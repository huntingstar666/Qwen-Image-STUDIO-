"""image-style-kit 的 Python 侧：目录加载 + 提示词合成。

复刻 ``web/vendor/image-style-kit/src/`` 里的纯逻辑（``buildNodePrompt``）：

    创意前缀 → 正文 → 创意后缀 → MJ 参数归并（normalizeMidjourneyPrompt）
    → 视角提示词（imageAnglePrompt）

与前端 ES module 完全同源、同序，因此前端直接用 vendor 里的 JS 合成、
后端用这里的 Python 合成，二者结果一致。视角提示词文案逐字照抄
``src/imageAngle.js``（中文原文），改动请同步两处。

契约见 ``docs/BUILD_CONTRACT.md`` 第 2.4 节。
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

#: vendor 目录（由本项目的静态托管直接暴露为 /vendor/image-style-kit/）。
VENDOR_DIR = Path(__file__).resolve().parent.parent / "web" / "vendor" / "image-style-kit"
DEFAULT_DATA_DIR = VENDOR_DIR / "data"

CREATIVE_KINDS = ("style", "motion", "filter")
CREATIVE_SLOTS = ("style", "motion", "filter", "custom")

#: 与 imageAngle.js 的 angleDirections 完全一致（顺序即语义）。
ANGLE_DIRECTIONS = ("正面", "右前侧", "右侧", "右后侧", "背面", "左后侧", "左侧", "左前侧")

#: 与 mjStyles.js 的 mjCategoryGroups 完全一致。
MJ_CATEGORY_GROUPS: tuple[dict, ...] = (
    {
        "name": "东方古风",
        "categories": [
            "东方古风·武侠",
            "东方神话·仙侠奇观",
            "东方古装·史诗",
            "古风室内·殿堂楼阁",
            "古镇村落·俯瞰",
            "仙侠天宫·奇观",
            "古建·祠庙宫殿",
        ],
    },
    {
        "name": "现代影像",
        "categories": [
            "现代都市·电影人文",
            "现代写实人像·生活流",
            "时尚编辑·商业广告",
            "日韩系·影像",
            "现代都市·街景",
            "现代室内·生活空间",
        ],
    },
    {
        "name": "科幻幻想",
        "categories": [
            "科幻·机甲",
            "游戏CG·动漫角色",
            "东方赛博·武侠朋克",
            "西方奇幻·神话史诗",
            "科幻·未来场景",
            "西幻·城堡秘境",
        ],
    },
    {"name": "自然氛围", "categories": ["自然奇观·山水云海", "光影空镜·氛围", "风格化与实验"]},
    {"name": "暗黑废墟", "categories": ["国风暗黑·志怪恐怖", "废墟·古代战场", "废墟末世·战场", "暗黑异兽·克苏鲁"]},
    {
        "name": "巨物传说",
        "categories": [
            "巨物·尺度压迫",
            "巨型机甲·超级机器人",
            "怪兽特摄·哥斯拉系",
            "超尺度奇观·巨物崇拜",
            "东方神龙·仙兽",
            "西方巨龙·翼兽",
            "深海巨兽·海怪",
            "上古神祇·泰坦巨人",
        ],
    },
)

#: 与 mjStyles.js 的 MJ_INSERT_MODES 完全一致。
MJ_INSERT_MODES: tuple[tuple[str, str], ...] = (
    ("style", "风格码"),
    ("parameters", "参数"),
    ("full", "完整提示词"),
    ("vibe", "氛围描述"),
)

MJ_FLAG_RE = re.compile(r"(?:^|\s)--([a-z][a-z-]*)(?=\s|$)", re.IGNORECASE)
PREVIEW_FLAG_RE = re.compile(r"(?:^|\s)--preview(?=\s|$)", re.IGNORECASE)
RATIO_RE = re.compile(r"^\d{1,3}\s*:\s*\d{1,3}$")


# --------------------------------------------------------------------------- 工具
def _finite_number(value: Any) -> float | None:
    """只有真正的 number 才算数（排除 bool / 数字字符串，与 JS typeof 对齐）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return float(value)


def _js_round(value: float) -> int:
    """JS ``Math.round``：.5 向 +∞ 取整（Python round 是银行家舍入，不能直接用）。"""
    return int(math.floor(value + 0.5))


def _as_text(value: Any) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


