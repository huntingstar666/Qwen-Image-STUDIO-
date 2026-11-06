/**
 * 「素材仓库」页面。
 * 与「历史记录」的差别：这里只保存用户主动收藏 / 上传的内容，
 * 数据由后端 /api/materials 持久化（storage/materials.json + 图片副本），
 * 因此清理历史不会影响这里。
 *
 * 交互：
 * 1. 卡片分类展示（文生图 / 图生图 / 精修 / 本地素材），搜索 + 分类筛选；
 * 2. 详情弹窗可复制提示词、下载、发送到文生图、在图片精修中打开、编辑元信息、删除；
 * 3. 支持一次上传多张本地图片（拖拽或选择文件），可编辑分类与备注。
 */

import { api } from '../api.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';
import { confirmDialog, openModal, closeModal } from './modal.js';
import { downloadUrl, escapeHtml, fmtNum, fmtTime, summarizeParams } from '../utils.js';
import { CATEGORY_PRESETS, KIND_LABELS } from './favorites.js';
import { goToStudioPage, goToT2IPage, setStudioHandoff, setT2IHandoff } from '../handoff.js';

const KIND_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 't2i', label: '文生图' },
  { id: 'edit', label: '图生图' },
  { id: 'studio', label: '精修' },
  { id: 'upload', label: '本地素材' },
];

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.4"/><path d="M16 16l4.2 4.2"/></svg>';

