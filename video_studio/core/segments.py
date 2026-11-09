"""分段：字幕 cue → 镜头段，并做静音吸附与帧对齐。

规则（与 docs/PLAN_VIDEO_WORKBENCH.md 5.1 一致）：

* 相邻 cue 间隔小于 ``mergeGapMs`` 合并为同一镜头，单镜头不超过 ``maxShotMs``；
* **只在 cue 边界切**，绝不从一句台词中间切；
* 段与段首尾相接、铺满整条音轨（含开头/结尾的静音）；
* 内部边界在 ``snapWindowMs`` 内命中静音中点时向中点移动；
* 所有边界对齐到视频帧，导出时零黑帧、总时长精确。
"""
from __future__ import annotations

from typing import Any, Iterable

from .. import config
from .errors import StudioError
from .schema import new_shot


def _frame_ms(fps: int) -> int:
    return max(1, int(round(1000.0 / max(1, fps))))


def snap_to_frame(value_ms: int, fps: int) -> int:
    frames = max(1, int(fps))
    return int(round(int(value_ms) * frames / 1000.0)) * 1000 // frames


def _group(cues: list[dict[str, Any]], merge_gap_ms: int, max_shot_ms: int) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for cue in cues:
        start = int(cue["startMs"])
        end = int(cue["endMs"])
        if groups:
            current = groups[-1]
            gap = start - current["endMs"]
            too_long = end - current["startMs"] > max_shot_ms
            if gap <= merge_gap_ms and not too_long:
                current["endMs"] = max(current["endMs"], end)
                current["texts"].append(cue["text"])
                continue
        groups.append({"startMs": start, "endMs": end, "texts": [cue["text"]]})
    return groups


def _snap(value_ms: int, silences: Iterable[tuple[int, int]], window_ms: int) -> int:
    best: tuple[int, int] | None = None
    for start, end in silences:
        midpoint = (start + end) // 2
        distance = abs(midpoint - value_ms)
        if distance <= window_ms and (best is None or distance < best[0]):
            best = (distance, midpoint)
    return best[1] if best else value_ms


def derive(
    cues: list[dict[str, Any]],
    *,
    duration_ms: int,
    fps: int = config.FPS,
    merge_gap_ms: int = config.MERGE_GAP_MS,
    max_shot_ms: int = config.MAX_SHOT_MS,
    silences: Iterable[tuple[int, int]] = (),
    snap_window_ms: int = config.SNAP_WINDOW_MS,
) -> list[dict[str, Any]]:
    """按字幕时间轴切出镜头段。返回的段首尾相接，覆盖 0~duration。"""
    if not cues:
        raise StudioError("还没有字幕，无法分段", code="no_subtitle")
    if duration_ms <= 0:
        raise StudioError("还没有音频，无法分段", code="no_audio")

    clean = []
    for cue in cues:
        start = max(0, min(int(cue["startMs"]), duration_ms))
        end = max(start + 1, min(int(cue["endMs"]), duration_ms))
        if end <= start:
            continue
        clean.append({"startMs": start, "endMs": end, "text": str(cue.get("text") or "")})
    if not clean:
        raise StudioError("字幕时间轴全部落在音频范围之外", code="bad_subtitle")

    merge_gap_ms = max(0, int(merge_gap_ms))
    max_shot_ms = max(500, int(max_shot_ms))
    groups = _group(clean, merge_gap_ms, max_shot_ms)
    if len(groups) > config.MAX_SHOTS:
        raise StudioError(
            f"分段后共 {len(groups)} 段，超过上限 {config.MAX_SHOTS} 段；"
            f"请调大单段最长时长（当前 {max_shot_ms} ms）",
            code="too_many_shots")

    # 边界：0 → 各组起点 → 总时长；内部边界先吸附静音，再对齐帧
    frame = _frame_ms(fps)
    boundaries = [0]
    for group in groups[1:]:
        candidate = _snap(int(group["startMs"]), silences, snap_window_ms)
        boundaries.append(candidate)
    boundaries.append(duration_ms)

    snapped = [0]
    for index in range(1, len(boundaries)):
        value = snap_to_frame(boundaries[index], fps)
        minimum = snapped[-1] + frame
        maximum = duration_ms - (len(boundaries) - index - 1) * frame
        snapped.append(max(minimum, min(value, maximum)))
    snapped[-1] = duration_ms

    shots: list[dict[str, Any]] = []
    for index, group in enumerate(groups):
        start = snapped[index]
        end = snapped[index + 1]
        shots.append(new_shot(index, start, end, "\n".join(group["texts"]).strip()))
    return shots


def normalize_timeline(shots: list[dict[str, Any]], duration_ms: int,
                       fps: int = config.FPS) -> list[dict[str, Any]]:
    """把镜头段整理成首尾相接、对齐帧、覆盖全时长的序列。

    以 ``shots[i].startMs`` 作为唯一权威边界（``endMs`` 由下一段起点推导），
    因此用户拖动某段左边界就等价于同时调整了上一段的右边界。
    """
    if not shots:
        return shots
    frame = _frame_ms(fps)
    duration_ms = max(int(duration_ms), frame * len(shots))
    boundaries = [0]
    for shot in shots[1:]:
        boundaries.append(int(shot.get("startMs") or 0))
    boundaries.append(duration_ms)

    fixed = [0]
    for index in range(1, len(boundaries)):
        remaining = len(boundaries) - index - 1
        value = snap_to_frame(boundaries[index], fps)
        value = max(fixed[-1] + frame, min(value, duration_ms - remaining * frame))
        fixed.append(value)
    fixed[-1] = duration_ms

    for index, shot in enumerate(shots):
        shot["index"] = index
        shot["id"] = shot.get("id") or f"s{index + 1}"
        shot["startMs"] = fixed[index]
        shot["endMs"] = fixed[index + 1]
    return shots


def retime(shots: list[dict[str, Any]], shot_id: str, patch: dict[str, Any],
           duration_ms: int, fps: int = config.FPS) -> list[dict[str, Any]]:
    """把「改某段左/右边界」翻译成边界数组，再统一归一化。"""
    index = next((i for i, shot in enumerate(shots) if shot.get("id") == shot_id), -1)
    if index < 0:
        raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
    if "startMs" in patch and index > 0:
        shots[index]["startMs"] = int(patch["startMs"])
    if "endMs" in patch and index < len(shots) - 1:
        shots[index + 1]["startMs"] = int(patch["endMs"])
    return normalize_timeline(shots, duration_ms, fps)


def summary(shots: list[dict[str, Any]]) -> dict[str, Any]:
    total = sum(max(0, int(shot["endMs"]) - int(shot["startMs"])) for shot in shots)
    ready = sum(1 for shot in shots if shot.get("status") == "ready")
    return {
        "count": len(shots),
        "durationMs": total,
        "readyCount": ready,
        "pendingCount": len(shots) - ready,
    }
