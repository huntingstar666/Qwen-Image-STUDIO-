"""素材仓库：用户主动收藏的作品与本地素材。

与「历史记录」的区别
--------------------
历史记录是全部任务结果（含失败与试错），由任务队列维护；
素材仓库只保存用户点击收藏 / 主动上传的内容，索引落在
``storage/materials.json``，图片复制到 ``storage/materials/``，
因此清理历史不会让仓库图片失效。

数据字段与前端保持一致（camelCase），避免前后端两套命名。
"""
from __future__ import annotations

import base64
import json
import os
import threading
import time
from typing import Any

from . import config, storage

INDEX_PATH = os.path.join(config.STORAGE_DIR, "materials.json")
MATERIALS_DIR = os.path.join(config.STORAGE_DIR, "materials")
THUMBS_DIR = os.path.join(MATERIALS_DIR, "thumbs")

KINDS = {"t2i", "edit", "upscale", "upload", "studio"}
SOURCES = {"gallery", "history", "result", "upload", "studio"}
_EXT_BY_FORMAT = {
    "jpeg": ".jpg",
    "jpg": ".jpg",
    "png": ".png",
    "webp": ".webp",
    "gif": ".gif",
    "bmp": ".bmp",
}

_LOCK = threading.RLock()


# --------------------------------------------------------------------------- 基础


def _ensure_dirs() -> None:
    os.makedirs(MATERIALS_DIR, exist_ok=True)
    os.makedirs(THUMBS_DIR, exist_ok=True)


