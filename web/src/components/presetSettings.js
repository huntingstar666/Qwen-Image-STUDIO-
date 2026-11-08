/**
 * 全局设置 · 预设与自定义搭配。
 *
 * 这里是预设默认值的唯一持久化入口：
 * - 内置预设可以覆盖全部参数，并支持单个 / 全部恢复出厂；
 * - 自定义搭配不继承任何预设，用模板起步后自由组合，保存前做冲突检测；
 * - 任务页只读取这里的默认值，页面上的修改属于临时值，切换预设时重建。
 */

import { api } from '../api.js';
import { escapeHtml } from '../utils.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';

const TASK_OPTIONS = [
  { value: 'edit', label: '通用编辑' },
  { value: 'remove', label: '元素移除' },
  { value: 'outpaint', label: '扩图' },
  { value: 'panorama', label: '全景' },
];
const SCHEME_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'b', label: '方案 B · 区域裁剪' },
  { value: 'a', label: '方案 A · 整画布' },
  { value: 'native', label: '原生 · 不合成' },
];
const HINT_OPTIONS = [
  { value: 'none', label: '不使用提示图' },
  { value: 'green_overlay', label: '绿色选区（移除）' },
  { value: 'gray_fill', label: '灰边（扩图 / 全景）' },
];
const BAND_OPTIONS = [
  { value: 'lowfreq', label: '低频增益' },
  { value: 'alpha', label: '仅 alpha' },
];
const ASPECT_OPTIONS = ['2:1', '3:1', '4:1', '21:9'].map((value) => ({ value, label: value }));
const CHAIN_OPTIONS = [
  { value: 'mask', label: '遮罩接力' },
  { value: 'native', label: '整图接力' },
];
const PREPROCESS_MODES = [
  { value: 'downscale_only', label: '仅缩小' },
  { value: 'clamp_range', label: '缩小 + 放大' },
];

