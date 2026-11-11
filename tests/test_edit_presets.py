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


def test_explicit_task_mode_drops_preset_task_only_keys():
    """显式换了任务，预设里"任务专属"的 hint / fills 必须让位（测试用例 0e）。

    否则 preset=remove + task.mode=edit 会把移除任务的绿区提示画进普通编辑的参考图。
    """
    merged, _ = presets.merge({"preset": "remove", "task": {"mode": "edit"}})
    assert merged["task"]["mode"] == "edit"
    assert merged["local"]["hint"] == "none"
    assert merged["local"]["fills"] is False
    # 用户显式给 hint 时仍然用户说了算
    merged2, _ = presets.merge({"preset": "remove", "task": {"mode": "edit"},
                                "local": {"hint": "green_overlay"}})
    assert merged2["local"]["hint"] == "green_overlay"
    # 任务一致时预设值原样保留
    merged3, _ = presets.merge({"preset": "remove"})
    assert merged3["local"]["hint"] == "green_overlay"
    assert merged3["local"]["fills"] is True


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
    assert outpaint["outpaint"]["max_side"] == 4096


def test_panorama_preset_uses_full_canvas_sampling():
    """全景档必须走整画布采样（scheme=a），裁块会破坏横向连续性。"""
    panorama, _ = presets.merge({"preset": "panorama"})
    assert panorama["task"]["mode"] == "panorama"
    assert panorama["local"]["scheme"] == "a"
    assert panorama["local"]["hint"] == "gray_fill"
    assert panorama["panorama"] == {
        "aspect": "2:1", "long_side": 3072, "wrap": False, "seam_blend": 24,
    }


def test_panorama360_preset_uses_redraw_pipeline():
    """360° 档：整张 2:1 重绘（原生、无提示图），参数只保留长边。"""
    preset, _ = presets.merge({"preset": "panorama360"})
    assert preset["task"]["mode"] == "panorama360"
    assert preset["local"]["scheme"] == "native"
    assert preset["local"]["hint"] == "none"
    assert preset["panorama360"] == {"long_side": 3072}


def test_public_presets_and_meta_endpoint():
    items = presets.public_presets()
    assert [item["id"] for item in items] == [
        "mask_edit", "remove", "outpaint", "panorama", "panorama360", "canvas", "native",
        "chain_mask", "chain_native"]
    assert [item["id"] for item in items if item["default"]] == ["mask_edit"]
    assert all(item["summary"] and item["params"] for item in items)
    assert presets.default_preset_id() == "mask_edit"

    meta = main.api_meta()
    assert meta["preset_version"] == presets.PRESET_VERSION
    assert meta["default_preset"] == "mask_edit"
    assert len(meta["edit_presets"]) == len(presets.EDIT_PRESETS)


def test_chain_presets_reuse_geometry_and_expose_chain_contract():
    """连续编辑两档：遮罩档必须走 b 几何，整图档走 native；chain 契约随预设下发。"""
    base_mask, _ = presets.merge({"preset": "mask_edit"})
    chain_mask, _ = presets.merge({"preset": "chain_mask"})
    assert chain_mask["local"] == base_mask["local"]
    assert chain_mask["chain"] == {"mode": "mask", "carry_mask": True,
                                   "anchor_every": 5, "drift_warn_delta_e": 10}

    base_native, _ = presets.merge({"preset": "native"})
    chain_native, _ = presets.merge({"preset": "chain_native"})
    assert chain_native["local"] == base_native["local"]
    assert chain_native["chain"]["mode"] == "native"
    assert chain_native["chain"]["carry_mask"] is False

    # 显式值仍然优先（链参数包不锁死高级开关）
    override, _ = presets.merge({"preset": "chain_mask", "local": {"scheme": "a"}})
    assert override["local"]["scheme"] == "a"

    # public_presets 必须把 chain 契约原样下发（前端据此保遮罩 / 提示回锚）
    published = {item["id"]: item for item in presets.public_presets()}
    assert published["chain_mask"]["params"]["chain"]["carry_mask"] is True
    assert published["chain_native"]["params"]["chain"]["carry_mask"] is False


