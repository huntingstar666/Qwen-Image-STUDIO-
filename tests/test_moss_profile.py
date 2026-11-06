# -*- coding: utf-8 -*-
"""MOSS 接入相关单元测试：模型档案 / 移植的节点逻辑 / 润色提示词。

只测纯函数与请求解析，不加载任何权重、不发网络请求。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import config, models, moss, pipeline, prompt_polish  # noqa: E402


# --------------------------------------------------------------------------- 分辨率


def test_resolution_selector_matches_workflow():
    # 参考工作流：16:9 / 2MP / multiple 16 → 1936×1088（2.11MP）
    assert moss.resolution_size("16:9", 2.0, multiple=16) == (1936, 1088)
    # 带后缀的写法也要能解析
    assert moss.parse_ratio("16:9 (Widescreen)") == (16, 9)
    assert moss.parse_ratio("3:4") == (3, 4)
    width, height = moss.resolution_size("3:4", 2.0, multiple=8)
    assert width % 8 == 0 and height % 8 == 0
    assert height > width


# --------------------------------------------------------------------------- 边界框


def test_boxes_from_pixels_to_regions_and_elements():
    boxes = moss.boxes_from_input(
        [{"x": 100, "y": 200, "width": 500, "height": 400,
          "metadata": {"type": "text", "text": "清凉一夏", "desc": "标题字"}}],
        1000, 1000)
    regions = moss.boxes_to_regions(boxes, 1000, 1000)
    elements = moss.build_elements(regions)
    assert elements[0]["bbox"] == [200, 100, 600, 600]  # [ymin, xmin, ymax, xmax]
    assert elements[0]["type"] == "text"
    assert elements[0]["text"] == "清凉一夏"


def test_elements_input_is_normalized():
    # 已经是 0..1000 element 的写法（id 形式）也要支持
    boxes = moss.boxes_from_input(
        [{"type": "obj", "bbox": [100, 200, 600, 700], "desc": "云"}], 1000, 1000)
    regions = moss.boxes_to_regions(boxes, 1000, 1000)
    elements = moss.build_elements(regions)
    assert elements[0]["bbox"] == [100, 200, 600, 700]
    assert elements[0]["desc"] == "云"


def test_layout_prompt_matches_node_math():
    elements = [{"type": "obj", "bbox": [100, 200, 600, 700], "desc": "白云"}]
    text = moss.layout_prompt("蓝天白云", elements, 1000, 1000, character_boxes="1")
    payload = json.loads(text)
    assert payload["bbox_coord_space"] == "abs_centralized"
    assert payload["bbox_format"] == "yxyx"
    assert payload["summary"]["caption"] == "蓝天白云"
    item = payload["items"][0]
    assert item["label"] == "character"
    # 中心原点：y 100..600 → -400..100；x 200..700 → -300..200
    assert item["bbox"] == [-400, -300, 100, 200]


def test_layout_prompt_without_items_returns_prompt():
    assert moss.layout_prompt("原样", [], 1024, 1024) == "原样"


def test_build_layout_prompt_from_request():
    payload = {
        "enabled": True,
        "canvas": [1000, 1000],
        "character_boxes": "1",
        "items": [{"x": 0, "y": 0, "width": 500, "height": 500, "desc": "左上"}],
    }
    text, info = moss.build_layout_prompt("画面", payload, 1024, 1024)
    assert info["enabled"] and info["items"] == 1
    item = json.loads(text)["items"][0]
    # 0..500/1000 → 0..512 px，中心 512
    assert item["bbox"] == [-512, -512, 0, 0]


def test_slg_defaults_off():
    assert moss.slg_config(None, True) is None
    cfg = {"single_layers": "22", "start_percent": 0.0, "end_percent": 0.5}
    assert moss.slg_config(cfg, None) is None
    assert moss.slg_config(cfg, False) is None
    merged = moss.slg_config(cfg, {"enabled": True})
    assert merged["single_layers"] == "22"
    assert moss.slg_config(cfg, {"enabled": False}) is None


# --------------------------------------------------------------------------- 模型档案


def test_moss_profile_defaults():
    cfg = config.load_config()
    profile = models.get(cfg, "moss")
    assert profile["latent_channels"] == 128
    assert profile["snap"] == 16
    assert profile["steps"] == 50
    assert profile["cfg"] == 3.5
    assert profile["sampler"] == "er_sde"
    assert profile["negative_prompt"] == "bad quality,"
    assert profile["capabilities"]["bbox"] is True
    assert profile["capabilities"]["edit"] is False
    accel = profile["accelerator"]
    assert accel["kind"] == "lora"
    assert accel["steps"] == 8 and accel["cfg"] == 1.0
    assert models.get(cfg, "qwen")["latent_channels"] == 64


def test_profile_aliases_and_public_list():
    assert models.normalize_model("moss-image") == "moss"
    assert models.normalize_model(None) == "qwen"
    try:
        models.normalize_model("sdxl")
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("未知模型应抛 ValueError")
    public = models.public_list(config.load_config())
    assert [item["id"] for item in public] == ["qwen", "moss"]


def test_sampling_plan_moss_default_and_accelerated():
    cfg = config.load_config()
    profile = models.get(cfg, "moss")
    base = pipeline._sampling_plan({}, cfg, profile)
    assert (base["steps"], base["cfg"], base["sampler"]) == (50, 3.5, "er_sde")
    assert base["negative_prompt"] == "bad quality,"
    fast = pipeline._sampling_plan({"turbo": {"enabled": True}}, cfg, profile)
    assert (fast["steps"], fast["cfg"], fast["sampler"], fast["scheduler"]) == \
        (8, 1.0, "euler", "simple")
    # 显式负向（哪怕空串）不被模型默认值覆盖
    assert pipeline._sampling_plan({"negative_prompt": ""}, cfg, profile)["negative_prompt"] == ""


def test_t2i_size_moss_ratio():
    cfg = config.load_config()
    profile = models.get(cfg, "moss")
    assert pipeline._t2i_size(cfg, {"ratio": "16:9", "megapixels": 2.0}, profile) == (1936, 1088)
    assert pipeline._t2i_size(cfg, {"width": 1000, "height": 772}, profile) == (992, 768)


# --------------------------------------------------------------------------- 润色


def test_moss_system_prompt_is_own_pe():
    moss_prompt = prompt_polish.load_system_prompt("t2i", "moss")
    qwen_prompt = prompt_polish.load_system_prompt("t2i", "qwen")
    assert moss_prompt and qwen_prompt and moss_prompt != qwen_prompt
    assert "MOSS" in moss_prompt or "Layout" in moss_prompt
    assert prompt_polish.normalize_image_model("moss-image") == "moss"
    assert prompt_polish.normalize_image_model("unknown") == "qwen"


def test_build_messages_injects_sizes():
    messages = prompt_polish.build_messages(
        "一只猫", "t2i", image_model="moss",
        target_size=(1920, 1088),
        references=[{"name": "image1", "width": 768, "height": 1024, "description": "白猫"}],
    )
    assert messages[0]["role"] == "system"
    user = messages[1]["content"]
    assert "1920×1088" in user
    assert "768×1024" in user
    assert "白猫" in user
    assert "1920×1088" in messages[0]["content"] + user


def test_parse_moss_caption_and_layout():
    caption = prompt_polish.parse_polish_output('{"caption": "蓝天下的白猫"}', "moss")
    assert caption["rewritten_prompt"] == "蓝天下的白猫"

    layout = {
        "width": 1024, "height": 1024, "bbox_coord_space": "abs",
        "bbox_format": "xyxy", "summary": {"caption": "海报"},
        "items": [{"label": "text", "caption": "标题", "text": "夏日", "bbox": [0, 0, 100, 100]}],
    }
    parsed = prompt_polish.parse_polish_output(json.dumps(layout, ensure_ascii=False), "moss")
    assert json.loads(parsed["rewritten_prompt"])["items"][0]["text"] == "夏日"
    assert parsed["parse"] == "json"


def test_parse_qwen_still_accepts_rewritten_prompt():
    parsed = prompt_polish.parse_polish_output('{"rewritten_prompt": "描述"}', "qwen")
    assert parsed["rewritten_prompt"] == "描述"
