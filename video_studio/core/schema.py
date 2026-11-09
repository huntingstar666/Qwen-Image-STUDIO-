"""项目字段注册表（唯一来源）。

所有可编辑字段只在这里定义一次：默认值、类型、枚举、区间。
后端校验与前端表单都从这里派生，禁止在其他文件里重复定义字段。

前端通过 ``GET /api/schema`` 拿到 :func:`public_schema` 的结果。
"""
from __future__ import annotations

import copy
import time
import uuid
from typing import Any

SCHEMA_VERSION = 1

#: 画布比例（比值 = 宽 / 高）
RATIOS: dict[str, float] = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "1:1": 1.0,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "3:2": 3 / 2,
    "2:3": 2 / 3,
    "21:9": 21 / 9,
}

TRANSITIONS = ("cut", "fade", "fadeblack")
#: 镜头语言：固定 / 慢推 / 慢拉 / 横移 / 纵摇 / 对角推
MOTIONS = ("none", "push", "pull", "left", "right", "up", "down", "diag")
SHOT_STATUS = ("pending", "generating", "ready", "failed")
#: 台词来源：auto = 跟随覆盖到的字幕；manual = 用户手改或合并/拆分写入
TEXT_MODES = ("auto", "manual")
SUBTITLE_POSITIONS = ("bottom", "middle", "top")
WATERMARK_POSITIONS = (
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
)
EXPORT_PRESETS = ("ultrafast", "veryfast", "fast", "medium", "slow")
FONT_IDS = ("msyhbd", "msyh", "simhei", "simsun", "simkai", "arialbd", "arial")

#: 主项目生图模型档案（model id 由主项目提供，这里只做兜底默认值）
DEFAULT_IMAGE_MODEL = "qwen"

# --------------------------------------------------------------------------- 注册表