const GROUPS = [
  {
    id: 'task',
    title: '任务与方案',
    open: true,
    fields: [
      { path: 'task.mode', label: '任务模式', type: 'select', options: TASK_OPTIONS },
      { path: 'local.enabled', label: '启用局部编辑', type: 'switch' },
      { path: 'local.scheme', label: '合成方案', type: 'select', options: SCHEME_OPTIONS },
      { path: 'local.hint', label: '提示图', type: 'select', options: HINT_OPTIONS },
    ],
  },
  {
    id: 'sampling',
    title: 'Turbo 与采样',
    open: true,
    fields: [
      { path: 'turbo.enabled', label: '启用 Turbo', type: 'switch' },
      { path: 'turbo.profile', label: 'Turbo 档位', type: 'select', options: 'turbo' },
      { path: 'sampling.steps', label: '步数', type: 'number', min: 1, max: 200, step: 1 },
      { path: 'sampling.cfg', label: 'CFG', type: 'number', min: 0, max: 30, step: 0.1 },
      { path: 'sampling.sampler', label: '采样器', type: 'select', options: 'sampler' },
      { path: 'sampling.scheduler', label: '调度器', type: 'select', options: 'scheduler' },
      { path: 'sampling.denoise', label: '降噪 denoise', type: 'number', min: 0.05, max: 1, step: 0.05 },
    ],
  },
  {
    id: 'consistency',
    title: '一致性 LoRA',
    open: true,
    fields: [
      { path: 'consistency.enabled', label: '启用一致性 LoRA', type: 'switch' },
      { path: 'consistency.lora', label: 'LoRA 文件', type: 'select', options: 'lora' },
      { path: 'consistency.strength', label: '强度', type: 'range', min: 0, max: 2, step: 0.01 },
    ],
  },
  {
    id: 'preprocess',
    title: '大图预处理',
    fields: [
      { path: 'preprocess.enabled', label: '启用预处理', type: 'switch' },
      { path: 'preprocess.max_side', label: '长边上限', type: 'number', min: 256, max: 8192, step: 32 },
      { path: 'preprocess.min_side', label: '长边下限', type: 'number', min: 256, max: 8192, step: 32 },
      { path: 'preprocess.multiple', label: '对齐倍数', type: 'number', min: 8, max: 256, step: 8 },
      { path: 'preprocess.mode', label: '缩放范围', type: 'select', options: PREPROCESS_MODES },
    ],
  },
  {
    id: 'crop',
    title: '裁切（方案 B）',
    fields: [
      { path: 'local.expand_top', label: '上扩系数', type: 'number', min: 1, max: 3, step: 0.05 },
      { path: 'local.expand_bottom', label: '下扩系数', type: 'number', min: 1, max: 3, step: 0.05 },
      { path: 'local.expand_left', label: '左扩系数', type: 'number', min: 1, max: 3, step: 0.05 },
      { path: 'local.expand_right', label: '右扩系数', type: 'number', min: 1, max: 3, step: 0.05 },
      { path: 'local.fills', label: '填充闭合选区', type: 'switch' },
      { path: 'local.crop_min_side', label: '裁块下限', type: 'number', min: 0, max: 4096, step: 32 },
      { path: 'local.crop_max_side', label: '裁块上限', type: 'number', min: 0, max: 4096, step: 32 },
      { path: 'local.crop_floor', label: '最小裁剪窗', type: 'number', min: 0, max: 2048, step: 32 },
    ],
  },
  {
    id: 'seam',
    title: '接缝与羽化',
    fields: [
      { path: 'local.expand_pct', label: '接缝扩展 %', type: 'number', min: 0, max: 20, step: 0.5 },
      { path: 'local.feather_pct', label: '接缝羽化 %', type: 'number', min: 0, max: 30, step: 0.5 },
      { path: 'local.blend_pixels', label: '过渡带 px', type: 'number', min: 0, max: 256, step: 4 },
      { path: 'local.feather', label: '羽化 px（A）', type: 'number', min: 0, max: 256, step: 4 },
      { path: 'local.mask_expand', label: '遮罩外扩 px（A）', type: 'number', min: 0, max: 256, step: 4 },
      { path: 'local.dither', label: '确定性抖动', type: 'switch' },
    ],
  },
  {
    id: 'color',
    title: '颜色',
    fields: [
      { path: 'local.color_match', label: '颜色匹配', type: 'switch' },
      { path: 'local.color_strength', label: '过渡带强度', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'local.color_restore', label: '区域色彩还原', type: 'switch' },
      { path: 'local.color_restore_strength', label: '还原强度', type: 'range', min: 0, max: 1, step: 0.01 },
      { path: 'local.band_mode', label: '过渡带算法', type: 'select', options: BAND_OPTIONS },
    ],
  },
  {
    id: 'outpaint',
    title: '扩图',
    fields: [
      { path: 'outpaint.top', label: '上扩 %', type: 'number', min: 0, max: 200, step: 1 },
      { path: 'outpaint.bottom', label: '下扩 %', type: 'number', min: 0, max: 200, step: 1 },
      { path: 'outpaint.left', label: '左扩 %', type: 'number', min: 0, max: 200, step: 1 },
      { path: 'outpaint.right', label: '右扩 %', type: 'number', min: 0, max: 200, step: 1 },
      { path: 'outpaint.max_side', label: '最大输出长边', type: 'number', min: 1024, max: 8192, step: 32 },
    ],
  },
  {
    id: 'panorama',
    title: '全景',
    fields: [
      { path: 'panorama.aspect', label: '比例', type: 'select', options: ASPECT_OPTIONS },
      { path: 'panorama.long_side', label: '长边', type: 'number', min: 1024, max: 4096, step: 32 },
      { path: 'panorama.wrap', label: '360° 环绕接缝', type: 'switch' },
      { path: 'panorama.seam_blend', label: '环绕融合 px', type: 'number', min: 0, max: 128, step: 4 },
    ],
  },
  {
    id: 'chain',
    title: '连续编辑',
    fields: [
      { path: 'chain.mode', label: '接力模式', type: 'select', options: CHAIN_OPTIONS },
      { path: 'chain.carry_mask', label: '跨轮保留遮罩', type: 'switch' },
      { path: 'chain.anchor_every', label: '每 N 轮回锚', type: 'number', min: 1, max: 50, step: 1, fallback: 5 },
      { path: 'chain.drift_warn_delta_e', label: '漂移告警 ΔE', type: 'number', min: 0, max: 100, step: 1, fallback: 10 },
    ],
  },
  {
    id: 'zero',
    title: '零偏移',
    fields: [{ path: 'zero_shift.enabled', label: '启用零像素偏移', type: 'switch' }],
  },
];

const TEMPLATES = [
  { id: 'mask_edit', label: '局部编辑模板' },
  { id: 'canvas', label: '整画布模板' },
  { id: 'native', label: '原生模板' },
  { id: 'remove', label: '元素移除模板' },
  { id: 'outpaint', label: '扩图模板' },
  { id: 'panorama', label: '全景模板' },
];

