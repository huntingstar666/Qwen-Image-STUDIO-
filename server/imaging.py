# -*- coding: utf-8 -*-
"""图像 I/O + 画布规划 + 合成编排（BlueBox 移植 + Precise-Align 方案 A/B 编排）。

职责边界：

* :mod:`server.align` 负责"几何/颜色算法核"（单步原语）；
* 本模块负责**把原语编排成服务端可直接用的一条流水线**：
  解码（sRGB 统一）→ 规划画布（32 对齐 / BlueBox 不动点）→ 铺画布 →
  遮罩坐标映射 → 合成（遮罩外逐像素保留原图）→ 裁剪局部编辑 / 贴回 → 编码输出。

移植对照（只读参考源码）：

============================================================  ==========================================
本模块                                                         参考实现
============================================================  ==========================================
:func:`decode_image` / :func:`decode_mask`                      ``BlueBoxLoadImage.load_image``
                                                                （exif_transpose / alpha / 遮罩回退）
:func:`encode_png` / :func:`encode_jpeg`                        BlueBox 输出统一 8bit sRGB PNG 的约定
:func:`plan_canvas` / :func:`compose_canvas`                    ``_pad_to`` + ``PreciseAlignPad.pad``
:func:`plan_canvas` 的 ``fixed_point`` 模式                     ``CutQwenImage21.run``（resolution 档 + 白名单）
:func:`map_mask_to_canvas` / :func:`map_mask_from_canvas`       ``_mask_to_canvas`` / CropBack 的 mask 分支
:func:`composite`                                              ``PreciseAlignComposite.composite``
:func:`crop_region` / :func:`stitch_region`                     ``PreciseAlignCropEdit.crop_region`` /
                                                                ``PreciseAlignStitch.stitch``
:func:`compare`                                                 零偏移/零色差验收工具
============================================================  ==========================================

"零色差"的两条硬保证：

1. **遮罩外逐像素保留原图**：:func:`composite` / :func:`stitch_region` 都从原图
   ``uint8`` 数组的拷贝出发，只对 ``alpha > 0`` 的像素做混合赋值，因此
   ``mask == 0`` 的像素与输入**字节级相同**（``compare()`` 的 ``max_abs == 0``）。
2. **颜色只在过渡带做 Reinhard 仿射匹配**：用 :func:`align.band_from_mask` 取
   过渡带统计均值/方差，再把编辑结果拉回参考图分布，不改变色相/几何。

"零偏移"的关键：画布尺寸恒为 :data:`SNAP`（32）的倍数；``fixed_point`` 模式保证
尺寸在 Qwen-Image 2.1 编辑器的内部缩放（resolution² 面积 + 32 对齐）下是**不动点**。
"""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, ImageCms, ImageOps

from . import align

__all__ = [
    "SNAP",
    "CanvasPlan",
    "ImageMeta",
    "CropInfo",
    "PreprocessPlan",
    "OutpaintInfo",
    "decode_image",
    "decode_mask",
    "encode_png",
    "encode_jpeg",
    "data_url",
    "parse_data_url",
    "image_meta",
    "parse_ratio",
    "plan_canvas",
    "preprocess_plan",
    "apply_preprocess",
    "restore_preprocess",
    "outpaint_canvas",
    "outpaint_mask",
    "PANORAMA_ASPECTS",
    "PanoramaPlan",
    "panorama_plan",
    "panorama_canvas",
    "PANORAMA360_DEFAULT_COVERAGE",
    "panorama360_plan",
    "wrap_seam_blend",
    "compose_canvas",
    "map_mask_to_canvas",
    "map_mask_from_canvas",
    "plan_to_pad_info",
    "composite",
    "crop_region",
    "crop_region_factors",
    "crop_with_color_fill",
    "crop_mask_for_region",
    "mask_hint_overlay",
    "stitch_region",
    "color_consistency",
    "compare",
]

#: 画布对齐步长（Qwen-Image 2.1 的 VAE 8x * patch 2x2）。
SNAP = align.MULTIPLE

_FITS = ("pad", "crop", "stretch")
_MODES = ("follow", "custom", "ratio", "fixed_point")

#: 单张图解码上限（像素数）。120MP ≈ 12000×10000，远大于 4K/8K 编辑需求，
#: 但能挡住「几百 KB 的 PNG 解压成几十 GB 位图」这类解压炸弹。
MAX_DECODE_PIXELS = 120_000_000


def _guard_pixels(im: Image.Image, *, limit: int | None = None,
                  label: str = "图片") -> None:
    """在 ``load()`` 之前按头部尺寸拦住超大图（避免先分配几十 GB 再报错）。"""
    limit = MAX_DECODE_PIXELS if limit is None else int(limit)
    width, height = im.size
    total = int(width) * int(height)
    if total > limit:
        raise ValueError(
            f"{label}尺寸 {width}×{height}（约 {total / 1_000_000:.0f} 百万像素）"
            f"超过上限 {limit / 1_000_000:.0f} 百万像素，请先缩小后再上传"
        )

_PIL_RESAMPLE = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
    "bilinear": Image.Resampling.BILINEAR,
    "area": Image.Resampling.BOX,
    "nearest": Image.Resampling.NEAREST,
}


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class CanvasPlan:
    """一次编辑的画布规划（source → canvas 的完整几何）。

    * ``width/height``   画布尺寸，恒为 :data:`SNAP` 的倍数
    * ``scale``          源图 → 画布的缩放倍率（``stretch`` 时记录 X 方向倍率）
    * ``offset_x/offset_y`` 缩放后的图在画布中的左上角（``crop`` 模式可能为负）
    * ``src_w/src_h``    源图尺寸
    * ``fit``            ``"pad"``(contain+pad) / ``"crop"``(cover+居中裁) / ``"stretch"``
    * ``resolution``     仅 ``fixed_point`` 模式有效：BlueBox 的 resolution 档位
      （其余模式为 0）。这是契约字段之外的**向后兼容扩展**（带默认值，不影响
      按契约字段构造的调用方），服务端需要把它透传给 ComfyUI 工作流。
    """

    width: int
    height: int
    scale: float
    offset_x: int
    offset_y: int
    src_w: int
    src_h: int
    fit: str
    resolution: int = 0


@dataclass
class ImageMeta:
    """图像元信息（对应 BlueBox LoadImage 关心的字段：尺寸 / 模式 / alpha / 格式 / ICC）。"""

    width: int
    height: int
    mode: str
    has_alpha: bool
    format: str
    icc: bool


@dataclass
class CropInfo:
    """方案 B 裁切信息（对应 ``CROP_INFO_TYPE`` 的最小必要子集）。

    ``x/y`` 是裁切窗口在**画布**中的左上角，``w/h`` 是窗口尺寸，``canvas_w/h``
    是原画布尺寸。补齐到 32 的偏移由 :func:`stitch_region` 用与
    :func:`crop_region` 完全相同的规则（居中补边、:data:`SNAP`）反推，因此二者
    必须成对使用。
    """

    x: int
    y: int
    w: int
    h: int
    canvas_w: int
    canvas_h: int
    #: 模型实际输入尺寸（孤海工作流会把裁切块缩放到「长边 768~2048、32 倍数」）。
    #: 0 表示没有额外缩放，等同于 ``snap_dims(w, h)``。
    model_w: int = 0
    model_h: int = 0
    #: 触发「最小裁剪窗」时的阈值（0 = 未触发）。窗口小于该值时以遮罩为中心扩到阈值见方。
    floor: int = 0

    def target_size(self) -> tuple[int, int]:
        """模型输入尺寸：有缩放用缩放后的，否则用 32 对齐后的裁切尺寸。"""
        if int(self.model_w) > 0 and int(self.model_h) > 0:
            return int(self.model_w), int(self.model_h)
        return align.snap_dims(int(self.w), int(self.h), SNAP)


@dataclass
class PreprocessPlan:
    """大图预处理几何（源图 → 工作尺寸 → 32 对齐画布）。

    * ``work_w/work_h``     缩放后的工作尺寸（未补边）
    * ``canvas_w/canvas_h`` 向上对齐到 32 后的画布尺寸
    * ``scale``             工作尺寸 / 源尺寸（``downscale_only`` 下恒 ``<= 1``）
    * ``pad_x/pad_y``       补边在画布内的左上偏移（居中、整数）

    ``work`` 与 ``canvas`` 之差只是补边；还原时先整数裁掉补边，再做唯一一次
    重采样回源尺寸，因此不会引入二次模糊或像素偏移。
    """

    enabled: bool
    src_w: int
    src_h: int
    work_w: int
    work_h: int
    canvas_w: int
    canvas_h: int
    scale: float
    pad_x: int
    pad_y: int
    max_side: int


@dataclass
class OutpaintInfo:
    """扩图外补画板的几何：源图在外扩画布中的整数位置。"""

    src_w: int
    src_h: int
    left: int
    right: int
    top: int
    bottom: int
    canvas_w: int
    canvas_h: int
    fill: tuple[int, int, int]
    #: 扩图前从源图四边各裁掉的像素数（0 = 不裁）
    trim: int = 0


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------


def _resample(method: str) -> Image.Resampling:
    return _PIL_RESAMPLE.get(str(method or "bicubic").lower(), Image.Resampling.BICUBIC)