SCHEMA: dict[str, dict[str, Any]] = {
    "canvas": {
        "type": "object", "label": "画布",
        "fields": {
            "ratio": {"type": "enum", "options": list(RATIOS), "default": "16:9", "label": "画布比例"},
            "longSide": {"type": "int", "min": 480, "max": 3840, "default": 1920, "label": "导出长边"},
            "fps": {"type": "int", "min": 12, "max": 60, "default": 30, "label": "帧率"},
        },
    },
    "locks": {
        "type": "object", "label": "锁定",
        "fields": {
            "style": {
                "type": "object", "label": "风格锁",
                "fields": {
                    "enabled": {"type": "bool", "default": True, "label": "启用风格锁"},
                    "styleId": {"type": "str", "default": "", "label": "风格库预设"},
                    "prefix": {"type": "text", "default": "", "label": "风格描述"},
                    "suffix": {"type": "text", "default": "", "label": "画面质感词"},
                    "negative": {"type": "text", "default": "", "label": "负面词"},
                    "seedBase": {"type": "int", "min": 0, "max": 2147483647, "default": 20261109,
                                 "label": "seed 基线"},
                    "consistency": {
                        "type": "object", "label": "一致性 LoRA",
                        "fields": {
                            "name": {"type": "str", "default": "", "label": "LoRA 名称"},
                            "strength": {"type": "float", "min": 0.0, "max": 2.0, "default": 0.48,
                                         "label": "强度"},
                        },
                    },
                },
            },
            "content": {
                "type": "object", "label": "内容锁",
                "fields": {
                    "enabled": {"type": "bool", "default": True, "label": "启用内容锁"},
                    "strict": {"type": "bool", "default": True, "label": "严格模式"},
                    "imageAnchor": {"type": "bool", "default": True, "label": "参考图锚定"},
                    "entities": {
                        "type": "entity_list", "default": [], "label": "角色与场景",
                        "kinds": ["character", "location", "prop"],
                    },
                },
            },
        },
    },
    "render": {
        "type": "object", "label": "成片",
        "fields": {
            "subtitle": {
                "type": "object", "label": "字幕",
                "fields": {
                    "enabled": {"type": "bool", "default": True, "label": "烧录字幕"},
                    "fontId": {"type": "enum", "options": list(FONT_IDS), "default": "msyhbd",
                               "label": "字体"},
                    "size": {"type": "int", "min": 12, "max": 160, "default": 46, "label": "字号"},
                    "color": {"type": "str", "default": "#FFFFFF", "label": "颜色"},
                    "outline": {"type": "int", "min": 0, "max": 12, "default": 2, "label": "描边宽度"},
                    "outlineColor": {"type": "str", "default": "#000000", "label": "描边颜色"},
                    "marginV": {"type": "int", "min": 0, "max": 600, "default": 56, "label": "边距"},
                    "position": {"type": "enum", "options": list(SUBTITLE_POSITIONS),
                                 "default": "bottom", "label": "位置"},
                },
            },
            "watermark": {
                "type": "object", "label": "水印",
                "fields": {
                    "enabled": {"type": "bool", "default": False, "label": "启用水印"},
                    "text": {"type": "str", "default": "", "label": "水印文字"},
                    "position": {"type": "enum", "options": list(WATERMARK_POSITIONS),
                                 "default": "bottom-right", "label": "位置"},
                    "opacity": {"type": "float", "min": 0.05, "max": 1.0, "default": 0.7,
                                "label": "不透明度"},
                    "scale": {"type": "float", "min": 0.01, "max": 0.2, "default": 0.035,
                              "label": "字号比例"},
                    "tile": {"type": "bool", "default": False, "label": "平铺"},
                    "color": {"type": "str", "default": "#FFFFFF", "label": "颜色"},
                },
            },
            "bgm": {
                "type": "object", "label": "背景音乐",
                "fields": {
                    "file": {"type": "str", "default": "", "label": "音频文件"},
                    "volumeDb": {"type": "int", "min": -40, "max": 0, "default": -18, "label": "音量"},
                    "loop": {"type": "bool", "default": True, "label": "循环铺满"},
                    "duck": {"type": "bool", "default": True, "label": "原声闪避"},
                },
            },
            "export": {
                "type": "object", "label": "导出",
                "fields": {
                    "crf": {"type": "int", "min": 12, "max": 32, "default": 18, "label": "画质"},
                    "preset": {"type": "enum", "options": list(EXPORT_PRESETS), "default": "medium",
                               "label": "编码预设"},
                    "format": {"type": "enum", "options": ["mp4"], "default": "mp4", "label": "格式"},
                },
            },
        },
    },
    "llm": {
        "type": "object", "label": "提示词模型",
        "fields": {
            "profileId": {"type": "str", "default": "", "label": "服务档案"},
            "model": {"type": "str", "default": "", "label": "模型"},
            "temperature": {"type": "float", "min": 0.0, "max": 1.5, "default": 0.7, "label": "温度"},
        },
    },
    "image": {
        "type": "object", "label": "生图",
        "fields": {
            "model": {"type": "str", "default": DEFAULT_IMAGE_MODEL, "label": "图像模型"},
            "steps": {"type": "int", "min": 1, "max": 60, "default": 8, "label": "步数"},
            "cfg": {"type": "float", "min": 0.0, "max": 12.0, "default": 1.0, "label": "CFG"},
            "turbo": {"type": "bool", "default": True, "label": "加速 LoRA"},
        },
    },
}

#: 单个镜头段的可编辑字段（PATCH /shots/{id} 用）
SHOT_FIELDS: dict[str, dict[str, Any]] = {
    "startMs": {"type": "int", "min": 0, "max": 24 * 3600 * 1000},
    "endMs": {"type": "int", "min": 0, "max": 24 * 3600 * 1000},
    "text": {"type": "text", "max_len": 2000},
    "description": {"type": "text", "max_len": 2000},
    "directive": {"type": "text", "max_len": 1000},
    "prompt": {"type": "text", "max_len": 4000},
    "negative": {"type": "text", "max_len": 2000},
    "textMode": {"type": "enum", "options": list(TEXT_MODES)},
    "image": {"type": "str", "max_len": 512},
    "seed": {"type": "int", "min": 0, "max": 2147483647},
    "status": {"type": "enum", "options": list(SHOT_STATUS)},
    "motion": {
        "type": "object",
        "fields": {
            "type": {"type": "enum", "options": list(MOTIONS)},
            "zoom": {"type": "float", "min": 1.0, "max": 1.3},
        },
    },
    "transition": {
        "type": "object",
        "fields": {
            "type": {"type": "enum", "options": list(TRANSITIONS)},
            "durationMs": {"type": "int", "min": 0, "max": 2000},
        },
    },
}


# --------------------------------------------------------------------------- 默认值


