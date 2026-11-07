"""模型档案（协议 + 每模型 profile）。

引擎（`server/backends/native.py`）是共用的：装载权重 → 文本编码 → 空 latent →
sigma 调度 → 采样 → VAE 解码。不同图像模型的差异收敛到这里：

* 权重默认路径、latent 通道数 / 下采样倍数 / 像素对齐粒度；
* 采样默认值（MOSS 无加速 LoRA 时是 50 步 / cfg 3.5 / er_sde）；
* 加速方式：Qwen 用官方 sigma 表 + 加速 LoRA，MOSS 直接用 8 步 LoRA（步数/cfg 跟着改）；
* 可选能力：边界框布局（仅 MOSS）、SLG（仅 MOSS）、RGBA 输出（仅 Qwen）。

新增模型时：在 `_PROFILES` 里加一条 + 在 `_resolve` 里补权重解析即可，
pipeline / prompt_polish / /api/options 都从这里取数据。
"""
from __future__ import annotations

import os
from typing import Any

from . import config, model_slots

#: 未指定模型时使用的档案
DEFAULT_MODEL = "qwen"

#: MOSS 默认权重（相对 model_root；可用 config.json 的 moss 段覆盖）
MOSS_UNET = "diffusion_models/moss/moss_image_sft_bf16.safetensors"
MOSS_CLIP = "text_encoders/moss/qwen3.5_9b_int8_convrot.safetensors"
MOSS_VAE = "vae/moss/flux2-vae.safetensors"
MOSS_8STEP_LORA = "loras/moss8step/moss-8steps.safetensors"

MODEL_IDS: tuple[str, ...] = ("qwen", "moss")

_ALIASES = {
    "qwen21": "qwen",
    "qwen-image": "qwen",
    "qwen_image": "qwen",
    "qwen2.1": "qwen",
    "moss-image": "moss",
    "moss_image": "moss",
    "moss2": "moss",
}


def normalize_model(value: Any) -> str:
    """把请求里的模型名规整成档案 id；未知值抛 ``ValueError``。"""
    text = str(value or "").strip().lower()
    if not text:
        return DEFAULT_MODEL
    text = _ALIASES.get(text, text)
    if text not in MODEL_IDS:
        raise ValueError(f"未知模型 {value!r}，可选：{list(MODEL_IDS)}")
    return text


def _basename(path: str | None) -> str | None:
    return os.path.basename(path.replace("\\", "/")) if path else None


def _stem(path: str | None) -> str | None:
    name = _basename(path)
    return name.rsplit(".", 1)[0] if name else None


def _resolve(cfg: dict[str, Any], name: str, task: str | None = None) -> dict[str, Any]:
    if name == "moss":
        raw = cfg.get("moss") or {}
        # 权重走文生图（MOSS 档案）槽位，系统设置里可覆盖；旧 moss 段继续兜底。
        plan = model_slots.resolve_plan(cfg, task="t2i", model="moss")
        paths = {
            "unet": config.resolve_model(cfg, "unet", plan["moss_unet"]),
            "clip": config.resolve_model(cfg, "clip", plan["moss_clip"]),
            "vae": config.resolve_model(cfg, "vae", plan["moss_vae"]),
        }
        lora = config.resolve_model(cfg, "lora", plan["moss_turbo_lora"])
        slg_defaults = {
            "single_layers": "22",
            "double_layers": "",
            "start_percent": 0.0,
            "end_percent": 0.5,
        }
        slg_defaults.update(raw.get("slg") or {})
        return {
            "id": "moss",
            "label": "MOSS-Image (sft)",
            **paths,
            # MOSS 的 latent 是 128 通道 / 16 倍下采样，像素只需 16 对齐
            "latent_channels": 128,
            "latent_downscale": 16,
            "snap": 16,
            # 无加速 LoRA：50 步 / cfg 3.5 / er_sde（对齐参考工作流）
            "steps": int(raw.get("steps") or 50),
            "cfg": float(raw.get("cfg") if raw.get("cfg") is not None else 3.5),
            "sampler": str(raw.get("sampler") or "er_sde"),
            "scheduler": str(raw.get("scheduler") or "simple"),
            "negative_prompt": str(raw.get("negative_prompt") or "bad quality,"),
            # 8 步加速 LoRA：挂上后步数/cfg/采样器一起切换（对齐参考工作流）
            "accelerator": {
                "kind": "lora",
                "lora": lora,
                "strength": float(raw.get("turbo_lora_strength") or 1.0),
                "steps": int(raw.get("turbo_steps") or 8),
                "cfg": float(raw.get("turbo_cfg") if raw.get("turbo_cfg") is not None else 1.0),
                "sampler": str(raw.get("turbo_sampler") or "euler"),
                "scheduler": str(raw.get("turbo_scheduler") or "simple"),
            },
            "slg": slg_defaults,
            "capabilities": {"t2i": True, "edit": False, "bbox": True, "slg": True, "rgba": False},
            "prompt_profile": "moss",
            "width": int(raw.get("width") or 1024),
            "height": int(raw.get("height") or 1024),
            "megapixels": float(raw.get("megapixels") or 2.0),
        }

    raw_plan = model_slots.resolve_plan(cfg, task=task)
    paths = {key: config.resolve_model(cfg, key, raw_plan.get(key))
             for key in ("unet", "clip", "vae", "turbo_lora")}
    return {
        "id": "qwen",
        "label": "Qwen-Image 2.1",
        **{k: paths.get(k) for k in ("unet", "clip", "vae")},
        "latent_channels": 64,
        "latent_downscale": 16,
        "snap": 32,
        "steps": int(cfg["steps"]),
        "cfg": float(cfg["cfg"]),
        "sampler": str(cfg["sampler"]),
        "scheduler": str(cfg["scheduler"]),
        "negative_prompt": "",
        "accelerator": {
            "kind": "sigma",
            "profile": str(cfg.get("turbo_profile") or "turbo8_official"),
            "lora": paths.get("turbo_lora"),
            "strength": 1.0,
            "steps": 8,
            "cfg": 1.0,
            "sampler": "euler",
            "scheduler": "simple",
        },
        "slg": None,
        "capabilities": {"t2i": True, "edit": True, "bbox": False, "slg": False, "rgba": True},
        "prompt_profile": "qwen",
        "width": int(cfg["width"]),
        "height": int(cfg["height"]),
        "megapixels": 1.0,
    }


