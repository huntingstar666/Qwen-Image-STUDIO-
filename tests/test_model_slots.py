"""默认模型槽位：优先级合并、路径规整与自动匹配。

注意：项目自带 pytest 子集（不支持 fixture），所有用例写成纯 assert 函数，
临时目录自行创建与清理。
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from server import config, model_slots


def _make_root() -> Path:
    return Path(tempfile.mkdtemp(prefix=".tmp_slots_", dir=str(Path(__file__).parent)))


def make_cfg(root: Path) -> dict:
    return {
        "model_root": str(root),
        "comfy_root": "",
        "extra_model_roots": [],
        "extra_model_paths_yaml": "",
        "model_dirs": {
            "unet": ["diffusion_models", "unet"],
            "clip": ["text_encoders", "clip"],
            "vae": ["vae"],
            "lora": ["loras"],
        },
    }


def touch(root: Path, relative: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


# --------------------------------------------------------------------- 出厂
def test_factory_equals_current_config():
    factory = model_slots.factory_slots()
    assert factory["unet"] == config.DEFAULTS["unet"]
    assert factory["clip"] == config.DEFAULTS["clip"]
    assert factory["vae"] == config.DEFAULTS["vae"]
    assert factory["turbo_lora"] == config.DEFAULTS["turbo_lora"]
    assert factory["turbo_unet"] == config.DEFAULTS["turbo_unet"]
    assert factory["remove_lora"] == config.LORA_TASKS["remove"]["name"]
    assert factory["outpaint_lora"] == config.LORA_TASKS["outpaint"]["name"]
    assert set(factory) == set(model_slots.SLOTS)


# --------------------------------------------------------------------- 合并
def test_resolve_plan_layers():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        cfg["model_defaults"] = {
            "version": 2,
            "slots": {"vae": "vae/custom_vae.safetensors"},
            "preset_overrides": {
                "remove": {"slots": {"unet": "diffusion_models/remove/unet.safetensors"}},
                "outpaint": None,
            },
        }
        base = model_slots.resolve_plan(cfg)
        assert base["vae"] == "vae/custom_vae.safetensors"
        assert base["unet"] == config.DEFAULTS["unet"]

        preset = model_slots.resolve_plan(cfg, "remove")
        assert preset["unet"] == "diffusion_models/remove/unet.safetensors"
        assert preset["vae"] == "vae/custom_vae.safetensors"

        # null 覆盖 = 跟随全局
        assert model_slots.resolve_plan(cfg, "outpaint")["unet"] == config.DEFAULTS["unet"]
        # 未配置的预设同样跟随全局
        assert model_slots.resolve_plan(cfg, "mask_edit")["unet"] == config.DEFAULTS["unet"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_legacy_top_level_keys_are_used():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        cfg["vae"] = "vae/legacy_vae.safetensors"
        plan = model_slots.resolve_plan(cfg)
        assert plan["vae"] == "vae/legacy_vae.safetensors"
        assert plan["unet"] == config.DEFAULTS["unet"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_normalize_rejects_unknown_slot():
    with pytest.raises(ValueError):
        model_slots.normalize({"not_a_slot": "x"})
    with pytest.raises(ValueError):
        model_slots.normalize({"vae": 123})
    with pytest.raises(ValueError):
        model_slots.normalize_preset_overrides({"remove": "bad"})


def test_normalize_paths_use_forward_slashes():
    out = model_slots.normalize({"vae": "  vae\\sub\\v.safetensors  "})
    assert out["vae"] == "vae/sub/v.safetensors"
    assert model_slots.normalize({"vae": "   "})["vae"] == ""


# --------------------------------------------------------------------- 匹配
def test_match_slots_exact_suffix_basename():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        touch(root, "diffusion_models/a/u.safetensors")
        touch(root, "diffusion_models/a/u2.safetensors")
        touch(root, "text_encoders/c.safetensors")

        plan = {
            "unet": "diffusion_models/a/u.safetensors",
            "clip": "elsewhere/c.safetensors",
            "vae": "vae/v.safetensors",
        }
        matched = model_slots.match_slots(cfg, plan)

        assert matched["unet"]["found"] is True
        assert matched["unet"]["via"] == "exact"
        assert matched["unet"]["value"] == "diffusion_models/a/u.safetensors"

        # 路径不存在但文件名唯一 → basename 命中
        assert matched["clip"]["found"] is True
        assert matched["clip"]["via"] == "basename"
        assert matched["clip"]["value"] == "text_encoders/c.safetensors"

        assert matched["vae"]["found"] is False
        assert matched["vae"]["value"] == "vae/v.safetensors"
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_match_slots_suffix_and_ambiguity():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        touch(root, "diffusion_models/a/u.safetensors")
        touch(root, "vae/other/vae.safetensors")
        touch(root, "vae/another/vae.safetensors")

        matched = model_slots.match_slots(cfg, {
            # 无法按任一模型子目录拼出完整路径，但结尾与候选一致 → 后缀命中
            "unet": "elsewhere/diffusion_models/a/u.safetensors",
            "vae": "missing/vae.safetensors",  # 同名两份 → 不自动选
        })
        assert matched["unet"]["found"] is True
        assert matched["unet"]["via"] == "suffix"
        assert matched["vae"]["found"] is False
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_audit_marks_missing_required():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        empty = model_slots.audit(cfg)
        assert empty["matched"] is False
        assert set(empty["missing"]) == {"unet", "clip", "vae"}
        assert empty["slots"]["unet"]["required"] is True

        factory = model_slots.factory_slots()
        touch(root, factory["unet"])
        touch(root, factory["clip"])
        touch(root, factory["vae"])
        ready = model_slots.audit(cfg)
        assert ready["matched"] is True
        assert ready["missing"] == []
        assert ready["slots"]["vae"]["found"] is True
        assert ready["slots"]["remove_lora"]["found"] is False
        assert ready["slots"]["remove_lora"]["required"] is False
    finally:
        shutil.rmtree(root, ignore_errors=True)
