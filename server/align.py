# -*- coding: utf-8 -*-
"""几何 / 颜色算法核（无 torch 移植版）。

本模块是 ComfyUI 自定义节点包 **ComfyUI-Precise-Align** 与本机 BlueBox 包中
``CutQwenImage21`` 的算法移植，但**不依赖 torch / cv2 / ComfyUI**，只使用
numpy + PIL，方便本项目服务端（FastAPI）直接调用，不再经过 ComfyUI 节点图。

移植对照表（源码路径均为只读参考）：

====================================================  ==========================================
本模块函数                                             参考实现
====================================================  ==========================================
:func:`snap_dims` / :func:`pad_image`                  ``PreciseAlignPad.pad`` +
                                                        ``_scale_dims`` / ``_pad_bhwc``
:func:`crop_back`                                      ``PreciseAlignCropBack.crop``
                                                        （含 "解码尺寸 != 画布尺寸" 的按比例兜底）
:func:`fixed_point_size`                               ``ComfyUI-BlueBox/nodes/cut_qwen_image_21.py``
                                                        ``CutQwenImage21.run``（白名单 + 打分 + 不动点校验）
:func:`dilate_mask`                                    ``_dilate``（max_pool2d 等价，可分离实现）
:func:`feather_mask`                                   ``_feather``（高斯可分离卷积）
:func:`curve_mask`                                     ``_apply_curve``
:func:`band_from_mask`                                 ``_band_from_mask``
:func:`reinhard_match`                                 ``_color_match``（Reinhard 仿射匹配）
:func:`diff_map` / :func:`mad_threshold`                ``color_calibrator_bluebox.py`` 的差异图与 MAD 阈值
:func:`anchor_affine`                                  ``color_calibrator_bluebox.py`` 的锚区逐通道仿射
:func:`lowfreq_merge`                                  ``color_calibrator_bluebox.py`` 的金字塔低频移植
:func:`changed_stats`                                  ``color_calibrator_bluebox.py`` 的改动/泄漏比例
:func:`region_shapes_to_mask`                          ``_rasterize_shapes``
:func:`transform_mask` / :func:`inverse_transform_mask` ``_mask_to_canvas`` 与 CropBack 的 mask 分支
:func:`latent_tokens`                                  ``_sanity_warnings`` 里的 token 估算
====================================================  ==========================================

约定（与 BUILD_CONTRACT.md 第 2.1 节一致）：

* 所有遮罩都是 ``np.float32``，形状 ``(H, W)``，值域 ``[0, 1]``，``1`` = 要编辑的区域。
* 所有画布尺寸都是 ``multiple``（Qwen-Image 2.1 用 32）的倍数。
* 颜色一律用 float32 ``[0, 1]`` 计算；像素最终以 uint8 落盘时四舍五入。
* ``scale_by == 1.0`` 时**绝不重采样**——这是 ``pad_image → crop_back``
  能逐像素还原（``max_abs == 0``）的前提。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

__all__ = [
    "MULTIPLE",
    "PAD_MODES",
    "ALIGN_MODES",
    "SCALE_METHODS",
    "PadInfo",
    "snap_dims",
    "pad_image",
    "crop_back",
    "fixed_point_size",
    "is_fixed_point",
    "dilate_mask",
    "feather_mask",
    "curve_mask",
    "band_from_mask",
    "fill_mask_holes",
    "ign_dither",
    "reinhard_match",
    "diff_map",
    "mad_threshold",
    "anchor_affine",
    "lowfreq_merge",
    "changed_stats",
    "region_shapes_to_mask",
    "transform_mask",
    "inverse_transform_mask",
    "latent_tokens",
    "resize_mask",
]

#: Qwen-Image 2.1 的 VAE 下采样步长（8x 空间下采样 * 2x2 patch = 32）。
MULTIPLE = 32
PAD_MODES = ("edge", "reflect", "gray", "black", "white")
ALIGN_MODES = ("center", "top_left")
SCALE_METHODS = ("lanczos", "bicubic", "bilinear", "area", "nearest-exact")

_CURVES = ("smoothstep", "linear")

_PIL_RESAMPLE = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
    "bilinear": Image.Resampling.BILINEAR,
    "area": Image.Resampling.BOX,
    "nearest-exact": Image.Resampling.NEAREST,
    "nearest": Image.Resampling.NEAREST,
}


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class PadInfo:
    """补边 / 缩放的完整几何记录，供 :func:`crop_back` 精确逆变换。

    字段对应 Precise-Align 节点里 ``PAD_INFO_TYPE`` 字典的化简版：

    * ``orig_w/orig_h``   原图尺寸
    * ``scale``           有效缩放倍率（= ``out_w / orig_w``；``scale_by==1`` 时为 1.0）
    * ``out_w/out_h``     缩放后、补边前的尺寸
    * ``pad_l/pad_t``     缩放图在画布中的左上角偏移（右/下补边由画布尺寸推出）
    * ``canvas_w/canvas_h`` 最终画布尺寸（``multiple`` 的倍数）
    * ``multiple``        对齐步长
    * ``pad_mode``        补边方式（用于日志/复现，不参与逆变换）
    """

    orig_w: int
    orig_h: int
    scale: float
    out_w: int
    out_h: int
    pad_l: int
    pad_t: int
    canvas_w: int
    canvas_h: int
    multiple: int
    pad_mode: str


# ---------------------------------------------------------------------------
# 基础工具（对应 Precise-Align 的 _scale_dims / _resize_bhwc / _pad_bhwc）
# ---------------------------------------------------------------------------


def _ceil_to(value: int, multiple: int) -> int:
    return ((int(value) + multiple - 1) // multiple) * multiple


def snap_dims(w: int, h: int, multiple: int = 32) -> tuple[int, int]:
    """把 ``(w, h)`` 向上对齐到 ``multiple`` 的倍数，最小值 ``multiple``。

    对应 ``PreciseAlignPad.pad`` 里的::

        pad_w = (-scaled_w) % multiple
        padded_w = scaled_w + pad_w

    以及 BlueBox/ComfyUI 的 "尺寸必须是 32 倍数" 硬约束。
    """
    multiple = max(1, int(multiple))
    w = max(1, int(w))
    h = max(1, int(h))
    return max(multiple, _ceil_to(w, multiple)), max(multiple, _ceil_to(h, multiple))


def _resample(method: str) -> Image.Resampling:
    key = str(method or "lanczos").lower()
    if key not in _PIL_RESAMPLE:
        # 与参考实现一致：未知算法退回 bicubic，不抛异常打断工作流。
        key = "bicubic"
    return _PIL_RESAMPLE[key]


def _scale_dims(width: int, height: int, scale_by: float, step: int) -> tuple[int, int]:
    """对应 Precise-Align ``_scale_dims``：``scale_by==1`` 时原样返回（不重采样）。

    缩放后宽高必须是 ``step`` 的倍数（参考实现里的 ``scale_step``，本项目固定取
    ``multiple``），这样补边量通常为 0，画布与缩放图完全重合。
    """
    if abs(float(scale_by) - 1.0) < 1e-6:
        return int(width), int(height)
    step = max(1, int(step))
    tw = max(step, int(round(width * float(scale_by) / step)) * step)
    th = max(step, int(round(height * float(scale_by) / step)) * step)
    return tw, th


def _ensure_supported_mode(im: Image.Image) -> Image.Image:
    """把非常规模式（P / CMYK / I 等）统一成 RGB 或 RGBA，避免 numpy 补边出错。"""
    if im.mode in ("RGB", "RGBA", "L", "LA"):
        return im
    has_alpha = im.mode in ("PA",) or ("transparency" in im.info)
    return im.convert("RGBA" if has_alpha else "RGB")


def _pad_array(
    arr: np.ndarray,
    left: int,
    top: int,
    right: int,
    bottom: int,
    pad_mode: str,
    pad_value: float,
) -> np.ndarray:
    """numpy 版 ``_pad_bhwc``：edge=replicate、reflect=镜像、solid=纯色。

    注意：参考实现里 ``reflect`` 在小图上会 ``RuntimeError`` 并退回 ``replicate``，
    numpy 的 ``reflect`` 支持大于边长的补边，这里同样 try/except 兜底成 edge。
    """
    if left == right == top == bottom == 0:
        return arr
    if pad_mode not in PAD_MODES:
        raise ValueError(f"未知 pad_mode={pad_mode!r}，可选 {PAD_MODES}")

    if arr.ndim == 2:
        pad_width = ((int(top), int(bottom)), (int(left), int(right)))
    else:
        pad_width = ((int(top), int(bottom)), (int(left), int(right)), (0, 0))

    if pad_mode == "edge":
        return np.pad(arr, pad_width, mode="edge")
    if pad_mode == "reflect":
        try:
            return np.pad(arr, pad_width, mode="reflect")
        except (ValueError, RuntimeError):
            return np.pad(arr, pad_width, mode="edge")

    if pad_mode == "black":
        fill = 0
    elif pad_mode == "white":
        fill = 255
    else:  # gray
        fill = int(round(max(0.0, min(1.0, float(pad_value))) * 255.0))
    padded = np.pad(arr, pad_width, mode="constant", constant_values=fill)
    if arr.ndim == 3 and arr.shape[2] in (2, 4):
        # 纯色补边时 alpha 必须是不透明的 255，而不是把灰度值当 alpha。
        padded[..., -1] = 255
        padded[int(top): int(top) + arr.shape[0], int(left): int(left) + arr.shape[1], -1] = arr[..., -1]
    return padded


# ---------------------------------------------------------------------------
# 方案 A-1：pad_image（对应 PreciseAlignPad.pad）
# ---------------------------------------------------------------------------


def pad_image(
    im: Image.Image,
    *,
    multiple: int = 32,
    pad_mode: str = "edge",
    align: str = "center",
    pad_value: float = 0.5,
    scale_by: float = 1.0,
    scale_method: str = "lanczos",
) -> tuple[Image.Image, PadInfo]:
    """缩放 + 补边到 ``multiple`` 的倍数，返回 ``(画布图, PadInfo)``。

    与 ``PreciseAlignPad.pad`` 的对应关系：

    1. ``_scale_dims`` → 可选缩放（``scale_by==1.0`` 时完全跳过重采样）；
    2. ``pad_h = (-scaled_h) % multiple`` → 补边量；
    3. ``align="center"``（默认）居中补边，``"top_left"`` 只补右下；
    4. ``_pad_bhwc`` → edge/reflect/gray/black/white 五种补边方式。

    返回的画布尺寸恒为 ``multiple`` 的倍数。颜色空间不变（不转 ICC、不改 gamma），
    因此解码回源尺寸后可以与原图像素级对齐。
    """
    if pad_mode not in PAD_MODES:
        raise ValueError(f"未知 pad_mode={pad_mode!r}，可选 {PAD_MODES}")
    if align not in ALIGN_MODES:
        raise ValueError(f"未知 align={align!r}，可选 {ALIGN_MODES}")
    multiple = max(1, int(multiple))
    if float(scale_by) <= 0:
        raise ValueError("scale_by 必须 > 0")

    im = _ensure_supported_mode(im)
    orig_w, orig_h = im.size
    out_w, out_h = _scale_dims(orig_w, orig_h, scale_by, multiple)

    work = im if (out_w, out_h) == (orig_w, orig_h) else im.resize((out_w, out_h), _resample(scale_method))

    pad_w = (-out_w) % multiple
    pad_h = (-out_h) % multiple
    if align == "top_left":
        left, top = 0, 0
    else:
        left, top = pad_w // 2, pad_h // 2
    right, bottom = pad_w - left, pad_h - top

    arr = np.asarray(work)
    padded = _pad_array(arr, left, top, right, bottom, pad_mode, pad_value)
    canvas = Image.fromarray(padded)

    info = PadInfo(
        orig_w=orig_w,
        orig_h=orig_h,
        scale=float(out_w) / float(orig_w) if orig_w else 1.0,
        out_w=out_w,
        out_h=out_h,
        pad_l=left,
        pad_t=top,
        canvas_w=out_w + pad_w,
        canvas_h=out_h + pad_h,
        multiple=multiple,
        pad_mode=pad_mode,
    )
    return canvas, info


# ---------------------------------------------------------------------------
# 方案 A-2：crop_back（对应 PreciseAlignCropBack.crop）
# ---------------------------------------------------------------------------


def crop_back(im: Image.Image, info: PadInfo, *, method: str = "bicubic") -> Image.Image:
    """把画布尺寸的图精确裁回原图尺寸：先裁 pad，再缩回 ``orig_w x orig_h``。

    对应 ``PreciseAlignCropBack.crop``：纯几何、不改颜色空间。

    * ``scale_by == 1.0`` 时 ``out_* == orig_*``、裁剪窗口与 :func:`pad_image`
      的补边一一对应，结果与原图**逐像素完全一致**（零偏移验收点）。
    * 若解码图尺寸和 ``info.canvas_w/h`` 不一致（例如模型内部改了尺寸），
      按参考实现的做法按比例映射裁剪窗口，不直接报错。
    """
    im = _ensure_supported_mode(im)
    w, h = im.size
    ow, oh = int(info.orig_w), int(info.orig_h)
    sw, sh = int(info.out_w), int(info.out_h)
    left, top = int(info.pad_l), int(info.pad_t)
    pw, ph = int(info.canvas_w), int(info.canvas_h)

    if (w, h) != (pw, ph):
        sx, sy = w / float(pw), h / float(ph)
        left = int(round(left * sx))
        top = int(round(top * sy))
        sw = max(1, int(round(sw * sx)))
        sh = max(1, int(round(sh * sy)))

    left = max(0, min(left, max(0, w - 1)))
    top = max(0, min(top, max(0, h - 1)))
    sw = max(1, min(sw, w - left))
    sh = max(1, min(sh, h - top))

    out = im.crop((left, top, left + sw, top + sh))
    if (sw, sh) != (ow, oh):
        out = out.resize((ow, oh), _resample(method))
    return out


# ---------------------------------------------------------------------------
# BlueBox：32 不动点算法（对应 CutQwenImage21.run）
# ---------------------------------------------------------------------------

# Qwen-Image 2.1 编辑训练桶常见比例，用于语义一致性打分（照抄 BlueBox）。
_STANDARD_RATIOS = (
    1.0,  # 1:1
    4 / 3,  # 4:3
    3 / 4,  # 3:4
    16 / 9,  # 16:9
    9 / 16,  # 9:16
    3 / 2,  # 3:2
    2 / 3,  # 2:3
)


def _generate_whitelist(resolution: int, tol_ratio: float = 1.0) -> list[tuple[int, int, int]]:
    """对应 BlueBox ``_generate_whitelist``：生成 resolution 的"不动点"尺寸白名单。

    规则：宽高均为 32 的倍数，``k*m`` 落在 ``n^2 ± tol`` 内（``n = resolution // 32``）。
    返回 ``[(w, h, prod), ...]``，``prod = k*m`` 即 32x32 格子数。
    """
    n = max(1, int(resolution) // MULTIPLE)
    target = n * n
    tol = max(1, int(n * float(tol_ratio)))

    pairs: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int]] = set()
    for k in range(1, n * 3):
        for m in range(1, n * 3):
            prod = k * m
            if abs(prod - target) <= tol:
                w, h = k * MULTIPLE, m * MULTIPLE
                if (w, h) in seen:
                    continue
                seen.add((w, h))
                pairs.append((w, h, prod))
    return pairs


def _ratio_distance(a: float, b: float) -> float:
    """对数比例距离（照抄 BlueBox）：对称且符合人眼比例感知。"""
    if a <= 0 or b <= 0:
        return float("inf")
    return abs(math.log(a) - math.log(b))


def _score_candidate(w: int, h: int, prod: int, resolution: int, input_ratio: float) -> float:
    """对应 BlueBox ``_score_candidate``：比例偏离 + 标准桶偏离 + 面积偏离，越低越好。"""
    ratio = w / float(h)
    d_input = _ratio_distance(ratio, input_ratio)
    d_std = min(_ratio_distance(ratio, r) for r in _STANDARD_RATIOS)
    target_area = float(resolution) * float(resolution)
    d_area = abs(prod * 1024 - target_area) / target_area  # prod 是 32x32 格数
    return d_input * 1.0 + d_std * 0.6 + d_area * 0.4


def _pick_target_size(
    width: int, height: int, resolution: int, tol_ratio: float = 1.0
) -> tuple[tuple[int, int], list[tuple[int, int, int]]]:
    """对应 BlueBox ``_pick_target_size``。"""
    input_ratio = float(width) / float(height)
    whitelist = _generate_whitelist(resolution, tol_ratio)
    if not whitelist:
        raise ValueError(f"resolution={resolution} 无法生成白名单")
    best: tuple[int, int] | None = None
    best_score = float("inf")
    for w, h, prod in whitelist:
        s = _score_candidate(w, h, prod, resolution, input_ratio)
        if s < best_score:
            best_score = s
            best = (w, h)
    assert best is not None
    return best, whitelist


def _verify_fixed_point(w: int, h: int, resolution: int) -> tuple[int, int]:
    """对应 BlueBox ``_verify_fixed_point``：模拟模型内部按 resolution² 面积缩放 + 32 对齐。

    若返回 == (w, h)，说明该尺寸在编码器里"缩放前后不变" ⇒ 零偏移。
    """
    w, h = max(1, int(w)), max(1, int(h))
    scale_by = math.sqrt((float(resolution) * float(resolution)) / (float(w) * float(h)))
    w2 = max(MULTIPLE, int(round(w * scale_by / MULTIPLE)) * MULTIPLE)
    h2 = max(MULTIPLE, int(round(h * scale_by / MULTIPLE)) * MULTIPLE)
    return w2, h2


def is_fixed_point(w: int, h: int, resolution: int) -> bool:
    """公开的"是否严格不动点"判定（``_verify_fixed_point`` 的布尔包装）。

    契约要求的 :func:`fixed_point_size` 返回值保证此函数为 ``True``。
    """
    return _verify_fixed_point(w, h, resolution) == (int(w), int(h))


def _snap_fixed_point(
    tw: int, th: int, resolution: int, tol_ratio: float, input_w: int, input_h: int
) -> tuple[int, int]:
    """对应 BlueBox ``_snap_fixed_point``：不是严格不动点时回退到白名单里比例最近且校验通过的一对。

    ``(n, n)``（正方形画布）永远在 tolerance 为 0 时也成立，因此本函数**总有**严格不动点可返回。
    """
    if _verify_fixed_point(tw, th, resolution) == (tw, th):
        return int(tw), int(th)

    whitelist = _generate_whitelist(resolution, tol_ratio)
    input_ratio = float(input_w) / float(input_h)
    fallback: tuple[int, int] | None = None
    best_err = float("inf")
    for cw, ch, _ in whitelist:
        cw2, ch2 = _verify_fixed_point(cw, ch, resolution)
        if (cw2, ch2) == (cw, ch):
            err = _ratio_distance(cw / float(ch), input_ratio)
            if err < best_err:
                best_err = err
                fallback = (cw, ch)
    if fallback is None:
        # 理论上走不到：白名单一定包含 (n*32, n*32)，且正方形是严格不动点。
        # 兜底时把 resolution 对齐到 32 档位，保证返回值仍是 32 的倍数。
        base = max(MULTIPLE, int(round(float(resolution) / MULTIPLE)) * MULTIPLE)
        fallback = (base, base)
    return fallback


def fixed_point_size(
    w: int, h: int, resolution: int = 1024, tol_ratio: float = 1.0
) -> tuple[int, int, int]:
    """BlueBox ``CutQwenImage21`` 的"32 不动点"算法，返回 ``(width, height, resolution)``。

    "不动点"指：把 ``(w, h)`` 喂给 Qwen-Image 2.1 编辑器时，内部会先按
    ``resolution²`` 面积等比缩放再把宽高对齐到 32；若缩放前后尺寸不变，
    就**没有重采样**，输出与输入严格同位（零偏移）。

    算法步骤（与 BlueBox 完全一致）：

    1. ``_generate_whitelist``：列出所有宽高为 32 倍数、且面积格子数
       ``k*m`` 落在 ``n² ± tol`` 内的候选；
    2. ``_score_candidate``：按「与输入比例的距离 * 1.0 + 与标准训练桶比例的距离
       * 0.6 + 面积偏差 * 0.4」打分，取最低分；
    3. ``_snap_fixed_point``：用 ``_verify_fixed_point`` 复核，若尚非严格不动点，
       在候选里挑比例最接近输入且严格不动点的一对。

    参数
    ----
    w, h
        输入图尺寸（只用其宽高比参与打分）。
    resolution
        分辨率档位（BlueBox 下拉档位为 512~2048、步进 32；本函数对任意正整数都可用，
        内部按 ``resolution // 32`` 取格子数 ``n``）。
    tol_ratio
        面积白名单容差比例（BlueBox 默认 1.0，越大候选越多、越可能保住原比例）。

    返回值的 ``(w, h)`` 恒为 32 的倍数，且 :func:`is_fixed_point` 为 ``True``。
    """
    w, h = int(w), int(h)
    if w <= 0 or h <= 0:
        raise ValueError("fixed_point_size 需要正数的宽高")
    resolution = int(resolution)
    if resolution < MULTIPLE:
        # 小于一个 token 的档位没有意义，按 32 处理（不会出现在 UI 可选档位里）。
        resolution = MULTIPLE
    tol_ratio = float(tol_ratio)
    if tol_ratio < 0:
        tol_ratio = 0.0

    (tw, th), _ = _pick_target_size(w, h, resolution, tol_ratio)
    tw, th = _snap_fixed_point(tw, th, resolution, tol_ratio, w, h)
    # 最后一道保险：契约承诺返回严格不动点。若上游输入了非 32 档位的 resolution
    # 导致 _snap_fixed_point 也兜底失败（理论上不会），退回 32 对齐的正方形。
    if not is_fixed_point(tw, th, resolution):
        base = max(MULTIPLE, int(round(float(resolution) / MULTIPLE)) * MULTIPLE)
        tw = th = base
    return int(tw), int(th), int(resolution)


# ---------------------------------------------------------------------------
# 遮罩基础运算（对应 Precise-Align 的 _dilate / _feather / _apply_curve / _band_from_mask）
# ---------------------------------------------------------------------------


def _as_mask(mask) -> np.ndarray:
    arr = np.asarray(mask, dtype=np.float32)
    if arr.ndim != 2:
        raise ValueError(f"遮罩必须是 (H, W) 的二维数组，收到 shape={arr.shape}")
    return arr


def _max_filter_axis(arr: np.ndarray, k: int, axis: int) -> np.ndarray:
    """一维最大值滤波（van Herk / Gil-Werman 算法，O(1)/像素，与窗口大小无关）。

    用于可分离的形态学膨胀；零填充等价于 torch 的 ``F.pad(0) + max_pool2d``。
    """
    if k <= 1:
        return arr
    p = k // 2
    a = np.moveaxis(arr, axis, -1)
    n = a.shape[-1]
    padded = np.zeros(a.shape[:-1] + (n + 2 * p,), dtype=a.dtype)
    padded[..., p: p + n] = a
    m = padded.shape[-1]

    nb = (m + k - 1) // k
    pad2 = nb * k - m
    if pad2:
        padded = np.concatenate(
            [padded, np.zeros(a.shape[:-1] + (pad2,), dtype=a.dtype)], axis=-1
        )
    blocks = padded.reshape(a.shape[:-1] + (nb, k))
    prefix = np.maximum.accumulate(blocks, axis=-1).reshape(a.shape[:-1] + (nb * k,))
    suffix = np.maximum.accumulate(blocks[..., ::-1], axis=-1)[..., ::-1].reshape(
        a.shape[:-1] + (nb * k,)
    )
    out = np.maximum(suffix[..., :n], prefix[..., k - 1: k - 1 + n])
    return np.moveaxis(out, -1, axis)


def dilate_mask(mask, px: int) -> np.ndarray:
    """遮罩向外扩张 ``px`` 像素（对应 ``_dilate`` 的 max_pool2d 膨胀）。

    可分离实现（先横后纵的 1-D 最大值滤波），内存与时间都远优于逐窗口扫描；
    数学上与 ``F.max_pool2d`` 的方形结构元完全等价。
    """
    a = _as_mask(mask)
    px = int(px)
    if px <= 0:
        return a.copy()
    k = 2 * px + 1
    return np.clip(_max_filter_axis(_max_filter_axis(a, k, 1), k, 0), 0.0, 1.0)


def _convolve_axis(arr: np.ndarray, g: np.ndarray, offsets: np.ndarray, p_lo: int, p_hi: int, axis: int) -> np.ndarray:
    """可分离高斯卷积的按 tap 累加实现（replicate 边界，对应 ``_feather`` 的 F.pad replicate）。

    直接循环 ``k`` 个抽头，每次对整幅图做一次切片乘法累加；内存只多一份 accumulator，
    在 2048x2048 / 半径 32 的典型遮罩上耗时约亚秒级，且不需要 scipy。
    """
    a = np.moveaxis(np.asarray(arr, dtype=np.float32), axis, -1)
    n = a.shape[-1]
    padded = np.pad(a, [(0, 0)] * (a.ndim - 1) + [(p_lo, p_hi)], mode="edge")
    acc = np.zeros_like(a)
    for gi, off in zip(g, offsets):
        start = p_lo + int(off)
        acc += float(gi) * padded[..., start: start + n]
    return np.moveaxis(acc, -1, axis)


def feather_mask(mask, px: int) -> np.ndarray:
    """高斯可分离羽化（对应 ``_feather``），比盒式模糊更平滑、无线性渐变带。

    ``sigma = max(0.5, px / 2)``、kernel 半径 ``px``，与参考实现参数一致。
    边界用 replicate（复制边缘），与 torch ``F.pad(mode="replicate")`` 对齐。
    """
    a = np.clip(_as_mask(mask), 0.0, 1.0)
    px = int(px)
    if px <= 0:
        return a
    sigma = max(0.5, px / 2.0)
    k = 2 * px + 1
    xs = np.arange(k, dtype=np.float64) - px
    g = np.exp(-(xs * xs) / (2.0 * sigma * sigma))
    g = g / g.sum()
    offsets = np.arange(k, dtype=np.int64) - px
    out = _convolve_axis(a, g, offsets, px, px, axis=1)
    out = _convolve_axis(out, g, offsets, px, px, axis=0)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def curve_mask(mask, curve: str = "smoothstep") -> np.ndarray:
    """过渡曲线（对应 ``_apply_curve``）：smoothstep 让接缝更自然，linear 保持原样。"""
    a = np.clip(_as_mask(mask), 0.0, 1.0)
    if curve == "smoothstep":
        return (a * a * (3.0 - 2.0 * a)).astype(np.float32)
    if curve == "linear":
        return a
    raise ValueError(f"未知 curve={curve!r}，可选 {_CURVES}")


def band_from_mask(mask, fallback_px: int = 8) -> np.ndarray | None:
    """取遮罩过渡带（``0 < mask < 1``）；硬边遮罩则用外扩环带替代（对应 ``_band_from_mask``）。

    返回的带用于 Reinhard 颜色匹配的统计区域；取不到有效带（例如全 0 遮罩）返回 ``None``。
    """
    a = np.clip(_as_mask(mask), 0.0, 1.0)
    band = ((a > 0.01) & (a < 0.99)).astype(np.float32)
    if float(band.sum()) >= 16:
        return band
    ring = np.clip(dilate_mask(a, max(8, int(fallback_px))) - a, 0.0, 1.0)
    if float(ring.sum()) < 16:
        return None
    return ring


def fill_mask_holes(mask, *, threshold: float = 0.5) -> np.ndarray:
    """填掉遮罩内部的"洞"（被遮罩完全包围的背景区域），返回 float32 0/1 遮罩。

    场景：移除物体时用户可能只圈了外轮廓，内部（如把手、镂空）没涂到；裁切窗口
    需要按"实心包围盒"算，否则中间的空洞不会被模型看到。

    做法：只在遮罩包围盒内做洪水填充——从包围盒边界出发，把与边界连通的背景标成
    "外部"，剩下的背景就是洞，一并置 1。复杂度与包围盒面积成正比。
    """
    m = (np.asarray(mask, dtype=np.float32) > float(threshold))
    if not m.any():
        return np.zeros(m.shape, dtype=np.float32)
    ys, xs = np.nonzero(m)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    sub = m[y0:y1, x0:x1]
    h, w = sub.shape
    # 用 PIL 的洪水填充：外面套一圈 0 边界，从角落灌 "外部" 标记
    pad = Image.new("L", (w + 2, h + 2), 0)
    pad.paste(Image.fromarray((sub.astype(np.uint8) * 255), "L"), (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    arr = np.asarray(pad)[1:-1, 1:-1]
    holes = (arr == 0)
    out = np.zeros(m.shape, dtype=np.float32)
    out[y0:y1, x0:x1] = np.logical_or(sub, holes).astype(np.float32)
    return out


def ign_dither(rgb, alpha, *, amount: float = 1.0 / 255.0) -> np.ndarray:
    """过渡带抖动（IGN，interleaved gradient noise）：压羽化带色带。

    ``rgb``：float32 0~1，形状 ``(N,3)`` / ``(H,W,3)``；``alpha``：``(N,1)`` / ``(H,W,1)``。
    振幅乘 ``4·α·(1-α)`` 包络，两端归零，所以 ``alpha == 0`` / ``alpha == 1`` 的像素
    逐字节不变（不破坏遮罩外 byte-exact）。使用确定性梯度噪声，无随机种子。
    """
    a = np.asarray(alpha, dtype=np.float32)
    a2 = a[..., 0] if a.ndim > 1 else a
    band = (a2 > 0.0) & (a2 < 1.0)
    if not bool(band.any()):
        return rgb
    src = np.asarray(rgb, dtype=np.float32)
    out = src.copy()
    n = int(band.sum())
    idx = np.arange(n, dtype=np.float32)
    # 以 64 宽网格模拟 2D IGN：fract(52.9829189 * fract(0.06711*x + 0.00584*y))
    xs = np.mod(idx, 64.0)
    ys = np.floor_divide(idx, 64.0)
    frac = np.modf(0.06711056 * xs + 0.00583715 * ys)[0]
    grain = (np.modf(52.9829189 * frac)[0] - 0.5) * 2.0
    av = a2[band]
    env = 4.0 * av * (1.0 - av) * float(amount)
    out[band] = np.clip(src[band] + grain[:, None] * env[:, None], 0.0, 1.0)
    return out


def reinhard_match(
    edited: np.ndarray, reference: np.ndarray, weights: np.ndarray, strength: float
) -> np.ndarray:
    """Reinhard 仿射颜色匹配（对应 ``_color_match``）。

    用 ``weights``（过渡带）加权统计 ``reference`` 与 ``edited`` 每个通道的均值/标准差，
    把 edited 线性映射到 reference 的分布：``(edited - me) * (so / se) + mo``，
    再按 ``strength``（0~1）与原图插值。只改颜色统计，不改几何、不改遮罩外像素。

    参数
    ----
    edited, reference
        ``(H, W)`` 或 ``(H, W, C)``，float32 ``[0,1]``（uint8 会先归一化）。
    weights
        ``(H, W)``，通常就是 :func:`band_from_mask` 的输出。
    strength
        0 = 完全不做匹配，1 = 完全匹配到 reference 的均值/方差。
    """
    ed = np.asarray(edited, dtype=np.float32)
    ref = np.asarray(reference, dtype=np.float32)
    if ed.shape != ref.shape:
        raise ValueError(f"edited{ed.shape} 与 reference{ref.shape} 形状不一致")
    w = _as_mask(weights)
    if w.shape != ed.shape[:2]:
        raise ValueError(f"weights{w.shape} 与图像尺寸 {ed.shape[:2]} 不一致")

    ww = w[..., None]
    axes = (0, 1)

    n = float(ww.sum()) + 1e-6
    mo = (ref * ww).sum(axis=axes, keepdims=True) / n
    me = (ed * ww).sum(axis=axes, keepdims=True) / n
    vo = (((ref - mo) ** 2) * ww).sum(axis=axes, keepdims=True) / n
    ve = (((ed - me) ** 2) * ww).sum(axis=axes, keepdims=True) / n
    so = np.sqrt(vo + 1e-6)
    se = np.sqrt(ve + 1e-6)
    corrected = (ed - me) * (so / se) + mo
    out = ed + float(strength) * (corrected - ed)
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# 事后校准（思路来源：ComfyUI-BlueBox Color Calibrator，只借鉴不照搬）
#
# 与原节点的区别：本模块只负责"估参数"和"过渡带修色"，不做自动遮罩决策，
# 也不允许改动遮罩外像素——零色差的底线仍由合成阶段（alpha == 0 不写）保证。
# ---------------------------------------------------------------------------


def _as_rgb(image) -> np.ndarray:
    """统一成 ``(H, W, 3)`` float32 ``[0, 1]``；uint8 自动归一化，灰度自动复制三通道。"""
    arr = np.asarray(image)
    arr = arr.astype(np.float32) / 255.0 if arr.dtype == np.uint8 else arr.astype(np.float32)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"图像必须是 (H, W, 3)，收到 shape={arr.shape}")
    return arr[..., :3]


def _rgb_to_ycbcr(rgb: np.ndarray) -> np.ndarray:
    """RGB → YCbCr（BT.601，与 BlueBox 的差异图一致）。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 0.5 * r - 0.418688 * g - 0.081312 * b
    return np.stack((y, cb, cr), axis=-1)


