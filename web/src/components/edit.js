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
import { MaskEditor } from './maskEditor.js';
import { createStylePicker } from './stylePicker.js';
import { LoraPicker, ModelsField, TurboControl } from './controls.js';
import { openModal } from './modal.js';
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
    <div class="page page-edit">
      <div class="col col-side">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">编辑指令 <span class="panel-sub">描述如何修改画面</span></div>
            <div class="panel-actions">
              <button class="btn violet sm" type="button" data-ref="polish">✦ 润色指令</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="field">
              <span class="field-label">指令 <span class="tag-hint" data-ref="promptCount">0 字</span></span>
              <div data-ref="stylePicker"></div>
              <textarea class="textarea prompt-main" data-ref="prompt" spellcheck="false"
                placeholder="例如：把人物外套换成红色羽绒服，保持脸部光影与背景不变。"></textarea>
            </div>
            <div class="field">
              <span class="field-label">负向提示词 <span class="tag-hint">可选</span></span>
              <input class="input" data-ref="negative" placeholder="例如：文字、水印、变形、重复人物" />
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">参考图 <span class="panel-sub" data-ref="uploadCount">0 / ${MAX_IMAGES}</span></div>
            <div class="panel-actions">
              <button class="btn ghost sm" type="button" data-ref="clearImages">清空全部</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="dropzone" data-ref="dropzone" role="button" tabindex="0">
              <div class="glyph">⬆</div>
              <div>拖拽图片到这里，或点击选择</div>
              <small>1~10 张 · 第 1 张为「编辑目标」，其余为参考图 · PNG / JPG / WebP</small>
            </div>
            <input type="file" accept="image/*" multiple hidden data-ref="fileInput" />
            <div class="upload-list" data-ref="uploadList"></div>
            <div class="field-hint" data-ref="uploadHint">第 1 张同时作为遮罩编辑器底图与输出尺寸基准。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">尺寸与画布 <span class="panel-sub">零偏移对齐</span></div>
          </div>
          <div class="panel-body">
            <label class="field">
              <span class="field-label">尺寸模式</span>
              <select class="select" data-ref="sizeMode">
                <option value="follow">跟随原图（推荐 · 零偏移）</option>
                <option value="custom">自定义尺寸</option>
                <option value="ratio">按比例</option>
                <option value="fixed_point">BlueBox 32 不动点</option>
              </select>
            </label>
            <div data-ref="modeRows"></div>
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
            <div data-ref="localOptions">
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
            <div class="field">
              <span class="field-label">种子 <span class="tag-hint">留空 = 随机</span></span>
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
          </div>
        </section>

        <details class="fold">
          <summary>高级：模型、LoRA 与一致性</summary>
          <div class="fold-body">
            <div data-ref="modelsHost"></div>
            <div class="field">
              <span class="field-label">LoRA <span class="tag-hint">勾选启用 · 可调强度</span></span>
              <div data-ref="loraHost"></div>
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
      </div>

      <div class="col">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">遮罩编辑器 <span class="panel-sub" data-ref="maskMeta">白 = 编辑区</span></div>
            <div class="panel-actions">
              <button class="btn ghost sm" type="button" data-ref="outpaintBtn" title="先规划扩图画布，再自动生成「新增区域」遮罩">⤢ 扩图</button>
              <span class="panel-sub" data-ref="maskState">尚未绘制</span>
            </div>
          </div>
          <div class="mask-body" data-ref="maskHost"></div>
          <div class="mask-tips" style="padding:0 12px 12px">
            <span>白 = 编辑区</span><span>·</span><span>导出尺寸 = 第 1 张图尺寸</span>
            <span class="spacer"></span>
            <span>滚轮缩放 · 空格/中键平移 · Ctrl+Z 撤销</span>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">编辑结果</div>
            <div class="panel-actions"><span class="panel-sub" data-ref="resultState">等待任务</span></div>
          </div>
          <div data-ref="resultHost"></div>
        </section>
      </div>

      <!-- 操作条作为 page 网格的整行（grid-column: 1 / -1），粘底时横跨整页 -->
      <div class="action-bar card" data-ref="actionBar">
        <div class="action-strip" data-ref="actionStrip"></div>
        <div>
          <div class="field-hint" style="margin-bottom:2px" data-ref="readyHint">引擎就绪后可直接编辑</div>
          <div class="hint" data-ref="actionHint">第 1 张图会被完整读取，输出尺寸遵循所选模式</div>
        </div>
        <span class="spacer"></span>
        <span class="action-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 编辑</span>
        <button class="btn ghost" type="button" data-ref="reset">重置参数</button>
        <button class="btn primary lg" type="button" data-ref="submit">开始编辑</button>
      </div>
    </div>`;

  const ref = (name) => host.querySelector(`[data-ref="${name}"]`);
  const refs = {
    polish: ref('polish'),
    prompt: ref('prompt'),
    promptCount: ref('promptCount'),
    negative: ref('negative'),
    uploadCount: ref('uploadCount'),
    dropzone: ref('dropzone'),
    fileInput: ref('fileInput'),
    uploadList: ref('uploadList'),
    uploadHint: ref('uploadHint'),
    clearImages: ref('clearImages'),
    sizeMode: ref('sizeMode'),
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
    actionBar: ref('actionBar'),
    actionStrip: ref('actionStrip'),
    maskHost: ref('maskHost'),
    maskMeta: ref('maskMeta'),
    maskState: ref('maskState'),
    resultHost: ref('resultHost'),
    resultState: ref('resultState'),
    stylePicker: ref('stylePicker'),
    outpaintBtn: ref('outpaintBtn'),
  };

  const maskEditor = new MaskEditor(refs.maskHost, {
    onChange: (state) => updateMaskStatus(state),
  });
  const jobRunner = new JobRunner(refs.resultHost, {
    idleText: '上传参考图、写好编辑指令后点击「开始编辑」，进度与结果会显示在这里。',
  });
  // 编辑指令上方的风格选择器（与文生图页各自独立）
  const stylePicker = createStylePicker(refs.stylePicker, { scope: 'edit' });
  stylePicker.attachPrompt(refs.prompt);

  /* ============================================================
   * 提示词
   * ============================================================ */
  function updatePromptCount() {
    refs.promptCount.textContent = `${refs.prompt.value.length} 字`;
  }
  refs.prompt.value = edit.prompt || '';
  updatePromptCount();
  refs.prompt.addEventListener('input', () => {
    edit.prompt = refs.prompt.value;
    patchSettings({ edit: { prompt: edit.prompt } });
    updatePromptCount();
  });
  refs.negative.value = edit.negativePrompt || '';
  refs.negative.addEventListener('input', () => {
    edit.negativePrompt = refs.negative.value;
    patchSettings({ edit: { negativePrompt: edit.negativePrompt } });
  });
  refs.polish.addEventListener('click', async () => {
    await polishWithDialog({
      prompt: refs.prompt.value,
      mode: 'edit',
      model: store.state.polishModel || null,
      button: refs.polish,
      onAccept: (text) => {
        refs.prompt.value = text;
        edit.prompt = text;
        patchSettings({ edit: { prompt: text } });
        updatePromptCount();
      },
    });
  });

  /* ============================================================
   * 参考图
   * ============================================================ */
  function renderUploadList() {
    refs.uploadCount.textContent = `${images.length} / ${MAX_IMAGES}`;
    refs.uploadList.innerHTML = images
      .map(
        (image, index) => `
        <div class="upload-item" draggable="true" data-image-index="${index}" title="${escapeHtml(image.name)}">
          <img src="${escapeHtml(image.dataUrl)}" alt="参考图 ${index + 1}" />
          <span class="upload-badge">${index === 0 ? '编辑目标' : `参考图 ${index + 1}`}</span>
          <button class="upload-del" type="button" data-delete="${index}" title="删除这张">×</button>
          <span class="upload-index">${index === 0 ? 'target' : `image${index + 1}`}</span>
        </div>`,
      )
      .join('');
    if (!images.length) {
      refs.uploadList.innerHTML = '';
      refs.uploadHint.textContent = '第 1 张同时作为遮罩编辑器底图与输出尺寸基准。';
    } else {
      const first = images[0];
      refs.uploadHint.textContent = `第 1 张：${first.width} × ${first.height}（遮罩与输出以它为准）${images.length > 1 ? ` · 共 ${images.length} 张` : ''}`;
    }
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
    if (first) {
      maskEditor.setImage(first.dataUrl);
      refs.maskMeta.textContent = `${first.width} × ${first.height} · 白 = 编辑区`;
    } else {
      maskEditor.clearImage();
      refs.maskMeta.textContent = '白 = 编辑区';
    }
    if (first && Number(edit.width) <= 0) {
      edit.width = snapUp(first.width);
      edit.height = snapUp(first.height);
    }
    renderModeRows();
    updateSizeInfo();
    updateMaskStatus();
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
  });
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

  bindRange(refs.feather, 'feather', refs.featherVal, (v) => `${Math.round(v)} px`, () => maskEditor.setPreview({ feather: edit.feather, expand: edit.maskExpand }));
  // 注意：store 里的字段叫 maskExpand（不是 expand），绑错会让滑杆值变成 undefined → 显示 NaN px
  bindRange(refs.expand, 'maskExpand', refs.expandVal, (v) => `${Math.round(v)} px`, () => maskEditor.setPreview({ feather: edit.feather, expand: edit.maskExpand }));
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

  function updateMaskStatus(state) {
    const coverage = state?.coverage ?? 0;
    const percent = Math.round(coverage * 100);
    if (state?.empty || percent <= 0) {
      refs.maskState.innerHTML = '<span class="mask-invalid">○ 尚未绘制</span>';
    } else {
      refs.maskState.innerHTML = `<span class="mask-valid">● 已绘制 ${percent}%</span>`;
    }
    if (!refs.localEnabled.checked) {
      refs.actionHint.textContent = '局部编辑关闭：整图参与编辑';
    } else if (state?.empty) {
      refs.actionHint.textContent = '局部编辑已开启：请先在右侧遮罩编辑器涂抹编辑区';
    } else {
      refs.actionHint.textContent = '局部编辑已开启：遮罩外像素会逐像素保留原图';
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
  refs.seed.addEventListener('input', () => {
    edit.seed = refs.seed.value.trim();
    patchSettings({ edit: { seed: edit.seed } });
  });
  refs.randomSeed.addEventListener('click', () => {
    const seed = Math.floor(Math.random() * 1_000_000_000);
    refs.seed.value = String(seed);
    edit.seed = String(seed);
    patchSettings({ edit: { seed: edit.seed } });
  });
  refs.reuseSeed.addEventListener('click', () => {
    if (lastSeed == null) return;
    refs.seed.value = String(lastSeed);
    edit.seed = String(lastSeed);
    patchSettings({ edit: { seed: edit.seed } });
    toastSuccess(`已填入上次种子 ${lastSeed}`);
  });
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
  maskEditor.setPreview({ feather: edit.feather, expand: edit.maskExpand });
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
    const mask = precomputedMask || (localEnabled ? maskEditor.getMask() : { dataURL: null, empty: true });
    const turboValue = turboControl.getValue();
    const models = modelsField.getValue();
    const seedText = refs.seed.value.trim();
    const seed = seedText === '' ? null : Math.max(0, Math.floor(Number(seedText)));
    const megapixels = Number(edit.megapixels);
    const consistencyOn = refs.consistencyEnabled.checked && Boolean(refs.consistencyLora.value);
    const pickerMeta = stylePicker.getMeta();

    return {
      // 指令正文保持原文，风格/滤镜/视角在这里合成
      prompt: stylePicker.composePrompt(refs.prompt.value.trim()),
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
      meta: {
        source: 'web/edit',
        targetSize: first ? { width: first.width, height: first.height } : null,
        maskSize: mask.dataURL ? { width: mask.width, height: mask.height } : null,
        rawPrompt: refs.prompt.value.trim(),
        creativePresets: pickerMeta.creativePresets,
        imageAngle: pickerMeta.imageAngle,
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
    if (!refs.prompt.value.trim()) {
      toastWarn('请先填写编辑指令');
      refs.prompt.focus();
      return;
    }
    let maskResult = null;
    if (refs.localEnabled.checked) {
      maskResult = maskEditor.getMask();
      if (maskResult.empty) {
        toastWarn('局部编辑已开启，但还没有涂抹遮罩。请先在右侧遮罩编辑器里画出要编辑的区域。');
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
            refs.reuseSeed.disabled = false;
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
    const defaults = { steps: 25, cfg: 4.0, denoise: 1.0, seed: '', sampler: 'euler', scheduler: 'simple', turbo: false };
    Object.assign(edit, defaults);
    patchSettings({ edit: defaults });
    refs.seed.value = '';
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
        };
        renderUploadList();
        renderModeRows();
        updateSizeInfo();
        await maskEditor.setImage(images[0].dataUrl);
        const maskOk = await maskEditor.setMaskDataUrl(result.maskDataUrl);
        refs.prompt.value = result.prompt;
        edit.prompt = result.prompt;
        patchSettings({ edit: { prompt: result.prompt, localEnabled: true } });
        updatePromptCount();
        edit.localEnabled = true;
        refs.localEnabled.checked = true;
        syncLocalUi();
        updateMaskStatus();
        toastSuccess(
          `扩图已准备：新画布 ${width} × ${height}，${maskOk ? '遮罩已生成' : '遮罩生成失败，请手动涂抹'}`,
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
      renderUploadList();
      renderModeRows();
      updateSizeInfo();
      await maskEditor.setImage(images[0].dataUrl);
      if (payload.mask) {
        const ok = await maskEditor.setMaskDataUrl(payload.mask);
        if (!ok) toastWarn('扩图遮罩导入失败，可手动涂抹新增区域');
      }
      if (payload.prompt != null) {
        refs.prompt.value = payload.prompt;
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
