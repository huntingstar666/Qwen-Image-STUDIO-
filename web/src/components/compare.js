/**
 * 图像对比弹窗。
 *
 * 交互：
 * 1. 先选择参考图与结果图；只有一张结果时不显示结果选择（自动使用）；
 * 2. 对比视图是「中间一条竖线」的可拖动滑块：左侧参考图、右侧结果图，逐像素对照；
 * 3. 右侧提供像素比对参数（容差、采样步长、差异视图、差异放大）与色彩比对参数
 *    （饱和度、亮度、对比度、色相），并可实时看到两图的亮度 / 饱和度 / 对比度 / 色温差异；
 * 4. 画布与统计都按同一套 contain 映射计算，宽高比不同也能正确对照重叠区域。
 */

import { openModal } from './modal.js';
import { toastWarn } from './toast.js';
import { escapeHtml, fmtNum } from '../utils.js';

const ZERO_ANALYSIS_WIDTH = 360;

/* ============================================================
 * 小工具
 * ============================================================ */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

function fitRect(iw, ih, w, h, scaleOverride) {
  if (!iw || !ih) return { x: 0, y: 0, w, h };
  const scale = scaleOverride || Math.min(w / iw, h / ih);
  const width = iw * scale;
  const height = ih * scale;
  return { x: (w - width) / 2, y: (h - height) / 2, w: width, h: height };
}

function colorFilter(sat, bright, contrast, hue) {
  const parts = [];
  if (sat !== 1) parts.push(`saturate(${sat})`);
  if (bright !== 1) parts.push(`brightness(${bright})`);
  if (contrast !== 1) parts.push(`contrast(${contrast})`);
  if (hue) parts.push(`hue-rotate(${hue}deg)`);
  return parts.join(' ') || 'none';
}

function meanColorStats(data, width, height, rect, step) {
  let count = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let lumSum = 0;
  let lumSq = 0;
  let satSum = 0;
  const x0 = Math.max(0, Math.floor(rect.x));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y0 = Math.max(0, Math.floor(rect.y));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 250) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sr += r;
      sg += g;
      sb += b;
      satSum += sat;
      lumSum += lum;
      lumSq += lum * lum;
      count += 1;
    }
  }
  if (!count) return { count: 0, lum: 0, sat: 0, contrast: 0, temp: 0 };
  const meanLum = lumSum / count;
  return {
    count,
    lum: meanLum * 255,
    sat: (satSum / count) * 100,
    contrast: Math.sqrt(Math.max(0, lumSq / count - meanLum * meanLum)) * 255,
    temp: ((sr - sb) / count) * 255,
  };
}