def get(cfg: dict[str, Any] | None = None, name: Any = None,
        task: str | None = None) -> dict[str, Any]:
    """取模型档案（权重已解析成绝对路径，可能为 None）。"""
    cfg = cfg or config.load_config()
    key = normalize_model(name if name is not None else cfg.get("model"))
    return _resolve(cfg, key, task=task)


def default_profile(cfg: dict[str, Any] | None = None,
                    task: str | None = None) -> dict[str, Any]:
    cfg = cfg or config.load_config()
    return get(cfg, cfg.get("model"), task=task)


def _moss_turbo(cfg: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, Any]]:
    """MOSS 的 Turbo 预设（格式对齐 TurboControl.profiles）。"""
    accel = profile["accelerator"]
    lora_path = accel.get("lora")
    lora_file = _basename(lora_path)
    lora_stem = _stem(lora_path)
    presets: list[dict[str, Any]] = []
    if lora_path:
        presets.append({
            "id": "moss8",
            "label": f"8 步加速 · {lora_stem} @{accel['strength']}",
            "kind": "lora",
            "steps": accel["steps"],
            "cfg": accel["cfg"],
            "sampler": accel["sampler"],
            "scheduler": accel["scheduler"],
            "lora": {
                "name": lora_stem,
                "file": lora_file,
                "strength": accel["strength"],
                "missing": not os.path.exists(lora_path),
            },
            "unet": None,
            "note": "挂载 8 步 LoRA，步数 / CFG / 采样器随预设切换。",
        })
    presets.append({
        "id": "none",
        "label": "不加速",
        "kind": "none",
        "steps": profile["steps"],
        "cfg": profile["cfg"],
        "sampler": profile["sampler"],
        "scheduler": profile["scheduler"],
        "lora": None,
        "unet": None,
        "note": f"{profile['steps']} 步 / CFG {profile['cfg']} / {profile['sampler']}。",
    })
    return presets


def public_list(cfg: dict[str, Any] | None = None,
                task: str = "t2i") -> list[dict[str, Any]]:
    """供 /api/options 的精简档案（不暴露绝对路径，只给文件名与缺失项）。"""
    cfg = cfg or config.load_config()
    qwen_turbo: list[dict[str, Any]] | None = None
    out: list[dict[str, Any]] = []
    for model_id in MODEL_IDS:
        p = get(cfg, model_id, task=task)
        missing = [k for k in ("unet", "clip", "vae") if not p.get(k)]
        if p["id"] == "qwen":
            if qwen_turbo is None:
                qwen_turbo = config.turbo_profiles_public(cfg)
            turbo = qwen_turbo
            samplers = list(config.SAMPLERS)
        else:
            turbo = _moss_turbo(cfg, p)
            samplers = ["er_sde", "euler"]
        out.append({
            "id": p["id"],
            "label": p["label"],
            "defaults": {
                "steps": p["steps"],
                "cfg": p["cfg"],
                "sampler": p["sampler"],
                "scheduler": p["scheduler"],
                "width": p["width"],
                "height": p["height"],
                "negative_prompt": p["negative_prompt"],
                "megapixels": p["megapixels"],
            },
            "latent_channels": p["latent_channels"],
            "snap": p["snap"],
            "accelerator": {
                "kind": p["accelerator"]["kind"],
                "lora": _basename(p["accelerator"].get("lora")),
                "strength": p["accelerator"].get("strength"),
                "steps": p["accelerator"].get("steps"),
                "cfg": p["accelerator"].get("cfg"),
                "sampler": p["accelerator"].get("sampler"),
                "scheduler": p["accelerator"].get("scheduler"),
            },
            "turbo": turbo,
            "samplers": samplers,
            "slg": p["slg"],
            "capabilities": p["capabilities"],
            "files": {k: _basename(p.get(k)) for k in ("unet", "clip", "vae")},
            "missing": missing,
            "ready": not missing,
        })
    return out


__all__ = [
    "DEFAULT_MODEL",
    "MODEL_IDS",
    "normalize_model",
    "get",
    "default_profile",
    "public_list",
    "MOSS_UNET",
    "MOSS_CLIP",
    "MOSS_VAE",
    "MOSS_8STEP_LORA",
]
