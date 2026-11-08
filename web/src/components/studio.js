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

import { downloadUrl, fmtCoverage, fmtNum, loadImage, readFileAsDataURL, escapeHtml } from '../utils.js';
import { api, pollJob } from '../api.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { confirmDialog, openModal } from './modal.js';
import { favoriteImage } from './favorites.js';
import { StudioDoc, ADJUST_DEFAULTS, supportsCanvasFilter, canvasToBlob, makeCanvas } from './studio/studioDoc.js';
import { mountAiPanel } from './studio/aiPanel.js';
import { mountOutpaintPanel } from './studio/outpaintPanel.js';
import { openUpscaleDialog } from './studio/upscaleDialog.js';
import { REF_MIME, filesFromDataTransfer, openImportPicker, urlToDataUrl } from './studio/importPicker.js';
import {
  addStudioVersion,
  clearLastProject,
  clearProject,
  cleanupProjects,
  createProjectLease,
  deleteStudioVersion,
  estimateStorage,
  leaseHeldByOther,
  listStudioVersions,
  loadLastProject,
  loadProject,
  loadStudioVersionBlob,
  listProjects,
  newProjectId,
  requestPersistentStorage,
  saveStudioProject,
  storageAvailable,
  trimStudioVersions,
} from './studio/persistence.js';
import { consumeStudioHandoff, goToEditPage, setHandoff } from '../handoff.js';
import { createPerfProbe } from './studio/perf.js';
import {
  buildOutlinePath,
  combineAlpha,
  contractAlpha,
  createAlpha,
  expandAlpha,
  featherAlpha,
  invertAlpha,
  alphaToCanvas,
  coverageAlpha,
  wandAlpha,
} from './studio/selection.js';
import { CUTOUT_EDGE_ORDER, CUTOUT_EDGE_PRESETS, cutoutRect, prepareCutoutAlpha } from './studio/cutout.js';
import { histogram, parseCube } from './studio/color.js';
import { ADJUSTMENT_DEFAULTS } from './studio/adjustments.js';
import { healDab, cloneDab } from './studio/heal.js';
import { normalizeVector, smudgeDab, smudgeShift } from './studio/smudge.js';
import { skinDab } from './studio/skin.js';
import { warpPatch } from './studio/liquify.js';
import { mosaicDab } from './studio/mosaic.js';
import { TEXT_DEFAULTS, TEXT_FONTS } from './studio/textLayer.js';
import { BLEND_MODES } from './studio/layers.js';
import { SHAPE_DEFAULTS, SHAPE_KINDS, SHAPE_STYLE_DEFAULTS, ShapeLayer, normalizeShapeStyle } from './studio/shapeLayer.js';
import { patternDab } from './studio/pattern.js';
import { SEGMENT_MODES, maskGrayToAlpha, segmentSendSize, sortSegmentMasks, toSendBox, toSendPoints } from './studio/segment.js';
import { drawLayers } from './studio/renderer.js';

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
    id: 'wand',
    label: '魔棒选区',
    key: 'W',
    hint: '点一下选中相近颜色；Shift 加选，Alt 减选',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5l5 5-3 3-5-5 3-3z"/><path d="M11.5 7.5L4 15l5 5 7.5-7.5"/><path d="M6.5 17.5l-.8 2.2 2.2-.8"/><path d="M18 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8.8-1.7z"/></svg>',
  },
  {
    id: 'segment',
    label: 'AI 主体选择',
    key: 'A',
    hint: '点一下自动选主体；也可框选 / 点选 / 输入文字描述（D13.1）',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l1.7 3.9 3.9 1.7-3.9 1.7L12 14.4l-1.7-3.9-3.9-1.7 3.9-1.7L12 3.2z"/><path d="M18.4 14.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z"/><path d="M5 18.5l4-4"/><path d="M5 15.5v3h3"/></svg>',
  },
  {
    id: 'spot',
    label: '污点修复',
    key: 'J',
    hint: '在瑕疵上涂抹，自动用周围颜色填补；大小/硬度可调',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.2"/><path d="M11 4.8v2.4"/><path d="M11 14.8v2.4"/><path d="M4.8 11h2.4"/><path d="M14.8 11h2.4"/><path d="M18.5 17.5l2 2"/><path d="M19.2 16.2a1.6 1.6 0 1 1 2.3 2.3"/></svg>',
  },
  {
    id: 'clone',
    label: '仿制图章',
    key: 'S',
    hint: 'Alt 点击取样，再涂抹复制；可切换对齐/非对齐',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20h8"/><path d="M10 20v-4.2L7.4 13a2 2 0 0 1-.4-1.2V7.5A1.5 1.5 0 0 1 8.5 6h7A1.5 1.5 0 0 1 17 7.5v4.3a2 2 0 0 1-.4 1.2L14 15.8V20"/><path d="M12 6V3.5"/><path d="M10.5 3.5h3"/></svg>',
  },
  {
    id: 'healbrush',
    label: '修复画笔',
    key: 'H',
    hint: 'Alt 点击取样，再涂抹：复制纹理并匹配目标色度',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5l5 5-8.5 8.5-5-5 8.5-8.5z"/><path d="M6 13l-2 5 5-2"/><path d="M18 17.5l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5z"/></svg>',
  },
  {
    id: 'smudge',
    label: '涂抹',
    key: 'U',
    hint: '拖动把像素沿方向推开，适合做水面/发丝拖尾',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16c3.2 0 3.2-8 6.4-8s3.2 8 6.4 8 3.2-4 3.2-4"/><path d="M4 20c3.2 0 3.2-4 6.4-4s3.2 4 6.4 4 3.2-2 3.2-2"/></svg>',
  },
  {
    id: 'skin',
    label: '磨皮',
    key: 'K',
    hint: '频率分离式柔化：抹平肤色过渡，保留毛孔与发丝细节',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c4.2 0 7-3 7-7.4C19 8 15.5 4 12 4S5 8 5 12.6C5 17 7.8 20 12 20z"/><path d="M9.2 11.4c.6.5 1.2.5 1.8 0"/><path d="M13 11.4c.6.5 1.2.5 1.8 0"/><path d="M10.2 15c1.1.8 2.5.8 3.6 0"/></svg>',
  },
  {
    id: 'liquify',
    label: '液化',
    key: 'Y',
    hint: '按住拖动推开像素，做瘦脸/拉长等局部形变',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8c3.5 0 4.5 8 8 8s4.5-8 8-8"/><path d="M9 4.5l-2 2 2 2"/><path d="M15 19.5l2-2-2-2"/></svg>',
  },
  {
    id: 'mosaic',
    label: '马赛克 / 模糊',
    key: 'P',
    hint: '涂抹打码；可在浮条切换马赛克与局部模糊',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="4" y="4" width="5" height="5"/><rect x="9" y="4" width="5" height="5"/><rect x="4" y="9" width="5" height="5"/><rect x="14" y="9" width="5" height="5"/><rect x="9" y="14" width="5" height="5"/><rect x="14" y="14" width="5" height="5"/></svg>',
  },
  {
    id: 'text',
    label: '文字',
    key: 'T',
    hint: '在画面上点一下创建文字图层，右侧可改文案/字体/描边/投影',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6V4.5h14V6"/><path d="M12 4.5V20"/><path d="M9 20h6"/></svg>',
  },
  {
    id: 'sticker',
    label: '贴纸',
    key: 'G',
    hint: '点画面空白处导入图片；点已有贴纸可拖动，拖角缩放、拖圆点旋转',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h15v9l-5.5 5.5h-9.5z"/><path d="M19.5 14.5H14v5.5"/><path d="M8 10.5c.9-.8 1.8-.8 2.7 0"/><path d="M13.3 10.5c.9-.8 1.8-.8 2.7 0"/><path d="M9.4 13.4c1.5 1.1 3.7 1.1 5.2 0"/></svg>',
  },
  {
    id: 'shape',
    label: '形状',
    key: 'D',
    hint: '拖动画出矩形/椭圆/直线/箭头；右侧可调填充、描边与圆角',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="10" height="10" rx="1.5"/><circle cx="16" cy="14" r="4.5"/></svg>',
  },
  {
    id: 'pattern',
    label: '图案图章',
    key: 'N',
    hint: 'Alt 拖框取样，再涂抹按图案平铺复制',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20h8"/><path d="M10 20v-4.2L7.4 13a2 2 0 0 1-.4-1.2V7.5A1.5 1.5 0 0 1 8.5 6h7A1.5 1.5 0 0 1 17 7.5v4.3a2 2 0 0 1-.4 1.2L14 15.8V20"/><path d="M10.5 9h3v3h-3z"/></svg>',
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
/** 使用笔刷参数的工具（蒙版涂抹 + 污点修复 + 仿制类，D10） */
const BRUSH_PARAM_TOOLS = new Set(['brush', 'eraser', 'spot', 'clone', 'healbrush', 'smudge', 'skin', 'liquify', 'mosaic', 'pattern']);
/** 仿制图章 / 修复画笔（D10.2） */
const CLONE_TOOLS = new Set(['clone', 'healbrush']);
/** 需要笔刷浮条的工具（含修复类，浮条在 is-heal 下精简） */
const HEAL_TOOLS = new Set(['spot', 'clone', 'healbrush', 'smudge', 'skin', 'liquify', 'mosaic', 'pattern']);
/** 需要「选区浮条」的工具（魔棒，或有选区时的任意工具）。 */
const WAND_TOOLS = new Set(['wand']);

/** 左栏分组：只影响 DOM 分组，工具行为仍走 setTool。 */
const TOOL_GROUPS = [
  { id: 'view', title: '查看', tools: ['view'] },
  { id: 'select', title: '选区', tools: ['wand', 'segment', 'brush', 'eraser', 'rect', 'ellipse', 'lasso'] },
  { id: 'repair', title: '修复', tools: ['spot', 'clone', 'healbrush', 'smudge', 'skin', 'liquify', 'mosaic', 'pattern'] },
  { id: 'transform', title: '变换', tools: ['crop', 'move'] },
  { id: 'compose', title: '文字 / 贴纸 / 形状', tools: ['text', 'sticker', 'shape'] },
  { id: 'generate', title: '生成', tools: ['outpaint'] },
];

export function createStudioPage(host) {
  let doc = null;
  let thumbCache = { doc: null, base: null, url: '' };
  let tool = 'view';
  /** 每组上次用过的工具（组按钮显示它，flyout 里也据此高亮）。 */
  const groupTool = new Map();
  let openGroupId = '';
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
  /* D11.3：贴纸工具点击画面后等待文件选择，记录落点（图像坐标）。 */
  let pendingStickerPoint = null;
  /* D11.4：形状工具的新建样式（无选中形状时作为默认值）。 */
  const shapeStyle = { ...SHAPE_DEFAULTS, style: normalizeShapeStyle() };
  /* D11.4：图案图章的取样矩形（图像坐标，未裁剪空间）。 */
  let patternRect = null;
  /* D13.3：透视四角编辑模式（选中贴纸时生效）。 */
  let perspectiveEdit = false;
  /* D8.1 选区：alpha 缓冲与画布同 doc.mask（旋转后、未裁剪坐标） */
  let selection = null;
  let selPath = null;
  let antsTimer = 0;
  let antsOffset = 0;
  let wand = { tolerance: 32, contiguous: true };
  let selRadius = 8;
  /* D13.1 AI 主体选择：模式、点提示（未裁剪图像坐标）、候选与请求状态 */
  let segMode = 'subject';
  let segPoints = [];
  let segCandidates = [];
  let segAppliedId = '';
  let segBusy = false;
  let segJob = null;
  /* D8.2 图层蒙版：当前正在涂抹的叠加层 id（空 = 涂抹文档蒙版） */
  let editingLayerMaskId = '';
  /* D9.4 局部调整：正在画布上拉取的渐变类型（null = 未进入取景模式） */
  let localEdit = null;
  /* D10.2 仿制取样：锚点（文档坐标）与对齐偏移 */
  let cloneAnchor = null;
  let cloneOffset = null;
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
  /* D22.2：「新建项目 · 本地图片」等选择器返回后再关闭旧工程，避免用户取消选择时误关。 */
  let pendingNewProject = false;
  /* D22.1：底部 Dock 的主图版本链（按时间正序，原始版本固定第一张）。 */
  let versions = [];
  let currentVersionId = '';
  let versionToken = 0;
  const MAX_VERSIONS = 30;
  /* D17.3：多标签租约、配额告警与持久化申请。 */
  let lease = null;
  let leaseLocked = false;
  let quotaWarned = false;
  let persistRequested = false;

  host.innerHTML = `
    <div class="page page-studio">
      <div class="studio">
        <div class="studio-bar">
          <div class="studio-import" data-ref="projWrap">
            <button class="btn ghost sm studio-proj-btn" type="button" data-ref="projBtn" aria-haspopup="menu" aria-expanded="false" title="项目：新建 / 保存 / 关闭 / 删除">＋</button>
            <div class="studio-import-menu studio-proj-menu" role="menu" data-ref="projMenu" hidden>
              <button type="button" role="menuitem" data-proj="new-local">新建项目 · 本地图片</button>
              <button type="button" role="menuitem" data-proj="new-warehouse">新建项目 · 素材仓库</button>
              <button type="button" role="menuitem" data-proj="save">立即保存（Ctrl+S）</button>
              <button type="button" role="menuitem" data-proj="rename">重命名项目</button>
              <button type="button" role="menuitem" data-proj="close">关闭项目</button>
              <button type="button" role="menuitem" data-proj="delete">删除当前项目</button>
            </div>
          </div>
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
              <button type="button" role="menuitem" data-import="newmain" hidden>作为新主图（新建项目）</button>
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
              <button type="button" role="menuitem" data-export="cutout-png">选区 · 透明 PNG</button>
              <button type="button" role="menuitem" data-export="cutout-copy">选区 · 复制到剪贴板</button>
              <button type="button" role="menuitem" data-export="copy">复制到剪贴板</button>
              <button type="button" role="menuitem" data-export="favorite">收藏到素材仓库</button>
              <button type="button" role="menuitem" data-export="send">发送到图像编辑 →</button>
            </div>
          </div>
          <button class="btn ghost sm" type="button" data-ref="upscaleBtn" disabled title="高清放大当前画面（VOSR2 / SeedVR2 / FlashVSR）">放大</button>
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
                <label class="studio-check studio-maskbar-align" data-ref="cloneAlignWrap" hidden>
                  <input type="checkbox" data-ref="cloneAligned" checked /><span>对齐取样</span>
                </label>
                <label class="studio-maskbar-field studio-maskbar-mode" data-ref="mosaicModeWrap" hidden>
                  <span>模式</span>
                  <select class="select" data-ref="mosaicMode">
                    <option value="mosaic">马赛克</option>
                    <option value="blur">局部模糊</option>
                  </select>
                </label>
                <span class="studio-maskbar-field" data-ref="patternWrap" hidden>
                  <span data-ref="patternHint">Alt 拖框取样</span>
                  <button class="btn ghost sm" type="button" data-ref="patternClear">清除图案</button>
                </span>
                <span class="spacer"></span>
                <button class="btn ghost sm" type="button" data-ref="maskExport">导出蒙版</button>
                <button class="btn ghost sm" type="button" data-ref="maskClear">清除蒙版</button>
              </div>
              <div class="studio-selbar" data-ref="selbar" hidden>
                <span class="studio-selbar-title">选区</span>
                <label class="studio-maskbar-field">
                  <span>容差</span>
                  <input type="range" min="0" max="255" step="1" value="32" data-sel="tolerance" />
                  <span class="mono" data-value="tolerance">32</span>
                </label>
                <label class="studio-check"><input type="checkbox" data-ref="wandContig" checked /><span>连续</span></label>
                <span class="studio-sep"></span>
                <label class="studio-maskbar-field">
                  <span>半径</span>
                  <input class="studio-selbar-num" type="number" min="0" max="200" step="1" value="8" data-ref="selRadius" />
                </label>
                <button class="btn ghost sm" type="button" data-sel-op="invert">反选</button>
                <button class="btn ghost sm" type="button" data-sel-op="feather">羽化</button>
                <button class="btn ghost sm" type="button" data-sel-op="expand">扩展</button>
                <button class="btn ghost sm" type="button" data-sel-op="contract">收缩</button>
                <button class="btn ghost sm" type="button" data-sel-op="mask">转为蒙版</button>
                <button class="btn primary sm" type="button" data-sel-op="remove">AI 消除</button>
                <div class="studio-import" data-ref="cutWrap">
                  <button
                    class="btn ghost sm"
                    type="button"
                    data-ref="cutBtn"
                    aria-haspopup="menu"
                    aria-expanded="false"
                    title="把当前选区抠成透明图（不改文档）"
                  >抠出选区 ▾</button>
                  <div class="studio-import-menu studio-cut-menu" role="menu" data-ref="cutMenu" hidden>
                    <div class="studio-cut-head">
                      <span>边缘</span>
                      <div class="studio-cut-edges" data-ref="cutEdges"></div>
                    </div>
                    <button type="button" role="menuitem" data-cut="png">透明 PNG</button>
                    <button type="button" role="menuitem" data-cut="copy">复制到剪贴板</button>
                    <button type="button" role="menuitem" data-cut="layer">新建抠图层</button>
                    <button type="button" role="menuitem" data-cut="white">白底 JPG</button>
                  </div>
                </div>
                <button class="btn ghost sm" type="button" data-sel-op="clear">清除选区</button>
                <span class="spacer"></span>
                <span class="mono" data-ref="selInfo">未选区</span>
              </div>
              <div class="studio-segbar" data-ref="segbar" hidden>
                <span class="studio-selbar-title">主体选择</span>
                <div class="studio-segmodes" data-ref="segModes"></div>
                <label class="studio-check"><input type="checkbox" data-ref="segMulti" /><span>多候选</span></label>
                <label class="studio-maskbar-field">
                  <span>羽化</span>
                  <input class="studio-selbar-num" type="number" min="0" max="32" step="1" value="2" data-ref="segFeather" />
                </label>
                <input class="input studio-segtext" type="text" placeholder="描述要选的主体，如：人物 / 沙发" data-ref="segText" hidden />
                <button class="btn primary sm" type="button" data-ref="segRun" hidden>选取</button>
                <button class="btn ghost sm" type="button" data-ref="segClear">清空提示</button>
                <span class="spacer"></span>
                <span class="mono studio-segstatus" data-ref="segStatus">点一下画面，自动选出最显著主体</span>
                <div class="studio-segcands" data-ref="segCands" hidden></div>
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
              <button type="button" data-tab="text">文字</button>
              <button type="button" data-tab="sticker">贴纸</button>
              <button type="button" data-tab="shape">形状</button>
            </div>

            <div class="studio-pane studio-pane-ai" data-pane="ai">
              <div data-ref="aiPane"></div>
            </div>

            <div class="studio-pane studio-pane-outpaint" data-pane="outpaint" hidden>
              <div data-ref="outpaintPane"></div>
            </div>

            <div class="studio-pane" data-pane="adjust">
              <div class="studio-adjust-target" data-ref="adjustTarget" hidden>
                <span>正在编辑调整图层「<b data-ref="adjustTargetName"></b>」</span>
                <button class="btn ghost sm" type="button" data-ref="adjustTargetBack">编辑主图</button>
              </div>
              <div class="studio-pane-title">直方图</div>
              <div class="studio-hist">
                <canvas class="studio-hist-canvas" width="300" height="72" data-ref="hist"></canvas>
                <div class="studio-hist-meta mono">
                  <span data-ref="histInfo">—</span>
                  <span data-ref="histClip"></span>
                </div>
              </div>
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
              <div class="studio-pane-title">调整图层</div>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="addAdjustLayer">＋ 新建调整图层</button>
              </div>
              <div class="studio-note">调整图层作用于它下面的所有内容，可随时回改、显隐、加蒙版；在图层面板选中后，上方滑杆即改为编辑该图层。</div>
              <div class="studio-local" data-ref="localBox" hidden>
                <div class="studio-pane-title">局部范围</div>
                <div class="studio-row">
                  <button class="btn ghost sm" type="button" data-ref="localLinear">线性渐变</button>
                  <button class="btn ghost sm" type="button" data-ref="localRadial">径向渐变</button>
                  <button class="btn ghost sm" type="button" data-ref="localBrush">画笔蒙版</button>
                  <button class="btn ghost sm" type="button" data-ref="localClear">全图</button>
                </div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>过渡</span><span class="mono" data-ref="localFeatherVal">50</span></span>
                  <input type="range" min="0" max="100" step="1" value="50" data-ref="localFeather" />
                </label>
                <div class="studio-note" data-ref="localHint"></div>
              </div>
              <div class="studio-pane-title">3D LUT</div>
              <div class="studio-row">
                <button class="btn ghost sm" type="button" data-ref="lutBtn">加载 .cube</button>
                <button class="btn ghost sm" type="button" data-ref="lutClear" disabled>移除</button>
                <input type="file" accept=".cube,text/plain" data-ref="lutInput" hidden />
              </div>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>强度</span><span class="mono" data-ref="lutStrengthVal">100</span></span>
                <input type="range" min="0" max="100" step="1" value="100" data-ref="lutStrength" disabled />
              </label>
              <div class="studio-note" data-ref="lutName">未加载 LUT（支持 3D .cube，1D 暂不支持）</div>
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

            <div class="studio-pane" data-pane="text" hidden>
              <div class="studio-note" data-ref="textEmpty">用「文字」工具（T）在画面上点一下创建文字图层；选中文字层后，这里可以改文案与样式。</div>
              <div data-ref="textFields" hidden>
                <div class="studio-pane-title">文案</div>
                <textarea class="studio-text-input" data-ref="textContent" rows="3" placeholder="输入文字，支持换行"></textarea>
                <div class="studio-row">
                  <select class="select" data-ref="textFont" aria-label="字体">
                    ${TEXT_FONTS.map((font) => `<option value='${font.id}'>${font.label}</option>`).join('')}
                  </select>
                  <label class="studio-check"><input type="checkbox" data-ref="textBold" /><span>粗体</span></label>
                </div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>字号</span><span class="mono" data-ref="textSizeVal">64</span></span>
                  <input type="range" min="8" max="240" step="1" value="64" data-ref="textSize" />
                </label>
                <div class="studio-row">
                  <label class="studio-check studio-text-color"><span>颜色</span><input type="color" data-ref="textColor" value="#ffffff" /></label>
                </div>
                <div class="studio-pane-title">描边</div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>宽度</span><span class="mono" data-ref="textStrokeVal">0</span></span>
                  <input type="range" min="0" max="24" step="1" value="0" data-ref="textStrokeWidth" />
                </label>
                <div class="studio-row">
                  <label class="studio-check studio-text-color"><span>描边色</span><input type="color" data-ref="textStrokeColor" value="#000000" /></label>
                </div>
                <div class="studio-pane-title">投影</div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>模糊</span><span class="mono" data-ref="textShadowVal">0</span></span>
                  <input type="range" min="0" max="40" step="1" value="0" data-ref="textShadow" />
                </label>
                <div class="studio-pane-title">路径文字</div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>弯曲</span><span class="mono" data-ref="textArcVal">0</span></span>
                  <input type="range" min="-100" max="100" step="1" value="0" data-ref="textArc" />
                </label>
                <button class="btn ghost sm studio-block" type="button" data-ref="textDelete">删除文字图层</button>
                <div class="studio-note">文字图层是非破坏式的：随时能改文案与样式；用「移动叠加图」工具可拖动位置。</div>
              </div>
            </div>

            <div class="studio-pane" data-pane="sticker" hidden>
              <div class="studio-note" data-ref="stickerEmpty">用「贴纸」工具（G）在画面上点一下导入图片；选中贴纸后，这里可以缩放、旋转、翻转与改混合模式。</div>
              <div data-ref="stickerFields" hidden>
                <div class="studio-pane-title">贴纸</div>
                <div class="studio-row">
                  <button class="btn ghost sm" type="button" data-ref="stickerImport">＋ 导入贴纸</button>
                  <button class="btn ghost sm" type="button" data-ref="stickerReset">重置变换</button>
                </div>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>缩放</span><span class="mono" data-ref="stickerScaleVal">100%</span></span>
                  <input type="range" min="5" max="400" step="1" value="100" data-ref="stickerScale" />
                </label>
                <label class="studio-slider">
                  <span class="studio-slider-head"><span>旋转</span><span class="mono" data-ref="stickerRotateVal">0°</span></span>
                  <input type="range" min="-180" max="180" step="1" value="0" data-ref="stickerRotate" />
                </label>
                <div class="studio-row">
                  <button class="btn ghost sm" type="button" data-ref="stickerFlipH">水平翻转</button>
                  <button class="btn ghost sm" type="button" data-ref="stickerFlipV">垂直翻转</button>
                </div>
                <div class="studio-pane-title">混合模式</div>
                <select class="select" data-ref="stickerBlend" aria-label="混合模式">
                  ${BLEND_MODES.map((mode) => `<option value="${mode.id}">${mode.label}</option>`).join('')}
                </select>
                <div class="studio-pane-title">透视变换</div>
                <label class="studio-check"><input type="checkbox" data-ref="stickerPerspective" /><span>编辑四角</span></label>
                <button class="btn ghost sm studio-block" type="button" data-ref="stickerPerspectiveReset" disabled>重置透视</button>
                <div class="studio-note" data-ref="stickerPerspectiveHint" hidden>拖动画面上的四个圆点改变透视；关闭「编辑四角」后仍保留透视结果。</div>
                <button class="btn ghost sm studio-block" type="button" data-ref="stickerDelete">删除贴纸</button>
                <div class="studio-note">画布上也能操作：拖动贴纸移动，拖四角缩放，拖顶部圆点旋转（按住 Alt 不吸附 15°）；不透明度在图层面板调。</div>
              </div>
              <input type="file" accept="image/*" data-ref="stickerInput" hidden />
            </div>

            <div class="studio-pane" data-pane="shape" hidden>
              <div class="studio-note">用「形状」工具（D）在画面上拖出矩形/椭圆/直线/箭头；未选中形状时，这里的设置会用于下一个新形状。</div>
              <div class="studio-pane-title">类型</div>
              <select class="select" data-ref="shapeKind" aria-label="形状类型">
                ${SHAPE_KINDS.map((kind) => `<option value="${kind.id}">${kind.label}</option>`).join('')}
              </select>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>填充</span><input type="color" data-ref="shapeFill" value="${SHAPE_DEFAULTS.fill}" /></label>
              </div>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>描边宽度</span><span class="mono" data-ref="shapeStrokeVal">0</span></span>
                <input type="range" min="0" max="40" step="1" value="0" data-ref="shapeStrokeWidth" />
              </label>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>描边色</span><input type="color" data-ref="shapeStroke" value="${SHAPE_DEFAULTS.stroke}" /></label>
              </div>
              <label class="studio-slider">
                <span class="studio-slider-head"><span>圆角</span><span class="mono" data-ref="shapeRadiusVal">0</span></span>
                <input type="range" min="0" max="200" step="1" value="0" data-ref="shapeRadius" />
              </label>
              <div class="studio-pane-title">图层样式</div>
              <label class="studio-check"><input type="checkbox" data-ref="styleShadow" /><span>外阴影</span></label>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>颜色</span><input type="color" data-ref="styleShadowColor" value="#000000" /></label>
                <label class="studio-maskbar-field"><span>模糊</span><input type="range" min="0" max="80" step="1" value="18" data-ref="styleShadowBlur" /><span class="mono" data-ref="styleShadowBlurVal">18</span></label>
              </div>
              <label class="studio-check"><input type="checkbox" data-ref="styleGlow" /><span>外发光</span></label>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>颜色</span><input type="color" data-ref="styleGlowColor" value="#f6c85f" /></label>
                <label class="studio-maskbar-field"><span>模糊</span><input type="range" min="0" max="80" step="1" value="18" data-ref="styleGlowBlur" /><span class="mono" data-ref="styleGlowBlurVal">18</span></label>
              </div>
              <label class="studio-check"><input type="checkbox" data-ref="styleGradient" /><span>渐变叠加</span></label>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>起</span><input type="color" data-ref="styleGradientFrom" value="#ff3b30" /></label>
                <label class="studio-check studio-text-color"><span>止</span><input type="color" data-ref="styleGradientTo" value="#7aa2ff" /></label>
              </div>
              <label class="studio-check"><input type="checkbox" data-ref="styleOverlay" /><span>颜色叠加</span></label>
              <div class="studio-row">
                <label class="studio-check studio-text-color"><span>颜色</span><input type="color" data-ref="styleOverlayColor" value="#000000" /></label>
                <label class="studio-maskbar-field"><span>不透明</span><input type="range" min="0" max="100" step="1" value="40" data-ref="styleOverlayOpacity" /><span class="mono" data-ref="styleOverlayOpacityVal">40</span></label>
              </div>
              <button class="btn ghost sm studio-block" type="button" data-ref="shapeDelete" disabled>删除形状</button>
              <div class="studio-note" data-ref="shapeHint">当前未选中形状：参数将用于新形状。</div>
            </div>

            <div class="studio-layer-props" data-ref="layerProps" hidden>
              <div class="studio-pane-title">图层属性 · <span class="mono" data-ref="layerPropsName"></span></div>
              <label class="studio-maskbar-field">
                <span>混合</span>
                <select class="select" data-ref="layerBlend" aria-label="图层混合模式">
                  ${BLEND_MODES.map((mode) => `<option value="${mode.id}">${mode.label}</option>`).join('')}
                </select>
              </label>
              <label class="studio-check"><input type="checkbox" data-ref="layerClipped" /><span>剪贴到下层</span></label>
              <div class="studio-note" data-ref="layerPropsHint" hidden></div>
            </div>

            <div class="studio-snapshots" data-ref="snapshotBox" hidden>
              <div class="studio-snapshots-head">
                <span class="studio-pane-title">历史快照</span>
                <button class="btn ghost sm" type="button" data-ref="snapshotAdd">＋ 新建</button>
              </div>
              <div class="studio-snapshot-list" data-ref="snapshotList"></div>
              <div class="studio-note">快照保存在本次会话内；点击名称回跳，双击重命名。</div>
            </div>

            <div class="studio-panel-foot">
              <span>空格拖动 · 滚轮缩放 · Ctrl+Z 撤销</span>
              <span class="studio-save" data-ref="saveState">自动保存 · 本机</span>
            </div>
          </aside>
        </div>

        <div class="studio-dock" data-ref="dock" hidden>
          <div class="studio-dock-track" data-ref="dockTrack" role="listbox" aria-label="主图版本链"></div>
          <div class="studio-dock-side">
            <button
              class="studio-dock-spine"
              type="button"
              data-ref="projHistoryBtn"
              aria-expanded="false"
              title="项目历史：本机的精修工程"
            >
              <span class="studio-dock-spine-count mono" data-ref="projHistoryCount">0</span>
              <span class="studio-dock-spine-label">项目历史</span>
            </button>
          </div>
          <div class="studio-projects" data-ref="projHistoryPanel" hidden>
            <div class="studio-projects-head">
              <span class="studio-projects-title">项目历史</span>
              <span class="studio-projects-meta mono" data-ref="projHistoryMeta"></span>
              <span class="spacer"></span>
              <button class="studio-projects-close" type="button" data-ref="projHistoryClose" aria-label="收起">×</button>
            </div>
            <div class="studio-projects-list" data-ref="projHistoryList"></div>
            <div class="studio-projects-empty" data-ref="projHistoryEmpty" hidden>还没有精修工程</div>
          </div>
        </div>
        <div class="studio-dock-menu" data-ref="versionMenu" role="menu" hidden></div>
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
    projWrap: ref('projWrap'),
    projBtn: ref('projBtn'),
    projMenu: ref('projMenu'),
    exportWrap: ref('exportWrap'),
    exportBtn: ref('exportBtn'),
    exportMenu: ref('exportMenu'),
    compareAllBtn: ref('compareAllBtn'),
    upscaleBtn: ref('upscaleBtn'),
    dock: ref('dock'),
    dockTrack: ref('dockTrack'),
    projHistoryBtn: ref('projHistoryBtn'),
    projHistoryCount: ref('projHistoryCount'),
    projHistoryPanel: ref('projHistoryPanel'),
    projHistoryMeta: ref('projHistoryMeta'),
    projHistoryClose: ref('projHistoryClose'),
    projHistoryList: ref('projHistoryList'),
    projHistoryEmpty: ref('projHistoryEmpty'),
    versionMenu: ref('versionMenu'),
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
    adjustTarget: ref('adjustTarget'),
    adjustTargetName: ref('adjustTargetName'),
    adjustTargetBack: ref('adjustTargetBack'),
    addAdjustLayer: ref('addAdjustLayer'),
    localBox: ref('localBox'),
    localLinear: ref('localLinear'),
    localRadial: ref('localRadial'),
    localBrush: ref('localBrush'),
    localClear: ref('localClear'),
    localFeather: ref('localFeather'),
    localFeatherVal: ref('localFeatherVal'),
    localHint: ref('localHint'),
    filterNote: ref('filterNote'),
    hist: ref('hist'),
    histInfo: ref('histInfo'),
    histClip: ref('histClip'),
    lutBtn: ref('lutBtn'),
    lutInput: ref('lutInput'),
    lutClear: ref('lutClear'),
    lutName: ref('lutName'),
    lutStrength: ref('lutStrength'),
    lutStrengthVal: ref('lutStrengthVal'),
    maskbar: ref('maskbar'),
    cloneAlignWrap: ref('cloneAlignWrap'),
    cloneAligned: ref('cloneAligned'),
    mosaicModeWrap: ref('mosaicModeWrap'),
    mosaicMode: ref('mosaicMode'),
    textEmpty: ref('textEmpty'),
    textFields: ref('textFields'),
    textContent: ref('textContent'),
    textFont: ref('textFont'),
    textBold: ref('textBold'),
    textSize: ref('textSize'),
    textSizeVal: ref('textSizeVal'),
    textColor: ref('textColor'),
    textStrokeWidth: ref('textStrokeWidth'),
    textStrokeVal: ref('textStrokeVal'),
    textStrokeColor: ref('textStrokeColor'),
    textShadow: ref('textShadow'),
    textShadowVal: ref('textShadowVal'),
    textArc: ref('textArc'),
    textArcVal: ref('textArcVal'),
    textDelete: ref('textDelete'),
    stickerEmpty: ref('stickerEmpty'),
    stickerFields: ref('stickerFields'),
    stickerImport: ref('stickerImport'),
    stickerReset: ref('stickerReset'),
    stickerScale: ref('stickerScale'),
    stickerScaleVal: ref('stickerScaleVal'),
    stickerRotate: ref('stickerRotate'),
    stickerRotateVal: ref('stickerRotateVal'),
    stickerFlipH: ref('stickerFlipH'),
    stickerFlipV: ref('stickerFlipV'),
    stickerBlend: ref('stickerBlend'),
    stickerPerspective: ref('stickerPerspective'),
    stickerPerspectiveReset: ref('stickerPerspectiveReset'),
    stickerPerspectiveHint: ref('stickerPerspectiveHint'),
    stickerDelete: ref('stickerDelete'),
    stickerInput: ref('stickerInput'),
    shapeKind: ref('shapeKind'),
    shapeFill: ref('shapeFill'),
    shapeStrokeWidth: ref('shapeStrokeWidth'),
    shapeStrokeVal: ref('shapeStrokeVal'),
    shapeStroke: ref('shapeStroke'),
    shapeRadius: ref('shapeRadius'),
    shapeRadiusVal: ref('shapeRadiusVal'),
    shapeDelete: ref('shapeDelete'),
    shapeHint: ref('shapeHint'),
    styleShadow: ref('styleShadow'),
    styleShadowColor: ref('styleShadowColor'),
    styleShadowBlur: ref('styleShadowBlur'),
    styleShadowBlurVal: ref('styleShadowBlurVal'),
    styleGlow: ref('styleGlow'),
    styleGlowColor: ref('styleGlowColor'),
    styleGlowBlur: ref('styleGlowBlur'),
    styleGlowBlurVal: ref('styleGlowBlurVal'),
    styleGradient: ref('styleGradient'),
    styleGradientFrom: ref('styleGradientFrom'),
    styleGradientTo: ref('styleGradientTo'),
    styleOverlay: ref('styleOverlay'),
    styleOverlayColor: ref('styleOverlayColor'),
    styleOverlayOpacity: ref('styleOverlayOpacity'),
    styleOverlayOpacityVal: ref('styleOverlayOpacityVal'),
    patternWrap: ref('patternWrap'),
    patternHint: ref('patternHint'),
    patternClear: ref('patternClear'),
    layerProps: ref('layerProps'),
    layerPropsName: ref('layerPropsName'),
    layerBlend: ref('layerBlend'),
    layerClipped: ref('layerClipped'),
    layerPropsHint: ref('layerPropsHint'),
    snapshotBox: ref('snapshotBox'),
    snapshotList: ref('snapshotList'),
    snapshotAdd: ref('snapshotAdd'),
    maskTool: ref('maskTool'),
    maskExport: ref('maskExport'),
    maskClear: ref('maskClear'),
    selbar: ref('selbar'),
    wandContig: ref('wandContig'),
    selRadius: ref('selRadius'),
    selInfo: ref('selInfo'),
    cutWrap: ref('cutWrap'),
    cutBtn: ref('cutBtn'),
    cutMenu: ref('cutMenu'),
    cutEdges: ref('cutEdges'),
    segbar: ref('segbar'),
    segModes: ref('segModes'),
    segMulti: ref('segMulti'),
    segFeather: ref('segFeather'),
    segText: ref('segText'),
    segRun: ref('segRun'),
    segClear: ref('segClear'),
    segStatus: ref('segStatus'),
    segCands: ref('segCands'),
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

  /**
   * 读取本地图片并作为叠加层/贴纸加入文档（D11.3）。
   * options.center 给出「图像坐标中的落点」，图层会以它为居中放置。
   */
  async function addOverlayFile(file, options = {}) {
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
    const { center, focusSticker = false, ...rest } = options;
    let placement = { ...rest };
    if (center) {
      const fit = Math.min(1, (doc.size.width * 0.6) / Math.max(1, image.naturalWidth || image.width));
      const width = (image.naturalWidth || image.width) * fit;
      const height = (image.naturalHeight || image.height) * fit;
      placement = { ...placement, scale: placement.scale ?? fit, x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) };
    }
    const layer = doc.addOverlay(image, { name: file.name || '叠加图', ...placement });
    layerBlobs.set(layer.id, file);
    selectedLayerId = layer.id;
    editingLayerMaskId = '';
    setTool('move');
    // setTool('move') 会把分页拉回 AI，贴纸导入/选中后再切回贴纸分页（D11.3）。
    if (focusSticker) {
      activeTab = 'sticker';
      syncTabs();
      syncStickerPane();
    }
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    ai?.refresh();
    return layer;
  }

  /* ============================================================
   * AI 面板（右栏「AI 修改」）
   * ============================================================ */

  /**
   * 提交用蒙版：文档蒙版 ∪ 选区（P1-2）。
   * AI 只认 mask，选区没手动转蒙版就等于没圈选；这里在提交时合并，
   * 但**不写回文档**——不替用户改画布，也不污染撤销栈。
   */
  function submissionMask() {
    const empty = { dataUrl: null, size: { width: 0, height: 0 }, coverage: 0, has: false };
    if (!doc) return empty;
    const mask = doc.mask;
    const stats = doc.maskStats();
    const sel = selection;
    const canMerge = Boolean(sel)
      && sel.width === mask.width
      && sel.height === mask.height
      && selectionHasPixels(sel.alpha);
    if (!canMerge) {
      return {
        dataUrl: stats.has ? doc.maskPng() : null,
        size: doc.maskSize,
        coverage: stats.has ? stats.coverage : 0,
        has: stats.has,
      };
    }
    const layer = makeCanvas(mask.width, mask.height);
    const lctx = layer.getContext('2d');
    lctx.drawImage(mask, 0, 0);
    lctx.drawImage(sel.canvas, 0, 0);
    const crop = doc.transform.crop;
    let out = layer;
    if (crop) {
      out = makeCanvas(crop.width, crop.height);
      out.getContext('2d').drawImage(layer, -(crop.x || 0), -(crop.y || 0));
    }
    const data = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
    let hit = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 8) hit += 1;
    }
    const total = out.width * out.height;
    return {
      dataUrl: out.toDataURL('image/png'),
      size: { width: out.width, height: out.height },
      coverage: total ? hit / total : 0,
      has: hit > 0,
    };
  }

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
    /** 轻量查询：只回答"有没有图片 / 蒙版"，不走烘焙（AI 面板回显降级预设用）。 */
    hasImage() {
      return Boolean(doc);
    },
    hasMask() {
      // 选区在提交时也会并入蒙版，所以面板判断"有没有圈选"要把选区算上。
      return Boolean(doc?.hasMask?.())
        || Boolean(selection && selectionHasPixels(selection.alpha));
    },
    getSource() {
      if (!doc) return null;
      const size = doc.size;
      flushAdjustPreview();
      const submission = submissionMask();
      return {
        main: { data: doc.bake('image/png'), name: doc.name, width: size.width, height: size.height },
        mask: submission.dataUrl,
        maskSize: submission.size,
        coverage: submission.coverage,
        hasMask: submission.has,
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
        void recordVersion('edit', sourceBlob, {
          label: meta.task === 'outpaint' ? nextVersionLabel('outpaint') : undefined,
          meta: { task: meta.task || '', width: meta.width || 0, height: meta.height || 0 },
        });
        return { width: next.size.width, height: next.size.height, name: next.name };
      } catch (err) {
        if (token === openSeq) toastError(err, '载入结果失败');
        return null;
      }
    },
    async addOverlay(file, options = {}) {
      return addOverlayFile(file, options);
    },
    getLayers() {
      return doc?.layers || [];
    },
    selectLayer(id) {
      selectedLayerId = id;
      editingLayerMaskId = '';
      const layer = doc?.findLayer(id);
      // 调整图层没有几何，选中它时保持当前工具，右侧滑杆改为编辑该层（D9.3）。
      if (!layer?.isAdjustment) setTool('move');
      // 选中文字层直接切到文字分页（D11.2）。
      if (layer?.isText) {
        activeTab = 'text';
        syncTabs();
      } else if (layer?.isShape) {
        activeTab = 'shape';
        syncTabs();
      } else if (layer && !layer.isAdjustment) {
        // 选中贴纸/叠加层切到贴纸分页（D11.3）。
        activeTab = 'sticker';
        syncTabs();
      }
      syncAdjustInputs();
      syncTextPane();
      syncStickerPane();
      syncShapePane();
      syncLayerProps();
      scheduleDraw();
    },
    removeLayer(id) {
      if (!doc) return;
      if (doc.removeOverlay(id)) {
        if (selectedLayerId === id) selectedLayerId = null;
        if (editingLayerMaskId === id) editingLayerMaskId = '';
        layerBlobs.delete(id);
        syncAdjustInputs();
        syncStickerPane();
        syncShapePane();
        syncLayerProps();
        updateHistoryUi();
        scheduleSave();
        scheduleDraw();
      }
    },
    /** 复制叠加层（副本偏移 16px，可撤销）。 */
    cloneLayer(id) {
      if (!doc) return null;
      const copy = doc.cloneOverlay(id);
      if (!copy) return null;
      const blob = layerBlobs.get(id);
      if (blob) layerBlobs.set(copy.id, blob);
      selectedLayerId = copy.id;
      syncAdjustInputs();
      syncStickerPane();
      syncShapePane();
      syncLayerProps();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return copy;
    },
    /** 图层排序：delta = +1 上移一层 / -1 下移一层。 */
    moveLayer(id, delta) {
      if (!doc) return false;
      const from = doc.layers.findIndex((layer) => layer.id === id);
      if (from < 0) return false;
      const moved = doc.moveOverlay(id, from + (Number(delta) || 0));
      if (moved < 0) return false;
      selectedLayerId = id;
      syncLayerProps();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    /** 拖拽排序：直接落到目标下标。 */
    moveLayerTo(id, toIndex) {
      if (!doc) return false;
      const moved = doc.moveOverlay(id, toIndex);
      if (moved < 0) return false;
      selectedLayerId = id;
      syncLayerProps();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    /** 重命名图层（空名或同名视为 no-op，不产生撤销步）。 */
    renameLayer(id, name) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      const next = String(name || '').trim();
      if (!layer || !next || next === layer.name) return false;
      layer.name = next;
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
      return true;
    },
    /** 锁定/解锁：锁定后画布上不可点选、不可拖动，但继续参与合成。 */
    toggleLayerLock(id) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      if (!layer) return false;
      layer.locked = !layer.locked;
      if (layer.locked && selectedLayerId === id) selectedLayerId = null;
      doc.commitLayers();
      syncAdjustInputs();
      syncLayerProps();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    /** 显示/隐藏图层（D9.3）：隐藏的图层不参与合成与点选，可撤销。 */
    toggleLayerVisible(id) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      if (!layer) return false;
      layer.visible = layer.visible === false;
      if (!layer.visible && selectedLayerId === id) selectedLayerId = null;
      doc.touchLayers();
      doc.commitLayers();
      syncAdjustInputs();
      syncLayerProps();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    setLayerOpacity(id, value) {
      if (!doc) return;
      doc.setOverlayOpacity(id, value);
      scheduleDraw();
    },
    /** 当前正在涂抹蒙版的图层 id（图层面板高亮用）。 */
    getMaskLayer() {
      return editingLayerMaskId;
    },
    /** 添加/显隐图层蒙版（D8.2）：无蒙版则创建，有蒙版则切换显示。 */
    toggleLayerMask(id) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      if (!layer) return false;
      // 文字 / 形状图层没有像素蒙版（D11.2 / D11.4）。
      if (layer.isText || layer.isShape) {
        toastWarn(layer.isText ? '文字图层不支持蒙版' : '形状图层不支持蒙版');
        return false;
      }
      if (!layer.mask) {
        layer.ensureMask();
        toast(`已为「${layer.name}」添加蒙版：用画笔涂抹隐藏，橡皮擦恢复`);
      } else {
        layer.toggleMaskVisible();
        if (!layer.maskVisible && editingLayerMaskId === id) editingLayerMaskId = '';
      }
      doc.touchLayers();
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    /** 进入/退出图层蒙版涂抹模式。 */
    editLayerMask(id) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      if (!layer) return false;
      layer.ensureMask();
      if (editingLayerMaskId === id) {
        editingLayerMaskId = '';
        setTool('move');
      } else {
        editingLayerMaskId = id;
        selectedLayerId = id;
        setTool('brush');
        if (!layer.maskVisible) layer.maskVisible = true;
        toast(`正在涂抹「${layer.name}」的图层蒙版：画笔隐藏，橡皮擦恢复`);
      }
      doc.touchLayers();
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
    },
    /** 删除图层蒙版（恢复完整显示）。 */
    removeLayerMask(id) {
      if (!doc) return false;
      const layer = doc.findLayer(id);
      if (!layer?.mask) return false;
      layer.removeMask();
      if (editingLayerMaskId === id) editingLayerMaskId = '';
      doc.touchLayers();
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
      scheduleDraw();
      return true;
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
      const layer = doc.findLayer(id);
      // 调整图层与文字/形状图层没有位图尺寸，忽略缩放。
      if (!layer || layer.isAdjustment || layer.isText || layer.isShape) return;
      if (layer.quad) {
        toastWarn('透视贴纸请拖动四角调整，或先重置透视');
        return;
      }
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
      activeTab = 'ai';
      syncTabs();
      // 先组好 outpaint 的 payload（submit 内部同步完成），再把预设切回进入扩图前的那个。
      ai.submitOutpaint();
      outpaint.restorePreset?.();
      setTool('view');
    },
  });
  outpaint.init();

  /* ============================================================
   * 工具与画布
   * ============================================================ */

  /**
   * 左栏工具轨：按 Photoshop 的方式收成「工具组」。
   * 单工具组直接点；多工具组点开右侧浮层选具体工具，避免 21 个按钮一列塞不下。
   */
  refs.rail.innerHTML = TOOL_GROUPS.map((group) => {
    const tools = group.tools.map((id) => TOOLS.find((entry) => entry.id === id)).filter(Boolean);
    if (!tools.length) return '';
    const primary = tools[0];
    const multi = tools.length > 1;
    return `
      <div class="studio-tool-group" data-group="${group.id}">
        <button class="studio-tool is-group" type="button" data-group-toggle="${group.id}"
          title="${escapeHtml(group.title)}${multi ? ' · 点击展开组内工具' : ''}"
          aria-haspopup="${multi ? 'menu' : 'false'}" aria-expanded="false">
          <span data-group-glyph>${primary.icon}</span>
          ${multi ? '<span class="studio-tool-more" aria-hidden="true"></span>' : ''}
          <span class="studio-tool-key" data-group-key>${primary.key}</span>
        </button>
        ${
          multi
            ? `<div class="studio-tool-flyout" data-flyout="${group.id}" role="menu" hidden>
          ${tools
            .map(
              (item) => `<button class="studio-tool-item" type="button" role="menuitem" data-tool="${item.id}" title="${escapeHtml(item.label)}（${item.key}）">
            <span class="studio-tool-item-icon">${item.icon}</span>
            <span class="studio-tool-item-label">${item.label}</span>
            <span class="studio-tool-item-key">${item.key}</span>
          </button>`,
            )
            .join('')}
        </div>`
            : ''
        }
      </div>`;
  }).join('');

  /** 组按钮/浮层的选中态与图标：组按钮显示该组上次用过的工具。 */
  function syncRail() {
    for (const group of TOOL_GROUPS) {
      const button = refs.rail.querySelector(`[data-group-toggle="${group.id}"]`);
      if (!button) continue;
      const current = groupTool.get(group.id) || group.tools[0];
      const meta = TOOLS.find((item) => item.id === current);
      button.classList.toggle('active', group.tools.includes(tool));
      const glyph = button.querySelector('[data-group-glyph]');
      if (glyph && meta) glyph.innerHTML = meta.icon;
      const key = button.querySelector('[data-group-key]');
      if (key && meta) key.textContent = meta.key;
      const flyout = refs.rail.querySelector(`[data-flyout="${group.id}"]`);
      if (!flyout) continue;
      for (const item of flyout.querySelectorAll('[data-tool]')) {
        item.classList.toggle('active', item.dataset.tool === tool);
      }
    }
  }

  function closeRailFlyout() {
    if (!openGroupId) return;
    const flyout = refs.rail.querySelector(`[data-flyout="${openGroupId}"]`);
    const button = refs.rail.querySelector(`[data-group-toggle="${openGroupId}"]`);
    if (flyout) {
      flyout.hidden = true;
      flyout.removeAttribute('style');
    }
    button?.setAttribute('aria-expanded', 'false');
    openGroupId = '';
  }

  function openRailFlyout(id) {
    const flyout = refs.rail.querySelector(`[data-flyout="${id}"]`);
    const button = refs.rail.querySelector(`[data-group-toggle="${id}"]`);
    if (!flyout || !button) return;
    if (openGroupId === id) {
      closeRailFlyout();
      return;
    }
    closeRailFlyout();
    const rect = button.getBoundingClientRect();
    flyout.hidden = false;
    const height = flyout.offsetHeight;
    flyout.style.left = `${Math.round(rect.right + 6)}px`;
    flyout.style.top = `${Math.max(12, Math.round(Math.min(rect.top, window.innerHeight - height - 12)))}px`;
    button.setAttribute('aria-expanded', 'true');
    openGroupId = id;
  }

  function setTool(next) {
    if (!TOOLS.some((item) => item.id === next)) return;
    if (next !== 'outpaint') {
      outpaint?.deactivate?.();
      outpaint?.restorePreset?.();
      // 从扩图切走时 activeTab 归一为 ai，必须立刻重排分页，
      // 否则扩图上下文面板不会隐藏、AI 面板一直是 hidden。
      if (activeTab === 'outpaint') {
        activeTab = 'ai';
        syncTabs();
      }
    }
    refs.maskbar.hidden = !(MASK_TOOLS.has(next) || HEAL_TOOLS.has(next));
    refs.maskbar.classList.toggle('is-heal', HEAL_TOOLS.has(next));
    if (refs.segbar) {
      refs.segbar.hidden = next !== 'segment';
      if (next === 'segment') syncSegUi();
    }
    if (next !== 'segment') {
      segPoints = [];
      segCandidates = [];
      segAppliedId = '';
    }
    if (refs.cloneAlignWrap) refs.cloneAlignWrap.hidden = !CLONE_TOOLS.has(next);
    if (refs.mosaicModeWrap) refs.mosaicModeWrap.hidden = next !== 'mosaic';
    if (refs.patternWrap) refs.patternWrap.hidden = next !== 'pattern';
    if (next === 'pattern') updatePatternHint();
    if (MASK_TOOLS.has(next)) refs.maskTool.value = next;
    tool = next;
    if (editingLayerMaskId && !MASK_TOOLS.has(next)) {
      editingLayerMaskId = '';
      ai?.refresh();
    }
    if (!MASK_TOOLS.has(next)) {
      cropRect = null;
      refs.cropbar.hidden = true;
    }
    if (next === 'wand' && doc) {
      activeTab = 'adjust';
      syncTabs();
    }
    if (next === 'crop' && doc) {
      activeTab = 'transform';
      syncTabs();
    } else if (next === 'move') {
      activeTab = 'ai';
      syncTabs();
    } else if (next === 'sticker' && doc) {
      activeTab = 'sticker';
      syncTabs();
      syncStickerPane();
    } else if (next === 'shape' && doc) {
      activeTab = 'shape';
      syncTabs();
      syncShapePane();
    } else if (next === 'outpaint') {
      activeTab = 'outpaint';
      syncTabs();
      outpaint?.activate?.();
    }
    const group = TOOL_GROUPS.find((item) => item.tools.includes(tool));
    if (group) groupTool.set(group.id, tool);
    syncRail();
    // 快捷键切到视口外的工具组时，把组按钮带进视野。
    if (group) {
      refs.rail.querySelector(`[data-group-toggle="${group.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
    }
    const meta = TOOLS.find((item) => item.id === tool);
    refs.statusTool.textContent = meta ? `${meta.label} · ${meta.hint}` : '';
    refs.canvas.dataset.tool = tool;
    updateSelectionUi();
    scheduleDraw();
    scheduleSave(1200);
  }

  const TAB_IDS = new Set(['ai', 'adjust', 'transform', 'text', 'sticker', 'shape']);

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

  /**
   * 选中贴纸的变换手柄：四角 + 顶部旋转圆点。
   * 同时给出「图像坐标」与「视口坐标」，绘制与命中判断共用一套几何（D11.3）。
   */
  function stickerHandles(layer) {
    const crop = doc?.transform.crop;
    const width = layer.width;
    const height = layer.height;
    const cx = layer.x + width / 2;
    const cy = layer.y + height / 2;
    const rad = ((layer.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const toDoc = (px, py) => ({ x: cx + px * cos - py * sin, y: cy + px * sin + py * cos });
    const toView = (point) => ({
      x: view.x + (point.x - (crop?.x || 0)) * view.scale,
      y: view.y + (point.y - (crop?.y || 0)) * view.scale,
    });
    const cornersDoc = [
      toDoc(-width / 2, -height / 2),
      toDoc(width / 2, -height / 2),
      toDoc(width / 2, height / 2),
      toDoc(-width / 2, height / 2),
    ];
    // 旋转圆点离顶边固定屏幕距离（26px），缩放画布时手感一致。
    const knobDoc = toDoc(0, -height / 2 - 26 / Math.max(0.01, view.scale));
    return {
      centerDoc: { x: cx, y: cy },
      cornersDoc,
      knobDoc,
      cornersView: cornersDoc.map(toView),
      knobView: toView(knobDoc),
    };
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
    // 图层蒙版涂抹同理：只重绘图层，底图继续走 underlay 缓存。
    const liveLayers =
      !adjustPreview &&
      doc.layers.length > 0 &&
      // 调整层会改写已合成内容，不能走「底图缓存 + 实时图层」捷径（D9.3）。
      !doc.hasAdjustmentLayers &&
      (drag?.mode === 'moveLayer' ||
        drag?.mode === 'stickerScale' ||
        drag?.mode === 'stickerRotate' ||
        drag?.mode === 'perspCorner' ||
        (editingLayerMaskId && drag?.mode === 'paint'));
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
      // 统一走 renderer，剪贴蒙版与混合模式在拖动预览里同样生效（D12.1）。
      drawLayers(ctx, doc.layers, { crop });
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

    // 选区蚂蚁线（D8.1）：黑白虚线交替，antsOffset 每 120ms 前进，形成流动感。
    if (selection) {
      const path = selectionOutline();
      if (path) {
        const crop = doc.transform.crop;
        ctx.save();
        ctx.translate(view.x - (crop?.x || 0) * view.scale, view.y - (crop?.y || 0) * view.scale);
        ctx.scale(view.scale, view.scale);
        ctx.lineWidth = 1.4 / view.scale;
        ctx.strokeStyle = 'rgba(0,0,0,0.88)';
        ctx.stroke(path);
        ctx.strokeStyle = 'rgba(255,255,255,0.98)';
        ctx.setLineDash([4 / view.scale, 4 / view.scale]);
        ctx.lineDashOffset = -antsOffset / view.scale;
        ctx.stroke(path);
        ctx.restore();
      }
    }

    // AI 主体选择（D13.1）：框选虚线框与点提示标记
    if (tool === 'segment') {
      const crop = doc.transform.crop;
      ctx.save();
      ctx.translate(view.x - (crop?.x || 0) * view.scale, view.y - (crop?.y || 0) * view.scale);
      ctx.scale(view.scale, view.scale);
      if (drag?.mode === 'segBox' && drag.rect) {
        ctx.setLineDash([6 / view.scale, 4 / view.scale]);
        ctx.lineWidth = 1.2 / view.scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeRect(drag.rect.x, drag.rect.y, drag.rect.width, drag.rect.height);
        ctx.setLineDash([]);
      }
      if (segMode === 'points') {
        for (const point of segPoints) {
          const radius = 5 / view.scale;
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = point.label === 0 ? 'rgba(255,80,60,0.95)' : 'rgba(46,204,113,0.95)';
          ctx.fill();
          ctx.lineWidth = 1.5 / view.scale;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.stroke();
        }
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

    // 形状图层预览（D11.4）：在视口里按当前样式直接画一遍，松手后才真正建层。
    if (drag?.mode === 'shapeDraw' && drag.end) {
      const crop = doc.transform.crop;
      const rect = normalizeRect(drag.start, drag.end);
      const signed = drag.shape === 'line' || drag.shape === 'arrow';
      const preview = new ShapeLayer({
        ...shapeStyle,
        x: (signed ? drag.start.x : rect.x) + (crop?.x || 0),
        y: (signed ? drag.start.y : rect.y) + (crop?.y || 0),
        width: signed ? drag.end.x - drag.start.x : rect.width,
        height: signed ? drag.end.y - drag.start.y : rect.height,
      });
      preview.opacity = 0.9;
      ctx.save();
      ctx.translate(view.x - (crop?.x || 0) * view.scale, view.y - (crop?.y || 0) * view.scale);
      ctx.scale(view.scale, view.scale);
      preview.draw(ctx);
      ctx.restore();
    }

    // 图案取样框（D11.4）：拖框中为虚线预览，已取样时持续显示取样范围。
    {
      const rect = drag?.mode === 'patternPick' && drag.rect ? drag.rect : tool === 'pattern' ? patternRect : null;
      if (rect && rect.width > 1 && rect.height > 1) {
        const crop = doc.transform.crop;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(
          view.x + (rect.x - (crop?.x || 0)) * view.scale,
          view.y + (rect.y - (crop?.y || 0)) * view.scale,
          rect.width * view.scale,
          rect.height * view.scale,
        );
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // 局部调整取景辅助线（D9.4）：拖动中实时显示，未拖动时回显已有几何
    {
      const crop = doc.transform.crop;
      const toView = (p) => ({
        x: view.x + (p.x - (crop?.x || 0)) * view.scale,
        y: view.y + (p.y - (crop?.y || 0)) * view.scale,
      });
      const target = localEdit ? adjustmentTarget() : null;
      const geometry =
        drag?.mode === 'local'
          ? { type: drag.type, start: drag.start, end: drag.end }
          : target?.local?.type === localEdit && localEdit
            ? target.local
            : null;
      if (geometry) {
        const a = toView(geometry.start);
        const b = toView(geometry.end);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        if (geometry.type === 'linear') {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        } else {
          ctx.ellipse(a.x, a.y, Math.max(1, Math.abs(b.x - a.x)), Math.max(1, Math.abs(b.y - a.y)), 0, 0, Math.PI * 2);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        for (const point of geometry.type === 'linear' ? [a, b] : [a]) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
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

    // 选中图层的外框；贴纸额外画缩放角点与旋转手柄（D11.3）
    const activeLayer = selectedLayerId ? doc.findLayer?.(selectedLayerId) : null;
    if ((tool === 'move' || tool === 'sticker' || tool === 'shape') && activeLayer && !activeLayer.isAdjustment) {
      const crop = doc.transform.crop;
      const toViewPoint = (point) => ({
        x: view.x + (point.x - (crop?.x || 0)) * view.scale,
        y: view.y + (point.y - (crop?.y || 0)) * view.scale,
      });
      if (perspectiveEdit && activeLayer.quad && !activeLayer.isText && !activeLayer.isShape) {
        // 透视四角编辑（D13.3）：画四边形 + 四个可拖圆点。
        const points = activeLayer.quad.map(toViewPoint);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        points.forEach((point, index) => {
          if (index) ctx.lineTo(point.x, point.y);
          else ctx.moveTo(point.x, point.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        for (const point of points) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 5.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else if (activeLayer.isText || activeLayer.isShape) {
        // 文字 / 形状层没有缩放旋转手柄，沿用普通虚线框。
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
        ctx.restore();
      } else {
        const handles = stickerHandles(activeLayer);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        handles.cornersView.forEach((handle, index) => {
          if (index) ctx.lineTo(handle.x, handle.y);
          else ctx.moveTo(handle.x, handle.y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        // 顶部中点 → 旋转圆点的连线
        const top = {
          x: (handles.cornersView[0].x + handles.cornersView[1].x) / 2,
          y: (handles.cornersView[0].y + handles.cornersView[1].y) / 2,
        };
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(handles.knobView.x, handles.knobView.y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        for (const handle of handles.cornersView) ctx.fillRect(handle.x - 3.5, handle.y - 3.5, 7, 7);
        ctx.beginPath();
        ctx.arc(handles.knobView.x, handles.knobView.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 仿制取样锚点 + 当前取样位置（D10.2）
    if (cloneAnchor && CLONE_TOOLS.has(tool)) {
      const crop = doc.transform.crop;
      const toView = (p) => ({
        x: view.x + (p.x - (crop?.x || 0)) * view.scale,
        y: view.y + (p.y - (crop?.y || 0)) * view.scale,
      });
      const anchor = toView(cloneAnchor);
      const source = drag?.mode === 'clone' && drag.last ? toView({
        x: drag.last.x - drag.offset.x,
        y: drag.last.y - drag.offset.y,
      }) : null;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 3]);
      for (const point of [anchor, source].filter(Boolean)) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(3, (brush.size / 2) * view.scale), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(point.x - 5, point.y);
        ctx.lineTo(point.x + 5, point.y);
        ctx.moveTo(point.x, point.y - 5);
        ctx.lineTo(point.x, point.y + 5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 画笔光标
    if (cursor && BRUSH_PARAM_TOOLS.has(tool)) {
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

    if (activeTab === 'adjust') updateHistogram();

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

  /* ============================================================
   * 选区（D8.1）
   * ============================================================ */

  function maskSize() {
    return doc ? { width: doc.mask.width, height: doc.mask.height } : { width: 0, height: 0 };
  }

  function selectionHasPixels(alpha) {
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] > 0) return true;
    }
    return false;
  }

  function updateSelectionUi() {
    const has = Boolean(selection);
    const coverage = has ? coverageAlpha(selection.alpha) : 0;
    refs.selbar.hidden = !(has || WAND_TOOLS.has(tool));
    refs.selInfo.textContent = has ? `选区 ${fmtCoverage(coverage)}` : '未选区';
    // 选区不必先转蒙版：提交时会自动并入（P1-2）。
    refs.selInfo.title = has ? '提交时会自动并入蒙版，无需先转蒙版' : '';
  }

  function ensureAnts() {
    if (antsTimer || !selection) return;
    antsTimer = window.setInterval(() => {
      if (!selection) return;
      antsOffset = (antsOffset + 2) % 8;
      scheduleDraw();
    }, 120);
  }

  function stopAnts() {
    if (!antsTimer) return;
    window.clearInterval(antsTimer);
    antsTimer = 0;
  }

  function setSelectionAlpha(alpha, width, height) {
    if (!alpha || !width || !height) {
      clearSelection();
      return;
    }
    selection = { width, height, alpha, canvas: alphaToCanvas(alpha, width, height) };
    selPath = null;
    antsOffset = 0;
    updateSelectionUi();
    ensureAnts();
    scheduleDraw();
  }

  function clearSelection(silent = false) {
    stopAnts();
    if (!selection && silent) return;
    selection = null;
    selPath = null;
    updateSelectionUi();
    if (!silent) scheduleDraw();
  }

  /** 蚂蚁线路径按需构建并缓存；大图自动降采样。 */
  function selectionOutline() {
    if (!selection) return null;
    if (!selPath || selPath.width !== selection.width || selPath.height !== selection.height) {
      const step = Math.max(1, Math.ceil(Math.max(selection.width, selection.height) / 1536));
      selPath = {
        width: selection.width,
        height: selection.height,
        path: buildOutlinePath(selection.alpha, selection.width, selection.height, step),
      };
    }
    return selPath.path;
  }

  /** 当前可见范围（裁剪后反选只作用于裁剪框内）。 */
  function visibleBounds() {
    if (!doc) return null;
    const crop = doc.transform.crop;
    return crop ? { ...crop } : { x: 0, y: 0, width: doc.mask.width, height: doc.mask.height };
  }

  /** 魔棒：从合成图取色洪泛，再换算回「旋转后、未裁剪」的蒙版坐标。 */
  function wandSelectAt(point, mode) {
    if (!doc) return;
    const base = doc.renderBase();
    const width = base.width;
    const height = base.height;
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const data = base.getContext('2d').getImageData(0, 0, width, height).data;
    const display = wandAlpha(data, width, height, x, y, {
      tolerance: wand.tolerance,
      contiguous: wand.contiguous,
    });
    const mask = maskSize();
    const crop = doc.transform.crop;
    let next = display;
    if (crop || mask.width !== width || mask.height !== height) {
      next = createAlpha(mask.width, mask.height);
      const offX = crop?.x || 0;
      const offY = crop?.y || 0;
      const limit = Math.max(0, Math.min(width, mask.width - offX));
      for (let row = 0; row < height; row += 1) {
        const targetY = row + offY;
        if (targetY < 0 || targetY >= mask.height) continue;
        const src = row * width;
        const dst = targetY * mask.width + offX;
        for (let col = 0; col < limit; col += 1) {
          if (display[src + col] >= 128) next[dst + col] = 255;
        }
      }
    }
    const merged = combineAlpha(selection?.alpha || null, next, mode);
    if (!selectionHasPixels(merged)) {
      clearSelection();
      toastWarn('该位置没有可选的区域，可调高容差再试');
      return;
    }
    setSelectionAlpha(merged, mask.width, mask.height);
  }

  /** 反选 / 羽化 / 扩展 / 收缩 / 清除。 */
  function runSelectionOp(op) {
    if (!doc) return;
    if (op === 'clear') {
      clearSelection();
      return;
    }
    if (!selection) {
      toastWarn('还没有选区：先用魔棒点选一块区域');
      return;
    }
    const mask = maskSize();
    if (selection.width !== mask.width || selection.height !== mask.height) {
      clearSelection();
      return;
    }
    let next = null;
    if (op === 'invert') next = invertAlpha(selection.alpha, mask.width, mask.height, visibleBounds());
    if (op === 'feather') next = featherAlpha(selection.alpha, mask.width, mask.height, selRadius);
    if (op === 'expand') next = expandAlpha(selection.alpha, mask.width, mask.height, selRadius);
    if (op === 'contract') next = contractAlpha(selection.alpha, mask.width, mask.height, selRadius);
    if (!next) return;
    if (!selectionHasPixels(next)) {
      clearSelection();
      return;
    }
    setSelectionAlpha(next, mask.width, mask.height);
  }

  /**
   * 把选区 alpha 并进文档蒙版（D13.2 一键消除的前置）：
   * AI 提交只认蒙版，选区必须落成蒙版才能让「元素移除」只改选区。
   */
  function commitSelectionToMask(armRemove) {
    if (!doc || !selection) {
      toastWarn('还没有选区：先用魔棒点选要处理的区域');
      return;
    }
    const mask = maskSize();
    if (selection.width !== mask.width || selection.height !== mask.height) {
      toastWarn('选区尺寸与当前图像不一致，请重新选择');
      clearSelection();
      return;
    }
    const data = new ImageData(selection.width, selection.height);
    const pixels = data.data;
    for (let i = 0; i < selection.alpha.length; i += 1) {
      const at = i * 4;
      pixels[at] = 255;
      pixels[at + 1] = 255;
      pixels[at + 2] = 255;
      pixels[at + 3] = selection.alpha[i];
    }
    const layer = makeCanvas(selection.width, selection.height);
    layer.getContext('2d').putImageData(data, 0, 0);
    doc.mask.getContext('2d').drawImage(layer, 0, 0);
    doc.markMaskChanged(true);
    tintDirty = true;
    doc.snapshot();
    updateHistoryUi();
    updateMaskStatus();
    scheduleDraw();
    scheduleSave();
    clearSelection();
    if (!armRemove) {
      toastSuccess('选区已转为蒙版');
      return;
    }
    activeTab = 'ai';
    syncTabs();
    ai?.prepareTask?.({
      preset: 'remove',
      task: 'remove',
      prompt: '移除选区内的内容，并按周围环境自然补全背景。',
    });
    toast('已填入「元素移除」指令，点「修改」开始消除');
  }

  /* ============================================================
   * AI 主体选择（D13.1）：/api/image/segment
   * ============================================================ */

  function syncSegUi(keepStatus = false) {
    if (refs.segModes) {
      refs.segModes.innerHTML = SEGMENT_MODES.map(
        (item) =>
          `<button class="btn ${item.id === segMode ? 'primary' : 'ghost'} sm" type="button" data-seg-mode="${item.id}">${item.label}</button>`,
      ).join('');
    }
    if (refs.segText) refs.segText.hidden = segMode !== 'text';
    if (refs.segRun) refs.segRun.hidden = segMode !== 'text';
    if (refs.segCands) {
      const multi = segCandidates.length > 1;
      refs.segCands.hidden = !multi;
      refs.segCands.innerHTML = multi
        ? segCandidates
            .map(
              (item, index) =>
                `<button class="btn ${item.url === segAppliedId ? 'primary' : 'ghost'} sm" type="button" data-seg-cand="${index}">候选 ${index + 1}</button>`,
            )
            .join('')
        : '';
    }
    if (refs.segStatus && !segBusy && !keepStatus) {
      const meta = SEGMENT_MODES.find((item) => item.id === segMode) || SEGMENT_MODES[0];
      refs.segStatus.textContent =
        segMode === 'points' && segPoints.length ? `${meta.hint}（已 ${segPoints.length} 点）` : meta.hint;
    }
  }

  /** 把分割蒙版贴进选区（灰度 PNG，白 = 选中；尺寸与原图一致，这里统一缩到蒙版空间）。 */
  async function applySegmentMask(mask) {
    if (!doc || !mask?.url) return;
    const size = maskSize();
    if (!size.width || !size.height) return;
    const image = await loadImage(api.fileUrl(mask.url));
    const canvas = makeCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size.width, size.height);
    const data = ctx.getImageData(0, 0, size.width, size.height).data;
    const alpha = maskGrayToAlpha(data, size.width, size.height);
    let hasPixels = false;
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] > 0) {
        hasPixels = true;
        break;
      }
    }
    if (!hasPixels) {
      toastWarn('这个提示没有选到区域，换个位置或改用框选');
      return;
    }
    setSelectionAlpha(alpha, size.width, size.height);
    segAppliedId = mask.url;
    toastSuccess(`已生成选区 ${(coverageAlpha(alpha) * 100).toFixed(1)}%`);
  }

  /**
   * 发起一次主体分割：发送「旋转后未裁剪」的合成图（长边超 2048 先缩小），
   * 异步任务轮询进度；框/点提示换算到发送图坐标后再提交。
   */
  async function runSegment(hint = {}) {
    if (!doc || segBusy) return;
    const base = doc.renderBase();
    const send = segmentSendSize(base.width, base.height, 2048);
    let image = base;
    if (send.scale !== 1) {
      image = makeCanvas(send.width, send.height);
      const ictx = image.getContext('2d');
      ictx.imageSmoothingEnabled = true;
      ictx.imageSmoothingQuality = 'high';
      ictx.drawImage(base, 0, 0, send.width, send.height);
    }
    const crop = doc.transform.crop;
    const payload = {
      image: image.toDataURL('image/png'),
      mode: segMode,
      multi: Boolean(refs.segMulti?.checked),
      feather: Math.max(0, Math.min(32, Math.round(Number(refs.segFeather?.value) || 0))),
      async: true,
    };
    if (segMode === 'text') {
      const text = String(hint.text ?? refs.segText?.value ?? '').trim();
      if (!text) {
        toastWarn('先写一句主体描述，例如「穿黑衣服的人」');
        refs.segText?.focus();
        return;
      }
      payload.text = text;
    }
    if (segMode === 'box' && hint.box) payload.box = toSendBox(hint.box, send.scale, crop);
    if (segMode === 'points') payload.points = toSendPoints(segPoints, send.scale, crop);

    segBusy = true;
    segCandidates = [];
    segAppliedId = '';
    syncSegUi();
    refs.segStatus.textContent = '正在分割（首次加载模型较慢）…';
    scheduleDraw();
    let failed = '';
    try {
      const started = await api.segment(payload);
      const jobId = started?.job_id;
      if (!jobId) throw new Error('后端没有返回分割任务');
      segJob = pollJob(jobId, (job) => {
        if (!refs.segStatus) return;
        if (job?.status === 'running') {
          const pct = Math.round(((Number(job.progress) || 0) / 1000) * 100);
          refs.segStatus.textContent = `正在分割… ${pct}%`;
        }
      });
      const job = await segJob;
      segJob = null;
      if (!job) return;
      if (job.status !== 'done') throw new Error(job.error || '分割失败');
      const masks = sortSegmentMasks(job.meta?.masks || job.masks || []);
      if (!masks.length) throw new Error('没有返回蒙版');
      segCandidates = masks;
      await applySegmentMask(masks[0]);
    } catch (err) {
      failed = err?.message || '分割失败';
      toastError(err, '主体选择失败');
    } finally {
      segBusy = false;
      // 失败时保留错误文案，别被模式提示覆盖。
      syncSegUi(Boolean(failed));
      if (failed && refs.segStatus) refs.segStatus.textContent = failed;
      scheduleDraw();
    }
  }

  function resetSegmentHints() {
    segJob?.stop?.();
    segJob = null;
    segBusy = false;
    segPoints = [];
    segCandidates = [];
    segAppliedId = '';
    syncSegUi();
  }

  /* ============================================================
   * 蒙版笔刷（D8.1 选区裁剪 / D8.2 图层蒙版）
   * ============================================================ */

  let dabScratch = null;
  let shapeScratch = null;

  function scratch(size) {
    if (!dabScratch) dabScratch = document.createElement('canvas');
    if (dabScratch.width !== size || dabScratch.height !== size) {
      dabScratch.width = size;
      dabScratch.height = size;
    }
    return dabScratch;
  }

  function fullScratch(width, height) {
    if (!shapeScratch) shapeScratch = document.createElement('canvas');
    if (shapeScratch.width !== width || shapeScratch.height !== height) {
      shapeScratch.width = width;
      shapeScratch.height = height;
    }
    return shapeScratch;
  }

  function paintDab(target, x, y, radius, erase) {
    const soft = 1 - brush.hardness;
    target.save();
    target.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    target.globalAlpha = brush.opacity;
    if (soft > 0.02) {
      const gradient = target.createRadialGradient(
        x,
        y,
        Math.max(0, radius * brush.hardness),
        x,
        y,
        radius,
      );
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      target.fillStyle = gradient;
    } else {
      target.fillStyle = '#ffffff';
    }
    target.beginPath();
    target.arc(x, y, radius, 0, Math.PI * 2);
    target.fill();
    target.restore();
  }

  function afterStamp(radius, point, erase) {
    if (!doc) return;
    doc.markMaskChanged(!erase);
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

  /** 文档坐标 → 叠加层自身像素坐标的仿射变换（图层蒙版涂抹用）。 */
  function docToLayerTransform(target, layer, offsetX, offsetY) {
    // 调整层蒙版与文档同坐标（旋转后、未裁剪），只需平移（D9.3）。
    if (layer.isAdjustment) {
      target.setTransform(1, 0, 0, 1, offsetX, offsetY);
      return;
    }
    const crop = doc.transform.crop;
    const naturalWidth = layer.image?.naturalWidth || layer.image?.width || 0;
    const naturalHeight = layer.image?.naturalHeight || layer.image?.height || 0;
    const theta = ((layer.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const scale = layer.scale || 1;
    const cx = layer.x + (naturalWidth * scale) / 2;
    const cy = layer.y + (naturalHeight * scale) / 2;
    const a = cos / scale;
    const b = -sin / scale;
    const c = sin / scale;
    const d = cos / scale;
    const dx = offsetX - (crop?.x || 0);
    const dy = offsetY - (crop?.y || 0);
    const e = naturalWidth / 2 - (cos * cx + sin * cy) / scale + a * dx + c * dy;
    const f = naturalHeight / 2 - (-sin * cx + cos * cy) / scale + b * dx + d * dy;
    target.setTransform(a, b, c, d, e, f);
  }

  /** 当前要涂抹的图层蒙版（未进入图层蒙版模式时返回 null）。 */
  function layerMaskTarget() {
    if (!doc || !editingLayerMaskId) return null;
    const layer = doc.findLayer(editingLayerMaskId);
    return layer?.mask ? layer : null;
  }

  function stampLayerMask(layer, point, radius, erase) {
    const pad = 2;
    const size = Math.ceil(radius * 2) + pad * 2;
    const x0 = Math.floor(point.x - radius) - pad;
    const y0 = Math.floor(point.y - radius) - pad;
    const scratchCanvas = scratch(size);
    const sctx = scratchCanvas.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, size, size);
    paintDab(sctx, point.x - x0, point.y - y0, radius, false);
    if (selection) {
      sctx.globalCompositeOperation = 'destination-in';
      sctx.drawImage(selection.canvas, -x0, -y0);
      sctx.globalCompositeOperation = 'source-over';
    }
    const mctx = layer.mask.getContext('2d');
    mctx.save();
    docToLayerTransform(mctx, layer, x0, y0);
    // 图层蒙版语义：白 = 显示。画笔涂抹 = 挖掉蒙版（隐藏），橡皮 = 补回白色（恢复）。
    mctx.globalCompositeOperation = erase ? 'source-over' : 'destination-out';
    mctx.drawImage(scratchCanvas, 0, 0);
    mctx.restore();
    layer.touchMask();
    doc.touchLayers();
    if (selectedLayerId !== layer.id) selectedLayerId = layer.id;
  }

  function stampMask(point) {
    if (!doc) return;
    const radius = Math.max(1, brush.size / 2);
    const erase = tool === 'eraser';
    const layer = layerMaskTarget();
    if (layer) {
      stampLayerMask(layer, point, radius, erase);
      return;
    }
    if (!selection) {
      paintDab(doc.mask.getContext('2d'), point.x, point.y, radius, erase);
      afterStamp(radius, point, erase);
      return;
    }
    // 有选区时先画到小画布，再按选区 alpha 裁剪，避免每次整图合成。
    const pad = 2;
    const size = Math.ceil(radius * 2) + pad * 2;
    const x0 = Math.floor(point.x - radius) - pad;
    const y0 = Math.floor(point.y - radius) - pad;
    const scratchCanvas = scratch(size);
    const sctx = scratchCanvas.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, size, size);
    paintDab(sctx, point.x - x0, point.y - y0, radius, false);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(selection.canvas, -x0, -y0);
    sctx.globalCompositeOperation = 'source-over';
    const mctx = doc.mask.getContext('2d');
    mctx.save();
    mctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    mctx.drawImage(scratchCanvas, 0, 0, size, size, x0, y0, size, size);
    mctx.restore();
    afterStamp(radius, point, erase);
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

  /**
   * 把「蒙版空间」的白色形状落到目标蒙版：有选区就按选区裁剪，
   * 图层蒙版模式下再经仿射变换写入图层自身坐标。
   */
  function commitShapePaint(paint) {
    if (!doc) return false;
    const layer = layerMaskTarget();
    if (layer) {
      const canvas = fullScratch(doc.mask.width, doc.mask.height);
      const sctx = canvas.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, canvas.width, canvas.height);
      paint(sctx);
      if (selection) {
        sctx.globalCompositeOperation = 'destination-in';
        sctx.drawImage(selection.canvas, 0, 0);
        sctx.globalCompositeOperation = 'source-over';
      }
      const mctx = layer.mask.getContext('2d');
      mctx.save();
      docToLayerTransform(mctx, layer, 0, 0);
      // 形状 = 隐藏蒙版区域（白蒙版语义），与画笔一致。
      mctx.globalCompositeOperation = 'destination-out';
      mctx.drawImage(canvas, 0, 0);
      mctx.restore();
      layer.touchMask();
      doc.touchLayers();
      doc.commitLayers();
      return true;
    }
    if (!selection) {
      paint(doc.mask.getContext('2d'));
      doc.markMaskChanged(true);
      tintDirty = true;
      doc.snapshot();
      return true;
    }
    const canvas = fullScratch(doc.mask.width, doc.mask.height);
    const sctx = canvas.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, canvas.width, canvas.height);
    paint(sctx);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(selection.canvas, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    doc.mask.getContext('2d').drawImage(canvas, 0, 0);
    doc.markMaskChanged(true);
    tintDirty = true;
    doc.snapshot();
    return true;
  }

  function fillShape(rect) {
    if (!doc || rect.width < 1 || rect.height < 1) return;
    const committed = commitShapePaint((target) => {
      target.save();
      target.globalAlpha = brush.opacity;
      target.fillStyle = '#ffffff';
      target.beginPath();
      if (tool === 'ellipse') {
        target.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
      } else {
        target.rect(rect.x, rect.y, rect.width, rect.height);
      }
      target.fill();
      target.restore();
    });
    if (!committed) return;
    updateHistoryUi();
    updateMaskStatus();
  }

  /** 套索：把自由路径自动闭合后填充成蒙版。 */
  function fillLasso(points) {
    if (!doc || points.length < 3) return;
    const committed = commitShapePaint((target) => {
      target.save();
      target.globalAlpha = brush.opacity;
      target.fillStyle = '#ffffff';
      target.beginPath();
      target.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) target.lineTo(point.x, point.y);
      target.closePath();
      target.fill();
      target.restore();
    });
    if (!committed) return;
    updateHistoryUi();
    updateMaskStatus();
  }

  /* ============================================================
   * 污点修复（D10.1）
   * ============================================================ */

  /**
   * 修复类笔触的统一入口：写入修复层，并在有选区时按选区 alpha 裁剪，
   * 与蒙版画笔/形状保持同一套选区语义（此前修复类会画到选区外）。
   *
   * 选区轮廓是蚂蚁线路径（大量不闭合线段），只能描边不能填充，
   * 所以这里沿用蒙版画笔的做法：先画到等尺寸临时画布，再用
   * destination-in 叠选区 alpha，最后贴回修复层。
   */
  function repairPaint(point, radius, paint) {
    if (!doc) return false;
    const repair = doc.ensureRepair();
    if (!selection) return paint(repair.getContext('2d'));
    const canvas = fullScratch(repair.width, repair.height);
    const sctx = canvas.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    // 只处理笔触附近，避免每次整图合成；边距覆盖笔刷最大外溢。
    const pad = Math.ceil(radius * 2) + 16;
    const x0 = Math.max(0, Math.floor(point.x - pad));
    const y0 = Math.max(0, Math.floor(point.y - pad));
    const x1 = Math.min(repair.width, Math.ceil(point.x + pad));
    const y1 = Math.min(repair.height, Math.ceil(point.y + pad));
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) return false;
    sctx.clearRect(x0, y0, width, height);
    const result = paint(sctx);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(selection.canvas, x0, y0, width, height, x0, y0, width, height);
    sctx.globalCompositeOperation = 'source-over';
    repair.getContext('2d').drawImage(canvas, x0, y0, width, height, x0, y0, width, height);
    return result;
  }

  /** 在文档坐标点画一个修复笔触：取样来自「底图合成」，结果写进修复层。 */
  function healAt(point) {
    if (!doc) return;
    const source = doc.renderUnderlay();
    const radius = Math.max(2, brush.size / 2);
    repairPaint(point, radius, (target) =>
      healDab(target, source, {
        x: point.x,
        y: point.y,
        radius,
        opacity: brush.opacity,
        softness: 1 - brush.hardness,
      }),
    );
    // 修复层画在 underlay 之上，必须让 underlay/base 一起失效才能看到即时结果。
    doc.invalidateBase();
  }

  /** 沿拖动路径按笔刷间距连续落笔，避免快速拖动出现断点。 */
  function healStroke(point) {
    const from = drag?.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(2, brush.size * 0.22);
    if (distance < step) return;
    const count = Math.floor(distance / step);
    for (let i = 1; i <= count; i += 1) {
      const t = (i * step) / distance;
      healAt({ x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
    }
    if (drag) drag.last = point;
  }

  /* ============================================================
   * 仿制图章 / 修复画笔（D10.2）
   * ============================================================ */

  function cloneAt(point) {
    if (!doc || !drag || drag.mode !== 'clone') return;
    if (!drag.sample) drag.sample = doc.renderSample();
    const radius = Math.max(2, brush.size / 2);
    const ok = repairPaint(point, radius, (target) =>
      cloneDab(target, drag.sample, {
        x: point.x,
        y: point.y,
        sx: point.x - drag.offset.x,
        sy: point.y - drag.offset.y,
        radius,
        opacity: brush.opacity,
        softness: 1 - brush.hardness,
        blend: tool === 'healbrush' ? 'heal' : 'clone',
      }),
    );
    if (!ok) {
      toastWarn('取样区域超出画面，请重新 Alt 点击取样');
      drag.mode = 'clone-blocked';
      return;
    }
    doc.invalidateBase();
  }

  function cloneStroke(point) {
    const from = drag?.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(2, brush.size * 0.22);
    if (distance < step) return;
    const count = Math.floor(distance / step);
    for (let i = 1; i <= count; i += 1) {
      const t = (i * step) / distance;
      cloneAt({ x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
    }
    if (drag) drag.last = point;
  }

  /* ============================================================
   * 图案图章（D11.4）
   * ============================================================ */

  /** 图案笔触：按取样矩形平铺填充笔刷窗口，写进修复层。 */
  function patternAt(point) {
    if (!doc || !patternRect) return;
    if (!drag) return;
    if (!drag.sample) drag.sample = doc.renderSample();
    const radius = Math.max(2, brush.size / 2);
    const ok = repairPaint(point, radius, (target) =>
      patternDab(target, drag.sample, {
        x: point.x,
        y: point.y,
        radius,
        opacity: brush.opacity,
        softness: 1 - brush.hardness,
        pattern: patternRect,
      }),
    );
    if (!ok) {
      toastWarn('图案取样区域超出画面，请按住 Alt 重新拖框取样');
      drag.mode = 'pattern-blocked';
      return;
    }
    doc.invalidateBase();
  }

  function patternStroke(point) {
    const from = drag?.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(2, brush.size * 0.3);
    if (distance < step) return;
    const count = Math.floor(distance / step);
    for (let i = 1; i <= count; i += 1) {
      const t = (i * step) / distance;
      patternAt({ x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
    }
    if (drag) drag.last = point;
  }

  function updatePatternHint() {
    if (!refs.patternHint) return;
    refs.patternHint.textContent = patternRect
      ? `图案 ${Math.round(patternRect.width)} × ${Math.round(patternRect.height)}`
      : 'Alt 拖框取样';
  }

  /* ============================================================
   * 涂抹（D10.3）
   * ============================================================ */

  function smudgeAt(point, delta) {
    if (!doc) return;
    const source = doc.renderUnderlay();
    const radius = Math.max(2, brush.size / 2);
    const shift = smudgeShift(normalizeVector(delta.x, delta.y), radius, 0.35);
    repairPaint(point, radius, (target) =>
      smudgeDab(target, source, {
        x: point.x,
        y: point.y,
        dx: shift.x,
        dy: shift.y,
        radius,
        opacity: brush.opacity,
        softness: 1 - brush.hardness,
      }),
    );
    doc.invalidateBase();
  }

  /* ============================================================
   * 磨皮（D10.4）
   * ============================================================ */

  function skinAt(point) {
    if (!doc) return;
    const source = doc.renderUnderlay();
    const radius = Math.max(3, brush.size / 2);
    const ok = repairPaint(point, radius, (target) =>
      skinDab(target, source, {
        x: point.x,
        y: point.y,
        radius,
        // 不透明度兼作磨皮强度：100% 最平滑，30% 只做轻微柔化。
        strength: 0.4 + brush.opacity * 0.55,
        opacity: brush.opacity,
        softness: 1 - brush.hardness,
      }),
    );
    if (!ok) return;
    doc.invalidateBase();
  }

  function skinStroke(point) {
    const from = drag?.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(2, brush.size * 0.22);
    if (distance < step) return;
    const count = Math.floor(distance / step);
    for (let i = 1; i <= count; i += 1) {
      const t = (i * step) / distance;
      skinAt({ x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
    }
    if (drag) drag.last = point;
  }

  /* ============================================================
   * 液化（D10.5）
   * ============================================================ */

  /**
   * 每帧都从「本笔开始时的快照」按累计位移取样，保证是形变而不是累积涂抹。
   */
  function liquifyAt(point) {
    if (!doc || !drag?.base) return;
    const radius = Math.max(3, brush.size / 2);
    const ok = repairPaint(point, radius, (target) =>
      warpPatch(target, drag.base, {
        x: point.x,
        y: point.y,
        dx: drag.total.x,
        dy: drag.total.y,
        radius,
        strength: 0.4 + brush.opacity * 0.6,
      }),
    );
    if (!ok) return;
    doc.invalidateBase();
  }

  /* ============================================================
   * 马赛克 / 局部模糊（D11.1）
   * ============================================================ */

  function mosaicAt(point) {
    if (!doc) return;
    const source = doc.renderUnderlay();
    const radius = Math.max(3, brush.size / 2);
    const ok = repairPaint(point, radius, (target) =>
      mosaicDab(target, source, {
        x: point.x,
        y: point.y,
        radius,
        mode: refs.mosaicMode?.value === 'blur' ? 'blur' : 'mosaic',
        block: Math.max(2, Math.round(radius * 0.22)),
        blurRadius: Math.max(1, Math.round(radius * 0.18)),
        opacity: brush.opacity,
        softness: 0.45,
      }),
    );
    if (!ok) return;
    doc.invalidateBase();
  }

  function mosaicStroke(point) {
    const from = drag?.last || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const step = Math.max(2, brush.size * 0.3);
    if (distance < step) return;
    const count = Math.floor(distance / step);
    for (let i = 1; i <= count; i += 1) {
      const t = (i * step) / distance;
      mosaicAt({ x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
    }
    if (drag) drag.last = point;
  }

  /* ============================================================
   * 指针交互
   * ============================================================ */

  refs.canvas.addEventListener('pointerdown', (event) => {
    if (!doc) return;
    refs.canvas.setPointerCapture?.(event.pointerId);
    dragRect = refs.canvas.getBoundingClientRect();
    const point = clampPoint(toImage(event.clientX, event.clientY, dragRect));

    if (tool === 'text' && event.button === 0) {
      // 在画面上点一下即创建文字图层，并切到「文字」分页直接编辑（D11.2）。
      const at = maskPoint(point);
      const count = doc.layers.filter((layer) => layer.isText).length + 1;
      const layer = doc.addTextLayer(TEXT_DEFAULTS, {
        name: `文字 ${count}`,
        x: Math.round(at.x),
        y: Math.round(at.y),
      });
      selectedLayerId = layer.id;
      editingLayerMaskId = '';
      // 先切工具（move 会把分页拉回 AI），再把分页锁到「文字」。
      setTool('move');
      activeTab = 'text';
      syncTabs();
      syncTextPane();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
      ai?.refresh?.();
      toast('已创建文字图层，在右侧修改文案与样式');
      return;
    }

    // 局部调整取景（D9.4）：优先级最高（含「抓手」工具），拖完自动退出，不会误涂或误平移。
    if (localEdit && adjustmentTarget() && event.button === 0) {
      const at = maskPoint(point);
      drag = { mode: 'local', type: localEdit, start: at, end: at };
      return;
    }
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
    if (tool === 'wand') {
      // Shift 加选，Alt 减选，Shift+Alt 交集，默认替换；单击即完成，不产生拖拽。
      const mode =
        event.shiftKey && event.altKey ? 'intersect' : event.altKey ? 'sub' : event.shiftKey ? 'add' : 'new';
      drag = null;
      wandSelectAt(point, mode);
      return;
    }
    if (tool === 'segment') {
      // D13.1：主体 = 点一下即分割；框选 = 拖框；点选 = 累积提示点；文字 = 走浮条输入。
      const at = maskPoint(point);
      if (segMode === 'box') {
        drag = { mode: 'segBox', start: at, rect: null };
        scheduleDraw();
      } else if (segMode === 'points') {
        segPoints.push({ x: at.x, y: at.y, label: event.altKey ? 0 : 1 });
        syncSegUi();
        scheduleDraw();
        void runSegment({});
      } else if (segMode === 'subject') {
        void runSegment({});
      } else {
        toast('文字模式：在下方输入主体描述后点「选取」');
        refs.segText?.focus();
      }
      return;
    }
    if (CLONE_TOOLS.has(tool)) {
      const imagePoint = maskPoint(point);
      if (event.altKey) {
        // Alt + 点击 = 取样（对齐模式下会清空旧偏移）。
        cloneAnchor = { x: imagePoint.x, y: imagePoint.y };
        cloneOffset = null;
        toast(`已取样：${Math.round(imagePoint.x)}, ${Math.round(imagePoint.y)}`);
        scheduleDraw();
        return;
      }
      if (!cloneAnchor) {
        toastWarn('按住 Alt 点击画面取样，再涂抹复制');
        return;
      }
      const relative = { x: imagePoint.x - cloneAnchor.x, y: imagePoint.y - cloneAnchor.y };
      // 对齐：整段会话沿用第一次落笔的相对偏移；非对齐：每笔重新对齐取样点。
      const useAligned = refs.cloneAligned?.checked !== false;
      if (useAligned && !cloneOffset) cloneOffset = relative;
      const offset = useAligned ? cloneOffset || relative : relative;
      drag = { mode: 'clone', last: imagePoint, offset, sample: doc.renderSample() };
      cloneAt(imagePoint);
      scheduleDraw();
      return;
    }
    if (tool === 'smudge') {
      drag = { mode: 'smudge', last: maskPoint(point) };
      return;
    }
    if (tool === 'skin') {
      drag = { mode: 'skin', last: maskPoint(point) };
      skinAt(maskPoint(point));
      scheduleDraw();
      return;
    }
    if (tool === 'liquify') {
      // 记下本笔开始时的底图，后续都从它取样（真正的形变，不会越推越花）。
      const at = maskPoint(point);
      drag = { mode: 'liquify', start: at, last: at, total: { x: 0, y: 0 }, base: doc.renderUnderlay() };
      return;
    }
    if (tool === 'mosaic') {
      drag = { mode: 'mosaic', last: maskPoint(point) };
      mosaicAt(maskPoint(point));
      scheduleDraw();
      return;
    }
    if (tool === 'spot') {
      drag = { mode: 'spot', last: maskPoint(point) };
      healAt(maskPoint(point));
      scheduleDraw();
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
    if (tool === 'shape') {
      // 形状图层：拖动时只记起止点，松手才建层（D11.4）。
      drag = { mode: 'shapeDraw', start: point, end: null, shape: shapeStyle.shape };
      return;
    }
    if (tool === 'pattern') {
      const at = maskPoint(point);
      if (event.altKey) {
        // Alt + 拖框 = 重新取样图案区域。
        drag = { mode: 'patternPick', start: at, rect: null };
        return;
      }
      if (!patternRect) {
        toastWarn('按住 Alt 在画面上拖框取样图案，再涂抹复制');
        return;
      }
      drag = { mode: 'patternPaint', last: at, sample: doc.renderSample() };
      patternAt(at);
      scheduleDraw();
      return;
    }
    if (tool === 'move' || tool === 'sticker') {
      const crop = doc.transform.crop;
      const ix = point.x + (crop?.x || 0);
      const iy = point.y + (crop?.y || 0);

      // 选中贴纸的角手柄 / 旋转圆点优先于普通拖动（D11.3）；透视编辑时改拖四角（D13.3）。
      const active = selectedLayerId ? doc.findLayer(selectedLayerId) : null;
      if (perspectiveEdit && active?.quad && !active.isText && !active.isShape) {
        const px = event.clientX - dragRect.left;
        const py = event.clientY - dragRect.top;
        const nearCorner = (point) => {
          const vx = view.x + (point.x - (crop?.x || 0)) * view.scale;
          const vy = view.y + (point.y - (crop?.y || 0)) * view.scale;
          return Math.hypot(vx - px, vy - py) <= 11;
        };
        const index = active.quad.findIndex(nearCorner);
        if (index >= 0) {
          drag = { mode: 'perspCorner', layer: active, index };
          return;
        }
      } else if (active && !active.isAdjustment && !active.isText) {
        const handles = stickerHandles(active);
        const px = event.clientX - dragRect.left;
        const py = event.clientY - dragRect.top;
        const near = (handle) => Math.hypot(handle.x - px, handle.y - py) <= 11;
        if (near(handles.knobView)) {
          drag = {
            mode: 'stickerRotate',
            layer: active,
            center: handles.centerDoc,
            startAngle: Math.atan2(iy - handles.centerDoc.y, ix - handles.centerDoc.x),
            origin: active.rotation || 0,
          };
          return;
        }
        if (handles.cornersView.some(near)) {
          drag = {
            mode: 'stickerScale',
            layer: active,
            center: handles.centerDoc,
            startDist: Math.max(1, Math.hypot(ix - handles.centerDoc.x, iy - handles.centerDoc.y)),
            startScale: active.scale,
          };
          return;
        }
      }

      const layer = [...(doc.layers || [])].reverse().find((item) => item.hitTest(ix, iy));
      if (layer) {
        selectedLayerId = layer.id;
        editingLayerMaskId = '';
        // 选中即切到对应分页：文字层 → 文字，贴纸/叠加层 → 贴纸（D11.2 / D11.3）。
        if (layer.isText) {
          activeTab = 'text';
          syncTabs();
          syncTextPane();
        } else if (!layer.isAdjustment) {
          activeTab = 'sticker';
          syncTabs();
          syncStickerPane();
        }
        syncLayerProps();
        drag = { mode: 'moveLayer', layer, start: point, originX: layer.x, originY: layer.y };
        scheduleDraw();
        return;
      }
      if (tool === 'sticker') {
        // 空白处点击：记下落点并打开文件选择，导入的新贴纸以该点居中（D11.3）。
        pendingStickerPoint = { x: ix, y: iy };
        refs.stickerInput.value = '';
        refs.stickerInput.click();
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
    const imagePoint = maskPoint(point);
    if (drag.mode === 'paint') {
      strokeTo(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'spot') {
      healStroke(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'clone' || drag.mode === 'clone-blocked') {
      if (drag.mode === 'clone') cloneStroke(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'mosaic') {
      mosaicStroke(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'liquify') {
      const step = drag.last || imagePoint;
      drag.total.x += imagePoint.x - step.x;
      drag.total.y += imagePoint.y - step.y;
      drag.last = imagePoint;
      liquifyAt(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'skin') {
      skinStroke(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'smudge') {
      const from = drag.last || imagePoint;
      const delta = { x: imagePoint.x - from.x, y: imagePoint.y - from.y };
      if (Math.hypot(delta.x, delta.y) >= 1) {
        smudgeAt(imagePoint, delta);
        drag.last = imagePoint;
      }
      scheduleDraw();
      return;
    }
    if (drag.mode === 'crop') {
      drag.rect = normalizeRect(drag.start, point);
      syncCropOverlay(drag.rect);
      return;
    }
    if (drag.mode === 'segBox') {
      drag.rect = normalizeRect(drag.start, imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'shape') {
      drag.rect = normalizeRect(drag.start, point);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'local') {
      drag.end = imagePoint;
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
    if (drag.mode === 'shapeDraw') {
      drag.end = point;
      scheduleDraw();
      return;
    }
    if (drag.mode === 'patternPick') {
      drag.rect = normalizeRect(drag.start, imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'patternPaint' || drag.mode === 'pattern-blocked') {
      if (drag.mode === 'patternPaint') patternStroke(imagePoint);
      scheduleDraw();
      return;
    }
    if (drag.mode === 'stickerScale') {
      const crop = doc.transform.crop;
      const px = point.x + (crop?.x || 0);
      const py = point.y + (crop?.y || 0);
      const dist = Math.hypot(px - drag.center.x, py - drag.center.y);
      setStickerScale(drag.layer, (drag.startScale * dist) / drag.startDist);
      doc.touchLayers();
      syncStickerPane();
      scheduleDraw();
      return;
    }
    if (drag.mode === 'stickerRotate') {
      const crop = doc.transform.crop;
      const px = point.x + (crop?.x || 0);
      const py = point.y + (crop?.y || 0);
      const angle = Math.atan2(py - drag.center.y, px - drag.center.x);
      let deg = drag.origin + ((angle - drag.startAngle) * 180) / Math.PI;
      // 默认吸附 15°；按住 Alt 自由旋转（D11.3）。
      if (!event.altKey) deg = Math.round(deg / 15) * 15;
      drag.layer.rotation = normalizeAngle(deg);
      doc.touchLayers();
      syncStickerPane();
      scheduleDraw();
      return;
    }
    if (drag.mode === 'perspCorner') {
      const crop = doc.transform.crop;
      drag.layer.quad[drag.index] = {
        x: Math.round((point.x + (crop?.x || 0)) * 10) / 10,
        y: Math.round((point.y + (crop?.y || 0)) * 10) / 10,
      };
      drag.layer._warpCache = null;
      doc.touchLayers();
      scheduleDraw();
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
    const shapeDrag = drag.mode === 'shapeDraw' && drag.end ? { start: { ...drag.start }, end: { ...drag.end }, shape: drag.shape } : null;
    const points = drag.points;
    const localDrag = drag.mode === 'local' ? { type: drag.type, start: drag.start, end: drag.end } : null;
    drag = null;
    if (mode === 'paint') {
      if (editingLayerMaskId) {
        // 图层蒙版：几何与蒙版都由 commitLayers 一次性落快照，不动文档蒙版状态。
        doc?.commitLayers();
      } else {
        doc?.markMaskChanged(tool !== 'eraser');
        doc?.snapshot();
      }
      updateHistoryUi();
      updateMaskStatus();
    } else if (mode === 'spot') {
      // 整笔修复作为一个撤销步（D10.1）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'clone' || mode === 'clone-blocked') {
      // 整笔仿制/修复作为一个撤销步（D10.2）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'smudge') {
      // 整笔涂抹作为一个撤销步（D10.3）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'skin') {
      // 整笔磨皮作为一个撤销步（D10.4）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'liquify') {
      // 整笔液化作为一个撤销步（D10.5）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'mosaic') {
      // 整笔马赛克/模糊作为一个撤销步（D11.1）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'shape' && rect) {
      fillShape(offsetRect(rect));
    } else if (mode === 'lasso' && points?.length >= 3) {
      fillLasso(points);
      // 圈完回到 AI 分页，直接写指令
      activeTab = 'ai';
      syncTabs();
      ai?.focusPrompt?.();
    } else if (mode === 'shapeDraw' && shapeDrag) {
      // 松手才建形状层：太短的拖动视为误触（D11.4）。
      const { start, end, shape } = shapeDrag;
      const box = normalizeRect(start, end);
      const signed = shape === 'line' || shape === 'arrow';
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const tiny = signed ? length < 4 : box.width < 4 || box.height < 4;
      if (!tiny) {
        const crop = doc.transform.crop;
        const count = doc.layers.filter((layer) => layer.isShape).length + 1;
        const layer = doc.addShapeLayer(
          { ...shapeStyle },
          {
            name: `形状 ${count}`,
            x: Math.round((signed ? start.x : box.x) + (crop?.x || 0)),
            y: Math.round((signed ? start.y : box.y) + (crop?.y || 0)),
            width: Math.round(signed ? end.x - start.x : box.width),
            height: Math.round(signed ? end.y - start.y : box.height),
          },
        );
        selectedLayerId = layer.id;
        editingLayerMaskId = '';
        // setTool('move') 会把分页拉回 AI，再切到形状页（D11.4）。
        setTool('move');
        activeTab = 'shape';
        syncTabs();
        syncShapePane();
        updateHistoryUi();
        scheduleDraw();
        scheduleSave();
        ai?.refresh?.();
        toast('已创建形状，可在右侧调整填充 / 描边 / 圆角');
      }
    } else if (mode === 'segBox') {
      // D13.1 框选：松手才发起分割，太小的框视为误触。
      if (rect && rect.width > 6 && rect.height > 6) {
        void runSegment({ box: rect });
      } else {
        toastWarn('框太小了，请重新拖出一个框');
      }
    } else if (mode === 'patternPick') {
      if (rect && rect.width > 4 && rect.height > 4) {
        patternRect = { ...rect };
        updatePatternHint();
        toastSuccess(`已取样 ${Math.round(rect.width)} × ${Math.round(rect.height)} 图案，开始涂抹复制`);
        scheduleDraw();
      } else {
        toastWarn('取样框太小，请按住 Alt 重新拖框');
      }
    } else if (mode === 'patternPaint' || mode === 'pattern-blocked') {
      // 整笔图案图章作为一个撤销步（D11.4）。
      doc?.snapshot();
      updateHistoryUi();
    } else if (mode === 'perspCorner') {
      // 透视四角整段拖动落一步撤销（D13.3）。
      doc?.commitLayers();
      syncStickerPane();
      updateHistoryUi();
    } else if (mode === 'stickerScale' || mode === 'stickerRotate') {
      // 贴纸缩放/旋转整段拖动作为一个撤销步（D11.3）。
      commitSticker();
    } else if (mode === 'moveLayer') {
      doc?.commitLayers();
      updateHistoryUi();
      ai?.refresh?.();
    } else if (mode === 'local') {
      // 拖太短视为误触，不落快照；否则按几何重建蒙版并退出取景。
      const target = adjustmentTarget();
      const distance = localDrag
        ? Math.hypot(localDrag.end.x - localDrag.start.x, localDrag.end.y - localDrag.start.y)
        : 0;
      if (target && distance >= 4 / Math.max(0.01, view.scale)) {
        target.setLocal({
          type: localDrag.type,
          start: localDrag.start,
          end: localDrag.end,
          feather: target.local?.feather ?? 50,
        });
        doc.touchLayers();
        doc.commitLayers();
        updateHistoryUi();
        ai?.refresh?.();
        toastSuccess(
          localDrag.type === 'linear' ? '已应用线性局部调整' : '已应用径向局部调整',
        );
      }
      localEdit = null;
      refs.canvas.classList.remove('is-local-picking');
      syncAdjustInputs();
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
    versions = [];
    currentVersionId = '';
    renderDock();
    saveDirty = true;
  }

  /* ---------------------------------------------------------- 项目生命周期（D22.2） */

  /**
   * 回到空状态（关闭当前项目）：默认先保存。
   * 关闭后仍可从「项目历史」重新打开，但同标签刷新不再自动恢复。
   */
  async function closeProject({ flush = true } = {}) {
    if (!doc) return;
    const closingId = projectId;
    clearTimeout(saveTimer);
    saveTimer = 0;
    clearTimeout(idleTimer);
    idleTimer = 0;
    clearTimeout(saveRetryTimer);
    saveRetryTimer = 0;
    savePending = false;
    if (flush && !persistDisabled && !leaseLocked && closingId) {
      // 等在途保存结束，避免同一工程被并发写入一半的状态。
      const deadline = Date.now() + 8000;
      while (saving && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      try {
        const payload = await collectProject();
        if (payload) {
          await saveStudioProject(payload);
          setSaveState('saved');
        }
      } catch {
        toastWarn('关闭前保存失败，工程可能缺少最后一次修改');
      }
    }
    saveDirty = false;
    stopLease();
    // 清掉「上次工程」指针：否则同标签刷新会立刻把刚关闭的工程恢复回来。
    await clearLastProject().catch(() => {});
    projectId = '';
    projectCreatedAt = 0;
    doc = null;
    sourceBlob = null;
    layerBlobs.clear();
    versions = [];
    currentVersionId = '';
    renderDock();
    thumbCache = { doc: null, base: null, url: '' };
    selection = null;
    selPath = null;
    stopAnts();
    pendingRestore = null;
    refs.restoreBar.hidden = true;
    cropRect = null;
    refs.cropbar.hidden = true;
    editingLayerMaskId = '';
    selectedLayerId = null;
    pendingStickerPoint = null;
    perspectiveEdit = false;
    tint = null;
    tintDirty = true;
    tintRect = null;
    adjustPreview = false;
    resetSegmentHints();
    setPreview(null);
    ai?.resetTaskContext?.();
    ai?.resetResult?.();
    ai?.refresh?.();
    refs.empty.hidden = false;
    refs.dot.classList.remove('is-live');
    refs.fileName.textContent = '未打开图片';
    refs.dims.textContent = '';
    for (const key of ['exportBtn', 'compareAllBtn', 'upscaleBtn']) refs[key].disabled = true;
    refs.statusMask.textContent = '蒙版 0%';
    refs.maskClear.disabled = true;
    refs.maskExport.disabled = true;
    renderSnapshots();
    updateHistoryUi();
    updateSelectionUi();
    updatePatternHint?.();
    // 先切工具（会重写状态栏），再把空状态文案补回去。
    setTool('view');
    refs.statusTool.textContent = '未打开图片 · 支持拖拽 / 粘贴';
    if (!persistDisabled) setSaveState('idle');
    void syncProjectCount();
    scheduleDraw();
  }

  /**
   * 新建项目：先打开选择器，用户真正选中图片后再关闭旧工程（自动保存）。
   * 这样取消选择时不会把当前工程关掉。
   */
  function startNewProject(source = 'local') {
    const asNewProject = Boolean(doc);
    if (source === 'warehouse') {
      openMainPicker('warehouse', { asNewProject });
      return;
    }
    pendingNewProject = asNewProject;
    refs.fileInput.click();
  }

  async function saveNow() {
    if (!doc) {
      toastWarn('还没有打开的项目');
      return;
    }
    if (persistDisabled) {
      toastWarn('当前浏览器不支持本机保存');
      return;
    }
    if (leaseLocked) {
      toastWarn('该工程已在其他标签编辑，本标签为只读');
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = 0;
    clearTimeout(idleTimer);
    idleTimer = 0;
    const deadline = Date.now() + 8000;
    while (saving && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    saveDirty = true;
    await runSave();
    if (saveDirty) toastWarn('保存失败，请稍后重试');
    else toastSuccess('已保存到本机');
  }

  function renameProject() {
    if (!doc) return;
    const wrap = document.createElement('div');
    wrap.className = 'studio-rename';
    wrap.innerHTML = `
      <input class="input" type="text" maxlength="60" aria-label="工程名称" />
      <div class="studio-note">只改工程名称，不影响图片与编辑内容。</div>`;
    const input = wrap.querySelector('input');
    input.value = doc.name || '';
    openModal({
      title: '重命名项目',
      size: 'sm',
      content: wrap,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存',
          kind: 'primary',
          onClick: () => {
            const next = input.value.trim();
            if (!next) {
              toastWarn('工程名称不能为空');
              return false;
            }
            doc.name = next;
            refs.fileName.textContent = next;
            saveDirty = true;
            flushSave();
            toastSuccess('已重命名');
            return true;
          },
        },
      ],
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  async function deleteCurrentProject() {
    if (!doc || !projectId) return;
    const name = doc.name || '未命名工程';
    const ok = await confirmDialog({
      title: '删除当前项目',
      message: `删除「${escapeHtml(name)}」？本机工程、图层、参考图与版本记录会一起删除，不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const id = projectId;
    await closeProject({ flush: false });
    try {
      await clearProject(id);
      toastSuccess('项目已删除');
    } catch (err) {
      toastError(err, '删除项目失败');
    }
  }

  /* ---------------------------------------------------------- 主图版本 Dock（D22.1） */

  const VERSION_BADGES = { original: '原', edit: 'AI', upscale: '放大', import: '导入' };

  function nextVersionLabel(kind) {
    if (kind === 'original') return '原始主图';
    const count = versions.filter((item) => item.kind !== 'original').length + 1;
    if (kind === 'upscale') return `放大 ${count}`;
    if (kind === 'import') return `导入 ${count}`;
    if (kind === 'outpaint') return `扩图 ${count}`;
    return `编辑 ${count}`;
  }

  /** 160px WebP 缩略图；失败返回空串，卡片用底色兜底。 */
  async function versionThumb(blob) {
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      const width = 160;
      const height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * width));
      const canvas = makeCanvas(width, height);
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      return canvas.toDataURL('image/webp', 0.8);
    } catch {
      return '';
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 重绘 Dock：卡片按时间正序，原始卡第一张并带分隔线。 */
  function renderDock() {
    const track = refs.dockTrack;
    if (!track) return;
    if (!doc || !versions.length) {
      refs.dock.hidden = true;
      track.textContent = '';
      return;
    }
    refs.dock.hidden = false;
    const frag = document.createDocumentFragment();
    for (const version of versions) {
      const item = document.createElement('div');
      item.className = 'studio-dock-item';
      if (version.kind === 'original' && versions.length > 1) item.classList.add('is-first');
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'studio-dock-card';
      card.dataset.vid = version.id;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', version.id === currentVersionId ? 'true' : 'false');
      if (version.id === currentVersionId) card.classList.add('is-current');
      const time = version.at ? new Date(version.at).toLocaleString() : '';
      card.title = `${version.label} · ${fmtNum(version.width)} × ${fmtNum(version.height)}${time ? ` · ${time}` : ''}`;
      const image = document.createElement('img');
      image.src = version.thumbUrl || '';
      image.alt = version.label;
      image.loading = 'lazy';
      image.decoding = 'async';
      card.appendChild(image);
      const badge = document.createElement('span');
      badge.className = 'studio-dock-badge';
      badge.textContent = VERSION_BADGES[version.kind] || '图';
      card.appendChild(badge);
      if (version.id === currentVersionId) {
        const dot = document.createElement('span');
        dot.className = 'studio-dock-dot';
        dot.setAttribute('aria-hidden', 'true');
        card.appendChild(dot);
      }
      item.appendChild(card);
      const label = document.createElement('span');
      label.className = 'studio-dock-label';
      label.textContent = version.label;
      item.appendChild(label);
      frag.appendChild(item);
    }
    track.textContent = '';
    track.appendChild(frag);
    // 当前卡滚进视野（只调 scrollLeft，不触发整页滚动）。
    const current = track.querySelector('.studio-dock-card.is-current');
    if (current) {
      const trackRect = track.getBoundingClientRect();
      const cardRect = current.getBoundingClientRect();
      if (cardRect.left < trackRect.left) {
        track.scrollLeft -= trackRect.left - cardRect.left + 16;
      } else if (cardRect.right > trackRect.right) {
        track.scrollLeft += cardRect.right - trackRect.right + 16;
      }
    }
  }

  /**
   * 追加一个主图版本并落盘（D22.1）。
   * 存储不可用时仍留在内存，保证 Dock 可用。
   */
  async function recordVersion(kind, blob, options = {}) {
    const current = doc;
    if (!current) return null;
    const last = versions[versions.length - 1];
    const id = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const thumbUrl = options.thumbUrl ?? (await versionThumb(blob));
    if (doc !== current) return null;
    const record = {
      id,
      kind,
      label: options.label || nextVersionLabel(kind),
      name: current.name,
      width: current.sourceSize?.width || current.size.width,
      height: current.sourceSize?.height || current.size.height,
      at: Math.max(Date.now(), (last?.at || 0) + 1),
      fromId: options.fromId ?? currentVersionId,
      thumbUrl,
      meta: options.meta || null,
      blobKey: `${projectId}:${id}`,
      ...(persistDisabled ? { blob } : {}),
    };
    versions = [...versions, record];
    currentVersionId = id;
    renderDock();
    if (persistDisabled || !projectId) return record;
    try {
      await addStudioVersion({ ...record, projectId, blob });
      const removed = await trimStudioVersions(projectId, { limit: MAX_VERSIONS, keepId: id });
      if (removed.length) versions = versions.filter((item) => !removed.includes(item.id));
      const stored = await listStudioVersions(projectId);
      if (stored.length) versions = stored;
      renderDock();
    } catch {
      // 落盘失败不影响当前会话，下次保存会再尝试
    }
    return record;
  }

  /** 载入某个版本为主图：清空蒙版/选区/撤销栈，当前指针同步。 */
  async function switchVersion(versionId) {
    if (!doc || !versionId || versionId === currentVersionId) return;
    const version = versions.find((item) => item.id === versionId);
    if (!version) return;
    const token = ++openSeq;
    let blob = version.blob || null;
    if (!blob) {
      try {
        blob = await loadStudioVersionBlob(version.blobKey || `${projectId}:${version.id}`);
      } catch {
        blob = null;
      }
    }
    if (token !== openSeq || !doc) return;
    if (!blob) {
      toastWarn('该版本的原图不在本机，无法切换');
      return;
    }
    setPreview(null);
    flushAdjustPreview();
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      if (token !== openSeq) return;
      const name = doc.name;
      const next = new StudioDoc(image, name);
      sourceBlob = blob;
      setDoc(next);
      // 150ms 淡入：只动 opacity，不做位移，避免切换时晕。
      refs.canvas.classList.remove('is-version-fade');
      void refs.canvas.offsetWidth;
      refs.canvas.classList.add('is-version-fade');
      currentVersionId = version.id;
      renderDock();
      scheduleSave();
      toast(`已切换到「${version.label}」`);
    } catch (err) {
      toastError(err, '切换版本失败');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** 打开工程时从本机恢复版本链；老工程没有版本记录时补一张原始卡。 */
  async function restoreVersions(session) {
    versions = [];
    currentVersionId = '';
    if (!doc || !projectId) {
      renderDock();
      return;
    }
    if (!persistDisabled) {
      try {
        versions = await listStudioVersions(projectId);
      } catch {
        versions = [];
      }
    }
    if (!doc) return;
    if (!versions.length) {
      await recordVersion('original', sourceBlob || undefined, { label: '原始主图' });
      return;
    }
    currentVersionId = session?.currentVersionId || '';
    if (!versions.some((item) => item.id === currentVersionId)) {
      currentVersionId = versions[versions.length - 1].id;
    }
    renderDock();
  }

  refs.dockTrack.addEventListener('click', (event) => {
    const card = event.target.closest('[data-vid]');
    if (!card) return;
    card.classList.remove('is-bounce');
    // 触发一次 macOS 式弹跳（只弹一次）
    void card.offsetWidth;
    card.classList.add('is-bounce');
    setTimeout(() => card.classList.remove('is-bounce'), 260);
    void switchVersion(card.dataset.vid);
  });

  refs.dockTrack.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const cards = [...refs.dockTrack.querySelectorAll('[data-vid]')];
    if (!cards.length) return;
    event.preventDefault();
    const index = cards.indexOf(document.activeElement);
    let next = index;
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowRight') next = Math.min(cards.length - 1, index + 1);
    else if (event.key === 'Home') next = 0;
    else next = cards.length - 1;
    cards[next]?.focus();
  });

  /** 滚轮 = 卡片轮播（不切换主图），每格约一张卡。 */
  refs.dockTrack.addEventListener(
    'wheel',
    (event) => {
      if (refs.dockTrack.scrollWidth <= refs.dockTrack.clientWidth) return;
      event.preventDefault();
      const delta = (event.deltaY || event.deltaX) * (event.shiftKey ? -1 : 1);
      refs.dockTrack.scrollLeft += delta;
    },
    { passive: false },
  );

  /* ---------------------------------------------------------- 版本卡右键菜单（D22.1 V3 收尾） */

  let versionMenuId = '';

  function closeVersionMenu() {
    if (!refs.versionMenu || refs.versionMenu.hidden) return;
    refs.versionMenu.hidden = true;
    versionMenuId = '';
  }

  function openVersionMenu(version, x, y) {
    const index = versions.findIndex((item) => item.id === version.id);
    if (index < 0) return;
    versionMenuId = version.id;
    const later = versions.length - index - 1;
    refs.versionMenu.innerHTML = `
      <button type="button" role="menuitem" data-vact="compare">与当前对比</button>
      <button type="button" role="menuitem" data-vact="save">另存为 PNG</button>
      ${version.kind === 'original' ? '' : '<button type="button" role="menuitem" data-vact="delete">删除此版本</button>'}
      ${
        later > 0
          ? `<button type="button" role="menuitem" data-vact="truncate">从此处重新开始（删除之后 ${later} 张）</button>`
          : ''
      }`;
    refs.versionMenu.hidden = false;
    refs.versionMenu.style.left = '0px';
    refs.versionMenu.style.top = '0px';
    const rect = refs.versionMenu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    refs.versionMenu.style.left = `${left}px`;
    refs.versionMenu.style.top = `${top}px`;
  }

  async function versionBlobOf(version) {
    if (version.blob) return version.blob;
    try {
      return await loadStudioVersionBlob(version.blobKey || `${projectId}:${version.id}`);
    } catch {
      return null;
    }
  }

  async function runVersionAction(action) {
    const version = versions.find((item) => item.id === versionMenuId);
    closeVersionMenu();
    if (!version) return;
    const index = versions.findIndex((item) => item.id === version.id);
    if (action === 'compare') {
      const blob = await versionBlobOf(version);
      if (!blob) {
        toastWarn('该版本的原图不在本机');
        return;
      }
      const url = URL.createObjectURL(blob);
      ai?.compareAll?.({ extra: [{ url, label: version.label }] });
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    if (action === 'save') {
      const blob = await versionBlobOf(version);
      if (!blob) {
        toastWarn('该版本的原图不在本机');
        return;
      }
      const url = URL.createObjectURL(blob);
      downloadUrl(url, `${baseName(doc?.name || 'studio')}-${version.label}.png`);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return;
    }
    if (action === 'delete') {
      if (version.kind === 'original' || !projectId) return;
      const confirmed = await confirmDialog({
        title: '删除版本',
        message: `删除「${version.label}」？该版本的原始图会从本机移除，不可恢复。`,
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      if (version.id === currentVersionId) {
        const prev = versions[index - 1] || versions.find((item) => item.id !== version.id);
        if (prev) await switchVersion(prev.id);
      }
      try {
        await deleteStudioVersion(projectId, version.id);
        versions = versions.filter((item) => item.id !== version.id);
        renderDock();
        toastSuccess('版本已删除');
      } catch (err) {
        toastError(err, '删除版本失败');
      }
      return;
    }
    if (action === 'truncate') {
      const later = versions.slice(index + 1);
      if (!later.length || !projectId) return;
      const confirmed = await confirmDialog({
        title: '从此处重新开始',
        message: `将删除「${version.label}」之后的 ${later.length} 个版本，不可恢复；当前底图会保留。`,
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      try {
        for (const item of later) await deleteStudioVersion(projectId, item.id, { force: true });
        versions = versions.slice(0, index + 1);
        if (!versions.some((item) => item.id === currentVersionId)) {
          const last = versions[versions.length - 1];
          if (last) await switchVersion(last.id);
        }
        renderDock();
        toastSuccess(`已删除之后 ${later.length} 个版本`);
      } catch (err) {
        toastError(err, '删除版本失败');
      }
    }
  }

  refs.dockTrack.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('[data-vid]');
    if (!card) return;
    event.preventDefault();
    const version = versions.find((item) => item.id === card.dataset.vid);
    if (version) openVersionMenu(version, event.clientX, event.clientY);
  });

  refs.versionMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = event.target.closest('[data-vact]');
    if (!item) return;
    void runVersionAction(item.dataset.vact);
  });

  /* ---------------------------------------------------------- 项目历史（D22.1 V4） */

  function setProjHistory(open) {
    if (!refs.projHistoryPanel) return;
    refs.projHistoryPanel.hidden = !open;
    refs.projHistoryBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    refs.projHistoryBtn.classList.toggle('is-open', open);
    if (open) void refreshProjectList();
  }

  async function syncProjectCount() {
    try {
      const projects = await listProjects();
      refs.projHistoryCount.textContent = String(projects.length);
    } catch {
      refs.projHistoryCount.textContent = '0';
    }
  }

  /** 渲染本机工程列表；正在被其它标签编辑的工程禁止直接打开。 */
  async function refreshProjectList() {
    let projects = [];
    try {
      projects = await listProjects();
    } catch {
      projects = [];
    }
    refs.projHistoryCount.textContent = String(projects.length);
    refs.projHistoryMeta.textContent = `${projects.length} 个项目`;
    refs.projHistoryEmpty.hidden = projects.length > 0;
    refs.projHistoryList.textContent = '';
    if (!projects.length) return;
    const tab = tabId();
    for (const project of projects) {
      const item = document.createElement('div');
      item.className = 'studio-proj-item';
      item.dataset.pid = project.id;
      if (project.id === projectId) item.classList.add('is-current');
      const locked = project.id !== projectId && leaseHeldByOther(project.id, tab);
      const size = project.width && project.height ? `${fmtNum(project.width)} × ${fmtNum(project.height)}` : '';
      const when = project.updatedAt ? relativeTime(project.updatedAt) : '';
      item.innerHTML = `
        <div class="studio-proj-thumb">${
          project.thumbnail ? `<img src="${escapeHtml(project.thumbnail)}" alt="" loading="lazy" />` : '<span>无图</span>'
        }</div>
        <div class="studio-proj-info">
          <div class="studio-proj-name">${escapeHtml(project.name || '未命名工程')}</div>
          <div class="studio-proj-meta mono">${escapeHtml([size, when].filter(Boolean).join(' · '))}</div>
        </div>
        ${project.id === projectId ? '<span class="studio-proj-flag">当前</span>' : ''}
        ${locked ? '<span class="studio-proj-flag is-lock">编辑中</span>' : ''}
        <div class="studio-proj-actions">
          <button class="btn ghost sm" type="button" data-act="open"${locked ? ' disabled' : ''}>打开</button>
          <button class="btn ghost sm" type="button" data-act="delete">删除</button>
        </div>`;
      refs.projHistoryList.appendChild(item);
    }
  }

  /** 读取并清空「从历史记录打开工程」的一次性交接。 */
  function takePendingProject() {
    try {
      const id = sessionStorage.getItem('wb.studio.openProject') || '';
      if (id) sessionStorage.removeItem('wb.studio.openProject');
      return id;
    } catch {
      return '';
    }
  }

  /** 从项目历史打开一个工程：先保存当前工程，再按工程快照恢复。 */
  async function openProjectById(id) {
    if (!id) return false;
    if (id === projectId && doc) {
      toast('已经是当前项目');
      return true;
    }
    let saved = null;
    try {
      saved = await loadProject(id);
    } catch {
      saved = null;
    }
    if (!saved?.project) {
      toastWarn('工程不存在或已删除');
      await syncProjectCount();
      return false;
    }
    const base = (saved.layers || []).find((layer) => layer.id === 'base');
    if (!base?.bitmapBlob) {
      toastWarn('工程缺少主图，无法打开');
      return false;
    }
    if (doc) await closeProject({ flush: true });
    const ok = await applyRestore(saved);
    if (ok) {
      // 重新落一次 lastProjectId：关闭旧工程时被清掉，打开新工程后要恢复自动恢复能力。
      scheduleSave(300);
      toastSuccess(`已打开「${saved.project.name || '工程'}」`);
      if (!refs.projHistoryPanel.hidden) await refreshProjectList();
    }
    return ok;
  }

  refs.projHistoryBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setProjHistory(refs.projHistoryPanel.hidden);
  });

  refs.projHistoryClose.addEventListener('click', () => setProjHistory(false));

  refs.projHistoryList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const item = button.closest('[data-pid]');
    const id = item?.dataset.pid;
    if (!id) return;
    if (button.dataset.act === 'open') {
      button.disabled = true;
      const ok = await openProjectById(id);
      button.disabled = false;
      if (ok) setProjHistory(false);
      return;
    }
    if (button.dataset.act === 'delete') {
      const name = item.querySelector('.studio-proj-name')?.textContent || '该工程';
      const confirmed = await confirmDialog({
        title: '删除工程',
        message: `删除「${escapeHtml(name)}」？本机工程、图层、参考图与版本记录会一起删除，不可恢复。`,
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      try {
        if (id === projectId) await closeProject({ flush: false });
        await clearProject(id);
      } catch (err) {
        toastError(err, '删除工程失败');
        return;
      }
      toastSuccess('工程已删除');
      await refreshProjectList();
    }
  });

  void syncProjectCount();

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
    // 调整图层没有位图，只持久化参数与蒙版（D9.3）；文字/形状层只存样式（D11.2 / D11.4）。
    if (layer.isAdjustment || layer.isText || layer.isShape) return null;
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
    // 3D LUT 体积大（33³ × Float32）且来自本地 .cube 文件，不写进会话
    delete adjust.lut;
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
    let repairBlob = null;
    try {
      // 污点修复层（D10.1）：PNG 保留透明通道，未修区域不覆盖底图。
      repairBlob = current.repair ? await canvasToBlob(current.repair, 'image/png') : null;
    } catch {
      repairBlob = null;
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
      let layerMaskBlob = null;
      if (layer.mask) {
        try {
          layerMaskBlob = await canvasToBlob(layer.mask, 'image/png');
        } catch {
          layerMaskBlob = null;
        }
      }
      layers.push({
        id: layer.id,
        props: {
          kind: layer.isAdjustment ? 'adjustment' : layer.isText ? 'text' : layer.isShape ? 'shape' : 'overlay',
          name: layer.name,
          x: layer.x ?? 0,
          y: layer.y ?? 0,
          scale: layer.scale ?? 1,
          opacity: layer.opacity,
          rotation: layer.rotation ?? 0,
          flipH: Boolean(layer.flipH),
          flipV: Boolean(layer.flipV),
          blend: layer.blend || 'source-over',
          clipped: Boolean(layer.clipped),
          quad: layer.quad ? layer.quad.map((point) => ({ ...point })) : null,
          locked: layer.locked,
          visible: layer.visible !== false,
          hasMask: Boolean(layer.mask),
          maskVisible: layer.maskVisible,
          ...(layer.isAdjustment ? { params: { ...layer.params }, local: { ...layer.local } } : {}),
          ...(layer.isText
            ? {
                text: layer.text,
                fontFamily: layer.fontFamily,
                fontSize: layer.fontSize,
                fontWeight: layer.fontWeight,
                color: layer.color,
                lineHeight: layer.lineHeight,
                strokeWidth: layer.strokeWidth,
                strokeColor: layer.strokeColor,
                shadowBlur: layer.shadowBlur,
                shadowX: layer.shadowX,
                shadowY: layer.shadowY,
                shadowColor: layer.shadowColor,
                arc: layer.arc,
              }
            : {}),
          ...(layer.isShape
            ? {
                width: layer.width,
                height: layer.height,
                shape: layer.shape,
                fill: layer.fill,
                stroke: layer.stroke,
                shapeStrokeWidth: layer.strokeWidth,
                radius: layer.radius,
                style: layer.style,
              }
            : {}),
        },
        blob,
        maskBlob: layerMaskBlob,
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
      repairBlob,
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
        currentVersionId,
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
      void syncProjectCount();
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
      // 污点修复层（D10.1）：透明通道保真，直接贴回同尺寸画布。
      if (base.repairBlob) {
        const repairUrl = URL.createObjectURL(base.repairBlob);
        urls.push(repairUrl);
        const repairImage = await loadImage(repairUrl);
        const repair = next.ensureRepair();
        repair.getContext('2d').drawImage(repairImage, 0, 0, repair.width, repair.height);
      }

      // 图层蒙版恢复（D8.2 / D9.3）：叠加层与调整层共用。
      const restoreLayerMask = async (layer, props, blob) => {
        if (!blob) return;
        const maskUrl = URL.createObjectURL(blob);
        urls.push(maskUrl);
        const maskImage = await loadImage(maskUrl);
        const maskCanvas = layer.ensureMask();
        const mctx = maskCanvas.getContext('2d');
        mctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        mctx.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
        layer.maskVisible = props.maskVisible !== false;
        layer.touchMask();
      };

      const missing = [];
      for (const record of saved.layers || []) {
        if (record.id === 'base') continue;
        const props = record.props || {};
        // D9.3：调整图层没有位图，按参数重建后再恢复蒙版。
        if (props.kind === 'adjustment') {
          const layer = next.addAdjustmentLayer(props.params || {}, {
            name: props.name,
            opacity: props.opacity,
            local: props.local,
          });
          layer.id = record.id;
          layer.visible = props.visible !== false;
          layer.locked = Boolean(props.locked);
          // 没有蒙版快照时按几何重建，保证刷新后局部范围还在（D9.4）。
          if (!record.maskBlob && layer.local?.type !== 'none') layer.setLocal(layer.local);
          await restoreLayerMask(layer, props, record.maskBlob);
          continue;
        }
        // D11.2：文字图层按 props 还原，没有位图。
        if (props.kind === 'text') {
          const layer = next.addTextLayer(props, {
            name: props.name,
            x: Number(props.x) || 0,
            y: Number(props.y) || 0,
          });
          layer.id = record.id;
          layer.visible = props.visible !== false;
          layer.locked = Boolean(props.locked);
          continue;
        }
        // D11.4：形状图层按几何 + 样式还原。
        if (props.kind === 'shape') {
          const layer = next.addShapeLayer(
            {
              shape: props.shape,
              fill: props.fill,
              stroke: props.stroke,
              strokeWidth: props.shapeStrokeWidth,
              radius: props.radius,
              opacity: props.opacity,
              blend: props.blend,
              clipped: props.clipped,
              style: props.style,
            },
            {
              name: props.name,
              x: Number(props.x) || 0,
              y: Number(props.y) || 0,
              width: Number(props.width) || 0,
              height: Number(props.height) || 0,
            },
          );
          layer.id = record.id;
          layer.visible = props.visible !== false;
          layer.locked = Boolean(props.locked);
          continue;
        }
        if (!record.bitmapBlob) {
          missing.push(record.props?.name || record.id);
          continue;
        }
        const layerUrl = URL.createObjectURL(record.bitmapBlob);
        urls.push(layerUrl);
        try {
          const layerImage = await loadImage(layerUrl);
          const layer = next.addOverlay(layerImage, {
            name: props.name,
            x: props.x,
            y: props.y,
            scale: props.scale,
            opacity: props.opacity,
            rotation: props.rotation,
            flipH: props.flipH,
            flipV: props.flipV,
            blend: props.blend,
            clipped: props.clipped,
            quad: props.quad,
            locked: props.locked,
            visible: props.visible !== false,
          });
          // 保留原图层 id，后续自动保存仍然增量更新同一批记录。
          layer.id = record.id;
          layerBlobs.set(record.id, record.bitmapBlob);
          await restoreLayerMask(layer, props, record.maskBlob);
        } catch {
          missing.push(record.props?.name || record.id);
        }
      }

      next.clearHistory();
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
      await restoreVersions(session);
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
      void recordVersion('original', file);
    } catch (err) {
      toastError(err, '打开图片失败');
    } finally {
      URL.revokeObjectURL(url);
      refs.fileInput.value = '';
    }
  }

  async function openUrl(url, name, { kind = 'original' } = {}) {
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
      void recordVersion(kind, sourceBlob);
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
    clearSelection(true);
    resetSegmentHints();
    editingLayerMaskId = '';
    selectedLayerId = null;
    pendingStickerPoint = null;
    perspectiveEdit = false;
    tint = null;
    tintDirty = true;
    tintRect = null;
    adjustPreview = false;
    refs.cropbar.hidden = true;
    refs.empty.hidden = true;
    refs.dot.classList.add('is-live');
    refs.fileName.textContent = doc.name;
    refs.dims.textContent = '';
    for (const key of ['exportBtn', 'compareAllBtn', 'upscaleBtn']) refs[key].disabled = false;
    syncAdjustInputs();
    syncTextPane();
    syncStickerPane();
    syncShapePane();
    syncLayerProps();
    renderSnapshots();
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
    refs.statusMask.textContent = `蒙版 ${fmtCoverage(stats.coverage)}`;
    refs.maskClear.disabled = !stats.has;
    refs.maskExport.disabled = !stats.has;
    ai?.onMaskChanged?.(stats.coverage);
  }

  /** 当前滑杆作用的调整层（选中且为调整图层时）；null 表示编辑主图。 */
  function adjustmentTarget() {
    if (!doc || !selectedLayerId) return null;
    const layer = doc.findLayer(selectedLayerId);
    return layer?.isAdjustment ? layer : null;
  }

  function syncAdjustInputs() {
    if (!doc) return;
    adjustPreview = false;
    const target = adjustmentTarget();
    const params = target ? target.params : doc.adjust;
    for (const input of host.querySelectorAll('[data-adjust]')) {
      const value = params[input.dataset.adjust] ?? 0;
      input.value = String(value);
      const label = host.querySelector(`[data-value="${input.dataset.adjust}"]`);
      if (label) label.textContent = String(value);
    }
    refs.adjustTarget.hidden = !target;
    if (target) refs.adjustTargetName.textContent = target.name;
    syncLocalUi(target);
    syncLutUi();
  }

  /* --------------------------------------------------- 局部调整（D9.4） */

  function localLabel(layer) {
    const local = layer?.local;
    // 涂抹过蒙版后以「画笔蒙版」为准，避免仍显示上一次的渐变类型（D9.4）。
    if (local?.freehand && layer?.mask) return '当前：画笔涂抹的蒙版';
    if (local?.type === 'linear') return '当前：线性渐变（画面上拖线可重画）';
    if (local?.type === 'radial') return '当前：径向渐变（画面上拖拽可重画）';
    return '当前作用全图';
  }

  function syncLocalUi(target) {
    if (!target) {
      localEdit = null;
      refs.localBox.hidden = true;
      refs.canvas.classList.remove('is-local-picking');
      return;
    }
    refs.localBox.hidden = false;
    refs.canvas.classList.toggle('is-local-picking', Boolean(localEdit));
    const feather = target.local?.feather ?? 50;
    refs.localFeather.value = String(feather);
    refs.localFeatherVal.textContent = String(feather);
    refs.localLinear.classList.toggle('is-active', localEdit === 'linear');
    refs.localRadial.classList.toggle('is-active', localEdit === 'radial');
    refs.localHint.textContent =
      localEdit === 'linear'
        ? '在画面上拖一条线：起点完全生效，终点不生效。'
        : localEdit === 'radial'
          ? '在画面上从中心往外拖：中心完全生效，边缘不生效。'
          : localLabel(target);
  }

  function pickLocalType(type) {
    if (!adjustmentTarget()) return;
    localEdit = localEdit === type ? null : type;
    syncLocalUi(adjustmentTarget());
    refs.canvas.classList.toggle('is-local-picking', Boolean(localEdit));
  }

  refs.localLinear.addEventListener('click', () => pickLocalType('linear'));
  refs.localRadial.addEventListener('click', () => pickLocalType('radial'));

  refs.localBrush.addEventListener('click', () => {
    const target = adjustmentTarget();
    if (!target) return;
    target.ensureMask();
    target.local.freehand = true;
    localEdit = null;
    editingLayerMaskId = target.id;
    selectedLayerId = target.id;
    setTool('brush');
    doc.touchLayers();
    doc.commitLayers();
    syncAdjustInputs();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    toast(`正在涂抹「${target.name}」的蒙版：画笔隐藏效果，橡皮擦恢复`);
  });

  refs.localClear.addEventListener('click', () => {
    const target = adjustmentTarget();
    if (!target) return;
    target.clearLocal();
    localEdit = null;
    editingLayerMaskId = editingLayerMaskId === target.id ? '' : editingLayerMaskId;
    doc.touchLayers();
    doc.commitLayers();
    syncAdjustInputs();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    toastSuccess('已恢复全图生效');
  });

  refs.localFeather.addEventListener('input', () => {
    const target = adjustmentTarget();
    if (!target) return;
    refs.localFeatherVal.textContent = refs.localFeather.value;
    target.local.feather = Number(refs.localFeather.value);
  });

  refs.localFeather.addEventListener('change', () => {
    const target = adjustmentTarget();
    if (!target || target.local.type === 'none') return;
    // 过渡曲线只在松手时重建蒙版，避免逐帧逐像素重算。
    target.setLocal(target.local);
    doc.touchLayers();
    doc.commitLayers();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
  });

  /* --------------------------------------------------- 文字图层（D11.2） */

  /** 当前选中的文字层（没有则返回 null）。 */
  function textTarget() {
    if (!doc || !selectedLayerId) return null;
    const layer = doc.findLayer(selectedLayerId);
    return layer?.isText ? layer : null;
  }

  function syncTextPane() {
    const target = textTarget();
    refs.textEmpty.hidden = Boolean(target);
    refs.textFields.hidden = !target;
    if (!target) return;
    refs.textContent.value = target.text;
    refs.textFont.value = target.fontFamily;
    refs.textBold.checked = target.fontWeight >= 600;
    refs.textSize.value = String(Math.round(target.fontSize));
    refs.textSizeVal.textContent = String(Math.round(target.fontSize));
    refs.textColor.value = target.color;
    refs.textStrokeWidth.value = String(Math.round(target.strokeWidth));
    refs.textStrokeVal.textContent = String(Math.round(target.strokeWidth));
    refs.textStrokeColor.value = target.strokeColor;
    refs.textShadow.value = String(Math.round(target.shadowBlur));
    refs.textShadowVal.textContent = String(Math.round(target.shadowBlur));
    refs.textArc.value = String(Math.round(target.arc || 0));
    refs.textArcVal.textContent = String(Math.round(target.arc || 0));
  }

  function bindTextInput(el, apply) {
    el.addEventListener('input', () => {
      const target = textTarget();
      if (!target) return;
      apply(target);
      doc.touchLayers();
      scheduleDraw();
    });
    el.addEventListener('change', () => {
      const target = textTarget();
      if (!target) return;
      apply(target);
      doc.touchLayers();
      doc.commitLayers();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
    });
  }

  bindTextInput(refs.textContent, (target) => {
    target.text = refs.textContent.value;
  });
  bindTextInput(refs.textFont, (target) => {
    target.fontFamily = refs.textFont.value;
  });
  bindTextInput(refs.textBold, (target) => {
    target.fontWeight = refs.textBold.checked ? 700 : 400;
  });
  bindTextInput(refs.textSize, (target) => {
    target.fontSize = Number(refs.textSize.value);
    refs.textSizeVal.textContent = refs.textSize.value;
  });
  bindTextInput(refs.textColor, (target) => {
    target.color = refs.textColor.value;
  });
  bindTextInput(refs.textStrokeWidth, (target) => {
    target.strokeWidth = Number(refs.textStrokeWidth.value);
    refs.textStrokeVal.textContent = refs.textStrokeWidth.value;
  });
  bindTextInput(refs.textStrokeColor, (target) => {
    target.strokeColor = refs.textStrokeColor.value;
  });
  bindTextInput(refs.textShadow, (target) => {
    target.shadowBlur = Number(refs.textShadow.value);
    refs.textShadowVal.textContent = refs.textShadow.value;
  });
  bindTextInput(refs.textArc, (target) => {
    target.arc = Number(refs.textArc.value);
    refs.textArcVal.textContent = refs.textArc.value;
  });

  refs.textDelete.addEventListener('click', () => {
    const target = textTarget();
    if (!target) return;
    if (doc.removeOverlay(target.id)) {
      selectedLayerId = null;
      syncTextPane();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
      toast('已删除文字图层');
    }
  });

  /* --------------------------------------------------- 贴纸（D11.3） */

  /** 当前选中的贴纸/叠加层（调整层与文字层不算）。 */
  function stickerTarget() {
    if (!doc || !selectedLayerId) return null;
    const layer = doc.findLayer(selectedLayerId);
    return layer && !layer.isAdjustment && !layer.isText ? layer : null;
  }

  /** 旋转角归一到 (-180, 180]，便于滑杆回显。 */
  function normalizeAngle(value) {
    const deg = ((Number(value) || 0) % 360 + 360) % 360;
    return deg > 180 ? deg - 360 : deg;
  }

  /** 保持中心不变地设置缩放。 */
  function setStickerScale(layer, nextScale) {
    const scale = Math.max(0.02, Math.min(8, Number(nextScale) || 0.02));
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    layer.scale = scale;
    layer.x = Math.round(cx - layer.width / 2);
    layer.y = Math.round(cy - layer.height / 2);
  }

  /** 贴纸「重置」时的适配缩放：不超过画布宽度的 60%。 */
  function stickerFitScale(layer) {
    if (!doc) return layer.scale;
    return Math.min(1, (doc.size.width * 0.6) / Math.max(1, layer.naturalWidth || 1));
  }

  function syncStickerPane() {
    const layer = stickerTarget();
    refs.stickerEmpty.hidden = Boolean(layer);
    refs.stickerFields.hidden = !layer;
    refs.stickerPerspective.checked = Boolean(layer?.quad) && perspectiveEdit;
    refs.stickerPerspective.disabled = !layer;
    refs.stickerPerspectiveHint.hidden = !(layer?.quad && perspectiveEdit);
    refs.stickerPerspectiveReset.disabled = !layer?.quad;
    if (!layer) return;
    const percent = Math.round(layer.scale * 100);
    refs.stickerScale.value = String(Math.max(5, Math.min(400, percent)));
    refs.stickerScaleVal.textContent = `${percent}%`;
    const deg = Math.round(normalizeAngle(layer.rotation));
    refs.stickerRotate.value = String(deg);
    refs.stickerRotateVal.textContent = `${deg}°`;
    refs.stickerBlend.value = layer.blend || 'source-over';
    // 透视四角已接管几何，缩放/旋转/翻转暂时禁用。
    const warped = Boolean(layer.quad);
    refs.stickerScale.disabled = warped;
    refs.stickerRotate.disabled = warped;
    refs.stickerFlipH.disabled = warped;
    refs.stickerFlipV.disabled = warped;
  }

  /** 贴纸参数落一步撤销 + 自动保存。 */
  function commitSticker() {
    if (!doc || !stickerTarget()) return;
    doc.touchLayers();
    doc.commitLayers();
    syncStickerPane();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    ai?.refresh?.();
  }

  refs.stickerScale.addEventListener('input', () => {
    const layer = stickerTarget();
    if (!layer) return;
    const percent = Number(refs.stickerScale.value);
    refs.stickerScaleVal.textContent = `${percent}%`;
    setStickerScale(layer, percent / 100);
    doc.touchLayers();
    scheduleDraw();
  });
  refs.stickerScale.addEventListener('change', commitSticker);

  refs.stickerRotate.addEventListener('input', () => {
    const layer = stickerTarget();
    if (!layer) return;
    layer.rotation = Number(refs.stickerRotate.value);
    refs.stickerRotateVal.textContent = `${refs.stickerRotate.value}°`;
    doc.touchLayers();
    scheduleDraw();
  });
  refs.stickerRotate.addEventListener('change', commitSticker);

  refs.stickerFlipH.addEventListener('click', () => {
    const layer = stickerTarget();
    if (!layer) return;
    layer.flipH = !layer.flipH;
    commitSticker();
  });

  refs.stickerFlipV.addEventListener('click', () => {
    const layer = stickerTarget();
    if (!layer) return;
    layer.flipV = !layer.flipV;
    commitSticker();
  });

  refs.stickerBlend.addEventListener('change', () => {
    const layer = stickerTarget();
    if (!layer) return;
    layer.blend = refs.stickerBlend.value;
    commitSticker();
  });

  refs.stickerPerspective.addEventListener('change', () => {
    const layer = stickerTarget();
    perspectiveEdit = refs.stickerPerspective.checked;
    if (perspectiveEdit && layer && !layer.quad) {
      // 首次进入透视编辑：用当前旋转后的四角初始化，之后拖动圆点即可改形。
      layer.quad = stickerHandles(layer).cornersDoc.map((point) => ({ ...point }));
      layer._warpCache = null;
      doc.touchLayers();
      doc.commitLayers();
      updateHistoryUi();
      scheduleSave();
      toast('已进入透视编辑：拖动四个圆点改变形状');
    }
    syncStickerPane();
    scheduleDraw();
  });

  refs.stickerPerspectiveReset.addEventListener('click', () => {
    const layer = stickerTarget();
    if (!layer?.quad) return;
    layer.quad = null;
    layer._warpCache = null;
    doc.touchLayers();
    doc.commitLayers();
    syncStickerPane();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    toast('已重置透视');
  });

  refs.stickerReset.addEventListener('click', () => {
    const layer = stickerTarget();
    if (!layer || !doc) return;
    setStickerScale(layer, stickerFitScale(layer));
    layer.rotation = 0;
    layer.flipH = false;
    layer.flipV = false;
    layer.blend = 'source-over';
    layer.quad = null;
    layer._warpCache = null;
    const crop = doc.transform.crop;
    const size = doc.size;
    layer.x = Math.round((size.width - layer.width) / 2 + (crop?.x || 0));
    layer.y = Math.round((size.height - layer.height) / 2 + (crop?.y || 0));
    commitSticker();
    toastSuccess('已重置贴纸变换');
  });

  refs.stickerDelete.addEventListener('click', () => {
    const layer = stickerTarget();
    if (!layer) return;
    if (doc.removeOverlay(layer.id)) {
      selectedLayerId = null;
      syncStickerPane();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
      toast('已删除贴纸');
    }
  });

  refs.stickerImport.addEventListener('click', () => {
    pendingStickerPoint = null;
    refs.stickerInput.value = '';
    refs.stickerInput.click();
  });

  refs.stickerInput.addEventListener('change', async () => {
    const file = refs.stickerInput.files?.[0];
    const at = pendingStickerPoint;
    pendingStickerPoint = null;
    refs.stickerInput.value = '';
    if (!file || !doc) return;
    try {
      const layer = await addOverlayFile(file, { center: at, focusSticker: true });
      if (layer) toast('已导入贴纸：拖动移动，拖角缩放，拖顶部圆点旋转');
    } catch (err) {
      toastError(err, '导入贴纸失败');
    }
  });

  /* --------------------------------------------------- 形状（D11.4） */

  /** 当前选中的形状层（没有则返回 null）。 */
  function shapeTarget() {
    if (!doc || !selectedLayerId) return null;
    const layer = doc.findLayer(selectedLayerId);
    return layer?.isShape ? layer : null;
  }

  /** 面板编辑目标：选中形状时改形状，否则改「新建默认样式」。 */
  function shapeStyleTarget() {
    return shapeTarget() || shapeStyle;
  }

  function syncShapePane() {
    const target = shapeTarget();
    const style = target || shapeStyle;
    refs.shapeKind.value = style.shape;
    refs.shapeFill.value = style.fill;
    refs.shapeStrokeWidth.value = String(Math.round(style.strokeWidth));
    refs.shapeStrokeVal.textContent = String(Math.round(style.strokeWidth));
    refs.shapeStroke.value = style.stroke;
    refs.shapeRadius.value = String(Math.round(style.radius));
    refs.shapeRadiusVal.textContent = String(Math.round(style.radius));
    refs.shapeRadius.disabled = style.shape !== 'rect';
    refs.shapeDelete.disabled = !target;
    refs.shapeHint.textContent = target
      ? `正在编辑「${target.name}」：改动可撤销。`
      : '当前未选中形状：参数将用于新形状。';

    // 图层样式（D12.2）
    const layerStyle = style.style || normalizeShapeStyle();
    refs.styleShadow.checked = layerStyle.shadow.enabled;
    refs.styleShadowColor.value = toHex(layerStyle.shadow.color);
    refs.styleShadowBlur.value = String(Math.round(layerStyle.shadow.blur));
    refs.styleShadowBlurVal.textContent = String(Math.round(layerStyle.shadow.blur));
    refs.styleGlow.checked = layerStyle.glow.enabled;
    refs.styleGlowColor.value = toHex(layerStyle.glow.color);
    refs.styleGlowBlur.value = String(Math.round(layerStyle.glow.blur));
    refs.styleGlowBlurVal.textContent = String(Math.round(layerStyle.glow.blur));
    refs.styleGradient.checked = layerStyle.gradient.enabled;
    refs.styleGradientFrom.value = toHex(layerStyle.gradient.from);
    refs.styleGradientTo.value = toHex(layerStyle.gradient.to);
    refs.styleOverlay.checked = layerStyle.colorOverlay.enabled;
    refs.styleOverlayColor.value = toHex(layerStyle.colorOverlay.color);
    refs.styleOverlayOpacity.value = String(Math.round(layerStyle.colorOverlay.opacity * 100));
    refs.styleOverlayOpacityVal.textContent = String(Math.round(layerStyle.colorOverlay.opacity * 100));
  }

  /** 颜色输入只接受 #rrggbb，做一次兜底转换。 */
  function toHex(color) {
    const value = String(color || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }
    return '#000000';
  }

  /** 形状样式控件：input 实时预览，change 落撤销步。 */
  function bindShapeStyleControl(el, apply) {
    el.addEventListener('input', () => {
      apply(shapeStyleTarget().style, el);
      if (shapeTarget()) {
        doc.touchLayers();
        scheduleDraw();
      }
    });
    el.addEventListener('change', () => {
      apply(shapeStyleTarget().style, el);
      commitShape();
      syncShapePane();
    });
  }

  /** 形状样式落一步撤销（仅在选中形状时）。 */
  function commitShape() {
    if (!doc || !shapeTarget()) return;
    doc.touchLayers();
    doc.commitLayers();
    syncShapePane();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    ai?.refresh?.();
  }

  refs.shapeKind.addEventListener('change', () => {
    shapeStyleTarget().shape = refs.shapeKind.value;
    commitShape();
    syncShapePane();
    scheduleDraw();
  });

  refs.shapeFill.addEventListener('input', () => {
    shapeStyleTarget().fill = refs.shapeFill.value;
    if (shapeTarget()) {
      doc.touchLayers();
      scheduleDraw();
    }
  });
  refs.shapeFill.addEventListener('change', () => {
    shapeStyleTarget().fill = refs.shapeFill.value;
    commitShape();
  });

  refs.shapeStrokeWidth.addEventListener('input', () => {
    const value = Number(refs.shapeStrokeWidth.value);
    shapeStyleTarget().strokeWidth = value;
    refs.shapeStrokeVal.textContent = String(value);
    if (shapeTarget()) {
      doc.touchLayers();
      scheduleDraw();
    }
  });
  refs.shapeStrokeWidth.addEventListener('change', () => {
    shapeStyleTarget().strokeWidth = Number(refs.shapeStrokeWidth.value);
    commitShape();
  });

  refs.shapeStroke.addEventListener('input', () => {
    shapeStyleTarget().stroke = refs.shapeStroke.value;
    if (shapeTarget()) {
      doc.touchLayers();
      scheduleDraw();
    }
  });
  refs.shapeStroke.addEventListener('change', () => {
    shapeStyleTarget().stroke = refs.shapeStroke.value;
    commitShape();
  });

  refs.shapeRadius.addEventListener('input', () => {
    const value = Number(refs.shapeRadius.value);
    shapeStyleTarget().radius = value;
    refs.shapeRadiusVal.textContent = String(value);
    if (shapeTarget()) {
      doc.touchLayers();
      scheduleDraw();
    }
  });
  refs.shapeRadius.addEventListener('change', () => {
    shapeStyleTarget().radius = Number(refs.shapeRadius.value);
    commitShape();
  });

  bindShapeStyleControl(refs.styleShadow, (style, el) => {
    style.shadow.enabled = el.checked;
  });
  bindShapeStyleControl(refs.styleShadowColor, (style, el) => {
    style.shadow.color = el.value;
  });
  bindShapeStyleControl(refs.styleShadowBlur, (style, el) => {
    style.shadow.blur = Number(el.value);
    refs.styleShadowBlurVal.textContent = el.value;
  });
  bindShapeStyleControl(refs.styleGlow, (style, el) => {
    style.glow.enabled = el.checked;
  });
  bindShapeStyleControl(refs.styleGlowColor, (style, el) => {
    style.glow.color = el.value;
  });
  bindShapeStyleControl(refs.styleGlowBlur, (style, el) => {
    style.glow.blur = Number(el.value);
    refs.styleGlowBlurVal.textContent = el.value;
  });
  bindShapeStyleControl(refs.styleGradient, (style, el) => {
    style.gradient.enabled = el.checked;
  });
  bindShapeStyleControl(refs.styleGradientFrom, (style, el) => {
    style.gradient.from = el.value;
  });
  bindShapeStyleControl(refs.styleGradientTo, (style, el) => {
    style.gradient.to = el.value;
  });
  bindShapeStyleControl(refs.styleOverlay, (style, el) => {
    style.colorOverlay.enabled = el.checked;
  });
  bindShapeStyleControl(refs.styleOverlayColor, (style, el) => {
    style.colorOverlay.color = el.value;
  });
  bindShapeStyleControl(refs.styleOverlayOpacity, (style, el) => {
    style.colorOverlay.opacity = Number(el.value) / 100;
    refs.styleOverlayOpacityVal.textContent = el.value;
  });

  refs.shapeDelete.addEventListener('click', () => {
    const target = shapeTarget();
    if (!target) return;
    if (doc.removeOverlay(target.id)) {
      selectedLayerId = null;
      syncShapePane();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
      toast('已删除形状');
    }
  });

  refs.patternClear.addEventListener('click', () => {
    patternRect = null;
    updatePatternHint();
    scheduleDraw();
    toast('已清除图案取样');
  });

  /* --------------------------------------------------- 图层属性：混合模式 + 剪贴蒙版（D12.1） */

  /** 当前可设置混合/剪贴的图层（调整层暂不支持）。 */
  function layerPropsTarget() {
    if (!doc || !selectedLayerId) return null;
    const layer = doc.findLayer(selectedLayerId);
    return layer && !layer.isAdjustment ? layer : null;
  }

  function syncLayerProps() {
    const layer = layerPropsTarget();
    refs.layerProps.hidden = !layer;
    if (!layer) return;
    refs.layerPropsName.textContent = layer.name;
    refs.layerBlend.value = layer.blend || 'source-over';
    const index = doc.layers.indexOf(layer);
    const canClip = index > 0;
    refs.layerClipped.disabled = !canClip;
    refs.layerClipped.checked = canClip && Boolean(layer.clipped);
    refs.layerPropsHint.hidden = canClip;
    refs.layerPropsHint.textContent = canClip ? '' : '最底层不能剪贴：请先把它移到其他图层之上。';
  }

  function commitLayerProps() {
    const layer = layerPropsTarget();
    if (!layer) return;
    doc.touchLayers();
    doc.commitLayers();
    syncLayerProps();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    ai?.refresh?.();
  }

  refs.layerBlend.addEventListener('change', () => {
    const layer = layerPropsTarget();
    if (!layer) return;
    layer.blend = refs.layerBlend.value;
    commitLayerProps();
  });

  refs.layerClipped.addEventListener('change', () => {
    const layer = layerPropsTarget();
    if (!layer) return;
    layer.clipped = refs.layerClipped.checked;
    commitLayerProps();
  });

  /* --------------------------------------------------- 历史快照（D12.3） */

  function renderSnapshots() {
    refs.snapshotBox.hidden = !doc;
    if (!doc) {
      refs.snapshotList.innerHTML = '';
      return;
    }
    const list = doc.snapshots || [];
    if (!list.length) {
      refs.snapshotList.innerHTML = '<div class="studio-note">还没有快照。新建一个可随时回跳。</div>';
      return;
    }
    refs.snapshotList.innerHTML = list
      .map(
        (item) => `
        <div class="studio-snapshot" data-snap="${item.id}">
          <button class="studio-snapshot-name" type="button" data-snap-jump="${item.id}" title="回跳到该快照（可撤销）">${escapeHtml(item.name)}</button>
          <button class="studio-snapshot-del" type="button" data-snap-del="${item.id}" title="删除快照">×</button>
        </div>`,
      )
      .join('');
  }

  /** 回跳后同步所有面板与画布状态。 */
  function afterSnapshotJump(name) {
    selectedLayerId = null;
    editingLayerMaskId = '';
    syncAdjustInputs();
    syncTextPane();
    syncStickerPane();
    syncShapePane();
    syncLayerProps();
    updateHistoryUi();
    updateMaskStatus();
    scheduleDraw();
    scheduleSave();
    renderSnapshots();
    ai?.refresh?.();
    toastSuccess(`已回到快照「${name}」`);
  }

  refs.snapshotAdd.addEventListener('click', () => {
    if (!doc) return;
    const item = doc.addSnapshot(doc.nextSnapshotName());
    if (!item) return;
    renderSnapshots();
    toast(`已创建快照「${item.name}」`);
  });

  refs.snapshotList.addEventListener('click', (event) => {
    const jump = event.target.closest('[data-snap-jump]');
    if (jump) {
      const item = doc?.snapshots.find((entry) => entry.id === jump.dataset.snapJump);
      if (item && doc.restoreSnapshot(item.id)) afterSnapshotJump(item.name);
      return;
    }
    const del = event.target.closest('[data-snap-del]');
    if (del) {
      doc?.removeSnapshot(del.dataset.snapDel);
      renderSnapshots();
      toast('已删除快照');
    }
  });

  refs.snapshotList.addEventListener('dblclick', (event) => {
    const button = event.target.closest('[data-snap-jump]');
    if (!button || !doc) return;
    const item = doc.snapshots.find((entry) => entry.id === button.dataset.snapJump);
    if (!item) return;
    event.preventDefault();
    const input = document.createElement('input');
    input.className = 'studio-snapshot-rename';
    input.value = item.name;
    input.maxLength = 60;
    button.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next) doc.renameSnapshot(item.id, next);
      renderSnapshots();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });

  /* --------------------------------------------------- 直方图（D9.2） */

  let histAt = 0;

  /** 用低分辨率代理画直方图，避免每帧读 4K 像素。 */
  function updateHistogram(force = false) {
    if (!doc || activeTab !== 'adjust') return;
    const now = performance.now();
    if (!force && now - histAt < 120) return;
    histAt = now;
    const source = doc.renderPreviewBase(320);
    const data = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
    const stats = histogram(data);
    paintHistogram(stats);
  }

  function paintHistogram(stats) {
    const canvas = refs.hist;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const { width, height } = canvas;
    g.clearRect(0, 0, width, height);

    // 1/4 网格
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i += 1) {
      const x = Math.round((width * i) / 4) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }

    const peak = Math.max(1, ...stats.luma);
    const top = 3;
    const plot = (bins, fill) => {
      g.beginPath();
      g.moveTo(0, height);
      for (let i = 0; i < 256; i += 1) {
        const x = (i / 255) * width;
        const y = height - Math.min(1, bins[i] / peak) * (height - top);
        g.lineTo(x, y);
      }
      g.lineTo(width, height);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };

    // 亮度做底，RGB 叠加提亮，和 Photoshop 的观感一致
    plot(stats.luma, 'rgba(220,220,220,0.16)');
    g.globalCompositeOperation = 'lighter';
    plot(stats.r, 'rgba(255,64,64,0.45)');
    plot(stats.g, 'rgba(64,220,96,0.45)');
    plot(stats.b, 'rgba(72,128,255,0.5)');
    g.globalCompositeOperation = 'source-over';

    refs.histInfo.textContent = `${Math.round(stats.sampled / 1000)}k 像素`;
    const clip = [];
    if (stats.clipHigh > 0.001) clip.push(`高光 ${(stats.clipHigh * 100).toFixed(1)}%`);
    if (stats.clipLow > 0.001) clip.push(`阴影 ${(stats.clipLow * 100).toFixed(1)}%`);
    refs.histClip.textContent = clip.length ? `削波 ${clip.join(' / ')}` : '无削波';
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
    clearSelection();
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

  /* ---------------------------------------------------------- 抠图（D21.1） */

  let cutoutEdge = 'standard';
  let cutoutBusy = false;

  function renderCutoutEdges() {
    if (!refs.cutEdges) return;
    refs.cutEdges.textContent = '';
    for (const key of CUTOUT_EDGE_ORDER) {
      const preset = CUTOUT_EDGE_PRESETS[key];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'studio-cut-edge';
      button.dataset.edge = key;
      button.textContent = preset.label;
      button.title = `收缩 ${preset.contract}px · 羽化 ${preset.feather}px`;
      button.classList.toggle('is-active', key === cutoutEdge);
      refs.cutEdges.appendChild(button);
    }
  }

  function setCutMenu(open) {
    if (!refs.cutMenu) return;
    refs.cutMenu.hidden = !open;
    refs.cutBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderCutoutEdges();
  }

  function selectionHasArea() {
    return Boolean(selection?.alpha?.length && coverageAlpha(selection.alpha) > 0);
  }

  /**
   * 合成透明底图：`renderBase` → 裁到 `doc.size` → `destination-in` 叠选区 alpha。
   * 选区与底图尺寸不一致时直接拒绝，不做隐式拉伸。
   */
  async function buildCutoutCanvas() {
    if (!doc) return null;
    const base = doc.renderBase();
    if (selection.width !== base.width || selection.height !== base.height) {
      toastWarn('选区与当前画布尺寸不一致，请重新选择');
      clearSelection(true);
      return null;
    }
    const rect = cutoutRect(doc.transform.crop, base.width, base.height);
    const alpha = prepareCutoutAlpha(selection.alpha, selection.width, selection.height, cutoutEdge);
    const alphaCanvas = alphaToCanvas(alpha, selection.width, selection.height);
    const canvas = makeCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alphaCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    ctx.globalCompositeOperation = 'source-over';
    return { canvas, rect };
  }

  async function copyBlob(blob) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  }

  /** 抠图四种出口：透明 PNG / 复制 / 抠图层 / 白底 JPG。 */
  async function runCutout(action) {
    if (!doc || cutoutBusy) return;
    if (previewBlocked('抠图')) return;
    if (!selectionHasArea()) {
      toastWarn('先用 AI 主体选择或魔棒圈出要保留的主体');
      return;
    }
    cutoutBusy = true;
    setCutMenu(false);
    const label = refs.cutBtn.textContent;
    refs.cutBtn.disabled = true;
    refs.cutBtn.textContent = '抠图中…';
    try {
      flushAdjustPreview();
      const built = await buildCutoutCanvas();
      if (!built) return;
      const { canvas, rect } = built;
      const name = baseName(doc.name);
      if (action === 'png') {
        const blob = await canvasToBlob(canvas, 'image/png');
        const url = URL.createObjectURL(blob);
        downloadUrl(url, `${name}-cutout.png`);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toastSuccess(`已抠出选区 · ${rect.width} × ${rect.height} · PNG`);
        return;
      }
      if (action === 'copy') {
        const blob = await canvasToBlob(canvas, 'image/png');
        if (await copyBlob(blob)) {
          toastSuccess('已复制透明 PNG 到剪贴板');
        } else {
          const url = URL.createObjectURL(blob);
          downloadUrl(url, `${name}-cutout.png`);
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          toastWarn('剪贴板不可用，已改为下载 PNG');
        }
        return;
      }
      if (action === 'white') {
        const out = makeCanvas(rect.width, rect.height);
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.drawImage(canvas, 0, 0);
        const blob = await canvasToBlob(out, 'image/jpeg', 0.92);
        const url = URL.createObjectURL(blob);
        downloadUrl(url, `${name}-cutout-white.jpg`);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toastSuccess(`已导出白底 JPG · ${rect.width} × ${rect.height}`);
        return;
      }
      if (action === 'layer') {
        if (leaseLocked) {
          toastWarn('该工程已在其他标签编辑，本标签为只读');
          return;
        }
        const blob = await canvasToBlob(canvas, 'image/png');
        const file = new File([blob], `${name}-cutout.png`, { type: 'image/png' });
        const count = (doc.layers || []).filter((layer) => String(layer.name || '').startsWith('抠图')).length + 1;
        await addOverlayFile(file, {
          name: `抠图 ${count}`,
          x: rect.x,
          y: rect.y,
          scale: 1,
          focusSticker: true,
        });
        toastSuccess('已建立抠图层（可拖动 / 缩放）');
      }
    } catch (err) {
      toastError(err, '抠图导出失败');
    } finally {
      cutoutBusy = false;
      refs.cutBtn.disabled = false;
      refs.cutBtn.textContent = label;
    }
  }

  refs.cutBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setCutMenu(refs.cutMenu.hidden);
  });

  refs.cutMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    const edge = event.target.closest('[data-edge]');
    if (edge) {
      cutoutEdge = edge.dataset.edge;
      renderCutoutEdges();
      return;
    }
    const item = event.target.closest('[data-cut]');
    if (item) void runCutout(item.dataset.cut);
  });

  /* ============================================================
   * 事件绑定
   * ============================================================ */

  refs.rail.addEventListener('click', (event) => {
    const groupButton = event.target.closest('[data-group-toggle]');
    if (groupButton) {
      const group = TOOL_GROUPS.find((item) => item.id === groupButton.dataset.groupToggle);
      if (!group) return;
      if (group.tools.length <= 1) {
        closeRailFlyout();
        setTool(group.tools[0]);
      } else {
        openRailFlyout(group.id);
      }
      return;
    }
    const button = event.target.closest('[data-tool]');
    if (button) {
      closeRailFlyout();
      setTool(button.dataset.tool);
    }
  });

  // 浮层是 fixed 定位（避免被工具轨的 overflow 裁掉）：点外部 / Esc / 滚动 / 改窗口都收起。
  document.addEventListener('click', (event) => {
    if (!openGroupId || !refs.rail.isConnected) return;
    if (event.target.closest('.studio-tool-group')) return;
    closeRailFlyout();
  });
  window.addEventListener('resize', () => {
    if (refs.rail.isConnected) closeRailFlyout();
  });
  refs.rail.addEventListener('scroll', closeRailFlyout, { passive: true });
  syncRail();

  host.querySelector('.studio-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    if (tool === 'outpaint') setTool('view');
    activeTab = button.dataset.tab;
    syncTabs();
    if (activeTab === 'adjust') updateHistogram(true);
    if (activeTab === 'text') syncTextPane();
    if (activeTab === 'sticker') syncStickerPane();
    if (activeTab === 'shape') syncShapePane();
  });

  /* ---------------------------------------------------------- 顶栏项目菜单（D22.2） */

  function setProjMenu(open) {
    refs.projMenu.hidden = !open;
    refs.projBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  refs.projBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setImportMenu(false);
    setExportMenu(false);
    setProjMenu(refs.projMenu.hidden);
  });

  refs.projMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-proj]');
    if (!item) return;
    setProjMenu(false);
    const action = item.dataset.proj;
    if (action === 'new-local') startNewProject('local');
    else if (action === 'new-warehouse') startNewProject('warehouse');
    else if (action === 'save') void saveNow();
    else if (action === 'rename') renameProject();
    else if (action === 'close') {
      void closeProject().then(() => toast('已关闭项目，可随时新建或恢复'));
    } else if (action === 'delete') {
      void deleteCurrentProject();
    }
  });

  /* ---------------------------------------------------------- 顶栏导入菜单 */

  function setImportMenu(open) {
    refs.importMenu.hidden = !open;
    refs.openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // 只有已有主图时才提供「作为新主图（新建项目）」。
    const newMain = refs.importMenu.querySelector('[data-import="newmain"]');
    if (newMain) newMain.hidden = !doc;
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
    if (source === 'newmain') startNewProject('local');
    else if (source === 'local') {
      pendingNewProject = false;
      refs.fileInput.click();
    } else openMainPicker(source);
  });

  /* ---------------------------------------------------------- 顶栏导出菜单 */

  function setExportMenu(open) {
    refs.exportMenu.hidden = !open;
    refs.exportBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // 抠图两项依赖有效选区，无选区时置灰（D21.1）。
    const hasSelection = Boolean(selection?.alpha?.length && coverageAlpha(selection.alpha) > 0);
    for (const button of refs.exportMenu.querySelectorAll('[data-export^="cutout-"]')) {
      button.disabled = !hasSelection;
    }
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
    else if (action === 'cutout-png') void runCutout('png');
    else if (action === 'cutout-copy') void runCutout('copy');
    else if (action === 'favorite') void collect();
    else if (action === 'send') void sendToEdit();
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
    if (!refs.projMenu.hidden && !refs.projWrap.contains(event.target)) setProjMenu(false);
    if (!refs.cutMenu.hidden && !refs.cutWrap.contains(event.target)) setCutMenu(false);
    if (!refs.versionMenu.hidden && !refs.versionMenu.contains(event.target)) closeVersionMenu();
    if (
      !refs.projHistoryPanel.hidden &&
      !refs.projHistoryPanel.contains(event.target) &&
      !refs.projHistoryBtn.contains(event.target)
    ) {
      setProjHistory(false);
    }
  }
  document.addEventListener('click', onDocumentClick);

  refs.emptyOpen.addEventListener('click', () => {
    pendingNewProject = false;
    refs.fileInput.click();
  });
  refs.emptyWarehouse.addEventListener('click', () => openMainPicker('warehouse'));
  refs.fileInput.addEventListener('cancel', () => {
    pendingNewProject = false;
  });
  refs.fileInput.addEventListener('change', () => {
    const asNewProject = pendingNewProject;
    pendingNewProject = false;
    const files = [...(refs.fileInput.files || [])];
    refs.fileInput.value = '';
    void importLocalFiles(files, { asNewProject });
  });

  refs.compareAllBtn.addEventListener('click', () => {
    void ai?.compareAll?.();
  });
  refs.upscaleBtn.addEventListener('click', () => {
    if (!doc || previewBlocked('放大')) return;
    flushAdjustPreview();
    openUpscaleDialog({
      getImage: () => doc.bake('image/png'),
      getSize: () => doc.size,
      onAdopt: (url, name) => openUrl(url, name, { kind: 'upscale' }),
      onCompare: (url) => ai?.compareAll?.({ extra: [{ url, label: '放大结果' }] }),
    });
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
      const target = adjustmentTarget();
      if (target) {
        // 调整图层（D9.3）：改它自己的参数，作用于所有下层内容。
        target.params[key] = Number(input.value);
        doc.touchAdjustment(target.id);
        doc.touchLayers();
      } else {
        doc.adjust[key] = Number(input.value);
        // 小图（≤1024）预览会直接复用 renderBase，必须让缓存失效才能看到实时变化
        doc.invalidateBase();
      }
      // 拖动期间只出低分辨率代理，避免每帧过滤 4K（D18.2）。
      adjustPreview = true;
      const label = host.querySelector(`[data-value="${key}"]`);
      if (label) label.textContent = input.value;
      scheduleDraw();
    });
    input.addEventListener('change', () => {
      if (!doc) return;
      const target = adjustmentTarget();
      if (adjustPreview) {
        adjustPreview = false;
        doc.invalidateBase();
      }
      if (target) {
        doc.touchAdjustment(target.id);
        doc.commitLayers();
      } else {
        doc.snapshot();
      }
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
    });
  }

  refs.resetAdjust.addEventListener('click', () => {
    if (!doc) return;
    const target = adjustmentTarget();
    if (target) {
      target.params = { ...ADJUSTMENT_DEFAULTS };
      doc.touchAdjustment(target.id);
      doc.commitLayers();
    } else {
      doc.adjust = { ...ADJUST_DEFAULTS };
      doc.invalidateBase();
      doc.snapshot();
    }
    syncAdjustInputs();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
  });

  /* ------------------------------------------------- 调整图层（D9.3） */

  refs.addAdjustLayer.addEventListener('click', () => {
    if (!doc) {
      toastWarn('请先打开一张图片');
      return;
    }
    const count = doc.layers.filter((layer) => layer.isAdjustment).length + 1;
    const layer = doc.addAdjustmentLayer({}, { name: `调整图层 ${count}` });
    selectedLayerId = layer.id;
    editingLayerMaskId = '';
    syncAdjustInputs();
    ai?.refresh?.();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
    toastSuccess(`已创建「${layer.name}」：拖动上方滑杆即可非破坏式调色`);
  });

  refs.adjustTargetBack.addEventListener('click', () => {
    selectedLayerId = null;
    syncAdjustInputs();
    scheduleDraw();
  });

  /* ------------------------------------------------------- 3D LUT（D9.2） */

  let lutBusy = false;

  function syncLutUi() {
    const target = adjustmentTarget();
    const lut = target ? null : doc?.adjust?.lut || null;
    const strength = Math.round((lut?.strength ?? 1) * 100);
    refs.lutBtn.disabled = Boolean(target);
    refs.lutClear.disabled = !lut;
    refs.lutStrength.disabled = !lut;
    refs.lutStrength.value = String(strength);
    refs.lutStrengthVal.textContent = String(strength);
    refs.lutName.textContent = target
      ? '调整图层不参与 LUT；点「编辑主图」后可加载 LUT'
      : lut
        ? `已加载「${lut.name}」· ${lut.size}³（刷新后需重新加载）`
        : '未加载 LUT（支持 3D .cube，1D 暂不支持）';
  }

  refs.lutBtn.addEventListener('click', () => refs.lutInput.click());

  refs.lutInput.addEventListener('change', async () => {
    const file = refs.lutInput.files?.[0];
    refs.lutInput.value = '';
    if (!file || !doc) return;
    if (adjustmentTarget()) return;
    if (lutBusy) return;
    lutBusy = true;
    try {
      const cube = parseCube(await file.text());
      doc.adjust.lut = {
        name: file.name.replace(/\.cube$/i, ''),
        size: cube.size,
        cube,
        strength: 1,
      };
      doc.invalidateBase();
      doc.snapshot();
      syncLutUi();
      updateHistoryUi();
      scheduleDraw();
      scheduleSave();
      toastSuccess(`已加载 LUT「${doc.adjust.lut.name}」（${cube.size}³）`);
    } catch (error) {
      toastError(`LUT 加载失败：${error.message}`);
    } finally {
      lutBusy = false;
    }
  });

  refs.lutStrength.addEventListener('input', () => {
    if (!doc?.adjust?.lut || adjustmentTarget()) return;
    const value = Number(refs.lutStrength.value);
    doc.adjust.lut.strength = value / 100;
    refs.lutStrengthVal.textContent = String(value);
    adjustPreview = true;
    doc.invalidateBase();
    scheduleDraw();
  });

  refs.lutStrength.addEventListener('change', () => {
    if (!doc?.adjust?.lut || adjustmentTarget()) return;
    if (adjustPreview) {
      adjustPreview = false;
      doc.invalidateBase();
    }
    doc.snapshot();
    updateHistoryUi();
    scheduleDraw();
    scheduleSave();
  });

  refs.lutClear.addEventListener('click', () => {
    if (!doc?.adjust?.lut) return;
    doc.adjust.lut = null;
    doc.invalidateBase();
    doc.snapshot();
    syncLutUi();
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

  /* 选区浮条（D8.1）：容差 / 连续 / 半径 + 反选、羽化、扩展、收缩、清除。 */
  const selTolerance = host.querySelector('[data-sel="tolerance"]');
  selTolerance?.addEventListener('input', () => {
    wand.tolerance = Math.max(0, Math.min(255, Math.round(Number(selTolerance.value) || 0)));
    const label = host.querySelector('.studio-selbar [data-value="tolerance"]');
    if (label) label.textContent = String(wand.tolerance);
  });
  refs.wandContig?.addEventListener('change', () => {
    wand.contiguous = Boolean(refs.wandContig.checked);
  });
  refs.selRadius?.addEventListener('input', () => {
    selRadius = Math.max(0, Math.min(200, Math.round(Number(refs.selRadius.value) || 0)));
  });
  for (const button of host.querySelectorAll('[data-sel-op]')) {
    button.addEventListener('click', () => {
      const op = button.dataset.selOp;
      if (op === 'mask' || op === 'remove') {
        commitSelectionToMask(op === 'remove');
        return;
      }
      runSelectionOp(op);
    });
  }

  /* ---------------------------------------------------------- AI 主体选择（D13.1） */

  refs.segModes?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seg-mode]');
    if (!button) return;
    const next = button.dataset.segMode;
    if (!SEGMENT_MODES.some((item) => item.id === next) || next === segMode) return;
    segMode = next;
    segPoints = [];
    segCandidates = [];
    segAppliedId = '';
    syncSegUi();
    scheduleDraw();
    if (segMode === 'text') refs.segText?.focus();
  });

  refs.segRun?.addEventListener('click', () => {
    void runSegment({ text: refs.segText?.value || '' });
  });

  refs.segText?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void runSegment({ text: refs.segText.value });
  });

  refs.segClear?.addEventListener('click', () => {
    resetSegmentHints();
    scheduleDraw();
  });

  refs.segCands?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seg-cand]');
    if (!button) return;
    const mask = segCandidates[Number(button.dataset.segCand)];
    if (!mask) return;
    void applySegmentMask(mask).then(() => syncSegUi());
  });

  syncSegUi();

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
  async function importPicked(items, { asNewProject = false } = {}) {
    const list = Array.isArray(items) ? items.filter((item) => item?.src) : [];
    if (!list.length) return;
    // 「新建项目」：用户已选中图片，此时才关闭旧工程（会先自动保存）。
    if (asNewProject && doc) await closeProject();
    if (doc) {
      await ai.addRefItems(list);
      return;
    }
    const [first, ...rest] = list;
    const opened = await openUrl(first.src, first.name);
    if (opened && rest.length) await ai.addRefItems(rest);
  }

  async function importLocalFiles(fileList, { asNewProject = false } = {}) {
    const files = [...(fileList || [])].filter((file) => file.type?.startsWith('image/'));
    if (!files.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    if (asNewProject && doc) await closeProject();
    if (doc) {
      await ai.addRefFiles(files);
      return;
    }
    const [first, ...rest] = files;
    await openFile(first);
    if (doc && rest.length) await ai.addRefFiles(rest);
  }

  function openMainPicker(source, { asNewProject = false } = {}) {
    openImportPicker({
      title: '导入图片',
      accept: 'main',
      multiple: false,
      initialSource: source,
      onPick(items) {
        void importPicked(items, { asNewProject });
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
    if (event.key === 'Escape' && refs.versionMenu && !refs.versionMenu.hidden) {
      closeVersionMenu();
      return;
    }
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
    if (mod && event.key.toLowerCase() === 's') {
      // 立即保存（D22.2）：自动保存之外的手动落盘。
      event.preventDefault();
      void saveNow();
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
      if (openGroupId) {
        closeRailFlyout();
        return;
      }
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
      // 从「历史记录 · 精修工程」跳转过来时，优先打开指定工程。
      const pending = takePendingProject();
      if (pending) {
        void openProjectById(pending);
        return;
      }
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
      stopAnts();
      selection = null;
      selPath = null;
      editingLayerMaskId = '';
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
