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
from . import prompts, store
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


def shot_anchor_refs(project: dict[str, Any], shot: dict[str, Any], *,
                     respect_anchor: bool = True) -> list[dict[str, Any]]:
    """收集本段引用且有设定图的资产，返回 [{id,kind,name,desc,data}]。

    顺序与 ``prompts.used_entity_ids`` 一致，保证「图2..N」在提示词、
    身份校准和 LLM 读图三处完全对应。
    """
    content = (project.get("locks") or {}).get("content") or {}
    if respect_anchor and (not content.get("enabled", True)
                           or not content.get("imageAnchor", True)):
        return []
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    refs: list[dict[str, Any]] = []
    for entity_id in prompts.used_entity_ids(project, shot):
        entity = entities.get(entity_id)
        if not entity:
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
                "name": str(entity.get("name") or "") or entity_id,
                "desc": str(entity.get("desc") or ""),
                "data": data,
            })
        if len(refs) >= ANCHOR_MAX_REFS:
            break
    return refs


def _used_locations(project: dict[str, Any], shot: dict[str, Any]) -> set[str]:
    content = (project.get("locks") or {}).get("content") or {}
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    return {
        entity_id for entity_id in prompts.used_entity_ids(project, shot)
        if str(entities.get(entity_id, {}).get("kind") or "") == "location"
    }


def _previous_base(project: dict[str, Any], shot: dict[str, Any]) -> bytes | None:
    """上一镜有画面且与本段同场景时，可作为单段锚定的图1（锁动作）。"""
    shots = project.get("shots") or []
    index = next((i for i, item in enumerate(shots) if item.get("id") == shot.get("id")), -1)
    if index <= 0:
        return None
    previous = shots[index - 1]
    if not str(previous.get("image") or "").strip():
        return None
    current_locations = _used_locations(project, shot)
    if current_locations:
        previous_locations = _used_locations(project, previous)
        if not (current_locations & previous_locations):
            return None
    try:
        return store.read_media(project["id"], str(previous["image"])).read_bytes()
    except (StudioError, OSError):
        return None


def _scene_ref(project: dict[str, Any], shot: dict[str, Any]) -> dict[str, Any] | None:
    """本段引用的场景资产 + 第一张定场图，用作单段锚定的图1。"""
    content = (project.get("locks") or {}).get("content") or {}
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    for entity_id in prompts.used_entity_ids(project, shot):
        entity = entities.get(entity_id) or {}
        if str(entity.get("kind") or "") != "location":
            continue
        files = [str(item) for item in (entity.get("refImages") or []) if str(item or "")]
        if not files:
            continue
        try:
            data = store.read_media(project["id"], files[0]).read_bytes()
        except (StudioError, OSError):
            continue
        return {
            "id": entity_id,
            "kind": "location",
            "name": str(entity.get("name") or "") or entity_id,
            "desc": str(entity.get("desc") or ""),
            "data": data,
        }
    return None


def anchor_plan(project: dict[str, Any], shot: dict[str, Any]) -> dict[str, Any]:
    """选锚定方式。

    - previous：图1=上一镜，动作/机位继承，只换脸（只适合同机位延续，显式选择）；
    - scene：图1=场景定场图，图2..=人物，单段合成，动作按文字；
    - two-pass：先文生图定动作，再做身份校准，最稳但慢；
    - auto：有场景定场图就走 scene，否则 two-pass（不自动用上一镜，避免每镜同机位）。
    """
    content = (project.get("locks") or {}).get("content") or {}
    if not content.get("enabled", True) or not content.get("imageAnchor", True):
        return {"mode": "none", "refs": []}
    refs = shot_anchor_refs(project, shot)
    if not refs:
        return {"mode": "none", "refs": []}
    subjects = [ref for ref in refs if ref["kind"] != "location"]
    if not subjects:
        return {"mode": "none", "refs": refs}
    mode = str(content.get("anchorMode") or "auto")
    if mode not in ("auto", "scene", "previous", "two-pass"):
        mode = "auto"
    if mode == "previous":
        base = _previous_base(project, shot)
        if base:
            return {"mode": "previous", "base": base, "refs": subjects}
        mode = "auto"
    if mode in ("auto", "scene"):
        scene = _scene_ref(project, shot)
        if scene:
            return {"mode": "scene", "scene": scene, "refs": subjects}
    return {"mode": "two-pass", "refs": refs}


