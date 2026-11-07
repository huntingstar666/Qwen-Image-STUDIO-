"""色彩一致 / 去闪烁：逐通道 gain + offset 仿射匹配。

这是主项目「零色差」方案里 ``CropRestore`` 的简化版：

* 只在「变化不大」的像素上统计，避免把主体的颜色带进参考；
* 增益夹在 0.9~1.1、偏移夹在 ±24 个色阶，防止通道断层；
* **alpha 通道逐字节保持不变**，透明边缘不会被改坏；
* 默认只作用于不透明主体（``scope=subject``），背景像素原样保留。

定格动画逐帧重拍/逐帧生成时，灯光、色温、模型随机性都会造成整体明暗跳动，
这里的全局仿射匹配是最稳、最不会产生局部色块的做法。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
from PIL import Image

from . import images as image_utils

GAIN_LIMITS = (0.9, 1.1)
OFFSET_LIMIT = 24.0


@dataclass
class ColorStats:
    frameId: str
    gain: list[float]
    offset: list[float]
    samples: int
    clamped: bool = False


@dataclass
class ColorReport:
    reference: str
    strength: float
    scope: str
    stats: list[ColorStats] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "reference": self.reference,
            "strength": self.strength,
            "scope": self.scope,
            "stats": [item.__dict__ for item in self.stats],
            "warnings": self.warnings,
        }


def _rgba(image: Image.Image) -> np.ndarray:
    return np.asarray(image_utils.ensure_rgba(image), dtype=np.float32)


def _mask_of(array: np.ndarray, scope: str) -> np.ndarray:
    if scope == "full":
        return np.ones(array.shape[:2], dtype=bool)
    return array[..., 3] > 8


def _stats(rgb: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    values = rgb[mask]
    if values.size == 0:
        return np.array([128.0, 128.0, 128.0], dtype=np.float32), np.ones(3, dtype=np.float32), 0
    mean = values.mean(axis=0)
    std = values.std(axis=0)
    std = np.maximum(std, 1e-3)
    return mean.astype(np.float32), std.astype(np.float32), int(values.shape[0])


def _match_arrays(
    source: np.ndarray,
    reference: np.ndarray,
    *,
    strength: float,
    scope: str,
    diff_threshold: float = 24.0,
    gain_limits: tuple[float, float] = GAIN_LIMITS,
    offset_limit: float = OFFSET_LIMIT,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, bool]:
    """返回 (输出 RGBA, gain, offset, 采样数, 是否触发夹取)。"""
    if source.shape != reference.shape:
        raise ValueError("色彩匹配要求两张图尺寸一致")

    src_rgb = source[..., :3]
    ref_rgb = reference[..., :3]
    scope_mask = _mask_of(source, scope)
    alpha_ref = reference[..., 3] > 8

    # 只在「本来就很接近」的像素上统计，避免把主体变化误判成整体偏色
    diff = np.abs(src_rgb - ref_rgb).max(axis=2)
    candidates = scope_mask & alpha_ref & (diff <= float(diff_threshold))
    if int(candidates.sum()) < 64:
        candidates = scope_mask & alpha_ref
    if int(candidates.sum()) < 8:
        candidates = scope_mask

    src_mean, src_std, _ = _stats(src_rgb, candidates)
    ref_mean, _, samples = _stats(ref_rgb, candidates)
    # 逐通道最小二乘：gain = cov / var（这里用 std 比近似，稳定性更好）
    gain = ref_rgb[candidates].std(axis=0) / np.maximum(src_std, 1e-3) if samples else np.ones(3)
    gain = np.clip(gain, gain_limits[0], gain_limits[1])
    offset = ref_mean - src_mean * gain
    clamped = bool(np.any(gain <= gain_limits[0] + 1e-6) or np.any(gain >= gain_limits[1] - 1e-6)
                   or np.any(np.abs(offset) >= offset_limit - 1e-6))
    offset = np.clip(offset, -offset_limit, offset_limit)

    strength = float(max(0.0, min(1.0, strength)))
    corrected = np.clip(src_rgb * (1.0 + strength * (gain - 1.0))
                        + strength * offset, 0.0, 255.0)

    out = source.copy()
    if scope == "full":
        out[..., :3] = corrected
    else:
        weight = np.clip(source[..., 3:4] / 255.0, 0.0, 1.0)
        out[..., :3] = src_rgb * (1.0 - weight) + corrected * weight
    # alpha 原样保留（source 未改动 alpha）
    return out, gain, offset, samples, clamped


def match_frame(frame: dict[str, Any], source: Image.Image, reference: Image.Image, *,
                strength: float = 0.8, scope: str = "subject") -> tuple[Image.Image, ColorStats]:
    src = _rgba(source)
    ref = _rgba(reference)
    out, gain, offset, samples, clamped = _match_arrays(
        src, ref, strength=strength, scope=scope,
    )
    image = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGBA")
    stats = ColorStats(
        frameId=str(frame.get("id") or ""),
        gain=[round(float(value), 4) for value in gain],
        offset=[round(float(value), 2) for value in offset],
        samples=int(samples),
        clamped=clamped,
    )
    return image, stats


def deflicker(
    frames: Sequence[dict[str, Any]],
    images: Sequence[Image.Image],
    *,
    reference: str = "median",
    strength: float = 0.8,
    scope: str = "subject",
) -> tuple[list[Image.Image], ColorReport]:
    """按全片统计量做统一匹配，消除逐帧明暗/色温跳动。

    ``reference=median`` 用各帧均值/标准差的逐通道中位数作为目标，
    比选某一帧更不容易把某一帧的偏色扩散到全片。
    """
    if len(frames) != len(images):
        raise ValueError("frames 与 images 数量不一致")
    report = ColorReport(reference=reference, strength=strength, scope=scope)
    if not images:
        return [], report

    arrays = [_rgba(image) for image in images]
    means: list[np.ndarray] = []
    stds: list[np.ndarray] = []
    for array in arrays:
        mask = _mask_of(array, scope)
        if not mask.any():
            mask = np.ones(array.shape[:2], dtype=bool)
        mean, std, _ = _stats(array[..., :3], mask)
        means.append(mean)
        stds.append(std)

    if reference == "first":
        target_mean, target_std = means[0], stds[0]
    else:
        target_mean = np.median(np.stack(means, axis=0), axis=0)
        target_std = np.median(np.stack(stds, axis=0), axis=0)

    outputs: list[Image.Image] = []
    for frame, array, mean, std in zip(frames, arrays, means, stds):
        gain = target_std / np.maximum(std, 1e-3)
        gain = np.clip(gain, GAIN_LIMITS[0], GAIN_LIMITS[1])
        offset = np.clip(target_mean - mean * gain, -OFFSET_LIMIT, OFFSET_LIMIT)
        clamped = bool(np.any(gain <= GAIN_LIMITS[0] + 1e-6) or np.any(gain >= GAIN_LIMITS[1] - 1e-6))

        factor = float(max(0.0, min(1.0, strength)))
        corrected = np.clip(array[..., :3] * (1.0 + factor * (gain - 1.0))
                            + factor * offset, 0.0, 255.0)
        out = array.copy()
        if scope == "full":
            out[..., :3] = corrected
        else:
            weight = np.clip(array[..., 3:4] / 255.0, 0.0, 1.0)
            out[..., :3] = array[..., :3] * (1.0 - weight) + corrected * weight

        outputs.append(Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), mode="RGBA"))
        report.stats.append(ColorStats(
            frameId=str(frame.get("id") or ""),
            gain=[round(float(value), 4) for value in gain],
            offset=[round(float(value), 2) for value in offset],
            samples=int(array.shape[0] * array.shape[1]),
            clamped=clamped,
        ))

    wide = [item for item in report.stats if item.clamped]
    if wide:
        report.warnings.append(f"{len(wide)} 帧的校正量触及安全上限，已夹取以防通道断层")
    return outputs, report


def stats_of(image: Image.Image, scope: str = "subject") -> dict[str, Any]:
    array = _rgba(image)
    mask = _mask_of(array, scope)
    mean, std, samples = _stats(array[..., :3], mask)
    return {
        "mean": [round(float(value), 2) for value in mean],
        "std": [round(float(value), 2) for value in std],
        "samples": samples,
    }
