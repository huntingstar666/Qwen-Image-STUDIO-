/**
 * 可复用表单控件：
 * - TurboControl：Turbo 开关 + 加速预设（调度 / 加速 LoRA / 底模全部由预设决定）；
 * - LoraPicker：LoRA 多选 + 强度；
 * - ModelsSummary：unet / clip / vae 的只读摘要（跟随系统设置里的默认模型）。
 * 文生图页与图像编辑页共用，避免参数逻辑两处各写一份。
 */

import { escapeHtml } from '../utils.js';
import { openModal } from './modal.js';

/* ============================================================
 * Turbo 加速预设
 * ============================================================ */
export class TurboControl {
  /**
   * @param {HTMLElement} host
   * @param {{profiles?: Array<object>, initial?: object, defaultProfile?: string, onChange?: Function}} options
   */
  constructor(host, { profiles = [], initial = {}, defaultProfile = '', onChange } = {}) {
    this.host = host;
    this.profiles = (profiles || []).map((profile) => ({
      id: profile.id,
      label: profile.label || profile.id,
      kind: profile.kind || (profile.lora ? 'lora' : 'none'),
      steps: profile.steps,
      cfg: profile.cfg,
      sampler: profile.sampler,
      scheduler: profile.scheduler,
      lora: profile.lora || null,
      unet: profile.unet || null,
      note: profile.note || '',
    }));
    this.onChange = onChange;
    this.defaultProfile = defaultProfile || this.profiles[0]?.id || '';
    this.value = {
      enabled: Boolean(initial.enabled),
      profile: initial.profile || '',
    };
    this.render();
  }

  render() {
    const enabled = this.value.enabled;
    this.host.innerHTML = `
      <div class="field">
        <label class="switch">
          <input type="checkbox" data-ref="toggle" ${enabled ? 'checked' : ''} />
          <span class="switch-track"></span>
          <span class="switch-label">Turbo 加速
            <small>按预设自动切换调度 / 加速 LoRA / 底模</small>
          </span>
        </label>
      </div>
      <div class="turbo-box ${enabled ? '' : 'hidden'}" data-ref="box">
        <div class="turbo-head">
          <span class="badge-mini">TURBO</span>
          <span>加速预设 · 开启时自动沿用上次选择</span>
        </div>
        <div class="field">
          <span class="field-label">加速方案</span>
          <select class="select" data-ref="profile"></select>
        </div>
        <div class="turbo-note turbo-action" data-ref="action"></div>
        <div class="turbo-note" data-ref="note"></div>
      </div>`;

    this.refs = {
      toggle: this.host.querySelector('[data-ref="toggle"]'),
      box: this.host.querySelector('[data-ref="box"]'),
      profile: this.host.querySelector('[data-ref="profile"]'),
      action: this.host.querySelector('[data-ref="action"]'),
      note: this.host.querySelector('[data-ref="note"]'),
    };

    this.renderProfiles();

    this.refs.toggle.addEventListener('change', () => {
      this.value.enabled = this.refs.toggle.checked;
      this.refs.box.classList.toggle('hidden', !this.value.enabled);
      this.emitChange();
    });
    this.refs.profile.addEventListener('change', () => {
      this.value.profile = this.refs.profile.value;
      this.renderDetail();
      this.emitChange();
    });
  }

