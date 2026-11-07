"""resize 多模式 + EXIF 方向（纯 CPU，用 PIL 现造图片）。"""
from __future__ import annotations

import io

from PIL import Image

from server import imageops


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _scene(w: int = 400, h: int = 200) -> Image.Image:
    return Image.new("RGB", (w, h), (120, 160, 200))


def _resized(spec: dict, w: int = 400, h: int = 200) -> tuple[int, int]:
    out, _ = imageops.apply_ops(_png(_scene(w, h)), [{"op": "resize", **spec}])
    return out[0].size


def test_exact_keep_aspect_default_contains():
    assert _resized({"mode": "exact", "width": 300, "height": 300}) == (300, 150)


def test_exact_unlock_stretches():
    assert _resized({"mode": "exact", "width": 300, "height": 300,
                     "keep_aspect": False}) == (300, 300)


def test_exact_single_side_keeps_ratio():
    assert _resized({"mode": "exact", "width": 100}) == (100, 50)
    assert _resized({"mode": "exact", "height": 100}) == (200, 100)


def test_percent_mode():
    assert _resized({"mode": "percent", "percent": 50}) == (200, 100)
    assert _resized({"mode": "percent", "percent": 150}) == (600, 300)


def test_long_and_short_edge():
    assert _resized({"mode": "long_edge", "long_edge": 200}, 800, 400) == (200, 100)
    assert _resized({"mode": "short_edge", "short_edge": 100}, 800, 400) == (200, 100)


def test_megapixels_mode():
    # 400×200 = 0.08MP；目标 0.32MP → 边长 ×2
    assert _resized({"mode": "megapixels", "megapixels": 0.32}) == (800, 400)


def test_snap_rounds_to_multiple():
    width, height = _resized({"mode": "percent", "percent": 33, "snap": 32}, 1000, 500)
    assert width % 32 == 0 and height % 32 == 0
    assert (width, height) == (320, 160)


def test_filter_and_sharpen_keep_size():
    out, _ = imageops.apply_ops(_png(_scene(320, 240)), [
        {"op": "resize", "mode": "percent", "percent": 50,
         "filter": "bicubic", "sharpen_after": 80},
    ])
    assert out[0].size == (160, 120)


def test_invalid_mode_and_filter_raise():
    for spec in ({"mode": "不存在的模式"}, {"mode": "percent", "percent": 0},
                 {"mode": "percent", "filter": "不存在的滤镜"},
                 {"mode": "exact", "width": 99999, "height": 10}):
        try:
            imageops.apply_ops(_png(_scene()), [{"op": "resize", **spec}])
        except imageops.ImageOpsError as exc:
            if spec.get("width") == 99999:
                assert exc.code == "image_too_large"
            continue
        raise AssertionError(f"应当报错：{spec}")


def test_exif_orientation_applied_on_decode():
    image = _scene(400, 200)
    exif = image.getexif()
    exif[274] = 6  # 顺时针 90°
    buf = io.BytesIO()
    image.save(buf, format="JPEG", exif=exif.tobytes())
    out, _ = imageops.apply_ops(buf.getvalue(), [])
    assert out[0].size == (200, 400)
