"""GIF：图片序列、全局调色板、往返/倒放、拆帧（纯 CPU）。"""
from __future__ import annotations

import io

from PIL import Image, ImageSequence

from server import mediaops


def _solid(color: tuple[int, int, int], w: int = 100, h: int = 80) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def _frames() -> list[bytes]:
    return [_solid((255, 0, 0)), _solid((0, 255, 0)), _solid((0, 0, 255))]


def _decode(payload: bytes):
    im = Image.open(io.BytesIO(payload))
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(im):
        frames.append(frame.convert("RGB").copy())
        durations.append(int(frame.info.get("duration") or 0))
    return im, frames, durations


def test_gif_frame_count_duration_loop():
    payload = mediaops.gif_from_images(_frames(), duration=120, width=50)
    im, frames, durations = _decode(payload)
    assert payload[:6] in (b"GIF87a", b"GIF89a")
    assert len(frames) == 3
    assert im.info.get("loop") == 0
    assert all(d == 120 for d in durations)
    assert frames[0].width == 50


def test_gif_reverse_order():
    payload = mediaops.gif_from_images(_frames(), duration=100, mode="reverse")
    _im, frames, _durations = _decode(payload)
    colors = [frame.getpixel((frame.width // 2, frame.height // 2)) for frame in frames]
    assert colors[0][2] > 150 and colors[0][0] < 100, colors
    assert colors[-1][0] > 150 and colors[-1][2] < 100, colors


def test_gif_boomerang_frame_count():
    payload = mediaops.gif_from_images(_frames(), duration=100, mode="boomerang")
    _im, frames, _durations = _decode(payload)
    assert len(frames) == 4


def test_gif_custom_durations():
    payload = mediaops.gif_from_images(_frames(), durations=[50, 200, 350])
    _im, decoded, durations = _decode(payload)
    assert durations == [50, 200, 350]


def test_split_gif_roundtrip():
    payload = mediaops.gif_from_images(_frames(), duration=90)
    items = mediaops.split_gif(payload)
    assert len(items) == 3
    assert all(png.startswith(b"\x89PNG") for png, _d in items)
    assert all(duration == 90 for _png_bytes, duration in items)


def test_too_many_frames_rejected():
    try:
        mediaops.gif_from_images([_solid((0, 0, 0), 4, 4)] * (mediaops.MAX_GIF_FRAMES + 1))
    except mediaops.MediaOpsError as exc:
        assert exc.code == "too_many_frames"
        return
    raise AssertionError("超过帧数上限应当报错")
