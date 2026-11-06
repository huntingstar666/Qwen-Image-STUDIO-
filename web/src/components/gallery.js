/**
 * 「作品画廊」页面。
 * 精选 AIFISHER 灵感画廊与 OpenZhenZhen 的作品，封面为本地缓存的原图，按分类以卡片形式陈列；
 * 每条作品保留原始提示词与来源署名，方便复刻与追溯。
 *
 * 核心动线：
 * 1. 浏览 / 搜索 / 分类筛选；
 * 2. 卡片一键「发送到文生图」，提示词、负向、尺寸全部带上；
 * 3. 喜欢就「收藏到素材仓库」，会把封面写入素材仓库。
 */

import { copyText, escapeHtml, fmtNum } from '../utils.js';
import { toast, toastError, toastSuccess } from './toast.js';
import { openModal, closeModal } from './modal.js';
import { favoriteImage } from './favorites.js';
import { GALLERY_CATEGORIES, GALLERY_ITEMS } from '../data/gallery.js';
import { goToT2IPage, setT2IHandoff } from '../handoff.js';

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.4"/><path d="M16 16l4.2 4.2"/></svg>';

const SEND_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l14-7-5 14-3.2-5.8L5 12z"/></svg>';

/**
 * 生成一张渐变封面（PNG dataURL），用于收藏进素材仓库。
 * 尺寸固定 1400×1050，保证缩略图清晰且体积可控。
 */
export function coverDataUrl(item) {
  const width = 1400;
  const height = 1050;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const [c1, c2, c3] = item.palette || ['#8aa29e', '#426b69', '#1d3331'];

  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, c1);
  base.addColorStop(0.55, c2);
  base.addColorStop(1, c3 || c2);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.2, height * 0.16, 0, width * 0.2, height * 0.16, width * 0.9);
  glow.addColorStop(0, 'rgba(255,255,255,0.34)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(width * 0.5, height * 0.5, width * 0.28, width * 0.5, height * 0.5, width * 0.82);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.font = `700 ${Math.round(height * 0.5)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(item.index || '', width * 0.05, height * 0.09);

  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = `600 ${Math.round(height * 0.055)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(item.title, width * 0.07, height * 0.77);

  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `400 ${Math.round(height * 0.029)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.fillText(`${item.category}  ·  ${item.params?.width || ''}×${item.params?.height || ''}`, width * 0.07, height * 0.865);

  return canvas.toDataURL('image/png');
}

/** 收藏时优先用真实封面；跨域或加载失败时退回渐变封面。 */
async function collectSource(item) {
  if (!item.image) return coverDataUrl(item);
  try {
    const response = await fetch(item.image, { cache: 'force-cache' });
    if (!response.ok) throw new Error('封面加载失败');
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('封面读取失败'));
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return coverDataUrl(item);
  }
}

