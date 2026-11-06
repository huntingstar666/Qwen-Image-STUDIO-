# -*- coding: utf-8 -*-
"""``server/ollama.py`` + ``server/prompt_polish.py`` 的单元测试（pytest 风格）。

所有网络交互都用注入的假 client / 假 session，不发任何真实请求：

* ``OllamaClient`` 的请求体构造、错误收敛、``/api/tags`` 规整；
* 润色解析的三级降级：``json.loads`` → 花括号截取 → 整段文本；
* Ollama 不可用 / 超时 / 空输出时不抛异常，返回 ``fallback=True`` + 原 prompt；
* 官方 PE 系统提示词作 system message、采样参数按模式区分（edit 的
  ``presence_penalty`` 必须是 0）。

文件末尾带 ``__main__`` 自跑块：本机没有真 pytest 时可
``$PY tests/test_prompt_polish.py`` 直接验证。
"""

from __future__ import annotations

import inspect
import json
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持 `python tests/test_prompt_polish.py` 直接运行
    sys.path.insert(0, str(ROOT))

from server import ollama as ollama_mod  # noqa: E402
from server import prompt_polish as pp  # noqa: E402

T2I_SYSTEM_FILE = ROOT / "data" / "pe_system_prompt_t2i.txt"
EDIT_SYSTEM_FILE = ROOT / "data" / "pe_system_prompt_edit.txt"


# --------------------------------------------------------------------------- 假对象
class FakeClient:
    """假 OllamaClient：记录调用参数，按预设返回内容或抛错。"""

    def __init__(self, content="", error=None):
        self.content = content
        self.error = error
        self.calls = []

    def chat(self, model, messages, **kwargs):
        self.calls.append({"model": model, "messages": messages, "kwargs": kwargs})
        if self.error is not None:
            raise self.error
        return self.content


class FakeResponse:
    def __init__(self, payload=None, status_code=200, text="", json_error=None):
        self.payload = payload
        self.status_code = status_code
        self.text = text
        self.json_error = json_error

    def json(self):
        if self.json_error is not None:
            raise self.json_error
        return self.payload


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def request(self, method, url, **kwargs):
        self.requests.append({"method": method, "url": url, "kwargs": kwargs})
        if self.error is not None:
            raise self.error
        return self.response


def _json_content(rewritten="润色后的提示词", wh_ratio="3:2", ratio_follow=""):
    return json.dumps(
        {"rewritten_prompt": rewritten, "wh_ratio": wh_ratio, "ratio_follow": ratio_follow},
        ensure_ascii=False,
    )


# --------------------------------------------------------------------------- 系统提示词
def test_system_prompt_files_are_official_and_untouched():
    t2i = T2I_SYSTEM_FILE.read_text(encoding="utf-8")
    edit = EDIT_SYSTEM_FILE.read_text(encoding="utf-8")
    assert t2i == pp.load_system_prompt("t2i")
    assert edit == pp.load_system_prompt("edit")
    assert len(t2i) > 10000 and len(edit) > 10000
    assert t2i.startswith("# Image Prompt Rewriting Expert")
    assert edit.startswith("# Edit Prompt Enhancer")
    # 官方 PE 自己的 Output format 要求是纯文本；工作台不改 system，只追加到 user message。
    assert "Output format" in t2i
    assert "Output Format" in edit
    assert t2i != edit


def test_load_system_prompt_rejects_invalid_mode():
    for bad in ("", "img", None, "T2I2"):
        try:
            pp.load_system_prompt(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"非法 mode 应当抛 ValueError：{bad!r}")


def test_normalize_mode():
    assert pp.normalize_mode("T2I") == "t2i"
    assert pp.normalize_mode(" edit ") == "edit"
    try:
        pp.normalize_mode("video")
    except ValueError:
        pass
    else:
        raise AssertionError("非法 mode 应当抛 ValueError")


def test_build_messages_uses_official_system_prompt_verbatim():
    prompt = "一只戴墨镜的橘猫"
    messages = pp.build_messages(prompt, "t2i")
    assert [item["role"] for item in messages] == ["system", "user"]
    # system 必须是官方 PE 原文（逐字，未追加任何东西）。
    assert messages[0]["content"] == pp.load_system_prompt("t2i")
    assert "rewritten_prompt" not in messages[0]["content"]
    # user 里带用户原文 + JSON 输出约定。
    assert messages[1]["content"].startswith(prompt)
    for key in ("rewritten_prompt", "wh_ratio", "ratio_follow"):
        assert key in messages[1]["content"]
    assert "<image1>" in messages[1]["content"]

    edit_messages = pp.build_messages(prompt, "edit")
    assert edit_messages[0]["content"] == pp.load_system_prompt("edit")


