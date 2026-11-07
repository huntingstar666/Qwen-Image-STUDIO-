"""S3：pipeline 使用默认槽位、缺模型结构化报错、LoRA 槽位覆盖。"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from server import config, model_slots, pipeline


def _make_root() -> Path:
    return Path(tempfile.mkdtemp(prefix=".tmp_pipe_", dir=str(Path(__file__).parent)))


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


def touch(root: Path, relative: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


def test_resolve_models_uses_plan_defaults():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        plan = model_slots.factory_slots()
        touch(root, plan["unet"])
        touch(root, plan["clip"])
        touch(root, plan["vae"])

        out = pipeline._resolve_models(cfg, {}, {})
        assert Path(out["unet"]).is_file()
        assert Path(out["clip"]).is_file()
        assert Path(out["vae"]).is_file()
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_models_honours_preset_override():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        plan = model_slots.factory_slots()
        touch(root, plan["clip"])
        touch(root, plan["vae"])
        touch(root, "diffusion_models/remove/unet.safetensors")
        cfg["model_defaults"] = {
            "version": 2,
            "slots": {},
            "preset_overrides": {
                "remove": {"slots": {"unet": "diffusion_models/remove/unet.safetensors"}},
            },
        }
        out = pipeline._resolve_models(cfg, {"preset": "remove"}, {})
        assert out["unet"].replace("\\", "/").endswith(
            "diffusion_models/remove/unet.safetensors")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_models_reports_missing_with_code():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        with pytest.raises(pipeline.PipelineError) as info:
            pipeline._resolve_models(cfg, {}, {})
        exc = info.value
        assert exc.code == "missing_models"
        slots = {item["slot"] for item in exc.meta["missing"]}
        assert {"unet", "clip", "vae"} <= slots
        assert exc.meta["missing"][0]["searched_dirs"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_build_loras_uses_remove_slot_override():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        touch(root, "loras/custom/remove_new.safetensors")
        cfg["model_defaults"] = {
            "version": 2,
            "slots": {"remove_lora": "loras/custom/remove_new.safetensors"},
            "preset_overrides": {},
        }
        loras = pipeline._build_loras(
            cfg, {"loras": [{"preset": "remove"}]}, {}, sampling={})
        assert len(loras) == 1
        assert loras[0]["name"].replace("\\", "/").endswith(
            "loras/custom/remove_new.safetensors")
        assert loras[0]["strength"] == config.LORA_TASKS["remove"]["strength"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_build_loras_reports_missing_with_code():
    root = _make_root()
    try:
        cfg = make_cfg(root)
        with pytest.raises(pipeline.PipelineError) as info:
            pipeline._build_loras(
                cfg, {"loras": [{"name": "loras/none.safetensors"}]}, {}, sampling={})
        assert info.value.code == "missing_models"
        assert info.value.meta["missing"][0]["slot"] == "lora"
    finally:
        shutil.rmtree(root, ignore_errors=True)
