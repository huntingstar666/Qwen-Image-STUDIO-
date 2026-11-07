"""编辑预设（server/presets.py）与 /api/meta 契约测试。

钉死的合并优先级：显式请求字段 > preset 展开值 > 后端内置默认。
"""
from __future__ import annotations

import pytest

from server import main, presets, pipeline

QWEN = {"id": "qwen", "snap": 32}


def test_merge_fills_missing_keys_from_preset():
    merged, info = presets.merge({"preset": "mask_edit"})
    assert merged["local"]["scheme"] == "b"
    assert merged["local"]["expand_pct"] == 4.0
    assert merged["local"]["feather_pct"] == 5.0
    assert merged["task"]["mode"] == "edit"
    assert merged["preprocess"]["enabled"] is True
    assert merged["zero_shift"]["enabled"] is True
    assert merged["preset"] == "mask_edit"
    assert merged["preset_version"] == presets.PRESET_VERSION
    assert info == {"id": "mask_edit", "version": presets.PRESET_VERSION,
                    "label": "局部编辑"}


def test_explicit_fields_beat_preset_and_preset_fills_the_rest():
    merged, _info = presets.merge({
        "preset": "mask_edit",
        "local": {"expand_pct": 9, "scheme": "a"},
        "task": {"mode": "remove"},
        "turbo": {"enabled": False},
    })
    # 显式值原样保留
    assert merged["local"]["expand_pct"] == 9
    assert merged["local"]["scheme"] == "a"
    assert merged["task"]["mode"] == "remove"
    assert merged["turbo"]["enabled"] is False
    # 未传的键由预设补齐（不是内置默认）
    assert merged["local"]["crop_min_side"] == 768
    assert merged["turbo"]["profile"] == "turbo9_ckpt"


def test_no_preset_is_identity():
    params = {"local": {"scheme": "a"}, "task": {"mode": "edit"}}
    merged, info = presets.merge(params)
    assert merged is params
    assert info is None


def test_unknown_preset_raises():
    with pytest.raises(ValueError, match="未知编辑预设"):
        presets.merge({"preset": "nope"})


def test_outpaint_preset_splits_crop_and_seam_defaults():
    """扩图档位与编辑档位必须分家（决策 37）。"""
    edit, _ = presets.merge({"preset": "mask_edit"})
    outpaint, _ = presets.merge({"preset": "outpaint"})
    assert edit["local"]["crop_min_side"] == 768
    assert (edit["local"]["expand_pct"], edit["local"]["feather_pct"]) == (4.0, 5.0)
    assert outpaint["task"]["mode"] == "outpaint"
    assert outpaint["local"]["crop_min_side"] == 1024
    assert (outpaint["local"]["expand_pct"], outpaint["local"]["feather_pct"]) == (3.0, 3.0)
    assert outpaint["outpaint"]["max_side"] == 5120


def test_public_presets_and_meta_endpoint():
    items = presets.public_presets()
    assert [item["id"] for item in items] == [
        "mask_edit", "remove", "outpaint", "canvas", "native"]
    assert [item["id"] for item in items if item["default"]] == ["mask_edit"]
    assert all(item["summary"] and item["params"] for item in items)
    assert presets.default_preset_id() == "mask_edit"

    meta = main.api_meta()
    assert meta["preset_version"] == presets.PRESET_VERSION
    assert meta["default_preset"] == "mask_edit"
    assert len(meta["edit_presets"]) == len(presets.EDIT_PRESETS)


def test_validation_rejects_unknown_preset_and_bad_outpaint_max_side():
    with pytest.raises(main.ApiError, match="未知编辑预设"):
        main._validate_edit_params({"preset": "nope"})
    with pytest.raises(main.ApiError, match="outpaint.max_side"):
        main._validate_edit_params({"outpaint": {"max_side": 9000}})
    with pytest.raises(main.ApiError, match="outpaint.max_side"):
        main._validate_edit_params({"outpaint": {"max_side": 512}})
    main._validate_edit_params({"preset": "outpaint",
                               "outpaint": {"left": 10, "max_side": 5120}})


def test_zero_shift_defaults_on_and_can_be_disabled():
    assert pipeline._zero_shift_spec({}, QWEN, "follow")["enabled"] is True
    assert pipeline._zero_shift_spec(
        {"zero_shift": {"enabled": False}}, QWEN, "follow")["enabled"] is False
    # custom / ratio 本就不承诺回源尺寸，默认不开
    assert pipeline._zero_shift_spec({}, QWEN, "custom")["enabled"] is False
