"""全景画布几何与环绕接缝的单测（纯 assert，兼容根目录 pytest.py shim）。"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from server import imaging


def test_plan_2_1_square_source():
    plan = imaging.panorama_plan(1024, 1024, aspect="2:1", long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (2048, 1024)
    assert (plan.work_w, plan.work_h) == (1024, 1024)
    assert (plan.left, plan.right, plan.top, plan.bottom) == (512, 512, 0, 0)
    assert plan.scale == 1.0


def test_plan_2_1_landscape_source_keeps_height():
    plan = imaging.panorama_plan(2048, 1536, aspect="2:1", long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (3072, 1536)
    assert (plan.work_w, plan.work_h) == (2048, 1536)
    assert (plan.left, plan.right) == (512, 512)


def test_plan_3_1_square_source():
    plan = imaging.panorama_plan(1024, 1024, aspect="3:1", long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (3072, 1024)
    assert plan.left == 1024 and plan.right == 1024


def test_plan_4_1_within_pixel_budget():
    plan = imaging.panorama_plan(1024, 1024, aspect="4:1", long_side=4096)
    assert (plan.canvas_w, plan.canvas_h) == (4096, 1024)
    assert plan.canvas_w * plan.canvas_h <= imaging.PANORAMA_MAX_PIXELS


def test_plan_21_9_rounds_to_32():
    plan = imaging.panorama_plan(1024, 1024, aspect="21:9", long_side=4096)
    assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0
    assert plan.canvas_w == 2400 and plan.canvas_h == 1024


def test_plan_caps_long_side_by_downscaling_source():
    plan = imaging.panorama_plan(1024, 1024, aspect="2:1", long_side=1024)
    assert (plan.canvas_w, plan.canvas_h) == (1024, 512)
    assert (plan.work_w, plan.work_h) == (512, 512)
    assert plan.left == 256 and plan.top == 0


def test_plan_large_source_is_downscaled_not_upscaled():
    plan = imaging.panorama_plan(4000, 3000, aspect="2:1", long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (3072, 1536)
    assert plan.work_w <= 3072 and plan.work_h <= 1536
    assert plan.scale < 1.0


def test_plan_wide_source_expands_vertically():
    plan = imaging.panorama_plan(3000, 1000, aspect="2:1", long_side=4096)
    assert plan.canvas_w >= 3000
    assert plan.canvas_h > plan.work_h
    assert plan.top > 0 and plan.bottom > 0


def test_plan_rejects_unknown_aspect():
    with pytest.raises(ValueError, match="全景比例"):
        imaging.panorama_plan(1024, 1024, aspect="16:9")


def test_plan_rejects_long_side_over_max_side():
    with pytest.raises(ValueError, match="长边"):
        imaging.panorama_plan(1024, 1024, aspect="2:1", long_side=5000)


def test_plan_rejects_impossible_pixel_budget():
    with pytest.raises(ValueError, match="总像素"):
        imaging.panorama_plan(1024, 1024, aspect="4:1", long_side=4096,
                              max_pixels=1000)


def test_panorama_canvas_pastes_center_and_fills_gray():
    src = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
    plan = imaging.panorama_plan(64, 64, aspect="2:1", long_side=512)
    canvas = imaging.panorama_canvas(src, plan)
    assert canvas.size == (plan.canvas_w, plan.canvas_h)
    assert canvas.getpixel((0, 0))[:3] == plan.fill
    assert canvas.getpixel((plan.left + 10, plan.top + 10))[:3] == (255, 0, 0)


def test_mask_covers_only_generated_area():
    src = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
    plan = imaging.panorama_plan(64, 64, aspect="2:1", long_side=512)
    mask = imaging.outpaint_mask(plan.to_outpaint_info())
    assert float(mask[0, 0]) == 1.0
    assert float(mask[plan.top + 10, plan.left + 10]) == 0.0


def test_seam_level_removes_step_at_source_edge():
    arr = np.full((40, 320, 3), 100, dtype=np.uint8)
    arr[:, :128] = 40  # 左扩展区比源图暗 60 级
    out, report = imaging.seam_level(
        arr, {"left": 128, "right": 0, "top": 0, "bottom": 0}, band=16)
    assert out.dtype == np.uint8
    before = float(np.abs(arr[:, 128].astype(int) - arr[:, 127].astype(int)).mean())
    after = float(np.abs(out[:, 128].astype(int) - out[:, 127].astype(int)).mean())
    assert before > 50
    assert after <= 1
    # 源图区域一个像素都不动
    assert np.array_equal(out[:, 128:], arr[:, 128:])
    # 光晕修正窗口（96px）之外仍保持模型原样
    assert np.array_equal(out[:, :32], arr[:, :32])
    assert report["sides"]["left"]["before_mean_abs"] > 50


def test_seam_level_flattens_glow_inside_extension():
    arr = np.full((40, 320, 3), 100, dtype=np.uint8)
    arr[:, 108:128] = 150                # 交界内侧 20px 处的光晕带（不影响交界本身）
    out, report = imaging.seam_level(
        arr, {"left": 128}, band=48, flatten=64)
    before = float(arr[:, 108].astype(int).mean() - arr[:, 200].astype(int).mean())
    after = float(out[:, 108].astype(int).mean() - out[:, 200].astype(int).mean())
    assert before > 40
    assert after < before * 0.65
    assert np.array_equal(out[:, 128:], arr[:, 128:])
    assert report["sides"]["left"]["flatten_mean_abs"] > 1


def test_seam_level_skips_without_pads():
    arr = np.zeros((16, 16, 3), dtype=np.uint8)
    out, report = imaging.seam_level(arr, {"left": 0, "right": 0})
    assert report["skipped"] is True
    assert np.array_equal(np.asarray(out), arr)


def test_seam_level_keeps_pil_mode():
    im = Image.new("RGB", (96, 24), (120, 120, 120))
    for x in range(24):
        for y in range(24):
            im.putpixel((x, y), (60, 60, 60))
    out, _ = imaging.seam_level(im, {"left": 24}, band=8)
    assert isinstance(out, Image.Image)
    assert out.size == im.size and out.mode == im.mode


def test_wrap_seam_blend_reduces_edge_gap():
    arr = np.zeros((64, 128, 3), dtype=np.uint8)
    arr[:, 64:] = 255
    out, report = imaging.wrap_seam_blend(arr, blend_px=8)
    assert out.shape == arr.shape
    assert out.dtype == np.uint8
    assert report["after_max_abs"] < report["before_max_abs"]
    assert abs(int(out[0, 0, 0]) - int(out[0, -1, 0])) <= 1


def test_wrap_seam_blend_keeps_pil_mode():
    im = Image.new("RGB", (256, 32), (0, 0, 0))
    for x in range(128, 256):
        for y in range(32):
            im.putpixel((x, y), (255, 255, 255))
    out, report = imaging.wrap_seam_blend(im, blend_px=8)
    assert isinstance(out, Image.Image)
    assert out.size == im.size and out.mode == im.mode
    assert report["after_max_abs"] <= report["before_max_abs"]
