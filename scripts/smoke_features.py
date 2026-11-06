"""功能矩阵冒烟：把「还没端到端验证过的参数路径」逐条跑一遍。

覆盖：
  1. 文生图 batch=2                       多图一次出
  2. 文生图 cfg=2.5 + 负向提示词            CFG > 1 路径
  3. 文生图无 Turbo（默认 scheduler）        默认 sigma 路径
  4. 编辑 size_mode=fixed_point（BlueBox 不动点）
  5. 编辑 size_mode=custom                 输出应等于自定义尺寸
  6. 编辑 local.scheme=b（裁切+贴回）        方案 B，省显存路线
  7. 编辑 denoise=0.55（全图，不遮罩）         img2img 强度
  8. 编辑 3 张参考图                       多参考图上限路径
  9. 编辑 resolution=1024（源=32 倍数）      零偏移守卫 + 非零 resolution

每项都会独立判定，任一失败不影响后续（除非前序没拿到图）。

用法：python scripts/smoke_features.py [--base http://127.0.0.1:8700]
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import urllib.request

from PIL import Image, ImageDraw

PASS, FAIL = [], []


def ok(name, detail=""):
    PASS.append(name)
    print(f"  PASS  {name}" + (f"  ({detail})" if detail else ""), flush=True)


def bad(name, detail):
    FAIL.append(f"{name}: {detail}")
    print(f"  FAIL  {name}  -> {detail}", flush=True)


def req(method, url, payload=None, timeout=120):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json; charset=utf-8"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode()) if raw else {}


def b64img(im: Image.Image) -> str:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def fetch(base, url) -> bytes:
    with urllib.request.urlopen(base + url, timeout=120) as r:
        return r.read()


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


def job_images(base, job) -> list[Image.Image]:
    out = []
    for item in job.get("images") or []:
        out.append(Image.open(io.BytesIO(fetch(base, item["url"]))))
    return out


def gen(base, payload):
    return wait(base, req("POST", f"{base}/api/generate", payload)["job_id"])


def edit(base, payload):
    return wait(base, req("POST", f"{base}/api/edit", payload)["job_id"])


def make_scene(w: int, h: int) -> Image.Image:
    """造一张有结构的测试图（渐变背景 + 几个色块），保证不是纯色。"""
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=(int(40 + 120 * t), int(70 + 90 * t), int(110 + 60 * (1 - t))))
    d.rectangle([w // 8, h // 8, w // 2, h // 2], fill=(210, 120, 70))
    d.ellipse([w // 2, h // 3, w * 7 // 8, h * 3 // 4], fill=(90, 180, 150))
    d.line([(0, h * 3 // 4), (w, h * 3 // 4)], fill=(245, 240, 220), width=max(2, w // 60))
    return im


def mask_rect(w: int, h: int, box) -> Image.Image:
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rectangle(box, fill=255)
    return m


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8700")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print(f"== 功能矩阵冒烟 {base} ==", flush=True)
    scene = make_scene(1024, 1024)
    tiny = make_scene(1000, 750)          # 非 32 倍数，测对齐
    turbo = {"enabled": True, "profile": "turbo8_official"}

    # ---------------------------------------------------------------- 1 batch
    print("\n[1/9] 文生图 batch=2", flush=True)
    try:
        t0 = time.time()
        job = gen(base, {"prompt": "two small ceramic bowls on a linen cloth, soft daylight",
                         "width": 512, "height": 512, "batch": 2, "turbo": turbo, "seed": 11})
        if job["status"] != "done":
            bad("batch2", job.get("error"))
        else:
            n = len(job.get("images") or [])
            if n == 2:
                sizes = [im.size for im in job_images(base, job)]
                ok("batch2", f"{n} 张 {sizes[0]} {time.time()-t0:.0f}s")
            else:
                bad("batch2", f"期望 2 张，实际 {n}")
    except Exception as exc:  # noqa: BLE001
        bad("batch2", repr(exc))

    # ---------------------------------------------------------------- 2 cfg>1
    print("\n[2/9] cfg=2.5 + 负向提示词", flush=True)
    try:
        job = gen(base, {"prompt": "a brass key on white paper, top view, studio light",
                         "negative_prompt": "blurry, text, watermark, extra objects",
                         "width": 512, "height": 512, "steps": 25, "cfg": 2.5,
                         "sampler": "euler", "scheduler": "simple", "seed": 12})
        if job["status"] != "done":
            bad("cfg_negative", job.get("error"))
        else:
            im = job_images(base, job)[0]
            ok("cfg_negative", f"{im.size}, cfg=2.5")
    except Exception as exc:  # noqa: BLE001
        bad("cfg_negative", repr(exc))

    # ---------------------------------------------------------------- 3 无 turbo
    print("\n[3/9] 默认调度（无 Turbo）512×512 20 步", flush=True)
    try:
        t0 = time.time()
        job = gen(base, {"prompt": "a single lit candle in a dark room, warm glow, minimal",
                         "width": 512, "height": 512, "steps": 20, "cfg": 1.0,
                         "sampler": "euler", "scheduler": "simple", "seed": 13})
        if job["status"] != "done":
            bad("default_sigma", job.get("error"))
        else:
            im = job_images(base, job)[0]
            ok("default_sigma", f"{im.size}, {time.time()-t0:.0f}s")
    except Exception as exc:  # noqa: BLE001
        bad("default_sigma", repr(exc))

    # ---------------------------------------------------------------- 4 fixed_point
    print("\n[4/9] 编辑 size_mode=fixed_point（BlueBox 不动点）源 1000×750", flush=True)
    try:
        job = edit(base, {"prompt": "make the blue block bright orange, keep everything else",
                          "images": [{"name": "s.png", "data": b64img(tiny)}],
                          "size_mode": "fixed_point", "width": 1024, "height": 1024,
                          "local": {"enabled": False}, "turbo": turbo, "seed": 14})
        if job["status"] != "done":
            bad("fixed_point", job.get("error"))
        else:
            canvas = (job.get("align") or {}).get("canvas") or {}
            im = job_images(base, job)[0]
            w, h = canvas.get("w", 0), canvas.get("h", 0)
            if w % 32 == 0 and h % 32 == 0 and im.size == tiny.size:
                ok("fixed_point", f"canvas {w}×{h}，输出 {im.size}（=源尺寸）")
            else:
                bad("fixed_point", f"canvas {canvas} 输出 {im.size} 源 {tiny.size}")
    except Exception as exc:  # noqa: BLE001
        bad("fixed_point", repr(exc))

    # ---------------------------------------------------------------- 5 custom
    print("\n[5/9] 编辑 size_mode=custom 768×512", flush=True)
    try:
        job = edit(base, {"prompt": "recompose as a wide shot of the same scene",
                          "images": [{"name": "s.png", "data": b64img(scene)}],
                          "size_mode": "custom", "width": 768, "height": 512,
                          "local": {"enabled": False}, "turbo": turbo, "seed": 15})
        if job["status"] != "done":
            bad("custom_size", job.get("error"))
        else:
            im = job_images(base, job)[0]
            if im.size == (768, 512):
                ok("custom_size", f"{im.size}")
            else:
                bad("custom_size", f"期望 (768,512)，实际 {im.size}")
    except Exception as exc:  # noqa: BLE001
        bad("custom_size", repr(exc))

    # ---------------------------------------------------------------- 6 scheme B
    print("\n[6/9] 局部编辑方案 B（裁切 + 贴回）", flush=True)
    try:
        box = (300, 300, 700, 700)
        job = edit(base, {"prompt": "replace the object inside the mask with a glossy red apple",
                          "images": [{"name": "s.png", "data": b64img(scene)}],
                          "mask": {"data": b64img(mask_rect(1024, 1024, box).convert("RGBA"))},
                          "size_mode": "follow",
                          "local": {"enabled": True, "scheme": "b", "blend_pixels": 24,
                                    "color_match": True, "color_strength": 0.85,
                                    "context_factor": 1.5, "context_pixels": 96},
                          "turbo": turbo, "seed": 16})
        if job["status"] != "done":
            bad("scheme_b", job.get("error"))
        else:
            im = job_images(base, job)[0]
            q = job.get("quality") or {}
            crop = (job.get("align") or {}).get("crop") or {}
            if im.size == scene.size and q.get("outside_max_abs") == 0:
                ok("scheme_b", f"{im.size}，crop {crop.get('w')}×{crop.get('h')}，遮罩外差异 0")
            else:
                bad("scheme_b", f"输出 {im.size}（源 {scene.size}）outside={q.get('outside_max_abs')}")
            im.save("storage/outputs/smoke_scheme_b.png")
    except Exception as exc:  # noqa: BLE001
        bad("scheme_b", repr(exc))

    # ---------------------------------------------------------------- 7 denoise
    print("\n[7/9] 编辑 denoise=0.55（全图轻度重绘）", flush=True)
    try:
        job = edit(base, {"prompt": "same scene, slightly warmer evening light",
                          "images": [{"name": "s.png", "data": b64img(scene)}],
                          "size_mode": "follow", "denoise": 0.55,
                          "local": {"enabled": False},
                          "steps": 25, "cfg": 1.0, "seed": 17})
        if job["status"] != "done":
            bad("denoise", job.get("error"))
        else:
            im = job_images(base, job)[0]
            if im.size == scene.size:
                ok("denoise", f"{im.size}, denoise=0.55")
            else:
                bad("denoise", f"尺寸 {im.size}")
            im.save("storage/outputs/smoke_denoise.png")
    except Exception as exc:  # noqa: BLE001
        bad("denoise", repr(exc))

    # ---------------------------------------------------------------- 8 三参考图
    print("\n[8/9] 编辑 3 张参考图", flush=True)
    try:
        ref_a = make_scene(512, 512)
        ref_b = make_scene(640, 480)
        job = edit(base, {"prompt": "Put the texture from <image2> and the palette of <image3> "
                                    "into the main scene of <image1>",
                          "images": [
                              {"name": "main.png", "data": b64img(scene)},
                              {"name": "tex.png", "data": b64img(ref_a)},
                              {"name": "pal.png", "data": b64img(ref_b)},
                          ],
                          "size_mode": "follow", "local": {"enabled": False},
                          "turbo": turbo, "seed": 18})
        if job["status"] != "done":
            bad("three_refs", job.get("error"))
        else:
            im = job_images(base, job)[0]
            refs = len((job.get("meta") or {}).get("input_urls") or [])
            if im.size == scene.size and refs == 3:
                ok("three_refs", f"{im.size}，{refs} 张参考图")
            else:
                bad("three_refs", f"尺寸 {im.size}，参考图 {refs}")
    except Exception as exc:  # noqa: BLE001
        bad("three_refs", repr(exc))

    # ---------------------------------------------------------------- 9 resolution
    print("\n[9/9] 编辑 resolution=1024（源已是 32 倍数）", flush=True)
    try:
        job = edit(base, {"prompt": "turn the scene into a watercolor painting, keep layout",
                          "images": [{"name": "s.png", "data": b64img(scene)}],
                          "size_mode": "follow", "resolution": 1024,
                          "local": {"enabled": False}, "turbo": turbo, "seed": 19})
        if job["status"] != "done":
            bad("resolution_param", job.get("error"))
        else:
            im = job_images(base, job)[0]
            q = job.get("quality") or {}
            if im.size == scene.size and q.get("size_match"):
                ok("resolution_param", f"{im.size}，零偏移守卫通过")
            else:
                bad("resolution_param", f"{im.size} {q}")
    except Exception as exc:  # noqa: BLE001
        bad("resolution_param", repr(exc))

    print("\n" + "=" * 62)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    for f in FAIL:
        print("  -", f)
    print("=" * 62)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
