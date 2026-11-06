"""提示词润色（Qwen-Image 官方 PE 系统提示词 + 本地 Ollama）。

契约见 ``docs/BUILD_CONTRACT.md`` 第 2.3 / 4.4 节：

* system message = ``data/pe_system_prompt_t2i.txt`` / ``pe_system_prompt_edit.txt``
  原文（逐字使用，不改写；文件只读）。
* 采样参数按官方：T2I ``temperature 1.0, top_p 0.95, top_k 20, min_p 0,
  presence_penalty 1.5, repetition_penalty 1.0``；编辑 ``presence_penalty 0``。
* 要求模型额外输出 JSON ``{"rewritten_prompt","wh_ratio","ratio_follow"}``
  （官方 PE 的 Output format 是纯文本，工作台在 user message 末尾追加一段
  输出约定并配合 Ollama ``format="json"`` 约束；解析仍做三级降级）。
* 解析降级：``json.loads`` → 花括号截取 → 整段文本。
* Ollama 不可用 / 超时 / 解析为空：不抛异常，``fallback=True`` 且返回原 prompt
  （``fallback=False`` 时才向上抛 ``OllamaError``）。非法 ``mode`` 一律 ``ValueError``。

Ollama 侧的实测要点（详见 docs/PROMPT_POLISH.md）：qwen3.5 系列默认会先输出
thinking，长思考会把 ``num_predict`` 吃光导致 content 为空，因此本模块调用
``/api/chat`` 时显式传 ``think=false``（Ollama >= 0.5 支持），并开
``format="json"`` 约束模型给出可解析的 JSON。
"""

from __future__ import annotations

import base64
import json
import re
import time
from pathlib import Path
from typing import Any

try:  # 正常情况：作为 server 包的一部分导入
    from .ollama import DEFAULT_BASE_URL, OllamaClient, OllamaError
except ImportError:  # 兜底：server/ 被直接加进 sys.path 时
    from ollama import DEFAULT_BASE_URL, OllamaClient, OllamaError  # type: ignore[no-redef]

#: 项目根目录（server/ 的上一级）。
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"

DEFAULT_T2I_MODEL = "qwen3.5:9b"
DEFAULT_EDIT_MODEL = "qwen3.5:9b"
DEFAULT_TIMEOUT = 300.0

SYSTEM_PROMPT_FILES = {
    "t2i": "pe_system_prompt_t2i.txt",
    "edit": "pe_system_prompt_edit.txt",
}

#: 每个图像模型自己的 PE 系统提示词（润色 LLM 必须按目标模型的写作规范输出）。
MODEL_SYSTEM_PROMPT_FILES: dict[str, dict[str, str]] = {
    "qwen": SYSTEM_PROMPT_FILES,
    # MOSS 的 PE 同时定义 Caption / Layout 两种输出模式，编辑模式也先复用这一份。
    "moss": {
        "t2i": "pe_system_prompt_moss_t2i.txt",
        "edit": "pe_system_prompt_moss_t2i.txt",
    },
}

IMAGE_MODEL_ALIASES = {
    "qwen21": "qwen",
    "qwen-image": "qwen",
    "qwen_image": "qwen",
    "qwen2.1": "qwen",
    "moss-image": "moss",
    "moss_image": "moss",
}

#: 官方 PE 采样参数（契约 4.4）。字段名即 Ollama /api/chat options 名。
T2I_SAMPLING: dict[str, float | int] = {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 20,
    "min_p": 0.0,
    "presence_penalty": 1.5,
    "repetition_penalty": 1.0,
    "num_predict": 2048,
}
EDIT_SAMPLING: dict[str, float | int] = {
    "temperature": 1.0,
    "top_p": 0.95,
    "top_k": 20,
    "min_p": 0.0,
    # 编辑模式官方要求 presence_penalty=0（T2I 是 1.5，别抄错）。
    "presence_penalty": 0.0,
    "repetition_penalty": 1.0,
    "num_predict": 2048,
}

#: 追加在 user message 末尾的输出约定（system 保持官方 PE 原文不动）。
JSON_OUTPUT_CONTRACT = (
    "---\n"
    "工作台输出约定（优先于上文 Output format）：请只输出一个 JSON 对象，"
    '形如 {"rewritten_prompt": "...", "wh_ratio": "...", "ratio_follow": "..."}。\n'
    "- rewritten_prompt：按上文规则写好的完整提示词本身（单段、连续，不要拆条、不要加引号包裹整段）。\n"
    '- wh_ratio：画面宽高比，如 "3:2"、"16:9"、"1:1"；判断不出时为空字符串。\n'
    '- ratio_follow：仅编辑模式使用；需要沿用某张参考图比例时填 "<image1>" 这类标记，否则为空字符串。\n'
    "不要输出 JSON 之外的任何文字、不要 markdown 代码块。"
)

