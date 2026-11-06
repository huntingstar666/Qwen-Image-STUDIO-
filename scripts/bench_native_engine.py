"""实测「采样前把文本编码器（CLIP 8.9GB int8）挪出显存」到底值不值。

同一个进程内跑两次 1024×1024 / turbo 8 步，唯一差别是 engine 的 offload 开关
（通过环境变量 `QWEN_NATIVE_KEEP_TEXT_ENCODER` 控制，引擎每次采样前读取，可运行时切换）：

  on  : 采样前 `model_management.unload_model_and_clones(clip.patcher)` → 释放 8.9GB
  off : CLIP 常驻显存

记录：采样每步的实时空闲显存、采样耗时、VAE 解码耗时（是否触发 tiled 回退）、
以及「编码完 → 采样」之后再次编码时 CLIP 重新上卡的代价。

用法::

    <COMFY_ROOT>\\ComfyUI-aki-v3.2\\python\\python.exe scripts\\bench_native_engine.py
"""

from __future__ import annotations

import json
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
    TURBO_SIGMAS,
    EngineConfig,
    NativeEngine,
)

OUT_DIR = os.path.join(ROOT, "storage", "outputs")
BENCH_JSON = os.path.join(OUT_DIR, "engine_clip_offload_bench.json")
W = H = 1024
PROMPT = "a vintage brass pocket watch on dark velvet, macro photo, warm rim light"
SEED = 2024


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def vram() -> tuple[int, int]:
    import torch
    free, total = torch.cuda.mem_get_info()
    return int(total // 1024 ** 2), int(free // 1024 ** 2)


def run_once(engine: NativeEngine, label: str, keep_clip: bool) -> dict:
    if keep_clip:
        os.environ["QWEN_NATIVE_KEEP_TEXT_ENCODER"] = "1"
    else:
        os.environ.pop("QWEN_NATIVE_KEEP_TEXT_ENCODER", None)

    rec: dict = {"label": label, "keep_text_encoder": keep_clip}
    total_before, free_before_enc = vram()
    rec["vram_free_before_encode_mb"] = free_before_enc
    rec["vram_total_mb"] = total_before

    # 每次编码都会把 CLIP 装回显存（若上一次被挪走），顺便测重新上卡的代价
    t0 = time.time()
    cond = engine.encode_text(PROMPT, resolution=0)
    rec["t_encode_s"] = round(time.time() - t0, 2)
    st = engine.status()
    rec["clip_reload_s"] = st["timings"]["clip_reload_s"]
    rec["text_encoder_offloaded_after_encode"] = st["text_encoder_offloaded"]
    _, rec["vram_free_after_encode_mb"] = vram()

    latent = engine.empty_latent(W, H)
    step_free: list[int] = []
    step_t: list[float] = []
    t_start = time.time()

    def cb(step, total_steps, _latent):
        _, free = vram()
        step_free.append(free)
        step_t.append(round(time.time() - t_start, 2))

    t0 = time.time()
    samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                            latent=latent, sigmas=list(TURBO_SIGMAS), steps=8, cfg=1.0,
                            sampler="euler", scheduler="simple", seed=SEED, callback=cb)
    rec["t_sample_s"] = round(time.time() - t0, 2)
    rec["vram_free_per_step_mb"] = step_free
    rec["step_timestamps_s"] = step_t
    if step_free:
        rec["vram_free_min_during_sample_mb"] = min(step_free)
        rec["vram_free_first_step_mb"] = step_free[0]
    _, rec["vram_free_after_sample_mb"] = vram()

    t0 = time.time()
    images = engine.decode(samples)      # 统一返回 list
    rec["t_decode_s"] = round(time.time() - t0, 2)
    _, rec["vram_free_after_decode_mb"] = vram()

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"engine_bench_clip_{label}.png")
    images[0].save(path)
    rec["file"] = path
    log(f"[{label}] encode={rec['t_encode_s']}s (clip_reload={rec['clip_reload_s']}) "
        f"sample={rec['t_sample_s']}s decode={rec['t_decode_s']}s "
        f"free: after_encode={rec['vram_free_after_encode_mb']} "
        f"min_during_sample={rec.get('vram_free_min_during_sample_mb')} "
        f"after_sample={rec['vram_free_after_sample_mb']}MB")
    return rec


def main() -> int:
    engine = NativeEngine(EngineConfig(
        engine_dir=DEFAULT_ENGINE_DIR, unet=DEFAULT_UNET, clip=DEFAULT_CLIP,
        vae=DEFAULT_VAE))

    t0 = time.time()
    engine.ensure_loaded()
    rec_load = round(time.time() - t0, 2)
    t0 = time.time()
    engine.ensure_loaded()
    rec_repeat = round((time.time() - t0) * 1000, 1)
    log(f"ensure_loaded 首次 {rec_load}s，重复调用 {rec_repeat}ms（应 << 1000ms）")

    results = {
        "meta": {"engine_dir": DEFAULT_ENGINE_DIR,
                 "model_root": DEFAULT_MODEL_ROOT,
                 "unet": DEFAULT_UNET,
                 "clip": DEFAULT_CLIP, "vae": DEFAULT_VAE,
                 "size": [W, H], "steps": 8, "cfg": 1.0, "seed": SEED,
                 "load_s": rec_load, "ensure_loaded_repeat_ms": rec_repeat},
        "runs": [],
    }

    # 第一次：offload（引擎默认行为）
    results["runs"].append(run_once(engine, "offload_on", keep_clip=False))
    # 第二次：CLIP 常驻（关掉优化）
    results["runs"].append(run_once(engine, "offload_off", keep_clip=True))

    engine.free(unload=True)
    with open(BENCH_JSON, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
    log(f"报告写入 {BENCH_JSON}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
