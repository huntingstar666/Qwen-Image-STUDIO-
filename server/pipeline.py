"""统一生成管线：解码 → 画布规划（32 对齐）→ 引擎推理 → 裁回 → 合成 → 存盘。

本文件是「零偏移 + 零色差」的落地处，把三个部件串起来：

    server/imaging.py + server/align.py   ← 几何与颜色（Precise-Align / BlueBox 移植）
    server/backends/native.py             ← 进程内推理引擎（模型生命周期 / 采样 / 编解码）
    server/config.py                      ← 模型路径、Turbo sigma 档位、默认值

对外只有两个入口：`Pipeline.generate_t2i(job)` 与 `Pipeline.generate_edit(job)`，
两者都由 `Pipeline.generate(job)` 按 `job.kind` 分派，异常统一交给 JobQueue 记录。

关键约定（不要改，否则零偏移/零色差会失效）
------------------------------------------------
1. 画布尺寸必须是 32 的倍数；编码器 `resolution` 传 0，参考图不再缩放。
2. 采样 latent 与参考图画布**必须同尺寸**（VAEEncode(画布) 或编码器 latent 二选一，尺寸相同）。
3. 出图后先合成（遮罩外保留原图像素），再 `crop_back_plan` 回源尺寸。
"""
from __future__ import annotations

import dataclasses
import os
import secrets
import time
from typing import Any, Callable

import numpy as np
from PIL import Image

from . import align, config, imaging, storage


class PipelineError(RuntimeError):
    """管线内部错误（会作为任务 error 返回给前端）。"""


# --------------------------------------------------------------------------- 小工具


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _pick_seed(value: Any) -> int:
    try:
        seed = int(value)
    except (TypeError, ValueError):
        seed = -1
    if seed < 0:
        return secrets.randbelow(2 ** 31 - 1)
    return seed


def _load_engine_module():
    try:
        from .backends import native as native_mod  # 延迟导入：引擎未就绪时不影响其它 API
        return native_mod
    except Exception as exc:  # noqa: BLE001
        raise PipelineError(
            f"推理引擎不可用（server/backends/native.py 导入失败）：{exc}"
        ) from exc


def _flatten_on_white(image: Image.Image) -> Image.Image:
    """把 RGBA 压到白底 RGB（非透明输出用）。"""
    if image.mode != "RGBA":
        return image.convert("RGB")
    base = Image.new("RGB", image.size, (255, 255, 255))
    base.paste(image, mask=image.getchannel("A"))
    return base


def _make_callback(job, total: int, *, label: str = "采样") -> Callable[..., None]:
    """把引擎的采样回调转成任务进度（对回调参数形态不敏感，只数次数）。"""
    counter = {"n": 0}

    def _cb(*_args, **_kwargs) -> None:
        counter["n"] += 1
        job.set_progress(counter["n"], max(1, total), f"{label} {counter['n']}/{total}")

    return _cb


def _outside_max_abs(original: Image.Image, edited: Image.Image,
                     mask: np.ndarray | None, expand: int = 0) -> int | None:
    """遮罩外像素的最大绝对差（零色差验收：应为 0）。

    `mask_expand>0` 时先按外扩后的遮罩计算——外扩本身就是主动改写遮罩外几像素，
    属于用户显式选择。
    """
    if mask is None:
        return None
    if original.size != edited.size:
        return None
    effective = align.dilate_mask(mask, int(expand)) if expand and expand > 0 else mask
    outside = effective <= 0.001
    if not bool(outside.any()):
        return None
    a = np.asarray(original.convert("RGBA"), dtype=np.int16)
    b = np.asarray(edited.convert("RGBA"), dtype=np.int16)
    if a.shape != b.shape:
        return None
    diff = np.abs(a - b).max(axis=2)
    return int(diff[outside].max())


def _signal_progress(job, value: int, total: int, label: str) -> None:
    try:
        job.set_progress(value, total, label)
    except Exception:  # noqa: BLE001 - 进度上报失败不能影响出图
        pass


# --------------------------------------------------------------------------- 采样计划


