# -*- coding: utf-8 -*-
"""``server/styles.py`` 的单元测试（pytest 风格，纯逻辑，不发网络请求）。

覆盖契约 2.4 / 4.4 的验收点：

* ``compose_prompt`` 的拼接顺序与空值处理（创意前缀 → 正文 → 创意后缀 → MJ 归并 → 视角）；
* ``normalize_mj_prompt`` 的参数归并、别名、叠加去重与 ``--preview`` 清理；
* ``angle_prompt`` 的八方向 / 俯仰 / 距离文案（并与 vendor 里的 ``imageAngle.js`` 交叉校验）；
* ``load_catalogs`` 读取真实目录数据的结构与数量。

文件末尾带 ``__main__`` 自跑块：本机没有 pytest 时可直接
``$PY tests/test_styles.py`` 验证。
"""

from __future__ import annotations

import json
import shutil
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # 支持 `python tests/test_styles.py` 直接运行
    sys.path.insert(0, str(ROOT))

from server import styles  # noqa: E402

VENDOR_ANGLE_JS = ROOT / "web" / "vendor" / "image-style-kit" / "src" / "imageAngle.js"


def _preset(preset_id, kind="style", name=None, prompt="预设提示词", prefix=None):
    preset = {
        "id": preset_id,
        "kind": kind,
        "category": "测试分类",
        "name": name or preset_id,
        "description": "测试描述",
        "prompt": prompt,
    }
    if prefix is not None:
        preset["prefix"] = prefix
    return preset


def _make_data_dir(tmp_root: Path) -> Path:
    """在 workspace 内建临时目录。

    不能用 ``tempfile.mkdtemp``：它建的目录带 0700 显式 ACL，在 DSH 沙箱下
    子进程再写入会被拒。这里用普通 ``mkdir``（继承父目录 ACL）＋随机后缀，
    用完 ``shutil.rmtree(ignore_errors=True)``。
    """
    tmp_root.mkdir(parents=True, exist_ok=True)
    directory = tmp_root / f".tmp_styles_{uuid.uuid4().hex}"
    directory.mkdir(parents=False, exist_ok=False)
    return directory


# --------------------------------------------------------------------------- 视角
def test_angle_prompt_requires_all_three_numbers():
    assert styles.angle_prompt(None) == ""
    assert styles.angle_prompt({}) == ""
    assert styles.angle_prompt({"azimuth": 0, "elevation": 0}) == ""
    assert styles.angle_prompt({"azimuth": "0", "elevation": 0, "zoom": 5}) == ""
    assert styles.angle_prompt({"azimuth": True, "elevation": 0, "zoom": 5}) == ""
    assert styles.angle_prompt({"azimuth": float("nan"), "elevation": 0, "zoom": 5}) == ""
    assert styles.angle_prompt({"azimuth": 0, "elevation": 0, "zoom": 5}) != ""


def test_angle_direction_eight_ways():
    expected = [
        (0, "正面"),
        (45, "右前侧"),
        (90, "右侧"),
        (135, "右后侧"),
        (180, "背面"),
        (225, "左后侧"),
        (270, "左侧"),
        (315, "左前侧"),
    ]
    for azimuth, direction in expected:
        described = styles.image_angle_description({"azimuth": azimuth, "elevation": 0, "zoom": 5})
        assert described["direction"] == direction, (azimuth, described["direction"], direction)


def test_angle_direction_wraps_and_boundaries():
    # 337.5° 是"左前侧 / 正面"的分界：337 仍是左前侧，338 回到正面。
    assert styles.image_angle_description({"azimuth": 337, "elevation": 0, "zoom": 5})["direction"] == "左前侧"
    assert styles.image_angle_description({"azimuth": 338, "elevation": 0, "zoom": 5})["direction"] == "正面"
    assert styles.image_angle_description({"azimuth": 22, "elevation": 0, "zoom": 5})["direction"] == "正面"
    assert styles.image_angle_description({"azimuth": 23, "elevation": 0, "zoom": 5})["direction"] == "右前侧"
    # 超出 0-359 自动回绕。
    assert styles.image_angle_description({"azimuth": 450, "elevation": 0, "zoom": 5})["direction"] == "右侧"
    assert styles.image_angle_description({"azimuth": -90, "elevation": 0, "zoom": 5})["direction"] == "左侧"


