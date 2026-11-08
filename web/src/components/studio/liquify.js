/**
 * 液化（D10.5）：以「推」为主的局部像素形变。
 *
 * 每次落笔都从「本笔开始时的底图快照」按累计位移反向取样，
 * 因此反复涂抹不会像涂抹工具那样把颜色越推越远，而是真正的形变。
 * 位移权重随到笔刷中心的距离做 smoothstep 衰减，边缘无缝。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 笔刷内某点的位移权重（0~1）：中心 1，边缘 0。
 * @param {number} distance 到笔刷中心的距离
 * @param {number} radius 笔刷半径
 */
export function pushWeight(distance, radius) {
  const r = Number(radius) || 0;
  if (!(r > 0)) return 0;
  const t = clamp(1 - Number(distance) / r, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 把底图按累计位移 (dx,dy) 反向取样后写进目标上下文（修复层）。
 * 只覆盖笔刷外接方形，未受影响区域保持透明。
 * @param {CanvasRenderingContext2D} ctx 目标
 * @param {CanvasImageSource} base 本笔开始时的底图快照（含修复层）
 * @param {{x:number,y:number,dx:number,dy:number,radius:number,strength?:number}} options
 * @returns {boolean}
 */
export function warpPatch(ctx, base, { x, y, dx = 0, dy = 0, radius, strength = 1 } = {}) {
  if (!ctx || !base) return false;
  const r = Math.max(2, Number(radius) || 2);
  const pad = Math.ceil(r) + 2;
  const size = pad * 2;
  const originX = Math.round(x - pad);
  const originY = Math.round(y - pad);
  if (originX < 0 || originY < 0 || originX + size > base.width || originY + size > base.height) return false;
  const probe = base.getContext('2d');
  const source = probe.getImageData(originX, originY, size, size);
  const out = ctx.createImageData(size, size);
  const amp = clamp(Number(strength) || 0, 0, 1);
  const cx = x - originX;
  const cy = y - originY;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const i = (py * size + px) * 4;
      const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      const weight = pushWeight(dist, r);
      if (weight <= 0 || amp <= 0) continue;
      // 反向取样：目标点吸收它「来处」的像素。
      const sx = clamp(Math.round(px - dx * weight * amp), 0, size - 1);
      const sy = clamp(Math.round(py - dy * weight * amp), 0, size - 1);
      const si = (sy * size + sx) * 4;
      out.data[i] = source.data[si];
      out.data[i + 1] = source.data[si + 1];
      out.data[i + 2] = source.data[si + 2];
      out.data[i + 3] = source.data[si + 3];
    }
  }

  // 用画布绘制而不是 putImageData：笔刷外的透明像素不会擦掉修复层里已有的内容。
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  scratchCanvas.getContext('2d').putImageData(out, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(scratchCanvas, originX, originY);
  ctx.restore();
  return true;
}
