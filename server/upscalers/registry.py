"""放大模型扫描与配置解析。

模型是**数据**：目录与文件名全部来自 ``config.json`` 的 ``upscale`` 段，
这里只负责把目录里的候选文件列出来，并判断引擎是否可用。
"""

from __future__ import annotations

import os
from typing import Any

from .. import config as app_config

SEEDVR2_EXTS = (".safetensors", ".gguf", ".pt", ".pth")
FLASHVSR_REQUIRED = (
    "diffusion_pytorch_model_streaming_dmd.safetensors",
    "Wan2.1_VAE.pth",
    "LQ_proj_in.ckpt",
    "posi_prompt.pth",
    "TCDecoder.ckpt",
)
#: VOSR2 一套 bundle 由 DiT / Qwen-Image VAE / DINOv2-L 三件套组成，缺一不可。
VOSR2_VAE_SUBDIR = "Qwen-Image-vae-2d"
VOSR2_VAE_FILES = ("config.json", "diffusion_pytorch_model.safetensors")
VOSR2_VISION_FILE = "dinov2_vitl14.safetensors"
VOSR2_DIT_CANDIDATES = (
    os.path.join("clean_weights", "ema_model.safetensors"),
    os.path.join("checkpoints", "ema_model.safetensors"),
    "ema_model.safetensors",
)


def section(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or app_config.load_config()
    return cfg.get("upscale") or {}


def resolve_dirs(cfg: dict[str, Any] | None = None) -> dict[str, str]:
    """解析三个引擎的模型目录；未配置时按 model_root 推断。"""
    cfg = cfg or app_config.load_config()
    up = section(cfg)
    root = str(cfg.get("model_root") or "")
    dirs = up.get("dirs") or {}
    out = {}
    for name, default in (
        ("seedvr2", os.path.join(root, "SEEDVR2")),
        ("flashvsr", os.path.join(root, "FlashVSR-v1.1")),
        ("vosr2", os.path.join(root, "vosr2")),
    ):
        value = str(dirs.get(name) or "").strip() or default
        out[name] = os.path.normpath(os.path.expandvars(os.path.expanduser(value))) if value else ""
    return out


def _files(directory: str) -> list[dict[str, Any]]:
    if not directory or not os.path.isdir(directory):
        return []
    items: list[dict[str, Any]] = []
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    for name in names:
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext not in SEEDVR2_EXTS:
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        items.append({"name": name, "size": size, "size_gb": round(size / 1024 ** 3, 2)})
    return items


def scan_seedvr2(directory: str, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    up = section(cfg)
    pref = up.get("seedvr2") or {}
    files = _files(directory)
    dits = [f for f in files if "vae" not in f["name"].lower()]
    vaes = [f for f in files if "vae" in f["name"].lower()]
    dit = str(pref.get("dit") or "")
    vae = str(pref.get("vae") or "")
    dit_ok = any(f["name"] == dit for f in dits)
    vae_ok = any(f["name"] == vae for f in vaes)
    return {
        "id": "seedvr2",
        "label": "SeedVR2 7B（单图质量优先）",
        "dir": directory,
        "exists": bool(directory) and os.path.isdir(directory),
        "dit": dit,
        "vae": vae,
        "dits": dits,
        "vaes": vaes,
        "ready": bool(dit_ok and vae_ok),
        "missing": [
            name for name, ok in ((dit, dit_ok), (vae, vae_ok)) if name and not ok
        ],
    }


def scan_flashvsr(directory: str, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    missing = [
        name for name in FLASHVSR_REQUIRED if not os.path.isfile(os.path.join(directory, name))
    ]
    return {
        "id": "flashvsr",
        "label": "FlashVSR 1.1（动图 / 速度优先）",
        "dir": directory,
        "exists": bool(directory) and os.path.isdir(directory),
        "files": _files(directory),
        "ready": not missing,
        "missing": missing,
    }


def _vosr2_bundle_ok(bundle_dir: str) -> bool:
    if not os.path.isfile(os.path.join(bundle_dir, "args.json")):
        return False
    if not any(
        os.path.isfile(os.path.join(bundle_dir, name)) for name in VOSR2_DIT_CANDIDATES
    ):
        return False
    vae_dir = os.path.join(bundle_dir, VOSR2_VAE_SUBDIR)
    if not all(os.path.isfile(os.path.join(vae_dir, name)) for name in VOSR2_VAE_FILES):
        return False
    return os.path.isfile(os.path.join(bundle_dir, VOSR2_VISION_FILE))


def scan_vosr2(directory: str, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """扫描 VOSR2 模型包（每个子目录是一套 bundle，如 ``VOSR2/``）。"""
    up = section(cfg)
    pref = up.get("vosr2") or {}
    bundle = str(pref.get("model_bundle") or "VOSR2")
    exists = bool(directory) and os.path.isdir(directory)
    bundles: list[str] = []
    if exists:
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            names = []
        for name in names:
            sub = os.path.join(directory, name)
            if os.path.isdir(sub) and _vosr2_bundle_ok(sub):
                bundles.append(name)
    ready = exists and bundle in bundles
    missing: list[str] = []
    if not exists:
        missing.append("模型目录")
    elif not bundles:
        missing.append("VOSR2 模型包")
    elif bundle not in bundles:
        missing.append(f"{bundle} 模型包")
    return {
        "id": "vosr2",
        "label": "VOSR2 1.4B（单步 / 细节优先）",
        "dir": directory,
        "exists": exists,
        "bundles": bundles,
        "model_bundle": bundle,
        "ready": ready,
        "missing": missing,
    }


def scan_all(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or app_config.load_config()
    dirs = resolve_dirs(cfg)
    up = section(cfg)
    engines = {
        "seedvr2": scan_seedvr2(dirs["seedvr2"], cfg),
        "flashvsr": scan_flashvsr(dirs["flashvsr"], cfg),
        "vosr2": scan_vosr2(dirs["vosr2"], cfg),
    }
    default = str(up.get("default_engine") or "seedvr2")
    if not engines.get(default, {}).get("ready"):
        ready = [k for k, v in engines.items() if v.get("ready")]
        default = ready[0] if ready else default
    return {
        "engines": engines,
        "default_engine": default,
        "defaults": up.get("defaults") or {"scale": 2, "seed": 42},
        "ready": any(e.get("ready") for e in engines.values()),
    }
