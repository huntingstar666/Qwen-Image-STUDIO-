/**
 * 调整图层（D9.3）：非破坏式的调色层。
 *
 * 与底图调色（`studioDoc.adjust`）的区别：
 * 1. 调整层是图层栈里的一个对象，作用于「它下面的所有内容」（底图 + 更低图层），
 *    因此可以插在任意位置、随时回改参数、显隐、加蒙版，导出与预览走同一条合成管线；
 * 2. 参数由 CPU 逐像素计算，不依赖 `ctx.filter`，小图 / 4K / 导出结果完全一致；
 * 3. 蒙版使用文档坐标（旋转后、未裁剪），可直接用现有蒙版画笔涂抹。
 *
 * 该模块不依赖 studioDoc，避免渲染与文档模型互相引用。
 */

import { whiteBalanceGains } from './color.js';

export const ADJUSTMENT_KEYS = [
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
];

export const ADJUSTMENT_DEFAULTS = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 把任意参数对象归一成完整的 -100~100 数值表。 */
export function normalizeAdjustment(params = {}) {
  const next = { ...ADJUSTMENT_DEFAULTS };
  for (const key of ADJUSTMENT_KEYS) {
    const value = Number(params?.[key]);
    next[key] = Number.isFinite(value) ? clamp(value, -100, 100) : 0;
  }
  return next;
}

export function hasAdjustment(params) {
  const next = normalizeAdjustment(params);
  return ADJUSTMENT_KEYS.some((key) => Math.abs(next[key]) > 1e-4);
}

/**
 * 逐像素应用调整参数（原地修改 RGBA）。
 * 顺序：曝光/亮度 → 对比度 → 色温/色调增益 → 饱和度；每步都在 sRGB 分量上计算，
 * 与 CSS 滤镜的观感方向一致。
 * @param {Uint8ClampedArray} data
 * @param {object} params
 * @param {number} [strength] 0~1，用于渐入/渐出
 */
export function applyAdjustment(data, params, strength = 1) {
  if (!data?.length) return data;
  const amount = clamp(Number(strength) || 0, 0, 1);
  if (amount <= 0) return data;
  const p = normalizeAdjustment(params);
  if (!hasAdjustment(p)) return data;

  const brightness = Math.pow(2, p.exposure / 100) * (1 + p.brightness / 100);
  const contrast = 1 + p.contrast / 100;
  const saturation = 1 + p.saturation / 100;

  const gains = { r: 1, g: 1, b: 1 };
  if (p.temperature) {
    const wb = whiteBalanceGains({ temperature: p.temperature, tint: 0 });
    gains.r *= wb.r;
    gains.g *= wb.g;
    gains.b *= wb.b;
  }
  if (p.tint) {
    const wb = whiteBalanceGains({ temperature: 0, tint: p.tint });
    gains.r *= wb.r;
    gains.g *= wb.g;
    gains.b *= wb.b;
  }

  const mix = (from, to) => (amount >= 1 ? to : from + (to - from) * amount);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r0 = data[i];
    const g0 = data[i + 1];
    const b0 = data[i + 2];

    let r = (r0 / 255) * brightness;
    let g = (g0 / 255) * brightness;
    let b = (b0 / 255) * brightness;

    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    r *= gains.r;
    g *= gains.g;
    b *= gains.b;

    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;

    data[i] = Math.round(clamp(mix(r0, clamp(r * 255, 0, 255)), 0, 255));
    data[i + 1] = Math.round(clamp(mix(g0, clamp(g * 255, 0, 255)), 0, 255));
    data[i + 2] = Math.round(clamp(mix(b0, clamp(b * 255, 0, 255)), 0, 255));
  }
  return data;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/* ------------------------------------------------------- 局部调整（D9.4） */

export const LOCAL_DEFAULT = { type: 'none', freehand: false };

