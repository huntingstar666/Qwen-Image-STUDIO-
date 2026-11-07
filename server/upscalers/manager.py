"""放大引擎的进程内单例管理。

约束：一台机器只有一张显卡，同一时刻只保留一个放大引擎的权重；
切换引擎时先把旧引擎卸载，避免 SeedVR2 7B 与 FlashVSR 同时抢显存。
"""

from __future__ import annotations

import threading
import time
from typing import Any

from .. import config as app_config
from . import registry
from .base import UpscaleCancelled, UpscaleError
from .flashvsr_runner import FlashVSREngine
from .seedvr2_runner import SeedVR2Engine
from .vosr2_api import VOSR2ComfyEngine

__all__ = [
    "UpscalerManager",
    "get_manager",
    "UpscaleError",
    "UpscaleCancelled",
]


class UpscalerManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._engines: dict[str, Any] = {}
        self._last_used = 0.0

    # ------------------------------------------------------------- factories
    def _build(self, name: str, cfg: dict[str, Any]) -> Any:
        up = registry.section(cfg)
        dirs = registry.resolve_dirs(cfg)
        if name == "seedvr2":
            pref = up.get("seedvr2") or {}
            return SeedVR2Engine(
                dirs["seedvr2"],
                dit_model=str(pref.get("dit") or "seedvr2_ema_7b_fp8_e4m3fn.safetensors"),
                vae_model=str(pref.get("vae") or "ema_vae_fp16.safetensors"),
                vae_tiled=bool(pref.get("vae_tiled", True)),
                attention_mode=str(pref.get("attention_mode") or "sdpa"),
                offload_device=str(pref.get("offload_device") or "cpu"),
            )
        if name == "flashvsr":
            pref = up.get("flashvsr") or {}
            return FlashVSREngine(
                dirs["flashvsr"],
                precision=str(pref.get("precision") or "bf16"),
            )
        if name == "vosr2":
            pref = up.get("vosr2") or {}
            return VOSR2ComfyEngine(
                url=str(pref.get("url") or "http://127.0.0.1:8188"),
                settings=pref,
                bundle=str(pref.get("model_bundle") or "VOSR2"),
                precision=str(pref.get("precision") or "auto"),
                memory_policy=str(pref.get("memory_policy") or "auto"),
                timeout_seconds=float(pref.get("timeout_seconds") or 1800),
            )
        raise UpscaleError(f"未知的放大引擎：{name}")

    def get(self, name: str | None = None, cfg: dict[str, Any] | None = None):
        cfg = cfg or app_config.load_config()
        name = str(name or registry.section(cfg).get("default_engine") or "seedvr2")
        with self._lock:
            for other, engine in list(self._engines.items()):
                if other != name and engine.loaded:
                    engine.unload()
                    self._engines.pop(other, None)
            if name == "vosr2":
                # 远程引擎本身不持有状态，每次按最新配置重建，设置页改 URL 后立即生效
                engine = self._build(name, cfg)
                self._engines[name] = engine
                return engine
            engine = self._engines.get(name)
            if engine is None:
                engine = self._build(name, cfg)
                self._engines[name] = engine
            return engine

    # ------------------------------------------------------------------ run
    def upscale(self, image, *, engine: str | None = None, params: dict[str, Any] | None = None, **options):
        params = params or {}
        cfg = app_config.load_config()
        target = self.get(engine, cfg)
        name = target.name
        up = registry.section(cfg)

        if name == "seedvr2":
            defaults = up.get("seedvr2") or {}
            kwargs = {
                "scale": int(params.get("scale") or up.get("defaults", {}).get("scale") or 2),
                "seed": int(params.get("seed") if params.get("seed") is not None
                            else up.get("defaults", {}).get("seed", 42)),
                "target_short_edge": params.get("target_short_edge"),
                "max_resolution": int(params.get("max_resolution") or 0),
                "batch_size": int(params.get("batch_size") or 1),
                "color_correction": str(params.get("color_correction") or "lab"),
            }
            if params.get("vae_tiled") is not None:
                target.vae_tiled = bool(params["vae_tiled"])
            if params.get("dit") or params.get("vae"):
                # 换模型文件时重建引擎
                prefs = dict(defaults)
                prefs.update({k: v for k, v in params.items() if k in ("dit", "vae")})
                with self._lock:
                    old = self._engines.pop("seedvr2", None)
                    if old is not None:
                        try:
                            old.unload()
                        except Exception:  # noqa: BLE001
                            pass
                cfg2 = app_config.load_config()
                cfg2.setdefault("upscale", {}).setdefault("seedvr2", {}).update(prefs)
                target = self._build("seedvr2", cfg2)
                self._engines["seedvr2"] = target
        elif name == "flashvsr":
            defaults = up.get("flashvsr") or {}
            merged = {**defaults, **{k: v for k, v in params.items() if v is not None}}
            kwargs = {
                "scale": int(merged.get("scale") or up.get("defaults", {}).get("scale") or 2),
                "seed": int(merged.get("seed") or 6),
                "color_fix": bool(merged.get("color_fix", True)),
                "tile_size": int(merged.get("tile_size") or 256),
                "tile_overlap": int(merged.get("tile_overlap") or 24),
                "topk_ratio": float(merged.get("topk_ratio") or 2.0),
                "kv_ratio": float(merged.get("kv_ratio") or 3.0),
                "local_range": int(merged.get("local_range") or 11),
            }
        else:  # vosr2：参数在构造引擎时已读取，这里只传本次推理参数
            kwargs = {
                "scale": int(params.get("scale") or up.get("defaults", {}).get("scale") or 2),
                "seed": int(params.get("seed") if params.get("seed") is not None
                            else up.get("defaults", {}).get("seed", 42)),
            }

        kwargs.update(options)
        try:
            result = target.upscale(image, **kwargs)
        except Exception:
            self._last_used = time.time()
            raise
        self._last_used = time.time()
        return result

    # --------------------------------------------------------------- status
    def status(self, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        cfg = cfg or app_config.load_config()
        with self._lock:
            loaded = {name: bool(engine.loaded) for name, engine in self._engines.items()}
        return {"loaded": loaded, "last_used": self._last_used}

    def free(self, unload: bool = True) -> None:
        with self._lock:
            if not unload:
                try:
                    import torch

                    torch.cuda.empty_cache()
                except Exception:
                    pass
                return
            for name, engine in list(self._engines.items()):
                try:
                    engine.unload()
                except Exception:
                    pass
                self._engines.pop(name, None)

    def maybe_unload(self, idle_seconds: float, cfg: dict[str, Any] | None = None) -> list[str]:
        cfg = cfg or app_config.load_config()
        minutes = float(registry.section(cfg).get("idle_unload_minutes") or 0)
        if minutes <= 0 or idle_seconds < minutes * 60:
            return []
        with self._lock:
            loaded = [n for n, e in self._engines.items() if e.loaded]
        if loaded:
            self.free(unload=True)
        return loaded


_MANAGER: UpscalerManager | None = None
_MANAGER_LOCK = threading.Lock()


def get_manager() -> UpscalerManager:
    global _MANAGER
    if _MANAGER is None:
        with _MANAGER_LOCK:
            if _MANAGER is None:
                _MANAGER = UpscalerManager()
    return _MANAGER
