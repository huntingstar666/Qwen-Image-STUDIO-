"""video_studio HTTP 服务。

只通过 HTTP 调主项目（8700），本服务可独立启停。
"""
from __future__ import annotations

import json
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Iterable

from fastapi import Body, FastAPI, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import config
from ..core import images, media, prompts, render, schema, segments, store, subtitle
from ..core.errors import CanceledError, StudioError
from ..core.tasks import manager as task_manager

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024

config.ensure_dirs()

#: 前端构建标识：文件一变，主项目内嵌页切回时会自动重载 iframe
def _build_id() -> str:
    """按前端文件最后修改时间算构建号；每次请求现算，改完前端不用重启服务。"""
    try:
        stamps = (
            [path.stat().st_mtime for path in (WEB_DIR / "src").glob("*.js")]
            + [path.stat().st_mtime for path in (WEB_DIR / "assets").glob("*.css")]
            + [(WEB_DIR / "index.html").stat().st_mtime]
        )
        return str(int(max(stamps)))
    except (OSError, ValueError):
        return "0"


BUILD_ID = _build_id()

app = FastAPI(title="video_studio", version="0.1.0")

# 主项目内嵌时需要用 fetch 探活（跨端口），只放行本机页面读取
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _no_cache(request: Request, call_next):
    """前端资源禁用强缓存：改完刷新即生效（主项目踩过的坑）。"""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith(("/assets/", "/src/")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock(project_id: str) -> threading.RLock:
    with _locks_guard:
        if project_id not in _locks:
            _locks[project_id] = threading.RLock()
        return _locks[project_id]


@app.exception_handler(StudioError)
def _studio_error(_request: Request, exc: StudioError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": str(exc), "code": exc.code})


# --------------------------------------------------------------------------- 工具


def _view(project: dict[str, Any]) -> dict[str, Any]:
    data = store.public_view(project)
    data["tasks"] = task_manager().active_for(project["id"])
    data["summary"] = segments.summary(project.get("shots") or [])
    return data


def _read_upload(file: UploadFile, limit: int, label: str) -> bytes:
    data = file.file.read()
    if not data:
        raise StudioError(f"{label}为空", code="empty_upload")
    if len(data) > limit:
        raise StudioError(f"{label}过大（上限 {limit // 1024 // 1024}MB）", code="too_large")
    return data


def _shot_of(project: dict[str, Any], shot_id: str) -> dict[str, Any]:
    shot = next((item for item in project.get("shots") or [] if item.get("id") == shot_id), None)
    if shot is None:
        raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
    return shot


def _entity_of(project: dict[str, Any], entity_id: str) -> dict[str, Any]:
    content = ((project.get("locks") or {}).get("content") or {})
    entity = next((item for item in content.get("entities") or []
                   if str(item.get("id")) == entity_id), None)
    if entity is None:
        raise StudioError(f"资产不存在：{entity_id}", code="not_found", status=404)
    return entity


def _shifted_cues(project: dict[str, Any]) -> list[dict[str, Any]]:
    """字幕 cue 平移到音频时间轴（与自动分段同一套偏移规则）。"""
    offset = int((project.get("audio") or {}).get("offsetMs") or 0)
    return [{**cue,
             "startMs": int(cue["startMs"]) + offset,
             "endMs": int(cue["endMs"]) + offset}
            for cue in ((project.get("subtitle") or {}).get("cues") or [])]


def _fps(project: dict[str, Any]) -> int:
    return int((project.get("canvas") or {}).get("fps") or config.FPS)


def _duration(project: dict[str, Any]) -> int:
    return int((project.get("audio") or {}).get("durationMs") or 0)


def _refresh_prompts(project: dict[str, Any], shot_ids: Iterable[str]) -> None:
    """结构变化后只重拼受影响段落的提示词（不调用 LLM）。"""
    wanted = {str(item) for item in shot_ids}
    for shot in project.get("shots") or []:
        if str(shot.get("id")) in wanted:
            shot["prompt"], shot["negative"] = prompts.assemble_prompt(project, shot)


def _silences(project: dict[str, Any]) -> list[tuple[int, int]]:
    """静音区间带缓存（音频换掉时缓存文件会被删除）。"""
    audio = project.get("audio") or {}
    if not str(audio.get("file") or "").strip():
        return []
    cache = store.project_dir(project["id"]) / "audio" / "silences.json"
    if cache.is_file():
        payload = json.loads(cache.read_text(encoding="utf-8"))
        return [(int(item[0]), int(item[1])) for item in payload if isinstance(item, (list, tuple))]
    source = store.read_media(project["id"], str(audio["file"]))
    spans = media.detect_silences(source)
    store.write_bytes(project["id"], "audio", "silences.json",
                      json.dumps(spans, ensure_ascii=False).encode("utf-8"))
    return spans


# --------------------------------------------------------------------------- 健康与元数据


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    main_info: dict[str, Any] = {"reachable": False, "error": ""}
    try:
        health = images.MainClient().health()
        main_info = {
            "reachable": True,
            "url": config.MAIN_BASE,
            "engineReady": bool((health.get("engine") or {}).get("ready")),
            "device": str((health.get("engine") or {}).get("device") or ""),
            "vramFreeMb": int((health.get("engine") or {}).get("vram_free_mb") or 0),
            "queue": health.get("queue") or {},
            "llmModels": list((health.get("llm") or {}).get("models") or []),
            "llmConnected": bool((health.get("llm") or {}).get("connected")),
            "llmModel": str((health.get("llm") or {}).get("model") or ""),
        }
    except StudioError as exc:
        main_info["error"] = str(exc)
    try:
        ffmpeg_ok = bool(media.require_ffmpeg())
    except StudioError:
        ffmpeg_ok = False
    return {
        "ok": True,
        "version": app.version,
        "build": _build_id(),
        "ffmpeg": ffmpeg_ok,
        "main": main_info,
        "llm": prompts.llm_options(),
    }


@app.get("/api/schema")
def api_schema() -> dict[str, Any]:
    return schema.public_schema()


#: 主项目风格库缓存：{at: 时间戳, data: [...]}（风格目录基本不变，缓存 5 分钟）
_STYLE_CACHE: dict[str, Any] = {"at": 0.0, "data": []}


@app.get("/api/styles")
def api_styles() -> dict[str, Any]:
    """代理主项目风格库，前端下拉直接选，选中即写入风格锁前缀。"""
    if time.time() - float(_STYLE_CACHE.get("at") or 0) < 300 and _STYLE_CACHE.get("data"):
        return {"styles": _STYLE_CACHE["data"], "cached": True}
    try:
        data = images.MainClient()._request("GET", "/api/styles", timeout=30.0)
    except StudioError as exc:
        return {"styles": [], "error": str(exc)}
    items = []
    for item in data.get("creative") or []:
        items.append({
            "id": str(item.get("id") or ""),
            "name": str(item.get("name") or ""),
            "category": str(item.get("category") or ""),
            "prompt": str(item.get("prompt") or ""),
            "preview": _main_url(str(item.get("preview") or "")),
        })
    _STYLE_CACHE.update({"at": time.time(), "data": items})
    return {"styles": items, "cached": False}


# --------------------------------------------------------------------------- 项目


@app.get("/api/projects")
def api_projects() -> dict[str, Any]:
    return {"projects": store.list_projects()}


@app.post("/api/projects")
def api_create(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    project = store.create(name)
    return _view(project)


@app.get("/api/projects/{project_id}")
def api_project(project_id: str) -> dict[str, Any]:
    return _view(store.load(project_id))


@app.patch("/api/projects/{project_id}")
def api_patch(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        patch = schema.validate_patch(payload)
    except ValueError as exc:
        raise StudioError(str(exc)) from exc
    with _lock(project_id):
        project = store.load(project_id)
        project = schema.deep_merge(project, patch)
        if "locks" in patch:
            prompts.assemble_all(project)
        store.save(project)
        return _view(project)


@app.delete("/api/projects/{project_id}")
def api_delete(project_id: str) -> dict[str, Any]:
    store.delete(project_id)
    return {"ok": True}


# --------------------------------------------------------------------------- 素材


@app.post("/api/projects/{project_id}/audio")
def api_audio(project_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    ext = media.check_audio_ext(file.filename or "")
    data = _read_upload(file, media.MAX_AUDIO_BYTES, "音频")
    with _lock(project_id):
        project = store.load(project_id)
        original = store.write_bytes(project_id, "audio", f"original{ext}", data)
        source = store.project_dir(project_id) / original
        normalized_rel = "audio/source.m4a"
        info = media.normalize_to_m4a(source, store.project_dir(project_id) / normalized_rel)
        peaks = media.build_peaks(store.project_dir(project_id) / normalized_rel, info["durationMs"])
        peaks_rel = store.write_bytes(project_id, "audio", "peaks.json",
                                      json.dumps(peaks, separators=(",", ":")).encode("utf-8"))
        project["audio"] = {
            "file": normalized_rel,
            "durationMs": int(info["durationMs"]),
            "peaksFile": peaks_rel,
            "offsetMs": int((project.get("audio") or {}).get("offsetMs") or 0),
            "original": original,
            "sampleRate": info.get("sampleRate"),
            "channels": info.get("channels"),
        }
        project["shots"] = []
        project["segments"] = {**(project.get("segments") or {}), "applied": False}
        cache = store.project_dir(project_id) / "audio" / "silences.json"
        if cache.is_file():
            cache.unlink()
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/subtitle")
def api_subtitle(project_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    data = _read_upload(file, MAX_SUBTITLE_BYTES, "字幕")
    with _lock(project_id):
        project = store.load(project_id)
        try:
            parsed = subtitle.parse(data, file.filename or "subtitle.srt")
        except StudioError:
            raise
        ext = ".srt" if parsed["format"] == "srt" else (
            ".vtt" if parsed["format"] == "vtt" else ".ass")
        relpath = store.save_subtitle(project_id, data, ext)
        project["subtitle"] = {"file": relpath, "format": parsed["format"],
                               "cues": parsed["cues"]}
        project["segments"] = {**(project.get("segments") or {}), "applied": False}
        store.save(project)
        return {**_view(project), "cueCount": len(parsed["cues"])}


@app.post("/api/projects/{project_id}/bgm")
def api_bgm(project_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    ext = media.check_audio_ext(file.filename or "", bgm=True)
    data = _read_upload(file, media.MAX_AUDIO_BYTES, "背景音乐")
    with _lock(project_id):
        project = store.load(project_id)
        store.write_bytes(project_id, "audio", f"bgm-original{ext}", data)
        source = store.project_dir(project_id) / "audio" / f"bgm-original{ext}"
        media.normalize_to_m4a(source, store.project_dir(project_id) / "audio" / "bgm.m4a")
        render_cfg = project.setdefault("render", {})
        bgm = render_cfg.setdefault("bgm", {})
        bgm["file"] = "audio/bgm.m4a"
        store.save(project)
        return _view(project)


@app.delete("/api/projects/{project_id}/bgm")
def api_bgm_clear(project_id: str) -> dict[str, Any]:
    with _lock(project_id):
        project = store.load(project_id)
        project.setdefault("render", {}).setdefault("bgm", {})["file"] = ""
        store.save(project)
        return _view(project)


# --------------------------------------------------------------------------- 分段


def _derive(project: dict[str, Any], payload: dict[str, Any]) -> list[dict[str, Any]]:
    cues = ((project.get("subtitle") or {}).get("cues") or [])
    if not cues:
        raise StudioError("还没有字幕，先上传带时间轴的字幕", code="no_subtitle")
    audio = project.get("audio") or {}
    duration = int(audio.get("durationMs") or 0)
    if duration <= 0:
        raise StudioError("还没有音频，先上传音频", code="no_audio")
    offset = int(audio.get("offsetMs") or 0)
    shifted = [{**cue, "startMs": int(cue["startMs"]) + offset,
                "endMs": int(cue["endMs"]) + offset} for cue in cues]
    # 0 是合法值（按停顿分段），不能用 or 兜底
    raw_gap = payload.get("mergeGapMs")
    raw_max = payload.get("maxShotMs")
    merge_gap_ms = int(config.MERGE_GAP_MS if raw_gap is None else raw_gap)
    max_shot_ms = int(config.MAX_SHOT_MS if raw_max is None else raw_max)
    return segments.derive(
        shifted,
        duration_ms=duration,
        fps=int((project.get("canvas") or {}).get("fps") or config.FPS),
        merge_gap_ms=merge_gap_ms,
        max_shot_ms=max_shot_ms,
        silences=_silences(project),
    )


@app.patch("/api/projects/{project_id}/subtitle/cues")
def api_subtitle_cues(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """就地改字幕文案：只替换 cues，不动上传的原字幕文件。"""
    cues = payload.get("cues")
    if not isinstance(cues, list):
        raise StudioError("cues 必须是数组", code="bad_payload")
    cleaned = []
    for index, item in enumerate(cues[:2000]):
        if not isinstance(item, dict):
            raise StudioError(f"cues[{index}] 必须是对象", code="bad_payload")
        try:
            start = int(item.get("startMs") or 0)
            end = int(item.get("endMs") or 0)
        except (TypeError, ValueError):
            raise StudioError(f"cues[{index}] 时间格式不正确", code="bad_payload") from None
        text = str(item.get("text") or "").strip()
        if end <= start or not text:
            continue
        cleaned.append({"startMs": start, "endMs": end, "text": text[:500]})
    cleaned.sort(key=lambda cue: cue["startMs"])
    with _lock(project_id):
        project = store.load(project_id)
        project.setdefault("subtitle", {})["cues"] = cleaned
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/segments/preview")
def api_segments_preview(project_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    with _lock(project_id):
        project = store.load(project_id)
        shots = _derive(project, payload)
        return {"shots": shots, "summary": segments.summary(shots)}


@app.post("/api/projects/{project_id}/segments/apply")
def api_segments_apply(project_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    with _lock(project_id):
        project = store.load(project_id)
        shots = _derive(project, payload)
        preserve = bool(payload.get("preserveImages"))
        if preserve:
            previous = project.get("shots") or []
            for index, shot in enumerate(shots):
                if index >= len(previous):
                    break
                old = previous[index]
                for key in ("image", "status", "seed", "attempts", "description", "note",
                            "negative", "usedEntities"):
                    if old.get(key):
                        shot[key] = old[key]
        project["shots"] = shots
        raw_gap = payload.get("mergeGapMs")
        raw_max = payload.get("maxShotMs")
        project["segments"] = {
            "mergeGapMs": int(config.MERGE_GAP_MS if raw_gap is None else raw_gap),
            "maxShotMs": int(config.MAX_SHOT_MS if raw_max is None else raw_max),
            "applied": True,
        }
        prompts.assemble_all(project)
        store.save(project)
        return _view(project)


@app.patch("/api/projects/{project_id}/shots/{shot_id}")
def api_patch_shot(project_id: str, shot_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        patch = schema.validate_fields(schema.SHOT_FIELDS, payload)
    except ValueError as exc:
        raise StudioError(str(exc)) from exc
    with _lock(project_id):
        project = store.load(project_id)
        shots = project.get("shots") or []
        shot = next((item for item in shots if item.get("id") == shot_id), None)
        if shot is None:
            raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)

        retimed = "startMs" in patch or "endMs" in patch
        before = {str(item.get("id")): max(0, int(item["endMs"]) - int(item["startMs"]))
                  for item in shots}
        before_texts = {str(item.get("id")): str(item.get("text") or "") for item in shots}
        if retimed:
            shots = segments.retime(shots, shot_id, patch, _duration(project), _fps(project))
            shot = next(item for item in shots if item.get("id") == shot_id)
        old_prompt = str(shot.get("prompt") or "")
        for key, value in patch.items():
            if key in ("startMs", "endMs"):
                continue
            if key == "motion":
                shot["motion"] = {**(shot.get("motion") or {}), **value}
            elif key == "transition":
                shot["transition"] = {**(shot.get("transition") or {}), **value}
            else:
                shot[key] = value
        # 手改台词即转为手动模式；显式传 textMode 时以传入值为准
        if "text" in patch and "textMode" not in patch:
            shot["textMode"] = "manual"

        auto_reset = "textMode" in patch and str(patch["textMode"]) == "auto"
        if retimed or auto_reset:
            segments.reconcile_texts(shots, _shifted_cues(project))
            # 台词跟着边界变了，受影响段的提示词要一起重拼
            for item in shots:
                if str(item.get("text") or "") != before_texts.get(str(item.get("id"))):
                    item["prompt"], item["negative"] = prompts.assemble_prompt(project, item)

        if retimed:
            # 边界变化只影响相邻段：时长长的按比例判断是否需要换图
            for item in shots:
                old = int(before.get(str(item.get("id"))) or 0)
                new = max(0, int(item["endMs"]) - int(item["startMs"]))
                if old == new:
                    continue
                changed = abs(new - old) > max(500, old * 0.1)
                segments.mark_review(item, prompt=True, image=changed, reason="retime")

        if "prompt" in patch and patch["prompt"] != old_prompt:
            history = shot.setdefault("promptHistory", [])
            history.insert(0, {"at": schema.now_text(), "text": patch["prompt"], "source": "manual"})
            del history[10:]
        if retimed or auto_reset or {"description", "text", "usedEntities", "directive",
                                     "refAssets"} & set(patch):
            shot["prompt"], shot["negative"] = prompts.assemble_prompt(project, shot)
        if "text" in patch and not retimed:
            segments.mark_review(shot, image=True, reason="text")
        project["shots"] = shots
        store.save(project)
        return {"shot": store.public_view(project)["shots"][
            next(i for i, item in enumerate(shots) if item.get("id") == shot_id)]}


@app.post("/api/projects/{project_id}/shots/{shot_id}/polish")
def api_shot_polish(project_id: str, shot_id: str,
                    payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """按用户指令让 LLM 重写本段画面描述，并重拼提示词。"""
    directive = str(payload.get("directive") or "").strip()[:1000]
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        shot["directive"] = directive
        if isinstance(payload.get("refAssets"), list):
            try:
                shot["refAssets"] = schema.validate_fields(
                    schema.SHOT_FIELDS, {"refAssets": payload["refAssets"]})["refAssets"]
            except ValueError:
                pass
        result = prompts.polish(project, shot, directive)
        store.save(project)
        return {**_view(project), "polish": result}


@app.post("/api/projects/{project_id}/shots/merge")
def api_shots_merge(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """合并连续镜头段：只改画面，字幕 cues 完全不动。"""
    shot_ids = payload.get("shotIds")
    if not isinstance(shot_ids, list) or len(shot_ids) < 2:
        raise StudioError("shotIds 至少包含两个连续镜头段", code="bad_payload")
    wanted = [str(item) for item in shot_ids]
    with _lock(project_id):
        project = store.load(project_id)
        existing = project.get("shots") or []
        order = {str(item.get("id")): index for index, item in enumerate(existing)}
        first_id = min(wanted, key=lambda sid: order.get(sid, 10 ** 9))
        shots = segments.merge_shots(
            existing, wanted,
            duration_ms=_duration(project), fps=_fps(project),
            cues=_shifted_cues(project),
        )
        project["shots"] = shots
        _refresh_prompts(project, [str(first_id)])
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/shots/{shot_id}/split")
def api_shot_split(project_id: str, shot_id: str,
                   payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """在播放头拆分（atMs）或均分为 N 个画面（parts）；不拆台词。"""
    with _lock(project_id):
        project = store.load(project_id)
        shots = project.get("shots") or []
        current = next((item for item in shots if item.get("id") == shot_id), None)
        if current is None:
            raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
        if payload.get("parts") is not None:
            result = segments.split_shot_parts(
                shots, shot_id, int(payload.get("parts") or 0),
                duration_ms=_duration(project), fps=_fps(project),
            )
        else:
            try:
                at_ms = int(payload.get("atMs") or 0)
            except (TypeError, ValueError):
                raise StudioError("atMs 必须是数字", code="bad_payload") from None
            result = segments.split_shot_at(
                shots, shot_id, at_ms,
                duration_ms=_duration(project), fps=_fps(project),
                cues=_shifted_cues(project),
                snap_window_ms=0 if payload.get("snapCues") is False else 120,
            )
        project["shots"] = result
        # 只重拼被拆的段与新建的段，别动以前遗留的待处理标记
        before_ids = {str(item.get("id")) for item in shots}
        touched = [str(item.get("id")) for item in result
                   if str(item.get("id")) == shot_id or str(item.get("id")) not in before_ids]
        _refresh_prompts(project, touched)
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/shots/{shot_id}/review/clear")
def api_shot_review_clear(project_id: str, shot_id: str,
                          payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """用户手动「标记已处理」：逐项清除待复核标记。"""
    fields = payload.get("fields") or ["prompt", "image"]
    if not isinstance(fields, list):
        raise StudioError("fields 必须是数组", code="bad_payload")
    wanted = [str(item) for item in fields if str(item) in ("prompt", "image")]
    if not wanted:
        raise StudioError("fields 只能是 prompt / image", code="bad_payload")
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        segments.clear_review(shot, wanted)
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/shots/{shot_id}/image")
def api_shot_image(project_id: str, shot_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    data = _read_upload(file, MAX_IMAGE_BYTES, "图片")
    suffix = Path(file.filename or "shot.png").suffix.lower() or ".png"
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        raise StudioError("只支持 PNG / JPG / WEBP", code="unsupported_format")
    with _lock(project_id):
        project = store.load(project_id)
        shot = next((item for item in project.get("shots") or [] if item.get("id") == shot_id), None)
        if shot is None:
            raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
        shot["image"] = store.save_shot_image(project_id, shot_id, data, suffix)
        shot["status"] = "ready"
        shot["seed"] = 0
        shot["width"] = 0
        shot["height"] = 0
        images.record_image_version(project_id, shot, shot["image"], source="upload")
        store.save(project)
        return _view(project)


def _add_asset_image(project_id: str, entity: dict[str, Any],
                     data: bytes, suffix: str) -> str:
    """写入一张资产设定图，最多保留 4 张（超出删最早的文件）。"""
    relpath = store.save_asset_image(project_id, str(entity.get("id") or "asset"), data, suffix)
    refs = entity.setdefault("refImages", [])
    if relpath not in refs:
        refs.append(relpath)
    while len(refs) > 4:
        victim = refs.pop(0)
        store.delete_media(project_id, victim)
    return relpath


@app.post("/api/projects/{project_id}/assets/{entity_id}/image")
def api_asset_image(project_id: str, entity_id: str,
                    file: UploadFile = File(...)) -> dict[str, Any]:
    """给资产卡上传本地设定图。"""
    data = _read_upload(file, MAX_IMAGE_BYTES, "图片")
    suffix = Path(file.filename or "asset.png").suffix.lower() or ".png"
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        raise StudioError("只支持 PNG / JPG / WEBP", code="unsupported_format")
    with _lock(project_id):
        project = store.load(project_id)
        entity = _entity_of(project, entity_id)
        _add_asset_image(project_id, entity, data, suffix)
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/assets/{entity_id}/image/from-material")
def api_asset_image_from_material(project_id: str, entity_id: str,
                                  payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """把素材仓库里的一张图设为资产设定图。"""
    url = str(payload.get("url") or "")
    if not url:
        raise StudioError("缺少素材 url", code="bad_payload")
    data = images.MainClient().download(url)
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        suffix = ".png"
    with _lock(project_id):
        project = store.load(project_id)
        entity = _entity_of(project, entity_id)
        _add_asset_image(project_id, entity, data, suffix)
        store.save(project)
        return _view(project)


@app.delete("/api/projects/{project_id}/assets/{entity_id}/image")
def api_asset_image_delete(project_id: str, entity_id: str,
                           payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """删除资产卡的一张设定图。"""
    file = str(payload.get("file") or "")
    if not file:
        raise StudioError("缺少 file", code="bad_payload")
    with _lock(project_id):
        project = store.load(project_id)
        entity = _entity_of(project, entity_id)
        refs = [str(item) for item in (entity.get("refImages") or [])]
        if file not in refs:
            raise StudioError(f"设定图不存在：{file}", code="not_found", status=404)
        refs.remove(file)
        entity["refImages"] = refs
        store.save(project)
        store.delete_media(project_id, file)
        return _view(project)


@app.post("/api/projects/{project_id}/assets/{entity_id}/generate")
def api_asset_generate(project_id: str, entity_id: str) -> dict[str, Any]:
    """用文字直接生成资产设定图（文生图），完成后自动加入参考图。"""
    def run(task) -> dict[str, Any]:
        with _lock(project_id):
            project = store.load(project_id)
            entity = _entity_of(project, entity_id)
        task.set_progress(5, "准备资产设定图")
        client = images.MainClient()
        try:
            images.generate_asset(
                project, entity, client,
                cancel=task.canceled,
                progress=lambda value, label: task.set_progress(value, label),
            )
        finally:
            with _lock(project_id):
                store.save(project)
        task.set_progress(100, "完成")
        return {"entityId": entity_id}

    task = task_manager().submit(
        "asset", project_id, run, title=f"生成资产设定图 {entity_id}")
    return {"taskId": task.id}


@app.get("/api/projects/{project_id}/shots/{shot_id}/versions")
def api_shot_versions(project_id: str, shot_id: str) -> dict[str, Any]:
    project = store.load(project_id)
    shot = _shot_of(project, shot_id)
    versions = []
    for item in shot.get("imageHistory") or []:
        entry = dict(item)
        file = str(entry.get("file") or "")
        if not file:
            continue
        entry["url"] = store.url_for(project_id, file)
        entry["current"] = file == (shot.get("image") or "")
        versions.append(entry)
    return {"shotId": shot_id, "versions": versions}


@app.post("/api/projects/{project_id}/shots/{shot_id}/versions/use")
def api_shot_version_use(project_id: str, shot_id: str,
                         payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    file = str(payload.get("file") or "")
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        entry = next((item for item in shot.get("imageHistory") or []
                      if item.get("file") == file), None)
        if entry is None:
            raise StudioError("该版本不在历史记录里", code="not_found", status=404)
        store.read_media(project_id, file)
        shot["image"] = file
        shot["status"] = "ready"
        shot["seed"] = int(entry.get("seed") or 0)
        shot["width"] = int(entry.get("width") or 0)
        shot["height"] = int(entry.get("height") or 0)
        segments.clear_review(shot, ["image"])
        store.save(project)
        return _view(project)


@app.delete("/api/projects/{project_id}/shots/{shot_id}/versions")
def api_shot_version_delete(project_id: str, shot_id: str,
                            payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    file = str(payload.get("file") or "")
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        history = [item for item in shot.get("imageHistory") or [] if item.get("file") != file]
        if len(history) == len(shot.get("imageHistory") or []):
            raise StudioError("该版本不在历史记录里", code="not_found", status=404)
        shot["imageHistory"] = history
        if shot.get("image") == file:
            shot["image"] = str(history[0].get("file") or "") if history else ""
            shot["status"] = "ready" if shot["image"] else "pending"
        store.save(project)
        store.delete_media(project_id, file)
        return _view(project)


@app.post("/api/projects/{project_id}/restore")
def api_restore(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """撤销/重做：用前端快照整体替换 shots（只做基础校验，保留图片历史）。"""
    items = payload.get("shots")
    if not isinstance(items, list):
        raise StudioError("shots 必须是数组", code="bad_payload")
    if len(items) > 500:
        raise StudioError("镜头段过多（上限 500）", code="too_many_shots")
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise StudioError(f"shots[{index}] 必须是对象", code="bad_payload")
        shot_id = str(item.get("id") or "")
        if not shot_id or shot_id in seen:
            raise StudioError(f"shots[{index}] 缺少 id 或 id 重复", code="bad_payload")
        seen.add(shot_id)
        shot = dict(item)
        shot.pop("imageUrl", None)
        shot["startMs"] = int(shot.get("startMs") or 0)
        shot["endMs"] = int(shot.get("endMs") or 0)
        cleaned.append(shot)
    cleaned.sort(key=lambda shot: shot["startMs"])
    with _lock(project_id):
        project = store.load(project_id)
        project["shots"] = cleaned
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/shots/{shot_id}/clear")
def api_shot_clear(project_id: str, shot_id: str) -> dict[str, Any]:
    with _lock(project_id):
        project = store.load(project_id)
        shot = next((item for item in project.get("shots") or [] if item.get("id") == shot_id), None)
        if shot is None:
            raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
        shot["image"] = ""
        shot["status"] = "pending"
        store.save(project)
        return _view(project)


# --------------------------------------------------------------------------- 任务


@app.post("/api/projects/{project_id}/prompts")
def api_prompts(project_id: str) -> dict[str, Any]:
    def run(task) -> dict[str, Any]:
        task.set_progress(10, "整理分镜上下文")
        with _lock(project_id):
            project = store.load(project_id)
        result = prompts.generate(project)
        with _lock(project_id):
            store.save(project)
        task.set_progress(100, "完成")
        return result

    task = task_manager().submit("prompts", project_id, run, title="生成分镜提示词")
    return {"taskId": task.id}


@app.post("/api/projects/{project_id}/images")
def api_images(project_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    shot_ids = [str(item) for item in (payload.get("shotIds") or [])] or None

    def run(task) -> dict[str, Any]:
        with _lock(project_id):
            project = store.load(project_id)
        targets = images.pending_shots(project, shot_ids)
        if not targets:
            raise StudioError("没有待生成的镜头段", code="nothing_to_do")
        client = images.MainClient()
        generated, failed = 0, []
        total = len(targets)
        try:
            for index, shot in enumerate(targets):
                if task.canceled():
                    raise CanceledError()
                task.set_progress(int(index * 100 / total), f"生成 {shot.get('id')}（{index + 1}/{total}）")
                try:
                    images.generate_shot(
                        project, shot, client,
                        cancel=task.canceled,
                        progress=lambda value, label, _i=index: task.set_progress(
                            int((_i + value / 100.0) * 100 / total), f"{shot.get('id')} {label}"),
                    )
                    generated += 1
                except StudioError as exc:
                    if exc.code == "canceled":
                        raise
                    shot["status"] = "failed"
                    failed.append({"id": shot.get("id"), "error": str(exc)})
                with _lock(project_id):
                    store.save(project)
        finally:
            with _lock(project_id):
                store.save(project)
        if generated == 0 and failed:
            raise StudioError(f"全部失败：{failed[0]['error']}", code="generate_failed")
        return {"generated": generated, "failed": failed, "total": total}

    task = task_manager().submit("images", project_id, run, title="批量生图")
    return {"taskId": task.id}


@app.post("/api/projects/{project_id}/images/{shot_id}")
def api_image_one(project_id: str, shot_id: str) -> dict[str, Any]:
    def run(task) -> dict[str, Any]:
        with _lock(project_id):
            project = store.load(project_id)
        shot = next((item for item in project.get("shots") or [] if item.get("id") == shot_id), None)
        if shot is None:
            raise StudioError(f"镜头段不存在：{shot_id}", code="not_found", status=404)
        task.set_progress(5, f"重新生成 {shot_id}")
        client = images.MainClient()
        attempt = int(shot.get("attempts") or 0) + 1
        shot["seed"] = 0
        try:
            images.generate_shot(project, shot, client, attempt=attempt,
                                 cancel=task.canceled,
                                 progress=lambda value, label: task.set_progress(value, label))
        finally:
            with _lock(project_id):
                store.save(project)
        task.set_progress(100, "完成")
        return {"shotId": shot_id}

    task = task_manager().submit("image", project_id, run,
                                 title=f"重新生成 {shot_id}", shot_id=shot_id)
    return {"taskId": task.id}


@app.post("/api/projects/{project_id}/render")
def api_render(project_id: str) -> dict[str, Any]:
    def run(task) -> dict[str, Any]:
        with _lock(project_id):
            project = store.load(project_id)
        result = render.render(project, progress=task.set_progress, cancel=task.canceled)
        with _lock(project_id):
            outputs = [item for item in (project.get("outputs") or [])
                       if item.get("file") != result["file"]]
            outputs.insert(0, result)
            project["outputs"] = outputs[:20]
            store.save(project)
        return result

    task = task_manager().submit("render", project_id, run, title="导出成片")
    return {"taskId": task.id}


@app.get("/api/tasks")
def api_tasks(projectId: str = "", limit: int = 50) -> dict[str, Any]:
    return {"tasks": task_manager().list_tasks(projectId, limit)}


@app.get("/api/main/queue")
def api_main_queue() -> dict[str, Any]:
    """主项目队列摘要：用于任务中心底部提示「卡在谁那里」。"""
    try:
        health = images.MainClient().health()
    except StudioError as exc:
        return {"reachable": False, "error": str(exc)}
    queue = health.get("queue") or {}
    engine = health.get("engine") or {}
    return {
        "reachable": True,
        "engineReady": bool(engine.get("ready")),
        "device": str(engine.get("device") or ""),
        "pending": int(queue.get("pending") or 0),
        "running": bool(queue.get("running")),
        "runningId": queue.get("running_id") or queue.get("runningId") or "",
        "history": int(queue.get("history") or 0),
    }


def _main_url(url: str) -> str:
    text = str(url or "")
    if text.startswith(("http://", "https://")):
        return text
    return f"{config.MAIN_BASE}{text}" if text.startswith("/") else text


@app.get("/api/main/history")
def api_main_history(limit: int = 30) -> dict[str, Any]:
    limit = max(1, min(int(limit), 60))
    try:
        data = images.MainClient()._request("GET", f"/api/history?limit={limit}", timeout=15.0)
    except StudioError as exc:
        return {"reachable": False, "error": str(exc), "items": []}
    items = []
    for job in data.get("items") or []:
        meta = job.get("meta") or {}
        imgs = []
        for index, raw in enumerate(job.get("images") or []):
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("url") or raw.get("thumb_url") or "")
            if not url:
                continue
            try:
                image_index = int(raw.get("index", index))
            except (TypeError, ValueError):
                image_index = index
            imgs.append({
                "url": _main_url(url),
                "thumbUrl": _main_url(str(raw.get("thumb_url") or url)),
                "filename": str(raw.get("filename") or ""),
                "width": int(raw.get("width") or 0),
                "height": int(raw.get("height") or 0),
                "index": image_index,
            })
        if not imgs:
            continue
        params = job.get("params") or {}
        items.append({
            "id": str(job.get("id") or ""),
            "kind": str(job.get("kind") or ""),
            "status": str(job.get("status") or ""),
            "prompt": str(job.get("prompt") or ""),
            "createdAt": str(job.get("created_at") or ""),
            "projectId": str(meta.get("projectId") or ""),
            "shotId": str(meta.get("shotId") or ""),
            "seed": params.get("seed"),
            "width": int(params.get("width") or 0),
            "height": int(params.get("height") or 0),
            "images": imgs,
        })
    return {"reachable": True, "items": items}


@app.get("/api/main/materials")
def api_main_materials(q: str = "", limit: int = 60) -> dict[str, Any]:
    """代理主项目素材仓库，供详情弹窗「从素材仓库选择」使用。"""
    limit = max(1, min(int(limit), 120))
    query = f"/api/materials?limit={limit}"
    if str(q or "").strip():
        query += "&q=" + urllib.parse.quote(str(q).strip())
    try:
        data = images.MainClient()._request("GET", query, timeout=20.0)
    except StudioError as exc:
        return {"reachable": False, "error": str(exc), "items": []}
    items = []
    for item in data.get("items") or []:
        image = item.get("image") or {}
        url = _main_url(str(image.get("url") or ""))
        thumb = _main_url(str(image.get("thumbUrl") or url))
        if not url:
            continue
        items.append({
            "id": str(item.get("id") or ""),
            "title": str(item.get("title") or ""),
            "kind": str(item.get("kind") or ""),
            "url": url,
            "thumbUrl": thumb,
        })
    return {"reachable": True, "items": items}


@app.post("/api/projects/{project_id}/shots/{shot_id}/image/from-material")
def api_image_from_material(project_id: str, shot_id: str,
                            payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """把素材仓库里的一张图取回，写成该段的新版本。"""
    url = str(payload.get("url") or "")
    if not url:
        raise StudioError("缺少素材 url", code="bad_payload")
    data = images.MainClient().download(url)
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        suffix = ".png"
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        relpath = store.save_shot_image(project_id, shot_id, data, suffix)
        shot["image"] = relpath
        shot["status"] = "ready"
        shot["seed"] = 0
        shot["width"] = 0
        shot["height"] = 0
        images.record_image_version(project_id, shot, relpath, source="material")
        store.save(project)
        return _view(project)


@app.post("/api/projects/{project_id}/shots/{shot_id}/image/from-history")
def api_image_from_history(project_id: str, shot_id: str,
                           payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """把主项目历史里的一张图取回，写成该段的新版本。"""
    job_id = str(payload.get("jobId") or "")
    try:
        image_index = int(payload.get("imageIndex") or 0)
    except (TypeError, ValueError):
        image_index = 0
    if not job_id:
        raise StudioError("缺少 jobId", code="bad_payload")
    client = images.MainClient()
    job: dict[str, Any] | None = None
    try:
        job = client.job(job_id)
    except StudioError:
        # 任务详情可能已清理，退回历史列表里找
        try:
            data = client._request("GET", "/api/history?limit=200", timeout=15.0)
        except StudioError as exc:
            raise StudioError(f"主项目不可达：{exc}", code="main_error", status=503) from exc
        job = next((item for item in data.get("items") or []
                    if str(item.get("id")) == job_id), None)
    if job is None:
        raise StudioError("主项目里找不到这条任务（可能已被清理）", code="not_found", status=404)

    images_list = [item for item in (job.get("images") or []) if isinstance(item, dict)]
    meta = next((item for item in images_list
                 if str(item.get("index")) == str(image_index)), None)
    if meta is None and 0 <= image_index < len(images_list):
        meta = images_list[image_index]
    if meta is None:
        raise StudioError("该任务没有对应图片", code="not_found", status=404)

    data = client.download(str(meta.get("url") or meta.get("thumb_url") or ""))
    suffix = Path(str(meta.get("filename") or "shot.png")).suffix.lower() or ".png"
    if suffix not in (".png", ".jpg", ".jpeg", ".webp"):
        suffix = ".png"
    with _lock(project_id):
        project = store.load(project_id)
        shot = _shot_of(project, shot_id)
        relpath = store.save_shot_image(project_id, shot_id, data, suffix)
        shot["image"] = relpath
        shot["status"] = "ready"
        shot["seed"] = int((job.get("params") or {}).get("seed") or 0)
        shot["width"] = int(meta.get("width") or 0)
        shot["height"] = int(meta.get("height") or 0)
        images.record_image_version(
            project_id, shot, relpath,
            seed=shot["seed"], width=shot["width"], height=shot["height"],
            job_id=job_id, source="history",
        )
        store.save(project)
        return _view(project)


@app.get("/api/tasks/{task_id}")
def api_task(task_id: str) -> dict[str, Any]:
    task = task_manager().get(task_id)
    if task is None:
        raise StudioError("任务不存在", code="not_found", status=404)
    return task.to_dict()


@app.post("/api/tasks/{task_id}/cancel")
def api_task_cancel(task_id: str) -> dict[str, Any]:
    ok = task_manager().cancel(task_id)
    return {"ok": ok}


# --------------------------------------------------------------------------- 静态托管

app.mount("/files", StaticFiles(directory=str(config.PROJECTS_DIR)), name="files")
for _sub in ("src", "assets"):
    _dir = WEB_DIR / _sub
    _dir.mkdir(parents=True, exist_ok=True)
    app.mount(f"/{_sub}", StaticFiles(directory=str(_dir)), name=_sub)


@app.get("/")
@app.get("/index.html")
def index() -> FileResponse:
    path = WEB_DIR / "index.html"
    if not path.is_file():
        raise StudioError("前端未找到：web/index.html", code="no_frontend", status=404)
    return FileResponse(path, media_type="text/html; charset=utf-8")
