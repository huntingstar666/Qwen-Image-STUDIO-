/**
 * 全局状态与轻量事件总线。
 * 职责：
 * 1. 保存跨页面共享的状态（health / options / styles 目录 / 当前提示词 / 已选风格预设 / 采样参数）；
 * 2. 把用户设置持久化到 localStorage（刷新不丢参数，但不保存上传的图片）；
 * 3. 提供极简订阅（subscribe）与事件（on/emit），组件按需监听，不引入框架。
 */

import { setLocale } from './i18n.js';

const STORAGE_KEY = 'qi21.workbench.settings.v1';

const DEFAULT_T2I = {
  model: '',
  byModel: {},
  ratioId: '1:1',
  width: 2048,
  height: 2048,
  custom: false,
  steps: 25,
  cfg: 4.0,
  seed: '',
  seedMode: 'random',
  batch: 1,
  sampler: 'euler',
  scheduler: 'simple',
  turbo: false,
  turboProfile: '',
  rgba: false,
  loras: {},
  unet: '',
  clip: '',
  vae: '',
  negativePrompt: '',
  slg: { enabled: false, singleLayers: '', doubleLayers: '', startPercent: 0, endPercent: 0.5 },
  bbox: { enabled: false, characterBoxes: '1', items: [] },
};

const DEFAULT_EDIT = {
  prompt: '',
  sizeMode: 'follow',
  width: 1024,
  height: 1024,
  ratio: '1:1',
  megapixels: '',
  fit: 'pad',
  padMode: 'edge',
  localEnabled: false,
  scheme: 'a',
  feather: 32,
  maskExpand: 0,
  colorMatch: true,
  colorStrength: 0.6,
  contextFactor: 1.5,
  contextPixels: 96,
  blendPixels: 24,
  consistencyEnabled: false,
  consistencyLora: '',
  consistencyStrength: 1.0,
  steps: 25,
  cfg: 4.0,
  seed: '',
  seedMode: 'random',
  denoise: 1.0,
  sampler: 'euler',
  scheduler: 'simple',
  turbo: false,
  turboProfile: '',
  loras: {},
  unet: '',
  clip: '',
  vae: '',
  negativePrompt: '',
};

const DEFAULT_SETTINGS = {
  prompt: '',
  polishModel: '',
  theme: 'system',
  language: 'zh',
  font: 'system',
  accent: 'teal',
  sidebarCollapsed: false,
  creativePresets: {},
  imageAngle: { azimuth: 0, elevation: 0, zoom: 5, enabled: false },
  t2i: DEFAULT_T2I,
  edit: DEFAULT_EDIT,
};

const FONT_MODES = new Set(['system', 'sans', 'serif', 'mono']);
const ACCENT_MODES = new Set(['teal', 'ochre', 'indigo', 'violet']);

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      theme: ['light', 'dark', 'system'].includes(parsed?.theme) ? parsed.theme : 'system',
      language: parsed?.language === 'en' ? 'en' : 'zh',
      font: FONT_MODES.has(parsed?.font) ? parsed.font : 'system',
      accent: ACCENT_MODES.has(parsed?.accent) ? parsed.accent : 'teal',
      sidebarCollapsed: Boolean(parsed?.sidebarCollapsed),
      t2i: { ...structuredClone(DEFAULT_T2I), ...(parsed?.t2i || {}) },
      edit: { ...DEFAULT_EDIT, ...(parsed?.edit || {}) },
      creativePresets: parsed?.creativePresets && typeof parsed.creativePresets === 'object' ? parsed.creativePresets : {},
      imageAngle: { ...DEFAULT_SETTINGS.imageAngle, ...(parsed?.imageAngle || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** 运行时状态（不持久化）。 */
const runtime = {
  health: null,
  options: null,
  styles: null,
  stylesError: null,
  activeTab: 't2i',
  lastResults: {},
};

const listeners = new Set();
const bus = new EventTarget();
let saveTimer = 0;

const settings = loadSettings();

const state = {
  get prompt() {
    return settings.prompt;
  },
  get polishModel() {
    return settings.polishModel;
  },
  get creativePresets() {
    return settings.creativePresets;
  },
  get imageAngle() {
    return settings.imageAngle;
  },
  get t2i() {
    return settings.t2i;
  },
  get edit() {
    return settings.edit;
  },
  get health() {
    return runtime.health;
  },
  get options() {
    return runtime.options;
  },
  get styles() {
    return runtime.styles;
  },
  get stylesError() {
    return runtime.stylesError;
  },
  get activeTab() {
    return runtime.activeTab;
  },
  get theme() {
    return settings.theme;
  },
  get language() {
    return settings.language;
  },
  get font() {
    return settings.font;
  },
  get accent() {
    return settings.accent;
  },
  get sidebarCollapsed() {
    return settings.sidebarCollapsed;
  },
  get lastResults() {
    return runtime.lastResults;
  },
};

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 存储空间不足时静默失败（不影响生成）
    }
  }, 250);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('[store] 订阅者执行失败', err);
    }
  }
}