# --------------------------------------------------------------------------- 视角
def normalize_image_angle(value: Any) -> dict:
    """与 imageAngle.js ``normalizeImageAngle`` 等价。"""
    data = value if isinstance(value, Mapping) else {}
    azimuth = _finite_number(data.get("azimuth"))
    elevation = _finite_number(data.get("elevation"))
    zoom = _finite_number(data.get("zoom"))
    azimuth = ((_js_round(azimuth if azimuth is not None else 0) % 360) + 360) % 360
    elevation = max(-30, min(60, _js_round(elevation if elevation is not None else 0)))
    zoom = max(0.0, min(10.0, _js_round((zoom if zoom is not None else 5) * 10) / 10))
    return {"azimuth": azimuth, "elevation": elevation, "zoom": zoom}


def image_angle_description(value: Any) -> dict:
    """与 imageAngle.js ``imageAngleDescription`` 等价。"""
    angle = normalize_image_angle(value)
    direction = ANGLE_DIRECTIONS[int(math.floor((angle["azimuth"] + 22.5) / 45)) % 8]
    elevation = angle["elevation"]
    if elevation < -15:
        elevation_text = "低机位仰视"
    elif elevation < 15:
        elevation_text = "平视"
    elif elevation < 45:
        elevation_text = "抬高机位俯视"
    else:
        elevation_text = "高机位俯拍"
    zoom = angle["zoom"]
    distance = "远景" if zoom < 2 else ("中景" if zoom < 6 else "近景")
    return {"direction": direction, "elevation": elevation_text, "distance": distance}


def angle_prompt(image_angle: Any) -> str:
    """与 imageAngle.js ``imageAnglePrompt`` 等价；未设置视角时返回空串。"""
    if not isinstance(image_angle, Mapping):
        return ""
    if any(_finite_number(image_angle.get(key)) is None for key in ("azimuth", "elevation", "zoom")):
        return ""
    angle = normalize_image_angle(image_angle)
    description = image_angle_description(angle)
    return (
        f"根据参考图片重新呈现同一个主体，目标视角为主体的{description['direction']}，"
        f"{description['elevation']}，{description['distance']}构图。\n"
        f"精确相机参数：水平环绕 {angle['azimuth']}°（0°正面、90°主体右侧、180°背面、270°主体左侧），"
        f"俯仰 {angle['elevation']}°（正值抬高机位向下看、负值降低机位向上看），"
        f"取景靠近程度 {angle['zoom']:.1f}/10（0为远景、5为中景、10为特写）。"
        "按连续数值调整，不要量化为固定预设。\n"
        "只改变相机观察方向、高度和取景距离；保持主体身份、面部特征、服饰、道具、材质和画面风格一致。"
        "依据原图合理补全新视角可见的结构。不要用平面旋转、镜像或拉伸原图代替视角变化，"
        "不添加多视图拼版、文字或重复主体。以本段目标视角为准，其他内容要求保持不变。"
    )


def angle_prompt_from_query(azimuth: Any = None, elevation: Any = None, zoom: Any = None) -> str:
    """给 ``GET /api/styles/angle-prompt`` 用的宽松入口。

    HTTP query 参数都是字符串，而 :func:`angle_prompt` 与 JS 一样严格要求 number
    （字符串会被视为无效、返回空串）。这里先转 float：空串/None 用默认值
    （azimuth=0, elevation=0, zoom=5）；三个参数全缺省时返回空串表示"不启用视角"。
    """
    if azimuth is None and elevation is None and zoom is None:
        return ""

    def _number(raw: Any, default: float) -> float:
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            return default
        try:
            return float(raw)
        except (TypeError, ValueError):
            return default

    return angle_prompt(
        {
            "azimuth": _number(azimuth, 0),
            "elevation": _number(elevation, 0),
            "zoom": _number(zoom, 5),
        }
    )


# --------------------------------------------------------------------------- MJ 参数
def normalize_mj_prompt(text: Any) -> str:
    """与 mjPrompt.js ``normalizeMidjourneyPrompt`` 等价。

    - 把所有 ``--flag value`` 参数块归并到末尾，参数块之前的正文保留在上方；
    - ``--preview`` 是本地预览专用标记，直接丢弃；
    - ``--p`` / ``--personalize`` 统一成 ``--profile``，且 ``--sref`` / ``--profile``
      支持叠加（去重合并），其余标量参数以最后一次显式选择为准。
    """
    source = _as_text(text)
    flags = list(MJ_FLAG_RE.finditer(source))
    if not flags:
        return source.strip()

    parameters: dict[str, str] = {}
    for index, flag in enumerate(flags):
        name = flag.group(1).lower()
        if name == "preview":
            continue
        if name in ("p", "personalize"):
            name = "profile"
        value_start = flag.start() + len(flag.group(0))
        value_end = flags[index + 1].start() if index + 1 < len(flags) else len(source)
        value = source[value_start:value_end].strip()
        if name in ("sref", "profile"):
            merged = f"{parameters.get(name, '')} {value}".split()
            parameters[name] = " ".join(dict.fromkeys(word for word in merged if word))
        else:
            parameters[name] = value

    suffix = " ".join(f"--{name}{f' {value}' if value else ''}" for name, value in parameters.items())
    head = source[: flags[0].start()].strip()
    return "\n".join(part for part in (head, suffix) if part)


