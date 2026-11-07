/**
 * 全局设置浮层（Apple 设置页风格）。
 * 分类：外观 / 模型目录 / AI 模型 / 运行与显存 / 关于。
 * 外观项即时生效并写入 localStorage；模型、LLM、运行项由底部「保存更改」提交到 /api/settings。
 */

import { api } from '../api.js';
import { setAccent, setFont, setLanguage, setTheme, store } from '../store.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';

const SECTIONS = [
  { id: 'appearance', icon: 'palette', label: () => t('settings.nav.appearance') },
  { id: 'models', icon: 'folder', label: () => t('settings.nav.models') },
  { id: 'llm', icon: 'spark', label: () => t('settings.nav.llm') },
  { id: 'runtime', icon: 'gauge', label: () => t('settings.nav.runtime') },
  { id: 'about', icon: 'info', label: () => t('settings.nav.about') },
];

const ICONS = {
  palette:
    '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="8" r="1.3"/><circle cx="8.3" cy="12" r="1.3"/><circle cx="15.7" cy="12" r="1.3"/><circle cx="12" cy="16" r="1.3"/>',
  folder:
    '<path d="M3.5 7.5a1.5 1.5 0 011.5-1.5h4l2 2h7a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013.5 17.5z"/>',
  spark:
    '<path d="M12 4l1.6 4.1 4.1 1.6-4.1 1.6L12 15.4l-1.6-4.1-4.1-1.6 4.1-1.6z"/><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  gauge:
    '<path d="M4.5 17a8 8 0 1115 0"/><path d="M12 13l3.2-3.6"/><circle cx="12" cy="14" r="1.4"/>',
  info: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5.2M12 7.9v.2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
};

function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

let overlay = null;
let refs = null;
let state = null;

const THEME_OPTIONS = [
  { value: 'light', label: () => t('theme.light') },
  { value: 'dark', label: () => t('theme.dark') },
  { value: 'system', label: () => t('theme.system') },
];
const LANG_OPTIONS = [
  { value: 'zh', label: () => t('lang.zh') },
  { value: 'en', label: () => t('lang.en') },
];
const FONT_OPTIONS = [
  { value: 'system', label: () => t('font.system') },
  { value: 'sans', label: () => t('font.sans') },
  { value: 'serif', label: () => t('font.serif') },
  { value: 'mono', label: () => t('font.mono') },
];
const ACCENT_OPTIONS = [
  { value: 'teal', label: () => t('accent.teal') },
  { value: 'ochre', label: () => t('accent.ochre') },
  { value: 'indigo', label: () => t('accent.indigo') },
  { value: 'violet', label: () => t('accent.violet') },
];

/* ============================================================
 * 状态
 * ============================================================ */

function emptyForm() {
  return {
    model: {
      comfy_root: '',
      model_root: '',
      extra_model_roots: '',
      extra_model_paths_yaml: '',
      model_dirs: { unet: '', clip: '', vae: '', lora: '' },
    },
    llm: { ollama_url: '', ollama_model: '' },
    runtime: {
      keep_text_encoder_resident: true,
      idle_unload_minutes: 0,
      vram_reserve: 0,
    },
  };
}

function formFromData(data) {
  const model = data?.model || {};
  const dirs = model.model_dirs || {};
  const joinDirs = (kind) => (Array.isArray(dirs[kind]) ? dirs[kind].join(', ') : '');
  return {
    model: {
      comfy_root: model.comfy_root || '',
      model_root: model.model_root || '',
      extra_model_roots: (model.extra_model_roots || []).join('\n'),
      extra_model_paths_yaml: model.extra_model_paths_yaml || '',
      model_dirs: {
        unet: joinDirs('unet'),
        clip: joinDirs('clip'),
        vae: joinDirs('vae'),
        lora: joinDirs('lora'),
      },
    },
    llm: {
      ollama_url: data?.llm?.ollama_url || '',
      ollama_model: data?.llm?.ollama_model || '',
    },
    runtime: {
      keep_text_encoder_resident: data?.runtime?.keep_text_encoder_resident !== false,
      idle_unload_minutes: Number(data?.runtime?.idle_unload_minutes) || 0,
      vram_reserve: Number(data?.runtime?.vram_reserve) || 0,
    },
  };
}

