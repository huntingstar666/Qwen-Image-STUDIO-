"""Qwen-Image 2.1 进程内推理引擎（不依赖 ComfyUI 服务）。

思想：把本机 ComfyUI 只用**模型库代码**（`comfy/` 纯 Python 包，328 个 .py / 约 5.4MB）
以 `sys.path` 方式借进来，按绝对路径直接加载单文件 safetensors 模型，自己组装
「文本编码 → 空 latent → sigma 调度 → 采样 → VAE 解码」管线。
不启动 ComfyUI、不用它的 folder_paths / 模型清单 / HTTP 接口，只 **import 不修改**。

本模块对外契约见 `docs/BUILD_CONTRACT.md` 第 2.5 节；技术基准是
`scripts/proto_native_ok.py`（已实测跑通 1024×1024 turbo 8 步）。

设计要点（踩过的坑，详见 docs/INFERENCE.md）：

1. `comfy` 是**命名空间包**（无 `__init__.py`），根目录加入 `sys.path` 即可 import。
   为了不遮挡项目自己的 `server/` `tests/` `web/` 等同名路径，这里用 `sys.path.append`
   而不是 `insert(0, ...)`。ComfyUI 根目录里同时有 `main.py` / `server.py` / `tests/`，
   `insert(0)` 会在 pytest 等场景抢到错误模块。
2. `encode_text` 逐行复刻了 `comfy_extras/nodes_qwen.py::TextEncodeQwenImage21.execute`，
   包括「同一张缩放后的图同时喂 VLM 和 VAE」「有 alpha 时 VLM 看到白底合成」
   「`keep_vision = len(ref_latents) == 0`」「canvas = 第一张参考图缩放后的尺寸」。
3. CLIP 权重约 8.9GB（int8），采样阶段完全用不到。`sample()` 开始前会把文本编码器
   挪出显存（`model_management.unload_model_and_clones`），给采样和 VAE 解码腾地方；
   下一次 `encode_text()` 会自动装回来。可用环境变量 `QWEN_NATIVE_KEEP_TEXT_ENCODER=1`
   关掉这个优化。
4. `denoise_mask` 就是 SetLatentNoiseMask 的等价物：`guider.sample(denoise_mask=...)`
   内部会做 `comfy.sampler_helpers.prepare_mask`（注意：**不在** `comfy.sample` 里），
   再交给 `KSamplerX0Inpaint`。这里在入口处先按 latent 形状 reshape 一次，便于提前报错。
"""

from __future__ import annotations

import gc
import logging
import math
import numbers
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 常量

#: 画布 / 参考图尺寸对齐粒度（Qwen-Image 全链路要求 32 的倍数）
SNAP = 32
#: 采样 latent 通道数（Qwen-Image 2.1 是 64 通道 / 16 倍下采样）
LATENT_CHANNELS = 64
#: latent 空间下采样倍数
LATENT_DOWNSCALE = 16
#: 没有参考图且 resolution=0 时的兜底画布边长（与节点 `resolution or 1024` 一致）
DEFAULT_RESOLUTION = 1024

#: 项目根目录（`<PROJECT_ROOT>`）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
#: 引擎代码目录（ComfyUI 模型库的 vendored 副本，只 import 不改）。
#: **这是 EngineConfig 唯一需要的代码路径**，运行期绝不把原 ComfyUI 源码目录加进 sys.path。
DEFAULT_ENGINE_DIR = os.path.join(PROJECT_ROOT, "engine")
#: 权重目录：复用本机 ComfyUI 的 models/（只读，不复制）。可用配置覆盖。
DEFAULT_MODEL_ROOT = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\models"
#: 原 ComfyUI 安装根目录——**只用来推断权重位置 / 重新移植引擎**，运行期不 import 它的代码。
DEFAULT_COMFY_ROOT = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI"
_DEFAULT_MODELS = DEFAULT_MODEL_ROOT
DEFAULT_UNET = os.path.join(_DEFAULT_MODELS, "diffusion_models", "QwenImage2.1",
                            "qwen_image_2.1_int8_convrot.safetensors")
DEFAULT_CLIP = os.path.join(_DEFAULT_MODELS, "text_encoders", "Qweniamge2.1",
                            "qwen3vl_8b_int8_convrot.safetensors")
DEFAULT_VAE = os.path.join(_DEFAULT_MODELS, "vae", "Qweniamge2.1",
                           "qwen_image_2.1_vae_bf16.safetensors")

#: 官方 Turbo checkpoint 的 sample_sigmas（8 个值 = 8 步；采样时补结尾 0.0）
TURBO_SIGMAS: tuple[float, ...] = (
    1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568,
)

#: 与 ComfyUI `UNETLoader.weight_dtype` 取值一致的合法 dtype
WEIGHT_DTYPES = ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2")

#: 关掉「采样前把文本编码器挪出显存」的环境变量（=1 时保留 CLIP 在卡上）
KEEP_TEXT_ENCODER_ENV = "QWEN_NATIVE_KEEP_TEXT_ENCODER"


class EngineError(RuntimeError):
    """推理引擎错误（配置非法 / 模型缺失 / ComfyUI 模型库不可用 / 采样失败）。"""


# ---------------------------------------------------------------- 纯逻辑（可单测，不 import torch）


def _check_positive_int(value: Any, name: str) -> int:
    # 注意：先判 bool 再判 Integral —— True 是 int 的子类，`int(True)` 会变成 1，
    # 所以不能先做 int() 转换再检查。
    if isinstance(value, bool) or not isinstance(value, numbers.Integral):
        raise EngineError(f"{name} 必须是整数，收到 {value!r}")
    value = int(value)
    if value <= 0:
        raise EngineError(f"{name} 必须为正数，收到 {value!r}")
    return value


def reference_size(width: int, height: int, resolution: int = 0) -> tuple[int, int]:
    """参考图缩放尺寸，逐行复刻 `TextEncodeQwenImage21.execute`。

    - ``resolution > 0``：按面积 ``resolution²`` 等比缩放，再 **四舍五入** 到 32 的倍数。
    - ``resolution == 0``：保持原尺寸，只四舍五入到 32 的倍数。

    注意用的是 Python 内置 ``round``（银行家舍入），节点也是，必须一致。

    :return: ``(width, height)``，最小 32。
    """
    width = _check_positive_int(width, "width")
    height = _check_positive_int(height, "height")
    if isinstance(resolution, bool) or not isinstance(resolution, numbers.Integral):
        raise EngineError(f"resolution 必须是整数，收到 {resolution!r}")
    resolution = int(resolution)
    if resolution < 0:
        raise EngineError(f"resolution 不能为负，收到 {resolution}")
    if resolution > 0:
        ratio = width / height
        w = round(math.sqrt(resolution * resolution * ratio) / SNAP) * SNAP
        h = round(math.sqrt(resolution * resolution / ratio) / SNAP) * SNAP
    else:
        w = round(width / SNAP) * SNAP
        h = round(height / SNAP) * SNAP
    return max(SNAP, w), max(SNAP, h)


def canvas_size(image_sizes: Iterable[tuple[int, int]] | None = None,
                resolution: int = 0) -> tuple[int, int]:
    """编辑画布尺寸 = **第一张**参考图缩放后的尺寸；没有参考图时等于分辨率档。

    与节点的 ``latent_size`` 输出一致：无参考图时 ``resolution or 1024`` 的正方形，
    有参考图时取第一张（排序后第一张，本引擎按传入顺序）。
    """
    sizes = list(image_sizes or [])
    if sizes:
        w, h = sizes[0]
        return reference_size(w, h, resolution)
    r = int(resolution or 0)
    if r <= 0:
        r = DEFAULT_RESOLUTION
    return r, r


