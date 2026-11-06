"""FastAPI 入口：HTTP 路由 + 静态托管 + 任务提交。

启动方式（见 scripts/run.ps1）：

    python -m uvicorn server.main:app --host 127.0.0.1 --port 8700

或直接：

    python -m server.main
"""
from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import (
    __version__, config, imageops, imaging, jobs, materials, pipeline, prompt_polish,
    storage, styles,
)
from . import models as image_models

# --------------------------------------------------------------------------- 单例


_QUEUE: jobs.JobQueue | None = None
_PIPELINE: pipeline.Pipeline | None = None
_OLLAMA_CACHE: dict[str, Any] = {"at": 0.0, "data": None}


class Utf8JSONResponse(JSONResponse):
    """显式声明 UTF-8，避免部分客户端（如 Windows PowerShell）把中文按 Latin-1 解码成乱码。"""

    media_type = "application/json; charset=utf-8"


def get_queue() -> jobs.JobQueue:
    global _QUEUE
    if _QUEUE is None:
        _QUEUE = jobs.JobQueue()
    return _QUEUE


def get_pipeline() -> pipeline.Pipeline:
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = pipeline.Pipeline()
    return _PIPELINE


_IDLE_WATCHDOG_STARTED = False


def _start_idle_watchdog() -> None:
    """空闲自动卸载显存的看护线程。

    用户桌面机器上常见场景是：出几张图之后去干别的，模型 16GB 一直占着显存。
    这里在「队列空闲 + 超过 config.idle_unload_minutes 分钟」后自动 unload，
    下次出图再按需重新加载（首次会慢 20~60 秒，但显存能还回去）。
    """
    global _IDLE_WATCHDOG_STARTED
    if _IDLE_WATCHDOG_STARTED:
        return
    _IDLE_WATCHDOG_STARTED = True

    def _loop() -> None:
        while True:
            time.sleep(30)
            try:
                cfg = config.load_config()
                minutes = float(cfg.get("idle_unload_minutes") or 0)
                if minutes <= 0:
                    continue
                pipe = get_pipeline()
                engine = getattr(pipe, "_engine", None)
                if engine is None:
                    continue
                loaded = (engine.status() or {}).get("loaded") or {}
                if not any(loaded.get(k) for k in ("unet", "clip", "vae")):
                    continue
                idle = time.time() - get_queue().last_activity()
                if idle >= minutes * 60:
                    engine.free(unload=True)
                    print(f"[idle] 空闲 {idle / 60:.0f} 分钟，已卸载模型释放显存", flush=True)
            except Exception as exc:  # noqa: BLE001 - 看护线程绝不能死
                print(f"[idle] 看护线程异常（已忽略）：{type(exc).__name__}: {exc}", flush=True)

    threading.Thread(target=_loop, name="q2i-idle-watchdog", daemon=True).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    get_queue().start()
    _start_idle_watchdog()
    yield
    queue = get_queue()
    queue.stop()


