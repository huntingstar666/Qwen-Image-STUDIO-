"""项目存储：project.json 原子读写 + 媒体落盘。

目录约定（每个项目一个目录，整体可直接拷走）::

    _data/projects/<project-id>/
        project.json
        audio/source.m4a  audio/peaks.json  audio/bgm.m4a
        subs/source.srt
        images/s1.png …
        out/export-20261109-160101.mp4
        tmp/                     渲染中间文件（可随时删除）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from .. import config
from . import schema
from .errors import StudioError


# --------------------------------------------------------------------------- 基础


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def project_dir(project_id: str) -> Path:
    if not project_id or "/" in project_id or "\\" in project_id or ".." in project_id:
        raise StudioError("项目 id 不合法", code="bad_project")
    return config.project_dir(project_id)


def project_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def media_dir(project_id: str, kind: str) -> Path:
    path = project_dir(project_id) / kind
    path.mkdir(parents=True, exist_ok=True)
    return path


def tmp_dir(project_id: str) -> Path:
    path = project_dir(project_id) / "tmp"
    path.mkdir(parents=True, exist_ok=True)
    return path


def url_for(project_id: str, relpath: str) -> str:
    """项目内相对路径 → 静态 URL（/files 挂载在项目根目录）。"""
    return f"/files/{project_id}/{relpath.replace(os.sep, '/')}"


# --------------------------------------------------------------------------- 增删改查


def create(name: str = "") -> dict[str, Any]:
    config.ensure_dirs()
    project = schema.default_project(name)
    project_dir(project["id"]).mkdir(parents=True, exist_ok=True)
    save(project)
    return project


def save(project: dict[str, Any]) -> dict[str, Any]:
    project["updatedAt"] = schema.now_text()
    path = project_path(project["id"])
    # 轮询与后台任务会同时读写，Windows 上 os.replace 偶发 PermissionError
    for attempt in range(6):
        try:
            _atomic_json(path, project)
            return project
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))
    return project


def load(project_id: str) -> dict[str, Any]:
    path = project_path(project_id)
    if not path.is_file():
        raise StudioError(f"项目不存在：{project_id}", code="not_found", status=404)
    for attempt in range(6):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
            return schema.apply_defaults(project)
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))
        except json.JSONDecodeError as exc:
            raise StudioError(f"project.json 已损坏：{exc}", code="bad_project") from exc
    raise StudioError("读取项目失败", code="bad_project")


def list_projects() -> list[dict[str, Any]]:
    config.ensure_dirs()
    items: list[dict[str, Any]] = []
    for entry in sorted(config.PROJECTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not entry.is_dir() or not (entry / "project.json").is_file():
            continue
        try:
            project = json.loads((entry / "project.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append({
            "id": project.get("id") or entry.name,
            "name": project.get("name") or entry.name,
            "updatedAt": project.get("updatedAt") or "",
            "durationMs": int((project.get("audio") or {}).get("durationMs") or 0),
            "shotCount": len(project.get("shots") or []),
            "readyCount": sum(1 for s in project.get("shots") or [] if s.get("status") == "ready"),
            "ratio": (project.get("canvas") or {}).get("ratio") or "16:9",
            "outputs": len(project.get("outputs") or []),
        })
    return items


def delete(project_id: str) -> None:
    path = project_dir(project_id)
    if not path.is_dir():
        raise StudioError(f"项目不存在：{project_id}", code="not_found", status=404)
    shutil.rmtree(path, ignore_errors=True)


# --------------------------------------------------------------------------- 媒体写入


def _safe_name(name: str, fallback: str = "file") -> str:
    stem = Path(str(name or "")).stem
    keep = [ch for ch in stem if ch.isalnum() or ch in "-_"]
    return ("".join(keep)[:48] or fallback)


def write_bytes(project_id: str, kind: str, filename: str, data: bytes) -> str:
    """写入项目媒体目录，返回相对路径（posix 分隔符）。"""
    path = media_dir(project_id, kind) / filename
    path.write_bytes(data)
    return f"{kind}/{filename}"


def read_media(project_id: str, relpath: str) -> Path:
    path = (project_dir(project_id) / relpath).resolve()
    root = project_dir(project_id).resolve()
    if not str(path).startswith(str(root)):
        raise StudioError("非法媒体路径", code="bad_path")
    if not path.is_file():
        raise StudioError(f"媒体文件不存在：{relpath}", code="not_found", status=404)
    return path


def save_shot_image(project_id: str, shot_id: str, data: bytes, ext: str = ".png",
                    *, version: int | None = None) -> str:
    """写入镜头图片，默认自动递增版本号（s3_v1.png、s3_v2.png…）。"""
    ext = ext if ext.startswith(".") else f".{ext}"
    stem = _safe_name(shot_id, "shot")
    if version is None:
        numbers = image_version_numbers(project_id, shot_id)
        version = (max(numbers) if numbers else 0) + 1
    return write_bytes(project_id, "images", f"{stem}_v{int(version)}{ext}", data)


def save_asset_image(project_id: str, entity_id: str, data: bytes,
                     ext: str = ".png") -> str:
    """写入资产设定图（assets/e1_v1.png…），返回相对路径。"""
    ext = ext if ext.startswith(".") else f".{ext}"
    stem = _safe_name(entity_id, "asset")
    numbers = asset_image_numbers(project_id, entity_id)
    version = (max(numbers) if numbers else 0) + 1
    return write_bytes(project_id, "assets", f"{stem}_v{version}{ext}", data)


def asset_image_numbers(project_id: str, entity_id: str) -> set[int]:
    """扫描磁盘上该资产的设定图版本号。"""
    stem = _safe_name(entity_id, "asset")
    directory = project_dir(project_id) / "assets"
    numbers: set[int] = set()
    if not directory.is_dir():
        return numbers
    pattern = re.compile(rf"^{re.escape(stem)}_v(\d+)\.")
    for entry in directory.iterdir():
        match = pattern.match(entry.name)
        if match:
            numbers.add(int(match.group(1)))
    return numbers


def image_version_numbers(project_id: str, shot_id: str) -> set[int]:
    """扫描磁盘上该段的图片版本号；旧版同名文件（s3.png）视为第 1 版。"""
    stem = _safe_name(shot_id, "shot")
    directory = project_dir(project_id) / "images"
    numbers: set[int] = set()
    if not directory.is_dir():
        return numbers
    pattern = re.compile(rf"^{re.escape(stem)}(?:_v(\d+))?\.(?:png|jpe?g|webp)$", re.IGNORECASE)
    for entry in directory.iterdir():
        match = pattern.match(entry.name)
        if match:
            numbers.add(int(match.group(1)) if match.group(1) else 1)
    return numbers


def delete_media(project_id: str, relpath: str) -> bool:
    """删除项目内媒体文件；路径校验与 read_media 一致。"""
    if not relpath:
        return False
    try:
        path = read_media(project_id, relpath)
    except StudioError:
        return False
    try:
        path.unlink()
        return True
    except OSError:
        return False


def save_audio(project_id: str, data: bytes, ext: str = ".m4a", *, stem: str = "source") -> str:
    ext = ext if ext.startswith(".") else f".{ext}"
    return write_bytes(project_id, "audio", f"{stem}{ext}", data)


def save_subtitle(project_id: str, data: bytes, ext: str = ".srt") -> str:
    ext = ext if ext.startswith(".") else f".{ext}"
    return write_bytes(project_id, "subs", f"source{ext}", data)


def save_output(project_id: str, data_or_path: bytes | str, filename: str) -> str:
    out = media_dir(project_id, "out") / filename
    if isinstance(data_or_path, bytes):
        out.write_bytes(data_or_path)
    else:
        shutil.copyfile(data_or_path, out)
    return f"out/{filename}"


def clear_tmp(project_id: str) -> None:
    path = project_dir(project_id) / "tmp"
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


# --------------------------------------------------------------------------- 对外投影


def _shot_view(project_id: str, shot: dict[str, Any]) -> dict[str, Any]:
    data = dict(shot)
    image = shot.get("image") or ""
    data["imageUrl"] = url_for(project_id, image) if image else ""
    history = []
    for item in shot.get("imageHistory") or []:
        entry = dict(item)
        file = entry.get("file") or ""
        entry["url"] = url_for(project_id, file) if file else ""
        history.append(entry)
    data["imageHistory"] = history
    return data


def public_view(project: dict[str, Any]) -> dict[str, Any]:
    """补上可直接访问的 URL，不改库里的原始字段。"""
    project_id = project["id"]
    data = json.loads(json.dumps(project, ensure_ascii=False))
    audio = data.get("audio") or {}
    audio["url"] = url_for(project_id, audio["file"]) if audio.get("file") else ""
    audio["peaksUrl"] = url_for(project_id, audio["peaksFile"]) if audio.get("peaksFile") else ""
    bgm = ((data.get("render") or {}).get("bgm") or {})
    bgm["url"] = url_for(project_id, bgm["file"]) if bgm.get("file") else ""
    subtitle = data.get("subtitle") or {}
    subtitle["url"] = url_for(project_id, subtitle["file"]) if subtitle.get("file") else ""
    # 资产卡：参考图补可直接显示的 URL（refImages 仍保留原始相对路径）
    content = ((data.get("locks") or {}).get("content") or {})
    for entity in content.get("entities") or []:
        if not isinstance(entity, dict):
            continue
        entity["refUrls"] = [
            url_for(project_id, str(file))
            for file in (entity.get("refImages") or [])
        ]
    data["shots"] = [_shot_view(project_id, shot) for shot in project.get("shots") or []]
    outputs = []
    for item in project.get("outputs") or []:
        entry = dict(item)
        entry["url"] = url_for(project_id, entry.get("file") or "")
        outputs.append(entry)
    data["outputs"] = outputs
    return data