function ensureState() {
  if (!state) {
    state = {
      section: 'appearance',
      data: null,
      form: emptyForm(),
      dirty: false,
      loading: false,
      saving: false,
      error: '',
      testResult: null,
      testing: false,
    };
  }
  return state;
}

/* ============================================================
 * DOM 骨架
 * ============================================================ */

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="settings-panel" role="document">
      <header class="settings-head">
        <div class="settings-head-text">
          <span class="settings-eyebrow">Qwen-Image 2.1</span>
          <h2 class="settings-title">${t('settings.title')}</h2>
          <p class="settings-sub">${t('settings.subtitle')}</p>
        </div>
        <button class="settings-close" type="button" data-action="close" aria-label="${t('settings.close')}">
          ${icon('close', 15)}
        </button>
      </header>
      <div class="settings-main">
        <nav class="settings-nav" data-ref="nav" aria-label="${t('settings.title')}"></nav>
        <section class="settings-content" data-ref="content"></section>
      </div>
      <footer class="settings-foot">
        <span class="settings-foot-status" data-ref="status"></span>
        <div class="settings-foot-actions">
          <button class="set-btn ghost" type="button" data-action="reload">${t('settings.reload')}</button>
          <button class="set-btn primary" type="button" data-action="save">${t('settings.save')}</button>
        </div>
      </footer>
    </div>`;

  refs = {
    panel: overlay.querySelector('.settings-panel'),
    nav: overlay.querySelector('[data-ref="nav"]'),
    content: overlay.querySelector('[data-ref="content"]'),
    status: overlay.querySelector('[data-ref="status"]'),
    reload: overlay.querySelector('[data-action="reload"]'),
    save: overlay.querySelector('[data-action="save"]'),
    title: overlay.querySelector('.settings-title'),
    sub: overlay.querySelector('.settings-sub'),
    close: overlay.querySelector('.settings-close'),
  };

  document.body.appendChild(overlay);
  bindEvents();
}

function bindEvents() {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      attemptClose();
      return;
    }
    const navButton = event.target.closest('[data-section]');
    if (navButton) {
      state.section = navButton.dataset.section;
      render();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (action) handleAction(action.dataset.action);
  });

  overlay.addEventListener('input', (event) => {
    const field = event.target.closest('[data-field]');
    if (!field) return;
    writeField(field.dataset.field, field.type === 'checkbox' ? field.checked : field.value);
    markDirty();
  });

  overlay.addEventListener('change', (event) => {
    const field = event.target.closest('[data-field]');
    if (!field) return;
    writeField(field.dataset.field, field.type === 'checkbox' ? field.checked : field.value);
    markDirty();
    if (field.dataset.field === 'llm.ollama_url') state.testResult = null;
    if (field.dataset.field.startsWith('runtime.')) render();
  });

  document.addEventListener('keydown', onKeydown);
}

function onKeydown(event) {
  if (!overlay || !document.body.contains(overlay)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    attemptClose();
  }
}

/* ============================================================
 * 字段读写
 * ============================================================ */

function writeField(path, value) {
  const [group, key, sub] = path.split('.');
  if (!state.form[group]) return;
  if (sub) state.form[group][key] = { ...state.form[group][key], [sub]: value };
  else state.form[group][key] = value;
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  renderFooter();
}

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitComma(text) {
  return String(text || '')
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/* ============================================================
 * 渲染
 * ============================================================ */

function renderNav() {
  refs.nav.innerHTML = SECTIONS.map(
    (section) => `
      <button class="settings-nav-item ${state.section === section.id ? 'active' : ''}"
        type="button" data-section="${section.id}">
        ${icon(section.icon)}
        <span>${escapeHtml(section.label())}</span>
      </button>`,
  ).join('');
}

function renderFooter() {
  if (state.loading) {
    refs.status.textContent = t('settings.loading');
    refs.save.disabled = true;
    return;
  }
  if (state.error) {
    refs.status.textContent = state.error;
    refs.status.classList.add('bad');
  } else {
    refs.status.textContent = state.dirty ? t('settings.unsaved') : t('settings.saved');
    refs.status.classList.toggle('dirty', state.dirty);
    refs.status.classList.remove('bad');
  }
  refs.save.disabled = state.saving || !state.dirty;
  refs.save.textContent = state.saving ? t('settings.saving') : t('settings.save');
  if (refs.reload) refs.reload.textContent = t('settings.reload');
}

function row(label, desc, control, extraClass = '') {
  return `
    <div class="set-row ${extraClass}">
      <div class="set-row-text">
        <span class="set-label">${label}</span>
        ${desc ? `<span class="set-desc">${desc}</span>` : ''}
      </div>
      <div class="set-control">${control}</div>
    </div>`;
}

function group(title, rows, note = '') {
  return `
    <section class="set-group">
      <h3 class="set-group-title">${title}</h3>
      <div class="set-card">${rows}</div>
      ${note ? `<p class="set-note">${note}</p>` : ''}
    </section>`;
}

function segmented(options, active, attr) {
  return `
    <div class="set-seg" role="group">
      ${options
        .map(
          (option) => `
          <button class="set-seg-item ${option.value === active ? 'active' : ''}" type="button"
            data-${attr}="${option.value}">${escapeHtml(option.label())}</button>`,
        )
        .join('')}
    </div>`;
}

function textInput(field, value, { placeholder = '', mono = true, type = 'text' } = {}) {
  return `<input class="set-input ${mono ? 'mono' : ''}" type="${type}" data-field="${field}"
    value="${escapeHtml(String(value ?? ''))}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" />`;
}

function renderAppearance() {
  const theme = store.state.theme || 'system';
  const language = store.state.language || 'zh';
  const font = store.state.font || 'system';
  const accent = store.state.accent || 'teal';

  const themeRow = row(
    t('appearance.theme'),
    t('appearance.themeDesc'),
    segmented(THEME_OPTIONS, theme, 'theme-mode'),
  );
  const langRow = row(
    t('appearance.language'),
    t('appearance.languageDesc'),
    segmented(LANG_OPTIONS, language, 'language-mode'),
  );
  const fontRow = row(
    t('appearance.font'),
    t('appearance.fontDesc'),
    segmented(FONT_OPTIONS, font, 'font-mode'),
  );
  const accentRow = row(
    t('appearance.accent'),
    t('appearance.accentDesc'),
    `<div class="set-swatches">${ACCENT_OPTIONS.map(
      (option) => `
        <button class="set-swatch ${option.value === accent ? 'active' : ''}" type="button"
          data-accent-mode="${option.value}" title="${escapeHtml(option.label())}"
          aria-label="${escapeHtml(option.label())}">
          <span class="set-swatch-dot" data-swatch="${option.value}"></span>
          <span class="set-swatch-label">${escapeHtml(option.label())}</span>
        </button>`,
    ).join('')}</div>`,
  );

  return `
    ${group(t('appearance.title'), themeRow + langRow + fontRow + accentRow, t('appearance.instant'))}
  `;
}

function renderScan(scan) {
  if (!scan) return `<p class="set-note">${t('models.scanning')}</p>`;
  const counts = scan.counts || {};
  const rows = [
    ['unet', t('models.unet')],
    ['clip', t('models.clip')],
    ['vae', t('models.vae')],
    ['lora', t('models.lora')],
  ]
    .map(
      ([kind, label]) => `
      <div class="scan-row">
        <span class="scan-label">${label}</span>
        <span class="scan-count ${counts[kind] ? '' : 'empty'}">${t('models.counts', { n: counts[kind] || 0 })}</span>
      </div>`,
    )
    .join('');

  const yaml = scan.yaml || {};
  const yamlText = yaml.path
    ? `<span class="set-chip ok">${t('models.yamlFound')}</span>
       <span class="set-mono-note">${escapeHtml(yaml.path)}</span>`
    : `<span class="set-chip warn">${t('models.yamlMissing')}</span>
       <span class="set-mono-note">${t('models.yamlMissingHint')}</span>`;

  const missingDirs = Object.entries(scan.missing_dirs || {})
    .filter(([, dirs]) => dirs.length)
    .map(([kind, dirs]) => `${kind}: ${dirs.join(' · ')}`);
  const missingDefaults = (scan.missing_defaults || []).join(', ');

  const dirsList = Object.entries(scan.dirs || {})
    .map(
      ([kind, dirs]) => `
      <div class="scan-dir-row">
        <span class="scan-dir-kind">${escapeHtml(kind)}</span>
        <span class="scan-dir-paths mono">${dirs.map((dir) => escapeHtml(dir)).join('<br/>')}</span>
      </div>`,
    )
    .join('');

  return `
    <div class="scan-summary">
      <div class="scan-total">
        <strong>${t('models.total', { n: scan.total || 0 })}</strong>
        <button class="set-mini-btn" type="button" data-action="rescan">${t('models.rescan')}</button>
      </div>
      <div class="scan-grid">${rows}</div>
      <div class="scan-yaml">${yamlText}</div>
      ${
        missingDefaults
          ? `<p class="scan-warn">${t('models.defaultsMissing')}：${escapeHtml(missingDefaults)}</p>`
          : ''
      }
      ${
        missingDirs.length
          ? `<details class="set-details"><summary>${t('models.missingDirs')}</summary>
             <div class="scan-dir-row mono">${missingDirs.map(escapeHtml).join('<br/>')}</div></details>`
          : ''
      }
      <details class="set-details"><summary>${t('models.scan')}</summary>${dirsList}</details>
    </div>`;
}

function renderModels() {
  const form = state.form.model;
  const dirFields = [
    ['unet', t('models.unet')],
    ['clip', t('models.clip')],
    ['vae', t('models.vae')],
    ['lora', t('models.lora')],
  ]
    .map(([kind, label]) =>
      row(
        label,
        '',
        textInput(`model.model_dirs.${kind}`, form.model_dirs[kind], {
          placeholder: kind === 'lora' ? 'loras' : 'diffusion_models, unet',
        }),
      ),
    )
    .join('');

  const rootsCard =
    row(t('models.comfyRoot'), t('models.comfyRootDesc'), textInput('model.comfy_root', form.comfy_root, { placeholder: 'D:\\ComfyUI' })) +
    row(t('models.modelRoot'), t('models.modelRootDesc'), textInput('model.model_root', form.model_root, { placeholder: 'D:\\ComfyUI\\models' })) +
    row(
      t('models.extraRoots'),
      t('models.extraRootsDesc'),
      `<textarea class="set-input set-textarea mono" data-field="model.extra_model_roots"
        rows="3" placeholder="/data/comfy-models">${escapeHtml(form.extra_model_roots)}</textarea>`,
    ) +
    row(
      t('models.yaml'),
      t('models.yamlDesc'),
      textInput('model.extra_model_paths_yaml', form.extra_model_paths_yaml, {
        placeholder: t('models.yamlAuto'),
      }),
    );

  return `
    ${group(t('models.title'), rootsCard, t('models.desc'))}
    ${group(
      t('models.dirs'),
      `<details class="set-details" ${state.dirDetailsOpen ? 'open' : ''}>
         <summary>${t('models.dirsDesc')}</summary>
         <div class="set-card inset">${dirFields}</div>
       </details>`,
    )}
    ${group(t('models.scan'), renderScan(state.data?.scan))}
  `;
}

function renderLlm() {
  const form = state.form.llm;
  const models = state.data?.llm?.models || [];
  const options = [...models];
  if (form.ollama_model && !options.includes(form.ollama_model)) options.unshift(form.ollama_model);
  const modelSelect = `
    <select class="set-input set-select mono" data-field="llm.ollama_model">
      ${options.length ? '' : `<option value="">${t('llm.noModels')}</option>`}
      ${options
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}" ${name === form.ollama_model ? 'selected' : ''}>${escapeHtml(name)}</option>`,
        )
        .join('')}
    </select>`;

  const test = state.testResult;
  const testText = state.testing
    ? t('llm.testing')
    : test
      ? test.ok
        ? t('llm.ok', { n: test.models?.length || 0, ms: test.latency_ms ?? 0 })
        : `${t('llm.fail')}：${test.error || ''}`
      : state.data?.llm?.connected
        ? t('llm.connected')
        : t('llm.offline');

  return `
    ${group(
      t('llm.title'),
      row(t('llm.url'), t('llm.urlDesc'), textInput('llm.ollama_url', form.ollama_url, { placeholder: 'http://127.0.0.1:11434' })) +
        row(t('llm.model'), t('llm.modelDesc'), modelSelect),
      t('llm.desc'),
    )}
    ${group(
      t('llm.test'),
      `<div class="llm-test-row">
         <span class="llm-status ${test && !test.ok ? 'bad' : state.data?.llm?.connected ? 'ok' : ''}">${escapeHtml(testText)}</span>
         <button class="set-mini-btn" type="button" data-action="test-ollama"
           ${state.testing ? 'disabled' : ''}>${state.testing ? t('llm.testing') : t('llm.test')}</button>
       </div>`,
    )}`;
}

function renderRuntime() {
  const form = state.form.runtime;
  return `
    ${group(
      t('runtime.title'),
      row(
        t('runtime.resident'),
        t('runtime.residentDesc'),
        `<label class="set-switch">
           <input type="checkbox" data-field="runtime.keep_text_encoder_resident"
             ${form.keep_text_encoder_resident ? 'checked' : ''} />
           <span class="set-switch-track"></span>
         </label>`,
      ) +
        row(
          t('runtime.idle'),
          t('runtime.idleDesc'),
          `<div class="set-inline">
             ${textInput('runtime.idle_unload_minutes', form.idle_unload_minutes, { type: 'number' })}
             <span class="set-unit">${t('runtime.minutes')}</span>
           </div>`,
        ) +
        row(
          t('runtime.reserve'),
          t('runtime.reserveDesc'),
          `<div class="set-inline">
             ${textInput('runtime.vram_reserve', form.vram_reserve, { type: 'number' })}
             <span class="set-unit">${t('runtime.reserveUnit')}</span>
           </div>`,
        ) +
        row(
          t('runtime.free'),
          t('runtime.freeDesc'),
          `<button class="set-mini-btn danger" type="button" data-action="free-vram">${t('runtime.free')}</button>`,
        ),
      t('runtime.desc'),
    )}`;
}

function renderAbout() {
  const app = state.data?.app || {};
  const storage = app.storage || {};
  const usedMb = Number(storage.size_mb) || 0;
  const used = usedMb >= 1024 ? `${(usedMb / 1024).toFixed(1)} GB` : `${usedMb.toFixed(0)} MB`;
  const free = `${(Number(storage.free_gb) || 0).toFixed(1)} GB`;
  const rows = [
    [t('about.version'), `<span class="set-value mono">${escapeHtml(app.version || '—')}</span>`],
    [t('about.modelRoot'), `<span class="set-value mono">${escapeHtml(state.data?.model?.model_root || '—')}</span>`],
    [t('about.engine'), `<span class="set-value mono">${escapeHtml(app.engine_dir || '—')}</span>`],
    [t('about.outputs'), `<span class="set-value">${t('about.outputsValue', { n: app.outputs ?? 0 })}</span>`],
    [t('about.storage'), `<span class="set-value">${t('about.storageValue', { used, free })}</span>`],
  ]
    .map(([label, control]) => row(label, '', control))
    .join('');
  return group(t('about.title'), rows);
}

const RENDERERS = {
  appearance: renderAppearance,
  models: renderModels,
  llm: renderLlm,
  runtime: renderRuntime,
  about: renderAbout,
};

function render() {
  if (!refs) return;
  const section = SECTIONS.find((item) => item.id === state.section) || SECTIONS[0];
  if (state.loading) {
    renderNav();
    refs.content.innerHTML = `<div class="set-loading">${t('settings.loading')}</div>`;
    refs.title.textContent = t('settings.title');
    refs.sub.textContent = t('settings.subtitle');
    refs.close.setAttribute('aria-label', t('settings.close'));
    renderFooter();
    return;
  }
  if (state.error) {
    renderNav();
    refs.content.innerHTML = `<div class="set-empty">${escapeHtml(state.error)}</div>`;
    renderFooter();
    return;
  }
  renderNav();
  refs.title.textContent = `${t('settings.title')} · ${section.label()}`;
  refs.sub.textContent = t('settings.subtitle');
  refs.close.setAttribute('aria-label', t('settings.close'));
  refs.content.innerHTML = RENDERERS[section.id]();
  renderFooter();
}

/* ============================================================
 * 行为
 * ============================================================ */

async function load() {
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await api.getSettings();
    state.data = data;
    state.form = formFromData(data);
    state.dirty = false;
    state.testResult = null;
  } catch (err) {
    state.error = t('settings.loadFailed', { msg: err?.message || err });
  } finally {
    state.loading = false;
    render();
  }
}

function buildPayload() {
  return {
    comfy_root: state.form.model.comfy_root.trim(),
    model_root: state.form.model.model_root.trim(),
    extra_model_roots: splitLines(state.form.model.extra_model_roots),
    extra_model_paths_yaml: state.form.model.extra_model_paths_yaml.trim(),
    model_dirs: {
      unet: splitComma(state.form.model.model_dirs.unet),
      clip: splitComma(state.form.model.model_dirs.clip),
      vae: splitComma(state.form.model.model_dirs.vae),
      lora: splitComma(state.form.model.model_dirs.lora),
    },
    ollama_url: state.form.llm.ollama_url.trim(),
    ollama_model: state.form.llm.ollama_model,
    keep_text_encoder_resident: Boolean(state.form.runtime.keep_text_encoder_resident),
    idle_unload_minutes: Number(state.form.runtime.idle_unload_minutes) || 0,
    vram_reserve: Number(state.form.runtime.vram_reserve) || 0,
  };
}

async function save() {
  if (state.saving) return;
  const idle = Number(state.form.runtime.idle_unload_minutes);
  if (!Number.isFinite(idle) || idle < 0) {
    toastWarn('空闲卸载时间不能为负数');
    return;
  }
  const payload = buildPayload();
  const before = state.data?.model || {};
  const modelChanged =
    JSON.stringify({
      comfy_root: payload.comfy_root,
      model_root: payload.model_root,
      yaml: payload.extra_model_paths_yaml,
      extra: payload.extra_model_roots,
      dirs: payload.model_dirs,
    }) !==
    JSON.stringify({
      comfy_root: before.comfy_root || '',
      model_root: before.model_root || '',
      yaml: before.extra_model_paths_yaml || '',
      extra: before.extra_model_roots || [],
      dirs: before.model_dirs || {},
    });

  state.saving = true;
  state.error = '';
  renderFooter();
  try {
    const result = await api.updateSettings(payload);
    state.data = result;
    state.form = formFromData(result);
    state.dirty = false;
    state.testResult = null;
    toastSuccess(t('settings.savedToast'));
    render();
    // 模型目录变了：通知壳层刷新参数并重建页面
    window.dispatchEvent(
      new CustomEvent('settings:saved', { detail: { ...result, modelChanged } }),
    );
  } catch (err) {
    state.error = t('settings.saveFailed', { msg: err?.message || err });
    renderFooter();
    toastError(err, '保存设置失败');
  } finally {
    state.saving = false;
    renderFooter();
  }
}

async function rescan() {
  try {
    const scan = await api.scanModels();
    if (state.data) state.data.scan = scan;
    render();
    toastSuccess(`已重新扫描：${scan.total} 个模型文件`);
  } catch (err) {
    toastError(err, '扫描模型目录失败');
  }
}

async function testOllama() {
  if (state.testing) return;
  state.testing = true;
  state.testResult = null;
  render();
  try {
    const result = await api.testOllama({ url: state.form.llm.ollama_url.trim() });
    state.testResult = result;
    if (result.ok && state.data?.llm) {
      state.data.llm.models = result.models || [];
      state.data.llm.connected = Boolean(result.connected);
    }
  } catch (err) {
    state.testResult = { ok: false, error: err?.message || String(err) };
  } finally {
    state.testing = false;
    render();
  }
}

async function freeVram() {
  try {
    await api.engineFree({ unload: true });
    toastSuccess(t('runtime.freeDone'));
  } catch (err) {
    toastError(err, '释放显存失败');
  }
}

function handleAction(action) {
  switch (action) {
    case 'close':
      attemptClose();
      break;
    case 'save':
      save();
      break;
    case 'reload':
      if (state.dirty && !window.confirm('有未保存的修改，重新加载将丢弃它们。继续？')) return;
      state.dirty = false;
      load();
      break;
    case 'rescan':
      rescan();
      break;
    case 'test-ollama':
      testOllama();
      break;
    case 'free-vram':
      freeVram();
      break;
    default:
      break;
  }
}

function applyAppearanceChoice(attr, value) {
  if (attr === 'theme-mode') {
    setTheme(value);
  } else if (attr === 'language-mode') {
    setLanguage(value);
  } else if (attr === 'font-mode') {
    setFont(value);
  } else if (attr === 'accent-mode') {
    setAccent(value);
  }
  render();
}

function onAppearanceClick(event) {
  const target = event.target.closest(
    '[data-theme-mode],[data-language-mode],[data-font-mode],[data-accent-mode]',
  );
  if (!target) return;
  event.preventDefault();
  if (target.dataset.themeMode) applyAppearanceChoice('theme-mode', target.dataset.themeMode);
  else if (target.dataset.languageMode) applyAppearanceChoice('language-mode', target.dataset.languageMode);
  else if (target.dataset.fontMode) applyAppearanceChoice('font-mode', target.dataset.fontMode);
  else if (target.dataset.accentMode) applyAppearanceChoice('accent-mode', target.dataset.accentMode);
}

/* ============================================================
 * 打开 / 关闭
 * ============================================================ */

function attemptClose() {
  if (state?.dirty && !window.confirm('有未保存的修改，确定关闭设置？')) return;
  close();
}

function close() {
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.classList.remove('settings-open');
  document.removeEventListener('keydown', onKeydown);
  window.setTimeout(() => {
    overlay?.remove();
    overlay = null;
    refs = null;
    state = null;
  }, 180);
}

export function openSettings(section = 'appearance') {
  const next = ensureState();
  if (!overlay) {
    buildOverlay();
    overlay.addEventListener('click', onAppearanceClick, true);
    document.body.classList.add('settings-open');
    // 触发进入动画
    requestAnimationFrame(() => overlay?.classList.add('open'));
    refs.close.focus({ preventScroll: true });
  }
  if (SECTIONS.some((item) => item.id === section)) next.section = section;
  if (!next.data && !next.loading) load();
  else render();
}
