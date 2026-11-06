# -*- coding: utf-8 -*-
"""``server/imaging.py`` 的 pytest 风格测试（只用 numpy + PIL，不依赖 pytest 运行时）。

覆盖 BUILD_CONTRACT.md 2.2 节与任务验收点：

* 图像 I/O：exif/ICC/alpha 解码、PNG 剥离 ICC、JPEG 白底、data URL 往返；
* 遮罩解码：alpha / 亮度 / invert / 缩放 / 空遮罩报错；
* 画布规划：``follow`` / ``custom`` / ``ratio`` / ``fixed_point`` 尺寸与 32 倍数；
* ``composite``：遮罩外与原图 ``max_abs == 0``、遮罩内来自 edited；
* ``crop_region → stitch_region`` 往返后遮罩外仍为原图像素；
* ``map_mask_to_canvas ⇄ map_mask_from_canvas`` 往返；
* 端到端"零偏移 + 零色差"流水线（follow 画布 → 合成 → 裁回源尺寸）。

本文件同时可以被 ``tests/_run_manual.py`` 直接调用（不依赖 pytest）。
"""

import io
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageCms

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import align, imaging  # noqa: E402


# ---------------------------------------------------------------------------
# 测试工具
# ---------------------------------------------------------------------------


def _rgba(w: int, h: int, seed: int = 0, alpha: int = 255) -> Image.Image:
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    arr[..., 3] = alpha
    return Image.fromarray(arr, "RGBA")


def _arr_u8(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("RGBA"), dtype=np.int16)


def _max_abs(a: Image.Image, b: Image.Image) -> int:
    assert a.size == b.size, f"尺寸不一致: {a.size} vs {b.size}"
    return int(np.abs(_arr_u8(a) - _arr_u8(b)).max())


def _mask(w: int, h: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.float32)
    m[y0:y1, x0:x1] = 1.0
    return m


def _png_bytes(mask: np.ndarray) -> bytes:
    im = Image.fromarray(np.rint(np.clip(mask, 0, 1) * 255).astype(np.uint8), "L")
    return imaging.encode_png(im)


# ---------------------------------------------------------------------------
# 图像 I/O
# ---------------------------------------------------------------------------


def test_decode_image_keep_alpha_true_and_false():
    src = _rgba(40, 30, seed=1, alpha=200)
    data = imaging.encode_png(src)
    decoded = imaging.decode_image(data, keep_alpha=True)
    assert decoded.mode == "RGBA"
    assert decoded.size == (40, 30)
    assert _max_abs(decoded, src) == 0

    rgb = imaging.decode_image(data, keep_alpha=False)
    assert rgb.mode == "RGB"
    assert rgb.size == (40, 30)
    # 丢弃 alpha 不应该改变 RGB 数值
    assert int(
        np.abs(np.asarray(rgb, np.int16) - np.asarray(src.convert("RGB"), np.int16)).max()
    ) == 0


def test_decode_image_srgb_icc_is_passthrough():
    src = _rgba(32, 24, seed=2)
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    buf = io.BytesIO()
    src.save(buf, format="PNG", icc_profile=srgb)
    decoded = imaging.decode_image(buf.getvalue())
    assert decoded.size == (32, 24)
    assert _max_abs(decoded, src) == 0, "sRGB ICC 不应引入任何像素变化"


def test_decode_image_empty_raises():
    try:
        imaging.decode_image(b"")
    except ValueError:
        return
    raise AssertionError("空图片数据应该 raise ValueError")


def test_encode_png_strips_icc_and_keeps_pixels():
    src = _rgba(16, 12, seed=3)
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    src.info["icc_profile"] = srgb
    data = imaging.encode_png(src)
    reopened = Image.open(io.BytesIO(data))
    assert "icc_profile" not in reopened.info
    assert reopened.mode == "RGBA"
    assert _max_abs(reopened.convert("RGBA"), src) == 0

    kept = Image.open(io.BytesIO(imaging.encode_png(src, strip_icc=False)))
    assert "icc_profile" in kept.info


