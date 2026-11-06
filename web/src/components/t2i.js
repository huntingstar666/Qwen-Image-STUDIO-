/**
 * 「文生图」页面。
 * 职责：
 * 1. 大提示词 / 负向提示词输入；
 * 2. 比例选择（来自 /api/options.ratios，显示实际 w×h 并标注 32 的倍数）与自定义尺寸；
 * 3. 步数 / CFG / 种子 / 批量 / 采样器 / 调度器；
 * 4. Turbo 开关（turbo_profiles 的 8 段 sigma 可见可改）；
 * 5. 透明背景、LoRA 多选（强度可调）、模型选择；
 * 6. 提示词上方嵌入风格选择器（风格 / MJ 码图 / 滤镜 / 视角，弹窗选择，chip 展示），
 *    提交时用 vendor 的 buildNodePrompt 合成到提示词；
 * 7. 提示词润色（POST /api/polish）对比弹窗：原文 / 润色后 / wh_ratio，可接受或回退；
 * 8. 提交 POST /api/generate，右侧 JobRunner 轮询展示进度与结果。
 */

import { api } from '../api.js';
import { getPrompt, on, patchSettings, setPrompt, store } from '../store.js';
import { toastSuccess, toastWarn } from './toast.js';
import { polishWithDialog } from './polish.js';
import { JobRunner } from './jobView.js';
import { consumeT2IHandoff } from '../handoff.js';
import { createStylePicker } from './stylePicker.js';
import { LoraPicker, ModelsField, TurboControl } from './controls.js';
import { escapeHtml, fmtNum, snapUp } from '../utils.js';

const FALLBACK_RATIOS = [
  { id: '1:1', label: '1:1 方形', w: 2048, h: 2048 },
  { id: '4:3', label: '4:3 横幅', w: 2048, h: 1536 },
  { id: '3:4', label: '3:4 竖幅', w: 1536, h: 2048 },
  { id: '16:9', label: '16:9 宽银幕', w: 2048, h: 1152 },
  { id: '9:16', label: '9:16 竖屏', w: 1152, h: 2048 },
  { id: '3:2', label: '3:2 相机', w: 2040, h: 1360 },
];

const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'res_multistep', 'lcm'];
const FALLBACK_SCHEDULERS = ['simple', 'normal', 'beta', 'karras', 'exponential', 'sgm_uniform', 'ddim_uniform'];

const FALLBACK_STEPS_PRESETS = [
  { id: 'fast', label: '快速 · 15 步', steps: 15, cfg: 4.0, note: '草稿' },
  { id: 'standard', label: '标准 · 25 步', steps: 25, cfg: 4.0, note: '日常' },
  { id: 'quality', label: '精细 · 40 步', steps: 40, cfg: 4.0, note: '出片' },
  { id: 'turbo8', label: 'Turbo · 8 步', steps: 8, cfg: 1.0, note: '需 Turbo' },
];

