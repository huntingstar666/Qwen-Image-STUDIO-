/**
 * 「图片精修」右栏 AI 面板：指令 → 参考图 → 输出设置 → LoRA → 结果。
 *
 * 依赖宿主（studio.js）传入的 ctx：
 *   getSource()  取得主图 / 蒙版的烘焙结果（提交时调用）
 *   showResult(url|null)  在画布上预览结果（null = 回到底图）
 *   compare(urls) 打开对比对话框
 *   addOverlay(file) / getLayers() / selectLayer(id) / removeLayer(id) / setLayerOpacity(id,v) / scaleLayer(id,f)
 *   getMainThumb() 主图缩略图
 *
 * 本模块不直接操作 StudioDoc，全部通过 ctx 转发，方便独立演进。
 */

import { api } from '../../api.js';
import { JobRunner, qualityItems } from '../jobView.js';
import { toastError, toastSuccess, toastWarn } from '../toast.js';
import { confirmDialog } from '../modal.js';
import { escapeHtml, loadImage } from '../../utils.js';
import { patchSettings, store } from '../../store.js';
import {
  buildEditPayload,
  detectTask,
  pickConsistencyLora,
  pickTaskLora,
  workSize,
} from './payload.js';
import {
  defaultPresetId,
  effectiveValue,
  findPreset,
  loadPresets,
  modifiedKeys,
  normalizeProtection,
  presetTaskMode,
  resolvePresetForMask,
} from './presets.js';
import { mountGuards } from './guards.js';
import { mountAdvanced } from './advanced.js';

