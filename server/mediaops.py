"""水印与动图（GIF）的本地实现。

* 水印：Pillow 渲染文字/图片水印，支持九宫格、自定义坐标、描边、阴影、平铺、批量；
* GIF：图片序列走 Pillow 全局调色板；视频走 ffmpeg 两遍调色板，缺 ffmpeg 时回退 OpenCV。

不改写源图：所有输出都是新的 RGBA / GIF 字节，落盘交给 :mod:`server.storage`。
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Callable, Iterator

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageSequence

from . import imaging

ProgressFn = Callable[[int, str], None]
CancelFn = Callable[[], bool]

#: 水印批量上限
MAX_WATERMARK_BATCH = 20
#: GIF 帧数上限（图片序列）
MAX_GIF_FRAMES = 300
#: GIF 输出体积上限
MAX_GIF_BYTES = 50 * 1024 * 1024
#: 视频截取最长秒数
MAX_VIDEO_SECONDS = 60


class MediaOpsError(ValueError):
    """参数或运行错误（会作为 400 / 任务错误返回）。"""

    def __init__(self, message: str, *, code: str = "invalid_field") -> None:
        super().__init__(message)
        self.code = code


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _check_cancel(cancel: CancelFn | None) -> None:
    if cancel is not None and cancel():
        raise MediaOpsError("任务已取消", code="canceled")


# --------------------------------------------------------------------------- 字体

_FONT_DIRS = [
    os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
    "/usr/share/fonts/truetype",
    "/System/Library/Fonts",
]

_FONT_SPECS: list[tuple[str, str, str, list[str]]] = [
    ("msyh", "微软雅黑", "Microsoft YaHei", ["msyh.ttc", "msyh.ttf"]),
    ("msyhbd", "微软雅黑 粗体", "Microsoft YaHei Bold", ["msyhbd.ttc"]),
    ("simhei", "黑体", "SimHei", ["simhei.ttf"]),
    ("simsun", "宋体", "SimSun", ["simsun.ttc"]),
    ("simkai", "楷体", "KaiTi", ["simkai.ttf"]),
    ("simfang", "仿宋", "FangSong", ["simfang.ttf"]),
    ("arial", "Arial", "Arial", ["arial.ttf"]),
    ("arialbd", "Arial Bold", "Arial", ["arialbd.ttf"]),
    ("times", "Times New Roman", "Times New Roman", ["times.ttf"]),
    ("georgia", "Georgia", "Georgia", ["georgia.ttf"]),
    ("segoeui", "Segoe UI", "Segoe UI", ["segoeui.ttf"]),
    ("consola", "Consolas", "Consolas", ["consola.ttf"]),
    ("impact", "Impact", "Impact", ["impact.ttf"]),
]


def _find_font(filenames: list[str]) -> str:
    for base in _FONT_DIRS:
        if not os.path.isdir(base):
            continue
        for name in filenames:
            direct = os.path.join(base, name)
            if os.path.isfile(direct):
                return direct
            for root, _dirs, files in os.walk(base):
                if name in files:
                    return os.path.join(root, name)
    return ""


def list_fonts() -> list[dict[str, str]]:
    """返回可用字体白名单（只列本机真实存在的）。"""
    out: list[dict[str, str]] = []
    for font_id, label, family, files in _FONT_SPECS:
        path = _find_font(files)
        if path:
            out.append({"id": font_id, "label": label, "family": family, "path": path})
    return out


def resolve_font(font: str | None, size: int) -> ImageFont.FreeTypeFont:
    """按 id 加载字体；id 也可以直接是字体文件绝对路径。"""
    candidates = list_fonts()
    if font:
        for item in candidates:
            if item["id"] == font or item["path"] == font:
                return ImageFont.truetype(item["path"], size)
        if os.path.isfile(str(font)):
            return ImageFont.truetype(str(font), size)
    if candidates:
        return ImageFont.truetype(candidates[0]["path"], size)
    try:  # 最后兜底：Pillow 自带默认字体（无中文字形，但不崩）
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover - 老版本 Pillow
        return ImageFont.load_default()


# --------------------------------------------------------------------------- 颜色


def _parse_rgba(value: Any, default: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) == 4:
        text = "".join(ch * 2 for ch in text)
    if len(text) not in (6, 8):
        return default
    try:
        parts = tuple(int(text[i:i + 2], 16) for i in range(0, len(text), 2))
    except ValueError:
        return default
    return (*parts[:3], parts[3] if len(parts) == 4 else 255)  # type: ignore[return-value]


def _scale_alpha(color: tuple[int, int, int, int], opacity: float) -> tuple[int, int, int, int]:
    return (color[0], color[1], color[2], int(round(color[3] * opacity)))


# --------------------------------------------------------------------------- 水印主体


def _render_text_mark(text: str, spec: dict[str, Any], ref_side: int) -> Image.Image:
    scale = _clamp(float(spec.get("scale", 0.06)), 0.01, 0.2)
    size = max(8, int(round(ref_side * scale)))
    font = resolve_font(spec.get("font"), size)

    color = _parse_rgba(spec.get("color"), (255, 255, 255, 255))
    stroke = spec.get("stroke") or {}
    stroke_width = int(round(ref_side * _clamp(float(stroke.get("width", 0)), 0, 0.05)))
    stroke_color = _parse_rgba(stroke.get("color"), (0, 0, 0, 255))

    shadow = spec.get("shadow") or {}
    shadow_color = _parse_rgba(shadow.get("color"), (0, 0, 0, 128))
    blur = float(shadow.get("blur", 0) or 0) * ref_side
    dx = float(shadow.get("dx", 0) or 0) * ref_side
    dy = float(shadow.get("dy", 0) or 0) * ref_side

    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = measure.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    text_w = max(1, bbox[2] - bbox[0])
    text_h = max(1, bbox[3] - bbox[1])
    pad = max(2, stroke_width) + max(4, int(abs(blur) + max(abs(dx), abs(dy))))
    canvas = Image.new("RGBA", (text_w + pad * 2, text_h + pad * 2), (0, 0, 0, 0))
    origin = (pad - bbox[0], pad - bbox[1])

    capsule = spec.get("capsule") or {}
    draw = ImageDraw.Draw(canvas)
    if capsule.get("enabled"):
        cap_color = _parse_rgba(capsule.get("color"), (0, 0, 0, 140))
        radius = int(round(min(canvas.size) * 0.28))
        draw.rounded_rectangle((pad // 2, pad // 2, canvas.width - pad // 2,
                                canvas.height - pad // 2), radius=radius, fill=cap_color)
        draw = ImageDraw.Draw(canvas)

    if blur > 0 or dx or dy:
        shadow_layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow_layer).text(
            (origin[0] + dx, origin[1] + dy), text, font=font, fill=shadow_color,
            stroke_width=stroke_width, stroke_fill=shadow_color,
        )
        if blur > 0:
            shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(blur))
        canvas.alpha_composite(shadow_layer)

    draw.text(origin, text, font=font, fill=color,
              stroke_width=stroke_width, stroke_fill=stroke_color)
    return canvas


def _render_image_mark(mark: bytes, spec: dict[str, Any], ref_width: int) -> Image.Image:
    im = imaging.decode_image(mark, keep_alpha=True)
    scale = _clamp(float(spec.get("scale", 0.18)), 0.02, 0.6)
    target_w = max(1, int(round(ref_width * scale)))
    target_h = max(1, int(round(im.height * target_w / im.width)))
    return im.resize((target_w, target_h), Image.LANCZOS)


def _anchor(position: str, canvas_size: tuple[int, int], mark_size: tuple[int, int],
            margin_px: int, x: float, y: float) -> tuple[int, int]:
    width, height = canvas_size
    mark_w, mark_h = mark_size
    left, center_x, right = margin_px, (width - mark_w) // 2, width - mark_w - margin_px
    top, center_y, bottom = margin_px, (height - mark_h) // 2, height - mark_h - margin_px
    table = {
        "top-left": (left, top), "top": (center_x, top), "top-right": (right, top),
        "left": (left, center_y), "center": (center_x, center_y), "right": (right, center_y),
        "bottom-left": (left, bottom), "bottom": (center_x, bottom),
        "bottom-right": (right, bottom),
    }
    if position == "custom":
        return (int(round(x * width - mark_w / 2)), int(round(y * height - mark_h / 2)))
    return table.get(position, table["bottom-right"])


def _tile_layer(canvas_size: tuple[int, int], mark: Image.Image, tile: dict[str, Any],
                ref_side: int) -> Image.Image:
    width, height = canvas_size
    angle = float(tile.get("angle", -24) or 0)
    rotated = mark.rotate(angle, expand=True, resample=Image.BICUBIC) if angle else mark
    gap_x = _clamp(float(tile.get("gap_x", 0.20)), 0.02, 2.0)
    gap_y = _clamp(float(tile.get("gap_y", 0.12)), 0.02, 2.0)
    step_x = max(int(rotated.width * 0.35), int(gap_x * ref_side))
    step_y = max(int(rotated.height * 0.35), int(gap_y * ref_side))
    layer = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    for y in range(-rotated.height, height + rotated.height, max(1, step_y)):
        for x in range(-rotated.width, width + rotated.width, max(1, step_x)):
            layer.paste(rotated, (x, y), rotated)
    return layer


def apply_watermark(data: bytes, spec: dict[str, Any], *, mark_data: bytes | None = None
                    ) -> Image.Image:
    """在图片上叠加水印，返回 RGBA 图（不落盘）。"""
    image = imaging.decode_image(data, keep_alpha=True)
    width, height = image.size
    ref_side = min(width, height)
    opacity = _clamp(float(spec.get("opacity", 0.55)), 0.0, 1.0)
    if opacity <= 0:
        return image

    text = str(spec.get("text") or "")
    mark_spec = spec.get("image_mark") or {}
    if text.strip():
        mark = _render_text_mark(text, spec, ref_side)
    elif mark_data:
        mark = _render_image_mark(mark_data, mark_spec, width)
        opacity *= _clamp(float(mark_spec.get("opacity", 1.0)), 0.0, 1.0)
    else:
        raise MediaOpsError("水印内容不能为空（text 或 image_mark 至少一个）")

    rotation = float(spec.get("rotation", 0) or 0)
    if rotation:
        mark = mark.rotate(rotation, expand=True, resample=Image.BICUBIC)

    if opacity < 0.999:
        alpha = mark.getchannel("A").point(lambda value: int(round(value * opacity)))
        mark.putalpha(alpha)

    tile = spec.get("tile") or {}
    if tile.get("enabled"):
        layer = _tile_layer((width, height), mark, tile, ref_side)
    else:
        margin = int(round(ref_side * _clamp(float(spec.get("margin", 0.03)), 0, 0.2)))
        position = str(spec.get("position") or "bottom-right")
        x = _clamp(float(spec.get("x", 0.5)), 0.0, 1.0)
        y = _clamp(float(spec.get("y", 0.5)), 0.0, 1.0)
        px, py = _anchor(position, (width, height), mark.size, margin, x, y)
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer.paste(mark, (px, py), mark)

    out = image.copy()
    out.alpha_composite(layer)
    return out


def preview(data: bytes, spec: dict[str, Any], *, mark_data: bytes | None = None,
            max_side: int = 960) -> tuple[bytes, int, int]:
    """服务端精确预览：返回 (PNG 字节, 宽, 高)。"""
    image = apply_watermark(data, spec, mark_data=mark_data)
    image.thumbnail((max_side, max_side), Image.LANCZOS)
    return imaging.encode_png(image), image.width, image.height


# --------------------------------------------------------------------------- GIF：图片序列


def _fit_frame(frame: Image.Image, width: int) -> Image.Image:
    frame = frame.convert("RGB")
    if width and frame.width != width:
        height = max(1, int(round(frame.height * width / frame.width)))
        frame = frame.resize((width, height), Image.LANCZOS)
    return frame


def _global_palette(frames: list[Image.Image]) -> Image.Image:
    """把缩略图拼成一张接触表，量化出全局调色板，避免逐帧跳色。"""
    cell = 64
    columns = min(8, max(1, len(frames)))
    rows = (len(frames) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell, rows * cell), (255, 255, 255))
    for index, frame in enumerate(frames):
        thumb = frame.copy()
        thumb.thumbnail((cell, cell), Image.LANCZOS)
        x = (index % columns) * cell + (cell - thumb.width) // 2
        y = (index // columns) * cell + (cell - thumb.height) // 2
        sheet.paste(thumb, (x, y))
    return sheet.quantize(colors=256, method=Image.Quantize.MEDIANCUT)


def _arrange_frames(frames: list[Image.Image], durations: list[int], mode: str
                    ) -> tuple[list[Image.Image], list[int]]:
    if mode == "reverse":
        return list(reversed(frames)), list(reversed(durations))
    if mode == "boomerang":
        if len(frames) < 2:
            return frames, durations
        return (frames + list(reversed(frames[1:-1]))), (durations + list(reversed(durations[1:-1])))
    return frames, durations


def gif_from_images(frames_data: list[bytes], *, duration: int = 100,
                    durations: list[int] | None = None, width: int = 0,
                    mode: str = "forward", loop: int = 0,
                    progress: ProgressFn | None = None,
                    cancel: CancelFn | None = None) -> bytes:
    """图片序列 → GIF（全局调色板 + 抖动）。"""
    if not frames_data:
        raise MediaOpsError("至少需要 1 帧", code="missing_field")
    if len(frames_data) > MAX_GIF_FRAMES:
        raise MediaOpsError(f"帧数过多（最多 {MAX_GIF_FRAMES}）", code="too_many_frames")
    base_duration = max(20, int(duration))
    custom = [max(20, int(value)) for value in (durations or [])]

    frames: list[Image.Image] = []
    for index, raw in enumerate(frames_data):
        _check_cancel(cancel)
        frames.append(_fit_frame(imaging.decode_image(raw, keep_alpha=False), int(width)))
        if progress:
            progress(int((index + 1) / len(frames_data) * 60), f"解码帧 {index + 1}/{len(frames_data)}")

    if width <= 0:
        width = frames[0].width
    # 统一到同一宽度后，高度取最大帧，短帧居中补白，避免 GIF 尺寸跳变
    target_h = max(frame.height for frame in frames)
    if target_h > 1600:
        scale = 1600 / max(width, target_h)
        width = max(1, int(round(width * scale)))
        target_h = max(1, int(round(target_h * scale)))
        frames = [_fit_frame(frame, width) for frame in frames]
    aligned: list[Image.Image] = []
    for frame in frames:
        if frame.size == (width, target_h):
            aligned.append(frame)
            continue
        canvas = Image.new("RGB", (width, target_h), (255, 255, 255))
        canvas.paste(frame, ((width - frame.width) // 2, (target_h - frame.height) // 2))
        aligned.append(canvas)
    frames = aligned

    frame_durations = [custom[i] if i < len(custom) else base_duration for i in range(len(frames))]
    frames, frame_durations = _arrange_frames(frames, frame_durations, mode)
    _check_cancel(cancel)
    if progress:
        progress(68, "构建全局调色板")

    palette = _global_palette(frames)
    converted: list[Image.Image] = []
    for index, frame in enumerate(frames):
        _check_cancel(cancel)
        converted.append(frame.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG))
        if progress and index % 5 == 0:
            progress(70 + int(index / max(1, len(frames)) * 20), f"量化帧 {index + 1}/{len(frames)}")

    buf = io.BytesIO()
    converted[0].save(
        buf, format="GIF", save_all=True, append_images=converted[1:],
        duration=frame_durations, loop=max(0, int(loop)), disposal=2, optimize=True,
    )
    payload = buf.getvalue()
    if len(payload) > MAX_GIF_BYTES:
        raise MediaOpsError(
            f"GIF 超过 {MAX_GIF_BYTES // 1024 // 1024}MB，请降低宽度/帧率或减少帧数",
            code="gif_too_large",
        )
    if progress:
        progress(95, "写入 GIF")
    return payload


def split_gif(data: bytes, *, max_frames: int = 60) -> list[tuple[bytes, int]]:
    """拆 GIF 帧：返回 [(PNG 字节, duration_ms), ...]。"""
    items: list[tuple[bytes, int]] = []
    with Image.open(io.BytesIO(data)) as im:
        for index, frame in enumerate(ImageSequence.Iterator(im)):
            if index >= max_frames:
                break
            rgba = frame.convert("RGBA")
            items.append((imaging.encode_png(rgba), int(frame.info.get("duration") or 100)))
    return items


# --------------------------------------------------------------------------- GIF：视频


def ffmpeg_path() -> str:
    return shutil.which("ffmpeg") or ""


def ffprobe_path() -> str:
    probe = shutil.which("ffprobe")
    if probe:
        return probe
    exe = ffmpeg_path()
    if exe:
        candidate = os.path.join(os.path.dirname(exe), "ffprobe.exe" if os.name == "nt" else "ffprobe")
        if os.path.isfile(candidate):
            return candidate
    return ""


def probe_video(path: str) -> dict[str, Any]:
    """用 ffprobe 读取时长/分辨率/fps/码率；没有 ffprobe 时回退 OpenCV。"""
    probe = ffprobe_path()
    if probe:
        cmd = [probe, "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", path]
        try:
            raw = subprocess.run(cmd, capture_output=True, check=True).stdout.decode("utf-8", "replace")
            data = json.loads(raw)
            stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
            fmt = data.get("format") or {}
            fps_text = str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1")
            try:
                num, den = fps_text.split("/")
                fps = float(num) / float(den) if float(den) else 0.0
            except (ValueError, ZeroDivisionError):
                fps = 0.0
            return {
                "duration": float(fmt.get("duration") or stream.get("duration") or 0),
                "width": int(stream.get("width") or 0),
                "height": int(stream.get("height") or 0),
                "fps": round(fps, 3),
                "bitrate": int(float(fmt.get("bit_rate") or 0)),
                "codec": str(stream.get("codec_name") or ""),
                "has_audio": any(s.get("codec_type") == "audio" for s in data.get("streams", [])),
                "source": "ffprobe",
            }
        except (subprocess.CalledProcessError, OSError, json.JSONDecodeError, ValueError):
            pass
    try:  # OpenCV 回退
        import cv2  # noqa: PLC0415

        capture = cv2.VideoCapture(path)
        if not capture.isOpened():
            raise MediaOpsError("无法读取视频文件", code="video_unreadable")
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
        count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        info = {
            "duration": round(count / fps, 3) if fps else 0.0,
            "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
            "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
            "fps": round(fps, 3),
            "bitrate": 0,
            "codec": "",
            "has_audio": False,
            "source": "opencv",
        }
        capture.release()
        return info
    except MediaOpsError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise MediaOpsError(f"无法探测视频：{exc}", code="video_unreadable") from exc


def _run_ffmpeg(cmd: list[str], *, progress: ProgressFn | None, cancel: CancelFn | None,
                start_ratio: int, end_ratio: int) -> None:
    process = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        assert process.stdout is not None
        for line in process.stdout:
            if cancel is not None and cancel():
                process.kill()
                raise MediaOpsError("任务已取消", code="canceled")
            line = line.strip()
            if line.startswith("out_time_ms=") and progress:
                try:
                    ms = int(line.split("=", 1)[1])
                except ValueError:
                    continue
                ratio = _clamp(ms / 1_000_000, 0.0, 1.0)
                progress(int(start_ratio + (end_ratio - start_ratio) * ratio), "转码中")
        code = process.wait()
    finally:
        if process.poll() is None:
            process.kill()
        if process.stdout:
            process.stdout.close()
    if code != 0:
        raise MediaOpsError("ffmpeg 转码失败", code="ffmpeg_failed")


def _gif_payload(path: str) -> bytes:
    with open(path, "rb") as fh:
        payload = fh.read()
    if len(payload) > MAX_GIF_BYTES:
        raise MediaOpsError(
            f"GIF 超过 {MAX_GIF_BYTES // 1024 // 1024}MB，请降低宽度/帧率或缩短片段",
            code="gif_too_large",
        )
    return payload


def gif_from_video_opencv(path: str, *, start: float, end: float, fps: float,
                          width: int, progress: ProgressFn | None = None,
                          cancel: CancelFn | None = None) -> bytes:
    """ffmpeg 缺失时的降级路径：OpenCV 抽帧 + Pillow 序列编码。"""
    import cv2  # noqa: PLC0415

    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise MediaOpsError("无法读取视频文件", code="video_unreadable")
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 25)
    step = max(1.0, source_fps / max(1.0, fps))
    frames_data: list[bytes] = []
    index = 0
    next_at = start * source_fps
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        timestamp = index / source_fps
        index += 1
        if timestamp < start:
            continue
        if timestamp > end:
            break
        if index < next_at:
            continue
        next_at += step
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frames_data.append(imaging.encode_png(Image.fromarray(rgb)))
        if len(frames_data) > MAX_GIF_FRAMES:
            break
        if progress:
            progress(30 + int(_clamp(timestamp / max(0.001, end - start), 0, 1) * 55), "抽帧中")
        if cancel is not None and cancel():
            capture.release()
            raise MediaOpsError("任务已取消", code="canceled")
    capture.release()
    if not frames_data:
        raise MediaOpsError("选中的片段没有可用帧", code="empty_segment")
    return gif_from_images(
        frames_data, duration=max(20, int(round(1000 / max(1.0, fps)))),
        width=width, progress=progress, cancel=cancel,
    )


def gif_from_video(path: str, *, start: float = 0.0, end: float = 0.0,
                   fps: float = 12, width: int = 720, fit: str = "contain",
                   mode: str = "forward",
                   progress: ProgressFn | None = None,
                   cancel: CancelFn | None = None) -> bytes:
    """视频 → GIF：ffmpeg 两遍调色板，进度映射到 5%~95%。"""
    length = max(0.0, end - start)
    if length <= 0:
        info = probe_video(path)
        length = float(info.get("duration") or 0) - start
    if length <= 0:
        raise MediaOpsError("片段时长为 0", code="empty_segment")
    if length > MAX_VIDEO_SECONDS:
        raise MediaOpsError(f"视频片段最长 {MAX_VIDEO_SECONDS} 秒", code="segment_too_long")
    fps = _clamp(float(fps), 5, 30)
    width = int(_clamp(int(width), 64, 1600))
    if mode in ("reverse", "boomerang") and length > 15:
        raise MediaOpsError("倒放/往返仅支持 15 秒以内的片段", code="segment_too_long")

    exe = ffmpeg_path()
    if not exe:
        return gif_from_video_opencv(path, start=start, end=end, fps=fps, width=width,
                                     progress=progress, cancel=cancel)

    # 等比缩放到目标宽度；fit=cover 的裁切由前端先裁好再传，避免滤镜里未知高度
    scale = f"scale={width}:-1:flags=lanczos"
    temp_dir = tempfile.mkdtemp(prefix="q2i-gif-")
    palette_file = os.path.join(temp_dir, "palette.png")
    gif_file = os.path.join(temp_dir, "out.gif")
    try:
        _check_cancel(cancel)
        pass_one = [
            exe, "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", path,
            "-vf", f"fps={fps},{scale},palettegen=stats_mode=diff",
            "-y", palette_file,
        ]
        _run_ffmpeg(pass_one, progress=progress, cancel=cancel, start_ratio=5, end_ratio=30)
        if progress:
            progress(35, "生成调色板")
        pass_two = [
            exe, "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", path, "-i", palette_file,
            "-lavfi", f"fps={fps},{scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
            "-loop", "0", "-y", gif_file,
        ]
        _run_ffmpeg(pass_two, progress=progress, cancel=cancel, start_ratio=40, end_ratio=90)
        payload = _gif_payload(gif_file)
        if mode in ("reverse", "boomerang"):
            if progress:
                progress(92, "倒放/往返")
            with Image.open(io.BytesIO(payload)) as im:
                frames = [(frame.convert("RGBA").copy(), int(frame.info.get("duration") or 100))
                          for frame in ImageSequence.Iterator(im)]
            order = list(reversed(frames)) if mode == "reverse" else (
                frames + list(reversed(frames[1:-1])))
            payload = gif_from_images(
                [imaging.encode_png(frame) for frame, _d in order],
                durations=[duration for _f, duration in order],
                progress=None, cancel=cancel,
            )
        if progress:
            progress(95, "写入 GIF")
        return payload
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
