"""大图预处理的单元测试：只缩不放、32 对齐、还原尺寸精确、无多余重采样。"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from server import imaging


def _noise(w: int, h: int, seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(seed)
    return Image.fromarray(rng.integers(0, 256, (h, w, 3), dtype=np.uint8), "RGB")


def test_downscale_only_never_upscales():
    for w, h in [(4000, 3000), (2048, 2048), (1024, 768), (640, 480), (10, 10)]:
        plan = imaging.preprocess_plan(w, h, max_side=2048)
        assert plan.enabled
        assert plan.scale <= 1.0, (w, h)
        assert plan.work_w <= w and plan.work_h <= h, (w, h)


def test_canvas_dims_are_multiple_of_32_and_cover_work():
    for w, h in [(4000, 3000), (1000, 700), (10, 10), (4032, 3024)]:
        plan = imaging.preprocess_plan(w, h, max_side=2048)
        assert plan.canvas_w % 32 == 0 and plan.canvas_h % 32 == 0, (w, h)
        assert plan.canvas_w >= plan.work_w and plan.canvas_h >= plan.work_h, (w, h)
        assert plan.canvas_w - plan.work_w < 32, (w, h)
        assert plan.canvas_h - plan.work_h < 32, (w, h)


def test_long_side_is_clamped_to_max_side():
    plan = imaging.preprocess_plan(4000, 3000, max_side=2048)
    assert max(plan.work_w, plan.work_h) == 2048
    assert (plan.work_w, plan.work_h) == (2048, 1536)
    assert plan.canvas_w == 2048 and plan.canvas_h == 1536


def test_restore_preprocess_roundtrip_size_exact():
    src = _noise(4000, 3000)
    plan = imaging.preprocess_plan(*src.size, max_side=2048)
    work = imaging.apply_preprocess(src, plan)
    assert work.size == (plan.canvas_w, plan.canvas_h)
    back = imaging.restore_preprocess(work, plan)
    assert back.size == src.size


def test_restore_accepts_work_size_directly():
    src = _noise(4000, 3000)
    plan = imaging.preprocess_plan(*src.size, max_side=2048)
    work = src.resize((plan.work_w, plan.work_h), Image.Resampling.LANCZOS)
    back = imaging.restore_preprocess(work, plan)
    assert back.size == src.size


def test_no_resample_when_source_already_fits_and_aligned():
    src = _noise(1024, 768)
    plan = imaging.preprocess_plan(*src.size, max_side=2048)
    assert (plan.work_w, plan.work_h) == src.size
    restored = imaging.restore_preprocess(imaging.apply_preprocess(src, plan), plan)
    assert np.array_equal(np.asarray(restored), np.asarray(src))


def test_padding_is_cropped_away_exactly():
    # 1000x700：不缩放，但补边到 1024x704；裁掉补边后必须逐像素等于原图
    src = _noise(1000, 700)
    plan = imaging.preprocess_plan(*src.size, max_side=2048)
    assert (plan.canvas_w, plan.canvas_h) == (1024, 704)
    padded = imaging.apply_preprocess(src, plan)
    restored = imaging.restore_preprocess(padded, plan)
    assert restored.size == src.size
    assert np.array_equal(np.asarray(restored), np.asarray(src))


def test_disabled_plan_keeps_source_size_in_work():
    plan = imaging.preprocess_plan(4000, 3000, enabled=False)
    assert plan.enabled is False
    assert plan.scale == 1.0
    assert (plan.work_w, plan.work_h) == (4000, 3000)
    restored = imaging.restore_preprocess(imaging.apply_preprocess(_noise(4000, 3000, 1), plan), plan)
    assert restored.size == (4000, 3000)


def test_clamp_range_upscales_small_images():
    plan = imaging.preprocess_plan(320, 200, mode="clamp_range", min_side=768, max_side=2048)
    assert plan.scale > 1.0
    assert max(plan.work_w, plan.work_h) == 768


def test_restore_rejects_unexpected_size():
    plan = imaging.preprocess_plan(4000, 3000, max_side=2048)
    with pytest.raises(ValueError):
        imaging.restore_preprocess(_noise(50, 50), plan)


def test_apply_rejects_unexpected_source_size():
    plan = imaging.preprocess_plan(4000, 3000, max_side=2048)
    with pytest.raises(ValueError):
        imaging.apply_preprocess(_noise(100, 100), plan)


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        imaging.preprocess_plan(100, 100, mode="bogus")
