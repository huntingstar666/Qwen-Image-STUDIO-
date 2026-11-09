/**
 * 「图像处理」页面（新）。
 * 定位：本地图片工作台 —— 裁剪 / 宫格 / 旋转翻转 / 缩放 / 调色 / 格式导出 / 扩图 / 送入图像编辑。
 *
 * 实现要点：
 * 1. 几何操作（crop / rotate / flip / resize / pad32）在前端 Canvas 里即时预览；
 *    调色用 CSS filter 即时近似预览，真正落盘时统一把 operations 交给后端
 *    `POST /api/image/process`，由 Pillow 按同样顺序执行，保证输出与预览一致。
 * 2. 裁剪 / 宫格几何直接复用 `web/vendor/image-tools-kit/src/cropGeometry.js`；
 *    只自行实现手柄交互与 canvas 渲染（不引 React）。
 * 3. 扩图复用 `outpaint.js`：`/api/image/outpaint-plan` → 新画布 + 「新增区域」遮罩，
 *    可一键把画布与遮罩送入图像编辑页做局部重绘。
 * 4. 所有结果仅在本页面会话内保留（缩略图历史），可下载、回看、继续编辑。
 */

import { api } from '../api.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { openModal } from './modal.js';
import { setHandoff, goToEditPage, setT2IHandoff, goToT2IPage } from '../handoff.js';
import { openCompareDialog } from './compare.js';
import { OUTPAINT_DIRECTIONS, OUTPAINT_DIRECTION_LABELS, planOutpaint } from '../outpaint.js';
import {
  copyText,
  downloadUrl,
  escapeHtml,
  fmtNum,
  probeImageSize,
  readFileAsDataURL,
  snapUp,
} from '../utils.js';

const NEUTRAL_ADJUST = Object.freeze({
  brightness: 1,
  contrast: 1,
  saturation: 1,
  sharpness: 1,
  temperature: 0,
});

const FORMAT_LABEL = { png: 'PNG（无损，可透明）', jpeg: 'JPEG（体积小，无透明）' };

const TOOL_ICONS = {
  adjust:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h9M18 7h2M4 17h4M13 17h7"/><circle cx="15.5" cy="7" r="2"/><circle cx="10.5" cy="17" r="2"/></svg>',
  size:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><path d="M9 12h6M12 9v6"/></svg>',
  watermark:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c2.6 3 5 6.2 5 8.8a5 5 0 0 1-10 0C7 9.2 9.4 6 12 3Z"/><path d="M9.5 14.5c.6.9 1.5 1.4 2.5 1.4"/></svg>',
  gif:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.5-2.8L10 9.2Z"/></svg>',
  upscale:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V4h6M20 14v6h-6M14 4h6v6M10 20H4v-6"/><path d="m10 14 4-4"/></svg>',
  export:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M8 10l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  outpaint:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M12 8v8M8 12h8"/></svg>',
  tagger:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5 13.5 20 4 10.5V4h6.5L20 13.5Z"/><circle cx="8.2" cy="8.2" r="1.1"/></svg>',
};

const toolIcon = (name) =>
  `<span class="tool-icon" aria-hidden="true">${TOOL_ICONS[name] || ''}</span>`;

const RESULT_KIND_LABEL = {
  process: '处理',
  grid: '宫格',
  upscale: '放大',
  watermark: '水印',
  gif: '动图',
  'gif-frame': '拆帧',
};

/* ============================================================
 * vendor kit 动态加载（模块级缓存）
 * ============================================================ */
let kitPromise = null;

function loadKit() {
  if (!kitPromise) {
    kitPromise = (async () => {
      const results = await Promise.allSettled([
        import('/vendor/image-tools-kit/src/cropGeometry.js'),
        import('/vendor/image-tools-kit/src/clientRenderer.js'),
        import('/vendor/image-tools-kit/src/prompt.js'),
      ]);
      const [geometry, renderer, prompt] = results.map((result) =>
        result.status === 'fulfilled' ? result.value : null,
      );
      const kit = {
        cropRatios: geometry?.cropRatios || ['1:1', '16:9', '9:16', '4:3', '3:4'],
        cropRatio: geometry?.cropRatio || (() => null),
        centeredCrop: geometry?.centeredCrop,
        cropHandles: geometry?.cropHandles,
        hitCrop: geometry?.hitCrop,
        createCrop: geometry?.createCrop,
        resizeCrop: geometry?.resizeCrop,
        moveCrop: geometry?.moveCrop,
        gridRects: geometry?.gridRects,
        cropOutputRects: geometry?.cropOutputRects,
        equalCuts: geometry?.equalCuts,
        loadImage: renderer?.loadImage,
        cropToDataUrl: renderer?.cropToDataUrl,
        gridToDataUrls: renderer?.gridToDataUrls,
        downloadDataUrl: renderer?.downloadDataUrl,
        panoramaPrompt: prompt?.panoramaPrompt || '',
        buildOutpaintDraft: prompt?.buildOutpaintDraft,
        outpaintDirections: prompt?.outpaintDirections,
        angleLabel: prompt?.angleLabel,
      };
      if (!kit.hitCrop || !kit.gridRects || !kit.cropOutputRects) {
        console.warn('[imageTools] image-tools-kit 模块未完全就绪，部分工具会降级', results);
      }
      return kit;
    })();
  }
  return kitPromise;
}

/* ============================================================
 * Canvas 几何工具（与后端 imageops.py 语义对齐）
 * ============================================================ */
function canvasFromImage(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

function cropCanvas(src, op) {
  const x = Math.max(0, Math.round(op.x || 0));
  const y = Math.max(0, Math.round(op.y || 0));
  const width = Math.max(1, Math.min(src.width - x, Math.round(op.width || src.width)));
  const height = Math.max(1, Math.min(src.height - y, Math.round(op.height || src.height)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(src, x, y, width, height, 0, 0, width, height);
  return canvas;
}

function rotateCanvas(src, angleDeg) {
  const angle = ((Number(angleDeg) || 0) % 360 + 360) % 360;
  if (!angle) return src;
  const rad = (angle * Math.PI) / 180;
  const width = src.width;
  const height = src.height;
  const outW = Math.ceil(Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad)));
  const outH = Math.ceil(Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad)));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(-rad); // PIL rotate 正值为逆时针；canvas 顺时针为正，所以取负
  ctx.drawImage(src, -width / 2, -height / 2);
  return canvas;
}

function flipCanvas(src, horizontal, vertical) {
  if (!horizontal && !vertical) return src;
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(horizontal ? canvas.width : 0, vertical ? canvas.height : 0);
  ctx.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
  ctx.drawImage(src, 0, 0);
  return canvas;
}

/** 与服务端 `op_resize` 对齐的目标尺寸计算（用于前端预览）。 */
function resizeTargetSize(src, op) {
  const mode = op.mode || 'exact';
  if (mode === 'percent') {
    const percent = Number(op.percent) || 100;
    return [src.width * percent / 100, src.height * percent / 100];
  }
  if (mode === 'long_edge') {
    const edge = Number(op.long_edge) || Math.max(src.width, src.height);
    const scale = edge / Math.max(src.width, src.height);
    return [src.width * scale, src.height * scale];
  }
  if (mode === 'short_edge') {
    const edge = Number(op.short_edge) || Math.min(src.width, src.height);
    const scale = edge / Math.min(src.width, src.height);
    return [src.width * scale, src.height * scale];
  }
  if (mode === 'megapixels') {
    const megapixels = Number(op.megapixels) || (src.width * src.height) / 1e6;
    const scale = Math.sqrt((megapixels * 1e6) / (src.width * src.height));
    return [src.width * scale, src.height * scale];
  }
  const width = Number(op.width) || src.width;
  const height = Number(op.height) || src.height;
  if (op.keep_aspect === false) return [width, height];
  const scale = Math.min(width / src.width, height / src.height);
  return [src.width * scale, src.height * scale];
}

