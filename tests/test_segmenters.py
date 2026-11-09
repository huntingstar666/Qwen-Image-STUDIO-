"""主体分割：目录/就绪扫描、模型选择、蒙版后处理与设置校验（不加载 torch/权重）。"""

from __future__ import annotations

import io
import shutil
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

from server import config
from server.segmenters import maskops, registry
from server.segmenters.errors import SegmentError
from server.segmenters.manager import SegmentManager


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix=".tmp_segment_", dir=str(Path(__file__).parent)))


def _cfg(root: Path) -> dict:
    return {
        "model_root": str(root),
        "segment": {
            "dirs": {},
            "sam3": {"model": "sam3.1_multiplex_fp16.safetensors",
                     "threshold": 0.5, "refine_iterations": 2},
            "birefnet": {"model": "birefnet.safetensors"},
            "default_model": "",
            "max_side": 2048,
            "max_candidates": 8,
            "timeout_s": 30,
            "idle_unload_minutes": 10,
        },
    }


def _fake_weights(root: Path) -> None:
    (root / "checkpoints").mkdir(parents=True, exist_ok=True)
    (root / "background_removal").mkdir(parents=True, exist_ok=True)
    (root / "checkpoints" / "sam3.1_multiplex_fp16.safetensors").write_bytes(b"0")
    (root / "background_removal" / "birefnet.safetensors").write_bytes(b"0")


def _without_min_size():
    """临时把最小体积门槛置 0（测试里不方便写 200MB 假文件）。"""
    old = {name: meta.get("min_mb") for name, meta in registry.ENGINES.items()}
    for meta in registry.ENGINES.values():
        meta["min_mb"] = 0
    return old


def _restore_min_size(old: dict) -> None:
    for name, value in old.items():
        registry.ENGINES[name]["min_mb"] = value


def test_defaults_section_exists():
    seg = config.DEFAULTS.get("segment") or {}
    assert seg.get("max_candidates") == 8
    assert seg.get("sam3", {}).get("model")
    assert config.MASK_DIR.endswith("masks")


def test_dirs_follow_model_root_and_explicit_win():
    root = _tmp()
    try:
        dirs = registry.resolve_dirs(_cfg(root))
        assert dirs["sam3"] == str(root / "checkpoints")
        assert dirs["birefnet"] == str(root / "background_removal")

        cfg = _cfg(root)
        cfg["segment"]["dirs"]["sam3"] = str(root / "custom")
        assert registry.resolve_dirs(cfg)["sam3"] == str(root / "custom")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_scan_engine_ready_and_missing():
    root = _tmp()
    old = _without_min_size()
    try:
        cfg = _cfg(root)
        scan = registry.scan_engine("sam3", cfg)
        assert scan["exists"] is False
        assert scan["ready"] is False
        assert "模型目录" in scan["missing"]

        _fake_weights(root)
        scan = registry.scan_engine("sam3", cfg)
        assert scan["ready"] is True
        assert scan["selected"] == "sam3.1_multiplex_fp16.safetensors"
        assert [item["name"] for item in scan["files"]] == [
            "sam3.1_multiplex_fp16.safetensors"]

        cfg["segment"]["sam3"]["model"] = "missing.safetensors"
        scan = registry.scan_engine("sam3", cfg)
        assert scan["ready"] is False
        assert scan["missing"]
    finally:
        _restore_min_size(old)
        shutil.rmtree(root, ignore_errors=True)


def test_scan_all_default_prefers_ready_model():
    root = _tmp()
    old = _without_min_size()
    try:
        cfg = _cfg(root)
        _fake_weights(root)
        data = registry.scan_all(cfg)
        assert data["ready"] is True
        assert data["default"] == "sam3.1-multiplex"
        ids = [item["id"] for item in data["models"]]
        assert ids == ["sam3.1-multiplex", "birefnet"]

        cfg["segment"]["default_model"] = "birefnet"
        assert registry.scan_all(cfg)["default"] == "birefnet"
    finally:
        _restore_min_size(old)
        shutil.rmtree(root, ignore_errors=True)


