"""图像解码/编码：与主项目 ``server/imaging.py`` 的口径保持一致。

* 解码做 EXIF 纠正 → ICC→sRGB（有 profile 才转）→ 统一 RGBA；
* PNG 输出剥离 ICC，统一 sRGB 8bit，alpha 原样保留；
* 所有几何操作只做整数裁剪/粘贴，缩放必须显式调用。
"""
from __future__ import annotations

import io
from typing import Any

from PIL import Image, ImageCms

try:  # Pillow 10+ 推荐用 Resampling 枚举
    LANCZOS = Image.Resampling.LANCZOS
    BICUBIC = Image.Resampling.BICUBIC
except AttributeError:  # pragma: no cover - 老版本兜底
    LANCZOS = Image.LANCZOS  # type: ignore[attr-defined]
    BICUBIC = Image.BICUBIC  # type: ignore[attr-defined]


def decode_image(data: bytes, *, keep_alpha: bool = True) -> Image.Image:
    """解码为 sRGB。``keep_alpha`` 为真时统一 RGBA，否则铺白底转 RGB。"""
    if not data:
        raise ValueError("图片数据为空")
    with Image.open(io.BytesIO(data)) as opened:
        opened.load()
        image = opened.copy()

    image = _apply_exif(image)
    image = _apply_icc(image)

    if keep_alpha:
        if image.mode not in ("RGBA", "LA"):
            if "transparency" in image.info:
                image = image.convert("RGBA")
            else:
                image = image.convert("RGBA")
        elif image.mode == "LA":
            image = image.convert("RGBA")
        return image

    if image.mode == "RGBA":
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        image = background
    return image.convert("RGB")


def _apply_exif(image: Image.Image) -> Image.Image:
    try:
        from PIL import ImageOps

        return ImageOps.exif_transpose(image)
    except Exception:  # noqa: BLE001 - 缺 exif 不影响
        return image


def _apply_icc(image: Image.Image) -> Image.Image:
    profile = image.info.get("icc_profile")
    if not profile:
        return image
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        target = ImageCms.createProfile("sRGB")
        converted = ImageCms.profileToProfile(
            image, source, target, outputMode="RGBA" if image.mode == "RGBA" else "RGB"
        )
        return converted
    except Exception:  # noqa: BLE001 - 色彩配置坏掉时保持原样，绝不隐式改色
        return image


def encode_png(image: Image.Image, *, compress_level: int = 6) -> bytes:
    buffer = io.BytesIO()
    out = image
    if out.mode not in ("RGB", "RGBA", "P"):
        out = out.convert("RGBA" if "A" in out.getbands() else "RGB")
    out.save(buffer, format="PNG", compress_level=int(compress_level), optimize=False)
    return buffer.getvalue()


def probe(data: bytes) -> dict[str, Any]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return {
                "width": int(image.width),
                "height": int(image.height),
                "mode": image.mode,
                "has_alpha": image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info,
                "format": (image.format or "").lower(),
            }
    except Exception:  # noqa: BLE001
        return {"width": 0, "height": 0, "mode": "", "has_alpha": False, "format": ""}


def ensure_rgba(image: Image.Image) -> Image.Image:
    if image.mode == "RGBA":
        return image
    if image.mode == "LA":
        return image.convert("RGBA")
    if image.mode == "P" and "transparency" in image.info:
        return image.convert("RGBA")
    return image.convert("RGBA")


def resize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    """显式缩放。只在用户开启缩放/画布适配时调用；默认零偏移路径不会走到这里。"""
    if image.size == size:
        return image
    return image.resize(size, LANCZOS)


def pad_to_multiple(image: Image.Image, multiple: int = 2,
                    *, anchor: str = "center") -> Image.Image:
    """把画布补到 ``multiple`` 的整数倍（透明补边），坐标保持整数。"""
    multiple = max(1, int(multiple))
    width = int((image.width + multiple - 1) // multiple * multiple)
    height = int((image.height + multiple - 1) // multiple * multiple)
    if (width, height) == image.size:
        return image
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    left = (width - image.width) // 2
    top = _anchor_top(image.height, height, anchor)
    canvas.alpha_composite(image, (left, top))
    return canvas


def _anchor_top(source_h: int, target_h: int, anchor: str) -> int:
    if anchor == "top":
        return 0
    if anchor == "bottom":
        return target_h - source_h
    return (target_h - source_h) // 2


def fit_into(image: Image.Image, size: tuple[int, int], *, fit: str = "contain",
             anchor: str = "center") -> tuple[Image.Image, dict[str, Any]]:
    """把图像放进目标画布，返回 (图像, 几何信息)。

    ``contain`` 只在必要时等比缩放；如果原图已经等于目标尺寸，则**不做任何重采样**。
    ``cover`` 先等比放大再整数裁剪；``stretch`` 强制拉伸；``none`` 保持原尺寸。
    """
    target_w, target_h = int(size[0]), int(size[1])
    if min(target_w, target_h) < 1:
        raise ValueError("目标画布尺寸非法")
    info: dict[str, Any] = {
        "fit": fit,
        "source": [image.width, image.height],
        "target": [target_w, target_h],
        "resampled": False,
        "offset": [0, 0],
    }
    if fit == "none":
        info["target"] = [image.width, image.height]
        return image, info

    if image.size == (target_w, target_h) and fit in ("contain", "cover"):
        # 尺寸已经一致：直接返回原图，保证逐字节不变（不做 alpha 预乘往返）
        return image, info

    if fit == "stretch":
        resized = resize(image, (target_w, target_h))
        info["resampled"] = resized.size != image.size
        return resized, info

    scale = (max(target_w / image.width, target_h / image.height)
             if fit == "cover"
             else min(target_w / image.width, target_h / image.height))
    scaled_w = max(1, int(round(image.width * scale)))
    scaled_h = max(1, int(round(image.height * scale)))
    resized = image if (scaled_w, scaled_h) == image.size else image.resize((scaled_w, scaled_h), LANCZOS)
    info["resampled"] = resized.size != image.size

    if fit == "cover":
        left = max(0, (scaled_w - target_w) // 2)
        top = max(0, (scaled_h - target_h) // 2)
        cropped = resized.crop((left, top, left + target_w, top + target_h))
        info["offset"] = [-left, -top]
        return cropped, info

    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    left = (target_w - scaled_w) // 2
    top = _anchor_top(scaled_h, target_h, anchor)
    canvas.alpha_composite(resized, (left, top))
    info["offset"] = [left, top]
    return canvas, info


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    if image.mode != "RGBA":
        return (0, 0, image.width, image.height)
    return image.getchannel("A").getbbox()
