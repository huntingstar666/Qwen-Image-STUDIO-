"""animation_kit（8710）服务客户端：去抖动 / 去闪烁 / 多格式导出。

设计原则：**按需调用**。still_loop 默认用自己的进程内编码器（无网络依赖），
只有用户显式打开「去抖动」或「去闪烁」时才走这里；服务不可用时抛出
``AnimServiceUnavailable``，由 runner 回退到本地导出并把原因写进 run。
"""
from __future__ import annotations

import base64
import io
import json
import time
import urllib.error
import urllib.request
from typing import Any

from PIL import Image

from .. import config


class AnimServiceUnavailable(RuntimeError):
    """8710 没起、超时或返回异常；调用方应回退本地导出。"""


class AnimExportFailed(RuntimeError):
    """服务可用但导出失败（例如格式不支持、帧解码失败）。"""


def _request(path: str, payload: dict[str, Any] | None = None,
             timeout: float = 8.0) -> dict[str, Any]:
    url = f"{config.ANIM_BASE.rstrip('/')}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers,
                                     method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        raise AnimExportFailed(f"animation_kit {path} HTTP {exc.code}: {body}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AnimServiceUnavailable(f"animation_kit 不可用：{exc}") from exc


def available(timeout: float = 1.5) -> bool:
    try:
        _request("/api/projects", timeout=timeout)
        return True
    except (AnimServiceUnavailable, AnimExportFailed):
        return False


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGBA").save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def stabilize_and_export(images: list[Image.Image], *, fps: int, fmt: str,
                         align: bool, color_match: bool, dither: bool = True,
                         name: str = "still_loop", timeout: float = 180.0) -> dict[str, Any]:
    """把帧交给 8710：建项目 → 导入 → 对齐/调色 → 导出，返回二进制和报告。"""
    created = _request("/api/projects", {
        "name": name,
        "timeline": {"fps": max(1, int(fps)), "loop": 0, "direction": "forward"},
        "canvas": {"width": images[0].width, "height": images[0].height,
                   "background": "", "fit": "pad"},
    })
    project_id = str((created.get("project") or {}).get("id") or "")
    if not project_id:
        raise AnimExportFailed("animation_kit 未返回 project id")

    imported = _request("/api/import/frames", {
        "projectId": project_id,
        "import": {"fit": "pad", "anchor": "center", "replace": True},
        "images": [
            {"name": f"frame-{index + 1:02d}",
             "data": base64.b64encode(_png_bytes(image)).decode("ascii")}
            for index, image in enumerate(images)
        ],
    }, timeout=60.0)
    if len((imported.get("frames") or [])) != len(images):
        raise AnimExportFailed("导入后帧数不一致")

    align_report = color_report = None
    if align:
        align_report = _request("/api/align", {"projectId": project_id}, timeout=60.0)
    if color_match:
        color_report = _request("/api/color-match", {"projectId": project_id}, timeout=60.0)

    submitted = _request("/api/export", {
        "projectId": project_id,
        "format": fmt,
        "options": {"dither": bool(dither)} if fmt == "gif" else {},
    })
    job_id = str(submitted.get("job_id") or "")
    if not job_id:
        raise AnimExportFailed("animation_kit 未返回 job_id")

    started = time.time()
    job: dict[str, Any] = {}
    while time.time() - started < timeout:
        job = _request(f"/api/jobs/{job_id}", timeout=10.0)
        if job.get("status") in ("done", "failed", "canceled"):
            break
        time.sleep(0.4)
    if job.get("status") != "done":
        raise AnimExportFailed(f"导出任务未完成：{job.get('status')} {job.get('error') or ''}".strip())

    result = job.get("result") or {}
    url = str(result.get("url") or "")
    if not url:
        raise AnimExportFailed("导出任务没有返回文件地址")
    full = url if url.startswith("http") else f"{config.ANIM_BASE.rstrip('/')}{url}"
    with urllib.request.urlopen(full, timeout=60.0) as response:
        blob = response.read()
    return {
        "blob": blob,
        "ext": str(result.get("ext") or fmt),
        "pixel_exact": result.get("pixel_exact"),
        "resampled_ids": result.get("resampled_ids") or [],
        "warnings": result.get("warnings") or [],
        "align": (align_report or {}).get("report"),
        "color": (color_report or {}).get("report"),
        "project_id": project_id,
    }
