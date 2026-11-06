"""逐阶段计时：定位「为什么比 ComfyUI 慢」。

不经过 HTTP / 任务队列，直接调引擎，连续跑多次同参数采样，
把 load / lora / 编码 / 采样 / 解码 分开计时，并检查：

  * 第二次 ensure_loaded 是否真的秒返回
  * apply_loras 同一组 LoRA 是否重复做重活（当前实现每次都从基座重挂）
  * CLIP 是否被 offload 掉，导致每次都要重新上卡
  * 采样是否在 inference_mode / no_grad 下跑

用法：
    python scripts/bench_stages.py                # 1024×1024 turbo 8 步，跑 3 次
    python scripts/bench_stages.py --size 512 --runs 4
    python scripts/bench_stages.py --no-lora      # 不挂加速 LoRA
"""
from __future__ import annotations

import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import config  # noqa: E402
from server.backends import native  # noqa: E402

TURBO_SIGMAS = config.TURBO_SIGMAS + [0.0]


def ms(t: float) -> str:
    return f"{t * 1000:.0f}ms" if t < 1 else f"{t:.2f}s"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--no-lora", action="store_true")
    ap.add_argument("--lora", default=None, help="加速 LoRA 相对路径（默认用 config 里那个）")
    args = ap.parse_args()
    W = args.width or args.size
    H = args.height or args.size

    cfg = config.load_config(refresh=True)
    paths = config.default_model_paths(cfg)
    engine = native.NativeEngine(native.EngineConfig(
        engine_dir=config.find_engine_dir(cfg),
        unet=paths["unet"], clip=paths["clip"], vae=paths["vae"],
    ))

    lora_rel = args.lora or cfg.get("turbo_lora")
    lora_path = config.resolve_model(cfg, "lora", lora_rel) if lora_rel else None
    loras = [] if args.no_lora or not lora_path else [{"name": lora_path, "strength": 1.0}]

    print(f"== bench {W}×{H}, turbo 8 步, lora={os.path.basename(lora_path) if loras else '不挂'} ==")
    print(f"   lora 文件大小: {round(os.path.getsize(lora_path)/1024/1024, 1) if loras else 0} MB\n")

    # ---- 首次装载
    t = time.perf_counter()
    engine.ensure_loaded(unet=paths["unet"], clip=paths["clip"], vae=paths["vae"])
    t_load = time.perf_counter() - t
    print(f"[1] ensure_loaded（冷）: {ms(t_load)}")

    t = time.perf_counter()
    engine.ensure_loaded(unet=paths["unet"], clip=paths["clip"], vae=paths["vae"])
    print(f"[1] ensure_loaded（重复调用）: {ms(time.perf_counter() - t)}")

    # ---- LoRA：连续挂两次，看第二次是否还在做重活
    t = time.perf_counter()
    engine.apply_loras(loras)
    print(f"[2] apply_loras（第一次）: {ms(time.perf_counter() - t)}")
    t = time.perf_counter()
    engine.apply_loras(loras)
    print(f"[2] apply_loras（同一组再挂一次，理想应≈0）: {ms(time.perf_counter() - t)}\n")

    prompt = "a ceramic teapot on a wooden table, soft window light from the left"
    for i in range(1, args.runs + 1):
        print(f"---- 第 {i} 次生成 ----")
        t0 = time.perf_counter()
        cond = engine.encode_text(prompt, "")
        t_enc = time.perf_counter() - t0
        print(f"  编码: {ms(t_enc)}")

        t1 = time.perf_counter()
        samples = engine.sample(
            positive=cond["positive"], negative=cond["negative"], latent=None,
            width=W, height=H, batch=1,
            sigmas=TURBO_SIGMAS, steps=8, cfg=1.0,
            sampler="euler", scheduler="simple", seed=123 + i,
            denoise=1.0, noise_mask=None, callback=None,
        )
        t_samp = time.perf_counter() - t1
        print(f"  采样 8 步: {ms(t_samp)}")

        t2 = time.perf_counter()
        decoded = engine.decode(samples)
        image = decoded[0] if isinstance(decoded, (list, tuple)) else decoded
        t_dec = time.perf_counter() - t2
        print(f"  解码: {ms(t_dec)}  → {image.size}")

        st = engine.status()
        print(f"  合计: {ms(time.perf_counter() - t0)} | "
              f"CLIP offloaded={st.get('text_encoder_offloaded')} | "
              f"timings={st.get('timings')}")
        print()

    engine.free(unload=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