def test_angle_elevation_bands():
    cases = [
        (-30, "低机位仰视"),
        (-16, "低机位仰视"),
        (-15, "平视"),
        (0, "平视"),
        (14, "平视"),
        (15, "抬高机位俯视"),
        (44, "抬高机位俯视"),
        (45, "高机位俯拍"),
        (60, "高机位俯拍"),
        (100, "高机位俯拍"),   # clamp 到 60
        (-100, "低机位仰视"),  # clamp 到 -30
    ]
    for elevation, expected in cases:
        described = styles.image_angle_description({"azimuth": 0, "elevation": elevation, "zoom": 5})
        assert described["elevation"] == expected, (elevation, described["elevation"])


def test_angle_distance_bands():
    cases = [
        (0, "远景"),
        (1.9, "远景"),
        (2, "中景"),
        (5.9, "中景"),
        (6, "近景"),
        (10, "近景"),
        (11, "近景"),   # clamp 到 10
        (-5, "远景"),   # clamp 到 0
    ]
    for zoom, expected in cases:
        described = styles.image_angle_description({"azimuth": 0, "elevation": 0, "zoom": zoom})
        assert described["distance"] == expected, (zoom, described["distance"])


def test_angle_prompt_text_format():
    text = styles.angle_prompt({"azimuth": 90, "elevation": 10, "zoom": 5})
    lines = text.split("\n")
    assert len(lines) == 3
    assert lines[0].startswith("根据参考图片重新呈现同一个主体，目标视角为主体的右侧，平视，中景构图。")
    assert "水平环绕 90°" in lines[1]
    assert "俯仰 10°" in lines[1]
    assert "取景靠近程度 5.0/10" in lines[1]
    assert "只改变相机观察方向、高度和取景距离" in lines[2]


def test_angle_prompt_text_matches_vendor_js():
    """视角中文文案必须与 vendor 的 imageAngle.js 逐字一致（防两边漂移）。"""
    assert VENDOR_ANGLE_JS.is_file(), f"vendor 文件缺失：{VENDOR_ANGLE_JS}"
    source = VENDOR_ANGLE_JS.read_text(encoding="utf-8")
    fragments = [
        "根据参考图片重新呈现同一个主体，目标视角为主体的",
        "构图。",
        "精确相机参数：水平环绕 ",
        "°（0°正面、90°主体右侧、180°背面、270°主体左侧），俯仰 ",
        "°（正值抬高机位向下看、负值降低机位向上看），取景靠近程度 ",
        "/10（0为远景、5为中景、10为特写）。按连续数值调整，不要量化为固定预设。",
        "只改变相机观察方向、高度和取景距离；保持主体身份、面部特征、服饰、道具、材质和画面风格一致。",
        "依据原图合理补全新视角可见的结构。不要用平面旋转、镜像或拉伸原图代替视角变化，",
        "不添加多视图拼版、文字或重复主体。以本段目标视角为准，其他内容要求保持不变。",
    ]
    for fragment in fragments:
        assert fragment in source, f"imageAngle.js 与 Python 文案不一致：{fragment}"


def test_angle_prompt_from_query():
    # GET /api/styles/angle-prompt 的 query 是字符串：宽松入口要能正确转型。
    numeric = styles.angle_prompt({"azimuth": 90, "elevation": 10, "zoom": 5})
    assert styles.angle_prompt_from_query("90", "10", "5") == numeric
    assert styles.angle_prompt_from_query(90.0, 10.0, 5.0) == numeric
    # 空串走默认值（azimuth=0, elevation=0, zoom=5）。
    assert styles.angle_prompt_from_query("", "", "") == styles.angle_prompt(
        {"azimuth": 0, "elevation": 0, "zoom": 5}
    )
    # 全缺省表示不启用视角。
    assert styles.angle_prompt_from_query() == ""
    assert styles.angle_prompt_from_query(None, None, None) == ""
    # 非法字符串退默认值，不抛异常。
    assert styles.angle_prompt_from_query("abc", "nope", "??") == styles.angle_prompt(
        {"azimuth": 0, "elevation": 0, "zoom": 5}
    )


def test_normalize_image_angle_wraps_and_clamps():
    angle = styles.normalize_image_angle({"azimuth": 370, "elevation": 100, "zoom": 5.55})
    assert angle == {"azimuth": 10, "elevation": 60, "zoom": 5.6}
    angle = styles.normalize_image_angle({"azimuth": -10, "elevation": -100, "zoom": 5.54})
    assert angle == {"azimuth": 350, "elevation": -30, "zoom": 5.5}
    angle = styles.normalize_image_angle({"azimuth": 359.6, "elevation": -30.4, "zoom": 11})
    assert angle == {"azimuth": 0, "elevation": -30, "zoom": 10.0}
    # 缺字段走默认值（js: azimuth=0, elevation=0, zoom=5）。
    assert styles.normalize_image_angle({}) == {"azimuth": 0, "elevation": 0, "zoom": 5}
    assert styles.normalize_image_angle({"azimuth": "45", "elevation": None, "zoom": 3}) == {
        "azimuth": 0,
        "elevation": 0,
        "zoom": 3,
    }


