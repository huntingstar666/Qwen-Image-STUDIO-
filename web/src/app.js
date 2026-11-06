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

const TABS = [
  { id: 't2i', label: '文生图', sub: 'TEXT → IMAGE', factory: createT2IPage },
  { id: 'edit', label: '图像编辑', sub: 'IMAGE + MASK', factory: createEditPage },
  { id: 'tools', label: '图像处理', sub: 'CROP · COLOR · OUTPAINT', factory: createImageToolsPage },
  { id: 'history', label: '历史', sub: 'GALLERY', factory: createHistoryPage },
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
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">Q</div>
      <div>
        <h1 class="brand-title">Qwen-Image 2.1 工作台</h1>
        <p class="brand-sub">本地推理 · 零偏移 · 零色差</p>
      </div>
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
        <button class="status-action" type="button" data-ref="freeVram" title="POST /api/engine/free（unload=true）：释放显存并卸载模型">释放显存</button>
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
      <span class="topbar-note" data-ref="idleHint"></span>
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
 * 页签与路由
 * ============================================================ */
function renderTabs() {
  const host = document.getElementById('tabbar');
  host.innerHTML = TABS.map(
    (tab) => `
      <button class="tab" type="button" data-tab="${tab.id}" role="tab">
        <span class="tab-label">${tab.label}</span>
        <span class="tab-sub">${tab.sub}</span>
      </button>`,
  ).join('');
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    const id = button.dataset.tab;
    if (location.hash === `#${id}`) route();
    else location.hash = id;
  });
}

function currentTabId() {
  const id = String(location.hash || '').replace(/^#/, '');
  return TABS.some((tab) => tab.id === id) ? id : 't2i';
}

function route() {
  const id = currentTabId();
  patchRuntime({ activeTab: id });
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
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
  renderTopbar();
  renderTabs();
  startHealthLoop();

  // 先拿参数表再挂页面，避免首屏控件空白
  await loadOptions();
  loadStylesCatalog();
  route();
  window.addEventListener('hashchange', route);

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[app] 未处理的 Promise 异常', event.reason);
  });
}
