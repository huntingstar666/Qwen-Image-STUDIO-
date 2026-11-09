from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from video_studio.core import images, prompts, schema, segments, subtitle  # noqa: E402


# --------------------------------------------------------------------------- 字幕


SRT = """1
00:00:00,000 --> 00:00:01,500
第一句台词

2
00:00:01,700 --> 00:00:03,000
第二句台词
"""


def test_parse_srt() -> None:
    parsed = subtitle.parse(SRT.encode("utf-8"), "a.srt")
    assert parsed["format"] == "srt"
    assert len(parsed["cues"]) == 2
    assert parsed["cues"][1]["startMs"] == 1700
    assert parsed["cues"][1]["id"] == "c2"


def test_parse_vtt_with_settings() -> None:
    text = """WEBVTT

00:01.000 --> 00:02.500 align:middle
你好

00:03.000 --> 00:04.000
世界
"""
    parsed = subtitle.parse(text.encode("utf-8"), "a.vtt")
    assert parsed["format"] == "vtt"
    assert parsed["cues"][0]["startMs"] == 1000
    assert parsed["cues"][0]["text"] == "你好"


def test_parse_ass_strips_tags() -> None:
    text = """[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.50,Default,,0,0,0,,{\\i1}第一句\\N第二行
"""
    parsed = subtitle.parse(text.encode("utf-8"), "a.ass")
    assert parsed["format"] == "ass"
    assert parsed["cues"][0]["endMs"] == 2500
    assert parsed["cues"][0]["text"] == "第一句\n第二行"


def test_build_ass_shifts_offset() -> None:
    cues = [{"startMs": 1000, "endMs": 2000, "text": "你好"}]
    text = subtitle.build_ass(cues, {"size": 46, "position": "bottom"},
                              width=1920, height=1080, offset_ms=1000, duration_ms=2000)
    assert "PlayResX: 1920" in text
    assert "Dialogue: 0,0:00:00.00,0:00:01.00" in text


def test_build_ass_uses_chosen_font() -> None:
    cues = [{"startMs": 0, "endMs": 1000, "text": "你好"}]
    text = subtitle.build_ass(cues, {"fontId": "simhei", "size": 40}, width=1280, height=720)
    assert "Style: Default,SimHei," in text
    bold = subtitle.build_ass(cues, {"fontId": "msyhbd", "size": 40}, width=1280, height=720)
    assert "Style: Default,Microsoft YaHei," in bold
    assert ",&H80000000,1," in bold


# --------------------------------------------------------------------------- 分段


def test_derive_tiles_entire_timeline() -> None:
    cues = subtitle.normalize_cues([
        {"startMs": 0, "endMs": 1500, "text": "一"},
        {"startMs": 1600, "endMs": 3000, "text": "二"},
        {"startMs": 5000, "endMs": 6000, "text": "三"},
    ])
    shots = segments.derive(cues, duration_ms=7000, fps=30, merge_gap_ms=350, max_shot_ms=8000)
    assert shots[0]["startMs"] == 0
    assert shots[-1]["endMs"] == 7000
    for left, right in zip(shots, shots[1:]):
        assert left["endMs"] == right["startMs"]
    # 1.5s 与 1.6s 间隔 100ms，应合并；5s 处是新段
    assert len(shots) == 2


def test_derive_never_splits_a_cue() -> None:
    cues = subtitle.normalize_cues([
        {"startMs": 0, "endMs": 2000, "text": "甲"},
        {"startMs": 2000, "endMs": 12000, "text": "乙"},
    ])
    shots = segments.derive(cues, duration_ms=12000, fps=30, merge_gap_ms=350, max_shot_ms=4000)
    assert len(shots) == 2
    assert shots[1]["startMs"] == 2000
    assert shots[1]["endMs"] == 12000


def test_derive_snaps_to_silence() -> None:
    cues = subtitle.normalize_cues([
        {"startMs": 0, "endMs": 2000, "text": "甲"},
        {"startMs": 2400, "endMs": 4000, "text": "乙"},
    ])
    # 静音区间 2050~2250，中点 2150，距 2400 只有 250ms；吸附后再对齐到 30fps 帧
    shots = segments.derive(cues, duration_ms=5000, fps=30, merge_gap_ms=100,
                            max_shot_ms=8000, silences=[(2050, 2250)], snap_window_ms=300)
    assert abs(shots[1]["startMs"] - 2150) <= 34
    assert shots[1]["startMs"] != 2400


