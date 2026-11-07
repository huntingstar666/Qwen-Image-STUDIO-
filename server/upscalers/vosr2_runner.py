"""VOSR2 1.4B 单步蒸馏放大适配器。

推理代码 vendor 自 ComfyUI-VOSR2（Apache-2.0，见
``server/upscalers/vendor/vosr2/LICENSE``），不依赖 ComfyUI 宿主：
``loader.py`` 里的 ``comfy.*`` 接线已替换为 ``ops_compat`` / ``_Patcher``。
本文件只负责本项目需要的接线：懒加载、PIL ⇄ tensor、进度、取消、显存回收。

模型包目录结构（``root`` 下每个子目录是一套 bundle）::

    <root>/VOSR2/args.json
    <root>/VOSR2/checkpoints/ema_model.safetensors
    <root>/VOSR2/Qwen-Image-vae-2d/{config.json,diffusion_pytorch_model.safetensors}
    <root>/VOSR2/dinov2_vitl14.safetensors
"""

from __future__ import annotations

import gc
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .base import UpscaleCancelled, UpscaleError

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

DEFAULT_BUNDLE = "VOSR2"
_COLOR_MODES = ("wavelet", "adain", "none")


def _torch():
    import torch

    return torch


class VOSR2Engine:
    """Lazily loaded VOSR2 pipeline (DiT + Qwen-Image VAE + DINOv2-L)."""

    name = "vosr2"

    def __init__(
        self,
        model_dir: Path | str,
        *,
        bundle: str = DEFAULT_BUNDLE,
        precision: str = "auto",
        color_alignment: str = "wavelet",
        tile_size: int = 512,
        tile_overlap: int = 64,
        vae_tile_size: int = 512,
        vae_tile_overlap: int = 64,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.bundle = bundle or DEFAULT_BUNDLE
        self.precision = precision or "auto"
        self.color_alignment = color_alignment or "wavelet"
        self.tile_size = int(tile_size)
        self.tile_overlap = int(tile_overlap)
        self.vae_tile_size = int(vae_tile_size)
        self.vae_tile_overlap = int(vae_tile_overlap)
        self._model = None
        self._lock = threading.RLock()
        self._last_used = 0.0

    # ------------------------------------------------------------- lifecycle
    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def last_used(self) -> float:
        return self._last_used

    def touch(self) -> None:
        self._last_used = time.time()

    def load(self, progress: Optional[ProgressFn] = None) -> None:
        """加载权重（幂等）。权重约 6.6GB，首次约 7 秒。"""
        with self._lock:
            if self._model is not None:
                return
            if not str(self.model_dir).strip():
                raise UpscaleError("未配置 VOSR2 模型目录")
            if progress is not None:
                progress(1.0, "加载 VOSR2 权重")
            dtype = "default" if self.precision in ("auto", "", None) else self.precision
            try:
                import torch

                if not torch.cuda.is_available():
                    # CPU 上 bf16/fp16 推理会明显变慢甚至报错，统一退回默认精度
                    dtype = "default"
            except Exception:  # noqa: BLE001 - 无 torch 时交给 loader 报错
                pass
            try:
                from .vendor.vosr2.loader import VOSR2LoadError, load_vosr2

                self._model = load_vosr2(self.model_dir, self.bundle, dtype=dtype)
            except VOSR2LoadError as exc:
                raise UpscaleError(f"VOSR2 模型加载失败：{exc}") from exc
            except FileNotFoundError as exc:
                raise UpscaleError(f"VOSR2 模型文件缺失：{exc}") from exc
            self.touch()

    def unload(self) -> None:
        with self._lock:
            self._model = None
            gc.collect()
            try:
                torch = _torch()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001 - 卸载失败不应影响主流程
                pass

    # ------------------------------------------------------------------ run
    def upscale(
        self,
        image,
        *,
        scale: int = 2,
        seed: int = 42,
        color_alignment: Optional[str] = None,
        tile_size: Optional[int] = None,
        tile_overlap: Optional[int] = None,
        vae_tile_size: Optional[int] = None,
        vae_tile_overlap: Optional[int] = None,
        progress: Optional[ProgressFn] = None,
        should_cancel: Optional[CancelFn] = None,
    ):
        """放大一张 PIL 图片（RGB/RGBA），返回 PIL 图片。"""
        if int(scale) not in (2, 4):
            raise UpscaleError("VOSR2 只支持 2× 或 4×")
        align = str(color_alignment or self.color_alignment or "wavelet").lower()
        if align not in _COLOR_MODES:
            align = "wavelet"

        from PIL import Image

        with self._lock:
            self.load(progress)
            self.touch()

            import numpy as np
            import torch
            from .vendor.vosr2.inference import run_vosr2

            has_alpha = image.mode in ("RGBA", "LA") or (
                image.mode == "P" and "transparency" in image.info
            )
            rgb = image.convert("RGB")
            alpha = image.convert("RGBA").getchannel("A") if has_alpha else None

            source = torch.from_numpy(
                np.asarray(rgb, dtype=np.float32) / 255.0
            ).unsqueeze(0)
            out_w, out_h = rgb.size[0] * int(scale), rgb.size[1] * int(scale)

            def _report(value: float, total: float) -> None:
                if progress is None:
                    return
                ratio = 0.0 if not total else max(0.0, min(1.0, value / total))
                progress(4.0 + ratio * 92.0, "推理")

            def _cancelled() -> bool:
                return bool(should_cancel is not None and should_cancel())

            try:
                if progress is not None:
                    progress(4.0, "推理")
                output = run_vosr2(
                    self._model,
                    source,
                    upscale=int(scale),
                    seed=int(seed),
                    color_alignment=align,
                    tile_size=int(self.tile_size if tile_size is None else tile_size),
                    tile_overlap=int(self.tile_overlap if tile_overlap is None else tile_overlap),
                    vae_tile_size=int(self.vae_tile_size if vae_tile_size is None else vae_tile_size),
                    vae_tile_overlap=int(
                        self.vae_tile_overlap if vae_tile_overlap is None else vae_tile_overlap
                    ),
                    progress=_report,
                    should_cancel=_cancelled,
                )
            except RuntimeError as exc:
                if "cancelled" in str(exc).lower():
                    raise UpscaleCancelled("已取消") from exc
                raise UpscaleError(f"VOSR2 推理失败：{exc}") from exc
            except torch.cuda.OutOfMemoryError as exc:
                raise UpscaleError("VOSR2 显存不足，请调小分块尺寸或降低倍率") from exc

            if progress is not None:
                progress(97.0, "收尾")
            array = output.clamp(0.0, 1.0)[0].mul(255.0).round().to(torch.uint8).cpu().numpy()
            result = Image.fromarray(array, mode="RGB")
            if result.size != (out_w, out_h):
                result = result.resize((out_w, out_h), Image.LANCZOS)
            if alpha is not None:
                result = result.convert("RGBA")
                result.putalpha(alpha.resize((out_w, out_h), Image.LANCZOS))
            if progress is not None:
                progress(100.0, "完成")
            return result
