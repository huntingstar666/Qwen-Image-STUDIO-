/**
 * 「文生图」页面。
 * 职责：
 * 1. 大提示词 / 负向提示词输入；
 * 2. 比例选择（来自 /api/options.ratios，显示实际 w×h 并标注 32 的倍数）与自定义尺寸；
 * 3. 步数 / CFG / 种子 / 批量 / 采样器 / 调度器；
 * 4. Turbo 开关（按 turbo_profiles 预设自动套用调度 / 加速 LoRA / 底模）；
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
import { createHistoryRail } from './historyRail.js';
import { consumeT2IHandoff } from '../handoff.js';
import { createStylePicker } from './stylePicker.js';
import { openPoseStudio } from './poseStudio.js';
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

/** 尺寸卡片的分辨率档位：按长边计算，2K 优先用后端官方比例值。 */
const SIZE_TIERS = [
  { value: 512, label: '512' },
  { value: 1024, label: '1K' },
  { value: 2048, label: '2K' },
  { value: 4096, label: '4K' },
];

/** 卡片比例网格（5 列，顺序与设计稿一致）。 */
const SIZE_RATIOS = [
  '1:1', '2:3', '3:2', '9:16', '16:9',
  '3:4', '4:3', '5:4', '4:5', '21:9',
  '1:4', '1:8', '4:1', '8:1', '2:1',
];

