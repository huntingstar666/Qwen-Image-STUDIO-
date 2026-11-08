/**
 * 磨皮（D10.4）：频率分离式的局部柔化。
 *
 * 做法：把笔刷窗口拆成「低频（模糊）+ 高频（细节）」，只把低频再模糊一次后与高频相加，
 * 这样肤色/明暗过渡被抹平，而毛孔、发丝等细节仍然保留，不会出现塑料感。
 *
 * 纯函数 `boxBlur` 便于单测；`skinDab` 负责柔边贴回修复层。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 可分离箱式模糊（原地返回新数组）。
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} width
 * @param {number} height
 * @param {number} radius 半径（像素），0 表示原样返回
 * @returns {Uint8ClampedArray}
 */
export function boxBlur(data, width, height, radius) {
  const r = Math.max(0, Math.round(radius));
  if (!data?.length || r <= 0) return data;
  const src = new Uint8ClampedArray(data);
  const out = new Uint8ClampedArray(data.length);
  const w = width;
  const h = height;

  // 横向
  const temp = new Float32Array(data.length);
  for (let y = 0; y < h; y += 1) {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let aSum = 0;
    for (let x = -r; x <= r; x += 1) {
      const sx = clamp(x, 0, w - 1);
      const i = (y * w + sx) * 4;
      rSum += src[i];
      gSum += src[i + 1];
      bSum += src[i + 2];
      aSum += src[i + 3];
    }
    const count = r * 2 + 1;
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      temp[o] = rSum / count;
      temp[o + 1] = gSum / count;
      temp[o + 2] = bSum / count;
      temp[o + 3] = aSum / count;
      const addX = clamp(x + r + 1, 0, w - 1);
      const subX = clamp(x - r, 0, w - 1);
      const ai = (y * w + addX) * 4;
      const si = (y * w + subX) * 4;
      rSum += src[ai] - src[si];
      gSum += src[ai + 1] - src[si + 1];
      bSum += src[ai + 2] - src[si + 2];
      aSum += src[ai + 3] - src[si + 3];
    }
  }

  // 纵向
  for (let x = 0; x < w; x += 1) {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let aSum = 0;
    for (let y = -r; y <= r; y += 1) {
      const sy = clamp(y, 0, h - 1);
      const i = (sy * w + x) * 4;
      rSum += temp[i];
      gSum += temp[i + 1];
      bSum += temp[i + 2];
      aSum += temp[i + 3];
    }
    const count = r * 2 + 1;
    for (let y = 0; y < h; y += 1) {
      const o = (y * w + x) * 4;
      out[o] = rSum / count;
      out[o + 1] = gSum / count;
      out[o + 2] = bSum / count;
      out[o + 3] = aSum / count;
      const addY = clamp(y + r + 1, 0, h - 1);
      const subY = clamp(y - r, 0, h - 1);
      const ai = (addY * w + x) * 4;
      const si = (subY * w + x) * 4;
      rSum += temp[ai] - temp[si];
      gSum += temp[ai + 1] - temp[si + 1];
      bSum += temp[ai + 2] - temp[si + 2];
      aSum += temp[ai + 3] - temp[si + 3];
    }
  }
  return out;
}

/**
 * 频率分离磨皮：低频再模糊 + 高频按比例保留，再与原图混合。
 * `ratio` 越大，低频过渡越平、高频细节衰减越多（但不会归零，避免塑料感）。
 * @param {Uint8ClampedArray} data RGBA（原地修改）
 * @param {number} width
 * @param {number} height
 * @param {number} radius 低频缩放半径
 * @param {number} ratio 0~1，越大越平滑
 */
export function smoothSkin(data, width, height, radius, ratio = 0.8) {
  if (!data?.length) return data;
  const amount = clamp(Number(ratio) || 0, 0, 1);
  if (amount <= 0) return data;
  const low = boxBlur(data, width, height, Math.max(1, radius));
  const low2 = boxBlur(low, width, height, Math.max(1, Math.round(radius * 1.8)));
  // 高频只保留一部分：抹掉细小瑕疵与噪点，同时留住毛发/毛孔的轮廓。
  const keep = 1 - amount * 0.45;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const smooth = low2[i] + (data[i] - low[i]) * keep;
    const smoothG = low2[i + 1] + (data[i + 1] - low[i + 1]) * keep;
    const smoothB = low2[i + 2] + (data[i + 2] - low[i + 2]) * keep;
    data[i] = clamp(data[i] + (smooth - data[i]) * amount, 0, 255);
    data[i + 1] = clamp(data[i + 1] + (smoothG - data[i + 1]) * amount, 0, 255);
    data[i + 2] = clamp(data[i + 2] + (smoothB - data[i + 2]) * amount, 0, 255);
  }
  return data;
}

/**
 * 把一次磨皮笔触画进目标上下文（修复层）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} source
 * @param {{x:number,y:number,radius:number,strength?:number,opacity?:number,softness?:number}} options
 */
export function skinDab(ctx, source, { x, y, radius, strength = 0.8, opacity = 1, softness = 0.6 } = {}) {
  if (!ctx || !source) return false;
  const r = Math.max(2, Number(radius) || 2);
  const pad = Math.ceil(r * 1.35);
  const size = pad * 2;
  const readX = Math.round(x - pad);
  const readY = Math.round(y - pad);
  if (readX < 0 || readY < 0 || readX + size > source.width || readY + size > source.height) return false;
  const probe = source.getContext('2d');
  const image = probe.getImageData(readX, readY, size, size);
  smoothSkin(image.data, size, size, Math.max(2, Math.round(r * 0.4)), strength);

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  const sctx = scratchCanvas.getContext('2d');
  sctx.putImageData(image, 0, 0);

  const center = size / 2;
  const edge = clamp(1 - clamp(softness, 0, 1) * 0.7, 0.2, 1);
  const mask = sctx.createRadialGradient(center, center, 0, center, center, size / 2);
  mask.addColorStop(0, 'rgba(255,255,255,1)');
  mask.addColorStop(edge, 'rgba(255,255,255,1)');
  mask.addColorStop(1, 'rgba(255,255,255,0)');
  sctx.globalCompositeOperation = 'destination-in';
  sctx.fillStyle = mask;
  sctx.fillRect(0, 0, size, size);
  sctx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clamp(Number(opacity) || 0, 0, 1);
  ctx.drawImage(scratchCanvas, readX, readY);
  ctx.restore();
  return true;
}
