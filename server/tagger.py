"""WD14 图像反推（Danbooru 标签）。

只依赖 onnxruntime / numpy / Pillow，不依赖 ComfyUI 服务；
模型为 SmilingWolf 的 WD 系列 ONNX，首次使用时从 HuggingFace 下载到本地模型目录。
"""

from __future__ import annotations

import csv
import io
import os
import threading
import time
from pathlib import Path
from typing import Any

from . import config

#: 默认模型：单文件约 300MB，CPU 推理一张 1024² 图约 0.3~1s。
DEFAULT_MODEL = "wd-v1-4-moat-tagger-v2"

#: 与 ComfyUI-WD14-Tagger 一致的模型仓库列表（SmilingWolf/*）。
MODELS: dict[str, dict[str, str]] = {
    "wd-v1-4-moat-tagger-v2": {"repo": "SmilingWolf/wd-v1-4-moat-tagger-v2", "label": "WD v1.4 Moat v2（推荐）"},
    "wd-v1-4-convnextv2-tagger-v2": {"repo": "SmilingWolf/wd-v1-4-convnextv2-tagger-v2", "label": "WD v1.4 ConvNeXtV2 v2"},
    "wd-v1-4-convnext-tagger-v2": {"repo": "SmilingWolf/wd-v1-4-convnext-tagger-v2", "label": "WD v1.4 ConvNeXt v2"},
    "wd-v1-4-vit-tagger-v2": {"repo": "SmilingWolf/wd-v1-4-vit-tagger-v2", "label": "WD v1.4 ViT v2"},
    "wd-v1-4-swinv2-tagger-v2": {"repo": "SmilingWolf/wd-v1-4-swinv2-tagger-v2", "label": "WD v1.4 SwinV2 v2"},
    "wd-v1-4-convnext-tagger": {"repo": "SmilingWolf/wd-v1-4-convnext-tagger", "label": "WD v1.4 ConvNeXt"},
    "wd-v1-4-vit-tagger": {"repo": "SmilingWolf/wd-v1-4-vit-tagger", "label": "WD v1.4 ViT"},
    "wd-vit-tagger-v3": {"repo": "SmilingWolf/wd-vit-tagger-v3", "label": "WD ViT v3"},
    "wd-convnext-tagger-v3": {"repo": "SmilingWolf/wd-convnext-tagger-v3", "label": "WD ConvNeXt v3"},
    "wd-swinv2-tagger-v3": {"repo": "SmilingWolf/wd-swinv2-tagger-v3", "label": "WD SwinV2 v3"},
    "wd-eva02-large-tagger-v3": {"repo": "SmilingWolf/wd-eva02-large-tagger-v3", "label": "WD EVA02-Large v3"},
}

_HEADERS = {"User-Agent": "qwen-image2.1-workbench/1.0"}
_LOCK = threading.RLock()
_SESSION: dict[str, Any] = {"key": "", "session": None, "tags": [], "general": 0, "character": 0}


class TaggerError(Exception):
    """反推出错（模型缺失 / 下载失败 / 推理失败）。"""

    def __init__(self, message: str, *, code: str = "tagger_error") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


# --------------------------------------------------------------------------- 目录


