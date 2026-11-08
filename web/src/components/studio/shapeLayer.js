/**
 * 形状图层（D11.4）：矩形 / 椭圆 / 直线 / 箭头。
 *
 * 与文字层一样是「非破坏式」层：只存几何与样式，渲染时用 Canvas 2D 现场绘制，
 * 因此可以随时改填充、描边、线宽与圆角，也可以显隐、锁定、调不透明度、排序。
 * 几何统一用图像坐标（x, y, width, height）；直线/箭头的 width/height 表示方向，
 * 允许为负，bounds/hitTest 内部按绝对值处理。
 */

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

const KIND_IDS = new Set(SHAPE_KINDS.map((item) => item.id));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
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
    this.id = options.id || `sh-${(seq += 1)}`;
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
    this.strokeWidth = clamp(options.strokeWidth ?? SHAPE_DEFAULTS.strokeWidth, 0, 64);
    this.radius = clamp(options.radius ?? SHAPE_DEFAULTS.radius, 0, 400);
    this.opacity = clamp(options.opacity ?? 1, 0, 1);
    this.locked = Boolean(options.locked);
    this.visible = options.visible !== false;
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
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (this.shape === 'rect') {
      const box = normalizeBox(this.x, this.y, this.width, this.height);
      if (box.width < 0.5 || box.height < 0.5) {
        ctx.restore();
        return;
      }
      roundRectPath(ctx, box.x, box.y, box.width, box.height, this.radius);
      this._fillAndStroke(ctx, true);
    } else if (this.shape === 'ellipse') {
      const box = normalizeBox(this.x, this.y, this.width, this.height);
      if (box.width < 0.5 || box.height < 0.5) {
        ctx.restore();
        return;
      }
      ctx.beginPath();
      ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
      this._fillAndStroke(ctx, true);
    } else if (this.shape === 'line') {
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(this.x + this.width, this.y + this.height);
      ctx.lineWidth = Math.max(1, this.strokeWidth || 1);
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
    } else {
      // 箭头：主杆 + 实心三角箭头，颜色统一用描边色。
      const x2 = this.x + this.width;
      const y2 = this.y + this.height;
      const angle = Math.atan2(this.height, this.width);
      const lineWidth = Math.max(1, this.strokeWidth || 1);
      const head = Math.max(8, lineWidth * 4);
      const backX = x2 - Math.cos(angle) * head * 0.85;
      const backY = y2 - Math.sin(angle) * head * 0.85;
      ctx.beginPath();
      ctx.moveTo(this.x, this.y);
      ctx.lineTo(backX, backY);
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(backX - Math.sin(angle) * head * 0.42, backY + Math.cos(angle) * head * 0.42);
      ctx.lineTo(backX + Math.sin(angle) * head * 0.42, backY - Math.cos(angle) * head * 0.42);
      ctx.closePath();
      ctx.fillStyle = this.stroke;
      ctx.fill();
    }
    ctx.restore();
  }

  _fillAndStroke(ctx, allowFill) {
    if (allowFill && this.fill && this.fill !== 'none') {
      ctx.fillStyle = this.fill;
      ctx.fill();
    }
    if (this.strokeWidth > 0 && this.stroke && this.stroke !== 'none') {
      ctx.lineWidth = this.strokeWidth;
      ctx.strokeStyle = this.stroke;
      ctx.stroke();
    }
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
