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
