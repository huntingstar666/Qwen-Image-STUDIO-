/** 定格工坊应用外壳：侧边栏、顶栏、路由、健康状态。 */
import { api } from './api.js';
import {
  $, $$, h, escapeHtml, icon, toast, openModal, applyTheme, initialTheme,
} from './ui.js';
import { PhotosView } from './views/photos.js';
import { PipelineView } from './views/pipeline.js';
import { ChainView } from './views/chain.js';
import { LibraryView } from './views/library.js';
import { ProjectsView } from './views/projects.js';

const ROUTES = {
  photos: {
    group: '创作', label: '定格工坊', code: 'STOP MOTION', icon: 'film',
    sub: '照片轨道 · 定格动画', View: PhotosView,
  },
  pipeline: {
    group: '创作', label: '自动化流水线', code: 'PIPELINE', icon: 'spark', badge: '实验',
    sub: '宫格切分 · 逐格精修', View: PipelineView,
  },
  chain: {
    group: '创作', label: '连续编辑', code: 'STILL LOOP', icon: 'chain',
    sub: '接力生成 · 逐帧自检', View: ChainView,
  },
  library: {
    group: '资产', label: '素材仓库', code: 'LIBRARY', icon: 'archive',
    sub: '主项目收藏与上传素材', View: LibraryView,
  },
  projects: {
    group: '资产', label: '我的项目', code: 'PROJECTS', icon: 'clock',
    sub: '全部轨道与运行记录', View: ProjectsView,
  },
};

const GROUPS = [
  { id: 'create', label: '创作', routes: ['photos', 'pipeline', 'chain'] },
  { id: 'assets', label: '资产', routes: ['library', 'projects'] },
];

const FALLBACK_OPTIONS = {
  canvas: [
    { id: '1:1s', label: '1:1 轻量 512', width: 512, height: 512 },
    { id: '1:1', label: '1:1 标准 768', width: 768, height: 768 },
    { id: '4:3', label: '4:3 横 896×672', width: 896, height: 672 },
    { id: '16:9', label: '16:9 宽 1024×576', width: 1024, height: 576 },
    { id: '9:16', label: '9:16 竖 576×1024', width: 576, height: 1024 },
  ],
  editModels: [{ id: 'qwen', label: 'Qwen-Image' }],
  presets: [],
  styles: [
    { id: '', label: '不限定（沿用提示词）' },
    { id: 'clay', label: '黏土' },
    { id: 'paper', label: '纸偶' },
    { id: 'felt', label: '毛毡' },
    { id: 'lego', label: '积木' },
  ],
  engines: [
    { id: 'mock', name: '模拟出图（演示）' },
    { id: 'main', name: '主项目真实生成（需 8700）' },
  ],  exportFormats: ['gif', 'apng', 'webp', 'mp4', 'webm'],
  video: { available: false, formats: ['mp4', 'webm'] },
  relay: [
    { id: 'chain', label: '连续接力' },
    { id: 'independent', label: '独立出图' },
  ],
  background: [
    { id: 'auto', label: '自动' },
    { id: 'plain', label: '整幅重绘' },
    { id: 'fixed', label: '固定背景' },
  ],
  defaults: {
    frames: 12, size: 768, width: 768, height: 768, fps: 12, max_retries: 3,
    steps: 8, cfg: 1.0, denoise: 1.0, turbo: true, consistency: true,
    relay: 'chain', background: 'auto', style: '', model: 'qwen', preset: '',
    motion: { preset: 'both', fps: 8, hold: 2, jitter: 1.2, grain: 0.06, vignette: 0.18, color_boil: 0.03 },
    export: { format: 'gif', dither: true, align: false, color_match: false },
    timeline: { fps: 12, hold: 2 },
  },
};

/* ---------------------------------------------------------------- 本地状态 */

const STORE_KEY = 'stillloop.workspace.v1';

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

