"""零偏移契约守卫与端到端回归。

两类测试：

* 契约守卫（纯几何，秒级）：矛盾参数直接拒绝，几何走样拒绝落盘；
* 端到端（假引擎，不占显存）：把 ``Pipeline.generate_edit`` 全链路跑一遍，
  断言「遮罩外字节级不变 / 输出尺寸回到源尺寸 / 采样画布 == 参考图画布 /
  预处理可逆 / 扩图不裁回」，真实权重由本机环境另行验证。
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageOps

from server import imaging, jobs, pipeline

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


# ---------------------------------------------------------------------------
# 端到端：假引擎跑完整 generate_edit（不加载真实权重）
# ---------------------------------------------------------------------------


def _noise_image(w: int, h: int, seed: int = 7) -> Image.Image:
    """确定性噪声图：任何重采样/整体校色都会破坏字节级相等。"""
    rng = np.random.default_rng(seed)
    return Image.fromarray(rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8))


def _src_url(image: Image.Image) -> str:
    return imaging.data_url("image/png", imaging.encode_png(image))


def _mask_bytes(w: int, h: int, box: tuple[int, int, int, int]) -> bytes:
    """``box`` 用半开区间 (x0, y0, x1, y1)，与 :func:`_outside_diff` 口径一致。"""
    canvas = Image.new("RGB", (w, h), (0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(canvas).rectangle((x0, y0, x1 - 1, y1 - 1), fill=(255, 255, 255))
    return imaging.encode_png(canvas)


class _FakeEngine:
    """把「模型」换成一个确定性的像素变换，只验证管线几何/合成。"""

    def __init__(self, transform=None):
        self.transform = transform or (lambda im: ImageOps.invert(im.convert("RGB")))
        self.seen: dict = {}

    def status(self):
        return {"loaded": {"unet": True, "clip": True, "vae": True, "loras": []}}

    def ensure_loaded(self, **kwargs):
        self.seen["models"] = kwargs

    def apply_loras(self, loras):
        self.seen["loras"] = list(loras or [])

    def warmup(self, **_kwargs):
        pass

    def encode_text(self, prompt, negative, *, images=None, resolution=0):
        self.seen["prompt"] = prompt
        self.seen["images"] = list(images or [])
        self.seen["resolution"] = int(resolution)
        return {
            "positive": [prompt],
            "negative": [negative],
            "canvas": images[0].size,
        }

    def encode_latent(self, image):
        self.seen["latent_size"] = image.size
        self.seen["canvas"] = image.size
        return image

    def sample(self, **kwargs):
        return self.transform(kwargs["latent"])

    def decode(self, samples):
        return samples

    def free(self, unload=False):
        pass


def _run_edit(params: dict, fake: _FakeEngine):
    """在内存存储上跑一次 generate_edit，返回 (job, 落盘字节)。"""
    sink: dict = {}
    old_upload = pipeline.storage.save_upload
    old_output = pipeline.storage.save_output
    old_models = pipeline._resolve_models
    old_loras = pipeline._build_loras
    pipeline.storage.save_upload = lambda data, **_kw: {
        "id": "up", "url": "mem://up", "bytes": len(data),
        "width": 0, "height": 0, "has_alpha": False, "format": "PNG",
    }

    def _save_output(data, **_kw):
        sink["png"] = data
        return {
            "id": "out", "url": "mem://out", "bytes": len(data),
            "width": 0, "height": 0, "has_alpha": False, "format": "PNG",
        }

    pipeline.storage.save_output = _save_output
    pipeline._resolve_models = lambda *_a, **_kw: {
        "unet": "mem://unet", "clip": "mem://clip", "vae": "mem://vae",
    }
    pipeline._build_loras = lambda *_a, **_kw: []
    try:
        job = jobs.Job(id="e2e", kind="edit", prompt="把这里换成蓝天", params=params)
        pipeline.Pipeline(engine=fake).generate_edit(job)
    finally:
        pipeline.storage.save_upload = old_upload
        pipeline.storage.save_output = old_output
        pipeline._resolve_models = old_models
        pipeline._build_loras = old_loras
    return job, sink


def _outside_diff(source: Image.Image, output: Image.Image, box) -> int:
    """遮罩外最大绝对差（0 = 字节级不变）。"""
    m = np.zeros((source.height, source.width), dtype=bool)
    m[box[1]: box[3], box[0]: box[2]] = True
    a = np.asarray(source.convert("RGB"), dtype=np.int16)
    b = np.asarray(output.convert("RGB"), dtype=np.int16)
    return int(np.abs(a - b).max(axis=2)[~m].max())


def test_generate_edit_follow_is_pixel_exact_outside_mask():
    src = _noise_image(1000, 700)
    box = (400, 250, 600, 450)
    fake = _FakeEngine()
    job, sink = _run_edit({
        "images": [{"data": _src_url(src)}],
        "mask": imaging.data_url("image/png", _mask_bytes(1000, 700, box)),
    }, fake)

    quality = job.quality
    assert quality["size_match"] is True
    assert (quality["output"]["w"], quality["output"]["h"]) == (1000, 700)
    assert quality["outside_max_abs"] == 0
    assert quality["leak_ratio"] == 0
    # 零偏移契约：resolution=0 且采样画布 == 参考图画布
    assert fake.seen["resolution"] == 0
    assert fake.seen["latent_size"] == fake.seen["canvas"] == (1024, 704)
    # 落盘结果在遮罩外与原图字节级相同（端到端，不只是画布阶段）
    final = imaging.decode_image(sink["png"])
    assert final.size == (1000, 700)
    assert _outside_diff(src, final, box) == 0


def test_generate_edit_preprocess_restores_source_size():
    src = _noise_image(3000, 2000)
    box = (1400, 900, 1600, 1100)
    fake = _FakeEngine()
    job, sink = _run_edit({
        "images": [{"data": _src_url(src)}],
        "mask": imaging.data_url("image/png", _mask_bytes(3000, 2000, box)),
        "preprocess": {"enabled": True, "max_side": 2048},
    }, fake)

    quality = job.quality
    assert quality["preprocess"]["applied"] is True
    assert quality["preprocess"]["canvas"] == {"w": 2048, "h": 1376}
    assert quality["outside_max_abs"] == 0
    # 预处理还原：输出必须回到源尺寸（唯一一次重采样发生在还原阶段）
    assert (quality["output"]["w"], quality["output"]["h"]) == (3000, 2000)
    assert imaging.decode_image(sink["png"]).size == (3000, 2000)


def test_generate_edit_crop_scheme_stitches_bytes_exactly():
    src = _noise_image(1000, 700, seed=11)
    # 靠左上角的遮罩：裁切会越界，走边缘众数色补 + 越界求交贴回
    box = (16, 16, 216, 216)
    fake = _FakeEngine()
    job, _sink = _run_edit({
        "images": [{"data": _src_url(src)}],
        "mask": imaging.data_url("image/png", _mask_bytes(1000, 700, box)),
        "local": {"enabled": True, "scheme": "b", "fills": True},
    }, fake)

    quality = job.quality
    assert quality["scheme"] == "b"
    assert job.align["crop"]["w"] > 0
    assert quality["outside_max_abs"] == 0
    assert quality["leak_ratio"] == 0


def test_generate_edit_outpaint_keeps_expanded_canvas():
    src = _noise_image(1000, 700, seed=3)
    fake = _FakeEngine()
    job, sink = _run_edit({
        "images": [{"data": _src_url(src)}],
        "task": {"mode": "outpaint"},
        "outpaint": {"left": 10, "right": 10, "top": 5, "bottom": 5},
    }, fake)

    quality = job.quality
    assert quality["task_mode"] == "outpaint"
    assert quality["zero_shift"]["enabled"] is False
    assert quality["outpaint"] is not None
    # 扩图不裁回：输出就是外扩后的画布
    assert quality["output"]["w"] > src.width
    assert quality["output"]["h"] > src.height
    assert imaging.decode_image(sink["png"]).size == (
        quality["output"]["w"], quality["output"]["h"])


def test_generate_edit_remove_task_paints_green_hint_inside_mask():
    src = _noise_image(1000, 700, seed=5)
    box = (400, 250, 600, 450)
    plan = imaging.plan_canvas(src.width, src.height, mode="follow", fit="pad")
    canvas = imaging.compose_canvas(src, plan, pad_mode="edge")

    fake = _FakeEngine()
    _run_edit({
        "images": [{"data": _src_url(src)}],
        "mask": imaging.data_url("image/png", _mask_bytes(1000, 700, box)),
        "task": {"mode": "remove"},
    }, fake)

    overlay = fake.seen["images"][0]
    inside_before = canvas.getpixel((500, 350))
    inside_after = overlay.getpixel((500, 350))
    # 遮罩内被染向绿色（提示图是 Remove LoRA 的训练约定）
    assert inside_after != inside_before
    assert inside_after[1] > inside_before[1]
    # 遮罩外保持画布原样
    assert overlay.getpixel((50, 50)) == canvas.getpixel((50, 50))
