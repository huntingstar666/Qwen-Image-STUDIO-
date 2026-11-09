"""生图调度：通过 HTTP 调主项目，不 import 其业务代码。

* 串行提交，一次一个任务，避免显存被并发抢空；
* 轮询 ``/api/jobs/{id}``，把主项目进度映射到本工作台；
* 生成结果下载到项目目录，成片渲染不依赖主项目在线；
* 断点续跑：只处理 ``status != ready`` 的镜头段。
"""
from __future__ import annotations

import base64
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

    def edit(self, payload: dict[str, Any]) -> str:
        """提交参考图编辑任务（资产锚定用）。"""
        data = self._request("POST", "/api/edit", payload, timeout=120.0)
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


# --------------------------------------------------------------------------- 资产图片锚定

#: 一次编辑最多带几张资产参考图（不含底稿）
ANCHOR_MAX_REFS = 4
KIND_LABEL = {"character": "人物", "location": "场景", "prop": "道具"}
KIND_FEATURES = {
    "character": "脸型、五官、发型、服装与配饰",
    "location": "空间结构、材质、陈设与光线",
    "prop": "造型、材质、颜色与磨损细节",
}


def _data_url(data: bytes) -> str:
    """把图片字节转成主项目 /api/edit 能识别的 data URL。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        mime = "image/png"
    elif data[:2] == b"\xff\xd8":
        mime = "image/jpeg"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def shot_anchor_refs(project: dict[str, Any], shot: dict[str, Any]) -> list[dict[str, Any]]:
    """收集本段引用且有设定图的资产，返回 [{id,kind,name,desc,data}]。"""
    content = (project.get("locks") or {}).get("content") or {}
    if not content.get("enabled", True) or not content.get("imageAnchor", True):
        return []
    entities = content.get("entities") or []
    used = {str(item) for item in (shot.get("usedEntities") or [])}
    text = f"{shot.get('text') or ''} {shot.get('prompt') or ''}"
    refs: list[dict[str, Any]] = []
    for entity in entities:
        entity_id = str(entity.get("id") or "")
        if not entity_id:
            continue
        name = str(entity.get("name") or "")
        # 老项目没有 usedEntities 时按名字回退匹配
        if used:
            if entity_id not in used:
                continue
        elif not name or name not in text:
            continue
        files = [str(item) for item in (entity.get("refImages") or []) if str(item or "")]
        for file in files:
            if len(refs) >= ANCHOR_MAX_REFS:
                break
            try:
                data = store.read_media(project["id"], file).read_bytes()
            except (StudioError, OSError):
                continue
            refs.append({
                "id": entity_id,
                "kind": str(entity.get("kind") or "character"),
                "name": name or entity_id,
                "desc": str(entity.get("desc") or ""),
                "data": data,
            })
        if len(refs) >= ANCHOR_MAX_REFS:
            break
    return refs


def build_anchor_prompt(refs: list[dict[str, Any]]) -> str:
    """身份校准指令：底稿不动，只把主体换成参考图里的同一外观。"""
    lines = [
        "以图1为画面底稿：保持它的构图、机位、景别、内容位置与动作、光影、背景",
        "以及所有非主体细节不变。只做身份校准，让以下主体与对应参考图保持同一外观：",
    ]
    # 同一资产的正面/侧面等多张设定图合并成一条，避免提示词被拆散
    groups: list[dict[str, Any]] = []
    for index, ref in enumerate(refs, start=2):
        if groups and groups[-1]["id"] == ref["id"]:
            groups[-1]["images"].append(index)
        else:
            groups.append({"id": ref["id"], "ref": ref, "images": [index]})
    for group in groups:
        ref = group["ref"]
        kind = KIND_LABEL.get(str(ref.get("kind")), "主体")
        name = str(ref.get("name") or ref.get("id") or "")
        desc = str(ref.get("desc") or "").strip()
        detail = f"（固定外观：{desc}）" if desc else ""
        features = KIND_FEATURES.get(str(ref.get("kind")), "外观特征")
        labels = "、".join(f"图{index}" for index in group["images"])
        lines.append(f"- {labels}：{kind}「{name}」{detail}，保持{features}一致。")
    lines.append("只替换上述主体的身份特征，不新增、不删除任何元素，不改变画幅与画面布局。")
    return "\n".join(lines)


def build_anchor_payload(project: dict[str, Any], shot: dict[str, Any],
                         base_image: bytes, refs: list[dict[str, Any]],
                         *, seed: int = 0) -> dict[str, Any]:
    """把底稿与资产设定图一起提交给 /api/edit。"""
    image_cfg = project.get("image") or {}
    images_payload = [{"data": _data_url(base_image)}]
    images_payload.extend({"data": _data_url(ref["data"])} for ref in refs)
    payload: dict[str, Any] = {
        "prompt": build_anchor_prompt(refs),
        "negative_prompt": str(shot.get("negative") or "").strip(),
        "images": images_payload,
        "seed": int(seed or 0),
        "steps": int(image_cfg.get("steps") or 8),
        "cfg": float(image_cfg.get("cfg") or 1.0),
        "meta": {
            "source": "video_studio",
            "anchor": True,
            "projectId": project.get("id"),
            "shotId": shot.get("id"),
            "entities": list(dict.fromkeys(ref["id"] for ref in refs)),
        },
    }
    if image_cfg.get("turbo"):
        payload["turbo"] = {"enabled": True}
    return payload


def _anchor_shot(project: dict[str, Any], shot: dict[str, Any], client: MainClient,
                 base_image: bytes, refs: list[dict[str, Any]], *, seed: int,
                 cancel: CancelFn | None,
                 progress: ProgressFn | None) -> tuple[bytes, dict[str, Any], str]:
    """拿底稿 + 资产设定图再跑一次身份校准。"""
    payload = build_anchor_payload(project, shot, base_image, refs, seed=seed)
    job_id = client.edit(payload)
    job = _wait(client, job_id, cancel=cancel, progress=progress)
    status = str(job.get("status") or "")
    if status == "canceled":
        raise CanceledError()
    if status != "done":
        raise StudioError(str(job.get("error") or "参考图锚定失败"), code="anchor_failed")
    items = job.get("images") or []
    if not items:
        raise StudioError("参考图锚定没有返回图片", code="anchor_failed")
    meta = items[0]
    data = client.download(str(meta.get("url") or meta.get("thumb_url") or ""))
    return data, meta, job_id


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

    def stage_progress(start: int, span: int) -> ProgressFn:
        def report(value: int, label: str) -> None:
            if progress is not None:
                progress(start + int(value * span / 100), label)
        return report

    job_id = client.generate(payload)
    job = _wait(client, job_id, cancel=cancel, progress=stage_progress(0, 58))
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
    seed = int(payload.get("seed") or 0)

    # 底稿先落一版：锚定失败或不启用时，用户至少还有纯文本生图
    relpath = store.save_shot_image(project["id"], str(shot.get("id") or "shot"), data, suffix)
    shot["image"] = relpath
    shot["status"] = "ready"
    shot["seed"] = seed
    shot["width"] = int(meta.get("width") or 0)
    shot["height"] = int(meta.get("height") or 0)
    record_image_version(
        project["id"], shot, relpath,
        seed=seed, width=shot["width"], height=shot["height"],
        job_id=job_id, source="generate",
    )

    # 资产图锚定：拿底稿 + 角色设定图再跑一次身份校准
    refs = shot_anchor_refs(project, shot)
    anchored = None
    if refs:
        if progress is not None:
            progress(58, f"参考图锚定（{len(refs)} 个资产）")
        try:
            anchored = _anchor_shot(
                project, shot, client, data, refs, seed=seed, cancel=cancel,
                progress=stage_progress(58, 42),
            )
        except CanceledError:
            raise
        except (StudioError, OSError) as exc:
            shot.setdefault("warnings", []).append(f"参考图锚定失败，已保留纯文本版本：{exc}")
            anchored = None
    if anchored is not None:
        anchor_data, anchor_meta, anchor_job = anchored
        anchor_suffix = Path(str(anchor_meta.get("filename") or "shot.png")).suffix or ".png"
        anchor_rel = store.save_shot_image(
            project["id"], str(shot.get("id") or "shot"), anchor_data, anchor_suffix)
        shot["image"] = anchor_rel
        shot["width"] = int(anchor_meta.get("width") or shot["width"])
        shot["height"] = int(anchor_meta.get("height") or shot["height"])
        record_image_version(
            project["id"], shot, anchor_rel,
            seed=seed, width=shot["width"], height=shot["height"],
            job_id=anchor_job, source="anchor",
        )
    return shot


def pending_shots(project: dict[str, Any], shot_ids: list[str] | None = None) -> list[dict[str, Any]]:
    shots = project.get("shots") or []
    if shot_ids:
        wanted = set(shot_ids)
        return [shot for shot in shots if shot.get("id") in wanted]
    return [shot for shot in shots if shot.get("status") != "ready"]
