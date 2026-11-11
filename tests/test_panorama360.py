"""360° 全景几何（panorama360_plan）单测：四边外扩、coverage、32 对齐与像素预算。"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from server import imaging


def test_panorama360_default_canvas_is_2_1():
    plan = imaging.panorama360_plan(3000, 2000, long_side=3072)
    assert (plan.canvas_w, plan.canvas_h) == (3072, 1536)
    assert plan.aspect == "2:1"
    assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0


def test_panorama360_keeps_four_sides_for_landscape_source():
    plan = imaging.panorama360_plan(3000, 2000, long_side=3072)
    # 源图宽占 40%（1216/3072），高按比例 800，四周都留补边区
    assert (plan.work_w, plan.work_h) == (1216, 800)
    assert plan.left > 0 and plan.right > 0
    assert plan.top > 0 and plan.bottom > 0
    assert plan.left == plan.right == 928
    assert plan.top == plan.bottom == 368
    assert plan.work_w / plan.canvas_w <= 0.4


def test_panorama360_square_source():
    plan = imaging.panorama360_plan(1024, 1024, long_side=3072)
    assert (plan.work_w, plan.work_h) == (1024, 1024)
    assert (plan.left, plan.right, plan.top, plan.bottom) == (1024, 1024, 256, 256)
    assert plan.scale == 1.0


def test_panorama360_portrait_caps_height():
    plan = imaging.panorama360_plan(800, 1200, long_side=3072)
    assert plan.work_h <= int(plan.canvas_h * 0.85)
    assert plan.top > 0 and plan.bottom > 0
    assert plan.work_w % 32 == 0 and plan.work_h % 32 == 0


def test_panorama360_never_upscales_source():
    plan = imaging.panorama360_plan(512, 512, long_side=3072)
    assert (plan.work_w, plan.work_h) == (512, 512)
    assert plan.scale == 1.0


def test_panorama360_downscales_only_when_over_budget():
    plan = imaging.panorama360_plan(4096, 2731, long_side=3072)
    assert plan.scale < 1
    assert plan.canvas_w * plan.canvas_h <= imaging.PANORAMA_MAX_PIXELS


def test_panorama360_long_side_shrinks_canvas():
    plan = imaging.panorama360_plan(3000, 2000, long_side=2048)
    assert (plan.canvas_w, plan.canvas_h) == (2048, 1024)
    assert (plan.left, plan.right) == (624, 624)


def test_panorama360_pixel_budget_caps_4096():
    plan = imaging.panorama360_plan(3000, 2000, long_side=4096)
    assert plan.canvas_w * plan.canvas_h <= imaging.PANORAMA_MAX_PIXELS
    assert plan.canvas_w == 3456 and plan.canvas_h == 1728
    assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0


def test_panorama360_rejects_bad_coverage():
    with pytest.raises(ValueError, match="coverage"):
        imaging.panorama360_plan(1024, 1024, coverage=0.2)
    with pytest.raises(ValueError, match="coverage"):
        imaging.panorama360_plan(1024, 1024, coverage=0.7)
    with pytest.raises(ValueError, match="coverage"):
        imaging.panorama360_plan(1024, 1024, coverage="x")  # type: ignore[arg-type]


def test_panorama360_rejects_long_side_over_max_side():
    with pytest.raises(ValueError, match="超过上限"):
        imaging.panorama360_plan(1024, 1024, long_side=8192, max_side=4096)


def test_panorama360_canvas_pastes_source_in_center():
    src = Image.new("RGBA", (3000, 2000), (255, 0, 0, 255))
    plan = imaging.panorama360_plan(3000, 2000, long_side=3072)
    canvas = imaging.panorama_canvas(src, plan)
    arr = np.asarray(canvas)
    # 左上角与右下角是灰边
    assert tuple(arr[0, 0, :3]) == (128, 128, 128)
    assert tuple(arr[-1, -1, :3]) == (128, 128, 128)
    # 源图区域是红色
    assert tuple(arr[plan.top + 5, plan.left + 5, :3]) == (255, 0, 0)


def test_panorama360_mask_covers_outside_source():
    plan = imaging.panorama360_plan(3000, 2000, long_side=3072)
    mask = imaging.outpaint_mask(plan.to_outpaint_info())
    assert mask.shape == (plan.canvas_h, plan.canvas_w)
    # 源图中心未选中
    assert mask[plan.top + plan.work_h // 2, plan.left + plan.work_w // 2] == 0
    # 四角都应被补全
    assert mask[0, 0] > 0 and mask[0, -1] > 0
    coverage = float((mask > 0.01).mean())
    expected = 1 - (plan.work_w * plan.work_h) / (plan.canvas_w * plan.canvas_h)
    assert abs(coverage - expected) < 0.01
