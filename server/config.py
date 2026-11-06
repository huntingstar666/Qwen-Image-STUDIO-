"""全局配置：模型路径、推理引擎、Ollama、生成默认值与比例表。

设计要点
--------
1. 本项目是**独立服务**：模型按绝对路径加载，不依赖 ComfyUI 的模型清单/服务进程，
   只需要 `comfy_root` 指向一份 ComfyUI 安装（借用其 `comfy/` 模型库代码）。
2. 配置优先级：环境变量 > `config.json` > 内置 DEFAULTS。
3. 修改 `config.json` 后重启服务生效；`/api/options` 会实时反映扫描到的模型列表。
"""
from __future__ import annotations

import json
import os
import shutil
from typing import Any

# --------------------------------------------------------------------------- 路径

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORAGE_DIR = os.path.join(ROOT, "storage")
UPLOAD_DIR = os.path.join(STORAGE_DIR, "uploads")
OUTPUT_DIR = os.path.join(STORAGE_DIR, "outputs")
THUMB_DIR = os.path.join(STORAGE_DIR, "thumbnails")
EDITOR_DIR = os.path.join(STORAGE_DIR, "editor")
WEB_DIR = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(ROOT, "data")
CONFIG_PATH = os.path.join(ROOT, "config.json")

# --------------------------------------------------------------------------- 常量

DEFAULT_COMFY_ROOT = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI"

#: 官方 Qwen-Image-2.1-Turbo 保存的 8 步采样调度（来自权重仓 model_index.json 的
#: `sample_sigmas`）。采样时再追加 0.0 → 9 个 sigma = 8 步。
TURBO_SIGMAS: list[float] = [
    1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568,
]

#: 9 步自定义调度（孤海工作流同款）：在官方 8 步末尾补一个 0.15 低噪台阶，
#: 让最后一步的细节收敛更充分。采样时同样追加 0.0 → 10 个 sigma = 9 步。
#: 图片精修（studio）开启 Turbo 时默认用这个预设。
TURBO_SIGMAS_9: list[float] = TURBO_SIGMAS + [0.15]

#: 仓库里现成的 Turbo 底模（权重本身已蒸馏，不需要再挂加速 LoRA）。
#: 可在 config.json 用 ``turbo_unet`` 覆盖。
TURBO_CKPT_UNET = (
    "diffusion_models/QwenImage2.1/qwen_image_2.1_turbo_int8_convrot.safetensors"
)

#: 官方推荐的 7 种比例（README「Supported Aspect Ratios」，均为 32 的倍数）
RATIOS: list[dict[str, Any]] = [
    {"id": "1:1", "label": "1:1 方形", "w": 2048, "h": 2048, "mp": 4.0},
    {"id": "4:3", "label": "4:3 横幅", "w": 2400, "h": 1792, "mp": 4.3},
    {"id": "3:4", "label": "3:4 竖幅", "w": 1792, "h": 2400, "mp": 4.3},
    {"id": "3:2", "label": "3:2 横幅", "w": 2528, "h": 1696, "mp": 4.3},
    {"id": "2:3", "label": "2:3 竖幅", "w": 1696, "h": 2528, "mp": 4.3},
    {"id": "16:9", "label": "16:9 宽银幕", "w": 2752, "h": 1536, "mp": 4.2},
    {"id": "9:16", "label": "9:16 竖屏", "w": 1536, "h": 2752, "mp": 4.2},
]

SAMPLERS: list[str] = [
    "euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lms",
    "dpmpp_2s_ancestral", "dpmpp_2m", "dpmpp_sde", "dpmpp_2m_sde",
    "dpmpp_3m_sde", "ddim", "uni_pc", "lcm", "res_multistep", "res_multistep_cfg_pp",
]

SCHEDULERS: list[str] = [
    "simple", "normal", "sgm_uniform", "beta", "ddim_uniform", "kl_optimal",
    "exponential", "karras",
]

