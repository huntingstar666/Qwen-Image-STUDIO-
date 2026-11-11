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
#: 2：新增 ``chain_mask`` / ``chain_native`` 两套连续编辑预设。
#: 3：新增 ``panorama`` 全景预设（整画布采样 + 宽幅画布）。
#: 4：扩图长边对齐全局 max_side（4096）；原生模式启用整图校色开关。
#: 5：预设默认值支持全局覆写；新增采样 / 一致性 / LoRA 默认参数与自定义搭配。
#: 6：新增 local.crop_floor（最小裁剪窗，默认 1024，与孤海一致）。
#: 7：局部编辑默认填充闭合选区（local.fills=true），与孤海一致。
#: 8：新增 ``panorama360`` 预设（2:1 画布、源图占 40%、四周外扩、环绕融合）。
#: 9：360° 全景改为「参考图条件整张 2:1 重绘 + 中缝二次重绘」，去掉 coverage / 环绕融合。
PRESET_VERSION = 9

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

#: 标准采样（未开 Turbo 时生效；开了 Turbo 由档位覆盖）。
_DEFAULT_SAMPLING = {
    "steps": 25,
    "cfg": 4.0,
    "sampler": "euler",
    "scheduler": "simple",
    "denoise": 1.0,
}

#: 一致性 LoRA 默认：开启、强度 0.48；lora 为空表示跟随系统设置里的默认文件。
_DEFAULT_CONSISTENCY = {"enabled": True, "lora": "", "strength": 0.48}

