/**
 * 页面右侧的隐藏式历史胶囊。
 * 收起时是一条通高书脊（竖排标题 + 批次计数），点击向左展开同高面板，
 * 按时间倒序列出本次会话生成的批次：时间、编号、张数、尺寸、缩略图，
 * 支持查看高清大图、收藏首图、下载整批。
 */

import { downloadUrl, escapeHtml, fmtNum } from '../utils.js';
import { openLightbox } from './lightbox.js';
import { favoriteImage } from './favorites.js';
import { REF_DRAG_TYPE } from './refLibrary.js';

const MAX_ITEMS = 60;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatFullTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTime(timestamp)}`;
}

/**
 * @param {HTMLElement} host 页面容器（胶囊会挂到这里，随页面一起显示 / 隐藏）
 * @param {{label?: string}} [options]
 */
export function createHistoryRail(host, { label = '生成历史' } = {}) {
  const rail = document.createElement('div');
  rail.className = 'history-rail';
  rail.innerHTML = `
    <div class="hr-panel">
      <div class="hr-panel-inner">
        <div class="hr-head">
          <span class="hr-title">${escapeHtml(label)}</span>
          <span class="hr-count" data-ref="count">0 批</span>
          <span class="spacer"></span>
          <button class="hr-close" type="button" data-ref="close" title="收起" aria-label="收起历史记录">×</button>
        </div>
        <div class="hr-list" data-ref="list"></div>
        <div class="hr-empty" data-ref="empty">
          <span class="hr-empty-icon">◧</span>
          <span>还没有生成记录</span>
          <span>生成结果会按时间收在这里</span>
        </div>
      </div>
    </div>
    <button class="hr-tab" type="button" data-ref="tab" aria-expanded="false" title="生成历史：点击展开">
      <span class="hr-tab-count" data-ref="tabCount">0</span>
      <span class="hr-tab-label">生成历史</span>
      <span class="hr-tab-chev" aria-hidden="true">‹</span>
    </button>`;

  // 挂在 .page 内部，才能配合 `:has(.wb-layout.adv-open)` 做侧栏避让
  const mount = host.querySelector('.page') || host;
  mount.append(rail);

  const list = rail.querySelector('[data-ref="list"]');
  const empty = rail.querySelector('[data-ref="empty"]');
  const countEl = rail.querySelector('[data-ref="count"]');
  const tabCount = rail.querySelector('[data-ref="tabCount"]');
  const tab = rail.querySelector('[data-ref="tab"]');
  const closeBtn = rail.querySelector('[data-ref="close"]');

  /** @type {Map<string, object>} */
  const batches = new Map();

  function setOpen(open) {
    rail.classList.toggle('is-open', open);
    tab.setAttribute('aria-expanded', String(open));
  }

  function syncCount() {
    const total = batches.size;
    countEl.textContent = `${total} 批`;
    tabCount.textContent = String(total);
    tabCount.classList.toggle('hidden', total === 0);
    empty.classList.toggle('hidden', total > 0);
  }

  function viewBatch(batch) {
    if (!batch.images.length) return;
    const no = pad2(batch.no);
    openLightbox(
      batch.images.map((image, index) => ({
        ...image,
        label: batch.images.length > 1 ? `批次 ${no} · 第 ${index + 1} 张` : `批次 ${no}`,
      })),
      0,
      { title: `批次 ${no} · 高清大图` },
    );
  }

  function itemNode(batch) {
    const first = batch.images[0] || {};
    const sizeText = first.width && first.height ? `${fmtNum(first.width)} × ${fmtNum(first.height)}` : '—';
    const node = document.createElement('div');
    node.className = 'hr-item is-current';
    node.dataset.batch = String(batch.no);
    node.title = `${formatFullTime(batch.time)} · 批次 ${pad2(batch.no)}${batch.prompt ? `\n${batch.prompt}` : ''}`;
    node.innerHTML = `
      <button class="hr-thumb" type="button" data-act="view" title="查看高清大图（可拖进小图库）" draggable="true">
        <img src="${escapeHtml(first.url || '')}" alt="批次 ${pad2(batch.no)} 缩略图" loading="lazy" draggable="false" />
        <span class="hr-no mono">#${pad2(batch.no)}</span>
      </button>
      <div class="hr-info">
        <div class="hr-line">
          <span class="hr-time mono">${formatTime(batch.time)}</span>
          <span class="hr-dot">·</span>
          <span class="hr-count-text">${batch.images.length} 张</span>
        </div>
        <div class="hr-dims mono">${sizeText}</div>
      </div>
      <div class="hr-actions">
        ${batch.favoriteMeta ? '<button class="hr-act" type="button" data-act="favorite" title="收藏首图">☆</button>' : ''}
        <button class="hr-act" type="button" data-act="download" title="下载本批">↓</button>
      </div>`;
    return node;
  }

  /**
   * 追加一批结果（最新的排在最前）。
   * @param {object} batch JobRunner 生成的批次对象
   */
  function add(batch) {
    if (!batch || !Array.isArray(batch.images) || !batch.images.length) return;
    const key = String(batch.no);
    if (batches.has(key)) return;
    batches.set(key, batch);

    list.querySelectorAll('.hr-item.is-current').forEach((node) => node.classList.remove('is-current'));
    list.prepend(itemNode(batch));

    while (list.children.length > MAX_ITEMS) {
      const last = list.lastElementChild;
      if (!last) break;
      batches.delete(last.dataset.batch);
      last.remove();
    }
    syncCount();
  }

  function clear() {
    batches.clear();
    list.innerHTML = '';
    syncCount();
    setOpen(false);
  }

  tab.addEventListener('click', () => setOpen(!rail.classList.contains('is-open')));
  closeBtn.addEventListener('click', () => setOpen(false));

  document.addEventListener('pointerdown', (event) => {
    if (!rail.classList.contains('is-open')) return;
    if (!rail.contains(event.target)) setOpen(false);
  });

  list.addEventListener('dragstart', (event) => {
    const thumb = event.target.closest('.hr-thumb');
    const item = thumb?.closest('.hr-item');
    const batch = item ? batches.get(item.dataset.batch) : null;
    const image = batch?.images?.[0];
    if (!image?.url) {
      event.preventDefault();
      return;
    }
    try {
      event.dataTransfer.setData(
        REF_DRAG_TYPE,
        JSON.stringify({
          src: image.url,
          name: image.filename || `批次${pad2(batch.no)}`,
          width: image.width,
          height: image.height,
        }),
      );
      event.dataTransfer.setData('text/plain', image.filename || '历史图片');
      event.dataTransfer.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const item = button.closest('.hr-item');
    const batch = item ? batches.get(item.dataset.batch) : null;
    if (!batch) return;

    const act = button.dataset.act;
    if (act === 'view') {
      viewBatch(batch);
      return;
    }
    if (act === 'download') {
      batch.images.forEach((image, index) => {
        setTimeout(() => downloadUrl(image.url, image.filename || `output-${index + 1}.png`), index * 220);
      });
      return;
    }
    if (act === 'favorite') {
      const image = batch.images[0];
      if (!image || !batch.favoriteMeta) return;
      button.disabled = true;
      await favoriteImage({
        ...batch.favoriteMeta,
        image: image.url,
        prompt: batch.prompt || '',
        seed: batch.job?.params?.seed ?? null,
      });
      button.disabled = false;
    }
  });

  syncCount();
  return { add, clear };
}