const store = {
  data: loadStore(),
  persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch { /* 忽略 */ }
  },
  get(route) {
    return (this.data.ids && this.data.ids[route]) || '';
  },
  set(route, id) {
    this.data.ids = this.data.ids || {};
    this.data.ids[route] = id;
    this.persist();
  },
  clear(route) {
    if (this.data.ids) {
      delete this.data.ids[route];
      this.persist();
    }
  },
  prefs(key, fallback) {
    const prefs = this.data.prefs || {};
    return key in prefs ? prefs[key] : fallback;
  },
  setPrefs(key, value) {
    this.data.prefs = this.data.prefs || {};
    this.data.prefs[key] = value;
    this.persist();
  },
};

/* ---------------------------------------------------------------- 上下文 */

const ctx = {
  api,
  options: FALLBACK_OPTIONS,
  health: null,
  store,
  go: (route) => go(route),
  refreshHealth: () => refreshHealth(),
};
let currentView = null;
let activeRoute = 'photos';

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '').trim();
  return ROUTES[hash] ? hash : 'photos';
}

function fallbackHealth() {
  return { ok: false, main: { ok: false }, ollama: { ok: false, models: [] } };
}

/* ---------------------------------------------------------------- 外壳 */

function renderSidebar() {
  const host = $('#sidebar');
  if (!host) return;
  const health = ctx.health || fallbackHealth();
  const mainOk = Boolean(health.main && health.main.ok);
  const llmOk = Boolean(health.ollama && health.ollama.ok);
  const modelCount = ((health.ollama && health.ollama.models) || []).length;
  const theme = localStorage.getItem('stillloop.theme') || 'system';
  host.innerHTML = `
    <div class="sidebar-head">
      <div class="sidebar-brand">
        <span class="brand-mark-lg">定</span>
        <div class="brand-copy">
          <div class="brand-name">定格工坊</div>
          <div class="brand-tag">Still Loop</div>
        </div>
      </div>
    </div>
    <div class="sidebar-scroll">
      ${GROUPS.map((group) => `<div class="nav-group">
        <div class="nav-group-title">${escapeHtml(group.label)}</div>
        ${group.routes.map((id) => {
          const route = ROUTES[id];
          return `<button class="nav-item${activeRoute === id ? ' active' : ''}" type="button" data-route="${id}">
            <span class="nav-icon">${icon(route.icon, 18)}</span>
            <span class="nav-label">${escapeHtml(route.label)}</span>
            ${route.badge ? `<span class="nav-badge">${escapeHtml(route.badge)}</span>` : ''}
          </button>`;
        }).join('')}
      </div>`).join('')}
    </div>
    <div class="sidebar-foot">
      <div class="sidebar-meta">
        <span>${mainOk ? '主项目 8700 在线' : '主项目 8700 离线'}</span>
        <span>${llmOk ? `LLM 在线 · ${modelCount} 个模型` : 'LLM 离线（手写分镜可用）'}</span>
      </div>
      <div class="theme-switch">
        <button class="theme-option${theme === 'system' ? ' active' : ''}" type="button" data-theme-mode="system">${icon('auto', 13)}<span>自动</span></button>
        <button class="theme-option${theme === 'light' ? ' active' : ''}" type="button" data-theme-mode="light">${icon('sun', 13)}<span>亮色</span></button>
        <button class="theme-option${theme === 'dark' ? ' active' : ''}" type="button" data-theme-mode="dark">${icon('moon', 13)}<span>暗色</span></button>
      </div>
    </div>
  `;
  $$('[data-route]', host).forEach((button) => {
    button.addEventListener('click', () => {
      go(button.dataset.route);
      document.getElementById('appShell').classList.remove('is-mobile-open');
    });
  });
  $$('[data-theme-mode]', host).forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.themeMode);
      renderSidebar();
    });
  });
}

