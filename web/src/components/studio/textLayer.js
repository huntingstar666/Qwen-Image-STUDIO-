/**
 * 文字图层（D11.2）：一个可反复编辑的文字对象，绘制在底图/修复层之上。
 *
 * 与叠加图层的区别：不存位图，只存文本与样式，渲染时用 Canvas 2D 现场绘制，
 * 因此改字号/颜色/描边/投影都是零成本，导出与预览也走同一段代码。
 */

import { BLEND_IDS } from './layers.js';

export const TEXT_FONTS = [
  { id: 'system-ui', label: '系统默认' },
  { id: '"Microsoft YaHei", sans-serif', label: '微软雅黑' },
  { id: '"SimSun", serif', label: '宋体' },
  { id: '"KaiTi", serif', label: '楷体' },
  { id: 'Georgia, serif', label: 'Georgia' },
  { id: 'Impact, sans-serif', label: 'Impact' },
];

export const TEXT_DEFAULTS = {
  text: '双击编辑文字',
  fontFamily: TEXT_FONTS[0].id,
  fontSize: 64,
  fontWeight: 600,
  color: '#ffffff',
  lineHeight: 1.25,
  strokeWidth: 0,
  strokeColor: '#000000',
  shadowBlur: 0,
  shadowX: 0,
  shadowY: 6,
  shadowColor: 'rgba(0, 0, 0, 0.45)',
};

let seq = 0;
let measureCanvas = null;

/**
 * 路径文字排版（D13.3）：给定每个字符宽度，返回相对基线中心的 {x,y,angle}。
 * arc -100~100：正数向上拱起（像彩虹），负数向下弯曲；0 为普通横排。
 * 纯函数，便于单测。
 * @param {number[]} widths
 * @param {number} arc
 * @returns {Array<{x:number,y:number,angle:number}>}
 */