def test_retime_moves_next_boundary() -> None:
    cues = subtitle.normalize_cues([
        {"startMs": 0, "endMs": 1000, "text": "甲"},
        {"startMs": 1100, "endMs": 2000, "text": "乙"},
        {"startMs": 2200, "endMs": 3000, "text": "丙"},
    ])
    shots = segments.derive(cues, duration_ms=3000, fps=30, merge_gap_ms=0, max_shot_ms=8000)
    assert len(shots) == 3
    shots = segments.retime(shots, shots[0]["id"], {"endMs": 1500}, 3000)
    assert shots[0]["endMs"] == 1500
    assert shots[1]["startMs"] == 1500


# --------------------------------------------------------------------------- 提示词


def _project() -> dict:
    project = schema.default_project("测试")
    project["locks"]["style"]["prefix"] = "冷色调赛博朋克"
    project["locks"]["style"]["suffix"] = "电影感，35mm 胶片"
    project["locks"]["style"]["negative"] = "过曝"
    project["locks"]["content"]["entities"] = [
        {"id": "e1", "kind": "character", "name": "小林", "desc": "短发，深蓝工装"},
        {"id": "e2", "kind": "location", "name": "夜班车间", "desc": "冷白顶灯，铁灰设备"},
    ]
    return project


def test_assemble_prompt_order_and_entities() -> None:
    project = _project()
    shot = schema.new_shot(0, 0, 2000, "小林走进夜班车间")
    shot["description"] = "小林推门进入车间，抬头看向亮着的设备"
    shot["note"] = "中景，平视"
    shot["usedEntities"] = ["e2", "e1"]
    prompt, negative = prompts.assemble_prompt(project, shot)
    assert prompt.startswith("冷色调赛博朋克")
    assert "场景「夜班车间」" in prompt
    assert "角色「小林」" in prompt
    assert prompt.endswith("电影感，35mm 胶片")
    assert "过曝" in negative and "水印" in negative


def test_assemble_prompt_detects_entity_from_dialogue() -> None:
    project = _project()
    shot = schema.new_shot(0, 0, 2000, "小林，把灯打开")
    shot["description"] = "人物伸手去按开关"
    prompt, _ = prompts.assemble_prompt(project, shot)
    assert "角色「小林」" in prompt


def test_template_description_mentions_entities() -> None:
    project = _project()
    shot = schema.new_shot(0, 0, 2000, "小林站在夜班车间门口")
    text = prompts.template_description(project, shot)
    assert "小林" in text and "夜班车间" in text
    # 台词没提到的实体不会被塞进画面描述
    other = schema.new_shot(1, 2000, 3000, "他推开门")
    assert "小林" not in prompts.template_description(project, other)


def test_parse_shots_accepts_fenced_json() -> None:
    raw = '```json\n{"shots":[{"id":"s1","description":"雨夜街头","usedEntities":[],"note":"远景"}]}\n```'
    items = prompts._parse_shots(raw)
    assert items[0]["description"] == "雨夜街头"


def test_parse_shots_rejects_non_json() -> None:
    from video_studio.core.errors import StudioError
    with pytest.raises(StudioError):
        prompts._parse_shots("我觉得可以")


def test_apply_defaults_migrates_old_document() -> None:
    project = {
        "id": "vid-old", "name": "老项目",
        "canvas": {"ratio": "9:16", "width": 1080, "height": 1920, "fps": 30},
        "shots": [{"id": "s1", "startMs": 0, "endMs": 1000, "text": "旧台词"}],
    }
    schema.apply_defaults(project)
    assert project["canvas"]["longSide"] == 1080
    assert "width" not in project["canvas"] and "height" not in project["canvas"]
    assert project["render"]["subtitle"]["enabled"] is True
    assert project["locks"]["style"]["enabled"] is True
    assert project["shots"][0]["motion"]["type"] == "push"
    assert project["shots"][0]["transition"]["type"] == "cut"


def test_apply_defaults_migrates_kenburns_motion() -> None:
    project = {
        "id": "vid-old", "name": "老项目",
        "canvas": {"ratio": "16:9", "longSide": 1920, "fps": 30},
        "shots": [{
            "id": "s1", "startMs": 0, "endMs": 1000, "text": "旧台词",
            "motion": {"type": "kenburns", "zoom": 1.08, "panX": 0.2, "panY": 0},
        }],
    }
    schema.apply_defaults(project)
    assert project["shots"][0]["motion"] == {"type": "push", "zoom": 1.08}


