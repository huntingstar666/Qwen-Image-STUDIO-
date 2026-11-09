/**
 * 统一导入选择器（D1.1）。
 *
 * 三个来源：本地文件 / 素材仓库 / 最近结果。只负责「选择 + 取图」，
 * 统一返回 dataURL 条目；主图取第一张、其余转参考图的分流由调用方决定。
 * 不修改 refLibrary.js，素材仓库与最近结果沿用它的网格视觉。
 */

import { api } from '../../api.js';
import { escapeHtml, probeImageSize, readFileAsDataURL } from '../../utils.js';
import { toastError, toastWarn } from '../toast.js';
import { openModal } from '../modal.js';

/** 与 refLibrary 保持一致的拖拽 MIME，供后续拖拽矩阵复用。 */
export const REF_MIME = 'application/x-wb-ref';

const HISTORY_LIMIT = 20;
const MATERIAL_LIMIT = 200;

function isImageFile(file) {
  return Boolean(file && String(file.type || '').startsWith('image/'));
}

/** 从 DataTransfer 取出图片文件（files 为空时回退到 items）。 */
export function filesFromDataTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const files = [...(dataTransfer.files || [])].filter(isImageFile);
  if (files.length) return files;
  return [...(dataTransfer.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file) => isImageFile(file));
}

/** File → 统一条目（dataURL + 尺寸）。 */
export async function readImageFile(file) {
  const src = await readFileAsDataURL(file);
  let width = 0;
  let height = 0;
  try {
    ({ width, height } = await probeImageSize(src));
  } catch {
    // 尺寸拿不到不阻止导入，后端会自行读取
  }
  return { name: file?.name || 'image.png', src, width, height, source: 'local' };
}

/** URL / 相对路径 → dataURL（提交契约要求 dataURL）。 */
export async function urlToDataUrl(url) {
  const src = String(url || '');
  if (!src) throw new Error('图片地址为空');
  if (/^data:/i.test(src)) return src;
  const response = await fetch(src);
  if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (!String(blob.type || '').startsWith('image/')) throw new Error('返回内容不是图片');
  return readFileAsDataURL(blob);
}