def test_encode_jpeg_flattens_alpha_on_white():
    src = Image.new("RGBA", (8, 8), (255, 0, 0, 0))  # 全透明
    data = imaging.encode_jpeg(src, quality=95)
    reopened = Image.open(io.BytesIO(data))
    assert reopened.format == "JPEG"
    assert reopened.mode == "RGB"
    arr = np.asarray(reopened)
    assert int(arr.min()) > 240, "透明区域应合成为白色"


def test_data_url_roundtrip():
    payload = b"\x89PNG\r\n\x1a\nhello"
    url = imaging.data_url("image/png", payload)
    assert url.startswith("data:image/png;base64,")
    mime, data = imaging.parse_data_url(url)
    assert mime == "image/png" and data == payload


def test_parse_data_url_rejects_invalid():
    for bad in ("", "http://x/y.png", "data:image/png,abc", "data:image/png;base64"):
        try:
            imaging.parse_data_url(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} 应该 raise ValueError")


def test_image_meta():
    src = _rgba(33, 21, seed=4)
    meta = imaging.image_meta(src)
    assert (meta.width, meta.height) == (33, 21)
    assert meta.mode == "RGBA"
    assert meta.has_alpha is True
    assert meta.icc is False


# ---------------------------------------------------------------------------
# 遮罩解码
# ---------------------------------------------------------------------------


def test_decode_mask_from_alpha_channel():
    mask = np.zeros((40, 60), dtype=np.float32)
    mask[10:30, 20:50] = 1.0
    rgba = np.zeros((40, 60, 4), dtype=np.uint8)
    rgba[..., 3] = np.rint(mask * 255).astype(np.uint8)
    data = imaging.encode_png(Image.fromarray(rgba, "RGBA"))
    out = imaging.decode_mask(data, 60, 40)
    assert out.shape == (40, 60) and out.dtype == np.float32
    assert int((out > 0.5).sum()) == 20 * 30
    assert float(out[15, 25]) == 1.0


def test_decode_mask_from_luminance_when_alpha_opaque():
    mask = np.zeros((24, 32), dtype=np.float32)
    mask[5:20, 8:30] = 1.0
    data = _png_bytes(mask)
    out = imaging.decode_mask(data, 32, 24)
    assert int((out > 0.5).sum()) == 15 * 22


def test_decode_mask_invert_and_resize():
    mask = np.zeros((10, 10), dtype=np.float32)
    mask[2:8, 2:8] = 1.0
    data = _png_bytes(mask)
    out = imaging.decode_mask(data, 45, 23)  # 需要双线性缩放
    assert out.shape == (23, 45)
    assert float(out.max()) > 0.9
    inverted = imaging.decode_mask(data, 10, 10, invert=True)
    assert abs(float(inverted[0, 0]) - 1.0) < 1e-6
    assert abs(float(inverted[5, 5]) - 0.0) < 1e-6


def test_decode_mask_empty_raises():
    empty = _png_bytes(np.zeros((16, 16), dtype=np.float32))
    try:
        imaging.decode_mask(empty, 16, 16)
    except ValueError as exc:
        assert "遮罩为空" in str(exc)
        return
    raise AssertionError("全黑遮罩应该 raise ValueError('遮罩为空')")


# ---------------------------------------------------------------------------
# 画布规划
# ---------------------------------------------------------------------------


def test_parse_ratio_variants():
    assert imaging.parse_ratio("16:9") == (16.0, 9.0)
    assert imaging.parse_ratio("16x9") == (16.0, 9.0)
    assert imaging.parse_ratio("16/9") == (16.0, 9.0)
    assert imaging.parse_ratio("16：9") == (16.0, 9.0)
    assert imaging.parse_ratio(2.0) == (2.0, 1.0)
    assert imaging.parse_ratio("1.5") == (1.5, 1.0)
    for bad in ("", None, "abc", "0:9", "16:-9"):
        try:
            imaging.parse_ratio(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} 应该 raise ValueError")


def test_plan_follow_is_one_to_one_and_snapped():
    plan = imaging.plan_canvas(100, 70, mode="follow")
    assert (plan.width, plan.height) == (128, 96)
    assert plan.width % 32 == 0 and plan.height % 32 == 0
    assert plan.scale == 1.0
    assert (plan.offset_x, plan.offset_y) == (14, 13)
    assert (plan.src_w, plan.src_h) == (100, 70)
    assert plan.fit == "pad"
    assert plan.resolution == 0


