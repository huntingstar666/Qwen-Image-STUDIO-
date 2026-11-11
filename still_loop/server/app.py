"""still_loop 工作台服务：分镜、接力生成、自检、审核、导出。

不修改主项目；主项目只通过 HTTP /api/edit 调用。
"""
from __future__ import annotations

import copy
import io
import json
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .. import __version__, config
from ..core import anim_client, motion, runner, store
from ..core.generator import MainProjectClient, MockGenerator

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
config.RUNS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="still_loop", version=__version__)
_GENERATION_LOCK = threading.Lock()
_CANCEL_EVENTS: dict[str, threading.Event] = {}


# ---------------------------------------------------------------- helpers

def _public_run(run: dict[str, Any]) -> dict[str, Any]:
    data = copy.deepcopy(run)
    run_id = data["id"]
    base = f"/files/{run_id}/"
    reference = data.get("reference") or {}
    if reference.get("file"):
        reference["previewUrl"] = base + reference["file"]
    for frame in data.get("frames") or []:
        accepted = frame.get("acceptedFile") or ""
        current = frame.get("currentFile") or ""
        source = frame.get("sourceFile") or ""
        frame["previewUrl"] = base + (accepted or current) if (accepted or current) else ""
        frame["acceptedPreviewUrl"] = base + accepted if accepted else ""
        frame["sourcePreviewUrl"] = base + source if source else ""
        frame["originalPreviewUrl"] = base + (frame.get("originalFile") or source) if (frame.get("originalFile") or source) else ""
        frame["isEdited"] = bool(source and accepted and accepted != source)
        frame["canRestore"] = bool(source and accepted != source)
        frame["attemptCount"] = len(frame.get("attempts") or [])
        for attempt in frame.get("attempts") or []:
            if attempt.get("file"):
                attempt["previewUrl"] = base + attempt["file"]
    animation = data.get("animation") or {}
    for key in ("gif", "apng", "file"):
        if animation.get(key):
            animation[key + "Url"] = base + animation[key]
    if animation.get("fileUrl") and not animation.get("format"):
        animation["format"] = "gif"
    mime_map = {"gif": "image/gif", "apng": "image/apng", "webp": "image/webp",
                "mp4": "video/mp4", "webm": "video/webm"}
    for item in animation.get("variants") or []:
        if item.get("file"):
            item["fileUrl"] = base + item["file"]
            item["mime"] = mime_map.get(str(item.get("format") or ""), "")
            item["seconds"] = round(int(item.get("durationMs") or 0) / 1000, 2)
    data["animation"] = animation
    source = data.get("source") or "loop"
    data["source"] = source
    frames = data.get("frames") or []
    active = data.get("status") in ("planning", "running", "exporting")
    every = bool(frames) and all(frame.get("status") == "accepted" for frame in frames)
    data["canStart"] = (source not in ("sheet", "photos", "pipeline") and bool(frames)
                        and data.get("status") in
                        ("planned", "review", "blocked", "canceled", "failed", "done"))
    data["canPipeline"] = (source in ("sheet", "photos", "pipeline") and bool(frames)
                           and not active)
    data["canReorder"] = data["canPipeline"]
    data["canDeleteFrames"] = data["canPipeline"] and len(frames) > 1
    data["canExport"] = every and not active
    data["canApprove"] = every and not active
    data["pipeline"] = data.get("pipeline") or {}
    data["frameCount"] = len(frames)
    data["acceptedCount"] = sum(1 for frame in frames if frame.get("status") == "accepted")
    return data


def _make_generator(run: dict[str, Any]):
    settings = run.get("settings") or {}
    if settings.get("engine") == "main":
        return MainProjectClient(settings=settings)
    reference = Image.open(store.run_dir(run["id"]) / "reference.png")
    reference.load()
    return MockGenerator(reference, settings, fail_frames=(5, 9))


def _fail(run_id: str, exc: BaseException) -> None:
    try:
        run = store.load_run(run_id)
        run["status"] = "failed"
        run["error"] = f"{type(exc).__name__}: {exc}"
        runner.log(run, "error", run["error"])
        store.save_run(run)
        store.write_report(run)
    except Exception:  # noqa: BLE001
        pass


def _spawn(target, *args) -> None:
    threading.Thread(target=target, args=args, daemon=True).start()


