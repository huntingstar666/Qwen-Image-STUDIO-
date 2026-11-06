/**
 * 遮罩编辑器（本项目自研核心件，Canvas 2D 手写，不引第三方库）。
 *
 * 能力：
 * - 画笔（笔径 / 软硬边可调）、橡皮、矩形、椭圆、整图填充；
 * - 撤销 / 重做（命令回放，内存友好）、清空、反相；
 * - 显示 / 隐藏遮罩叠加；滚轮缩放、空格拖拽或中键平移、适配窗口、全屏；
 * - 羽化 + 外扩的预览叠加（离屏 canvas 高斯近似）；
 * - 对外输出：白 = 编辑区的 PNG dataURL，尺寸与第 1 张参考图完全一致。
 *
 * 坐标体系：
 * - 遮罩始终保存在「原图分辨率」的离屏 canvas（maskCanvas）里，保证导出尺寸精确；
 * - 视图层（view canvas）只负责按缩放/平移把原图与彩色叠加画出来。
 */

import { clamp, escapeHtml } from '../utils.js';

const TAU = Math.PI * 2;
const MAX_HISTORY = 40;

const TOOL_DEFS = [
  ['brush', '画笔', 'B'],
  ['eraser', '橡皮', 'E'],
  ['rect', '矩形', 'R'],
  ['ellipse', '椭圆', 'O'],
  ['fill', '填充', 'F'],
];

export class MaskEditor {
  /**
   * @param {HTMLElement} host
   * @param {{onChange?: (state: object) => void}} [options]
   */
  constructor(host, { onChange } = {}) {
    this.host = host;
    this.onChange = onChange;

    this.image = null;
    this.imageSrc = '';
    this.width = 0;
    this.height = 0;

    this.viewScale = 1;
    this.viewX = 0;
    this.viewY = 0;

    this.tool = 'brush';
    this.brushSize = 48;
    this.hardness = 0.7;
    this.feather = 32;
    this.expand = 0;
    this.showOverlay = true;

    this.history = [];
    this.redoStack = [];
    this.activeStroke = null;
    this.activeShape = null;
    this.dragStart = null;

    this.pointer = null;
    this.spaceDown = false;
    this.panning = null;
    this.userTransformed = false;
    this.coverage = 0;
    this.drawingFrame = 0;
    this.previewTimer = 0;

    this.maskCanvas = document.createElement('canvas');
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.unionCanvas = document.createElement('canvas');
    this.previewCanvas = document.createElement('canvas');

    this.render();
    this.bind();
    this.observeResize();
    this.updateStatus();
    this.resizeCanvas();
  }

