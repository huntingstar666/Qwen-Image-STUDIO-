"""图像处理：服务端（Pillow）的裁剪 / 宫格切分 / 旋转翻转 / 缩放 / 调色 / 32 对齐。

为什么放在服务端而不是只在浏览器 canvas 里做：

1. **无损**：PNG 直通不做二次编码，JPEG 输出可控质量；
2. **可复用**：处理结果直接落 `storage/outputs`，能立刻被「送入图生图 / 局部重绘」引用；
3. **一致**：32 对齐、补边策略和服务端管线（pipeline）用同一套规则，避免前端算错导致编辑偏移。

前端 canvas 版（`web/vendor/image-tools-kit/src/clientRenderer.js`）仍然保留用于实时预览，
真正落盘时走这里。
"""
from __future__ import annotations

import io
import math
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

from . import align, imaging, storage

MAX_SIDE = 8192

#: 导出体积目标范围（KB）：太小的目标在高质量图上无解，太大则失去意义。
MIN_TARGET_KB = 32
MAX_TARGET_KB = 50 * 1024

#: resize 支持的重采样滤镜（默认 lanczos）。
_RESAMPLE = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
    "bilinear": Image.Resampling.BILINEAR,
    "nearest": Image.Resampling.NEAREST,
    "box": Image.Resampling.BOX,
}


class ImageOpsError(ValueError):
    """参数非法（会作为 400 返回给前端）。

    ``code`` 用于前端把错误映射到具体动作（如 ``image_too_large`` 提示先缩小）。
    """

    def __init__(self, message: str, *, code: str = "invalid_ops") -> None:
        super().__init__(message)
        self.code = code


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
    """宫格切分：rows × columns，可带间隔（像素）与选中的格子序号（1 起，行优先）。"""
    rows = _as_int(spec.get("rows", 1), "rows", minimum=1)
    columns = _as_int(spec.get("columns", 1), "columns", minimum=1)
    row_gap = _as_int(spec.get("row_gap", 0), "row_gap")
    column_gap = _as_int(spec.get("column_gap", 0), "column_gap")
    if rows * columns > 64:
        raise ImageOpsError("宫格数量过多（最多 64 块）")

    wanted: set[int] | None = None
    raw_cells = spec.get("cells")
    if raw_cells is not None:
        if not isinstance(raw_cells, (list, tuple)):
            raise ImageOpsError("cells 必须是数组")
        wanted = set()
        for value in raw_cells:
            index = _as_int(value, "cells", minimum=1)
            if index > rows * columns:
                raise ImageOpsError(f"cells 里的序号超出范围（1~{rows * columns}）")
            wanted.add(index)
        if not wanted:
            raise ImageOpsError("没有选中任何宫格")

    cell_w = (image.width - column_gap * (columns - 1)) / columns
    cell_h = (image.height - row_gap * (rows - 1)) / rows
    if cell_w < 1 or cell_h < 1:
        raise ImageOpsError("间隔过大，导致切分后每块不足 1 像素")

    out: list[Image.Image] = []
    for r in range(rows):
        for c in range(columns):
            index = r * columns + c + 1
            if wanted is not None and index not in wanted:
                continue
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