def latent_hw(width: int, height: int) -> tuple[int, int]:
    """像素尺寸 → 采样 latent 的 ``(H, W)``（16 倍下采样，向下取整，最小 1）。"""
    width = _check_positive_int(width, "width")
    height = _check_positive_int(height, "height")
    return max(1, height // LATENT_DOWNSCALE), max(1, width // LATENT_DOWNSCALE)


def normalize_sigmas(values: Any, *, append_zero: bool = True) -> list[float]:
    """把外部 sigma 输入规范化成可传给采样器的列表。

    接受 ``list/tuple`` 或 ``"1.0, 0.5, 0"`` 形式的逗号分隔字符串；保证：

    - 全是 ``>= 0`` 的有限浮点数；
    - 单调不增（sigma 调度必须递减，否则采样器行为未定义）；
    - ``append_zero=True`` 时结尾补 ``0.0``（Turbo 官方 sigma 只有 8 个值，补 0 后
      是 9 个值 = 8 步）。已经以 0 结尾则不重复补。

    :raises EngineError: 输入非法。
    """
    if isinstance(values, str):
        text = values.strip()
        if not text:
            raise EngineError("sigmas 字符串为空")
        parts = [p for p in text.replace(";", ",").split(",") if p.strip()]
        raw: list[Any] = [p.strip() for p in parts]
    elif isinstance(values, (list, tuple)):
        raw = list(values)
    else:
        raise EngineError(f"sigmas 必须是 list/tuple/str，收到 {type(values).__name__}")

    if not raw:
        raise EngineError("sigmas 不能为空")

    out: list[float] = []
    for item in raw:
        try:
            val = float(item)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"sigmas 含非数字项: {item!r}") from exc
        if not math.isfinite(val):
            raise EngineError(f"sigmas 含非有限值: {item!r}")
        if val < 0:
            raise EngineError(f"sigmas 不能为负: {val}")
        out.append(val)

    for prev, cur in zip(out, out[1:]):
        if cur > prev:
            raise EngineError(f"sigmas 必须单调不增（{prev} -> {cur}）")

    if append_zero and out[-1] != 0.0:
        out.append(0.0)
    return out


def slice_sigmas_for_denoise(values: Sequence[float], denoise: float) -> list[float]:
    """按 ``denoise`` 截取显式 sigma 列表的尾段（图生图 / 局部重绘用）。

    等价于 ComfyUI `KSampler.set_steps` 里 ``sigmas[-(steps + 1):]`` 的思路：
    ``denoise=0.5`` 时保留后半段调度。结尾的 ``0.0`` 始终保留。
    """
    seq = list(values)
    if not seq:
        return seq
    d = float(denoise)
    if d >= 0.9999:
        return seq
    if d <= 0.0:
        return [seq[-1]] if seq[-1] == 0.0 else [0.0]
    tail = 1 if seq[-1] == 0.0 else 0
    steps = len(seq) - tail
    if steps <= 0:
        return seq
    start = int(round(steps * (1.0 - d)))
    start = max(0, min(start, steps - 1))
    kept = seq[start:]
    if tail and kept[-1] != 0.0:
        kept.append(0.0)
    return kept


def normalize_loras(loras: Iterable[dict] | None) -> list[dict]:
    """校验 LoRA 列表，返回 ``[{"name": 绝对路径, "strength": float, "strength_clip": float}]``。

    ``name`` 可以是 ``"E:/x.safetensors"`` 这样的路径字符串，也可以是
    ``{"path": ...}``。``strength_clip`` 缺省与 ``strength`` 相同。
    """
    out: list[dict] = []
    for idx, item in enumerate(loras or []):
        if not isinstance(item, dict):
            raise EngineError(f"loras[{idx}] 必须是 dict，收到 {type(item).__name__}")
        name = item.get("name") or item.get("path")
        if not name or not isinstance(name, str):
            raise EngineError(f"loras[{idx}] 缺少 name/path")
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError) as exc:
            raise EngineError(f"loras[{idx}].strength 不是数字: {item.get('strength')!r}") from exc
        try:
            strength_clip = float(item.get("strength_clip", strength))
        except (TypeError, ValueError) as exc:
            raise EngineError(
                f"loras[{idx}].strength_clip 不是数字: {item.get('strength_clip')!r}") from exc
        out.append({"name": name, "strength": strength, "strength_clip": strength_clip})
    return out


def as_normal_tensor(tensor):
    """把 **inference tensor** 转成普通张量（`torch.inference_mode()` 里创建的张量）。

    为什么需要它：ComfyUI 的 `comfy.utils.tiled_scale`（以及 `tiled_scale_multidim`）带
    `@torch.inference_mode()`，它产出的张量是 inference tensor。而
    `comfy/sd.py::VAE.encode_tiled_` 用 `samples += ...` / `samples /= 3.0` 原地改这个
    张量——这一句在 inference_mode **之外**执行，于是抛：

        RuntimeError: Inplace update to inference tensor outside InferenceMode is not allowed.

    真机上只在「VAE encode 显存不够 → 自动回退 tiled encode」时才会走到；多参考图（3 张以上）
    显存更紧，就会踩到。引擎的修法是在 `_encode_vae()` 里把整个 encode 调用包进
    `torch.inference_mode()`（让库里的原地操作合法），再用本函数把输出 clone 成普通张量，
    保证后续采样/解码可以安全地原地改。

    **必须在 inference_mode 之外调用**（在模式内 clone 出来仍是 inference tensor）。
    """
    if tensor is None:
        return None
    checker = getattr(tensor, "is_inference", None)
    if callable(checker) and checker():
        tensor = tensor.clone()
    if not tensor.is_contiguous():
        tensor = tensor.contiguous()
    return tensor


def callback_adapter(callback: Callable[[int, int, Any], Any] | None,
                     on_error: list | None = None):
    """把 ComfyUI 采样回调 ``(i, denoised, x, total_steps)`` 适配成契约的
    ``callback(step, total_steps, current_latent)``。

    返回 ``None`` 表示不装回调。**上层在回调里抛的异常（典型的取消信号）会原样向上抛**，
    并且同时记到 ``on_error`` 里，方便 `sample()` 不要把它包成 EngineError。
    """
    if callback is None:
        return None

    def _wrapped(i, denoised, x, total_steps):
        try:
            callback(int(i), int(total_steps), denoised)
        except BaseException as exc:  # 取消/中断：记录后原样抛，采样器会一路带上来
            if on_error is not None:
                on_error.append(exc)
            raise

    return _wrapped


@dataclass
class EngineConfig:
    """引擎配置。

    ``engine_dir`` 是**项目内 vendored 的引擎代码目录**（默认 ``<PROJECT_ROOT>\\engine``，
    内含 ``comfy/`` 与 ``node_helpers.py``）。运行期只 import 这里的代码，
    绝不把原 ComfyUI 安装目录加进 ``sys.path``。

    ``comfy_root`` 是**旧字段名**的兼容别名（等价于 ``engine_dir``）；两者都给时
    ``engine_dir`` 优先。模型权重仍按绝对路径加载（默认复用 ComfyUI 的 ``models/``）。
    """

    engine_dir: str = ""
    unet: str | None = None
    clip: str | None = None
    vae: str | None = None
    vram_reserve: float = 0.15
    dtype: str = "default"
    #: 分块解码的 tile 边长（像素）。实测 1024 比 ComfyUI 默认的 512 快 2.3 倍
    vae_tile_size: int = 1024
    #: 分块解码的重叠像素
    vae_tile_overlap: int = 64
    #: 超过这个输出像素数就直接走分块解码。CLIP 常驻 + 18GB LoRA 时 896² 全量就会 OOM，
    #: 失败一次既浪费 3~5 秒、又会把后续采样拖慢；768²（0.59MP）全量仍更快。
    tiled_decode_threshold: int = 600_000
    #: 旧字段名兼容别名（旧契约里叫 comfy_root）
    comfy_root: str | None = None

    def resolve(self, *, unet: str | None = None, clip: str | None = None,
                vae: str | None = None) -> dict[str, str | None]:
        """合并调用参数与配置默认值，返回三个模型路径（可能为 None）。"""
        return {
            "unet": unet if unet is not None else self.unet,
            "clip": clip if clip is not None else self.clip,
            "vae": vae if vae is not None else self.vae,
        }

    def resolve_dir(self) -> str:
        """``engine_dir`` / 旧别名 ``comfy_root`` 二选一，返回原始字符串。"""
        return self.engine_dir or self.comfy_root or ""


