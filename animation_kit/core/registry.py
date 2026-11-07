"""字段与导出能力的**单一注册表**。

主项目的硬约束是「字段与数据结构必须通过单一注册表统一维护，禁止多处重复定义」。
这里把所有可持久化字段、范围、默认值、枚举，以及导入/导出选项集中在一处：

* 服务端 ``normalize_doc`` 用它做清洗与校验；
* ``/api/options`` 直接把它序列化给前端渲染表单；
* 测试用同一份定义断言边界，避免前后端各写一套。

新增字段只改这个文件。
"""
from __future__ import annotations

import copy
import re
from typing import Any, Iterable

DOC_VERSION = 1


class DocError(ValueError):
    """文档字段非法（HTTP 层转 400）。"""


# --------------------------------------------------------------------------- 字段定义


FRAME_FIELDS: dict[str, dict[str, Any]] = {
    "id": {"type": "str", "default": "", "label": "编号", "group": "identity", "max": 64},
    "name": {"type": "str", "default": "帧", "label": "名称", "group": "identity", "max": 80},
    "url": {"type": "str", "default": "", "label": "图片地址", "group": "identity", "max": 512},
    "sourceUrl": {"type": "str", "default": "", "label": "原图地址", "group": "identity", "max": 512},
    "width": {"type": "int", "default": 1, "label": "宽", "group": "identity", "min": 1, "max": 8192},
    "height": {"type": "int", "default": 1, "label": "高", "group": "identity", "min": 1, "max": 8192},
    "offsetX": {"type": "int", "default": 0, "label": "X 位移", "group": "transform", "min": -8192, "max": 8192},
    "offsetY": {"type": "int", "default": 0, "label": "Y 位移", "group": "transform", "min": -8192, "max": 8192},
    "scale": {"type": "float", "default": 1.0, "label": "缩放", "group": "transform", "min": 0.05, "max": 8.0},
    "rotation": {"type": "float", "default": 0.0, "label": "旋转", "group": "transform", "min": -360.0, "max": 360.0},
    "opacity": {"type": "float", "default": 1.0, "label": "不透明度", "group": "transform", "min": 0.0, "max": 1.0},
    "hold": {"type": "int", "default": 1, "label": "停顿", "group": "timing", "min": 1, "max": 240},
    "duration": {"type": "int", "default": 0, "label": "帧时长", "group": "timing", "min": 0, "max": 60000},
    "visible": {"type": "bool", "default": True, "label": "显示", "group": "state"},
    "locked": {"type": "bool", "default": False, "label": "锁定", "group": "state"},
    "origin": {
        "type": "enum", "default": "upload", "label": "来源", "group": "identity",
        "values": ["sheet", "upload", "derived"],
    },
    "note": {"type": "str", "default": "", "label": "备注", "group": "identity", "max": 200},
}

CANVAS_FIELDS: dict[str, dict[str, Any]] = {
    "width": {"type": "int", "default": 1024, "label": "画布宽", "min": 1, "max": 8192},
    "height": {"type": "int", "default": 1024, "label": "画布高", "min": 1, "max": 8192},
    "background": {"type": "str", "default": "", "label": "背景色", "max": 32},
    "fit": {
        "type": "enum", "default": "contain", "label": "适配",
        "values": ["contain", "cover", "stretch", "none"],
    },
    "anchor": {
        "type": "enum", "default": "center", "label": "锚点",
        "values": ["center", "top", "bottom"],
    },
}

TIMELINE_FIELDS: dict[str, dict[str, Any]] = {
    "fps": {"type": "int", "default": 12, "label": "帧率", "min": 1, "max": 60},
    "loop": {"type": "int", "default": 0, "label": "循环次数", "min": 0, "max": 999},
    "direction": {
        "type": "enum", "default": "forward", "label": "播放方向",
        "values": ["forward", "pingpong"],
    },
    "defaultHold": {"type": "int", "default": 1, "label": "默认停顿", "min": 1, "max": 240},
}