DEFAULTS: dict[str, Any] = {
    # 引擎代码位置：项目内 engine/（由 scripts/port_engine.ps1 从 ComfyUI 移植而来）。
    # 运行期**不依赖**原 ComfyUI 的源码目录。
    "engine_dir": "",
    # 仅用于「重新移植引擎」与推断默认 model_root；运行期不读取其代码。
    "comfy_root": DEFAULT_COMFY_ROOT,
    # 模型根目录；也可单独指定 model_dirs 覆盖
    "model_root": "",
    "model_dirs": {
        "unet": ["diffusion_models", "unet"],
        "clip": ["text_encoders", "clip"],
        "vae": ["vae"],
        "lora": ["loras"],
    },
    # 默认使用的模型档案（见 server/models.py：qwen / moss）
    "model": "qwen",
    # 默认使用的模型（相对 model_root 的路径，需带子目录前缀；也可写绝对路径）
    "unet": "diffusion_models/QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors",
    "clip": "text_encoders/Qweniamge2.1/qwen3vl_8b_int8_convrot.safetensors",
    "vae": "vae/Qweniamge2.1/qwen_image_2.1_vae_bf16.safetensors",
    # 常用 LoRA
    "turbo_lora": "loras/qwen2.1加速/qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors",
    # Turbo 预设「自动切底模」使用的权重（仓库里现成的 Turbo 版本）
    "turbo_unet": TURBO_CKPT_UNET,
    "consistency_lora": "loras/Qwen-功能2.1/qwen-image-2.1-consistency-2000.safetensors",
    # 服务
    "host": "127.0.0.1",
    "port": 8700,
    # Ollama
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "",  # 空字符串 = 自动挑一个
    # 生成默认值
    "steps": 25,
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "width": 1024,
    "height": 1024,
    "turbo_profile": "turbo8_official",
    "max_batch": 4,
    "max_side": 4096,
    "vram_reserve": 0.15,
    # 历史
    "history_limit": 200,
    # 显存自治：空闲多少分钟后自动卸载模型（分钟；0 = 关闭）
    # 注意：卸载后下一张图要重新装载 + 预热（约 20~30s），所以默认给到 30 分钟
    "idle_unload_minutes": 30,
    # 文本编码器是否常驻显存（实测常驻更快，2026-11-06）：
    # 省掉每次 1.0~1.4s 的重新上卡，且采样更稳（1024² 8 步 1.28s，让位后 2.33s）。
    # 代价是显存变紧，必须配合下面的 tiled_decode_threshold 一起用。
    "keep_text_encoder_resident": True,
    # 冷启动后预热 kernel：实测「小尺寸预热」并不能消除大尺寸首图的 autotune，
    # 反而多花 ~19s，默认关。
    "warmup_on_load": False,  # 预热只是把 autotune 成本前移，不减少总时间
    # 分块解码：>= 该像素数直接分块。CLIP 常驻 + 18GB LoRA 时 896² 全量就会 OOM，
    # 失败一次既慢（0.38s→0.74s）又会污染紧接着的采样；768² 全量仍更快（0.15s vs 分块 0.25s）。
    # 实测 tile=1024 最快。
    "vae_tile_size": 1024,
    "vae_tile_overlap": 64,
    "tiled_decode_threshold": 600000,
    # 输出 PNG 压缩档位：只影响编码耗时/文件体积，不影响画质。
    # 6 是 PIL 默认；1 在 2MP 图上编码快约 3.3 倍、文件大约 1.6 倍。
    "png_compress_level": 1,
    # 文本编码结果缓存条数：同提示词连抽多张时省掉一次 CLIP 前向（热态约 0.15s/张，
    # 带参考图的编辑再抽时还能省掉整段参考图 VAE 编码）。0 = 关闭。
    "encode_cache_size": 8,
}

