"""局部编辑基线：一次跑完 a / b / native / remove 四条路线并打印可复现数据。

用法（需要服务已启动）：
    python scripts/bench_local_edit.py
    python scripts/bench_local_edit.py --base http://127.0.0.1:8700 --seed 851971521
    python scripts/bench_local_edit.py --image 原图.png --mask 遮罩.png --prompt "去掉衣领上的小国旗"
    python scripts/bench_local_edit.py --out docs/benchmarks/local_edit_baseline.md

不给图时用内置合成夹具（灰蓝渐变 + 角标 + 柔和描边遮罩），保证换机器也能一条命令复现。
输出字段：方案、裁块、changed_ratio（全图）、mask_changed_ratio（遮罩内）、
outside_max_abs（遮罩外最大差异）、耗时。
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image, ImageDraw

DEFAULT_PROMPT = "去掉衣领上的小国旗"
DEFAULT_SEED = 851971521


def _data_url(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def fixture(size: int = 1024) -> tuple[Image.Image, np.ndarray]:
    """合成夹具：渐变底 + 高亮角标（模拟要移除的小目标）+ 柔和遮罩。"""
    yy, xx = np.meshgrid(
        np.linspace(0, 1, size, dtype=np.float32),
        np.linspace(0, 1, size, dtype=np.float32),
        indexing="ij",
    )
    base = np.stack([
        70 + 60 * xx,
        90 + 50 * yy,
        110 + 40 * (1 - xx * yy),
    ], axis=2)
    image = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    cx, cy, r = int(size * 0.42), int(size * 0.4), max(8, int(size * 0.035))
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 60, 60))
    draw.rectangle([cx - r // 2, cy - r // 3, cx + r // 2, cy + r // 4], fill=(250, 235, 70))

    mask = np.zeros((size, size), dtype=np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    # 中间实心、外圈柔和过渡：正好用来验证"送采样器二值化 / 合成保留软边"
    mask = np.clip((r * 1.6 - dist) / (r * 0.6), 0.0, 1.0).astype(np.float32)
    return image, mask


def mask_png(mask: np.ndarray) -> Image.Image:
    alpha = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
    rgb = np.full((*alpha.shape, 3), 255, dtype=np.uint8)
    return Image.fromarray(np.dstack([rgb, alpha]))


def http_json(method: str, url: str, payload: dict | None = None, timeout: float = 120.0):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def submit_edit(base: str, payload: dict) -> str:
    data = http_json("POST", f"{base}/api/edit", payload)
    return str(data.get("id") or data.get("job_id") or "")


def wait_job(base: str, job_id: str, timeout: float) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = http_json("GET", f"{base}/api/jobs/{job_id}", timeout=30)
        if str(last.get("status")) in ("done", "error", "canceled"):
            return last
        time.sleep(0.7)
    last["status"] = last.get("status") or "timeout"
    return last


def run_route(base: str, name: str, payload: dict, timeout: float) -> dict:
    started = time.time()
    job_id = submit_edit(base, payload)
    if not job_id:
        return {"route": name, "status": "no-job"}
    job = wait_job(base, job_id, timeout)
    quality = job.get("quality") or {}
    return {
        "route": name,
        "status": job.get("status"),
        "wall_s": round(time.time() - started, 1),
        "crop": quality.get("crop") or (job.get("align") or {}).get("crop"),
        "changed": quality.get("changed_ratio"),
        "mask_changed": quality.get("mask_changed_ratio"),
        "outside": quality.get("outside_max_abs"),
        "error": job.get("error"),
    }


def fmt(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def fmt_crop(crop: dict | None) -> str:
    if not isinstance(crop, dict):
        return "—"
    return f"{crop.get('w')}×{crop.get('h')}@{crop.get('x')},{crop.get('y')}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8700")
    parser.add_argument("--image", default="")
    parser.add_argument("--mask", default="")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--out", default="")
    parser.add_argument("--no-warmup", action="store_true",
                        help="跳过预热（不跳过的话第一条路线的耗时会包含模型加载）")
    args = parser.parse_args()

    if args.image:
        image = Image.open(args.image).convert("RGB")
        if args.mask:
            alpha = Image.open(args.mask).convert("L").resize(image.size, Image.NEAREST)
            mask = np.asarray(alpha, dtype=np.float32) / 255.0
        else:
            raise SystemExit("给了 --image 就必须同时给 --mask")
    else:
        image, mask = fixture()

    payload_base = {
        "prompt": args.prompt,
        "images": [{"name": "bench.png", "data": _data_url(image)}],
        "mask": {"data": _data_url(mask_png(mask))},
        "size_mode": "follow",
        "fit": "pad",
        "pad_mode": "edge",
        "seed": args.seed,
        "meta": {"source": "bench/local_edit", "rawPrompt": args.prompt},
    }
    routes = [
        ("b-局部编辑", {"preset": "mask_edit", "local": {"scheme": "b"}, "task": {"mode": "edit"}}),
        ("a-整画布", {"preset": "mask_edit", "local": {"scheme": "a"}, "task": {"mode": "edit"}}),
        ("native-原生", {"preset": "native", "local": {"scheme": "native"}, "task": {"mode": "edit"}}),
        ("remove-元素移除", {"preset": "remove", "task": {"mode": "remove"}}),
    ]

    if not args.no_warmup:
        print("[bench] 预热（模型加载，不计入基线）...", flush=True)
        run_route(args.base, "warmup", {**payload_base, **routes[0][1]}, args.timeout)

    rows = []
    for name, extra in routes:
        payload = {**payload_base, **extra}
        print(f"[bench] {name} ...", flush=True)
        rows.append(run_route(args.base, name, payload, args.timeout))

    lines = [
        "| 路线 | 状态 | 裁块 | 全图改动 | 遮罩内改动 | 遮罩外最大差异 | 耗时(s) |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['route']} | {row['status']} | {fmt_crop(row.get('crop'))} | "
            f"{fmt(row.get('changed'))} | {fmt(row.get('mask_changed'))} | "
            f"{fmt(row.get('outside'))} | {fmt(row.get('wall_s'))} |"
        )
    table = "\n".join(lines)
    print("\n" + table + "\n", flush=True)

    if args.out:
        header = (
            f"# 局部编辑基线（seed={args.seed}）\n\n"
            f"- 夹具：{'内置合成图' if not args.image else args.image}\n"
            f"- 指令：{args.prompt}\n"
            f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"- 服务：{args.base}\n\n"
        )
        note = (
            "\n> `全图改动` 会被小目标面积稀释，判断“有没有真的改到目标”看 `遮罩内改动`；"
            "`遮罩外最大差异` 应为 0（零色差硬门槛）。\n"
        )
        out_dir = os.path.dirname(args.out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(header + table + "\n" + note)
        print(f"[bench] 已写入 {args.out}", flush=True)

    if any(row["status"] != "done" for row in rows):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