def test_plan_custom_pad_crop_stretch():
    pad = imaging.plan_canvas(100, 70, mode="custom", width=640, height=480, fit="pad")
    assert (pad.width, pad.height) == (640, 480)
    assert abs(pad.scale - 6.4) < 1e-6
    content_w, content_h = imaging._content_size(pad)
    assert (content_w, content_h) == (640, 448)
    assert (pad.offset_x, pad.offset_y) == (0, 16)

    crop = imaging.plan_canvas(100, 70, mode="custom", width=640, height=480, fit="crop")
    cw, ch = imaging._content_size(crop)
    assert cw >= crop.width and ch >= crop.height
    assert crop.offset_x <= 0 and crop.offset_y <= 0
    # crop 模式下 scale 是"回算后的实际倍率"（content_w / src_w），保证遮罩映射一致
    assert abs(crop.scale - cw / 100.0) < 1e-6
    assert crop.scale >= max(640 / 100.0, 480 / 70.0) - 0.02

    stretch = imaging.plan_canvas(100, 70, mode="custom", width=640, height=480, fit="stretch")
    assert stretch.fit == "stretch"
    assert imaging._content_size(stretch) == (640, 480)

    for kw in (dict(mode="custom"), dict(mode="custom", width=640)):
        try:
            imaging.plan_canvas(100, 70, **kw)
        except ValueError:
            continue
        raise AssertionError(f"{kw} 应该 raise ValueError")


def test_plan_ratio_keeps_ratio_and_area():
    cases = [("16:9", 1.0, 16 / 9), ("4:3", 2.0, 4 / 3), ("1:1", 1.0, 1.0), ("9:16", 1.0, 9 / 16)]
    for ratio, mp, expected_ratio in cases:
        plan = imaging.plan_canvas(100, 70, mode="ratio", ratio=ratio, megapixels=mp)
        assert plan.width % 32 == 0 and plan.height % 32 == 0
        ratio_err = abs(math.log((plan.width / float(plan.height)) / expected_ratio))
        assert ratio_err < 0.02, f"{ratio} 比例误差过大（{ratio_err:.4f}）"
        area_err = abs(plan.width * plan.height - mp * 1_000_000.0) / (mp * 1_000_000.0)
        assert area_err < 0.15, f"{ratio}+{mp}MP 面积误差过大（{area_err:.3f}）"


def test_plan_ratio_default_megapixels_is_one():
    plan = imaging.plan_canvas(100, 70, mode="ratio", ratio="16:9", megapixels=None)
    assert abs(plan.width * plan.height - 1_000_000.0) / 1_000_000.0 < 0.15


def test_plan_fixed_point_is_strict_fixed_point():
    for mp in (0.5, 1.0, 2.2):
        plan = imaging.plan_canvas(1234, 567, mode="fixed_point", megapixels=mp)
        assert plan.width % 32 == 0 and plan.height % 32 == 0
        assert plan.resolution >= 512 and plan.resolution % 32 == 0
        assert align.is_fixed_point(plan.width, plan.height, plan.resolution), (
            f"{mp}MP -> {plan.width}x{plan.height} res={plan.resolution} 不是不动点"
        )
        # 面积应接近 resolution²（白名单允许 ±tol）
        area_err = abs(plan.width * plan.height - plan.resolution ** 2) / plan.resolution ** 2
        assert area_err < 0.2, f"{mp}MP 画布面积偏离 resolution² 过大（{area_err:.3f}）"


def test_plan_fixed_point_respects_ratio_argument():
    plan = imaging.plan_canvas(100, 70, mode="fixed_point", megapixels=1.0, ratio="16:9")
    assert plan.width > plan.height
    assert abs(math.log((plan.width / float(plan.height)) / (16 / 9))) < 0.2


def test_plan_fixed_point_width_height_is_resolution_hint_not_ratio():
    """UI 用 width=height=1024 表示"选 1024 档"，不能被当成 1:1 目标画布。"""
    plan = imaging.plan_canvas(1234, 567, mode="fixed_point", width=1024, height=1024)
    assert plan.resolution == 1024
    assert plan.width > plan.height * 1.5, "fixed_point 应沿用源图横向比例"
    assert align.is_fixed_point(plan.width, plan.height, plan.resolution)


