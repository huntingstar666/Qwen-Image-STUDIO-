/**
 * 形状图层（D11.4）：矩形 / 椭圆 / 直线 / 箭头。
 *
 * 与文字层一样是「非破坏式」层：只存几何与样式，渲染时用 Canvas 2D 现场绘制，
 * 因此可以随时改填充、描边、线宽与圆角，也可以显隐、锁定、调不透明度、排序。
 * 几何统一用图像坐标（x, y, width, height）；直线/箭头的 width/height 表示方向，
 * 允许为负，bounds/hitTest 内部按绝对值处理。
 */

import { BLEND_IDS } from './layers.js';

export const SHAPE_KINDS = [
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'line', label: '直线' },
  { id: 'arrow', label: '箭头' },
];

export const SHAPE_DEFAULTS = {
  kind: 'rect',
  fill: '#ff3b30',
  stroke: '#ffffff',
  strokeWidth: 0,
  radius: 0,
  opacity: 1,
};

/** 几何上限（与面板滑杆共用，保证「写进去的值 = 刷新后能画出来的值」，§20.3.3）。 */
export const SHAPE_LIMITS = {
  strokeWidth: [0, 64],
  radius: [0, 400],
};

/** 图层样式默认值（D12.2）：外阴影 / 外发光 / 渐变叠加 / 颜色叠加。 */
export const SHAPE_STYLE_DEFAULTS = {
  shadow: { enabled: false, color: '#000000', blur: 18, distance: 10, angle: 135 },
  glow: { enabled: false, color: '#f6c85f', blur: 18 },
  gradient: { enabled: false, from: '#ff3b30', to: '#7aa2ff', angle: 90, opacity: 1 },
  colorOverlay: { enabled: false, color: '#000000', opacity: 0.4 },
};

/** 数值兜底：非法值回退默认，再夹到区间，避免 NaN 进入 Canvas 属性。 */
function numberOr(value, fallback, min, max) {
  const numeric = Number(value);
  return clamp(Number.isFinite(numeric) ? numeric : fallback, min, max);
}

/** 深合并样式，忽略未知字段，数值夹在合理区间。 */
export function normalizeShapeStyle(style = {}) {
  const base = SHAPE_STYLE_DEFAULTS;
  const shadow = style.shadow || {};
  const glow = style.glow || {};
  const gradient = style.gradient || {};
  const overlay = style.colorOverlay || {};
  return {
    shadow: {
      enabled: Boolean(shadow.enabled),
      color: shadow.color || base.shadow.color,
      blur: numberOr(shadow.blur, base.shadow.blur, 0, 120),
      distance: numberOr(shadow.distance, base.shadow.distance, 0, 200),
      angle: numberOr(shadow.angle, base.shadow.angle, -360, 360),
    },
    glow: {
      enabled: Boolean(glow.enabled),
      color: glow.color || base.glow.color,
      blur: numberOr(glow.blur, base.glow.blur, 0, 120),
    },
    gradient: {
      enabled: Boolean(gradient.enabled),
      from: gradient.from || base.gradient.from,
      to: gradient.to || base.gradient.to,
      angle: numberOr(gradient.angle, base.gradient.angle, -360, 360),
      opacity: numberOr(gradient.opacity, base.gradient.opacity, 0, 1),
    },
    colorOverlay: {
      enabled: Boolean(overlay.enabled),
      color: overlay.color || base.colorOverlay.color,
      opacity: numberOr(overlay.opacity, base.colorOverlay.opacity, 0, 1),
    },
  };
}

const KIND_IDS = new Set(SHAPE_KINDS.map((item) => item.id));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

/** 十六进制颜色转带透明度的 rgba，用于阴影/发光（颜色选择器不支持 alpha）。 */
function withAlpha(color, alpha) {
  if (!color) return `rgba(0, 0, 0, ${alpha})`;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((char) => char + char).join('') : hex;
    const num = Number.parseInt(full, 16);
    if (Number.isFinite(num)) {
      return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
    }
  }
  return color;
}