def test_motion_state_is_continuous_and_in_bounds() -> None:
    from video_studio.core import render
    base_w, base_h = 3840, 2160
    for kind in schema.MOTIONS:
        for step in range(11):
            zoom, x, y = render._motion_state(kind, 1.12, step / 10, base_w, base_h)
            assert zoom >= 1.0
            assert 0 <= x <= base_w - base_w / zoom + 1e-6
            assert 0 <= y <= base_h - base_h / zoom + 1e-6

    push = [render._motion_state("push", 1.12, step / 10, base_w, base_h)[0] for step in range(11)]
    pull = [render._motion_state("pull", 1.12, step / 10, base_w, base_h)[0] for step in range(11)]
    assert all(b >= a for a, b in zip(push, push[1:]))     # 慢推单调放大
    assert all(b <= a for a, b in zip(pull, pull[1:]))     # 慢拉单调缩小
    assert abs(push[-1] - 1.12) < 1e-9 and abs(pull[-1] - 1.0) < 1e-9

    left = [render._motion_state("left", 1.09, step / 10, base_w, base_h)[1] for step in range(11)]
    right = [render._motion_state("right", 1.09, step / 10, base_w, base_h)[1] for step in range(11)]
    up = [render._motion_state("up", 1.09, step / 10, base_w, base_h)[2] for step in range(11)]
    down = [render._motion_state("down", 1.09, step / 10, base_w, base_h)[2] for step in range(11)]
    assert all(b < a for a, b in zip(left, left[1:]))
    assert all(b > a for a, b in zip(right, right[1:]))
    assert all(b < a for a, b in zip(up, up[1:]))
    assert all(b > a for a, b in zip(down, down[1:]))


def test_transition_centering_keeps_total_duration() -> None:
    from video_studio.core import render
    project = schema.default_project("转场")
    project["canvas"]["fps"] = 30
    shots = []
    for index in range(3):
        shot = schema.new_shot(index, index * 1000, (index + 1) * 1000, f"第{index + 1}句")
        shot["image"] = f"images/s{index + 1}.png"
        if index > 0:
            shot["transition"] = {"type": "fade", "durationMs": 300}
        shots.append(shot)
    project["shots"] = shots
    plan = render.timeline(project)
    assert plan["totalFrames"] == 90  # 3 秒 × 30fps，转场不吃时长
    for item in plan["items"]:
        assert item["renderFrames"] == item["frames"] + item["headFrames"] + item["tailFrames"]
    # 切点两侧各让出半个转场，两半相加正好一个转场（9 帧 @30fps）
    assert plan["items"][0]["tailFrames"] + plan["items"][1]["headFrames"] == 9


def test_keyframes_avoid_static_motion_and_land_on_transitions() -> None:
    """I 帧不能落在匀速运镜中间，否则每 250 帧会「闪一下」。"""
    from video_studio.core import render
    project = schema.default_project("关键帧")
    project["canvas"]["fps"] = 30
    shots = []
    for index in range(3):
        shot = schema.new_shot(index, index * 2000, (index + 1) * 2000, f"第{index + 1}句")
        shot["image"] = f"images/s{index + 1}.png"
        shot["transition"] = ({"type": "cut"} if index == 0
                              else {"type": "fade", "durationMs": 400})
        shots.append(shot)
    project["shots"] = shots
    plan = render.timeline(project)
    boundaries = render._shot_boundaries(plan)

    assert len(boundaries) == 2
    for item, boundary in zip(plan["items"][1:], boundaries):
        assert item["fadeStartFrame"] < item["cutFrame"]  # 淡入淡出
        middle = (item["cutFrame"] + item["fadeStartFrame"]) / 2 / plan["fps"]
        assert abs(boundary - middle) <= 1.0 / plan["fps"]
        # 落在转场里，而不是静止画面上
        assert item["fadeStartFrame"] / plan["fps"] <= boundary <= item["cutFrame"] / plan["fps"]


def test_continuity_carries_character_to_unnamed_shot() -> None:
    project = _project()
    project["shots"] = [
        schema.new_shot(0, 0, 2000, "小林把灯打开"),
        schema.new_shot(1, 2000, 4000, "他叹了口气"),
        schema.new_shot(2, 4000, 6000, "夜班车间空无一人"),
    ]
    prompts.assemble_all(project)
    assert project["shots"][0]["usedEntities"] == ["e1"]
    # 第二段没有点名，沿用上一段的角色
    assert project["shots"][1]["usedEntities"] == ["e1"]
    assert "角色「小林」" in project["shots"][1]["prompt"]
    # 第三段显式提到场景，不再带人物
    assert project["shots"][2]["usedEntities"] == ["e2"]


# --------------------------------------------------------------------------- 合并 / 拆分


def _cues() -> list[dict]:
    return subtitle.normalize_cues([
        {"startMs": 0, "endMs": 1500, "text": "第一句"},
        {"startMs": 1700, "endMs": 3000, "text": "第二句"},
        {"startMs": 3200, "endMs": 5000, "text": "第三句"},
    ])


