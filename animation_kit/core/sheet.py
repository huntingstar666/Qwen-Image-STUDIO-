"""宫格切分：4×4 透明通道总表 → 逐帧（默认保留相对位移）。

关键规则（和主项目 ``server/imageops.py::op_grid`` 同一套取整方式）：

1. 单元格边界用 ``round(索引 × (边长 + 间隔))`` 推导，**只做整数裁剪**；
2. 默认 ``trim=union``：取所有单元格内容的并集包围盒，
   每帧裁同一个相对矩形，因此角色在格子里的位移被完整保留；
3. ``trim=each`` 只适合“每格都居中”的角色表，它会消除格内位移；
4. 统一尺寸只用透明补边（整数偏移），默认绝不缩放。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from PIL import Image

from . import images as image_utils


@dataclass
class SheetSplit:
    frames: list[Image.Image]
    rects: list[tuple[int, int, int, int]]
    cell_rects: list[tuple[int, int, int, int]]
    order: list[int]
    bbox: tuple[int, int, int, int]
    size: tuple[int, int]
    warnings: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)


def _cell_rects(width: int, height: int, rows: int, columns: int,
                row_gap: int, column_gap: int) -> list[tuple[int, int, int, int]]:
    if rows < 1 or columns < 1:
        raise ValueError("行数和列数必须大于 0")
    if rows * columns > 256:
        raise ValueError("宫格数量过多（最多 256 块）")
    cell_w = (width - column_gap * (columns - 1)) / columns
    cell_h = (height - row_gap * (rows - 1)) / rows
    if cell_w < 1 or cell_h < 1:
        raise ValueError("间隔过大，切分后每格不足 1 像素")
    rects: list[tuple[int, int, int, int]] = []
    for row in range(rows):
        for column in range(columns):
            left = int(round(column * (cell_w + column_gap)))
            top = int(round(row * (cell_h + row_gap)))
            right = int(round(left + cell_w))
            bottom = int(round(top + cell_h))
            rects.append((left, top, max(left + 1, right), max(top + 1, bottom)))
    return rects


def _order_indices(rows: int, columns: int, order: str) -> list[int]:
    """返回「播放顺序 → 单元格序号（行优先编号）」的映射。"""
    if order == "serpentine":
        out: list[int] = []
        for row in range(rows):
            columns_range = range(columns) if row % 2 == 0 else range(columns - 1, -1, -1)
            out.extend(row * columns + column for column in columns_range)
        return out
    if order == "column-major":
        return [row * columns + column for column in range(columns) for row in range(rows)]
    return list(range(rows * columns))


def split_sheet(
    image: Image.Image,
    *,
    rows: int = 4,
    columns: int = 4,
    row_gap: int = 0,
    column_gap: int = 0,
    order: str = "row-major",
    trim: str = "union",
    padding: int = 0,
    fit: str = "pad",
    anchor: str = "center",
    target_size: tuple[int, int] | None = None,
) -> SheetSplit:
    source = image_utils.ensure_rgba(image)
    rows = max(1, int(rows))
    columns = max(1, int(columns))
    row_gap = max(0, int(row_gap))
    column_gap = max(0, int(column_gap))
    padding = max(0, int(padding))

    cell_rects = _cell_rects(source.width, source.height, rows, columns, row_gap, column_gap)
    order_indices = _order_indices(rows, columns, order)
    cells = [source.crop(rect) for rect in cell_rects]
    warnings: list[str] = []

    if trim not in ("none", "union", "each"):
        trim = "union"

    bbox = (0, 0, cells[0].width, cells[0].height)
    cropped: list[Image.Image] = []
    if trim == "none":
        cropped = cells
    elif trim == "each":
        for cell in cells:
            box = image_utils.alpha_bbox(cell)
            if box is None:
                cropped.append(cell)
                continue
            left = max(0, box[0] - padding)
            top = max(0, box[1] - padding)
            right = min(cell.width, box[2] + padding)
            bottom = min(cell.height, box[3] + padding)
            cropped.append(cell.crop((left, top, right, bottom)))
        bbox = _union_size(cropped)
    else:
        boxes = []
        for cell in cells:
            box = image_utils.alpha_bbox(cell)
            if box is not None:
                boxes.append(box)
        if boxes:
            left = max(0, min(box[0] for box in boxes) - padding)
            top = max(0, min(box[1] for box in boxes) - padding)
            right = min(min(cell.width for cell in cells),
                        max(box[2] for box in boxes) + padding)
            bottom = min(min(cell.height for cell in cells),
                         max(box[3] for box in boxes) + padding)
            if right <= left or bottom <= top:
                warnings.append("并集包围盒为空，已退回整格裁切")
                cropped = cells
            else:
                bbox = (left, top, right, bottom)
                cropped = [cell.crop(bbox) for cell in cells]
        else:
            warnings.append("所有格子都是全透明，跳过裁边")
            cropped = cells

    if fit == "stretch":
        if target_size is None:
            target_size = _union_size(cropped)
        if target_size != _union_size(cropped):
            warnings.append("统一尺寸使用了拉伸缩放：会重采样，不再满足零像素偏移")
        normalized = [image_utils.resize(frame, target_size) for frame in cropped]
    else:
        if target_size is None:
            target_size = _union_size(cropped)
        normalized = [_pad_to(frame, target_size, anchor) for frame in cropped]

    # 按播放顺序重排
    ordered_frames = [normalized[index] for index in order_indices]
    ordered_rects = [cell_rects[index] for index in order_indices]

    return SheetSplit(
        frames=ordered_frames,
        rects=ordered_rects,
        cell_rects=cell_rects,
        order=order_indices,
        bbox=bbox,
        size=target_size,
        warnings=warnings,
        meta={
            "rows": rows,
            "columns": columns,
            "rowGap": row_gap,
            "columnGap": column_gap,
            "order": order,
            "trim": trim,
            "padding": padding,
            "fit": fit,
            "anchor": anchor,
            "sourceSize": [source.width, source.height],
        },
    )


def _union_size(frames: list[Image.Image]) -> tuple[int, int]:
    return (max((frame.width for frame in frames), default=1),
            max((frame.height for frame in frames), default=1))


def _pad_to(frame: Image.Image, size: tuple[int, int], anchor: str) -> Image.Image:
    width, height = int(size[0]), int(size[1])
    if frame.size == (width, height):
        return frame
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    left = (width - frame.width) // 2
    if anchor == "top":
        top = 0
    elif anchor == "bottom":
        top = height - frame.height
    else:
        top = (height - frame.height) // 2
    canvas.alpha_composite(frame, (left, top))
    return canvas


def layout_preview(image: Image.Image, rows: int, columns: int,
                   row_gap: int = 0, column_gap: int = 0) -> dict[str, Any]:
    """给前端画宫格辅助线用，不产生任何裁切。"""
    rects = _cell_rects(image.width, image.height, max(1, rows), max(1, columns),
                        max(0, row_gap), max(0, column_gap))
    return {
        "width": image.width,
        "height": image.height,
        "cells": [{"x": rect[0], "y": rect[1], "w": rect[2] - rect[0], "h": rect[3] - rect[1]}
                  for rect in rects],
    }
