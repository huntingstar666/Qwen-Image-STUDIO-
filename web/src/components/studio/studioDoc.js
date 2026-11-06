/**
 * 图片精修的「文档模型」（非破坏式）。
 *
 * 设计原则：
 * 1. 原图永远不改，所有编辑都记录为状态：transform（旋转/翻转/裁剪）+ adjust（调色）+ mask（蒙版）；
 * 2. 渲染与导出共用同一套绘制逻辑，所见即所得；
 * 3. 撤销/重做采用状态快照（含蒙版画布副本），上限 30 步，避免内存失控；
 * 4. 蒙版保存在「旋转后」的坐标空间里，旋转/翻转/裁剪时同步变换，保证始终贴合画面。
 *
 * 该模块不依赖 DOM 事件，方便后续替换成后端渲染或单元测试。
 */

export const ADJUST_DEFAULTS = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
};

const HISTORY_LIMIT = 30;

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function cloneCanvas(source) {
  const next = makeCanvas(source.width, source.height);
  next.getContext('2d').drawImage(source, 0, 0);
  return next;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class StudioDoc {
  /**
   * @param {HTMLImageElement} image 已 decode 完成的图片
   * @param {string} name 文件名，用于导出与收藏标题
   */
  constructor(image, name = 'untitled.png') {
    this.image = image;
    this.name = name;
    this.transform = { rotate: 0, flipH: false, flipV: false, crop: null };
    this.adjust = { ...ADJUST_DEFAULTS };
    this.mask = makeCanvas(this.oriented.width, this.oriented.height);
    this.history = [];
    this.future = [];
    this._base = null;
    this.snapshot();
  }

  /* ---------------------------------------------------------- 尺寸 */

  get sourceSize() {
    return { width: this.image.naturalWidth || this.image.width, height: this.image.naturalHeight || this.image.height };
  }

  /** 旋转后的尺寸（未裁剪） */
  get oriented() {
    const { width, height } = this.sourceSize;
    return this.transform.rotate % 180 !== 0 ? { width: height, height: width } : { width, height };
  }

  /** 最终输出尺寸（含裁剪） */
  get size() {
    const oriented = this.oriented;
    const crop = this.transform.crop;
    if (!crop) return oriented;
    return { width: Math.round(crop.width), height: Math.round(crop.height) };
  }

  /* ---------------------------------------------------------- 状态快照 */

  snapshot() {
    this.history.push({
      transform: { ...this.transform, crop: this.transform.crop ? { ...this.transform.crop } : null },
      adjust: { ...this.adjust },
      mask: cloneCanvas(this.mask),
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future.length = 0;
    this._base = null;
    return this;
  }

  restore(state) {
    this.transform = { ...state.transform, crop: state.transform.crop ? { ...state.transform.crop } : null };
    this.adjust = { ...state.adjust };
    this.mask = cloneCanvas(state.mask);
    this._base = null;
    this._maskHas = null;
  }

  get canUndo() {
    return this.history.length > 1;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  undo() {
    if (!this.canUndo) return false;
    this.future.push(this.history.pop());
    this.restore(this.history[this.history.length - 1]);
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    const state = this.future.pop();
    this.history.push(state);
    this.restore(state);
    return true;
  }

  /* ---------------------------------------------------------- 变换 */

  rotateRight() {
    this.transform.rotate = (this.transform.rotate + 90) % 360;
    this.transform.crop = null;
    this.rotateMaskRight();
    this._maskHas = null;
    this.snapshot();
  }

  rotateLeft() {
    this.transform.rotate = (this.transform.rotate + 270) % 360;
    this.transform.crop = null;
    this.rotateMaskLeft();
    this._maskHas = null;
    this.snapshot();
  }

  flip(axis) {
    if (axis === 'h') {
      this.transform.flipH = !this.transform.flipH;
      this.flipMask('h');
    } else {
      this.transform.flipV = !this.transform.flipV;
      this.flipMask('v');
    }
    this.transform.crop = null;
    this._maskHas = null;
    this.snapshot();
  }

  /**
   * @param {{x:number,y:number,width:number,height:number}} rect 旋转后坐标系里的裁剪矩形
   */
  applyCrop(rect) {
    const oriented = this.oriented;
    const x = clamp(Math.round(rect.x), 0, oriented.width - 8);
    const y = clamp(Math.round(rect.y), 0, oriented.height - 8);
    const width = clamp(Math.round(rect.width), 8, oriented.width - x);
    const height = clamp(Math.round(rect.height), 8, oriented.height - y);
    this.transform.crop = { x, y, width, height };
    this.snapshot();
  }

  clearCrop() {
    if (!this.transform.crop) return;
    this.transform.crop = null;
    this.snapshot();
  }

  resetAll() {
    this.transform = { rotate: 0, flipH: false, flipV: false, crop: null };
    this.adjust = { ...ADJUST_DEFAULTS };
    this.mask = makeCanvas(this.oriented.width, this.oriented.height);
    this._maskHas = null;
    this.snapshot();
  }

  /* ---------------------------------------------------------- 蒙版 */

  get maskSize() {
    return { width: this.mask.width, height: this.mask.height };
  }

  clearMask() {
    const ctx = this.mask.getContext('2d');
    ctx.clearRect(0, 0, this.mask.width, this.mask.height);
    this._maskHas = false;
    this.snapshot();
  }

  /**
   * UI 直接修改蒙版画布后调用，让 hasMask 缓存失效。
   * @param {boolean} [painted] 明确知道刚画上了蒙版时传 true，避免每帧全图扫描。
   */
  markMaskChanged(painted = false) {
    this._maskHas = painted ? true : null;
  }

  hasMask() {
    if (this._maskHas === undefined || this._maskHas === null) {
      this._maskHas = this._computeHasMask();
    }
    return this._maskHas;
  }

  _computeHasMask() {
    const { width, height } = this.mask;
    if (!width || !height) return false;
    const data = this.mask.getContext('2d').getImageData(0, 0, width, height).data;
    const step = 4 * 4;
    for (let i = 3; i < data.length; i += step) {
      if (data[i] > 4) return true;
    }
    return false;
  }

  maskCoverage() {
    const { width, height } = this.mask;
    if (!width || !height) return 0;
    const data = this.mask.getContext('2d').getImageData(0, 0, width, height).data;
    let hit = 0;
    let total = 0;
    for (let i = 3; i < data.length; i += 4 * 4) {
      total += 1;
      if (data[i] > 8) hit += 1;
    }
    return total ? hit / total : 0;
  }

  maskCanvas() {
    const oriented = this.oriented;
    const crop = this.transform.crop;
    if (!crop) {
      if (this.mask.width === oriented.width && this.mask.height === oriented.height) return this.mask;
      // 尺寸不一致时（理论上不会发生）按左上角对齐兜底
      const next = makeCanvas(oriented.width, oriented.height);
      next.getContext('2d').drawImage(this.mask, 0, 0);
      return next;
    }
    const next = makeCanvas(crop.width, crop.height);
    next.getContext('2d').drawImage(this.mask, -crop.x, -crop.y);
    return next;
  }

  rotateMaskRight() {
    const source = this.mask;
    const next = makeCanvas(source.height, source.width);
    const ctx = next.getContext('2d');
    ctx.translate(next.width / 2, next.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    this.mask = next;
  }

  rotateMaskLeft() {
    const source = this.mask;
    const next = makeCanvas(source.height, source.width);
    const ctx = next.getContext('2d');
    ctx.translate(next.width / 2, next.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    this.mask = next;
  }

  flipMask(axis) {
    const source = this.mask;
    const next = makeCanvas(source.width, source.height);
    const ctx = next.getContext('2d');
    if (axis === 'h') {
      ctx.translate(source.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, source.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(source, 0, 0);
    this.mask = next;
  }

  /* ---------------------------------------------------------- 渲染 */

  /** 调色等状态被外部修改后调用，丢弃合成缓存。 */
  invalidateBase() {
    this._base = null;
  }

  /**
   * 输出「原图 + 变换 + 调色」的合成画布（不含蒙版，不含裁剪以外的遮罩）。
   * 结果缓存，供画布展示与导出复用。
   */
  renderBase() {
    if (this._base) return this._base;
    const oriented = this.oriented;
    let canvas = makeCanvas(oriented.width, oriented.height);
    const ctx = canvas.getContext('2d');
    const img = this.image;
    const { rotate, flipH, flipV } = this.transform;
    const adjust = this.adjust;

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (ctx.filter !== undefined) {
      const brightness = Math.pow(2, adjust.exposure / 100) * (1 + adjust.brightness / 100);
      const contrast = 1 + adjust.contrast / 100;
      const saturation = 1 + adjust.saturation / 100;
      ctx.filter = `brightness(${Math.max(0, brightness)}) contrast(${Math.max(0, contrast)}) saturate(${Math.max(0, saturation)})`;
    }
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2, img.naturalWidth, img.naturalHeight);
    ctx.restore();
    if (ctx.filter !== undefined) ctx.filter = 'none';

    // 色温 / 色调：Canvas filter 不支持，用 soft-light 叠加近似
    if (adjust.temperature || adjust.tint) {
      if (adjust.temperature) {
        ctx.save();
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = Math.min(0.5, Math.abs(adjust.temperature) / 100 * 0.5);
        ctx.fillStyle = adjust.temperature > 0 ? '#ff9a4d' : '#4d9aff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      if (adjust.tint) {
        ctx.save();
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = Math.min(0.45, Math.abs(adjust.tint) / 100 * 0.45);
        ctx.fillStyle = adjust.tint > 0 ? '#ff4dd2' : '#4dff9a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    }

    const crop = this.transform.crop;
    if (crop) {
      const cropped = makeCanvas(crop.width, crop.height);
      cropped.getContext('2d').drawImage(canvas, -crop.x, -crop.y);
      canvas = cropped;
    }
    this._base = canvas;
    return canvas;
  }

  /** 蒙版着色图（红色 35%），用于画布叠加显示。 */
  renderMaskTint() {
    const mask = this.maskCanvas();
    const tint = makeCanvas(mask.width, mask.height);
    const ctx = tint.getContext('2d');
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(0, 0, tint.width, tint.height);
    return tint;
  }

  /* ---------------------------------------------------------- 导出 */

  /**
   * @param {'image/png'|'image/jpeg'} type
   * @param {number} [quality]
   */
  bake(type = 'image/png', quality = 0.92) {
    const base = this.renderBase();
    if (type === 'image/jpeg') {
      const flat = makeCanvas(base.width, base.height);
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(base, 0, 0);
      return flat.toDataURL(type, quality);
    }
    return base.toDataURL(type);
  }

  maskPng() {
    if (!this.hasMask()) return null;
    return this.maskCanvas().toDataURL('image/png');
  }
}
