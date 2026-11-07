"""FlashVSR 1.1 adapter.

Runs the *original* FlashVSR streaming core (vendored under
``server/upscalers/vendor/flashvsr``) without ComfyUI.  Algorithm code is not
modified: this module only supplies the wiring that the ComfyUI node used to
provide (model loading, 25-frame still padding, spatial tiling with feathered
blending, progress and cancellation).

Verified recipe (see docs/PLAN_IMAGE_TOOLS_V2.md §6.2):
  * ``Causal_LQ4x_Proj(in_dim=3, out_dim=1536, layer_num=1)``
  * ``build_tcdecoder(new_channels=[512,256,128,128], new_latent_channels=784)``
  * ``LQ_video`` must be at the *target* resolution, not target/scale.
"""

from __future__ import annotations

import gc
import math
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .base import UpscaleCancelled, UpscaleError

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

DIT_FILE = "diffusion_pytorch_model_streaming_dmd.safetensors"
VAE_FILE = "Wan2.1_VAE.pth"
LQ_FILE = "LQ_proj_in.ckpt"
PROMPT_FILE = "posi_prompt.pth"
TCDECODER_FILE = "TCDecoder.ckpt"

# FlashVSR always consumes 8n+5 frames; a single still needs one full stream
# block, which is 25 frames for the tiny pipeline.
STILL_FRAMES = 25


def _torch():
    import torch

    return torch


def _missing_files(model_dir: Path) -> list[str]:
    required = [DIT_FILE, VAE_FILE, LQ_FILE, PROMPT_FILE, TCDECODER_FILE]
    return [name for name in required if not (model_dir / name).is_file()]