def _asset_lines(refs: list[dict[str, Any]], *, start: int = 2) -> list[str]:
    """把资产映射成「图2、图3：人物小林」；同一资产的多张设定图合并。"""
    groups: list[dict[str, Any]] = []
    for index, ref in enumerate(refs, start=start):
        if groups and groups[-1]["id"] == ref["id"]:
            groups[-1]["images"].append(index)
        else:
            groups.append({"id": ref["id"], "ref": ref, "images": [index]})
    lines: list[str] = []
    for group in groups:
        ref = group["ref"]
        kind = KIND_LABEL.get(str(ref.get("kind")), "主体")
        desc = str(ref.get("desc") or "").strip()
        detail = f"（固定外观：{desc}）" if desc else ""
        features = KIND_FEATURES.get(str(ref.get("kind")), "外观特征")
        labels = "、".join(f"图{index}" for index in group["images"])
        lines.append(f"- {labels}：{kind}「{ref['name']}」{detail}，保持{features}一致。")
    return lines


def build_scene_anchor_prompt(project: dict[str, Any], shot: dict[str, Any],
                             scene: dict[str, Any], refs: list[dict[str, Any]]) -> str:
    lines = [
        f"以图1为场景底图：保持「{scene['name']}」的空间结构、陈设、材质、光线、"
        "色调与镜头机位不变。把以下资产放入图1场景中，保持其固定外观：",
    ]
    lines.extend(_asset_lines(refs))
    action = prompts.strip_asset_mentions(
        " ".join(item for item in [shot.get("description"), shot.get("directive")] if item))
    if action:
        lines.append(f"画面内容与动作：{action}")
    lines.append("人物动作与位置按上面的画面内容决定；不新增图1中不存在的空间结构，"
                 "不改变画幅与场景布局。")
    return "\n".join(lines)


def build_previous_anchor_prompt(project: dict[str, Any], shot: dict[str, Any],
                                 refs: list[dict[str, Any]]) -> str:
    lines = [
        "以图1为上一镜画面：保持它的构图、机位、景别、人物位置与姿态、动作、"
        "光影、背景和所有非主体细节不变。只把人物外观替换为以下资产：",
    ]
    lines.extend(_asset_lines(refs))
    action = prompts.strip_asset_mentions(
        " ".join(item for item in [shot.get("description"), shot.get("directive")] if item))
    if action:
        lines.append(f"如果本段需要动作/表情变化，按此小幅调整：{action}；"
                     "但不要改变镜头机位与场景。")
    lines.append("只替换人物身份特征，不新增、不删除任何元素，不改变画幅。")
    return "\n".join(lines)


def _edit_payload(project: dict[str, Any], shot: dict[str, Any],
                  images_payload: list[dict[str, Any]], prompt: str,
                  *, seed: int = 0, mode: str = "anchor") -> dict[str, Any]:
    image_cfg = project.get("image") or {}
    payload: dict[str, Any] = {
        "prompt": prompt,
        "negative_prompt": str(shot.get("negative") or "").strip(),
        "images": images_payload,
        "size_mode": "follow",
        "seed": int(seed or 0),
        "steps": int(image_cfg.get("steps") or 8),
        "cfg": float(image_cfg.get("cfg") or 1.0),
        "meta": {
            "source": "video_studio",
            "anchor": mode,
            "projectId": project.get("id"),
            "shotId": shot.get("id"),
        },
    }
    model = str(image_cfg.get("model") or "").strip()
    if model:
        payload["model"] = model
    if image_cfg.get("turbo"):
        payload["turbo"] = {"enabled": True}
    return payload