def test_json_contract_mentions_all_three_fields():
    for key in ("rewritten_prompt", "wh_ratio", "ratio_follow"):
        assert key in pp.JSON_OUTPUT_CONTRACT
    # 约定里不能出现单花括号以外的内容（避免误导模型输出 markdown）。
    assert "markdown" in pp.JSON_OUTPUT_CONTRACT


# --------------------------------------------------------------------------- 解析
def test_parse_json_direct():
    parsed = pp.parse_polish_output(_json_content("a cat", "16:9", "<image1>"))
    assert parsed["parse"] == "json"
    assert parsed["rewritten_prompt"] == "a cat"
    assert parsed["wh_ratio"] == "16:9"
    assert parsed["ratio_follow"] == "<image1>"


def test_parse_code_fence_json():
    raw = "```json\n" + _json_content("fenced", "1:1") + "\n```"
    parsed = pp.parse_polish_output(raw)
    assert parsed["parse"] == "json"
    assert parsed["rewritten_prompt"] == "fenced"
    assert parsed["wh_ratio"] == "1:1"


def test_parse_braces_extraction():
    raw = '好的，结果如下：{"rewritten_prompt": "braced", "wh_ratio": "4:5"} 以上。'
    parsed = pp.parse_polish_output(raw)
    assert parsed["parse"] == "braces"
    assert parsed["rewritten_prompt"] == "braced"
    assert parsed["wh_ratio"] == "4:5"


def test_parse_plain_text_falls_back_to_whole_text():
    raw = "The image is a vertical photograph of a cat sitting on a windowsill."
    parsed = pp.parse_polish_output(raw)
    assert parsed["parse"] == "text"
    assert parsed["rewritten_prompt"] == raw
    assert parsed["wh_ratio"] == ""
    assert parsed["ratio_follow"] == ""


def test_parse_invalid_braces_falls_through_to_text():
    raw = "prefix {not valid json} suffix"
    parsed = pp.parse_polish_output(raw)
    assert parsed["parse"] == "text"
    assert parsed["rewritten_prompt"] == raw


def test_parse_json_string_payload():
    parsed = pp.parse_polish_output('"一段被 JSON 包了一层的提示词"')
    assert parsed["parse"] == "json"
    assert parsed["rewritten_prompt"] == "一段被 JSON 包了一层的提示词"


def test_parse_ratio_normalization_and_validation():
    parsed = pp.parse_polish_output(
        json.dumps({"rewritten_prompt": "x", "wh_ratio": " 16 : 9 ", "ratio_follow": "<image12>"})
    )
    assert parsed["wh_ratio"] == "16:9"
    assert parsed["ratio_follow"] == "<image12>"

    parsed = pp.parse_polish_output(
        json.dumps({"rewritten_prompt": "x", "wh_ratio": "wide", "ratio_follow": "image2"})
    )
    assert parsed["wh_ratio"] == ""
    assert parsed["ratio_follow"] == ""

    parsed = pp.parse_polish_output(json.dumps({"rewritten_prompt": "x", "wh_ratio": 3}))
    assert parsed["wh_ratio"] == ""


def test_parse_alias_keys():
    assert pp.parse_polish_output('{"rewritten": "alias-rewritten"}')["rewritten_prompt"] == "alias-rewritten"
    assert pp.parse_polish_output('{"prompt": "alias-prompt"}')["rewritten_prompt"] == "alias-prompt"
    assert pp.parse_polish_output('{"text": "alias-text"}')["rewritten_prompt"] == "alias-text"
    assert pp.parse_polish_output('{"rewritten_prompt": "ok", "aspect_ratio": "2:3"}')["wh_ratio"] == "2:3"
    assert pp.parse_polish_output('{"rewritten_prompt": "ok", "ratioFollow": "<image3>"}')["ratio_follow"] == "<image3>"


def test_parse_empty_and_non_string():
    assert pp.parse_polish_output("")["rewritten_prompt"] == ""
    assert pp.parse_polish_output(None)["rewritten_prompt"] == ""
    assert pp.parse_polish_output("   ")["parse"] == "text"
    # 缺 rewritten_prompt 的 JSON 不能把 JSON 本身当正文以外的空结果丢掉，会退到整段文本。
    parsed = pp.parse_polish_output('{"wh_ratio": "3:2"}')
    assert parsed["parse"] == "text"
    assert parsed["rewritten_prompt"] == '{"wh_ratio": "3:2"}'


