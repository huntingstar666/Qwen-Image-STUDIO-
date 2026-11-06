/**
 * 可复用表单控件：
 * - TurboControl：Turbo 开关 + 加速预设（调度 / 加速 LoRA / 底模全部由预设决定）；
 * - LoraPicker：LoRA 多选 + 强度；
 * - ModelsField：unet / clip / vae 三个模型下拉。
 * 文生图页与图像编辑页共用，避免参数逻辑两处各写一份。
 */

import { escapeHtml } from '../utils.js';

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
 * LoRA 多选
 * ============================================================ */
export class LoraPicker {
  /**
   * @param {HTMLElement} host
   * @param {{loras?: Array<object|string>, initial?: Record<string, number>}} options
   */
  constructor(host, { loras = [], initial = {} } = {}) {
    this.host = host;
    this.loras = (loras || []).map((item) => {
      if (typeof item === 'string') return { name: item, label: item, sizeGb: null };
      const name = item.value ?? item.name ?? String(item);
      return { name, label: item.label || name, sizeGb: item.size_gb ?? item.sizeGb ?? null };
    });
    this.selected = { ...(initial || {}) };
    this.render();
  }

  render() {
    if (!this.loras.length) {
      this.host.innerHTML = '<div class="empty" style="padding:14px 8px"><div>后端未返回 LoRA 列表，可在 /api/options 里检查 models.lora</div></div>';
      this.refs = { rows: [] };
      return;
    }
    this.host.innerHTML = `<div class="lora-list">${this.loras
      .map((lora, index) => {
        const active = Object.prototype.hasOwnProperty.call(this.selected, lora.name);
        const strength = active ? Number(this.selected[lora.name]) : 1;
        return `
          <div class="lora-row ${active ? '' : 'off'}" data-index="${index}">
            <input type="checkbox" data-role="check" ${active ? 'checked' : ''} aria-label="启用 ${escapeHtml(lora.label)}" />
            <span class="lora-name" title="${escapeHtml(`${lora.label}${lora.sizeGb ? ` · ${lora.sizeGb} GB` : ''}`)}">${escapeHtml(lora.label)}</span>
            <input class="range lora-strength" type="range" min="0" max="2" step="0.05" value="${strength}" ${active ? '' : 'disabled'} aria-label="强度" />
            <span class="lora-value mono">${strength.toFixed(2)}</span>
          </div>`;
      })
      .join('')}</div>`;

    this.refs = { rows: [...this.host.querySelectorAll('.lora-row')] };
    this.refs.rows.forEach((row, index) => {
      const lora = this.loras[index];
      const check = row.querySelector('[data-role="check"]');
      const range = row.querySelector('.lora-strength');
      const valueEl = row.querySelector('.lora-value');
      check.addEventListener('change', () => {
        row.classList.toggle('off', !check.checked);
        range.disabled = !check.checked;
        if (check.checked) this.selected[lora.name] = Number(range.value);
        else delete this.selected[lora.name];
      });
      range.addEventListener('input', () => {
        valueEl.textContent = Number(range.value).toFixed(2);
        if (check.checked) this.selected[lora.name] = Number(range.value);
      });
    });
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

/* ============================================================
 * 模型选择
 * ============================================================ */
export class ModelsField {
  /**
   * @param {HTMLElement} host
   * @param {{models?: object, initial?: {unet?:string, clip?:string, vae?:string}}} options
   */
  constructor(host, { models = {}, initial = {} } = {}) {
    this.host = host;
    this.models = models || {};
    this.initial = { ...(initial || {}) };
    this.render();
  }

  render() {
    const groups = [
      ['unet', '扩散模型 UNET'],
      ['clip', '文本编码器 CLIP'],
      ['vae', 'VAE'],
    ];
    this.host.innerHTML = `<div class="model-selects">${groups
      .map(([key, label]) => {
        const list = normalizeModelList(this.models[key]);
        const current = this.initial[key] || '';
        const values = list.map((item) => item.value ?? item.name ?? String(item));
        const options = list
          .map((item) => {
            const value = item.value ?? item.name ?? String(item);
            const text = item.label || value;
            const size = item.size_gb ? ` · ${item.size_gb}GB` : '';
            return `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(text + size)}</option>`;
          })
          .join('');
        // 当前值不在扫描列表里（例如默认路径已失效）时，也保留成一个选中项，避免静默切到列表第一项
        const fallbackOption =
          current && !values.includes(current)
            ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（当前值）</option>`
            : current
              ? ''
              : '<option value="">（后端默认）</option>';
        return `
          <label class="field">
            <span class="field-label">${label}</span>
            <select class="select mono" data-role="${key}">
              ${fallbackOption}
              ${options || '<option value="">（未返回模型列表）</option>'}
            </select>
          </label>`;
      })
      .join('')}</div>`;
    this.host.querySelectorAll('select[data-role]').forEach((select) => {
      if (!select.value && this.initial[select.dataset.role]) select.value = this.initial[select.dataset.role];
    });
  }

  getValue() {
    const value = {};
    this.host.querySelectorAll('select[data-role]').forEach((select) => {
      value[select.dataset.role] = select.value;
    });
    return value;
  }

  /** 只改某个下拉的选中值（不重建 DOM，避免丢失事件监听）。 */
  setKey(key, value) {
    if (value == null) return;
    const select = this.host.querySelector(`select[data-role="${key}"]`);
    if (!select) return;
    if ([...select.options].some((option) => option.value === String(value))) {
      select.value = String(value);
    }
  }

  setDisabled(key, disabled) {
    const select = this.host.querySelector(`select[data-role="${key}"]`);
    if (select) select.disabled = Boolean(disabled);
  }

  setValue(initial = {}) {
    this.initial = { ...(initial || {}) };
    this.render();
  }
}

function normalizeModelList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === 'string' ? { value: item, label: item } : item));
}