def op_mirror(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """对称镜像：把选区中「基准侧」的内容翻到对称轴另一侧。

    * ``axis``：``vertical``（左右对称）/ ``horizontal``（上下对称）；
    * ``position``：对称轴在选区内的相对位置，0~1；
    * ``side``：``start``（左/上为准）/ ``end``（右/下为准）；
    * ``rect``：可选选区（像素），缺省镜像整图。
    """
    axis = str(spec.get("axis") or "vertical").lower()
    if axis not in ("vertical", "horizontal"):
        raise ImageOpsError(f"未知的镜像轴：{axis}（支持 vertical/horizontal）")
    position = _clamp(float(spec.get("position", 0.5)), 0.02, 0.98)
    side = str(spec.get("side") or "start").lower()
    if side not in ("start", "end"):
        side = "start"

    rect = spec.get("rect") or {}
    left = max(0, _as_int(rect.get("x", 0), "x"))
    top = max(0, _as_int(rect.get("y", 0), "y"))
    width = _as_int(rect.get("width", image.width), "width", minimum=1)
    height = _as_int(rect.get("height", image.height), "height", minimum=1)
    right = min(image.width, left + width)
    bottom = min(image.height, top + height)
    left = min(left, image.width - 1)
    top = min(top, image.height - 1)
    width = right - left
    height = bottom - top
    if width < 2 or height < 2:
        raise ImageOpsError("镜像区域过小（至少 2×2）")

    out = image.copy()
    if axis == "vertical":
        axis_x = left + round(width * position)
        if side == "start":
            src_avail, dest_avail = axis_x - left, right - axis_x
        else:
            src_avail, dest_avail = right - axis_x, axis_x - left
        take = min(src_avail, dest_avail)
        if take < 1:
            return out
        if side == "start":
            strip = image.crop((axis_x - take, top, axis_x, bottom))
            out.paste(strip.transpose(Image.FLIP_LEFT_RIGHT), (axis_x, top))
        else:
            strip = image.crop((axis_x, top, axis_x + take, bottom))
            out.paste(strip.transpose(Image.FLIP_LEFT_RIGHT), (axis_x - take, top))
        return out

    axis_y = top + round(height * position)
    if side == "start":
        src_avail, dest_avail = axis_y - top, bottom - axis_y
    else:
        src_avail, dest_avail = bottom - axis_y, axis_y - top
    take = min(src_avail, dest_avail)
    if take < 1:
        return out
    if side == "start":
        strip = image.crop((left, axis_y - take, right, axis_y))
        out.paste(strip.transpose(Image.FLIP_TOP_BOTTOM), (left, axis_y))
    else:
        strip = image.crop((left, axis_y, right, axis_y + take))
        out.paste(strip.transpose(Image.FLIP_TOP_BOTTOM), (left, axis_y - take))
    return out


def _resample(name: Any) -> Image.Resampling:
    key = str(name or "lanczos").lower()
    if key not in _RESAMPLE:
        raise ImageOpsError(f"未知的重采样滤镜：{name}（支持 {sorted(_RESAMPLE)}）")
    return _RESAMPLE[key]


def _target_size(image: Image.Image, spec: dict[str, Any]) -> tuple[int, int]:
    """按 mode 计算目标尺寸（不做事，只算数）。

    mode 缺省为 ``exact``，兼容旧的 ``width/height`` 请求。
    ``keep_aspect`` 默认 True：给定长宽时按「放进框内」等比缩小（contain），
    不会因为锁定比例反而超出用户输入的目标框。
    """
    mode = str(spec.get("mode") or "exact").lower()
    width, height = image.size

    if mode == "exact":
        raw_w = spec.get("width")
        raw_h = spec.get("height")
        has_w = raw_w not in (None, "", 0)
        has_h = raw_h not in (None, "", 0)
        if not has_w and not has_h:
            raise ImageOpsError("exact 模式需要 width 或 height")
        if not has_w:
            target_h = _as_int(raw_h, "height", minimum=1)
            return max(1, round(width * target_h / height)), target_h
        if not has_h:
            target_w = _as_int(raw_w, "width", minimum=1)
            return target_w, max(1, round(height * target_w / width))
        target_w = _as_int(raw_w, "width", minimum=1)
        target_h = _as_int(raw_h, "height", minimum=1)
        if target_w > MAX_SIDE or target_h > MAX_SIDE:
            # 用户请求值先校验：锁定比例时会被缩到框内，不能让它悄悄通过
            raise ImageOpsError(f"目标尺寸过大（上限 {MAX_SIDE}）", code="image_too_large")
        if bool(spec.get("keep_aspect", True)):
            scale = min(target_w / width, target_h / height)
            return max(1, round(width * scale)), max(1, round(height * scale))
        return target_w, target_h

    if mode == "percent":
        percent = float(spec.get("percent", 100))
        if percent <= 0:
            raise ImageOpsError("percent 必须大于 0")
        return max(1, round(width * percent / 100)), max(1, round(height * percent / 100))

    if mode == "long_edge":
        edge = _as_int(spec.get("long_edge"), "long_edge", minimum=1)
        scale = edge / max(width, height)
        return max(1, round(width * scale)), max(1, round(height * scale))

    if mode == "short_edge":
        edge = _as_int(spec.get("short_edge"), "short_edge", minimum=1)
        scale = edge / min(width, height)
        return max(1, round(width * scale)), max(1, round(height * scale))

    if mode == "megapixels":
        megapixels = float(spec.get("megapixels", 0))
        if megapixels <= 0:
            raise ImageOpsError("megapixels 必须大于 0")
        scale = math.sqrt(megapixels * 1_000_000 / (width * height))
        return max(1, round(width * scale)), max(1, round(height * scale))

    raise ImageOpsError(f"未知的 resize 模式：{mode}（支持 exact/percent/long_edge/short_edge/megapixels）")


def _apply_sharpen(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """缩放后的锐化（UnsharpMask），``sharpen_after`` 0 表示不处理。"""
    sharpen = float(spec.get("sharpen_after") or 0)
    if sharpen <= 0:
        return image
    return image.filter(
        ImageFilter.UnsharpMask(
            radius=1.0, percent=int(_clamp(sharpen, 1, 200)), threshold=2
        )
    )


def _apply_snap(size: tuple[int, int], spec: dict[str, Any]) -> tuple[int, int]:
    """把目标尺寸对齐到 ``snap`` 的倍数（与前端预览一致）。"""
    snap = _as_int(spec.get("snap", 0), "snap")
    if snap <= 1:
        return size
    width = max(snap, int(round(size[0] / snap)) * snap)
    height = max(snap, int(round(size[1] / snap)) * snap)
    return width, height


def op_resize(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """两种用法：

    * 旧接口：``width/height + fit``（contain 补边 / cover 裁切 / stretch 拉伸）；
    * 新接口：``mode + 目标参数``（exact / percent / long_edge / short_edge / megapixels），
      可带 ``snap``（对齐到倍数）、``filter``（重采样滤镜）、``sharpen_after``（锐化强度）。
    """
    if spec.get("fit") is not None:
        return _resize_fit(image, spec)

    width, height = _target_size(image, spec)
    width, height = _apply_snap((width, height), spec)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise ImageOpsError(f"目标尺寸过大（上限 {MAX_SIDE}）", code="image_too_large")

    method = _resample(spec.get("filter"))
    if width < image.width or height < image.height:
        out = image.resize((width, height), resample=method, reducing_gap=3)
    else:
        out = image.resize((width, height), resample=method)
    return _apply_sharpen(out, spec)


def _resize_fit(image: Image.Image, spec: dict[str, Any]) -> Image.Image:
    """旧接口：fit = contain(补边) / cover(裁切) / stretch(拉伸)。

    ``filter`` / ``sharpen_after`` 与新模式保持一致，避免用户在精确宽高下
    选了算法却仍然固定走 LANCZOS。
    """
    width = _as_int(spec.get("width"), "width", minimum=1)
    height = _as_int(spec.get("height"), "height", minimum=1)
    width, height = _apply_snap((width, height), spec)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise ImageOpsError(f"目标尺寸过大（上限 {MAX_SIDE}）", code="image_too_large")
    fit = str(spec.get("fit") or "contain")
    method = _resample(spec.get("filter"))
    if fit == "stretch":
        return _apply_sharpen(image.resize((width, height), method), spec)
    if fit == "cover":
        scale = max(width / image.width, height / image.height)
        size = (max(width, int(round(image.width * scale))), max(height, int(round(image.height * scale))))
        resized = image.resize(size, method)
        left = (size[0] - width) // 2
        top = (size[1] - height) // 2
        out = resized.crop((left, top, left + width, top + height))
        return _apply_sharpen(out, spec)
    # contain：等比缩到能放下，然后居中补边（透明或白）
    scale = min(width / image.width, height / image.height)
    size = (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
    resized = image.resize(size, method)
    background = (255, 255, 255, 0) if image.mode == "RGBA" else (255, 255, 255)
    canvas = Image.new(image.mode, (width, height), background)
    canvas.paste(resized, ((width - size[0]) // 2, (height - size[1]) // 2))
    return _apply_sharpen(canvas, spec)


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
    "mirror": op_mirror,
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


def _parse_color(value: Any, default: tuple[int, int, int] = (255, 255, 255)) -> tuple[int, int, int]:
    """解析 ``#rgb`` / ``#rrggbb`` 颜色；非法时退回默认值。"""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        return default
    try:
        return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return default


def _flatten_rgb(image: Image.Image, background: tuple[int, int, int]) -> Image.Image:
    """把带 alpha 的图合成到纯色底（JPEG 这类无透明通道的格式用）。"""
    rgba = image.convert("RGBA")
    canvas = Image.new("RGBA", rgba.size, (*background, 255))
    canvas.alpha_composite(rgba)
    return canvas.convert("RGB")


def _encode(image: Image.Image, fmt: str, *, quality: int, lossless: bool,
            background: tuple[int, int, int]) -> bytes:
    if fmt == "png":
        return imaging.encode_png(image)
    if fmt == "webp":
        buf = io.BytesIO()
        if lossless:
            image.save(buf, format="WEBP", lossless=True, quality=100, method=4)
        else:
            image.save(buf, format="WEBP", quality=int(quality), method=4)
        return buf.getvalue()
    return imaging.encode_jpeg(_flatten_rgb(image, background), quality=quality)


def encode_export(image: Image.Image, fmt: str = "png", *, quality: int = 92,
                  lossless: bool = False, background: Any = "#ffffff") -> tuple[bytes, str]:
    """按导出格式编码单张图，返回 ``(字节, 扩展名)``（水印等其它模块复用）。"""
    fmt = "jpeg" if fmt == "jpg" else fmt
    if fmt not in ("png", "jpeg", "webp"):
        raise ImageOpsError("format 只能是 png / jpeg / webp")
    payload = _encode(image, fmt, quality=int(_clamp(quality, 1, 100)), lossless=lossless,
                      background=_parse_color(background, (255, 255, 255)))
    return payload, {"png": "png", "jpeg": "jpg", "webp": "webp"}[fmt]


def _encode_with_target(image: Image.Image, fmt: str, *, quality: int, lossless: bool,
                        background: tuple[int, int, int], target_kb: int | None
                        ) -> tuple[bytes, int, bool | None]:
    """编码；给了 ``target_kb`` 时对 JPEG/WebP 二分搜索质量（最多 7 次）。

    返回 ``(字节, 实际质量, 是否达标)``。PNG 不可控体积，达标信息按实际大小如实返回。
    """
    if not target_kb:
        return _encode(image, fmt, quality=quality, lossless=lossless,
                       background=background), quality, None

    target = target_kb * 1024
    if fmt == "png":
        payload = _encode(image, fmt, quality=quality, lossless=lossless, background=background)
        return payload, quality, len(payload) <= target

    low, high = 30, max(quality, 60)
    best: tuple[bytes, int] | None = None
    smallest: tuple[bytes, int] | None = None
    for _ in range(7):
        if low > high:
            break
        mid = (low + high) // 2
        payload = _encode(image, fmt, quality=mid, lossless=lossless, background=background)
        if smallest is None or len(payload) < len(smallest[0]):
            smallest = (payload, mid)
        if len(payload) <= target:
            best = (payload, mid)
            low = mid + 1
        else:
            high = mid - 1
    if best is not None:
        return best[0], best[1], True
    # 最低质量仍超标：给出最小质量结果并告知未达标
    payload = _encode(image, fmt, quality=30, lossless=lossless, background=background)
    return payload, 30, False


def process(data: bytes, body: dict[str, Any]) -> dict[str, Any]:
    """HTTP 层入口：执行操作并落盘，返回可直接展示的结果。

    导出增强：``webp`` + ``lossless``、``target_kb``（JPEG/WebP 二分质量）、
    ``background``（JPEG 透明区铺底颜色）。
    """
    fmt = str(body.get("format") or "png").lower()
    if fmt == "jpg":
        fmt = "jpeg"
    if fmt not in ("png", "jpeg", "webp"):
        raise ImageOpsError("format 只能是 png / jpeg / webp")
    quality = _as_int(body.get("quality", 92), "quality", minimum=1)
    quality = min(quality, 100)
    lossless = bool(body.get("lossless"))
    background = _parse_color(body.get("background"), (255, 255, 255))
    target_kb: int | None = None
    if body.get("target_kb") not in (None, "", 0):
        target_kb = _as_int(body.get("target_kb"), "target_kb", minimum=MIN_TARGET_KB)
        if target_kb > MAX_TARGET_KB:
            raise ImageOpsError(f"target_kb 过大（上限 {MAX_TARGET_KB}KB）")
    prefix = str(body.get("prefix") or "processed")
    ext = {"png": "png", "jpeg": "jpg", "webp": "webp"}[fmt]

    images, applied = apply_ops(data, body.get("ops"))
    results = []
    for index, image in enumerate(images):
        payload, used_quality, target_met = _encode_with_target(
            image, fmt, quality=quality, lossless=lossless,
            background=background, target_kb=target_kb,
        )
        meta = storage.save_output(payload, prefix=f"{prefix}-{index + 1}", ext=f".{ext}",
                                   image=image)
        meta["index"] = index
        meta["quality"] = used_quality
        if target_kb is not None:
            meta["target_kb"] = target_kb
            meta["target_met"] = target_met
        results.append(meta)

    return {
        "ok": True,
        "applied": applied,
        "count": len(results),
        "format": fmt,
        "lossless": lossless,
        "images": results,
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