def remove_mj_preview(text: Any) -> str:
    """与 mjPrompt.js ``removeMidjourneyPreview`` 等价。"""
    return PREVIEW_FLAG_RE.sub("", _as_text(text)).strip()


def mj_style_text(item: Mapping, mode: str) -> str:
    """与 mjStyles.js ``mjStyleText`` 等价：按插入模式取文本。"""
    mode = str(mode or "style").lower()
    if mode == "full":
        text = _as_text(item.get("prompt"))
    elif mode == "vibe":
        text = _as_text(item.get("vibe"))
    else:
        parts = [
            _as_text(item.get("vibe")),
            _as_text(item.get("parameters" if mode == "parameters" else "codes")),
        ]
        text = "\n".join(part for part in parts if part)
    return remove_mj_preview(text)


# --------------------------------------------------------------------------- 创意预设
def valid_creative_preset(value: Any) -> bool:
    """与 creative.js ``validCreativePreset`` 等价。"""
    if not isinstance(value, Mapping):
        return False
    preset_id = value.get("id")
    kind = value.get("kind")
    name = value.get("name")
    prompt = value.get("prompt")
    prefix = value.get("prefix")
    return (
        isinstance(preset_id, str)
        and len(preset_id) <= 100
        and isinstance(kind, str)
        and kind in CREATIVE_KINDS
        and isinstance(name, str)
        and 0 < len(name) <= 80
        and isinstance(prompt, str)
        and len(prompt) <= 12000
        and (
            prefix is None
            or (isinstance(prefix, str) and len(prefix) <= 12000)
        )
    )


def _clean_preset(value: Mapping) -> dict:
    preset = {
        "id": value["id"],
        "kind": value["kind"],
        "category": _as_text(value.get("category")),
        "name": value["name"],
        "description": _as_text(value.get("description")),
        "prompt": value["prompt"],
    }
    prefix = value.get("prefix")
    if isinstance(prefix, str) and prefix:
        preset["prefix"] = prefix
    for key in ("preview", "poster"):
        if isinstance(value.get(key), str) and value[key]:
            preset[key] = value[key]
    return preset


def slots_of(presets: Any) -> dict:
    """把 ``presets`` 规整成 ``{slot: preset}``。

    接受两种输入，方便前端/后端互传：

    * ``{"style": {...}, "filter": {...}, ...}``：节点上的 ``creativePresets`` 快照；
    * ``[{kind: "style", ...}, ...]``：风格库选中的标签列表，按 ``kind`` 落槽，
      ``kind`` 不是 style/motion/filter 的落 ``custom`` 槽。
    """
    if not presets:
        return {}
    selection: dict[str, dict] = {}
    if isinstance(presets, Mapping):
        for slot in CREATIVE_SLOTS:
            preset = presets.get(slot)
            if valid_creative_preset(preset):
                selection[slot] = _clean_preset(preset)
        return selection
    if isinstance(presets, (str, bytes)):
        return {}
    if not isinstance(presets, Iterable):
        return {}
    for preset in presets:
        if not valid_creative_preset(preset):
            continue
        kind = preset["kind"]
        slot = kind if kind in ("style", "motion", "filter") else "custom"
        selection[slot] = _clean_preset(preset)
    return selection


def validate_presets(presets: Any) -> list[dict]:
    """过滤非法预设，返回可直接入库/下发前端的干净列表（按 id 去重）。"""
    if not presets:
        return []
    if isinstance(presets, Mapping):
        raw: Iterable[Any] = [presets.get(slot) for slot in CREATIVE_SLOTS]
    elif isinstance(presets, (str, bytes)):
        return []
    elif not isinstance(presets, Iterable):
        return []
    else:
        raw = presets
    result: list[dict] = []
    seen: set[str] = set()
    for preset in raw:
        if not valid_creative_preset(preset):
            continue
        if preset["id"] in seen:
            continue
        seen.add(preset["id"])
        result.append(_clean_preset(preset))
    return result


