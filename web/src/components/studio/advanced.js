/**
 * 高级设置（8 组）：孤海原版可调参数全部可改，每项带单位 / 作用提示 / 恢复。
 *
 * 数值模型：生效值 = 覆盖项 > 当前预设参数 > `fallback`（仅用于显示，不参与提交）。
 * 「恢复」= 删掉对应覆盖项，回到预设值；预设没写的键交给后端内置默认。
 */

import { escapeHtml } from '../../utils.js';
import {
  effectiveValue,
  modifiedKeys,
  withOverride,
  withoutOverrides,
} from './presets.js';

const RANGE_MODES = [
  { value: 'downscale_only', label: '仅缩小' },
  { value: 'range', label: '缩小 + 放大' },
];

const GROUPS = [
  {
    id: 'crop',
    title: '裁切与上下文',
    note: '只把遮罩附近送去采样；上下文系数 / 像素决定带多少周边画面。',
    fields: [
      { key: 'local.expand_top', label: '上扩系数', type: 'number', min: 1, max: 3, step: 0.05, fallback: 1.3, unit: '×', hint: '遮罩包围盒向上扩展的倍数（乘遮罩短边）。' },
      { key: 'local.expand_bottom', label: '下扩系数', type: 'number', min: 1, max: 3, step: 0.05, fallback: 1.4, unit: '×', hint: '遮罩包围盒向下扩展的倍数。人物/脚部建议更大。' },
      { key: 'local.expand_left', label: '左扩系数', type: 'number', min: 1, max: 3, step: 0.05, fallback: 1.4, unit: '×', hint: '遮罩包围盒向左扩展的倍数。' },
      { key: 'local.expand_right', label: '右扩系数', type: 'number', min: 1, max: 3, step: 0.05, fallback: 1.4, unit: '×', hint: '遮罩包围盒向右扩展的倍数。' },
      { key: 'local.fills', label: '填充闭合选区', type: 'switch', fallback: false, hint: '把描边内部一并填满，避免只移除一圈边。元素移除必须开。' },
      { key: 'local.crop_min_side', label: '裁块下限', type: 'select', fallback: 768, numeric: true, options: [0, 512, 768, 1024, 1536], unit: 'px', hint: '裁块短边至少这么大；扩图档位是 1024。' },
      { key: 'local.crop_max_side', label: '裁块上限', type: 'select', fallback: 2048, numeric: true, options: [1024, 1536, 2048, 2560, 3072, 4096], unit: 'px', hint: '裁块长边上限；越大越贵，超过 2048 收益递减。' },
      { key: 'local.context_factor', label: '上下文系数', type: 'number', min: 0.5, max: 4, step: 0.1, fallback: 1.5, unit: '×', hint: '整画布/固定上下文时的外扩倍数（区域裁剪不生效）。' },
      { key: 'local.context_pixels', label: '上下文像素', type: 'number', min: 0, max: 512, step: 16, fallback: 96, unit: 'px', hint: '固定外扩像素；不希望裁块太小贴边时调大。' },
    ],
  },
  {
    id: 'seam',
    title: '接缝与羽化',
    note: '接缝按遮罩短边百分比扩展，羽化向遮罩内收，绝不向遮罩外扩。',
    fields: [
      { key: 'local.expand_pct', label: '接缝扩展', type: 'range', min: 0, max: 20, step: 0.5, fallback: 4, unit: '%', hint: '还原时把写入区向外扩的百分比；0 = 严格按遮罩。' },
      { key: 'local.feather_pct', label: '接缝羽化', type: 'range', min: 0, max: 30, step: 0.5, fallback: 5, unit: '%', hint: '扩展区的过渡带宽度（占遮罩短边）。' },
      { key: 'local.feather', label: '羽化像素', type: 'number', min: 0, max: 256, step: 4, fallback: 32, unit: 'px', hint: '合成时遮罩边缘向内羽化的像素数；0 会被当成 32。' },
      { key: 'local.mask_expand', label: '遮罩外扩', type: 'number', min: 0, max: 256, step: 4, fallback: 0, unit: 'px', hint: '把可写入区域向外扩 N 像素；0 = 严格只改选区。' },
      { key: 'local.blend_pixels', label: '过渡带宽度', type: 'number', min: 0, max: 128, step: 4, fallback: 24, unit: 'px', hint: '整画布/原生合成的边界过渡带。' },
      { key: 'local.dither', label: '确定性抖动', type: 'switch', fallback: true, hint: '消除 8bit 舍入造成的色阶断层，幅度 < 1/255，肉眼不可见。' },
    ],
  },
  {
    id: 'blend',
    title: '合成策略',
    note: '区域裁剪最快；整画布上下文最多；原生不做遮罩合成，整图校色。',
    fields: [
      {
        key: 'local.scheme',
        label: '局部策略',
        type: 'select',
        fallback: 'a',
        options: [
          { value: 'auto', label: '自动（按选区面积）' },
          { value: 'b', label: '区域裁剪（快）' },
          { value: 'a', label: '整画布（稳）' },
          { value: 'native', label: '原生（不合遮罩）' },
        ],
        hint: 'auto 在选区占比大时自动切整画布。',
      },
      {
        key: 'local.band_mode',
        label: '过渡带算法',
        type: 'select',
        fallback: 'lowfreq',
        options: [
          { value: 'lowfreq', label: '低频增益（推荐）' },
          { value: 'alpha', label: '仅按 alpha' },
        ],
        hint: '低频增益只修正亮度/色温；仅 alpha 只做透明度混合。',
      },
    ],
  },
  {
    id: 'color',
    title: '色彩还原',
    note: '只在遮罩内与过渡带生效；遮罩外逐像素取原图，不受任何校色影响。',
    fields: [
      { key: 'local.color_match', label: '过渡带校色', type: 'switch', fallback: true, hint: '按过渡带估算 gain/offset，消除接缝色差。' },
      { key: 'local.color_strength', label: '过渡带强度', type: 'range', min: 0, max: 1, step: 0.01, fallback: 0.6, hint: '0 = 不校色；1 = 完全按估算值修正。' },
      { key: 'local.color_restore', label: '区域色彩还原', type: 'switch', fallback: true, hint: '用未变化像素逐通道估算增益，孤海 CropRestore 同款算法。' },
      { key: 'local.color_restore_strength', label: '还原强度', type: 'range', min: 0, max: 1, step: 0.01, fallback: 1, hint: '1 = 完全还原；0 = 只贴图不校色。' },
      { key: 'local.hint', label: '提示图', type: 'readonly', hint: '训练约定：移除=绿色 40% 叠加，扩图=灰边标记，由任务自动决定。' },
    ],
  },
  {
    id: 'consistency',
    title: '一致性 LoRA',
    note: '抑制整体漂移；强度在「采样与 LoRA」区调节。',
    fields: [
      { key: 'local.consistency', label: '启用一致性 LoRA', type: 'switch', fallback: true, hint: '关掉后局部改动更自由，但人物/背景更容易变。' },
    ],
  },
  {
    id: 'preprocess',
    title: '大图预处理',
    note: '长边超过上限时才真正缩小；出图后按接缝记录一次性还原，不二次取整。',
    fields: [
      { key: 'preprocess.enabled', label: '启用预处理', type: 'switch', fallback: true, hint: '关掉后 4K 图更慢，可能爆显存。' },
      { key: 'preprocess.max_side', label: '长边上限', type: 'select', fallback: 2048, numeric: true, options: [1024, 1536, 2048, 2560, 3072], unit: 'px', hint: '超过就等比缩小；越大越清晰也越慢。' },
      { key: 'preprocess.mode', label: '缩放范围', type: 'select', fallback: 'downscale_only', options: RANGE_MODES, hint: '默认只缩小；「缩小 + 放大」会把小图也拉到长边区间。' },
      { key: 'preprocess.min_side', label: '长边下限', type: 'number', min: 256, max: 2048, step: 32, fallback: 768, unit: 'px', hint: '仅在「缩小 + 放大」模式生效。', showIf: (value) => value === 'range' },
      { key: 'preprocess.multiple', label: '对齐倍数', type: 'readonly', hint: '训练约定固定 32，不可改。' },
    ],
  },
  {
    id: 'outpaint',
    title: '扩图',
    note: '百分比相对源图宽 / 高计算；至少一条边 > 0 才能提交，32 对齐由后端保证。',
    fields: [
      { key: 'outpaint.top', label: '上扩', type: 'number', min: 0, max: 300, step: 1, fallback: 0, unit: '%', hint: '向上外补占源图高度的百分比。' },
      { key: 'outpaint.bottom', label: '下扩', type: 'number', min: 0, max: 300, step: 1, fallback: 0, unit: '%', hint: '向下外补占源图高度的百分比。' },
      { key: 'outpaint.left', label: '左扩', type: 'number', min: 0, max: 300, step: 1, fallback: 0, unit: '%', hint: '向左外补占源图宽度的百分比。' },
      { key: 'outpaint.right', label: '右扩', type: 'number', min: 0, max: 300, step: 1, fallback: 0, unit: '%', hint: '向右外补占源图宽度的百分比。' },
      { key: 'outpaint.max_side', label: '最大输出长边', type: 'select', fallback: 5120, numeric: true, options: [2048, 3072, 4096, 5120, 6144, 8192], unit: 'px', hint: '硬上限 8192，超限后端直接拒绝，不静默夹取。' },
    ],
  },
];