# --------------------------------------------------------------------------- MJ 参数
def test_normalize_mj_prompt_passthrough():
    assert styles.normalize_mj_prompt("  a photo of a cat  ") == "a photo of a cat"
    assert styles.normalize_mj_prompt("") == ""
    assert styles.normalize_mj_prompt(None) == ""


def test_normalize_mj_prompt_moves_parameters_to_end():
    result = styles.normalize_mj_prompt("a cat on a windowsill --ar 16:9 --stylize 50")
    lines = result.split("\n")
    assert lines[0] == "a cat on a windowsill"
    assert lines[1] == "--ar 16:9 --stylize 50"


def test_normalize_mj_prompt_scalar_last_wins():
    assert styles.normalize_mj_prompt("cat --ar 1:1 --ar 16:9") == "cat\n--ar 16:9"
    assert styles.normalize_mj_prompt("cat --v 6 --v 7") == "cat\n--v 7"


def test_normalize_mj_prompt_drops_preview():
    result = styles.normalize_mj_prompt("cat --ar 16:9 --preview upscaled --v 6")
    assert result == "cat\n--ar 16:9 --v 6"
    assert "--preview" not in result
    # --preview 在第一个参数位时也不能留下空正文。
    assert styles.normalize_mj_prompt("cat --preview --ar 16:9") == "cat\n--ar 16:9"


def test_normalize_mj_prompt_profile_alias_and_merge():
    result = styles.normalize_mj_prompt(
        "x --p abc --profile def --sref 123 --sref 456 123"
    )
    # --p / --personalize 归一到 --profile；--sref / --profile 叠加并去重。
    assert result == "x\n--profile abc def --sref 123 456"


def test_normalize_mj_prompt_flag_without_value():
    assert styles.normalize_mj_prompt("cat --hd --v 6") == "cat\n--hd --v 6"


def test_normalize_mj_prompt_case_insensitive_and_idempotent():
    once = styles.normalize_mj_prompt("cat --AR 16:9 --V 6")
    assert once == "cat\n--ar 16:9 --v 6"
    assert styles.normalize_mj_prompt(once) == once


def test_remove_mj_preview():
    # removeMidjourneyPreview 只删 flag token，不吞它后面的词（与 JS 完全一致）。
    assert styles.remove_mj_preview("a --preview up --v 6") == "a up --v 6"
    assert styles.remove_mj_preview("noop") == "noop"
    assert styles.remove_mj_preview(None) == ""


def test_mj_style_text_modes():
    item = {
        "codes": "--sref 410525033 --preview x",
        "parameters": "--ar 16:9 --stylize 50 --preview x",
        "prompt": "a cat --ar 16:9",
        "vibe": "糖果粉+薄荷绿",
    }
    assert styles.mj_style_text(item, "vibe") == "糖果粉+薄荷绿"
    assert styles.mj_style_text(item, "full") == "a cat --ar 16:9"
    style_text = styles.mj_style_text(item, "style")
    assert style_text == "糖果粉+薄荷绿\n--sref 410525033 x"
    parameters_text = styles.mj_style_text(item, "parameters")
    assert parameters_text == "糖果粉+薄荷绿\n--ar 16:9 --stylize 50 x"
    assert "--preview" not in style_text and "--preview" not in parameters_text


# --------------------------------------------------------------------------- 合成
def test_compose_prompt_without_presets_is_plain_prompt():
    assert styles.compose_prompt("a photo of a cat") == "a photo of a cat"
    assert styles.compose_prompt("a photo of a cat", presets=None, image_angle=None) == "a photo of a cat"


def test_compose_prompt_creative_order_for_image():
    presets = [
        _preset("s", "style", name="风格", prompt="风格后缀", prefix="风格前缀"),
        _preset("f", "filter", name="滤镜", prompt="滤镜后缀", prefix="滤镜前缀"),
        _preset("m", "motion", name="运镜", prompt="运镜后缀", prefix="运镜前缀"),
    ]
    result = styles.compose_prompt("正文", presets=presets)
    assert result.split("\n") == ["风格前缀", "滤镜前缀", "正文", "风格后缀", "滤镜后缀"]


