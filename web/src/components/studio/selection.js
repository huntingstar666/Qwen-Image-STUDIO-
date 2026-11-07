/**
 * 选区内核（D8.1）。
 *
 * 数据结构统一为「alpha 蒙版」：`Uint8ClampedArray`，长度 = width × height，
 * 每个元素 0~255（0 = 未选中，255 = 选中）。所有算法都是纯函数，方便 Node 单测；
 * 只有 `alphaToCanvas / canvasToAlpha / buildOutlinePath` 依赖浏览器 API。
 *
 * 与 studioDoc 的分工：
 * - 选区是「临时状态」，不进撤销栈、不参与导出；
 * - 选区坐标与 doc.mask 一致（旋转后、未裁剪的画布空间）；
 * - 画笔/形状写入蒙版时，按选区 alpha 裁剪。
 */

export const SELECT_THRESHOLD = 128;

export function createAlpha(width, height) {
  const w = Math.max(0, Math.round(width) || 0);
  const h = Math.max(0, Math.round(height) || 0);
  return new Uint8ClampedArray(w * h);
}

function clipRect(rect, width, height) {
  const x = Math.max(0, Math.floor(rect?.x || 0));
  const y = Math.max(0, Math.floor(rect?.y || 0));
  const right = Math.min(width, Math.ceil((rect?.x || 0) + (rect?.width || 0)));
  const bottom = Math.min(height, Math.ceil((rect?.y || 0) + (rect?.height || 0)));
  return { x, y, right, bottom, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** 矩形选区。 */
export function rectAlpha(width, height, rect) {
  const alpha = createAlpha(width, height);
  const box = clipRect(rect, width, height);
  if (!box.width || !box.height) return alpha;
  for (let y = box.y; y < box.bottom; y += 1) {
    const row = y * width;
    alpha.fill(255, row + box.x, row + box.right);
  }
  return alpha;
}

/** 椭圆选区（内切于 rect）。 */
export function ellipseAlpha(width, height, rect) {
  const alpha = createAlpha(width, height);
  const box = clipRect(rect, width, height);
  if (!box.width || !box.height) return alpha;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2;
  const ry = box.height / 2;
  for (let y = box.y; y < box.bottom; y += 1) {
    const dy = (y + 0.5 - cy) / ry;
    const span = 1 - dy * dy;
    if (span <= 0) continue;
    const half = Math.sqrt(span) * rx;
    const x0 = Math.max(box.x, Math.ceil(cx - half - 0.5));
    const x1 = Math.min(box.right, Math.floor(cx + half - 0.5) + 1);
    if (x1 > x0) alpha.fill(255, y * width + x0, y * width + x1);
  }
  return alpha;
}

/** 套索（自由多边形），奇偶规则扫描线填充。 */
export function lassoAlpha(width, height, points) {
  const alpha = createAlpha(width, height);
  const list = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (list.length < 3) return alpha;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of list) {
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y += 1) {
    const scan = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const b = list[(i + 1) % list.length];
      if (a.y === b.y) continue;
      const lower = Math.min(a.y, b.y);
      const upper = Math.max(a.y, b.y);
      if (scan < lower || scan >= upper) continue;
      xs.push(a.x + ((scan - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * width;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(width, Math.floor(xs[i + 1] - 0.5) + 1);
      if (xb > xa) alpha.fill(255, row + xa, row + xb);
    }
  }
  return alpha;
}

/**
 * 魔棒：把与落点颜色接近的像素写入 alpha。
 * @param {Uint8ClampedArray} pixels 图像 RGBA 数据（ImageData.data）
 * @param {number} x 落点（图像像素坐标）
 * @param {number} y
 * @param {{tolerance?:number, contiguous?:boolean}} [options]
 *        tolerance 0~255，按 RGB 三通道最大差判定；contiguous=false 时全图取样。
 */
export function wandAlpha(pixels, width, height, x, y, options = {}) {
  const alpha = createAlpha(width, height);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (!pixels || sx < 0 || sy < 0 || sx >= width || sy >= height) return alpha;
  const tolerance = Math.max(0, Math.min(255, Number(options.tolerance) || 0));
  const seed = (sy * width + sx) * 4;
  const sr = pixels[seed];
  const sg = pixels[seed + 1];
  const sb = pixels[seed + 2];
  const match = (index) =>
    Math.abs(pixels[index] - sr) <= tolerance &&
    Math.abs(pixels[index + 1] - sg) <= tolerance &&
    Math.abs(pixels[index + 2] - sb) <= tolerance;

  if (options.contiguous === false) {
    for (let i = 0, p = 0; i < alpha.length; i += 1, p += 4) {
      if (match(p)) alpha[i] = 255;
    }
    return alpha;
  }

  const total = width * height;
  const stack = new Int32Array(total);
  let top = 0;
  const start = sy * width + sx;
  alpha[start] = 255;
  stack[top++] = start;
  while (top > 0) {
    const point = stack[--top];
    const px = point % width;
    const py = (point - px) / width;
    if (px > 0) {
      const q = point - 1;
      if (!alpha[q] && match(q * 4)) {
        alpha[q] = 255;
        stack[top++] = q;
      }
    }
    if (px < width - 1) {
      const q = point + 1;
      if (!alpha[q] && match(q * 4)) {
        alpha[q] = 255;
        stack[top++] = q;
      }
    }
    if (py > 0) {
      const q = point - width;
      if (!alpha[q] && match(q * 4)) {
        alpha[q] = 255;
        stack[top++] = q;
      }
    }
    if (py < height - 1) {
      const q = point + width;
      if (!alpha[q] && match(q * 4)) {
        alpha[q] = 255;
        stack[top++] = q;
      }
    }
  }
  return alpha;
}

/**
 * 选区运算：new（替换）/ add（并集）/ sub（差集）/ intersect（交集）。
 * @returns {Uint8ClampedArray} 新数组，不修改入参
 */
export function combineAlpha(base, next, mode = 'new') {
  if (!base || mode === 'new') return new Uint8ClampedArray(next);
  const out = new Uint8ClampedArray(base.length);
  for (let i = 0; i < out.length; i += 1) {
    const a = base[i];
    const b = next[i];
    if (mode === 'add') out[i] = Math.max(a, b);
    else if (mode === 'sub') out[i] = Math.max(0, a - b);
    else if (mode === 'intersect') out[i] = Math.min(a, b);
    else out[i] = b;
  }
  return out;
}

/** 反选；传入 bounds 时只在该矩形内取反，矩形外清空（裁剪后反选不越界）。 */
export function invertAlpha(alpha, width, height, bounds = null) {
  const out = new Uint8ClampedArray(alpha.length);
  if (!bounds) {
    for (let i = 0; i < out.length; i += 1) out[i] = 255 - alpha[i];
    return out;
  }
  const box = clipRect(bounds, width, height);
  for (let y = box.y; y < box.bottom; y += 1) {
    const row = y * width;
    for (let x = box.x; x < box.right; x += 1) {
      out[row + x] = 255 - alpha[row + x];
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 形态学 / 羽化 */

function blurPass(src, dst, tmp, prefix, width, height, radius) {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + src[row + x];
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      tmp[row + x] = (prefix[x1 + 1] - prefix[x0]) / (x1 - x0 + 1);
    }
  }
  for (let x = 0; x < width; x += 1) {
    prefix[0] = 0;
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y] + tmp[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      dst[y * width + x] = (prefix[y1 + 1] - prefix[y0]) / (y1 - y0 + 1);
    }
  }
}

/** 羽化：三次盒式模糊近似高斯，O(n)，radius 为像素半径。 */
export function featherAlpha(alpha, width, height, radius) {
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (!r) return new Uint8ClampedArray(alpha);
  const n = width * height;
  let a = new Float32Array(n);
  for (let i = 0; i < n; i += 1) a[i] = alpha[i];
  let b = new Float32Array(n);
  const tmp = new Float32Array(n);
  const prefix = new Float32Array(Math.max(width, height) + 1);
  for (let pass = 0; pass < 3; pass += 1) {
    blurPass(a, b, tmp, prefix, width, height, r);
    const swap = a;
    a = b;
    b = swap;
  }
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 1) out[i] = a[i];
  return out;
}

function morphAlpha(alpha, width, height, radius, mode) {
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (!r) return new Uint8ClampedArray(alpha);
  const n = width * height;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) bin[i] = alpha[i] >= SELECT_THRESHOLD ? 1 : 0;
  const tmp = new Uint8Array(n);
  const prefix = new Int32Array(Math.max(width, height) + 2);
  const keep = (count, length) => (mode === 'expand' ? count > 0 : count === length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    prefix[0] = 0;
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + bin[row + x];
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      const count = prefix[x1 + 1] - prefix[x0];
      tmp[row + x] = keep(count, x1 - x0 + 1) ? 1 : 0;
    }
  }
  const out = new Uint8ClampedArray(n);
  for (let x = 0; x < width; x += 1) {
    prefix[0] = 0;
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y] + tmp[y * width + x];
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      const count = prefix[y1 + 1] - prefix[y0];
      out[y * width + x] = keep(count, y1 - y0 + 1) ? 255 : 0;
    }
  }
  return out;
}