class FlashVSREngine:
    """Lazily loaded, single-instance FlashVSR pipeline."""

    name = "flashvsr"

    def __init__(self, model_dir: Path, *, mode: str = "tiny", precision: str = "bf16") -> None:
        self.model_dir = Path(model_dir)
        self.mode = mode
        self.precision = precision
        self._pipe = None
        self._torch_dtype = None
        self._device = None
        self._lock = threading.Lock()
        self._last_used = 0.0

    # ------------------------------------------------------------------ load
    @property
    def loaded(self) -> bool:
        return self._pipe is not None

    @property
    def last_used(self) -> float:
        return self._last_used

    def load(self) -> None:
        if self._pipe is not None:
            return
        missing = _missing_files(self.model_dir)
        if missing:
            raise UpscaleError(
                f"FlashVSR 模型目录缺少文件：{', '.join(missing)}（{self.model_dir}）"
            )

        torch = _torch()
        if not torch.cuda.is_available():
            raise UpscaleError("FlashVSR 需要 NVIDIA CUDA 设备")

        dtype = torch.bfloat16 if self.precision == "bf16" else torch.float16
        if dtype is torch.bfloat16 and not torch.cuda.is_bf16_supported():
            dtype = torch.float16

        from .vendor.flashvsr.flashvsr_core.models.model_manager import ModelManager
        from .vendor.flashvsr.flashvsr_core.models.TCDecoder import build_tcdecoder
        from .vendor.flashvsr.flashvsr_core.models.utils import (
            Buffer_LQ4x_Proj,
            Causal_LQ4x_Proj,
        )
        from .vendor.flashvsr.flashvsr_core.pipelines.flashvsr_tiny import (
            FlashVSRTinyPipeline,
        )

        manager = ModelManager(
            torch_dtype=dtype,
            device="cuda",
            file_path_list=[str(self.model_dir / DIT_FILE), str(self.model_dir / VAE_FILE)],
        )
        pipe = FlashVSRTinyPipeline.from_model_manager(manager, device="cuda")

        dit_dim = int(getattr(pipe.dit, "dim", 1536))
        proj_cls = Causal_LQ4x_Proj if "v1.1" in self.model_dir.name else Buffer_LQ4x_Proj
        lq_proj = proj_cls(in_dim=3, out_dim=dit_dim, layer_num=1)
        lq_proj.load_state_dict(
            torch.load(self.model_dir / LQ_FILE, map_location="cpu", weights_only=True),
            strict=True,
        )
        pipe.dit.LQ_proj_in = lq_proj.to(device="cuda", dtype=dtype)

        decoder = build_tcdecoder(
            new_channels=[512, 256, 128, 128],
            device="cuda",
            dtype=dtype,
            new_latent_channels=784,
        )
        decoder.load_state_dict(
            torch.load(self.model_dir / TCDECODER_FILE, map_location="cpu", weights_only=True),
            strict=False,
        )
        decoder.clean_mem()
        pipe.TCDecoder = decoder

        pipe.init_cross_kv(prompt_path=str(self.model_dir / PROMPT_FILE))
        pipe.load_models_to_device(["dit", "vae"])

        self._pipe = pipe
        self._torch_dtype = dtype
        self._device = torch.device("cuda")
        self._last_used = time.time()

    def unload(self) -> None:
        pipe = self._pipe
        self._pipe = None
        if pipe is not None:
            try:
                pipe.offload_model()
            except Exception:
                pass
            del pipe
        gc.collect()
        try:
            _torch().cuda.empty_cache()
        except Exception:
            pass

    def touch(self) -> None:
        self._last_used = time.time()

    # --------------------------------------------------------------- helpers
    def _target_size(self, width: int, height: int, scale: int) -> tuple[int, int]:
        """Round the output size up to a multiple of 128 (FlashVSR requirement)."""

        out_w = max(128, width * scale)
        out_h = max(128, height * scale)
        return (
            int(math.ceil(out_w / 128) * 128),
            int(math.ceil(out_h / 128) * 128),
        )

    @staticmethod
    def _tile_coords(height: int, width: int, tile: int, overlap: int):
        tile_h = min(tile, height)
        tile_w = min(tile, width)
        stride_h = max(1, tile_h - overlap)
        stride_w = max(1, tile_w - overlap)
        rows = max(1, math.ceil(max(0, height - overlap) / stride_h))
        cols = max(1, math.ceil(max(0, width - overlap) / stride_w))
        coords = []
        for row in range(rows):
            for col in range(cols):
                y1 = min(row * stride_h, height - tile_h)
                x1 = min(col * stride_w, width - tile_w)
                box = (x1, y1, x1 + tile_w, y1 + tile_h)
                if box not in coords:
                    coords.append(box)
        return coords

    @staticmethod
    def _feather(height: int, width: int, overlap: int):
        torch = _torch()
        mask = torch.ones(1, height, width, 1, dtype=torch.float32)
        fade = min(overlap, height // 2, width // 2)
        if fade <= 0:
            return mask
        ramp = torch.linspace(1.0 / (fade + 1), 1.0, fade)
        mask[:, :, :fade] *= ramp.view(1, 1, -1, 1)
        mask[:, :, -fade:] *= ramp.flip(0).view(1, 1, -1, 1)
        mask[:, :fade] *= ramp.view(1, -1, 1, 1)
        mask[:, -fade:] *= ramp.flip(0).view(1, -1, 1, 1)
        return mask

    def _run_once(
        self,
        frame_chw: "object",
        *,
        target_w: int,
        target_h: int,
        seed: int,
        color_fix: bool,
        topk_ratio: float,
        kv_ratio: float,
        local_range: int,
        progress: Optional[ProgressFn],
        should_cancel: Optional[CancelFn],
    ):
        """Run the pipeline on one padded still (C,H,W float tensor in 0..1)."""
        torch = _torch()
        dtype = self._torch_dtype

        import torch.nn.functional as F

        # LQ conditioning must share the requested output resolution.
        lq = F.interpolate(
            frame_chw.unsqueeze(0),
            size=(target_h, target_w),
            mode="bicubic",
            align_corners=False,
        ).clamp_(0.0, 1.0)
        lq = lq.permute(1, 0, 2, 3).unsqueeze(0)  # 1,C,1,H,W
        lq = lq.repeat(1, 1, STILL_FRAMES, 1, 1).mul_(2.0).sub_(1.0).contiguous()
        lq = lq.to(device=self._device, dtype=dtype)

        def _iter(range_):
            total = max(1, len(range_))
            for index, value in enumerate(range_):
                if should_cancel is not None and should_cancel():
                    raise UpscaleCancelled("cancelled")
                if progress is not None:
                    progress((index / total) * 100.0, f"去噪 {index + 1}/{total}")
                yield value

        output = self._pipe(
            prompt="",
            negative_prompt="",
            cfg_scale=1.0,
            num_inference_steps=1,
            seed=int(seed),
            tiled=True,
            LQ_video=lq,
            num_frames=STILL_FRAMES,
            height=target_h,
            width=target_w,
            is_full_block=False,
            if_buffer=True,
            topk_ratio=float(topk_ratio),
            kv_ratio=float(kv_ratio),
            local_range=int(local_range),
            color_fix=bool(color_fix),
            stage_memory=False,
            progress_bar_cmd=_iter,
        )
        del lq
        # output: (C, F, H, W) in [-1, 1]; every frame is the same still.
        frame = output[:, 0].float().add_(1.0).div_(2.0).clamp_(0.0, 1.0)
        del output
        return frame

    # ------------------------------------------------------------- public op
    def upscale(
        self,
        image,
        *,
        scale: int = 2,
        seed: int = 6,
        color_fix: bool = True,
        tile_size: int = 256,
        tile_overlap: int = 24,
        topk_ratio: float = 2.0,
        kv_ratio: float = 3.0,
        local_range: int = 11,
        progress: Optional[ProgressFn] = None,
        should_cancel: Optional[CancelFn] = None,
    ):
        """Upscale a PIL image (RGB or RGBA) and return a PIL image."""
        if scale not in (2, 4):
            raise UpscaleError("FlashVSR 只支持 2× 或 4×")
        if tile_overlap < 0 or tile_overlap * 2 >= tile_size:
            raise UpscaleError("tile_overlap 必须非负且小于 tile_size 的一半")

        from PIL import Image

        with self._lock:
            self.load()
            self.touch()

            has_alpha = image.mode in ("RGBA", "LA") or (
                image.mode == "P" and "transparency" in image.info
            )
            rgb = image.convert("RGB")
            alpha = image.convert("RGBA").getchannel("A") if has_alpha else None

            import numpy as np
            import torch

            width, height = rgb.size
            out_w, out_h = width * scale, height * scale
            source = torch.from_numpy(np.asarray(rgb, dtype=np.float32) / 255.0).permute(2, 0, 1)

            use_tiles = max(width, height) > 384
            if not use_tiles:
                target_w, target_h = self._target_size(width, height, scale)
                if progress is not None:
                    progress(2.0, "推理")
                frame = self._run_once(
                    source,
                    target_w=target_w,
                    target_h=target_h,
                    seed=seed,
                    color_fix=color_fix,
                    topk_ratio=topk_ratio,
                    kv_ratio=kv_ratio,
                    local_range=local_range,
                    progress=progress,
                    should_cancel=should_cancel,
                )
                result = frame.unsqueeze(0)
            else:
                coords = self._tile_coords(height, width, tile_size, tile_overlap)
                canvas = torch.zeros(1, 3, out_h, out_w, dtype=torch.float32)
                weights = torch.zeros(1, 1, out_h, out_w, dtype=torch.float32)
                for index, (x1, y1, x2, y2) in enumerate(coords):
                    if should_cancel is not None and should_cancel():
                        raise UpscaleCancelled("cancelled")
                    tile = source[:, y1:y2, x1:x2]
                    tw, th = (x2 - x1) * scale, (y2 - y1) * scale
                    target_w, target_h = self._target_size(x2 - x1, y2 - y1, scale)

                    def _tile_progress(value, text, _i=index):
                        if progress is not None:
                            base = (_i / len(coords)) * 100.0
                            span = 100.0 / len(coords)
                            progress(base + value / 100.0 * span, f"分块 {_i + 1}/{len(coords)}")

                    frame = self._run_once(
                        tile,
                        target_w=target_w,
                        target_h=target_h,
                        seed=seed,
                        color_fix=color_fix,
                        topk_ratio=topk_ratio,
                        kv_ratio=kv_ratio,
                        local_range=local_range,
                        progress=_tile_progress,
                        should_cancel=should_cancel,
                    )
                    if (frame.shape[2], frame.shape[1]) != (th, tw):
                        frame = torch.nn.functional.interpolate(
                            frame.unsqueeze(0),
                            size=(th, tw),
                            mode="bicubic",
                            align_corners=False,
                        ).squeeze(0).clamp_(0.0, 1.0)
                    mask = self._feather(th, tw, tile_overlap * scale)
                    ox1, oy1 = x1 * scale, y1 * scale
                    canvas[:, :, oy1 : oy1 + th, ox1 : ox1 + tw] += frame.unsqueeze(0) * mask
                    weights[:, :, oy1 : oy1 + th, ox1 : ox1 + tw] += mask
                    del frame
                    gc.collect()
                    torch.cuda.empty_cache()
                result = canvas.div_(weights.clamp_min_(1e-6)).clamp_(0.0, 1.0)

            # Exact requested size (target size may be rounded up to 128).
            if (result.shape[3], result.shape[2]) != (out_w, out_h):
                result = torch.nn.functional.interpolate(
                    result,
                    size=(out_h, out_w),
                    mode="lanczos",
                    align_corners=False,
                    antialias=True,
                ).clamp_(0.0, 1.0)

            array = (
                result.squeeze(0).mul_(255.0).round_().clamp_(0, 255).byte().permute(1, 2, 0)
            )
            out = Image.fromarray(array.cpu().numpy(), "RGB")

            if alpha is not None:
                out = out.convert("RGBA")
                out.putalpha(
                    alpha.resize((out_w, out_h), Image.LANCZOS)
                    if alpha.size != (out_w, out_h)
                    else alpha
                )

            if progress is not None:
                progress(100.0, "完成")
            self.touch()
            return out
