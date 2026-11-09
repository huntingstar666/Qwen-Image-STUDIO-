"""字幕解析与 ASS 生成。

支持 SRT / VTT / ASS 三种带时间轴的输入，统一转成 ``cue``：

    {"id": "c1", "startMs": 0, "endMs": 2140, "text": "第一句台词"}

烧录走 ASS（样式可控、中文断行稳），不用 drawtext。
"""
from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any, Iterable

from .errors import StudioError

FORMATS = ("srt", "vtt", "ass", "ssa")
MAX_CUES = 2000
MAX_TEXT = 1000

_TIME_FULL = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})")
_TAG = re.compile(r"<[^>]+>")
_ASS_OVERRIDE = re.compile(r"\{[^}]*\}")


def detect_format(filename: str, head: str = "") -> str:
    ext = Path(str(filename or "")).suffix.lower().lstrip(".")
    if ext in FORMATS:
        return "ass" if ext == "ssa" else ext
    text = (head or "").lstrip("\ufeff").strip().lower()
    if text.startswith("webvtt"):
        return "vtt"
    if "[script info]" in text or "[events]" in text:
        return "ass"
    if "-->" in text:
        return "srt"
    raise StudioError("无法识别字幕格式（需要 SRT / VTT / ASS）", code="unsupported_format")


def decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


# --------------------------------------------------------------------------- 时间


