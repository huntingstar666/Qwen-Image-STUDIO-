"""SeedVR2 7B adapter.

Runs the *original* SeedVR2 inference code (vendored under
``server/upscalers/vendor/seedvr2``) without ComfyUI.  Only the node wiring is
re-implemented here, mirroring ``inference_cli._process_frames_core``: the four
pipeline phases (encode → upscale → decode → postprocess) and their parameters
come straight from the upstream project, so output quality matches the
original node/CLI.

Model directory layout (``model_dir``)::

    seedvr2_ema_7b_fp8_e4m3fn.safetensors   # DiT
    ema_vae_fp16.safetensors                # VAE
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

DEFAULT_DIT = "seedvr2_ema_7b_fp8_e4m3fn.safetensors"
DEFAULT_VAE = "ema_vae_fp16.safetensors"

#: Phase weights copied from the upstream ComfyUI node so the progress bar
#: behaves exactly like the original.
_PHASE_WEIGHTS = {
    "Phase 1: Encoding": (0.0, 0.20),
    "Phase 2: Upscaling": (0.20, 0.25),
    "Phase 3: Decoding": (0.45, 0.50),
    "Phase 4: Post-processing": (0.95, 0.05),
}

_DEVICE_KEYS = (
    "dit_device",
    "vae_device",
    "dit_offload_device",
    "vae_offload_device",
    "tensor_offload_device",
    "compute_dtype",
)


def _torch():
    import torch

    return torch


class SeedVR2Engine:
    """Lazily loaded, single-instance SeedVR2 pipeline."""

    name = "seedvr2"

    def __init__(
        self,
        model_dir: Path,
        *,
        dit_model: str = DEFAULT_DIT,
        vae_model: str = DEFAULT_VAE,
        vae_tiled: bool = True,
        encode_tile_size: int = 1024,
        encode_tile_overlap: int = 128,
        decode_tile_size: int = 1024,
        decode_tile_overlap: int = 128,
        attention_mode: str = "sdpa",
        offload_device: str = "cpu",
        blocks_to_swap: int = 0,
        swap_io_components: bool = False,
        debug: bool = False,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.dit_model = dit_model
        self.vae_model = vae_model
        self.vae_tiled = vae_tiled
        self.encode_tile_size = encode_tile_size
        self.encode_tile_overlap = encode_tile_overlap
        self.decode_tile_size = decode_tile_size
        self.decode_tile_overlap = decode_tile_overlap
        self.attention_mode = attention_mode
        self.offload_device = offload_device
        self.blocks_to_swap = blocks_to_swap
        self.swap_io_components = swap_io_components
        self.debug_enabled = debug

        self._runner = None
        self._ctx = None
        self._text_embeds = None
        self._debug = None
        self._torch = None
        self._lock = threading.Lock()
        self._last_used = 0.0

    # ------------------------------------------------------------------ load
    @property
    def loaded(self) -> bool:
        return self._runner is not None

    @property
    def last_used(self) -> float:
        return self._last_used

    @property
    def _dit_id(self) -> str:
        return f"q2i_dit_{self.dit_model}"

    @property
    def _vae_id(self) -> str:
        return f"q2i_vae_{self.vae_model}"

    def _missing_files(self) -> list[str]:
        missing = []
        for name in (self.dit_model, self.vae_model):
            if not (self.model_dir / name).is_file():
                missing.append(name)
        return missing

    def load(self) -> None:
        if self._runner is not None:
            return
        missing = self._missing_files()
        if missing:
            raise UpscaleError(
                f"SeedVR2 模型目录缺少文件：{', '.join(missing)}（{self.model_dir}）"
            )

        torch = _torch()
        if not torch.cuda.is_available():
            raise UpscaleError("SeedVR2 需要 NVIDIA CUDA 设备")

        from .vendor.seedvr2.src.core.generation_utils import (
            load_text_embeddings,
            prepare_runner,
            setup_generation_context,
            script_directory,
        )
        from .vendor.seedvr2.src.utils.debug import Debug

        class _QuietDebug(Debug):
            """上游把大量阶段日志标成 force=True；服务端只保留警告/错误。"""

            def log(self, message, level="INFO", category="general", force=False,
                    indent_level=0):
                if level in ("WARNING", "ERROR"):
                    super().log(message, level, category, force, indent_level)

        debug = _QuietDebug(enabled=self.debug_enabled)
        offload = None if self.offload_device in ("", "none") else self.offload_device

        ctx = setup_generation_context(
            dit_device="cuda",
            vae_device="cuda",
            dit_offload_device=offload,
            vae_offload_device=offload,
            tensor_offload_device=offload,
            debug=debug,
        )

        runner, cache_context = prepare_runner(
            dit_model=self.dit_model,
            vae_model=self.vae_model,
            model_dir=str(self.model_dir),
            debug=debug,
            ctx=ctx,
            dit_cache=True,
            vae_cache=True,
            dit_id=self._dit_id,
            vae_id=self._vae_id,
            block_swap_config=(
                {
                    "blocks_to_swap": self.blocks_to_swap,
                    "swap_io_components": self.swap_io_components,
                    "offload_device": torch.device(offload or "cpu"),
                }
                if self.blocks_to_swap > 0 or self.swap_io_components
                else None
            ),
            encode_tiled=self.vae_tiled,
            encode_tile_size=(self.encode_tile_size, self.encode_tile_size),
            encode_tile_overlap=(self.encode_tile_overlap, self.encode_tile_overlap),
            decode_tiled=self.vae_tiled,
            decode_tile_size=(self.decode_tile_size, self.decode_tile_size),
            decode_tile_overlap=(self.decode_tile_overlap, self.decode_tile_overlap),
            tile_debug="false",
            attention_mode=self.attention_mode,
            torch_compile_args_dit=None,
            torch_compile_args_vae=None,
        )
        ctx["cache_context"] = cache_context

        text_embeds = load_text_embeddings(
            script_directory, ctx["dit_device"], ctx["compute_dtype"], debug
        )

        self._torch = torch
        self._debug = debug
        self._ctx = ctx
        self._runner = runner
        self._text_embeds = text_embeds
        self._last_used = time.time()

    def unload(self) -> None:
        runner, ctx = self._runner, self._ctx
        self._runner = None
        self._ctx = None
        self._text_embeds = None

        try:
            from .vendor.seedvr2.src.core.model_cache import get_global_cache
            from .vendor.seedvr2.src.optimization.memory_manager import (
                cleanup_text_embeddings,
                complete_cleanup,
            )

            if runner is not None:
                complete_cleanup(
                    runner=runner, debug=self._debug, dit_cache=False, vae_cache=False
                )
            if ctx:
                cleanup_text_embeddings(ctx, self._debug)
            cache = get_global_cache()
            cache.remove_dit({"node_id": self._dit_id}, self._debug)
            cache.remove_vae({"node_id": self._vae_id}, self._debug)
        except Exception:
            pass

        del runner, ctx
        gc.collect()
        try:
            _torch().cuda.empty_cache()
        except Exception:
            pass

    def touch(self) -> None:
        self._last_used = time.time()

    # ------------------------------------------------------------- pipeline
    def _reset_ctx(self, ctx: dict) -> dict:
        """Drop per-run data while keeping the device configuration."""
        for key in list(ctx.keys()):
            if key not in _DEVICE_KEYS and key != "cache_context":
                del ctx[key]
        ctx["text_embeds"] = self._text_embeds
        return ctx

    def _make_progress(self, progress: Optional[ProgressFn]):
        if progress is None:
            return None

        def _callback(
            current_step: int, total_steps: int, current_frames: int, phase_name: str
        ) -> None:
            key = phase_name.split(" (")[0] if " (" in phase_name else phase_name
            offset, weight = _PHASE_WEIGHTS.get(key, (0.0, 1.0))
            ratio = (current_step / total_steps) if total_steps > 0 else 0.0
            value = min(100.0, (offset + ratio * weight) * 100.0)
            progress(value, key)

        return _callback

    def upscale(
        self,
        image,
        *,
        scale: int = 2,
        target_short_edge: Optional[int] = None,
        max_resolution: int = 0,
        seed: int = 42,
        batch_size: int = 1,
        color_correction: str = "lab",
        progress: Optional[ProgressFn] = None,
        should_cancel: Optional[CancelFn] = None,
    ):
        """Upscale a PIL image (RGB or RGBA) and return a PIL image."""
        if scale not in (2, 4):
            raise UpscaleError("SeedVR2 只支持 2× 或 4×")

        from PIL import Image

        with self._lock:
            self.load()
            self.touch()

            torch = self._torch
            ctx = self._reset_ctx(self._ctx)
            if should_cancel is not None:

                def _interrupt():
                    if should_cancel():
                        raise UpscaleCancelled("cancelled")

                ctx["interrupt_fn"] = _interrupt

            has_alpha = image.mode in ("RGBA", "LA") or (
                image.mode == "P" and "transparency" in image.info
            )
            rgb = image.convert("RGBA") if has_alpha else image.convert("RGB")
            in_w, in_h = rgb.size

            short = min(in_w, in_h)
            resolution = int(target_short_edge or round(short * scale))
            resolution = max(16, resolution - (resolution % 2))

            arr = torch.frombuffer(bytearray(rgb.tobytes()), dtype=torch.uint8)
            arr = arr.view(in_h, in_w, -1).to(torch.float32).div_(255.0).unsqueeze(0)
            # (T, H, W, C) float32 in [0, 1] — exactly what the node receives.

            from .vendor.seedvr2.src.core.generation_phases import (
                decode_all_batches,
                encode_all_batches,
                postprocess_all_batches,
                upscale_all_batches,
            )
            from .vendor.seedvr2.src.core.generation_utils import (
                compute_generation_info,
                log_generation_start,
            )

            frames, info = compute_generation_info(
                ctx=ctx,
                images=arr,
                resolution=resolution,
                max_resolution=max_resolution,
                batch_size=batch_size,
                uniform_batch_size=False,
                seed=seed,
                prepend_frames=0,
                temporal_overlap=0,
                debug=self._debug,
            )
            log_generation_start(info, self._debug)

            callback = self._make_progress(progress)
            ctx = encode_all_batches(
                self._runner,
                ctx=ctx,
                images=frames,
                debug=self._debug,
                batch_size=batch_size,
                uniform_batch_size=False,
                seed=seed,
                progress_callback=callback,
                temporal_overlap=0,
                resolution=resolution,
                max_resolution=max_resolution,
                input_noise_scale=0.0,
                color_correction=color_correction,
            )
            ctx = upscale_all_batches(
                self._runner,
                ctx=ctx,
                debug=self._debug,
                progress_callback=callback,
                seed=seed,
                latent_noise_scale=0.0,
                cache_model=True,
            )
            ctx = decode_all_batches(
                self._runner,
                ctx=ctx,
                debug=self._debug,
                progress_callback=callback,
                cache_model=True,
            )
            ctx = postprocess_all_batches(
                ctx=ctx,
                debug=self._debug,
                progress_callback=callback,
                color_correction=color_correction,
                prepend_frames=0,
                temporal_overlap=0,
                batch_size=batch_size,
            )

            out = ctx["final_video"]
            if torch.is_tensor(out):
                out = out[0].detach().float().cpu().clamp_(0.0, 1.0)
                np_arr = (out.numpy() * 255.0 + 0.5).astype("uint8")
                result = Image.fromarray(np_arr)
            else:
                raise UpscaleError("SeedVR2 未返回有效结果")

            if result.mode == "RGBA" and not has_alpha:
                result = result.convert("RGB")

            exact = (in_w * scale, in_h * scale)
            if result.size != exact:
                result = result.resize(exact, Image.LANCZOS)

            self._reset_ctx(ctx)
            self.touch()
            if progress is not None:
                progress(100.0, "完成")
            return result
