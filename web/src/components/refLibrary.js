/**
 * 图生图页左侧「小图库」。
 * 存放本次会话可能用到的参考图，来源：
 * 1. 上传按钮 / 直接把电脑上的图片拖进来；
 * 2. 「从仓库」从素材仓库挑选；
 * 3. 从右侧历史胶囊把缩略图拖进来。
 *
 * 交互：点击缩略图 → 加入下方参考图区域；拖动缩略图 → 拖进指令框插入 @ 引用 chip；
 * 点右上角 × → 从小图库移除，同时把对应参考图从参考图区域移除。
 * 会话级共享（切页回来仍在），不写 localStorage，避免 dataURL 撑爆存储。
 */

import { api } from '../api.js';
import { escapeHtml, probeImageSize, readFileAsDataURL } from '../utils.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';
import { openModal } from './modal.js';

const MAX_ITEMS = 24;
export const REF_DRAG_TYPE = 'application/x-wb-ref';

/** 会话级图库内容：模块级变量，切页重建组件时仍保留。 */
const sessionItems = [];

function hashSrc(src) {
  let hash = 0;
  const text = String(src || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function itemId(src) {
  return `lib-${hashSrc(src)}`;
}

/** 读取拖拽载荷里的图片描述（历史胶囊 / 小图库之间互拖）。 */
export function readRefDrag(event) {
  const raw = event.dataTransfer?.getData(REF_DRAG_TYPE);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data?.src ? data : null;
  } catch {
    return null;
  }
}

export function hasRefDrag(event) {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes(REF_DRAG_TYPE));
}

/**
 * @param {HTMLElement} host 挂载容器
 * @param {{onUse?: (item:object)=>void, onRemove?: (item:object)=>void}} [options]
 */
