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

from . import align, config, imaging, models, moss, storage


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


def _sampling_plan(params: dict[str, Any], cfg: dict[str, Any],
                   profile: dict[str, Any]) -> dict[str, Any]:
    """解析采样参数；加速模式下覆盖 steps/cfg/sampler（sigma 表或 LoRA 两种）。"""
    turbo = params.get("turbo") or {}
    accel = profile.get("accelerator") or {}
    steps = int(params.get("steps") or profile["steps"])
    cfg_scale = float(params.get("cfg") if params.get("cfg") is not None else profile["cfg"])
    sampler = str(params.get("sampler") or profile["sampler"])
    scheduler = str(params.get("scheduler") or profile["scheduler"])
    sigmas: list[float] | None = None
    turbo_plan: dict[str, Any] | None = None
    turbo_enabled = _truthy(turbo.get("enabled"))

    if turbo_enabled and accel.get("kind") == "sigma":
        # Qwen：预设是唯一权威（自动挂加速 LoRA 或自动切 Turbo 底模）
        turbo_plan = config.turbo_plan(cfg, turbo.get("profile") or accel.get("profile"))
        missing = []
        if turbo_plan.get("lora") and turbo_plan["lora"]["missing"]:
            missing.append(f"加速 LoRA {turbo_plan['lora']['file']}")
        if turbo_plan.get("unet") and turbo_plan["unet"]["missing"]:
            missing.append(f"Turbo 底模 {turbo_plan['unet']['file']}")
        if missing:
            raise PipelineError(
                "Turbo 预设缺少文件：" + "、".join(missing)
                + "。请检查 config.json 的 turbo_lora / turbo_unet。"
            )
        sigmas = [float(v) for v in turbo_plan["sigmas"]]
        # 容忍预设只给 8 个值（不带末尾 0.0）
        if sigmas[-1] != 0.0:
            sigmas = sigmas + [0.0]
        steps = len(sigmas) - 1
        cfg_scale = float(turbo_plan["cfg"])
        sampler = str(turbo_plan["sampler"])
        scheduler = str(turbo_plan["scheduler"])
    elif turbo_enabled and accel.get("kind") == "lora":
        # MOSS：8 步加速 LoRA 没有自带 sigma 表，走普通 scheduler + 8 步 / cfg 1
        steps = int(accel.get("steps") or 8)
        cfg_scale = float(accel.get("cfg") if accel.get("cfg") is not None else 1.0)
        sampler = str(accel.get("sampler") or "euler")
        scheduler = str(accel.get("scheduler") or "simple")

    negative = params.get("negative_prompt")
    if negative is None:
        negative = profile.get("negative_prompt") or ""

    return {
        "sigmas": sigmas,
        "steps": max(1, steps),
        "cfg": cfg_scale,
        "sampler": sampler,
        "scheduler": scheduler,
        "seed": _pick_seed(params.get("seed")),
        "denoise": float(params.get("denoise") if params.get("denoise") is not None else 1.0),
        "turbo": turbo_enabled,
        "turbo_plan": turbo_plan,
        "negative_prompt": str(negative),
        "slg": moss.slg_config(profile.get("slg"), params.get("slg")),
    }


def _resolve_models(cfg: dict[str, Any], params: dict[str, Any],
                    profile: dict[str, Any], turbo_unet: str | None = None) -> dict[str, str]:
    """按模型档案取权重；请求里的 models.{unet,clip,vae} 可覆盖。

    ``turbo_unet`` 来自 Turbo 预设（例如「自动切 Turbo 底模」），优先级最高。
    """
    requested = dict(params.get("models") or {})
    if turbo_unet:
        requested["unet"] = turbo_unet
    out: dict[str, str] = {}
    for key in ("unet", "clip", "vae"):
        value = requested.get(key)
        path = config.resolve_model(cfg, key, value) if value else profile.get(key)
        if not path:
            raise PipelineError(
                f"找不到 {key} 模型：{value or profile.get(key)!r}。请检查 config.json 的 "
                f"model_root / {key}，或在请求里显式指定绝对路径。"
            )
        out[key] = path
    return out


