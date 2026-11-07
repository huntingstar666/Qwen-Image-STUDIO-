"""O1：去水印提示词补全（文字水印 → 文字 + 徽章 + 编号）。"""

from __future__ import annotations

from server.pipeline import augment_watermark_prompt


def test_watermark_prompt_appends_scope():
    prompt = augment_watermark_prompt("移除画面中的水印")
    assert prompt is not None
    assert prompt.startswith("移除画面中的水印")
    assert "徽章" in prompt and "编号" in prompt


def test_watermark_prompt_skips_when_scope_named():
    assert augment_watermark_prompt("移除画面中的水印和徽章") is None
    assert augment_watermark_prompt("remove the watermark and badge") is None


def test_watermark_prompt_respects_text_only_switch():
    params = {"task": {"watermark_scope": "text"}}
    assert augment_watermark_prompt("移除画面中的水印", params) is None
    assert augment_watermark_prompt("移除画面中的水印", {"watermark_scope": "text_only"}) is None


def test_watermark_prompt_requires_remove_intent():
    assert augment_watermark_prompt("水印区域有一块反光，请保留") is None
    assert augment_watermark_prompt("把水印换成金色") is None


def test_watermark_prompt_ignores_unrelated_prompt():
    assert augment_watermark_prompt("把马克杯换成玻璃杯") is None
    assert augment_watermark_prompt("") is None


def test_watermark_prompt_english():
    prompt = augment_watermark_prompt("remove the watermark from the picture")
    assert prompt is not None
    assert "badge" in prompt or "徽章" in prompt
