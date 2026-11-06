"""MOSS-Image 的节点逻辑移植（纯 Python，不 import torch / 不依赖 ComfyUI 节点）。

对应原节点（`ComfyUI/comfy_extras/`），逐行复刻数值行为：

* `nodes_resolution.py::ResolutionSelector`   → `resolution_size()`（比例 + 百万像素 → 宽高）
* `nodes_bounding_boxes.py::CreateBoundingBoxes`（纯计算部分）
    → `boxes_from_input()` / `boxes_to_regions()` / `build_elements()`
* `nodes_moss_image.py::MOSSImageLayoutPrompt` → `layout_prompt()`

为什么要移植而不是调用原节点：本项目运行期只 import vendored 的 `engine/comfy`
模型库，**不启动 ComfyUI**，而 `comfy_extras` 依赖 `nodes`、`comfy_api` 等
宿主侧模块。这里的实现只保留数值换算，输入输出与节点一致。

坐标约定（节点原文，不要改）
--------------------------
* `CreateBoundingBoxes` 画布坐标是像素 `(x, y, width, height)`；
* 转成 `regions` 时归一化到 0..1，再 `round(v * 1000)` 量化成 0..1000 的
  `[ymin, xmin, ymax, xmax]`；
* `MOSSImageLayoutPrompt` 把 0..1000 的框按**目标图尺寸**换成像素边界
  （`floor/ceil`），再减去画布中心 → `abs_centralized` + `yxyx`；
* 最终 prompt 是紧凑 JSON（`separators=(",", ":")`），无空格。
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

#: `ResolutionSelector` 的比例表（键同时接受 "16:9" 与 "16:9 (Widescreen)"）
ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}


# --------------------------------------------------------------------------- 分辨率


def parse_ratio(aspect_ratio: Any) -> tuple[int, int]:
    """把 ``"16:9"`` / ``"16:9 (Widescreen)"`` 解析成 ``(16, 9)``。"""
    if isinstance(aspect_ratio, (list, tuple)) and len(aspect_ratio) == 2:
        try:
            return int(aspect_ratio[0]), int(aspect_ratio[1])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"比例非法: {aspect_ratio!r}") from exc
    text = str(aspect_ratio or "").strip()
    match = re.match(r"^(\d+)\s*:\s*(\d+)", text)
    if not match:
        raise ValueError(f"无法识别的比例: {aspect_ratio!r}（示例：'16:9'）")
    w, h = int(match.group(1)), int(match.group(2))
    if w <= 0 or h <= 0:
        raise ValueError(f"比例必须为正: {aspect_ratio!r}")
    return w, h


def resolution_size(aspect_ratio: Any, megapixels: float = 1.0,
                    multiple: int = 8) -> tuple[int, int]:
    """复刻 `ResolutionSelector.execute`：按目标总像素算宽高并吸附到 multiple。"""
    w_ratio, h_ratio = parse_ratio(aspect_ratio)
    total_pixels = float(megapixels) * 1024.0 * 1024.0
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    step = max(1, int(multiple))
    width = max(step, round(w_ratio * scale / step) * step)
    height = max(step, round(h_ratio * scale / step) * step)
    return int(width), int(height)


# --------------------------------------------------------------------------- 边界框


def pixels_to_fractions(box: dict, width: int, height: int) -> dict:
    """复刻 `CreateBoundingBoxes.pixels_to_fractions`。"""
    w = width or 1
    h = height or 1
    return {
        "x": box.get("x", 0) / w,
        "y": box.get("y", 0) / h,
        "w": box.get("width", 0) / w,
        "h": box.get("height", 0) / h,
    }


def normalize_incoming_boxes(bboxes: Any) -> list:
    """复刻 `CreateBoundingBoxes.normalize_incoming_boxes`。"""
    if isinstance(bboxes, dict):
        frame = [bboxes]
    elif not isinstance(bboxes, list) or not bboxes:
        frame = []
    elif isinstance(bboxes[0], dict):
        frame = bboxes
    else:
        frame = bboxes[0] if isinstance(bboxes[0], list) else []
    boxes = []
    for box in frame:
        if not isinstance(box, dict):
            continue
        norm = {
            "x": box.get("x", 0),
            "y": box.get("y", 0),
            "width": box.get("width", 0),
            "height": box.get("height", 0),
        }
        meta = box.get("metadata")
        if not isinstance(meta, dict):
            # 前端新接口允许把 type/text/desc/palette 直接写在框上（不必再包一层 metadata）
            meta = {}
            for src, dst in (("type", "type"), ("text", "text"), ("desc", "desc"),
                             ("palette", "palette"), ("color_palette", "palette")):
                if box.get(src) is not None:
                    meta[dst] = box[src]
        if meta:
            norm["metadata"] = meta
        boxes.append(norm)
    return boxes


def _looks_like_element(box: dict) -> bool:
    bbox = box.get("bbox")
    return isinstance(bbox, (list, tuple)) and len(bbox) == 4


def _looks_like_bbox(box: dict) -> bool:
    return all(key in box for key in ("x", "y", "width", "height"))


def elements_to_boxes(elements: list, width: int, height: int) -> list:
    """复刻 `CreateBoundingBoxes.elements_to_boxes`（0..1000 yxyx → 像素框）。"""
    boxes = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        bbox = element.get("bbox")
        if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
            raise ValueError("bboxes element 缺少合法的 'bbox' [ymin, xmin, ymax, xmax]")
        try:
            ymin, xmin, ymax, xmax = (float(v) / 1000.0 for v in bbox)
        except (TypeError, ValueError) as exc:
            raise ValueError("bboxes element 的 'bbox' 必须含四个数字") from exc
        etype = "text" if element.get("type") == "text" else "obj"
        boxes.append({
            "x": round(min(xmin, xmax) * width),
            "y": round(min(ymin, ymax) * height),
            "width": round(abs(xmax - xmin) * width),
            "height": round(abs(ymax - ymin) * height),
            "metadata": {
                "type": etype,
                "text": element.get("text", "") if etype == "text" else "",
                "desc": element.get("desc", ""),
                "palette": element.get("color_palette", []) or element.get("palette", []) or [],
            },
        })
    return boxes


def boxes_from_input(data: Any, width: int, height: int) -> list:
    """复刻 `CreateBoundingBoxes.boxes_from_input`（dict / list / JSON 字符串）。"""
    if data is None:
        return []
    if isinstance(data, str):
        text = data.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"bboxes 字符串不是合法 JSON: {exc}") from exc
    if isinstance(data, dict):
        if _looks_like_element(data):
            return elements_to_boxes([data], width, height)
        if _looks_like_bbox(data):
            return normalize_incoming_boxes(data)
        raise ValueError("bboxes 字典必须是像素框 (x, y, width, height) 或带 'bbox' 的 element")
    if not isinstance(data, list):
        raise ValueError(f"bboxes 必须是框列表、element 列表或 JSON 字符串，收到 {type(data).__name__}")
    if not data:
        return []
    first = data[0]
    if isinstance(first, list):
        return normalize_incoming_boxes(data)
    if isinstance(first, dict):
        if _looks_like_element(first):
            return elements_to_boxes(data, width, height)
        if _looks_like_bbox(first):
            return normalize_incoming_boxes(data)
        raise ValueError("bboxes 列表项必须是像素框或带 'bbox' 的 element")
    raise ValueError(f"bboxes 列表项类型不支持: {type(first).__name__}")


def boxes_to_regions(boxes: Any, width: int, height: int) -> list:
    """复刻 `CreateBoundingBoxes.boxes_to_regions`。"""
    regions: list = []
    if not isinstance(boxes, list):
        return regions
    for box in boxes:
        if not isinstance(box, dict):
            continue
        meta = box.get("metadata")
        meta = meta if isinstance(meta, dict) else {}
        regions.append({
            **pixels_to_fractions(box, width, height),
            "type": meta.get("type", "obj"),
            "text": meta.get("text", ""),
            "desc": meta.get("desc", ""),
            "palette": meta.get("palette", []),
        })
    return regions


def _norm_bbox(region: dict) -> list[int]:
    """复刻 `CreateBoundingBoxes._norm_bbox`：0..1 → 0..1000 的 yxyx。"""
    def grid(value: float) -> int:
        return max(0, min(1000, round(value * 1000)))

    x, y = region.get("x", 0.0), region.get("y", 0.0)
    w, h = region.get("w", 0.0), region.get("h", 0.0)
    ymin, xmin, ymax, xmax = grid(y), grid(x), grid(y + h), grid(x + w)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def _normalize_palette(colors: Any) -> list[str]:
    if isinstance(colors, dict):
        colors = colors.values()
    return [c.upper() for c in (colors or []) if isinstance(c, str) and c]


def build_elements(regions: list) -> list:
    """复刻 `CreateBoundingBoxes.build_elements`（输出 MOSS 需要的 element）。"""
    elements = []
    for region in regions:
        if not isinstance(region, dict):
            continue
        etype = "text" if region.get("type") == "text" else "obj"
        element = {"type": etype}
        element["bbox"] = _norm_bbox(region)
        if etype == "text":
            element["text"] = region.get("text", "")
        element["desc"] = region.get("desc", "")
        palette = _normalize_palette(region.get("palette", []))
        if palette:
            element["color_palette"] = palette[:5]
        elements.append(element)
    return elements


# --------------------------------------------------------------------------- 布局提示词


def layout_prompt(prompt: str, elements: list, width: int, height: int,
                  character_boxes: Any = "") -> str:
    """复刻 `MOSSImageLayoutPrompt.execute`。

    没有可用 element 时**原样返回 prompt**（节点行为），否则返回紧凑 JSON：
    `{"summary":{"caption":...},"items":[...],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}`。
    """
    characters = {int(i) for i in re.findall(r"\d+", str(character_boxes or ""))}
    items = []
    for i, el in enumerate(elements if isinstance(elements, list) else []):
        if not isinstance(el, dict):
            continue
        label = "text" if el.get("type") == "text" else ("character" if i + 1 in characters else "object")
        item: dict[str, Any] = {"label": label, "caption": el.get("desc", "")}
        if item["label"] == "text":
            item["text"] = el.get("text", "")
        if el.get("color_palette"):
            item["palette"] = el["color_palette"]
        # 0-1000 [y0, x0, y1, x1] → 以画布中心为原点的像素边界
        y0, x0, y1, x1 = el["bbox"]
        item["bbox"] = [
            math.floor(round(y0 * height / 1000, 9)) - height // 2,
            math.floor(round(x0 * width / 1000, 9)) - width // 2,
            math.ceil(round(y1 * height / 1000, 9)) - height // 2,
            math.ceil(round(x1 * width / 1000, 9)) - width // 2,
        ]
        items.append(item)
    if not items:
        return prompt
    layout = {"summary": {"caption": prompt.strip()}, "items": items,
              "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":"))


def _extract_items(payload: Any) -> Any:
    """从请求的 bbox 载荷里取框列表（兼容 items / boxes / elements 三种命名）。"""
    if payload is None:
        return None
    if isinstance(payload, dict):
        for key in ("items", "boxes", "elements", "bboxes"):
            if payload.get(key) is not None:
                return payload[key]
        if _looks_like_bbox(payload) or _looks_like_element(payload):
            return payload
        return []
    return payload


def build_layout_prompt(prompt: str, payload: Any, width: int, height: int
                        ) -> tuple[str, dict[str, Any]]:
    """请求级入口：把 ``bbox`` 字段转成 MOSS 布局提示词。

    ``payload`` 结构（都可省略）：::

        {"enabled": true, "canvas": [1264, 1680], "character_boxes": "1",
         "items": [{"x": 0, "y": 0, "width": 100, "height": 100,
                    "type": "text", "text": "清凉一夏", "desc": "...", "palette": []}]}

    * ``canvas`` 或 ``width``/``height``：画框时的像素画布（默认等于目标尺寸）；
    * ``items`` 也可以直接给 0..1000 的 element（带 ``bbox`` 键）；
    * 返回 ``(最终提示词, 信息)``，信息会写进任务 meta 便于排查。
    """
    if not isinstance(payload, dict):
        payload = {"items": payload}
    if payload.get("enabled") is False:
        return prompt, {"enabled": False, "reason": "显式关闭"}

    canvas = payload.get("canvas")
    if isinstance(canvas, (list, tuple)) and len(canvas) == 2:
        canvas_w, canvas_h = int(canvas[0]), int(canvas[1])
    else:
        canvas_w = int(payload.get("width") or payload.get("canvas_width") or width)
        canvas_h = int(payload.get("height") or payload.get("canvas_height") or height)
    canvas_w = max(1, canvas_w)
    canvas_h = max(1, canvas_h)

    raw_items = _extract_items(payload)
    boxes = boxes_from_input(raw_items, canvas_w, canvas_h)
    regions = boxes_to_regions(boxes, canvas_w, canvas_h)
    elements = build_elements(regions)
    text = layout_prompt(prompt, elements, int(width), int(height),
                         payload.get("character_boxes", ""))
    return text, {
        "enabled": bool(elements),
        "items": len(elements),
        "canvas": [canvas_w, canvas_h],
        "target": [int(width), int(height)],
        "prompt_chars": len(text),
    }


# --------------------------------------------------------------------------- SLG 参数


def slg_config(defaults: dict | None, requested: Any) -> dict | None:
    """解析 SLG 开关；``requested`` 为 None 时用模型默认（MOSS 默认关）。"""
    if not defaults:
        return None
    if requested is None or requested is False:
        return None
    merged = dict(defaults)
    if isinstance(requested, dict):
        merged.update({k: v for k, v in requested.items() if v is not None})
    if not bool(merged.get("enabled", True)):
        return None
    return merged


__all__ = [
    "ASPECT_RATIOS",
    "parse_ratio",
    "resolution_size",
    "pixels_to_fractions",
    "normalize_incoming_boxes",
    "elements_to_boxes",
    "boxes_from_input",
    "boxes_to_regions",
    "build_elements",
    "layout_prompt",
    "build_layout_prompt",
    "slg_config",
]
