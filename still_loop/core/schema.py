from __future__ import annotations

from typing import Any

from .. import config

PRESERVE_DEFAULT = ["人物身份", "发型", "服装", "背景", "镜头构图"]


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _float(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _choice(value: Any, default: str, options: tuple[str, ...]) -> str:
    text = str(value or "").strip().lower()
    return text if text in options else default


def normalize_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    check = raw.get("check") if isinstance(raw.get("check"), dict) else {}
    export = raw.get("export") if isinstance(raw.get("export"), dict) else {}
    quality = raw.get("quality") if isinstance(raw.get("quality"), dict) else {}
    motion = raw.get("motion") if isinstance(raw.get("motion"), dict) else {}
    timeline = raw.get("timeline") if isinstance(raw.get("timeline"), dict) else {}
    raw_holds = timeline.get("holds")
    holds = [_int(item, 1, 1, 6) for item in (raw_holds if isinstance(raw_holds, list) else [])][:48]
    preserve = raw.get("preserve")
    if not isinstance(preserve, list) or not preserve:
        preserve = list(PRESERVE_DEFAULT)
    preserve = [str(item).strip() for item in preserve if str(item).strip()][:12]
    settings = {
        "frames": _int(raw.get("frames"), config.DEFAULT_FRAMES, 2, 48),
        "size": _int(raw.get("size"), config.DEFAULT_SIZE, 256, 1024),
        # 画布尺寸：不填时按 size 出正方形；填了就按宽高出非方形（如 19:9 的 1216×576）。
        "width": _int(raw.get("width"), 0, 0, 1536),
        "height": _int(raw.get("height"), 0, 0, 1536),
        "steps": _int(raw.get("steps"), 8, 1, 100),
        "cfg": _float(raw.get("cfg"), 1.0, 0.0, 30.0),
        "denoise": _float(raw.get("denoise"), 1.0, 0.05, 1.0),
        "turbo": bool(raw.get("turbo", True)),
        # 一致性 LoRA 会强力锁住主体形态：做「动作/微调」要开，做「成长/变形」必须关，
        # 否则模型只肯在同一张图上做几十个像素的改动。
        "consistency": bool(raw.get("consistency", True)),
        "seed": _int(raw.get("seed"), 20261107, -1, 2**31 - 1),
        "max_retries": _int(raw.get("max_retries"), config.DEFAULT_MAX_RETRIES, 1, 5),
        "seamless": bool(raw.get("seamless", False)),
        "engine": "main" if raw.get("engine") == "main" else "mock",
        "model": str(raw.get("model") or config.EDIT_MODEL).strip() or config.EDIT_MODEL,
        "preset": str(raw.get("preset") or "").strip(),
        # 背景策略：fixed = 主体画在品红键控背景上、本地抠 alpha 再合成固定背景板；
        # plain = 整幅重绘（旧行为）；auto = 成长/变形叙事用 fixed，其余 plain。
        "background": _choice(raw.get("background"), "auto",
                              ("auto", "plain", "fixed")),
        # 接力方式：chain = 每帧基于上一帧（连续动作）；independent = 每帧都从参考图出发
        # （同一主体换季节/换配色/换状态时更稳，不会把上一帧的噪声带下去）。
        "relay": _choice(raw.get("relay"), "chain", ("chain", "independent")),
        "style": _choice(raw.get("style"), "", config.HANDMADE_STYLES),
        "preserve": preserve or list(PRESERVE_DEFAULT),
        "timeline": {
            "fps": _int(timeline.get("fps"), config.DEFAULT_FPS, 4, 30),
            "holds": holds,
        },
        "motion": {
            "preset": _choice(motion.get("preset"), "both", config.MOTION_PRESETS),
            "fps": _int(motion.get("fps"), config.DEFAULT_STOPMOTION_FPS, 4, 24),
            "hold": _int(motion.get("hold"), config.DEFAULT_HOLD, 1, 6),
            "jitter": _float(motion.get("jitter"), 1.2, 0.0, 8.0),
            "grain": _float(motion.get("grain"), 0.06, 0.0, 0.3),
            "vignette": _float(motion.get("vignette"), 0.18, 0.0, 0.8),
            "color_boil": _float(motion.get("color_boil"), 0.03, 0.0, 0.2),
        },
        "export": {
            "format": _choice(export.get("format"), "gif", config.EXPORT_FORMATS),
            "dither": bool(export.get("dither", True)),
            # 去抖动/去闪烁要走 animation_kit 服务（8710），默认关，离线可用。
            "align": bool(export.get("align", False)),
            "color_match": bool(export.get("color_match", False)),
        },
        "quality": {
            "require_size_match": bool(quality.get("require_size_match", True)),
            "max_outside": _float(quality.get("max_outside"), 24.0, 0.0, 255.0),
        },
        "check": {
            "min_change": _float(check.get("min_change"), 0.002, 0.0, 1.0),
            "max_change": _float(check.get("max_change"), 0.35, 0.001, 1.0),
            "min_ssim": _float(check.get("min_ssim"), 0.40, 0.0, 1.0),
            "max_mae": _float(check.get("max_mae"), 55.0, 0.0, 255.0),
            "min_hist": _float(check.get("min_hist"), 0.35, -1.0, 1.0),
            "min_ref_hist": _float(check.get("min_ref_hist"), 0.55, -1.0, 1.0),
            "max_ref_color_delta": _float(check.get("max_ref_color_delta"), 18.0, 0.0, 255.0),
            "min_loop_ssim": _float(check.get("min_loop_ssim"), 0.35, 0.0, 1.0),
        },
    }
    width = settings["width"] or settings["size"]
    height = settings["height"] or settings["size"]
    settings["width"] = max(256, min(1536, int(round(width / 32.0)) * 32))
    settings["height"] = max(256, min(1536, int(round(height / 32.0)) * 32))
    return settings


def preserve_text(settings: dict[str, Any]) -> str:
    items = settings.get("preserve") or PRESERVE_DEFAULT
    if len(items) == 1:
        return str(items[0])
    return "、".join(str(item) for item in items)


def default_check() -> dict[str, Any]:
    return normalize_settings({})["check"]