const MAX_REFS = 3;
const MAX_LORAS = 2;
const MAX_REF_SIDE = 4096;
const MAX_REF_PIXELS = 24_000_000;
const MAX_REF_BYTES = 20 * 1024 * 1024;
const TASK_LABELS = {
  auto: '自动识别',
  edit: '通用编辑',
  inpaint: '局部重绘',
  remove: '元素移除',
  replace: '元素替换',
  outpaint: '扩图',
};

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export function mountAiPanel(host, ctx) {
  host.innerHTML = `
    <div class="ai-pane">
      <section class="ai-section">
        <div class="ai-label">方案预设 <span class="ai-label-note" data-ref="presetNote"></span></div>
        <div class="ai-presets" data-ref="presets"></div>
        <div class="ai-hint" data-ref="presetHint"></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">本次保护</div>
        <div data-ref="guards"></div>
        <div class="ai-guard-note" data-ref="guardNote" hidden></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">指令</div>
        <textarea class="ai-prompt" data-ref="prompt" rows="4"
          placeholder="帮我去除苹果；或用 @图二 的梨子替换 @图一 的苹果"></textarea>
        <div class="ai-prompt-foot">
          <button class="ai-chip" type="button" data-ref="mention">@ 引用</button>
          <button class="ai-chip" type="button" data-ref="polish">✦ 润色</button>
          <span class="spacer"></span>
          <span class="mono ai-count" data-ref="count">0 / 2000</span>
        </div>
        <div class="ai-mentions" data-ref="mentions" hidden></div>
        <div class="ai-polish" data-ref="polishBox" hidden></div>
        <button class="btn primary ai-submit" type="button" data-ref="submit">修改</button>
        <div class="ai-hint" data-ref="submitHint">Ctrl+Enter 提交 · 空白提交会被拦截</div>
      </section>

      <section class="ai-section">
        <div class="ai-label">参考图 <span class="ai-label-note" data-ref="refCount"></span></div>
        <div class="ai-refs" data-ref="refs"></div>
        <div class="ai-row">
          <button class="btn ghost sm" type="button" data-ref="addRef">+ 添加参考图</button>
          <button class="btn ghost sm" type="button" data-ref="addOverlayBtn">叠加扣图</button>
        </div>
        <input type="file" accept="image/*" hidden data-ref="refInput" />
        <input type="file" accept="image/*" hidden data-ref="overlayInput" />
        <div class="ai-hint">图一 = 主图（锁定为底图）；叠加图会画进主图，可拖动/缩放/调透明度。</div>
        <div class="ai-layers" data-ref="layers"></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">输出</div>
        <label class="ai-field">
          <span>分辨率</span>
          <select class="select" data-ref="sizeMode">
            <option value="follow">跟随主图（推荐）</option>
            <option value="custom">指定尺寸</option>
            <option value="ratio">按比例</option>
          </select>
        </label>
        <div class="ai-row" data-ref="customSize" hidden>
          <label class="ai-field">
            <span>宽</span>
            <input class="input mono" type="number" min="64" step="32" data-ref="width" />
          </label>
          <label class="ai-field">
            <span>高</span>
            <input class="input mono" type="number" min="64" step="32" data-ref="height" />
          </label>
        </div>
        <label class="ai-field" data-ref="ratioRow" hidden>
          <span>比例</span>
          <select class="select" data-ref="ratio"></select>
        </label>

        <div class="ai-work mono" data-ref="workInfo"></div>
        <div class="ai-warn" data-ref="workWarn" hidden></div>
        <div class="ai-row">
          <button class="btn ghost sm" type="button" data-ref="openOutpaint">扩图 / 外补画布 →</button>
        </div>
      </section>

      <section class="ai-section">
        <div class="ai-label">高级设置 <span class="ai-label-note" data-ref="advNote">数值 = 预设 + 你的覆盖</span></div>
        <div data-ref="advanced"></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">采样与 LoRA</div>
        <label class="ai-field">
          <span>加速方案</span>
          <select class="select" data-ref="turbo"></select>
        </label>
        <div class="ai-work mono" data-ref="samplingInfo"></div>
        <label class="ai-field">
          <span>任务</span>
          <select class="select" data-ref="task">
            ${Object.entries(TASK_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
        </label>
        <label class="ai-check"><input type="checkbox" data-ref="consistency" checked /><span>一致性 LoRA</span>
          <span class="ai-tag" data-ref="consistencyName">—</span>
        </label>
        <label class="ai-slider">
          <span class="ai-slider-head"><span>一致性强度</span><span class="mono" data-ref="strengthLabel">0.48</span></span>
          <input type="range" min="0" max="200" step="1" value="48" data-ref="strength" />
        </label>
        <div class="ai-row">
          <select class="select" data-ref="loraPick"><option value="">选择要叠加的 LoRA</option></select>
          <button class="btn ghost sm" type="button" data-ref="loraAdd">添加</button>
        </div>
        <div class="ai-loras" data-ref="loraList"></div>
        <div class="ai-warn" data-ref="loraWarn" hidden></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">结果</div>
        <div class="ai-job" data-ref="jobHost"></div>
        <div class="ai-row" data-ref="resultActions" hidden>
          <button class="btn ghost sm" type="button" data-ref="previewBtn">画布预览</button>
          <button class="btn ghost sm" type="button" data-ref="compareBtn">与底图对比</button>
          <button class="btn primary sm" type="button" data-ref="adoptBtn">载入为新底图</button>
        </div>
        <div class="ai-hint" data-ref="adoptHint" hidden>载入后结果图成为新的主图，蒙版与历史会清空，可继续精修或再次扩图。</div>
        <div class="ai-quality" data-ref="quality" hidden></div>
      </section>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    presets: ref('presets'),
    presetNote: ref('presetNote'),
    presetHint: ref('presetHint'),
    guards: ref('guards'),
    guardNote: ref('guardNote'),
    prompt: ref('prompt'),
    count: ref('count'),
    mention: ref('mention'),
    mentions: ref('mentions'),
    polish: ref('polish'),
    polishBox: ref('polishBox'),
    submit: ref('submit'),
    submitHint: ref('submitHint'),
    refs: ref('refs'),
    refCount: ref('refCount'),
    addRef: ref('addRef'),
    addOverlayBtn: ref('addOverlayBtn'),
    refInput: ref('refInput'),
    overlayInput: ref('overlayInput'),
    layers: ref('layers'),
    sizeMode: ref('sizeMode'),
    customSize: ref('customSize'),
    width: ref('width'),
    height: ref('height'),
    ratioRow: ref('ratioRow'),
    ratio: ref('ratio'),
    advanced: ref('advanced'),
    workInfo: ref('workInfo'),
    workWarn: ref('workWarn'),
    openOutpaint: ref('openOutpaint'),
    turbo: ref('turbo'),
    samplingInfo: ref('samplingInfo'),
    task: ref('task'),
    consistency: ref('consistency'),
    consistencyName: ref('consistencyName'),
    strength: ref('strength'),
    strengthLabel: ref('strengthLabel'),
    loraPick: ref('loraPick'),
    loraAdd: ref('loraAdd'),
    loraList: ref('loraList'),
    loraWarn: ref('loraWarn'),
    jobHost: ref('jobHost'),
    resultActions: ref('resultActions'),
    previewBtn: ref('previewBtn'),
    compareBtn: ref('compareBtn'),
    adoptBtn: ref('adoptBtn'),
    adoptHint: ref('adoptHint'),
    quality: ref('quality'),
  };

  const editSettings = store.state.edit || {};
  const state = {
    prompt: '',
    refs: [],
    customLoras: [],
    resultUrl: '',
    previewOn: false,
    resultInfo: null,
    busy: false,
    options: null,
    turboProfiles: [],
    turboId: '',
    presets: [],
    presetVersion: 1,
    presetId: String(editSettings.preset || ''),
    overrides: { ...(editSettings.overrides || {}) },
    protection: normalizeProtection(editSettings.protection),
    consistencyOn: editSettings.consistency !== false,
    consistencyStrength: Number(editSettings.consistencyStrength ?? 0.48),
  };

  /** 指令 / 参考图 / AI 参数变化后通知宿主合并自动保存。 */
  function notifyPersist() {
    ctx.onPersistChange?.();
  }

  /** 预设 / 覆盖项 / 保护开关 / 一致性强度跨页共享，写回同一份 settings.edit。 */
  function persistEdit() {
    patchSettings({
      edit: {
        preset: state.presetId,
        overrides: state.overrides,
        protection: state.protection,
        consistency: state.consistencyOn,
        consistencyStrength: state.consistencyStrength,
      },
    });
    notifyPersist();
  }

  function currentPreset() {
    return findPreset(state.presets, state.presetId);
  }

  function presetValue(key, fallback) {
    return effectiveValue(currentPreset(), state.overrides, key, fallback);
  }

  const runner = new JobRunner(refs.jobHost, {
    idleText: '圈出要修改的区域，写好指令后点击「修改」。',
    idleGlyph: '✦',
  });

  const guards = mountGuards(refs.guards, {
    value: state.protection,
    onChange(next) {
      state.protection = next;
      persistEdit();
    },
  });

  /* ------------------------------------------------------------ 预设 */

  function renderPresets() {
    if (!state.presets.length) {
      refs.presets.innerHTML = '<div class="ai-hint">未连接后端，暂不能选择预设</div>';
      refs.presetNote.textContent = '';
      refs.presetHint.textContent = '预设数值由后端下发，连接后自动出现。';
      return;
    }
    const dirty = modifiedKeys(currentPreset(), state.overrides).length > 0;
    refs.presets.innerHTML = state.presets
      .map((item) => {
        const active = item.id === state.presetId;
        return `<button type="button" class="ai-preset${active ? ' active' : ''}" data-preset="${escapeHtml(item.id)}"
          title="${escapeHtml(item.summary || '')}">
          <span class="ai-preset-head">
            <span class="ai-preset-name">${escapeHtml(item.label || item.id)}</span>
            ${item.default ? '<span class="ai-preset-badge">推荐</span>' : ''}
            ${active && dirty ? '<span class="ai-preset-chip">已修改</span>' : ''}
          </span>
          <span class="ai-preset-sum">${escapeHtml(item.summary || '')}</span>
        </button>`;
      })
      .join('');
    refs.presetNote.textContent = `v${state.presetVersion}`;
    refs.presetHint.textContent = currentPreset()?.summary || '';
  }

  function selectPreset(id) {
    const preset = findPreset(state.presets, id);
    if (!preset) return;
    state.presetId = id;
    persistEdit();
    const mode = presetTaskMode(preset);
    if (mode === 'remove' || mode === 'outpaint') refs.task.value = mode;
    else if (refs.task.value === 'remove' || refs.task.value === 'outpaint') refs.task.value = 'auto';
    renderPresets();
    advanced.refresh();
    renderMeta();
    syncGuardNote();
  }

  function syncGuardNote() {
    const outpaint = refs.task.value === 'outpaint';
    refs.guardNote.hidden = !outpaint;
    refs.guardNote.textContent = outpaint
      ? '扩图会改变输出尺寸，零像素偏移校验自动关闭；原图区域仍逐字节保留。'
      : '';
  }

  async function loadPresetMeta() {
    try {
      const meta = await loadPresets();
      state.presets = meta.list;
      state.presetVersion = meta.version;
      if (!findPreset(state.presets, state.presetId)) {
        state.presetId = meta.defaultId || defaultPresetId(state.presets);
      }
      renderPresets();
      advanced.refresh();
      renderMeta();
      syncGuardNote();
    } catch (err) {
      renderPresets();
      toastWarn('读取预设失败，提交时会按后端默认参数执行');
    }
  }

  const advanced = mountAdvanced(refs.advanced, {
    getPreset: currentPreset,
    getOverrides: () => state.overrides,
    apply(next) {
      state.overrides = next;
      persistEdit();
      renderPresets();
    },
    onChange: renderMeta,
  });

  // 扩图面板 / 其他页改的是同一份 settings.edit，这里跟着回显，避免两处状态打架。
  store.subscribe(() => {
    const edit = store.state.edit || {};
    const nextOverrides = edit.overrides && typeof edit.overrides === 'object' ? edit.overrides : {};
    if (JSON.stringify(nextOverrides) !== JSON.stringify(state.overrides)) {
      state.overrides = { ...nextOverrides };
      advanced.refresh();
      renderPresets();
      renderMeta();
    }
    const nextPreset = String(edit.preset || state.presetId);
    if (nextPreset !== state.presetId) {
      state.presetId = nextPreset;
      const mode = presetTaskMode(findPreset(state.presets, nextPreset));
      if (mode === 'remove' || mode === 'outpaint') refs.task.value = mode;
      else if (refs.task.value === 'remove' || refs.task.value === 'outpaint') refs.task.value = 'auto';
      renderPresets();
      advanced.refresh();
      renderMeta();
      syncGuardNote();
    }
    const nextProtection = normalizeProtection(edit.protection);
    if (
      nextProtection.color !== state.protection.color ||
      nextProtection.zeroShift !== state.protection.zeroShift
    ) {
      state.protection = nextProtection;
      guards.sync(nextProtection);
    }
    if (edit.consistency !== undefined && Boolean(edit.consistency) !== state.consistencyOn) {
      state.consistencyOn = Boolean(edit.consistency);
      refs.consistency.checked = state.consistencyOn;
      refs.strength.disabled = !state.consistencyOn;
    }
    const strength = Number(edit.consistencyStrength);
    if (Number.isFinite(strength) && Math.abs(strength - state.consistencyStrength) > 1e-6) {
      setStrength(strength);
    }
  });

  /* ------------------------------------------------------------ 选项 */

  function syncTurboUi() {
    const profiles = state.turboProfiles;
    refs.turbo.innerHTML =
      '<option value="">关闭加速（标准采样）</option>' +
      profiles
        .map(
          (profile) =>
            `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label || profile.id)}</option>`,
        )
        .join('');
    if (state.turboId) refs.turbo.value = state.turboId;
    syncSamplingInfo();
  }

  function currentTurbo() {
    if (!state.turboId) return null;
    return state.turboProfiles.find((profile) => profile.id === state.turboId) || null;
  }

  function sampling() {
    const profile = currentTurbo();
    if (profile) {
      return {
        steps: Number(profile.steps) || 9,
        cfg: Number(profile.cfg) || 1,
        sampler: profile.sampler || 'euler',
        scheduler: profile.scheduler || 'simple',
        turbo: { enabled: true, profile: profile.id },
      };
    }
    const defaults = state.options?.defaults || {};
    return {
      steps: Number(defaults.steps) || 25,
      cfg: Number(defaults.cfg) || 4,
      sampler: defaults.sampler || 'euler',
      scheduler: defaults.scheduler || 'simple',
      turbo: { enabled: false, profile: null },
    };
  }

  function syncSamplingInfo() {
    const plan = sampling();
    const parts = [`${plan.steps} 步`, `cfg ${plan.cfg}`, `${plan.sampler}/${plan.scheduler}`];
    if (plan.turbo.enabled) parts.push('Turbo 预设');
    refs.samplingInfo.textContent = parts.join(' · ');
  }

  async function loadOptions() {
    try {
      const options = await api.options();
      state.options = options;
      const profiles = options?.turbo_profiles || [];
      state.turboProfiles = profiles;
      const nine = profiles.find((profile) => Number(profile.steps) === 9);
      const eight = profiles.find((profile) => Number(profile.steps) === 8) || profiles[0];
      // 图片精修默认走 9 步预设（细节收敛更充分）；后端 defaults.turbo_profile
      // 是给文生图/图像编辑用的 8 步，这里不跟随它。
      state.turboId = (nine || eight)?.id || '';
      syncTurboUi();

      const ratios = options?.ratios || [];
      refs.ratio.innerHTML = ratios.length
        ? ratios
            .map((item) => {
              const value = typeof item === 'string' ? item : item.id || item.value;
              const label = typeof item === 'string' ? item : item.label || item.id;
              return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
            })
            .join('')
        : ['1:1', '16:9', '9:16', '4:3', '3:4']
            .map((value) => `<option value="${value}">${value}</option>`)
            .join('');

      const loras = options?.models?.lora || [];
      const consistency = pickConsistencyLora(loras, options?.defaults?.consistency_lora);
      state.consistencyName = consistency;
      refs.consistencyName.textContent = consistency ? consistency.split(/[\\/]/).pop() : '后端未返回';
      refs.loraPick.innerHTML =
        '<option value="">选择要叠加的 LoRA</option>' +
        loras
          .map((item) => {
            const value = item.value || item.name || '';
            return `<option value="${escapeHtml(value)}">${escapeHtml(item.label || value)}</option>`;
          })
          .join('');
      if (!loras.length) {
        refs.loraPick.innerHTML = '<option value="">后端未返回 LoRA 列表</option>';
      }
      renderMeta();
    } catch (err) {
      refs.consistencyName.textContent = '读取失败';
      refs.samplingInfo.textContent = '未连接后端，提交时会再试';
      toastError(err, '读取模型选项失败');
    }
  }

  /* ------------------------------------------------------------ 尺寸 */

  function mainSize() {
    const source = ctx.getSize?.();
    return source && source.width ? source : { width: 1024, height: 1024 };
  }

  function renderMeta() {
    const size = mainSize();
    const mode = refs.sizeMode.value;
    refs.customSize.hidden = mode !== 'custom';
    refs.ratioRow.hidden = mode !== 'ratio';
    const work = workSize(size, {
      preprocess: presetValue('preprocess.enabled', true) !== false,
      maxSide: Number(presetValue('preprocess.max_side', 2048)) || 2048,
    });
    const output =
      mode === 'custom'
        ? `${refs.width.value || '—'} × ${refs.height.value || '—'}`
        : mode === 'ratio'
          ? `${refs.ratio.value || '1:1'}`
          : `${size.width} × ${size.height}`;
    refs.workInfo.textContent = `工作画布 ${work.width} × ${work.height} · 输出 ${output}`;
    const tokens = Math.round((work.width / 32) * (work.height / 32));
    const heavy = tokens > 4096;
    refs.workWarn.hidden = !heavy;
    refs.workWarn.textContent = heavy
      ? `采样 token 约 ${tokens}，显存占用偏高：建议开启预处理或圈小一点。`
      : '';
  }

  if (!refs.width.value) refs.width.value = '1024';
  if (!refs.height.value) refs.height.value = '1024';

  /* ------------------------------------------------------------ 参考图 */

  function renderRefs() {
    const thumb = ctx.getMainThumb?.() || '';
    const mainCard = `
      <div class="ai-ref is-main" title="主图（底图，不可删除）">
        ${thumb ? `<img src="${thumb}" alt="主图" />` : '<div class="ai-ref-ph">主图</div>'}
        <span class="ai-ref-tag">图一 · 主图</span>
        <span class="ai-ref-lock">🔒</span>
      </div>`;
    const cards = state.refs
      .map(
        (item, index) => `
        <div class="ai-ref" data-ref-id="${item.id}" title="${escapeHtml(item.name)}">
          <img src="${item.dataUrl}" alt="${escapeHtml(item.name)}" />
          <span class="ai-ref-tag">图${['一', '二', '三', '四'][index + 1] || index + 2}</span>
          <button class="ai-ref-del" type="button" data-ref-del="${item.id}" title="移除">×</button>
        </div>`,
      )
      .join('');
    refs.refs.innerHTML = mainCard + cards;
    refs.refCount.textContent = `${1 + state.refs.length} / ${1 + MAX_REFS}`;
    refs.addRef.disabled = state.refs.length >= MAX_REFS;
  }

  async function addRefFiles(files) {
    const before = state.refs.length;
    for (const file of [...files]) {
      if (state.refs.length >= MAX_REFS) {
        toastWarn(`最多再添加 ${MAX_REFS} 张参考图`);
        break;
      }
      if (!file.type.startsWith('image/')) continue;
      if (file.size > MAX_REF_BYTES) {
        toastWarn(`参考图 ${file.name || ''} 超过 ${Math.round(MAX_REF_BYTES / 1048576)}MB，已跳过`);
        continue;
      }
      try {
        const dataUrl = await readFile(file);
        const image = await loadImage(dataUrl);
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (width > MAX_REF_SIDE || height > MAX_REF_SIDE || width * height > MAX_REF_PIXELS) {
          toastWarn(`参考图尺寸过大（${width}×${height}），已跳过`);
          continue;
        }
        state.refs.push({
          id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name || '参考图',
          dataUrl,
          width,
          height,
        });
      } catch (err) {
        toastError(err, '读取参考图失败');
      }
    }
    renderRefs();
    refs.refInput.value = '';
    if (state.refs.length > before) insertMention(before + 2);
    if (state.refs.length !== before) notifyPersist();
  }

  function insertMention(index) {
    if (!index || index > 1 + state.refs.length) return;
    const label = `@图${['一', '二', '三', '四'][index - 1] || index}`;
    const textarea = refs.prompt;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = `${textarea.value.slice(0, start)}${label} ${textarea.value.slice(end)}`;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + label.length + 1;
    syncPrompt();
  }

  /** 删除参考图后同步指令：移除指向它的 @图N，并把后面的引用整体前移一位。 */
  function dropMention(index) {
    const chars = ['一', '二', '三', '四'];
    const label = chars[index - 1];
    if (!label) return;
    let text = refs.prompt.value.replace(new RegExp(`@图${label}[ \\t]*`, 'g'), '');
    for (let n = index + 1; n <= chars.length; n += 1) {
      text = text.replace(new RegExp(`@图${chars[n - 1]}`, 'g'), `@图${chars[n - 2]}`);
    }
    if (text === refs.prompt.value) return;
    refs.prompt.value = text;
    syncPrompt();
  }

  function renderMentionsMenu() {
    const items = ['图一 · 主图', ...state.refs.map((item, index) => `图${['二', '三', '四'][index] || index + 2} · ${item.name}`)];
    refs.mentions.innerHTML = items
      .map(
        (label, index) =>
          `<button type="button" class="ai-mention" data-mention="${index + 1}">@${escapeHtml(label)}</button>`,
      )
      .join('');
    refs.mentions.hidden = false;
  }

  /* ------------------------------------------------------------ 叠加层 */

  function renderLayers() {
    const layers = ctx.getLayers?.() || [];
    if (!layers.length) {
      refs.layers.innerHTML = '';
      return;
    }
    refs.layers.innerHTML = layers
      .map(
        (layer) => `
        <div class="ai-layer" data-layer="${layer.id}">
          <button class="ai-layer-name" type="button" data-layer-pick="${layer.id}">${escapeHtml(layer.name)}</button>
          <button class="ai-layer-btn" type="button" data-layer-scale="${layer.id}" title="缩小">−</button>
          <button class="ai-layer-btn" type="button" data-layer-scale="${layer.id}" data-dir="1" title="放大">＋</button>
          <input class="ai-layer-alpha" type="range" min="0" max="100" step="1" value="${Math.round(layer.opacity * 100)}"
            data-layer-alpha="${layer.id}" title="不透明度" />
          <button class="ai-layer-btn" type="button" data-layer-del="${layer.id}" title="删除">×</button>
        </div>`,
      )
      .join('');
  }

  /* ------------------------------------------------------------ 指令 */

  function syncPrompt() {
    state.prompt = refs.prompt.value;
    refs.count.textContent = `${refs.prompt.value.length} / 2000`;
    refs.submit.disabled = !state.prompt.trim() || state.busy;
    notifyPersist();
  }

  function syncBusy() {
    refs.submit.disabled = state.busy || !state.prompt.trim();
    refs.submit.textContent = state.busy ? '修改中…' : '修改';
    refs.polish.disabled = state.busy;
  }

  async function polish() {
    const text = refs.prompt.value.trim();
    if (!text) {
      toastWarn('先写一句指令，再润色');
      return;
    }
    refs.polish.disabled = true;
    refs.polish.textContent = '润色中…';
    const size = mainSize();
    try {
      const result = await api.polish({
        prompt: text,
        mode: 'edit',
        image_model: 'qwen',
        target_size: [size.width, size.height],
        references: [
          { label: '图1', role: '主图（编辑目标）' },
          ...state.refs.map((item, index) => ({ label: `图${index + 2}`, role: item.name })),
        ],
      });
      const polished = String(result?.prompt || '').trim();
      if (!polished) {
        toastWarn('润色没有返回内容，可直接提交原文');
        return;
      }
      showPolish(text, polished);
    } catch (err) {
      toastError(err, '润色失败，原文仍可提交');
    } finally {
      refs.polish.disabled = false;
      refs.polish.textContent = '✦ 润色';
    }
  }

  function showPolish(original, polished) {
    refs.polishBox.hidden = false;
    refs.polishBox.innerHTML = `
      <div class="ai-polish-head">润色结果</div>
      <div class="ai-polish-body">
        <div class="ai-polish-col"><div class="ai-polish-title">原文</div><p>${escapeHtml(original)}</p></div>
        <div class="ai-polish-col is-new"><div class="ai-polish-title">润色</div><p>${escapeHtml(polished)}</p></div>
      </div>
      <div class="ai-polish-actions">
        <button class="btn ghost sm" type="button" data-ref="polishDrop">用原文</button>
        <button class="btn primary sm" type="button" data-ref="polishAccept">采用润色</button>
      </div>`;
    refs.polishBox.querySelector('[data-ref="polishDrop"]').addEventListener('click', () => {
      refs.polishBox.hidden = true;
    });
    refs.polishBox.querySelector('[data-ref="polishAccept"]').addEventListener('click', () => {
      refs.prompt.value = polished;
      syncPrompt();
      refs.polishBox.hidden = true;
    });
  }

  /* ------------------------------------------------------------ 提交 */

  function collectLoras() {
    const size = mainSize();
    const source = ctx.getSource?.();
    const taskMode = refs.task.value;
    const task = taskMode === 'auto' ? detectTask(refs.prompt.value, Boolean(source?.hasMask)) : taskMode;
    const loras = state.options?.models?.lora || [];
    return {
      task,
      taskLora: pickTaskLora(loras, task),
      consistency: refs.consistency.checked,
      consistencyName: state.consistencyName || '',
      strength: Number(refs.strength.value) / 100,
      custom: state.customLoras,
      size,
    };
  }

  async function submit() {
    if (state.busy) return;
    const text = refs.prompt.value.trim();
    if (!text) {
      toastWarn('先写一句修改指令，例如「帮我去除苹果」');
      refs.prompt.focus();
      return;
    }
    const source = ctx.getSource?.();
    if (!source) {
      toastWarn('请先打开一张主图');
      return;
    }
    if (!source.hasMask && refs.task.value !== 'outpaint') {
      const ok = await confirmDialog({
        title: '没有检测到蒙版',
        message: '将按整图重绘，速度更慢且可能改变画面其他部分。推荐先用套索/椭圆圈出要改的区域。',
        confirmText: '继续整图修改',
      });
      if (!ok) return;
    }

    const loraState = collectLoras();
    const resolved = resolvePresetForMask(state.presetId, source.hasMask);
    if (resolved.degraded) {
      toastWarn(`「${resolved.from}」需要蒙版，本次已按「整画布」执行`);
    }
    if (loraState.task === 'outpaint') {
      const edges = ['outpaint.top', 'outpaint.bottom', 'outpaint.left', 'outpaint.right'].map((key) =>
        Number(presetValue(key, 0)) || 0,
      );
      if (!edges.some((value) => value > 0)) {
        toastWarn('扩图需要至少一条外扩边：先在高级设置里填写上/下/左/右百分比');
        return;
      }
    }
    const settings = {
      sizeMode: refs.sizeMode.value,
      width: Number(refs.width.value) || source.main.width,
      height: Number(refs.height.value) || source.main.height,
      ratio: refs.ratio.value,
      preprocess: presetValue('preprocess.enabled', true) !== false,
      maxSide: Number(presetValue('preprocess.max_side', 2048)) || 2048,
      preset: resolved.id,
      overrides: state.overrides,
      protection: state.protection,
      hasMask: source.hasMask,
      coverage: source.coverage || 0,
    };
    const payload = buildEditPayload({
      main: source.main,
      mask: source.mask,
      prompt: text,
      refs: state.refs.map((item) => ({ name: item.name, data: item.dataUrl })),
      settings,
      loras: loraState,
      sampling: sampling(),
      task: loraState.task,
    });

    state.busy = true;
    state.previewOn = false;
    syncBusy();
    refs.resultActions.hidden = true;
    refs.adoptHint.hidden = true;
    refs.quality.hidden = true;

    await runner
      .start({
        create: () => api.edit(payload),
        prompt: payload.prompt,
        maskDataUrl: payload.mask?.data || null,
        onProgress: (job) => {
          if (['done', 'error', 'canceled'].includes(job?.status)) {
            state.busy = false;
            syncBusy();
          }
        },
        onDone: (job) => {
          state.busy = false;
          syncBusy();
          const image = job?.images?.[0];
          if (!image) return;
          const url = api.fileUrl(image.url || image.path || '');
          if (!url) {
            toastError(new Error('后端未返回结果地址'), '生成失败');
            return;
          }
          state.resultUrl = url;
          state.resultInfo = { width: image.width, height: image.height, task: loraState.task };
          refs.resultActions.hidden = false;
          renderQuality(job);
          if (state.resultInfo.width && state.resultInfo.height) {
            refs.adoptHint.textContent = `载入后 ${state.resultInfo.width}×${state.resultInfo.height} 成为新底图：蒙版与历史清空，可继续精修或再次扩图。`;
            refs.adoptHint.hidden = false;
          }
          state.previewOn = true;
          refs.previewBtn.textContent = '回到主图';
          ctx.showResult?.(state.resultUrl);
          toastSuccess('修改完成，已叠加到画布预览');
          notifyPersist();
        },
      })
      .finally(() => {
        state.busy = false;
        syncBusy();
      });
  }

  function renderQuality(job) {
    const items = qualityItems(job);
    refs.quality.innerHTML = items
      .map(({ text, kind = '', title = '' }) => {
        const cls = `ai-tag${kind === 'ok' || kind === 'warn' ? ` ${kind}` : ''}`;
        const attr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<span class="${cls}"${attr}>${escapeHtml(text)}</span>`;
      })
      .join('');
    refs.quality.hidden = !items.length;
  }

  /* ------------------------------------------------------------ 事件 */

  refs.prompt.addEventListener('input', syncPrompt);
  refs.prompt.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape') refs.mentions.hidden = true;
  });

  refs.mention.addEventListener('click', () => {
    if (refs.mentions.hidden) renderMentionsMenu();
    else refs.mentions.hidden = true;
  });
  refs.mentions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mention]');
    if (!button) return;
    insertMention(Number(button.dataset.mention));
    refs.mentions.hidden = true;
  });

  refs.polish.addEventListener('click', polish);
  refs.submit.addEventListener('click', submit);
  refs.openOutpaint.addEventListener('click', () => ctx.openOutpaint?.());

  refs.addRef.addEventListener('click', () => refs.refInput.click());
  refs.refInput.addEventListener('change', () => addRefFiles(refs.refInput.files || []));
  refs.refs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ref-del]');
    if (!button) return;
    const index = state.refs.findIndex((item) => item.id === button.dataset.refDel);
    if (index < 0) return;
    state.refs = state.refs.filter((item) => item.id !== button.dataset.refDel);
    dropMention(index + 2);
    renderRefs();
    notifyPersist();
  });

  refs.addOverlayBtn.addEventListener('click', () => refs.overlayInput.click());
  refs.overlayInput.addEventListener('change', async () => {
    const file = refs.overlayInput.files?.[0];
    refs.overlayInput.value = '';
    if (!file) return;
    try {
      await ctx.addOverlay?.(file);
      renderLayers();
      toastSuccess('已叠加，切换到「移动」工具可拖动');
    } catch (err) {
      toastError(err, '叠加失败');
    }
  });

  refs.layers.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-layer-pick]');
    if (pick) {
      ctx.selectLayer?.(pick.dataset.layerPick);
      return;
    }
    const del = event.target.closest('[data-layer-del]');
    if (del) {
      ctx.removeLayer?.(del.dataset.layerDel);
      renderLayers();
      return;
    }
    const scale = event.target.closest('[data-layer-scale]');
    if (scale) {
      ctx.scaleLayer?.(scale.dataset.layerScale, scale.dataset.dir === '1' ? 1.1 : 1 / 1.1);
      renderLayers();
    }
  });
  refs.layers.addEventListener('input', (event) => {
    const input = event.target.closest('[data-layer-alpha]');
    if (!input) return;
    ctx.setLayerOpacity?.(input.dataset.layerAlpha, Number(input.value) / 100);
  });
  refs.layers.addEventListener('change', (event) => {
    if (!event.target.closest('[data-layer-alpha]')) return;
    ctx.commitLayers?.();
  });

  refs.sizeMode.addEventListener('change', () => {
    renderMeta();
    notifyPersist();
  });
  refs.width.addEventListener('input', () => {
    renderMeta();
    notifyPersist();
  });
  refs.height.addEventListener('input', () => {
    renderMeta();
    notifyPersist();
  });
  refs.ratio.addEventListener('change', () => {
    renderMeta();
    notifyPersist();
  });

  refs.presets.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preset]');
    if (button) selectPreset(button.dataset.preset);
  });

  refs.turbo.addEventListener('change', () => {
    state.turboId = refs.turbo.value;
    syncSamplingInfo();
    notifyPersist();
  });

  refs.task.addEventListener('change', () => {
    const mode = refs.task.value;
    refs.submitHint.textContent =
      mode === 'auto'
        ? 'Ctrl+Enter 提交 · 任务 LoRA 会按指令关键词自动识别'
        : `Ctrl+Enter 提交 · 当前任务：${TASK_LABELS[mode] || mode}`;
    syncGuardNote();
    notifyPersist();
  });

  /** 一致性强度唯一写入口：滑块、标签、共享设置一起更新（B2/B6）。 */
  function setStrength(value) {
    const next = Math.min(2, Math.max(0, Number(value) || 0));
    state.consistencyStrength = next;
    refs.strength.value = String(Math.round(next * 100));
    refs.strengthLabel.textContent = next.toFixed(2);
  }

  refs.consistency.checked = state.consistencyOn;
  refs.strength.disabled = !state.consistencyOn;
  setStrength(state.consistencyStrength);

  refs.consistency.addEventListener('change', () => {
    state.consistencyOn = refs.consistency.checked;
    refs.strength.disabled = !state.consistencyOn;
    persistEdit();
  });
  refs.strength.addEventListener('input', () => {
    refs.strengthLabel.textContent = (Number(refs.strength.value) / 100).toFixed(2);
  });
  refs.strength.addEventListener('change', () => {
    setStrength(Number(refs.strength.value) / 100);
    persistEdit();
  });

  refs.loraAdd.addEventListener('click', () => {
    const name = refs.loraPick.value;
    if (!name) return;
    const total = state.customLoras.length + 1;
    if (total > MAX_LORAS) {
      refs.loraWarn.hidden = false;
      refs.loraWarn.textContent = `最多叠加 ${MAX_LORAS} 条 LoRA（含任务 LoRA），请先移除一条。`;
      return;
    }
    if (state.customLoras.some((item) => item.name === name)) {
      toastWarn('这条 LoRA 已经添加过');
      return;
    }
    state.customLoras.push({ name, strength: 1 });
    refs.loraWarn.hidden = true;
    renderCustomLoras();
    notifyPersist();
  });

  function renderCustomLoras() {
    refs.loraList.innerHTML = state.customLoras
      .map(
        (item) => `
        <div class="ai-lora">
          <span class="ai-lora-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name.split(/[\\/]/).pop())}</span>
          <input class="input mono ai-lora-strength" type="number" min="0" max="2" step="0.05"
            value="${Number(item.strength).toFixed(2)}" data-lora-strength="${escapeHtml(item.name)}" />
          <button class="ai-layer-btn" type="button" data-lora-del="${escapeHtml(item.name)}">×</button>
        </div>`,
      )
      .join('');
  }

  refs.loraList.addEventListener('input', (event) => {
    const input = event.target.closest('[data-lora-strength]');
    if (!input) return;
    const item = state.customLoras.find((entry) => entry.name === input.dataset.loraStrength);
    if (item) item.strength = Math.min(2, Math.max(0, Number(input.value) || 0));
    notifyPersist();
  });
  refs.loraList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lora-del]');
    if (!button) return;
    state.customLoras = state.customLoras.filter((item) => item.name !== button.dataset.loraDel);
    renderCustomLoras();
    notifyPersist();
  });

  refs.previewBtn.addEventListener('click', () => {
    if (!state.resultUrl) return;
    state.previewOn = !state.previewOn;
    refs.previewBtn.textContent = state.previewOn ? '回到主图' : '画布预览';
    ctx.showResult?.(state.previewOn ? state.resultUrl : null);
  });

  refs.adoptBtn.addEventListener('click', async () => {
    if (!state.resultUrl || state.busy) return;
    refs.adoptBtn.disabled = true;
    try {
      const info = await ctx.adoptResult?.(state.resultUrl, {
        task: state.resultInfo?.task || refs.task.value,
        width: state.resultInfo?.width,
        height: state.resultInfo?.height,
      });
      if (info) toastSuccess(`已载入新底图 ${info.width} × ${info.height}，可继续精修`);
    } finally {
      refs.adoptBtn.disabled = false;
    }
  });

  refs.compareBtn.addEventListener('click', () => {
    const source = ctx.getSource?.();
    if (!source) return;
    const results = [];
    if (state.resultUrl) results.push({ url: state.resultUrl, label: '本次结果' });
    const past = runner.getResults?.() || [];
    for (const item of past) {
      if (item.url && !results.some((entry) => entry.url === item.url)) {
        results.push({ url: item.url, label: item.label || '历史结果' });
      }
    }
    if (!results.length) {
      toastWarn('还没有可对比的结果');
      return;
    }
    ctx.compare?.(source.main.data, results);
  });

  /* ------------------------------------------------------------ 对外接口 */

  const controller = {
    /** 主图/蒙版变化后刷新（尺寸、缩略图、叠加层列表） */
    refresh() {
      renderMeta();
      renderRefs();
      renderLayers();
    },
    /** 底图被替换（载入结果 / 打开新图）：清空结果态，避免旧预览残留 */
    resetResult() {
      state.resultUrl = '';
      state.previewOn = false;
      state.resultInfo = null;
      refs.previewBtn.textContent = '画布预览';
      refs.resultActions.hidden = true;
      refs.adoptHint.hidden = true;
      refs.quality.hidden = true;
      refs.quality.innerHTML = '';
    },
    /** 换主图 / 载入结果：参考图与指令属于上一张图，清空避免串任务 */
    resetTaskContext() {
      state.refs = [];
      refs.prompt.value = '';
      refs.refInput.value = '';
      syncPrompt();
      renderRefs();
      controller.resetResult();
      renderMeta();
    },
    /** studio 端画完蒙版后调用：只更新任务识别与提示，不做整图编码 */
    onMaskChanged(coverage) {
      const task = detectTask(refs.prompt.value, coverage > 0);
      refs.submitHint.textContent = `已圈选 ${(coverage * 100).toFixed(1)}% · 自动识别：${
        TASK_LABELS[task] || task
      }`;
    },
    focusPrompt() {
      refs.prompt.focus();
    },
    /** 本机工程恢复：把保存的 AI 现场写回面板（不改动已提交的任务）。 */
    restoreState(persist, refsData) {
      if (!persist) return;
      if (Array.isArray(refsData) && refsData.length) state.refs = refsData.slice(0, MAX_REFS);
      refs.prompt.value = typeof persist.prompt === 'string' ? persist.prompt : '';
      if (persist.presetId) state.presetId = persist.presetId;
      state.overrides = { ...(persist.overrides || {}) };
      state.protection = normalizeProtection(persist.protection);
      guards.sync(state.protection);
      state.consistencyOn = persist.consistencyOn !== false;
      refs.consistency.checked = state.consistencyOn;
      refs.strength.disabled = !state.consistencyOn;
      setStrength(persist.consistencyStrength ?? state.consistencyStrength);
      state.customLoras = Array.isArray(persist.customLoras)
        ? persist.customLoras.slice(0, MAX_LORAS).map((item) => ({ ...item }))
        : [];
      if (persist.task) {
        refs.task.value = persist.task;
        refs.submitHint.textContent =
          persist.task === 'auto'
            ? 'Ctrl+Enter 提交 · 任务 LoRA 会按指令关键词自动识别'
            : `Ctrl+Enter 提交 · 当前任务：${TASK_LABELS[persist.task] || persist.task}`;
      }
      if (persist.sizeMode) refs.sizeMode.value = persist.sizeMode;
      if (persist.width) refs.width.value = persist.width;
      if (persist.height) refs.height.value = persist.height;
      if (persist.ratio) refs.ratio.value = persist.ratio;
      state.turboId = persist.turboId || '';
      if (state.turboId) refs.turbo.value = state.turboId;
      state.resultUrl = persist.resultUrl || '';
      state.previewOn = false;
      state.resultInfo = persist.resultInfo || null;
      refs.previewBtn.textContent = '画布预览';
      refs.resultActions.hidden = !state.resultUrl;
      if (state.resultUrl && state.resultInfo?.width) {
        refs.adoptHint.textContent = `载入后 ${state.resultInfo.width}×${state.resultInfo.height} 成为新底图：蒙版与历史清空，可继续精修或再次扩图。`;
        refs.adoptHint.hidden = false;
      } else {
        refs.adoptHint.hidden = true;
      }
      syncPrompt();
      syncBusy();
      renderRefs();
      renderPresets();
      advanced.refresh();
      renderMeta();
      renderCustomLoras();
      syncGuardNote();
      syncSamplingInfo();
    },
    /** 宿主的本机自动保存从这里取 AI 现场（指令、参考图、参数、结果地址）。 */
    getPersistState() {
      return {
        prompt: refs.prompt.value,
        refs: state.refs.map((item) => ({
          id: item.id,
          name: item.name,
          dataUrl: item.dataUrl,
          width: item.width,
          height: item.height,
        })),
        presetId: state.presetId,
        overrides: { ...state.overrides },
        protection: { ...state.protection },
        customLoras: state.customLoras.map((item) => ({ ...item })),
        task: refs.task.value,
        sizeMode: refs.sizeMode.value,
        width: refs.width.value,
        height: refs.height.value,
        ratio: refs.ratio.value,
        turboId: state.turboId,
        consistencyOn: state.consistencyOn,
        consistencyStrength: state.consistencyStrength,
        resultUrl: state.resultUrl,
        resultInfo: state.resultInfo ? { ...state.resultInfo } : null,
      };
    },
    /** 扩图面板点「生成扩图」：补默认指令、切 outpaint 任务后直接提交。 */
    submitOutpaint() {
      if (!refs.prompt.value.trim()) {
        refs.prompt.value = '移除图像中的灰色区域，无缝自然延展为完整图像。';
        syncPrompt();
      }
      refs.task.value = 'outpaint';
      syncGuardNote();
      renderMeta();
      return submit();
    },
  };

  syncPrompt();
  syncBusy();
  renderRefs();
  renderMeta();
  syncGuardNote();
  loadOptions();
  loadPresetMeta();

  return controller;
}