def _build_loras(cfg: dict[str, Any], params: dict[str, Any], profile: dict[str, Any], *,
                 sampling: dict[str, Any]) -> list[dict[str, Any]]:
    """收集 LoRA：请求里显式的 + 加速档位要求的 + 一致性 LoRA。"""
    loras: list[dict[str, Any]] = []
    accel = profile.get("accelerator") or {}

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
        if accel.get("kind") == "sigma":
            # Qwen：加速 LoRA 完全由预设决定，并且同时只允许挂一个。
            plan = sampling.get("turbo_plan") or {}
            allowed = (plan.get("lora") or {}).get("path")
            dropped: list[str] = []
            kept: list[dict[str, Any]] = []
            for item in loras:
                if config.is_accel_lora(item["name"]):
                    # 同一个文件由预设以固定强度重新挂载，不重复提示
                    if item["name"] != allowed:
                        dropped.append(os.path.basename(item["name"]))
                else:
                    kept.append(item)
            loras[:] = kept
            if allowed:
                if not any(item["name"] == allowed for item in loras):
                    loras.append({
                        "name": allowed,
                        "strength": float(plan["lora"]["strength"]),
                    })
                lora_info = (
                    f"{os.path.basename(allowed)} @ {plan['lora']['strength']}"
                    f"（预设 {plan.get('label') or plan.get('id')} 自动挂载）"
                )
            else:
                unet_file = (plan.get("unet") or {}).get("file")
                lora_info = (
                    f"不挂加速 LoRA（预设已切换 Turbo 底模 {unet_file}）"
                    if unet_file else "不挂加速 LoRA"
                )
            if dropped:
                lora_info += "；已忽略多余的加速 LoRA：" + "、".join(dropped)
            sampling["turbo_lora_note"] = lora_info
        else:
            # LoRA 型加速（MOSS）：请求可指定别的 8 步 LoRA，或 turbo.lora="none" 关掉
            requested = turbo.get("lora")
            strength = turbo.get("lora_strength", turbo.get("strength"))
            if requested is False or str(requested or "").strip().lower() == "none":
                lora_info = "不挂 8 步加速 LoRA（请求显式关闭）"
            else:
                name = requested or accel.get("lora")
                path = config.resolve_model(cfg, "lora", name)
                if not path:
                    raise PipelineError(
                        f"找不到加速 LoRA：{name!r}（检查 config.json 的 moss.turbo_lora 或 models/lora 路径）")
                strength = float(accel.get("strength", 1.0) if strength is None else strength)
                if not any(item["name"] == path for item in loras):
                    loras.append({"name": path, "strength": strength})
                lora_info = f"{os.path.basename(path)} @ {strength}（8 步加速）"
        sampling["turbo_lora_note"] = lora_info

    consistency = params.get("consistency_lora")
    if consistency and profile["id"] == "qwen":
        _add(consistency.get("name") or cfg.get("consistency_lora"),
             float(consistency.get("strength", 1.0)))

    return loras


def _t2i_size(cfg: dict[str, Any], params: dict[str, Any],
              profile: dict[str, Any]) -> tuple[int, int]:
    """文生图画布：显式宽高优先；只给比例时按比例 + 百万像素算（对齐 ResolutionSelector）。"""
    snap = int(profile.get("snap") or 32)
    ratio = params.get("ratio")
    if ratio and not params.get("width") and not params.get("height"):
        megapixels = params.get("megapixels")
        if profile["id"] == "moss":
            width, height = moss.resolution_size(
                ratio, float(megapixels or profile.get("megapixels") or 1.0), multiple=snap)
        else:
            width, height = config.ratio_size(
                str(ratio), float(megapixels) if megapixels else None, multiple=snap)
    else:
        width = params.get("width") or profile.get("width") or cfg["width"]
        height = params.get("height") or profile.get("height") or cfg["height"]
    return config.snap32(width, snap), config.snap32(height, snap)


