"""成片渲染：分段 → 拼接/转场 → 字幕水印 → 混音 → 封装。

设计要点（见 docs/PLAN_VIDEO_WORKBENCH.md 5.4）：

* 分段渲染，绝不一次性把 N 路视频塞进同一条 ``filter_complex``；
* 每段比台词时长多渲染「下一段转场时长」的尾巴，xfade 重叠后总时长仍然精确等于音轨；
* 原声始终是一条连续轨，画面按帧切，音画不会累积偏移；
* 转场只在相邻两段之间增量合并，硬切直接 ``concat -c copy``。
"""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw, ImageFont

from . import media, store, subtitle
from .errors import CanceledError, RenderError, StudioError
from .images import canvas_size

ProgressFn = Callable[[int, str], None]
CancelFn = Callable[[], bool]

#: 分段渲染与中间文件的统一编码参数（concat -c copy 要求完全一致）
VIDEO_CODEC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high"]

#: x264 默认每 250 帧插一个 I 帧；I 帧的亮度/细节与前后 P 帧对不上，
#: 慢速运镜时每 8 秒左右就会出现一次「画面跳一下」。实测恒定 QP 也消不掉，
#: 只有不在镜头中间插 I 帧才干净。这里把周期拉长到约等于无穷，
#: 关键帧改由切点/转场起点显式指定（见 ``_shot_boundaries``）。
X264_PARAMS = "ipratio=1.0:pbratio=1.0:scenecut=0:keyint=100000:min-keyint=1"


def _check_cancel(cancel: CancelFn | None) -> None:
    if cancel is not None and cancel():
        raise CanceledError()


def _progress(progress: ProgressFn | None, value: int, label: str) -> None:
    if progress is not None:
        progress(max(0, min(100, int(value))), label)


def _run(cmd: list[str], *, cwd: Path | None = None, timeout: float = 1800.0,
         cancel: CancelFn | None = None) -> subprocess.CompletedProcess:
    _check_cancel(cancel)
    result = subprocess.run(
        cmd, cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or b"").decode("utf-8", "replace")[-800:]
        raise RenderError(f"ffmpeg 执行失败：{detail}")
    return result


def _exe() -> str:
    return media.require_ffmpeg()


def _export_args(render: dict[str, Any], keyframes: list[float] | None = None) -> list[str]:
    export = render.get("export") or {}
    crf = int(export.get("crf") or 18)
    preset = str(export.get("preset") or "medium")
    args = [*VIDEO_CODEC, "-crf", str(crf), "-preset", preset,
            "-x264-params", X264_PARAMS, "-movflags", "+faststart"]
    if keyframes:
        args += ["-force_key_frames", ",".join(f"{t:.4f}" for t in keyframes)]
    return args


def _shot_boundaries(plan: dict[str, Any]) -> list[float]:
    """I 帧的落点（秒）。

    I 帧的画面细节和前后 P 帧对不上，落在静止画面上会「闪一下」。
    所以硬切放在切点，淡入淡出放在两段混合最激烈的转场中点，让人看不出来。
    """
    times = []
    for item in plan["items"][1:]:
        cut, fade = item["cutFrame"], item["fadeStartFrame"]
        frame = cut if fade >= cut else (cut + fade) // 2
        times.append(frame / plan["fps"])
    return times


# --------------------------------------------------------------------------- 时间轴


