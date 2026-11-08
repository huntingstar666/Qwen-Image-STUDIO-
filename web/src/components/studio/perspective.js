/**
 * 透视变换（D13.3）：四角映射 + 反向采样。
 *
 * 纯数学部分（`quadHomography` / `invert3x3` / `projectPoint` / `pointInQuad`）可直接单测；
 * `warpImageToQuad` 负责把图片按四角做反向采样并返回离屏结果，调用方（OverlayLayer）
 * 负责按四角变化做缓存，避免每帧逐像素计算。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 由四角求「单位正方形 → 四边形」的 3×3 单应矩阵。
 * 四角顺序固定为 (0,0)、(1,0)、(1,1)、(0,1)。
 * @param {Array<{x:number,y:number}>} quad
 * @returns {number[]|null} [a,b,c,d,e,f,g,h,1]，退化四边形返回 null
 */
export function quadHomography(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  const [p0, p1, p2, p3] = quad;
  // 面积为 0 的退化四边形直接拒绝，避免后续归一化出 NaN。
  const area = Math.abs(
    (p0.x * p1.y - p1.x * p0.y) +
      (p1.x * p2.y - p2.x * p1.y) +
      (p2.x * p3.y - p3.x * p2.y) +
      (p3.x * p0.y - p0.x * p3.y),
  ) / 2;
  if (area < 1e-6) return null;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a;
  let b;
  let c;
  let d;
  let e;
  let f;
  let g;
  let h;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // 平行四边形：仿射即可。
    a = p1.x - p0.x;
    b = p2.x - p1.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p2.y - p1.y;
    f = p0.y;
    g = 0;
    h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
    f = p0.y;
  }
  return [a, b, c, d, e, f, g, h, 1];
}

/** 3×3 矩阵求逆（行主序），奇异矩阵返回 null。 */
export function invert3x3(m) {
  if (!m || m.length !== 9) return null;
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  return inv;
}

/** 用单应矩阵把归一化坐标 (u,v) 投影到文档坐标。 */
export function projectPoint(m, u, v) {
  if (!m) return null;
  const den = m[6] * u + m[7] * v + m[8];
  if (Math.abs(den) < 1e-9) return null;
  return {
    x: (m[0] * u + m[1] * v + m[2]) / den,
    y: (m[3] * u + m[4] * v + m[5]) / den,
  };
}

/** 点是否在凸四边形内（含边界）。 */
export function pointInQuad(quad, x, y) {
  if (!quad || quad.length !== 4) return false;
  let positive = 0;
  let negative = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = quad[index];
    const b = quad[(index + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > 0.001) positive += 1;
    else if (cross < -0.001) negative += 1;
    if (positive && negative) return false;
  }
  return true;
}

/** 四角的外接矩形（含少量留白）。 */
export function quadBounds(quad) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of quad) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.max(1, Math.ceil(maxX) - Math.floor(minX)),
    height: Math.max(1, Math.ceil(maxY) - Math.floor(minY)),
  };
}

/**
 * 把图片按四角做反向采样，返回可直接 drawImage 的离屏画布。
 * @param {CanvasImageSource} image 已解码图片或画布
 * @param {Array<{x:number,y:number}>} quad 目标四角（文档坐标）
 * @param {{ maxSide?: number }} [options] maxSide 限制采样画布的最大边，避免超大图卡顿
 * @returns {{canvas: HTMLCanvasElement, x:number, y:number}|null}
 */
export function warpImageToQuad(image, quad, { maxSide = 4096 } = {}) {
  if (!image || !quad || quad.length !== 4) return null;
  const forward = quadHomography(quad);
  const inverse = invert3x3(forward);
  if (!inverse) return null;

  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) return null;

  const box = quadBounds(quad);
  const scale = Math.min(1, maxSide / Math.max(box.width, box.height));
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));

  const source = document.createElement('canvas');
  source.width = sourceWidth;
  source.height = sourceHeight;
  const sourceCtx = source.getContext('2d');
  sourceCtx.drawImage(image, 0, 0);
  const sourceData = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d');
  const output = outCtx.createImageData(width, height);
  const data = output.data;
  const maxU = sourceWidth - 1;
  const maxV = sourceHeight - 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const docX = box.x + (x + 0.5) / scale;
      const docY = box.y + (y + 0.5) / scale;
      const den = inverse[6] * docX + inverse[7] * docY + inverse[8];
      if (Math.abs(den) < 1e-9) continue;
      const u = (inverse[0] * docX + inverse[1] * docY + inverse[2]) / den;
      const v = (inverse[3] * docX + inverse[4] * docY + inverse[5]) / den;
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;

      // 双线性采样，减轻透视边缘的锯齿。
      const sx = u * maxU;
      const sy = v * maxV;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = clamp(x0 + 1, 0, maxU);
      const y1 = clamp(y0 + 1, 0, maxV);
      const tx = sx - x0;
      const ty = sy - y0;
      const idx = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const tl = sourceData[((y0 * sourceWidth + x0) * 4) + channel];
        const tr = sourceData[((y0 * sourceWidth + x1) * 4) + channel];
        const bl = sourceData[((y1 * sourceWidth + x0) * 4) + channel];
        const br = sourceData[((y1 * sourceWidth + x1) * 4) + channel];
        data[idx + channel] = (tl * (1 - tx) + tr * tx) * (1 - ty) + (bl * (1 - tx) + br * tx) * ty;
      }
    }
  }
  outCtx.putImageData(output, 0, 0);
  return { canvas: out, x: box.x, y: box.y, scale };
}
