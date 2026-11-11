"""固定背景 + 主体透明层：键控抠图、背景板重建、合成。

成长叙事每帧都是整幅重绘，模型会把干净的米白背景重画成一层泥点/布纹，
再靠"清理背景"的编辑去修补，既慢又不稳。这里换成图层思路：

1. 参考图 → 用四周边缘拟合一张**固定背景板**（纯纸背景，不含主体）；
2. 参考图 → 让模型把背景换成纯品红色，得到"键控参考帧"；
3. 每帧只让模型在品红背景上画主体，本地按键色抠出 alpha（主体的透明通道图）；
4. 主体层叠到固定背景板上，背景逐帧完全一致。
"""
from __future__ import annotations

import re
from collections import deque
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

DEFAULT_KEY = (255, 0, 255)

CORRECTIONS = {
    "key_lost": ("背景必须整张铺满纯品红色 #FF00FF 的纯色色块：不要天空、云、地平线、"
                 "渐变、阴影、纹理、颗粒或场景，主体完整地画在画面中间，不要被裁掉"),
}

#: 键控背景的固定措辞（分镜提示词里统一用它）。
KEY_CLAUSE = ("背景保持纯品红色 #FF00FF 的纯色色块：不要天空、云、地平线、渐变、阴影、"
              "纹理、颗粒或噪点，也不要画任何其他物体")

#: 需要被替换成键控背景的旧措辞（按长度从长到短匹配）。
_BG_PATTERNS = (
    "纯净无纹理的米白色无缝背景纸",
    "纯净无纹理的米白色背景",
    "米白色纯净无纹理背景",
    "米白色无缝背景纸",
    "米白色的无缝背景纸",
    "米白色背景",
    "纯净背景",
)


def to_key_prompt(edit: str) -> str:
    """把分镜里的"米白背景/天空"统一改写成品红键控背景。"""
    text = str(edit or "")
    for pattern in _BG_PATTERNS:
        text = text.replace(pattern, "纯品红色 #FF00FF 的纯色背景")
    # 分镜里出现"天空转蓝/起雾"这类背景元素时直接删掉整个短句：
    # 键控模式下背景必须是纯品红，不能有任何天空。
    text = re.sub(r"[，；。]?[^，；。]*天空[^，；。]*", "", text)
    text = text.replace("，，", "，").replace("；；", "；").strip("，；")
    if "品红" not in text:
        # 放最前面：模型对句首约束的遵循度明显更高，放末尾经常被忽略。
        text = f"{KEY_CLAUSE}；{text}"
    else:
        text = f"{text}；{KEY_CLAUSE}"
    return text


def _ring_mask(width: int, height: int, ring: float = 0.12) -> np.ndarray:
    """取顶部与左右两侧上部做"已知背景"采样区。

    跳过底部（泥土堆、地台），左右两侧也只取上部——19:9 的山景地台会一直延伸到
    画面左右边缘，整条侧边采样会把地台颜色当成背景。
    """
    margin_x = max(4, int(width * ring))
    margin_y = max(4, int(height * ring))
    yy, xx = np.mgrid[0:height, 0:width]
    top = yy < margin_y
    side = ((xx < margin_x) | (xx >= width - margin_x)) & (yy < int(height * 0.65))
    return top | side


def background_plate(image: Image.Image, ring: float = 0.12) -> Image.Image:
    """用四周边缘拟合一张平滑背景板（二次曲面），主体区域由拟合结果外推填充。"""
    array = np.asarray(image.convert("RGB"), dtype=np.float64)
    height, width = array.shape[:2]
    known = _ring_mask(width, height, ring)
    yy, xx = np.mgrid[0:height, 0:width]
    xs = (xx / max(1, width - 1)) * 2.0 - 1.0
    ys = (yy / max(1, height - 1)) * 2.0 - 1.0
    terms = np.stack([np.ones_like(xs), xs, ys, xs * xs, ys * ys, xs * ys], axis=-1)
    samples = terms[known]
    plate = np.zeros_like(array)
    for channel in range(3):
        values = array[known][:, channel]
        # 采样点太多没有必要，均匀抽稀，拟合结果几乎不变。
        step = max(1, len(values) // 20000)
        coef, *_ = np.linalg.lstsq(samples[::step], values[::step], rcond=None)
        plate[:, :, channel] = terms @ coef
    return Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8), "RGB")