def _plan_canvas_for(src: Image.Image, params: dict[str, Any],
                     multiple: int = 32) -> imaging.CanvasPlan:
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
        multiple=int(multiple or 32),
    )


# --------------------------------------------------------------------------- 管线主体


class Pipeline:
    """把「引擎 + 对齐/色彩 + 存储」串起来的薄编排层。"""

    def __init__(self, engine: Any | None = None) -> None:
        self._engine = engine
        #: 每个模型档案一个引擎（切换模型时把其它引擎的权重卸掉，32G 放不下两套）
        self._engines: dict[str, Any] = {"qwen": engine} if engine is not None else {}
        self._active_model: str | None = "qwen" if engine is not None else None

    # -- 引擎（惰性创建，避免模块导入时就加载 torch） ----------------------
    @property
    def engine(self):
        """默认模型（config.json 的 model）对应的引擎。"""
        return self._engine_for(models.default_profile(config.load_config()))

    def _engine_for(self, profile: dict[str, Any]):
        cfg = config.load_config()
        model_id = profile["id"]
        engine = self._engines.get(model_id)
        if engine is None:
            mod = _load_engine_module()
            engine_dir = config.find_engine_dir(cfg)
            if not engine_dir:
                raise PipelineError(
                    "找不到引擎代码目录 engine/comfy。请先执行：\n"
                    "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\port_engine.ps1"
                )
            if cfg.get("keep_text_encoder_resident", True):
                # 引擎默认每单把 CLIP 挪出显存再装回（省显存，但每单多 0.8~1.4s）。
                # 32GB 卡上 16GB 权重放得下，连续出图保持常驻更快。
                os.environ.setdefault("QWEN_NATIVE_KEEP_TEXT_ENCODER", "1")
            engine_config = _make_engine_config(mod, engine_dir, profile, cfg)
            engine = mod.NativeEngine(engine_config)
            self._engines[model_id] = engine

        # 换模型：把其它引擎已加载的权重卸掉（否则两套 9~20GB 权重会 OOM）
        for other_id, other in self._engines.items():
            if other_id == model_id or other is None:
                continue
            if getattr(other, "_model", None) is not None:
                try:
                    other.free(unload=True)
                except Exception:  # noqa: BLE001 - 卸载失败不阻塞出图
                    pass

        self._engine = engine
        self._active_model = model_id
        return engine

    @staticmethod
    def _profile(cfg: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        try:
            return models.get(cfg, params.get("model"))
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc

    def status(self) -> dict[str, Any]:
        try:
            return (self._engine or self.engine).status()
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
        profile = self._profile(cfg, params)
        width, height = _t2i_size(cfg, params, profile)
        batch = max(1, min(int(params.get("batch") or 1), int(cfg["max_batch"])))
        for side in (width, height):
            if side > int(cfg["max_side"]):
                raise PipelineError(f"尺寸超限：{side} > max_side {cfg['max_side']}")

        sampling = _sampling_plan(params, cfg, profile)
        turbo_unet = ((sampling.get("turbo_plan") or {}).get("unet") or {}).get("path")
        model_paths = _resolve_models(cfg, params, profile, turbo_unet=turbo_unet)
        loras = _build_loras(cfg, params, profile, sampling=sampling)
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]
        if turbo_unet:
            job.meta["turbo_unet"] = os.path.basename(turbo_unet)
        job.params.update({
            "model": profile["id"],
            "width": width, "height": height, "batch": batch,
            "steps": sampling["steps"], "cfg": sampling["cfg"],
            "sampler": sampling["sampler"], "scheduler": sampling["scheduler"],
            "seed": sampling["seed"], "turbo": sampling["turbo"],
            "negative_prompt": sampling["negative_prompt"],
            "sigmas": sampling["sigmas"],
        })
        if sampling.get("slg"):
            job.params["slg"] = sampling["slg"]
            job.meta["slg"] = {k: sampling["slg"].get(k) for k in
                               ("single_layers", "double_layers", "start_percent", "end_percent")}

        total = sampling["steps"] + 3
        engine = self._engine_for(profile)
        _signal_progress(job, 1, total, "准备模型")
        self._prepare_engine(engine, model_paths, loras, job)
        job.check_cancel()

        _signal_progress(job, 2, total, "文本编码")
        prompt = job.prompt or ""
        # 边界框布局（可选，仅支持该能力的模型）：把框换成 MOSS 需要的布局提示词
        if profile["capabilities"].get("bbox"):
            payload = params.get("bbox") if params.get("bbox") is not None else params.get("bboxes")
            if payload:
                try:
                    prompt, bbox_info = moss.build_layout_prompt(prompt, payload, width, height)
                except ValueError as exc:
                    raise PipelineError(f"边界框参数非法：{exc}") from exc
                job.meta["bbox"] = bbox_info
                if bbox_info.get("enabled"):
                    job.params["layout_prompt"] = prompt
        elif params.get("bbox") or params.get("bboxes"):
            job.meta["bbox_ignored"] = "当前模型不支持边界框布局（仅 MOSS 支持）"

        if profile["capabilities"].get("rgba") and _truthy(params.get("rgba")) and "RGBA" not in prompt:
            prompt = (f"This is an RGBA image with transparency. {prompt} "
                      f"The image has an alpha channel and a transparent background.")
        cond = engine.encode_text(prompt, sampling["negative_prompt"])

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
            slg=sampling["slg"],
            callback=_make_callback(job, sampling["steps"]),
        )
        job.check_cancel()

        _signal_progress(job, total - 1, total, "解码")
        decoded = self._decode(engine, samples)
        want_alpha = bool(profile["capabilities"].get("rgba")) and _truthy(params.get("rgba"))
        saved: list[dict[str, Any]] = []
        for idx, image in enumerate(decoded):
            out = image if want_alpha else _flatten_on_white(image)
            data = imaging.encode_png(out, compress_level=int(cfg.get("png_compress_level", 1)))
            meta = storage.save_output(data, prefix=_prefix(job.prompt, "t2i", profile["id"]),
                                       image=out)
            meta["index"] = idx
            saved.append(meta)
        job.images = saved
        job.quality = {"size_match": True, "outside_max_abs": None, "canvas": None,
                       "model": profile["id"]}
        _signal_progress(job, total, total, "完成")
        engine.free(unload=False)  # 只清缓存，模型留在显存给下一次用

    # -- 图像编辑 -----------------------------------------------------------
    def generate_edit(self, job) -> None:
        cfg = config.load_config()
        params = job.params
        profile = self._profile(cfg, params)
        if not profile["capabilities"].get("edit"):
            raise PipelineError(f"{profile['label']} 暂不支持参考图编辑（当前只支持文生图）")
        entries = params.get("images") or []
        if not entries:
            raise PipelineError("图像编辑至少需要 1 张输入图片")
        if len(entries) > 10:
            raise PipelineError("最多支持 10 张参考图（image_1 … image_10）")
        params["model"] = profile["id"]

        t_start = time.time()
        decoded: list[Image.Image] = []
        for entry in entries:
            data = _entry_bytes(entry)
            decoded.append(imaging.decode_image(data))
        src = decoded[0]
        size_mode = str(params.get("size_mode") or "follow")

        # 大图预处理：只缩不放，出图后还原。仅 follow 模式启用（custom/ratio 是
        # 用户指定新尺寸，预处理会把这条路径搅乱）。
        pp_params = params.get("preprocess") or {}
        pp = imaging.preprocess_plan(
            src.width, src.height,
            enabled=_truthy(pp_params.get("enabled")) and size_mode == "follow",
            max_side=int(pp_params.get("max_side") or 2048),
            min_side=int(pp_params.get("min_side") or 768),
            multiple=int(pp_params.get("multiple") or profile.get("snap") or 32),
            mode=str(pp_params.get("mode") or "downscale_only"),
        )
        # 没真正缩小就不走预处理：对齐补边交给 plan_canvas 即可，少一条路径。
        use_pp = pp.enabled and (pp.work_w, pp.work_h) != (pp.src_w, pp.src_h)
        src_work = imaging.apply_preprocess(src, pp) if use_pp else src

        # 画布规划（32 对齐）——零像素偏移的第一步
        plan = _plan_canvas_for(src_work, params, multiple=int(profile.get("snap") or 32))
        canvas = imaging.compose_canvas(src_work, plan, pad_mode=str(params.get("pad_mode") or "edge"))
        if canvas.size != (plan.width, plan.height):
            raise PipelineError(
                f"画布尺寸异常：期望 {plan.width}×{plan.height}，实际 {canvas.size}")

        # 遮罩（原图尺寸 → 工作画布坐标），零色差靠它把遮罩外原样保留
        mask_canvas: np.ndarray | None = None
        if params.get("mask"):
            mask_bytes = _entry_bytes(params["mask"])
            mask_src = imaging.decode_mask(mask_bytes, src_work.width, src_work.height)
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
            "work": {"w": src_work.width, "h": src_work.height},
            "applied": True,
            "plan": _plan_dict(plan),
            "preprocess": {**dataclasses.asdict(pp), "applied": bool(use_pp)},
        }

        local = params.get("local") or {}
        scheme = str(local.get("scheme") or "a") if _truthy(local.get("enabled")) else "none"
        sampling = _sampling_plan(params, cfg, profile)
        turbo_unet = ((sampling.get("turbo_plan") or {}).get("unet") or {}).get("path")
        model_paths = _resolve_models(cfg, params, profile, turbo_unet=turbo_unet)
        loras = _build_loras(cfg, params, profile, sampling=sampling)
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]
        if turbo_unet:
            job.meta["turbo_unet"] = os.path.basename(turbo_unet)

        engine = self._engine_for(profile)
        total = sampling["steps"] + 4
        _signal_progress(job, 1, total, "准备模型")
        self._prepare_engine(engine, model_paths, loras, job)
        job.check_cancel()

        # ---- 方案 B：先裁切局部，只采样这一块（省显存）
        crop_info = None
        if scheme == "b" and mask_canvas is not None:
            crop_img, crop_info = imaging.crop_region(
                canvas, mask_canvas,
                context_factor=float(local.get("context_factor") or 1.5),
                context_pixels=int(local.get("context_pixels") or 96),
                multiple=int(profile.get("snap") or 32),
            )
            job.align["crop"] = dataclasses.asdict(crop_info)
            ref_images = [crop_img] + decoded[1:]
        else:
            ref_images = [canvas] + decoded[1:]

        _signal_progress(job, 2, total, "文本编码（含参考图）")
        cond = engine.encode_text(
            job.prompt or "",
            sampling["negative_prompt"],
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
            slg=sampling["slg"],
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
        # 锚区仿射（BlueBox 思路）是 color_match 的子模式：可用时替代 Reinhard。
        anchor_match = _truthy(local.get("color_restore", True))
        anchor_strength = float(
            local.get("color_restore_strength")
            if local.get("color_restore_strength") is not None
            else 1.0
        )
        band_mode = str(local.get("band_mode") or "lowfreq")
        if band_mode not in ("alpha", "lowfreq"):
            band_mode = "lowfreq"
        color_report: dict[str, Any] = {}

        if crop_info is not None:
            composed = imaging.stitch_region(
                canvas, edited, crop_info, mask_canvas,
                blend_pixels=int(local.get("blend_pixels") or 24),
                curve="smoothstep",
                color_match=color_match,
                color_strength=max(color_strength, 0.7),
                anchor_match=anchor_match,
                anchor_strength=anchor_strength,
                band_mode=band_mode,
                report=color_report,
            )
        else:
            composed = imaging.composite(
                canvas, edited, mask_canvas,
                feather=feather,
                curve="smoothstep",
                color_match=color_match,
                color_strength=color_strength,
                mask_expand=mask_expand,
                anchor_match=anchor_match,
                anchor_strength=anchor_strength,
                band_mode=band_mode,
                report=color_report,
            )

        outside = _outside_max_abs(canvas, composed, mask_canvas, expand=mask_expand)

        # 诊断（只读）：模型实际改动比例 / 遮罩外泄漏；失败不影响出图。
        try:
            diff_stats = align.changed_stats(canvas, composed, mask_canvas)
        except Exception as exc:  # noqa: BLE001 - 诊断是附加信息，不能拖垮任务
            print(f"[pipeline] 改动诊断跳过：{type(exc).__name__}: {exc}", flush=True)
            diff_stats = {}

        # 回到源尺寸：纯几何裁回，不重采样（零偏移闭环）。
        # 但 size_mode=custom/ratio 时用户要的就是**新尺寸**，不能裁回源尺寸。
        if size_mode in ("custom", "ratio"):
            final = composed
            expected_size = (plan.width, plan.height)
        else:
            final = imaging.crop_back_plan(composed, plan, method="bicubic")
            if use_pp:
                # 预处理还原：先整数裁掉 32 补边，再唯一一次重采样回原尺寸
                final = imaging.restore_preprocess(final, pp)
            expected_size = src.size
        size_match = final.size == expected_size

        data = imaging.encode_png(final, compress_level=int(cfg.get("png_compress_level", 1)))
        meta = storage.save_output(data, prefix=_prefix(job.prompt, "edit", profile["id"]),
                                   image=final)
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
            "color": color_report,
            "preprocess": {
                "applied": bool(use_pp),
                "scale": round(float(pp.scale), 6),
                "work": {"w": pp.work_w, "h": pp.work_h},
                "canvas": {"w": pp.canvas_w, "h": pp.canvas_h},
            },
            "changed_ratio": diff_stats.get("changed_ratio"),
            "leak_ratio": diff_stats.get("leak_ratio"),
            "diff_threshold": diff_stats.get("threshold"),
            "lora_warning": job.meta.get("lora_warning"),
            "model": profile["id"],
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


def _make_engine_config(mod, engine_dir: str, profile: dict[str, Any],
                        cfg: dict[str, Any]):
    """把模型档案翻译成 EngineConfig（字段名兼容旧版引擎）。"""
    is_moss = profile["id"] == "moss"
    kwargs = {
        "unet": profile.get("unet"),
        "clip": profile.get("clip"),
        "vae": profile.get("vae"),
        "vram_reserve": float(cfg.get("vram_reserve") or 0.15),
        # 模型私有：CLIPType / 文本编码方式 / latent 形状
        "clip_type": "moss_image" if is_moss else "qwen_image",
        "text_backend": "moss" if is_moss else "qwen",
        "latent_channels": int(profile.get("latent_channels") or 64),
        "latent_downscale": int(profile.get("latent_downscale") or 16),
        # 分块解码参数：大图必须走分块，且 tile=1024 比 ComfyUI 默认的 512 快 2.3 倍
        "vae_tile_size": int(cfg.get("vae_tile_size") or 1024),
        "vae_tile_overlap": int(cfg.get("vae_tile_overlap") or 64),
        "tiled_decode_threshold": int(cfg.get("tiled_decode_threshold") or 600_000),
        # 文本编码缓存：同提示词连抽多张时复用 conditioning
        "encode_cache_size": int(cfg.get("encode_cache_size", 8)),
    }
    try:
        return mod.EngineConfig(engine_dir=engine_dir, **kwargs)
    except TypeError:
        for key in ("vae_tile_size", "vae_tile_overlap", "tiled_decode_threshold",
                    "encode_cache_size", "clip_type", "text_backend",
                    "latent_channels", "latent_downscale"):
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


def _prefix(prompt: str, kind: str, model_id: str = "qwen") -> str:
    """用提示词前几个字做文件名前缀，便于在历史里肉眼分辨。"""
    text = "".join(ch for ch in (prompt or "") if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")
    tag = "qwen21" if model_id == "qwen" else str(model_id)
    return f"{tag}-{kind}-{text[:12]}" if text else f"{tag}-{kind}"
