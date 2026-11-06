# -*- coding: utf-8 -*-
"""``server/align.py`` 的 pytest 风格测试（只用 numpy + PIL，不依赖 pytest 运行时）。

覆盖 BUILD_CONTRACT.md 2.1 节与任务验收点：

* ``snap_dims`` 向上对齐 multiple；
* ``pad_image → crop_back`` 在 ``scale_by=1.0`` 时逐像素完全一致（max_abs == 0）；
* ``pad_image`` 画布宽高均为 32 倍数，遮罩映射到画布后位置正确；
* ``fixed_point_size`` 对 512 / 1024 / 1440 都返回真不动点；
* ``dilate/feather/curve/band/reinhard`` 的数值性质；
* ``region_shapes_to_mask`` 的矩形/椭圆覆盖区域；
* ``latent_tokens`` 与"禁止 import torch/cv2"的静态检查。

本文件同时可以被 ``tests/_run_manual.py`` 直接调用（不依赖 pytest）。
"""

import math
import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import align  # noqa: E402


# ---------------------------------------------------------------------------
# 测试工具
# ---------------------------------------------------------------------------


def _rgb(w: int, h: int, seed: int = 0) -> Image.Image:
    """生成对位移极其敏感的随机 RGB 图（任何 1px 偏移都会显著改变 max_abs）。"""
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
    return Image.fromarray(arr, "RGB")


def _rgba(w: int, h: int, seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    return Image.fromarray(arr, "RGBA")


def _arr(im: Image.Image, alpha: bool = True) -> np.ndarray:
    mode = "RGBA" if alpha else "RGB"
    return np.asarray(im.convert(mode), dtype=np.int16)


def _max_abs(a: Image.Image, b: Image.Image, alpha: bool = True) -> int:
    assert a.size == b.size, f"尺寸不一致: {a.size} vs {b.size}"
    return int(np.abs(_arr(a, alpha) - _arr(b, alpha)).max())


def _rectangle_mask(w: int, h: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.float32)
    m[y0:y1, x0:x1] = 1.0
    return m


def _bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask > 0.5)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


# ---------------------------------------------------------------------------
# snap_dims
# ---------------------------------------------------------------------------


def test_snap_dims_rounds_up_to_multiple():
    assert align.snap_dims(1, 1) == (32, 32)
    assert align.snap_dims(32, 32) == (32, 32)
    assert align.snap_dims(33, 40) == (64, 64)
    assert align.snap_dims(100, 70) == (128, 96)
    assert align.snap_dims(64, 96) == (64, 96)


def test_snap_dims_custom_multiple():
    assert align.snap_dims(9, 17, multiple=8) == (16, 24)
    assert align.snap_dims(1, 1, multiple=8) == (8, 8)
    assert align.snap_dims(37, 61, multiple=1) == (37, 61)
    # 非法 multiple 会被夹到 1，不抛异常
    assert align.snap_dims(10, 10, multiple=0) == (10, 10)