def _shots_from_cues() -> list[dict]:
    cues = _cues()
    return segments.derive(cues, duration_ms=6000, fps=30, merge_gap_ms=0, max_shot_ms=8000)


def test_reconcile_texts_follows_cues_after_retime() -> None:
    shots = _shots_from_cues()
    # 把第二、三句圈进同一段：自动台词应变成两句
    shots = segments.retime(shots, shots[1]["id"], {"endMs": 5100}, 6000)
    segments.reconcile_texts(shots, _cues())
    assert shots[1]["text"] == "第二句\n第三句"
    assert shots[1]["textMode"] == "auto"


def test_reconcile_texts_skips_manual_and_warns_missing() -> None:
    shots = _shots_from_cues()
    shots[1]["textMode"] = "manual"
    shots[1]["text"] = "我自己写的台词"
    segments.reconcile_texts(shots, _cues())
    assert shots[1]["text"] == "我自己写的台词"
    # 手动段不参与自动重算；自动段没有 cue 时保留原文并警告
    assert "本段没有覆盖字幕" not in shots[1]["warnings"]


def test_merge_shots_keeps_duration_and_text() -> None:
    shots = _shots_from_cues()
    shots[0]["image"] = "images/s1.png"
    shots[0]["status"] = "ready"
    shots[0]["imageHistory"] = [{"file": "images/s1.png", "at": "2026-11-09 10:00:00"}]
    shots[1]["image"] = "images/s2.png"
    shots[1]["status"] = "ready"
    shots[1]["imageHistory"] = [{"file": "images/s2.png", "at": "2026-11-09 10:01:00"}]
    merged = segments.merge_shots(shots, [shots[0]["id"], shots[1]["id"]],
                                  duration_ms=6000, fps=30, cues=_cues())
    assert len(merged) == 2
    assert merged[0]["startMs"] == 0
    assert merged[0]["endMs"] == shots[1]["endMs"]
    assert merged[1]["endMs"] == 6000
    assert merged[0]["text"] == "第一句\n第二句"
    assert merged[0]["image"] == "images/s1.png"
    assert merged[0]["status"] == "ready"
    assert merged[0]["review"]["prompt"] is True
    assert merged[0]["review"]["image"] is True
    # 图片历史迁移，当前图仍在历史里
    files = [item["file"] for item in merged[0]["imageHistory"]]
    assert "images/s1.png" in files and "images/s2.png" in files


def test_merge_shots_rejects_gap() -> None:
    from video_studio.core.errors import StudioError
    shots = _shots_from_cues()
    with pytest.raises(StudioError):
        segments.merge_shots(shots, [shots[0]["id"], shots[2]["id"]],
                             duration_ms=6000, fps=30, cues=_cues())


def test_split_at_keeps_total_and_does_not_split_text() -> None:
    shots = _shots_from_cues()
    source = shots[1]
    original_text = source["text"]
    total = sum(shot["endMs"] - shot["startMs"] for shot in shots)
    result = segments.split_shot_at(shots, source["id"], 2400,
                                    duration_ms=6000, fps=30, cues=_cues())
    assert len(result) == 4
    assert sum(shot["endMs"] - shot["startMs"] for shot in result) == total
    for left, right in zip(result, result[1:]):
        assert left["endMs"] == right["startMs"]
    left, right = result[1], result[2]
    assert left["text"] == original_text and right["text"] == original_text
    assert right["image"] == "" and right["status"] == "pending"
    assert right["review"]["image"] is True
    assert left["review"]["prompt"] is True


def test_split_snaps_to_cue_boundary_and_recomputes_text() -> None:
    shots = [
        schema.new_shot(0, 0, 3200, "第一句\n第二句"),
        schema.new_shot(1, 3200, 6000, "第三句"),
    ]
    result = segments.split_shot_at(shots, "s1", 1460,
                                    duration_ms=6000, fps=30, cues=_cues(),
                                    snap_window_ms=120)
    left, right = result[0], result[1]
    assert left["endMs"] == right["startMs"] == 1500
    assert left["textMode"] == "auto" and right["textMode"] == "auto"
    assert left["text"] == "第一句" and right["text"] == "第二句"


