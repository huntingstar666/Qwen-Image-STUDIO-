/** 视图共享：设置表单、画布换算、页头。 */
import {
  $$, escapeHtml, selectField, numberField, checkField, readForm, num, icon,
} from '../ui.js';

export function defaultsFromOptions(options) {
  const d = (options && options.defaults) || {};
  const width = num(d.width, num(d.size, 512)) || 512;
  const height = num(d.height, num(d.size, 512)) || 512;
  return {
    canvas: canvasIdFor(options, width, height),
    width,
    height,
    fps: num(d.fps, 12),
    frames: num(d.frames, 12),
    steps: num(d.steps, 8),
    cfg: num(d.cfg, 1.0),
    denoise: num(d.denoise, 1.0),
    turbo: d.turbo !== false,
    consistency: d.consistency !== false,
    relay: d.relay || 'chain',
    background: d.background || 'auto',
    style: d.style || '',
    seed: 20261107,
    max_retries: num(d.max_retries, 3),
    seamless: false,
    engine: 'mock',
    model: (options && options.defaultModel) || 'qwen',
    preset: '',
    hold: num(d.motion && d.motion.hold, 2),
    motionFps: num(d.motion && d.motion.fps, 8),
    motionPreset: (d.motion && d.motion.preset) || 'both',
    jitter: num(d.motion && d.motion.jitter, 1.2),
    grain: num(d.motion && d.motion.grain, 0.06),
    vignette: num(d.motion && d.motion.vignette, 0.18),
    colorBoil: num(d.motion && d.motion.color_boil, 0.03),
    exportFormat: (d.export && d.export.format) || 'gif',
  };
}

export function canvasIdFor(options, width, height) {
  const presets = (options && options.canvas) || [];
  const match = presets.find((item) => Number(item.width) === Number(width)
    && Number(item.height) === Number(height));
  return match ? match.id : 'custom';
}

/* ---------------------------------------------------------------- 设置行
 * 参考系统设置：一行一个决定，控件在右侧；进阶参数默认折叠。
 * 目的：不要让 8 个输入框同时抢注意力。
 */

export function settingRow({ label, hint = '', control = '', wide = false }) {
  return `<div class="set-row${wide ? ' wide' : ''}">
    <div class="set-row-copy">
      <span class="set-label">${escapeHtml(label)}</span>
      ${hint ? `<span class="set-hint">${escapeHtml(hint)}</span>` : ''}
    </div>
    <div class="set-row-control">${control}</div>
  </div>`;
}

export function stepper({ name, value, min = 0, max = 99, step = 1, unit = '' }) {
  return `<div class="stepper" data-stepper>
    <button class="stepper-btn" type="button" data-step="-1" aria-label="减少">−</button>
    <span class="stepper-value">
      <input type="number" name="${escapeHtml(name)}" value="${escapeHtml(value)}"
        min="${min}" max="${max}" step="${step}" inputmode="numeric">
      ${unit ? `<em>${escapeHtml(unit)}</em>` : ''}
    </span>
    <button class="stepper-btn" type="button" data-step="1" aria-label="增加">+</button>
  </div>`;
}

export function sliderRow({ name, label, hint = '', value, min, max, step = 1, unit = '' }) {
  return `<div class="set-row">
    <div class="set-row-copy">
      <span class="set-label">${escapeHtml(label)}</span>
      ${hint ? `<span class="set-hint">${escapeHtml(hint)}</span>` : ''}
    </div>
    <div class="set-row-control slider-control">
      <input type="range" name="${escapeHtml(name)}" value="${escapeHtml(value)}"
        min="${min}" max="${max}" step="${step}" data-unit="${escapeHtml(unit)}">
      <b class="set-value" data-role="${escapeHtml(name)}Value">${escapeHtml(value)}${escapeHtml(unit)}</b>
    </div>
  </div>`;
}

export function choiceRow({ name, label, hint = '', options = [], value }) {
  return `<div class="set-row wide">
    <div class="set-row-copy">
      <span class="set-label">${escapeHtml(label)}</span>
      ${hint ? `<span class="set-hint">${escapeHtml(hint)}</span>` : ''}
    </div>
    <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">
    <div class="chips" data-choice="${escapeHtml(name)}">
      ${options.map((item) => `<button type="button" class="chip${String(item.id) === String(value) ? ' active' : ''}"
        data-value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`).join('')}
    </div>
  </div>`;
}

export function advancedCard({ title = '引擎与生成参数', meta = '', content = '', open = false }) {
  return `<details class="fold advance"${open ? ' open' : ''}>
    <summary><span>${escapeHtml(title)}</span>${meta ? `<em>${escapeHtml(meta)}</em>` : ''}</summary>
    <div class="advance-body">${content}</div>
  </details>`;
}

