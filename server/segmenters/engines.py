"""主体分割引擎：SAM 3.1（点 / 框 / 文字）与 BiRefNet（显著性主体）。

* 只 import 项目内 vendored 的 ``engine/`` 模型库，不依赖 ComfyUI 进程；
* 权重按绝对路径加载；显存不够时由上层（main）先让出显存；
* 对外返回「原图尺寸的概率蒙版」，后处理（阈值/连通域/羽化）在 manager 里做。
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Callable

import numpy as np
from PIL import Image

from .. import config as app_config
from .errors import SegmentError

#: SAM 3.1 推理固定分辨率（与 ComfyUI 的 SAM3_Detect 节点一致）
SAM3_INPUT = 1008

_COMFY_LOCK = threading.Lock()
_COMFY: dict[str, Any] = {}

Progress = Callable[[float, str], None] | None


def _ensure_engine_path() -> str:
    cfg = app_config.load_config()
    root = app_config.find_engine_dir(cfg) or ""
    if not root:
        raise SegmentError(
            "引擎目录不可用：请检查项目的 engine/ 是否完整",
            code="model_not_ready", status=503)
    if root not in sys.path:
        sys.path.insert(0, root)
    return root


def _comfy_modules() -> tuple[Any, Any]:
    """延迟导入 comfy.model_management / comfy.sd（首次约 1~2s）。"""
    with _COMFY_LOCK:
        if not _COMFY:
            root = _ensure_engine_path()
            import comfy.model_management as model_management
            import comfy.sd as sd

            sd_file = os.path.abspath(getattr(sd, "__file__", ""))
            if not sd_file.startswith(os.path.abspath(root) + os.sep):
                raise SegmentError(
                    f"comfy.sd 解析到了引擎目录之外：{sd_file}",
                    code="model_not_ready", status=503)
            _COMFY["mm"] = model_management
            _COMFY["sd"] = sd
        return _COMFY["mm"], _COMFY["sd"]


def _empty_cache() -> None:
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - CPU 环境 / 未初始化都无需处理
        pass


def _unload_patcher(patcher) -> None:
    """把单个 ModelPatcher 从 ComfyUI 的常驻列表里摘掉并归还显存。

    只丢 Python 引用不够：``comfy.model_management.current_loaded_models``
    仍持有 patcher，权重会一直留在显存里（导致切换引擎时 OOM/变慢）。
    """
    if patcher is None:
        return
    try:
        import comfy.model_management as mm

        mm.unload_model_and_clones(patcher)
        mm.soft_empty_cache()
    except Exception:  # noqa: BLE001 - 老版本没有该函数时忽略
        pass


def _pil_tensor(image: Image.Image):
    """PIL → ``[1,H,W,3]`` float32 CPU 张量（0~1）。"""
    import torch

    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array)[None]


class Sam3Engine:
    """SAM 3.1 multiplex：文字 / 框 / 点提示，统一走同一个 checkpoint。"""

    name = "sam3"

    def __init__(self, path: str, *, threshold: float = 0.5,
                 refine_iterations: int = 2, max_candidates: int = 8) -> None:
        self.path = path
        self.threshold = float(threshold)
        self.refine_iterations = int(refine_iterations)
        self.max_candidates = int(max_candidates)
        self._lock = threading.RLock()
        self._model = None
        self._clip = None
        self._sam = None
        self._device = None
        self._dtype = None
        self._text_cache: dict[str, list[tuple[Any, Any]]] = {}

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> "Sam3Engine":
        mm, sd = _comfy_modules()
        with self._lock:
            if self._model is not None:
                return self
            try:
                model, clip, _vae, _clipvision = sd.load_checkpoint_guess_config(
                    self.path, output_vae=False, output_clip=True,
                    output_clipvision=False)
            except Exception as exc:  # noqa: BLE001 - 权重损坏/格式不符
                raise SegmentError(
                    f"分割模型加载失败：{exc}", code="model_not_ready", status=503) from exc
            if model is None or clip is None:
                raise SegmentError(
                    "SAM 3.1 权重缺少模型或文字编码器",
                    code="model_not_ready", status=503)
            mm.load_model_gpu(model)
            self._model = model
            self._clip = clip
            self._sam = model.model.diffusion_model
            self._device = mm.get_torch_device()
            self._dtype = model.model.get_dtype()
            return self

    def unload(self) -> None:
        import gc

        with self._lock:
            _unload_patcher(self._model)
            _unload_patcher(getattr(self._clip, "patcher", None)
                            if self._clip is not None else None)
            self._model = None
            self._clip = None
            self._sam = None
            self._text_cache.clear()
        gc.collect()
        _empty_cache()

    # ---------------------------------------------------------------- 文本
    def _encode_text(self, text: str) -> list[tuple[Any, Any]]:
        key = str(text or "").strip()
        cached = self._text_cache.get(key)
        if cached is not None:
            return [
                (emb.to(device=self._device, dtype=self._dtype) if emb is not None else None,
                 mask.to(self._device) if mask is not None else None)
                for emb, mask in cached
            ]
        cond = self._clip.encode_from_tokens_scheduled(self._clip.tokenize(key))
        if not cond:
            return []
        entries: list[tuple[Any, Any]] = []
        meta = cond[0][1] or {}
        multi = meta.get("sam3_multi_cond")
        if multi:
            for item in multi:
                entries.append((item.get("cond"), item.get("attention_mask")))
        else:
            entries.append((cond[0][0], meta.get("attention_mask")))
        # 只缓存到 CPU，避免长时间占显存
        self._text_cache[key] = [
            (emb.detach().to("cpu") if emb is not None else None,
             mask.detach().to("cpu") if mask is not None else None)
            for emb, mask in entries
        ]
        if len(self._text_cache) > 8:
            oldest = next(iter(self._text_cache))
            self._text_cache.pop(oldest, None)
        return [
            (emb.to(device=self._device, dtype=self._dtype) if emb is not None else None,
             mask.to(self._device) if mask is not None else None)
            for emb, mask in entries
        ]

    def _forward_mask(self, frame, **kwargs):
        logit = self._sam.forward_segment(frame, **kwargs)
        for _ in range(max(0, self.refine_iterations - 1)):
            logit = self._sam.forward_segment(frame, mask_inputs=logit)
        return logit

    def _mask_from_logit(self, logit, width: int, height: int) -> dict[str, Any] | None:
        import torch
        import torch.nn.functional as F

        if tuple(logit.shape[-2:]) != (height, width):
            logit = F.interpolate(logit, size=(height, width), mode="bilinear",
                                  align_corners=False)
        prob = torch.sigmoid(logit[0, 0].float()).cpu().numpy().astype(np.float32)
        if not bool((prob >= 0.5).any()):
            return None
        # 用选中区域的高分位数当置信度：边界像素会把均值拉低，90 分位更接近
        # 「这块选得有多确定」，也与契约里的 score > 0.8 验收一致。
        score = float(np.percentile(prob[prob >= 0.5], 90))
        return {"mask": prob, "score": score}

    def _text_detect(self, frame, text: str, multi: bool,
                     width: int, height: int,
                     geo_points=None, geo_boxes=None) -> list[dict[str, Any]]:
        import torch
        import torch.nn.functional as F

        entries = self._encode_text(text)
        if not entries:
            return []
        limit = self.max_candidates if multi else 1
        results: list[dict[str, Any]] = []
        with torch.inference_mode():
            for embeddings, attention_mask in entries:
                if embeddings is None:
                    continue
                out = self._sam(
                    frame,
                    text_embeddings=embeddings,
                    text_mask=attention_mask,
                    points=geo_points,
                    boxes=geo_boxes,
                    threshold=float(self.threshold),
                    orig_size=(height, width),
                )
                scores = out["scores"][0].float().sigmoid().cpu().numpy()
                keep = np.where(scores >= self.threshold)[0]
                masks = out["masks"][0]
                if len(keep):
                    order = keep[np.argsort(-scores[keep])][:limit]
                    for index in order:
                        logit = masks[int(index)]
                        if tuple(logit.shape[-2:]) != (height, width):
                            logit = F.interpolate(
                                logit[None, None].float(), size=(height, width),
                                mode="bilinear", align_corners=False)[0, 0]
                        prob = torch.sigmoid(logit.float()).cpu().numpy().astype(np.float32)
                        if not bool((prob >= 0.5).any()):
                            continue
                        results.append({
                            "mask": prob,
                            "score": float(scores[int(index)]),
                        })
                del out, masks
        return results

    # ---------------------------------------------------------------- 推理
    def segment(self, image: Image.Image, *, mode: str, box=None, points=None,
                text: str = "", multi: bool = False,
                progress: Progress = None) -> list[dict[str, Any]]:
        import torch
        import torch.nn.functional as F

        self.load()
        width, height = image.size
        tensor = _pil_tensor(image)
        frame = F.interpolate(tensor.movedim(-1, 1), size=(SAM3_INPUT, SAM3_INPUT),
                              mode="bilinear", align_corners=False).to(
            device=self._device, dtype=self._dtype)
        sx = SAM3_INPUT / max(1, width)
        sy = SAM3_INPUT / max(1, height)

        if progress:
            progress(0.55, "推理中")
        # SAM 3.1 multiplex：框 / 点 / 文字可以组合成同一组提示。
        # 送进 detector 的几何提示用归一化坐标；送进 SAM decoder 的用 1008 像素坐标。
        geo_points = None
        geo_boxes = None
        if points:
            coords = [[[x * sx / SAM3_INPUT, y * sy / SAM3_INPUT]
                       for x, y, _label in points]]
            labels = [[label for _x, _y, label in points]]
            geo_points = (
                torch.tensor(coords, device=self._device, dtype=self._dtype),
                torch.tensor(labels, device=self._device, dtype=torch.int32),
            )
        if box is not None:
            x1, y1, x2, y2 = [float(value) for value in box]
            width_px = max(0.0, (x2 - x1) * sx)
            height_px = max(0.0, (y2 - y1) * sy)
            cx = (x1 + x2) / 2 * sx
            cy = (y1 + y2) / 2 * sy
            geo_boxes = torch.tensor(
                [[[cx / SAM3_INPUT, cy / SAM3_INPUT,
                   width_px / SAM3_INPUT, height_px / SAM3_INPUT]]],
                device=self._device, dtype=self._dtype)

        with torch.inference_mode():
            if mode == "text":
                if not str(text or "").strip():
                    return []
                return self._text_detect(frame, text, multi, width, height,
                                         geo_points=geo_points, geo_boxes=geo_boxes)
            # 框 / 点 / 两者组合：走 SAM decoder（点可以 Alt 标记为排除点）。
            box_input = None
            if box is not None:
                x1, y1, x2, y2 = [float(value) for value in box]
                box_input = torch.tensor(
                    [[[x1 * sx, y1 * sy], [x2 * sx, y2 * sy]]],
                    device=self._device, dtype=self._dtype)
            point_inputs = None
            if points:
                coords = [[[x * sx, y * sy] for x, y, _label in points]]
                labels = [[label for _x, _y, label in points]]
                point_inputs = {
                    "point_coords": torch.tensor(coords, device=self._device,
                                                 dtype=self._dtype),
                    "point_labels": torch.tensor(labels, device=self._device,
                                                 dtype=torch.int32),
                }
            if box_input is None and point_inputs is None:
                return []
            logit = self._forward_mask(frame, box_inputs=box_input,
                                       point_inputs=point_inputs)
            result = self._mask_from_logit(logit, width, height)
            return [result] if result else []


class BiRefNetEngine:
    """BiRefNet 显著性主体：无需提示，输出概率图。"""

    name = "birefnet"

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._model = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> "BiRefNetEngine":
        _ensure_engine_path()
        with self._lock:
            if self._model is not None:
                return self
            try:
                import comfy.bg_removal_model as bg_removal

                model = bg_removal.load(self.path)
            except Exception as exc:  # noqa: BLE001
                raise SegmentError(
                    f"主体分割模型加载失败：{exc}",
                    code="model_not_ready", status=503) from exc
            if model is None:
                raise SegmentError(
                    "BiRefNet 权重格式不受支持",
                    code="model_not_ready", status=503)
            self._model = model
            return self

    def unload(self) -> None:
        import gc

        with self._lock:
            _unload_patcher(getattr(self._model, "patcher", None)
                            if self._model is not None else None)
            self._model = None
        gc.collect()
        _empty_cache()

    def segment(self, image: Image.Image, *, mode: str, box=None, points=None,
                text: str = "", multi: bool = False,
                progress: Progress = None) -> list[dict[str, Any]]:
        import torch

        self.load()
        if progress:
            progress(0.55, "推理中")
        tensor = _pil_tensor(image)
        with torch.inference_mode():
            out = self._model.encode_image(tensor)
        array = out.detach().float().cpu().numpy()
        if array.ndim == 3:
            array = array[0]
        mask = np.clip(array, 0.0, 1.0).astype(np.float32)
        if not bool((mask >= 0.5).any()):
            return []
        return [{"mask": mask, "score": float(mask[mask >= 0.5].mean())}]


def build_engine(spec: dict[str, Any], path: str, cfg: dict[str, Any]):
    """按模型 spec 构造引擎（不加载权重）。"""
    segment = cfg.get("segment") or {}
    if spec["engine"] == "sam3":
        pref = segment.get("sam3") or {}
        return Sam3Engine(
            path,
            threshold=float(pref.get("threshold") or 0.5),
            refine_iterations=int(pref.get("refine_iterations") or 2),
            max_candidates=int(segment.get("max_candidates") or 8),
        )
    if spec["engine"] == "birefnet":
        return BiRefNetEngine(path)
    raise SegmentError(f"未知的分割引擎：{spec['engine']}",
                       code="model_not_ready", status=503)