PROCESSING_FIELDS: dict[str, dict[str, Any]] = {
    "align": {
        "type": "object",
        "label": "自动稳定",
        "fields": {
            "reference": {
                "type": "enum", "default": "first", "label": "参考帧",
                "values": ["first", "previous", "median"],
            },
            "maxShift": {"type": "int", "default": 64, "label": "最大位移", "min": 0, "max": 512},
            "confidence": {"type": "float", "default": 0.08, "label": "置信度", "min": 0.0, "max": 1.0},
        },
    },
    "color": {
        "type": "object",
        "label": "色彩一致",
        "fields": {
            "reference": {
                "type": "enum", "default": "median", "label": "参考",
                "values": ["median", "first"],
            },
            "strength": {"type": "float", "default": 0.8, "label": "强度", "min": 0.0, "max": 1.0},
            "scope": {
                "type": "enum", "default": "subject", "label": "作用范围",
                "values": ["subject", "full"],
            },
        },
    },
}

SOURCE_FIELDS: dict[str, dict[str, Any]] = {
    "type": {"type": "enum", "default": "images", "label": "来源", "values": ["sheet", "images"]},
    "importedAt": {"type": "str", "default": "", "label": "导入时间", "max": 40},
    "sheet": {
        "type": "object",
        "label": "宫格参数",
        "fields": {
            "rows": {"type": "int", "default": 4, "label": "行", "min": 1, "max": 16},
            "columns": {"type": "int", "default": 4, "label": "列", "min": 1, "max": 16},
            "rowGap": {"type": "int", "default": 0, "label": "行间隔", "min": 0, "max": 256},
            "columnGap": {"type": "int", "default": 0, "label": "列间隔", "min": 0, "max": 256},
            "order": {
                "type": "enum", "default": "row-major", "label": "顺序",
                "values": ["row-major", "serpentine", "column-major"],
            },
            "trim": {
                "type": "enum", "default": "union", "label": "裁边",
                "values": ["none", "union", "each"],
            },
            "padding": {"type": "int", "default": 0, "label": "留白", "min": 0, "max": 256},
        },
    },
}

IMPORT_FIELDS: dict[str, dict[str, Any]] = {
    "fit": {"type": "enum", "default": "pad", "label": "统一尺寸", "values": ["pad", "stretch"]},
    "anchor": {"type": "enum", "default": "center", "label": "锚点", "values": ["center", "top", "bottom"]},
    "replace": {"type": "bool", "default": False, "label": "替换现有帧"},
}

EXPORT_FORMATS: dict[str, dict[str, Any]] = {
    "gif": {
        "label": "GIF 动图",
        "ext": "gif",
        "hint": "兼容性最好；256 色调色板，透明只有 1 位，适合预览与分享。",
        "options": {
            "colors": {"type": "int", "default": 256, "label": "颜色数", "min": 2, "max": 256},
            "dither": {"type": "bool", "default": True, "label": "抖动"},
            "transparent": {"type": "bool", "default": True, "label": "透明背景"},
            "background": {"type": "str", "default": "#ffffff", "label": "背景色", "max": 32},
            "loop": {"type": "int", "default": 0, "label": "循环", "min": 0, "max": 999},
            "minMs": {"type": "int", "default": 20, "label": "最短帧", "min": 10, "max": 200},
            "optimize": {"type": "bool", "default": False, "label": "体积优化"},
        },
    },
    "apng": {
        "label": "APNG 无损",
        "ext": "png",
        "hint": "保留完整 alpha 与逐像素精度，体积较大；适合交付和二次编辑。",
        "options": {
            "loop": {"type": "int", "default": 0, "label": "循环", "min": 0, "max": 999},
        },
    },
    "webp": {
        "label": "WebP 动图",
        "ext": "webp",
        "hint": "体积小、支持 alpha；无损模式可做到逐像素一致。",
        "options": {
            "quality": {"type": "int", "default": 92, "label": "质量", "min": 1, "max": 100},
            "lossless": {"type": "bool", "default": True, "label": "无损"},
            "loop": {"type": "int", "default": 0, "label": "循环", "min": 0, "max": 999},
            "method": {"type": "int", "default": 4, "label": "压缩级别", "min": 0, "max": 6},
        },
    },
    "png-sequence": {
        "label": "PNG 序列",
        "ext": "zip",
        "hint": "逐帧无损 PNG + manifest.json 打包，方便进剪辑软件。",
        "options": {},
    },
    "sprite-sheet": {
        "label": "精灵表",
        "ext": "png",
        "hint": "把当前帧重新拼成透明宫格（默认 4×4），可附带 atlas JSON。",
        "options": {
            "columns": {"type": "int", "default": 4, "label": "列数", "min": 1, "max": 16},
            "padding": {"type": "int", "default": 0, "label": "间隔", "min": 0, "max": 256},
            "atlas": {"type": "bool", "default": True, "label": "输出 atlas"},
        },
    },
}