def _gaussian_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    """可分离高斯模糊（replicate 边界），复用 :func:`_convolve_axis`，不引入 scipy。"""
    if sigma <= 0.0:
        return arr.astype(np.float32)
    radius = max(1, int(math.ceil(3.0 * float(sigma))))
    xs = np.arange(-radius, radius + 1, dtype=np.float64)
    g = np.exp(-(xs * xs) / (2.0 * float(sigma) ** 2))
    g = g / g.sum()
    offsets = np.arange(-radius, radius + 1, dtype=np.int64)
    out = _convolve_axis(arr, g, offsets, radius, radius, axis=1)
    out = _convolve_axis(out, g, offsets, radius, radius, axis=0)
    return out.astype(np.float32)


def _block_mean(arr: np.ndarray, factor: int) -> np.ndarray:
    """按 ``factor`` 做块均值下采样（用于低频统计，避免逐像素开销）。"""
    f = max(1, int(factor))
    h, w = arr.shape[:2]
    sh, sw = h // f, w // f
    if sh < 1 or sw < 1:
        return arr.astype(np.float32)
    a = arr[: sh * f, : sw * f]
    if a.ndim == 2:
        return a.reshape(sh, f, sw, f).mean(axis=(1, 3)).astype(np.float32)
    return a.reshape(sh, f, sw, f, a.shape[2]).mean(axis=(1, 3)).astype(np.float32)


