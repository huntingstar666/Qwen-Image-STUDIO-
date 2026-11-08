"""蒙版纯算法核：坐标校验、二值化、连通域拆分、羽化与 PNG 编码。

只依赖 numpy + PIL（连通域优先用 scipy，缺失时退化为整体一块），
不 import torch，便于单元测试与前端坐标契约对齐。
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageFilter

from .errors import SegmentError

#: 输入图硬限制（见 docs/BACKEND_REQUIREMENTS_STUDIO_AI.md）
MAX_SIDE = 4096
MAX_PIXELS = 16 * 1024 * 1024


def check_image_size(width: int, height: int) -> None:
    """校验输入图尺寸；不合法时抛 ``invalid_image``。"""
    if width <= 0 or height <= 0:
        raise SegmentError("图片无法读取或超出尺寸限制", code="invalid_image", status=400)
    if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
        raise SegmentError("图片无法读取或超出尺寸限制", code="invalid_image", status=400)


def _number(value, *, code: str, message: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise SegmentError(message, code=code, status=400) from exc
    if not np.isfinite(number):
        raise SegmentError(message, code=code, status=400)
    return number


def validate_box(box, width: int, height: int) -> tuple[int, int, int, int]:
    """把 ``{x,y,width,height}`` 校验并转成 ``(x1,y1,x2,y2)`` 像素框。

    与契约一致：宽高必须为正，越界视为无效框（前端应先夹到图像内）。
    """
    message = "框选区域无效，请重新框选"
    if not isinstance(box, dict):
        raise SegmentError(message, code="invalid_box", status=400)
    x = _number(box.get("x"), code="invalid_box", message=message)
    y = _number(box.get("y"), code="invalid_box", message=message)
    w = _number(box.get("width"), code="invalid_box", message=message)
    h = _number(box.get("height"), code="invalid_box", message=message)
    if w <= 0 or h <= 0:
        raise SegmentError(message, code="invalid_box", status=400)
    # 允许 1px 的取整误差，超过即判为越界
    if x < -0.5 or y < -0.5 or x + w > width + 0.5 or y + h > height + 0.5:
        raise SegmentError(message, code="invalid_box", status=400)
    x1 = max(0, int(round(x)))
    y1 = max(0, int(round(y)))
    x2 = min(int(width), int(round(x + w)))
    y2 = min(int(height), int(round(y + h)))
    if x2 <= x1 or y2 <= y1:
        raise SegmentError(message, code="invalid_box", status=400)
    return x1, y1, x2, y2


def validate_points(points, width: int, height: int) -> list[tuple[float, float, int]]:
    """校验点提示：``[{x,y,label}]``，label=1 前景、0 背景（缺省 1）。"""
    message = "取样点无效，请重新点选"
    if not isinstance(points, list) or not points:
        raise SegmentError(message, code="invalid_points", status=400)
    out: list[tuple[float, float, int]] = []
    for item in points[:64]:
        if not isinstance(item, dict):
            raise SegmentError(message, code="invalid_points", status=400)
        x = _number(item.get("x"), code="invalid_points", message=message)
        y = _number(item.get("y"), code="invalid_points", message=message)
        if x < 0 or y < 0 or x >= width or y >= height:
            raise SegmentError(message, code="invalid_points", status=400)
        label = item.get("label", 1)
        try:
            label = int(label)
        except (TypeError, ValueError) as exc:
            raise SegmentError(message, code="invalid_points", status=400) from exc
        out.append((x, y, 1 if label != 0 else 0))
    if not any(label == 1 for _x, _y, label in out):
        raise SegmentError("至少需要一个前景取样点", code="invalid_points", status=400)
    return out


def resize_float(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """把概率/Logit 蒙版双线性缩放到目标尺寸（float32）。"""
    array = np.asarray(mask, dtype=np.float32)
    if array.ndim != 2:
        raise SegmentError("蒙版维度错误", code="segmentation_failed", status=500)
    if array.shape == (height, width):
        return array
    image = Image.fromarray(array, mode="F")
    return np.asarray(image.resize((int(width), int(height)), Image.BILINEAR), dtype=np.float32)


def binarize(mask: np.ndarray, threshold: float = 0.5) -> np.ndarray:
    """按 0.5 阈值二值化（返回 bool）。"""
    return np.asarray(mask, dtype=np.float32) >= float(threshold)


def clip_to_box(mask: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """把蒙版严格限制在框内（框外一律 False）。"""
    out = np.asarray(mask, dtype=bool).copy()
    x1, y1, x2, y2 = box
    keep = np.zeros_like(out, dtype=bool)
    keep[max(0, y1):max(0, y2), max(0, x1):max(0, x2)] = True
    return out & keep


def bbox_of(mask: np.ndarray) -> dict[str, int] | None:
    """蒙版的像素包围盒（无选中像素时返回 None）。"""
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return None
    ys = np.where(rows)[0]
    xs = np.where(cols)[0]
    x1, x2 = int(xs[0]), int(xs[-1]) + 1
    y1, y2 = int(ys[0]), int(ys[-1]) + 1
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


def mask_info(mask: np.ndarray) -> tuple[int, dict[str, int] | None]:
    """返回 ``(选中像素数, 包围盒)``。"""
    binary = np.asarray(mask, dtype=bool)
    return int(binary.sum()), bbox_of(binary)


def components(mask: np.ndarray, min_area: int = 0) -> list[np.ndarray]:
    """把二值蒙版拆成互不连通的区域（按面积降序）。

    优先用 scipy.ndimage；环境里没有 scipy 时退化为「整体一块」，
    仍能满足 multi=false 的行为。
    """
    binary = np.asarray(mask, dtype=bool)
    if not binary.any():
        return []
    try:
        from scipy import ndimage  # type: ignore
    except Exception:  # pragma: no cover - 环境缺 scipy
        return [binary]
    labels, count = ndimage.label(binary, structure=np.ones((3, 3), dtype=np.uint8))
    if count <= 1:
        return [binary]
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    parts: list[np.ndarray] = []
    for index in range(1, count + 1):
        if areas[index] <= 0 or areas[index] < min_area:
            continue
        parts.append(labels == index)
    parts.sort(key=lambda item: int(item.sum()), reverse=True)
    return parts


def rasterize(mask: np.ndarray, feather: float = 0) -> bytes:
    """把概率蒙版编码成灰度 PNG（白=选中）。

    * ``feather > 0``：按该半径高斯羽化，边缘为渐变灰；
    * ``feather == 0``：0.5 硬阈值二值化，再做 1px 轻度抗锯齿。
    """
    array = np.clip(np.asarray(mask, dtype=np.float32), 0.0, 1.0)
    if feather and float(feather) > 0:
        gray = (array * 255.0).round().astype(np.uint8)
        image = Image.fromarray(gray, mode="L").filter(
            ImageFilter.GaussianBlur(float(feather)))
    else:
        gray = np.where(array >= 0.5, 255, 0).astype(np.uint8)
        image = Image.fromarray(gray, mode="L").filter(ImageFilter.GaussianBlur(1.0))
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()