# --------------------------------------------------------------------------- 清洗


def _coerce(spec: dict[str, Any], value: Any) -> Any:
    kind = spec["type"]
    if kind == "bool":
        if isinstance(value, str):
            return value.strip().lower() not in ("", "0", "false", "no", "off")
        return bool(value)
    if kind == "int":
        try:
            out = int(round(float(value)))
        except (TypeError, ValueError) as exc:
            raise DocError(f"{spec.get('label') or '字段'} 必须是整数，收到 {value!r}") from exc
        return max(int(spec.get("min", out)), min(int(spec.get("max", out)), out))
    if kind == "float":
        try:
            out = float(value)
        except (TypeError, ValueError) as exc:
            raise DocError(f"{spec.get('label') or '字段'} 必须是数字，收到 {value!r}") from exc
        return max(float(spec.get("min", out)), min(float(spec.get("max", out)), out))
    if kind == "enum":
        text = str(value or "").strip()
        values = spec.get("values") or []
        return text if text in values else spec["default"]
    text = str(value if value is not None else "")
    limit = int(spec.get("max") or 0)
    return text[:limit] if limit > 0 else text


def _normalize_object(raw: Any, fields: dict[str, dict[str, Any]]) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    out: dict[str, Any] = {}
    for name, spec in fields.items():
        if spec["type"] == "object":
            out[name] = _normalize_object(raw.get(name), spec["fields"])
        else:
            out[name] = _coerce(spec, raw.get(name, spec["default"]))
    return out


def normalize_frame(raw: Any, index: int = 0) -> dict[str, Any]:
    frame = _normalize_object(raw, FRAME_FIELDS)
    if not frame["id"]:
        frame["id"] = f"f{index + 1:03d}"
    if not frame["name"]:
        frame["name"] = f"帧 {index + 1:02d}"
    return frame


def normalize_doc(raw: Any, *, doc_id: str = "") -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    frames_raw = raw.get("frames")
    frames: list[dict[str, Any]] = []
    if isinstance(frames_raw, list):
        for index, item in enumerate(frames_raw[:512]):
            if not isinstance(item, dict):
                continue
            frames.append(normalize_frame(item, index))
    doc = {
        "version": DOC_VERSION,
        "id": str(raw.get("id") or doc_id or ""),
        "name": str(raw.get("name") or "未命名动画")[:80],
        "createdAt": str(raw.get("createdAt") or ""),
        "updatedAt": str(raw.get("updatedAt") or ""),
        "canvas": _normalize_object(raw.get("canvas"), CANVAS_FIELDS),
        "timeline": _normalize_object(raw.get("timeline"), TIMELINE_FIELDS),
        "processing": _normalize_object(raw.get("processing"), PROCESSING_FIELDS),
        "source": _normalize_object(raw.get("source"), SOURCE_FIELDS),
        "frames": frames,
    }
    if frames:
        # 没有显式画布时跟随第一帧，避免导入后空白
        if not raw.get("canvas"):
            doc["canvas"]["width"] = frames[0]["width"]
            doc["canvas"]["height"] = frames[0]["height"]
    return doc


