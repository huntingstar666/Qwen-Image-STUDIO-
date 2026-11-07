/**
 * 「图片精修」工作台（PS 式前端）。
 *
 * 能力（纯前端，后端已有雏形）：
 * - 打开本地图片 / 接收素材仓库交接 / 拖拽 / 粘贴；
 * - 缩放平移、适应画布、1:1；
 * - 调色：曝光、亮度、对比度、饱和度、色温、色调；
 * - 变换：左右旋转、水平/垂直翻转、矩形裁剪；
 * - 蒙版：画笔、橡皮、矩形、椭圆，可调大小/硬度/不透明度；
 * - 撤销/重做、蒙版显隐、蒙版覆盖率；
 * - 导出 PNG/JPG、复制、收藏到素材仓库、带上蒙版送入「图像编辑」。
 *
 * 文档模型见 studioDoc.js：原图不变，所有操作是状态，渲染与导出共用一条管线。
 */

import { downloadUrl, fmtNum } from '../utils.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { confirmDialog } from './modal.js';
import { favoriteImage } from './favorites.js';
import { StudioDoc, ADJUST_DEFAULTS } from './studio/studioDoc.js';
import { mountAiPanel } from './studio/aiPanel.js';
import { mountOutpaintPanel } from './studio/outpaintPanel.js';
import { openCompareDialog } from './compare.js';
import { consumeStudioHandoff, goToEditPage, setHandoff } from '../handoff.js';

const TOOLS = [
  {
    id: 'view',
    label: '抓手',
    key: 'V',
    hint: '拖动画布；按住空格可随时平移',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 10.5V6.5a1.5 1.5 0 0 1 3 0V13"/><path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a7 7 0 0 1-5.6-2.8L4 14.5a1.6 1.6 0 0 1 2.5-2l1.5 1.8"/></svg>',
  },
  {
    id: 'crop',
    label: '裁剪',
    key: 'C',
    hint: '在画面上拖出裁剪框，再应用',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v14a1 1 0 0 0 1 1h14"/><path d="M3 6h14a1 1 0 0 1 1 1v14"/></svg>',
  },
  {
    id: 'brush',
    label: '蒙版画笔',
    key: 'B',
    hint: '涂抹要重绘的区域',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5l5 5-8.5 8.5-5-5 8.5-8.5z"/><path d="M6 13l-2 5 5-2"/><path d="M15 6l3 3"/></svg>',
  },
  {
    id: 'eraser',
    label: '蒙版橡皮',
    key: 'E',
    hint: '擦掉多余的蒙版',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20l-5-5 9-9 5 5-9 9z"/><path d="M12 9l3 3"/><path d="M9 20h11"/></svg>',
  },
  {
    id: 'rect',
    label: '矩形蒙版',
    key: 'R',
    hint: '框选一块矩形区域',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.4" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>',
  },
  {
    id: 'ellipse',
    label: '椭圆蒙版',
    key: 'O',
    hint: '框选一块椭圆区域',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.4"><ellipse cx="12" cy="12" rx="8" ry="6.4"/></svg>',
  },
  {
    id: 'lasso',
    label: '套索蒙版',
    key: 'L',
    hint: '沿目标画一圈，松手自动闭合填充',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5c0-3.6 3.4-6.5 7.5-6.5s7.5 2.9 7.5 6.5c0 2.6-1.8 4.9-4.5 5.9-1 .4-1.6 1-1.6 2" stroke-dasharray="3 2.4"/><circle cx="13.4" cy="19.4" r="1.3"/></svg>',
  },
  {
    id: 'move',
    label: '移动叠加图',
    key: 'M',
    hint: '拖动叠加层；滚轮缩放仍作用于画布',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M9 6l3-3 3 3"/><path d="M9 18l3 3 3-3"/><path d="M3 12h18"/><path d="M6 9l-3 3 3 3"/><path d="M18 9l3 3-3 3"/></svg>',
  },
  {
    id: 'outpaint',
    label: '扩图 / 外补画布',
    key: 'X',
    hint: '拖动画布四边外补；松开手柄可实时看到百分比',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="8" height="8" rx="1"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="M7 5l5-2 5 2"/><path d="M7 19l5 2 5-2"/><path d="M5 7l-2 5 2 5"/><path d="M19 7l2 5-2 5"/></svg>',
  },
];

const ADJUST_FIELDS = [
  { key: 'exposure', label: '曝光', min: -100, max: 100 },
  { key: 'brightness', label: '亮度', min: -100, max: 100 },
  { key: 'contrast', label: '对比度', min: -100, max: 100 },
  { key: 'saturation', label: '饱和度', min: -100, max: 100 },
  { key: 'temperature', label: '色温', min: -100, max: 100 },
  { key: 'tint', label: '色调', min: -100, max: 100 },
];

const MASK_TOOLS = new Set(['brush', 'eraser', 'rect', 'ellipse', 'lasso']);

