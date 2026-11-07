"""FastAPI 入口：项目、帧导入、自动稳定、色彩一致、导出任务与静态托管。

路由风格对齐主项目 ``server/main.py``：

* 提交类接口返回 ``{job_id}``，前端轮询 ``/api/jobs/{id}``；
* 错误统一 ``{"error": {"code", "message"}}``；
* 图片地址统一 ``/files/...``；
* 前端静态文件禁用强缓存（主项目踩过的坑）。
"""
from __future__ import annotations

import base64
import copy
import io
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image as PILImage

from .. import __version__, config
from ..core import align as align_core
from ..core import color as color_core
from ..core import compose, encode, images, project, registry, sheet, timeline
from . import jobs

__all__ = ["app", "create_app"]


class ApiError(Exception):
    def __init__(self, message: str, *, code: str = "bad_request", status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


class Utf8JSONResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


# --------------------------------------------------------------------------- 数据访问


def _decode_payload(raw: Any) -> bytes:
    """接受 data URL、/files/ 路径、{data|url} 或原始 base64。"""
    if isinstance(raw, dict):
        for key in ("data", "dataUrl", "url"):
            if raw.get(key):
                return _decode_payload(raw[key])
        raise ApiError("图片对象缺少 data/url")
    text = str(raw or "").strip()
    if not text:
        raise ApiError("图片数据为空")
    if text.startswith("data:"):
        _, _, body = text.partition(",")
        try:
            return base64.b64decode(body)
        except (ValueError, TypeError) as exc:
            raise ApiError("data URL 解析失败") from exc
    if text.startswith("/files/"):
        try:
            return project.read_frame_bytes(text)
        except FileNotFoundError as exc:
            raise ApiError(f"图片不存在：{text}", code="not_found", status=404) from exc
    try:
        return base64.b64decode(text)
    except (ValueError, TypeError) as exc:
        raise ApiError("无法识别的图片数据（需要 data URL 或 /files/ 路径）") from exc


def _load_doc(body: dict[str, Any]) -> dict[str, Any]:
    """优先用请求里的 doc 快照；否则按 projectId 读盘。"""
    if isinstance(body.get("doc"), dict):
        doc = registry.normalize_doc(body["doc"], doc_id=str(body["doc"].get("id") or ""))
        if not doc["id"]:
            doc["id"] = registry.normalize_doc(body["doc"]).get("id") or body.get("projectId") or ""
        return doc
    project_id = str(body.get("projectId") or "").strip()
    if not project_id:
        raise ApiError("缺少 projectId 或 doc", code="missing_field")
    try:
        return project.load_project(project_id)
    except KeyError as exc:
        raise ApiError(f"项目不存在：{project_id}", code="not_found", status=404) from exc


def _persist(doc: dict[str, Any]) -> dict[str, Any]:
    if not doc.get("id"):
        base = project.create_doc(doc.get("name") or "未命名动画")
        doc["id"] = base["id"]
        doc["createdAt"] = doc.get("createdAt") or base["createdAt"]
    return project.save_project(doc)


def _frame_images(doc: dict[str, Any]) -> list[Any]:
    out = []
    for frame in doc.get("frames") or []:
        url = str(frame.get("url") or "")
        try:
            data = project.read_frame_bytes(url)
        except FileNotFoundError as exc:
            raise ApiError(f"帧「{frame.get('name')}」文件丢失：{url}", code="missing_frame", status=404) from exc
        out.append(images.decode_image(data))
    return out


def _make_frame(url: str, width: int, height: int, index: int, *,
                origin: str = "upload", name: str = "") -> dict[str, Any]:
    return registry.normalize_frame({
        "id": project.generate_frame_id(),
        "name": name or f"帧 {index + 1:02d}",
        "url": url,
        "width": int(width),
        "height": int(height),
        "origin": origin,
    }, index)


def _canvas_from(body_canvas: Any, fallback: tuple[int, int]) -> dict[str, Any]:
    raw = body_canvas if isinstance(body_canvas, dict) else {}
    canvas = registry.normalize_doc({"canvas": raw}).get("canvas") or {}
    if not raw.get("width") or not raw.get("height"):
        canvas["width"], canvas["height"] = int(fallback[0]), int(fallback[1])
    return canvas


# --------------------------------------------------------------------------- 应用


def create_app() -> FastAPI:
    config.ensure_dirs()
    queue = jobs.JobQueue(history_limit=int(config.DEFAULTS["history_limit"]))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        config.ensure_dirs()
        queue.start()
        yield
        queue.stop()

    app = FastAPI(title="定格动画 / GIF 工作台", version=__version__, lifespan=lifespan,
                  default_response_class=Utf8JSONResponse)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])

    @app.middleware("http")
    async def _no_cache(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith(("/src/", "/assets/")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status,
                            content={"error": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(registry.DocError)
    async def _doc_error(_request: Request, exc: registry.DocError) -> JSONResponse:
        return JSONResponse(status_code=400,
                            content={"error": {"code": "invalid_doc", "message": str(exc)}})

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={
            "error": {"code": "internal_error", "message": f"{type(exc).__name__}: {exc}"}
        })

    # ---------------------------------------------------------------- 基础

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "queue": queue.stats(),
            "data_dir": str(config.DATA_DIR),
            "projects": len(project.list_projects()),
            "formats": list(registry.EXPORT_FORMATS),
        }

    @app.get("/api/options")
    def options() -> dict[str, Any]:
        payload = registry.public_options()
        payload["defaults"]["canvas"]["width"] = int(config.DEFAULTS["canvas_width"])
        payload["defaults"]["canvas"]["height"] = int(config.DEFAULTS["canvas_height"])
        payload["defaults"]["timeline"]["fps"] = int(config.DEFAULTS["fps"])
        return payload

    # ---------------------------------------------------------------- 项目

    @app.get("/api/projects")
    def projects() -> dict[str, Any]:
        return {"items": project.list_projects()}

    @app.post("/api/projects")
    def project_create(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        canvas = _canvas_from(payload.get("canvas"), (
            int(config.DEFAULTS["canvas_width"]), int(config.DEFAULTS["canvas_height"])
        ))
        doc = project.create_doc(str(payload.get("name") or "未命名动画"), canvas=canvas,
                                 timeline=payload.get("timeline"))
        doc = project.save_project(doc)
        return {"project": doc}

    @app.get("/api/projects/{project_id}")
    def project_get(project_id: str) -> dict[str, Any]:
        try:
            return {"project": project.load_project(project_id)}
        except KeyError as exc:
            raise ApiError("项目不存在", code="not_found", status=404) from exc

    @app.put("/api/projects/{project_id}")
    def project_put(project_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        raw = payload.get("project") if isinstance(payload.get("project"), dict) else payload
        doc = registry.normalize_doc(raw, doc_id=project_id)
        doc["id"] = project_id
        if not doc["createdAt"]:
            try:
                doc["createdAt"] = project.load_project(project_id).get("createdAt") or ""
            except KeyError:
                doc["createdAt"] = project.now()
        doc = project.save_project(doc, project_id)
        return {"project": doc}

    @app.delete("/api/projects/{project_id}")
    def project_delete(project_id: str) -> dict[str, Any]:
        if not project.delete_project(project_id):
            raise ApiError("项目不存在", code="not_found", status=404)
        return {"ok": True, "id": project_id}

    # ---------------------------------------------------------------- 导入

    @app.post("/api/import/sheet")
    def import_sheet(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        raw = payload.get("image")
        if not raw:
            raise ApiError("缺少 image", code="missing_field")
        data = _decode_payload(raw)
        image = images.decode_image(data, keep_alpha=True)

        grid = payload.get("grid") if isinstance(payload.get("grid"), dict) else {}
        import_opts = registry.normalize_import(payload.get("import"))
        try:
            result = sheet.split_sheet(
                image,
                rows=int(grid.get("rows") or 4),
                columns=int(grid.get("columns") or 4),
                row_gap=int(grid.get("rowGap") or 0),
                column_gap=int(grid.get("columnGap") or 0),
                order=str(grid.get("order") or "row-major"),
                trim=str(grid.get("trim") or "union"),
                padding=int(grid.get("padding") or 0),
                fit=str(import_opts.get("fit") or "pad"),
                anchor=str(import_opts.get("anchor") or "center"),
            )
        except ValueError as exc:
            raise ApiError(str(exc), code="invalid_grid") from exc

        project_id = str(payload.get("projectId") or "").strip()
        if project_id:
            try:
                doc = project.load_project(project_id)
            except KeyError as exc:
                raise ApiError("项目不存在", code="not_found", status=404) from exc
        else:
            doc = project.create_doc(str(payload.get("name") or "宫格动画"))

        canvas = _canvas_from(payload.get("canvas"), result.size)
        if not doc.get("frames") or import_opts.get("replace"):
            doc["canvas"] = canvas

        frames: list[dict[str, Any]] = []
        for index, frame_image in enumerate(result.frames):
            saved = project.save_frame(doc["id"], images.encode_png(frame_image),
                                       stem=f"sheet-{index + 1:02d}")
            frames.append(_make_frame(saved["url"], frame_image.width, frame_image.height,
                                      index, origin="sheet"))
        doc["frames"] = frames if import_opts.get("replace") else list(doc.get("frames") or []) + frames
        doc["source"] = {
            "type": "sheet",
            "importedAt": project.now(),
            "sheet": {
                "rows": result.meta["rows"],
                "columns": result.meta["columns"],
                "rowGap": result.meta["rowGap"],
                "columnGap": result.meta["columnGap"],
                "order": result.meta["order"],
                "trim": result.meta["trim"],
                "padding": result.meta["padding"],
            },
        }
        doc = project.save_project(doc)
        return {
            "project": doc,
            "frames": frames,
            "split": {
                "size": list(result.size),
                "bbox": list(result.bbox),
                "rects": [list(rect) for rect in result.rects],
                "meta": result.meta,
            },
            "warnings": result.warnings + (["尺寸不一致的帧已用透明补边统一"] if result.warnings else []),
        }

    @app.post("/api/import/frames")
    def import_frames(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        raws = payload.get("images")
        if not isinstance(raws, list) or not raws:
            raise ApiError("images 必须是非空数组", code="missing_field")
        if len(raws) > 512:
            raise ApiError("一次最多导入 512 张")
        import_opts = registry.normalize_import(payload.get("import"))
        decoded = []
        for index, raw in enumerate(raws):
            image = images.decode_image(_decode_payload(raw), keep_alpha=True)
            name = ""
            if isinstance(raw, dict):
                name = str(raw.get("name") or "")
            decoded.append((image, name, index))

        if import_opts.get("fit") == "stretch":
            width = max(item[0].width for item in decoded)
            height = max(item[0].height for item in decoded)
            prepared = [(images.resize(image, (width, height)), name, index)
                        for image, name, index in decoded]
            warning = "统一尺寸使用了拉伸缩放"
        else:
            width = max(item[0].width for item in decoded)
            height = max(item[0].height for item in decoded)
            prepared = []
            for image, name, index in decoded:
                if image.size == (width, height):
                    prepared.append((image, name, index))
                else:
                    canvas_image = PILImage.new("RGBA", (width, height), (0, 0, 0, 0))
                    left = (width - image.width) // 2
                    anchor = str(import_opts.get("anchor") or "center")
                    top = 0 if anchor == "top" else (
                        height - image.height if anchor == "bottom" else (height - image.height) // 2)
                    canvas_image.alpha_composite(image, (left, top))
                    prepared.append((canvas_image, name, index))
            warning = ""

        project_id = str(payload.get("projectId") or "").strip()
        if project_id:
            try:
                doc = project.load_project(project_id)
            except KeyError as exc:
                raise ApiError("项目不存在", code="not_found", status=404) from exc
        else:
            doc = project.create_doc(str(payload.get("name") or "定格动画"))

        if not doc.get("frames") or import_opts.get("replace"):
            doc["canvas"] = _canvas_from(payload.get("canvas"), (width, height))

        frames: list[dict[str, Any]] = []
        for image, name, index in prepared:
            saved = project.save_frame(doc["id"], images.encode_png(image), stem=f"frame-{index + 1:02d}")
            frames.append(_make_frame(saved["url"], image.width, image.height, index,
                                      origin="upload", name=name))
        doc["frames"] = frames if import_opts.get("replace") else list(doc.get("frames") or []) + frames
        doc["source"] = {"type": "images", "importedAt": project.now()}
        doc = project.save_project(doc)
        warnings = [warning] if warning else []
        return {"project": doc, "frames": frames, "size": [width, height], "warnings": warnings}

    # ---------------------------------------------------------------- 处理

    @app.post("/api/align")
    def align_frames(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        doc = _load_doc(payload)
        if not doc.get("frames"):
            raise ApiError("时间轴为空", code="empty_timeline")
        settings = doc.get("processing", {}).get("align") or {}
        reference = str(payload.get("reference") or settings.get("reference") or "first")
        max_shift = int(payload.get("maxShift") if payload.get("maxShift") is not None
                        else settings.get("maxShift") or 64)
        confidence = float(payload.get("confidence") if payload.get("confidence") is not None
                           else settings.get("confidence") or 0.08)
        images_list = _frame_images(doc)
        report = align_core.estimate_offsets(
            doc["frames"], images_list, reference=reference,
            max_shift=max_shift, confidence=confidence,
        )
        before = align_core.jitter_metric(images_list)
        doc["frames"] = align_core.apply_offsets(doc["frames"], report)
        doc["processing"]["align"] = {"reference": reference, "maxShift": max_shift,
                                      "confidence": confidence}
        doc = _persist(doc)
        body = report.to_dict()
        body["jitter_before"] = before
        return {"project": doc, "report": body}

    @app.post("/api/color-match")
    def color_match(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        doc = _load_doc(payload)
        if not doc.get("frames"):
            raise ApiError("时间轴为空", code="empty_timeline")
        settings = doc.get("processing", {}).get("color") or {}
        reference = str(payload.get("reference") or settings.get("reference") or "median")
        strength = float(payload.get("strength") if payload.get("strength") is not None
                         else settings.get("strength") or 0.8)
        scope = str(payload.get("scope") or settings.get("scope") or "subject")

        sources = []
        for frame in doc["frames"]:
            url = str(frame.get("sourceUrl") or frame.get("url") or "")
            try:
                sources.append(images.decode_image(project.read_frame_bytes(url)))
            except FileNotFoundError as exc:
                raise ApiError(f"帧文件丢失：{url}", code="missing_frame", status=404) from exc
        outputs, report = color_core.deflicker(
            doc["frames"], sources, reference=reference, strength=strength, scope=scope,
        )
        for frame, output in zip(doc["frames"], outputs):
            saved = project.save_frame(doc["id"], images.encode_png(output),
                                       stem=f"{frame.get('name') or 'frame'}-color")
            if not frame.get("sourceUrl"):
                frame["sourceUrl"] = frame.get("url") or ""
            frame["url"] = saved["url"]
            frame["width"], frame["height"] = output.width, output.height
        doc["processing"]["color"] = {"reference": reference, "strength": strength, "scope": scope}
        doc = _persist(doc)
        return {"project": doc, "report": report.to_dict()}

    @app.post("/api/color-match/revert")
    def color_revert(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        doc = _load_doc(payload)
        frame_ids = {str(item) for item in (payload.get("frameIds") or [])}
        restored = 0
        for frame in doc.get("frames") or []:
            if frame_ids and str(frame.get("id")) not in frame_ids:
                continue
            source_url = str(frame.get("sourceUrl") or "")
            if not source_url:
                continue
            frame["url"] = source_url
            frame["sourceUrl"] = ""
            restored += 1
        doc = _persist(doc)
        return {"project": doc, "restored": restored}

    # ---------------------------------------------------------------- 导出

    @app.post("/api/export")
    def export(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        doc = _load_doc(payload)
        registry.validate_doc(doc)
        fmt = str(payload.get("format") or "gif")
        options = registry.normalize_export(fmt, payload.get("options"))
        snapshot = copy.deepcopy(doc)

        def run(job: jobs.Job) -> None:
            total = max(1, len(snapshot.get("frames") or []))
            steps = max(1, len(timeline.expanded_sequence(snapshot)))
            overall = total + steps
            job.set_progress(0, overall, "加载帧")

            def loader(url: str) -> Any:
                return images.decode_image(project.read_frame_bytes(url))

            def progress(value: int, maximum: int, label: str) -> None:
                scaled = int(round(total * min(value, maximum) / max(1, maximum)))
                job.set_progress(scaled, overall, label)

            rendered = compose.render_doc(snapshot, loader, progress=progress,
                                          cancel=lambda: job.cancel_requested)
            job.set_progress(total, overall, "编码中")
            result = encode.export_animation(
                snapshot, rendered, fmt, options,
                out_dir=config.EXPORTS_DIR,
                url_for=config.url_for,
                progress=lambda value, maximum, label: job.set_progress(
                    total + min(value, maximum), overall, label),
                cancel=lambda: job.cancel_requested,
            )
            result["project_id"] = snapshot.get("id")
            result["project_name"] = snapshot.get("name")
            job.result = result
            job.set_progress(overall, overall, "完成")

        job = queue.submit("export", run, params={"format": fmt},
                           meta={"project_id": doc.get("id"), "project_name": doc.get("name")})
        return {"job_id": job.id, "status": job.status}

    @app.get("/api/jobs/{job_id}")
    def job_get(job_id: str) -> dict[str, Any]:
        job = queue.get(job_id)
        if job is None:
            raise ApiError("任务不存在", code="not_found", status=404)
        return job.to_dict()

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str) -> dict[str, Any]:
        if not queue.cancel(job_id):
            raise ApiError("任务不存在或已结束", code="not_found", status=404)
        return {"ok": True, "job_id": job_id}

    @app.get("/api/history")
    def history(limit: int = 30) -> dict[str, Any]:
        return {"items": queue.history(limit=max(1, min(int(limit), 200)))}

    # ---------------------------------------------------------------- 静态

    app.mount("/files", StaticFiles(directory=str(config.DATA_DIR)), name="files")
    for sub in ("src", "assets"):
        folder = config.WEB_DIR / sub
        folder.mkdir(parents=True, exist_ok=True)
        app.mount(f"/{sub}", StaticFiles(directory=str(folder)), name=sub)

    @app.get("/")
    def index() -> FileResponse:
        path = config.WEB_DIR / "index.html"
        if not path.is_file():
            raise ApiError("前端缺失：web/index.html", code="no_frontend", status=404)
        return FileResponse(path, media_type="text/html; charset=utf-8")

    @app.get("/favicon.ico")
    @app.get("/favicon.svg")
    def favicon() -> Any:
        path = config.WEB_DIR / "favicon.svg"
        if path.is_file():
            return FileResponse(path, media_type="image/svg+xml")
        return JSONResponse(status_code=204, content=None)

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run("animation_kit.server.app:app", host=config.HOST, port=config.PORT,
                log_level="info", reload=False)


if __name__ == "__main__":
    main()
