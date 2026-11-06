"""端到端冒烟测试：直接打 HTTP API，验证服务真的能出图。

覆盖：
  1. /api/health           引擎可用、Ollama 可用
  2. /api/options          模型与预设齐备
  3. /api/styles           风格库目录
  4. /api/polish           提示词润色（Ollama）
  5. /api/generate         Turbo 8 步文生图
  6. /api/edit             单图编辑 + 遮罩局部编辑（零偏移 + 零色差验收）

用法：
    python scripts/smoke_api.py                # 默认 http://127.0.0.1:8700
    python scripts/smoke_api.py --base http://127.0.0.1:8700 --skip-polish
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import urllib.error
import urllib.request

from PIL import Image

PASSED: list[str] = []
FAILED: list[str] = []


def ok(name: str, detail: str = "") -> None:
    PASSED.append(name)
    print(f"  PASS  {name}" + (f"  ({detail})" if detail else ""), flush=True)


def fail(name: str, detail: str) -> None:
    FAILED.append(f"{name}: {detail}")
    print(f"  FAIL  {name}  -> {detail}", flush=True)


def http(method: str, url: str, payload: dict | None = None, timeout: float = 60.0):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, raw


def get_json(url: str, timeout: float = 60.0):
    status, raw = http("GET", url, timeout=timeout)
    return status, json.loads(raw.decode("utf-8"))


def post_json(url: str, payload: dict, timeout: float = 120.0):
    status, raw = http("POST", url, payload, timeout=timeout)
    return status, json.loads(raw.decode("utf-8"))


def data_url(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


def wait_job(base: str, job_id: str, timeout: float = 600.0) -> dict:
    started = time.time()
    last = ""
    while time.time() - started < timeout:
        _status, job = get_json(f"{base}/api/jobs/{job_id}")
        p = job.get("progress") or {}
        label = f"{job['status']} {p.get('value')}/{p.get('max')} {p.get('label') or ''}"
        if label != last:
            print(f"        {label}", flush=True)
            last = label
        if job["status"] in ("done", "error", "canceled"):
            return job
        time.sleep(1.0)
    raise TimeoutError(f"任务 {job_id} 超时")


def fetch_bytes(base: str, url: str) -> bytes:
    _status, raw = http("GET", base + url, timeout=120)
    return raw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8700")
    ap.add_argument("--skip-polish", action="store_true")
    ap.add_argument("--size", type=int, default=512, help="冒烟用尺寸（32 的倍数）")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    size = args.size

    print(f"== 冒烟测试 {base} ==", flush=True)

    # ---------------------------------------------------------------- health
    print("\n[1/6] health", flush=True)
    try:
        _s, health = get_json(f"{base}/api/health")
        if health.get("ok"):
            ok("health.ok")
        else:
            fail("health.ok", str(health)[:200])
        eng = health.get("engine") or {}
        if eng.get("available"):
            ok("engine.available", eng.get("device") or "")
        else:
            fail("engine.available", eng.get("reason") or "unknown")
        ol = health.get("ollama") or {}
        if ol.get("connected"):
            ok("ollama.connected", f"{len(ol.get('models') or [])} models")
        else:
            fail("ollama.connected", ol.get("error") or "not reachable")
    except Exception as exc:  # noqa: BLE001
        fail("health", repr(exc))
        return _summary()

    # ---------------------------------------------------------------- options
    print("\n[2/6] options", flush=True)
    try:
        _s, options = get_json(f"{base}/api/options")
        models = options.get("models") or {}
        counts = {k: len(v or []) for k, v in models.items()}
        ok("options.models", str(counts))
        if options.get("turbo_profiles"):
            ok("options.turbo_profiles", f"{len(options['turbo_profiles'])} 个")
        else:
            fail("options.turbo_profiles", "空")
        if options.get("capabilities", {}).get("precise_align"):
            ok("capabilities.precise_align")
    except Exception as exc:  # noqa: BLE001
        fail("options", repr(exc))

    # ---------------------------------------------------------------- styles
    print("\n[3/6] styles", flush=True)
    try:
        _s, catalog = get_json(f"{base}/api/styles")
        count = catalog.get("count") or {}
        ok("styles.catalog", f"creative={count.get('creative')} mj={count.get('mj')}")
        if not catalog.get("insertModes"):
            fail("styles.insertModes", "空")
    except Exception as exc:  # noqa: BLE001
        fail("styles", repr(exc))

    # ---------------------------------------------------------------- polish
    print("\n[4/6] polish", flush=True)
    if args.skip_polish:
        print("  跳过（--skip-polish）", flush=True)
    else:
        try:
            t0 = time.time()
            _s, polished = post_json(f"{base}/api/polish",
                                     {"prompt": "a corgi wearing sunglasses on a beach", "mode": "t2i"},
                                     timeout=300)
            text = polished.get("rewritten_prompt") or ""
            if text:
                ok("polish.rewritten", f"{len(text)} 字符, {int((time.time()-t0)*1000)}ms, "
                                       f"fallback={polished.get('fallback')}, wh_ratio={polished.get('wh_ratio')!r}")
            else:
                fail("polish.rewritten", "返回为空")
        except Exception as exc:  # noqa: BLE001
            fail("polish", repr(exc))

    # ---------------------------------------------------------------- 文生图
    print(f"\n[5/6] generate turbo 8 步 {size}×{size}", flush=True)
    t2i_png = None
    try:
        _s, submitted = post_json(f"{base}/api/generate", {
            "prompt": "A minimal ceramic teapot on a warm wooden table, soft window light from the left",
            "width": size, "height": size,
            "turbo": {"enabled": True, "profile": "turbo8_official"},
            "seed": 12345,
            "meta": {"source": "smoke_api"},
        })
        job_id = submitted["job_id"]
        t0 = time.time()
        job = wait_job(base, job_id)
        if job["status"] != "done":
            fail("generate.done", job.get("error") or job["status"])
        else:
            ok("generate.done", f"{time.time()-t0:.1f}s")
            images = job.get("images") or []
            if images:
                png = fetch_bytes(base, images[0]["url"])
                with Image.open(io.BytesIO(png)) as im:
                    if im.size == (size, size):
                        ok("generate.size", f"{im.size}")
                    else:
                        fail("generate.size", f"期望 {(size, size)} 实际 {im.size}")
                t2i_png = png
                ok("generate.image", f"{len(png)} 字节 {images[0]['url']}")
            else:
                fail("generate.images", "没有输出图片")
    except Exception as exc:  # noqa: BLE001
        fail("generate", repr(exc))

    # ---------------------------------------------------------------- 图像编辑
    print("\n[6/6] edit（单图 + 遮罩局部编辑）", flush=True)
    if t2i_png is None:
        print("  跳过（没有可用的输入图）", flush=True)
    else:
        try:
            with Image.open(io.BytesIO(t2i_png)) as im:
                src = im.convert("RGB")
            w, h = src.size
            # 画一个居中的方块遮罩（白=编辑区）
            mask = Image.new("L", (w, h), 0)
            box = (w // 4, h // 4, w * 3 // 4, h * 3 // 4)
            mask.paste(255, box)
            buf = io.BytesIO()
            src.save(buf, format="PNG")
            src_png = buf.getvalue()
            mbuf = io.BytesIO()
            mask.save(mbuf, format="PNG")

            _s, submitted = post_json(f"{base}/api/edit", {
                "prompt": "Replace the object in the masked area with a bright red apple",
                "images": [{"name": "input.png", "data": data_url(src_png)}],
                "mask": {"data": data_url(mbuf.getvalue())},
                "size_mode": "follow",
                "local": {"enabled": True, "scheme": "a", "feather": 24,
                          "color_match": True, "color_strength": 0.6},
                "turbo": {"enabled": True, "profile": "turbo8_official"},
                "seed": 777,
            })
            job_id = submitted["job_id"]
            t0 = time.time()
            job = wait_job(base, job_id)
            if job["status"] != "done":
                fail("edit.done", job.get("error") or job["status"])
            else:
                ok("edit.done", f"{time.time()-t0:.1f}s")
                align = job.get("align") or {}
                canvas = (align.get("canvas") or {})
                if canvas and canvas.get("w", 0) % 32 == 0 and canvas.get("h", 0) % 32 == 0:
                    ok("edit.canvas32", f"{canvas['w']}×{canvas['h']}")
                else:
                    fail("edit.canvas32", str(canvas))
                quality = job.get("quality") or {}
                outside = quality.get("outside_max_abs")
                if outside == 0:
                    ok("edit.zero_color_shift", "遮罩外 max_abs_diff = 0")
                elif outside is None:
                    fail("edit.zero_color_shift", f"没有度量值 quality={quality}")
                else:
                    fail("edit.zero_color_shift", f"遮罩外差异 {outside}")
                if quality.get("size_match"):
                    ok("edit.zero_pixel_shift", f"输出尺寸 == 输入尺寸 {src.size}")
                else:
                    fail("edit.zero_pixel_shift", str(quality))
                images = job.get("images") or []
                if images:
                    png = fetch_bytes(base, images[0]["url"])
                    with Image.open(io.BytesIO(png)) as im:
                        if im.size == src.size:
                            ok("edit.output_size", f"{im.size}")
                        else:
                            fail("edit.output_size", f"期望 {src.size} 实际 {im.size}")
                    with open("storage/outputs/smoke_edit.png", "wb") as fh:
                        fh.write(png)
        except Exception as exc:  # noqa: BLE001
            fail("edit", repr(exc))

    return _summary()


def _summary() -> int:
    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for item in FAILED:
        print(f"  - {item}")
    print("=" * 60)
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