def test_plan_canvas_accepts_lead_pipeline_call_shape():
    """与 server/pipeline.py 的调用形态完全对齐（全部 kwargs 显式传入）。"""
    plan = imaging.plan_canvas(
        100, 70, mode="follow", width=None, height=None, ratio=None,
        megapixels=None, fit="pad", multiple=32,
    )
    assert (plan.width, plan.height) == (128, 96)
    for mode, kwargs in (
        ("custom", dict(width=640, height=480)),
        ("ratio", dict(ratio="16:9", megapixels=2.2)),
        ("fixed_point", dict(megapixels=1.0)),
    ):
        p = imaging.plan_canvas(
            100, 70, mode=mode, width=kwargs.get("width"), height=kwargs.get("height"),
            ratio=kwargs.get("ratio"), megapixels=kwargs.get("megapixels"),
            fit="pad", multiple=32,
        )
        src = _rgba(100, 70, seed=30)
        canvas = imaging.compose_canvas(src, p, pad_mode="edge")
        assert canvas.size == (p.width, p.height) and canvas.mode == "RGBA"
        mask = _mask(100, 70, 10, 10, 60, 50)
        mask_canvas = imaging.map_mask_to_canvas(mask, p)
        assert mask_canvas.shape == (p.height, p.width)
        out = imaging.composite(
            canvas, Image.new("RGBA", canvas.size, (1, 2, 3, 255)), mask_canvas,
            feather=32, curve="smoothstep", color_match=True,
            color_strength=0.6, mask_expand=0,
        )
        back = imaging.crop_back_plan(out, p, method="bicubic")
        assert back.size == (100, 70)


def test_plan_canvas_rejects_unknown_mode():
    try:
        imaging.plan_canvas(10, 10, mode="bogus")
    except ValueError:
        return
    raise AssertionError("未知 mode 应该 raise ValueError")


# ---------------------------------------------------------------------------
# compose / 遮罩映射
# ---------------------------------------------------------------------------


def test_compose_canvas_returns_exact_plan_size():
    src = _rgba(100, 70, seed=5)
    for kwargs in (
        dict(mode="follow"),
        dict(mode="custom", width=640, height=480, fit="pad"),
        dict(mode="custom", width=640, height=480, fit="crop"),
        dict(mode="custom", width=640, height=480, fit="stretch"),
        dict(mode="ratio", ratio="16:9", megapixels=1.0),
        dict(mode="fixed_point", megapixels=1.0),
    ):
        plan = imaging.plan_canvas(100, 70, **kwargs)
        canvas = imaging.compose_canvas(src, plan, pad_mode="edge")
        assert canvas.size == (plan.width, plan.height)
        assert canvas.mode == "RGBA"


def test_compose_follow_preserves_source_pixels_exactly():
    src = _rgba(100, 70, seed=6)
    plan = imaging.plan_canvas(100, 70, mode="follow")
    canvas = imaging.compose_canvas(src, plan, pad_mode="edge")
    region = canvas.crop(
        (plan.offset_x, plan.offset_y, plan.offset_x + 100, plan.offset_y + 70)
    )
    assert _max_abs(region, src) == 0, "follow 模式不应重采样源图"


def test_compose_canvas_pad_modes():
    src = _rgba(50, 40, seed=7)
    plan = imaging.plan_canvas(50, 40, mode="custom", width=128, height=128, fit="pad")
    for pad_mode in align.PAD_MODES:
        canvas = imaging.compose_canvas(src, plan, pad_mode=pad_mode, pad_color=(0.2, 0.4, 0.6, 1.0))
        assert canvas.size == (128, 128)
        if pad_mode == "gray":
            # 补边区域应为 pad_color 对应的灰度
            arr = np.asarray(canvas)
            corner = arr[0, 0]
            assert abs(int(corner[0]) - 51) <= 1 and abs(int(corner[1]) - 102) <= 1


