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
import re
import secrets
import time
from typing import Any, Callable

import numpy as np
from PIL import Image

from . import align, config, imaging, model_slots, models, moss, presets, storage


class PipelineError(RuntimeError):
    """管线内部错误（会作为任务 error 返回给前端）。

    ``code`` / ``meta`` 供前端做结构化提示（例如缺模型时跳转系统设置）。
    """

    def __init__(self, message: str, *, code: str | None = None,
                 meta: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.meta = meta


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


#: 任务别名：与预设校验共用同一份（``presets.TASK_ALIASES``），避免两套口径。
_TASK_ALIASES = presets.TASK_ALIASES

#: 任务指令：与 LoRA 的训练提示词保持一致（缺了会留下灰边 / 绿区）。
_OUTPAINT_INSTRUCTION = "移除图像中的灰色区域，无缝自然延展为完整图像。"
_REMOVE_INSTRUCTION = "移除图像中的绿色区域。"
#: 全景：灰边外补 + 横向连续性，重点是地平线/透视/光线与避免重复元素。
_PANORAMA_INSTRUCTION = (
    "把灰色扩展区域补全为连续的全景画面，保持地平线、透视、光线和主体一致，"
    "左右两侧自然衔接，不要出现重复的人物、建筑或纹理。"
)

#: 任务档位：扩图 / 全景的训练约定（裁块下限、接缝百分比、灰提示）。
#: 前端切任务时会同时改这些键；第三方只传 task.mode 时必须由后端补齐，
#: 否则预设是编辑档（768 / 4% / 5%）就会盖住任务档位（P1-4）。
_TASK_LOCAL_DEFAULTS: dict[str, dict[str, Any]] = {
    "outpaint": {
        "crop_min_side": 1024,
        "expand_pct": 3.0,
        "feather_pct": 3.0,
        "hint": "gray_fill",
        "fills": False,
    },
    "panorama": {
        "crop_min_side": 0,
        "expand_pct": 0.0,
        "feather_pct": 0.0,
        "hint": "gray_fill",
        "fills": False,
    },
}


def _task_local_overrides(local: dict[str, Any], requested: Any,
                          task_mode: str) -> dict[str, Any]:
    """按任务补齐执行档位；``requested`` 里显式给过的键保持不变。"""
    defaults = _TASK_LOCAL_DEFAULTS.get(task_mode)
    if not defaults:
        return local
    explicit = requested if isinstance(requested, dict) else {}
    merged = dict(local or {})
    for key, value in defaults.items():
        if key not in explicit:
            merged[key] = value
    return merged


#: 去水印补全：模型默认只把“水印”理解成文字，徽章 / 编号需要点名（见测试 11a~11d）。
_WATERMARK_INSTRUCTION = (
    "同时移除画面中所有叠加的水印元素，包括斜向平铺文字、角标徽章/logo、编号/日期，"
    "保持底层画面与主体不变。"
)
_WATERMARK_REMOVE_WORDS = ("移除", "去除", "去掉", "消除", "抹掉", "清理", "remove", "erase", "delete", "clean")
_WATERMARK_SCOPE_WORDS = ("徽章", "角标", "编号", "badge", "叠加元素", "斜向平铺文字")


def augment_watermark_prompt(prompt: str, params: dict[str, Any] | None = None,
                            *, detect: str | None = None) -> str | None:
    """提示词提到“水印”且是移除意图时，补全徽章 / 编号等叠加元素。

    返回补全后的提示词；无需补全时返回 ``None``。
    ``task.watermark_scope = "text"``（或顶层 ``watermark_scope``）表示“仅去文字”，
    此时保持原提示词，交给模型只处理文字水印。

    ``detect`` 是关键词判定用的文本（缺省等于 ``prompt``）：前端会把用户原文放在
    ``meta.rawPrompt``，用它判定可以避免风格/滤镜拼出的字样误触发（P2-7）。
    """
    text = str(prompt or "").strip()
    if not text:
        return None
    low = str(detect if detect is not None else text).strip().lower()
    if "水印" not in low and "watermark" not in low:
        return None
    if not any(word in low for word in _WATERMARK_REMOVE_WORDS):
        return None
    params = params or {}
    task = params.get("task") if isinstance(params.get("task"), dict) else {}
    scope = str(task.get("watermark_scope") or params.get("watermark_scope") or "").strip().lower()
    if scope in ("text", "text_only", "text-only", "文字"):
        return None
    if any(word in low for word in _WATERMARK_SCOPE_WORDS):
        return None
    return f"{text}；{_WATERMARK_INSTRUCTION}"


#: 提示图别名：前端历史上传 ``green``，旧数据可能传 ``overlay``。
_HINT_ALIASES = {
    "green": "green_overlay",
    "overlay": "green_overlay",
    "mask": "green_overlay",
    "gray": "gray_fill",
    "grey": "gray_fill",
    "grey_fill": "gray_fill",
}


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


def _make_callback(job, total: int, *, label: str = "采样",
                   offset: int = 0, steps: int | None = None) -> Callable[..., None]:
    """把引擎的采样回调转成任务进度（对回调参数形态不敏感，只数次数）。

    * ``offset``：采样前已占用的进度格数。不加它的话进度会从 4/N 跳回 1/N
      （前端进度条肉眼可见地倒退）。
    * ``steps``：只用于文案里的 ``n/步数``，缺省按 ``total - offset`` 估算。
    * 每次回调都检查取消：用户点「取消」后不必等整轮采样跑完。
    """
    counter = {"n": 0}
    span = max(1, int(steps if steps is not None else total - offset))

    def _cb(*_args, **_kwargs) -> None:
        job.check_cancel()
        counter["n"] += 1
        value = min(offset + counter["n"], max(1, total))
        job.set_progress(value, max(1, total), f"{label} {counter['n']}/{span}")

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


# --------------------------------------------------------------------------- 姿态参考
#
# 语义与 ComfyUI-Gaoshang-Pose / GaoshangQwenFreePose 对齐：
#   image1 = 人偶姿态参考（黑底彩色人偶，只给动作 / 朝向 / 构图）
#   image2.. = 人物与场景参考
#   Qwen 采样时叠加 VNCCS 姿态 LoRA，提示词用 "Draw character from image2" 引导。
# 图生图会把指令里的 <imageN> 整体顺延 1，保证 @ 引用仍然指向原来的图。

POSE_LORA_FILE = "VNCCS_QI2_PoseStudioV1.1.safetensors"
_IMAGE_TOKEN = re.compile(r"<image(\d+)>", re.IGNORECASE)


def _pose_payload(params: dict[str, Any]) -> dict[str, Any] | None:
    pose = params.get("pose")
    if not isinstance(pose, dict):
        return None
    image = pose.get("image") or pose.get("data") or pose.get("dataURL")
    if not image:
        return None
    return pose


def _cap_reference_images(images: list[Image.Image], max_side: int) -> list[Image.Image]:
    """给第 2 张起的参考图设长边上限（32 对齐）。

    第 1 张是编辑画布，直接决定输出尺寸，不能动；其余参考图只提供内容参考，
    超过画布分辨率的部分模型也用不上，却会让 VAE 编码与注意力序列随原图线性变大。
    """
    if max_side <= 0 or len(images) <= 1:
        return images
    out = [images[0]]
    for image in images[1:]:
        width, height = image.size
        long_side = max(width, height)
        if long_side <= max_side:
            out.append(image)
            continue
        scale = max_side / float(long_side)
        new_w = max(32, int(round(width * scale / 32.0)) * 32)
        new_h = max(32, int(round(height * scale / 32.0)) * 32)
        out.append(image.resize((new_w, new_h), Image.LANCZOS))
    return out


def _pose_reference(pose: dict[str, Any], size: tuple[int, int]) -> Image.Image:
    """把姿态图等比放进白底画布，尺寸与采样画布严格一致。

    VNCCS 姿态 LoRA 是在白底人偶图上训练的，补边也必须是白色，
    否则黑边会把「画布边缘」误当成画面内容，姿态跟随会明显变弱。
    """
    raw = pose.get("image") or pose.get("data") or pose.get("dataURL")
    try:
        image = imaging.decode_image(_entry_bytes(raw))
    except Exception as exc:  # noqa: BLE001
        raise PipelineError(f"姿态参考图解码失败：{exc}") from exc
    image = image.convert("RGB")
    resample = getattr(Image, "Resampling", Image).LANCZOS
    scale = min(size[0] / image.width, size[1] / image.height)
    fitted = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        resample,
    )
    canvas = Image.new("RGB", size, (255, 255, 255))
    canvas.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    return canvas


