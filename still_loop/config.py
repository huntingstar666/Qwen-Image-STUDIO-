from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("STILL_LOOP_DATA") or (ROOT / "_data"))
RUNS_DIR = DATA_DIR / "runs"

MAIN_BASE = os.environ.get("STILL_LOOP_MAIN") or "http://127.0.0.1:8700"
OLLAMA_BASE = os.environ.get("STILL_LOOP_OLLAMA") or "http://127.0.0.1:11434"
ANIM_BASE = os.environ.get("STILL_LOOP_ANIM") or "http://127.0.0.1:8710"
LLM_MODEL = os.environ.get("STILL_LOOP_LLM") or "qwen3.5:9b"

#: 主项目 data/ 目录里有各图像模型的 PE 系统提示词，分镜直接复用 Qwen edit 那一份。
PE_DIR = Path(os.environ.get("STILL_LOOP_PE_DIR") or (ROOT.parent / "data"))
EDIT_MODEL = os.environ.get("STILL_LOOP_EDIT_MODEL") or "qwen"
EXPORT_FORMATS = ("gif", "apng", "webp", "mp4", "webm")
VIDEO_FORMATS = ("mp4", "webm")
MOTION_PRESETS = ("both", "smooth", "stopmotion")
HANDMADE_STYLES = ("", "clay", "paper", "felt", "lego")
FFMPEG = os.environ.get("STILL_LOOP_FFMPEG") or "ffmpeg"

DEFAULT_FRAMES = 12
DEFAULT_SIZE = 512
DEFAULT_MAX_RETRIES = 3
DEFAULT_FPS = 12
DEFAULT_HOLD = 2
DEFAULT_STOPMOTION_FPS = 8
