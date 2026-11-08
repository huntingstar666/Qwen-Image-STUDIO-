/**
 * 合成渲染器（D7.2 / D23.4 L4）。
 *
 * 只负责「把叠加层叠到底图上」这一步，底图（原图 + 变换 + 调色）由调用方先铺好：
 * - `drawLayers`：在已就绪的 2D 上下文上按顺序画图层，裁剪用平移抵消；
 * - `composite`：把底图画进目标画布后再叠图层。
 *
 * 图层组（D23.4 L4）：组员会先合成到与目标画布同尺寸的离屏画布，再按组参数
 * （显隐 / 不透明度 / 混合模式）整块贴回；因此组不透明度与组混合是「整组合成后」
 * 生效，组内剪贴只在本组内找基座，组内调整层也只作用于本组像素。
 *
 * 不依赖 studioDoc，避免渲染与文档模型互相引用；目标画布由调用方创建与缓存。
 */

import { applyAdjustmentLayer } from './adjustments.js';

function clamp01(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

/** 离屏画布按目标画布像素尺寸创建，每帧复用，避免重复分配。 */
function makeEnsure(ctx, scratch) {
  return (key) => {
    if (!scratch[key]) {
      const canvas = document.createElement('canvas');
      canvas.width = ctx.canvas.width;
      canvas.height = ctx.canvas.height;
      scratch[key] = canvas;
    }
    return scratch[key];
  };
}

/** 复制调用方当前的视口变换（平移 / 缩放 / DPR），离屏画布与主画布才能像素对齐。 */
function mirrorTransform(target, source) {
  const matrix = source.getTransform?.();
  if (matrix) target.setTransform(matrix);
  else target.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * 剪贴蒙版（D12.1）：把图层画到离屏画布，再用下方图层的 alpha 做 `destination-in`，
 * 最后整块贴回目标。离屏画布按目标画布像素尺寸创建，每帧复用，避免重复分配。
 * 离屏画布复制调用方变换，避免缩放/裁剪时剪贴层跳回 1:1。
 */
function drawClippedLayer(ctx, layer, base, crop, ensure) {
  const mask = ensure('mask');
  const mctx = mask.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mask.width, mask.height);
  mirrorTransform(mctx, ctx);
  mctx.save();
  if (crop) mctx.translate(-crop.x, -crop.y);
  base.draw(mctx);
  mctx.restore();

  const paint = ensure('paint');
  const pctx = paint.getContext('2d');
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, paint.width, paint.height);
  mirrorTransform(pctx, ctx);
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
 * 找剪贴基座：只允许同组内向下找（组外的层不能当组内剪贴的基座）。
 * 调整层没有像素，跳过继续向下；找不到返回 null。
 */
function clipBaseFor(layers, index) {
  const groupId = layers[index].groupId || '';
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = layers[i];
    if ((item.groupId || '') !== groupId) return null;
    if (item.clipped || item.isAdjustment) continue;
    return item;
  }
  return null;
}

/** 画单个图层（调整层 / 剪贴层 / 普通层）。 */
function paintLayer(ctx, layers, index, { crop, ensure }) {
  const layer = layers[index];
  // 调整层（D9.3）作用于已合成的下层内容，必须在画布坐标里处理，先归零变换。
  if (layer.isAdjustment) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyAdjustmentLayer(ctx, layer, { crop });
    ctx.restore();
    return;
  }
  if (layer.clipped) {
    const base = clipBaseFor(layers, index);
    if (base) {
      drawClippedLayer(ctx, layer, base, crop, ensure);
      return;
    }
  }
  ctx.save();
  if (crop) ctx.translate(-crop.x, -crop.y);
  layer.draw(ctx);
  ctx.restore();
}

/** 图层组：组员先合成到离屏画布，再按组参数整块贴回。 */
function drawGroup(ctx, members, group, { crop, skip, ensure }) {
  const canvas = ensure('group');
  const gctx = canvas.getContext('2d');
  gctx.setTransform(1, 0, 0, 1, 0, 0);
  gctx.clearRect(0, 0, canvas.width, canvas.height);
  mirrorTransform(gctx, ctx);
  const innerEnsure = makeEnsure(gctx, { mask: null, paint: null, group: null });
  members.forEach((layer, index) => {
    if (skip?.has?.(layer.id)) return;
    paintLayer(gctx, members, index, { crop, ensure: innerEnsure });
  });

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clamp01(group.opacity ?? 1);
  ctx.globalCompositeOperation = group.blend || 'source-over';
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

/**
 * 按 `layers[0] → 末尾` 的顺序绘制叠加层（末尾在最上层）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ draw: (ctx: CanvasRenderingContext2D) => void }>} layers
 * @param {{ crop?: {x:number,y:number}|null, skip?: Set<string>|null, groups?: Array<object>|null }} [options]
 *   crop: 图层坐标按「旋转后未裁剪」空间记录，裁剪时平移抵消；
 *   skip: 仍然参与剪贴蒙版的 alpha 基座计算，但不绘制（D23.3 合并选中用）；
 *   groups: 图层组参数（D23.4 L4），缺省时组员按普通图层绘制。
 */
export function drawLayers(ctx, layers, { crop = null, skip = null, groups = null } = {}) {
  if (!ctx || !layers?.length) return;
  const scratch = { mask: null, paint: null, group: null };
  const ensure = makeEnsure(ctx, scratch);
  const groupMap = new Map((groups || []).map((group) => [group.id, group]));
  const handledGroups = new Set();

  layers.forEach((layer, index) => {
    if (skip?.has?.(layer.id)) return;
    const groupId = layer.groupId || '';
    if (groupId && groupMap.has(groupId)) {
      if (handledGroups.has(groupId)) return;
      handledGroups.add(groupId);
      const group = groupMap.get(groupId);
      // 组隐藏 = 整组不参与合成（组员自己的眼睛按钮仍然保留状态）。
      if (group.visible === false) return;
      drawGroup(ctx, layers.filter((item) => item.groupId === groupId), group, { crop, skip, ensure });
      return;
    }
    paintLayer(ctx, layers, index, { crop, ensure });
  });
}

/**
 * 底图 + 叠加层合成到目标画布。
 * @param {CanvasRenderingContext2D} ctx 目标画布上下文，尺寸需与 underlay 一致
 * @param {CanvasImageSource} underlay
 * @param {Array<{ draw: (ctx: CanvasRenderingContext2D) => void }>} layers
 * @param {{ crop?: {x:number,y:number}|null, groups?: Array<object>|null }} [options]
 */
export function composite(ctx, underlay, layers, { crop = null, groups = null } = {}) {
  if (!ctx || !underlay) return;
  ctx.drawImage(underlay, 0, 0);
  drawLayers(ctx, layers, { crop, groups });
}