class _Libs:
    """ComfyUI 模块句柄集合（延迟 import，避免每次调用重新解析属性）。"""

    __slots__ = ("torch", "sd", "samplers", "sample", "utils", "mm", "helpers", "node_helpers")

    def __init__(self, torch, sd, samplers, sample, utils, mm, helpers, node_helpers):
        self.torch = torch
        self.sd = sd
        self.samplers = samplers
        self.sample = sample
        self.utils = utils
        self.mm = mm
        self.helpers = helpers
        self.node_helpers = node_helpers


def _conditioning_set_values(conditioning, values: dict, append: bool = False):
    """`node_helpers.conditioning_set_values` 的本地等价实现（兜底用）。"""
    out = []
    for entry in conditioning:
        new = [entry[0], entry[1].copy()]
        for key, val in values.items():
            if append:
                old = new[1].get(key, None)
                if old is not None:
                    val = old + val
            new[1][key] = val
        out.append(new)
    return out


class NativeEngine:
    """Qwen-Image 2.1 进程内推理引擎。

    典型用法::

        engine = NativeEngine(EngineConfig(comfy_root=r"D:\\...\\ComfyUI"))
        engine.ensure_loaded()                       # 装载 unet/clip/vae
        cond = engine.encode_text("a teapot", resolution=0)
        latent = engine.empty_latent(1024, 1024)
        samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                                latent=latent, sigmas=TURBO_SIGMAS, steps=8, cfg=1.0)
        image = engine.decode(samples)               # RGBA PIL Image

    线程模型：模型装载/编码/采样/解码走 `self._gen_lock` 串行（GPU 不能并发）；
    `status()` 不加锁，采样进行中也能立刻返回（供 /api/health 轮询）。
    """

    def __init__(self, config: EngineConfig) -> None:
        if not isinstance(config, EngineConfig):
            raise EngineError("config 必须是 EngineConfig")
        self.config = config
        self.config.engine_dir = self._normalize_engine_dir(config.resolve_dir())
        if config.dtype not in WEIGHT_DTYPES:
            raise EngineError(
                f"dtype 非法: {config.dtype!r}，可选 {list(WEIGHT_DTYPES)}")
        try:
            reserve = float(config.vram_reserve)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"vram_reserve 不是数字: {config.vram_reserve!r}") from exc
        if not (0.0 <= reserve < 1.0):
            raise EngineError(f"vram_reserve 必须在 [0,1)，收到 {reserve}")
        self.config.vram_reserve = reserve

        self._gen_lock = threading.RLock()
        self._lib_lock = threading.Lock()
        self._libs: _Libs | None = None
        self._lib_error: str | None = None

        self._base_model = None      # 未挂 LoRA 的 model patcher
        self._base_clip = None
        self._model = None           # 当前生效（可能已挂 LoRA）
        self._clip = None
        self._vae = None
        self._paths: dict[str, str | None] = {"unet": None, "clip": None, "vae": None}
        self._loras: list[dict] = []
        self._text_encoder_offloaded = False
        self._pending_loras: list[dict] = []

        # 观测数据（status() 与 docs 用）
        self._load_seconds: float | None = None
        self._last_clip_reload_seconds: float | None = None
        self._last_sample_seconds: float | None = None
        self._last_decode_seconds: float | None = None

    # ------------------------------------------------------------ 路径/依赖

    @staticmethod
    def _normalize_engine_dir(path: str) -> str:
        """容错：允许传引擎目录本身，也允许传它的上级（工作区根目录）。"""
        if not path or not isinstance(path, str):
            # 允许空串：让 status() 报 available=False + reason，而不是构造就炸
            return ""
        root = os.path.abspath(os.path.expanduser(path))
        if os.path.isfile(os.path.join(root, "comfy", "sd.py")):
            return root
        nested = os.path.join(root, "engine")
        if os.path.isfile(os.path.join(nested, "comfy", "sd.py")):
            return nested
        # 不在构造时抛错：让 status() 能报 available=False + reason
        return root

    def _load_libs(self) -> _Libs:
        """导入项目内 vendored 的 ComfyUI 模型库（只 import 不修改）。

        关键自检：``comfy.sd`` / ``node_helpers`` 必须解析到 ``engine_dir`` 之内。
        如果解析到外面，说明 ``sys.path`` 里混进了原 ComfyUI 源码目录（或有人忘了移植
        引擎），此时抛 EngineError——**绝不能悄悄依赖项目外的代码**。
        """
        if self._libs is not None:
            return self._libs
        with self._lib_lock:
            if self._libs is not None:
                return self._libs
            if self._lib_error is not None:
                raise EngineError(self._lib_error)

            root = self.config.engine_dir
            if not root:
                self._lib_error = (
                    "engine_dir 为空：请指向项目内 engine/（含 comfy/ 的目录），"
                    f"默认应为 {DEFAULT_ENGINE_DIR}")
                raise EngineError(self._lib_error)
            if not os.path.isfile(os.path.join(root, "comfy", "sd.py")):
                self._lib_error = (
                    f"engine_dir 下找不到 comfy/sd.py: {root}"
                    "（应指向项目内 engine/，先跑 scripts\\port_engine.ps1 移植）")
                raise EngineError(self._lib_error)

            if root not in sys.path:
                sys.path.insert(0, root)

            try:
                import torch  # noqa: F401  (延迟导入：import torch 约 1.5s)
                import comfy.sd as _sd
                import comfy.samplers as _samplers
                import comfy.sample as _sample
                import comfy.utils as _utils
                import comfy.model_management as _mm
                import comfy.sampler_helpers as _helpers
            except Exception as exc:  # pragma: no cover - 依赖环境
                self._lib_error = f"导入引擎模型库失败（engine_dir={root}）: {exc}"
                raise EngineError(self._lib_error) from exc

            try:
                import node_helpers as _node_helpers
            except Exception:  # pragma: no cover - 极少数精简移植
                _node_helpers = None

            self._assert_imports_inside(root, _sd, _node_helpers)
            # 对齐 ComfyUI main.py 的启动设置（我们是直接 import 引擎，不会走它的 main）：
            #  * set_cudnn_benchmark() 内部会开 SDPA 的 fp16/bf16 归约（torch>=2.5），
            #    这项对 attention 吞吐影响很大（实测不开采样慢 ~2 倍）
            #  * cudnn.benchmark=True 让 VAE 卷积自动选算法
            try:
                _mm.set_cudnn_benchmark()
                logger.info("已应用 ComfyUI 的 cudnn/SDPA 性能设置")
            except Exception:  # pragma: no cover - 老版本没有这个函数
                logger.debug("set_cudnn_benchmark 不可用", exc_info=True)
            # 注意：不要开 torch.backends.cudnn.benchmark = True。
            # 实测在 2.3MP VAE 解码时会触发 cudnn autotune，首图解码从 3.8s 飙到 120s。
            # ComfyUI 默认也没开（只有 --fast 才开）。

            self._libs = _Libs(torch, _sd, _samplers, _sample, _utils, _mm,
                               _helpers, _node_helpers)
            return self._libs

    def _assert_imports_inside(self, root: str, sd_module, node_helpers_module) -> None:
        """断言 comfy / node_helpers 都来自 engine_dir 内部。"""
        root_abs = os.path.abspath(root)
        prefix = root_abs + os.sep

        sd_file = os.path.abspath(getattr(sd_module, "__file__", "") or "")
        if not sd_file.startswith(prefix):
            self._lib_error = (
                f"comfy.sd 解析到了 engine_dir 之外：{sd_file}（期望在 {root_abs} 下）。"
                "说明 sys.path 里混入了外部 ComfyUI 源码目录，或引擎还没移植到项目内。"
                "请只把项目内 engine/ 加进 sys.path。")
            raise EngineError(self._lib_error)

        if node_helpers_module is not None:
            nh_file = os.path.abspath(getattr(node_helpers_module, "__file__", "") or "")
            if not nh_file.startswith(prefix):
                self._lib_error = (
                    f"node_helpers 解析到了 engine_dir 之外：{nh_file}（期望在 {root_abs} 下）")
                raise EngineError(self._lib_error)

    def _model_options(self) -> dict:
        """UNETLoader 的 weight_dtype → model_options 映射。"""
        if self.config.dtype == "default":
            return {}
        libs = self._load_libs()
        torch = libs.torch
        if self.config.dtype == "fp8_e4m3fn":
            return {"dtype": torch.float8_e4m3fn}
        if self.config.dtype == "fp8_e4m3fn_fast":
            return {"dtype": torch.float8_e4m3fn, "fp8_optimizations": True}
        if self.config.dtype == "fp8_e5m2":
            return {"dtype": torch.float8_e5m2}
        raise EngineError(f"dtype 非法: {self.config.dtype!r}")

    # ------------------------------------------------------------ 状态

    def _vram_state(self) -> tuple[int, int]:
        """返回 ``(total_mb, free_mb)``。优先 torch 实测量（能反映别的进程占用）。"""
        try:
            libs = self._load_libs()
        except EngineError:
            return 0, 0
        torch = libs.torch
        try:
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                return int(total // (1024 * 1024)), int(free // (1024 * 1024))
        except Exception:  # pragma: no cover
            pass
        try:
            total = int(libs.mm.get_total_memory() // (1024 * 1024))
            free = int(libs.mm.get_free_memory() // (1024 * 1024))
            return total, free
        except Exception:  # pragma: no cover
            return 0, 0

    def status(self) -> dict:
        """引擎状态（不加锁，采样中也能调用）。

        ``available`` 表示「能推理的基础设施是否就绪」（ComfyUI 模型库可 import +
        CUDA 可用）；具体模型是否装载看 ``loaded``。
        """
        loaded = {
            "unet": self._paths.get("unet"),
            "clip": self._paths.get("clip"),
            "vae": self._paths.get("vae"),
            "loras": [{"name": it["name"], "strength": it["strength"]} for it in self._loras],
        }
        info: dict[str, Any] = {
            "available": False,
            "reason": None,
            "engine_dir": self.config.engine_dir,
            # 旧字段名，保留给旧调用方（与 engine_dir 同值）
            "comfy_root": self.config.engine_dir,
            "device": None,
            "vram_total_mb": 0,
            "vram_free_mb": 0,
            "loaded": loaded,
            "text_encoder_offloaded": self._text_encoder_offloaded,
        "warmup_s": getattr(self, "_last_warmup_seconds", None),
            "timings": {
                "load_s": self._load_seconds,
                "clip_reload_s": self._last_clip_reload_seconds,
                "sample_s": self._last_sample_seconds,
                "decode_s": self._last_decode_seconds,
            },
        }
        try:
            libs = self._load_libs()
        except EngineError as exc:
            info["reason"] = str(exc)
            return info

        info["available"] = True
        try:
            info["device"] = str(libs.mm.get_torch_device())
        except Exception:  # pragma: no cover
            info["device"] = "unknown"

        total_mb, free_mb = self._vram_state()
        info["vram_total_mb"] = total_mb
        info["vram_free_mb"] = free_mb

        if not libs.torch.cuda.is_available():
            info["available"] = False
            info["device"] = "cpu"
            info["reason"] = "CUDA 不可用，Qwen-Image 2.1 需要 GPU"
        return info

    # ------------------------------------------------------------ 模型生命周期

    def _validate_targets(self, target: dict[str, str | None]) -> dict[str, str]:
        """校验三个模型路径（先于 import torch，保证错误分支又快又准）。"""
        missing = [k for k in ("unet", "clip", "vae") if not target.get(k)]
        if missing:
            raise EngineError(
                "缺少模型路径: " + ", ".join(missing)
                + "（请在 EngineConfig 或 ensure_loaded() 里指定绝对路径）")
        resolved: dict[str, str] = {}
        for key in ("unet", "clip", "vae"):
            path = os.path.abspath(os.path.expanduser(str(target[key])))
            if not os.path.isfile(path):
                raise EngineError(f"{key} 模型文件不存在: {path}")
            resolved[key] = path
        return resolved

    def ensure_loaded(self, *, unet: str | None = None, clip: str | None = None,
                      vae: str | None = None) -> None:
        """确保指定的模型组已装载。

        三个路径任一与当前装载不同 → 全部卸载重载（换模型不玩增量）。
        同一套模型重复调用会立刻返回（毫秒级），不会重新读盘。
        """
        target = self._validate_targets(self.config.resolve(unet=unet, clip=clip, vae=vae))

        with self._gen_lock:
            if (self._model is not None and self._clip is not None and self._vae is not None
                    and self._paths == target):
                # 同一套模型：把可能被挪走的文本编码器装回来即可
                self._ensure_text_encoder_loaded()
                return

            libs = self._load_libs()
            t0 = time.time()
            prev_loras = list(self._loras)
            self._unload_models(log=False)
            try:
                logger.info("装载 diffusion model: %s", target["unet"])
                model = libs.sd.load_diffusion_model(target["unet"],
                                                     model_options=self._model_options())
                logger.info("装载 text encoder: %s", target["clip"])
                clip_obj = libs.sd.load_clip([target["clip"]], embedding_directory=None,
                                             clip_type=libs.sd.CLIPType.QWEN_IMAGE)
                logger.info("装载 vae: %s", target["vae"])
                vae_sd = libs.utils.load_torch_file(target["vae"])
                vae = libs.sd.VAE(sd=vae_sd)
            except EngineError:
                raise
            except Exception as exc:
                self._unload_models(log=False)
                raise EngineError(f"模型装载失败: {exc}") from exc

            self._base_model, self._base_clip, self._vae = model, clip_obj, vae
            self._model, self._clip = model, clip_obj
            self._paths = dict(target)  # type: ignore[assignment]
            self._loras = []
            self._text_encoder_offloaded = False
            self._load_seconds = round(time.time() - t0, 3)
            logger.info("模型装载完成 %.2fs（权重多为 mmap 延迟加载，首次编码才会真正上卡）",
                        self._load_seconds)

            # 若之前配过 LoRA，重载后按原样重新挂上
            if prev_loras:
                self.apply_loras(prev_loras)

    def apply_loras(self, loras: list[dict]) -> None:
        """把 LoRA 挂到当前模型上。

        ``loras = [{"name": "绝对路径", "strength": 1.0}]``；传空列表 = 恢复基础模型。
        实现是 `comfy.sd.load_lora_for_models` 的链式克隆：始终从「未挂 LoRA 的基座」
        重新叠加，所以重复调用同一组 LoRA 是幂等的。
        """
        norm = normalize_loras(loras)

        with self._gen_lock:
            # 同一组 LoRA 已经挂着：直接返回。
            # 否则每次出图都要重新 load_torch_file + 逐层 patch（18GB 适配器是灾难级慢）
            if norm and self._loras and [
                (os.path.abspath(os.path.expanduser(i["name"])), float(i["strength"]),
                 float(i.get("strength_clip", i["strength"])))
                for i in norm
            ] == [
                (i["name"], float(i["strength"]), float(i.get("strength_clip", i["strength"])))
                for i in self._loras
            ]:
                return
            if self._model is None or self._clip is None or self._vae is None:
                raise EngineError("模型未装载，先调用 ensure_loaded() 再 apply_loras()")
            for idx, item in enumerate(norm):
                path = os.path.abspath(os.path.expanduser(item["name"]))
                if not os.path.isfile(path):
                    raise EngineError(f"loras[{idx}] 文件不存在: {path}")
                item["name"] = path

            libs = self._load_libs()
            if not norm:
                self._model = self._base_model
                self._clip = self._base_clip
                self._loras = []
                self._text_encoder_offloaded = False
                return

            model, clip_obj = self._base_model, self._base_clip
            try:
                for item in norm:
                    lora_sd = libs.utils.load_torch_file(item["name"])
                    model, clip_obj = libs.sd.load_lora_for_models(
                        model, clip_obj, lora_sd, item["strength"], item["strength_clip"])
            except Exception as exc:
                raise EngineError(f"LoRA 装载失败: {exc}") from exc

            self._model, self._clip = model, clip_obj
            self._loras = [{"name": it["name"], "strength": it["strength"]}
                           for it in norm]
            self._text_encoder_offloaded = False

    def warmup(self, *, size: int = 256, width: int | None = None,
               height: int | None = None, steps: int = 1) -> float:
        """预热 kernel：跑一次极小尺寸采样 + 解码，把「首图特别慢」的成本前移一部分。

        ComfyUI 首次采样/解码会做 cudnn/attention 的算法选择，实测量级：
        1024×1024 首图采样 15s、VAE 解码 4.4s；预热后同样的图只要 5.9s / 0.2s。
        返回耗时（秒）；失败只记日志，不影响出图。
        """
        if self._model is None:
            return 0.0
        t0 = time.time()
        try:
            sigmas = [1.0, 0.0] if steps <= 1 else [1.0, 0.5, 0.0]
            w = max(64, int(width or size))
            h = max(64, int(height or size))
            cond = self.encode_text("warmup", "")
            samples = self.sample(
                positive=cond["positive"], negative=cond["negative"], latent=None,
                width=w, height=h, batch=1,
                sigmas=sigmas, steps=len(sigmas) - 1, cfg=1.0,
                sampler="euler", scheduler="simple", seed=0, denoise=1.0,
            )
            self.decode(samples)
        except Exception:  # pragma: no cover - 预热失败不影响出图
            logger.warning("引擎预热失败（忽略）", exc_info=True)
        elapsed = round(time.time() - t0, 3)
        logger.info("引擎预热完成 %.2fs", elapsed)
        self._last_warmup_seconds = elapsed
        return elapsed

    def _unload_models(self, *, log: bool = True) -> None:
        """丢弃所有模型对象并归还显存（ComfyUI 的 current_loaded_models 也要清）。"""
        self._model = None
        self._base_model = None
        self._clip = None
        self._base_clip = None
        self._vae = None
        self._paths = {"unet": None, "clip": None, "vae": None}
        self._loras = []
        self._text_encoder_offloaded = False
        if self._libs is not None:
            try:
                self._libs.mm.unload_all_models()
            except Exception:  # pragma: no cover
                logger.warning("unload_all_models 失败", exc_info=True)
            try:
                self._libs.mm.soft_empty_cache()
            except Exception:  # pragma: no cover
                pass
        gc.collect()
        if log:
            logger.info("模型已卸载")

    def free(self, *, unload: bool = False) -> None:
        """归还显存。``unload=False`` 只清缓存；``unload=True`` 卸载全部模型。"""
        with self._gen_lock:
            if unload:
                self._unload_models()
                return
            if self._libs is not None:
                try:
                    self._libs.mm.soft_empty_cache()
                except Exception:  # pragma: no cover
                    pass
            gc.collect()

    # ------------------------------------------------------------ 文本编码器上下卡

    def _text_encoder_offload_skipped(self) -> bool:
        return os.environ.get(KEEP_TEXT_ENCODER_ENV, "").strip().lower() in (
            "1", "true", "yes", "on")

    def _offload_text_encoder(self) -> None:
        """把 CLIP 权重挪出显存（采样/解码阶段用不到它）。"""
        if self._clip is None or self._text_encoder_offloaded:
            return
        if self._text_encoder_offload_skipped():
            return
        libs = self._libs
        if libs is None:
            return
        try:
            t0 = time.time()
            libs.mm.unload_model_and_clones(self._clip.patcher)
            libs.mm.soft_empty_cache()
            self._text_encoder_offloaded = True
            logger.info("文本编码器已挪出显存（%.2fs），腾给采样/VAE", time.time() - t0)
        except Exception:  # pragma: no cover - 老版本 ComfyUI 没这个函数
            logger.warning("文本编码器 offload 失败，继续（不影响正确性）", exc_info=True)

    def _ensure_text_encoder_loaded(self) -> None:
        """需要编码时把 CLIP 装回显存；返回耗时写入 self._last_clip_reload_seconds。"""
        if self._clip is None or not self._text_encoder_offloaded:
            return
        libs = self._libs
        if libs is None:
            return
        t0 = time.time()
        libs.mm.load_models_gpu([self._clip.patcher])
        self._text_encoder_offloaded = False
        self._last_clip_reload_seconds = round(time.time() - t0, 3)
        logger.info("文本编码器重新上卡 %.2fs", self._last_clip_reload_seconds)

    # ------------------------------------------------------------ 编解码工具

    @staticmethod
    def _require_pillow():
        try:
            from PIL import Image
        except Exception as exc:  # pragma: no cover
            raise EngineError(f"PIL 不可用: {exc}") from exc
        return Image

    def image_to_tensor(self, image):
        """PIL Image → ``[1, H, W, 4]`` float32（0~1，CPU）。

        一律按 RGBA 处理：没有 alpha 的一律视为全不透明（alpha=1.0），
        与 ComfyUI `LoadImage` 的输出习惯一致。
        """
        libs = self._load_libs()
        Image = self._require_pillow()
        if not isinstance(image, Image.Image):
            raise EngineError(f"需要 PIL.Image.Image，收到 {type(image).__name__}")
        import numpy as np
        arr = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
        arr = np.ascontiguousarray(arr)
        return libs.torch.from_numpy(arr).unsqueeze(0)

    def tensor_to_image(self, tensor) -> Any:
        """``[1, H, W, C]`` 0~1 张量 → PIL Image（C=4 → RGBA，C=3 → RGB）。"""
        Image = self._require_pillow()
        import numpy as np
        arr = tensor.detach().float().cpu().clamp(0, 1).numpy()
        if arr.ndim == 4:
            arr = arr[0]
        arr = (arr * 255.0).round().astype(np.uint8)
        if arr.shape[-1] >= 4:
            return Image.fromarray(arr[..., :4], "RGBA")
        if arr.shape[-1] == 3:
            return Image.fromarray(arr[..., :3], "RGB")
        if arr.shape[-1] == 1:
            return Image.fromarray(arr[..., 0], "L")
        raise EngineError(f"无法转换张量形状 {tuple(tensor.shape)}")

    # ------------------------------------------------------------ 文本编码

    def encode_text(self, prompt: str, negative_prompt: str = "",
                    images: list | None = None,
                    resolution: int = 0) -> dict:
        """文本 + 参考图编码，**逐行复刻** `TextEncodeQwenImage21.execute`。

        :param prompt: 正向提示词
        :param negative_prompt: 负向提示词（可为空串）
        :param images: 0..N 张 PIL Image；第 1 张决定 canvas 尺寸
        :param resolution: >0 按面积 resolution² 缩放参考图并 32 对齐；0 各自保持原尺寸
        :return: ``{"positive": COND, "negative": COND, "canvas": (w, h)}``
        """
        if prompt is None or not isinstance(prompt, str):
            raise EngineError("prompt 必须是字符串")
        if negative_prompt is None:
            negative_prompt = ""
        if not isinstance(negative_prompt, str):
            raise EngineError("negative_prompt 必须是字符串")
        try:
            resolution = int(resolution or 0)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"resolution 不是整数: {resolution!r}") from exc
        if resolution < 0:
            raise EngineError(f"resolution 不能为负: {resolution}")

        if images is None:
            images = []
        elif not isinstance(images, (list, tuple)):
            images = [images]
        images = [im for im in images if im is not None]

        with self._gen_lock:
            self._require_loaded()
            libs = self._load_libs()
            self._ensure_text_encoder_loaded()

            Image = self._require_pillow()
            for idx, im in enumerate(images):
                if not isinstance(im, Image.Image):
                    raise EngineError(f"images[{idx}] 不是 PIL.Image.Image")

            images_vl: list[Any] = []
            ref_latents: list[Any] = []
            canvas_w = canvas_h = int(resolution or 0) or DEFAULT_RESOLUTION

            for idx, im in enumerate(images):
                tensor = self.image_to_tensor(im)      # [1,H,W,4]
                samples = tensor[:1].movedim(-1, 1)    # [1,4,H,W]
                src_h, src_w = int(samples.shape[2]), int(samples.shape[3])
                width, height = reference_size(src_w, src_h, resolution)

                if (width, height) == (src_w, src_h):
                    scaled = tensor[:1]                # 尺寸已对齐，不做重采样
                else:
                    scaled = libs.utils.common_upscale(
                        samples, width, height, "lanczos", "disabled").movedim(1, -1)

                if idx == 0:
                    canvas_w, canvas_h = width, height

                rgb = scaled[:, :, :, :3]
                if scaled.shape[-1] > 3:
                    # VLM 看「白底合成」后的 RGB，VAE 仍保留 4 通道（含 alpha）
                    alpha = scaled[:, :, :, 3:]
                    rgb = rgb * alpha + (1.0 - alpha)
                images_vl.append(rgb)
                if self._vae is not None:
                    # 走统一入口：内部包 inference_mode + 输出转普通张量（见 _encode_vae）
                    ref_latents.append(self._encode_vae(scaled))

            keep_vision = len(ref_latents) == 0
            positive = self._encode_one(libs, prompt, images_vl, keep_vision)
            negative = self._encode_one(libs, negative_prompt, images_vl, keep_vision)

            if ref_latents:
                values = {"reference_latents": ref_latents}
                positive = self._set_cond_values(libs, positive, values)
                negative = self._set_cond_values(libs, negative, values)

            self._text_encoder_offloaded = False
            return {"positive": positive, "negative": negative,
                    "canvas": (int(canvas_w), int(canvas_h))}

    def _encode_one(self, libs: _Libs, text: str, images_vl: list, keep_vision: bool):
        tokens = self._clip.tokenize(text, images=images_vl, keep_vision=keep_vision,
                                     prevent_empty_text=True)
        return self._clip.encode_from_tokens_scheduled(tokens)

    @staticmethod
    def _set_cond_values(libs: _Libs, conditioning, values: dict):
        if libs.node_helpers is not None:
            return libs.node_helpers.conditioning_set_values(conditioning, values, append=True)
        return _conditioning_set_values(conditioning, values, append=True)

    # ------------------------------------------------------------ VAE / latent

    def _encode_vae(self, pixels):
        """VAE 编码唯一的入口（encode_text 的参考图 + encode_latent 都走这里）。

        两步都是必需的：

        1. **整个 encode 调用包在 `torch.inference_mode()` 里**。ComfyUI 的
           `comfy.utils.tiled_scale` 自己在 inference_mode 内运行，而
           `comfy/sd.py::VAE.encode_tiled_` 又对它的产出做 `samples += ...` / `/= 3.0`
           原地运算——只有让外层也处于 inference_mode，这些原地操作才合法。
        2. 出来后用 `as_normal_tensor()` clone 成普通张量。否则常规路径产出的 latent 也是
           inference tensor，后续采样对 latent 的原地操作会抛同样的错。

        真机触发条件：VAE encode 显存不足 → 自动回退 tiled encode（多参考图时更容易发生）。
        """
        libs = self._load_libs()
        torch = libs.torch
        # 先把 VAE 权重上卡（放在 inference_mode 之外，避免在推理上下文里搬权重）
        try:
            patcher = getattr(self._vae, "patcher", None)
            if patcher is not None:
                libs.mm.load_models_gpu([patcher])
        except Exception:  # pragma: no cover - 交给 encode 内部再处理
            logger.debug("VAE 预上卡失败", exc_info=True)
        with torch.inference_mode():
            out = self._vae.encode(pixels)
        return as_normal_tensor(out)

    def encode_latent(self, image):
        """VAE 编码一张图 → ``[1, 64, H/16, W/16]`` latent（局部编辑用）。"""
        Image = self._require_pillow()
        if not isinstance(image, Image.Image):
            raise EngineError(f"encode_latent 需要 PIL.Image.Image，收到 {type(image).__name__}")
        with self._gen_lock:
            self._require_loaded(need_clip=False)
            tensor = self.image_to_tensor(image)
            try:
                return self._encode_vae(tensor)
            except EngineError:
                raise
            except Exception as exc:
                raise EngineError(f"VAE 编码失败: {exc}") from exc

    def empty_latent(self, width: int, height: int, batch: int = 1):
        """按画布尺寸造空 latent ``[batch, 64, h//16, w//16]``（64 通道 / 16 倍下采样）。

        pipeline 走 ``sample(latent=None, width=..., height=...)`` 时引擎内部用的就是它。
        """
        libs = self._load_libs()
        return self._make_empty_latent(libs, width, height, batch)

    # ------------------------------------------------------------ 采样

    def _require_loaded(self, *, need_clip: bool = True, need_vae: bool = True,
                        need_model: bool = True) -> None:
        problems = []
        if need_model and self._model is None:
            problems.append("unet")
        if need_clip and self._clip is None:
            problems.append("clip")
        if need_vae and self._vae is None:
            problems.append("vae")
        if problems:
            raise EngineError(
                "模型未装载: " + ", ".join(problems) + "；先调用 ensure_loaded()")

    def resolve_sigmas(self, sigmas, *, steps: int, scheduler: str = "simple",
                       denoise: float = 1.0):
        """把 ``sigmas`` 输入解析成采样用的 1D FloatTensor。

        - 给定显式 sigma：规范化（补结尾 0.0）+ 按 denoise 截尾；**忽略 steps/scheduler**。
        - 给 None：走 ``comfy.samplers.calculate_sigmas(model_sampling, scheduler, steps)``，
          denoise<1 时按 `KSampler.set_steps` 的做法 ``steps/denoise`` 取尾段。
        """
        libs = self._load_libs()
        torch = libs.torch
        try:
            steps = int(steps)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"steps 不是整数: {steps!r}") from exc
        if steps < 1:
            raise EngineError(f"steps 必须 >= 1，收到 {steps}")
        try:
            denoise = float(denoise)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"denoise 不是数字: {denoise!r}") from exc
        if not (0.0 <= denoise <= 1.0):
            raise EngineError(f"denoise 必须在 [0,1]，收到 {denoise}")

        if sigmas is not None:
            values = normalize_sigmas(sigmas)
            values = slice_sigmas_for_denoise(values, denoise)
            return torch.FloatTensor(values)

        model_sampling = self._model.get_model_object("model_sampling")
        if denoise >= 0.9999:
            return self._calculate_sigmas(libs, model_sampling, scheduler, steps)
        if denoise <= 0.0:
            return torch.FloatTensor([])
        new_steps = int(steps / denoise)
        sig = self._calculate_sigmas(libs, model_sampling, scheduler, new_steps)
        return sig[-(steps + 1):]

    @staticmethod
    def _calculate_sigmas(libs: _Libs, model_sampling, scheduler: str, steps: int):
        try:
            return libs.samplers.calculate_sigmas(model_sampling, scheduler, int(steps))
        except ValueError as exc:
            raise EngineError(
                f"未知 scheduler: {scheduler!r}（ComfyUI 支持 {libs.samplers.SCHEDULER_NAMES}）"
            ) from exc
        except Exception as exc:
            raise EngineError(f"sigma 计算失败: {exc}") from exc

    def sample(self, *, positive, negative, latent=None, sigmas=None,
               steps: int, cfg: float, sampler: str = "euler", scheduler: str = "simple",
               seed: int = 0, denoise: float = 1.0,
               width: int | None = None, height: int | None = None, batch: int = 1,
               noise_mask=None, callback: Callable[[int, int, Any], Any] | None = None):
        """执行采样。

        :param latent: 已有 latent（VAE 编码后的图像 latent）。传 ``None`` 时按
            ``width/height/batch`` 在引擎内部造空 latent（t2i 用，省得 pipeline import torch）
        :param sigmas: 显式 sigma 列表（Turbo）；``None`` 走 scheduler 默认路径
        :param width,height,batch: ``latent is None`` 时使用的画布尺寸与批量
        :param noise_mask: 局部编辑遮罩，等价 SetLatentNoiseMask。接受
            ``np.float32 (H, W)``（**像素尺寸**，不是 latent 尺寸，值域 0..1，1=重绘）、
            PIL ``L`` 图、或已 reshape 好的 tensor；引擎内部按 latent 形状插值。
        :param callback: ``callback(step, total_steps, current_latent)``，用于进度条；
            在回调里抛异常可以中断采样（取消任务），该异常会原样抛给上层，不包裹成
            EngineError。
        :return: 采样后的 latent（形状与输入 latent 一致）
        """
        callback_errors: list[BaseException] = []
        callback_wrapped = callback_adapter(callback, on_error=callback_errors)
        try:
            cfg = float(cfg)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"cfg 不是数字: {cfg!r}") from exc
        try:
            seed = int(seed)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"seed 不是整数: {seed!r}") from exc

        with self._gen_lock:
            self._require_loaded()
            libs = self._load_libs()
            torch = libs.torch

            # 采样前把文本编码器挪走（8.9GB int8 权重，采样期完全用不到）
            self._offload_text_encoder()

            if latent is None:
                latent = self._make_empty_latent(libs, width, height, batch)
            else:
                latent = self._validate_latent(libs, latent)
                # 防御：调用方若把 inference tensor 传进来（例如自己用 tiled VAE 产出的），
                # 采样器对 latent 的原地操作会抛 "Inplace update to inference tensor ..."。
                latent = as_normal_tensor(latent)

            sig_tensor = self.resolve_sigmas(sigmas, steps=steps, scheduler=scheduler,
                                             denoise=denoise)
            if sig_tensor.shape[-1] == 0:
                logger.info("sigma 为空（denoise=0），直接返回输入 latent")
                return latent

            sampler_obj = self._sampler_object(libs, sampler)

            guider = libs.samplers.CFGGuider(self._model)
            guider.set_conds(positive, negative)
            guider.set_cfg(cfg)

            try:
                latent_image = libs.sample.fix_empty_latent_channels(
                    guider.model_patcher, latent, None, None)
            except Exception as exc:
                raise EngineError(f"latent 预处理失败: {exc}") from exc

            mask = self._prepare_noise_mask(libs, noise_mask, latent_image)
            noise = libs.sample.prepare_noise(latent_image, seed)

            t0 = time.time()
            try:
                out = guider.sample(noise, latent_image, sampler_obj, sig_tensor,
                                    denoise_mask=mask, callback=callback_wrapped,
                                    disable_pbar=True, seed=seed)
            except EngineError:
                raise
            except Exception as exc:
                if callback_errors:
                    # 上层回调里抛的取消信号：原样传播，别包成 EngineError
                    raise callback_errors[0] from None
                raise EngineError(f"采样失败: {exc}") from exc
            self._last_sample_seconds = round(time.time() - t0, 3)
            logger.info("采样完成 %.2fs（%s, %d 步, cfg=%s, seed=%s）",
                        self._last_sample_seconds, sampler,
                        max(0, sig_tensor.shape[-1] - 1), cfg, seed)
            return out

    def _make_empty_latent(self, libs: _Libs, width, height, batch):
        """``torch.zeros([batch, 64, h//16, w//16])``（与 TextEncodeQwenImage21 的 latent 输出一致）。"""
        if width is None or height is None:
            raise EngineError(
                "latent 为空时必须给 width/height（引擎内部造空 latent）")
        try:
            width = int(width)
            height = int(height)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"width/height 不是整数: {width!r}/{height!r}") from exc
        if width <= 0 or height <= 0:
            raise EngineError(f"width/height 必须为正：{width}x{height}")
        try:
            batch = int(batch or 1)
        except (TypeError, ValueError) as exc:
            raise EngineError(f"batch 不是整数: {batch!r}") from exc
        if batch < 1:
            raise EngineError(f"batch 必须 >= 1，收到 {batch}")
        lh, lw = latent_hw(width, height)
        return libs.torch.zeros([batch, LATENT_CHANNELS, lh, lw],
                                device=libs.mm.intermediate_device())

    @staticmethod
    def _validate_latent(libs: _Libs, latent):
        torch = libs.torch
        if not torch.is_tensor(latent):
            raise EngineError(f"latent 必须是 torch.Tensor，收到 {type(latent).__name__}")
        if latent.ndim != 4:
            raise EngineError(f"latent 必须是 4 维 [B, 64, H/16, W/16]，收到 {tuple(latent.shape)}")
        if latent.shape[1] != LATENT_CHANNELS:
            raise EngineError(
                f"latent 通道数必须是 {LATENT_CHANNELS}，收到 {latent.shape[1]}"
                f"（形状 {tuple(latent.shape)}）")
        return latent

    @staticmethod
    def _sampler_object(libs: _Libs, name: str):
        try:
            obj = libs.samplers.sampler_object(str(name))
        except AttributeError as exc:
            raise EngineError(
                f"未知 sampler: {name!r}（ComfyUI 支持 {libs.samplers.SAMPLER_NAMES}）") from exc
        except Exception as exc:
            raise EngineError(f"sampler 创建失败: {exc}") from exc
        if obj is None:
            raise EngineError(f"sampler_object({name!r}) 返回 None")
        return obj

    @staticmethod
    def _prepare_noise_mask(libs: _Libs, noise_mask, latent_image):
        """把 ``noise_mask`` 规范成可交给采样器的 float tensor。

        接受：``np.float32 (H, W)``（像素尺寸，0..1）、PIL ``L`` 图、torch tensor。
        像素尺寸的遮罩会按 latent 形状插值——这与 ComfyUI `SetLatentNoiseMask` +
        `comfy.sampler_helpers.prepare_mask` 的行为一致。
        """
        if noise_mask is None:
            return None
        torch = libs.torch
        try:
            mask = noise_mask
            if not torch.is_tensor(mask):
                Image = NativeEngine._require_pillow()
                if isinstance(mask, Image.Image):
                    import numpy as np
                    mask = np.asarray(mask.convert("L"), dtype="float32") / 255.0
                import numpy as np
                mask = torch.from_numpy(np.ascontiguousarray(np.asarray(mask, dtype="float32")))
            mask = mask.float()
            if mask.ndim == 4:
                # (B,1,H,W) 直接用；多通道取第一通道（语义上只允许单通道遮罩）
                if mask.shape[1] != 1:
                    mask = mask[:, :1]
            elif mask.ndim not in (2, 3):
                raise EngineError(
                    f"noise_mask 形状不受支持：{tuple(mask.shape)}（期望 (H,W)、(1,H,W) 或 (1,1,H,W)）")
            shape = tuple(latent_image.shape)
            if tuple(mask.shape) != shape:
                # 等价于 SetLatentNoiseMask 节点的 reshape：把像素空间遮罩贴到 latent 形状
                mask = libs.helpers.prepare_mask(mask, shape, mask.device)
            return as_normal_tensor(mask)
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(f"noise_mask 处理失败: {exc}") from exc

    # ------------------------------------------------------------ 解码

    def _decode_pixels(self, samples) -> int:
        """latent 形状 → 输出像素数（latent_h*16 × latent_w*16）。"""
        if samples.ndim != 4:
            return 0
        return int(samples.shape[-2]) * LATENT_DOWNSCALE * int(samples.shape[-1]) * LATENT_DOWNSCALE

    def _free_torch_mb(self, libs) -> int:
        """返回当前空闲显存（MB）；拿不到就返回 0。"""
        try:
            free, _total = libs.torch.cuda.mem_get_info()
            return int(free // (1024 * 1024))
        except Exception:  # pragma: no cover
            return 0

    def _decode_tiled(self, libs, samples):
        """分块解码，tile 尺寸按**当前空闲显存**自适应。

        实测（2016×1152，cu130）：
          * 全量解码会 OOM，而且要 5.6s
          * ComfyUI 默认 tile=512 需 2.99s
          * tile=768 / 1024 只要 1.29~1.34s（切块少、边界重算少）

        但 tile=1024 需要约 6~8GB 空闲显存。服务里 CLIP 常驻 + 18GB HiFi LoRA 时
        显存很紧，直接用 1024 会连续 OOM 重试（每次失败都白花时间并刷日志），
        所以先按空闲显存选一档，失败再逐级减半。
        """
        overlap = max(0, int(self.config.vae_tile_overlap))
        configured = max(256, int(self.config.vae_tile_size))
        free_mb = self._free_torch_mb(libs)
        if free_mb >= 7000:
            tile = configured
        elif free_mb >= 4500:
            tile = min(configured, 768)
        elif free_mb >= 2500:
            tile = min(configured, 512)
        else:
            tile = 256
        if free_mb:
            logger.info("分块解码起始 tile=%d（空闲显存 %dMB）", tile, free_mb)
        last_exc = None
        for _attempt in range(4):
            try:
                return self._vae.decode_tiled(samples, tile_x=tile, tile_y=tile, overlap=overlap)
            except Exception as exc:  # noqa: BLE001 - 逐级缩小 tile 重试
                last_exc = exc
                libs.mm.soft_empty_cache()
                tile //= 2
                if tile < 256:
                    break
        raise EngineError(f"VAE 分块解码失败: {last_exc}")

    def decode(self, samples):
        """VAE 解码 → **PIL Image 列表**（每个 batch 元素一张）。

        返回 list 是刻意为之：pipeline 的 t2i 支持 batch>1，必须逐个元素给。
        Qwen-Image 2.1 的 VAE 输出 4 通道，alpha 保留。

        解码策略（实测数据见 docs/INFERENCE.md）：
          * 小图（< 阈值）：直接全量解码，最快
          * 大图：**直接走大 tile 分块**，不要先试全量——全量在这种尺寸上既会 OOM
            又要花 5~6 秒，失败一次比直接分块慢得多
        """
        with self._gen_lock:
            self._require_loaded()
            libs = self._load_libs()
            samples = as_normal_tensor(samples)   # 防御 inference tensor
            try:
                patcher = getattr(self._vae, "patcher", None)
                if patcher is not None:
                    libs.mm.load_models_gpu([patcher])
            except Exception:  # pragma: no cover
                logger.debug("VAE 预上卡失败，交给 decode 内部处理", exc_info=True)
            t0 = time.time()
            pixels = self._decode_pixels(samples)
            threshold = int(self.config.tiled_decode_threshold)
            tiled = pixels >= threshold
            # 大图解码前先腾显存：CLIP（~8.9GB）解码时完全用不到，
            # 留着会让 tile 从 1024 掉到 256（4 倍慢）；下一单编码时再上卡。
            if tiled:
                self._offload_text_encoder()
            try:
                try:
                    libs.mm.soft_empty_cache()
                except Exception:  # pragma: no cover
                    pass
                if tiled:
                    logger.info("解码走分块路径（%.2fMP ≥ 阈值 %.2fMP）",
                                pixels / 1e6, threshold / 1e6)
                    out = self._decode_tiled(libs, samples)
                else:
                    out = self._vae.decode(samples)
            except Exception as exc:
                if tiled:
                    raise EngineError(f"VAE 解码失败: {exc}") from exc
                # 小图全量失败：退到分块（很少发生）
                logger.info("全量解码失败，回退分块解码: %s", exc)
                try:
                    out = self._decode_tiled(libs, samples)
                except Exception as exc2:  # noqa: BLE001
                    raise EngineError(f"VAE 解码失败: {exc2}") from exc2
            self._last_decode_seconds = round(time.time() - t0, 3)
            logger.info("解码完成 %.2fs, shape=%s", self._last_decode_seconds,
                        tuple(out.shape))
            if out.ndim == 3:
                out = out.unsqueeze(0)
            return [self.tensor_to_image(out[i:i + 1]) for i in range(int(out.shape[0]))]


__all__ = [
    "EngineError",
    "EngineConfig",
    "NativeEngine",
    "SNAP",
    "LATENT_CHANNELS",
    "LATENT_DOWNSCALE",
    "TURBO_SIGMAS",
    "WEIGHT_DTYPES",
    "PROJECT_ROOT",
    "DEFAULT_ENGINE_DIR",
    "DEFAULT_MODEL_ROOT",
    "DEFAULT_COMFY_ROOT",
    "DEFAULT_UNET",
    "DEFAULT_CLIP",
    "DEFAULT_VAE",
    "reference_size",
    "canvas_size",
    "latent_hw",
    "normalize_sigmas",
    "slice_sigmas_for_denoise",
    "normalize_loras",
    "callback_adapter",
    "as_normal_tensor",
]