function statusChip(ref, label, detail, ok = true, tone = '') {
  return `<div class="status" data-ref="${ref}">
    <span class="dot ${tone || (ok ? 'ok' : 'bad')}"></span>
    <span class="status-label">${escapeHtml(label)}</span>
    <span class="status-detail">${escapeHtml(detail)}</span>
  </div>`;
}

function renderTopbar() {
  const host = $('#topbar');
  if (!host) return;
  const route = ROUTES[activeRoute] || ROUTES.photos;
  const health = ctx.health || fallbackHealth();
  const mainOk = Boolean(health.main && health.main.ok);
  const llmOk = Boolean(health.ollama && health.ollama.ok);
  const models = (health.ollama && health.ollama.models) || [];
  const polishModel = models.find((name) => /qwen/i.test(name)) || models[0] || '';
  const ffmpegOk = Boolean(ctx.options && ctx.options.video && ctx.options.video.available);
  host.innerHTML = `
    <button class="mobile-menu" type="button" id="mobileMenu" aria-label="打开导航">${icon('menu', 18)}</button>
    <div class="topbar-titles">
      <div class="topbar-kicker">
        <span>${escapeHtml(route.group)}</span><span aria-hidden="true">/</span><span>${escapeHtml(route.label)}</span>
      </div>
      <div class="topbar-context">${escapeHtml(route.sub)}</div>
    </div>
    <div class="topbar-status">
      ${statusChip('main', '主项目', mainOk ? '在线' : '离线', mainOk)}
      ${statusChip('llm', 'LLM', llmOk ? (polishModel || '在线') : '离线', llmOk)}
      ${statusChip('ffmpeg', 'FFmpeg', ffmpegOk ? '就绪' : '缺失', ffmpegOk, ffmpegOk ? '' : 'warn')}
      <button class="topbar-icon" type="button" id="helpBtn" title="服务与接入">${icon('info', 15)}</button>
    </div>
  `;
  const menu = host.querySelector('#mobileMenu');
  if (menu) {
    menu.addEventListener('click', () => {
      document.getElementById('appShell').classList.toggle('is-mobile-open');
    });
  }
  const help = host.querySelector('#helpBtn');
  if (help) help.addEventListener('click', openHelp);
  document.title = route.label === '定格工坊'
    ? '定格工坊 · Still Loop'
    : `${route.label} · 定格工坊`;
}

function openHelp() {
  const health = ctx.health || fallbackHealth();
  const mainOk = Boolean(health.main && health.main.ok);
  const body = h('div', { class: 'stack' });
  body.innerHTML = `
    <div class="notice ${mainOk ? 'ok' : 'warn'}">${icon(mainOk ? 'check' : 'alert', 15)}
      <span>主项目 ${mainOk ? '在线' : '离线'}：${escapeHtml((health.main && health.main.base) || 'http://127.0.0.1:8700')}</span></div>
    <div class="field-grid">
      <div class="metric"><span>数据目录</span><b style="font-size:11px">${escapeHtml((health.data) || 'still_loop/_data')}</b></div>
      <div class="metric"><span>FFmpeg</span><b>${ctx.options && ctx.options.video && ctx.options.video.available ? '可用' : '不可用'}</b></div>
    </div>
    <div>
      <strong style="font-size:12.5px">与主项目的接口面</strong>
      <p class="mini" style="margin-top:4px">定格工坊不 import 主项目代码，只通过 HTTP 使用：</p>
      <p class="mini mono" style="margin-top:4px">/api/edit · /api/upload · /api/jobs/{id}<br>/api/materials · /api/options · /api/meta</p>
    </div>
    <div>
      <strong style="font-size:12.5px">嵌入主项目</strong>
      <p class="mini" style="margin-top:4px">在主项目里用 iframe 打开 <span class="mono">http://127.0.0.1:8720/?embed=1</span>，会自动隐藏侧边栏与顶栏装饰，只保留工作区。</p>
    </div>
    <div>
      <strong style="font-size:12.5px">素材仓库</strong>
      <p class="mini" style="margin-top:4px">素材列表来自主项目 /api/materials；导入时由 8720 服务端抓取图片，前端不需要跨域权限。</p>
    </div>
  `;
  openModal({ title: '服务与接入', sub: '定格工坊 · 独立服务 / 8720', body });
}