def _sampling_plan(params: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    """解析采样参数；Turbo 模式下用显式 sigma 覆盖 steps/scheduler。"""
    turbo = params.get("turbo") or {}
    steps = int(params.get("steps") or cfg["steps"])
    cfg_scale = float(params.get("cfg") if params.get("cfg") is not None else cfg["cfg"])
    sampler = str(params.get("sampler") or cfg["sampler"])
    scheduler = str(params.get("scheduler") or cfg["scheduler"])
    sigmas: list[float] | None = None
    turbo_enabled = _truthy(turbo.get("enabled"))

    if turbo_enabled:
        profile = config.turbo_profile(turbo.get("profile"))
        raw = turbo.get("sigmas")
        if isinstance(raw, (list, tuple)) and len(raw) >= 2:
            sigmas = [float(v) for v in raw]
        else:
            sigmas = [float(v) for v in profile["sigmas"]]
        # 容忍前端只给 8 个值（不带末尾 0.0）
        if sigmas[-1] != 0.0:
            sigmas = sigmas + [0.0]
        steps = len(sigmas) - 1
        cfg_scale = float(profile.get("cfg", 1.0))
        sampler = str(profile.get("sampler", "euler"))
        scheduler = "simple"

    return {
        "sigmas": sigmas,
        "steps": max(1, steps),
        "cfg": cfg_scale,
        "sampler": sampler,
        "scheduler": scheduler,
        "seed": _pick_seed(params.get("seed")),
        "denoise": float(params.get("denoise") if params.get("denoise") is not None else 1.0),
        "turbo": turbo_enabled,
    }


def _resolve_models(cfg: dict[str, Any], params: dict[str, Any]) -> dict[str, str]:
    models = params.get("models") or {}
    out: dict[str, str] = {}
    for key in ("unet", "clip", "vae"):
        value = models.get(key) or cfg.get(key)
        path = config.resolve_model(cfg, key, value)
        if not path:
            raise PipelineError(
                f"找不到 {key} 模型：{value!r}。请检查 config.json 的 model_root / {key}，"
                f"或在请求里显式指定绝对路径。"
            )
        out[key] = path
    return out


def _build_loras(cfg: dict[str, Any], params: dict[str, Any], *,
                 sampling: dict[str, Any]) -> list[dict[str, Any]]:
    """收集 LoRA：请求里显式的 + Turbo 档位要求的 + 一致性 LoRA。"""
    loras: list[dict[str, Any]] = []

    def _add(name: str | None, strength: float) -> None:
        path = config.resolve_model(cfg, "lora", name)
        if not path:
            raise PipelineError(f"找不到 LoRA：{name!r}（检查 models/lora 路径）")
        if any(item["name"] == path for item in loras):
            return
        loras.append({"name": path, "strength": float(strength)})

    for item in (params.get("loras") or []):
        if not item:
            continue
        _add(item.get("name") or item.get("value"), float(item.get("strength", 1.0)))

    if sampling.get("turbo"):
        turbo = params.get("turbo") or {}
        profile = config.turbo_profile(turbo.get("profile"))
        # 加速 LoRA 可由请求覆盖：turbo.lora = "none" 表示不挂，指定文件名则用那个
        pick = config.pick_turbo_lora(
            cfg, profile,
            requested=turbo.get("lora"),
            strength=turbo.get("lora_strength", turbo.get("strength")),
        )
        if pick["missing"]:
            raise PipelineError(
                f"找不到指定的加速 LoRA：{pick['name']!r}。"
                f"请检查 /api/options 的 models.turbo_lora 候选，或检查 models/lora 路径。"
            )
        if pick["path"]:
            if any(item["name"] == pick["path"] for item in loras):
                pass  # 手动 LoRA 里已经挂了同一个，避免重复叠加
            else:
                loras.append({"name": pick["path"], "strength": float(pick["strength"])})
            lora_info = f"{os.path.basename(pick['path'])} @ {pick['strength']}（{pick['reason']}）"
        else:
            lora_info = f"不挂加速 LoRA（{pick['reason']}）"
        sampling["turbo_lora_note"] = lora_info

    consistency = params.get("consistency_lora")
    if consistency:
        _add(consistency.get("name") or cfg.get("consistency_lora"),
             float(consistency.get("strength", 1.0)))

    return loras


def _plan_canvas_for(src: Image.Image, params: dict[str, Any]) -> imaging.CanvasPlan:
    mode = str(params.get("size_mode") or "follow")
    return imaging.plan_canvas(
        src.width,
        src.height,
        mode=mode,
        width=params.get("width"),
        height=params.get("height"),
        ratio=params.get("ratio"),
        megapixels=params.get("megapixels"),
        fit=str(params.get("fit") or "pad"),
        multiple=config.SNAP if hasattr(config, "SNAP") else 32,
    )


# --------------------------------------------------------------------------- 管线主体


class Pipeline:
    """把「引擎 + 对齐/色彩 + 存储」串起来的薄编排层。"""

    def __init__(self, engine: Any | None = None) -> None:
        self._engine = engine

    # -- 引擎（惰性创建，避免模块导入时就加载 torch） ----------------------
    @property
    def engine(self):
        if self._engine is None:
            mod = _load_engine_module()
            cfg = config.load_config()
            engine_dir = config.find_engine_dir(cfg)
            if not engine_dir:
                raise PipelineError(
                    "找不到引擎代码目录 engine/comfy。请先执行：\n"
                    "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\port_engine.ps1"
                )
            paths = config.default_model_paths(cfg)
            if cfg.get("keep_text_encoder_resident", True):
                # 引擎默认每单把 CLIP 挪出显存再装回（省显存，但每单多 0.8~1.4s）。
                # 32GB 卡上 16GB 权重放得下，连续出图保持常驻更快。
                os.environ.setdefault("QWEN_NATIVE_KEEP_TEXT_ENCODER", "1")
            engine_config = _make_engine_config(mod, engine_dir, paths, cfg)
            self._engine = mod.NativeEngine(engine_config)
        return self._engine

    def status(self) -> dict[str, Any]:
        try:
            return self.engine.status()
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "reason": str(exc),
                    "loaded": {"unet": None, "clip": None, "vae": None, "loras": []}}

    # -- 分派 ---------------------------------------------------------------
    def generate(self, job) -> None:
        if job.kind == "t2i":
            self.generate_t2i(job)
        elif job.kind == "edit":
            self.generate_edit(job)
        else:
            raise PipelineError(f"未知任务类型：{job.kind}")

    # -- 文生图 -------------------------------------------------------------
    def generate_t2i(self, job) -> None:
        cfg = config.load_config()
        params = job.params
        width = config.snap32(params.get("width") or cfg["width"])
        height = config.snap32(params.get("height") or cfg["height"])
        batch = max(1, min(int(params.get("batch") or 1), int(cfg["max_batch"])))
        for side in (width, height):
            if side > int(cfg["max_side"]):
                raise PipelineError(f"尺寸超限：{side} > max_side {cfg['max_side']}")

        sampling = _sampling_plan(params, cfg)
        models = _resolve_models(cfg, params)
        loras = _build_loras(cfg, params, sampling=sampling)
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]
        job.params.update({
            "width": width, "height": height, "batch": batch,
            "steps": sampling["steps"], "cfg": sampling["cfg"],
            "sampler": sampling["sampler"], "scheduler": sampling["scheduler"],
            "seed": sampling["seed"], "turbo": sampling["turbo"],
            "sigmas": sampling["sigmas"],
        })

        total = sampling["steps"] + 3
        engine = self.engine
        _signal_progress(job, 1, total, "准备模型")
        self._prepare_engine(engine, models, loras, job)
        job.check_cancel()

        _signal_progress(job, 2, total, "文本编码")
        prompt = job.prompt or ""
        if _truthy(params.get("rgba")) and "RGBA" not in prompt:
            prompt = (f"This is an RGBA image with transparency. {prompt} "
                      f"The image has an alpha channel and a transparent background.")
        cond = engine.encode_text(prompt, params.get("negative_prompt") or "")

        job.check_cancel()
        _signal_progress(job, 3, total, "扩散采样")
        samples = engine.sample(
            positive=cond["positive"],
            negative=cond["negative"],
            latent=None,                       # 引擎按 width/height 造空 latent
            width=width,
            height=height,
            batch=batch,
            sigmas=sampling["sigmas"],
            steps=sampling["steps"],
            cfg=sampling["cfg"],
            sampler=sampling["sampler"],
            scheduler=sampling["scheduler"],
            seed=sampling["seed"],
            denoise=sampling["denoise"],
            noise_mask=None,
            callback=_make_callback(job, sampling["steps"]),
        )
        job.check_cancel()

        _signal_progress(job, total - 1, total, "解码")
        decoded = self._decode(engine, samples)
        want_alpha = _truthy(params.get("rgba"))
        saved: list[dict[str, Any]] = []
        for idx, image in enumerate(decoded):
            out = image if want_alpha else _flatten_on_white(image)
            data = imaging.encode_png(out)
            meta = storage.save_output(data, prefix=_prefix(job.prompt, "t2i"))
            meta["index"] = idx
            saved.append(meta)
        job.images = saved
        job.quality = {"size_match": True, "outside_max_abs": None, "canvas": None}
        _signal_progress(job, total, total, "完成")
        engine.free(unload=False)  # 只清缓存，模型留在显存给下一次用

    # -- 图像编辑 -----------------------------------------------------------
    def generate_edit(self, job) -> None:
        cfg = config.load_config()
        params = job.params
        entries = params.get("images") or []
        if not entries:
            raise PipelineError("图像编辑至少需要 1 张输入图片")
        if len(entries) > 10:
            raise PipelineError("最多支持 10 张参考图（image_1 … image_10）")

        t_start = time.time()
        decoded: list[Image.Image] = []
        for entry in entries:
            data = _entry_bytes(entry)
            decoded.append(imaging.decode_image(data))
        src = decoded[0]

        # 画布规划（32 对齐）——零像素偏移的第一步
        plan = _plan_canvas_for(src, params)
        canvas = imaging.compose_canvas(src, plan, pad_mode=str(params.get("pad_mode") or "edge"))
        if canvas.size != (plan.width, plan.height):
            raise PipelineError(
                f"画布尺寸异常：期望 {plan.width}×{plan.height}，实际 {canvas.size}")

        # 遮罩（原图尺寸 → 画布坐标），零色差靠它把遮罩外原样保留
        mask_canvas: np.ndarray | None = None
        if params.get("mask"):
            mask_bytes = _entry_bytes(params["mask"])
            mask_src = imaging.decode_mask(mask_bytes, src.width, src.height)
            mask_canvas = imaging.map_mask_to_canvas(mask_src, plan)

        # 记录输入图，供历史回看
        input_urls: list[str] = []
        for image, entry in zip(decoded, entries):
            meta = storage.save_upload(imaging.encode_png(image), ext=".png",
                                       orig_name=(entry.get("name") if isinstance(entry, dict) else None))
            input_urls.append(meta["url"])
        job.meta["input_urls"] = input_urls

        job.align = {
            "canvas": {"w": plan.width, "h": plan.height},
            "source": {"w": src.width, "h": src.height},
            "applied": True,
            "plan": _plan_dict(plan),
        }

        local = params.get("local") or {}
        scheme = str(local.get("scheme") or "a") if _truthy(local.get("enabled")) else "none"
        sampling = _sampling_plan(params, cfg)
        models = _resolve_models(cfg, params)
        loras = _build_loras(cfg, params, sampling=sampling)
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]

        engine = self.engine
        total = sampling["steps"] + 4
        _signal_progress(job, 1, total, "准备模型")
        self._prepare_engine(engine, models, loras, job)
        job.check_cancel()

        # ---- 方案 B：先裁切局部，只采样这一块（省显存）
        crop_info = None
        if scheme == "b" and mask_canvas is not None:
            crop_img, crop_info = imaging.crop_region(
                canvas, mask_canvas,
                context_factor=float(local.get("context_factor") or 1.5),
                context_pixels=int(local.get("context_pixels") or 96),
                multiple=32,
            )
            job.align["crop"] = dataclasses.asdict(crop_info)
            ref_images = [crop_img] + decoded[1:]
        else:
            ref_images = [canvas] + decoded[1:]

        _signal_progress(job, 2, total, "文本编码（含参考图）")
        cond = engine.encode_text(
            job.prompt or "",
            params.get("negative_prompt") or "",
            images=ref_images,
            resolution=int(params.get("resolution") or 0),
        )

        # 零偏移守卫：采样画布必须与参考图画布同尺寸
        cond_canvas = cond.get("canvas")
        work_image = ref_images[0]
        if cond_canvas and tuple(cond_canvas) != work_image.size:
            raise PipelineError(
                f"零偏移守卫：参考图画布 {tuple(cond_canvas)} 与采样画布 {work_image.size} 不一致。"
                f"请把 resolution 设为 0，或让画布尺寸等于参考图尺寸。")

        job.check_cancel()
        _signal_progress(job, 3, total, "VAE 编码")
        latent = engine.encode_latent(work_image)
        noise_mask = mask_canvas if scheme == "a" else None

        job.check_cancel()
        _signal_progress(job, 4, total, "扩散采样")
        samples = engine.sample(
            positive=cond["positive"],
            negative=cond["negative"],
            latent=latent,
            sigmas=sampling["sigmas"],
            steps=sampling["steps"],
            cfg=sampling["cfg"],
            sampler=sampling["sampler"],
            scheduler=sampling["scheduler"],
            seed=sampling["seed"],
            denoise=sampling["denoise"],
            noise_mask=noise_mask,
            callback=_make_callback(job, sampling["steps"]),
        )
        job.check_cancel()

        _signal_progress(job, total - 1, total, "解码与合成")
        edited_list = self._decode(engine, samples)
        edited = edited_list[0]

        feather = int(local.get("feather") or 32)
        color_match = _truthy(local.get("color_match", True))
        color_strength = float(local.get("color_strength") if local.get("color_strength") is not None else 0.6)
        mask_expand = int(local.get("mask_expand") or 0)

        if crop_info is not None:
            composed = imaging.stitch_region(
                canvas, edited, crop_info, mask_canvas,
                blend_pixels=int(local.get("blend_pixels") or 24),
                curve="smoothstep",
                color_match=color_match,
                color_strength=max(color_strength, 0.7),
            )
        else:
            composed = imaging.composite(
                canvas, edited, mask_canvas,
                feather=feather,
                curve="smoothstep",
                color_match=color_match,
                color_strength=color_strength,
                mask_expand=mask_expand,
            )

        outside = _outside_max_abs(canvas, composed, mask_canvas, expand=mask_expand)

        # 回到源尺寸：纯几何裁回，不重采样（零偏移闭环）。
        # 但 size_mode=custom/ratio 时用户要的就是**新尺寸**，不能裁回源尺寸。
        size_mode = str(params.get("size_mode") or "follow")
        if size_mode in ("custom", "ratio"):
            final = composed
            expected_size = (plan.width, plan.height)
        else:
            final = imaging.crop_back_plan(composed, plan, method="bicubic")
            expected_size = src.size
        size_match = final.size == expected_size

        data = imaging.encode_png(final)
        meta = storage.save_output(data, prefix=_prefix(job.prompt, "edit"))
        meta["index"] = 0
        job.images = [meta]
        job.quality = {
            "outside_max_abs": outside,
            "size_match": size_match,
            "canvas": {"w": plan.width, "h": plan.height},
            "source": {"w": src.width, "h": src.height},
            "output": {"w": final.width, "h": final.height},
            "size_mode": size_mode,
            "scheme": scheme,
            "feather": feather,
            "color_match": color_match,
            "lora_warning": job.meta.get("lora_warning"),
            "elapsed_encode_s": round(time.time() - t_start, 1),
        }
        _signal_progress(job, total, total, "完成")
        engine.free(unload=False)

    # -- 内部 ---------------------------------------------------------------
    def _prepare_engine(self, engine, models: dict[str, str],
                        loras: list[dict[str, Any]], job) -> None:
        """装载模型 + 挂 LoRA + （仅冷启动时）预热 kernel。

        为什么区分冷/热：模型已在显存时 ensure_loaded 是 0ms、apply_loras 命中签名缓存也是
        0ms，整单只剩「编码 + 采样 + 解码」≈ 4~8 秒；而刚加载完的第一单，采样/解码要做
        cudnn 与 attention 的算法选择，会多花 10~15 秒，用一次极小尺寸预热把它前移。
        """
        cfg = config.load_config()
        loaded_before = bool((engine.status().get("loaded") or {}).get("unet"))
        engine.ensure_loaded(**models)
        self._apply_loras(engine, loras, job)
        if not loaded_before and cfg.get("warmup_on_load", True):
            try:
                # 按**本次任务的真实尺寸**预热：cudnn/attention 的 autotune 是按 shape 缓存的，
                # 小尺寸预热对大图无效（实测 256 预热后 2.3MP 首图仍旧 20s）。
                engine.warmup(width=int(job.params.get("width") or 0) or None,
                              height=int(job.params.get("height") or 0) or None)
            except Exception as exc:  # noqa: BLE001 - 预热失败不影响出图
                print(f"[pipeline] warmup 跳过：{type(exc).__name__}: {exc}", flush=True)

    @staticmethod
    def _apply_loras(engine, loras: list[dict[str, Any]], job) -> None:
        """应用 LoRA；失败时降级为「不挂 LoRA」并在任务里留警告，而不是整单失败。

        典型场景：18GB 的 HiFi Turbo 适配器在 Windows 上可能因页面文件/提交限制
        mmap 失败（OSError 1455）。此时无 LoRA 的 8 步 + 官方 sigma 仍可用，
        只是画质下降，所以选择「带警告继续」而不是「直接报错」。
        """
        try:
            engine.apply_loras(loras or [])
        except Exception as exc:  # noqa: BLE001
            warning = f"LoRA 应用失败，已降级为不挂 LoRA：{type(exc).__name__}: {exc}"
            job.meta["lora_warning"] = warning
            print(f"[pipeline] WARN {warning}", flush=True)
            try:
                engine.apply_loras([])
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _decode(engine, samples) -> list[Image.Image]:
        result = engine.decode(samples)
        if isinstance(result, Image.Image):
            return [result]
        if isinstance(result, (list, tuple)):
            return list(result)
        raise PipelineError(f"引擎 decode 返回了意外类型：{type(result)!r}")


