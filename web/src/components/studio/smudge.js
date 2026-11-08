/**
 * 涂抹（D10.3）：把笔刷范围内的像素沿拖动方向「推」一小段，形成湿画法般的拖尾。
 *
 * 算法很朴素但稳定：每次落笔读取当前位置的方形补丁 → 按拖动方向偏移 →
 * 用径向渐变做柔边后叠回修复层。连续落笔时补丁互相叠加，就得到自然的涂抹感。
 * 不做像素级流体模拟，因此 4K 下也只是「读一块、贴一块」的开销。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 把向量归一化为单位长度；零向量返回 {x:0,y:0}，避免除零。 */
export function normalizeVector(x, y) {
  const length = Math.hypot(x, y);
  if (!(length > 1e-6)) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

/**
 * 单次涂抹的取样偏移（纯函数，便于单测）：
 * 拖动方向单位向量 × 半径 × 强度系数。
 * @param {{x:number,y:number}} direction 单位向量
 * @param {number} radius 笔刷半径（文档像素）
 * @param {number} [amount] 0~1，默认 0.35
 */
export function smudgeShift(direction, radius, amount = 0.35) {
  const unit = normalizeVector(direction?.x || 0, direction?.y || 0);
  const step = Math.max(0, Number(radius) || 0) * clamp(Number(amount) || 0, 0, 1);
  return { x: unit.x * step, y: unit.y * step };
}

/**
 * 把一次涂抹画进目标上下文（修复层）。
 * @param {CanvasRenderingContext2D} ctx 目标（文档坐标）
 * @param {CanvasImageSource} source 取样来源（当前合成底图）
 * @param {{x:number,y:number,dx:number,dy:number,radius:number,opacity?:number,softness?:number}} options
 * @returns {boolean} 是否真的绘制（取样越界返回 false）
 */
export function smudgeDab(ctx, source, { x, y, dx = 0, dy = 0, radius, opacity = 1, softness = 0.4 } = {}) {
  if (!ctx || !source) return false;
  const r = Math.max(1, Number(radius) || 1);
  const pad = Math.ceil(r * 1.35);
  const size = pad * 2;
  const readX = Math.round(x - pad);
  const readY = Math.round(y - pad);
  if (readX < 0 || readY < 0 || readX + size > source.width || readY + size > source.height) return false;
  let probe;
  try {
    probe = source.getContext('2d');
  } catch {
    return false;
  }
  const patch = probe.getImageData(readX, readY, size, size);

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  const sctx = scratchCanvas.getContext('2d');
  sctx.putImageData(patch, 0, 0);

  const center = size / 2;
  const edge = clamp(1 - clamp(softness, 0, 1) * 0.75, 0.15, 1);
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
  ctx.drawImage(scratchCanvas, Math.round(readX + dx), Math.round(readY + dy));
  ctx.restore();
  return true;
}