function getPath(obj, path, fallback = undefined) {
  const value = String(path || '')
    .split('.')
    .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), obj);
  return value === undefined ? fallback : value;
}

function setPath(obj, path, value) {
  const parts = String(path || '').split('.');
  let cursor = obj;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function fmtNumber(value, step = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return step && step < 1 ? String(Number(number.toFixed(3))) : String(Math.round(number));
}

function optionsFor(field, state) {
  if (Array.isArray(field.options)) return field.options;
  if (field.options === 'sampler') {
    return (state.options?.samplers || []).map((value) => ({ value, label: value }));
  }
  if (field.options === 'scheduler') {
    return (state.options?.schedulers || []).map((value) => ({ value, label: value }));
  }
  if (field.options === 'turbo') {
    return (state.options?.turbo_profiles || []).map((item) => ({
      value: item.id,
      label: `${item.label || item.id}${item.steps ? ` · ${item.steps} 步` : ''}`,
    }));
  }
  if (field.options === 'lora') {
    const list = (state.options?.models?.lora || []).map((item) => ({
      value: item.value || item.name || '',
      label: item.label || item.value || item.name || '',
    }));
    const current = '';
    if (!list.some((item) => item.value === current)) {
      list.unshift({ value: '', label: '跟随系统设置里的默认一致性 LoRA' });
    }
    return list;
  }
  return [];
}

function renderField(field, params, state, scope) {
  const attr = scope === 'custom' ? 'data-cpath' : 'data-ppath';
  const value = getPath(params, field.path);
  const label = escapeHtml(field.label || field.path);
  if (field.type === 'switch') {
    return `<label class="preset-admin-field preset-admin-check">
      <input type="checkbox" ${attr}="${field.path}" data-ptype="switch" ${value ? 'checked' : ''} />
      <span>${label}</span>
    </label>`;
  }
  if (field.type === 'select') {
    const options = optionsFor(field, state);
    const current = value == null ? '' : String(value);
    const hasCurrent = options.some((item) => String(item.value) === current);
    const rows = options.map(
      (item) =>
        `<option value="${escapeHtml(item.value)}" ${String(item.value) === current ? 'selected' : ''}>${escapeHtml(item.label)}</option>`,
    );
    if (!hasCurrent && current) {
      rows.unshift(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`);
    }
    return `<label class="preset-admin-field">
      <span>${label}</span>
      <select class="set-input" ${attr}="${field.path}" data-ptype="text">${rows.join('')}</select>
    </label>`;
  }
  if (field.type === 'range') {
    return `<label class="preset-admin-field">
      <span>${label} <em class="mono">${escapeHtml(fmtNumber(value, field.step))}</em></span>
      <input class="set-input" type="range" min="${field.min}" max="${field.max}" step="${field.step}"
        value="${escapeHtml(String(value ?? field.min))}" ${attr}="${field.path}" data-ptype="number" />
    </label>`;
  }
  return `<label class="preset-admin-field">
    <span>${label}</span>
    <input class="set-input mono" type="number" min="${field.min}" max="${field.max}" step="${field.step}"
      value="${escapeHtml(fmtNumber(value ?? field.fallback ?? 0, field.step))}" ${attr}="${field.path}" data-ptype="number" />
  </label>`;
}

function renderLoras(params, scope) {
  const attr = scope === 'custom' ? 'data-cpath' : 'data-ppath';
  const list = Array.isArray(params.loras) ? params.loras : [];
  const rows = list
    .map(
      (item, index) => `
      <div class="preset-admin-lora">
        <input class="set-input mono" placeholder="LoRA 文件路径" value="${escapeHtml(String(item?.name || ''))}"
          ${attr}="loras.${index}.name" data-ptype="text" />
        <input class="set-input mono" type="number" min="0" max="2" step="0.05"
          value="${escapeHtml(String(item?.strength ?? 1))}" ${attr}="loras.${index}.strength" data-ptype="number" />
        <button class="btn ghost sm" type="button" data-paction="remove-lora" data-index="${index}">删除</button>
      </div>`,
    )
    .join('');
  return `<div class="preset-admin-loras">
    ${rows || '<div class="set-note">没有额外 LoRA（任务 LoRA 仍会按任务自动挂载）。</div>'}
    <button class="btn ghost sm" type="button" data-paction="add-lora">+ 添加额外 LoRA</button>
  </div>`;
}

function renderGroups(params, state, scope) {
  return GROUPS.map((group) => {
    const body = group.fields.map((field) => renderField(field, params, state, scope)).join('');
    const loras = group.id === 'consistency' ? renderLoras(params, scope) : '';
    return `<details class="preset-admin-group" ${group.open ? 'open' : ''}>
      <summary>${escapeHtml(group.title)}</summary>
      <div class="preset-admin-grid">${body}${loras}</div>
    </details>`;
  }).join('');
}

function renderIssues(issues) {
  const errors = issues?.errors || [];
  const warnings = issues?.warnings || [];
  if (!errors.length && !warnings.length) {
    return '<div class="preset-admin-issues ok">未发现冲突，可以保存。</div>';
  }
  const rows = [
    ...errors.map((text) => `<div class="preset-admin-issue error">✕ ${escapeHtml(text)}</div>`),
    ...warnings.map((text) => `<div class="preset-admin-issue warn">! ${escapeHtml(text)}</div>`),
  ];
  return `<div class="preset-admin-issues">${rows.join('')}</div>`;
}

function validateParams(params, maxSide, { custom = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!params || typeof params !== 'object') return { errors: ['参数不是对象'], warnings: [] };
  const task = String(getPath(params, 'task.mode', 'edit'));
  const scheme = String(getPath(params, 'local.scheme', 'a'));
  const hint = String(getPath(params, 'local.hint', 'none'));

  for (const group of GROUPS) {
    for (const field of group.fields) {
      if (field.type !== 'number' && field.type !== 'range') continue;
      const raw = getPath(params, field.path);
      if (raw == null || raw === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        errors.push(`${field.label} 必须是数字`);
      } else if (value < field.min || value > field.max) {
        errors.push(`${field.label} 必须在 ${field.min}~${field.max}`);
      }
    }
  }

  const cropMin = Number(getPath(params, 'local.crop_min_side', 0)) || 0;
  const cropMax = Number(getPath(params, 'local.crop_max_side', 0)) || 0;
  if (cropMin && cropMax && cropMin > cropMax) errors.push('裁块下限不能大于裁块上限');
  const preMin = Number(getPath(params, 'preprocess.min_side', 0)) || 0;
  const preMax = Number(getPath(params, 'preprocess.max_side', 0)) || 0;
  if (preMin && preMax && preMin > preMax) errors.push('预处理长边下限不能大于上限');
  const outMax = Number(getPath(params, 'outpaint.max_side', 0)) || 0;
  if (outMax && maxSide && outMax > maxSide) {
    errors.push(`扩图最大长边不能超过全局 max_side（${maxSide}）`);
  }
  const panoLong = Number(getPath(params, 'panorama.long_side', 0)) || 0;
  if (panoLong && maxSide && panoLong > maxSide) {
    errors.push(`全景长边不能超过全局 max_side（${maxSide}）`);
  }

  const pads = ['top', 'bottom', 'left', 'right'].map((key) =>
    Number(getPath(params, `outpaint.${key}`, 0)) || 0,
  );
  const fills = Boolean(getPath(params, 'local.fills', false));
  if (task === 'remove') {
    if (!fills) errors.push('元素移除要求开启「填充闭合选区」');
    if (hint !== 'green_overlay') errors.push('元素移除要求提示图 = 绿色选区');
  }
  if (custom && task === 'outpaint' && !pads.some((value) => value > 0)) {
    errors.push('扩图至少需要一条外扩边大于 0');
  }
  if (task === 'panorama') {
    if (scheme !== 'a') errors.push('全景必须使用方案 A（整画布采样）');
    if (hint !== 'gray_fill') errors.push('全景要求提示图 = 灰边');
  }
  if (scheme === 'native' && ['remove', 'outpaint'].includes(task)) {
    warnings.push('原生模式不做遮罩合成，任务边缘可能无法逐字节保留');
  }
  if (!Boolean(getPath(params, 'consistency.enabled', true))) {
    const strength = Number(getPath(params, 'consistency.strength', 0.48));
    if (getPath(params, 'consistency.lora', '') || Math.abs(strength - 0.48) > 1e-6) {
      warnings.push('一致性已关闭，LoRA 文件与强度不会生效');
    }
  }
  return { errors, warnings };
}

function autoFix(params) {
  const task = String(getPath(params, 'task.mode', 'edit'));
  if (task === 'remove') {
    setPath(params, 'local.fills', true);
    setPath(params, 'local.hint', 'green_overlay');
  } else if (task === 'outpaint') {
    setPath(params, 'local.fills', false);
    setPath(params, 'local.hint', 'gray_fill');
    const pads = ['top', 'bottom', 'left', 'right'].map((key) =>
      Number(getPath(params, `outpaint.${key}`, 0)) || 0,
    );
    if (!pads.some((value) => value > 0)) {
      for (const key of ['top', 'bottom', 'left', 'right']) setPath(params, `outpaint.${key}`, 10);
    }
  } else if (task === 'panorama') {
    setPath(params, 'local.scheme', 'a');
    setPath(params, 'local.hint', 'gray_fill');
  } else {
    setPath(params, 'local.hint', 'none');
  }
  const cropMin = Number(getPath(params, 'local.crop_min_side', 0)) || 0;
  const cropMax = Number(getPath(params, 'local.crop_max_side', 0)) || 0;
  if (cropMin && cropMax && cropMin > cropMax) setPath(params, 'local.crop_max_side', cropMin);
  const preMin = Number(getPath(params, 'preprocess.min_side', 0)) || 0;
  const preMax = Number(getPath(params, 'preprocess.max_side', 0)) || 0;
  if (preMin && preMax && preMin > preMax) setPath(params, 'preprocess.max_side', preMin);
  return params;
}

function templateParams(state, templateId) {
  const item =
    (state.data?.factory || []).find((entry) => entry.id === templateId) ||
    (state.data?.factory || [])[0];
  const params = clone(item?.params || {});
  const task = String(getPath(params, 'task.mode', 'edit'));
  if (task === 'outpaint') {
    for (const key of ['top', 'bottom', 'left', 'right']) setPath(params, `outpaint.${key}`, 10);
  }
  if (task === 'remove') {
    setPath(params, 'local.fills', true);
    setPath(params, 'local.hint', 'green_overlay');
  }
  if (task === 'panorama') {
    setPath(params, 'local.scheme', 'a');
    setPath(params, 'local.hint', 'gray_fill');
  }
  if (!Array.isArray(params.loras)) params.loras = [];
  return params;
}

export function mountPresetSettings(host) {
  if (!host) return;
  host.classList.add('preset-admin');
  const state = {
    loading: true,
    error: '',
    data: null,
    options: null,
    drafts: {},
    custom: [],
    activeId: 'mask_edit',
    editingIndex: -1,
    editingName: '',
    editingTemplate: 'mask_edit',
    editingParams: null,
    issues: { errors: [], warnings: [] },
    saving: false,
  };

  function presetIssues() {
    return validateParams(state.drafts[state.activeId] || {}, state.data?.max_side);
  }

  function customIssues() {
    if (state.editingParams === null) return null;
    return validateParams(state.editingParams, state.data?.max_side, { custom: true });
  }

  function paintIssues() {
    const preset = presetIssues();
    const custom = customIssues();
    const presetNode = host.querySelector('[data-preset-issues]');
    const customNode = host.querySelector('[data-custom-issues]');
    if (presetNode) presetNode.innerHTML = renderIssues(preset);
    if (customNode && custom) customNode.innerHTML = renderIssues(custom);
    state.issues = custom || preset;
    const presetSave = host.querySelector('[data-paction="save-preset"]');
    const customSave = host.querySelector('[data-paction="save-custom"]');
    if (presetSave) presetSave.disabled = state.saving || preset.errors.length > 0;
    if (customSave) customSave.disabled = state.saving || Boolean(custom?.errors.length);
  }

  function presetTab(id, label, overridden) {
    return `<button type="button" class="preset-admin-tab ${state.activeId === id ? 'active' : ''}"
      data-paction="select-preset" data-id="${escapeHtml(id)}">
      ${escapeHtml(label)}${overridden ? '<span class="preset-admin-dot" title="已在全局设置里自定义"></span>' : ''}
    </button>`;
  }

  function render() {
    if (!host.isConnected) return;
    if (state.loading) {
      host.innerHTML = '<div class="set-loading">正在读取预设配置…</div>';
      return;
    }
    if (state.error) {
      host.innerHTML = `<div class="set-empty">${escapeHtml(state.error)}</div>`;
      return;
    }
    const preset = (state.data?.presets || []).find((item) => item.id === state.activeId);
    const params = state.drafts[state.activeId] || preset?.params || {};
    const presetIss = presetIssues();
    const customIss = customIssues();
    state.issues = customIss || presetIss;
    const overridden = new Set(state.data?.overridden || []);
    const customRows = state.custom
      .map(
        (item, index) => `
        <div class="preset-admin-custom-row">
          <div class="preset-admin-custom-name">${escapeHtml(item.name)}</div>
          <div class="preset-admin-actions">
            <button class="btn ghost sm" type="button" data-paction="edit-custom" data-index="${index}">编辑</button>
            <button class="btn ghost sm" type="button" data-paction="duplicate-custom" data-index="${index}">复制</button>
            <button class="btn ghost sm" type="button" data-paction="delete-custom" data-index="${index}">删除</button>
          </div>
        </div>`,
      )
      .join('');
    const customEditor =
      state.editingParams !== null
        ? `<div class="preset-admin-editor">
            <div class="preset-admin-editor-head">
              <label class="preset-admin-field">
                <span>配置名称</span>
                <input class="set-input" data-pname value="${escapeHtml(state.editingName)}" maxlength="40" />
              </label>
              <label class="preset-admin-field">
                <span>模板</span>
                <select class="set-input" data-ptemplate>
                  ${TEMPLATES.map(
                    (item) =>
                      `<option value="${item.id}" ${item.id === state.editingTemplate ? 'selected' : ''}>${escapeHtml(item.label)}</option>`,
                  ).join('')}
                </select>
              </label>
            </div>
            <div data-custom-issues>${renderIssues(customIss || { errors: [], warnings: [] })}</div>
            ${renderGroups(state.editingParams, state, 'custom')}
            <div class="preset-admin-actions">
              <button class="btn primary sm" type="button" data-paction="save-custom" ${customIss?.errors?.length ? 'disabled' : ''}>保存自定义搭配</button>
              <button class="btn ghost sm" type="button" data-paction="auto-fix">自动修复冲突</button>
              <button class="btn ghost sm" type="button" data-paction="cancel-custom">取消</button>
            </div>
          </div>`
        : '';

    host.innerHTML = `
      <div class="preset-admin-hero">
        <h2>预设默认配置</h2>
        <p>这里保存的数值是所有生图任务的默认值。任务页上的修改只保留到下次切换预设；切换预设会重新加载这里的配置。</p>
        <p class="set-note">本页使用下面的「保存」按钮立即写盘，不受设置页底部「保存更改」影响。</p>
      </div>
      <section class="set-group">
        <h3 class="set-group-title">内置预设</h3>
        <div class="set-card">
          <div class="preset-admin-tabs">
            ${(state.data?.presets || [])
              .map((item) => presetTab(item.id, item.label || item.id, overridden.has(item.id)))
              .join('')}
          </div>
          <div class="preset-admin-toolbar">
            <span class="set-desc">${escapeHtml(preset?.summary || '')}</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" type="button" data-paction="reset-preset">恢复此预设出厂值</button>
            <button class="btn ghost sm" type="button" data-paction="reset-all">全部恢复出厂</button>
            <button class="btn primary sm" type="button" data-paction="save-preset" ${presetIss.errors.length ? 'disabled' : ''}>保存此预设默认</button>
          </div>
          <div data-preset-issues>${renderIssues(presetIss)}</div>
          ${renderGroups(params, state, 'preset')}
        </div>
      </section>
      <section class="set-group">
        <h3 class="set-group-title">自定义搭配</h3>
        <div class="set-card">
          <div class="preset-admin-toolbar">
            <span class="set-desc">不继承任何预设，从模板起步后自由组合；保存前会检测冲突。</span>
            <span class="spacer"></span>
            <button class="btn primary sm" type="button" data-paction="new-custom">+ 新建自定义搭配</button>
          </div>
          ${customRows || '<div class="set-note">还没有自定义搭配。任务页会在预设列表旁提供「自定义搭配」选择器。</div>'}
          ${customEditor}
        </div>
      </section>`;
  }

  function notifyUpdated() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('presets:updated'));
    }
  }

  async function load() {
    state.loading = true;
    state.error = '';
    render();
    try {
      const [data, options] = await Promise.all([
        api.presetConfig(),
        api.options().catch(() => null),
      ]);
      state.data = data;
      state.options = options || {};
      state.drafts = Object.fromEntries(
        (data.presets || []).map((item) => [item.id, clone(item.params)]),
      );
      state.custom = clone(data.custom || []);
      const first = data.presets?.[0]?.id;
      if (first && !state.drafts[state.activeId]) state.activeId = first;
      state.loading = false;
    } catch (err) {
      state.loading = false;
      state.error = `读取预设配置失败：${err?.message || err}`;
      toastError(err, '读取预设配置失败');
    }
    render();
  }

  async function savePreset() {
    if (state.saving) return;
    const params = state.drafts[state.activeId];
    if (params?.consistency) {
      setPath(params, 'local.consistency', getPath(params, 'consistency.enabled', true) !== false);
    }
    const issues = validateParams(params, state.data?.max_side);
    if (issues.errors.length) {
      toastWarn(issues.errors[0]);
      return;
    }
    state.saving = true;
    render();
    try {
      const data = await api.savePresetConfig({ preset_defaults: { [state.activeId]: params } });
      state.data = data;
      state.drafts = Object.fromEntries(
        (data.presets || []).map((item) => [item.id, clone(item.params)]),
      );
      state.custom = clone(data.custom || []);
      notifyUpdated();
      toastSuccess('预设默认值已保存');
    } catch (err) {
      toastError(err, '保存预设失败');
    } finally {
      state.saving = false;
      render();
    }
  }

  async function resetPreset(ids) {
    if (state.saving || !ids.length) return;
    state.saving = true;
    try {
      const data = await api.savePresetConfig({ reset_presets: ids });
      state.data = data;
      state.drafts = Object.fromEntries(
        (data.presets || []).map((item) => [item.id, clone(item.params)]),
      );
      state.custom = clone(data.custom || []);
      notifyUpdated();
      toastSuccess(ids.length > 1 ? '已全部恢复出厂预设' : '已恢复此预设出厂值');
    } catch (err) {
      toastError(err, '恢复默认失败');
    } finally {
      state.saving = false;
      render();
    }
  }

  function startCustom(index = -1, template = 'mask_edit') {
    if (index >= 0) {
      const item = state.custom[index];
      if (!item) return;
      state.editingIndex = index;
      state.editingName = item.name;
      state.editingTemplate = 'mask_edit';
      state.editingParams = clone(item.params);
    } else {
      state.editingIndex = -1;
      state.editingName = `自定义搭配 ${state.custom.length + 1}`;
      state.editingTemplate = template;
      state.editingParams = templateParams(state, template);
    }
    render();
  }

  async function saveCustom() {
    if (state.saving || state.editingParams === null) return;
    const name = String(state.editingName || '').trim();
    if (!name) {
      toastWarn('先给自定义搭配起个名字');
      return;
    }
    if (state.editingParams.consistency) {
      setPath(state.editingParams, 'local.consistency',
        getPath(state.editingParams, 'consistency.enabled', true) !== false);
    }
    const issues = validateParams(state.editingParams, state.data?.max_side, { custom: true });
    if (issues.errors.length) {
      state.issues = issues;
      paintIssues();
      toastWarn(issues.errors[0]);
      return;
    }
    const next = state.custom.map((item) => clone(item));
    const payloadItem = {
      id:
        state.editingIndex >= 0
          ? next[state.editingIndex].id
          : `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      params: clone(state.editingParams),
    };
    if (state.editingIndex >= 0) next[state.editingIndex] = payloadItem;
    else next.push(payloadItem);
    state.saving = true;
    render();
    try {
      const data = await api.savePresetConfig({ custom_presets: next });
      state.data = data;
      state.drafts = Object.fromEntries(
        (data.presets || []).map((item) => [item.id, clone(item.params)]),
      );
      state.custom = clone(data.custom || []);
      state.editingParams = null;
      state.editingIndex = -1;
      notifyUpdated();
      toastSuccess('自定义搭配已保存');
    } catch (err) {
      toastError(err, '保存自定义搭配失败');
    } finally {
      state.saving = false;
      render();
    }
  }

  async function deleteCustom(index) {
    if (state.saving) return;
    const item = state.custom[index];
    if (!item) return;
    if (!window.confirm(`删除自定义搭配「${item.name}」？`)) return;
    const next = state.custom.filter((_, i) => i !== index).map((entry) => clone(entry));
    state.saving = true;
    render();
    try {
      const data = await api.savePresetConfig({ custom_presets: next });
      state.data = data;
      state.custom = clone(data.custom || []);
      notifyUpdated();
      toastSuccess('已删除自定义搭配');
    } catch (err) {
      toastError(err, '删除失败');
    } finally {
      state.saving = false;
      render();
    }
  }

  function writeInput(target, event) {
    const scope = target.hasAttribute('data-cpath') ? 'custom' : 'preset';
    const path = target.getAttribute(scope === 'custom' ? 'data-cpath' : 'data-ppath');
    if (!path) return;
    const params = scope === 'custom' ? state.editingParams : state.drafts[state.activeId];
    if (!params) return;
    const type = target.dataset.ptype || 'text';
    let value;
    if (type === 'switch') value = target.checked;
    else if (type === 'number') value = Number(target.value);
    else value = target.value;
    setPath(params, path, value);
    // 一致性总开关同时驱动 local.consistency，避免两份开关打架。
    if (path === 'consistency.enabled') {
      setPath(params, 'local.consistency', Boolean(value));
    }
    const rangeLabel = target.parentElement?.querySelector('em');
    if (rangeLabel && type === 'number' && target.type === 'range') {
      rangeLabel.textContent = fmtNumber(value, Number(target.step) || 1);
    }
    paintIssues();
  }

  host.addEventListener('input', (event) => {
    const nameInput = event.target.closest('[data-pname]');
    if (nameInput) {
      state.editingName = nameInput.value;
      return;
    }
    const target = event.target.closest('[data-ppath], [data-cpath]');
    if (!target || target.type === 'checkbox' || target.tagName === 'SELECT') return;
    writeInput(target, event);
  });
  host.addEventListener('change', (event) => {
    const nameInput = event.target.closest('[data-pname]');
    if (nameInput) {
      state.editingName = nameInput.value;
      return;
    }
    const template = event.target.closest('[data-ptemplate]');
    if (template) {
      state.editingTemplate = template.value;
      state.editingParams = templateParams(state, template.value);
      render();
      return;
    }
    const target = event.target.closest('[data-ppath], [data-cpath]');
    if (target) writeInput(target, event);
  });
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-paction]');
    if (!button) return;
    const action = button.dataset.paction;
    if (action === 'select-preset') {
      state.activeId = button.dataset.id;
      render();
      return;
    }
    if (action === 'save-preset') return void savePreset();
    if (action === 'reset-preset') return void resetPreset([state.activeId]);
    if (action === 'reset-all') {
      if (!window.confirm('把所有内置预设恢复为出厂值？这会清除全局设置里的预设覆盖。')) return;
      return void resetPreset((state.data?.presets || []).map((item) => item.id));
    }
    if (action === 'new-custom') return startCustom();
    if (action === 'edit-custom') return startCustom(Number(button.dataset.index));
    if (action === 'duplicate-custom') {
      const source = state.custom[Number(button.dataset.index)];
      if (!source) return;
      const next = state.custom.map((item) => clone(item));
      next.push({
        id: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: `${source.name} 副本`,
        params: clone(source.params),
      });
      state.saving = true;
      render();
      api
        .savePresetConfig({ custom_presets: next })
        .then((data) => {
          state.data = data;
          state.custom = clone(data.custom || []);
          notifyUpdated();
          toastSuccess('已复制自定义搭配');
        })
        .catch((err) => toastError(err, '复制失败'))
        .finally(() => {
          state.saving = false;
          render();
        });
      return;
    }
    if (action === 'delete-custom') return void deleteCustom(Number(button.dataset.index));
    if (action === 'save-custom') return void saveCustom();
    if (action === 'cancel-custom') {
      state.editingParams = null;
      state.editingIndex = -1;
      render();
      return;
    }
    if (action === 'auto-fix') {
      if (!state.editingParams) return;
      autoFix(state.editingParams);
      const issues = validateParams(state.editingParams, state.data?.max_side, { custom: true });
      state.issues = issues;
      render();
      toastSuccess(issues.errors.length ? '已修复部分冲突，请查看剩余问题' : '冲突已自动修复');
      return;
    }
    if (action === 'add-lora' || action === 'remove-lora') {
      const params = state.editingParams || state.drafts[state.activeId];
      if (!params) return;
      if (!Array.isArray(params.loras)) params.loras = [];
      if (action === 'add-lora') params.loras.push({ name: '', strength: 1 });
      else params.loras.splice(Number(button.dataset.index), 1);
      render();
      paintIssues();
    }
  });

  void load();
}