def _parse_settings(raw: str | None) -> dict[str, Any]:
    try:
        data = json.loads(str(raw or "{}").lstrip("\ufeff"))
    except json.JSONDecodeError as exc:
        raise HTTPException(400, f"settings 不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(400, "settings 必须是对象")
    return data


def _parse_prompts(raw: Any) -> Any:
    """接受 JSON 数组/对象，或按行分隔的纯文本。"""
    if isinstance(raw, (list, dict)):
        return raw
    text = str(raw or "").lstrip("\ufeff").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return [line.strip() for line in text.splitlines() if line.strip()]
    return data if isinstance(data, (list, dict)) else []


def _abs_main(path: str) -> str:
    if not path:
        return ""
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return config.MAIN_BASE.rstrip("/") + path


def _fetch_main_asset(url: str) -> bytes:
    """从主项目取图片字节；路径里可能带中文，先做百分号编码。"""
    target = _abs_main(url)
    parts = urllib.parse.urlsplit(target)
    target = urllib.parse.urlunsplit((
        parts.scheme, parts.netloc, urllib.parse.quote(parts.path),
        urllib.parse.quote(parts.query, safe="=&"), parts.fragment,
    ))
    with urllib.request.urlopen(target, timeout=60.0) as response:
        return response.read()


def _pipeline_task(run_id: str, event: threading.Event,
                   prompts: Any = None, indexes: list[int] | None = None) -> None:
    try:
        with _GENERATION_LOCK:
            run = store.load_run(run_id)
            generator = _make_generator(run)
            runner.edit_frames(run, generator, prompts=prompts, indexes=indexes,
                               should_cancel=event.is_set)
    except Exception as exc:  # noqa: BLE001
        _fail(run_id, exc)
    finally:
        _CANCEL_EVENTS.pop(run_id, None)


def _plan_task(run_id: str) -> None:
    try:
        run = store.load_run(run_id)
        runner.plan_run(run, llm="auto")
    except Exception as exc:  # noqa: BLE001
        _fail(run_id, exc)


def _start_task(run_id: str, event: threading.Event) -> None:
    try:
        with _GENERATION_LOCK:
            run = store.load_run(run_id)
            generator = _make_generator(run)
            runner.start_run(run, generator, should_cancel=event.is_set)
    except Exception as exc:  # noqa: BLE001
        _fail(run_id, exc)
    finally:
        _CANCEL_EVENTS.pop(run_id, None)


def _retry_task(run_id: str, index: int, prompt: str | None,
                reference: str | None, images: list[int] | None,
                overrides: dict[str, Any] | None,
                event: threading.Event) -> None:
    try:
        with _GENERATION_LOCK:
            run = store.load_run(run_id)
            generator = _make_generator(run)
            runner.retry_frame(run, index, generator, prompt=prompt,
                               reference=reference, images=images,
                               overrides=overrides, should_cancel=event.is_set)
    except Exception as exc:  # noqa: BLE001
        _fail(run_id, exc)
    finally:
        _CANCEL_EVENTS.pop(run_id, None)


def _export_task(run_id: str, fps: int) -> None:
    try:
        with _GENERATION_LOCK:
            run = store.load_run(run_id)
            runner.export_animation(run, fps=fps)
    except Exception as exc:  # noqa: BLE001
        _fail(run_id, exc)


def _health_main() -> dict[str, Any]:
    try:
        with urllib.request.urlopen(config.MAIN_BASE.rstrip("/") + "/api/health",
                                    timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return {"ok": True, "base": config.MAIN_BASE, "version": payload.get("version")}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "base": config.MAIN_BASE, "error": str(exc)}


def _health_ollama() -> dict[str, Any]:
    try:
        with urllib.request.urlopen(config.OLLAMA_BASE.rstrip("/") + "/api/tags",
                                    timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        models = [item.get("name") for item in payload.get("models") or [] if item.get("name")]
        return {"ok": True, "base": config.OLLAMA_BASE, "models": models}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "base": config.OLLAMA_BASE, "models": [], "error": str(exc)}


# ---------------------------------------------------------------- routes

@app.get("/api/loop/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__,
            "main": _health_main(), "ollama": _health_ollama(),
            "data": str(config.DATA_DIR)}


def _main_json(path: str, timeout: float = 2.0) -> dict[str, Any]:
    with urllib.request.urlopen(config.MAIN_BASE.rstrip("/") + path,
                                timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _main_options() -> dict[str, Any]:
    """拉主项目 /api/options + /api/meta，只取编辑相关的部分；失败时退化为默认值。"""
    try:
        payload = _main_json("/api/options")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "models": [], "presets": [],
                "default": config.EDIT_MODEL, "defaultPreset": ""}
    raw_models = payload.get("model_profiles") or payload.get("models") or {}
    items = raw_models.values() if isinstance(raw_models, dict) else raw_models
    models = []
    for item in items:
        if not isinstance(item, dict):
            continue
        caps = item.get("capabilities") or {}
        if not caps.get("edit"):
            continue
        models.append({
            "id": item.get("id") or item.get("model_id") or "",
            "label": item.get("label") or item.get("name") or item.get("id") or "",
            "rgba": bool(caps.get("rgba")),
        })
    raw_presets: Any = {}
    default_preset = ""
    try:
        meta = _main_json("/api/meta")
        raw_presets = meta.get("edit_presets") or {}
        default_preset = str(meta.get("default_preset") or "")
    except Exception:  # noqa: BLE001
        raw_presets = payload.get("edit_presets") or payload.get("presets") or {}
    preset_items = raw_presets.values() if isinstance(raw_presets, dict) else raw_presets
    presets = []
    for item in preset_items:
        if isinstance(item, str):
            presets.append({"id": item, "label": item, "summary": ""})
        elif isinstance(item, dict):
            key = item.get("id") or item.get("key") or ""
            mode = str(item.get("task_mode") or "")
            if key and mode in ("", "edit"):
                presets.append({"id": str(key),
                                "label": str(item.get("label") or key),
                                "summary": str(item.get("summary") or ""),
                                "taskMode": mode})
    # 接力编辑优先用「连续编辑·遮罩」：每轮只重绘选区，遮罩外逐字节保持
    ids = {item["id"] for item in presets}
    if "chain_mask" in ids:
        preset_default = "chain_mask"
    elif default_preset in ids:
        preset_default = default_preset
    else:
        preset_default = ""
    defaults = payload.get("defaults") or {}
    default = defaults.get("edit")
    if not isinstance(default, str) or not default:
        default = config.EDIT_MODEL
    return {
        "ok": True,
        "models": [item for item in models if item["id"]],
        "presets": presets,
        "default": default,
        "defaultPreset": preset_default,
    }


@app.get("/api/loop/options")
def options() -> dict[str, Any]:
    main = _main_options()
    return {
        "frames": {"min": 1, "max": 48, "default": config.DEFAULT_FRAMES},
        "sizes": [384, 512, 640, 768],
        "canvas": [
            {"id": "1:1s", "label": "1:1 轻量 512", "width": 512, "height": 512},
            {"id": "1:1", "label": "1:1 标准 768", "width": 768, "height": 768},
            {"id": "4:3", "label": "4:3 横 896×672", "width": 896, "height": 672},
            {"id": "16:9", "label": "16:9 宽 1024×576", "width": 1024, "height": 576},
            {"id": "9:16", "label": "9:16 竖 576×1024", "width": 576, "height": 1024},
            {"id": "3:4", "label": "3:4 竖 672×896", "width": 672, "height": 896},
        ],
        "fps": {"min": 4, "max": 30, "default": config.DEFAULT_FPS},
        "retries": {"min": 1, "max": 5, "default": config.DEFAULT_MAX_RETRIES},
        "engines": [
            {"id": "mock", "name": "模拟出图（演示）"},
            {"id": "main", "name": "主项目真实生成（需 8700）"},
        ],
        "editModels": main["models"],
        "presets": main["presets"],
        "defaultModel": main["default"] or config.EDIT_MODEL,
        "defaultPreset": main.get("defaultPreset") or "",
        "mainOk": main["ok"],
        "mainError": main.get("error") or "",
        "library": {"ok": main["ok"], "base": config.MAIN_BASE},
        "exportFormats": list(config.EXPORT_FORMATS),
        "video": {"available": motion.ffmpeg_available(),
                  "formats": list(config.VIDEO_FORMATS)},
        "styles": [{"id": key, "label": label}
                   for key, label in (("", "不限定"), ("clay", "黏土"),
                                      ("paper", "纸偶"), ("felt", "毛毡"),
                                      ("lego", "积木"))],
        "relay": [
            {"id": "chain", "label": "连续接力", "hint": "每帧基于上一帧，适合连续动作"},
            {"id": "independent", "label": "独立出图", "hint": "每帧从参考图出发，适合换季/换状态"},
        ],
        "background": [
            {"id": "auto", "label": "自动", "hint": "成长叙事自动用固定背景"},
            {"id": "plain", "label": "整幅重绘", "hint": "最通用，背景可能累积纹理"},
            {"id": "fixed", "label": "固定背景", "hint": "品红抠图 + 背景板，主体更稳"},
        ],
        "pipeline": {"maxCells": 48, "experimental": True},
        "timeline": {
            "fps": {"min": 4, "max": 30, "default": config.DEFAULT_FPS},
            "hold": {"min": 1, "max": 6, "default": config.DEFAULT_HOLD},
        },
        "motion": {
            "presets": [{"id": "both", "label": "顺滑 + 定格（两版）"},
                        {"id": "smooth", "label": "仅顺滑"},
                        {"id": "stopmotion", "label": "仅定格"}],
            "fps": {"min": 4, "max": 24, "default": config.DEFAULT_STOPMOTION_FPS},
            "hold": {"min": 1, "max": 6, "default": config.DEFAULT_HOLD},
            "jitter": {"min": 0, "max": 8, "default": 1.2},
            "grain": {"min": 0, "max": 0.3, "default": 0.06},
            "vignette": {"min": 0, "max": 0.8, "default": 0.18},
            "colorBoil": {"min": 0, "max": 0.2, "default": 0.03},
        },
        "stabilize": {"align": True, "colorMatch": True,
                      "service": config.ANIM_BASE,
                      "available": anim_client.available()},
        "defaults": {
            "frames": config.DEFAULT_FRAMES,
            "size": config.DEFAULT_SIZE,
            "width": config.DEFAULT_SIZE,
            "height": config.DEFAULT_SIZE,
            "fps": config.DEFAULT_FPS,
            "max_retries": config.DEFAULT_MAX_RETRIES,
            "steps": 8,
            "cfg": 1.0,
            "denoise": 1.0,
            "turbo": True,
            "consistency": True,
            "relay": "chain",
            "background": "auto",
            "style": "",
            "export": {"format": "gif", "dither": True, "align": False,
                       "color_match": False},
            "motion": {"preset": "both", "fps": config.DEFAULT_STOPMOTION_FPS,
                       "hold": config.DEFAULT_HOLD, "jitter": 1.2,
                       "grain": 0.06, "vignette": 0.18, "color_boil": 0.03},
            "timeline": {"fps": config.DEFAULT_FPS,
                         "hold": config.DEFAULT_HOLD},
        },
    }


@app.get("/api/loop/runs")
def list_runs(limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(100, int(limit)))
    paths = sorted(config.RUNS_DIR.glob("*/run.json"),
                   key=lambda path: path.stat().st_mtime, reverse=True)[:limit]
    items = []
    for path in paths:
        try:
            run = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        cover = ""
        frames = run.get("frames") or []
        if frames and frames[0].get("acceptedFile"):
            cover = f"/files/{run['id']}/{frames[0]['acceptedFile']}"
        elif (run.get("reference") or {}).get("file"):
            cover = f"/files/{run['id']}/{run['reference']['file']}"
        items.append({
            "id": run.get("id"),
            "name": run.get("name") or run.get("idea") or "",
            "idea": run.get("idea"),
            "source": run.get("source") or "loop",
            "status": run.get("status"),
            "updatedAt": run.get("updatedAt"),
            "createdAt": run.get("createdAt"),
            "frames": len(frames),
            "accepted": sum(1 for frame in frames
                            if frame.get("status") == "accepted"),
            "cover": cover,
            "animation": (run.get("animation") or {}).get("file") or "",
        })
    return {"items": items}


@app.post("/api/loop/runs")
async def create_run(file: UploadFile = File(...), idea: str = Form(...),
                     settings: str = Form("{}"), engine: str = Form("mock")) -> dict[str, Any]:
    try:
        raw = _parse_settings(settings)
    except HTTPException:
        raise
    raw["engine"] = engine
    data = await file.read()
    if not data:
        raise HTTPException(400, "参考图为空")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "参考图不能超过 30MB")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"无法读取参考图：{exc}") from exc
    try:
        run = runner.create_run(image, idea, raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


@app.post("/api/loop/runs/sheet")
async def create_sheet_run(file: UploadFile = File(...), settings: str = Form("{}"),
                           rows: int = Form(4), columns: int = Form(4),
                           row_gap: int = Form(0), column_gap: int = Form(0),
                           order: str = Form("row-major"), trim: str = Form("union")
                           ) -> dict[str, Any]:
    """可选来源：上传一张宫格总表，按格切分后直接进入审核/导出。"""
    raw = _parse_settings(settings)
    data = await file.read()
    if not data:
        raise HTTPException(400, "宫格图为空")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "宫格图不能超过 30MB")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"无法读取宫格图：{exc}") from exc
    try:
        run = runner.create_sheet_run(
            image, raw, rows=rows, columns=columns, row_gap=row_gap,
            column_gap=column_gap, order=order, trim=trim)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


