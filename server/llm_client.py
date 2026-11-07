"""LLM 客户端工厂：本机 Ollama + OpenAI 兼容云端大模型。

提示词润色（``prompt_polish.polish``）只依赖两个方法：``chat()`` 与
``supports_vision()``。这里用同一份接口包住两套协议，``main.py`` 只跟
:func:`make_client` 打交道，换服务不用改调用方。

设计约定见 ``docs/PLAN_LLM_PROVIDERS.md``：

* 鉴权：``Authorization: Bearer {api_key}``；填了 ``api_key_env`` 时优先读环境变量。
* 错误统一收敛成 :class:`LLMError`（``code`` 供前端分级，``hint`` 是可执行建议）。
* Key 只出现在请求头里，日志/异常/接口回包都不带明文。
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import requests

try:  # 正常情况：作为 server 包的一部分导入
    from . import config
    from .ollama import DEFAULT_BASE_URL, OllamaClient
except ImportError:  # 兜底：server/ 被直接加进 sys.path 时
    import config  # type: ignore[no-redef]
    from ollama import DEFAULT_BASE_URL, OllamaClient  # type: ignore[no-redef]

DEFAULT_TIMEOUT = 300.0
#: 列模型用短超时：设置页/健康检查不能被一个卡死的网关拖住。
LIST_TIMEOUT = 8.0

#: 模型名启发式（vision=auto 时用）：命中即认为支持读图，避免额外探测费用。
VISION_HINTS = (
    "gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4",
    "qwen-vl", "qwen2.5-vl", "qwen3-vl",
    "claude", "gemini", "glm-4v", "glm-4.5v", "internvl", "llava", "pixtral",
)

_STATUS_ERRORS: dict[int, tuple[str, str, str]] = {
    400: ("upstream_error", "请求被服务拒绝", "检查模型名、参数与服务商文档"),
    401: ("auth_failed", "API Key 无效或无权限", "检查 Key 是否正确、是否属于该服务商与区域"),
    403: ("auth_failed", "API Key 无访问权限", "检查 Key 权限、模型白名单或企业网关策略"),
    404: ("not_found", "地址或模型不存在", "检查 Base URL 是否需要 /v1、模型名是否正确"),
    405: ("not_found", "接口不支持该操作", "检查 Base URL 是否指向 OpenAI 兼容接口"),
    429: ("rate_limited", "触发限流", "稍后重试，或提升账户配额"),
}


class LLMError(RuntimeError):
    """LLM 服务不可用 / 鉴权失败 / 响应异常。"""

    def __init__(self, message: str, *, code: str = "upstream_error", hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.hint = hint


def mask_key(key: Any) -> str:
    """Key 打码：只留前 3 位与末 4 位（用于设置页提示，永不回明文）。"""
    text = str(key or "")
    if not text:
        return ""
    if len(text) <= 8:
        return "…"
    return f"{text[:3]}…{text[-4:]}"


def resolve_api_key(profile: Mapping[str, Any]) -> str:
    """``api_key_env`` 优先于落盘的 ``api_key``。"""
    env_name = str(profile.get("api_key_env") or "").strip()
    if env_name:
        return os.environ.get(env_name, "").strip()
    return str(profile.get("api_key") or "").strip()


def scrub_secrets(text: Any, *secrets: Any) -> str:
    """把回包/日志里的 Key 明文替换成打码形式（上游偶尔会把 Key 回显出来）。"""
    out = str(text or "")
    for secret in secrets:
        value = str(secret or "")
        if len(value) >= 8:
            out = out.replace(value, mask_key(value))
    return out


def _response_detail(response: Any) -> str:
    """从错误响应里提取可读信息（最多 200 字，避免把整页 HTML 抛给前端）。"""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, Mapping):
        error = payload.get("error")
        if isinstance(error, Mapping):
            text = error.get("message") or error.get("code") or ""
            if text:
                return str(text)[:200]
        if error:
            return str(error)[:200]
        if payload.get("message"):
            return str(payload["message"])[:200]
    return str(getattr(response, "text", "") or "")[:200]


def _image_data_url(value: Any) -> str:
    text = str(value or "").strip()
    if text.startswith("data:"):
        return text
    return f"data:image/png;base64,{text}"


def _to_openai_messages(messages: Any) -> list[dict[str, Any]]:
    """把 ``prompt_polish`` 的 Ollama 格式（user 带 ``images``）转成 content parts。"""
    out: list[dict[str, Any]] = []
    for message in messages or []:
        if not isinstance(message, Mapping):
            continue
        role = str(message.get("role") or "user")
        content = message.get("content")
        images = message.get("images") or []
        if isinstance(images, list) and images:
            parts: list[dict[str, Any]] = [{"type": "text", "text": str(content or "")}]
            for image in images:
                parts.append({"type": "image_url", "image_url": {"url": _image_data_url(image)}})
            out.append({"role": role, "content": parts})
        else:
            out.append({"role": role, "content": "" if content is None else str(content)})
    return out


class OpenAICompatClient:
    """OpenAI 兼容接口客户端（OpenAI / DeepSeek / 百炼 / SiliconFlow / vLLM / 网关）。"""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str = "",
        timeout: float = DEFAULT_TIMEOUT,
        max_tokens: int = 2048,
        json_mode: bool = True,
        vision: str = "auto",
        extra_headers: Mapping[str, str] | None = None,
        session: Any = None,
    ) -> None:
        self.base_url = str(base_url or "").rstrip("/")
        self.api_key = str(api_key or "")
        try:
            self.timeout = float(timeout) or DEFAULT_TIMEOUT
        except (TypeError, ValueError):
            self.timeout = DEFAULT_TIMEOUT
        self.max_tokens = int(max_tokens or 2048)
        self.json_mode = bool(json_mode)
        self.vision = str(vision or "auto")
        self.extra_headers = {str(k): str(v) for k, v in dict(extra_headers or {}).items()}
        self._session = session

    # ------------------------------------------------------------------ 基础
    @property
    def session(self) -> Any:
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def url(self, path: str) -> str:
        return f"{self.base_url}/{str(path).lstrip('/')}"

    def headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self.extra_headers)
        return headers

    def _request(self, method: str, path: str, *, timeout: float | None = None,
                 **kwargs: Any) -> Any:
        limit = float(timeout or self.timeout)
        try:
            response = self.session.request(
                method,
                self.url(path),
                headers=self.headers(),
                timeout=(10.0, limit),
                **kwargs,
            )
        except requests.Timeout as exc:
            raise LLMError(
                f"超过 {int(limit)}s 未返回", code="timeout",
                hint="在服务的高级选项里调大超时，或换更快的模型",
            ) from exc
        except requests.exceptions.SSLError as exc:
            raise LLMError(
                "TLS 证书校验失败", code="tls_error",
                hint="检查代理 / 企业网关证书，或改用内网 http 地址",
            ) from exc
        except requests.RequestException as exc:
            raise LLMError(
                f"无法连接 {self.base_url}", code="unreachable",
                hint="检查网络、代理与接口地址是否可访问",
            ) from exc
        except Exception as exc:  # 注入的假 session 也可能抛别的异常
            raise LLMError(f"请求失败：{exc}", code="unreachable") from exc

        status = int(getattr(response, "status_code", 0) or 0)
        if status >= 400:
            detail = _response_detail(response)
            code, message, hint = _STATUS_ERRORS.get(
                status, ("upstream_error", f"服务返回 HTTP {status}", ""))
            if status >= 500:
                code = "upstream_error"
                message = f"服务商异常（HTTP {status}）"
                hint = "稍后重试；持续失败请查看服务商状态页"
            raise LLMError(
                f"{message}：{detail}" if detail else message,
                code=code,
                hint=hint,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise LLMError(
                "服务返回了非 JSON 响应", code="upstream_error",
                hint="确认 Base URL 指向 OpenAI 兼容接口，而不是网页地址",
            ) from exc

    # ------------------------------------------------------------------ 接口
    def list_models(self) -> list[dict[str, Any]]:
        """``GET /models``；服务不支持列举时返回空列表（不算故障）。"""
        try:
            data = self._request("GET", "/models", timeout=LIST_TIMEOUT)
        except LLMError as exc:
            if exc.code == "not_found":
                return []
            raise
        raw: Any = None
        if isinstance(data, Mapping):
            raw = data.get("data")
            if raw is None:
                raw = data.get("models")
        models: list[dict[str, Any]] = []
        for item in raw or []:
            name = ""
            if isinstance(item, Mapping):
                name = str(item.get("id") or item.get("name") or "").strip()
            else:
                name = str(item).strip()
            if name:
                models.append({"name": name, "size": 0, "modified_at": ""})
        return models

    def model_names(self) -> list[str]:
        return [item["name"] for item in self.list_models()]

    def is_alive(self) -> bool:
        """服务是否可达且鉴权通过（永不抛异常，供 health 轮询使用）。"""
        try:
            self.list_models()
        except LLMError:
            return False
        return True

    def supports_vision(self, model: str) -> bool:
        """``vision=auto`` 时按模型名启发式判断，不做额外探测（避免费用）。"""
        if self.vision == "on":
            return True
        if self.vision == "off":
            return False
        name = str(model or "").lower()
        return any(hint in name for hint in VISION_HINTS)

    def chat(
        self,
        model: str,
        messages: Any,
        *,
        temperature: float = 1.0,
        top_p: float = 0.95,
        presence_penalty: float = 1.5,
        num_predict: int = 2048,
        format: str | None = None,
        think: bool | None = None,
        **_ignored: Any,
    ) -> str:
        """``POST /chat/completions``，返回 ``choices[0].message.content``。

        ``top_k`` / ``min_p`` / ``repetition_penalty`` / ``think`` 属于 Ollama
        专有参数，这里忽略；``format="json"`` 或档案开启 ``json_mode`` 时请求
        ``response_format=json_object``。
        """
        if not model:
            raise LLMError("未指定模型", code="not_found",
                           hint="在设置里为该服务选择一个默认模型")
        try:
            limit = int(num_predict or self.max_tokens)
        except (TypeError, ValueError):
            limit = self.max_tokens
        payload: dict[str, Any] = {
            "model": str(model),
            "messages": _to_openai_messages(messages),
            "temperature": float(temperature),
            "top_p": float(top_p),
            "presence_penalty": float(presence_penalty),
            "max_tokens": max(16, min(limit, self.max_tokens)),
        }
        wants_json = bool(format == "json") or self.json_mode
        if wants_json:
            payload["response_format"] = {"type": "json_object"}

        try:
            data = self._request("POST", "/chat/completions", json=payload)
        except LLMError as exc:
            # 部分兼容服务不认识 response_format：去掉后重试一次
            if "response_format" in payload and exc.code in ("upstream_error", "not_found"):
                payload.pop("response_format", None)
                data = self._request("POST", "/chat/completions", json=payload)
            else:
                raise

        choices = data.get("choices") if isinstance(data, Mapping) else None
        message: Any = {}
        if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
            message = choices[0].get("message") or {}
        content = message.get("content") if isinstance(message, Mapping) else ""
        if isinstance(content, list):
            content = "".join(
                str(part.get("text") or "") for part in content if isinstance(part, Mapping))
        text = str(content or "").strip()
        if text:
            return text
        reasoning = ""
        if isinstance(message, Mapping):
            reasoning = str(
                message.get("reasoning_content") or message.get("reasoning") or "").strip()
        if reasoning:
            raise LLMError(
                "模型只返回了推理内容（reasoning_content）", code="empty_content",
                hint="换一个非推理模型，或在服务上关闭思考模式",
            )
        raise LLMError("模型返回了空内容", code="empty_content",
                       hint="换一个模型，或调大最大输出")

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"OpenAICompatClient(base_url={self.base_url!r}, model_key={mask_key(self.api_key)!r})"


def client_from_profile(profile: Mapping[str, Any]) -> Any:
    """按一条服务档案构造客户端（未落盘的草稿也能直接用）。"""
    kind = str(profile.get("kind") or "ollama")
    timeout = float(profile.get("timeout_s") or DEFAULT_TIMEOUT)
    if kind == "openai":
        return OpenAICompatClient(
            str(profile.get("base_url") or ""),
            api_key=resolve_api_key(profile),
            timeout=timeout,
            max_tokens=int(profile.get("max_tokens") or 2048),
            json_mode=bool(profile.get("json_mode", True)),
            vision=str(profile.get("vision") or "auto"),
            extra_headers=profile.get("extra_headers") or {},
        )
    return OllamaClient(
        base_url=str(profile.get("base_url") or DEFAULT_BASE_URL),
        timeout=timeout,
    )


def make_client(cfg: dict[str, Any] | None = None, profile_id: str | None = None) -> Any:
    """按当前激活（或指定 id）的服务档案构造客户端。"""
    cfg = cfg or config.load_config()
    profile = config.active_llm_profile(cfg, profile_id)
    return client_from_profile(profile)


__all__ = [
    "LLMError",
    "OpenAICompatClient",
    "make_client",
    "client_from_profile",
    "resolve_api_key",
    "mask_key",
    "scrub_secrets",
    "DEFAULT_TIMEOUT",
    "LIST_TIMEOUT",
]
