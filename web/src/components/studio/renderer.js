/**
 * 合成渲染器（D7.2）。
 *
 * 只负责「把叠加层叠到底图上」这一步，底图（原图 + 变换 + 调色）由调用方先铺好：
 * - `drawLayers`：在已就绪的 2D 上下文上按顺序画图层，裁剪用平移抵消；
 * - `composite`：把底图画进目标画布后再叠图层。
 *
 * 不依赖 studioDoc，避免渲染与文档模型互相引用；目标画布由调用方创建与缓存。
 */

/**
 * 按 `layers[0] → 末尾` 的顺序绘制叠加层（末尾在最上层）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ draw: (ctx: CanvasRenderingContext2D) => void }>} layers
 * @param {{ crop?: {x:number,y:number}|null }} [options] 图层坐标按「旋转后未裁剪」空间记录，裁剪时平移抵消
 */
export function drawLayers(ctx, layers, { crop = null } = {}) {
  if (!ctx || !layers?.length) return;
  ctx.save();
  if (crop) ctx.translate(-crop.x, -crop.y);
  for (const layer of layers) layer.draw(ctx);
  ctx.restore();
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