# ---------------------------------------------------------------- 素材仓库 / 照片导入 / 流水线

@app.get("/api/loop/library")
def library(kind: str = "", category: str = "", q: str = "", limit: int = 120
            ) -> dict[str, Any]:
    """代理主项目素材仓库，返回可直接用于 <img> 的绝对地址。"""
    query = urllib.parse.urlencode({
        key: value for key, value in
        (("kind", kind), ("category", category), ("q", q), ("limit", str(limit)))
        if value
    })
    try:
        payload = _main_json("/api/materials?" + query, timeout=12.0)
    except Exception as exc:  # noqa: BLE001 - 主项目离线时前端显示空态
        return {"ok": False, "error": str(exc), "items": [], "categories": [],
                "base": config.MAIN_BASE}
    items: list[dict[str, Any]] = []
    categories: set[str] = set()
    for item in payload.get("items") or []:
        if not isinstance(item, dict):
            continue
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        url = str(image.get("url") or "")
        if not url:
            continue
        category_name = str(item.get("category") or "未分类")
        categories.add(category_name)
        items.append({
            "id": item.get("id"),
            "title": str(item.get("title") or ""),
            "category": category_name,
            "kind": str(item.get("kind") or ""),
            "prompt": str(item.get("prompt") or ""),
            "width": int(image.get("width") or 0),
            "height": int(image.get("height") or 0),
            "createdAt": str(item.get("createdAt") or ""),
            "url": _abs_main(url),
            "thumbUrl": _abs_main(str(image.get("thumbUrl") or url)),
        })
    return {"ok": True, "items": items, "categories": sorted(categories),
            "base": config.MAIN_BASE}


