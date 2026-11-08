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
  hard: { label: '硬边', contract: 1, feather: 0, decontaminate: false },
  standard: { label: '标准', contract: 1, feather: 0.8, decontaminate: true },
  hair: { label: '发丝', contract: 0, feather: 1.2, decontaminate: true },
};

export const CUTOUT_EDGE_ORDER = ['standard', 'hard', 'hair'];

/** 固定尺寸预设（P4）：输出画布固定，主体等比 contain 居中，四周透明留白。 */
export const CUTOUT_SIZES = [
  { id: 'origin', label: '原图' },
  { id: 'square1000', label: '1000 × 1000', width: 1000, height: 1000 },
  { id: 'portrait1200', label: '1200 × 1600', width: 1200, height: 1600 },
  { id: 'landscape1600', label: '1600 × 1200', width: 1600, height: 1200 },
  { id: 'story1080', label: '1080 × 1920', width: 1080, height: 1920 },
  { id: 'custom', label: '自定义…' },
];

export const CUTOUT_MIN_SIDE = 16;
export const CUTOUT_MAX_SIDE = 8192;

/** 固定尺寸输入夹取（非法值回退默认）。 */
export function clampCutoutSide(value, fallback = 1024) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(CUTOUT_MIN_SIDE, Math.min(CUTOUT_MAX_SIDE, n));
}

/**
 * contain 布局：内容等比缩放塞进目标画布并居中（不裁剪）。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function fitCutoutRect(contentWidth, contentHeight, targetWidth, targetHeight) {
  const cw = Math.max(1, Number(contentWidth) || 1);
  const ch = Math.max(1, Number(contentHeight) || 1);
  const tw = Math.max(1, Number(targetWidth) || 1);
  const th = Math.max(1, Number(targetHeight) || 1);
  const scale = Math.min(tw / cw, th / ch);
  const width = cw * scale;
  const height = ch * scale;
  return { x: (tw - width) / 2, y: (th - height) / 2, width, height };
}

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
 * 去色边（decontaminate）：只改 α∈(8, 248) 的边缘带 RGB，
 * 用半径 r 内 α≥250 的实心像素均值替换，避免背景色渗进主体边缘。
 *
 * 直接在 RGBA 缓冲上原地处理并返回；实心像素永远不会被写入，因此可以边读边写。
 *
 * @param {Uint8ClampedArray|Uint8Array} data RGBA 缓冲
 * @param {number} width
 * @param {number} height
 * @param {number} [radius] 1~3px
 */
export function decontaminatePixels(data, width, height, radius = 1) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  if (!data?.length || !w || !h || data.length < w * h * 4) return data;
  const r = Math.max(1, Math.min(3, Math.round(Number(radius) || 1)));
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i += 1) solid[i] = data[i * 4 + 3] >= 250 ? 1 : 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const index = y * w + x;
      const alpha = data[index * 4 + 3];
      if (alpha <= 8 || alpha >= 248) continue;
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let count = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let sy = y0; sy <= y1; sy += 1) {
        for (let sx = x0; sx <= x1; sx += 1) {
          const near = sy * w + sx;
          if (!solid[near]) continue;
          const p = near * 4;
          rs += data[p];
          gs += data[p + 1];
          bs += data[p + 2];
          count += 1;
        }
      }
      if (!count) continue;
      const p = index * 4;
      data[p] = Math.round(rs / count);
      data[p + 1] = Math.round(gs / count);
      data[p + 2] = Math.round(bs / count);
    }
  }
  return data;
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