/* ---------------------------------------------------------------- 路由 */

function mountView() {
  if (currentView && currentView.unmount) currentView.unmount();
  const routeId = parseRoute();
  activeRoute = routeId;
  const route = ROUTES[routeId];
  const viewport = $('#viewport');
  viewport.className = 'viewport';
  currentView = new route.View(ctx);
  currentView.mount(viewport);
  renderSidebar();
  renderTopbar();
}

function go(route) {
  const target = ROUTES[route] ? route : 'photos';
  if (location.hash !== `#/${target}`) {
    location.hash = `#/${target}`;
  } else {
    mountView();
  }
}

/* ---------------------------------------------------------------- 健康状态 */

async function refreshHealth() {
  try {
    ctx.health = await api.health();
  } catch (error) {
    ctx.health = fallbackHealth();
  }
  renderSidebar();
  renderTopbar();
}

/* ---------------------------------------------------------------- 启动 */

function showFatal(error) {
  console.error('[still_loop]', error);
  const viewport = $('#viewport');
  if (!viewport || viewport.querySelector('.page')) return;
  const message = (error && error.message) || String(error || '未知错误');
  viewport.innerHTML = `<div class="page"><div class="panel"><div class="panel-body stack">
    <div class="notice bad">${icon('alert', 15)}<span><strong>页面加载失败</strong>：${escapeHtml(message)}</span></div>
    <p class="mini">按 Ctrl+F5 强制刷新；若仍失败，请把浏览器控制台的报错发给开发者。</p>
  </div></div></div>`;
}

function safeMountView() {
  try {
    mountView();
  } catch (error) {
    showFatal(error);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), ms)),
  ]);
}

window.addEventListener('error', (event) => {
  if (event.error && !document.querySelector('#viewport .page')) showFatal(event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[still_loop] unhandled rejection', event.reason);
  if (!document.querySelector('#viewport .page')) showFatal(event.reason);
});

async function boot() {
  applyTheme(initialTheme());
  if (new URLSearchParams(location.search).get('embed') === '1') {
    document.documentElement.classList.add('is-embed');
  }
  activeRoute = parseRoute();
  renderSidebar();
  renderTopbar();

  // 先用内置默认选项把界面挂出来，避免接口慢/离线时出现空白工作区。
  safeMountView();
  window.addEventListener('hashchange', safeMountView);
  // 健康状态独立刷新，不被 options 的等待拖住。
  void refreshHealth();
  setTimeout(refreshHealth, 2000);
  setInterval(refreshHealth, 5000);

  let hydrated = false;
  try {
    const options = await withTimeout(api.options(), 8000, '读取选项');
    ctx.options = { ...FALLBACK_OPTIONS, ...(options || {}) };
    if (options && options.defaults) {
      ctx.options.defaults = { ...FALLBACK_OPTIONS.defaults, ...options.defaults };
    }
    hydrated = true;
  } catch (error) {
    ctx.options = FALLBACK_OPTIONS;
    toast('读取主项目选项失败，已使用默认参数', 'warn');
  }
  try {
    ctx.health = await withTimeout(api.health(), 5000, '读取健康状态');
  } catch (error) {
    ctx.health = fallbackHealth();
  }
  renderSidebar();
  renderTopbar();

  // 真实的模型/预设到达后重挂一次当前页面，让下拉框拿到主项目选项。
  if (hydrated) safeMountView();
  document.getElementById('sidebarBackdrop').addEventListener('click', () => {
    document.getElementById('appShell').classList.remove('is-mobile-open');
  });
}

boot();
