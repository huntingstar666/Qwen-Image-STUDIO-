/**
 * 独立全景查看器（three.js）
 *
 * 两种模式：
 * - 宽幅（默认）：整张图按「包含」方式铺满视口，拖动平移、滚轮缩放，适合普通宽幅全景图；
 * - 球面：等距柱状 360° 贴图，拖动环视（真正的全景内容才建议用）。
 *
 * 只读依赖 ./vendor/three.module.mjs（从项目 vendor 复制，未改动任何项目代码）。
 */

import * as THREE from './vendor/three.module.mjs';

const canvas = document.getElementById('view');
const drop = document.getElementById('drop');
const toastEl = document.getElementById('toast');
const metaEl = document.getElementById('meta');
const hintEl = document.getElementById('hint');
const fileInput = document.getElementById('file');
const fovInput = document.getElementById('fov');
const rotateBtn = document.getElementById('rotate');
const modeFlatBtn = document.getElementById('modeFlat');
const modeSphereBtn = document.getElementById('modeSphere');

const FOV_DEFAULT = 90;
const FOV_MIN = 30;
const FOV_MAX = 120;
const ROTATE_SPEED = 0.0022;
const AUTO_ROTATE_SPEED = 0.06;
const PITCH_LIMIT = Math.PI / 2 - 0.06;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

const state = {
  mode: 'flat',
  // 球面
  yaw: 0,
  pitch: 0,
  fov: FOV_DEFAULT,
  // 宽幅
  zoom: 1,
  panX: 0,
  panY: 0,
  // 通用
  dragging: false,
  autoRotate: false,
  velX: 0,
  velY: 0,
  objectUrl: '',
  imgW: 0,
  imgH: 0,
  baseW: 0,
  baseH: 0,
};

/* ------------------------------------------------------------ three 基础 */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x05070a, 1);

/* 球面场景 */
const sphereScene = new THREE.Scene();
const sphereCamera = new THREE.PerspectiveCamera(
  FOV_DEFAULT,
  window.innerWidth / window.innerHeight,
  0.1,
  2000,
);
sphereCamera.rotation.order = 'YXZ';
const sphereMaterial = new THREE.MeshBasicMaterial();
const sphereGeometry = new THREE.SphereGeometry(500, 96, 48);
// 翻转几何让面朝球内，同时等距柱状纹理左右方向正确（否则文字/场景会镜像）
sphereGeometry.scale(-1, 1, 1);
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
sphereScene.add(sphere);

/* 宽幅场景（正交相机，整图可见） */
const flatScene = new THREE.Scene();
const flatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
flatCamera.position.z = 5;
const flatMaterial = new THREE.MeshBasicMaterial();
const flatPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial);
flatScene.add(flatPlane);

/* ------------------------------------------------------------ 状态应用 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function viewWidth() {
  return (window.innerWidth / window.innerHeight) * 2; // 正交相机高度固定为 2
}

function applyCamera() {
  state.pitch = clamp(state.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  state.fov = clamp(state.fov, FOV_MIN, FOV_MAX);
  sphereCamera.rotation.set(state.pitch, state.yaw, 0);
  sphereCamera.fov = state.fov;
  sphereCamera.updateProjectionMatrix();
  fovInput.value = String(Math.round(state.fov));
}

function layoutFlat() {
  if (!state.imgW || !state.imgH) return;
  const viewH = 2;
  const viewW = viewWidth();
  const k = Math.min(viewW / state.imgW, viewH / state.imgH);
  state.baseW = state.imgW * k;
  state.baseH = state.imgH * k;
  applyFlat();
}

function applyFlat() {
  const viewW = viewWidth();
  const viewH = 2;
  const width = state.baseW * state.zoom;
  const height = state.baseH * state.zoom;
  const maxX = Math.max(0, (width - viewW) / 2);
  const maxY = Math.max(0, (height - viewH) / 2);
  state.panX = clamp(state.panX, -maxX, maxX);
  state.panY = clamp(state.panY, -maxY, maxY);
  flatPlane.scale.set(width || 1, height || 1, 1);
  flatPlane.position.set(state.panX, state.panY, 0);
}

function setMode(mode) {
  state.mode = mode === 'sphere' ? 'sphere' : 'flat';
  modeFlatBtn.setAttribute('aria-pressed', String(state.mode === 'flat'));
  modeSphereBtn.setAttribute('aria-pressed', String(state.mode === 'sphere'));
  hintEl.textContent =
    state.mode === 'sphere'
      ? '拖动环视 360° · 滚轮缩放视野 · R 重置 · 空格自动旋转 · F 全屏'
      : '拖动平移 · 滚轮缩放 · R 重置 · 空格自动旋转 · F 全屏';
  if (state.mode === 'flat') {
    state.velX = 0;
    state.velY = 0;
    applyFlat();
  } else {
    applyCamera();
  }
}

function resetView() {
  if (state.mode === 'sphere') {
    state.yaw = 0;
    state.pitch = 0;
    state.fov = FOV_DEFAULT;
    state.velX = 0;
    state.velY = 0;
    applyCamera();
  } else {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.velX = 0;
    state.velY = 0;
    applyFlat();
  }
}

function toggleAutoRotate(force) {
  state.autoRotate = typeof force === 'boolean' ? force : !state.autoRotate;
  rotateBtn.setAttribute('aria-pressed', String(state.autoRotate));
}

/* ------------------------------------------------------------ 纹理 */