function delta(value, digits = 1) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}`;
}

/* ============================================================
 * 对比视图
 * ============================================================ */
function mountCompare(container, references, results, initialReference, initialResult, close) {
  let refIndex = Math.min(Math.max(0, initialReference), references.length - 1);
  let resIndex = Math.min(Math.max(0, initialResult), results.length - 1);

  const state = {
    split: 0.5,
    tol: 24,
    stride: 3,
    diffMode: false,
    actualScale: false,
    amp: 4,
    sat: 1,
    bright: 1,
    contrast: 1,
    hue: 0,
  };

  let refImg = null;
  let resImg = null;
  let loadToken = 0;
  let observer = null;
  let rafId = 0;

  const refOptions = references
    .map((item, index) => `<option value="${index}">${escapeHtml(item.label || `参考图 ${index + 1}`)}</option>`)
    .join('');
  const resOptions = results
    .map((item, index) => `<option value="${index}">${escapeHtml(item.label || `结果 ${index + 1}`)}</option>`)
    .join('');

  container.innerHTML = `
    <div class="cmp-view">
      <div class="cmp-main">
        <div class="cmp-switchbar">
          <label class="cmp-select ${references.length > 1 ? '' : 'hidden'}">
            <span>参考图</span>
            <select data-ref="refSelect">${refOptions}</select>
          </label>
          <label class="cmp-select ${results.length > 1 ? '' : 'hidden'}">
            <span>结果图</span>
            <select data-ref="resSelect">${resOptions}</select>
          </label>
          <span class="spacer"></span>
          <label class="cmp-toggle" title="按两图真实像素大小显示，缩放前后差异一眼可见">
            <input type="checkbox" data-ref="actualScale" />
            <span>真实比例</span>
          </label>
          <span class="cmp-tip">拖动竖线 / ← → 逐像素对照</span>
        </div>
        <div class="cmp-stage" data-ref="stage" tabindex="0" aria-label="图像对比画布：左右拖动中缝">
          <canvas data-ref="canvas"></canvas>
          <div class="cmp-line" data-ref="line"><span class="cmp-knob">⇔</span></div>
          <span class="cmp-tag left">参考图</span>
          <span class="cmp-tag right">结果图</span>
          <div class="cmp-loading" data-ref="loading"><span class="spin"></span> 加载图片…</div>
        </div>
        <div class="cmp-names">
          <span class="mono" data-ref="refName"></span>
          <span class="mono" data-ref="resName"></span>
        </div>
      </div>

      <aside class="cmp-side">
        <section class="cmp-block">
          <div class="cmp-block-head">像素比对</div>
          <label class="cmp-range">
            <span>容差 <b data-ref="tolVal">24</b></span>
            <input type="range" min="0" max="128" step="1" value="24" data-ref="tol" />
          </label>
          <label class="cmp-range">
            <span>采样步长 <b data-ref="strideVal">3 px</b></span>
            <input type="range" min="1" max="12" step="1" value="3" data-ref="stride" />
          </label>
          <label class="cmp-switch">
            <input type="checkbox" data-ref="diffMode" />
            <span class="cmp-check"></span>
            <span>差异视图（右侧显示差值热图）</span>
          </label>
          <label class="cmp-range">
            <span>差异放大 <b data-ref="ampVal">4×</b></span>
            <input type="range" min="1" max="12" step="1" value="4" data-ref="amp" />
          </label>
        </section>

        <details class="cmp-block cmp-fold">
          <summary class="cmp-block-head">色彩比对 <span class="cmp-block-sub">结果图校正</span></summary>
          <div class="cmp-fold-body">
            <label class="cmp-range">
              <span>饱和度 <b data-ref="satVal">100%</b></span>
              <input type="range" min="0" max="200" step="1" value="100" data-ref="sat" />
            </label>
            <label class="cmp-range">
              <span>亮度 <b data-ref="brightVal">100%</b></span>
              <input type="range" min="40" max="180" step="1" value="100" data-ref="bright" />
            </label>
            <label class="cmp-range">
              <span>对比度 <b data-ref="contrastVal">100%</b></span>
              <input type="range" min="40" max="200" step="1" value="100" data-ref="contrast" />
            </label>
            <label class="cmp-range">
              <span>色相 <b data-ref="hueVal">0°</b></span>
              <input type="range" min="-45" max="45" step="1" value="0" data-ref="hue" />
            </label>
            <button class="btn ghost sm block" type="button" data-ref="resetColor">恢复原始色彩</button>
          </div>
        </details>

        <section class="cmp-block cmp-result-block">
          <div class="cmp-block-head">比对结果 <span class="cmp-badge" data-ref="badge"></span></div>
          <div class="cmp-stats" data-ref="stats">计算中…</div>
        </section>
      </aside>
    </div>`;

  const ref = (name) => container.querySelector(`[data-ref="${name}"]`);
  const stage = ref('stage');
  const canvas = ref('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const line = ref('line');
  const loading = ref('loading');
  const diffCanvas = document.createElement('canvas');
  const analysis = document.createElement('canvas');

  const colorFilterNow = () => colorFilter(state.sat, state.bright, state.contrast, state.hue);

  const refSelect = ref('refSelect');
  const resSelect = ref('resSelect');
  if (refSelect) refSelect.value = String(refIndex);
  if (resSelect) resSelect.value = String(resIndex);

  function applySplit() {
    line.style.left = `${state.split * 100}%`;
    draw();
  }

  function resizeCanvas() {
    const width = Math.max(1, Math.round(stage.clientWidth));
    const height = Math.max(1, Math.round(stage.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /** 「真实比例」下的公共缩放：两图按同一像素比例绘制，缩略图大小直接反映尺寸差。 */
  function sharedScale(width, height) {
    if (!state.actualScale || !refImg || !resImg) return 0;
    const maxW = Math.max(refImg.naturalWidth, resImg.naturalWidth);
    const maxH = Math.max(refImg.naturalHeight, resImg.naturalHeight);
    if (!maxW || !maxH) return 0;
    return Math.min(width / maxW, height / maxH);
  }

  function draw() {
    if (!refImg || !resImg) return;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    const scale = sharedScale(width, height);
    const refRect = fitRect(refImg.naturalWidth, refImg.naturalHeight, width, height, scale || undefined);
    const resRect = fitRect(resImg.naturalWidth, resImg.naturalHeight, width, height, scale || undefined);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(refImg, refRect.x, refRect.y, refRect.w, refRect.h);

    const splitX = width * state.split;
    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, 0, width - splitX, height);
    ctx.clip();
    if (state.diffMode) {
      drawDiff(width, height, refRect, resRect);
    } else {
      ctx.filter = colorFilterNow();
      ctx.drawImage(resImg, resRect.x, resRect.y, resRect.w, resRect.h);
      ctx.filter = 'none';
    }
    ctx.restore();
  }

  function drawDiff(width, height, refRect, resRect) {
    diffCanvas.width = Math.max(1, Math.round(width));
    diffCanvas.height = Math.max(1, Math.round(height));
    const dctx = diffCanvas.getContext('2d');
    dctx.clearRect(0, 0, width, height);
    dctx.drawImage(refImg, refRect.x, refRect.y, refRect.w, refRect.h);
    dctx.globalCompositeOperation = 'difference';
    dctx.filter = colorFilterNow();
    dctx.drawImage(resImg, resRect.x, resRect.y, resRect.w, resRect.h);
    dctx.filter = 'none';
    dctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.filter = `brightness(${state.amp}) saturate(1.15)`;
    ctx.drawImage(diffCanvas, 0, 0, width, height);
    ctx.restore();
  }

  function analyze() {
    if (!refImg || !resImg) return;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (!stageWidth || !stageHeight) return;

    const width = Math.min(ZERO_ANALYSIS_WIDTH, Math.max(80, Math.round(stageWidth)));
    const height = Math.max(1, Math.round(width * (stageHeight / stageWidth)));
    analysis.width = width;
    analysis.height = height;
    const actx = analysis.getContext('2d', { willReadFrequently: true });
    const scale = sharedScale(width, height);
    const refRect = fitRect(refImg.naturalWidth, refImg.naturalHeight, width, height, scale || undefined);
    const resRect = fitRect(resImg.naturalWidth, resImg.naturalHeight, width, height, scale || undefined);

    actx.clearRect(0, 0, width, height);
    actx.drawImage(refImg, refRect.x, refRect.y, refRect.w, refRect.h);
    let refData;
    let resData;
    try {
      refData = actx.getImageData(0, 0, width, height).data;
      actx.clearRect(0, 0, width, height);
      actx.save();
      actx.filter = colorFilterNow();
      actx.drawImage(resImg, resRect.x, resRect.y, resRect.w, resRect.h);
      actx.restore();
      resData = actx.getImageData(0, 0, width, height).data;
    } catch {
      ref('stats').textContent = '无法读取像素（图片可能来自跨域地址）';
      return;
    }

    const x0 = Math.max(0, Math.ceil(Math.max(refRect.x, resRect.x)));
    const x1 = Math.min(width, Math.floor(Math.min(refRect.x + refRect.w, resRect.x + resRect.w)));
    const y0 = Math.max(0, Math.ceil(Math.max(refRect.y, resRect.y)));
    const y1 = Math.min(height, Math.floor(Math.min(refRect.y + refRect.h, resRect.y + resRect.h)));

    let samples = 0;
    let sum = 0;
    let max = 0;
    let above = 0;
    const step = state.stride;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        if (refData[i + 3] < 250 || resData[i + 3] < 250) continue;
        const diff =
          (Math.abs(refData[i] - resData[i]) +
            Math.abs(refData[i + 1] - resData[i + 1]) +
            Math.abs(refData[i + 2] - resData[i + 2])) /
          3;
        samples += 1;
        sum += diff;
        if (diff > max) max = diff;
        if (diff > state.tol) above += 1;
      }
    }

    const refColor = meanColorStats(refData, width, height, refRect, step);
    const resColor = meanColorStats(resData, width, height, resRect, step);
    renderStats({
      samples,
      mean: samples ? sum / samples : 0,
      max,
      above,
      refColor,
      resColor,
      sizeInfo: {
        refW: refImg.naturalWidth,
        refH: refImg.naturalHeight,
        resW: resImg.naturalWidth,
        resH: resImg.naturalHeight,
      },
    });
  }

  function renderStats({ samples, mean, max, above, refColor, resColor, sizeInfo }) {
    const abovePct = samples ? (above / samples) * 100 : 0;
    const badge = ref('badge');
    let level = '低差异';
    let levelClass = 'ok';
    if (mean >= 15) {
      level = '高差异';
      levelClass = 'bad';
    } else if (mean >= 5) {
      level = '中差异';
      levelClass = 'warn';
    }
    badge.textContent = level;
    badge.className = `cmp-badge ${levelClass}`;

    const rows = [
      ['亮度', refColor.lum, resColor.lum, 0],
      ['饱和度', refColor.sat, resColor.sat, 1],
      ['对比度', refColor.contrast, resColor.contrast, 1],
      ['色温 R−B', refColor.temp, resColor.temp, 0],
    ];

    const sizeDiffer =
      sizeInfo && (sizeInfo.refW !== sizeInfo.resW || sizeInfo.refH !== sizeInfo.resH);
    const areaPct = sizeDiffer
      ? ((sizeInfo.resW * sizeInfo.resH) / Math.max(1, sizeInfo.refW * sizeInfo.refH)) * 100
      : 100;
    const sizeRow = sizeDiffer
      ? `<div class="cmp-metric"><span>尺寸变化</span><b>${fmtNum(sizeInfo.refW)}×${fmtNum(
          sizeInfo.refH,
        )} → ${fmtNum(sizeInfo.resW)}×${fmtNum(sizeInfo.resH)} <em>${areaPct.toFixed(0)}%</em></b></div>`
      : '';

    ref('stats').innerHTML = `
      <div class="cmp-metric"><span>平均像素差异</span><b>${samples ? mean.toFixed(1) : '—'} <em>/ 255</em></b></div>
      <div class="cmp-metric"><span>最大像素差异</span><b>${samples ? max.toFixed(0) : '—'}</b></div>
      <div class="cmp-metric"><span>超容差像素</span><b>${samples ? abovePct.toFixed(1) + '%' : '—'}</b></div>
      <div class="cmp-metric"><span>采样点</span><b>${fmtNum(samples)}</b></div>
      ${sizeRow}
      <table class="cmp-table">
        <thead><tr><th>指标</th><th>参考</th><th>结果</th><th>Δ</th></tr></thead>
        <tbody>
          ${rows
            .map(
              ([label, refValue, resValue, digits]) => `
              <tr>
                <td>${label}</td>
                <td class="mono">${Number(refValue).toFixed(digits)}</td>
                <td class="mono">${Number(resValue).toFixed(digits)}</td>
                <td class="mono ${Math.abs(resValue - refValue) >= (digits ? 5 : 3) ? 'is-diff' : ''}">${delta(resValue - refValue, digits)}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <div class="cmp-hint">${
        state.actualScale
          ? '真实比例用于观察缩放前后的大小差异；像素差异请取消勾选「真实比例」后查看。'
          : '统计基于两图重叠区域与当前采样步长；结果图校正参数会实时计入。'
      }</div>`;
  }

  function schedule(full = true) {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      draw();
      if (full) analyze();
    });
  }

  async function loadPair() {
    const token = ++loadToken;
    loading.classList.remove('hidden');
    loading.innerHTML = '<span class="spin"></span> 加载图片…';
    try {
      const [nextRef, nextRes] = await Promise.all([
        loadImage(references[refIndex].url),
        loadImage(results[resIndex].url),
      ]);
      if (token !== loadToken) return;
      refImg = nextRef;
      resImg = nextRes;
      loading.classList.add('hidden');
      ref('refName').textContent = references[refIndex].label || `参考图 ${refIndex + 1}`;
      ref('resName').textContent = results[resIndex].label || `结果 ${resIndex + 1}`;
      if (refSelect) refSelect.value = String(refIndex);
      if (resSelect) resSelect.value = String(resIndex);
      resizeCanvas();
      analyze();
    } catch (err) {
      if (token !== loadToken) return;
      loading.innerHTML = '图片加载失败，请关闭后重试';
    }
  }

  /* ---------------- 参数 ---------------- */
  function bindRange(name, key, labelName, format, full = true) {
    const input = ref(name);
    const label = ref(labelName);
    const sync = () => {
      const value = Number(input.value);
      label.textContent = format(value);
      if (key === 'sat') state.sat = value / 100;
      else if (key === 'bright') state.bright = value / 100;
      else if (key === 'contrast') state.contrast = value / 100;
      else if (key === 'hue') state.hue = value;
      else state[key] = value;
      schedule(full);
    };
    input.addEventListener('input', sync);
  }

  bindRange('tol', 'tol', 'tolVal', (v) => String(v));
  bindRange('stride', 'stride', 'strideVal', (v) => `${v} px`);
  bindRange('amp', 'amp', 'ampVal', (v) => `${v}×`, false);
  bindRange('sat', 'sat', 'satVal', (v) => `${v}%`);
  bindRange('bright', 'bright', 'brightVal', (v) => `${v}%`);
  bindRange('contrast', 'contrast', 'contrastVal', (v) => `${v}%`);
  bindRange('hue', 'hue', 'hueVal', (v) => `${v}°`);

  ref('diffMode').addEventListener('change', (event) => {
    state.diffMode = event.target.checked;
    schedule(false);
  });

  ref('actualScale').addEventListener('change', (event) => {
    state.actualScale = event.target.checked;
    schedule(true);
  });

  ref('resetColor').addEventListener('click', () => {
    state.sat = 1;
    state.bright = 1;
    state.contrast = 1;
    state.hue = 0;
    ref('sat').value = '100';
    ref('bright').value = '100';
    ref('contrast').value = '100';
    ref('hue').value = '0';
    ref('satVal').textContent = '100%';
    ref('brightVal').textContent = '100%';
    ref('contrastVal').textContent = '100%';
    ref('hueVal').textContent = '0°';
    schedule(true);
  });

  if (refSelect) {
    refSelect.addEventListener('change', () => {
      refIndex = Number(refSelect.value) || 0;
      loadPair();
    });
  }
  if (resSelect) {
    resSelect.addEventListener('change', () => {
      resIndex = Number(resSelect.value) || 0;
      loadPair();
    });
  }

  /* ---------------- 拖动竖线 ---------------- */
  function updateSplitFromEvent(event) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    state.split = Math.min(0.98, Math.max(0.02, (event.clientX - rect.left) / rect.width));
    applySplit();
  }

  let dragging = false;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
    updateSplitFromEvent(event);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    updateSplitFromEvent(event);
  });
  const stopDrag = () => {
    dragging = false;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('dblclick', () => {
    state.split = 0.5;
    applySplit();
  });
  stage.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      state.split = Math.min(0.98, Math.max(0.02, state.split + (event.key === 'ArrowLeft' ? -0.02 : 0.02)));
      applySplit();
    } else if (event.key === 'Home') {
      event.preventDefault();
      state.split = 0.02;
      applySplit();
    } else if (event.key === 'End') {
      event.preventDefault();
      state.split = 0.98;
      applySplit();
    }
  });

  observer = new ResizeObserver(() => {
    resizeCanvas();
    analyze();
  });
  observer.observe(stage);

  line.style.left = `${state.split * 100}%`;
  loadPair();

  return () => {
    observer?.disconnect();
    if (rafId) cancelAnimationFrame(rafId);
    loadToken += 1;
    void close;
  };
}

