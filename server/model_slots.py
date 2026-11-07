"""默认模型槽位：系统设置里「默认用哪个模型」的唯一事实来源。

优先级（低 → 高）：出厂值 < 全局槽位 < 预设覆盖 < 任务级显式请求。

本模块只做注册、规整、解析与匹配，不碰任务队列；
``/api/settings``、``/api/options``、``pipeline`` 共用同一套结果，
避免「设置页显示」和「实际请求」不一致。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from . import config


@dataclass(frozen=True)
class Slot:
    """一个可配置的默认模型槽位。"""

    key: str
    label: str
    kind: str  # 扫描类别：unet / clip / vae / lora
    required: bool
    note: str = ""


#: 第一阶段支持的槽位；新增槽位只需在这里加一行（前端按 schema 渲染）。
SLOTS: dict[str, Slot] = {
    "unet": Slot("unet", "扩散模型 UNET", "unet", True),
    "clip": Slot("clip", "文本编码器 CLIP", "clip", True),
    "vae": Slot("vae", "VAE", "vae", True),
    "turbo_lora": Slot("turbo_lora", "Turbo 加速 LoRA", "lora", False,
                       "Turbo 档位未固定 LoRA 时兜底"),
    "turbo_unet": Slot("turbo_unet", "Turbo 底模", "unet", False,
                       "Turbo「自动切底模」档使用"),
    "consistency_lora": Slot("consistency_lora", "一致性 LoRA", "lora", False),
    "remove_lora": Slot("remove_lora", "移除 LoRA", "lora", False),
    "outpaint_lora": Slot("outpaint_lora", "扩图 LoRA", "lora", False),
}

#: 旧版顶层配置键 → 槽位（迁移兼容：没有 model_defaults 时用它兜底）。
_LEGACY_KEYS: dict[str, str] = {
    "unet": "unet",
    "clip": "clip",
    "vae": "vae",
    "turbo_lora": "turbo_lora",
    "turbo_unet": "turbo_unet",
    "consistency_lora": "consistency_lora",
}


def _norm(value: str) -> str:
    return str(value or "").replace("\\", "/").strip("/")


def _basename(value: str) -> str:
    return _norm(value).rsplit("/", 1)[-1]


def factory_slots() -> dict[str, str]:
    """出厂默认（= 当前这套配置），与 config.DEFAULTS / LORA_TASKS 保持一致。"""
    defaults = config.DEFAULTS
    remove = (config.LORA_TASKS.get("remove") or {}).get("name") or ""
    outpaint = (config.LORA_TASKS.get("outpaint") or {}).get("name") or ""
    return {
        "unet": str(defaults.get("unet") or ""),
        "clip": str(defaults.get("clip") or ""),
        "vae": str(defaults.get("vae") or ""),
        "turbo_lora": str(defaults.get("turbo_lora") or ""),
        "turbo_unet": str(defaults.get("turbo_unet") or ""),
        "consistency_lora": str(defaults.get("consistency_lora") or ""),
        "remove_lora": str(remove),
        "outpaint_lora": str(outpaint),
    }


def section(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or config.load_config()
    raw = cfg.get("model_defaults")
    return raw if isinstance(raw, dict) else {}


def normalize_value(value: Any) -> str:
    """把槽位值规整成入库形式（统一正斜杠、去掉首尾空白）。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("槽位值必须是字符串路径")
    text = value.strip().strip('"').strip("'")
    if not text:
        return ""
    return os.path.normpath(text).replace("\\", "/")


def normalize(raw: Any) -> dict[str, str]:
    """校验并规整一份槽位补丁；未知键直接报错，避免写脏配置。"""
    if not isinstance(raw, dict):
        raise ValueError("model_defaults.slots 必须是对象")
    out: dict[str, str] = {}
    for key, value in raw.items():
        if key not in SLOTS:
            raise ValueError(f"未知模型槽位：{key!r}（可选 {', '.join(SLOTS)}）")
        out[key] = normalize_value(value)
    return out


def normalize_preset_overrides(raw: Any) -> dict[str, Any]:
    """校验预设覆盖结构：``{preset_id: null | {"slots": {...}}}``。"""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("preset_overrides 必须是对象")
    out: dict[str, Any] = {}
    for preset_id, value in raw.items():
        if value is None:
            out[str(preset_id)] = None
            continue
        if not isinstance(value, dict):
            raise ValueError(f"preset_overrides.{preset_id} 必须是对象或 null")
        slots = value.get("slots")
        out[str(preset_id)] = {"slots": normalize(slots) if slots is not None else {}}
    return out