#: Turbo 加速预设：用户只选方案，调度 / 加速 LoRA / 底模全部由预设决定。
#: kind = "lora" → 自动挂载 profile.lora_name（且只挂这一个加速 LoRA）；
#: kind = "ckpt" → 自动把扩散模型换成 unet 指向的 Turbo 权重，不挂加速 LoRA。
TURBO_PROFILES: list[dict[str, Any]] = [
    {
        "id": "turbo8_official",
        "label": "官方 Turbo 8 步（自动挂 Turbo LoRA）",
        "kind": "lora",
        "sigmas": TURBO_SIGMAS + [0.0],
        "steps": 8,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "lora": True,
        "lora_name": "loras/qwen2.1加速/qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors",
        "strength": 1.0,
        "unet": None,
        "note": "使用官方 8 步 sigma 调度，并自动挂载 8 步加速 LoRA。",
    },
    {
        "id": "turbo9_official",
        "label": "Turbo 9 步（自定义调度 + Turbo LoRA）",
        "kind": "lora",
        "sigmas": TURBO_SIGMAS_9 + [0.0],
        "steps": 9,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "lora": True,
        "lora_name": "loras/qwen2.1加速/qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors",
        "strength": 1.0,
        "unet": None,
        "note": "官方 8 步调度末尾补 0.15 低噪台阶；图片精修开启 Turbo 时默认使用。",
    },
    {
        "id": "turbo8_ckpt",
        "label": "官方 Turbo 8 步（自动切换 Turbo 底模）",
        "kind": "ckpt",
        "sigmas": TURBO_SIGMAS + [0.0],
        "steps": 8,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "lora": False,
        "lora_name": None,
        "strength": 1.0,
        "unet": TURBO_CKPT_UNET,
        "note": "自动把底模换成仓库里的 Turbo 权重，不加载加速 LoRA。",
    },
    {
        "id": "turbo9_ckpt",
        "label": "Turbo 9 步（自定义调度 + Turbo 底模）",
        "kind": "ckpt",
        "sigmas": TURBO_SIGMAS_9 + [0.0],
        "steps": 9,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "lora": False,
        "lora_name": None,
        "strength": 1.0,
        "unet": TURBO_CKPT_UNET,
        "note": "9 步自定义调度 + Turbo 底模，不加载加速 LoRA。",
    },
    {
        "id": "turbo6_viggle",
        "label": "viggle turbo 6 步（自动挂 6 步 LoRA）",
        "kind": "lora",
        "sigmas": [1.0, 0.9735, 0.9326, 0.8587, 0.7484, 0.5652, 0.0],
        "steps": 6,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "lora": True,
        "lora_name": "loras/Qwen-功能2.1/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors",
        "strength": 1.0,
        "unet": None,
        "note": "6 步 sigma 必须配合 viggle 6 步加速 LoRA，开启后自动挂载。",
    },
]

#: 用于「加速 LoRA」下拉框的筛选：文件名同时命中这些关键词才算候选
_TURBO_LORA_DIR_KEYWORDS = ("qwen", "qwen21", "qwenimage")
_TURBO_LORA_NAME_KEYWORDS = ("turbo", "step", "lightning", "lcm", "accel")
#: 明显属于 Qwen-Image 1.x 的加速 LoRA，列出来但标注不兼容
_TURBO_LORA_INCOMPATIBLE = ("qwen-image-lightning", "lightning-8steps-v1")

STEPS_PRESETS: list[dict[str, Any]] = [
    {"id": "draft", "label": "草稿 15 步", "steps": 15, "cfg": 1.0, "note": "快速试构图"},
    {"id": "standard", "label": "标准 25 步", "steps": 25, "cfg": 1.0, "note": "官方模板默认"},
    {"id": "official", "label": "官方 40 步", "steps": 40, "cfg": 1.0, "note": "README 默认值，细节更好"},
    {"id": "text", "label": "文字密集 50 步", "steps": 50, "cfg": 1.0, "note": "画面里字多时用"},
]