const READONLY_NOTE =
  '只读约定：画布宽高必须是 32 倍数、外补色 #808080、移除提示图 绿色 40%、resolution=0。这几项属于训练约定，改了会掉效果。';

function formLabel(key) {
  return `adv-${String(key).replace(/\./g, '-')}`;
}

function fmtNumber(field, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(field.step && field.step < 0.1 ? 2 : 1);
}

function display(field, value) {
  if (field.type === 'readonly') {
    if (field.key === 'local.hint') return HINT_LABELS[value] || String(value ?? 'none');
    if (field.key === 'preprocess.multiple') return '32 倍数';
    return '';
  }
  if (field.type === 'select' && field.options) {
    const hit = field.options.find((item) => (typeof item === 'object' ? item.value === value : item === value));
    if (hit && typeof hit === 'object') return hit.label;
  }
  if (typeof value === 'number') return fmtNumber(field, value);
  return String(value ?? '');
}

const HINT_LABELS = {
  none: '不使用提示图',
  green_overlay: '绿色 40% 叠加（移除）',
  gray_fill: '灰边标记（扩图）',
  green: '绿色 40% 叠加（移除）',
};

function renderControl(field, value) {
  const id = formLabel(field.key);
  if (field.type === 'switch') {
    return `<label class="adv-check-line" for="${id}">
      <input type="checkbox" id="${id}" data-key="${field.key}" ${value ? 'checked' : ''} />
      <span class="adv-name">${escapeHtml(field.label)}</span>
      ${field.unit ? `<span class="adv-unit">${escapeHtml(field.unit)}</span>` : ''}
    </label>`;
  }
  if (field.type === 'select') {
    const options = (field.options || [])
      .map((item) => {
        const option = typeof item === 'object' ? item : { value: item, label: `${item}` };
        const active = String(option.value) === String(value) ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${active}>${escapeHtml(option.label)}</option>`;
      })
      .join('');
    return `<div class="adv-control">
      <select class="select" id="${id}" data-key="${field.key}">${options}</select>
      ${field.unit ? `<span class="adv-suffix">${escapeHtml(field.unit)}</span>` : ''}
    </div>`;
  }
  if (field.type === 'range') {
    return `<div class="adv-range">
      <input type="range" id="${id}" data-key="${field.key}" min="${field.min}" max="${field.max}"
        step="${field.step}" value="${value}" />
      <span class="mono adv-range-val" data-val="${field.key}">${escapeHtml(display(field, value))}${escapeHtml(field.unit || '')}</span>
    </div>`;
  }
  if (field.type === 'readonly') {
    return `<div class="adv-control"><span class="adv-readonly" id="${id}">${escapeHtml(display(field, value) || '—')}</span></div>`;
  }
  return `<div class="adv-control">
    <input class="input mono" id="${id}" type="number" data-key="${field.key}" min="${field.min}"
      max="${field.max}" step="${field.step}" value="${value}" />
    ${field.unit ? `<span class="adv-suffix">${escapeHtml(field.unit)}</span>` : ''}
  </div>`;
}

function renderField(field, value) {
  if (field.showIf && !field.showIf(value)) return '';
  const head =
    field.type === 'switch'
      ? ''
      : `<div class="adv-head"><span class="adv-name">${escapeHtml(field.label)}</span></div>`;
  return `<div class="adv-row" data-row="${field.key}" title="${escapeHtml(field.hint)}">
    ${head}
    ${renderControl(field, value)}
    <button class="adv-reset" type="button" data-reset="${field.key}" title="恢复预设值" hidden>↺</button>
    <div class="adv-hint">${escapeHtml(field.hint)}</div>
  </div>`;
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   getPreset: () => object|null,
 *   getOverrides: () => object,
 *   apply: (overrides: object) => void,
 *   onChange?: () => void,
 * }} options
 */
export function mountAdvanced(host, { getPreset, getOverrides, apply, onChange } = {}) {
  const defaultOpen = new Set(['crop', 'seam']);

  function valueOf(field) {
    return effectiveValue(getPreset(), getOverrides(), field.key, field.fallback);
  }

  function allKeys(group) {
    return group.fields.map((field) => field.key);
  }

  function render() {
    const preset = getPreset();
    if (!preset) {
      host.classList.add('adv-empty');
      host.innerHTML = '<div class="ai-hint">未连接后端，高级参数暂不可用。</div>';
      return;
    }
    host.classList.remove('adv-empty');
    const opened = new Set(
      [...host.querySelectorAll('details[data-group][open]')].map((node) => node.dataset.group),
    );
    const keep = opened.size ? opened : defaultOpen;
    host.innerHTML =
      GROUPS.map((group) => {
        const body = group.fields
          .map((field) => renderField(field, valueOf(field)))
          .join('');
        return `<details class="adv-group" data-group="${group.id}" ${keep.has(group.id) ? 'open' : ''}>
          <summary class="adv-group-head">
            <span class="adv-group-title">${escapeHtml(group.title)}</span>
            <span class="adv-group-count" data-count="${group.id}" hidden></span>
            <button class="adv-group-reset" type="button" data-reset-group="${group.id}"
              title="本组恢复预设值" hidden>↺</button>
          </summary>
          <div class="adv-group-body">
            ${group.note ? `<div class="adv-note">${escapeHtml(group.note)}</div>` : ''}
            ${body}
          </div>
        </details>`;
      }).join('') +
      `<div class="adv-note">${escapeHtml(READONLY_NOTE)}</div>
       <div class="adv-foot">
         <span class="adv-dirty" data-dirty hidden></span>
         <button class="btn ghost sm" type="button" data-reset-all hidden>全部恢复预设值</button>
       </div>`;
    paintChips();
  }

  function paintChips() {
    const preset = getPreset();
    const overrides = getOverrides();
    let dirty = 0;
    for (const group of GROUPS) {
      const keys = allKeys(group);
      const changed = modifiedKeys(preset, overrides).filter((key) => keys.includes(key));
      dirty += changed.length;
      const count = host.querySelector(`[data-count="${group.id}"]`);
      if (count) {
        count.hidden = !changed.length;
        count.textContent = `${changed.length} 项已改`;
      }
      const groupReset = host.querySelector(`[data-reset-group="${group.id}"]`);
      if (groupReset) groupReset.hidden = !changed.length;
    }
    for (const field of GROUPS.flatMap((group) => group.fields)) {
      if (field.type === 'readonly') continue;
      const button = host.querySelector(`[data-reset="${field.key}"]`);
      if (button) button.hidden = !modifiedKeys(preset, overrides).includes(field.key);
    }
    const label = host.querySelector('[data-dirty]');
    const resetAll = host.querySelector('[data-reset-all]');
    if (label) {
      label.hidden = !dirty;
      label.textContent = dirty ? `已改动 ${dirty} 项（生效值 = 预设 + 你的覆盖）` : '';
    }
    if (resetAll) resetAll.hidden = !dirty;
  }

  function commit(key, field, raw) {
    let value = raw;
    if (field.type === 'switch') value = Boolean(raw);
    else if (field.type === 'number' || field.type === 'range') {
      value = Number(raw);
      if (!Number.isFinite(value)) value = field.fallback;
      value = Math.min(field.max, Math.max(field.min, value));
    } else if (field.type === 'select' && field.numeric) {
      value = Number(raw);
    }
    apply(withOverride(getPreset(), getOverrides(), key, value));
    paintChips();
    onChange?.();
  }

  function resetKeys(keys) {
    apply(withoutOverrides(getOverrides(), keys));
    render();
    onChange?.();
  }

  const fieldByKey = new Map(GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field])));

  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-key]');
    if (!input) return;
    const field = fieldByKey.get(input.dataset.key);
    if (field?.type !== 'range') return;
    const label = host.querySelector(`[data-val="${field.key}"]`);
    if (label) label.textContent = `${fmtNumber(field, input.value)}${field.unit || ''}`;
  });

  host.addEventListener('change', (event) => {
    const input = event.target.closest('[data-key]');
    if (!input) return;
    const field = fieldByKey.get(input.dataset.key);
    if (!field || field.type === 'readonly') return;
    const raw = field.type === 'switch' ? input.checked : input.value;
    commit(field.key, field, raw);
    if (field.key === 'preprocess.enabled' || field.key === 'preprocess.max_side' || field.key === 'preprocess.mode') {
      render();
    }
  });

  host.addEventListener('click', (event) => {
    const single = event.target.closest('[data-reset]');
    if (single) {
      resetKeys([single.dataset.reset]);
      return;
    }
    const group = event.target.closest('[data-reset-group]');
    if (group) {
      event.preventDefault();
      event.stopPropagation();
      const hit = GROUPS.find((entry) => entry.id === group.dataset.resetGroup);
      if (hit) resetKeys(allKeys(hit).filter((key) => modifiedKeys(getPreset(), getOverrides()).includes(key)));
      return;
    }
    if (event.target.closest('[data-reset-all]')) {
      resetKeys(modifiedKeys(getPreset(), getOverrides()));
    }
  });

  render();

  return {
    refresh: render,
    isModified: (key) => modifiedKeys(getPreset(), getOverrides()).includes(key),
    valueOf,
  };
}

export { GROUPS as ADVANCED_GROUPS };
