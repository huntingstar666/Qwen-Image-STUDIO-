"""推理后端包。

当前只有一个后端：`native` —— 进程内直跑 Qwen-Image 2.1。

**代码与权重是分开的**：

- 代码：项目内 vendored 的 `<PROJECT_ROOT>\\engine`（ComfyUI 0.43.0 的模型库副本，
  只 import 不改，见 `engine/SOURCE.json`、`engine/NOTICE.md`）；
- 权重：仍复用本机 ComfyUI 的 `models/`（只读），按绝对路径加载。

运行期**不依赖** ComfyUI 服务，也不 import 原 ComfyUI 安装目录里的源码。

用法::

    from server.backends import EngineConfig, NativeEngine

    engine = NativeEngine(EngineConfig(
        engine_dir=r"<PROJECT_ROOT>\\engine",
        unet=r"D:\\...\\models\\diffusion_models\\QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors",
        clip=r"D:\\...\\models\\text_encoders\\Qweniamge2.1\\qwen3vl_8b_int8_convrot.safetensors",
        vae=r"D:\\...\\models\\vae\\Qweniamge2.1\\qwen_image_2.1_vae_bf16.safetensors",
    ))
    engine.ensure_loaded()
    cond = engine.encode_text("a teapot")
    samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                            latent=None, width=1024, height=1024,
                            sigmas=[...], steps=8, cfg=1.0)
    images = engine.decode(samples)      # list[PIL.Image]

`NativeEngine` 构造是**零成本**的（不 import torch、不读模型），第一次
`ensure_loaded()` / `status()` 才会去 import 引擎模型库。这样 `server.main`
启动和单元测试都不会被 4 秒的 import 拖慢。
"""

from .native import (  # noqa: F401
    DEFAULT_CLIP,
    DEFAULT_COMFY_ROOT,
    DEFAULT_ENGINE_DIR,
    DEFAULT_MODEL_ROOT,
    DEFAULT_UNET,
    DEFAULT_VAE,
    EngineConfig,
    EngineError,
    LATENT_CHANNELS,
    LATENT_DOWNSCALE,
    NativeEngine,
    PROJECT_ROOT,
    SNAP,
    TURBO_SIGMAS,
    WEIGHT_DTYPES,
    as_normal_tensor,
    canvas_size,
    latent_hw,
    normalize_loras,
    normalize_sigmas,
    reference_size,
)

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
    "normalize_loras",
    "as_normal_tensor",
]
