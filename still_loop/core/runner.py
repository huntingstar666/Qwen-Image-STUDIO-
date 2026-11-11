"""接力循环：分镜 → 逐帧编辑 → 自检 → 重试 → 人工审核 → 动画导出。"""
from __future__ import annotations

import io
import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageOps

from .. import config
from . import anim_client, checker, matte, motion as motion_lib, planner, store
from .generator import (FrameRef, GeneratedImage, GeneratorCanceled, GeneratorError,
                        MockGenerator)
from .schema import normalize_settings

EventFn = Callable[[dict[str, Any]], None]

#: 成长叙事每帧都是大幅重绘，主项目会把平背景重画成一层颗粒/布纹。
#: 单独跑一次「只清理背景」的编辑能把背景恢复干净，主体基本不动（实测 P1）。
CLEAN_BACKGROUND_PROMPT = (
    "以<image1>为画布，保持镜头、机位、光照、主体、土堆与构图完全不变；"
    "只做一件事：把背景清理干净，变成纯净无纹理的米白色无缝背景纸——"
    "去掉所有颗粒、斑点、布纹与噪点，土堆以外不要有任何散落的泥土颗粒"
)

#: 键控参考帧：把参考图的纸背景换成纯品红，主体原样保留。
#: 之后每帧都在品红底上画主体，本地抠 alpha 叠回固定背景板。
KEY_REFERENCE_PROMPT = (
    "以<image1>为画布，只做一件事：把整张背景替换成纯品红色 #FF00FF 的纯色色块。"
    "画面里的主体（山体、地台、植物、道具）保持原来的位置、大小、材质、光照与细节，完全不动。"
    "背景不要天空、云、地平线、渐变、阴影、纹理、颗粒，也不要在背景上画任何其他东西。"
    "<image2> 提供主体的材质与配色。"
)


def _background_mode(settings: dict[str, Any], idea: str) -> str:
    mode = str(settings.get("background") or "auto")
    if mode == "auto":
        return "fixed" if planner.is_growth(idea) else "plain"
    return mode if mode in ("fixed", "plain") else "plain"


def _key_reference(run: dict[str, Any], reference: FrameRef, generator,
                   total: int, on_event: EventFn | None) -> FrameRef | None:
    """让模型把参考图的主体搬到品红底上；失败三次就放弃图层模式。"""
    for attempt in (1, 2, 3):
        if attempt > 1:
            prompt = f"{KEY_REFERENCE_PROMPT}上一次背景不够纯，请把整张背景铺满纯品红 #FF00FF。"
            if hasattr(generator, "wait_ready"):
                generator.wait_ready(90)
        else:
            prompt = KEY_REFERENCE_PROMPT
        try:
            result = generator.generate(
                reference, reference, prompt, 0, total, attempt,
                on_progress=(lambda info: _on_job_progress(run, info, on_event)))
        except GeneratorCanceled:
            raise
        except GeneratorError as exc:
            log(run, "warn", f"键控参考帧生成失败（第 {attempt} 次）：{exc}")
            continue
        subject, stats = matte.key_subject(result.image)
        if stats["key_coverage"] >= 0.35 and stats["subject_coverage"] >= 0.002:
            log(run, "layer", f"键控参考帧就绪（键色 {stats['key']}，"
                              f"背景覆盖 {stats['key_coverage']}）")
            return FrameRef(result.image, url=result.url)
        log(run, "warn", f"键控参考帧背景覆盖不足：{stats}")
    return None


def _build_layer(run: dict[str, Any], reference: Image.Image, reference_ref: FrameRef,
                 generator, settings: dict[str, Any], total: int,
                 on_event: EventFn | None) -> dict[str, Any] | None:
    """准备固定背景板 + 键控参考帧；不满足条件返回 None（走整幅重绘的老路）。"""
    if getattr(generator, "name", "") != "main":
        return None
    if _background_mode(settings, run.get("idea") or "") != "fixed":
        return None
    if hasattr(generator, "wait_ready"):
        generator.wait_ready(90)
    plate = matte.background_plate(reference)
    plate.save(store.run_dir(run["id"]) / "background.png", format="PNG")
    key_ref = _key_reference(run, reference_ref, generator, total, on_event)
    if key_ref is None:
        run["layers"] = {"mode": "plain", "reason": "键控参考帧生成失败，已回退整幅重绘"}
        log(run, "warn", "键控参考帧不可用，本次退回整幅重绘")
        return None
    _, stats = matte.key_subject(key_ref.image)
    run["layers"] = {
        "mode": "fixed",
        "plate": "background.png",
        "key": stats["key"],
        "key_coverage": stats["key_coverage"],
        "subject_coverage": stats["subject_coverage"],
    }
    log(run, "layer", "固定背景模式：主体层抠图后合成到 background.png")
    if on_event:
        on_event({"stage": "layer_ready", "mode": "fixed", "key": stats["key"]})
    return {
        "plate": plate,
        "key_color": tuple(stats["key"]),
        "previous_key": key_ref,
        # 帧生成时 <image2> 必须也用键控参考帧：原始参考图的米白背景会把
        # 模型"拽回"整幅重绘，这是实测里 key_lost 的直接原因。
        "reference": key_ref,
    }


def _stored_key(run: dict[str, Any], index: int, generator=None) -> FrameRef | None:
    """取某帧已保存的键控原图（品红底），用于断点续跑。"""
    if index <= 0:
        return None
    for frame in run.get("frames") or []:
        if int(frame["index"]) == index and frame.get("keyFile"):
            path = store.run_dir(run["id"]) / frame["keyFile"]
            if path.exists():
                image = Image.open(path)
                image.load()
                # 续跑要继续调 /api/edit，必须有可访问的 URL，重新上传一次。
                return generator.prepare(image) if generator else FrameRef(image)
    return None


def _is_return_beat(frame: dict[str, Any]) -> bool:
    """末帧是否是"回到种子/植物消失"的收尾节拍。"""
    text = f"{frame.get('beat') or ''}{frame.get('prompt') or ''}"
    return any(word in text for word in ("归种", "消失", "只剩", "回到", "轮回"))



def _clean_background(run: dict[str, Any], index: int, total: int,
                      image: Image.Image, url: str | None, reference: FrameRef,
                      generator, on_event: EventFn | None) -> GeneratedImage | None:
    """成长叙事专用的背景净化：成功返回净化后的图，失败返回 None 保留原图。"""
    if getattr(generator, "name", "") != "main":
        return None
    if on_event:
        on_event({"stage": "cleanup_start", "frame": index, "total": total})
    try:
        return generator.generate(
            FrameRef(image, url=url), reference, CLEAN_BACKGROUND_PROMPT,
            index, total, 99,
            on_progress=(lambda info: _on_job_progress(run, info, on_event)),
        )
    except GeneratorCanceled:
        raise
    except GeneratorError as exc:
        log(run, "warn", f"第 {index} 帧背景净化失败，保留原图：{exc}")
        return None


def _has_alpha(image: Image.Image) -> bool:
    if "A" not in image.convert("RGBA").getbands():
        return False
    alpha = image.convert("RGBA").getchannel("A")
    return alpha.getextrema()[0] < 250


def _prepare_reference(image: Image.Image, width: int, height: int) -> Image.Image:
    rgba = image.convert("RGBA") if _has_alpha(image) else image.convert("RGB")
    fitted = ImageOps.contain(rgba, (width, height), Image.Resampling.LANCZOS)
    if _has_alpha(rgba):
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    else:
        canvas = Image.new("RGB", (width, height), (255, 255, 255))
    canvas.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
    return canvas


def log(run: dict[str, Any], stage: str, message: str) -> None:
    run.setdefault("log", []).append({
        "t": time.strftime("%H:%M:%S", time.localtime()),
        "stage": stage,
        "message": message,
    })
    if len(run["log"]) > 500:
        del run["log"][:-500]


