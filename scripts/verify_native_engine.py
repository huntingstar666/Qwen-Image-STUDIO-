r"""真实出图验收：Qwen-Image 2.1 进程内引擎（不经 ComfyUI 服务）。

跑「必测三组」+ 两组补充用例，记录耗时 / 显存 / 产物统计，写
`storage/outputs/engine_bench.json`，图存 `storage/outputs/engine_*.png`。

用法（解释器固定用 ComfyUI 自带那个，torch 2.11+cu128）::

    $PY scripts\verify_native_engine.py                 # 全部用例
    $PY scripts\verify_native_engine.py --cases q,a     # 指定用例
    $PY scripts\verify_native_engine.py --keep-clip     # 关掉 CLIP offload 优化

用例：
  q  512×512  turbo 8 步 + 官方 18.2GB turbo LoRA（最快冒烟，验证 apply_loras 真实通路）
  a  t2i 1024×1024  turbo 8 步显式 sigma（**不挂 LoRA**，与原型基准对齐）
  b  t2i 2048×2048  默认 sigma 路径 25 步（simple / euler / cfg=1，官方模板参数）
  c  单图编辑  1 张参考图 + prompt, resolution=0（canvas 跟随参考图，ref_latents 路径）
  d  局部编辑  VAEEncode(canvas) + noise_mask（numpy 像素尺寸遮罩，等价 SetLatentNoiseMask）
  e  LoRA 通路：挂小 LoRA → 出图 → 清空还原（验证幂等）
"""

from __future__ import annotations

import argparse
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
    EngineError,
    NativeEngine,
)

OUT_DIR = os.path.join(ROOT, "storage", "outputs")
BENCH_JSON = os.path.join(OUT_DIR, "engine_bench.json")

#: 官方「高保真 turbo 8 步」LoRA（pipeline 的 turbo8_official 档位默认挂它，18.2GB）
TURBO_LORA = os.path.join(DEFAULT_MODEL_ROOT, "loras", "qwen2.1加速",
                          "qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors")
#: 小 LoRA，用于验证 LoRA 切换/清空通路（320MB）
SMALL_LORA = os.path.join(DEFAULT_MODEL_ROOT, "loras", "Qwen-功能2.1",
                          "p_qwen_image_2.1_8step_v0.1.safetensors")

CASES = ("q", "a", "b", "c", "d", "e")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _torch():
    import torch  # noqa: WPS433  (延迟导入：只有本脚本需要)
    return torch


def vram() -> tuple[int, int]:
    torch = _torch()
    if not torch.cuda.is_available():
        return 0, 0
    free, total = torch.cuda.mem_get_info()
    return int(total // 1024 ** 2), int(free // 1024 ** 2)


def reset_peak() -> None:
    torch = _torch()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def peak_mb() -> int:
    torch = _torch()
    if not torch.cuda.is_available():
        return 0
    return int(torch.cuda.max_memory_allocated() // 1024 ** 2)


def image_stats(image) -> dict:
    """产物统计：用于机器判断「不是全黑 / 不是糊成一片」。"""
    import numpy as np

    rgba = image.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.float32) / 255.0
    rgb = arr[..., :3]
    luma = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    # 高频能量：相邻像素差的均值，糊图会显著偏低
    sharpness = float(np.abs(np.diff(luma, axis=0)).mean() + np.abs(np.diff(luma, axis=1)).mean())
    return {
        "width": rgba.width,
        "height": rgba.height,
        "mode": rgba.mode,
        "mean_luma": round(float(luma.mean()), 4),
        "std_luma": round(float(luma.std()), 4),
        "min_luma": round(float(luma.min()), 4),
        "max_luma": round(float(luma.max()), 4),
        "sharpness": round(sharpness, 5),
        "alpha_min": round(float(arr[..., 3].min()), 4),
        "alpha_max": round(float(arr[..., 3].max()), 4),
    }


def save(image, name: str) -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    image.save(path)
    return path


def _sample(engine, cond, *, latent=None, width=None, height=None,
            sigmas=None, steps=8, cfg=1.0, seed=0, denoise=1.0, noise_mask=None):
    """包一层计时：sample + decode（decode 统一返回 list）。"""
    t0 = time.time()
    samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                            latent=latent, width=width, height=height,
                            sigmas=sigmas, steps=steps, cfg=cfg, sampler="euler",
                            scheduler="simple", seed=seed, denoise=denoise,
                            noise_mask=noise_mask)
    t_sample = round(time.time() - t0, 2)
    t0 = time.time()
    images = engine.decode(samples)
    t_decode = round(time.time() - t0, 2)
    if not isinstance(images, list):
        raise EngineError(f"decode 必须返回 list，实际是 {type(images)!r}")
    return images, t_sample, t_decode


