/**
 * 可复用表单控件：
 * - TurboControl：Turbo 开关 + turbo_profiles 方案 + 8 段 sigma 可编辑文本；
 * - LoraPicker：LoRA 多选 + 强度；
 * - ModelsField：unet / clip / vae 三个模型下拉。
 * 文生图页与图像编辑页共用，避免参数逻辑两处各写一份。
 */

import { escapeHtml } from '../utils.js';

/* ============================================================
 * Turbo 采样调度
 * ============================================================ */
export class TurboControl {
  /**
   * @param {HTMLElement} host
   * @param {{profiles?: Array<object>, loras?: Array<object>, initial?: object, onChange?: Function}} options
   */
  constructor(host, { profiles = [], loras = [], initial = {}, onChange, help = '' } = {}) {
    this.host = host;
    this.profiles = profiles;
    this.loras = (loras || []).map((item) => {
      if (typeof item === 'string') return { name: item, label: item, sizeGb: null, compatible: true, default: false };
      return {
        name: item.value ?? item.name ?? String(item),
        label: item.label || item.value || String(item),
        sizeGb: item.size_gb ?? item.sizeGb ?? null,
        compatible: item.compatible !== false,
        default: Boolean(item.default),
      };
    });
    this.onChange = onChange;
    this.help = help;
    this.value = {
      enabled: Boolean(initial.enabled),
      profile: initial.profile || '',
      sigmas: initial.sigmas || '',
      lora: initial.lora ?? null,
      loraStrength: initial.loraStrength ?? null,
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
            <small>官方保存的 sigma 调度 · cfg 1.0 · euler</small>
          </span>
        </label>
      </div>
      <div class="turbo-box ${enabled ? '' : 'hidden'}" data-ref="box">
        <div class="turbo-head">
          <span class="badge-mini">TURBO</span>
          <span>官方保存的采样调度（sigma 可编辑）</span>
        </div>
        <div class="field">
          <span class="field-label">调度方案 <span class="tag-hint" data-ref="profileCount"></span></span>
          <select class="select" data-ref="profile"></select>
        </div>
        <div class="field">
          <span class="field-label">加速 LoRA <span class="tag-hint" data-ref="loraHint"></span></span>
          <select class="select" data-ref="lora"></select>
        </div>
        <div class="field" data-ref="loraStrengthField">
          <span class="field-label">LoRA 强度 <span class="tag-hint" data-ref="loraStrengthVal">1.0</span></span>
          <input class="range" type="range" min="0" max="1.5" step="0.05" data-ref="loraStrength" />
        </div>
        <div class="field">
          <span class="field-label">sigma 列表 <span class="tag-hint">逗号分隔 · 末尾 0.0 由引擎追加</span></span>
          <textarea class="textarea mono turbo-sigmas" data-ref="sigmas" spellcheck="false"
            placeholder="1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568"></textarea>
        </div>
        <div class="turbo-note" data-ref="help"></div>
        <div class="turbo-note" data-ref="note"></div>
      </div>`;

    this.refs = {
      toggle: this.host.querySelector('[data-ref="toggle"]'),
      box: this.host.querySelector('[data-ref="box"]'),
      profile: this.host.querySelector('[data-ref="profile"]'),
      sigmas: this.host.querySelector('[data-ref="sigmas"]'),
      note: this.host.querySelector('[data-ref="note"]'),
      help: this.host.querySelector('[data-ref="help"]'),
      profileCount: this.host.querySelector('[data-ref="profileCount"]'),
      lora: this.host.querySelector('[data-ref="lora"]'),
      loraHint: this.host.querySelector('[data-ref="loraHint"]'),
      loraStrength: this.host.querySelector('[data-ref="loraStrength"]'),
      loraStrengthVal: this.host.querySelector('[data-ref="loraStrengthVal"]'),
      loraStrengthField: this.host.querySelector('[data-ref="loraStrengthField"]'),
    };
    if (this.help) this.refs.help.textContent = this.help;
    this.refs.sigmas.value = this.value.sigmas || '';
    this.renderProfiles();
    this.renderLoras();
    this.refs.toggle.addEventListener('change', () => {
      this.value.enabled = this.refs.toggle.checked;
      this.refs.box.classList.toggle('hidden', !this.value.enabled);
      if (this.value.enabled && !this.refs.sigmas.value.trim()) this.applyFirstProfile();
      this.emitChange();
    });
    this.refs.profile.addEventListener('change', () => {
      this.applyProfile(this.refs.profile.value);
      this.emitChange();
    });
    this.refs.lora.addEventListener('change', () => {
      this.value.lora = this.refs.lora.value;
      this.syncLoraStrengthField();
      this.renderNote(this.selectedProfile());
      this.emitChange();
    });
    this.refs.loraStrength.addEventListener('input', () => {
      this.value.loraStrength = Number(this.refs.loraStrength.value);
      this.refs.loraStrengthVal.textContent = this.value.loraStrength.toFixed(2);
      this.emitChange();
    });
    this.refs.sigmas.addEventListener('input', () => {
      this.value.sigmas = this.refs.sigmas.value;
      this.emitChange({ sigmasEdited: true });
    });
  }

  /** 加速 LoRA 下拉：默认项、全部候选、以及「不挂」 */
  renderLoras() {
    const options = this.loras || [];
    const current = this.value.lora;
    const rows = [];
    rows.push('<option value="none">不挂加速 LoRA（用基座 + 官方 sigma）</option>');
    for (const item of options) {
      const size = item.sizeGb != null ? ` · ${item.sizeGb}GB` : '';
      const flags = [item.compatible ? '' : '不兼容', item.default ? '默认' : ''].filter(Boolean).join(' · ');
      rows.push(
        `<option value="${escapeHtml(item.name)}" ${item.compatible ? '' : 'disabled'}>` +
          `${escapeHtml(item.label)}${size}${flags ? `（${flags}）` : ''}</option>`,
      );
    }
    if (!options.length) rows.push('<option value="none">后端未返回加速 LoRA 候选</option>');
    this.refs.lora.innerHTML = rows.join('');

    let picked = current;
    if (picked == null) {
      // 未指定：跟随档位默认，再退回 config 默认，最后不挂
      const profile = this.selectedProfile();
      picked = profile?.lora_name
        || options.find((item) => item.default)?.name
        || 'none';
    }
    const exists = [...this.refs.lora.options].some((opt) => opt.value === picked && !opt.disabled);
    this.refs.lora.value = exists ? picked : 'none';
    this.value.lora = this.refs.lora.value;
    this.syncLoraStrengthField();
  }

  syncLoraStrengthField() {
    const off = this.refs.lora.value === 'none';
    this.refs.loraStrengthField.classList.toggle('hidden', off);
    const strength = this.value.loraStrength ?? 1.0;
    this.refs.loraStrength.value = String(strength);
    this.refs.loraStrengthVal.textContent = Number(strength).toFixed(2);
    const selected = this.loras.find((item) => item.name === this.refs.lora.value);
    this.refs.loraHint.textContent = off
      ? '不挂 LoRA'
      : selected?.sizeGb != null
        ? `${selected.sizeGb}GB${selected.sizeGb >= 4 ? ' · 加载慢、占内存/显存' : ''}`
        : '';
  }

  renderProfiles() {
    const profiles = this.profiles || [];
    this.refs.profileCount.textContent = `${profiles.length} 个方案`;
    if (!profiles.length) {
      this.refs.profile.innerHTML = '<option value="">后端未返回 turbo_profiles</option>';
      this.refs.note.textContent = '服务未就绪或未配置 turbo_profiles；仍可手动填写 sigma 并开启 Turbo。';
      return;
    }
    this.refs.profile.innerHTML = profiles
      .map((profile) => {
        const id = profile.id ?? profile.value ?? profile.label;
        return `<option value="${escapeHtml(id)}">${escapeHtml(profile.label || id)}</option>`;
      })
      .join('');
    const target = profiles.find((p) => String(p.id ?? p.value) === String(this.value.profile)) || profiles[0];
    this.refs.profile.value = String(target.id ?? target.value);
    if (!this.value.sigmas) {
      this.refs.sigmas.value = sigmasText(target.sigmas);
      this.value.sigmas = this.refs.sigmas.value;
    }
    this.renderNote(target);
  }

  applyFirstProfile() {
    const first = this.profiles?.[0];
    if (!first) return;
    this.applyProfile(first.id ?? first.value);
  }

  applyProfile(profileId) {
    const profile = (this.profiles || []).find((p) => String(p.id ?? p.value) === String(profileId));
    if (!profile) return;
    this.value.profile = String(profileId);
    const sigmas = sigmasText(profile.sigmas);
    this.refs.sigmas.value = sigmas;
    this.value.sigmas = sigmas;
    // 换档位时同步该档位的默认加速 LoRA（用户仍可在下拉里改）
    if (profile.lora === false) {
      this.value.lora = 'none';
    } else if (typeof profile.lora_name === 'string' && profile.lora_name) {
      this.value.lora = profile.lora_name;
    }
    if (profile.strength != null) this.value.loraStrength = Number(profile.strength);
    this.renderLoras();
    this.renderNote(profile);
  }

  renderNote(profile) {
    if (!profile) return;
    const parts = [];
    if (profile.steps) parts.push(`步数 ${profile.steps}`);
    if (profile.cfg != null) parts.push(`CFG ${profile.cfg}`);
    if (profile.sampler) parts.push(`采样器 ${profile.sampler}`);
    if (typeof profile.lora === 'string' && profile.lora) {
      parts.push(`LoRA ${profile.lora}${profile.strength != null ? ` @ ${profile.strength}` : ''}`);
    } else if (profile.lora === true) {
      parts.push(`自动挂载 Turbo LoRA${profile.strength != null ? ` @ ${profile.strength}` : ''}`);
    }
    if (profile.note) parts.push(profile.note);
    this.refs.note.textContent = parts.join(' · ') || '使用官方保存的 sigma 调度。';
  }

  emitChange(extra = {}) {
    this.onChange?.({ ...this.getValue(), ...extra });
  }

  /** @returns {{enabled:boolean, profile:string, sigmas:number[]|null, sigmasText:string, lora:string, loraStrength:number}} */
  getValue() {
    const sigmasText = this.refs.sigmas.value;
    const sigmas = parseSigmas(sigmasText);
    this.refs.sigmas.classList.toggle('turbo-invalid', sigmas === null && sigmasText.trim() !== '');
    return {
      enabled: this.refs.toggle.checked,
      profile: this.refs.profile.value || '',
      sigmas,
      sigmasText,
      lora: this.refs.lora ? this.refs.lora.value : 'none',
      loraStrength: Number(this.refs.loraStrength?.value ?? 1),
    };
  }

  selectedProfile() {
    return (this.profiles || []).find((p) => String(p.id ?? p.value) === String(this.refs.profile.value)) || null;
  }

  setValue(initial = {}) {
    this.value = {
      enabled: Boolean(initial.enabled),
      profile: initial.profile || '',
      sigmas: initial.sigmas || '',
      lora: initial.lora ?? null,
      loraStrength: initial.loraStrength ?? null,
    };
    this.render();
  }
}

/** 把 sigma 数组转成可编辑文本：去掉末尾的 0.0（采样时引擎会自动追加）。 */
export function sigmasText(sigmas) {
  if (!Array.isArray(sigmas)) return '';
  const values = sigmas.map(Number).filter((value) => Number.isFinite(value));
  while (values.length > 1 && values[values.length - 1] === 0) values.pop();
  return values.join(', ');
}

/** 解析 sigma 文本：空 → null；有非法值 → null；否则数字数组。 */
export function parseSigmas(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const parts = raw.split(/[\s,，;；]+/).filter(Boolean);
  const values = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    values.push(n);
  }
  if (!values.length || values.length > 32) return null;
  return values;
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

  setValue(initial = {}) {
    this.initial = { ...(initial || {}) };
    this.render();
  }
}

function normalizeModelList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => (typeof item === 'string' ? { value: item, label: item } : item));
}