@app.post("/api/loop/runs/import-photos")
async def create_photo_import(files: list[UploadFile] = File(...),
                              settings: str = Form("{}"),
                              prompts: str = Form("[]"),
                              name: str = Form("")) -> dict[str, Any]:
    """多图上传：按上传顺序直接铺成定格轨道。"""
    raw = _parse_settings(settings)
    images: list[Image.Image] = []
    for upload in files[:48]:
        data = await upload.read()
        if not data:
            continue
        if len(data) > 30 * 1024 * 1024:
            raise HTTPException(400, f"{upload.filename or '照片'} 超过 30MB")
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"无法读取照片 {upload.filename or ''}：{exc}") from exc
        images.append(image)
    if not images:
        raise HTTPException(400, "没有可导入的照片")
    try:
        run = runner.create_photo_run(images, raw,
                                      prompts=_parse_prompts(prompts), name=name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


@app.post("/api/loop/runs/from-materials")
def create_material_run(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """从主项目素材仓库多选导入；服务端抓取图片，避免前端跨域。"""
    ids = [str(item) for item in (payload.get("ids") or [])][:48]
    if not ids:
        raise HTTPException(400, "请至少选择一张素材")
    try:
        listing = _main_json("/api/materials?limit=500", timeout=15.0)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"素材仓库不可用：{exc}") from exc
    by_id = {str(item.get("id")): item for item in listing.get("items") or []
             if isinstance(item, dict)}
    images: list[Image.Image] = []
    titles: list[str] = []
    for material_id in ids:
        item = by_id.get(material_id)
        if not item:
            continue
        url = str((item.get("image") or {}).get("url") or "")
        if not url:
            continue
        try:
            data = _fetch_main_asset(url)
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"素材 {material_id} 读取失败：{exc}") from exc
        images.append(image)
        titles.append(str(item.get("title") or ""))
    if not images:
        raise HTTPException(400, "选中的素材没有可用图片")
    try:
        run = runner.create_photo_run(
            images, payload.get("settings") or {},
            prompts=_parse_prompts(payload.get("prompts")),
            name=payload.get("name") or f"素材导入 {len(images)} 帧")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    run["library"] = {"ids": ids, "titles": titles}
    store.save_run(run)
    return _public_run(run)


