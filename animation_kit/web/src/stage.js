// 舞台：透明棋盘、整数坐标合成、洋葱皮、辅助线、适应/缩放。
// 几何计算与后端 core/compose.py 保持同一顺序：缩放 → 旋转 → 画布适配 → 位移。

import {
  getSelectedFrame, playbackFrame, state, subscribe, visibleFrames,
} from './store.js';

const cache = new Map();
const loading = new Set();
let canvas = null;
let ctx = null;
let board = null;
let viewport = null;
let empty = null;
let badge = null;
let tintCanvas = null;
let drawQueued = false;

function load(url) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);
  if (loading.has(url)) return null;
  loading.add(url);
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    loading.delete(url);
    cache.set(url, image);
    requestDraw();
  };
  image.onerror = () => {
    loading.delete(url);
    cache.set(url, null);
    requestDraw();
  };
  image.src = url;
  return null;
}

function preload() {
  const frames = state.doc?.frames || [];
  frames.forEach((frame) => load(frame.url));
  frames.forEach((frame) => { if (frame.sourceUrl) load(frame.sourceUrl); });
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function placement(image, frame, canvasW, canvasH) {
  const fit = state.doc?.canvas?.fit || 'contain';
  const anchor = state.doc?.canvas?.anchor || 'center';
  const scale = Number(frame.scale) || 1;
  const sourceW = image?.naturalWidth || Number(frame.width) || canvasW;
  const sourceH = image?.naturalHeight || Number(frame.height) || canvasH;
  const scaledW = Math.max(1, Math.round(sourceW * scale));
  const scaledH = Math.max(1, Math.round(sourceH * scale));
  const rotation = ((Number(frame.rotation) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const boundW = scaledW * cos + scaledH * sin;
  const boundH = scaledW * sin + scaledH * cos;

  const offsetX = Math.round(Number(frame.offsetX) || 0);
  const offsetY = Math.round(Number(frame.offsetY) || 0);

  if (fit === 'none') {
    return {
      x: offsetX, y: offsetY, drawW: scaledW, drawH: scaledH,
      sourceW, sourceH, rotation, scaleX: 1, scaleY: 1, fit,
      boundW: scaledW, boundH: scaledH,
    };
  }
  if (fit === 'stretch') {
    return {
      x: offsetX, y: offsetY, drawW: canvasW, drawH: canvasH,
      sourceW, sourceH, rotation, scaleX: canvasW / scaledW, scaleY: canvasH / scaledH,
      fit, boundW: canvasW, boundH: canvasH,
    };
  }

  const factor = fit === 'cover'
    ? Math.max(canvasW / boundW, canvasH / boundH)
    : Math.min(canvasW / boundW, canvasH / boundH);
  const drawW = boundW * factor;
  const drawH = boundH * factor;
  const x = (canvasW - drawW) / 2 + offsetX;
  const y = (anchor === 'top' ? 0 : anchor === 'bottom' ? canvasH - drawH : (canvasH - drawH) / 2) + offsetY;
  return {
    x, y, drawW, drawH, sourceW, sourceH, rotation,
    scaleX: factor, scaleY: factor, fit, boundW, boundH,
  };
}

function paintFrame(target, image, frame, canvasW, canvasH) {
  const place = placement(image, frame, canvasW, canvasH);
  const supportsClip = place.fit === 'cover' || place.fit === 'none';
  target.save();
  if (supportsClip) {
    target.beginPath();
    target.rect(0, 0, canvasW, canvasH);
    target.clip();
  }
  target.globalAlpha = Number(frame.opacity ?? 1);
  const sourceW = place.sourceW;
  const sourceH = place.sourceH;

  if (place.fit === 'stretch') {
    const centerX = place.x + place.drawW / 2;
    const centerY = place.y + place.drawH / 2;
    target.translate(centerX, centerY);
    if (place.rotation) target.rotate(place.rotation);
    target.scale(place.scaleX, place.scaleY);
    target.drawImage(image, -sourceW / 2, -sourceH / 2, sourceW, sourceH);
    target.restore();
    return;
  }

  const centerX = place.x + place.drawW / 2;
  const centerY = place.y + place.drawH / 2;
  const smooth = Math.abs(place.drawW - place.sourceW) > 0.5
    || Math.abs(place.drawH - place.sourceH) > 0.5;
  target.imageSmoothingEnabled = smooth;
  target.imageSmoothingQuality = 'high';
  if (place.rotation) {
    const factor = place.scaleX;
    target.translate(centerX, centerY);
    target.rotate(place.rotation);
    target.drawImage(image, -(sourceW * factor) / 2, -(sourceH * factor) / 2,
      sourceW * factor, sourceH * factor);
  } else {
    target.drawImage(image, place.x, place.y, place.drawW, place.drawH);
  }
  target.restore();
}

function drawTinted(image, frame, color, alpha, canvasW, canvasH) {
  if (!tintCanvas) {
    tintCanvas = document.createElement('canvas');
  }
  if (tintCanvas.width !== canvasW || tintCanvas.height !== canvasH) {
    tintCanvas.width = canvasW;
    tintCanvas.height = canvasH;
  }
  const tintCtx = tintCanvas.getContext('2d');
  tintCtx.clearRect(0, 0, canvasW, canvasH);
  paintFrame(tintCtx, image, frame, canvasW, canvasH);
  tintCtx.globalCompositeOperation = 'source-in';
  tintCtx.fillStyle = color;
  tintCtx.fillRect(0, 0, canvasW, canvasH);
  tintCtx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(tintCanvas, 0, 0);
  ctx.restore();
}

function drawGuides(width, height) {
  ctx.save();
  ctx.strokeStyle = 'rgba(111, 179, 168, 0.4)';
  ctx.lineWidth = Math.max(1, Math.round(Math.min(width, height) / 900));
  ctx.setLineDash([6, 6]);
  for (let index = 1; index <= 2; index += 1) {
    ctx.beginPath();
    ctx.moveTo((width * index) / 3, 0);
    ctx.lineTo((width * index) / 3, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, (height * index) / 3);
    ctx.lineTo(width, (height * index) / 3);
    ctx.stroke();
  }
  ctx.restore();
}

function draw() {
  if (!canvas || !state.doc) return;
  const width = Number(state.doc.canvas.width) || 1;
  const height = Number(state.doc.canvas.height) || 1;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    layout();
  }
  ctx.clearRect(0, 0, width, height);
  const background = state.doc.canvas.background;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  const hasFrames = (state.doc.frames || []).length > 0;
  if (empty) empty.hidden = hasFrames;
  if (!hasFrames) return;

  const current = playbackFrame() || getSelectedFrame();
  if (!current) return;
  const currentImage = load(current.url);

  // 洋葱皮只在暂停时显示，避免播放时拖慢
  if (!state.playing && state.onion.enabled) {
    const frames = visibleFrames();
    const index = frames.findIndex((frame) => frame.id === current.id);
    const prev = index > 0 ? frames[index - 1] : null;
    const next = index >= 0 && index < frames.length - 1 ? frames[index + 1] : null;
    const alpha = Number(state.onion.opacity) || 0.26;
    if (prev && state.onion.mode !== 'next') {
      const image = load(prev.url);
      if (image) drawTinted(image, prev, '#4f9cf9', alpha, width, height);
    }
    if (next && state.onion.mode !== 'prev') {
      const image = load(next.url);
      if (image) drawTinted(image, next, '#f0a04b', alpha, width, height);
    }
  }

  if (currentImage) paintFrame(ctx, currentImage, current, width, height);
  if (state.showGuides) drawGuides(width, height);

  if (badge) {
    badge.hidden = !state.playing;
    if (state.playing) {
      const frames = visibleFrames();
      const index = frames.findIndex((frame) => frame.id === current.id);
      badge.textContent = `${current.name || '帧'} · ${index + 1}/${frames.length}`;
    }
  }
}

function layout() {
  if (!board || !canvas || !state.doc || !viewport) return;
  const width = Number(state.doc.canvas.width) || 1;
  const height = Number(state.doc.canvas.height) || 1;
  const rect = viewport.getBoundingClientRect();
  const pad = 36;
  let scale;
  if (state.zoom === 'fit' || !Number.isFinite(state.zoom)) {
    scale = Math.min((rect.width - pad) / width, (rect.height - pad) / height);
    scale = Math.max(0.02, Math.min(scale, 2.2));
  } else {
    scale = Math.max(0.02, Number(state.zoom) / 100);
  }
  board.style.width = `${Math.round(width * scale)}px`;
  board.style.height = `${Math.round(height * scale)}px`;
  board.classList.toggle('pixelated', scale >= 1.5);
}

export function mountStage() {
  canvas = document.getElementById('stage-canvas');
  ctx = canvas.getContext('2d');
  board = document.getElementById('stage-board');
  viewport = document.getElementById('stage-viewport');
  empty = document.getElementById('stage-empty');
  badge = document.getElementById('playhead-badge');

  const observer = new ResizeObserver(() => {
    layout();
    requestDraw();
  });
  observer.observe(viewport);

  subscribe((reason) => {
    if (reason === 'project' || reason === 'doc') {
      preload();
      layout();
      requestDraw();
      return;
    }
    if (['frame', 'selection', 'playhead', 'playback', 'ui', 'selection'].includes(reason)) {
      layout();
      requestDraw();
    }
  });
  preload();
  layout();
  requestDraw();
}

export { requestDraw };
