/**
 * 抠图（D21.1）：选区 alpha → 透明 PNG / 复制 / 抠图层 / 白底 JPG。
 *
 * 与 `doc.mask` 的区别：蒙版「白 = 要 AI 重绘」，选区「白 = 保留」，
 * 因此抠图只读 `selection.alpha`，绝不写回文档。
 *
 * 坐标见 docs/PLAN_PS_FRONTEND.md §19.2：
 * - 选区空间 = 旋转后未裁剪（`doc.oriented`）
 * - 输出空间 = 裁剪后（`doc.size`），左上角偏移 = `-crop.x/-crop.y`
 */

import { contractAlpha, featherAlpha } from './selection.js';

export const CUTOUT_EDGE_PRESETS = {
  hard: { label: '硬边', contract: 1, feather: 0 },
  standard: { label: '标准', contract: 1, feather: 0.8 },
  hair: { label: '发丝', contract: 0, feather: 1.2 },
};

export const CUTOUT_EDGE_ORDER = ['standard', 'hard', 'hair'];

/**
 * 按预设处理选区 alpha（收缩 → 羽化），返回新数组，不改原选区。
 * @param {Uint8ClampedArray|Uint8Array} alpha
 * @param {number} width 选区空间宽
 * @param {number} height 选区空间高
 * @param {'hard'|'standard'|'hair'} edge
 */
export function prepareCutoutAlpha(alpha, width, height, edge = 'standard') {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  if (!alpha?.length || !w || !h) return new Uint8ClampedArray(0);
  const preset = CUTOUT_EDGE_PRESETS[edge] || CUTOUT_EDGE_PRESETS.standard;
  let next = alpha;
  if (preset.contract) next = contractAlpha(next, w, h, preset.contract);
  if (preset.feather) next = featherAlpha(next, w, h, preset.feather);
  return next instanceof Uint8ClampedArray ? next : new Uint8ClampedArray(next);
}

/**
 * 从「旋转后未裁剪」尺寸与裁剪框算出输出矩形（`doc.size`）。
 * @param {{x:number,y:number,width:number,height:number}|null} crop
 * @param {number} width 未裁剪宽
 * @param {number} height 未裁剪高
 */
export function cutoutRect(crop, width, height) {
  const fullWidth = Math.max(1, Math.round(Number(width) || 0));
  const fullHeight = Math.max(1, Math.round(Number(height) || 0));
  if (!crop) return { x: 0, y: 0, width: fullWidth, height: fullHeight };
  return {
    x: Math.round(Number(crop.x) || 0),
    y: Math.round(Number(crop.y) || 0),
    width: Math.max(1, Math.round(Number(crop.width) || fullWidth)),
    height: Math.max(1, Math.round(Number(crop.height) || fullHeight)),
  };
}
