/**
 * 合成渲染器（D7.2）。
 *
 * 只负责「把叠加层叠到底图上」这一步，底图（原图 + 变换 + 调色）由调用方先铺好：
 * - `drawLayers`：在已就绪的 2D 上下文上按顺序画图层，裁剪用平移抵消；
 * - `composite`：把底图画进目标画布后再叠图层。
 *
 * 不依赖 studioDoc，避免渲染与文档模型互相引用；目标画布由调用方创建与缓存。
 */

import { applyAdjustmentLayer } from './adjustments.js';

/**
 * 剪贴蒙版（D12.1）：把图层画到离屏画布，再用下方图层的 alpha 做 `destination-in`，
 * 最后整块贴回目标。离屏画布按目标画布像素尺寸创建，每帧复用，避免重复分配。
 */
function drawClippedLayer(ctx, layer, base, crop, scratch, ensure) {
  const mask = ensure('mask');
  const mctx = mask.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mask.width, mask.height);
  mctx.save();
  if (crop) mctx.translate(-crop.x, -crop.y);
  base.draw(mctx);
  mctx.restore();

  const paint = ensure('paint');
  const pctx = paint.getContext('2d');
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, paint.width, paint.height);
  pctx.save();
  if (crop) pctx.translate(-crop.x, -crop.y);
  layer.draw(pctx);
  pctx.restore();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(mask, 0, 0);
  pctx.globalCompositeOperation = 'source-over';

  // 离屏结果已经是目标画布的像素尺寸，用单位矩阵贴回，不受调用方缩放/平移影响。
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(paint, 0, 0);
  ctx.restore();
}

/**
 * 按 `layers[0] → 末尾` 的顺序绘制叠加层（末尾在最上层）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ draw: (ctx: CanvasRenderingContext2D) => void }>} layers
 * @param {{ crop?: {x:number,y:number}|null }} [options] 图层坐标按「旋转后未裁剪」空间记录，裁剪时平移抵消
 */
export function drawLayers(ctx, layers, { crop = null } = {}) {
  if (!ctx || !layers?.length) return;
  const scratch = { mask: null, paint: null };
  const ensure = (key) => {
    if (!scratch[key]) {
      const canvas = document.createElement('canvas');
      canvas.width = ctx.canvas.width;
      canvas.height = ctx.canvas.height;
      scratch[key] = canvas;
    }
    return scratch[key];
  };

  layers.forEach((layer, index) => {
    // 调整层（D9.3）作用于已合成的下层内容，必须在画布坐标里处理，先归零变换。
    if (layer.isAdjustment) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      applyAdjustmentLayer(ctx, layer, { crop });
      ctx.restore();
      return;
    }
    // 剪贴蒙版：取最近的、未剪贴的下层作为 alpha 基座（D12.1）。
    if (layer.clipped) {
      let baseIndex = index - 1;
      while (baseIndex >= 0 && layers[baseIndex].clipped) baseIndex -= 1;
      const base = baseIndex >= 0 ? layers[baseIndex] : null;
      if (base) {
        drawClippedLayer(ctx, layer, base, crop, scratch, ensure);
        return;
      }
    }
    ctx.save();
    if (crop) ctx.translate(-crop.x, -crop.y);
    layer.draw(ctx);
    ctx.restore();
  });
}

/**
 * 底图 + 叠加层合成到目标画布。
 * @param {CanvasRenderingContext2D} ctx 目标画布上下文，尺寸需与 underlay 一致
 * @param {CanvasImageSource} underlay
 * @param {Array<{ draw: (ctx: CanvasRenderingContext2D) => void }>} layers
 * @param {{ crop?: {x:number,y:number}|null }} [options]
 */
export function composite(ctx, underlay, layers, { crop = null } = {}) {
  if (!ctx || !underlay) return;
  ctx.drawImage(underlay, 0, 0);
  drawLayers(ctx, layers, { crop });
}
