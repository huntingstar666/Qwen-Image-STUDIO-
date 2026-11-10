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

import { OverlayLayer } from './layers.js';
import {
  addLayer,
  cloneLayer,
  createDocument,
  findLayer as findDocLayer,
  layerCount,
  layersOf,
  moveLayer,
  removeLayer,
} from './document.js';
import { createHistory } from './history.js';
import { composite, drawLayers } from './renderer.js';
import { applyCube } from './color.js';
import { AdjustmentLayer, applyAdjustmentLayer, normalizeAdjustment } from './adjustments.js';
import { TextLayer } from './textLayer.js';
import { ShapeLayer } from './shapeLayer.js';

export const ADJUST_DEFAULTS = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  /** D9.2：{name, size, cube, strength}，null 表示未加载 3D LUT */
  lut: null,
};

const HISTORY_LIMIT = 30;
const HISTORY_BUDGET = 256 * 1024 * 1024;

/** 图层组 id 序号（与图层 id 一样带时间戳，避免刷新后撞车）。 */
let groupSeq = 0;

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

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), type, quality);
  });
}

/**
 * 旧版 Safari 不支持 Canvas filter，赋值后读回仍是 'none'。
 * 模块加载时探测一次，渲染与 UI 共用同一结论，避免「滑杆有反应但画面没变」。
 */
