"""分段：字幕 cue → 镜头段，并做静音吸附与帧对齐。

规则（与 docs/PLAN_VIDEO_WORKBENCH.md 5.1 一致）：

* 相邻 cue 间隔小于 ``mergeGapMs`` 合并为同一镜头，单镜头不超过 ``maxShotMs``；
* **只在 cue 边界切**，绝不从一句台词中间切；
* 段与段首尾相接、铺满整条音轨（含开头/结尾的静音）；
* 内部边界在 ``snapWindowMs`` 内命中静音中点时向中点移动；
* 所有边界对齐到视频帧，导出时零黑帧、总时长精确。
"""
from __future__ import annotations

import copy
from typing import Any, Iterable

from .. import config
from .errors import StudioError
from .schema import new_shot, now_text


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


# --------------------------------------------------------------------------- 待处理标记


def mark_review(shot: dict[str, Any], *, prompt: bool = False, image: bool = False,
                reason: str = "") -> None:
    """给段落打「提示词 / 图片需复核」标记；不阻塞生成与导出。"""
    review = dict(shot.get("review") or {})
    if prompt:
        review["prompt"] = True
    if image:
        review["image"] = True
    if not (review.get("prompt") or review.get("image")):
        shot.pop("review", None)
        return
    if reason:
        review["reason"] = reason
    review["at"] = now_text()
    shot["review"] = review


def clear_review(shot: dict[str, Any], fields: Iterable[str]) -> None:
    """清除指定标记；两个都清掉后整条 review 删除。"""
    review = shot.get("review")
    if not isinstance(review, dict):
        return
    review = dict(review)
    for field in fields:
        review.pop(field, None)
    if not (review.get("prompt") or review.get("image")):
        shot.pop("review", None)
    else:
        shot["review"] = review


# --------------------------------------------------------------------------- 台词与字幕


def cues_for_range(cues: Iterable[dict[str, Any]], start_ms: int,
                   end_ms: int) -> list[dict[str, Any]]:
    """返回与 [start, end) 有重叠的字幕 cue。"""
    return [cue for cue in cues
            if int(cue["endMs"]) > int(start_ms) and int(cue["startMs"]) < int(end_ms)]


def _cue_owner(shots: list[dict[str, Any]], cue: dict[str, Any]) -> int:
    """跨段 cue 归给重叠时长最大的那一段（并列时归前一段）。"""
    cue_start = int(cue["startMs"])
    cue_end = int(cue["endMs"])
    best, best_overlap = -1, 0
    for index, shot in enumerate(shots):
        overlap = min(cue_end, int(shot["endMs"])) - max(cue_start, int(shot["startMs"]))
        if overlap > best_overlap:
            best, best_overlap = index, overlap
    return best


def reconcile_texts(shots: list[dict[str, Any]], cues: Iterable[dict[str, Any]]) -> None:
    """按覆盖到的 cue 重算所有 ``textMode == auto`` 段的台词。

    手动段完全不动；没有覆盖到字幕的自动段保留原台词并追加一条警告。
    """
    cues = list(cues)
    owned: dict[int, list[str]] = {index: [] for index in range(len(shots))}
    for cue in cues:
        owner = _cue_owner(shots, cue)
        if owner < 0:
            continue
        text = str(cue.get("text") or "").strip()
        if text:
            owned[owner].append(text)

    for index, shot in enumerate(shots):
        if str(shot.get("textMode") or "auto") != "auto":
            continue
        texts = owned.get(index) or []
        warnings = [str(item) for item in (shot.get("warnings") or [])
                    if str(item) != "本段没有覆盖字幕"]
        if texts:
            shot["text"] = "\n".join(texts)[:2000]
        else:
            warnings.append("本段没有覆盖字幕")
        shot["warnings"] = warnings


def next_shot_id(shots: Iterable[dict[str, Any]]) -> str:
    used = {str(shot.get("id") or "") for shot in shots}
    highest = 0
    for shot_id in used:
        if shot_id.startswith("s") and shot_id[1:].isdigit():
            highest = max(highest, int(shot_id[1:]))
    candidate = highest + 1
    while f"s{candidate}" in used:
        candidate += 1
    return f"s{candidate}"


# --------------------------------------------------------------------------- 合并 / 拆分


