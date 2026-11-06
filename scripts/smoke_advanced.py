"""进阶冒烟：多参考图编辑 / 透明 RGBA / 1024 turbo / 比例模式。

用法：python scripts/smoke_advanced.py [--base http://127.0.0.1:8700]
产物：storage/outputs/smoke_*.png
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import urllib.request

from PIL import Image

PASS, FAIL = [], []


def ok(n, d=""):
    PASS.append(n)
    print(f"  PASS  {n}" + (f"  ({d})" if d else ""), flush=True)


def bad(n, d):
    FAIL.append(f"{n}: {d}")
    print(f"  FAIL  {n}  -> {d}", flush=True)


def req(method, url, payload=None, timeout=120):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def b64(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def wait(base, jid, timeout=900):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        job = req("GET", f"{base}/api/jobs/{jid}")
        p = job.get("progress") or {}
        cur = f"{job['status']} {p.get('value')}/{p.get('max')}"
        if cur != last:
            print(f"        {cur} {p.get('label') or ''}", flush=True)
            last = cur
        if job["status"] in ("done", "error", "canceled"):
            return job
        time.sleep(1)
    raise TimeoutError(jid)


def gen(base, payload, timeout=900):
    jid = req("POST", f"{base}/api/generate", payload)["job_id"]
    return wait(base, jid, timeout)


def edit(base, payload, timeout=900):
    jid = req("POST", f"{base}/api/edit", payload)["job_id"]
    return wait(base, jid, timeout)


def fetch(base, url):
    with urllib.request.urlopen(base + url, timeout=120) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8700")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    # ---------------------------------------------------------------- 1024 turbo
    print("\n[1/4] 文生图 1024×1024 turbo 8 步", flush=True)
    t2i_png = None
    try:
        t0 = time.time()
        job = gen(base, {
            "prompt": "A cozy reading nook by a tall window, warm afternoon light, "
                      "stacked books and a ceramic mug on a walnut side table, "
                      "soft dust motes in the sunbeam, photorealistic",
            "width": 1024, "height": 1024,
            "turbo": {"enabled": True, "profile": "turbo8_official"},
            "seed": 20261104,
        })
        if job["status"] != "done":
            bad("t2i1024", job.get("error"))
        else:
            png = fetch(base, job["images"][0]["url"])
            with Image.open(io.BytesIO(png)) as im:
                if im.size == (1024, 1024):
                    ok("t2i1024", f"{time.time()-t0:.0f}s, {im.size}")
                    im.save("storage/outputs/smoke_t2i_1024.png")
                else:
                    bad("t2i1024", f"size {im.size}")
            t2i_png = png
    except Exception as exc:  # noqa: BLE001
        bad("t2i1024", repr(exc))

    # ---------------------------------------------------------------- RGBA
    print("\n[2/4] 透明 RGBA 512×512", flush=True)
    try:
        job = gen(base, {
            "prompt": "a cute cartoon red panda sticker, clean vector style",
            "width": 512, "height": 512, "rgba": True,
            "turbo": {"enabled": True, "profile": "turbo8_official"},
            "seed": 42,
        })
        if job["status"] != "done":
            bad("rgba", job.get("error"))
        else:
            png = fetch(base, job["images"][0]["url"])
            with Image.open(io.BytesIO(png)) as im:
                alpha = im.getchannel("A") if "A" in im.getbands() else None
                if alpha is None:
                    bad("rgba", f"输出没有 alpha 通道（mode={im.mode}）")
                else:
                    lo, hi = alpha.getextrema()
                    if lo < 250:
                        ok("rgba", f"带 alpha（{lo}..{hi}），已有透明像素")
                    else:
                        bad("rgba", f"alpha 恒不透明（{lo}..{hi}），模型没吐透明背景")
                    im.save("storage/outputs/smoke_rgba.png")
    except Exception as exc:  # noqa: BLE001
        bad("rgba", repr(exc))

    # ---------------------------------------------------------------- 多参考图
    print("\n[3/4] 双参考图编辑", flush=True)
    if t2i_png is None:
        print("  跳过（没有主图）", flush=True)
    else:
        try:
            second = fetch(base, "/files/outputs/smoke_rgba.png") if False else None
            # 第二张参考图：直接用刚生成的 RGBA 图转 RGB
            with Image.open(io.BytesIO(t2i_png)) as im:
                main_img = im.convert("RGB")
            sw = Image.new("RGB", (512, 512), (250, 245, 235))
            for i in range(0, 512, 32):
                sw.paste((30, 60, 90), (i, 0, i + 16, 512))
            buf = io.BytesIO(); sw.save(buf, format="PNG")
            bmain = io.BytesIO(); main_img.save(bmain, format="PNG")

            job = edit(base, {
                "prompt": "Place the striped curtain pattern from <image2> as a fabric throw "
                          "draped over the chair in <image1>",
                "images": [
                    {"name": "room.png", "data": b64(bmain.getvalue())},
                    {"name": "pattern.png", "data": b64(buf.getvalue())},
                ],
                "size_mode": "follow",
                "local": {"enabled": False},
                "turbo": {"enabled": True, "profile": "turbo8_official"},
                "seed": 5,
            })
            if job["status"] != "done":
                bad("multi_ref", job.get("error"))
            else:
                png = fetch(base, job["images"][0]["url"])
                with Image.open(io.BytesIO(png)) as im:
                    canvas = (job.get("align") or {}).get("canvas") or {}
                    if (job.get("quality") or {}).get("size_match"):
                        ok("multi_ref", f"{im.size}, canvas {canvas}, 2 张参考图")
                    else:
                        bad("multi_ref", f"尺寸不匹配 {im.size} vs 输入")
                    im.save("storage/outputs/smoke_multi_ref.png")
        except Exception as exc:  # noqa: BLE001
            bad("multi_ref", repr(exc))

    # ---------------------------------------------------------------- 比例模式
    print("\n[4/4] 编辑 size_mode=ratio 16:9", flush=True)
    if t2i_png is None:
        print("  跳过", flush=True)
    else:
        try:
            with Image.open(io.BytesIO(t2i_png)) as im:
                main_img = im.convert("RGB")
            buf = io.BytesIO(); main_img.save(buf, format="PNG")
            job = edit(base, {
                "prompt": "Extend the scene to a wide cinematic composition, "
                          "keep the room and furnishings exactly as they are",
                "images": [{"name": "room.png", "data": b64(buf.getvalue())}],
                "size_mode": "ratio", "ratio": "16:9", "megapixels": 1.0,
                "fit": "pad",
                "local": {"enabled": False},
                "turbo": {"enabled": True, "profile": "turbo8_official"},
                "seed": 9,
            })
            if job["status"] != "done":
                bad("ratio_edit", job.get("error"))
            else:
                png = fetch(base, job["images"][0]["url"])
                with Image.open(io.BytesIO(png)) as im:
                    canvas = (job.get("align") or {}).get("canvas") or {}
                    w, h = canvas.get("w", 0), canvas.get("h", 0)
                    if w % 32 == 0 and h % 32 == 0 and w and h:
                        ratio = w / h
                        # ratio 模式的输出应当就是画布尺寸（不裁回源尺寸）
                        if im.size == (w, h):
                            ok("ratio_edit", f"输出 {im.size} = canvas {w}×{h} (比例 {ratio:.2f})")
                        else:
                            bad("ratio_edit", f"输出 {im.size} 与 canvas {(w, h)} 不符")
                    else:
                        bad("ratio_edit", f"canvas 非 32 倍数：{canvas}")
                    im.save("storage/outputs/smoke_ratio_edit.png")
        except Exception as exc:  # noqa: BLE001
            bad("ratio_edit", repr(exc))

    print("\n" + "=" * 60)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    for f in FAIL:
        print("  -", f)
    print("=" * 60)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
