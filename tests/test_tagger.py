"""WD14 图片反推：标签解析、模型目录扫描、阈值过滤与预处理。

不加载真实 ONNX：用伪造 session 验证张量布局与筛选逻辑，
保证测试在没装 onnxruntime / 没下载模型的机器上也能跑。
"""

from __future__ import annotations

import csv
import io
import shutil
import tempfile
from pathlib import Path

import pytest

from server import tagger


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix=".tmp_tagger_", dir=str(Path(__file__).parent)))


def _write_csv(path: Path, rows) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["tag_id", "name", "category", "count"])
        for row in rows:
            writer.writerow(row)


def _patch(cfg: dict, *, paths=None, session=None, tags=None, general=0, character=0):
    """临时替换 config 与模型加载，返回用于恢复的原函数。"""
    originals = (tagger.config.load_config, tagger._model_paths, tagger._session)
    tagger.config.load_config = lambda: cfg
    if paths is not None:
        tagger._model_paths = lambda name, cfg=None: paths
    if session is not None:
        tagger._session = lambda onnx, csv_path, replace: (session, tags, general, character)
    return originals


def _restore(originals) -> None:
    tagger.config.load_config, tagger._model_paths, tagger._session = originals


def _png_bytes(size=(16, 8), color=(10, 20, 30)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


class _FakeInput:
    def __init__(self, shape, name="pixels") -> None:
        self.shape = shape
        self.name = name


class _FakeSession:
    def __init__(self, shape, scores=None) -> None:
        self._input = _FakeInput(shape)
        self._scores = scores or []

    def get_inputs(self):
        return [self._input]

    def get_outputs(self):
        return [_FakeInput([len(self._scores)], "scores")]

    def run(self, _outputs, _feeds):
        import numpy as np

        return [np.asarray(self._scores, dtype=np.float32)[None, :]]


# --------------------------------------------------------------------------- CSV


def test_read_tags_splits_rating_general_character():
    folder = _tmp()
    try:
        path = folder / "tags.csv"
        _write_csv(
            path,
            [
                (0, "general", 9, 0),
                (1, "safe", 9, 0),
                (2, "long_hair", 0, 0),
                (3, "blue_eyes", 0, 0),
                (4, "hatsune_miku", 4, 0),
            ],
        )
        tags, general, character = tagger._read_tags(path, False)
        assert tags == ["general", "safe", "long_hair", "blue_eyes", "hatsune_miku"]
        assert general == 2
        assert character == 4

        replaced, general2, character2 = tagger._read_tags(path, True)
        assert replaced == ["general", "safe", "long hair", "blue eyes", "hatsune miku"]
        assert general2 == 2
        assert character2 == 4
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_read_tags_without_character_section_uses_end():
    folder = _tmp()
    try:
        path = folder / "tags.csv"
        _write_csv(path, [(0, "general", 9, 0), (1, "long_hair", 0, 0)])
        tags, general, character = tagger._read_tags(path, False)
        assert tags == ["general", "long_hair"]
        assert general == 1
        assert character == len(tags)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


# --------------------------------------------------------------------------- 模型发现


def test_list_models_reports_installed_entries():
    folder = _tmp()
    try:
        (folder / "wd-v1-4-moat-tagger-v2.onnx").write_bytes(b"x" * 4096)
        (folder / "custom-tagger.onnx").write_bytes(b"x" * 2048)
        (folder / "custom-tagger.csv").write_text("tag_id,name,category,count\n", encoding="utf-8")
        cfg = {
            "model_root": "",
            "tagger": {"dir": str(folder), "model": "wd-v1-4-moat-tagger-v2"},
        }
        originals = _patch(cfg)
        try:
            data = tagger.list_models()
        finally:
            _restore(originals)

        assert data["default"] == "wd-v1-4-moat-tagger-v2"
        assert data["dir"] == str(folder)
        moat = next(item for item in data["models"] if item["name"] == "wd-v1-4-moat-tagger-v2")
        # 缺 selected_tags.csv 时不算已安装
        assert moat["installed"] is False
        custom = next(item for item in data["models"] if item["name"] == "custom-tagger")
        assert custom["installed"] is True
        assert custom["known"] is False
        assert custom["dir"] == str(folder)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_hf_endpoints_prefers_official_then_mirror():
    import os

    original = os.environ.pop("HF_ENDPOINT", None)
    try:
        assert tagger._hf_endpoints() == [
            "https://huggingface.co",
            "https://hf-mirror.com",
        ]
        os.environ["HF_ENDPOINT"] = "hf-mirror.com"
        assert tagger._hf_endpoints() == ["https://hf-mirror.com"]
    finally:
        if original is None:
            os.environ.pop("HF_ENDPOINT", None)
        else:
            os.environ["HF_ENDPOINT"] = original


def test_download_dir_falls_back_to_storage_when_unwritable():
    folder = _tmp()
    try:
        # model_root 指向一个普通文件 → 其下的 onnx 目录无法创建
        blocker = folder / "blocked"
        blocker.write_text("x", encoding="utf-8")
        cfg = {"model_root": str(blocker), "tagger": {"dir": "", "model": "wd-v1-4-moat-tagger-v2"}}
        originals = (tagger.config.load_config, tagger.config.STORAGE_DIR)
        tagger.config.load_config = lambda: cfg
        tagger.config.STORAGE_DIR = str(folder / "storage")
        tagger._WRITABLE.clear()
        try:
            target = tagger.download_dir()
        finally:
            tagger.config.load_config, tagger.config.STORAGE_DIR = originals
            tagger._WRITABLE.clear()
        assert target == folder / "storage" / "models" / "wd14"
        assert target.is_dir()
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_missing_model_without_download():
    folder = _tmp()
    try:
        cfg = {"model_root": "", "tagger": {"dir": str(folder)}}
        originals = _patch(cfg)
        try:
            with pytest.raises(tagger.TaggerError) as ctx:
                tagger.tag_image(b"", model="wd-v14-missing", allow_download=False)
        finally:
            _restore(originals)
        assert ctx.value.code == "model_missing"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


# --------------------------------------------------------------------------- 预处理 / 推理


def test_preprocess_supports_nhwc_and_nchw():
    from PIL import Image

    image = Image.new("RGB", (8, 4), (10, 20, 30))
    nhwc, name = tagger._preprocess(image, _FakeSession([None, 4, 4, 3]))
    assert name == "pixels"
    assert nhwc.shape == (1, 4, 4, 3)

    nchw, _ = tagger._preprocess(image, _FakeSession([None, 3, 4, 4]))
    assert nchw.shape == (1, 3, 4, 4)
    # 8×4 图按 4×4 白底 letterbox：第 1 行才是图像，BGR 顺序（蓝 30 / 红 10）
    assert float(nchw[0, 0, 1, 0]) == 30
    assert float(nchw[0, 2, 1, 0]) == 10


def test_tag_image_filters_thresholds_and_orders_character_first():
    folder = _tmp()
    tags = ["rating_general", "long_hair", "extra_(pose)", "hatsune_miku", "rare_char"]
    scores = [0.99, 0.9, 0.4, 0.95, 0.5]
    session = _FakeSession([None, 4, 4, 3], scores)
    cfg = {"model_root": "", "tagger": {"dir": str(folder)}}
    originals = _patch(
        cfg,
        paths=(folder / "model.onnx", folder / "model.csv"),
        session=session,
        tags=tags,
        general=1,
        character=3,
    )
    try:
        result = tagger.tag_image(
            _png_bytes(),
            model="wd-v1-4-moat-tagger-v2",
            threshold=0.35,
            character_threshold=0.85,
        )
    finally:
        _restore(originals)
        shutil.rmtree(folder, ignore_errors=True)

    assert result["count"] == 3
    assert result["downloaded"] is False
    assert [item["tag"] for item in result["tags"]] == [
        "hatsune_miku",
        "long_hair",
        "extra_(pose)",
    ]
    assert result["tags"][0]["category"] == "character"
    assert result["prompt"] == "hatsune_miku, long_hair, extra_\\(pose\\)"


def test_tag_image_excludes_tags_and_trailing_comma():
    folder = _tmp()
    tags = ["rating_general", "long_hair", "hatsune_miku"]
    scores = [0.99, 0.9, 0.95]
    session = _FakeSession([None, 4, 4, 3], scores)
    cfg = {"model_root": "", "tagger": {"dir": str(folder)}}
    originals = _patch(
        cfg,
        paths=(folder / "model.onnx", folder / "model.csv"),
        session=session,
        tags=tags,
        general=1,
        character=2,
    )
    try:
        result = tagger.tag_image(
            _png_bytes(),
            model="wd-v1-4-moat-tagger-v2",
            exclude_tags="LONG_HAIR, watermark",
            trailing_comma=True,
        )
    finally:
        _restore(originals)
        shutil.rmtree(folder, ignore_errors=True)

    assert result["count"] == 1
    assert result["prompt"] == "hatsune_miku,"