def _merge_history(shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    history: list[dict[str, Any]] = []
    for shot in shots:
        for item in shot.get("imageHistory") or []:
            file = str(item.get("file") or "")
            if not file or file in seen:
                continue
            seen.add(file)
            history.append(dict(item))
    history.sort(key=lambda item: str(item.get("at") or ""), reverse=True)
    return history


def _merge_image(merged: dict[str, Any], group: list[dict[str, Any]]) -> None:
    source = next((shot for shot in group if shot.get("image")), None)
    if source is None:
        merged["image"] = ""
        merged["status"] = "pending"
        merged["seed"] = 0
        merged["width"] = 0
        merged["height"] = 0
        return
    merged["image"] = str(source.get("image") or "")
    merged["status"] = "ready"
    merged["seed"] = int(source.get("seed") or 0)
    merged["width"] = int(source.get("width") or 0)
    merged["height"] = int(source.get("height") or 0)


def merge_shots(shots: list[dict[str, Any]], shot_ids: Iterable[str], *,
                duration_ms: int, fps: int = config.FPS,
                cues: Iterable[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """把连续的多个镜头段合并成一个画面（字幕 cues 完全不动）。"""
    wanted = [str(item) for item in shot_ids]
    if len(wanted) < 2:
        raise StudioError("至少选择两个连续镜头段才能合并", code="bad_payload")
    index_of = {str(shot.get("id")): index for index, shot in enumerate(shots)}
    missing = [shot_id for shot_id in wanted if shot_id not in index_of]
    if missing:
        raise StudioError(f"镜头段不存在：{missing[0]}", code="not_found", status=404)
    indexes = sorted(index_of[shot_id] for shot_id in wanted)
    if indexes != list(range(indexes[0], indexes[0] + len(indexes))):
        raise StudioError("只能合并时间上连续的镜头段", code="bad_payload")
    group = [shots[index] for index in indexes]
    start = int(group[0]["startMs"])
    end = int(group[-1]["endMs"])
    frame = _frame_ms(fps)
    if end - start < frame:
        raise StudioError("合并后的画面不足 1 帧", code="bad_payload")
    if end - start > 30000:
        raise StudioError("一次最多合并成 30 秒的画面", code="bad_payload")

    merged = copy.deepcopy(group[0])
    merged["startMs"] = start
    merged["endMs"] = end
    auto = all(str(shot.get("textMode") or "auto") == "auto" for shot in group)
    texts: list[str] = []
    for shot in group:
        for line in str(shot.get("text") or "").split("\n"):
            line = line.strip()
            if line and line not in texts:
                texts.append(line)
    merged["textMode"] = "auto" if auto else "manual"
    merged["text"] = "\n".join(texts)[:2000]

    description = next((str(shot.get("description") or "").strip()
                        for shot in group if str(shot.get("description") or "").strip()), "")
    merged["description"] = description

    used: list[str] = []
    for shot in group:
        for item in shot.get("usedEntities") or []:
            if str(item) not in used:
                used.append(str(item))
    merged["usedEntities"] = used

    history = _merge_history(group)
    _merge_image(merged, group)
    current = str(merged.get("image") or "")
    if current:
        history = [item for item in history if item.get("file") != current]
        history.insert(0, next(
            (item for item in _merge_history(group) if item.get("file") == current),
            {"file": current, "seed": merged["seed"], "at": now_text(),
             "jobId": "", "width": merged["width"], "height": merged["height"],
             "source": "merge"},
        ))
    merged["imageHistory"] = history[:8]
    merged["beat"] = None
    merged["attempts"] = max(int(shot.get("attempts") or 0) for shot in group)

    # 保持原顺序：用第一段的位置替换，再剔除被合并段
    head = shots[:indexes[0]]
    tail = shots[indexes[-1] + 1:]
    merged_shots = head + [merged] + tail

    normalize_timeline(merged_shots, duration_ms, fps)
    reconcile_texts(merged_shots, cues)
    mark_review(merged, prompt=True, image=True, reason="merge")
    return merged_shots


def _beat(child: dict[str, Any], parent: dict[str, Any], index: int, count: int) -> None:
    beat = parent.get("beat") if isinstance(parent.get("beat"), dict) else {}
    group = str(beat.get("group") or parent.get("id") or "")
    child["beat"] = {"group": group, "index": index, "count": count}


_MOTION_OPPOSITE = {
    "push": "pull", "pull": "push",
    "left": "right", "right": "left",
    "up": "down", "down": "up",
    "diag": "none", "none": "none",
}


def _split_frame(value_ms: int, fps: int) -> int:
    return snap_to_frame(value_ms, fps)


def split_shot_at(shots: list[dict[str, Any]], shot_id: str, at_ms: int, *,
                  duration_ms: int, fps: int = config.FPS,
                  cues: Iterable[dict[str, Any]] = (),
                  snap_window_ms: int = 120) -> list[dict[str, Any]]:
    """在播放头位置把一段拆成两个画面；台词与字幕都不拆。"""
    index = next((i for i, shot in enumerate(shots) if shot.get("id") == shot_id), -1)
    if index < 0:
        raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
    source = shots[index]
    frame = _frame_ms(fps)
    start = int(source["startMs"])
    end = int(source["endMs"])
    cut = _split_frame(int(at_ms), fps)
    cues = list(cues)

    snapped = cut
    best = None
    for cue in cues:
        for edge in (int(cue["startMs"]), int(cue["endMs"])):
            distance = abs(edge - cut)
            if distance <= snap_window_ms and (best is None or distance < best[0]):
                best = (distance, edge)
    on_boundary = False
    if best is not None:
        candidate = _split_frame(best[1], fps)
        # 吸附到段首/段尾就失去拆分意义，这种情况保留原始切点
        if candidate - start >= frame and end - candidate >= frame:
            snapped = candidate
            on_boundary = True
    cut = snapped
    if cut - start < frame or end - cut < frame:
        raise StudioError("拆分点太靠近段落边缘，至少留 1 帧", code="bad_payload")

    left = copy.deepcopy(source)
    right = copy.deepcopy(source)
    right["id"] = next_shot_id(shots)

    left["startMs"] = start
    left["endMs"] = cut
    right["startMs"] = cut
    right["endMs"] = end

    auto = str(source.get("textMode") or "auto") == "auto" and on_boundary
    left["textMode"] = "auto" if auto else "manual"
    right["textMode"] = "auto" if auto else "manual"
    left["text"] = str(source.get("text") or "")
    right["text"] = str(source.get("text") or "")

    right["image"] = ""
    right["status"] = "pending"
    right["seed"] = 0
    right["width"] = 0
    right["height"] = 0
    right["imageHistory"] = []
    right["attempts"] = 0
    right["transition"] = {"type": "cut", "durationMs": 300}
    motion = dict(right.get("motion") or {})
    motion["type"] = _MOTION_OPPOSITE.get(str(motion.get("type") or "none"), "none")
    right["motion"] = motion

    beat = source.get("beat") if isinstance(source.get("beat"), dict) else None
    if beat:
        count = int(beat.get("count") or 1) + 1
        base = int(beat.get("index") or 1)
        _beat(left, source, base, count)
        _beat(right, source, base + 1, count)

    right.pop("review", None)

    result = shots[:index] + [left, right] + shots[index + 1:]
    normalize_timeline(result, duration_ms, fps)
    reconcile_texts(result, cues)

    mark_review(left, prompt=True, reason="split")
    mark_review(right, prompt=True, image=True, reason="split")
    return result


def split_shot_parts(shots: list[dict[str, Any]], shot_id: str, parts: int, *,
                     duration_ms: int, fps: int = config.FPS) -> list[dict[str, Any]]:
    """把一段均分为 N 个画面：每段保留整句台词，总时长精确不变。"""
    index = next((i for i, shot in enumerate(shots) if shot.get("id") == shot_id), -1)
    if index < 0:
        raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
    try:
        parts = int(parts)
    except (TypeError, ValueError):
        raise StudioError("parts 必须是数字", code="bad_payload") from None
    if parts < 2 or parts > 6:
        raise StudioError("只能均分为 2~6 个画面", code="bad_payload")
    source = shots[index]
    start = int(source["startMs"])
    end = int(source["endMs"])
    frame = _frame_ms(fps)
    if end - start < parts * frame:
        raise StudioError("这一段太短，无法均分", code="bad_payload")

    boundaries = [start]
    for step in range(1, parts):
        value = snap_to_frame(start + (end - start) * step / parts, fps)
        minimum = boundaries[-1] + frame
        maximum = end - (parts - step) * frame
        boundaries.append(max(minimum, min(value, maximum)))
    boundaries.append(end)

    group: list[dict[str, Any]] = []
    for step in range(parts):
        child = copy.deepcopy(source)
        if step > 0:
            child["id"] = next_shot_id(shots + group)
            child["image"] = ""
            child["status"] = "pending"
            child["seed"] = 0
            child["width"] = 0
            child["height"] = 0
            child["imageHistory"] = []
            child["attempts"] = 0
            child["transition"] = {"type": "cut", "durationMs": 300}
        child["startMs"] = boundaries[step]
        child["endMs"] = boundaries[step + 1]
        child["textMode"] = "manual"
        child["text"] = str(source.get("text") or "")
        child["description"] = str(source.get("description") or "")
        child.pop("review", None)
        _beat(child, source, step + 1, parts)
        group.append(child)

    result = shots[:index] + group + shots[index + 1:]
    normalize_timeline(result, duration_ms, fps)
    for step, child in enumerate(group):
        mark_review(child, prompt=True, image=step > 0, reason="split")
    return result


def summary(shots: list[dict[str, Any]]) -> dict[str, Any]:
    total = sum(max(0, int(shot["endMs"]) - int(shot["startMs"])) for shot in shots)
    ready = sum(1 for shot in shots if shot.get("status") == "ready")
    review = sum(1 for shot in shots if isinstance(shot.get("review"), dict)
                 and (shot["review"].get("prompt") or shot["review"].get("image")))
    return {
        "count": len(shots),
        "durationMs": total,
        "readyCount": ready,
        "pendingCount": len(shots) - ready,
        "reviewCount": review,
    }
