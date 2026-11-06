"""原型验证：不启动 ComfyUI 服务，直接借用 ComfyUI 的模型库代码进程内跑 Qwen-Image 2.1。

目的：验证「把依赖抽离成独立服务」在技术上可行。
只 import ComfyUI 的 comfy/ 包（纯 Python，不改一行），自带采样管线（可控 sigma）。
"""
import os
import sys
import time

COMFY_ROOT = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI"
MODELS = os.path.join(COMFY_ROOT, "models")
UNET = os.path.join(MODELS, "diffusion_models", "QwenImage2.1", "qwen_image_2.1_int8_convrot.safetensors")
CLIP = os.path.join(MODELS, "text_encoders", "Qweniamge2.1", "qwen3vl_8b_int8_convrot.safetensors")
VAE = os.path.join(MODELS, "vae", "Qweniamge2.1", "qwen_image_2.1_vae_bf16.safetensors")

sys.path.insert(0, COMFY_ROOT)

import numpy as np
import torch
import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.sd
import comfy.utils
from PIL import Image

TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568]


def log(msg):
    print(f"[native-proto] {msg}", flush=True)


def main():
    t0 = time.time()
    w, h, steps = 1024, 1024, 8
    prompt = ("A ceramic teapot on a wooden table, soft window light from the left, "
              "shallow depth of field, warm neutral palette")
    seed = 42

    log("loading diffusion model ...")
    model = comfy.sd.load_diffusion_model(UNET)
    log(f"unet loaded in {time.time() - t0:.1f}s")

    log("loading text encoder ...")
    clip = comfy.sd.load_clip([CLIP], embedding_directory=None,
                              clip_type=comfy.sd.CLIPType.QWEN_IMAGE)
    log(f"clip loaded in {time.time() - t0:.1f}s")

    log("loading vae ...")
    vae_sd = comfy.utils.load_torch_file(VAE)
    vae = comfy.sd.VAE(sd=vae_sd)
    log(f"vae loaded in {time.time() - t0:.1f}s")

    # ---- 文本编码：复刻 TextEncodeQwenImage21 的 T2I 分支（无参考图，resolution 不参与）
    t1 = time.time()
    positive = clip.encode_from_tokens_scheduled(
        clip.tokenize(prompt, images=[], keep_vision=True, prevent_empty_text=True))
    negative = clip.encode_from_tokens_scheduled(
        clip.tokenize("", images=[], keep_vision=True, prevent_empty_text=True))
    log(f"encoded in {time.time() - t1:.1f}s")

    # ---- 空 latent（64 通道 / 16 倍下采样）
    latent = torch.zeros([1, 64, h // 16, w // 16],
                         device=comfy.model_management.intermediate_device())

    # ---- 采样：显式 sigma（turbo 8 步）
    sigmas = torch.FloatTensor(TURBO_SIGMAS + [0.0])
    log(f"sigmas = {sigmas.tolist()}")

    guider = comfy.samplers.CFGGuider(model)
    guider.set_conds(positive, negative)
    guider.set_cfg(1.0)

    sampler = comfy.samplers.sampler_object("euler")
    if sampler is None:
        raise RuntimeError("sampler_object('euler') 返回 None")

    latent_image = comfy.sample.fix_empty_latent_channels(guider.model_patcher, latent, None, None)
    noise = comfy.sample.prepare_noise(latent_image, seed)

    t2 = time.time()
    samples = guider.sample(noise, latent_image, sampler, sigmas,
                            denoise_mask=None, callback=None, disable_pbar=True, seed=seed)
    log(f"sampled {steps} steps in {time.time() - t2:.1f}s")

    # ---- 解码
    t3 = time.time()
    model_management_loaded = getattr(vae, "patcher", None)
    if model_management_loaded is not None:
        comfy.model_management.load_models_gpu([model_management_loaded])
    out = vae.decode(samples)
    log(f"decoded in {time.time() - t3:.1f}s, shape={tuple(out.shape)}")

    arr = (out[0].clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
    if arr.shape[-1] > 3:
        # RGBA -> 白底合成（保持视觉正确）
        alpha = arr[..., 3:4].astype(np.float32) / 255.0
        rgb = arr[..., :3].astype(np.float32)
        arr_rgb = (rgb * alpha + 255.0 * (1 - alpha)).round().astype(np.uint8)
        Image.fromarray(arr_rgb).save("storage/outputs/proto_native.png")
    else:
        Image.fromarray(arr[..., :3]).save("storage/outputs/proto_native.png")

    log(f"TOTAL {time.time() - t0:.1f}s -> storage/outputs/proto_native.png")


if __name__ == "__main__":
    main()
