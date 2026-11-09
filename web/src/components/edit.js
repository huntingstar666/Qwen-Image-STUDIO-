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
import { LoraPicker, ModelsSummary, TurboControl } from './controls.js';
import { openModal } from './modal.js';
import { openPoseStudio } from './poseStudio.js';
import { openCompareDialog } from './compare.js';
import { consumeHandoff } from '../handoff.js';
import { OUTPAINT_DIRECTIONS, OUTPAINT_DIRECTION_LABELS, planOutpaint } from '../outpaint.js';
import { escapeHtml, fmtCoverage, fmtNum, loadImage, readFileAsDataURL, probeImageSize, snapUp } from '../utils.js';
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
} from './studio/presets.js';
import { nestOverrides, pickConsistencyLora } from './studio/payload.js';
import { chainConfigOf, imageUrlToDataUrl, meanDeltaE } from './studio/chain.js';
import { mountGuards } from './studio/guards.js';
import { mountAdvanced } from './studio/advanced.js';
import { mountOutpaintPanel } from './studio/outpaintPanel.js';
import { mountPanoramaPanel } from './studio/panoramaPanel.js';

const MAX_IMAGES = 10;

//: 去水印模板：点名文字 + 徽章 + 编号，避免模型只清掉文字水印（测试 11a~11d）。
const WATERMARK_TEMPLATE = '移除画面中的水印，包括斜向平铺文字、角标徽章/logo、编号/日期等所有叠加元素，保持底层画面与主体不变。';

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
  // 连续编辑会话：起点原图 / 已接力轮次 / 累计漂移（chain 预设专用）
  let chainSession = { config: null, round: 0, drift: 0, original: null, lastDataUrl: '' };
  let turboControl = null;
  let loraPicker = null;
  let loraHostBound = false;
  let turboSnapshot = null; // 开 Turbo 前的 steps/cfg/sampler，关掉时还原

  let dragFrom = null;
  let lastSeed = null;
  let presetList = [];
  let presetVersion = 1;

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
            <div class="panel-title">本次保护 <span class="panel-sub">零偏移 / 色彩</span></div>
          </div>
          <div class="panel-body">
            <div data-ref="guardsHost"></div>
            <div class="ai-guard-note" data-ref="guardNote" hidden></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">高级参数 <span class="panel-sub">孤海几何 / 接缝 / 预处理</span></div>
          </div>
          <div class="panel-body" data-ref="advancedHost"></div>
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
                <span class="field-label">强度 <span class="tag-hint" data-ref="consistencyStrengthVal">0.48</span></span>
                <input class="range" type="range" min="0" max="2" step="0.01" data-ref="consistencyStrength" />
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
              <button class="refbox-link" type="button" data-ref="outpaintBtn" title="按四边百分比直接扩图（灰边延展），内可切换旧流程">⤢ 扩图</button>
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
            <div class="notice info" data-ref="chainBar" hidden></div>
            <div class="wb-prompt-wrap">
              <div data-ref="stylePicker"></div>
              <div class="wb-prompt" data-ref="prompt" spellcheck="false"
                data-placeholder="描述如何修改画面，例如：把人物外套换成红色羽绒服，保持脸部光影与背景不变。输入 @ 可引用小图库里的参考图。"></div>
              <div class="wb-prompt-foot">
                <span class="wb-char" data-ref="promptCount">0 字</span>
                <input class="wb-negative" data-ref="negative" placeholder="负向提示词（可选）：文字、水印、变形、重复人物" />
                <button class="wb-link" type="button" data-ref="atRef" title="引用小图库里的参考图">＠ 参考图</button>
                <button class="wb-link" type="button" data-ref="watermarkPrompt" title="一键写入去水印模板（文字 + 徽章 + 编号）">去水印模板</button>
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
              <div class="wb-preset-anchor" data-ref="presetAnchor">
                <button class="wb-pill wb-preset-pill" type="button" data-ref="presetPill" aria-expanded="false" title="任务预设">
                  <span class="wb-pill-key">预设</span>
                  <span class="wb-preset-value" data-ref="presetPillValue">局部编辑</span>
                  <span class="wb-caret">▼</span>
                </button>
                <div class="wb-preset-pop" data-ref="presetPop" hidden>
                  <div class="wb-preset-pop-head">
                    <span>任务预设</span>
                    <span class="mono" data-ref="presetNote"></span>
                  </div>
                  <div class="ai-presets edit-presets" data-ref="presetCards"></div>
                  <label class="ai-field">
                    <span>任务</span>
                    <select class="select" data-ref="taskMode">
                      <option value="auto">跟随预设</option>
                      <option value="edit">通用编辑</option>
                      <option value="inpaint">局部重绘</option>
                      <option value="remove">元素移除</option>
                      <option value="outpaint">扩图</option>
                      <option value="panorama">全景</option>
                    </select>
                  </label>
                  <div class="ai-hint" data-ref="taskNote"></div>
                  <div data-ref="panoramaHost" hidden></div>
                  <div class="ai-hint" data-ref="presetHint"></div>
                  <div class="ai-custom-pick" data-ref="customPickHost"></div>
                </div>
              </div>
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
    watermarkPrompt: ref('watermarkPrompt'),
    clearPrompt: ref('clearPrompt'),
    libHost: ref('libHost'),
    refBox: ref('refBox'),
    composer: ref('composer'),
    chainBar: ref('chainBar'),
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
    presetAnchor: ref('presetAnchor'),
    presetPill: ref('presetPill'),
    presetPillValue: ref('presetPillValue'),
    presetPop: ref('presetPop'),
    sizeModes: ref('sizeModes'),
    sizeBody: ref('sizeBody'),
    modeRows: ref('modeRows'),
    fit: ref('fit'),
    padMode: ref('padMode'),
    sizeInfo: ref('sizeInfo'),
    canvasHint: ref('canvasHint'),
    presetCards: ref('presetCards'),
    presetNote: ref('presetNote'),
    presetHint: ref('presetHint'),
    customPickHost: ref('customPickHost'),
    taskMode: ref('taskMode'),
    taskNote: ref('taskNote'),
    panoramaHost: ref('panoramaHost'),
    guardsHost: ref('guardsHost'),
    guardNote: ref('guardNote'),
    advancedHost: ref('advancedHost'),
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
      initial: {
        // 3D 编辑器：把上次的姿势原样带回去，接着改
        pose3d: poseState?.pose3d || '',
        strength: poseState?.strength,
        useLora: poseState?.useLora,
        // 当前编辑目标顺手放进编辑器右栏，摆姿时能对着人物参考
        referencePreview: images[0]?.dataUrl || null,
      },
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
  refs.watermarkPrompt.addEventListener('click', () => {
    const current = promptEditor.getSemantic().trim();
    const next = current.includes('水印') ? current : (current ? `${current}；${WATERMARK_TEMPLATE}` : WATERMARK_TEMPLATE);
    promptEditor.setText(next);
    edit.prompt = next;
    patchSettings({ edit: { prompt: next } });
    updatePromptCount();
    promptEditor.focus();
  });
  refs.polish.addEventListener('click', async () => {
    await polishWithDialog({
      // 润色同样走 <imageN> 语义映射，LLM 才能分清「编辑目标」和「参考图」
      prompt: promptEditor.getSemantic(),
      mode: 'edit',
      // 图像编辑目前只有 qwen 支持（服务端会拒绝其它档案），显式传 PE 档案避免默认歧义。
      imageModel: 'qwen',
      model: store.state.polishModel || null,
      styleHint: stylePicker.styleHint(),
      button: refs.polish,
      targetSize: images[0] ? { width: images[0].width, height: images[0].height } : null,
      pose: poseState
        ? { image: poseState.dataUrl, summary: poseState.summary, label: poseState.label }
        : null,
      // 参考图本体：润色模型看到图才能把「做 <image2> 的动作」展开成可执行描述，
      // 否则只能闭着眼睛改措辞（实测 1 张 vs 2 张差的正是这一步）。
      images: images.map((image) => ({ data: image.dataUrl, name: image.name })),
      // 清单走文字：让模型知道第几张是编辑目标、各自的尺寸
      references: images.map((image, index) => ({
        name: `image${index + 1}`,
        description: `${index === 0 ? '编辑目标（要保留的主体）' : '参考图'}${
          image.name ? `：${image.name}` : ''
        }`,
        size: image.width && image.height ? [image.width, image.height] : undefined,
      })),
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
    makeThumbnail(entry.dataUrl).then((url) => {
      if (url === entry.dataUrl || !images.includes(entry)) return;
      entry.previewUrl = url;
      renderUploadList();
    });
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
      subtitle: isTarget
        ? '绿色实色 = 模型重绘区域；浅绿光晕 = 接缝羽化/外扩；虚线框 = 遮罩包围盒'
        : '标记区域后可把这张设为编辑目标',
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
            syncImages();
            toastSuccess(`遮罩已保存（覆盖 ${fmtCoverage(coverage)}），提交时按局部重绘执行`);
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

  /**
   * 列表缩略图：长边缩到 160px 的 JPEG。
   * 直接把原图 data URL 塞进 <img> 会让浏览器按原分辨率解码，多张大图时滚动/重排明显卡顿；
   * 提交给后端的仍是原始 dataUrl，不影响画质。
   */
  async function makeThumbnail(dataUrl, maxSide = 160) {
    try {
      const img = await loadImage(dataUrl);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      if (scale >= 1) return dataUrl;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      // JPEG 没有透明通道：先铺白底，否则带 alpha 的 PNG 缩略图会变黑
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      return dataUrl;
    }
  }

  /**
   * 估算遮罩 PNG 的覆盖率（alpha 优先、否则取亮度，与后端 decode_mask 一致）。
   * 扩图规划 / 图像处理页交接带进来的遮罩没有覆盖率字段，回显不能直接写 0%。
   */
  async function probeMaskCoverage(dataUrl) {
    try {
      const img = await loadImage(dataUrl);
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!width || !height) return 0;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      let alphaVaries = false;
      for (let i = 3; i < data.length; i += 4 * 7) {
        if (data[i] !== 255 && data[i] !== 0) {
          alphaVaries = true;
          break;
        }
      }
      let hit = 0;
      let total = 0;
      for (let i = 0; i < data.length; i += 4 * 2) {
        total += 1;
        const value = alphaVaries
          ? data[i + 3]
          : Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        if (value > 8) hit += 1;
      }
      return total ? hit / total : 0;
    } catch (err) {
      console.warn('[edit] 遮罩覆盖率估算失败', err);
      return 0;
    }
  }

  function renderUploadList() {
    refs.uploadCount.textContent = `${images.length} / ${MAX_IMAGES}`;
    refs.uploadList.innerHTML = images
      .map((image, index) => {
        const hasMask = Boolean(image.mask?.dataUrl);
        return `
        <div class="upload-item ${hasMask ? 'has-mask' : ''}" draggable="true" data-image-index="${index}" title="${escapeHtml(image.name)}">
          <img src="${escapeHtml(image.previewUrl || image.dataUrl)}" alt="${imageLabel(index)}" loading="lazy" />
          <span class="upload-badge">${imageLabel(index)}</span>
          ${hasMask ? `<span class="upload-mask-flag">遮罩 ${fmtCoverage(image.mask.coverage || 0)}</span>` : ''}
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
    // 已有参考图时把拖放区改成窄条「添加更多」，满了直接隐藏
    const dropTitle = refs.dropzone.querySelector('.wb-drop-text b');
    if (dropTitle) dropTitle.textContent = images.length ? '添加更多参考图' : '拖拽图片到这里';
    const dropDesc = refs.dropzone.querySelector('.wb-drop-text small');
    if (dropDesc) {
      dropDesc.textContent = images.length
        ? '点击上传，或从左侧小图库拖进来'
        : '或点击上传 · 第 1 张为「编辑目标」';
    }
    refs.dropzone.hidden = images.length >= MAX_IMAGES;
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
          previewUrl: await makeThumbnail(dataUrl),
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

  /* 整个参考图区域都是拖放目标：小图库 / 历史胶囊拖进来的图，或本机文件。 */
  refs.refBox.addEventListener('dragover', (event) => {
    if (!hasRefDrag(event) && !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    refs.refBox.classList.add('ref-drop-active');
  });
  refs.refBox.addEventListener('dragleave', (event) => {
    if (refs.refBox.contains(event.relatedTarget)) return;
    refs.refBox.classList.remove('ref-drop-active');
    refs.dropzone.classList.remove('drag');
  });
  refs.refBox.addEventListener('drop', async (event) => {
    event.preventDefault();
    refs.refBox.classList.remove('ref-drop-active');
    refs.dropzone.classList.remove('drag');
    const payload = readRefDrag(event);
    if (payload?.src) {
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
      if (item) useLibraryItem(item);
      return;
    }
    if (event.dataTransfer?.files?.length) await addFiles(event.dataTransfer.files);
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
    // 外部拖入（小图库 / 文件）交给参考图区域处理，只在本区域内排序时才高亮
    if (hasRefDrag(event) || dragFrom === null) return;
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
    if (hasRefDrag(event) || dragFrom === null) return;
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

  let panoramaPanel = null;

  function updateSizeInfo() {
    const mode = refs.sizeMode.value;
    const first = images[0] || null;
    panoramaPanel?.refresh();
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

  /** 任务预设浮层（从底部参数条的「预设」圆钮弹出，向上展开）。 */
  function onPresetDocDown(event) {
    if (refs.presetAnchor.contains(event.target)) return;
    setPresetPopOpen(false);
  }

  function setPresetPopOpen(open) {
    refs.presetPop.hidden = !open;
    refs.presetPill.setAttribute('aria-expanded', String(open));
    refs.presetAnchor.classList.toggle('open', open);
    if (open) {
      // 圆钮靠近右侧，浮层默认向右展开会顶出视口：按可视宽度把左边界夹回来。
      const rect = refs.presetPill.getBoundingClientRect();
      const width = Math.min(520, window.innerWidth - 46);
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      refs.presetPop.style.left = `${Math.round(left - rect.left)}px`;
      document.addEventListener('pointerdown', onPresetDocDown, true);
    } else {
      document.removeEventListener('pointerdown', onPresetDocDown, true);
    }
  }

  refs.presetPill.addEventListener('click', () => setPresetPopOpen(refs.presetPop.hidden));
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
   * 任务预设 / 本次保护 / 高级参数（与图片精修共用同一套数据源）
   * ============================================================ */
  /**
   * 是否提交遮罩：唯一依据是「编辑目标上有没有画遮罩」。
   * 不再单独放"局部编辑"开关——有遮罩就局部重绘，没遮罩就整图编辑，
   * 避免开关、预设、任务三处各说一套。
   */
  function hasTargetMask() {
    return Boolean(images[0]?.mask?.dataUrl);
  }

  function localHasMask() {
    return hasTargetMask();
  }

  function currentPresetId() {
    const wanted = String(edit.preset || defaultPresetId(presetList) || 'mask_edit');
    // 还没上传图片时不降级：此时"没有蒙版"不代表用户要整图重绘。
    if (!images.length) return { id: wanted, degraded: false, from: '' };
    return resolvePresetForMask(wanted, localHasMask());
  }

  function currentPreset() {
    return findPreset(presetList, currentPresetId().id);
  }

  function presetValue(key, fallback) {
    return effectiveValue(currentPreset(), edit.overrides || {}, key, fallback);
  }

  const guards = mountGuards(refs.guardsHost, {
    // 开关显示值由预设生效值推导（唯一事实源），改动写回 overrides
    value: protectionOf(currentPreset(), edit.overrides || {}),
    onChange(next) {
      edit.overrides = applyProtection(currentPreset(), edit.overrides || {}, next);
      patchSettings({ edit: { overrides: edit.overrides } });
      advanced.refresh();
      renderPresets();
      syncGuardNote();
    },
  });

  const advanced = mountAdvanced(refs.advancedHost, {
    getPreset: currentPreset,
    getOverrides: () => edit.overrides || {},
    // 扩图四边与最大长边在参考图条的「⤢ 扩图」弹窗里设置，高级参数不再重复一份。
    omit: [
      'outpaint.top',
      'outpaint.bottom',
      'outpaint.left',
      'outpaint.right',
      'outpaint.max_side',
    ],
    apply(next) {
      edit.overrides = next;
      patchSettings({ edit: { overrides: next } });
      syncLocalControls();
      guards.sync(protectionOf(currentPreset(), edit.overrides || {}));
      renderPresets();
      syncGuardNote();
    },
    onChange() {
      renderPresets();
    },
  });

  panoramaPanel = mountPanoramaPanel(refs.panoramaHost, {
    getSize: () => {
      const image = images[0];
      return image ? { width: image.width, height: image.height } : null;
    },
  });
  panoramaPanel.init().catch(() => {});

  function activeTaskMode() {
    const preset = currentPreset();
    const fallback = preset ? presetTaskMode(preset) : 'edit';
    const explicit = String(edit.taskMode || 'auto');
    return explicit === 'auto' ? fallback : explicit;
  }

  const TASK_NOTES = {
    remove: '元素移除：提交时强制 fills=true + 绿色提示图，并自动补「移除图像中的绿色区域」；遮罩外逐字节保留。',
    outpaint: '扩图：用「⤢ 扩图」的四边百分比外补，提交时强制 fills=false + 灰色提示。',
    panorama: '全景：按目标比例做最小外扩，整画布采样；源图保持原尺寸或等比缩小，向外补画布。',
    inpaint: '局部重绘：只重绘蒙版内，其余逐像素保留。',
  };

  function renderTaskMode() {
    refs.taskMode.value = String(edit.taskMode || 'auto');
    const note = TASK_NOTES[activeTaskMode()] || '';
    refs.taskNote.textContent = note;
    refs.taskNote.hidden = !note;
    const isPanorama = activeTaskMode() === 'panorama';
    refs.panoramaHost.hidden = !isPanorama;
    if (isPanorama) panoramaPanel?.refresh();
  }

  refs.taskMode.addEventListener('change', () => {
    edit.taskMode = refs.taskMode.value;
    // 移除 / 扩图 / 全景有专属提示图约定，显式选任务时同步到对应预设
    if (['remove', 'outpaint', 'panorama'].includes(edit.taskMode)) {
      const hit = findPreset(presetList, edit.taskMode);
      if (hit) {
        // 等价于选中该预设：套用全局默认，任务下拉回到「跟随预设」。
        choosePreset(hit);
        return;
      }
    }
    patchSettings({
      edit: { taskMode: edit.taskMode, preset: edit.preset, overrides: edit.overrides },
    });
    renderTaskMode();
    renderPresets();
    syncLocalControls();
    advanced.refresh();
  });

  function renderPresets() {
    if (!presetList.length) {
      refs.presetCards.innerHTML = '<div class="ai-hint">未连接后端，暂不能选择预设（提交时回退旧参数集）</div>';
      refs.presetNote.textContent = '';
      refs.presetHint.textContent = '';
      renderTaskMode();
      refs.guardNote.hidden = true;
      return;
    }
    const preset = currentPreset();
    const dirty = preset ? modifiedKeys(preset, edit.overrides || {}).length > 0 : false;
    refs.presetCards.innerHTML = presetList
      .filter((item) => !item.custom)
      .map((item) => {
        const active = preset ? item.id === preset.id : false;
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
    refs.presetNote.textContent = preset
      ? `${preset.label || preset.id} · v${presetVersion}`
      : `v${presetVersion}`;
    refs.presetPillValue.textContent = preset ? (preset.label || preset.id) : '预设';
    refs.presetHint.textContent = preset
      ? `${preset.summary || ''}${dirty ? ' · 已覆盖 ' + modifiedKeys(preset, edit.overrides || {}).length + ' 项' : ''}`
      : '';
    renderCustomPick();
    renderTaskMode();
    syncGuardNote();
  }

  /** 任务页的「自定义搭配」入口：一个选择器，不挤占内置预设卡片。 */
  function renderCustomPick() {
    const host = refs.customPickHost;
    if (!host) return;
    const customs = presetList.filter((item) => item.custom);
    if (!customs.length) {
      host.innerHTML = '<div class="ai-hint">自定义搭配：到「设置 → 预设与自定义」创建。</div>';
      return;
    }
    const current = currentPresetId().id;
    const active = customs.some((item) => item.id === current) ? current : '';
    host.innerHTML = `<label class="ai-field">
      <span>自定义搭配</span>
      <select class="select" data-ref="customPick">
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

  /** 套用预设 / 自定义搭配的完整默认值（切预设时调用，页面临时值随之失效）。 */
  function applyPresetDefaults(preset) {
    if (!preset) return;
    const params = preset.params || {};
    const sampling = params.sampling || {};
    const steps = Number(sampling.steps);
    if (Number.isFinite(steps) && steps > 0) {
      edit.steps = steps;
      refs.steps.value = String(steps);
    }
    const cfgValue = Number(sampling.cfg);
    if (Number.isFinite(cfgValue) && cfgValue >= 0) {
      edit.cfg = cfgValue;
      refs.cfg.value = String(cfgValue);
    }
    if (sampling.sampler && [...refs.sampler.options].some((item) => item.value === sampling.sampler)) {
      edit.sampler = sampling.sampler;
      refs.sampler.value = sampling.sampler;
    }
    if (sampling.scheduler && [...refs.scheduler.options].some((item) => item.value === sampling.scheduler)) {
      edit.scheduler = sampling.scheduler;
      refs.scheduler.value = sampling.scheduler;
    }
    const denoise = Number(sampling.denoise);
    if (Number.isFinite(denoise)) {
      edit.denoise = denoise;
      refs.denoise.value = String(denoise);
    }
    // Turbo 是预设默认的一部分：切预设时恢复，之后再手动改才算临时覆盖。
    edit.turboUser = false;
    applyPresetTurbo(preset);
    const cons = params.consistency || {};
    edit.consistency = cons.enabled !== false;
    const strength = Number(cons.strength);
    edit.consistencyStrength = Number.isFinite(strength) ? strength : 0.48;
    edit.consistencyLora = cons.lora ? String(cons.lora) : '';
    const loras = Array.isArray(params.loras) ? params.loras : [];
    edit.loras = Object.fromEntries(
      loras
        .filter((item) => item && item.name)
        .map((item) => [String(item.name), Number(item.strength) || 1]),
    );
    edit.appliedPreset = preset.id;
    edit.taskMode = 'auto';
    patchSettings({
      edit: {
        preset: preset.id,
        taskMode: 'auto',
        appliedPreset: preset.id,
        turboUser: false,
        steps: edit.steps,
        cfg: edit.cfg,
        sampler: edit.sampler,
        scheduler: edit.scheduler,
        denoise: edit.denoise,
        consistency: edit.consistency,
        consistencyStrength: edit.consistencyStrength,
        consistencyLora: edit.consistencyLora,
        loras: edit.loras,
      },
    });
    renderConsistency();
    renderLoras();
    syncLocalControls();
    guards.sync(protectionOf(preset, edit.overrides || {}));
    syncGuardNote();
    renderCustomPick();
    renderTaskMode();
  }

  function choosePreset(preset) {
    if (!preset) return;
    edit.preset = preset.id;
    edit.overrides = resetDefinedOverrides(preset, edit.overrides || {});
    patchSettings({
      edit: { preset: preset.id, taskMode: 'auto', overrides: edit.overrides },
    });
    applyPresetDefaults(preset);
    renderPresets();
    advanced.refresh();
  }

  if (refs.customPickHost) {
    refs.customPickHost.addEventListener('change', (event) => {
      const select = event.target.closest('[data-ref="customPick"]');
      if (!select || !select.value) return;
      choosePreset(findPreset(presetList, select.value));
    });
  }

  function syncGuardNote() {
    const protection = protectionOf(currentPreset(), edit.overrides || {});
    const notes = [];
    const resolved = currentPresetId();
    if (resolved.degraded) {
      const from = findPreset(presetList, resolved.from);
      notes.push(`当前没有蒙版：「${from?.label || resolved.from}」会按整画布执行`);
    }
    if (!protection.color) notes.push('色彩校准已关闭：输出可能与原图有色差');
    if (!protection.zeroShift) notes.push('零像素偏移已关闭：可能出现 1~31px 位移或亚像素模糊');
    refs.guardNote.hidden = !notes.length;
    refs.guardNote.textContent = notes.join('；');
  }

  refs.presetCards.addEventListener('click', (event) => {
    const button = event.target.closest('[data-preset]');
    if (!button) return;
    choosePreset(findPreset(presetList, button.dataset.preset));
  });

  /** 旧字段一次性迁移到覆盖项，避免历史自定义值被预设默认值覆盖。 */
  function migrateLegacyOverrides() {
    if (edit.presetMigrated) return;
    const preset = currentPreset();
    if (!preset) return;
    let next = { ...(edit.overrides || {}) };
    const seed = (key, value, fallback) => {
      const number = Number(value);
      if (!Number.isFinite(number) || Math.abs(number - Number(fallback)) < 1e-6) return;
      if (!Object.prototype.hasOwnProperty.call(next, key)) next = withOverride(preset, next, key, number);
    };
    const scheme = String(effectiveValue(preset, edit.overrides || {}, 'local.scheme', 'a'));
    // 羽化 / 外扩只在方案 A 的遮罩合成里生效，方案 B 不迁移这两个旧值。
    if (scheme === 'a') {
      seed('local.feather', edit.feather, 32);
      seed('local.mask_expand', edit.maskExpand, 0);
    }
    seed('local.color_strength', edit.colorStrength, 0.6);
    seed('local.blend_pixels', edit.blendPixels, 24);
    if (edit.colorMatch === false) next = withOverride(preset, next, 'local.color_match', false);
    if (edit.scheme === 'b' || edit.scheme === 'native') {
      next = withOverride(preset, next, 'local.scheme', edit.scheme);
    }
    edit.overrides = next;
    edit.presetMigrated = true;
    patchSettings({ edit: { overrides: next, presetMigrated: true } });
  }

  /**
   * 回显预设生效值（不写覆盖项）。
   * 方案 / 羽化 / 外扩 / 颜色这几项已经没有页面快捷控件，统一在「高级参数」里改，
   * 这里只把状态同步到 store，供旧参数集（不带 preset 的后端）兜底使用。
   */
  function syncLocalControls() {
    const preset = currentPreset();
    if (!preset) return;
    edit.scheme = String(presetValue('local.scheme', preset.params?.local?.scheme || 'a'));
    edit.feather = Math.round(Number(presetValue('local.feather', 32)));
    edit.maskExpand = Math.round(Number(presetValue('local.mask_expand', 0)));
    edit.colorStrength = Number(presetValue('local.color_strength', 0.6));
    edit.colorMatch = Boolean(presetValue('local.color_match', true));
    patchSettings({
      edit: {
        scheme: edit.scheme,
        feather: edit.feather,
        maskExpand: edit.maskExpand,
        colorStrength: edit.colorStrength,
        colorMatch: edit.colorMatch,
      },
    });
  }

  function updateMaskStatus() {
    const target = images[0];
    if (!hasTargetMask()) {
      refs.actionHint.textContent = '未绘制遮罩：本次按整图编辑；点参考图上的 ✂ 涂抹只重绘的区域';
    } else {
      refs.actionHint.textContent = `已提交遮罩：覆盖 ${fmtCoverage(target.mask.coverage || 0)}，遮罩外逐像素保留`;
    }
    // 遮罩有无会影响「需蒙版预设」是否降级，及时刷新预设条与保护提示
    if (presetList.length) renderPresets();
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
        // 用户手动改过 Turbo 后，切换预设不再覆盖他的选择。
        edit.turboUser = true;
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
          const defaults = store.state.options?.defaults || {};
          restored = turboSnapshot || {
            steps: Number(defaults.steps) || 25,
            cfg: Number(defaults.cfg) || 4,
            sampler: defaults.sampler || 'euler',
          };
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
              turbo: false, turboProfile: value.profile, turboUser: true,
              steps: restored.steps, cfg: restored.cfg, sampler: restored.sampler,
            },
          });
          toastSuccess(`已关闭 Turbo，采样参数还原为 ${restored.steps} 步 · CFG ${restored.cfg}`);
        } else {
          patchSettings({
            edit: { turbo: value.enabled, turboProfile: value.profile, turboUser: true },
          });
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
    // Turbo 底模由后端按预设槽位（turbo_unet）自动切换，前端不再改模型下拉
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

  /**
   * 预设里的 Turbo 档位是默认值：未手动改过 Turbo 的用户跟随预设，
   * 手动改过之后由用户的显式选择优先（turboUser=true）。
   */
  function applyPresetTurbo(preset) {
    if (!turboControl || !preset || edit.turboUser) return;
    const turbo = preset.params?.turbo;
    if (!turbo) return;
    const profile = String(turbo.profile || edit.turboProfile || '');
    // 记住开启 Turbo 前的标准采样参数，用户手动关掉时能原样还原。
    if (turbo.enabled && !turboControl.getValue().enabled && !turboSnapshot) {
      turboSnapshot = {
        steps: Number(refs.steps.value) || 25,
        cfg: Number(refs.cfg.value) || 4,
        sampler: refs.sampler.value || 'euler',
      };
    }
    turboControl.setValue({ enabled: Boolean(turbo.enabled), profile });
    const actual = turboControl.getValue();
    edit.turbo = Boolean(actual.enabled);
    edit.turboProfile = actual.profile;
    patchSettings({ edit: { turbo: edit.turbo, turboProfile: edit.turboProfile } });
    applyTurboToFields(true);
  }

  function renderLoras() {
    const loras = store.state.options?.models?.lora || [];
    loraPicker = new LoraPicker(refs.loraHost, { loras, initial: edit.loras });
    const sync = () => {
      edit.loras = Object.fromEntries(loraPicker.getValue().map((item) => [item.name, item.strength]));
      patchSettings({ edit: { loras: edit.loras } });
    };
    if (!loraHostBound) {
      // 宿主元素固定，监听器只绑一次；闭包里的 loraPicker 始终指向最新实例。
      loraPicker.host.addEventListener('change', sync);
      loraPicker.host.addEventListener('input', sync);
      loraHostBound = true;
    }
  }

  function renderModels() {
    const defaults = store.state.options?.defaults || {};
    new ModelsSummary(refs.modelsHost, { slots: defaults.edit || defaults.slots || defaults });
  }

  function renderConsistency() {
    const loras = (store.state.options?.models?.lora || []).map((item) =>
      typeof item === 'string' ? { value: item, label: item } : { value: item.value ?? item.name, label: item.label || item.value || item.name },
    );
    // 默认选后端配置的一致性 LoRA，而不是 LoRA 列表的第一项。
    const preferred = pickConsistencyLora(
      store.state.options?.models?.lora || [],
      store.state.options?.defaults?.consistency_lora,
    );
    const current = edit.consistencyLora || preferred;
    refs.consistencyLora.innerHTML = loras.length
      ? loras
          .map(
            (lora) =>
              `<option value="${escapeHtml(lora.value)}" ${lora.value === current ? 'selected' : ''}>${escapeHtml(lora.label)}</option>`,
          )
          .join('')
      : '<option value="">后端未返回 LoRA 列表</option>';
    if (current && loras.some((lora) => lora.value === current)) {
      refs.consistencyLora.value = current;
      if (edit.consistencyLora !== current) {
        edit.consistencyLora = current;
        patchSettings({ edit: { consistencyLora: current } });
      }
    } else if (loras.length) {
      edit.consistencyLora = refs.consistencyLora.value;
      patchSettings({ edit: { consistencyLora: edit.consistencyLora } });
    }
    // 两页共用 `consistency`：预设默认开启时这里也应显示开启。
    refs.consistencyEnabled.checked = edit.consistency !== false;
    refs.consistencyStrength.value = String(edit.consistencyStrength);
    refs.consistencyStrengthVal.textContent = Number(edit.consistencyStrength).toFixed(2);
    refs.consistencyRows.classList.toggle('hidden', !refs.consistencyEnabled.checked);
  }

  refs.consistencyEnabled.addEventListener('change', () => {
    edit.consistency = refs.consistencyEnabled.checked;
    patchSettings({ edit: { consistency: edit.consistency } });
    refs.consistencyRows.classList.toggle('hidden', !edit.consistency);
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
  /** 预设加载 / 全局设置保存后：同步当前预设与页面默认值。 */
  function syncPresetState(forceApply = false) {
    // 预设被删除（例如自定义搭配在全局设置里删掉）时回落到默认预设。
    if (!findPreset(presetList, edit.preset)) {
      edit.preset = defaultPresetId(presetList);
      patchSettings({ edit: { preset: edit.preset } });
    }
    migrateLegacyOverrides();
    const preset = currentPreset();
    if (preset && (forceApply || edit.appliedPreset !== preset.id)) {
      // 切过预设 / 首次加载 / 全局默认刚更新：套用默认值，清掉临时覆盖。
      edit.overrides = resetDefinedOverrides(preset, edit.overrides || {});
      patchSettings({ edit: { overrides: edit.overrides } });
      applyPresetDefaults(preset);
    } else {
      // 同一个预设：保留页面临时值，只回显。
      syncLocalControls();
      guards.sync(protectionOf(currentPreset(), edit.overrides || {}));
      syncGuardNote();
      renderConsistency();
      renderLoras();
      renderCustomPick();
      renderTaskMode();
    }
    renderPresets();
    advanced.refresh();
  }

  // 预设摘要异步加载：先迁移旧字段，再回显预设生效值
  ensurePresets().then(() => syncPresetState(false));
  // 全局设置保存后：重新拉取预设 / 自定义搭配，并强制套用当前预设的新默认值。
  window.addEventListener('presets:updated', () => {
    if (!host.isConnected) return;
    presetList = [];
    presetVersion = 1;
    ensurePresets().then(() => syncPresetState(true));
  });

  /* ============================================================
   * 提交
   * ============================================================ */
  /** 拉取预设摘要；失败时退回旧参数集提交，不影响可用性。 */
  async function ensurePresets() {
    if (presetList.length) return presetList;
    try {
      const data = await loadPresets();
      presetList = data.list || [];
      presetVersion = data.version || 1;
    } catch {
      presetList = [];
    }
    return presetList;
  }

  /** 宽松数值比较：用于判断页面值与预设值是否等价（等价就不必显式回传）。 */
  function sameNumber(a, b) {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
  }

  /** LoRA 列表指纹（名称 + 强度，排序后比较，忽略顺序差异）。 */
  function loraSignature(list) {
    return (Array.isArray(list) ? list : [])
      .map((item) => {
        const name = String(item?.name || item?.value || '').trim();
        if (!name) return '';
        const strength = Number(item?.strength ?? item?.weight ?? 1);
        return `${name}@${(Number.isFinite(strength) ? strength : 1).toFixed(3)}`;
      })
      .filter(Boolean)
      .sort()
      .join('|');
  }

  function collectPayload(precomputedMask = null) {
    const mode = refs.sizeMode.value;
    const first = images[0];
    const localEnabled = hasTargetMask();
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
    const seedMode = edit.seedMode === 'fixed' ? 'fixed' : 'random';
    const seedText = refs.seed.value.trim();
    const seed = seedMode === 'random' ? null : Math.max(0, Math.floor(Number(seedText) || 0));
    const megapixels = Number(edit.megapixels);
    const consistencyOn = refs.consistencyEnabled.checked && Boolean(refs.consistencyLora.value);
    const pickerMeta = stylePicker.getMeta();
    // 指令框里的 @ 引用按参考图顺序映射成 <imageN>，与后端多图 token 对齐
    const promptText = promptEditor.getSemantic().trim();

    // 预设：有遮罩默认局部编辑，无遮罩降级整画布（§15.4 / 决策 53）
    const hasMask = Boolean(mask.dataURL);
    const wantedPreset = String(edit.preset || defaultPresetId(presetList) || 'mask_edit');
    const resolvedPreset = resolvePresetForMask(wantedPreset, hasMask);
    const presetMeta = findPreset(presetList, resolvedPreset.id);
    const presetId = presetMeta ? resolvedPreset.id : '';
    const presetTask = presetId ? presetTaskMode(presetMeta) : 'edit';
    const taskMode = String(edit.taskMode || 'auto') === 'auto'
      ? presetTask
      : String(edit.taskMode);
    // 元素移除：任务约定要求绿提示图，并把「移除绿色区域」写进指令
    const basePrompt = stylePicker.composePrompt(promptText);
    const promptFinal =
      taskMode === 'remove' && !basePrompt.includes('移除图像中的绿色区域')
        ? `${basePrompt}${basePrompt ? '；' : ''}移除图像中的绿色区域`
        : basePrompt;
    const consistency = consistencyOn
      ? { name: refs.consistencyLora.value, strength: Number(refs.consistencyStrength.value) }
      : false;

    const payload = {
      // 指令正文保持原文，风格/滤镜/视角在这里合成
      prompt: promptFinal,
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
      task: { mode: taskMode },
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
      loras: loraPicker.getValue(),
      consistency_lora: consistency,
      // 姿态图作为 image1：后端会把指令里的 <imageN> 顺延为 <image(N+1)>
      pose: poseState
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

    if (presetId) {
      // 预设模式：只发 preset + 覆盖项（§14.4）；其余参数由后端预设补全
      payload.preset = presetId;
      const extra = nestOverrides(edit.overrides || {});
      const localExtra = { ...(extra.local || {}) };
      // 局部编辑开关是页面上的显式选择：必须回传，否则预设里的 local.enabled=true 会把它盖掉
      localExtra.enabled = localEnabled;
      // 色彩校准 / 零偏移已经通过 overrides 里的 local.color_match / zero_shift.enabled 下发，
      // 不再另算一份 protection（两套状态会让界面与预设打架）。
      // 任务训练约定优先于预设文案
      if (taskMode === 'remove') {
        localExtra.fills = true;
        localExtra.hint = 'green_overlay';
      } else if (taskMode === 'outpaint') {
        localExtra.fills = false;
        localExtra.hint = 'gray_fill';
      } else if (taskMode === 'panorama') {
        // 全景必须整画布采样 + 灰边提示，覆盖预设里的任何裁剪/提示差异。
        localExtra.scheme = 'a';
        localExtra.fills = false;
        localExtra.hint = 'gray_fill';
      }
      // 一致性开关是用户当前选择，必须显式回传（开/关都发）：
      // 只在关闭时发 false 的话，用户重新打开会沿用预设里保存的 false，UI 勾选等于无效。
      localExtra.consistency = consistencyOn;
      if (Object.keys(localExtra).length) extra.local = localExtra;
      Object.assign(payload, extra);

      // 预设才是唯一事实源：与预设完全一致的采样 / Turbo / LoRA / 一致性不再显式回传。
      // 否则后端 merge() 只看到显式值（显式 > 预设），预设等于没生效，
      // 全局设置里改了预设默认值也不会跟着变。
      const presetParams = presetMeta?.params || {};
      const presetSampling = presetParams.sampling || {};
      const presetTurbo = presetParams.turbo;
      const turboFromPreset = !edit.turboUser && Boolean(presetTurbo?.enabled);
      if (turboFromPreset) {
        // Turbo 开启时采样由档位决定，采样字段和 turbo 本身都不必回传
        delete payload.turbo;
        delete payload.steps;
        delete payload.cfg;
        delete payload.sampler;
        delete payload.scheduler;
        delete payload.denoise;
      } else {
        if (presetSampling.steps != null && sameNumber(payload.steps, presetSampling.steps)) delete payload.steps;
        if (presetSampling.cfg != null && sameNumber(payload.cfg, presetSampling.cfg)) delete payload.cfg;
        if (presetSampling.denoise != null && sameNumber(payload.denoise, presetSampling.denoise)) delete payload.denoise;
        if (presetSampling.sampler != null && String(payload.sampler) === String(presetSampling.sampler)) delete payload.sampler;
        if (presetSampling.scheduler != null && String(payload.scheduler) === String(presetSampling.scheduler)) delete payload.scheduler;
      }
      if (presetParams.loras !== undefined
          && loraSignature(payload.loras) === loraSignature(presetParams.loras)) {
        delete payload.loras;
      }
      const presetCons = presetParams.consistency;
      const presetConsEnabled = Boolean(presetCons)
        && typeof presetCons === 'object'
        && presetCons.enabled !== false;
      // 只有预设本身开着一致性、且文件/强度都一致时才交给预设补全；
      // 预设关着而用户手动勾选开启时，必须显式带 consistency_lora，否则后端会按预设关掉。
      if (consistencyOn && presetConsEnabled) {
        const loraMatch = !presetCons.lora
          || String(presetCons.lora) === String(payload.consistency_lora?.name || '');
        const strengthMatch = sameNumber(
          payload.consistency_lora?.strength, Number(presetCons.strength ?? 0.48));
        if (loraMatch && strengthMatch) delete payload.consistency_lora;
      }
    } else {
      // 旧参数集：不带 preset 时保持原行为；保护开关仍读同一份覆盖项
      const guard = protectionOf(null, edit.overrides || {});
      payload.local = {
        enabled: localEnabled,
        scheme: ['a', 'b', 'auto', 'native'].includes(String(edit.scheme)) ? edit.scheme : 'a',
        feather: Math.round(Number(edit.feather) || 0),
        color_match: edit.colorMatch !== false && guard.color,
        color_restore: guard.color,
        color_strength: Number(edit.colorStrength),
        mask_expand: Math.round(Number(edit.maskExpand) || 0),
        blend_pixels: Math.round(Number(edit.blendPixels) || 0),
        consistency: consistencyOn,
      };
      if (!guard.zeroShift) payload.zero_shift = { enabled: false };
      if (taskMode === 'remove') {
        payload.local.fills = true;
        payload.local.hint = 'green_overlay';
      } else if (taskMode === 'outpaint') {
        payload.local.fills = false;
        payload.local.hint = 'gray_fill';
      } else if (taskMode === 'panorama') {
        payload.local.fills = false;
        payload.local.hint = 'gray_fill';
        payload.local.scheme = 'a';
      }
    }
    if (taskMode === 'panorama') {
      payload.panorama = {
        aspect: String(effectiveValue(
          presetMeta, edit.overrides || {}, 'panorama.aspect', '2:1')),
        long_side: Number(effectiveValue(
          presetMeta, edit.overrides || {}, 'panorama.long_side', 3072)) || 3072,
        wrap: Boolean(effectiveValue(
          presetMeta, edit.overrides || {}, 'panorama.wrap', false)),
        seam_blend: Number(effectiveValue(
          presetMeta, edit.overrides || {}, 'panorama.seam_blend', 24)) || 24,
      };
    }
    return payload;
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

  /* ============================================================
   * 连续编辑（接力）：结果自动接为下一轮输入、保留遮罩、回锚提示
   * chain 契约由预设下发（server/presets.py 的 chain_mask / chain_native）
   * ============================================================ */
  function activeChainConfig() {
    if (!images.length) return null;
    const hasMask = hasTargetMask();
    const wanted = String(edit.preset || defaultPresetId(presetList) || 'mask_edit');
    const resolved = resolvePresetForMask(wanted, hasMask);
    const cfg = chainConfigOf(findPreset(presetList, resolved.id));
    if (!cfg) return null;
    if (cfg.mode === 'mask' && !hasMask) return null;
    return cfg;
  }

  function beginChainIfNeeded(cfg) {
    const first = images[0];
    if (!first) return;
    const sameSession = chainSession.original
      && chainSession.config?.mode === cfg.mode
      && chainSession.lastDataUrl === first.dataUrl;
    if (sameSession) {
      chainSession.config = cfg;
      return;
    }
    chainSession = {
      config: cfg,
      round: 0,
      drift: 0,
      lastDataUrl: first.dataUrl,
      original: {
        dataUrl: first.dataUrl,
        width: first.width,
        height: first.height,
        mask: first.mask ? { ...first.mask } : null,
      },
    };
    renderChainBar();
  }

  function chainName(name, round) {
    const base = String(name || 'image').replace(/\.[^.]+$/, '');
    return `${base}-chain${round}.png`;
  }

  function renderChainBar() {
    const bar = refs.chainBar;
    if (!bar) return;
    const { round, drift, config, original } = chainSession;
    if (!original || !round) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const warn = drift >= (config?.driftWarn || 10);
    bar.hidden = false;
    bar.className = `notice ${warn ? 'warn' : 'info'}`;
    bar.innerHTML = `
      <span>连续编辑第 <b>${round}</b> 轮 · 结果已自动接为下一轮输入${config?.carryMask ? ' · 遮罩已保留' : ''} · 累计漂移 ΔE <b>${drift.toFixed(1)}</b>${warn ? '（建议回锚）' : ''}</span>
      <span class="spacer"></span>
      <button class="btn ghost sm" type="button" data-chain="anchor">回锚到原图</button>
      <button class="btn ghost sm" type="button" data-chain="hide">收起</button>`;
  }

  function anchorChainBack(silent = false) {
    const original = chainSession.original;
    if (!original || !images.length) return;
    const prev = images[0];
    images[0] = {
      ...prev,
      id: `img-${Date.now().toString(36)}`,
      name: chainName(prev.name, 'anchor'),
      dataUrl: original.dataUrl,
      width: original.width,
      height: original.height,
      mask: original.mask ? { ...original.mask } : null,
    };
    chainSession.round = 0;
    chainSession.drift = 0;
    chainSession.lastDataUrl = original.dataUrl;
    renderUploadList();
    renderModeRows();
    updateSizeInfo();
    updateMaskStatus();
    renderChainBar();
    if (!silent) toastSuccess('已回锚到本次接力的起点原图，遮罩已还原');
  }

  function promptChainAnchor() {
    const { round, drift, original } = chainSession;
    if (!original) return;
    openModal({
      title: `已连续编辑 ${round} 轮`,
      subtitle: '整图反复重绘会累积漂移；建议回锚到原图后再继续',
      content: `<div class="notice ${drift >= 10 ? 'warn' : 'info'}">相对起点原图累计漂移 ΔE ${drift.toFixed(1)}。回锚会丢弃这一段的画面变化（遮罩保留）。</div>`,
      actions: [
        { label: '继续接力', kind: 'ghost', close: true },
        { label: '回锚到原图', kind: 'primary', close: true, onClick: () => anchorChainBack() },
      ],
    });
  }

  async function advanceChain(job, cfg) {
    if (job?.status && job.status !== 'done') return;
    const image = (job?.images || [])[0];
    if (!image?.url) return;
    try {
      const url = String(image.url).startsWith('http') ? image.url : api.fileUrl(image.url);
      const dataUrl = await imageUrlToDataUrl(url);
      const { width, height } = await probeImageSize(dataUrl);
      const prev = images[0];
      if (!prev) return;
      let mask = null;
      if (cfg.carryMask && prev.mask?.dataUrl) {
        const same = Number(prev.mask.width) === Number(width)
          && Number(prev.mask.height) === Number(height);
        mask = same ? { ...prev.mask } : null;
        if (!same) toastWarn('输出尺寸与遮罩不一致，遮罩已清除，请重新涂抹');
      }
      images[0] = {
        ...prev,
        id: `img-${Date.now().toString(36)}`,
        name: chainName(prev.name, chainSession.round + 1),
        dataUrl,
        width,
        height,
        mask,
      };
      chainSession.round += 1;
      chainSession.lastDataUrl = dataUrl;
      chainSession.config = cfg;
      chainSession.drift = chainSession.original
        ? await meanDeltaE(chainSession.original.dataUrl, dataUrl)
        : 0;
      renderUploadList();
      renderModeRows();
      updateSizeInfo();
      updateMaskStatus();
      renderChainBar();
      if (chainSession.round % cfg.anchorEvery === 0) promptChainAnchor();
      else if (chainSession.drift >= cfg.driftWarn) {
        toastWarn(`连续编辑累计漂移 ΔE ${chainSession.drift.toFixed(1)}，建议回锚`);
      }
    } catch (err) {
      console.warn('[edit] 连续编辑自动接力失败', err);
      toastWarn('结果已生成，但自动接力失败：可把结果图重新拖入参考区继续');
    }
  }

  if (refs.chainBar) {
    refs.chainBar.addEventListener('click', (event) => {
      const action = event.target.closest('[data-chain]')?.dataset.chain;
      if (action === 'anchor') anchorChainBack();
      if (action === 'hide') refs.chainBar.hidden = true;
    });
  }

  async function handleSubmit(onPayloadBuilt = null) {
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
    if (hasTargetMask()) {
      const target = images[0];
      maskResult = {
        dataURL: target.mask.dataUrl,
        empty: false,
        width: target.mask.width,
        height: target.mask.height,
      };
    }
    // 扩图必须有至少一条外边；否则后端会静默退回普通编辑（且 warning 不再被忽略）。
    if (activeTaskMode() === 'outpaint') {
      const edges = ['top', 'bottom', 'left', 'right']
        .map((key) => Number(presetValue(`outpaint.${key}`, 0)) || 0);
      if (!edges.some((value) => value > 0)) {
        toastWarn('扩图需要至少一条外扩边：先点「⤢ 扩图」设置四边百分比');
        return;
      }
    }
    refs.submit.disabled = true;
    refs.submit.innerHTML = '<span class="spin"></span>编辑中…';
    try {
      // 等 vendor 模块就绪，确保风格预设能合成进编辑指令
      await stylePicker.ensureVendor();
      if (stylePicker.hasSelection() && !stylePicker.isReady()) {
        toastWarn('风格模块未就绪：本次将只使用原始编辑指令（可稍后重试）');
      }
      // 预设摘要必须先就绪：决定 preset / task.mode 与覆盖项合并
      await ensurePresets();
      // 明确选「元素移除」时必须已有蒙版，否则会提交一次无效任务
      if (String(edit.taskMode || 'auto') === 'remove' && !images[0]?.mask?.dataUrl) {
        toastWarn('元素移除需要先在参考图上涂抹蒙版（点 ✂ 绘制）');
        return;
      }
      // 连续编辑：记录本次接力的起点原图，成功后自动把结果接为下一轮输入
      const chainCfg = activeChainConfig();
      if (chainCfg) beginChainIfNeeded(chainCfg);
      const payload = collectPayload(maskResult);
      const maskOverlay = payload.__maskOverlay;
      delete payload.__maskOverlay;
      // 扩图弹窗在 payload 组好后才能把预设切回去，否则会拿旧预设重新采集参数。
      if (typeof onPayloadBuilt === 'function') onPayloadBuilt(payload);
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
        maskDataUrl: hasTargetMask() ? maskOverlay : null,
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
          if (chainCfg) void advanceChain(job, chainCfg);
          refreshHealthSoon();
        },
      });
    } catch (err) {
      // 提交前任何异常（预设/风格模块、payload 组装、后端 4xx）都必须可见，
      // 否则按钮只是静默复位，看起来像「点了没反应」。
      toastError(`提交失败：${err?.message || err}`);
      refs.resultState.textContent = '提交失败';
    } finally {
      refs.submit.disabled = false;
      refs.submit.textContent = '开始编辑';
    }
  }

  refs.submit.addEventListener('click', () => handleSubmit());
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
  /**
   * 扩图（新路径）：四边百分比 → 提交 `task=outpaint`，由后端补灰边并延展。
   * 复用图片精修同一块 `outpaintPanel`，数值写到共享的 `outpaint.*` 覆盖项。
   */
  function openOutpaintPanelDialog() {
    const first = images[0];
    if (!first) {
      toastWarn('请先上传第 1 张编辑目标图，再使用扩图');
      return;
    }
    const content = document.createElement('div');
    content.className = 'op-dialog';
    content.innerHTML = `
      <div class="op-dialog-body">
        <div class="op-dialog-stage">
          <div class="op-stage-box" data-ref="stageBox">
            <img data-ref="stageImg" alt="扩图预览" />
            <div class="studio-outpaint" data-ref="opLayer" hidden>
              <div class="so-shade" data-shade="top"></div>
              <div class="so-shade" data-shade="bottom"></div>
              <div class="so-shade" data-shade="left"></div>
              <div class="so-shade" data-shade="right"></div>
              <div class="so-frame" data-so="frame"></div>
              <span class="so-halo" data-edge="top"></span>
              <span class="so-halo" data-edge="bottom"></span>
              <span class="so-halo" data-edge="left"></span>
              <span class="so-halo" data-edge="right"></span>
              <span class="so-handle" data-edge="nw"></span>
              <span class="so-handle" data-edge="ne"></span>
              <span class="so-handle" data-edge="sw"></span>
              <span class="so-handle" data-edge="se"></span>
              <span class="so-cap" data-cap="top" hidden></span>
              <span class="so-cap" data-cap="bottom" hidden></span>
              <span class="so-cap" data-cap="left" hidden></span>
              <span class="so-cap" data-cap="right" hidden></span>
            </div>
          </div>
        </div>
        <div class="op-dialog-side" data-ref="panelHost"></div>
      </div>
      <div class="op-dialog-foot">
        <button class="btn ghost sm" type="button" data-ref="legacyBtn">改用旧流程：先扩画布再涂遮罩（legacy）</button>
      </div>`;
    let panel = null;
    const previousPreset = edit.preset || defaultPresetId(presetList);
    const previousTask = edit.taskMode || 'auto';
    let applied = false;
    const restorePrevious = () => {
      const prev = findPreset(presetList, previousPreset);
      if (prev) applyPresetDefaults(prev);
      edit.taskMode = previousTask;
      patchSettings({ edit: { preset: previousPreset, taskMode: previousTask } });
      renderPresets();
      renderTaskMode();
      syncLocalControls();
      advanced.refresh();
    };
    const modal = openModal({
      title: '扩图 / 外补画布',
      subtitle: '按四边百分比外补，提交时直接走 task=outpaint（灰边延展，遮罩外逐字节保留）',
      dialogClass: 'op-modal',
      hideFooter: true,
      content,
      onClose: () => {
        panel?.destroy?.();
        panel = null;
        // 取消时回到原预设，避免后续普通编辑被当成扩图提交
        if (!applied) restorePrevious();
      },
    });
    const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
    const stageImg = ref('stageImg');
    const stageBox = ref('stageBox');
    stageImg.src = first.dataUrl;
    panel = mountOutpaintPanel(ref('panelHost'), ref('opLayer'), {
      getSize: () => ({ width: first.width, height: first.height }),
      getView: () => {
        const width = stageBox.getBoundingClientRect().width;
        return { scale: first.width ? width / first.width : 1, x: 0, y: 0 };
      },
      onApply: () => {
        applied = true;
        let restored = false;
        const restore = () => {
          if (restored) return;
          restored = true;
          restorePrevious();
        };
        modal.close();
        // handleSubmit 异步等 vendor，payload 组好后再切回原预设；中途失败则兜底恢复。
        handleSubmit(restore).finally(restore);
      },
    });
    // 等预设加载完再 activate，确保能清掉 outpaint 预设定义键上的旧覆盖。
    Promise.resolve(panel.init()).then(() => {
      if (!panel) return; // 弹窗在预设加载完成前已被关闭
      panel.activate();
      const opPreset = findPreset(presetList, 'outpaint');
      if (opPreset) applyPresetDefaults(opPreset);
      // 扩图面板接管任务，任务下拉回到「跟随预设」
      edit.taskMode = 'auto';
      patchSettings({ edit: { taskMode: 'auto' } });
      renderTaskMode();
    });
    // 图片尺寸就绪后再对齐幽灵层（否则 getView 拿到 0 宽）
    if (stageImg.complete) requestAnimationFrame(() => panel?.syncGhost());
    else stageImg.addEventListener('load', () => requestAnimationFrame(() => panel?.syncGhost()), { once: true });
    ref('legacyBtn').addEventListener('click', () => {
      modal.close();
      openLegacyOutpaintDialog();
    });
  }

  /**
   * 扩图（旧流程 · legacy）：先把原图贴到新画布并生成新增区域遮罩，再走局部重绘。
   */
  function openLegacyOutpaintDialog() {
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
      <div class="notice info">旧流程（legacy）：先扩画布再生成遮罩，仍可用，但需要多一次「贴图 + 缩回」。新流程直接按四边百分比扩图，模型输出即为最终尺寸，遮罩外逐字节保留。</div>
      <div class="notice info">点击「生成画布」后：第 1 张图会被贴到新画布上，自动生成「新增区域」白色遮罩并预填扩图提示词；原图内容保持不变。</div>
      <div class="outpaint-actions">
        <button class="btn ghost" type="button" data-ref="cancel">取消</button>
        <button class="btn primary" type="button" data-ref="apply">生成画布</button>
      </div>`;
    let direction = 'right';
    let amount = 0.5;
    let busy = false;
    const modal = openModal({
      title: '扩图（旧流程 · legacy）',
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
            ? {
                dataUrl: result.maskDataUrl,
                width,
                height,
                coverage: await probeMaskCoverage(result.maskDataUrl),
              }
            : null,
        };
        renderUploadList();
        renderModeRows();
        updateSizeInfo();
        promptEditor.setText(result.prompt);
        edit.prompt = result.prompt;
        patchSettings({ edit: { prompt: result.prompt } });
        updatePromptCount();
        // 旧流程产出了新画布 + 遮罩，落回局部编辑预设
        edit.preset = 'mask_edit';
        edit.taskMode = 'auto';
        patchSettings({ edit: { prompt: result.prompt, preset: 'mask_edit', taskMode: 'auto' } });
        renderPresets();
        syncLocalControls();
        advanced.refresh();
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

  refs.outpaintBtn.addEventListener('click', openOutpaintPanelDialog);

  /* ============================================================
   * 历史回退：把 replay.params 拆回页面状态
   * 预设 + 覆盖项 + 尺寸 + 采样 + 种子 + Turbo + LoRA/一致性
   * ============================================================ */
  function applyRestore(restore) {
    if (!restore || typeof restore !== 'object') return;
    const warnings = [];

    const presetId = String(restore.preset || '').trim();
    const preset = presetId ? findPreset(presetList, presetId) : null;
    if (presetId && !preset) warnings.push(`预设 ${presetId} 已不存在`);
    if (preset) edit.preset = preset.id;

    // 预设之外的嵌套参数 → 扁平覆盖项；任务强制的 local 键不回填。
    const groups = ['local', 'zero_shift', 'preprocess', 'outpaint', 'panorama'];
    const taskKeys = new Set(['local.enabled', 'local.fills', 'local.hint', 'local.consistency']);
    const next = { ...(edit.overrides || {}) };
    const flatten = (prefix, value) => {
      if (value === undefined || value === null) return;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) flatten(`${prefix}.${key}`, child);
        return;
      }
      next[prefix] = value;
    };
    for (const group of groups) {
      if (restore[group] && typeof restore[group] === 'object') flatten(group, restore[group]);
    }
    for (const key of taskKeys) delete next[key];
    edit.overrides = next;

    // 尺寸
    const sizeMode = String(restore.size_mode || edit.sizeMode || 'follow');
    if (['follow', 'custom', 'ratio', 'fixed_point'].includes(sizeMode)) {
      edit.sizeMode = sizeMode;
      refs.sizeMode.value = sizeMode;
    }
    if (Number(restore.width) > 0) edit.width = snapUp(restore.width);
    if (Number(restore.height) > 0) edit.height = snapUp(restore.height);
    if (restore.ratio) edit.ratio = String(restore.ratio);
    if (restore.megapixels != null && restore.megapixels !== '') edit.megapixels = String(restore.megapixels);
    if (restore.fit === 'pad' || restore.fit === 'crop') {
      edit.fit = restore.fit;
      refs.fit.value = restore.fit;
    }
    if (restore.pad_mode) {
      edit.padMode = String(restore.pad_mode);
      if ([...refs.padMode.options].some((option) => option.value === edit.padMode)) {
        refs.padMode.value = edit.padMode;
      }
    }

    // 采样（按页面上下限夹紧）
    const steps = Number(restore.steps);
    if (Number.isFinite(steps) && steps > 0) {
      edit.steps = Math.min(200, Math.max(1, Math.round(steps)));
      refs.steps.value = String(edit.steps);
    }
    const cfgValue = Number(restore.cfg);
    if (Number.isFinite(cfgValue) && cfgValue >= 0) {
      edit.cfg = Math.min(20, cfgValue);
      refs.cfg.value = String(edit.cfg);
    }
    const denoise = Number(restore.denoise);
    if (Number.isFinite(denoise)) {
      edit.denoise = Math.min(1, Math.max(0, denoise));
      refs.denoise.value = String(edit.denoise);
    }
    if (restore.sampler && [...refs.sampler.options].some((item) => item.value === restore.sampler)) {
      edit.sampler = restore.sampler;
      refs.sampler.value = restore.sampler;
    }
    if (restore.scheduler && [...refs.scheduler.options].some((item) => item.value === restore.scheduler)) {
      edit.scheduler = restore.scheduler;
      refs.scheduler.value = restore.scheduler;
    }

    // 种子：历史记录里是后端实际使用的种子，回填后固定，保证可复现
    const seed = Number(restore.seed);
    if (Number.isFinite(seed)) {
      edit.seedMode = 'fixed';
      setSeedValue(String(Math.max(0, Math.floor(seed))));
    }

    // Turbo
    if (restore.turbo && typeof restore.turbo === 'object' && turboControl) {
      const turbo = { enabled: Boolean(restore.turbo.enabled), profile: String(restore.turbo.profile || '') };
      turboControl.setValue(turbo);
      edit.turbo = turbo.enabled;
      edit.turboProfile = turbo.profile;
      edit.turboUser = true;
      applyTurboToFields(false);
    }

    // LoRA
    if (Array.isArray(restore.loras)) {
      edit.loras = Object.fromEntries(
        restore.loras
          .filter((item) => item && item.name)
          .map((item) => [String(item.name), Number(item.strength) || 1]),
      );
      renderLoras();
    }

    // 一致性 LoRA
    const consistency = restore.consistency_lora;
    if (consistency && typeof consistency === 'object' && consistency.name) {
      edit.consistency = true;
      edit.consistencyLora = String(consistency.name);
      const strength = Number(consistency.strength);
      if (Number.isFinite(strength)) edit.consistencyStrength = Math.min(2, Math.max(0, strength));
    } else if (consistency === false) {
      edit.consistency = false;
    }
    renderConsistency();

    patchSettings({
      edit: {
        preset: edit.preset,
        overrides: edit.overrides,
        sizeMode: edit.sizeMode,
        width: edit.width,
        height: edit.height,
        ratio: edit.ratio,
        megapixels: edit.megapixels,
        fit: edit.fit,
        padMode: edit.padMode,
        steps: edit.steps,
        cfg: edit.cfg,
        denoise: edit.denoise,
        sampler: edit.sampler,
        scheduler: edit.scheduler,
        seedMode: edit.seedMode,
        seed: edit.seed,
        loras: edit.loras,
        consistency: edit.consistency,
        consistencyLora: edit.consistencyLora,
        consistencyStrength: edit.consistencyStrength,
        turbo: edit.turbo,
        turboProfile: edit.turboProfile,
        turboUser: edit.turboUser,
      },
    });
    syncSeedUi();
    renderModeRows();
    updateSizeInfo();
    syncSizeCard();
    renderPresets();
    renderTaskMode();
    syncLocalControls();
    advanced.refresh();
    guards.sync(protectionOf(currentPreset(), edit.overrides || {}));
    syncGuardNote();
    updateMaskStatus();
    if (warnings.length) toastWarn(`部分参数未还原：${warnings.join('、')}`);
  }

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
          coverage: await probeMaskCoverage(payload.mask),
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
      if (payload.taskMode) {
        const mode = String(payload.taskMode);
        if (['edit', 'inpaint', 'remove', 'outpaint', 'panorama'].includes(mode)) {
          edit.taskMode = mode;
          if (findPreset(presetList, mode)) edit.preset = mode;
          patchSettings({ edit: { taskMode: mode, preset: edit.preset } });
        }
      }
      if (payload.panorama && typeof payload.panorama === 'object') {
        const preset = findPreset(presetList, 'panorama') || currentPreset();
        for (const [key, value] of Object.entries(payload.panorama)) {
          if (value === undefined || value === null) continue;
          edit.overrides = withOverride(preset, edit.overrides || {}, `panorama.${key}`, value);
        }
        patchSettings({ edit: { overrides: edit.overrides } });
      }
      if (payload.restore) applyRestore(payload.restore);
      renderTaskMode();
      renderPresets();
      syncLocalControls();
      advanced.refresh();
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