def build_scene_anchor_payload(project: dict[str, Any], shot: dict[str, Any],
                               scene: dict[str, Any], refs: list[dict[str, Any]],
                               *, seed: int = 0) -> dict[str, Any]:
    images_payload = [{"data": _data_url(scene["data"])}]
    images_payload.extend({"data": _data_url(ref["data"])} for ref in refs)
    payload = _edit_payload(
        project, shot, images_payload,
        build_scene_anchor_prompt(project, shot, scene, refs), seed=seed, mode="scene")
    payload["meta"]["entities"] = [scene["id"], *dict.fromkeys(ref["id"] for ref in refs)]
    return payload


def build_previous_anchor_payload(project: dict[str, Any], shot: dict[str, Any],
                                  base_image: bytes, refs: list[dict[str, Any]],
                                  *, seed: int = 0) -> dict[str, Any]:
    images_payload = [{"data": _data_url(base_image)}]
    images_payload.extend({"data": _data_url(ref["data"])} for ref in refs)
    payload = _edit_payload(
        project, shot, images_payload,
        build_previous_anchor_prompt(project, shot, refs), seed=seed, mode="previous")
    payload["meta"]["entities"] = list(dict.fromkeys(ref["id"] for ref in refs))
    return payload


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
    """把底稿与资产设定图一起提交给 /api/edit。

    参数对应关系（不要改顺序）：
    - images[0] = 本段底稿，决定画布尺寸与构图，对应提示词里的「图1」；
    - images[1..] = 资产设定图，按 refs 顺序对应「图2、图3…」；
    - size_mode=follow：跟底稿尺寸，不额外传 width/height，避免二次缩放。
    """
    image_cfg = project.get("image") or {}
    images_payload = [{"data": _data_url(base_image)}]
    images_payload.extend({"data": _data_url(ref["data"])} for ref in refs)
    payload: dict[str, Any] = {
        "prompt": build_anchor_prompt(refs),
        "negative_prompt": str(shot.get("negative") or "").strip(),
        "images": images_payload,
        "size_mode": "follow",
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
    model = str(image_cfg.get("model") or "").strip()
    if model:
        payload["model"] = model
    if image_cfg.get("turbo"):
        payload["turbo"] = {"enabled": True}
    return payload


def build_asset_payload(project: dict[str, Any], entity: dict[str, Any], *,
                        attempt: int = 0) -> dict[str, Any]:
    """资产设定图走纯文生图：不传 images，避免把分镜底稿带进来。"""
    image_cfg = project.get("image") or {}
    style = (project.get("locks") or {}).get("style") or {}
    width, height = prompts.asset_size(entity)
    seed_base = int(style.get("seedBase") or 0)
    entity_id = str(entity.get("id") or "asset")
    seed = (seed_base + sum(ord(ch) for ch in entity_id) + attempt * 13) % 2147483647
    payload: dict[str, Any] = {
        "prompt": prompts.asset_prompt(project, entity),
        "negative_prompt": prompts.asset_negative(project, entity),
        "width": width,
        "height": height,
        "seed": seed,
        "steps": int(image_cfg.get("steps") or 8),
        "cfg": float(image_cfg.get("cfg") or 1.0),
        "batch": 1,
        "meta": {
            "source": "video_studio",
            "asset": True,
            "projectId": project.get("id"),
            "entityId": entity_id,
        },
    }
    model = str(image_cfg.get("model") or "").strip()
    if model:
        payload["model"] = model
    if image_cfg.get("turbo"):
        payload["turbo"] = {"enabled": True}
    return payload


def generate_asset(project: dict[str, Any], entity: dict[str, Any], client: MainClient, *,
                   attempt: int = 0, cancel: CancelFn | None = None,
                   progress: ProgressFn | None = None) -> str:
    """用文字生成一张资产设定图，追加到该资产并返回相对路径。"""
    payload = build_asset_payload(project, entity, attempt=attempt)
    if not payload["prompt"]:
        raise StudioError("该资产还没有名称或外观描述，无法生成设定图",
                          code="empty_asset")
    job_id = client.generate(payload)
    job = _wait(client, job_id, cancel=cancel, progress=progress)
    status = str(job.get("status") or "")
    if status == "canceled":
        raise CanceledError()
    if status != "done":
        raise StudioError(str(job.get("error") or "资产设定图生成失败"),
                          code="asset_generate_failed")
    items = job.get("images") or []
    if not items:
        raise StudioError("主项目没有返回资产图片", code="asset_generate_failed")
    meta = items[0]
    data = client.download(str(meta.get("url") or meta.get("thumb_url") or ""))
    suffix = Path(str(meta.get("filename") or "asset.png")).suffix or ".png"
    relpath = store.save_asset_image(
        project["id"], str(entity.get("id") or "asset"), data, suffix)
    refs = entity.setdefault("refImages", [])
    if relpath not in refs:
        refs.append(relpath)
    while len(refs) > 4:
        victim = refs.pop(0)
        store.delete_media(project["id"], victim)
    return relpath


def _run_edit(client: MainClient, payload: dict[str, Any], *,
              cancel: CancelFn | None,
              progress: ProgressFn | None) -> tuple[bytes, dict[str, Any], str]:
    """提交 /api/edit 并等结果，返回 (图片字节, job 图片元数据, job_id)。"""
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


def _anchor_shot(project: dict[str, Any], shot: dict[str, Any], client: MainClient,
                 base_image: bytes, refs: list[dict[str, Any]], *, seed: int,
                 cancel: CancelFn | None,
                 progress: ProgressFn | None) -> tuple[bytes, dict[str, Any], str]:
    """拿底稿 + 资产设定图再跑一次身份校准。"""
    payload = build_anchor_payload(project, shot, base_image, refs, seed=seed)
    return _run_edit(client, payload, cancel=cancel, progress=progress)


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
    seed = int(payload.get("seed") or 0)

    def stage_progress(start: int, span: int) -> ProgressFn:
        def report(value: int, label: str) -> None:
            if progress is not None:
                progress(start + int(value * span / 100), label)
        return report

    # 单段锚定：场景底图 / 上一镜画面直接当图1，只跑一次图生图
    plan = anchor_plan(project, shot)
    if plan["mode"] in ("scene", "previous"):
        label = "场景锚定" if plan["mode"] == "scene" else "上一镜延续"
        if progress is not None:
            progress(2, label)
        try:
            if plan["mode"] == "scene":
                edit_payload = build_scene_anchor_payload(
                    project, shot, plan["scene"], plan["refs"], seed=seed)
            else:
                edit_payload = build_previous_anchor_payload(
                    project, shot, plan["base"], plan["refs"], seed=seed)
            data, meta, job_id = _run_edit(
                client, edit_payload, cancel=cancel, progress=stage_progress(0, 100))
            suffix = Path(str(meta.get("filename") or "shot.png")).suffix or ".png"
            relpath = store.save_shot_image(
                project["id"], str(shot.get("id") or "shot"), data, suffix)
            shot["image"] = relpath
            shot["status"] = "ready"
            shot["seed"] = seed
            shot["width"] = int(meta.get("width") or 0)
            shot["height"] = int(meta.get("height") or 0)
            record_image_version(
                project["id"], shot, relpath,
                seed=seed, width=shot["width"], height=shot["height"],
                job_id=job_id, source=f"anchor-{plan['mode']}",
            )
            return shot
        except CanceledError:
            shot["status"] = "pending"
            raise
        except (StudioError, OSError) as exc:
            shot.setdefault("warnings", []).append(f"{label}失败，已回退两段式：{exc}")

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