def _resize_float(arr: np.ndarray, width: int, height: int) -> np.ndarray:
    """float 数组双线性缩放（PIL 的 F 模式，逐通道处理）。"""
    arr = np.asarray(arr, dtype=np.float32)
    if arr.shape[:2] == (height, width):
        return arr
    if arr.ndim == 2:
        img = Image.fromarray(arr, mode="F")
        return np.asarray(
            img.resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32
        )
    chans = [_resize_float(arr[..., i], width, height) for i in range(arr.shape[2])]
    return np.stack(chans, axis=-1).astype(np.float32)


def diff_map(
    original, edited, *, preblur: float = 0.8, chroma_weight: float = 1.0
) -> np.ndarray:
    """YCbCr 加权差异图：``0.4·|ΔY| + w·soft_sat(√(ΔCb²+ΔCr²))``。

    相比逐通道 RGB 最大差，这个度量对"亮度几乎没变、只是偏色"更敏感，
    且颜色差先做软饱和，避免大面积强色块把统计拉爆。
    """
    o, e = _as_rgb(original), _as_rgb(edited)
    if o.shape != e.shape:
        raise ValueError(f"original{o.shape} 与 edited{e.shape} 形状不一致")
    yo, ye = _rgb_to_ycbcr(o), _rgb_to_ycbcr(e)
    dy = np.abs(yo[..., 0] - ye[..., 0])
    dc = np.sqrt((yo[..., 1] - ye[..., 1]) ** 2 + (yo[..., 2] - ye[..., 2]) ** 2)
    dc = dc / (1.0 + dc)
    diff = 0.4 * dy + float(chroma_weight) * dc
    if preblur and float(preblur) > 0.0:
        diff = _gaussian_blur(diff, float(preblur))
    return diff.astype(np.float32)