  /* ============================================================
   * DOM 构建
   * ============================================================ */
  render() {
    this.host.innerHTML = `
      <div class="mask-editor" data-ref="shell">
        <div class="mask-toolbar">
          <div class="mask-tool-group">
            ${TOOL_DEFS.map(
              ([id, label, key]) =>
                `<button class="mask-tool ${id === this.tool ? 'active' : ''}" type="button" data-tool="${id}" title="${label}（${key}）">${label}<span class="kbd">${key}</span></button>`,
            ).join('')}
          </div>
          <div class="mask-tool-group">
            <span class="mask-field">笔径
              <input class="range" type="range" min="2" max="400" step="1" value="${this.brushSize}" data-ref="size" />
              <span class="range-value mono" data-ref="sizeVal">${this.brushSize}px</span>
            </span>
            <span class="mask-field">硬度
              <input class="range" type="range" min="0" max="100" step="1" value="${Math.round(this.hardness * 100)}" data-ref="hardness" />
              <span class="range-value mono" data-ref="hardnessVal">${Math.round(this.hardness * 100)}%</span>
            </span>
          </div>
          <div class="mask-divider"></div>
          <div class="mask-tool-group">
            <button class="mask-tool" type="button" data-action="undo" title="撤销（Ctrl+Z）">↶ 撤销</button>
            <button class="mask-tool" type="button" data-action="redo" title="重做（Ctrl+Shift+Z）">↷ 重做</button>
          </div>
          <div class="mask-tool-group">
            <button class="mask-tool" type="button" data-action="invert" title="反相遮罩">反相</button>
            <button class="mask-tool" type="button" data-action="clear" title="清空遮罩">清空</button>
          </div>
          <div class="mask-divider"></div>
          <label class="mask-preview-toggle">
            <input type="checkbox" data-ref="overlay" ${this.showOverlay ? 'checked' : ''} />显示叠加
          </label>
          <button class="mask-tool" type="button" data-action="fit" title="适配窗口">适配窗口</button>
          <button class="mask-tool" type="button" data-action="fullscreen" title="全屏编辑">⛶</button>
        </div>

        <div class="mask-stage" data-ref="stage" tabindex="0" aria-label="遮罩画布">
          <canvas class="mask-canvas" data-ref="canvas"></canvas>
          <div class="mask-empty" data-ref="empty">
            <div class="glyph">▧</div>
            <div>先在左侧上传第 1 张「编辑目标」图，然后在这里涂抹要编辑的区域</div>
          </div>
          <div class="mask-hint">滚轮缩放 · 空格/中键平移</div>
        </div>

        <div class="mask-statusbar">
          <span data-ref="sizeInfo" class="mono">—</span>
          <span data-ref="coverageInfo">覆盖 0%</span>
          <span class="spacer"></span>
          <span data-ref="previewInfo">羽化 0px · 外扩 0px</span>
        </div>
      </div>`;

    const ref = (name) => this.host.querySelector(`[data-ref="${name}"]`);
    this.refs = {
      shell: ref('shell'),
      stage: ref('stage'),
      canvas: ref('canvas'),
      empty: ref('empty'),
      size: ref('size'),
      sizeVal: ref('sizeVal'),
      hardness: ref('hardness'),
      hardnessVal: ref('hardnessVal'),
      overlay: ref('overlay'),
      sizeInfo: ref('sizeInfo'),
      coverageInfo: ref('coverageInfo'),
      previewInfo: ref('previewInfo'),
    };
    this.ctx = this.refs.canvas.getContext('2d');
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  bind() {
    const { stage, canvas } = this.refs;

    stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    stage.addEventListener('pointermove', (event) => this.onPointerMove(event));
    stage.addEventListener('pointerup', (event) => this.onPointerUp(event));
    stage.addEventListener('pointercancel', (event) => this.onPointerUp(event));
    stage.addEventListener('pointerleave', () => {
      if (!this.activeStroke && !this.panning && !this.activeShape) {
        this.pointer = null;
        this.requestDraw();
      }
    });
    stage.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    stage.addEventListener('contextmenu', (event) => event.preventDefault());

    // 工具与动作按钮
    this.host.addEventListener('click', (event) => {
      const toolButton = event.target.closest('[data-tool]');
      if (toolButton) {
        this.setTool(toolButton.dataset.tool);
        return;
      }
      const actionButton = event.target.closest('[data-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.action;
      if (action === 'undo') this.undo();
      else if (action === 'redo') this.redo();
      else if (action === 'clear') this.clear();
      else if (action === 'invert') this.invert();
      else if (action === 'fit') {
        this.userTransformed = false;
        this.fit();
      } else if (action === 'fullscreen') this.toggleFullscreen();
    });

    this.refs.size.addEventListener('input', () => {
      this.brushSize = clamp(this.refs.size.value, 2, 400);
      this.refs.sizeVal.textContent = `${Math.round(this.brushSize)}px`;
      this.requestDraw();
    });
    this.refs.hardness.addEventListener('input', () => {
      this.hardness = clamp(Number(this.refs.hardness.value) / 100, 0, 1);
      this.refs.hardnessVal.textContent = `${Math.round(this.hardness * 100)}%`;
    });
    this.refs.overlay.addEventListener('change', () => {
      this.showOverlay = this.refs.overlay.checked;
      this.requestDraw();
    });

    // 键盘快捷键（焦点在画布上时）
    stage.addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (event.code === 'Space') {
        event.preventDefault();
        if (!this.spaceDown) {
          this.spaceDown = true;
          stage.classList.add('pan-ready');
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      const map = { b: 'brush', e: 'eraser', r: 'rect', o: 'ellipse', f: 'fill' };
      if (map[key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const activeTag = document.activeElement?.tagName;
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
        event.preventDefault();
        this.setTool(map[key]);
      }
      if (key === 'escape') {
        this.setFullscreen(false);
      }
    });
    stage.addEventListener('keyup', (event) => {
      if (event.code === 'Space') {
        this.spaceDown = false;
        stage.classList.remove('pan-ready');
      }
    });
    stage.addEventListener('blur', () => {
      this.spaceDown = false;
      stage.classList.remove('pan-ready');
    });
  }

  observeResize() {
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
        if (!this.userTransformed) this.fit();
        else this.requestDraw();
      });
      this.resizeObserver.observe(this.refs.stage);
    }
    window.addEventListener('resize', this.onWindowResize);
  }