export function createT2IPage(host) {
  const t2i = store.state.t2i;

  host.innerHTML = `
    <div class="page page-t2i">
      <div class="col col-side">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">提示词 <span class="panel-sub">描述画面内容</span></div>
            <div class="panel-actions">
              <button class="btn violet sm" type="button" data-ref="polish">✦ 润色提示词</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="field">
              <span class="field-label">正向提示词 <span class="tag-hint" data-ref="promptCount">0 字</span></span>
              <div data-ref="stylePicker"></div>
              <textarea class="textarea prompt-main" data-ref="prompt" spellcheck="false"
                placeholder="例如：清晨薄雾中的东方古镇，青石板路湿润反光，屋檐下挂着红灯笼，电影感，冷调晨光。"></textarea>
              <div class="field-row">
                <span class="field-hint">正文保持你的原文；上方选中的风格 / MJ 码 / 视角会在提交时自动合成进提示词。</span>
                <span class="spacer"></span>
                <button class="btn ghost sm" type="button" data-ref="clearPrompt">清空</button>
              </div>
            </div>
            <div class="field">
              <span class="field-label">负向提示词 <span class="tag-hint">可选</span></span>
              <textarea class="textarea" data-ref="negative" rows="2" spellcheck="false"
                placeholder="不希望出现的内容，例如：文字、水印、模糊、畸变"></textarea>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">画面尺寸 <span class="panel-sub">官方 2K 比例 · 32 的倍数</span></div>
          </div>
          <div class="panel-body">
            <div class="ratio-grid" data-ref="ratios"></div>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">宽度 <span class="tag-hint">32 倍数</span></span>
                <input class="input mono" type="number" min="256" max="4096" step="32" data-ref="width" />
              </label>
              <label class="field">
                <span class="field-label">高度 <span class="tag-hint">32 倍数</span></span>
                <input class="input mono" type="number" min="256" max="4096" step="32" data-ref="height" />
              </label>
            </div>
            <div class="size-summary">
              <span>输出</span><span class="mono" data-ref="sizeSummary">—</span>
              <span class="spacer"></span>
              <span class="field-hint">宽高会自动向上对齐到 32 的倍数</span>
            </div>
            <div class="field">
              <span class="field-label">采样步数预设</span>
              <div class="chips" data-ref="stepsPresets"></div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div class="panel-title">采样参数</div></div>
          <div class="panel-body">
            <div class="grid-3">
              <label class="field">
                <span class="field-label">步数 <span class="locked-note hidden" data-ref="turboLock">Turbo 锁定</span></span>
                <input class="input mono" type="number" min="1" max="200" step="1" data-ref="steps" />
              </label>
              <label class="field">
                <span class="field-label">CFG</span>
                <input class="input mono" type="number" min="0" max="20" step="0.1" data-ref="cfg" />
              </label>
              <label class="field">
                <span class="field-label">批量</span>
                <input class="input mono" type="number" min="1" max="8" step="1" data-ref="batch" />
              </label>
            </div>
            <div class="field">
              <span class="field-label">种子 <span class="tag-hint">留空 = 每次随机</span></span>
              <div class="field-row">
                <input class="input mono" data-ref="seed" placeholder="随机" inputmode="numeric" />
                <button class="btn ghost sm" type="button" data-ref="randomSeed">随机</button>
                <button class="btn ghost sm" type="button" data-ref="reuseSeed" disabled>填入上次</button>
              </div>
            </div>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">采样器</span>
                <select class="select" data-ref="sampler"></select>
              </label>
              <label class="field">
                <span class="field-label">调度器</span>
                <select class="select" data-ref="scheduler"></select>
              </label>
            </div>
            <div data-ref="turboHost"></div>
            <div class="field">
              <label class="switch">
                <input type="checkbox" data-ref="rgba" />
                <span class="switch-track"></span>
                <span class="switch-label">透明背景（RGBA）<small>输出带 alpha 通道的 PNG</small></span>
              </label>
            </div>
          </div>
        </section>

        <details class="fold">
          <summary>高级：模型与 LoRA</summary>
          <div class="fold-body">
            <div data-ref="modelsHost"></div>
            <div class="field">
              <span class="field-label">LoRA <span class="tag-hint">勾选启用 · 可调强度</span></span>
              <div data-ref="loraHost"></div>
            </div>
          </div>
        </details>

      </div>

      <div class="col col-sticky">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">生成结果</div>
            <div class="panel-actions"><span class="panel-sub" data-ref="resultState">等待任务</span></div>
          </div>
          <div data-ref="resultHost"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><div class="panel-title">当前参数摘要</div></div>
          <div class="panel-body tight" data-ref="summary"></div>
        </section>
      </div>

    <!-- 操作条作为 page 网格的整行（grid-column: 1 / -1），粘底时横跨整页 -->
    <div class="action-bar card" data-ref="actionBar">
      <div class="action-strip" data-ref="actionStrip"></div>
      <div>
        <div class="field-hint" style="margin-bottom:2px" data-ref="readyHint">引擎就绪后可直接生成</div>
        <div class="hint" data-ref="actionHint">首次生成需要加载模型，可能要等待一段时间</div>
      </div>
      <span class="spacer"></span>
      <span class="action-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 生成</span>
      <button class="btn ghost" type="button" data-ref="reset">重置参数</button>
      <button class="btn primary lg" type="button" data-ref="generate">开始生成</button>
    </div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    prompt: ref('prompt'),
    promptCount: ref('promptCount'),
    negative: ref('negative'),
    polish: ref('polish'),
    clearPrompt: ref('clearPrompt'),
    ratios: ref('ratios'),
    width: ref('width'),
    height: ref('height'),
    sizeSummary: ref('sizeSummary'),
    stepsPresets: ref('stepsPresets'),
    steps: ref('steps'),
    cfg: ref('cfg'),
    batch: ref('batch'),
    seed: ref('seed'),
    randomSeed: ref('randomSeed'),
    reuseSeed: ref('reuseSeed'),
    sampler: ref('sampler'),
    scheduler: ref('scheduler'),
    turboHost: ref('turboHost'),
    turboLock: ref('turboLock'),
    rgba: ref('rgba'),
    modelsHost: ref('modelsHost'),
    loraHost: ref('loraHost'),
    generate: ref('generate'),
    reset: ref('reset'),
    readyHint: ref('readyHint'),
    actionHint: ref('actionHint'),
    actionBar: ref('actionBar'),
    actionStrip: ref('actionStrip'),
    resultHost: ref('resultHost'),
    resultState: ref('resultState'),
    summary: ref('summary'),
    stylePicker: ref('stylePicker'),
  };

  const jobRunner = new JobRunner(refs.resultHost, {
    idleText: '设置参数后点击「开始生成」，进度与结果会显示在这里。',
  });

  // 提示词上方的风格选择器（本页独立选择集合）
  const stylePicker = createStylePicker(refs.stylePicker, { scope: 't2i' });
  stylePicker.attachPrompt(refs.prompt);

  let turboControl = null;
  let loraPicker = null;
  let turboSnapshot = null; // 开 Turbo 前的 steps/cfg/sampler，关掉时还原
  let modelsField = null;
  let lastSeed = null;

  /* ---------------- 提示词 ---------------- */
  function updatePromptCount() {
    const length = refs.prompt.value.length;
    refs.promptCount.textContent = `${length} 字`;
  }

  refs.prompt.value = getPrompt();
  updatePromptCount();
  refs.prompt.addEventListener('input', () => {
    setPrompt(refs.prompt.value);
    updatePromptCount();
  });
  refs.clearPrompt.addEventListener('click', () => {
    refs.prompt.value = '';
    setPrompt('');
    updatePromptCount();
    refs.prompt.focus();
  });
  refs.negative.value = t2i.negativePrompt || '';
  refs.negative.addEventListener('input', () => {
    t2i.negativePrompt = refs.negative.value;
    patchSettings({ t2i: { negativePrompt: refs.negative.value } });
  });
  on('prompt:change', (event) => {
    const value = String(event.detail ?? '');
    if (document.activeElement === refs.prompt) return;
    if (refs.prompt.value !== value) {
      refs.prompt.value = value;
      updatePromptCount();
    }
  });

  /* ---------------- 尺寸 ---------------- */
  function ratioList() {
    const ratios = store.state.options?.ratios;
    return Array.isArray(ratios) && ratios.length ? ratios : FALLBACK_RATIOS;
  }

  function renderRatios() {
    const ratios = ratioList();
    const currentW = Number(refs.width.value) || t2i.width;
    const currentH = Number(refs.height.value) || t2i.height;
    refs.ratios.innerHTML = ratios
      .map((ratio) => {
        const active = ratio.w === currentW && ratio.h === currentH;
        return `
          <button class="ratio-btn ${active ? 'active' : ''}" type="button" data-ratio="${escapeHtml(ratio.id)}"
            data-w="${ratio.w}" data-h="${ratio.h}" title="${escapeHtml(ratio.label || ratio.id)} · ${ratio.w} × ${ratio.h}">
            <span class="ratio-name">${escapeHtml(ratio.label || ratio.id)}</span>
            <span class="ratio-dims">${fmtNum(ratio.w)} × ${fmtNum(ratio.h)}</span>
          </button>`;
      })
      .join('');
    refs.ratios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.addEventListener('click', () => {
        t2i.width = Number(button.dataset.w);
        t2i.height = Number(button.dataset.h);
        t2i.ratioId = button.dataset.ratio;
        t2i.custom = false;
        patchSettings({ t2i: { width: t2i.width, height: t2i.height, ratioId: t2i.ratioId, custom: false } });
        syncSizeFields();
      });
    });
  }

  function syncSizeFields() {
    refs.width.value = String(t2i.width);
    refs.height.value = String(t2i.height);
    const width = Number(refs.width.value) || 0;
    const height = Number(refs.height.value) || 0;
    const snappedW = snapUp(width);
    const snappedH = snapUp(height);
    const snapNote = snappedW !== width || snappedH !== height ? `（将自动对齐为 ${snappedW} × ${snappedH}）` : ' · 32 的倍数 ✓';
    refs.sizeSummary.textContent = `${fmtNum(snappedW)} × ${fmtNum(snappedH)}${snapNote}`;
    for (const button of refs.ratios.querySelectorAll('[data-ratio]')) {
      const active = Number(button.dataset.w) === width && Number(button.dataset.h) === height;
      button.classList.toggle('active', active);
    }
    updateSummary();
  }

  function commitSizeInputs() {
    const width = snapUp(refs.width.value);
    const height = snapUp(refs.height.value);
    t2i.width = width;
    t2i.height = height;
    t2i.custom = true;
    t2i.ratioId = '';
    patchSettings({ t2i: { width, height, custom: true, ratioId: '' } });
    syncSizeFields();
  }

  refs.width.addEventListener('change', commitSizeInputs);
  refs.height.addEventListener('change', commitSizeInputs);

  function renderStepsPresets() {
    const presets = Array.isArray(store.state.options?.steps_presets) && store.state.options.steps_presets.length
      ? store.state.options.steps_presets
      : FALLBACK_STEPS_PRESETS;
    refs.stepsPresets.innerHTML = presets
      .map(
        (preset) => `
        <button class="chip" type="button" data-steps="${preset.steps}" data-cfg="${preset.cfg}" title="${escapeHtml(preset.note || '')}">
          ${escapeHtml(preset.label || preset.id)}
          <small>${preset.steps}步 · cfg ${preset.cfg}</small>
        </button>`,
      )
      .join('');
    refs.stepsPresets.querySelectorAll('[data-steps]').forEach((button) => {
      button.addEventListener('click', () => {
        refs.steps.value = button.dataset.steps;
        refs.cfg.value = button.dataset.cfg;
        t2i.steps = Number(button.dataset.steps);
        t2i.cfg = Number(button.dataset.cfg);
        patchSettings({ t2i: { steps: t2i.steps, cfg: t2i.cfg } });
        updateSummary();
      });
    });
  }

  /* ---------------- 采样器 ---------------- */
  function renderSelects() {
    const samplers = Array.isArray(store.state.options?.samplers) && store.state.options.samplers.length
      ? store.state.options.samplers
      : FALLBACK_SAMPLERS;
    const schedulers = Array.isArray(store.state.options?.schedulers) && store.state.options.schedulers.length
      ? store.state.options.schedulers
      : FALLBACK_SCHEDULERS;
    refs.sampler.innerHTML = samplers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    refs.scheduler.innerHTML = schedulers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (samplers.includes(t2i.sampler)) refs.sampler.value = t2i.sampler;
    if (schedulers.includes(t2i.scheduler)) refs.scheduler.value = t2i.scheduler;
  }

  /* ---------------- 采样字段 ---------------- */
  refs.steps.value = String(t2i.steps);
  refs.cfg.value = String(t2i.cfg);
  refs.batch.value = String(t2i.batch);
  refs.seed.value = t2i.seed ?? '';
  refs.rgba.checked = Boolean(t2i.rgba);

  refs.steps.addEventListener('change', () => {
    t2i.steps = Math.max(1, Math.round(Number(refs.steps.value) || 25));
    refs.steps.value = String(t2i.steps);
    patchSettings({ t2i: { steps: t2i.steps } });
    updateSummary();
  });
  refs.cfg.addEventListener('change', () => {
    t2i.cfg = Math.max(0, Number(refs.cfg.value) || 1);
    refs.cfg.value = String(t2i.cfg);
    patchSettings({ t2i: { cfg: t2i.cfg } });
    updateSummary();
  });
  refs.batch.addEventListener('change', () => {
    t2i.batch = Math.max(1, Math.min(8, Math.round(Number(refs.batch.value) || 1)));
    refs.batch.value = String(t2i.batch);
    patchSettings({ t2i: { batch: t2i.batch } });
    updateSummary();
  });
  refs.seed.addEventListener('input', () => {
    t2i.seed = refs.seed.value.trim();
    patchSettings({ t2i: { seed: t2i.seed } });
  });
  refs.randomSeed.addEventListener('click', () => {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    refs.seed.value = String(seed);
    t2i.seed = String(seed);
    patchSettings({ t2i: { seed: t2i.seed } });
  });
  refs.reuseSeed.addEventListener('click', () => {
    if (lastSeed == null) return;
    refs.seed.value = String(lastSeed);
    t2i.seed = String(lastSeed);
    patchSettings({ t2i: { seed: t2i.seed } });
    toastSuccess(`已填入上次种子 ${lastSeed}`);
  });
  refs.sampler.addEventListener('change', () => {
    t2i.sampler = refs.sampler.value;
    patchSettings({ t2i: { sampler: t2i.sampler } });
    updateSummary();
  });
  refs.scheduler.addEventListener('change', () => {
    t2i.scheduler = refs.scheduler.value;
    patchSettings({ t2i: { scheduler: t2i.scheduler } });
    updateSummary();
  });
  refs.rgba.addEventListener('change', () => {
    t2i.rgba = refs.rgba.checked;
    patchSettings({ t2i: { rgba: t2i.rgba } });
    updateSummary();
  });

  function renderTurbo() {
    const profiles = store.state.options?.turbo_profiles || [];
    turboControl = new TurboControl(refs.turboHost, {
      profiles,
      loras: store.state.options?.models?.turbo_lora || [],
      initial: {
        enabled: Boolean(t2i.turbo),
        profile: t2i.turboProfile || '',
        sigmas: t2i.sigmas || '',
        lora: t2i.turboLora ?? null,
        loraStrength: t2i.turboLoraStrength ?? null,
      },
      help: store.state.options?.turbo_sigmas_help || '',
      onChange: (value) => {
        // 开 Turbo 时记住原采样参数，关掉时还原（否则会一直停在 8 步 / cfg 1）
        if (value.enabled && !turboSnapshot) {
          turboSnapshot = {
            steps: Number(refs.steps.value) || 25,
            cfg: Number(refs.cfg.value) || 1,
            sampler: refs.sampler.value || 'euler',
          };
        }
        let restored = null;
        if (!value.enabled) {
          restored = turboSnapshot || { steps: 25, cfg: 1, sampler: 'euler' };
          turboSnapshot = null;
        }
        t2i.turbo = value.enabled;
        t2i.turboProfile = value.profile;
        t2i.sigmas = value.sigmasText || '';
        t2i.turboLora = value.lora;
        t2i.turboLoraStrength = value.loraStrength;
        if (restored) {
          t2i.steps = restored.steps;
          t2i.cfg = restored.cfg;
          t2i.sampler = restored.sampler;
          refs.steps.value = String(restored.steps);
          refs.cfg.value = String(restored.cfg);
          if ([...refs.sampler.options].some((o) => o.value === restored.sampler)) {
            refs.sampler.value = restored.sampler;
          }
          patchSettings({
            t2i: {
              turbo: false, turboProfile: value.profile, sigmas: value.sigmasText || '',
              turboLora: value.lora, turboLoraStrength: value.loraStrength,
              steps: restored.steps, cfg: restored.cfg, sampler: restored.sampler,
            },
          });
          toastSuccess(`已关闭 Turbo，采样参数还原为 ${restored.steps} 步 · CFG ${restored.cfg}`);
        } else {
          patchSettings({ t2i: { turbo: value.enabled, turboProfile: value.profile, sigmas: value.sigmasText || '',
                                  turboLora: value.lora, turboLoraStrength: value.loraStrength } });
        }
        applyTurboToFields();
        updateSummary();
      },
    });
    applyTurboToFields(false);
    // 历史遗留：之前 Turbo 关掉后步数停在 8，这里纠正一次（8 步只在 Turbo 下有意义）
    if (!t2i.turbo && Number(refs.steps.value) < 12) {
      refs.steps.value = '25';
      t2i.steps = 25;
      patchSettings({ t2i: { steps: 25 } });
    }
  }

  function applyTurboToFields(overwriteValues = true) {
    if (!turboControl) return;
    const enabled = turboControl.getValue().enabled;
    const profile = turboControl.selectedProfile();
    refs.turboLock.classList.toggle('hidden', !enabled);
    refs.steps.disabled = enabled;
    refs.cfg.disabled = enabled;
    refs.sampler.disabled = enabled;
    if (enabled && profile && overwriteValues) {
      if (profile.steps) {
        refs.steps.value = String(profile.steps);
        t2i.steps = Number(profile.steps);
      }
      if (profile.cfg != null) {
        refs.cfg.value = String(profile.cfg);
        t2i.cfg = Number(profile.cfg);
      }
      if (profile.sampler && [...refs.sampler.options].some((o) => o.value === profile.sampler)) {
        refs.sampler.value = profile.sampler;
        t2i.sampler = profile.sampler;
      }
      patchSettings({ t2i: { steps: t2i.steps, cfg: t2i.cfg, sampler: t2i.sampler } });
    }
    updateSummary();
  }

  function renderLoras() {
    const loras = store.state.options?.models?.lora || [];
    loraPicker = new LoraPicker(refs.loraHost, { loras, initial: t2i.loras });
    loraPicker.host.addEventListener('change', () => {
      t2i.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ t2i: { loras: t2i.loras } });
      updateSummary();
    });
    loraPicker.host.addEventListener('input', () => {
      t2i.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ t2i: { loras: t2i.loras } });
    });
  }

  function renderModels() {
    modelsField = new ModelsField(refs.modelsHost, {
      models: store.state.options?.models || {},
      initial: { unet: t2i.unet, clip: t2i.clip, vae: t2i.vae },
    });
    refs.modelsHost.addEventListener('change', () => {
      const value = modelsField.getValue();
      t2i.unet = value.unet || '';
      t2i.clip = value.clip || '';
      t2i.vae = value.vae || '';
      patchSettings({ t2i: { unet: t2i.unet, clip: t2i.clip, vae: t2i.vae } });
    });
  }

  /* ---------------- 参数摘要 ---------------- */
  function updateSummary() {
    if (!refs.summary) return;
    const width = snapUp(refs.width.value || t2i.width);
    const height = snapUp(refs.height.value || t2i.height);
    const turboValue = turboControl?.getValue();
    const turboOn = Boolean(turboValue?.enabled);
    const loraCount = Object.keys(t2i.loras || {}).length;
    const turboLoraName = turboOn && turboValue.lora && turboValue.lora !== 'none'
      ? String(turboValue.lora).split('/').pop()
      : '';
    const loraText = [
      loraCount ? `${loraCount} 个手动` : '',
      turboLoraName ? `加速 ${turboLoraName}` : (turboOn ? '不挂加速' : ''),
    ].filter(Boolean).join(' + ') || '无';
    const rows = [
      ['尺寸', `${fmtNum(width)} × ${fmtNum(height)}`],
      ['步数 / CFG', `${refs.steps.value} / ${refs.cfg.value}`],
      ['采样', `${refs.sampler.value} · ${refs.scheduler.value}`],
      ['Turbo', turboOn ? `${turboValue.profile || '自定义'}` : '关闭'],
      ['批量', refs.batch.value],
      ['LoRA', loraText],
      ['透明背景', refs.rgba.checked ? '是' : '否'],
    ];
    refs.summary.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="field-row"><span class="field-hint" style="min-width:74px">${label}</span><span class="mono" style="font-size:11px">${escapeHtml(String(value))}</span></div>`,
      )
      .join('');
    if (turboOn) {
      refs.actionHint.textContent = turboLoraName
        ? `Turbo 模式 · 加速 LoRA：${turboLoraName}`
        : 'Turbo 模式：不挂加速 LoRA（基座 + 官方 sigma）';
    } else {
      refs.actionHint.textContent = '首次生成需要加载模型，可能要等待一段时间';
    }
  }

  /* ---------------- 启动 / 刷新 ---------------- */
  function refreshAll() {
    renderRatios();
    syncSizeFields();
    renderStepsPresets();
    renderSelects();
    renderTurbo();
    renderLoras();
    renderModels();
    updateSummary();
    renderHealthHint();
  }

  function renderHealthHint() {
    const health = store.state.health;
    if (!health) {
      refs.readyHint.textContent = '等待后端连接…';
      refs.readyHint.style.color = 'var(--warn)';
      return;
    }
    const ready = Boolean(health.engine?.ready ?? health.engine?.available);
    refs.readyHint.textContent = ready ? '引擎已就绪' : `引擎不可用：${health.engine?.reason || '请检查后端日志'}`;
    refs.readyHint.style.color = ready ? 'var(--ok)' : 'var(--warn)';
  }

  renderRatios();
  syncSizeFields();
  renderStepsPresets();
  renderSelects();
  renderTurbo();
  renderLoras();
  renderModels();
  updateSummary();
  renderHealthHint();
  on('options:loaded', () => refreshAll());
  // health 变化通过 store 订阅刷新「引擎就绪」提示
  store.subscribe(() => renderHealthHint());

  /* ---------------- 润色 ---------------- */
  function applyRatioByText(text) {
    const target = String(text || '').trim();
    if (!target) return false;
    const normalized = target.replace(/\s+/g, '');
    const ratios = ratioList();
    const match = ratios.find((ratio) => ratio.id === normalized);
    if (!match) return false;
    t2i.width = match.w;
    t2i.height = match.h;
    t2i.ratioId = match.id;
    t2i.custom = false;
    patchSettings({ t2i: { width: match.w, height: match.h, ratioId: match.id, custom: false } });
    syncSizeFields();
    return true;
  }

  async function handlePolish() {
    await polishWithDialog({
      prompt: refs.prompt.value,
      mode: 't2i',
      model: store.state.polishModel || null,
      button: refs.polish,
      ratios: ratioList(),
      onAccept: (text, _result, extra) => {
        refs.prompt.value = text;
        setPrompt(text);
        updatePromptCount();
        if (extra?.applyRatio && extra.ratio) applyRatioByText(extra.ratio.id);
      },
    });
  }

  refs.polish.addEventListener('click', handlePolish);

  /* ---------------- 生成 ---------------- */
  function collectPayload() {
    const width = snapUp(refs.width.value || t2i.width);
    const height = snapUp(refs.height.value || t2i.height);
    refs.width.value = String(width);
    refs.height.value = String(height);
    t2i.width = width;
    t2i.height = height;

    const turboValue = turboControl.getValue();
    const seedText = refs.seed.value.trim();
    const seed = seedText === '' ? null : Math.max(0, Math.floor(Number(seedText)));
    const loras = loraPicker.getValue();
    const models = modelsField.getValue();
    const pickerMeta = stylePicker.getMeta();

    return {
      // 正文保持原文，预设/视角在这里合成为最终提示词
      prompt: stylePicker.composePrompt(refs.prompt.value.trim()),
      negative_prompt: refs.negative.value.trim(),
      width,
      height,
      steps: Number(refs.steps.value) || 25,
      cfg: Number(refs.cfg.value) || 4.0,
      seed: Number.isFinite(seed) ? seed : null,
      batch: Number(refs.batch.value) || 1,
      sampler: refs.sampler.value || 'euler',
      scheduler: refs.scheduler.value || 'simple',
      turbo: {
        enabled: turboValue.enabled,
        profile: turboValue.profile,
        sigmas: turboValue.enabled ? turboValue.sigmas : null,
        lora: turboValue.enabled ? turboValue.lora : null,
        lora_strength: turboValue.enabled ? turboValue.loraStrength : null,
      },
      rgba: refs.rgba.checked,
      models: {
        unet: models.unet || '',
        clip: models.clip || '',
        vae: models.vae || '',
      },
      loras,
      meta: {
        source: 'web/t2i',
        ratio: t2i.ratioId || null,
        rawPrompt: refs.prompt.value.trim(),
        creativePresets: pickerMeta.creativePresets,
        imageAngle: pickerMeta.imageAngle,
        client: 'qwen-image2.1-web',
      },
    };
  }

  const DEFAULT_ACTION_HINT = '首次生成需要加载模型，可能要等待一段时间';

  /** 把任务进度同步到底部操作条：条永远可见，用户不用滚到结果面板看进度。 */
  function syncActionProgress(job) {
    if (!refs.actionBar) return;
    if (!job) {
      refs.actionBar.classList.remove('is-running', 'is-done', 'is-error');
      if (refs.actionStrip) refs.actionStrip.style.width = '0%';
      refs.actionHint.textContent = DEFAULT_ACTION_HINT;
      return;
    }
    const p = job.progress || {};
    const max = Number(p.max) || 0;
    const value = Number(p.value) || 0;
    const percent = max ? Math.min(100, Math.round((value / max) * 100)) : 12;
    if (refs.actionStrip) refs.actionStrip.style.width = `${percent}%`;
    refs.actionBar.classList.toggle('is-running', job.status === 'running' || job.status === 'queued');
    refs.actionBar.classList.toggle('is-done', job.status === 'done');
    refs.actionBar.classList.toggle('is-error', job.status === 'error');
    const parts = [];
    if (job.status === 'queued') parts.push('排队中');
    else if (job.status === 'running') parts.push(`进行中 ${max ? `${value}/${max}` : ''}`.trim());
    else if (job.status === 'done') parts.push('已完成');
    else if (job.status === 'error') parts.push(`失败：${job.error || '未知错误'}`);
    else if (job.status === 'canceled') parts.push('已取消');
    if (p.label) parts.push(p.label);
    if (job.elapsed_ms) parts.push(`${(job.elapsed_ms / 1000).toFixed(1)}s`);
    refs.actionHint.textContent = parts.join(' · ') || DEFAULT_ACTION_HINT;
  }

  async function handleGenerate() {
    syncActionProgress(null);
    if (refs.generate.disabled) return;
    const rawPrompt = refs.prompt.value.trim();
    if (!rawPrompt) {
      toastWarn('请先填写正向提示词');
      refs.prompt.focus();
      return;
    }
    refs.generate.disabled = true;
    refs.generate.innerHTML = '<span class="spin"></span>生成中…';
    try {
      // 等 vendor 模块就绪，确保预设能合成进提示词
      await stylePicker.ensureVendor();
      if (stylePicker.hasSelection() && !stylePicker.isReady()) {
        toastWarn('风格模块未就绪：本次将只使用原始提示词（可稍后重试）');
      }
      const payload = collectPayload();
      if (payload.turbo.enabled && payload.turbo.sigmas === null && !payload.turbo.profile) {
        toastWarn('Turbo 已开启但没有可用 sigma，请选择调度方案或手动填写 sigma');
        return;
      }
      refs.resultState.textContent = '任务进行中';
      await jobRunner.start({
        create: () => api.generate(payload),
        prompt: payload.prompt,
        favoriteMeta: {
          kind: 't2i',
          category: '未分类',
          params: {
            width: payload.width,
            height: payload.height,
            steps: payload.steps,
            cfg: payload.cfg,
            batch: payload.batch,
            sampler: payload.sampler,
            scheduler: payload.scheduler,
            rgba: payload.rgba,
          },
        },
        onProgress: syncActionProgress,
        onDone: (job) => {
          refs.resultState.textContent = '已完成';
          const seed = job?.params?.seed;
          if (seed != null) {
            lastSeed = seed;
            refs.reuseSeed.disabled = false;
          }
          refreshHealthSoon();
        },
      });
    } finally {
      refs.generate.disabled = false;
      refs.generate.textContent = '开始生成';
    }
  }

  refs.generate.addEventListener('click', handleGenerate);
  // Ctrl/Cmd + Enter 直接开始生成（长表单里最实用）
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleGenerate();
    }
  });

  refs.reset.addEventListener('click', () => {
    const defaults = { steps: 25, cfg: 4.0, batch: 1, seed: '', sampler: 'euler', scheduler: 'simple', rgba: false, turbo: false };
    Object.assign(t2i, defaults);
    patchSettings({ t2i: defaults });
    refs.seed.value = '';
    refs.rgba.checked = false;
    renderSelects();
    renderTurbo();
    syncSizeFields();
    updateSummary();
    toastSuccess('采样参数已重置');
  });

  function refreshHealthSoon() {
    // 生成结束后让顶栏尽快刷新一次显存 / 队列
    setTimeout(() => {
      api.health().then((health) => {
        store.patchRuntime({ health });
      }).catch(() => {});
    }, 800);
  }

  /** 消费作品画廊 / 素材仓库发来的提示词交接。 */
  function applyT2IHandoff() {
    const payload = consumeT2IHandoff();
    if (!payload) return;
    refs.prompt.value = payload.prompt;
    setPrompt(payload.prompt);
    updatePromptCount();
    if (payload.negativePrompt) {
      refs.negative.value = payload.negativePrompt;
      t2i.negativePrompt = payload.negativePrompt;
      patchSettings({ t2i: { negativePrompt: payload.negativePrompt } });
    }
    if (payload.seed != null) {
      refs.seed.value = String(payload.seed);
      t2i.seed = String(payload.seed);
      patchSettings({ t2i: { seed: String(payload.seed) } });
    }
    if (payload.width && payload.height) {
      t2i.width = snapUp(payload.width);
      t2i.height = snapUp(payload.height);
      t2i.custom = true;
      t2i.ratioId = '';
      patchSettings({
        t2i: { width: t2i.width, height: t2i.height, custom: true, ratioId: '' },
      });
      syncSizeFields();
    }
    refs.prompt.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toastSuccess(payload.toast);
  }

  return {
    onShow() {
      renderHealthHint();
      applyT2IHandoff();
    },
  };
}

/* 让 store 的 patchRuntime 在 health 变化时能刷新提示（保持可读性的小补丁） */
