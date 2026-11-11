"""360° 全景几何/接缝原语单测。

对齐官方 Qwen2.1 全景工作流：输出固定 2:1 画布、参考图只做条件（缩到约 1.5MP），
生成后横向滚动半幅、只重绘中缝竖带，再滚回原排列。
"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from server import imaging


def _stripes(width: int, height: int) -> Image.Image:
    """按列着色的测试图：滚动后每一列的位置都能被精确验证。"""
    arr = np.zeros((height, width, 3), dtype=np.uint8)
    arr[..., 0] = np.arange(width, dtype=np.uint8)[None, :]
    arr[..., 1] = np.arange(width, dtype=np.uint8)[::-1][None, :]
    return Image.fromarray(arr)


def test_panorama360_default_canvas_is_2_1():
    plan = imaging.panorama360_plan(3000, 2000, long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (3072, 1536)
    assert plan.aspect == "2:1"
    assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0


def test_panorama360_work_size_is_contained_reference():
    plan = imaging.panorama360_plan(1100, 1586, long_side=3072)
    assert plan.work_w <= plan.canvas_w and plan.work_h <= plan.canvas_h
    assert plan.work_w % 32 == 0 and plan.work_h % 32 == 0
    assert plan.left == plan.right and plan.top == plan.bottom


def test_panorama360_square_source():
    plan = imaging.panorama360_plan(1024, 1024, long_side=3072)
    assert (plan.work_w, plan.work_h) == (1024, 1024)
    assert plan.scale == 1.0


def test_panorama360_never_upscales_reference():
    plan = imaging.panorama360_plan(512, 512, long_side=3072)
    assert (plan.work_w, plan.work_h) == (512, 512)
    assert plan.scale == 1.0


def test_panorama360_long_side_shrinks_canvas():
    plan = imaging.panorama360_plan(3000, 2000, long_side=2048)
    assert (plan.canvas_w, plan.canvas_h) == (2048, 1024)


def test_panorama360_pixel_budget_caps_4096():
    plan = imaging.panorama360_plan(3000, 2000, long_side=4096)
    assert plan.canvas_w * plan.canvas_h <= imaging.PANORAMA_MAX_PIXELS
    assert plan.canvas_w == 3456 and plan.canvas_h == 1728
    assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0


def test_panorama360_rejects_long_side_over_max_side():
    with pytest.raises(ValueError, match="超过上限"):
        imaging.panorama360_plan(1024, 1024, long_side=8192, max_side=4096)


def test_panorama360_rejects_bad_source():
    with pytest.raises(ValueError, match="尺寸无效"):
        imaging.panorama360_plan(0, 1024)


def test_panorama360_reference_scales_to_total_pixels():
    src = _stripes(1100, 1586)
    ref = imaging.panorama360_reference(src)
    assert ref.mode == "RGB"
    assert ref.width % 32 == 0 and ref.height % 32 == 0
    pixels = ref.width * ref.height
    assert 1.35e6 <= pixels <= 1.65e6
    # 保持原图长宽比（32 对齐带来的误差不超过一个 32 步长）
    assert abs(ref.width / ref.height - src.width / src.height) < 0.02


def test_panorama360_reference_upscales_small_source():
    ref = imaging.panorama360_reference(Image.new("RGB", (512, 512)))
    assert ref.width * ref.height >= 1.35e6


def test_roll_half_swaps_halves_exactly():
    src = _stripes(64, 8)
    rolled = imaging.roll_half(src)
    w = src.width
    original = np.asarray(src)
    result = np.asarray(rolled)
    assert np.array_equal(result[:, : w // 2], original[:, w // 2:])
    assert np.array_equal(result[:, w // 2:], original[:, : w // 2])
    # 滚两次回到原图
    assert np.array_equal(np.asarray(imaging.roll_half(rolled)), original)


def test_seam_band_mask_is_centered_and_feathered():
    width, height = 1024, 512
    mask = imaging.seam_band_mask(width, height)
    assert mask.shape == (height, width)
    assert mask.dtype == np.float32
    assert mask.min() == 0.0
    assert mask[:, width // 2].min() > 0.99
    # 两侧远端完全在带外
    assert float(mask[:, : width // 8].max()) == 0.0
    assert float(mask[:, -width // 8:].max()) == 0.0
    # 中心竖带覆盖宽度接近 7.8% + 两侧扩张
    covered = float((mask[height // 2] > 0.5).mean())
    expected = imaging.PANORAMA360_SEAM_BAND + 2 * imaging.PANORAMA360_SEAM_EXPAND
    assert abs(covered - expected) < 0.05


def test_seam_band_mask_scales_with_width():
    small = imaging.seam_band_mask(512, 256)
    large = imaging.seam_band_mask(2048, 1024)
    small_ratio = float((small[128] > 0.5).mean())
    large_ratio = float((large[512] > 0.5).mean())
    assert abs(small_ratio - large_ratio) < 0.02
