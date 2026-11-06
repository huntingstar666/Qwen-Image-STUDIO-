"""`server/backends/native.py` 的纯逻辑测试。

**不加载任何模型、不 import torch / comfy**（约 0.05s 跑完）。真实出图的验收走
`scripts/verify_native_engine.py`。

重点覆盖三类容易写错、又完全不依赖 GPU 的东西：

1. `reference_size` / `canvas_size` —— 必须与 ComfyUI `TextEncodeQwenImage21.execute`
   **逐位一致**（包括 Python 内置 round 的银行家舍入）；
2. `normalize_sigmas` / `slice_sigmas_for_denoise` —— Turbo 显式 sigma 与 denoise 截尾；
3. 状态字典结构 + 各条错误分支。

注意：本项目没有真 pytest（离线环境），`$PY -m pytest tests` 跑的是工作区根目录的
`pytest.py` 兼容 shim。它**不支持 parametrize / fixture / conftest**，所以这里全部
写成无参纯函数，参数化用函数内循环，临时目录用 tempfile。
"""

from __future__ import annotations

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.backends.native import (  # noqa: E402
    DEFAULT_ENGINE_DIR,
    PROJECT_ROOT,
    LATENT_CHANNELS,
    LATENT_DOWNSCALE,
    SNAP,
    TURBO_SIGMAS,
    EngineConfig,
    EngineError,
    NativeEngine,
    _CondCache,
    as_normal_tensor,
    callback_adapter,
    canvas_size,
    cond_cache_key,
    latent_hw,
    normalize_loras,
    normalize_sigmas,
    reference_size,
    slice_sigmas_for_denoise,
)

#: 一个必然不存在的 ComfyUI 根目录：用它构造引擎不会 import torch / comfy
FAKE_ROOT = os.path.join(os.path.dirname(ROOT), "__no_such_comfy_root__")


def _raises(exc_type, fn, *args, **kwargs):
    """断言 fn 抛 exc_type，返回异常消息（shim 的 raises 只给 value，这里包一层）。"""
    with pytest.raises(exc_type) as excinfo:
        fn(*args, **kwargs)
    return str(excinfo.value)


# ================================================================ inference tensor 归一化

def test_as_normal_tensor_converts_inference_tensor():
    """回归守卫：`tiled_scale` 产出的 inference tensor 必须能转成可原地改的普通张量。

    历史 bug：3 张参考图编辑时报
    `Inplace update to inference tensor outside InferenceMode is not allowed`。
    根因是 `comfy/sd.py::VAE.encode_tiled_` 对 `comfy.utils.tiled_scale`
    （带 `@torch.inference_mode()`）产出的张量做 `samples += ...` / `/= 3.0`。
    引擎的修法是 `_encode_vae()` 里整段包 inference_mode + 用本函数归一化输出。
    """
    import torch

    with torch.inference_mode():
        t = torch.zeros(2, 3, 4, 4)
    assert t.is_inference(), "inference_mode 里创建的张量应标记为 inference tensor"

    # 先确认原始症状可复现：在 inference_mode 之外原地改 inference tensor 会抛
    # （注意：抛错前底层可能已部分写入，所以下面另取新张量做归一化验证）
    message = ""
    try:
        t.add_(1)
    except RuntimeError as exc:
        message = str(exc)
    assert "InferenceMode" in message, f"预期抛 inference tensor 相关错误，实际: {message!r}"

    # 归一化后再原地改必须成功。注意用新张量：上面探测用的 t 可能已被部分写入
    with torch.inference_mode():
        fresh = torch.zeros(2, 3, 4, 4)
    normal = as_normal_tensor(fresh)
    assert not normal.is_inference()
    normal.add_(1)
    assert float(normal.sum()) == float(normal.numel())
    assert as_normal_tensor(None) is None


def test_as_normal_tensor_makes_contiguous():
    import torch

    view = torch.zeros(6, 4).t()        # 转置视图，非连续
    assert not view.is_contiguous()
    out = as_normal_tensor(view)
    assert out.is_contiguous()


# ================================================================ 常量

