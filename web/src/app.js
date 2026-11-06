/**
 * 应用布局与路由。
 * 职责：
 * 1. 渲染顶栏（项目名 / 引擎状态 / 显存 / Ollama / 队列）并每 5s 轮询 /api/health；
 * 2. 渲染页签，按 location.hash 切换页面（文生图 / 图像编辑 / 历史）；
 * 3. 启动时加载 /api/options 与 /api/styles（供提示词上方的风格选择器使用），
 *    失败时给出中文提示而不是白屏。
 */

import { api } from './api.js';
import { applyOptionDefaults, patchRuntime, patchSettings, store } from './store.js';
import { toastError, toastWarn, toast } from './components/toast.js';
import { escapeHtml } from './utils.js';
import { createT2IPage } from './components/t2i.js';
import { createEditPage } from './components/edit.js';
import { createImageToolsPage } from './components/imageTools.js';
import { createHistoryPage } from './components/history.js';
import { createMaterialsPage } from './components/materials.js';

/* ---------------------------------------------------------------- 图标 */

const NAV_ICONS = {
  sparkles:
    '<path d="M12 3.6l1.65 4.2 4.2 1.65-4.2 1.65L12 15.3l-1.65-4.2-4.2-1.65 4.2-1.65L12 3.6z"/><path d="M18.2 14.6l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85.85-2.15z"/>',
  sliders:
    '<path d="M4 7h7M15 7h5M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="13" cy="7" r="1.8"/><circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="17" r="1.8"/>',
  brush:
    '<path d="M14.5 4.5l3 3-8.2 8.2a3.4 3.4 0 01-4.8-4.8l8.2-8.2z"/><path d="M5.2 15.2c-1 .9-1.7 2.3-1.7 4.3 2 0 3.4-.7 4.3-1.7"/><path d="M13.5 6.5l2 2"/>',
  grid:
    '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  archive:
    '<path d="M4 8.5V19a1 1 0 001 1h14a1 1 0 001-1V8.5"/><rect x="3.2" y="4.2" width="17.6" height="4.3" rx="1.3"/><path d="M9.5 12.2h5"/>',
  wand:
    '<path d="M4.5 19.5l9.2-9.2M12.3 4.2l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2z"/><path d="M18.4 9.6l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55.55-1.35z"/><path d="M13.5 5.8l1.2 2.6 2.6 1.2"/>',
  clock:
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/>',
  sun:
    '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.2v1.9M12 18.9v1.9M3.2 12h1.9M18.9 12h1.9M5.8 5.8l1.35 1.35M16.85 16.85l1.35 1.35M18.2 5.8l-1.35 1.35M7.15 16.85L5.8 18.2"/>',
  moon: '<path d="M19.2 14.6A7.6 7.6 0 019.4 4.8a7.7 7.7 0 109.8 9.8z"/>',
  auto:
    '<rect x="3.5" y="5" width="17" height="12.5" rx="2"/><path d="M8 21h8M12 17.5V21"/><path d="M8.2 13.5l2.1-5.2 2.1 5.2M9.1 11.7h2.4"/>',
  chevron:
    '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};

function navIcon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[name] || ''}</svg>`;
}

/* ---------------------------------------------------------------- 页面注册 */

function createPlaceholderPage(label, message) {
  return (host) => {
    host.innerHTML = `
      <div class="page">
        <div class="panel">
          <div class="empty">
            <div class="glyph">${navIcon('sparkles')}</div>
            <div>${escapeHtml(label)}正在建设中</div>
            <div class="empty-hint">${escapeHtml(message)}</div>
          </div>
        </div>
      </div>`;
    return {};
  };
}

const NAV_GROUPS = [
  { id: 'create', label: '创作' },
  { id: 'assets', label: '资产' },
  { id: 'utilities', label: '工具' },
];

const TABS = [
  { id: 't2i', label: '文生图', sub: '文字生成图片', code: 'TEXT → IMAGE', group: 'create', icon: 'sparkles', factory: createT2IPage },
  { id: 'edit', label: '图像编辑', sub: '蒙版局部重绘', code: 'IMAGE + MASK', group: 'create', icon: 'sliders', factory: createEditPage },
  {
    id: 'studio',
    label: '图片精修',
    sub: '调整 · 蒙版 · 局部编辑',
    code: 'RETOUCH STUDIO',
    group: 'create',
    icon: 'brush',
    badge: '新',
    factory: createPlaceholderPage('图片精修', 'PS 式工作台正在建设中'),
  },
  {
    id: 'gallery',
    label: '作品画廊',
    sub: '精选灵感与提示词',
    code: 'INSPIRATION',
    group: 'assets',
    icon: 'grid',
    badge: '新',
    factory: createPlaceholderPage('作品画廊', '精选作品与提示词正在整理'),
  },
  {
    id: 'materials',
    label: '素材仓库',
    sub: '我收藏的作品与素材',
    code: 'COLLECTION',
    group: 'assets',
    icon: 'archive',
    badge: '新',
    factory: createMaterialsPage,
  },
  { id: 'tools', label: '图像处理', sub: '裁剪 · 调色 · 扩图', code: 'IMAGE TOOLS', group: 'utilities', icon: 'wand', factory: createImageToolsPage },
  { id: 'history', label: '历史记录', sub: '全部生成与编辑结果', code: 'HISTORY', group: 'utilities', icon: 'clock', factory: createHistoryPage },
];

const pages = new Map();
let healthTimer = 0;
let healthFailing = false;

/* ============================================================
 * 顶栏
 * ============================================================ */
function renderTopbar() {
  const host = document.getElementById('topbar');
  host.innerHTML = `
    <button class="mobile-menu" type="button" data-action="menu" aria-label="打开导航">${navIcon('menu')}</button>
    <div class="topbar-titles">
      <div class="topbar-kicker">
        <span data-ref="kickerGroup">创作</span>
        <span aria-hidden="true">/</span>
        <span data-ref="kickerLabel">文生图</span>
      </div>
      <h1 class="topbar-title" data-ref="pageTitle">文生图</h1>
      <p class="topbar-sub" data-ref="pageSub">文字生成图片</p>
    </div>
    <div class="topbar-status">
      <div class="status" data-ref="engine" title="本地推理引擎状态">
        <span class="dot"></span>
        <span class="status-label">引擎</span>
        <span class="status-detail" data-role="text">连接中…</span>
      </div>
      <div class="status" data-ref="vram" title="显存占用（已用 / 总量）">
        <span class="status-label">显存</span>
        <span class="status-detail" data-role="text">—</span>
        <button class="status-action" type="button" data-ref="freeVram" title="POST /api/engine/free（unload=true）：释放显存并卸载模型">释放</button>
      </div>
      <div class="status" data-ref="ollama" title="Ollama 本地大模型（用于提示词润色）">
        <span class="dot"></span>
        <span class="status-label">Ollama</span>
        <span class="status-detail" data-role="text">连接中…</span>
        <select class="mini-select" data-ref="polishModel" aria-label="提示词润色模型" title="提示词润色使用的 Ollama 模型"></select>
      </div>
      <div class="status" data-ref="queue" title="生成任务队列">
        <span class="dot"></span>
        <span class="status-label">队列</span>
        <span class="status-detail" data-role="text">—</span>
      </div>
    </div>`;
  host.querySelector('[data-ref="polishModel"]').addEventListener('change', (event) => {
    patchSettings({ polishModel: event.target.value });
    toast(`润色模型已切换为 ${event.target.value}`, 'info', { timeout: 2200 });
  });
  host.querySelector('[data-ref="freeVram"]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '释放中…';
    try {
      await api.engineFree({ unload: true });
      toast('已释放显存并卸载模型；下次生成会自动重新加载', 'success', { timeout: 4200 });
      await pollHealth();
    } catch (err) {
      toastError(err, '释放显存失败');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
  host.querySelector('[data-action="menu"]').addEventListener('click', () => {
    setMobileNav(!document.getElementById('app-shell').classList.contains('is-mobile-open'));
  });
}

/* ============================================================
 * 侧边栏
 * ============================================================ */
function renderSidebar() {
  const host = document.getElementById('sidebar');
  const groups = NAV_GROUPS.map((group) => {
    const items = TABS.filter((tab) => tab.group === group.id)
      .map(
        (tab) => `
          <button class="nav-item" type="button" data-tab="${tab.id}" role="tab" aria-selected="false" title="${escapeHtml(tab.label)} · ${escapeHtml(tab.sub)}">
            <span class="nav-icon">${navIcon(tab.icon)}</span>
            <span class="nav-label">${escapeHtml(tab.label)}</span>
            ${tab.badge ? `<span class="nav-badge">${escapeHtml(tab.badge)}</span>` : ''}
          </button>`,
      )
      .join('');
    return `
      <div class="nav-group">
        <div class="nav-group-title">${escapeHtml(group.label)}</div>
        ${items}
      </div>`;
  }).join('');

  const themeOptions = [
    { mode: 'light', label: '亮色', icon: 'sun' },
    { mode: 'dark', label: '暗色', icon: 'moon' },
    { mode: 'system', label: '自动', icon: 'auto' },
  ]
    .map(
      (item) => `
        <button class="theme-option" type="button" data-theme-option="${item.mode}" title="${item.label}主题">
          ${navIcon(item.icon)}<span>${item.label}</span>
        </button>`,
    )
    .join('');

  host.innerHTML = `
    <div class="sidebar-head">
      <div class="sidebar-brand">
        <div class="brand-mark-lg" aria-hidden="true">Q</div>
        <div class="brand-copy">
          <div class="brand-name">Qwen-Image</div>
          <div class="brand-tag">Studio 2.1</div>
        </div>
      </div>
      <button class="sidebar-collapse" type="button" data-action="collapse" title="收起 / 展开侧边栏" aria-label="收起侧边栏">
        ${navIcon('chevron')}
      </button>
    </div>
    <div class="sidebar-scroll">${groups}</div>
    <div class="sidebar-foot">
      <div class="sidebar-meta" data-ref="idleHint"></div>
      <div class="theme-switch" role="group" aria-label="主题模式">${themeOptions}</div>
    </div>`;

  host.addEventListener('click', (event) => {
    const themeButton = event.target.closest('[data-theme-option]');
    if (themeButton) {
      store.setTheme(themeButton.dataset.themeOption);
      syncThemeOptions();
      return;
    }
    if (event.target.closest('[data-action="collapse"]')) {
      store.setSidebarCollapsed(!store.state.sidebarCollapsed);
      applyShellState();
      return;
    }
    const tabButton = event.target.closest('[data-tab]');
    if (!tabButton) return;
    const id = tabButton.dataset.tab;
    if (location.hash === `#${id}`) route();
    else location.hash = id;
    if (window.innerWidth <= 820) setMobileNav(false);
  });

  syncThemeOptions();
  applyShellState();
}

