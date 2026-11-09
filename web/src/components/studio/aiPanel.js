/**
 * 「图片精修」右栏 AI 面板：指令 → 参考图 → 输出设置 → LoRA → 结果。
 *
 * 依赖宿主（studio.js）传入的 ctx：
 *   getSource()  取得主图 / 蒙版的烘焙结果（提交时调用）
 *   showResult(url|null)  在画布上预览结果（null = 回到底图）
 *   compare(urls) 打开对比对话框
 *   addOverlay(file) / getLayers() / selectLayer(id) / removeLayer(id) / cloneLayer(id) / moveLayer(id,delta) / setLayerOpacity(id,v) / scaleLayer(id,f)
 *   getMainThumb() 主图缩略图
 *
 * 本模块不直接操作 StudioDoc，全部通过 ctx 转发，方便独立演进。
 */

import { api } from '../../api.js';
import { JobRunner, qualityItems } from '../jobView.js';
import { toastError, toastSuccess, toastWarn } from '../toast.js';
import { confirmDialog } from '../modal.js';
import { escapeHtml, fmtCoverage, loadImage } from '../../utils.js';
import { patchSettings, store } from '../../store.js';
import {
  buildEditPayload,
  detectTask,
  pickConsistencyLora,
  pickTaskLora,
  workSize,
  PANORAMA_ASPECTS,
  panoramaPlan,
} from './payload.js';
import {
  applyProtection,
  defaultPresetId,
  effectiveValue,
  findPreset,
  loadPresets,
  modifiedKeys,
  presetTaskMode,
  protectionOf,
  resetDefinedOverrides,
  resolvePresetForMask,
  withOverride,
} from './presets.js';
import { mountGuards } from './guards.js';
import { mountAdvanced } from './advanced.js';
import {
  REF_MIME,
  filesFromDataTransfer,
  openImportPicker,
  urlToDataUrl,
} from './importPicker.js';
import { hasRefDrag, readRefDrag } from '../refLibrary.js';
import { createPromptEditor } from './promptEditor.js';
import { createSessionHistory } from './sessionHistory.js';
import { mountAiHistory } from './aiHistory.js';
import { openStudioCompare } from './compareLauncher.js';

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
  panorama: '全景',
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
        <div class="ai-label">指令</div>
        <div class="ai-prompt-host" data-ref="promptHost"></div>
        <div class="ai-prompt-foot">
          <button class="ai-chip" type="button" data-ref="mention">@ 引用</button>
          <button class="ai-chip" type="button" data-ref="polish">✦ 润色</button>
          <span class="spacer"></span>
          <span class="mono ai-count" data-ref="count">0 / 2000</span>
        </div>
        <div class="ai-mentions" data-ref="mentions" hidden></div>
        <div class="ai-polish" data-ref="polishBox" hidden></div>
      </section>

      <section class="ai-section">
        <div class="ai-label">参考图 <span class="ai-label-note" data-ref="refCount"></span></div>
        <div class="ai-refs" data-ref="refs"></div>
        <div class="ai-row">
          <div class="ai-ref-add" data-ref="addRefWrap">
            <button class="btn ghost sm" type="button" data-ref="addRef" aria-haspopup="menu" aria-expanded="false">+ 添加参考图 ▾</button>
            <div class="ai-ref-menu" role="menu" data-ref="addRefMenu" hidden>
              <button type="button" role="menuitem" data-ref-source="local">本地文件</button>
              <button type="button" role="menuitem" data-ref-source="warehouse">素材仓库</button>
              <button type="button" role="menuitem" data-ref-source="history">最近结果</button>
            </div>
          </div>
          <button class="btn ghost sm" type="button" data-ref="addOverlayBtn">叠加扣图</button>
        </div>
        <input type="file" accept="image/*" multiple hidden data-ref="refInput" />
        <input type="file" accept="image/*" hidden data-ref="overlayInput" />
        <div class="ai-hint">图一 = 主图（锁定为底图）；叠加图会画进主图，可拖动/缩放/调透明度。</div>
      </section>

      <section class="ai-section ai-submit-section">
        <button class="btn primary ai-submit" type="button" data-ref="submit">修改</button>
        <div class="ai-hint" data-ref="submitHint">Ctrl+Enter 提交 · 空白提交会被拦截</div>
      </section>

      <section class="ai-section ai-more">
        <button class="ai-more-head" type="button" data-ref="moreToggle" aria-expanded="false">
          <span class="ai-more-arrow">▸</span>
          <span class="ai-more-title">更多设置</span>
          <span class="ai-more-summary" data-ref="moreSummary"></span>
        </button>
        <div class="ai-more-body" data-ref="moreBody" hidden>
          <div class="ai-more-group">
            <div class="ai-label">方案预设 <span class="ai-label-note" data-ref="presetNote"></span></div>
            <div class="ai-presets" data-ref="presets"></div>
            <div class="ai-hint" data-ref="presetHint"></div>
            <div class="ai-custom-pick" data-ref="customPresets"></div>
          </div>

          <div class="ai-more-group">
            <div class="ai-label">本次保护</div>
            <div data-ref="guards"></div>
            <div class="ai-guard-note" data-ref="guardNote" hidden></div>
          </div>

          <div class="ai-more-group">
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
            <div class="ai-pano" data-ref="panoBox" hidden>
              <div class="ai-label">全景画布 <span class="ai-label-note">参考图向两侧延展</span></div>
              <div class="ai-row ai-pano-aspects" data-ref="panoAspects"></div>
              <label class="ai-field">
                <span>长边上限</span>
                <select class="select" data-ref="panoLongSide">
                  <option value="2048">2048</option>
                  <option value="3072">3072（推荐）</option>
                  <option value="4096">4096</option>
                </select>
              </label>
              <label class="ai-check"><input type="checkbox" data-ref="panoWrap" /><span>360° 环绕接缝</span>
                <span class="ai-label-note">实验</span>
              </label>
              <div class="ai-work mono" data-ref="panoInfo"></div>
            </div>
            <div class="ai-row">
              <button class="btn ghost sm" type="button" data-ref="openOutpaint">扩图 / 外补画布 →</button>
            </div>
          </div>

          <div class="ai-more-group">
            <div class="ai-label">高级设置 <span class="ai-label-note" data-ref="advNote">数值 = 预设 + 你的覆盖</span></div>
            <div data-ref="advanced"></div>
          </div>

          <div class="ai-more-group">
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
          </div>
        </div>
      </section>

      <section class="ai-section">
        <div class="ai-label">结果</div>
        <div class="ai-job" data-ref="jobHost"></div>
        <div class="ai-row" data-ref="resultActions" hidden>
          <button class="btn ghost sm" type="button" data-ref="previewBtn">画布预览</button>
          <button class="btn ghost sm" type="button" data-ref="compareBtn">与底图对比</button>
          <button class="btn ghost sm" type="button" data-ref="asLayerBtn" title="保留主图，把结果落成可单独显隐/移动的图层">作为新图层</button>
          <button class="btn primary sm" type="button" data-ref="adoptBtn">载入为新底图</button>
        </div>
        <div class="ai-hint" data-ref="adoptHint" hidden>「载入为新底图」会替换主图并清空蒙版与历史；「作为新图层」保留主图，结果叠成可单独编辑的图层。</div>
        <div class="ai-quality" data-ref="quality" hidden></div>
      </section>

      <section class="ai-section ai-history" data-ref="historyHost"></section>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    moreToggle: ref('moreToggle'),
    moreBody: ref('moreBody'),
    moreSummary: ref('moreSummary'),
    presets: ref('presets'),
    presetNote: ref('presetNote'),
    presetHint: ref('presetHint'),
    customPresets: ref('customPresets'),
    guards: ref('guards'),
    guardNote: ref('guardNote'),
    promptHost: ref('promptHost'),
    count: ref('count'),
    mention: ref('mention'),
    mentions: ref('mentions'),
    polish: ref('polish'),
    polishBox: ref('polishBox'),
    submit: ref('submit'),
    submitHint: ref('submitHint'),
    refs: ref('refs'),
    refCount: ref('refCount'),
    addRefWrap: ref('addRefWrap'),
    addRef: ref('addRef'),
    addRefMenu: ref('addRefMenu'),
    addOverlayBtn: ref('addOverlayBtn'),
    refInput: ref('refInput'),
    overlayInput: ref('overlayInput'),
    sizeMode: ref('sizeMode'),
    customSize: ref('customSize'),
    width: ref('width'),
    height: ref('height'),
    ratioRow: ref('ratioRow'),
    ratio: ref('ratio'),
    advanced: ref('advanced'),
    workInfo: ref('workInfo'),
    workWarn: ref('workWarn'),
    panoBox: ref('panoBox'),
    panoAspects: ref('panoAspects'),
    panoLongSide: ref('panoLongSide'),
    panoWrap: ref('panoWrap'),
    panoInfo: ref('panoInfo'),
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
    asLayerBtn: ref('asLayerBtn'),
    adoptBtn: ref('adoptBtn'),
    adoptHint: ref('adoptHint'),
    quality: ref('quality'),
    historyHost: ref('historyHost'),
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
    // 用户手动选过加速方案后，不再跟随预设默认档位（随项目现场恢复）。
    turboUser: false,
    presets: [],
    presetVersion: 1,
    presetId: String(editSettings.preset || ''),
    // 同一份 settings.edit 里记录「上次真正套用过默认值的预设」：
    // 首次打开本页时若与当前预设一致，就保留页面临时覆盖，不再重放默认值。
    appliedPreset: String(editSettings.appliedPreset || ''),
    overrides: { ...(editSettings.overrides || {}) },
    consistencyOn: editSettings.consistency !== false,
    consistencyStrength: Number(editSettings.consistencyStrength ?? 0.48),
    currentHistoryId: '',
    resultEntryId: '',
    /** 本次提交用的蒙版（输出尺寸）：结果「作为新图层」时并到该层。 */
    submittedMask: null,
  };

  /** 富文本指令框：chip 存储参考图 id，提交时序列化回 `@图N`。 */
  const promptEditor = createPromptEditor(refs.promptHost, {
    placeholder: '帮我去除苹果；或用 @图二 的梨子替换 @图一 的苹果',
    onChange: () => syncPrompt(),
    onEnterSubmit: () => void submit(),
    onMentionQuery(query) {
      if (query === null) {
        refs.mentions.hidden = true;
        return;
      }
      renderMentionsMenu(query);
    },
    onMissingRef: (count) => toastWarn(`已移除 ${count} 个失效的参考图引用`),
  });

  /** 指令 / 参考图 / AI 参数变化后通知宿主合并自动保存。 */
  function notifyPersist() {
    ctx.onPersistChange?.();
  }

  /* ------------------------------------------------------------ 编辑历史 */

  let history = null;
  let historySession = '';
  let historyPanel = null;

  /** 一次任务 = 一次文档；换图后自动切换到新会话，历史互不混用。 */
  function currentHistory() {
    const sessionId = String(ctx.getSessionId?.() || '');
    if (!history || historySession !== sessionId) {
      history?.destroy();
      historySession = sessionId;
      history = createSessionHistory({ sessionId });
      history.load().then(() => {
        if (historySession === sessionId) historyPanel?.render();
      });
    }
    return history;
  }

  function renderHistory() {
    currentHistory();
    historyPanel?.render();
    historyPanel?.setBusy(state.busy);
  }

  async function loadHistoryEntry(entry) {
    if (!entry || state.busy) return;
    if (ctx.hasDocChanges?.()) {
      const ok = await confirmDialog({
        title: `载入历史 #${entry.index}`,
        message: '将用该结果替换当前主图，裁剪、旋转、调色与蒙版会重置。',
        confirmText: '载入',
      });
      if (!ok) return;
    }
    const storeRef = currentHistory();
    const url = await storeRef.ensureResultUrl(entry.id);
    if (!url) {
      toastWarn('该历史结果已不在本机，无法载入');
      return;
    }
    const info = await ctx.adoptResult?.(url, {
      task: 'history',
      width: entry.result?.width,
      height: entry.result?.height,
    });
    if (!info) return;
    // 载入新底图会清空现场，这里把该次记录的参考图与指令补回去，便于继续修改。
    const restored = await storeRef.refsFor(entry.id);
    state.refs = restored.slice(0, MAX_REFS);
    syncEditorRefs();
    promptEditor.setText(entry.prompt || '');
    renderRefs();
    syncPrompt();
    notifyPersist();
    state.currentHistoryId = entry.id;
    historyPanel?.setCurrent(entry.id);
    historyPanel?.render();
    toastSuccess(`已载入历史 #${entry.index}，指令${restored.length ? '与参考图' : ''}已恢复`);
  }

  /**
   * 统一对比入口：references = 本次结果 + 参考图 + 编辑历史，results = 当前主图。
   * 顶部「对比」、结果卡片、历史卡片都走这里，避免三套数据组装。
   */
  async function compareAll({ extra = [], initialHistoryId = '', initialUrl = '' } = {}) {
    if (state.busy) {
      toastWarn('修改进行中，完成后再对比');
      return null;
    }
    const store = currentHistory();
    return openStudioCompare({
      getMain: () => ctx.getMainImage?.() || null,
      getRefs: () => state.refs,
      getHistory: () => store.entries,
      getHistoryUrl: (entry) => store.ensureResultUrl(entry.id, { pin: true }),
      extra,
      initialHistoryId,
      initialUrl,
    });
  }

  async function compareHistoryEntry(entry) {
    if (!entry) return;
    await compareAll({ initialHistoryId: entry.id });
  }

  async function removeHistoryEntry(entry) {
    if (!entry) return;
    const removed = await currentHistory().remove(entry.id);
    if (!removed) return;
    if (state.currentHistoryId === entry.id) state.currentHistoryId = '';
    if (state.resultEntryId === entry.id) state.resultEntryId = '';
    historyPanel?.setCurrent(state.currentHistoryId);
    historyPanel?.render();
    toastSuccess(`已删除历史 #${entry.index}`);
  }

  async function clearHistory() {
    const entries = currentHistory().entries;
    if (!entries.length) return;
    const ok = await confirmDialog({
      title: '清空编辑历史',
      message: `删除本次任务的全部 ${entries.length} 条 AI 编辑记录？当前画面不受影响。`,
      confirmText: '清空',
    });
    if (!ok) return;
    await currentHistory().clear();
    state.currentHistoryId = '';
    state.resultEntryId = '';
    historyPanel?.setCurrent('');
    historyPanel?.render();
    toastSuccess('已清空编辑历史');
  }

  historyPanel = mountAiHistory(refs.historyHost, {
    getEntries: () => currentHistory().entries,
    isBusy: () => state.busy,
    onLoad: (entry) => void loadHistoryEntry(entry),
    onCompare: (entry) => void compareHistoryEntry(entry),
    onRemove: (entry) => void removeHistoryEntry(entry),
    onClear: () => void clearHistory(),
  });

  /** 预设 / 覆盖项 / 一致性强度跨页共享，写回同一份 settings.edit。 */
  function persistEdit() {
    patchSettings({
      edit: {
        preset: state.presetId,
        // 两个页面共用这一份「已套用预设」标记，切页后才知道要不要重放默认值。
        appliedPreset: state.appliedPreset,
        overrides: state.overrides,
        consistency: state.consistencyOn,
        consistencyStrength: state.consistencyStrength,
      },
    });
    notifyPersist();
  }

  // 连续编辑预设只在「图生图」页有接力状态机；精修面板按等价的单次预设执行。
  const STUDIO_PRESET_ALIAS = { chain_mask: 'mask_edit', chain_native: 'native' };

  function hasMaskNow() {
    return Boolean(ctx.hasMask?.());
  }

  function hasImageNow() {
    if (typeof ctx.hasImage === 'function') return Boolean(ctx.hasImage());
    return Boolean(ctx.getMainThumb?.());
  }

  /** 实际生效的预设：先做连续编辑别名，再按有无蒙版降级（没打开图片时不降级）。 */
  function currentPresetId() {
    const raw = String(state.presetId || defaultPresetId(state.presets));
    const mapped = STUDIO_PRESET_ALIAS[raw] || raw;
    if (!hasImageNow()) return { id: mapped, degraded: false, from: '' };
    return resolvePresetForMask(mapped, hasMaskNow());
  }

  function currentPreset() {
    return findPreset(state.presets, currentPresetId().id);
  }

  /**
   * 真正会提交的任务：任务框显式选过就用它，停在「自动」时跟随预设
   * （与 submit() 内部同一口径）。注意「自动识别」只影响提示与任务 LoRA 预选，
   * 不会把识别结果当任务发出去（会被 presets.merge 判成与预设冲突）。
   */
  function effectiveTask() {
    const mode = String(refs.task.value || 'auto');
    if (mode !== 'auto') return mode;
    return presetTaskMode(currentPreset()) || 'edit';
  }

  function presetValue(key, fallback) {
    return effectiveValue(currentPreset(), state.overrides, key, fallback);
  }

  const runner = new JobRunner(refs.jobHost, {
    idleText: '圈出要修改的区域，写好指令后点击「修改」。',
    idleGlyph: '✦',
  });

  const guards = mountGuards(refs.guards, {
    // 开关值来自预设生效值（唯一事实源），改动写回 overrides
    value: protectionOf(currentPreset(), state.overrides),
    onChange(next) {
      state.overrides = applyProtection(currentPreset(), state.overrides || {}, next);
      persistEdit();
      renderPresets();
      advanced.refresh();
      renderMeta();
    },
  });

  /* ------------------------------------------------------------ 预设 */

  function renderPresets() {
    if (!state.presets.length) {
      refs.presets.innerHTML = '<div class="ai-hint">未连接后端，暂不能选择预设</div>';
      refs.presetNote.textContent = '';
      refs.presetHint.textContent = '预设数值由后端下发，连接后自动出现。';
      syncMoreSummary();
      return;
    }
    const resolved = currentPresetId();
    const preset = findPreset(state.presets, resolved.id);
    const dirty = modifiedKeys(preset, state.overrides).length > 0;
    // 连续编辑依赖「图生图」页的接力状态机；自定义搭配走独立选择器。
    const visible = state.presets.filter((item) => !item.custom && !item.params?.chain);
    refs.presets.innerHTML = visible
      .map((item) => {
        const active = item.id === resolved.id;
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
    const notes = [preset?.summary || ''];
    if (resolved.degraded) {
      const from = findPreset(state.presets, resolved.from);
      notes.push(`无蒙版：已按「${preset?.label || resolved.id}」执行（来自「${from?.label || resolved.from}」）`);
    }
    if (STUDIO_PRESET_ALIAS[state.presetId]) {
      notes.push('连续编辑预设请在「图生图」页使用');
    }
    refs.presetHint.textContent = notes.filter(Boolean).join(' · ');
    renderCustomPicker();
    syncMoreSummary();
  }

  /** 任务页的「自定义搭配」选择器。 */
  function renderCustomPicker() {
    const host = refs.customPresets;
    if (!host) return;
    const customs = state.presets.filter((item) => item.custom);
    if (!customs.length) {
      host.innerHTML = '<div class="ai-hint">自定义搭配：到「设置 → 预设与自定义」创建。</div>';
      return;
    }
    const active = customs.some((item) => item.id === state.presetId) ? state.presetId : '';
    host.innerHTML = `<label class="ai-field">
      <span>自定义搭配</span>
      <select class="select" data-ref="customPresetSelect">
        <option value="">选择已保存的自定义搭配</option>
        ${customs
          .map(
            (item) =>
              `<option value="${escapeHtml(item.id)}" ${item.id === active ? 'selected' : ''}>${escapeHtml(item.label || item.id)}</option>`,
          )
          .join('')}
      </select>
    </label>`;
  }

  /** 套用预设 / 自定义搭配的完整默认值（切预设时调用）。 */
  function applyPresetDefaults(preset) {
    if (!preset) return;
    const params = preset.params || {};
    state.turboUser = false;
    applyPresetTurbo();
    const cons = params.consistency || {};
    state.consistencyOn = cons.enabled !== false;
    const strength = Number(cons.strength);
    state.consistencyStrength = Number.isFinite(strength) ? strength : 0.48;
    state.consistencyName = cons.lora
      ? String(cons.lora)
      : pickConsistencyLora(state.options?.models?.lora || [],
          state.options?.defaults?.consistency_lora);
    refs.consistency.checked = state.consistencyOn;
    refs.strength.disabled = !state.consistencyOn;
    setStrength(state.consistencyStrength);
    refs.consistencyName.textContent = state.consistencyName
      ? state.consistencyName.split(/[\\/]/).pop()
      : '后端未返回';
    state.customLoras = (Array.isArray(params.loras) ? params.loras : [])
      .filter((item) => item && item.name)
      .slice(0, MAX_LORAS)
      .map((item) => ({ name: String(item.name), strength: Number(item.strength) || 1 }));
    renderCustomLoras();
    state.appliedPreset = preset.id;
    guards.sync(protectionOf(preset, state.overrides));
    // 先落 preset / appliedPreset，再同步采样：顺序反了的话，
    // store 订阅者会在「preset 还是旧值、state.presetId 已是新值」时误判成外部切换并被回滚。
    persistEdit();
    // 采样 / Turbo 也是「切预设重建」的一部分：写回共享 settings.edit，
    // 图生图页与精修页才不会一个用新预设、一个还停在旧采样值。
    const sampling = params.sampling || {};
    const shared = {};
    const steps = Number(sampling.steps);
    if (Number.isFinite(steps) && steps > 0) shared.steps = steps;
    const cfg = Number(sampling.cfg);
    if (Number.isFinite(cfg) && cfg >= 0) shared.cfg = cfg;
    if (sampling.sampler) shared.sampler = String(sampling.sampler);
    if (sampling.scheduler) shared.scheduler = String(sampling.scheduler);
    const denoise = Number(sampling.denoise);
    if (Number.isFinite(denoise)) shared.denoise = denoise;
    if (state.turboProfiles.length) {
      shared.turbo = Boolean(state.turboId);
      shared.turboProfile = state.turboId || '';
      shared.turboUser = false;
    }
    if (Object.keys(shared).length) patchSettings({ edit: shared });
    notifyPersist();
    syncSamplingInfo();
    renderMeta();
  }

  function selectPreset(id) {
    const preset = findPreset(state.presets, id);
    if (!preset) return;
    state.presetId = id;
    // 切预设时清掉该预设已定义键上的旧覆盖，确保新预设默认值生效；
    // outpaint.top/left 这类预设未定义的任务输入继续保留。
    state.overrides = resetDefinedOverrides(preset, state.overrides);
    applyPresetDefaults(preset);
    const mode = presetTaskMode(preset);
    if (mode === 'remove' || mode === 'outpaint' || mode === 'panorama') refs.task.value = mode;
    else if (['remove', 'outpaint', 'panorama'].includes(refs.task.value)) refs.task.value = 'auto';
    syncTaskHint();
    renderPresets();
    advanced.refresh();
    renderMeta();
    syncGuardNote();
  }

  function syncGuardNote() {
    const mode = refs.task.value;
    const outpaint = mode === 'outpaint';
    const panorama = mode === 'panorama';
    refs.guardNote.hidden = !(outpaint || panorama);
    refs.guardNote.textContent = outpaint
      ? '扩图会改变输出尺寸，零像素偏移校验自动关闭；原图区域仍逐字节保留。'
      : panorama
        ? '全景会按目标比例扩画布，零像素偏移校验自动关闭；原图区域等比缩放到画布中央。'
        : '';
    syncPano();
  }

  /* ------------------------------------------------------------ 全景（D14.1） */

  function panoValue(key, fallback) {
    return effectiveValue(currentPreset(), state.overrides, key, fallback);
  }

  function setPano(key, value) {
    state.overrides = withOverride(currentPreset(), state.overrides, key, value);
    persistEdit();
    renderPresets();
    renderMeta();
  }

  function syncTaskHint() {
    const mode = refs.task.value;
    const effective = TASK_LABELS[effectiveTask()] || effectiveTask();
    refs.submitHint.textContent =
      mode === 'auto'
        ? `Ctrl+Enter 提交 · 任务跟随预设：${effective}`
        : `Ctrl+Enter 提交 · 当前任务：${TASK_LABELS[mode] || mode}`;
  }

  function renderPanoAspects(active) {
    refs.panoAspects.innerHTML = PANORAMA_ASPECTS.map(
      (aspect) =>
        `<button type="button" class="btn ${aspect === active ? 'primary' : 'ghost'} sm" data-pano-aspect="${aspect}">${aspect}</button>`,
    ).join('');
  }

  /** 全景面板：只在任务切到「全景」时出现，数值写进预设覆盖项。 */
  function syncPano() {
    const on = refs.task.value === 'panorama';
    refs.panoBox.hidden = !on;
    if (!on) return;
    const aspect = String(panoValue('panorama.aspect', '2:1'));
    const longSide = Number(panoValue('panorama.long_side', 3072)) || 3072;
    renderPanoAspects(aspect);
    refs.panoLongSide.value = String(longSide);
    refs.panoWrap.checked = Boolean(panoValue('panorama.wrap', false));
    const plan = panoramaPlan(mainSize(), { aspect, longSide });
    const notes = [`${plan.width} × ${plan.height}`, `${plan.megapixels} MP`];
    if (plan.scale < 1) notes.push(`源图缩到 ${Math.round(plan.scale * 100)}%`);
    if (plan.overPixels) notes.push('超出 6MP 上限，请降低长边');
    refs.panoInfo.textContent = notes.join(' · ');
    refs.panoInfo.classList.toggle('is-warn', plan.overPixels);
  }

  refs.panoAspects.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pano-aspect]');
    if (!button) return;
    setPano('panorama.aspect', button.dataset.panoAspect);
  });

  refs.panoLongSide.addEventListener('change', () => {
    setPano('panorama.long_side', Number(refs.panoLongSide.value) || 3072);
  });

  refs.panoWrap.addEventListener('change', () => {
    setPano('panorama.wrap', Boolean(refs.panoWrap.checked));
  });

  async function loadPresetMeta() {
    try {
      const meta = await loadPresets();
      state.presets = meta.list;
      state.presetVersion = meta.version;
      if (!findPreset(state.presets, state.presetId)) {
        state.presetId = meta.defaultId || defaultPresetId(state.presets);
      }
      const preset = findPreset(state.presets, state.presetId);
      if (preset && state.appliedPreset !== state.presetId) {
        // 切过预设 / 首次加载：套用全局默认，清掉旧预设定义键上的临时覆盖。
        state.overrides = resetDefinedOverrides(preset, state.overrides);
        applyPresetDefaults(preset);
      } else {
        // 同一个预设：保留项目里的临时值，只回显。
        const presetCons = preset?.params?.consistency;
        if (presetCons?.lora) state.consistencyName = String(presetCons.lora);
        refs.consistency.checked = state.consistencyOn;
        refs.strength.disabled = !state.consistencyOn;
        setStrength(state.consistencyStrength);
        renderCustomLoras();
        applyPresetTurbo();
      }
      guards.sync(protectionOf(currentPreset(), state.overrides));
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
      guards.sync(protectionOf(currentPreset(), state.overrides));
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
      guards.sync(protectionOf(currentPreset(), state.overrides));
      renderPresets();
      renderMeta();
    }
    const nextPreset = String(edit.preset || state.presetId);
    if (nextPreset !== state.presetId) {
      state.presetId = nextPreset;
      const nextPresetMeta = findPreset(state.presets, nextPreset);
      if (nextPresetMeta && state.appliedPreset !== nextPreset) {
        // 另一个页面切了预设：这里也要套用同一份全局默认。
        state.overrides = resetDefinedOverrides(nextPresetMeta, state.overrides);
        applyPresetDefaults(nextPresetMeta);
      } else {
        applyPresetTurbo();
      }
      const mode = presetTaskMode(nextPresetMeta);
      if (mode === 'remove' || mode === 'outpaint' || mode === 'panorama') refs.task.value = mode;
      else if (['remove', 'outpaint', 'panorama'].includes(refs.task.value)) refs.task.value = 'auto';
      renderPresets();
      advanced.refresh();
      guards.sync(protectionOf(currentPreset(), state.overrides));
      renderMeta();
      syncGuardNote();
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
    // Turbo 也走共享设置：图生图页手动改过后本页跟随；预设默认值仍由 applyPresetTurbo 负责。
    if (edit.turboUser) {
      const turboId = String(edit.turboProfile || '');
      if (turboId !== state.turboId || !state.turboUser) {
        state.turboId = turboId;
        state.turboUser = true;
        syncTurboUi();
      }
    }
  });

  /* ------------------------------------------------------------ 选项 */

  /** 预设的 Turbo 档位是默认值；用户手动选过加速方案后不再覆盖。 */
  function applyPresetTurbo() {
    if (state.turboUser) return;
    const turbo = currentPreset()?.params?.turbo;
    if (!turbo) return;
    if (!turbo.enabled) {
      if (!state.turboId) return;
      state.turboId = '';
      syncTurboUi();
      notifyPersist();
      return;
    }
    const profile = String(turbo.profile || '');
    if (!profile || !state.turboProfiles.some((item) => item.id === profile)) return;
    if (state.turboId === profile) return;
    state.turboId = profile;
    syncTurboUi();
    notifyPersist();
  }

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
    const presetSampling = currentPreset()?.params?.sampling || {};
    return {
      steps: Number(presetSampling.steps) || Number(defaults.steps) || 25,
      cfg: presetSampling.cfg != null ? Number(presetSampling.cfg) : (Number(defaults.cfg) || 4),
      sampler: presetSampling.sampler || defaults.sampler || 'euler',
      scheduler: presetSampling.scheduler || defaults.scheduler || 'simple',
      turbo: { enabled: false, profile: null },
    };
  }

  function syncSamplingInfo() {
    const plan = sampling();
    const parts = [`${plan.steps} 步`, `cfg ${plan.cfg}`, `${plan.sampler}/${plan.scheduler}`];
    if (plan.turbo.enabled) parts.push('Turbo 预设');
    refs.samplingInfo.textContent = parts.join(' · ');
    syncMoreSummary();
  }

  async function loadOptions() {
    try {
      const options = await api.options();
      state.options = options;
      const profiles = options?.turbo_profiles || [];
      state.turboProfiles = profiles;
      const nine = profiles.find((profile) => Number(profile.steps) === 9);
      const eight = profiles.find((profile) => Number(profile.steps) === 8) || profiles[0];
      // 默认跟随预设的 Turbo 档位；用户手动选过加速方案则沿用其选择。
      const presetTurbo = currentPreset()?.params?.turbo;
      const presetProfile = presetTurbo?.enabled ? String(presetTurbo.profile || '') : '';
      const fallback = (nine || eight)?.id || '';
      if (state.turboUser) {
        if (!profiles.some((item) => item.id === state.turboId)) state.turboId = fallback;
      } else if (presetTurbo && !presetTurbo.enabled) {
        state.turboId = '';
      } else {
        state.turboId = profiles.some((item) => item.id === presetProfile)
          ? presetProfile
          : fallback;
      }
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
      // 预设里指定了一致性 LoRA 时不覆盖；否则用后端默认文件。
      if (!state.consistencyName) {
        state.consistencyName = pickConsistencyLora(loras, options?.defaults?.consistency_lora);
      }
      refs.consistencyName.textContent = state.consistencyName
        ? state.consistencyName.split(/[\\/]/).pop()
        : '后端未返回';
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

  function outputSummary() {
    const size = mainSize();
    const mode = refs.sizeMode.value;
    if (mode === 'custom') return `${refs.width.value || '—'} × ${refs.height.value || '—'}`;
    if (mode === 'ratio') return refs.ratio.value || '1:1';
    return `${size.width} × ${size.height}`;
  }

  function syncMoreSummary() {
    const plan = sampling();
    const turbo = plan.turbo.enabled ? `Turbo ${plan.steps} 步` : `标准 ${plan.steps} 步`;
    refs.moreSummary.textContent = `${currentPreset()?.label || '自然'} · 输出 ${outputSummary()} · ${turbo}`;
  }

  function renderMeta() {
    const size = mainSize();
    const mode = refs.sizeMode.value;
    refs.customSize.hidden = mode !== 'custom';
    refs.ratioRow.hidden = mode !== 'ratio';
    // 全景输出的是「按比例扩出的新画布」，工作画布直接按全景预估展示。
    const panorama = refs.task.value === 'panorama';
    const work = panorama
      ? panoramaPlan(size, {
          aspect: String(panoValue('panorama.aspect', '2:1')),
          longSide: Number(panoValue('panorama.long_side', 3072)) || 3072,
        })
      : workSize(size, {
          preprocess: presetValue('preprocess.enabled', true) !== false,
          maxSide: Number(presetValue('preprocess.max_side', 2048)) || 2048,
        });
    refs.workInfo.textContent = panorama
      ? `全景画布 ${work.width} × ${work.height} · 输出同尺寸`
      : `工作画布 ${work.width} × ${work.height} · 输出 ${outputSummary()}`;
    const tokens = Math.round((work.width / 32) * (work.height / 32));
    const heavy = tokens > 4096;
    refs.workWarn.hidden = !heavy;
    refs.workWarn.textContent = heavy
      ? `采样 token 约 ${tokens}，显存占用偏高：建议开启预处理或圈小一点。`
      : '';
    syncMoreSummary();
    if (panorama) syncPano();
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

  /** 富文本编号来源：主图固定第 0 位，参考图按当前顺序。 */
  function syncEditorRefs() {
    promptEditor.syncRefs([{ id: 'main' }, ...state.refs.map((item) => ({ id: item.id }))]);
  }

  /** 统一的参考图入队：接受 dataURL 条目（导入选择器 / 拖拽矩阵）。 */
  async function addRefItems(items) {
    const before = state.refs.length;
    for (const item of [...items]) {
      if (state.refs.length >= MAX_REFS) {
        toastWarn(`参考图最多 ${MAX_REFS} 张，已忽略多余图片`);
        break;
      }
      const dataUrl = item?.dataUrl || item?.src || '';
      if (!dataUrl) continue;
      let width = Number(item.width) || 0;
      let height = Number(item.height) || 0;
      if (!width || !height) {
        try {
          const image = await loadImage(dataUrl);
          width = image.naturalWidth;
          height = image.naturalHeight;
        } catch (err) {
          toastError(err, '读取参考图失败');
          continue;
        }
      }
      if (width > MAX_REF_SIDE || height > MAX_REF_SIDE || width * height > MAX_REF_PIXELS) {
        toastWarn(`参考图尺寸过大（${width}×${height}），已跳过`);
        continue;
      }
      if (state.refs.some((ref) => ref.dataUrl === dataUrl)) continue;
      state.refs.push({
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: item.name || '参考图',
        dataUrl,
        width,
        height,
      });
    }
    renderRefs();
    syncEditorRefs();
    if (state.refs.length > before) insertMention(before + 2);
    if (state.refs.length !== before) notifyPersist();
  }

  async function addRefFiles(files) {
    const items = [];
    for (const file of [...files]) {
      if (!file.type?.startsWith('image/')) continue;
      if (file.size > MAX_REF_BYTES) {
        toastWarn(`参考图 ${file.name || ''} 超过 ${Math.round(MAX_REF_BYTES / 1048576)}MB，已跳过`);
        continue;
      }
      try {
        items.push({ name: file.name || '参考图', src: await readFile(file) });
      } catch (err) {
        toastError(err, '读取参考图失败');
      }
    }
    await addRefItems(items);
    refs.refInput.value = '';
  }

  function insertMention(index) {
    if (!index || index > 1 + state.refs.length) return;
    const refId = index === 1 ? 'main' : state.refs[index - 2]?.id;
    if (!refId) return;
    promptEditor.focus();
    promptEditor.insertMention({ refId });
  }

  function renderMentionsMenu(query = '') {
    const items = [
      { index: 1, refId: 'main', label: '图一 · 主图' },
      ...state.refs.map((item, i) => ({
        index: i + 2,
        refId: item.id,
        label: `图${['二', '三', '四'][i] || i + 2} · ${item.name}`,
      })),
    ].filter((item) => !query || item.label.includes(query));
    if (!items.length) {
      refs.mentions.hidden = true;
      return;
    }
    refs.mentions.innerHTML = items
      .map(
        (item) =>
          `<button type="button" class="ai-mention" data-mention="${item.index}">@${escapeHtml(item.label)}</button>`,
      )
      .join('');
    promptEditor.setMentionMenu(
      items.map((item) => ({ refId: item.refId, label: item.label.split(' · ')[0] })),
    );
    refs.mentions.hidden = false;
  }

  /* ------------------------------------------------------------ 叠加层 */

  /* ------------------------------------------------------------ 指令 */

  function syncPrompt() {
    state.prompt = promptEditor.getText();
    refs.count.textContent = `${state.prompt.length} / 2000`;
    refs.submit.disabled = !state.prompt.trim() || state.busy;
    notifyPersist();
  }

  function syncBusy() {
    refs.submit.disabled = state.busy || !state.prompt.trim();
    refs.submit.textContent = state.busy ? '修改中…' : '修改';
    refs.polish.disabled = state.busy;
    historyPanel?.setBusy(state.busy);
  }

  async function polish() {
    const text = promptEditor.getText().trim();
    if (!text) {
      toastWarn('先写一句指令，再润色');
      return;
    }
    refs.polish.disabled = true;
    refs.polish.textContent = '润色中…';
    const size = mainSize();
    const source = ctx.getSource?.();
    // 参考图与编辑页同一套契约：服务端只读 name/description/size，图片本体走 images。
    const refImages = state.refs.filter((item) => item.dataUrl).slice(0, 5);
    const images = [
      source?.main?.data ? { data: source.main.data, name: source.main.name || 'main.png' } : null,
      ...refImages.map((item) => ({ data: item.dataUrl, name: item.name || '参考图' })),
    ].filter(Boolean);
    try {
      const result = await api.polish({
        prompt: text,
        mode: 'edit',
        image_model: 'qwen',
        target_size: [size.width, size.height],
        references: [
          {
            name: 'image1',
            description: `${source?.main?.name || '主图'}（编辑目标）`,
            size: [size.width, size.height],
          },
          ...refImages.map((item, index) => ({
            name: `image${index + 2}`,
            description: item.name || '参考图',
            size: [item.width || 0, item.height || 0],
          })),
        ],
        images,
      });
      // 接口返回字段是 rewritten_prompt（与 edit 页共用的 /api/polish 契约）。
      const polished = String(result?.rewritten_prompt || '').trim();
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
      promptEditor.setText(polished);
      refs.polishBox.hidden = true;
    });
  }

  /* ------------------------------------------------------------ 提交 */

  function collectLoras() {
    const size = mainSize();
    const source = ctx.getSource?.();
    const taskMode = refs.task.value;
    const task = taskMode === 'auto' ? detectTask(promptEditor.getText(), Boolean(source?.hasMask)) : taskMode;
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
    const text = promptEditor.getText().trim();
    if (!text) {
      toastWarn('先写一句修改指令，例如「帮我去除苹果」');
      promptEditor.focus();
      return;
    }
    const source = ctx.getSource?.();
    if (!source) {
      toastWarn('请先打开一张主图');
      return;
    }
    if (!source.hasMask && refs.task.value !== 'outpaint' && refs.task.value !== 'panorama') {
      const ok = await confirmDialog({
        title: '没有检测到蒙版',
        message: '将按整图重绘，速度更慢且可能改变画面其他部分。推荐先用套索/椭圆圈出要改的区域。',
        confirmText: '继续整图修改',
      });
      if (!ok) return;
    }

    // 指令看起来是移除 / 扩图 / 全景，但当前预设的任务不是它：直接提交会按普通编辑跑
    // （没有任务 LoRA、没有提示图，遮罩也可能不参与合成），结果就是「看着没生效」（D29.2）。
    const detected = detectTask(text, Boolean(source.hasMask));
    const currentTask = effectiveTask();
    if (
      String(refs.task.value || 'auto') === 'auto'
      && detected !== currentTask
      && ['remove', 'outpaint', 'panorama'].includes(detected)
      && findPreset(state.presets, detected)
    ) {
      const presetLabel = currentPreset()?.label || currentTask;
      const ok = await confirmDialog({
        title: `按「${TASK_LABELS[detected]}」执行？`,
        message:
          `指令看起来是「${TASK_LABELS[detected]}」，但当前预设「${presetLabel}」会按`
          + `「${TASK_LABELS[currentTask] || currentTask}」执行：缺少对应的任务 LoRA 与提示图，`
          + `结果通常不会真的${detected === 'remove' ? '移除' : '扩展'}。`
          + `建议切到「${TASK_LABELS[detected]}」预设再提交。`,
        confirmText: `切到${TASK_LABELS[detected]}`,
        cancelText: '仍按当前预设',
      });
      if (ok) {
        selectPreset(detected);
        if (detected !== 'remove') {
          toastWarn(`已切到「${TASK_LABELS[detected]}」预设：先设置外扩/比例参数，再点「生成」`);
          return;
        }
      }
    }

    const loraState = collectLoras();
    const mappedPreset = STUDIO_PRESET_ALIAS[state.presetId] || state.presetId;
    const resolved = resolvePresetForMask(mappedPreset, source.hasMask);
    if (resolved.degraded) {
      const from = findPreset(state.presets, resolved.from);
      const to = findPreset(state.presets, resolved.id);
      toastWarn(`「${from?.label || resolved.from}」需要蒙版，本次已按「${to?.label || resolved.id}」执行`);
    }
    if (STUDIO_PRESET_ALIAS[state.presetId]) {
      toastWarn('连续编辑预设请在「图生图」页使用，本次按等价的单次预设执行');
    }
    // 任务：手动选过就以手动为准；停留在「自动」时跟随预设。
    // 若把 auto 猜出来的任务当显式值发出去，presets.merge 会认为任务与预设不一致，
    // 把元素移除/全景预设的绿区、填洞与 Remove LoRA 全部复位（P0-3）。
    const explicitTask = String(refs.task.value || 'auto') !== 'auto';
    const task = explicitTask ? loraState.task : presetTaskMode(findPreset(state.presets, resolved.id));
    if (task !== loraState.task) {
      loraState.task = task;
      loraState.taskLora = pickTaskLora(state.options?.models?.lora || [], task);
    }
    if (task === 'outpaint') {
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
      hasMask: source.hasMask,
      coverage: source.coverage || 0,
      taskExplicit: explicitTask,
    };
    const payload = buildEditPayload({
      main: source.main,
      mask: source.mask,
      prompt: text,
      refs: state.refs.map((item) => ({ name: item.name, data: item.dataUrl })),
      settings,
      loras: loraState,
      sampling: sampling(),
      task,
    });

    state.busy = true;
    state.previewOn = false;
    // 记下本次提交的蒙版，出图后「作为新图层」时并进图层，只在修改区域显示结果。
    state.submittedMask = source.hasMask && source.mask
      ? {
          dataUrl: source.mask,
          width: source.maskSize?.width || 0,
          height: source.maskSize?.height || 0,
        }
      : null;
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
          // 回显后端**实际执行**的任务：remove 无蒙版、outpaint 无外扩时会被降级成 edit。
          const actualTask = String(job?.quality?.task_mode || loraState.task || 'edit');
          state.resultInfo = { width: image.width, height: image.height, task: actualTask };
          refs.resultActions.hidden = false;
          renderQuality(job);
          if (state.resultInfo.width && state.resultInfo.height) {
            refs.adoptHint.textContent = `结果 ${state.resultInfo.width}×${state.resultInfo.height}：可「作为新图层」保留主图叠加，或「载入为新底图」直接替换主图。`;
            refs.adoptHint.hidden = false;
          }
          state.previewOn = true;
          refs.previewBtn.textContent = '回到主图';
          ctx.showResult?.(state.resultUrl);
          toastSuccess('修改完成，已叠加到画布预览');
          // D22.1：结果一出图就自动存入底部版本槽（不切换主图，点卡片再载入）。
          void ctx.recordAiResult?.({
            url: state.resultUrl,
            width: state.resultInfo.width,
            height: state.resultInfo.height,
            task: actualTask,
          });
          notifyPersist();

          // 成功的任务落一张历史卡片；一张图都没取到时不记录，避免空记录。
          const images = (job?.images || [])
            .map((item) => ({
              url: api.fileUrl(item.url || item.path || ''),
              width: item.width,
              height: item.height,
            }))
            .filter((item) => item.url);
          if (images.length) {
            void currentHistory()
              .append({
                jobId: job?.id || job?.job_id || '',
                prompt: text,
                model: 'qwen',
                params: {
                  width: images[0].width || payload.meta?.targetSize?.width || source.main.width,
                  height: images[0].height || payload.meta?.targetSize?.height || source.main.height,
                  preset: resolved.id,
                  turbo: payload.turbo?.profile || '',
                  steps: payload.steps,
                  cfg: payload.cfg,
                },
                refs: state.refs.map((item) => ({
                  id: item.id,
                  name: item.name,
                  dataUrl: item.dataUrl,
                  width: item.width,
                  height: item.height,
                })),
                images,
              })
              .then((added) => {
                if (!added.length) return;
                state.resultEntryId = added[0].id;
                state.currentHistoryId = added[0].id;
                historyPanel?.setCurrent(state.currentHistoryId);
                historyPanel?.render();
              })
              .catch(() => {
                // 历史记录失败不影响本次结果
              });
          }
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

  promptEditor.el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') refs.mentions.hidden = true;
  });

  let moreOpen = false;
  function setMoreOpen(open) {
    moreOpen = open;
    refs.moreBody.hidden = !open;
    refs.moreToggle.setAttribute('aria-expanded', String(open));
    refs.moreToggle.classList.toggle('is-open', open);
  }
  refs.moreToggle.addEventListener('click', () => setMoreOpen(!moreOpen));

  refs.mention.addEventListener('click', () => {
    if (refs.mentions.hidden) {
      promptEditor.focus();
      renderMentionsMenu();
    } else {
      refs.mentions.hidden = true;
    }
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

  /* 添加参考图：本地 / 素材仓库 / 最近结果三来源共用统一导入选择器。 */
  function setRefMenu(open) {
    refs.addRefMenu.hidden = !open;
    refs.addRef.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function focusRefMenuItem(index) {
    const items = [...refs.addRefMenu.querySelectorAll('[data-ref-source]')];
    if (!items.length) return;
    const next = (index + items.length) % items.length;
    items[next].focus();
  }

  function openRefPicker(source) {
    openImportPicker({
      title: '添加参考图',
      accept: 'ref',
      multiple: true,
      max: Math.max(1, MAX_REFS - state.refs.length),
      initialSource: source,
      onPick(items) {
        void addRefItems(items);
      },
    });
  }

  refs.addRef.addEventListener('click', (event) => {
    if (refs.addRef.disabled) return;
    event.stopPropagation();
    setRefMenu(refs.addRefMenu.hidden);
  });

  refs.addRef.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setRefMenu(true);
    focusRefMenuItem(0);
  });

  refs.addRefMenu.addEventListener('keydown', (event) => {
    const items = [...refs.addRefMenu.querySelectorAll('[data-ref-source]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setRefMenu(false);
      refs.addRef.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRefMenuItem(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRefMenuItem(index - 1);
    }
  });

  refs.addRefMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-ref-source]');
    if (!item) return;
    setRefMenu(false);
    const source = item.dataset.refSource;
    if (source === 'local') refs.refInput.click();
    else openRefPicker(source);
  });

  function onRefMenuOutside(event) {
    if (!refs.addRefMenu.hidden && !refs.addRefWrap.contains(event.target)) setRefMenu(false);
  }
  document.addEventListener('click', onRefMenuOutside);

  refs.refInput.addEventListener('change', () => {
    const files = [...(refs.refInput.files || [])];
    refs.refInput.value = '';
    void addRefFiles(files);
  });
  /* 参考图条 / 指令框拖拽：本地文件与 x-wb-ref 统一入队，重复 dataURL 自动忽略。 */
  const hasImageDrop = (event) => {
    const types = event.dataTransfer ? [...event.dataTransfer.types] : [];
    return types.includes('Files') || types.includes(REF_MIME);
  };

  async function acceptRefDrop(event) {
    const before = state.refs.length;
    const drag = readRefDrag(event);
    if (drag?.src) {
      try {
        await addRefItems([
          {
            name: drag.name || '参考图',
            src: await urlToDataUrl(drag.src),
            width: drag.width,
            height: drag.height,
          },
        ]);
      } catch (err) {
        toastError(err, '读取参考图失败');
        return;
      }
    } else {
      const files = filesFromDataTransfer(event.dataTransfer);
      if (!files.length) return;
      await addRefFiles(files);
    }
    if (state.refs.length === before && state.refs.length < MAX_REFS) {
      toastWarn('参考图已存在，未重复添加');
    }
  }

  [refs.refs, refs.promptHost].forEach((zone) => {
    ['dragenter', 'dragover'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        if (!hasImageDrop(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        zone.classList.add('is-dropping');
      });
    });
    zone.addEventListener('dragleave', (event) => {
      if (zone.contains(event.relatedTarget)) return;
      zone.classList.remove('is-dropping');
    });
    zone.addEventListener('drop', (event) => {
      if (!hasImageDrop(event)) return;
      event.preventDefault();
      zone.classList.remove('is-dropping');
      void acceptRefDrop(event);
    });
  });

  refs.refs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-ref-del]');
    if (!button) return;
    state.refs = state.refs.filter((item) => item.id !== button.dataset.refDel);
    syncEditorRefs();
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
      toastSuccess('已叠加，切换到「移动」工具可拖动');
    } catch (err) {
      toastError(err, '叠加失败');
    }
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
    state.turboUser = true;
    // Turbo 也是两页共享的编辑设置：写回 settings.edit，图生图页切回时按同一值提交。
    patchSettings({
      edit: {
        turbo: Boolean(state.turboId),
        turboProfile: state.turboId || '',
        turboUser: true,
      },
    });
    syncSamplingInfo();
    notifyPersist();
  });

  refs.customPresets.addEventListener('change', (event) => {
    const select = event.target.closest('[data-ref="customPresetSelect"]');
    if (!select || !select.value) return;
    selectPreset(select.value);
  });

  refs.task.addEventListener('change', () => {
    // 与图生图页一致：显式选移除 / 扩图 / 全景时同步切到对应预设，
    // 否则扩图会误用编辑档的裁块与接缝参数。
    const mode = refs.task.value;
    if (['remove', 'outpaint', 'panorama'].includes(mode) && findPreset(state.presets, mode)) {
      selectPreset(mode);
    }
    syncTaskHint();
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

  refs.asLayerBtn.addEventListener('click', async () => {
    if (!state.resultUrl || state.busy) return;
    refs.asLayerBtn.disabled = true;
    try {
      const info = await ctx.addResultAsLayer?.(state.resultUrl, {
        task: state.resultInfo?.task || refs.task.value,
        width: state.resultInfo?.width,
        height: state.resultInfo?.height,
        mask: state.submittedMask,
      });
      // 无论落层是否成功都退回主图视图：否则结果预览会盖住新图层，看起来像没生效。
      state.previewOn = false;
      refs.previewBtn.textContent = '画布预览';
      ctx.showResult?.(null);
      return info;
    } finally {
      refs.asLayerBtn.disabled = false;
    }
  });

  refs.adoptBtn.addEventListener('click', async () => {
    if (!state.resultUrl || state.busy) return;
    refs.adoptBtn.disabled = true;
    const entryId = state.resultEntryId;
    try {
      const info = await ctx.adoptResult?.(state.resultUrl, {
        task: state.resultInfo?.task || refs.task.value,
        width: state.resultInfo?.width,
        height: state.resultInfo?.height,
      });
      if (info) {
        if (entryId) {
          state.currentHistoryId = entryId;
          historyPanel?.setCurrent(entryId);
        }
        toastSuccess(`已载入新底图 ${info.width} × ${info.height}，可继续精修`);
      }
    } finally {
      refs.adoptBtn.disabled = false;
    }
  });

  refs.compareBtn.addEventListener('click', () => {
    const extra = [];
    if (state.resultUrl) extra.push({ url: state.resultUrl, label: '本次结果' });
    for (const item of runner.getResults?.() || []) {
      if (item.url && !extra.some((entry) => entry.url === item.url)) {
        extra.push({ url: item.url, label: item.label || '历史结果' });
      }
    }
    if (!extra.length) {
      toastWarn('还没有可对比的结果');
      return;
    }
    void compareAll({ extra, initialUrl: state.resultUrl });
  });

  /* ------------------------------------------------------------ 对外接口 */

  const controller = {
    /** D23.1：左侧图层栏复用同一套图层控制器。 */
    layerCtx: ctx,
    /** 主图/蒙版变化后刷新（尺寸、缩略图、叠加层列表、编辑历史会话） */
    refresh() {
      renderMeta();
      renderRefs();
      renderHistory();
    },
    /** 底图被替换（载入结果 / 打开新图）：清空结果态，避免旧预览残留 */
    resetResult() {
      state.resultUrl = '';
      state.previewOn = false;
      state.resultInfo = null;
      state.resultEntryId = '';
      refs.previewBtn.textContent = '画布预览';
      refs.resultActions.hidden = true;
      refs.adoptHint.hidden = true;
      refs.quality.hidden = true;
      refs.quality.innerHTML = '';
    },
    /** 换主图 / 载入结果：参考图与指令属于上一张图，清空避免串任务 */
    resetTaskContext() {
      state.refs = [];
      promptEditor.clear();
      refs.refInput.value = '';
      renderRefs();
      controller.resetResult();
      renderMeta();
    },
    /** studio 端画完蒙版后调用：只更新任务识别与提示，不做整图编码 */
    onMaskChanged(coverage) {
      // 显示**实际会执行**的任务，而不是「自动识别」猜到的任务：
      // 预设是「原生」时，指令写成「去掉耳环」也不会走移除流程（D29.2）。
      const detected = detectTask(promptEditor.getText(), coverage > 0);
      const effective = effectiveTask();
      const mismatch =
        detected !== effective && ['remove', 'outpaint', 'panorama'].includes(detected);
      refs.submitHint.textContent = `已圈选 ${fmtCoverage(coverage)} · 本次任务：${
        TASK_LABELS[effective] || effective
      }${mismatch ? `（指令像「${TASK_LABELS[detected]}」，需切到同名预设）` : ''}`;
      // 有没有蒙版会决定预设是否降级，及时刷新卡片与高级参数回显。
      renderPresets();
      advanced.refresh();
      renderMeta();
      syncGuardNote();
    },
    focusPrompt() {
      promptEditor.focus();
    },
    /** 图片对比：顶部按钮 / Shift+C 共用。 */
    compareAll,
    /** 宿主拖入 / 选择文件后批量加入参考图。 */
    addRefFiles(files) {
      return addRefFiles(files);
    },
    /** 宿主从统一导入选择器拿到 dataURL 条目后批量加入参考图。 */
    addRefItems(items) {
      return addRefItems(items);
    },
    /** 宿主销毁时解绑 document 级菜单监听。 */
    destroy() {
      document.removeEventListener('click', onRefMenuOutside);
      history?.destroy();
      history = null;
    },
    /** 本机工程恢复：把保存的 AI 现场写回面板（不改动已提交的任务）。 */
    restoreState(persist, refsData) {
      if (!persist) return;
      if (Array.isArray(refsData) && refsData.length) state.refs = refsData.slice(0, MAX_REFS);
      syncEditorRefs();
      promptEditor.setText(typeof persist.prompt === 'string' ? persist.prompt : '');
      if (persist.presetId) state.presetId = persist.presetId;
      state.appliedPreset = String(persist.appliedPreset || '');
      state.overrides = { ...(persist.overrides || {}) };
      guards.sync(protectionOf(currentPreset(), state.overrides));
      state.consistencyOn = persist.consistencyOn !== false;
      refs.consistency.checked = state.consistencyOn;
      refs.strength.disabled = !state.consistencyOn;
      setStrength(persist.consistencyStrength ?? state.consistencyStrength);
      state.customLoras = Array.isArray(persist.customLoras)
        ? persist.customLoras.slice(0, MAX_LORAS).map((item) => ({ ...item }))
        : [];
      if (persist.task) refs.task.value = persist.task;
      if (persist.sizeMode) refs.sizeMode.value = persist.sizeMode;
      if (persist.width) refs.width.value = persist.width;
      if (persist.height) refs.height.value = persist.height;
      if (persist.ratio) refs.ratio.value = persist.ratio;
      state.turboId = persist.turboId || '';
      state.turboUser = Boolean(persist.turboUser);
      if (state.turboId) refs.turbo.value = state.turboId;
      if (!state.turboUser) applyPresetTurbo();
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
      if (state.presets.length) {
        const preset = findPreset(state.presets, state.presetId);
        if (preset && state.appliedPreset !== state.presetId) {
          state.overrides = resetDefinedOverrides(preset, state.overrides);
          applyPresetDefaults(preset);
        }
      }
      syncPrompt();
      syncBusy();
      syncTaskHint();
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
        prompt: promptEditor.getText(),
        refs: state.refs.map((item) => ({
          id: item.id,
          name: item.name,
          dataUrl: item.dataUrl,
          width: item.width,
          height: item.height,
        })),
        presetId: state.presetId,
        overrides: { ...state.overrides },
        customLoras: state.customLoras.map((item) => ({ ...item })),
        task: refs.task.value,
        sizeMode: refs.sizeMode.value,
        width: refs.width.value,
        height: refs.height.value,
        ratio: refs.ratio.value,
        turboId: state.turboId,
        turboUser: state.turboUser,
        appliedPreset: state.appliedPreset,
        consistencyOn: state.consistencyOn,
        consistencyStrength: state.consistencyStrength,
        resultUrl: state.resultUrl,
        resultInfo: state.resultInfo ? { ...state.resultInfo } : null,
      };
    },
    /** 扩图面板点「生成扩图」：补默认指令、切 outpaint 任务后直接提交。 */
    submitOutpaint() {
      if (!promptEditor.getText().trim()) {
        promptEditor.setText('移除图像中的灰色区域，无缝自然延展为完整图像。');
      }
      refs.task.value = 'outpaint';
      syncGuardNote();
      renderMeta();
      return submit();
    },
    /**
     * 宿主快捷入口（如选区「AI 消除」）：切预设 / 任务并填入指令，
     * 只做准备、不自动提交，避免用户没确认就消耗一次生成。
     */
    prepareTask({ preset = '', task = '', prompt = '' } = {}) {
      if (preset && findPreset(state.presets, preset)) selectPreset(preset);
      if (task) {
        refs.task.value = task;
        syncTaskHint();
      }
      if (prompt) promptEditor.setText(prompt);
      renderMeta();
      syncGuardNote();
      promptEditor.focus();
      notifyPersist();
    },
  };

  syncEditorRefs();
  syncPrompt();
  syncBusy();
  renderRefs();
  renderMeta();
  syncGuardNote();
  loadOptions();
  loadPresetMeta();
  // 全局设置保存后：重新拉取预设 / 自定义搭配，并套用新的默认值。
  window.addEventListener('presets:updated', () => {
    if (!host.isConnected) return;
    state.appliedPreset = '';
    state.presets = [];
    loadPresetMeta();
  });

  return controller;
}
