"""音频处理：探测、归一化、波形峰值、静音检测。

全部走 ffmpeg / ffprobe，不引入额外音频依赖。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from .. import config
from .errors import StudioError

#: 上传音频的允许扩展名
AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".mp4", ".mov")
#: 背景音乐允许的扩展名
BGM_EXTS = AUDIO_EXTS
#: 上传上限
MAX_AUDIO_BYTES = 200 * 1024 * 1024


def require_ffmpeg() -> str:
    exe = shutil.which(config.FFMPEG) or shutil.which("ffmpeg")
    if not exe:
        raise StudioError("未找到 ffmpeg，请确认已安装并加入 PATH", code="ffmpeg_missing", status=500)
    return exe


def require_ffprobe() -> str:
    exe = shutil.which(config.FFPROBE) or shutil.which("ffprobe")
    if exe:
        return exe
    ffmpeg = require_ffmpeg()
    candidate = str(Path(ffmpeg).with_name("ffprobe.exe" if ffmpeg.lower().endswith(".exe") else "ffprobe"))
    if Path(candidate).is_file():
        return candidate
    raise StudioError("未找到 ffprobe（与 ffmpeg 同目录）", code="ffprobe_missing", status=500)


def _run(cmd: list[str], *, timeout: float = 300.0, capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def suffix_of(filename: str) -> str:
    ext = Path(str(filename or "")).suffix.lower()
    return ext if ext else ".bin"


def check_audio_ext(filename: str, *, bgm: bool = False) -> str:
    ext = suffix_of(filename)
    allowed = BGM_EXTS if bgm else AUDIO_EXTS
    if ext not in allowed:
        raise StudioError(f"不支持的音频格式：{ext}（支持 {', '.join(allowed)}）",
                          code="unsupported_format")
    return ext


# --------------------------------------------------------------------------- 探测


def probe(path: Path) -> dict[str, Any]:
    """返回 ``{"durationMs", "sampleRate", "channels", "codec"}``。"""
    exe = require_ffprobe()
    result = _run([
        exe, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
        "-of", "json", str(path),
    ], timeout=60)
    if result.returncode != 0:
        raise StudioError(f"无法解析音频：{result.stderr.decode('utf-8', 'replace')[:300]}",
                          code="bad_audio")
    data = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
    stream = (data.get("streams") or [{}])[0]
    duration = float((data.get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise StudioError("音频时长读取失败（文件可能损坏）", code="bad_audio")
    return {
        "durationMs": int(round(duration * 1000)),
        "sampleRate": int(stream.get("sample_rate") or 0),
        "channels": int(stream.get("channels") or 0),
        "codec": str(stream.get("codec_name") or ""),
    }


# --------------------------------------------------------------------------- 归一化


def normalize_to_m4a(source: Path, target: Path) -> dict[str, Any]:
    """统一转成浏览器可播放的 AAC/m4a，同时得到准确时长。"""
    exe = require_ffmpeg()
    target.parent.mkdir(parents=True, exist_ok=True)
    result = _run([
        exe, "-y", "-v", "error", "-i", str(source),
        "-vn", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "192k",
        str(target),
    ], timeout=600)
    if result.returncode != 0 or not target.is_file():
        raise StudioError(
            f"音频转码失败：{result.stderr.decode('utf-8', 'replace')[:300]}", code="bad_audio")
    return probe(target)


# --------------------------------------------------------------------------- 波形


def build_peaks(source: Path, duration_ms: int) -> list[int]:
    """解码成 8kHz 单声道 PCM，按 20ms 一桶取峰值（0~100）。"""
    if duration_ms <= 0:
        return []
    exe = require_ffmpeg()
    sample_rate = 8000
    result = _run([
        exe, "-v", "error", "-i", str(source),
        "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
    ], timeout=600)
    if result.returncode != 0:
        return []
    pcm = np.frombuffer(result.stdout, dtype="<i2")
    if pcm.size == 0:
        return []
    bucket = max(1, int(sample_rate / config.PEAKS_PER_SECOND))
    usable = (pcm.size // bucket) * bucket
    if usable == 0:
        return [int(min(100, abs(int(pcm.max(initial=0))) * 100 / 32768))]
    frames = pcm[:usable].reshape(-1, bucket)
    peaks = np.abs(frames).max(axis=1).astype(np.int32)
    peaks = np.clip((peaks * 100) // 32768, 0, 100)
    return [int(v) for v in peaks]


# --------------------------------------------------------------------------- 静音


_SILENCE_START = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


def detect_silences(source: Path) -> list[tuple[int, int]]:
    """返回静音区间 ``[(startMs, endMs), ...]``。"""
    exe = require_ffmpeg()
    result = _run([
        exe, "-hide_banner", "-nostats", "-i", str(source),
        "-af", f"silencedetect=noise={config.SILENCE_NOISE}:d={config.SILENCE_MIN_DURATION}",
        "-f", "null", "-",
    ], timeout=600)
    text = (result.stderr or b"").decode("utf-8", "replace")
    spans: list[tuple[int, int]] = []
    pending: float | None = None
    for line in text.splitlines():
        start = _SILENCE_START.search(line)
        if start:
            pending = max(0.0, float(start.group(1)))
            continue
        end = _SILENCE_END.search(line)
        if end and pending is not None:
            spans.append((int(pending * 1000), int(float(end.group(1)) * 1000)))
            pending = None
    if pending is not None:
        # 文件以静音结尾时没有 silence_end
        spans.append((int(pending * 1000), 24 * 3600 * 1000))
    return spans