# --------------------------------------------------------------------------- 辅助


def _make_engine_config(mod, engine_dir: str, paths: dict[str, Any], cfg: dict[str, Any]):
    """兼容 EngineConfig 字段命名差异（engine_dir / comfy_root）。"""
    kwargs = {
        "unet": paths.get("unet"),
        "clip": paths.get("clip"),
        "vae": paths.get("vae"),
        "vram_reserve": float(cfg.get("vram_reserve") or 0.15),
        # 分块解码参数：大图必须走分块，且 tile=1024 比 ComfyUI 默认的 512 快 2.3 倍
        "vae_tile_size": int(cfg.get("vae_tile_size") or 1024),
        "vae_tile_overlap": int(cfg.get("vae_tile_overlap") or 64),
        "tiled_decode_threshold": int(cfg.get("tiled_decode_threshold") or 600_000),
    }
    try:
        return mod.EngineConfig(engine_dir=engine_dir, **kwargs)
    except TypeError:
        for key in ("vae_tile_size", "vae_tile_overlap", "tiled_decode_threshold"):
            kwargs.pop(key, None)
        return mod.EngineConfig(comfy_root=engine_dir, **kwargs)


def _entry_bytes(entry: Any) -> bytes:
    """从 {"data": "data:image/png;base64,..."} 或裸字符串里取字节。"""
    if isinstance(entry, dict):
        raw = entry.get("data") or entry.get("url") or ""
    else:
        raw = str(entry or "")
    if not raw:
        raise PipelineError("图片数据为空")
    if raw.startswith("data:"):
        _mime, data = imaging.parse_data_url(raw)
        return data
    if raw.startswith("/files/"):
        with open(storage.resolve_storage_path(raw[len("/files/"):]), "rb") as fh:
            return fh.read()
    raise PipelineError("无法识别的图片数据（需要 data URL 或 /files/ 路径）")


def _plan_dict(plan) -> dict[str, Any]:
    try:
        return dataclasses.asdict(plan)
    except Exception:  # noqa: BLE001
        return {k: getattr(plan, k) for k in ("width", "height", "scale", "offset_x", "offset_y",
                                             "src_w", "src_h", "fit") if hasattr(plan, k)}


def _prefix(prompt: str, kind: str) -> str:
    """用提示词前几个字做文件名前缀，便于在历史里肉眼分辨。"""
    text = "".join(ch for ch in (prompt or "") if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")
    return (f"qwen21-{kind}-{text[:12]}" if text else f"qwen21-{kind}")