@app.post("/api/loop/runs/pipeline")
async def create_pipeline_run(file: UploadFile = File(...), settings: str = Form("{}"),
                              rows: int = Form(4), columns: int = Form(4),
                              row_gap: int = Form(0), column_gap: int = Form(0),
                              order: str = Form("row-major"), trim: str = Form("union"),
                              prompts: str = Form("[]"), auto_start: bool = Form(True),
                              name: str = Form("")) -> dict[str, Any]:
    """实验性自动化：宫格切分 → 逐格 AI 精修 → 审核 → 导出。"""
    raw = _parse_settings(settings)
    data = await file.read()
    if not data:
        raise HTTPException(400, "宫格图为空")
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "宫格图不能超过 30MB")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"无法读取宫格图：{exc}") from exc
    try:
        run = runner.create_sheet_run(
            image, raw, rows=rows, columns=columns, row_gap=row_gap,
            column_gap=column_gap, order=order, trim=trim)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    run["source"] = "pipeline"
    run["name"] = (name or "").strip() or f"自动化流水线 {rows}×{columns}"
    run["idea"] = run["name"]
    text_prompts = _parse_prompts(prompts)
    runner.apply_prompts(run, text_prompts)
    run["pipeline"] = {
        "kind": "grid",
        "auto": bool(auto_start),
        "grid": (run.get("plan") or {}).get("grid") or {},
        "step": "split",
        "createdAt": store.now_text(),
        "settingsPreview": {
            "style": (run.get("settings") or {}).get("style") or "",
            "engine": (run.get("settings") or {}).get("engine") or "mock",
        },
    }
    store.save_run(run)
    if auto_start:
        run["status"] = "running"
        run["progress"] = {"stage": "pipeline", "frame": 0, "attempt": 0,
                           "done": 0, "total": len(run["frames"]), "percent": 0,
                           "message": "切分完成，开始 AI 精修"}
        store.save_run(run)
        event = threading.Event()
        _CANCEL_EVENTS[run["id"]] = event
        _spawn(_pipeline_task, run["id"], event, None, None)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/pipeline")
