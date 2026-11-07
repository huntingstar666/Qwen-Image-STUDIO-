"""导出增强：WebP、目标体积二分、alpha 铺底、超限错误码（纯 CPU）。"""
from __future__ import annotations

import io
import os

import numpy as np
from PIL import Image

from server import config, imageops


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _noise(w: int = 640, h: int = 480) -> bytes:
    rng = np.random.default_rng(7)
    arr = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
    return _png(Image.fromarray(arr, mode="RGB"))


def _read(item: dict) -> bytes:
    with open(os.path.join(config.STORAGE_DIR, item["relpath"]), "rb") as fh:
        return fh.read()


def test_webp_export():
    result = imageops.process(_png(Image.new("RGB", (320, 240), (30, 90, 160))), {
        "format": "webp", "quality": 80, "prefix": "webptest",
    })
    item = result["images"][0]
    assert result["format"] == "webp"
    assert item["filename"].endswith(".webp")
    data = _read(item)
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert (item["width"], item["height"]) == (320, 240)


def test_jpeg_target_kb_binary_search():
    # 640×480 随机噪声在 q30 约 150KB，目标 220KB 必然可达
    result = imageops.process(_noise(), {
        "format": "jpeg", "quality": 92, "target_kb": 220, "prefix": "targettest",
    })
    item = result["images"][0]
    assert item["target_met"] is True
    assert item["bytes"] <= 220 * 1024
    assert 30 <= item["quality"] <= 92
    assert _read(item)[:2] == b"\xff\xd8"


def test_target_kb_unreachable_reports_false():
    result = imageops.process(_noise(1600, 1200), {
        "format": "jpeg", "target_kb": 32, "prefix": "toosmall",
    })
    item = result["images"][0]
    assert item["target_met"] is False
    assert item["quality"] == 30


def test_png_target_reports_actual_size():
    result = imageops.process(_png(Image.new("RGB", (64, 64), (200, 30, 30))), {
        "format": "png", "target_kb": 32, "prefix": "pngtarget",
    })
    item = result["images"][0]
    assert item["target_met"] is True


def test_jpeg_flattens_alpha_with_background():
    image = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
    image.paste((255, 40, 40, 255), (40, 40, 80, 80))
    result = imageops.process(_png(image), {
        "format": "jpeg", "background": "#2040ff", "quality": 95, "prefix": "alphabg",
    })
    decoded = Image.open(io.BytesIO(_read(result["images"][0]))).convert("RGB")
    r, g, b = decoded.getpixel((5, 5))
    assert b > 180 and b > r + 80, f"透明区应铺成蓝底，实际 {(r, g, b)}"
    r2, _g2, b2 = decoded.getpixel((60, 60))
    assert r2 > 180 and b2 < 120, f"实心区应保持红色，实际 {(r2, b2)}"


def test_export_rejects_unknown_format():
    try:
        imageops.process(_png(Image.new("RGB", (8, 8))), {"format": "tiff"})
    except imageops.ImageOpsError as exc:
        assert exc.code == "invalid_ops"
    else:
        raise AssertionError("未知导出格式应当报错")