#: 公共兜底：所有预设都要的零偏移 / 预处理 / 采样档位 / 一致性 / 额外 LoRA。
_COMMON = {
    "preprocess": _PREPROCESS,
    "zero_shift": {"enabled": True},
    "turbo": SAMPLING_PRESET,
    "sampling": _DEFAULT_SAMPLING,
    "consistency": _DEFAULT_CONSISTENCY,
    "loras": [],
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
            # 闭合描边画出的遮罩先填内部空洞再算包围盒，避免只改一圈边（对齐孤海）。
            "fills": True,
            "expand_top": 1.3,
            "expand_bottom": 1.4,
            "expand_left": 1.4,
            "expand_right": 1.4,
            "crop_min_side": 768,
            "crop_max_side": 2048,
            "crop_floor": 1024,
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
            "crop_floor": 1024,
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
        "summary": "灰边外补 · 裁块 ≥1024 · 接缝 3%/3% · 长边 ≤4096",
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
            "crop_floor": 1024,
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
        "outpaint": {"max_side": 4096},
        **_COMMON,
    },
    "panorama": {
        "label": "全景",
        "summary": "参考图 → 宽幅全景 · 2:1 / 3:1 / 4:1 · 整画布采样 · 接缝融合",
        "default": False,
        "task": {"mode": "panorama"},
        "local": {
            "enabled": True,
            # 全景必须整画布采样，裁块方案（b）会破坏横向连续性。
            "scheme": "a",
            "fills": False,
            "crop_min_side": 0,
            "crop_max_side": 4096,
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
            "hint": "gray_fill",
            "band_mode": "lowfreq",
        },
        "panorama": {
            "aspect": "2:1",
            "long_side": 3072,
            "wrap": False,
            "seam_blend": 24,
        },
        **_COMMON,
    },
    "panorama360": {
        "label": "360° 全景",
        "summary": "参考图 → 2:1 等距柱状全景 · 整张重绘 · 中缝二次修复",
        "default": False,
        "task": {"mode": "panorama360"},
        "local": {
            "enabled": True,
            # 360° 是「参考图条件 + 空 latent」整张重绘，没有遮罩合成。
            "scheme": "native",
            "fills": False,
            "crop_min_side": 0,
            "crop_max_side": 4096,
            "expand_pct": 0.0,
            "feather_pct": 0.0,
            "blend_pixels": 24,
            "dither": True,
            "feather": 32,
            "mask_expand": 0,
            "color_match": False,
            "color_strength": 0.6,
            "color_restore": False,
            "color_restore_strength": 1.0,
            "consistency": True,
            "hint": "none",
            "band_mode": "alpha",
        },
        "panorama360": {
            "long_side": 3072,
        },
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
            "crop_floor": 1024,
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
            "crop_floor": 1024,
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
    "chain_mask": {
        "label": "连续编辑·遮罩",
        "summary": "接力首选 · 每轮只重绘选区 · 遮罩外逐字节保持 · 每 5 轮回锚",
        "default": False,
        "task": {"mode": "edit"},
        # 连续编辑的流程契约：前端按此保持遮罩、记录回锚轮次并提示漂移。
        "chain": {
            "mode": "mask",
            "carry_mask": True,
            "anchor_every": 5,
            "drift_warn_delta_e": 10,
        },
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
            "crop_floor": 1024,
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
    "chain_native": {
        "label": "连续编辑·整图",
        "summary": "整图重绘 · 每轮全局校色 · 无遮罩会累积漂移，建议 ≤5 轮回锚",
        "default": False,
        "task": {"mode": "edit"},
        "chain": {
            "mode": "native",
            "carry_mask": False,
            "anchor_every": 5,
            "drift_warn_delta_e": 10,
        },
        "local": {
            "enabled": True,
            "scheme": "native",
            "fills": False,
            "crop_min_side": 0,
            "crop_max_side": 2048,
            "crop_floor": 1024,
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
}

_META_KEYS = ("label", "summary", "default")
_CUSTOM_PREFIX = "custom:"


def _cfg(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    if cfg is not None:
        return cfg
    from . import config

    return config.load_config()


def normalize_id(value: Any) -> str:
    return str(value or "").strip().lower()


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> None:
    for key, value in (patch or {}).items():
        if key in _META_KEYS:
            continue
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)


def factory_presets() -> dict[str, dict[str, Any]]:
    """代码内置的出厂预设（恢复默认的唯一依据）。"""
    return copy.deepcopy(EDIT_PRESETS)


def effective_presets(cfg: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """出厂预设 + 全局设置里的覆盖 = 实际生效的预设。"""
    cfg = _cfg(cfg)
    stored = cfg.get("preset_defaults") or {}
    out: dict[str, dict[str, Any]] = {}
    for key, factory in EDIT_PRESETS.items():
        preset = copy.deepcopy(factory)
        patch = stored.get(key) if isinstance(stored, dict) else None
        if isinstance(patch, dict):
            _deep_merge(preset, patch)
        out[key] = preset
    return out


def custom_presets(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """全局设置里保存的自定义搭配（id / name / params）。"""
    cfg = _cfg(cfg)
    out: list[dict[str, Any]] = []
    for raw in cfg.get("custom_presets") or []:
        if not isinstance(raw, dict):
            continue
        cid = normalize_id(raw.get("id"))
        name = str(raw.get("name") or "").strip()
        params = raw.get("params")
        if not cid.startswith(_CUSTOM_PREFIX) or not name or not isinstance(params, dict):
            continue
        out.append({"id": cid, "name": name, "params": copy.deepcopy(params)})
    return out


def _shaped_custom(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": item["name"],
        "summary": "自定义搭配 · 用户配置",
        "default": False,
        "custom": True,
        **copy.deepcopy(item["params"]),
    }


def get_preset(preset_id: Any, cfg: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """按 id 取预设（返回副本，调用方随便改不会污染常量）。"""
    key = normalize_id(preset_id)
    if not key:
        return None
    if key in EDIT_PRESETS:
        return copy.deepcopy(effective_presets(cfg)[key])
    if key.startswith(_CUSTOM_PREFIX):
        for item in custom_presets(cfg):
            if item["id"] == key:
                return _shaped_custom(item)
    return None


def default_preset_id() -> str:
    for key, preset in EDIT_PRESETS.items():
        if preset.get("default"):
            return key
    return next(iter(EDIT_PRESETS))


def _public_item(key: str, preset: dict[str, Any], *, custom: bool = False) -> dict[str, Any]:
    return {
        "id": key,
        "label": preset.get("label") or key,
        "summary": preset.get("summary") or "",
        "default": bool(preset.get("default")),
        "custom": custom,
        "task_mode": str((preset.get("task") or {}).get("mode") or "edit"),
        "params": {k: copy.deepcopy(v) for k, v in preset.items() if k not in _META_KEYS},
    }


def public_presets(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """下发给前端的预设摘要（出厂 + 全局覆写后的生效值）。"""
    presets = effective_presets(cfg)
    return [_public_item(key, preset) for key, preset in presets.items()]


def public_custom_presets(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in custom_presets(cfg):
        shaped = _shaped_custom(item)
        entry = _public_item(item["id"], shaped, custom=True)
        entry["label"] = item["name"]
        items.append(entry)
    return items


def preset_config_view(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """全局设置页读取的完整视图：出厂值 / 生效值 / 自定义 / 已覆写列表。"""
    cfg = _cfg(cfg)
    factory = [
        _public_item(key, preset) for key, preset in factory_presets().items()
    ]
    return {
        "version": PRESET_VERSION,
        "factory": factory,
        "presets": public_presets(cfg),
        # 设置页需要 id / name / params 的原始结构；任务页走 /api/meta 的公开摘要。
        "custom": copy.deepcopy(custom_presets(cfg)),
        "overridden": sorted((cfg.get("preset_defaults") or {}).keys()),
        "stored": copy.deepcopy(cfg.get("preset_defaults") or {}),
        "max_side": int(cfg.get("max_side") or 4096),
    }


# --------------------------------------------------------------------------- 校验

#: 任务别名：前端 ``detectTask`` 会产出 inpaint/replace，本质都是普通编辑。
#: 校验层与执行层共用这一份，避免「API 接受、预设拒绝」这类口径分裂。
TASK_ALIASES: dict[str, str] = {
    "": "edit",
    "none": "edit",
    "edit": "edit",
    "inpaint": "edit",
    "replace": "edit",
    "remove": "remove",
    "outpaint": "outpaint",
    "panorama": "panorama",
    "panorama360": "panorama360",
}

#: 局部编辑方案枚举（``raw`` 是 ``native`` 的历史别名）。
SCHEMES = ("a", "b", "auto", "native", "raw")

#: 数值参数区间：预设保存校验、API 请求校验、前端控件共用这一份。
#: ``step`` 只给前端控件用；区间不一致会让「保存得进、提交被拒」或「UI 调不到」。
NUMERIC_LIMITS: dict[str, dict[str, Any]] = {
    "preprocess.max_side": {"min": 256, "max": 8192, "step": 32},
    "preprocess.min_side": {"min": 256, "max": 8192, "step": 32},
    "preprocess.multiple": {"min": 8, "max": 256, "step": 8},
    "local.expand_top": {"min": 1, "max": 3, "step": 0.05},
    "local.expand_bottom": {"min": 1, "max": 3, "step": 0.05},
    "local.expand_left": {"min": 1, "max": 3, "step": 0.05},
    "local.expand_right": {"min": 1, "max": 3, "step": 0.05},
    "local.expand_pct": {"min": 0, "max": 20, "step": 0.5},
    "local.feather_pct": {"min": 0, "max": 30, "step": 0.5},
    "local.blend_pixels": {"min": 0, "max": 256, "step": 4},
    "local.feather": {"min": 0, "max": 256, "step": 4},
    "local.mask_expand": {"min": 0, "max": 256, "step": 4},
    "local.color_strength": {"min": 0, "max": 1, "step": 0.01},
    "local.color_restore_strength": {"min": 0, "max": 1, "step": 0.01},
    "local.crop_min_side": {"min": 0, "max": 4096, "step": 32},
    "local.crop_max_side": {"min": 0, "max": 4096, "step": 32},
    "local.crop_floor": {"min": 0, "max": 2048, "step": 32},
    "consistency.strength": {"min": 0, "max": 2, "step": 0.01},
    # Turbo 档位可覆盖加速 LoRA 的强度（MOSS 的 8 步 LoRA）；与 loras[].strength 同区间。
    "turbo.lora_strength": {"min": 0, "max": 2, "step": 0.05},
    "sampling.steps": {"min": 1, "max": 200, "step": 1},
    "sampling.cfg": {"min": 0, "max": 30, "step": 0.5},
    # denoise=0 等于「不采样、原样返回」，没有实际意义，统一从 0.05 起。
    "sampling.denoise": {"min": 0.05, "max": 1, "step": 0.05},
    "outpaint.top": {"min": 0, "max": 200, "step": 1},
    "outpaint.bottom": {"min": 0, "max": 200, "step": 1},
    "outpaint.left": {"min": 0, "max": 200, "step": 1},
    "outpaint.right": {"min": 0, "max": 200, "step": 1},
    "outpaint.max_side": {"min": 1024, "max": 8192, "step": 32},
    "panorama.long_side": {"min": 1024, "max": 4096, "step": 32},
    "panorama.seam_blend": {"min": 0, "max": 128, "step": 4},
    "panorama360.coverage": {"min": 0.3, "max": 0.6, "step": 0.01},
    "panorama360.long_side": {"min": 1024, "max": 4096, "step": 32},
    "panorama360.seam_blend": {"min": 0, "max": 128, "step": 4},
    "chain.anchor_every": {"min": 1, "max": 50, "step": 1},
    "chain.drift_warn_delta_e": {"min": 0, "max": 100, "step": 1},
}


def limits(path: str) -> dict[str, Any]:
    """取某个数值参数的区间（缺省返回全开区间，调用方自行兜底）。"""
    return NUMERIC_LIMITS.get(path) or {"min": None, "max": None, "step": None}


def _get(params: dict[str, Any], path: str, default: Any = None) -> Any:
    cursor: Any = params
    for part in path.split("."):
        if not isinstance(cursor, dict) or part not in cursor:
            return default
        cursor = cursor[part]
    return cursor


def validate_params(params: dict[str, Any], cfg: dict[str, Any] | None = None,
                    *, custom: bool = False, strict_task: bool = True) -> dict[str, list[str]]:
    """预设 / 自定义搭配的参数校验与冲突检测。

    返回 ``{"errors": [...], "warnings": [...]}``；errors 会阻止保存。

    ``strict_task=False`` 用于**请求**校验：任务专属的硬性组合（移除必须 fills+绿区、
    全景必须整画布+灰提示）在保存预设时才强制，请求里由 ``pipeline`` 按任务档位补齐，
    否则第三方只传 ``task.mode=remove`` 会被误拒。
    """
    cfg = _cfg(cfg)
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(params, dict):
        return {"errors": ["参数必须是对象"], "warnings": []}

    from . import config

    def num(path: str, low: float, high: float, label: str, *, required: bool = False) -> float | None:
        value = _get(params, path)
        if value is None:
            if required:
                errors.append(f"缺少 {label}")
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            errors.append(f"{label} 必须是数字")
            return None
        if not low <= number <= high:
            errors.append(f"{label} 必须在 {low:g}~{high:g}")
        return number

    def integer(path: str, low: int, high: int, label: str) -> int | None:
        value = _get(params, path)
        if value is None:
            return None
        try:
            number = int(value)
        except (TypeError, ValueError):
            errors.append(f"{label} 必须是整数")
            return None
        if not low <= number <= high:
            errors.append(f"{label} 必须在 {low}~{high}")
        return number

    def flag(path: str, label: str) -> bool | None:
        value = _get(params, path)
        if value is None:
            return None
        if not isinstance(value, bool):
            errors.append(f"{label} 必须是布尔值")
            return None
        return value

    def bounds(path: str) -> tuple[float, float]:
        """从共享区间表取 (min, max)，避免每个校验点各写一套数字。"""
        lim = limits(path)
        return float(lim["min"]), float(lim["max"])

    task = str(_get(params, "task.mode", "edit")).strip().lower()
    if task not in TASK_ALIASES:
        errors.append(f"未知 task.mode：{task!r}")

    scheme = str(_get(params, "local.scheme", "a")).strip().lower()
    if scheme not in SCHEMES:
        errors.append(f"未知 local.scheme：{scheme!r}")

    hint = str(_get(params, "local.hint", "none")).strip().lower()
    if hint not in ("none", "green_overlay", "gray_fill"):
        errors.append(f"未知 local.hint：{hint!r}")

    for path, label in (
        ("local.enabled", "局部编辑开关"),
        ("local.fills", "填充闭合选区"),
        ("local.dither", "确定性抖动"),
        ("local.color_match", "颜色匹配"),
        ("local.color_restore", "区域色彩还原"),
        ("local.consistency", "一致性开关"),
        ("zero_shift.enabled", "零偏移开关"),
        ("turbo.enabled", "Turbo 开关"),
        ("preprocess.enabled", "预处理开关"),
        ("panorama.wrap", "全景环绕"),
        ("panorama360.wrap", "360° 环绕融合"),
        ("panorama360.level", "360° 交界对齐"),
        ("consistency.enabled", "一致性 LoRA 开关"),
    ):
        flag(path, label)

    if _get(params, "preprocess.mode", "downscale_only") not in ("downscale_only", "clamp_range"):
        errors.append("preprocess.mode 只支持 downscale_only / clamp_range")
    pre_max = integer("preprocess.max_side", *bounds("preprocess.max_side"), "preprocess.max_side")
    pre_min = integer("preprocess.min_side", *bounds("preprocess.min_side"), "preprocess.min_side")
    integer("preprocess.multiple", *bounds("preprocess.multiple"), "preprocess.multiple")
    if pre_max is not None and pre_min is not None and pre_min > pre_max:
        errors.append("preprocess.min_side 不能大于 max_side")

    for path, label in (
        ("local.expand_top", "上扩系数"),
        ("local.expand_bottom", "下扩系数"),
        ("local.expand_left", "左扩系数"),
        ("local.expand_right", "右扩系数"),
        ("local.expand_pct", "接缝扩展"),
        ("local.feather_pct", "接缝羽化"),
        ("local.color_strength", "颜色强度"),
        ("local.color_restore_strength", "还原强度"),
        ("consistency.strength", "一致性强度"),
        ("turbo.lora_strength", "加速 LoRA 强度"),
        ("sampling.cfg", "CFG"),
        ("sampling.denoise", "降噪"),
    ):
        num(path, *bounds(path), label)

    crop_min = integer("local.crop_min_side", *bounds("local.crop_min_side"), "裁块下限")
    crop_max = integer("local.crop_max_side", *bounds("local.crop_max_side"), "裁块上限")
    integer("local.crop_floor", *bounds("local.crop_floor"), "最小裁剪窗")
    integer("local.feather", *bounds("local.feather"), "羽化像素")
    integer("local.mask_expand", *bounds("local.mask_expand"), "遮罩外扩")
    integer("local.blend_pixels", *bounds("local.blend_pixels"), "过渡带宽度")
    if crop_min and crop_max and crop_min > crop_max:
        errors.append("裁块下限不能大于裁块上限")

    if _get(params, "local.band_mode", "lowfreq") not in ("alpha", "lowfreq"):
        errors.append("local.band_mode 只支持 alpha / lowfreq")

    steps = integer("sampling.steps", *bounds("sampling.steps"), "采样步数")
    sampler = str(_get(params, "sampling.sampler", "") or "")
    scheduler = str(_get(params, "sampling.scheduler", "") or "")
    if sampler and sampler not in config.SAMPLERS:
        errors.append(f"未知采样器：{sampler!r}")
    if scheduler and scheduler not in config.SCHEDULERS:
        errors.append(f"未知调度器：{scheduler!r}")

    turbo_enabled = bool(_get(params, "turbo.enabled", False))
    profile_id = str(_get(params, "turbo.profile", "") or "")
    profile_ids = {str(item.get("id")) for item in config.TURBO_PROFILES}
    if turbo_enabled and profile_id and profile_id not in profile_ids:
        errors.append(f"未知 Turbo 档位：{profile_id!r}")

    max_side = int(cfg.get("max_side") or 4096)
    pads = []
    for key in ("top", "bottom", "left", "right"):
        value = num(f"outpaint.{key}", *bounds(f"outpaint.{key}"),
                    f"扩图 {key}", required=False)
        pads.append(0 if value is None else value)
    integer("outpaint.max_side", *bounds("outpaint.max_side"), "扩图最大长边")
    out_max = _get(params, "outpaint.max_side")
    try:
        out_max_int = int(out_max) if out_max is not None else None
    except (TypeError, ValueError):
        out_max_int = None
    if out_max_int is not None and out_max_int > max_side:
        errors.append(f"outpaint.max_side 不能超过全局 max_side（{max_side}）")

    aspect = str(_get(params, "panorama.aspect", "2:1") or "2:1")
    if aspect not in ("2:1", "3:1", "4:1", "21:9"):
        errors.append(f"未知全景比例：{aspect!r}")
    pano_long = integer("panorama.long_side", *bounds("panorama.long_side"), "全景长边")
    if pano_long is not None and pano_long > max_side:
        errors.append(f"panorama.long_side 不能超过全局 max_side（{max_side}）")
    integer("panorama.seam_blend", *bounds("panorama.seam_blend"), "全景接缝融合")

    num("panorama360.coverage", *bounds("panorama360.coverage"), "360° 源图占比")
    pano360_long = integer(
        "panorama360.long_side", *bounds("panorama360.long_side"), "360° 长边")
    if pano360_long is not None and pano360_long > max_side:
        errors.append(f"panorama360.long_side 不能超过全局 max_side（{max_side}）")
    integer("panorama360.seam_blend", *bounds("panorama360.seam_blend"), "360° 接缝融合")

    chain_mode = _get(params, "chain.mode")
    if chain_mode is not None and str(chain_mode) not in ("mask", "native"):
        errors.append("chain.mode 只支持 mask / native")
    integer("chain.anchor_every", *bounds("chain.anchor_every"), "回锚间隔")
    integer("chain.drift_warn_delta_e", *bounds("chain.drift_warn_delta_e"), "漂移告警阈值")

    consistency_lora = str(_get(params, "consistency.lora", "") or "").strip()
    if consistency_lora and not config.resolve_model(cfg, "lora", consistency_lora):
        errors.append(f"找不到一致性 LoRA：{consistency_lora!r}")

    loras = params.get("loras")
    if loras is not None:
        if not isinstance(loras, list):
            errors.append("loras 必须是数组")
        else:
            for index, item in enumerate(loras, start=1):
                if not isinstance(item, dict):
                    errors.append(f"loras[{index}] 必须是对象")
                    continue
                name = str(item.get("name") or "").strip()
                if not name:
                    # {"preset": "remove"} 由 pipeline 解析成文件，不需要文件名。
                    if item.get("preset"):
                        continue
                    errors.append(f"loras[{index}] 缺少文件名")
                elif not config.resolve_model(cfg, "lora", name):
                    errors.append(f"找不到 LoRA：{name!r}")
                try:
                    strength = float(item.get("strength", 1.0))
                except (TypeError, ValueError):
                    errors.append(f"loras[{index}].strength 必须是数字")
                else:
                    if not 0 <= strength <= 2:
                        errors.append(f"loras[{index}].strength 必须在 0~2")

    # ---- 冲突检测 ----
    # 任务组合的硬性要求只在「保存预设」时强制；请求里由 pipeline 按任务档位补齐。
    fills = bool(_get(params, "local.fills", False))
    if strict_task and task == "remove":
        if not fills:
            errors.append("元素移除要求开启「填充闭合选区」（local.fills=true）")
        if hint != "green_overlay":
            errors.append("元素移除要求 local.hint=green_overlay（绿区提示）")
    # 内置预设的扩图外边由任务页临时输入，不在预设默认里锁死；自定义搭配要求完整。
    if custom and task == "outpaint" and not any(value > 0 for value in pads):
        errors.append("扩图至少需要一条外扩边大于 0")
    if strict_task and task == "panorama":
        if scheme != "a":
            errors.append("全景必须使用 local.scheme=a（整画布采样）")
        if hint != "gray_fill":
            errors.append("全景要求 local.hint=gray_fill（灰边提示）")
    # 360° 是「参考图条件 + 空 latent」整张重绘，不铺灰边也不做遮罩合成。
    if strict_task and task == "panorama360":
        if scheme != "native":
            errors.append("360° 全景必须使用 local.scheme=native（整张重绘，无遮罩合成）")
        if hint not in ("none", "gray_fill"):
            errors.append("360° 全景不使用提示图（local.hint=none）")

    if scheme == "native" and task in ("remove", "outpaint"):
        warnings.append("原生模式不做遮罩合成，任务边缘可能无法逐字节保留")
    if not bool(_get(params, "consistency.enabled", True)):
        strength = _get(params, "consistency.strength")
        try:
            strength_mismatch = strength is not None and float(strength) != 0.48
        except (TypeError, ValueError):
            strength_mismatch = False
        if _get(params, "consistency.lora") or strength_mismatch:
            warnings.append("一致性已关闭，LoRA 文件名与强度不会生效")
    if custom:
        required = ("task", "local", "preprocess", "zero_shift", "turbo",
                    "sampling", "consistency")
        for key in required:
            if not isinstance(params.get(key), dict):
                errors.append(f"自定义搭配缺少 {key} 配置段")
        if steps is None:
            errors.append("自定义搭配必须设置采样步数")

    return {"errors": errors, "warnings": warnings}


def _clean_params(params: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for key, value in (params or {}).items():
        if key in _META_KEYS or str(key).startswith("_"):
            continue
        out[key] = copy.deepcopy(value)
    return out


def save_preset_config(payload: dict[str, Any], cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """保存全局预设默认值与自定义搭配；返回最新的设置视图。"""
    from . import config

    cfg = _cfg(cfg)
    patch: dict[str, Any] = {}
    stored = dict(cfg.get("preset_defaults") or {})
    reset_ids = payload.get("reset_presets") or []
    if not isinstance(reset_ids, list):
        raise ValueError("reset_presets 必须是数组")
    for key in reset_ids:
        stored.pop(normalize_id(key), None)
    if "preset_defaults" in payload:
        raw = payload.get("preset_defaults")
        if not isinstance(raw, dict):
            raise ValueError("preset_defaults 必须是对象")
        for key, params in raw.items():
            preset_id = normalize_id(key)
            if preset_id not in EDIT_PRESETS:
                raise ValueError(f"未知编辑预设：{preset_id!r}")
            if params is None:
                stored.pop(preset_id, None)  # null = 恢复出厂
                continue
            stats = validate_params(params, cfg)
            if stats["errors"]:
                label = EDIT_PRESETS[preset_id].get("label") or preset_id
                raise ValueError(f"{label}：{stats['errors'][0]}")
            stored[preset_id] = _clean_params(params)
    patch["preset_defaults"] = stored

    if "custom_presets" in payload:
        raw = payload.get("custom_presets")
        if not isinstance(raw, list):
            raise ValueError("custom_presets 必须是数组")
        clean_items = []
        seen_ids: set[str] = set()
        seen_names: set[str] = set()
        for index, item in enumerate(raw, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"custom_presets[{index}] 必须是对象")
            name = str(item.get("name") or "").strip()
            if not name:
                raise ValueError(f"自定义搭配 #{index} 缺少名称")
            if len(name) > 40:
                raise ValueError(f"自定义搭配名称过长：{name!r}")
            if name.lower() in seen_names:
                raise ValueError(f"自定义搭配名称重复：{name!r}")
            seen_names.add(name.lower())
            cid = normalize_id(item.get("id")) or f"{_CUSTOM_PREFIX}{index:02d}"
            if not cid.startswith(_CUSTOM_PREFIX):
                cid = f"{_CUSTOM_PREFIX}{cid}"
            if len(cid) > 60:
                raise ValueError("自定义搭配 id 过长")
            if cid in seen_ids:
                raise ValueError(f"自定义搭配 id 重复：{cid!r}")
            seen_ids.add(cid)
            params = item.get("params")
            stats = validate_params(params, cfg, custom=True)
            if stats["errors"]:
                raise ValueError(f"{name}：{stats['errors'][0]}")
            clean_items.append({
                "id": cid,
                "name": name,
                "params": _clean_params(params),
            })
        patch["custom_presets"] = clean_items

    patch["preset_defaults_version"] = PRESET_VERSION
    config.update_config(patch)
    return preset_config_view(config.load_config())


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

    预设可以是内置 id，也可以是 ``custom:<id>`` 的自定义搭配。
    自定义搭配不继承任何内置预设，只补它自己保存的参数。
    """
    preset_id = normalize_id(params.get("preset"))
    if not preset_id:
        return params, None
    cfg = _cfg()
    preset = get_preset(preset_id, cfg)
    if preset is None:
        raise ValueError(f"未知编辑预设：{preset_id!r}")
    source = {
        key: value for key, value in preset.items()
        if key not in _META_KEYS and key != "custom"
    }
    merged = copy.deepcopy(dict(params))
    _fill_missing(merged, source)
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
    # 版本号描述的是「代码里这套预设 schema」：config 里保存的 preset_defaults_version
    # 只是上次保存时的快照，升级后必然落后（例如新增 local.crop_floor），不能拿它冒充。
    version = PRESET_VERSION
    merged["preset_version"] = version
    return merged, {
        "id": preset_id,
        "version": version,
        "label": preset.get("label") or preset_id,
    }