  renderProfiles() {
    const select = this.refs.profile;
    if (!this.profiles.length) {
      select.innerHTML = '<option value="">后端未返回加速预设</option>';
      select.disabled = true;
      this.refs.action.textContent = '服务未就绪：无法获取 Turbo 加速预设。';
      this.refs.note.textContent = '';
      return;
    }
    select.disabled = false;
    select.innerHTML = this.profiles
      .map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</option>`)
      .join('');
    // 优先用上次选择；没有则用后端默认；都无效时用第一个
    const target =
      this.profiles.find((profile) => profile.id === this.value.profile) ||
      this.profiles.find((profile) => profile.id === this.defaultProfile) ||
      this.profiles[0];
    this.value.profile = target.id;
    select.value = target.id;
    this.renderDetail();
  }

  renderDetail() {
    const profile = this.selectedProfile();
    if (!profile) return;
    const parts = [];
    let missing = false;
    if (profile.kind === 'ckpt' && profile.unet) {
      parts.push(`自动切换底模：${profile.unet.file}`);
      missing = Boolean(profile.unet.missing);
    } else if (profile.lora) {
      const strength = profile.lora.strength != null ? ` @ ${profile.lora.strength}` : '';
      parts.push(`自动挂载加速 LoRA：${profile.lora.file}${strength}`);
      missing = Boolean(profile.lora.missing);
    } else {
      parts.push('不挂加速 LoRA');
    }
    const sampling = [
      profile.steps ? `${profile.steps} 步` : '',
      profile.cfg != null ? `CFG ${profile.cfg}` : '',
      profile.sampler || '',
      profile.scheduler ? `· ${profile.scheduler}` : '',
    ].filter(Boolean).join(' · ');

    this.refs.action.textContent = missing ? `${parts.join('')}（文件缺失）` : parts.join('');
    this.refs.action.classList.toggle('turbo-missing', missing);
    this.refs.note.textContent = [
      sampling,
      profile.note,
      '其他 LoRA 仍可在下方按需加载；加速 LoRA 只会挂载预设指定的这一个。',
    ].filter(Boolean).join(' · ');
  }

  emitChange() {
    this.onChange?.({ ...this.getValue() });
  }

  /** @returns {{enabled:boolean, profile:string}} */
  getValue() {
    return {
      enabled: Boolean(this.refs.toggle?.checked),
      profile: this.refs.profile?.value || this.value.profile || '',
    };
  }

  selectedProfile() {
    return this.profiles.find((profile) => profile.id === this.getValue().profile) || null;
  }

  /** 由外部（输入框 pill）切换 Turbo 开关，保持内部开关与侧栏展示同步。 */
  setEnabled(enabled) {
    this.value.enabled = Boolean(enabled);
    if (this.refs?.toggle) this.refs.toggle.checked = this.value.enabled;
    this.refs?.box?.classList.toggle('hidden', !this.value.enabled);
    this.emitChange();
  }

  setValue(initial = {}) {
    this.value = {
      enabled: Boolean(initial.enabled),
      profile: initial.profile || '',
    };
    this.render();
  }
}

/* ============================================================
 * LoRA 选择：按需添加，只显示已添加的条目
 * ============================================================ */
export class LoraPicker {
  /**
   * @param {HTMLElement} host
   * @param {{loras?: Array<object|string>, initial?: Record<string, number>}} options
   */
  constructor(host, { loras = [], initial = {} } = {}) {
    this.host = host;
    this.loras = (loras || []).map((item) => {
      if (typeof item === 'string') {
        return { name: item, label: item, short: loraShortName(item), folder: loraFolder(item), sizeGb: null };
      }
      const name = item.value ?? item.name ?? String(item);
      return {
        name,
        label: item.label || name,
        short: loraShortName(item.label || name),
        folder: loraFolder(name),
        sizeGb: item.size_gb ?? item.sizeGb ?? null,
      };
    });
    this.selected = { ...(initial || {}) };
    this.render();
  }

  metaOf(name) {
    return (
      this.loras.find((item) => item.name === name) || {
        name,
        label: name,
        short: loraShortName(name),
        folder: loraFolder(name),
        sizeGb: null,
      }
    );
  }

  render() {
    const entries = Object.entries(this.selected);
    const rows = entries
      .map(([name, raw]) => {
        const meta = this.metaOf(name);
        const strength = Number(raw);
        const title = meta.folder ? `${meta.folder} / ${meta.label}` : meta.label;
        return `
          <div class="lora-row" data-name="${escapeHtml(name)}">
            <span class="lora-name" title="${escapeHtml(title)}">${escapeHtml(meta.short)}</span>
            <input class="range lora-strength" type="range" min="0" max="2" step="0.05" value="${strength}"
              aria-label="${escapeHtml(meta.short)} 强度" />
            <span class="lora-value mono">${strength.toFixed(2)}</span>
            <button class="lora-remove" type="button" title="移除" aria-label="移除 ${escapeHtml(meta.short)}">×</button>
          </div>`;
      })
      .join('');

    this.host.innerHTML = `
      <div class="lora-picker">
        ${
          entries.length
            ? `<div class="lora-list">${rows}</div>`
            : '<div class="lora-empty">还没有添加 LoRA，点击下方按钮从目录中挑选</div>'
        }
        <button class="lora-add" type="button" ${this.loras.length ? '' : 'disabled'}>＋ 新增 LoRA</button>
        ${this.loras.length ? '' : '<div class="field-hint">后端未返回 LoRA 列表，请检查模型目录配置</div>'}
      </div>`;

    this.host.querySelector('.lora-add')?.addEventListener('click', () => this.openPicker());

    this.host.querySelectorAll('.lora-row').forEach((row) => {
      const name = row.dataset.name;
      const range = row.querySelector('.lora-strength');
      const valueEl = row.querySelector('.lora-value');
      range.addEventListener('input', () => {
        valueEl.textContent = Number(range.value).toFixed(2);
        this.selected[name] = Number(range.value);
      });
      row.querySelector('.lora-remove').addEventListener('click', () => {
        delete this.selected[name];
        this.render();
        this.emit();
      });
    });
  }

  /** 从 LoRA 目录里挑一个加入列表 */
  openPicker() {
    const available = this.loras.filter((item) => !(item.name in this.selected));
    const content = document.createElement('div');
    content.className = 'lora-picker-body';
    content.innerHTML = `
      <input class="input lora-search" type="search" placeholder="搜索 LoRA 名称或目录…" />
      <div class="lora-catalog"></div>`;
    const list = content.querySelector('.lora-catalog');
    const search = content.querySelector('.lora-search');

    const paint = (keyword = '') => {
      const kw = keyword.trim().toLowerCase();
      const items = available.filter(
        (item) =>
          !kw ||
          item.label.toLowerCase().includes(kw) ||
          item.short.toLowerCase().includes(kw) ||
          item.folder.toLowerCase().includes(kw)
      );
      if (!items.length) {
        list.innerHTML = '<div class="lora-empty">没有可添加的 LoRA</div>';
        return;
      }
      list.innerHTML = items
        .map(
          (item) => `
          <button class="lora-catalog-row" type="button" data-name="${escapeHtml(item.name)}">
            <span class="lora-catalog-main">
              <span class="lora-catalog-name">${escapeHtml(item.short)}</span>
              ${item.folder ? `<span class="lora-catalog-sub">${escapeHtml(item.folder)}</span>` : ''}
            </span>
            ${item.sizeGb ? `<span class="lora-catalog-size mono">${item.sizeGb} GB</span>` : ''}
          </button>`
        )
        .join('');
    };
    paint();
    search.addEventListener('input', () => paint(search.value));

    const modal = openModal({
      title: '选择 LoRA',
      subtitle: '从 LoRA 目录中挑一个加入本次生成',
      content,
      dialogClass: 'lora-picker-modal',
      hideFooter: true,
    });

    list.addEventListener('click', (event) => {
      const btn = event.target.closest('.lora-catalog-row');
      if (!btn) return;
      const name = btn.dataset.name;
      if (!(name in this.selected)) this.selected[name] = 1;
      modal.close();
      this.render();
      this.emit();
    });
  }

  /** 让外层的 change 监听拿到最新值 */
  emit() {
    this.host.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** @returns {Array<{name:string, strength:number}>} */
  getValue() {
    return Object.entries(this.selected).map(([name, strength]) => ({ name, strength: Number(strength) }));
  }

  setValue(value = {}) {
    this.selected = { ...(value || {}) };
    this.render();
  }
}

/** 只保留文件名，去掉扩展名 */
function loraShortName(value) {
  const base = String(value || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
}

/** 文件名所在的目录 */
function loraFolder(value) {
  const parts = String(value || '').split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

/* ============================================================
 * 模型摘要（只读：跟随系统设置里的默认模型）
 * ============================================================ */

const MODEL_ROWS = [
  ['unet', '扩散模型 UNET'],
  ['clip', '文本编码器 CLIP'],
  ['vae', 'VAE'],
];

export class ModelsSummary {
  /**
   * @param {HTMLElement} host
   * @param {{slots?: object}} options
   */
  constructor(host, { slots = {} } = {}) {
    this.host = host;
    this.slots = slots || {};
    this.render();
  }

  render() {
    const rows = MODEL_ROWS.map(([key, label]) => {
      const value = this.slots[key] || '';
      const text = value || '未找到默认模型，请在系统设置中选择';
      return `
        <div class="field">
          <span class="field-label">${label}</span>
          <div class="model-path mono" title="${escapeHtml(value)}">${escapeHtml(text)}</div>
        </div>`;
    }).join('');
    this.host.innerHTML = `
      <div class="model-selects">
        ${rows}
        <div class="model-summary-note">跟随系统默认 · 在「设置 → 默认模型」中修改</div>
      </div>`;
  }

  setValue(slots = {}) {
    this.slots = slots || {};
    this.render();
  }
}