def compose_creative_prompt(prompt: Any, presets: Any, node_type: str = "Image") -> str:
    """与 creative.js ``composeCreativePrompt`` 等价。

    顺序：创意前缀（style → filter → [motion] → custom）→ 正文 → 创意后缀（同序）。
    图片节点只用 style/filter/custom，视频节点额外叠加 motion，其它类型原样返回。
    """
    text = _as_text(prompt)
    node_kind = _as_text(node_type).lower()
    if node_kind not in ("image", "video"):
        return prompt if isinstance(prompt, str) else text
    selected = slots_of(presets)
    slots = ["style", "filter"] + (["motion"] if node_kind == "video" else []) + ["custom"]
    entries = [selected[slot] for slot in slots if slot in selected]
    parts = [entry.get("prefix", "").strip() for entry in entries]
    parts.append(text)
    parts.extend(entry["prompt"].strip() for entry in entries)
    return "\n".join(part for part in parts if part)


def compose_prompt(
    prompt: str,
    *,
    presets: list[dict] | dict | None = None,
    image_angle: dict | None = None,
    node_type: str = "Image",
) -> str:
    """与 ``buildNodePrompt`` 等价：创意前缀 → 正文 → 创意后缀 → MJ 归并 → 视角。"""
    composed = compose_creative_prompt(prompt, presets, node_type)
    normalized = normalize_mj_prompt(composed)
    return "\n".join(part for part in (normalized, angle_prompt(image_angle)) if part)


# --------------------------------------------------------------------------- 目录
def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_catalogs(data_dir: str | Path | None = None) -> dict:
    """读取两份目录 JSON，返回 ``GET /api/styles`` 需要的结构。

    返回::

        {"creative": [...], "mj": [...], "mjGroups": [...],
         "insertModes": [{"key","label"}, ...], "count": {...}}

    ``count`` 里带 ``creative`` / ``mj`` / ``creativeKinds`` / ``mjCategories``
    等统计，前端可直接显示数量。
    """
    directory = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    creative_path = directory / "creativeCatalog.json"
    mj_path = directory / "mjStyleCatalog.json"

    creative_raw = _read_json(creative_path)
    mj_raw = _read_json(mj_path)
    if not isinstance(creative_raw, list):
        raise ValueError(f"{creative_path} 顶层应为数组")
    if not isinstance(mj_raw, list):
        raise ValueError(f"{mj_path} 顶层应为数组")

    creative = [
        _clean_preset(item) for item in creative_raw if valid_creative_preset(item)
    ]
    mj = [dict(item) for item in mj_raw if isinstance(item, Mapping)]

    creative_kinds: dict[str, int] = {kind: 0 for kind in CREATIVE_KINDS}
    for item in creative:
        creative_kinds[item["kind"]] = creative_kinds.get(item["kind"], 0) + 1

    mj_groups = [
        {"name": group["name"], "categories": list(group["categories"])}
        for group in MJ_CATEGORY_GROUPS
    ]
    insert_modes = [{"key": key, "label": label} for key, label in MJ_INSERT_MODES]

    mj_categories = sorted({_as_text(item.get("category")) for item in mj if item.get("category")})
    count = {
        "creative": len(creative),
        "creativeKinds": creative_kinds,
        "mj": len(mj),
        "mjGroups": len(mj_groups),
        "mjCategories": len(mj_categories),
        "insertModes": len(insert_modes),
    }

    return {
        "creative": creative,
        "mj": mj,
        "mjGroups": mj_groups,
        "insertModes": insert_modes,
        "count": count,
    }


__all__ = [
    "VENDOR_DIR",
    "DEFAULT_DATA_DIR",
    "CREATIVE_KINDS",
    "CREATIVE_SLOTS",
    "ANGLE_DIRECTIONS",
    "MJ_CATEGORY_GROUPS",
    "MJ_INSERT_MODES",
    "normalize_image_angle",
    "image_angle_description",
    "angle_prompt",
    "angle_prompt_from_query",
    "normalize_mj_prompt",
    "remove_mj_preview",
    "mj_style_text",
    "valid_creative_preset",
    "slots_of",
    "validate_presets",
    "compose_creative_prompt",
    "compose_prompt",
    "load_catalogs",
]
