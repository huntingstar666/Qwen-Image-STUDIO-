"""生图调度：通过 HTTP 调主项目，不 import 其业务代码。

* 串行提交，一次一个任务，避免显存被并发抢空；
* 轮询 ``/api/jobs/{id}``，把主项目进度映射到本工作台；
* 生成结果下载到项目目录，成片渲染不依赖主项目在线；
* 断点续跑：只处理 ``status != ready`` 的镜头段。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .. import config
from . import store
from .errors import CanceledError, MainProjectError, StudioError

TERMINAL = ("done", "error", "canceled")
#: 每段保留的图片版本上限（超出删最旧文件）
MAX_IMAGE_VERSIONS = 8
ProgressFn = Callable[[int, str], None]
CancelFn = Callable[[], bool]


def record_image_version(project_id: str, shot: dict[str, Any], file: str, *,
                         seed: int = 0, width: int = 0, height: int = 0,
                         job_id: str = "", source: str = "generate") -> None:
    """把一版图片记入 shot.imageHistory，并裁掉超限的最旧文件。"""
    from .schema import now_text
    history = [dict(item) for item in (shot.get("imageHistory") or [])]
    history = [item for item in history if item.get("file") != file]
    history.insert(0, {
        "file": file,
        "seed": int(seed or 0),
        "at": now_text(),
        "jobId": str(job_id or ""),
        "width": int(width or 0),
        "height": int(height or 0),
        "source": str(source or "generate"),
    })
    victims: list[str] = []
    while len(history) > MAX_IMAGE_VERSIONS:
        oldest = history.pop()
        old_file = str(oldest.get("file") or "")
        if old_file and old_file != shot.get("image"):
            victims.append(old_file)
    shot["imageHistory"] = history
    for victim in victims:
        store.delete_media(project_id, victim)
    # 有新画面了，图片待确认标记自动解除
    from .segments import clear_review
    clear_review(shot, ["image"])


class MainClient:
    """主项目 HTTP 客户端。"""

    def __init__(self, base_url: str | None = None, *, timeout: float = 60.0) -> None:
        self.base_url = (base_url or config.MAIN_BASE).rstrip("/")
        self.timeout = timeout

    # -- 基础 -------------------------------------------------------------
    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None,
                 *, timeout: float | None = None, raw: bool = False) -> Any:
        data = None
        headers: dict[str, str] = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers,
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                body = response.read()
                return body if raw else json.loads(body.decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise MainProjectError(f"主项目 {method} {path} 返回 {exc.code}：{detail}",
                                   code="main_error") from exc
        except urllib.error.URLError as exc:
            raise MainProjectError(
                f"主项目不可达：{self.base_url}（{exc.reason}）。请先启动主工作台。") from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/api/health", timeout=8.0)

    def options(self) -> dict[str, Any]:
        return self._request("GET", "/api/options", timeout=30.0)

    def download(self, url: str) -> bytes:
        target = url if str(url).startswith("http") else self.base_url + str(url)
        # 主项目的文件名带提示词前缀，常含中文；URL 必须先百分号编码，否则
        # http.client 会抛 UnicodeEncodeError（'ascii' codec ...）
        target = urllib.parse.quote(target, safe=":/?&=%#[]@!$'()*+,;~-._")
        request = urllib.request.Request(target, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=120.0) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise MainProjectError(f"下载生成结果失败：{exc}", code="download_failed") from exc

    # -- 生图 -------------------------------------------------------------
    def generate(self, payload: dict[str, Any]) -> str:
        data = self._request("POST", "/api/generate", payload, timeout=60.0)
        job_id = str(data.get("job_id") or "")
        if not job_id:
            raise MainProjectError(f"主项目没有返回任务 id：{data}", code="main_error")
        return job_id

    def job(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/jobs/{job_id}", timeout=30.0)

    def cancel(self, job_id: str) -> None:
        try:
            self._request("POST", f"/api/jobs/{job_id}/cancel", {}, timeout=10.0)
        except MainProjectError:
            pass


# --------------------------------------------------------------------------- 尺寸


def _round32(value: float) -> int:
    return max(256, int(round(value / 32.0)) * 32)


def image_size(project: dict[str, Any]) -> tuple[int, int]:
    """按项目画布比例算出出图宽高（长边不超过 IMAGE_MAX_SIDE）。"""
    canvas = project.get("canvas") or {}
    ratio_text = str(canvas.get("ratio") or "16:9")
    from .schema import RATIOS
    ratio = float(RATIOS.get(ratio_text) or 16 / 9)
    long_side = config.IMAGE_MAX_SIDE
    if ratio >= 1:
        width, height = long_side, long_side / ratio
    else:
        width, height = long_side * ratio, long_side
    return _round32(width), _round32(height)


def canvas_size(project: dict[str, Any]) -> tuple[int, int]:
    """导出画布尺寸：按比例把长边收在 480~3840，宽高都取偶数（H.264 要求）。"""
    canvas = project.get("canvas") or {}
    from .schema import RATIOS
    ratio = float(RATIOS.get(str(canvas.get("ratio") or "16:9")) or 16 / 9)
    long_side = min(3840, max(480, int(canvas.get("longSide") or 1920)))
    if ratio >= 1:
        width, height = long_side, long_side / ratio
    else:
        width, height = long_side * ratio, long_side
    width = max(320, int(round(width / 2.0)) * 2)
    height = max(240, int(round(height / 2.0)) * 2)
    return width, height


# --------------------------------------------------------------------------- 生成


def build_payload(project: dict[str, Any], shot: dict[str, Any], *, attempt: int = 0) -> dict[str, Any]:
    width, height = image_size(project)
    image_cfg = project.get("image") or {}
    style = (project.get("locks") or {}).get("style") or {}
    seed_base = int(style.get("seedBase") or 0)
    seed = int(shot.get("seed") or 0)
    if seed <= 0:
        seed = (seed_base + int(shot.get("index") or 0) * 97 + attempt * 13) % 2147483647
    payload: dict[str, Any] = {
        "prompt": str(shot.get("prompt") or "").strip(),
        "negative_prompt": str(shot.get("negative") or "").strip(),
        "model": str(image_cfg.get("model") or "qwen"),
        "width": width,
        "height": height,
        "seed": seed,
        "steps": int(image_cfg.get("steps") or 8),
        "cfg": float(image_cfg.get("cfg") or 1.0),
        "batch": 1,
        "meta": {"source": "video_studio", "projectId": project.get("id"),
                 "shotId": shot.get("id")},
    }
    if image_cfg.get("turbo"):
        payload["turbo"] = {"enabled": True}
    lora = style.get("consistency") or {}
    if str(lora.get("name") or "").strip():
        payload["consistency_lora"] = {
            "name": str(lora.get("name")).strip(),
            "strength": float(lora.get("strength") or 1.0),
        }
    return payload


def _wait(client: MainClient, job_id: str, *, cancel: CancelFn | None = None,
          progress: ProgressFn | None = None, timeout: float = 1800.0) -> dict[str, Any]:
    started = time.time()
    while True:
        if cancel is not None and cancel():
            client.cancel(job_id)
            raise CanceledError()
        job = client.job(job_id)
        status = str(job.get("status") or "")
        info = job.get("progress") or {}
        value = int(info.get("value") or 0)
        maximum = max(1, int(info.get("max") or 1))
        label = str(info.get("label") or "")
        if progress is not None:
            # 每次都上报：主项目同一 label 下 value 会变，不刷新进度条会卡住
            progress(int(value * 100 / maximum), label or "生成中")
        if status in TERMINAL:
            return job
        if time.time() - started > timeout:
            client.cancel(job_id)
            raise MainProjectError("主项目生成超时（30 分钟）", code="main_timeout")
        time.sleep(0.6)


def generate_shot(project: dict[str, Any], shot: dict[str, Any], client: MainClient, *,
                  attempt: int = 0, cancel: CancelFn | None = None,
                  progress: ProgressFn | None = None) -> dict[str, Any]:
    """生成单个镜头段并把图片落到项目目录。返回更新后的 shot。"""
    payload = build_payload(project, shot, attempt=attempt)
    if not payload["prompt"]:
        raise StudioError("该镜头还没有提示词，先生成提示词或手动填写",
                          code="empty_prompt")
    shot["status"] = "generating"
    shot["attempts"] = int(shot.get("attempts") or 0) + 1
    job_id = client.generate(payload)
    job = _wait(client, job_id, cancel=cancel, progress=progress)
    if str(job.get("status")) == "canceled":
        shot["status"] = "pending"
        raise CanceledError()
    if str(job.get("status")) != "done":
        shot["status"] = "failed"
        raise StudioError(str(job.get("error") or "生成失败"), code="generate_failed")
    images = job.get("images") or []
    if not images:
        shot["status"] = "failed"
        raise StudioError("主项目没有返回图片", code="generate_failed")
    meta = images[0]
    data = client.download(str(meta.get("url") or meta.get("thumb_url") or ""))
    suffix = Path(str(meta.get("filename") or "shot.png")).suffix or ".png"
    relpath = store.save_shot_image(project["id"], str(shot.get("id") or "shot"), data, suffix)
    shot["image"] = relpath
    shot["status"] = "ready"
    shot["seed"] = int(payload.get("seed") or 0)
    shot["width"] = int(meta.get("width") or 0)
    shot["height"] = int(meta.get("height") or 0)
    record_image_version(
        project["id"], shot, relpath,
        seed=shot["seed"], width=shot["width"], height=shot["height"],
        job_id=job_id, source="generate",
    )
    return shot


def pending_shots(project: dict[str, Any], shot_ids: list[str] | None = None) -> list[dict[str, Any]]:
    shots = project.get("shots") or []
    if shot_ids:
        wanted = set(shot_ids)
        return [shot for shot in shots if shot.get("id") in wanted]
    return [shot for shot in shots if shot.get("status") != "ready"]
