"""默认模型槽位：系统设置里「默认用哪个模型」的唯一事实来源。

优先级（低 → 高）：出厂值 < 全局槽位 < 预设覆盖 < 任务级显式请求。

本模块只做注册、规整、解析与匹配，不碰任务队列；
``/api/settings``、``/api/options``、``pipeline`` 共用同一套结果，
避免「设置页显示」和「实际请求」不一致。
"""

from __future__ import annotations

import copy
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

#: 文生图（MOSS 档案）专用槽位；只有 ``tasks.t2i.model = moss`` 时生效。
MOSS_SLOTS: dict[str, Slot] = {
    "moss_unet": Slot("moss_unet", "MOSS 扩散模型", "unet", True),
    "moss_clip": Slot("moss_clip", "MOSS 文本编码器", "clip", True),
    "moss_vae": Slot("moss_vae", "MOSS VAE", "vae", True),
    "moss_turbo_lora": Slot("moss_turbo_lora", "MOSS 8 步加速 LoRA", "lora", False),
}

#: 全部可用槽位（设置接口校验用）。
ALL_SLOTS: dict[str, Slot] = {**SLOTS, **MOSS_SLOTS}

#: 任务 id：文生图 / 图生图。
TASK_IDS: tuple[str, ...] = ("t2i", "edit")

#: 各任务实际展示 / 校验的槽位。t2i 随模型档案切换，edit 固定 Qwen。
_T2I_QWEN_KEYS: tuple[str, ...] = ("unet", "clip", "vae", "turbo_lora", "turbo_unet")
_T2I_MOSS_KEYS: tuple[str, ...] = tuple(MOSS_SLOTS)
_TASK_KEYS: dict[str, tuple[str, ...]] = {
    "t2i": _T2I_QWEN_KEYS + _T2I_MOSS_KEYS,
    "edit": tuple(SLOTS),
}
_TASK_ACTIVE_KEYS: dict[str, dict[str, tuple[str, ...]]] = {
    "t2i": {"qwen": _T2I_QWEN_KEYS, "moss": _T2I_MOSS_KEYS},
    "edit": {"qwen": tuple(SLOTS)},
}

#: MOSS 槽位 → 档案实际使用的键。
_MOSS_TO_PROFILE: dict[str, str] = {
    "moss_unet": "unet",
    "moss_clip": "clip",
    "moss_vae": "vae",
    "moss_turbo_lora": "turbo_lora",
}