def mad_threshold(
    diff, *, floor: float = 0.02, ceil_mult: float = 2.0, k: float = 3.0
) -> float:
    """MAD 自适应阈值：``med + k·1.4826·MAD``，夹在 ``[floor, floor·ceil_mult]``。

    没改动时差异全是噪声，MAD 很小，阈值会落到 ``floor``；
    大面积改动时 MAD 变大，阈值最多抬到 ``floor·ceil_mult``，不会一路飙升。
    """
    d = np.asarray(diff, dtype=np.float32).reshape(-1)
    med = float(np.median(d))
    mad = float(np.median(np.abs(d - med)))
    thr = med + float(k) * 1.4826 * max(mad, 0.002)
    return float(min(max(thr, float(floor)), float(floor) * float(ceil_mult)))


def anchor_affine(
    original,
    edited,
    alpha,
    *,
    anchor_min: float = 0.02,
    scale_clamp: tuple[float, float] = (0.5, 2.0),
    shift_abs: float | None = None,
    strength: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, bool]:
    """只用"锚区"（``alpha == 0``，即遮罩外）估计模型的整体漂移。

    锚区理论上应与原图逐像素一致，差异只剩模型漂移，因此估出来的
    ``scale``（对比度/增益）与 ``shift``（偏移）最干净。

    返回 ``(scale[3], shift[3], skipped)``；锚区占比不足 ``anchor_min`` 时
    ``skipped=True``，调用方应回退 Reinhard 或不做校色。

    默认**不夹紧 shift**（与 BlueBox 一致）：锚区本就该与原图一致，偏移是真实的
    整体漂移，夹紧反而校不干净；``scale`` 仍夹在 ``[0.5, 2]`` 防极端对比度崩坏。
    """
    o, e = _as_rgb(original), _as_rgb(edited)
    if o.shape != e.shape:
        raise ValueError(f"original{o.shape} 与 edited{e.shape} 形状不一致")
    a = _as_mask(alpha)
    if a.shape != o.shape[:2]:
        raise ValueError(f"alpha{a.shape} 与图像尺寸 {o.shape[:2]} 不一致")

    anchor = a <= 0.0
    if float(anchor.mean()) < float(anchor_min):
        return np.ones(3, dtype=np.float32), np.zeros(3, dtype=np.float32), True

    m = anchor[..., None]
    n = float(m.sum())
    mu0 = (o * m).sum(axis=(0, 1)) / n
    mu1 = (e * m).sum(axis=(0, 1)) / n
    sd0 = np.sqrt((((o - mu0) ** 2) * m).sum(axis=(0, 1)) / n) + 1e-4
    sd1 = np.sqrt((((e - mu1) ** 2) * m).sum(axis=(0, 1)) / n) + 1e-4

    # 纯色通道（白底商品图、纯色海报）的标准差接近 0，增益没有统计意义：
    # 这时只校偏移不放大对比度，否则 0.5 的下界会把物体颜色撕开。
    eps = 1.0 / 255.0
    degenerate = (sd0 < eps) | (sd1 < eps)
    scale = np.where(
        degenerate, 1.0,
        np.clip(sd0 / sd1, float(scale_clamp[0]), float(scale_clamp[1])),
    ).astype(np.float32)
    shift = mu0 - scale * mu1
    if shift_abs is not None:
        shift = np.clip(shift, -float(shift_abs), float(shift_abs))
    s = float(np.clip(strength, 0.0, 1.0))
    return (
        (1.0 + s * (scale - 1.0)).astype(np.float32),
        (s * shift).astype(np.float32),
        False,
    )