RATIO_RE = re.compile(r"^\d{1,3}:\d{1,3}$")
RATIO_FOLLOW_RE = re.compile(r"^<image\d+>$")
CODE_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$")

#: MOSS PE 自己就要求「只输出纯 JSON」（Caption 或 Layout 两种形态），
#: 所以这里的约定只补画布尺寸与两种形态的最小骨架，不再要求 rewritten_prompt 字段。
MOSS_JSON_CONTRACT = (
    "---\n"
    "工作台输出约定（优先于上文 Hard Output Format Constraints）：只输出 JSON 本体，"
    "不要 markdown 代码块、不要任何解释文字。\n"
    '- 普通文生图：{"caption": "..."}（caption 为完整画面描述）。\n'
    "- 需要边界框 / 海报 / 分栏排版：输出上文 Layout 模式的完整对象"
    '（width / height / bbox_coord_space:"abs" / bbox_format:"xyxy" / summary / items）。\n'
    "{canvas_rule}"
    "所有可见文字必须逐字写出，不要用占位符。"
)

#: 视觉模型单张参考图的最长边（Ollama 官方建议 448 左右，过大会拖慢且无收益）
VISION_MAX_SIDE = 448


# --------------------------------------------------------------------------- 工具
def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return "" if value is None else str(value)


def normalize_mode(mode: Any) -> str:
    """校验并规整 mode；非法值抛 ``ValueError``（契约允许的唯一异常）。"""
    key = _as_text(mode).strip().lower()
    if key not in SYSTEM_PROMPT_FILES:
        raise ValueError(f"mode 必须是 't2i' 或 'edit'，收到 {mode!r}")
    return key


def normalize_image_model(image_model: Any) -> str:
    """规整目标图像模型名（决定用哪份 PE）；未知值退回 ``qwen``。"""
    key = _as_text(image_model).strip().lower()
    key = IMAGE_MODEL_ALIASES.get(key, key)
    return key if key in MODEL_SYSTEM_PROMPT_FILES else "qwen"


def _size_tuple(value: Any) -> tuple[int, int] | None:
    """把 ``(w, h)`` / ``{"width","height"}`` / ``"1920x1088"`` 统一成整数对。"""
    if value is None:
        return None
    try:
        if isinstance(value, dict):
            w, h = int(value.get("width")), int(value.get("height"))
        elif isinstance(value, str):
            match = re.match(r"^\s*(\d+)\s*[x×*]\s*(\d+)\s*$", value)
            if not match:
                return None
            w, h = int(match.group(1)), int(match.group(2))
        else:
            w, h = int(value[0]), int(value[1])
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    return (w, h) if w > 0 and h > 0 else None


def _context_block(target_size: Any, references: Any) -> str:
    """把「目标画布 + 参考图尺寸」写进 user message。

    润色 LLM 看不到图片本身时也能知道比例是否要沿用、参考图长什么样，
    避免它按训练数据的默认比例瞎猜（这是之前最容易出错的地方）。
    """
    lines: list[str] = []
    target = _size_tuple(target_size)
    if target:
        w, h = target
        lines.append(f"[目标画布] {w}×{h} px（宽高比约 {w / h:.3f}），生成结果将按这个尺寸输出。")
    refs = references or []
    if isinstance(refs, dict):
        refs = [refs]
    if refs and isinstance(refs, (list, tuple)):
        lines.append(f"[参考图] 共 {len(refs)} 张，顺序与 <image1>…<image{len(refs)}> 一致：")
        for index, ref in enumerate(refs, start=1):
            if isinstance(ref, dict):
                name = _as_text(ref.get("name")).strip() or f"image{index}"
                size = _size_tuple(ref.get("size") or ref)
                desc = _as_text(ref.get("description") or ref.get("desc")).strip()
            else:
                name = f"image{index}"
                size = None
                desc = _as_text(ref).strip()
            detail = f"{size[0]}×{size[1]} px" if size else "尺寸未知"
            if desc:
                detail += f"，内容：{desc}"
            lines.append(f"  <{name}>：{detail}")
        lines.append("参考图内容以随消息附上的图片为准；没有附图时不要臆造画面细节。")
    return "\n".join(lines)


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = CODE_FENCE_RE.sub("", stripped).strip()
    return stripped