def _legacy_value(cfg: dict[str, Any], key: str) -> str | None:
    legacy_key = _LEGACY_KEYS.get(key)
    if not legacy_key:
        return None
    value = cfg.get(legacy_key)
    if isinstance(value, str) and value.strip():
        return normalize_value(value)
    return None


def resolve_plan(cfg: dict[str, Any] | None = None,
                 preset_id: str | None = None) -> dict[str, str]:
    """合并后的生效槽位：出厂 < 旧顶层键 < 全局槽位 < 预设覆盖。"""
    cfg = cfg or config.load_config()
    plan = factory_slots()

    for key in SLOTS:
        legacy = _legacy_value(cfg, key)
        if legacy:
            plan[key] = legacy

    data = section(cfg)
    for key, value in (data.get("slots") or {}).items():
        if key in SLOTS and isinstance(value, str) and value.strip():
            plan[key] = normalize_value(value)

    if preset_id:
        overrides = data.get("preset_overrides") or {}
        override = overrides.get(str(preset_id))
        if isinstance(override, dict):
            for key, value in (override.get("slots") or {}).items():
                if key in SLOTS and isinstance(value, str) and value.strip():
                    plan[key] = normalize_value(value)
    return plan


def _display_value(cfg: dict[str, Any], absolute: str) -> str:
    """主根目录内用相对路径（与 scan_models 一致），根外用绝对路径。"""
    primary = str(cfg.get("model_root") or "")
    if primary:
        rel = os.path.relpath(absolute, primary)
        if not rel.startswith(".."):
            return rel.replace("\\", "/")
    return os.path.abspath(absolute).replace("\\", "/")


def match_slots(cfg: dict[str, Any] | None = None,
                plan: dict[str, str] | None = None) -> dict[str, dict[str, Any]]:
    """逐个槽位确认文件是否存在；返回 ``{slot: {expected,value,found,via}}``。

    匹配顺序：精确解析 → 路径后缀唯一 → 文件名唯一；多候选不算命中。
    """
    cfg = cfg or config.load_config()
    plan = plan if plan is not None else resolve_plan(cfg)
    models = config.scan_models(cfg)
    out: dict[str, dict[str, Any]] = {}

    for key, slot in SLOTS.items():
        expected = plan.get(key) or ""
        value = ""
        via: str | None = None
        if expected:
            absolute = config.resolve_model(cfg, slot.kind, expected)
            if absolute:
                value, via = _display_value(cfg, absolute), "exact"
            else:
                candidates = models.get(slot.kind) or []
                norm_expected = _norm(expected)
                # 双方互为后缀都算：候选可能少一层根目录，期望也可能多一层前缀
                suffix = []
                for item in candidates:
                    candidate = _norm(item.get("value") or "")
                    if candidate and (candidate.endswith(norm_expected)
                                      or norm_expected.endswith(candidate)):
                        suffix.append(item)
                if len(suffix) == 1:
                    value, via = suffix[0]["value"], "suffix"
                else:
                    base = _basename(norm_expected)
                    same_name = [item for item in candidates
                                 if _basename(item.get("value") or "") == base]
                    if len(same_name) == 1:
                        value, via = same_name[0]["value"], "basename"
        out[key] = {
            "expected": expected,
            "value": value or expected,
            "found": bool(value),
            "via": via,
        }
    return out


def match_factory(cfg: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """自动匹配出厂方案（首次使用向导第 2 步用）。"""
    cfg = cfg or config.load_config()
    return match_slots(cfg, factory_slots())


def audit(cfg: dict[str, Any] | None = None,
          preset_id: str | None = None) -> dict[str, Any]:
    """设置页用的完整视图：每个槽位的期望值 / 当前值 / 是否找到 / 是否必需。"""
    cfg = cfg or config.load_config()
    plan = resolve_plan(cfg, preset_id)
    matched = match_slots(cfg, plan)
    factory = factory_slots()
    slots: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for key, slot in SLOTS.items():
        item = matched[key]
        found = bool(item["found"])
        if slot.required and not found:
            missing.append(key)
        slots[key] = {
            "label": slot.label,
            "kind": slot.kind,
            "required": slot.required,
            "note": slot.note,
            "expected": item["expected"],
            "value": item["value"],
            "found": found,
            "via": item["via"],
            "source": "factory" if plan.get(key) == factory.get(key) else "custom",
        }
    data = section(cfg)
    return {
        "version": int(data.get("version") or 2),
        "matched": not missing,
        "slots": slots,
        "missing": missing,
        "preset_overrides": data.get("preset_overrides") or {},
    }