def lowfreq_merge(
    original,
    edited,
    alpha,
    *,
    levels: int = 3,
    sigma: float = 2.0,
    downscale: int = 4,
) -> np.ndarray:
    """过渡带低频移植：把原图的低频颜色/亮度搬回 edited，保留其高频细节。

    ``out = edited + (1 - alpha) · lowpass(original - edited)``。

    性质（很重要）：

    * ``alpha == 0`` → 权重为 0，edited 原样返回（合成阶段本来也不写这些像素）；
    * ``alpha == 1`` → 权重为 0，遮罩内核心区仍是模型自己的内容；
    * ``0 < alpha < 1`` → 越靠近边界，越向原图的低频靠拢，用来消接缝色块/光晕。
    """
    o, e = _as_rgb(original), _as_rgb(edited)
    if o.shape != e.shape:
        raise ValueError(f"original{o.shape} 与 edited{e.shape} 形状不一致")
    a = np.clip(_as_mask(alpha), 0.0, 1.0)
    if a.shape != e.shape[:2]:
        raise ValueError(f"alpha{a.shape} 与图像尺寸 {e.shape[:2]} 不一致")

    height, width = e.shape[:2]
    delta = _block_mean(o - e, downscale)
    for _ in range(max(1, int(levels))):
        delta = _gaussian_blur(delta, float(sigma))
    delta = _resize_float(delta, width, height)

    weight = np.where(a > 0.0, 1.0 - a, 0.0)[..., None]
    return np.clip(e + weight * delta, 0.0, 1.0).astype(np.float32)