def test_map_mask_follow_roundtrip_is_exact():
    plan = imaging.plan_canvas(100, 70, mode="follow")
    mask = _mask(100, 70, 10, 5, 60, 40)
    canvas_mask = imaging.map_mask_to_canvas(mask, plan)
    assert canvas_mask.shape == (plan.height, plan.width)
    # 补边区不应被标记为编辑区
    assert float(canvas_mask[0, 0]) == 0.0
    back = imaging.map_mask_from_canvas(canvas_mask, plan)
    assert back.shape == mask.shape
    assert float(np.abs(back - mask).max()) == 0.0, "follow 模式遮罩往返必须逐像素一致"


def test_map_mask_to_canvas_position():
    # follow 模式是 1:1 平移，位置必须严格对应
    follow = imaging.plan_canvas(200, 150, mode="follow")
    mask = _mask(200, 150, 100, 60, 140, 100)
    canvas_mask = imaging.map_mask_to_canvas(mask, follow)
    ys, xs = np.nonzero(canvas_mask > 0.5)
    assert xs.size > 0
    assert int(xs.min()) == follow.offset_x + 100
    assert int(ys.min()) == follow.offset_y + 60
    assert int(xs.max()) == follow.offset_x + 139
    assert int(ys.max()) == follow.offset_y + 99

    # 缩放模式：centroid 应按 scale 线性映射（允许 2px 内的插值/取整误差）
    plan = imaging.plan_canvas(200, 150, mode="custom", width=640, height=480, fit="pad")
    scaled = imaging.map_mask_to_canvas(mask, plan)
    content_w, content_h = imaging._content_size(plan)
    ys, xs = np.nonzero(scaled > 0.5)
    expected_cx = plan.offset_x + (120.0 * content_w / 200.0)
    expected_cy = plan.offset_y + (80.0 * content_h / 150.0)
    assert abs(float(xs.mean()) - expected_cx) < 2.0
    assert abs(float(ys.mean()) - expected_cy) < 2.0


def test_plan_to_pad_info_and_crop_back_plan_roundtrip():
    src = _rgba(100, 70, seed=8)
    plan = imaging.plan_canvas(100, 70, mode="follow")
    canvas = imaging.compose_canvas(src, plan)
    info = imaging.plan_to_pad_info(plan)
    back1 = align.crop_back(canvas, info)
    back2 = imaging.crop_back_plan(canvas, plan)
    assert back1.size == (100, 70) and back2.size == (100, 70)
    assert _max_abs(back1, src) == 0
    assert _max_abs(back2, src) == 0


# ---------------------------------------------------------------------------
# composite（方案 A 收尾）
# ---------------------------------------------------------------------------


def test_composite_outside_mask_is_pixel_identical():
    """核心验收：composite 遮罩外像素与原图 max_abs == 0（零色差）。"""
    original = _rgba(128, 96, seed=10)
    edited = Image.new("RGBA", (128, 96), (210, 30, 40, 255))
    mask = _mask(128, 96, 30, 20, 90, 60)

    for feather in (0, 8, 32):
        for color_match in (False, True):
            out = imaging.composite(
                original, edited, mask,
                feather=feather, color_match=color_match, color_strength=0.7,
            )
            assert out.size == original.size
            outside = _arr_u8(out)[mask == 0]
            outside_orig = _arr_u8(original)[mask == 0]
            assert int(np.abs(outside - outside_orig).max()) == 0, (
                f"feather={feather} color_match={color_match} 时遮罩外像素被改动"
            )


def test_composite_inside_mask_comes_from_edited():
    original = _rgba(128, 96, seed=11)
    edited = Image.new("RGBA", (128, 96), (7, 250, 13, 255))
    mask = _mask(128, 96, 30, 20, 90, 60)
    out = imaging.composite(original, edited, mask, feather=0, color_match=False)
    inside = _arr_u8(out)[mask == 1]
    assert int(np.abs(inside - _arr_u8(edited)[mask == 1]).max()) == 0


def test_composite_no_mask_means_full_edit():
    original = _rgba(64, 48, seed=12)
    edited = Image.new("RGBA", (64, 48), (1, 2, 3, 255))
    out = imaging.composite(original, edited, None, feather=0, color_match=False)
    assert _max_abs(out, edited) == 0