export function createStudioPage(host) {
  let doc = null;
  let tool = 'view';
  let brush = { size: 64, hardness: 0.7, opacity: 1 };
  let view = { scale: 1, x: 0, y: 0 };
  let showMask = true;
  let activeTab = 'ai';
  let cropRect = null;
  let drag = null;
  let cursor = null;
  let spaceDown = false;
  let raf = 0;
  let tint = null;
  let tintDirty = true;
  let selectedLayerId = null;
  let preview = { url: '', image: null, flash: false };
  let outpaint = null;

  host.innerHTML = `
    <div class="page page-studio">
      <div class="studio">
        <div class="studio-bar">
          <div class="studio-file">
            <span class="studio-dot" data-ref="dot"></span>
            <span class="studio-name" data-ref="fileName">未打开图片</span>
            <span class="studio-dims mono" data-ref="dims"></span>
          </div>
          <span class="spacer"></span>
          <button class="btn ghost sm" type="button" data-ref="openBtn">打开图片</button>
          <span class="studio-sep"></span>
          <button class="btn ghost sm" type="button" data-ref="favoriteBtn" disabled>收藏</button>
          <button class="btn ghost sm" type="button" data-ref="copyBtn" disabled>复制</button>
          <button class="btn ghost sm" type="button" data-ref="jpgBtn" disabled>导出 JPG</button>
          <button class="btn ghost sm" type="button" data-ref="pngBtn" disabled>导出 PNG</button>
          <button class="btn primary sm" type="button" data-ref="sendBtn" disabled>送入图像编辑</button>
          <input type="file" accept="image/*" hidden data-ref="fileInput" />
        </div>

        <div class="studio-body">
          <div class="studio-rail" data-ref="rail"></div>

          <section class="studio-stage">
            <div class="studio-stage-bar">
              <div class="studio-zoom">
                <button type="button" data-zoom="out" title="缩小">−</button>
                <button type="button" class="studio-zoom-value mono" data-zoom="menu" data-ref="zoomLabel">100%</button>
                <button type="button" data-zoom="in" title="放大">+</button>
                <span class="studio-sep"></span>
                <button type="button" data-zoom="fit">适应</button>
                <button type="button" data-zoom="actual">1:1</button>
              </div>
              <span class="spacer"></span>
              <button class="btn ghost sm" type="button" data-ref="undoBtn" disabled>撤销</button>
              <button class="btn ghost sm" type="button" data-ref="redoBtn" disabled>重做</button>
              <label class="studio-check"><input type="checkbox" data-ref="maskVisible" checked /><span>显示蒙版</span></label>
            </div>

            <div class="studio-canvas-wrap" data-ref="stage">
              <canvas data-ref="canvas"></canvas>
              <div class="studio-outpaint" data-ref="outpaintLayer" hidden>
                <div class="so-shade" data-shade="top"></div>
                <div class="so-shade" data-shade="bottom"></div>
                <div class="so-shade" data-shade="left"></div>
                <div class="so-shade" data-shade="right"></div>
                <div class="so-frame" data-so="frame"></div>
                <span class="so-halo" data-edge="top"></span>
                <span class="so-halo" data-edge="bottom"></span>
                <span class="so-halo" data-edge="left"></span>
                <span class="so-halo" data-edge="right"></span>
                <span class="so-handle" data-edge="nw"></span>
                <span class="so-handle" data-edge="ne"></span>
                <span class="so-handle" data-edge="sw"></span>
                <span class="so-handle" data-edge="se"></span>
                <span class="so-cap" data-cap="top" hidden></span>
                <span class="so-cap" data-cap="bottom" hidden></span>
                <span class="so-cap" data-cap="left" hidden></span>
                <span class="so-cap" data-cap="right" hidden></span>
              </div>
              <div class="studio-empty" data-ref="empty">
                <div class="studio-empty-mark">
                  <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="9" width="34" height="30" rx="4"/><path d="M7 31l9-8 7 6 5-4 13 10"/><circle cx="17" cy="18" r="2.4"/></svg>
                </div>
                <div class="studio-empty-title">开始精修</div>
                <div class="studio-empty-hint">打开一张图片，或直接从素材仓库「在图片精修中打开」；支持拖拽与粘贴。</div>
                <div class="studio-empty-actions">
                  <button class="btn primary" type="button" data-ref="emptyOpen">打开图片</button>
                  <button class="btn ghost" type="button" data-ref="emptySample">用近期结果试试</button>
                </div>
              </div>
              <div class="studio-cropbar" data-ref="cropbar" hidden>
                <span class="mono" data-ref="cropInfo"></span>
                <span class="spacer"></span>
                <button class="btn ghost sm" type="button" data-ref="cropCancel">取消</button>
                <button class="btn primary sm" type="button" data-ref="cropApply">应用裁剪</button>
              </div>
            </div>

            <div class="studio-status">
              <span data-ref="statusTool">未打开图片</span>
              <span class="spacer"></span>
              <span data-ref="statusMask">蒙版 0%</span>
            </div>
          </section>

          <aside class="studio-panel">
            <div class="studio-tabs">
              <button type="button" class="active" data-tab="ai">AI 修改</button>
              <button type="button" data-tab="outpaint">扩图</button>
              <button type="button" data-tab="adjust">调整</button>
              <button type="button" data-tab="mask">蒙版</button>
              <button type="button" data-tab="transform">变换</button>
            </div>

            <div class="studio-pane studio-pane-ai" data-pane="ai">
              <div data-ref="aiPane"></div>
            </div>

            <div class="studio-pane studio-pane-outpaint" data-pane="outpaint" hidden>
              <div data-ref="outpaintPane"></div>
            </div>

            <div class="studio-pane" data-pane="adjust">
              <div class="studio-pane-title">色调</div>
              <div class="studio-sliders">
                ${ADJUST_FIELDS.map(
                  (field) => `
                  <label class="studio-slider">
                    <span class="studio-slider-head"><span>${field.label}</span><span class="mono" data-value="${field.key}">0</span></span>
                    <input type="range" min="${field.min}" max="${field.max}" value="0" step="1" data-adjust="${field.key}" />
                  </label>`,
                ).join('')}
              </div>
              <button class="btn ghost sm studio-block" type="button" data-ref="resetAdjust">复位调色</button>
              <div class="studio-note">调色为非破坏式，随时可以撤销；导出时才真正写入像素。</div>
            </div>

            <div class="studio-pane" data-pane="mask" hidden>
              <div class="studio-pane-title">画笔</div>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>大小</span><span class="mono" data-value="size">64 px</span></span>
                <input type="range" min="4" max="400" step="2" value="64" data-brush="size" />
              </label>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>硬度</span><span class="mono" data-value="hardness">70%</span></span>
                <input type="range" min="0" max="100" step="1" value="70" data-brush="hardness" />
              </label>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>不透明度</span><span class="mono" data-value="opacity">100%</span></span>
                <input type="range" min="5" max="100" step="1" value="100" data-brush="opacity" />
              </label>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="maskExport">导出蒙版</button>
                <button class="btn ghost sm" type="button" data-ref="maskClear">清除蒙版</button>
              </div>
              <div class="studio-note">蒙版标红的区域会被送去图生图做精准重绘；送入后可在图像编辑页继续调整。</div>
            </div>

            <div class="studio-pane" data-pane="transform" hidden>
              <div class="studio-pane-title">方向</div>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="rotateLeft">向左旋转</button>
                <button class="btn ghost sm" type="button" data-ref="rotateRight">向右旋转</button>
              </div>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="flipH">水平翻转</button>
                <button class="btn ghost sm" type="button" data-ref="flipV">垂直翻转</button>
              </div>
              <div class="studio-pane-title">裁剪</div>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="cropStart">开始裁剪</button>
                <button class="btn ghost sm" type="button" data-ref="cropClear" disabled>清除裁剪</button>
              </div>
              <div class="studio-pane-title">重置</div>
              <button class="btn ghost sm studio-block" type="button" data-ref="resetAll">恢复原始图片</button>
              <div class="studio-note">旋转或翻转会清空裁剪框；蒙版会跟随画面一起变换。</div>
            </div>

            <div class="studio-panel-foot">
              <span>空格拖动 · 滚轮缩放 · Ctrl+Z 撤销</span>
            </div>
          </aside>
        </div>
      </div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    dot: ref('dot'),
    fileName: ref('fileName'),
    dims: ref('dims'),
    openBtn: ref('openBtn'),
    favoriteBtn: ref('favoriteBtn'),
    copyBtn: ref('copyBtn'),
    jpgBtn: ref('jpgBtn'),
    pngBtn: ref('pngBtn'),
    sendBtn: ref('sendBtn'),
    fileInput: ref('fileInput'),
    rail: ref('rail'),
    zoomLabel: ref('zoomLabel'),
    undoBtn: ref('undoBtn'),
    redoBtn: ref('redoBtn'),
    maskVisible: ref('maskVisible'),
    stage: ref('stage'),
    canvas: ref('canvas'),
    empty: ref('empty'),
    emptyOpen: ref('emptyOpen'),
    emptySample: ref('emptySample'),
    cropbar: ref('cropbar'),
    cropInfo: ref('cropInfo'),
    cropApply: ref('cropApply'),
    cropCancel: ref('cropCancel'),
    statusTool: ref('statusTool'),
    statusMask: ref('statusMask'),
    resetAdjust: ref('resetAdjust'),
    maskExport: ref('maskExport'),
    maskClear: ref('maskClear'),
    rotateLeft: ref('rotateLeft'),
    rotateRight: ref('rotateRight'),
    flipH: ref('flipH'),
    flipV: ref('flipV'),
    cropStart: ref('cropStart'),
    cropClear: ref('cropClear'),
    resetAll: ref('resetAll'),
    aiPane: ref('aiPane'),
    outpaintLayer: ref('outpaintLayer'),
    outpaintPane: ref('outpaintPane'),
  };
  const ctx = refs.canvas.getContext('2d');
  const stageEl = refs.stage;

  /* ============================================================
   * AI 面板（右栏「AI 修改」）
   * ============================================================ */

  const ai = mountAiPanel(refs.aiPane, {
    getSize() {
      return doc ? doc.size : { width: 0, height: 0 };
    },
    getMainThumb() {
      if (!doc) return '';
      try {
        const base = doc.renderBase();
        const size = 168;
        const k = Math.min(1, size / Math.max(base.width, base.height));
        const thumb = document.createElement('canvas');
        thumb.width = Math.max(1, Math.round(base.width * k));
        thumb.height = Math.max(1, Math.round(base.height * k));
        thumb.getContext('2d').drawImage(base, 0, 0, thumb.width, thumb.height);
        return thumb.toDataURL('image/jpeg', 0.72);
      } catch {
        return '';
      }
    },
    getSource() {
      if (!doc) return null;
      const size = doc.size;
      const hasMask = doc.hasMask();
      return {
        main: { data: doc.bake('image/png'), name: doc.name, width: size.width, height: size.height },
        mask: hasMask ? doc.maskPng() : null,
        maskSize: doc.maskSize,
        coverage: hasMask ? doc.maskCoverage() : 0,
        hasMask,
      };
    },
    showResult(url) {
      setPreview(url);
    },
    compare(referenceUrl, results) {
      openCompareDialog({
        references: [{ url: referenceUrl, label: '底图（主图）' }],
        results,
      });
    },
    async addOverlay(file) {
      if (!doc) throw new Error('请先打开一张主图');
      if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const image = await loadImage(dataUrl);
      const layer = doc.addOverlay(image, { name: file.name || '叠加图' });
      selectedLayerId = layer.id;
      setTool('move');
      updateHistoryUi();
      scheduleDraw();
      ai?.refresh();
      return layer;
    },
    getLayers() {
      return doc?.layers || [];
    },
    selectLayer(id) {
      selectedLayerId = id;
      setTool('move');
      scheduleDraw();
    },
    removeLayer(id) {
      if (!doc) return;
      if (doc.removeOverlay(id)) {
        if (selectedLayerId === id) selectedLayerId = null;
        updateHistoryUi();
        scheduleDraw();
      }
    },
    setLayerOpacity(id, value) {
      if (!doc) return;
      doc.setOverlayOpacity(id, value);
      scheduleDraw();
    },
    scaleLayer(id, factor) {
      if (!doc) return;
      doc.scaleOverlay(id, factor);
      doc.commitLayers();
      updateHistoryUi();
      scheduleDraw();
    },
    openOutpaint() {
      if (!doc) {
        toastWarn('请先打开一张图片');
        return;
      }
      setTool('outpaint');
    },
  });

  function setPreview(url) {
    if (!url) {
      preview = { url: '', image: null, flash: false };
      scheduleDraw();
      return;
    }
    loadImage(url)
      .then((image) => {
        preview = { url, image, flash: false };
        scheduleDraw();
      })
      .catch((err) => toastError(err, '结果预览加载失败'));
  }

  /* ============================================================
   * 扩图 / 外补画布（右栏「扩图」）
   * ============================================================ */

  outpaint = mountOutpaintPanel(refs.outpaintPane, refs.outpaintLayer, {
    getSize() {
      if (!doc) return null;
      const base = doc.renderBase();
      return { width: base.width, height: base.height };
    },
    getView: () => view,
    onApply() {
      setTool('view');
      activeTab = 'ai';
      syncTabs();
      ai.submitOutpaint();
    },
  });
  outpaint.init();

  /* ============================================================
   * 工具与画布
   * ============================================================ */

  refs.rail.innerHTML = TOOLS.map(
    (item) => `
      <button class="studio-tool${item.id === tool ? ' active' : ''}" type="button" data-tool="${item.id}" title="${item.label}（${item.key}）">
        ${item.icon}
        <span class="studio-tool-key">${item.key}</span>
      </button>`,
  ).join('');

  function setTool(next) {
    if (!TOOLS.some((item) => item.id === next)) return;
    if (next !== 'outpaint') outpaint?.deactivate?.();
    tool = next;
    if (!MASK_TOOLS.has(next)) {
      cropRect = null;
      refs.cropbar.hidden = true;
    }
    if (next === 'crop' && doc) {
      activeTab = 'transform';
      syncTabs();
    } else if (next === 'move') {
      activeTab = 'ai';
      syncTabs();
    } else if (MASK_TOOLS.has(next)) {
      activeTab = 'mask';
      syncTabs();
    } else if (next === 'outpaint') {
      activeTab = 'outpaint';
      syncTabs();
      outpaint?.activate?.();
    }
    for (const button of refs.rail.querySelectorAll('[data-tool]')) {
      button.classList.toggle('active', button.dataset.tool === tool);
    }
    const meta = TOOLS.find((item) => item.id === tool);
    refs.statusTool.textContent = meta ? `${meta.label} · ${meta.hint}` : '';
    refs.canvas.dataset.tool = tool;
    scheduleDraw();
  }

  function syncTabs() {
    for (const button of host.querySelectorAll('.studio-tabs [data-tab]')) {
      button.classList.toggle('active', button.dataset.tab === activeTab);
    }
    for (const pane of host.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== activeTab;
    }
  }

  function sizeCanvas() {
    const rect = stageEl.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    refs.canvas.width = Math.floor(width * dpr);
    refs.canvas.height = Math.floor(height * dpr);
    refs.canvas.style.width = `${width}px`;
    refs.canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }

  function fitView() {
    if (!doc) return;
    const rect = stageEl.getBoundingClientRect();
    const image = doc.renderBase();
    const pad = 56;
    const scale = Math.min(
      (rect.width - pad) / image.width,
      (rect.height - pad) / image.height,
      1.6,
    );
    view = {
      scale: Math.max(0.02, scale),
      x: (rect.width - image.width * scale) / 2,
      y: (rect.height - image.height * scale) / 2,
    };
    updateZoomLabel();
    scheduleDraw();
  }

  function actualSize() {
    if (!doc) return;
    const rect = stageEl.getBoundingClientRect();
    const image = doc.renderBase();
    view.scale = 1;
    view.x = (rect.width - image.width) / 2;
    view.y = (rect.height - image.height) / 2;
    updateZoomLabel();
    scheduleDraw();
  }

  function zoomAt(factor, clientX, clientY) {
    if (!doc) return;
    const rect = refs.canvas.getBoundingClientRect();
    const px = clientX == null ? rect.width / 2 : clientX - rect.left;
    const py = clientY == null ? rect.height / 2 : clientY - rect.top;
    const ix = (px - view.x) / view.scale;
    const iy = (py - view.y) / view.scale;
    const next = Math.min(8, Math.max(0.04, view.scale * factor));
    view.scale = next;
    view.x = px - ix * next;
    view.y = py - iy * next;
    updateZoomLabel();
    scheduleDraw();
  }

  function updateZoomLabel() {
    refs.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  }

  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }

  function draw() {
    const width = refs.canvas.clientWidth;
    const height = refs.canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);
    if (!doc) {
      outpaint?.syncGhost?.();
      return;
    }
    const image = doc.renderBase();
    const w = image.width * view.scale;
    const h = image.height * view.scale;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.26)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(image, view.x, view.y, w, h);
    ctx.restore();

    // AI 结果预览（覆盖底图；按住 Tab 可临时看回底图）
    if (preview.image && !preview.flash) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(preview.image, view.x, view.y, w, h);
      ctx.restore();
    }

    if (showMask && doc.hasMask() && !preview.image) {
      if (tintDirty || !tint) {
        tint = doc.renderMaskTint();
        tintDirty = false;
      }
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tint, view.x, view.y, w, h);
      ctx.restore();
    }

    // 裁剪框
    if (tool === 'crop' && cropRect) {
      const rx = view.x + cropRect.x * view.scale;
      const ry = view.y + cropRect.y * view.scale;
      const rw = cropRect.width * view.scale;
      const rh = cropRect.height * view.scale;
      ctx.save();
      ctx.fillStyle = 'rgba(12, 14, 16, 0.5)';
      ctx.beginPath();
      ctx.rect(view.x, view.y, w, h);
      ctx.rect(rx, ry, rw, rh);
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      for (let i = 1; i < 3; i += 1) {
        ctx.beginPath();
        ctx.moveTo(rx + (rw * i) / 3, ry);
        ctx.lineTo(rx + (rw * i) / 3, ry + rh);
        ctx.moveTo(rx, ry + (rh * i) / 3);
        ctx.lineTo(rx + rw, ry + (rh * i) / 3);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 形状预览
    if (drag && (drag.mode === 'shape') && drag.rect) {
      const rect = drag.rect;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.fillStyle = 'rgba(255,59,48,0.28)';
      ctx.lineWidth = 1.2;
      const rx = view.x + rect.x * view.scale;
      const ry = view.y + rect.y * view.scale;
      const rw = rect.width * view.scale;
      const rh = rect.height * view.scale;
      ctx.beginPath();
      if (tool === 'ellipse') ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
      else ctx.rect(rx, ry, rw, rh);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // 套索路径预览
    if (drag?.mode === 'lasso' && drag.points?.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(view.x + drag.points[0].x * view.scale, view.y + drag.points[0].y * view.scale);
      for (const point of drag.points.slice(1)) {
        ctx.lineTo(view.x + point.x * view.scale, view.y + point.y * view.scale);
      }
      ctx.strokeStyle = 'rgba(255, 59, 48, 0.95)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 59, 48, 0.16)';
      ctx.fill();
      ctx.restore();
    }

    // 选中叠加层的外框
    const activeLayer = selectedLayerId ? doc.findLayer?.(selectedLayerId) : null;
    if (tool === 'move' && activeLayer) {
      const crop = doc.transform.crop;
      const box = activeLayer.bounds();
      const rx = view.x + (box.x - (crop?.x || 0)) * view.scale;
      const ry = view.y + (box.y - (crop?.y || 0)) * view.scale;
      const rw = box.width * view.scale;
      const rh = box.height * view.scale;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      for (const [hx, hy] of [
        [rx, ry],
        [rx + rw, ry],
        [rx, ry + rh],
        [rx + rw, ry + rh],
      ]) {
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
      ctx.restore();
    }

    // 画笔光标
    if (cursor && (tool === 'brush' || tool === 'eraser')) {
      const radius = Math.max(3, (brush.size / 2) * view.scale);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, radius + 1, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // 扩图幽灵层（DOM 覆盖，跟随画布缩放/平移）
    outpaint?.syncGhost?.();
  }

  /* ============================================================
   * 坐标与蒙版绘制
   * ============================================================ */

  function toImage(clientX, clientY) {
    const rect = refs.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  }

  function imageRect() {
    return doc ? doc.renderBase() : { width: 1, height: 1 };
  }

  /** 显示坐标 → 蒙版坐标（蒙版始终覆盖整张未裁剪的画面）。 */
  function maskPoint(point) {
    const crop = doc?.transform.crop;
    return crop ? { x: point.x + crop.x, y: point.y + crop.y } : { x: point.x, y: point.y };
  }

  function offsetRect(rect) {
    const crop = doc?.transform.crop;
    return crop
      ? { x: rect.x + crop.x, y: rect.y + crop.y, width: rect.width, height: rect.height }
      : rect;
  }

  function clampPoint(point) {
    const size = imageRect();
    return {
      x: Math.min(size.width, Math.max(0, point.x)),
      y: Math.min(size.height, Math.max(0, point.y)),
    };
  }

  function stampMask(point) {
    if (!doc) return;
    const mctx = doc.mask.getContext('2d');
    const radius = Math.max(1, brush.size / 2);
    const soft = 1 - brush.hardness;
    mctx.save();
    mctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    mctx.globalAlpha = brush.opacity;
    if (soft > 0.02) {
      const gradient = mctx.createRadialGradient(
        point.x,
        point.y,
        Math.max(0, radius * brush.hardness),
        point.x,
        point.y,
        radius,
      );
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      mctx.fillStyle = gradient;
    } else {
      mctx.fillStyle = '#ffffff';
    }
    mctx.beginPath();
    mctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    mctx.fill();
    mctx.restore();
    doc.markMaskChanged(tool !== 'eraser');
    tintDirty = true;
  }

  function strokeTo(point) {
    const from = drag.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(1, brush.size * 0.12);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let i = 1; i <= count; i += 1) {
      stampMask({ x: from.x + ((point.x - from.x) * i) / count, y: from.y + ((point.y - from.y) * i) / count });
    }
    drag.last = point;
  }

  function normalizeRect(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }

  function fillShape(rect) {
    if (!doc || rect.width < 1 || rect.height < 1) return;
    const mctx = doc.mask.getContext('2d');
    mctx.save();
    mctx.globalAlpha = brush.opacity;
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    if (tool === 'ellipse') {
      mctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
    } else {
      mctx.rect(rect.x, rect.y, rect.width, rect.height);
    }
    mctx.fill();
    mctx.restore();
    doc.markMaskChanged(true);
    tintDirty = true;
    doc.snapshot();
    updateHistoryUi();
    updateMaskStatus();
  }

  /** 套索：把自由路径自动闭合后填充成蒙版。 */
  function fillLasso(points) {
    if (!doc || points.length < 3) return;
    const mctx = doc.mask.getContext('2d');
    mctx.save();
    mctx.globalAlpha = brush.opacity;
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) mctx.lineTo(point.x, point.y);
    mctx.closePath();
    mctx.fill();
    mctx.restore();
    doc.markMaskChanged(true);
    tintDirty = true;
    doc.snapshot();
    updateHistoryUi();
    updateMaskStatus();
  }

  /* ============================================================
   * 指针交互
   * ============================================================ */

  refs.canvas.addEventListener('pointerdown', (event) => {
    if (!doc) return;
    refs.canvas.setPointerCapture?.(event.pointerId);
    const point = clampPoint(toImage(event.clientX, event.clientY));

    if (event.button === 1 || spaceDown || tool === 'view') {
      drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      refs.canvas.classList.add('is-grabbing');
      return;
    }
    if (tool === 'crop') {
      drag = { mode: 'crop', start: point, rect: null };
      return;
    }
    if (tool === 'brush' || tool === 'eraser') {
      const start = maskPoint(point);
      drag = { mode: 'paint', last: start };
      stampMask(start);
      scheduleDraw();
      return;
    }
    if (tool === 'rect' || tool === 'ellipse') {
      drag = { mode: 'shape', start: point, rect: null };
      return;
    }
    if (tool === 'lasso') {
      drag = { mode: 'lasso', points: [maskPoint(point)] };
      return;
    }
    if (tool === 'move') {
      const crop = doc.transform.crop;
      const ix = point.x + (crop?.x || 0);
      const iy = point.y + (crop?.y || 0);
      const layer = [...(doc.layers || [])].reverse().find((item) => item.hitTest(ix, iy));
      if (layer) {
        selectedLayerId = layer.id;
        drag = { mode: 'moveLayer', layer, start: point, originX: layer.x, originY: layer.y };
        scheduleDraw();
        return;
      }
      drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      refs.canvas.classList.add('is-grabbing');
    }
  });

  refs.canvas.addEventListener('pointermove', (event) => {
    const rect = refs.canvas.getBoundingClientRect();
    cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (!drag) {
      if (MASK_TOOLS.has(tool)) scheduleDraw();
      return;
    }
    if (drag.mode === 'pan') {
      view.x = drag.originX + (event.clientX - drag.startX);
      view.y = drag.originY + (event.clientY - drag.startY);
      scheduleDraw();
      return;
    }
    const point = clampPoint(toImage(event.clientX, event.clientY));
    if (drag.mode === 'paint') {
      strokeTo(maskPoint(point));
      scheduleDraw();
      return;
    }
    if (drag.mode === 'crop') {
      drag.rect = normalizeRect(drag.start, point);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'shape') {
      drag.rect = normalizeRect(drag.start, point);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'lasso') {
      const last = drag.points[drag.points.length - 1];
      const threshold = Math.max(1, 1.6 / view.scale);
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= threshold) {
        drag.points.push(maskPoint(point));
        scheduleDraw();
      }
      return;
    }
    if (drag.mode === 'moveLayer') {
      const layer = drag.layer;
      layer.x = Math.round(drag.originX + (point.x - drag.start.x));
      layer.y = Math.round(drag.originY + (point.y - drag.start.y));
      doc.touchLayers();
      scheduleDraw();
    }
  });

  function endDrag() {
    refs.canvas.classList.remove('is-grabbing');
    if (!drag) return;
    const mode = drag.mode;
    const rect = drag.rect;
    const points = drag.points;
    drag = null;
    if (mode === 'paint') {
      doc?.markMaskChanged(tool !== 'eraser');
      doc?.snapshot();
      updateHistoryUi();
      updateMaskStatus();
    } else if (mode === 'shape' && rect) {
      fillShape(offsetRect(rect));
    } else if (mode === 'lasso' && points?.length >= 3) {
      fillLasso(points);
      // 圈完回到 AI 分页，直接写指令
      activeTab = 'ai';
      syncTabs();
      ai?.focusPrompt?.();
    } else if (mode === 'moveLayer') {
      doc?.commitLayers();
      updateHistoryUi();
      ai?.refresh?.();
    } else if (mode === 'crop' && rect && rect.width > 6 && rect.height > 6) {
      cropRect = rect;
      refs.cropbar.hidden = false;
      refs.cropInfo.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      refs.cropApply.disabled = false;
    } else if (mode === 'crop') {
      cropRect = null;
      refs.cropbar.hidden = true;
    }
    scheduleDraw();
  }

  refs.canvas.addEventListener('pointerup', endDrag);
  refs.canvas.addEventListener('pointercancel', endDrag);
  refs.canvas.addEventListener('pointerleave', () => {
    cursor = null;
    scheduleDraw();
  });

  refs.canvas.addEventListener('wheel', (event) => {
    if (!doc) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0016);
    zoomAt(factor, event.clientX, event.clientY);
  }, { passive: false });

  /* ============================================================
   * 打开 / 载入 / 导出
   * ============================================================ */

  function baseName(name) {
    return String(name || 'studio').replace(/\.[^.]+$/, '') || 'studio';
  }

  function loadImage(src, name) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = src;
    });
  }

  async function openFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      setDoc(new StudioDoc(image, file.name || 'untitled.png'));
    } catch (err) {
      toastError(err, '打开图片失败');
    } finally {
      URL.revokeObjectURL(url);
      refs.fileInput.value = '';
    }
  }

  async function openUrl(url, name) {
    try {
      const image = await loadImage(url);
      setDoc(new StudioDoc(image, name || 'material.png'));
      return true;
    } catch (err) {
      toastError(err, '打开图片失败');
      return false;
    }
  }

  function setDoc(next) {
    doc = next;
    cropRect = null;
    tint = null;
    tintDirty = true;
    refs.cropbar.hidden = true;
    refs.empty.hidden = true;
    refs.dot.classList.add('is-live');
    refs.fileName.textContent = doc.name;
    refs.dims.textContent = '';
    for (const key of ['favoriteBtn', 'copyBtn', 'jpgBtn', 'pngBtn', 'sendBtn']) refs[key].disabled = false;
    syncAdjustInputs();
    updateSizeInfo();
    updateHistoryUi();
    updateMaskStatus();
    setTool(tool === 'view' ? 'view' : tool);
    setPreview(null);
    ai?.refresh?.();
    requestAnimationFrame(() => {
      fitView();
      updateSizeInfo();
    });
  }

  function updateSizeInfo() {
    if (!doc) return;
    const size = doc.size;
    refs.dims.textContent = `${fmtNum(size.width)} × ${fmtNum(size.height)}`;
    refs.cropClear.disabled = !doc.transform.crop;
  }

  function updateHistoryUi() {
    refs.undoBtn.disabled = !doc?.canUndo;
    refs.redoBtn.disabled = !doc?.canRedo;
  }

  function updateMaskStatus() {
    if (!doc) {
      refs.statusMask.textContent = '蒙版 0%';
      refs.maskClear.disabled = true;
      refs.maskExport.disabled = true;
      return;
    }
    const coverage = doc.maskCoverage();
    refs.statusMask.textContent = `蒙版 ${(coverage * 100).toFixed(1)}%`;
    const has = doc.hasMask();
    refs.maskClear.disabled = !has;
    refs.maskExport.disabled = !has;
    ai?.onMaskChanged?.(coverage);
  }

  function syncAdjustInputs() {
    if (!doc) return;
    for (const input of host.querySelectorAll('[data-adjust]')) {
      const value = doc.adjust[input.dataset.adjust] ?? 0;
      input.value = String(value);
      const label = host.querySelector(`[data-value="${input.dataset.adjust}"]`);
      if (label) label.textContent = String(value);
    }
  }

  function commitTransform(action) {
    if (!doc) return;
    action();
    updateSizeInfo();
    updateHistoryUi();
    updateMaskStatus();
    tintDirty = true;
    fitView();
    selectedLayerId = null;
    ai?.refresh?.();
  }

  function downloadDataUrl(dataUrl, filename) {
    if (!dataUrl) {
      toastWarn('没有可下载的内容');
      return;
    }
    downloadUrl(dataUrl, filename);
  }

  async function copyToClipboard() {
    if (!doc) return;
    try {
      const blob = await (await fetch(doc.bake('image/png'))).blob();
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('当前浏览器不支持剪贴板图片写入');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toastSuccess('已复制到剪贴板');
    } catch (err) {
      toastError(err, '复制失败');
    }
  }

  async function collect() {
    if (!doc) return;
    refs.favoriteBtn.disabled = true;
    const original = refs.favoriteBtn.textContent;
    refs.favoriteBtn.textContent = '收藏中…';
    await favoriteImage({
      image: doc.bake('image/png'),
      kind: 'studio',
      category: '精修',
      prompt: '',
      seed: null,
      source: 'studio',
      title: baseName(doc.name),
    });
    refs.favoriteBtn.disabled = false;
    refs.favoriteBtn.textContent = original;
  }

  function sendToEdit() {
    if (!doc) return;
    try {
      const dataUrl = doc.bake('image/png');
      const mask = doc.maskPng();
      setHandoff({
        images: [{ dataUrl, name: `${baseName(doc.name)}-edited.png` }],
        mask,
        prompt: null,
        localEnabled: Boolean(mask),
        toast: mask ? '已带上蒙版送入图像编辑' : '已送入图像编辑',
      });
      goToEditPage();
    } catch (err) {
      toastError(err, '送入失败');
    }
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */

  refs.rail.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tool]');
    if (button) setTool(button.dataset.tool);
  });

  host.querySelector('.studio-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    const tab = button.dataset.tab;
    if (tab === 'outpaint') {
      setTool('outpaint');
      return;
    }
    if (tool === 'outpaint') setTool('view');
    activeTab = tab;
    syncTabs();
  });

  refs.openBtn.addEventListener('click', () => refs.fileInput.click());
  refs.emptyOpen.addEventListener('click', () => refs.fileInput.click());
  refs.fileInput.addEventListener('change', () => openFile(refs.fileInput.files?.[0]));

  refs.emptySample?.addEventListener('click', async () => {
    try {
      const data = await (await fetch('/api/history?limit=1')).json();
      const record = data?.items?.[0];
      const url = record?.images?.[0]?.url;
      if (!url) {
        toastWarn('还没有可用的历史结果，先打开一张本地图片吧');
        return;
      }
      await openUrl(url.startsWith('/') ? url : `/files/${url}`, record.images[0].filename || 'history.png');
    } catch (err) {
      toastError(err, '读取历史失败');
    }
  });

  refs.favoriteBtn.addEventListener('click', collect);
  refs.copyBtn.addEventListener('click', copyToClipboard);
  refs.jpgBtn.addEventListener('click', () => {
    if (!doc) return;
    downloadDataUrl(doc.bake('image/jpeg', 0.92), `${baseName(doc.name)}-edited.jpg`);
  });
  refs.pngBtn.addEventListener('click', () => {
    if (!doc) return;
    downloadDataUrl(doc.bake('image/png'), `${baseName(doc.name)}-edited.png`);
  });
  refs.sendBtn.addEventListener('click', sendToEdit);

  refs.undoBtn.addEventListener('click', () => {
    if (doc?.undo()) {
      syncAdjustInputs();
      updateSizeInfo();
      updateHistoryUi();
      updateMaskStatus();
      tintDirty = true;
      selectedLayerId = null;
      ai?.refresh?.();
      scheduleDraw();
    }
  });
  refs.redoBtn.addEventListener('click', () => {
    if (doc?.redo()) {
      syncAdjustInputs();
      updateSizeInfo();
      updateHistoryUi();
      updateMaskStatus();
      tintDirty = true;
      selectedLayerId = null;
      ai?.refresh?.();
      scheduleDraw();
    }
  });

  refs.maskVisible.addEventListener('change', () => {
    showMask = refs.maskVisible.checked;
    scheduleDraw();
  });

  for (const input of host.querySelectorAll('[data-adjust]')) {
    input.addEventListener('input', () => {
      if (!doc) return;
      const key = input.dataset.adjust;
      doc.adjust[key] = Number(input.value);
      doc.invalidateBase();
      const label = host.querySelector(`[data-value="${key}"]`);
      if (label) label.textContent = input.value;
      scheduleDraw();
    });
    input.addEventListener('change', () => {
      if (!doc) return;
      doc.snapshot();
      updateHistoryUi();
    });
  }

  refs.resetAdjust.addEventListener('click', () => {
    if (!doc) return;
    doc.adjust = { ...ADJUST_DEFAULTS };
    doc.invalidateBase();
    doc.snapshot();
    syncAdjustInputs();
    updateHistoryUi();
    scheduleDraw();
  });

  for (const input of host.querySelectorAll('[data-brush]')) {
    input.addEventListener('input', () => {
      const key = input.dataset.brush;
      const value = Number(input.value);
      if (key === 'size') brush.size = value;
      if (key === 'hardness') brush.hardness = value / 100;
      if (key === 'opacity') brush.opacity = value / 100;
      const label = host.querySelector(`[data-value="${key}"]`);
      if (label) label.textContent = key === 'size' ? `${value} px` : `${value}%`;
      scheduleDraw();
    });
  }

  refs.maskClear.addEventListener('click', async () => {
    if (!doc || !doc.hasMask()) return;
    const ok = await confirmDialog({
      title: '清除蒙版',
      message: '会清空当前涂抹的所有区域，确定继续？',
      confirmText: '清除',
      danger: true,
    });
    if (!ok) return;
    doc.clearMask();
    tintDirty = true;
    updateHistoryUi();
    updateMaskStatus();
    scheduleDraw();
  });

  refs.maskExport.addEventListener('click', () => {
    if (!doc) return;
    const dataUrl = doc.maskPng();
    if (!dataUrl) {
      toastWarn('还没有涂抹蒙版');
      return;
    }
    downloadDataUrl(dataUrl, `${baseName(doc.name)}-mask.png`);
  });

  refs.rotateLeft.addEventListener('click', () => commitTransform(() => doc?.rotateLeft()));
  refs.rotateRight.addEventListener('click', () => commitTransform(() => doc?.rotateRight()));
  refs.flipH.addEventListener('click', () => commitTransform(() => doc?.flip('h')));
  refs.flipV.addEventListener('click', () => commitTransform(() => doc?.flip('v')));

  refs.cropStart.addEventListener('click', () => setTool('crop'));

  refs.cropApply.addEventListener('click', () => {
    if (!doc || !cropRect) return;
    const current = doc.transform.crop;
    const rect = current
      ? {
          x: current.x + cropRect.x,
          y: current.y + cropRect.y,
          width: cropRect.width,
          height: cropRect.height,
        }
      : cropRect;
    doc.applyCrop(rect);
    cropRect = null;
    refs.cropbar.hidden = true;
    updateSizeInfo();
    updateHistoryUi();
    fitView();
    setTool('view');
    ai?.refresh?.();
  });

  refs.cropCancel.addEventListener('click', () => {
    cropRect = null;
    refs.cropbar.hidden = true;
    setTool('view');
  });

  refs.cropClear.addEventListener('click', () => {
    if (!doc) return;
    doc.clearCrop();
    updateSizeInfo();
    updateHistoryUi();
    fitView();
  });

  refs.resetAll.addEventListener('click', async () => {
    if (!doc) return;
    const ok = await confirmDialog({
      title: '恢复原始图片',
      message: '会清空所有调色、裁剪与蒙版操作（原图不会被删除），确定继续？',
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    doc.resetAll();
    syncAdjustInputs();
    tintDirty = true;
    updateSizeInfo();
    updateHistoryUi();
    updateMaskStatus();
    fitView();
    selectedLayerId = null;
    ai?.refresh?.();
  });

  for (const button of host.querySelectorAll('[data-zoom]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.zoom;
      if (action === 'in') zoomAt(1.25);
      else if (action === 'out') zoomAt(0.8);
      else if (action === 'fit') fitView();
      else if (action === 'actual') actualSize();
      else if (action === 'menu') fitView();
    });
  }

  /* ---------------------------------------------------------- 拖拽与粘贴 */

  ['dragenter', 'dragover'].forEach((type) => {
    stageEl.addEventListener(type, (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      stageEl.classList.add('is-dropping');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    stageEl.addEventListener(type, (event) => {
      stageEl.classList.remove('is-dropping');
      if (type === 'dragleave') return;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      openFile(file);
    });
  });

  window.addEventListener('paste', (event) => {
    if (!isActive()) return;
    const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (file) openFile(file);
  });

  /* ---------------------------------------------------------- 键盘 */

  function isActive() {
    return host.isConnected && host.offsetParent !== null;
  }

  function onKeyDown(event) {
    if (!isActive()) return;
    const tag = event.target?.tagName || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (event.key === 'Tab' && preview.image) {
      event.preventDefault();
      preview.flash = true;
      scheduleDraw();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) refs.redoBtn.click();
      else refs.undoBtn.click();
      return;
    }
    if (event.code === 'Space') {
      spaceDown = true;
      refs.canvas.classList.add('is-grab');
      event.preventDefault();
      return;
    }
    if (mod) return;
    const key = event.key.toLowerCase();
    if (key === '[') {
      brush.size = Math.max(4, brush.size - 8);
      syncBrushInputs();
      return;
    }
    if (key === ']') {
      brush.size = Math.min(400, brush.size + 8);
      syncBrushInputs();
      return;
    }
    if (key === '0') {
      fitView();
      return;
    }
    if (key === '1') {
      actualSize();
      return;
    }
    if (key === 'escape') {
      cropRect = null;
      refs.cropbar.hidden = true;
      setTool('view');
      return;
    }
    const found = TOOLS.find((item) => item.key.toLowerCase() === key);
    if (found) setTool(found.id);
  }

  function syncBrushInputs() {
    const input = host.querySelector('[data-brush="size"]');
    if (input) input.value = String(brush.size);
    const label = host.querySelector('[data-value="size"]');
    if (label) label.textContent = `${brush.size} px`;
    scheduleDraw();
  }

  function onKeyUp(event) {
    if (event.key === 'Tab' && preview.flash) {
      preview.flash = false;
      scheduleDraw();
      return;
    }
    if (event.code !== 'Space') return;
    spaceDown = false;
    refs.canvas.classList.remove('is-grab');
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  /* ---------------------------------------------------------- 尺寸与交接 */

  const resizeObserver = new ResizeObserver(() => {
    sizeCanvas();
    if (doc && view.scale) {
      // 窗口变化后如果画面被裁掉，重新适应；否则保持用户当前的缩放。
      const rect = stageEl.getBoundingClientRect();
      const image = doc.renderBase();
      const w = image.width * view.scale;
      const h = image.height * view.scale;
      const outside =
        view.x < -4 || view.y < -4 || view.x + w > rect.width + 4 || view.y + h > rect.height + 4;
      if (outside) fitView();
    }
  });
  resizeObserver.observe(stageEl);

  async function applyStudioHandoff() {
    const payload = consumeStudioHandoff();
    if (!payload) return;
    await openUrl(payload.url, payload.name || 'material.png');
    toastSuccess(payload.toast);
  }
  // 页面刚创建时画布还没有尺寸，先初始化一次
  requestAnimationFrame(() => {
    sizeCanvas();
    updateMaskStatus();
    updateHistoryUi();
    setTool(tool);
    syncTabs();
    if (!doc) refs.statusTool.textContent = '未打开图片 · 支持拖拽 / 粘贴';
  });

  return {
    onShow() {
      sizeCanvas();
      applyStudioHandoff();
      if (doc) {
        requestAnimationFrame(fitView);
      }
    },
  };
}