def _defaults_of(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, spec in fields.items():
        kind = spec.get("type")
        if kind == "object":
            out[key] = _defaults_of(spec.get("fields") or {})
        else:
            out[key] = copy.deepcopy(spec.get("default"))
    return out


DEFAULTS: dict[str, Any] = _defaults_of(SCHEMA)


def shot_defaults() -> dict[str, Any]:
    return {
        # 默认给一点慢推，静帧也有呼吸感；需要完全静止可切 none
        "motion": {"type": "push", "zoom": 1.06},
        "transition": {"type": "cut", "durationMs": 300},
    }


# --------------------------------------------------------------------------- 校验


def _coerce(spec: dict[str, Any], value: Any, path: str) -> Any:
    kind = spec.get("type")
    if kind in ("int", "float"):
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{path} 必须是数字") from exc
        low = spec.get("min")
        high = spec.get("max")
        if low is not None and number < low:
            number = float(low)
        if high is not None and number > high:
            number = float(high)
        return int(round(number)) if kind == "int" else round(number, 4)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        text = str(value).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off", ""):
            return False
        raise ValueError(f"{path} 必须是布尔值")
    if kind == "enum":
        text = str(value)
        options = spec.get("options") or []
        if text not in options:
            raise ValueError(f"{path} 只能是 {options} 之一")
        return text
    if kind in ("str", "text"):
        text = str(value if value is not None else "")
        limit = int(spec.get("max_len") or 20000)
        if len(text) > limit:
            raise ValueError(f"{path} 超过长度上限 {limit}")
        return text
    if kind == "entity_list":
        if not isinstance(value, list):
            raise ValueError(f"{path} 必须是数组")
        kinds = spec.get("kinds") or []
        out = []
        for index, item in enumerate(value[:60]):
            if not isinstance(item, dict):
                raise ValueError(f"{path}[{index}] 必须是对象")
            kind = str(item.get("kind") or "character")
            if kinds and kind not in kinds:
                raise ValueError(f"{path}[{index}].kind 只能是 {kinds} 之一")
            refs = item.get("refImages")
            if not isinstance(refs, list):
                refs = []
            out.append({
                "id": str(item.get("id") or f"e{index + 1}")[:32],
                "kind": kind,
                "name": str(item.get("name") or "")[:40],
                "desc": str(item.get("desc") or "")[:400],
                # 资产设定图：人物三视图 / 场景定场图，生图时做身份与场景锚定
                "refImages": [str(entry)[:512] for entry in refs[:4] if str(entry or "").strip()],
            })
        return out
    if kind == "object":
        if not isinstance(value, dict):
            raise ValueError(f"{path} 必须是对象")
        return validate_fields(spec.get("fields") or {}, value, prefix=path)
    raise ValueError(f"{path} 类型未注册：{kind}")


def validate_fields(fields: dict[str, Any], patch: dict[str, Any], *, prefix: str = "") -> dict[str, Any]:
    """按注册表校验并收敛一个 patch（只保留已注册字段）。"""
    if not isinstance(patch, dict):
        raise ValueError(f"{prefix or 'payload'} 必须是对象")
    out: dict[str, Any] = {}
    for key, value in patch.items():
        spec = fields.get(key)
        path = f"{prefix}.{key}" if prefix else key
        if spec is None:
            raise ValueError(f"未知字段：{path}")
        out[key] = _coerce(spec, value, path)
    return out


def validate_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """校验项目级 patch（canvas / locks / render / llm / image）。"""
    return validate_fields(SCHEMA, patch)


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def _fill_defaults(node: dict[str, Any], fields: dict[str, Any],
                   defaults: dict[str, Any]) -> None:
    for key, spec in fields.items():
        if spec.get("type") == "object":
            child = node.get(key)
            if not isinstance(child, dict):
                node[key] = copy.deepcopy(defaults.get(key) or {})
                continue
            _fill_defaults(child, spec.get("fields") or {}, defaults.get(key) or {})
        elif key not in node or node[key] is None:
            node[key] = copy.deepcopy(defaults.get(key))


def apply_defaults(project: dict[str, Any]) -> dict[str, Any]:
    """给老项目补齐新字段（只补缺，不覆盖用户值），并迁移历史画布字段。"""
    # 先迁移：老文档只有 width/height，没有 longSide
    canvas = project.get("canvas")
    if isinstance(canvas, dict) and not int(canvas.get("longSide") or 0):
        canvas["longSide"] = int(canvas.get("width") or 1920) or 1920

    for name, section in SCHEMA.items():
        node = project.get(name)
        if not isinstance(node, dict):
            project[name] = copy.deepcopy(DEFAULTS[name])
            continue
        _fill_defaults(node, section.get("fields") or {}, DEFAULTS[name])

    canvas = project["canvas"]
    canvas.pop("width", None)
    canvas.pop("height", None)

    # 老资产卡没有参考图字段：补空数组，避免前端读到 undefined
    content = ((project.get("locks") or {}).get("content") or {})
    for entity in content.get("entities") or []:
        if isinstance(entity, dict) and not isinstance(entity.get("refImages"), list):
            entity["refImages"] = []

    for shot in project.get("shots") or []:
        shot.setdefault("description", "")
        shot.setdefault("warnings", [])
        shot.setdefault("attempts", 0)
        shot.setdefault("imageHistory", [])
        shot.setdefault("promptHistory", [])
        # 旧项目：现有图片补一条 v1 记录，不移动文件
        if shot.get("image") and not shot["imageHistory"]:
            shot["imageHistory"] = [{
                "file": shot["image"],
                "seed": int(shot.get("seed") or 0),
                "at": project.get("updatedAt") or "",
                "jobId": "",
                "width": int(shot.get("width") or 0),
                "height": int(shot.get("height") or 0),
                "source": "legacy",
            }]
        for key, value in shot_defaults().items():
            if not isinstance(shot.get(key), dict):
                shot[key] = copy.deepcopy(value)
        shot.setdefault("textMode", "auto")
        shot.setdefault("beat", None)
        shot.setdefault("directive", "")
        if not isinstance(shot.get("review"), dict):
            shot.pop("review", None)
        motion = shot.get("motion") or {}
        if str(motion.get("type") or "") == "kenburns":
            motion["type"] = "push"
        # 旧字段（自由 pan 已由镜头语言预设取代）
        motion.pop("panX", None)
        motion.pop("panY", None)
        if float(motion.get("zoom") or 0) <= 1.0:
            motion["zoom"] = 1.06
        shot["motion"] = motion
    return project


# --------------------------------------------------------------------------- 项目文档


def new_project_id() -> str:
    return f"vid-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


def now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def default_project(name: str = "") -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": new_project_id(),
        "name": (name or "未命名项目").strip()[:60],
        "createdAt": now_text(),
        "updatedAt": now_text(),
        "canvas": copy.deepcopy(DEFAULTS["canvas"]),
        "audio": {"file": "", "durationMs": 0, "peaksFile": "", "offsetMs": 0},
        "subtitle": {"file": "", "format": "", "cues": []},
        "locks": copy.deepcopy(DEFAULTS["locks"]),
        "render": copy.deepcopy(DEFAULTS["render"]),
        "llm": copy.deepcopy(DEFAULTS["llm"]),
        "image": copy.deepcopy(DEFAULTS["image"]),
        "segments": {"mergeGapMs": 350, "maxShotMs": 8000, "applied": False},
        "shots": [],
        "prompts": {"at": "", "source": "", "model": "", "error": ""},
        "outputs": [],
    }