def estimate_key(image: Image.Image, margin: float = 0.08) -> tuple[int, int, int]:
    """从画面三个角的中位数估计实际键色（模型很少给到绝对纯 #FF00FF）。"""
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    height, width = array.shape[:2]
    m = max(4, int(min(width, height) * margin))
    patches = [
        array[:m, :m], array[:m, -m:], array[-m:, -m:],
        array[:m, width // 3: width // 3 * 2],
    ]
    pixels = np.concatenate([p.reshape(-1, 3) for p in patches], axis=0)
    median = np.median(pixels, axis=0)
    return tuple(int(v) for v in median)


def _largest_component(mask: np.ndarray, size: int = 96) -> np.ndarray:
    """在缩略网格上取最大连通域，再放大回原尺寸（避免依赖 scipy）。"""
    height, width = mask.shape
    small = Image.fromarray((mask * 255).astype(np.uint8), "L").resize(
        (size, size), Image.Resampling.BILINEAR)
    grid = np.asarray(small) > 96
    visited = np.zeros_like(grid, dtype=bool)
    best: list[tuple[int, int]] = []
    for sy in range(size):
        for sx in range(size):
            if not grid[sy, sx] or visited[sy, sx]:
                continue
            queue = deque([(sy, sx)])
            visited[sy, sx] = True
            cells: list[tuple[int, int]] = []
            while queue:
                cy, cx = queue.popleft()
                cells.append((cy, cx))
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < size and 0 <= nx < size and grid[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        queue.append((ny, nx))
            if len(cells) > len(best):
                best = cells
    if not best:
        return mask
    keep = np.zeros((size, size), dtype=np.uint8)
    rows = np.array([cell[0] for cell in best])
    cols = np.array([cell[1] for cell in best])
    keep[rows, cols] = 255
    upscaled = Image.fromarray(keep, "L").resize((width, height), Image.Resampling.BILINEAR)
    allowed = np.asarray(upscaled) > 64
    return (mask & allowed).astype(mask.dtype)


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    """从边缘泛洪，没被泛洪到的背景空洞填成主体（例如树冠间隙）。"""
    height, width = mask.shape
    empty = ~mask
    visited = np.zeros_like(empty, dtype=bool)
    queue = deque()
    for x in range(width):
        for y in (0, height - 1):
            if empty[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if empty[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < height and 0 <= nx < width and empty[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))
    return mask | (empty & ~visited)


def _despill(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """去掉品红溢色，只作用于"真品红"和半透明边缘。

    判据必须带 `green < 90`：浅粉花（如 255,178,203）同样满足 R、B > G，
    没有这个限制会把花瓣压成灰色——实测开花帧整圈花都变灰。
    """
    out = rgb.astype(np.float32).copy()
    red, green, blue = out[..., 0], out[..., 1], out[..., 2]
    spill = ((green < 90) & (red - green > 8) & (blue - green > 8)
             & (alpha < 0.99))
    limit = green + 8.0
    out[..., 0] = np.where(spill, np.minimum(red, limit), red)
    out[..., 2] = np.where(spill, np.minimum(blue, limit), blue)
    return np.clip(out, 0, 255)


def key_subject(image: Image.Image, key: tuple[int, int, int] | None = None,
                low: float = 42.0, high: float = 96.0) -> tuple[Image.Image, dict[str, Any]]:
    """按键色抠出主体，返回 RGBA 主体层与统计信息。"""
    array = np.asarray(image.convert("RGB"), dtype=np.float32)

    def _alpha_for(candidate: tuple[int, int, int]) -> tuple[np.ndarray, float]:
        dist = np.sqrt(((array - np.array(candidate, dtype=np.float32)) ** 2).sum(axis=2))
        near = (dist < low).astype(np.float32)
        return near, float(near.mean())

    # 模型每帧给的品红并不完全一致（实测 205,0,176 与 255,0,255 都出现过），
    # 所以在"参考帧键色"和"本帧角点估计"里挑覆盖率高的一支。
    candidates = [tuple(key)] if key else []
    candidates.append(estimate_key(image))
    best_key, near_key, key_coverage = candidates[0], None, -1.0
    for candidate in candidates:
        near, coverage = _alpha_for(candidate)
        if coverage > key_coverage:
            best_key, near_key, key_coverage = candidate, near, coverage

    distance = np.sqrt(((array - np.array(best_key, dtype=np.float32)) ** 2).sum(axis=2))
    alpha = np.clip((distance - low) / max(1e-6, high - low), 0.0, 1.0)

    hard = alpha > 0.5
    # 模型偶尔会在主体周围补一层淡灰紫底（实测开花帧），色相离品红很远、抠图会
    # 误当主体。判据：低饱和 + 较亮 + 绿色通道不低（排除暗色泥土）。
    # 主体内部的白色高光会被后面的填洞步骤补回来。
    luminance = array.mean(axis=2)
    saturation = array.max(axis=2) - array.min(axis=2)
    washed = (saturation < 60) & (luminance > 150) & (array[..., 1] > 80)
    hard = hard & ~washed
    hard = _largest_component(hard)
    hard = _fill_holes(hard)
    # 形态学开运算去孤点 + 闭运算补裂缝，都用最小/最大值滤波近似。
    mask = Image.fromarray((hard * 255).astype(np.uint8), "L")
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    # 内缩 1px：抠出来的最外圈一定混了键色（粉边），宁可少一圈也不要紫边。
    mask = mask.filter(ImageFilter.MinFilter(3))
    mask = mask.filter(ImageFilter.GaussianBlur(0.9))
    alpha = np.asarray(mask, dtype=np.float32) / 255.0
    # 键色区域强制全透明，避免半透明底噪。
    alpha = np.where(near_key > 0.5, 0.0, alpha)
    subject_coverage = float((alpha > 0.05).mean())

    rgb = _despill(array, alpha)
    rgba = np.dstack([rgb, alpha * 255.0]).astype(np.uint8)
    subject = Image.fromarray(rgba, "RGBA")
    return subject, {
        "key": [int(v) for v in best_key],
        "key_coverage": round(key_coverage, 4),
        "subject_coverage": round(subject_coverage, 4),
    }


def composite(plate: Image.Image, subject: Image.Image, *, shadow: float = 0.28) -> Image.Image:
    """把主体层叠到固定背景板上；alpha 再做一次模糊当接地阴影，避免悬浮感。"""
    base = plate.convert("RGBA")
    if shadow > 0:
        alpha = subject.getchannel("A")
        soft = alpha.filter(ImageFilter.GaussianBlur(6))
        offset = Image.new("L", soft.size, 0)
        offset.paste(soft, (0, 4))
        shade = offset.point(lambda value: int(value * shadow))
        dark = Image.new("RGBA", base.size, (28, 22, 18, 255))
        base = Image.composite(dark, base, shade)
    return Image.alpha_composite(base, subject).convert("RGB")


def extract(image: Image.Image, plate: Image.Image,
            key: tuple[int, int, int] | None = None) -> tuple[Image.Image, Image.Image, dict[str, Any]]:
    subject, stats = key_subject(image, key)
    frame = composite(plate, subject)
    return subject, frame, stats