# --------------------------------------------------------------------------- polish 正常路径
def test_polish_success_t2i_json():
    fake = FakeClient(content=_json_content("A vertical photo of a cat.", "2:3", "<image1>"))
    result = pp.polish("一只猫", client=fake)
    assert set(result) >= {
        "rewritten_prompt",
        "wh_ratio",
        "ratio_follow",
        "model",
        "elapsed_ms",
        "fallback",
        "raw",
        "mode",
    }
    assert result["rewritten_prompt"] == "A vertical photo of a cat."
    assert result["wh_ratio"] == "2:3"
    # wh_ratio 只属于文生图；ratio_follow 只属于编辑模式，跨模式字段被收口。
    assert result["ratio_follow"] == ""
    assert result["model"] == pp.DEFAULT_T2I_MODEL
    assert result["mode"] == "t2i"
    assert result["fallback"] is False
    assert result["parse"] == "json"
    assert result["raw"] == fake.content
    assert isinstance(result["elapsed_ms"], int) and result["elapsed_ms"] >= 0
    assert result["error"] is None


def test_polish_success_edit_masks_wh_ratio():
    fake = FakeClient(content=_json_content("把背景换成雪山", "3:2", "<image2>"))
    result = pp.polish("把背景换成雪山", mode="edit", client=fake)
    assert result["mode"] == "edit"
    assert result["fallback"] is False
    assert result["rewritten_prompt"] == "把背景换成雪山"
    assert result["wh_ratio"] == ""
    assert result["ratio_follow"] == "<image2>"


def test_polish_plain_text_still_usable():
    plain = "The image is a wide cinematic photograph of a cat on a neon street."
    fake = FakeClient(content=plain)
    result = pp.polish("一只猫", client=fake)
    assert result["fallback"] is False
    assert result["parse"] == "text"
    assert result["rewritten_prompt"] == plain
    assert result["wh_ratio"] == "" and result["ratio_follow"] == ""
    assert result["raw"] == plain


def test_polish_model_override_and_uses_official_system_prompt():
    fake = FakeClient(content=_json_content("x"))
    result = pp.polish("一只猫", model="qwen3.5:27b", client=fake)
    assert result["model"] == "qwen3.5:27b"
    call = fake.calls[0]
    assert call["model"] == "qwen3.5:27b"
    assert call["messages"][0]["role"] == "system"
    assert call["messages"][0]["content"] == pp.load_system_prompt("t2i")


def test_polish_sampling_parameters_by_mode():
    t2i_fake = FakeClient(content=_json_content("x"))
    pp.polish("一只猫", client=t2i_fake)
    t2i_kwargs = t2i_fake.calls[0]["kwargs"]
    for key, value in pp.T2I_SAMPLING.items():
        assert t2i_kwargs[key] == value, (key, t2i_kwargs[key], value)
    assert t2i_kwargs["presence_penalty"] == 1.5
    assert t2i_kwargs["format"] == "json"
    assert t2i_kwargs["think"] is False

    edit_fake = FakeClient(content=_json_content("x"))
    pp.polish("改一下", mode="edit", client=edit_fake)
    edit_kwargs = edit_fake.calls[0]["kwargs"]
    # 契约 4.4：编辑模式 presence_penalty 必须是 0（T2I 是 1.5）。
    assert edit_kwargs["presence_penalty"] == 0.0
    assert edit_kwargs["temperature"] == 1.0
    assert edit_kwargs["format"] == "json"
    assert edit_kwargs["think"] is False
    assert edit_fake.calls[0]["messages"][0]["content"] == pp.load_system_prompt("edit")


def test_polish_json_mode_can_be_disabled():
    fake = FakeClient(content="plain text paragraph")
    pp.polish("一只猫", client=fake, json_mode=False)
    assert "format" not in fake.calls[0]["kwargs"]


# --------------------------------------------------------------------------- polish 降级路径
def test_polish_ollama_unavailable_falls_back():
    fake = FakeClient(error=ollama_mod.OllamaError("无法连接 Ollama（http://127.0.0.1:11434）"))
    result = pp.polish("一只猫", client=fake)
    assert result["fallback"] is True
    assert result["rewritten_prompt"] == "一只猫"
    assert result["raw"] == ""
    assert "无法连接" in result["error"]
    assert result["elapsed_ms"] >= 0


def test_polish_timeout_falls_back():
    fake = FakeClient(error=requests.Timeout("timed out"))
    result = pp.polish("一只猫", mode="edit", client=fake)
    assert result["fallback"] is True
    assert result["rewritten_prompt"] == "一只猫"
    assert result["mode"] == "edit"