def new_shot(index: int, start_ms: int, end_ms: int, text: str) -> dict[str, Any]:
    return {
        "id": f"s{index + 1}",
        "index": index,
        "startMs": int(start_ms),
        "endMs": int(end_ms),
        "text": text,
        "description": "",
        "directive": "",
        "prompt": "",
        "negative": "",
        "usedEntities": [],
        "warnings": [],
        "note": "",
        "image": "",
        "imageHistory": [],
        "promptHistory": [],
        "seed": 0,
        "width": 0,
        "height": 0,
        "textMode": "auto",
        "beat": None,
        "status": "pending",
        "attempts": 0,
        **copy.deepcopy(shot_defaults()),
    }


# --------------------------------------------------------------------------- 前端投影


def _public_fields(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, spec in fields.items():
        entry = {k: v for k, v in spec.items() if k in (
            "type", "options", "min", "max", "default", "label", "kinds", "max_len")}
        if spec.get("type") == "object":
            entry["fields"] = _public_fields(spec.get("fields") or {})
        out[key] = entry
    return out


def public_schema() -> dict[str, Any]:
    return {
        "version": SCHEMA_VERSION,
        "sections": {name: {"label": sec.get("label", name), "fields": _public_fields(sec["fields"])}
                     for name, sec in SCHEMA.items()},
        "shotFields": _public_fields(SHOT_FIELDS),
        "ratios": RATIOS,
        "transitions": list(TRANSITIONS),
        "motions": list(MOTIONS),
        "shotStatus": list(SHOT_STATUS),
        "watermarkPositions": list(WATERMARK_POSITIONS),
        "subtitlePositions": list(SUBTITLE_POSITIONS),
        "defaults": copy.deepcopy(DEFAULTS),
    }