def test_constants_match_qwen_image_2_1():
    assert SNAP == 32
    assert LATENT_CHANNELS == 64
    assert LATENT_DOWNSCALE == 16
    # 官方 Turbo checkpoint 的 sample_sigmas：8 个值 = 8 步
    assert len(TURBO_SIGMAS) == 8
    assert TURBO_SIGMAS[0] == 1.0
    assert TURBO_SIGMAS[-1] == pytest.approx(0.414568)
    assert list(TURBO_SIGMAS) == sorted(TURBO_SIGMAS, reverse=True)


# ================================================================ reference_size

#: (width, height, resolution, expected) —— 期望值按节点公式手算
_REFERENCE_SIZE_CASES = [
    # resolution=0：原尺寸四舍五入到 32 的倍数
    (1024, 1024, 0, (1024, 1024)),
    (1920, 1080, 0, (1920, 1088)),          # 1080/32 = 33.75 -> 34
    (1080, 1920, 0, (1088, 1920)),
    (1000, 700, 0, (992, 704)),             # 31.25 -> 31 / 21.875 -> 22
    (100, 100, 0, (96, 96)),                # 3.125 -> 3
    # resolution>0：按面积 resolution² 等比缩放后 32 对齐
    (1024, 1024, 1024, (1024, 1024)),
    (2048, 2048, 2048, (2048, 2048)),
    (1920, 1080, 1024, (1376, 768)),
    (1080, 1920, 1024, (768, 1376)),
    (2000, 1000, 1024, (1440, 736)),
    (8000, 4000, 2048, (2912, 1440)),       # sqrt(2048²*2)=2896.3 -> 91*32
]


def test_reference_size_matches_node():
    for width, height, resolution, expected in _REFERENCE_SIZE_CASES:
        got = reference_size(width, height, resolution)
        assert got == expected, f"{width}x{height}@{resolution} -> {got} != {expected}"


def test_reference_size_uses_python_banker_rounding():
    """节点用的是内置 round，2.5 会舍到 2（银行家舍入），不能写成 int(x+0.5)。"""
    assert round(2.5) == 2
    assert reference_size(80, 320, 0) == (64, 320)      # 80/32 = 2.5 -> 2
    assert reference_size(144, 320, 0) == (128, 320)    # 144/32 = 4.5 -> 4
    assert reference_size(48, 320, 0) == (64, 320)      # 48/32 = 1.5 -> 2


def test_reference_size_clamps_to_32():
    # 极小的图四舍五入后可能变 0，节点里 max(32, ...) 兜底
    assert reference_size(1, 1, 0) == (32, 32)
    assert reference_size(16, 16, 0) == (32, 32)
    # resolution>0 时只看长宽比、不看原图大小，所以 1×1 也会被放大到 resolution²
    assert reference_size(1, 1, 1024) == (1024, 1024)


def test_reference_size_rejects_bad_input():
    for bad in [(0, 100, 0), (-1, 100, 0), (100, 0, 0), (100, 100, -32),
                (True, 100, 0), ("100", 100, 0)]:
        _raises(EngineError, reference_size, *bad)


# ================================================================ canvas / latent

def test_canvas_size_without_images_uses_resolution():
    # 等价节点的 `resolution or 1024`
    assert canvas_size(None, 0) == (1024, 1024)
    assert canvas_size([], 0) == (1024, 1024)
    assert canvas_size(None, 2048) == (2048, 2048)
    assert canvas_size([], 512) == (512, 512)


def test_canvas_size_follows_first_reference_image():
    assert canvas_size([(1024, 1024)], 0) == (1024, 1024)
    assert canvas_size([(1920, 1080)], 0) == (1920, 1088)
    # 多张参考图：只有第一张决定画布
    assert canvas_size([(640, 480), (2048, 2048)], 0) == (640, 480)
    assert canvas_size([(1920, 1080)], 1024) == (1376, 768)


def test_latent_hw_matches_empty_latent_shape():
    assert latent_hw(1024, 1024) == (64, 64)      # [1,64,64,64]
    assert latent_hw(2048, 2048) == (128, 128)
    assert latent_hw(1280, 768) == (48, 80)
    assert latent_hw(1, 1) == (1, 1)
    _raises(EngineError, latent_hw, 0, 100)


# ================================================================ sigmas

