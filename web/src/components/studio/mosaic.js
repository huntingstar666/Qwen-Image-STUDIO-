/**
 * 马赛克 / 局部模糊（D11.1）。
 *
 * 两种模式共用一次「读窗口 → 处理 → 柔边贴回」的流程：
 * - `mosaic`：按方块取均值再整块填充，边缘用笔刷径向渐变羽化，避免出现硬矩形；
 * - `blur`：复用箱式模糊（与磨皮同一算法），适合打码前的柔和处理。
 *
 * `pixelate` 是纯函数，可直接单测。
 */

import { boxBlur } from './skin.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 方块马赛克（原地修改并返回）。
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} width
 * @param {number} height
 * @param {number} block 方块边长（像素），<=1 时原样返回
 */
export function pixelate(data, width, height, block) {
  const size = Math.max(1, Math.round(Number(block) || 1));
  if (!data?.length || size <= 1) return data;
  for (let by = 0; by < height; by += size) {
    for (let bx = 0; bx < width; bx += size) {
      const maxY = Math.min(height, by + size);
      const maxX = Math.min(width, bx + size);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = by; y < maxY; y += 1) {
        for (let x = bx; x < maxX; x += 1) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n += 1;
        }
      }
      if (!n) continue;
      r /= n;
      g /= n;
      b /= n;
      a /= n;
      for (let y = by; y < maxY; y += 1) {
        for (let x = bx; x < maxX; x += 1) {
          const i = (y * width + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = a;
        }
      }
    }
  }
  return data;
}

/**
 * 一次马赛克/模糊笔触。
 * @param {CanvasRenderingContext2D} ctx 目标（修复层）
 * @param {CanvasImageSource} source 取样来源
 * @param {{x:number,y:number,radius:number,mode?:'mosaic'|'blur',block?:number,blurRadius?:number,opacity?:number,softness?:number}} options
 * @returns {boolean}
 */
export function mosaicDab(
  ctx,
  source,
  { x, y, radius, mode = 'mosaic', block = 0, blurRadius = 0, opacity = 1, softness = 0.35 } = {},
) {
  if (!ctx || !source) return false;
  const r = Math.max(2, Number(radius) || 2);
  const pad = Math.ceil(r * 1.2);
  const size = pad * 2;
  const readX = Math.round(x - pad);
  const readY = Math.round(y - pad);
  if (readX < 0 || readY < 0 || readX + size > source.width || readY + size > source.height) return false;
  const probe = source.getContext('2d');
  const image = probe.getImageData(readX, readY, size, size);

  if (mode === 'blur') {
    // boxBlur 返回新数组，必须写回补丁数据。
    const blurred = boxBlur(image.data, size, size, Math.max(1, Math.round(blurRadius || r * 0.18)));
    if (blurred !== image.data) image.data.set(blurred);
  } else {
    pixelate(image.data, size, size, Math.max(2, Math.round(block || r * 0.22)));
  }

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