/* ---------------------------------------------------------------- 参数胶囊 / 抽屉
 * 对齐主项目文生图：画布区只留「尺寸 / 帧率 / ...」几个胶囊摘要，
 * 点胶囊或齿轮打开右侧参数抽屉，所有输入都在抽屉里。
 */

export function paramPill({ key, label, value }) {
  return `<button class="param-pill" type="button" data-drawer-open aria-expanded="false">
    <span class="param-key">${escapeHtml(label)}</span>
    <span class="param-value" data-pill="${escapeHtml(key)}">${escapeHtml(value)}</span>
  </button>`;
}

export function canvasSummary(options, form) {
  if (form.canvas === 'custom') return `自定义 · ${form.width}×${form.height}`;
  const presets = (options && options.canvas) || [];
  const hit = presets.find((item) => item.id === form.canvas)
    || presets.find((item) => Number(item.width) === Number(form.width)
      && Number(item.height) === Number(form.height));
  if (!hit) return `${form.width}×${form.height}`;
  return `${ratioText(hit.width, hit.height)} · ${hit.width}×${hit.height}`;
}

export function syncPills(root) {
  const set = (key, text) => {
    const target = root.querySelector(`[data-pill="${key}"]`);
    if (target) target.textContent = text;
  };
  const canvasInput = root.querySelector('input[name="canvas"]');
  if (canvasInput) {
    if (canvasInput.value === 'custom') {
      const width = root.querySelector('input[name="width"]');
      const height = root.querySelector('input[name="height"]');
      if (width && height) set('size', `自定义 · ${width.value}×${height.value}`);
    } else {
      const chip = root.querySelector(`.ratio-chip[data-ratio="${canvasInput.value}"]`);
      const main = chip && chip.querySelector('.ratio-text b');
      const sub = chip && chip.querySelector('.ratio-text i');
      if (main) set('size', `${main.textContent} · ${sub ? sub.textContent : ''}`);
    }
  }
  const fps = root.querySelector('input[name="fps"]');
  if (fps) set('fps', `${fps.value} fps`);
  const hold = root.querySelector('input[name="hold"]');
  if (hold) set('hold', `${hold.value} 帧`);
  const frames = root.querySelector('input[name="frames"]');
  if (frames) set('frames', `${frames.value} 帧`);
  const rows = root.querySelector('input[name="rows"]');
  const columns = root.querySelector('input[name="columns"]');
  if (rows && columns) set('grid', `${rows.value} × ${columns.value}`);
}

export function bindDrawer(root) {
  const bench = root.querySelector('[data-role="workbench"]');
  const drawer = root.querySelector('[data-role="drawer"]');
  if (!bench || !drawer) return;
  const setOpen = (open) => {
    bench.classList.toggle('drawer-open', open);
    $$('[data-drawer-open]', bench).forEach((button) => {
      button.setAttribute('aria-expanded', String(open));
    });
  };
  $$('[data-drawer-open]', bench).forEach((button) => {
    button.addEventListener('click', () => setOpen(!bench.classList.contains('drawer-open')));
  });
  const close = drawer.querySelector('[data-drawer-close]');
  if (close) close.addEventListener('click', () => setOpen(false));
  drawer.addEventListener('input', () => syncPills(root));
  drawer.addEventListener('change', () => syncPills(root));
  syncPills(root);
}

