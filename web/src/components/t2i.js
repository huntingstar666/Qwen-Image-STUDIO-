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
import { openBboxStudio } from './bboxStudio.js';
import { LoraPicker, ModelsSummary, TurboControl } from './controls.js';
import { escapeHtml, fmtNum, snapUp } from '../utils.js';
import { SPHERE_SIZES, findSphereSize, isSphereSizeId, withSpherePrompt } from './panoramaMath.js';

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

/** 尺寸卡片的分辨率档位：按长边计算，官方比例值仅在长边等于档位时直接采用。 */
const SIZE_TIERS = [
  { value: 512, label: '512' },
  { value: 1024, label: '1K' },
  { value: 2048, label: '2K' },
  { value: 2752, label: '2.7K' },
  { value: 4096, label: '4K' },
];

/** 宽幅比例：渲染时单独分组，并在提交时追加宽幅提示词。 */
const PANORAMA_RATIOS = ['2:1', '3:1', '4:1', '8:1', '21:9'];

/** 卡片比例网格（5 列，顺序与设计稿一致；全景比例统一排在末尾）。 */
const SIZE_RATIOS = [
  '1:1', '2:3', '3:2', '9:16', '16:9',
  '3:4', '4:3', '5:4', '4:5', '1:4', '1:8',
  ...PANORAMA_RATIOS,
];

