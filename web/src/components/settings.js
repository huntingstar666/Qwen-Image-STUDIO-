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
  { id: 'defaults', icon: 'spark', label: () => t('settings.nav.defaults') },
  { id: 'upscale', icon: 'image', label: () => t('settings.nav.upscale') },
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
  image:
    '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.4"/><path d="M4.5 17l4.6-4.4 3.2 2.9 2.5-2.2 4.7 4.1"/>',
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
    upscale: {
      dirs: { seedvr2: '', flashvsr: '' },
      seedvr2: { dit: '', vae: '', vae_tiled: true },
      flashvsr: { precision: 'bf16' },
      default_engine: 'seedvr2',
      idle_unload_minutes: 10,
      defaults: { scale: 2 },
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
    upscale: upscaleFormFromData(data?.upscale),
  };
}

function upscaleFormFromData(up = {}) {
  const dirs = up.dirs || {};
  const seedvr2 = up.seedvr2 || {};
  const flashvsr = up.flashvsr || {};
  return {
    dirs: { seedvr2: dirs.seedvr2 || '', flashvsr: dirs.flashvsr || '' },
    seedvr2: {
      dit: seedvr2.dit || '',
      vae: seedvr2.vae || '',
      vae_tiled: seedvr2.vae_tiled !== false,
    },
    flashvsr: { precision: flashvsr.precision || 'bf16' },
    default_engine: up.default_engine || 'seedvr2',
    idle_unload_minutes: Number(up.idle_unload_minutes ?? 10),
    defaults: { scale: Number(up.defaults?.scale) || 2 },
  };
}

/** 默认模型槽位的草稿值（空串 = 跟随出厂）；任务槽位用 `<task>.<slot>` 键。 */
function defaultsFromData(data) {
  const defaults = data?.model_defaults || {};
  const out = {};
  for (const [key, item] of Object.entries(defaults.slots || {})) out[key] = item?.expected || '';
  for (const [task, view] of Object.entries(defaults.tasks || {})) {
    for (const [key, item] of Object.entries(view?.slots || {})) {
      out[`${task}.${key}`] = item?.expected || '';
    }
  }
  return out;
}

function defaultsT2iModel(data) {
  return String(data?.model_defaults?.t2i_model || 'qwen');
}