def test_normalize_sigmas_appends_zero_for_turbo():
    out = normalize_sigmas(list(TURBO_SIGMAS))
    assert out == [*TURBO_SIGMAS, 0.0]
    assert len(out) == 9          # 9 个值 = 8 步


def test_normalize_sigmas_does_not_duplicate_zero():
    assert normalize_sigmas([1.0, 0.5, 0.0]) == [1.0, 0.5, 0.0]
    assert normalize_sigmas([0.0]) == [0.0]
    assert normalize_sigmas([1.0, 0.5]) == [1.0, 0.5, 0.0]


def test_normalize_sigmas_accepts_string_and_tuple():
    assert normalize_sigmas("1.0, 0.978453, 0.5, 0") == [1.0, 0.978453, 0.5, 0.0]
    assert normalize_sigmas("1;0.5;0") == [1.0, 0.5, 0.0]
    assert normalize_sigmas((1.0, 0.5)) == [1.0, 0.5, 0.0]
    assert normalize_sigmas([1, 0]) == [1.0, 0.0]     # int 也接受


def test_normalize_sigmas_append_zero_can_be_disabled():
    assert normalize_sigmas([1.0, 0.5], append_zero=False) == [1.0, 0.5]


def test_normalize_sigmas_rejects_bad_input():
    for bad in ([], "", "   ", [1.0, 2.0], [1.0, 0.5, 0.7], ["a"], [None],
                [-0.1], [float("nan")], [float("inf")], 123, {"a": 1}, None):
        _raises(EngineError, normalize_sigmas, bad)


def test_slice_sigmas_for_denoise():
    values = normalize_sigmas(list(TURBO_SIGMAS))       # 9 个值
    assert len(values) == 9
    assert slice_sigmas_for_denoise(values, 1.0) == values
    assert slice_sigmas_for_denoise(values, 0.9999) == values
    # denoise=0.5：8 步 -> 取后 4 步 + 结尾 0.0
    half = slice_sigmas_for_denoise(values, 0.5)
    assert half[-1] == 0.0
    assert half == values[4:]
    # denoise=0.25：只留最后 2 步
    assert slice_sigmas_for_denoise(values, 0.25) == values[6:]
    # denoise=0：只剩结尾 0.0
    assert slice_sigmas_for_denoise(values, 0.0) == [0.0]
    # 短列表也不炸
    assert slice_sigmas_for_denoise([1.0, 0.0], 0.5) == [1.0, 0.0]
    assert slice_sigmas_for_denoise([], 0.5) == []


def test_slice_sigmas_denoise_keeps_result_monotonic():
    values = normalize_sigmas(list(TURBO_SIGMAS))
    for denoise in (0.1, 0.3, 0.5, 0.75, 0.9):
        sliced = slice_sigmas_for_denoise(values, denoise)
        assert sliced[-1] == 0.0
        assert sliced == sorted(sliced, reverse=True)
        assert 2 <= len(sliced) <= len(values)


# ================================================================ loras

def test_normalize_loras_defaults():
    out = normalize_loras([{"name": "a.safetensors", "strength": 0.8}])
    assert out == [{"name": "a.safetensors", "strength": 0.8, "strength_clip": 0.8}]


def test_normalize_loras_accepts_path_key_and_strength_clip():
    out = normalize_loras([{"path": "/tmp/a.safetensors", "strength": 1,
                            "strength_clip": 0.5}])
    assert out[0]["name"] == "/tmp/a.safetensors"
    assert out[0]["strength"] == 1.0
    assert out[0]["strength_clip"] == 0.5


def test_normalize_loras_empty():
    assert normalize_loras([]) == []
    assert normalize_loras(None) == []


def test_normalize_loras_rejects_bad_input():
    for bad in (["a.safetensors"], [{"strength": 1.0}], [{"name": ""}],
                [{"name": "a", "strength": "strong"}],
                [{"name": "a", "strength_clip": "loud"}]):
        _raises(EngineError, normalize_loras, bad)


# ================================================================ callback 适配

def test_callback_adapter_maps_signature():
    calls = []
    wrapped = callback_adapter(lambda step, total, latent: calls.append((step, total, latent)))
    assert wrapped is not None
    # ComfyUI 回调签名是 (i, denoised, x, total_steps)
    wrapped(3, "denoised", "x", 8)
    assert calls == [(3, 8, "denoised")]