def start_pipeline(run_id: str, payload: dict[str, Any] = Body(default={})
                   ) -> dict[str, Any]:
    """对已有照片/宫格轨道启动 AI 精修；可只重跑指定的若干帧。"""
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("source") not in ("photos", "sheet", "pipeline"):
        raise HTTPException(400, "当前轨道不支持 AI 精修")
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "当前状态不能启动精修")
    prompts = payload.get("prompts")
    if prompts:
        runner.apply_prompts(run, _parse_prompts(prompts))
    raw_settings = payload.get("settings")
    if isinstance(raw_settings, dict):
        run["settings"] = runner.normalize_settings({**(run.get("settings") or {}), **raw_settings})
    indexes = payload.get("indexes")
    clean_indexes: list[int] | None = None
    if isinstance(indexes, list) and indexes:
        try:
            clean_indexes = [int(item) for item in indexes]
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "indexes 必须是帧号数组") from exc
    run["status"] = "running"
    run["progress"] = {"stage": "pipeline", "frame": 0, "attempt": 0,
                       "done": 0, "total": len(run.get("frames") or []),
                       "percent": 0, "message": "准备 AI 精修"}
    store.save_run(run)
    event = threading.Event()
    _CANCEL_EVENTS[run_id] = event
    _spawn(_pipeline_task, run_id, event, None, clean_indexes)
    return _public_run(run)


@app.patch("/api/loop/runs/{run_id}/timeline")
def update_timeline(run_id: str, payload: dict[str, Any] = Body(default={})
                    ) -> dict[str, Any]:
    """持久化轨道编排：帧率与逐帧停格数。"""
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    settings = copy.deepcopy(run.get("settings") or {})
    timeline = dict(settings.get("timeline") or {})
    if "fps" in payload:
        timeline["fps"] = payload.get("fps")
    if "holds" in payload:
        timeline["holds"] = payload.get("holds")
    settings["timeline"] = timeline
    run["settings"] = runner.normalize_settings(settings)
    store.save_run(run)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/frames/order")
def reorder_frames(run_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("source") not in ("photos", "sheet", "pipeline"):
        raise HTTPException(400, "只有导入/宫格/流水线轨道可以重排")
    frames = run.get("frames") or []
    try:
        order = [int(item) for item in (payload.get("order") or [])]
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "order 必须是帧号数组") from exc
    if sorted(order) != sorted(int(frame["index"]) for frame in frames):
        raise HTTPException(400, "order 必须包含全部帧且不重复")
    mapping = {int(frame["index"]): frame for frame in frames}
    run["frames"] = [mapping[item] for item in order]
    for position, frame in enumerate(run["frames"], start=1):
        frame["index"] = position
    store.save_run(run)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/frames/{index}/restore")
def restore_frame(run_id: str, index: int) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    try:
        runner.restore_frame(run, int(index))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


