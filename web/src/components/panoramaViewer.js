/**
 * 360° 全景查看器（球面 / 宽幅双模式）。
 *
 * - 球面：等距柱状贴图，拖动环视、滚轮改视野，适合真 360° 全景；
 * - 宽幅：整张图按「包含」铺满，拖动平移、滚轮缩放，适合普通宽幅全景。
 *
 * three.js 走动态 import，只有真正打开查看器时才加载（不影响首屏体积）；
 * 复用 vendor 里现成的 three.module.mjs，不新增依赖。
 */

import { openModal } from './modal.js';
import { isPanoramaAspect } from './panoramaMath.js';

const FOV_DEFAULT = 90;
const FOV_MIN = 30;
const FOV_MAX = 120;
const ROTATE_SPEED = 0.0022;
const AUTO_ROTATE_SPEED = 0.06;
const PITCH_LIMIT = Math.PI / 2 - 0.06;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * 打开全景查看器。
 * @param {{url:string, width?:number, height?:number, title?:string, filename?:string}} options
 * @returns {{close:Function}|null}
 */
export function openPanoramaViewer({
  url,
  width = 0,
  height = 0,
  title = '全景查看',
  filename = '',
} = {}) {
  if (!url) return null;

  const content = document.createElement('div');
  content.className = 'pv';
  content.innerHTML = `
    <canvas class="pv-canvas" data-ref="canvas"></canvas>
    <div class="pv-top">
      <div class="pv-group" role="group" aria-label="投影方式">
        <button class="pv-btn" type="button" data-mode="flat" aria-pressed="false">宽幅</button>
        <button class="pv-btn" type="button" data-mode="sphere" aria-pressed="true">360° 全景</button>
      </div>
      <div class="pv-group">
        <button class="pv-btn" type="button" data-act="rotate" aria-pressed="false">自动旋转</button>
        <button class="pv-btn" type="button" data-act="reset">重置</button>
      </div>
    </div>
    <div class="pv-foot">
      <span class="pv-meta" data-ref="meta">加载中…</span>
      <span class="pv-hint" data-ref="hint">拖动环视 · 滚轮缩放 · R 重置 · 空格自动旋转</span>
    </div>
    <div class="pv-state" data-ref="state">正在载入全景…</div>`;

  const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
  const canvas = ref('canvas');
  const metaEl = ref('meta');
  const hintEl = ref('hint');
  const stateEl = ref('state');
  const rotateBtn = content.querySelector('[data-act="rotate"]');
  const modeButtons = [...content.querySelectorAll('[data-mode]')];

  const state = {
    mode: isPanoramaAspect(width, height) || (!width && !height) ? 'sphere' : 'flat',
    yaw: 0,
    pitch: 0,
    fov: FOV_DEFAULT,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    autoRotate: false,
    velX: 0,
    velY: 0,
  };

  let closed = false;
  let raf = 0;
  let lastTime = 0;
  let resizeObserver = null;
  let THREE = null;
  let renderer = null;
  let sphereScene = null;
  let sphereCamera = null;
  let sphereMaterial = null;
  let sphereGeometry = null;
  let flatScene = null;
  let flatCamera = null;
  let flatMaterial = null;
  let flatPlane = null;
  let texture = null;

  const syncModeButtons = () => {
    modeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    });
    hintEl.textContent =
      state.mode === 'sphere'
        ? '拖动环视 360° · 滚轮缩放视野 · R 重置 · 空格自动旋转'
        : '拖动平移 · 滚轮缩放 · R 重置 · 空格自动旋转';
  };

  /* ------------------------------------------------------------ 相机与布局 */

  const viewWidth = () => {
    if (!canvas.clientHeight) return 2;
    return (canvas.clientWidth / canvas.clientHeight) * 2;
  };

  const applySphere = () => {
    if (!sphereCamera) return;
    state.pitch = clamp(state.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    state.fov = clamp(state.fov, FOV_MIN, FOV_MAX);
    sphereCamera.rotation.set(state.pitch, state.yaw, 0);
    sphereCamera.fov = state.fov;
    sphereCamera.updateProjectionMatrix();
  };

  let baseW = 0;
  let baseH = 0;

  const layoutFlat = () => {
    if (!texture?.image || !flatPlane) return;
    const imgW = texture.image.width || 1;
    const imgH = texture.image.height || 1;
    const viewH = 2;
    const viewW = viewWidth();
    const k = Math.min(viewW / imgW, viewH / imgH);
    baseW = imgW * k;
    baseH = imgH * k;
    applyFlat();
  };

  const applyFlat = () => {
    if (!flatPlane) return;
    const viewW = viewWidth();
    const viewH = 2;
    const w = baseW * state.zoom;
    const h = baseH * state.zoom;
    const maxX = Math.max(0, (w - viewW) / 2);
    const maxY = Math.max(0, (h - viewH) / 2);
    state.panX = clamp(state.panX, -maxX, maxX);
    state.panY = clamp(state.panY, -maxY, maxY);
    flatPlane.scale.set(w || 1, h || 1, 1);
    flatPlane.position.set(state.panX, state.panY, 0);
  };

  const resize = () => {
    if (!renderer) return;
    const widthPx = Math.max(1, canvas.clientWidth);
    const heightPx = Math.max(1, canvas.clientHeight);
    renderer.setSize(widthPx, heightPx, false);
    if (sphereCamera) {
      sphereCamera.aspect = widthPx / heightPx;
      sphereCamera.updateProjectionMatrix();
    }
    if (flatCamera) {
      const viewW = (widthPx / heightPx) * 2;
      flatCamera.left = -viewW / 2;
      flatCamera.right = viewW / 2;
      flatCamera.top = 1;
      flatCamera.bottom = -1;
      flatCamera.updateProjectionMatrix();
    }
    layoutFlat();
  };

  const resetView = () => {
    state.velX = 0;
    state.velY = 0;
    if (state.mode === 'sphere') {
      state.yaw = 0;
      state.pitch = 0;
      state.fov = FOV_DEFAULT;
      applySphere();
    } else {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyFlat();
    }
  };

  const setMode = (mode) => {
    state.mode = mode === 'flat' ? 'flat' : 'sphere';
    state.velX = 0;
    state.velY = 0;
    syncModeButtons();
    resetView();
  };

  /* ------------------------------------------------------------ 渲染循环 */

  const tick = (time = 0) => {
    if (closed) return;
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;

    if (!state.dragging) {
      if (Math.abs(state.velX) > 1e-5 || Math.abs(state.velY) > 1e-5) {
        if (state.mode === 'sphere') {
          state.yaw += state.velX;
          state.pitch += state.velY;
          applySphere();
        } else {
          state.panX += state.velX;
          state.panY += state.velY;
          applyFlat();
        }
        state.velX *= 0.93;
        state.velY *= 0.93;
      }
      if (state.autoRotate && dt) {
        if (state.mode === 'sphere') {
          state.yaw += AUTO_ROTATE_SPEED * dt;
          applySphere();
        } else {
          state.panX += AUTO_ROTATE_SPEED * 6 * dt;
          applyFlat();
        }
      }
    }

    if (renderer) {
      if (state.mode === 'sphere') renderer.render(sphereScene, sphereCamera);
      else renderer.render(flatScene, flatCamera);
    }
    raf = requestAnimationFrame(tick);
  };

  /* ------------------------------------------------------------ 交互 */

  canvas.addEventListener('pointerdown', (event) => {
    if (!texture) return;
    state.dragging = true;
    state.velX = 0;
    state.velY = 0;
    canvas.classList.add('is-dragging');
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件没有活跃指针 */
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
      applySphere();
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

  const endDrag = (event) => {
    if (!state.dragging) return;
    state.dragging = false;
    canvas.classList.remove('is-dragging');
    if (event && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', endDrag);

  canvas.addEventListener('wheel', (event) => {
    if (!texture) return;
    event.preventDefault();
    if (state.mode === 'sphere') {
      state.fov += event.deltaY * 0.02;
      applySphere();
    } else {
      state.zoom = clamp(state.zoom * Math.exp(-event.deltaY * 0.0016), ZOOM_MIN, ZOOM_MAX);
      applyFlat();
    }
  }, { passive: false });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  rotateBtn.addEventListener('click', () => {
    state.autoRotate = !state.autoRotate;
    rotateBtn.setAttribute('aria-pressed', String(state.autoRotate));
  });

  content.querySelector('[data-act="reset"]').addEventListener('click', resetView);

  const onKey = (event) => {
    if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'r') resetView();
    else if (key === ' ') {
      event.preventDefault();
      rotateBtn.click();
    }
  };
  document.addEventListener('keydown', onKey);

  /* ------------------------------------------------------------ 初始化 three */

  const setup = async () => {
    try {
      THREE = await import('../../vendor/pose3d/vnccs/three.module.mjs');
    } catch (err) {
      stateEl.hidden = false;
      stateEl.textContent = `three.js 加载失败：${err?.message || err}`;
      return;
    }
    if (closed) return;

    if (!prefersReducedMotion()) {
      stateEl.textContent = '正在准备全景…';
    }
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x05070a, 1);

    /* 球面 */
    sphereScene = new THREE.Scene();
    sphereCamera = new THREE.PerspectiveCamera(FOV_DEFAULT, 1, 0.1, 2000);
    sphereCamera.rotation.order = 'YXZ';
    sphereMaterial = new THREE.MeshBasicMaterial();
    sphereGeometry = new THREE.SphereGeometry(500, 96, 48);
    // 翻转几何：面朝球内，且等距柱状纹理左右方向正确（否则会镜像）
    sphereGeometry.scale(-1, 1, 1);
    sphereScene.add(new THREE.Mesh(sphereGeometry, sphereMaterial));

    /* 宽幅 */
    flatScene = new THREE.Scene();
    flatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    flatCamera.position.z = 5;
    flatMaterial = new THREE.MeshBasicMaterial();
    flatPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), flatMaterial);
    flatScene.add(flatPlane);

    resize();
    syncModeButtons();
    applySphere();

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', resize);

    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (loaded) => {
        if (closed) {
          loaded.dispose();
          return;
        }
        texture = loaded;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        sphereMaterial.map = texture;
        sphereMaterial.needsUpdate = true;
        flatMaterial.map = texture;
        flatMaterial.needsUpdate = true;

        const imgW = texture.image?.width || width || 0;
        const imgH = texture.image?.height || height || 0;
        const ratio = imgW && imgH ? imgW / imgH : 0;
        metaEl.textContent = ratio
          ? `${imgW} × ${imgH} · ${ratio.toFixed(2)}:1`
          : (filename || '');
        if (!isPanoramaAspect(imgW, imgH)) {
          metaEl.textContent += ' · 非宽幅，球面会拉伸';
          setMode('flat');
        }
        layoutFlat();
        stateEl.hidden = true;
        resize();
      },
      undefined,
      () => {
        stateEl.hidden = false;
        stateEl.textContent = '图片加载失败，请稍后重试。';
      },
    );

    raf = requestAnimationFrame(tick);
  };

  const cleanup = () => {
    closed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', resize);
    resizeObserver?.disconnect();
    texture?.dispose();
    sphereGeometry?.dispose();
    sphereMaterial?.dispose();
    flatPlane?.geometry.dispose();
    flatMaterial?.dispose();
    renderer?.dispose();
  };

  const modal = openModal({
    title,
    subtitle: '拖动环视 · 滚轮缩放',
    content,
    size: 'lg',
    dialogClass: 'pano360-modal',
    hideFooter: true,
    onClose: cleanup,
  });

  syncModeButtons();
  setup();

  return modal;
}