def _tagger_cfg(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or config.load_config()
    return dict(cfg.get("tagger") or {})


def search_dirs(cfg: dict[str, Any] | None = None) -> list[Path]:
    """候选模型目录：显式配置 → ComfyUI 的 onnx / wd14_tagger → 项目 storage。"""
    cfg = cfg or config.load_config()
    tag = _tagger_cfg(cfg)
    out: list[Path] = []
    if tag.get("dir"):
        out.append(Path(str(tag["dir"])).expanduser())
    root = str(cfg.get("model_root") or "").strip()
    if root:
        out.append(Path(root) / "onnx")
        out.append(Path(root) / "wd14_tagger")
    out.append(Path(config.STORAGE_DIR) / "models" / "wd14")
    # 去重且保持顺序
    seen: set[str] = set()
    unique: list[Path] = []
    for path in out:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def download_dir(cfg: dict[str, Any] | None = None) -> Path:
    """下载目录：优先显式目录，其次 model_root/onnx，最后项目 storage。"""
    cfg = cfg or config.load_config()
    tag = _tagger_cfg(cfg)
    if tag.get("dir"):
        return Path(str(tag["dir"])).expanduser()
    root = str(cfg.get("model_root") or "").strip()
    if root:
        return Path(root) / "onnx"
    return Path(config.STORAGE_DIR) / "models" / "wd14"


def _model_paths(name: str, cfg: dict[str, Any] | None = None) -> tuple[Path | None, Path | None]:
    """在候选目录里找 `<name>.onnx` 与 `<name>.csv`。"""
    for folder in search_dirs(cfg):
        onnx = folder / f"{name}.onnx"
        tags = folder / f"{name}.csv"
        if onnx.is_file() and tags.is_file():
            return onnx, tags
    return None, None


def list_models() -> dict[str, Any]:
    """可用的反推模型清单（含未安装项，便于前端触发首次下载）。"""
    cfg = config.load_config()
    tag = _tagger_cfg(cfg)
    installed: dict[str, dict[str, Any]] = {}
    for folder in search_dirs(cfg):
        if not folder.is_dir():
            continue
        for item in folder.iterdir():
            if item.suffix.lower() != ".onnx":
                continue
            name = item.stem
            tags = folder / f"{name}.csv"
            if not tags.is_file() or name in installed:
                continue
            installed[name] = {
                "name": name,
                "dir": str(folder),
                "size_mb": round(item.stat().st_size / (1024 ** 2), 1),
            }

    models: list[dict[str, Any]] = []
    for name, meta in MODELS.items():
        found = installed.get(name) or {}
        models.append(
            {
                "name": name,
                "label": meta["label"],
                "installed": bool(found),
                "size_mb": found.get("size_mb", 0),
                "dir": found.get("dir", ""),
                "known": True,
            }
        )
    for name, found in installed.items():
        if name not in MODELS:
            models.append(
                {
                    "name": name,
                    "label": name,
                    "installed": True,
                    "size_mb": found["size_mb"],
                    "dir": found["dir"],
                    "known": False,
                }
            )

    default = str(tag.get("model") or DEFAULT_MODEL)
    if default.endswith(".onnx"):
        default = default[:-5]
    return {
        "default": default,
        "dir": str(download_dir(cfg)),
        "dirs": [str(path) for path in search_dirs(cfg)],
        "models": models,
    }


# --------------------------------------------------------------------------- 下载


def _hf_endpoint() -> str:
    endpoint = os.getenv("HF_ENDPOINT", "https://huggingface.co").strip().rstrip("/")
    if not endpoint.startswith(("http://", "https://")):
        endpoint = f"https://{endpoint}"
    return endpoint


def _fetch(url: str, target: Path) -> None:
    import requests

    part = target.with_suffix(target.suffix + ".part")
    try:
        with requests.get(url, headers=_HEADERS, stream=True, timeout=(30, 120)) as resp:
            if resp.status_code != 200:
                raise TaggerError(
                    f"下载失败：HTTP {resp.status_code}（{url}）",
                    code="download_failed",
                )
            size = 0
            with open(part, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    size += len(chunk)
        if size <= 0:
            raise TaggerError("下载失败：文件为空", code="download_failed")
        os.replace(part, target)
    except TaggerError:
        part.unlink(missing_ok=True)
        raise
    except Exception as exc:  # noqa: BLE001
        part.unlink(missing_ok=True)
        raise TaggerError(
            "无法下载模型。请检查网络，或设置环境变量 HF_ENDPOINT 为镜像"
            f"（如 https://hf-mirror.com）后重试。原始错误：{type(exc).__name__}: {exc}",
            code="download_failed",
        ) from exc


def download_model(name: str, cfg: dict[str, Any] | None = None) -> tuple[Path, Path]:
    meta = MODELS.get(name)
    if not meta:
        raise TaggerError(f"未知模型：{name}", code="unknown_model")
    folder = download_dir(cfg)
    folder.mkdir(parents=True, exist_ok=True)
    base = f"{_hf_endpoint()}/{meta['repo']}/resolve/main"
    onnx = folder / f"{name}.onnx"
    tags = folder / f"{name}.csv"
    if not onnx.is_file():
        _fetch(f"{base}/model.onnx", onnx)
    if not tags.is_file():
        _fetch(f"{base}/selected_tags.csv", tags)
    return onnx, tags


# --------------------------------------------------------------------------- 推理


def _read_tags(path: Path, replace_underscore: bool) -> tuple[list[str], int, int]:
    tags: list[str] = []
    general_index = 0
    character_index = 0
    general_seen = False
    character_seen = False
    with open(path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        next(reader, None)
        for row in reader:
            if len(row) < 3:
                continue
            if not general_seen and row[2] == "0":
                general_index = len(tags)
                general_seen = True
            elif not character_seen and row[2] == "4":
                character_index = len(tags)
                character_seen = True
            tags.append(row[1].replace("_", " ") if replace_underscore else row[1])
    if not character_seen:
        character_index = len(tags)
    return tags, general_index, character_index


def _session(onnx_path: Path, tags_path: Path, replace_underscore: bool):
    import onnxruntime as ort

    key = f"{onnx_path}|{onnx_path.stat().st_mtime_ns}|{int(replace_underscore)}"
    with _LOCK:
        if _SESSION["session"] is not None and _SESSION["key"] == key:
            return _SESSION["session"], _SESSION["tags"], _SESSION["general"], _SESSION["character"]

        providers = [
            name
            for name in ("CUDAExecutionProvider", "CPUExecutionProvider")
            if name in ort.get_available_providers()
        ]
        try:
            session = ort.InferenceSession(str(onnx_path), providers=providers or ["CPUExecutionProvider"])
            tags, general, character = _read_tags(tags_path, replace_underscore)
        except Exception as exc:  # noqa: BLE001
            raise TaggerError(f"模型加载失败：{type(exc).__name__}: {exc}", code="model_load_failed") from exc

        _SESSION.update(
            {"key": key, "session": session, "tags": tags, "general": general, "character": character}
        )
        return session, tags, general, character


def _preprocess(image, session):
    import numpy as np

    meta = session.get_inputs()[0]
    shape = list(meta.shape)
    # v2 是 NHWC [1,H,W,3]，v3 是 NCHW [1,3,H,W]。
    nchw = len(shape) == 4 and shape[1] == 3
    size = int(shape[2] if nchw else shape[1])
    ratio = float(size) / max(image.size)
    new_size = (max(1, int(image.size[0] * ratio)), max(1, int(image.size[1] * ratio)))

    from PIL import Image

    resized = image.resize(new_size, Image.LANCZOS)
    square = Image.new("RGB", (size, size), (255, 255, 255))
    square.paste(resized, ((size - new_size[0]) // 2, (size - new_size[1]) // 2))

    array = np.asarray(square, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR
    if nchw:
        array = array.transpose(2, 0, 1)
    return np.expand_dims(array, 0), meta.name


def tag_image(
    data: bytes,
    *,
    model: str = "",
    threshold: float = 0.35,
    character_threshold: float = 0.85,
    exclude_tags: str = "",
    replace_underscore: bool = False,
    trailing_comma: bool = False,
    allow_download: bool = True,
) -> dict[str, Any]:
    """对图片做 WD14 反推，返回标签与可直接使用的提示词。"""
    from PIL import Image, ImageOps

    started = time.time()
    cfg = config.load_config()
    name = (model or str(_tagger_cfg(cfg).get("model") or DEFAULT_MODEL)).strip()
    if name.endswith(".onnx"):
        name = name[:-5]

    onnx_path, tags_path = _model_paths(name, cfg)
    downloaded = False
    if onnx_path is None or tags_path is None:
        if not allow_download:
            raise TaggerError(f"模型未安装：{name}", code="model_missing")
        onnx_path, tags_path = download_model(name, cfg)
        downloaded = True

    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise TaggerError(f"图片无法解析：{exc}", code="invalid_image") from exc

    session, tags, general_index, character_index = _session(onnx_path, tags_path, replace_underscore)
    tensor, input_name = _preprocess(image, session)
    try:
        scores = session.run([session.get_outputs()[0].name], {input_name: tensor})[0][0]
    except Exception as exc:  # noqa: BLE001
        raise TaggerError(f"推理失败：{type(exc).__name__}: {exc}", code="inference_failed") from exc

    threshold = max(0.0, min(1.0, float(threshold)))
    character_threshold = max(0.0, min(1.0, float(character_threshold)))
    excluded = {item.strip().lower() for item in exclude_tags.split(",") if item.strip()}

    picked: list[dict[str, Any]] = []
    for index, score in enumerate(scores):
        if index >= len(tags):
            break
        value = float(score)
        if index >= character_index:
            category = "character"
            if value < character_threshold:
                continue
        elif index >= general_index:
            category = "general"
            if value < threshold:
                continue
        else:
            continue  # rating 分类不输出
        tag_name = tags[index]
        if tag_name.lower() in excluded:
            continue
        picked.append({"tag": tag_name, "score": round(value, 4), "category": category})

    character = sorted(
        (item for item in picked if item["category"] == "character"),
        key=lambda item: item["score"],
        reverse=True,
    )
    general = sorted(
        (item for item in picked if item["category"] == "general"),
        key=lambda item: item["score"],
        reverse=True,
    )
    ordered = character + general

    parts = [item["tag"].replace("(", "\\(").replace(")", "\\)") for item in ordered]
    prompt = ", ".join(parts)
    if trailing_comma and prompt:
        prompt += ","

    return {
        "model": name,
        "prompt": prompt,
        "count": len(ordered),
        "tags": ordered,
        "width": image.size[0],
        "height": image.size[1],
        "downloaded": downloaded,
        "model_dir": str(onnx_path.parent),
        "elapsed_ms": int((time.time() - started) * 1000),
    }