@app.delete("/api/loop/runs/{run_id}/frames/{index}")
def delete_frame(run_id: str, index: int) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("source") not in ("photos", "sheet", "pipeline"):
        raise HTTPException(400, "只有导入/宫格/流水线轨道可以删帧")
    frames = run.get("frames") or []
    if len(frames) <= 1:
        raise HTTPException(400, "轨道至少保留 1 帧")
    remaining = [frame for frame in frames if int(frame["index"]) != int(index)]
    if len(remaining) == len(frames):
        raise HTTPException(404, "帧不存在")
    run["frames"] = remaining
    for position, frame in enumerate(remaining, start=1):
        frame["index"] = position
    settings = copy.deepcopy(run.get("settings") or {})
    settings["frames"] = len(remaining)
    timeline = dict(settings.get("timeline") or {})
    holds = [int(item) for item in (timeline.get("holds") or [])]
    if 1 <= int(index) <= len(holds):
        holds.pop(int(index) - 1)
    fallback = int((settings.get("motion") or {}).get("hold") or 2)
    holds = holds[:len(remaining)] + [fallback] * max(0, len(remaining) - len(holds))
    timeline["holds"] = holds
    settings["timeline"] = timeline
    run["settings"] = runner.normalize_settings(settings)
    store.save_run(run)
    return _public_run(run)


@app.get("/api/loop/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/plan")
def plan_run(run_id: str) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "当前状态不能重新分镜")
    if run.get("source") in ("sheet", "photos", "pipeline"):
        raise HTTPException(400, "导入/切分轨道不需要 LLM 分镜，请直接精修或导出")
    run["status"] = "planning"
    run["progress"] = {"stage": "planning", "frame": 0, "attempt": 0, "done": 0,
                       "total": run["settings"]["frames"], "percent": 0,
                       "message": "LLM 正在拆分镜"}
    store.save_run(run)
    _spawn(_plan_task, run_id)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/prompts")
def set_prompts(run_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """手写提示词直接建帧，不经过 LLM。"""
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "当前状态不能改提示词")
    if run.get("source") in ("photos", "sheet", "pipeline"):
        run = runner.apply_prompts(run, payload.get("prompts") or [])
        return _public_run(run)
    try:
        run = runner.use_prompts(run, payload.get("prompts") or [])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/start")
def start_run(run_id: str) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if not run.get("frames"):
        raise HTTPException(400, "还没有分镜，请先生成分镜")
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "当前状态不能开始生成")
    run["status"] = "running"
    run["progress"] = {"stage": "running", "frame": 0, "attempt": 0, "done": 0,
                       "total": len(run["frames"]), "percent": 0,
                       "message": "准备开始接力"}
    store.save_run(run)
    event = threading.Event()
    _CANCEL_EVENTS[run_id] = event
    _spawn(_start_task, run_id, event)
    return _public_run(run)


@app.patch("/api/loop/runs/{run_id}/frames/{index}")
def patch_frame(run_id: str, index: int, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "生成中不能改提示词")
    target = next((frame for frame in run.get("frames") or []
                   if int(frame["index"]) == int(index)), None)
    if target is None:
        raise HTTPException(404, "帧不存在")
    prompt = payload.get("prompt")
    if prompt is not None:
        target["prompt"] = str(prompt).strip()
    if payload.get("reset") and target.get("status") == "accepted":
        target["status"] = "pending"
        target["acceptedFile"] = ""
        target["acceptedUrl"] = ""
        target["acceptedPrompt"] = ""
    store.save_run(run)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/frames/{index}/retry")
def retry_frame(run_id: str, index: int,
                payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if run.get("status") in ("planning", "running", "exporting"):
        raise HTTPException(409, "生成中不能重试")
    if not any(int(frame["index"]) == int(index) for frame in run.get("frames") or []):
        raise HTTPException(404, "帧不存在")
    prompt = payload.get("prompt")
    if prompt is not None:
        for frame in run["frames"]:
            if int(frame["index"]) == int(index):
                frame["prompt"] = str(prompt).strip()
                break
    # 参考框：images 是帧号数组，images[0] 当画布，其余当参考图；空数组 = 文生图。
    raw_images = payload.get("images")
    images: list[int] | None = None
    if raw_images is not None:
        if not isinstance(raw_images, list):
            raise HTTPException(400, "images 必须是数组（空数组表示文生图）")
        try:
            images = [int(item) for item in raw_images]
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "images 里只能放帧号") from exc
        if len(images) > 10:
            raise HTTPException(400, "参考图最多 10 张")
        known = {int(frame["index"]): frame for frame in run.get("frames") or []}
        for item in images:
            frame_item = known.get(item)
            if frame_item is None:
                raise HTTPException(400, f"第 {item} 帧不存在")
            if not any(frame_item.get(key) for key in
                       ("acceptedFile", "currentFile", "sourceFile", "originalFile")):
                raise HTTPException(400, f"第 {item} 帧还没有可用图片")
        if not images and not str(payload.get("prompt") or "").strip():
            raise HTTPException(400, "参考图为空时是文生图，请先填写提示词")
    reference = str(payload.get("reference") or "source").strip()
    if images is None and reference not in ("source", "previous"):
        raise HTTPException(400, "reference 只支持 source / previous")
    overrides = payload.get("settings") or {}
    if not isinstance(overrides, dict):
        raise HTTPException(400, "settings 必须是对象")
    if images is None and reference == "previous":
        if int(index) <= 1:
            raise HTTPException(400, "第 1 帧没有上一帧")
        prev = next((frame for frame in run["frames"]
                     if int(frame["index"]) == int(index) - 1), None)
        if not prev or not (prev.get("acceptedFile") or prev.get("currentFile")):
            raise HTTPException(400, f"第 {int(index) - 1} 帧还没有可用图片，先精修上一帧")
    run["status"] = "running"
    run["progress"] = {"stage": "running", "frame": int(index), "attempt": 0,
                       "done": sum(1 for frame in run["frames"]
                                   if frame.get("status") == "accepted"),
                       "total": len(run["frames"]), "percent": 0,
                       "message": f"准备重试第 {index} 帧"}
    store.save_run(run)
    event = threading.Event()
    _CANCEL_EVENTS[run_id] = event
    _spawn(_retry_task, run_id, int(index), prompt, reference, images, overrides, event)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/approve")
