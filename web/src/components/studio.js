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

import { downloadUrl, fmtNum, readFileAsDataURL } from '../utils.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { confirmDialog } from './modal.js';
import { favoriteImage } from './favorites.js';
import { StudioDoc, ADJUST_DEFAULTS, supportsCanvasFilter, canvasToBlob, makeCanvas } from './studio/studioDoc.js';
import { mountAiPanel } from './studio/aiPanel.js';
import { mountOutpaintPanel } from './studio/outpaintPanel.js';
import { REF_MIME, filesFromDataTransfer, openImportPicker, urlToDataUrl } from './studio/importPicker.js';
import {
  cleanupProjects,
  createProjectLease,
  estimateStorage,
  loadLastProject,
  newProjectId,
  requestPersistentStorage,
  saveStudioProject,
  storageAvailable,
} from './studio/persistence.js';
import { consumeStudioHandoff, goToEditPage, setHandoff } from '../handoff.js';
import { createPerfProbe } from './studio/perf.js';

const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

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

/** 左栏分组：只影响 DOM 分组，工具行为仍走 setTool。 */
const TOOL_GROUPS = [
  { id: 'view', title: '查看', tools: ['view'] },
  { id: 'select', title: '选区', tools: ['brush', 'eraser', 'rect', 'ellipse', 'lasso'] },
  { id: 'transform', title: '变换', tools: ['crop', 'move'] },
  { id: 'generate', title: '生成', tools: ['outpaint'] },
];