def test_split_parts_numbers_beats_and_keeps_duration() -> None:
    shots = _shots_from_cues()
    source = shots[1]
    total = sum(shot["endMs"] - shot["startMs"] for shot in shots)
    result = segments.split_shot_parts(shots, source["id"], 3, duration_ms=6000, fps=30)
    group = result[1:4]
    assert [item["beat"]["index"] for item in group] == [1, 2, 3]
    assert all(item["beat"]["count"] == 3 for item in group)
    assert group[0]["text"] == source["text"]
    assert all(item["text"] == source["text"] for item in group)
    assert group[0]["startMs"] == source["startMs"]
    assert group[-1]["endMs"] == source["endMs"]
    assert sum(shot["endMs"] - shot["startMs"] for shot in result) == total


def test_review_mark_and_clear() -> None:
    shot = schema.new_shot(0, 0, 1000, "台词")
    segments.mark_review(shot, prompt=True, image=True, reason="split")
    assert shot["review"]["prompt"] is True and shot["review"]["image"] is True
    assert shot["review"]["reason"] == "split"
    segments.clear_review(shot, ["prompt"])
    assert "prompt" not in shot["review"] and shot["review"]["image"] is True
    segments.clear_review(shot, ["image"])
    assert "review" not in shot


def test_directive_is_appended_to_prompt() -> None:
    project = _project()
    shot = schema.new_shot(0, 0, 2000, "台词")
    shot["description"] = "人物抬头看向灯光"
    shot["note"] = "中景，平视"
    shot["directive"] = "让雨更大，人物不要看镜头"
    prompt, _ = prompts.assemble_prompt(project, shot)
    assert "让雨更大" in prompt
    assert prompt.index("中景") < prompt.index("让雨更大")


def test_new_shot_has_text_mode_and_beat() -> None:
    shot = schema.new_shot(0, 0, 1000, "台词")
    assert shot["textMode"] == "auto" and shot["beat"] is None
    assert shot["directive"] == ""
    assert "review" not in shot


# --------------------------------------------------------------------------- 注册表


def test_schema_rejects_unknown_field() -> None:
    with pytest.raises(ValueError):
        schema.validate_patch({"canvas": {"ratio": "16:9", "nope": 1}})


def test_schema_clamps_numbers() -> None:
    patch = schema.validate_patch({"render": {"export": {"crf": 99}}})
    assert patch["render"]["export"]["crf"] == 32


def test_image_and_canvas_size_follow_ratio() -> None:
    from video_studio.core import images
    project = schema.default_project("比例")
    project["canvas"]["ratio"] = "9:16"
    width, height = images.image_size(project)
    assert height > width
    assert width % 32 == 0 and height % 32 == 0
    width, height = images.canvas_size(project)
    assert height > width
    assert width % 2 == 0 and height % 2 == 0


# --------------------------------------------------------------------------- 资产图片锚定


def test_asset_ref_images_roundtrip() -> None:
    patch = schema.validate_patch({"locks": {"content": {"entities": [{
        "id": "e1", "kind": "character", "name": "小林", "desc": "短发",
        "refImages": ["assets/e1_v1.png"],
    }]}}})
    entity = patch["locks"]["content"]["entities"][0]
    assert entity["refImages"] == ["assets/e1_v1.png"]
    assert "refUrls" not in entity


def test_apply_defaults_adds_asset_ref_images() -> None:
    project = schema.default_project("旧项目")
    project["locks"]["content"]["entities"] = [
        {"id": "e1", "kind": "character", "name": "小林", "desc": "短发"},
    ]
    schema.apply_defaults(project)
    assert project["locks"]["content"]["entities"][0]["refImages"] == []
    assert project["locks"]["content"]["imageAnchor"] is True


def test_build_anchor_payload_uses_base_and_assets() -> None:
    project = schema.default_project("锚定")
    shot = {"id": "s1", "negative": "过曝"}
    refs = [{
        "id": "e1", "kind": "character", "name": "小林",
        "desc": "短发，深蓝工装", "data": b"\x89PNG\r\n\x1a\nref",
    }]
    payload = images.build_anchor_payload(
        project, shot, b"\x89PNG\r\n\x1a\nbase", refs, seed=7)
    assert len(payload["images"]) == 2
    assert payload["images"][0]["data"].startswith("data:image/png;base64,")
    assert payload["seed"] == 7
    assert payload["meta"]["anchor"] is True
    assert "图2" in payload["prompt"]
    assert "小林" in payload["prompt"]


def test_anchor_prompt_groups_multiple_refs_of_same_asset() -> None:
    refs = [
        {"id": "e1", "kind": "character", "name": "小林", "desc": "", "data": b"a"},
        {"id": "e1", "kind": "character", "name": "小林", "desc": "", "data": b"b"},
    ]
    prompt = images.build_anchor_prompt(refs)
    assert "图2、图3" in prompt
    assert prompt.count("人物「小林」") == 1
