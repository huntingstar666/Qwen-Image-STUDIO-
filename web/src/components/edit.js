/**
 * 「图像编辑」页面。
 * 职责：
 * 1. 编辑指令（含负向提示词）与提示词润色（mode=edit）；
 * 2. 参考图上传：拖拽/选择 1~10 张，第 1 张标注「编辑目标」，其余「参考图 N」，可拖动排序、可删除；
 * 3. 尺寸模式：跟随原图 / 自定义 / 按比例 / BlueBox 32 不动点；fit=pad|crop；
 * 4. 遮罩编辑器（Canvas 2D 自研，见 maskEditor.js）；
 * 5. 局部编辑：方案 A 全画布 / 方案 B 裁切，羽化、外扩、颜色匹配、上下文参数；
 * 6. 一致性 LoRA、采样参数、Turbo；
 * 7. 编辑指令上方嵌入风格选择器（风格 / MJ 码图 / 滤镜 / 视角，提交时合成进指令）；
 * 8. POST /api/edit 后轮询任务，展示结果、尺寸、align.canvas 与零色差校验（quality.outside_max_abs）。
 */

import { api } from '../api.js';
import { on, patchSettings, store } from '../store.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';
import { polishWithDialog } from './polish.js';
import { JobRunner } from './jobView.js';
import { createHistoryRail } from './historyRail.js';
import { createRefLibrary, hasRefDrag, readRefDrag } from './refLibrary.js';
import { PromptEditor } from './promptEditor.js';
import { MaskEditor } from './maskEditor.js';
import { createStylePicker } from './stylePicker.js';
import { LoraPicker, ModelsField, TurboControl } from './controls.js';
import { openModal } from './modal.js';
import { openPoseStudio } from './poseStudio.js';
import { openCompareDialog } from './compare.js';
import { consumeHandoff } from '../handoff.js';
import { OUTPAINT_DIRECTIONS, OUTPAINT_DIRECTION_LABELS, planOutpaint } from '../outpaint.js';
import { escapeHtml, fmtNum, readFileAsDataURL, probeImageSize, snapUp } from '../utils.js';

const MAX_IMAGES = 10;

const FALLBACK_RATIOS = [
  { id: '1:1', label: '1:1 方形', w: 2048, h: 2048 },
  { id: '4:3', label: '4:3 横幅', w: 2048, h: 1536 },
  { id: '3:4', label: '3:4 竖幅', w: 1536, h: 2048 },
  { id: '16:9', label: '16:9 宽银幕', w: 2048, h: 1152 },
  { id: '9:16', label: '9:16 竖屏', w: 1152, h: 2048 },
];
const FALLBACK_SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'res_multistep', 'lcm'];
const FALLBACK_SCHEDULERS = ['simple', 'normal', 'beta', 'karras', 'exponential'];