export function createT2IPage(host) {
  const t2i = store.state.t2i;

  host.innerHTML = `
    <div class="page wb-page page-t2i-v2">
      <div class="wb-layout" data-ref="layout">
        <aside class="wb-adv" data-ref="advDrawer" aria-label="文生图高级设置">
          <div class="wb-adv-head">
            <span>文生图高级设置</span>
            <button class="wb-adv-close" type="button" data-ref="advClose" title="收起侧边栏">×</button>
          </div>
          <div class="wb-adv-body">
            <section class="panel">
              <div class="panel-head">
                <div class="panel-title">画面尺寸 <span class="panel-sub">官方 2K · 32 倍数</span></div>
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
                  <span class="field-hint">自动向上对齐到 32 的倍数</span>
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head"><div class="panel-title">采样参数</div></div>
              <div class="panel-body">
                <div class="field">
                  <span class="field-label">步数预设</span>
                  <div class="chips" data-ref="stepsPresets"></div>
                </div>
                <div class="grid-2">
                  <label class="field">
                    <span class="field-label">步数 <span class="locked-note hidden" data-ref="turboLock">Turbo 锁定</span></span>
                    <input class="input mono" type="number" min="1" max="200" step="1" data-ref="steps" />
                  </label>
                  <label class="field">
                    <span class="field-label">CFG</span>
                    <input class="input mono" type="number" min="0" max="20" step="0.1" data-ref="cfg" />
                  </label>
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

            <section class="panel">
              <div class="panel-head"><div class="panel-title">当前参数摘要</div></div>
              <div class="panel-body tight" data-ref="summary"></div>
            </section>

            <button class="btn ghost block" type="button" data-ref="reset">重置采样参数</button>
            <div class="wb-adv-note">高级设置只影响下一次生成；收起侧边栏不会丢失参数。</div>
          </div>
        </aside>

        <main class="wb-main">
          <div class="wb-topbar">
            <span class="wb-topbar-hint">提示词 → 生成，高级参数收在右侧</span>
            <span class="spacer"></span>
            <button class="wb-adv-toggle" type="button" data-ref="advToggle" aria-expanded="false">
              <span class="wb-adv-icon">⚙</span> 文生图高级设置
            </button>
          </div>

          <section class="wb-feed">
            <div class="wb-feed-head">
              <div class="wb-feed-title">生成结果 <span data-ref="resultState">等待任务</span></div>
              <span class="spacer"></span>
              <button class="btn ghost sm" type="button" data-ref="feedClear">清空记录</button>
            </div>
            <div class="wb-art" aria-hidden="true">
              <div class="wb-art-text">
                <div class="wb-art-glyph">把想象画进现实</div>
                <div class="wb-art-sub">IMAGINE · THEN CREATE</div>
                <div class="wb-art-foot">一念起 · 万物生</div>
              </div>
              <div class="wb-art-seal">绘</div>
            </div>
            <div class="wb-feed-body" data-ref="resultHost"></div>
          </section>

          <div class="wb-composer">
            <div class="wb-status">
              <span class="wb-status-dot"></span>
              <span class="wb-status-ready" data-ref="readyHint">引擎就绪后可直接生成</span>
              <span class="wb-status-sub" data-ref="actionHint">首次生成需要加载模型，可能要等待一段时间</span>
              <span class="spacer"></span>
              <div class="wb-status-job" data-ref="statusStrip"></div>
            </div>
            <div class="wb-prompt-wrap">
              <div data-ref="stylePicker"></div>
              <textarea class="wb-prompt" data-ref="prompt" spellcheck="false"
                placeholder="描述你想要的画面，例如：清晨薄雾中的东方古镇，青石板路湿润反光，屋檐下挂着红灯笼，电影感，冷调晨光。"></textarea>
              <div class="wb-prompt-foot">
                <span class="wb-char" data-ref="promptCount">0 字</span>
                <input class="wb-negative" data-ref="negative" placeholder="负向提示词（可选）：文字、水印、模糊、畸变" />
                <button class="wb-link" type="button" data-ref="clearPrompt">清空</button>
                <button class="wb-link accent" type="button" data-ref="polish">✦ 润色</button>
              </div>
            </div>
            <div class="wb-pillbar">
              <div class="wb-size-anchor" data-ref="sizeAnchor">
                <button class="wb-pill wb-size-pill" type="button" data-ref="sizePill" aria-expanded="false" title="画面尺寸">
                  <span class="wb-pill-key">尺寸</span>
                  <span class="wb-size-value" data-ref="sizePillValue">1:1 · 2048×2048</span>
                  <span class="wb-caret">▼</span>
                </button>
                <div class="size-pop" data-ref="sizePop" hidden>
                  <div class="size-pop-head">
                    <span>分辨率</span>
                    <span class="size-pop-dims mono" data-ref="sizePopDims">2048 × 2048</span>
                  </div>
                  <div class="size-tier-row" data-ref="sizeTiers"></div>
                  <div class="size-pop-head"><span>比例</span></div>
                  <div class="size-ratio-grid" data-ref="sizeRatios"></div>
                  <div class="size-pop-foot">
                    <label class="size-custom">
                      <span>自定义</span>
                      <input class="mono" type="number" min="256" max="4096" step="32" data-ref="popWidth" />
                      <span>×</span>
                      <input class="mono" type="number" min="256" max="4096" step="32" data-ref="popHeight" />
                    </label>
                    <button class="size-pop-apply" type="button" data-ref="sizeApply">应用</button>
                  </div>
                </div>
              </div>
              <label class="wb-pill wb-pill-select" title="一次生成几张">
                <span class="wb-pill-key">批量</span>
                <select data-ref="batch">
                  <option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option>
                  <option value="4">4 张</option><option value="5">5 张</option><option value="6">6 张</option>
                  <option value="7">7 张</option><option value="8">8 张</option>
                </select>
              </label>
              <div class="wb-pill wb-seed" title="固定：每次用输入框的种子；随机：每次生成自动换一个">
                <span class="wb-pill-key">种子</span>
                <input data-ref="seed" placeholder="每次随机" inputmode="numeric" />
                <span class="wb-seed-seg" role="group" aria-label="种子模式">
                  <button type="button" data-ref="seedFixed" title="固定种子">固定</button>
                  <button type="button" data-ref="seedRandom" title="每次生成自动换种子">随机</button>
                </span>
                <button type="button" data-ref="randomSeed" title="换一个固定种子">⚄</button>
                <button type="button" data-ref="reuseSeed" title="填入上次使用的种子（切到固定）" disabled>↺</button>
              </div>
              <button class="wb-pill wb-pose-pill" type="button" data-ref="posePill" title="姿态参考：设置人物动作与构图">
                <span class="wb-pill-key">姿态</span>
                <img class="wb-pose-thumb" data-ref="poseThumb" alt="" hidden />
                <span data-ref="poseLabel">未设置</span>
              </button>
              <button class="wb-pill wb-pill-btn" type="button" data-ref="turboPill" title="Turbo 加速">
                <span class="wb-pill-key">Turbo</span><span data-role="label">加速</span>
              </button>
              <label class="wb-pill wb-pill-check" data-ref="rgbaPill" title="输出带 alpha 通道的 PNG">
                <input type="checkbox" data-ref="rgba" />
                <span class="wb-check-dot"></span><span>透明背景</span>
              </label>
              <span class="spacer"></span>
              <span class="wb-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
              <button class="btn primary lg wb-generate" type="button" data-ref="generate">生成</button>
            </div>
          </div>
        </main>
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
    seedFixed: ref('seedFixed'),
    seedRandom: ref('seedRandom'),
    randomSeed: ref('randomSeed'),
    reuseSeed: ref('reuseSeed'),
    sizeAnchor: ref('sizeAnchor'),
    sizePill: ref('sizePill'),
    sizePillValue: ref('sizePillValue'),
    sizePop: ref('sizePop'),
    sizePopDims: ref('sizePopDims'),
    sizeTiers: ref('sizeTiers'),
    sizeRatios: ref('sizeRatios'),
    popWidth: ref('popWidth'),
    popHeight: ref('popHeight'),
    sizeApply: ref('sizeApply'),
    sampler: ref('sampler'),
    scheduler: ref('scheduler'),
    turboHost: ref('turboHost'),
    turboLock: ref('turboLock'),
    rgba: ref('rgba'),
    rgbaPill: ref('rgbaPill'),
    modelsHost: ref('modelsHost'),
    loraHost: ref('loraHost'),
    generate: ref('generate'),
    reset: ref('reset'),
    readyHint: ref('readyHint'),
    actionHint: ref('actionHint'),
    resultHost: ref('resultHost'),
    resultState: ref('resultState'),
    summary: ref('summary'),
    stylePicker: ref('stylePicker'),
    layout: ref('layout'),
    advDrawer: ref('advDrawer'),
    advToggle: ref('advToggle'),
    advClose: ref('advClose'),
    turboPill: ref('turboPill'),
    posePill: ref('posePill'),
    poseThumb: ref('poseThumb'),
    poseLabel: ref('poseLabel'),
    statusStrip: ref('statusStrip'),
    feedClear: ref('feedClear'),
  };

  const historyRail = createHistoryRail(host, { label: '文生图历史' });

  const jobRunner = new JobRunner(refs.resultHost, {
    feed: true,
    latestOnly: true,
    progressHost: refs.statusStrip,
    onBatch: (batch) => historyRail.add(batch),
    idleText: '生成结果会显示在这里，历史记录收在右侧书脊里，点击即可展开。',
  });

  // 提示词上方的风格选择器（本页独立选择集合）
  const stylePicker = createStylePicker(refs.stylePicker, { scope: 't2i' });
  stylePicker.attachPrompt(refs.prompt);

  let turboControl = null;
  let loraPicker = null;
  let turboSnapshot = null; // 开 Turbo 前的 steps/cfg/sampler，关掉时还原
  let turboModelSnapshot = null; // 开 Turbo 前用户选的底模，切回普通模式时还原
  let modelsField = null;
  let lastSeed = null;
  let sizeTier = 2048;
  let poseState = null;

  /* ---------------- 姿态参考 ---------------- */
  function syncPoseUi() {
    const active = Boolean(poseState);
    refs.posePill.classList.toggle('has-pose', active);
    refs.poseThumb.hidden = !active;
    if (active) refs.poseThumb.src = poseState.dataUrl;
    refs.poseLabel.textContent = active ? poseState.label : '未设置';
    refs.posePill.title = active
      ? `姿态：${poseState.summary}（点击修改）`
      : '姿态参考：设置人物动作与构图';
  }

  function openPoseDialog() {
    openPoseStudio({
      initial: poseState
        ? {
            joints: poseState.joints,
            preset: poseState.preset,
            strength: poseState.strength,
            useLora: poseState.useLora,
          }
        : null,
      onApply: (pose) => {
        poseState = pose;
        syncPoseUi();
        toastSuccess(`姿态已应用：${pose.label}`);
      },
      onClear: () => {
        poseState = null;
        syncPoseUi();
        toastSuccess('已清除姿态参考');
      },
    });
  }

  refs.posePill.addEventListener('click', openPoseDialog);
  syncPoseUi();

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

  function ratioPair(id) {
    const [rw, rh] = String(id).split(':').map(Number);
    return { rw: rw > 0 ? rw : 1, rh: rh > 0 ? rh : 1 };
  }

  function clampSide(value) {
    return Math.min(4096, Math.max(256, Math.round(Number(value) || 0)));
  }

  /** 按「长边 = 档位」算尺寸；2K 档优先用后端官方比例值（如 16:9 → 2752×1536）。 */
  function sizeForRatio(id, tier = sizeTier) {
    const official = ratioList().find((ratio) => ratio.id === id);
    if (official && tier === 2048) return { w: official.w, h: official.h };
    const { rw, rh } = ratioPair(id);
    const long = clampSide(tier);
    if (rw >= rh) {
      return { w: long, h: clampSide(Math.round((long * rh) / rw / 32) * 32) };
    }
    return { w: clampSide(Math.round((long * rw) / rh / 32) * 32), h: long };
  }

  /** 根据当前长边推断档位（官方 2K 值直接归到 2K）。 */
  function inferTier(width, height) {
    if (ratioList().some((ratio) => ratio.w === width && ratio.h === height)) return 2048;
    const long = Math.max(Number(width) || 0, Number(height) || 0);
    let best = 2048;
    for (const tier of SIZE_TIERS) {
      if (Math.abs(long - tier.value) < Math.abs(long - best)) best = tier.value;
    }
    return best;
  }

  /** 当前尺寸对应的比例 id，找不到就是自定义。 */
  function detectRatioId(width, height) {
    const official = ratioList().find((ratio) => ratio.w === width && ratio.h === height);
    if (official && SIZE_RATIOS.includes(official.id)) return official.id;
    return SIZE_RATIOS.find((id) => {
      const size = sizeForRatio(id, sizeTier);
      return size.w === width && size.h === height;
    }) || '';
  }

  function applySize(width, height, ratioId = '') {
    t2i.width = clampSide(width);
    t2i.height = clampSide(height);
    t2i.ratioId = ratioId;
    t2i.custom = !ratioId;
    patchSettings({
      t2i: { width: t2i.width, height: t2i.height, ratioId, custom: !ratioId },
    });
    syncSizeFields();
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
        sizeTier = inferTier(Number(button.dataset.w), Number(button.dataset.h));
        applySize(Number(button.dataset.w), Number(button.dataset.h), button.dataset.ratio);
      });
    });
  }

  /** 尺寸弹框：分辨率档位 + 比例网格 + 自定义。 */
  function renderSizeCard() {
    refs.sizeTiers.innerHTML = SIZE_TIERS.map(
      (tier) => `<button class="size-tier" type="button" data-tier="${tier.value}">${tier.label}</button>`,
    ).join('');
    refs.sizeTiers.querySelectorAll('[data-tier]').forEach((button) => {
      button.addEventListener('click', () => {
        const ratioId = detectRatioId(
          Number(refs.width.value) || t2i.width,
          Number(refs.height.value) || t2i.height,
        );
        sizeTier = Number(button.dataset.tier) || 2048;
        if (ratioId) {
          const size = sizeForRatio(ratioId, sizeTier);
          applySize(size.w, size.h, ratioId);
        } else {
          syncSizeCard();
        }
      });
    });

    refs.sizeRatios.innerHTML = SIZE_RATIOS.map((id) => {
      const { rw, rh } = ratioPair(id);
      const scale = Math.min(18 / rw, 16 / rh);
      const gw = Math.max(2, Math.round(rw * scale));
      const gh = Math.max(2, Math.round(rh * scale));
      return `
        <button class="size-ratio-item" type="button" data-ratio="${id}" title="${id}">
          <span class="ratio-glyph" style="width:${gw}px;height:${gh}px"></span>
          <span class="ratio-label">${id}</span>
        </button>`;
    }).join('');
    refs.sizeRatios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.addEventListener('click', () => {
        const size = sizeForRatio(button.dataset.ratio, sizeTier);
        applySize(size.w, size.h, button.dataset.ratio);
      });
    });
  }

  function syncSizeCard() {
    const width = Number(refs.width.value) || t2i.width;
    const height = Number(refs.height.value) || t2i.height;
    const ratioId = detectRatioId(width, height);
    refs.sizePillValue.textContent = `${ratioId || '自定义'} · ${fmtNum(width)}×${fmtNum(height)}`;
    refs.sizePopDims.textContent = `${fmtNum(width)} × ${fmtNum(height)}`;
    refs.sizeTiers.querySelectorAll('[data-tier]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.tier) === sizeTier);
    });
    refs.sizeRatios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.classList.toggle('active', button.dataset.ratio === ratioId);
    });
    if (document.activeElement !== refs.popWidth) refs.popWidth.value = String(width);
    if (document.activeElement !== refs.popHeight) refs.popHeight.value = String(height);
  }

  function setSizePop(open) {
    refs.sizePop.hidden = !open;
    refs.sizeAnchor.classList.toggle('open', open);
    refs.sizePill.setAttribute('aria-expanded', String(open));
    if (open) syncSizeCard();
  }

  function commitCustomSize() {
    const width = snapUp(refs.popWidth.value || t2i.width);
    const height = snapUp(refs.popHeight.value || t2i.height);
    sizeTier = inferTier(width, height);
    applySize(width, height, '');
  }

  refs.sizePill.addEventListener('click', (event) => {
    event.stopPropagation();
    setSizePop(refs.sizePop.hidden);
  });
  refs.sizePop.addEventListener('click', (event) => event.stopPropagation());
  refs.sizeApply.addEventListener('click', () => {
    commitCustomSize();
    setSizePop(false);
  });
  refs.popWidth.addEventListener('change', commitCustomSize);
  refs.popHeight.addEventListener('change', commitCustomSize);
  document.addEventListener('click', () => setSizePop(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSizePop(false);
  });

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
    syncSizeCard();
    updateSummary();
  }

  function commitSizeInputs() {
    const width = snapUp(refs.width.value);
    const height = snapUp(refs.height.value);
    sizeTier = inferTier(width, height);
    applySize(width, height, '');
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
          <small>cfg ${preset.cfg}</small>
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
  syncRgbaPill();
  syncSeedUi();

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
  function setSeedValue(value) {
    refs.seed.value = value == null ? '' : String(value);
    t2i.seed = refs.seed.value;
    patchSettings({ t2i: { seed: t2i.seed } });
  }

  function syncSeedUi() {
    const mode = t2i.seedMode === 'fixed' ? 'fixed' : 'random';
    refs.seedFixed.classList.toggle('active', mode === 'fixed');
    refs.seedRandom.classList.toggle('active', mode === 'random');
    refs.seed.readOnly = mode === 'random';
    refs.seed.classList.toggle('is-random', mode === 'random');
    refs.seed.placeholder = mode === 'random' ? '每次随机' : '固定种子';
    refs.randomSeed.disabled = mode === 'random';
    refs.randomSeed.title = mode === 'random' ? '随机模式下每次生成自动换种子' : '换一个固定种子';
    refs.reuseSeed.disabled = lastSeed == null;
  }

  function setSeedMode(mode) {
    const next = mode === 'fixed' ? 'fixed' : 'random';
    t2i.seedMode = next;
    patchSettings({ t2i: { seedMode: next } });
    if (next === 'fixed' && !refs.seed.value.trim()) {
      setSeedValue(String(Math.floor(Math.random() * 1_000_000_000)));
    } else if (next === 'random') {
      // 随机模式清空显示，生成结束后回填本次实际种子
      setSeedValue('');
    }
    syncSeedUi();
  }

  refs.seedFixed.addEventListener('click', () => setSeedMode('fixed'));
  refs.seedRandom.addEventListener('click', () => setSeedMode('random'));
  refs.seed.addEventListener('input', () => {
    t2i.seed = refs.seed.value.trim();
    patchSettings({ t2i: { seed: t2i.seed } });
  });
  refs.randomSeed.addEventListener('click', () => {
    setSeedValue(String(Math.floor(Math.random() * 1_000_000_000)));
    setSeedMode('fixed');
  });
  refs.reuseSeed.addEventListener('click', () => {
    if (lastSeed == null) return;
    setSeedValue(String(lastSeed));
    setSeedMode('fixed');
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
    syncRgbaPill();
    updateSummary();
  });

  /* ---------------- 输入框 pill / 高级设置侧栏 ---------------- */
  function syncRgbaPill() {
    refs.rgbaPill?.classList.toggle('active', Boolean(refs.rgba.checked));
  }

  function setAdvancedOpen(open) {
    refs.layout.classList.toggle('adv-open', open);
    refs.advToggle.setAttribute('aria-expanded', String(open));
    refs.advToggle.innerHTML = open
      ? '<span class="wb-adv-icon">⚙</span> 收起高级设置'
      : '<span class="wb-adv-icon">⚙</span> 文生图高级设置';
  }

  refs.advToggle.addEventListener('click', () => {
    const open = !refs.layout.classList.contains('adv-open');
    setAdvancedOpen(open);
    if (open) refs.advDrawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  refs.advClose.addEventListener('click', () => setAdvancedOpen(false));

  function syncTurboPill() {
    if (!refs.turboPill) return;
    const value = turboControl?.getValue();
    const enabled = Boolean(value?.enabled);
    const profile = turboControl?.selectedProfile();
    refs.turboPill.classList.toggle('active', enabled);
    const label = refs.turboPill.querySelector('[data-role="label"]');
    if (label) {
      if (!enabled) label.textContent = '加速';
      else if (profile?.steps) label.textContent = `${profile.steps} 步`;
      else label.textContent = '已开启';
    }
  }

  refs.turboPill.addEventListener('click', () => {
    if (!turboControl) return;
    const enabled = Boolean(turboControl.getValue().enabled);
    if (!enabled && !turboControl.profiles.length) {
      toastWarn('后端未返回 Turbo 加速预设，暂时无法开启');
      return;
    }
    turboControl.setEnabled(!enabled);
  });

  refs.feedClear.addEventListener('click', () => {
    jobRunner.clearFeed();
    historyRail.clear();
    refs.resultState.textContent = '等待任务';
  });

  syncRgbaPill();

  function renderTurbo() {
    const profiles = store.state.options?.turbo_profiles || [];
    turboControl = new TurboControl(refs.turboHost, {
      profiles,
      defaultProfile: store.state.options?.defaults?.turbo_profile || '',
      initial: {
        enabled: Boolean(t2i.turbo),
        profile: t2i.turboProfile || '',
      },
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
              turbo: false, turboProfile: value.profile,
              steps: restored.steps, cfg: restored.cfg, sampler: restored.sampler,
            },
          });
          toastSuccess(`已关闭 Turbo，采样参数还原为 ${restored.steps} 步 · CFG ${restored.cfg}`);
        } else {
          patchSettings({ t2i: { turbo: value.enabled, turboProfile: value.profile } });
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
    // 「自动切换 Turbo 底模」预设：只改界面显示，关闭后恢复用户原来的选择
    applyTurboModel(enabled, profile);
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
    syncTurboPill();
    updateSummary();
  }

  function applyTurboModel(enabled, profile) {
    if (!modelsField) return;
    const ckpt = enabled && profile?.kind === 'ckpt' ? profile.unet?.name : '';
    if (ckpt) {
      if (turboModelSnapshot === null) {
        turboModelSnapshot = modelsField.getValue().unet ?? '';
      }
      modelsField.setKey('unet', ckpt);
      modelsField.setDisabled('unet', true);
      return;
    }
    modelsField.setDisabled('unet', false);
    if (turboModelSnapshot !== null) {
      modelsField.setKey('unet', turboModelSnapshot);
      turboModelSnapshot = null;
    }
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
    // Turbo 的「自动切底模」预设需要模型下拉已就绪后才能套用
    applyTurboToFields(false);
  }

  /* ---------------- 参数摘要 ---------------- */
  function updateSummary() {
    if (!refs.summary) return;
    const width = snapUp(refs.width.value || t2i.width);
    const height = snapUp(refs.height.value || t2i.height);
    const turboValue = turboControl?.getValue();
    const turboOn = Boolean(turboValue?.enabled);
    const preset = turboControl?.selectedProfile();
    const loraCount = Object.keys(t2i.loras || {}).length;
    const turboLoraFile = turboOn && preset?.lora?.file ? preset.lora.file : '';
    const turboCkptFile = turboOn && preset?.kind === 'ckpt' ? preset?.unet?.file || '' : '';
    const loraText = [
      loraCount ? `${loraCount} 个手动` : '',
      turboLoraFile ? `加速 ${turboLoraFile}` : (turboOn ? '不挂加速' : ''),
    ].filter(Boolean).join(' + ') || '无';
    const rows = [
      ['尺寸', `${fmtNum(width)} × ${fmtNum(height)}`],
      ['步数 / CFG', `${refs.steps.value} / ${refs.cfg.value}`],
      ['采样', `${refs.sampler.value} · ${refs.scheduler.value}`],
      ['Turbo', turboOn ? (preset?.label || '开启') : '关闭'],
      ['批量', refs.batch.value],
      ['种子', t2i.seedMode === 'fixed' ? (refs.seed.value.trim() || '0') : '随机'],
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
      refs.actionHint.textContent = turboCkptFile
        ? `Turbo 模式 · 自动切换底模：${turboCkptFile}`
        : turboLoraFile
          ? `Turbo 模式 · 加速 LoRA：${turboLoraFile}`
          : 'Turbo 模式：不挂加速 LoRA';
    } else {
      refs.actionHint.textContent = '首次生成需要加载模型，可能要等待一段时间';
    }
  }

  /* ---------------- 启动 / 刷新 ---------------- */
  function refreshAll() {
    sizeTier = inferTier(Number(t2i.width) || 2048, Number(t2i.height) || 2048);
    renderRatios();
    renderSizeCard();
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

  sizeTier = inferTier(Number(t2i.width) || 2048, Number(t2i.height) || 2048);
  renderRatios();
  renderSizeCard();
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
    sizeTier = inferTier(match.w, match.h);
    applySize(match.w, match.h, match.id);
    return true;
  }

  async function handlePolish() {
    await polishWithDialog({
      prompt: refs.prompt.value,
      mode: 't2i',
      model: store.state.polishModel || null,
      button: refs.polish,
      ratios: ratioList(),
      targetSize: {
        width: snapUp(refs.width.value || t2i.width),
        height: snapUp(refs.height.value || t2i.height),
      },
      pose: poseState
        ? { image: poseState.dataUrl, summary: poseState.summary, label: poseState.label }
        : null,
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
    const seedMode = t2i.seedMode === 'fixed' ? 'fixed' : 'random';
    const seedText = refs.seed.value.trim();
    // 随机模式交给后端每次抽新种子；固定模式按输入框，空则用 0
    const seed = seedMode === 'random' ? null : Math.max(0, Math.floor(Number(seedText) || 0));
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
      seed,
      batch: Number(refs.batch.value) || 1,
      sampler: refs.sampler.value || 'euler',
      scheduler: refs.scheduler.value || 'simple',
      turbo: {
        enabled: turboValue.enabled,
        profile: turboValue.profile,
      },
      rgba: refs.rgba.checked,
      models: {
        unet: models.unet || '',
        clip: models.clip || '',
        vae: models.vae || '',
      },
      loras,
      pose: poseState
        ? {
            image: poseState.dataUrl,
            width: poseState.width,
            height: poseState.height,
            joints: poseState.joints,
            preset: poseState.preset,
            label: poseState.label,
            summary: poseState.summary,
            strength: poseState.strength,
            use_lora: poseState.useLora,
          }
        : null,
      meta: {
        source: 'web/t2i',
        ratio: t2i.ratioId || null,
        rawPrompt: refs.prompt.value.trim(),
        creativePresets: pickerMeta.creativePresets,
        imageAngle: pickerMeta.imageAngle,
        pose: poseState ? { preset: poseState.preset, summary: poseState.summary } : null,
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
      if (payload.turbo.enabled && !payload.turbo.profile) {
        toastWarn('Turbo 已开启但没有可用的加速预设，请等模型信息加载完成后再试');
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
          const usedSeed = job?.params?.seed;
          if (usedSeed != null) {
            lastSeed = usedSeed;
            refs.reuseSeed.disabled = false;
            // 随机模式把本次实际种子回填，用户能看到每次都在变
            if (t2i.seedMode !== 'fixed') setSeedValue(String(usedSeed));
          }
          refreshHealthSoon();
        },
      });
    } finally {
      refs.generate.disabled = false;
      refs.generate.textContent = '生成';
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
    const defaults = {
      steps: 25, cfg: 4.0, batch: 1, seed: '', seedMode: 'random',
      sampler: 'euler', scheduler: 'simple', rgba: false, turbo: false,
    };
    Object.assign(t2i, defaults);
    patchSettings({ t2i: defaults });
    refs.seed.value = '';
    refs.batch.value = '1';
    refs.rgba.checked = false;
    syncRgbaPill();
    syncSeedUi();
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
      setSeedValue(String(payload.seed));
      setSeedMode('fixed');
    }
    if (payload.width && payload.height) {
      const width = snapUp(payload.width);
      const height = snapUp(payload.height);
      sizeTier = inferTier(width, height);
      applySize(width, height, '');
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