def test_latent_tokens():
    assert align.latent_tokens(1024, 1024) == 1024
    assert align.latent_tokens(1000, 700) == (1024 // 32) * (704 // 32)
    assert align.latent_tokens(1, 1) == 1
    assert align.latent_tokens(33, 33) == 2 * 2


# ---------------------------------------------------------------------------
# pad_image
# ---------------------------------------------------------------------------


def test_pad_image_canvas_is_multiple_of_32():
    im = _rgb(100, 70)
    for pad_mode in align.PAD_MODES:
        for alignment in align.ALIGN_MODES:
            canvas, info = align.pad_image(im, pad_mode=pad_mode, align=alignment)
            assert canvas.size == (info.canvas_w, info.canvas_h)
            assert info.canvas_w % 32 == 0 and info.canvas_h % 32 == 0
            assert (info.orig_w, info.orig_h) == (100, 70)
            assert (info.out_w, info.out_h) == (100, 70)
            assert info.multiple == 32
            assert info.pad_mode == pad_mode
            # 画布必须能完整容纳缩放图
            assert info.pad_l + info.out_w <= info.canvas_w
            assert info.pad_t + info.out_h <= info.canvas_h


def test_pad_image_center_and_top_left_offsets():
    im = _rgb(100, 70)
    _, center = align.pad_image(im, align="center")
    _, top_left = align.pad_image(im, align="top_left")
    assert (center.pad_l, center.pad_t) == (14, 13)
    assert center.canvas_w == 128 and center.canvas_h == 96
    assert (top_left.pad_l, top_left.pad_t) == (0, 0)


def test_pad_image_gray_fill_value():
    im = Image.new("RGB", (100, 70), (10, 20, 30))
    canvas, info = align.pad_image(im, pad_mode="gray", pad_value=0.5)
    arr = np.asarray(canvas)
    # 左上角补边区域应恰好是 0.5 → 128
    assert int(arr[0, 0, 0]) == 128
    # 原图内容区域保持原值
    y, x = info.pad_t + 5, info.pad_l + 5
    assert tuple(int(v) for v in arr[y, x]) == (10, 20, 30)


def test_pad_image_black_white_fill():
    im = Image.new("RGB", (100, 70), (10, 20, 30))
    black, info = align.pad_image(im, pad_mode="black")
    white, _ = align.pad_image(im, pad_mode="white")
    assert int(np.asarray(black)[0, 0, 0]) == 0
    assert int(np.asarray(white)[0, 0, 0]) == 255


def test_pad_image_edge_replicates_border():
    arr = np.zeros((70, 100, 3), dtype=np.uint8)
    arr[:, 0] = (200, 100, 50)  # 左边界一列特殊颜色
    canvas, info = align.pad_image(Image.fromarray(arr, "RGB"), pad_mode="edge", align="center")
    out = np.asarray(canvas)
    # 补边出来的左列应该复制原图第 0 列的像素
    assert int(info.pad_l) > 0
    assert tuple(int(v) for v in out[info.pad_t + 10, 0]) == (200, 100, 50)


def test_pad_crop_back_roundtrip_is_pixel_exact_scale_1():
    """核心验收：pad_image → crop_back 在 scale_by=1.0 时 max_abs == 0。"""
    im = _rgb(100, 70, seed=3)
    for pad_mode in align.PAD_MODES:
        for alignment in align.ALIGN_MODES:
            canvas, info = align.pad_image(im, pad_mode=pad_mode, align=alignment)
            back = align.crop_back(canvas, info)
            assert back.size == im.size
            assert _max_abs(back, im) == 0, f"{pad_mode}/{alignment} 往返出现像素偏移"


def test_pad_crop_back_roundtrip_is_pixel_exact_rgba():
    im = _rgba(57, 43, seed=7)
    canvas, info = align.pad_image(im, pad_mode="reflect")
    back = align.crop_back(canvas, info)
    assert back.mode == "RGBA"
    assert _max_abs(back, im) == 0


def test_pad_image_scale_by_scales_canvas_and_crop_back_recovers():
    im = _rgb(100, 70, seed=11)
    canvas, info = align.pad_image(im, scale_by=2.0)
    # 缩放后宽高对齐到 32：round(200/32)*32=192, round(140/32)*32=128
    assert (info.out_w, info.out_h) == (192, 128)
    assert (info.canvas_w, info.canvas_h) == (192, 128)
    assert abs(info.scale - 1.92) < 1e-6
    back = align.crop_back(canvas, info, method="bicubic")
    assert back.size == im.size
    # 缩放往返不保证逐像素相同，但必须无系统性几何偏移（均值差很小）
    diff = np.abs(_arr(back) - _arr(im)).astype(np.float64)
    assert diff.mean() < 40.0


def test_pad_image_reflect_on_small_image_falls_back_safely():
    im = _rgb(1, 1, seed=5)  # reflect 在 1px 图上不可用，应自动退回 edge
    canvas, info = align.pad_image(im, pad_mode="reflect")
    assert canvas.size == (32, 32)
    arr = np.asarray(canvas)
    assert tuple(int(v) for v in arr[0, 0]) == tuple(int(v) for v in np.asarray(im)[0, 0])


def test_pad_crop_back_handles_resized_decoded_canvas():
    """模型输出尺寸与画布不一致时，按比例映射而不是报错。"""
    im = _rgb(100, 70, seed=13)
    canvas, info = align.pad_image(im)
    odd = canvas.resize((info.canvas_w * 2, info.canvas_h * 2), Image.Resampling.BICUBIC)
    back = align.crop_back(odd, info)
    assert back.size == im.size


# ---------------------------------------------------------------------------
# 遮罩坐标映射（对应 _mask_to_canvas）
# ---------------------------------------------------------------------------


def test_transform_mask_position_on_canvas():
    im = _rgb(200, 150, seed=21)
    mask = _rectangle_mask(200, 150, 100, 60, 140, 100)
    _, info = align.pad_image(im)
    canvas_mask = align.transform_mask(mask, info)

    assert canvas_mask.shape == (info.canvas_h, info.canvas_w)
    assert canvas_mask.dtype == np.float32
    bbox = _bbox_of(canvas_mask)
    expected = (
        info.pad_l + 100,
        info.pad_t + 60,
        info.pad_l + 139,
        info.pad_t + 99,
    )
    assert bbox == expected
    # 画布补边区域不应被标记成编辑区
    if info.pad_l > 0:
        assert float(canvas_mask[:, : info.pad_l].max()) == 0.0
    # 未遮罩区域为 0
    assert float(canvas_mask[0, 0]) == 0.0


def test_inverse_transform_mask_roundtrip_is_exact():
    im = _rgb(200, 150, seed=23)
    mask = _rectangle_mask(200, 150, 13, 27, 180, 140).astype(np.float32)
    mask = align.feather_mask(mask, 4)
    _, info = align.pad_image(im)
    canvas_mask = align.transform_mask(mask, info)
    back = align.inverse_transform_mask(canvas_mask, info)
    assert back.shape == mask.shape
    assert float(np.abs(back - np.clip(mask, 0, 1)).max()) < 1e-5


# ---------------------------------------------------------------------------
# 32 不动点（BlueBox CutQwenImage21）
# ---------------------------------------------------------------------------


def test_fixed_point_size_is_strict_fixed_point_for_main_resolutions():
    """核心验收：512 / 1024 / 1440 档位返回的 (w,h) 必须是真不动点。"""
    shapes = [(1234, 567), (800, 800), (3000, 2000), (512, 4096), (100, 70)]
    for resolution in (512, 1024, 1440):
        for src_w, src_h in shapes:
            w, h, res = align.fixed_point_size(src_w, src_h, resolution=resolution)
            assert res == resolution
            assert w % 32 == 0 and h % 32 == 0
            assert w > 0 and h > 0

            # 独立复算 BlueBox 的内部缩放：按 resolution² 面积等比缩放 + 32 对齐
            scale = math.sqrt((resolution * resolution) / float(w * h))
            w2 = max(32, int(round(w * scale / 32.0)) * 32)
            h2 = max(32, int(round(h * scale / 32.0)) * 32)
            assert (w2, h2) == (w, h), (
                f"res={resolution} src={src_w}x{src_h} -> {(w, h)} 不是不动点（缩放后 {(w2, h2)}）"
            )
            assert align.is_fixed_point(w, h, resolution)


def test_fixed_point_size_keeps_input_ratio_reasonably():
    for src_w, src_h in [(1234, 567), (800, 800), (3000, 2000), (1080, 1920)]:
        w, h, _ = align.fixed_point_size(src_w, src_h, resolution=1024)
        ratio_err = abs(math.log((w / float(h)) / (src_w / float(src_h))))
        assert ratio_err < 0.35, f"{src_w}x{src_h} -> {w}x{h} 比例偏离过大（{ratio_err:.3f}）"


def test_fixed_point_size_square_input_stays_square():
    for resolution in (512, 1024, 1440):
        assert align.fixed_point_size(1000, 1000, resolution=resolution)[:2] == (
            resolution,
            resolution,
        )


def test_fixed_point_size_tol_ratio_still_returns_fixed_point():
    for tol in (0.0, 0.2, 2.0, 3.0):
        w, h, res = align.fixed_point_size(1234, 567, resolution=1440, tol_ratio=tol)
        assert align.is_fixed_point(w, h, res), f"tol_ratio={tol} 时 ({(w, h)}) 不是不动点"


def test_fixed_point_size_rejects_non_positive():
    for bad in ((0, 100), (100, 0), (-1, 10)):
        try:
            align.fixed_point_size(*bad, resolution=1024)
        except ValueError:
            continue
        raise AssertionError(f"{bad} 应该 raise ValueError")


# ---------------------------------------------------------------------------
# dilate / feather / curve / band / reinhard
# ---------------------------------------------------------------------------


def test_dilate_mask_expands_square_window():
    mask = np.zeros((21, 21), dtype=np.float32)
    mask[10, 10] = 1.0
    out = align.dilate_mask(mask, 3)
    assert out.dtype == np.float32
    assert float(out[10, 10]) == 1.0
    assert float(out[10, 7]) == 1.0 and float(out[10, 13]) == 1.0
    assert float(out[7, 10]) == 1.0 and float(out[13, 10]) == 1.0
    assert float(out[10, 6]) == 0.0 and float(out[6, 10]) == 0.0
    # 膨胀后面积应为 7x7（窗口被图像边界裁掉的部分除外）
    assert int((out > 0.5).sum()) == 49


def test_dilate_mask_zero_is_noop_and_edges_are_clipped():
    mask = _rectangle_mask(9, 9, 0, 0, 3, 3)
    same = align.dilate_mask(mask, 0)
    assert float(np.abs(same - mask).max()) == 0.0
    out = align.dilate_mask(mask, 4)
    assert out.shape == mask.shape
    assert int((out > 0.5).sum()) > int((mask > 0.5).sum())


def test_feather_mask_center_is_one_edge_is_zero_and_monotonic():
    mask = _rectangle_mask(128, 128, 40, 40, 88, 88)
    soft = align.feather_mask(mask, 8)
    assert soft.shape == mask.shape
    assert soft.min() >= 0.0 and soft.max() <= 1.0
    # 中心（远离边界）保持 1
    assert float(soft[64, 64]) > 0.999
    # 遮罩外较远处为 0
    assert float(soft[64, 5]) < 1e-3
    # 从中心向遮罩边界走，值必须单调不增（允许极小数值抖动）
    row = soft[64, 40:65]
    assert np.all(np.diff(row) >= -1e-6), "羽化应从中心向边缘单调衰减"
    # 过渡带确实存在
    band = (soft > 0.05) & (soft < 0.95)
    assert int(band.sum()) > 16


def test_feather_mask_identity_for_zero_radius():
    mask = _rectangle_mask(20, 20, 5, 5, 15, 15)
    assert float(np.abs(align.feather_mask(mask, 0) - mask).max()) == 0.0


def test_curve_mask_smoothstep_and_linear():
    mask = np.array([[0.0, 0.25, 0.5, 1.0]], dtype=np.float32)
    smooth = align.curve_mask(mask, "smoothstep")
    assert abs(float(smooth[0, 1]) - 0.15625) < 1e-6
    assert abs(float(smooth[0, 2]) - 0.5) < 1e-6
    assert abs(float(smooth[0, 0]) - 0.0) < 1e-6
    linear = align.curve_mask(mask, "linear")
    assert float(np.abs(linear - mask).max()) == 0.0


def test_band_from_mask_variants():
    # 软边遮罩：直接取 0<v<1 的过渡带
    soft = align.feather_mask(_rectangle_mask(64, 64, 20, 20, 44, 44), 6)
    band = align.band_from_mask(soft)
    assert band is not None and float(band.sum()) >= 16

    # 硬边遮罩：退回"外扩环带"，环在遮罩之外
    hard = _rectangle_mask(64, 64, 20, 20, 44, 44)
    ring = align.band_from_mask(hard, fallback_px=8)
    assert ring is not None
    assert float(ring.sum()) >= 16
    assert float(ring[32, 32]) == 0.0  # 遮罩内不属于环带
    assert float(ring[32, 46]) == 1.0  # 遮罩右侧紧邻的环带

    # 全 0 遮罩：没有有效带
    assert align.band_from_mask(np.zeros((32, 32), dtype=np.float32)) is None


def test_reinhard_match_pulls_mean_and_std_to_reference():
    rng = np.random.default_rng(31)
    reference = (rng.random((96, 96, 3)) * 0.5 + 0.25).astype(np.float32)
    edited = np.clip(reference * 1.25 + 0.08, 0.0, 1.0).astype(np.float32)
    weights = np.ones((96, 96), dtype=np.float32)

    out = align.reinhard_match(edited, reference, weights, 1.0)
    assert out.shape == edited.shape and out.dtype == np.float32

    ref_mean = reference.reshape(-1, 3).mean(axis=0)
    out_mean = out.reshape(-1, 3).mean(axis=0)
    ref_std = reference.reshape(-1, 3).std(axis=0)
    out_std = out.reshape(-1, 3).std(axis=0)
    assert np.allclose(out_mean, ref_mean, atol=1e-3)
    assert np.allclose(out_std, ref_std, atol=2e-3)


def test_reinhard_match_strength_zero_is_identity():
    rng = np.random.default_rng(33)
    reference = rng.random((32, 32, 3)).astype(np.float32)
    edited = rng.random((32, 32, 3)).astype(np.float32)
    weights = np.ones((32, 32), dtype=np.float32)
    out = align.reinhard_match(edited, reference, weights, 0.0)
    assert float(np.abs(out - edited).max()) < 1e-6


def test_reinhard_match_uses_only_weighted_band():
    """只有权重带内的统计参与匹配：改变带外像素不应影响结果。"""
    rng = np.random.default_rng(35)
    reference = rng.random((64, 64, 3)).astype(np.float32)
    edited = rng.random((64, 64, 3)).astype(np.float32)
    weights = np.zeros((64, 64), dtype=np.float32)
    weights[20:44, 20:44] = 1.0
    out_a = align.reinhard_match(edited, reference, weights, 1.0)
    edited_b = edited.copy()
    edited_b[0:10, 0:10] = 0.0
    out_b = align.reinhard_match(edited_b, reference, weights, 1.0)
    # 带外像素不参与统计，所以带内的校正参数相同（带内结果一致）
    assert float(np.abs(out_a[20:44, 20:44] - out_b[20:44, 20:44]).max()) < 1e-6


# ---------------------------------------------------------------------------
# 事后校准：diff_map / mad_threshold / anchor_affine / lowfreq_merge
# ---------------------------------------------------------------------------


def test_diff_map_detects_color_shift():
    """亮度不变、只是偏色也要被识别（RGB 最大差会被这题骗）。"""
    base = np.full((32, 32, 3), 0.5, np.float32)
    shifted = np.clip(base + np.array([0.0, 0.08, -0.08], np.float32), 0.0, 1.0)
    diff = align.diff_map(base, shifted, preblur=0.0)
    assert diff.shape == (32, 32) and diff.dtype == np.float32
    assert float(diff.mean()) > 0.05
    assert float(align.diff_map(base, base, preblur=0.0).max()) < 1e-6


def test_mad_threshold_is_clamped():
    flat = np.zeros((16, 16), np.float32)
    assert align.mad_threshold(flat) == 0.02
    noisy = np.full((16, 16), 0.3, np.float32)
    assert 0.02 <= align.mad_threshold(noisy) <= 0.04


def test_anchor_affine_estimated_only_from_outside_mask():
    """遮罩内怎么改都不影响估计；锚区漂移被准确还原成 scale/shift。"""
    rng = np.random.default_rng(41)
    original = (rng.random((64, 64, 3)) * 0.4 + 0.3).astype(np.float32)
    alpha = np.zeros((64, 64), np.float32)
    alpha[20:44, 20:44] = 1.0
    edited = original.copy()
    edited[alpha > 0] = 0.9
    edited[alpha == 0] = np.clip(original[alpha == 0] * 1.2 + 0.05, 0.0, 1.0)

    scale, shift, skipped = align.anchor_affine(original, edited, alpha)
    assert skipped is False
    assert np.allclose(scale, 1.0 / 1.2, atol=5e-3)
    assert np.allclose(shift, -0.05 / 1.2, atol=2e-2)

    # 遮罩内换成别的颜色，估计结果不应变化
    edited2 = edited.copy()
    edited2[alpha > 0] = 0.1
    scale2, shift2, _ = align.anchor_affine(original, edited2, alpha)
    assert np.allclose(scale, scale2) and np.allclose(shift, shift2)


def test_anchor_affine_skips_when_anchor_below_min():
    original = np.full((16, 16, 3), 0.5, np.float32)
    alpha = np.ones((16, 16), np.float32)
    scale, shift, skipped = align.anchor_affine(original, original, alpha)
    assert skipped is True
    assert np.allclose(scale, 1.0) and np.allclose(shift, 0.0)


def test_band_lowfreq_merges_outside_untouched():
    """alpha==0 / alpha==1 严格不变；过渡带被拉向原图低频。"""
    rng = np.random.default_rng(43)
    original = (rng.random((64, 64, 3)) * 0.5 + 0.2).astype(np.float32)
    edited = np.clip(original * 1.15 + 0.05, 0.0, 1.0)
    alpha = np.zeros((64, 64), np.float32)
    alpha[10:54, 10:54] = 0.5
    alpha[16:48, 16:48] = 1.0

    merged = align.lowfreq_merge(original, edited, alpha)
    assert np.allclose(merged[alpha == 0.0], edited[alpha == 0.0], atol=1e-6)
    assert np.allclose(merged[alpha == 1.0], edited[alpha == 1.0], atol=1e-6)

    band = alpha == 0.5
    d_merged = float(np.abs(merged[band] - original[band]).mean())
    d_edited = float(np.abs(edited[band] - original[band]).mean())
    assert d_merged < d_edited * 0.8


def test_changed_stats_reports_leak():
    original = np.zeros((160, 160, 3), np.float32)
    edited = original.copy()
    edited[40:120, 40:120] = 1.0
    mask = np.zeros((160, 160), np.float32)
    mask[40:120, 40:120] = 1.0

    stats = align.changed_stats(original, edited, mask)
    # 80x80 / 160x160 = 25%，诊断不做预模糊，边界应严格落在遮罩内
    assert 0.24 < stats["changed_ratio"] < 0.26
    assert stats["leak_ratio"] == 0.0
    assert 0.02 <= stats["threshold"] <= 0.04


# ---------------------------------------------------------------------------
# region_shapes_to_mask
# ---------------------------------------------------------------------------


def test_region_shapes_rect_coverage():
    mask = align.region_shapes_to_mask(
        200, 100, [{"kind": "rect", "x": 10, "y": 20, "w": 50, "h": 30}]
    )
    assert mask.shape == (100, 200) and mask.dtype == np.float32
    assert int((mask > 0.5).sum()) == 50 * 30
    assert float(mask[20, 10]) == 1.0
    assert float(mask[49, 59]) == 1.0
    assert float(mask[50, 59]) == 0.0  # y 上界不含
    assert float(mask[9, 10]) == 0.0
    assert float(mask[20, 9]) == 0.0


def test_region_shapes_ellipse_coverage():
    w, h = 200, 100
    mask = align.region_shapes_to_mask(
        w, h, [{"kind": "ellipse", "x": 100, "y": 20, "w": 80, "h": 60}]
    )
    # 包围盒中心 (140, 50)，rx=40, ry=30
    assert float(mask[50, 140]) == 1.0
    assert float(mask[20, 100]) == 0.0  # 包围盒左上角不在椭圆内
    assert float(mask[80, 180]) == 0.0
    area = int((mask > 0.5).sum())
    expected = math.pi * 40 * 30
    assert abs(area - expected) / expected < 0.05, f"椭圆面积 {area} 与期望 {expected:.0f} 偏差过大"


def test_region_shapes_accepts_type_key_and_wrapped_json():
    # 兼容 Precise-Align 的 {"type": ...} 与 {"width","height","shapes"} 包装格式
    mask = align.region_shapes_to_mask(
        400,
        200,
        {
            "width": 100,
            "height": 50,
            "shapes": [{"type": "rect", "x": 10, "y": 10, "w": 20, "h": 10}],
        },
    )
    # 坐标按 4 倍缩放：x=40..119, y=40..79
    assert int((mask > 0.5).sum()) == 80 * 40
    assert float(mask[40, 40]) == 1.0
    assert float(mask[39, 40]) == 0.0


def test_region_shapes_union_expand_and_feather():
    shapes = [
        {"kind": "rect", "x": 10, "y": 10, "w": 20, "h": 20},
        {"kind": "ellipse", "x": 40, "y": 10, "w": 20, "h": 20},
    ]
    plain = align.region_shapes_to_mask(80, 60, shapes)
    expanded = align.region_shapes_to_mask(80, 60, shapes, expand=3)
    feathered = align.region_shapes_to_mask(80, 60, shapes, feather=4)
    assert float(plain.sum()) > 0
    assert float(expanded.sum()) > float(plain.sum())
    assert float(feathered.min()) >= 0.0 and float(feathered.max()) <= 1.0
    assert float(feathered[20, 20]) > 0.99
    # 两个形状并集都会生效
    assert float(plain[20, 20]) == 1.0 and float(plain[20, 50]) == 1.0


def test_region_shapes_empty_returns_zero_mask():
    zero = align.region_shapes_to_mask(32, 32, [])
    assert zero.shape == (32, 32) and float(zero.max()) == 0.0
    assert float(align.region_shapes_to_mask(32, 32, None).max()) == 0.0


# ---------------------------------------------------------------------------
# 静态约束：不允许 import torch / cv2
# ---------------------------------------------------------------------------


def test_align_does_not_import_torch_or_cv2():
    source = (ROOT / "server" / "align.py").read_text(encoding="utf-8")
    for forbidden in ("import torch", "import cv2", "from torch", "comfy.utils"):
        assert forbidden not in source, f"server/align.py 不允许出现 {forbidden!r}"