def _try_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _clean_ratio(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    compact = value.strip().replace(" ", "")
    return compact if RATIO_RE.match(compact) else ""


def _clean_ratio_follow(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip() if RATIO_FOLLOW_RE.match(value.strip()) else ""


def _from_mapping(data: dict) -> dict:
    rewritten = ""
    for key in ("rewritten_prompt", "rewritten", "prompt", "text", "description"):
        candidate = data.get(key)
        if isinstance(candidate, str) and candidate.strip():
            rewritten = candidate.strip()
            break
    wh_ratio = ""
    for key in ("wh_ratio", "aspect_ratio", "ratio"):
        wh_ratio = _clean_ratio(data.get(key))
        if wh_ratio:
            break
    ratio_follow = ""
    for key in ("ratio_follow", "ratioFollow"):
        ratio_follow = _clean_ratio_follow(data.get(key))
        if ratio_follow:
            break
    return {"rewritten_prompt": rewritten, "wh_ratio": wh_ratio, "ratio_follow": ratio_follow}


# --------------------------------------------------------------------------- 系统提示词
def load_system_prompt(mode: str, image_model: Any = "qwen") -> str:
    """读取目标模型自己的 PE 系统提示词原文（UTF-8）。

    ``mode ∈ {"t2i","edit"}``；``image_model ∈ {"qwen","moss"}``（未知值退回 qwen）。
    """
    key = normalize_mode(mode)
    model_key = normalize_image_model(image_model)
    path = DATA_DIR / MODEL_SYSTEM_PROMPT_FILES[model_key][key]
    return path.read_text(encoding="utf-8")


def build_messages(prompt: str, mode: str = "t2i", *, image_model: Any = "qwen",
                   target_size: Any = None, references: Any = None) -> list[dict]:
    """构造 Ollama messages：目标模型 PE 原文作 system，用户请求 + 上下文 + JSON 约定作 user。

    ``target_size`` / ``references`` 只影响 user message 里的上下文块（不改变 system）。
    """
    key = normalize_mode(mode)
    model_key = normalize_image_model(image_model)
    text = _as_text(prompt).strip()
    system = load_system_prompt(key, model_key)
    if model_key == "moss":
        target = _size_tuple(target_size)
        rule = (f"画布固定为 {target[0]}×{target[1]} px；若输出 Layout，width/height 必须等于该值，"
                f"所有 bbox 必须落在 0..{target[0]} / 0..{target[1]} 内。\n" if target else "")
        contract = MOSS_JSON_CONTRACT.replace("{canvas_rule}", rule)
    else:
        contract = JSON_OUTPUT_CONTRACT
    context = _context_block(target_size, references)
    head = f"{context}\n\n" if context else ""
    user = f"{head}{text}\n\n{contract}" if text else f"{head}{contract}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# --------------------------------------------------------------------------- 解析
def _from_moss_mapping(data: dict) -> dict:
    """MOSS PE 的两种输出形态：``{"caption": ...}`` 或完整 Layout 对象。"""
    caption = data.get("caption")
    if isinstance(caption, str) and caption.strip():
        return {"rewritten_prompt": caption.strip(), "wh_ratio": "", "ratio_follow": ""}
    if (isinstance(data.get("items"), list)
            and ("bbox_coord_space" in data or "bbox_format" in data)):
        # Layout 模式：原样紧凑序列化后直接当提示词（MOSS 的 layout 节点吃的就是这个字符串）
        return {
            "rewritten_prompt": json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            "wh_ratio": "",
            "ratio_follow": "",
        }
    return _from_mapping(data)


def parse_polish_output(raw: Any, image_model: Any = "qwen") -> dict:
    """三级降级解析模型输出。

    返回 ``{"rewritten_prompt","wh_ratio","ratio_follow","parse"}``，
    ``parse`` ∈ ``{"json","braces","text"}`` 表示最终落在哪一级。

    ``image_model="moss"`` 时额外识别 MOSS PE 的 ``caption`` / Layout 两种输出。
    """
    text = _strip_code_fence(_as_text(raw))
    if not text:
        return {"rewritten_prompt": "", "wh_ratio": "", "ratio_follow": "", "parse": "text"}
    mapper = _from_moss_mapping if normalize_image_model(image_model) == "moss" else _from_mapping

    # 一级：整段就是 JSON（含被 model 包了一层 JSON 字符串的情况）。
    parsed = _try_json(text)
    if isinstance(parsed, dict):
        result = mapper(parsed)
        if result["rewritten_prompt"]:
            return {**result, "parse": "json"}
    elif isinstance(parsed, str) and parsed.strip():
        return {
            "rewritten_prompt": parsed.strip(),
            "wh_ratio": "",
            "ratio_follow": "",
            "parse": "json",
        }

    # 二级：截取首个 "{" 到末个 "}"。
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        parsed = _try_json(text[start : end + 1])
        if isinstance(parsed, dict):
            result = mapper(parsed)
            if result["rewritten_prompt"]:
                return {**result, "parse": "braces"}

    # 三级：整段文本当 rewritten_prompt（官方 PE 的原生输出格式）。
    return {
        "rewritten_prompt": text,
        "wh_ratio": "",
        "ratio_follow": "",
        "parse": "text",
    }


# --------------------------------------------------------------------------- 调用
def _call_model(
    client: OllamaClient,
    model: str,
    messages: list[dict],
    sampling: dict,
    *,
    json_mode: bool = True,
) -> str:
    """调 ``client.chat``；``think=false`` 抑制 qwen3.5 的思考段。

    兼容没有 ``think`` 参数的客户端实现：TypeError 时退一步重试。
    """
    kwargs = dict(sampling)
    if json_mode:
        kwargs["format"] = "json"
    try:
        return client.chat(model, messages, think=False, **kwargs)
    except TypeError:
        kwargs.pop("think", None)
        return client.chat(model, messages, **kwargs)


def _empty_timer() -> float:
    return time.perf_counter()


def _elapsed_ms(started: float) -> int:
    return max(0, int(round((time.perf_counter() - started) * 1000)))


def _client_supports_vision(client: Any, model: str) -> bool:
    checker = getattr(client, "supports_vision", None)
    if not callable(checker):
        return False
    try:
        return bool(checker(model))
    except Exception:  # noqa: BLE001 - 能力探测失败一律当不支持
        return False


def _image_b64(value: Any) -> str | None:
    """把 PIL 图压到 ``VISION_MAX_SIDE`` 内再转 base64（Ollama images 字段格式）。"""
    try:
        from io import BytesIO

        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow 是项目依赖
        return None
    image = value.get("image") if isinstance(value, dict) else value
    if not isinstance(image, Image.Image):
        return None
    image = image.convert("RGB")
    width, height = image.size
    scale = min(1.0, float(VISION_MAX_SIDE) / max(width, height))
    if scale < 1.0:
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))),
                             Image.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def polish(
    prompt: str,
    *,
    mode: str = "t2i",
    model: str | None = None,
    client: OllamaClient | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    fallback: bool = True,
    language: str | None = None,
    json_mode: bool = True,
    image_model: Any = "qwen",
    target_size: Any = None,
    references: Any = None,
    reference_images: Any = None,
) -> dict:
    """润色一条提示词。

    返回::

        {"rewritten_prompt": str, "wh_ratio": str, "ratio_follow": str,
         "model": str, "elapsed_ms": int, "fallback": bool, "raw": str,
         "mode": str, "parse": str, "error": str | None,
         "image_model": str, "vision": bool}

    ``image_model`` 决定用哪份 PE 系统提示词（qwen / moss）；``target_size`` 与
    ``references`` 会写进 user message，``reference_images``（PIL 图）在 Ollama 模型
    支持视觉时以 base64 附图形式一起发送。

    * Ollama 不可用 / 超时 / 任意调用异常：``fallback=True``，``rewritten_prompt``
      为原 prompt，``raw=""``（``fallback=False`` 时抛出 ``OllamaError``）。
    * 模型输出为空或解析不出正文：同样回退原 prompt，但保留 ``raw``。
    * 非法 ``mode``：``ValueError``（任何情况下都抛）。
    """
    mode_key = normalize_mode(mode)
    model_key = normalize_image_model(image_model)
    started = _empty_timer()
    text = _as_text(prompt).strip()
    resolved_model = _as_text(model).strip() or (
        DEFAULT_T2I_MODEL if mode_key == "t2i" else DEFAULT_EDIT_MODEL
    )
    vision_used = False

    def _result(
        rewritten: str,
        *,
        wh_ratio: str = "",
        ratio_follow: str = "",
        fallback_flag: bool,
        raw: str = "",
        parse: str = "text",
        error: str | None = None,
    ) -> dict:
        return {
            "rewritten_prompt": rewritten,
            "wh_ratio": wh_ratio,
            "ratio_follow": ratio_follow,
            "model": resolved_model,
            "elapsed_ms": _elapsed_ms(started),
            "fallback": bool(fallback_flag),
            "raw": raw,
            "mode": mode_key,
            "parse": parse,
            "error": error,
            "image_model": model_key,
            "vision": vision_used,
        }

    # 空提示词没有可润色的内容，也绝不发网络请求。
    if not text:
        return _result(text, fallback_flag=True, error="提示词为空")

    if client is None:
        client = OllamaClient(timeout=timeout)

    try:
        messages = build_messages(text, mode_key, image_model=model_key,
                                  target_size=target_size, references=references)
        if reference_images:
            encoded = [b64 for b64 in (_image_b64(item) for item in reference_images) if b64]
            if encoded and _client_supports_vision(client, resolved_model):
                messages[1]["images"] = encoded
                vision_used = True
            elif encoded:
                messages[1]["content"] = (
                    "[注意] 当前润色模型不支持读图，只能按参考图的尺寸与文字描述工作，"
                    "不要臆造画面细节。\n" + messages[1]["content"])
        sampling = T2I_SAMPLING if mode_key == "t2i" else EDIT_SAMPLING
        raw = _call_model(client, resolved_model, messages, sampling, json_mode=json_mode)
    except Exception as exc:  # noqa: BLE001 - 契约要求：除 mode 外都不抛异常
        if not fallback:
            if isinstance(exc, OllamaError):
                raise
            raise OllamaError(f"提示词润色失败：{exc}") from exc
        return _result(text, fallback_flag=True, error=str(exc))

    parsed = parse_polish_output(raw, model_key)
    if not parsed["rewritten_prompt"]:
        return _result(
            text,
            fallback_flag=True,
            raw=_as_text(raw),
            parse=parsed["parse"],
            error="模型没有返回可用的提示词",
        )
    # 契约 4.4：wh_ratio 只属于文生图（T2I PE 第 2 步），ratio_follow 只属于编辑；
    # 模型偶尔会跨模式多填，这里按模式收口，避免前端拿错字段。
    wh_ratio = parsed["wh_ratio"] if mode_key == "t2i" else ""
    ratio_follow = parsed["ratio_follow"] if mode_key == "edit" else ""
    return _result(
        parsed["rewritten_prompt"],
        wh_ratio=wh_ratio,
        ratio_follow=ratio_follow,
        fallback_flag=False,
        raw=_as_text(raw),
        parse=parsed["parse"],
    )


