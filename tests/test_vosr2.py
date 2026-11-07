"""VOSR2 本地引擎：模型包扫描与引擎接线测试（不加载 6.6GB 权重）。"""

from __future__ import annotations

import os
import shutil
import tempfile

from server.upscalers import registry
from server.upscalers.base import UpscaleError
from server.upscalers.manager import UpscalerManager
from server.upscalers.vosr2_runner import VOSR2Engine


def _make_bundle(root: str, name: str = "VOSR2", *, complete: bool = True) -> str:
    bundle = os.path.join(root, name)
    os.makedirs(os.path.join(bundle, "checkpoints"), exist_ok=True)
    os.makedirs(os.path.join(bundle, "Qwen-Image-vae-2d"), exist_ok=True)
    with open(os.path.join(bundle, "args.json"), "w", encoding="utf-8") as f:
        f.write("{}")
    with open(os.path.join(bundle, "checkpoints", "ema_model.safetensors"), "wb") as f:
        f.write(b"")
    for filename in ("config.json", "diffusion_pytorch_model.safetensors"):
        with open(os.path.join(bundle, "Qwen-Image-vae-2d", filename), "wb") as f:
            f.write(b"")
    if complete:
        with open(os.path.join(bundle, "dinov2_vitl14.safetensors"), "wb") as f:
            f.write(b"")
    return bundle


def test_scan_vosr2_requires_full_bundle() -> None:
    root = tempfile.mkdtemp(prefix=".tmp_vosr2_", dir="tests")
    try:
        _make_bundle(root, "VOSR2", complete=True)
        _make_bundle(root, "Broken", complete=False)
        cfg = {"model_root": root, "upscale": {"dirs": {"vosr2": root}, "vosr2": {"model_bundle": "VOSR2"}}}
        scan = registry.scan_vosr2(root, cfg)
        assert scan["bundles"] == ["VOSR2"], scan
        assert scan["ready"] is True, scan
        assert scan["missing"] == []

        cfg["upscale"]["vosr2"]["model_bundle"] = "Broken"
        scan = registry.scan_vosr2(root, cfg)
        assert scan["ready"] is False
        assert scan["missing"], scan
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_manager_builds_vosr2_engine_from_config() -> None:
    root = tempfile.mkdtemp(prefix=".tmp_vosr2_", dir="tests")
    try:
        cfg = {
            "model_root": root,
            "upscale": {
                "dirs": {"vosr2": root},
                "vosr2": {
                    "model_bundle": "VOSR2",
                    "precision": "bf16",
                    "tile_size": 256,
                    "tile_overlap": 32,
                    "vae_tile_size": 512,
                    "vae_tile_overlap": 64,
                    "color_alignment": "adain",
                },
            },
        }
        engine = UpscalerManager().get("vosr2", cfg)
        assert isinstance(engine, VOSR2Engine)
        assert engine.name == "vosr2"
        assert str(engine.model_dir) == os.path.normpath(root)
        assert engine.bundle == "VOSR2"
        assert engine.precision == "bf16"
        assert engine.tile_size == 256
        assert engine.tile_overlap == 32
        assert engine.vae_tile_size == 512
        assert engine.color_alignment == "adain"
        assert engine.loaded is False
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_vosr2_rejects_unsupported_scale_without_loading() -> None:
    engine = VOSR2Engine("tests", bundle="VOSR2")
    try:
        engine.upscale(object(), scale=3)
    except UpscaleError as exc:
        assert "2×" in str(exc) or "2" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("scale=3 应当被拒绝")
    assert engine.loaded is False
