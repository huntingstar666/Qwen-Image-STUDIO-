"""图片编辑预设：唯一事实源（图片精修 / 图生图共用）。

合并优先级（钉死，见 docs/PLAN_PS_EDIT_GH.md §13.5）：

    显式请求字段  >  preset 展开值  >  后端内置默认

``merge`` 只补请求里**没有**的键，绝不覆盖用户显式传的值；请求不带 ``preset``
时原样返回，保证老前端与第三方 API 行为不变。

预设参数与孤海三份工作流（九步局部编辑 / 元素移除 / 扩图）对齐：
- ``mask_edit`` 默认走 ``scheme=b``（孤海 MaskCropV2 几何），不再用 ``auto``；
- ``outpaint`` 的裁块下限 1024、接缝 3%/3%、外补长边 5120 与编辑档位分家；
- ``canvas`` / ``native`` 是退路，分别对应整画布采样与"不做遮罩合成"。

前端只渲染 ``public_presets()`` 下发的摘要，不复制数值（决策 33）。
"""
from __future__ import annotations

import copy
from typing import Any

#: 预设参数变更时必须 +1（写进 ``job.params.preset_version``，历史回放才不会串图）。
PRESET_VERSION = 1

#: 采样档位：仓库里的 Turbo 9 步底模档（qwen_image_2.1_turbo_int8_convrot + 9 段 sigma）。
#: 文档里称 "turbo9_gh"，实现复用已有的 ``turbo9_ckpt``（同一份权重与 sigma）。
SAMPLING_PRESET: dict[str, Any] = {"enabled": True, "profile": "turbo9_ckpt"}

_PREPROCESS = {
    "enabled": True,
    "max_side": 2048,
    "min_side": 768,
    "multiple": 32,
    "mode": "downscale_only",
}

#: 公共兜底：五个预设都要的零偏移 / 预处理 / 采样档位。
_COMMON = {
    "preprocess": _PREPROCESS,
    "zero_shift": {"enabled": True},
    "turbo": SAMPLING_PRESET,
}

EDIT_PRESETS: dict[str, dict[str, Any]] = {
    "mask_edit": {
        "label": "局部编辑",
        "summary": "孤海几何 · 裁块 768~2048 · 接缝 4%/5% · 一致性 0.48",
        "default": True,
        "task": {"mode": "edit"},
        "local": {
            "enabled": True,
            "scheme": "b",
            "fills": False,
            "expand_top": 1.3,
            "expand_bottom": 1.4,
            "expand_left": 1.4,
            "expand_right": 1.4,
            "crop_min_side": 768,
            "crop_max_side": 2048,
            "expand_pct": 4.0,
            "feather_pct": 5.0,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": True,
            "color_strength": 0.6,
            "color_restore": True,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "none",
            "band_mode": "lowfreq",
        },
        **_COMMON,
    },
    "remove": {
        "label": "元素移除",
        "summary": "填充闭合选区 · 绿区提示 · Remove LoRA 1.0",
        "default": False,
        "task": {"mode": "remove"},
        "local": {
            "enabled": True,
            "scheme": "b",
            "fills": True,
            "expand_top": 1.3,
            "expand_bottom": 1.4,
            "expand_left": 1.4,
            "expand_right": 1.4,
            "crop_min_side": 768,
            "crop_max_side": 2048,
            "expand_pct": 4.0,
            "feather_pct": 5.0,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": True,
            "color_strength": 0.6,
            "color_restore": True,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "green_overlay",
            "band_mode": "lowfreq",
        },
        **_COMMON,
    },
    "outpaint": {
        "label": "扩图",
        "summary": "灰边外补 · 裁块 ≥1024 · 接缝 3%/3% · 长边 ≤5120",
        "default": False,
        "task": {"mode": "outpaint"},
        "local": {
            "enabled": True,
            "scheme": "b",
            "fills": False,
            "expand_top": 1.3,
            "expand_bottom": 1.4,
            "expand_left": 1.4,
            "expand_right": 1.4,
            "crop_min_side": 1024,
            "crop_max_side": 2048,
            "expand_pct": 3.0,
            "feather_pct": 3.0,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": True,
            "color_strength": 0.6,
            "color_restore": True,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "gray_fill",
            "band_mode": "lowfreq",
        },
        "outpaint": {"max_side": 5120},
        **_COMMON,
    },
    "canvas": {
        "label": "整画布",
        "summary": "不裁块 · 整画布采样 · 遮罩合成 · 一致性 0.48",
        "default": False,
        "task": {"mode": "edit"},
        "local": {
            "enabled": True,
            "scheme": "a",
            "fills": False,
            "crop_min_side": 0,
            "crop_max_side": 2048,
            "expand_pct": 0.0,
            "feather_pct": 0.0,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": True,
            "color_strength": 0.6,
            "color_restore": True,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "none",
            "band_mode": "lowfreq",
        },
        **_COMMON,
    },
    "native": {
        "label": "原生",
        "summary": "不裁块 · 不做遮罩合成 · 整图校色 · 一致性 0.48",
        "default": False,
        "task": {"mode": "edit"},
        "local": {
            "enabled": True,
            "scheme": "native",
            "fills": False,
            "crop_min_side": 0,
            "crop_max_side": 2048,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": False,
            "color_strength": 0.6,
            "color_restore": True,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "none",
            "band_mode": "lowfreq",
        },
        **_COMMON,
    },
}