const PANORAMA_PROMPT = 'seamless ultra-wide panoramic photograph, consistent horizon, no duplicated subjects';

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
            <div class="wb-model-bar" data-ref="modelBar"></div>

            <section class="panel">
              <div class="panel-head"><div class="panel-title">采样参数</div></div>
              <div class="panel-body">
                <div class="field">
                  <span class="field-label">步数预设</span>
                  <div class="chips" data-ref="stepsPresets"></div>
                </div>
                <div class="grid-2">
                  <label class="field">
                    <span class="field-label">步数 <span class="tag-hint" data-ref="stepsHint"></span> <span class="locked-note hidden" data-ref="turboLock">Turbo 锁定</span></span>
                    <input class="input mono" type="number" min="1" max="200" step="1" data-ref="steps" />
                  </label>
                  <label class="field">
                    <span class="field-label">CFG <span class="tag-hint" data-ref="cfgHint"></span></span>
                    <input class="input mono" type="number" min="0" max="20" step="0.1" data-ref="cfg" />
                  </label>
                </div>
                <div class="grid-2">
                  <label class="field">
                    <span class="field-label">采样器 <span class="tag-hint" data-ref="samplerHint"></span></span>
                    <select class="select" data-ref="sampler"></select>
                  </label>
                  <label class="field">
                    <span class="field-label">调度器 <span class="tag-hint" data-ref="schedulerHint"></span></span>
                    <select class="select" data-ref="scheduler"></select>
                  </label>
                </div>
                <div class="wb-adv-rows" data-ref="turboHost"></div>
                <details class="fold slg-fold" data-ref="slgFold" hidden>
                  <summary>SLG 跳过层引导（实验）</summary>
                  <div class="fold-body">
                    <label class="switch">
                      <input type="checkbox" data-ref="slgEnabled" />
                      <span class="switch-track"></span>
                      <span class="switch-label">启用 SLG<small>50 步下约 +10~15s；8 步加速下不建议开启</small></span>
                    </label>
                    <div class="grid-2">
                      <label class="field">
                        <span class="field-label">单层 <span class="tag-hint" data-ref="slgSingleHint">默认 22</span></span>
                        <input class="input mono" data-ref="slgSingle" placeholder="22" />
                      </label>
                      <label class="field">
                        <span class="field-label">双层 <span class="tag-hint">留空不启用</span></span>
                        <input class="input mono" data-ref="slgDouble" placeholder="留空" />
                      </label>
                    </div>
                    <div class="grid-2">
                      <label class="field">
                        <span class="field-label">起始比例</span>
                        <input class="input mono" type="number" min="0" max="1" step="0.05" data-ref="slgStart" placeholder="0" />
                      </label>
                      <label class="field">
                        <span class="field-label">结束比例</span>
                        <input class="input mono" type="number" min="0" max="1" step="0.05" data-ref="slgEnd" placeholder="0.5" />
                      </label>
                    </div>
                  </div>
                </details>
              </div>
            </section>

            <section class="panel" data-ref="bboxPanel" hidden>
              <div class="panel-head"><div class="panel-title">边界框布局</div></div>
              <div class="panel-body">
                <label class="switch">
                  <input type="checkbox" data-ref="bboxEnabled" />
                  <span class="switch-track"></span>
                  <span class="switch-label">启用布局<small>框内文字 / 物体位置由边界框指定</small></span>
                </label>
                <div class="grid-2">
                  <label class="field">
                    <span class="field-label">角色数量</span>
                    <select class="select" data-ref="bboxCharacters">
                      <option value="1">1 个角色</option>
                      <option value="-1">多角色</option>
                      <option value="">不限制</option>
                    </select>
                  </label>
                  <div class="field">
                    <span class="field-label">画布</span>
                    <span class="field-hint mono" data-ref="bboxCanvas">—</span>
                  </div>
                </div>
                <div class="bbox-actions">
                  <button class="btn ghost sm" type="button" data-ref="bboxOpen">打开设计器</button>
                  <button class="btn ghost sm" type="button" data-ref="bboxClear">清空</button>
                </div>
                <div class="field-hint" data-ref="bboxSummary">未设置</div>
              </div>
            </section>

            <details class="fold">
              <summary>高级：模型与 LoRA</summary>
              <div class="fold-body">
                <div class="field-hint" data-ref="modelFiles" hidden></div>
                <div class="wb-adv-stack" data-ref="modelsHost"></div>
                <div class="field">
                  <span class="field-label">LoRA <span class="tag-hint">按需添加 · 可调强度</span></span>
                  <div class="wb-adv-stack" data-ref="loraHost"></div>
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
              <div class="wb-model-anchor" data-ref="modelAnchor">
                <button class="wb-pill wb-model-pill" type="button" data-ref="modelPill" aria-expanded="false" title="图像模型">
                  <span class="wb-pill-key">模型</span>
                  <span class="wb-model-dot" data-ref="modelDot"></span>
                  <span data-ref="modelLabel">Qwen-Image 2.1</span>
                  <span class="wb-caret">▼</span>
                </button>
                <div class="model-pop" data-ref="modelPop" hidden></div>
              </div>
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
                  <div class="size-pano-row" data-ref="panoPromptRow" hidden>
                    <label class="studio-check">
                      <input type="checkbox" data-ref="panoPrompt" checked />
                      <span data-ref="panoPromptLabel">自动追加宽幅提示词</span>
                    </label>
                  </div>
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
              <button class="wb-pill wb-bbox-pill" type="button" data-ref="bboxPill" title="边界框布局（仅 MOSS）" hidden>
                <span class="wb-pill-key">布局</span><span data-ref="bboxLabel">未设置</span>
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
    modelAnchor: ref('modelAnchor'),
    modelPill: ref('modelPill'),
    modelPop: ref('modelPop'),
    modelDot: ref('modelDot'),
    modelLabel: ref('modelLabel'),
    modelBar: ref('modelBar'),
    sizePop: ref('sizePop'),
    sizePopDims: ref('sizePopDims'),
    sizeTiers: ref('sizeTiers'),
    sizeRatios: ref('sizeRatios'),
    panoPromptRow: ref('panoPromptRow'),
    panoPrompt: ref('panoPrompt'),
    panoPromptLabel: ref('panoPromptLabel'),
    popWidth: ref('popWidth'),
    popHeight: ref('popHeight'),
    sizeApply: ref('sizeApply'),
    sampler: ref('sampler'),
    scheduler: ref('scheduler'),
    stepsHint: ref('stepsHint'),
    cfgHint: ref('cfgHint'),
    samplerHint: ref('samplerHint'),
    schedulerHint: ref('schedulerHint'),
    slgFold: ref('slgFold'),
    slgEnabled: ref('slgEnabled'),
    slgSingle: ref('slgSingle'),
    slgDouble: ref('slgDouble'),
    slgStart: ref('slgStart'),
    slgEnd: ref('slgEnd'),
    slgSingleHint: ref('slgSingleHint'),
    bboxPanel: ref('bboxPanel'),
    bboxEnabled: ref('bboxEnabled'),
    bboxCharacters: ref('bboxCharacters'),
    bboxCanvas: ref('bboxCanvas'),
    bboxOpen: ref('bboxOpen'),
    bboxClear: ref('bboxClear'),
    bboxSummary: ref('bboxSummary'),
    bboxPill: ref('bboxPill'),
    bboxLabel: ref('bboxLabel'),
    modelFiles: ref('modelFiles'),
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
  let lastSeed = null;
  let sizeTier = 2048;
  let poseState = null;
  let jobActive = false;

  /* ---------------- 模型档案 / 按模型快照 ---------------- */
  const SNAPSHOT_KEYS = [
    'steps', 'cfg', 'sampler', 'scheduler', 'width', 'height', 'ratioId', 'custom',
    'negativePrompt', 'turbo', 'turboProfile', 'rgba', 'slg', 'bbox',
  ];

  function ensureModelState() {
    if (!t2i.byModel || typeof t2i.byModel !== 'object') t2i.byModel = {};
    if (!t2i.slg || typeof t2i.slg !== 'object') {
      t2i.slg = { enabled: false, singleLayers: '', doubleLayers: '', startPercent: 0, endPercent: 0.5 };
    }
    if (!t2i.bbox || typeof t2i.bbox !== 'object') {
      t2i.bbox = { enabled: false, characterBoxes: '1', items: [] };
    }
    if (!Array.isArray(t2i.bbox.items)) t2i.bbox.items = [];
  }

  function modelProfiles() {
    const profiles = store.state.options?.model_profiles;
    return Array.isArray(profiles) ? profiles : [];
  }

  function profileById(id) {
    return modelProfiles().find((profile) => profile.id === id) || null;
  }

  function fallbackProfile() {
    return {
      id: t2i.model === 'moss' ? 'moss' : 'qwen',
      label: t2i.model === 'moss' ? 'MOSS-Image (sft)' : 'Qwen-Image 2.1',
      defaults: {
        steps: t2i.steps, cfg: t2i.cfg, sampler: t2i.sampler, scheduler: t2i.scheduler,
        width: t2i.width, height: t2i.height, negative_prompt: '', megapixels: 1,
      },
      snap: t2i.model === 'moss' ? 16 : 32,
      capabilities: t2i.model === 'moss'
        ? { t2i: true, edit: false, bbox: true, slg: true, rgba: false }
        : { t2i: true, edit: true, bbox: false, slg: false, rgba: true },
      turbo: [],
      samplers: [t2i.sampler, 'euler', 'er_sde'].filter(Boolean),
      slg: null,
      files: {},
      missing: [],
      ready: true,
    };
  }

  function currentProfile() {
    ensureModelState();
    const fallbackId = store.state.options?.defaults?.t2i_model
      || store.state.options?.default_model || 'qwen';
    return profileById(t2i.model) || profileById(fallbackId) || fallbackProfile();
  }

  function currentModelId() {
    return currentProfile().id;
  }

  function modelSnap() {
    return Number(currentProfile()?.snap) || 32;
  }

  function modelCapabilities() {
    return currentProfile()?.capabilities || {};
  }

  function modelDefaults() {
    return currentProfile()?.defaults || {};
  }

  function snapSize(value) {
    return snapUp(value, modelSnap());
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function snapshotCurrentModel() {
    const snapshot = {};
    for (const key of SNAPSHOT_KEYS) snapshot[key] = clone(t2i[key]);
    t2i.byModel = { ...(t2i.byModel || {}), [currentModelId()]: snapshot };
  }

  function restoreSnapshot(snapshot) {
    for (const key of SNAPSHOT_KEYS) {
      if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, key)) t2i[key] = clone(snapshot[key]);
    }
  }

  function applyProfileDefaults(profile) {
    const d = profile.defaults || {};
    t2i.steps = Number(d.steps) || 25;
    t2i.cfg = Number(d.cfg) || 4;
    t2i.sampler = d.sampler || 'euler';
    t2i.scheduler = d.scheduler || 'simple';
    t2i.width = clampSide(Number(d.width) || 1024);
    t2i.height = clampSide(Number(d.height) || 1024);
    t2i.ratioId = '';
    t2i.custom = true;
    t2i.negativePrompt = '';
    t2i.turbo = false;
    t2i.turboProfile = profile.turbo?.[0]?.id || '';
    t2i.rgba = false;
    const slg = profile.slg || {};
    t2i.slg = {
      enabled: false,
      singleLayers: String(slg.single_layers ?? ''),
      doubleLayers: String(slg.double_layers ?? ''),
      startPercent: Number(slg.start_percent ?? 0),
      endPercent: Number(slg.end_percent ?? 0.5),
    };
    t2i.bbox = { enabled: false, characterBoxes: '1', items: [] };
  }

  function patchModelState(extra = {}) {
    const patch = { model: t2i.model, byModel: t2i.byModel, ...extra };
    for (const key of SNAPSHOT_KEYS) {
      if (!(key in patch)) patch[key] = t2i[key];
    }
    patchSettings({ t2i: patch });
  }

  function profileSubtitle(profile) {
    const d = profile.defaults || {};
    const caps = profile.capabilities || {};
    const tags = [];
    if (caps.edit) tags.push('参考图编辑');
    if (caps.rgba) tags.push('透明背景');
    if (caps.bbox) tags.push('布局框');
    return `${d.steps} 步 · CFG ${d.cfg} · ${d.sampler}${tags.length ? ` · ${tags.join(' / ')}` : ''}`;
  }

  function syncModelPill() {
    const profile = currentProfile();
    const resident = store.state.health?.engine?.model || null;
    refs.modelLabel.textContent = profile.label || profile.id;
    refs.modelDot.className = 'wb-model-dot';
    if (resident === profile.id) refs.modelDot.classList.add('is-resident');
    else if (resident) refs.modelDot.classList.add('is-other');
    refs.modelPill.classList.toggle('is-busy', jobActive);
    refs.modelPill.disabled = jobActive;
    refs.modelPill.title = resident
      ? `图像模型：当前显存驻留 ${profileById(resident)?.label || resident}`
      : '图像模型（切换只改参数，生成时才换权重）';
  }

  function renderModelPop() {
    const resident = store.state.health?.engine?.model || null;
    refs.modelPop.innerHTML = modelProfiles()
      .map((profile) => {
        const active = profile.id === currentModelId();
        const status = !profile.ready
          ? `<span class="model-status is-bad">缺失 ${escapeHtml((profile.missing || []).join(', '))}</span>`
          : resident === profile.id
            ? '<span class="model-status is-resident">已驻留</span>'
            : '<span class="model-status">未加载</span>';
        return `
          <button class="model-card ${active ? 'active' : ''}" type="button"
            data-model="${escapeHtml(profile.id)}" ${profile.ready ? '' : 'disabled'}>
            <span class="model-card-title">${escapeHtml(profile.label)}${active ? ' ✓' : ''}</span>
            <span class="model-card-sub">${escapeHtml(profileSubtitle(profile))}</span>
            ${status}
          </button>`;
      })
      .join('') || '<div class="field-hint">模型信息尚未加载</div>';
    refs.modelPop.querySelectorAll('[data-model]').forEach((button) => {
      button.addEventListener('click', () => switchModel(button.dataset.model));
    });
  }

  function setModelPop(open) {
    refs.modelPop.hidden = !open;
    refs.modelAnchor.classList.toggle('open', open);
    refs.modelPill.setAttribute('aria-expanded', String(open));
    if (open) {
      renderModelPop();
      syncModelPill();
    }
  }

  function switchModel(nextId) {
    if (!nextId || nextId === currentModelId()) {
      setModelPop(false);
      return;
    }
    if (jobActive) {
      toastWarn('任务进行中，完成后再切换模型');
      return;
    }
    const profile = profileById(nextId);
    if (!profile) return;
    if (!profile.ready) {
      toastWarn(`${profile.label} 权重缺失：${(profile.missing || []).join(', ')}`);
      return;
    }
    const prevResident = store.state.health?.engine?.model || null;
    snapshotCurrentModel();
    t2i.model = nextId;
    const snapshot = t2i.byModel?.[nextId];
    if (snapshot) restoreSnapshot(snapshot);
    else applyProfileDefaults(profile);
    if (!profile.capabilities?.rgba) t2i.rgba = false;
    if (profile.id !== 'qwen') {
      poseState = null;
      syncPoseUi();
    }
    if (!profile.capabilities?.bbox) t2i.bbox = { ...(t2i.bbox || {}), enabled: false };
    patchModelState();
    sizeTier = inferTier(Number(t2i.width) || 1024, Number(t2i.height) || 1024);
    refreshModelDependentUi();
    setModelPop(false);
    if (snapshot) toastSuccess(`已切换 ${profile.label}（沿用上次参数）`);
    else toastSuccess(`已切换 ${profile.label}，已套用默认 ${t2i.steps} 步 / CFG ${t2i.cfg}`);
    if (prevResident && prevResident !== nextId) {
      toastWarn(`生成前会先卸载 ${profileById(prevResident)?.label || prevResident} 再加载新模型（约 30~60s）`);
    } else if (nextId === 'moss') {
      toastWarn('MOSS 首次加载约 30~60s，显存约 20GB');
    }
  }

  function syncModelBar() {
    const profile = currentProfile();
    const d = profile.defaults || {};
    const files = Object.values(profile.files || {}).filter(Boolean);
    refs.modelBar.innerHTML = `
      <div class="wb-model-bar-main">
        <span class="badge info">${escapeHtml(profile.label)}</span>
        <span class="field-hint">${d.steps} 步 · CFG ${d.cfg} · ${escapeHtml(String(d.sampler || ''))}</span>
      </div>
      <button class="btn ghost sm" type="button" data-role="modelReset">恢复默认</button>
      ${files.length ? `<div class="field-hint wb-model-bar-files">${files.map((name) => `<span class="mono">${escapeHtml(name)}</span>`).join(' · ')}</div>` : ''}`;
    refs.modelBar.querySelector('[data-role="modelReset"]')?.addEventListener('click', () => {
      if (jobActive) {
        toastWarn('任务进行中，完成后再恢复默认');
        return;
      }
      applyProfileDefaults(profile);
      patchModelState();
      sizeTier = inferTier(t2i.width, t2i.height);
      refreshModelDependentUi();
      toastSuccess(`已恢复 ${profile.label} 的默认参数`);
    });
  }

  function syncSizeSnapUi() {
    const snap = modelSnap();
    for (const input of [refs.popWidth, refs.popHeight]) {
      input.step = String(snap);
    }
  }

  function applyModelCapabilities() {
    const profile = currentProfile();
    const caps = profile.capabilities || {};
    refs.rgbaPill.hidden = !caps.rgba;
    refs.posePill.hidden = profile.id !== 'qwen';
    refs.bboxPill.hidden = !caps.bbox;
    refs.bboxPanel.hidden = !caps.bbox;
    refs.slgFold.hidden = !caps.slg;
    if (!caps.rgba && refs.rgba.checked) {
      refs.rgba.checked = false;
      t2i.rgba = false;
      patchSettings({ t2i: { rgba: false } });
      syncRgbaPill();
    }
  }

  function refreshModelDependentUi() {
    syncSamplingFields();
    renderStepsPresets();
    renderSelects();
    renderTurbo();
    renderModels();
    renderLoras();
    applyModelCapabilities();
    syncSlgUi();
    syncBboxUi();
    syncSizeSnapUi();
    syncDefaultHints();
    syncModelBar();
    syncModelPill();
    syncSizeCard();
    updateSummary();
  }

  /* ---------------- SLG（MOSS） ---------------- */
  function slgState() {
    ensureModelState();
    return t2i.slg;
  }

  function syncSlgUi() {
    const slg = slgState();
    const defaults = currentProfile().slg || {};
    const single = defaults.single_layers ?? '22';
    const double = defaults.double_layers ?? '';
    refs.slgEnabled.checked = Boolean(slg.enabled);
    refs.slgSingle.value = slg.singleLayers ?? '';
    refs.slgDouble.value = slg.doubleLayers ?? '';
    refs.slgStart.value = slg.startPercent ?? '';
    refs.slgEnd.value = slg.endPercent ?? '';
    refs.slgSingle.placeholder = String(single);
    refs.slgDouble.placeholder = String(double || '留空');
    refs.slgStart.placeholder = String(defaults.start_percent ?? 0);
    refs.slgEnd.placeholder = String(defaults.end_percent ?? 0.5);
    refs.slgSingleHint.textContent = `默认 ${single}`;
    const enabled = Boolean(slg.enabled);
    for (const input of [refs.slgSingle, refs.slgDouble, refs.slgStart, refs.slgEnd]) {
      input.disabled = !enabled;
    }
  }

  function commitSlg(patch) {
    t2i.slg = { ...slgState(), ...patch };
    patchSettings({ t2i: { slg: t2i.slg } });
    syncSlgUi();
    updateSummary();
  }

  refs.slgEnabled.addEventListener('change', () => commitSlg({ enabled: refs.slgEnabled.checked }));
  refs.slgSingle.addEventListener('change', () => commitSlg({ singleLayers: refs.slgSingle.value.trim() }));
  refs.slgDouble.addEventListener('change', () => commitSlg({ doubleLayers: refs.slgDouble.value.trim() }));
  refs.slgStart.addEventListener('change', () => commitSlg({ startPercent: Number(refs.slgStart.value) || 0 }));
  refs.slgEnd.addEventListener('change', () => commitSlg({ endPercent: Number(refs.slgEnd.value) || 0 }));

  /* ---------------- 边界框布局 ---------------- */
  function bboxState() {
    ensureModelState();
    return t2i.bbox;
  }

  function currentCanvasSize() {
    return [snapSize(t2i.width), snapSize(t2i.height)];
  }

  function bboxCountText() {
    const items = bboxState().items || [];
    if (!items.length) return '未设置';
    const textCount = items.filter((item) => item.type === 'text').length;
    return `${items.length} 个框${textCount ? ` · ${textCount} 文字` : ''}`;
  }

  function bboxEnabledNow() {
    const bbox = bboxState();
    return Boolean(bbox.enabled && bbox.items.length);
  }

  function syncBboxUi() {
    const bbox = bboxState();
    const caps = modelCapabilities();
    const active = bboxEnabledNow() && Boolean(caps.bbox);
    refs.bboxEnabled.checked = Boolean(bbox.enabled);
    refs.bboxCharacters.value = bbox.characterBoxes ?? '1';
    refs.bboxPill.classList.toggle('active', active);
    refs.bboxLabel.textContent = bboxCountText();
    const [width, height] = currentCanvasSize();
    refs.bboxCanvas.textContent = `${fmtNum(width)} × ${fmtNum(height)}`;
    refs.bboxSummary.textContent = bbox.items.length
      ? `${bbox.items.length} 个框 · ${bbox.enabled ? '已启用' : '未启用'}`
      : '未设置：打开设计器后在画布上拖拽创建';
    // 布局模式一次只能生成 1 张
    refs.batch.disabled = active;
    refs.batch.title = active ? '布局模式一次生成 1 张' : '一次生成几张';
    if (active && Number(refs.batch.value) !== 1) {
      refs.batch.value = '1';
      t2i.batch = 1;
      patchSettings({ t2i: { batch: 1 } });
    }
  }

  /** 提交前校验布局框：越界 / 零面积 / 文字框为空都直接拦截。 */
  function validateBboxPayload(payload) {
    if (!payload?.bbox?.enabled) return '';
    for (const item of payload.bbox.items) {
      if (![item.x, item.y, item.w, item.h].every(Number.isFinite)) return '布局框坐标无效';
      if (item.w < 16 || item.h < 16) return '布局框最小尺寸为 16×16';
      if (item.type === 'text' && !String(item.text || '').trim()) return '文字框必须填写文字';
      if (item.x < 0 || item.y < 0
          || item.x + item.w > payload.width || item.y + item.h > payload.height) {
        return '存在超出画布的布局框，请重新调整';
      }
    }
    return '';
  }

  function openBboxDialog() {
    const [width, height] = currentCanvasSize();
    openBboxStudio({
      width,
      height,
      initial: clone(bboxState()),
      onApply: ({ enabled, characterBoxes, items }) => {
        t2i.bbox = {
          enabled: Boolean(enabled),
          characterBoxes: characterBoxes ?? '1',
          items: Array.isArray(items) ? items : [],
        };
        patchSettings({ t2i: { bbox: t2i.bbox } });
        syncBboxUi();
        updateSummary();
        toastSuccess(`布局已应用：${t2i.bbox.items.length} 个框`);
      },
      onClear: () => {
        t2i.bbox = { enabled: false, characterBoxes: bboxState().characterBoxes || '1', items: [] };
        patchSettings({ t2i: { bbox: t2i.bbox } });
        syncBboxUi();
        updateSummary();
        toastSuccess('已清空布局');
      },
    });
  }

  refs.bboxEnabled.addEventListener('change', () => {
    const bbox = bboxState();
    if (refs.bboxEnabled.checked && !bbox.items.length) {
      refs.bboxEnabled.checked = false;
      openBboxDialog();
      return;
    }
    t2i.bbox = { ...bbox, enabled: refs.bboxEnabled.checked };
    patchSettings({ t2i: { bbox: t2i.bbox } });
    syncBboxUi();
    updateSummary();
  });
  refs.bboxCharacters.addEventListener('change', () => {
    t2i.bbox = { ...bboxState(), characterBoxes: refs.bboxCharacters.value };
    patchSettings({ t2i: { bbox: t2i.bbox } });
    syncBboxUi();
  });
  refs.bboxOpen.addEventListener('click', openBboxDialog);
  refs.bboxPill.addEventListener('click', openBboxDialog);
  refs.bboxClear.addEventListener('click', () => {
    t2i.bbox = { enabled: false, characterBoxes: bboxState().characterBoxes || '1', items: [] };
    patchSettings({ t2i: { bbox: t2i.bbox } });
    syncBboxUi();
    updateSummary();
    toastSuccess('已清空布局');
  });

  refs.modelPill.addEventListener('click', (event) => {
    event.stopPropagation();
    if (jobActive) {
      toastWarn('任务进行中，完成后再切换模型');
      return;
    }
    setModelPop(refs.modelPop.hidden);
  });
  refs.modelPop.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => setModelPop(false));

  /** 采样参数输入框与模型相关提示（负向默认值 / placeholder）。 */
  function syncSamplingFields() {
    refs.steps.value = String(t2i.steps);
    refs.cfg.value = String(t2i.cfg);
    refs.batch.value = String(t2i.batch);
    refs.negative.value = t2i.negativePrompt || '';
    const negativeDefault = modelDefaults().negative_prompt || '';
    refs.negative.placeholder = negativeDefault
      ? `负向提示词（留空 = 默认：${negativeDefault}）`
      : '负向提示词（可选）：文字、水印、模糊、畸变';
    refs.negative.title = negativeDefault ? `留空时使用模型默认：${negativeDefault}` : '';
  }

  /** 默认值提示：未改动显示「默认 X」，改动后显示「已改 · 默认 X」。 */
  function setDefaultHint(node, value, fallback) {
    if (!node) return;
    if (fallback == null || fallback === '') {
      node.textContent = '';
      node.classList.remove('is-changed');
      return;
    }
    const same = String(value) === String(fallback);
    node.textContent = same ? `默认 ${fallback}` : `已改 · 默认 ${fallback}`;
    node.classList.toggle('is-changed', !same);
  }

  function syncDefaultHints() {
    const d = modelDefaults();
    setDefaultHint(refs.stepsHint, Number(refs.steps.value) || d.steps, d.steps);
    setDefaultHint(refs.cfgHint, Number(refs.cfg.value), d.cfg);
    setDefaultHint(refs.samplerHint, refs.sampler.value, d.sampler);
    setDefaultHint(refs.schedulerHint, refs.scheduler.value, d.scheduler);
    const steps = Number(refs.steps.value);
    const cfg = Number(refs.cfg.value);
    refs.stepsPresets.querySelectorAll('[data-steps]').forEach((button) => {
      const active = Number(button.dataset.steps) === steps
        && Math.abs(Number(button.dataset.cfg) - cfg) < 0.01;
      button.classList.toggle('active', active);
    });
  }

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
      initial: {
        // 3D 编辑器：把上次的姿势原样带回去，接着改
        pose3d: poseState?.pose3d || '',
        strength: poseState?.strength,
        useLora: poseState?.useLora,
      },
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

  /** 按「长边 = 档位」算尺寸；官方预设仅在长边等于档位时直接采用。 */
  function sizeForRatio(id, tier = sizeTier) {
    const multiple = modelSnap();
    const sphere = findSphereSize(id);
    if (sphere) return { w: sphere.width, h: sphere.height };
    const official = ratioList().find((ratio) => ratio.id === id);
    if (official && Math.max(official.w, official.h) === tier) {
      return { w: official.w, h: official.h };
    }
    const { rw, rh } = ratioPair(id);
    const long = clampSide(tier);
    if (rw >= rh) {
      return { w: long, h: clampSide(Math.round((long * rh) / rw / multiple) * multiple) };
    }
    return { w: clampSide(Math.round((long * rw) / rh / multiple) * multiple), h: long };
  }

  /** 根据长边推断档位（官方预设尺寸就近归档）。 */
  function inferTier(width, height) {
    const long = Math.max(Number(width) || 0, Number(height) || 0);
    if (!long) return 2048;
    let best = SIZE_TIERS[0].value;
    for (const tier of SIZE_TIERS) {
      if (Math.abs(long - tier.value) < Math.abs(long - best)) best = tier.value;
    }
    return best;
  }

  /** 当前尺寸对应的比例 id，找不到就是自定义。 */
  function detectRatioId(width, height) {
    const sphere = SPHERE_SIZES.find((size) => size.width === width && size.height === height);
    if (sphere) return sphere.id;
    const official = ratioList().find((ratio) => ratio.w === width && ratio.h === height);
    if (official && SIZE_RATIOS.includes(official.id)) return official.id;
    return SIZE_RATIOS.find((id) => {
      const size = sizeForRatio(id, sizeTier);
      return size.w === width && size.h === height;
    }) || '';
  }

  function applySize(width, height, ratioId = '') {
    const oldWidth = Number(t2i.width) || 0;
    const oldHeight = Number(t2i.height) || 0;
    const bbox = t2i.bbox;
    if (oldWidth && oldHeight && (oldWidth !== width || oldHeight !== height)
        && bbox?.enabled && bbox.items?.length) {
      const keep = window.confirm(
        `画布尺寸将从 ${oldWidth}×${oldHeight} 变为 ${width}×${height}。\n\n`
        + '确定：按比例缩放所有布局框；取消：清空布局。',
      );
      if (keep) {
        const fx = width / oldWidth;
        const fy = height / oldHeight;
        t2i.bbox = {
          ...bbox,
          items: bbox.items.map((item) => ({
            ...item,
            x: Math.round(item.x * fx),
            y: Math.round(item.y * fy),
            w: Math.max(16, Math.round(item.w * fx)),
            h: Math.max(16, Math.round(item.h * fy)),
          })),
        };
      } else {
        t2i.bbox = { ...bbox, enabled: false, items: [] };
      }
      patchSettings({ t2i: { bbox: t2i.bbox } });
      syncBboxUi();
    }
    t2i.width = clampSide(width);
    t2i.height = clampSide(height);
    t2i.ratioId = ratioId;
    t2i.custom = !ratioId;
    patchSettings({
      t2i: { width: t2i.width, height: t2i.height, ratioId, custom: !ratioId },
    });
    syncSizeCard();
    updateSummary();
  }

  /** 尺寸弹框：分辨率档位 + 比例网格 + 自定义。 */
  function renderSizeCard() {
    refs.sizeTiers.innerHTML = SIZE_TIERS.map(
      (tier) => `<button class="size-tier" type="button" data-tier="${tier.value}">${tier.label}</button>`,
    ).join('');
    refs.sizeTiers.querySelectorAll('[data-tier]').forEach((button) => {
      button.addEventListener('click', () => {
        const ratioId = detectRatioId(t2i.width, t2i.height);
        // 360° 档是固定 2:1 尺寸，不跟随分辨率档位变化，避免档位高亮与实际尺寸不一致
        if (isSphereSizeId(ratioId)) {
          syncSizeCard();
          return;
        }
        sizeTier = Number(button.dataset.tier) || 2048;
        if (ratioId) {
          const size = sizeForRatio(ratioId, sizeTier);
          applySize(size.w, size.h, ratioId);
        } else {
          syncSizeCard();
        }
      });
    });

    const renderRatio = (id) => {
      const { rw, rh } = ratioPair(id);
      const scale = Math.min(18 / rw, 16 / rh);
      const gw = Math.max(2, Math.round(rw * scale));
      const gh = Math.max(2, Math.round(rh * scale));
      return `
        <button class="size-ratio-item" type="button" data-ratio="${id}" title="${id}">
          <span class="ratio-glyph" style="width:${gw}px;height:${gh}px"></span>
          <span class="ratio-label">${id}</span>
        </button>`;
    };
    const renderSphere = (size) => `
        <button class="size-ratio-item" type="button" data-sphere="${size.id}" title="360° 等距柱状 · ${size.width}×${size.height}">
          <span class="ratio-glyph" style="width:18px;height:9px"></span>
          <span class="ratio-label">${size.label}</span>
        </button>`;
    refs.sizeRatios.innerHTML = [
      ...SIZE_RATIOS.filter((id) => !PANORAMA_RATIOS.includes(id)).map(renderRatio),
      '<div class="size-ratio-group">宽幅</div>',
      ...PANORAMA_RATIOS.map(renderRatio),
      '<div class="size-ratio-group">360° 全景</div>',
      ...SPHERE_SIZES.map(renderSphere),
    ].join('');
    refs.sizeRatios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.addEventListener('click', () => {
        const size = sizeForRatio(button.dataset.ratio, sizeTier);
        applySize(size.w, size.h, button.dataset.ratio);
      });
    });
    refs.sizeRatios.querySelectorAll('[data-sphere]').forEach((button) => {
      button.addEventListener('click', () => {
        const size = findSphereSize(button.dataset.sphere);
        if (!size) return;
        applySize(size.width, size.height, size.id);
      });
    });
  }

  function syncSizeCard() {
    const width = t2i.width;
    const height = t2i.height;
    const ratioId = detectRatioId(width, height);
    const sphereActive = isSphereSizeId(ratioId);
    refs.sizePillValue.textContent = `${ratioId || '自定义'} · ${fmtNum(width)}×${fmtNum(height)}`;
    refs.sizePopDims.textContent = `${fmtNum(width)} × ${fmtNum(height)}`;
    refs.sizeTiers.querySelectorAll('[data-tier]').forEach((button) => {
      // 360° 固定尺寸没有档位概念，避免与 2K/2.7K 高亮冲突
      button.classList.toggle(
        'active',
        !sphereActive && Number(button.dataset.tier) === sizeTier,
      );
    });
    refs.sizeRatios.querySelectorAll('[data-ratio]').forEach((button) => {
      button.classList.toggle('active', button.dataset.ratio === ratioId);
    });
    refs.sizeRatios.querySelectorAll('[data-sphere]').forEach((button) => {
      button.classList.toggle('active', button.dataset.sphere === ratioId);
    });
    refs.panoPromptRow.hidden = !(PANORAMA_RATIOS.includes(ratioId) || sphereActive);
    refs.panoPromptLabel.textContent = sphereActive
      ? '自动追加 360° 全景提示词'
      : '自动追加宽幅提示词';
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
    const width = snapSize(refs.popWidth.value || t2i.width);
    const height = snapSize(refs.popHeight.value || t2i.height);
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

  function stepsPresetsForModel() {
    const profile = currentProfile();
    const d = profile.defaults || {};
    if (profile.id !== 'qwen') {
      return [
        { id: 'standard', label: `标准 · ${d.steps || 50} 步`, steps: d.steps || 50, cfg: d.cfg ?? 3.5, note: `${profile.label} 默认` },
        { id: 'turbo8', label: 'Turbo · 8 步', steps: 8, cfg: 1.0, note: '需开启 Turbo' },
      ];
    }
    const presets = store.state.options?.steps_presets;
    return Array.isArray(presets) && presets.length ? presets : FALLBACK_STEPS_PRESETS;
  }

  function renderStepsPresets() {
    const presets = stepsPresetsForModel();
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
        syncDefaultHints();
        updateSummary();
      });
    });
  }

  /* ---------------- 采样器 ---------------- */
  function renderSelects() {
    const profile = currentProfile();
    const d = profile.defaults || {};
    const optionSamplers = store.state.options?.samplers;
    const samplers = Array.isArray(profile.samplers) && profile.samplers.length
      ? profile.samplers
      : (Array.isArray(optionSamplers) && optionSamplers.length ? optionSamplers : FALLBACK_SAMPLERS);
    const schedulers = Array.isArray(store.state.options?.schedulers) && store.state.options.schedulers.length
      ? store.state.options.schedulers
      : FALLBACK_SCHEDULERS;
    const samplerOptions = !t2i.sampler || samplers.includes(t2i.sampler)
      ? samplers
      : [...samplers, t2i.sampler];
    const schedulerOptions = !t2i.scheduler || schedulers.includes(t2i.scheduler)
      ? schedulers
      : [...schedulers, t2i.scheduler];
    refs.sampler.innerHTML = samplerOptions.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    refs.scheduler.innerHTML = schedulerOptions.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (!t2i.sampler) {
      t2i.sampler = samplers.includes(d.sampler) ? d.sampler : samplers[0];
      patchSettings({ t2i: { sampler: t2i.sampler } });
    }
    if (!t2i.scheduler) {
      t2i.scheduler = schedulers.includes(d.scheduler) ? d.scheduler : schedulers[0];
      patchSettings({ t2i: { scheduler: t2i.scheduler } });
    }
    refs.sampler.value = t2i.sampler;
    refs.scheduler.value = t2i.scheduler;
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
    syncDefaultHints();
    updateSummary();
  });
  refs.cfg.addEventListener('change', () => {
    t2i.cfg = Math.max(0, Number(refs.cfg.value) || 1);
    refs.cfg.value = String(t2i.cfg);
    patchSettings({ t2i: { cfg: t2i.cfg } });
    syncDefaultHints();
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
    syncDefaultHints();
    updateSummary();
  });
  refs.scheduler.addEventListener('change', () => {
    t2i.scheduler = refs.scheduler.value;
    patchSettings({ t2i: { scheduler: t2i.scheduler } });
    syncDefaultHints();
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

  function turboProfilesForModel() {
    const profile = currentProfile();
    if (Array.isArray(profile.turbo) && profile.turbo.length) return profile.turbo;
    return store.state.options?.turbo_profiles || [];
  }

  function renderTurbo() {
    const profiles = turboProfilesForModel();
    turboControl = new TurboControl(refs.turboHost, {
      profiles,
      defaultProfile: profiles[0]?.id || '',
      initial: {
        enabled: Boolean(t2i.turbo),
        profile: t2i.turboProfile || '',
      },
      onChange: (value) => {
        const d = modelDefaults();
        // 开 Turbo 时记住原采样参数，关掉时还原（否则会一直停在加速档）
        if (value.enabled && !turboSnapshot) {
          turboSnapshot = {
            steps: Number(refs.steps.value) || Number(d.steps) || 25,
            cfg: Number(refs.cfg.value) || Number(d.cfg) || 1,
            sampler: refs.sampler.value || d.sampler || 'euler',
          };
        }
        let restored = null;
        if (!value.enabled) {
          restored = turboSnapshot || {
            steps: Number(d.steps) || 25,
            cfg: Number(d.cfg) || 4,
            sampler: d.sampler || 'euler',
          };
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
        syncDefaultHints();
        updateSummary();
      },
    });
    applyTurboToFields(false);
    // 历史遗留：普通模式下步数不应停在个位数（8 步只在 Turbo 下有意义）
    const defaultSteps = Number(modelDefaults().steps) || 25;
    if (!t2i.turbo && Number(refs.steps.value) < 12 && defaultSteps >= 12) {
      refs.steps.value = String(defaultSteps);
      t2i.steps = defaultSteps;
      patchSettings({ t2i: { steps: defaultSteps } });
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
    // Turbo 底模由后端按预设槽位（turbo_unet）自动切换，前端不再改模型下拉
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

  function renderLoras() {
    const loras = store.state.options?.models?.lora || [];
    loraPicker = new LoraPicker(refs.loraHost, { loras, initial: t2i.loras });
    if (refs.loraHost.dataset.bound) return;
    refs.loraHost.dataset.bound = '1';
    refs.loraHost.addEventListener('change', () => {
      t2i.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ t2i: { loras: t2i.loras } });
      updateSummary();
    });
    refs.loraHost.addEventListener('input', () => {
      t2i.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ t2i: { loras: t2i.loras } });
    });
  }

  function renderModels() {
    const profile = currentProfile();
    const readOnly = profile.id !== 'qwen';
    refs.modelsHost.hidden = readOnly;
    const files = Object.values(profile.files || {}).filter(Boolean);
    refs.modelFiles.hidden = !readOnly;
    refs.modelFiles.textContent = readOnly
      ? `当前模型权重（只读）：${files.length ? files.join(' · ') : '未配置'}`
      : '';
    if (readOnly) return;
    const defaults = store.state.options?.defaults || {};
    const slots = currentModelId() === 'moss'
      ? (defaults.t2i_moss || defaults.t2i)
      : (defaults.t2i_qwen || defaults.t2i);
    new ModelsSummary(refs.modelsHost, { slots: slots || defaults.slots || defaults });
  }

  /* ---------------- 参数摘要 ---------------- */
  function defaultActionHint() {
    const profile = currentProfile();
    const resident = store.state.health?.engine?.model || null;
    if (resident && resident !== profile.id) {
      const residentLabel = profileById(resident)?.label || resident;
      return `生成前将卸载 ${residentLabel} 并加载 ${profile.label}（约 30~60s）`;
    }
    if (profile.id === 'moss' && resident !== 'moss') {
      return 'MOSS 首次加载约 30~60s，显存约 20GB';
    }
    return '首次生成需要加载模型，可能要等待一段时间';
  }

  function updateSummary() {
    if (!refs.summary) return;
    const profile = currentProfile();
    const d = profile.defaults || {};
    const caps = profile.capabilities || {};
    const width = snapSize(t2i.width);
    const height = snapSize(t2i.height);
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
    const stepsValue = Number(refs.steps.value) || 0;
    const cfgValue = Number(refs.cfg.value) || 0;
    const stepsMark = String(stepsValue) === String(d.steps) ? '（默认）' : '（自定义）';
    const cfgMark = String(cfgValue) === String(d.cfg) ? '（默认）' : '（自定义）';
    const rows = [
      ['模型', `${profile.label} · ${stepsValue} 步${stepsMark} · CFG ${cfgValue}${cfgMark} · ${refs.sampler.value}`],
      ['尺寸', `${fmtNum(width)} × ${fmtNum(height)}`],
      ['采样', `${refs.sampler.value} · ${refs.scheduler.value}`],
      ['Turbo', turboOn ? (preset?.label || '开启') : '关闭'],
      ['批量', refs.batch.value],
      ['种子', t2i.seedMode === 'fixed' ? (refs.seed.value.trim() || '0') : '随机'],
      ['LoRA', loraText],
    ];
    if (caps.bbox) {
      const bbox = bboxState();
      rows.push(['布局', bbox.items.length
        ? `${bboxCountText()}${bbox.enabled ? ' · 已启用' : ' · 未启用'}`
        : '未设置']);
    }
    if (caps.rgba) rows.push(['透明背景', refs.rgba.checked ? '是' : '否']);
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
      refs.actionHint.textContent = defaultActionHint();
    }
  }

  /* ---------------- 启动 / 刷新 ---------------- */
  function refreshAll() {
    ensureModelState();
    sizeTier = inferTier(Number(t2i.width) || 2048, Number(t2i.height) || 2048);
    renderSizeCard();
    renderStepsPresets();
    renderSelects();
    renderTurbo();
    renderLoras();
    renderModels();
    applyModelCapabilities();
    syncSamplingFields();
    syncSlgUi();
    syncSizeSnapUi();
    syncDefaultHints();
    syncBboxUi();
    syncModelBar();
    syncModelPill();
    syncSizeCard();
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
  refreshAll();
  on('options:loaded', () => refreshAll());
  // health 变化通过 store 订阅刷新「引擎就绪」提示与模型驻留状态
  store.subscribe(() => {
    renderHealthHint();
    syncModelPill();
  });

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
    const profile = currentProfile();
    const bbox = bboxState();
    await polishWithDialog({
      prompt: refs.prompt.value,
      mode: 't2i',
      model: store.state.polishModel || null,
      imageModel: profile.id,
      layoutHint: profile.capabilities?.bbox && bbox.enabled && bbox.items.length
        ? '这是边界框布局任务：框内文字与物体位置已在布局中单独指定，主提示词只描述整体画面，不要把框内文字写进主提示词。'
        : '',
      styleHint: stylePicker.styleHint(),
      button: refs.polish,
      ratios: ratioList(),
      targetSize: {
        width: snapSize(t2i.width),
        height: snapSize(t2i.height),
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
    const profile = currentProfile();
    const caps = profile.capabilities || {};
    const width = snapSize(t2i.width);
    const height = snapSize(t2i.height);
    t2i.width = width;
    t2i.height = height;

    const turboValue = turboControl.getValue();
    const seedMode = t2i.seedMode === 'fixed' ? 'fixed' : 'random';
    const seedText = refs.seed.value.trim();
    // 随机模式交给后端每次抽新种子；固定模式按输入框，空则用 0
    const seed = seedMode === 'random' ? null : Math.max(0, Math.floor(Number(seedText) || 0));
    const loras = loraPicker.getValue();
    const pickerMeta = stylePicker.getMeta();
    // 负向提示词留空时：有模型默认值就传 null 让后端补默认，否则传空串
    const negative = refs.negative.value.trim();
    const bbox = bboxState();
    const bboxEnabled = Boolean(caps.bbox && bbox.enabled && bbox.items.length);
    const slgStateValue = slgState();

    const composedPrompt = stylePicker.composePrompt(refs.prompt.value.trim());
    const ratioId = detectRatioId(width, height);
    const sphereActive = isSphereSizeId(ratioId);
    const panoActive = PANORAMA_RATIOS.includes(ratioId);
    let promptFinal = composedPrompt;
    if (sphereActive) {
      promptFinal = withSpherePrompt(composedPrompt, refs.panoPrompt.checked);
    } else if (panoActive && refs.panoPrompt.checked && !/panoram/i.test(composedPrompt)) {
      promptFinal = `${composedPrompt}${composedPrompt ? ', ' : ''}${PANORAMA_PROMPT}`;
    }

    return {
      // 正文保持原文，预设/视角在这里合成为最终提示词
      prompt: promptFinal,
      model: profile.id,
      negative_prompt: negative || (caps.rgba && !modelDefaults().negative_prompt ? '' : null),
      width,
      height,
      steps: Number(refs.steps.value) || Number(modelDefaults().steps) || 25,
      cfg: Number(refs.cfg.value) || Number(modelDefaults().cfg) || 4.0,
      seed,
      batch: Number(refs.batch.value) || 1,
      sampler: refs.sampler.value || modelDefaults().sampler || 'euler',
      scheduler: refs.scheduler.value || modelDefaults().scheduler || 'simple',
      turbo: {
        enabled: turboValue.enabled,
        profile: turboValue.profile,
      },
      rgba: Boolean(caps.rgba && refs.rgba.checked),
      loras,
      slg: caps.slg
        ? {
            enabled: Boolean(slgStateValue.enabled),
            single_layers: slgStateValue.singleLayers ?? '',
            double_layers: slgStateValue.doubleLayers ?? '',
            start_percent: Number(slgStateValue.startPercent ?? 0),
            end_percent: Number(slgStateValue.endPercent ?? 0.5),
          }
        : undefined,
      bbox: bboxEnabled
        ? {
            enabled: true,
            canvas: [width, height],
            character_boxes: bbox.characterBoxes ?? '1',
            items: bbox.items.map((item) => ({
              x: Math.round(item.x),
              y: Math.round(item.y),
              width: Math.round(item.w),
              height: Math.round(item.h),
              w: Math.round(item.w),
              h: Math.round(item.h),
              type: item.type || 'object',
              text: item.text || '',
              desc: item.desc || '',
            })),
          }
        : undefined,
      pose: profile.id === 'qwen' && poseState
        ? {
            image: poseState.dataUrl,
            width: poseState.width,
            height: poseState.height,
            label: poseState.label,
            summary: poseState.summary,
            strength: poseState.strength,
            use_lora: poseState.useLora,
          }
        : null,
      meta: {
        source: 'web/t2i',
        model: profile.id,
        ratio: t2i.ratioId || null,
        rawPrompt: refs.prompt.value.trim(),
        creativePresets: pickerMeta.creativePresets,
        imageAngle: pickerMeta.imageAngle,
        pose: poseState ? { label: poseState.label, summary: poseState.summary } : null,
        client: 'qwen-image2.1-web',
      },
    };
  }

  /** 把任务进度同步到底部操作条：条永远可见，用户不用滚到结果面板看进度。 */
  function syncActionProgress(job) {
    if (!refs.actionBar) return;
    if (!job) {
      refs.actionBar.classList.remove('is-running', 'is-done', 'is-error');
      if (refs.actionStrip) refs.actionStrip.style.width = '0%';
      refs.actionHint.textContent = defaultActionHint();
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
    refs.actionHint.textContent = parts.join(' · ') || defaultActionHint();
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
    jobActive = true;
    syncModelPill();
    try {
      // 等 vendor 模块就绪，确保预设能合成进提示词
      await stylePicker.ensureVendor();
      if (stylePicker.hasSelection() && !stylePicker.isReady()) {
        toastWarn('风格模块未就绪：本次将只使用原始提示词（可稍后重试）');
      }
      const payload = collectPayload();
      const bboxError = validateBboxPayload(payload);
      if (bboxError) {
        toastWarn(bboxError);
        return;
      }
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
      jobActive = false;
      syncModelPill();
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
    const profile = currentProfile();
    const d = profile.defaults || {};
    const defaults = {
      steps: Number(d.steps) || 25,
      cfg: Number(d.cfg) || 4.0,
      batch: 1,
      seed: '',
      seedMode: 'random',
      sampler: d.sampler || 'euler',
      scheduler: d.scheduler || 'simple',
      rgba: false,
      turbo: false,
      turboProfile: profile.turbo?.[0]?.id || '',
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
    syncDefaultHints();
    syncSizeCard();
    updateSummary();
    toastSuccess('采样参数已重置为模型默认值');
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
      const width = snapSize(payload.width);
      const height = snapSize(payload.height);
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
