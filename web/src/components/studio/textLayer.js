/**
 * 文字图层（D11.2）：一个可反复编辑的文字对象，绘制在底图/修复层之上。
 *
 * 与叠加图层的区别：不存位图，只存文本与样式，渲染时用 Canvas 2D 现场绘制，
 * 因此改字号/颜色/描边/投影都是零成本，导出与预览也走同一段代码。
 */

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function measureContext() {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d');
}

export class TextLayer {
  constructor({ id = '', name = '文字', x = 0, y = 0, rotation = 0, opacity = 1, visible = true, locked = false, ...text } = {}) {
    this.id = id || `tx-${(seq += 1)}`;
    this.name = name;
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.rotation = Number(rotation) || 0;
    this.opacity = clamp(Number(opacity) ?? 1, 0, 1);
    this.visible = visible !== false;
    this.locked = Boolean(locked);
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
    ctx.restore();
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