def _shift_image_markers(text: str, offset: int = 1) -> str:
    """姿态图插到最前面后，把提示词里的 <imageN> 统一顺延，保持引用不串位。"""
    return _IMAGE_TOKEN.sub(lambda m: f"<image{int(m.group(1)) + offset}>", text or "")


def _pose_prompt(prompt: str, pose: dict[str, Any], *, mode: str) -> str:
    """按节点语义拼提示词：人偶只提供姿态，不进入画面。"""
    summary = str(pose.get("summary") or "").strip()
    if mode == "edit":
        head = "Draw character from image2."
        guide = (
            "Image1 is a mannequin pose reference: match its body pose, orientation and framing. "
            "Keep the identity, face, hairstyle and clothing of image2. "
            "Do not render the mannequin, its colors, joints or any extra people."
        )
    else:
        head = "Draw a natural, fully rendered person following the exact pose, body orientation and framing of image1."
        guide = "Do not render the mannequin, its colors, joints or any extra people."
    pose_line = f" Pose: {summary}." if summary else ""
    return f"{head} {guide}{pose_line} {prompt}".strip()


def _apply_pose_lora(cfg: dict[str, Any], profile: dict[str, Any],
                     params: dict[str, Any], loras: list[dict[str, Any]], job) -> None:
    """姿态开启时自动挂 VNCCS LoRA；文件缺失只警告，不影响出图。"""
    pose = _pose_payload(params)
    if not pose or profile.get("id") != "qwen":
        return
    if not _truthy(pose.get("use_lora", True)):
        job.meta["pose_lora"] = "请求显式关闭姿态 LoRA"
        return
    path = config.resolve_model(cfg, "lora", pose.get("lora") or POSE_LORA_FILE)
    if not path:
        job.meta["pose_lora"] = f"未找到姿态 LoRA {POSE_LORA_FILE}，本次只做姿态语义参考"
        return
    strength = float(pose.get("strength") if pose.get("strength") is not None else 0.85)
    strength = max(0.0, min(2.0, strength))
    if not any(item["name"] == path for item in loras):
        loras.append({"name": path, "strength": strength})
    job.meta["pose_lora"] = f"{os.path.basename(path)} @ {strength:g}"


# --------------------------------------------------------------------------- 采样计划


def _sampling_plan(params: dict[str, Any], cfg: dict[str, Any],
                   profile: dict[str, Any]) -> dict[str, Any]:
    """解析采样参数；加速模式下覆盖 steps/cfg/sampler（sigma 表或 LoRA 两种）。"""
    turbo = params.get("turbo") or {}
    accel = profile.get("accelerator") or {}
    # 预设 / 自定义搭配里的 sampling 是默认值；请求显式给了就覆盖它。
    preset_sampling = params.get("sampling") if isinstance(params.get("sampling"), dict) else {}
    steps = int(params.get("steps") or preset_sampling.get("steps") or profile["steps"])
    cfg_value = params.get("cfg")
    if cfg_value is None:
        cfg_value = preset_sampling.get("cfg")
    cfg_scale = float(cfg_value if cfg_value is not None else profile["cfg"])
    sampler = str(params.get("sampler") or preset_sampling.get("sampler") or profile["sampler"])
    scheduler = str(params.get("scheduler") or preset_sampling.get("scheduler")
                    or profile["scheduler"])
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
        "denoise": float(
            params.get("denoise")
            if params.get("denoise") is not None
            else (preset_sampling.get("denoise", 1.0))
        ),
        "turbo": turbo_enabled,
        "turbo_plan": turbo_plan,
        "negative_prompt": str(negative),
        "slg": moss.slg_config(profile.get("slg"), params.get("slg")),
    }


def _resolve_models(cfg: dict[str, Any], params: dict[str, Any],
                    profile: dict[str, Any], turbo_unet: str | None = None,
                    task: str | None = None) -> dict[str, str]:
    """按模型档案取权重；请求里的 models.{unet,clip,vae} 可覆盖。

    ``task`` 区分文生图 / 图生图（默认槽位可能不同）；``turbo_unet`` 来自
    Turbo 预设（例如「自动切 Turbo 底模」），优先级最高。
    """
    requested = dict(params.get("models") or {})
    if turbo_unet:
        requested["unet"] = turbo_unet
    if task is None and profile.get("id") == "moss":
        task = "t2i"
    plan = model_slots.resolve_plan(cfg, params.get("preset") or None,
                                    task=task, model=profile.get("id"))
    out: dict[str, str] = {}
    missing: list[dict[str, Any]] = []
    for key in ("unet", "clip", "vae"):
        value = requested.get(key)
        expected = value or plan.get(key) or profile.get(key)
        path = config.resolve_model(cfg, key, expected) if expected else None
        if not path:
            missing.append({
                "slot": key,
                "expected": expected,
                "searched_dirs": config.model_search_dirs(cfg).get(key) or [],
            })
            continue
        out[key] = path
    if missing:
        first = missing[0]
        raise PipelineError(
            f"找不到默认 {first['slot']} 模型：{first['expected']!r}。"
            "请到「系统设置 → 默认模型」重新选择，或检查模型目录。",
            code="missing_models",
            meta={"missing": missing},
        )
    return out


def _lora_basename(value: Any) -> str:
    """LoRA 文件名归一：前端可能传绝对路径，后端配的是相对路径。"""
    return os.path.basename(str(value or "").replace("\\", "/")).strip().lower()


def _ensure_task_lora(loras: list[dict[str, Any]], task_mode: str) -> list[dict[str, Any]]:
    """保证「移除 / 扩图」的任务 LoRA 存在，但同一文件不重复挂两份。

    前端会按任务先挂一次（传绝对路径），后端再按预设注入一次（相对路径），
    按路径字符串判重会漏掉；这里统一按文件名判，命中就保留用户那份
    （显式 > 预设，强度也听用户的）。
    """
    spec = config.resolve_lora_preset(task_mode)
    if not spec:
        return loras
    key = _lora_basename(spec.get("name"))
    for item in loras:
        if not isinstance(item, dict):
            continue
        if str(item.get("preset") or "").strip().lower() == task_mode:
            return loras
        if key and _lora_basename(item.get("name") or item.get("value")) == key:
            return loras
    return [{"preset": task_mode}, *loras]


