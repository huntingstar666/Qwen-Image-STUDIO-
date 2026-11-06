r"""诊断：官方 18.2GB turbo LoRA 到底能不能挂上（独立最小复现）。

只做：import 引擎 → 载 UNET/CLIP/VAE → 读 LoRA 文件 → load_lora_for_models → 打印统计。
不出图。用于定位 `verify_native_engine.py --cases q` 的硬崩溃点。

用法::
    $PY scripts/debug_turbo_lora.py
"""

from __future__ import annotations

import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from server.backends.native import (  # noqa: E402
    DEFAULT_CLIP,
    DEFAULT_ENGINE_DIR,
    DEFAULT_MODEL_ROOT,
    DEFAULT_UNET,
    DEFAULT_VAE,
    EngineConfig,
    NativeEngine,
)

TURBO_LORA = os.path.join(DEFAULT_MODEL_ROOT, "loras", "qwen2.1加速",
                          "qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    log(f"LoRA = {TURBO_LORA} ({os.path.getsize(TURBO_LORA) / 2**30:.2f} GB)")
    engine = NativeEngine(EngineConfig(
        engine_dir=DEFAULT_ENGINE_DIR, unet=DEFAULT_UNET, clip=DEFAULT_CLIP, vae=DEFAULT_VAE))
    t0 = time.time()
    engine.ensure_loaded()
    log(f"ensure_loaded {time.time() - t0:.2f}s")

    libs = engine._load_libs()
    log("开始 load_torch_file ...")
    t0 = time.time()
    sd = libs.utils.load_torch_file(TURBO_LORA)
    log(f"load_torch_file 完成 {time.time() - t0:.2f}s, {len(sd)} keys")

    keys = list(sd.keys())
    log(f"前 5 个 key: {keys[:5]}")
    log(f"后 3 个 key: {keys[-3:]}")
    import numpy as np
    sample_dtype = getattr(sd[keys[0]], "dtype", None)
    log(f"dtype 示例: {sample_dtype}")

    log("开始 load_lora_for_models（可能很慢）...")
    t0 = time.time()
    try:
        model, clip = libs.sd.load_lora_for_models(engine._base_model, engine._base_clip,
                                                   sd, 1.0, 1.0)
        log(f"load_lora_for_models 完成 {time.time() - t0:.2f}s")
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        log(f"load_lora_for_models 抛异常: {exc}")
        return 1
    del sd

    log("采样一张 512×512 / 8 步验证 LoRA 生效 ...")
    engine._model, engine._clip = model, clip
    from server.backends.native import TURBO_SIGMAS
    cond = engine.encode_text("a white ceramic mug on a dark walnut desk", resolution=0)
    images, t_sample, t_decode = None, None, None
    t0 = time.time()
    samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                            latent=None, width=512, height=512,
                            sigmas=list(TURBO_SIGMAS), steps=8, cfg=1.0,
                            sampler="euler", scheduler="simple", seed=42)
    t_sample = round(time.time() - t0, 2)
    t0 = time.time()
    images = engine.decode(samples)
    t_decode = round(time.time() - t0, 2)
    out = os.path.join(ROOT, "storage", "outputs", "engine_turbo_lora_debug.png")
    images[0].save(out)
    log(f"采样 {t_sample}s / 解码 {t_decode}s -> {out}")
    engine.free(unload=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