def test_pick_model_by_mode_and_errors():
    root = _tmp()
    old = _without_min_size()
    try:
        cfg = _cfg(root)
        _fake_weights(root)
        assert registry.pick_model(cfg, "box")["id"] == "sam3.1-multiplex"
        assert registry.pick_model(cfg, "points")["id"] == "sam3.1-multiplex"
        assert registry.pick_model(cfg, "text")["id"] == "sam3.1-multiplex"
        assert registry.pick_model(cfg, "subject")["id"] == "birefnet"

        try:
            registry.pick_model(cfg, "box", "birefnet")
            raise AssertionError("应当拒绝不支持的模型/模式组合")
        except SegmentError as exc:
            assert exc.code == "invalid_mode"

        try:
            registry.pick_model(cfg, "box", "nope")
            raise AssertionError("应当拒绝未知模型")
        except SegmentError as exc:
            assert exc.code == "invalid_model"

        empty = _cfg(root / "nope")
        try:
            registry.pick_model(empty, "text")
            raise AssertionError("没有模型时应报错")
        except SegmentError as exc:
            assert exc.code == "not_implemented"
    finally:
        _restore_min_size(old)
        shutil.rmtree(root, ignore_errors=True)


def test_validate_box_rules():
    assert maskops.validate_box({"x": 10, "y": 20, "width": 30, "height": 40},
                                100, 100) == (10, 20, 40, 60)
    for bad in (
        {"x": -1, "y": 0, "width": 10, "height": 10},
        {"x": 0, "y": 0, "width": 0, "height": 10},
        {"x": 95, "y": 0, "width": 10, "height": 10},
        None,
    ):
        try:
            maskops.validate_box(bad, 100, 100)
            raise AssertionError(f"应当拒绝无效框：{bad}")
        except SegmentError as exc:
            assert exc.code == "invalid_box"


def test_validate_points_rules():
    points = maskops.validate_points(
        [{"x": 5, "y": 6}, {"x": 7, "y": 8, "label": 0}], 100, 100)
    assert points == [(5.0, 6.0, 1), (7.0, 8.0, 0)]
    for bad in ([], [{"x": -1, "y": 2}], [{"x": 5, "y": 6, "label": 0}], "nope"):
        try:
            maskops.validate_points(bad, 100, 100)
            raise AssertionError(f"应当拒绝无效点：{bad}")
        except SegmentError as exc:
            assert exc.code == "invalid_points"


def test_check_image_size_limits():
    maskops.check_image_size(4096, 4096)
    for width, height in ((0, 100), (5000, 10), (4096, 4097)):
        try:
            maskops.check_image_size(width, height)
            raise AssertionError("应当拒绝超限图片")
        except SegmentError as exc:
            assert exc.code == "invalid_image"


def test_binarize_clip_and_info():
    mask = np.zeros((50, 50), dtype=np.float32)
    mask[10:20, 10:20] = 0.9
    binary = maskops.binarize(mask)
    assert binary.sum() == 100
    clipped = maskops.clip_to_box(binary, (0, 0, 15, 50))
    assert clipped.sum() == 50
    area, box = maskops.mask_info(clipped)
    assert area == 50
    assert box == {"x": 10, "y": 10, "width": 5, "height": 10}


def test_components_split_and_order():
    mask = np.zeros((100, 100), dtype=bool)
    mask[5:15, 5:15] = True       # 100 px
    mask[60:90, 60:90] = True     # 900 px
    parts = maskops.components(mask)
    assert len(parts) == 2
    assert int(parts[0].sum()) == 900
    assert int(parts[1].sum()) == 100
    assert maskops.components(mask, min_area=200) and len(
        maskops.components(mask, min_area=200)) == 1


def test_resize_float_and_rasterize():
    mask = np.zeros((10, 10), dtype=np.float32)
    mask[2:8, 2:8] = 1.0
    resized = maskops.resize_float(mask, 40, 20)
    assert resized.shape == (20, 40)
    assert float(resized.max()) > 0.9

    png = maskops.rasterize(resized, feather=0)
    with Image.open(io.BytesIO(png)) as image:
        assert image.size == (40, 20)
        assert image.mode == "L"
        assert image.getpixel((20, 10)) >= 200
        assert image.getpixel((0, 0)) <= 5

    soft = maskops.rasterize(resized, feather=3)
    with Image.open(io.BytesIO(soft)) as image:
        assert image.mode == "L"