_META_KEYS = ("label", "summary", "default")


def normalize_id(value: Any) -> str:
    return str(value or "").strip().lower()


def get_preset(preset_id: Any) -> dict[str, Any] | None:
    """按 id 取预设（返回副本，调用方随便改不会污染常量）。"""
    key = normalize_id(preset_id)
    preset = EDIT_PRESETS.get(key)
    return copy.deepcopy(preset) if preset is not None else None


def default_preset_id() -> str:
    for key, preset in EDIT_PRESETS.items():
        if preset.get("default"):
            return key
    return next(iter(EDIT_PRESETS))


def public_presets() -> list[dict[str, Any]]:
    """下发给前端的预设摘要（id / 名称 / 说明 / 是否默认 / 只读参数）。"""
    items: list[dict[str, Any]] = []
    for key, preset in EDIT_PRESETS.items():
        items.append({
            "id": key,
            "label": preset.get("label") or key,
            "summary": preset.get("summary") or "",
            "default": bool(preset.get("default")),
            "task_mode": str((preset.get("task") or {}).get("mode") or "edit"),
            "params": {k: copy.deepcopy(v) for k, v in preset.items() if k not in _META_KEYS},
        })
    return items


def _fill_missing(target: dict[str, Any], source: dict[str, Any]) -> None:
    """只补缺：target 里已有且非 None 的键一律保留（显式优先）。"""
    for key, value in source.items():
        if key in _META_KEYS:
            continue
        current = target.get(key)
        if isinstance(value, dict):
            if current is None:
                target[key] = copy.deepcopy(value)
            elif isinstance(current, dict):
                _fill_missing(current, value)
        elif current is None:
            target[key] = copy.deepcopy(value)


def merge(params: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """按「显式 > 预设 > 内置默认」合并；不带 preset 时原样返回。

    返回 ``(merged, info)``，``info`` 会写进 ``job.params`` 供历史回放：
    ``{"id", "version", "label"}``。
    """
    preset_id = normalize_id(params.get("preset"))
    if not preset_id:
        return params, None
    preset = EDIT_PRESETS.get(preset_id)
    if preset is None:
        raise ValueError(f"未知编辑预设：{preset_id!r}")
    merged = copy.deepcopy(dict(params))
    _fill_missing(merged, preset)
    # task.mode 单独处理：显式给了就用显式的，没给才用预设默认任务。
    req_task = merged.get("task")
    if not isinstance(req_task, dict):
        req_task = {}
    # 显式任务与预设任务不一致时（例如 preset=remove 却显式 task.mode=edit），
    # 任务专属的 local 开关必须让位给新任务，否则会把「移除」的绿区提示 / 洞填充
    # 带进普通编辑，模型输入被污染（测试用例 0e 复现）。
    explicit_mode = normalize_id(((params.get("task") or {})
                                  if isinstance(params.get("task"), dict) else {}).get("mode"))
    preset_mode = normalize_id((preset.get("task") or {}).get("mode"))
    if explicit_mode and preset_mode and explicit_mode != preset_mode:
        req_local = params.get("local") if isinstance(params.get("local"), dict) else {}
        local = merged.get("local")
        if isinstance(local, dict):
            if "hint" not in req_local:
                local["hint"] = "none"
            if "fills" not in req_local:
                local["fills"] = explicit_mode == "remove"
    if not normalize_id(req_task.get("mode")):
        req_task = {**req_task, **copy.deepcopy(preset.get("task") or {})}
    merged["task"] = req_task
    merged["preset"] = preset_id
    merged["preset_version"] = PRESET_VERSION
    return merged, {
        "id": preset_id,
        "version": PRESET_VERSION,
        "label": preset.get("label") or preset_id,
    }