def timeline(project: dict[str, Any]) -> dict[str, Any]:
    """整理渲染用的时间轴：每段帧数、转场时长、总帧数。"""
    shots = project.get("shots") or []
    if not shots:
        raise StudioError("还没有镜头段，无法导出", code="no_shots")
    missing = [shot.get("id") for shot in shots if not str(shot.get("image") or "").strip()]
    if missing:
        raise StudioError(
            f"还有 {len(missing)} 个镜头没有图片（{', '.join(str(x) for x in missing[:5])}…），"
            "先批量生图或手动指定图片",
            code="image_missing")
    fps = max(12, min(60, int((project.get("canvas") or {}).get("fps") or 30)))
    frame_ms = 1000.0 / fps
    width, height = canvas_size(project)

    # 先把每段的帧数与转场帧数全部取整：xfade 的 offset/duration 必须是整数帧，
    # 否则每次转场都会悄悄少 1 帧，几段下来就音画不同步了。
    frames_list = [
        max(1, int(round((int(shot["endMs"]) - int(shot["startMs"])) / frame_ms)))
        for shot in shots
    ]
    transition_frames: list[int] = []
    for index, shot in enumerate(shots):
        incoming = shot.get("transition") or {}
        kind = str(incoming.get("type") or "cut")
        count = 0
        if index > 0 and kind != "cut":
            count = int(round(int(incoming.get("durationMs") or 0) / frame_ms))
            count = max(0, min(count, frames_list[index] // 2))
        transition_frames.append(count)

    planned = []
    for index, shot in enumerate(shots):
        frames = frames_list[index]
        d_in_frames = transition_frames[index]
        d_out_frames = transition_frames[index + 1] if index + 1 < len(shots) else 0
        kind_in = str((shot.get("transition") or {}).get("type") or "cut")
        kind_out = ("cut" if index + 1 >= len(shots)
                    else str((shots[index + 1].get("transition") or {}).get("type") or "cut"))
        # 转场以切点为中心：两段各让出半个转场；余数补到后半个，
        # 保证「前半个 + 后半个 = 整数个转场」，总时长不被取整吃掉。
        head = d_in_frames - d_in_frames // 2
        tail = d_out_frames // 2
        planned.append({
            "shot": shot,
            "frames": frames,
            "headFrames": head,
            "tailFrames": tail,
            "renderFrames": frames + head + tail,
            # 用「整帧时长」回写，拼接时 xfade 的 duration 与 overlap 才能严格对上
            "transitionOut": {"type": kind_out, "durationMs": d_out_frames * frame_ms},
            "kindIn": kind_in,
        })
    total_frames = 0
    for index, item in enumerate(planned):
        d_in_frames = transition_frames[index]
        # 成片里的起点，以及入转场的起点（I 帧落点用）
        item["cutFrame"] = total_frames
        item["fadeStartFrame"] = max(0, total_frames - d_in_frames)
        total_frames += item["frames"]
    return {
        "items": planned,
        "fps": fps,
        "width": width,
        "height": height,
        "totalFrames": total_frames,
        "durationMs": int(round(total_frames * frame_ms)),
    }


# --------------------------------------------------------------------------- 分段渲染


#: 运动段的工作分辨率倍数：先把静帧放大到输出的 2 倍再逐帧仿射，
#: 输出时是「降采样」而不是「放大」，边缘更干净。
MOTION_BASE_SCALE = 2


def _motion_state(kind: str, zoom_to: float, progress: float,
                  base_w: int, base_h: int) -> tuple[float, float, float]:
    """返回 (zoom, 左上角 x, 左上角 y)，坐标在工作分辨率下。

    所有量都是浮点，交给重采样器做亚像素插值，不做整数取整。
    """
    zoom_to = max(1.001, min(1.3, float(zoom_to)))
    p = max(0.0, min(1.0, float(progress)))
    if kind == "push":
        zoom = 1 + (zoom_to - 1) * p
        x = y = None
    elif kind == "pull":
        zoom = zoom_to - (zoom_to - 1) * p
        x = y = None
    elif kind == "diag":
        zoom = 1 + (zoom_to - 1) * p
        x = (base_w - base_w / zoom) * (1 - p)
        y = (base_h - base_h / zoom) * p
        return zoom, x, y
    else:
        zoom = zoom_to
        x = y = None

    if kind in ("left", "right"):
        x = (base_w - base_w / zoom) * (1 - p if kind == "left" else p)
    if kind in ("up", "down"):
        y = (base_h - base_h / zoom) * (1 - p if kind == "up" else p)
    if x is None:
        x = (base_w - base_w / zoom) / 2
    if y is None:
        y = (base_h - base_h / zoom) / 2
    return zoom, x, y


def _encode_frames(target: Path, plan: dict[str, Any], render, *, frames: int,
                   export: list[str], cancel: CancelFn | None = None,
                   on_frame: Callable[[int], None] | None = None) -> None:
    """把逐帧生成器编码成 MP4：rawvideo 走管道，不落中间图片。"""
    width, height, fps = plan["width"], plan["height"], plan["fps"]
    log = target.with_suffix(".log")
    with open(log, "wb") as err:
        process = subprocess.Popen(
            [_exe(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
             *export, "-an", str(target)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err,
        )
        try:
            for index in range(frames):
                if cancel is not None and index % 6 == 0 and cancel():
                    raise CanceledError()
                process.stdin.write(render(index).tobytes())
                if on_frame is not None:
                    on_frame(index + 1)
            process.stdin.close()
        except BaseException:
            try:
                process.kill()
            except OSError:
                pass
            process.wait()
            raise
    code = process.wait()
    if code != 0:
        detail = log.read_text(encoding="utf-8", errors="replace")[-600:]
        log.unlink(missing_ok=True)
        raise RenderError(f"运动段编码失败：{detail}")
    log.unlink(missing_ok=True)


def _render_motion_segment(project: dict[str, Any], item: dict[str, Any], plan: dict[str, Any],
                           source: Path, target: Path, *, cancel: CancelFn | None = None,
                           on_frame: Callable[[int], None] | None = None) -> None:
    """用亚像素仿射逐帧渲染运动镜头。

    不用 ``zoompan``：它的裁剪坐标是整数像素，慢推时每帧只挪不到一个像素，
    取整会让画面在相邻像素间来回跳。这里坐标全程浮点，由重采样器插值，
    推、拉、横移、纵摇都不会有台阶。
    """
    from PIL import Image, ImageOps

    width, height = plan["width"], plan["height"]
    frames = max(2, int(item["renderFrames"]))
    motion = item["shot"].get("motion") or {}
    kind = str(motion.get("type") or "none")
    zoom_to = float(motion.get("zoom") or 1.06)
    base_w, base_h = width * MOTION_BASE_SCALE, height * MOTION_BASE_SCALE

    image = Image.open(source).convert("RGB")
    image = ImageOps.fit(image, (base_w, base_h), method=Image.LANCZOS, centering=(0.5, 0.5))

    try:  # OpenCV 走 float 仿射 + Lanczos4，稳定且快
        import cv2
        import numpy as np

        base_array = np.asarray(image, dtype=np.uint8)

        def render(index: int):
            zoom, x, y = _motion_state(kind, zoom_to, index / (frames - 1), base_w, base_h)
            matrix = np.array([[base_w / zoom / width, 0, x],
                               [0, base_h / zoom / height, y]], dtype=np.float32)
            return cv2.warpAffine(base_array, matrix, (width, height),
                                  # 我们给的是 目标→源 的矩阵，必须显式声明，
                                  # 否则 OpenCV 会再求一次逆，画面被多放大一倍
                                  flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP,
                                  borderMode=cv2.BORDER_REPLICATE)
    except ImportError:  # 兜底：PIL 双三次
        def render(index: int):
            zoom, x, y = _motion_state(kind, zoom_to, index / (frames - 1), base_w, base_h)
            return image.transform(
                (width, height), Image.AFFINE,
                (base_w / zoom / width, 0, x, 0, base_h / zoom / height, y),
                resample=Image.BICUBIC)

    scenario = {**plan, "render": project.get("render") or {}}
    _encode_frames(target, scenario, render, frames=frames,
                   export=_export_args(project.get("render") or {}),
                   cancel=cancel, on_frame=on_frame)


def _static_filter(plan: dict[str, Any]) -> str:
    width, height = plan["width"], plan["height"]
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )


def _render_segments(project: dict[str, Any], plan: dict[str, Any], tmp: Path, *,
                     progress: ProgressFn | None, cancel: CancelFn | None) -> list[Path]:
    exe = _exe()
    fps = plan["fps"]
    export = _export_args(project.get("render") or {})
    files: list[Path] = []
    total = len(plan["items"])
    for index, item in enumerate(plan["items"]):
        _check_cancel(cancel)
        shot = item["shot"]
        source = store.read_media(project["id"], str(shot["image"]))
        target = tmp / f"seg_{index:04d}.mp4"
        motion = str((shot.get("motion") or {}).get("type") or "none")
        base = 5 + index * 45 / max(1, total)
        span = 45 / max(1, total)
        frames = max(2, item["renderFrames"])
        if motion != "none":
            _render_motion_segment(
                project, item, plan, source, target, cancel=cancel,
                on_frame=lambda done, _index=index, _frames=frames, _base=base, _span=span: _progress(
                    progress, int(_base + _span * done / _frames),
                    f"渲染分段 {_index + 1}/{total}（{done}/{_frames} 帧）"),
            )
        else:
            vf = _static_filter(plan) + ",format=yuv420p"
            cmd = [exe, "-y", "-v", "error", "-loop", "1", "-framerate", str(fps),
                   "-i", str(source), "-vf", vf,
                   "-frames:v", str(frames), *export, "-an", str(target)]
            _run(cmd, timeout=900, cancel=cancel)
        files.append(target)
        _progress(progress, int(base + span), f"渲染分段 {index + 1}/{total}")
    return files


# --------------------------------------------------------------------------- 拼接


def _probe_frames(path: Path) -> int:
    """读视频帧数（mp4 的 nb_frames；读不到就返回 0 表示跳过校准）。"""
    try:
        result = subprocess.run(
            [media.require_ffprobe(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=nb_frames", "-of", "default=nw=1:nk=1", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
        return int((result.stdout or b"").decode("utf-8", "replace").strip() or 0)
    except (ValueError, OSError, subprocess.SubprocessError):
        return 0


def _normalize_frames(project: dict[str, Any], video: Path, tmp: Path, plan: dict[str, Any], *,
                      progress: ProgressFn | None, cancel: CancelFn | None) -> Path:
    """把拼接结果校准到精确帧数。

    xfade 在每条边界的取整方式不受我们控制，3 段以上会累计少一两帧；
    这里以「台词总帧数」为唯一标准，多了裁掉、少了克隆末帧补齐，音画严格对齐。
    """
    target = int(plan["totalFrames"])
    actual = _probe_frames(video)
    if not actual or actual == target:
        return video
    _check_cancel(cancel)
    target_out = tmp / "length.mp4"
    vf = "null"
    if actual < target:
        pad = (target - actual) / plan["fps"] + 0.2
        vf = f"tpad=stop_mode=clone:stop_duration={pad:.3f}"
    _run([_exe(), "-y", "-v", "error", "-i", str(video), "-vf", vf,
          "-frames:v", str(target), *_export_args(project.get("render") or {},
                                                  _shot_boundaries(plan)),
          "-an", str(target_out)], timeout=1800, cancel=cancel)
    _progress(progress, 70, f"校准时长 {actual}→{target} 帧")
    return target_out


def _concat_copy(files: list[Path], target: Path, tmp: Path, *, cancel: CancelFn | None) -> None:
    listing = tmp / "concat.txt"
    listing.write_text(
        "\n".join(f"file '{path.name}'" for path in files) + "\n", encoding="utf-8")
    _run([_exe(), "-y", "-v", "error", "-f", "concat", "-safe", "0",
          "-i", listing.name, "-c", "copy", target.name], cwd=tmp, timeout=1800, cancel=cancel)


def _merge(project: dict[str, Any], plan: dict[str, Any], files: list[Path], tmp: Path, *,
           progress: ProgressFn | None, cancel: CancelFn | None) -> Path:
    items = plan["items"]
    if len(files) == 1:
        return files[0]
    exe = _exe()
    export = _export_args(project.get("render") or {}, _shot_boundaries(plan))
    accumulated = files[0]
    accumulated_frames = int(items[0]["renderFrames"])
    for index in range(1, len(files)):
        _check_cancel(cancel)
        transition = items[index - 1]["transitionOut"]
        duration_ms = float(transition.get("durationMs") or 0.0)
        kind = str(transition.get("type") or "cut")
        target = tmp / f"acc_{index:04d}.mp4"
        if kind == "cut" or duration_ms <= 0:
            _concat_copy([accumulated, files[index]], target, tmp, cancel=cancel)
            accumulated_frames += int(items[index]["renderFrames"])
        else:
            duration_s = duration_ms / 1000.0
            overlap_frames = int(round(duration_ms * plan["fps"] / 1000.0))
            offset_s = max(0.0, (accumulated_frames - overlap_frames) / plan["fps"])
            xfade_kind = "fadeblack" if kind == "fadeblack" else "fade"
            _run([
                exe, "-y", "-v", "error",
                "-i", str(accumulated), "-i", str(files[index]),
                "-filter_complex",
                f"[0:v][1:v]xfade=transition={xfade_kind}:"
                f"duration={duration_s:.3f}:offset={offset_s:.3f},format=yuv420p",
                *export, "-an", str(target),
            ], timeout=1800, cancel=cancel)
            accumulated_frames += int(items[index]["renderFrames"]) - overlap_frames
        accumulated = target
        _progress(progress, 52 + int(index * 16 / max(1, len(files) - 1)), "拼接镜头")
    return accumulated


# --------------------------------------------------------------------------- 水印


def _font(size: int) -> ImageFont.FreeTypeFont:
    path = subtitle.font_path("msyhbd")
    if path:
        return ImageFont.truetype(path, size)
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # pragma: no cover
        return ImageFont.load_default()


def build_watermark(project: dict[str, Any], size: tuple[int, int], target: Path) -> bool:
    spec = (project.get("render") or {}).get("watermark") or {}
    text = str(spec.get("text") or "").strip()
    if not bool(spec.get("enabled")) or not text:
        return False
    width, height = size
    font_size = max(10, int(round(float(spec.get("scale") or 0.035) * width)))
    font = _font(font_size)
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    color = _rgba(str(spec.get("color") or "#FFFFFF"), float(spec.get("opacity") or 0.7))
    draw = ImageDraw.Draw(layer)
    margin = max(8, int(width * 0.03))

    def position_of() -> tuple[int, int]:
        box = draw.textbbox((0, 0), text, font=font)
        text_w, text_h = box[2] - box[0], box[3] - box[1]
        spot = str(spec.get("position") or "bottom-right")
        vertical, _, horizontal = spot.partition("-")
        x = {"left": margin, "center": (width - text_w) // 2,
             "right": width - text_w - margin}.get(horizontal, width - text_w - margin)
        y = {"top": margin, "middle": (height - text_h) // 2,
             "bottom": height - text_h - margin}.get(vertical, height - text_h - margin)
        return int(x), int(y)

    if bool(spec.get("tile")):
        step_x = max(80, font_size * (len(text) + 2))
        step_y = max(60, font_size * 3)
        for y in range(0, height, step_y):
            for x in range(0, width, step_x):
                draw.text((x, y), text, font=font, fill=color)
    else:
        x, y = position_of()
        draw.text((x, y), text, font=font, fill=color,
                  stroke_width=max(0, int(font_size * 0.04)), stroke_fill=(0, 0, 0, 140))
    target.parent.mkdir(parents=True, exist_ok=True)
    layer.save(target)
    return True


def _rgba(value: str, alpha: float) -> tuple[int, int, int, int]:
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    try:
        red, green, blue = (int(text[index:index + 2], 16) for index in (0, 2, 4))
    except (ValueError, IndexError):
        red, green, blue = 255, 255, 255
    return red, green, blue, int(round(max(0.0, min(1.0, alpha)) * 255))


# --------------------------------------------------------------------------- 画面叠加


def _apply_overlays(project: dict[str, Any], base: Path, tmp: Path, plan: dict[str, Any],
                    *, progress: ProgressFn | None, cancel: CancelFn | None) -> Path:
    render = project.get("render") or {}
    subtitle_spec = render.get("subtitle") or {}
    cues = ((project.get("subtitle") or {}).get("cues") or [])
    want_subtitle = bool(subtitle_spec.get("enabled")) and bool(cues)
    watermark_path = tmp / "watermark.png"
    want_watermark = build_watermark(project, (plan["width"], plan["height"]), watermark_path)
    if not want_subtitle and not want_watermark:
        return base

    exe = _exe()
    export = _export_args(render, _shot_boundaries(plan))
    target = tmp / "visual.mp4"
    ass_name = "overlay.ass"
    if want_subtitle:
        (tmp / ass_name).write_text(
            subtitle.build_ass(cues, subtitle_spec, width=plan["width"], height=plan["height"]),
            encoding="utf-8")

    cmd = [exe, "-y", "-v", "error", "-i", str(base)]
    if want_watermark:
        cmd += ["-i", str(watermark_path)]
        chain = "[0:v][1:v]overlay=0:0"
        if want_subtitle:
            chain += f"[tmp];[tmp]ass={ass_name}"
        cmd += ["-filter_complex", chain]
    elif want_subtitle:
        # 只烧字幕：相对路径 + cwd 调 libass，避开中文与空格路径的转义问题
        cmd += ["-vf", f"ass={ass_name}"]
    cmd += [*export, "-an", str(target)]
    _run(cmd, cwd=tmp, timeout=1800, cancel=cancel)
    _progress(progress, 74, "叠加字幕与水印")
    return target


# --------------------------------------------------------------------------- 混音


def _db_to_gain(db: float) -> float:
    return round(10 ** (float(db) / 20.0), 4)


def _mix_audio(project: dict[str, Any], tmp: Path, duration_ms: float, *,
               progress: ProgressFn | None, cancel: CancelFn | None) -> Path:
    audio = project.get("audio") or {}
    if not str(audio.get("file") or "").strip():
        raise StudioError("项目还没有音频", code="no_audio")
    voice = store.read_media(project["id"], str(audio["file"]))
    bgm_spec = (project.get("render") or {}).get("bgm") or {}
    bgm_file = str(bgm_spec.get("file") or "").strip()
    target = tmp / "mixed.m4a"
    seconds = max(0.1, duration_ms / 1000.0)
    exe = _exe()

    if not bgm_file:
        _run([exe, "-y", "-v", "error", "-i", str(voice),
              "-af", f"apad,atrim=0:{seconds:.3f},asetpts=N/SR/TB",
              "-t", f"{seconds:.3f}", "-c:a", "aac", "-b:a", "192k", str(target)],
             timeout=900, cancel=cancel)
        _progress(progress, 84, "整理原声")
        return target

    bgm = store.read_media(project["id"], bgm_file)
    gain = _db_to_gain(float(bgm_spec.get("volumeDb") or -18))
    loop = ["-stream_loop", "-1"] if bool(bgm_spec.get("loop", True)) else []
    filters = [
        f"[0:a]apad,atrim=0:{seconds:.3f},asetpts=N/SR/TB[voice]",
        f"[1:a]atrim=0:{seconds:.3f},asetpts=N/SR/TB,volume={gain}[bg]",
    ]
    if bool(bgm_spec.get("duck", True)):
        filters += [
            "[voice]asplit=2[v1][v2]",
            "[bg][v2]sidechaincompress=threshold=0.06:ratio=6:attack=20:release=350[bgd]",
            "[v1][bgd]amix=inputs=2:duration=first:normalize=0[a]",
        ]
    else:
        filters.append("[voice][bg]amix=inputs=2:duration=first:normalize=0[a]")
    _run([exe, "-y", "-v", "error", "-i", str(voice), *loop, "-i", str(bgm),
          "-filter_complex", ";".join(filters), "-map", "[a]", "-t", f"{seconds:.3f}",
          "-c:a", "aac", "-b:a", "192k", str(target)], timeout=900, cancel=cancel)
    _progress(progress, 84, "混合背景音乐")
    return target


# --------------------------------------------------------------------------- 主流程


def render(project: dict[str, Any], *, progress: ProgressFn | None = None,
           cancel: CancelFn | None = None) -> dict[str, Any]:
    """渲染导出，返回 ``{"file", "durationMs", "bytes"}``。"""
    media.require_ffmpeg()
    plan = timeline(project)
    store.clear_tmp(project["id"])
    tmp = store.tmp_dir(project["id"])
    try:
        _progress(progress, 2, "准备渲染")
        files = _render_segments(project, plan, tmp, progress=progress, cancel=cancel)
        merged = _merge(project, plan, files, tmp, progress=progress, cancel=cancel)
        merged = _normalize_frames(project, merged, tmp, plan, progress=progress, cancel=cancel)
        visual = _apply_overlays(project, merged, tmp, plan, progress=progress, cancel=cancel)
        mixed = _mix_audio(project, tmp, plan["durationMs"], progress=progress, cancel=cancel)
        _check_cancel(cancel)
        name = f"export-{time.strftime('%Y%m%d-%H%M%S')}.mp4"
        target = store.media_dir(project["id"], "out") / name
        _run([_exe(), "-y", "-v", "error", "-i", str(visual), "-i", str(mixed),
              "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
              "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(target)],
             timeout=1800, cancel=cancel)
        size = target.stat().st_size if target.is_file() else 0
        _progress(progress, 100, "导出完成")
        return {
            "file": f"out/{name}",
            "durationMs": plan["durationMs"],
            "bytes": size,
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "shots": len(plan["items"]),
            "width": plan["width"],
            "height": plan["height"],
            "fps": plan["fps"],
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