export function createGalleryPage(host) {
  let category = '全部';
  let keyword = '';

  host.innerHTML = `
    <div class="page page-gallery">
      <div class="lib-toolbar">
        <label class="lib-search">
          ${SEARCH_ICON}
          <input class="input" type="search" data-ref="search" placeholder="搜索标题、提示词、风格…" autocomplete="off" />
        </label>
        <span class="spacer"></span>
        <span class="lib-summary" data-ref="summary"></span>
        <button class="btn ghost" type="button" data-ref="random">随机灵感</button>
      </div>
      <div class="lib-filters">
        <div class="chips" data-ref="categories"></div>
      </div>
      <div data-ref="grid"></div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    search: ref('search'),
    summary: ref('summary'),
    random: ref('random'),
    categories: ref('categories'),
    grid: ref('grid'),
  };

  function filtered() {
    const q = keyword.trim().toLowerCase();
    return GALLERY_ITEMS.filter((item) => {
      if (category !== '全部' && item.category !== category) return false;
      if (!q) return true;
      return [item.title, item.prompt, item.style, item.category, item.description, item.model, ...(item.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }

  function coverStyle(item) {
    const [c1, c2, c3] = item.palette || [];
    return `--c1:${c1};--c2:${c2};--c3:${c3 || c2}`;
  }

  function cardMarkup(item) {
    const width = item.params?.width || 0;
    const height = item.params?.height || 0;
    return `
      <article class="gallery-card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button">
        <div class="gallery-cover${item.image ? ' has-image' : ''}" style="${coverStyle(item)}">
          ${
            item.image
              ? `<img class="gallery-cover-img" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" />`
              : ''
          }
          <span class="gallery-index">${escapeHtml(item.index)}</span>
          <span class="gallery-badge">${escapeHtml(item.category)}</span>
          <div class="gallery-cover-text">
            <div class="gallery-title">${escapeHtml(item.title)}</div>
            <div class="gallery-sub">${escapeHtml(item.style)}</div>
          </div>
          <div class="gallery-hover">
            <button class="lib-action" type="button" data-action="detail">查看</button>
            <button class="lib-action" type="button" data-action="send">${SEND_ICON}发送到文生图</button>
          </div>
        </div>
        <div class="gallery-body">
          <p class="gallery-prompt">${escapeHtml(item.prompt)}</p>
          <div class="gallery-meta">
            ${item.seed != null ? `<span class="mono">seed ${item.seed}</span>` : ''}
            <span class="mono">${width && height ? `${fmtNum(width)}×${fmtNum(height)}` : ''}</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" type="button" data-action="send">发送</button>
          </div>
        </div>
      </article>`;
  }

  function render() {
    refs.categories.innerHTML = GALLERY_CATEGORIES.map((name) => {
      const count = name === '全部' ? GALLERY_ITEMS.length : GALLERY_ITEMS.filter((item) => item.category === name).length;
      return `<button class="chip${category === name ? ' active' : ''}" type="button" data-cat="${name}">${name}<small>${count}</small></button>`;
    }).join('');

    const list = filtered();
    refs.summary.textContent = `精选 ${list.length} / ${GALLERY_ITEMS.length} 件作品`;

    if (!list.length) {
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">⌕</div>
          <div>没有匹配的作品</div>
          <div class="empty-hint">换个关键词，或把分类切回「全部」。</div>
          <button class="btn ghost" type="button" data-empty="reset">清除筛选</button>
        </div></div>`;
      refs.grid.querySelector('[data-empty="reset"]')?.addEventListener('click', () => {
        keyword = '';
        category = '全部';
        refs.search.value = '';
        render();
      });
      return;
    }

    refs.grid.innerHTML = `<div class="gallery-grid">${list.map(cardMarkup).join('')}</div>`;

    for (const card of refs.grid.querySelectorAll('.gallery-card[data-id]')) {
      const item = GALLERY_ITEMS.find((entry) => entry.id === card.dataset.id);
      if (!item) continue;
      const open = () => showDetail(item);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      for (const button of card.querySelectorAll('[data-action]')) {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (button.dataset.action === 'send') sendToT2I(item);
          else open();
        });
      }
    }
  }

  function sendToT2I(item) {
    try {
      setT2IHandoff({
        prompt: item.prompt,
        negativePrompt: item.negativePrompt || '',
        seed: item.seed,
        width: item.params?.width,
        height: item.params?.height,
        title: item.title,
      });
      closeModal();
      goToT2IPage();
    } catch (err) {
      toastError(err, '发送失败');
    }
  }

  async function collect(item, button) {
    if (button) {
      button.disabled = true;
      button.textContent = '收藏中…';
    }
    await favoriteImage({
      image: await collectSource(item),
      prompt: item.prompt,
      negativePrompt: item.negativePrompt || '',
      seed: item.seed,
      kind: 't2i',
      category: item.category,
      params: item.params,
      source: 'gallery',
      sourceRef: item.id,
      title: item.title,
    });
    if (button) {
      button.disabled = false;
      button.textContent = '收藏到素材仓库';
    }
  }

  function showDetail(item) {
    const width = item.params?.width || 0;
    const height = item.params?.height || 0;
    const content = document.createElement('div');
    content.className = 'lib-detail gallery-detail';
    content.innerHTML = `
      <div class="lib-detail-media">
        <div class="gallery-cover is-large${item.image ? ' has-image' : ''}" style="${coverStyle(item)}">
          ${
            item.image
              ? `<img class="gallery-cover-img" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" />`
              : ''
          }
          <span class="gallery-index">${escapeHtml(item.index)}</span>
          <div class="gallery-cover-text">
            <div class="gallery-title">${escapeHtml(item.title)}</div>
            <div class="gallery-sub">${escapeHtml(item.style)}</div>
          </div>
        </div>
      </div>
      <div class="lib-detail-side">
        <div class="result-badges">
          <span class="badge">${escapeHtml(item.category)}</span>
          ${item.model ? `<span class="badge">${escapeHtml(item.model)}</span>` : ''}
          ${width && height ? `<span class="badge mono">${fmtNum(width)} × ${fmtNum(height)}</span>` : ''}
          ${item.seed != null ? `<span class="badge mono">seed ${escapeHtml(String(item.seed))}</span>` : ''}
          ${item.params?.steps ? `<span class="badge">${item.params.steps} steps</span>` : ''}
          ${item.params?.cfg ? `<span class="badge">cfg ${item.params.cfg}</span>` : ''}
        </div>
        ${item.description ? `<div class="field"><span class="field-label">画面说明</span><div class="result-prompt">${escapeHtml(item.description)}</div></div>` : ''}
        <div class="field">
          <span class="field-label">提示词</span>
          <div class="result-prompt">${escapeHtml(item.prompt)}</div>
          <div class="gallery-prompt-tools">
            <button class="btn ghost sm" type="button" data-copy="prompt">复制提示词</button>
          </div>
        </div>
        ${
          item.negativePrompt
            ? `<div class="field"><span class="field-label">反向提示词</span><div class="result-prompt">${escapeHtml(item.negativePrompt)}</div></div>`
            : ''
        }
        <div class="field">
          <span class="field-label">采样参数</span>
          <div class="result-prompt mono">${escapeHtml(
            [item.params?.sampler, item.params?.scheduler, item.params?.steps && `${item.params.steps} steps`]
              .filter(Boolean)
              .join(' · ') || '—',
          )}</div>
        </div>
        <div class="gallery-source">
          来源：<a href="${escapeHtml(item.sourceSiteUrl || item.siteUrl || 'https://gallery.work-fisher.com/')}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.sourceSite || 'AIFISHER 灵感画廊')}</a>
          ${item.sourceName ? ` · ${escapeHtml(item.sourceName)}` : ''}
          ${item.sourceUrl ? ` · <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看原帖</a>` : ''}
        </div>
        <div class="gallery-tip">图片与提示词版权归原作者所有，这里仅作灵感索引与复刻起点；换种子或微调措辞即可得到不同结果。</div>
      </div>`;

    const dialog = openModal({
      title: item.title,
      subtitle: `${item.category} · ${item.style}`,
      size: 'lg',
      dialogClass: 'modal-library',
      content,
      actions: [
        {
          label: '复制提示词',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            const ok = await copyText(item.prompt);
            if (ok) toastSuccess('提示词已复制');
            else toastError(new Error('剪贴板不可用'), '复制失败');
          },
        },
        {
          label: '收藏到素材仓库',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            await collect(item);
          },
        },
        {
          label: '发送到文生图',
          kind: 'primary',
          close: false,
          onClick: () => sendToT2I(item),
        },
      ],
    });

    content.querySelector('[data-copy="prompt"]')?.addEventListener('click', async () => {
      const ok = await copyText(item.prompt);
      if (ok) toastSuccess('提示词已复制');
      else toastError(new Error('剪贴板不可用'), '复制失败');
    });

    return dialog;
  }

  let searchTimer = 0;
  refs.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      keyword = refs.search.value;
      render();
    }, 160);
  });

  refs.categories.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cat]');
    if (!button) return;
    category = button.dataset.cat;
    render();
  });

  refs.random.addEventListener('click', () => {
    const pool = filtered();
    const item = (pool.length ? pool : GALLERY_ITEMS)[Math.floor(Math.random() * (pool.length || GALLERY_ITEMS.length))];
    if (item) showDetail(item);
  });

  render();

  return {
    onShow() {
      render();
    },
  };
}