export const supportsCanvasFilter = (() => {
  try {
    const probe = document.createElement('canvas').getContext('2d');
    if (!probe) return false;
    probe.filter = 'brightness(0.5)';
    return probe.filter === 'brightness(0.5)';
  } catch {
    return false;
  }
})();

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
    /** D23.1：主图（背景层）显隐；false 时导出为透明底 */
    this.baseVisible = true;
    /** 污点修复图层（D10.1）：与原图同尺寸，透明处不覆盖底图 */
    this.repair = null;
    /**
     * 蒙版 / 修复层的像素版本号：每次真正改像素时自增。
     * 自动保存据此复用同一份 Blob，避免「有蒙版就整条重写」（签名不再每次变化）。
     */
    this.maskVersion = 0;
    this.repairVersion = 0;
    /** 叠加层图层栈（底图不在其中，底图永远锁定）；见 document.js */
    this._doc = createDocument({ width: this.oriented.width, height: this.oriented.height });
    this._history = createHistory({ limit: HISTORY_LIMIT, budget: HISTORY_BUDGET });
    this._base = null;
    this._clean = null;
    this.snapshot();
  }

  /* ---------------------------------------------------------- 图层栈 */

  /** @type {OverlayLayer[]} 0 为最底层，末尾为最上层 */
  get layers() {
    return layersOf(this._doc);
  }

  set layers(next) {
    this._doc.layers = Array.isArray(next) ? next : [];
    this._doc.activeId = '';
  }

  /** 图层组（D23.4 L4）：[{ id, name, visible, opacity, blend, collapsed }] */
  get groups() {
    if (!Array.isArray(this._doc.groups)) this._doc.groups = [];
    return this._doc.groups;
  }

  set groups(next) {
    this._doc.groups = Array.isArray(next) ? next : [];
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
    const bytes = this.mask.width * this.mask.height * 4;
    const state = {
      transform: { ...this.transform, crop: this.transform.crop ? { ...this.transform.crop } : null },
      adjust: { ...this.adjust },
      // 记录当时的整图尺寸：换主图后旧快照尺寸对不上，恢复会错位，需拒绝。
      oriented: { width: this.oriented.width, height: this.oriented.height },
      mask: cloneCanvas(this.mask),
      /** 污点修复层（D10.1）：透明 = 未修，像素 = 已修 */
      repair: this.repair ? cloneCanvas(this.repair) : null,
      layers: this.layers.map((layer) => layer.clone()),
      groups: this.groups.map((group) => ({ ...group })),
      bytes,
    };
    this._history.push(state);
    this._base = null;
    return this;
  }

  restore(state) {
    if (!this._canRestore(state)) return false;
    this.transform = { ...state.transform, crop: state.transform.crop ? { ...state.transform.crop } : null };
    this.adjust = { ...state.adjust };
    this.mask = cloneCanvas(state.mask);
    this.repair = state.repair ? cloneCanvas(state.repair) : null;
    this.layers = (state.layers || []).map((layer) => layer.clone());
    this.groups = (state.groups || []).map((group) => ({ ...group }));
    this._base = null;
    this._underlay = null;
    this._clean = null;
    this._tint = null;
    this._maskHas = null;
    this.maskVersion += 1;
    this.repairVersion += 1;
    return true;
  }

  get canUndo() {
    return this._history.canUndo;
  }

  get canRedo() {
    return this._history.canRedo;
  }

  /** 历史总字节占用（调试 / 台账用） */
  get historyBytes() {
    return this._history.bytes;
  }

  undo() {
    const state = this._history.undo();
    if (!state) return false;
    this.restore(state);
    return true;
  }

  redo() {
    const state = this._history.redo();
    if (!state) return false;
    this.restore(state);
    return true;
  }

  /** 清空历史（工程恢复后用，避免旧快照串项目） */
  clearHistory() {
    this._history.clear();
  }

  /** 命名快照列表（D12.3），元素为 {id, name, state, at}。 */
  get snapshots() {
    return this._history.snapshots;
  }

  /** 把当前状态另存为命名快照（不占撤销步数）。 */
  addSnapshot(name = '') {
    const past = this._history.past;
    const state = past[past.length - 1];
    if (!state) return null;
    return this._history.addSnapshot(state, name);
  }

  /**
   * 快照属于哪张主图：尺寸不一致时不能恢复。
   * 换主图后旧快照里的图层坐标 / 蒙版尺寸都是上一张图的，硬恢复会整体错位。
   */
  _canRestore(state) {
    const target = state?.oriented;
    if (!target) return true;
    return target.width === this.oriented.width && target.height === this.oriented.height;
  }

  /** 回跳到命名快照：先把当前状态入栈，所以回跳本身也能撤销。 */
  restoreSnapshot(id) {
    const item = this._history.findSnapshot(id);
    if (!item) return false;
    if (!this._canRestore(item.state)) return false;
    this.snapshot();
    this.restore(item.state);
    return true;
  }

  renameSnapshot(id, name) {
    const item = this._history.findSnapshot(id);
    if (!item) return false;
    const next = String(name || '').trim();
    if (!next) return false;
    item.name = next.slice(0, 60);
    return true;
  }

  removeSnapshot(id) {
    return this._history.removeSnapshot(id);
  }

  /** 默认快照名（避免删除后重名）。 */
  nextSnapshotName() {
    return this._history.nextSnapshotName();
  }

  /* ---------------------------------------------------------- 变换 */

  rotateRight() {
    const old = this.oriented;
    this.transform.rotate = (this.transform.rotate + 90) % 360;
    this.transform.crop = null;
    // 图层跟着一起转：不再清空图层（与「主图 = 仅底图」模型一致）。
    this._rotateLayersBy90(old, 1);
    this.rotateMaskRight();
    this.rotateRepairRight();
    this._maskHas = null;
    // 旋转会改变底图几何：干净底图 / underlay 缓存必须一起丢掉，
    // 只清 _base 会让 renderBase 仍返回旋转前的整张图（裁剪后尺寸也会对不上）。
    this.invalidateBase();
    this.snapshot();
  }

  rotateLeft() {
    const old = this.oriented;
    this.transform.rotate = (this.transform.rotate + 270) % 360;
    this.transform.crop = null;
    this._rotateLayersBy90(old, -1);
    this.rotateMaskLeft();
    this.rotateRepairLeft();
    this._maskHas = null;
    this.invalidateBase();
    this.snapshot();
  }

  flip(axis) {
    if (axis === 'h') {
      this.transform.flipH = !this.transform.flipH;
      this.flipMask('h');
      this.flipRepair('h');
    } else {
      this.transform.flipV = !this.transform.flipV;
      this.flipMask('v');
      this.flipRepair('v');
    }
    this.transform.crop = null;
    // 图层一起镜像（位置 + 自身翻转），不再清空。
    this._flipLayerGeometry(axis);
    this._maskHas = null;
    this.invalidateBase();
    this.snapshot();
  }

  /**
   * 一次 90° 旋转后换算图层几何。
   * 图层坐标属于「旋转后未裁剪」空间，按中心点映射并累加自身旋转角；
   * 形状层没有旋转角，改为交换宽高。
   * @param {{width:number,height:number}} old 旋转前的 oriented 尺寸
   * @param {1|-1} direction 1 = 顺时针（右转），-1 = 逆时针（左转）
   */
  _rotateLayersBy90(old, direction) {
    const W = old.width;
    const H = old.height;
    const oriented = this.oriented;
    // 图层文档尺寸跟随旋转后的整图，保持与 replaceMainImage 一致。
    this._doc.width = oriented.width;
    this._doc.height = oriented.height;
    const mapPoint =
      direction > 0 ? (x, y) => ({ x: H - y, y: x }) : (x, y) => ({ x: y, y: W - x });
    (this.layers || []).forEach((layer) => {
      if (!layer) return;
      if (layer.isAdjustment) {
        // 调整层覆盖整幅画面：范围跟随新尺寸，旧蒙版属于旧坐标，作废。
        layer.width = Math.max(1, oriented.width);
        layer.height = Math.max(1, oriented.height);
        layer.mask = null;
        return;
      }
      if (Array.isArray(layer.quad)) {
        layer.quad = layer.quad.map((point) => mapPoint(point.x, point.y));
        layer._warpCache = null;
        return;
      }
      const w = layer.width || 0;
      const h = layer.height || 0;
      if (layer.isShape) {
        // 形状（含直线 / 箭头）用两个端点映射：
        // 「中心 + 交换宽高」会把斜线换到另一条对角线，方向直接反了。
        const p1 = mapPoint(layer.x, layer.y);
        const p2 = mapPoint(layer.x + w, layer.y + h);
        layer.x = p1.x;
        layer.y = p1.y;
        layer.width = p2.x - p1.x;
        layer.height = p2.y - p1.y;
        return;
      }
      const center = mapPoint(layer.x + w / 2, layer.y + h / 2);
      const nextRotation = ((Number(layer.rotation) || 0) + (direction > 0 ? 90 : -90)) % 360;
      layer.rotation = nextRotation < 0 ? nextRotation + 360 : nextRotation;
      layer.x = center.x - w / 2;
      layer.y = center.y - h / 2;
    });
  }

  /** 翻转后换算图层几何：位置镜像 + 图层自身翻转；尺寸不变。 */
  _flipLayerGeometry(axis) {
    const oriented = this.oriented;
    const W = oriented.width;
    const H = oriented.height;
    (this.layers || []).forEach((layer) => {
      if (!layer) return;
      if (layer.isAdjustment) {
        // 翻转不改尺寸，但蒙版是旧坐标，作废避免反向显示。
        layer.mask = null;
        return;
      }
      if (Array.isArray(layer.quad)) {
        layer.quad = layer.quad.map((point) => ({
          x: axis === 'h' ? W - point.x : point.x,
          y: axis === 'v' ? H - point.y : point.y,
        }));
        layer._warpCache = null;
        return;
      }
      const w = layer.width || 0;
      const h = layer.height || 0;
      if (layer.isShape) {
        // 端点镜像：斜线/箭头翻转后方向才对。
        const p1 = { x: axis === 'h' ? W - layer.x : layer.x, y: axis === 'v' ? H - layer.y : layer.y };
        const p2 = {
          x: axis === 'h' ? W - (layer.x + w) : layer.x + w,
          y: axis === 'v' ? H - (layer.y + h) : layer.y + h,
        };
        layer.x = p1.x;
        layer.y = p1.y;
        layer.width = p2.x - p1.x;
        layer.height = p2.y - p1.y;
        return;
      }
      const cx = layer.x + w / 2;
      const cy = layer.y + h / 2;
      // 反射关系 F·R(θ)=R(-θ)·F：整图翻转 = 旋转角取反 + 图层自身对应轴翻转。
      if (layer.rotation !== undefined) {
        const flipped = -Number(layer.rotation || 0);
        layer.rotation = ((flipped % 360) + 360) % 360;
      }
      if (axis === 'h') {
        if (layer.flipH !== undefined) layer.flipH = !layer.flipH;
        layer.x = W - cx - w / 2;
      } else {
        if (layer.flipV !== undefined) layer.flipV = !layer.flipV;
        layer.y = H - cy - h / 2;
      }
    });
  }

  /**
   * 换主图（同一工程内换底图）：只替换底图位图，叠加图层与图层组原样保留。
   *
   * 主图级状态（变换 / 调色 / 蒙版 / 修复 / 撤销栈）按“新图”重建；
   * 图层坐标属于「旋转后未裁剪」空间，由调用方先按尺寸差异做补偿再调用这里。
   */
  replaceMainImage(image) {
    const layers = this.layers.slice();
    const groups = this.groups.map((group) => ({ ...group }));
    this.image = image;
    this.transform = { rotate: 0, flipH: false, flipV: false, crop: null };
    this.adjust = { ...ADJUST_DEFAULTS };
    const oriented = this.oriented;
    this.mask = makeCanvas(oriented.width, oriented.height);
    this.repair = null;
    this.baseVisible = true;
    this._doc.width = oriented.width;
    this._doc.height = oriented.height;
    this.layers = layers;
    this.groups = groups;
    // 调整层覆盖整幅画面：范围跟随新主图，旧蒙版属于旧坐标，作废。
    layers.forEach((layer) => {
      if (!layer?.isAdjustment) return;
      layer.width = Math.max(1, oriented.width);
      layer.height = Math.max(1, oriented.height);
      layer.mask = null;
    });
    this._maskHas = null;
    this._tint = null;
    this.maskVersion += 1;
    this.repairVersion += 1;
    this.clearHistory();
    this.invalidateBase();
    this.snapshot();
    return this;
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
    // 裁剪改变输出尺寸与底图几何，必须连干净底图 / underlay 一起失效，
    // 否则 renderBase 仍是裁剪前的整张图（AI 主体选择看到的也是整张图）。
    this.invalidateBase();
    this.snapshot();
  }

  clearCrop() {
    if (!this.transform.crop) return;
    this.transform.crop = null;
    this.invalidateBase();
    this.snapshot();
  }

  resetAll() {
    this.transform = { rotate: 0, flipH: false, flipV: false, crop: null };
    this.adjust = { ...ADJUST_DEFAULTS };
    this.mask = makeCanvas(this.oriented.width, this.oriented.height);
    this.layers = [];
    this.groups = [];
    this.repair = null;
    this.baseVisible = true;
    this._maskHas = null;
    this.invalidateBase();
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
    this.maskVersion += 1;
    this.snapshot();
  }

  /**
   * UI 直接修改蒙版画布后调用，让 hasMask 缓存失效。
   * @param {boolean} [painted] 明确知道刚画上了蒙版时传 true，避免每帧全图扫描。
   */
  markMaskChanged(painted = false) {
    this._maskHas = painted ? true : null;
    this.maskVersion += 1;
  }

  hasMask() {
    if (this._maskHas === undefined || this._maskHas === null) {
      this._maskHas = this._computeHasMask();
    }
    return this._maskHas;
  }

  _computeHasMask() {
    return this.maskStats().has;
  }

  /** 一次扫描同时得到「是否有蒙版」与覆盖率，供状态栏和 AI 面板复用。 */
  maskStats() {
    const { width, height } = this.mask;
    if (!width || !height) return { has: false, coverage: 0 };
    const data = this.mask.getContext('2d').getImageData(0, 0, width, height).data;
    // 必须逐像素扫：抽样（每 4 像素）会漏掉细笔触，让"画了却提示未圈选"（P2-4）。
    let hit = 0;
    let has = false;
    const total = width * height;
    for (let i = 3; i < data.length; i += 4) {
      const alpha = data[i];
      if (alpha > 0) has = true;
      if (alpha > 8) hit += 1;
    }
    return { has, coverage: total ? hit / total : 0 };
  }

  maskCoverage() {
    return this.maskStats().coverage;
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
    this.maskVersion += 1;
  }

  rotateMaskLeft() {
    const source = this.mask;
    const next = makeCanvas(source.height, source.width);
    const ctx = next.getContext('2d');
    ctx.translate(next.width / 2, next.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    this.mask = next;
    this.maskVersion += 1;
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
    this.maskVersion += 1;
  }

  /* ---------------------------------------------------------- 污点修复层（D10.1） */

  /** 懒创建修复层：与「旋转后、未裁剪」画布同尺寸，透明表示未修复。 */
  ensureRepair() {
    const oriented = this.oriented;
    if (!this.repair || this.repair.width !== oriented.width || this.repair.height !== oriented.height) {
      const next = makeCanvas(oriented.width, oriented.height);
      if (this.repair) next.getContext('2d').drawImage(this.repair, 0, 0);
      this.repair = next;
      this.repairVersion += 1;
    }
    return this.repair;
  }

  hasRepair() {
    return Boolean(this.repair);
  }

  clearRepair() {
    this.repair = null;
    this.repairVersion += 1;
    this._base = null;
    this._underlay = null;
    this.snapshot();
  }

  /** 修复内容画进底图合成（在调色/LUT 之后、叠加层之前）。 */
  _drawRepair(ctx) {
    if (!this.repair) return;
    const crop = this.transform.crop;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // repair 与蒙版一样存「旋转后未裁剪」空间，而目标画布是裁剪后尺寸，必须减去裁剪原点。
    ctx.drawImage(this.repair, -(crop?.x || 0), -(crop?.y || 0));
    ctx.restore();
  }

  /**
   * 不含修复层的「干净底图」，供仿制图章 / 修复画笔 / 图案图章取样。
   * 包含叠加层、文字层与形状层（所见即所取），只临时摘掉修复层本身，避免把修补结果取样回去。
   * 每次调用都完整重合成一次，但只在落笔开始时调用，不参与逐帧渲染。
   */
  renderSample() {
    const repair = this.repair;
    const underlay = this._underlay;
    const clean = this._clean;
    const base = this._base;
    const crop = this.transform.crop;
    this.repair = null;
    this._underlay = null;
    // 取样坐标是「旋转后未裁剪」空间（仿制/图案都是按整图坐标落点），
    // 这里临时去掉裁剪渲染整张，避免有裁剪时取样整体偏移。
    this._clean = null;
    this._base = null;
    this.transform.crop = null;
    let sample;
    try {
      const under = this.renderUnderlay();
      sample = makeCanvas(under.width, under.height);
      composite(sample.getContext('2d'), under, this.layers, { crop: null, groups: this.groups });
    } finally {
      this.repair = repair;
      this._underlay = underlay;
      this._clean = clean;
      this._base = base;
      this.transform.crop = crop;
    }
    return sample;
  }

  rotateRepairRight() {
    if (!this.repair) return;
    const source = this.repair;
    const next = makeCanvas(source.height, source.width);
    const ctx = next.getContext('2d');
    ctx.translate(next.width / 2, next.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    this.repair = next;
    this.repairVersion += 1;
  }

  rotateRepairLeft() {
    if (!this.repair) return;
    const source = this.repair;
    const next = makeCanvas(source.height, source.width);
    const ctx = next.getContext('2d');
    ctx.translate(next.width / 2, next.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    this.repair = next;
    this.repairVersion += 1;
  }

  flipRepair(axis) {
    if (!this.repair) return;
    const source = this.repair;
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
    this.repair = next;
    this.repairVersion += 1;
  }

  /* ---------------------------------------------------------- 叠加层 */

  /**
   * 叠加一张图片（扣图 / 素材），默认居中并缩放到画布的 60% 以内。
   * @param {HTMLImageElement} image
   * @param {{name?:string, x?:number, y?:number, scale?:number, opacity?:number, rotation?:number, flipH?:boolean, flipV?:boolean, blend?:string, clipped?:boolean, quad?:Array<{x:number,y:number}>, locked?:boolean}} [options]
   */
  addOverlay(image, options = {}) {
    const box = this.renderBase();
    // renderBase 是「裁剪后」的尺寸，而图层坐标存的是未裁剪空间，默认居中要加回裁剪偏移。
    const crop = this.transform.crop;
    const offsetX = crop ? crop.x : 0;
    const offsetY = crop ? crop.y : 0;
    const fit = Math.min(1, (box.width * 0.6) / Math.max(1, image.naturalWidth || image.width));
    const scale = options.scale ?? fit;
    const width = (image.naturalWidth || image.width) * scale;
    const height = (image.naturalHeight || image.height) * scale;
    const layer = new OverlayLayer(image, {
      name: options.name || `叠加 ${layerCount(this._doc) + 2}`,
      x: options.x ?? Math.round(offsetX + (box.width - width) / 2),
      y: options.y ?? Math.round(offsetY + (box.height - height) / 2),
      scale,
      opacity: options.opacity ?? 1,
      rotation: options.rotation ?? 0,
      flipH: options.flipH ?? false,
      flipV: options.flipV ?? false,
      blend: options.blend ?? 'source-over',
      clipped: options.clipped ?? false,
      quad: options.quad ?? null,
      locked: options.locked ?? false,
      visible: options.visible ?? true,
    });
    addLayer(this._doc, layer);
    this._base = null;
    this.snapshot();
    return layer;
  }

  findLayer(id) {
    return findDocLayer(this._doc, id);
  }

  /** 是否存在调整层（D9.3）：存在时不能走「底图缓存 + 实时图层」的拖动捷径。 */
  get hasAdjustmentLayers() {
    return this.layers.some((layer) => layer.isAdjustment);
  }

  /**
   * 新建调整图层（D9.3），默认落在最上层，作用于底图与所有更低图层。
   * @param {object} [params] 见 ADJUSTMENT_DEFAULTS
   * @param {{name?: string, opacity?: number}} [options]
   */
  addAdjustmentLayer(params = {}, { name = '调整图层', opacity = 1, local = null } = {}) {
    const oriented = this.oriented;
    const layer = new AdjustmentLayer({
      name,
      params: normalizeAdjustment(params),
      width: oriented.width,
      height: oriented.height,
      opacity,
      local,
    });
    if (local?.type && local.type !== 'none') layer.setLocal(local);
    addLayer(this._doc, layer);
    this._base = null;
    this.snapshot();
    return layer;
  }

  /**
   * 用画布新建叠加层（D23.3 合并结果）。
   * `x/y` 默认对齐当前裁剪偏移，`scale:1` 表示像素 1:1。
   */
  addOverlayFromCanvas(canvas, { name = '合并图层', x, y, scale = 1, index = -1 } = {}) {
    const crop = this.transform.crop;
    const layer = new OverlayLayer(canvas, {
      name,
      x: x ?? (crop ? crop.x : 0),
      y: y ?? (crop ? crop.y : 0),
      scale,
    });
    addLayer(this._doc, layer, { index });
    this._base = null;
    this.snapshot();
    return layer;
  }

  /**
   * 用合并结果替换一组叠加层：新层插在最低被替换层的位置，只落一次快照。
   */
  replaceOverlaysWithCanvas(ids, canvas, { name = '合并图层' } = {}) {
    const set = new Set(ids || []);
    const first = this.layers.findIndex((layer) => set.has(layer.id));
    const crop = this.transform.crop;
    const layer = new OverlayLayer(canvas, {
      name,
      x: crop ? crop.x : 0,
      y: crop ? crop.y : 0,
      scale: 1,
    });
    // 先删旧层再插新层，整个过程只落一次快照（一次撤销恢复原图层）。
    for (const id of set) removeLayer(this._doc, id);
    const index = first < 0 ? -1 : Math.min(first, this._doc.layers.length);
    addLayer(this._doc, layer, { index });
    this._base = null;
    this.snapshot();
    return layer;
  }

  /**
   * 与主图合并（D23.3）：合成结果写回 base，清空全部叠加层，历史重置。
   * 合并后这张图就是 AI 编辑的操作对象，AI 逻辑不需要任何改动。
   */
  replaceBaseFromCanvas(canvas, { name = '' } = {}) {
    this.image = canvas;
    this.transform = { rotate: 0, flipH: false, flipV: false, crop: null };
    this.adjust = { ...ADJUST_DEFAULTS };
    this.mask = makeCanvas(this.oriented.width, this.oriented.height);
    this.layers = [];
    this.groups = [];
    this.repair = null;
    this.baseVisible = true;
    this._maskHas = null;
    this._tint = null;
    this.invalidateBase();
    // 旧历史的状态指向旧底图，保留会产生错误合成，直接重开一段历史。
    this._history = createHistory({ limit: HISTORY_LIMIT, budget: HISTORY_BUDGET });
    if (name) this.name = name;
    this.snapshot();
    return this;
  }

  /** 新建文字图层（D11.2）。 */
  addTextLayer(props = {}, { name = '文字', x = 0, y = 0 } = {}) {
    const layer = new TextLayer({ ...props, name, x, y });
    addLayer(this._doc, layer);
    this._base = null;
    this.snapshot();
    return layer;
  }

  /**
   * 新建形状图层（D11.4）。
   * @param {object} props 见 SHAPE_DEFAULTS（shape/fill/stroke/strokeWidth/radius）
   * @param {{name?:string,x?:number,y?:number,width?:number,height?:number}} [options]
   */
  addShapeLayer(props = {}, { name = '形状', x = 0, y = 0, width = 0, height = 0 } = {}) {
    const layer = new ShapeLayer({ ...props, name, x, y, width, height });
    addLayer(this._doc, layer);
    this._base = null;
    this.snapshot();
    return layer;
  }

  /** 调整层参数被改动后调用：只失效合成缓存，历史由调用方决定何时落快照。 */
  touchAdjustment(id) {
    const layer = this.findLayer(id);
    if (!layer?.isAdjustment) return false;
    layer.params = normalizeAdjustment(layer.params);
    this._base = null;
    return true;
  }

  removeOverlay(id) {
    const removed = removeLayer(this._doc, id);
    if (!removed) return false;
    this._base = null;
    this.snapshot();
    return true;
  }

  /** 批量删除（D23.2 多选）：只落一次快照，一次撤销全部恢复。 */
  removeOverlays(ids) {
    let removed = 0;
    for (const id of ids || []) {
      if (removeLayer(this._doc, id)) removed += 1;
    }
    if (removed) {
      this._base = null;
      this.snapshot();
    }
    return removed;
  }

  /** 复制图层：副本插在源图层上方并偏移 16px，可撤销。 */
  cloneOverlay(id) {
    const copy = cloneLayer(this._doc, id, { offset: 16 });
    if (!copy) return null;
    this._base = null;
    this.snapshot();
    return copy;
  }

  /** 调整图层顺序（+1 上移一层 / -1 下移一层），可撤销。 */
  moveOverlay(id, toIndex) {
    const index = moveLayer(this._doc, id, toIndex);
    if (index < 0) return -1;
    this._base = null;
    this.snapshot();
    return index;
  }

  /**
   * 拖动/缩放过程中频繁调用：只失效缓存，不写历史。
   * 松手后调用 commitLayers() 落一次快照。
   */
  touchLayers() {
    this._base = null;
  }

  commitLayers() {
    this.snapshot();
  }

  /* ---------------------------------------------------------- 图层组（D23.4 L4） */

  findGroup(id) {
    return this.groups.find((group) => group.id === id) || null;
  }

  /** 新建空组；入组、排序等由调用方与快照一起完成。 */
  addGroup({ name = '', id = '' } = {}) {
    const group = {
      id: id || `grp-${Date.now().toString(36)}-${(groupSeq += 1)}`,
      name: name || `组 ${this.groups.length + 1}`,
      visible: true,
      opacity: 1,
      blend: 'source-over',
      collapsed: false,
    };
    this.groups.push(group);
    return group;
  }

  removeGroup(id) {
    const at = this.groups.findIndex((group) => group.id === id);
    if (at < 0) return false;
    this.groups.splice(at, 1);
    for (const layer of this.layers) if (layer.groupId === id) layer.groupId = '';
    this._base = null;
    return true;
  }

  /** 改组参数（显隐 / 不透明度 / 混合 / 折叠 / 改名）；不写历史。 */
  setGroupProps(id, patch = {}) {
    const group = this.findGroup(id);
    if (!group) return false;
    if (patch.name !== undefined && String(patch.name).trim()) group.name = String(patch.name).trim().slice(0, 60);
    if (patch.visible !== undefined) group.visible = patch.visible !== false;
    if (patch.opacity !== undefined) group.opacity = Math.max(0, Math.min(1, Number(patch.opacity) || 0));
    if (patch.blend !== undefined) group.blend = patch.blend || 'source-over';
    if (patch.collapsed !== undefined) group.collapsed = Boolean(patch.collapsed);
    this._base = null;
    return true;
  }

  /**
   * 把一组图层收进新组：组内相对顺序不变，整体挪到最低成员原来的位置，
   * 保证组员在图层栈里连续（PS 的「从图层建立组」）。
   */
  groupLayers(ids, { name = '' } = {}) {
    const wanted = new Set(ids || []);
    const picked = this.layers.filter((layer) => wanted.has(layer.id));
    if (!picked.length) return null;
    const group = this.addGroup({ name });
    for (const layer of picked) layer.groupId = group.id;
    const layers = this.layers;
    const at = layers.indexOf(picked[0]);
    for (const layer of picked) {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    }
    layers.splice(Math.max(0, Math.min(at, layers.length)), 0, ...picked);
    this._base = null;
    return group;
  }

  /** 解组：成员回到原位（顺序不变），组记录删除。返回解掉的组数。 */
  ungroup(ids = []) {
    const targets = new Set();
    for (const layer of this.layers) {
      if (!layer.groupId) continue;
      if (ids.length && !ids.includes(layer.id)) continue;
      targets.add(layer.groupId);
    }
    if (!targets.size) return 0;
    for (const layer of this.layers) if (targets.has(layer.groupId)) layer.groupId = '';
    this.groups = this.groups.filter((group) => !targets.has(group.id));
    this._base = null;
    return targets.size;
  }

  setOverlayOpacity(id, opacity) {
    const layer = this.findLayer(id);
    if (!layer) return false;
    layer.opacity = Math.max(0, Math.min(1, Number(opacity) || 0));
    this._base = null;
    return true;
  }

  scaleOverlay(id, factor) {
    const layer = this.findLayer(id);
    if (!layer) return false;
    layer.scale = Math.max(0.02, Math.min(8, layer.scale * factor));
    this._base = null;
    return true;
  }

  /* ---------------------------------------------------------- 渲染 */

  /** 调色等状态被外部修改后调用，丢弃合成缓存。 */
  invalidateBase() {
    this._base = null;
    this._underlay = null;
    this._clean = null;
  }

  /** D27.1：只改了修复层（仿制图章 / 修复画笔 / 污点）时用，干净底图缓存继续复用。 */
  invalidateRepair() {
    this._base = null;
    this._underlay = null;
  }

  /**
   * D27.2：把刚画的笔触同步进缓存的 underlay，避免每帧重建整张底图。
   * `paint` 必须是「同样的笔触画到任意 ctx」的幂等操作（所有修复类 dab 都满足）。
   * 缓存的 underlay 与干净底图是同一个对象时先脱钩，别把修复写进干净底图。
   */
  stampRepairLive(paint) {
    const underlay = this._underlay;
    if (!underlay) return false;
    this.repairVersion += 1;
    if (underlay === this._clean) {
      const copy = makeCanvas(underlay.width, underlay.height);
      copy.getContext('2d').drawImage(underlay, 0, 0);
      this._underlay = copy;
    }
    const ctx = this._underlay.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    paint(ctx);
    ctx.restore();
    this._base = null;
    return true;
  }

  /**
   * 3D LUT 逐像素查表（D9.2）。只在加载了 LUT 时多一次 getImageData/putImageData，
   * 结果随 `_underlay` 缓存，拖动叠加层不会重复计算。
   */
  _applyLut(canvas) {
    const lut = this.adjust?.lut;
    if (!lut || !lut.cube || !(lut.strength > 0)) return canvas;
    const ctx = canvas.getContext('2d');
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyCube(image.data, lut.cube, lut.strength);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  /**
   * 「原图 + 变换 + 调色 + 裁剪」的合成画布（不含修复层、不含叠加层），单独缓存。
   * 修复笔触只改修复层，每次落笔都重跑这层会连同滤镜/LUT 一起重算，
   * 大图上会明显卡顿（D27.1），所以把「干净底图」与「带修复层的底图」分开缓存。
   */
  renderClean() {
    if (this._clean) return this._clean;
    const oriented = this.oriented;
    const crop = this.transform.crop;
    const baseWidth = crop ? crop.width : oriented.width;
    const baseHeight = crop ? crop.height : oriented.height;
    const canvas = makeCanvas(baseWidth, baseHeight);
    const ctx = canvas.getContext('2d');
    const img = this.image;
    const { rotate, flipH, flipV } = this.transform;
    const adjust = this.adjust;

    ctx.save();
    // 裁剪后直接以裁剪尺寸为目标画布，避免先分配整张原图再复制一份。
    ctx.translate(
      oriented.width / 2 - (crop ? crop.x : 0),
      oriented.height / 2 - (crop ? crop.y : 0),
    );
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (supportsCanvasFilter) {
      const brightness = Math.pow(2, adjust.exposure / 100) * (1 + adjust.brightness / 100);
      const contrast = 1 + adjust.contrast / 100;
      const saturation = 1 + adjust.saturation / 100;
      ctx.filter = `brightness(${Math.max(0, brightness)}) contrast(${Math.max(0, contrast)}) saturate(${Math.max(0, saturation)})`;
    }
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
    if (supportsCanvasFilter) ctx.filter = 'none';

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

    this._applyLut(canvas);
    this._clean = canvas;
    return canvas;
  }

  /**
   * 「干净底图 + 修复层」。修复笔触只让这一层失效（`invalidateRepair()`），
   * 滤镜 / LUT / 原图变换不必重跑，涂抹时每帧只多两次全尺寸 drawImage。
   */
  renderUnderlay() {
    if (this._underlay) return this._underlay;
    const clean = this.renderClean();
    if (!this.repair) {
      this._underlay = clean;
      return clean;
    }
    const canvas = makeCanvas(clean.width, clean.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(clean, 0, 0);
    this._drawRepair(ctx);
    this._underlay = canvas;
    return canvas;
  }

  /**
   * 输出「原图 + 变换 + 调色 + 叠加层」的合成画布（不含蒙版，不含裁剪以外的遮罩）。
   * 结果缓存，供画布展示与导出复用。
   */
  renderBase() {
    if (this._base) return this._base;
    if (this.baseVisible === false) {
      const size = this.size;
      const canvas = makeCanvas(size.width, size.height);
      drawLayers(canvas.getContext('2d'), this.layers, { crop: this.transform.crop, groups: this.groups });
      this._base = canvas;
      return canvas;
    }
    const underlay = this.renderUnderlay();
    if (!this.layers.length) {
      this._base = underlay;
      return underlay;
    }
    const canvas = makeCanvas(underlay.width, underlay.height);
    // 叠加层：画在裁剪之后，坐标仍按「旋转后未裁剪」空间，裁剪时同步偏移（见 renderer.js）
    composite(canvas.getContext('2d'), underlay, this.layers, { crop: this.transform.crop, groups: this.groups });
    this._base = canvas;
    return canvas;
  }

  /**
   * 只渲染指定叠加层（透明底）。
   * 默认尺寸与画面（裁剪后）一致；传 region 时按「旋转后未裁剪」坐标渲染该区域，
   * 用来把落在裁剪区之外的图层像素也交给 AI（否则这些像素会被裁掉）。
   * 调整层没有像素，返回 null。
   * @param {string} layerId
   * @param {{region?: {x:number,y:number,width:number,height:number}|null}} [options]
   */
  renderLayer(layerId, { region = null } = {}) {
    const layer = this.findLayer?.(layerId) || (this.layers || []).find((item) => item.id === layerId);
    if (!layer || layer.isAdjustment) return null;
    const size = region ? region : this.size;
    const canvas = makeCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (region) {
      // 画布区域原点平移到左上角，图层仍按未裁剪坐标绘制。
      ctx.translate(-Math.round(region.x || 0), -Math.round(region.y || 0));
      drawLayers(ctx, [layer], { crop: null, groups: this.groups });
    } else {
      drawLayers(ctx, [layer], { crop: this.transform.crop, groups: this.groups });
    }
    return canvas;
  }

  /**
   * 低分辨率合成（D18.2 调色滑杆预览）：从原图按缩小比例重新合成，避免每帧过滤 4K。
   * 不写入任何缓存，`change` 后仍需 `invalidateBase()` + `renderBase()` 出正式结果。
   */
  renderPreviewBase(maxSide = 1024) {
    // 主图隐藏时不能走「原图直绘」的预览路径，直接复用合成结果。
    if (this.baseVisible === false) return this.renderBase();
    const oriented = this.oriented;
    const crop = this.transform.crop;
    const fullWidth = crop ? crop.width : oriented.width;
    const fullHeight = crop ? crop.height : oriented.height;
    const ratio = Math.min(1, maxSide / Math.max(1, fullWidth, fullHeight));
    if (ratio >= 1) return this.renderBase();
    const width = Math.max(1, Math.round(fullWidth * ratio));
    const height = Math.max(1, Math.round(fullHeight * ratio));
    if (!this._preview || this._preview.width !== width || this._preview.height !== height) {
      this._preview = makeCanvas(width, height);
    }
    const canvas = this._preview;
    const ctx = canvas.getContext('2d');
    const img = this.image;
    const { rotate, flipH, flipV } = this.transform;
    const adjust = this.adjust;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.translate(
      oriented.width / 2 - (crop ? crop.x : 0),
      oriented.height / 2 - (crop ? crop.y : 0),
    );
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (supportsCanvasFilter) {
      const brightness = Math.pow(2, adjust.exposure / 100) * (1 + adjust.brightness / 100);
      const contrast = 1 + adjust.contrast / 100;
      const saturation = 1 + adjust.saturation / 100;
      ctx.filter = `brightness(${Math.max(0, brightness)}) contrast(${Math.max(0, contrast)}) saturate(${Math.max(0, saturation)})`;
    }
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
    ctx.restore();
    if (supportsCanvasFilter) ctx.filter = 'none';
    if (adjust.temperature) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.min(0.5, Math.abs(adjust.temperature) / 100 * 0.5);
      ctx.fillStyle = adjust.temperature > 0 ? '#ff9a4d' : '#4d9aff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    if (adjust.tint) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.min(0.45, Math.abs(adjust.tint) / 100 * 0.45);
      ctx.fillStyle = adjust.tint > 0 ? '#ff4dd2' : '#4dff9a';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    // 污点修复层（D10.1）：预览按 ratio 缩放，随裁剪偏移。
    if (this.repair) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(
        this.repair,
        -((crop?.x || 0) * ratio),
        -((crop?.y || 0) * ratio),
        this.repair.width * ratio,
        this.repair.height * ratio,
      );
      ctx.restore();
    }
    if (this.layers.length) {
      for (const layer of this.layers) {
        if (layer.isAdjustment) {
          // 调整层作用于已画好的预览内容，按 preview 比例缩放蒙版（D9.3）。
          applyAdjustmentLayer(ctx, layer, { crop, scale: ratio });
          continue;
        }
        ctx.save();
        ctx.scale(ratio, ratio);
        if (crop) ctx.translate(-crop.x, -crop.y);
        layer.draw(ctx);
        ctx.restore();
      }
    }
    this._applyLut(canvas);
    return canvas;
  }

  /** 蒙版着色图（红色 35%），用于画布叠加显示。复用画布，尺寸变化时才重新分配。
   *  传入 `rect`（蒙版坐标）时只重绘该矩形，涂抹时避免每帧整张 4K 重算（D18.2）。
   */
  renderMaskTint(rect = null) {
    const oriented = this.oriented;
    const crop = this.transform.crop;
    const width = crop ? crop.width : oriented.width;
    const height = crop ? crop.height : oriented.height;
    const offX = crop ? crop.x : 0;
    const offY = crop ? crop.y : 0;
    if (!this._tint || this._tint.width !== width || this._tint.height !== height) {
      this._tint = makeCanvas(width, height);
      rect = null;
    }
    const tint = this._tint;
    const ctx = tint.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (!rect) {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(this.mask, -offX, -offY);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      return tint;
    }
    const dx = Math.max(0, Math.floor(rect.x - offX));
    const dy = Math.max(0, Math.floor(rect.y - offY));
    const ex = Math.min(width, Math.ceil(rect.x + rect.width - offX));
    const ey = Math.min(height, Math.ceil(rect.y + rect.height - offY));
    const dw = ex - dx;
    const dh = ey - dy;
    if (dw <= 0 || dh <= 0) return tint;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.clearRect(dx, dy, dw, dh);
    ctx.drawImage(this.mask, dx + offX, dy + offY, dw, dh, dx, dy, dw, dh);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(dx, dy, dw, dh);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    return tint;
  }

  /* ---------------------------------------------------------- 导出 */

  /**
   * @param {'image/png'|'image/jpeg'} type
   */
  exportCanvas(type = 'image/png') {
    const base = this.renderBase();
    if (type !== 'image/jpeg') return base;
    const flat = makeCanvas(base.width, base.height);
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(base, 0, 0);
    return flat;
  }

  /**
   * 「主图」画布：底图 + 变换 + 调色 + 修复（不含叠加层）。
   *
   * 与 `exportCanvas()` 的区别是**不含图层**：AI 送图与快门快照默认用它，
   * 否则结果图里已经烘焙了图层像素，回流成新主图后图层再叠一次就是重影。
   */
  exportMainCanvas(type = 'image/png') {
    const base = this.renderUnderlay();
    if (type !== 'image/jpeg') return base;
    const flat = makeCanvas(base.width, base.height);
    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(base, 0, 0);
    return flat;
  }

  /**
   * @param {'image/png'|'image/jpeg'} type
   * @param {number} [quality]
   */
  bake(type = 'image/png', quality = 0.92) {
    return this.exportCanvas(type).toDataURL(type, quality);
  }

  /** 仅主图（不含图层）的 dataURL，供 AI 送图使用。 */
  bakeMain(type = 'image/png', quality = 0.92) {
    return this.exportMainCanvas(type).toDataURL(type, quality);
  }

  /** 仅主图的异步编码（换主图时作为工程源文件兜底）。 */
  bakeMainBlob(type = 'image/png', quality = 0.92) {
    return canvasToBlob(this.exportMainCanvas(type), type, quality);
  }

  /** 异步编码，避免 4K 导出时同步 toDataURL 冻结主线程。 */
  bakeBlob(type = 'image/png', quality = 0.92) {
    return canvasToBlob(this.exportCanvas(type), type, quality);
  }

  maskPng() {
    if (!this.hasMask()) return null;
    return this.maskCanvas().toDataURL('image/png');
  }

  async maskBlob() {
    if (!this.hasMask()) return null;
    return canvasToBlob(this.maskCanvas(), 'image/png');
  }
}