/** 扩展（膨胀）。 */
export function expandAlpha(alpha, width, height, radius) {
  return morphAlpha(alpha, width, height, radius, 'expand');
}

/** 收缩（腐蚀）。 */
export function contractAlpha(alpha, width, height, radius) {
  return morphAlpha(alpha, width, height, radius, 'contract');
}

/* ---------------------------------------------------------------- 统计 */

export function coverageAlpha(alpha) {
  if (!alpha?.length) return 0;
  let hit = 0;
  for (let i = 0; i < alpha.length; i += 1) {
    if (alpha[i] >= SELECT_THRESHOLD) hit += 1;
  }
  return hit / alpha.length;
}

export function boundsAlpha(alpha, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (alpha[row + x] < SELECT_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/* ---------------------------------------------------------------- 浏览器辅助 */

/** alpha → 白色画布（alpha 通道即选区），选区裁剪画笔时直接 drawImage 使用。 */
export function alphaToCanvas(alpha, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  const count = Math.min(alpha.length, canvas.width * canvas.height);
  for (let i = 0, p = 0; i < count; i += 1, p += 4) {
    data[p] = 255;
    data[p + 1] = 255;
    data[p + 2] = 255;
    data[p + 3] = alpha[i];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** 画布 alpha → 选区数组（用于从工程/图层蒙版反推选区）。 */
export function canvasToAlpha(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 3; i < alpha.length; i += 1, p += 4) alpha[i] = data[p];
  return alpha;
}

/**
 * 蚂蚁线路径：按 step 采样单元格，只连出「选中 ↔ 未选中」的边。
 * 大图或碎片化选区会自动加大 step，保证线段数可控（默认上限 6000）。
 */
export function buildOutlinePath(alpha, width, height, step = 1, maxSegments = 6000) {
  if (typeof Path2D === 'undefined') return null;
  let s = Math.max(1, Math.round(step));
  const limit = Math.max(width, height);
  const gridSize = () => ({ gw: Math.ceil(width / s), gh: Math.ceil(height / s) });
  const sampler = (gw, gh) => (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return false;
    const px = Math.min(width - 1, gx * s + Math.floor(s / 2));
    const py = Math.min(height - 1, gy * s + Math.floor(s / 2));
    return alpha[py * width + px] >= SELECT_THRESHOLD;
  };

  // 先估算线段数，超限就降采样（避免 4K 噪声选区每帧描几万条线）。
  let gw;
  let gh;
  let sample;
  for (;;) {
    ({ gw, gh } = gridSize());
    sample = sampler(gw, gh);
    let count = 0;
    for (let gy = 0; gy < gh && count <= maxSegments; gy += 1) {
      for (let gx = 0; gx < gw && count <= maxSegments; gx += 1) {
        if (!sample(gx, gy)) continue;
        if (!sample(gx, gy - 1)) count += 1;
        if (!sample(gx, gy + 1)) count += 1;
        if (!sample(gx - 1, gy)) count += 1;
        if (!sample(gx + 1, gy)) count += 1;
      }
    }
    if (count <= maxSegments || s >= limit) break;
    s *= 2;
  }

  const path = new Path2D();
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      if (!sample(gx, gy)) continue;
      const x0 = gx * s;
      const x1 = Math.min(width, x0 + s);
      const y0 = gy * s;
      const y1 = Math.min(height, y0 + s);
      if (!sample(gx, gy - 1)) {
        path.moveTo(x0, y0);
        path.lineTo(x1, y0);
      }
      if (!sample(gx, gy + 1)) {
        path.moveTo(x0, y1);
        path.lineTo(x1, y1);
      }
      if (!sample(gx - 1, gy)) {
        path.moveTo(x0, y0);
        path.lineTo(x0, y1);
      }
      if (!sample(gx + 1, gy)) {
        path.moveTo(x1, y0);
        path.lineTo(x1, y1);
      }
    }
  }
  return path;
}