# --------------------------------------------------------------------------- 模型发现
def available_models(base_url: str = DEFAULT_BASE_URL, timeout: float = 10.0) -> list[str]:
    """当前 Ollama 已安装模型名列表；Ollama 不可用时返回 ``[]``（不抛异常）。"""
    try:
        return OllamaClient(base_url=base_url, timeout=timeout).model_names()
    except Exception:  # noqa: BLE001 - /api/health 轮询不能因为 Ollama 挂了而 500
        return []


def pick_default_model(preferred: str | None = None) -> str:
    """选默认模型：显式指定优先；否则优先 qwen3.5:9b，再退到任一 qwen 模型。"""
    choice = _as_text(preferred).strip()
    if choice:
        return choice
    models = available_models()
    if DEFAULT_T2I_MODEL in models:
        return DEFAULT_T2I_MODEL
    for name in models:
        lowered = name.lower()
        if "qwen3.5" in lowered or "qwen" in lowered:
            return name
    return DEFAULT_T2I_MODEL


__all__ = [
    "DEFAULT_T2I_MODEL",
    "DEFAULT_EDIT_MODEL",
    "DEFAULT_TIMEOUT",
    "SYSTEM_PROMPT_FILES",
    "MODEL_SYSTEM_PROMPT_FILES",
    "T2I_SAMPLING",
    "EDIT_SAMPLING",
    "JSON_OUTPUT_CONTRACT",
    "MOSS_JSON_CONTRACT",
    "normalize_mode",
    "normalize_image_model",
    "load_system_prompt",
    "build_messages",
    "parse_polish_output",
    "polish",
    "available_models",
    "pick_default_model",
]