/** 前端预览用近似 Unsharp Mask；超大图跳过卷积，导出时仍由服务端执行。 */
function sharpenCanvas(src, amount) {
  const strength = Math.max(0, Math.min(200, Number(amount) || 0));
  if (strength <= 0) return src;
  const width = src.width;
  const height = src.height;
  if (width < 3 || height < 3 || width * height > 4_000_000) return src;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const base = new Uint8ClampedArray(data);
  const k = (strength / 200) * 0.8;
  const center = 1 + 4 * k;
  const stride = width * 4;
  for (let y = 1; y < height - 1; y += 1) {
    let i = y * stride + 4;
    for (let x = 1; x < width - 1; x += 1, i += 4) {
      for (let c = 0; c < 3; c += 1) {
        data[i + c] =
          center * base[i + c] -
          k * (base[i - 4 + c] + base[i + 4 + c] + base[i - stride + c] + base[i + stride + c]);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function resizeCanvasFit(src, op) {
  const isExact = !op.mode || op.mode === 'exact';
  let [rawWidth, rawHeight] = isExact
    ? [Number(op.width) || src.width, Number(op.height) || src.height]
    : resizeTargetSize(src, op);
  const snap = Number(op.snap) || 0;
  if (snap > 1) {
    rawWidth = Math.max(snap, Math.round(rawWidth / snap) * snap);
    rawHeight = Math.max(snap, Math.round(rawHeight / snap) * snap);
  }
  const width = Math.max(1, Math.round(rawWidth || src.width));
  const height = Math.max(1, Math.round(rawHeight || src.height));
  const fit = op.fit || 'contain';
  const filter = String(op.filter || 'lanczos').toLowerCase();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // 用 Canvas 的插值质量近似服务端重采样：nearest 关闭平滑，其余按滤镜分档
  ctx.imageSmoothingEnabled = filter !== 'nearest';
  ctx.imageSmoothingQuality =
    filter === 'bilinear' ? 'low' : filter === 'bicubic' ? 'medium' : 'high';
  if (fit === 'stretch') {
    ctx.drawImage(src, 0, 0, width, height);
    return sharpenCanvas(canvas, op.sharpen_after);
  }
  if (fit === 'cover') {
    const scale = Math.max(width / src.width, height / src.height);
    const sw = Math.round(src.width * scale);
    const sh = Math.round(src.height * scale);
    ctx.drawImage(src, 0, 0, src.width, src.height, Math.round((width - sw) / 2), Math.round((height - sh) / 2), sw, sh);
    return sharpenCanvas(canvas, op.sharpen_after);
  }
  const scale = Math.min(width / src.width, height / src.height);
  const sw = Math.max(1, Math.round(src.width * scale));
  const sh = Math.max(1, Math.round(src.height * scale));
  ctx.drawImage(src, 0, 0, src.width, src.height, Math.round((width - sw) / 2), Math.round((height - sh) / 2), sw, sh);
  return sharpenCanvas(canvas, op.sharpen_after);
}

function pad32Canvas(src) {
  const width = snapUp(src.width, 32);
  const height = snapUp(src.height, 32);
  if (width === src.width && height === src.height) return src;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const x = Math.floor((width - src.width) / 2);
  const y = Math.floor((height - src.height) / 2);
  ctx.drawImage(src, x, y);
  // 用边缘像素补满剩余区域（近似服务端 pad_mode=edge）
  if (x > 0) {
    ctx.drawImage(src, 0, 0, 1, src.height, 0, y, x, src.height);
  }
  if (width - src.width - x > 0) {
    ctx.drawImage(src, src.width - 1, 0, 1, src.height, x + src.width, y, width - src.width - x, src.height);
  }
  if (y > 0) {
    ctx.drawImage(canvas, 0, y, width, 1, 0, 0, width, y);
  }
  if (height - src.height - y > 0) {
    ctx.drawImage(canvas, 0, y + src.height - 1, width, 1, 0, y + src.height, width, height - src.height - y);
  }
  return canvas;
}

function applyOpsToCanvas(image, ops) {
  let canvas = canvasFromImage(image);
  for (const op of ops) {
    if (!op || !op.op) continue;
    if (op.op === 'crop') canvas = cropCanvas(canvas, op);
    else if (op.op === 'rotate') canvas = rotateCanvas(canvas, op.angle);
    else if (op.op === 'flip') canvas = flipCanvas(canvas, Boolean(op.horizontal), Boolean(op.vertical));
    else if (op.op === 'resize') canvas = resizeCanvasFit(canvas, op);
    else if (op.op === 'pad32') canvas = pad32Canvas(canvas);
    else if (op.op === 'adjust') continue; // 调色用 CSS filter 预览
  }
  return canvas;
}

function adjustFilterString(adjustOps, live) {
  let brightness = 1;
  let contrast = 1;
  let saturation = 1;
  let temperature = 0;
  for (const op of adjustOps) {
    brightness *= Number(op.brightness) || 1;
    contrast *= Number(op.contrast) || 1;
    saturation *= Number(op.saturation) || 1;
    temperature += Number(op.temperature) || 0;
  }
  if (live) {
    brightness *= live.brightness;
    contrast *= live.contrast;
    saturation *= live.saturation;
    temperature += live.temperature;
  }
  const parts = [
    `brightness(${Math.max(0.1, brightness).toFixed(3)})`,
    `contrast(${Math.max(0.1, contrast).toFixed(3)})`,
    `saturate(${Math.max(0, saturation).toFixed(3)})`,
  ];
  if (Math.abs(temperature) > 0.001) {
    const amount = Math.min(0.5, Math.abs(temperature) * 0.2);
    parts.push(`sepia(${amount.toFixed(3)})`);
    parts.push(`hue-rotate(${Math.round(temperature * -16)}deg)`);
  }
  return parts.join(' ');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function urlToDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载结果失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取结果图片失败'));
    reader.readAsDataURL(blob);
  });
}

/* ============================================================
 * 页面
 * ============================================================ */
export function createImageToolsPage(host) {
  let kit = null;
  let disposed = false;
  let sourceImage = null;
  let watermarkMarkImage = null;
  let watermarkPreviewRect = null;
  let watermarkPreviewStamp = { width: 0, height: 0 };
  let workCanvas = null;
  let renderToken = 0;
  let currentWorkDims = { width: 0, height: 0 };
  let drag = null;
  let resizeObserver = null;
  /* D18.3：工作画布缓存签名（源图 / 操作链 / 扩图结果），拖动选框时不再重算。 */
  let workKey = { source: null, count: -1, last: null, outpaint: null };
  /* D18.3：显示画布尺寸签名，只有变化时才重设 canvas.width/height。 */
  let displayStamp = { width: 0, height: 0, dpr: 0 };
  let overlayRaf = 0;
  const selectedResultIds = new Set();
  const toastRoot = document.getElementById('toast-root');
  toastRoot?.classList.add('tools-toast');

  const state = {
    source: null, // {dataUrl,name,width,height}
    stagedOps: [],
    crop: { rect: null, ratioLabel: 'Free', grid: false, rows: 2, columns: 2, rowGap: 0, columnGap: 0 },
    adjust: { ...NEUTRAL_ADJUST },
    resize: { width: 0, height: 0, lock: true, fit: 'contain' },
    format: 'png',
    quality: 92,
    outpaint: { direction: 'right', amount: 0.5, panoramaAspect: '', active: false, result: null, busy: false },
    upscale: { models: null, engine: '', scale: 2, jobId: '', polling: false, touchedScale: false },
    results: [],
    tool: 'adjust',
    watermark: {
      kind: 'text',
      text: '© 2026 Studio',
      font: '',
      color: '#ffffff',
      opacity: 55,
      scale: 6,
      rotation: 0,
      position: 'bottom-right',
      x: 0.5,
      y: 0.5,
      margin: 3,
      tile: false,
      gapX: 20,
      gapY: 12,
      tileAngle: -24,
      strokeWidth: 0,
      strokeColor: '#000000',
      shadow: true,
      markData: '',
      markName: '',
      fonts: [],
      busy: false,
    },
    gif: {
      source: 'images',
      frames: [],
      video: null,
      duration: 120,
      fps: 12,
      width: 720,
      mode: 'forward',
      loop: 0,
      start: 0,
      end: 0,
      busy: false,
      jobId: '',
      uploading: false,
      status: '',
      percent: 0,
    },
    tagger: {
      models: null,
      model: '',
      threshold: 0.35,
      characterThreshold: 0.85,
      busy: false,
      result: null,
    },
  };

  host.innerHTML = `
    <div class="page page-tools">
      <div class="tools-layout">
        <nav class="tools-rail" data-ref="toolRail" aria-label="图像处理工具" role="tablist" aria-orientation="vertical">
          <button class="tools-rail-btn active" type="button" data-tool-group="adjust" id="tool-tab-adjust" role="tab" aria-selected="true" aria-controls="tool-panel" tabindex="0" title="调整">
            ${toolIcon('adjust')}<span class="lbl">调整</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="size" id="tool-tab-size" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="尺寸">
            ${toolIcon('size')}<span class="lbl">尺寸</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="watermark" id="tool-tab-watermark" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="水印">
            ${toolIcon('watermark')}<span class="lbl">水印</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="gif" id="tool-tab-gif" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="动图">
            ${toolIcon('gif')}<span class="lbl">动图</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="upscale" id="tool-tab-upscale" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="放大">
            ${toolIcon('upscale')}<span class="lbl">放大</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="export" id="tool-tab-export" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="导出">
            ${toolIcon('export')}<span class="lbl">导出</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="outpaint" id="tool-tab-outpaint" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="扩图">
            ${toolIcon('outpaint')}<span class="lbl">扩图</span>
          </button>
          <button class="tools-rail-btn" type="button" data-tool-group="tagger" id="tool-tab-tagger" role="tab" aria-selected="false" aria-controls="tool-panel" tabindex="-1" title="反推">
            ${toolIcon('tagger')}<span class="lbl">反推</span>
          </button>
        </nav>

        <aside class="tools-inspector">
          <div class="tools-inspector-scroll" data-ref="inspectorScroll">
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">源图 <span class="panel-sub" data-ref="sourceSub">上传后开始处理</span></div>
              <div class="panel-actions">
                <button class="btn ghost sm" type="button" data-ref="newSource">换一张</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="dropzone tools-drop" data-ref="dropzone" role="button" tabindex="0">
                <div class="glyph">⬆</div>
                <div>拖拽图片到这里，或点击选择</div>
                <small>PNG / JPG / WebP；像素越大处理越慢</small>
              </div>
              <input type="file" accept="image/*" hidden data-ref="fileInput" aria-label="选择要处理的图片" />
              <div class="row tools-import">
                <button class="btn ghost sm" type="button" data-ref="importMaterials">素材仓库</button>
                <button class="btn ghost sm" type="button" data-ref="importRecent">最近结果</button>
                <button class="btn ghost sm" type="button" data-ref="importPaste">剪贴板</button>
              </div>
              <div class="source-meta" data-ref="sourceMeta">
                <span class="dim">尚未选择图片</span>
              </div>
            </div>
          </section>

          <section class="panel" id="tool-panel" role="tabpanel" aria-labelledby="tool-tab-adjust" tabindex="0">
            <div class="panel-head"><div class="panel-title">工具 <span class="panel-sub">即时预览 · 可撤销</span></div></div>
            <div class="panel-body tool-stack">
              <details class="fold tool-fold" data-group="adjust" data-section="crop" open>
                <summary>裁剪 / 宫格</summary>
                <div class="fold-body">
                  <div class="field">
                    <span class="field-label">比例</span>
                    <div class="chips tool-ratios" data-ref="ratios"></div>
                  </div>
                  <div class="grid-2">
                    <button class="btn primary sm" type="button" data-ref="cropApply">应用裁剪</button>
                    <button class="btn ghost sm" type="button" data-ref="cropReset">重置选框</button>
                  </div>
                  <div class="size-summary"><span>裁剪输出</span><span class="mono" data-ref="cropSize">—</span></div>
                  <label class="switch">
                    <input type="checkbox" data-ref="gridEnabled" />
                    <span class="switch-track"></span>
                    <span class="switch-label">宫格切分<small>一次输出多张（最多 64 块）</small></span>
                  </label>
                  <div class="grid-2 hidden" data-ref="gridOptions">
                    <label class="field"><span class="field-label">行数</span><input class="input mono" type="number" min="1" max="10" step="1" value="2" data-ref="gridRows" /></label>
                    <label class="field"><span class="field-label">列数</span><input class="input mono" type="number" min="1" max="10" step="1" value="2" data-ref="gridColumns" /></label>
                    <label class="field"><span class="field-label">行间距 px</span><input class="input mono" type="number" min="0" max="200" step="1" value="0" data-ref="gridRowGap" /></label>
                    <label class="field"><span class="field-label">列间距 px</span><input class="input mono" type="number" min="0" max="200" step="1" value="0" data-ref="gridColumnGap" /></label>
                  </div>
                  <button class="btn ghost sm block" type="button" data-ref="gridApply">宫格切分并保存</button>
                </div>
              </details>

              <details class="fold tool-fold" data-group="adjust" data-section="rotate">
                <summary>旋转 / 翻转</summary>
                <div class="fold-body">
                  <div class="chips">
                    <button class="chip" type="button" data-rotate="90">↺ 逆时针 90°</button>
                    <button class="chip" type="button" data-rotate="-90">↻ 顺时针 90°</button>
                    <button class="chip" type="button" data-flip="h">⇋ 水平翻转</button>
                    <button class="chip" type="button" data-flip="v">⇅ 垂直翻转</button>
                  </div>
                  <div class="field-row">
                    <input class="input mono" type="number" min="-180" max="180" step="1" value="0" data-ref="rotateAngle" placeholder="任意角度" />
                    <button class="btn ghost sm" type="button" data-ref="rotateApply">应用角度</button>
                  </div>
                  <div class="field-hint">角度以逆时针为正；任意旋转会扩展画布以保留四角。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="size">
                <summary>缩放 / 对齐 32</summary>
                <div class="fold-body">
                  <div class="grid-2">
                    <label class="field"><span class="field-label">宽度 px</span><input class="input mono" type="number" min="1" max="8192" step="1" data-ref="resizeWidth" /></label>
                    <label class="field"><span class="field-label">高度 px</span><input class="input mono" type="number" min="1" max="8192" step="1" data-ref="resizeHeight" /></label>
                  </div>
                  <label class="switch">
                    <input type="checkbox" data-ref="resizeLock" checked />
                    <span class="switch-track"></span>
                    <span class="switch-label">锁定比例<small>修改一边时同步另一边</small></span>
                  </label>
                  <label class="field">
                    <span class="field-label">缩放方式</span>
                    <select class="select" data-ref="resizeMode">
                      <option value="exact">精确宽高</option>
                      <option value="percent">按百分比</option>
                      <option value="long_edge">按长边</option>
                      <option value="short_edge">按短边</option>
                      <option value="megapixels">按百万像素</option>
                    </select>
                  </label>
                  <label class="field hidden" data-ref="resizeModeField">
                    <span class="field-label" data-ref="resizeModeLabel">百分比 %</span>
                    <input class="input mono" type="number" min="1" step="1" value="100" data-ref="resizeModeValue" />
                  </label>
                  <details class="tool-subfold">
                    <summary>高级参数 <span class="subfold-tip" data-ref="resizeAdvancedTip">Lanczos · contain</span></summary>
                    <div class="subfold-body">
                      <label class="field">
                        <span class="field-label">宽高不匹配时</span>
                        <select class="select" data-ref="resizeFit">
                          <option value="contain">contain 等比缩放 + 补边</option>
                          <option value="cover">cover 等比缩放 + 居中裁切</option>
                          <option value="stretch">stretch 拉伸铺满</option>
                        </select>
                      </label>
                      <label class="field">
                        <span class="field-label">重采样算法</span>
                        <select class="select" data-ref="resizeFilter">
                          <option value="lanczos">Lanczos（默认，最清晰）</option>
                          <option value="bicubic">Bicubic（平滑）</option>
                          <option value="bilinear">Bilinear（轻量）</option>
                          <option value="nearest">Nearest（像素风 / 硬边）</option>
                          <option value="box">Box（缩小时平均）</option>
                        </select>
                      </label>
                      <div class="grid-2">
                        <label class="field">
                          <span class="field-label">对齐倍数</span>
                          <input class="input mono" type="number" min="0" max="256" step="1" value="0" data-ref="resizeSnap" />
                        </label>
                        <label class="field">
                          <span class="field-label">缩放后锐化 <span class="tag-hint" data-ref="resizeSharpenVal">0</span></span>
                          <input class="range" type="range" min="0" max="200" step="5" value="0" data-ref="resizeSharpen" />
                        </label>
                      </div>
                    </div>
                  </details>
                  <div class="resize-target" data-ref="resizeTarget" aria-live="polite">
                    <div class="resize-target-line">
                      <span class="resize-target-label">当前</span>
                      <span class="mono" data-ref="resizeFrom">—</span>
                      <span class="resize-target-arrow" aria-hidden="true">→</span>
                      <span class="resize-target-label">输出</span>
                      <span class="mono strong" data-ref="resizeTo">—</span>
                    </div>
                    <div class="resize-target-meta" data-ref="resizeMeta">上传图片后可查看缩放结果</div>
                  </div>
                  <div class="field-hint" data-ref="resizeHint">—</div>
                  <div class="row">
                    <button class="btn primary sm" type="button" data-ref="resizeApply">应用缩放</button>
                    <button class="btn ghost sm" type="button" data-ref="pad32Apply">对齐 32</button>
                  </div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="adjust" data-section="color">
                <summary>调色</summary>
                <div class="fold-body">
                  <div class="adjust-list" data-ref="adjustList"></div>
                  <div class="row">
                    <button class="btn primary sm" type="button" data-ref="adjustApply">应用调色</button>
                    <button class="btn ghost sm" type="button" data-ref="adjustReset">重置滑杆</button>
                  </div>
                  <div class="field-hint">滑杆为 CSS filter 实时近似预览；落盘时由后端按真实参数处理（锐化只有落盘后可见）。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="export">
                <summary>格式导出</summary>
                <div class="fold-body">
                  <label class="field">
                    <span class="field-label">格式</span>
                    <select class="select" data-ref="format">
                      <option value="png">PNG（无损，可透明）</option>
                      <option value="jpeg">JPEG（体积小，无透明）</option>
                      <option value="webp">WebP（小体积，可透明）</option>
                    </select>
                  </label>
                  <label class="field" data-ref="qualityField">
                    <span class="field-label">质量 <span class="tag-hint" data-ref="qualityVal">92</span></span>
                    <input class="range" type="range" min="30" max="100" step="1" value="92" data-ref="quality" />
                  </label>
                  <label class="switch hidden" data-ref="losslessField">
                    <input type="checkbox" data-ref="lossless" />
                    <span class="switch-track"></span>
                    <span class="switch-label">WebP 无损<small>体积更大，画质完全保留</small></span>
                  </label>
                  <label class="field">
                    <span class="field-label">目标体积 KB <span class="tag-hint">可选，留空按质量</span></span>
                    <input class="input mono" type="number" min="32" max="51200" step="32" data-ref="targetKb" placeholder="例如 800" />
                  </label>
                  <label class="field hidden" data-ref="bgField">
                    <span class="field-label">JPEG 透明区铺底</span>
                    <input class="input" type="color" value="#ffffff" data-ref="exportBg" />
                  </label>
                  <div class="size-summary"><span>预计体积</span><span class="mono" data-ref="estimate">—</span></div>
                  <div class="field-hint hidden" data-ref="exportPending"></div>
                  <button class="btn primary block" type="button" data-ref="processApply">处理并保存</button>
                </div>
              </details>

              <details class="fold tool-fold" data-group="outpaint">
                <summary>扩图</summary>
                <div class="fold-body">
                  <div class="field">
                    <span class="field-label">全景比例 <span class="tag-hint">自动算方向与幅度</span></span>
                    <div class="chips" data-ref="outpaintPano">
                      <button class="chip active" type="button" data-pano="">不限</button>
                      ${['2:1', '3:1', '4:1', '21:9'].map(
                        (aspect) =>
                          `<button class="chip" type="button" data-pano="${aspect}">${aspect}</button>`,
                      ).join('')}
                    </div>
                  </div>
                  <div class="chips" data-ref="outpaintDirs">
                    ${OUTPAINT_DIRECTIONS.map(
                      (direction) =>
                        `<button class="chip ${direction === 'right' ? 'active' : ''}" type="button" data-dir="${direction}">${escapeHtml(
                          OUTPAINT_DIRECTION_LABELS[direction],
                        )}</button>`,
                    ).join('')}
                  </div>
                  <label class="field">
                    <span class="field-label">扩展幅度 <span class="tag-hint" data-ref="outpaintAmountVal">50%</span></span>
                    <input class="range" type="range" min="10" max="200" step="5" value="50" data-ref="outpaintAmount" />
                  </label>
                  <div class="row">
                    <button class="btn ghost sm" type="button" data-ref="outpaintPlan">规划扩图</button>
                    <button class="btn primary sm" type="button" data-ref="outpaintGo" disabled>去局部重绘</button>
                    <button class="btn ghost sm hidden" type="button" data-ref="outpaintCancel">取消预览</button>
                  </div>
                  <div class="field-hint" data-ref="outpaintSummary">规划后显示新画布尺寸与新增区域；「去局部重绘」会跳到图像编辑并自动带好画布与遮罩。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="upscale">
                <summary>高清放大 <span class="tag-hint">SeedVR2 / FlashVSR / VOSR2</span></summary>
                <div class="fold-body">
                  <div class="field">
                    <span class="field-label">放大引擎</span>
                    <div class="chips" data-ref="upscaleEngines">
                      <span class="field-hint" data-ref="upscaleEnginesHint">正在读取模型…</span>
                    </div>
                  </div>
                  <div class="field">
                    <span class="field-label">倍率</span>
                    <div class="chips" data-ref="upscaleScales">
                      <button class="chip active" type="button" data-scale="2">2×</button>
                      <button class="chip" type="button" data-scale="4">4×</button>
                    </div>
                  </div>
                  <div class="upscale-progress hidden" data-ref="upscaleProgress">
                    <div class="upscale-bar"><span data-ref="upscaleBar"></span></div>
                    <div class="field-hint mono" data-ref="upscaleStatus">排队中…</div>
                  </div>
                  <div class="row">
                    <button class="btn primary sm" type="button" data-ref="upscaleGo" disabled>开始放大</button>
                    <button class="btn ghost sm hidden" type="button" data-ref="upscaleCancel">取消</button>
                    <button class="btn ghost sm" type="button" data-ref="upscaleCompare" disabled>图像对比</button>
                  </div>
                  <div class="field-hint" data-ref="upscaleHint">放大走后台任务队列：SeedVR2 单图质量优先，FlashVSR 更快，VOSR2 单步细节恢复。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="tagger">
                <summary>反推提示词 <span class="tag-hint">WD14 / Danbooru</span></summary>
                <div class="fold-body">
                  <label class="field">
                    <span class="field-label">模型</span>
                    <select class="select" data-ref="taggerModel">
                      <option value="">正在读取模型…</option>
                    </select>
                  </label>
                  <div class="grid-2">
                    <label class="field">
                      <span class="field-label">通用阈值 <span class="tag-hint" data-ref="taggerThresholdVal">0.35</span></span>
                      <input class="range" type="range" min="0" max="1" step="0.01" value="0.35" data-ref="taggerThreshold" />
                    </label>
                    <label class="field">
                      <span class="field-label">角色阈值 <span class="tag-hint" data-ref="taggerCharThresholdVal">0.85</span></span>
                      <input class="range" type="range" min="0" max="1" step="0.01" value="0.85" data-ref="taggerCharThreshold" />
                    </label>
                  </div>
                  <label class="field">
                    <span class="field-label">排除标签</span>
                    <input class="input" type="text" placeholder="英文逗号分隔，如 watermark, text" data-ref="taggerExclude" />
                  </label>
                  <label class="switch">
                    <input type="checkbox" data-ref="taggerReplace" />
                    <span class="switch-track"></span>
                    <span class="switch-label">下划线转空格<small>long_hair → long hair</small></span>
                  </label>
                  <label class="switch">
                    <input type="checkbox" data-ref="taggerTrailing" />
                    <span class="switch-track"></span>
                    <span class="switch-label">末尾逗号<small>方便继续拼接提示词</small></span>
                  </label>
                  <div class="row">
                    <button class="btn primary sm" type="button" data-ref="taggerGo" disabled>反推标签</button>
                    <button class="btn ghost sm" type="button" data-ref="taggerCopy" disabled>复制</button>
                  </div>
                  <textarea class="input mono" rows="4" readonly placeholder="识别结果会出现在这里" aria-label="反推标签结果" data-ref="taggerResult"></textarea>
                  <div class="row hidden" data-ref="taggerActions">
                    <button class="btn ghost sm" type="button" data-ref="taggerToT2i">→ 文生图</button>
                    <button class="btn ghost sm" type="button" data-ref="taggerToEdit">→ 图像编辑</button>
                  </div>
                  <div class="field-hint" data-ref="taggerStatus">首次使用会自动下载所选模型（约 300MB～1GB），请保持网络畅通。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="watermark">
                <summary>水印 <span class="tag-hint">文字 / 图片</span></summary>
                <div class="fold-body">
                  <div class="chips" data-ref="wmKinds">
                    <button class="chip active" type="button" data-wm-kind="text">文字水印</button>
                    <button class="chip" type="button" data-wm-kind="image">图片水印</button>
                  </div>
                  <div data-ref="wmTextFields">
                    <label class="field"><span class="field-label">水印文字</span><input class="input" type="text" value="© 2026 Studio" placeholder="输入水印文字，例如 © 2026 Studio" data-ref="wmText" /></label>
                    <label class="field"><span class="field-label">字体</span><select class="select" data-ref="wmFont"></select></label>
                  </div>
                  <div class="hidden" data-ref="wmImageFields">
                    <input type="file" accept="image/*" hidden data-ref="wmMarkInput" aria-label="选择图片水印" />
                    <div class="field-label">水印图片</div>
                    <button class="btn ghost sm block" type="button" data-ref="wmMarkPick">选择 PNG logo（推荐透明背景）</button>
                    <div class="field-hint" data-ref="wmMarkName">未选择图片</div>
                  </div>
                  <div class="grid-2">
                    <label class="field"><span class="field-label">颜色</span><input class="input" type="color" value="#ffffff" data-ref="wmColor" /></label>
                    <label class="field"><span class="field-label">位置</span><select class="select" data-ref="wmPosition">
                      <option value="top-left">左上</option>
                      <option value="top">上中</option>
                      <option value="top-right">右上</option>
                      <option value="left">左中</option>
                      <option value="center">居中</option>
                      <option value="right">右中</option>
                      <option value="bottom-left">左下</option>
                      <option value="bottom">下中</option>
                      <option value="bottom-right" selected>右下</option>
                      <option value="custom">自定义（画布拖动）</option>
                    </select></label>
                  </div>
                  <div class="field-hint">位置选「自定义」后可在画布上拖动水印；方向键微调 1px，Shift 10px。</div>
                  <label class="field"><span class="field-label">不透明度 <span class="tag-hint" data-ref="wmOpacityVal">55%</span></span><input class="range" type="range" min="5" max="100" value="55" data-ref="wmOpacity" /></label>
                  <div class="grid-2">
                    <label class="field"><span class="field-label">大小 <span class="tag-hint" data-ref="wmScaleVal">6%</span></span><input class="range" type="range" min="1" max="20" value="6" data-ref="wmScale" /></label>
                    <label class="field"><span class="field-label">旋转°</span><input class="input mono" type="number" min="-180" max="180" step="1" value="0" data-ref="wmRotation" /></label>
                    <label class="field"><span class="field-label">边距 <span class="tag-hint" data-ref="wmMarginVal">3%</span></span><input class="range" type="range" min="0" max="20" value="3" data-ref="wmMargin" /></label>
                    <label class="field"><span class="field-label">描边 <span class="tag-hint" data-ref="wmStrokeVal">0</span></span><input class="range" type="range" min="0" max="5" step="1" value="0" data-ref="wmStroke" /></label>
                  </div>
                  <label class="switch">
                    <input type="checkbox" checked data-ref="wmShadow" />
                    <span class="switch-track"></span>
                    <span class="switch-label">柔和阴影<small>深底上更清晰</small></span>
                  </label>
                  <label class="switch">
                    <input type="checkbox" data-ref="wmTile" />
                    <span class="switch-track"></span>
                    <span class="switch-label">平铺防盗<small>覆盖全图</small></span>
                  </label>
                  <div class="grid-2 hidden" data-ref="wmTileFields">
                    <label class="field"><span class="field-label">横向间距 <span class="tag-hint" data-ref="wmGapXVal">20%</span></span><input class="range" type="range" min="5" max="60" value="20" data-ref="wmGapX" /></label>
                    <label class="field"><span class="field-label">纵向间距 <span class="tag-hint" data-ref="wmGapYVal">12%</span></span><input class="range" type="range" min="5" max="60" value="12" data-ref="wmGapY" /></label>
                    <label class="field"><span class="field-label">平铺角度</span><input class="input mono" type="number" min="-90" max="90" step="1" value="-24" data-ref="wmTileAngle" /></label>
                  </div>
                  <div class="row">
                    <button class="btn ghost sm" type="button" data-ref="wmPreview">服务端预览</button>
                    <button class="btn primary sm" type="button" data-ref="wmApply">应用水印</button>
                  </div>
                  <div class="wm-preview hidden" data-ref="wmPreviewBox">
                    <img alt="水印预览" data-ref="wmPreviewImg" />
                  </div>
                  <div class="field-hint" data-ref="wmHint">「服务端预览」与最终落盘一致；应用后结果进入右侧「结果」。</div>
                </div>
              </details>

              <details class="fold tool-fold" data-group="gif">
                <summary>动图 GIF <span class="tag-hint">图片序列 / 视频</span></summary>
                <div class="fold-body">
                  <div class="chips" data-ref="gifSources">
                    <button class="chip active" type="button" data-gif-source="images">图片序列</button>
                    <button class="chip" type="button" data-gif-source="video">视频截取</button>
                  </div>
                  <div data-ref="gifImageFields">
                    <input type="file" accept="image/*" multiple hidden data-ref="gifFrameInput" aria-label="选择 GIF 帧图片" />
                    <div class="row">
                      <button class="btn ghost sm" type="button" data-ref="gifAddFrames">添加帧</button>
                      <button class="btn ghost sm" type="button" data-ref="gifAddSource">当前源图入帧</button>
                    </div>
                    <div class="chips gif-frames" data-ref="gifFrames"></div>
                    <div class="grid-2">
                      <label class="field"><span class="field-label">每帧毫秒</span><input class="input mono" type="number" min="20" max="2000" step="10" value="120" data-ref="gifDuration" /></label>
                      <label class="field"><span class="field-label">宽度 px</span><input class="input mono" type="number" min="64" max="1600" step="8" value="720" data-ref="gifWidth" /></label>
                    </div>
                  </div>
                  <div class="hidden" data-ref="gifVideoFields">
                    <input type="file" accept="video/*" hidden data-ref="gifVideoInput" aria-label="选择 GIF 视频" />
                    <button class="btn ghost sm block" type="button" data-ref="gifVideoPick">选择视频（≤512MB）</button>
                    <div class="field-hint" data-ref="gifVideoInfo">支持 mp4 / mov / webm / mkv / avi</div>
                    <div class="grid-2">
                      <label class="field"><span class="field-label">起点秒</span><input class="input mono" type="number" min="0" step="0.1" value="0" data-ref="gifStart" /></label>
                      <label class="field"><span class="field-label">终点秒</span><input class="input mono" type="number" min="0" step="0.1" value="0" data-ref="gifEnd" /></label>
                      <label class="field"><span class="field-label">帧率 fps</span><input class="input mono" type="number" min="5" max="30" step="1" value="12" data-ref="gifFps" /></label>
                      <label class="field"><span class="field-label">宽度 px</span><input class="input mono" type="number" min="64" max="1600" step="8" value="720" data-ref="gifVideoWidth" /></label>
                    </div>
                  </div>
                  <label class="field"><span class="field-label">播放方式</span><select class="select" data-ref="gifMode">
                    <option value="forward">正向</option>
                    <option value="reverse">倒放</option>
                    <option value="boomerang">往返</option>
                  </select></label>
                  <div class="upscale-progress hidden" data-ref="gifProgress">
                    <div class="upscale-bar"><span data-ref="gifBar"></span></div>
                    <div class="field-hint mono" data-ref="gifStatus">排队中…</div>
                  </div>
                  <div class="row">
                    <button class="btn primary sm" type="button" data-ref="gifGo">生成 GIF</button>
                    <button class="btn ghost sm hidden" type="button" data-ref="gifCancel">取消</button>
                  </div>
                  <button class="btn ghost sm block" type="button" data-ref="gifSplit">把当前 GIF 拆帧</button>
                  <div class="field-hint" data-ref="gifHint">图片序列与视频都会自动统一调色；结果进入右侧「结果」。</div>
                </div>
              </details>

              <button class="btn ghost block" type="button" data-ref="sendEdit">→ 送入图像编辑</button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><div class="panel-title">处理提示</div></div>
            <div class="panel-body tight">
              <div class="field-hint">· 处理结果会保存到作品历史，并出现在底部「结果」胶片条里。</div>
              <div class="field-hint">· 胶片条单击选中，可批量收藏 / 送入编辑 / 导出 / 加入 GIF；双击查看大图。</div>
              <div class="field-hint">· 扩图「去局部重绘」会自动生成遮罩，只需补一句编辑指令。</div>
              <div class="field-hint">· PNG 会保留透明区域；JPEG 无透明，需要先选择铺底色。</div>
            </div>
          </section>
          </div>

          <div class="tools-actionbar" data-ref="actionBar">
            <div class="tools-actionbar-hint" data-ref="actionHint">选择工具后在这里执行</div>
            <div class="tools-actionbar-row">
              <button class="btn ghost" type="button" data-ref="actionSecondary" disabled>—</button>
              <button class="btn primary" type="button" data-ref="actionPrimary" disabled>—</button>
            </div>
          </div>
        </aside>

        <main class="tools-main">
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">画布 <span class="panel-sub" data-ref="stageSub">上传图片开始</span></div>
              <div class="panel-actions">
                <button class="btn ghost sm" type="button" data-ref="stageCompare" disabled>对比</button>
                <button class="btn ghost sm" type="button" data-ref="undo">↶ 撤销</button>
                <button class="btn ghost sm" type="button" data-ref="resetAll">重置</button>
                <button class="btn ghost sm tools-quick-export" type="button" data-ref="quickExport" disabled>导出</button>
              </div>
            </div>
            <div class="tool-stage" data-ref="stage">
              <div class="tool-stage-inner" data-ref="stageInner">
                <canvas class="tool-canvas" data-ref="imageCanvas"></canvas>
                <canvas class="tool-canvas tool-overlay" data-ref="overlayCanvas" tabindex="0"></canvas>
              </div>
              <div class="tool-stage-empty" data-ref="stageEmpty">
                <div class="glyph">◫</div>
                <div>上传一张图片开始处理</div>
                <small>支持拖拽到画布区域</small>
              </div>
              <div class="tool-stage-status" data-ref="stageStatus">—</div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">操作史 <span class="panel-sub" data-ref="opsCount">0 步</span></div>
              <div class="panel-actions"><span class="panel-sub">点击某一步可回退到那里</span></div>
            </div>
            <div class="panel-body tight">
              <div class="ops-list" data-ref="opsList"></div>
            </div>
          </section>
        </main>

        <section class="panel tools-filmstrip">
          <div class="panel-head">
            <div class="panel-title">
              结果
              <span class="panel-sub" data-ref="resultCount" aria-live="polite">0 张</span>
              <span class="panel-sub" data-ref="filmSelected">未选择</span>
            </div>
            <div class="panel-actions tools-film-actions">
              <button class="btn ghost sm" type="button" data-ref="filmSelectAll">全选</button>
              <button class="btn ghost sm" type="button" data-ref="filmClearSelect">取消选择</button>
              <button class="btn ghost sm" type="button" data-ref="filmFavorite">收藏</button>
              <button class="btn ghost sm" type="button" data-ref="filmToEdit">送入编辑</button>
              <button class="btn ghost sm" type="button" data-ref="filmExport">导出</button>
              <button class="btn ghost sm" type="button" data-ref="filmToGif">加入 GIF</button>
              <button class="btn ghost sm" type="button" data-ref="clearResults">清空</button>
            </div>
          </div>
          <div class="panel-body tight">
            <div class="tool-results" data-ref="results" role="listbox" aria-multiselectable="true"></div>
          </div>
        </section>
      </div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    dropzone: ref('dropzone'),
    fileInput: ref('fileInput'),
    newSource: ref('newSource'),
    sourceMeta: ref('sourceMeta'),
    sourceSub: ref('sourceSub'),
    inspectorScroll: ref('inspectorScroll'),
    actionBar: ref('actionBar'),
    actionHint: ref('actionHint'),
    actionSecondary: ref('actionSecondary'),
    actionPrimary: ref('actionPrimary'),
    importMaterials: ref('importMaterials'),
    importRecent: ref('importRecent'),
    importPaste: ref('importPaste'),
    ratios: ref('ratios'),
    cropApply: ref('cropApply'),
    cropReset: ref('cropReset'),
    cropSize: ref('cropSize'),
    gridEnabled: ref('gridEnabled'),
    gridOptions: ref('gridOptions'),
    gridRows: ref('gridRows'),
    gridColumns: ref('gridColumns'),
    gridRowGap: ref('gridRowGap'),
    gridColumnGap: ref('gridColumnGap'),
    gridApply: ref('gridApply'),
    rotateAngle: ref('rotateAngle'),
    rotateApply: ref('rotateApply'),
    resizeWidth: ref('resizeWidth'),
    resizeHeight: ref('resizeHeight'),
    resizeLock: ref('resizeLock'),
    resizeFit: ref('resizeFit'),
    resizeApply: ref('resizeApply'),
    pad32Apply: ref('pad32Apply'),
    resizeHint: ref('resizeHint'),
    toolRail: ref('toolRail'),
    resizeMode: ref('resizeMode'),
    resizeModeField: ref('resizeModeField'),
    resizeModeLabel: ref('resizeModeLabel'),
    resizeModeValue: ref('resizeModeValue'),
    resizeFilter: ref('resizeFilter'),
    resizeSnap: ref('resizeSnap'),
    resizeSharpen: ref('resizeSharpen'),
    resizeSharpenVal: ref('resizeSharpenVal'),
    resizeFrom: ref('resizeFrom'),
    resizeTo: ref('resizeTo'),
    resizeMeta: ref('resizeMeta'),
    resizeAdvancedTip: ref('resizeAdvancedTip'),
    losslessField: ref('losslessField'),
    lossless: ref('lossless'),
    targetKb: ref('targetKb'),
    bgField: ref('bgField'),
    exportBg: ref('exportBg'),
    wmKinds: ref('wmKinds'),
    wmTextFields: ref('wmTextFields'),
    wmImageFields: ref('wmImageFields'),
    wmText: ref('wmText'),
    wmFont: ref('wmFont'),
    wmMarkInput: ref('wmMarkInput'),
    wmMarkPick: ref('wmMarkPick'),
    wmMarkName: ref('wmMarkName'),
    wmColor: ref('wmColor'),
    wmPosition: ref('wmPosition'),
    wmOpacity: ref('wmOpacity'),
    wmOpacityVal: ref('wmOpacityVal'),
    wmScale: ref('wmScale'),
    wmScaleVal: ref('wmScaleVal'),
    wmRotation: ref('wmRotation'),
    wmMargin: ref('wmMargin'),
    wmMarginVal: ref('wmMarginVal'),
    wmStroke: ref('wmStroke'),
    wmStrokeVal: ref('wmStrokeVal'),
    wmShadow: ref('wmShadow'),
    wmTile: ref('wmTile'),
    wmTileFields: ref('wmTileFields'),
    wmGapX: ref('wmGapX'),
    wmGapXVal: ref('wmGapXVal'),
    wmGapY: ref('wmGapY'),
    wmGapYVal: ref('wmGapYVal'),
    wmTileAngle: ref('wmTileAngle'),
    wmPreview: ref('wmPreview'),
    wmApply: ref('wmApply'),
    wmPreviewBox: ref('wmPreviewBox'),
    wmPreviewImg: ref('wmPreviewImg'),
    wmHint: ref('wmHint'),
    gifSources: ref('gifSources'),
    gifImageFields: ref('gifImageFields'),
    gifVideoFields: ref('gifVideoFields'),
    gifFrameInput: ref('gifFrameInput'),
    gifAddFrames: ref('gifAddFrames'),
    gifAddSource: ref('gifAddSource'),
    gifFrames: ref('gifFrames'),
    gifDuration: ref('gifDuration'),
    gifWidth: ref('gifWidth'),
    gifVideoInput: ref('gifVideoInput'),
    gifVideoPick: ref('gifVideoPick'),
    gifVideoInfo: ref('gifVideoInfo'),
    gifStart: ref('gifStart'),
    gifEnd: ref('gifEnd'),
    gifFps: ref('gifFps'),
    gifVideoWidth: ref('gifVideoWidth'),
    gifMode: ref('gifMode'),
    gifProgress: ref('gifProgress'),
    gifBar: ref('gifBar'),
    gifStatus: ref('gifStatus'),
    gifGo: ref('gifGo'),
    gifCancel: ref('gifCancel'),
    gifSplit: ref('gifSplit'),
    gifHint: ref('gifHint'),
    adjustList: ref('adjustList'),
    adjustApply: ref('adjustApply'),
    adjustReset: ref('adjustReset'),
    format: ref('format'),
    quality: ref('quality'),
    qualityVal: ref('qualityVal'),
    qualityField: ref('qualityField'),
    estimate: ref('estimate'),
    exportPending: ref('exportPending'),
    processApply: ref('processApply'),
    outpaintDirs: ref('outpaintDirs'),
    outpaintPano: ref('outpaintPano'),
    outpaintAmount: ref('outpaintAmount'),
    outpaintAmountVal: ref('outpaintAmountVal'),
    outpaintPlan: ref('outpaintPlan'),
    outpaintGo: ref('outpaintGo'),
    outpaintCancel: ref('outpaintCancel'),
    outpaintSummary: ref('outpaintSummary'),
    upscaleEngines: ref('upscaleEngines'),
    upscaleEnginesHint: ref('upscaleEnginesHint'),
    upscaleScales: ref('upscaleScales'),
    upscaleProgress: ref('upscaleProgress'),
    upscaleBar: ref('upscaleBar'),
    upscaleStatus: ref('upscaleStatus'),
    upscaleGo: ref('upscaleGo'),
    upscaleCancel: ref('upscaleCancel'),
    upscaleHint: ref('upscaleHint'),
    upscaleCompare: ref('upscaleCompare'),
    taggerModel: ref('taggerModel'),
    taggerThreshold: ref('taggerThreshold'),
    taggerThresholdVal: ref('taggerThresholdVal'),
    taggerCharThreshold: ref('taggerCharThreshold'),
    taggerCharThresholdVal: ref('taggerCharThresholdVal'),
    taggerExclude: ref('taggerExclude'),
    taggerReplace: ref('taggerReplace'),
    taggerTrailing: ref('taggerTrailing'),
    taggerGo: ref('taggerGo'),
    taggerCopy: ref('taggerCopy'),
    taggerResult: ref('taggerResult'),
    taggerActions: ref('taggerActions'),
    taggerToT2i: ref('taggerToT2i'),
    taggerToEdit: ref('taggerToEdit'),
    taggerStatus: ref('taggerStatus'),
    sendEdit: ref('sendEdit'),
    undo: ref('undo'),
    quickExport: ref('quickExport'),
    stageCompare: ref('stageCompare'),
    resetAll: ref('resetAll'),
    stage: ref('stage'),
    stageInner: ref('stageInner'),
    imageCanvas: ref('imageCanvas'),
    overlayCanvas: ref('overlayCanvas'),
    stageEmpty: ref('stageEmpty'),
    stageSub: ref('stageSub'),
    stageStatus: ref('stageStatus'),
    opsList: ref('opsList'),
    opsCount: ref('opsCount'),
    results: ref('results'),
    resultCount: ref('resultCount'),
    filmSelected: ref('filmSelected'),
    filmSelectAll: ref('filmSelectAll'),
    filmClearSelect: ref('filmClearSelect'),
    filmFavorite: ref('filmFavorite'),
    filmToEdit: ref('filmToEdit'),
    filmExport: ref('filmExport'),
    filmToGif: ref('filmToGif'),
    clearResults: ref('clearResults'),
  };

  /* ============================================================
   * 初始化
   * ============================================================ */
  loadKit().then((loaded) => {
    if (disposed) return;
    kit = loaded;
    renderRatios();
    syncActionBar();
  });

  function renderRatios() {
    const ratios = kit?.cropRatios || ['1:1', '16:9', '9:16', '4:3', '3:4'];
    refs.ratios.innerHTML = ['Free', 'Original', ...ratios]
      .map(
        (label) =>
          `<button class="chip ${state.crop.ratioLabel === label ? 'active' : ''}" type="button" data-ratio="${escapeHtml(label)}">${
            label === 'Free' ? '自由' : label === 'Original' ? '原图比例' : escapeHtml(label)
          }</button>`,
      )
      .join('');
    refs.ratios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.addEventListener('click', () => {
        state.crop.ratioLabel = button.dataset.ratio;
        renderRatios();
        resetCrop();
        render();
      });
    });
  }

  // 调色滑杆
  const ADJUST_FIELDS = [
    ['brightness', '亮度', 0.2, 2, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['contrast', '对比度', 0.2, 2, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['saturation', '饱和度', 0, 2, 0.01, (v) => `${Math.round(v * 100)}%`],
    ['sharpness', '锐化', 0, 4, 0.05, (v) => Number(v).toFixed(2)],
    ['temperature', '色温', -1, 1, 0.01, (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}`],
  ];
  function renderAdjustFields() {
    refs.adjustList.innerHTML = ADJUST_FIELDS.map(
      ([key, label, min, max, step, format]) => `
      <div class="adjust-row">
        <span class="adjust-label">${label}</span>
        <input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${state.adjust[key]}" data-adjust="${key}" />
        <span class="adjust-value mono" data-adjust-value="${key}">${format(state.adjust[key])}</span>
      </div>`,
    ).join('');
    refs.adjustList.querySelectorAll('input[data-adjust]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.adjust;
        state.adjust[key] = Number(input.value);
        refs.adjustList.querySelector(`[data-adjust-value="${key}"]`).textContent =
          ADJUST_FIELDS.find(([name]) => name === key)[5](state.adjust[key]);
        render();
      });
    });
  }
  renderAdjustFields();

  /* ============================================================
   * 工具轨 / 尺寸模式 / 导出选项
   * ============================================================ */
  let adjustSection = 'crop';

  const ACTION_MAP = {
    adjust: () => {
      if (adjustSection === 'rotate') {
        return {
          primary: refs.rotateApply,
          label: '应用角度',
          hint: '按输入角度旋转并扩展画布',
        };
      }
      if (adjustSection === 'color') {
        return {
          primary: refs.adjustApply,
          secondary: refs.adjustReset,
          label: '应用调色',
          secondaryLabel: '重置滑杆',
          hint: '应用到当前编辑结果 · 可撤销',
        };
      }
      const pending = pendingCropPixelRect();
      if (!pending && state.stagedOps.length) {
        return {
          primary: refs.quickExport,
          label: '去导出',
          hint: '裁剪已应用 · 可继续调色或导出',
        };
      }
      return {
        primary: refs.cropApply,
        secondary: refs.cropReset,
        label: '应用裁剪',
        secondaryLabel: '重置选框',
        hint: pending
          ? '应用到当前编辑结果 · 可撤销'
          : '先在画布上拖出裁剪框，或选择一个比例',
        disabled: !pending,
      };
    },
    size: {
      primary: refs.resizeApply,
      secondary: refs.pad32Apply,
      label: '应用缩放',
      secondaryLabel: '对齐 32',
      hint: '按当前宽高与模式缩放',
    },
    watermark: {
      primary: refs.wmApply,
      secondary: refs.wmPreview,
      label: '应用水印',
      secondaryLabel: '服务端预览',
      hint: '预览与最终导出保持一致',
    },
    gif: {
      primary: refs.gifGo,
      secondary: refs.gifCancel,
      label: '生成 GIF',
      secondaryLabel: '取消',
      hint: '提交到后台任务队列',
    },
    upscale: {
      primary: refs.upscaleGo,
      secondary: refs.upscaleCompare,
      label: '开始放大',
      secondaryLabel: '图像对比',
      hint: '使用当前编辑结果放大',
    },
    export: {
      primary: refs.processApply,
      label: '处理并保存',
      hint: '保存到作品历史',
    },
    outpaint: () =>
      state.outpaint.active && state.outpaint.result
        ? {
            primary: refs.outpaintGo,
            secondary: refs.outpaintCancel,
            label: '去局部重绘',
            secondaryLabel: '取消预览',
            hint: '把画布与遮罩送入图像编辑',
          }
        : {
            primary: refs.outpaintPlan,
            label: '规划扩图',
            hint: '先规划新画布与新增区域',
          },
    tagger: {
      primary: refs.taggerGo,
      secondary: refs.taggerCopy,
      label: '反推标签',
      secondaryLabel: '复制',
      hint: '识别结果可送入文生图 / 图像编辑',
    },
  };

  function currentAction() {
    const entry = ACTION_MAP[state.tool];
    return typeof entry === 'function' ? entry() : entry;
  }

  function syncActionBar() {
    const action = currentAction();
    if (!action) return;
    const primary = action.primary;
    const noSource = !state.source;
    host.querySelector('.page-tools')?.classList.toggle('is-empty', noSource);
    refs.actionPrimary.textContent = action.label || primary?.textContent?.trim() || '执行';
    const disabledByAction =
      action.disabled !== undefined ? Boolean(action.disabled) : Boolean(primary?.disabled);
    refs.actionPrimary.disabled = noSource || disabledByAction;
    refs.actionPrimary.title = noSource
      ? '请先上传图片'
      : disabledByAction
        ? action.hint || '当前没有可执行的操作'
        : primary?.title || '';
    refs.quickExport.disabled = noSource;
    refs.stageCompare.disabled =
      noSource || (!state.stagedOps.length && !(state.outpaint.active && state.outpaint.result));
    refs.actionHint.textContent = noSource
      ? '请先上传图片，或从素材仓库 / 最近结果导入'
      : action.hint || '';
    const secondary = action.secondary;
    const available =
      secondary &&
      !secondary.classList.contains('hidden') &&
      secondary.offsetParent !== null;
    refs.actionSecondary.classList.toggle('hidden', !available);
    if (available) {
      refs.actionSecondary.textContent =
        action.secondaryLabel || secondary.textContent.trim();
      refs.actionSecondary.disabled = Boolean(secondary.disabled);
      refs.actionSecondary.title = secondary.title || '';
    }
  }

  refs.actionPrimary.addEventListener('click', () => {
    const action = currentAction();
    if (!action?.primary || refs.actionPrimary.disabled) return;
    action.primary.click();
  });
  refs.actionSecondary.addEventListener('click', () => {
    const action = currentAction();
    if (!action?.secondary || refs.actionSecondary.disabled) return;
    action.secondary.click();
  });

  function scrollToolIntoView(fold) {
    if (!fold || !refs.inspectorScroll) return;
    const scroll = refs.inspectorScroll;
    const top = Math.max(
      0,
      fold.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 8,
    );
    scroll.scrollTo({ top, behavior: 'smooth' });
  }

  function syncToolGroups() {
    const panel = host.querySelector('#tool-panel');
    for (const chip of refs.toolRail.querySelectorAll('[data-tool-group]')) {
      const active = chip.dataset.toolGroup === state.tool;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-selected', active ? 'true' : 'false');
      chip.tabIndex = active ? 0 : -1;
      if (active && panel) panel.setAttribute('aria-labelledby', chip.id);
    }
    const visible = [];
    for (const fold of host.querySelectorAll('.tool-fold[data-group]')) {
      const active = fold.dataset.group === state.tool;
      fold.hidden = !active;
      if (active) visible.push(fold);
    }
    // 点击工具轨后，目标面板至少展开第一个折叠区，避免出现空白面板
    if (visible.length && !visible.some((fold) => fold.open)) visible[0].open = true;
    // 切工具后把目标面板滚到 Inspector 顶部，避免「水印文字」等内容被滚出视口
    if (visible.length) scrollToolIntoView(visible[0]);
    syncActionBar();
  }

  // 「调整」内部是裁剪 / 旋转 / 调色三个分区，同一时间只展开一个
  host.querySelectorAll('.tool-fold[data-group="adjust"][data-section]').forEach((fold) => {
    fold.querySelector('summary')?.addEventListener('click', () => {
      window.setTimeout(() => {
        if (fold.open) {
          adjustSection = fold.dataset.section || 'crop';
          host.querySelectorAll('.tool-fold[data-group="adjust"]').forEach((other) => {
            if (other !== fold) other.open = false;
          });
          scrollToolIntoView(fold);
        }
        syncActionBar();
      }, 0);
    });
  });

  refs.toolRail.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tool-group]');
    if (!chip) return;
    state.tool = chip.dataset.toolGroup;
    syncToolGroups();
    if (state.source) render();
  });

  refs.toolRail.addEventListener('keydown', (event) => {
    const nextKeys = ['ArrowDown', 'ArrowRight'];
    const prevKeys = ['ArrowUp', 'ArrowLeft'];
    if (!nextKeys.includes(event.key) && !prevKeys.includes(event.key) && !['Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const tabs = [...refs.toolRail.querySelectorAll('[data-tool-group]')];
    const current = Math.max(
      0,
      tabs.findIndex((tab) => tab.dataset.toolGroup === state.tool),
    );
    let next = current;
    if (nextKeys.includes(event.key)) next = (current + 1) % tabs.length;
    if (prevKeys.includes(event.key)) next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    const tab = tabs[next];
    if (!tab) return;
    state.tool = tab.dataset.toolGroup;
    syncToolGroups();
    if (state.source) render();
    tab.focus();
  });
  syncToolGroups();

  const actionSyncObserver = new MutationObserver(() => syncActionBar());
  actionSyncObserver.observe(refs.inspectorScroll, {
    attributes: true,
    attributeFilter: ['disabled'],
    subtree: true,
  });

  const RESIZE_MODES = {
    percent: { label: '百分比 %', min: 1, max: 400, step: 1, value: 100 },
    long_edge: { label: '长边 px', min: 1, max: 8192, step: 1, value: 2048 },
    short_edge: { label: '短边 px', min: 1, max: 8192, step: 1, value: 1080 },
    megapixels: { label: '百万像素 MP', min: 0.1, max: 80, step: 0.1, value: 4 },
  };
  function applyResizeModeMeta(meta) {
    refs.resizeModeField.classList.toggle('hidden', !meta);
    if (!meta) {
      updateResizeHint();
      return;
    }
    refs.resizeModeLabel.textContent = meta.label;
    refs.resizeModeValue.min = String(meta.min);
    refs.resizeModeValue.max = String(meta.max);
    refs.resizeModeValue.step = String(meta.step);
    updateResizeHint();
  }
  refs.resizeMode.addEventListener('change', () => {
    const meta = RESIZE_MODES[refs.resizeMode.value];
    if (meta) refs.resizeModeValue.value = String(meta.value);
    applyResizeModeMeta(meta);
    // 精确宽高模式下把输入框恢复为当前工作尺寸，避免上次百分比数值残留在宽高里
    if (!meta) syncResizeInputs();
  });
  applyResizeModeMeta(null);
  refs.resizeSharpen.addEventListener('input', () => {
    refs.resizeSharpenVal.textContent = refs.resizeSharpen.value;
  });
  ['input', 'change'].forEach((type) => {
    refs.resizeModeValue.addEventListener(type, updateResizeHint);
    refs.resizeSnap.addEventListener(type, updateResizeHint);
    refs.resizeFit.addEventListener(type, updateResizeHint);
    refs.resizeFilter.addEventListener(type, updateResizeHint);
    refs.resizeLock.addEventListener(type, updateResizeHint);
  });

  const syncExportUi = () => {
    const fmt = refs.format.value;
    refs.losslessField.classList.toggle('hidden', fmt !== 'webp');
    refs.bgField.classList.toggle('hidden', fmt !== 'jpeg');
    refs.qualityField.classList.toggle('hidden', fmt === 'png' || (fmt === 'webp' && refs.lossless.checked));
  };
  syncExportUi();

  /* ============================================================
   * 源图 / 上传
   * ============================================================ */
  async function setSourceFromDataUrl(dataUrl, name = 'image.png') {
    const { width, height } = await probeImageSize(dataUrl);
    state.source = { dataUrl, name, width, height };
    state.stagedOps = [];
    state.adjust = { ...NEUTRAL_ADJUST };
    state.outpaint.active = false;
    state.outpaint.result = null;
    state.outpaint.panoramaAspect = '';
    state.crop.ratioLabel = 'Free';
    state.crop.rect = null;
    state.crop.suppressed = false;
    state.resize.width = width;
    state.resize.height = height;
    refs.resizeWidth.value = String(width);
    refs.resizeHeight.value = String(height);
    renderRatios();
    renderAdjustFields();
    refs.outpaintGo.disabled = true;
    refs.outpaintCancel.classList.add('hidden');
    syncPanoramaUi();
    refs.stageEmpty.classList.add('hidden');
    await loadSourceImage();
    // 注意：这里不要提前 resetCrop()。此时 render() 还没跑，currentWorkDims 仍是 0，
    // currentDisplaySize() 会退化成 1×1，裁切框就变成一个 2px 的小点（裁剪输出显示 2×2）。
    // 交给 render()：它先写入 currentWorkDims，再在 rect 为空时 resetCrop()。
    state.crop.rect = null;
    render();
    renderSourceMeta();
    renderOps();
    updateOutpaintSummary();
    syncUpscaleButton();
    syncTaggerButton();
    syncCompareButton();
    syncActionBar();
  }

  async function loadSourceImage() {
    if (!state.source) return null;
    if (sourceImage && sourceImage.__src === state.source.dataUrl) return sourceImage;
    const loader = kit?.loadImage
      ? kit.loadImage
      : (src) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('图片加载失败'));
            image.src = src;
          });
    const image = await loader(state.source.dataUrl);
    image.__src = state.source.dataUrl;
    sourceImage = image;
    return image;
  }

  function renderSourceMeta() {
    if (!state.source) {
      refs.dropzone.classList.remove('hidden');
      refs.sourceSub.textContent = '上传后开始处理';
      refs.sourceMeta.innerHTML = '<span class="dim">尚未选择图片</span>';
      refs.stageSub.textContent = '上传图片开始';
      return;
    }
    const { width, height, name } = state.source;
    refs.dropzone.classList.add('hidden');
    refs.sourceSub.textContent = `已载入 · ${fmtNum(width)} × ${fmtNum(height)} · ${((width * height) / 1e6).toFixed(1)} MP`;
    refs.sourceMeta.innerHTML = `
      <div class="source-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="source-dims mono">${fmtNum(width)} × ${fmtNum(height)} · ${((width * height) / 1e6).toFixed(1)} MP</div>`;
    refs.stageSub.textContent = `${fmtNum(width)} × ${fmtNum(height)}`;
  }

  async function handleFiles(files) {
    const file = [...(files || [])].find((item) => item.type.startsWith('image/'));
    if (!file) {
      toastWarn('请选择图片文件');
      return;
    }
    try {
      const dataUrl = await readFileAsDataURL(file);
      await setSourceFromDataUrl(dataUrl, file.name);
      toastSuccess(`已载入 ${file.name}`);
    } catch (err) {
      toastError(err, '载入图片失败');
    }
  }

  refs.dropzone.addEventListener('click', () => refs.fileInput.click());
  refs.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      refs.fileInput.click();
    }
  });
  refs.newSource.addEventListener('click', () => refs.fileInput.click());
  refs.fileInput.addEventListener('change', async () => {
    await handleFiles(refs.fileInput.files);
    refs.fileInput.value = '';
  });
  refs.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    refs.dropzone.classList.add('drag');
  });
  refs.dropzone.addEventListener('dragleave', () => refs.dropzone.classList.remove('drag'));
  refs.dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    refs.dropzone.classList.remove('drag');
    await handleFiles(event.dataTransfer?.files);
  });
  refs.stage.addEventListener('dragover', (event) => event.preventDefault());
  refs.stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    await handleFiles(event.dataTransfer?.files);
  });

  /* ============================================================
   * 导入菜单：素材仓库 / 最近结果 / 剪贴板
   * ============================================================ */
  function pickFromItems({ title, subtitle, items, emptyHint }) {
    return new Promise((resolve) => {
      if (!items.length) {
        toastWarn(emptyHint || '没有可导入的图片');
        resolve(null);
        return;
      }
      let picked = null;
      const wrap = document.createElement('div');
      wrap.className = 'tools-pick';
      wrap.innerHTML = `
        <div class="tools-pick-grid">
          ${items
            .map(
              (item, index) => `
            <button class="tools-pick-card" type="button" data-index="${index}">
              <span class="tools-pick-thumb"><img src="${escapeHtml(item.thumbUrl || item.url)}" alt="" loading="lazy" /></span>
              <span class="tools-pick-cap" title="${escapeHtml(item.name || '')}">${escapeHtml(item.name || '图片')}</span>
            </button>`,
            )
            .join('')}
        </div>`;
      const cards = [...wrap.querySelectorAll('[data-index]')];
      cards.forEach((card) => {
        card.addEventListener('click', () => {
          cards.forEach((node) => node.classList.remove('active'));
          card.classList.add('active');
          picked = items[Number(card.dataset.index)];
        });
      });
      const modal = openModal({
        title,
        subtitle,
        size: 'lg',
        content: wrap,
        actions: [
          { label: '取消', kind: 'ghost' },
          {
            label: '载入为源图',
            kind: 'primary',
            close: false,
            onClick: () => {
              if (!picked) {
                toastWarn('请先选择一张图片');
                return false;
              }
              resolve(picked);
              modal.close();
            },
          },
        ],
        onClose: () => resolve(null),
      });
    });
  }

  async function loadPickedSource(picked) {
    try {
      await setSourceFromDataUrl(picked.url, picked.name || 'imported.png');
      toastSuccess(`已载入 ${picked.name || '图片'}`);
    } catch (err) {
      toastError(err, '载入图片失败');
    }
  }

  async function openMaterialsPicker() {
    try {
      const data = await api.materials({ limit: 200 });
      const items = (data.items || [])
        .filter((item) => item.image?.url)
        .map((item) => ({
          url: item.image.url,
          thumbUrl: item.image.thumbUrl || item.image.url,
          name: item.title || item.image.filename || '素材图片',
        }));
      const picked = await pickFromItems({
        title: '从素材仓库导入',
        subtitle: `${items.length} 张素材`,
        items,
        emptyHint: '素材仓库还没有图片，可先在「素材仓库」页收藏或上传',
      });
      if (picked) await loadPickedSource(picked);
    } catch (err) {
      toastError(err, '读取素材仓库失败');
    }
  }

  async function openRecentPicker() {
    const items = state.results.slice(0, 24).map((item) => ({
      url: item.url,
      thumbUrl: item.thumbUrl,
      name: item.filename || `${item.kind || 'result'}.png`,
    }));
    const picked = await pickFromItems({
      title: '从最近结果导入',
      subtitle: '本次会话的处理结果',
      items,
      emptyHint: '还没有处理结果',
    });
    if (picked) await loadPickedSource(picked);
  }

  async function importBlob(blob) {
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const file = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: blob.type || 'image/png' });
    await handleFiles([file]);
  }

  async function importFromClipboard() {
    if (!navigator.clipboard?.read) {
      toastWarn('当前浏览器不支持读取剪贴板，请在页面上按 Ctrl+V 粘贴图片');
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const type = item.types.find((value) => value.startsWith('image/'));
        if (!type) continue;
        await importBlob(await item.getType(type));
        return;
      }
      toastWarn('剪贴板里没有图片');
    } catch {
      toastWarn('无法读取剪贴板，请在页面上按 Ctrl+V 粘贴图片');
    }
  }

  function onPaste(event) {
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    handleFiles(files);
  }

  refs.importMaterials.addEventListener('click', openMaterialsPicker);
  refs.importRecent.addEventListener('click', openRecentPicker);
  refs.importPaste.addEventListener('click', importFromClipboard);
  document.addEventListener('paste', onPaste);

  /* ============================================================
   * 渲染：几何预览 + CSS 调色 + 裁剪/宫格/扩图叠加
   * ============================================================ */
  function currentDisplaySize() {
    const stage = refs.stage;
    const width = Math.max(1, stage.clientWidth - 36);
    const height = Math.max(1, stage.clientHeight - 64);
    const naturalW = currentWorkDims.width || 1;
    const naturalH = currentWorkDims.height || 1;
    const fit = Math.min(width / naturalW, height / naturalH, 1);
    return {
      width: Math.max(1, Math.round(naturalW * fit)),
      height: Math.max(1, Math.round(naturalH * fit)),
    };
  }

  function resetCrop() {
    if (!state.source) return;
    state.crop.suppressed = false;
    const display = currentDisplaySize();
    const ratio = kit?.cropRatio ? kit.cropRatio(state.crop.ratioLabel, { width: currentWorkDims.width, height: currentWorkDims.height }) : null;
    if (ratio && kit?.centeredCrop) {
      state.crop.rect = kit.centeredCrop(display, ratio, 0.9);
    } else {
      state.crop.rect = { x: 0, y: 0, width: display.width, height: display.height };
    }
  }

  /* D18.3：工作画布只在源图 / 操作链 / 扩图结果变化时重建；
     裁剪与水印拖动只刷新叠加层，不再每次 pointermove 全量重算。 */
  function markWorkBuilt() {
    const ops = state.stagedOps;
    workKey = {
      source: state.source,
      count: ops.length,
      last: ops.length ? ops[ops.length - 1] : null,
      outpaint: state.outpaint.active ? state.outpaint.result : null,
    };
  }

  function workStale() {
    if (!workCanvas) return true;
    const ops = state.stagedOps;
    return (
      workKey.source !== state.source ||
      workKey.count !== ops.length ||
      workKey.last !== (ops.length ? ops[ops.length - 1] : null) ||
      workKey.outpaint !== (state.outpaint.active ? state.outpaint.result : null)
    );
  }

  /** 只在显示尺寸 / DPR 变化时重设 backing store，避免拖动时反复重分配画布。 */
  function syncCanvasSize(display, dpr) {
    if (
      displayStamp.width === display.width &&
      displayStamp.height === display.height &&
      displayStamp.dpr === dpr
    ) {
      return false;
    }
    displayStamp = { width: display.width, height: display.height, dpr };
    for (const canvas of [refs.imageCanvas, refs.overlayCanvas]) {
      canvas.width = Math.round(display.width * dpr);
      canvas.height = Math.round(display.height * dpr);
      canvas.style.width = `${display.width}px`;
      canvas.style.height = `${display.height}px`;
      canvas.style.display = 'block';
    }
    return true;
  }

  function drawDisplay() {
    if (!workCanvas || !displayStamp.width) return;
    const ictx = refs.imageCanvas.getContext('2d');
    ictx.setTransform(displayStamp.dpr, 0, 0, displayStamp.dpr, 0, 0);
    ictx.clearRect(0, 0, displayStamp.width, displayStamp.height);
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(workCanvas, 0, 0, displayStamp.width, displayStamp.height);
  }

  function drawOverlay() {
    if (!displayStamp.width) return;
    const octx = refs.overlayCanvas.getContext('2d');
    octx.setTransform(displayStamp.dpr, 0, 0, displayStamp.dpr, 0, 0);
    octx.clearRect(0, 0, displayStamp.width, displayStamp.height);
    if (state.outpaint.active && state.outpaint.result) drawOutpaintOverlay(octx, displayStamp);
    else if (state.tool === 'watermark') drawWatermarkPreview(octx, displayStamp);
    else if (state.tool === 'adjust' && adjustSection === 'crop') drawCropOverlay(octx, displayStamp);
    const cropMode = state.tool === 'adjust' && adjustSection === 'crop';
    const wmCustom =
      state.tool === 'watermark' && refs.wmPosition.value === 'custom' && !refs.wmTile.checked;
    refs.overlayCanvas.style.cursor = wmCustom ? 'move' : cropMode ? 'crosshair' : 'default';
  }

  function syncStageReadouts() {
    updateCropSize();
    updateEstimate();
    updateResizeHint();
    if (currentWorkDims.width && currentWorkDims.height) {
      refs.stageSub.textContent = `${fmtNum(currentWorkDims.width)} × ${fmtNum(currentWorkDims.height)}`;
    }
    refs.stageStatus.textContent = `${fmtNum(currentWorkDims.width)} × ${fmtNum(currentWorkDims.height)} · 显示 ${Math.round(
      (displayStamp.width / currentWorkDims.width) * 100,
    )}%`;
  }

  /** 拖动中只重绘叠加层；工作画布与底图保持不动。 */
  function paintOverlayOnly() {
    if (!state.source || !workCanvas || state.crop.pendingReset) {
      render();
      return;
    }
    const display = currentDisplaySize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (syncCanvasSize(display, dpr)) drawDisplay();
    if (!state.crop.rect) {
      syncStageReadouts();
      return;
    }
    state.crop.rect = clampRect(state.crop.rect, displayStamp);
    drawOverlay();
    syncStageReadouts();
  }

  /** 所有 pointermove 走 rAF 合并，一帧最多重绘一次叠加层。 */
  function scheduleOverlay() {
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(() => {
      overlayRaf = 0;
      paintOverlayOnly();
    });
  }

  async function render() {
    const token = (renderToken += 1);
    if (!state.source) {
      refs.stageEmpty.classList.remove('hidden');
      refs.imageCanvas.style.display = 'none';
      refs.overlayCanvas.style.display = 'none';
      refs.stageStatus.textContent = '—';
      return;
    }
    if (workStale()) {
      const image = await loadSourceImage();
      if (!image || token !== renderToken) return;
      if (state.outpaint.active && state.outpaint.result) {
        workCanvas = state.outpaint.result.canvas;
      } else {
        workCanvas = applyOpsToCanvas(image, state.stagedOps);
      }
      currentWorkDims = { width: workCanvas.width, height: workCanvas.height };
      markWorkBuilt();
      // 工作画布换了，显示层必须按新尺寸重画一次
      displayStamp = { width: 0, height: 0, dpr: 0 };
    }
    // 调色走 CSS filter，与工作画布缓存无关，每次都要同步到显示层
    refs.imageCanvas.style.filter =
      state.outpaint.active && state.outpaint.result
        ? 'none'
        : adjustFilterString(
            state.stagedOps.filter((op) => op.op === 'adjust'),
            state.adjust,
          );
    if (token !== renderToken) return;
    refs.stageEmpty.classList.add('hidden');

    const display = currentDisplaySize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (syncCanvasSize(display, dpr)) drawDisplay();

    if (!state.crop.rect && !state.crop.suppressed) resetCrop();
    // 前面某次操作（如应用裁剪）要求在新尺寸下重排选框
    if (state.crop.pendingReset) {
      state.crop.pendingReset = false;
      state.crop.rect = null;
      if (!state.crop.suppressed) resetCrop();
    }
    if (!state.crop.rect) {
      syncStageReadouts();
      syncActionBar();
      return;
    }
    state.crop.rect = clampRect(state.crop.rect, displayStamp);
    drawOverlay();
    syncStageReadouts();
    syncActionBar();
  }

  function clampRect(rect, display) {
    if (!rect) return { x: 0, y: 0, width: display.width, height: display.height };
    const width = Math.max(1, Math.min(rect.width, display.width));
    const height = Math.max(1, Math.min(rect.height, display.height));
    return {
      x: Math.max(0, Math.min(rect.x, display.width - width)),
      y: Math.max(0, Math.min(rect.y, display.height - height)),
      width,
      height,
    };
  }

  function drawCropOverlay(ctx, display) {
    const rect = state.crop.rect;
    if (!rect) return;
    // 框外压暗
    ctx.save();
    ctx.fillStyle = 'rgba(35, 38, 43, 0.42)';
    ctx.beginPath();
    ctx.rect(0, 0, display.width, display.height);
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.fill('evenodd');
    ctx.restore();

    // 网格线
    if (state.crop.grid) {
      const rows = Math.max(1, Math.min(10, Number(refs.gridRows.value) || 2));
      const columns = Math.max(1, Math.min(10, Number(refs.gridColumns.value) || 2));
      const rowGap = Math.max(0, Number(refs.gridRowGap.value) || 0);
      const columnGap = Math.max(0, Number(refs.gridColumnGap.value) || 0);
      const rects = cropGridRects(rect, display, rows, columns, rowGap, columnGap, 'display');
      if (rects && rects.length) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.2;
        for (const cell of rects) {
          ctx.strokeRect(cell.x + 0.5, cell.y + 0.5, cell.width, cell.height);
        }
        ctx.restore();
      }
    }

    // 裁剪框 + 8 个手柄（白色描边 + 墨绿填充）
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
    ctx.strokeStyle = 'rgba(47,107,98,0.95)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.width - 2, rect.height - 2);
    const handles = kit?.cropHandles ? kit.cropHandles(rect) : [];
    for (const handle of handles) {
      ctx.beginPath();
      ctx.rect(handle.x - 4, handle.y - 4, 8, 8);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(47,107,98,0.95)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    // 三分线
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i += 1) {
      ctx.beginPath();
      ctx.moveTo(rect.x + (rect.width * i) / 3, rect.y);
      ctx.lineTo(rect.x + (rect.width * i) / 3, rect.y + rect.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y + (rect.height * i) / 3);
      ctx.lineTo(rect.x + rect.width, rect.y + (rect.height * i) / 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 水印拖动把手（近似尺寸；真实尺寸以服务端渲染为准）。 */
  function watermarkHandleRect(display) {
    if (
      watermarkPreviewRect &&
      watermarkPreviewStamp.width === display.width &&
      watermarkPreviewStamp.height === display.height
    ) {
      return { ...watermarkPreviewRect };
    }
    const side = Math.min(display.width, display.height);
    const scale = (Number(refs.wmScale.value) || 6) / 100;
    let width = side * scale * 4;
    let height = side * scale * 1.6;
    if (state.watermark.kind === 'text') {
      const text = refs.wmText.value.trim() || '水印';
      width = side * scale * 0.62 * Math.max(2, text.length);
      height = side * scale * 1.5;
    }
    width = Math.max(28, width);
    height = Math.max(20, height);
    return {
      x: state.watermark.x * display.width - width / 2,
      y: state.watermark.y * display.height - height / 2,
      width,
      height,
    };
  }

  const WATERMARK_SNAP = [1 / 3, 0.5, 2 / 3];

  function snapWatermark(value, pixels) {
    for (const target of WATERMARK_SNAP) {
      if (Math.abs(value - target) * pixels <= 8) return target;
    }
    return value;
  }

  function watermarkAnchor(display, width, height) {
    const side = Math.min(display.width, display.height);
    const margin = ((Number(refs.wmMargin.value) || 0) / 100) * side;
    const position = refs.wmPosition.value;
    let x = display.width / 2;
    let y = display.height / 2;
    if (position === 'custom') {
      x = state.watermark.x * display.width;
      y = state.watermark.y * display.height;
    } else {
      if (position.includes('left')) x = margin + width / 2;
      else if (position.includes('right')) x = display.width - margin - width / 2;
      if (position.includes('top')) y = margin + height / 2;
      else if (position.includes('bottom')) y = display.height - margin - height / 2;
    }
    x = Math.max(width / 2 + 2, Math.min(display.width - width / 2 - 2, x));
    y = Math.max(height / 2 + 2, Math.min(display.height - height / 2 - 2, y));
    return { x, y };
  }

  function drawWatermarkText(ctx, text, x, y, fontSize, family, color, rotation, stroke, side) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.font = `600 ${fontSize}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (stroke > 0) {
      ctx.lineWidth = Math.max(1, side * (stroke / 1000));
      ctx.strokeStyle = '#000000';
      ctx.strokeText(text, 0, 0);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawWatermarkPreview(ctx, display) {
    const side = Math.min(display.width, display.height);
    const scale = (Number(refs.wmScale.value) || 6) / 100;
    const opacity = (Number(refs.wmOpacity.value) || 55) / 100;
    const rotation = Number(refs.wmRotation.value) || 0;
    const color = refs.wmColor.value || '#ffffff';
    const stroke = Number(refs.wmStroke.value) || 0;
    const shadow = refs.wmShadow.checked;
    const tile = refs.wmTile.checked;
    const position = refs.wmPosition.value;
    const fontLabel = refs.wmFont.selectedOptions?.[0]?.textContent || '默认字体';
    const family =
      fontLabel === '默认字体'
        ? '"Microsoft YaHei", "PingFang SC", sans-serif'
        : `"${fontLabel}", "Microsoft YaHei", sans-serif`;

    ctx.save();
    ctx.globalAlpha = opacity;
    if (shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.max(2, side * 0.008);
      ctx.shadowOffsetX = Math.max(1, side * 0.003);
      ctx.shadowOffsetY = Math.max(1, side * 0.003);
    }

    let rect = null;
    if (state.watermark.kind === 'text') {
      const text = refs.wmText.value.trim() || '水印';
      const fontSize = Math.max(10, side * scale);
      ctx.font = `600 ${fontSize}px ${family}`;
      const width = Math.max(8, ctx.measureText(text).width);
      const height = fontSize * 1.25;
      if (tile) {
        const gapX = ((Number(refs.wmGapX.value) || 20) / 100) * side;
        const gapY = ((Number(refs.wmGapY.value) || 12) / 100) * side;
        const stepX = width + gapX;
        const stepY = height + gapY;
        ctx.save();
        ctx.translate(display.width / 2, display.height / 2);
        ctx.rotate(((Number(refs.wmTileAngle.value) || -24) * Math.PI) / 180);
        for (let y = -display.height; y <= display.height; y += stepY) {
          for (let x = -display.width; x <= display.width; x += stepX) {
            drawWatermarkText(ctx, text, x, y, fontSize, family, color, 0, stroke, side);
          }
        }
        ctx.restore();
        watermarkPreviewRect = null;
        ctx.restore();
        return;
      }
      const anchor = watermarkAnchor(display, width, height);
      drawWatermarkText(ctx, text, anchor.x, anchor.y, fontSize, family, color, rotation, stroke, side);
      rect = { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height };
    } else if (watermarkMarkImage) {
      const width = Math.max(24, side * scale * 4);
      const height = Math.max(16, width * (watermarkMarkImage.height / watermarkMarkImage.width));
      const anchor = watermarkAnchor(display, width, height);
      ctx.save();
      ctx.translate(anchor.x, anchor.y);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(watermarkMarkImage, -width / 2, -height / 2, width, height);
      ctx.restore();
      rect = { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height };
    } else {
      const width = Math.max(40, side * scale * 4);
      const height = Math.max(24, side * scale * 1.6);
      const anchor = watermarkAnchor(display, width, height);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(anchor.x - width / 2, anchor.y - height / 2, width, height);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('选择 logo', anchor.x, anchor.y);
      ctx.restore();
      rect = { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height };
    }

    if (rect && position === 'custom') {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
      ctx.restore();
    }
    watermarkPreviewRect = rect;
    watermarkPreviewStamp = { width: display.width, height: display.height };
    ctx.restore();
  }

  function drawOutpaintOverlay(ctx, display) {
    const result = state.outpaint.result;
    const sourceRect = result.sourceRect || result.plan?.offset || {};
    const scaleX = display.width / result.width;
    const scaleY = display.height / result.height;
    const sx = (Number(sourceRect.x) || 0) * scaleX;
    const sy = (Number(sourceRect.y) || 0) * scaleY;
    const sw = (Number(sourceRect.width) || result.plan?.source?.w || result.width) * scaleX;
    const sh = (Number(sourceRect.height) || result.plan?.source?.h || result.height) * scaleY;
    ctx.save();
    // 新增区域用半透明墨绿斜线标识
    ctx.fillStyle = 'rgba(47, 107, 98, 0.22)';
    ctx.beginPath();
    ctx.rect(0, 0, display.width, display.height);
    ctx.rect(sx, sy, sw, sh);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(47,107,98,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw, sh);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 1.5, sy + 1.5, sw - 2, sh - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText('原图区域', sx + 8, sy + 20);
    ctx.restore();
  }

  function cropGridRects(rect, display, rows, columns, rowGap, columnGap, target = 'pixel') {
    if (!kit?.gridRects) return [];
    const sourceSize = { width: currentWorkDims.width, height: currentWorkDims.height };
    const rects = kit.gridRects(rect, display, sourceSize, rows, columns, rowGap, columnGap);
    if (target === 'display') {
      const scaleX = display.width / sourceSize.width;
      const scaleY = display.height / sourceSize.height;
      return rects.map((cell) => ({
        x: cell.x * scaleX,
        y: cell.y * scaleY,
        width: cell.width * scaleX,
        height: cell.height * scaleY,
      }));
    }
    return rects;
  }

  function pendingCropPixelRect() {
    if (!kit?.cropOutputRects || !state.crop.rect || !state.source) return null;
    const display = currentDisplaySize();
    if (state.crop.rect.width >= display.width - 1 && state.crop.rect.height >= display.height - 1) return null;
    const rects = kit.cropOutputRects(
      state.crop.rect,
      { width: display.width, height: display.height },
      { width: currentWorkDims.width, height: currentWorkDims.height },
      [],
      [],
      0,
      0,
    );
    const column = rects.columns[0];
    const row = rects.rows[0];
    // 防御：选框异常小时（<16px）视为「没有单独裁剪」，避免把图切成 1×1
    if (!column || !row || column.size < 16 || row.size < 16) return null;
    let width = column.size;
    let height = row.size;
    // 把显示坐标换算产生的 1–2px 误差修正回目标比例（尤其 1:1 必须是正方形）
    const ratio = kit.cropRatio
      ? kit.cropRatio(state.crop.ratioLabel, {
          width: currentWorkDims.width,
          height: currentWorkDims.height,
        })
      : null;
    if (ratio) {
      const maxW = Math.max(1, currentWorkDims.width - column.start);
      const maxH = Math.max(1, currentWorkDims.height - row.start);
      if (Math.abs(width / height - ratio) > 0.0005) {
        const heightFromWidth = Math.round(width / ratio);
        const widthFromHeight = Math.round(height * ratio);
        if (
          heightFromWidth <= maxH &&
          (widthFromHeight > maxW ||
            Math.abs(heightFromWidth - height) <= Math.abs(widthFromHeight - width))
        ) {
          height = heightFromWidth;
        } else if (widthFromHeight <= maxW) {
          width = widthFromHeight;
        }
      }
      if (Math.abs(ratio - 1) < 1e-6) {
        const side = Math.max(1, Math.min(width, height, maxW, maxH));
        width = side;
        height = side;
      }
      width = Math.max(1, Math.min(width, maxW));
      height = Math.max(1, Math.min(height, maxH));
    }
    return { op: 'crop', x: column.start, y: row.start, width, height };
  }

  function updateCropSize() {
    if (!state.source) {
      refs.cropSize.textContent = '—';
      return;
    }
    const pixel = pendingCropPixelRect();
    if (!pixel) {
      refs.cropSize.textContent = `整图 ${fmtNum(currentWorkDims.width)} × ${fmtNum(currentWorkDims.height)}`;
      return;
    }
    refs.cropSize.textContent = `${fmtNum(pixel.width)} × ${fmtNum(pixel.height)}`;
  }

  /** 按当前面板参数算出「实际输出尺寸」，供摘要展示与实际提交共用。 */
  function resizePlan() {
    if (!state.source) return null;
    const baseW = currentWorkDims.width || state.source.width || 1;
    const baseH = currentWorkDims.height || state.source.height || 1;
    const mode = refs.resizeMode.value || 'exact';
    const snap = Math.max(0, Math.round(Number(refs.resizeSnap.value) || 0));
    let width;
    let height;
    if (mode === 'exact') {
      width = Number(refs.resizeWidth.value) || baseW;
      height = Number(refs.resizeHeight.value) || baseH;
    } else {
      const value = Number(refs.resizeModeValue.value) || 0;
      if (!(value > 0)) return { baseW, baseH, width: 0, height: 0, snap, mode, invalid: true };
      [width, height] = resizeTargetSize({ width: baseW, height: baseH }, { mode, [mode]: value });
    }
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (snap > 1) {
      width = Math.max(snap, Math.round(width / snap) * snap);
      height = Math.max(snap, Math.round(height / snap) * snap);
    }
    return { baseW, baseH, width, height, snap, mode };
  }

  function updateResizeHint() {
    const filterLabel = (refs.resizeFilter.selectedOptions?.[0]?.textContent || 'Lanczos')
      .split('（')[0]
      .trim();
    refs.resizeAdvancedTip.textContent = `${filterLabel} · ${refs.resizeFit.value}`;
    if (!state.source) {
      refs.resizeFrom.textContent = '—';
      refs.resizeTo.textContent = '—';
      refs.resizeTo.classList.remove('is-warn');
      refs.resizeMeta.textContent = '上传图片后可查看缩放结果';
      refs.resizeHint.textContent = '当前 —';
      refs.pad32Apply.disabled = true;
      refs.pad32Apply.title = '请先上传图片';
      return;
    }
    // 预览尺寸变化后同步输入框（正在输入时不打扰）
    if (document.activeElement !== refs.resizeWidth && document.activeElement !== refs.resizeHeight) {
      refs.resizeWidth.value = String(currentWorkDims.width || state.source.width || 0);
      refs.resizeHeight.value = String(currentWorkDims.height || state.source.height || 0);
    }
    const plan = resizePlan();
    const baseW = plan?.baseW || currentWorkDims.width || state.source.width || 0;
    const baseH = plan?.baseH || currentWorkDims.height || state.source.height || 0;
    refs.resizeFrom.textContent = `${fmtNum(baseW)} × ${fmtNum(baseH)}`;
    const aligned = baseW > 0 && baseH > 0 && baseW % 32 === 0 && baseH % 32 === 0;
    refs.pad32Apply.disabled = aligned;
    refs.pad32Apply.title = aligned ? '当前尺寸已是 32 的倍数' : '按 32 倍数延伸边缘像素';
    if (!plan || plan.invalid) {
      refs.resizeTo.textContent = '待输入';
      refs.resizeTo.classList.add('is-warn');
      refs.resizeMeta.textContent = '请输入大于 0 的目标值';
      refs.resizeHint.textContent = '32 倍数：—';
      return;
    }
    const oversized = plan.width > 8192 || plan.height > 8192;
    refs.resizeTo.textContent = `${fmtNum(plan.width)} × ${fmtNum(plan.height)}`;
    refs.resizeTo.classList.toggle('is-warn', oversized);
    const fromPx = Math.max(1, plan.baseW * plan.baseH);
    const toPx = plan.width * plan.height;
    // 用户理解的「缩放 50%」是边长比例；面积比只在等比时与边长平方一致
    const linear = Math.sqrt(toPx / fromPx) * 100;
    const sameAspect =
      Math.abs(plan.width / plan.height - plan.baseW / plan.baseH) < 0.005;
    const megapixels = toPx / 1e6;
    const parts = [
      `${sameAspect ? '边长' : '等效'} ${linear.toFixed(linear >= 100 ? 0 : 1)}%`,
      `${megapixels < 1 ? megapixels.toFixed(2) : megapixels.toFixed(1)} MP`,
    ];
    if (plan.snap > 1) parts.push(`已按 ${plan.snap} 对齐`);
    if (plan.width === plan.baseW && plan.height === plan.baseH) parts.push('尺寸未变化');
    if (oversized) parts.push('超出 8192 上限');
    refs.resizeMeta.textContent = parts.join(' · ');
    refs.resizeHint.textContent = `32 倍数：${
      plan.width % 32 === 0 && plan.height % 32 === 0 ? '是' : '否，建议先「对齐 32」'
    }`;
  }

  function updateEstimate() {
    const pixel = pendingCropPixelRect();
    const width = pixel?.width || currentWorkDims.width;
    const heightPx = pixel?.height || currentWorkDims.height;
    let bytesPerPixel;
    if (state.format === 'jpeg') {
      bytesPerPixel = 0.16 * (state.quality / 92);
    } else if (state.format === 'webp') {
      bytesPerPixel = refs.lossless.checked ? 1.1 : 0.28 * (state.quality / 92);
    } else {
      bytesPerPixel = 1.35;
    }
    const bytes = width * heightPx * bytesPerPixel;
    refs.estimate.textContent = `约 ${(bytes / 1024 / 1024).toFixed(2)} MB（${state.format.toUpperCase()}，估算）`;
    if (refs.exportPending) {
      refs.exportPending.textContent = pixel
        ? `会同时应用当前裁剪 ${fmtNum(pixel.width)}×${fmtNum(pixel.height)}；如需只保存已应用操作，请回到「调整 → 裁剪」重置选框。`
        : '';
      refs.exportPending.classList.toggle('hidden', !pixel);
    }
  }

  /* ============================================================
   * 裁剪交互
   * ============================================================ */
  function pointerPoint(event) {
    const rect = refs.overlayCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  refs.overlayCanvas.addEventListener('pointerdown', (event) => {
    if (!state.source || state.outpaint.active || event.button !== 0) return;
    const point = pointerPoint(event);
    if (state.tool === 'watermark') {
      if (refs.wmPosition.value !== 'custom' || refs.wmTile.checked) return;
      const display = currentDisplaySize();
      const rect = watermarkHandleRect(display);
      const inside =
        point.x >= rect.x - 8 &&
        point.x <= rect.x + rect.width + 8 &&
        point.y >= rect.y - 8 &&
        point.y <= rect.y + rect.height + 8;
      if (!inside) return;
      event.preventDefault();
      refs.overlayCanvas.setPointerCapture?.(event.pointerId);
      refs.overlayCanvas.focus?.();
      drag = { type: 'watermark', size: display };
      return;
    }
    if (state.tool !== 'adjust' || adjustSection !== 'crop') return;
    if (!kit) return;
    const handle = state.crop.rect ? kit.hitCrop(state.crop.rect, point) : null;
    event.preventDefault();
    refs.overlayCanvas.setPointerCapture?.(event.pointerId);
    if (!handle) {
      state.crop.suppressed = false;
      drag = {
        type: 'draw',
        start: point,
        size: currentDisplaySize(),
        ratio: kit.cropRatio(state.crop.ratioLabel, currentWorkDims),
      };
      state.crop.rect = kit.createCrop(point, point, drag.size, drag.ratio);
      return;
    }
    drag = {
      type: handle === 'move' ? 'move' : 'resize',
      handle,
      start: point,
      origin: { ...state.crop.rect },
      size: currentDisplaySize(),
      ratio: kit.cropRatio(state.crop.ratioLabel, currentWorkDims),
    };
  });

  refs.overlayCanvas.addEventListener('pointermove', (event) => {
    if (!state.source || state.outpaint.active) return;
    const point = pointerPoint(event);
    if (drag?.type === 'watermark') {
      const display = drag.size;
      const nx = snapWatermark(point.x / display.width, display.width);
      const ny = snapWatermark(point.y / display.height, display.height);
      state.watermark.x = Math.max(0, Math.min(1, nx));
      state.watermark.y = Math.max(0, Math.min(1, ny));
      scheduleOverlay();
      return;
    }
    if (state.tool === 'watermark') {
      if (refs.wmPosition.value === 'custom' && !refs.wmTile.checked) {
        const display = currentDisplaySize();
        const rect = watermarkHandleRect(display);
        const inside =
          point.x >= rect.x - 8 &&
          point.x <= rect.x + rect.width + 8 &&
          point.y >= rect.y - 8 &&
          point.y <= rect.y + rect.height + 8;
        refs.overlayCanvas.style.cursor = inside ? 'move' : 'default';
      } else {
        refs.overlayCanvas.style.cursor = 'default';
      }
      return;
    }
    if (state.tool !== 'adjust' || adjustSection !== 'crop') {
      refs.overlayCanvas.style.cursor = 'default';
      return;
    }
    if (!kit) return;
    if (!drag) {
      const handle = state.crop.rect ? kit.hitCrop(state.crop.rect, point) : null;
      refs.overlayCanvas.style.cursor = handle
        ? handle === 'move'
          ? 'move'
          : `${handle}-resize`
        : 'crosshair';
      return;
    }
    if (drag.type === 'draw') {
      state.crop.rect = kit.createCrop(drag.start, point, drag.size, drag.ratio);
    } else if (drag.type === 'move') {
      state.crop.rect = kit.moveCrop(drag.origin, { x: point.x - drag.start.x, y: point.y - drag.start.y }, drag.size);
    } else {
      state.crop.rect = kit.resizeCrop(drag.origin, drag.handle, point, drag.size, drag.ratio);
    }
    scheduleOverlay();
  });

  function endDrag(event) {
    drag = null;
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    syncActionBar();
  }
  refs.overlayCanvas.addEventListener('pointerup', endDrag);
  refs.overlayCanvas.addEventListener('pointercancel', endDrag);

  // 水印自定义位置：方向键微调 1px，Shift 10px
  refs.overlayCanvas.addEventListener('keydown', (event) => {
    if (!state.source || state.tool !== 'watermark') return;
    if (refs.wmPosition.value !== 'custom' || refs.wmTile.checked) return;
    const display = currentDisplaySize();
    const step = event.shiftKey ? 10 : 1;
    const dx = step / display.width;
    const dy = step / display.height;
    let changed = true;
    if (event.key === 'ArrowLeft') state.watermark.x -= dx;
    else if (event.key === 'ArrowRight') state.watermark.x += dx;
    else if (event.key === 'ArrowUp') state.watermark.y -= dy;
    else if (event.key === 'ArrowDown') state.watermark.y += dy;
    else changed = false;
    if (!changed) return;
    event.preventDefault();
    state.watermark.x = Math.max(0, Math.min(1, state.watermark.x));
    state.watermark.y = Math.max(0, Math.min(1, state.watermark.y));
    render();
  });

  /** 幂等操作：重复提交同一目标不会产生新画面，直接拦掉。 */
  function isRepeatableNoop(op) {
    const prev = state.stagedOps[state.stagedOps.length - 1];
    if (!prev || prev.op !== op.op) return false;
    if (op.op === 'pad32') return true;
    if (op.op === 'resize') {
      return [
        'mode',
        'width',
        'height',
        'percent',
        'long_edge',
        'short_edge',
        'megapixels',
        'fit',
        'filter',
        'snap',
        'sharpen_after',
      ].every((key) => (prev[key] ?? null) === (op[key] ?? null));
    }
    return false;
  }

  function pushOp(op, label) {
    if (isRepeatableNoop(op)) {
      toastWarn('这一步与上一步相同，未重复记录');
      return false;
    }
    // 扩图预览是独立模式，一旦应用几何操作就回到普通处理
    if (state.outpaint.active) {
      state.outpaint.active = false;
      state.outpaint.result = null;
      refs.outpaintGo.disabled = true;
      refs.outpaintCancel.classList.add('hidden');
    }
    state.stagedOps.push({ ...op, label });
    if (state.stagedOps.length > 40) state.stagedOps.shift();
    state.crop.rect = null;
    // 应用任何操作后都不再自动生成待裁剪框，避免隐藏的二次裁切
    state.crop.suppressed = true;
    renderOps();
    render();
    return true;
  }

  function renderOps() {
    const ops = state.stagedOps;
    const kindLabels = {
      crop: '裁剪',
      rotate: '旋转',
      flip: '翻转',
      resize: '缩放',
      adjust: '调色',
      pad32: '对齐',
      grid: '宫格',
    };
    refs.opsCount.textContent = `${ops.length} 步`;
    refs.undo.disabled = !ops.length;
    refs.resetAll.disabled = !ops.length && !state.source;
    refs.stageCompare.disabled =
      !state.source || (!ops.length && !(state.outpaint.active && state.outpaint.result));
    if (!ops.length) {
      refs.opsList.innerHTML = '<div class="field-hint">还没有操作。裁剪/旋转/缩放/调色应用后会记录在这里。</div>';
      return;
    }
    refs.opsList.innerHTML = ops
      .map(
        (op, index) => `
        <div class="op-row" data-op-index="${index}" role="button" tabindex="0" title="点击回退到这一步之前">
          <span class="op-index mono">${String(index + 1).padStart(2, '0')}</span>
          <span class="op-label">${escapeHtml(op.label || kindLabels[op.op] || op.op)}</span>
          <span class="op-kind">${escapeHtml(kindLabels[op.op] || op.op)}</span>
        </div>`,
      )
      .join('');
    refs.opsList.querySelectorAll('[data-op-index]').forEach((row) => {
      const revert = () => {
        state.stagedOps = state.stagedOps.slice(0, Number(row.dataset.opIndex));
        state.crop.rect = null;
        renderOps();
        render();
        toast('已回退到该操作之前', 'info', { timeout: 1600 });
      };
      row.addEventListener('click', revert);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          revert();
        }
      });
    });
  }

  refs.undo.addEventListener('click', () => {
    if (!state.stagedOps.length) return;
    state.stagedOps.pop();
    state.crop.rect = null;
    renderOps();
    render();
  });
  refs.resetAll.addEventListener('click', () => {
    state.stagedOps = [];
    state.adjust = { ...NEUTRAL_ADJUST };
    state.outpaint.active = false;
    state.outpaint.result = null;
    state.outpaint.panoramaAspect = '';
    state.crop.rect = null;
    state.crop.ratioLabel = 'Free';
    state.crop.suppressed = false;
    refs.outpaintGo.disabled = true;
    refs.outpaintCancel.classList.add('hidden');
    syncPanoramaUi();
    renderRatios();
    renderAdjustFields();
    renderOps();
    updateOutpaintSummary();
    render();
    syncActionBar();
    toast('已重置所有处理步骤', 'info', { timeout: 1800 });
  });

  refs.quickExport.addEventListener('click', () => {
    if (!state.source) return;
    state.tool = 'export';
    syncToolGroups();
    refs.format?.focus?.();
  });

  refs.stageCompare.addEventListener('click', async () => {
    if (!state.source) return;
    if (!state.stagedOps.length && !(state.outpaint.active && state.outpaint.result)) {
      toastWarn('还没有编辑，当前就是原图');
      return;
    }
    if (workStale()) await render();
    if (!workCanvas || !sourceImage) return;

    // 参考图停在「第一次缩放」之前：缩放会改变画面尺寸，若把 resize 也应用到参考图，
    // 两张图会被 fit 成同样的显示大小，用户看到的就是 0 差异（对比失效）。
    const firstResize = state.stagedOps.findIndex((op) => op.op === 'resize');
    const referenceOps =
      firstResize >= 0 ? state.stagedOps.slice(0, firstResize) : state.stagedOps;
    const geometryOps = referenceOps.filter((op) => op.op !== 'adjust');
    const referenceCanvas = geometryOps.length
      ? applyOpsToCanvas(sourceImage, geometryOps)
      : canvasFromImage(sourceImage);
    const referenceUrl = referenceCanvas.toDataURL('image/png');

    // Canvas 像素本身不含 CSS filter，对比前把调色烘焙进临时画布
    const currentCanvas = document.createElement('canvas');
    currentCanvas.width = workCanvas.width;
    currentCanvas.height = workCanvas.height;
    const currentCtx = currentCanvas.getContext('2d');
    const adjustOps = state.stagedOps.filter((op) => op.op === 'adjust');
    currentCtx.filter = adjustFilterString(adjustOps, null) || 'none';
    currentCtx.drawImage(workCanvas, 0, 0);
    const currentUrl = currentCanvas.toDataURL('image/png');

    openCompareDialog({
      references: [
        {
          url: referenceUrl,
          label: `编辑前（${fmtNum(referenceCanvas.width)}×${fmtNum(referenceCanvas.height)}）`,
        },
      ],
      results: [
        {
          url: currentUrl,
          label: `当前编辑（${fmtNum(currentWorkDims.width)}×${fmtNum(currentWorkDims.height)}）`,
        },
      ],
      initialResult: 0,
    });
  });

  refs.cropReset.addEventListener('click', () => {
    state.crop.rect = null;
    resetCrop();
    render();
  });

  refs.cropApply.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const pixel = pendingCropPixelRect();
    if (!pixel) {
      toastWarn('裁剪框已经是整张图，无需裁剪');
      return;
    }
    pushOp({ op: 'crop', ...pixel }, `裁剪 ${fmtNum(pixel.width)}×${fmtNum(pixel.height)}`);
    // 裁剪已生效：选框回到「整张新图」，比例切回自由，避免保存时再次裁切
    state.crop.ratioLabel = 'Free';
    state.crop.rect = null;
    state.crop.suppressed = true;
    state.crop.pendingReset = true;
    renderRatios();
    render();
    toastSuccess('已应用裁剪，裁剪框已重置为整图');
  });

  refs.gridEnabled.addEventListener('change', () => {
    state.crop.grid = refs.gridEnabled.checked;
    refs.gridOptions.classList.toggle('hidden', !state.crop.grid);
    render();
  });

  async function applyGrid() {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    if (!kit?.gridRects) {
      toastWarn('图像处理模块未就绪，请稍后重试');
      return;
    }
    const rows = Math.max(1, Math.min(10, Number(refs.gridRows.value) || 2));
    const columns = Math.max(1, Math.min(10, Number(refs.gridColumns.value) || 2));
    const rowGap = Math.max(0, Number(refs.gridRowGap.value) || 0);
    const columnGap = Math.max(0, Number(refs.gridColumnGap.value) || 0);
    if (rows * columns > 64) {
      toastWarn('宫格数量过多（最多 64 块）');
      return;
    }
    const ops = [...state.stagedOps, ...(pendingCropPixelRect() ? [pendingCropPixelRect()] : []), { op: 'grid', rows, columns, row_gap: rowGap, column_gap: columnGap }];
    await processAndSave(ops, { kind: 'grid', label: `宫格 ${rows}×${columns}`, button: refs.gridApply });
  }

  refs.gridApply.addEventListener('click', () => {
    applyGrid().catch((err) => toastError(err, '宫格切分失败'));
  });

  /* ============================================================
   * 几何 / 调色操作
   * ============================================================ */
  host.querySelectorAll('[data-rotate]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.source) {
        toastWarn('请先上传图片');
        return;
      }
      const angle = Number(button.dataset.rotate);
      pushOp({ op: 'rotate', angle }, angle > 0 ? '逆时针旋转 90°' : '顺时针旋转 90°');
    });
  });
  refs.rotateApply.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const angle = Number(refs.rotateAngle.value) || 0;
    if (!angle) {
      toastWarn('请输入旋转角度');
      return;
    }
    pushOp({ op: 'rotate', angle }, `旋转 ${angle}°`);
  });
  host.querySelectorAll('[data-flip]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.source) {
        toastWarn('请先上传图片');
        return;
      }
      const horizontal = button.dataset.flip === 'h';
      pushOp({ op: 'flip', horizontal, vertical: !horizontal }, horizontal ? '水平翻转' : '垂直翻转');
    });
  });

  function syncResizeInputs() {
    refs.resizeWidth.value = String(currentWorkDims.width || state.source?.width || 0);
    refs.resizeHeight.value = String(currentWorkDims.height || state.source?.height || 0);
    state.resize.width = currentWorkDims.width;
    state.resize.height = currentWorkDims.height;
    updateResizeHint();
  }
  function applyResize() {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const plan = resizePlan();
    if (!plan || plan.invalid) {
      toastWarn('请输入有效的缩放目标');
      return;
    }
    if (plan.width > 8192 || plan.height > 8192) {
      toastWarn(`输出尺寸 ${plan.width}×${plan.height} 超出 8192 上限`);
      return;
    }
    const common = {
      snap: plan.snap,
      filter: refs.resizeFilter.value || 'lanczos',
      sharpen_after: Math.max(0, Math.round(Number(refs.resizeSharpen.value) || 0)),
    };
    // 尺寸没变且没有锐化需求时，提交上去也不会产生新画面，直接拦住
    if (plan.width === plan.baseW && plan.height === plan.baseH && common.sharpen_after <= 0) {
      toastWarn(`输出尺寸与当前相同（${fmtNum(plan.width)} × ${fmtNum(plan.height)}），未新增操作`);
      return;
    }
    let pushed = false;
    if (plan.mode === 'exact') {
      const fit = refs.resizeFit.value || 'contain';
      pushed = pushOp(
        { op: 'resize', width: plan.width, height: plan.height, fit, ...common },
        `缩放到 ${fmtNum(plan.width)}×${fmtNum(plan.height)}（${fit}）`,
      );
    } else {
      const value = Number(refs.resizeModeValue.value) || 0;
      const meta = RESIZE_MODES[plan.mode];
      pushed = pushOp(
        { op: 'resize', mode: plan.mode, [plan.mode]: value, ...common },
        `缩放到 ${fmtNum(plan.width)}×${fmtNum(plan.height)}（${meta ? meta.label : plan.mode} ${value}）`,
      );
    }
    if (!pushed) return;
    state.resize.width = plan.width;
    state.resize.height = plan.height;
    // 应用后把比例型参数重置为「基于新尺寸」的等效值，避免连续点击变成二次缩小
    if (plan.mode !== 'exact') {
      const nextValue =
        plan.mode === 'percent'
          ? 100
          : plan.mode === 'long_edge'
            ? Math.max(plan.width, plan.height)
            : plan.mode === 'short_edge'
              ? Math.min(plan.width, plan.height)
              : Number(((plan.width * plan.height) / 1e6).toFixed(2));
      refs.resizeModeValue.value = String(nextValue);
    }
    toastSuccess(`已缩放到 ${fmtNum(plan.width)} × ${fmtNum(plan.height)}`);
  }
  refs.resizeApply.addEventListener('click', applyResize);
  refs.pad32Apply.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const width = currentWorkDims.width || state.source.width;
    const height = currentWorkDims.height || state.source.height;
    if (width % 32 === 0 && height % 32 === 0) {
      toastWarn(`当前 ${fmtNum(width)} × ${fmtNum(height)} 已是 32 的倍数`);
      return;
    }
    if (!pushOp({ op: 'pad32' }, '对齐 32')) return;
    toastSuccess(`已按 32 倍数补边到 ${fmtNum(snapUp(width, 32))} × ${fmtNum(snapUp(height, 32))}`);
  });
  refs.resizeLock.addEventListener('change', () => {
    state.resize.lock = refs.resizeLock.checked;
  });
  function bindResizeInput(input, other, key) {
    input.addEventListener('input', () => {
      if (state.resize.lock) {
        const baseW = currentWorkDims.width || state.source?.width || 1;
        const baseH = currentWorkDims.height || state.source?.height || 1;
        const aspect = baseW / baseH;
        if (key === 'width') {
          const width = Number(refs.resizeWidth.value) || 1;
          refs.resizeHeight.value = String(Math.max(1, Math.round(width / aspect)));
        } else {
          const height = Number(refs.resizeHeight.value) || 1;
          refs.resizeWidth.value = String(Math.max(1, Math.round(height * aspect)));
        }
      }
      updateResizeHint();
    });
  }
  bindResizeInput(refs.resizeWidth, refs.resizeHeight, 'width');
  bindResizeInput(refs.resizeHeight, refs.resizeWidth, 'height');
  refs.resizeFit.addEventListener('change', () => {
    state.resize.fit = refs.resizeFit.value;
  });

  refs.adjustApply.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const values = { ...state.adjust };
    const neutral =
      Math.abs(values.brightness - 1) < 1e-6 &&
      Math.abs(values.contrast - 1) < 1e-6 &&
      Math.abs(values.saturation - 1) < 1e-6 &&
      Math.abs(values.sharpness - 1) < 1e-6 &&
      Math.abs(values.temperature) < 1e-6;
    if (neutral) {
      toastWarn('调色参数都是默认值，无需应用');
      return;
    }
    pushOp({ op: 'adjust', ...values }, '调色');
    state.adjust = { ...NEUTRAL_ADJUST };
    renderAdjustFields();
    render();
    toastSuccess('已应用调色（后端落盘时按真实参数处理）');
  });
  refs.adjustReset.addEventListener('click', () => {
    state.adjust = { ...NEUTRAL_ADJUST };
    renderAdjustFields();
    render();
  });

  /* ============================================================
   * 高清放大（SeedVR2 / FlashVSR / VOSR2 任务队列）
   * ============================================================ */
  const UPSCALE_LABELS = {
    seedvr2: 'SeedVR2 7B · 质量优先',
    flashvsr: 'FlashVSR · 速度优先',
    vosr2: 'VOSR2 · 1.4B',
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  initUpscale();
  initTagger();

  async function initUpscale() {
    try {
      const data = await api.upscaleModels();
      if (disposed) return;
      state.upscale.models = data;
      renderUpscaleEngines();
    } catch (err) {
      if (disposed) return;
      refs.upscaleEngines.innerHTML =
        '<span class="field-hint">读取放大模型失败，请确认服务已启动。</span>';
      refs.upscaleHint.textContent = err?.message || String(err);
    }
    syncUpscaleButton();
  }

  function renderUpscaleEngines() {
    const data = state.upscale.models || {};
    const engines = Object.values(data.engines || {}).filter((engine) => engine.ready);
    if (!engines.length) {
      refs.upscaleEngines.innerHTML =
        '<span class="field-hint">没有可用的放大模型，请到「设置 → 图像放大」配置模型目录并扫描。</span>';
      state.upscale.engine = '';
      syncUpscaleButton();
      return;
    }
    const preferred = data.default_engine || engines[0].id;
    if (!engines.some((engine) => engine.id === state.upscale.engine)) {
      state.upscale.engine = preferred;
    }
    refs.upscaleEngines.innerHTML = engines
      .map(
        (engine) => `<button class="chip ${engine.id === state.upscale.engine ? 'active' : ''}"
          type="button" data-engine="${escapeHtml(engine.id)}">${escapeHtml(
          UPSCALE_LABELS[engine.id] || engine.label || engine.id,
        )}</button>`,
      )
      .join('');
    for (const chip of refs.upscaleEngines.querySelectorAll('[data-engine]')) {
      chip.addEventListener('click', () => {
        state.upscale.engine = chip.dataset.engine;
        renderUpscaleEngines();
      });
    }
    if (!state.upscale.touchedScale && [2, 4].includes(Number(data.defaults?.scale))) {
      state.upscale.scale = Number(data.defaults.scale);
      syncScaleChips();
    }
  }

  function syncScaleChips() {
    for (const chip of refs.upscaleScales.querySelectorAll('[data-scale]')) {
      chip.classList.toggle('active', Number(chip.dataset.scale) === state.upscale.scale);
    }
  }

  function syncUpscaleButton() {
    refs.upscaleGo.disabled =
      state.upscale.polling || !state.source || !state.upscale.engine;
  }

  function setUpscaleProgress(percent, label) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    refs.upscaleBar.style.width = `${value}%`;
    refs.upscaleStatus.textContent = label ? `${label}（${value}%）` : `${value}%`;
  }

  function finishUpscale() {
    state.upscale.polling = false;
    state.upscale.jobId = '';
    refs.upscaleCancel.classList.add('hidden');
    syncUpscaleButton();
  }

  function addUpscaleResults(job) {
    for (const image of job.images || []) {
      state.results.unshift({
        id: `up-${job.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        url: image.url,
        thumbUrl: image.thumb_url || image.url,
        width: image.width,
        height: image.height,
        filename: image.filename,
        kind: 'upscale',
        at: Date.now(),
      });
    }
    renderResults();
  }

  refs.upscaleScales.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-scale]');
    if (!chip) return;
    state.upscale.scale = Number(chip.dataset.scale) || 2;
    state.upscale.touchedScale = true;
    syncScaleChips();
  });

  refs.upscaleCompare.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const outputs = state.results
      .filter((item) => item.kind === 'upscale')
      .map((item) => ({
        url: item.url,
        label: `${item.filename || '放大结果'}（${fmtNum(item.width)}×${fmtNum(item.height)}）`,
      }));
    if (!outputs.length) {
      toastWarn('还没有放大结果，先运行一次放大');
      return;
    }
    openCompareDialog({
      references: [
        {
          url: state.source.dataUrl,
          label: `原图（${fmtNum(state.source.width)}×${fmtNum(state.source.height)}）`,
        },
      ],
      results: outputs,
      initialResult: 0,
    });
  });

  refs.upscaleGo.addEventListener('click', async () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    if (!state.upscale.engine) {
      toastWarn('没有可用的放大引擎，请先在设置里配置模型');
      return;
    }
    state.upscale.polling = true;
    refs.upscaleProgress.classList.remove('hidden');
    refs.upscaleCancel.classList.remove('hidden');
    setUpscaleProgress(0, '提交任务');
    syncUpscaleButton();
    try {
      const resp = await api.upscale({
        image: state.source.dataUrl,
        engine: state.upscale.engine,
        scale: state.upscale.scale,
      });
      state.upscale.jobId = resp.job_id;
      setUpscaleProgress(0, '排队中');
      await pollUpscaleJob(resp.job_id);
    } catch (err) {
      toastError(err, '放大失败');
      finishUpscale();
    }
  });

  refs.upscaleCancel.addEventListener('click', async () => {
    const jobId = state.upscale.jobId;
    if (!jobId) return;
    try {
      await api.cancelJob(jobId);
      toastWarn('已请求取消放大');
    } catch (err) {
      toastError(err, '取消失败');
    }
  });

  async function pollUpscaleJob(jobId) {
    while (!disposed && state.upscale.jobId === jobId) {
      let job;
      try {
        job = await api.job(jobId);
      } catch (err) {
        await sleep(1500);
        continue;
      }
      const progress = job.progress || {};
      const percent = progress.max
        ? (Number(progress.value) / Number(progress.max)) * 100
        : 0;
      const stage = progress.label || (job.status === 'queued' ? '排队中' : '放大中');
      setUpscaleProgress(percent, stage);

      if (job.status === 'done') {
        addUpscaleResults(job);
        const count = (job.images || []).length;
        setUpscaleProgress(100, '完成');
        toastSuccess(`放大完成：${count} 张已加入结果`);
        finishUpscale();
        return;
      }
      if (job.status === 'error') {
        const message = job.error?.message || job.error || '放大失败';
        toastError(new Error(message), '放大失败');
        finishUpscale();
        return;
      }
      if (job.status === 'canceled') {
        toastWarn('已取消放大');
        finishUpscale();
        return;
      }
      await sleep(1000);
    }
  }

  /* ============================================================
   * 反推提示词（WD14 / Danbooru）
   * ============================================================ */
  async function initTagger() {
    refs.taggerThreshold.value = String(state.tagger.threshold);
    refs.taggerThresholdVal.textContent = state.tagger.threshold.toFixed(2);
    refs.taggerCharThreshold.value = String(state.tagger.characterThreshold);
    refs.taggerCharThresholdVal.textContent = state.tagger.characterThreshold.toFixed(2);
    syncTaggerButton();
    try {
      const data = await api.taggerModels();
      if (disposed) return;
      renderTaggerModels(data);
    } catch (err) {
      if (disposed) return;
      refs.taggerModel.innerHTML = '<option value="">模型清单读取失败</option>';
      setTaggerStatus(`读取反推模型失败：${err?.message || err}`);
    }
  }

  function renderTaggerModels(data) {
    state.tagger.models = data;
    const models = data?.models || [];
    if (!models.length) {
      refs.taggerModel.innerHTML = '<option value="">没有可用模型</option>';
      setTaggerStatus('没有可用的反推模型，请确认服务端已安装 onnxruntime。');
      syncTaggerButton();
      return;
    }
    const preferred =
      models.find((item) => item.name === data.default && item.installed)?.name ||
      models.find((item) => item.installed)?.name ||
      data.default ||
      models[0].name;
    state.tagger.model = preferred;
    refs.taggerModel.innerHTML = models
      .map((item) => {
        const suffix = item.installed ? `已安装 · ${fmtNum(item.size_mb)} MB` : '需下载';
        return `<option value="${escapeHtml(item.name)}" ${
          item.name === preferred ? 'selected' : ''
        }>${escapeHtml(item.label)}（${suffix}）</option>`;
      })
      .join('');
    renderTaggerStatus();
    syncTaggerButton();
  }

  function renderTaggerStatus() {
    const current = (state.tagger.models?.models || []).find(
      (item) => item.name === state.tagger.model,
    );
    if (current?.installed) {
      setTaggerStatus(`已安装 · ${fmtNum(current.size_mb)} MB，可直接反推。`);
    } else {
      setTaggerStatus(
        current?.size_mb
          ? `首次反推会下载所选模型（约 ${fmtNum(current.size_mb)} MB），请保持网络畅通。`
          : '首次反推会下载所选模型（约 300MB～1GB），请保持网络畅通。',
      );
    }
  }

  function setTaggerStatus(text) {
    refs.taggerStatus.textContent = text;
  }

  function syncTaggerButton() {
    refs.taggerGo.disabled = state.tagger.busy || !state.source || !state.tagger.model;
    const hasPrompt = Boolean(state.tagger.result?.prompt);
    refs.taggerCopy.disabled = !hasPrompt;
    refs.taggerActions.classList.toggle('hidden', !hasPrompt);
  }

  refs.taggerModel.addEventListener('change', () => {
    state.tagger.model = refs.taggerModel.value;
    renderTaggerStatus();
    syncTaggerButton();
  });

  refs.taggerThreshold.addEventListener('input', () => {
    state.tagger.threshold = Number(refs.taggerThreshold.value);
    refs.taggerThresholdVal.textContent = state.tagger.threshold.toFixed(2);
  });

  refs.taggerCharThreshold.addEventListener('input', () => {
    state.tagger.characterThreshold = Number(refs.taggerCharThreshold.value);
    refs.taggerCharThresholdVal.textContent = state.tagger.characterThreshold.toFixed(2);
  });

  refs.taggerGo.addEventListener('click', async () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    if (!state.tagger.model) {
      toastWarn('没有可用的反推模型');
      return;
    }
    const installed = (state.tagger.models?.models || []).find(
      (item) => item.name === state.tagger.model,
    )?.installed;
    state.tagger.busy = true;
    setTaggerStatus(installed ? '正在反推标签…' : '首次使用，正在下载模型…');
    syncTaggerButton();
    try {
      const resp = await api.tagImage({
        image: state.source.dataUrl,
        model: state.tagger.model,
        threshold: state.tagger.threshold,
        character_threshold: state.tagger.characterThreshold,
        exclude_tags: refs.taggerExclude.value.trim(),
        replace_underscore: refs.taggerReplace.checked,
        trailing_comma: refs.taggerTrailing.checked,
      });
      if (disposed) return;
      state.tagger.busy = false;
      state.tagger.result = resp;
      refs.taggerResult.value = resp.prompt || '';
      const detail = `${resp.count} 个标签 · ${resp.model} · ${resp.elapsed_ms}ms`;
      setTaggerStatus(resp.downloaded ? `${detail}（模型已下载到 ${resp.model_dir}）` : detail);
      toastSuccess(`反推完成：${resp.count} 个标签`);
      syncTaggerButton();
    } catch (err) {
      if (disposed) return;
      state.tagger.busy = false;
      state.tagger.result = null;
      refs.taggerResult.value = '';
      setTaggerStatus(err?.message || String(err));
      toastError(err, '反推失败');
      syncTaggerButton();
    }
  });

  refs.taggerCopy.addEventListener('click', async () => {
    const prompt = state.tagger.result?.prompt;
    if (!prompt) return;
    const ok = await copyText(prompt);
    if (ok) toastSuccess('已复制反推提示词');
    else toastError(new Error('浏览器拒绝写入剪贴板'), '复制失败');
  });

  refs.taggerToT2i.addEventListener('click', () => {
    const prompt = state.tagger.result?.prompt;
    if (!prompt) return;
    try {
      setT2IHandoff({ prompt, toast: '已把反推提示词发送到文生图' });
      goToT2IPage();
    } catch (err) {
      toastError(err, '发送失败');
    }
  });

  refs.taggerToEdit.addEventListener('click', () => {
    const prompt = state.tagger.result?.prompt;
    if (!prompt || !state.source) return;
    try {
      setHandoff({
        images: [{ dataUrl: state.source.dataUrl, name: state.source.name }],
        prompt,
        toast: '已把图片与反推提示词送入图像编辑',
      });
      goToEditPage();
    } catch (err) {
      toastError(err, '发送失败');
    }
  });

  /* ============================================================
   * 水印 / 动图
   * ============================================================ */
  function currentOpsForServer() {
    const ops = [...state.stagedOps];
    const pending = pendingCropPixelRect();
    if (pending) ops.push(pending);
    return ops;
  }

  function addResultItems(items, kind) {
    for (const image of items) {
      state.results.unshift({
        id: `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        url: image.url,
        thumbUrl: image.thumb_url || image.url,
        width: image.width,
        height: image.height,
        filename: image.filename,
        kind,
        at: Date.now(),
      });
    }
    renderResults();
  }

  function loadWatermarkMark() {
    watermarkMarkImage = null;
    const data = state.watermark.markData;
    if (!data) {
      scheduleOverlay();
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (disposed) return;
      watermarkMarkImage = img;
      scheduleOverlay();
    };
    img.onerror = () => {
      watermarkMarkImage = null;
      scheduleOverlay();
    };
    img.src = data;
  }

  function syncWatermarkKind() {
    const isText = state.watermark.kind === 'text';
    refs.wmTextFields.classList.toggle('hidden', !isText);
    refs.wmImageFields.classList.toggle('hidden', isText);
    for (const chip of refs.wmKinds.querySelectorAll('[data-wm-kind]')) {
      chip.classList.toggle('active', chip.dataset.wmKind === state.watermark.kind);
    }
    if (!isText) loadWatermarkMark();
    scheduleOverlay();
  }
  refs.wmKinds.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-wm-kind]');
    if (!chip) return;
    state.watermark.kind = chip.dataset.wmKind;
    syncWatermarkKind();
  });
  syncWatermarkKind();

  refs.wmPosition.addEventListener('change', () => {
    const previous = state.watermark.position;
    const next = refs.wmPosition.value;
    if (next === 'custom') {
      const m = (Number(refs.wmMargin.value) || 0) / 100;
      const map = {
        'top-left': [m + 0.12, m + 0.1],
        top: [0.5, m + 0.1],
        'top-right': [1 - m - 0.12, m + 0.1],
        left: [m + 0.12, 0.5],
        center: [0.5, 0.5],
        right: [1 - m - 0.12, 0.5],
        'bottom-left': [m + 0.12, 1 - m - 0.1],
        bottom: [0.5, 1 - m - 0.1],
        'bottom-right': [1 - m - 0.12, 1 - m - 0.1],
      };
      const point = map[previous] || [0.5, 0.5];
      state.watermark.x = point[0];
      state.watermark.y = point[1];
    }
    state.watermark.position = next;
    if (state.source) render();
  });

  const wmRangeLabels = [
    [refs.wmOpacity, refs.wmOpacityVal, '%'],
    [refs.wmScale, refs.wmScaleVal, '%'],
    [refs.wmMargin, refs.wmMarginVal, '%'],
    [refs.wmStroke, refs.wmStrokeVal, ''],
    [refs.wmGapX, refs.wmGapXVal, '%'],
    [refs.wmGapY, refs.wmGapYVal, '%'],
  ];
  for (const [input, label, suffix] of wmRangeLabels) {
    const sync = () => { label.textContent = `${input.value}${suffix}`; };
    input.addEventListener('input', sync);
    input.addEventListener('input', scheduleOverlay);
    sync();
  }
  refs.wmText.addEventListener('input', () => {
    state.watermark.text = refs.wmText.value;
    scheduleOverlay();
  });
  refs.wmColor.addEventListener('input', scheduleOverlay);
  refs.wmFont.addEventListener('change', scheduleOverlay);
  refs.wmRotation.addEventListener('input', scheduleOverlay);
  refs.wmShadow.addEventListener('change', scheduleOverlay);
  refs.wmTileAngle.addEventListener('input', scheduleOverlay);
  refs.wmTile.addEventListener('change', () => {
    refs.wmTileFields.classList.toggle('hidden', !refs.wmTile.checked);
    scheduleOverlay();
  });
  refs.wmMarkPick.addEventListener('click', () => refs.wmMarkInput.click());
  refs.wmMarkInput.addEventListener('change', async () => {
    const file = refs.wmMarkInput.files?.[0];
    if (!file) return;
    state.watermark.markData = await fileToDataUrl(file);
    state.watermark.markName = file.name;
    refs.wmMarkName.textContent = file.name;
    loadWatermarkMark();
  });

  api.watermarkFonts()
    .then((result) => {
      const fonts = result?.fonts || [];
      state.watermark.fonts = fonts;
      refs.wmFont.innerHTML = fonts.length
        ? fonts.map((font, index) => `<option value="${escapeHtml(font.id)}"${index === 0 ? ' selected' : ''}>${escapeHtml(font.label)}</option>`).join('')
        : '<option value="">默认字体</option>';
      if (fonts.length) state.watermark.font = fonts[0].id;
      scheduleOverlay();
    })
    .catch(() => {
      refs.wmFont.innerHTML = '<option value="">默认字体</option>';
      scheduleOverlay();
    });

  function watermarkSpec() {
    const position = refs.wmPosition.value;
    const spec = {
      opacity: Number(refs.wmOpacity.value) / 100,
      scale: Number(refs.wmScale.value) / 100,
      rotation: Number(refs.wmRotation.value) || 0,
      position,
      margin: Number(refs.wmMargin.value) / 100,
      tile: {
        enabled: refs.wmTile.checked,
        gap_x: Number(refs.wmGapX.value) / 100,
        gap_y: Number(refs.wmGapY.value) / 100,
        angle: Number(refs.wmTileAngle.value) || 0,
      },
      shadow: refs.wmShadow.checked
        ? { blur: 0.008, dx: 0.004, dy: 0.004, color: '#00000099' }
        : null,
      stroke: { width: Number(refs.wmStroke.value) / 1000, color: '#000000' },
      ops: currentOpsForServer(),
      format: 'png',
    };
    if (position === 'custom') {
      spec.x = state.watermark.x;
      spec.y = state.watermark.y;
    }
    if (state.watermark.kind === 'text') {
      spec.text = refs.wmText.value.trim();
      spec.font = refs.wmFont.value || state.watermark.font;
      spec.color = refs.wmColor.value;
    } else if (state.watermark.markData) {
      spec.image_mark = {
        url: state.watermark.markData,
        scale: Number(refs.wmScale.value) / 100,
        opacity: 1,
      };
    }
    return spec;
  }

  refs.wmPreview.addEventListener('click', async () => {
    if (!state.source) { toastWarn('请先上传图片'); return; }
    const spec = watermarkSpec();
    if (!spec.text && !spec.image_mark) { toastWarn('请输入水印内容或选择 logo'); return; }
    refs.wmPreview.disabled = true;
    refs.wmHint.textContent = '正在生成服务端预览…';
    try {
      const result = await api.watermarkPreview({ image: state.source.dataUrl, ...spec });
      refs.wmPreviewImg.src = result.data_url;
      refs.wmPreviewBox.classList.remove('hidden');
      refs.wmHint.textContent = `预览 ${result.width}×${result.height}，与最终落盘一致。`;
    } catch (err) {
      toastError(err, '水印预览失败');
      refs.wmHint.textContent = '预览失败，检查字体/参数后重试。';
    } finally {
      refs.wmPreview.disabled = false;
    }
  });

  refs.wmApply.addEventListener('click', async () => {
    if (!state.source) { toastWarn('请先上传图片'); return; }
    const spec = watermarkSpec();
    if (!spec.text && !spec.image_mark) { toastWarn('请输入水印内容或选择 logo'); return; }
    const original = refs.wmApply.textContent;
    refs.wmApply.disabled = true;
    refs.wmApply.innerHTML = '<span class="spin"></span>处理中…';
    try {
      const result = await api.watermark({ images: [state.source.dataUrl], ...spec });
      addResultItems(result.images || [], 'watermark');
      toastSuccess(`水印完成：${(result.images || []).length} 张已加入结果`);
    } catch (err) {
      toastError(err, '加水印失败');
    } finally {
      refs.wmApply.disabled = false;
      refs.wmApply.textContent = original;
    }
  });

  function renderGifFrames() {
    const frames = state.gif.frames;
    if (!frames.length) {
      refs.gifFrames.innerHTML = '<span class="field-hint">还没有帧：添加本地图片，或把当前源图/结果加入。</span>';
      return;
    }
    refs.gifFrames.innerHTML = frames
      .map((frame, index) => `
        <span class="gif-frame" title="${escapeHtml(frame.name)}">
          <img src="${escapeHtml(frame.dataUrl)}" alt="" />
          <span class="gif-frame-index">${index + 1}</span>
          <button type="button" class="gif-frame-remove" data-gif-remove="${index}" aria-label="移除">×</button>
        </span>`)
      .join('');
  }
  function addGifFrame(dataUrl, name) {
    if (state.gif.frames.length >= 300) { toastWarn('最多 300 帧'); return; }
    state.gif.frames.push({ dataUrl, name });
    renderGifFrames();
  }
  renderGifFrames();
  refs.gifFrames.addEventListener('click', (event) => {
    const button = event.target.closest('[data-gif-remove]');
    if (!button) return;
    state.gif.frames.splice(Number(button.dataset.gifRemove), 1);
    renderGifFrames();
  });
  refs.gifAddFrames.addEventListener('click', () => refs.gifFrameInput.click());
  refs.gifFrameInput.addEventListener('change', async () => {
    const files = [...(refs.gifFrameInput.files || [])];
    for (const file of files) {
      try {
        addGifFrame(await fileToDataUrl(file), file.name);
      } catch (err) {
        toastError(err, '读取图片失败');
      }
    }
    refs.gifFrameInput.value = '';
  });
  refs.gifAddSource.addEventListener('click', () => {
    if (!state.source) { toastWarn('请先上传图片'); return; }
    addGifFrame(state.source.dataUrl, state.source.name);
  });

  function syncGifSource() {
    const isImages = state.gif.source === 'images';
    refs.gifImageFields.classList.toggle('hidden', !isImages);
    refs.gifVideoFields.classList.toggle('hidden', isImages);
    for (const chip of refs.gifSources.querySelectorAll('[data-gif-source]')) {
      chip.classList.toggle('active', chip.dataset.gifSource === state.gif.source);
    }
  }
  refs.gifSources.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-gif-source]');
    if (!chip) return;
    state.gif.source = chip.dataset.gifSource;
    syncGifSource();
  });
  syncGifSource();

  refs.gifVideoPick.addEventListener('click', () => refs.gifVideoInput.click());
  refs.gifVideoInput.addEventListener('change', async () => {
    const file = refs.gifVideoInput.files?.[0];
    if (!file) return;
    refs.gifVideoInfo.textContent = `上传中… ${file.name}`;
    state.gif.uploading = true;
    try {
      const result = await api.uploadVideo(file);
      state.gif.video = {
        relpath: result.relpath,
        url: result.url,
        name: file.name,
        info: result.info || {},
      };
      const duration = Number(result.info?.duration) || 0;
      if (duration) {
        refs.gifStart.value = '0';
        refs.gifEnd.value = String(Math.min(duration, 6).toFixed(1));
      }
      refs.gifVideoInfo.textContent = `${file.name} · ${duration.toFixed(1)}s · ${result.info?.width || '?'}×${result.info?.height || '?'} · ${result.info?.fps || '?'}fps`;
    } catch (err) {
      state.gif.video = null;
      refs.gifVideoInfo.textContent = '上传失败，重新选择视频。';
      toastError(err, '视频上传失败');
    } finally {
      state.gif.uploading = false;
      refs.gifVideoInput.value = '';
    }
  });

  function setGifProgress(percent, text, visible = true) {
    refs.gifProgress.classList.toggle('hidden', !visible);
    refs.gifBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (text) refs.gifStatus.textContent = text;
  }
  function finishGif() {
    state.gif.busy = false;
    state.gif.jobId = '';
    refs.gifGo.disabled = false;
    refs.gifCancel.classList.add('hidden');
  }

  refs.gifGo.addEventListener('click', async () => {
    if (state.gif.busy) return;
    const mode = refs.gifMode.value;
    let payload;
    if (state.gif.source === 'images') {
      if (!state.gif.frames.length) { toastWarn('请先添加至少 1 帧'); return; }
      payload = {
        source: 'images',
        images: state.gif.frames.map((frame) => frame.dataUrl),
        duration: Math.max(20, Number(refs.gifDuration.value) || 120),
        width: Number(refs.gifWidth.value) || 720,
        mode,
        loop: 0,
      };
    } else {
      if (!state.gif.video) { toastWarn('请先选择视频'); return; }
      const start = Number(refs.gifStart.value) || 0;
      const end = Number(refs.gifEnd.value) || 0;
      if (end <= start) { toastWarn('终点必须大于起点'); return; }
      payload = {
        source: 'video',
        path: state.gif.video.relpath,
        start,
        end,
        fps: Number(refs.gifFps.value) || 12,
        width: Number(refs.gifVideoWidth.value) || 720,
        mode,
      };
    }
    state.gif.busy = true;
    refs.gifGo.disabled = true;
    refs.gifCancel.classList.remove('hidden');
    setGifProgress(2, '提交任务…');
    try {
      const resp = await api.gif(payload);
      state.gif.jobId = resp.job_id;
      state.gif.status = resp.status || 'queued';
      await pollGifJob(resp.job_id);
    } catch (err) {
      toastError(err, 'GIF 任务提交失败');
      finishGif();
    }
  });

  refs.gifCancel.addEventListener('click', async () => {
    if (!state.gif.jobId) return;
    try {
      await api.cancelJob(state.gif.jobId);
      refs.gifStatus.textContent = '正在取消…';
    } catch (err) {
      toastError(err, '取消失败');
    }
  });

  async function pollGifJob(jobId) {
    while (!disposed && state.gif.jobId === jobId) {
      let job;
      try {
        job = await api.job(jobId);
      } catch {
        await sleep(1500);
        continue;
      }
      const progress = job.progress || {};
      const percent = progress.max ? (Number(progress.value) / Number(progress.max)) * 100 : 0;
      const stage = progress.label || (job.status === 'queued' ? '排队中' : '生成中');
      setGifProgress(percent, stage);
      if (job.status === 'done') {
        addResultItems(job.images || [], 'gif');
        toastSuccess(`GIF 完成：${(job.images || []).length} 个已加入结果`);
        setGifProgress(100, '完成');
        finishGif();
        return;
      }
      if (job.status === 'error') {
        toastError(new Error(job.error?.message || job.error || 'GIF 生成失败'), 'GIF 失败');
        finishGif();
        return;
      }
      if (job.status === 'canceled') {
        toastWarn('已取消 GIF');
        finishGif();
        return;
      }
      await sleep(1000);
    }
  }

  refs.gifSplit.addEventListener('click', async () => {
    if (!state.source) { toastWarn('请先上传 GIF'); return; }
    const isGif = /^data:image\/gif/i.test(state.source.dataUrl) || /\.gif$/i.test(state.source.name || '');
    if (!isGif) { toastWarn('当前源图不是 GIF'); return; }
    const original = refs.gifSplit.textContent;
    refs.gifSplit.disabled = true;
    refs.gifSplit.innerHTML = '<span class="spin"></span>拆帧中…';
    try {
      const result = await api.splitGif({ image: state.source.dataUrl, max_frames: 60 });
      addResultItems((result.images || []).map((item, index) => ({
        ...item,
        filename: item.filename || `gifframe-${index + 1}.png`,
      })), 'gif-frame');
      toastSuccess(`拆帧完成：${(result.images || []).length} 帧已加入结果`);
    } catch (err) {
      toastError(err, 'GIF 拆帧失败');
    } finally {
      refs.gifSplit.disabled = false;
      refs.gifSplit.textContent = original;
    }
  });

  /* ============================================================
   * 导出 / 结果
   * ============================================================ */
  refs.format.addEventListener('change', () => {
    state.format = refs.format.value;
    syncExportUi();
    updateEstimate();
  });
  refs.lossless.addEventListener('change', () => {
    syncExportUi();
    updateEstimate();
  });
  refs.quality.addEventListener('input', () => {
    state.quality = Number(refs.quality.value);
    refs.qualityVal.textContent = String(state.quality);
    updateEstimate();
  });

  refs.processApply.addEventListener('click', () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const ops = [...state.stagedOps];
    const pending = pendingCropPixelRect();
    if (pending) ops.push(pending);
    processAndSave(ops, { kind: 'process', label: '处理并保存' }).catch((err) => toastError(err, '处理失败'));
  });

  async function processAndSave(ops, { kind = 'process', label = '处理', button } = {}) {
    if (!state.source) throw new Error('请先上传图片');
    const trigger = button || refs.processApply;
    const original = trigger.textContent;
    trigger.disabled = true;
    trigger.innerHTML = '<span class="spin"></span>处理中…';
    refs.actionPrimary.disabled = true;
    refs.actionPrimary.textContent = '处理中…';
    try {
      const result = await api.processImage({
        image: state.source.dataUrl,
        ops,
        format: state.format,
        quality: state.quality,
        lossless: refs.lossless.checked,
        target_kb: Number(refs.targetKb.value) || undefined,
        background: refs.exportBg.value || '#ffffff',
        prefix: kind === 'grid' ? 'grid' : 'processed',
      });
      if (!result?.images?.length) throw new Error('后端没有返回图片');
      for (const image of result.images) {
        state.results.unshift({
          id: `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          url: image.url,
          thumbUrl: image.thumb_url || image.url,
          width: image.width,
          height: image.height,
          filename: image.filename,
          kind,
          at: Date.now(),
        });
      }
      renderResults();
      toastSuccess(`${label}完成：${result.images.length} 张${kind === 'grid' ? '宫格' : '结果'}已保存`);
    } finally {
      trigger.disabled = false;
      trigger.textContent = original;
      syncActionBar();
    }
  }

  function selectedResults() {
    return state.results.filter((item) => selectedResultIds.has(item.id));
  }

  function syncFilmSelectionUi() {
    const count = selectedResults().length;
    refs.filmSelected.textContent = count ? `已选 ${count} 张` : '未选择';
    for (const button of [refs.filmFavorite, refs.filmToEdit, refs.filmExport, refs.filmToGif]) {
      button.disabled = count === 0;
    }
  }

  function toggleResultSelection(id) {
    const selected = !selectedResultIds.has(id);
    if (selected) selectedResultIds.add(id);
    else selectedResultIds.delete(id);
    const card = refs.results.querySelector(`[data-result-id="${id}"]`);
    if (card) {
      card.classList.toggle('is-selected', selected);
      card.setAttribute('aria-selected', String(selected));
    }
    syncFilmSelectionUi();
  }

  function syncCompareButton() {
    const hasUpscale = state.results.some((item) => item.kind === 'upscale');
    refs.upscaleCompare.disabled = !state.source || !hasUpscale;
  }

  function renderResults() {
    syncCompareButton();
    for (const id of [...selectedResultIds]) {
      if (!state.results.some((item) => item.id === id)) selectedResultIds.delete(id);
    }
    refs.resultCount.textContent = `${state.results.length} 张`;
    syncFilmSelectionUi();
    if (!state.results.length) {
      refs.results.innerHTML = '<div class="field-hint">还没有处理结果。裁剪/缩放/调色/宫格处理后会显示在这里。</div>';
      return;
    }
    refs.results.innerHTML = state.results
      .map((item) => {
        const selected = selectedResultIds.has(item.id);
        return `
        <div class="tool-result-card${selected ? ' is-selected' : ''}" data-result-id="${escapeHtml(item.id)}"
             role="option" aria-selected="${selected}" tabindex="0" title="单击选择 · 双击查看大图">
          <div class="tool-result-thumb"><img src="${escapeHtml(item.thumbUrl)}" alt="" loading="lazy" /></div>
          <button class="tool-result-open" type="button" data-open-result="${escapeHtml(item.id)}" title="查看大图" aria-label="查看大图">⤢</button>
          <span class="tool-result-check" aria-hidden="true">✓</span>
          <div class="tool-result-meta">
            <span class="mono">${fmtNum(item.width)}×${fmtNum(item.height)}</span>
            <span class="kind">${RESULT_KIND_LABEL[item.kind] || '处理'}</span>
          </div>
        </div>`;
      })
      .join('');
    for (const card of refs.results.querySelectorAll('[data-result-id]')) {
      const item = state.results.find((entry) => entry.id === card.dataset.resultId);
      if (!item) continue;
      card.addEventListener('click', (event) => {
        if (event.target.closest('[data-open-result]')) return;
        toggleResultSelection(item.id);
      });
      card.addEventListener('dblclick', () => showResultModal(item));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleResultSelection(item.id);
        }
      });
    }
    for (const button of refs.results.querySelectorAll('[data-open-result]')) {
      const item = state.results.find((entry) => entry.id === button.dataset.openResult);
      if (!item) continue;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        showResultModal(item);
      });
    }
  }

  function showResultModal(item) {
    if (!item) return;
    const content = document.createElement('div');
    content.className = 'result-detail';
    content.innerHTML = `
      <div class="result-img-wrap"><img src="${escapeHtml(item.url)}" alt="" /></div>
      <div class="result-badges">
        <span class="badge info">${fmtNum(item.width)} × ${fmtNum(item.height)}</span>
        <span class="badge">${escapeHtml(item.filename || '')}</span>
      </div>`;
    openModal({
      title: '处理结果',
      subtitle: `${RESULT_KIND_LABEL[item.kind] || '图像处理'}输出`,
      size: 'lg',
      content,
      actions: [
        {
          label: '下载',
          kind: 'ghost',
          close: false,
          onClick: () => downloadUrl(item.url, item.filename || 'processed.png'),
        },
        {
          label: '收藏素材',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            try {
              await api.createMaterial({
                image: { url: item.url, filename: item.filename },
                title: item.filename || '',
                kind: 'upload',
              });
              toastSuccess('已收藏到素材仓库');
            } catch (err) {
              toastError(err, '收藏失败');
            }
          },
        },
        {
          label: '加入 GIF',
          kind: 'ghost',
          close: true,
          onClick: () => { addResultToGif(item); },
        },
        {
          label: '继续编辑',
          kind: 'ghost',
          onClick: async () => {
            try {
              const dataUrl = await urlToDataUrl(item.url);
              await setSourceFromDataUrl(dataUrl, item.filename || 'result.png');
              toastSuccess('已把结果设为当前源图，可继续处理');
            } catch (err) {
              toastError(err, '读取结果失败');
              return false;
            }
          },
        },
        {
          label: '送入图像编辑',
          kind: 'primary',
          onClick: async () => {
            try {
              const dataUrl = await urlToDataUrl(item.url);
              setHandoff({
                images: [{ dataUrl, name: item.filename || 'result.png' }],
                prompt: '',
                source: 'image-tools',
              });
              goToEditPage();
            } catch (err) {
              toastError(err, '送入编辑失败');
              return false;
            }
          },
        },
      ],
    });
  }

  async function addResultToGif(item) {
    try {
      const dataUrl = item.url.startsWith('data:') ? item.url : await urlToDataUrl(item.url);
      addGifFrame(dataUrl, item.filename || 'result.png');
      state.tool = 'gif';
      syncToolGroups();
      toastSuccess('已加入 GIF 帧');
    } catch (err) {
      toastError(err, '加入 GIF 失败');
    }
  }

  refs.clearResults.addEventListener('click', () => {
    state.results = [];
    selectedResultIds.clear();
    renderResults();
  });

  refs.filmSelectAll.addEventListener('click', () => {
    for (const item of state.results) selectedResultIds.add(item.id);
    renderResults();
  });

  refs.filmClearSelect.addEventListener('click', () => {
    selectedResultIds.clear();
    renderResults();
  });

  refs.filmFavorite.addEventListener('click', async () => {
    const items = selectedResults();
    if (!items.length) return;
    let saved = 0;
    for (const item of items) {
      try {
        await api.createMaterial({
          image: { url: item.url, filename: item.filename },
          title: item.filename || '',
          kind: 'upload',
        });
        saved += 1;
      } catch (err) {
        // 批量收藏时单张失败不打断其余
      }
    }
    if (saved) toastSuccess(`已收藏 ${saved} 张到素材仓库`);
    if (saved < items.length) toastWarn(`${items.length - saved} 张收藏失败`);
  });

  refs.filmToEdit.addEventListener('click', async () => {
    const items = selectedResults();
    if (!items.length) return;
    refs.filmToEdit.disabled = true;
    try {
      const images = [];
      for (const item of items) {
        images.push({
          dataUrl: await urlToDataUrl(item.url),
          name: item.filename || 'result.png',
        });
      }
      setHandoff({ images, prompt: '', source: 'image-tools' });
      goToEditPage();
    } catch (err) {
      toastError(err, '送入编辑失败');
    } finally {
      syncFilmSelectionUi();
    }
  });

  refs.filmExport.addEventListener('click', () => {
    const items = selectedResults();
    if (!items.length) return;
    items.forEach((item, index) => {
      window.setTimeout(
        () => downloadUrl(item.url, item.filename || `result-${index + 1}.png`),
        index * 180,
      );
    });
    toastSuccess(`开始导出 ${items.length} 张`);
  });

  refs.filmToGif.addEventListener('click', async () => {
    const items = selectedResults();
    if (!items.length) return;
    let added = 0;
    for (const item of items) {
      try {
        const dataUrl = item.url.startsWith('data:') ? item.url : await urlToDataUrl(item.url);
        addGifFrame(dataUrl, item.filename || 'result.png');
        added += 1;
      } catch (err) {
        // 单张失败不打断批量
      }
    }
    if (added) {
      state.tool = 'gif';
      syncToolGroups();
      toastSuccess(`已加入 ${added} 帧到 GIF`);
    } else {
      toastWarn('加入 GIF 失败');
    }
  });

  /* ============================================================
   * 扩图
   * ============================================================ */
  /** 按目标全景比例反推扩图方向与幅度（与后端 outpaint-plan 的 amount 语义一致）。 */
  function panoramaDirectionAmount(dims, aspect) {
    const [aw, ah] = String(aspect).split(':').map(Number);
    if (!aw || !ah || !dims?.width || !dims?.height) return null;
    const target = aw / ah;
    const current = dims.width / dims.height;
    if (Math.abs(current - target) < 0.002) return { direction: 'horizontal', amount: 0.05 };
    if (current < target) {
      const extra = (target * dims.height - dims.width) / dims.width;
      return { direction: 'horizontal', amount: Math.max(0.05, extra / 2) };
    }
    const extra = (dims.width / target - dims.height) / dims.height;
    return { direction: 'vertical', amount: Math.max(0.05, extra / 2) };
  }

  function syncPanoramaUi() {
    const active = Boolean(state.outpaint.panoramaAspect);
    for (const chip of refs.outpaintPano.querySelectorAll('[data-pano]')) {
      chip.classList.toggle('active', (chip.dataset.pano || '') === state.outpaint.panoramaAspect);
    }
    refs.outpaintAmount.disabled = active;
    for (const chip of refs.outpaintDirs.querySelectorAll('[data-dir]')) chip.disabled = active;
    refs.outpaintGo.textContent = active ? '带到编辑 · 全景' : '去局部重绘';
  }

  refs.outpaintPano.querySelectorAll('[data-pano]').forEach((button) => {
    button.addEventListener('click', () => {
      state.outpaint.panoramaAspect = button.dataset.pano || '';
      syncPanoramaUi();
      updateOutpaintSummary();
    });
  });

  refs.outpaintDirs.querySelectorAll('[data-dir]').forEach((button) => {
    button.addEventListener('click', () => {
      state.outpaint.direction = button.dataset.dir;
      for (const chip of refs.outpaintDirs.querySelectorAll('[data-dir]')) {
        chip.classList.toggle('active', chip === button);
      }
      updateOutpaintSummary();
    });
  });
  refs.outpaintAmount.addEventListener('input', () => {
    state.outpaint.amount = Number(refs.outpaintAmount.value) / 100;
    refs.outpaintAmountVal.textContent = `${Math.round(state.outpaint.amount * 100)}%`;
  });

  function updateOutpaintSummary() {
    if (!state.source) {
      refs.outpaintSummary.textContent = '上传图片后可规划扩图。';
      return;
    }
    const aspect = state.outpaint.panoramaAspect;
    if (state.outpaint.active && state.outpaint.result) {
      const result = state.outpaint.result;
      refs.outpaintSummary.textContent = `${aspect ? `全景 ${aspect} · ` : ''}已规划：新画布 ${fmtNum(
        result.width,
      )} × ${fmtNum(result.height)}，原图位于 (${Math.round(result.sourceRect.x)}, ${Math.round(
        result.sourceRect.y,
      )})，新增区域已生成遮罩。`;
      return;
    }
    if (aspect) {
      const dims = {
        width: currentWorkDims.width || state.source.width,
        height: currentWorkDims.height || state.source.height,
      };
      const resolved = panoramaDirectionAmount(dims, aspect);
      if (!resolved) {
        refs.outpaintSummary.textContent = `全景 ${aspect}：图片尺寸无效，无法规划。`;
        return;
      }
      refs.outpaintSummary.textContent = `全景 ${aspect}：自动${
        resolved.direction === 'horizontal' ? '向左右' : '向上下'
      }外扩（左右/上下各约 ${Math.round(resolved.amount * 100)}%），点击「规划扩图」预览；确认后带到图像编辑页生成。`;
      return;
    }
    refs.outpaintSummary.textContent = `方向「${OUTPAINT_DIRECTION_LABELS[state.outpaint.direction]}」· 幅度 ${Math.round(
      state.outpaint.amount * 100,
    )}%：点击「规划扩图」查看新画布与新增区域。`;
  }

  refs.outpaintPlan.addEventListener('click', async () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    if (state.outpaint.busy) return;
    state.outpaint.busy = true;
    const button = refs.outpaintPlan;
    const original = button.textContent;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>规划中…';
    try {
      const dims = {
        width: currentWorkDims.width || state.source.width,
        height: currentWorkDims.height || state.source.height,
      };
      const resolved = state.outpaint.panoramaAspect
        ? panoramaDirectionAmount(dims, state.outpaint.panoramaAspect)
        : null;
      const result = await planOutpaint({
        srcDataUrl: state.source.dataUrl,
        width: dims.width,
        height: dims.height,
        direction: resolved?.direction || state.outpaint.direction,
        amount: resolved?.amount ?? state.outpaint.amount,
      });
      state.outpaint.result = result;
      state.outpaint.active = true;
      state.crop.rect = null;
      refs.outpaintGo.disabled = false;
      refs.outpaintCancel.classList.remove('hidden');
      refs.stageEmpty.classList.add('hidden');
      updateOutpaintSummary();
      await render();
      toastSuccess(`扩图规划完成：${result.width} × ${result.height}`);
    } catch (err) {
      toastError(err, '扩图规划失败（后端接口可能尚未就绪）');
    } finally {
      state.outpaint.busy = false;
      button.disabled = false;
      button.textContent = original;
    }
  });

  refs.outpaintCancel.addEventListener('click', () => {
    state.outpaint.active = false;
    state.outpaint.result = null;
    refs.outpaintGo.disabled = true;
    refs.outpaintCancel.classList.add('hidden');
    updateOutpaintSummary();
    render();
  });

  /** 把当前处理状态（已应用的操作 + 待应用裁剪）落成一张图片。 */
  async function exportCurrentImage() {
    const ops = [...state.stagedOps];
    const pending = pendingCropPixelRect();
    if (pending) ops.push(pending);
    let dataUrl = '';
    let name = 'from-tools.png';
    try {
      const result = await api.processImage({ image: state.source.dataUrl, ops, format: 'png', quality: 92, prefix: 'to-edit' });
      const first = result?.images?.[0];
      if (!first?.url) throw new Error('后端未返回图片');
      dataUrl = await urlToDataUrl(first.url);
      name = first.filename || name;
    } catch (err) {
      console.warn('[imageTools] 后端处理不可用，使用本地预览结果', err);
      const image = await loadSourceImage();
      const canvas = ops.length ? applyOpsToCanvas(image, ops) : canvasFromImage(image);
      dataUrl = canvas.toDataURL('image/png');
      toastWarn('后端图像处理接口未就绪，已使用本地预览结果送入编辑');
    }
    return { dataUrl, name };
  }

  async function goOutpaintEdit() {
    const result = state.outpaint.result;
    if (!result) {
      toastWarn('请先点击「规划扩图」');
      return;
    }
    // 全景：把当前处理图交给编辑页的「全景」任务重新规划，
    // 不用预览画布，避免编辑页把已扩好的画布再当成源图。
    if (state.outpaint.panoramaAspect) {
      const { dataUrl, name } = await exportCurrentImage();
      setHandoff({
        images: [{ dataUrl, name }],
        mask: null,
        prompt: null,
        localEnabled: false,
        taskMode: 'panorama',
        panorama: { aspect: state.outpaint.panoramaAspect, long_side: 3072, wrap: false, seam_blend: 24 },
        toast: `已把图片送入图像编辑并选中「全景 ${state.outpaint.panoramaAspect}」`,
      });
      goToEditPage();
      return;
    }
    setHandoff({
      images: [{ dataUrl: result.dataUrl, name: 'outpaint.png' }],
      mask: result.maskDataUrl,
      prompt: result.prompt,
      localEnabled: true,
      toast: '已把扩图结果送入图像编辑：画布与「新增区域」遮罩已就绪，补一句编辑指令即可',
    });
    goToEditPage();
  }
  refs.outpaintGo.addEventListener('click', () => {
    goOutpaintEdit().catch((err) => toastError(err, '送入局部重绘失败'));
  });

  /* ============================================================
   * 送入图像编辑
   * ============================================================ */
  refs.sendEdit.addEventListener('click', async () => {
    if (!state.source) {
      toastWarn('请先上传图片');
      return;
    }
    const button = refs.sendEdit;
    const original = button.textContent;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>准备中…';
    try {
      if (state.outpaint.active && state.outpaint.result) {
        await goOutpaintEdit();
        return;
      }
      const { dataUrl, name } = await exportCurrentImage();
      setHandoff({
        images: [{ dataUrl, name }],
        mask: null,
        prompt: null,
        localEnabled: false,
        toast: '已把图像处理结果送入图像编辑（image_1）',
      });
      goToEditPage();
    } catch (err) {
      toastError(err, '送入图像编辑失败');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });

  /* ============================================================
   * 尺寸变化
   * ============================================================ */
  function onStageResize() {
    if (!state.source) return;
    const prev = state.crop.rect;
    render().then(() => {
      if (prev && state.crop.rect) {
        // 保留大概的裁剪位置（按比例缩放）
        void prev;
      }
    });
  }
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      onStageResize();
    });
    resizeObserver.observe(refs.stage);
  }
  window.addEventListener('resize', onStageResize);

  // 窄屏工具轨要粘在真实顶栏高度下方，而不是固定的 --topbar-h
  const topbarEl = document.querySelector('.topbar');
  const syncStickyTop = () => {
    const height = topbarEl ? topbarEl.getBoundingClientRect().height : 64;
    document.documentElement.style.setProperty('--tools-sticky-top', `${Math.round(height)}px`);
  };
  syncStickyTop();
  const topbarObserver =
    typeof ResizeObserver === 'function' && topbarEl ? new ResizeObserver(syncStickyTop) : null;
  topbarObserver?.observe(topbarEl);

  renderResults();
  renderOps();
  syncPanoramaUi();
  updateOutpaintSummary();
  updateEstimate();
  syncActionBar();

  return {
    onShow() {
      if (state.source) render();
    },
    destroy() {
      disposed = true;
      toastRoot?.classList.remove('tools-toast');
      if (overlayRaf) cancelAnimationFrame(overlayRaf);
      resizeObserver?.disconnect();
      topbarObserver?.disconnect();
      actionSyncObserver.disconnect();
      window.removeEventListener('resize', onStageResize);
      document.removeEventListener('paste', onPaste);
    },
  };
}