def test_polish_generic_exception_falls_back():
    fake = FakeClient(error=RuntimeError("boom"))
    result = pp.polish("一只猫", client=fake)
    assert result["fallback"] is True
    assert result["rewritten_prompt"] == "一只猫"
    assert "boom" in result["error"]


def test_polish_empty_model_output_falls_back():
    fake = FakeClient(content="")
    result = pp.polish("一只猫", client=fake)
    assert result["fallback"] is True
    assert result["rewritten_prompt"] == "一只猫"
    assert result["raw"] == ""
    assert result["error"]


def test_polish_fallback_false_raises_ollama_error():
    fake = FakeClient(error=ollama_mod.OllamaError("boom"))
    try:
        pp.polish("一只猫", client=fake, fallback=False)
    except ollama_mod.OllamaError:
        pass
    else:
        raise AssertionError("fallback=False 时应当抛 OllamaError")

    generic = FakeClient(error=RuntimeError("kaboom"))
    try:
        pp.polish("一只猫", client=generic, fallback=False)
    except ollama_mod.OllamaError:
        pass
    else:
        raise AssertionError("非 OllamaError 的异常在 fallback=False 时也应包成 OllamaError")


def test_polish_invalid_mode_raises_even_with_client():
    fake = FakeClient(content=_json_content("x"))
    try:
        pp.polish("一只猫", mode="video", client=fake)
    except ValueError:
        pass
    else:
        raise AssertionError("非法 mode 必须抛 ValueError")
    assert fake.calls == []


def test_polish_empty_prompt_makes_no_request():
    fake = FakeClient(content=_json_content("x"))
    result = pp.polish("   ", client=fake)
    assert fake.calls == []
    assert result["fallback"] is True
    assert result["rewritten_prompt"] == ""


def test_polish_returns_int_elapsed():
    fake = FakeClient(content=_json_content("x"))
    result = pp.polish("一只猫", client=fake)
    assert isinstance(result["elapsed_ms"], int)
    assert result["elapsed_ms"] < 10000


# --------------------------------------------------------------------------- 签名 / 模型选择
def test_polish_signature_matches_contract():
    params = inspect.signature(pp.polish).parameters
    assert params["prompt"].default is inspect.Parameter.empty
    for name, default in (
        ("mode", "t2i"),
        ("model", None),
        ("client", None),
        ("timeout", 300),
        ("fallback", True),
    ):
        assert name in params, name
        assert params[name].kind is inspect.Parameter.KEYWORD_ONLY, name
        assert params[name].default == default, (name, params[name].default)
    # 扩展参数只能追加在契约签名之后，且必须有默认值。
    assert params["language"].default is None
    assert params["json_mode"].default is True


def test_ollama_client_signature_and_defaults():
    init_params = inspect.signature(ollama_mod.OllamaClient.__init__).parameters
    assert init_params["base_url"].default == "http://127.0.0.1:11434"
    assert init_params["timeout"].default == 300

    chat_params = inspect.signature(ollama_mod.OllamaClient.chat).parameters
    for name in (
        "temperature",
        "top_p",
        "top_k",
        "min_p",
        "presence_penalty",
        "repetition_penalty",
        "num_predict",
        "format",
    ):
        assert name in chat_params, name
    assert chat_params["temperature"].default == 1.0
    assert chat_params["top_p"].default == 0.95
    assert chat_params["top_k"].default == 20
    assert chat_params["min_p"].default == 0.0
    assert chat_params["presence_penalty"].default == 1.5
    assert chat_params["repetition_penalty"].default == 1.0
    assert chat_params["num_predict"].default == 2048
    assert issubclass(ollama_mod.OllamaError, RuntimeError)


def test_pick_default_model_prefers_explicit():
    assert pp.pick_default_model("qwen3.5:27b") == "qwen3.5:27b"
    assert pp.pick_default_model("  gemma4:31b  ") == "gemma4:31b"


