"""零偏移契约守卫：矛盾参数直接拒绝，几何走样拒绝落盘。"""
from __future__ import annotations

import dataclasses

import pytest

from server import imaging, pipeline

QWEN = {"id": "qwen", "snap": 32}


def _follow_plan(w: int = 1000, h: int = 700):
    return imaging.plan_canvas(w, h, mode="follow", fit="pad")


def test_zero_shift_spec_disabled_outside_follow_mode():
    spec = pipeline._zero_shift_spec({"zero_shift": {"enabled": True}}, QWEN, "custom")
    assert spec["enabled"] is False
    assert spec["resolution"] == 0


def test_zero_shift_spec_requires_resolution_zero():
    with pytest.raises(pipeline.PipelineError, match="resolution"):
        pipeline._zero_shift_spec(
            {"zero_shift": {"enabled": True, "resolution": 64}}, QWEN, "follow")


def test_zero_shift_spec_requires_expected_snap():
    with pytest.raises(pipeline.PipelineError, match="snap"):
        pipeline._zero_shift_spec(
            {"zero_shift": {"enabled": True, "snap": 8}}, QWEN, "follow")


def test_zero_shift_spec_accepts_frontend_default():
    spec = pipeline._zero_shift_spec(
        {"zero_shift": {"enabled": True, "snap": 32, "resolution": 0}}, QWEN, "follow")
    assert spec == {"enabled": True, "snap": 32, "resolution": 0}


def test_verify_zero_shift_passes_for_follow_geometry():
    pipeline.verify_zero_shift(
        {"enabled": True, "snap": 32}, _follow_plan(), (1000, 700), (1000, 700))


def test_verify_zero_shift_rejects_size_drift():
    with pytest.raises(pipeline.PipelineError, match="输出"):
        pipeline.verify_zero_shift(
            {"enabled": True, "snap": 32}, _follow_plan(), (1000, 700), (1000, 704))


def test_verify_zero_shift_rejects_unaligned_canvas():
    plan = dataclasses.replace(_follow_plan(), width=_follow_plan().width + 1)
    with pytest.raises(pipeline.PipelineError, match="倍数"):
        pipeline.verify_zero_shift(
            {"enabled": True, "snap": 32}, plan, (1000, 700), (1000, 700))


def test_verify_zero_shift_noop_when_disabled():
    pipeline.verify_zero_shift({"enabled": False}, _follow_plan(), (1000, 700), (1, 1))
