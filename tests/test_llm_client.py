# -*- coding: utf-8 -*-
"""``server/llm_client.py`` 云端客户端的自动降级测试（pytest 风格）。

覆盖两条真实踩过的坑，全部用注入的假 session，不发真实请求：

* 思考型模型把输出预算全花在 reasoning 上（``finish_reason=length``、content 为空），
  客户端要自动翻倍预算重试，而不是把「空正文」直接抛给润色；
* ``vision=auto`` 遇到没见过的视觉模型要先带上参考图，上游 400 拒绝图片时
  自动去掉图片重试并缓存该模型不支持读图，纯文本模型因此也能正常润色。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持 `python tests/test_llm_client.py` 直接运行
    sys.path.insert(0, str(ROOT))

from server import llm_client as lc  # noqa: E402


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self.payload = payload
        self.status_code = status_code
        self.text = text

    def json(self):
        return self.payload


class FakeSession:
    """按顺序返回预设响应；响应可以是异常实例（模拟网络错误）。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def request(self, method, url, **kwargs):
        self.requests.append({"method": method, "url": url, "kwargs": kwargs})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _reply(content="", reasoning="", finish="stop", status=200, error=""):
    if status >= 400:
        payload = {"error": {"message": error or "bad request"}}
    else:
        payload = {"choices": [{"message": {"content": content,
                                            "reasoning_content": reasoning},
                                "finish_reason": finish}]}
    return FakeResponse(payload, status)


def _reset_vision_cache():
    lc._VISION_SUPPORTED.clear()
    lc._VISION_UNSUPPORTED.clear()


def test_chat_raises_budget_when_reasoning_truncated():
    _reset_vision_cache()
    session = FakeSession([_reply("", "长思考", "length"),
                           _reply('{"ok":1}', "长思考", "stop")])
    client = lc.OpenAICompatClient("https://example.com/v1", max_tokens=2048,
                                   vision="off", session=session)
    out = client.chat("m", [{"role": "user", "content": "hi"}],
                      num_predict=2048, format="json")
    assert out == '{"ok":1}'
    budgets = [item["kwargs"]["json"]["max_tokens"] for item in session.requests]
    assert budgets == [2048, 4096]


def test_chat_budget_escalation_caps_at_hard_max():
    _reset_vision_cache()
    session = FakeSession([_reply("", "长思考", "length"),
                           _reply("正文", "短思考", "stop")])
    client = lc.OpenAICompatClient("https://example.com/v1", max_tokens=8192,
                                   vision="off", session=session)
    assert client.chat("m", [{"role": "user", "content": "hi"}],
                       num_predict=4096) == "正文"
    budgets = [item["kwargs"]["json"]["max_tokens"] for item in session.requests]
    assert budgets == [4096, lc.HARD_MAX_TOKENS]


def test_chat_raises_after_budget_retries_exhausted():
    _reset_vision_cache()
    session = FakeSession([_reply("", "长思考", "length")] * 3)
    client = lc.OpenAICompatClient("https://example.com/v1", max_tokens=2048,
                                   vision="off", session=session)
    try:
        client.chat("m", [{"role": "user", "content": "hi"}], num_predict=2048)
    except lc.LLMError as exc:
        assert exc.code == "empty_content"
        assert "推理" in str(exc)
    else:  # pragma: no cover - 必须抛错
        raise AssertionError("预算用尽后应抛出 empty_content")
    budgets = [item["kwargs"]["json"]["max_tokens"] for item in session.requests]
    assert budgets == [2048, 4096, lc.HARD_MAX_TOKENS]


def test_chat_drops_images_when_upstream_rejects_them():
    _reset_vision_cache()
    session = FakeSession([_reply(status=400, error="image input is not supported"),
                           _reply("纯文本结果")])
    client = lc.OpenAICompatClient("https://example.com/v1", vision="auto",
                                   session=session)
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "看看参考图", "images": ["aGVsbG8="]},
    ]
    assert client.chat("text-only-model", messages) == "纯文本结果"

    first = session.requests[0]["kwargs"]["json"]["messages"][1]["content"]
    second = session.requests[1]["kwargs"]["json"]["messages"][1]["content"]
    assert isinstance(first, list) and first[1]["type"] == "image_url"
    assert second == "看看参考图"
    assert client.last_vision_used is False
    assert client.supports_vision("text-only-model") is False

    # 缓存后换一个客户端也不再重试图片
    again = lc.OpenAICompatClient("https://example.com/v1", vision="auto",
                                  session=FakeSession([_reply("ok")]))
    assert again.supports_vision("text-only-model") is False


def test_vision_auto_accepts_unknown_vision_model():
    _reset_vision_cache()
    client = lc.OpenAICompatClient("https://example.com/v1", vision="auto",
                                   session=FakeSession([_reply("ok")]))
    # 未知型号（例如以后新上线的视觉模型）默认先尝试读图
    assert client.supports_vision("brand-new-vision-model-2027") is True
    client.chat("brand-new-vision-model-2027",
                [{"role": "user", "content": "hi", "images": ["aGVsbG8="]}])
    assert client.last_vision_used is True


def test_chat_retries_without_response_format():
    _reset_vision_cache()
    session = FakeSession([_reply(status=400, error="response_format is not supported"),
                           _reply("ok")])
    client = lc.OpenAICompatClient("https://example.com/v1", vision="off",
                                   session=session)
    assert client.chat("m", [{"role": "user", "content": "hi"}], format="json") == "ok"
    assert "response_format" in session.requests[0]["kwargs"]["json"]
    assert "response_format" not in session.requests[1]["kwargs"]["json"]