# --------------------------------------------------------------------------- OllamaClient HTTP
def test_ollama_chat_request_payload():
    session = FakeSession(FakeResponse({"message": {"content": "  你好  "}}))
    client = ollama_mod.OllamaClient(session=session)
    assert client.chat("m", [{"role": "user", "content": "hi"}], format="json", think=False) == "  你好  "

    request = session.requests[0]
    assert request["method"] == "POST"
    assert request["url"] == "http://127.0.0.1:11434/api/chat"
    assert request["kwargs"]["timeout"] == 300
    payload = request["kwargs"]["json"]
    assert payload["model"] == "m"
    assert payload["stream"] is False
    assert payload["format"] == "json"
    assert payload["think"] is False
    options = payload["options"]
    assert options["temperature"] == 1.0
    assert options["top_p"] == 0.95
    assert options["top_k"] == 20
    assert options["min_p"] == 0.0
    assert options["presence_penalty"] == 1.5
    assert options["repetition_penalty"] == 1.0
    assert options["num_predict"] == 2048
    assert payload["messages"] == [{"role": "user", "content": "hi"}]


def test_ollama_chat_does_not_send_think_when_none():
    session = FakeSession(FakeResponse({"message": {"content": "ok"}}))
    client = ollama_mod.OllamaClient(session=session)
    client.chat("m", [{"role": "user", "content": "hi"}])
    payload = session.requests[0]["kwargs"]["json"]
    assert "think" not in payload
    assert "format" not in payload


def test_ollama_chat_http_error():
    session = FakeSession(FakeResponse({"error": "model not found"}, status_code=404))
    client = ollama_mod.OllamaClient(session=session)
    try:
        client.chat("missing", [{"role": "user", "content": "hi"}])
    except ollama_mod.OllamaError as exc:
        assert "404" in str(exc) and "model not found" in str(exc)
    else:
        raise AssertionError("HTTP 404 应当抛 OllamaError")


def test_ollama_chat_missing_content():
    session = FakeSession(FakeResponse({"message": {}}))
    client = ollama_mod.OllamaClient(session=session)
    try:
        client.chat("m", [{"role": "user", "content": "hi"}])
    except ollama_mod.OllamaError:
        pass
    else:
        raise AssertionError("缺少 message.content 应当抛 OllamaError")


def test_ollama_chat_rejects_bad_arguments():
    client = ollama_mod.OllamaClient(session=FakeSession(FakeResponse({})))
    for model, messages in (("", [{"role": "user", "content": "x"}]), ("m", []), ("m", "junk")):
        try:
            client.chat(model, messages)
        except ollama_mod.OllamaError:
            pass
        else:
            raise AssertionError("非法参数应当抛 OllamaError")


def test_ollama_is_alive_true_and_false():
    alive = ollama_mod.OllamaClient(session=FakeSession(FakeResponse({"models": []})))
    assert alive.is_alive() is True

    dead = ollama_mod.OllamaClient(
        session=FakeSession(error=requests.ConnectionError("connection refused"))
    )
    assert dead.is_alive() is False

    broken = ollama_mod.OllamaClient(session=FakeSession(FakeResponse(text="<html>", json_error=ValueError("x"))))
    assert broken.is_alive() is False


def test_ollama_list_models_normalizes():
    payload = {
        "models": [
            {"name": "qwen3.5:9b", "size": 6144, "modified_at": "2026-10-11T11:53:00+08:00"},
            {"model": "legacy:1b", "size": 3, "modified_at": ""},
            {"size": 1},
            "junk",
        ]
    }
    session = FakeSession(FakeResponse(payload))
    client = ollama_mod.OllamaClient(session=session)
    models = client.list_models()
    assert models == [
        {"name": "qwen3.5:9b", "size": 6144, "modified_at": "2026-10-11T11:53:00+08:00"},
        {"name": "legacy:1b", "size": 3, "modified_at": ""},
    ]
    assert session.requests[0]["method"] == "GET"
    assert session.requests[0]["url"].endswith("/api/tags")


def test_ollama_model_names_helper():
    session = FakeSession(FakeResponse({"models": [{"name": "a:1"}, {"name": "b:2"}]}))
    client = ollama_mod.OllamaClient(session=session)
    assert client.model_names() == ["a:1", "b:2"]


def test_ollama_base_url_normalization():
    client = ollama_mod.OllamaClient(base_url="http://127.0.0.1:11434/")
    assert client.base_url == "http://127.0.0.1:11434"
    assert client.url("/api/tags") == "http://127.0.0.1:11434/api/tags"


# --------------------------------------------------------------------------- 自跑
if __name__ == "__main__":  # pragma: no cover - 没有 pytest 时的本地入口
    import traceback

    failed = []
    tests = [(name, obj) for name, obj in sorted(globals().items()) if name.startswith("test_") and callable(obj)]
    for name, test in tests:
        try:
            test()
        except Exception:  # noqa: BLE001
            failed.append(name)
            print(f"FAIL {name}")
            traceback.print_exc()
        else:
            print(f"PASS {name}")
    print(f"\n{len(tests) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)
