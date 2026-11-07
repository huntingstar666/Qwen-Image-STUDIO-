"""导出：GIF / APNG / 动画 WebP / PNG 序列 / 透明精灵表。

原则：

* 合成后的帧已经是最终画布尺寸，导出器只做编码，不再改几何；
* APNG 与 WebP 无损模式能逐像素保留 alpha；
* GIF 受格式限制（256 色 + 1 位透明），会明确写入 warnings；
* 精灵表重新拼回透明宫格时只做整数粘贴，默认 4×4。
"""
from __future__ import annotations

import io
import json
import math
import os
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

from . import timeline as timeline_utils
from .errors import AnimationCanceled
from .registry import EXPORT_FORMATS, normalize_export, parse_color


def _dither(value: bool) -> Any:
    return Image.Dither.FLOYDSTEINBERG if value else Image.Dither.NONE


def _p_image(rgba: Image.Image, colors: int, dither: bool,
             transparent: bool) -> Image.Image:
    """RGBA → P。透明模式下把索引 0 保留给透明色。"""
    colors = max(2, min(256, int(colors)))
    base_colors = max(2, colors - 1) if transparent else colors
    rgb = rgba.convert("RGB")
    quantized = rgb.quantize(colors=base_colors, method=Image.Quantize.MEDIANCUT,
                             dither=_dither(dither))
    palette = list(quantized.getpalette() or [])
    palette = (palette + [0] * (768 - len(palette)))[:768]

    if not transparent:
        out = quantized.copy()
        out.putpalette(palette)
        return out

    indices = np.asarray(quantized, dtype=np.uint8)
    indices = np.minimum(indices, 254) + 1
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    indices[alpha < 128] = 0
    out = Image.fromarray(indices, mode="P")
    out.putpalette([0, 0, 0] + palette[:765])
    out.info["transparency"] = 0
    return out