function ensureState() {
  if (!state) {
    state = {
      section: 'appearance',
      data: null,
      form: emptyForm(),
      slotDraft: null,
      slotSaved: null,
      defaultsTask: 't2i',
      t2iModelDraft: 'qwen',
      t2iModelSaved: 'qwen',
      options: null,
      optionsLoading: false,
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
    if (action) handleAction(action.dataset.action, action);
  });

  overlay.addEventListener('input', (event) => {
    const field = event.target.closest('[data-field]');
    if (!field) return;
    writeField(field.dataset.field, field.type === 'checkbox' ? field.checked : field.value);
    markDirty();
  });

  overlay.addEventListener('change', (event) => {
    const slot = event.target.closest('[data-slot]');
    if (slot) {
      state.slotDraft = { ...state.slotDraft, [slot.dataset.slot]: slot.value };
      markDirty();
      render();
      return;
    }
    const defaultsModel = event.target.closest('[data-defaults-model]');
    if (defaultsModel) {
      state.t2iModelDraft = defaultsModel.value;
      markDirty();
      render();
      return;
    }
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

function slotSelect(slotKey, slot, current) {
  const list = (state.options?.models?.[slot.kind] || []).map((item) => ({
    value: item.value,
    label: item.label || item.value,
  }));
  if (current && !list.some((item) => item.value === current)) {
    list.unshift({ value: current, label: t('defaults.notScanned', { value: current }) });
  }
  const options = list
    .map(
      (item) =>
        `<option value="${escapeHtml(item.value)}" ${item.value === current ? 'selected' : ''}>${escapeHtml(item.label)}</option>`,
    )
    .join('');
  return `
    <select class="set-input set-select mono" data-slot="${slotKey}">
      <option value="" ${current ? '' : 'selected'}>${t('defaults.followFactory')}</option>
      ${options}
    </select>`;
}

function slotChip(slot, pending) {
  if (pending) return `<span class="set-chip">${t('defaults.pending')}</span>`;
  return slot.found
    ? `<span class="set-chip ok">${t('defaults.found')}</span>`
    : `<span class="set-chip warn">${t('defaults.missingSlot')}</span>`;
}

function renderDefaults() {
  const audit = state.data?.model_defaults;
  if (!audit) return `<p class="set-note">${t('defaults.loading')}</p>`;
  const task = state.defaultsTask === 'edit' ? 'edit' : 't2i';
  const view = audit.tasks?.[task] || { slots: {}, matched: audit.matched, missing: audit.missing || [] };
  const slots = view.slots || audit.slots || {};
  const model = task === 't2i' ? (state.t2iModelDraft || 'qwen') : 'qwen';
  const rowsForTask = Object.entries(slots).filter(([key]) =>
    task !== 't2i' || key.startsWith('moss_') === (model === 'moss'));
  const missing = (view.missing || []).map((key) => slots[key]?.label || key);
  const banner = view.matched
    ? `<div class="notice info">${t('defaults.ok')} ${t('defaults.okHint')}</div>`
    : `<div class="notice warn">${t('defaults.missing')} ${t('defaults.missingHint', { slots: missing.join('、') })}</div>`;

  if (!state.options) {
    return `${banner}${group(t('defaults.title'), `<div class="set-row"><span class="set-desc">${t('defaults.loading')}</span></div>`)}`;
  }

  const tabs = `
    <div class="set-tasktabs">
      ${['t2i', 'edit'].map((id) => `<button type="button" class="set-tasktab ${id === task ? 'active' : ''}" data-action="defaults-task" data-task="${id}">${t(`defaults.task.${id}`)}</button>`).join('')}
    </div>`;
  const modelRow = task === 't2i'
    ? row(
        t('defaults.t2iModel'),
        t('defaults.t2iModelDesc'),
        `<select class="set-input set-select" data-defaults-model>
          ${(state.options.model_profiles || []).map((profile) =>
            `<option value="${escapeHtml(profile.id)}" ${profile.id === model ? 'selected' : ''}>${escapeHtml(profile.label || profile.id)}</option>`).join('')}
        </select>${state.t2iModelDraft !== state.t2iModelSaved ? `<span class="set-chip">${t('defaults.pending')}</span>` : ''}`,
      )
    : '';

  const rows = rowsForTask
    .map(([key, slot]) => {
      const compound = `${task}.${key}`;
      const draft = state.slotDraft?.[compound] ?? '';
      const saved = state.slotSaved?.[compound] ?? '';
      const pending = draft !== saved;
      const hint = [
        escapeHtml(slot.value || slot.expected || '—'),
        slot.via ? t(`defaults.via.${slot.via}`) : '',
        slot.source === 'factory' ? t('defaults.follow') : t('defaults.custom'),
        slot.required ? t('defaults.required') : t('defaults.optional'),
      ]
        .filter(Boolean)
        .join(' · ');
      return row(
        `${escapeHtml(slot.label)}${slot.required ? ' *' : ''}`,
        hint,
        `${slotSelect(compound, slot, draft)}${slotChip(slot, pending)}`,
      );
    })
    .join('');

  const actions =
    row(
      t('defaults.resetAll'),
      t('defaults.resetAllDesc'),
      `<button class="set-mini-btn" type="button" data-action="reset-defaults">${t('defaults.resetAll')}</button>`,
    ) +
    row(
      t('defaults.recheck'),
      t('defaults.recheckDesc'),
      `<button class="set-mini-btn" type="button" data-action="recheck-defaults">${t('defaults.recheck')}</button>`,
    );

  return `
    ${tabs}
    ${banner}
    ${group(`${t('defaults.title')} · ${t(`defaults.task.${task}`)}`, `${modelRow}${rows}`, t('defaults.desc'))}
    ${group(t('defaults.actions'), actions, t('defaults.saveHint'))}
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

function renderUpscaleScan() {
  const scan = state.data?.upscale?.scan;
  if (!scan) return `<p class="set-note">${t('upscale.scanning')}</p>`;
  const engines = scan.engines || {};
  const rows = Object.values(engines)
    .map((engine) => {
      const chip = engine.ready
        ? `<span class="set-chip ok">${t('upscale.ready')}</span>`
        : `<span class="set-chip warn">${t('upscale.notReady')}</span>`;
      const missing = (engine.missing || []).length
        ? `<span class="set-mono-note">${t('upscale.missing')}：${escapeHtml((engine.missing || []).join(', '))}</span>`
        : '';
      return `
        <div class="scan-row">
          <span class="scan-label">${escapeHtml(engine.label || engine.id)}</span>
          <span class="scan-count">${chip}</span>
        </div>
        <div class="scan-dir-row">
          <span class="scan-dir-kind">${t('upscale.dir')}</span>
          <span class="scan-dir-paths mono">${escapeHtml(engine.dir || '—')}</span>
        </div>
        ${missing ? `<div class="scan-dir-row">${missing}</div>` : ''}`;
    })
    .join('');
  return `
    <div class="scan-summary">
      <div class="scan-total">
        <strong>${scan.ready ? t('upscale.anyReady') : t('upscale.noneReady')}</strong>
        <button class="set-mini-btn" type="button" data-action="rescan">${t('models.rescan')}</button>
      </div>
      ${rows}
    </div>`;
}

function renderUpscale() {
  const form = state.form.upscale;
  const scan = state.data?.upscale?.scan || {};
  const engines = scan.engines || {};
  const sd = engines.seedvr2 || {};

  const selectInput = (field, value, options, fallback = '') => {
    if (!options.length) return textInput(field, value || fallback, { placeholder: fallback });
    return `<select class="set-input mono" data-field="${field}">
      ${options
        .map(
          (option) =>
            `<option value="${escapeHtml(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`,
        )
        .join('')}
    </select>`;
  };

  const ditOptions = (sd.dits || []).map((file) => ({
    value: file.name,
    label: `${file.name}（${file.size_gb} GB）`,
  }));
  const vaeOptions = (sd.vaes || []).map((file) => ({
    value: file.name,
    label: `${file.name}（${file.size_gb} GB）`,
  }));
  const engineOptions = Object.values(engines).map((engine) => ({
    value: engine.id,
    label: engine.label || engine.id,
  }));

  const dirsCard =
    row(t('upscale.seedvr2Dir'), t('upscale.dirDesc'),
      textInput('upscale.dirs.seedvr2', form.dirs.seedvr2, { placeholder: 'D:\\ComfyUI\\models\\SEEDVR2' })) +
    row(t('upscale.flashvsrDir'), t('upscale.dirDesc'),
      textInput('upscale.dirs.flashvsr', form.dirs.flashvsr, { placeholder: 'D:\\ComfyUI\\models\\FlashVSR-v1.1' }));

  const seedCard =
    row(t('upscale.dit'), t('upscale.ditDesc'),
      selectInput('upscale.seedvr2.dit', form.seedvr2.dit, ditOptions,
        'seedvr2_ema_7b_fp8_e4m3fn.safetensors')) +
    row(t('upscale.vae'), '', selectInput('upscale.seedvr2.vae', form.seedvr2.vae, vaeOptions,
      'ema_vae_fp16.safetensors')) +
    row(t('upscale.vaeTiled'), t('upscale.vaeTiledDesc'),
      `<label class="set-switch">
         <input type="checkbox" data-field="upscale.seedvr2.vae_tiled"
           ${form.seedvr2.vae_tiled ? 'checked' : ''} />
         <span class="set-switch-track"></span>
       </label>`) +
    row(t('upscale.precision'), t('upscale.precisionDesc'),
      selectInput('upscale.flashvsr.precision', form.flashvsr.precision, [
        { value: 'bf16', label: 'bfloat16' },
        { value: 'fp16', label: 'float16' },
      ]));

  const defaultsCard =
    row(t('upscale.engine'), t('upscale.engineDesc'),
      selectInput('upscale.default_engine', form.default_engine, engineOptions)) +
    row(t('upscale.scale'), t('upscale.scaleDesc'),
      selectInput('upscale.defaults.scale', String(form.defaults.scale), [
        { value: '2', label: '2×' },
        { value: '4', label: '4×' },
      ], '2')) +
    row(t('upscale.idle'), t('upscale.idleDesc'),
      `<div class="set-inline">
         ${textInput('upscale.idle_unload_minutes', form.idle_unload_minutes, { type: 'number' })}
         <span class="set-unit">${t('runtime.minutes')}</span>
       </div>`);

  return `
    ${group(t('upscale.dirs'), dirsCard, t('upscale.dirsDesc'))}
    ${group(t('upscale.models'), seedCard)}
    ${group(t('upscale.defaults'), defaultsCard)}
    ${group(t('upscale.scan'), renderUpscaleScan(), t('upscale.scanDesc'))}
  `;
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
  defaults: renderDefaults,
  upscale: renderUpscale,
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
  if (section.id === 'defaults' && !state.options) loadModelOptions();
  refs.title.textContent = `${t('settings.title')} · ${section.label()}`;
  refs.sub.textContent = t('settings.subtitle');
  refs.close.setAttribute('aria-label', t('settings.close'));
  refs.content.innerHTML = RENDERERS[section.id]();
  renderFooter();
}

/* ============================================================
 * 行为
 * ============================================================ */

async function loadModelOptions() {
  if (state.optionsLoading) return;
  state.optionsLoading = true;
  try {
    const data = await api.options();
    state.options = data || {};
  } catch (err) {
    state.options = {};
    toastError(err, '扫描候选模型失败');
  } finally {
    state.optionsLoading = false;
    if (state?.section === 'defaults') render();
  }
}

async function load() {
  state.loading = true;
  state.error = '';
  render();
  try {
    const data = await api.getSettings();
    state.data = data;
    state.form = formFromData(data);
    state.slotDraft = defaultsFromData(data);
    state.slotSaved = { ...state.slotDraft };
    state.t2iModelDraft = defaultsT2iModel(data);
    state.t2iModelSaved = state.t2iModelDraft;
    state.dirty = false;
    state.testResult = null;
  } catch (err) {
    state.error = t('settings.loadFailed', { msg: err?.message || err });
  } finally {
    state.loading = false;
    render();
  }
}

/** 只提交用户改过的槽位；空串 = 清空自定义，回落出厂 / 公共值。 */
function collectSlotPatch() {
  const globalPatch = {};
  const tasks = {};
  for (const [key, value] of Object.entries(state.slotDraft || {})) {
    if ((state.slotSaved?.[key] ?? '') === value) continue;
    if (key.includes('.')) {
      const [task, slot] = key.split('.', 2);
      tasks[task] = tasks[task] || { slots: {} };
      tasks[task].slots[slot] = value;
    } else {
      globalPatch[key] = value;
    }
  }
  if (state.t2iModelDraft !== state.t2iModelSaved) {
    tasks.t2i = tasks.t2i || {};
    tasks.t2i.model = state.t2iModelDraft;
  }
  const patch = {};
  if (Object.keys(globalPatch).length) patch.slots = globalPatch;
  if (Object.keys(tasks).length) patch.tasks = tasks;
  return Object.keys(patch).length ? patch : null;
}

function buildPayload() {
  const payload = {
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
    upscale: {
      dirs: {
        seedvr2: state.form.upscale.dirs.seedvr2.trim(),
        flashvsr: state.form.upscale.dirs.flashvsr.trim(),
      },
      seedvr2: {
        dit: state.form.upscale.seedvr2.dit,
        vae: state.form.upscale.seedvr2.vae,
        vae_tiled: Boolean(state.form.upscale.seedvr2.vae_tiled),
      },
      flashvsr: { precision: state.form.upscale.flashvsr.precision },
      default_engine: state.form.upscale.default_engine,
      idle_unload_minutes: Number(state.form.upscale.idle_unload_minutes) || 0,
      defaults: { scale: Number(state.form.upscale.defaults.scale) || 2 },
    },
  };
  const slots = collectSlotPatch();
  if (slots) payload.model_defaults = slots;
  return payload;
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
    state.slotDraft = defaultsFromData(result);
    state.slotSaved = { ...state.slotDraft };
    state.t2iModelDraft = defaultsT2iModel(result);
    state.t2iModelSaved = state.t2iModelDraft;
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

/** 全部恢复出厂：清空所有自定义槽位（保存后才写盘）。 */
function resetDefaults() {
  if (!state.slotDraft) return;
  let changed = false;
  for (const key of Object.keys(state.slotDraft)) {
    if (state.slotDraft[key] !== '') {
      state.slotDraft[key] = '';
      changed = true;
    }
  }
  if (state.t2iModelDraft !== 'qwen') {
    state.t2iModelDraft = 'qwen';
    changed = true;
  }
  if (!changed) return;
  markDirty();
  render();
}

/** 重新读取设置并重算默认模型匹配结果（丢弃未保存修改）。 */
async function recheckDefaults() {
  if (state.dirty && !window.confirm('有未保存的修改，重新检测将丢弃它们。继续？')) return;
  state.dirty = false;
  await load();
  if (!state.error) toastSuccess(t('defaults.rechecked'));
}

async function rescan() {
  try {
    const scan = await api.scanModels();
    if (state.data) {
      state.data.scan = scan;
      if (scan.upscale && state.data.upscale) state.data.upscale.scan = scan.upscale;
    }
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

function handleAction(action, element = null) {
  switch (action) {
    case 'close':
      attemptClose();
      break;
    case 'save':
      save();
      break;
    case 'defaults-task':
      state.defaultsTask = element?.dataset?.task === 'edit' ? 'edit' : 't2i';
      render();
      break;
    case 'reload':
      if (state.dirty && !window.confirm('有未保存的修改，重新加载将丢弃它们。继续？')) return;
      state.dirty = false;
      load();
      break;
    case 'rescan':
      rescan();
      break;
    case 'reset-defaults':
      resetDefaults();
      break;
    case 'recheck-defaults':
      recheckDefaults();
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

/* ============================================================
 * 首次使用向导：目录 → 自动匹配 → 确认默认
 * ============================================================ */

const WIZARD_KEY = 'qwen:model-wizard';

let wizard = null;

function wizardDirs(data) {
  const model = data?.model || {};
  return {
    model_root: model.model_root || '',
    extra: Array.isArray(model.extra_model_roots) ? model.extra_model_roots.join(', ') : '',
  };
}

function markWizardSeen(value) {
  try {
    localStorage.setItem(WIZARD_KEY, value);
  } catch {
    // 隐私模式下写不进去也不影响本次使用
  }
}

/** 首次启动：默认方案没匹配上才弹向导，且只提醒一次。 */
export async function maybeOpenModelWizard() {
  try {
    if (localStorage.getItem(WIZARD_KEY)) return;
  } catch {
    return;
  }
  let data;
  try {
    data = await api.getSettings();
  } catch {
    return;
  }
  if (!data?.model_defaults || data.model_defaults.matched) return;
  openModelWizard(data);
}

function closeWizard() {
  if (!wizard) return;
  document.removeEventListener('keydown', onWizardKeydown);
  wizard.overlay?.remove();
  wizard = null;
}

function onWizardKeydown(event) {
  if (event.key === 'Escape' && wizard) {
    event.preventDefault();
    dismissWizard();
  }
}

function dismissWizard() {
  markWizardSeen('later');
  closeWizard();
}

export function openModelWizard(data = null) {
  if (wizard) return;
  const el = document.createElement('div');
  el.className = 'settings-overlay open wizard-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="settings-panel wizard-panel" role="document">
      <header class="settings-head">
        <div class="settings-head-text">
          <span class="settings-eyebrow">Qwen-Image 2.1</span>
          <h2 class="settings-title">${t('wizard.title')}</h2>
          <p class="settings-sub" data-ref="step"></p>
        </div>
        <button class="settings-close" type="button" data-wizard="later" aria-label="${t('wizard.later')}">
          ${icon('close', 15)}
        </button>
      </header>
      <section class="settings-content" data-ref="body"></section>
      <footer class="settings-foot">
        <span class="settings-foot-status" data-ref="status"></span>
        <div class="settings-foot-actions" data-ref="actions"></div>
      </footer>
    </div>`;
  document.body.appendChild(el);
  wizard = {
    overlay: el,
    body: el.querySelector('[data-ref="body"]'),
    actions: el.querySelector('[data-ref="actions"]'),
    status: el.querySelector('[data-ref="status"]'),
    stepEl: el.querySelector('[data-ref="step"]'),
    step: 1,
    data,
    options: null,
    slots: {},
    busy: false,
  };
  el.addEventListener('click', (event) => {
    if (event.target.closest('[data-wizard="later"]')) {
      dismissWizard();
      return;
    }
    const action = event.target.closest('[data-wizard-action]');
    if (action) {
      event.preventDefault();
      handleWizardAction(action.dataset.wizardAction);
    }
  });
  el.addEventListener('change', (event) => {
    const select = event.target.closest('[data-wiz-slot]');
    if (select) wizard.slots[select.dataset.wizSlot] = select.value;
  });
  document.addEventListener('keydown', onWizardKeydown);
  loadWizardOptions();
  renderWizard();
}

async function loadWizardOptions() {
  if (!wizard || wizard.options) return;
  try {
    const data = await api.options();
    if (!wizard) return;
    wizard.options = data?.models || {};
  } catch {
    if (!wizard) return;
    wizard.options = {};
  }
  if (wizard?.step === 3) renderWizard();
}

function setWizardBusy(busy) {
  if (!wizard) return;
  wizard.busy = busy;
  wizard.status.textContent = busy ? t('wizard.loading') : '';
  wizard.actions.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
}

function renderWizard() {
  if (!wizard) return;
  wizard.stepEl.textContent =
    wizard.step === 1 ? t('wizard.step1') : wizard.step === 2 ? t('wizard.step2') : t('wizard.step3');
  wizard.status.textContent = wizard.busy ? t('wizard.loading') : '';
  if (wizard.step === 1) renderWizardDirs();
  else if (wizard.step === 2) renderWizardMatch();
  else renderWizardSlots();
}

function renderWizardDirs() {
  const dirs = wizardDirs(wizard.data);
  const placeholder = wizard.data?.model?.comfy_root || '';
  wizard.body.innerHTML = `
    <div class="notice info">${t('wizard.dirHint')}</div>
    <div class="set-group">
      ${row(
        t('wizard.modelRoot'),
        t('wizard.modelRootDesc'),
        `<input class="set-input mono" data-wiz="model_root" value="${escapeHtml(dirs.model_root)}"
          placeholder="${escapeHtml(placeholder)}" />`,
      )}
      ${row(
        t('wizard.extraRoots'),
        t('wizard.extraHint'),
        `<input class="set-input mono" data-wiz="extra" value="${escapeHtml(dirs.extra)}"
          placeholder="D:/models" />`,
      )}
    </div>`;
  wizard.actions.innerHTML = `
    <button class="set-btn ghost" type="button" data-wizard-action="later">${t('wizard.later')}</button>
    <button class="set-btn primary" type="button" data-wizard-action="match">${
      wizard.busy ? t('wizard.loading') : t('wizard.match')
    }</button>`;
}

function renderWizardMatch() {
  const audit = wizard.data?.model_defaults;
  const slots = Object.entries(audit?.slots || {});
  const rows = slots
    .map(([, item]) =>
      row(
        escapeHtml(item.label),
        escapeHtml(item.value || item.expected || '—'),
        item.found
          ? `<span class="set-chip ok">${t('defaults.found')}</span>`
          : `<span class="set-chip warn">${t('defaults.missingSlot')}</span>`,
      ),
    )
    .join('');
  wizard.body.innerHTML = `
    ${
      audit?.matched
        ? `<div class="notice info">${t('wizard.matchOk')}</div>`
        : `<div class="notice warn">${t('wizard.matchFail')}</div>`
    }
    ${group(t('defaults.title'), rows)}`;
  wizard.actions.innerHTML = `
    <button class="set-btn ghost" type="button" data-wizard-action="back">${t('wizard.back')}</button>
    ${
      audit?.matched
        ? `<button class="set-btn primary" type="button" data-wizard-action="finish">${t('wizard.useThese')}</button>`
        : `<button class="set-btn primary" type="button" data-wizard-action="manual">${t('wizard.manual')}</button>`
    }`;
}

function renderWizardSlots() {
  const audit = wizard.data?.model_defaults;
  if (!audit) return;
  if (!wizard.options) {
    loadWizardOptions();
    wizard.body.innerHTML = `<p class="set-note">${t('defaults.loading')}</p>`;
    return;
  }
  const rows = Object.entries(audit.slots || {})
    .map(([key, slot]) => {
      if (wizard.slots[key] === undefined) wizard.slots[key] = slot.expected || '';
      const current = wizard.slots[key] || '';
      const list = (wizard.options[slot.kind] || []).map((item) => ({
        value: item.value,
        label: item.label || item.value,
      }));
      if (current && !list.some((item) => item.value === current)) {
        list.unshift({ value: current, label: t('defaults.notScanned', { value: current }) });
      }
      const options = list
        .map(
          (item) =>
            `<option value="${escapeHtml(item.value)}" ${item.value === current ? 'selected' : ''}>${escapeHtml(item.label)}</option>`,
        )
        .join('');
      return row(
        `${escapeHtml(slot.label)}${slot.required ? ' *' : ''}`,
        escapeHtml(slot.value || slot.expected || '—'),
        `<select class="set-input set-select mono" data-wiz-slot="${key}">
          <option value="" ${current ? '' : 'selected'}>${t('defaults.followFactory')}</option>
          ${options}
        </select>`,
      );
    })
    .join('');
  wizard.body.innerHTML = `
    <div class="notice warn">${t('wizard.matchFail')}</div>
    ${group(t('defaults.title'), rows, t('wizard.manualHint'))}`;
  wizard.actions.innerHTML = `
    <button class="set-btn ghost" type="button" data-wizard-action="back">${t('wizard.back')}</button>
    <button class="set-btn primary" type="button" data-wizard-action="save">${t('wizard.finish')}</button>`;
}

function handleWizardAction(action) {
  if (!wizard || wizard.busy) return;
  if (action === 'later') {
    dismissWizard();
    return;
  }
  if (action === 'back') {
    wizard.step = 1;
    renderWizard();
    return;
  }
  if (action === 'match') {
    saveWizardDirs();
    return;
  }
  if (action === 'manual') {
    wizard.step = 3;
    loadWizardOptions();
    renderWizard();
    return;
  }
  if (action === 'finish') {
    finishWizard();
    return;
  }
  if (action === 'save') {
    saveWizardSlots();
  }
}

async function saveWizardDirs() {
  const root = wizard.body.querySelector('[data-wiz="model_root"]')?.value.trim() || '';
  const extra = splitComma(wizard.body.querySelector('[data-wiz="extra"]')?.value);
  setWizardBusy(true);
  try {
    wizard.data = await api.updateSettings({ model_root: root, extra_model_roots: extra });
    wizard.slots = {};
    wizard.step = 2;
    renderWizard();
    toastSuccess(t('wizard.dirsSaved'));
    window.dispatchEvent(new CustomEvent('settings:saved', { detail: { modelChanged: true } }));
  } catch (err) {
    toastError(err, t('wizard.saveFailed'));
  } finally {
    setWizardBusy(false);
  }
}

async function saveWizardSlots() {
  const audit = wizard.data?.model_defaults;
  const patch = {};
  for (const key of Object.keys(audit?.slots || {})) {
    const value = wizard.slots[key] ?? '';
    if (value !== (audit.slots[key].expected || '')) patch[key] = value;
  }
  setWizardBusy(true);
  try {
    if (Object.keys(patch).length) {
      wizard.data = await api.updateSettings({ model_defaults: { slots: patch } });
    }
    finishWizard();
  } catch (err) {
    toastError(err, t('wizard.saveFailed'));
    setWizardBusy(false);
  }
}

function finishWizard() {
  markWizardSeen('done');
  closeWizard();
  toastSuccess(t('wizard.done'));
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