function normalizeBox(x, y, width, height) {
  return {
    x: Math.min(x, x + width),
    y: Math.min(y, y + height),
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

/** 圆角矩形路径（避免依赖 roundRect 的浏览器差异）。 */
function roundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (r <= 0.01) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

let seq = 0;

export class ShapeLayer {
  constructor(options = {}) {
    // 带时间戳，避免刷新后序号归零与已恢复图层的 id 冲突。
    this.id = options.id || `sh-${Date.now().toString(36)}-${(seq += 1)}`;
    this.kind = 'shape';
    this.isShape = true;
    this.name = options.name || '形状';
    this.x = Number(options.x) || 0;
    this.y = Number(options.y) || 0;
    this.width = Number(options.width) || 0;
    this.height = Number(options.height) || 0;
    this.shape = KIND_IDS.has(options.shape) ? options.shape : SHAPE_DEFAULTS.kind;
    this.fill = options.fill || SHAPE_DEFAULTS.fill;
    this.stroke = options.stroke || SHAPE_DEFAULTS.stroke;
    this.strokeWidth = clamp(
      options.strokeWidth ?? SHAPE_DEFAULTS.strokeWidth,
      ...SHAPE_LIMITS.strokeWidth,
    );
    this.radius = clamp(options.radius ?? SHAPE_DEFAULTS.radius, ...SHAPE_LIMITS.radius);
    this.opacity = clamp(options.opacity ?? 1, 0, 1);
    this.locked = Boolean(options.locked);
    this.visible = options.visible !== false;
    /** 混合模式与剪贴蒙版（D12.1）。 */
    this.blend = BLEND_IDS.has(options.blend) ? options.blend : 'source-over';
    this.clipped = Boolean(options.clipped);
    /** 所属图层组（D23.4 L4）。 */
    this.groupId = String(options.groupId || '');
    /** 图层样式（D12.2）。 */
    this.style = normalizeShapeStyle(options.style);
  }

  get isOpenPath() {
    return this.shape === 'line' || this.shape === 'arrow';
  }

  bounds() {
    if (this.isOpenPath) {
      const pad = Math.max(4, this.strokeWidth / 2 + 2);
      return {
        x: Math.min(this.x, this.x + this.width) - pad,
        y: Math.min(this.y, this.y + this.height) - pad,
        width: Math.abs(this.width) + pad * 2,
        height: Math.abs(this.height) + pad * 2,
      };
    }
    return normalizeBox(this.x, this.y, this.width, this.height);
  }

  hitTest(px, py) {
    if (this.locked || !this.visible) return false;
    if (this.isOpenPath) {
      const x2 = this.x + this.width;
      const y2 = this.y + this.height;
      const dx = x2 - this.x;
      const dy = y2 - this.y;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? clamp(((px - this.x) * dx + (py - this.y) * dy) / lengthSq, 0, 1) : 0;
      const distance = Math.hypot(px - (this.x + dx * t), py - (this.y + dy * t));
      return distance <= Math.max(6, this.strokeWidth / 2 + 4);
    }
    const box = this.bounds();
    if (this.shape === 'ellipse') {
      const rx = box.width / 2;
      const ry = box.height / 2;
      if (rx < 1 || ry < 1) return false;
      const nx = (px - (box.x + rx)) / rx;
      const ny = (py - (box.y + ry)) / ry;
      return nx * nx + ny * ny <= 1;
    }
    return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
  }

  draw(ctx) {
    if (!this.visible || this.opacity <= 0) return;
    if (Math.abs(this.width) < 0.5 && Math.abs(this.height) < 0.5) return;
    const box = normalizeBox(this.x, this.y, this.width, this.height);
    if (!this.isOpenPath && (box.width < 0.5 || box.height < 0.5)) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
    ctx.globalCompositeOperation = this.blend || 'source-over';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 图层样式（D12.2）：先画发光/阴影剪影，再画主体。
    const style = this.style;
    if (style?.glow?.enabled) {
      this._paintSilhouetteShadow(ctx, { color: style.glow.color, blur: style.glow.blur, dx: 0, dy: 0 });
    }
    if (style?.shadow?.enabled) {
      const rad = (style.shadow.angle * Math.PI) / 180;
      this._paintSilhouetteShadow(ctx, {
        color: style.shadow.color,
        blur: style.shadow.blur,
        dx: Math.cos(rad) * style.shadow.distance,
        dy: Math.sin(rad) * style.shadow.distance,
      });
    }
    this._paintBody(ctx, box);
    ctx.restore();
  }

  /** 绘制几何路径（直线/箭头不走这里）。 */
  _trace(ctx) {
    if (this.shape === 'ellipse') {
      const box = normalizeBox(this.x, this.y, this.width, this.height);
      ctx.beginPath();
      ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
      return;
    }
    const box = normalizeBox(this.x, this.y, this.width, this.height);
    roundRectPath(ctx, box.x, box.y, box.width, box.height, this.radius);
  }

  /** 用纯色画出「剪影」，供阴影/发光只取 alpha（D12.2）。 */
  _paintSilhouette(ctx, color) {
    if (this.isOpenPath) {
      this._paintArrowStroke(ctx, color, Math.max(1, this.strokeWidth || 1), true);
      return;
    }
    this._trace(ctx);
    ctx.fillStyle = color;
    ctx.fill();
  }

  /**
   * 只让阴影落回画面：把剪影平移到画布外，再用反向 shadowOffset 把阴影投回原位。
   * shadowOffset/Blur 不受 CTM 影响，这里用 CTM 的缩放把文档单位换算成设备像素。
   */
  _paintSilhouetteShadow(ctx, { color, blur, dx, dy }) {
    const t = ctx.getTransform();
    const scale = Math.hypot(t.a, t.b) || 1;
    const shift = 10000;
    ctx.save();
    ctx.shadowColor = withAlpha(color, 0.6);
    ctx.shadowBlur = Math.max(0, blur) * scale;
    ctx.shadowOffsetX = dx * scale + shift;
    ctx.shadowOffsetY = dy * scale;
    ctx.translate(-shift / scale, 0);
    this._paintSilhouette(ctx, '#000000');
    ctx.restore();
  }

  _paintArrowStroke(ctx, color, lineWidth, withHead) {
    const x2 = this.x + this.width;
    const y2 = this.y + this.height;
    const angle = Math.atan2(this.height, this.width);
    const head = Math.max(8, lineWidth * 4);
    const backX = x2 - Math.cos(angle) * head * 0.85;
    const backY = y2 - Math.sin(angle) * head * 0.85;
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(backX, backY);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (!withHead) return;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(backX - Math.sin(angle) * head * 0.42, backY + Math.cos(angle) * head * 0.42);
    ctx.lineTo(backX + Math.sin(angle) * head * 0.42, backY - Math.cos(angle) * head * 0.42);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** 填充/描边主体；渐变叠加与颜色叠加画在主体之上（D12.2）。 */
  _paintBody(ctx, box) {
    const style = this.style;
    const alpha = ctx.globalAlpha;
    if (this.shape === 'line') {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + this.width, this.y + this.height);
      ctx.lineWidth = Math.max(1, this.strokeWidth || 1);
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
      this._paintOverlayStroke(ctx, box, style);
      return;
    }
    if (this.shape === 'arrow') {
      this._paintArrowStroke(ctx, this.stroke, Math.max(1, this.strokeWidth || 1), true);
      this._paintOverlayStroke(ctx, box, style);
      return;
    }

    this._trace(ctx);
    if (this.fill && this.fill !== 'none') {
      ctx.fillStyle = this.fill;
      ctx.fill();
    }
    if (this.strokeWidth > 0 && this.stroke && this.stroke !== 'none') {
      ctx.lineWidth = this.strokeWidth;
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
    }
    // 叠加层画在主体之上：渐变优先于颜色叠加。
    if (style?.gradient?.enabled) {
      ctx.globalAlpha = alpha * style.gradient.opacity;
      ctx.fillStyle = this._linearGradient(ctx, box, style.gradient);
      ctx.fill();
      ctx.globalAlpha = alpha;
    } else if (style?.colorOverlay?.enabled) {
      ctx.globalAlpha = alpha * style.colorOverlay.opacity;
      ctx.fillStyle = style.colorOverlay.color;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
  }

  /** 直线/箭头的叠加：在原有描边之上再描一次渐变或纯色。 */
  _paintOverlayStroke(ctx, box, style) {
    if (!style) return;
    const alpha = ctx.globalAlpha;
    if (style.gradient?.enabled) {
      ctx.globalAlpha = alpha * style.gradient.opacity;
      this._paintArrowStroke(ctx, this._linearGradient(ctx, box, style.gradient), Math.max(1, this.strokeWidth || 1), true);
      ctx.globalAlpha = alpha;
    } else if (style.colorOverlay?.enabled) {
      ctx.globalAlpha = alpha * style.colorOverlay.opacity;
      this._paintArrowStroke(ctx, style.colorOverlay.color, Math.max(1, this.strokeWidth || 1), true);
      ctx.globalAlpha = alpha;
    }
  }

  _linearGradient(ctx, box, gradient) {
    const rad = (gradient.angle * Math.PI) / 180;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const length = Math.abs(box.width * Math.cos(rad)) + Math.abs(box.height * Math.sin(rad));
    const dx = (Math.cos(rad) * length) / 2;
    const dy = (Math.sin(rad) * length) / 2;
    const paint = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    paint.addColorStop(0, gradient.from);
    paint.addColorStop(1, gradient.to);
    return paint;
  }

  clone({ fresh = false } = {}) {
    return new ShapeLayer({
      id: fresh ? '' : this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      shape: this.shape,
      fill: this.fill,
      stroke: this.stroke,
      strokeWidth: this.strokeWidth,
      radius: this.radius,
      opacity: this.opacity,
      locked: this.locked,
      visible: this.visible,
      blend: this.blend,
      clipped: this.clipped,
      groupId: this.groupId,
      style: this.style,
    });
  }

  hasMask() {
    return false;
  }

  touchMask() {}
}

/** 从工程 props 还原形状层（持久化用）。 */
export function shapeLayerFromProps(props = {}, fallbackName = '形状') {
  return new ShapeLayer({
    ...props,
    name: props.name || fallbackName,
  });
}