def changed_stats(
    original,
    edited,
    mask=None,
    *,
    threshold: float | None = None,
    preblur: float = 0.0,
    chroma_weight: float = 1.0,
    inside_mask=None,
) -> dict:
    """诊断：模型实际改动比例与遮罩外泄漏比例。纯只读，不参与像素写入。

    ``mask`` 给出时额外算 ``leak_ratio``（遮罩外被改动的像素占遮罩外的比例）；
    ``inside_mask`` 给出时算 ``mask_changed_ratio``（**遮罩内**被改动的像素占
    遮罩像素的比例）。两者分开传是因为方案 B 的写入范围是膨胀后的过渡带：
    查泄漏要用膨胀遮罩，验证"有没有真的改到目标"必须用用户原始遮罩。

    阈值缺省用 :func:`mad_threshold` 自适应。

    ``preblur`` 默认 0：诊断要的是"哪一像素真的变了"，预模糊会把边界外
    1~2px 抹成差异，制造假泄漏。8bit 噪声只有 1/255，远低于阈值下限。
    """
    diff = diff_map(
        original, edited, preblur=preblur, chroma_weight=chroma_weight
    )
    thr = float(threshold) if threshold is not None else mad_threshold(diff)
    changed = diff > thr
    stats = {
        "threshold": round(thr, 6),
        "changed_ratio": float(changed.mean()),
    }
    if inside_mask is not None:
        im = _as_mask(inside_mask)
        if im.shape != changed.shape:
            im = resize_mask(im, changed.shape[1], changed.shape[0])
        inside = im > 0.0
        inside_total = int(inside.sum())
        stats["mask_changed_ratio"] = (
            float((changed & inside).sum()) / float(inside_total)
            if inside_total else None
        )
    if mask is not None:
        m = _as_mask(mask)
        if m.shape != changed.shape:
            m = resize_mask(m, changed.shape[1], changed.shape[0])
        outside = m <= 0.0
        total = int(outside.sum())
        stats["leak_ratio"] = (
            float((changed & outside).sum()) / float(total) if total else 0.0
        )
    return stats


