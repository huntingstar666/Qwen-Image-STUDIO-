"""video_studio 运行配置。

独立工作台：不 import 主项目业务代码，只通过 HTTP 调用主项目 8700。
所有路径都相对本目录，媒体数据全部落在 `_data/` 下。
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("VIDEO_STUDIO_DATA") or (ROOT / "_data"))
PROJECTS_DIR = DATA_DIR / "projects"

#: 主项目（生图 / 参考图上传 / 模型档案）地址
MAIN_BASE = (os.environ.get("VIDEO_STUDIO_MAIN") or "http://127.0.0.1:8700").rstrip("/")
#: 主项目配置文件：读 LLM 服务档案（只读，不写回）
MAIN_CONFIG = ROOT.parent / "config.json"

HOST = os.environ.get("VIDEO_STUDIO_HOST") or "127.0.0.1"
PORT = int(os.environ.get("VIDEO_STUDIO_PORT") or 8730)

#: 成片帧率：所有边界都对齐到该帧率
FPS = 30
#: 单项目最大镜头段数（防止一次生成把显存和磁盘吃光）
MAX_SHOTS = 120
#: 分段：相邻字幕 cue 间隔小于该值则合并为同一镜头
MERGE_GAP_MS = 350
#: 分段：单镜头最长时长
MAX_SHOT_MS = 8000
#: 分段：边界向静音中点吸附的搜索半径
SNAP_WINDOW_MS = 250
#: 静音检测参数（ffmpeg silencedetect）
SILENCE_NOISE = "-30dB"
SILENCE_MIN_DURATION = 0.15

#: 生图长边上限（主项目 max_side 默认 2048，这里保守取 1280 保证显存与速度）
IMAGE_MAX_SIDE = 1280
#: 波形采样：每秒峰值点数
PEAKS_PER_SECOND = 50

FFMPEG = os.environ.get("VIDEO_STUDIO_FFMPEG") or "ffmpeg"
FFPROBE = os.environ.get("VIDEO_STUDIO_FFPROBE") or "ffprobe"

#: 默认 LLM 模型（档案里 model 为空时用这个，避免落到空模型）
DEFAULT_LLM_MODEL = os.environ.get("VIDEO_STUDIO_LLM") or "qwen3.5:9b"
#: 单次 LLM 最多处理的镜头段数（超出分批）
PROMPT_BATCH = 40


def ensure_dirs() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


def project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id