export function createMaterialsPage(host) {
  let items = [];
  let loading = false;
  let loadedAt = 0;
  let kindFilter = 'all';
  let categoryFilter = '全部';
  let keyword = '';

  host.innerHTML = `
    <div class="page page-library">
      <div class="lib-toolbar">
        <label class="lib-search">
          ${SEARCH_ICON}
          <input class="input" type="search" data-ref="search" placeholder="搜索标题、提示词、备注…" autocomplete="off" />
        </label>
        <span class="spacer"></span>
        <span class="lib-summary" data-ref="summary">加载中…</span>
        <button class="btn ghost" type="button" data-ref="refresh">刷新</button>
        <button class="btn primary" type="button" data-ref="upload">上传图片</button>
        <input type="file" accept="image/*" multiple data-ref="fileInput" hidden />
      </div>
      <div class="lib-filters">
        <div class="chips lib-kinds" data-ref="kindFilter">
          ${KIND_FILTERS.map(
            (item) =>
              `<button class="chip${item.id === 'all' ? ' active' : ''}" type="button" data-kind="${item.id}">${item.label}<small data-count="${item.id}"></small></button>`,
          ).join('')}
        </div>
        <span class="lib-divider"></span>
        <div class="chips lib-cats" data-ref="categories"></div>
      </div>
      <div class="lib-dropzone" data-ref="dropzone" hidden>松开即可上传到素材仓库</div>
      <div data-ref="grid"></div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    search: ref('search'),
    kindFilter: ref('kindFilter'),
    categories: ref('categories'),
    summary: ref('summary'),
    refresh: ref('refresh'),
    upload: ref('upload'),
    fileInput: ref('fileInput'),
    dropzone: ref('dropzone'),
    grid: ref('grid'),
  };
  const page = host.querySelector('.page-library');

  /* ============================================================
   * 数据与筛选
   * ============================================================ */
  function categories() {
    const seen = new Map();
    for (const item of items) {
      const name = item.category || '未分类';
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    // 预设分类即使为空也展示，方便用户形成固定分类习惯
    for (const name of CATEGORY_PRESETS) {
      if (!seen.has(name)) seen.set(name, 0);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  }

  function filtered() {
    const q = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
      if (categoryFilter !== '全部' && (item.category || '未分类') !== categoryFilter) return false;
      if (!q) return true;
      const haystack = [
        item.title,
        item.prompt,
        item.negativePrompt,
        item.note,
        item.category,
        ...(item.tags || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function renderCounts() {
    const counts = { all: items.length, t2i: 0, edit: 0, studio: 0, upload: 0 };
    for (const item of items) counts[item.kind] = (counts[item.kind] || 0) + 1;
    for (const chip of refs.kindFilter.querySelectorAll('[data-kind]')) {
      const badge = chip.querySelector('[data-count]');
      const count = counts[chip.dataset.kind] || 0;
      if (badge) badge.textContent = count ? String(count) : '';
      chip.classList.toggle('active', chip.dataset.kind === kindFilter);
    }
  }

  function renderCategories() {
    const list = categories().filter(([, count]) => count > 0);
    if (!list.length) {
      refs.categories.innerHTML = '<span class="lib-cats-empty">上传或收藏后会自动生成分类</span>';
      return;
    }
    refs.categories.innerHTML = list
      .map(
        ([name, count]) =>
          `<button class="chip${categoryFilter === name ? ' active' : ''}" type="button" data-cat="${escapeHtml(name)}">${escapeHtml(name)}<small>${count}</small></button>`,
      )
      .join('');
  }

  /* ============================================================
   * 卡片渲染
   * ============================================================ */
  function cardMarkup(item) {
    const image = item.image || {};
    const thumb = image.thumbUrl || image.url || '';
    const kindLabel = KIND_LABELS[item.kind] || '素材';
    const seedText = item.seed != null ? `seed ${item.seed}` : '';
    const sizeText = image.width && image.height ? `${fmtNum(image.width)}×${fmtNum(image.height)}` : '';
    const prompt = item.prompt || item.note || (item.kind === 'upload' ? '本地上传素材（无提示词）' : '（无提示词）');
    const canSend = Boolean(item.prompt);
    return `
      <article class="lib-card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button">
        <div class="lib-thumb">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(item.title || '素材')}" loading="lazy" />` : '<span class="dim">无预览</span>'}
          <span class="lib-kind">${escapeHtml(kindLabel)}</span>
          ${seedText ? `<span class="lib-seed mono">${escapeHtml(seedText)}</span>` : ''}
          <div class="lib-thumb-actions">
            <button class="lib-action" type="button" data-action="detail">查看</button>
            <button class="lib-action ${canSend ? '' : 'is-disabled'}" type="button" data-action="send" ${
              canSend ? '' : 'disabled title="该素材没有提示词"'
            }>发送到文生图</button>
          </div>
        </div>
        <div class="lib-body">
          <div class="lib-title">${escapeHtml(item.title || '未命名素材')}</div>
          <div class="lib-prompt">${escapeHtml(prompt)}</div>
          <div class="lib-meta">
            <span class="lib-cat">${escapeHtml(item.category || '未分类')}</span>
            ${sizeText ? `<span class="mono">${sizeText}</span>` : ''}
            <span class="spacer"></span>
            <span>${escapeHtml(fmtTime(item.createdAt))}</span>
          </div>
        </div>
      </article>`;
  }

  function render() {
    renderCounts();
    renderCategories();
    const list = filtered();
    const filteredText =
      kindFilter === 'all' && categoryFilter === '全部' && !keyword.trim()
        ? `共 ${items.length} 件素材`
        : `筛选出 ${list.length} / ${items.length} 件`;
    refs.summary.textContent = loading ? '加载中…' : filteredText;

    if (loading) {
      refs.grid.innerHTML = `
        <div class="lib-grid">${Array.from({ length: 8 })
          .map(() => '<div class="lib-card is-skeleton"><div class="lib-thumb"></div><div class="lib-body"><div class="sk-line"></div><div class="sk-line short"></div></div></div>')
          .join('')}</div>`;
      return;
    }

    if (!items.length) {
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">◫</div>
          <div>素材仓库还是空的</div>
          <div class="empty-hint">在生成结果或历史记录里点击「收藏」，或直接上传本地图片；也可以从作品画廊收藏喜欢的作品。</div>
          <div class="lib-empty-actions">
            <button class="btn primary" type="button" data-empty="upload">上传图片</button>
            <button class="btn ghost" type="button" data-empty="gallery">去作品画廊逛逛</button>
          </div>
        </div></div>`;
      refs.grid.querySelector('[data-empty="upload"]')?.addEventListener('click', () => refs.fileInput.click());
      refs.grid.querySelector('[data-empty="gallery"]')?.addEventListener('click', () => {
        location.hash = 'gallery';
      });
      return;
    }

    if (!list.length) {
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">⌕</div>
          <div>没有匹配的素材</div>
          <div class="empty-hint">换个关键词，或把筛选切回「全部」。</div>
          <button class="btn ghost" type="button" data-empty="reset">清除筛选</button>
        </div></div>`;
      refs.grid.querySelector('[data-empty="reset"]')?.addEventListener('click', () => {
        keyword = '';
        refs.search.value = '';
        kindFilter = 'all';
        categoryFilter = '全部';
        render();
      });
      return;
    }

    refs.grid.innerHTML = `<div class="lib-grid">${list.map(cardMarkup).join('')}</div>`;

    for (const img of refs.grid.querySelectorAll('.lib-thumb img')) {
      img.addEventListener('error', () => {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'dim', textContent: '无预览' }));
      });
    }

    for (const card of refs.grid.querySelectorAll('.lib-card[data-id]')) {
      const item = itemById(card.dataset.id);
      if (!item) continue;
      const open = () => showDetail(item);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      card.querySelector('[data-action="detail"]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        open();
      });
      card.querySelector('[data-action="send"]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        sendToT2I(item);
      });
    }
  }

  function itemById(id) {
    return items.find((item) => String(item.id) === String(id)) || null;
  }

  /* ============================================================
   * 交接与操作
   * ============================================================ */
  function sendToT2I(item) {
    if (!item?.prompt) {
      toastWarn('这件素材没有提示词，无法发送到文生图');
      return;
    }
    const image = item.image || {};
    try {
      setT2IHandoff({
        prompt: item.prompt,
        negativePrompt: item.negativePrompt || '',
        seed: item.seed,
        width: image.width || item.params?.width || null,
        height: image.height || item.params?.height || null,
        title: item.title,
      });
      closeModal();
      goToT2IPage();
    } catch (err) {
      toastError(err, '发送失败');
    }
  }

  function openInStudio(item) {
    const image = item.image || {};
    if (!image.url) {
      toastWarn('这件素材没有可打开的图片');
      return;
    }
    try {
      setStudioHandoff({
        url: image.url,
        name: image.filename || `${item.title || 'material'}.png`,
        title: item.title,
      });
      closeModal();
      goToStudioPage();
    } catch (err) {
      toastError(err, '打开失败');
    }
  }

  function showDetail(item) {
    const image = item.image || {};
    const badges = [
      `<span class="badge">${escapeHtml(KIND_LABELS[item.kind] || '素材')}</span>`,
      `<span class="badge">${escapeHtml(item.category || '未分类')}</span>`,
      item.seed != null ? `<span class="badge mono">seed ${escapeHtml(String(item.seed))}</span>` : '',
      image.width && image.height ? `<span class="badge">${fmtNum(image.width)} × ${fmtNum(image.height)}</span>` : '',
      `<span class="badge">${escapeHtml(fmtTime(item.createdAt))}</span>`,
    ]
      .filter(Boolean)
      .join('');

    const refsHtml = (item.referenceImages || []).length
      ? `<div class="field">
           <span class="field-label">参考图</span>
           <div class="lib-refs">${item.referenceImages
             .map(
               (ref) =>
                 `<a class="lib-ref" href="${escapeHtml(api.fileUrl(ref.url))}" target="_blank" rel="noopener"><img src="${escapeHtml(
                   api.fileUrl(ref.thumbUrl || ref.url),
                 )}" alt="参考图" loading="lazy" /></a>`,
             )
             .join('')}</div>
         </div>`
      : '';

    const content = document.createElement('div');
    content.className = 'lib-detail';
    content.innerHTML = `
      <div class="lib-detail-media">
        ${image.url ? `<img src="${escapeHtml(api.fileUrl(image.url))}" alt="${escapeHtml(item.title || '素材')}" />` : '<div class="empty"><div>没有可显示的图片</div></div>'}
      </div>
      <div class="lib-detail-side">
        <div class="result-badges">${badges}</div>
        <div class="field">
          <span class="field-label">标题</span>
          <div class="lib-detail-title">${escapeHtml(item.title || '未命名素材')}</div>
        </div>
        <div class="field">
          <span class="field-label">提示词</span>
          <div class="result-prompt">${escapeHtml(item.prompt || '（无提示词）')}</div>
        </div>
        ${
          item.negativePrompt
            ? `<div class="field"><span class="field-label">反向提示词</span><div class="result-prompt">${escapeHtml(item.negativePrompt)}</div></div>`
            : ''
        }
        ${
          item.note
            ? `<div class="field"><span class="field-label">备注</span><div class="result-prompt">${escapeHtml(item.note)}</div></div>`
            : ''
        }
        ${refsHtml}
        ${
          Object.keys(item.params || {}).length
            ? `<div class="field"><span class="field-label">参数摘要</span><pre class="result-prompt mono" style="margin:0">${escapeHtml(
                summarizeParams(item.params),
              )}</pre></div>`
            : ''
        }
      </div>`;

    openModal({
      title: item.title || '素材详情',
      subtitle: KIND_LABELS[item.kind] || '素材',
      size: 'lg',
      dialogClass: 'modal-library',
      content,
      actions: [
        {
          label: '删除',
          kind: 'danger',
          close: false,
          onClick: async () => {
            const ok = await confirmDialog({
              title: '删除素材',
              message: `将从素材仓库删除「${escapeHtml(item.title || '未命名素材')}」，原始历史记录不受影响。`,
              confirmText: '删除',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.deleteMaterial(item.id);
              items = items.filter((entry) => entry.id !== item.id);
              toastSuccess('素材已删除');
              closeModal();
              render();
            } catch (err) {
              toastError(err, '删除失败');
            }
          },
        },
        {
          label: '编辑信息',
          kind: 'ghost',
          close: false,
          onClick: () => openEdit(item),
        },
        {
          label: '下载',
          kind: 'ghost',
          close: false,
          onClick: () => {
            if (!image.url) {
              toastWarn('没有可下载的图片');
              return;
            }
            downloadUrl(api.fileUrl(image.url), image.filename || 'material.png');
          },
        },
        {
          label: '在图片精修中打开',
          kind: 'ghost',
          close: false,
          onClick: () => openInStudio(item),
        },
        {
          label: '发送到文生图',
          kind: 'primary',
          close: false,
          onClick: () => sendToT2I(item),
        },
      ],
    });
  }

  function openEdit(item) {
    const content = document.createElement('div');
    content.className = 'lib-edit';
    content.innerHTML = `
      <div class="field">
        <span class="field-label">标题</span>
        <input class="input" type="text" data-field="title" maxlength="80" value="${escapeHtml(item.title || '')}" />
      </div>
      <div class="field">
        <span class="field-label">分类</span>
        <input class="input" type="text" data-field="category" list="lib-category-list" maxlength="24" value="${escapeHtml(
          item.category || '未分类',
        )}" />
        <datalist id="lib-category-list">${CATEGORY_PRESETS.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
      </div>
      <div class="field">
        <span class="field-label">提示词</span>
        <textarea class="textarea" data-field="prompt" rows="4">${escapeHtml(item.prompt || '')}</textarea>
      </div>
      <div class="field">
        <span class="field-label">备注</span>
        <textarea class="textarea" data-field="note" rows="3" placeholder="记录一下这张图的思路或用途">${escapeHtml(item.note || '')}</textarea>
      </div>`;

    openModal({
      title: '编辑素材信息',
      subtitle: item.title || '',
      size: 'sm',
      content,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async () => {
            const value = (name) => content.querySelector(`[data-field="${name}"]`).value;
            try {
              const data = await api.updateMaterial(item.id, {
                title: value('title').trim(),
                category: value('category').trim() || '未分类',
                prompt: value('prompt').trim(),
                note: value('note').trim(),
              });
              const updated = data?.item;
              if (updated) {
                items = items.map((entry) => (entry.id === updated.id ? updated : entry));
                render();
              }
              toastSuccess('素材信息已更新');
              closeModal();
            } catch (err) {
              toastError(err, '保存失败');
            }
          },
        },
      ],
    });
  }

  /* ============================================================
   * 上传
   * ============================================================ */
  async function uploadFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    const category = categoryFilter === '全部' ? '未分类' : categoryFilter;
    let done = 0;
    let failed = 0;
    refs.upload.disabled = true;
    for (const file of files) {
      refs.upload.textContent = `上传 ${done + failed + 1}/${files.length}`;
      try {
        await api.uploadMaterial(file, { title: file.name.replace(/\.[^.]+$/, ''), category });
        done += 1;
      } catch (err) {
        failed += 1;
        console.error('[materials] 上传失败', file.name, err);
      }
    }
    refs.upload.disabled = false;
    refs.upload.textContent = '上传图片';
    refs.fileInput.value = '';
    if (done) toastSuccess(`已上传 ${done} 张图片`);
    if (failed) toastError(new Error(`${failed} 张图片上传失败`), '部分上传失败');
    await load({ force: true });
  }

  /* ============================================================
   * 加载与事件
   * ============================================================ */
  async function load({ force = false } = {}) {
    if (loading) return;
    if (!force && Date.now() - loadedAt < 5000 && items.length) return;
    loading = true;
    render();
    try {
      const data = await api.materials({ limit: 500 });
      items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      loadedAt = Date.now();
    } catch (err) {
      items = [];
      loadedAt = 0;
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">!</div>
          <div>素材仓库加载失败</div>
          <div class="empty-hint">${escapeHtml(err.message || '后端服务未就绪')}</div>
          <button class="btn ghost" type="button" data-empty="retry">重试</button>
        </div></div>`;
      refs.grid.querySelector('[data-empty="retry"]')?.addEventListener('click', () => load({ force: true }));
      toastError(err, '素材仓库加载失败');
    } finally {
      loading = false;
      render();
    }
  }

  let searchTimer = 0;
  refs.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      keyword = refs.search.value;
      render();
    }, 160);
  });

  refs.kindFilter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button) return;
    kindFilter = button.dataset.kind;
    render();
  });

  refs.categories.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cat]');
    if (!button) return;
    // 再次点击当前分类即取消筛选，省掉一个多余的「全部」按钮
    categoryFilter = categoryFilter === button.dataset.cat ? '全部' : button.dataset.cat;
    render();
  });

  refs.refresh.addEventListener('click', () => load({ force: true }));
  refs.upload.addEventListener('click', () => refs.fileInput.click());
  refs.fileInput.addEventListener('change', () => uploadFiles(refs.fileInput.files));

  let dragDepth = 0;
  page.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    refs.dropzone.hidden = false;
    page.classList.add('is-dragover');
  });
  page.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
  });
  page.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      refs.dropzone.hidden = true;
      page.classList.remove('is-dragover');
    }
  });
  page.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    refs.dropzone.hidden = true;
    page.classList.remove('is-dragover');
    uploadFiles(event.dataTransfer.files);
  });

  return {
    onShow() {
      load({ force: false });
    },
  };
}
