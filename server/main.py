"""FastAPI 入口：HTTP 路由 + 静态托管 + 任务提交。

启动方式（见 scripts/run.ps1）：

    python -m uvicorn server.main:app --host 127.0.0.1 --port 8700

或直接：

    python -m server.main
"""
from __future__ import annotations

import io
import json
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
    __version__, config, imageops, imaging, jobs, materials, mediaops, model_slots,
    ollama as ollama_client, pipeline, presets, prompt_polish, storage, styles,
)
from . import models as image_models
from .upscalers import manager as upscale_manager
from .upscalers import registry as upscale_registry

#: 单张上传上限：4K PNG 约 20~30MB，64MB 足够且能挡住误传的超大文件。
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
#: 请求里内联图片（data URL 文本）的长度上限，约合 36MB 原图。
MAX_INLINE_IMAGE_CHARS = 48 * 1024 * 1024

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
                queue = get_queue()
                idle = time.time() - queue.last_activity()

                minutes = float(cfg.get("idle_unload_minutes") or 0)
                pipe = get_pipeline()
                engine = getattr(pipe, "_engine", None)
                if minutes > 0 and engine is not None:
                    loaded = (engine.status() or {}).get("loaded") or {}
                    if any(loaded.get(k) for k in ("unet", "clip", "vae")) and idle >= minutes * 60:
                        engine.free(unload=True)
                        print(f"[idle] 空闲 {idle / 60:.0f} 分钟，已卸载模型释放显存", flush=True)

                freed = upscale_manager.get_manager().maybe_unload(idle, cfg)
                if freed:
                    print(f"[idle] 空闲 {idle / 60:.0f} 分钟，已卸载放大模型 {','.join(freed)}", flush=True)
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