function syncThemeOptions() {
  const mode = store.state.theme || 'system';
  for (const button of document.querySelectorAll('[data-theme-option]')) {
    button.classList.toggle('active', button.dataset.themeOption === mode);
  }
}

function applyShellState() {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.toggle('is-collapsed', Boolean(store.state.sidebarCollapsed));
}

function setMobileNav(open) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  shell.classList.toggle('is-mobile-open', Boolean(open));
}

function statusEl(name) {
  return document.querySelector(`[data-ref="${name}"]`);
}

function setStatus(name, { dot = null, text = null, title = null }) {
  const el = statusEl(name);
  if (!el) return;
  const dotEl = el.querySelector('.dot');
  if (dot) dotEl.className = `dot ${dot}`;
  if (text != null) {
    const textEl = el.querySelector('[data-role="text"]');
    if (textEl) textEl.textContent = text;
  }
  if (title) el.title = title;
}

function fillModelOptions(models) {
  const select = statusEl('polishModel');
  if (!select) return;
  const current = store.state.polishModel || select.value || '';
  const list = Array.isArray(models) ? models : [];
  if (!list.length) {
    select.innerHTML = '<option value="">—</option>';
    return;
  }
  const preferred = list.includes(current) ? current : list.includes('qwen3.5:9b') ? 'qwen3.5:9b' : list[0];
  select.innerHTML = list.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  select.value = preferred;
  if (!store.state.polishModel) patchSettings({ polishModel: preferred });
}