def test_composite_mask_expand_grows_edited_area():
    original = _rgba(96, 96, seed=13)
    edited = Image.new("RGBA", (96, 96), (240, 240, 240, 255))
    mask = _mask(96, 96, 40, 40, 60, 60)
    plain = imaging.composite(original, edited, mask, feather=0, color_match=False, mask_expand=0)
    expanded = imaging.composite(original, edited, mask, feather=0, color_match=False, mask_expand=4)
    changed_plain = int((_arr_u8(plain) != _arr_u8(original)).any(axis=2).sum())
    changed_expanded = int((_arr_u8(expanded) != _arr_u8(original)).any(axis=2).sum())
    assert changed_expanded > changed_plain


def test_composite_color_match_moves_mean_toward_original():
    original = Image.new("RGBA", (64, 64), (100, 110, 120, 255))
    edited = Image.new("RGBA", (64, 64), (180, 190, 200, 255))
    mask = _mask(64, 64, 16, 16, 48, 48)
    out = imaging.composite(
        original, edited, mask, feather=0, color_match=True, color_strength=1.0
    )
    arr = np.asarray(out.convert("RGB"), dtype=np.float32)
    inside = arr[20:44, 20:44].reshape(-1, 3).mean(axis=0)
    # 完全匹配时，遮罩内均值应被拉到原图 (100,110,120) 附近
    assert np.allclose(inside, np.array([100.0, 110.0, 120.0]), atol=12.0)


# ---------------------------------------------------------------------------
# crop_region / stitch_region（方案 B）
# ---------------------------------------------------------------------------


def test_crop_region_pads_to_multiple():
    canvas = _rgba(512, 384, seed=15)
    mask = _mask(512, 384, 180, 120, 332, 250)
    crop, info = imaging.crop_region(canvas, mask, context_factor=1.5, context_pixels=64)
    assert crop.size[0] % 32 == 0 and crop.size[1] % 32 == 0
    assert (info.canvas_w, info.canvas_h) == (512, 384)
    assert 0 <= info.x < 512 and 0 <= info.y < 384
    assert info.x + info.w <= 512 and info.y + info.h <= 384
    assert crop.size[0] >= info.w and crop.size[1] >= info.h


def test_crop_region_empty_mask_raises():
    canvas = _rgba(64, 64, seed=16)
    try:
        imaging.crop_region(canvas, np.zeros((64, 64), dtype=np.float32))
    except ValueError as exc:
        assert "遮罩为空" in str(exc)
        return
    raise AssertionError("空遮罩应该 raise ValueError")


def test_crop_region_stitch_roundtrip_outside_mask_is_original():
    """核心验收：crop_region → stitch_region 往返后遮罩外仍是原图像素。"""
    canvas = _rgba(512, 384, seed=17)
    mask = _mask(512, 384, 200, 140, 360, 280)
    crop, info = imaging.crop_region(canvas, mask, context_factor=1.5, context_pixels=64)
    edited_crop = Image.new("RGBA", crop.size, (0, 255, 128, 255))

    out = imaging.stitch_region(
        canvas, edited_crop, info, mask, blend_pixels=24, color_match=False
    )
    assert out.size == canvas.size
    outside = _arr_u8(out)[mask == 0]
    outside_orig = _arr_u8(canvas)[mask == 0]
    assert int(np.abs(outside - outside_orig).max()) == 0, "贴回后遮罩外像素被改动"

    # 遮罩中心确实来自编辑结果
    assert tuple(int(v) for v in np.asarray(out.convert("RGB"))[210, 280]) == (0, 255, 128)


def test_stitch_region_color_match_keeps_outside_exact():
    canvas = _rgba(512, 384, seed=18)
    mask = _mask(512, 384, 200, 140, 360, 280)
    crop, info = imaging.crop_region(canvas, mask, context_pixels=48)
    edited_crop = Image.new("RGBA", crop.size, (250, 240, 10, 255))
    out = imaging.stitch_region(canvas, edited_crop, info, mask, color_match=True, color_strength=0.8)
    outside = _arr_u8(out)[mask == 0]
    outside_orig = _arr_u8(canvas)[mask == 0]
    assert int(np.abs(outside - outside_orig).max()) == 0