/* ============================================================
 * 选择参考图 / 结果图
 * ============================================================ */
function mountPicker(container, references, results, initialReference, initialResult, onConfirm, onCancel) {
  let refIndex = Math.min(Math.max(0, initialReference), references.length - 1);
  let resIndex = Math.min(Math.max(0, initialResult), results.length - 1);
  const showRefs = references.length > 1;
  const showResults = results.length > 1;

  const thumbs = (items, kind, active) =>
    items
      .map(
        (item, index) => `
        <button class="cmp-thumb ${index === active ? 'active' : ''}" type="button" data-kind="${kind}" data-index="${index}">
          <img src="${escapeHtml(item.url)}" alt="" loading="lazy" />
          <span>${escapeHtml(item.label || `${kind === 'ref' ? '参考图' : '结果'} ${index + 1}`)}</span>
        </button>`,
      )
      .join('');

  container.innerHTML = `
    <div class="cmp-picker">
      <div class="cmp-picker-hint">选择要比对的参考图与结果图；只有一张结果时会自动选中。</div>
      <div class="cmp-picker-cols">
        <section class="cmp-picker-col ${showRefs ? '' : 'hidden'}">
          <header>参考图 <span>${references.length} 张</span></header>
          <div class="cmp-thumbs" data-ref="refThumbs">${thumbs(references, 'ref', refIndex)}</div>
        </section>
        <section class="cmp-picker-col ${showResults ? '' : 'hidden'}">
          <header>结果图 <span>${results.length} 张</span></header>
          <div class="cmp-thumbs" data-ref="resThumbs">${thumbs(results, 'res', resIndex)}</div>
        </section>
      </div>
      <div class="cmp-picker-selected" data-ref="summary"></div>
      <div class="cmp-picker-foot">
        <button class="btn ghost" type="button" data-ref="cancel">取消</button>
        <button class="btn primary" type="button" data-ref="start">开始对比</button>
      </div>
    </div>`;

  const ref = (name) => container.querySelector(`[data-ref="${name}"]`);

  const syncSummary = () => {
    const refLabel = references[refIndex]?.label || `参考图 ${refIndex + 1}`;
    const resLabel = results[resIndex]?.label || `结果 ${resIndex + 1}`;
    ref('summary').innerHTML = `<span>参考图</span><b>${escapeHtml(refLabel)}</b><span class="cmp-arrow">⇄</span><span>结果图</span><b>${escapeHtml(resLabel)}</b>`;
  };

  container.querySelectorAll('[data-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      const index = Number(button.dataset.index);
      if (kind === 'ref') refIndex = index;
      else resIndex = index;
      const scope = kind === 'ref' ? 'refThumbs' : 'resThumbs';
      ref(scope)
        .querySelectorAll('[data-index]')
        .forEach((node) => node.classList.toggle('active', Number(node.dataset.index) === index));
      syncSummary();
    });
  });

  ref('cancel').addEventListener('click', onCancel);
  ref('start').addEventListener('click', () => onConfirm(refIndex, resIndex));
  syncSummary();
}

