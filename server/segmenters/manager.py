"""分割引擎的进程内单例管理 + 请求编排。

约束与放大引擎一致：一台机器只有一张显卡，同一时刻只保留一个分割引擎的权重；
切换模型时先卸载旧的。显存不够时由 main.py 先让出生成/放大引擎的显存。
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

import numpy as np
from PIL import Image

from .. import config as app_config
from . import engines, maskops, registry
from .errors import SegmentError

__all__ = ["SegmentError", "SegmentManager", "get_manager"]


Progress = Callable[[float, str], None] | None


class SegmentManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._engines: dict[str, Any] = {}
        self._last_used = 0.0

    # ------------------------------------------------------------- 引擎池
    def get(self, spec: dict[str, Any], cfg: dict[str, Any]):
        model_id = spec["id"]
        with self._lock:
            for other, engine in list(self._engines.items()):
                if other != model_id and engine.loaded:
                    try:
                        engine.unload()
                    except Exception:  # noqa: BLE001
                        pass
                    self._engines.pop(other, None)
            engine = self._engines.get(model_id)
            if engine is not None:
                return engine
            path = registry.model_path(spec, cfg)
            if not path:
                raise SegmentError("分割模型未就绪，请稍后重试",
                                   code="model_not_ready", status=503)
            engine = engines.build_engine(spec, path, cfg)
            self._engines[model_id] = engine
            return engine

    def status(self) -> dict[str, Any]:
        with self._lock:
            loaded = {name: bool(engine.loaded) for name, engine in self._engines.items()}
        return {"loaded": loaded, "last_used": self._last_used}

    def free(self, unload: bool = True) -> None:
        with self._lock:
            if not unload:
                engines._empty_cache()
                return
            for name, engine in list(self._engines.items()):
                try:
                    engine.unload()
                except Exception:  # noqa: BLE001
                    pass
                self._engines.pop(name, None)

    def maybe_unload(self, idle_seconds: float,
                     cfg: dict[str, Any] | None = None) -> list[str]:
        cfg = cfg or app_config.load_config()
        minutes = float((cfg.get("segment") or {}).get("idle_unload_minutes") or 0)
        if minutes <= 0 or idle_seconds < minutes * 60:
            return []
        with self._lock:
            loaded = [name for name, engine in self._engines.items() if engine.loaded]
        if loaded:
            self.free(unload=True)
        return loaded

    # --------------------------------------------------------------- 编排
    def segment(self, image: Image.Image, *, model: str | None = None,
                mode: str = "subject", box=None, points=None, text: str = "",
                multi: bool = False, max_side: int = 0,
                progress: Progress = None) -> dict[str, Any]:
        cfg = app_config.load_config()
        seg = cfg.get("segment") or {}
        spec = registry.pick_model(cfg, mode, model)

        width, height = image.size
        maskops.check_image_size(width, height)

        limit = int(max_side or seg.get("max_side") or 2048)
        limit = max(256, min(maskops.MAX_SIDE, limit))
        scale = 1.0
        infer = image
        if max(width, height) > limit:
            scale = limit / float(max(width, height))
            infer = image.resize(
                (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
                Image.LANCZOS)

        ibox = None
        box_xyxy = None
        if mode == "box":
            box_xyxy = maskops.validate_box(box, width, height)
            ibox = tuple(value * scale for value in box_xyxy)
        ipts = None
        if mode == "points":
            pts = maskops.validate_points(points, width, height)
            ipts = [(x * scale, y * scale, label) for x, y, label in pts]
        if mode == "text" and not str(text or "").strip():
            raise SegmentError("请填写要选取的主体描述", code="invalid_field", status=400)

        started = time.time()
        if progress:
            progress(0.15, "加载分割模型")
        engine = self.get(spec, cfg)
        if progress:
            progress(0.35, "准备推理")
        try:
            raw = engine.segment(infer, mode=mode, box=ibox, points=ipts,
                                 text=text, multi=multi, progress=progress)
        except SegmentError:
            raise
        except Exception as exc:  # noqa: BLE001 - CUDA OOM / 推理异常统一收口
            engine.unload()
            message = str(exc)
            if "out of memory" in message.lower():
                raise SegmentError(
                    "显存不足，已卸载分割模型；请先释放显存或改用更小的 max_side",
                    code="model_busy", status=503) from exc
            raise SegmentError(f"主体分割失败：{exc}",
                               code="segmentation_failed", status=500) from exc

        if progress:
            progress(0.8, "后处理蒙版")
        candidates = self._postprocess(raw, mode, multi, width, height,
                                       box_xyxy, int(seg.get("max_candidates") or 8))
        if not candidates:
            raise SegmentError("未识别到主体，请改用框选或点选",
                               code="no_subject", status=422)

        elapsed_ms = int((time.time() - started) * 1000)
        timeout = int(seg.get("timeout_s") or 30)
        if timeout > 0 and elapsed_ms > timeout * 1000:
            raise SegmentError("分割超时，请重试",
                               code="segmentation_timeout", status=504)
        self._last_used = time.time()
        return {
            "model": spec["id"],
            "mode": mode,
            "masks": candidates,
            "elapsed_ms": elapsed_ms,
        }

    def _postprocess(self, raw: list[dict[str, Any]], mode: str, multi: bool,
                     width: int, height: int, box_xyxy, max_candidates: int
                     ) -> list[dict[str, Any]]:
        limit = max(1, int(max_candidates)) if multi else 1
        min_area = max(64, int(width * height * 0.001))
        candidates: list[dict[str, Any]] = []
        for item in raw or []:
            prob = maskops.resize_float(item.get("mask"), width, height)
            binary = maskops.binarize(prob, 0.5)
            if mode == "box" and box_xyxy is not None:
                binary = maskops.clip_to_box(binary, box_xyxy)
                prob = np.where(binary, prob, 0.0).astype(np.float32)
            if not binary.any():
                continue
            if mode == "subject" and multi:
                # 显著性模型只给一张概率图：按连通域拆成多个主体
                for part in maskops.components(binary, min_area=min_area):
                    sub = np.where(part, prob, 0.0).astype(np.float32)
                    candidates.append({
                        "mask": sub,
                        "score": float(prob[part].mean()) if part.any() else 0.0,
                    })
                continue
            candidates.append({
                "mask": prob,
                "score": float(item.get("score") or prob[binary].mean()),
            })

        candidates.sort(key=lambda item: float(item["score"]), reverse=True)
        out: list[dict[str, Any]] = []
        for item in candidates[:limit]:
            binary = maskops.binarize(item["mask"], 0.5)
            if not binary.any():
                continue
            area, box = maskops.mask_info(binary)
            out.append({
                "mask": item["mask"],
                "score": round(float(item["score"]), 4),
                "box": box,
                "area": area,
            })
        return out


_MANAGER: SegmentManager | None = None
_MANAGER_LOCK = threading.Lock()


def get_manager() -> SegmentManager:
    global _MANAGER
    if _MANAGER is None:
        with _MANAGER_LOCK:
            if _MANAGER is None:
                _MANAGER = SegmentManager()
    return _MANAGER