def approve_run(run_id: str) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    try:
        runner.approve(run)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/export")
def export_run(run_id: str, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    try:
        run = store.load_run(run_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, "run 不存在") from exc
    if not all(frame.get("status") == "accepted" for frame in run.get("frames") or []):
        raise HTTPException(400, "还有未通过的帧")
    fps = int(payload.get("fps") or (run.get("animation") or {}).get("fps")
              or config.DEFAULT_FPS)
    raw_export = payload.get("export") if isinstance(payload.get("export"), dict) else {}
    fmt = str(raw_export.get("format") or payload.get("format") or "gif").lower()
    if fmt not in config.EXPORT_FORMATS:
        raise HTTPException(400, f"不支持的导出格式：{fmt}")
    if fmt in config.VIDEO_FORMATS and not motion.ffmpeg_available():
        raise HTTPException(400, "本机没有 ffmpeg，无法输出视频；请改用 GIF/APNG/WebP")
    # 导出选项落到 run.settings，重试/重导时还能沿用同一套参数
    settings = dict(run.get("settings") or {})
    settings["export"] = {
        **(settings.get("export") or {}),
        "format": fmt,
        "dither": bool(raw_export.get("dither", True)),
        "align": bool(raw_export.get("align", False)),
        "color_match": bool(raw_export.get("color_match", False)),
    }
    raw_motion = payload.get("motion")
    if isinstance(raw_motion, dict):
        settings["motion"] = {**(settings.get("motion") or {}), **raw_motion}
    raw_timeline = payload.get("timeline")
    if isinstance(raw_timeline, dict):
        settings["timeline"] = {**(settings.get("timeline") or {}), **raw_timeline}
    run["settings"] = settings
    run["status"] = "exporting"
    run["progress"] = {"stage": "exporting", "frame": len(run["frames"]), "attempt": 0,
                       "done": len(run["frames"]), "total": len(run["frames"]),
                       "percent": 100, "message": f"正在导出 {fmt.upper()}"}
    store.save_run(run)
    _spawn(_export_task, run_id, fps)
    return _public_run(run)


@app.post("/api/loop/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict[str, Any]:
    event = _CANCEL_EVENTS.get(run_id)
    if event:
        event.set()
    return {"ok": True, "run_id": run_id}


# ---------------------------------------------------------------- static

@app.middleware("http")
async def no_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") or path == "/" or path.endswith(
            (".html", ".js", ".css", ".json")):
        response.headers["Cache-Control"] = "no-store"
    return response


app.mount("/files", StaticFiles(directory=str(config.RUNS_DIR)), name="files")
app.mount("/src", StaticFiles(directory=str(WEB_DIR / "src")), name="src")
app.mount("/assets", StaticFiles(directory=str(WEB_DIR / "assets")), name="assets")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/favicon.svg")
def favicon() -> Response:
    return Response(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='16' fill='#faf8f4'/>"
        "<circle cx='32' cy='32' r='17' fill='none' stroke='#2f6b62' stroke-width='4'/>"
        "<circle cx='32' cy='32' r='6' fill='#b87340'/>"
        "</svg>",
        media_type="image/svg+xml")


@app.exception_handler(HTTPException)
def http_error(request, exc: HTTPException):
    return JSONResponse({"error": {"code": exc.status_code, "message": exc.detail}},
                        status_code=exc.status_code)
