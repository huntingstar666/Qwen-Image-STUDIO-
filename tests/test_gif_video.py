"""视频 → GIF：探测与两遍调色板（没有 ffmpeg 时整组跳过）。"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageSequence
import io

from server import mediaops


def _make_video(path: str) -> bool:
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    cmd = [
        exe, "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
        "-pix_fmt", "yuv420p", "-y", path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except (OSError, subprocess.CalledProcessError):
        return False


def test_probe_and_gif_from_video():
    folder = tempfile.mkdtemp(prefix="q2i-gif-test-")
    path = os.path.join(folder, "sample.mp4")
    try:
        if not _make_video(path):
            import pytest

            pytest.skip("本机没有可用的 ffmpeg")

        info = mediaops.probe_video(path)
        assert info["width"] == 160 and info["height"] == 120
        assert info["duration"] > 0.5

        payload = mediaops.gif_from_video(path, start=0, end=0.6, fps=8, width=120)
        assert payload[:6] in (b"GIF87a", b"GIF89a")
        with Image.open(io.BytesIO(payload)) as im:
            frames = list(ImageSequence.Iterator(im))
        assert 3 <= len(frames) <= 8
        assert frames[0].width == 120
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_probe_missing_file_reports_error():
    try:
        mediaops.probe_video(os.path.join(tempfile.gettempdir(), "no-such-video-xyz.mp4"))
    except mediaops.MediaOpsError as exc:
        assert exc.code == "video_unreadable"
        return
    raise AssertionError("不存在的视频应当报错")
