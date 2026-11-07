"""放大引擎：目录推断、模型扫描与就绪判定。

不加载 torch/权重，只测注册表与管理器的轻量逻辑。
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from server import config
from server.upscalers import registry
from server.upscalers.manager import UpscalerManager


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix=".tmp_upscale_", dir=str(Path(__file__).parent)))


def _cfg(root: Path) -> dict:
    return {
        "model_root": str(root),
        "upscale": {
            "dirs": {"seedvr2": "", "flashvsr": ""},
            "default_engine": "seedvr2",
            "seedvr2": {"dit": "seedvr2_ema_7b_fp8_e4m3fn.safetensors",
                        "vae": "ema_vae_fp16.safetensors"},
            "defaults": {"scale": 2, "seed": 42},
        },
    }


def test_dirs_follow_model_root():
    root = _tmp()
    try:
        dirs = registry.resolve_dirs(_cfg(root))
        assert dirs["seedvr2"] == str(root / "SEEDVR2")
        assert dirs["flashvsr"] == str(root / "FlashVSR-v1.1")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_explicit_dirs_win():
    root = _tmp()
    try:
        cfg = _cfg(root)
        cfg["upscale"]["dirs"]["seedvr2"] = str(root / "custom")
        assert registry.resolve_dirs(cfg)["seedvr2"] == str(root / "custom")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_seedvr2_scan_detects_missing_and_ready():
    root = _tmp()
    try:
        cfg = _cfg(root)
        scan = registry.scan_seedvr2(str(root), cfg)
        assert scan["exists"] is True
        assert scan["ready"] is False
        assert len(scan["missing"]) == 2

        (root / "seedvr2_ema_7b_fp8_e4m3fn.safetensors").write_bytes(b"0")
        (root / "ema_vae_fp16.safetensors").write_bytes(b"0")
        scan = registry.scan_seedvr2(str(root), cfg)
        assert scan["ready"] is True
        assert scan["missing"] == []
        assert [f["name"] for f in scan["dits"]] == ["seedvr2_ema_7b_fp8_e4m3fn.safetensors"]
        assert [f["name"] for f in scan["vaes"]] == ["ema_vae_fp16.safetensors"]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_flashvsr_scan_requires_all_weights():
    root = _tmp()
    try:
        for name in registry.FLASHVSR_REQUIRED[:2]:
            (root / name).write_bytes(b"0")
        scan = registry.scan_flashvsr(str(root), _cfg(root))
        assert scan["ready"] is False
        assert set(scan["missing"]) == set(registry.FLASHVSR_REQUIRED[2:])
        for name in registry.FLASHVSR_REQUIRED[2:]:
            (root / name).write_bytes(b"0")
        assert registry.scan_flashvsr(str(root), _cfg(root))["ready"] is True
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_scan_all_falls_back_to_ready_engine():
    root = _tmp()
    try:
        seed_dir = root / "SEEDVR2"
        seed_dir.mkdir()
        (seed_dir / "seedvr2_ema_7b_fp8_e4m3fn.safetensors").write_bytes(b"0")
        (seed_dir / "ema_vae_fp16.safetensors").write_bytes(b"0")
        data = registry.scan_all(_cfg(root))
        assert data["engines"]["seedvr2"]["ready"] is True
        assert data["engines"]["flashvsr"]["ready"] is False
        assert data["default_engine"] == "seedvr2"
        assert data["ready"] is True
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_manager_status_is_empty_before_use():
    manager = UpscalerManager()
    status = manager.status({"upscale": {"dirs": {}}, "model_root": ""})
    assert status["loaded"] == {}
    assert manager.maybe_unload(10 ** 6, {"upscale": {"idle_unload_minutes": 0}}) == []


def test_defaults_section_exists():
    up = config.DEFAULTS.get("upscale") or {}
    assert up.get("default_engine") == "seedvr2"
    assert up.get("defaults", {}).get("scale") == 2