def _resize_mask_nearest(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """最近邻缩放 float32 遮罩（用于取"硬边界"，不产生 0/1 之间的插值灰边）。"""
    a = np.asarray(mask, dtype=np.float32)
    width, height = max(1, int(width)), max(1, int(height))
    if a.shape == (height, width):
        return a
    im = Image.fromarray(np.ascontiguousarray(a, dtype=np.float32))
    return np.asarray(im.resize((width, height), Image.Resampling.NEAREST), dtype=np.float32)


def _to_uint8(im: Image.Image, *, alpha: bool = True) -> np.ndarray:
    """PIL → numpy uint8（``alpha=True`` 时统一 RGBA，否则 RGB）。"""
    mode = "RGBA" if alpha else "RGB"
    if im.mode != mode:
        im = im.convert(mode)
    return np.asarray(im, dtype=np.uint8)


def _content_size(plan: CanvasPlan) -> tuple[int, int]:
    """缩放后的内容尺寸（与 :func:`compose_canvas` / 遮罩映射共用）。"""
    if plan.fit == "stretch":
        return int(plan.width), int(plan.height)
    cw = max(1, int(round(plan.src_w * float(plan.scale))))
    ch = max(1, int(round(plan.src_h * float(plan.scale))))
    return cw, ch


def _fit_geometry(
    src_w: int, src_h: int, canvas_w: int, canvas_h: int, fit: str
) -> tuple[float, tuple[int, int], int, int]:
    """计算 ``(scale, (content_w, content_h), offset_x, offset_y)``。

    对应 Precise-Align ``_pad_bhwc`` 的"留白/裁切"语义与 BlueBox ``_pad_to`` /
    ``_center_crop_to`` 的缩放策略：

    * ``pad``  = contain（``scale = min(...)``）后居中补边；
    * ``crop`` = cover（``scale = max(...)``）后居中裁切，offset 为负；
    * ``stretch`` = 直接拉伸铺满画布（只用于用户显式选择，不参与零偏移推荐路径）。
    """
    fit = str(fit or "pad").lower()
    if fit not in _FITS:
        raise ValueError(f"未知 fit={fit!r}，可选 {_FITS}")
    if src_w <= 0 or src_h <= 0 or canvas_w <= 0 or canvas_h <= 0:
        raise ValueError("plan_canvas 需要正数的源尺寸与画布尺寸")

    if fit == "stretch":
        return canvas_w / float(src_w), (canvas_w, canvas_h), 0, 0

    if fit == "pad":
        scale = min(canvas_w / float(src_w), canvas_h / float(src_h))
    else:
        scale = max(canvas_w / float(src_w), canvas_h / float(src_h))

    cw = max(1, int(round(src_w * scale)))
    ch = max(1, int(round(src_h * scale)))
    if fit == "pad":
        cw, ch = min(cw, canvas_w), min(ch, canvas_h)
        ox = (canvas_w - cw) // 2
        oy = (canvas_h - ch) // 2
    else:
        cw, ch = max(cw, canvas_w), max(ch, canvas_h)
        ox = -((cw - canvas_w) // 2)
        oy = -((ch - canvas_h) // 2)
    return float(scale), (cw, ch), int(ox), int(oy)


def _place_rgba(
    arr: np.ndarray,
    offset_x: int,
    offset_y: int,
    width: int,
    height: int,
    pad_mode: str,
    pad_color: tuple[float, float, float, float],
) -> np.ndarray:
    """把 RGBA uint8 数组按偏移放到 ``width x height`` 画布上（负偏移裁切）。

    ``pad_mode="edge"`` 用边缘复制（对应 ``_pad_bhwc`` 的 replicate），
    ``"reflect"`` 用镜像，``gray/black/white`` 用纯色。
    """
    if pad_mode not in align.PAD_MODES:
        raise ValueError(f"未知 pad_mode={pad_mode!r}，可选 {align.PAD_MODES}")
    c = arr.shape[2]
    W, H = int(width), int(height)

    crop_l = max(0, -int(offset_x))
    crop_t = max(0, -int(offset_y))
    dst_x = max(0, int(offset_x))
    dst_y = max(0, int(offset_y))
    work = arr[crop_t:, crop_l:]
    if work.shape[1] > W - dst_x:
        work = work[:, : W - dst_x]
    if work.shape[0] > H - dst_y:
        work = work[: H - dst_y]

    if pad_mode in ("gray", "black", "white"):
        if pad_mode == "black":
            fill = (0, 0, 0, 255)
        elif pad_mode == "white":
            fill = (255, 255, 255, 255)
        else:
            rgb = tuple(int(round(max(0.0, min(1.0, float(v))) * 255)) for v in pad_color[:3])
            a = int(round(max(0.0, min(1.0, float(pad_color[3] if len(pad_color) > 3 else 1.0))) * 255))
            fill = rgb + (a,)
        canvas = np.empty((H, W, c), dtype=np.uint8)
        canvas[...] = np.asarray(fill[:c], dtype=np.uint8)
        if work.size and work.shape[0] > 0 and work.shape[1] > 0:
            canvas[dst_y: dst_y + work.shape[0], dst_x: dst_x + work.shape[1]] = work
        return canvas

    mode = "edge" if pad_mode == "edge" else "reflect"
    if work.shape[0] <= 0 or work.shape[1] <= 0:
        canvas = np.empty((H, W, c), dtype=np.uint8)
        canvas[...] = 0
        return canvas

    right = W - dst_x - work.shape[1]
    bottom = H - dst_y - work.shape[0]
    if dst_x or dst_y or right or bottom:
        pad_width = ((dst_y, max(0, bottom)), (dst_x, max(0, right)), (0, 0))
        try:
            work = np.pad(work, pad_width, mode=mode)
        except (ValueError, RuntimeError):
            work = np.pad(work, pad_width, mode="edge")
    return work


def _place_mask_zero(
    arr: np.ndarray, offset_x: int, offset_y: int, width: int, height: int
) -> np.ndarray:
    """把 float32 遮罩按偏移贴到画布，画布其余区域填 0（补边区不参与编辑）。"""
    out = np.zeros((height, width), dtype=np.float32)
    crop_l = max(0, -int(offset_x))
    crop_t = max(0, -int(offset_y))
    dst_x = max(0, int(offset_x))
    dst_y = max(0, int(offset_y))
    work = arr[crop_t:, crop_l:]
    if work.shape[1] > width - dst_x:
        work = work[:, : width - dst_x]
    if work.shape[0] > height - dst_y:
        work = work[: height - dst_y]
    if work.size and work.shape[0] > 0 and work.shape[1] > 0:
        out[dst_y: dst_y + work.shape[0], dst_x: dst_x + work.shape[1]] = work
    return out


def _extract_region_zero(
    mask: np.ndarray, x: int, y: int, width: int, height: int
) -> np.ndarray:
    """从画布遮罩里取出 ``(x, y, width, height)`` 窗口，越界部分填 0。"""
    h, w = mask.shape
    out = np.zeros((max(1, int(height)), max(1, int(width))), dtype=np.float32)
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(w, int(x) + int(width)), min(h, int(y) + int(height))
    if x1 > x0 and y1 > y0:
        out[y0 - int(y): y1 - int(y), x0 - int(x): x1 - int(x)] = mask[y0:y1, x0:x1]
    return out


# ---------------------------------------------------------------------------
# 图像 I/O（对应 BlueBoxLoadImage 的 exif / alpha / 色彩空间处理）
# ---------------------------------------------------------------------------


def _convert_icc_to_srgb(im: Image.Image) -> Image.Image:
    """有 ICC 且不是 sRGB 时用 littleCMS 转到 sRGB；失败则原样返回（不隐式改色）。

    对应 ''BUILD_CONTRACT.md'' 4.2 第一步：exif 纠正 → ICC → sRGB → 统一 RGBA。
    BlueBox 的 LoadImage 本身不处理 ICC（直接 ``convert("RGB")``），这里按契约补上。
    灰度/CMYK 等 profile 先转 RGB 再做变换；alpha 单独保留避免 littleCMS 模式限制。
    """
    icc = im.info.get("icc_profile")
    if not icc:
        return im
    try:
        src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        description = (ImageCms.getProfileDescription(src_profile) or "").strip().lower()
        if "srgb" in description.replace(" ", ""):
            return im  # 已经是 sRGB，不需要往返变换（避免任何数值抖动）
        dst_profile = ImageCms.createProfile("sRGB")
        alpha = im.getchannel("A") if "A" in im.getbands() else None
        rgb = im.convert("RGB")
        out = ImageCms.profileToProfile(
            rgb,
            src_profile,
            dst_profile,
            outputMode="RGB",
            renderingIntent=ImageCms.Intent.PERCEPTUAL,
        )
        if alpha is not None:
            out = out.convert("RGBA")
            out.putalpha(alpha)
        return out
    except Exception:
        # profile 损坏 / 不支持的模式：退回"不做色彩变换"，保证不丢图。
        return im


def decode_image(data: bytes, *, keep_alpha: bool = True) -> Image.Image:
    """解码图片字节流（对应 BlueBox ``LoadImage`` 的输入处理）。

    流程：``Image.open`` → ``ImageOps.exif_transpose``（纠正手机照片方向）→
    非 sRGB ICC 转 sRGB → 统一 ``RGBA``（``keep_alpha=True``）或 ``RGB``。

    **不做任何隐式色彩变换**：没有 ICC 时就按原始 8bit sRGB 数值使用；
    ``keep_alpha=False`` 时直接丢弃 alpha 通道（RGB 数值保持不变）。
    """
    if not data:
        raise ValueError("图片数据为空")
    try:
        im = Image.open(io.BytesIO(data))
        _guard_pixels(im)
        im.load()
    except Image.DecompressionBombError as exc:  # pragma: no cover - 需超大文件才能触发
        raise ValueError("图片像素过大，已拒绝解码；请先缩小后再上传") from exc
    except ValueError:
        raise
    except Exception as exc:  # pragma: no cover - 依赖损坏文件才能触发
        raise ValueError(f"无法解码图片: {exc}") from exc

    im = ImageOps.exif_transpose(im)
    im = _convert_icc_to_srgb(im)
    return im.convert("RGBA" if keep_alpha else "RGB")


def _mask_luminance(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("L"), dtype=np.float32) / 255.0


def decode_mask(
    data: bytes, width: int, height: int, *, invert: bool = False
) -> np.ndarray:
    """解码前端遮罩（白色/不透明 = 要编辑的区域），返回 ``(h, w)`` float32。

    选择规则（契约 2.2 的"取 alpha 或亮度"）：

    * 图片带 alpha **且 alpha 有变化** → 直接取 alpha 通道（遮罩编辑器导出的
      "白=编辑区、透明=不编辑" PNG 就走这条）；
    * alpha 恒为不透明（普通 RGB 白/黑遮罩图）→ 取亮度；
    * alpha 全透明 → 视为空遮罩（后续 raise）。

    任何输入都会用双线性缩放到 ``(width, height)``。``invert=True`` 时反相。
    解码后全 0 会 raise ``ValueError("遮罩为空")``（对应契约 2.2 / Precise-Align
    "遮罩是全黑的，找不到编辑区域"）。
    """
    if not data:
        raise ValueError("遮罩数据为空")
    width, height = max(1, int(width)), max(1, int(height))
    try:
        im = Image.open(io.BytesIO(data))
        _guard_pixels(im, label="遮罩")
        im.load()
    except Image.DecompressionBombError as exc:  # pragma: no cover
        raise ValueError("遮罩像素过大，已拒绝解码") from exc
    except ValueError:
        raise
    except Exception as exc:  # pragma: no cover
        raise ValueError(f"无法解码遮罩: {exc}") from exc
    im = ImageOps.exif_transpose(im)

    bands = im.getbands()
    has_alpha = ("A" in bands) or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        alpha = np.asarray(im.convert("RGBA").getchannel("A"), dtype=np.float32) / 255.0
        if float(alpha.min()) < float(alpha.max()):
            mask = alpha
        elif float(alpha.max()) >= 0.999:
            mask = _mask_luminance(im)
        else:
            mask = alpha  # 全透明：后续按"空遮罩"处理
    else:
        mask = _mask_luminance(im)

    if (mask.shape[1], mask.shape[0]) != (width, height):
        mask = align.resize_mask(mask, width, height)
    if invert:
        mask = 1.0 - mask
    mask = np.clip(np.asarray(mask, dtype=np.float32), 0.0, 1.0)
    if float(mask.max()) <= 0.0:
        raise ValueError("遮罩为空")
    return mask


def encode_png(im: Image.Image, *, strip_icc: bool = True, compress_level: int = 6) -> bytes:
    """编码 PNG（默认剥离 ICC，输出统一 sRGB 8bit；RGBA 透明通道保留）。

    ``compress_level`` 只影响编码耗时与文件体积（不影响画质）：6 是 PIL 默认，
    1 在 2MP 图上快约 3.3 倍、体积大约 1.6 倍。
    """
    im = im.copy()
    if strip_icc:
        im.info.pop("icc_profile", None)
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=int(compress_level))
    return buf.getvalue()


def encode_jpeg(im: Image.Image, quality: int = 95) -> bytes:
    """编码 JPEG q95；RGBA 先合成到白底（JPEG 无透明通道）。"""
    if im.mode in ("RGBA", "LA") or ("transparency" in im.info):
        rgba = im.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        im = background.convert("RGB")
    elif im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=int(quality), subsampling=0, optimize=True)
    return buf.getvalue()


def data_url(mime: str, data: bytes) -> str:
    """把字节流包装成 ``data:<mime>;base64,<...>``。"""
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def parse_data_url(url: str) -> tuple[str, bytes]:
    """解析 ``data:<mime>;base64,<payload>``，返回 ``(mime, bytes)``。"""
    if not isinstance(url, str) or not url.startswith("data:"):
        raise ValueError("非法 data URL：必须以 data: 开头")
    try:
        header, payload = url.split(",", 1)
    except ValueError as exc:
        raise ValueError("非法 data URL：缺少逗号分隔的 payload") from exc
    meta = header[5:]
    mime = meta.split(";", 1)[0] or "application/octet-stream"
    if "base64" not in meta.split(";")[1:]:
        raise ValueError("非法 data URL：仅支持 base64 编码")
    try:
        return mime, base64.b64decode(payload)
    except Exception as exc:  # pragma: no cover
        raise ValueError(f"非法 data URL：base64 解码失败（{exc}）") from exc


def image_meta(im: Image.Image) -> ImageMeta:
    """读取 :class:`ImageMeta`（尺寸 / 模式 / alpha / 格式 / 是否带 ICC）。"""
    return ImageMeta(
        width=int(im.size[0]),
        height=int(im.size[1]),
        mode=str(im.mode),
        has_alpha=("A" in im.getbands()) or ("transparency" in im.info),
        format=str(im.format or ""),
        icc=bool(im.info.get("icc_profile")),
    )


# ---------------------------------------------------------------------------
# 画布规划（BlueBox Cut 的 32 不动点 + Precise-Align 的 32 补边）
# ---------------------------------------------------------------------------


def parse_ratio(ratio) -> tuple[float, float]:
    """解析比例字符串，返回 ``(wr, hr)``。

    支持 ``"16:9"`` / ``"16x9"`` / ``"16/9"`` / ``"16：9"``（全角冒号）/ ``"1.777"``
    （小数视为 ``宽/高``）。契约里 ``ratio`` 来自前端比例表或提示词润色的
    ``wh_ratio``，格式不统一，因此这里做宽进严出的归一化。
    """
    if ratio is None:
        raise ValueError("ratio 不能为空")
    if isinstance(ratio, (int, float)):
        value = float(ratio)
        if value <= 0:
            raise ValueError(f"非法比例: {ratio!r}")
        return value, 1.0
    text = str(ratio).strip()
    if not text:
        raise ValueError("ratio 不能为空")
    for sep in (":", "：", "x", "X", "/"):
        if sep in text:
            left, _, right = text.partition(sep)
            try:
                wr, hr = float(left.strip()), float(right.strip())
            except ValueError as exc:
                raise ValueError(f"无法解析比例: {ratio!r}") from exc
            if wr <= 0 or hr <= 0:
                raise ValueError(f"非法比例: {ratio!r}")
            return wr, hr
    try:
        value = float(text)
    except ValueError as exc:
        raise ValueError(f"无法解析比例: {ratio!r}") from exc
    if value <= 0:
        raise ValueError(f"非法比例: {ratio!r}")
    return value, 1.0


def _ratio_canvas(wr: float, hr: float, megapixels: float, multiple: int) -> tuple[int, int]:
    """按比例 + 面积求画布：在 32 网格上做小范围搜索，优先保比例、其次保面积。

    直接在连续域四舍五入会把 16:9（理想 1333x750）舍成 1344x736（比例偏差 2.7%）；
    这里在目标附近 ``±2~3`` 个网格内搜索，在面积偏差 ≤15% 的候选里取比例误差最小者，
    再以面积误差做 tie-break。面积误差通常 <5%，比例误差通常 <2%。
    """
    r = float(wr) / float(hr)
    area = max(1.0, float(megapixels) * 1_000_000.0)
    w0 = math.sqrt(area * r)
    h0 = w0 / r
    kw0 = max(1, int(round(w0 / multiple)))
    kh0 = max(1, int(round(h0 / multiple)))

    best: tuple[float, float, int, int] | None = None  # (ratio_err, area_err, w, h)
    for kw in range(max(1, kw0 - 2), kw0 + 4):
        for kh in range(max(1, kh0 - 2), kh0 + 4):
            w, h = kw * multiple, kh * multiple
            area_err = abs((w * h) / area - 1.0)
            if area_err > 0.15:
                continue
            ratio_err = abs(math.log((w / float(h)) / r))
            score = (ratio_err, area_err, w, h)
            if best is None or score < best:
                best = score
    if best is None:
        return max(multiple, int(round(w0 / multiple)) * multiple), max(
            multiple, int(round(h0 / multiple)) * multiple
        )
    return int(best[2]), int(best[3])


def _resolution_for_fixed_point(
    src_w: int, src_h: int, width: int | None, height: int | None, megapixels: float | None
) -> int:
    """推断 BlueBox resolution 档位：显式面积 > 显式宽高 > 源图面积，再夹到 512~2048 步进 32。"""
    if megapixels is not None and float(megapixels) > 0:
        area = float(megapixels) * 1_000_000.0
    elif width and height and int(width) > 0 and int(height) > 0:
        area = float(int(width) * int(height))
    else:
        area = float(src_w * src_h)
    res = int(round(math.sqrt(max(1.0, area))))
    res = max(512, min(2048, res))
    res = max(SNAP, int(round(res / float(SNAP))) * SNAP)
    return int(max(512, min(2048, res)))


def plan_canvas(
    src_w,
    src_h,
    *,
    mode: str,
    width: int | None = None,
    height: int | None = None,
    ratio: str | None = None,
    megapixels: float | None = None,
    fit: str = "pad",
    multiple: int = 32,
) -> CanvasPlan:
    """规划一次编辑的画布（尺寸恒为 ``multiple`` 的倍数）。

    四种模式（对应契约 2.2 与前端"尺寸模式"下拉）：

    * ``follow``     跟随源图尺寸，向上补齐到 ``multiple``；**不重采样、不裁切**，
                     ``scale == 1.0``、offset 居中（补边 ≤31px）。这是零偏移首选。
    * ``custom``     指定 ``width/height``（向上补齐到 ``multiple``），源图按 ``fit`` 摆放。
    * ``ratio``      按 ``ratio`` + ``megapixels`` 计算画布。``megapixels`` 缺省时
                     **默认 1.0MP**（≈1024² 面积，Qwen-Image 2.1 的稳定档），见 ALIGN_COLOR.md。
    * ``fixed_point`` BlueBox ``CutQwenImage21`` 的"分辨率档 + 面积白名单"算法：
                     resolution 由 ``megapixels``（优先）/``width*height``/源图面积推断，
                     再交给 :func:`align.fixed_point_size` 选出严格 32 不动点画布。

    返回的 :class:`CanvasPlan` 同时记录 ``fit`` 与 ``resolution``（仅 fixed_point 有值）。
    """
    mode = str(mode or "follow").lower()
    if mode not in _MODES:
        raise ValueError(f"未知 size_mode={mode!r}，可选 {_MODES}")
    multiple = max(1, int(multiple))
    src_w, src_h = max(1, int(round(src_w))), max(1, int(round(src_h)))
    fit = str(fit or "pad").lower()

    if mode == "follow":
        # 跟随源图：不重采样、不裁切，scale 恒为 1.0，补边最多 31px 且居中。
        canvas_w, canvas_h = align.snap_dims(src_w, src_h, multiple)
        content = (src_w, src_h)
        scale = 1.0
        ox = (canvas_w - src_w) // 2
        oy = (canvas_h - src_h) // 2
        plan_fit = "pad"
        resolution = 0
    elif mode == "custom":
        if not width or not height:
            raise ValueError("size_mode=custom 必须提供 width 与 height")
        canvas_w, canvas_h = align.snap_dims(int(width), int(height), multiple)
        scale, content, ox, oy = _fit_geometry(src_w, src_h, canvas_w, canvas_h, fit)
        plan_fit = "stretch" if fit == "stretch" else fit
        resolution = 0
    elif mode == "ratio":
        if ratio is None:
            if width and height:
                ratio = f"{int(width)}:{int(height)}"
            else:
                raise ValueError("size_mode=ratio 必须提供 ratio（如 16:9）或 width/height")
        wr, hr = parse_ratio(ratio)
        mp = 1.0 if megapixels is None or float(megapixels) <= 0 else float(megapixels)
        canvas_w, canvas_h = _ratio_canvas(wr, hr, mp, multiple)
        scale, content, ox, oy = _fit_geometry(src_w, src_h, canvas_w, canvas_h, fit)
        plan_fit = "stretch" if fit == "stretch" else fit
        resolution = 0
    else:  # fixed_point
        resolution = _resolution_for_fixed_point(src_w, src_h, width, height, megapixels)
        # 比例：显式 ratio 优先；否则沿用**源图比例**（与 BlueBox CutQwenImage21 一致）。
        # width/height 在这里只作为 resolution 档位的面积提示，不当作目标宽高比——
        # 否则 UI 传 width=height=1024 表示"选 1024 档"时会把画布错误地压成正方形。
        if ratio is not None:
            wr, hr = parse_ratio(ratio)
        else:
            wr, hr = float(src_w), float(src_h)
        base_ratio = wr / hr
        base_w = max(1, int(round(resolution * math.sqrt(base_ratio))))
        base_h = max(1, int(round(resolution / math.sqrt(base_ratio))))
        fixed_w, fixed_h, resolution = align.fixed_point_size(
            base_w, base_h, resolution=resolution, tol_ratio=1.0
        )
        canvas_w, canvas_h = int(fixed_w), int(fixed_h)
        scale, content, ox, oy = _fit_geometry(src_w, src_h, canvas_w, canvas_h, fit)
        plan_fit = "stretch" if fit == "stretch" else fit

    # 用实测 content 尺寸回算 scale，保证 compose / 遮罩映射 / crop_back 三者一致
    # （round 之后 scale 与 content 必须严格互为倒数关系，否则遮罩会错位）。
    if plan_fit != "stretch":
        scale = content[0] / float(src_w)
    return CanvasPlan(
        width=int(canvas_w),
        height=int(canvas_h),
        scale=float(scale),
        offset_x=int(ox),
        offset_y=int(oy),
        src_w=int(src_w),
        src_h=int(src_h),
        fit=str(plan_fit),
        resolution=int(resolution),
    )


def compose_canvas(
    src: Image.Image,
    plan: CanvasPlan,
    *,
    pad_mode: str = "edge",
    pad_color: tuple[float, float, float, float] = (0.5, 0.5, 0.5, 1.0),
) -> Image.Image:
    """把源图按 :class:`CanvasPlan` 铺到画布，返回**严格** ``plan.width x plan.height`` 的 RGBA。

    对应 BlueBox ``_pad_to``（contain + 居中补边）与 ``_center_crop_to``
    （cover + 居中裁切）、以及 Precise-Align ``_pad_bhwc`` 的补边方式。

    ``follow`` 模式（``scale==1.0``）不做任何重采样：源图像素原样落到画布，
    所以 ``compose_canvas`` 后再裁回源区域可与原图逐像素一致。
    """
    if pad_mode not in align.PAD_MODES:
        raise ValueError(f"未知 pad_mode={pad_mode!r}，可选 {align.PAD_MODES}")
    src_rgba = src.convert("RGBA")
    content_w, content_h = _content_size(plan)
    if (content_w, content_h) != src_rgba.size:
        src_rgba = src_rgba.resize((content_w, content_h), Image.Resampling.LANCZOS)
    arr = np.asarray(src_rgba, dtype=np.uint8)
    canvas = _place_rgba(
        arr, int(plan.offset_x), int(plan.offset_y), int(plan.width), int(plan.height),
        pad_mode, tuple(pad_color),
    )
    return Image.fromarray(canvas, "RGBA")


def map_mask_to_canvas(mask: np.ndarray, plan: CanvasPlan) -> np.ndarray:
    """原图遮罩 → 画布遮罩（``(canvas_h, canvas_w)``，补边区填 0）。

    对应 ``_mask_to_canvas``：先按 ``plan.scale`` 缩放，再按 ``offset`` 平移。
    ``follow`` 模式是纯平移（无插值误差），可与 :func:`map_mask_from_canvas`
    严格往返。
    """
    m = np.asarray(mask, dtype=np.float32)
    if m.ndim != 2:
        raise ValueError(f"遮罩必须是 (H, W)，收到 shape={m.shape}")
    if m.shape != (int(plan.src_h), int(plan.src_w)):
        m = align.resize_mask(m, plan.src_w, plan.src_h)
    if plan.fit == "stretch":
        return np.clip(align.resize_mask(m, plan.width, plan.height), 0.0, 1.0)
    content_w, content_h = _content_size(plan)
    if m.shape != (content_h, content_w):
        m = align.resize_mask(m, content_w, content_h)
    return np.clip(_place_mask_zero(m, plan.offset_x, plan.offset_y, plan.width, plan.height), 0.0, 1.0)


def map_mask_from_canvas(mask: np.ndarray, plan: CanvasPlan) -> np.ndarray:
    """画布遮罩 → 原图遮罩（``map_mask_to_canvas`` 的逆变换）。"""
    m = np.asarray(mask, dtype=np.float32)
    if m.ndim != 2:
        raise ValueError(f"遮罩必须是 (H, W)，收到 shape={m.shape}")
    if m.shape != (int(plan.height), int(plan.width)):
        m = align.resize_mask(m, plan.width, plan.height)
    if plan.fit == "stretch":
        return np.clip(align.resize_mask(m, plan.src_w, plan.src_h), 0.0, 1.0)
    content_w, content_h = _content_size(plan)
    region = _extract_region_zero(m, plan.offset_x, plan.offset_y, content_w, content_h)
    if region.shape != (int(plan.src_h), int(plan.src_w)):
        region = align.resize_mask(region, plan.src_w, plan.src_h)
    return np.clip(region, 0.0, 1.0)


def plan_to_pad_info(plan: CanvasPlan) -> align.PadInfo:
    """把 :class:`CanvasPlan` 转成 :class:`align.PadInfo`，便于复用 :func:`align.crop_back`。

    只支持 ``pad`` 语义（``follow`` / ``custom``/``ratio``/``fixed_point`` 且
    ``fit="pad"``）。``crop`` / ``stretch`` 的画布与源图不是"缩放+补边"关系，
    无法用 PadInfo 表达，调用会 ``ValueError``（请改用 :func:`crop_back_plan`）。
    """
    if plan.fit != "pad":
        raise ValueError("plan_to_pad_info 只支持 fit='pad' 的画布（crop/stretch 请用 crop_back_plan）")
    content_w, content_h = _content_size(plan)
    return align.PadInfo(
        orig_w=int(plan.src_w),
        orig_h=int(plan.src_h),
        scale=float(plan.scale),
        out_w=int(content_w),
        out_h=int(content_h),
        pad_l=int(plan.offset_x),
        pad_t=int(plan.offset_y),
        canvas_w=int(plan.width),
        canvas_h=int(plan.height),
        multiple=SNAP,
        pad_mode="edge",
    )


def crop_back_plan(im: Image.Image, plan: CanvasPlan, *, method: str = "bicubic") -> Image.Image:
    """按 :class:`CanvasPlan` 把画布图裁回源图尺寸（服务端出图后的收尾步骤）。

    * ``fit="pad"``：画布 = "缩放图 + 补边"，先按 ``offset_x/offset_y`` 切出内容区，
      再缩放到 ``src_w x src_h``。``scale == 1.0`` 时是**纯切片、逐像素不变**。
    * ``fit="crop"``：画布是缩放图的居中裁切，被裁掉的边缘无法恢复，因此把整张
      画布直接缩回 ``src_w x src_h``（尺寸与视角正确，边缘为裁切前内容的重采样近似）。
    * ``fit="stretch"``：整张画布缩回源尺寸。

    这是契约外的**辅助函数**（Lead 的 pipeline 会调用），语义与
    ``align.crop_back(画布, plan_to_pad_info(plan))`` 在 ``fit="pad"`` 时完全等价。
    """
    resample = _resample(method)
    im = im.convert("RGBA")
    if im.size != (int(plan.width), int(plan.height)):
        im = im.resize((int(plan.width), int(plan.height)), resample)

    if plan.fit == "stretch":
        return im.resize((int(plan.src_w), int(plan.src_h)), resample)

    if plan.fit == "crop":
        # cover 裁切丢掉的边缘无法找回，只能整图缩回源尺寸。
        return im.resize((int(plan.src_w), int(plan.src_h)), resample)

    content_w, content_h = _content_size(plan)
    left = max(0, int(plan.offset_x))
    top = max(0, int(plan.offset_y))
    right = min(int(plan.width), left + content_w)
    bottom = min(int(plan.height), top + content_h)
    out = im.crop((left, top, max(left + 1, right), max(top + 1, bottom)))
    if out.size != (int(plan.src_w), int(plan.src_h)):
        out = out.resize((int(plan.src_w), int(plan.src_h)), resample)
    return out


# ---------------------------------------------------------------------------
# 大图预处理：只缩不放 + 32 对齐 + 可逆还原
# ---------------------------------------------------------------------------

_PREPROCESS_MODES = ("downscale_only", "clamp_range")


def _snap_up(value: int, multiple: int) -> int:
    multiple = max(1, int(multiple))
    value = max(1, int(value))
    return max(multiple, ((value + multiple - 1) // multiple) * multiple)


def preprocess_plan(
    w: int,
    h: int,
    *,
    enabled: bool = True,
    max_side: int = 2048,
    min_side: int = 768,
    multiple: int = 32,
    mode: str = "downscale_only",
) -> PreprocessPlan:
    """计算大图预处理几何（不碰像素）。

    ``mode``：

    * ``downscale_only``（默认）：长边超过 ``max_side`` 才缩，小图原样保留，
      永不放大；
    * ``clamp_range``：长边夹到 ``[min_side, max_side]``，小图会被放大
      （仅用于对齐出图档位）。

    ``work`` 尺寸只做比例缩放；32 对齐交给 ``canvas``，因此补边永远是整数
    裁剪，不参与重采样。
    """
    if mode not in _PREPROCESS_MODES:
        raise ValueError(f"未知预处理模式 {mode!r}，可选 {_PREPROCESS_MODES}")
    src_w, src_h = max(1, int(w)), max(1, int(h))
    max_side = max(1, int(max_side))
    scale = 1.0
    if enabled:
        long_side = max(src_w, src_h)
        if mode == "clamp_range":
            target = min(max(long_side, int(min_side)), max_side)
        else:
            target = min(long_side, max_side)
        scale = target / float(long_side)
        if mode == "downscale_only":
            scale = min(1.0, scale)
    if scale == 1.0:
        work_w, work_h = src_w, src_h
    else:
        work_w = max(1, int(round(src_w * scale)))
        work_h = max(1, int(round(src_h * scale)))
    canvas_w = _snap_up(work_w, multiple)
    canvas_h = _snap_up(work_h, multiple)
    return PreprocessPlan(
        enabled=bool(enabled),
        src_w=src_w,
        src_h=src_h,
        work_w=work_w,
        work_h=work_h,
        canvas_w=canvas_w,
        canvas_h=canvas_h,
        scale=work_w / float(src_w),
        pad_x=(canvas_w - work_w) // 2,
        pad_y=(canvas_h - work_h) // 2,
        max_side=max_side,
    )


def sample_size_for(
    width: int,
    height: int,
    *,
    max_side: int = 2048,
    min_side: int = 1024,
    multiple: int = 32,
) -> tuple[int, int]:
    """采样分辨率：长边夹到 ``[min_side, max_side]``，32 对齐；只缩不放。

    孤海扩图工作流会把「原图 + 灰边」的整张画布先做一次
    ``长边 = min(max(1024, 长边), 2048)`` 的缩放再送模型，出图后还原回画布尺寸。
    直接在 4K 级画布上采样会让模型丢掉细节、外补区发虚而且接缝亮度跳变。
    """
    w = max(1, int(width))
    h = max(1, int(height))
    multiple = max(1, int(multiple))
    long_side = max(w, h)
    target = min(max(long_side, max(1, int(min_side))), max(1, int(max_side)))
    if target >= long_side:
        return w, h
    scale = target / float(long_side)
    out_w = max(multiple, int(round(w * scale / multiple)) * multiple)
    out_h = max(multiple, int(round(h * scale / multiple)) * multiple)
    return out_w, out_h


def apply_preprocess(im: Image.Image, plan: PreprocessPlan, *, method: str = "lanczos") -> Image.Image:
    """按 :class:`PreprocessPlan` 缩放并补边，返回 ``canvas_w x canvas_h`` 的工作图。

    ``scale == 1`` 时不做任何重采样；补边用边缘复制（``edge``），且落在还原时
    会被整数裁掉的区域内，不会污染内容。
    """
    if im.size != (plan.src_w, plan.src_h):
        raise ValueError(
            f"预处理源图尺寸不符：期望 {plan.src_w}x{plan.src_h}，"
            f"实际 {im.width}x{im.height}")
    if im.mode == "P":
        im = im.convert("RGBA")
    work = im if im.size == (plan.work_w, plan.work_h) else im.resize(
        (plan.work_w, plan.work_h), _resample(method))
    if work.size == (plan.canvas_w, plan.canvas_h):
        return work

    arr = np.asarray(work)
    if arr.ndim < 2:
        raise ValueError("预处理只支持位图图像")
    pad_r = plan.canvas_w - arr.shape[1] - plan.pad_x
    pad_b = plan.canvas_h - arr.shape[0] - plan.pad_y
    if min(plan.pad_x, plan.pad_y, pad_r, pad_b) < 0:
        raise ValueError("预处理补边参数越界")
    pads = ((plan.pad_y, pad_b), (plan.pad_x, pad_r)) + ((0, 0),) * (arr.ndim - 2)
    return Image.fromarray(np.pad(arr, pads, mode="edge"))


def restore_preprocess(
    im: Image.Image, plan: PreprocessPlan, *, method: str = "lanczos"
) -> Image.Image:
    """还原：整数裁掉 32 补边 → 唯一一次重采样回源尺寸。

    接受工作尺寸（``work``）或画布尺寸（``canvas``）的输入；其它尺寸直接报错，
    避免"悄悄重采样"造成偏移。``scale == 1`` 且源尺寸本就对齐时是**纯恒等**。
    """
    if im.size == (plan.canvas_w, plan.canvas_h) and im.size != (plan.work_w, plan.work_h):
        im = im.crop((
            plan.pad_x, plan.pad_y,
            plan.pad_x + plan.work_w, plan.pad_y + plan.work_h,
        ))
    elif im.size != (plan.work_w, plan.work_h):
        raise ValueError(
            f"待还原图尺寸不符：期望 {plan.work_w}x{plan.work_h}（工作尺寸）或 "
            f"{plan.canvas_w}x{plan.canvas_h}（画布），实际 {im.width}x{im.height}")
    if im.size != (plan.src_w, plan.src_h):
        im = im.resize((plan.src_w, plan.src_h), _resample(method))
    return im


# ---------------------------------------------------------------------------
# 扩图：外补画板（灰边）→ 模型去灰 → 输出大图
# ---------------------------------------------------------------------------

_OUTPAINT_FILL = (128, 128, 128)


def outpaint_canvas(
    im: Image.Image,
    *,
    left: float = 0.0,
    right: float = 0.0,
    top: float = 0.0,
    bottom: float = 0.0,
    trim: int = 0,
    multiple: int = 32,
    max_side: int = 8192,
    fill: tuple[int, int, int] = _OUTPAINT_FILL,
) -> tuple[Image.Image, OutpaintInfo]:
    """按百分比外扩画布，外补区域填 ``#808080``（孤海扩图约定）。

    ``left/right`` 是**宽度**的百分比，``top/bottom`` 是**高度**的百分比。
    画布向上取整到 ``multiple``，多出来的像素统一补到右/下，保证源图坐标仍是
    整数偏移（贴回时不需要重采样）。

    ``trim``：扩图前先从源图四边各裁掉 N 像素（某些图四周带 1~3px 白边/描边，
    直接外扩会把这条边一路"续"出去）。裁掉的区域由模型重新生成，不是简单丢弃。

    ``max_side`` 是硬保护：外扩后的画布长边超过它就抛 ``ValueError``。
    扩图不裁回也不预处理，若不设上限，几下百分比就能把显存打爆。
    """
    src = im.convert("RGBA")
    trim = max(0, int(trim or 0))
    if trim:
        sw0, sh0 = src.size
        if sw0 - trim * 2 < multiple or sh0 - trim * 2 < multiple:
            raise ValueError(
                f"裁边 {trim}px 后图片只剩 {sw0 - trim * 2}×{sh0 - trim * 2}，太小了")
        src = src.crop((trim, trim, sw0 - trim, sh0 - trim))
    sw, sh = src.size
    pads = [float(left), float(right), float(top), float(bottom)]
    if any(not math.isfinite(v) for v in pads):
        raise ValueError("扩图比例必须是有限数字")
    left, right, top, bottom = pads
    left_px = max(0, int(round(sw * left / 100.0)))
    right_px = max(0, int(round(sw * right / 100.0)))
    top_px = max(0, int(round(sh * top / 100.0)))
    bottom_px = max(0, int(round(sh * bottom / 100.0)))
    multiple = max(1, int(multiple))
    canvas_w = _snap_up(sw + left_px + right_px, multiple)
    canvas_h = _snap_up(sh + top_px + bottom_px, multiple)
    if max_side and max(canvas_w, canvas_h) > int(max_side):
        raise ValueError(
            f"扩图后画布 {canvas_w}×{canvas_h} 超过上限 {int(max_side)}"
            "；请减小外扩比例，或先把原图缩到更小"
        )
    right_px += canvas_w - (sw + left_px + right_px)
    bottom_px += canvas_h - (sh + top_px + bottom_px)

    canvas = Image.new("RGBA", (canvas_w, canvas_h), (*fill, 255))
    canvas.paste(src, (left_px, top_px))
    info = OutpaintInfo(
        src_w=sw, src_h=sh,
        left=left_px, right=right_px, top=top_px, bottom=bottom_px,
        canvas_w=canvas_w, canvas_h=canvas_h,
        fill=tuple(int(v) for v in fill),
        trim=trim,
    )
    return canvas, info


def outpaint_mask(info: OutpaintInfo, *, feather: int = 0) -> np.ndarray:
    """外补区域遮罩：源图范围内为 0，灰边为 1。"""
    mask = np.ones((info.canvas_h, info.canvas_w), dtype=np.float32)
    mask[info.top:info.top + info.src_h, info.left:info.left + info.src_w] = 0.0
    if feather > 0:
        mask = align.feather_mask(mask, int(feather))
    return mask


# ---------------------------------------------------------------------------
# 全景：按目标比例规划宽幅画布 → 复用灰边外补语义
# ---------------------------------------------------------------------------

#: 全景比例（宽:高）。官方开源权重只保证到 16:9，2:1 以上属于参考图编辑的延展用法。
PANORAMA_ASPECTS: dict[str, tuple[int, int]] = {
    "2:1": (2, 1),
    "3:1": (3, 1),
    "4:1": (4, 1),
    "21:9": (21, 9),
}

#: 单张全景的总像素上限：覆盖 3072×1536（4.7MP），但拦住 4096×2048（8.4MP）。
PANORAMA_MAX_PIXELS = 6_000_000


@dataclass
class PanoramaPlan:
    """全景画布几何：源图按比例缩到 ``work_*`` 后贴在画布中央。"""

    src_w: int
    src_h: int
    work_w: int
    work_h: int
    left: int
    right: int
    top: int
    bottom: int
    canvas_w: int
    canvas_h: int
    aspect: str
    wrap: bool
    scale: float
    fill: tuple[int, int, int]

    def to_outpaint_info(self) -> OutpaintInfo:
        """复用 ``outpaint_mask`` 的遮罩几何。"""
        return OutpaintInfo(
            src_w=self.work_w, src_h=self.work_h,
            left=self.left, right=self.right,
            top=self.top, bottom=self.bottom,
            canvas_w=self.canvas_w, canvas_h=self.canvas_h,
            fill=self.fill,
        )


def panorama_plan(
    src_w: int,
    src_h: int,
    *,
    aspect: str = "2:1",
    long_side: int = 3072,
    multiple: int = 32,
    max_side: int = 4096,
    max_pixels: int = PANORAMA_MAX_PIXELS,
    fill: tuple[int, int, int] = _OUTPAINT_FILL,
) -> PanoramaPlan:
    """按目标比例计算全景画布；只缩不放，超出预算时抛 ``ValueError``。

    扩展方向由原图比例自动决定，按“最小外扩”补齐：
    - 源图比目标窄 → 左右补灰；
    - 源图比目标宽 → 上下补灰（否则只能裁掉内容）。

    ``long_side`` 是输出长边上限，``max_pixels`` 是总像素上限；两者都只触发
    等比缩小（源图同步缩），不会放大源图。
    """
    sw, sh = int(src_w), int(src_h)
    if sw <= 0 or sh <= 0:
        raise ValueError("全景原图尺寸无效")
    aspect = str(aspect or "2:1").strip()
    if aspect not in PANORAMA_ASPECTS:
        raise ValueError(
            f"全景比例只支持 {'/'.join(PANORAMA_ASPECTS)}，收到 {aspect!r}")
    multiple = max(1, int(multiple))
    long_side = int(long_side or 0)
    if long_side <= 0:
        raise ValueError("全景长边必须是正整数")
    if max_side and long_side > int(max_side):
        raise ValueError(f"全景长边 {long_side} 超过上限 {int(max_side)}")

    aw, ah = PANORAMA_ASPECTS[aspect]
    ratio = aw / ah

    # 1) 最小外扩：只补需要的方向
    current = sw / sh
    if current < ratio:
        natural_w = max(sw, int(math.ceil(sh * ratio)))
        natural_h = sh
    elif current > ratio:
        natural_w = sw
        natural_h = max(sh, int(math.ceil(sw / ratio)))
    else:
        natural_w, natural_h = sw, sh

    canvas_w = _snap_up(natural_w, multiple)
    canvas_h = _snap_up(natural_h, multiple)

    # 2) 长边 / 总像素上限：只缩不放
    scale = 1.0
    long = max(canvas_w, canvas_h)
    if long > long_side:
        scale = long_side / long
    if max_pixels and canvas_w * canvas_h * scale * scale > max_pixels:
        scale = min(scale, math.sqrt(max_pixels / (canvas_w * canvas_h)))
    if scale < 1.0:
        # 向下取整到 32 的倍数，确保缩小后不越过长边/像素上限。
        canvas_w = max(multiple, int(round(canvas_w * scale)) // multiple * multiple)
        canvas_h = max(multiple, int(round(canvas_h * scale)) // multiple * multiple)

    if max_side and max(canvas_w, canvas_h) > int(max_side):
        raise ValueError(
            f"全景画布 {canvas_w}×{canvas_h} 超过单边上限 {int(max_side)}；请降低长边")
    if max_pixels and canvas_w * canvas_h > max_pixels:
        raise ValueError(
            f"全景画布 {canvas_w}×{canvas_h} 超过总像素上限 {int(max_pixels)}；"
            f"请降低长边到 {max(multiple, int(math.sqrt(max_pixels / ratio)) // multiple * multiple)} 以内")

    # 3) 源图等比缩到画布内（不放大），居中贴放
    actual = min(1.0, canvas_w / natural_w, canvas_h / natural_h)
    work_w = max(1, min(canvas_w, int(round(sw * actual))))
    work_h = max(1, min(canvas_h, int(round(sh * actual))))
    left = (canvas_w - work_w) // 2
    top = (canvas_h - work_h) // 2
    return PanoramaPlan(
        src_w=sw, src_h=sh, work_w=work_w, work_h=work_h,
        left=left, right=canvas_w - work_w - left,
        top=top, bottom=canvas_h - work_h - top,
        canvas_w=canvas_w, canvas_h=canvas_h,
        aspect=aspect, wrap=False,
        scale=round(actual, 6), fill=tuple(int(v) for v in fill),
    )


def panorama_canvas(im: Image.Image, plan: PanoramaPlan) -> Image.Image:
    """把源图按 plan 缩到工作尺寸并贴在灰底画布中央。"""
    src = im.convert("RGBA")
    if (plan.work_w, plan.work_h) != src.size:
        src = src.resize((plan.work_w, plan.work_h), _resample("bicubic"))
    canvas = Image.new("RGBA", (plan.canvas_w, plan.canvas_h),
                       (*plan.fill, 255))
    canvas.paste(src, (plan.left, plan.top))
    return canvas


#: 360° 全景默认源图占比：源图宽占画布宽的 40%，其余四周交给模型补全。
PANORAMA360_DEFAULT_COVERAGE = 0.4


def panorama360_plan(
    src_w: int,
    src_h: int,
    *,
    coverage: float = PANORAMA360_DEFAULT_COVERAGE,
    long_side: int = 3072,
    multiple: int = 32,
    max_side: int = 4096,
    max_pixels: int = PANORAMA_MAX_PIXELS,
    fill: tuple[int, int, int] = _OUTPAINT_FILL,
) -> PanoramaPlan:
    """360° 全景几何：固定 2:1 画布，源图缩到 ``coverage`` 后居中，四周补灰。

    与 :func:`panorama_plan` 的「最小外扩」不同，这里**四个方向都会留出补全区**，
    模型才有空间把场景向四周延展成球面内容。

    - ``coverage``：源图宽度占画布宽度的比例，0.3~0.6；默认 0.4。
    - 源图只缩不放；竖图/超高图按画布高度的 85% 兜底，避免顶到上下边。
    - ``long_side`` / ``max_pixels`` 都是上限，超出时只缩小画布。
    """
    sw, sh = int(src_w), int(src_h)
    if sw <= 0 or sh <= 0:
        raise ValueError("360° 全景原图尺寸无效")
    multiple = max(1, int(multiple))
    long_side = int(long_side or 0)
    if long_side <= 0:
        raise ValueError("360° 全景长边必须是正整数")
    if max_side and long_side > int(max_side):
        raise ValueError(f"360° 全景长边 {long_side} 超过上限 {int(max_side)}")
    try:
        cov = float(coverage)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"360° 全景 coverage 必须是数字：{exc}") from exc
    if not 0.3 <= cov <= 0.6:
        raise ValueError(f"360° 全景 coverage 必须在 0.3~0.6，收到 {cov}")

    # 1) 2:1 画布；长边取 multiple*2 的倍数，保证高也是 multiple 的倍数。
    step = multiple * 2
    canvas_w = max(step, long_side // step * step)
    if max_pixels and canvas_w * (canvas_w // 2) > max_pixels:
        budget_w = int(math.sqrt(2 * max_pixels)) // step * step
        canvas_w = max(step, min(canvas_w, budget_w))
    canvas_h = max(multiple, canvas_w // 2)

    if max_side and canvas_w > int(max_side):
        raise ValueError(
            f"360° 全景画布 {canvas_w}×{canvas_h} 超过单边上限 {int(max_side)}；请降低长边")
    if max_pixels and canvas_w * canvas_h > max_pixels:
        raise ValueError(
            f"360° 全景画布 {canvas_w}×{canvas_h} 超过总像素上限 {int(max_pixels)}；请降低长边")

    def _snap_down(value: float) -> int:
        return max(multiple, int(value) // multiple * multiple)

    # 2) 源图工作尺寸：宽占 coverage，高按原比例；只缩不放。
    work_w = _snap_down(min(sw, canvas_w * cov))
    work_h = _snap_down(min(sh, work_w * sh / sw))
    # 3) 竖图兜底：高度不超过画布 85%，再反推宽度。
    max_h = _snap_down(canvas_h * 0.85)
    if work_h > max_h:
        work_h = max_h
        work_w = _snap_down(min(sw, work_h * sw / sh))
    work_w = min(canvas_w, work_w)
    work_h = min(canvas_h, work_h)

    # 4) 居中贴放；四周补边由遮罩统一处理。
    left = (canvas_w - work_w) // 2
    top = (canvas_h - work_h) // 2
    return PanoramaPlan(
        src_w=sw, src_h=sh, work_w=work_w, work_h=work_h,
        left=left, right=canvas_w - work_w - left,
        top=top, bottom=canvas_h - work_h - top,
        canvas_w=canvas_w, canvas_h=canvas_h,
        aspect="2:1", wrap=False,
        scale=round(work_w / sw, 6), fill=tuple(int(v) for v in fill),
    )


def _smooth_1d(values: np.ndarray, radius: int) -> np.ndarray:
    """沿第 0 维做均值平滑（edge padding），用于抹掉逐行/逐列的噪声。"""
    radius = int(radius)
    if radius <= 0 or values.shape[0] < 3:
        return values.astype(np.float32, copy=False)
    radius = min(radius, max(1, values.shape[0] // 2))
    kernel = np.ones(2 * radius + 1, dtype=np.float32) / (2 * radius + 1)
    padded = np.pad(values, ((radius, radius), (0, 0)), mode="edge")
    out = np.empty(values.shape, dtype=np.float32)
    for channel in range(values.shape[1]):
        out[:, channel] = np.convolve(padded[:, channel], kernel, mode="valid")
    return out


def _smooth_axis1(values: np.ndarray, radius: int) -> np.ndarray:
    """沿第 1 维（宽/列）做均值平滑。"""
    rows, cols = values.shape[0], values.shape[1]
    flat = np.swapaxes(values, 0, 1).reshape(cols, -1)
    smoothed = _smooth_1d(flat, radius)
    return np.swapaxes(smoothed.reshape(cols, rows, values.shape[2]), 0, 1)


def seam_level(
    image: Image.Image | np.ndarray,
    pads: dict[str, int] | None,
    *,
    band: int = 48,
    smooth: int = 16,
    flatten: int = 96,
    flatten_clip: float = 32.0,
) -> tuple[Image.Image | np.ndarray, dict[str, Any]]:
    """把源图与扩展区交界的亮度阶跃摊成渐变（只改扩展区一侧）。

    ``pads`` 为输出画布的 ``{left, right, top, bottom}``。分两步：

    1. **边界阶跃**：取交界两侧像素的逐行（左右）或逐列（上下）色差，向扩展区内做
       ``band`` 像素的线性衰减偏移，让交界处与源图对齐。
    2. **低频光晕**：模型常在灰边边界内侧画出一条约 20~40px 宽的竖/横亮带。把源图
       边缘的低频灰度走向镜像到扩展区一侧，按 ``flatten`` 像素衰减做修正（限幅
       ``flatten_clip``），只抹掉低频偏差，保留纹理细节。

    源图区域不参与写入，因此 ``outside_max_abs`` 仍为 0。
    """
    is_pil = isinstance(image, Image.Image)
    raw = np.asarray(image)
    if raw.ndim != 3:
        return image, {"skipped": True, "reason": "shape"}
    pads = {k: max(0, int(v or 0)) for k, v in (pads or {}).items()}
    sides = ("left", "right", "top", "bottom")
    if not any(pads.get(k) for k in sides):
        return image, {"skipped": True, "reason": "no_pads"}

    height, width = raw.shape[:2]
    rgb = raw[..., :3].astype(np.float32)
    report: dict[str, Any] = {
        "mode": "edge_offset_ramp",
        "band": int(band),
        "flatten": int(flatten),
        "sides": {},
    }

    def _record(name: str, delta: np.ndarray, after: np.ndarray,
                flatten_abs: float | None = None) -> None:
        entry = {
            "pad": pads.get(name, 0),
            "band": int(min(band, pads.get(name, 0))),
            "before_mean_abs": round(float(np.abs(delta).mean()), 2),
            "before_max_abs": round(float(np.abs(delta).max()), 2),
            "after_mean_abs": round(float(np.abs(after).mean()), 2),
        }
        if flatten_abs is not None:
            entry["flatten_mean_abs"] = round(float(flatten_abs), 2)
        report["sides"][name] = entry

    # 第一步：交界列/行的阶跃对齐
    left = min(pads.get("left", 0), width // 2)
    if left > 0:
        span = min(band, left)
        delta = rgb[:, left] - rgb[:, left - 1]
        ramp = np.linspace(0.0, 1.0, span, dtype=np.float32)
        rgb[:, left - span:left] += _smooth_1d(delta, smooth)[:, None, :] * ramp[None, :, None]
        _record("left", delta, rgb[:, left] - rgb[:, left - 1])

    right = min(pads.get("right", 0), width // 2)
    if right > 0:
        span = min(band, right)
        delta = rgb[:, width - right - 1] - rgb[:, width - right]
        ramp = np.linspace(1.0, 0.0, span, dtype=np.float32)
        rgb[:, width - right:width - right + span] += (
            _smooth_1d(delta, smooth)[:, None, :] * ramp[None, :, None])
        _record("right", delta, rgb[:, width - right - 1] - rgb[:, width - right])

    top = min(pads.get("top", 0), height // 2)
    if top > 0:
        span = min(band, top)
        delta = rgb[top, :] - rgb[top - 1, :]
        ramp = np.linspace(0.0, 1.0, span, dtype=np.float32)
        rgb[top - span:top, :] += _smooth_1d(delta, smooth)[None, :, :] * ramp[:, None, None]
        _record("top", delta, rgb[top, :] - rgb[top - 1, :])

    bottom = min(pads.get("bottom", 0), height // 2)
    if bottom > 0:
        span = min(band, bottom)
        delta = rgb[height - bottom - 1, :] - rgb[height - bottom, :]
        ramp = np.linspace(1.0, 0.0, span, dtype=np.float32)
        rgb[height - bottom:height - bottom + span, :] += (
            _smooth_1d(delta, smooth)[None, :, :] * ramp[:, None, None])
        _record("bottom", delta, rgb[height - bottom - 1, :] - rgb[height - bottom, :])

    # 第二步：把源图边缘的低频走向镜像到扩展区，压掉模型画出的光晕带
    if flatten > 1:
        for name in ("left", "right"):
            pad = min(pads.get(name, 0), width // 2)
            span = min(int(flatten), pad)
            if span < 4:
                continue
            if name == "left":
                gen = rgb[:, left - span:left][:, ::-1]
                src = rgb[:, left:left + span]
            else:
                gen = rgb[:, width - right:width - right + span]
                src = rgb[:, width - right - span:width - right][:, ::-1]
            gen_s = _smooth_axis1(gen, max(2, smooth // 4))
            src_s = _smooth_axis1(src, max(2, smooth // 4))
            weight = 1.0 - np.arange(span, dtype=np.float32) / max(1, span - 1)
            corr = np.clip(
                (src_s - src_s[:, :1] - (gen_s - gen_s[:, :1]))
                * weight[None, :, None],
                -flatten_clip, flatten_clip)
            if name == "left":
                rgb[:, left - span:left] += corr[:, ::-1]
            else:
                rgb[:, width - right:width - right + span] += corr
            report["sides"][name]["flatten_mean_abs"] = round(float(np.abs(corr).mean()), 2)

    out = np.array(raw, copy=True)
    if raw.dtype == np.uint8:
        out[..., :3] = np.rint(np.clip(rgb, 0.0, 255.0)).astype(np.uint8)
    else:
        out[..., :3] = np.clip(rgb, 0.0, 255.0)
    if is_pil:
        return Image.fromarray(out, mode=image.mode), report
    return out, report


def wrap_seam_blend(
    image: Image.Image | np.ndarray,
    *,
    blend_px: int = 24,
    strength: float = 1.0,
) -> tuple[Image.Image | np.ndarray, dict[str, Any]]:
    """360° 环绕接缝的近似处理：边缘色差校正 + 窄带羽化。

    只做“让左右边缘尽量对齐”的低频修补，不承诺等距柱状投影的结构正确性。
    返回 ``(image, report)``，``report`` 里带处理前后的边缘差。
    """
    is_pil = isinstance(image, Image.Image)
    raw = np.asarray(image)
    if raw.ndim != 3 or raw.shape[1] < 4:
        return image, {"skipped": True, "reason": "shape"}
    width = int(raw.shape[1])
    band = max(1, min(int(blend_px), width // 2))
    scale_div = 255.0 if raw.dtype == np.uint8 else 1.0
    rgb = raw[..., :3].astype(np.float32) / scale_div

    before = float(np.abs(rgb[:, 0] - rgb[:, -1]).max() * 255.0)
    left_mean = rgb[:, :band].mean(axis=(0, 1))
    right_mean = rgb[:, -band:].mean(axis=(0, 1))
    delta = (right_mean - left_mean) * float(max(0.0, min(1.0, strength)))

    # 全宽线性校正：左边缘 -delta/2，右边缘 +delta/2，中间平滑过渡。
    ramp = np.linspace(-0.5, 0.5, width, dtype=np.float32)[None, :, None]
    rgb = np.clip(rgb + delta[None, None, :] * ramp, 0.0, 1.0)

    # 窄带羽化：把首尾两列先取平均，再按距离衰减写回两侧。
    edge = (rgb[:, 0:1, :] + rgb[:, -1:, :]) * 0.5
    for index in range(band):
        alpha = 1.0 - index / band
        rgb[:, index:index + 1] = rgb[:, index:index + 1] * (1 - alpha) + edge * alpha
        rgb[:, width - 1 - index:width - index] = (
            rgb[:, width - 1 - index:width - index] * (1 - alpha) + edge * alpha)

    after = float(np.abs(rgb[:, 0] - rgb[:, -1]).max() * 255.0)
    out = np.array(raw, copy=True)
    out[..., :3] = (
        np.rint(rgb * 255.0).astype(np.uint8) if raw.dtype == np.uint8 else rgb)
    report = {
        "mode": "edge_affine",
        "blend_px": band,
        "before_max_abs": round(before, 2),
        "after_max_abs": round(after, 2),
        "shift": [round(float(v) * 255.0, 2) for v in delta],
    }
    if is_pil:
        return Image.fromarray(out, mode=image.mode), report
    return out, report


# ---------------------------------------------------------------------------
# 方案 A 收尾：composite（对应 PreciseAlignComposite.composite）
# ---------------------------------------------------------------------------


def _apply_reinhard_to_u8(
    edited_u8: np.ndarray,
    original_u8: np.ndarray,
    band: np.ndarray,
    strength: float,
) -> np.ndarray:
    """在过渡带上做 Reinhard 匹配并把结果写回 uint8 编辑图（只动 RGB，不动 alpha）。"""
    edited_rgb = edited_u8[..., :3].astype(np.float32) / 255.0
    original_rgb = original_u8[..., :3].astype(np.float32) / 255.0
    matched = align.reinhard_match(edited_rgb, original_rgb, band, strength)
    out = edited_u8.copy()
    out[..., :3] = np.rint(np.clip(matched, 0.0, 1.0) * 255.0).astype(np.uint8)
    return out


def color_consistency(original, edited, *, strength: float = 1.0,
                      low: float = 6.0, high: float = 16.0,
                      anchor_min: float = 0.05):
    """BlueBox 式整图颜色一致性（原生模式用，不涉及任何遮罩）。

    以"几乎没变"的像素当锚区（``|dst - src| <= low``），用
    :func:`align.anchor_affine` 估逐通道增益/偏移，再按 ``strength`` 应用到整张图。
    VAE 编解码必然带来 1~5 级的整体漂移，这一步把它拉回原图的色域，
    同时不动物体本身（大改动像素只参与统计的极小权重，不会被压平）。

    返回 ``(image, report)``；锚区不足 ``anchor_min`` 时原样返回并标记 ``skipped``。
    ``original`` / ``edited`` 支持 PIL 或 ndarray，返回类型与 ``edited`` 一致。
    """
    is_pil = isinstance(edited, Image.Image)
    e_raw = np.asarray(edited)
    o_raw = np.asarray(original)
    # 画布通常是 RGBA、模型解码输出是 RGB：只比较前 3 通道，要求空间尺寸一致。
    if (e_raw.ndim != 3 or o_raw.ndim != 3
            or e_raw.shape[:2] != o_raw.shape[:2]
            or min(e_raw.shape[2], o_raw.shape[2]) < 3 or e_raw.size == 0):
        return edited, {"mode": "global_affine", "skipped": True, "reason": "shape"}

    is_u8 = e_raw.dtype == np.uint8
    scale_div = 255.0 if is_u8 else 1.0
    o = o_raw[..., :3].astype(np.float32) / scale_div
    e = e_raw[..., :3].astype(np.float32) / scale_div

    diff = np.abs(e - o).max(axis=2) * 255.0
    span = max(1e-6, float(high) - float(low))
    t = np.clip((diff - float(low)) / span, 0.0, 1.0)
    weight = t * t * (3.0 - 2.0 * t)

    scale, shift, skipped = align.anchor_affine(
        o, e, weight, anchor_min=float(anchor_min), strength=float(strength))
    report = {
        "mode": "global_affine",
        "scale": [round(float(v), 6) for v in scale],
        "shift": [round(float(v), 6) for v in shift],
        "strength": float(strength),
        "anchor_ratio": round(float((weight <= 0.0).mean()), 4),
        "skipped": bool(skipped),
    }
    if skipped:
        return edited, report

    corrected = np.clip(e * scale + shift, 0.0, 1.0)
    out = np.array(e_raw, copy=True)
    out[..., :3] = (
        np.rint(corrected * 255.0).astype(np.uint8) if is_u8
        else corrected.astype(np.float32)
    )
    if is_pil:
        return Image.fromarray(out, mode=edited.mode), report
    return out, report


def _suppress_small_changes(content, original, *, low: float = 6.0,
                            high: float = 16.0):
    """把模型"顺手重绘"带来的小改动压回原图（逐像素软阈值，不引入空间台阶）。

    ``out = src + (dst - src) * smoothstep(|dst - src|; low, high)``

    模型会把遮罩内整块区域重画一遍，干净背景上通常带 1~8 级的偏色与噪点；在纯渐变、
    纯色墙这类背景上，这些"几乎没改"的像素会拼出一个可见矩形。这里按差异大小做
    **逐像素**软阈值：差异 ``<= low`` 完全回到原图（字节级一致），``>= high`` 原样
    保留（物体、接触投影、真实改动），中间单调平滑过渡。

    为什么不用这两种写法：

    * ``alpha *= max(a, b)`` 乘性闸门会在两场的交界处留下一条等高线（真机回归里
      直接看到一圈"线框"），比原问题更糟；
    * 对闸门做空间模糊会把物体的颜色糊到边界外，形成光晕。

    逐像素软阈值只做值域上的单调压缩，输出始终是 ``src`` 与 ``dst`` 的凸组合，
    且 ``|dst - src| <= low`` 处精确等于 ``src``。参数是 0~255 色阶差；
    ``content`` / ``original`` 允许 u8 或 0~1 浮点，返回与 ``content`` 同类型。
    """
    data = np.asarray(content)
    src = np.asarray(original)
    if src.shape != data.shape or data.size == 0:
        return content

    is_u8 = data.dtype == np.uint8
    dst_f = data[..., :3].astype(np.float32) / (255.0 if is_u8 else 1.0)
    src_f = src[..., :3].astype(np.float32) / (255.0 if is_u8 else 1.0)
    diff = np.abs(dst_f - src_f).max(axis=2) * 255.0
    span = max(1e-6, float(high) - float(low))
    t = np.clip((diff - float(low)) / span, 0.0, 1.0)
    weight = (t * t * (3.0 - 2.0 * t))[..., None]
    if not bool((weight < 1.0).any()):
        return content

    out = np.array(data, copy=True)
    merged = src_f + (dst_f - src_f) * weight
    out[..., :3] = (
        np.rint(np.clip(merged, 0.0, 1.0) * 255.0).astype(np.uint8)
        if is_u8 else np.clip(merged, 0.0, 1.0).astype(np.float32)
    )
    return out


def composite(
    original_canvas: Image.Image,
    edited_canvas: Image.Image,
    mask_canvas: np.ndarray | None,
    *,
    feather: int = 32,
    curve: str = "smoothstep",
    color_match: bool = True,
    color_strength: float = 0.6,
    mask_expand: int = 0,
    anchor_match: bool = True,
    anchor_strength: float = 1.0,
    band_mode: str = "lowfreq",
    dither: bool = False,
    report: dict | None = None,
) -> Image.Image:
    """方案 A 收尾：用遮罩把编辑结果合成回原图（零色差的关键步骤）。

    与 ``PreciseAlignComposite.composite`` 的对应关系：

    1. ``mask=None`` → 全图编辑（alpha 全 1）；
    2. ``mask_expand`` → 先膨胀遮罩（覆盖模型边缘的硬接缝）；
    3. 颜色（``color_match`` 开启时）：优先用**锚区**（遮罩外）估 gain/offset
       （BlueBox 思路，最干净）；锚区不足才回退"过渡带 Reinhard"；
    4. ``feather`` → 高斯羽化，``curve`` → smoothstep 过渡；
    5. ``band_mode="lowfreq"`` → 过渡带低频移植（消接缝色块），``"alpha"`` → 纯羽化；
    6. 混合：``original * (1 - a) + edited * a``。

    ``report`` 传入字典时写入本次实际使用的颜色参数与锚区比例（供 quality 用），
    只读不参与像素写入。

    **零色差硬保证**：输出从原图 uint8 拷贝出发，只对 ``alpha > 0`` 的像素赋值，
    因此遮罩外（alpha == 0）像素与 ``original_canvas`` 逐字节相同，
    ``compare(result, original_canvas)["max_abs"] == 0``。

    ``edited_canvas`` 尺寸必须与 ``original_canvas`` 一致；不一致时按 bicubic
    缩放到原图尺寸（不报错，方便前端预览；正式出图应保证一致）。
    """
    if curve not in ("smoothstep", "linear"):
        raise ValueError(f"未知 curve={curve!r}")
    original = original_canvas.convert("RGBA")
    edited = edited_canvas.convert("RGBA")
    if edited.size != original.size:
        edited = edited.resize(original.size, Image.Resampling.BICUBIC)

    width, height = original.size
    original_u8 = _to_uint8(original, alpha=True)
    edited_u8 = _to_uint8(edited, alpha=True)

    if mask_canvas is None:
        raw = np.ones((height, width), dtype=np.float32)
    else:
        raw = np.asarray(mask_canvas, dtype=np.float32)
        if raw.ndim != 2:
            raise ValueError(f"遮罩必须是 (H, W)，收到 shape={raw.shape}")
        if raw.shape != (height, width):
            raw = align.resize_mask(raw, width, height)
        raw = np.clip(raw, 0.0, 1.0)
        if int(mask_expand) > 0:
            raw = align.dilate_mask(raw, int(mask_expand))

    # 3) 颜色：锚区仿射优先，锚区不足才回退 Reinhard（两者互斥，避免二次拉色）
    if band_mode not in ("alpha", "lowfreq"):
        raise ValueError(f"未知 band_mode={band_mode!r}")
    color_info = {"mode": "off", "band_mode": band_mode}
    anchor_ok = False
    if anchor_match and color_match and mask_canvas is not None:
        original_f = original_u8[..., :3].astype(np.float32) / 255.0
        edited_f = edited_u8[..., :3].astype(np.float32) / 255.0
        scale, shift, skipped = align.anchor_affine(
            original_f, edited_f, raw, strength=float(anchor_strength)
        )
        color_info["anchor_ratio"] = float((raw <= 0.0).mean())
        color_info["skipped"] = bool(skipped)
        if not skipped:
            corrected = np.clip(edited_f * scale + shift, 0.0, 1.0)
            edited_u8 = edited_u8.copy()
            edited_u8[..., :3] = np.rint(corrected * 255.0).astype(np.uint8)
            anchor_ok = True
            color_info.update(
                mode="anchor_affine",
                scale=[round(float(v), 6) for v in scale],
                offset=[round(float(v), 6) for v in shift],
            )
    if color_match and not anchor_ok:
        band = align.band_from_mask(raw, fallback_px=max(8, int(feather)))
        if band is not None and float(band.sum()) > 0:
            edited_u8 = _apply_reinhard_to_u8(edited_u8, original_u8, band, float(color_strength))
            color_info["mode"] = "reinhard"

    # 4) 羽化 + 曲线
    alpha = align.feather_mask(raw, int(feather)) if int(feather) > 0 else raw
    alpha = align.curve_mask(alpha, curve)

    # 零色差硬约束：羽化会向外扩散，这里把 alpha 重新钳到"原始遮罩 > 0"的范围内，
    # 保证遮罩外（mask == 0）像素的 alpha 严格为 0，渲染结果与输入字节级相同。
    # 代价是羽化只向遮罩内侧衰减（内侧过渡），这也是本地编辑最稳的做法。
    if mask_canvas is not None:
        alpha = alpha * (raw > 0.0).astype(np.float32)

    # 5) 过渡带低频移植（只动 0 < alpha < 1，alpha 0/1 处严格不变）
    base_u8 = edited_u8
    if band_mode == "lowfreq" and mask_canvas is not None:
        band_sel = (alpha > 0.0) & (alpha < 1.0)
        if bool(band_sel.any()):
            original_f = original_u8[..., :3].astype(np.float32) / 255.0
            edited_f = edited_u8[..., :3].astype(np.float32) / 255.0
            merged = align.lowfreq_merge(original_f, edited_f, alpha)
            base_u8 = edited_u8.copy()
            base_u8[..., :3] = np.rint(np.clip(merged, 0.0, 1.0) * 255.0).astype(np.uint8)

    # 小改动压回原图：模型"顺手重绘"整块背景会带来 1~8 级偏色/噪点，在纯渐变、
    # 纯色墙这类干净背景上会拼出一个可见矩形（真机回归的「像素块」）。
    if mask_canvas is not None:
        base_u8 = _suppress_small_changes(base_u8, original_u8)

    # 6) 混合：只在 alpha > 0 处赋值，保证遮罩外逐字节保留。
    out = original_u8.copy()
    selected = alpha > 0.0
    if bool(selected.any()):
        a = alpha[selected][:, None]
        blended = (
            original_u8[selected].astype(np.float32) * (1.0 - a)
            + base_u8[selected].astype(np.float32) * a
        )
        if dither:
            rgb = align.ign_dither(blended[:, :3] / 255.0, a, amount=1.0 / 255.0)
            blended[:, :3] = rgb * 255.0
        out[selected] = np.rint(np.clip(blended, 0.0, 255.0)).astype(np.uint8)
    if report is not None:
        report.update(color_info)
    return Image.fromarray(out, "RGBA")


# ---------------------------------------------------------------------------
# 方案 B：crop_region / stitch_region
# （对应 PreciseAlignCropEdit.crop_region / PreciseAlignStitch.stitch）
# ---------------------------------------------------------------------------


def crop_region(
    original_canvas: Image.Image,
    mask_canvas: np.ndarray | None,
    *,
    context_factor: float = 1.5,
    context_pixels: int = 96,
    multiple: int = 32,
) -> tuple[Image.Image, CropInfo]:
    """按遮罩包围盒裁出"编辑区 + 上下文"，补边到 32，返回 ``(裁切画布, CropInfo)``。

    对应 ``PreciseAlignCropEdit.crop_region`` 的几何部分：

    1. 取 ``mask > 0.5`` 的包围盒（无遮罩则用整画布）；
    2. 窗口尺寸 = ``max(32, round(w * context_factor) + 2 * context_pixels)``，
       居中于包围盒，再夹到画布内；
    3. 裁切后居中补边到 ``multiple`` 的倍数（``pad_mode=edge``）。

    补边偏移是确定性的（居中、``multiple``），:func:`stitch_region` 按同一规则反推，
    因此两者成对使用可以精确贴回。建议 ``multiple`` 保持 32（stitch 内部按 32 反推）。
    """
    multiple = max(1, int(multiple))
    original = original_canvas.convert("RGBA")
    width, height = original.size

    if mask_canvas is None:
        region = (0, 0, width, height)
    else:
        m = np.asarray(mask_canvas, dtype=np.float32)
        if m.ndim != 2:
            raise ValueError(f"遮罩必须是 (H, W)，收到 shape={m.shape}")
        if m.shape != (height, width):
            m = align.resize_mask(m, width, height)
        ys, xs = np.nonzero(m > 0.5)
        if ys.size == 0:
            raise ValueError("遮罩为空，无法确定编辑区域")
        x1, x2 = int(xs.min()), int(xs.max())
        y1, y2 = int(ys.min()), int(ys.max())
        region = (x1, y1, x2 - x1 + 1, y2 - y1 + 1)

    rx, ry, rw, rh = region
    cx, cy = rx + rw / 2.0, ry + rh / 2.0
    nw = max(32, int(round(rw * float(context_factor))) + 2 * int(context_pixels))
    nh = max(32, int(round(rh * float(context_factor))) + 2 * int(context_pixels))
    x = int(round(cx - nw / 2.0))
    y = int(round(cy - nh / 2.0))
    x = max(0, min(x, max(0, width - 1)))
    y = max(0, min(y, max(0, height - 1)))
    cw = max(1, min(nw, width - x))
    ch = max(1, min(nh, height - y))

    crop = original.crop((x, y, x + cw, y + ch))
    padded, _info = align.pad_image(
        crop, multiple=multiple, pad_mode="edge", align="center", scale_by=1.0
    )
    info = CropInfo(
        x=int(x), y=int(y), w=int(cw), h=int(ch),
        canvas_w=int(width), canvas_h=int(height),
    )
    return padded, info


def _edge_mode_color(im: Image.Image, *, step: int = 4) -> tuple[int, int, int]:
    """取图像四边像素里出现最多的 RGB（量化到 24bit 精确计数）。"""
    a = np.asarray(im.convert("RGB"), dtype=np.uint8)
    if a.size == 0:
        return (0, 0, 0)
    step = max(1, int(step))
    border = np.concatenate([
        a[0, ::step].reshape(-1, 3),
        a[-1, ::step].reshape(-1, 3),
        a[::step, 0].reshape(-1, 3),
        a[::step, -1].reshape(-1, 3),
    ])
    packed = (border[:, 0].astype(np.int64) << 16) | (border[:, 1].astype(np.int64) << 8) | border[:, 2]
    vals, counts = np.unique(packed, return_counts=True)
    v = int(vals[int(np.argmax(counts))])
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255)


def crop_with_color_fill(
    im: Image.Image, box: tuple[int, int, int, int],
    *, fill: tuple[int, int, int] | None = None,
) -> Image.Image:
    """按 ``box`` 裁图；越界部分用"边缘众数色"补，输出尺寸恒为 ``box`` 大小。

    与 :func:`crop_region` 的 edge 补边不同：这里窗口可以越出画布，越界区域是
    合成出来的，只在模型输入里存在；贴回时 :func:`stitch_region` 会按画布求交
    丢弃它们，所以不会污染画布。
    """
    x0, y0, x1, y1 = (int(v) for v in box)
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    src = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    sh, sw = src.shape[:2]
    color = tuple(int(v) for v in (fill if fill is not None else _edge_mode_color(im)))
    out = np.empty((h, w, 4), dtype=np.uint8)
    out[..., 0] = color[0]
    out[..., 1] = color[1]
    out[..., 2] = color[2]
    out[..., 3] = 255
    ox0, oy0 = max(0, x0), max(0, y0)
    ox1, oy1 = min(sw, x1), min(sh, y1)
    if ox1 > ox0 and oy1 > oy0:
        out[oy0 - y0: oy1 - y0, ox0 - x0: ox1 - x0] = src[oy0:oy1, ox0:ox1]
    return Image.fromarray(out, "RGBA")


def crop_region_factors(
    original_canvas: Image.Image,
    mask_canvas: np.ndarray | None,
    *,
    fills: bool = False,
    expand_top: float = 1.3,
    expand_bottom: float = 1.4,
    expand_left: float = 1.4,
    expand_right: float = 1.4,
    multiple: int = 32,
    max_side: int = 0,
    min_side: int = 0,
    min_window: int = 1024,
) -> tuple[Image.Image, CropInfo]:
    """按「短边 × 每向独立系数」裁编辑区，允许越界（用边缘众数色填充）。

    与 :func:`crop_region` 的差异（孤海工作流语义）：

    * 扩展量 = ``短边 × (系数 - 1)``，上下左右可独立；
    * ``fills=True`` 先填掉遮罩内部空洞再算包围盒（移除场景）；
    * 窗口中心不动、尺寸向上取整到 ``multiple``，**越界不缩小**而是补色；
    * 裁切块按「长边」夹到 ``[min_side, max_side]``（孤海节点 8），小遮罩也放大到
      至少 768 长边，让模型有足够分辨率；贴回时 :func:`stitch_region` 会缩回原尺寸；
    * 空遮罩 → 整画布（不报错）。

    返回的 ``CropInfo.w/h`` 恒为 ``multiple`` 的倍数，因此 :func:`stitch_region`
    的补边量为 0；越界部分在贴回时被画布求交自动丢弃。
    """
    original = original_canvas.convert("RGBA")
    width, height = original.size
    full = CropInfo(0, 0, width, height, width, height)
    if mask_canvas is None:
        return original, full

    m = np.asarray(mask_canvas, dtype=np.float32)
    if m.ndim != 2:
        raise ValueError(f"遮罩必须是 (H, W)，收到 shape={m.shape}")
    if m.shape != (height, width):
        m = align.resize_mask(m, width, height)
    if fills:
        m = align.fill_mask_holes(m)
    ys, xs = np.nonzero(m > 0.1)
    if xs.size == 0:
        return original, full

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    short = max(1, min(x1 - x0, y1 - y0))
    top = max(0, min(int(short * (float(expand_top) - 1.0)), y0))
    bottom = max(0, min(int(short * (float(expand_bottom) - 1.0)), height - y1))
    left = max(0, min(int(short * (float(expand_left) - 1.0)), x0))
    right = max(0, min(int(short * (float(expand_right) - 1.0)), width - x1))

    # 最小裁剪窗：小遮罩不靠放大，而是以遮罩为中心把窗口扩到 min_window 见方，
    # 扩出来的是真实周边像素（越界部分由 crop_with_color_fill 用边缘众数色补）。
    min_window = max(0, int(min_window or 0))
    floor_hit = 0
    if min_window:
        x0e, x1e = x0 - left, x1 + right
        y0e, y1e = y0 - top, y1 + bottom
        nw, nh = x1e - x0e, y1e - y0e
        if nw < min_window or nh < min_window:
            nw = max(nw, min_window)
            nh = max(nh, min_window)
            cx0, cy0 = (x0e + x1e) // 2, (y0e + y1e) // 2
            x0e, y0e = cx0 - nw // 2, cy0 - nh // 2
            x1e, y1e = x0e + nw, y0e + nh
            left, right = x0 - x0e, x1e - x1
            top, bottom = y0 - y0e, y1e - y1
            floor_hit = min_window

    multiple = max(1, int(multiple))
    bw = _snap_up(x1 - x0 + left + right, multiple)
    bh = _snap_up(y1 - y0 + top + bottom, multiple)
    cx = (x0 - left + x1 + right) // 2
    cy = (y0 - top + y1 + bottom) // 2
    x, y = cx - bw // 2, cy - bh // 2

    crop = crop_with_color_fill(original, (x, y, x + bw, y + bh))
    long_side = max(bw, bh)
    scale = 1.0
    if max_side and long_side > int(max_side):
        scale = float(max_side) / float(long_side)
    elif min_side and long_side < int(min_side):
        scale = float(min_side) / float(long_side)
    model_w, model_h = int(bw), int(bh)
    if scale != 1.0:
        model_w = max(multiple, int(round(bw * scale / multiple)) * multiple)
        model_h = max(multiple, int(round(bh * scale / multiple)) * multiple)
        crop = crop.resize((model_w, model_h), Image.Resampling.LANCZOS)
    return crop, CropInfo(
        x=int(x), y=int(y), w=int(bw), h=int(bh),
        canvas_w=int(width), canvas_h=int(height),
        model_w=int(model_w), model_h=int(model_h),
        floor=int(floor_hit),
    )


def mask_hint_overlay(
    im: Image.Image,
    mask: np.ndarray,
    *,
    color: tuple[int, int, int] = (0, 200, 80),
    opacity: float = 0.4,
) -> Image.Image:
    """按遮罩把区域染成绿色提示（remove 任务约定），返回 RGBA 图。

    只改 RGB，alpha 保持原样；``opacity`` 是最大不透明度，遮罩内按遮罩值线性混合。
    """
    base = np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0
    m = np.asarray(mask, dtype=np.float32)
    if m.ndim == 3:
        m = m[..., 0]
    if m.shape != base.shape[:2]:
        m = align.resize_mask(m, base.shape[1], base.shape[0])
    a = np.clip(m, 0.0, 1.0)[..., None] * float(np.clip(opacity, 0.0, 1.0))
    tint = np.array(
        [color[0], color[1], color[2], 255], dtype=np.float32) / 255.0
    out = base * (1.0 - a) + tint * a
    out[..., 3] = base[..., 3]
    return Image.fromarray(np.rint(np.clip(out, 0.0, 1.0) * 255.0).astype(np.uint8), "RGBA")


def _crop_canvas_mask_for_region(
    mask_canvas: np.ndarray,
    crop: CropInfo,
    target_w: int,
    target_h: int,
    pad_l: int,
    pad_t: int,
) -> np.ndarray:
    """把遮罩对齐到"裁切画布"坐标系（``target_w x target_h``）。

    兼容两种传入方式（契约只规定传画布遮罩，这里额外容忍裁切画布遮罩）：

    * shape == ``(canvas_h, canvas_w)`` → 画布坐标遮罩，按 ``x - pad_l`` 映射；
    * shape == ``(target_h, target_w)`` → 已经是裁切画布遮罩，直接用；
    * 其他尺寸 → 双线性缩放到画布尺寸后按画布坐标处理。
    """
    m = np.asarray(mask_canvas, dtype=np.float32)
    if m.ndim != 2:
        raise ValueError(f"遮罩必须是 (H, W)，收到 shape={m.shape}")
    if m.shape == (int(crop.canvas_h), int(crop.canvas_w)):
        return _extract_region_zero(
            m, int(crop.x) - int(pad_l), int(crop.y) - int(pad_t), target_w, target_h
        )
    if m.shape == (int(target_h), int(target_w)):
        return np.clip(m, 0.0, 1.0)
    return _extract_region_zero(
        align.resize_mask(m, int(crop.canvas_w), int(crop.canvas_h)),
        int(crop.x) - int(pad_l), int(crop.y) - int(pad_t), target_w, target_h,
    )


def crop_mask_for_region(crop: CropInfo, mask_canvas: np.ndarray) -> np.ndarray:
    """按 :class:`CropInfo` 把画布遮罩切到「模型输入」坐标系（含补边/缩放）。"""
    cw, ch = int(crop.w), int(crop.h)
    target_w, target_h = align.snap_dims(cw, ch, SNAP)
    pad_l = (target_w - cw) // 2
    pad_t = (target_h - ch) // 2
    m = _crop_canvas_mask_for_region(
        mask_canvas, crop, target_w, target_h, pad_l, pad_t)
    model_w, model_h = crop.target_size()
    if (model_w, model_h) != (target_w, target_h):
        # 孤海节点 8：裁切块按长边夹到 [768, 2048] 后再送模型，遮罩跟着缩放
        m = align.resize_mask(m, model_w, model_h)
    return m


def stitch_region(
    original_canvas: Image.Image,
    edited_crop: Image.Image,
    crop: CropInfo,
    mask_canvas: np.ndarray | None,
    *,
    blend_pixels: int = 24,
    curve: str = "smoothstep",
    color_match: bool = True,
    color_strength: float = 0.85,
    anchor_match: bool = True,
    anchor_strength: float = 1.0,
    band_mode: str = "lowfreq",
    dither: bool = False,
    expand_pct: float = 0.0,
    feather_pct: float = 0.0,
    color_gain_clamp: tuple[float, float] | None = None,
    color_shift_abs: float | None = None,
    report: dict | None = None,
) -> Image.Image:
    """把解码后的裁切结果贴回原画布（带羽化/曲线/颜色匹配）。

    对应 ``PreciseAlignStitch.stitch``：

    1. 按 :func:`crop_region` 的补边规则（居中、32）反推 ``left/top``，裁掉补边拿到内容；
       若模型输出尺寸与裁切画布不同，按参考实现按比例映射窗口并缩放；
    2. ``mask_canvas`` 给出时用它当 alpha（含羽化带）；``mask_canvas=None`` 时用
       ``blend_pixels`` 做边缘线性 ramp（参考实现的"无 mask"分支）；
    3. 颜色（``color_match`` 开启时）：优先用**锚区**（原始硬遮罩外）估 gain/offset，
       不足才回退过渡带 Reinhard；
    4. ``band_mode="lowfreq"`` → 过渡带低频移植，``"alpha"`` → 纯羽化；
    5. 混合时只写 ``alpha > 0`` 的像素——**遮罩外逐像素保留原图**。

    返回原画布尺寸的 RGBA 图。
    """
    if curve not in ("smoothstep", "linear"):
        raise ValueError(f"未知 curve={curve!r}")
    original = original_canvas.convert("RGBA")
    width, height = original.size
    if (width, height) != (int(crop.canvas_w), int(crop.canvas_h)):
        raise ValueError(
            f"stitch_region: original_canvas {width}x{height} 与 CropInfo 记录的 "
            f"{int(crop.canvas_w)}x{int(crop.canvas_h)} 不一致"
        )

    x, y = int(crop.x), int(crop.y)
    cw, ch = int(crop.w), int(crop.h)
    target_w, target_h = align.snap_dims(cw, ch, SNAP)
    pad_l = (target_w - cw) // 2
    pad_t = (target_h - ch) // 2
    model_w, model_h = crop.target_size()

    edited = edited_crop.convert("RGBA")
    ew, eh = edited.size
    if (ew, eh) != (target_w, target_h):
        sx, sy = ew / float(target_w), eh / float(target_h)
        left = int(round(pad_l * sx))
        top = int(round(pad_t * sy))
        sw = max(1, int(round(cw * sx)))
        sh = max(1, int(round(ch * sy)))
    else:
        left, top, sw, sh = pad_l, pad_t, cw, ch
    left = max(0, min(left, max(0, ew - 1)))
    top = max(0, min(top, max(0, eh - 1)))
    sw = max(1, min(sw, ew - left))
    sh = max(1, min(sh, eh - top))

    content = edited.crop((left, top, left + sw, top + sh))
    if (sw, sh) != (cw, ch):
        content = content.resize((cw, ch), Image.Resampling.BICUBIC)

    # 裁切窗口可能越界（:func:`crop_region_factors` 用边缘众数色补齐）；贴回时
    # 只处理与画布的交集，越界处的合成像素直接丢弃，绝不写到画布外。
    ix0, iy0 = max(0, x), max(0, y)
    ix1, iy1 = min(width, x + cw), min(height, y + ch)
    if ix1 <= ix0 or iy1 <= iy0:
        return original
    dx, dy = ix0 - x, iy0 - y
    iw, ih = ix1 - ix0, iy1 - iy0
    clipped = (dx, dy, iw, ih) != (0, 0, cw, ch)
    if clipped:
        content = content.crop((dx, dy, dx + iw, dy + ih))

    original_u8 = _to_uint8(original, alpha=True)
    content_u8 = _to_uint8(content, alpha=True)
    content_f = content_u8.astype(np.float32) / 255.0
    region_u8 = original_u8[iy0:iy1, ix0:ix1]
    region_f = region_u8.astype(np.float32) / 255.0

    if mask_canvas is not None:
        win = _crop_canvas_mask_for_region(mask_canvas, crop, target_w, target_h, pad_l, pad_t)
        if (ew, eh) != (target_w, target_h):
            win = align.resize_mask(win, ew, eh)
        alpha = win[top: top + sh, left: left + sw]
        if (sw, sh) != (cw, ch):
            alpha = align.resize_mask(alpha, cw, ch)
        alpha = np.clip(alpha, 0.0, 1.0)

        # 零色差硬约束（与 composite 同一策略）：把 alpha 钳到"原始遮罩 > 0"的范围内。
        # 缩放/模型改尺寸时双线性会把遮罩 0/1 边界插值成小数，导致遮罩外的像素被
        # 混入微小编辑量；这里用最近邻取硬边界，保证遮罩外 alpha 严格为 0。
        canvas_mask_arr = np.asarray(mask_canvas, dtype=np.float32)
        if canvas_mask_arr.ndim != 2:
            raise ValueError(f"遮罩必须是 (H, W)，收到 shape={canvas_mask_arr.shape}")
        if canvas_mask_arr.shape != (height, width):
            canvas_mask_arr = align.resize_mask(canvas_mask_arr, width, height)
        hard = (canvas_mask_arr > 0.0).astype(np.float32)
        hard_win = _crop_canvas_mask_for_region(hard, crop, target_w, target_h, pad_l, pad_t)
        if (ew, eh) != (target_w, target_h):
            hard_win = _resize_mask_nearest(hard_win, ew, eh)
        hard_alpha = hard_win[top: top + sh, left: left + sw]
        if (sw, sh) != (cw, ch):
            hard_alpha = _resize_mask_nearest(hard_alpha, cw, ch)
        # 接缝（孤海 GH_CropRestore 语义）：先按「遮罩包围盒平均边长 × 百分比」向外
        # 膨胀，再做高斯羽化。只往内羽化会把模型重绘的背景在遮罩线处硬切，留下矩形
        # 台阶；向外扩 + 羽化后，模型自己重绘的那一圈背景才被平滑接回原图。
        expand_px = feather_px = 0
        if expand_pct > 0 or feather_pct > 0:
            ys, xs = np.nonzero(canvas_mask_arr > 0.0)
            if xs.size:
                avg_side = 0.5 * ((xs.max() - xs.min() + 1)
                                  + (ys.max() - ys.min() + 1))
                expand_px = max(0, int(avg_side * float(expand_pct) / 100.0))
                feather_px = max(0, int(avg_side * float(feather_pct) / 100.0))
                base = (hard_alpha > 0.5).astype(np.float32)
                grown = align.dilate_mask(base, expand_px) if expand_px else base
                alpha = align.feather_mask(grown, feather_px) if feather_px else grown
                # 数值兜底：膨胀 + 羽化支持之外严格不写（高斯核支持半径 = feather_px）
                guard = align.dilate_mask(base, expand_px + feather_px + 1)
                alpha = alpha * (guard > 0.0).astype(np.float32)
        if expand_px == 0 and feather_px == 0:
            # 兼容旧参数：只在硬遮罩内部羽化（mask 外严格 0）
            if int(blend_pixels) > 0:
                alpha = align.feather_mask(alpha, int(blend_pixels))
            alpha = alpha * (hard_alpha > 0.5).astype(np.float32)
        if report is not None:
            report["mask_band"] = {
                "expand_px": int(expand_px), "feather_px": int(feather_px),
                "expand_pct": float(expand_pct), "feather_pct": float(feather_pct),
            }
    else:
        hard_alpha = None
        alpha = np.ones((ch, cw), dtype=np.float32)
        bp = min(int(blend_pixels), cw // 2, ch // 2)
        if bp > 0:
            ramp = np.linspace(0.0, 1.0, bp + 2)[1:-1].astype(np.float32)
            ax = np.ones(cw, dtype=np.float32)
            ay = np.ones(ch, dtype=np.float32)
            ax[:bp] = ramp
            ax[-bp:] = ramp[::-1]
            ay[:bp] = ramp
            ay[-bp:] = ramp[::-1]
            alpha = np.outer(ay, ax).astype(np.float32)

    if clipped:
        alpha = alpha[dy: dy + ih, dx: dx + iw]
        if hard_alpha is not None:
            hard_alpha = hard_alpha[dy: dy + ih, dx: dx + iw]

    # 颜色：锚区（原始硬遮罩外）估 gain/offset，不足才回退 Reinhard（互斥）
    if band_mode not in ("alpha", "lowfreq"):
        raise ValueError(f"未知 band_mode={band_mode!r}")
    color_info = {"mode": "off", "band_mode": band_mode}
    anchor_ok = False
    if anchor_match and color_match:
        anchor_src = hard_alpha if hard_alpha is not None else np.ones_like(alpha)
        # 孤海「匹配裁剪颜色」的安全边界：gain 0.9~1.1、offset ±24 级，避免把
        # 真实的物体颜色差当成漂移放大。None 表示沿用 anchor_affine 的默认夹取。
        affine_kwargs = {}
        if color_gain_clamp is not None:
            affine_kwargs["scale_clamp"] = color_gain_clamp
        if color_shift_abs is not None:
            affine_kwargs["shift_abs"] = float(color_shift_abs)
        scale, shift, skipped = align.anchor_affine(
            region_f, content_f, anchor_src, strength=float(anchor_strength),
            **affine_kwargs,
        )
        color_info["anchor_ratio"] = float((anchor_src <= 0.0).mean())
        color_info["skipped"] = bool(skipped)
        if not skipped:
            corrected = np.clip(
                content_f[..., :3] * scale + shift, 0.0, 1.0
            ).astype(np.float32)
            content_f = content_f.copy()
            content_f[..., :3] = corrected
            anchor_ok = True
            color_info.update(
                mode="anchor_affine",
                scale=[round(float(v), 6) for v in scale],
                offset=[round(float(v), 6) for v in shift],
            )
    if color_match and not anchor_ok:
        band = align.band_from_mask(alpha, fallback_px=max(8, int(blend_pixels)))
        if band is not None and float(band.sum()) > 0:
            matched = align.reinhard_match(content_f, region_f, band, float(color_strength))
            content_f = matched.astype(np.float32)
            color_info["mode"] = "reinhard"

    # 过渡带低频移植（alpha 0/1 处严格不变，只动中间带）
    if band_mode == "lowfreq":
        band_sel = (alpha > 0.0) & (alpha < 1.0)
        if bool(band_sel.any()):
            merged = align.lowfreq_merge(region_f, content_f, alpha)
            content_f = content_f.copy()
            content_f[..., :3] = merged

    # 小改动压回原图：模型"顺手重绘"整块背景会带来 1~8 级偏色/噪点，在纯渐变、
    # 纯色墙这类干净背景上会拼出一个可见矩形（真机回归的「像素块」）。
    content_f = _suppress_small_changes(content_f, region_f)

    alpha = align.curve_mask(alpha, curve)

    out = original_u8.copy()
    view = out[iy0:iy1, ix0:ix1]
    selected = alpha > 0.0
    if bool(selected.any()):
        a = alpha[selected][:, None]
        blended = region_f[selected] * (1.0 - a) + content_f[selected] * a
        if dither:
            blended[:, :3] = align.ign_dither(blended[:, :3], a, amount=1.0 / 255.0)
        view[selected] = np.rint(np.clip(blended, 0.0, 1.0) * 255.0).astype(np.uint8)
    if report is not None:
        report.update(color_info)
    return Image.fromarray(out, "RGBA")


# ---------------------------------------------------------------------------
# 验收工具
# ---------------------------------------------------------------------------


def compare(a: Image.Image, b: Image.Image) -> dict:
    """比较两张图的像素差，供"零偏移 / 零色差"验收使用。

    返回 ``{"size_equal": bool, "max_abs": int, "mean_abs": float, "identical": bool}``：

    * 尺寸不同时视为完全不同（``max_abs=255``、``mean_abs=255.0``、``identical=False``）；
    * 尺寸相同时按 RGBA 8bit 逐字节比较（alpha 也算），因此遮罩外
      "``max_abs == 0``"等价于字节级相同。
    """
    if a.size != b.size:
        return {"size_equal": False, "max_abs": 255, "mean_abs": 255.0, "identical": False}
    arr_a = _to_uint8(a.convert("RGBA"), alpha=True).astype(np.int16)
    arr_b = _to_uint8(b.convert("RGBA"), alpha=True).astype(np.int16)
    diff = np.abs(arr_a - arr_b)
    max_abs = int(diff.max()) if diff.size else 0
    mean_abs = float(diff.mean()) if diff.size else 0.0
    return {
        "size_equal": True,
        "max_abs": max_abs,
        "mean_abs": mean_abs,
        "identical": max_abs == 0,
    }