#: 旧版顶层配置键 → 槽位（迁移兼容：没有 model_defaults 时用它兜底）。
LEGACY_KEYS: dict[str, str] = {
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
    from . import models  # 局部导入，避免模块级循环依赖

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
        "moss_unet": models.MOSS_UNET,
        "moss_clip": models.MOSS_CLIP,
        "moss_vae": models.MOSS_VAE,
        "moss_turbo_lora": models.MOSS_8STEP_LORA,
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
        if key not in ALL_SLOTS:
            raise ValueError(f"未知模型槽位：{key!r}（可选 {', '.join(ALL_SLOTS)}）")
        out[key] = normalize_value(value)
    return out


def normalize_task_slots(task: str, raw: Any) -> dict[str, str]:
    """校验任务级槽位补丁：只允许该任务实际使用的槽位。"""
    if task not in TASK_IDS:
        raise ValueError(f"未知任务：{task!r}（可选 {', '.join(TASK_IDS)}）")
    if not isinstance(raw, dict):
        raise ValueError(f"model_defaults.tasks.{task}.slots 必须是对象")
    allowed = set(_TASK_KEYS[task])
    out: dict[str, str] = {}
    for key, value in raw.items():
        if key not in allowed:
            raise ValueError(f"任务 {task} 不支持槽位：{key!r}")
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


def merge_section(cfg: dict[str, Any] | None, raw: Any) -> dict[str, Any]:
    """把 POST 的 ``model_defaults`` 补丁合并成可写盘的完整段。

    只允许出现 ``slots`` / ``tasks`` / ``preset_overrides``；
    槽位传空串表示「清空，回落出厂/公共值」。
    """
    cfg = cfg or {}
    if not isinstance(raw, dict):
        raise ValueError("model_defaults 必须是对象")
    current = section(cfg)
    merged: dict[str, Any] = {
        "version": int(current.get("version") or 2),
        "slots": dict(current.get("slots") or {}),
        "tasks": copy.deepcopy(current.get("tasks") or {}),
        "preset_overrides": dict(current.get("preset_overrides") or {}),
    }
    if "slots" in raw:
        for key, value in normalize(raw.get("slots")).items():
            if value:
                merged["slots"][key] = value
            else:
                merged["slots"].pop(key, None)
    if "tasks" in raw:
        tasks_raw = raw.get("tasks")
        if not isinstance(tasks_raw, dict):
            raise ValueError("model_defaults.tasks 必须是对象")
        for task, patch in tasks_raw.items():
            if task not in TASK_IDS:
                raise ValueError(f"未知任务：{task!r}（可选 {', '.join(TASK_IDS)}）")
            if patch is None:
                merged["tasks"].pop(task, None)
                continue
            if not isinstance(patch, dict):
                raise ValueError(f"model_defaults.tasks.{task} 必须是对象或 null")
            item = dict(merged["tasks"].get(task) or {})
            if "model" in patch:
                value = patch.get("model")
                if value is None or not str(value).strip():
                    item.pop("model", None)
                else:
                    from . import models

                    item["model"] = models.normalize_model(value)
            if "slots" in patch:
                slots = dict(item.get("slots") or {})
                for key, value in normalize_task_slots(task, patch.get("slots")).items():
                    if value:
                        slots[key] = value
                    else:
                        slots.pop(key, None)
                if slots:
                    item["slots"] = slots
                else:
                    item.pop("slots", None)
            if item:
                merged["tasks"][task] = item
            else:
                merged["tasks"].pop(task, None)
    if "preset_overrides" in raw:
        merged["preset_overrides"] = normalize_preset_overrides(raw.get("preset_overrides"))
    if merged["tasks"]:
        merged["version"] = 3
    return merged


def legacy_patch(cfg: dict[str, Any]) -> dict[str, str]:
    """把生效的全局槽位同步回旧顶层键，保持历史脚本与 turbo_plan 兼容。"""
    plan = resolve_plan(cfg)
    return {LEGACY_KEYS[key]: plan[key] for key in LEGACY_KEYS}


def _legacy_value(cfg: dict[str, Any], key: str) -> str | None:
    legacy_key = LEGACY_KEYS.get(key)
    if not legacy_key:
        return None
    value = cfg.get(legacy_key)
    if isinstance(value, str) and value.strip():
        return normalize_value(value)
    return None


def task_model(cfg: dict[str, Any] | None = None) -> str:
    """文生图默认模型档案：``tasks.t2i.model`` → 旧 ``cfg.model`` → ``qwen``。"""
    cfg = cfg or config.load_config()
    tasks = section(cfg).get("tasks") or {}
    item = tasks.get("t2i") if isinstance(tasks, dict) else {}
    raw = item.get("model") if isinstance(item, dict) else None
    from . import models

    try:
        return models.normalize_model(raw or cfg.get("model") or "qwen")
    except ValueError:
        return models.DEFAULT_MODEL


def resolve_plan(cfg: dict[str, Any] | None = None,
                 preset_id: str | None = None,
                 task: str | None = None,
                 model: str | None = None) -> dict[str, str]:
    """合并后的生效槽位。

    优先级：出厂 < 旧顶层键（仅无 model_defaults 时）< MOSS 旧配置段
    < 公共槽位 < 任务槽位 < 预设覆盖；``task=t2i`` 且档案为 MOSS 时，
    把 ``moss_*`` 槽位映射为档案实际使用的 unet / clip / vae / turbo_lora。
    """
    cfg = cfg or config.load_config()
    if task is not None and task not in TASK_IDS:
        raise ValueError(f"未知任务：{task!r}（可选 {', '.join(TASK_IDS)}）")
    plan = factory_slots()
    has_section = isinstance(cfg.get("model_defaults"), dict)
    data = section(cfg)

    # 旧顶层键只在「还没写过 model_defaults」时兜底；一旦启用新结构，
    # 清空某个槽位就应真正回落出厂值，而不是被旧值复活。
    if not has_section:
        for key in SLOTS:
            legacy = _legacy_value(cfg, key)
            if legacy:
                plan[key] = legacy

    # MOSS 旧配置段（config.json 的 moss.unet/clip/vae/turbo_lora）：始终作为兜底，
    # 低于 model_defaults 的公共 / 任务槽位，保证老用户配置继续生效。
    raw_moss = cfg.get("moss") or {}
    for slot_key, moss_key in _MOSS_TO_PROFILE.items():
        value = raw_moss.get(moss_key)
        if isinstance(value, str) and value.strip():
            plan[slot_key] = normalize_value(value)

    for key, value in (data.get("slots") or {}).items():
        if key in ALL_SLOTS and isinstance(value, str) and value.strip():
            plan[key] = normalize_value(value)

    if task:
        item = (data.get("tasks") or {}).get(task)
        if isinstance(item, dict):
            for key, value in (item.get("slots") or {}).items():
                if key in _TASK_KEYS[task] and isinstance(value, str) and value.strip():
                    plan[key] = normalize_value(value)

    if preset_id:
        overrides = data.get("preset_overrides") or {}
        override = overrides.get(str(preset_id))
        if isinstance(override, dict):
            for key, value in (override.get("slots") or {}).items():
                if key in ALL_SLOTS and isinstance(value, str) and value.strip():
                    plan[key] = normalize_value(value)

    if task == "t2i":
        from . import models

        try:
            effective = models.normalize_model(model or task_model(cfg))
        except ValueError:
            effective = models.DEFAULT_MODEL
        if effective == "moss":
            for slot_key, profile_key in _MOSS_TO_PROFILE.items():
                plan[profile_key] = plan.get(slot_key) or plan[profile_key]
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

    for key, slot in ALL_SLOTS.items():
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


def _audit_slots(plan: dict[str, str], matched: dict[str, dict[str, Any]],
                 keys: tuple[str, ...], factory: dict[str, str]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    slots: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for key in keys:
        slot = ALL_SLOTS[key]
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
    return slots, missing


def audit(cfg: dict[str, Any] | None = None,
          preset_id: str | None = None) -> dict[str, Any]:
    """设置页用的完整视图：每个槽位的期望值 / 当前值 / 是否找到 / 是否必需。"""
    cfg = cfg or config.load_config()
    plan = resolve_plan(cfg, preset_id)
    matched = match_slots(cfg, plan)
    factory = factory_slots()
    slots, missing = _audit_slots(plan, matched, tuple(SLOTS), factory)

    t2i_model = task_model(cfg)
    tasks: dict[str, dict[str, Any]] = {}
    for task in TASK_IDS:
        task_plan = resolve_plan(cfg, preset_id, task=task, model=t2i_model if task == "t2i" else None)
        task_matched = match_slots(cfg, task_plan)
        active_keys = set(_TASK_ACTIVE_KEYS[task].get(t2i_model if task == "t2i" else "qwen", ()))
        task_slots, task_missing = _audit_slots(task_plan, task_matched, _TASK_KEYS[task], factory)
        for key, item in task_slots.items():
            item["active"] = key in active_keys
        tasks[task] = {
            "model": t2i_model if task == "t2i" else "qwen",
            "matched": not task_missing,
            "slots": task_slots,
            "missing": task_missing,
        }

    data = section(cfg)
    return {
        "version": int(data.get("version") or 2),
        "matched": not missing,
        "slots": slots,
        "missing": missing,
        "preset_overrides": data.get("preset_overrides") or {},
        "t2i_model": t2i_model,
        "tasks": tasks,
    }