function setBusy(text) {
  metaEl.classList.remove('is-warn');
  metaEl.textContent = text;
}

function showToast(message) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4600);
}

function setTexture(source, width, height, label, { mode } = {}) {
  if (!width || !height) {
    showToast('这张图没有可用的像素尺寸。');
    return;
  }
  const texture = source.isTexture ? source : new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;

  for (const material of [sphereMaterial, flatMaterial]) {
    if (material.map && material.map !== texture) material.map.dispose();
    material.map = texture;
    material.needsUpdate = true;
  }

  state.imgW = width;
  state.imgH = height;
  drop.classList.add('is-hidden');

  const ratio = width / height;
  const offRatio = Math.abs(ratio - 2) > 0.06;
  metaEl.classList.toggle('is-warn', offRatio);
  metaEl.textContent = offRatio
    ? `${width} × ${height} · ${ratio.toFixed(2)}:1 · 非 2:1，球面会拉伸`
    : `${width} × ${height} · ${ratio.toFixed(2)}:1 · 等距柱状 2:1`;
  if (label) metaEl.title = label;

  if (mode) setMode(mode);
  resetView();
  layoutFlat();
}

function loadFromSource(src, label) {
  setBusy('加载中…');
  const image = new Image();
  image.decoding = 'async';
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      setTexture(image, image.naturalWidth || image.width, image.naturalHeight || image.height, label);
    } catch (err) {
      showToast(`图片无法作为纹理使用（可能是跨源限制）：${err.message || err}`);
    }
  };
  image.onerror = () => {
    setBusy('等待图片');
    showToast('图片加载失败，请确认文件可读或地址可访问。');
  };
  image.src = src;
}

function loadFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    showToast('请选择图片文件（PNG / JPG / WEBP）。');
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  loadFromSource(state.objectUrl, file.name);
}

/* ------------------------------------------------------------ 360° 示例（程序生成） */

function buildDemoEquirect() {
  const width = 4096;
  const height = 2048;
  const demo = document.createElement('canvas');
  demo.width = width;
  demo.height = height;
  const ctx = demo.getContext('2d');
  const horizon = height / 2;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#1d2f4f');
  sky.addColorStop(0.7, '#7ea6cf');
  sky.addColorStop(1, '#f0c98a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);

  const ground = ctx.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, '#4a5b45');
  ground.addColorStop(1, '#161d18');
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, width, height - horizon);

  // 太阳
  ctx.beginPath();
  ctx.arc(width * 0.28, horizon * 0.55, 120, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe6a8';
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;

  // 地平线
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(0, horizon - 2, width, 4);

  // 8 个方位柱：每个 45° 一根，用来验证环视和左右衔接
  for (let i = 0; i < 8; i++) {
    const x = (i / 8) * width;
    const hue = (i * 45) % 360;
    const pillarW = 180;
    const pillarH = 420;
    ctx.fillStyle = `hsl(${hue} 55% 52%)`;
    ctx.fillRect(x - pillarW / 2, horizon - pillarH, pillarW, pillarH);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 120px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i * 45), x, horizon - pillarH / 2);
  }

  // 极区标注
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = 'bold 90px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('天顶 ZENITH', width / 2, 140);
  ctx.fillText('天底 NADIR', width / 2, height - 140);

  const texture = new THREE.CanvasTexture(demo);
  setTexture(texture, width, height, '360° 示例（程序生成）', { mode: 'sphere' });
  showToast('这是程序生成的 360° 等距柱状示例：拖动可以环视一圈，能看到 8 个方位柱。');
}

/* ------------------------------------------------------------ 交互 */

canvas.addEventListener('pointerdown', (event) => {
  if (!state.imgW) return;
  state.dragging = true;
  state.velX = 0;
  state.velY = 0;
  canvas.classList.add('is-dragging');
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* 合成事件 / 旧浏览器没有活跃指针，忽略即可 */
  }
  canvas.dataset.lastX = String(event.clientX);
  canvas.dataset.lastY = String(event.clientY);
});

