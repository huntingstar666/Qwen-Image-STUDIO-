"""自动稳定：用 FFT 相位相关估计整数平移，消除定格拍摄/生成造成的主体抖动。

为什么默认只做**整数**平移：

* 主项目的零像素偏移承诺来自「整数裁剪 + 整数粘贴」；
* 亚像素平移必然重采样，会让线条发糊、颜色偏移；
* 定格动画的抖动通常就是 1~N 个像素，整数补偿已经能明显改善。

相位相关给出的是 ``cur`` 相对 ``ref`` 的位移 ``(dx, dy)``，
补偿时对帧应用 ``(-dx, -dy)``。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
from PIL import Image

from . import images as image_utils


@dataclass
class Shift:
    frameId: str
    dx: int
    dy: int
    confidence: float
    applied: bool
    reason: str = ""


@dataclass
class AlignReport:
    reference: str
    maxShift: int
    confidence: float
    shifts: list[Shift] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        accepted = [item for item in self.shifts if item.applied]
        return {
            "reference": self.reference,
            "maxShift": self.maxShift,
            "confidence": self.confidence,
            "shifts": [item.__dict__ for item in self.shifts],
            "accepted": len(accepted),
            "rejected": len(self.shifts) - len(accepted),
            "mean_abs": (
                round(float(np.mean([abs(item.dx) + abs(item.dy) for item in accepted]) / 2), 2)
                if accepted else 0.0
            ),
            "max_abs": max((max(abs(item.dx), abs(item.dy)) for item in accepted), default=0),
            "warnings": self.warnings,
        }


# --------------------------------------------------------------------------- 预处理


def _signal(image: Image.Image) -> np.ndarray:
    """亮度 × alpha，去均值；透明区域自然变成 0，不会主导相关性。"""
    rgba = np.asarray(image_utils.ensure_rgba(image), dtype=np.float32)
    if rgba.ndim != 3 or rgba.shape[2] < 3:
        raise ValueError("对齐需要彩色图像")
    luma = rgba[..., 0] * 0.299 + rgba[..., 1] * 0.587 + rgba[..., 2] * 0.114
    alpha = rgba[..., 3] / 255.0
    signal = luma * alpha
    signal -= float(signal.mean())
    # 加窗抑制 FFT 循环卷绕造成的假峰；alpha 已经压掉透明区，窗口只影响边缘
    height, width = signal.shape
    window = np.outer(np.hanning(height), np.hanning(width)).astype(np.float32)
    return signal * window


def _gray(image: Image.Image) -> np.ndarray:
    rgba = np.asarray(image_utils.ensure_rgba(image), dtype=np.float32)
    return rgba[..., 0] * 0.299 + rgba[..., 1] * 0.587 + rgba[..., 2] * 0.114


# --------------------------------------------------------------------------- 相位相关


def phase_shift(reference: Image.Image, current: Image.Image,
                *, max_shift: int | None = None) -> tuple[int, int, float]:
    """估计 ``current`` 相对 ``reference`` 的整数平移。

    返回 ``(dx, dy, confidence)``；正数表示 current 的内容在 ref 的右/下方。
    """
    if reference.size != current.size:
        raise ValueError("相位相关要求两张图尺寸一致")
    ref = _signal(reference)
    cur = _signal(current)
    if float(np.abs(ref).max()) < 1e-6 or float(np.abs(cur).max()) < 1e-6:
        return 0, 0, 0.0

    spectrum = np.fft.rfft2(ref) * np.conj(np.fft.rfft2(cur))
    magnitude = np.abs(spectrum)
    spectrum = spectrum / np.maximum(magnitude, 1e-8)
    correlation = np.fft.irfft2(spectrum, s=ref.shape)

    height, width = correlation.shape
    peak_index = int(np.argmax(correlation))
    peak_y, peak_x = np.unravel_index(peak_index, correlation.shape)
    # F_ref × conj(F_cur) 的峰在 -shift，翻转后才是「cur 相对 ref」的位移
    dy, dx = -int(peak_y), -int(peak_x)
    if dy < -height // 2:
        dy += height
    if dx < -width // 2:
        dx += width
    if max_shift is not None:
        dx = int(np.clip(dx, -max_shift, max_shift))
        dy = int(np.clip(dy, -max_shift, max_shift))

    mean = float(correlation.mean())
    std = float(correlation.std()) or 1e-8
    confidence = float((correlation[peak_y, peak_x] - mean) / std)
    return int(dx), int(dy), round(confidence, 4)


def _median_reference(images: Sequence[Image.Image], limit: int = 24) -> Image.Image:
    sample = [np.asarray(ensure_rgba_small(image), dtype=np.float32) for image in images[:limit]]
    stack = np.stack(sample, axis=0)
    median = np.median(stack, axis=0)
    return Image.fromarray(np.clip(median, 0, 255).astype(np.uint8), mode="L")


def ensure_rgba_small(image: Image.Image) -> Image.Image:
    rgba = image_utils.ensure_rgba(image)
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.float32) / 255.0
    luma = np.asarray(rgba.convert("RGB"), dtype=np.float32) @ np.array(
        [0.299, 0.587, 0.114], dtype=np.float32
    )
    return Image.fromarray(np.clip(luma * alpha, 0, 255).astype(np.uint8), mode="L")


# --------------------------------------------------------------------------- 对外


def estimate_offsets(
    frames: Sequence[dict[str, Any]],
    images: Sequence[Image.Image],
    *,
    reference: str = "first",
    max_shift: int = 64,
    confidence: float = 0.08,
) -> AlignReport:
    """估计每帧需要施加的补偿位移。

    ``frames`` 与 ``images`` 一一对应，只用 ``id`` 字段做回填。
    补偿值是整数，直接加到帧的 ``offsetX/offsetY`` 上即可。
    """
    if len(frames) != len(images):
        raise ValueError("frames 与 images 数量不一致")
    if not images:
        return AlignReport(reference, max_shift, confidence)

    report = AlignReport(reference=reference, maxShift=max_shift, confidence=confidence)
    reference_image = images[0]
    if reference == "median":
        reference_image = _median_reference(images)

    total_x = 0
    total_y = 0
    previous = images[0]
    for index, (frame, image) in enumerate(zip(frames, images)):
        if index == 0:
            report.shifts.append(Shift(str(frame.get("id") or index), 0, 0, 1.0, True, "参考帧"))
            continue

        base = previous if reference == "previous" else reference_image
        dx, dy, score = phase_shift(base, image, max_shift=max_shift)

        if reference == "previous":
            total_x += dx
            total_y += dy
            comp_x, comp_y = -total_x, -total_y
        else:
            comp_x, comp_y = -dx, -dy
        previous = image

        if score < confidence:
            report.shifts.append(
                Shift(str(frame.get("id") or index), comp_x, comp_y, score, False, "置信度不足")
            )
            continue
        if max(abs(comp_x), abs(comp_y)) > max_shift:
            report.shifts.append(
                Shift(str(frame.get("id") or index), comp_x, comp_y, score, False, "超过最大位移")
            )
            continue

        report.shifts.append(
            Shift(str(frame.get("id") or index), int(comp_x), int(comp_y), score, True)
        )

    if report.shifts and not any(item.applied and (item.dx or item.dy) for item in report.shifts):
        report.warnings.append("没有检测到需要补偿的位移（或所有帧都低于置信度阈值）")
    return report


def apply_offsets(frames: list[dict[str, Any]], report: AlignReport) -> list[dict[str, Any]]:
    """把补偿位移写回帧字典（返回新列表，不原地修改）。"""
    by_id = {item.frameId: item for item in report.shifts}
    out: list[dict[str, Any]] = []
    for index, frame in enumerate(frames):
        item = by_id.get(str(frame.get("id") or index))
        updated = dict(frame)
        if item and item.applied:
            updated["offsetX"] = int(updated.get("offsetX") or 0) + item.dx
            updated["offsetY"] = int(updated.get("offsetY") or 0) + item.dy
        out.append(updated)
    return out


def jitter_metric(images: Sequence[Image.Image]) -> dict[str, float]:
    """相邻帧平均绝对差：越小越稳，用于对齐前后对比。"""
    if len(images) < 2:
        return {"mean_abs": 0.0, "max_abs": 0.0}
    values: list[float] = []
    previous = _gray(images[0])
    for image in images[1:]:
        current = _gray(image)
        if current.shape != previous.shape:
            break
        values.append(float(np.abs(current - previous).mean()))
        previous = current
    if not values:
        return {"mean_abs": 0.0, "max_abs": 0.0}
    return {"mean_abs": round(float(np.mean(values)), 3), "max_abs": round(float(np.max(values)), 3)}
