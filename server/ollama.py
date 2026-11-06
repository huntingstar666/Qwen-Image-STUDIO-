"""Ollama HTTP 客户端（只用 requests / 标准库）。

契约见 ``docs/BUILD_CONTRACT.md`` 第 2.3 节：

    class OllamaError(RuntimeError)
    class OllamaClient:
        def __init__(self, base_url="http://127.0.0.1:11434", timeout=300)
        def is_alive(self) -> bool
        def list_models(self) -> list[dict]
        def chat(self, model, messages, *, temperature=1.0, top_p=0.95, top_k=20,
                 min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0,
                 num_predict=2048, format=None) -> str

采样参数名与 Ollama ``/api/chat`` 的 ``options`` 字段一一对应；官方 Qwen PE
推荐值见 ``prompt_polish`` 里的 ``T2I_SAMPLING`` / ``EDIT_SAMPLING``。

本模块不做任何重试（润色只调用一次，失败由 prompt_polish 降级处理），
所有异常统一收敛成 :class:`OllamaError`，方便上层决定是否 fallback。
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

import requests

DEFAULT_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_TIMEOUT = 300.0
#: ``is_alive`` 用短超时，避免 /api/health 轮询被一个卡死的 Ollama 拖住。
ALIVE_TIMEOUT = 5.0


class OllamaError(RuntimeError):
    """Ollama 不可达、HTTP 出错或响应结构异常。"""


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class OllamaClient:
    """极简 Ollama 客户端，接口与契约 2.3 完全一致。"""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        session: Any = None,
    ) -> None:
        self.base_url = str(base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = _as_float(timeout, DEFAULT_TIMEOUT) or DEFAULT_TIMEOUT
        # 允许注入 requests.Session（测试里可注入假对象，不发网络请求）。
        self._session = session

    # ------------------------------------------------------------------ 基础
    @property
    def session(self) -> Any:
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def url(self, path: str) -> str:
        return f"{self.base_url}/{str(path).lstrip('/')}"

    def _request(self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any) -> dict:
        """发请求并把各种失败统一转成 :class:`OllamaError`。"""
        try:
            response = self.session.request(
                method,
                self.url(path),
                timeout=self.timeout if timeout is None else timeout,
                **kwargs,
            )
        except requests.RequestException as exc:  # 连接失败 / 超时 / DNS ...
            raise OllamaError(f"无法连接 Ollama（{self.base_url}）：{exc}") from exc
        except Exception as exc:  # 注入的假 session 也可能抛别的异常
            raise OllamaError(f"Ollama 请求失败（{self.base_url}）：{exc}") from exc

        status = getattr(response, "status_code", 0)
        if status >= 400:
            detail = ""
            try:
                payload = response.json()
                if isinstance(payload, dict):
                    detail = str(payload.get("error") or "")
            except ValueError:
                pass
            if not detail:
                detail = str(getattr(response, "text", "") or "")[:500]
            raise OllamaError(f"Ollama 返回 HTTP {status}：{detail}".rstrip("："))

        try:
            data = response.json()
        except ValueError as exc:
            raise OllamaError("Ollama 返回了非 JSON 响应") from exc
        if not isinstance(data, dict):
            raise OllamaError("Ollama 返回了非对象 JSON 响应")
        if data.get("error"):
            raise OllamaError(f"Ollama 错误：{data['error']}")
        return data

    # ------------------------------------------------------------------ 接口
    def is_alive(self) -> bool:
        """Ollama 是否可达（永不抛异常，供 /api/health 轮询使用）。"""
        try:
            data = self._request("GET", "/api/tags", timeout=min(self.timeout, ALIVE_TIMEOUT))
        except OllamaError:
            return False
        return isinstance(data.get("models"), list) or isinstance(data.get("models"), type(None))

    def list_models(self) -> list[dict]:
        """返回 ``[{"name", "size", "modified_at"}, ...]``，按 Ollama 返回顺序。"""
        data = self._request("GET", "/api/tags")
        raw_models = data.get("models") or []
        if not isinstance(raw_models, list):
            raise OllamaError("Ollama /api/tags 的 models 字段不是数组")
        models: list[dict] = []
        for item in raw_models:
            if not isinstance(item, Mapping):
                continue
            name = item.get("name") or item.get("model") or ""
            if not name:
                continue
            models.append(
                {
                    "name": str(name),
                    "size": int(item.get("size") or 0),
                    "modified_at": str(item.get("modified_at") or ""),
                }
            )
        return models

    def chat(
        self,
        model: str,
        messages: list[dict],
        *,
        temperature: float = 1.0,
        top_p: float = 0.95,
        top_k: int = 20,
        min_p: float = 0.0,
        presence_penalty: float = 1.5,
        repetition_penalty: float = 1.0,
        num_predict: int = 2048,
        format: str | None = None,
        think: bool | None = None,
    ) -> str:
        """非流式对话，返回 ``message.content`` 字符串。

        参数名即 Ollama ``options`` 字段名；``format="json"`` 可让 Ollama 做
        JSON 语法约束（token 级），``think=False`` 可关闭 qwen3.5 等思考模型的
        thinking 段（否则长思考会吃光 ``num_predict``、content 为空）。
        两者都是可选扩展，默认不发送，不改变契约 2.3 的行为。
        """
        if not model:
            raise OllamaError("未指定 Ollama 模型")
        if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)) or not messages:
            raise OllamaError("messages 必须是非空列表")

        payload: dict[str, Any] = {
            "model": str(model),
            "messages": [dict(message) for message in messages],
            "stream": False,
            "options": {
                "temperature": float(temperature),
                "top_p": float(top_p),
                "top_k": int(top_k),
                "min_p": float(min_p),
                "presence_penalty": float(presence_penalty),
                "repetition_penalty": float(repetition_penalty),
                "num_predict": int(num_predict),
            },
        }
        if format:
            payload["format"] = str(format)
        if think is not None:
            payload["think"] = bool(think)

        data = self._request("POST", "/api/chat", json=payload)
        message = data.get("message")
        content = message.get("content") if isinstance(message, Mapping) else None
        if not isinstance(content, str):
            raise OllamaError("Ollama /api/chat 响应缺少 message.content")
        return content

    # ---------------------------------------------------------------- 便捷方法
    def model_names(self) -> list[str]:
        """仅返回模型名列表（/api/health 用）。"""
        return [item["name"] for item in self.list_models()]

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"OllamaClient(base_url={self.base_url!r}, timeout={self.timeout!r})"


__all__ = ["OllamaError", "OllamaClient", "DEFAULT_BASE_URL", "DEFAULT_TIMEOUT", "ALIVE_TIMEOUT"]