def _build_loras(cfg: dict[str, Any], params: dict[str, Any], profile: dict[str, Any], *,
                 sampling: dict[str, Any]) -> list[dict[str, Any]]:
    """收集 LoRA：请求里显式的 + 加速档位要求的 + 一致性 LoRA。"""
    loras: list[dict[str, Any]] = []
    accel = profile.get("accelerator") or {}
    plan = model_slots.resolve_plan(cfg, params.get("preset") or None)

    def _add(name: str | None, strength: float, slot: str | None = None) -> None:
        path = config.resolve_model(cfg, "lora", name)
        if not path:
            raise PipelineError(
                f"找不到 LoRA：{name!r}（检查 models/lora 路径，或在系统设置里改默认）",
                code="missing_models",
                meta={"missing": [{
                    "slot": slot or "lora",
                    "expected": name,
                    "searched_dirs": config.model_search_dirs(cfg).get("lora") or [],
                }]},
            )
        if any(item["name"] == path for item in loras):
            return
        loras.append({"name": path, "strength": float(strength)})

    for item in (params.get("loras") or []):
        if not item:
            continue
        preset = item.get("preset")
        if preset:
            spec = config.resolve_lora_preset(str(preset))
            if not spec:
                raise PipelineError(
                    f"未知 LoRA 预设：{preset!r}（可选 "
                    f"{', '.join(config.LORA_TASKS)}）")
            # 系统设置里的默认 LoRA 槽位只接管 remove / outpaint；
            # 一致性 LoRA 仍按已验证的预设强度走，避免改变现网表现。
            slot = {"remove": "remove_lora", "outpaint": "outpaint_lora"}.get(
                str(preset).strip().lower())
            name = (plan.get(slot) if slot else None) or spec["name"]
            _add(name, float(item.get("strength", spec["strength"])), slot)
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
    if isinstance(consistency, dict) and consistency.get("enabled") is False:
        consistency = None
    if consistency and profile["id"] == "qwen":
        _add(consistency.get("name") or cfg.get("consistency_lora"),
             float(consistency.get("strength", 1.0)))

    # 契约约束：一致性 + 任务 LoRA 叠加后最多 2 个；超了只警告，不擅自丢任务 LoRA。
    if len(loras) > 2:
        sampling["lora_warning"] = (
            f"LoRA 数量 {len(loras)} 超过建议上限 2，可能互相干扰："
            + "、".join(os.path.basename(item["name"]) for item in loras)
        )

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


def _zero_shift_spec(params: dict[str, Any], profile: dict[str, Any],
                     size_mode: str) -> dict[str, Any]:
    """解析并校验 ``zero_shift`` 契约；只在 ``follow`` 模式下生效。

    严格模式（前端默认）：``resolution`` 必须为 0（画布跟随源图）、``snap`` 必须
    等于模型对齐值。任何一条不满足都直接拒绝，避免"看起来没偏移、其实重采样过"。
    """
    zs = params.get("zero_shift")
    if not isinstance(zs, dict):
        zs = {}
    snap = int(zs.get("snap") or profile.get("snap") or 32)
    # 默认开启（§13.7：图片精修零偏移默认开），只有显式 false 才关闭。
    raw_enabled = zs.get("enabled")
    enabled = (True if raw_enabled is None else _truthy(raw_enabled)) and size_mode == "follow"
    if not enabled:
        return {"enabled": False, "snap": snap, "resolution": 0}
    resolution = int(zs.get("resolution") or 0)
    if resolution != 0:
        raise PipelineError(
            f"零偏移要求 resolution=0（画布跟随源图），收到 resolution={resolution}")
    expected = int(profile.get("snap") or 32)
    if snap != expected:
        raise PipelineError(
            f"零偏移对齐必须是 {expected} 的倍数，收到 snap={snap}")
    return {"enabled": True, "snap": snap, "resolution": 0}


