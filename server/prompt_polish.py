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
def load_system_prompt(mode: str) -> str:
    """读取官方 PE 系统提示词原文（UTF-8）。``mode ∈ {"t2i","edit"}``。"""
    key = normalize_mode(mode)
    path = DATA_DIR / SYSTEM_PROMPT_FILES[key]
    return path.read_text(encoding="utf-8")


def build_messages(prompt: str, mode: str = "t2i") -> list[dict]:
    """构造 Ollama messages：官方 PE 原文作 system，用户请求 + JSON 约定作 user。"""
    key = normalize_mode(mode)
    text = _as_text(prompt).strip()
    system = load_system_prompt(key)
    user = f"{text}\n\n{JSON_OUTPUT_CONTRACT}" if text else JSON_OUTPUT_CONTRACT
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# --------------------------------------------------------------------------- 解析
def parse_polish_output(raw: Any) -> dict:
    """三级降级解析模型输出。

    返回 ``{"rewritten_prompt","wh_ratio","ratio_follow","parse"}``，
    ``parse`` ∈ ``{"json","braces","text"}`` 表示最终落在哪一级。
    """
    text = _strip_code_fence(_as_text(raw))
    if not text:
        return {"rewritten_prompt": "", "wh_ratio": "", "ratio_follow": "", "parse": "text"}

    # 一级：整段就是 JSON（含被 model 包了一层 JSON 字符串的情况）。
    parsed = _try_json(text)
    if isinstance(parsed, dict):
        result = _from_mapping(parsed)
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
            result = _from_mapping(parsed)
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
) -> dict:
    """润色一条提示词。

    返回::

        {"rewritten_prompt": str, "wh_ratio": str, "ratio_follow": str,
         "model": str, "elapsed_ms": int, "fallback": bool, "raw": str,
         "mode": str, "parse": str, "error": str | None}

    * Ollama 不可用 / 超时 / 任意调用异常：``fallback=True``，``rewritten_prompt``
      为原 prompt，``raw=""``（``fallback=False`` 时抛出 ``OllamaError``）。
    * 模型输出为空或解析不出正文：同样回退原 prompt，但保留 ``raw``。
    * 非法 ``mode``：``ValueError``（任何情况下都抛）。
    """
    mode_key = normalize_mode(mode)
    started = _empty_timer()
    text = _as_text(prompt).strip()
    resolved_model = _as_text(model).strip() or (
        DEFAULT_T2I_MODEL if mode_key == "t2i" else DEFAULT_EDIT_MODEL
    )

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
        }

    # 空提示词没有可润色的内容，也绝不发网络请求。
    if not text:
        return _result(text, fallback_flag=True, error="提示词为空")

    if client is None:
        client = OllamaClient(timeout=timeout)

    try:
        messages = build_messages(text, mode_key)
        sampling = T2I_SAMPLING if mode_key == "t2i" else EDIT_SAMPLING
        raw = _call_model(client, resolved_model, messages, sampling, json_mode=json_mode)
    except Exception as exc:  # noqa: BLE001 - 契约要求：除 mode 外都不抛异常
        if not fallback:
            if isinstance(exc, OllamaError):
                raise
            raise OllamaError(f"提示词润色失败：{exc}") from exc
        return _result(text, fallback_flag=True, error=str(exc))

    parsed = parse_polish_output(raw)
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
    "T2I_SAMPLING",
    "EDIT_SAMPLING",
    "JSON_OUTPUT_CONTRACT",
    "normalize_mode",
    "load_system_prompt",
    "build_messages",
    "parse_polish_output",
    "polish",
    "available_models",
    "pick_default_model",
]