#: 任务 LoRA 预设：前端发 ``loras: [{"preset": "remove"}]``，后端解析成具体文件。
#: 与 ``DEFAULTS["consistency_lora"]`` 相互独立——这里是图片精修（studio）的工作台
#: 预设，不改文生图的默认一致性 LoRA。
LORA_TASKS: dict[str, dict[str, Any]] = {
    "consistency": {
        "id": "consistency",
        "label": "一致性（GH 无偏移）",
        "name": "loras/Qwen-功能2.1/Qwen2.1 一致性无偏移_GH_V1.0.safetensors",
        "strength": 0.48,
    },
    "remove": {
        "id": "remove",
        "label": "万物移除（GH）",
        "name": "loras/Qwen-功能2.1/Qwen2.1_万物移除Remove_GH.safetensors",
        "strength": 1.0,
    },
    "outpaint": {
        "id": "outpaint",
        "label": "扩图（GH）",
        "name": "loras/Qwen-功能2.1/Qwen2.1_扩图_GH_3750.safetensors",
        "strength": 0.7,
    },
}


def resolve_lora_preset(preset: str | None) -> dict[str, Any] | None:
    """把任务 LoRA 预设 id 解析成 ``{id,label,name,strength}``；未知返回 ``None``。"""
    key = str(preset or "").strip().lower()
    return LORA_TASKS.get(key)


def lora_presets_public() -> list[dict[str, Any]]:
    """给 ``/api/options`` 用的白名单视图（不含文件绝对路径）。"""
    return [
        {"id": item["id"], "label": item["label"], "strength": item["strength"]}
        for item in LORA_TASKS.values()
    ]


_ENV_MAP = {
    "Q2I_COMFY_ROOT": "comfy_root",
    "Q2I_MODEL_ROOT": "model_root",
    "Q2I_OLLAMA_URL": "ollama_url",
    "Q2I_PORT": "port",
    "Q2I_HOST": "host",
}


# --------------------------------------------------------------------------- 加载


def ensure_dirs() -> None:
    """创建运行期需要的所有目录。"""
    for d in (STORAGE_DIR, UPLOAD_DIR, OUTPUT_DIR, THUMB_DIR, EDITOR_DIR):
        os.makedirs(d, exist_ok=True)


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


_cache: dict[str, Any] | None = None


def load_config(path: str | None = None, *, refresh: bool = False) -> dict[str, Any]:
    """读取配置（带缓存）。环境变量优先。"""
    global _cache
    if _cache is not None and not refresh:
        return _cache

    cfg = json.loads(json.dumps(DEFAULTS))  # 深拷贝
    target = path or CONFIG_PATH
    if os.path.isfile(target):
        try:
            with open(target, "r", encoding="utf-8") as fh:
                cfg = _deep_merge(cfg, json.load(fh))
        except (OSError, json.JSONDecodeError):
            pass  # 配置写坏时退回默认值，不阻塞启动

    for env_key, cfg_key in _ENV_MAP.items():
        raw = os.environ.get(env_key)
        if raw:
            if cfg_key == "port":
                try:
                    cfg[cfg_key] = int(raw)
                except ValueError:
                    continue
            else:
                cfg[cfg_key] = raw

    if not cfg.get("model_root"):
        cfg["model_root"] = os.path.join(cfg["comfy_root"], "models")
    if not cfg.get("engine_dir"):
        cfg["engine_dir"] = os.path.join(ROOT, "engine")
    _cache = cfg
    return cfg


def save_config(cfg: dict[str, Any], path: str | None = None) -> str:
    """把当前配置写回 config.json（保留用户手改的其他字段）。"""
    target = path or CONFIG_PATH
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return target


def reload_config() -> dict[str, Any]:
    return load_config(refresh=True)


# --------------------------------------------------------------------------- 尺寸