def test_manager_postprocess_subject_multi_and_cap():
    manager = SegmentManager()
    prob = np.zeros((100, 100), dtype=np.float32)
    prob[10:30, 10:30] = 0.9
    prob[60:95, 60:95] = 0.8
    raw = [{"mask": prob, "score": 0.9}]

    single = manager._postprocess(raw, "subject", False, 100, 100, None, 8)
    assert len(single) == 1

    multi = manager._postprocess(raw, "subject", True, 100, 100, None, 8)
    assert len(multi) == 2
    assert sorted(item["area"] for item in multi) == [400, 1225]
    # 候选按 score 降序：小方块 score 0.9 排在前
    assert multi[0]["area"] == 400


def test_manager_postprocess_text_cap_and_box_clip():
    manager = SegmentManager()
    prob = np.zeros((60, 60), dtype=np.float32)
    prob[5:55, 5:55] = 0.9
    raw = [{"mask": prob, "score": 0.9}, {"mask": prob, "score": 0.8},
           {"mask": prob, "score": 0.7}]
    assert len(manager._postprocess(raw, "text", False, 60, 60, None, 8)) == 1
    assert len(manager._postprocess(raw, "text", True, 60, 60, None, 2)) == 2

    clipped = manager._postprocess([{"mask": prob, "score": 0.9}], "box", False,
                                   60, 60, (0, 0, 30, 30), 8)
    assert len(clipped) == 1
    assert clipped[0]["box"] == {"x": 5, "y": 5, "width": 25, "height": 25}


def test_manager_combined_box_and_points_prompts():
    """框 + 点组合：两种提示都要原样传给 SAM 3.1，并把结果裁到框内。"""
    from server.segmenters import manager as manager_module

    manager = SegmentManager()
    captured: dict = {}

    class FakeEngine:
        loaded = True

        def segment(self, image, *, mode, box, points, text, multi, progress=None):
            captured.update(mode=mode, box=box, points=points)
            prob = np.zeros((40, 40), dtype=np.float32)
            prob[5:35, 5:35] = 0.9
            return [{"mask": prob, "score": 0.9}]

    old_get = manager.get
    old_load = manager_module.app_config.load_config
    old_pick = registry.pick_model
    manager.get = lambda spec, cfg: FakeEngine()
    manager_module.app_config.load_config = lambda: {
        "segment": {"max_side": 2048, "max_candidates": 8, "timeout_s": 0}}
    registry.pick_model = lambda cfg, mode, requested=None: {
        "id": "sam3.1-multiplex", "engine": "sam3", "vram_mb": 100}
    try:
        image = Image.new("RGB", (40, 40), "white")
        result = manager.segment(
            image, mode="box",
            box={"x": 2, "y": 2, "width": 20, "height": 20},
            points=[{"x": 10, "y": 10}, {"x": 12, "y": 12, "label": 0}],
        )
        assert captured["mode"] == "box"
        assert captured["box"] == (2, 2, 22, 22)
        assert captured["points"] == [(10.0, 10.0, 1), (12.0, 12.0, 0)]
        # 结果被裁到框内（20×20 的框）
        assert result["masks"][0]["box"]["width"] <= 20
        assert result["masks"][0]["box"]["height"] <= 20
    finally:
        manager.get = old_get
        manager_module.app_config.load_config = old_load
        registry.pick_model = old_pick


def test_manager_status_and_idle_unload():
    manager = SegmentManager()
    assert manager.status()["loaded"] == {}
    assert manager.maybe_unload(10 ** 6, {"segment": {"idle_unload_minutes": 0}}) == []


def test_normalize_section_validation():
    current = _cfg(Path("."))["segment"]
    merged = registry.normalize_section(current, {
        "sam3": {"threshold": 0.7, "refine_iterations": 3},
        "default_model": "birefnet",
        "max_side": 3072,
    })
    assert merged["sam3"]["threshold"] == 0.7
    assert merged["sam3"]["refine_iterations"] == 3
    assert merged["default_model"] == "birefnet"
    assert merged["max_side"] == 3072
    # 未提交的字段保持原值
    assert merged["birefnet"]["model"] == "birefnet.safetensors"

    for bad, code in (
        ({"sam3": {"threshold": 1.5}}, "invalid_field"),
        ({"sam3": {"refine_iterations": 9}}, "invalid_field"),
        ({"default_model": "nope"}, "invalid_field"),
        ({"max_candidates": 99}, "invalid_field"),
        ("nope", "invalid_field"),
    ):
        try:
            registry.normalize_section(current, bad)
            raise AssertionError(f"应当拒绝无效设置：{bad}")
        except SegmentError as exc:
            assert exc.code == code