def run_case(engine: NativeEngine, key: str) -> dict:
    reset_peak()
    rec: dict = {"case": key, "ok": False}
    t_case = time.time()

    if key == "q":
        rec.update(kind="t2i_turbo_512_lora", size=[512, 512], steps=8, cfg=1.0,
                   sampler="euler", scheduler="simple", sigmas="TURBO_SIGMAS+0.0",
                   lora=TURBO_LORA,
                   prompt="a white ceramic mug on a dark walnut desk, soft morning light, "
                          "steam rising, shallow depth of field")
        if not os.path.isfile(TURBO_LORA):
            raise EngineError(f"turbo LoRA 不存在: {TURBO_LORA}")
        t0 = time.time()
        engine.apply_loras([{"name": TURBO_LORA, "strength": 1.0}])
        rec["t_apply_loras_s"] = round(time.time() - t0, 2)
        t0 = time.time()
        cond = engine.encode_text(rec["prompt"], resolution=0)
        rec["t_encode_s"] = round(time.time() - t0, 2)
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, width=512, height=512, sigmas=list(TURBO_SIGMAS), seed=42)
        rec["file"] = save(images[0], "engine_t2i_512_turbo_lora.png")
        image = images[0]

    elif key == "a":
        engine.apply_loras([])          # 回到基座模型（与原型基准一致）
        rec.update(kind="t2i_turbo_1024", size=[1024, 1024], steps=8, cfg=1.0,
                   sampler="euler", scheduler="simple", sigmas="TURBO_SIGMAS+0.0",
                   lora=None,
                   prompt="一个手工陶土茶壶放在原木桌上，左侧柔和窗光，浅景深，温暖的中性色调，"
                          "细腻的釉面反光，背景是虚化的白色墙壁")
        t0 = time.time()
        cond = engine.encode_text(rec["prompt"], resolution=0)
        rec["t_encode_s"] = round(time.time() - t0, 2)
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, width=1024, height=1024, sigmas=list(TURBO_SIGMAS), seed=42)
        rec["file"] = save(images[0], "engine_t2i_1024_turbo.png")
        image = images[0]

    elif key == "b":
        rec.update(kind="t2i_default_2048", size=[2048, 2048], steps=25, cfg=1.0,
                   sampler="euler", scheduler="simple", sigmas=None, lora=None,
                   prompt="A red fox sitting in a snowy pine forest at golden hour, thick "
                          "winter fur with individual hairs catching the light, shallow depth "
                          "of field, soft bokeh snowflakes, cinematic wildlife photography")
        t0 = time.time()
        cond = engine.encode_text(rec["prompt"], resolution=0)
        rec["t_encode_s"] = round(time.time() - t0, 2)
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, width=2048, height=2048, sigmas=None, steps=25,
            cfg=1.0, seed=7)
        rec["file"] = save(images[0], "engine_t2i_2048_default.png")
        image = images[0]

    elif key == "c":
        ref_path = os.path.join(OUT_DIR, "engine_t2i_1024_turbo.png")
        if not os.path.isfile(ref_path):
            raise EngineError(f"单图编辑需要参考图，请先跑用例 a（或手动放 {ref_path}）")
        from PIL import Image
        ref = Image.open(ref_path).convert("RGBA")
        rec.update(kind="edit_single_ref", ref=ref_path, ref_size=list(ref.size),
                   resolution=0, steps=25, cfg=1.0, sampler="euler", scheduler="simple",
                   lora=None,
                   prompt="把桌布换成深蓝色亚麻布，并在茶壶右侧放一只白色陶瓷茶杯，"
                          "保持原有光线、构图和其他物体不变")
        t0 = time.time()
        cond = engine.encode_text(rec["prompt"], images=[ref], resolution=0)
        rec["t_encode_s"] = round(time.time() - t0, 2)
        rec["canvas"] = list(cond["canvas"])
        if tuple(rec["canvas"]) != ref.size:
            raise EngineError(f"canvas {rec['canvas']} != 参考图 {ref.size}（零偏移被破坏）")
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, width=ref.width, height=ref.height, sigmas=None,
            steps=25, cfg=1.0, seed=1234)
        rec["file"] = save(images[0], "engine_edit_single_ref.png")
        rec["ref_file_copy"] = save(ref, "engine_edit_single_ref_input.png")
        image = images[0]

    elif key == "d":
        from PIL import Image, ImageDraw
        import numpy as np
        src_path = os.path.join(OUT_DIR, "engine_t2i_1024_turbo.png")
        if not os.path.isfile(src_path):
            raise EngineError("局部编辑需要画布，请先跑用例 a")
        canvas = Image.open(src_path).convert("RGBA")
        mask_im = Image.new("L", canvas.size, 0)
        ImageDraw.Draw(mask_im).rectangle([560, 380, 990, 900], fill=255)
        # pipeline 传的正是这种：np.float32 (H,W) 像素尺寸，值域 0..1，1=重绘
        mask_np = np.asarray(mask_im, dtype=np.float32) / 255.0
        rec.update(kind="edit_local_mask", src=src_path, mask_space="pixel HxW float32",
                   steps=8, cfg=1.0, sampler="euler", scheduler="simple", seed=99,
                   prompt="在这个区域画一只坐着的橙白相间的猫，背景与周围保持一致")
        t0 = time.time()
        cond = engine.encode_text(rec["prompt"], images=[canvas], resolution=0)
        latent = engine.encode_latent(canvas)
        rec["t_encode_s"] = round(time.time() - t0, 2)
        rec["latent_shape"] = list(latent.shape)
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, latent=latent, sigmas=list(TURBO_SIGMAS), steps=8,
            cfg=1.0, seed=99, denoise=1.0, noise_mask=mask_np)
        rec["file"] = save(images[0], "engine_edit_local_mask.png")
        rec["mask_file"] = save(mask_im.convert("RGB"), "engine_edit_local_mask_area.png")
        image = images[0]

    elif key == "e":
        if not os.path.isfile(SMALL_LORA):
            raise EngineError(f"小 LoRA 不存在: {SMALL_LORA}")
        rec.update(kind="lora_switch", size=[512, 512], steps=8, cfg=1.0, lora=SMALL_LORA,
                   prompt="一朵发光的蓝色莲花，黑色背景，微距摄影")
        t0 = time.time()
        engine.apply_loras([{"name": SMALL_LORA, "strength": 0.8}])
        rec["t_apply_loras_s"] = round(time.time() - t0, 2)
        rec["loras_loaded"] = engine.status()["loaded"]["loras"]
        cond = engine.encode_text(rec["prompt"], resolution=0)
        images, rec["t_sample_s"], rec["t_decode_s"] = _sample(
            engine, cond, width=512, height=512, sigmas=list(TURBO_SIGMAS), seed=5)
        rec["file"] = save(images[0], "engine_lora_smoke.png")
        t0 = time.time()
        engine.apply_loras([])          # 清空还原
        rec["t_clear_loras_s"] = round(time.time() - t0, 2)
        rec["loras_after_reset"] = engine.status()["loaded"]["loras"]
        image = images[0]

    else:
        raise EngineError(f"未知用例: {key}")

    rec["vram_peak_mb"] = peak_mb()
    _, free_mb = vram()
    rec["vram_free_mb_after"] = free_mb
    rec.update(image_stats(image))
    rec["total_s"] = round(time.time() - t_case, 2)
    rec["ok"] = True
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=",".join(CASES))
    ap.add_argument("--keep-clip", action="store_true",
                    help="不把文本编码器挪出显存（对比实验）")
    args = ap.parse_args()
    keys = [k.strip().lower() for k in args.cases.split(",") if k.strip()]
    bad = [k for k in keys if k not in CASES]
    if bad:
        log(f"未知用例: {bad}，可选 {list(CASES)}")
        return 2
    if args.keep_clip:
        os.environ["QWEN_NATIVE_KEEP_TEXT_ENCODER"] = "1"

    os.makedirs(OUT_DIR, exist_ok=True)
    log(f"ENGINE_DIR = {DEFAULT_ENGINE_DIR}")
    log(f"MODEL_ROOT = {DEFAULT_MODEL_ROOT}")
    for p in (DEFAULT_UNET, DEFAULT_CLIP, DEFAULT_VAE):
        log(f"  exists={os.path.isfile(p)}  {os.path.basename(p)}")
    total_mb, free_mb = vram()
    log(f"GPU 起始显存: free {free_mb} / total {total_mb} MB")

    engine = NativeEngine(EngineConfig(
        engine_dir=DEFAULT_ENGINE_DIR, unet=DEFAULT_UNET, clip=DEFAULT_CLIP,
        vae=DEFAULT_VAE))
    log("构造引擎完成（此时还没 import torch）")

    t0 = time.time()
    engine.ensure_loaded()
    log(f"ensure_loaded 完成 {time.time() - t0:.2f}s")
    st = engine.status()
    log(f"status: available={st['available']} device={st['device']} "
        f"engine_dir={st['engine_dir']} vram={st['vram_free_mb']}/{st['vram_total_mb']}MB")
    t0 = time.time()
    engine.ensure_loaded()
    st["timings"]["ensure_repeat_ms"] = round((time.time() - t0) * 1000, 2)
    log(f"ensure_loaded 重复调用 {st['timings']['ensure_repeat_ms']}ms（幂等快路径）")

    results: dict = {"meta": {
        "engine": "server/backends/native.py",
        "engine_dir": DEFAULT_ENGINE_DIR,
        "model_root": DEFAULT_MODEL_ROOT,
        "unet": DEFAULT_UNET, "clip": DEFAULT_CLIP, "vae": DEFAULT_VAE,
        "keep_text_encoder": bool(args.keep_clip),
        "torch": _torch().__version__,
        "gpu": _torch().cuda.get_device_name(0),
        "vram_total_mb": total_mb, "vram_free_at_start_mb": free_mb,
        "cases": keys,
        "timings": st["timings"],
    }, "cases": {}}

    for key in keys:
        log(f"===== 用例 {key} 开始 =====")
        try:
            rec = run_case(engine, key)
        except Exception as exc:  # 一个用例失败不影响后面，且把错误写进报告
            import traceback
            traceback.print_exc()
            results["cases"][key] = {"case": key, "ok": False, "error": str(exc)}
            log(f"用例 {key} 失败: {exc}")
            _, free_mb_now = vram()
            log(f"  失败后显存 free={free_mb_now}MB")
            continue
        results["cases"][key] = rec
        log(f"用例 {key} 完成 total={rec['total_s']}s "
            + (f"encode={rec.get('t_encode_s')}s " if 't_encode_s' in rec else "")
            + (f"lora={rec.get('t_apply_loras_s')}s " if 't_apply_loras_s' in rec else "")
            + f"sample={rec.get('t_sample_s')}s decode={rec.get('t_decode_s')}s "
            f"peak={rec['vram_peak_mb']}MB size={rec['width']}x{rec['height']} "
            f"mean={rec['mean_luma']} std={rec['std_luma']} sharp={rec['sharpness']} "
            f"-> {rec['file']}")
        st = engine.status()
        log(f"  timings={st['timings']} text_encoder_offloaded={st['text_encoder_offloaded']}")

    total, free = vram()
    results["meta"]["vram_free_mb_end"] = free
    results["meta"]["total_s"] = round(
        sum(c.get("total_s", 0) for c in results["cases"].values()), 2)

    with open(BENCH_JSON, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
    log(f"报告写入 {BENCH_JSON}")

    log("===== 汇总 =====")
    for key, rec in results["cases"].items():
        if rec.get("ok"):
            log(f"  {key}: {rec['width']}x{rec['height']} total={rec['total_s']}s "
                f"(enc {rec.get('t_encode_s')} / sample {rec.get('t_sample_s')} / "
                f"dec {rec.get('t_decode_s')}) peak={rec['vram_peak_mb']}MB "
                f"mean_luma={rec['mean_luma']} std={rec['std_luma']}")
        else:
            log(f"  {key}: FAILED {rec.get('error')}")

    engine.free(unload=True)
    log("显存已归还")
    return 0 if all(c.get("ok") for c in results["cases"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