def test_callback_adapter_none():
    assert callback_adapter(None) is None


def test_callback_adapter_records_and_reraises_user_error():
    """回调里抛的取消信号必须原样抛出并记录，供 sample() 不要包成 EngineError。"""

    class _Cancel(BaseException):
        pass

    errors = []

    def cb(step, total, latent):
        raise _Cancel("stop")

    wrapped = callback_adapter(cb, on_error=errors)
    with pytest.raises(_Cancel):
        wrapped(0, "denoised", "x", 8)
    assert len(errors) == 1 and isinstance(errors[0], _Cancel)


# ================================================================ EngineConfig / 构造

def test_engine_config_resolve_prefers_arguments():
    cfg = EngineConfig(engine_dir="C:/c", unet="u", clip="c", vae="v")
    assert cfg.resolve() == {"unet": "u", "clip": "c", "vae": "v"}
    assert cfg.resolve(unet="u2") == {"unet": "u2", "clip": "c", "vae": "v"}
    assert cfg.resolve(clip=None) == {"unet": "u", "clip": "c", "vae": "v"}


def test_engine_config_defaults():
    cfg = EngineConfig(engine_dir="C:/c")
    assert cfg.vram_reserve == 0.15
    assert cfg.dtype == "default"
    assert cfg.resolve() == {"unet": None, "clip": None, "vae": None}


def test_engine_accepts_valid_dtype():
    for dtype in ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"):
        engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT, dtype=dtype))
        assert engine.config.dtype == dtype


def test_engine_rejects_invalid_dtype():
    for dtype in ("bogus", "fp16", "", None):
        _raises(EngineError, NativeEngine, EngineConfig(engine_dir=FAKE_ROOT, dtype=dtype))


def test_engine_rejects_invalid_vram_reserve():
    for reserve in (-0.1, 1.0, 2, "x"):
        _raises(EngineError, NativeEngine,
                EngineConfig(engine_dir=FAKE_ROOT, vram_reserve=reserve))


def test_engine_rejects_bad_config_object():
    _raises(EngineError, NativeEngine, {"engine_dir": FAKE_ROOT})


def test_engine_resolves_engine_dir_from_project_root():
    # 传工作区根目录也能自动找到它下面的 engine/（只读探测，不建临时目录：
    # DSH 沙箱禁止 chmod，tempfile 的清理会 PermissionError）。
    if not os.path.isfile(os.path.join(DEFAULT_ENGINE_DIR, "comfy", "sd.py")):
        pytest.skip("项目内没有 engine/，跳过")
    engine = NativeEngine(EngineConfig(engine_dir=PROJECT_ROOT))
    assert engine.config.engine_dir == os.path.abspath(DEFAULT_ENGINE_DIR)


def test_engine_accepts_legacy_comfy_root_alias():
    # 旧字段名 comfy_root 仍可作为 engine_dir 的别名（两者都给时 engine_dir 优先）
    cfg = EngineConfig(comfy_root="C:/legacy")
    assert cfg.resolve_dir() == "C:/legacy"
    cfg2 = EngineConfig(engine_dir="C:/engine", comfy_root="C:/legacy")
    assert cfg2.resolve_dir() == "C:/engine"


def test_engine_empty_dir_keeps_status_reportable():
    engine = NativeEngine(EngineConfig())
    assert engine.config.engine_dir == ""
    st = engine.status()
    assert st["available"] is False and "engine_dir" in (st["reason"] or "")


def test_engine_keeps_unknown_root_for_status_reporting():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    assert engine.config.engine_dir == os.path.abspath(FAKE_ROOT)


# ================================================================ 错误分支

def test_engine_error_is_runtime_error():
    assert issubclass(EngineError, RuntimeError)


def test_ensure_loaded_without_models_raises_quickly():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    msg = _raises(EngineError, engine.ensure_loaded)
    assert "unet" in msg and "clip" in msg and "vae" in msg