def test_validation_rejects_unknown_preset_and_bad_outpaint_max_side():
    with pytest.raises(main.ApiError, match="未知编辑预设"):
        main._validate_edit_params({"preset": "nope"})
    with pytest.raises(main.ApiError, match="outpaint.max_side"):
        main._validate_edit_params({"outpaint": {"max_side": 9000}})
    with pytest.raises(main.ApiError, match="outpaint.max_side"):
        main._validate_edit_params({"outpaint": {"max_side": 512}})
    main._validate_edit_params({"preset": "outpaint",
                               "outpaint": {"left": 10, "max_side": 4096}})
    with pytest.raises(main.ApiError, match="全局 max_side"):
        main._validate_edit_params({"preset": "outpaint",
                                   "outpaint": {"left": 10, "max_side": 5120}})


def _temp_config():
    """把 config 指向临时文件；返回 restore()，避免污染真实 config.json。"""
    import os
    import tempfile

    from server import config

    tmp = tempfile.TemporaryDirectory()
    old_path = config.CONFIG_PATH
    old_cache = config._cache
    config.CONFIG_PATH = os.path.join(tmp.name, "config.json")
    config.reload_config()

    def restore():
        config.CONFIG_PATH = old_path
        config._cache = old_cache
        tmp.cleanup()

    return restore


def test_preset_defaults_roundtrip_and_reset():
    """全局设置保存预设覆盖后，merge 立即使用；reset 后回退出厂。"""
    restore = _temp_config()
    try:
        preset = presets.get_preset("mask_edit")
        preset["local"]["crop_min_side"] = 1024
        view = presets.save_preset_config({"preset_defaults": {"mask_edit": preset}})
        assert view["overridden"] == ["mask_edit"]
        assert presets.get_preset("mask_edit")["local"]["crop_min_side"] == 1024

        view = presets.save_preset_config({"reset_presets": ["mask_edit"]})
        assert view["overridden"] == []
        assert presets.get_preset("mask_edit")["local"]["crop_min_side"] == 768
    finally:
        restore()


def test_custom_preset_does_not_inherit_builtin():
    restore = _temp_config()
    try:
        params = {
            "task": {"mode": "edit"},
            "local": {"enabled": True, "scheme": "native"},
            "preprocess": {"enabled": True, "max_side": 2048, "min_side": 768,
                           "multiple": 32, "mode": "downscale_only"},
            "zero_shift": {"enabled": True},
            "turbo": {"enabled": False, "profile": "turbo9_ckpt"},
            "sampling": {"steps": 12, "cfg": 3.5, "sampler": "euler",
                         "scheduler": "simple", "denoise": 1.0},
            "consistency": {"enabled": False, "lora": "", "strength": 0.48},
        }
        view = presets.save_preset_config({
            "custom_presets": [{"id": "custom:demo", "name": "我的搭配", "params": params}],
        })
        assert view["custom"][0]["id"] == "custom:demo"
        merged, info = presets.merge({"preset": "custom:demo"})
        assert info["id"] == "custom:demo"
        assert merged["local"]["scheme"] == "native"
        assert "crop_min_side" not in merged["local"]
        assert merged["sampling"]["steps"] == 12
    finally:
        restore()


def test_preset_conflicts_are_rejected():
    restore = _temp_config()
    try:
        remove = presets.get_preset("remove")
        remove["local"]["fills"] = False
        with pytest.raises(ValueError, match="填充闭合选区"):
            presets.save_preset_config({"preset_defaults": {"remove": remove}})

        panorama = presets.get_preset("panorama")
        panorama["local"]["scheme"] = "b"
        with pytest.raises(ValueError, match="整画布采样"):
            presets.save_preset_config({"preset_defaults": {"panorama": panorama}})

        pano360 = presets.get_preset("panorama360")
        pano360["local"]["scheme"] = "b"
        with pytest.raises(ValueError, match="整张重绘"):
            presets.save_preset_config({"preset_defaults": {"panorama360": pano360}})
    finally:
        restore()


def test_zero_shift_defaults_on_and_can_be_disabled():
    assert pipeline._zero_shift_spec({}, QWEN, "follow")["enabled"] is True
    assert pipeline._zero_shift_spec(
        {"zero_shift": {"enabled": False}}, QWEN, "follow")["enabled"] is False
    # custom / ratio 本就不承诺回源尺寸，默认不开
    assert pipeline._zero_shift_spec({}, QWEN, "custom")["enabled"] is False
