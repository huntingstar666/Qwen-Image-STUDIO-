"""主体分割模型的目录推断、扫描与选择。

模型仍是**数据**：目录与文件名来自 ``config.json`` 的 ``segment`` 段；
目录留空时按 ComfyUI 约定推断（``model_root/checkpoints``、
``model_root/background_removal``），首次启动即可复用用户已有的 ComfyUI 模型目录。
"""

from __future__ import annotations

import json
import os
from typing import Any

from .. import config as app_config
from .errors import SegmentError

SEGMENT_EXTS = (".safetensors", ".pth", ".pt", ".ckpt", ".bin")
_MB = 1024 * 1024

#: 引擎（一个引擎 = 一套权重 + 一种推理实现）
ENGINES: dict[str, dict[str, Any]] = {
    "sam3": {
        "id": "sam3",
        "label": "SAM 3.1（点 / 框 / 文字）",
        "default_dir": "checkpoints",
        "keywords": ("sam3",),
        "min_mb": 200,
        "missing_label": "SAM 3.1 权重",
    },
    "birefnet": {
        "id": "birefnet",
        "label": "BiRefNet（显著性主体）",
        "default_dir": "background_removal",
        "keywords": ("biref",),
        "min_mb": 50,
        "missing_label": "BiRefNet 权重",
    },
}

#: 对外暴露的模型清单；``kind`` 与契约一致：subject / prompt / text
MODEL_SPECS: list[dict[str, Any]] = [
    {
        "id": "sam3.1-multiplex",
        "engine": "sam3",
        "label": "SAM 3.1 Multiplex",
        "kind": "prompt",
        "modes": ("box", "points", "text"),
        "vram_mb": 6500,
    },
    {
        "id": "birefnet",
        "engine": "birefnet",
        "label": "BiRefNet 主体",
        "kind": "subject",
        "modes": ("subject",),
        "vram_mb": 3000,
    },
]

#: 模式要求的最小可见性（用于 /api/options 的能力声明）
MODES = ("subject", "box", "points", "text")


