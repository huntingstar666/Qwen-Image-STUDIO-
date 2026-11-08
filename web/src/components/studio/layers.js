/**
 * 叠加层：主图之上可拖动 / 缩放 / 调透明度的图片（例如一张扣好的素材）。
 *
 * 约束：
 * 1. 底图永远锁定，不可移动；只有叠加层是可编辑对象；
 * 2. 坐标使用「主图图像坐标」，与 doc.renderBase() 同尺寸，导出时一起烘焙；
 * 3. 叠加层可拥有自己的蒙版（D8.2），但文档蒙版始终只作用于底图坐标系。
 */

let seq = 0;

/** 贴纸/叠加层可用的混合模式（D11.3），id 直接作为 Canvas globalCompositeOperation。 */
export const BLEND_MODES = [
  { id: 'source-over', label: '正常' },
  { id: 'multiply', label: '正片叠底' },
  { id: 'screen', label: '滤色' },
  { id: 'overlay', label: '叠加' },
  { id: 'soft-light', label: '柔光' },
  { id: 'hard-light', label: '强光' },
  { id: 'color-dodge', label: '颜色减淡' },
  { id: 'color-burn', label: '颜色加深' },
  { id: 'difference', label: '差值' },
];

export const BLEND_IDS = new Set(BLEND_MODES.map((mode) => mode.id));

export class OverlayLayer {
  constructor(
    image,
    {
      name = '叠加图',
      x = 0,
      y = 0,
      scale = 1,
      opacity = 1,
      rotation = 0,
      flipH = false,
      flipV = false,
      blend = 'source-over',
      locked = false,
      visible = true,
      clipped = false,
      id = '',
    } = {},
  ) {
    this.id = id || `ov-${(seq += 1)}`;
    this.image = image;
    this.name = name;
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.scale = Number(scale) || 1;
    this.opacity = opacity === undefined ? 1 : Number(opacity);
    this.rotation = Number(rotation) || 0;
    /** 贴纸翻转（D11.3）：围绕图层中心镜像，不影响 x/y/scale。 */
    this.flipH = Boolean(flipH);
    this.flipV = Boolean(flipV);
    /** 混合模式（D11.3），默认正常。 */
    this.blend = BLEND_IDS.has(blend) ? blend : 'source-over';
    /** 剪贴蒙版（D12.1）：只显示在下方图层的非透明区域内。 */
    this.clipped = Boolean(clipped);
    /** 锁定后仍参与合成，但画布上不可点选/拖动（D7.3 图层面板）。 */
    this.locked = Boolean(locked);
    /** 显隐（D9.3 图层面板眼睛按钮）；隐藏的图层不参与合成。 */
    this.visible = visible !== false;
    /**
     * 图层蒙版（D8.2）：尺寸等于图层原图像素，白色 = 显示，黑色 = 隐藏；
     * 只在 draw() 合成时应用，不改变图层几何。
     */
    this.mask = null;
    this.maskVisible = true;
    this._masked = null;
  }

  get width() {
    return (this.image?.naturalWidth || this.image?.width || 0) * this.scale;
  }

  get height() {
    return (this.image?.naturalHeight || this.image?.height || 0) * this.scale;
  }

  get naturalWidth() {
    return this.image?.naturalWidth || this.image?.width || 0;
  }

  get naturalHeight() {
    return this.image?.naturalHeight || this.image?.height || 0;
  }

  bounds() {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  hitTest(px, py) {
    if (this.locked || !this.visible) return false;
    const width = this.width;
    const height = this.height;
    if (width < 1 || height < 1) return false;
    // 旋转后按图层本地坐标判断，避免 AABB 把角落外的点击也算命中（D11.3）。
    const cx = this.x + width / 2;
    const cy = this.y + height / 2;
    const rad = (-(this.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) <= width / 2 && Math.abs(ly) <= height / 2;
  }

  hasMask() {
    return Boolean(this.mask);
  }

  /** 创建全白蒙版（= 完全显示），已存在则直接返回。 */
  ensureMask() {
    if (this.mask) return this.mask;
    const width = Math.max(1, this.naturalWidth);
    const height = Math.max(1, this.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    this.mask = canvas;
    this._masked = null;
    return canvas;
  }

  /** 蒙版被涂抹后调用，丢弃合成缓存。 */
  touchMask() {
    this._masked = null;
  }

  toggleMaskVisible() {
    if (!this.mask) return false;
    this.maskVisible = !this.maskVisible;
    return this.maskVisible;
  }

  removeMask() {
    this.mask = null;
    this.maskVisible = true;
    this._masked = null;
  }

  /** 应用蒙版后的位图（缓存）；无蒙版或关闭蒙版时直接用原图。 */
  maskedImage() {
    if (!this.mask || !this.maskVisible) return this.image;
    if (this._masked) return this._masked;
    const width = Math.max(1, this.naturalWidth);
    const height = Math.max(1, this.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.image, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.mask, 0, 0, width, height);
    this._masked = canvas;
    return canvas;
  }

  draw(ctx) {
    if (!this.image || !this.visible || this.opacity <= 0 || this.width < 1 || this.height < 1) return;
    const source = this.maskedImage();
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
    ctx.globalCompositeOperation = this.blend || 'source-over';
    if (this.rotation || this.flipH || this.flipV) {
      ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
      if (this.rotation) ctx.rotate((this.rotation * Math.PI) / 180);
      if (this.flipH || this.flipV) ctx.scale(this.flipH ? -1 : 1, this.flipV ? -1 : 1);
      ctx.drawImage(source, -this.width / 2, -this.height / 2, this.width, this.height);
    } else {
      ctx.drawImage(source, this.x, this.y, this.width, this.height);
    }
    ctx.restore();
  }

  /** @param {{ fresh?: boolean }} [options] fresh = true 时生成新 id（复制图层用） */
  clone({ fresh = false } = {}) {
    const copy = new OverlayLayer(this.image, {
      id: fresh ? '' : this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      scale: this.scale,
      opacity: this.opacity,
      rotation: this.rotation,
      flipH: this.flipH,
      flipV: this.flipV,
      blend: this.blend,
      locked: this.locked,
      visible: this.visible,
      clipped: this.clipped,
    });
    if (this.mask) {
      const canvas = document.createElement('canvas');
      canvas.width = this.mask.width;
      canvas.height = this.mask.height;
      canvas.getContext('2d').drawImage(this.mask, 0, 0);
      copy.mask = canvas;
    }
    copy.maskVisible = this.maskVisible;
    return copy;
  }
}