def test_compose_prompt_video_adds_motion():
    presets = [
        _preset("s", "style", prompt="风格后缀", prefix="风格前缀"),
        _preset("f", "filter", prompt="滤镜后缀", prefix="滤镜前缀"),
        _preset("m", "motion", prompt="运镜后缀", prefix="运镜前缀"),
    ]
    result = styles.compose_prompt("正文", presets=presets, node_type="Video")
    assert result.split("\n") == [
        "风格前缀",
        "滤镜前缀",
        "运镜前缀",
        "正文",
        "风格后缀",
        "滤镜后缀",
        "运镜后缀",
    ]


def test_compose_prompt_dict_with_custom_slot():
    presets = {
        "style": _preset("s", "style", prompt="风格后缀", prefix="风格前缀"),
        "custom": _preset("c", "style", prompt="自定义后缀", prefix="自定义前缀"),
    }
    result = styles.compose_prompt("正文", presets=presets)
    # custom 槽排在 filter 之后，图片节点不叠加 motion。
    assert result.split("\n") == ["风格前缀", "自定义前缀", "正文", "风格后缀", "自定义后缀"]


def test_compose_prompt_other_node_type_ignores_presets_but_normalizes_mj():
    presets = [_preset("s", "style", prompt="后缀", prefix="前缀")]
    result = styles.compose_prompt("正文 --ar 16:9", presets=presets, node_type="Audio")
    assert result == "正文\n--ar 16:9"


def test_compose_prompt_empty_values_are_dropped():
    presets = [_preset("s", "style", prompt="后缀", prefix="前缀")]
    assert styles.compose_prompt("", presets=presets) == "前缀\n后缀"
    # prompt 为空串时不能产生首尾空行。
    assert not styles.compose_prompt("", presets=presets).startswith("\n")


def test_compose_prompt_appends_angle_last():
    angle = {"azimuth": 90, "elevation": 10, "zoom": 5}
    body = "一只猫"
    result = styles.compose_prompt(body, image_angle=angle)
    assert result == body + "\n" + styles.angle_prompt(angle)
    assert result.startswith("一只猫\n根据参考图片重新呈现同一个主体")


def test_compose_prompt_mj_normalize_happens_after_creative():
    presets = [_preset("s", "style", prompt="胶片颗粒", prefix="视觉风格：复古胶片")]
    result = styles.compose_prompt(
        "一只猫 --ar 16:9 --preview upscale", presets=presets, image_angle=None
    )
    lines = result.split("\n")
    assert lines[0] == "视觉风格：复古胶片"
    assert lines[1] == "一只猫"
    # MJ 参数被归并到最末尾，--preview 被丢弃。
    assert lines[-1] == "--ar 16:9"
    assert "--preview" not in result


def test_compose_prompt_accepts_preset_list_with_duplicate_slots():
    presets = [
        _preset("s1", "style", prompt="旧后缀", prefix="旧前缀"),
        _preset("s2", "style", prompt="新后缀", prefix="新前缀"),
    ]
    result = styles.compose_prompt("正文", presets=presets)
    assert result == "新前缀\n正文\n新后缀"


# --------------------------------------------------------------------------- 预设校验
def test_valid_creative_preset_rules():
    assert styles.valid_creative_preset(_preset("ok"))
    assert not styles.valid_creative_preset(None)
    assert not styles.valid_creative_preset("junk")
    # 与 JS 一致：id 只要求是字符串且 <=100，空字符串也算合法；prompt 可以为空。
    assert styles.valid_creative_preset({"id": "", "kind": "style", "name": "n", "prompt": "p"})
    assert not styles.valid_creative_preset({"id": "a", "kind": "nope", "name": "n", "prompt": "p"})
    assert not styles.valid_creative_preset({"id": "a", "kind": "style", "name": "", "prompt": "p"})
    assert not styles.valid_creative_preset(
        {"id": "a", "kind": "style", "name": "n" * 81, "prompt": "p"}
    )
    assert not styles.valid_creative_preset({"id": "a", "kind": "style", "name": "n", "prompt": 1})
    assert not styles.valid_creative_preset(
        {"id": "a", "kind": "style", "name": "n", "prompt": "p", "prefix": 1}
    )
    assert styles.valid_creative_preset(
        {"id": "a" * 100, "kind": "style", "name": "n", "prompt": ""}
    )


def test_validate_presets_filters_and_dedupes():
    items = [
        _preset("s1"),
        _preset("s2", kind="filter"),
        None,
        "junk",
        {"id": "", "kind": "style", "name": "合法但空 id", "prompt": "p"},
        {"id": "bad", "kind": "unknown", "name": "n", "prompt": "p"},
        {"id": "s1", "kind": "style", "name": "重复 id", "prompt": "p"},  # 同 id 丢弃
        _preset("m1", kind="motion"),
    ]
    cleaned = styles.validate_presets(items)
    assert [preset["id"] for preset in cleaned] == ["s1", "s2", "", "m1"]
    assert styles.validate_presets(None) == []
    assert styles.validate_presets("junk") == []


