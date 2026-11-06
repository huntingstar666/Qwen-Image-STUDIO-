r"""复现「3 张参考图编辑失败：Inplace update to inference tensor outside InferenceMode」。

完全按 pipeline 的调用顺序跑（encode_text → encode_latent → sample → decode）：
- canvas 1024×1024（主图，来自 engine_t2i_1024_turbo.png）
- ref2 512×512、ref3 640×480
- size_mode=follow ⇒ resolution=0 ⇒ canvas 跟随主图

用法::
    $PY scripts/repro_multi_ref.py            # 只到 encode_latent（快）
    $PY scripts/repro_multi_ref.py --sample   # 再跑 8 步采样 + 解码（完整耗时）
    $PY scripts/repro_multi_ref.py --refs 2   # 对照：只用 2 张参考图
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from server.backends.native import (  # noqa: E402
    DEFAULT_CLIP,
    DEFAULT_ENGINE_DIR,
    DEFAULT_UNET,
    DEFAULT_VAE,
    TURBO_SIGMAS,
    EngineConfig,
    NativeEngine,
)

OUT_DIR = os.path.join(ROOT, "storage", "outputs")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refs", type=int, default=3, choices=(1, 2, 3))
    ap.add_argument("--sample", action="store_true")
    ap.add_argument("--force-tiled", action="store_true",
                    help="把 vae.encode 替换成 vae.encode_tiled_，确定性地走 tiled 回退路径")
    ap.add_argument("--tile", type=int, nargs=2, default=None,
                    help="--force-tiled 时的 tile 大小，如 --tile 256 256")
    args = ap.parse_args()

    from PIL import Image

    src = os.path.join(OUT_DIR, "engine_t2i_1024_turbo.png")
    if not os.path.isfile(src):
        log(f"缺少画布源图 {src}")
        return 2
    canvas = Image.open(src).convert("RGBA")
    ref2 = canvas.resize((512, 512), Image.LANCZOS)
    ref3 = canvas.resize((640, 480), Image.LANCZOS)
    refs = [canvas, ref2, ref3][: args.refs]
    log(f"refs={len(refs)} sizes={[im.size for im in refs]}")

    engine = NativeEngine(EngineConfig(
        engine_dir=DEFAULT_ENGINE_DIR, unet=DEFAULT_UNET, clip=DEFAULT_CLIP, vae=DEFAULT_VAE))
    t0 = time.time()
    engine.ensure_loaded()
    engine.apply_loras([])
    log(f"ensure_loaded {time.time() - t0:.2f}s")

    if args.force_tiled:
        # 确定性触发 sd.py::VAE.encode_tiled_（真机上只在 VAE encode OOM 时才会走到）。
        # 注意 encode_tiled_ 收的是 NCHW（encode() 会先 movedim(-1,1)），这里补适配；
        # 且 encode_tiled_ 自己不负责把 VAE 权重上卡（真机上由前面失败的 encode 做过），先手动上卡。
        libs = engine._load_libs()
        libs.mm.load_models_gpu([engine._vae.patcher])
        vae = engine._vae
        tile_w, tile_h = args.tile or (512, 512)
        vae.encode = lambda pixels: vae.encode_tiled_(
            pixels.movedim(-1, 1), tile_x=tile_w, tile_y=tile_h)
        log(f"已强制 vae.encode -> vae.encode_tiled_ tile=({tile_w},{tile_h})"
            "（模拟显存不足触发的 tiled 回退）")

    prompt = ("把主机位图里的桌布换成深蓝色亚麻布，参考第二张图的配色风格，"
              "并保持第三张图里的器物摆放关系不变")
    try:
        t0 = time.time()
        cond = engine.encode_text(prompt, "", images=refs, resolution=0)
        log(f"encode_text 完成 {time.time() - t0:.2f}s canvas={cond['canvas']} "
            f"pos_entries={len(cond['positive'])}")

        t0 = time.time()
        latent = engine.encode_latent(canvas)
        log(f"encode_latent 完成 {time.time() - t0:.2f}s shape={tuple(latent.shape)} "
            f"is_inference={latent.is_inference()}")
    except Exception:
        log("!! 复现失败点如下：")
        traceback.print_exc()
        return 1

    if args.sample:
        t0 = time.time()
        samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                                latent=latent, sigmas=list(TURBO_SIGMAS), steps=8,
                                cfg=1.0, sampler="euler", scheduler="simple", seed=321)
        t_sample = round(time.time() - t0, 2)
        t0 = time.time()
        images = engine.decode(samples)
        t_decode = round(time.time() - t0, 2)
        out = os.path.join(OUT_DIR, f"engine_edit_multi{len(refs)}ref.png")
        images[0].save(out)
        log(f"采样 {t_sample}s / 解码 {t_decode}s -> {out} "
            f"size={images[0].size} mode={images[0].mode}")

    engine.free(unload=True)
    log("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
