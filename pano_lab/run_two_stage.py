"""两段式验证：竖图 → 先扩成横图 → 再跑 360° 全景（独立目录实验，不改项目代码）。

用法：python pano_lab/run_two_stage.py
产物：pano_lab/out/two-stage-step1-*.png、two-stage-step2-*.png
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time

import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_panorama_test import (  # noqa: E402
    OUT, data_url_from_png_bytes, download, post, wait_job,
)

#: 用户实测效果差的竖图（1100×1586）
SOURCE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "storage", "uploads", "up-20261111-161423-9d7e2d_艺术懂吗.png",
)


def run_job(payload: dict, label: str, seed: int) -> tuple[dict, str]:
    print(f"[{label}] 提交任务 …")
    job_id = post("/api/edit", payload)["job_id"]
    job = wait_job(job_id)
    if job.get("status") != "done" or not job.get("images"):
        raise RuntimeError(f"{label} 失败：{job.get('error')}")
    image = job["images"][0]
    name = f"{label}-s{seed}{os.path.splitext(image.get('filename') or '.png')[1]}"
    path, size = download(image["url"], name)
    print(f"  {os.path.basename(path)}  {image.get('width')}×{image.get('height')}  {size/1e6:.1f}MB  "
          f"{job.get('elapsed_ms')}ms")
    return job, path


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    seed = 1207
    src_url = data_url_from_png_bytes(open(SOURCE, "rb").read())

    # 第一段：左右各扩 60%，竖图变成 ~3:2 横图（源图区域不改）
    job1, path1 = run_job({
        "prompt": "保持人物、光线与房间细节不变，把画面左右两侧自然延展成完整房间",
        "images": [src_url],
        "task": {"mode": "outpaint"},
        "outpaint": {"left": 60, "right": 60},
        "seed": seed,
        "size_mode": "custom",
    }, "two-stage-step1", seed)

    # 第二段：把横图作为源图跑 360°，coverage 40%
    stage1_url = data_url_from_png_bytes(open(path1, "rb").read())
    job2, path2 = run_job({
        "preset": "panorama360",
        "prompt": "360° 等距柱状全景：室内卧室，木地板、白墙、窗帘，四周环境连续，左右自然衔接，画面写实",
        "images": [stage1_url],
        "task": {"mode": "panorama360"},
        "panorama360": {
            "coverage": 0.4, "long_side": 3072,
            "wrap": True, "seam_blend": 24, "level": True,
        },
        "seed": seed,
        "size_mode": "custom",
    }, "two-stage-step2", seed)

    info = (job2.get("quality") or {}).get("panorama360") or {}
    print("\n第二段 quality：")
    print("  canvas", info.get("canvas"), "work", info.get("work"), "pads", info.get("pads"))
    for key, value in ((info.get("seam_report") or {}).get("sides") or {}).items():
        print(f"  seam {key}: {value.get('before_mean_abs')} → {value.get('after_mean_abs')}")
    print("  wrap", info.get("wrap_report"))

    result = {
        "step1": {
            "job_id": job1["id"],
            "size": [job1["images"][0].get("width"), job1["images"][0].get("height")],
            "path": os.path.basename(path1),
        },
        "step2": {
            "job_id": job2["id"],
            "size": [job2["images"][0].get("width"), job2["images"][0].get("height")],
            "path": os.path.basename(path2),
            "quality": info,
        },
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(os.path.join(OUT, "two-stage-result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