/** 更新可持久化设置（浅合并，t2i/edit 支持深一层合并）。 */
export function patchSettings(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 't2i' || key === 'edit') {
      settings[key] = { ...settings[key], ...(value || {}) };
      notifySettingsObj(key);
    } else if (key === 'imageAngle') {
      settings.imageAngle = { ...settings.imageAngle, ...(value || {}) };
    } else if (key === 'creativePresets') {
      settings.creativePresets = value || {};
      emit('creative:change', settings.creativePresets);
    } else {
      settings[key] = value;
    }
  }
  persist();
  notify();
}

function notifySettingsObj(key) {
  emit(`${key}:change`, settings[key]);
}

/** 更新运行时状态（不持久化）。 */
export function patchRuntime(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch || {})) {
    if (runtime[key] !== value) {
      runtime[key] = value;
      changed = true;
    }
  }
  if (changed) {
    if ('options' in patch) emit('options:loaded', runtime.options);
    if ('styles' in patch) emit('styles:loaded', runtime.styles);
    notify();
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 事件总线：on/off/emit。 */
export function on(type, handler) {
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

/** 设置当前提示词（所有页面共享），并广播。 */
export function setPrompt(text) {
  settings.prompt = String(text ?? '');
  persist();
  notify();
  emit('prompt:change', settings.prompt);
}

export function getPrompt() {
  return settings.prompt;
}

/** ---------------------------------------------------------------- 主题 */

const THEME_MODES = new Set(['light', 'dark', 'system']);

/** 把主题模式应用到 <html data-theme>，返回是否为暗色。 */
export function applyTheme(mode = settings.theme) {
  const normalized = THEME_MODES.has(mode) ? mode : 'system';
  const dark =
    normalized === 'dark' ||
    (normalized === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  emit('theme:change', { mode: normalized, dark });
  return dark;
}

export function setTheme(mode) {
  if (!THEME_MODES.has(mode)) return;
  patchSettings({ theme: mode });
  applyTheme(mode);
}

export function setSidebarCollapsed(collapsed) {
  patchSettings({ sidebarCollapsed: Boolean(collapsed) });
}

/** ---------------------------------------------------------------- 外观（语言 / 字体 / 强调色） */

/** 把语言、字体、强调色应用到 <html>，并广播 appearance:change。 */
export function applyAppearance(prefs = {}) {
  const language =
    prefs.language === 'en' ? 'en' : prefs.language === 'zh' ? 'zh' : settings.language;
  const font = FONT_MODES.has(prefs.font ?? settings.font) ? prefs.font ?? settings.font : 'system';
  const accent = ACCENT_MODES.has(prefs.accent ?? settings.accent) ? prefs.accent ?? settings.accent : 'teal';
  setLocale(language);
  const root = document.documentElement;
  root.dataset.font = font;
  root.dataset.accent = accent;
  emit('appearance:change', { language, font, accent });
  return { language, font, accent };
}

export function setLanguage(language) {
  const next = language === 'en' ? 'en' : 'zh';
  patchSettings({ language: next });
  applyAppearance({ language: next });
}

export function setFont(font) {
  if (!FONT_MODES.has(font)) return;
  patchSettings({ font });
  applyAppearance({ font });
}

export function setAccent(accent) {
  if (!ACCENT_MODES.has(accent)) return;
  patchSettings({ accent });
  applyAppearance({ accent });
}

/** 已选创意预设快照操作：kind → preset（同 kind 覆盖）。 */
export function setCreativePreset(kind, preset) {
  const next = { ...settings.creativePresets };
  if (preset) next[kind] = preset;
  else delete next[kind];
  settings.creativePresets = next;
  persist();
  notify();
  emit('creative:change', next);
}

/** 用 /api/options 的 defaults 初始化尚未被用户改过的字段。 */
export function applyOptionDefaults(options) {
  const defaults = options?.defaults || {};
  const t2i = settings.t2i;
  const edit = settings.edit;
  // 模型选择：没有保存过就用后端默认模型
  const profiles = options?.model_profiles || [];
  const modelIds = profiles.map((profile) => profile.id);
  const defaultModel = options?.default_model || modelIds[0] || 'qwen';
  if (!modelIds.includes(t2i.model)) t2i.model = defaultModel;
  if (!t2i.byModel || typeof t2i.byModel !== 'object') t2i.byModel = {};
  if (!t2i.slg || typeof t2i.slg !== 'object') t2i.slg = { ...DEFAULT_T2I.slg };
  if (!t2i.bbox || typeof t2i.bbox !== 'object') t2i.bbox = { ...DEFAULT_T2I.bbox };
  if (!Array.isArray(t2i.bbox.items)) t2i.bbox.items = [];
  if (!t2i.unet && defaults.unet) t2i.unet = defaults.unet;
  if (!t2i.clip && defaults.clip) t2i.clip = defaults.clip;
  if (!t2i.vae && defaults.vae) t2i.vae = defaults.vae;
  if (!edit.unet && defaults.unet) edit.unet = defaults.unet;
  if (!edit.clip && defaults.clip) edit.clip = defaults.clip;
  if (!edit.vae && defaults.vae) edit.vae = defaults.vae;
  if (!edit.consistencyLora && defaults.consistency_lora) edit.consistencyLora = defaults.consistency_lora;

  // 采样默认值只在用户从未保存过设置时套用
  const saved = (() => {
    try {
      return Boolean(localStorage.getItem(STORAGE_KEY));
    } catch {
      return false;
    }
  })();
  if (!saved) {
    if (defaults.steps) {
      t2i.steps = defaults.steps;
      edit.steps = defaults.steps;
    }
    if (defaults.cfg) {
      t2i.cfg = defaults.cfg;
      edit.cfg = defaults.cfg;
    }
    if (defaults.sampler) {
      t2i.sampler = defaults.sampler;
      edit.sampler = defaults.sampler;
    }
    if (defaults.scheduler) {
      t2i.scheduler = defaults.scheduler;
      edit.scheduler = defaults.scheduler;
    }
    if (defaults.width) t2i.width = defaults.width;
    if (defaults.height) t2i.height = defaults.height;
  }

  // Turbo 加速预设：上次选择有效就沿用，否则回落到后端默认（config.json 的 turbo_profile）
  const turboIds = (options?.turbo_profiles || []).map((profile) => profile.id);
  const turboDefault = defaults.turbo_profile || turboIds[0] || '';
  if (turboIds.length) {
    if (!turboIds.includes(t2i.turboProfile)) t2i.turboProfile = turboDefault;
    if (!turboIds.includes(edit.turboProfile)) edit.turboProfile = turboDefault;
  }

  // 比例表里的默认项
  const ratios = options?.ratios;
  if (Array.isArray(ratios) && ratios.length) {
    const match = ratios.find((r) => r.w === t2i.width && r.h === t2i.height);
    if (match) t2i.ratioId = match.id;
  }
  persist();
  notify();
}

/** 结果缓存（切页后回来仍显示上次结果）。 */
export function rememberResult(tab, payload) {
  runtime.lastResults[tab] = payload;
}

export const store = {
  state,
  patchSettings,
  patchRuntime,
  subscribe,
  on,
  emit,
  setPrompt,
  getPrompt,
  applyTheme,
  setTheme,
  applyAppearance,
  setLanguage,
  setFont,
  setAccent,
  setSidebarCollapsed,
  setCreativePreset,
  applyOptionDefaults,
  rememberResult,
  defaults: { t2i: DEFAULT_T2I, edit: DEFAULT_EDIT },
};

// 跟随系统主题：仅当用户选择 "system" 时响应系统切换。
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

// 模块加载即同步主题与外观（index.html 的首屏脚本已先行设置，避免闪烁）。
applyTheme(settings.theme);
applyAppearance();