def snap32(value: float, multiple: int = 32) -> int:
    """对齐到 multiple 的最近倍数（至少一个 multiple）。"""
    multiple = max(1, int(multiple))
    return max(multiple, int(round(float(value) / multiple)) * multiple)


def ratio_size(ratio_id: str, megapixels: float | None = None,
               multiple: int = 32) -> tuple[int, int]:
    """按比例与目标总像素计算画布尺寸（宽高均为 multiple 的倍数）。

    megapixels 语义与官方一致：1MP = 1024×1024 面积。省略时用该比例的官方尺寸。
    """
    preset = next((r for r in RATIOS if r["id"] == ratio_id), None)
    if preset is None:
        raise ValueError(f"未知比例：{ratio_id}")
    if megapixels is None:
        return snap32(preset["w"], multiple), snap32(preset["h"], multiple)
    try:
        a, b = ratio_id.split(":")
        rw, rh = float(a), float(b)
    except (ValueError, AttributeError):
        rw, rh = 1.0, 1.0
    total = float(megapixels) * 1024.0 * 1024.0
    width = (total * rw / rh) ** 0.5
    height = width * rh / rw
    return snap32(width, multiple), snap32(height, multiple)


# --------------------------------------------------------------------------- 模型


def _iter_model_files(root: str, dirs: list[str]) -> list[str]:
    """在若干候选子目录下递归找 safetensors（返回相对 model_root 的 posix 路径）。"""
    found: list[str] = []
    for sub in dirs:
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in sorted(filenames):
                if not name.lower().endswith((".safetensors", ".sft", ".ckpt", ".pt")):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, name), root)
                found.append(rel.replace("\\", "/"))
    return sorted(dict.fromkeys(found))


def scan_models(cfg: dict[str, Any] | None = None) -> dict[str, list[dict[str, Any]]]:
    """扫描 model_root，返回 {unet|clip|vae|lora: [{value,label,size_gb}]}。"""
    cfg = cfg or load_config()
    root = cfg["model_root"]
    out: dict[str, list[dict[str, Any]]] = {}
    for kind, dirs in cfg["model_dirs"].items():
        items = []
        for rel in _iter_model_files(root, dirs):
            ap = os.path.join(root, rel)
            try:
                size_gb = round(os.path.getsize(ap) / (1024 ** 3), 2)
            except OSError:
                size_gb = None
            items.append({"value": rel, "label": rel, "size_gb": size_gb})
        out[kind] = items
    return out


def resolve_model(cfg: dict[str, Any], kind: str, value: str | None) -> str | None:
    """把相对路径解析成绝对路径；容错省略子目录前缀（如只写 `QwenImage2.1/x.safetensors`）。"""
    if not value:
        return None
    if os.path.isabs(value):
        return value if os.path.isfile(value) else None
    root = cfg["model_root"]
    rel = value.replace("/", os.sep)
    direct = os.path.join(root, rel)
    if os.path.isfile(direct):
        return direct
    for sub in cfg["model_dirs"].get(kind, []):
        candidate = os.path.join(root, sub, rel)
        if os.path.isfile(candidate):
            return candidate
    return None


def default_model_paths(cfg: dict[str, Any] | None = None) -> dict[str, str | None]:
    cfg = cfg or load_config()
    return {
        "unet": resolve_model(cfg, "unet", cfg.get("unet")),
        "clip": resolve_model(cfg, "clip", cfg.get("clip")),
        "vae": resolve_model(cfg, "vae", cfg.get("vae")),
        "turbo_lora": resolve_model(cfg, "lora", cfg.get("turbo_lora")),
        "consistency_lora": resolve_model(cfg, "lora", cfg.get("consistency_lora")),
    }


def turbo_profile(profile_id: str | None) -> dict[str, Any]:
    if not profile_id:
        profile_id = DEFAULTS["turbo_profile"]
    for p in TURBO_PROFILES:
        if p["id"] == profile_id:
            return json.loads(json.dumps(p))
    return json.loads(json.dumps(TURBO_PROFILES[0]))