@app.middleware("http")
async def _frontend_no_cache(request: Request, call_next):
    """前端代码/样式禁用强缓存：未变走 304，改完刷新即可生效。

    否则浏览器会按启发式缓存旧 ES Module，页面里还是旧类，
    升级后可能报 ``xxx is not a function`` 这类版本错位错误。
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith(("/src/", "/assets/", "/vendor/")):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
    base_url = str(cfg.get("ollama_url") or ollama_client.DEFAULT_BASE_URL)
    try:
        models = prompt_polish.available_models(base_url=base_url)
        data = {"connected": bool(models), "models": models}
    except Exception as exc:  # noqa: BLE001
        data = {"connected": False, "models": [], "error": str(exc)}
    data["url"] = base_url
    data["model"] = str(cfg.get("ollama_model") or "")
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


# --------------------------------------------------------------------------- 全局设置


MODEL_KINDS = ("unet", "clip", "vae", "lora")


def _clean_paths(value: Any, *, field: str) -> list[str]:
    """把「一行一个路径」的字符串或数组收敛成绝对、去空的路径列表。"""
    if isinstance(value, str):
        items = value.splitlines()
    elif isinstance(value, list):
        items = value
    else:
        raise ApiError(f"{field} 必须是路径列表", code="invalid_field")
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            raise ApiError(f"{field} 里的路径必须是字符串", code="invalid_field")
        text = item.strip().strip('"').strip("'")
        if not text:
            continue
        out.append(os.path.normpath(os.path.expanduser(os.path.expandvars(text))))
    return out


def _settings_view(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """设置页读取的完整（已脱敏）配置视图。"""
    cfg = cfg or config.load_config()
    scan = config.scan_summary(cfg)
    llm = _ollama_health()
    return {
        "model": {
            "comfy_root": str(cfg.get("comfy_root") or ""),
            "model_root": str(cfg.get("model_root") or ""),
            "extra_model_roots": [str(r) for r in (cfg.get("extra_model_roots") or [])],
            "extra_model_paths_yaml": str(cfg.get("extra_model_paths_yaml") or ""),
            "model_dirs": cfg.get("model_dirs") or {},
        },
        "llm": {
            "ollama_url": str(cfg.get("ollama_url") or ""),
            "ollama_model": str(cfg.get("ollama_model") or ""),
            "connected": bool(llm.get("connected")),
            "models": list(llm.get("models") or []),
            "error": llm.get("error"),
        },
        "runtime": {
            "keep_text_encoder_resident": bool(cfg.get("keep_text_encoder_resident", True)),
            "idle_unload_minutes": int(cfg.get("idle_unload_minutes") or 0),
            "vram_reserve": float(cfg.get("vram_reserve") or 0),
        },
        "upscale": {
            **(cfg.get("upscale") or {}),
            "dirs": upscale_registry.resolve_dirs(cfg),
            "scan": upscale_registry.scan_all(cfg),
            "status": upscale_manager.get_manager().status(),
        },
        "scan": scan,
        "model_defaults": model_slots.audit(cfg),
        "app": {
            "version": __version__,
            "engine_dir": cfg.get("engine_dir"),
            "storage": config.disk_usage(),
            "outputs": storage.count_outputs(),
        },
    }


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
            "keep_text_encoder_resident": bool(cfg.get("keep_text_encoder_resident", True)),
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
    t2i_model = model_slots.task_model(cfg)
    t2i_plan = model_slots.resolve_plan(cfg, task="t2i", model=t2i_model)
    t2i_qwen = model_slots.resolve_plan(cfg, task="t2i", model="qwen")
    t2i_moss = model_slots.resolve_plan(cfg, task="t2i", model="moss")
    edit_plan = model_slots.resolve_plan(cfg, task="edit")
    return {
        "models": models,
        # 图像模型档案（协议 + 每模型 profile）：前端据此切换模型 / 步数 / 加速 / 边界框
        "model_profiles": image_models.public_list(cfg),
        "default_model": t2i_model,
        "samplers": config.SAMPLERS,
        "schedulers": config.SCHEDULERS,
        "ratios": config.RATIOS,
        "megapixels": [1.0, 2.0, 2.2, 4.0],
        "turbo_profiles": config.turbo_profiles_public(cfg),
        "steps_presets": config.STEPS_PRESETS,
        "lora_presets": config.lora_presets_public(),
        "defaults": {
            # 模型类默认值统一由槽位解析（系统设置 > 出厂），参数类仍来自 config
            **model_slots.resolve_plan(cfg),
            "slots": model_slots.resolve_plan(cfg),
            "t2i": t2i_plan,
            "t2i_qwen": t2i_qwen,
            "t2i_moss": t2i_moss,
            "edit": edit_plan,
            "t2i_model": t2i_model,
            "preset_overrides": model_slots.section(cfg).get("preset_overrides") or {},
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
            "local_edit_schemes": ["a", "b", "auto", "native"],
            "size_modes": ["follow", "custom", "ratio", "fixed_point"],
            "fits": ["pad", "crop"],
            "task_modes": ["edit", "inpaint", "replace", "remove", "outpaint"],
            "hint_modes": ["none", "green_overlay", "gray_fill"],
            "outpaint_percent": {"min": 0, "max": 200},
            "outpaint_max_side": {"min": 1024, "max": 8192, "default": 5120},
            "preprocess_max_side": {"min": 256, "max": 8192},
            "feather": {"min": 0, "max": 256},
            "context_factor": {"min": 1.0, "max": 4.0},
            "ollama": _ollama_health().get("connected", False),
        },
        "turbo_sigmas_help": (
            "Turbo 加速按预设执行：选「自动挂 Turbo LoRA」会挂载对应的加速 LoRA；"
            "选「自动切换 Turbo 底模」会把扩散模型换成仓库里的 Turbo 权重且不挂加速 LoRA。"
            "开启后自动沿用上次选择的预设，其他 LoRA 仍可手动叠加。"
        ),
    }


@app.get("/api/meta")
def api_meta() -> dict[str, Any]:
    """编辑预设的唯一事实源：图片精修与图生图都从这里渲染，不在前端复制数值。"""
    return {
        "version": __version__,
        "preset_version": presets.PRESET_VERSION,
        "default_preset": presets.default_preset_id(),
        "edit_presets": presets.public_presets(),
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
    pose = payload.get("pose") if isinstance(payload.get("pose"), dict) else None
    # 参考图本体（data URL）：润色模型支持视觉时随消息发过去，让它真的"看到"图
    reference_images: list[Any] = []
    for entry in (payload.get("images") or []):
        try:
            reference_images.append(imaging.decode_image(pipeline._entry_bytes(entry),
                                                        keep_alpha=False))
        except Exception:  # noqa: BLE001 - 单张图坏了不影响润色
            continue
    # 姿态人偶图也交给视觉模型，让它按真实动作写描述
    if pose and (pose.get("image") or pose.get("data")):
        try:
            reference_images.append(imaging.decode_image(
                pipeline._entry_bytes(pose.get("image") or pose.get("data")),
                keep_alpha=False))
        except Exception:  # noqa: BLE001
            pose = {k: v for k, v in pose.items() if k != "image"}
    try:
        cfg = config.load_config()
        client = ollama_client.OllamaClient(
            base_url=str(cfg.get("ollama_url") or ollama_client.DEFAULT_BASE_URL))
        result = prompt_polish.polish(
            prompt,
            mode=mode,
            model=payload.get("model") or cfg.get("ollama_model") or None,
            client=client,
            fallback=bool(payload.get("fallback", True)),
            image_model=image_model,
            target_size=target_size,
            references=references,
            reference_images=reference_images or None,
            pose=pose,
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
    task = payload.get("task")
    task_mode = str(task.get("mode") or "").strip().lower() if isinstance(task, dict) else ""
    # remove / outpaint 由后端补训练指令，提示词可以留空（第三方只传 task.mode 也能用）；
    # 普通编辑没有指令就变成「随机整图重绘」，仍然要求填写。
    if task_mode in ("remove", "outpaint"):
        prompt = str(payload.get("prompt") or "").strip()
    else:
        prompt = str(_require(payload, "prompt", label="编辑指令") or "").strip()
    images = _require(payload, "images", label="输入图片")
    if not isinstance(images, list) or not images:
        raise ApiError("images 必须是非空数组（第 1 张是编辑目标）")
    if len(images) > 10:
        raise ApiError("最多支持 10 张参考图")
    for index, entry in enumerate(images, start=1):
        if isinstance(entry, dict):
            data = entry.get("data") or entry.get("url") or ""
        elif isinstance(entry, str):
            data = entry
        else:
            data = ""
        if not isinstance(data, str) or not data.strip():
            raise ApiError(f"images[{index}] 缺少图像数据")
        if len(data) > MAX_INLINE_IMAGE_CHARS:
            raise ApiError(
                f"images[{index}] 图像过大，请先压缩或改用 /api/upload 上传后再引用")
    _validate_edit_params(payload)
    payload["prompt"] = prompt
    payload["images"] = images
    return _submit("edit", payload, prompt=prompt)


def _validate_edit_params(payload: dict[str, Any]) -> None:
    """编辑参数边界校验：不合法直接 400，别等采样时才炸。"""
    size_mode = payload.get("size_mode")
    if size_mode is not None and str(size_mode) not in (
            "follow", "custom", "ratio", "fixed_point"):
        raise ApiError(f"未知 size_mode：{size_mode!r}")

    preset = payload.get("preset")
    if preset is not None and str(preset).strip() and presets.get_preset(preset) is None:
        raise ApiError(f"未知编辑预设：{preset!r}")

    pre = payload.get("preprocess")
    if pre is not None:
        if not isinstance(pre, dict):
            raise ApiError("preprocess 必须是对象")
        if pre.get("enabled"):
            try:
                max_side = int(pre.get("max_side") or 2048)
            except (TypeError, ValueError):
                raise ApiError("preprocess.max_side 必须是整数")
            if not 256 <= max_side <= 8192:
                raise ApiError("preprocess.max_side 必须在 256~8192")
            try:
                min_side = int(pre.get("min_side") or 768)
            except (TypeError, ValueError):
                raise ApiError("preprocess.min_side 必须是整数")
            if not 256 <= min_side <= 8192:
                raise ApiError("preprocess.min_side 必须在 256~8192")
            if min_side > max_side:
                raise ApiError("preprocess.min_side 不能大于 max_side")
            if pre.get("multiple") is not None:
                try:
                    multiple = int(pre["multiple"])
                except (TypeError, ValueError):
                    raise ApiError("preprocess.multiple 必须是整数")
                if not 8 <= multiple <= 256:
                    raise ApiError("preprocess.multiple 必须在 8~256")
            mode = str(pre.get("mode") or "downscale_only")
            if mode not in ("downscale_only", "clamp_range"):
                raise ApiError(f"未知 preprocess.mode：{mode!r}")

    # 采样参数：非法值会让管线在 worker 里抛 ValueError（前端只看到 500）。
    if payload.get("steps") is not None:
        try:
            steps = int(payload["steps"])
        except (TypeError, ValueError):
            raise ApiError("steps 必须是整数")
        if not 1 <= steps <= 200:
            raise ApiError("steps 必须在 1~200")
    if payload.get("cfg") is not None:
        try:
            cfg_value = float(payload["cfg"])
        except (TypeError, ValueError):
            raise ApiError("cfg 必须是数字")
        if not 0 <= cfg_value <= 30:
            raise ApiError("cfg 必须在 0~30")
    if payload.get("denoise") is not None:
        try:
            denoise = float(payload["denoise"])
        except (TypeError, ValueError):
            raise ApiError("denoise 必须是数字")
        if not 0 < denoise <= 1:
            raise ApiError("denoise 必须在 0~1")
    if payload.get("sampler") and str(payload["sampler"]) not in config.SAMPLERS:
        raise ApiError(f"未知采样器：{payload['sampler']!r}")
    if payload.get("scheduler") and str(payload["scheduler"]) not in config.SCHEDULERS:
        raise ApiError(f"未知调度器：{payload['scheduler']!r}")

    task = payload.get("task")
    if task is not None and not isinstance(task, dict):
        raise ApiError("task 必须是对象")
    # inpaint / replace 是前端 detectTask 的合法产出，后端按普通编辑处理
    if isinstance(task, dict) and task.get("mode") not in (
            None, "edit", "remove", "outpaint", "inpaint", "replace", "panorama"):
        raise ApiError(f"未知 task.mode：{task.get('mode')!r}")

    outpaint = payload.get("outpaint")
    if outpaint is not None:
        if not isinstance(outpaint, dict):
            raise ApiError("outpaint 必须是对象")
        for key in ("left", "right", "top", "bottom"):
            if outpaint.get(key) is None:
                continue
            try:
                value = float(outpaint[key])
            except (TypeError, ValueError):
                raise ApiError(f"outpaint.{key} 必须是数字（百分比）")
            if not 0 <= value <= 200:
                raise ApiError(f"outpaint.{key} 必须在 0~200（百分比）")
        if outpaint.get("max_side") is not None:
            try:
                max_side = int(outpaint["max_side"])
            except (TypeError, ValueError):
                raise ApiError("outpaint.max_side 必须是整数")
            if not 1024 <= max_side <= 8192:
                raise ApiError("outpaint.max_side 必须在 1024~8192")

    panorama = payload.get("panorama")
    if panorama is not None:
        if not isinstance(panorama, dict):
            raise ApiError("panorama 必须是对象")
        aspect = str(panorama.get("aspect") or "2:1")
        if aspect not in imaging.PANORAMA_ASPECTS:
            raise ApiError(
                f"panorama.aspect 只支持 {'/'.join(imaging.PANORAMA_ASPECTS)}")
        if panorama.get("long_side") is not None:
            try:
                long_side = int(panorama["long_side"])
            except (TypeError, ValueError):
                raise ApiError("panorama.long_side 必须是整数")
            if not 1024 <= long_side <= 4096:
                raise ApiError("panorama.long_side 必须在 1024~4096")
        if panorama.get("wrap") is not None and not isinstance(panorama["wrap"], bool):
            raise ApiError("panorama.wrap 必须是布尔值")
        if panorama.get("seam_blend") is not None:
            try:
                seam_blend = int(panorama["seam_blend"])
            except (TypeError, ValueError):
                raise ApiError("panorama.seam_blend 必须是整数")
            if not 0 <= seam_blend <= 128:
                raise ApiError("panorama.seam_blend 必须在 0~128")

    local = payload.get("local")
    if local is not None:
        if not isinstance(local, dict):
            raise ApiError("local 必须是对象")
        scheme = local.get("scheme")
        if scheme is not None and str(scheme) not in ("a", "b", "none", "auto", "native"):
            raise ApiError(f"未知 local.scheme：{scheme!r}")
        for key, low, high in (("feather", 0, 256), ("mask_expand", 0, 256),
                               ("blend_pixels", 0, 256), ("context_pixels", 0, 1024)):
            if local.get(key) is None:
                continue
            try:
                value = int(local[key])
            except (TypeError, ValueError):
                raise ApiError(f"local.{key} 必须是整数")
            if not low <= value <= high:
                raise ApiError(f"local.{key} 必须在 {low}~{high}")
        if local.get("context_factor") is not None:
            try:
                factor = float(local["context_factor"])
            except (TypeError, ValueError):
                raise ApiError("local.context_factor 必须是数字")
            if not 1.0 <= factor <= 4.0:
                raise ApiError("local.context_factor 必须在 1~4")

    mask = payload.get("mask")
    if mask is not None and not isinstance(mask, (str, dict)):
        raise ApiError("mask 必须是 data URL 字符串或 {data} 对象")

    loras = payload.get("loras")
    if loras is not None:
        if not isinstance(loras, list):
            raise ApiError("loras 必须是数组")
        for item in loras:
            if not isinstance(item, dict):
                raise ApiError("loras 每一项必须是对象")
            preset = item.get("preset")
            if preset and not config.resolve_lora_preset(str(preset)):
                raise ApiError(f"未知 LoRA 预设：{preset!r}")
            if item.get("strength") is not None:
                try:
                    strength = float(item["strength"])
                except (TypeError, ValueError):
                    raise ApiError("loras[].strength 必须是数字")
                if not 0 <= strength <= 2:
                    raise ApiError("loras[].strength 必须在 0~2")

    if payload.get("zero_shift") is not None and not isinstance(payload["zero_shift"], dict):
        raise ApiError("zero_shift 必须是对象")


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

    params = jobs.slim_params(job.params)
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
        raise ApiError(str(exc), code=getattr(exc, "code", "invalid_ops")) from exc
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


@app.get("/api/image/upscale/models")
def api_upscale_models() -> dict[str, Any]:
    """放大模型扫描结果：目录、候选 DiT/VAE、可用性、默认引擎。"""
    data = upscale_registry.scan_all()
    data["status"] = upscale_manager.get_manager().status()
    return data


#: 单批最多同时放大的图片数（前端胶片条多选上限）
MAX_UPSCALE_BATCH = 8


def _upscale_room_mb() -> int:
    try:
        import torch

        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return int(free / (1024 ** 2))
    except Exception:  # noqa: BLE001
        pass
    return 0


def _ensure_upscale_room(engine: str) -> None:
    """放大前腾显存：先尝试释放生成引擎，不够再报错。"""
    need = 12000 if engine == "seedvr2" else 7000
    if _upscale_room_mb() >= need:
        return
    pipe = get_pipeline()
    gen = getattr(pipe, "_engine", None)
    if gen is not None:
        try:
            gen.free(unload=True)
        except Exception:  # noqa: BLE001
            pass
    if _upscale_room_mb() < need:
        raise upscale_manager.UpscaleError(
            f"显存不足：{engine} 约需 {need // 1000}GB 可用显存，当前仅 {_upscale_room_mb()}MB"
        )


@app.post("/api/image/upscale")
def api_image_upscale(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """提交高清放大任务（走单 worker 队列，支持进度与取消）。"""
    raw_images = payload.get("images")
    if raw_images is None and payload.get("image"):
        raw_images = [payload.get("image")]
    if not isinstance(raw_images, list) or not raw_images:
        raise ApiError("缺少 images（data URL 或 /files/ 路径数组）", code="missing_field")
    if len(raw_images) > MAX_UPSCALE_BATCH:
        raise ApiError(f"一次最多放大 {MAX_UPSCALE_BATCH} 张", code="too_many_images")

    cfg = config.load_config()
    up = upscale_registry.section(cfg)
    params: dict[str, Any] = {}
    for key in (
        "scale", "seed", "target_short_edge", "max_resolution", "batch_size",
        "color_correction", "vae_tiled", "dit", "vae",
        "tile_size", "tile_overlap", "topk_ratio", "kv_ratio", "local_range", "color_fix",
    ):
        if payload.get(key) is not None:
            params[key] = payload.get(key)

    scan = upscale_registry.scan_all(cfg)
    engine = str(payload.get("engine") or scan.get("default_engine") or "seedvr2")
    if engine not in scan["engines"]:
        raise ApiError(f"未知的放大引擎：{engine}", code="invalid_field")
    if not scan["engines"][engine].get("ready"):
        missing = ", ".join(scan["engines"][engine].get("missing") or []) or "模型文件"
        raise ApiError(
            f"{scan['engines'][engine]['label']} 不可用，缺少：{missing}",
            code="model_missing",
        )
    if params.get("scale") is not None and int(params["scale"]) not in (2, 4):
        raise ApiError("scale 只能是 2 或 4", code="invalid_field")

    params.setdefault("scale", int((up.get("defaults") or {}).get("scale") or 2))
    params["engine"] = engine
    total = len(raw_images)

    def _run(job: jobs.Job) -> None:
        from io import BytesIO

        from PIL import Image, ImageOps

        _ensure_upscale_room(engine)
        manager = upscale_manager.get_manager()
        results: list[dict[str, Any]] = []
        job.meta.update({"engine": engine, "total": total})
        for index, raw in enumerate(raw_images):
            job.check_cancel()
            data = _decode_image_payload(raw)
            with Image.open(BytesIO(data)) as probe:
                image = ImageOps.exif_transpose(probe)
                image.load()
            if max(image.size) * int(params["scale"]) > imageops.MAX_SIDE:
                raise ApiError(
                    f"放大后尺寸超出上限 {imageops.MAX_SIDE}px", code="image_too_large"
                )

            def _progress(value: float, label: str, _i: int = index) -> None:
                done = _i + max(0.0, min(1.0, value / 100.0))
                job.set_progress(int(done * 1000), total * 1000,
                                 f"[{_i + 1}/{total}] {label}")

            job.set_progress(index * 1000, total * 1000, f"[{index + 1}/{total}] 准备中")
            result = manager.upscale(
                image,
                engine=engine,
                params=params,
                progress=_progress,
                should_cancel=lambda: job.cancel_requested,
            )
            buf = BytesIO()
            result.save(buf, format="PNG", compress_level=1)
            saved = storage.save_output(
                buf.getvalue(), prefix=f"upscale-{engine}", ext="png", image=result
            )
            results.append(saved)
            job.images = list(results)

        job.set_progress(total * 1000, total * 1000, "完成")
        job.meta["engine"] = engine

    job = get_queue().submit(
        "upscale",
        _run,
        prompt=f"放大 {total} 张（{engine} ×{params['scale']}）",
        params=params,
        meta={"engine": engine, "total": total},
    )
    return {"ok": True, "job_id": job.id, "status": job.status, "engine": engine}


# --------------------------------------------------------------------------- 水印 / 动图

#: 视频上传上限（给 GIF 用，不需要更大）
MAX_VIDEO_BYTES = 512 * 1024 * 1024
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi"}


def _watermark_mark_data(payload: dict[str, Any]) -> bytes | None:
    raw = payload.get("image_mark")
    if isinstance(raw, dict):
        raw = raw.get("url") or raw.get("data")
    if not raw:
        return None
    return _decode_image_payload(raw)


@app.get("/api/image/watermark/fonts")
def api_watermark_fonts() -> dict[str, Any]:
    """可用字体白名单（浏览器用 family 预览，服务端用 path 精确渲染）。"""
    return {"fonts": mediaops.list_fonts()}


@app.post("/api/image/watermark/preview")
def api_watermark_preview(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    raw = payload.get("image")
    if not raw:
        raise ApiError("缺少 image（data URL 或 /files/ 路径）", code="missing_field")
    try:
        data = _decode_image_payload(raw)
        png, width, height = mediaops.preview(
            data, payload, mark_data=_watermark_mark_data(payload))
    except mediaops.MediaOpsError as exc:
        raise ApiError(str(exc), code=exc.code) from exc
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"水印预览失败：{exc}") from exc
    return {"ok": True, "data_url": imaging.data_url("image/png", png),
            "width": width, "height": height}


@app.post("/api/image/watermark")
def api_watermark(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """批量加水印（最多 20 张），结果落 storage/outputs。"""
    raw_images = payload.get("images")
    if raw_images is None and payload.get("image"):
        raw_images = [payload.get("image")]
    if not isinstance(raw_images, list) or not raw_images:
        raise ApiError("缺少 images（data URL 或 /files/ 路径数组）", code="missing_field")
    if len(raw_images) > mediaops.MAX_WATERMARK_BATCH:
        raise ApiError(f"一次最多处理 {mediaops.MAX_WATERMARK_BATCH} 张", code="too_many_images")

    mark_data = _watermark_mark_data(payload)
    fmt = str(payload.get("format") or "png").lower()
    prefix = str(payload.get("prefix") or "watermark")
    results = []
    for index, raw in enumerate(raw_images):
        try:
            watermarked = mediaops.apply_watermark(
                _decode_image_payload(raw), payload, mark_data=mark_data)
            encoded, ext = imageops.encode_export(
                watermarked, fmt,
                quality=int(payload.get("quality") or 92),
                lossless=bool(payload.get("lossless")),
                background=payload.get("background") or "#ffffff",
            )
        except mediaops.MediaOpsError as exc:
            raise ApiError(str(exc), code=exc.code) from exc
        except imageops.ImageOpsError as exc:
            raise ApiError(str(exc), code=getattr(exc, "code", "invalid_ops")) from exc
        meta = storage.save_output(
            encoded, prefix=f"{prefix}-{index + 1}", ext=f".{ext}", image=watermarked)
        meta["index"] = index
        results.append(meta)

    return {"ok": True, "count": len(results), "format": fmt, "images": results}


def _video_path(relpath: Any) -> str:
    text = str(relpath or "").strip()
    if not text:
        raise ApiError("缺少视频 path（/api/media/upload 返回的 relpath）", code="missing_field")
    rel = text[len("/files/"):] if text.startswith("/files/") else text
    try:
        path = storage.resolve_storage_path(rel)
    except ValueError as exc:
        raise ApiError(str(exc), code="invalid_path") from exc
    if os.path.splitext(path)[1].lower() not in VIDEO_EXTS or not os.path.isfile(path):
        raise ApiError("视频不存在或格式不支持", code="not_found")
    return path


@app.post("/api/media/upload")
async def api_media_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    """上传视频（GIF 源），返回 relpath / url / 探测信息。"""
    name = file.filename or "video.mp4"
    ext = os.path.splitext(name)[1].lower()
    if ext not in VIDEO_EXTS:
        raise ApiError("仅支持 mp4/mov/webm/mkv/avi", code="invalid_format")
    storage.ensure_dirs()
    uid = storage.new_id("vid-")
    filename = f"{uid}{ext}"
    relpath = f"uploads/{filename}"
    target = os.path.join(config.STORAGE_DIR, relpath)
    size = 0
    try:
        with open(target, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_VIDEO_BYTES:
                    raise ApiError(f"视频不能超过 {MAX_VIDEO_BYTES // 1024 // 1024}MB",
                                   code="file_too_large")
                fh.write(chunk)
    except ApiError:
        if os.path.isfile(target):
            os.remove(target)
        raise
    finally:
        await file.close()
    try:
        info = mediaops.probe_video(target)
    except mediaops.MediaOpsError as exc:
        info = {"error": str(exc)}
    return {"ok": True, "relpath": relpath, "url": storage.url_for(relpath),
            "filename": filename, "bytes": size, "info": info}


@app.post("/api/media/video/probe")
def api_media_probe(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    path = _video_path(payload.get("path") or payload.get("url"))
    try:
        return {"ok": True, "info": mediaops.probe_video(path)}
    except mediaops.MediaOpsError as exc:
        raise ApiError(str(exc), code=exc.code) from exc


@app.post("/api/media/gif")
def api_media_gif(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """提交 GIF 任务（图片序列或视频），走单 worker 队列。"""
    source = str(payload.get("source") or "images").lower()
    if source not in ("images", "video"):
        raise ApiError("source 只能是 images 或 video", code="invalid_field")
    mode = str(payload.get("mode") or "forward").lower()
    if mode not in ("forward", "reverse", "boomerang"):
        raise ApiError("mode 只能是 forward/reverse/boomerang", code="invalid_field")
    try:
        duration = max(20, int(payload.get("duration") or 100))
        width = int(payload.get("width") or 0)
        fps = float(payload.get("fps") or 12)
        loop = int(payload.get("loop") or 0)
        start = float(payload.get("start") or 0)
        end = float(payload.get("end") or 0)
    except (TypeError, ValueError) as exc:
        raise ApiError("duration/width/fps/start/end 必须是数字", code="invalid_field") from exc
    durations = payload.get("durations")
    if durations is not None and not isinstance(durations, list):
        raise ApiError("durations 必须是数组", code="invalid_field")

    if source == "video":
        path = _video_path(payload.get("path") or payload.get("video"))
        total_frames = 0
    else:
        raw_images = payload.get("images")
        if not isinstance(raw_images, list) or not raw_images:
            raise ApiError("缺少 images（帧数组）", code="missing_field")
        if len(raw_images) > mediaops.MAX_GIF_FRAMES:
            raise ApiError(f"帧数过多（最多 {mediaops.MAX_GIF_FRAMES}）", code="too_many_frames")
        path = ""
        total_frames = len(raw_images)

    def _run(job: jobs.Job) -> None:
        job.meta.update({"source": source, "mode": mode, "frames": total_frames})
        if source == "video":
            result = mediaops.gif_from_video(
                path, start=start, end=end, fps=fps, width=width or 720, mode=mode,
                progress=lambda value, label: job.set_progress(value, 100, label),
                cancel=lambda: job.cancel_requested,
            )
        else:
            result = mediaops.gif_from_images(
                raw_images, duration=duration, durations=durations, width=width, mode=mode,
                loop=loop,
                progress=lambda value, label: job.set_progress(value, 100, label),
                cancel=lambda: job.cancel_requested,
            )
        job.check_cancel()
        from PIL import Image

        with Image.open(io.BytesIO(result)) as probe:
            frames = int(getattr(probe, "n_frames", 1))
        meta = storage.save_output(result, prefix="gif", ext=".gif")
        meta["frames"] = frames
        job.images = [meta]
        job.meta["frames"] = frames
        job.set_progress(100, 100, "完成")

    job = get_queue().submit(
        "gif", _run,
        prompt=f"GIF（{source} → {mode}）",
        params={"source": source, "mode": mode, "duration": duration,
                "width": width, "fps": fps, "frames": total_frames},
        meta={"source": source, "mode": mode, "frames": total_frames},
    )
    return {"ok": True, "job_id": job.id, "status": job.status}


@app.post("/api/media/gif/split")
def api_media_gif_split(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """GIF 拆帧：每帧存成 PNG 结果（最多 60 帧）。"""
    raw = payload.get("image") or payload.get("path")
    if not raw:
        raise ApiError("缺少 image（data URL 或 /files/ 路径）", code="missing_field")
    try:
        max_frames = int(payload.get("max_frames") or 60)
    except (TypeError, ValueError) as exc:
        raise ApiError("max_frames 必须是整数", code="invalid_field") from exc
    try:
        items = mediaops.split_gif(_decode_image_payload(raw),
                                   max_frames=max(1, min(max_frames, 60)))
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"GIF 拆帧失败：{exc}", code="invalid_gif") from exc
    results = []
    for index, (png, duration) in enumerate(items):
        meta = storage.save_output(png, prefix=f"gifframe-{index + 1:02d}", ext=".png")
        meta["index"] = index
        meta["duration"] = duration
        results.append(meta)
    return {"ok": True, "count": len(results), "images": results}


# --------------------------------------------------------------------------- 引擎/文件


@app.post("/api/engine/free")
def api_engine_free(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """释放显存：unload=False 只清缓存，True 卸载模型（生成引擎 + 放大引擎）。"""
    unload = bool(payload.get("unload"))
    freed = []
    try:
        upscale_manager.get_manager().free(unload=unload)
        freed.append("upscale")
    except Exception:  # noqa: BLE001
        pass
    pipe = get_pipeline()
    engine = getattr(pipe, "_engine", None)
    if engine is None:
        return {"ok": True, "unload": unload, "note": "引擎尚未加载", "freed": freed}
    engine.free(unload=unload)
    return {"ok": True, "unload": unload, "freed": freed}


@app.get("/api/settings")
def api_settings_get() -> dict[str, Any]:
    """全局设置：模型目录、LLM、运行与显存策略、扫描摘要。"""
    return _settings_view()


@app.post("/api/settings")
def api_settings(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """保存全局设置；model_root / comfy_root 等保存后立即对下一次扫描生效。"""
    cfg = config.load_config()
    patch: dict[str, Any] = {}

    for key in ("comfy_root", "model_root", "extra_model_paths_yaml", "ollama_url", "ollama_model"):
        if key in payload:
            value = payload.get(key)
            if not isinstance(value, str):
                raise ApiError(f"{key} 必须是字符串", code="invalid_field")
            text = value.strip()
            if key == "ollama_url" and text and not text.startswith(("http://", "https://")):
                raise ApiError("Ollama 地址必须以 http:// 或 https:// 开头", code="invalid_field")
            if key in ("comfy_root", "model_root", "extra_model_paths_yaml") and text:
                text = os.path.normpath(os.path.expanduser(os.path.expandvars(text)))
            patch[key] = text

    if "extra_model_roots" in payload:
        patch["extra_model_roots"] = _clean_paths(payload.get("extra_model_roots"), field="额外模型根目录")

    if "model_dirs" in payload:
        raw = payload.get("model_dirs")
        if not isinstance(raw, dict):
            raise ApiError("model_dirs 必须是对象", code="invalid_field")
        dirs = dict(cfg.get("model_dirs") or {})
        for kind in MODEL_KINDS:
            if kind in raw:
                dirs[kind] = _clean_paths(raw.get(kind), field=f"model_dirs.{kind}")
        patch["model_dirs"] = dirs

    if "keep_text_encoder_resident" in payload:
        value = payload.get("keep_text_encoder_resident")
        if not isinstance(value, bool):
            raise ApiError("keep_text_encoder_resident 必须是布尔值", code="invalid_field")
        patch["keep_text_encoder_resident"] = value

    if "idle_unload_minutes" in payload:
        try:
            minutes = int(payload.get("idle_unload_minutes"))
        except (TypeError, ValueError) as exc:
            raise ApiError("idle_unload_minutes 必须是整数", code="invalid_field") from exc
        if minutes < 0:
            raise ApiError("空闲卸载分钟数不能为负数", code="invalid_field")
        patch["idle_unload_minutes"] = minutes

    if "vram_reserve" in payload:
        try:
            reserve = float(payload.get("vram_reserve"))
        except (TypeError, ValueError) as exc:
            raise ApiError("vram_reserve 必须是数字", code="invalid_field") from exc
        if not 0 <= reserve < 1:
            raise ApiError("显存预留必须在 0 到 1 之间", code="invalid_field")
        patch["vram_reserve"] = round(reserve, 2)

    if "model_defaults" in payload:
        try:
            merged = model_slots.merge_section(cfg, payload.get("model_defaults"))
        except ValueError as exc:
            raise ApiError(str(exc), code="invalid_field") from exc
        patch["model_defaults"] = merged
        # 生效值同步回旧顶层键，保持 turbo_plan / 历史脚本兼容
        patch.update(model_slots.legacy_patch({**cfg, "model_defaults": merged}))

    if "upscale" in payload:
        raw = payload.get("upscale")
        if not isinstance(raw, dict):
            raise ApiError("upscale 必须是对象", code="invalid_field")
        current = json.loads(json.dumps(cfg.get("upscale") or {}))
        if "dirs" in raw:
            if not isinstance(raw.get("dirs"), dict):
                raise ApiError("upscale.dirs 必须是对象", code="invalid_field")
            dirs = dict(current.get("dirs") or {})
            for name in ("seedvr2", "flashvsr"):
                if name in raw["dirs"]:
                    text = str(raw["dirs"].get(name) or "").strip()
                    dirs[name] = (
                        os.path.normpath(os.path.expandvars(os.path.expanduser(text)))
                        if text else ""
                    )
            current["dirs"] = dirs
        for section in ("seedvr2", "flashvsr", "defaults"):
            if section in raw:
                if not isinstance(raw.get(section), dict):
                    raise ApiError(f"upscale.{section} 必须是对象", code="invalid_field")
                current[section] = {**(current.get(section) or {}), **raw[section]}
        for key in ("default_engine", "idle_unload_minutes", "enabled"):
            if key in raw:
                current[key] = raw[key]
        patch["upscale"] = current

    if not patch:
        raise ApiError("没有可修改的设置项", code="missing_field")

    updated = config.update_config(patch)
    if "upscale" in patch:
        upscale_manager.get_manager().free(unload=True)
    if any(key in patch for key in ("ollama_url", "ollama_model")):
        _OLLAMA_CACHE["data"] = None
    released = 0
    if patch.get("keep_text_encoder_resident") is False:
        # 切到「让位」时立即归还显存，不用等下一次采样
        released = get_pipeline().release_text_encoder()
    return {"ok": True, "released": released, **_settings_view(updated)}


@app.post("/api/models/scan")
def api_models_scan() -> dict[str, Any]:
    """按当前配置重新扫描所有模型目录（设置页的「重新扫描」）。"""
    data = config.scan_summary()
    data["upscale"] = upscale_registry.scan_all()
    return data


@app.post("/api/ollama/test")
def api_ollama_test(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    """测试 Ollama 连通性并列出模型；不修改配置，供设置页「测试连接」使用。"""
    cfg = config.load_config()
    url = str(payload.get("url") or cfg.get("ollama_url") or ollama_client.DEFAULT_BASE_URL).strip()
    if not url.startswith(("http://", "https://")):
        raise ApiError("Ollama 地址必须以 http:// 或 https:// 开头", code="invalid_field")
    started = time.time()
    try:
        client = ollama_client.OllamaClient(base_url=url, timeout=8.0)
        models = client.model_names()
        return {
            "ok": True,
            "connected": bool(models),
            "models": models,
            "url": url,
            "latency_ms": int((time.time() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 - 连接失败要让设置页看到原因
        return {
            "ok": False,
            "connected": False,
            "models": [],
            "url": url,
            "error": str(exc),
            "latency_ms": int((time.time() - started) * 1000),
        }


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
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(
            f"图片过大：{len(data) / 1024 / 1024:.0f}MB，上限 {MAX_UPLOAD_BYTES // 1024 // 1024}MB")
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