# ---------------------------------------------------------------------------
# 区域形状栅格化（对应 PreciseAlignRegion 的 _rasterize_shapes）
# ---------------------------------------------------------------------------


def _normalize_shapes(shapes) -> tuple[list[dict], int, int]:
    """把编辑器传来的 shapes 统一成 ``(列表, 参考宽, 参考高)``。

    支持两种格式（都兼容）：

    1. ``[{"kind": "rect", "x":..., "y":..., "w":..., "h":...}, ...]`` —— 契约格式，
       坐标就是目标图像素坐标，不缩放；
    2. ``{"width": W, "height": H, "shapes": [...]}`` —— Precise-Align 的
       ``shapes_json`` 格式，坐标属于 ``W x H``，需要按比例缩放到目标尺寸。
    """
    src_w = src_h = 0
    if isinstance(shapes, dict):
        data = shapes
        items = data.get("shapes") or []
        try:
            src_w = int(round(float(data.get("width") or 0)))
            src_h = int(round(float(data.get("height") or 0)))
        except (TypeError, ValueError):
            src_w = src_h = 0
    elif isinstance(shapes, (list, tuple)):
        items = list(shapes)
    else:
        items = []
    return [s for s in items if isinstance(s, dict)], src_w, src_h


def region_shapes_to_mask(
    w: int, h: int, shapes: list[dict], feather: int = 0, expand: int = 0
) -> np.ndarray:
    """把编辑器里的矩形/椭圆栅格化成 ``(h, w)`` 的 float32 遮罩（对应 ``_rasterize_shapes``）。

    * shapes 元素：``{"kind": "rect"|"ellipse", "x": float, "y": float, "w": float, "h": float}``
      （也接受参考实现的 ``"type"`` 键，以及 ``{"width","height","shapes"}`` 包装格式）。
    * 坐标为原图像素坐标；矩形按 ``floor/ceil`` 向外取整（与参考实现一致），
      椭圆在包围盒内按椭圆方程判定。
    * 先 ``expand`` 外扩（形态学膨胀），再 ``feather`` 高斯羽化。

    未提供任何形状时返回全 0 遮罩。
    """
    w, h = max(1, int(w)), max(1, int(h))
    mask = np.zeros((h, w), dtype=np.float32)
    items, src_w, src_h = _normalize_shapes(shapes)
    if not items:
        return mask
    if src_w > 0 and src_h > 0:
        sx = w / float(src_w)
        sy = h / float(src_h)
    else:
        sx = sy = 1.0

    xs = np.arange(w, dtype=np.float32)[None, :]
    ys = np.arange(h, dtype=np.float32)[:, None]

    for s in items:
        try:
            st = str(s.get("kind", s.get("type", "rect"))).lower()
            x = float(s.get("x", 0.0)) * sx
            y = float(s.get("y", 0.0)) * sy
            sw = float(s.get("w", 0.0)) * sx
            sh = float(s.get("h", 0.0)) * sy
        except (TypeError, ValueError):
            continue
        if sw <= 0 or sh <= 0:
            continue
        x1 = max(0, int(math.floor(x)))
        y1 = max(0, int(math.floor(y)))
        x2 = min(w, int(math.ceil(x + sw)))
        y2 = min(h, int(math.ceil(y + sh)))
        if x2 <= x1 or y2 <= y1:
            continue

        if st in ("ellipse", "circle", "oval"):
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            rx = max((x2 - x1) / 2.0, 0.5)
            ry = max((y2 - y1) / 2.0, 0.5)
            inside = (((xs[:, x1:x2] - cx) / rx) ** 2 + ((ys[y1:y2, :] - cy) / ry) ** 2) <= 1.0
            mask[y1:y2, x1:x2] = np.maximum(mask[y1:y2, x1:x2], inside.astype(np.float32))
        else:
            mask[y1:y2, x1:x2] = 1.0

    if int(expand) > 0:
        mask = dilate_mask(mask, int(expand))
    if int(feather) > 0:
        mask = feather_mask(mask, int(feather))
    return np.clip(mask, 0.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# 遮罩的坐标变换（对应 _mask_to_canvas 与 CropBack 的 mask 分支）
# ---------------------------------------------------------------------------


def resize_mask(mask, width: int, height: int) -> np.ndarray:
    """把 float32 遮罩双线性缩放到 ``(height, width)``（Pillow 的 F 模式）。"""
    a = _as_mask(mask)
    width, height = max(1, int(width)), max(1, int(height))
    if a.shape == (height, width):
        return a
    im = Image.fromarray(np.ascontiguousarray(a, dtype=np.float32))
    return np.asarray(im.resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32)


def transform_mask(mask, info: PadInfo, *, pad_value: float = 0.0) -> np.ndarray:
    """把原图尺寸的遮罩映射到 :func:`pad_image` 之后的画布坐标系。

    对应 ``_mask_to_canvas`` 的 mask 分支：先按缩放倍率缩放，再按 ``pad_l/pad_t``
    平移；画布上补边区域填 ``pad_value``（默认 0，即"不编辑补边区"）。

    实现上与参考实现等价：``out = resize(mask, out_w, out_h)`` 后整块贴到画布
    ``[pad_t:pad_t+out_h, pad_l:pad_l+out_w]``。``scale_by==1.0`` 时逐像素平移，
    不产生插值误差。
    """
    m = _as_mask(mask)
    if m.shape != (int(info.orig_h), int(info.orig_w)):
        m = resize_mask(m, info.orig_w, info.orig_h)
    if (info.out_w, info.out_h) != (info.orig_w, info.orig_h):
        m = resize_mask(m, info.out_w, info.out_h)
    canvas = np.full((int(info.canvas_h), int(info.canvas_w)), float(pad_value), dtype=np.float32)
    x0, y0 = int(info.pad_l), int(info.pad_t)
    x1 = min(info.canvas_w, x0 + int(info.out_w))
    y1 = min(info.canvas_h, y0 + int(info.out_h))
    if x1 > x0 and y1 > y0:
        canvas[y0:y1, x0:x1] = np.clip(m[: y1 - y0, : x1 - x0], 0.0, 1.0)
    return canvas


def inverse_transform_mask(mask, info: PadInfo) -> np.ndarray:
    """画布遮罩 → 原图遮罩（``transform_mask`` 的逆变换，对应 CropBack 的 mask 输出）。"""
    m = _as_mask(mask)
    if m.shape != (int(info.canvas_h), int(info.canvas_w)):
        m = resize_mask(m, info.canvas_w, info.canvas_h)
    x0, y0 = int(info.pad_l), int(info.pad_t)
    out = m[y0: y0 + int(info.out_h), x0: x0 + int(info.out_w)]
    if out.shape != (int(info.orig_h), int(info.orig_w)):
        out = resize_mask(out, info.orig_w, info.orig_h)
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def latent_tokens(w: int, h: int, multiple: int = 32) -> int:
    """估算采样 latent 的 token 数：``(ceil32(w)/32) * (ceil32(h)/32)``。

    对应 Precise-Align ``_sanity_warnings`` 里的 token 告警（>2048 提示显存压力，
    >4096 提示很可能 OOM），服务端可以据此给前端返回提示。
    """
    cw, ch = snap_dims(w, h, multiple)
    step = max(1, int(multiple))
    return (cw // step) * (ch // step)