def _load() -> list[dict[str, Any]]:
    _ensure_dirs()
    if not os.path.exists(INDEX_PATH):
        return []
    try:
        with open(INDEX_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    items = data.get("items") if isinstance(data, dict) else data
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _save(items: list[dict[str, Any]]) -> None:
    _ensure_dirs()
    payload = {"version": 1, "items": items}
    tmp = f"{INDEX_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, INDEX_PATH)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _clean_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _derive_title(prompt: str, fallback: str = "未命名素材") -> str:
    text = " ".join(prompt.split())
    if not text:
        return fallback
    return text[:24] + ("…" if len(text) > 24 else "")


def _normalize_seed(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return None


def _normalize_palette(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    start = _clean_text(value.get("from"), 32)
    end = _clean_text(value.get("to"), 32)
    if not start or not end:
        return None
    try:
        angle = int(float(value.get("angle", 135)))
    except (TypeError, ValueError):
        angle = 135
    return {"from": start, "to": end, "angle": angle % 360}


def _read_image_bytes(raw: Any) -> bytes | None:
    """接受 data URL、/files/ 相对路径、{dataUrl|url} 或原始 bytes。

    外链（http/https）不抓取，返回 None，由前端用渐变封面兜底。
    """
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    if isinstance(raw, dict):
        for key in ("data", "dataUrl", "url"):
            if raw.get(key):
                return _read_image_bytes(raw[key])
        return None
    text = str(raw or "").strip()
    if not text:
        return None
    if text.startswith("data:"):
        try:
            _header, _sep, body = text.partition(",")
            return base64.b64decode(body)
        except (ValueError, TypeError) as exc:
            raise ValueError("图片 data URL 解析失败") from exc
    if text.startswith("/files/"):
        path = storage.resolve_storage_path(text[len("/files/"):])
        if not os.path.exists(path):
            raise ValueError("图片文件不存在")
        with open(path, "rb") as fh:
            return fh.read()
    return None


def _write_image(data: bytes, material_id: str, suffix: str = "") -> dict[str, Any]:
    info = storage.probe_image(data)
    ext = _EXT_BY_FORMAT.get(str(info.get("format") or "").lower(), ".png")
    name = f"{material_id}{suffix}{ext}"
    rel = f"materials/{name}"
    path = os.path.join(config.STORAGE_DIR, "materials", name)
    with open(path, "wb") as fh:
        fh.write(data)

    thumb_name = f"{material_id}{suffix}.png"
    thumb_rel = f"materials/thumbs/{thumb_name}"
    thumb_path = os.path.join(THUMBS_DIR, thumb_name)
    try:
        with open(thumb_path, "wb") as fh:
            fh.write(storage.make_thumb(data, max_side=720))
        thumb_url = storage.url_for(thumb_rel)
    except Exception:  # noqa: BLE001 - 缩略图失败不影响原图
        thumb_url = storage.url_for(rel)

    return {
        "url": storage.url_for(rel),
        "thumbUrl": thumb_url,
        "width": int(info.get("width") or 0),
        "height": int(info.get("height") or 0),
        "filename": name,
    }


def _delete_url(url: str) -> None:
    """只允许删除仓库目录内的文件，避免误删 outputs/uploads。"""
    text = str(url or "")
    if not text.startswith("/files/materials/"):
        return
    try:
        path = storage.resolve_storage_path(text[len("/files/"):])
        if os.path.isfile(path):
            os.remove(path)
    except (OSError, ValueError):
        pass


def _delete_item_files(item: dict[str, Any]) -> None:
    image = item.get("image")
    if isinstance(image, dict):
        _delete_url(image.get("url"))
        _delete_url(image.get("thumbUrl"))
    for ref in item.get("referenceImages") or []:
        if isinstance(ref, dict):
            _delete_url(ref.get("url"))
            _delete_url(ref.get("thumbUrl"))
        else:
            _delete_url(ref)


# --------------------------------------------------------------------------- 对外 API


def list_materials(
    *,
    kind: str | None = None,
    category: str | None = None,
    q: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    kind = (kind or "").strip()
    category = (category or "").strip()
    keyword = (q or "").strip().lower()
    limit = max(1, min(int(limit or 200), 500))
    with _LOCK:
        items = _load()
    result: list[dict[str, Any]] = []
    for item in items:
        if kind and kind != "all" and item.get("kind") != kind:
            continue
        if category and category != "全部" and item.get("category") != category:
            continue
        if keyword:
            haystack = " ".join(
                [
                    str(item.get("title") or ""),
                    str(item.get("prompt") or ""),
                    str(item.get("note") or ""),
                    str(item.get("category") or ""),
                    " ".join(str(tag) for tag in item.get("tags") or []),
                ]
            ).lower()
            if keyword not in haystack:
                continue
        result.append(item)
    result.sort(key=lambda entry: str(entry.get("createdAt") or ""), reverse=True)
    return result[:limit]


def create_material(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("素材数据格式不正确")
    prompt = _clean_text(payload.get("prompt"))
    kind = str(payload.get("kind") or "").strip()
    if kind not in KINDS:
        if payload.get("referenceImages"):
            kind = "edit"
        elif prompt:
            kind = "t2i"
        else:
            kind = "upload"

    source = str(payload.get("source") or "result").strip()
    if source not in SOURCES:
        source = "result"

    material_id = f"mat-{storage.new_id()}"
    image = payload.get("image")
    image_meta = None
    raw = _read_image_bytes(image)
    if raw:
        try:
            image_meta = _write_image(raw, material_id)
        except (OSError, ValueError) as exc:
            raise ValueError(f"图片保存失败：{exc}") from exc

    reference_images: list[dict[str, Any]] = []
    for index, ref in enumerate(payload.get("referenceImages") or []):
        if len(reference_images) >= 6:
            break
        ref_raw = _read_image_bytes(ref)
        if not ref_raw:
            continue
        try:
            reference_images.append(_write_image(ref_raw, material_id, f"-ref{index + 1}"))
        except (OSError, ValueError):
            continue

    fallback_name = ""
    if isinstance(image, dict):
        fallback_name = _clean_text(image.get("filename"), 80)
    title = _clean_text(payload.get("title"), 80) or _derive_title(prompt, fallback_name or "未命名素材")
    category = _clean_text(payload.get("category"), 24) or "未分类"
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    tags = [str(tag)[:24] for tag in (payload.get("tags") or []) if str(tag).strip()][:8]

    item = {
        "id": material_id,
        "title": title,
        "category": category,
        "kind": kind,
        "prompt": prompt,
        "negativePrompt": _clean_text(payload.get("negativePrompt")),
        "seed": _normalize_seed(payload.get("seed")),
        "params": params,
        "image": image_meta,
        "referenceImages": reference_images,
        "palette": _normalize_palette(payload.get("palette")),
        "tags": tags,
        "note": _clean_text(payload.get("note"), 1000),
        "source": source,
        "sourceRef": _clean_text(payload.get("sourceRef"), 160),
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    with _LOCK:
        items = _load()
        items.insert(0, item)
        _save(items)
    return item


def create_upload(
    data: bytes,
    *,
    filename: str = "",
    title: str | None = None,
    category: str | None = None,
) -> dict[str, Any]:
    if not data:
        raise ValueError("上传文件为空")
    stem = os.path.splitext(os.path.basename(filename or "upload"))[0]
    return create_material(
        {
            "title": title or stem or "本地素材",
            "category": category or "未分类",
            "kind": "upload",
            "prompt": "",
            "source": "upload",
            "image": {"data": data, "filename": filename or "upload.png"},
        }
    )


def update_material(material_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(patch, dict):
        raise ValueError("更新内容格式不正确")
    with _LOCK:
        items = _load()
        for index, item in enumerate(items):
            if item.get("id") != material_id:
                continue
            for key, limit in (
                ("title", 80),
                ("category", 24),
                ("note", 1000),
                ("prompt", 4000),
                ("negativePrompt", 4000),
            ):
                if key in patch:
                    item[key] = _clean_text(patch.get(key), limit)
            if "seed" in patch:
                item["seed"] = _normalize_seed(patch.get("seed"))
            if "tags" in patch:
                item["tags"] = [str(tag)[:24] for tag in (patch.get("tags") or []) if str(tag).strip()][:8]
            item["updatedAt"] = _now()
            items[index] = item
            _save(items)
            return item
    raise KeyError(material_id)


def delete_material(material_id: str) -> bool:
    with _LOCK:
        items = _load()
        for index, item in enumerate(items):
            if item.get("id") != material_id:
                continue
            _delete_item_files(item)
            items.pop(index)
            _save(items)
            return True
    return False
