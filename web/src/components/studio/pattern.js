/**
 * 图案图章（D11.4）：把一块矩形取样区域按「相对取样原点」平铺后盖章。
 *
 * - `tilePatch`：纯函数，按 offset 把 sw×sh 的 RGBA 平铺填充 dw×dh，便于单测；
 * - `patternDab`：读取取样区域 → 生成笔刷窗口大小的平铺补丁 → 径向柔边后贴回修复层。
 *
 * 平铺对齐以取样矩形的左上角为原点：画布上同一位置无论分几笔，图案都连续。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 负数的正模，保证 offset 为负时仍落在 [0, size)。 */
function mod(value, size) {
  if (size <= 0) return 0;
  return ((value % size) + size) % size;
}

/**
 * 把 sw×sh 的 RGBA 数据平铺到 dw×dh。
 * @param {Uint8ClampedArray} source
 * @param {number} sw
 * @param {number} sh
 * @param {number} dw
 * @param {number} dh
 * @param {number} offsetX 目标窗口左上角相对图案原点的 x（可为负）
 * @param {number} offsetY
 * @returns {Uint8ClampedArray}
 */
export function tilePatch(source, sw, sh, dw, dh, offsetX = 0, offsetY = 0) {
  const out = new Uint8ClampedArray(Math.max(0, dw * dh * 4));
  if (!source || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;
  for (let y = 0; y < dh; y += 1) {
    const sy = mod(offsetY + y, sh);
    const srcRow = sy * sw;
    const dstRow = y * dw;
    for (let x = 0; x < dw; x += 1) {
      const si = (srcRow + mod(offsetX + x, sw)) * 4;
      const di = (dstRow + x) * 4;
      out[di] = source[si];
      out[di + 1] = source[si + 1];
      out[di + 2] = source[si + 2];
      out[di + 3] = source[si + 3];
    }
  }
  return out;
}

/**
 * 图案图章的一笔。
 * @param {CanvasRenderingContext2D} ctx 目标（修复层）
 * @param {CanvasImageSource} source 取样来源（干净底图）
 * @param {{x:number,y:number,radius:number,opacity?:number,softness?:number,
 *   pattern:{x:number,y:number,width:number,height:number}}} options
 *   pattern 为图像坐标中的取样矩形；越界返回 false。
 */
export function patternDab(ctx, source, { x, y, radius, opacity = 1, softness = 0.5, pattern } = {}) {
  if (!ctx || !source || !pattern) return false;
  const r = Math.max(1, Number(radius) || 1);
  const patternX = Math.round(Number(pattern.x) || 0);
  const patternY = Math.round(Number(pattern.y) || 0);
  const patternW = Math.round(Number(pattern.width) || 0);
  const patternH = Math.round(Number(pattern.height) || 0);
  if (patternW < 1 || patternH < 1) return false;
  if (
    patternX < 0 ||
    patternY < 0 ||
    patternX + patternW > source.width ||
    patternY + patternH > source.height
  ) {
    return false;
  }

  let probe;
  try {
    probe = source.getContext('2d');
  } catch {
    return false;
  }
  const data = probe.getImageData(patternX, patternY, patternW, patternH).data;

  const pad = Math.ceil(r * 1.4);
  const size = pad * 2;
  const windowX = Math.round(x - pad);
  const windowY = Math.round(y - pad);
  const patch = tilePatch(data, patternW, patternH, size, size, windowX - patternX, windowY - patternY);

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  const sctx = scratchCanvas.getContext('2d');
  sctx.putImageData(new ImageData(patch, size, size), 0, 0);

  const center = size / 2;
  const edge = clamp(1 - clamp(softness, 0, 1) * 0.7, 0.25, 1);
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
  ctx.drawImage(scratchCanvas, windowX, windowY);
  ctx.restore();
  return true;
}