/**
 * 归一化局部调整描述：
 * - `linear`：start → end 的渐变，start 处全量、end 处不生效；
 * - `radial`：start 为中心、end 决定半径（可椭圆），中心全量、边缘不生效；
 * - `feather`：0~100，控制过渡曲线（0 = 线性，100 = 平滑步进）。
 */
export function normalizeLocal(local = {}) {
  const type = local?.type === 'linear' || local?.type === 'radial' ? local.type : 'none';
  const point = (value) => {
    const x = Number(value?.x);
    const y = Number(value?.y);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
    };
  };
  return {
    type,
    start: point(local?.start),
    end: point(local?.end),
    feather: clamp(Number(local?.feather ?? 50), 0, 100),
    freehand: Boolean(local?.freehand),
  };
}

/**
 * 采样局部调整在某个文档坐标点的强度 0~1（1 = 完整应用调整）。
 * 纯函数，便于单测；画布蒙版由 `buildLocalMask` 调用它生成。
 */
export function localStrengthAt(local, x, y) {
  return strengthFor(normalizeLocal(local), x, y);
}

/** 内部采样：调用方已完成归一化，避免逐像素重复构造对象。 */
function strengthFor(local, x, y) {
  if (local.type === 'none') return 1;
  const ease = (t) => {
    const value = clamp(t, 0, 1);
    return value + (smoothstep(value) - value) * (local.feather / 100);
  };
  if (local.type === 'linear') {
    const dx = local.end.x - local.start.x;
    const dy = local.end.y - local.start.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-6) return 1;
    const t = ((x - local.start.x) * dx + (y - local.start.y) * dy) / lengthSq;
    return 1 - ease(t);
  }
  const rx = Math.abs(local.end.x - local.start.x);
  const ry = Math.abs(local.end.y - local.start.y);
  if (rx < 1e-6 && ry < 1e-6) return 1;
  const nx = (x - local.start.x) / (rx || ry);
  const ny = (y - local.start.y) / (ry || rx);
  return 1 - ease(Math.sqrt(nx * nx + ny * ny));
}

/**
 * 把局部调整描述渲染成文档尺寸的蒙版画布（白 = 应用，透明 = 不影响）。
 * 只在拖动结束时调用，逐像素成本可接受；预览期间只画辅助线。
 */
