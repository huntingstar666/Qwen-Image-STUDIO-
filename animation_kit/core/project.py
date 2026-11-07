"""项目与帧的落盘：一个项目 = 一个 JSON 文档 + 一个帧目录。

设计对齐主项目的 ``storage`` / ``materials``：

* JSON 原子写入（临时文件 + ``os.replace``），避免进程中断写坏索引；
* 帧图统一存 PNG，URL 走 ``/files/frames/<project>/<frame>.png``；
* 项目列表从磁盘扫描，不额外维护容易失真的索引；
* 删除项目只删自己的帧目录，导出文件独立保留。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

from .. import config
from . import registry

_SAFE = re.compile(r"[^0-9A-Za-z_.\-\u4e00-\u9fff]+")


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def new_id(prefix: str = "") -> str:
    tail = secrets.token_hex(4)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{prefix}{stamp}-{tail}" if prefix else f"{stamp}-{tail}"


def _safe_stem(text: str, fallback: str = "frame") -> str:
    stem = os.path.splitext(os.path.basename(str(text or "")))[0]
    stem = _SAFE.sub("_", stem).strip("._")[:50]
    return stem or fallback


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def project_path(project_id: str) -> Path:
    clean = _SAFE.sub("_", str(project_id or ""))[:80]
    if not clean:
        raise ValueError("项目编号为空")
    return config.PROJECTS_DIR / f"{clean}.json"


def generate_frame_id() -> str:
    return f"f-{secrets.token_hex(4)}"


def create_doc(name: str, *, canvas: dict[str, Any] | None = None,
               timeline: dict[str, Any] | None = None) -> dict[str, Any]:
    config.ensure_dirs()
    stamp = now()
    raw = {
        "version": registry.DOC_VERSION,
        "id": new_id("prj-"),
        "name": str(name or "未命名动画")[:80],
        "createdAt": stamp,
        "updatedAt": stamp,
        "canvas": canvas or {},
        "timeline": timeline or {},
        "processing": {},
        "source": {"type": "images", "importedAt": stamp},
        "frames": [],
    }
    doc = registry.normalize_doc(raw)
    doc["id"] = raw["id"]
    doc["createdAt"] = stamp
    doc["updatedAt"] = stamp
    return doc


def save_project(doc: dict[str, Any], project_id: str | None = None) -> dict[str, Any]:
    config.ensure_dirs()
    normalized = registry.normalize_doc(doc, doc_id=str(project_id or doc.get("id") or ""))
    if not normalized["id"]:
        normalized["id"] = new_id("prj-")
    if not normalized["createdAt"]:
        normalized["createdAt"] = now()
    normalized["updatedAt"] = now()
    _write_json(project_path(normalized["id"]), normalized)
    return normalized


def load_project(project_id: str) -> dict[str, Any]:
    path = project_path(project_id)
    if not path.is_file():
        raise KeyError(project_id)
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    doc = registry.normalize_doc(raw, doc_id=project_id)
    doc["id"] = project_id
    doc["createdAt"] = str(raw.get("createdAt") or doc.get("createdAt") or "")
    doc["updatedAt"] = str(raw.get("updatedAt") or doc.get("updatedAt") or "")
    return doc


def list_projects() -> list[dict[str, Any]]:
    config.ensure_dirs()
    items: list[dict[str, Any]] = []
    for path in config.PROJECTS_DIR.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError):
            continue
        frames = raw.get("frames") or []
        first = frames[0] if frames else {}
        items.append({
            "id": str(raw.get("id") or path.stem),
            "name": str(raw.get("name") or "未命名动画"),
            "updatedAt": str(raw.get("updatedAt") or ""),
            "createdAt": str(raw.get("createdAt") or ""),
            "frameCount": len(frames),
            "canvas": raw.get("canvas") or {},
            "timeline": raw.get("timeline") or {},
            "cover": str(first.get("url") or ""),
        })
    items.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    return items


def delete_project(project_id: str) -> bool:
    path = project_path(project_id)
    if not path.is_file():
        return False
    try:
        path.unlink()
    except OSError:
        return False
    shutil.rmtree(_project_frames_dir(project_id), ignore_errors=True)
    return True


def _project_frames_dir(project_id: str) -> Path:
    clean = _SAFE.sub("_", str(project_id or ""))[:80]
    return config.FRAMES_DIR / clean


def save_frame(project_id: str, data: bytes, *, stem: str = "frame",
               ext: str = ".png") -> dict[str, Any]:
    """保存一帧 PNG，返回 {name, relpath, url, bytes}。"""
    folder = _project_frames_dir(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{new_id('')}_{_safe_stem(stem)}{ext}"
    path = folder / name
    with open(path, "wb") as handle:
        handle.write(data)
    return {
        "name": name,
        "relpath": f"frames/{project_id}/{name}",
        "url": config.url_for(path),
        "bytes": len(data),
    }


def delete_frame_file(url: str) -> None:
    try:
        path = config.resolve_url(url)
        if path.is_file() and config.FRAMES_DIR.resolve() in path.parents:
            path.unlink()
    except (OSError, ValueError):
        pass


def read_frame_bytes(url: str) -> bytes:
    path = config.resolve_url(url)
    if not path.is_file():
        raise FileNotFoundError(f"帧文件不存在：{url}")
    return path.read_bytes()