def _flat(image: Image.Image, background: tuple[int, int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", image.size, background)
    canvas.alpha_composite(image)
    return canvas


def export_gif(frames: list[Image.Image], durations: list[int], path: Path,
               options: dict[str, Any]) -> dict[str, Any]:
    transparent = bool(options.get("transparent", True))
    background = parse_color(str(options.get("background") or "#ffffff"), default=(255, 255, 255, 255))
    prepared = [(_p_image(frame, int(options.get("colors") or 256),
                          bool(options.get("dither", True)), transparent)
                 if transparent else _p_image(_flat(frame, background),
                                              int(options.get("colors") or 256),
                                              bool(options.get("dither", True)), False))
                for frame in frames]
    kwargs: dict[str, Any] = {
        "format": "GIF",
        "save_all": True,
        "append_images": prepared[1:],
        "duration": durations,
        "loop": int(options.get("loop") or 0),
        "disposal": 2 if transparent else 1,
        "optimize": bool(options.get("optimize", False)),
        "comment": b"animation_kit",
    }
    if transparent:
        kwargs["transparency"] = 0
    prepared[0].save(path, **kwargs)
    return {"transparent": transparent}


def export_apng(frames: list[Image.Image], durations: list[int], path: Path,
                options: dict[str, Any]) -> dict[str, Any]:
    rgba = [frame.convert("RGBA") for frame in frames]
    rgba[0].save(
        path,
        format="PNG",
        save_all=True,
        append_images=rgba[1:],
        duration=durations,
        loop=int(options.get("loop") or 0),
        disposal=1,
        blend=0,
        optimize=False,
    )
    return {"lossless": True}


def export_webp(frames: list[Image.Image], durations: list[int], path: Path,
                options: dict[str, Any]) -> dict[str, Any]:
    rgba = [frame.convert("RGBA") for frame in frames]
    kwargs: dict[str, Any] = {
        "format": "WEBP",
        "save_all": True,
        "append_images": rgba[1:],
        "duration": durations,
        "loop": int(options.get("loop") or 0),
        "quality": int(options.get("quality") or 92),
        "lossless": bool(options.get("lossless", True)),
        "method": int(options.get("method") or 4),
        "exact": True,
    }
    rgba[0].save(path, **kwargs)
    return {"lossless": bool(options.get("lossless", True))}


def export_png_sequence(frames: list[Image.Image], durations: list[int], path: Path,
                        doc: dict[str, Any]) -> dict[str, Any]:
    manifest = {
        "version": 1,
        "canvas": doc.get("canvas"),
        "timeline": timeline_utils.summary(doc),
        "frames": [],
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for index, (frame, duration) in enumerate(zip(frames, durations)):
            name = f"frame_{index + 1:04d}.png"
            buffer = io.BytesIO()
            frame.convert("RGBA").save(buffer, format="PNG", compress_level=6)
            archive.writestr(name, buffer.getvalue())
            manifest["frames"].append({"file": name, "duration": int(duration)})
        archive.writestr("manifest.json",
                         json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    return {"zip": True}


def build_sprite_sheet(frames: list[Image.Image], *, columns: int = 4,
                       padding: int = 0) -> tuple[Image.Image, dict[str, Any]]:
    if not frames:
        raise ValueError("没有可导出的帧")
    width, height = frames[0].size
    columns = max(1, min(64, int(columns)))
    padding = max(0, int(padding))
    rows = int(math.ceil(len(frames) / columns))
    sheet_w = columns * width + padding * (columns - 1)
    sheet_h = rows * height + padding * (rows - 1)
    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    cells = []
    for index, frame in enumerate(frames):
        row, column = divmod(index, columns)
        x = column * (width + padding)
        y = row * (height + padding)
        sheet.alpha_composite(frame, (x, y))
        cells.append({"index": index, "x": x, "y": y, "w": width, "h": height})
    return sheet, {
        "width": sheet_w,
        "height": sheet_h,
        "columns": columns,
        "rows": rows,
        "padding": padding,
        "cell": {"w": width, "h": height},
        "cells": cells,
    }


def _unique_frames(doc: dict[str, Any], rendered: Any) -> list[tuple[dict[str, Any], Image.Image]]:
    out = []
    for frame in doc.get("frames") or []:
        if not frame.get("visible", True):
            continue
        out.append((frame, rendered.image_for(frame)))
    return out


def export_animation(
    doc: dict[str, Any],
    rendered: Any,
    fmt: str,
    raw_options: Any,
    *,
    out_dir: Path,
    url_for: Callable[[Path], str],
    progress: Callable[[int, int, str], None] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    fmt = str(fmt or "").strip()
    if fmt not in EXPORT_FORMATS:
        raise ValueError(f"不支持的导出格式：{fmt}")
    options = normalize_export(fmt, raw_options)
    sequence = timeline_utils.expanded_sequence(doc)
    if not sequence:
        raise ValueError("时间轴为空：请先导入至少一帧")

    assets = _unique_frames(doc, rendered)
    if not assets:
        raise ValueError("没有可见的帧")
    frames = [image for _frame, image in assets]
    durations = [int(item["duration"]) for item in sequence]
    duration_values = [int(item["duration"]) for item in sequence]

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"anim-{time.strftime('%Y%m%d-%H%M%S')}-{os.urandom(3).hex()}"
    spec = EXPORT_FORMATS[fmt]
    steps = max(1, len(sequence))
    warnings: list[str] = list(rendered.warnings)

    if fmt == "sprite-sheet":
        sheet, layout = build_sprite_sheet(
            frames,
            columns=int(options.get("columns") or 4),
            padding=int(options.get("padding") or 0),
        )
        path = out_dir / f"{stem}.png"
        sheet.save(path, format="PNG", compress_level=6)
        atlas_url = ""
        if options.get("atlas", True):
            atlas = {
                "image": path.name,
                "width": layout["width"],
                "height": layout["height"],
                "columns": layout["columns"],
                "rows": layout["rows"],
                "padding": layout["padding"],
                "cell": layout["cell"],
                "frames": [
                    dict(cell, id=frame.get("id"), name=frame.get("name"),
                         duration=timeline_utils.frame_duration(frame, int((doc.get("timeline") or {}).get("fps") or 12)),
                         hold=timeline_utils.hold_of(frame))
                    for cell, (frame, _image) in zip(layout["cells"], assets)
                ],
            }
            atlas_path = out_dir / f"{stem}.atlas.json"
            atlas_path.write_text(json.dumps(atlas, ensure_ascii=False, indent=2), encoding="utf-8")
            atlas_url = url_for(atlas_path)
        if progress:
            progress(1, 1, "精灵表已生成")
        result = {
            "format": fmt,
            "filename": path.name,
            "url": url_for(path),
            "atlas_url": atlas_url,
            "bytes": path.stat().st_size,
            "width": layout["width"],
            "height": layout["height"],
            "frame_count": len(frames),
            "exposure_count": len(sequence),
            "duration_ms": sum(duration_values),
            "loop": int(options.get("loop") or 0),
            "pixel_exact": bool(rendered.pixel_exact),
            "warnings": warnings + ["精灵表使用去重后的帧（停顿会写进 atlas 的 hold/duration）"],
        }
        return result

    expanded: list[Image.Image] = []
    expanded_durations: list[int] = []
    for index, item in enumerate(sequence):
        if cancel and cancel():
            raise AnimationCanceled()
        image = rendered.frames[str(item["frameId"])].image
        expanded.append(image)
        expanded_durations.append(int(item["duration"]))
        if progress:
            progress(index + 1, steps, f"准备第 {index + 1}/{steps} 次曝光")

    if fmt == "gif":
        durations_gif = timeline_utils.gif_durations(
            sequence, min_ms=int(options.get("minMs") or 20),
        )
        expanded_durations = durations_gif
        if options.get("transparent", True):
            warnings.append("GIF 透明只有 1 位（alpha<128 视为透明），半透明边缘会被硬切")
        if int(options.get("colors") or 256) < 256:
            warnings.append(f"GIF 使用 {int(options.get('colors') or 256)} 色调色板，颜色会有量化误差")
    elif fmt == "webp" and not options.get("lossless", True):
        warnings.append("WebP 有损模式会产生压缩误差；需要逐像素一致请开启无损")

    path = out_dir / f"{stem}.{spec['ext']}"
    if fmt == "gif":
        info = export_gif(expanded, expanded_durations, path, options)
    elif fmt == "apng":
        info = export_apng(expanded, expanded_durations, path, options)
    elif fmt == "webp":
        info = export_webp(expanded, expanded_durations, path, options)
    elif fmt == "png-sequence":
        info = export_png_sequence(expanded, expanded_durations, path, doc)
    else:  # pragma: no cover - 上面已经穷举
        raise ValueError(f"未实现的格式：{fmt}")

    if progress:
        progress(steps, steps, "编码完成")

    actual = _probe_animation(path) if fmt in ("gif", "apng", "webp") else {}
    actual_count = int(actual.get("frames") or len(expanded))
    actual_durations = actual.get("durations") or expanded_durations
    if actual_count != len(expanded):
        warnings.append(
            f"{fmt.upper()} 编码器把 {len(expanded)} 次曝光合并成 {actual_count} 帧"
            "（相同连帧被合并，播放时长不变）"
        )
    return {
        "format": fmt,
        "filename": path.name,
        "url": url_for(path),
        "bytes": path.stat().st_size,
        "width": expanded[0].width,
        "height": expanded[0].height,
        "frame_count": actual_count,
        "exposure_count": len(expanded),
        "unique_frames": len(frames),
        "duration_ms": sum(int(item) for item in actual_durations),
        "loop": int(options.get("loop") or 0),
        "durations": [int(item) for item in actual_durations],
        "pixel_exact": bool(rendered.pixel_exact) and bool(info.get("lossless", fmt in ("apng", "png-sequence"))),
        "resampled_ids": rendered.resampled_ids,
        "warnings": warnings,
        "options": options,
    }


def _probe_animation(path: Path) -> dict[str, Any]:
    """回读编码结果，拿到真实的帧数与逐帧时长（GIF 会合并相同连帧）。"""
    try:
        with Image.open(path) as image:
            count = int(getattr(image, "n_frames", 1))
            durations: list[int] = []
            for index in range(count):
                image.seek(index)
                durations.append(int(image.info.get("duration") or 0))
            return {"frames": count, "durations": durations}
    except Exception:  # noqa: BLE001
        return {}