export function createEditPage(host) {
  const edit = store.state.edit;
  let images = [];
  let turboControl = null;
  let loraPicker = null;
  let turboSnapshot = null; // 开 Turbo 前的 steps/cfg/sampler，关掉时还原
  let turboModelSnapshot = null; // 开 Turbo 前用户选的底模，切回普通模式时还原
  let modelsField = null;
  let dragFrom = null;
  let lastSeed = null;

  host.innerHTML = `
    <div class="page wb-page page-edit-v2">
      <div class="wb-layout with-lib" data-ref="layout">
        <aside class="wb-adv" data-ref="advDrawer" aria-label="图生图高级设置">
          <div class="wb-adv-head">
            <span>图生图高级设置</span>
            <button class="wb-adv-close" type="button" data-ref="advClose" title="收起侧边栏">×</button>
          </div>
          <div class="wb-adv-body">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">尺寸与画布 <span class="panel-sub">零偏移对齐</span></div>
          </div>
          <div class="panel-body">
            <div class="wb-adv-rows" data-ref="modeRows"></div>
            <div class="grid-2">
              <label class="field">
                <span class="field-label">适配方式</span>
                <select class="select" data-ref="fit">
                  <option value="pad">补边 pad</option>
                  <option value="crop">裁切 crop</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">补边模式</span>
                <select class="select" data-ref="padMode">
                  <option value="edge">edge 边缘延伸</option>
                </select>
              </label>
            </div>
            <div class="size-summary">
              <span>输出</span><span class="mono" data-ref="sizeInfo">—</span>
              <span class="spacer"></span>
              <span class="field-hint" data-ref="canvasHint">采样画布向上对齐到 32 的倍数</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">局部编辑 <span class="panel-sub">只重绘遮罩白色区域</span></div>
          </div>
          <div class="panel-body">
            <label class="switch">
              <input type="checkbox" data-ref="localEnabled" />
              <span class="switch-track"></span>
              <span class="switch-label">开启局部编辑<small>遮罩外逐像素保留原图（零色差）</small></span>
            </label>
            <div class="notice warn hidden" data-ref="localDisabledNote">局部编辑已关闭：当前遮罩不会提交，整张图按全局编辑处理。</div>
            <div class="wb-adv-rows" data-ref="localOptions">
              <div class="field">
                <span class="field-label">编辑方案</span>
                <div class="radio-row">
                  <label class="radio-pill"><input type="radio" name="edit-scheme" value="a" data-ref="schemeA" />方案 A · 全画布</label>
                  <label class="radio-pill"><input type="radio" name="edit-scheme" value="b" data-ref="schemeB" />方案 B · 裁切</label>
                </div>
                <div class="field-hint">方案 A：整幅画布参与采样，按遮罩合成；方案 B：只裁出遮罩区域采样再拼回，省显存。</div>
              </div>
              <div class="grid-2">
                <label class="field">
                  <span class="field-label">羽化 <span class="tag-hint" data-ref="featherVal">32 px</span></span>
                  <input class="range" type="range" min="0" max="128" step="1" data-ref="feather" />
                </label>
                <label class="field">
                  <span class="field-label">外扩 <span class="tag-hint" data-ref="expandVal">0 px</span></span>
                  <input class="range" type="range" min="0" max="64" step="1" data-ref="expand" />
                </label>
              </div>
              <label class="switch">
                <input type="checkbox" data-ref="colorMatch" />
                <span class="switch-track"></span>
                <span class="switch-label">颜色匹配（Reinhard）<small>把编辑区颜色统计拉回原图，减少色差</small></span>
              </label>
              <div class="grid-2">
                <label class="field">
                  <span class="field-label">颜色强度 <span class="tag-hint" data-ref="colorStrengthVal">0.60</span></span>
                  <input class="range" type="range" min="0" max="1" step="0.05" data-ref="colorStrength" />
                </label>
                <label class="field">
                  <span class="field-label">上下文倍数 <span class="tag-hint" data-ref="contextFactorVal">1.5×</span></span>
                  <input class="range" type="range" min="1" max="3" step="0.1" data-ref="contextFactor" />
                </label>
              </div>
              <div class="grid-2">
                <label class="field">
                  <span class="field-label">上下文像素</span>
                  <input class="input mono" type="number" min="0" max="1024" step="8" data-ref="contextPixels" />
                </label>
                <label class="field">
                  <span class="field-label">混合像素</span>
                  <input class="input mono" type="number" min="0" max="256" step="4" data-ref="blendPixels" />
                </label>
              </div>
              <div class="notice info">羽化与外扩会实时叠加到遮罩编辑器的红色预览；提交的遮罩尺寸 = 第 1 张图尺寸。</div>
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
                <span class="field-label">降噪 denoise</span>
                <input class="input mono" type="number" min="0" max="1" step="0.05" data-ref="denoise" />
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
          <summary>高级：模型、LoRA 与一致性</summary>
          <div class="fold-body">
            <div class="wb-adv-stack" data-ref="modelsHost"></div>
            <div class="field">
              <span class="field-label">LoRA <span class="tag-hint">按需添加 · 可调强度</span></span>
              <div class="wb-adv-stack" data-ref="loraHost"></div>
            </div>
            <label class="switch">
              <input type="checkbox" data-ref="consistencyEnabled" />
              <span class="switch-track"></span>
              <span class="switch-label">一致性 LoRA<small>约束编辑后与原图的身份 / 风格一致</small></span>
            </label>
            <div class="grid-2" data-ref="consistencyRows">
              <label class="field">
                <span class="field-label">LoRA</span>
                <select class="select mono" data-ref="consistencyLora"></select>
              </label>
              <label class="field">
                <span class="field-label">强度 <span class="tag-hint" data-ref="consistencyStrengthVal">1.00</span></span>
                <input class="range" type="range" min="0" max="2" step="0.05" data-ref="consistencyStrength" />
              </label>
            </div>
          </div>
        </details>
            <button class="btn ghost block" type="button" data-ref="reset">重置参数</button>
            <div class="wb-adv-note">尺寸与采样参数都在这里；参考图缩略图上的 ✂ 可打开遮罩编辑器。</div>
          </div>
        </aside>

        <div class="wb-side">
          <aside class="wb-lib" data-ref="libHost" aria-label="小图库"></aside>

          <section class="wb-refbox" data-ref="refBox" aria-label="参考图">
            <div class="refbox-head">
              <span class="refbox-title">参考图</span>
              <span class="refbox-count mono" data-ref="uploadCount">0 / ${MAX_IMAGES}</span>
              <span class="spacer"></span>
              <button class="refbox-link" type="button" data-ref="outpaintBtn" title="先规划扩图画布，再自动生成「新增区域」遮罩">⤢ 扩图</button>
              <button class="refbox-link" type="button" data-ref="clearImages">清空</button>
            </div>
            <div class="refbox-body">
              <div class="upload-list wb-upload-list" data-ref="uploadList"></div>
              <div class="dropzone wb-dropzone refbox-drop" data-ref="dropzone" role="button" tabindex="0">
                <div class="glyph">＋</div>
                <div class="wb-drop-text">
                  <b>拖拽图片到这里</b>
                  <small>或点击上传 · 第 1 张为「编辑目标」</small>
                </div>
              </div>
            </div>
            <div class="refbox-foot" data-ref="uploadHint">第 1 张同时作为遮罩编辑器底图与输出尺寸基准。</div>
            <input type="file" accept="image/*" multiple hidden data-ref="fileInput" />
          </section>
        </div>

        <main class="wb-main">
          <div class="wb-topbar">
            <span class="wb-topbar-hint">上传参考图 · 描述修改 · 生成，高级参数收在右侧</span>
            <span class="spacer"></span>
            <button class="wb-compare-btn" type="button" data-ref="compareBtn">⧉ 图像对比</button>
            <button class="wb-adv-toggle" type="button" data-ref="advToggle" aria-expanded="false">
              <span class="wb-adv-icon">⚙</span> 图生图高级设置
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
                <div class="wb-art-glyph">让每一笔都有回响</div>
                <div class="wb-art-sub">REFINE · THEN BLOOM</div>
                <div class="wb-art-foot">一图一世界 · 一笔一呼吸</div>
              </div>
              <div class="wb-art-seal">修</div>
            </div>
            <div class="wb-feed-body" data-ref="resultHost"></div>
          </section>

          <div class="wb-composer" data-ref="composer">
            <div class="wb-status">
              <span class="wb-status-dot"></span>
              <span class="wb-status-ready" data-ref="readyHint">引擎就绪后可直接编辑</span>
              <span class="wb-status-sub" data-ref="actionHint">第 1 张图会被完整读取，输出尺寸遵循所选模式</span>
              <span class="spacer"></span>
              <div class="wb-status-job" data-ref="statusStrip"></div>
            </div>
            <div class="wb-prompt-wrap">
              <div data-ref="stylePicker"></div>
              <div class="wb-prompt" data-ref="prompt" spellcheck="false"
                data-placeholder="描述如何修改画面，例如：把人物外套换成红色羽绒服，保持脸部光影与背景不变。输入 @ 可引用小图库里的参考图。"></div>
              <div class="wb-prompt-foot">
                <span class="wb-char" data-ref="promptCount">0 字</span>
                <input class="wb-negative" data-ref="negative" placeholder="负向提示词（可选）：文字、水印、变形、重复人物" />
                <button class="wb-link" type="button" data-ref="atRef" title="引用小图库里的参考图">＠ 参考图</button>
                <button class="wb-link" type="button" data-ref="clearPrompt">清空</button>
                <button class="wb-link accent" type="button" data-ref="polish">✦ 润色指令</button>
              </div>
            </div>
            <div class="wb-pillbar">
              <div class="wb-size-anchor" data-ref="sizeAnchor">
                <button class="wb-pill wb-size-pill" type="button" data-ref="sizePill" aria-expanded="false" title="输出尺寸">
                  <span class="wb-pill-key">尺寸</span>
                  <span class="wb-size-value" data-ref="sizePillValue">跟随原图</span>
                  <span class="wb-caret">▼</span>
                </button>
                <div class="size-pop" data-ref="sizePop" hidden>
                  <div class="size-pop-head">
                    <span>尺寸模式</span>
                    <span class="size-pop-dims mono" data-ref="sizePopDims">—</span>
                  </div>
                  <div class="size-tier-row" data-ref="sizeModes">
                    <button class="size-tier" type="button" data-mode="follow">跟随原图</button>
                    <button class="size-tier" type="button" data-mode="ratio">按比例</button>
                    <button class="size-tier" type="button" data-mode="custom">自定义</button>
                    <button class="size-tier" type="button" data-mode="fixed_point">32 不动点</button>
                  </div>
                  <div class="size-pop-body" data-ref="sizeBody"></div>
                </div>
                <select data-ref="sizeMode" hidden>
                  <option value="follow">跟随原图</option>
                  <option value="custom">自定义尺寸</option>
                  <option value="ratio">按比例</option>
                  <option value="fixed_point">32 不动点</option>
                </select>
              </div>
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
              <button class="wb-pill wb-pill-check" type="button" data-ref="localPill" title="只重绘遮罩区域">
                <span class="wb-check-dot"></span><span>局部编辑</span>
              </button>
              <span class="spacer"></span>
              <span class="wb-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
              <button class="btn primary lg wb-generate" type="button" data-ref="submit">开始编辑</button>
            </div>
          </div>
        </main>
      </div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    polish: ref('polish'),
    prompt: ref('prompt'),
    promptCount: ref('promptCount'),
    negative: ref('negative'),
    atRef: ref('atRef'),
    clearPrompt: ref('clearPrompt'),
    libHost: ref('libHost'),
    refBox: ref('refBox'),
    composer: ref('composer'),
    uploadCount: ref('uploadCount'),
    dropzone: ref('dropzone'),
    fileInput: ref('fileInput'),
    uploadList: ref('uploadList'),
    uploadHint: ref('uploadHint'),
    clearImages: ref('clearImages'),
    sizeMode: ref('sizeMode'),
    sizeAnchor: ref('sizeAnchor'),
    sizePill: ref('sizePill'),
    sizePillValue: ref('sizePillValue'),
    sizePop: ref('sizePop'),
    sizePopDims: ref('sizePopDims'),
    sizeModes: ref('sizeModes'),
    sizeBody: ref('sizeBody'),
    modeRows: ref('modeRows'),
    fit: ref('fit'),
    padMode: ref('padMode'),
    sizeInfo: ref('sizeInfo'),
    canvasHint: ref('canvasHint'),
    localEnabled: ref('localEnabled'),
    localOptions: ref('localOptions'),
    localDisabledNote: ref('localDisabledNote'),
    schemeA: ref('schemeA'),
    schemeB: ref('schemeB'),
    feather: ref('feather'),
    featherVal: ref('featherVal'),
    expand: ref('expand'),
    expandVal: ref('expandVal'),
    colorMatch: ref('colorMatch'),
    colorStrength: ref('colorStrength'),
    colorStrengthVal: ref('colorStrengthVal'),
    contextFactor: ref('contextFactor'),
    contextFactorVal: ref('contextFactorVal'),
    contextPixels: ref('contextPixels'),
    blendPixels: ref('blendPixels'),
    steps: ref('steps'),
    cfg: ref('cfg'),
    denoise: ref('denoise'),
    seed: ref('seed'),
    seedFixed: ref('seedFixed'),
    seedRandom: ref('seedRandom'),
    randomSeed: ref('randomSeed'),
    reuseSeed: ref('reuseSeed'),
    sampler: ref('sampler'),
    scheduler: ref('scheduler'),
    turboHost: ref('turboHost'),
    turboLock: ref('turboLock'),
    modelsHost: ref('modelsHost'),
    loraHost: ref('loraHost'),
    consistencyEnabled: ref('consistencyEnabled'),
    consistencyRows: ref('consistencyRows'),
    consistencyLora: ref('consistencyLora'),
    consistencyStrength: ref('consistencyStrength'),
    consistencyStrengthVal: ref('consistencyStrengthVal'),
    submit: ref('submit'),
    reset: ref('reset'),
    readyHint: ref('readyHint'),
    actionHint: ref('actionHint'),
    resultHost: ref('resultHost'),
    resultState: ref('resultState'),
    stylePicker: ref('stylePicker'),
    outpaintBtn: ref('outpaintBtn'),
    layout: ref('layout'),
    advDrawer: ref('advDrawer'),
    advToggle: ref('advToggle'),
    advClose: ref('advClose'),
    ratioPill: null,
    turboPill: ref('turboPill'),
    posePill: ref('posePill'),
    poseThumb: ref('poseThumb'),
    poseLabel: ref('poseLabel'),
    localPill: ref('localPill'),
    statusStrip: ref('statusStrip'),
    feedClear: ref('feedClear'),
    compareBtn: ref('compareBtn'),
  };

  const historyRail = createHistoryRail(host, { label: '图生图历史' });

  /* ============================================================
   * 姿态参考：与文生图共用姿态工作室，提交时作为 image1
   * ============================================================ */
  let poseState = null;

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
        toastSuccess(`姿态已应用：${pose.label}，提交时会作为 image1`);
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

  /** 富文本指令框：普通文字 + @参考图缩略图 chip。 */
  const promptEditor = new PromptEditor(refs.prompt, {
    onChange: (text) => {
      edit.prompt = text;
      patchSettings({ edit: { prompt: text } });
      updatePromptCount();
    },
  });

  /** 左侧小图库：点击加入参考图，拖进指令框即插入 @ 引用。 */
  const refLib = createRefLibrary(refs.libHost, {
    onUse: (item) => useLibraryItem(item),
    onRemove: (item) => removeLibraryItem(item),
  });

  /* 参考图盒子与指令卡等高：底边对齐后，两者的分界线正好落在「引擎已就绪」上方的横线上 */
  const sideEl = refs.libHost.closest('.wb-side');
  function syncRefBoxHeight() {
    if (!sideEl) return;
    if (window.innerWidth <= 1180) {
      sideEl.style.removeProperty('--refbox-h');
      return;
    }
    const height = Math.round(refs.composer.getBoundingClientRect().height);
    if (height > 0) sideEl.style.setProperty('--refbox-h', `${height}px`);
  }
  if (typeof ResizeObserver === 'function' && sideEl) {
    new ResizeObserver(syncRefBoxHeight).observe(refs.composer);
  }
  window.addEventListener('resize', syncRefBoxHeight);

  const jobRunner = new JobRunner(refs.resultHost, {
    feed: true,
    latestOnly: true,
    progressHost: refs.statusStrip,
    onCompare: (batch) => openCompare(batch),
    onBatch: (batch) => historyRail.add(batch),
    idleText: '生成结果会显示在这里，历史记录收在右侧书脊里，点击即可展开。',
  });
  // 编辑指令上方的风格选择器（与文生图页各自独立）
  const stylePicker = createStylePicker(refs.stylePicker, { scope: 'edit' });
  // MJ 码图等预设按光标插入：contenteditable 走 insertPromptText 适配
  stylePicker.attachPrompt({
    insertPromptText(text) {
      promptEditor.insertText(`\n${String(text || '').trim()}`);
      return true;
    },
  });

  /* ============================================================
   * 侧栏 / 输入框 pill / 图像对比入口
   * ============================================================ */
  function setAdvancedOpen(open) {
    refs.layout.classList.toggle('adv-open', open);
    refs.advToggle.setAttribute('aria-expanded', String(open));
    refs.advToggle.innerHTML = open
      ? '<span class="wb-adv-icon">⚙</span> 收起高级设置'
      : '<span class="wb-adv-icon">⚙</span> 图生图高级设置';
  }

  refs.advToggle.addEventListener('click', () => {
    const open = !refs.layout.classList.contains('adv-open');
    setAdvancedOpen(open);
    if (open) refs.advDrawer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  refs.advClose.addEventListener('click', () => setAdvancedOpen(false));

  refs.feedClear.addEventListener('click', () => {
    jobRunner.clearFeed();
    historyRail.clear();
    refs.resultState.textContent = '等待任务';
  });

  refs.localPill.addEventListener('click', () => {
    refs.localEnabled.checked = !refs.localEnabled.checked;
    refs.localEnabled.dispatchEvent(new Event('change', { bubbles: true }));
  });

  refs.turboPill.addEventListener('click', () => {
    if (!turboControl) return;
    const enabled = Boolean(turboControl.getValue().enabled);
    if (!enabled && !turboControl.profiles.length) {
      toastWarn('后端未返回 Turbo 加速预设，暂时无法开启');
      return;
    }
    turboControl.setEnabled(!enabled);
  });

  refs.compareBtn.addEventListener('click', () => openCompare());

  function openCompare(batch = null) {
    const results = jobRunner.getResults();
    if (!images.length) {
      toastWarn('请先上传参考图，再使用图像对比');
      return;
    }
    if (!results.length) {
      toastWarn('还没有生成结果，先运行一次编辑再对比');
      return;
    }
    let initialResult = 0;
    if (batch?.images?.length) {
      const target = batch.images[0].url;
      const found = results.findIndex((item) => item.url === target);
      if (found >= 0) initialResult = found;
    }
    openCompareDialog({
      references: images.map((image, index) => ({
        url: image.dataUrl,
        label: index === 0 ? '编辑目标' : `参考图 ${index + 1}`,
      })),
      results,
      initialReference: 0,
      initialResult,
    });
  }

  /* ============================================================
   * 提示词
   * ============================================================ */
  function updatePromptCount() {
    refs.promptCount.textContent = `${promptEditor.getText().length} 字`;
  }
  promptEditor.setText(edit.prompt || '');
  updatePromptCount();
  refs.negative.value = edit.negativePrompt || '';
  refs.negative.addEventListener('input', () => {
    edit.negativePrompt = refs.negative.value;
    patchSettings({ edit: { negativePrompt: edit.negativePrompt } });
  });
  refs.clearPrompt.addEventListener('click', () => {
    promptEditor.setText('');
    edit.prompt = '';
    patchSettings({ edit: { prompt: '' } });
    updatePromptCount();
    promptEditor.focus();
  });
  refs.polish.addEventListener('click', async () => {
    await polishWithDialog({
      // 润色同样走 <imageN> 语义映射，LLM 才能分清「编辑目标」和「参考图」
      prompt: promptEditor.getSemantic(),
      mode: 'edit',
      model: store.state.polishModel || null,
      styleHint: stylePicker.styleHint(),
      button: refs.polish,
      targetSize: images[0] ? { width: images[0].width, height: images[0].height } : null,
      pose: poseState
        ? { image: poseState.dataUrl, summary: poseState.summary, label: poseState.label }
        : null,
      onAccept: (text) => {
        promptEditor.setText(text);
        edit.prompt = text;
        patchSettings({ edit: { prompt: text } });
        updatePromptCount();
      },
    });
  });

  /* ============================================================
   * 指令框：@ 引用小图库 / 拖图进指令框
   * ============================================================ */
  let atPop = null;
  let atRange = null;

  function caretRectOf(range) {
    const elRect = refs.prompt.getBoundingClientRect();
    if (range) {
      const rect = range.getClientRects()[0] || range.getBoundingClientRect();
      if (rect && (rect.height || rect.width)) return rect;
    }
    return { left: elRect.left + 12, top: elRect.top, bottom: elRect.top + 18 };
  }

  function closeAtPicker() {
    if (!atPop) return;
    atPop.remove();
    atPop = null;
    atRange = null;
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener('scroll', closeAtPicker, true);
    window.removeEventListener('resize', closeAtPicker);
  }

  function onDocPointerDown(event) {
    if (atPop?.contains(event.target)) return;
    closeAtPicker();
  }

  function openAtPicker(range = null) {
    closeAtPicker();
    atRange = range ? range.cloneRange() : null;
    const items = refLib.items;
    const pop = document.createElement('div');
    pop.className = 'ref-at-pop';
    pop.innerHTML = `
      <div class="ref-at-head">
        <span>@ 引用参考图</span>
        <span class="spacer"></span>
        <button class="ref-at-link" type="button" data-act="warehouse">从仓库添加</button>
        <button class="ref-at-link" type="button" data-act="upload">上传</button>
      </div>
      <div class="ref-at-grid">
        ${items
          .map(
            (item, index) => `
          <button class="ref-at-item" type="button" data-src="${escapeHtml(item.src)}" title="${escapeHtml(item.name || '参考图')}">
            <img src="${escapeHtml(item.src)}" alt="" loading="lazy" />
            <span class="mono">${index + 1}</span>
          </button>`,
          )
          .join('')}
      </div>
      ${items.length ? '' : '<div class="ref-at-empty">小图库还是空的，先上传或从仓库添加</div>'}
      <div class="ref-at-foot">点选后自动加入参考图区域 · 也可以直接把小图库的图拖进来</div>`;
    document.body.append(pop);

    const rect = caretRectOf(atRange);
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    pop.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'warehouse') {
        closeAtPicker();
        refs.libHost.querySelector('[data-ref="warehouse"]')?.click();
        return;
      }
      if (act === 'upload') {
        closeAtPicker();
        refs.libHost.querySelector('[data-ref="upload"]')?.click();
        return;
      }
      const btn = event.target.closest('[data-src]');
      if (!btn) return;
      const item = refLib.items.find((entry) => entry.src === btn.dataset.src);
      const range = atRange;
      closeAtPicker();
      if (item) insertLibraryChip(item, range);
    });

    atPop = pop;
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('scroll', closeAtPicker, true);
    window.addEventListener('resize', closeAtPicker);
  }

  refs.prompt.addEventListener('keydown', (event) => {
    if (event.key !== '@' || event.isComposing) return;
    event.preventDefault();
    openAtPicker(promptEditor.currentRange());
  });
  refs.atRef.addEventListener('click', () => {
    promptEditor.focus();
    openAtPicker(promptEditor.currentRange() || promptEditor.endRange());
  });

  refs.prompt.addEventListener('dragover', (event) => {
    if (!hasRefDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    refs.prompt.classList.add('drop-active');
  });
  refs.prompt.addEventListener('dragleave', () => refs.prompt.classList.remove('drop-active'));
  refs.prompt.addEventListener('drop', async (event) => {
    if (!hasRefDrag(event)) return;
    event.preventDefault();
    refs.prompt.classList.remove('drop-active');
    const payload = readRefDrag(event);
    if (!payload?.src) return;
    let range = null;
    try {
      range = document.caretRangeFromPoint?.(event.clientX, event.clientY) || null;
    } catch {
      range = null;
    }
    if (range && range.startContainer.parentElement?.closest('.ref-chip')) range = null;
    let item = refLib.items.find((entry) => entry.src === payload.src);
    if (!item) {
      item = await refLib.addItem({
        src: payload.src,
        name: payload.name,
        width: payload.width,
        height: payload.height,
        source: 'history',
      });
    }
    if (!item) return;
    const safeRange =
      range && (range.startContainer === refs.prompt || refs.prompt.contains(range.startContainer))
        ? range
        : null;
    insertLibraryChip(item, safeRange);
  });

  /* ============================================================
   * 参考图 / 小图库联动
   * ============================================================ */
  function imageLabel(index) {
    return index === 0 ? '编辑目标' : `参考图 ${index + 1}`;
  }

  /** 小图库 → 参考图区域（已在区域里则复用）。 */
  function useLibraryItem(item) {
    const existing = images.find((image) => image.libKey === item.id);
    if (existing) {
      toastWarn('这张图已经在参考图区域了，拖进指令框可插入 @ 引用');
      return existing;
    }
    if (images.length >= MAX_IMAGES) {
      toastWarn(`最多 ${MAX_IMAGES} 张参考图`);
      return null;
    }
    const entry = {
      id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      libKey: item.id,
      name: item.name || '参考图',
      dataUrl: item.src,
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    };
    images.push(entry);
    syncImages();
    toastSuccess(`已加入参考图区域（${imageLabel(images.indexOf(entry))}）`);
    if (!entry.width || !entry.height) {
      probeImageSize(entry.dataUrl)
        .then(({ width, height }) => {
          entry.width = width;
          entry.height = height;
          syncImages();
        })
        .catch(() => {});
    }
    return entry;
  }

  /** 小图库删除 → 对应参考图与指令框里的引用一起消失。 */
  function removeLibraryItem(item) {
    const before = images.length;
    images = images.filter((image) => image.libKey !== item.id);
    if (images.length === before) return;
    syncImages();
    toastSuccess('已从小图库和参考图区域移除');
  }

  /** chip → 当前 images 顺序（第 1 张 = <image1>）。 */
  function resolveChipRef(key) {
    const index = images.findIndex((image) => image.libKey === key);
    if (index < 0) return null;
    const image = images[index];
    return {
      index,
      label: imageLabel(index),
      src: image.dataUrl,
      width: image.width,
      height: image.height,
    };
  }

  /** 确保小图库图片已加入参考图区域。 */
  function ensureLibraryRef(item) {
    return images.find((image) => image.libKey === item.id) || useLibraryItem(item);
  }

  /** 把小图库图片插入指令框，显示为「@ + 缩略图」。 */
  function insertLibraryChip(item, range = null) {
    if (!item) return;
    const entry = ensureLibraryRef(item);
    if (!entry) return;
    const index = images.indexOf(entry);
    promptEditor.insertChip(
      {
        key: item.id,
        src: item.src,
        label: imageLabel(index),
        index,
        width: entry.width,
        height: entry.height,
      },
      range,
    );
  }

  /* ============================================================
   * 遮罩编辑器（点击参考图上的 ✂ 打开）
   * ============================================================ */
  function openMaskDialog(index) {
    const image = images[index];
    if (!image) return;
    const isTarget = index === 0;

    const content = document.createElement('div');
    content.className = 'mask-dialog';
    content.innerHTML = `
      <div class="mask-dialog-bar">
        <img class="mask-dialog-thumb" src="${escapeHtml(image.dataUrl)}" alt="" />
        <div class="mask-dialog-meta">
          <div class="mask-dialog-name">${escapeHtml(image.name || '参考图')}</div>
          <div class="mask-dialog-sub">${imageLabel(index)} · ${image.width} × ${image.height}</div>
        </div>
        <span class="spacer"></span>
        <span class="mask-dialog-tip">涂抹 = 重绘区域 · 滚轮缩放 · 空格/中键平移 · Ctrl+Z 撤销</span>
      </div>
      ${
        isTarget
          ? ''
          : `<div class="mask-dialog-warn">遮罩只对第 1 张「编辑目标」生效，保存时会把这张图提到第 1 位。</div>`
      }
      <div class="mask-dialog-host" data-ref="maskHost"></div>`;

    let coverage = 0;
    let empty = true;
    let editor = null;

    const modal = openModal({
      title: '遮罩编辑器',
      subtitle: isTarget ? '白色描色区域 = 模型重绘的部分' : '标记区域后可把这张设为编辑目标',
      content,
      size: 'lg',
      dialogClass: 'mask-dialog-modal',
      onClose: () => {
        editor?.destroy();
        editor = null;
      },
      actions: [
        { label: '取消' },
        {
          label: '清除遮罩',
          onClick: () => {
            image.mask = null;
            syncImages();
            if (editor?.image) editor.clear();
            toastSuccess('已清除这张图的遮罩');
            return false;
          },
        },
        {
          label: isTarget ? '保存遮罩' : '设为编辑目标并保存',
          kind: 'primary',
          onClick: () => {
            if (empty) {
              toastWarn('还没有涂抹任何区域');
              return false;
            }
            const mask = editor?.getMask();
            if (!mask?.dataURL) {
              toastWarn('遮罩导出失败，请重试');
              return false;
            }
            image.mask = {
              dataUrl: mask.dataURL,
              width: mask.width,
              height: mask.height,
              coverage,
            };
            if (!isTarget) {
              const [item] = images.splice(images.indexOf(image), 1);
              images.unshift(item);
            }
            edit.localEnabled = true;
            patchSettings({ edit: { localEnabled: true } });
            refs.localEnabled.checked = true;
            syncLocalUi();
            syncImages();
            toastSuccess(`遮罩已保存（覆盖 ${Math.round(coverage * 100)}%），局部编辑已开启`);
            return true;
          },
        },
      ],
    });

    editor = new MaskEditor(content.querySelector('[data-ref="maskHost"]'), {
      onChange: (state) => {
        coverage = state.coverage || 0;
        empty = Boolean(state.empty);
      },
    });
    editor.setPreview({ feather: edit.feather, expand: edit.maskExpand });
    (async () => {
      await editor.setImage(image.dataUrl);
      if (image.mask?.dataUrl) await editor.setMaskDataUrl(image.mask.dataUrl);
      editor.setPreview({ feather: edit.feather, expand: edit.maskExpand });
    })();
    void modal;
  }

  function renderUploadList() {
    refs.uploadCount.textContent = `${images.length} / ${MAX_IMAGES}`;
    refs.uploadList.innerHTML = images
      .map((image, index) => {
        const hasMask = Boolean(image.mask?.dataUrl);
        return `
        <div class="upload-item ${hasMask ? 'has-mask' : ''}" draggable="true" data-image-index="${index}" title="${escapeHtml(image.name)}">
          <img src="${escapeHtml(image.dataUrl)}" alt="${imageLabel(index)}" />
          <span class="upload-badge">${imageLabel(index)}</span>
          ${hasMask ? `<span class="upload-mask-flag">遮罩 ${Math.round((image.mask.coverage || 0) * 100)}%</span>` : ''}
          <button class="upload-del" type="button" data-delete="${index}" title="删除这张">×</button>
          <button class="upload-cut ${hasMask ? 'active' : ''}" type="button" data-mask="${index}" title="绘制遮罩：只重绘标记区域" aria-label="绘制遮罩"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6.5" r="2.6"/><circle cx="6" cy="17.5" r="2.6"/><path d="M8.3 7.9L19 17.2M8.3 16.1L19 6.8"/></svg></button>
          <span class="upload-index">${index === 0 ? 'target' : `image${index + 1}`}</span>
        </div>`;
      })
      .join('');
    if (!images.length) {
      refs.uploadList.innerHTML = '';
      refs.uploadHint.textContent = '第 1 张同时作为遮罩编辑器底图与输出尺寸基准。';
    } else {
      const first = images[0];
      refs.uploadHint.textContent = `第 1 张：${first.width} × ${first.height}（遮罩与输出以它为准）${images.length > 1 ? ` · 共 ${images.length} 张` : ''}`;
    }
    refs.refBox?.classList.toggle('has-refs', images.length > 0);
  }

  async function addFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      toastWarn('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      toastWarn(`最多上传 ${MAX_IMAGES} 张参考图`);
      return;
    }
    if (files.length > remaining) toastWarn(`最多 ${MAX_IMAGES} 张，已忽略 ${files.length - remaining} 张`);
    for (const file of files.slice(0, remaining)) {
      try {
        const dataUrl = await readFileAsDataURL(file);
        const { width, height } = await probeImageSize(dataUrl);
        images.push({
          id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          dataUrl,
          width,
          height,
        });
      } catch (err) {
        toastError(err, `读取 ${file.name} 失败`);
      }
    }
    syncImages();
  }

  function reorderImages(from, to) {
    if (from == null || to == null || from === to || from < 0 || to < 0) return;
    if (from >= images.length || to >= images.length) return;
    const [item] = images.splice(from, 1);
    images.splice(to, 0, item);
    syncImages();
  }

  function syncImages() {
    renderUploadList();
    const first = images[0] || null;
    if (first && Number(edit.width) <= 0) {
      edit.width = snapUp(first.width);
      edit.height = snapUp(first.height);
    }
    renderModeRows();
    updateSizeInfo();
    updateMaskStatus();
    // 指令框里的 @ 引用跟着参考图顺序更新；图库标记「已用」
    promptEditor.syncChips(resolveChipRef);
    refLib.setUsed(images.map((image) => image.libKey).filter(Boolean));
    syncSizeCard();
  }

  refs.dropzone.addEventListener('click', () => refs.fileInput.click());
  refs.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      refs.fileInput.click();
    }
  });
  refs.fileInput.addEventListener('change', async () => {
    await addFiles(refs.fileInput.files);
    refs.fileInput.value = '';
  });
  refs.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    refs.dropzone.classList.add('drag');
  });
  refs.dropzone.addEventListener('dragleave', () => refs.dropzone.classList.remove('drag'));
  refs.dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    refs.dropzone.classList.remove('drag');
    await addFiles(event.dataTransfer?.files);
  });

  refs.uploadList.addEventListener('click', (event) => {
    const cut = event.target.closest('[data-mask]');
    if (cut) {
      event.stopPropagation();
      openMaskDialog(Number(cut.dataset.mask));
      return;
    }
    const button = event.target.closest('[data-delete]');
    if (!button) return;
    event.stopPropagation();
    const index = Number(button.dataset.delete);
    if (Number.isInteger(index)) {
      images.splice(index, 1);
      syncImages();
    }
  });
  refs.uploadList.addEventListener('dragstart', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item) return;
    dragFrom = Number(item.dataset.imageIndex);
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', String(dragFrom));
    } catch {
      // Firefox 需要 setData 才允许拖动
    }
    item.classList.add('dragging');
  });
  refs.uploadList.addEventListener('dragover', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    item.classList.add('drop-target');
  });
  refs.uploadList.addEventListener('dragleave', (event) => {
    const item = event.target.closest('[data-image-index]');
    item?.classList.remove('drop-target');
  });
  refs.uploadList.addEventListener('drop', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item) return;
    event.preventDefault();
    reorderImages(dragFrom, Number(item.dataset.imageIndex));
    dragFrom = null;
  });
  refs.uploadList.addEventListener('dragend', () => {
    dragFrom = null;
    for (const node of refs.uploadList.querySelectorAll('.dragging, .drop-target')) {
      node.classList.remove('dragging', 'drop-target');
    }
  });
  refs.clearImages.addEventListener('click', () => {
    if (!images.length) return;
    images = [];
    syncImages();
    toastSuccess('已清空参考图');
  });

  /* ============================================================
   * 尺寸
   * ============================================================ */
  function ratioList() {
    const ratios = store.state.options?.ratios;
    return Array.isArray(ratios) && ratios.length ? ratios : FALLBACK_RATIOS;
  }

  function renderModeRows() {
    const mode = refs.sizeMode.value;
    const first = images[0] || null;
    if (mode === 'follow') {
      refs.modeRows.innerHTML = `<div class="notice info">输出尺寸 = 第 1 张图尺寸（仅向上对齐 32），遮罩按 1:1 映射，推荐用于零偏移编辑。</div>`;
      return;
    }
    if (mode === 'custom') {
      const width = snapUp(edit.width || first?.width || 1024);
      const height = snapUp(edit.height || first?.height || 1024);
      refs.modeRows.innerHTML = `
        <div class="grid-2">
          <label class="field">
            <span class="field-label">宽度 <span class="tag-hint">32 倍数</span></span>
            <input class="input mono" type="number" min="256" max="4096" step="32" data-ref="customWidth" value="${width}" />
          </label>
          <label class="field">
            <span class="field-label">高度 <span class="tag-hint">32 倍数</span></span>
            <input class="input mono" type="number" min="256" max="4096" step="32" data-ref="customHeight" value="${height}" />
          </label>
        </div>`;
      const widthInput = refs.modeRows.querySelector('[data-ref="customWidth"]');
      const heightInput = refs.modeRows.querySelector('[data-ref="customHeight"]');
      widthInput.addEventListener('change', () => {
        edit.width = snapUp(widthInput.value);
        widthInput.value = String(edit.width);
        patchSettings({ edit: { width: edit.width } });
        updateSizeInfo();
      });
      heightInput.addEventListener('change', () => {
        edit.height = snapUp(heightInput.value);
        heightInput.value = String(edit.height);
        patchSettings({ edit: { height: edit.height } });
        updateSizeInfo();
      });
      return;
    }
    if (mode === 'ratio') {
      const ratios = ratioList();
      const activeRatio = ratios.find((ratio) => ratio.id === edit.ratio) || ratios[0];
      refs.modeRows.innerHTML = `
        <div class="ratio-grid">
          ${ratios
            .map(
              (ratio) => `
              <button class="ratio-btn ${ratio.id === activeRatio.id ? 'active' : ''}" type="button" data-ratio="${escapeHtml(ratio.id)}">
                <span class="ratio-name">${escapeHtml(ratio.label || ratio.id)}</span>
                <span class="ratio-dims">${fmtNum(ratio.w)} × ${fmtNum(ratio.h)}</span>
              </button>`,
            )
            .join('')}
        </div>
        <div class="grid-2" style="margin-top:10px">
          <label class="field">
            <span class="field-label">目标百万像素 <span class="tag-hint">可选</span></span>
            <input class="input mono" type="number" min="0.1" max="16" step="0.1" data-ref="megapixels" placeholder="例如 1.0" value="${edit.megapixels ?? ''}" />
          </label>
          <div class="field">
            <span class="field-label">说明</span>
            <div class="field-hint">留空 = 后端默认 1.0 MP（约 1024² 面积）；填写后按百万像素缩放，宽高仍 32 对齐。上方按钮显示的是官方 2K 参考尺寸。</div>
          </div>
        </div>`;
      refs.modeRows.querySelectorAll('[data-ratio]').forEach((button) => {
        button.addEventListener('click', () => {
          edit.ratio = button.dataset.ratio;
          patchSettings({ edit: { ratio: edit.ratio } });
          renderModeRows();
          updateSizeInfo();
        });
      });
      const megapixels = refs.modeRows.querySelector('[data-ref="megapixels"]');
      megapixels.addEventListener('change', () => {
        edit.megapixels = megapixels.value.trim();
        patchSettings({ edit: { megapixels: edit.megapixels } });
        updateSizeInfo();
      });
      return;
    }
    // fixed_point
    refs.modeRows.innerHTML = `
      <div class="notice info">
        BlueBox 32 不动点：先按目标分辨率对齐到 32 的倍数，缩放回原图时尺寸保持不变（零偏移）；遮罩仍按第 1 张图 1:1 对齐。
      </div>
      <div class="grid-2" style="margin-top:10px">
        <label class="field">
          <span class="field-label">参考百万像素</span>
          <input class="input mono" type="number" min="0.1" max="16" step="0.1" data-ref="fixedMegapixels" value="${edit.megapixels || 1.0}" />
        </label>
        <div class="field">
          <span class="field-label">当前原图</span>
          <div class="field-hint mono">${first ? `${first.width} × ${first.height}` : '上传后确定'}</div>
        </div>
      </div>`;
    const fixedMegapixels = refs.modeRows.querySelector('[data-ref="fixedMegapixels"]');
    fixedMegapixels.addEventListener('change', () => {
      edit.megapixels = fixedMegapixels.value.trim() || '1.0';
      patchSettings({ edit: { megapixels: edit.megapixels } });
      updateSizeInfo();
    });
  }

  function updateSizeInfo() {
    const mode = refs.sizeMode.value;
    const first = images[0] || null;
    if (mode === 'follow') {
      refs.sizeInfo.textContent = first ? `${fmtNum(snapUp(first.width))} × ${fmtNum(snapUp(first.height))}` : '上传后确定';
      refs.canvasHint.textContent = first && (first.width % 32 || first.height % 32)
        ? '原图不是 32 的倍数，画布会向上对齐并裁回'
        : '采样画布向上对齐到 32 的倍数';
      return;
    }
    if (mode === 'custom') {
      refs.sizeInfo.textContent = `${fmtNum(snapUp(edit.width))} × ${fmtNum(snapUp(edit.height))}`;
      refs.canvasHint.textContent = '自定义尺寸会自动对齐到 32 的倍数';
      return;
    }
    if (mode === 'ratio') {
      const ratios = ratioList();
      const ratio = ratios.find((item) => item.id === edit.ratio) || ratios[0];
      refs.sizeInfo.textContent = edit.megapixels
        ? `${ratio.id} @ ${edit.megapixels} MP`
        : `${ratio.id} · 默认 1.0 MP`;
      refs.canvasHint.textContent = '比例规划由后端完成，宽高仍 32 对齐';
      return;
    }
    refs.sizeInfo.textContent = `32 不动点 @ ${edit.megapixels || '1.0'} MP`;
    refs.canvasHint.textContent = '输出会回到第 1 张图尺寸';
  }

  refs.sizeMode.value = edit.sizeMode;
  refs.sizeMode.addEventListener('change', () => {
    edit.sizeMode = refs.sizeMode.value;
    patchSettings({ edit: { sizeMode: edit.sizeMode } });
    renderModeRows();
    updateSizeInfo();
    syncSizeCard();
  });

  /* ------------------------------------------------------------ 尺寸胶囊卡片 */

  function sizePillText() {
    const mode = refs.sizeMode.value;
    const first = images[0] || null;
    if (mode === 'follow') {
      return first ? `跟随原图 · ${fmtNum(snapUp(first.width))}×${fmtNum(snapUp(first.height))}` : '跟随原图';
    }
    if (mode === 'custom') return `自定义 · ${fmtNum(snapUp(edit.width))}×${fmtNum(snapUp(edit.height))}`;
    if (mode === 'ratio') {
      const ratio = ratioList().find((item) => item.id === edit.ratio) || ratioList()[0];
      return `按比例 · ${ratio.id}`;
    }
    return `32 不动点 · ${edit.megapixels || '1.0'} MP`;
  }

  function syncSizeCard() {
    const mode = refs.sizeMode.value;
    const first = images[0] || null;
    refs.sizePillValue.textContent = sizePillText();
    refs.sizePopDims.textContent = refs.sizeInfo.textContent;
    refs.sizeModes.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });

    if (mode === 'custom') {
      refs.sizeBody.innerHTML = `
        <label class="size-custom">
          <span>宽 × 高</span>
          <input class="mono" type="number" min="256" max="4096" step="32" data-card="width" value="${snapUp(edit.width || first?.width || 1024)}" />
          <span>×</span>
          <input class="mono" type="number" min="256" max="4096" step="32" data-card="height" value="${snapUp(edit.height || first?.height || 1024)}" />
        </label>
        <div class="size-pop-note">自动向上对齐到 32 的倍数</div>`;
      refs.sizeBody.querySelectorAll('[data-card]').forEach((input) => {
        input.addEventListener('change', () => {
          edit[input.dataset.card] = snapUp(input.value);
          input.value = String(edit[input.dataset.card]);
          patchSettings({ edit: { [input.dataset.card]: edit[input.dataset.card] } });
          renderModeRows();
          updateSizeInfo();
          syncSizeCard();
        });
      });
      return;
    }

    if (mode === 'ratio') {
      const ratios = ratioList();
      const active = ratios.find((ratio) => ratio.id === edit.ratio) || ratios[0];
      refs.sizeBody.innerHTML = `
        <div class="size-ratio-grid">
          ${ratios
            .map(
              (ratio) => `
            <button class="size-ratio-item ${ratio.id === active.id ? 'active' : ''}" type="button" data-ratio="${escapeHtml(ratio.id)}" title="${escapeHtml(ratio.label || '')} · ${fmtNum(ratio.w)} × ${fmtNum(ratio.h)}">
              <span class="ratio-label">${escapeHtml(ratio.id)}</span>
            </button>`,
            )
            .join('')}
        </div>
        <label class="size-custom">
          <span>百万像素</span>
          <input class="mono" type="number" min="0.1" max="16" step="0.1" placeholder="默认 1.0" data-card="megapixels" value="${edit.megapixels ?? ''}" />
          <span>MP</span>
        </label>`;
      refs.sizeBody.querySelectorAll('[data-ratio]').forEach((button) => {
        button.addEventListener('click', () => {
          edit.ratio = button.dataset.ratio;
          patchSettings({ edit: { ratio: edit.ratio } });
          renderModeRows();
          updateSizeInfo();
          syncSizeCard();
        });
      });
      const mp = refs.sizeBody.querySelector('[data-card="megapixels"]');
      mp.addEventListener('change', () => {
        edit.megapixels = mp.value.trim();
        patchSettings({ edit: { megapixels: edit.megapixels } });
        renderModeRows();
        updateSizeInfo();
        syncSizeCard();
      });
      return;
    }

    if (mode === 'fixed_point') {
      refs.sizeBody.innerHTML = `
        <label class="size-custom">
          <span>参考百万像素</span>
          <input class="mono" type="number" min="0.1" max="16" step="0.1" data-card="megapixels" value="${edit.megapixels || 1.0}" />
          <span>MP</span>
        </label>
        <div class="size-pop-note">先对齐 32 再缩放回原图尺寸（零偏移）${first ? ` · 当前 ${first.width}×${first.height}` : ''}</div>`;
      const mp = refs.sizeBody.querySelector('[data-card="megapixels"]');
      mp.addEventListener('change', () => {
        edit.megapixels = mp.value.trim() || '1.0';
        patchSettings({ edit: { megapixels: edit.megapixels } });
        renderModeRows();
        updateSizeInfo();
        syncSizeCard();
      });
      return;
    }

    refs.sizeBody.innerHTML = `<div class="size-pop-note">输出 = 第 1 张图尺寸（仅向上对齐 32），遮罩 1:1 映射，推荐用于零偏移编辑。</div>`;
  }

  function onSizeDocDown(event) {
    if (refs.sizeAnchor.contains(event.target)) return;
    setSizePopOpen(false);
  }

  function setSizePopOpen(open) {
    refs.sizePop.hidden = !open;
    refs.sizePill.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('pointerdown', onSizeDocDown, true);
    else document.removeEventListener('pointerdown', onSizeDocDown, true);
  }

  refs.sizePill.addEventListener('click', () => setSizePopOpen(refs.sizePop.hidden));
  refs.sizeModes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    refs.sizeMode.value = button.dataset.mode;
    refs.sizeMode.dispatchEvent(new Event('change'));
  });
  updateSizeInfo();
  syncSizeCard();

  refs.fit.value = edit.fit;
  refs.fit.addEventListener('change', () => {
    edit.fit = refs.fit.value;
    patchSettings({ edit: { fit: edit.fit } });
  });
  refs.padMode.value = 'edge';

  /* ============================================================
   * 局部编辑
   * ============================================================ */
  function syncLocalUi() {
    const enabled = refs.localEnabled.checked;
    refs.localOptions.classList.toggle('hidden', !enabled);
    refs.localDisabledNote.classList.toggle('hidden', enabled);
    refs.localPill?.classList.toggle('active', enabled);
    updateMaskStatus();
  }

  refs.localEnabled.checked = Boolean(edit.localEnabled);
  refs.localEnabled.addEventListener('change', () => {
    edit.localEnabled = refs.localEnabled.checked;
    patchSettings({ edit: { localEnabled: edit.localEnabled } });
    syncLocalUi();
  });

  function setScheme(scheme) {
    edit.scheme = scheme;
    refs.schemeA.checked = scheme === 'a';
    refs.schemeB.checked = scheme === 'b';
    for (const pill of refs.localOptions.querySelectorAll('.radio-pill')) {
      const input = pill.querySelector('input');
      pill.classList.toggle('active', input.checked);
    }
    patchSettings({ edit: { scheme } });
  }
  refs.schemeA.addEventListener('change', () => setScheme('a'));
  refs.schemeB.addEventListener('change', () => setScheme('b'));

  function bindRange(input, key, labelEl, format, after) {
    input.value = String(edit[key]);
    if (labelEl) labelEl.textContent = format(edit[key]);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      edit[key] = value;
      if (labelEl) labelEl.textContent = format(value);
      patchSettings({ edit: { [key]: value } });
      after?.(value);
    });
  }

  bindRange(refs.feather, 'feather', refs.featherVal, (v) => `${Math.round(v)} px`);
  // 注意：store 里的字段叫 maskExpand（不是 expand），绑错会让滑杆值变成 undefined → 显示 NaN px
  bindRange(refs.expand, 'maskExpand', refs.expandVal, (v) => `${Math.round(v)} px`);
  bindRange(refs.colorStrength, 'colorStrength', refs.colorStrengthVal, (v) => Number(v).toFixed(2));
  bindRange(refs.contextFactor, 'contextFactor', refs.contextFactorVal, (v) => `${Number(v).toFixed(1)}×`);

  refs.colorMatch.checked = Boolean(edit.colorMatch);
  refs.colorMatch.addEventListener('change', () => {
    edit.colorMatch = refs.colorMatch.checked;
    patchSettings({ edit: { colorMatch: edit.colorMatch } });
  });
  refs.contextPixels.value = String(edit.contextPixels);
  refs.contextPixels.addEventListener('change', () => {
    edit.contextPixels = Math.max(0, Math.round(Number(refs.contextPixels.value) || 0));
    patchSettings({ edit: { contextPixels: edit.contextPixels } });
  });
  refs.blendPixels.value = String(edit.blendPixels);
  refs.blendPixels.addEventListener('change', () => {
    edit.blendPixels = Math.max(0, Math.round(Number(refs.blendPixels.value) || 0));
    patchSettings({ edit: { blendPixels: edit.blendPixels } });
  });

  function updateMaskStatus() {
    const target = images[0];
    const hasMask = Boolean(target?.mask?.dataUrl);
    const percent = Math.round((target?.mask?.coverage || 0) * 100);
    if (!refs.localEnabled.checked) {
      refs.actionHint.textContent = '局部编辑关闭：整图参与编辑';
    } else if (!hasMask) {
      refs.actionHint.textContent = '局部编辑已开启：点参考图上的 ✂ 涂抹要重绘的区域';
    } else {
      refs.actionHint.textContent = `局部编辑已开启：遮罩覆盖 ${percent}%，遮罩外逐像素保留`;
    }
  }

  /* ============================================================
   * 采样参数 / Turbo / 模型
   * ============================================================ */
  function renderSelects() {
    const samplers = Array.isArray(store.state.options?.samplers) && store.state.options.samplers.length
      ? store.state.options.samplers
      : FALLBACK_SAMPLERS;
    const schedulers = Array.isArray(store.state.options?.schedulers) && store.state.options.schedulers.length
      ? store.state.options.schedulers
      : FALLBACK_SCHEDULERS;
    refs.sampler.innerHTML = samplers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    refs.scheduler.innerHTML = schedulers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (samplers.includes(edit.sampler)) refs.sampler.value = edit.sampler;
    if (schedulers.includes(edit.scheduler)) refs.scheduler.value = edit.scheduler;
  }

  refs.steps.value = String(edit.steps);
  refs.cfg.value = String(edit.cfg);
  refs.denoise.value = String(edit.denoise);
  refs.seed.value = edit.seed ?? '';
  refs.steps.addEventListener('change', () => {
    edit.steps = Math.max(1, Math.round(Number(refs.steps.value) || 25));
    refs.steps.value = String(edit.steps);
    patchSettings({ edit: { steps: edit.steps } });
  });
  refs.cfg.addEventListener('change', () => {
    edit.cfg = Math.max(0, Number(refs.cfg.value) || 1);
    refs.cfg.value = String(edit.cfg);
    patchSettings({ edit: { cfg: edit.cfg } });
  });
  refs.denoise.addEventListener('change', () => {
    edit.denoise = Math.min(1, Math.max(0, Number(refs.denoise.value) || 1));
    refs.denoise.value = String(edit.denoise);
    patchSettings({ edit: { denoise: edit.denoise } });
  });
  function setSeedValue(value) {
    refs.seed.value = value == null ? '' : String(value);
    edit.seed = refs.seed.value;
    patchSettings({ edit: { seed: edit.seed } });
  }

  function syncSeedUi() {
    const mode = edit.seedMode === 'fixed' ? 'fixed' : 'random';
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
    edit.seedMode = next;
    patchSettings({ edit: { seedMode: next } });
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
    edit.seed = refs.seed.value.trim();
    patchSettings({ edit: { seed: edit.seed } });
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
  syncSeedUi();
  refs.sampler.addEventListener('change', () => {
    edit.sampler = refs.sampler.value;
    patchSettings({ edit: { sampler: edit.sampler } });
  });
  refs.scheduler.addEventListener('change', () => {
    edit.scheduler = refs.scheduler.value;
    patchSettings({ edit: { scheduler: edit.scheduler } });
  });

  function renderTurbo() {
    const profiles = store.state.options?.turbo_profiles || [];
    turboControl = new TurboControl(refs.turboHost, {
      profiles,
      defaultProfile: store.state.options?.defaults?.turbo_profile || '',
      initial: {
        enabled: Boolean(edit.turbo),
        profile: edit.turboProfile || '',
      },
      onChange: (value) => {
        // 开 Turbo 时记住原来的采样参数，关掉时还原。
        // 不还原的话会一直停在 8 步 / cfg 1 ——那是 Turbo 专用值，普通采样用会糊。
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
        edit.turbo = value.enabled;
        edit.turboProfile = value.profile;
        if (restored) {
          edit.steps = restored.steps;
          edit.cfg = restored.cfg;
          edit.sampler = restored.sampler;
          refs.steps.value = String(restored.steps);
          refs.cfg.value = String(restored.cfg);
          if ([...refs.sampler.options].some((option) => option.value === restored.sampler)) {
            refs.sampler.value = restored.sampler;
          }
          patchSettings({
            edit: {
              turbo: false, turboProfile: value.profile,
              steps: restored.steps, cfg: restored.cfg, sampler: restored.sampler,
            },
          });
          toastSuccess(`已关闭 Turbo，采样参数还原为 ${restored.steps} 步 · CFG ${restored.cfg}`);
        } else {
          patchSettings({ edit: { turbo: value.enabled, turboProfile: value.profile } });
        }
        applyTurboToFields();
      },
    });
    applyTurboToFields(false);
    // 历史遗留：之前 Turbo 关掉后步数停在 8，这里纠正一次（8 步只在 Turbo 下有意义）
    if (!edit.turbo && Number(refs.steps.value) < 12) {
      refs.steps.value = '25';
      edit.steps = 25;
      patchSettings({ edit: { steps: 25 } });
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
        edit.steps = Number(profile.steps);
      }
      if (profile.cfg != null) {
        refs.cfg.value = String(profile.cfg);
        edit.cfg = Number(profile.cfg);
      }
      if (profile.sampler && [...refs.sampler.options].some((option) => option.value === profile.sampler)) {
        refs.sampler.value = profile.sampler;
        edit.sampler = profile.sampler;
      }
      patchSettings({ edit: { steps: edit.steps, cfg: edit.cfg, sampler: edit.sampler } });
    }
    syncTurboPill();
  }

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
    loraPicker = new LoraPicker(refs.loraHost, { loras, initial: edit.loras });
    const sync = () => {
      edit.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ edit: { loras: edit.loras } });
    };
    loraPicker.host.addEventListener('change', sync);
    loraPicker.host.addEventListener('input', sync);
  }

  function renderModels() {
    modelsField = new ModelsField(refs.modelsHost, {
      models: store.state.options?.models || {},
      initial: { unet: edit.unet, clip: edit.clip, vae: edit.vae },
    });
    refs.modelsHost.addEventListener('change', () => {
      const value = modelsField.getValue();
      edit.unet = value.unet || '';
      edit.clip = value.clip || '';
      edit.vae = value.vae || '';
      patchSettings({ edit: { unet: edit.unet, clip: edit.clip, vae: edit.vae } });
    });
    // Turbo 的「自动切底模」预设需要模型下拉已就绪后才能套用
    applyTurboToFields(false);
  }

  function renderConsistency() {
    const loras = (store.state.options?.models?.lora || []).map((item) =>
      typeof item === 'string' ? { value: item, label: item } : { value: item.value ?? item.name, label: item.label || item.value || item.name },
    );
    const current = edit.consistencyLora || '';
    refs.consistencyLora.innerHTML = loras.length
      ? loras
          .map(
            (lora) =>
              `<option value="${escapeHtml(lora.value)}" ${lora.value === current ? 'selected' : ''}>${escapeHtml(lora.label)}</option>`,
          )
          .join('')
      : '<option value="">后端未返回 LoRA 列表</option>';
    if (current && loras.some((lora) => lora.value === current)) refs.consistencyLora.value = current;
    else if (loras.length) {
      edit.consistencyLora = refs.consistencyLora.value;
      patchSettings({ edit: { consistencyLora: edit.consistencyLora } });
    }
    refs.consistencyEnabled.checked = Boolean(edit.consistencyEnabled);
    refs.consistencyStrength.value = String(edit.consistencyStrength);
    refs.consistencyStrengthVal.textContent = Number(edit.consistencyStrength).toFixed(2);
    refs.consistencyRows.classList.toggle('hidden', !refs.consistencyEnabled.checked);
  }

  refs.consistencyEnabled.addEventListener('change', () => {
    edit.consistencyEnabled = refs.consistencyEnabled.checked;
    patchSettings({ edit: { consistencyEnabled: edit.consistencyEnabled } });
    refs.consistencyRows.classList.toggle('hidden', !edit.consistencyEnabled);
  });
  refs.consistencyLora.addEventListener('change', () => {
    edit.consistencyLora = refs.consistencyLora.value;
    patchSettings({ edit: { consistencyLora: edit.consistencyLora } });
  });
  refs.consistencyStrength.addEventListener('input', () => {
    edit.consistencyStrength = Number(refs.consistencyStrength.value);
    refs.consistencyStrengthVal.textContent = edit.consistencyStrength.toFixed(2);
    patchSettings({ edit: { consistencyStrength: edit.consistencyStrength } });
  });

  /* ============================================================
   * 启动 / 刷新
   * ============================================================ */
  function refreshAll() {
    renderModeRows();
    updateSizeInfo();
    renderSelects();
    renderTurbo();
    renderLoras();
    renderModels();
    renderConsistency();
    updateMaskStatus();
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

  setScheme(edit.scheme === 'b' ? 'b' : 'a');
  refs.localEnabled.checked = Boolean(edit.localEnabled);
  syncLocalUi();
  renderSelects();
  renderTurbo();
  renderLoras();
  renderModels();
  renderConsistency();
  renderModeRows();
  updateSizeInfo();
  renderHealthHint();
  store.subscribe(() => renderHealthHint());
  on('options:loaded', () => refreshAll());

  /* ============================================================
   * 提交
   * ============================================================ */
  function collectPayload(precomputedMask = null) {
    const mode = refs.sizeMode.value;
    const first = images[0];
    const localEnabled = refs.localEnabled.checked;
    const targetMask = localEnabled ? images[0]?.mask : null;
    const mask = precomputedMask || (targetMask?.dataUrl
      ? {
          dataURL: targetMask.dataUrl,
          empty: false,
          width: targetMask.width || first?.width,
          height: targetMask.height || first?.height,
        }
      : { dataURL: null, empty: true });
    const turboValue = turboControl.getValue();
    const models = modelsField.getValue();
    const seedMode = edit.seedMode === 'fixed' ? 'fixed' : 'random';
    const seedText = refs.seed.value.trim();
    const seed = seedMode === 'random' ? null : Math.max(0, Math.floor(Number(seedText) || 0));
    const megapixels = Number(edit.megapixels);
    const consistencyOn = refs.consistencyEnabled.checked && Boolean(refs.consistencyLora.value);
    const pickerMeta = stylePicker.getMeta();
    // 指令框里的 @ 引用按参考图顺序映射成 <imageN>，与后端多图 token 对齐
    const promptText = promptEditor.getSemantic().trim();

    return {
      // 指令正文保持原文，风格/滤镜/视角在这里合成
      prompt: stylePicker.composePrompt(promptText),
      negative_prompt: refs.negative.value.trim(),
      images: images.map((image) => ({ name: image.name, data: image.dataUrl })),
      size_mode: mode,
      width: mode === 'custom' ? snapUp(edit.width) : null,
      height: mode === 'custom' ? snapUp(edit.height) : null,
      ratio: mode === 'ratio' ? edit.ratio || (ratioList()[0]?.id ?? '1:1') : null,
      megapixels: Number.isFinite(megapixels) && megapixels > 0 ? megapixels : null,
      fit: refs.fit.value || 'pad',
      pad_mode: 'edge',
      mask: mask.dataURL ? { data: mask.dataURL } : null,
      local: {
        enabled: localEnabled,
        scheme: refs.schemeB.checked ? 'b' : 'a',
        feather: Math.round(Number(edit.feather) || 0),
        color_match: refs.colorMatch.checked,
        color_strength: Number(edit.colorStrength),
        mask_expand: Math.round(Number(edit.maskExpand) || 0),
        context_factor: Number(edit.contextFactor),
        context_pixels: Math.round(Number(edit.contextPixels) || 0),
        blend_pixels: Math.round(Number(edit.blendPixels) || 0),
      },
      resolution: 0,
      steps: Number(refs.steps.value) || 25,
      cfg: Number(refs.cfg.value) || 4,
      seed: Number.isFinite(seed) ? seed : null,
      denoise: Number(refs.denoise.value) || 1,
      sampler: refs.sampler.value || 'euler',
      scheduler: refs.scheduler.value || 'simple',
      turbo: {
        enabled: turboValue.enabled,
        profile: turboValue.profile,
      },
      models: { unet: models.unet || '', clip: models.clip || '', vae: models.vae || '' },
      loras: loraPicker.getValue(),
      consistency_lora: consistencyOn
        ? { name: refs.consistencyLora.value, strength: Number(refs.consistencyStrength.value) }
        : null,
      // 姿态图作为 image1：后端会把指令里的 <imageN> 顺延为 <image(N+1)>
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
        source: 'web/edit',
        targetSize: first ? { width: first.width, height: first.height } : null,
        maskSize: mask.dataURL ? { width: mask.width, height: mask.height } : null,
        rawPrompt: promptText,
        // 给后端的语义映射：<image1> = 编辑目标，<image2>… = 参考图
        referenceMap: images.map((image, index) => ({
          marker: `<image${index + 1}>`,
          role: index === 0 ? '编辑目标' : '参考图',
          name: image.name,
          fromLibrary: Boolean(image.libKey),
        })),
        creativePresets: pickerMeta.creativePresets,
        imageAngle: pickerMeta.imageAngle,
        pose: poseState ? { preset: poseState.preset, summary: poseState.summary } : null,
        client: 'qwen-image2.1-web',
      },
      // 仅供结果面板显示遮罩叠加，不发送
      __maskOverlay: mask.dataURL || null,
    };
  }

  const DEFAULT_ACTION_HINT = '第 1 张图会被完整读取，输出尺寸遵循所选模式';

  /** 把任务进度同步到底部操作条：条永远可见，不用滚到结果面板看进度。 */
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

  async function handleSubmit() {
    syncActionProgress(null);
    if (refs.submit.disabled) return;
    if (!images.length) {
      toastWarn('请先上传至少 1 张参考图（第 1 张是编辑目标）');
      return;
    }
    if (promptEditor.isEmpty()) {
      toastWarn('请先填写编辑指令');
      promptEditor.focus();
      return;
    }
    let maskResult = null;
    if (refs.localEnabled.checked) {
      const target = images[0];
      if (!target?.mask?.dataUrl) {
        toastWarn('局部编辑已开启，但还没有遮罩：点参考图上的 ✂ 涂抹要重绘的区域');
        return;
      }
      maskResult = {
        dataURL: target.mask.dataUrl,
        empty: false,
        width: target.mask.width,
        height: target.mask.height,
      };
    }
    refs.submit.disabled = true;
    refs.submit.innerHTML = '<span class="spin"></span>编辑中…';
    try {
      // 等 vendor 模块就绪，确保风格预设能合成进编辑指令
      await stylePicker.ensureVendor();
      if (stylePicker.hasSelection() && !stylePicker.isReady()) {
        toastWarn('风格模块未就绪：本次将只使用原始编辑指令（可稍后重试）');
      }
      const payload = collectPayload(maskResult);
      const maskOverlay = payload.__maskOverlay;
      delete payload.__maskOverlay;
      refs.resultState.textContent = '任务进行中';
      await jobRunner.start({
        create: () => api.edit(payload),
        prompt: payload.prompt,
        favoriteMeta: {
          kind: 'edit',
          category: '未分类',
          referenceImages: images.slice(0, 3).map((image) => image.dataUrl),
          params: {
            width: payload.width,
            height: payload.height,
            size_mode: payload.size_mode,
            steps: payload.steps,
            cfg: payload.cfg,
            denoise: payload.denoise,
            sampler: payload.sampler,
            scheduler: payload.scheduler,
          },
        },
        maskDataUrl: payload.local.enabled ? maskOverlay : null,
        onProgress: syncActionProgress,
        onDone: (job) => {
          refs.resultState.textContent = '已完成';
          const seed = job?.params?.seed;
          if (seed != null) {
            lastSeed = seed;
            // 随机模式下把本次实际种子回填到输入框，方便复用
            if (edit.seedMode !== 'fixed') setSeedValue(String(seed));
            syncSeedUi();
          }
          refreshHealthSoon();
        },
      });
    } finally {
      refs.submit.disabled = false;
      refs.submit.textContent = '开始编辑';
    }
  }

  refs.submit.addEventListener('click', handleSubmit);
  // Ctrl/Cmd + Enter 直接开始编辑
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
    }
  });
  refs.reset.addEventListener('click', () => {
    const defaults = {
      steps: 25,
      cfg: 4.0,
      denoise: 1.0,
      seed: '',
      seedMode: 'random',
      sampler: 'euler',
      scheduler: 'simple',
      turbo: false,
    };
    Object.assign(edit, defaults);
    patchSettings({ edit: defaults });
    refs.seed.value = '';
    syncSeedUi();
    renderSelects();
    renderTurbo();
    toastSuccess('采样参数已重置');
  });

  function refreshHealthSoon() {
    setTimeout(() => {
      api.health()
        .then((health) => store.patchRuntime({ health }))
        .catch(() => {});
    }, 800);
  }

  /* ============================================================
   * 扩图入口（与「图像处理」页共用同一套规划逻辑）
   * ============================================================ */
  function openOutpaintDialog() {
    const first = images[0];
    if (!first) {
      toastWarn('请先上传第 1 张编辑目标图，再使用扩图');
      return;
    }
    const content = document.createElement('div');
    content.className = 'outpaint-dialog';
    content.innerHTML = `
      <div class="field">
        <span class="field-label">扩图方向</span>
        <div class="chips" data-ref="dirs">
          ${OUTPAINT_DIRECTIONS.map(
            (direction) =>
              `<button class="chip ${direction === 'right' ? 'active' : ''}" type="button" data-dir="${direction}">${escapeHtml(
                OUTPAINT_DIRECTION_LABELS[direction],
              )}</button>`,
          ).join('')}
        </div>
      </div>
      <div class="field">
        <span class="field-label">扩展幅度 <span class="tag-hint" data-ref="amountVal">50%</span></span>
        <input class="range" type="range" min="10" max="200" step="5" value="50" data-ref="amount" />
        <div class="field-hint">相对原图对应边长；四周方向会向四边同时扩展。</div>
      </div>
      <div class="notice info">点击「生成画布」后：第 1 张图会被贴到新画布上，自动生成「新增区域」白色遮罩并预填扩图提示词；原图内容保持不变。</div>
      <div class="outpaint-actions">
        <button class="btn ghost" type="button" data-ref="cancel">取消</button>
        <button class="btn primary" type="button" data-ref="apply">生成画布</button>
      </div>`;
    let direction = 'right';
    let amount = 0.5;
    let busy = false;
    const modal = openModal({
      title: '扩图',
      subtitle: '规划新画布 → 生成新增区域遮罩 → 进入局部重绘',
      dialogClass: 'outpaint-modal',
      hideFooter: true,
      content,
    });
    const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
    const amountEl = ref('amount');
    const amountVal = ref('amountVal');
    ref('dirs')
      .querySelectorAll('[data-dir]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          direction = button.dataset.dir;
          for (const chip of ref('dirs').querySelectorAll('[data-dir]')) {
            chip.classList.toggle('active', chip === button);
          }
        });
      });
    amountEl.addEventListener('input', () => {
      amount = Number(amountEl.value) / 100;
      amountVal.textContent = `${Math.round(amount * 100)}%`;
    });
    ref('cancel').addEventListener('click', () => modal.close());
    ref('apply').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      const button = ref('apply');
      button.disabled = true;
      button.innerHTML = '<span class="spin"></span>规划中…';
      try {
        modal.close();
        const result = await planOutpaint({
          srcDataUrl: first.dataUrl,
          width: first.width,
          height: first.height,
          direction,
          amount,
        });
        const { width, height } = await probeImageSize(result.dataUrl);
        images[0] = {
          ...first,
          id: `img-${Date.now().toString(36)}`,
          name: `${first.name.replace(/\.[^.]+$/, '') || 'image'}-outpaint.png`,
          dataUrl: result.dataUrl,
          width,
          height,
          mask: result.maskDataUrl
            ? { dataUrl: result.maskDataUrl, width, height, coverage: 0 }
            : null,
        };
        renderUploadList();
        renderModeRows();
        updateSizeInfo();
        promptEditor.setText(result.prompt);
        edit.prompt = result.prompt;
        patchSettings({ edit: { prompt: result.prompt, localEnabled: true } });
        updatePromptCount();
        edit.localEnabled = true;
        refs.localEnabled.checked = true;
        syncLocalUi();
        updateMaskStatus();
        toastSuccess(
          `扩图已准备：新画布 ${width} × ${height}，${result.maskDataUrl ? '已生成新增区域遮罩，可点 ✂ 微调' : '遮罩生成失败，请点 ✂ 手动涂抹'}`,
        );
      } catch (err) {
        toastError(err, '扩图规划失败');
      } finally {
        busy = false;
      }
    });
  }

  refs.outpaintBtn.addEventListener('click', openOutpaintDialog);

  /* ============================================================
   * 接收「图像处理」页的交接（送入图生图 / 扩图去局部重绘）
   * ============================================================ */
  async function applyHandoff() {
    const payload = consumeHandoff();
    if (!payload) return;
    try {
      const nextImages = [];
      for (const item of payload.images) {
        if (!item?.dataUrl) continue;
        try {
          const { width, height } = await probeImageSize(item.dataUrl);
          nextImages.push({
            id: `img-${Date.now().toString(36)}-${nextImages.length}`,
            name: item.name || `image-${nextImages.length + 1}.png`,
            dataUrl: item.dataUrl,
            width,
            height,
          });
        } catch (err) {
          console.warn('[edit] 交接图片读取失败', err);
        }
      }
      if (!nextImages.length) {
        toastWarn('图像处理页交接过来的图片无法读取');
        return;
      }
      images = nextImages;
      if (payload.mask && images[0]) {
        images[0].mask = {
          dataUrl: payload.mask,
          width: images[0].width,
          height: images[0].height,
          coverage: 0,
        };
      }
      renderUploadList();
      promptEditor.syncChips(resolveChipRef);
      refLib.setUsed(images.map((image) => image.libKey).filter(Boolean));
      renderModeRows();
      updateSizeInfo();
      if (payload.prompt != null) {
        promptEditor.setText(payload.prompt);
        edit.prompt = payload.prompt;
        patchSettings({ edit: { prompt: payload.prompt } });
        updatePromptCount();
      }
      if (payload.localEnabled != null) {
        edit.localEnabled = Boolean(payload.localEnabled);
        refs.localEnabled.checked = edit.localEnabled;
        patchSettings({ edit: { localEnabled: edit.localEnabled } });
        syncLocalUi();
      }
      updateMaskStatus();
      toastSuccess(payload.toast || '已接收图像处理结果');
    } catch (err) {
      toastError(err, '接收图像处理结果失败');
    }
  }

  return {
    onShow() {
      renderHealthHint();
      updateMaskStatus();
      applyHandoff();
    },
  };
}