export function createRefLibrary(host, { onUse, onRemove } = {}) {
  host.innerHTML = `
    <div class="lib-head">
      <span class="lib-title">小图库</span>
      <span class="lib-count mono" data-ref="count">0</span>
    </div>
    <div class="lib-actions">
      <button class="lib-btn" type="button" data-ref="warehouse" title="从素材仓库选择参考图">⧉ 仓库</button>
      <button class="lib-btn" type="button" data-ref="upload" title="上传本地图片">＋ 上传</button>
    </div>
    <div class="lib-grid" data-ref="grid"></div>
    <div class="lib-empty" data-ref="empty">
      <span class="lib-empty-icon">▦</span>
      <span>拖入图片 / 上传 / 从仓库添加</span>
      <span class="lib-empty-hint">拖进指令框即可 @ 引用</span>
    </div>
    <div class="lib-foot">点图加入参考图 · 拖图进指令框</div>
    <input type="file" accept="image/*" multiple hidden data-ref="file" />`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    count: ref('count'),
    warehouse: ref('warehouse'),
    upload: ref('upload'),
    grid: ref('grid'),
    empty: ref('empty'),
    file: ref('file'),
  };

  let usedKeys = new Set();

  /** 稳定的插入顺序：同一 src 只存一份。 */
  function findIndexBySrc(src) {
    return sessionItems.findIndex((item) => item.src === src);
  }

  function render() {
    refs.count.textContent = String(sessionItems.length);
    refs.empty.classList.toggle('hidden', sessionItems.length > 0);
    refs.grid.innerHTML = sessionItems
      .map((item, index) => {
        const used = usedKeys.has(item.id);
        return `
        <div class="lib-thumb${used ? ' in-refs' : ''}" draggable="true" data-lib-id="${escapeHtml(item.id)}"
          title="${escapeHtml(item.name || '参考图')}${item.width && item.height ? ` · ${item.width}×${item.height}` : ''}\n点击加入参考图 · 拖进指令框 @ 引用">
          <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.name || '参考图')}" loading="lazy" draggable="false" />
          <span class="lib-no mono">${index + 1}</span>
          ${used ? '<span class="lib-used">已用</span>' : ''}
          <button class="lib-del" type="button" data-del="${escapeHtml(item.id)}" title="从小图库移除（同时移出参考图）">×</button>
        </div>`;
      })
      .join('');
  }

  function setUsed(keys) {
    usedKeys = new Set(keys || []);
    for (const node of refs.grid.querySelectorAll('[data-lib-id]')) {
      node.classList.toggle('in-refs', usedKeys.has(node.dataset.libId));
    }
    render();
  }

  async function fillSize(item) {
    if (item.width && item.height) return item;
    try {
      const { width, height } = await probeImageSize(item.src);
      item.width = width;
      item.height = height;
      render();
    } catch {
      // 尺寸拿不到不影响引用，提交时后端会自己读
    }
    return item;
  }

  /**
   * 加入一张图（已存在则复用）。
   * @param {{src:string,name?:string,width?:number,height?:number,source?:string}} input
   * @returns {Promise<object|null>} 图库条目
   */
  async function addItem(input) {
    const src = String(input?.src || '');
    if (!src) return null;
    const existing = findIndexBySrc(src);
    if (existing >= 0) {
      const item = sessionItems[existing];
      await fillSize(item);
      return item;
    }
    if (sessionItems.length >= MAX_ITEMS) {
      toastWarn(`小图库最多 ${MAX_ITEMS} 张，请先移除一些`);
      return null;
    }
    const item = {
      id: itemId(src),
      src,
      name: input.name || '参考图',
      width: Number(input.width) || 0,
      height: Number(input.height) || 0,
      source: input.source || 'upload',
    };
    sessionItems.push(item);
    render();
    await fillSize(item);
    return item;
  }

  async function addFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    let added = 0;
    for (const file of files) {
      if (sessionItems.length >= MAX_ITEMS) {
        toastWarn(`小图库最多 ${MAX_ITEMS} 张，已忽略剩余文件`);
        break;
      }
      try {
        const dataUrl = await readFileAsDataURL(file);
        if (findIndexBySrc(dataUrl) >= 0) continue;
        await addItem({ src: dataUrl, name: file.name, source: 'upload' });
        added += 1;
      } catch (err) {
        toastError(err, `读取 ${file.name} 失败`);
      }
    }
    if (added) toastSuccess(`已加入小图库 ${added} 张`);
  }

  function removeItem(id) {
    const index = sessionItems.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = sessionItems.splice(index, 1);
    render();
    onRemove?.(item);
  }

  /* ------------------------------------------------------------ 素材仓库选择 */

  function openWarehousePicker() {
    const content = document.createElement('div');
    content.className = 'ref-pick-wrap';
    content.innerHTML = '<div class="ref-pick-status">正在加载素材仓库…</div>';
    const selected = new Set();
    const itemById = new Map();

    openModal({
      title: '从素材仓库添加参考图',
      subtitle: '点选可多选；已在图库中的素材会标记「已添加」',
      size: 'lg',
      content,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '添加所选',
          kind: 'primary',
          onClick: async () => {
            if (!selected.size) {
              toastWarn('还没有选择素材');
              return false;
            }
            const picked = [...selected];
            selected.clear();
            let added = 0;
            for (const id of picked) {
              const item = itemById.get(id);
              const image = item?.image || {};
              if (!image.url) continue;
              const before = sessionItems.length;
              await addItem({
                src: api.fileUrl(image.url),
                name: item.title || item.prompt || '仓库素材',
                width: image.width,
                height: image.height,
                source: 'warehouse',
              });
              if (sessionItems.length > before) added += 1;
            }
            toastSuccess(added ? `已加入小图库 ${added} 张` : '所选素材已在小图库中');
          },
        },
      ],
    });

    api
      .materials({ limit: 200 })
      .then((data) => {
        const items = (Array.isArray(data?.items) ? data.items : []).filter((item) => item?.image?.url);
        const grid = document.createElement('div');
        grid.className = 'ref-pick-grid';
        if (!items.length) {
          content.innerHTML = '<div class="ref-pick-status">素材仓库还是空的，先去收藏或上传一些图片吧。</div>';
          return;
        }
        grid.innerHTML = items
          .map((item) => {
            itemById.set(item.id, item);
            const image = item.image || {};
            const exists = Boolean(item.image?.url) && findIndexBySrc(api.fileUrl(image.url)) >= 0;
            return `
              <button class="ref-pick${exists ? ' is-added' : ''}" type="button" data-pick="${escapeHtml(item.id)}"
                ${exists ? 'disabled' : ''} title="${escapeHtml(item.title || item.prompt || '素材')}">
                <img src="${escapeHtml(api.fileUrl(image.thumbUrl || image.url))}" alt="" loading="lazy" />
                <span class="ref-pick-meta">${image.width && image.height ? `${image.width}×${image.height}` : '—'}</span>
                ${exists ? '<span class="ref-pick-flag">已添加</span>' : '<span class="ref-pick-check">✓</span>'}
              </button>`;
          })
          .join('');
        content.innerHTML = '';
        content.append(grid);

        grid.addEventListener('click', (event) => {
          const card = event.target.closest('[data-pick]');
          if (!card || card.disabled) return;
          const id = card.dataset.pick;
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          card.classList.toggle('selected', selected.has(id));
        });
      })
      .catch((err) => {
        content.innerHTML = '';
        const tip = document.createElement('div');
        tip.className = 'ref-pick-status';
        tip.textContent = err?.message || '素材仓库加载失败';
        content.append(tip);
      });
  }

  /* ------------------------------------------------------------ 事件 */

  refs.upload.addEventListener('click', () => refs.file.click());
  refs.file.addEventListener('change', async () => {
    await addFiles(refs.file.files);
    refs.file.value = '';
  });
  refs.warehouse.addEventListener('click', openWarehousePicker);

  refs.grid.addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      event.stopPropagation();
      removeItem(del.dataset.del);
      return;
    }
    const thumb = event.target.closest('[data-lib-id]');
    if (!thumb) return;
    const item = sessionItems.find((entry) => entry.id === thumb.dataset.libId);
    if (item) onUse?.(item);
  });

  refs.grid.addEventListener('dragstart', (event) => {
    const thumb = event.target.closest('[data-lib-id]');
    if (!thumb) return;
    const item = sessionItems.find((entry) => entry.id === thumb.dataset.libId);
    if (!item) return;
    const payload = JSON.stringify({
      key: item.id,
      src: item.src,
      name: item.name,
      width: item.width,
      height: item.height,
    });
    try {
      event.dataTransfer.setData(REF_DRAG_TYPE, payload);
      event.dataTransfer.setData('text/plain', item.name || '参考图');
    } catch {
      // ignore
    }
    event.dataTransfer.effectAllowed = 'copy';
    thumb.classList.add('dragging');
  });
  refs.grid.addEventListener('dragend', () => {
    refs.grid.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  });

  // 直接把电脑上的图片拖到小图库面板
  host.addEventListener('dragover', (event) => {
    if (!hasRefDrag(event) && ![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    host.classList.add('drop-active');
  });
  host.addEventListener('dragleave', (event) => {
    if (host.contains(event.relatedTarget)) return;
    host.classList.remove('drop-active');
  });
  host.addEventListener('drop', async (event) => {
    if (!hasRefDrag(event) && !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    host.classList.remove('drop-active');
    const payload = readRefDrag(event);
    if (payload?.src) {
      const item = await addItem({
        src: payload.src,
        name: payload.name,
        width: payload.width,
        height: payload.height,
        source: 'history',
      });
      if (item) toastSuccess('已加入小图库');
      return;
    }
    await addFiles(event.dataTransfer?.files);
  });

  render();
  return { addItem, addFiles, removeItem, setUsed, items: sessionItems, element: host };
}