/* ============================================================
 * 对外入口
 * ============================================================ */
/**
 * @param {{references?: Array<{url:string,label?:string}>, results?: Array<{url:string,label?:string}>, initialReference?:number, initialResult?:number}} options
 */
export function openCompareDialog({
  references = [],
  results = [],
  initialReference = 0,
  initialResult = 0,
} = {}) {
  const refs = references.filter((item) => item?.url);
  const outs = results.filter((item) => item?.url);
  if (!refs.length) {
    toastWarn('没有可用的参考图，请先上传参考图');
    return null;
  }
  if (!outs.length) {
    toastWarn('还没有生成结果，先运行一次再对比');
    return null;
  }

  const content = document.createElement('div');
  content.className = 'cmp-dialog';
  let dispose = () => {};

  const modal = openModal({
    title: '图像对比',
    subtitle: '拖动中间竖线逐像素对照；右侧可调像素与色彩参数',
    size: 'lg',
    dialogClass: 'compare-modal',
    hideFooter: true,
    content,
    onClose: () => {
      dispose();
      dispose = () => {};
    },
  });

  const startCompare = (refIndex, resIndex) => {
    dispose();
    dispose = mountCompare(content, refs, outs, refIndex, resIndex, () => modal.close());
  };

  if (refs.length <= 1 && outs.length <= 1) {
    startCompare(
      Math.min(Math.max(0, initialReference), refs.length - 1),
      Math.min(Math.max(0, initialResult), outs.length - 1),
    );
  } else {
    mountPicker(
      content,
      refs,
      outs,
      initialReference,
      initialResult,
      startCompare,
      () => modal.close(),
    );
  }

  return { close: () => modal.close() };
}