def section(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or app_config.load_config()
    return cfg.get("segment") or {}


def resolve_dirs(cfg: dict[str, Any] | None = None) -> dict[str, str]:
    """解析两个引擎的模型目录；未配置时按 model_root 推断。"""
    cfg = cfg or app_config.load_config()
    seg = section(cfg)
    root = str(cfg.get("model_root") or "")
    dirs = seg.get("dirs") or {}
    out: dict[str, str] = {}
    for name, meta in ENGINES.items():
        default = os.path.join(root, meta["default_dir"]) if root else ""
        value = str(dirs.get(name) or "").strip() or default
        out[name] = (
            os.path.normpath(os.path.expandvars(os.path.expanduser(value))) if value else ""
        )
    return out


def _files(directory: str, meta: dict[str, Any]) -> list[dict[str, Any]]:
    if not directory or not os.path.isdir(directory):
        return []
    items: list[dict[str, Any]] = []
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    for name in names:
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() not in SEGMENT_EXTS:
            continue
        low = name.lower()
        if meta.get("keywords") and not any(k in low for k in meta["keywords"]):
            continue
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        items.append({
            "name": name,
            "size": size,
            "size_gb": round(size / (1024 ** 3), 2),
            # 明显不完整（下载中断）的权重不标可用，避免加载时才炸
            "ready": size > 0 and size >= int(meta.get("min_mb") or 0) * _MB,
        })
    return items


def scan_engine(engine_id: str, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """扫描单个引擎：目录、候选文件、当前选中的权重与就绪状态。"""
    cfg = cfg or app_config.load_config()
    meta = ENGINES[engine_id]
    seg = section(cfg)
    directory = resolve_dirs(cfg).get(engine_id, "")
    files = _files(directory, meta)
    pref = seg.get(engine_id) or {}
    selected = str(pref.get("model") or "").strip()
    if not selected:
        selected = _default_file(engine_id)
    selected_file = next((f for f in files if f["name"] == selected), None)
    ready = bool(selected_file and selected_file.get("ready"))
    missing: list[str] = []
    if not directory or not os.path.isdir(directory):
        missing.append("模型目录")
    elif not files:
        missing.append(meta["missing_label"])
    elif not ready:
        missing.append(selected or meta["missing_label"])
    return {
        "id": engine_id,
        "label": meta["label"],
        "dir": directory,
        "exists": bool(directory) and os.path.isdir(directory),
        "files": files,
        "selected": selected,
        "selected_size_gb": (selected_file or {}).get("size_gb"),
        "ready": ready,
        "missing": missing,
    }


def _default_file(engine_id: str) -> str:
    return {
        "sam3": "sam3.1_multiplex_fp16.safetensors",
        "birefnet": "birefnet.safetensors",
    }.get(engine_id, "")


def model_path(spec: dict[str, Any], cfg: dict[str, Any] | None = None) -> str | None:
    """解析模型权重的绝对路径；文件不存在返回 ``None``。"""
    cfg = cfg or app_config.load_config()
    scan = scan_engine(spec["engine"], cfg)
    name = scan.get("selected") or ""
    if not name:
        return None
    if os.path.isabs(name):
        return name if os.path.isfile(name) else None
    path = os.path.join(scan["dir"], name)
    return path if os.path.isfile(path) else None


def engine_ready(engine_id: str, cfg: dict[str, Any] | None = None) -> bool:
    return bool(scan_engine(engine_id, cfg).get("ready"))


def _spec(model_id: str) -> dict[str, Any] | None:
    return next((item for item in MODEL_SPECS if item["id"] == model_id), None)


def pick_model(cfg: dict[str, Any] | None, mode: str,
               requested: str | None = None) -> dict[str, Any]:
    """按请求的模式挑一个可用模型；不可用时抛带错误码的 ``SegmentError``。"""
    cfg = cfg or app_config.load_config()
    seg = section(cfg)
    if requested:
        spec = _spec(str(requested))
        if spec is None:
            raise SegmentError(f"未知的分割模型：{requested}", code="invalid_model", status=400)
        if mode not in spec["modes"]:
            raise SegmentError(
                f"{spec['label']} 不支持 {mode} 模式", code="invalid_mode", status=400)
        if not engine_ready(spec["engine"], cfg):
            raise SegmentError("分割模型未就绪，请稍后重试",
                               code="model_not_ready", status=503)
        return spec

    preferred = str(seg.get("default_model") or "").strip()
    order: list[str] = []
    if preferred:
        order.append(preferred)
    # 默认优先级：subject 先 BiRefNet，其余先 SAM 3.1（MODEL_SPECS 顺序即此意）
    order.extend(spec["id"] for spec in MODEL_SPECS if mode in spec["modes"])
    for model_id in dict.fromkeys(order):
        spec = _spec(model_id)
        if not spec or mode not in spec["modes"]:
            continue
        if engine_ready(spec["engine"], cfg):
            return spec
    if mode == "text":
        raise SegmentError("当前未启用文字选主体", code="not_implemented", status=501)
    raise SegmentError("分割模型未就绪，请稍后重试", code="model_not_ready", status=503)


def scan_all(cfg: dict[str, Any] | None = None,
             loaded: dict[str, bool] | None = None) -> dict[str, Any]:
    """``GET /api/image/segment/models`` 的数据源。"""
    cfg = cfg or app_config.load_config()
    loaded = loaded or {}
    engines = {name: scan_engine(name, cfg) for name in ENGINES}
    models: list[dict[str, Any]] = []
    for spec in MODEL_SPECS:
        scan = engines[spec["engine"]]
        models.append({
            "id": spec["id"],
            "label": spec["label"],
            "kind": spec["kind"],
            "modes": list(spec["modes"]),
            "ready": bool(scan.get("ready")),
            "loaded": bool(loaded.get(spec["id"])),
            "vram_mb": int(spec["vram_mb"]),
            "file": scan.get("selected"),
            "size_gb": scan.get("selected_size_gb"),
            "missing": scan.get("missing") or [],
        })
    default = _pick_default(cfg, models)
    return {
        "models": models,
        "default": default,
        "engines": engines,
        "dirs": resolve_dirs(cfg),
        "ready": any(item["ready"] for item in models),
    }


def _pick_default(cfg: dict[str, Any], models: list[dict[str, Any]]) -> str:
    configured = str(section(cfg).get("default_model") or "").strip()
    by_id = {item["id"]: item for item in models}
    if configured and by_id.get(configured, {}).get("ready"):
        return configured
    for item in models:
        if item["ready"]:
            return item["id"]
    return models[0]["id"] if models else ""


def normalize_section(current: dict[str, Any], raw: Any) -> dict[str, Any]:
    """校验并合并设置页提交的 ``segment`` 段（纯函数，便于测试）。"""
    from . import maskops

    if not isinstance(raw, dict):
        raise SegmentError("segment 必须是对象", code="invalid_field", status=400)
    out = json.loads(json.dumps(current or {}))
    if "dirs" in raw:
        if not isinstance(raw.get("dirs"), dict):
            raise SegmentError("segment.dirs 必须是对象", code="invalid_field", status=400)
        dirs = dict(out.get("dirs") or {})
        for name in ENGINES:
            if name not in raw["dirs"]:
                continue
            text = str(raw["dirs"].get(name) or "").strip()
            dirs[name] = (
                os.path.normpath(os.path.expandvars(os.path.expanduser(text)))
                if text else ""
            )
        out["dirs"] = dirs

    for name in ENGINES:
        if name not in raw:
            continue
        if not isinstance(raw.get(name), dict):
            raise SegmentError(f"segment.{name} 必须是对象",
                               code="invalid_field", status=400)
        merged = {**(out.get(name) or {}), **(raw.get(name) or {})}
        merged["model"] = str(merged.get("model") or "").strip()
        out[name] = merged

    sam3 = out.get("sam3") or {}
    try:
        threshold = float(sam3.get("threshold", 0.5))
        refine = int(sam3.get("refine_iterations", 2))
    except (TypeError, ValueError) as exc:
        raise SegmentError("segment.sam3 的阈值/细化次数必须是数字",
                           code="invalid_field", status=400) from exc
    if not 0.0 <= threshold <= 1.0:
        raise SegmentError("segment.sam3.threshold 必须在 0–1 之间",
                           code="invalid_field", status=400)
    if not 0 <= refine <= 5:
        raise SegmentError("segment.sam3.refine_iterations 必须在 0–5 之间",
                           code="invalid_field", status=400)
    out["sam3"] = {**sam3, "threshold": round(threshold, 3),
                   "refine_iterations": refine}

    if "default_model" in raw:
        value = str(raw.get("default_model") or "").strip()
        known = {spec["id"] for spec in MODEL_SPECS}
        if value and value not in known:
            raise SegmentError("segment.default_model 不在可选分割模型里",
                               code="invalid_field", status=400)
        out["default_model"] = value

    for key, low, high in (
        ("max_side", 256, maskops.MAX_SIDE),
        ("max_candidates", 1, 8),
        ("timeout_s", 5, 120),
        ("idle_unload_minutes", 0, 1440),
    ):
        if key not in raw:
            continue
        try:
            number = int(raw.get(key))
        except (TypeError, ValueError) as exc:
            raise SegmentError(f"segment.{key} 必须是整数",
                               code="invalid_field", status=400) from exc
        if not low <= number <= high:
            raise SegmentError(f"segment.{key} 必须在 {low}–{high} 之间",
                               code="invalid_field", status=400)
        out[key] = number
    return out