def verify_zero_shift(spec: dict[str, Any], plan: imaging.CanvasPlan,
                      src_size: tuple[int, int],
                      out_size: tuple[int, int]) -> None:
    """零偏移几何验收：画布对齐、输出尺寸与源图一致。失败即拒绝出图。"""
    if not spec.get("enabled"):
        return
    snap = int(spec.get("snap") or 32)
    if plan.width % snap or plan.height % snap:
        raise PipelineError(
            f"零偏移校验失败：画布 {plan.width}×{plan.height} 不是 {snap} 的倍数")
    if tuple(out_size) != tuple(src_size):
        raise PipelineError(
            f"零偏移校验失败：输出 {out_size[0]}×{out_size[1]} "
            f"≠ 源图 {src_size[0]}×{src_size[1]}")


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
            engine_config = _make_engine_config(mod, engine_dir, profile, cfg)
            engine = mod.NativeEngine(engine_config)
            self._engines[model_id] = engine

        # 显存策略可在运行期切换（/api/settings），这里每次取引擎都同步一次
        engine_cfg = getattr(engine, "config", None)
        if engine_cfg is not None and hasattr(engine_cfg, "keep_text_encoder_resident"):
            engine_cfg.keep_text_encoder_resident = bool(
                cfg.get("keep_text_encoder_resident", True))

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
    def _profile(cfg: dict[str, Any], params: dict[str, Any],
                 task: str | None = None) -> dict[str, Any]:
        try:
            return models.get(cfg, params.get("model"), task=task)
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc

    def status(self) -> dict[str, Any]:
        try:
            info = dict((self._engine or self.engine).status())
        except Exception as exc:  # noqa: BLE001
            info = {"available": False, "reason": str(exc),
                    "loaded": {"unet": None, "clip": None, "vae": None, "loras": []}}
        # 当前驻留模型：仅当权重真的在显存里才算（空闲卸载后回到 None）
        loaded = info.get("loaded") or {}
        info["model"] = self._active_model if loaded.get("unet") else None
        return info

    def release_text_encoder(self) -> int:
        """把已加载引擎的文本编码器挪出显存，返回实际释放的引擎数。

        对应顶栏「显存策略 = 让位」：立即归还约 9GB，而不是等下一次采样。
        """
        released = 0
        for engine in self._engines.values():
            if engine is None:
                continue
            fn = getattr(engine, "release_text_encoder", None)
            if callable(fn):
                try:
                    released += 1 if fn() else 0
                except Exception:  # noqa: BLE001 - 释放失败不影响设置保存
                    pass
        return released

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
        profile = self._profile(cfg, params, task="t2i")
        width, height = _t2i_size(cfg, params, profile)
        batch = max(1, min(int(params.get("batch") or 1), int(cfg["max_batch"])))
        for side in (width, height):
            if side > int(cfg["max_side"]):
                raise PipelineError(f"尺寸超限：{side} > max_side {cfg['max_side']}")

        sampling = _sampling_plan(params, cfg, profile)
        turbo_unet = ((sampling.get("turbo_plan") or {}).get("unet") or {}).get("path")
        model_paths = _resolve_models(cfg, params, profile, turbo_unet=turbo_unet, task="t2i")
        loras = _build_loras(cfg, params, profile, sampling=sampling)
        _apply_pose_lora(cfg, profile, params, loras, job)
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]
        if sampling.get("lora_warning") and not job.meta.get("lora_warning"):
            job.meta["lora_warning"] = sampling["lora_warning"]
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

        total = sampling["steps"] + 5
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

        # cfg≈1（Turbo）时采样器不读 uncond；负向留空就不必再跑一遍 CLIP
        encode_negative = not (
            abs(float(sampling["cfg"]) - 1.0) < 1e-6
            and not str(sampling["negative_prompt"] or "").strip()
        )

        # 姿态参考：作为 image1 交给文本编码器，latent 仍是空画布
        pose = _pose_payload(params) if profile["id"] == "qwen" else None
        if pose:
            pose_ref = _pose_reference(pose, (width, height))
            prompt = _pose_prompt(prompt, pose, mode="t2i")
            cond = engine.encode_text(
                prompt,
                sampling["negative_prompt"],
                images=[pose_ref],
                resolution=0,
                encode_negative=encode_negative,
            )
            job.meta["pose"] = {
                "preset": pose.get("preset"),
                "label": pose.get("label"),
                "summary": pose.get("summary"),
                "role": "image1",
            }
            job.params["pose_prompt"] = prompt
        else:
            cond = engine.encode_text(
                prompt, sampling["negative_prompt"], encode_negative=encode_negative)

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
            callback=_make_callback(job, total, offset=3, steps=sampling["steps"]),
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
        # 记录「用户原始请求」（预设合并前）：历史回退要按用户意图还原，
        # 不能把后端自动挂载的任务 / 一致性 / 加速 LoRA 当成用户选择写回界面。
        if "request_loras" not in job.meta:
            job.meta["request_loras"] = [
                {"name": os.path.basename(str(item.get("name") or "")),
                 "strength": item.get("strength")}
                for item in (params.get("loras") or [])
                if isinstance(item, dict) and item.get("name")
            ]
        job.meta.setdefault("request_consistency", params.get("consistency_lora"))
        # 预设合并：显式 > preset > 内置默认。不带 preset 时原样返回（老前端无感）。
        try:
            params, preset_info = presets.merge(params)
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc
        if preset_info is not None:
            job.params["preset"] = preset_info["id"]
            job.params["preset_version"] = preset_info["version"]
            # 连续编辑约定：随 job.params 原样记录，前端 / 历史回放据此恢复接力策略。
            chain = params.get("chain")
            if isinstance(chain, dict):
                job.params["chain"] = dict(chain)
            job.meta["preset"] = preset_info
        profile = self._profile(cfg, params, task="edit")
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
        timings: dict[str, float] = {"decode_input": round(time.time() - t_start, 2)}
        size_mode = str(params.get("size_mode") or "follow")
        local = params.get("local") or {}
        warnings: list[str] = []

        # 任务模式归一：前端 detectTask 会给出 replace / inpaint，它们本质都是
        # 普通局部编辑，不能因为名字不同就 400。
        requested_task = str((params.get("task") or {}).get("mode") or "edit").strip().lower()
        task_mode = _TASK_ALIASES.get(requested_task, "edit")

        # 元素移除靠绿色选区训练；没圈区域就退回普通编辑，并明确告诉用户原因。
        if task_mode == "remove" and not params.get("mask"):
            task_mode = "edit"
            warnings.append("未圈选区域，元素移除已按普通编辑处理（Remove LoRA 依赖绿色选区）")

        # 扩图：先补灰边画板，模型把灰色去掉，最后保留整张外扩图。
        op_info: imaging.OutpaintInfo | None = None
        op_canvas: Image.Image | None = None
        pano_plan: imaging.PanoramaPlan | None = None
        pano_aspect = "2:1"
        pano_long_side = 3072
        pano_wrap = False
        pano_seam_blend = 24
        wrap_report: dict[str, Any] | None = None
        if task_mode == "outpaint":
            op = params.get("outpaint") or {}
            try:
                pads = {key: float(op.get(key) or 0) for key in ("left", "right", "top", "bottom")}
            except (TypeError, ValueError) as exc:
                raise PipelineError(f"扩图比例必须是数字：{exc}") from exc
            if not any(value > 0 for value in pads.values()):
                # 只写了"扩图"却没给比例：退回普通编辑，避免生成一张尺寸没变的图
                task_mode = "edit"
                warnings.append("未设置外扩比例，扩图已按普通编辑处理")
            else:
                try:
                    # 缺省跟随全局上限：写死 5120 会在 max_side=4096 的机器上
                    # 「先建大画布、再被上限拒绝」，随机失败（P1-9）。
                    op_max_side = int(op.get("max_side") or cfg.get("max_side") or 4096)
                except (TypeError, ValueError) as exc:
                    raise PipelineError(f"outpaint.max_side 必须是整数：{exc}") from exc
                try:
                    # 裁边：某些源图四周带 1~3px 白边/描边，直接外扩会把这条边续出去；
                    # 先裁掉再让模型重新生成（默认 0，不影响不带边框的图）。
                    op_trim = max(0, min(64, int(op.get("trim") or 0)))
                except (TypeError, ValueError) as exc:
                    raise PipelineError(f"扩图裁边必须是整数：{exc}") from exc
                try:
                    op_canvas, op_info = imaging.outpaint_canvas(
                        src, multiple=int(profile.get("snap") or 32),
                        max_side=op_max_side, trim=op_trim, **pads)
                except ValueError as exc:
                    raise PipelineError(f"扩图参数不可用：{exc}") from exc

        elif task_mode == "panorama":
            # 全景：按目标比例算最小外扩画布，源图等比缩到画布内（只缩不放）。
            pan = params.get("panorama") or {}
            pano_aspect = str(pan.get("aspect") or "2:1")
            pano_wrap = _truthy(pan.get("wrap"))
            try:
                pano_long_side = int(pan.get("long_side") or 3072)
                pano_seam_blend = int(pan.get("seam_blend") or 24)
            except (TypeError, ValueError) as exc:
                raise PipelineError(f"全景参数必须是整数：{exc}") from exc
            try:
                pano_plan = imaging.panorama_plan(
                    src.width, src.height,
                    aspect=pano_aspect,
                    long_side=pano_long_side,
                    multiple=int(profile.get("snap") or 32),
                    max_side=int(cfg.get("max_side") or 4096),
                )
            except ValueError as exc:
                raise PipelineError(f"全景参数不可用：{exc}") from exc
            op_canvas = imaging.panorama_canvas(src, pano_plan)
            op_info = pano_plan.to_outpaint_info()

        # 任务档位归一：预设是编辑档而任务被切到扩图/全景时，不能让编辑档位
        # （768 / 4% / 5%）盖住任务训练约定；请求显式给过的键仍然优先。
        local = _task_local_overrides(local, job.params.get("local"), task_mode)
        params = {**params, "local": local}

        if task_mode in ("outpaint", "panorama"):
            # 扩图/全景输出的是"更大的画布"，零偏移语义不适用（尺寸本就要变）。
            zs_spec = {"enabled": False, "snap": int(profile.get("snap") or 32), "resolution": 0}
        else:
            zs_spec = _zero_shift_spec(params, profile, size_mode)
            if (size_mode == "follow"
                    and isinstance(params.get("zero_shift"), dict)
                    and params["zero_shift"].get("enabled") is not None
                    and not _truthy(params["zero_shift"].get("enabled"))):
                warnings.append("已关闭零像素偏移保护，可能出现亚像素偏移或 1~31px 位移")

        # 大图预处理：只缩不放，出图后还原。仅 follow 模式启用（custom/ratio 是
        # 用户指定新尺寸，预处理会把这条路径搅乱）；扩图自身已决定画布大小。
        pp_params = params.get("preprocess") or {}
        pp = imaging.preprocess_plan(
            src.width, src.height,
            enabled=_truthy(pp_params.get("enabled")) and size_mode == "follow"
            and task_mode not in ("outpaint", "panorama"),
            max_side=int(pp_params.get("max_side") or 2048),
            min_side=int(pp_params.get("min_side") or 768),
            multiple=int(pp_params.get("multiple") or profile.get("snap") or 32),
            mode=str(pp_params.get("mode") or "downscale_only"),
        )
        # 没真正缩小就不走预处理：对齐补边交给 plan_canvas 即可，少一条路径。
        use_pp = pp.enabled and (pp.work_w, pp.work_h) != (pp.src_w, pp.src_h)
        if op_canvas is not None:
            src_work = op_canvas
            use_pp = False
        else:
            src_work = imaging.apply_preprocess(src, pp) if use_pp else src

        # 画布规划（32 对齐）——零像素偏移的第一步
        plan_params = {**params, "size_mode": "follow"} if op_canvas is not None else params
        plan = _plan_canvas_for(src_work, plan_params, multiple=int(profile.get("snap") or 32))
        canvas = imaging.compose_canvas(src_work, plan, pad_mode=str(params.get("pad_mode") or "edge"))
        if canvas.size != (plan.width, plan.height):
            raise PipelineError(
                f"画布尺寸异常：期望 {plan.width}×{plan.height}，实际 {canvas.size}")

        # 与文生图共用同一上限：custom/ratio 或关闭预处理时可能规划出超大画布，
        # 在编码前就拦住，别等 CUDA OOM 把整个服务拖死。
        side_limit = int(cfg.get("max_side") or 4096)
        if max(plan.width, plan.height) > side_limit:
            raise PipelineError(
                f"编辑画布 {plan.width}×{plan.height} 超过上限 {side_limit}（max_side）；"
                "请开启大图预处理、缩小输出尺寸，或改用 follow 模式"
            )

        # 遮罩（原图尺寸 → 工作画布坐标），零色差靠它把遮罩外原样保留
        mask_canvas: np.ndarray | None = None
        mask_src: np.ndarray | None = None
        if params.get("mask"):
            mask_bytes = _entry_bytes(params["mask"])
            try:
                mask_src = imaging.decode_mask(mask_bytes, src_work.width, src_work.height)
            except ValueError as exc:
                raise PipelineError(f"遮罩不可用：{exc}。请重新圈选要修改的区域") from exc
            mask_canvas = imaging.map_mask_to_canvas(mask_src, plan)
        if op_info is not None:
            op_mask = imaging.outpaint_mask(op_info)
            mask_canvas = op_mask if mask_canvas is None else np.maximum(mask_canvas, op_mask)

        # 产品提示：让用户知道这次到底改了多少（不阻断，只解释）
        coverage: float | None = None
        if mask_canvas is not None:
            coverage = float((mask_canvas > 0.01).mean())
            if task_mode not in ("outpaint", "panorama") and coverage > 0.9:
                warnings.append(f"选区覆盖 {coverage:.0%}，接近整图重绘，遮罩外像素也会被模型重画")
            job.meta["mask_coverage"] = round(coverage, 4)
        elif task_mode not in ("outpaint", "panorama"):
            warnings.append("未圈选区域，本次将按整图重绘")

        # 记录输入图，供历史回看
        input_urls: list[str] = []
        for image, entry in zip(decoded, entries):
            meta = storage.save_upload(imaging.encode_png(image), ext=".png",
                                       orig_name=(entry.get("name") if isinstance(entry, dict) else None))
            input_urls.append(meta["url"])
        job.meta["input_urls"] = input_urls

        # 遮罩留档：还原到原图尺寸，历史「回到图像编辑」时可直接回填遮罩编辑器
        if mask_src is not None:
            mask_image = Image.fromarray(
                np.where(mask_src > 0.5, 255, 0).astype(np.uint8), mode="L")
            if mask_image.size != src.size:
                mask_image = mask_image.resize(src.size, Image.NEAREST)
            job.meta["mask_url"] = storage.save_upload(
                imaging.encode_png(mask_image), ext=".png", orig_name="mask.png")["url"]

        job.align = {
            "canvas": {"w": plan.width, "h": plan.height},
            "source": {"w": src.width, "h": src.height},
            "work": {"w": src_work.width, "h": src_work.height},
            "applied": True,
            "plan": _plan_dict(plan),
            "preprocess": {**dataclasses.asdict(pp), "applied": bool(use_pp)},
            "zero_shift": dict(zs_spec),
        }
        if op_info is not None:
            align_key = "panorama" if task_mode == "panorama" else "outpaint"
            job.align[align_key] = dataclasses.asdict(op_info)

        scheme = (str(local.get("scheme") or "a").strip().lower()
                  if _truthy(local.get("enabled")) else "none")
        if scheme == "raw":
            scheme = "native"
        if scheme not in ("a", "b") and mask_canvas is None:
            # 没有遮罩 = 整图编辑：本来就没有「遮罩外」可保留，直接走原生。
            # 这样 BlueBox 整图颜色一致性才生效（全画布编辑最需要校色）。
            scheme = "native"
        if scheme == "auto":
            # 与前端 resolveScheme 同口径：小遮罩走整画布（接缝最稳），
            # 中等遮罩才裁局部（省显存）；无遮罩/超大遮罩一律回整画布。
            scheme = "b" if coverage is not None and 0.02 < coverage < 0.45 else "a"
        if task_mode == "panorama":
            # 全景必须整画布采样：裁块会切断横向连续性，接缝无法还原。
            scheme = "a"
        sampling = _sampling_plan(params, cfg, profile)
        # 记录真正生效的采样参数：前端通常传 seed=null，历史/回放要靠这里才能复现。
        job.params.update({
            "model": profile["id"],
            "steps": sampling["steps"], "cfg": sampling["cfg"],
            "sampler": sampling["sampler"], "scheduler": sampling["scheduler"],
            "seed": sampling["seed"], "denoise": sampling["denoise"],
            "turbo": {
                "enabled": bool(sampling["turbo"]),
                "profile": str((params.get("turbo") or {}).get("profile") or ""),
            },
            "negative_prompt": sampling["negative_prompt"],
            "sigmas": sampling["sigmas"],
        })
        if sampling.get("slg"):
            job.params["slg"] = sampling["slg"]
        turbo_unet = ((sampling.get("turbo_plan") or {}).get("unet") or {}).get("path")
        model_paths = _resolve_models(cfg, params, profile, turbo_unet=turbo_unet, task="edit")
        # 显式任务模式但没带 LoRA 时，按任务自动挂预设：
        # 第三方 API 只传 task.mode 也能得到 Remove / 扩图 LoRA 的正确效果。
        # 普通编辑默认挂「一致性无偏移」LoRA（与孤海工作流一致），
        # 可用 params.consistency_lora = false 或 local.consistency = false 关掉。
        cons_cfg = params.get("consistency_lora")
        # 预设 / 自定义搭配里的 consistency 是默认值；请求显式给了 consistency_lora 就优先。
        if cons_cfg is None:
            preset_cons = params.get("consistency")
            if isinstance(preset_cons, dict):
                if preset_cons.get("enabled") is False:
                    cons_cfg = False
                else:
                    cons_cfg = {
                        "name": preset_cons.get("lora") or cfg.get("consistency_lora"),
                        "strength": float(preset_cons.get("strength", 0.48)),
                    }
                params = dict(params)
                params["consistency_lora"] = cons_cfg
        cons_switch = local.get("consistency")
        # local.consistency=false 是硬关闭：即使 consistency_lora 是对象也不能再挂。
        if cons_switch is not None and not _truthy(cons_switch):
            cons_cfg = False
            params = dict(params)
            params["consistency_lora"] = False
        cons_enabled = not (
            cons_cfg is False
            or (isinstance(cons_cfg, dict) and cons_cfg.get("enabled") is False)
            or (cons_switch is not None and not _truthy(cons_switch))
        )
        # 显式 consistency_lora 已经是"用户指定的那份"，不能再自动补 preset consistency，
        # 否则同一类 LoRA 会挂两份（0.48 的 GH 版 + 用户选的文件）。
        has_explicit_consistency = isinstance(cons_cfg, dict) and cons_cfg.get("enabled") is not False
        current_loras = list(params.get("loras") or [])
        if task_mode in ("remove", "outpaint"):
            # 任务 LoRA 是训练约定的一部分：即使用户加了别的 LoRA 也要保证它存在；
            # 同一文件（前端绝对路径 vs 后端相对路径）只挂一份。
            merged_loras = _ensure_task_lora(current_loras, task_mode)
            if merged_loras is not current_loras:
                params = dict(params)
                params["loras"] = merged_loras
        elif not current_loras and cons_enabled and not has_explicit_consistency:
            params = dict(params)
            params["loras"] = [{"preset": "consistency"}]
        loras = _build_loras(cfg, params, profile, sampling=sampling)
        _apply_pose_lora(cfg, profile, params, loras, job)
        # 真正挂载的 LoRA 写回 job.params：预设/任务自动挂载的那部分原本只在局部变量里，
        # 历史回放与质量报告看不到（测试用例 0a 复现）。
        job.params["loras"] = [
            {"name": os.path.basename(item["name"]), "strength": item["strength"]}
            for item in loras
        ]
        if sampling.get("turbo_lora_note"):
            job.meta["turbo_lora"] = sampling["turbo_lora_note"]
        if sampling.get("lora_warning") and not job.meta.get("lora_warning"):
            job.meta["lora_warning"] = sampling["lora_warning"]
        if turbo_unet:
            job.meta["turbo_unet"] = os.path.basename(turbo_unet)

        engine = self._engine_for(profile)
        total = sampling["steps"] + 6
        _signal_progress(job, 1, total, "准备模型")
        self._prepare_engine(engine, model_paths, loras, job)
        timings["prepare"] = round(time.time() - t_start, 2)
        job.check_cancel()

        # ---- 方案 B：先裁切局部，只采样这一块（省显存）
        crop_info = None
        if scheme == "b" and mask_canvas is not None:
            # 默认走孤海 GH_MaskCropV2 的几何：短边 × 每向独立系数（上 1.3 / 其余 1.4），
            # 遮罩内部空洞按需填充；裁切块长边夹到 [crop_min_side, crop_max_side]，
            # 小遮罩也放大到 768，模型才有足够分辨率（孤海节点 8）。
            # 扩图与编辑的参数分家（决策 37）：裁块下限 1024（孤海扩图档位），
            # 用户显式传的 local.crop_min_side 仍然优先。
            default_crop_min = 1024 if task_mode == "outpaint" else 768
            crop_min_side = int(
                local.get("crop_min_side")
                if local.get("crop_min_side") is not None else default_crop_min)
            crop_img, crop_info = imaging.crop_region_factors(
                canvas, mask_canvas,
                fills=_truthy(local.get("fills", task_mode == "remove")),
                expand_top=float(local.get("expand_top") or 1.3),
                expand_bottom=float(local.get("expand_bottom") or 1.4),
                expand_left=float(local.get("expand_left") or 1.4),
                expand_right=float(local.get("expand_right") or 1.4),
                multiple=int(profile.get("snap") or 32),
                max_side=int(local.get("crop_max_side") or 2048),
                min_side=crop_min_side,
                # 最小裁剪窗：小遮罩以遮罩为中心扩到至少 crop_floor 见方（默认 1024，与孤海一致），
                # 补真实周边像素而不是把小块放大。
                min_window=int(local.get("crop_floor", 1024) or 0),
            )
            job.align["crop"] = dataclasses.asdict(crop_info)
            ref_images = [crop_img] + decoded[1:]
        else:
            ref_images = [canvas] + decoded[1:]

        # 提示图（green overlay）：移除任务始终开启，让 LoRA 看到的输入分布与训练一致。
        # 扩图不需要绿提示——灰边本身就是提示；普通编辑默认关闭。
        # 兼容前端写法（"green"）与旧数据（"overlay"）：统一归一到规范名。
        hint_mode = str(local.get("hint") or "").strip().lower()
        hint_mode = _HINT_ALIASES.get(hint_mode, hint_mode)
        if task_mode in ("outpaint", "panorama"):
            hint_mode = "gray_fill"
        else:
            if hint_mode in ("", "auto"):
                hint_mode = "green_overlay" if task_mode == "remove" else "none"
            if task_mode == "remove":
                # Remove LoRA 按「绿色选区」训练；既然自动挂了 LoRA，就必须给绿提示，
                # 否则移除效果会明显退化（用户显式传 none 时说明原因，不静默）。
                if hint_mode != "green_overlay":
                    warnings.append("元素移除已自动启用绿色选区提示（Remove LoRA 的训练约定）")
                hint_mode = "green_overlay"
            elif hint_mode not in ("none", "green_overlay"):
                hint_mode = "none"
            if hint_mode == "green_overlay" and mask_canvas is not None:
                if scheme == "b" and crop_info is not None:
                    hint_mask = imaging.crop_mask_for_region(crop_info, mask_canvas)
                else:
                    hint_mask = mask_canvas
                ref_images[0] = imaging.mask_hint_overlay(ref_images[0], hint_mask)

        # 采样画布 / latent 的基准始终是「编辑目标」（或方案 B 的裁切块）
        work_image = ref_images[0]

        # 第 2 张起的参考图不需要比输出画布更清晰：按画布长边设上限。
        # 否则 4K/8K 参考图会按原分辨率做 VAE 编码，耗时和显存都随原图尺寸暴涨。
        ref_images = _cap_reference_images(ref_images, max(max(work_image.size), 1024))

        # 扩图 / 全景：先按孤海工作流的「图像缩放（范围）」把整张画布（原图 + 灰边）
        # 缩到长边 1024~2048 再采样，出图后还原回画布尺寸。
        # 直接在 4K 级画布上采样，模型会丢细节、外补区发虚、接缝亮度跳变。
        sample_res = {
            "from": [work_image.width, work_image.height],
            "to": [work_image.width, work_image.height],
            "applied": False,
        }
        if task_mode in ("outpaint", "panorama"):
            try:
                sample_limit = int(local.get("sample_max_side") or 2048)
            except (TypeError, ValueError):
                sample_limit = 2048
            sample_w, sample_h = imaging.sample_size_for(
                work_image.width, work_image.height,
                max_side=sample_limit,
                min_side=int(local.get("sample_min_side") or 1024),
                multiple=int(profile.get("snap") or 32),
            )
            if (sample_w, sample_h) != work_image.size:
                work_image = work_image.resize((sample_w, sample_h), Image.LANCZOS)
                ref_images[0] = work_image
                sample_res.update(to=[sample_w, sample_h], applied=True)
        job.align["sample_res"] = sample_res

        # cfg≈1（Turbo）时采样器不读 uncond；负向留空就不必再跑一遍 CLIP
        encode_negative = not (
            abs(float(sampling["cfg"]) - 1.0) < 1e-6
            and not str(sampling["negative_prompt"] or "").strip()
        )

        _signal_progress(job, 2, total, "文本编码（含参考图）")
        prompt_text = job.prompt or ""
        # 关键词判定只看**用户原文**：风格/滤镜拼进来的「灰色 / 全景 / 绿色」等字样
        # 不该让训练指令被跳过（P2-7）。前端会把原文放在 meta.rawPrompt。
        meta_in = params.get("meta") if isinstance(params.get("meta"), dict) else {}
        raw_prompt = str(meta_in.get("rawPrompt") or "").strip() or prompt_text
        probe = raw_prompt.lower()
        # 任务指令补全：这两条是 LoRA 的训练约定，缺了会出现"灰边没去掉 / 绿区没移除"。
        if task_mode == "panorama" and not any(
                key in probe for key in ("全景", "panorama", "panoramic", "宽幅")):
            prompt_text = _PANORAMA_INSTRUCTION + prompt_text
            job.meta["prompt_augmented"] = "panorama"
        elif task_mode == "outpaint" and not any(
                key in probe for key in ("灰色", "灰边", "gray", "grey")):
            prompt_text = _OUTPAINT_INSTRUCTION + prompt_text
            job.meta["prompt_augmented"] = "outpaint"
        elif hint_mode == "green_overlay" and not any(
                key in probe for key in ("绿色", "绿区", "green")):
            prompt_text = _REMOVE_INSTRUCTION + prompt_text
            job.meta["prompt_augmented"] = "remove"
        # 去水印：模型默认只理解“文字水印”，徽章 / 编号需要点名补全。
        watermark_prompt = augment_watermark_prompt(prompt_text, params, detect=raw_prompt)
        if watermark_prompt:
            prompt_text = watermark_prompt
            job.meta["watermark_prompt"] = True
            warnings.append(
                "提示词提到水印但未点名徽章 / 编号，已自动补全为“文字 + 徽章 + 编号”全量移除；"
                "如需只去文字，请设置 task.watermark_scope=text")
        # 姿态参考：插到最前面成为 image1，编辑目标顺延为 image2；
        # 提示词里的 <imageN> 同步顺延，避免 @ 引用指错图。
        pose = _pose_payload(params) if profile["id"] == "qwen" else None
        if pose:
            pose_ref = _pose_reference(pose, work_image.size)
            ref_images = [pose_ref] + ref_images
            prompt_text = _shift_image_markers(prompt_text, 1)
            prompt_text = _pose_prompt(prompt_text, pose, mode="edit")
            job.meta["pose"] = {
                "preset": pose.get("preset"),
                "label": pose.get("label"),
                "summary": pose.get("summary"),
                "role": "image1",
                "target": "image2",
            }
            job.meta["pose_prompt"] = prompt_text

        cond = engine.encode_text(
            prompt_text,
            sampling["negative_prompt"],
            images=ref_images,
            resolution=int(params.get("resolution") or 0),
            encode_negative=encode_negative,
        )
        timings["encode"] = round(time.time() - t_start, 2)

        # 零偏移守卫：采样画布必须与参考图画布同尺寸
        cond_canvas = cond.get("canvas")
        if cond_canvas and tuple(cond_canvas) != work_image.size:
            raise PipelineError(
                f"零偏移守卫：参考图画布 {tuple(cond_canvas)} 与采样画布 {work_image.size} 不一致。"
                f"请把 resolution 设为 0，或让画布尺寸等于参考图尺寸。")

        job.check_cancel()
        _signal_progress(job, 3, total, "VAE 编码")
        # 没有姿态参考时，encode_text 的 image1 就是编辑目标：它已经做过一次 VAE 编码，
        # 直接 clone 出来当初始 latent，省掉同样一张图的第二次 VAE 前向。
        reused = None if pose else cond.get("latent")
        latent = reused.clone() if reused is not None else engine.encode_latent(work_image)
        timings["latent"] = round(time.time() - t_start, 2)
        # 送采样器的遮罩用硬边（>0.5）：与孤海工作流的硬遮罩一致，
        # 软边只在合成/贴回阶段用，否则边缘会出现半透明过渡带（阶段 4 · M4）。
        sample_mask = None
        if mask_canvas is not None:
            sample_mask = (mask_canvas > 0.5).astype(mask_canvas.dtype)
            if sample_res.get("applied") and sample_mask.shape[1::-1] != tuple(work_image.size):
                # 扩图把画布缩小采样时，噪声遮罩要同步缩到采样尺寸（最近邻保持硬边）。
                mask_image = Image.fromarray(
                    (sample_mask * 255).astype(np.uint8), mode="L")
                mask_image = mask_image.resize(work_image.size, Image.NEAREST)
                sample_mask = (np.asarray(mask_image) > 127).astype(np.float32)
        noise_mask = sample_mask if scheme == "a" else None

        job.check_cancel()
        _signal_progress(job, 4, total, "扩散采样")
        try:
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
                callback=_make_callback(job, total, offset=4, steps=sampling["steps"]),
            )
        except Exception as exc:  # noqa: BLE001 - 只翻译 OOM，其它异常原样抛出
            if "out of memory" not in str(exc).lower():
                raise
            raise PipelineError(
                "显存不足：请开启大图预处理、降低编辑画布/扩图比例，"
                "或关闭其它占用显卡的程序后重试"
            ) from exc
        timings["sample"] = round(time.time() - t_start, 2)
        job.check_cancel()

        _signal_progress(job, total - 1, total, "解码与合成")
        edited_list = self._decode(engine, samples)
        timings["decode"] = round(time.time() - t_start, 2)
        edited = edited_list[0]
        if sample_res.get("applied"):
            # 还原：采样尺寸 → 画布尺寸（唯一一次重采样），随后仍按整画布遮罩合成，
            # 源图区在合成阶段逐字节保留。
            target_size = tuple(sample_res["from"])
            if edited.size != target_size:
                edited = edited.resize(target_size, Image.LANCZOS)

        feather = int(local.get("feather") if local.get("feather") is not None else 32)
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

        if scheme == "native":
            # 原生模式：不裁块、不贴回、不用遮罩；整张画布就是模型输出。
            # 只保留 BlueBox 式整图颜色一致性（可关），几何/预处理仍走零偏移闭环。
            # color_match 也参与判断：前端「颜色匹配」开关在原生模式下必须同样有效。
            composed = edited
            if anchor_match and color_match:
                composed, color_report = imaging.color_consistency(
                    canvas, composed, strength=anchor_strength)
            else:
                color_report = {"mode": "global_affine", "skipped": True, "reason": "disabled"}
        elif crop_info is not None:
            # 接缝按孤海 GH_CropRestore：遮罩包围盒平均边长 × 4% 向外膨胀、
            # × 5% 羽化；颜色还原用 gain 0.9~1.1 / offset ±24 的安全夹取。
            composed = imaging.stitch_region(
                canvas, edited, crop_info, mask_canvas,
                blend_pixels=int(local.get("blend_pixels") or 24),
                curve="smoothstep",
                color_match=color_match,
                color_strength=color_strength,
                anchor_match=anchor_match,
                anchor_strength=anchor_strength,
                band_mode=band_mode,
                dither=_truthy(local.get("dither", True)),
                # 扩图接缝按孤海扩图档位 3%/3%，编辑档位仍是 4%/5%（决策 37）。
                expand_pct=float(local.get("expand_pct")
                                 if local.get("expand_pct") is not None
                                 else (3.0 if task_mode == "outpaint" else 4.0)),
                feather_pct=float(local.get("feather_pct")
                                  if local.get("feather_pct") is not None
                                  else (3.0 if task_mode == "outpaint" else 5.0)),
                color_gain_clamp=(0.9, 1.1),
                color_shift_abs=24.0 / 255.0,
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
                dither=_truthy(local.get("dither", True)),
                report=color_report,
            )

        # 方案 B 的写入范围 = 遮罩向外膨胀 expand_px + 羽化 feather_px 的过渡带；
        # 验收「零色差」要以这条带的外沿为界，否则会把有意写入的接缝当成泄漏。
        band = color_report.get("mask_band") if isinstance(color_report, dict) else None
        band_px = 0
        if isinstance(band, dict):
            band_px = int(band.get("expand_px", 0)) + int(band.get("feather_px", 0))
        effective_expand = band_px if scheme == "b" else mask_expand

        # 原生模式不承诺"遮罩外逐字节保留"，这里如实返回 None，避免误读。
        outside = (None if scheme == "native"
                   else _outside_max_abs(canvas, composed, mask_canvas,
                                         expand=effective_expand))

        # 诊断（只读）：模型实际改动比例 / 遮罩外泄漏；失败不影响出图。
        try:
            diag_mask = (align.dilate_mask(mask_canvas, effective_expand)
                         if band_px and mask_canvas is not None else mask_canvas)
            diff_stats = align.changed_stats(
                canvas, composed, diag_mask, inside_mask=mask_canvas)
        except Exception as exc:  # noqa: BLE001 - 诊断是附加信息，不能拖垮任务
            print(f"[pipeline] 改动诊断跳过：{type(exc).__name__}: {exc}", flush=True)
            diff_stats = {}

        # 回到源尺寸：纯几何裁回，不重采样（零偏移闭环）。
        # 但 size_mode=custom/ratio 时用户要的就是**新尺寸**，不能裁回源尺寸；
        # 扩图同理——输出的就是外扩后的大图。
        if task_mode in ("outpaint", "panorama"):
            final = composed
            expected_size = (plan.width, plan.height)
        elif size_mode in ("custom", "ratio"):
            final = composed
            expected_size = (plan.width, plan.height)
        else:
            final = imaging.crop_back_plan(composed, plan, method="bicubic")
            if use_pp:
                # 预处理还原：先整数裁掉 32 补边，再唯一一次重采样回原尺寸
                final = imaging.restore_preprocess(final, pp)
            expected_size = src.size
        # 源图与扩展区的交界：模型补全结果和源图边缘常有十几到三十级的亮度阶跃，
        # 合成后就是一条竖向亮带。这里只在扩展区一侧做渐变对齐，源图像素不动。
        seam_report = None
        if task_mode == "panorama" and pano_plan is not None:
            final, seam_report = imaging.seam_level(
                final,
                {
                    "left": pano_plan.left, "right": pano_plan.right,
                    "top": pano_plan.top, "bottom": pano_plan.bottom,
                },
            )
        elif task_mode == "outpaint" and op_info is not None:
            # 扩图同样需要交界渐变：模型在灰边一侧画出的亮带/阶跃，
            # 合成后会沿着源图边界显出一个「方框」。只改扩展区，源图像素不动。
            final, seam_report = imaging.seam_level(
                final,
                {
                    "left": op_info.left, "right": op_info.right,
                    "top": op_info.top, "bottom": op_info.bottom,
                },
            )
        # 360° 环绕接缝：仅全景可开，属于实验能力（官方未承诺等距柱状投影）。
        if task_mode == "panorama" and pano_wrap and pano_seam_blend > 0:
            final, wrap_report = imaging.wrap_seam_blend(
                final, blend_px=pano_seam_blend)
        size_match = final.size == expected_size

        # 零偏移硬验收：任何几何走样都在这里拦下，不落盘。
        verify_zero_shift(zs_spec, plan, (src.width, src.height), final.size)

        data = imaging.encode_png(final, compress_level=int(cfg.get("png_compress_level", 1)))
        meta = storage.save_output(data, prefix=_prefix(job.prompt, "edit", profile["id"]),
                                   image=final)
        meta["index"] = 0
        job.images = [meta]
        job.quality = {
            "outside_max_abs": outside,
            "size_match": size_match,
            "preset": (preset_info or {}).get("id"),
            "preset_label": (preset_info or {}).get("label"),
            "preset_version": (preset_info or {}).get("version"),
            # 真正生效的采样参数：前端可能不回传（由预设决定），这里给结果页一个可核对的口径
            "sampling": {
                "steps": sampling["steps"],
                "cfg": sampling["cfg"],
                "sampler": sampling["sampler"],
                "scheduler": sampling["scheduler"],
                "denoise": sampling["denoise"],
                # 统一成对象：结果页按 s.turbo.enabled / s.turbo.profile 读（P2-3）
                "turbo": {
                    "enabled": bool(sampling["turbo"]),
                    "profile": str((params.get("turbo") or {}).get("profile") or ""),
                },
            },
            "canvas": {"w": plan.width, "h": plan.height},
            # 送进采样器的画布（方案 B 是裁块）与本次是否用到了遮罩
            "sample_canvas": {"w": work_image.width, "h": work_image.height},
            # 扩图/全景的采样缩放记录：from=画布尺寸，to=实际采样尺寸
            "sample_res": dict(sample_res),
            "mask_used": mask_canvas is not None,
            "source": {"w": src.width, "h": src.height},
            "output": {"w": final.width, "h": final.height},
            "size_mode": size_mode,
            "scheme": scheme,
            "feather": feather,
            "color_match": color_match,
            "color": color_report,
            "hint_mode": hint_mode,
            "task_mode": task_mode,
            "task_requested": requested_task,
            "seed": sampling["seed"],
            "warnings": warnings,
            "outpaint": (dataclasses.asdict(op_info)
                         if op_info is not None and task_mode != "panorama" else None),
            # 扩图/全景的交界渐变报告：before_* 是原阶跃，after_* 是摊平后的残差
            "seam": seam_report,
            "panorama": ({
                "aspect": pano_aspect,
                "long_side": pano_long_side,
                "wrap": pano_wrap,
                "seam_blend": pano_seam_blend,
                "canvas": {"w": pano_plan.canvas_w, "h": pano_plan.canvas_h},
                "work": {"w": pano_plan.work_w, "h": pano_plan.work_h},
                "pads": {
                    "left": pano_plan.left, "right": pano_plan.right,
                    "top": pano_plan.top, "bottom": pano_plan.bottom,
                },
                "scale": pano_plan.scale,
                "seam_report": seam_report,
                "wrap_report": wrap_report,
            } if pano_plan is not None else None),
            "preprocess": {
                "applied": bool(use_pp),
                "scale": round(float(pp.scale), 6),
                "work": {"w": pp.work_w, "h": pp.work_h},
                "canvas": {"w": pp.canvas_w, "h": pp.canvas_h},
            },
            "zero_shift": dict(zs_spec, verified=bool(zs_spec.get("enabled"))),
            "changed_ratio": diff_stats.get("changed_ratio"),
            # 遮罩内改动率：判断"局部编辑有没有真的改到目标"的唯一可靠指标
            # （全图 changed_ratio 会被小目标稀释，删对了也只有 0.1% 左右）。
            "mask_changed_ratio": diff_stats.get("mask_changed_ratio"),
            "leak_ratio": diff_stats.get("leak_ratio"),
            "diff_threshold": diff_stats.get("threshold"),
            "lora_warning": job.meta.get("lora_warning"),
            "loras": job.params.get("loras") or [],
            "pose_lora": job.meta.get("pose_lora"),
            "turbo_lora": job.meta.get("turbo_lora"),
            "turbo_unet": job.meta.get("turbo_unet"),
            "prompt_augmented": job.meta.get("prompt_augmented"),
            "watermark_prompt": bool(job.meta.get("watermark_prompt")),
            "model": profile["id"],
            # 分阶段耗时（累计时间戳，含解码输入/读权重）：用来定位到底慢在哪一段
            "timings": {**timings, "total": round(time.time() - t_start, 1)},
            "elapsed_s": round(time.time() - t_start, 1),
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
        # 显存策略：文本编码器是否常驻（运行期可在顶栏切换）
        "keep_text_encoder_resident": bool(cfg.get("keep_text_encoder_resident", True)),
    }
    try:
        return mod.EngineConfig(engine_dir=engine_dir, **kwargs)
    except TypeError:
        for key in ("vae_tile_size", "vae_tile_overlap", "tiled_decode_threshold",
                    "encode_cache_size", "clip_type", "text_backend",
                    "latent_channels", "latent_downscale", "keep_text_encoder_resident"):
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
        try:
            with open(storage.resolve_storage_path(raw[len("/files/"):]), "rb") as fh:
                return fh.read()
        except FileNotFoundError as exc:
            raise PipelineError(f"引用的图片不存在或已被清理：{raw}") from exc
        except ValueError as exc:
            raise PipelineError(f"图片路径不合法：{raw}") from exc
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
