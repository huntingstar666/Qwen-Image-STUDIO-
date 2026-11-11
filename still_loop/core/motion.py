"""定格渲染与视频编码：逐帧烘焙（抖动/颗粒/暗角/色彩轻微漂移）+ ffmpeg 封装。

只依赖 Pillow 与系统 ffmpeg；没有 numpy 时自动退化为无噪点版本。
"""
from __future__ import annotations

import random
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from .. import config

try:  # numpy 可选
    import numpy as np
except Exception:  # noqa: BLE001
    np = None  # type: ignore[assignment]


STYLE_HINTS = {
    "clay": "画面是定格黏土动画质感：人偶与道具由手捏的黏土/橡皮泥做成，"
            "表面留有不规则的指痕、接缝与轻微凹凸，棚拍式柔光，实物微距景深；",
    "paper": "画面是定格纸偶动画质感：人物与场景由剪纸、卡纸拼贴而成，"
             "能看到纸张纤维、折痕与层叠阴影，平面布景配合顶光；",
    "felt": "画面是定格毛毡动画质感：角色由羊毛毡/毛线缝制，"
            "表面有绒毛、针脚与柔软体积感，暖色棚拍布光；",
    "lego": "画面是积木定格动画质感：角色与道具由塑料积木拼搭，"
            "能看到颗粒、接缝与塑料反光，桌面微距拍摄；",
}

STYLE_LABELS = {
    "clay": "黏土",
    "paper": "纸偶",
    "felt": "毛毡",
    "lego": "积木",
}


def style_hint(style: str | None) -> str:
    return STYLE_HINTS.get(str(style or "").strip().lower(), "")


def _rgba(image: Image.Image) -> Image.Image:
    return image if image.mode == "RGBA" else image.convert("RGBA")


def _jitter(image: Image.Image, rng: random.Random, pixels: float, degrees: float) -> Image.Image:
    if pixels <= 0 and degrees <= 0:
        return image
    dx = rng.uniform(-pixels, pixels)
    dy = rng.uniform(-pixels, pixels)
    angle = rng.uniform(-degrees, degrees) if degrees > 0 else 0.0
    return image.rotate(angle, resample=Image.Resampling.BICUBIC,
                        translate=(dx, dy), fillcolor=(0, 0, 0, 0))


def _bake_numpy(image: Image.Image, rng: random.Random, grain: float,
                vignette: float, color_boil: float) -> Image.Image:
    array = np.asarray(_rgba(image)).astype(np.float32)  # type: ignore[union-attr]
    height, width = array.shape[:2]
    rgb = array[..., :3]
    if grain > 0:
        noise = np.random.default_rng(rng.randrange(1 << 31)).normal(
            0.0, 255.0 * grain, (height, width, 1)).astype(np.float32)
        rgb += noise
    if vignette > 0:
        yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
        radius = np.sqrt(((xx - width / 2) / max(1.0, width / 2)) ** 2
                         + ((yy - height / 2) / max(1.0, height / 2)) ** 2)
        mask = 1.0 - vignette * np.clip((radius - 0.55) / 0.95, 0.0, 1.0)
        rgb *= mask[..., None]
    if color_boil > 0:
        gains = np.array([rng.uniform(1 - color_boil, 1 + color_boil) for _ in range(3)],
                         dtype=np.float32)
        rgb *= gains.reshape(1, 1, 3)
    array[..., :3] = np.clip(rgb, 0.0, 255.0)
    return Image.fromarray(array.astype(np.uint8), "RGBA")


def _bake_pillow(image: Image.Image, rng: random.Random, grain: float,
                 vignette: float, color_boil: float) -> Image.Image:
    """无 numpy 的简化版：只做颗粒与暗角。"""
    rgba = _rgba(image)
    width, height = rgba.size
    if grain > 0:
        noise = Image.effect_noise((width, height), 255 * grain * 0.35).convert("RGBA")
        noise.putalpha(int(min(255, 90 * grain * 10)))
        rgba = Image.alpha_composite(rgba, noise)
    if vignette > 0:
        mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((-width * 0.15, -height * 0.15, width * 1.15, height * 1.15),
                     fill=255)
        dark = Image.new("RGBA", (width, height), (0, 0, 0, int(255 * vignette)))
        rgba = Image.composite(rgba, Image.alpha_composite(rgba, dark), mask)
    return rgba


