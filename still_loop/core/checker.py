"""逐帧代码自检：尺寸、alpha、改动幅度、SSIM、色差、直方图、首尾闭环。"""
from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

CORRECTIONS = {
    "size_mismatch": "输出尺寸必须与输入完全一致，不要裁切或缩放",
    "alpha_lost": "必须保留透明背景与 alpha 通道",
    "too_small": "改动太小：请把动作做大一些，明确改变姿势或道具状态，但保持身份与背景不变",
    "too_large": "改动过大：保持人物脸型、发型、服装、背景、构图完全不变，只改变指定动作",
    "structure_broken": "人物结构崩坏：保持五官、四肢、服装完整，只做小幅动作变化",
    "color_jump": "色调跳变：保持原有光照、色温与背景颜色",
    "color_drift": "整体色调相对参考图漂移过大：沿用原图的光照、色温与配色，不要重新调色或加滤镜",
    "subject_moved": "主体位置偏移过大：保持人物在画面中的位置与大小",
    "loop_broken": "末帧需要回到接近首帧的姿态，形成无缝循环",
    "edge_bleed": "画布边缘出现了参考图之外的新内容：不要外扩画面或改变背景范围，只改画面内部的指定动作",
}


def _flatten(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    canvas.alpha_composite(rgba)
    return canvas.convert("RGB")


def _gray(image: Image.Image) -> np.ndarray:
    return np.asarray(
        image.convert("L").resize((128, 128), Image.Resampling.BILINEAR),
        dtype=np.float64,
    )


def _ssim(first: Image.Image, second: Image.Image) -> float:
    a, b = _gray(first), _gray(second)
    mu_a, mu_b = float(a.mean()), float(b.mean())
    var_a, var_b = float(a.var()), float(b.var())
    cov = float(((a - mu_a) * (b - mu_b)).mean())
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    numerator = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    denominator = (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2)
    if denominator <= 0:
        return 1.0
    return max(-1.0, min(1.0, numerator / denominator))


def _histogram(image: Image.Image) -> np.ndarray:
    array = np.asarray(_flatten(image).resize((64, 64), Image.Resampling.BILINEAR), dtype=np.uint8)
    parts = []
    for channel in range(3):
        counts, _ = np.histogram(array[:, :, channel], bins=32, range=(0, 256))
        total = max(1, int(counts.sum()))
        parts.append(counts.astype(np.float64) / total)
    return np.concatenate(parts)


def _hist_corr(first: Image.Image, second: Image.Image) -> float:
    """直方图相似度（交集），0~1；比相关系数更抗分箱抖动。"""
    a, b = _histogram(first), _histogram(second)
    return float(np.minimum(a, b).sum() / max(1e-9, min(a.sum(), b.sum())))


def _alpha_stats(image: Image.Image) -> dict[str, Any]:
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    transparent = float((alpha < 250).mean())
    return {
        "has_channel": "A" in image.getbands() or image.mode in ("RGBA", "LA", "PA"),
        "transparent_ratio": transparent,
        "has_transparency": transparent > 0.001,
        "min": int(alpha.min()) if alpha.size else 255,
    }


def _alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    alpha = np.asarray(image.convert("RGBA").getchannel("A"), dtype=np.uint8)
    rows, cols = np.where(alpha > 8)
    if len(cols) == 0:
        return None
    return int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1


def _iou(first: tuple[int, int, int, int] | None,
         second: tuple[int, int, int, int] | None) -> float | None:
    if first is None or second is None:
        return None
    ax1, ay1, ax2, ay2 = first
    bx1, by1, bx2, by2 = second
    left, top = max(ax1, bx1), max(ay1, by1)
    right, bottom = min(ax2, bx2), min(ay2, by2)
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def _mean_rgb(image: Image.Image) -> np.ndarray:
    """平均色（0~255），用于检测跨帧累积的色彩漂移。"""
    array = np.asarray(
        _flatten(image).resize((64, 64), Image.Resampling.BILINEAR),
        dtype=np.float64,
    )
    return array.reshape(-1, 3).mean(axis=0)


def drift(anchor: Image.Image, current: Image.Image) -> dict[str, float]:
    """当前帧相对锚点（参考图）的全局色彩偏移。"""
    delta = np.abs(_mean_rgb(anchor) - _mean_rgb(current))
    return {
        "ref_hist": round(_hist_corr(anchor, current), 4),
        "ref_color_delta": round(float(delta.mean()), 3),
    }


def measure(previous: Image.Image, current: Image.Image) -> dict[str, Any]:
    a = np.asarray(_flatten(previous), dtype=np.int16)
    b = np.asarray(_flatten(current), dtype=np.int16)
    diff = np.abs(a - b)
    changed = float((diff.max(axis=2) > 12).mean())
    mae = float(diff.mean())
    alpha_a, alpha_b = _alpha_stats(previous), _alpha_stats(current)
    iou = _iou(_alpha_bbox(previous), _alpha_bbox(current)) if alpha_a["has_transparency"] else None
    return {
        "width": current.width,
        "height": current.height,
        "same_size": previous.size == current.size,
        "changed_ratio": round(changed, 6),
        "mae": round(mae, 3),
        "ssim": round(_ssim(previous, current), 4),
        "hist_corr": round(_hist_corr(previous, current), 4),
        "bbox_iou": None if iou is None else round(iou, 4),
        "prev_alpha": alpha_a,
        "alpha": alpha_b,
    }


def _band_hit(value: float, low: float, high: float) -> float:
    if low <= value <= high:
        return 1.0
    distance = low - value if value < low else value - high
    return max(0.0, 1.0 - distance / 0.2)


def check(previous: Image.Image, current: Image.Image, frame: dict[str, Any],
          settings: dict[str, Any], *, is_last: bool = False,
          first: Image.Image | None = None,
          anchor: Image.Image | None = None,
          quality: dict[str, Any] | None = None) -> dict[str, Any]:
    thresholds = settings["check"]
    metrics = measure(previous, current)
    low = float(frame.get("min_change", thresholds["min_change"]))
    high = float(frame.get("max_change", thresholds["max_change"]))
    reasons: list[str] = []

    if not metrics["same_size"]:
        reasons.append("size_mismatch")

    prev_alpha = metrics["prev_alpha"]
    if prev_alpha["has_transparency"] and not metrics["alpha"]["has_transparency"]:
        reasons.append("alpha_lost")

    changed = float(metrics["changed_ratio"])
    # 硬门槛只用全局安全阈值：LLM 给的 min/max 是“预期幅度”，只影响评分，
    # 不直接判失败。真实编辑会整图重绘，像素改动比例天然偏高。
    hard_low = max(0.0015, thresholds["min_change"])
    hard_high = max(0.60, thresholds["max_change"])
    if changed < hard_low:
        reasons.append("too_small")
    if changed > hard_high:
        reasons.append("too_large")
    if metrics["ssim"] < thresholds["min_ssim"]:
        reasons.append("structure_broken")
    if metrics["mae"] > thresholds["max_mae"]:
        reasons.append("color_jump")
    if metrics["hist_corr"] < thresholds["min_hist"]:
        reasons.append("color_jump")
    if metrics["bbox_iou"] is not None and metrics["bbox_iou"] < 0.35:
        reasons.append("subject_moved")

    # 跨帧累积漂移：单帧对比上一帧可能都觉得“还好”，但十几帧后整体偏色会很明显，
    # 所以额外与参考图比一次全局色彩。
    if anchor is not None:
        metrics.update(drift(anchor, current))
        if metrics["ref_hist"] < thresholds["min_ref_hist"]:
            reasons.append("color_drift")
        if metrics["ref_color_delta"] > thresholds["max_ref_color_delta"]:
            reasons.append("color_drift")

    # 主项目 /api/edit 会回执 job.quality：尺寸是否与画布一致、画布外改动多少。
    # 这两项只有真实引擎才给，Mock 不传，因此保持 None 时不参与判定。
    rules = settings.get("quality") or {}
    if quality:
        metrics["q_size_match"] = bool(quality.get("size_match", True))
        outside = quality.get("outside_max_abs")
        metrics["q_outside_max_abs"] = outside
        if rules.get("require_size_match", True) and not metrics["q_size_match"]:
            reasons.append("size_mismatch")
        if isinstance(outside, (int, float)) and outside > float(rules.get("max_outside", 24.0)):
            reasons.append("edge_bleed")

    warnings: list[str] = []
    if changed < low:
        warnings.append("below_expected_band")
    elif changed > high:
        warnings.append("above_expected_band")

    if is_last and settings.get("seamless") and first is not None:
        loop_ssim = _ssim(first, current)
        metrics["first_last_ssim"] = round(loop_ssim, 4)
        if loop_ssim < thresholds["min_loop_ssim"]:
            reasons.append("loop_broken")

    reasons = list(dict.fromkeys(reasons))
    band = _band_hit(changed, low, high)
    score = (
        0.35 * max(0.0, metrics["ssim"])
        + 0.25 * max(0.0, metrics["hist_corr"])
        + 0.25 * max(0.0, 1.0 - metrics["mae"] / 255.0)
        + 0.15 * band
    )
    messages = [CORRECTIONS[reason] for reason in reasons if reason in CORRECTIONS]
    return {
        "verdict": "pass" if not reasons else "fail",
        "reasons": reasons,
        "messages": messages,
        "warnings": warnings,
        "hint": "；".join(messages),
        "metrics": metrics,
        "score": round(score, 4),
        "band": {"min": low, "max": high},
    }


def correction_text(result: dict[str, Any]) -> str:
    if not result.get("reasons"):
        return ""
    lines = [CORRECTIONS[reason] for reason in result["reasons"] if reason in CORRECTIONS]
    return "；".join(dict.fromkeys(lines))