def turbo_lora_candidates(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """扫描 loras 目录，挑出「Qwen 系 + 加速/步数」的 LoRA，供界面下拉选择。

    排序：兼容的小体积优先（显存/内存压力小），并把 config 里默认的那个标 `default`。
    """
    cfg = cfg or load_config()
    root = cfg["model_root"]
    default_name = (cfg.get("turbo_lora") or "").replace("\\", "/")
    items: list[dict[str, Any]] = []
    for rel in _iter_model_files(root, cfg["model_dirs"].get("lora", [])):
        low = rel.lower()
        filename = low.rsplit("/", 1)[-1]
        if not any(k in low for k in _TURBO_LORA_DIR_KEYWORDS):
            continue
        if not any(k in filename for k in _TURBO_LORA_NAME_KEYWORDS):
            continue
        path = os.path.join(root, rel.replace("/", os.sep))
        try:
            size_gb = round(os.path.getsize(path) / (1024 ** 3), 2)
        except OSError:
            size_gb = None
        items.append({
            "value": rel,
            "label": rel.rsplit("/", 1)[-1],
            "dir": rel.rsplit("/", 2)[0] if "/" in rel else "",
            "size_gb": size_gb,
            "compatible": not any(k in filename for k in _TURBO_LORA_INCOMPATIBLE),
            "default": rel == default_name,
        })
    items.sort(key=lambda it: (
        not it["compatible"],
        it["size_gb"] if it["size_gb"] is not None else 999.0,
        it["label"],
    ))
    return items


def turbo_plan(cfg: dict[str, Any] | None = None,
               profile_id: str | None = None) -> dict[str, Any]:
    """把 Turbo 预设解析成可直接执行的计划（采样参数 + 加速 LoRA / 底模）。

    预设是唯一权威：调用方不需要（也不应该）再让用户改 sigma、LoRA 或强度。
    """
    cfg = cfg or load_config()
    profile = turbo_profile(profile_id)
    kind = str(profile.get("kind") or ("lora" if profile.get("lora") else "none"))

    lora = None
    if profile.get("lora") and profile.get("lora_name"):
        name = str(profile["lora_name"])
        path = resolve_model(cfg, "lora", name)
        lora = {
            "name": name,
            "path": path,
            "file": name.replace("\\", "/").rsplit("/", 1)[-1],
            "strength": float(profile.get("strength") or 1.0),
            "missing": path is None,
        }

    unet = None
    unet_name = profile.get("unet")
    if kind == "ckpt":
        unet_name = cfg.get("turbo_unet") or unet_name
    if unet_name:
        name = str(unet_name)
        path = resolve_model(cfg, "unet", name)
        unet = {
            "name": name,
            "path": path,
            "file": name.replace("\\", "/").rsplit("/", 1)[-1],
            "missing": path is None,
        }

    return {
        "id": profile["id"],
        "label": profile["label"],
        "kind": kind,
        "sigmas": [float(v) for v in profile["sigmas"]],
        "steps": int(profile["steps"]),
        "cfg": float(profile["cfg"]),
        "sampler": str(profile["sampler"]),
        "scheduler": str(profile["scheduler"]),
        "lora": lora,
        "unet": unet,
        "note": profile.get("note") or "",
    }


def turbo_profiles_public(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """供 /api/options 的 Turbo 预设列表（只给文件名与缺失标记，不暴露绝对路径）。"""
    cfg = cfg or load_config()
    out: list[dict[str, Any]] = []
    for profile in TURBO_PROFILES:
        plan = turbo_plan(cfg, profile["id"])
        out.append({
            key: plan[key]
            for key in ("id", "label", "kind", "sigmas", "steps", "cfg",
                        "sampler", "scheduler", "note")
        } | {
            "lora": ({k: plan["lora"][k] for k in ("name", "file", "strength", "missing")}
                     if plan["lora"] else None),
            "unet": ({k: plan["unet"][k] for k in ("name", "file", "missing")}
                     if plan["unet"] else None),
        })
    return out


def is_accel_lora(value: str | None) -> bool:
    """判断一个 LoRA 路径/文件名是否属于「加速 LoRA」（用于保证同时只挂一个）。"""
    if not value:
        return False
    low = str(value).replace("\\", "/").lower()
    filename = low.rsplit("/", 1)[-1]
    return any(k in filename for k in _TURBO_LORA_NAME_KEYWORDS)


def pick_turbo_lora(cfg: dict[str, Any], profile: dict[str, Any] | None,
                    requested: Any = None, strength: Any = None) -> dict[str, Any]:
    """决定 Turbo 模式挂哪个加速 LoRA（纯函数，便于测试）。

    requested 语义：
        None  → 用档位默认（profile.lora_name，回落 config.turbo_lora）
        ""/"none"/"off"/"no"/"0"/false → 不挂
        其他字符串 → 按相对路径或绝对路径解析

    返回 {"name","path","strength","reason","missing"}；path 为 None 且 requested 有值时
    由上层（pipeline）报错，避免悄悄换成别的 LoRA。
    """
    profile = profile or {}
    try:
        strength_value = float(strength if strength is not None else (profile.get("strength") or 1.0))
    except (TypeError, ValueError):
        strength_value = 1.0

    if isinstance(requested, str) and requested.strip().lower() in ("", "none", "off", "no", "0", "false"):
        return {"name": None, "path": None, "strength": strength_value,
                "reason": "选择不挂加速 LoRA", "missing": False}

    if requested:
        path = resolve_model(cfg, "lora", str(requested))
        return {"name": str(requested), "path": path, "strength": strength_value,
                "reason": "用户指定", "missing": path is None}

    if not profile.get("lora"):
        return {"name": None, "path": None, "strength": strength_value,
                "reason": "该档位本身不需要 LoRA", "missing": False}

    name = profile.get("lora_name") or cfg.get("turbo_lora")
    path = resolve_model(cfg, "lora", name) if name else None
    return {"name": name, "path": path, "strength": strength_value,
            "reason": "档位默认", "missing": path is None}


def find_engine_dir(cfg: dict[str, Any] | None = None) -> str | None:
    """返回可用的引擎目录（项目内 engine/，要求含 comfy/sd.py）。"""
    cfg = cfg or load_config()
    candidates = [cfg.get("engine_dir"), os.path.join(ROOT, "engine")]
    for candidate in candidates:
        if not candidate:
            continue
        resolved = candidate if os.path.isabs(candidate) else os.path.join(ROOT, candidate)
        if os.path.isfile(os.path.join(resolved, "comfy", "sd.py")):
            return os.path.abspath(resolved)
    return None


def find_comfy_root(cfg: dict[str, Any] | None = None) -> str | None:
    """返回 ComfyUI 根目录——**仅用于重新移植引擎/推断权重目录**，运行期不读其代码。"""
    cfg = cfg or load_config()
    for candidate in (cfg.get("comfy_root"), DEFAULT_COMFY_ROOT):
        if candidate and os.path.isfile(os.path.join(candidate, "comfy", "sd.py")):
            return candidate
    return None


def disk_usage() -> dict[str, Any]:
    """storage 目录占用情况，用于 /api/health。"""
    total = files = 0
    for dirpath, _d, filenames in os.walk(STORAGE_DIR):
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
                files += 1
            except OSError:
                pass
    try:
        free = shutil.disk_usage(STORAGE_DIR).free
    except OSError:
        free = 0
    return {"files": files, "size_mb": round(total / (1024 ** 2), 1),
            "free_gb": round(free / (1024 ** 3), 1)}