def create_run(reference: Image.Image, idea: str, settings: dict[str, Any] | None = None,
               *, name: str = "") -> dict[str, Any]:
    idea = str(idea or "").strip()
    if not idea:
        raise ValueError("想法不能为空")
    normalized = normalize_settings(settings)
    prepared = _prepare_reference(reference, normalized["width"], normalized["height"])
    run_id = store.new_run_id()
    run: dict[str, Any] = {
        "version": 1,
        "id": run_id,
        "name": name or idea[:24],
        "status": "draft",
        "idea": idea,
        "createdAt": store.now_text(),
        "updatedAt": store.now_text(),
        "reference": {
            "file": "reference.png",
            "url": "",
            "width": prepared.width,
            "height": prepared.height,
            "has_alpha": _has_alpha(prepared),
        },
        "settings": normalized,
        "plan": None,
        "frames": [],
        "progress": {"stage": "draft", "frame": 0, "attempt": 0,
                     "done": 0, "total": normalized["frames"], "percent": 0,
                     "message": "已创建"},
        "animation": {"fps": config.DEFAULT_FPS, "projectId": None,
                      "gif": None, "apng": None},
        "log": [],
    }
    target = store.run_dir(run_id)
    target.mkdir(parents=True, exist_ok=True)
    prepared.save(target / "reference.png", format="PNG")
    log(run, "create", f"参考图 {prepared.width}×{prepared.height}，计划 {normalized['frames']} 帧")
    store.save_run(run)
    return run