  onWindowResize = () => {
    this.resizeCanvas();
    if (!this.userTransformed) this.fit();
    else this.requestDraw();
  };

  /* ============================================================
   * 图像 / 画布尺寸
   * ============================================================ */
  async setImage(src) {
    if (!src) {
      this.clearImage();
      return;
    }
    if (src === this.imageSrc && this.image) return;
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('遮罩底图加载失败'));
        img.src = src;
      });
      this.image = image;
      this.imageSrc = src;
      this.width = image.naturalWidth || image.width;
      this.height = image.naturalHeight || image.height;
      this.maskCanvas.width = this.width;
      this.maskCanvas.height = this.height;
      this.unionCanvas.width = this.width;
      this.unionCanvas.height = this.height;
      this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
      this.maskCtx.clearRect(0, 0, this.width, this.height);
      this.history = [];
      this.redoStack = [];
      this.activeStroke = null;
      this.activeShape = null;
      this.coverage = 0;
      this.refs.empty.classList.add('hidden');
      this.userTransformed = false;
      this.resizeCanvas();
      this.fit();
      this.rebuildPreview();
      this.updateStatus();
      this.emitChange();
    } catch (err) {
      this.clearImage(`底图加载失败：${err.message}`);
    }
  }

  clearImage(message = '') {
    this.image = null;
    this.imageSrc = '';
    this.width = 0;
    this.height = 0;
    this.history = [];
    this.redoStack = [];
    this.maskCanvas.width = 1;
    this.maskCanvas.height = 1;
    this.coverage = 0;
    this.refs.empty.classList.remove('hidden');
    if (message) this.refs.empty.innerHTML = `<div class="glyph">!</div><div>${escapeHtml(message)}</div>`;
    this.resizeCanvas();
    this.updateStatus();
    this.requestDraw();
    this.emitChange();
  }

  /**
   * 导入一张遮罩 PNG（来自扩图交接等）。
   * 兼容两种约定：alpha 有变化取 alpha，否则取亮度（与后端 decode_mask 一致）。
   * 导入后清空撤销历史（外部遮罩没有可回放的操作）。
   */
  async setMaskDataUrl(dataUrl) {
    if (!dataUrl || !this.image || !this.width) return false;
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('遮罩图片加载失败'));
        img.src = dataUrl;
      });
      const temp = document.createElement('canvas');
      temp.width = this.width;
      temp.height = this.height;
      const tctx = temp.getContext('2d', { willReadFrequently: true });
      tctx.clearRect(0, 0, this.width, this.height);
      tctx.drawImage(image, 0, 0, this.width, this.height);
      const pixels = tctx.getImageData(0, 0, this.width, this.height);
      const data = pixels.data;
      let alphaVaries = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255 && data[i] !== 0) {
          alphaVaries = true;
          break;
        }
      }
      const ctx = this.maskCtx;
      ctx.clearRect(0, 0, this.width, this.height);
      const out = ctx.createImageData(this.width, this.height);
      for (let i = 0; i < data.length; i += 4) {
        const coverage = alphaVaries
          ? data[i + 3]
          : Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        out.data[i] = 255;
        out.data[i + 1] = 255;
        out.data[i + 2] = 255;
        out.data[i + 3] = coverage;
      }
      ctx.putImageData(out, 0, 0);
      this.history = [];
      this.redoStack = [];
      this.rebuildPreview();
      this.coverage = this.computeCoverage();
      this.updateStatus();
      this.requestDraw();
      this.emitChange();
      return true;
    } catch (err) {
      console.warn('[maskEditor] 导入遮罩失败', err);
      return false;
    }
  }

  resizeCanvas() {
    const stage = this.refs.stage;
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.refs.canvas.width = Math.round(cssW * dpr);
    this.refs.canvas.height = Math.round(cssH * dpr);
    this.refs.canvas.style.width = `${cssW}px`;
    this.refs.canvas.style.height = `${cssH}px`;
    this.dpr = dpr;
    this.requestDraw();
  }

  fit() {
    if (!this.image || !this.cssWidth) return;
    const margin = 22;
    const scale = Math.min((this.cssWidth - margin) / this.width, (this.cssHeight - margin) / this.height);
    this.viewScale = clamp(Math.min(scale, 4), 0.02, 8);
    this.viewX = (this.cssWidth - this.width * this.viewScale) / 2;
    this.viewY = (this.cssHeight - this.height * this.viewScale) / 2;
    this.requestDraw();
  }

  /* ============================================================
   * 绘制
   * ============================================================ */
  requestDraw() {
    if (this.drawingFrame) return;
    this.drawingFrame = requestAnimationFrame(() => {
      this.drawingFrame = 0;
      this.draw();
    });
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth || 1, this.cssHeight || 1);

    if (!this.image) return;
    const x = this.viewX;
    const y = this.viewY;
    const w = this.width * this.viewScale;
    const h = this.height * this.viewScale;

    // 底图
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, x, y, w, h);
    ctx.strokeStyle = 'rgba(35,38,43,0.30)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);

    // 遮罩叠加（羽化 + 外扩后的预览）：浅色主题下用半透明墨绿 + 白色描边
    if (this.showOverlay && this.previewCanvas.width > 1) {
      ctx.save();
      ctx.globalAlpha = 0.66;
      ctx.drawImage(this.previewCanvas, x, y, w, h);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.restore();
    }

    // 形状拖拽预览
    if (this.activeShape) {
      const { start, current } = this.activeShape;
      const sx = x + start.x * this.viewScale;
      const sy = y + start.y * this.viewScale;
      const ex = x + current.x * this.viewScale;
      const ey = y + current.y * this.viewScale;
      ctx.save();
      ctx.fillStyle = this.tool === 'eraser' ? 'rgba(163,77,69,0.12)' : 'rgba(47,107,98,0.16)';
      ctx.setLineDash([]);
      ctx.beginPath();
      if (this.tool === 'rect') {
        ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
      } else {
        ctx.ellipse(
          (sx + ex) / 2,
          (sy + ey) / 2,
          Math.abs(ex - sx) / 2,
          Math.abs(ey - sy) / 2,
          0,
          0,
          TAU,
        );
      }
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = this.tool === 'eraser' ? 'rgba(163,77,69,0.95)' : 'rgba(47,107,98,0.95)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.restore();
    }

    // 笔刷光标
    if (this.pointer && !this.panning && !this.spaceDown && (this.tool === 'brush' || this.tool === 'eraser')) {
      const radius = Math.max(2, (this.brushSize / 2) * this.viewScale);
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.pointer.cx, this.pointer.cy, radius, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.strokeStyle = this.tool === 'eraser' ? 'rgba(163,77,69,0.95)' : 'rgba(47,107,98,0.95)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.pointer.cx, this.pointer.cy, 1.4, 0, TAU);
      ctx.fillStyle = 'rgba(35,38,43,0.85)';
      ctx.fill();
      ctx.restore();
    }
  }

  /* ============================================================
   * 坐标与视图操作
   * ============================================================ */
  toImage(clientX, clientY) {
    const rect = this.refs.canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    return {
      x: (cx - this.viewX) / this.viewScale,
      y: (cy - this.viewY) / this.viewScale,
      cx,
      cy,
    };
  }

  onWheel(event) {
    if (!this.image) return;
    event.preventDefault();
    const rect = this.refs.canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const imageX = (cx - this.viewX) / this.viewScale;
    const imageY = (cy - this.viewY) / this.viewScale;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextScale = clamp(this.viewScale * factor, 0.02, 8);
    this.viewX = cx - imageX * nextScale;
    this.viewY = cy - imageY * nextScale;
    this.viewScale = nextScale;
    this.userTransformed = true;
    this.requestDraw();
  }

  /* ============================================================
   * 指针绘制
   * ============================================================ */
  onPointerDown(event) {
    if (!this.image) return;
    this.refs.stage.focus({ preventScroll: true });

    if (event.button === 1 || this.spaceDown) {
      event.preventDefault();
      this.panning = { startX: event.clientX, startY: event.clientY, viewX: this.viewX, viewY: this.viewY };
      this.refs.stage.classList.add('panning');
      this.refs.stage.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;

    const point = this.toImage(event.clientX, event.clientY);
    this.pointer = point;
    this.refs.stage.setPointerCapture?.(event.pointerId);

    if (this.tool === 'fill') {
      this.pushCommand({ type: 'fill' });
      this.applyCommand({ type: 'fill' });
      this.finalizeChange();
      return;
    }

    if (this.tool === 'rect' || this.tool === 'ellipse') {
      this.activeShape = { start: { x: point.x, y: point.y }, current: { x: point.x, y: point.y } };
      this.requestDraw();
      return;
    }

    // 画笔 / 橡皮
    this.activeStroke = {
      type: 'stroke',
      erase: this.tool === 'eraser',
      size: this.brushSize,
      hardness: this.hardness,
      points: [{ x: point.x, y: point.y }],
    };
    this.stamp(point.x, point.y, this.brushSize, this.hardness, this.tool === 'eraser');
    this.requestDraw();
  }

  onPointerMove(event) {
    if (!this.image) return;

    if (this.panning) {
      this.viewX = this.panning.viewX + (event.clientX - this.panning.startX);
      this.viewY = this.panning.viewY + (event.clientY - this.panning.startY);
      this.userTransformed = true;
      this.requestDraw();
      return;
    }

    const point = this.toImage(event.clientX, event.clientY);
    this.pointer = point;

    if (this.activeShape) {
      this.activeShape.current = { x: point.x, y: point.y };
      this.requestDraw();
      return;
    }

    if (this.activeStroke) {
      const stroke = this.activeStroke;
      const last = stroke.points[stroke.points.length - 1];
      const radius = Math.max(0.5, stroke.size / 2);
      const step = Math.max(1, radius * 0.22);
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.4) return;
      const segments = Math.max(1, Math.ceil(distance / step));
      for (let i = 1; i <= segments; i += 1) {
        const t = i / segments;
        const x = last.x + dx * t;
        const y = last.y + dy * t;
        stroke.points.push({ x, y });
        this.stamp(x, y, stroke.size, stroke.hardness, stroke.erase);
      }
      this.requestDraw();
      return;
    }

    if (this.tool === 'brush' || this.tool === 'eraser') this.requestDraw();
  }

  onPointerUp(event) {
    if (this.panning) {
      this.panning = null;
      this.refs.stage.classList.remove('panning');
      return;
    }
    if (this.activeShape) {
      const { start, current } = this.activeShape;
      const shape = {
        type: this.tool === 'rect' ? 'rect' : 'ellipse',
        x0: start.x,
        y0: start.y,
        x1: current.x,
        y1: current.y,
      };
      this.activeShape = null;
      if (Math.abs(shape.x1 - shape.x0) >= 1 && Math.abs(shape.y1 - shape.y0) >= 1) {
        this.pushCommand(shape);
        this.applyCommand(shape);
        this.finalizeChange();
      } else {
        this.requestDraw();
      }
      return;
    }
    if (this.activeStroke) {
      const stroke = this.activeStroke;
      this.activeStroke = null;
      if (stroke.points.length) {
        this.pushCommand(stroke);
        this.finalizeChange();
      }
    }
  }

  /* ============================================================
   * 遮罩绘制原语
   * ============================================================ */
  stamp(x, y, size, hardness, erase) {
    const ctx = this.maskCtx;
    if (!ctx) return;
    const radius = Math.max(0.5, size / 2);
    ctx.save();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    if (hardness >= 0.995) {
      ctx.fillStyle = 'rgba(255,255,255,1)';
    } else {
      const inner = Math.max(0, radius * hardness);
      const gradient = ctx.createRadialGradient(x, y, inner, x, y, radius);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  applyCommand(command) {
    if (!command) return;
    const ctx = this.maskCtx;
    if (!ctx) return;
    if (command.type === 'stroke') {
      if (command.points.length === 1) {
        this.stamp(command.points[0].x, command.points[0].y, command.size, command.hardness, command.erase);
      } else {
        for (let i = 0; i < command.points.length; i += 1) {
          const point = command.points[i];
          this.stamp(point.x, point.y, command.size, command.hardness, command.erase);
        }
      }
      return;
    }
    if (command.type === 'rect' || command.type === 'ellipse') {
      const x0 = Math.min(command.x0, command.x1);
      const y0 = Math.min(command.y0, command.y1);
      const w = Math.abs(command.x1 - command.x0);
      const h = Math.abs(command.y1 - command.y0);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      if (command.type === 'rect') ctx.rect(x0, y0, w, h);
      else ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (command.type === 'fill') {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
      return;
    }
    if (command.type === 'invert') {
      this.invertPixels();
      return;
    }
    if (command.type === 'clear') {
      ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  invertPixels() {
    const ctx = this.maskCtx;
    if (!ctx || !this.width) return;
    const imageData = ctx.getImageData(0, 0, this.width, this.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = 255 - data[i + 3];
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = alpha;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  /* ============================================================
   * 命令历史 / 撤销重做
   * ============================================================ */
  pushCommand(command) {
    this.history.push(command);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.redoStack = [];
  }

  replay() {
    const ctx = this.maskCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    for (const command of this.history) this.applyCommand(command);
  }

  undo() {
    if (!this.history.length) return;
    const command = this.history.pop();
    this.redoStack.push(command);
    this.replay();
    this.finalizeChange();
  }

  redo() {
    if (!this.redoStack.length) return;
    const command = this.redoStack.pop();
    this.history.push(command);
    this.applyCommand(command);
    this.finalizeChange();
  }

  clear() {
    if (!this.image) return;
    this.pushCommand({ type: 'clear' });
    this.applyCommand({ type: 'clear' });
    this.finalizeChange();
  }

  invert() {
    if (!this.image) return;
    this.pushCommand({ type: 'invert' });
    this.applyCommand({ type: 'invert' });
    this.finalizeChange();
  }

  /* ============================================================
   * 预览（羽化 + 外扩）与状态
   * ============================================================ */
  setPreview({ feather, expand } = {}) {
    let changed = false;
    if (feather != null && Number(feather) !== this.feather) {
      this.feather = Math.max(0, Number(feather) || 0);
      changed = true;
    }
    if (expand != null && Number(expand) !== this.expand) {
      this.expand = Math.max(0, Number(expand) || 0);
      changed = true;
    }
    this.refs.previewInfo.textContent = `羽化 ${Math.round(this.feather)}px · 外扩 ${Math.round(this.expand)}px`;
    if (changed) {
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => {
        this.rebuildPreview();
        this.requestDraw();
      }, 120);
    }
  }

  rebuildPreview() {
    if (!this.width || !this.height || !this.image) {
      this.previewCanvas.width = 1;
      this.previewCanvas.height = 1;
      return;
    }
    const width = this.width;
    const height = this.height;

    // 1) 外扩：把遮罩按圆周方向多次平移叠加，得到形态学膨胀近似
    const union = this.unionCanvas;
    if (union.width !== width || union.height !== height) {
      union.width = width;
      union.height = height;
    }
    const uctx = union.getContext('2d');
    uctx.clearRect(0, 0, width, height);
    if (this.expand > 0) {
      const steps = 12;
      const radius = this.expand;
      uctx.save();
      uctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < steps; i += 1) {
        const angle = (i / steps) * TAU;
        uctx.drawImage(this.maskCanvas, Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
      uctx.drawImage(this.maskCanvas, 0, 0);
      uctx.restore();
    } else {
      uctx.drawImage(this.maskCanvas, 0, 0);
    }

    // 2) 羽化：用 canvas filter 做高斯近似 + 着色
    const preview = this.previewCanvas;
    if (preview.width !== width || preview.height !== height) {
      preview.width = width;
      preview.height = height;
    }
    const pctx = preview.getContext('2d');
    pctx.clearRect(0, 0, width, height);
    pctx.save();
    if (this.feather > 0) pctx.filter = `blur(${Math.max(0.5, this.feather / 2)}px)`;
    pctx.drawImage(union, 0, 0);
    pctx.restore();
    pctx.save();
    pctx.globalCompositeOperation = 'source-in';
    pctx.fillStyle = 'rgba(47, 107, 98, 0.55)';
    pctx.fillRect(0, 0, width, height);
    pctx.restore();
  }

  computeCoverage() {
    if (!this.width || !this.height) return 0;
    const data = this.maskCtx.getImageData(0, 0, this.width, this.height).data;
    let covered = 0;
    let total = 0;
    // 逐像素统计（2048² 约 4M 次循环，一次描边结束才执行，开销可接受）
    for (let i = 3; i < data.length; i += 4) {
      total += 1;
      if (data[i] > 8) covered += 1;
    }
    return total ? covered / total : 0;
  }

  finalizeChange() {
    this.rebuildPreview();
    this.coverage = this.computeCoverage();
    this.updateStatus();
    this.requestDraw();
    this.emitChange();
  }

  updateStatus() {
    if (this.width && this.height) {
      this.refs.sizeInfo.textContent = `${this.width} × ${this.height}`;
    } else {
      this.refs.sizeInfo.textContent = '—';
    }
    const percent = Math.round(this.coverage * 100);
    this.refs.coverageInfo.innerHTML =
      percent > 0
        ? `<span class="mask-valid">● 覆盖 ${percent}%</span>`
        : '<span class="mask-invalid">○ 尚未绘制遮罩</span>';
    this.refs.previewInfo.textContent = `羽化 ${Math.round(this.feather)}px · 外扩 ${Math.round(this.expand)}px`;
  }

  emitChange() {
    this.onChange?.({
      empty: this.coverage <= 0,
      coverage: this.coverage,
      width: this.width,
      height: this.height,
    });
  }

  /* ============================================================
   * 导出：白 = 编辑区，尺寸与第 1 张参考图一致
   * ============================================================ */
  getMask() {
    if (!this.image || !this.width || !this.height || this.coverage <= 0) {
      return { dataURL: null, empty: true, width: this.width, height: this.height };
    }
    const out = document.createElement('canvas');
    out.width = this.width;
    out.height = this.height;
    const outCtx = out.getContext('2d');
    const source = this.maskCtx.getImageData(0, 0, this.width, this.height);
    const imageData = outCtx.createImageData(this.width, this.height);
    const src = source.data;
    const dst = imageData.data;
    for (let i = 0; i < src.length; i += 4) {
      const alpha = src[i + 3];
      dst[i] = alpha;
      dst[i + 1] = alpha;
      dst[i + 2] = alpha;
      dst[i + 3] = alpha;
    }
    outCtx.putImageData(imageData, 0, 0);
    return {
      dataURL: out.toDataURL('image/png'),
      empty: false,
      width: this.width,
      height: this.height,
    };
  }

  /* ============================================================
   * 其他
   * ============================================================ */
  setTool(tool) {
    this.tool = tool;
    for (const button of this.host.querySelectorAll('[data-tool]')) {
      button.classList.toggle('active', button.dataset.tool === tool);
    }
    this.requestDraw();
  }

  toggleFullscreen() {
    this.setFullscreen(!this.refs.shell.classList.contains('fullscreen'));
  }

  setFullscreen(enabled) {
    this.refs.shell.classList.toggle('fullscreen', enabled);
    document.body.classList.toggle('mask-locked', enabled);
    setTimeout(() => {
      this.resizeCanvas();
      if (!this.userTransformed) this.fit();
      else this.requestDraw();
      if (enabled) this.refs.stage.focus({ preventScroll: true });
    }, 60);
  }

  destroy() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    document.body.classList.remove('mask-locked');
    if (this.drawingFrame) cancelAnimationFrame(this.drawingFrame);
    clearTimeout(this.previewTimer);
  }
}