/** 按 src 去重，保持首次出现的顺序。 */
function dedupeBySrc(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.src || seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function historyCandidates(data) {
  const rows = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  const items = [];
  for (const row of rows) {
    const images = Array.isArray(row?.images)
      ? row.images
      : Array.isArray(row?.outputs)
        ? row.outputs
        : Array.isArray(row?.files)
          ? row.files
          : [];
    for (const [index, image] of images.entries()) {
      const url = typeof image === 'string' ? image : image?.url || image?.path || image?.src;
      if (!url) continue;
      const thumb = typeof image === 'string' ? url : image?.thumb_url || image?.thumb || url;
      items.push({
        src: api.fileUrl(url),
        thumb: api.fileUrl(thumb),
        name:
          (typeof image === 'object' && (image.filename || image.name)) ||
          row?.prompt?.slice(0, 24) ||
          `历史结果 ${index + 1}`,
        width: Number(image?.width) || 0,
        height: Number(image?.height) || 0,
        source: 'history',
      });
    }
    if (items.length >= HISTORY_LIMIT) break;
  }
  return dedupeBySrc(items).slice(0, HISTORY_LIMIT);
}

function materialCandidates(data) {
  const rows = Array.isArray(data?.items) ? data.items : [];
  return dedupeBySrc(
    rows
      .filter((item) => item?.image?.url)
      .map((item) => ({
        src: api.fileUrl(item.image.url),
        thumb: api.fileUrl(item.image.thumbUrl || item.image.url),
        name: item.title || item.prompt || '仓库素材',
        width: Number(item.image.width) || 0,
        height: Number(item.image.height) || 0,
        // D26.1：图层素材带 sidecar（kind/props），置入时可重建为文字/形状图层。
        params: item.params || null,
        source: 'warehouse',
      })),
  );
}

/**
 * 打开统一导入选择器。
 *
 * @param {object} [options]
 * @param {string} [options.title] 弹窗标题
 * @param {boolean} [options.multiple] 是否多选（主图默认单选，参考图传 true）
 * @param {'main'|'ref'} [options.accept] 用途，仅影响文案与默认上限
 * @param {number} [options.max] 最多返回张数
 * @param {'local'|'warehouse'|'history'} [options.initialSource] 打开时默认来源
 * @param {(items: Array<{name:string,src:string,width:number,height:number,source:string}>) => void} [options.onPick]
 * @returns {{close:Function, body:HTMLElement}}
 */
export function openImportPicker({
  title = '导入素材',
  multiple = false,
  accept = 'main',
  max,
  initialSource = 'local',
  onPick,
} = {}) {
  const limit = Math.max(1, Number(max) || (multiple ? 3 : 1));
  const selected = new Map();
  const candidates = new Map();
  const cache = { warehouse: null, history: null };
  const loading = { warehouse: false, history: false };
  let source = 'local';
  let grid = null;
  let panel = null;

  const content = document.createElement('div');
  content.className = 'ip';
  content.innerHTML = `
    <div class="ip-tabs" role="tablist">
      <button class="ip-tab active" type="button" role="tab" data-source="local">本地文件</button>
      <button class="ip-tab" type="button" role="tab" data-source="warehouse">素材仓库</button>
      <button class="ip-tab" type="button" role="tab" data-source="history">最近结果</button>
    </div>
    <div class="ip-panel" data-ref="panel"></div>
    <div class="ip-foot">
      <span class="ip-count" data-ref="count"></span>
      <span class="spacer"></span>
      <button class="btn ghost sm" type="button" data-ref="cancel">取消</button>
      <button class="btn primary sm" type="button" data-ref="confirm">选择文件</button>
    </div>`;

  const $ = (name) => content.querySelector(`[data-ref="${name}"]`);
  panel = $('panel');
  const countLabel = $('count');
  const confirmBtn = $('confirm');

  const modal = openModal({
    title,
    subtitle:
      accept === 'main'
        ? '本地可多选：第一张作为主图，其余按顺序转为参考图'
        : `可多选，最多 ${limit} 张`,
    size: 'lg',
    content,
    hideFooter: true,
  });

  function syncFooter() {
    const size = selected.size;
    countLabel.textContent = source === 'local' ? '' : size ? `已选 ${size} / ${limit} 张` : `最多 ${limit} 张`;
    confirmBtn.disabled = false;
    confirmBtn.textContent = source === 'local' ? '选择文件' : '导入所选';
  }

  function renderSelection() {
    if (grid) {
      for (const card of grid.querySelectorAll('[data-src]')) {
        card.classList.toggle('selected', selected.has(card.dataset.src));
      }
    }
    syncFooter();
  }

  function toggle(candidate) {
    if (!candidate?.src) return;
    if (selected.has(candidate.src)) {
      selected.delete(candidate.src);
    } else {
      if (!multiple) selected.clear();
      if (selected.size >= limit) {
        toastWarn(`最多选择 ${limit} 张`);
        return;
      }
      selected.set(candidate.src, candidate);
    }
    renderSelection();
  }

  function cardHtml(item) {
    const active = selected.has(item.src);
    const dims = item.width && item.height ? `${item.width}×${item.height}` : '—';
    return `
      <button class="ref-pick${active ? ' selected' : ''}" type="button" data-src="${escapeHtml(item.src)}"
        title="${escapeHtml(item.name || '图片')}">
        <img src="${escapeHtml(item.thumb || item.src)}" alt="" loading="lazy" />
        <span class="ref-pick-meta">${dims}</span>
        <span class="ref-pick-check">✓</span>
      </button>`;
  }

  function renderGrid(items, emptyText) {
    grid = document.createElement('div');
    grid.className = 'ref-pick-grid';
    if (!items.length) {
      panel.innerHTML = `<div class="ip-status">${escapeHtml(emptyText)}</div>`;
      grid = null;
      return;
    }
    grid.innerHTML = items.map(cardHtml).join('');
    panel.innerHTML = '';
    panel.append(grid);
    grid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-src]');
      if (!card) return;
      toggle(candidates.get(card.dataset.src));
    });
  }

  function renderStatus(text, retry) {
    panel.innerHTML = `<div class="ip-status">${escapeHtml(text)}${
      retry ? ' <button class="btn ghost sm" type="button" data-ref="retry">重试</button>' : ''
    }</div>`;
    panel.querySelector('[data-ref="retry"]')?.addEventListener('click', retry);
  }

  async function loadSource(next) {
    if (next === 'local') {
      renderLocal();
      return;
    }
    if (cache[next]) {
      renderGrid(cache[next], next === 'warehouse' ? '素材仓库还是空的' : '还没有生成结果');
      return;
    }
    if (loading[next]) return;
    loading[next] = true;
    renderStatus(next === 'warehouse' ? '正在加载素材仓库…' : '正在读取最近结果…');
    try {
      const data = next === 'warehouse' ? await api.materials({ limit: MATERIAL_LIMIT }) : await api.history(HISTORY_LIMIT);
      const items = next === 'warehouse' ? materialCandidates(data) : historyCandidates(data);
      cache[next] = items;
      for (const item of items) candidates.set(item.src, item);
      renderGrid(items, next === 'warehouse' ? '素材仓库还是空的' : '还没有生成结果');
    } catch (err) {
      renderStatus(err?.message || '加载失败', () => {
        loading[next] = false;
        void loadSource(next);
      });
    } finally {
      loading[next] = false;
    }
  }

  function renderLocal() {
    panel.innerHTML = `
      <div class="ip-local" data-ref="drop">
        <div class="ip-local-icon">＋</div>
        <div>选择本地图片，或把图片拖到这里</div>
        <div class="field-hint">PNG / JPG / WebP · 可多选</div>
        <button class="btn ghost sm" type="button" data-ref="browse">选择文件</button>
        <input type="file" accept="image/*" multiple hidden data-ref="file" />
      </div>`;
    const drop = panel.querySelector('[data-ref="drop"]');
    const input = panel.querySelector('[data-ref="file"]');
    panel.querySelector('[data-ref="browse"]').addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      void pickLocal(input.files);
      input.value = '';
    });
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('drop');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('drop');
      void pickLocal(filesFromDataTransfer(event.dataTransfer));
    });
    syncFooter();
  }

  async function pickLocal(files) {
    // 主图允许一次拖入多张：第一张作主图，其余由调用方转参考图（上限 1 主 + 3 参考）。
    const localLimit = accept === 'main' ? 4 : limit;
    const list = [...(files || [])].filter(isImageFile).slice(0, localLimit);
    if (!list.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    const items = [];
    for (const file of list) {
      try {
        items.push(await readImageFile(file));
      } catch (err) {
        toastError(err, `读取 ${file.name} 失败`);
      }
    }
    const picked = dedupeBySrc(items).slice(0, localLimit);
    if (!picked.length) return;
    modal.close();
    onPick?.(picked);
  }

  async function confirmSelection() {
    if (!selected.size) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '读取中…';
    const picked = [];
    for (const item of [...selected.values()].slice(0, limit)) {
      try {
        const src = await urlToDataUrl(item.src);
        let { width, height } = item;
        if (!width || !height) {
          try {
            ({ width, height } = await probeImageSize(src));
          } catch {
            // 尺寸未知不影响导入
          }
        }
        if (picked.some((entry) => entry.src === src)) continue;
        // D26.1：保留素材自带的图层 sidecar（kind/props），置入时才能重建可编辑图层。
        picked.push({
          name: item.name || 'image.png',
          src,
          width,
          height,
          source: item.source,
          params: item.params || null,
        });
      } catch (err) {
        toastError(err, `读取「${item.name || '图片'}」失败`);
      }
    }
    if (!picked.length) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '导入所选';
      return;
    }
    modal.close();
    onPick?.(picked);
  }

  content.querySelector('.ip-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-source]');
    if (!tab || tab.dataset.source === source) return;
    source = tab.dataset.source;
    selected.clear();
    for (const button of content.querySelectorAll('[data-source]')) {
      button.classList.toggle('active', button === tab);
    }
    syncFooter();
    void loadSource(source);
  });

  $('cancel').addEventListener('click', () => modal.close());
  confirmBtn.addEventListener('click', () => {
    if (source === 'local') panel.querySelector('[data-ref="file"]')?.click();
    else void confirmSelection();
  });

  renderLocal();
  if (initialSource === 'warehouse' || initialSource === 'history') {
    content.querySelector(`[data-source="${initialSource}"]`)?.click();
  }
  return { close: modal.close, body: content };
}