export function arcLayout(widths, arc = 0) {
  const list = Array.isArray(widths) ? widths : [];
  const total = list.reduce((sum, width) => sum + Math.max(0, Number(width) || 0), 0);
  const result = [];
  const curvature = clamp(Number(arc) || 0, -100, 100);
  if (!curvature) {
    let offset = -total / 2;
    for (const width of list) {
      result.push({ x: offset + width / 2, y: 0, angle: 0 });
      offset += width;
    }
    return result;
  }
  const sweep = (Math.PI * 0.9 * curvature) / 100;
  const radius = Math.max(1, total / Math.abs(sweep));
  const centerY = sweep > 0 ? radius : -radius;
  let offset = -total / 2;
  for (const width of list) {
    const middle = offset + width / 2;
    const t = middle / radius;
    if (sweep > 0) {
      result.push({ x: Math.sin(t) * radius, y: centerY - Math.cos(t) * radius, angle: t });
    } else {
      result.push({ x: Math.sin(t) * radius, y: centerY + Math.cos(t) * radius, angle: -t });
    }
    offset += width;
  }
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function measureContext() {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d');
}

export class TextLayer {
  constructor({ id = '', name = '文字', x = 0, y = 0, rotation = 0, opacity = 1, visible = true, locked = false, blend = 'source-over', clipped = false, ...text } = {}) {
    this.id = id || `tx-${(seq += 1)}`;
    this.name = name;
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.rotation = Number(rotation) || 0;
    this.opacity = clamp(Number(opacity) ?? 1, 0, 1);
    this.visible = visible !== false;
    this.locked = Boolean(locked);
    /** 混合模式与剪贴蒙版（D12.1）。 */
    this.blend = BLEND_IDS.has(blend) ? blend : 'source-over';
    this.clipped = Boolean(clipped);
    this.text = typeof text.text === 'string' ? text.text : TEXT_DEFAULTS.text;
    this.fontFamily = text.fontFamily || TEXT_DEFAULTS.fontFamily;
    this.fontSize = clamp(Number(text.fontSize) || TEXT_DEFAULTS.fontSize, 8, 400);
    this.fontWeight = clamp(Number(text.fontWeight) || TEXT_DEFAULTS.fontWeight, 100, 900);
    this.color = text.color || TEXT_DEFAULTS.color;
    this.lineHeight = clamp(Number(text.lineHeight) || TEXT_DEFAULTS.lineHeight, 0.8, 3);
    this.strokeWidth = clamp(Number(text.strokeWidth) || 0, 0, 40);
    this.strokeColor = text.strokeColor || TEXT_DEFAULTS.strokeColor;
    this.shadowBlur = clamp(Number(text.shadowBlur) || 0, 0, 80);
    this.shadowX = Number(text.shadowX) || 0;
    this.shadowY = Number(text.shadowY) || 0;
    this.shadowColor = text.shadowColor || TEXT_DEFAULTS.shadowColor;
    /** 路径文字弯曲度（D13.3）：正数向上拱起，负数向下弯曲。 */
    this.arc = clamp(Number(text.arc) || 0, -100, 100);
  }

  get kind() {
    return 'text';
  }

  get isText() {
    return true;
  }

  get font() {
    return `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
  }

  lines() {
    return String(this.text ?? '').split('\n');
  }

  /** 文字包围盒（文档坐标，未考虑旋转）。 */
  bounds() {
    const ctx = measureContext();
    ctx.font = this.font;
    const lines = this.lines();
    let width = 0;
    for (const line of lines) width = Math.max(width, ctx.measureText(line || ' ').width);
    const lineHeight = this.fontSize * this.lineHeight;
    const pad = this.strokeWidth + this.shadowBlur;
    if (this.arc) {
      // 弯曲时宽度会随弧线收窄/外扩，给一个保守包围盒，保证可点选。
      const extra = (Math.abs(this.arc) / 100) * this.fontSize * 2.4;
      return {
        x: this.x - width / 2 - extra - pad,
        y: this.y - this.fontSize * 0.9 - extra - pad,
        width: Math.max(8, width + (extra + pad) * 2),
        height: Math.max(8, lineHeight * lines.length + extra + pad * 2),
      };
    }
    return {
      x: this.x - pad,
      y: this.y - pad,
      width: Math.max(8, width + pad * 2),
      height: Math.max(8, lineHeight * lines.length + pad * 2),
    };
  }

  hitTest(px, py) {
    if (this.locked || this.visible === false) return false;
    const box = this.bounds();
    return px >= box.x && py >= box.y && px <= box.x + box.width && py <= box.y + box.height;
  }

  draw(ctx) {
    if (!ctx || this.visible === false || this.opacity <= 0 || !String(this.text || '').trim()) return;
    const lines = this.lines();
    const lineHeight = this.fontSize * this.lineHeight;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.globalCompositeOperation = this.blend || 'source-over';
    ctx.translate(this.x, this.y);
    if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180);
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (this.shadowBlur > 0) {
      ctx.shadowColor = this.shadowColor;
      ctx.shadowBlur = this.shadowBlur;
      ctx.shadowOffsetX = this.shadowX;
      ctx.shadowOffsetY = this.shadowY;
    }
    if (this.arc) {
      this._drawArc(ctx, lines, lineHeight);
    } else {
      lines.forEach((line, index) => {
        const y = index * lineHeight;
        if (this.strokeWidth > 0) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = this.strokeWidth;
          ctx.strokeStyle = this.strokeColor;
          ctx.strokeText(line, 0, y);
        }
        ctx.fillStyle = this.color;
        ctx.fillText(line, 0, y);
      });
    }
    ctx.restore();
  }

  /** 沿圆弧逐字排布（D13.3）：每个字符单独平移 + 旋转，描边/填充与横排一致。 */
  _drawArc(ctx, lines, lineHeight) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, index) => {
      const chars = Array.from(line || ' ');
      const widths = chars.map((char) => ctx.measureText(char).width);
      const placements = arcLayout(widths, this.arc);
      const lineOffset = index * lineHeight;
      placements.forEach((placement, charIndex) => {
        ctx.save();
        ctx.translate(placement.x, lineOffset + placement.y);
        ctx.rotate(placement.angle);
        const char = chars[charIndex];
        if (this.strokeWidth > 0) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = this.strokeWidth;
          ctx.strokeStyle = this.strokeColor;
          ctx.strokeText(char, 0, 0);
        }
        ctx.fillStyle = this.color;
        ctx.fillText(char, 0, 0);
        ctx.restore();
      });
    });
  }

  clone({ fresh = false } = {}) {
    return new TextLayer({
      id: fresh ? '' : this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      opacity: this.opacity,
      visible: this.visible,
      locked: this.locked,
      blend: this.blend,
      clipped: this.clipped,
      text: this.text,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      fontWeight: this.fontWeight,
      color: this.color,
      lineHeight: this.lineHeight,
      strokeWidth: this.strokeWidth,
      strokeColor: this.strokeColor,
      shadowBlur: this.shadowBlur,
      shadowX: this.shadowX,
      shadowY: this.shadowY,
      shadowColor: this.shadowColor,
      arc: this.arc,
    });
  }

  /** 文字层没有位图蒙版，保留接口让图层循环安全跳过。 */
  hasMask() {
    return false;
  }

  touchMask() {}
}

/** 从保存的 props 还原文字层。 */
export function textLayerFromProps(props = {}, fallbackName = '文字') {
  return new TextLayer({ ...props, name: props.name || fallbackName });
}
