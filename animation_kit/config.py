"""运行配置：路径、端口、目录初始化。

数据目录默认放在包内 ``_data/``，也可以用环境变量 ``ANIM_KIT_DATA`` 指到别处。
这样套件是自包含的：拷走整个 ``animation_kit/`` 就能跑，不会污染主项目。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

PACKAGE_DIR = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_DIR / "web"
DATA_DIR = Path(os.environ.get("ANIM_KIT_DATA") or (PACKAGE_DIR / "_data")).resolve()

PROJECTS_DIR = DATA_DIR / "projects"
FRAMES_DIR = DATA_DIR / "frames"
EXPORTS_DIR = DATA_DIR / "exports"
THUMBS_DIR = DATA_DIR / "thumbs"

HOST = "127.0.0.1"
PORT = int(os.environ.get("ANIM_KIT_PORT") or 8710)

DEFAULTS: dict[str, Any] = {
    "fps": 12,
    "canvas_width": 1024,
    "canvas_height": 1024,
    "max_side": 8192,
    "history_limit": 40,
    "gif_min_ms": 20,
}


def ensure_dirs() -> None:
    for folder in (DATA_DIR, PROJECTS_DIR, FRAMES_DIR, EXPORTS_DIR, THUMBS_DIR):
        folder.mkdir(parents=True, exist_ok=True)


def url_for(path: Path | str) -> str:
    """把数据目录内的路径转成 ``/files/...`` 对外地址。"""
    target = Path(path).resolve()
    try:
        rel = target.relative_to(DATA_DIR)
    except ValueError:
        rel = target
    return "/files/" + str(rel).replace("\\", "/").lstrip("/")


def resolve_url(url: str) -> Path:
    """把 ``/files/...`` 解析为数据目录内的绝对路径，并阻止目录穿越。"""
    text = str(url or "")
    if text.startswith("/files/"):
        text = text[len("/files/"):]
    clean = text.replace("\\", "/").lstrip("/")
    if ".." in clean.split("/"):
        raise ValueError("非法路径")
    target = (DATA_DIR / clean).resolve()
    root = DATA_DIR.resolve()
    if target != root and root not in target.parents:
        raise ValueError("非法路径")
    return target