def _fit_square(image: Image.Image, size: int) -> Image.Image:
    rgba = image.convert("RGBA")
    fitted = ImageOps.contain(rgba, (size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def _fit_canvas(image: Image.Image, width: int, height: int) -> Image.Image:
    """宫格/照片统一到画布：等比缩放后居中，保留透明通道，不裁切内容。"""
    rgba = image.convert("RGBA")
    fitted = ImageOps.contain(rgba, (width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.paste(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
    return canvas


def _holds_seed(settings: dict[str, Any], count: int) -> list[int]:
    """导入轨道时先按默认停格数铺满，后续由编排板逐帧覆盖。"""
    hold = int((settings.get("motion") or {}).get("hold") or config.DEFAULT_HOLD)
    return [max(1, min(6, hold))] * max(0, count)


def default_edit_prompt(style: str = "") -> str:
    """流水线没有单独写提示词时的兜底：只统一质感，不改内容。"""
    hint = motion_lib.style_hint(style) or "细腻的定格动画质感，柔和棚拍光，实物微距感；"
    return ("以<image1>为画布，保持原图的构图、主体、配色与画面内容完全不变；"
            f"只统一为{hint}细节清晰，不要新增或删除任何物体")


def _effective_prompt(frame: dict[str, Any], settings: dict[str, Any]) -> str:
    """过滤导入时自动生成的占位提示词，避免把「第 N 帧」当成编辑指令。"""
    index = int(frame.get("index") or 0)
    text = str(frame.get("prompt") or "").strip()
    if not text or text == f"第 {index} 帧" or text.startswith("宫格第 "):
        return default_edit_prompt(settings.get("style"))
    return text


def create_sheet_run(sheet: Image.Image, settings: dict[str, Any] | None = None,
                     *, rows: int = 4, columns: int = 4, row_gap: int = 0,
                     column_gap: int = 0, order: str = "row-major",
                     trim: str = "union") -> dict[str, Any]:
    """可选来源：一张宫格总表 → 按格切分 → 直接进入审核/导出。

    复用 animation_kit 的切分规则（整数坐标、alpha 原样、可选并集裁边），
    只是把结果接进 still_loop 的帧清单，后面照走审核与 GIF 导出。
    """
    from animation_kit.core.sheet import split_sheet

    rows = max(1, min(16, int(rows)))
    columns = max(1, min(16, int(columns)))
    if rows * columns < 2:
        raise ValueError("宫格至少要有 2 格")
    normalized = normalize_settings(settings)
    normalized["frames"] = rows * columns
    normalized["preserve"] = []
    normalized["timeline"]["holds"] = _holds_seed(normalized, rows * columns)
    split = split_sheet(
        sheet, rows=rows, columns=columns,
        row_gap=max(0, int(row_gap)), column_gap=max(0, int(column_gap)),
        order=order if order in ("row-major", "serpentine", "column-major") else "row-major",
        trim=trim if trim in ("none", "union", "each") else "union",
        fit="pad", target_size=None,
    )

    run_id = store.new_run_id()
    title = f"宫格切分 {rows}×{columns}"
    run: dict[str, Any] = {
        "version": 1,
        "id": run_id,
        "name": title,
        "source": "sheet",
        "status": "review",
        "idea": title,
        "createdAt": store.now_text(),
        "updatedAt": store.now_text(),
        "reference": {
            "file": "reference.png",
            "url": "",
            "width": sheet.width,
            "height": sheet.height,
            "has_alpha": _has_alpha(sheet),
        },
        "settings": normalized,
        "plan": {
            "source": "sheet",
            "title": title,
            "anchors": [],
            "model": None,
            "vision": True,
            "elapsed_ms": 0,
            "warnings": list(split.warnings),
            "grid": split.meta,
            "frames": [],
        },
        "frames": [],
        "progress": {"stage": "review", "frame": len(split.frames), "attempt": 0,
                     "done": len(split.frames), "total": len(split.frames),
                     "percent": 100, "message": f"宫格切分完成（{len(split.frames)} 帧）"},
        "animation": {"fps": config.DEFAULT_FPS, "projectId": None,
                      "gif": None, "apng": None},
        "log": [],
    }
    target = store.run_dir(run_id)
    target.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGBA" if _has_alpha(sheet) else "RGB").save(target / "reference.png", format="PNG")

    for index, image in enumerate(split.frames, start=1):
        square = _fit_canvas(image, normalized["width"], normalized["height"])
        rel = store.save_frame_bytes(run, _image_bytes(square), f"f{index:02d}.png")
        prompt = f"宫格第 {index} 格"
        run["frames"].append({
            "index": index,
            "beat": f"第 {index} 格",
            "prompt": prompt,
            "expect": "",
            "min_change": 0.0,
            "max_change": 1.0,
            "status": "accepted",
            "attempts": [{
                "n": 1, "prompt": prompt, "verdict": "pass",
                "reasons": [], "messages": ["宫格切分导入，无需重新生成"],
                "warnings": [], "hint": "",
                "metrics": {"width": square.width, "height": square.height},
                "score": 1.0, "elapsedMs": 0, "jobId": "",
                "url": "", "file": rel, "quality": {}, "source": "sheet",
            }],
            "acceptedFile": rel,
            "acceptedUrl": "",
            "acceptedPrompt": prompt,
            "currentFile": rel,
            # 原图留作 AI 精修/重跑的输入；精修后 acceptedFile 会指向新文件。
            "sourceFile": rel,
            "originalFile": rel,
        })

    log(run, "sheet", f"{title} → {len(run['frames'])} 帧"
                      f"（顺序 {split.meta['order']}，裁边 {split.meta['trim']}）")
    for warning in split.warnings:
        log(run, "warn", warning)
    store.save_run(run)
    store.write_report(run)
    return run


def create_photo_run(images: list[Image.Image], settings: dict[str, Any] | None = None,
                     *, prompts: list[str] | None = None, name: str = "",
                     source: str = "photos") -> dict[str, Any]:
    """把用户上传/素材仓库多选的照片按顺序铺成一条定格轨道。

    照片本身即最终帧，不需要生成；后续可对单帧做 AI 精修、重排、删除与导出。
    """
    images = [image for image in (images or []) if image is not None]
    if not images:
        raise ValueError("至少需要 1 张照片")
    if len(images) > 48:
        raise ValueError("一次最多导入 48 张照片")
    normalized = normalize_settings(settings)
    count = len(images)
    width, height = normalized["width"], normalized["height"]
    normalized["frames"] = count
    normalized["timeline"]["holds"] = _holds_seed(normalized, count)
    prompts = [str(item).strip() for item in (prompts or [])]

    run_id = store.new_run_id()
    title = (name or "").strip() or f"照片轨道 {count} 帧"
    first = _prepare_reference(ImageOps.exif_transpose(images[0]), width, height)
    run: dict[str, Any] = {
        "version": 1,
        "id": run_id,
        "name": title,
        "source": source,
        "status": "review",
        "idea": title,
        "createdAt": store.now_text(),
        "updatedAt": store.now_text(),
        "reference": {
            "file": "reference.png",
            "url": "",
            "width": first.width,
            "height": first.height,
            "has_alpha": _has_alpha(first),
        },
        "settings": normalized,
        "plan": {
            "source": "photos" if source == "photos" else source,
            "title": title,
            "anchors": [],
            "model": None,
            "vision": False,
            "elapsed_ms": 0,
            "warnings": [],
            "frames": [],
        },
        "frames": [],
        "progress": {"stage": "review", "frame": count, "attempt": 0,
                     "done": count, "total": count, "percent": 100,
                     "message": f"已导入 {count} 张照片"},
        "animation": {"fps": config.DEFAULT_FPS, "projectId": None,
                      "gif": None, "apng": None},
        "pipeline": {"kind": "photos", "auto": False, "step": "imported"},
        "log": [],
    }
    target = store.run_dir(run_id)
    target.mkdir(parents=True, exist_ok=True)
    first.save(target / "reference.png", format="PNG")

    for index, image in enumerate(images, start=1):
        prepared = _prepare_reference(ImageOps.exif_transpose(image), width, height)
        rel = store.save_frame_bytes(run, _image_bytes(prepared), f"f{index:02d}.png")
        prompt = prompts[index - 1] if index - 1 < len(prompts) and prompts[index - 1] else ""
        run["frames"].append({
            "index": index,
            "beat": f"第 {index} 帧",
            "prompt": prompt,
            "expect": "",
            "min_change": 0.0,
            "max_change": 1.0,
            "status": "accepted",
            "attempts": [{
                "n": 1, "prompt": prompt, "verdict": "pass",
                "reasons": [], "messages": ["本地照片导入，无需重新生成"],
                "warnings": [], "hint": "",
                "metrics": {"width": prepared.width, "height": prepared.height},
                "score": 1.0, "elapsedMs": 0, "jobId": "",
                "url": "", "file": rel, "quality": {}, "source": "import",
            }],
            "acceptedFile": rel,
            "acceptedUrl": "",
            "acceptedPrompt": prompt,
            "currentFile": rel,
            "sourceFile": rel,
            "originalFile": rel,
        })

    log(run, "import", f"导入 {count} 张照片到轨道，画布 {width}×{height}")
    store.save_run(run)
    store.write_report(run)
    return run


def apply_prompts(run: dict[str, Any], prompts: Any) -> dict[str, Any]:
    """把提示词写回轨道。支持顺序数组或 {帧号: 提示词} 映射，不改写内容。"""
    frames = run.get("frames") or []
    if isinstance(prompts, dict):
        for frame in frames:
            value = prompts.get(str(frame.get("index"))) or prompts.get(str(int(frame.get("index") or 0)))
            if value is None:
                value = prompts.get(int(frame.get("index") or 0))
            if value is not None:
                text = str(value).strip()
                frame["prompt"] = text
                frame["beat"] = text[:18] or f"第 {frame.get('index')} 帧"
    elif isinstance(prompts, (list, tuple)):
        for index, frame in enumerate(frames):
            if index < len(prompts):
                text = str(prompts[index] or "").strip()
                if text:
                    frame["prompt"] = text
                    frame["beat"] = text[:18] or f"第 {frame.get('index')} 帧"
    store.save_run(run)
    return run


def restore_frame(run: dict[str, Any], index: int) -> dict[str, Any]:
    """把某一帧恢复成导入/切分时的原图（撤销 AI 精修）。"""
    target = next((frame for frame in run.get("frames") or []
                   if int(frame.get("index") or 0) == int(index)), None)
    if target is None:
        raise ValueError(f"帧不存在：{index}")
    source = target.get("sourceFile") or target.get("originalFile")
    if not source:
        raise ValueError("这一帧没有可恢复的原图")
    target["acceptedFile"] = source
    target["acceptedUrl"] = ""
    target["acceptedPrompt"] = ""
    target["currentFile"] = source
    target["status"] = "accepted"
    target["attempts"] = [item for item in (target.get("attempts") or [])
                          if item.get("source") in ("import", "sheet")]
    log(run, "restore", f"第 {index} 帧已恢复原图")
    store.save_run(run)
    return run


def plan_run(run: dict[str, Any], *, llm: str = "auto", model: str | None = None,
             timeout: float = 180.0) -> dict[str, Any]:
    if run.get("source") == "sheet":
        raise ValueError("宫格切分的 run 不需要再生成分镜")
    run["status"] = "planning"
    run["progress"] = {"stage": "planning", "frame": 0, "attempt": 0, "done": 0,
                       "total": run["settings"]["frames"], "percent": 0,
                       "message": "LLM 正在拆分镜"}
    store.save_run(run)
    reference = Image.open(store.run_dir(run["id"]) / "reference.png")
    reference.load()
    result = planner.plan(run["idea"], run["settings"], reference, llm=llm,
                          model=model, timeout=timeout)
    run["plan"] = result
    run["frames"] = [
        {
            "index": item["index"],
            "beat": item["beat"],
            "prompt": item["edit"],
            "expect": item.get("expect") or "",
            "min_change": item["min_change"],
            "max_change": item["max_change"],
            "status": "pending",
            "attempts": [],
            "acceptedFile": "",
            "currentFile": "",
            "acceptedPrompt": "",
        }
        for item in result["frames"]
    ]
    run["status"] = "planned"
    run["progress"] = {"stage": "planned", "frame": 0, "attempt": 0, "done": 0,
                       "total": len(run["frames"]), "percent": 0,
                       "message": f"分镜完成（{result.get('source')}，{len(run['frames'])} 帧）"}
    log(run, "plan", f"分镜完成：{result.get('source')}，{len(run['frames'])} 帧，"
                     f"{result.get('elapsed_ms', 0)}ms")
    store.save_run(run)
    return run


def use_prompts(run: dict[str, Any], prompts: list[str]) -> dict[str, Any]:
    """手写提示词直接成片：不调用 LLM，不改写任何一条提示词。"""
    if run.get("source") == "sheet":
        raise ValueError("宫格切分的 run 不需要提示词")
    items = [str(item).strip() for item in (prompts or [])]
    items = [item for item in items if item]
    if len(items) < 2:
        raise ValueError("至少需要 2 条提示词")
    items = items[:48]
    run["settings"]["frames"] = len(items)
    run["plan"] = {
        "source": "manual",
        "title": (run.get("idea") or "手写分镜")[:24],
        "anchors": [],
        "model": None,
        "vision": False,
        "elapsed_ms": 0,
        "warnings": [],
        "frames": [],
    }
    run["frames"] = [
        {
            "index": index + 1,
            "beat": f"第 {index + 1} 帧",
            "prompt": prompt,
            "expect": "",
            "min_change": 0.0,
            "max_change": 1.0,
            "status": "pending",
            "attempts": [],
            "acceptedFile": "",
            "currentFile": "",
            "acceptedPrompt": "",
        }
        for index, prompt in enumerate(items)
    ]
    run["status"] = "planned"
    run["progress"] = {"stage": "planned", "frame": 0, "attempt": 0, "done": 0,
                       "total": len(items), "percent": 0,
                       "message": f"手写分镜 {len(items)} 帧"}
    log(run, "plan", f"使用手写提示词 {len(items)} 条，未调用 LLM")
    store.save_run(run)
    return run


def _image_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _frame_ref(run: dict[str, Any], index: int) -> FrameRef | None:
    """取第 index 帧（1-based）的已接受图；index=0 表示参考图。"""
    path = store.run_dir(run["id"])
    if index <= 0:
        image = Image.open(path / "reference.png")
        image.load()
        return FrameRef(image, url=run["reference"].get("url") or None)
    for frame in run.get("frames") or []:
        if int(frame["index"]) == index and frame.get("acceptedFile"):
            image = Image.open(path / frame["acceptedFile"])
            image.load()
            return FrameRef(image, url=frame.get("acceptedUrl") or None)
    return None


_OVERRIDE_KEYS = ("steps", "cfg", "denoise", "seed")


def _merge_overrides(settings: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    """把单帧手动参数合进本次调用的设置，只接受白名单字段。"""
    if not overrides:
        return settings
    merged = dict(settings)
    touched: set[str] = set()
    for key in _OVERRIDE_KEYS:
        value = overrides.get(key)
        if value is None or value == "":
            continue
        try:
            merged[key] = int(value) if key in ("steps", "seed") else float(value)
            touched.add(key)
        except (TypeError, ValueError):
            continue
    if int(merged.get("steps") or 0) < 1:
        merged["steps"] = settings["steps"]
    if float(merged.get("denoise") or 0) <= 0:
        merged["denoise"] = settings["denoise"]
    # 主项目的 Turbo 档位会强制 8 步 / CFG 1.0；用户显式改步数或 CFG 时关掉 Turbo，
    # 否则这两个手动参数会被预设静默覆盖。
    if touched & {"steps", "cfg"}:
        merged["turbo"] = False
    return merged


def _frame_image(run: dict[str, Any], index: int):
    """取某帧当前最可用的图：已通过结果 > 当前结果 > 原图，和轨道上看到的一致。"""
    base = store.run_dir(run["id"])
    for frame in run.get("frames") or []:
        if int(frame["index"]) != int(index):
            continue
        for key in ("acceptedFile", "currentFile", "sourceFile", "originalFile"):
            rel = frame.get(key)
            if rel and (base / rel).exists():
                image = Image.open(base / rel)
                image.load()
                return image
        break
    raise ValueError(f"第 {index} 帧还没有可用图片")


def _previous_frame_image(run: dict[str, Any], index: int):
    """取上一帧当前最可用的图，作为本次精修的额外参考。"""
    if index <= 1:
        raise ValueError("第 1 帧没有上一帧")
    return _frame_image(run, index - 1)


def _run_frame(run: dict[str, Any], frame: dict[str, Any], previous: FrameRef,
               reference: FrameRef, generator, settings: dict[str, Any],
               first_image: Image.Image | None, on_event: EventFn | None,
               should_cancel: Callable[[], bool] | None,
               layer: dict[str, Any] | None = None) -> tuple[FrameRef | None, bool]:
    total = len(run["frames"])
    index = int(frame["index"])
    max_retries = int(settings["max_retries"])
    growth = planner.is_growth(run.get("idea") or "")
    seasonal = planner.is_seasonal(run.get("idea") or "") and not growth
    key_mode = layer is not None
    correction = ""
    frame["status"] = "running"
    frame["attempts"] = []
    run["status"] = "running"
    run["progress"] = {"stage": "running", "frame": index, "attempt": 1,
                       "done": sum(1 for f in run["frames"] if f["status"] == "accepted"),
                       "total": total, "percent": 0,
                       "message": f"第 {index}/{total} 帧开始"}
    store.save_run(run)
    if on_event:
        on_event({"stage": "frame_start", "frame": index, "total": total})

    for attempt in range(1, max_retries + 1):
        if should_cancel and should_cancel():
            raise GeneratorCanceled("用户取消")
        prompt = frame["prompt"]
        if growth:
            prompt = planner.growth_guard(prompt)
        if key_mode:
            # 分镜是按"米白背景"写的，键控模式下统一改写成"品红纯色背景"。
            prompt = matte.to_key_prompt(prompt)
        if correction and attempt > 1:
            prompt = f"{prompt}\n\n【纠错】{correction}"
        frame["status"] = "running"
        run["progress"]["attempt"] = attempt
        run["progress"]["message"] = f"第 {index}/{total} 帧 · 第 {attempt}/{max_retries} 次尝试"
        store.save_run(run)
        if on_event:
            on_event({"stage": "attempt_start", "frame": index, "attempt": attempt,
                      "total": total, "prompt": prompt})

        started = time.time()
        gen_reference = (layer or {}).get("reference") or reference
        if key_mode and index == total and _is_return_beat(frame):
            # 末帧"变回种子"是一次极大的语义跳跃，模型实测只肯收掉树干、留下树冠。
            # 图层模式直接用键控参考帧复位：零成本，且与第 1 帧严丝合缝地闭环。
            result = GeneratedImage(
                image=layer["reference"].image, job_id="layer-reset", elapsed_ms=0,
                meta={"generator": "layer-reset"})
            frame["loopReset"] = True
            log(run, "layer", f"第 {index} 帧复用键控参考帧回到初始种子（不调用模型）")
        else:
            try:
                result = generator.generate(
                    (layer or {}).get("previous_key") or previous, gen_reference,
                    prompt, index, total, attempt,
                    on_progress=(lambda info: _on_job_progress(run, info, on_event)),
                )
            except GeneratorCanceled:
                raise
            except GeneratorError as exc:
                log(run, "error", f"第 {index} 帧第 {attempt} 次生成失败：{exc}")
                frame["attempts"].append({
                    "n": attempt, "prompt": prompt, "verdict": "error",
                    "reasons": ["generator_error"], "messages": [str(exc)],
                    "hint": str(exc), "metrics": {}, "score": 0,
                    "elapsedMs": int((time.time() - started) * 1000), "jobId": "",
                    "file": "", "url": "",
                })
                correction = "上一次生成失败，请重试同一个动作"
                if hasattr(generator, "wait_ready"):
                    generator.wait_ready(60)
                continue

        subject_image: Image.Image | None = None
        matte_stats: dict[str, Any] = {}
        composed = result.image
        if key_mode:
            subject_image, composed, matte_stats = matte.extract(
                result.image, layer["plate"], layer.get("key_color"))
            if (matte_stats["key_coverage"] < 0.15
                    or matte_stats["subject_coverage"] < 0.004):
                # 模型没守住品红底（画了渐变/场景）或主体丢了，抠图不可信，重试。
                log(run, "warn", f"第 {index} 帧键控异常：{matte_stats}")
                frame["attempts"].append({
                    "n": attempt, "prompt": prompt, "verdict": "fail",
                    "reasons": ["key_lost"], "messages": [matte.CORRECTIONS["key_lost"]],
                    "warnings": [], "hint": matte.CORRECTIONS["key_lost"],
                    "metrics": {"key_coverage": matte_stats["key_coverage"],
                                "subject_coverage": matte_stats["subject_coverage"]},
                    "score": 0, "matte": matte_stats,
                    "elapsedMs": int((time.time() - started) * 1000),
                    "jobId": result.job_id, "url": result.url or "",
                    "file": "", "quality": result.quality,
                })
                correction = matte.CORRECTIONS["key_lost"]
                frame["status"] = "retrying"
                store.save_run(run)
                continue

        file_rel = store.save_frame_bytes(
            run, _image_bytes(composed), f"f{index:02d}_a{attempt}.png")
        frame["currentFile"] = file_rel
        is_last = index == total
        # 成长/变形故事本来就要从褐色种子长到绿色树冠，再拿参考图的配色当锚点判偏色
        # 会把正常叙事判死；四季叙事整幅换色同理。这类叙事只和上一帧比，不跟参考图比全局色。
        anchor = None if (growth or seasonal) else reference.image
        if growth:
            check_settings = planner.growth_thresholds(settings)
        elif seasonal:
            check_settings = planner.transform_thresholds(settings)
        else:
            check_settings = settings
        check = checker.check(previous.image, composed, frame, check_settings,
                              is_last=is_last, first=first_image,
                              anchor=anchor, quality=result.quality)
        if frame.get("loopReset"):
            # 这是刻意做的"回到起点"，不是模型跑偏，指标不参与判定。
            check["verdict"] = "pass"
            check["reasons"] = []
            check["hint"] = ""
        attempt_record = {
            "n": attempt,
            "prompt": prompt,
            "verdict": check["verdict"],
            "reasons": check["reasons"],
            "messages": check["messages"],
            "warnings": check.get("warnings") or [],
            "hint": check["hint"],
            "metrics": check["metrics"],
            "score": check["score"],
            "band": check["band"],
            "jobId": result.job_id,
            "url": result.url or "",
            "file": file_rel,
            "elapsedMs": int(result.elapsed_ms or (time.time() - started) * 1000),
            "quality": result.quality,
            "align": result.align,
            "matte": matte_stats,
        }
        frame["attempts"].append(attempt_record)
        log(run, "check",
            f"第 {index} 帧第 {attempt} 次：{check['verdict']} "
            f"(改动 {check['metrics'].get('changed_ratio')}, "
            f"SSIM {check['metrics'].get('ssim')}, MAE {check['metrics'].get('mae')})"
            + (f"；{check['hint']}" if check["hint"] else ""))
        store.save_run(run)
        if on_event:
            on_event({"stage": "attempt_result", "frame": index, "attempt": attempt,
                      "verdict": check["verdict"], "metrics": check["metrics"],
                      "reasons": check["reasons"], "file": file_rel})

        if check["verdict"] == "pass":
            accepted_image, accepted_url = composed, result.url or ""
            if key_mode:
                # 键控模式下背景本来就是固定板，不需要再做"清理背景"的编辑。
                frame["keyFile"] = store.save_frame_bytes(
                    run, _image_bytes(result.image), f"f{index:02d}_key.png")
                if subject_image is not None:
                    frame["subjectFile"] = store.save_frame_bytes(
                        run, _image_bytes(subject_image), f"f{index:02d}_subject.png")
                frame["matte"] = matte_stats
                layer["previous_key"] = FrameRef(result.image, url=result.url)
                log(run, "layer", f"第 {index} 帧主体层 {matte_stats['subject_coverage']}"
                                  f"，键色覆盖 {matte_stats['key_coverage']}")
            elif growth and getattr(generator, "name", "") == "main":
                cleaned = _clean_background(run, index, total, accepted_image,
                                            accepted_url, reference, generator, on_event)
                if cleaned is not None:
                    accepted_image = cleaned.image
                    accepted_url = cleaned.url or accepted_url
                    frame["cleanup"] = "ok"
                    log(run, "cleanup", f"第 {index} 帧背景已净化")
                else:
                    frame["cleanup"] = "skipped"
            accepted_bytes = _image_bytes(accepted_image)
            accepted_rel = store.save_frame_bytes(run, accepted_bytes, f"f{index:02d}.png")
            frame["acceptedFile"] = accepted_rel
            frame["acceptedUrl"] = accepted_url
            frame["acceptedPrompt"] = prompt
            frame["status"] = "accepted"
            run["progress"]["done"] = sum(
                1 for item in run["frames"] if item["status"] == "accepted")
            run["progress"]["percent"] = int(
                run["progress"]["done"] * 100 / max(1, total))
            run["progress"]["message"] = f"第 {index}/{total} 帧通过"
            log(run, "accept", f"第 {index} 帧通过（第 {attempt} 次）")
            store.save_run(run)
            if on_event:
                on_event({"stage": "frame_accepted", "frame": index, "attempt": attempt,
                          "file": accepted_rel, "done": run["progress"]["done"],
                          "total": total})
            return FrameRef(accepted_image, url=accepted_url), True

        correction = check["hint"] or "请重新生成这一帧"
        frame["status"] = "retrying"

    best = max(frame["attempts"], key=lambda item: float(item.get("score") or 0))
    frame["currentFile"] = best.get("file") or frame.get("currentFile") or ""
    frame["status"] = "blocked"
    log(run, "blocked", f"第 {index} 帧 {max_retries} 次仍未通过，已暂停等待人工处理")
    if on_event:
        on_event({"stage": "frame_blocked", "frame": index,
                  "attempts": len(frame["attempts"]),
                  "bestFile": frame["currentFile"]})
    return None, False


def _on_job_progress(run: dict[str, Any], info: dict[str, Any],
                     on_event: EventFn | None) -> None:
    if on_event:
        on_event({"stage": "job_progress", **info})
    message = str(info.get("message") or "")
    if message:
        run["progress"]["job"] = message


def start_run(run: dict[str, Any], generator, *, on_event: EventFn | None = None,
              should_cancel: Callable[[], bool] | None = None) -> dict[str, Any]:
    if run.get("source") in ("sheet", "photos", "pipeline"):
        # 导入/切分/流水线轨道不走接力生成；需要编辑请调用 AI 精修接口。
        every = all(frame.get("status") == "accepted" for frame in run.get("frames") or [])
        run["status"] = "review" if every else "blocked"
        run["progress"] = {"stage": run["status"], "frame": len(run.get("frames") or []),
                           "attempt": 0,
                           "done": sum(1 for frame in run.get("frames") or []
                                       if frame.get("status") == "accepted"),
                           "total": len(run.get("frames") or []),
                           "percent": 100 if every else 0,
                           "message": "导入轨道无需接力生成" if every else "还有帧待处理"}
        store.save_run(run)
        return run
    if not run.get("frames"):
        plan_run(run)
    settings = normalize_settings(run["settings"])
    reference_image = Image.open(store.run_dir(run["id"]) / "reference.png")
    reference_image.load()
    try:
        reference = generator.prepare(reference_image)
        if reference.url:
            run["reference"]["url"] = reference.url
    except Exception as exc:  # noqa: BLE001
        run["status"] = "failed"
        run["error"] = f"准备参考图失败：{exc}"
        log(run, "error", run["error"])
        store.save_run(run)
        return run

    previous = reference
    first_image: Image.Image | None = None
    layer = _build_layer(run, reference_image, reference, generator, settings,
                         len(run["frames"]), on_event)
    run["status"] = "running"
    log(run, "start", f"开始接力，共 {len(run['frames'])} 帧，生成器 {getattr(generator, 'name', '?')}"
                      + ("，固定背景模式" if layer else ""))
    store.save_run(run)

    try:
        for frame in run["frames"]:
            if frame["status"] == "accepted" and frame.get("acceptedFile"):
                current = _frame_ref(run, int(frame["index"]))
                if current is not None:
                    previous = current
                    if first_image is None:
                        first_image = current.image
                    if layer is not None:
                        # 续跑时接着用上一帧的品红底原图，否则背景会断链。
                        layer["previous_key"] = _stored_key(run, int(frame["index"]), generator)
                continue
            next_ref, accepted = _run_frame(
                run, frame, reference if settings.get("relay") == "independent" else previous,
                reference, generator, settings,
                first_image, on_event, should_cancel, layer)
            if not accepted:
                run["status"] = "blocked"
                run["progress"]["stage"] = "blocked"
                run["progress"]["message"] = f"第 {frame['index']} 帧自检未通过，等待人工处理"
                store.save_run(run)
                store.write_report(run)
                return run
            if first_image is None and next_ref is not None:
                first_image = next_ref.image
            if next_ref is not None:
                previous = next_ref
    except GeneratorCanceled:
        run["status"] = "canceled"
        run["progress"]["message"] = "已取消"
        log(run, "cancel", "用户取消")
        store.save_run(run)
        store.write_report(run)
        return run
    except Exception as exc:  # noqa: BLE001 - 落盘后上报
        run["status"] = "failed"
        run["error"] = f"{type(exc).__name__}: {exc}"
        log(run, "error", run["error"])
        store.save_run(run)
        store.write_report(run)
        return run

    run["status"] = "review"
    run["progress"] = {"stage": "review",
                       "frame": len(run["frames"]), "attempt": 0,
                       "done": len(run["frames"]), "total": len(run["frames"]),
                       "percent": 100, "message": "全部帧通过，等待确认"}
    log(run, "review", "全部帧通过，等待人工确认")
    store.save_run(run)
    store.write_report(run)
    store.write_replay(run)
    if on_event:
        on_event({"stage": "run_review", "done": len(run["frames"]),
                  "total": len(run["frames"])})
    return run


def approve(run: dict[str, Any]) -> dict[str, Any]:
    missing = [frame["index"] for frame in run.get("frames") or []
               if frame.get("status") != "accepted" or not frame.get("acceptedFile")]
    if missing:
        raise ValueError(f"还有未通过的帧：{missing}")
    run["status"] = "approved"
    log(run, "approve", "用户确认全部帧")
    store.save_run(run)
    return run


def _encode_local(images: list[Image.Image], durations: list[int], fmt: str,
                  target: Path, dither: bool) -> str:
    """进程内编码（默认路径）：GIF 复用 animation_kit 的库，其余用 Pillow。"""
    if fmt == "gif":
        try:
            from animation_kit.core.encode import export_gif
            export_gif(images, durations, target, {
                "transparent": True, "colors": 256, "dither": bool(dither),
                "loop": 0, "optimize": False, "background": "#ffffff",
            })
            return "animation_kit"
        except Exception:  # noqa: BLE001 - animation_kit 不在时退回 Pillow
            images[0].save(target, format="GIF", save_all=True,
                           append_images=images[1:], duration=durations, loop=0,
                           disposal=2)
            return "pillow"
    if fmt == "apng":
        images[0].save(target, format="PNG", save_all=True,
                       append_images=images[1:], duration=durations, loop=0)
        return "pillow"
    images[0].save(target, format="WEBP", save_all=True,
                   append_images=images[1:], duration=durations, loop=0,
                   quality=92, lossless=True, method=4)
    return "pillow"


def _holds_for(settings: dict[str, Any], count: int, fallback: int) -> list[int]:
    """把编排板给的停格数补齐/截断到帧数。"""
    holds = list(settings["timeline"]["holds"])[:count]
    holds += [fallback] * (count - len(holds))
    return holds


def export_animation(run: dict[str, Any], *, fps: int | None = None,
                     fmt: str | None = None,
                     align: bool | None = None,
                     color_match: bool | None = None,
                     dither: bool | None = None,
                     motion: dict[str, Any] | None = None) -> dict[str, Any]:
    frames = run.get("frames") or []
    missing = [frame["index"] for frame in frames if not frame.get("acceptedFile")]
    if missing:
        raise ValueError(f"还有未通过的帧：{missing}")
    merged = dict(run.get("settings") or {})
    if motion:
        merged["motion"] = {**(merged.get("motion") or {}), **motion}
    if fps:
        timeline = merged.get("timeline")
        timeline = dict(timeline) if isinstance(timeline, dict) else {}
        timeline["fps"] = int(fps)
        merged["timeline"] = timeline
    settings = normalize_settings(merged)
    run["settings"] = settings
    export_cfg = settings["export"]
    fmt = str(fmt or export_cfg["format"] or "gif").lower()
    if fmt not in config.EXPORT_FORMATS:
        fmt = "gif"
    is_video = fmt in config.VIDEO_FORMATS
    align = export_cfg["align"] if align is None else bool(align)
    color_match = export_cfg["color_match"] if color_match is None else bool(color_match)
    dither = export_cfg["dither"] if dither is None else bool(dither)
    motion_cfg = settings["motion"]
    preset = motion_cfg["preset"]
    smooth_fps = int(settings["timeline"]["fps"])
    stop_fps = int(motion_cfg["fps"])
    holds = _holds_for(settings, len(frames), motion_cfg["hold"])

    base = store.run_dir(run["id"])
    images = []
    for frame in frames:
        image = Image.open(base / frame["acceptedFile"])
        image.load()
        images.append(image.convert("RGBA"))

    ext = {"gif": "gif", "apng": "png", "webp": "webp", "mp4": "mp4", "webm": "webm"}[fmt]
    label = {"gif": "GIF", "apng": "APNG", "webp": "WebP",
             "mp4": "MP4", "webm": "WebM"}[fmt]

    plans: list[tuple[str, list[Image.Image], int]] = []
    if preset in ("both", "smooth"):
        plans.append(("smooth", motion_lib.expand_holds(images, [1] * len(images)), smooth_fps))
    if preset in ("both", "stopmotion"):
        plans.append(("stopmotion", motion_lib.stopmotion_frames(
            images, holds,
            jitter=motion_cfg["jitter"], grain=motion_cfg["grain"],
            vignette=motion_cfg["vignette"], color_boil=motion_cfg["color_boil"],
            seed=int(settings.get("seed") or 20261107),
        ), stop_fps))

    stabilize: dict[str, Any] = {
        "requested": bool(align or color_match),
        "ok": False, "error": "", "pixel_exact": None,
        "align": None, "color": None, "warnings": [],
    }
    if stabilize["requested"] and is_video:
        stabilize["error"] = "视频输出不支持 8710 稳定化，已跳过"
        log(run, "export", stabilize["error"])

    variants: list[dict[str, Any]] = []
    for key, frameset, rate in plans:
        duration = max(20, int(round(1000 / max(1, rate))))
        durations = [duration] * len(frameset)
        name = f"anim.{ext}" if len(plans) == 1 else f"anim_{key}.{ext}"
        target = base / name
        encoder = ""
        if is_video:
            encoder = motion_lib.encode_video(frameset, target, rate, fmt)
        elif stabilize["requested"] and key == "smooth" and not stabilize["ok"]:
            try:
                result = anim_client.stabilize_and_export(
                    images, fps=rate, fmt=fmt, align=align, color_match=color_match,
                    dither=dither, name=f"still_loop {run['id']}",
                )
                target.write_bytes(result["blob"])
                stabilize.update({
                    "ok": True,
                    "pixel_exact": result.get("pixel_exact"),
                    "resampled_ids": result.get("resampled_ids") or [],
                    "warnings": result.get("warnings") or [],
                    "align": result.get("align"),
                    "color": result.get("color"),
                    "project_id": result.get("project_id"),
                })
                encoder = "animation_kit(8710)"
            except (anim_client.AnimServiceUnavailable, anim_client.AnimExportFailed) as exc:
                stabilize["error"] = str(exc)
                log(run, "export", f"稳定化不可用，回退本地导出：{exc}")
        if not encoder:
            encoder = _encode_local(frameset, durations, fmt, target, dither)
        info: dict[str, Any] = {
            "key": key,
            "file": name,
            "format": fmt,
            "encoder": encoder,
            "fps": rate,
            "frames": len(frameset),
            "sourceFrames": len(images),
            "durationMs": duration * len(frameset),
            "holds": holds if key == "stopmotion" else [1] * len(images),
        }
        probe = motion_lib.probe_video(target) if is_video else {}
        if probe:
            info["probe"] = probe
        variants.append(info)

    primary = variants[-1]
    animation = dict(run.get("animation") or {})
    animation.update({
        "file": primary["file"],
        "format": fmt,
        "encoder": primary["encoder"],
        "fps": primary["fps"],
        "frames": primary["frames"],
        "sourceFrames": len(images),
        "durationMs": primary["durationMs"],
        "exportedAt": store.now_text(),
        "stabilize": stabilize,
        "motion": {"preset": preset, "holds": holds, "stopmotion": motion_cfg},
        "variants": variants,
    })
    for legacy in ("gif", "apng"):
        animation.pop(legacy, None)
    if fmt == "gif":
        animation["gif"] = primary["file"]
    if fmt == "apng":
        animation["apng"] = primary["file"]
    run["animation"] = animation
    run["status"] = "done"
    total_seconds = round(sum(item["durationMs"] for item in variants) / 1000, 2)
    run["progress"] = {"stage": "done", "frame": len(images), "attempt": 0,
                       "done": len(images), "total": len(images), "percent": 100,
                       "message": f"已导出 {label}（{len(variants)} 个版本 · {total_seconds}s）"}
    extra = ""
    if stabilize["requested"]:
        extra = "，稳定化成功" if stabilize["ok"] else "，稳定化已回退"
    detail = " / ".join(f"{item['key']}={item['file']}({item['frames']}格@{item['fps']}fps)"
                        for item in variants)
    log(run, "export", f"导出 {label}：{detail}{extra}")
    store.save_run(run)
    store.write_report(run)
    store.write_replay(run)
    return run


def _edit_single_frame(run: dict[str, Any], frame: dict[str, Any], generator,
                       prompt: str, settings: dict[str, Any], *,
                       canvas_image: Image.Image | None = None,
                       extra_images: list[Image.Image] | None = None,
                       mode: str = "source",
                       on_event: EventFn | None = None,
                       should_cancel: Callable[[], bool] | None = None) -> bool:
    """对一帧做一次独立生成。

    ``mode="t2i"``：参考框为空，走文生图；
    其它模式：``canvas_image`` 是画布（None 表示取本帧原图），``extra_images``
    是用户额外拖进参考框的图，按顺序对应提示词里的 <image1>、<image2>…
    """
    index = int(frame["index"])
    total = len(run.get("frames") or [])
    text_only = mode == "t2i"
    if canvas_image is not None:
        source_image = canvas_image
    elif text_only:
        source_image = None
    else:
        base = store.run_dir(run["id"])
        source_rel = (frame.get("sourceFile") or frame.get("originalFile")
                      or frame.get("acceptedFile"))
        if not source_rel:
            raise ValueError(f"第 {index} 帧缺少原图")
        source_path = base / source_rel
        if not source_path.exists():
            raise ValueError(f"第 {index} 帧原图丢失：{source_rel}")
        source_image = Image.open(source_path)
        source_image.load()
    # 把本次实际使用的提示词写回帧，界面能直接看到效果依据，单帧重跑也沿用。
    frame["prompt"] = prompt
    max_retries = int(settings.get("max_retries") or config.DEFAULT_MAX_RETRIES)
    frame["status"] = "running"
    run["status"] = "running"
    run["progress"] = {"stage": "pipeline", "frame": index, "attempt": 0,
                       "done": sum(1 for item in run["frames"]
                                   if item.get("status") == "accepted"),
                       "total": total, "percent": 0,
                       "message": f"AI 精修第 {index}/{total} 帧"}
    store.save_run(run)
    if on_event:
        on_event({"stage": "pipeline_frame_start", "frame": index, "total": total})

    for attempt in range(1, max_retries + 1):
        if should_cancel and should_cancel():
            raise GeneratorCanceled("用户取消")
        run["progress"]["attempt"] = attempt
        run["progress"]["message"] = f"AI 精修第 {index}/{total} 帧 · 第 {attempt}/{max_retries} 次"
        store.save_run(run)
        started = time.time()
        try:
            is_mock = getattr(generator, "name", "") == "mock"
            if text_only:
                # 参考框为空：文生图，不传任何图片。
                worker = (MockGenerator(Image.new("RGB", (512, 512), (247, 243, 236)),
                                        settings, fail_frames=()) if is_mock else generator)
                if hasattr(worker, "wait_ready"):
                    worker.wait_ready(60)
                result = worker.text_to_image(
                    prompt, index, total, attempt,
                    on_progress=(lambda info: _on_job_progress(run, info, on_event)))
            else:
                worker = (MockGenerator(source_image, settings, fail_frames=())
                          if is_mock else generator)
                if hasattr(worker, "wait_ready"):
                    worker.wait_ready(60)
                source_ref = worker.prepare(source_image)
                extras = [worker.prepare(image) for image in (extra_images or [])]
                result = worker.generate(
                    source_ref, FrameRef(source_image), prompt, index, total, attempt,
                    on_progress=(lambda info: _on_job_progress(run, info, on_event)),
                    extras=extras)
        except GeneratorCanceled:
            raise
        except Exception as exc:  # noqa: BLE001 - 主项目偶发断连，重试即可
            log(run, "error", f"第 {index} 帧 AI 精修失败（第 {attempt} 次）：{exc}")
            frame.setdefault("attempts", []).append({
                "n": attempt, "prompt": prompt, "verdict": "error",
                "reasons": ["generator_error"], "messages": [str(exc)],
                "warnings": [], "hint": str(exc), "metrics": {}, "score": 0,
                "elapsedMs": int((time.time() - started) * 1000), "jobId": "",
                "url": "", "file": "", "quality": {}, "source": "pipeline",
            })
            if hasattr(generator, "wait_ready"):
                generator.wait_ready(30)
            continue

        rel = store.save_frame_bytes(
            run, _image_bytes(result.image), f"f{index:02d}_ai{attempt}.png")
        frame.setdefault("attempts", []).append({
            "n": attempt, "prompt": prompt, "verdict": "pass",
            "reasons": [], "messages": ["AI 精修完成"],
            "warnings": [], "hint": "",
            "metrics": {"width": result.image.width, "height": result.image.height},
            "score": 1.0, "jobId": result.job_id or "",
            "url": result.url or "", "file": rel,
            "elapsedMs": int(result.elapsed_ms or (time.time() - started) * 1000),
            "quality": result.quality or {}, "align": result.align or {},
            "matte": {}, "source": "pipeline", "reference": mode,
        })
        frame["acceptedFile"] = rel
        frame["acceptedUrl"] = result.url or ""
        frame["acceptedPrompt"] = prompt
        frame["currentFile"] = rel
        frame["status"] = "accepted"
        run["progress"]["done"] = sum(1 for item in run["frames"]
                                      if item.get("status") == "accepted")
        run["progress"]["percent"] = int(100 * run["progress"]["done"] / max(1, total))
        log(run, "pipeline", f"第 {index} 帧 AI 精修完成（第 {attempt} 次）")
        store.save_run(run)
        if on_event:
            on_event({"stage": "pipeline_frame_done", "frame": index,
                      "file": rel, "attempt": attempt})
        return True

    frame["status"] = "blocked"
    log(run, "blocked", f"第 {index} 帧 AI 精修 {max_retries} 次仍未成功，等待人工处理")
    store.save_run(run)
    return False


def edit_frames(run: dict[str, Any], generator, *, prompts: Any = None,
                indexes: list[int] | None = None, on_event: EventFn | None = None,
                should_cancel: Callable[[], bool] | None = None) -> dict[str, Any]:
    """流水线第二步：对导入/切分出来的每一帧做独立 AI 精修。

    与接力生成不同，每帧都从自己的原图出发，互不依赖；因此可以单帧重跑、
    任意重排、随时恢复原图，适合“宫格切分 + 单图连续编辑”的实验性流程。
    """
    source = str(run.get("source") or "")
    if source not in ("photos", "sheet", "pipeline"):
        raise ValueError("只有照片/宫格/流水线轨道可以做 AI 精修")
    frames = run.get("frames") or []
    if not frames:
        raise ValueError("轨道里还没有帧")
    if isinstance(prompts, (list, tuple, dict)) and prompts:
        apply_prompts(run, prompts)
    settings = normalize_settings(run.get("settings"))
    wanted = {int(item) for item in indexes} if indexes else None
    run.setdefault("pipeline", {})
    run["pipeline"].update({"kind": run["pipeline"].get("kind") or "grid",
                            "running": True, "step": "editing",
                            "startedAt": store.now_text(),
                            "requested": len(wanted) if wanted else len(frames)})
    log(run, "pipeline", "开始 AI 精修：" + ("全部帧" if not wanted else f"{len(wanted)} 帧"))
    done = 0
    try:
        for frame in frames:
            index = int(frame["index"])
            if wanted and index not in wanted:
                continue
            prompt = _effective_prompt(frame, settings)
            ok = _edit_single_frame(run, frame, generator, prompt, settings,
                                    on_event=on_event, should_cancel=should_cancel)
            if not ok:
                run["status"] = "blocked"
                run["progress"].update({"stage": "blocked",
                                        "message": f"第 {index} 帧精修失败，等待人工处理"})
                run["pipeline"].update({"running": False, "step": "blocked"})
                store.save_run(run)
                store.write_report(run)
                return run
            done += 1
        run["status"] = "review"
        run["progress"] = {"stage": "review", "frame": len(frames), "attempt": 0,
                           "done": len(frames), "total": len(frames), "percent": 100,
                           "message": f"AI 精修完成（{done} 帧），等待确认"}
        run["pipeline"].update({"running": False, "step": "edited",
                                "editedAt": store.now_text(), "editedFrames": done})
        log(run, "pipeline", f"AI 精修完成：{done} 帧")
        store.save_run(run)
        store.write_report(run)
    except GeneratorCanceled:
        run["status"] = "canceled"
        run["progress"].update({"stage": "canceled", "message": "AI 精修已取消"})
        run["pipeline"].update({"running": False, "step": "canceled"})
        log(run, "cancel", "用户取消 AI 精修")
        store.save_run(run)
    except Exception as exc:  # noqa: BLE001 - 落盘后上报
        run["status"] = "failed"
        run["error"] = f"{type(exc).__name__}: {exc}"
        run["pipeline"].update({"running": False, "step": "failed"})
        log(run, "error", run["error"])
        store.save_run(run)
        store.write_report(run)
    return run


def retry_frame(run: dict[str, Any], index: int, generator, *,
                prompt: str | None = None, reference: str | None = None,
                images: list[int] | None = None,
                overrides: dict[str, Any] | None = None,
                on_event: EventFn | None = None,
                should_cancel: Callable[[], bool] | None = None) -> dict[str, Any]:
    """单帧重试；接力轨道会作废后续帧，导入/流水线轨道只重跑当前帧。

    images: 用户参考框里的帧号，按顺序提交；images[0] 是画布，空数组 = 文生图。
            None 表示走旧参数 reference（"source" / "previous"）。
    overrides: 本次调用的临时采样参数（steps / cfg / denoise / seed），不写回轨道设置
    """
    target = None
    for frame in run.get("frames") or []:
        if int(frame["index"]) == int(index):
            target = frame
            break
    if target is None:
        raise ValueError(f"帧不存在：{index}")
    if prompt is not None:
        target["prompt"] = str(prompt)

    if run.get("source") in ("photos", "sheet", "pipeline") or target.get("sourceFile"):
        if run.get("source") == "sheet" and not target.get("sourceFile"):
            raise ValueError("宫格切分没有可重试的生成步骤，请重新切分或直接导出")
        settings = normalize_settings(run.get("settings"))
        settings = _merge_overrides(settings, overrides)
        # 生成器在构造时就缓存了设置；单帧手动参数要同步进去，
        # 否则 steps / cfg / seed / denoise 不会进入 /api/edit。
        if overrides and hasattr(generator, "settings"):
            generator.settings = settings
        text = _effective_prompt(target, settings)
        canvas_image = None
        extra_images: list[Image.Image] = []
        mode = reference or "source"
        if images is not None:
            if images:
                canvas_image = _frame_image(run, images[0])
                extra_images = [_frame_image(run, item) for item in images[1:]]
                mode = "images"
            else:
                mode = "t2i"
                if not str(text or "").strip():
                    raise ValueError("文生图需要先填写提示词")
        elif reference == "previous":
            extra_images = [_previous_frame_image(run, int(index))]
        run["status"] = "running"
        run["progress"] = {"stage": "pipeline", "frame": int(index), "attempt": 0,
                           "done": sum(1 for item in run["frames"]
                                       if item.get("status") == "accepted"),
                           "total": len(run["frames"]), "percent": 0,
                           "message": f"准备{'生成' if mode == 't2i' else '精修'}第 {index} 帧"}
        store.save_run(run)
        ok = _edit_single_frame(run, target, generator, text, settings,
                                canvas_image=canvas_image,
                                extra_images=extra_images,
                                mode=mode,
                                on_event=on_event, should_cancel=should_cancel)
        accepted = sum(1 for item in run["frames"] if item.get("status") == "accepted")
        run["status"] = "review" if ok and accepted == len(run["frames"]) else ("review" if ok else "blocked")
        run["progress"] = {
            "stage": run["status"], "frame": int(index), "attempt": 0,
            "done": accepted, "total": len(run["frames"]),
            "percent": int(100 * accepted / max(1, len(run["frames"]))),
            "message": f"第 {index} 帧精修{'完成' if ok else '失败'}",
        }
        store.save_run(run)
        store.write_report(run)
        return run

    # 后续帧作废（接力链必须连续）
    for frame in run.get("frames") or []:
        if int(frame["index"]) > int(index):
            frame["status"] = "pending"
            frame["acceptedFile"] = ""
            frame["acceptedUrl"] = ""
            frame["acceptedPrompt"] = ""
            frame["currentFile"] = ""
            frame["attempts"] = []
    target["status"] = "pending"
    target["acceptedFile"] = ""
    target["acceptedUrl"] = ""
    target["acceptedPrompt"] = ""

    previous = _frame_ref(run, int(index) - 1)
    if previous is None:
        raise ValueError(f"第 {index - 1} 帧尚未通过，无法重试")
    reference_image = Image.open(store.run_dir(run["id"]) / "reference.png")
    reference_image.load()
    reference = generator.prepare(reference_image)
    first = _frame_ref(run, 1) if int(index) > 1 else None
    settings = normalize_settings(run["settings"])
    layer = _build_layer(run, reference_image, reference, generator, settings,
                         len(run["frames"]), on_event)
    if layer is not None:
        layer["previous_key"] = (_stored_key(run, int(index) - 1, generator)
                                 or _key_reference(run, previous, generator,
                                                   len(run["frames"]), on_event))
    run["status"] = "running"
    next_ref, accepted = _run_frame(run, target, previous, reference, generator, settings,
                                    first.image if first else None, on_event,
                                    should_cancel, layer)
    if not accepted:
        run["status"] = "blocked"
        run["progress"]["message"] = f"第 {index} 帧重试仍未通过"
        store.save_run(run)
        store.write_report(run)
        return run
    # 重试通过后，后续帧需要重新跑
    run["status"] = "review" if all(
        frame.get("status") == "accepted" for frame in run["frames"]
        if int(frame["index"]) <= int(index)) else "running"
    run["progress"] = {
        "stage": run["status"],
        "frame": int(index),
        "attempt": 0,
        "done": sum(1 for frame in run["frames"] if frame["status"] == "accepted"),
        "total": len(run["frames"]),
        "percent": int(100 * sum(1 for frame in run["frames"]
                                 if frame["status"] == "accepted") / max(1, len(run["frames"]))),
        "message": f"第 {index} 帧重试通过",
    }
    store.save_run(run)
    store.write_report(run)
    return run