def stopmotion_frames(images: list[Image.Image], holds: list[int], *,
                      jitter: float, grain: float, vignette: float,
                      color_boil: float, seed: int = 20261107) -> list[Image.Image]:
    """按每帧停留格数展开，并逐帧加入轻微的实拍抖动与颗粒。"""
    baked: list[Image.Image] = []
    for position, image in enumerate(images):
        hold = max(1, int(holds[position] if position < len(holds) else 1))
        rng = random.Random(seed + position * 7919)
        base = _rgba(image)
        for step in range(hold):
            frame_rng = random.Random(seed + position * 7919 + step * 104729)
            frame = _jitter(base, frame_rng, jitter, jitter * 0.06)
            if np is not None:
                frame = _bake_numpy(frame, frame_rng, grain, vignette, color_boil)
            else:
                frame = _bake_pillow(frame, frame_rng, grain, vignette, color_boil)
            baked.append(frame)
    return baked


def expand_holds(images: list[Image.Image], holds: list[int]) -> list[Image.Image]:
    expanded: list[Image.Image] = []
    for position, image in enumerate(images):
        hold = max(1, int(holds[position] if position < len(holds) else 1))
        expanded.extend([image] * hold)
    return expanded


def ffmpeg_available() -> bool:
    return bool(shutil.which(config.FFMPEG))


def encode_video(frames: list[Image.Image], target: Path, fps: int,
                 container: str) -> str:
    """把帧序列通过管道交给 ffmpeg 编码；返回编码器名。"""
    if not frames:
        raise ValueError("没有可编码的帧")
    if not ffmpeg_available():
        raise RuntimeError("未找到 ffmpeg，无法输出视频")
    width, height = frames[0].size
    if width % 2 or height % 2:  # yuv420p 要求偶数尺寸
        width -= width % 2
        height -= height % 2
    command = [
        config.FFMPEG, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{width}x{height}", "-r", str(int(fps)), "-i", "-",
    ]
    if container == "webm":
        command += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30",
                    "-pix_fmt", "yuv420p", "-row-mt", "1"]
    else:
        command += ["-c:v", "libx264", "-preset", "medium", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    command.append(str(target))
    process = subprocess.Popen(command, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame in frames:
            process.stdin.write(_rgba(frame).tobytes())
        process.stdin.close()
    except BrokenPipeError as exc:  # ffmpeg 提前退出
        raise RuntimeError(f"ffmpeg 中断：{exc}") from exc
    _, stderr = process.communicate()
    if process.returncode != 0:
        message = stderr.decode("utf-8", "ignore").strip()[:400]
        raise RuntimeError(f"ffmpeg 编码失败：{message}")
    return "ffmpeg"


def probe_video(path: Path) -> dict[str, Any]:
    """读回视频的真实帧数与时长（ffprobe 缺失时返回空）。"""
    probe = shutil.which("ffprobe")
    if not probe:
        return {}
    try:
        result = subprocess.run(
            [probe, "-v", "error", "-select_streams", "v:0",
             "-count_frames", "-show_entries", "stream=nb_read_frames,r_frame_rate,duration",
             "-of", "default=noprint_wrappers=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        data: dict[str, Any] = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            if key and value:
                data[key] = value
        frames = data.get("nb_read_frames")
        return {
            "frames": int(frames) if frames and frames.isdigit() else None,
            "fps": data.get("r_frame_rate") or "",
            "seconds": float(data["duration"]) if data.get("duration") else None,
        }
    except Exception:  # noqa: BLE001
        return {}


def snapshot_frames(frames: list[Image.Image], target_dir: Path,
                    limit: int = 24) -> list[str]:
    """把展开后的帧落成 PNG（排查问题时用，最多 limit 张）。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    names = []
    for index, frame in enumerate(frames[:limit]):
        name = f"bake_{index:03d}.png"
        _rgba(frame).save(target_dir / name)
        names.append(name)
    return names
