"""把帧图合成到统一画布。

默认路径（无缩放、无旋转、整数位移）是**纯 alpha 合成**：
像素值直接拷贝，不做任何插值，满足主项目的零像素偏移规则。
只有用户显式开启缩放/旋转，或画布适配需要缩放时才会走重采样，
并在导出结果里通过 ``resampled`` / ``pixel_exact`` 明确告知。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
from PIL import Image

from . import images as image_utils
from .errors import AnimationCanceled
from .registry import parse_color


@dataclass
class FrameRender:
    id: str
    image: Image.Image
    resampled: bool = False
    reasons: list[str] = field(default_factory=list)


@dataclass
class RenderResult:
    frames: dict[str, FrameRender]
    width: int
    height: int
    warnings: list[str] = field(default_factory=list)

    @property
    def pixel_exact(self) -> bool:
        return not any(item.resampled for item in self.frames.values())

    @property
    def resampled_ids(self) -> list[str]:
        return [item.id for item in self.frames.values() if item.resampled]

    def image_for(self, frame: dict[str, Any]) -> Image.Image:
        key = str(frame.get("id") or "")
        return self.frames[key].image

    def to_dict(self) -> dict[str, Any]:
        return {
            "pixel_exact": self.pixel_exact,
            "resampled": self.resampled_ids,
            "width": self.width,
            "height": self.height,
            "warnings": self.warnings,
        }


def _multiply_alpha(image: Image.Image, opacity: float) -> Image.Image:
    if abs(opacity - 1.0) < 1e-6:
        return image
    array = np.asarray(image, dtype=np.float32).copy()
    array[..., 3] = np.clip(array[..., 3] * max(0.0, min(1.0, opacity)), 0, 255)
    return Image.fromarray(array.round().astype(np.uint8), mode="RGBA")


def _rotate(image: Image.Image, angle: float) -> Image.Image:
    if abs(angle % 360) < 1e-6:
        return image
    return image.rotate(angle, expand=True, resample=image_utils.BICUBIC)


def render_frame(frame: dict[str, Any], source: Image.Image,
                 canvas: dict[str, Any]) -> FrameRender:
    width = int(canvas.get("width") or source.width)
    height = int(canvas.get("height") or source.height)
    fit = str(canvas.get("fit") or "contain")
    anchor = str(canvas.get("anchor") or "center")
    reasons: list[str] = []

    resampled = False
    image = image_utils.ensure_rgba(source)

    scale = float(frame.get("scale") or 1.0)
    if abs(scale - 1.0) > 1e-6:
        target = (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
        if target != image.size:
            image = image_utils.resize(image, target)
            resampled = True
            reasons.append(f"缩放 ×{scale:g}")

    rotation = float(frame.get("rotation") or 0.0)
    if abs(rotation % 360) > 1e-6:
        image = _rotate(image, rotation)
        resampled = True
        reasons.append(f"旋转 {rotation:g}°")

    placed, info = image_utils.fit_into(image, (width, height), fit=fit, anchor=anchor)
    if info.get("resampled"):
        resampled = True
        reasons.append(f"画布适配 {fit}")

    opacity = float(frame.get("opacity") if frame.get("opacity") is not None else 1.0)
    if abs(opacity - 1.0) > 1e-6:
        placed = _multiply_alpha(placed, opacity)

    offset_x = int(round(float(frame.get("offsetX") or 0)))
    offset_y = int(round(float(frame.get("offsetY") or 0)))
    if float(frame.get("offsetX") or 0) != offset_x or float(frame.get("offsetY") or 0) != offset_y:
        reasons.append("位移已取整")

    background = parse_color(str(canvas.get("background") or ""))
    canvas_image = Image.new("RGBA", (width, height), background)

    if (not resampled and offset_x == 0 and offset_y == 0
            and placed.size == (width, height) and background[3] == 0):
        # 零偏移快路径：直接拷贝，连 alpha 预乘的往返都省掉
        return FrameRender(id=str(frame.get("id") or ""), image=placed.copy(),
                           resampled=False, reasons=reasons)

    canvas_image.alpha_composite(placed, (offset_x, offset_y))
    return FrameRender(
        id=str(frame.get("id") or ""),
        image=canvas_image,
        resampled=resampled,
        reasons=reasons,
    )


def render_doc(
    doc: dict[str, Any],
    loader: Callable[[str], Image.Image],
    *,
    progress: Callable[[int, int, str], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> RenderResult:
    """渲染所有帧到画布尺寸；``loader(url)`` 返回 PIL 图。"""
    canvas = doc.get("canvas") or {}
    frames = doc.get("frames") or []
    rendered: dict[str, FrameRender] = {}

    for index, frame in enumerate(frames):
        if cancel and cancel():
            raise AnimationCanceled()
        key = str(frame.get("id") or "")
        if key in rendered:
            continue
        source = loader(str(frame.get("url") or ""))
        # 用帧自带的宽高校正，避免同一 URL 被不同帧引用时尺寸判断失真
        rendered[key] = render_frame(frame, source, canvas)
        if progress:
            progress(index + 1, max(1, len(frames)), f"合成第 {index + 1}/{len(frames)} 帧")

    width = int(canvas.get("width") or (next(iter(rendered.values())).image.width if rendered else 1))
    height = int(canvas.get("height") or (next(iter(rendered.values())).image.height if rendered else 1))
    warnings: list[str] = []
    resampled = [item for item in rendered.values() if item.resampled]
    if resampled:
        warnings.append(f"{len(resampled)} 帧经过重采样（缩放/旋转/画布适配），不再逐像素一致")
    return RenderResult(frames=rendered, width=width, height=height, warnings=warnings)
