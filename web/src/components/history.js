/**
 * 「历史」页面。
 * 职责：
 * 1. GET /api/history?limit=30 拉取生成记录，缩略图网格展示；
 * 2. 点击查看大图 + 参数摘要 + 提示词；
 * 3. 下载、复制提示词、导出工作流 JSON（/api/workflow/{id}.json，失败时中文提示）；
 * 4. 删除单条（后端若未提供单条接口则优雅提示）与清空全部历史；
 * 5. 「精修工程」分组（D22.1 V4）：复用 IndexedDB 的 listProjects()，与工作室底部 Dock 同源。
 */

import { api } from '../api.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { confirmDialog, openModal } from './modal.js';
import { favoriteImage } from './favorites.js';
import { clearProject, leaseHeldByOther, listProjects } from './studio/persistence.js';
import {
  copyText,
  downloadUrl,
  escapeHtml,
  fmtElapsed,
  fmtNum,
  fmtTime,
  summarizeParams,
} from '../utils.js';

const LIMIT = 60;

export function createHistoryPage(host) {
  let items = [];
  let loading = false;
  let loadedAt = 0;
  let projects = [];

  host.innerHTML = `
    <div class="page page-history">
      <div class="history-toolbar">
        <div class="chips" data-ref="kindFilter">
          <button class="chip active" type="button" data-kind="all">全部</button>
          <button class="chip" type="button" data-kind="t2i">文生图</button>
          <button class="chip" type="button" data-kind="edit">图像编辑</button>
        </div>
        <span class="history-summary" data-ref="summary">加载中…</span>
        <span class="spacer"></span>
        <button class="btn ghost sm" type="button" data-ref="refresh">刷新</button>
        <button class="btn danger sm" type="button" data-ref="clearAll">清空全部</button>
      </div>
      <div class="history-projects" data-ref="projectSection">
        <div class="history-section-head">
          <span class="history-section-title">精修工程</span>
          <span class="history-section-count" data-ref="projectCount"></span>
          <span class="spacer"></span>
          <button class="btn ghost sm" type="button" data-ref="projectRefresh">刷新</button>
        </div>
        <div class="history-project-grid" data-ref="projectGrid"></div>
      </div>
      <div data-ref="grid"></div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    kindFilter: ref('kindFilter'),
    summary: ref('summary'),
    refresh: ref('refresh'),
    clearAll: ref('clearAll'),
    grid: ref('grid'),
    projectCount: ref('projectCount'),
    projectRefresh: ref('projectRefresh'),
    projectGrid: ref('projectGrid'),
  };
  let kindFilter = 'all';

  /* ============================================================
   * 精修工程（D22.1 V4）
   * ============================================================ */
  function currentTabToken() {
    try {
      let token = sessionStorage.getItem('wb.studio.tab');
      if (!token) {
        token = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem('wb.studio.tab', token);
      }
      return token;
    } catch {
      return '';
    }
  }

  function openProject(id) {
    try {
      sessionStorage.setItem('wb.studio.openProject', id);
    } catch {
      toastWarn('无法写入会话存储，请手动打开精修页');
      return;
    }
    if (location.hash === '#studio') {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    location.hash = '#studio';
  }

  function renderProjects() {
    refs.projectCount.textContent = projects.length ? `${projects.length} 个` : '';
    if (!projects.length) {
      refs.projectGrid.innerHTML = `
        <div class="history-project-empty">
          <span>还没有精修工程</span>
          <button class="btn ghost sm" type="button" data-proj-act="new">打开「图片精修」新建一个</button>
        </div>`;
      return;
    }
    const tab = currentTabToken();
    refs.projectGrid.innerHTML = projects
      .map((project) => {
        const locked = leaseHeldByOther(project.id, tab);
        const size = project.width && project.height ? `${fmtNum(project.width)} × ${fmtNum(project.height)}` : '';
        const when = project.updatedAt ? fmtTime(new Date(project.updatedAt).toISOString()) : '';
        return `
          <div class="history-project-card" data-pid="${escapeHtml(project.id)}">
            <div class="history-project-thumb">
              ${
                project.thumbnail
                  ? `<img src="${escapeHtml(project.thumbnail)}" alt="" loading="lazy" />`
                  : '<span class="dim">无预览</span>'
              }
            </div>
            <div class="history-project-info">
              <div class="history-project-name">${escapeHtml(project.name || '未命名工程')}</div>
              <div class="history-project-meta mono">${escapeHtml([size, when, locked ? '编辑中' : ''].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="history-project-actions">
              <button class="btn primary sm" type="button" data-proj-act="open"${locked ? ' disabled' : ''}>打开</button>
              <button class="btn ghost sm" type="button" data-proj-act="delete">删除</button>
            </div>
          </div>`;
      })
      .join('');
  }

  async function loadProjects() {
    try {
      projects = await listProjects();
    } catch {
      projects = [];
    }
    renderProjects();
  }

  refs.projectGrid.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-proj-act]');
    if (!button) return;
    const action = button.dataset.projAct;
    if (action === 'new') {
      location.hash = '#studio';
      return;
    }
    const card = button.closest('[data-pid]');
    const id = card?.dataset.pid;
    if (!id) return;
    if (action === 'open') {
      openProject(id);
      return;
    }
    if (action === 'delete') {
      const name = card.querySelector('.history-project-name')?.textContent || '该工程';
      const confirmed = await confirmDialog({
        title: '删除精修工程',
        message: `删除「${escapeHtml(name)}」？本机工程、图层、参考图与版本记录会一起删除，不可恢复。`,
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await clearProject(id);
        toastSuccess('工程已删除');
        await loadProjects();
      } catch (err) {
        toastError(err, '删除工程失败');
      }
    }
  });

  refs.projectRefresh.addEventListener('click', () => {
    void loadProjects();
  });

  /* ============================================================
   * 数据归一化（后端字段可能略有差异，做兼容读取）
   * ============================================================ */
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const imagesRaw = Array.isArray(raw.images)
      ? raw.images
      : Array.isArray(raw.outputs)
        ? raw.outputs
        : Array.isArray(raw.files)
          ? raw.files
          : [];
    const images = imagesRaw
      .map((image, index) => {
        if (typeof image === 'string') {
          return { url: image, thumb: image, width: null, height: null, filename: `output-${index + 1}.png` };
        }
        const url = image.url || image.path || image.src || '';
        return {
          url,
          thumb: image.thumb_url || image.thumb || url,
          width: image.width ?? null,
          height: image.height ?? null,
          filename: image.filename || image.name || `output-${index + 1}.png`,
        };
      })
      .filter((image) => image.url);
    const thumbnail = raw.thumbnail || raw.thumb || images[0]?.thumb || images[0]?.url || '';
    return {
      id: raw.id ?? raw.job_id ?? raw.jobId ?? `history-${Math.random().toString(36).slice(2, 8)}`,
      kind: raw.kind || raw.params?.kind || 't2i',
      status: raw.status || 'done',
      prompt: raw.prompt || raw.params?.prompt || '',
      params: raw.params || {},
      meta: raw.meta || {},
      images,
      thumbnail,
      align: raw.align || null,
      quality: raw.quality || null,
      elapsed_ms: raw.elapsed_ms ?? null,
      created_at: raw.created_at || raw.createdAt || raw.time || null,
    };
  }

  function imageUrl(path) {
    return api.fileUrl(path);
  }

  function filteredItems() {
    if (kindFilter === 'all') return items;
    return items.filter((item) => item.kind === kindFilter);
  }

  /* ============================================================
   * 列表渲染
   * ============================================================ */
  function render() {
    const list = filteredItems();
    refs.summary.textContent = loading ? '加载中…' : `共 ${items.length} 条记录${kindFilter === 'all' ? '' : ` · 当前筛选 ${list.length} 条`}`;
    if (loading) {
      refs.grid.innerHTML = '<div class="empty"><div class="spinner"></div><div>正在读取历史记录…</div></div>';
      return;
    }
    if (!list.length) {
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">◫</div>
          <div>还没有历史记录</div>
          <div class="field-hint">生成或编辑成功后，结果会自动出现在这里。</div>
        </div></div>`;
      return;
    }
    refs.grid.innerHTML = `<div class="history-grid">${list
      .map((item) => {
        const thumb = item.thumbnail ? imageUrl(item.thumbnail) : '';
        const first = item.images[0];
        const sizeText = first?.width && first?.height ? `${fmtNum(first.width)}×${fmtNum(first.height)}` : '';
        const statusText = { queued: '排队中', running: '进行中', error: '失败', canceled: '已取消' }[item.status] || '';
        return `
          <div class="history-card" data-history-id="${escapeHtml(String(item.id))}" role="button" tabindex="0">
            <div class="history-thumb" data-thumb>
              ${thumb ? `<img src="${escapeHtml(thumb)}" alt="历史缩略图" loading="lazy" />` : `<span class="dim">无预览</span>`}
            </div>
            <div class="history-info">
              <div class="history-title">${escapeHtml(item.prompt || '（无提示词）')}</div>
              <div class="history-meta">
                <span class="kind-tag">${item.kind === 'edit' ? '编辑' : '文生图'}</span>
                ${statusText ? `<span style="color:var(--warn)">${statusText}</span>` : ''}
                ${sizeText ? `<span>${sizeText}</span>` : ''}
                <span>${escapeHtml(fmtTime(item.created_at))}</span>
              </div>
            </div>
          </div>`;
      })
      .join('')}</div>`;

    // 缩略图缺失或加载失败：隐藏图片，不显示破图
    for (const img of refs.grid.querySelectorAll('.history-thumb img')) {
      img.addEventListener('error', () => {
        img.remove();
        const thumb = img.closest('[data-thumb]');
        if (thumb && !thumb.querySelector('.dim')) thumb.innerHTML = '<span class="dim">无预览</span>';
      });
    }
    for (const card of refs.grid.querySelectorAll('[data-history-id]')) {
      const open = () => showDetail(card.dataset.historyId);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
    }
  }

  /* ============================================================
   * 详情弹窗
   * ============================================================ */
  function itemById(id) {
    return items.find((item) => String(item.id) === String(id)) || null;
  }

  function showDetail(id) {
    const item = itemById(id);
    if (!item) return;

    const badges = [];
    if (item.elapsed_ms != null) badges.push(`<span class="badge info">耗时 ${fmtElapsed(item.elapsed_ms)}</span>`);
    const first = item.images[0];
    if (first?.width && first?.height) badges.push(`<span class="badge">${fmtNum(first.width)} × ${fmtNum(first.height)}</span>`);
    if (item.align?.canvas) badges.push(`<span class="badge">画布 ${fmtNum(item.align.canvas.w)} × ${fmtNum(item.align.canvas.h)}</span>`);
    if (item.quality?.outside_max_abs != null) {
      const zero = Number(item.quality.outside_max_abs) === 0;
      badges.push(
        `<span class="badge ${zero ? 'ok' : 'warn'}">遮罩外差异 ${fmtNum(item.quality.outside_max_abs)}${zero ? ' · 零色差' : ''}</span>`,
      );
    }
    badges.push(`<span class="badge">${escapeHtml(fmtTime(item.created_at))}</span>`);

    const imagesHtml = item.images.length
      ? `<div class="result-grid">${item.images
          .map(
            (image, index) => `
            <div class="result-card">
              <div class="result-img-wrap">
                <a href="${escapeHtml(imageUrl(image.url))}" target="_blank" rel="noopener" title="打开原图">
                  <img src="${escapeHtml(imageUrl(image.url))}" alt="历史结果 ${index + 1}" loading="lazy" />
                </a>
              </div>
              <div class="result-card-foot">
                <span class="mono">${fmtNum(image.width)}×${fmtNum(image.height)}</span>
                <span class="spacer"></span>
                <button class="btn ghost sm" type="button" data-favorite-index="${index}">收藏</button>
                <button class="btn ghost sm" type="button" data-download-index="${index}">下载</button>
              </div>
            </div>`,
          )
          .join('')}</div>`
      : '<div class="empty"><div class="glyph">⌀</div><div>该记录没有可显示的图片</div></div>';

    const content = document.createElement('div');
    content.className = 'history-detail';
    content.innerHTML = `
      ${imagesHtml}
      <div class="result-badges">${badges.join('')}</div>
      <div class="field">
        <span class="field-label">提示词</span>
        <div class="result-prompt">${escapeHtml(item.prompt || '（无）')}</div>
      </div>
      <div class="field">
        <span class="field-label">参数摘要</span>
        <pre class="result-prompt mono" style="margin:0;font-family:var(--mono)">${escapeHtml(summarizeParams(item.params))}</pre>
      </div>`;

    content.querySelectorAll('[data-download-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const image = item.images[Number(button.dataset.downloadIndex)];
        if (image) downloadUrl(imageUrl(image.url), image.filename);
      });
    });

    content.querySelectorAll('[data-favorite-index]').forEach((button) => {
      button.addEventListener('click', async () => {
        const image = item.images[Number(button.dataset.favoriteIndex)];
        if (!image) return;
        button.disabled = true;
        const original = button.textContent;
        button.textContent = '收藏中…';
        await favoriteImage({
          image: imageUrl(image.url),
          prompt: item.prompt,
          seed: item.params?.seed ?? null,
          kind: item.kind === 'edit' ? 'edit' : 't2i',
          params: item.params,
          source: 'history',
          sourceRef: String(item.id),
        });
        button.disabled = false;
        button.textContent = original;
      });
    });

    openModal({
      title: item.kind === 'edit' ? '图像编辑记录' : '文生图记录',
      subtitle: `#${item.id}`,
      size: 'lg',
      content,
      actions: [
        {
          label: '下载全部',
          kind: 'ghost',
          close: false,
          onClick: () => {
            if (!item.images.length) {
              toastWarn('该记录没有可下载的图片');
              return;
            }
            item.images.forEach((image, index) => {
              setTimeout(() => downloadUrl(imageUrl(image.url), image.filename), index * 220);
            });
          },
        },
        {
          label: '复制提示词',
          kind: 'ghost',
          close: false,
          onClick: async () => {
            const ok = await copyText(item.prompt || '');
            toast(ok ? '提示词已复制' : '复制失败，请手动选中复制', ok ? 'success' : 'warn');
          },
        },
        {
          label: '任务参数 JSON',
          kind: 'ghost',
          close: false,
          onClick: () => downloadWorkflow(item),
        },
      ],
    });
  }

  async function downloadWorkflow(item) {
    // 后端没有 /api/workflow/{id}.json，提供的是可复现请求参数 /api/jobs/{id}/replay.json
    const url = api.replayUrl(item.id);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      downloadUrl(objectUrl, `replay-${item.id}.json`);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      toastSuccess('任务参数 JSON 已开始下载');
    } catch (err) {
      toastWarn(`导出任务参数失败：${err.message}。后端可能还未实现 ${url}`);
    }
  }

  /* ============================================================
   * 加载 / 清空 / 事件
   * ============================================================ */
  async function load({ force = false } = {}) {
    if (loading) return;
    if (!force && Date.now() - loadedAt < 5000 && items.length) return;
    loading = true;
    render();
    try {
      const data = await api.history(LIMIT);
      const rawItems = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      items = rawItems.map(normalizeItem).filter(Boolean);
      loadedAt = Date.now();
    } catch (err) {
      items = [];
      loadedAt = 0;
      refs.grid.innerHTML = `
        <div class="panel"><div class="empty">
          <div class="glyph">!</div>
          <div>历史记录加载失败</div>
          <div class="field-hint">${escapeHtml(err.message || '后端服务未就绪')}</div>
          <button class="btn ghost sm" type="button" data-ref="retry">重试</button>
        </div></div>`;
      refs.grid.querySelector('[data-retry]')?.addEventListener('click', () => load({ force: true }));
      toastError(err, '历史记录加载失败');
    } finally {
      loading = false;
      render();
    }
  }

  refs.kindFilter.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button) return;
    kindFilter = button.dataset.kind;
    for (const chip of refs.kindFilter.querySelectorAll('[data-kind]')) {
      chip.classList.toggle('active', chip === button);
    }
    render();
  });

  refs.refresh.addEventListener('click', () => load({ force: true }));

  refs.clearAll.addEventListener('click', async () => {
    if (!items.length) {
      toastWarn('当前没有历史记录');
      return;
    }
    const confirmed = await confirmDialog({
      title: '清空全部历史',
      message: '将请求后端清空全部历史记录（删除接口由后端决定是否同时删除图片文件）。此操作不可撤销。',
      confirmText: '清空全部',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteHistory();
      items = [];
      loadedAt = 0;
      toastSuccess('历史记录已清空');
      render();
    } catch (err) {
      toastError(err, '清空历史失败');
    }
  });

  return {
    onShow() {
      void loadProjects();
      load({ force: false });
    },
  };
}