function renderHealth(health) {
  if (!health) return;
  const engine = health.engine || {};
  const ready = Boolean(engine.ready ?? engine.available);
  const loaded = engine.loaded || {};
  const loadedNames = [loaded.unet, loaded.clip, loaded.vae].filter(Boolean);
  const loralNames = Array.isArray(loaded.loras)
    ? loaded.loras.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
    : [];
  setStatus('engine', {
    dot: ready ? 'ok' : 'warn',
    text: ready ? '就绪' : '未就绪',
    title: [
      engine.reason || (ready ? '推理引擎可用' : '引擎不可用'),
      engine.device ? `设备 ${engine.device}` : '',
      loadedNames.length ? `已加载：${loadedNames.join(' / ')}` : '模型尚未加载，首次生成会自动加载',
      loralNames.length ? `LoRA：${loralNames.join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const total = Number(engine.vram_total_mb) || 0;
  const free = Number(engine.vram_free_mb) || 0;
  if (total > 0) {
    const used = Math.max(0, total - free);
    setStatus('vram', {
      text: `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB`,
      title: `显存占用 ${used} MB / ${total} MB（空闲 ${free} MB）`,
    });
  } else {
    setStatus('vram', { text: '—', title: engine.reason || '未获取到显存信息' });
  }

  const ollama = health.ollama || {};
  const models = Array.isArray(ollama.models) ? ollama.models : [];
  setStatus('ollama', {
    dot: ollama.connected ? 'ok' : 'bad',
    text: ollama.connected ? `${models.length} 个模型` : '未连接',
    title: ollama.connected ? `Ollama 已连接：${models.join('、') || '无模型'}` : 'Ollama 未连接，提示词润色将不可用',
  });
  fillModelOptions(models);

  const queue = health.queue || {};
  const pending = Number(queue.pending) || 0;
  const running = Boolean(queue.running);
  setStatus('queue', {
    dot: running || pending > 0 ? 'busy' : 'ok',
    text: `${pending} 待处理${running ? ' · 运行中' : ''}`,
    title: `排队 ${pending} 个任务${running ? '，当前有任务运行中' : ''}${health.outputs != null ? `；已产出 ${health.outputs} 张图` : ''}`,
  });
  updateIdleHint(health);
}

function updateIdleHint(health) {
  const hint = document.querySelector('[data-ref="idleHint"]');
  if (!hint) return;
  const engine = health?.engine || {};
  const minutes = Number(
    health?.config?.idle_unload_minutes ?? engine.idle_unload_minutes ?? engine.config?.idle_unload_minutes ?? 0,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) {
    hint.textContent = '';
    hint.title = '';
    return;
  }
  const idleSeconds = Number(engine.idle_seconds ?? health?.idle_seconds ?? NaN);
  hint.textContent = `空闲 ${minutes} 分钟后自动释放显存`;
  hint.title = Number.isFinite(idleSeconds)
    ? `已空闲约 ${Math.max(0, Math.floor(idleSeconds / 60))} 分钟；也可点击「释放显存」立即卸载`
    : '长时间空闲后服务端会自动卸载模型释放显存';
}

function renderHealthError() {
  setStatus('engine', { dot: 'bad', text: '服务未连接', title: '无法连接 127.0.0.1:8700，请确认后端已启动' });
  setStatus('vram', { text: '—' });
  setStatus('ollama', { dot: 'bad', text: '未知' });
  setStatus('queue', { dot: 'bad', text: '—' });
  updateIdleHint(null);
}

async function pollHealth() {
  try {
    const health = await api.health();
    healthFailing = false;
    patchRuntime({ health });
    renderHealth(health);
  } catch (err) {
    renderHealthError();
    if (!healthFailing) {
      healthFailing = true;
      toastWarn('后端服务未连接：生成、编辑、历史等功能暂不可用。请确认服务已在 127.0.0.1:8700 启动。');
    }
  }
}

function startHealthLoop() {
  clearInterval(healthTimer);
  pollHealth();
  healthTimer = setInterval(pollHealth, 5000);
}

/* ============================================================
 * 导航与路由
 * ============================================================ */
function currentTabId() {
  const id = String(location.hash || '').replace(/^#/, '');
  return TABS.some((tab) => tab.id === id) ? id : 't2i';
}

function updateTopbarTitles(tab) {
  if (!tab) return;
  const group = NAV_GROUPS.find((item) => item.id === tab.group);
  const set = (name, value) => {
    const el = document.querySelector(`[data-ref="${name}"]`);
    if (el) el.textContent = value;
  };
  set('kickerGroup', group?.label || '工作台');
  set('kickerLabel', tab.label);
  set('pageTitle', tab.label);
  set('pageSub', tab.sub);
  document.title = `${tab.label} · Qwen-Image 2.1 工作台`;
}

function route() {
  const id = currentTabId();
  patchRuntime({ activeTab: id });
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  updateTopbarTitles(TABS.find((tab) => tab.id === id));
  showPage(id);
}

function showPage(id) {
  const viewport = document.getElementById('viewport');
  const definition = TABS.find((tab) => tab.id === id);
  if (!definition) return;
  if (!pages.has(id)) {
    const host = document.createElement('div');
    host.className = 'page-host';
    host.dataset.page = id;
    viewport.append(host);
    let page;
    try {
      page = definition.factory(host);
    } catch (err) {
      console.error('[app] 页面初始化失败', err);
      host.innerHTML = `<div class="panel"><div class="empty"><div class="glyph">!</div><div>页面初始化失败：${escapeHtml(err?.message || String(err))}</div></div></div>`;
      page = {};
    }
    pages.set(id, { host, page });
  }
  for (const [pageId, entry] of pages) {
    entry.host.classList.toggle('hidden', pageId !== id);
  }
  const entry = pages.get(id);
  try {
    entry?.page?.onShow?.();
  } catch (err) {
    console.error('[app] onShow 失败', err);
    toastError(err, '页面刷新失败');
  }
}

/* ============================================================
 * 启动
 * ============================================================ */
async function loadOptions() {
  try {
    const options = await api.options();
    patchRuntime({ options });
    applyOptionDefaults(options);
    return options;
  } catch (err) {
    patchRuntime({ options: null });
    console.warn('[app] /api/options 加载失败', err);
    toastWarn(`读取 /api/options 失败：${err.message}。部分参数将使用内置默认值。`);
    return null;
  }
}

async function loadStylesCatalog() {
  try {
    const styles = await api.styles();
    patchRuntime({ styles, stylesError: null });
  } catch (err) {
    patchRuntime({ styles: null, stylesError: err.message });
    console.warn('[app] /api/styles 加载失败', err);
  }
}

export async function boot() {
  renderSidebar();
  renderTopbar();
  startHealthLoop();

  document.getElementById('sidebar-backdrop').addEventListener('click', () => setMobileNav(false));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) setMobileNav(false);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMobileNav(false);
  });

  // 先拿参数表再挂页面，避免首屏控件空白
  await loadOptions();
  loadStylesCatalog();
  route();
  window.addEventListener('hashchange', route);

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[app] 未处理的 Promise 异常', event.reason);
  });
}