export function createStudioPage(host) {
  let doc = null;
  let thumbCache = { doc: null, base: null, url: '' };
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
  /* D18.2：涂抹时只重绘 tint 的脏矩形，避免每帧重算整张 4K 蒙版。 */
  let tintRect = null;
  /* D18.2：调色滑杆拖动期间用低分辨率代理预览，change 后再全分辨率合成。 */
  let adjustPreview = false;
  let selectedLayerId = null;
  let preview = { url: '', image: null, flash: false };
  let outpaint = null;
  /* D5.3：拖动期间复用的画布矩形，避免 pointermove 触发同步布局。 */
  let dragRect = null;
  let cropBoxStyle = { left: '', top: '', width: '', height: '' };
  /* D18.1：性能探针（localStorage['wb.studio.perf']='1' 时启用）。 */
  const perf = createPerfProbe('studio.draw');

  /* 本机工程持久化（D17.1）：工程 id、主图源 Blob、叠加层 Blob 与自动保存节流。 */
  let projectId = '';
  let projectCreatedAt = 0;
  let sourceBlob = null;
  const layerBlobs = new Map();
  let saveTimer = 0;
  let idleTimer = 0;
  let saveRetryTimer = 0;
  let saveRetryDelay = 0;
  let saveStateTimer = 0;
  let saving = false;
  let savePending = false;
  let saveDirty = false;
  let saveWarned = false;
  let storageWarned = false;
  let persistDisabled = !storageAvailable();
  let restoreChecked = false;
  let restoring = false;
  let pendingRestore = null;
  /* D17.3：多标签租约、配额告警与持久化申请。 */
  let lease = null;
  let leaseLocked = false;
  let quotaWarned = false;
  let persistRequested = false;

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
          <div class="studio-import" data-ref="importWrap">
            <button class="btn ghost sm" type="button" data-ref="openBtn" aria-haspopup="menu" aria-expanded="false">导入 ▾</button>
            <div class="studio-import-menu" role="menu" data-ref="importMenu" hidden>
              <button type="button" role="menuitem" data-import="local">本地文件</button>
              <button type="button" role="menuitem" data-import="warehouse">素材仓库</button>
              <button type="button" role="menuitem" data-import="history">最近结果</button>
            </div>
          </div>
          <span class="studio-sep"></span>
          <button class="btn ghost sm" type="button" data-ref="compareAllBtn" disabled title="对比参考图与历史结果（Shift+C）">对比</button>
          <div class="studio-import" data-ref="exportWrap">
            <button class="btn ghost sm" type="button" data-ref="exportBtn" disabled aria-haspopup="menu" aria-expanded="false">导出 ▾</button>
            <div class="studio-import-menu studio-export-menu" role="menu" data-ref="exportMenu" hidden>
              <button type="button" role="menuitem" data-export="png">导出 PNG</button>
              <button type="button" role="menuitem" data-export="jpg">导出 JPG</button>
              <button type="button" role="menuitem" data-export="mask">导出蒙版</button>
              <button type="button" role="menuitem" data-export="copy">复制到剪贴板</button>
              <button type="button" role="menuitem" data-export="favorite">收藏到素材仓库</button>
            </div>
          </div>
          <button class="btn primary sm" type="button" data-ref="sendBtn" disabled>送入图像编辑</button>
          <input type="file" accept="image/*" hidden data-ref="fileInput" />
        </div>

        <div class="studio-restore" data-ref="restoreBar" hidden>
          <span class="studio-restore-dot"></span>
          <span class="studio-restore-text" data-ref="restoreText">上次编辑未完成</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" type="button" data-ref="restoreIgnore">忽略</button>
          <button class="btn primary sm" type="button" data-ref="restoreApply">恢复</button>
        </div>

        <div class="studio-restore studio-lock" data-ref="lockBar" hidden>
          <span class="studio-restore-dot"></span>
          <span class="studio-restore-text" data-ref="lockText">该工程已在其他标签编辑 · 本标签暂不保存</span>
          <span class="spacer"></span>
          <button class="btn primary sm" type="button" data-ref="lockTake">接管编辑</button>
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
              <div class="studio-crop-overlay" data-ref="cropOverlay" hidden>
                <div class="studio-crop-box" data-ref="cropBox"></div>
              </div>
              <div class="studio-maskbar" data-ref="maskbar" hidden>
                <select class="select studio-maskbar-tool" data-ref="maskTool" aria-label="蒙版工具">
                  <option value="brush">画笔</option>
                  <option value="eraser">橡皮</option>
                  <option value="rect">矩形</option>
                  <option value="ellipse">椭圆</option>
                  <option value="lasso">套索</option>
                </select>
                <label class="studio-maskbar-field">
                  <span>大小</span>
                  <input type="range" min="4" max="400" step="2" value="64" data-brush="size" />
                  <span class="mono" data-value="size">64 px</span>
                </label>
                <label class="studio-maskbar-field">
                  <span>硬度</span>
                  <input type="range" min="0" max="100" step="1" value="70" data-brush="hardness" />
                  <span class="mono" data-value="hardness">70%</span>
                </label>
                <label class="studio-maskbar-field">
                  <span>不透明度</span>
                  <input type="range" min="5" max="100" step="1" value="100" data-brush="opacity" />
                  <span class="mono" data-value="opacity">100%</span>
                </label>
                <span class="spacer"></span>
                <button class="btn ghost sm" type="button" data-ref="maskExport">导出蒙版</button>
                <button class="btn ghost sm" type="button" data-ref="maskClear">清除蒙版</button>
              </div>
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
                  <button class="btn primary" type="button" data-ref="emptyOpen">从本地选择</button>
                  <button class="btn ghost" type="button" data-ref="emptyWarehouse">从素材仓库</button>
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
              <button type="button" data-tab="adjust">调整</button>
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
              <div class="studio-note" data-ref="filterNote" hidden></div>
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
              <span class="studio-save" data-ref="saveState">自动保存 · 本机</span>
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
    importWrap: ref('importWrap'),
    openBtn: ref('openBtn'),
    importMenu: ref('importMenu'),
    exportWrap: ref('exportWrap'),
    exportBtn: ref('exportBtn'),
    exportMenu: ref('exportMenu'),
    compareAllBtn: ref('compareAllBtn'),
    sendBtn: ref('sendBtn'),
    fileInput: ref('fileInput'),
    rail: ref('rail'),
    zoomLabel: ref('zoomLabel'),
    undoBtn: ref('undoBtn'),
    redoBtn: ref('redoBtn'),
    maskVisible: ref('maskVisible'),
    stage: ref('stage'),
    canvas: ref('canvas'),
    cropOverlay: ref('cropOverlay'),
    cropBox: ref('cropBox'),
    empty: ref('empty'),
    emptyOpen: ref('emptyOpen'),
    emptyWarehouse: ref('emptyWarehouse'),
    cropbar: ref('cropbar'),
    cropInfo: ref('cropInfo'),
    cropApply: ref('cropApply'),
    cropCancel: ref('cropCancel'),
    statusTool: ref('statusTool'),
    statusMask: ref('statusMask'),
    resetAdjust: ref('resetAdjust'),
    filterNote: ref('filterNote'),
    maskbar: ref('maskbar'),
    maskTool: ref('maskTool'),
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
    saveState: ref('saveState'),
    restoreBar: ref('restoreBar'),
    restoreText: ref('restoreText'),
    restoreApply: ref('restoreApply'),
    restoreIgnore: ref('restoreIgnore'),
    lockBar: ref('lockBar'),
    lockText: ref('lockText'),
    lockTake: ref('lockTake'),
  };
  const ctx = refs.canvas.getContext('2d');
  const stageEl = refs.stage;

  /* ============================================================
   * AI 面板（右栏「AI 修改」）
   * ============================================================ */

  const ai = mountAiPanel(refs.aiPane, {
    /** AI 面板里的指令 / 参考图 / 参数变化后，合并到同一条自动保存。 */
    onPersistChange() {
      scheduleSave();
    },
    getSize() {
      return doc ? doc.size : { width: 0, height: 0 };
    },
    /** 本次任务 id = 当前工程 id；打开新图会开启新会话，历史互不混用。 */
    getSessionId() {
      return projectId;
    },
    /** 当前文档是否有未保存的手动改动（撤销栈非空），历史回退前二次确认用。 */
    hasDocChanges() {
      return Boolean(doc?.canUndo);
    },
    getMainThumb() {
      if (!doc) return '';
      flushAdjustPreview();
      try {
        const base = doc.renderBase();
        if (thumbCache.doc === doc && thumbCache.base === base && thumbCache.url) return thumbCache.url;
        const size = 168;
        const k = Math.min(1, size / Math.max(base.width, base.height));
        const thumb = document.createElement('canvas');
        thumb.width = Math.max(1, Math.round(base.width * k));
        thumb.height = Math.max(1, Math.round(base.height * k));
        thumb.getContext('2d').drawImage(base, 0, 0, thumb.width, thumb.height);
        const url = thumb.toDataURL('image/jpeg', 0.72);
        thumbCache = { doc, base, url };
        return url;
      } catch {
        return '';
      }
    },
    getSource() {
      if (!doc) return null;
      const size = doc.size;
      const stats = doc.maskStats();
      flushAdjustPreview();
      return {
        main: { data: doc.bake('image/png'), name: doc.name, width: size.width, height: size.height },
        mask: stats.has ? doc.maskPng() : null,
        maskSize: doc.maskSize,
        coverage: stats.has ? stats.coverage : 0,
        hasMask: stats.has,
      };
    },
    /** 当前主图（含调色/变换/叠加层，不含 AI 结果预览），用于图片对比。 */
    getMainImage() {
      if (!doc) return null;
      flushAdjustPreview();
      const size = doc.size;
      return { url: doc.bake('image/png'), label: '当前主图', width: size.width, height: size.height };
    },
    showResult(url) {
      setPreview(url);
    },
    /** 结果回流：把结果图载入为新底图（蒙版与历史随新文档清空），可继续精修 / 再次扩图。 */
    async adoptResult(url, meta = {}) {
      if (!url) return null;
      const token = ++openSeq;
      try {
        const image = await loadImage(url);
        if (token !== openSeq) return null;
        if (imageTooLarge(image, 'AI 结果')) return null;
        const stem = (doc?.name || 'result').replace(/\.[^.]+$/, '') || 'result';
        const suffix = meta.task === 'outpaint' ? '-扩图' : '-精修';
        const next = new StudioDoc(image, `${stem}${suffix}.png`);
        sourceBlob = await fetchBlob(url);
        if (token !== openSeq) return null;
        if (!sourceBlob) {
          try {
            sourceBlob = next.bakeBlob('image/png');
          } catch {
            sourceBlob = null;
          }
        }
        setDoc(next);
        return { width: next.size.width, height: next.size.height, name: next.name };
      } catch (err) {
        if (token === openSeq) toastError(err, '载入结果失败');
        return null;
      }
    },
    async addOverlay(file) {
      if (!doc) throw new Error('请先打开一张主图');
      if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件');
      if (fileTooLarge(file, '叠加图')) return null;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const image = await loadImage(dataUrl);
      if (imageTooLarge(image, '叠加图')) return null;
      const layer = doc.addOverlay(image, { name: file.name || '叠加图' });
      layerBlobs.set(layer.id, file);
      selectedLayerId = layer.id;
      setTool('move');
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
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
        layerBlobs.delete(id);
        updateHistoryUi();
        scheduleSave();
        scheduleDraw();
      }
    },
    setLayerOpacity(id, value) {
      if (!doc) return;
      doc.setOverlayOpacity(id, value);
      scheduleDraw();
    },
    /** 滑杆松手后落一次快照，让不透明度调整可以撤销。 */
    commitLayers() {
      if (!doc) return;
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
    },
    scaleLayer(id, factor) {
      if (!doc) return;
      doc.scaleOverlay(id, factor);
      doc.commitLayers();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
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

  refs.rail.innerHTML = TOOL_GROUPS.map(
    (group) => `
      <div class="studio-tool-group" data-group="${group.id}">
        <span class="studio-tool-group-title">${group.title}</span>
        ${group.tools
          .map((id) => {
            const item = TOOLS.find((entry) => entry.id === id);
            if (!item) return '';
            return `<button class="studio-tool${item.id === tool ? ' active' : ''}" type="button" data-tool="${item.id}" title="${item.label}（${item.key}）">
        ${item.icon}
        <span class="studio-tool-key">${item.key}</span>
      </button>`;
          })
          .join('')}
      </div>`,
  ).join('');

  function setTool(next) {
    if (!TOOLS.some((item) => item.id === next)) return;
    if (next !== 'outpaint') {
      outpaint?.deactivate?.();
      if (activeTab === 'outpaint') activeTab = 'ai';
    }
    refs.maskbar.hidden = !MASK_TOOLS.has(next);
    if (MASK_TOOLS.has(next)) refs.maskTool.value = next;
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
    scheduleSave(1200);
  }

  const TAB_IDS = new Set(['ai', 'adjust', 'transform']);

  /** 恢复会话时把历史的 5 tab 归一化：扩图只在对应工具下保留。 */
  function normalizeTab(tab) {
    if (TAB_IDS.has(tab)) return tab;
    if (tab === 'outpaint' && tool === 'outpaint') return 'outpaint';
    return 'ai';
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
    scheduleSave(1500);
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
    scheduleSave(1500);
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
    scheduleSave(1500);
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

  /** 调色代理预览结束：丢缓存并安排一次全分辨率合成（D18.2）。 */
  function flushAdjustPreview() {
    if (!adjustPreview || !doc) return;
    adjustPreview = false;
    doc.invalidateBase();
    scheduleDraw();
  }

  /**
   * 裁剪框改为 DOM 覆盖层（D5.3）：拖动选框只写 left/top/width/height，
   * 画布不再重绘，4K 图下也不会出现整图重绘卡顿。
   */
  function syncCropOverlay(rect = cropRect) {
    const visible = tool === 'crop' && doc && rect && rect.width > 1 && rect.height > 1;
    if (!visible) {
      if (!refs.cropOverlay.hidden) refs.cropOverlay.hidden = true;
      return;
    }
    if (refs.cropOverlay.hidden) refs.cropOverlay.hidden = false;
    const next = {
      left: `${Math.round(view.x + rect.x * view.scale)}px`,
      top: `${Math.round(view.y + rect.y * view.scale)}px`,
      width: `${Math.max(1, Math.round(rect.width * view.scale))}px`,
      height: `${Math.max(1, Math.round(rect.height * view.scale))}px`,
    };
    const style = refs.cropBox.style;
    for (const key of ['left', 'top', 'width', 'height']) {
      if (cropBoxStyle[key] !== next[key]) {
        style[key] = next[key];
        cropBoxStyle[key] = next[key];
      }
    }
  }

  function draw() {
    const t0 = perf.start();
    const width = refs.canvas.clientWidth;
    const height = refs.canvas.clientHeight;
    ctx.clearRect(0, 0, width, height);
    if (!doc) {
      syncCropOverlay();
      outpaint?.syncGhost?.();
      perf.end(t0);
      return;
    }
    // 叠加层拖动（D18.2）：底层合成复用缓存，叠加层按视口实时重画，避免每帧重建 4K base。
    const liveLayers = !adjustPreview && drag?.mode === 'moveLayer' && doc.layers.length > 0;
    const image = adjustPreview
      ? doc.renderPreviewBase()
      : liveLayers
        ? doc.renderUnderlay()
        : doc.renderBase();
    const size = doc.size;
    const w = size.width * view.scale;
    const h = size.height * view.scale;

    // 底图阴影交给 CSS drop-shadow（见 .studio-canvas-wrap canvas），
    // 避免每帧对整图做 shadowBlur 模糊。
    ctx.drawImage(image, view.x, view.y, w, h);
    if (liveLayers) {
      const crop = doc.transform.crop;
      ctx.save();
      ctx.translate(view.x - (crop?.x || 0) * view.scale, view.y - (crop?.y || 0) * view.scale);
      ctx.scale(view.scale, view.scale);
      for (const layer of doc.layers) layer.draw(ctx);
      ctx.restore();
    }

    // AI 结果预览（覆盖底图；按住 \ 可临时看回底图）
    if (preview.image && !preview.flash) {
      const pw = preview.image.naturalWidth || preview.image.width;
      const ph = preview.image.naturalHeight || preview.image.height;
      const scale = Math.min(w / pw, h / ph);
      const dw = pw * scale;
      const dh = ph * scale;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(preview.image, view.x + (w - dw) / 2, view.y + (h - dh) / 2, dw, dh);
      ctx.restore();
    }

    if (showMask && doc.hasMask() && !preview.image) {
      if (tintDirty || !tint) {
        tint = doc.renderMaskTint();
        tintDirty = false;
        tintRect = null;
      } else if (tintRect) {
        tint = doc.renderMaskTint(tintRect);
        tintRect = null;
      }
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tint, view.x, view.y, w, h);
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

    // 裁剪框由 DOM 覆盖层绘制，这里只同步位置
    syncCropOverlay();

    // 扩图幽灵层（DOM 覆盖，跟随画布缩放/平移）
    outpaint?.syncGhost?.();

    perf.end(t0);
  }

  /* ============================================================
   * 坐标与蒙版绘制
   * ============================================================ */

  function toImage(clientX, clientY, rect = null) {
    const box = rect || refs.canvas.getBoundingClientRect();
    return {
      x: (clientX - box.left - view.x) / view.scale,
      y: (clientY - box.top - view.y) / view.scale,
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
    // 只记录画笔包围盒，让 tint 增量重绘（D18.2）；若已有整图失效，保持整图重绘。
    if (!tintDirty) {
      const dirty = { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
      tintRect = tintRect
        ? {
            x: Math.min(tintRect.x, dirty.x),
            y: Math.min(tintRect.y, dirty.y),
            width: Math.max(tintRect.x + tintRect.width, dirty.x + dirty.width) - Math.min(tintRect.x, dirty.x),
            height: Math.max(tintRect.y + tintRect.height, dirty.y + dirty.height) - Math.min(tintRect.y, dirty.y),
          }
        : dirty;
    }
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
    dragRect = refs.canvas.getBoundingClientRect();
    const point = clampPoint(toImage(event.clientX, event.clientY, dragRect));

    if (event.button === 1 || spaceDown || tool === 'view') {
      drag = { mode: 'pan', startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      refs.canvas.classList.add('is-grabbing');
      return;
    }
    if (tool === 'crop') {
      drag = { mode: 'crop', start: point, rect: null };
      syncCropOverlay(null);
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
    const rect = dragRect || refs.canvas.getBoundingClientRect();
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
    const point = clampPoint(toImage(event.clientX, event.clientY, rect));
    if (drag.mode === 'paint') {
      strokeTo(maskPoint(point));
      scheduleDraw();
      return;
    }
    if (drag.mode === 'crop') {
      drag.rect = normalizeRect(drag.start, point);
      syncCropOverlay(drag.rect);
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
    dragRect = null;
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
    scheduleSave();
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
   * 本机自动保存（D17.1）
   * ============================================================ */

  const SAVE_LABELS = {
    idle: '自动保存 · 本机',
    saving: '保存中…',
    saved: '已保存',
    error: '保存失败，重试中',
    off: '当前浏览器不支持本机保存',
    locked: '其他标签编辑中',
  };
  let tabToken = '';

  function tabId() {
    if (tabToken) return tabToken;
    try {
      tabToken = sessionStorage.getItem('wb.studio.tab') || '';
      if (!tabToken) {
        tabToken = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem('wb.studio.tab', tabToken);
      }
    } catch {
      tabToken = '';
    }
    return tabToken;
  }

  /* ---------------------------------------------------------- 多标签租约（D17.3） */

  function setSaveState(next) {
    if (!refs.saveState) return;
    refs.saveState.dataset.state = next;
    refs.saveState.textContent = SAVE_LABELS[next] || SAVE_LABELS.idle;
    clearTimeout(saveStateTimer);
    if (next === 'saved') {
      saveStateTimer = setTimeout(() => {
        if (refs.saveState?.dataset.state === 'saved') setSaveState('idle');
      }, 2500);
    }
  }

  /** 只读态：画布与右栏不可交互，自动保存停摆，避免覆盖另一个标签的编辑。 */
  function setLeaseLocked(locked) {
    if (leaseLocked === locked) return;
    leaseLocked = locked;
    const root = host.querySelector('.studio');
    if (root) root.dataset.locked = locked ? 'true' : 'false';
    refs.lockBar.hidden = !locked;
    if (locked) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      clearTimeout(idleTimer);
      idleTimer = 0;
      setSaveState('locked');
    } else if (!persistDisabled) {
      setSaveState('idle');
    }
  }

  function stopLease() {
    lease?.release?.();
    lease = null;
    setLeaseLocked(false);
  }

  /** 进入工程时抢占租约：失败则锁定，等用户点「接管编辑」。 */
  function startLease(id) {
    stopLease();
    if (!id) return;
    lease = createProjectLease(id, tabId(), {
      onLost: () => {
        setLeaseLocked(true);
        toastWarn('该工程已在其他标签接管编辑，本标签已暂停保存');
      },
    });
    if (!lease.claim()) {
      setLeaseLocked(true);
      refs.lockText.textContent = '该工程已在其他标签编辑 · 本标签为只读';
    }
  }

  refs.lockTake.addEventListener('click', () => {
    if (!lease) return;
    lease.take();
    setLeaseLocked(false);
    scheduleSave(300);
    toastSuccess('已接管编辑');
  });

  /** 打开新主图 = 开启新工程；旧工程留在本机，供后续「最近工程」入口使用。 */
  function beginProject() {
    stopLease();
    projectId = newProjectId();
    projectCreatedAt = Date.now();
    sourceBlob = null;
    layerBlobs.clear();
    saveDirty = true;
  }

  async function fetchBlob(url) {
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) return null;
      const blob = await response.blob();
      return blob.size ? blob : null;
    } catch {
      return null;
    }
  }

  /** 叠加层优先复用打开时的原始文件；缺失时（撤销/恢复后）再编码一次并缓存。 */
  async function layerBlobFor(layer) {
    const cached = layerBlobs.get(layer.id);
    if (cached) return cached;
    const image = layer.image;
    const width = image?.naturalWidth || image?.width || 0;
    const height = image?.naturalHeight || image?.height || 0;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const blob = await canvasToBlob(canvas, 'image/png');
    layerBlobs.set(layer.id, blob);
    return blob;
  }

  function thumbnailOf(current) {
    try {
      const base = current.renderBase();
      const scale = Math.min(1, 280 / Math.max(base.width, base.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(base.width * scale));
      canvas.height = Math.max(1, Math.round(base.height * scale));
      canvas.getContext('2d').drawImage(base, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return '';
    }
  }

  async function collectProject() {
    const current = doc;
    if (!current) return null;
    if (!projectId) beginProject();
    const id = projectId;
    const createdAt = projectCreatedAt;
    // 先同步取快照，后续 await 期间用户继续操作也不会写脏。
    const transform = {
      ...current.transform,
      crop: current.transform.crop ? { ...current.transform.crop } : null,
    };
    const adjust = { ...current.adjust };
    const layerList = current.layers.slice();
    const name = current.name;
    const size = current.size;
    const sourceSize = current.sourceSize;
    const aiState = ai?.getPersistState?.() || null;
    // 参考图有独立 store（存 Blob），session 里只留轻量参数，避免重复存大图。
    const aiParams = aiState ? { ...aiState } : null;
    if (aiParams) delete aiParams.refs;
    const viewport = { scale: view.scale, x: view.x, y: view.y };

    let base = sourceBlob;
    if (!base) {
      try {
        base = await current.bakeBlob('image/png');
        sourceBlob = base;
      } catch {
        base = null;
      }
    }
    let maskBlob = null;
    try {
      // 存「旋转后、未裁剪」的完整蒙版，恢复时才能和 transform/crop 对齐。
      maskBlob = current.hasMask() ? await canvasToBlob(current.mask, 'image/png') : null;
    } catch {
      maskBlob = null;
    }

    const layers = [];
    const keepIds = new Set(layerList.map((layer) => layer.id));
    for (const layer of layerList) {
      let blob = null;
      try {
        blob = await layerBlobFor(layer);
      } catch {
        blob = null;
      }
      layers.push({
        id: layer.id,
        props: {
          name: layer.name,
          x: layer.x,
          y: layer.y,
          scale: layer.scale,
          opacity: layer.opacity,
          rotation: layer.rotation,
        },
        blob,
      });
    }
    // 旋转/重置会清空叠加层，顺带释放不再需要的 Blob 引用。
    for (const id of [...layerBlobs.keys()]) {
      if (!keepIds.has(id)) layerBlobs.delete(id);
    }

    return {
      id,
      name,
      width: size.width,
      height: size.height,
      createdAt,
      updatedAt: Date.now(),
      thumbnail: thumbnailOf(current),
      activeTool: tool,
      viewport,
      tabId: tabId(),
      base: { blob: base, name, width: sourceSize.width, height: sourceSize.height },
      maskBlob,
      refs: aiState?.refs || [],
      layers,
      session: {
        prompt: aiState?.prompt || '',
        activeTab,
        cropRect: cropRect ? { ...cropRect } : null,
        transform,
        adjust,
        aiParams,
        viewport,
        activeTool: tool,
      },
    };
  }

  function scheduleSave(delay = 800) {
    if (!doc || persistDisabled || leaseLocked) return;
    saveDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      void runSave();
    }, delay);
    // 空闲兜底：连续操作间隙也保证 5s 内至少落一次。
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (saveDirty) void runSave();
    }, 5000);
  }

  async function runSave() {
    if (!doc || persistDisabled || leaseLocked) return;
    if (saving) {
      savePending = true;
      return;
    }
    clearTimeout(saveRetryTimer);
    saveRetryTimer = 0;
    saving = true;
    saveDirty = false;
    setSaveState('saving');
    try {
      const estimate = await estimateStorage();
      if (estimate && estimate.ratio >= 0.8 && !quotaWarned) {
        quotaWarned = true;
        toastWarn(
          `浏览器本机存储已用 ${Math.round(estimate.ratio * 100)}%，自动保存可能失败；` +
            '可在「设置 · 关于」清理旧工程',
        );
      }
      const payload = await collectProject();
      if (!payload) return;
      await saveStudioProject(payload);
      saveRetryDelay = 0;
      saveWarned = false;
      setSaveState('saved');
      if (!persistRequested) {
        persistRequested = true;
        void requestPersistentStorage();
      }
    } catch (err) {
      saveDirty = true;
      setSaveState('error');
      if (!saveWarned) {
        saveWarned = true;
        const quotaExceeded = err?.name === 'QuotaExceededError';
        toastWarn(
          quotaExceeded
            ? '浏览器本机存储空间不足，自动保存暂停；请先导出，再在「设置 · 关于」清理旧工程'
            : '本地自动保存失败，编辑内容仍在内存中，可继续导出',
        );
      }
      saveRetryDelay = Math.min(30000, saveRetryDelay ? saveRetryDelay * 2 : 2000);
      saveRetryTimer = setTimeout(() => {
        saveRetryTimer = 0;
        if (doc) void runSave();
      }, saveRetryDelay);
    } finally {
      saving = false;
      if (savePending) {
        savePending = false;
        void runSave();
      }
    }
  }

  function flushSave() {
    if (!doc || persistDisabled || leaseLocked) return;
    clearTimeout(saveTimer);
    saveTimer = 0;
    clearTimeout(idleTimer);
    idleTimer = 0;
    if (saveDirty || saving) void runSave();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') flushSave();
  }

  function onPageHide() {
    flushSave();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  /* ---------------------------------------------------------- 恢复（D17.2） */

  function relativeTime(stamp) {
    if (!stamp) return '';
    const diff = Date.now() - stamp;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
    const date = new Date(stamp);
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function hideRestoreBar() {
    refs.restoreBar.hidden = true;
    pendingRestore = null;
  }

  async function applyRestore(saved) {
    if (restoring) return false;
    const base = (saved.layers || []).find((layer) => layer.id === 'base');
    if (!base?.bitmapBlob) {
      toastWarn('工程缺少主图，无法恢复');
      hideRestoreBar();
      return false;
    }
    restoring = true;
    const urls = [];
    try {
      const baseUrl = URL.createObjectURL(base.bitmapBlob);
      urls.push(baseUrl);
      const image = await loadImage(baseUrl);
      const next = new StudioDoc(image, saved.project.name || 'untitled.png');
      const session = saved.session || {};
      const transform = session.transform || {};
      next.transform.rotate = Number(transform.rotate) || 0;
      next.transform.flipH = Boolean(transform.flipH);
      next.transform.flipV = Boolean(transform.flipV);
      next.transform.crop = transform.crop ? { ...transform.crop } : null;
      next.adjust = { ...ADJUST_DEFAULTS, ...(session.adjust || {}) };
      next.mask = makeCanvas(next.oriented.width, next.oriented.height);
      if (base.maskBlob) {
        const maskUrl = URL.createObjectURL(base.maskBlob);
        urls.push(maskUrl);
        const maskImage = await loadImage(maskUrl);
        next.mask.getContext('2d').drawImage(maskImage, 0, 0);
      }

      const missing = [];
      for (const record of saved.layers || []) {
        if (record.id === 'base') continue;
        if (!record.bitmapBlob) {
          missing.push(record.props?.name || record.id);
          continue;
        }
        const layerUrl = URL.createObjectURL(record.bitmapBlob);
        urls.push(layerUrl);
        try {
          const layerImage = await loadImage(layerUrl);
          const props = record.props || {};
          const layer = next.addOverlay(layerImage, {
            name: props.name,
            x: props.x,
            y: props.y,
            scale: props.scale,
            opacity: props.opacity,
          });
          layer.rotation = Number(props.rotation) || 0;
          // 保留原图层 id，后续自动保存仍然增量更新同一批记录。
          layer.id = record.id;
          layerBlobs.set(record.id, record.bitmapBlob);
        } catch {
          missing.push(record.props?.name || record.id);
        }
      }

      next.history.length = 0;
      next.future.length = 0;
      next._historyBytes = 0;
      next.snapshot();

      projectId = saved.project.id;
      projectCreatedAt = saved.project.createdAt || Date.now();
      sourceBlob = base.bitmapBlob;
      cropRect = session.cropRect ? { ...session.cropRect } : null;
      startLease(projectId);

      setDoc(next, { restore: true, fit: false, tool: session.activeTool });
      if (cropRect) {
        refs.cropbar.hidden = false;
        refs.cropInfo.textContent = `${Math.round(cropRect.width)} × ${Math.round(cropRect.height)}`;
      }
      if (session.activeTab) {
        activeTab = normalizeTab(session.activeTab);
        syncTabs();
      }
      if (session.viewport && session.viewport.scale > 0) {
        view = { ...session.viewport };
        updateZoomLabel();
      } else {
        requestAnimationFrame(fitView);
      }

      // 参考图落库时是 Blob，面板内部统一用 dataURL。
      const restoredRefs = [];
      for (const item of saved.refs || []) {
        if (!item.blob) continue;
        try {
          const dataUrl = await readFileAsDataURL(item.blob);
          restoredRefs.push({ id: item.id, name: item.name, dataUrl, width: item.width, height: item.height });
        } catch {
          // 单张参考图坏了不影响其他内容恢复
        }
      }
      ai?.restoreState?.(session.aiParams || null, restoredRefs);

      updateSizeInfo();
      updateHistoryUi();
      updateMaskStatus();
      scheduleDraw();
      scheduleSave(600);
      hideRestoreBar();
      if (missing.length) toastWarn(`${missing.length} 个叠加层恢复失败，其余内容已恢复`);
      else toastSuccess('已恢复上次编辑');
      return true;
    } catch (err) {
      hideRestoreBar();
      toastError(err, '恢复工程失败');
      return false;
    } finally {
      restoring = false;
      for (const url of urls) URL.revokeObjectURL(url);
    }
  }

  async function maybeRestore() {
    if (restoreChecked || doc || persistDisabled) return;
    restoreChecked = true;
    try {
      const saved = await loadLastProject();
      if (!saved?.project || doc) return;
      const base = (saved.layers || []).find((layer) => layer.id === 'base');
      if (!base?.bitmapBlob) return;
      try {
        if (sessionStorage.getItem(`wb.studio.ignore.${saved.project.id}`)) return;
      } catch {
        // 隐私模式下读不到 sessionStorage，按未忽略处理
      }
      if (saved.project.tabId && saved.project.tabId === tabId()) {
        // 同一标签页刷新：直接恢复，不打断。
        await applyRestore(saved);
        return;
      }
      pendingRestore = saved;
      refs.restoreText.textContent = `上次编辑未完成 · ${relativeTime(saved.project.updatedAt)}`;
      refs.restoreBar.hidden = false;
    } catch {
      // 本地数据不可用时不打扰用户
    }
  }

  refs.restoreApply.addEventListener('click', async () => {
    if (!pendingRestore) return;
    refs.restoreApply.disabled = true;
    await applyRestore(pendingRestore);
    refs.restoreApply.disabled = false;
  });

  refs.restoreIgnore.addEventListener('click', () => {
    if (pendingRestore) {
      try {
        sessionStorage.setItem(`wb.studio.ignore.${pendingRestore.project.id}`, '1');
      } catch {
        // 记不住也无妨，下次打开最多再问一次
      }
    }
    hideRestoreBar();
  });

  /* ============================================================
   * 打开 / 载入 / 导出
   * ============================================================ */

  function baseName(name) {
    return String(name || 'studio').replace(/\.[^.]+$/, '') || 'studio';
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (/^https?:/i.test(src)) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片加载失败，可能是格式不支持或跨域限制'));
      image.src = src;
    });
  }

  function fileTooLarge(file, label = '图片') {
    if (file.size <= MAX_FILE_BYTES) return false;
    toastWarn(`${label}超过 ${Math.round(MAX_FILE_BYTES / 1048576)}MB，请先压缩`);
    return true;
  }

  function imageTooLarge(image, label = '图片') {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE && width * height <= MAX_IMAGE_PIXELS) {
      return false;
    }
    toastWarn(`${label}尺寸过大（${width}×${height}），请压缩到长边 ≤ ${MAX_IMAGE_SIDE}、总像素 ≤ 4000 万`);
    return true;
  }

  let openSeq = 0;

  async function openFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    if (fileTooLarge(file)) return;
    const url = URL.createObjectURL(file);
    const token = ++openSeq;
    try {
      const image = await loadImage(url);
      if (token !== openSeq) return;
      if (imageTooLarge(image)) return;
      flushSave();
      beginProject();
      startLease(projectId);
      sourceBlob = file;
      setDoc(new StudioDoc(image, file.name || 'untitled.png'));
    } catch (err) {
      toastError(err, '打开图片失败');
    } finally {
      URL.revokeObjectURL(url);
      refs.fileInput.value = '';
    }
  }

  async function openUrl(url, name) {
    const token = ++openSeq;
    try {
      const image = await loadImage(url);
      if (token !== openSeq) return false;
      if (imageTooLarge(image)) return false;
      const next = new StudioDoc(image, name || 'material.png');
      const fetched = await fetchBlob(url);
      if (token !== openSeq) return false;
      flushSave();
      beginProject();
      startLease(projectId);
      // 外链/历史图取不到原文件时，用空白文档先编码一份原图，避免把叠加层烘进底图。
      sourceBlob = fetched || (await next.bakeBlob('image/png').catch(() => null));
      setDoc(next);
      return true;
    } catch (err) {
      if (token === openSeq) toastError(err, '打开图片失败');
      return false;
    }
  }

  function setDoc(next, options = {}) {
    doc = next;
    if (!options.restore) layerBlobs.clear();
    cropRect = null;
    tint = null;
    tintDirty = true;
    tintRect = null;
    adjustPreview = false;
    refs.cropbar.hidden = true;
    refs.empty.hidden = true;
    refs.dot.classList.add('is-live');
    refs.fileName.textContent = doc.name;
    refs.dims.textContent = '';
    for (const key of ['exportBtn', 'sendBtn', 'compareAllBtn']) refs[key].disabled = false;
    syncAdjustInputs();
    updateSizeInfo();
    updateHistoryUi();
    updateMaskStatus();
    setTool(options.tool || (tool === 'view' ? 'view' : tool));
    setPreview(null);
    if (!options.restore) {
      ai?.resetTaskContext?.();
      scheduleSave(600);
    }
    ai?.refresh?.();
    if (persistDisabled && !storageWarned) {
      storageWarned = true;
      toastWarn('当前浏览器不支持本机工程存储，刷新或关闭页面后编辑会丢失');
    }
    requestAnimationFrame(() => {
      if (options.fit !== false) fitView();
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
    const stats = doc.maskStats();
    refs.statusMask.textContent = `蒙版 ${(stats.coverage * 100).toFixed(1)}%`;
    refs.maskClear.disabled = !stats.has;
    refs.maskExport.disabled = !stats.has;
    ai?.onMaskChanged?.(stats.coverage);
  }

  function syncAdjustInputs() {
    if (!doc) return;
    adjustPreview = false;
    for (const input of host.querySelectorAll('[data-adjust]')) {
      const value = doc.adjust[input.dataset.adjust] ?? 0;
      input.value = String(value);
      const label = host.querySelector(`[data-value="${input.dataset.adjust}"]`);
      if (label) label.textContent = String(value);
    }
  }

  /** 不支持 Canvas filter 时禁用相关滑杆并说明，避免「滑杆有反应但画面没变」。 */
  function applyCanvasFilterCapability() {
    if (supportsCanvasFilter) return;
    for (const key of ['exposure', 'brightness', 'contrast', 'saturation']) {
      const input = host.querySelector(`[data-adjust="${key}"]`);
      if (input) input.disabled = true;
    }
    refs.filterNote.hidden = false;
    refs.filterNote.textContent =
      '当前浏览器不支持画布滤镜：曝光 / 亮度 / 对比度 / 饱和度已禁用，色温与色调仍可用。';
  }

  async function commitTransform(label, action) {
    if (!doc) return;
    const lost = [];
    if (doc.layers.length) lost.push(`${doc.layers.length} 个叠加层`);
    if (doc.transform.crop) lost.push('裁剪区域');
    if (lost.length) {
      const ok = await confirmDialog({
        title: label,
        message: `${label}会清空${lost.join('、')}（可用 Ctrl+Z 撤销），确定继续？`,
        confirmText: '继续',
        danger: true,
      });
      if (!ok || !doc) return;
    }
    action();
    updateSizeInfo();
    updateHistoryUi();
    updateMaskStatus();
    tintDirty = true;
    fitView();
    selectedLayerId = null;
    ai?.refresh?.();
    scheduleSave();
  }

  function downloadDataUrl(dataUrl, filename) {
    if (!dataUrl) {
      toastWarn('没有可下载的内容');
      return;
    }
    downloadUrl(dataUrl, filename);
  }

  /** AI 预览只画在画布上，导出/复制/收藏/送编辑都读底图，先拦住避免「所见非所得」。 */
  function previewBlocked(action) {
    if (!preview.image) return false;
    toastWarn(`当前显示的是 AI 预览，导出的是载入前的底图。请先点「载入为新底图」或关闭预览再${action}`);
    return true;
  }

  async function copyToClipboard() {
    if (!doc) return;
    if (previewBlocked('复制')) return;
    flushAdjustPreview();
    try {
      const blob = await doc.bakeBlob('image/png');
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
    if (previewBlocked('收藏')) return;
    flushAdjustPreview();
    refs.exportBtn.disabled = true;
    try {
      const blob = await doc.bakeBlob('image/png');
      await favoriteImage({
        image: await readFileAsDataURL(blob),
        kind: 'studio',
        category: '精修',
        prompt: '',
        seed: null,
        source: 'studio',
        title: baseName(doc.name),
      });
    } catch (err) {
      toastError(err, '收藏失败');
    } finally {
      refs.exportBtn.disabled = false;
    }
  }

  async function sendToEdit() {
    if (!doc) return;
    if (previewBlocked('送入图像编辑')) return;
    flushAdjustPreview();
    try {
      const [blob, maskBlob] = await Promise.all([doc.bakeBlob('image/png'), doc.maskBlob()]);
      const [dataUrl, mask] = await Promise.all([
        readFileAsDataURL(blob),
        maskBlob ? readFileAsDataURL(maskBlob) : Promise.resolve(null),
      ]);
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

  async function exportImage(type, name) {
    if (!doc) return;
    if (previewBlocked('导出')) return;
    flushAdjustPreview();
    refs.exportBtn.disabled = true;
    try {
      const blob = await doc.bakeBlob(type, 0.92);
      const url = URL.createObjectURL(blob);
      downloadUrl(url, name);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      toastError(err, '导出失败');
    } finally {
      refs.exportBtn.disabled = false;
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
    if (tool === 'outpaint') setTool('view');
    activeTab = button.dataset.tab;
    syncTabs();
  });

  /* ---------------------------------------------------------- 顶栏导入菜单 */

  function setImportMenu(open) {
    refs.importMenu.hidden = !open;
    refs.openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function focusImportItem(index) {
    const items = [...refs.importMenu.querySelectorAll('[data-import]')];
    if (!items.length) return;
    const next = (index + items.length) % items.length;
    items[next].focus();
  }

  refs.openBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setExportMenu(false);
    setImportMenu(refs.importMenu.hidden);
  });

  refs.openBtn.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setImportMenu(true);
    focusImportItem(0);
  });

  refs.importMenu.addEventListener('keydown', (event) => {
    const items = [...refs.importMenu.querySelectorAll('[data-import]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setImportMenu(false);
      refs.openBtn.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusImportItem(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusImportItem(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusImportItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusImportItem(items.length - 1);
    }
  });

  refs.importMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-import]');
    if (!item) return;
    setImportMenu(false);
    const source = item.dataset.import;
    if (source === 'local') refs.fileInput.click();
    else openMainPicker(source);
  });

  /* ---------------------------------------------------------- 顶栏导出菜单 */

  function setExportMenu(open) {
    refs.exportMenu.hidden = !open;
    refs.exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function focusExportItem(index) {
    const items = [...refs.exportMenu.querySelectorAll('[data-export]')];
    if (!items.length) return;
    items[(index + items.length) % items.length].focus();
  }

  function runExport(action) {
    if (!doc) return;
    const name = baseName(doc.name);
    if (action === 'png') exportImage('image/png', `${name}-edited.png`);
    else if (action === 'jpg') exportImage('image/jpeg', `${name}-edited.jpg`);
    else if (action === 'copy') copyToClipboard();
    else if (action === 'favorite') void collect();
    else if (action === 'mask') {
      const dataUrl = doc.maskPng();
      if (!dataUrl) {
        toastWarn('还没有涂抹蒙版');
        return;
      }
      downloadDataUrl(dataUrl, `${name}-mask.png`);
    }
  }

  refs.exportBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (refs.exportBtn.disabled) return;
    setImportMenu(false);
    setExportMenu(refs.exportMenu.hidden);
  });

  refs.exportBtn.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || refs.exportBtn.disabled) return;
    event.preventDefault();
    setExportMenu(true);
    focusExportItem(0);
  });

  refs.exportMenu.addEventListener('keydown', (event) => {
    const items = [...refs.exportMenu.querySelectorAll('[data-export]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setExportMenu(false);
      refs.exportBtn.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusExportItem(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusExportItem(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusExportItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusExportItem(items.length - 1);
    }
  });

  refs.exportMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-export]');
    if (!item) return;
    setExportMenu(false);
    runExport(item.dataset.export);
  });

  function onDocumentClick(event) {
    if (!refs.importMenu.hidden && !refs.importWrap.contains(event.target)) setImportMenu(false);
    if (!refs.exportMenu.hidden && !refs.exportWrap.contains(event.target)) setExportMenu(false);
  }
  document.addEventListener('click', onDocumentClick);

  refs.emptyOpen.addEventListener('click', () => refs.fileInput.click());
  refs.emptyWarehouse.addEventListener('click', () => openMainPicker('warehouse'));
  refs.fileInput.addEventListener('change', () => {
    const files = [...(refs.fileInput.files || [])];
    refs.fileInput.value = '';
    void importLocalFiles(files);
  });

  refs.sendBtn.addEventListener('click', sendToEdit);
  refs.compareAllBtn.addEventListener('click', () => {
    void ai?.compareAll?.();
  });

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
      scheduleSave();
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
      scheduleSave();
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
      // 拖动期间只出低分辨率代理，避免每帧过滤 4K（D18.2）。
      adjustPreview = true;
      const label = host.querySelector(`[data-value="${key}"]`);
      if (label) label.textContent = input.value;
      scheduleDraw();
    });
    input.addEventListener('change', () => {
      if (!doc) return;
      if (adjustPreview) {
        adjustPreview = false;
        doc.invalidateBase();
      }
      doc.snapshot();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
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
    scheduleSave();
  });

  for (const input of host.querySelectorAll('[data-brush]')) {
    input.addEventListener('input', () => {
      const key = input.dataset.brush;
      const value = Number(input.value);
      if (key === 'size') brush.size = value;
      if (key === 'hardness') brush.hardness = value / 100;
      if (key === 'opacity') brush.opacity = value / 100;
      const label = host.querySelector(`.studio-maskbar [data-value="${key}"]`);
      if (label) label.textContent = key === 'size' ? `${value} px` : `${value}%`;
      scheduleDraw();
    });
  }

  /* 蒙版工具浮条：下拉切换画笔类工具，参数与快捷键共用同一份 brush 状态。 */
  refs.maskTool.addEventListener('change', () => {
    if (MASK_TOOLS.has(refs.maskTool.value)) setTool(refs.maskTool.value);
  });

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
    scheduleSave();
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

  refs.rotateLeft.addEventListener('click', () => commitTransform('向左旋转', () => doc?.rotateLeft()));
  refs.rotateRight.addEventListener('click', () => commitTransform('向右旋转', () => doc?.rotateRight()));
  refs.flipH.addEventListener('click', () => commitTransform('水平翻转', () => doc?.flip('h')));
  refs.flipV.addEventListener('click', () => commitTransform('垂直翻转', () => doc?.flip('v')));

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
    scheduleSave();
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
    scheduleSave();
  });

  refs.resetAll.addEventListener('click', async () => {
    if (!doc) return;
    const layerNote = doc.layers.length ? `、${doc.layers.length} 个叠加层` : '';
    const ok = await confirmDialog({
      title: '恢复原始图片',
      message: `会清空所有调色、裁剪、蒙版${layerNote}（原图不会被删除），确定继续？`,
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
    scheduleSave();
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

  /* ---------------------------------------------------------- 导入分流（D1.2） */

  /** 统一导入入口：有主图时全部转参考图，无主图时第一张开为主图。 */
  async function importPicked(items) {
    const list = Array.isArray(items) ? items.filter((item) => item?.src) : [];
    if (!list.length) return;
    if (doc) {
      await ai.addRefItems(list);
      return;
    }
    const [first, ...rest] = list;
    const opened = await openUrl(first.src, first.name);
    if (opened && rest.length) await ai.addRefItems(rest);
  }

  async function importLocalFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file.type?.startsWith('image/'));
    if (!files.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    if (doc) {
      await ai.addRefFiles(files);
      return;
    }
    const [first, ...rest] = files;
    await openFile(first);
    if (doc && rest.length) await ai.addRefFiles(rest);
  }

  function openMainPicker(source) {
    openImportPicker({
      title: '导入图片',
      accept: 'main',
      multiple: false,
      initialSource: source,
      onPick(items) {
        void importPicked(items);
      },
    });
  }

  /** 小图库 / 历史胶囊的 application/x-wb-ref 载荷 → 参考图。 */
  async function importLibraryRef(raw) {
    try {
      const src = await urlToDataUrl(raw.src);
      await ai.addRefItems([
        { name: raw.name || '参考图', src, width: raw.width, height: raw.height },
      ]);
    } catch (err) {
      toastError(err, '读取参考图失败');
    }
  }

  /* ---------------------------------------------------------- 拖拽与粘贴 */

  const hasType = (event, type) => Boolean(event.dataTransfer && [...event.dataTransfer.types].includes(type));

  ['dragenter', 'dragover'].forEach((type) => {
    stageEl.addEventListener(type, (event) => {
      if (!hasType(event, 'Files') && !hasType(event, REF_MIME)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      stageEl.classList.add('is-dropping');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    stageEl.addEventListener(type, (event) => {
      stageEl.classList.remove('is-dropping');
      if (type === 'dragleave') return;
      const refRaw = event.dataTransfer?.getData(REF_MIME);
      if (refRaw) {
        event.preventDefault();
        try {
          const raw = JSON.parse(refRaw);
          if (raw?.src) void importLibraryRef(raw);
        } catch {
          toastWarn('这张参考图的数据已失效，请重新从图库拖入');
        }
        return;
      }
      const files = filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      void importLocalFiles(files);
    });
  });

  async function onPaste(event) {
    if (!isActive()) return;
    if (isEditableTarget(event.target)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    // 粘贴会替换主图并清空历史，已有编辑时先确认，避免误丢工作。
    if (doc) {
      const ok = await confirmDialog({
        title: '替换当前图片',
        message: '粘贴的图片会替换当前主图，未导出的编辑将丢失。确定继续？',
        confirmText: '替换',
        danger: true,
      });
      if (!ok || !doc) return;
    }
    openFile(file);
  }

  /* ---------------------------------------------------------- 键盘 */

  function isActive() {
    return host.isConnected && host.offsetParent !== null;
  }

  /** 指令框、参考图输入、弹窗内的输入都算可编辑区域，不抢快捷键与粘贴。 */
  function isEditableTarget(target) {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    if (el.closest('.modal, .modal-backdrop')) return true;
    if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]')) {
      return true;
    }
    return Boolean(el.isContentEditable);
  }

  function onKeyDown(event) {
    if (!isActive()) return;
    if (isEditableTarget(event.target)) return;
    // 其他标签正在编辑本工程时，键盘编辑快捷键一并禁用。
    if (leaseLocked) return;
    // 按住 \ 临时闪回底图，替代原来被劫持的 Tab（保留键盘导航）。
    if (event.key === '\\' && preview.image) {
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
      // 按钮/链接获得焦点时保留空格的原生激活行为，不抢来平移。
      const target = event.target;
      if (target instanceof Element && target.closest('button, a, [role="button"], summary')) return;
      spaceDown = true;
      refs.canvas.classList.add('is-grab');
      event.preventDefault();
      return;
    }
    if (!mod && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void ai?.compareAll?.();
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
    if (event.key === '\\' && preview.flash) {
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
  window.addEventListener('paste', onPaste);

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

  function applyStudioHandoff() {
    const payload = consumeStudioHandoff();
    if (!payload) return false;
    void openUrl(payload.url, payload.name || 'material.png').then((ok) => {
      if (ok) toastSuccess(payload.toast);
      else void maybeRestore();
    });
    return true;
  }
  // 页面刚创建时画布还没有尺寸，先初始化一次
  requestAnimationFrame(() => {
    sizeCanvas();
    updateMaskStatus();
    updateHistoryUi();
    setTool(tool);
    syncTabs();
    applyCanvasFilterCapability();
    if (persistDisabled) setSaveState('off');
    if (!doc) refs.statusTool.textContent = '未打开图片 · 支持拖拽 / 粘贴';
  });

  return {
    onShow() {
      sizeCanvas();
      if (doc) {
        requestAnimationFrame(fitView);
        return;
      }
      // 有素材仓库交接时优先打开交接图，否则尝试恢复上次未完成的工程。
      if (!applyStudioHandoff()) {
        void maybeRestore().then(() => {
          // 顺带清理超过 7 天或排名 10 名之外的旧工程，正在被其他标签编辑的跳过。
          void cleanupProjects({ keep: 10, maxAgeDays: 7, keepId: projectId, tabId: tabId() });
        });
      }
    },
    /** 页面被移除时统一解绑，避免全局监听器与观察器在旧实例上累积。 */
    destroy() {
      flushSave();
      stopLease();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('paste', onPaste);
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      clearTimeout(saveTimer);
      clearTimeout(idleTimer);
      clearTimeout(saveRetryTimer);
      clearTimeout(saveStateTimer);
      resizeObserver.disconnect();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      spaceDown = false;
      outpaint?.destroy?.();
      outpaint = null;
      ai?.destroy?.();
      tint = null;
      tintDirty = true;
      thumbCache = { doc: null, base: null, url: '' };
      preview = { url: '', image: null, flash: false };
      doc = null;
      host.innerHTML = '';
    },
  };
}