export function buildLocalMask(local, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const next = normalizeLocal(local);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (next.type === 'none') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    return canvas;
  }
  const image = ctx.createImageData(w, h);
  const data = image.data;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(strengthFor(next, x + 0.5, y + 0.5) * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

let seq = 0;

/**
 * 调整图层对象：本身没有位图，合成时对下层结果做一次像素调整。
 */
export class AdjustmentLayer {
  constructor({
    id = '',
    name = '调整图层',
    params = {},
    width = 1,
    height = 1,
    opacity = 1,
    visible = true,
    locked = false,
    local = null,
    groupId = '',
  } = {}) {
    // 带时间戳，避免刷新后序号归零与已恢复图层的 id 冲突。
    this.id = id || `adj-${Date.now().toString(36)}-${(seq += 1)}`;
    this.name = name;
    this.params = normalizeAdjustment(params);
    /** 覆盖范围 = 文档「旋转后、未裁剪」尺寸，与 doc.mask 同坐标 */
    this.width = Math.max(1, Math.round(Number(width) || 1));
    this.height = Math.max(1, Math.round(Number(height) || 1));
    this.opacity = clamp(Number(opacity) ?? 1, 0, 1);
    this.visible = visible !== false;
    this.locked = Boolean(locked);
    /** 文档坐标蒙版：白色 = 应用调整，透明 = 保持原样 */
    this.mask = null;
    this.maskVisible = true;
    /** 局部调整描述（D9.4）：线性/径向渐变；画笔涂抹后保留最后几何，便于回显 */
    this.local = normalizeLocal(local || LOCAL_DEFAULT);
    /** 所属图层组（D23.4 L4）：组内合成时只作用于组内像素。 */
    this.groupId = String(groupId || '');
  }

  get kind() {
    return 'adjustment';
  }

  get isAdjustment() {
    return true;
  }

  bounds() {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /** 调整层盖住整张画面，画布点选交给图层面板，避免挡住下层拖动。 */
  hitTest() {
    return false;
  }

  ensureMask() {
    if (this.mask) return this.mask;
    const canvas = makeCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.mask = canvas;
    return canvas;
  }

  /** 调整层不缓存像素结果，保留接口与 OverlayLayer 一致。 */
  touchMask() {}

  /**
   * 应用局部调整（D9.4）：按几何重建蒙版画布，白 = 应用、透明 = 不影响。
   * `feather` 参与过渡曲线；`none` 表示恢复全图。
   */
  setLocal(local) {
    this.local = normalizeLocal(local);
    this.mask = buildLocalMask(this.local, this.width, this.height);
    this.maskVisible = true;
    return this.mask;
  }

  /** 恢复全图（清掉局部几何，保留画笔涂抹出来的蒙版由调用方决定）。 */
  clearLocal() {
    this.local = normalizeLocal(LOCAL_DEFAULT);
    this.removeMask();
  }

  hasMask() {
    return Boolean(this.mask);
  }

  toggleMaskVisible() {
    if (!this.mask) return false;
    this.maskVisible = !this.maskVisible;
    return this.maskVisible;
  }

  removeMask() {
    this.mask = null;
    this.maskVisible = true;
  }

  /** 合成由 `applyAdjustmentLayer` 完成，这里保留空实现以便图层循环统一调用。 */
  draw() {}

  clone({ fresh = false } = {}) {
    const copy = new AdjustmentLayer({
      id: fresh ? '' : this.id,
      name: this.name,
      params: this.params,
      width: this.width,
      height: this.height,
      opacity: this.opacity,
      visible: this.visible,
      locked: this.locked,
      local: this.local,
      groupId: this.groupId,
    });
    if (this.mask) {
      const canvas = makeCanvas(this.mask.width, this.mask.height);
      canvas.getContext('2d').drawImage(this.mask, 0, 0);
      copy.mask = canvas;
    }
    copy.maskVisible = this.maskVisible;
    return copy;
  }
}

/**
 * 把一个调整层合进目标画布：快照下层内容 → 逐像素调整 → 按蒙版裁剪 → 叠回。
 * @param {CanvasRenderingContext2D} ctx 目标画布上下文（尺寸为输出尺寸）
 * @param {AdjustmentLayer} layer
 * @param {{ crop?: {x:number,y:number}|null, scale?: number }} [options]
 *   crop 为文档裁剪框（图层蒙版按文档坐标记录）；scale 用于低分辨率预览（默认 1）
 */
export function applyAdjustmentLayer(ctx, layer, { crop = null, scale = 1 } = {}) {
  if (!ctx || !layer || layer.visible === false || layer.opacity <= 0) return;
  if (!hasAdjustment(layer.params)) return;
  const canvas = ctx.canvas;
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return;

  const snapshot = makeCanvas(width, height);
  snapshot.getContext('2d').drawImage(canvas, 0, 0);

  const adjusted = makeCanvas(width, height);
  const actx = adjusted.getContext('2d');
  actx.drawImage(snapshot, 0, 0);
  const image = actx.getImageData(0, 0, width, height);
  applyAdjustment(image.data, layer.params);
  actx.putImageData(image, 0, 0);

  if (layer.mask && layer.maskVisible !== false) {
    const ratio = Number(scale) > 0 ? Number(scale) : 1;
    actx.save();
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.globalCompositeOperation = 'destination-in';
    actx.drawImage(
      layer.mask,
      -(crop?.x || 0) * ratio,
      -(crop?.y || 0) * ratio,
      layer.mask.width * ratio,
      layer.mask.height * ratio,
    );
    actx.restore();
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = clamp(Number(layer.opacity) || 0, 0, 1);
  ctx.drawImage(adjusted, 0, 0);
  ctx.restore();
}