def parse_time(text: str) -> int:
    match = _TIME_FULL.search(str(text or ""))
    if not match:
        return -1
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    fraction = match.group(4) or "0"
    millis = int(fraction.ljust(3, "0")[:3])
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def format_ass_time(ms: int) -> str:
    ms = max(0, int(ms))
    hours, rest = divmod(ms, 3600000)
    minutes, rest = divmod(rest, 60000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{millis // 10:02d}"


def format_srt_time(ms: int) -> str:
    ms = max(0, int(ms))
    hours, rest = divmod(ms, 3600000)
    minutes, rest = divmod(rest, 60000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


# --------------------------------------------------------------------------- 解析


def _clean_text(text: str, *, ass: bool = False) -> str:
    value = _ASS_OVERRIDE.sub("", text) if ass else _TAG.sub("", text)
    value = value.replace("\\N", "\n").replace("\\n", "\n")
    value = html.unescape(value)
    value = re.sub(r"[ \t\u00a0]+", " ", value)
    lines = [line.strip() for line in value.split("\n")]
    value = "\n".join(line for line in lines if line)
    return value.strip()[:MAX_TEXT]


def parse_srt(text: str) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n"))
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        index = 0
        if re.fullmatch(r"\d+", lines[0].strip()):
            index = 1
        if index >= len(lines) or "-->" not in lines[index]:
            continue
        left, _, right = lines[index].partition("-->")
        start = parse_time(left)
        end = parse_time(right.strip().split(" ")[0])
        body = _clean_text("\n".join(lines[index + 1:]))
        if start < 0 or end <= start or not body:
            continue
        cues.append({"startMs": start, "endMs": end, "text": body})
    return cues


def parse_vtt(text: str) -> list[dict[str, Any]]:
    body = text.replace("\r\n", "\n").replace("\r", "\n")
    cues: list[dict[str, Any]] = []
    blocks = re.split(r"\n\s*\n", body)
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        header = lines[0].strip()
        if header.upper().startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue
        index = 0
        if "-->" not in lines[0] and len(lines) > 1 and "-->" in lines[1]:
            index = 1
        if "-->" not in lines[index]:
            continue
        left, _, right = lines[index].partition("-->")
        start = parse_time(left)
        end = parse_time(right.strip().split(" ")[0])
        content = _clean_text("\n".join(lines[index + 1:]))
        if start < 0 or end <= start or not content:
            continue
        cues.append({"startMs": start, "endMs": end, "text": content})
    return cues


def parse_ass(text: str) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    in_events = False
    columns: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if line.lower().startswith("[") and line.endswith("]"):
            in_events = line.lower().strip("[]") == "events"
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            columns = [item.strip().lower() for item in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("dialogue:"):
            continue
        payload = line.split(":", 1)[1]
        parts = payload.split(",", max(0, len(columns) - 1)) if columns else payload.split(",", 9)
        if len(parts) < 3:
            continue
        if columns and "start" in columns and "end" in columns and "text" in columns:
            start = parse_time(parts[columns.index("start")])
            end = parse_time(parts[columns.index("end")])
            content = _clean_text(parts[columns.index("text")], ass=True)
        else:
            start = parse_time(parts[1])
            end = parse_time(parts[2])
            content = _clean_text(",".join(parts[9:]) if len(parts) > 9 else parts[-1], ass=True)
        if start < 0 or end <= start or not content:
            continue
        cues.append({"startMs": start, "endMs": end, "text": content})
    return cues


def parse(data: bytes, filename: str) -> dict[str, Any]:
    text = decode(data)
    fmt = detect_format(filename, text)
    if fmt == "vtt":
        cues = parse_vtt(text)
    elif fmt == "ass":
        cues = parse_ass(text)
    else:
        cues = parse_srt(text)
    if not cues:
        raise StudioError("字幕里没有解析到有效时间轴（需要 开始 --> 结束 或 Dialogue 行）",
                          code="bad_subtitle")
    cues.sort(key=lambda item: (item["startMs"], item["endMs"]))
    return {"format": fmt, "cues": normalize_cues(cues)}


def normalize_cues(cues: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in cues:
        start = max(0, int(raw.get("startMs") or 0))
        end = max(start + 1, int(raw.get("endMs") or 0))
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        out.append({"startMs": start, "endMs": end, "text": text[:MAX_TEXT]})
        if len(out) >= MAX_CUES:
            break
    return [{"id": f"c{index + 1}", **cue} for index, cue in enumerate(out)]


# --------------------------------------------------------------------------- ASS 生成


def _ass_color(value: str, *, alpha: float = 1.0) -> str:
    """``#RRGGBB`` → ASS ``&HAABBGGRR``。"""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    try:
        red, green, blue = (int(text[index:index + 2], 16) for index in (0, 2, 4))
    except (ValueError, IndexError):
        red, green, blue = 255, 255, 255
    alpha_byte = int(round((1.0 - max(0.0, min(1.0, alpha))) * 255))
    return f"&H{alpha_byte:02X}{blue:02X}{green:02X}{red:02X}"


_FONT_FILES = {
    "msyhbd": ["msyhbd.ttc"],
    "msyh": ["msyh.ttc", "msyh.ttf"],
    "simhei": ["simhei.ttf"],
    "simsun": ["simsun.ttc"],
    "simkai": ["simkai.ttf"],
    "arialbd": ["arialbd.ttf"],
    "arial": ["arial.ttf"],
}


def font_path(font_id: str) -> str:
    """按字体 id 找本机字体文件；找不到返回空串（由 libass 回退）。"""
    import os

    for base in (os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
                 "/usr/share/fonts", "/System/Library/Fonts"):
        if not os.path.isdir(base):
            continue
        for name in _FONT_FILES.get(font_id, []):
            candidate = os.path.join(base, name)
            if os.path.isfile(candidate):
                return candidate
    return ""


#: 字体 id → libass 使用的字体族名（与 font_path 的候选文件对应）
FONT_FAMILIES = {
    "msyhbd": ("Microsoft YaHei", 1),
    "msyh": ("Microsoft YaHei", 0),
    "simhei": ("SimHei", 0),
    "simsun": ("SimSun", 0),
    "simkai": ("KaiTi", 0),
    "arialbd": ("Arial", 1),
    "arial": ("Arial", 0),
}


def build_ass(
    cues: Iterable[dict[str, Any]],
    style: dict[str, Any],
    *,
    width: int,
    height: int,
    offset_ms: int = 0,
    duration_ms: int | None = None,
) -> str:
    """把 cue 渲染成整段 ASS。``offset_ms`` 用于分段渲染时把时间平移到段内。"""
    size = max(8, int(round(int(style.get("size") or 46) * height / 1080)))
    outline = max(0, int(style.get("outline") or 0))
    position = str(style.get("position") or "bottom")
    alignment = {"bottom": 2, "middle": 5, "top": 8}.get(position, 2)
    margin_v = int(int(style.get("marginV") or 56) * height / 1080)
    primary = _ass_color(str(style.get("color") or "#FFFFFF"))
    outline_color = _ass_color(str(style.get("outlineColor") or "#000000"))
    font_name, bold = FONT_FAMILIES.get(str(style.get("fontId") or "msyhbd"),
                                        ("Microsoft YaHei", 1))

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,{font},{size},{primary},&H00FFFFFF,{outline_color},&H80000000,"
        "{bold},0,0,0,100,100,0,0,1,{outline},1,{alignment},40,40,{margin_v},1".format(
            font=font_name, size=size, primary=primary, outline_color=outline_color,
            bold=bold, outline=outline, alignment=alignment, margin_v=margin_v),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    lines = list(header)
    limit = duration_ms if duration_ms is not None else None
    for cue in cues:
        start = int(cue.get("startMs") or 0) - offset_ms
        end = int(cue.get("endMs") or 0) - offset_ms
        if limit is not None:
            start = min(start, limit)
            end = min(end, limit)
        if end <= 0 or start >= (limit if limit is not None else 1 << 60):
            continue
        start = max(0, start)
        end = max(start + 10, end)
        text = str(cue.get("text") or "").replace("\n", "\\N")
        lines.append(f"Dialogue: 0,{format_ass_time(start)},{format_ass_time(end)},Default,,0,0,0,,{text}")
    return "\n".join(lines) + "\n"


def write_srt_file(path: Path, cues: Iterable[dict[str, Any]]) -> None:
    lines = []
    for index, cue in enumerate(cues, start=1):
        lines.append(str(index))
        lines.append(f"{format_srt_time(cue['startMs'])} --> {format_srt_time(cue['endMs'])}")
        lines.append(str(cue["text"]))
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
