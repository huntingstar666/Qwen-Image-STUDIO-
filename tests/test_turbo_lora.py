"""Turbo 档位与加速 LoRA 选择的单元测试（纯 CPU，不加载模型）。

覆盖 config.pick_turbo_lora 的四种语义：
    None       → 用档位默认
    "none"     → 不挂
    指定名字   → 用指定的
    指定不存在 → missing=True（由 pipeline 报清晰错误）
"""
from __future__ import annotations

from server import config


def _cfg() -> dict:
    cfg = config.load_config(refresh=True)
    return cfg


def test_candidates_are_scanned_and_sorted():
    cfg = _cfg()
    items = config.turbo_lora_candidates(cfg)
    assert items, "本机应当能扫到 Qwen 加速 LoRA"
    names = [it["label"] for it in items]
    assert any("8step" in n or "8steps" in n for n in names), names
    # 兼容的排在前面，体积小的更靠前
    compatible = [it for it in items if it["compatible"]]
    assert compatible[0]["size_gb"] <= compatible[-1]["size_gb"]
    # 默认项必须来自 config
    defaults = [it for it in items if it["default"]]
    if cfg.get("turbo_lora"):
        assert defaults, "config.turbo_lora 指向的 LoRA 应当被标记为默认"
        assert defaults[0]["value"].replace("\\", "/") == cfg["turbo_lora"].replace("\\", "/")


def test_pick_none_disables_lora():
    cfg = _cfg()
    profile = config.turbo_profile("turbo8_official")
    pick = config.pick_turbo_lora(cfg, profile, "none")
    assert pick["path"] is None
    assert pick["missing"] is False
    assert pick["name"] is None
    for alias in ("", "off", "no", "false", "0"):
        assert config.pick_turbo_lora(cfg, profile, alias)["path"] is None, alias


def test_pick_default_uses_profile_lora_name():
    cfg = _cfg()
    profile = config.turbo_profile("turbo8_official")
    pick = config.pick_turbo_lora(cfg, profile)
    assert pick["reason"] == "档位默认"
    assert pick["name"] == profile["lora_name"]
    assert pick["path"] and pick["path"].endswith(".safetensors")
    assert pick["strength"] == 1.0


def test_pick_explicit_name_overrides_profile():
    cfg = _cfg()
    profile = config.turbo_profile("turbo8_official")
    candidates = config.turbo_lora_candidates(cfg)
    small = next(it for it in candidates if it["size_gb"] and it["size_gb"] < 1)
    pick = config.pick_turbo_lora(cfg, profile, small["value"])
    assert pick["reason"] == "用户指定"
    assert pick["path"] and pick["path"].endswith(small["label"])
    assert pick["missing"] is False


def test_pick_missing_reports_missing():
    cfg = _cfg()
    pick = config.pick_turbo_lora(cfg, config.turbo_profile("turbo8_official"),
                                  "loras/不存在的加速LoRA.safetensors")
    assert pick["path"] is None
    assert pick["missing"] is True


def test_pick_strength_override():
    cfg = _cfg()
    profile = config.turbo_profile("turbo8_official")
    pick = config.pick_turbo_lora(cfg, profile, "none", 0.65)
    assert abs(pick["strength"] - 0.65) < 1e-6
    # 非法强度回落 1.0
    assert config.pick_turbo_lora(cfg, profile, "none", "oops")["strength"] == 1.0


def test_profile_without_lora_does_not_attach():
    cfg = _cfg()
    profile = config.turbo_profile("turbo8_ckpt")
    pick = config.pick_turbo_lora(cfg, profile)
    assert pick["path"] is None
    assert pick["reason"] == "该档位本身不需要 LoRA"


def test_every_profile_has_lora_name_field():
    for profile in config.TURBO_PROFILES:
        assert "lora_name" in profile, profile.get("id")
        if profile["lora"]:
            assert profile["lora_name"], f"{profile['id']} 需要 lora_name"
        else:
            assert profile["lora_name"] is None


# --------------------------------------------------------------------------- 8/9 步双预设


def _sigmas(profile_id: str) -> list[float]:
    return [float(v) for v in config.turbo_profile(profile_id)["sigmas"]]


def test_eight_and_nine_step_presets_exist():
    ids = [p["id"] for p in config.TURBO_PROFILES]
    for pid in ("turbo8_official", "turbo9_official", "turbo8_ckpt", "turbo9_ckpt"):
        assert pid in ids, ids


def test_every_profile_sigmas_descend_and_match_steps():
    for profile in config.TURBO_PROFILES:
        sigmas = [float(v) for v in profile["sigmas"]]
        assert sigmas[-1] == 0.0, profile["id"]
        assert all(b < a for a, b in zip(sigmas, sigmas[1:])), profile["id"]
        assert profile["steps"] == len(sigmas) - 1, profile["id"]


def test_nine_step_is_eight_step_plus_low_noise_taper():
    eight = _sigmas("turbo8_official")
    nine = _sigmas("turbo9_official")
    assert nine == eight[:-1] + [0.15, 0.0]
    assert _sigmas("turbo9_ckpt") == nine


def test_nine_step_lora_preset_reuses_eight_step_lora():
    eight = config.turbo_profile("turbo8_official")
    nine = config.turbo_profile("turbo9_official")
    assert nine["kind"] == eight["kind"] == "lora"
    assert nine["lora_name"] == eight["lora_name"]
    assert nine["strength"] == eight["strength"]


def test_default_profile_stays_eight_steps_for_text_to_image():
    assert config.DEFAULTS["turbo_profile"] == "turbo8_official"
    assert config.turbo_profile(None)["steps"] == 8


# --------------------------------------------------------------------------- 任务 LoRA 预设


def test_lora_task_presets_resolve_with_expected_strength():
    expected = {"consistency": 0.48, "remove": 1.0, "outpaint": 0.7}
    for pid, strength in expected.items():
        spec = config.resolve_lora_preset(pid)
        assert spec is not None and spec["id"] == pid
        assert spec["strength"] == strength
        assert spec["name"].endswith(".safetensors")


def test_lora_preset_unknown_returns_none():
    assert config.resolve_lora_preset("nope") is None
    assert config.resolve_lora_preset(None) is None
    assert config.resolve_lora_preset("  ") is None


def test_lora_presets_public_hides_file_paths():
    items = config.lora_presets_public()
    assert {item["id"] for item in items} == {"consistency", "remove", "outpaint"}
    for item in items:
        assert "name" not in item


def test_build_loras_expands_preset():
    import os
    import tempfile

    from server import pipeline

    with tempfile.TemporaryDirectory() as root:
        rel = config.LORA_TASKS["remove"]["name"]
        target = os.path.join(root, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(b"fake")
        cfg = {"model_root": root, "model_dirs": {"lora": ["loras"]}}
        loras = pipeline._build_loras(
            cfg,
            {"loras": [{"preset": "remove"}]},
            {"id": "qwen", "accelerator": {}},
            sampling={},
        )
    assert len(loras) == 1
    assert os.path.basename(loras[0]["name"]) == os.path.basename(target)
    assert loras[0]["strength"] == 1.0


def test_build_loras_rejects_unknown_preset():
    import tempfile

    import pytest

    from server import pipeline

    with tempfile.TemporaryDirectory() as root:
        cfg = {"model_root": root, "model_dirs": {"lora": ["loras"]}}
        with pytest.raises(pipeline.PipelineError, match="未知 LoRA 预设"):
            pipeline._build_loras(
                cfg,
                {"loras": [{"preset": "nope"}]},
                {"id": "qwen", "accelerator": {}},
                sampling={},
            )
