"""文生 360° 全景一条命令（独立目录，不改项目代码）。

流程：补全等距柱状提示词 → 调 8700 /api/generate（2:1）→ 下载 →
本地左右接缝色差融合 → 打印接缝指标 → 可选自动打开全景查看器。

用法示例：
  python pano_lab/make_panorama.py --prompt "现代客厅，午后阳光，浅色沙发、木地板、落地窗"
  python pano_lab/make_panorama.py --prompt "雪山湖泊日落" --seed 2026 --open
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import webbrowser

import numpy as np
from PIL import Image

BASE = "http://127.0.0.1:8700"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")

EQUIRECT_CN = (
    "360° 等距柱状全景照片，完整球面视角：四周环境环绕连续，"
    "天花板与地板可见，左右边缘无缝衔接，无重复物体，画面写实"
)
EQUIRECT_EN = "360-degree equirectangular panorama, full spherical view, seamless left-right"


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
    last = None
    while time.time() - started < timeout:
        job = get_json(f"/api/jobs/{job_id}")
        status = job.get("status")
        if status != last:
            print(f"  状态 {status}")
            last = status
        if status in ("done", "error", "canceled"):
            return job
        time.sleep(1)
    raise TimeoutError(job_id)


def download(url: str, target: str) -> None:
    full = BASE + url if url.startswith("/") else url
    full = urllib.parse.quote(full, safe=":/%?=&")
    with urllib.request.urlopen(full, timeout=180) as resp:
        data = resp.read()
    with open(target, "wb") as fh:
        fh.write(data)


def build_prompt(prompt: str) -> str:
    lowered = prompt.lower()
    if "等距柱状" in prompt or "equirect" in lowered:
        return prompt
    return f"{EQUIRECT_CN}。场景：{prompt}。{EQUIRECT_EN}"


def seam_metrics(arr: np.ndarray, band: int = 8) -> tuple[float, float]:
    """返回（逐列色差均值, 首尾列逐像素差均值）。"""
    left = arr[:, :band, :].mean(axis=1)
    right = arr[:, -band:, :].mean(axis=1)
    color = float(np.abs(left - right).mean())
    pixel = float(np.abs(arr[:, 0, :] - arr[:, -1, :]).mean())
    return color, pixel


def wrap_blend(arr: np.ndarray) -> tuple[np.ndarray, dict]:
    """把首尾接缝的色差按水平线性斜坡摊平：左右各承担一半，中间汇合。"""
    height, width, _ = arr.shape
    band = max(4, min(16, width // 64))
    left = arr[:, :band, :].mean(axis=1)
    right = arr[:, -band:, :].mean(axis=1)
    diff = right - left
    # 左端 +0.5·diff，右端 -0.5·diff，两端在中间对齐
    ramp = 0.5 - np.linspace(0.0, 1.0, width)[None, :, None]
    out = arr + diff[:, None, :] * ramp
    return np.clip(out, 0, 255), {"band": band, "shift": np.abs(diff).mean(axis=0).round(2).tolist()}


def ensure_server(port: int = 8799) -> bool:
    """端口已被占用就认为服务已在跑；否则尝试拉起一个后台静态服务（失败返回 False）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            return True

    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(
            [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
    except OSError:
        return False
    for _ in range(30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def publish_sample(path: str) -> str:
    """复制一份到 panorama_360/samples/，保证查看器静态服务无论根目录是哪都能取到。"""
    samples = os.path.join(ROOT, "panorama_360", "samples")
    os.makedirs(samples, exist_ok=True)
    name = os.path.basename(path)
    with open(path, "rb") as src, open(os.path.join(samples, name), "wb") as dst:
        dst.write(src.read())
    return name


def open_viewer(sample_name: str, port: int = 8799) -> str:
    quoted = urllib.parse.quote(sample_name)
    if ensure_server(port):
        url = (f"http://127.0.0.1:{port}/panorama_360/"
               f"?mode=sphere&src=samples/{quoted}")
        webbrowser.open(url)
        return url
    fallback = (f"http://127.0.0.1:{port}/?mode=sphere&src=samples/{quoted}")
    print("后台服务没起来：请先双击 panorama_360/启动全景查看器.bat，"
          f"然后打开 {fallback}")
    print(f"  或直接运行：panorama_360\\启动全景查看器.bat {sample_name}")
    return fallback


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True, help="场景描述（会自动补等距柱状关键词）")
    parser.add_argument("--width", type=int, default=2048)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--steps", type=int, default=9)
    parser.add_argument("--cfg", type=float, default=1.0)
    parser.add_argument("--blend", choices=["on", "off"], default="on")
    parser.add_argument("--open", action="store_true", help="生成后自动打开全景查看器")
    args = parser.parse_args()

    if args.width * 2 != args.height * 4 and abs(args.width / args.height - 2) > 0.01:
        print("提醒：等距柱状建议 2:1，当前尺寸不是 2:1。")

    os.makedirs(OUT, exist_ok=True)
    seed = args.seed or int(time.time()) % 2_000_000_000
    prompt = build_prompt(args.prompt)
    print(f"提示词：{prompt}")
    print(f"尺寸：{args.width}×{args.height}  seed={seed}")

    job_id = post("/api/generate", {
        "prompt": prompt,
        "model": "qwen",
        "width": args.width,
        "height": args.height,
        "seed": seed,
        "steps": args.steps,
        "cfg": args.cfg,
        "turbo": {"enabled": True},
    })["job_id"]
    print(f"任务 {job_id} 已提交，等待完成 …")
    job = wait_job(job_id)
    if job.get("status") != "done" or not job.get("images"):
        print(f"失败：{job.get('error')}")
        return 1

    stamp = time.strftime("%Y%m%d-%H%M%S")
    raw_path = os.path.join(OUT, f"t2i360-{stamp}-s{seed}.png")
    download(job["images"][0]["url"], raw_path)
    print(f"原始输出：{os.path.relpath(raw_path, ROOT)}")

    final_path = raw_path
    if args.blend == "on":
        arr = np.asarray(Image.open(raw_path).convert("RGB")).astype(np.float32)
        before_color, before_pixel = seam_metrics(arr)
        blended, report = wrap_blend(arr)
        after_color, after_pixel = seam_metrics(blended)
        final_path = raw_path.replace(".png", "-blend.png")
        Image.fromarray(blended.astype(np.uint8)).save(final_path)
        print(f"接缝融合：色差 {before_color:.2f} → {after_color:.2f}"
              f"（逐像素 {before_pixel:.2f} → {after_pixel:.2f}），band={report['band']}")
        print(f"融合输出：{os.path.relpath(final_path, ROOT)}")

    if args.open:
        sample = publish_sample(final_path)
        print(f"示例已放入 panorama_360/samples/{sample}")
        print(f"查看器：{open_viewer(sample)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
