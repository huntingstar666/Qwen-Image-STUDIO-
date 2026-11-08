"""管线守卫：把 2026-11-08 整改里「不依赖 GPU 的约定」固化成回归用例。

这些断言都只跑纯函数（不加载模型），CI 里可以随手执行；
需要 GPU 的四路线矩阵用 ``scripts/bench_local_edit.py`` 跑。
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from server import config, imaging, pipeline, presets


def _ring_mask(size: int = 400) -> np.ndarray:
    mask = np.zeros((size, size), dtype=np.float32)
    mask[100:300, 100:300] = 1.0
    mask[140:260, 140:260] = 0.0
    return mask


def test_min_crop_window_expands_small_mask_to_1024():
    """最小裁剪窗：小遮罩以自己为中心扩到 1024 见方（P1 阶段 1）。"""
    image = Image.new("RGB", (400, 400), (120, 120, 120))
    mask = np.zeros((400, 400), dtype=np.float32)
    mask[190:210, 190:210] = 1.0
    crop, info = imaging.crop_region_factors(
        image, mask, multiple=32, max_side=2048, min_side=0, min_window=1024)
    assert (info.w, info.h) == (1024, 1024)
    assert info.floor == 1024
    assert crop.size == (1024, 1024)


def test_min_crop_window_zero_disables_expansion():
    image = Image.new("RGB", (400, 400), (120, 120, 120))
    mask = np.zeros((400, 400), dtype=np.float32)
    mask[190:210, 190:210] = 1.0
    _, info = imaging.crop_region_factors(
        image, mask, multiple=32, max_side=2048, min_side=0, min_window=0)
    assert max(info.w, info.h) < 1024
    assert info.floor == 0


def test_fills_only_changes_hole_bbox_not_closed_shapes():
    """fills 只影响包围盒；对闭合遮罩是恒等变换（阶段 4 的实测结论）。"""
    image = Image.new("RGB", (400, 400), (120, 120, 120))
    mask = _ring_mask()
    kwargs = dict(expand_top=1.0, expand_bottom=1.0, expand_left=1.0,
                  expand_right=1.0, multiple=32, max_side=2048,
                  min_side=0, min_window=0)
    plain, _ = imaging.crop_region_factors(image, mask, fills=False, **kwargs)
    filled, _ = imaging.crop_region_factors(image, mask, fills=True, **kwargs)
    assert plain.size == filled.size


def test_sampler_mask_is_binarized():
    """送采样器的遮罩是硬边（>0.5），软边只留给合成阶段。"""
    soft = np.linspace(0, 1, 64 * 64, dtype=np.float32).reshape(64, 64)
    hard = (soft > 0.5).astype(soft.dtype)
    assert set(np.unique(hard).tolist()) == {0.0, 1.0}


def test_task_local_overrides_follow_task_but_keep_explicit():
    merged, _ = presets.merge({"preset": "mask_edit", "task": {"mode": "outpaint"}})
    local = merged["local"]
    assert (local["crop_min_side"], local["expand_pct"], local["feather_pct"]) == (768, 4.0, 5.0)
    fixed = pipeline._task_local_overrides(local, {}, "outpaint")
    assert (fixed["crop_min_side"], fixed["expand_pct"], fixed["feather_pct"]) == (1024, 3.0, 3.0)
    assert fixed["hint"] == "gray_fill" and fixed["fills"] is False
    merged_explicit, _ = presets.merge({
        "preset": "mask_edit", "task": {"mode": "outpaint"},
        "local": {"expand_pct": 4.5},
    })
    keep = pipeline._task_local_overrides(
        merged_explicit["local"], {"expand_pct": 4.5}, "outpaint")
    assert keep["expand_pct"] == 4.5
    assert keep["feather_pct"] == 3.0
    untouched = pipeline._task_local_overrides(local, {}, "edit")
    assert untouched["expand_pct"] == 4.0


def test_task_lora_dedupes_by_basename():
    name = config.resolve_lora_preset("remove")["name"]
    abs_path = "D:/models/" + name
    same = pipeline._ensure_task_lora([{"name": abs_path, "strength": 0.6}], "remove")
    assert same == [{"name": abs_path, "strength": 0.6}]
    other = pipeline._ensure_task_lora([{"name": "other.safetensors", "strength": 1}], "remove")
    assert other[0] == {"preset": "remove"}
    empty = pipeline._ensure_task_lora([], "outpaint")
    assert empty == [{"preset": "outpaint"}]


def test_watermark_prompt_detects_on_raw_text():
    out = pipeline.augment_watermark_prompt(
        "电影感；去掉水印", None, detect="去掉水印")
    assert out and "徽章" in out
    assert pipeline.augment_watermark_prompt(
        "风格：灰色调全景；换成蓝天", None, detect="换成蓝天") is None


def test_preset_enums_are_single_source():
    assert presets.TASK_ALIASES["inpaint"] == "edit"
    assert "raw" in presets.SCHEMES
    assert "none" not in presets.SCHEMES
    assert presets.limits("sampling.denoise")["min"] == 0.05
