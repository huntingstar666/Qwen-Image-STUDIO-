"""VOSR2（ComfyUI API）工作流构造与模型扫描测试。"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from server.upscalers import registry
from server.upscalers.vosr2_api import build_workflow


def test_build_workflow_matches_comfy_api_shape():
    flow = build_workflow(
        "uploaded.png",
        scale=3,
        seed=123,
        settings={"quality_profile": "quality", "tile_size": 256},
    )
    assert set(flow) == {"1", "2", "3", "4", "11", "12"}
    assert flow["1"]["class_type"] == "SaveImage"
    assert flow["2"]["inputs"]["image"] == "uploaded.png"
    assert flow["4"]["inputs"]["value"] == 3
    assert flow["11"]["inputs"]["scale"] == ["4", 0]
    assert flow["11"]["inputs"]["seed"] == 123
    assert flow["3"]["inputs"]["quality_profile"] == "quality"
    assert flow["3"]["inputs"]["tile_size"] == 256
    assert flow["3"]["inputs"]["color_alignment"] == "wavelet"
    assert flow["12"]["inputs"]["model_bundle"] == "VOSR2"


def test_build_workflow_drops_unknown_settings_and_clamps_scale():
    flow = build_workflow("a.png", scale=0, settings={"unknown": 1})
    assert flow["4"]["inputs"]["value"] == 1
    assert "unknown" not in flow["3"]["inputs"]


def test_scan_vosr2():
    root = Path(tempfile.mkdtemp(prefix=".tmp_vosr2_", dir="tests"))
    try:
        checkpoint = root / "VOSR2" / "checkpoints" / "ema_model.safetensors"
        checkpoint.parent.mkdir(parents=True)
        checkpoint.write_bytes(b"x")
        cfg = {"upscale": {"vosr2": {"model_bundle": "VOSR2"}}}

        info = registry.scan_vosr2(str(root), cfg)
        assert info["ready"] is True
        assert info["bundles"] == ["VOSR2"]
        assert info["url"] == ""

        missing = registry.scan_vosr2(str(root / "nope"), cfg)
        assert missing["ready"] is False
        assert "模型目录" in missing["missing"]
    finally:
        shutil.rmtree(root, ignore_errors=True)
