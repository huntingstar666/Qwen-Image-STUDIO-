/**
 * 高清大图查看器。
 * 1. 点击生成结果图后打开，支持缩放（滚轮 / 按钮 / 双击）、拖拽平移；
 * 2. 多图时可用左右按钮、方向键、底部缩略图切换；
 * 3. 提供下载与「新窗口打开原图」，不改变页面状态。
 */

import { openModal } from './modal.js';
import { downloadUrl, escapeHtml, fmtNum } from '../utils.js';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ENTER_DURATION = 260;
const ENTER_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** 只接受有实际尺寸的 rect，避免 0 尺寸导致从左上角飞入。 */
function usableRect(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
  return width > 2 && height > 2 ? rect : null;
}

/**
 * @param {Array<{url:string,width?:number,height?:number,filename?:string,label?:string}>} images
 * @param {number} [startIndex]
 * @param {{title?:string, onClose?:Function, origin?:DOMRect}} [options]
 */
export function openLightbox(images, startIndex = 0, { title = '高清大图', onClose, origin = null } = {}) {
  const list = (images || []).filter((item) => item?.url);
  if (!list.length) return null;

  let index = Math.min(Math.max(0, startIndex), list.length - 1);
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragBaseX = 0;
  let dragBaseY = 0;

  const content = document.createElement('div');
  content.className = 'lb';
  content.innerHTML = `
    <div class="lb-stage" data-ref="stage" tabindex="0">
      <img class="lb-lqip" data-ref="lqip" alt="" aria-hidden="true" />
      <img class="lb-img" data-ref="img" alt="高清大图" draggable="false" />
      <button class="lb-close" type="button" data-ref="close" title="关闭（Esc）">×</button>
      <button class="lb-nav prev" type="button" data-ref="prev" title="上一张（←）">‹</button>
      <button class="lb-nav next" type="button" data-ref="next" title="下一张（→）">›</button>
      <div class="lb-counter mono" data-ref="counter"></div>
    </div>
    <div class="lb-bar">
      <div class="lb-info" data-ref="info"></div>
      <span class="spacer"></span>
      <button class="lb-tool" type="button" data-ref="zoomOut" title="缩小">−</button>
      <button class="lb-tool" type="button" data-ref="zoomReset" title="还原到适应窗口">适应</button>
      <button class="lb-tool" type="button" data-ref="zoomActual" title="按原图 1:1 实际像素显示（1）">1:1</button>
      <button class="lb-tool" type="button" data-ref="zoomIn" title="放大">＋</button>
      <span class="lb-zoom mono" data-ref="zoomVal">100%</span>
      <button class="lb-tool" type="button" data-ref="download">下载</button>
      <button class="lb-tool" type="button" data-ref="open">原图</button>
    </div>
    <div class="lb-film" data-ref="film"></div>`;

  const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
  const stage = ref('stage');
  const img = ref('img');
  const lqip = ref('lqip');
  const film = ref('film');
  const counter = ref('counter');

  /** 缩略图占位：和原图同一张时不重复请求，只用它垫底防止白屏。 */
  const showLqip = (item) => {
    const thumb = String(item?.thumb || '');
    if (!thumb || thumb === item?.url) {
      lqip.classList.remove('is-on');
      return;
    }
    if (lqip.getAttribute('src') !== thumb) lqip.src = thumb;
    lqip.classList.add('is-on');
  };
  const hideLqip = () => lqip.classList.remove('is-on');

  /** 平移边界：放大后才允许移动，且不把图片拖出舞台。 */
  const clampPan = () => {
    const maxX = Math.max(0, (img.clientWidth * zoom - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.clientHeight * zoom - stage.clientHeight) / 2);
    panX = Math.min(maxX, Math.max(-maxX, panX));
    panY = Math.min(maxY, Math.max(-maxY, panY));
  };

  let transformTimer = 0;
  /**
   * @param {boolean} [animate] 按钮/双击/快捷键缩放用过渡；滚轮与拖拽必须跟手，传 false。
   */
  const applyTransform = (animate = false) => {
    clampPan();
    img.classList.toggle('is-animating', animate);
    img.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
    img.style.cursor = zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-out';
    ref('zoomVal').textContent = `${Math.round(zoom * 100)}%`;
    if (animate) {
      window.clearTimeout(transformTimer);
      transformTimer = window.setTimeout(() => img.classList.remove('is-animating'), 220);
    }
  };

  const resetView = (animate = false) => {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyTransform(animate);
  };

  // 原图实际像素：当前显示宽度是被 max-width/max-height 适应窗口后的尺寸，
  // 用 naturalWidth / clientWidth 得到 1:1 所需倍率。
  const actualSizeZoom = () => {
    const natural = img.naturalWidth || 0;
    const shown = img.clientWidth || 0;
    return natural && shown ? clampZoom(natural / shown) : 1;
  };

  const showActualSize = () => {
    zoom = actualSizeZoom();
    panX = 0;
    panY = 0;
    applyTransform(true);
  };

  const updateInfo = () => {
    const item = list[index] || {};
    const width = item.width || img.naturalWidth || 0;
    const height = item.height || img.naturalHeight || 0;
    const dims = width && height ? `${fmtNum(width)} × ${fmtNum(height)}` : '';
    ref('info').textContent = [item.label || `第 ${index + 1} 张`, dims].filter(Boolean).join(' · ');
  };

  const renderFilm = () => {
    if (list.length <= 1) {
      film.style.display = 'none';
      return;
    }
    film.style.display = '';
    film.innerHTML = list
      .map(
        (item, i) =>
          `<button class="lb-thumb ${i === index ? 'active' : ''}" type="button" data-thumb="${i}" title="${escapeHtml(item.label || `第 ${i + 1} 张`)}">
            <img src="${escapeHtml(item.url)}" alt="" loading="lazy" />
          </button>`,
      )
      .join('');
    film.querySelectorAll('[data-thumb]').forEach((button) => {
      button.addEventListener('click', () => show(Number(button.dataset.thumb)));
    });
  };

  /** 真正切换 DOM 与所有状态（不含过渡动画）。 */
  const applyImage = (nextIndex) => {
    index = nextIndex;
    const item = list[index];
    showLqip(item);
    img.src = item.url;
    resetView();
    counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    ref('prev').style.display = list.length > 1 ? '' : 'none';
    ref('next').style.display = list.length > 1 ? '' : 'none';
    updateInfo();
    film.querySelectorAll('[data-thumb]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.thumb) === index);
    });
  };

  /** 预解码令牌：连续快速切图时只让最后一次生效。 */
  let swapToken = 0;

  const show = (nextIndex) => {
    if (!list.length) return;
    const total = list.length;
    const target = ((nextIndex % total) + total) % total;
    // 首次渲染：直接落图，交给打开动画处理。
    if (!entered) {
      applyImage(target);
      return;
    }
    if (target === index) return;
    const forward = (target - index + total) % total <= total / 2;
    const dir = forward ? 1 : -1;
    const token = ++swapToken;

    const commit = () => {
      if (token !== swapToken) return;
      if (prefersReducedMotion() || typeof img.animate !== 'function') {
        applyImage(target);
        return;
      }
      const out = img.animate(
        [
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-14 * dir}px)` },
        ],
        { duration: 90, easing: 'ease-in', fill: 'forwards' },
      );
      out.finished
        .catch(() => {})
        .then(() => {
          if (token !== swapToken) {
            out.cancel();
            return;
          }
          out.cancel();
          applyImage(target);
          img.animate(
            [
              { opacity: 0, transform: `translateX(${20 * dir}px)` },
              { opacity: 1, transform: 'translateX(0)' },
            ],
            { duration: 150, easing: ENTER_EASING },
          );
        });
    };

    // 先解码再替换：避免新图首帧白闪，也避免解码耗时造成旧图先消失。
    const probe = new Image();
    probe.src = list[target].url;
    if (typeof probe.decode === 'function') {
      probe.decode().then(commit).catch(commit);
    } else {
      probe.onload = commit;
      probe.onerror = commit;
    }
  };

  let modal = null;
  let entered = false;

  /**
   * 打开动画：从来源缩略图的位置/尺寸“长”到灯箱里的最终尺寸。
   * 目标 rect 要等图片加载后才有意义，所以由 img.load 触发。
   */
  const playEnter = () => {
    if (entered) return;
    entered = true;
    if (prefersReducedMotion() || typeof img.animate !== 'function') return;
    const target = img.getBoundingClientRect();
    if (!target.width || !target.height) return;
    const from = usableRect(origin);
    if (!from) {
      img.animate(
        [
          { opacity: 0, transform: 'scale(1.02)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: ENTER_EASING },
      );
      return;
    }
    const scaleX = Math.min(1, from.width / target.width);
    const scaleY = Math.min(1, from.height / target.height);
    const dx = from.left + from.width / 2 - (target.left + target.width / 2);
    const dy = from.top + from.height / 2 - (target.top + target.height / 2);
    img.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.9,
          borderRadius: '10px',
        },
        { transform: 'none', opacity: 1, borderRadius: '0px' },
      ],
      { duration: ENTER_DURATION, easing: ENTER_EASING },
    );
  };

  /**
   * 关闭动画：把当前图“飞回”来源缩略图位置，遮罩同时淡出。
   * 用克隆层做位移动画，避免遮罩淡出把图片一起淡化。
   */
  const playExit = () => new Promise((resolve) => {
    const backdrop = modal?.root;
    if (!backdrop || prefersReducedMotion() || typeof img.animate !== 'function') {
      resolve();
      return;
    }
    const finish = () => resolve();
    const backdropAnim = backdrop.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 160, easing: 'ease-in', fill: 'forwards' },
    );
    const target = img.getBoundingClientRect();
    const from = usableRect(origin);
    // 放大/平移状态下直接淡出，避免从被裁切的画面硬跳回缩略图。
    if (!from || zoom !== 1 || !target.width || !target.height) {
      img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      backdropAnim.finished.catch(() => {}).then(finish);
      return;
    }
    const clone = img.cloneNode();
    clone.style.cssText = [
      'position:fixed',
      `left:${target.left}px`,
      `top:${target.top}px`,
      `width:${target.width}px`,
      `height:${target.height}px`,
      'max-width:none',
      'max-height:none',
      'object-fit:contain',
      'z-index:120',
      'pointer-events:none',
      'transform-origin:center center',
    ].join(';');
    document.body.append(clone);
    const scaleX = from.width / target.width;
    const scaleY = from.height / target.height;
    const dx = from.left + from.width / 2 - (target.left + target.width / 2);
    const dy = from.top + from.height / 2 - (target.top + target.height / 2);
    const fly = clone.animate(
      [
        { transform: 'none', opacity: 1 },
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
          opacity: 0.9,
        },
      ],
      { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
    );
    Promise.all([backdropAnim.finished.catch(() => {}), fly.finished.catch(() => {})]).then(() => {
      clone.remove();
      finish();
    });
  });

  const onKey = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === '+' || event.key === '=') {
      zoom = clampZoom(zoom * 1.2);
      applyTransform(true);
    } else if (event.key === '-') {
      zoom = clampZoom(zoom / 1.2);
      applyTransform(true);
    } else if (event.key === '0') {
      resetView(true);
    } else if (event.key === '1') {
      showActualSize();
    }
  };
  document.addEventListener('keydown', onKey);

  modal = openModal({
    title,
    content,
    size: 'lg',
    dialogClass: 'lightbox-modal',
    hideFooter: true,
    exit: playExit,
    onClose: () => {
      document.removeEventListener('keydown', onKey);
      onClose?.();
    },
  });

  ref('close').addEventListener('click', () => modal.close());
  ref('prev').addEventListener('click', () => show(index - 1));
  ref('next').addEventListener('click', () => show(index + 1));
  ref('zoomIn').addEventListener('click', () => {
    zoom = clampZoom(zoom * 1.25);
    applyTransform(true);
  });
  ref('zoomOut').addEventListener('click', () => {
    zoom = clampZoom(zoom / 1.25);
    applyTransform(true);
  });
  ref('zoomReset').addEventListener('click', () => resetView(true));
  ref('zoomActual').addEventListener('click', showActualSize);
  ref('download').addEventListener('click', () => {
    const item = list[index];
    downloadUrl(item.url, item.filename || `image-${index + 1}.png`);
  });
  ref('open').addEventListener('click', () => window.open(list[index].url, '_blank', 'noopener'));

  /** 以指针为锚点缩放：光标下的那一点保持不动。 */
  const zoomAtPoint = (nextZoom, clientX, clientY, animate = false) => {
    const next = clampZoom(nextZoom);
    const rect = stage.getBoundingClientRect();
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const ratio = next / zoom;
    panX = px - (px - panX) * ratio;
    panY = py - (py - panY) * ratio;
    zoom = next;
    if (zoom <= 1) {
      panX = 0;
      panY = 0;
    }
    applyTransform(animate);
  };

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAtPoint(zoom * (event.deltaY < 0 ? 1.12 : 0.9), event.clientX, event.clientY, false);
  }, { passive: false });

  stage.addEventListener('dblclick', (event) => {
    if (zoom > 1) resetView(true);
    else zoomAtPoint(2, event.clientX, event.clientY, true);
  });

  // 拖拽速度（px/ms）用于松手后的短惯性
  let lastMoveAt = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let velocityX = 0;
  let velocityY = 0;
  let inertiaToken = 0;

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || zoom <= 1) return;
    dragging = true;
    inertiaToken += 1; // 取消上一段惯性
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragBaseX = panX;
    dragBaseY = panY;
    lastMoveAt = performance.now();
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    velocityX = 0;
    velocityY = 0;
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件或已释放的指针没有 capture，忽略即可
    }
    applyTransform();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    panX = dragBaseX + (event.clientX - dragStartX);
    panY = dragBaseY + (event.clientY - dragStartY);
    const now = performance.now();
    const dt = Math.max(1, now - lastMoveAt);
    velocityX = (event.clientX - lastPointerX) / dt;
    velocityY = (event.clientY - lastPointerY) / dt;
    lastMoveAt = now;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    applyTransform();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    applyTransform();
    // 松手惯性：按最近一次速度衰减，撞到边界自然停住
    const speed = Math.hypot(velocityX, velocityY);
    if (prefersReducedMotion() || speed < 0.05 || zoom <= 1) return;
    const token = ++inertiaToken;
    let vx = velocityX * 16;
    let vy = velocityY * 16;
    const step = () => {
      if (token !== inertiaToken || !img.isConnected) return;
      vx *= 0.9;
      vy *= 0.9;
      if (Math.abs(vx) < 0.2 && Math.abs(vy) < 0.2) return;
      panX += vx;
      panY += vy;
      applyTransform();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', endDrag);

  img.addEventListener('load', () => {
    resetView();
    updateInfo();
    hideLqip();
    // 等一帧让灯箱布局稳定，再读取目标尺寸做共享元素动画。
    requestAnimationFrame(playEnter);
  });
  img.addEventListener('error', () => {
    // 失败时保留模糊占位，至少还能看出是哪张图
    ref('info').textContent = '图片加载失败，请稍后重试';
  });

  renderFilm();
  show(index);
  stage.focus({ preventScroll: true });
  return modal;
}