export function bindSettingRows(root) {
  $$('[data-stepper]', root).forEach((box) => {
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    const input = box.querySelector('input');
    if (!input) return;
    $$('[data-step]', box).forEach((button) => {
      button.addEventListener('click', () => {
        const step = Number(button.dataset.step) * (Math.abs(Number(input.step)) || 1);
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        const next = Math.min(max, Math.max(min, (Number(input.value) || 0) + step));
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });
  $$('[data-choice]', root).forEach((group) => {
    if (group.dataset.bound) return;
    group.dataset.bound = '1';
    const hidden = root.querySelector(`input[name="${group.dataset.choice}"]`);
    $$('.chip', group).forEach((chip) => {
      chip.addEventListener('click', () => {
        if (!hidden) return;
        hidden.value = chip.dataset.value;
        $$('.chip', group).forEach((item) => item.classList.toggle('active', item === chip));
      });
    });
  });
}

export function engineLabel(options, id) {
  const list = (options && options.engines) || [];
  const hit = list.find((item) => item.id === id);
  if (hit) return hit.name || hit.id;
  return id === 'main' ? '主项目真实生成' : '模拟出图';
}

export function modelLabel(options, id) {
  const list = (options && options.editModels) || [];
  const hit = list.find((item) => item.id === id);
  return hit ? (hit.label || hit.id) : id;
}

function ratioShape(width, height) {
  if (!width || !height) return '<span class="ratio-shape ratio-shape-custom"></span>';
  const scale = 15 / Math.max(width, height);
  return `<span class="ratio-shape" style="width:${Math.max(7, Math.round(width * scale))}px;height:${Math.max(7, Math.round(height * scale))}px"></span>`;
}

function ratioText(width, height) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const div = gcd(width, height) || 1;
  return `${width / div}:${height / div}`;
}

function ratioChip({ id, width, height, current }) {
  return `<button type="button" class="ratio-chip${id === current ? ' active' : ''}" data-ratio="${escapeHtml(id)}">
    ${ratioShape(width, height)}
    <span class="ratio-text">
      <b>${escapeHtml(ratioText(width, height))}</b>
      <i>${width}×${height}</i>
    </span>
  </button>`;
}

export function canvasFields(options, form) {
  const presets = (options && options.canvas) || [];
  const current = form.canvas || canvasIdFor(options, form.width, form.height);
  return `<div class="set-list">
    <div class="set-row wide">
      <div class="set-row-copy">
        <span class="set-label">画布比例</span>
        <span class="set-hint">出图与导出同尺寸</span>
      </div>
      <div class="ratio-chips" data-role="ratioChips">
        <input type="hidden" name="canvas" value="${escapeHtml(current)}">
        ${presets.map((item) => ratioChip({
          id: item.id, width: item.width, height: item.height, current,
        })).join('')}
        <button type="button" class="ratio-chip${current === 'custom' ? ' active' : ''}" data-ratio="custom">
          ${ratioShape(0, 0)}
          <span class="ratio-text"><b>自定义</b><i>宽 × 高</i></span>
        </button>
      </div>
      <div class="ratio-custom${current === 'custom' ? '' : ' hidden'}" data-role="customCanvas">
        ${stepper({ name: 'width', value: form.width, min: 256, max: 1536, step: 32 })}
        <span class="ratio-x">×</span>
        ${stepper({ name: 'height', value: form.height, min: 256, max: 1536, step: 32 })}
      </div>
    </div>
    ${sliderRow({
      name: 'fps', label: '播放帧率', hint: '成片每秒播放的张数',
      value: form.fps, min: 4, max: 30, unit: ' fps',
    })}
  </div>`;
}

export function bindCanvas(root) {
  const input = root.querySelector('input[name="canvas"]');
  if (!input) return;
  const custom = root.querySelector('[data-role="customCanvas"]');
  const chips = $$('[data-role="ratioChips"] [data-ratio]', root);
  const sync = () => {
    if (custom) custom.classList.toggle('hidden', input.value !== 'custom');
    chips.forEach((chip) => chip.classList.toggle('active', chip.dataset.ratio === input.value));
  };
  chips.forEach((chip) => {
    if (chip.dataset.bound) return;
    chip.dataset.bound = '1';
    chip.addEventListener('click', () => {
      input.value = chip.dataset.ratio;
      sync();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  sync();
}

export function modelFields(options, form) {
  const models = (options && options.editModels) || [];
  const modelOptions = models.length
    ? models.map((item) => ({ id: item.id, label: item.label || item.id }))
    : [{ id: 'qwen', label: 'Qwen-Image' }];
  const presets = (options && options.presets) || [];
  const presetOptions = [{ id: '', label: '默认（不锁形态）' }]
    .concat(presets.map((item) => ({ id: item.id, label: item.label || item.id })));
  const engines = (options && options.engines) || [
    { id: 'mock', name: '模拟出图' },
    { id: 'main', name: '主项目真实生成' },
  ];
  return `
    <div class="field-grid">
      ${selectField({ name: 'engine', label: '生成引擎', options: engines.map((item) => ({ id: item.id, label: item.name || item.id })), value: form.engine })}
      ${selectField({ name: 'model', label: '编辑模型', options: modelOptions, value: form.model })}
    </div>
    <div class="field-grid" style="margin-top:9px">
      ${selectField({ name: 'preset', label: '编辑预设', options: presetOptions, value: form.preset })}
      ${selectField({ name: 'style', label: '手作材质', options: (options && options.styles) || [], value: form.style })}
    </div>
    <p class="mini" style="margin-top:6px">${form.engine === 'main'
      ? '主项目真实生成需要 8700 在线；连续出图时偶发进程退出，工作台会自动等待并重试。'
      : '模拟引擎只验证分镜、自检、轨道与导出，不消耗显存。'}</p>
  `;
}

export function generationFields(options, form, { fold = true } = {}) {
  const relays = (options && options.relay) || [
    { id: 'chain', label: '连续接力' }, { id: 'independent', label: '独立出图' },
  ];
  const backgrounds = (options && options.background) || [
    { id: 'auto', label: '自动' }, { id: 'plain', label: '整幅重绘' }, { id: 'fixed', label: '固定背景' },
  ];
  const body = `
      <div class="stack" style="margin-top:${fold ? 10 : 0}px">
        <div class="field-grid three">
          ${numberField({ name: 'steps', label: '步数', value: form.steps, min: 1, max: 100 })}
          ${numberField({ name: 'cfg', label: 'CFG', value: form.cfg, min: 0, max: 30, step: 0.1 })}
          ${numberField({ name: 'denoise', label: '降噪', value: form.denoise, min: 0.05, max: 1, step: 0.05 })}
        </div>
        <div class="field-grid">
          ${selectField({ name: 'relay', label: '接力方式', options: relays.map((item) => ({ id: item.id, label: item.label })), value: form.relay })}
          ${selectField({ name: 'background', label: '背景策略', options: backgrounds.map((item) => ({ id: item.id, label: item.label })), value: form.background })}
        </div>
        <div class="field-grid">
          ${numberField({ name: 'seed', label: '随机种子', value: form.seed, min: -1, max: 2147483647 })}
          ${numberField({ name: 'max_retries', label: '单帧重试', value: form.max_retries, min: 1, max: 5 })}
        </div>
        <div class="stack" style="gap:7px">
          ${checkField({ name: 'turbo', label: 'Turbo 加速（8 步左右）', checked: form.turbo })}
          ${checkField({ name: 'consistency', label: '一致性 LoRA（成长/变形请关闭）', checked: form.consistency })}
          ${checkField({ name: 'seamless', label: '首尾闭环（末帧回到首帧）', checked: form.seamless })}
        </div>
      </div>`;
  if (!fold) return body;
  return `<details class="fold"><summary>生成参数</summary>${body}</details>`;
}

export function readSettings(root, options, base) {
  const form = readForm(root);
  const presets = (options && options.canvas) || [];
  const preset = presets.find((item) => item.id === form.canvas);
  const width = form.canvas === 'custom'
    ? num(form.width, base.width) : num(preset && preset.width, base.width);
  const height = form.canvas === 'custom'
    ? num(form.height, base.height) : num(preset && preset.height, base.height);
  const pick = (value, fallback) => (value === undefined || value === null || value === ''
    ? fallback : value);
  return {
    ...base,
    size: Math.max(width, height),
    width,
    height,
    frames: pick(form.frames, base.frames),
    steps: pick(form.steps, base.steps),
    cfg: pick(form.cfg, base.cfg),
    denoise: pick(form.denoise, base.denoise),
    turbo: form.turbo === undefined ? base.turbo : Boolean(form.turbo),
    consistency: form.consistency === undefined ? base.consistency : Boolean(form.consistency),
    relay: form.relay || base.relay,
    background: form.background || base.background,
    style: form.style === undefined ? base.style : form.style,
    seed: pick(form.seed, base.seed),
    max_retries: pick(form.max_retries, base.max_retries),
    seamless: form.seamless === undefined ? base.seamless : Boolean(form.seamless),
    engine: form.engine || base.engine,
    model: form.model || base.model,
    preset: form.preset === undefined ? base.preset : form.preset,
    timeline: {
      fps: pick(form.fps, base.fps),
      holds: (base.timeline && base.timeline.holds) || [],
    },
    motion: {
      preset: base.motionPreset || 'both',
      fps: num(base.motionFps, 8),
      hold: pick(form.hold, base.hold),
      jitter: num(base.jitter, 1.2),
      grain: num(base.grain, 0.06),
      vignette: num(base.vignette, 0.18),
      color_boil: num(base.colorBoil, 0.03),
    },
    export: {
      format: base.exportFormat || 'gif',
      dither: true,
      align: false,
      color_match: false,
    },
  };
}

export function pageHead({ kicker = '', title, sub = '', actions = '' }) {
  return `<div class="page-head">
    <div class="page-head-copy">
      <h1 class="page-title">${escapeHtml(title)}</h1>
      ${sub ? `<p class="page-sub">${escapeHtml(sub)}</p>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;
}

export function emptyState({ iconName = 'film', title, text, actions = '', features = '' }) {
  return `<div class="panel"><div class="empty-state">
    <div class="empty-glyph">${icon(iconName, 24)}</div>
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(text)}</p>
    ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
    ${features ? `<div class="feature-grid">${features}</div>` : ''}
  </div></div>`;
}

export function featureCard(iconName, title, text) {
  return `<div class="feature-card"><div class="feature-icon">${icon(iconName, 16)}</div>
    <strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`;
}

export function settingsSummary(options) {
  return {
    models: ((options && options.editModels) || []).map((item) => item.label || item.id),
  };
}