def validate_doc(doc: dict[str, Any], *, require_frames: bool = True) -> None:
    if not isinstance(doc, dict):
        raise DocError("文档格式不正确")
    if require_frames and not doc.get("frames"):
        raise DocError("时间轴为空：请先导入帧")
    for frame in doc.get("frames") or []:
        if not frame.get("url"):
            raise DocError(f"帧「{frame.get('name')}」缺少图片地址")
        if int(frame.get("width") or 0) < 1 or int(frame.get("height") or 0) < 1:
            raise DocError(f"帧「{frame.get('name')}」尺寸非法")
    canvas = doc.get("canvas") or {}
    if int(canvas.get("width") or 0) < 1 or int(canvas.get("height") or 0) < 1:
        raise DocError("画布尺寸非法")


def normalize_export(fmt: str, options: Any) -> dict[str, Any]:
    spec = EXPORT_FORMATS.get(str(fmt or "").strip())
    if spec is None:
        raise DocError(f"不支持的导出格式：{fmt}（可选 {sorted(EXPORT_FORMATS)}）")
    return _normalize_object(options, spec["options"])


def normalize_import(raw: Any) -> dict[str, Any]:
    return _normalize_object(raw, IMPORT_FIELDS)


_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def parse_color(text: str, *, default: tuple[int, int, int, int] = (255, 255, 255, 0)) -> tuple[int, int, int, int]:
    """``#rrggbb`` → RGBA；空串表示透明。"""
    match = _HEX.match(str(text or "").strip())
    if not match:
        return default
    value = match.group(1)
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), 255)


# --------------------------------------------------------------------------- 给前端


def _public_fields(fields: dict[str, dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, spec in fields.items():
        if spec["type"] == "object":
            out[name] = {"type": "object", "label": spec.get("label"), "fields": _public_fields(spec["fields"])}
        else:
            out[name] = {k: v for k, v in spec.items() if k != "type"} | {"type": spec["type"]}
    return out


def public_options() -> dict[str, Any]:
    return {
        "doc_version": DOC_VERSION,
        "fields": {
            "frame": _public_fields(FRAME_FIELDS),
            "canvas": _public_fields(CANVAS_FIELDS),
            "timeline": _public_fields(TIMELINE_FIELDS),
            "processing": _public_fields(PROCESSING_FIELDS),
            "source": _public_fields(SOURCE_FIELDS),
            "import": _public_fields(IMPORT_FIELDS),
        },
        "export_formats": copy.deepcopy(EXPORT_FORMATS),
        "defaults": {
            "canvas": {k: v["default"] for k, v in CANVAS_FIELDS.items()},
            "timeline": {k: v["default"] for k, v in TIMELINE_FIELDS.items()},
            "processing": {
                k: ({f: s["default"] for f, s in v["fields"].items()} if v["type"] == "object" else v["default"])
                for k, v in PROCESSING_FIELDS.items()
            },
        },
        "capabilities": {
            "sheet_orders": SOURCE_FIELDS["sheet"]["fields"]["order"]["values"],
            "sheet_trims": SOURCE_FIELDS["sheet"]["fields"]["trim"]["values"],
            "formats": list(EXPORT_FORMATS),
            "max_frames": 512,
            "zero_shift": True,
        },
    }


def ensure_unique_frame_ids(frames: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """导入/合并时保证 id 唯一，冲突就补后缀。"""
    seen: dict[str, int] = {}
    out: list[dict[str, Any]] = []
    for frame in frames:
        item = dict(frame)
        base = str(item.get("id") or "f")
        count = seen.get(base, 0)
        seen[base] = count + 1
        if count:
            item["id"] = f"{base}-{count + 1}"
        out.append(item)
    return out
