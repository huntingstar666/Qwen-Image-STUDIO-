/**
 * 叠加层：主图之上可拖动 / 缩放 / 调透明度的图片（例如一张扣好的素材）。
 *
 * 约束：
 * 1. 底图永远锁定，不可移动；只有叠加层是可编辑对象；
 * 2. 坐标使用「主图图像坐标」，与 doc.renderBase() 同尺寸，导出时一起烘焙；
 * 3. 叠加层可拥有自己的蒙版（D8.2），但文档蒙版始终只作用于底图坐标系。
 */

import { quadBounds, pointInQuad, warpImageToQuad } from './perspective.js';

let seq = 0;

/** 命中检测用的 1×1 采样画布（复用，避免每次点击都新建）。 */
let hitCanvas = null;
let hitCtx = null;

function pixelAlphaAt(source, x, y) {
  try {
    if (!hitCanvas) {
      hitCanvas = document.createElement('canvas');
      hitCanvas.width = 1;
      hitCanvas.height = 1;
      hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });
    }
    hitCtx.clearRect(0, 0, 1, 1);
    hitCtx.drawImage(source, x, y, 1, 1, 0, 0, 1, 1);
    return hitCtx.getImageData(0, 0, 1, 1).data[3];
  } catch {
    // 取不到像素（跨域 / 未解码）时按不透明处理，退回几何命中。
    return 255;
  }
}

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
      quad = null,
      groupId = '',
      smart = false,
      id = '',
    } = {},
  ) {
    // 带时间戳：刷新后模块级序号会归零，纯序号会和从本机工程恢复的旧 id 撞车，
    // 导致两个图层同 id（第二个选不中、保存时互相覆盖丢层）。
    this.id = id || `ov-${Date.now().toString(36)}-${(seq += 1)}`;
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
    /**
     * 透视四角（D13.3）：顺序 (0,0)/(1,0)/(1,1)/(0,1) 的文档坐标；
     * 为 null 时按 x/y/scale/rotation 常规绘制。
     */
    this.quad = Array.isArray(quad) && quad.length === 4 ? quad.map((point) => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 })) : null;
    this._warpCache = null;
    /** 锁定后仍参与合成，但画布上不可点选/拖动（D7.3 图层面板）。 */
    this.locked = Boolean(locked);
    /** 显隐（D9.3 图层面板眼睛按钮）；隐藏的图层不参与合成。 */
    this.visible = visible !== false;
    /** 所属图层组（D23.4 L4）：空串 = 不在组内；组的显隐/不透明度/混合在合成时统一应用。 */
    this.groupId = String(groupId || '');
    /**
     * 智能对象（D23.4 L4 可选）：始终按原始位图绘制，缩放/旋转不烘焙像素；
     * 面板显示「智能」角标，可「替换内容」或「恢复原始尺寸」。
     */
    this.smart = Boolean(smart);
    /** 智能对象的原始像素尺寸（替换内容后更新，用于「原始尺寸」与信息展示）。 */
    this.sourceWidth = Number(this.image?.naturalWidth || this.image?.width) || 0;
    this.sourceHeight = Number(this.image?.naturalHeight || this.image?.height) || 0;
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
    if (this.quad) return quadBounds(this.quad);
    const width = this.width;
    const height = this.height;
    const rotation = Number(this.rotation) || 0;
    if (!rotation) return { x: this.x, y: this.y, width, height };
    // 旋转图层返回外接盒：选中框与 AI 送图区域都按它取，
    // 否则旋转后的内容会被裁掉一角（draw 以中心旋转，x/y 只是未旋转包围盒左上角）。
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const boxWidth = width * cos + height * sin;
    const boxHeight = width * sin + height * cos;
    const cx = this.x + width / 2;
    const cy = this.y + height / 2;
    return { x: cx - boxWidth / 2, y: cy - boxHeight / 2, width: boxWidth, height: boxHeight };
  }

  hitTest(px, py) {
    if (this.locked || !this.visible) return false;
    if (this.quad) return pointInQuad(this.quad, px, py);
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

  /**
   * 像素级命中：几何命中后再看该点像素的 alpha（D23.7）。
   *
   * 抠图层是带大片透明像素的 PNG，若只按外框判定，上层抠图的透明区域会挡住
   * 下层图层的可见内容，表现为「双击下层没反应」。这里让透明处可以点穿。
   * 透视层保持几何命中（重采样成本高，且四角通常贴合内容）。
   */
  hitTestPixel(px, py) {
    if (!this.hitTest(px, py)) return false;
    if (this.quad) return true;
    const source = this.maskedImage();
    const nw = source?.naturalWidth || source?.width || 0;
    const nh = source?.naturalHeight || source?.height || 0;
    if (!nw || !nh) return false;
    const width = this.width;
    const height = this.height;
    if (width < 1 || height < 1) return false;
    const scale = Math.max(0.0001, this.scale || 1);
    const cx = this.x + width / 2;
    const cy = this.y + height / 2;
    const rad = (-(this.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    let ix = Math.floor((lx + width / 2) / scale);
    let iy = Math.floor((ly + height / 2) / scale);
    if (this.flipH) ix = nw - 1 - ix;
    if (this.flipV) iy = nh - 1 - iy;
    if (ix < 0 || iy < 0 || ix >= nw || iy >= nh) return false;
    return pixelAlphaAt(source, ix, iy) > 8;
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

  /** 透视四角版本的位图（带缓存，四角或蒙版变化才重新采样）。 */
  warpedQuad() {
    if (!this.quad) return null;
    const source = this.maskedImage();
    const signature = this.quad
      .map((point) => `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`)
      .join(';');
    if (this._warpCache && this._warpCache.source === source && this._warpCache.signature === signature) {
      return this._warpCache.result;
    }
    const result = warpImageToQuad(source, this.quad);
    this._warpCache = { source, signature, result };
    return result;
  }

  draw(ctx) {
    if (!this.image || !this.visible || this.opacity <= 0) return;
    if (this.quad) {
      const warped = this.warpedQuad();
      if (!warped) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
      ctx.globalCompositeOperation = this.blend || 'source-over';
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        warped.canvas,
        warped.x,
        warped.y,
        warped.canvas.width / (warped.scale || 1),
        warped.canvas.height / (warped.scale || 1),
      );
      ctx.restore();
      return;
    }
    if (this.width < 1 || this.height < 1) return;
    const source = this.maskedImage();
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, this.opacity));
    ctx.globalCompositeOperation = this.blend || 'source-over';
    // 智能对象放大时用高质量重采样，避免大图放大出现明显锯齿。
    if (this.smart) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
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
      groupId: this.groupId,
      smart: this.smart,
      quad: this.quad ? this.quad.map((point) => ({ ...point })) : null,
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