app = FastAPI(
    title="Qwen-Image 2.1 工作台",
    version=__version__,
    lifespan=lifespan,
    default_response_class=Utf8JSONResponse,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _log_runtime_banner() -> None:
    """打印运行环境并把「性能陷阱」直接喊出来。

    引擎的 int8 权重靠 comfy_kitchen 的原生 CUDA 算子加速，而那些算子要求
    torch 的 CUDA >= 13（cu130）。若进程里是 cu128，算子会被禁用、退回 eager，
    采样会掉到 sm80 wmma 慢路径（实测同一张图 12s vs 4s）。
    最容易踩的坑：系统里装了 torch 到 user site-packages，会覆盖 python 自带的那份。
    """
    try:
        import torch

        cuda = torch.version.cuda or "?"
        line = f"torch {torch.__version__} (CUDA {cuda}) | file={torch.__file__}"
        print(f"[env] {line}", flush=True)
        major = 0
        try:
            major = int(str(cuda).split(".")[0])
        except (TypeError, ValueError):
            major = 0
        if major and major < 13:
            print(
                "[env] ⚠ torch 的 CUDA < 13：comfy_kitchen 的 int8 原生算子不可用，"
                "采样会慢约 3 倍。请用 `python -s` 启动（启动器已自动加）或换 cu130 torch。",
                flush=True,
            )
    except Exception:  # pragma: no cover - 环境缺 torch 时不影响服务
        pass


_log_runtime_banner()


# --------------------------------------------------------------------------- 错误


class ApiError(Exception):
    def __init__(self, message: str, *, code: str = "bad_request", status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


@app.exception_handler(ApiError)
async def _api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(Exception)
async def _unhandled_handler(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": f"{type(exc).__name__}: {exc}"}},
    )


# --------------------------------------------------------------------------- 工具


def _vram() -> dict[str, Any]:
    try:
        import torch  # 只有引擎加载过才在 sys.modules，这里代价很小

        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            return {
                "device": torch.cuda.get_device_name(0),
                "vram_free_mb": int(free / (1024 ** 2)),
                "vram_total_mb": int(total / (1024 ** 2)),
            }
    except Exception:  # noqa: BLE001
        pass
    return {"device": "", "vram_free_mb": 0, "vram_total_mb": 0}


def _ollama_health(ttl: float = 10.0) -> dict[str, Any]:
    now = time.time()
    if _OLLAMA_CACHE["data"] is not None and now - _OLLAMA_CACHE["at"] < ttl:
        return _OLLAMA_CACHE["data"]
    cfg = config.load_config()
    data: dict[str, Any]
    try:
        models = prompt_polish.available_models()
        data = {"connected": bool(models), "models": models}
    except Exception as exc:  # noqa: BLE001
        data = {"connected": False, "models": [], "error": str(exc)}
    data["url"] = cfg.get("ollama_url")
    _OLLAMA_CACHE.update({"at": now, "data": data})
    return data


def _engine_health() -> dict[str, Any]:
    """轻量体检：未加载模型时不实例化引擎（避免 health 轮询触发 torch 导入）。"""
    cfg = config.load_config()
    engine_dir = config.find_engine_dir(cfg)
    paths = config.default_model_paths(cfg)
    missing = [k for k in ("unet", "clip", "vae") if not paths.get(k)]
    pipe = get_pipeline()
    if getattr(pipe, "_engine", None) is not None:
        info = pipe.status()
    else:
        info = {
            "available": bool(engine_dir) and not missing,
            "reason": (
                None if engine_dir and not missing
                else ("引擎未移植：engine/comfy 不存在" if not engine_dir
                      else f"默认模型缺失：{', '.join(missing)}")
            ),
            "loaded": {"unet": None, "clip": None, "vae": None, "loras": []},
        }
    info.setdefault("engine_dir", engine_dir)
    # 契约里字段叫 ready，历史上实现返回 available，这里两个都给，前端/脚本都兼容
    info.setdefault("ready", bool(info.get("available")))
    info.setdefault("available", bool(info.get("ready")))
    info["idle_seconds"] = int(time.time() - get_queue().last_activity())
    info["resident"] = bool((info.get("loaded") or {}).get("unet"))
    info["idle_unload_minutes"] = cfg.get("idle_unload_minutes")
    info.update(_vram())
    return info


def _require(payload: dict[str, Any], key: str, *, label: str | None = None) -> Any:
    value = payload.get(key)
    if value in (None, "", [], {}):
        raise ApiError(f"缺少必填字段 {label or key}", code="missing_field")
    return value


# --------------------------------------------------------------------------- 基础路由


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    cfg = config.load_config()
    queue = get_queue()
    ollama_info = _ollama_health()
    return {
        "ok": True,
        "version": __version__,
        "engine": _engine_health(),
        "ollama": ollama_info,
        "queue": queue.stats(),
        "storage": config.disk_usage(),
        "outputs": storage.count_outputs(),
        "config": {
            "model_root": cfg.get("model_root"),
            "engine_dir": cfg.get("engine_dir"),
            "idle_unload_minutes": cfg.get("idle_unload_minutes"),
            "has_default_models": all(config.default_model_paths(cfg).values()),
        },
    }


@app.get("/api/options")
def api_options() -> dict[str, Any]:
    cfg = config.load_config()
    paths = config.default_model_paths(cfg)
    models = config.scan_models(cfg)
    # 加速 LoRA 单独一份候选（已按兼容性/体积排好序），供 Turbo 面板下拉选择
    models["turbo_lora"] = config.turbo_lora_candidates(cfg)
    return {
        "models": models,
        # 图像模型档案（协议 + 每模型 profile）：前端据此切换模型 / 步数 / 加速 / 边界框
        "model_profiles": image_models.public_list(cfg),
        "default_model": image_models.normalize_model(cfg.get("model")),
        "samplers": config.SAMPLERS,
        "schedulers": config.SCHEDULERS,
        "ratios": config.RATIOS,
        "megapixels": [1.0, 2.0, 2.2, 4.0],
        "turbo_profiles": config.turbo_profiles_public(cfg),
        "steps_presets": config.STEPS_PRESETS,
        "defaults": {
            "unet": cfg.get("unet"),
            "clip": cfg.get("clip"),
            "vae": cfg.get("vae"),
            "turbo_lora": cfg.get("turbo_lora"),
            "consistency_lora": cfg.get("consistency_lora"),
            "steps": cfg["steps"],
            "cfg": cfg["cfg"],
            "sampler": cfg["sampler"],
            "scheduler": cfg["scheduler"],
            "width": cfg["width"],
            "height": cfg["height"],
            "turbo_profile": cfg["turbo_profile"],
            "resolved": {k: (os.path.basename(v) if v else None) for k, v in paths.items()},
        },
        "capabilities": {
            "precise_align": True,
            "bluebox_io": True,
            "custom_sigmas": True,
            "rgba": True,
            "max_ref_images": 10,
            "local_edit_schemes": ["a", "b"],
            "size_modes": ["follow", "custom", "ratio", "fixed_point"],
            "fits": ["pad", "crop"],
            "ollama": _ollama_health().get("connected", False),
        },
        "turbo_sigmas_help": (
            "Turbo 加速按预设执行：选「自动挂 Turbo LoRA」会挂载对应的加速 LoRA；"
            "选「自动切换 Turbo 底模」会把扩散模型换成仓库里的 Turbo 权重且不挂加速 LoRA。"
            "开启后自动沿用上次选择的预设，其他 LoRA 仍可手动叠加。"
        ),
    }


# --------------------------------------------------------------------------- 提示词与风格


@app.post("/api/polish")
def api_polish(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ApiError("提示词不能为空")
    mode = str(payload.get("mode") or "t2i")
    if mode not in ("t2i", "edit"):
        raise ApiError("mode 只能是 t2i 或 edit")
    # 目标模型决定 system prompt（qwen / moss 各有一份 PE 写作规范）
    image_model = payload.get("image_model") or payload.get("model_profile") or "qwen"
    target_size = payload.get("target_size") or payload.get("target")
    if not target_size and payload.get("width") and payload.get("height"):
        target_size = [payload.get("width"), payload.get("height")]
    references = payload.get("references") or payload.get("images_info")
    # 参考图本体（data URL）：润色模型支持视觉时随消息发过去，让它真的"看到"图
    reference_images: list[Any] = []
    for entry in (payload.get("images") or []):
        try:
            reference_images.append(imaging.decode_image(pipeline._entry_bytes(entry),
                                                        keep_alpha=False))
        except Exception:  # noqa: BLE001 - 单张图坏了不影响润色
            continue
    try:
        result = prompt_polish.polish(
            prompt,
            mode=mode,
            model=payload.get("model") or None,
            fallback=bool(payload.get("fallback", True)),
            image_model=image_model,
            target_size=target_size,
            references=references,
            reference_images=reference_images or None,
        )
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"提示词润色失败：{exc}", code="polish_failed", status=502) from exc
    _OLLAMA_CACHE["data"] = None  # 下次 health 重新探测
    return result


@app.get("/api/styles")
def api_styles() -> dict[str, Any]:
    try:
        return styles.load_catalogs()
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"风格库加载失败：{exc}", code="styles_failed", status=500) from exc


@app.get("/api/styles/angle-prompt")
def api_angle_prompt(azimuth: str | None = None, elevation: str | None = None,
                     zoom: str | None = None) -> dict[str, Any]:
    getter = getattr(styles, "angle_prompt_from_query", None)
    if getter is None:
        prompt = styles.angle_prompt(
            {"azimuth": float(azimuth or 0), "elevation": float(elevation or 0),
             "zoom": float(zoom if zoom is not None else 5)})
    else:
        prompt = getter(azimuth, elevation, zoom)
    return {"prompt": prompt, "query": {"azimuth": azimuth, "elevation": elevation, "zoom": zoom}}


# --------------------------------------------------------------------------- 生成


def _submit(kind: str, payload: dict[str, Any], *, prompt: str) -> dict[str, Any]:
    queue = get_queue()
    pipe = get_pipeline()
    job = queue.submit(
        kind,
        lambda j: pipe.generate(j),
        prompt=prompt,
        params=payload,
        meta=payload.get("meta") or {},
    )
    return {"job_id": job.id, "status": job.status}


@app.post("/api/generate")
def api_generate(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prompt = str(_require(payload, "prompt", label="提示词") or "").strip()
    cfg = config.load_config()
    try:
        profile = image_models.get(cfg, payload.get("model"))
    except ValueError as exc:
        raise ApiError(str(exc), code="bad_model") from exc
    # 只给 ratio（MOSS 的 ResolutionSelector 用法）时不要塞默认宽高，交给管线算
    payload["prompt"] = prompt
    payload["model"] = profile["id"]
    if payload.get("ratio") and not payload.get("width") and not payload.get("height"):
        payload.pop("width", None)
        payload.pop("height", None)
    else:
        width = int(payload.get("width") or profile["width"])
        height = int(payload.get("height") or profile["height"])
        if width > int(cfg["max_side"]) or height > int(cfg["max_side"]):
            raise ApiError(f"尺寸超限：最大单边 {cfg['max_side']}")
        payload["width"] = width
        payload["height"] = height
    return _submit("t2i", payload, prompt=prompt)


@app.post("/api/edit")
def api_edit(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    prompt = str(_require(payload, "prompt", label="编辑指令") or "").strip()
    images = _require(payload, "images", label="输入图片")
    if not isinstance(images, list) or not images:
        raise ApiError("images 必须是非空数组（第 1 张是编辑目标）")
    if len(images) > 10:
        raise ApiError("最多支持 10 张参考图")
    payload["prompt"] = prompt
    payload["images"] = images
    return _submit("edit", payload, prompt=prompt)


# --------------------------------------------------------------------------- 任务与历史


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict[str, Any]:
    job = get_queue().get(job_id)
    if job is None:
        raise ApiError(f"任务不存在：{job_id}", code="not_found", status=404)
    return job.to_dict()


@app.post("/api/jobs/{job_id}/cancel")
def api_cancel(job_id: str) -> dict[str, Any]:
    ok = get_queue().cancel(job_id)
    if not ok:
        raise ApiError("任务不存在或已结束", code="not_found", status=404)
    return {"ok": True, "job_id": job_id}


@app.get("/api/jobs/{job_id}/replay.json")
def api_job_replay(job_id: str) -> dict[str, Any]:
    """导出可复现的请求参数（不含图片二进制，只留文件 URL）。"""
    job = get_queue().get(job_id)
    if job is None:
        raise ApiError(f"任务不存在：{job_id}", code="not_found", status=404)

    def _strip(entry: Any) -> Any:
        if isinstance(entry, dict) and isinstance(entry.get("data"), str) \
                and entry["data"].startswith("data:"):
            out = {k: v for k, v in entry.items() if k != "data"}
            out["data"] = "<binary omitted>"
            return out
        return entry

    params = dict(job.params)
    for key in ("images", "mask"):
        if key in params:
            value = params[key]
            params[key] = [_strip(v) for v in value] if isinstance(value, list) else _strip(value)
    return {
        "job": {"id": job.id, "kind": job.kind, "prompt": job.prompt},
        "params": params,
        "meta": job.meta,
        "align": job.align,
        "quality": job.quality,
        "replay_hint": "把 params 原样 POST 到 /api/generate 或 /api/edit（图片需重新上传成 data URL）",
    }


@app.get("/api/history")
def api_history(limit: int = 30) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    return {"items": get_queue().history(limit=limit)}


@app.delete("/api/history")
def api_history_clear() -> dict[str, Any]:
    get_queue().clear_history()
    return {"ok": True}


@app.delete("/api/history/{job_id}")
def api_history_delete(job_id: str) -> dict[str, Any]:
    if not get_queue().delete(job_id):
        raise ApiError("记录不存在或任务仍在运行", code="not_found", status=404)
    return {"ok": True, "job_id": job_id}


# --------------------------------------------------------------------------- 素材仓库
#
# 只保存用户主动收藏 / 上传的内容；图片复制到 storage/materials/，
# 与 outputs、history 解耦，清理历史不会影响仓库。


@app.get("/api/materials")
def api_materials(
    kind: str = "",
    category: str = "",
    q: str = "",
    limit: int = 200,
) -> dict[str, Any]:
    return {
        "items": materials.list_materials(
            kind=kind or None,
            category=category or None,
            q=q or None,
            limit=limit,
        )
    }


@app.post("/api/materials")
def api_material_create(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        item = materials.create_material(payload)
    except ValueError as exc:
        raise ApiError(str(exc), code="invalid_material") from exc
    return {"item": item}


@app.post("/api/materials/upload")
async def api_material_upload(
    file: UploadFile = File(...),
    title: str = Form(""),
    category: str = Form(""),
) -> dict[str, Any]:
    data = await file.read()
    try:
        item = materials.create_upload(
            data,
            filename=file.filename or "upload.png",
            title=title or None,
            category=category or None,
        )
    except ValueError as exc:
        raise ApiError(str(exc), code="invalid_material") from exc
    return {"item": item}


@app.patch("/api/materials/{material_id}")
def api_material_update(material_id: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        item = materials.update_material(material_id, payload)
    except KeyError as exc:
        raise ApiError("素材不存在", code="not_found", status=404) from exc
    except ValueError as exc:
        raise ApiError(str(exc), code="invalid_material") from exc
    return {"item": item}


@app.delete("/api/materials/{material_id}")
def api_material_delete(material_id: str) -> dict[str, Any]:
    if not materials.delete_material(material_id):
        raise ApiError("素材不存在", code="not_found", status=404)
    return {"ok": True, "id": material_id}


def _decode_image_payload(raw: Any) -> bytes:
    """接受 data URL 或 /files/ 路径，返回原始字节。"""
    if isinstance(raw, dict):
        raw = raw.get("data") or raw.get("url") or ""
    text = str(raw or "")
    if not text:
        raise ApiError("图片数据为空")
    if text.startswith("data:"):
        _mime, data = imaging.parse_data_url(text)
        return data
    if text.startswith("/files/"):
        path = storage.resolve_storage_path(text[len("/files/"):])
        with open(path, "rb") as fh:
            return fh.read()
    raise ApiError("无法识别的图片数据（需要 data URL 或 /files/ 路径）")


# --------------------------------------------------------------------------- 图像处理
#
# 服务端 Pillow 做裁剪/宫格/旋转/缩放/调色/32 对齐，结果直接落 storage/outputs，
# 可以立刻被「送入图生图 / 局部重绘」引用。前端的 canvas 版只做实时预览。


@app.post("/api/image/process")
def api_image_process(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    raw = payload.get("image")
    if not raw:
        raise ApiError("缺少 image（data URL 或 /files/ 路径）", code="missing_field")
    try:
        data = _decode_image_payload(raw)  # data URL 或 /files/ 路径
    except ApiError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"图片数据无法解析：{exc}") from exc
    try:
        result = imageops.process(data, payload)
    except imageops.ImageOpsError as exc:
        raise ApiError(str(exc), code="invalid_ops") from exc
    return result


@app.post("/api/image/outpaint-plan")
def api_outpaint_plan(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """扩图规划：给前端算画布尺寸、原图偏移与新增区域。"""
    width = int(payload.get("width") or 0)
    height = int(payload.get("height") or 0)
    if width <= 0 or height <= 0:
        raise ApiError("需要提供原图宽高（width / height）")
    direction = str(payload.get("direction") or "right")
    if direction not in ("left", "right", "up", "down", "horizontal", "vertical", "all"):
        raise ApiError("direction 只能是 left/right/up/down/horizontal/vertical/all")
    try:
        amount = float(payload.get("amount", 0.5))
    except (TypeError, ValueError) as exc:
        raise ApiError("amount 必须是数字") from exc
    return imageops.outpaint_plan(width, height, direction=direction, amount=amount)


# --------------------------------------------------------------------------- 引擎/文件


@app.post("/api/engine/free")
def api_engine_free(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """释放显存：unload=False 只清缓存，True 卸载模型。"""
    pipe = get_pipeline()
    engine = getattr(pipe, "_engine", None)
    if engine is None:
        return {"ok": True, "note": "引擎尚未加载"}
    engine.free(unload=bool(payload.get("unload")))
    return {"ok": True, "unload": bool(payload.get("unload"))}


@app.post("/api/engine/warmup")
def api_engine_warmup() -> dict[str, Any]:
    """预加载默认模型（首次出图前跑一次，避免请求里等 20~60 秒）。"""
    pipe = get_pipeline()
    engine = pipe.engine
    cfg = config.load_config()
    paths = config.default_model_paths(cfg)
    loaded_before = bool((engine.status().get("loaded") or {}).get("unet"))
    engine.ensure_loaded(unet=paths["unet"], clip=paths["clip"], vae=paths["vae"])
    warmup_s = None
    if not loaded_before:
        try:
            warmup_s = engine.warmup()
        except Exception:  # noqa: BLE001 - 预热失败不影响服务
            warmup_s = None
    return {"ok": True, "warmup_s": warmup_s, "loaded": engine.status().get("loaded")}


@app.post("/api/upload")
async def api_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    if not data:
        raise ApiError("上传文件为空")
    try:
        meta = storage.save_upload(data, orig_name=file.filename)
    except ValueError as exc:
        raise ApiError(str(exc), code="unsupported_format") from exc
    return meta


# --------------------------------------------------------------------------- 静态托管

config.ensure_dirs()

app.mount("/files", StaticFiles(directory=config.STORAGE_DIR), name="files")
for _sub in ("src", "assets", "vendor"):
    _dir = os.path.join(config.WEB_DIR, _sub)
    os.makedirs(_dir, exist_ok=True)
    app.mount(f"/{_sub}", StaticFiles(directory=_dir), name=_sub)

# 风格库预览图（复用 image-style-kit 原项目 public/ 下的资源，约 107MB）
# 目录 JSON 里的 preview/thumbnail 就是 /creative-presets/xxx.webp 这种绝对路径
for _sub in ("creative-presets", "mj-styles"):
    _dir = os.path.join(config.WEB_DIR, _sub)
    if os.path.isdir(_dir):
        app.mount(f"/{_sub}", StaticFiles(directory=_dir), name=_sub)


@app.get("/")
def index() -> FileResponse:
    path = os.path.join(config.WEB_DIR, "index.html")
    if not os.path.isfile(path):
        raise ApiError("前端未构建：web/index.html 不存在", code="no_frontend", status=404)
    return FileResponse(path, media_type="text/html; charset=utf-8")


@app.get("/favicon.ico")
def favicon() -> Any:
    path = os.path.join(config.WEB_DIR, "favicon.ico")
    if os.path.isfile(path):
        return FileResponse(path)
    return JSONResponse(status_code=204, content=None)


def main() -> None:
    import uvicorn

    cfg = config.load_config()
    uvicorn.run(
        "server.main:app",
        host=str(cfg["host"]),
        port=int(cfg["port"]),
        log_level="info",
        reload=False,
    )


if __name__ == "__main__":
    main()
