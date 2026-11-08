/**
 * 污点修复（D10.1）：围绕笔刷的环形采样 + 锥形渐变填色。
 *
 * 思路：小面积瑕疵（痘、灰尘、孤立噪点）周围的像素通常是连续的，
 * 用「半径外一圈」的颜色按角度采样，再以锥形渐变填进笔刷范围内，
 * 就能在渐变背景上得到几乎看不出接缝的补丁，且完全不联网、不依赖 AI。
 *
 * 纯函数（`ringSamples`）与画布绘制（`healDab`）分离，前者可直接单测。
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 在半径 `radius` 的圆环上按角度采样颜色。
 * @param {Uint8ClampedArray} data 源图 RGBA
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,radius:number,samples?:number,box?:number}} options
 * @returns {Array<{r:number,g:number,b:number}>} 每个角度一个颜色（含透明像素时退回上一有效值）
 */
export function ringSamples(data, width, height, { x, y, radius, samples = 8, box = 1 } = {}) {
  const count = Math.max(4, Math.round(samples));
  const out = [];
  let last = { r: 200, g: 200, b: 200 };
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const px = Math.round(x + Math.cos(angle) * radius);
    const py = Math.round(y + Math.sin(angle) * radius);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dy = -box; dy <= box; dy += 1) {
      for (let dx = -box; dx <= box; dx += 1) {
        const sx = px + dx;
        const sy = py + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const idx = (sy * width + sx) * 4;
        if (data[idx + 3] < 8) continue;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        n += 1;
      }
    }
    if (n) last = { r: r / n, g: g / n, b: b / n };
    out.push({ ...last });
  }
  return out;
}

function css(color) {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}

/**
 * 把一个修复笔触画进目标上下文（通常是文档修复层）。
 * @param {CanvasRenderingContext2D} ctx 目标上下文（文档坐标）
 * @param {CanvasImageSource} source 取样来源（合成后的底图）
 * @param {{x:number,y:number,radius:number,opacity?:number,softness?:number,sourceRect?:{x:number,y:number}}} options
 *   `sourceRect`：source 相对文档的偏移；为 undefined 时按同尺寸处理。
 */
export function healDab(ctx, source, { x, y, radius, opacity = 1, softness = 0.5, sourceRect = null } = {}) {
  if (!ctx || !source) return;
  const r = Math.max(1, Number(radius) || 1);
  const pad = Math.ceil(r * 1.7);
  const size = pad * 2;
  const sx = Math.round(x - pad - (sourceRect?.x || 0));
  const sy = Math.round(y - pad - (sourceRect?.y || 0));
  const sw = Math.min(size, Math.max(1, source.width - Math.max(0, sx)));
  const sh = Math.min(size, Math.max(1, source.height - Math.max(0, sy)));
  const readX = Math.max(0, sx);
  const readY = Math.max(0, sy);
  let colors = null;
  try {
    const probe = source.getContext('2d');
    const data = probe.getImageData(readX, readY, sw, sh).data;
    colors = ringSamples(data, sw, sh, {
      x: pad - (readX - sx),
      y: pad - (readY - sy),
      radius: r * 1.25,
      samples: 10,
      box: 1,
    });
  } catch {
    colors = null;
  }
  if (!colors) return;

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = size;
  scratchCanvas.height = size;
  const sctx = scratchCanvas.getContext('2d');
  const center = size / 2;

  if (typeof sctx.createConicGradient === 'function') {
    const gradient = sctx.createConicGradient(-Math.PI / 2, center, center);
    colors.forEach((color, i) => gradient.addColorStop(i / colors.length, css(color)));
    gradient.addColorStop(1, css(colors[0]));
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, size, size);
  } else {
    const avg = colors.reduce(
      (acc, color) => ({ r: acc.r + color.r / colors.length, g: acc.g + color.g / colors.length, b: acc.b + color.b / colors.length }),
      { r: 0, g: 0, b: 0 },
    );
    sctx.fillStyle = css(avg);
    sctx.fillRect(0, 0, size, size);
  }

  // 柔和边缘：中心实心，外圈渐隐，避免出现硬圆斑。
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
  ctx.drawImage(scratchCanvas, Math.round(x - pad), Math.round(y - pad));
  ctx.restore();
}
