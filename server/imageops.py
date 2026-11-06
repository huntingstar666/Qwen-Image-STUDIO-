"""图像处理：服务端（Pillow）的裁剪 / 宫格切分 / 旋转翻转 / 缩放 / 调色 / 32 对齐。

为什么放在服务端而不是只在浏览器 canvas 里做：

1. **无损**：PNG 直通不做二次编码，JPEG 输出可控质量；
2. **可复用**：处理结果直接落 `storage/outputs`，能立刻被「送入图生图 / 局部重绘」引用；
3. **一致**：32 对齐、补边策略和服务端管线（pipeline）用同一套规则，避免前端算错导致编辑偏移。

前端 canvas 版（`web/vendor/image-tools-kit/src/clientRenderer.js`）仍然保留用于实时预览，
真正落盘时走这里。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance

from . import align, imaging, storage

MAX_SIDE = 8192


class ImageOpsError(ValueError):
    """参数非法（会作为 400 返回给前端）。"""


# --------------------------------------------------------------------------- 单项操作


def _as_int(value: Any, name: str, *, minimum: int = 0) -> int:
    try:
        out = int(round(float(value)))
    except (TypeError, ValueError) as exc:
        raise ImageOpsError(f"{name} 必须是数字，收到 {value!r}") from exc
    if out < minimum:
        raise ImageOpsError(f"{name} 不能小于 {minimum}（收到 {out}）")
    return out


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def op_crop(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """按像素矩形裁剪（超出边界自动收敛到图内）。"""
    left = _as_int(spec.get("x", 0), "x")
    top = _as_int(spec.get("y", 0), "y")
    width = _as_int(spec.get("width"), "width", minimum=1)
    height = _as_int(spec.get("height"), "height", minimum=1)
    right = min(image.width, left + width)
    bottom = min(image.height, top + height)
    left = min(left, image.width - 1)
    top = min(top, image.height - 1)
    if right <= left or bottom <= top:
        raise ImageOpsError("裁剪区域为空，请检查 x/y/width/height")
    return image.crop((left, top, right, bottom))


def op_grid(image: Image.Image, spec: dict[str, Any]) -> list[Image.Image]:
    """宫格切分：rows × columns，可带间隔（像素）。"""
    rows = _as_int(spec.get("rows", 1), "rows", minimum=1)
    columns = _as_int(spec.get("columns", 1), "columns", minimum=1)
    row_gap = _as_int(spec.get("row_gap", 0), "row_gap")
    column_gap = _as_int(spec.get("column_gap", 0), "column_gap")
    if rows * columns > 64:
        raise ImageOpsError("宫格数量过多（最多 64 块）")

    cell_w = (image.width - column_gap * (columns - 1)) / columns
    cell_h = (image.height - row_gap * (rows - 1)) / rows
    if cell_w < 1 or cell_h < 1:
        raise ImageOpsError("间隔过大，导致切分后每块不足 1 像素")

    out: list[Image.Image] = []
    for r in range(rows):
        for c in range(columns):
            left = int(round(c * (cell_w + column_gap)))
            top = int(round(r * (cell_h + row_gap)))
            right = int(round(left + cell_w))
            bottom = int(round(top + cell_h))
            out.append(image.crop((left, top, right, bottom)))
    return out


def op_rotate(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    angle = float(spec.get("angle", 90))
    if abs(angle % 360) < 1e-6:
        return image
    # PIL 的 rotate 是逆时针；expand=True 保证不裁掉四角
    return image.rotate(angle, expand=True, resample=Image.BICUBIC)


def op_flip(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    horizontal = bool(spec.get("horizontal"))
    vertical = bool(spec.get("vertical"))
    out = image
    if horizontal:
        out = out.transpose(Image.FLIP_LEFT_RIGHT)
    if vertical:
        out = out.transpose(Image.FLIP_TOP_BOTTOM)
    return out if (horizontal or vertical) else image


def op_resize(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """fit: contain(补边) / cover(裁切) / stretch(拉伸)。"""
    width = _as_int(spec.get("width"), "width", minimum=1)
    height = _as_int(spec.get("height"), "height", minimum=1)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise ImageOpsError(f"目标尺寸过大（上限 {MAX_SIDE}）")
    fit = str(spec.get("fit") or "contain")
    if fit == "stretch":
        return image.resize((width, height), Image.LANCZOS)
    if fit == "cover":
        scale = max(width / image.width, height / image.height)
        size = (max(width, int(round(image.width * scale))), max(height, int(round(image.height * scale))))
        resized = image.resize(size, Image.LANCZOS)
        left = (size[0] - width) // 2
        top = (size[1] - height) // 2
        return resized.crop((left, top, left + width, top + height))
    # contain：等比缩到能放下，然后居中补边（透明或白）
    scale = min(width / image.width, height / image.height)
    size = (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
    resized = image.resize(size, Image.LANCZOS)
    background = (255, 255, 255, 0) if image.mode == "RGBA" else (255, 255, 255)
    canvas = Image.new(image.mode, (width, height), background)
    canvas.paste(resized, ((width - size[0]) // 2, (height - size[1]) // 2))
    return canvas


def op_adjust(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """亮度 / 对比 / 饱和 / 锐度 / 色温（-1 冷 ~ +1 暖）。"""
    brightness = _clamp(float(spec.get("brightness", 1.0)), 0.1, 3.0)
    contrast = _clamp(float(spec.get("contrast", 1.0)), 0.1, 3.0)
    saturation = _clamp(float(spec.get("saturation", 1.0)), 0.0, 3.0)
    sharpness = _clamp(float(spec.get("sharpness", 1.0)), 0.0, 4.0)
    temperature = _clamp(float(spec.get("temperature", 0.0)), -1.0, 1.0)

    out = image
    if abs(brightness - 1.0) > 1e-6:
        out = ImageEnhance.Brightness(out).enhance(brightness)
    if abs(contrast - 1.0) > 1e-6:
        out = ImageEnhance.Contrast(out).enhance(contrast)
    if abs(saturation - 1.0) > 1e-6:
        out = ImageEnhance.Color(out).enhance(saturation)
    if abs(sharpness - 1.0) > 1e-6:
        out = ImageEnhance.Sharpness(out).enhance(sharpness)
    if abs(temperature) > 1e-6:
        arr = np.asarray(out.convert("RGB"), dtype=np.float32)
        # 暖：抬红压蓝；冷：反过来。幅度控制在 ±18 个色阶以内，避免断层
        delta = temperature * 18.0
        arr[..., 0] = np.clip(arr[..., 0] + delta, 0, 255)
        arr[..., 2] = np.clip(arr[..., 2] - delta, 0, 255)
        warmed = Image.fromarray(arr.round().astype(np.uint8), mode="RGB")
        if out.mode == "RGBA":
            warmed = warmed.convert("RGBA")
            warmed.putalpha(out.getchannel("A"))
        out = warmed
    return out


def op_pad32(image: Image.Image, _spec: dict[str, Any]) -> Image.Image:
    """向上对齐到 32 的倍数（补边），与编辑管线的零偏移规则一致。"""
    width, height = align.snap_dims(image.width, image.height, 32)
    canvas, _info = align.pad_image(image, multiple=32, pad_mode="edge", align="center")
    if canvas.size != (width, height):
        canvas = canvas.resize((width, height), Image.LANCZOS)
    return canvas


def op_trim_alpha(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """按 alpha 去白边（可选）。padding 为保留的边距像素。"""
    if image.mode != "RGBA":
        return image
    padding = _as_int(spec.get("padding", 0), "padding")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return image
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(image.width, bbox[2] + padding)
    bottom = min(image.height, bbox[3] + padding)
    return image.crop((left, top, right, bottom))


_OP_HANDLERS = {
    "crop": op_crop,
    "rotate": op_rotate,
    "flip": op_flip,
    "resize": op_resize,
    "adjust": op_adjust,
    "pad32": op_pad32,
    "trim_alpha": op_trim_alpha,
}

#: 会产生多张输出的操作（其余一律单张）
_MULTI_OPS = {"grid"}


# --------------------------------------------------------------------------- 入口


def apply_ops(data: bytes, ops: list[dict[str, Any]] | None) -> tuple[list[Image.Image], list[str]]:
    """按顺序执行操作，返回 (图像列表, 操作名列表)。"""
    image = imaging.decode_image(data, keep_alpha=True)
    applied: list[str] = []
    images = [image]
    for spec in ops or []:
        if not isinstance(spec, dict):
            raise ImageOpsError("ops 里每一项必须是对象")
        name = str(spec.get("op") or "").strip()
        if not name:
            raise ImageOpsError("ops 里缺少 op 字段")
        if name in _MULTI_OPS:
            # 宫格只对当前第一张生效（常见用法：先裁剪再切宫格）
            images = op_grid(images[0], spec)
        else:
            handler = _OP_HANDLERS.get(name)
            if handler is None:
                raise ImageOpsError(
                    f"未知操作：{name}（支持 {sorted(list(_OP_HANDLERS) + list(_MULTI_OPS))}）")
            images = [handler(im, spec) for im in images]
        applied.append(name)
        if len(images) > 64:
            raise ImageOpsError("输出图片数量过多（最多 64 张）")
    return images, applied


def process(data: bytes, body: dict[str, Any]) -> dict[str, Any]:
    """HTTP 层入口：执行操作并落盘，返回可直接展示的结果。"""
    fmt = str(body.get("format") or "png").lower()
    if fmt not in ("png", "jpeg", "jpg"):
        raise ImageOpsError("format 只能是 png 或 jpeg")
    quality = _as_int(body.get("quality", 92), "quality", minimum=1)
    quality = min(quality, 100)
    prefix = str(body.get("prefix") or "processed")

    images, applied = apply_ops(data, body.get("ops"))
    results = []
    for index, image in enumerate(images):
        if fmt == "png":
            payload = imaging.encode_png(image)
            ext = "png"
        else:
            payload = imaging.encode_jpeg(image.convert("RGB"), quality=quality)
            ext = "jpg"
        meta = storage.save_output(payload, prefix=f"{prefix}-{index + 1}", ext=f".{ext}")
        meta["index"] = index
        results.append(meta)

    return {
        "ok": True,
        "applied": applied,
        "count": len(results),
        "images": results,
        "format": fmt,
    }


def outpaint_plan(source_w: int, source_h: int, *, direction: str = "right",
                  amount: float = 0.5, multiple: int = 32) -> dict[str, Any]:
    """扩图规划：给出画布尺寸 + 原图在画布中的位置（供前端生成遮罩）。

    `amount` 是相对原图对应边长的比例（0.1 ~ 2.0）。
    """
    amount = _clamp(float(amount), 0.05, 2.0)
    pad = {
        "left": int(round(source_w * amount)) if direction in ("left", "horizontal") else 0,
        "right": int(round(source_w * amount)) if direction in ("right", "horizontal") else 0,
        "top": int(round(source_h * amount)) if direction in ("up", "vertical") else 0,
        "bottom": int(round(source_h * amount)) if direction in ("down", "vertical") else 0,
    }
    if direction == "all":
        pad = {k: int(round((source_w if k in ("left", "right") else source_h) * amount))
               for k in ("left", "right", "top", "bottom")}
    canvas_w, canvas_h = align.snap_dims(source_w + pad["left"] + pad["right"],
                                         source_h + pad["top"] + pad["bottom"], multiple)
    return {
        "direction": direction,
        "amount": amount,
        "pad": pad,
        "source": {"w": source_w, "h": source_h},
        "canvas": {"w": canvas_w, "h": canvas_h},
        "offset": {"x": pad["left"], "y": pad["top"]},
        "note": "原图贴到画布 offset 处，遮罩只覆盖新增区域（白=要生成的地方）",
    }
