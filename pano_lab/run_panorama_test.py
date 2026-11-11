"""独立目录里的「能否生成真 360° 全景」实验脚本（只调 8700 现有 API，不改项目代码）。

四组对照：
  A. 文生图 2:1 + 360° 等距柱状提示词（室内）
  B. 文生图 2:1 + 360° 等距柱状提示词（户外）
  C. 图生图 panorama 任务（源图约占画布 75%，与现有行为一致）
  D. 图生图 panorama 任务（先把源图缩到约占画布 40%，逼模型补出更多场景）

用法：
  python pano_lab/run_panorama_test.py            # 跑全部
  python pano_lab/run_panorama_test.py --tests A B
"""

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8700"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TMP = os.path.join(HERE, "tmp")
SOURCE = os.path.join(
    os.path.dirname(HERE),
    "storage", "uploads", "up-20261108-213644-6bc579_20220318164313801.png",
)

PROMPT_A = (
    "360° 等距柱状全景照片，现代客厅室内，完整球面视角：沙发、茶几、落地窗、"
    "天花板与地板全部可见，四周环绕连续，左右边缘无缝衔接，无重复物体，画面写实"
)
PROMPT_B = (
    "360° equirectangular panorama photograph of a mountain lake at sunset, "
    "full spherical view, sky above and ground below, seamless left and right edges, "
    "continuous horizon, no duplicated subjects, photorealistic"
)
PROMPT_C = (
    "把画面扩展成以人物为中心的 360° 等距柱状全景：四周环视可见完整房间、家具、"
    "窗户、天花板与地板，左右边缘无缝衔接，画面写实"
)
PROMPT_E = (
    "把画面扩展为 360° 等距柱状全景：保持人物与旗帜外观，补齐房间四周、天花板与地板，"
    "四周环境连续，左右边缘自然衔接，画面写实"
)


def post(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.load(resp)


def get_json(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=60) as resp:
        return json.load(resp)


def wait_job(job_id: str, timeout: float = 900) -> dict:
    started = time.time()
    last_status = None
    while time.time() - started < timeout:
        job = get_json(f"/api/jobs/{job_id}")
        status = job.get("status")
        if status != last_status:
            print(f"    status={status} progress={job.get('progress')}")
            last_status = status
        if status in ("done", "error", "canceled"):
            return job
        time.sleep(1)
    raise TimeoutError(job_id)


def download(url: str, name: str) -> tuple[str, int]:
    target = BASE + url if url.startswith("/") else url
    # 输出文件名含中文，urllib 需要先做百分号编码
    target = urllib.parse.quote(target, safe=":/%?=&")
    with urllib.request.urlopen(target, timeout=180) as resp:
        data = resp.read()
    path = os.path.join(OUT, name)
    with open(path, "wb") as fh:
        fh.write(data)
    return path, len(data)


def data_url_from_png_bytes(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def shrink_source(width: int) -> bytes:
    from PIL import Image

    os.makedirs(TMP, exist_ok=True)
    image = Image.open(SOURCE).convert("RGB")
    ratio = width / image.width
    size = (width, max(32, int(round(image.height * ratio / 32)) * 32))
    small = image.resize(size, Image.LANCZOS)
    path = os.path.join(TMP, f"source_w{width}.png")
    small.save(path)
    return open(path, "rb").read()


def run_test(label: str, kind: str, payload: dict, seed: int) -> dict:
    print(f"[{label}] 提交 {kind} 任务 …")
    job_id = post("/api/generate" if kind == "t2i" else "/api/edit", payload)["job_id"]
    job = wait_job(job_id)
    result = {
        "test": label,
        "kind": kind,
        "job_id": job_id,
        "status": job.get("status"),
        "error": job.get("error"),
        "elapsed_ms": job.get("elapsed_ms"),
        "quality": (job.get("quality") or {}).get("panorama"),
        "images": [],
    }
    for index, image in enumerate(job.get("images") or []):
        if not isinstance(image, dict) or not image.get("url"):
            continue
        name = f"{label}-s{seed}-{index}{os.path.splitext(image.get('filename') or '.png')[1]}"
        path, size = download(image["url"], name)
        result["images"].append(
            {"path": os.path.relpath(path, HERE), "bytes": size,
             "width": image.get("width"), "height": image.get("height")})
        print(f"    保存 {result['images'][-1]['path']} "
              f"({image.get('width')}×{image.get('height')}, {size / 1e6:.1f}MB)")
    if job.get("status") != "done":
        print(f"    失败：{job.get('error')}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tests", nargs="*", default=["A", "B", "C", "D"])
    parser.add_argument("--seed", type=int, default=1207)
    args = parser.parse_args()

    os.makedirs(OUT, exist_ok=True)
    if not os.path.exists(SOURCE):
        print(f"源图不存在：{SOURCE}")
        return 1

    source_url = data_url_from_png_bytes(open(SOURCE, "rb").read())
    small_url = data_url_from_png_bytes(shrink_source(800))

    results = []
    for label in args.tests:
        label = label.upper()
        if label == "A":
            results.append(run_test("A-t2i-indoor", "t2i", {
                "prompt": PROMPT_A, "model": "qwen",
                "width": 2048, "height": 1024,
                "seed": args.seed, "steps": 9, "cfg": 1.0,
                "turbo": {"enabled": True},
            }, args.seed))
        elif label == "B":
            results.append(run_test("B-t2i-outdoor", "t2i", {
                "prompt": PROMPT_B, "model": "qwen",
                "width": 2048, "height": 1024,
                "seed": args.seed, "steps": 9, "cfg": 1.0,
                "turbo": {"enabled": True},
            }, args.seed))
        elif label == "C":
            results.append(run_test("C-edit-75pct", "edit", {
                "preset": "panorama",
                "prompt": PROMPT_C,
                "images": [source_url],
                "task": {"mode": "panorama"},
                "panorama": {"aspect": "2:1", "long_side": 2048, "wrap": True, "seam_blend": 24},
                "seed": args.seed,
                "size_mode": "custom",
            }, args.seed))
        elif label == "D":
            results.append(run_test("D-edit-40pct", "edit", {
                "preset": "panorama",
                "prompt": PROMPT_C,
                "images": [small_url],
                "task": {"mode": "panorama"},
                "panorama": {"aspect": "2:1", "long_side": 2048, "wrap": True, "seam_blend": 24},
                "seed": args.seed,
                "size_mode": "custom",
            }, args.seed))
        elif label in ("E", "F"):
            long_side = 2048 if label == "E" else 3072
            results.append(run_test(f"{label}-360-{long_side // 1024}k", "edit", {
                "preset": "panorama360",
                "prompt": PROMPT_E,
                "images": [source_url],
                "task": {"mode": "panorama360"},
                "panorama360": {
                    "coverage": 0.4, "long_side": long_side,
                    "wrap": True, "seam_blend": 24, "level": True,
                },
                "seed": args.seed,
                "size_mode": "custom",
            }, args.seed))
        else:
            print(f"未知测试：{label}")

    path = os.path.join(OUT, "results.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
    print(f"\n结果已写入 {os.path.relpath(path, os.path.dirname(HERE))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
