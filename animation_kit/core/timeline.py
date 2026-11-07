"""时间轴：停顿（hold）、逐帧时长、乒乓循环与 GIF 厘秒取整。

语义与前端播放器保持一致：

* ``duration`` 为 0 时使用 ``1000 / fps``；
* ``hold = N`` 表示这一帧曝光 N 次，每次 ``duration`` 毫秒（定格动画的“拍 N 格”）；
* ``direction = pingpong`` 时序列为 ``0,1,2,…,n-2``（首尾不重复）；
* GIF 时长按 10ms 取整，并受 ``minMs`` 下限约束。
"""
from __future__ import annotations

import math
from typing import Any


def frame_duration(frame: dict[str, Any], fps: int) -> int:
    duration = int(frame.get("duration") or 0)
    if duration > 0:
        return duration
    return max(10, int(round(1000.0 / max(1, int(fps)))))


def hold_of(frame: dict[str, Any]) -> int:
    return max(1, int(frame.get("hold") or 1))


def expanded_sequence(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """把文档展开成逐次曝光序列（供播放器与导出共用）。"""
    timeline = doc.get("timeline") or {}
    fps = max(1, int(timeline.get("fps") or 12))
    direction = str(timeline.get("direction") or "forward")
    frames = [frame for frame in (doc.get("frames") or []) if frame.get("visible", True)]
    if not frames:
        return []

    order = list(range(len(frames)))
    if direction == "pingpong" and len(order) > 2:
        order = order + order[-2:0:-1]

    sequence: list[dict[str, Any]] = []
    for frame_index in order:
        frame = frames[frame_index]
        duration = frame_duration(frame, fps)
        hold = hold_of(frame)
        for repeat in range(hold):
            sequence.append({
                "frameId": str(frame.get("id") or ""),
                "frameIndex": frame_index,
                "duration": duration,
                "holdIndex": repeat,
                "holdTotal": hold,
            })
    return sequence


def gif_durations(sequence: list[dict[str, Any]], *, min_ms: int = 20,
                  step: int = 10) -> list[int]:
    """GIF 以 10ms 为单位；太短的帧浏览器会自行改写，所以给一个下限。"""
    step = max(1, int(step))
    min_ms = max(step, int(min_ms))
    out: list[int] = []
    for item in sequence:
        value = int(item.get("duration") or min_ms)
        # 四舍五入到最近一档（不用 Python 的银行家舍入）
        value = max(min_ms, int(math.floor(value / step + 0.5)) * step)
        out.append(value)
    return out


def summary(doc: dict[str, Any]) -> dict[str, Any]:
    sequence = expanded_sequence(doc)
    total = sum(int(item["duration"]) for item in sequence)
    visible = [frame for frame in (doc.get("frames") or []) if frame.get("visible", True)]
    return {
        "frameCount": len(doc.get("frames") or []),
        "visibleCount": len(visible),
        "exposureCount": len(sequence),
        "durationMs": total,
        "durationSec": round(total / 1000.0, 3),
        "fps": int((doc.get("timeline") or {}).get("fps") or 12),
        "direction": (doc.get("timeline") or {}).get("direction") or "forward",
        "loop": int((doc.get("timeline") or {}).get("loop") or 0),
    }
