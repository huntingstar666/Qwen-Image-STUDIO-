"""水印：位置、透明度、平铺、图片水印（纯 CPU，不落盘）。"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image

from server import mediaops


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _white(w: int = 240, h: int = 180) -> bytes:
    return _png(Image.new("RGB", (w, h), (255, 255, 255)))


def _diff_mask(original: bytes, watermarked: Image.Image) -> np.ndarray:
    base = np.asarray(Image.open(io.BytesIO(original)).convert("RGB"), dtype=np.int16)
    out = np.asarray(watermarked.convert("RGB"), dtype=np.int16)
    return np.abs(out - base).max(axis=2) > 8


def _centroid(mask: np.ndarray) -> tuple[float, float]:
    ys, xs = np.nonzero(mask)
    return float(xs.mean()), float(ys.mean())


def test_text_watermark_bottom_right():
    src = _white()
    out = mediaops.apply_watermark(src, {
        "text": "© 2026 Studio", "font": "arial", "scale": 0.08,
        "color": "#ff0000", "opacity": 1.0, "position": "bottom-right", "margin": 0.04,
    })
    mask = _diff_mask(src, out)
    assert mask.sum() > 20, "水印应当改变像素"
    cx, cy = _centroid(mask)
    assert cx > out.width * 0.5 and cy > out.height * 0.5, (cx, cy)


def test_custom_position_is_centered():
    src = _white(300, 300)
    out = mediaops.apply_watermark(src, {
        "text": "W", "font": "arial", "scale": 0.2, "color": "#000000",
        "opacity": 1.0, "position": "custom", "x": 0.5, "y": 0.5,
    })
    mask = _diff_mask(src, out)
    cx, cy = _centroid(mask)
    assert abs(cx - 150) < 25 and abs(cy - 150) < 25, (cx, cy)


def test_zero_opacity_keeps_pixels():
    src = _white()
    out = mediaops.apply_watermark(src, {"text": "HIDDEN", "opacity": 0})
    assert _diff_mask(src, out).sum() == 0


def test_tile_covers_multiple_areas():
    src = _white(300, 300)
    out = mediaops.apply_watermark(src, {
        "text": "COPY", "font": "arial", "scale": 0.05, "opacity": 1.0,
        "color": "#000000", "tile": {"enabled": True, "gap_x": 0.3, "gap_y": 0.3, "angle": -20},
    })
    mask = _diff_mask(src, out)
    xs = np.nonzero(mask)[1]
    assert mask.sum() > 100
    assert xs.min() < 100 and xs.max() > 200, "平铺应当覆盖左右两侧"


def test_image_mark_center():
    src = _white(300, 200)
    mark_image = Image.new("RGBA", (80, 80), (0, 0, 0, 0))
    mark_image.paste((255, 0, 0, 255), (0, 0, 80, 80))
    out = mediaops.apply_watermark(src, {
        "position": "center", "opacity": 1.0,
        "image_mark": {"scale": 0.2, "opacity": 1.0},
    }, mark_data=_png(mark_image))
    r, _g, b = out.convert("RGB").getpixel((150, 100))
    assert r > 180 and b < 120, (r, b)


def test_empty_content_raises():
    try:
        mediaops.apply_watermark(_white(), {"opacity": 0.5})
    except mediaops.MediaOpsError as exc:
        assert exc.code == "invalid_field"
        return
    raise AssertionError("空水印应当报错")


def test_fonts_list_shape():
    fonts = mediaops.list_fonts()
    assert isinstance(fonts, list)
    for item in fonts:
        assert {"id", "label", "family", "path"} <= set(item)