def test_stitch_region_handles_resized_edited_crop():
    canvas = _rgba(512, 384, seed=19)
    mask = _mask(512, 384, 200, 140, 360, 280)
    crop, info = imaging.crop_region(canvas, mask)
    resized = crop.resize((int(crop.size[0] * 1.25), int(crop.size[1] * 1.25)), Image.BICUBIC)
    out = imaging.stitch_region(
        canvas, resized, info, mask, blend_pixels=24, color_match=False
    )
    assert out.size == canvas.size
    outside = _arr_u8(out)[mask == 0]
    outside_orig = _arr_u8(canvas)[mask == 0]
    assert int(np.abs(outside - outside_orig).max()) == 0


def test_stitch_region_without_mask_uses_edge_ramp():
    canvas = _rgba(256, 192, seed=20)
    mask = _mask(256, 192, 100, 70, 160, 130)
    crop, info = imaging.crop_region(canvas, mask)
    edited_crop = Image.new("RGBA", crop.size, (30, 60, 90, 255))
    out = imaging.stitch_region(canvas, edited_crop, info, None, blend_pixels=16, color_match=False)
    assert out.size == canvas.size
    # 无 mask 时整块区域会被改写，但边缘有一圈 ramp
    assert _max_abs(out, canvas) > 0


def test_stitch_region_rejects_canvas_size_mismatch():
    canvas = _rgba(128, 96, seed=21)
    info = imaging.CropInfo(x=0, y=0, w=64, h=48, canvas_w=256, canvas_h=192)
    try:
        imaging.stitch_region(canvas, canvas, info, None)
    except ValueError:
        return
    raise AssertionError("画布尺寸不一致应该 raise ValueError")


# ---------------------------------------------------------------------------
# compare / 端到端
# ---------------------------------------------------------------------------


def test_compare():
    a = _rgba(16, 16, seed=22)
    b = a.copy()
    same = imaging.compare(a, b)
    assert same == {"size_equal": True, "max_abs": 0, "mean_abs": 0.0, "identical": True}

    arr = np.asarray(a).copy()
    arr[3, 4, 0] = (int(arr[3, 4, 0]) + 7) % 256
    c = Image.fromarray(arr, "RGBA")
    diff = imaging.compare(a, c)
    assert diff["size_equal"] is True and diff["identical"] is False
    assert diff["max_abs"] == 7

    small = _rgba(8, 8, seed=23)
    mismatched = imaging.compare(a, small)
    assert mismatched["size_equal"] is False
    assert mismatched["identical"] is False
    assert mismatched["max_abs"] == 255


def test_zero_offset_zero_color_pipeline_end_to_end():
    """端到端：follow 画布 → 铺画布 → 遮罩映射 → 合成 → 裁回源尺寸。

    验收：输出尺寸 == 输入尺寸；画布为 32 倍数；遮罩外像素与原图逐字节相同。
    """
    source = _rgba(100, 70, seed=24)
    plan = imaging.plan_canvas(100, 70, mode="follow")
    canvas = imaging.compose_canvas(source, plan, pad_mode="edge")
    assert canvas.size == (plan.width, plan.height)
    assert plan.width % 32 == 0 and plan.height % 32 == 0

    mask_src = _mask(100, 70, 20, 15, 70, 55)
    mask_canvas = imaging.map_mask_to_canvas(mask_src, plan)

    # 模拟模型输出：全画布换成另一种颜色（真出图时这里是 ComfyUI 返回的图）
    edited_canvas = Image.new("RGBA", canvas.size, (200, 50, 80, 255))
    composed_canvas = imaging.composite(
        canvas, edited_canvas, mask_canvas,
        feather=16, curve="smoothstep", color_match=True, color_strength=0.6,
    )
    result = imaging.crop_back_plan(composed_canvas, plan)
    assert result.size == source.size

    result_mask = align.inverse_transform_mask(mask_canvas, align.pad_image(source)[1])
    outside = _arr_u8(result)[result_mask == 0]
    outside_orig = _arr_u8(source)[result_mask == 0]
    assert int(np.abs(outside - outside_orig).max()) == 0, "端到端遮罩外像素必须与原图一致"


def test_imaging_does_not_import_torch_or_cv2():
    source = (ROOT / "server" / "imaging.py").read_text(encoding="utf-8")
    for forbidden in ("import torch", "import cv2", "from torch", "comfy.utils"):
        assert forbidden not in source, f"server/imaging.py 不允许出现 {forbidden!r}"