def test_ensure_loaded_missing_file():
    # 路径校验发生在 import torch / comfy 之前，所以这条分支又快又不碰 GPU
    engine = NativeEngine(EngineConfig(
        engine_dir=FAKE_ROOT,
        unet=os.path.join(FAKE_ROOT, "nope1.safetensors"),
        clip=os.path.join(FAKE_ROOT, "nope2.safetensors"),
        vae=os.path.join(FAKE_ROOT, "nope3.safetensors")))
    msg = _raises(EngineError, engine.ensure_loaded)
    assert "模型文件不存在" in msg


def test_encode_text_requires_loaded_models():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    msg = _raises(EngineError, engine.encode_text, "hello")
    assert "模型未装载" in msg


def test_apply_loras_requires_loaded_models():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    msg = _raises(EngineError, engine.apply_loras,
                  [{"name": "x.safetensors", "strength": 1.0}])
    assert "模型未装载" in msg


def test_encode_latent_requires_pil():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    _raises(EngineError, engine.encode_latent, "not an image")


def test_free_without_models_is_safe():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    engine.free()
    engine.free(unload=True)
    assert engine.status()["loaded"]["unet"] is None


# ================================================================ status

def test_status_unavailable_shape():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    st = engine.status()
    for key in ("available", "reason", "engine_dir", "comfy_root", "device", "vram_total_mb",
                "vram_free_mb", "loaded"):
        assert key in st, key
    assert st["available"] is False
    assert st["reason"] and "engine_dir" in st["reason"]
    assert st["device"] is None
    assert st["vram_total_mb"] == 0 and st["vram_free_mb"] == 0
    assert st["loaded"] == {"unet": None, "clip": None, "vae": None, "loras": []}


def test_status_is_stable_and_cheap_when_unavailable():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    assert engine.status() == engine.status()


def test_status_loaded_loras_shape():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    assert isinstance(engine.status()["loaded"]["loras"], list)


# ================================================================ 文本编码缓存

def test_cond_cache_lru_and_stats():
    cache = _CondCache(2)
    cache.put("a", {"v": 1})
    cache.put("b", {"v": 2})
    assert cache.get("a")["v"] == 1        # 命中 a，b 变成最久未用
    cache.put("c", {"v": 3})               # 淘汰 b
    assert cache.get("b") is None
    assert cache.get("a")["v"] == 1
    assert cache.get("c")["v"] == 3
    st = cache.stats()
    assert st["size"] == 2 and st["max"] == 2
    assert st["hits"] == 3 and st["misses"] == 1


def test_cond_cache_disabled_when_size_zero():
    cache = _CondCache(0)
    assert cache.enabled is False
    cache.put("a", {})
    assert cache.get("a") is None
    assert cache.stats()["size"] == 0


def test_cond_cache_key_stable_and_image_sensitive():
    from PIL import Image

    red = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
    red_copy = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
    blue = Image.new("RGBA", (64, 64), (0, 0, 255, 255))

    base = cond_cache_key("p", "", 0, [], 1)
    assert base == cond_cache_key("p", "", 0, [], 1)
    assert base != cond_cache_key("p2", "", 0, [], 1)        # 提示词变了
    assert base != cond_cache_key("p", "neg", 0, [], 1)      # 负向变了
    assert base != cond_cache_key("p", "", 1024, [], 1)      # resolution 变了
    assert base != cond_cache_key("p", "", 0, [], 2)         # 权重代号变了

    # 参考图按像素内容摘要：同图重新加载也命中，换色就不命中
    assert cond_cache_key("p", "", 0, [red], 1) == cond_cache_key("p", "", 0, [red_copy], 1)
    assert cond_cache_key("p", "", 0, [red], 1) != cond_cache_key("p", "", 0, [blue], 1)


def test_clear_encode_cache_drops_entries_and_bumps_generation():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT))
    assert engine._encode_cache.enabled
    engine._encode_cache.put("k", {})
    before = engine._weights_generation
    engine.clear_encode_cache()
    assert engine._encode_cache.stats()["size"] == 0
    assert engine._weights_generation == before + 1
    assert engine.status()["encode_cache"]["max"] == 8


def test_encode_cache_size_zero_disables():
    engine = NativeEngine(EngineConfig(engine_dir=FAKE_ROOT, encode_cache_size=0))
    assert engine._encode_cache.enabled is False
    assert engine.status()["encode_cache"]["max"] == 0