canvas.addEventListener('pointermove', (event) => {
  if (!state.dragging) return;
  const lastX = Number(canvas.dataset.lastX) || event.clientX;
  const lastY = Number(canvas.dataset.lastY) || event.clientY;
  const dx = event.clientX - lastX;
  const dy = event.clientY - lastY;
  if (!dx && !dy) return;

  if (state.mode === 'sphere') {
    const scale = ROTATE_SPEED * (state.fov / FOV_DEFAULT);
    state.yaw += dx * scale;
    state.pitch += dy * scale;
    state.velX = dx * scale;
    state.velY = dy * scale;
    applyCamera();
  } else {
    const unitX = viewWidth() / Math.max(1, canvas.clientWidth);
    const unitY = 2 / Math.max(1, canvas.clientHeight);
    state.panX += dx * unitX;
    state.panY -= dy * unitY;
    state.velX = dx * unitX;
    state.velY = -dy * unitY;
    applyFlat();
  }

  canvas.dataset.lastX = String(event.clientX);
  canvas.dataset.lastY = String(event.clientY);
});

function endDrag(event) {
  if (!state.dragging) return;
  state.dragging = false;
  canvas.classList.remove('is-dragging');
  if (event && canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', endDrag);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('wheel', (event) => {
  if (!state.imgW) return;
  event.preventDefault();
  if (state.mode === 'sphere') {
    state.fov += event.deltaY * 0.02;
    applyCamera();
  } else {
    state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.0016), ZOOM_MIN, ZOOM_MAX);
    applyFlat();
  }
}, { passive: false });

fovInput.addEventListener('input', () => {
  state.fov = Number(fovInput.value) || FOV_DEFAULT;
  applyCamera();
});

document.getElementById('open').addEventListener('click', () => fileInput.click());
document.getElementById('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
document.getElementById('demo').addEventListener('click', buildDemoEquirect);

modeFlatBtn.addEventListener('click', () => setMode('flat'));
modeSphereBtn.addEventListener('click', () => setMode('sphere'));
rotateBtn.addEventListener('click', () => toggleAutoRotate());
document.getElementById('reset').addEventListener('click', resetView);
document.getElementById('full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

window.addEventListener('keydown', (event) => {
  if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  const key = event.key.toLowerCase();
  if (key === 'r') resetView();
  else if (key === ' ') {
    event.preventDefault();
    toggleAutoRotate();
  } else if (key === 'f') {
    document.getElementById('full').click();
  }
});

/* 拖拽文件 / 拖入 url */
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    loadFile(file);
    return;
  }
  const url =
    event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain');
  if (url) loadFromSource(url.trim(), url);
});

function handleResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  sphereCamera.aspect = width / height;
  sphereCamera.updateProjectionMatrix();
  const viewW = (width / height) * 2;
  flatCamera.left = -viewW / 2;
  flatCamera.right = viewW / 2;
  flatCamera.top = 1;
  flatCamera.bottom = -1;
  flatCamera.updateProjectionMatrix();
  layoutFlat();
}

window.addEventListener('resize', handleResize);

/* ------------------------------------------------------------ 渲染循环 */

const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!state.dragging) {
    if (Math.abs(state.velX) > 1e-5 || Math.abs(state.velY) > 1e-5) {
      if (state.mode === 'sphere') {
        state.yaw += state.velX;
        state.pitch += state.velY;
        applyCamera();
      } else {
        state.panX += state.velX;
        state.panY += state.velY;
        applyFlat();
      }
      state.velX *= 0.93;
      state.velY *= 0.93;
    }
    if (state.autoRotate) {
      if (state.mode === 'sphere') {
        state.yaw += AUTO_ROTATE_SPEED * dt;
        applyCamera();
      } else {
        state.panX += AUTO_ROTATE_SPEED * 6 * dt;
        applyFlat();
      }
    }
  }

  if (state.mode === 'sphere') renderer.render(sphereScene, sphereCamera);
  else renderer.render(flatScene, flatCamera);

  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------ 启动 */

handleResize();
setMode('flat');
applyCamera();
tick();

const params = new URLSearchParams(location.search);
const initialMode = params.get('mode');
if (initialMode === 'sphere' || initialMode === 'flat') setMode(initialMode);
const initial = params.get('src');
if (initial) loadFromSource(initial, initial);

/* 供自动化测试/调试读取 */
window.__pano = {
  state,
  setMode,
  resetView,
  loadFile,
  loadFromSource,
  buildDemoEquirect,
  get hasTexture() {
    return Boolean(state.imgW);
  },
};
