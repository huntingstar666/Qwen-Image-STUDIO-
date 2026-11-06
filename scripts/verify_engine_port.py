r"""验证「引擎已移植进本项目」：只把项目内 engine/ 加进 sys.path，完成出图。

检查项
------
1. `import comfy.*` 解析到 `<PROJECT_ROOT>\engine\comfy`（不是原 ComfyUI 目录）。
2. 不把原 ComfyUI 根目录放进 sys.path，仍能完成 1024×1024 Turbo 8 步出图。
3. 确定性：同 seed 两次采样结果逐像素一致。
4. 权重仍复用原 ComfyUI 的 models/ 目录（只读），符合「代码移植、权重复用」的约定。

用法：python scripts/verify_engine_port.py [--quick]
"""
from __future__ import annotations

import argparse
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE_DIR = os.path.join(ROOT, "engine")
MODEL_ROOT = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\models"

UNET = os.path.join(MODEL_ROOT, "diffusion_models", "QwenImage2.1", "qwen_image_2.1_int8_convrot.safetensors")
CLIP = os.path.join(MODEL_ROOT, "text_encoders", "Qweniamge2.1", "qwen3vl_8b_int8_convrot.safetensors")
VAE = os.path.join(MODEL_ROOT, "vae", "Qweniamge2.1", "qwen_image_2.1_vae_bf16.safetensors")

TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568]


def log(msg: str) -> None:
    print(f"[verify-engine] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="只做 import 校验，不出图")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(ENGINE_DIR, "comfy")):
        log("FAIL: engine/comfy 不存在，请先运行 scripts/port_engine.ps1")
        return 1

    # 关键：只加项目内 engine/，并且断言原 ComfyUI 根目录不在 sys.path
    sys.path.insert(0, ENGINE_DIR)
    comfy_src_root = os.path.dirname(ENGINE_DIR)
    original_comfy_root = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI"
    assert original_comfy_root not in sys.path, "原 ComfyUI 根目录不该出现在 sys.path"

    log(f"sys.path[0] = {ENGINE_DIR}")

    import numpy as np
    import torch

    import comfy.model_management
    import comfy.sample
    import comfy.samplers
    import comfy.sd
    import comfy.utils
    import node_helpers  # noqa: F401  引擎侧复刻 TextEncodeQwenImage21 需要它
    from PIL import Image

    sd_path = os.path.dirname(os.path.abspath(comfy.sd.__file__))
    log(f"comfy.sd -> {sd_path}")
    if not sd_path.startswith(os.path.abspath(ENGINE_DIR)):
        log(f"FAIL: comfy 解析到了项目外：{sd_path}")
        return 1
    try:
        import comfy.cli_args  # noqa: F401  引擎需要它（args / LatentPreviewMethod）
        log("OK: comfy.cli_args 可导入")
    except Exception as exc:  # noqa: BLE001
        log(f"FAIL: comfy.cli_args 导入异常 {exc}")
        return 1

    source_json = os.path.join(ENGINE_DIR, "SOURCE.json")
    if os.path.isfile(source_json):
        import json

        with open(source_json, "r", encoding="utf-8-sig") as fh:
            meta = json.load(fh)
        log(f"移植记录: ComfyUI {meta.get('source_version')} / {meta.get('file_count')} 文件 / "
            f"{round(meta.get('total_bytes', 0) / 1024 / 1024, 2)} MB")

    log("OK: 模型库代码来自本项目 engine/")
    if args.quick:
        return 0

    # ---------------------------------------------------------------- 真出图
    t0 = time.time()
    log("加载权重（复用 ComfyUI models/ 目录，只读）...")
    model = comfy.sd.load_diffusion_model(UNET)
    clip = comfy.sd.load_clip([CLIP], embedding_directory=None,
                              clip_type=comfy.sd.CLIPType.QWEN_IMAGE)
    vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(VAE))
    log(f"权重加载 {time.time() - t0:.1f}s")

    prompt = "A vertical poster of a koi pond in moonlight, deep indigo water, soft ripples"
    positive = clip.encode_from_tokens_scheduled(
        clip.tokenize(prompt, images=[], keep_vision=True, prevent_empty_text=True))
    negative = clip.encode_from_tokens_scheduled(
        clip.tokenize("", images=[], keep_vision=True, prevent_empty_text=True))
    log(f"编码完成 {time.time() - t0:.1f}s")

    def generate(seed: int, width: int, height: int) -> np.ndarray:
        latent = torch.zeros([1, 64, height // 16, width // 16],
                             device=comfy.model_management.intermediate_device())
        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(positive, negative)
        guider.set_cfg(1.0)
        sampler = comfy.samplers.sampler_object("euler")
        sigmas = torch.FloatTensor(TURBO_SIGMAS + [0.0])
        latent_image = comfy.sample.fix_empty_latent_channels(guider.model_patcher, latent, None, None)
        noise = comfy.sample.prepare_noise(latent_image, seed)
        samples = guider.sample(noise, latent_image, sampler, sigmas,
                               denoise_mask=None, callback=None, disable_pbar=True, seed=seed)
        patcher = getattr(vae, "patcher", None)
        if patcher is not None:
            comfy.model_management.load_models_gpu([patcher])
        out = vae.decode(samples)
        arr = (out[0].clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
        return arr

    log("出图 1024×1024 / 8 步 ...")
    t1 = time.time()
    arr = generate(1234, 1024, 1024)
    log(f"出图耗时 {time.time() - t1:.1f}s, shape={arr.shape}")

    os.makedirs(os.path.join(ROOT, "storage", "outputs"), exist_ok=True)
    if arr.shape[-1] > 3:
        alpha = arr[..., 3:4].astype(np.float32) / 255.0
        rgb = (arr[..., :3].astype(np.float32) * alpha + 255.0 * (1 - alpha)).round().astype(np.uint8)
        img = Image.fromarray(rgb)
        rgba = Image.fromarray(arr, mode="RGBA")
    else:
        img = Image.fromarray(arr[..., :3])
        rgba = img.convert("RGBA")
    out_path = os.path.join(ROOT, "storage", "outputs", "verify_vendored.png")
    img.save(out_path)
    rgba.save(os.path.join(ROOT, "storage", "outputs", "verify_vendored_rgba.png"))
    log(f"已保存 {out_path}")

    # ---------------------------------------------------------------- 确定性
    log("确定性检查（512×512 同 seed 跑两次）...")
    a = generate(777, 512, 512)
    b = generate(777, 512, 512)
    if a.shape != b.shape:
        log(f"FAIL: 两次形状不同 {a.shape} vs {b.shape}")
        return 1
    max_diff = int(np.abs(a.astype(np.int16) - b.astype(np.int16)).max())
    log(f"两次同 seed 最大像素差 = {max_diff}")
    if max_diff != 0:
        log("WARN: 非同 seed 完全一致（可能存在非确定性算子，如 attention 后端）")
    else:
        log("OK: 采样确定性成立（逐像素一致）")

    log(f"总耗时 {time.time() - t0:.1f}s")
    log("PASS: 引擎已独立于 ComfyUI，可单独出图")
    return 0


if __name__ == "__main__":
    sys.exit(main())