def test_validate_presets_accepts_creative_presets_mapping():
    presets = {
        "style": _preset("s1"),
        "filter": _preset("f1", kind="filter"),
        "custom": _preset("c1"),
        "motion": {"id": "bad", "kind": "nope", "name": "x", "prompt": "p"},
        "unknown_slot": _preset("x1"),
    }
    cleaned = styles.validate_presets(presets)
    assert [preset["id"] for preset in cleaned] == ["s1", "f1", "c1"]


def test_slots_of_ignores_empty_presets():
    assert styles.slots_of(None) == {}
    assert styles.slots_of([]) == {}
    assert styles.slots_of([{"kind": "style"}]) == {}
    # 非法类型不能炸（前端可能传 null / 数字）。
    assert styles.slots_of(5) == {}
    assert styles.validate_presets(5) == []
    # 未知类型传给 compose_prompt 时原样返回提示词。
    assert styles.compose_prompt("一只猫", presets=5) == "一只猫"


# --------------------------------------------------------------------------- 目录
def test_load_catalogs_real_vendor_data():
    catalogs = styles.load_catalogs()
    assert set(catalogs) == {"creative", "mj", "mjGroups", "insertModes", "count"}

    count = catalogs["count"]
    assert count["creative"] == 285
    assert count["mj"] == 493
    assert count["mjGroups"] == 6
    assert count["insertModes"] == 4
    assert count["mjCategories"] == 34
    assert count["creativeKinds"] == {"style": 217, "motion": 51, "filter": 17}
    assert sum(count["creativeKinds"].values()) == count["creative"]

    assert len(catalogs["creative"]) == 285
    assert all(styles.valid_creative_preset(item) for item in catalogs["creative"])
    assert catalogs["creative"][0]["id"] == "style-643"

    assert len(catalogs["mj"]) == 493
    required = {
        "id",
        "group",
        "category",
        "name",
        "mixed",
        "medium",
        "codes",
        "parameters",
        "prompt",
        "vibe",
        "thumbnail",
        "preview",
    }
    assert all(required <= set(item) for item in catalogs["mj"])

    assert [group["name"] for group in catalogs["mjGroups"]] == [
        "东方古风",
        "现代影像",
        "科幻幻想",
        "自然氛围",
        "暗黑废墟",
        "巨物传说",
    ]
    assert all(isinstance(group["categories"], list) and group["categories"] for group in catalogs["mjGroups"])
    assert [mode["key"] for mode in catalogs["insertModes"]] == [
        "style",
        "parameters",
        "full",
        "vibe",
    ]
    assert [mode["label"] for mode in catalogs["insertModes"]] == [
        "风格码",
        "参数",
        "完整提示词",
        "氛围描述",
    ]
    # 返回的目录必须是可 JSON 序列化的纯数据（前端直接消费）。
    json.dumps(catalogs, ensure_ascii=False)


def test_load_catalogs_custom_directory():
    directory = _make_data_dir(ROOT / "tests")
    try:
        (directory / "creativeCatalog.json").write_text(
            json.dumps(
                [
                    _preset("ok"),
                    {"id": "坏", "kind": "nope", "name": "坏数据", "prompt": "p"},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (directory / "mjStyleCatalog.json").write_text(
            json.dumps(
                [
                    {"id": "mj1", "group": "char", "category": "风格化与实验", "name": "甲"},
                    {"id": "mj2", "group": "scene", "category": "现代都市·街景", "name": "乙"},
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        catalogs = styles.load_catalogs(directory)
        assert catalogs["count"]["creative"] == 1
        assert catalogs["count"]["mj"] == 2
        assert catalogs["count"]["mjCategories"] == 2
        # 分组与插入模式来自 vendor 常量，不依赖数据里的 group 值。
        assert len(catalogs["mjGroups"]) == 6
        assert len(catalogs["insertModes"]) == 4
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def test_load_catalogs_rejects_non_list_json():
    directory = _make_data_dir(ROOT / "tests")
    try:
        (directory / "creativeCatalog.json").write_text("{}", encoding="utf-8")
        (directory / "mjStyleCatalog.json").write_text("[]", encoding="utf-8")
        try:
            styles.load_catalogs(directory)
        except ValueError:
            pass
        else:
            raise AssertionError("顶层不是数组时应当抛 ValueError")
    finally:
        shutil.rmtree(directory, ignore_errors=True)


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
