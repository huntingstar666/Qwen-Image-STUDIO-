/** 自动化流水线：宫格切分 → 逐格提示词 → AI 精修 → 审核导出（实验性）。 */
import { api } from '../api.js';
import {
  $, $$, h, escapeHtml, icon, toast, openModal, confirmDialog, clamp, num, readForm,
  selectField, numberField, syncRangeLabels, runStatusBadge, frameStatusBadge,
  fmtDuration,
} from '../ui.js';
import {
  Player, mountInspector, mountExportPanel, exportDefaults, progressOf, stepStrip,
  logPanel, runMetaLine,
} from '../components.js';
import {
  defaultsFromOptions, canvasFields, bindCanvas, modelFields, generationFields,
  readSettings, pageHead, emptyState, featureCard,
  settingRow, stepper, choiceRow, advancedCard, engineLabel, modelLabel, bindSettingRows,
  paramPill, canvasSummary, bindDrawer,
} from './common.js';

const ACTIVE = new Set(['planning', 'running', 'exporting']);

export class PipelineView {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.state = {
      runId: ctx.store.get('pipeline'),
      run: null,
      selected: 1,
      drafts: {},
      file: null,
      fileUrl: '',
      busy: false,
      autoStart: true,
      form: defaultsFromOptions(ctx.options),
      grid: { rows: 4, columns: 4, rowGap: 0, columnGap: 0, order: 'row-major', trim: 'union' },
      export: null,
      rightTab: 'inspect',
      poll: 0,
    };
    this.player = null;
  }

  mount(root) {
    this.root = root;
    this.state.export = this.ctx.store.prefs('pipeline.export', exportDefaults(this.ctx.options));
    this.render();
    this.loadRun();
  }

  unmount() {
    clearTimeout(this.state.poll);
    if (this.player) this.player.destroy();
    if (this.state.fileUrl) URL.revokeObjectURL(this.state.fileUrl);
  }

  /* ------------------------------------------------------------ 页面骨架 */

  render() {
    const run = this.state.run;
    const actions = `
      <button class="btn ghost" type="button" data-action="new">${icon('plus', 15)} 新建流水线</button>
      <button class="btn ghost" type="button" data-action="libraryHint">${icon('archive', 15)} 素材仓库</button>
      <button class="btn primary" type="button" data-action="pick">${icon('grid', 15)} 选择宫格图</button>
    `;
    this.root.innerHTML = `<div class="page page-host${run ? ' page-workspace' : ' setup-page'}">
      ${pageHead({
        kicker: '创作 / 自动化流水线',
        title: '自动化流水线',
        sub: '宫格切分 · 逐格精修 · 实验性；中间结果可逐格改词、重跑或恢复原图。',
        actions,
      })}
      ${run
        ? `<div class="work-grid">
            <div class="col col-left" data-role="left"></div>
            <div class="col col-center" data-role="center"></div>
            <div class="col col-right" data-role="right"></div>
          </div>`
        : `<div data-role="left"></div>`}
      <input type="file" id="pipelineFileInput" accept="image/*" hidden>
    </div>`;
    this.el = {
      left: this.root.querySelector('[data-role="left"]'),
      center: this.root.querySelector('[data-role="center"]'),
      right: this.root.querySelector('[data-role="right"]'),
      file: this.root.querySelector('#pipelineFileInput'),
    };
    this.bindShell();
    if (this.state.run) this.renderRun();
    else this.renderSetup();
  }

  bindShell() {
    const pageActions = this.root.querySelector('.page-actions');
    $$('[data-action]', pageActions || this.root).forEach((button) => {
      const action = button.dataset.action;
      if (action === 'pick') button.addEventListener('click', () => this.el.file.click());
      if (action === 'new') button.addEventListener('click', () => this.newPipeline());
      if (action === 'libraryHint') {
        button.addEventListener('click', () => {
          toast('先在主项目「素材仓库」收藏宫格图，再导出到本地选择；本页直接上传图片。', 'info');
        });
      }
    });
    this.el.file.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) this.setFile(file);
    });
  }

  /* ------------------------------------------------------------ 新建 */

  renderSetup() {
    const form = this.state.form;
    const grid = this.state.grid;
    this.el.left.innerHTML = `
      <div class="bench" data-role="workbench">
        <main class="bench-main">
          <section class="panel bench-stage">
            <div class="panel-head">
              <h2>宫格</h2>
              <span class="hint" id="pipelineStageHint"></span>
            </div>
            <div class="panel-body">
              <div class="bench-stage-host" id="pipelinePreview"></div>
              <label class="field"><span>统一提示词（可选）</span>
                <textarea class="textarea" name="pipelinePrompt" rows="2"
                  placeholder="留空则用内置的「只统一质感、不改内容」提示词；也可以逐格再改。"></textarea>
              </label>
              <label class="check"><input type="checkbox" id="pipelineAuto" checked> 切分后自动开始 AI 精修</label>
            </div>
          </section>
          <div class="bench-bar">
            <div class="bench-pills">
              ${paramPill({ key: 'grid', label: '网格', value: `${grid.rows} × ${grid.columns}` })}
              ${paramPill({ key: 'size', label: '尺寸', value: canvasSummary(this.ctx.options, form) })}
              ${paramPill({ key: 'fps', label: '帧率', value: `${form.fps} fps` })}
              <button class="param-pill gear" type="button" data-drawer-open aria-expanded="false">
                ${icon('settings', 13)} 参数
              </button>
            </div>
            <div class="bench-cta">
              <span class="mini">实验性功能：建议先小批量试跑，再逐格改词重跑。</span>
              <div class="spacer"></div>
              <button class="btn primary" type="button" data-action="create" disabled>${icon('spark', 15)} 切分并生成</button>
            </div>
          </div>
        </main>
        <aside class="bench-drawer" data-role="drawer">
          <div class="drawer-head">
            <span>参数</span>
            <button class="drawer-close" type="button" data-drawer-close aria-label="收起参数">${icon('close', 12)}</button>
          </div>
          <section class="panel" id="pipelineGridForm">
            <div class="panel-head"><h2>切分</h2><span class="hint">行优先 / 蛇形 / 列优先</span></div>
            <div class="panel-body">
              <div class="set-list">
                ${settingRow({ label: '行数', control: stepper({ name: 'rows', value: grid.rows, min: 1, max: 16, unit: '行' }) })}
                ${settingRow({ label: '列数', control: stepper({ name: 'columns', value: grid.columns, min: 1, max: 16, unit: '列' }) })}
                ${settingRow({
                  label: '纵向间隔', hint: '格与格之间留出的像素',
                  control: stepper({ name: 'rowGap', value: grid.rowGap, min: 0, max: 400, unit: 'px' }),
                })}
                ${settingRow({
                  label: '横向间隔', hint: '格与格之间留出的像素',
                  control: stepper({ name: 'columnGap', value: grid.columnGap, min: 0, max: 400, unit: 'px' }),
                })}
                ${choiceRow({ name: 'order', label: '读取顺序', options: [
                  { id: 'row-major', label: '行优先' },
                  { id: 'serpentine', label: '蛇形' },
                  { id: 'column-major', label: '列优先' },
                ], value: grid.order })}
                ${choiceRow({ name: 'trim', label: '裁边', options: [
                  { id: 'union', label: '并集' },
                  { id: 'each', label: '逐格' },
                  { id: 'none', label: '不裁' },
                ], value: grid.trim })}
              </div>
              <p class="mini" style="margin-top:10px">透明通道原样保留；每一格等比居中到统一画布，不裁切内容。</p>
            </div>
          </section>
          <section class="panel" id="pipelineSettings">
            <div class="panel-head"><h2>画布与精修</h2></div>
            <div class="panel-body">
              ${canvasFields(this.ctx.options, form)}
              ${advancedCard({
                meta: `${engineLabel(this.ctx.options, form.engine)} · ${modelLabel(this.ctx.options, form.model)}`,
                content: `<div class="stack">
                  ${modelFields(this.ctx.options, form)}
                  ${generationFields(this.ctx.options, form, { fold: false })}
                </div>`,
              })}
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>说明</h2><span class="badge experiment">Beta</span></div>
            <div class="panel-body setup-features">
              <div class="notice">${icon('info', 15)}<span>自动化流程仍在打磨：主体漂移、背景颗粒、材质不稳定都可能出现。</span></div>
              <div class="setup-feature"><span class="feature-icon">${icon('scissors', 15)}</span><div><strong>切分后先看一遍</strong><span>行优先 / 蛇形 / 列优先，可设间隔与裁边。</span></div></div>
              <div class="setup-feature"><span class="feature-icon">${icon('spark', 15)}</span><div><strong>逐格改词重跑</strong><span>每格独立提示词，改词、重跑、恢复原图都不影响其它格。</span></div></div>
            </div>
          </section>
        </aside>
      </div>
    `;
    this.bindSetup();
    this.renderPreview();
    this.syncCreate();
  }

  bindDropzones() {
    $$('[data-role="pipelineDrop"]', this.root).forEach((drop) => {
      if (drop.dataset.bound) return;
      drop.dataset.bound = '1';
      drop.addEventListener('click', () => this.el.file.click());
      drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('drag'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('drag');
        const file = event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) this.setFile(file);
      });
    });
  }

  bindSetup() {
    this.bindDropzones();
    bindCanvas(this.root);
    bindSettingRows(this.root);
    syncRangeLabels(this.root);
    bindDrawer(this.root);
    const auto = this.root.querySelector('#pipelineAuto');
    if (auto) auto.addEventListener('change', () => { this.state.autoStart = auto.checked; });
    const create = this.el.left.querySelector('[data-action="create"]');
    if (create) create.addEventListener('click', () => this.createPipeline());
  }

  setFile(file) {
    if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'warn'); return; }
    if (this.state.fileUrl) URL.revokeObjectURL(this.state.fileUrl);
    this.state.file = file;
    this.state.fileUrl = URL.createObjectURL(file);
    this.renderPreview();
    this.syncCreate();
  }

  renderPreview() {
    const host = this.root && this.root.querySelector('#pipelinePreview');
    if (!host) return;
    const hint = this.root.querySelector('#pipelineStageHint');
    if (hint) hint.textContent = this.state.fileUrl ? '已选择' : '';
    if (!this.state.fileUrl) {
      host.innerHTML = `<div class="dropzone" data-role="pipelineDrop">
        <div class="drop-empty">
          <span class="drop-icon">${icon('grid', 18)}</span>
          <strong>拖入一张宫格图</strong>
          <span>或点击选择文件</span>
        </div>
      </div>`;
      this.bindDropzones();
      return;
    }
    host.innerHTML = `<div class="stage-preview">
      <img src="${this.state.fileUrl}" alt="宫格图预览">
      <div class="stage-meta">
        <span class="badge info">${escapeHtml(this.state.file ? this.state.file.name : '宫格图')}</span>
        <span class="mini">切分后逐格进入轨道</span>
      </div>
    </div>`;
  }

  syncCreate() {
    const create = this.el.left && this.el.left.querySelector('[data-action="create"]');
    if (create) create.disabled = !this.state.file || this.state.busy;
  }

  async createPipeline() {
    if (!this.state.file) { toast('请先选择宫格图', 'warn'); return; }
    const gridForm = this.root.querySelector('#pipelineGridForm');
    const gridRaw = readForm(gridForm);
    const grid = {
      rows: num(gridRaw.rows, 4),
      columns: num(gridRaw.columns, 4),
      rowGap: num(gridRaw.rowGap, 0),
      columnGap: num(gridRaw.columnGap, 0),
      order: gridRaw.order || 'row-major',
      trim: gridRaw.trim || 'union',
    };
    const settingsRoot = this.root.querySelector('#pipelineSettings');
    const settings = readSettings(settingsRoot, this.ctx.options, this.state.form);
    const promptEl = this.root.querySelector('[name="pipelinePrompt"]');
    const template = promptEl ? promptEl.value.trim() : '';
    const count = grid.rows * grid.columns;
    const prompts = template ? new Array(count).fill(template) : [];
    this.state.busy = true;
    this.syncCreate();
    try {
      const run = await api.createPipeline(
        this.state.file, settings, grid, prompts,
        this.state.autoStart, `流水线 ${grid.rows}×${grid.columns}`,
      );
      this.state.run = run;
      this.state.runId = run.id;
      this.state.selected = 1;
      this.ctx.store.set('pipeline', run.id);
      this.render();
      this.startPoll();
      toast(`已切分 ${run.frameCount} 格${this.state.autoStart ? '，开始 AI 精修' : ''}`, 'success');
    } catch (error) {
      toast(error.message || '创建流水线失败', 'error');
    } finally {
      this.state.busy = false;
      this.syncCreate();
    }
  }

  newPipeline() {
    this.ctx.store.clear('pipeline');
    clearTimeout(this.state.poll);
    if (this.state.fileUrl) URL.revokeObjectURL(this.state.fileUrl);
    this.state.file = null;
    this.state.fileUrl = '';
    this.state.run = null;
    this.state.runId = '';
    this.state.selected = 1;
    this.render();
  }

  /* ------------------------------------------------------------ 已有流水线 */

  async loadRun() {
    if (!this.state.runId) return;
    try {
      const run = await api.getRun(this.state.runId);
      this.state.run = run;
      this.state.selected = clamp(this.state.selected, 1, Math.max(1, run.frameCount || 1));
      this.render();
      this.startPoll();
    } catch (error) {
      this.ctx.store.clear('pipeline');
      this.state.runId = '';
      this.state.run = null;
      this.render();
      if (error.status !== 404) toast(error.message, 'error');
    }
  }

  renderRun() {
    const run = this.state.run;
    const defaults = defaultsFromOptions(this.ctx.options);
    const settings = run.settings || {};
    const width = num(settings.width, defaults.width);
    const height = num(settings.height, defaults.height);
    const form = {
      ...defaults,
      width,
      height,
      canvas: this.ctx.options && this.ctx.options.canvas
        ? (this.ctx.options.canvas.find((item) => item.width === width && item.height === height) || {}).id || 'custom'
        : 'custom',
      fps: num(settings.timeline && settings.timeline.fps, defaults.fps),
      steps: num(settings.steps, defaults.steps),
      cfg: num(settings.cfg, defaults.cfg),
      engine: settings.engine || 'mock',
      model: settings.model || defaults.model,
      preset: settings.preset || '',
      style: settings.style || '',
      max_retries: num(settings.max_retries, defaults.max_retries),
      hold: num(settings.motion && settings.motion.hold, defaults.hold),
    };
    this.state.form = form;

    const grid = (run.plan && run.plan.grid) || {};
    this.el.left.innerHTML = `
      <div class="rail-surface">
      <section class="panel">
        <div class="panel-head"><h2>当前流水线</h2><div class="spacer"></div><span data-role="leftRunBadge">${runStatusBadge(run.status)}</span></div>
        <div class="panel-body stack" style="gap:8px">
          <strong style="font-size:13px">${escapeHtml(run.name || '自动化流水线')}</strong>
          <div class="row wrap">
            <span class="badge" data-role="leftRunMeta">${escapeHtml(runMetaLine(run))}</span>
            <span class="badge">${width}×${height}</span>
          </div>
          <div class="row wrap" style="margin-top:2px">
            <button class="btn small ghost" type="button" data-action="new">${icon('plus', 13)} 新建</button>
            <button class="btn small ghost" type="button" data-action="reload">${icon('refresh', 13)} 刷新</button>
          </div>
          ${grid.rows ? `<p class="mini">原始网格 ${grid.rows}×${grid.columns} · ${escapeHtml(grid.order || '')}</p>` : ''}
        </div>
      </section>
      <section class="panel" id="pipelineSettings">
        <div class="panel-head"><h2>精修参数</h2><span class="badge experiment">实验性</span></div>
        <div class="panel-body stack">
          <div class="notice">${icon('info', 15)}<span>结果尚不稳定；建议先跑 2–4 格确认方向，再批量精修。</span></div>
          ${advancedCard({
            title: '画布与节奏',
            meta: canvasSummary(this.ctx.options, form),
            content: canvasFields(this.ctx.options, form),
          })}
          ${advancedCard({
            meta: `${engineLabel(this.ctx.options, form.engine)} · ${modelLabel(this.ctx.options, form.model)}`,
            content: `<div class="stack">
              ${modelFields(this.ctx.options, form)}
              ${generationFields(this.ctx.options, form, { fold: false })}
            </div>`,
          })}
          <label class="field"><span>统一提示词（可选）</span>
            <textarea class="textarea" name="pipelinePrompt" rows="3"
              placeholder="留空则沿用每格自己的提示词；内置兜底只统一质感，不改内容。"></textarea>
          </label>
          <div class="row wrap">
            <button class="btn small ghost" type="button" data-action="applyPrompts">应用到全部格</button>
            <button class="btn primary small" type="button" data-action="runAll">${icon('spark', 14)} 精修全部</button>
            <button class="btn small ghost" type="button" data-action="runSelected" ${run.canPipeline ? '' : 'disabled'}>精修选中</button>
          </div>
        </div>
      </section>
      </div>
    `;

    this.el.center.innerHTML = `
      <div class="center-stack">
        <div id="pipelineStatus" class="status-strip"></div>
        <section class="panel player-surface pipeline-player">
          <div class="panel-head"><h2>顺序预览</h2><span class="hint" id="pipelinePlayerHint"></span></div>
          <div class="panel-body"><div id="pipelinePlayer"></div></div>
        </section>
        <section class="panel pipeline-grid-surface">
          <div class="panel-head"><h2>宫格与中间结果</h2><div class="spacer"></div>
            <span class="hint" id="pipelineGridHint"></span></div>
          <div class="panel-body"><div id="pipelineGrid"></div></div>
        </section>
        <details class="log-fold">
          <summary>运行日志 <span class="hint" id="pipelineLogHint"></span></summary>
          <div id="pipelineLog"></div>
        </details>
      </div>
    `;
    this.el.right.innerHTML = `
      <div class="rail-switch" data-role="rightSwitch">
        <button type="button" data-tab="inspect" class="active">格检查</button>
        <button type="button" data-tab="export">导出</button>
      </div>
      <section class="panel rail-surface" style="flex:1;min-height:0;overflow-y:auto">
        <div id="pipelineRailBody" class="panel-body"></div>
      </section>
    `;
    this.player = new Player(this.el.center.querySelector('#pipelinePlayer'), {
      onIndex: (index) => this.selectFrame(index),
    });
    this.bindRun();
    this.refreshDynamic();
  }

  bindRun() {
    bindCanvas(this.el.left);
    bindSettingRows(this.el.left);
    syncRangeLabels(this.el.left);
    const switchRoot = this.el.right.querySelector('[data-role="rightSwitch"]');
    if (switchRoot) {
      $$('[data-tab]', switchRoot).forEach((button) => {
        button.addEventListener('click', () => this.setRightTab(button.dataset.tab));
      });
    }
    const newBtn = this.el.left.querySelector('[data-action="new"]');
    if (newBtn) newBtn.addEventListener('click', () => this.newPipeline());
    const reload = this.el.left.querySelector('[data-action="reload"]');
    if (reload) reload.addEventListener('click', () => this.reload());
    const apply = this.el.left.querySelector('[data-action="applyPrompts"]');
    if (apply) apply.addEventListener('click', () => this.applyPrompts());
    const runAll = this.el.left.querySelector('[data-action="runAll"]');
    if (runAll) runAll.addEventListener('click', () => this.runPipeline(null));
    const runSelected = this.el.left.querySelector('[data-action="runSelected"]');
    if (runSelected) runSelected.addEventListener('click', () => this.runPipeline([this.state.selected]));
  }

  refreshDynamic() {
    const run = this.state.run;
    if (!run) return;
    const frames = run.frames || [];
    if (!frames.some((frame) => Number(frame.index) === Number(this.state.selected))) {
      this.state.selected = frames.length ? frames[0].index : 1;
    }
    this.renderStatus();
    const leftBadge = this.el.left.querySelector('[data-role="leftRunBadge"]');
    if (leftBadge) leftBadge.innerHTML = runStatusBadge(run.status);
    const leftMeta = this.el.left.querySelector('[data-role="leftRunMeta"]');
    if (leftMeta) leftMeta.textContent = runMetaLine(run);
    this.player.setRun(run, this.state.selected);
    this.renderGrid();
    const hint = this.el.center.querySelector('#pipelineGridHint');
    if (hint) hint.textContent = `${frames.filter((frame) => frame.isEdited).length}/${frames.length} 格已精修`;
    const playerHint = this.el.center.querySelector('#pipelinePlayerHint');
    if (playerHint) playerHint.textContent = `${frames.length} 格 · 按轨道顺序预览`;

    this.renderRight();
    const log = this.el.center.querySelector('#pipelineLog');
    if (log) log.innerHTML = logPanel(run.log || []);
    const logHint = this.el.center.querySelector('#pipelineLogHint');
    if (logHint) logHint.textContent = `${(run.log || []).length} 条`;
  }

  setRightTab(tab) {
    this.state.rightTab = tab === 'export' ? 'export' : 'inspect';
    const root = this.el.right.querySelector('[data-role="rightSwitch"]');
    if (root) {
      $$('[data-tab]', root).forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === this.state.rightTab);
      });
    }
    this.renderRight();
  }

  renderRight() {
    const body = this.el.right.querySelector('#pipelineRailBody');
    if (!body || !this.state.run) return;
    if (this.state.rightTab === 'export') {
      mountExportPanel(body, this.state.run, this.ctx.options, this.state, {
        onExport: (values) => this.exportRun(values),
      });
      return;
    }
    if (document.activeElement && body.contains(document.activeElement)) return;
    mountInspector(body, this.state.run, this.state.selected, {
      draft: this.draftFor(this.state.selected),
      onSavePrompt: (index, prompt) => this.savePrompt(index, prompt),
      onRetry: (index, payload) => this.retryFrame(index, payload),
      onGenerate: (index, payload) => this.retryFrame(index, payload),
      onRestore: (index) => this.restoreFrame(index),
      onDelete: (index) => this.deleteFrame(index),
      onMove: (index, delta) => this.moveFrame(index, delta),
    });
  }

  renderStatus() {
    const host = this.el.center.querySelector('#pipelineStatus');
    if (!host) return;
    const run = this.state.run;
    const progress = progressOf(run);
    const active = ACTIVE.has(run.status);
    host.innerHTML = `
      ${runStatusBadge(run.status)}
      <div class="status-strip-main">
        <div class="status-strip-line">
          <strong title="${escapeHtml(progress.message)}">${escapeHtml(progress.message)}</strong>
          <span>${progress.accepted}/${progress.total} 格 · ${progress.percent}%</span>
        </div>
        <div class="progress-bar"><span style="width:${progress.percent}%"></span></div>
      </div>
      <div class="row" style="gap:6px">
        ${active
          ? `<button class="btn small danger" type="button" data-action="cancel" title="取消">${icon('close', 13)}</button>`
          : `<button class="btn small subtle" type="button" data-action="reload" title="刷新">${icon('refresh', 13)}</button>`}
        <button class="btn small ${run.canExport ? 'primary' : 'ghost'}" type="button" data-action="openExport">${icon('download', 13)} 导出</button>
      </div>
    `;
    const cancel = host.querySelector('[data-action="cancel"]');
    if (cancel) cancel.addEventListener('click', () => this.cancel());
    const reload = host.querySelector('[data-action="reload"]');
    if (reload) reload.addEventListener('click', () => this.reload());
    const openExport = host.querySelector('[data-action="openExport"]');
    if (openExport) openExport.addEventListener('click', () => this.setRightTab('export'));
  }

  renderGrid() {
    const host = this.el.center.querySelector('#pipelineGrid');
    if (!host) return;
    const run = this.state.run;
    const frames = (run && run.frames) || [];
    if (!frames.length) { host.innerHTML = '<div class="empty-hint">还没有切分结果。</div>'; return; }
    host.innerHTML = `<div class="pipeline-grid">
      ${frames.map((frame) => {
        const status = frameStatusBadge(frame.status);
        const prompt = (frame.prompt || '').replace(/^以<image1>为画布[，,]?/, '').slice(0, 46);
        return `<article class="pipeline-cell${Number(frame.index) === Number(this.state.selected) ? ' selected' : ''}" data-frame="${frame.index}">
          <div class="pipeline-thumb">
            ${frame.previewUrl ? `<img src="${escapeHtml(frame.previewUrl)}" alt="第 ${frame.index} 格" loading="lazy">` : '<span class="placeholder">待生成</span>'}
            <span class="track-index">#${String(frame.index).padStart(2, '0')}</span>
            ${frame.isEdited ? '<span class="track-flag">AI</span>' : ''}
          </div>
          <div class="pipeline-cell-body">
            <div class="row" style="justify-content:space-between">${status}<span class="mini">${frame.attemptCount || 0} 次</span></div>
            <p class="pipeline-prompt" title="${escapeHtml(frame.prompt || '')}">${escapeHtml(prompt || '未写提示词 · 使用内置兜底')}</p>
            <div class="pipeline-cell-actions">
              <button class="btn tiny ghost" type="button" data-cell-action="edit">改词</button>
              <button class="btn tiny ghost" type="button" data-cell-action="retry" ${run.canPipeline ? '' : 'disabled'}>重跑</button>
              <button class="btn tiny ghost" type="button" data-cell-action="compare">对比</button>
            </div>
          </div>
        </article>`;
      }).join('')}
    </div>`;
    $$('.pipeline-cell', host).forEach((cell) => {
      const index = Number(cell.dataset.frame);
      cell.addEventListener('click', (event) => {
        if (event.target.closest('[data-cell-action]')) return;
        this.selectFrame(index);
      });
      $$('[data-cell-action]', cell).forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const frame = frames.find((item) => Number(item.index) === index);
          if (!frame) return;
          const action = button.dataset.cellAction;
          if (action === 'edit') this.editCell(frame);
          if (action === 'retry') this.retryFrame(index, frame.prompt || '');
          if (action === 'compare') this.compareFrame(frame);
        });
      });
    });
  }

  selectFrame(index) {
    this.state.selected = index;
    const run = this.state.run;
    if (!run) return;
    this.player.setIndex(index);
    this.renderGrid();
    this.renderRight();
  }

  editCell(frame) {
    const body = h('div', { class: 'stack' });
    body.innerHTML = `
      <div class="inspect-img-wrap" style="margin:0">
        <img src="${escapeHtml(frame.previewUrl || frame.sourcePreviewUrl || '')}" alt="第 ${frame.index} 格">
      </div>
      <label class="field"><span>第 ${frame.index} 格提示词</span>
        <textarea class="textarea" name="cellPrompt" rows="5">${escapeHtml(frame.prompt || '')}</textarea>
      </label>
      <p class="mini">这一格只影响自己；保存后可以立即重跑，不影响其它格。</p>
    `;
    const footer = h('div', { class: 'row', style: 'width:100%' });
    footer.innerHTML = `
      <button class="btn small ghost" type="button" data-action="compare">对比原图</button>
      <button class="btn small ghost" type="button" data-action="restore" ${frame.canRestore ? '' : 'disabled'}>恢复原图</button>
      <div class="spacer"></div>
      <button class="btn small ghost" type="button" data-action="save">仅保存</button>
      <button class="btn small primary" type="button" data-action="rerun">保存并重跑</button>
    `;
    const modal = openModal({ title: `第 ${frame.index} 格`, sub: '手动修改中间步骤', body, footer });
    const promptEl = body.querySelector('[name="cellPrompt"]');
    footer.querySelector('[data-action="compare"]').addEventListener('click', () => this.compareFrame(frame));
    footer.querySelector('[data-action="restore"]').addEventListener('click', async () => {
      try {
        this.state.run = await api.restoreFrame(this.state.runId, frame.index);
        modal.close();
        this.refreshDynamic();
        toast('已恢复原图', 'success');
      } catch (error) { toast(error.message, 'error'); }
    });
    footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
      try {
        this.state.run = await api.patchFrame(this.state.runId, frame.index, { prompt: promptEl.value });
        modal.close();
        this.refreshDynamic();
        toast('提示词已保存', 'success');
      } catch (error) { toast(error.message, 'error'); }
    });
    footer.querySelector('[data-action="rerun"]').addEventListener('click', async () => {
      modal.close();
      await this.retryFrame(frame.index, promptEl.value);
    });
  }

  compareFrame(frame) {
    const body = h('div', { class: 'compare-grid' });
    body.innerHTML = `
      <div class="compare-col"><span class="mini">切分原图</span>
        ${frame.sourcePreviewUrl || frame.originalPreviewUrl
          ? `<img src="${escapeHtml(frame.sourcePreviewUrl || frame.originalPreviewUrl)}" alt="原图">`
          : '<div class="empty-hint">没有原图</div>'}
      </div>
      <div class="compare-col"><span class="mini">当前结果</span>
        ${frame.previewUrl
          ? `<img src="${escapeHtml(frame.previewUrl)}" alt="结果">`
          : '<div class="empty-hint">还没有结果</div>'}
      </div>
    `;
    openModal({ title: `第 ${frame.index} 格 · 对比`, body });
  }

  async reload() {
    if (!this.state.runId) return;
    try {
      this.state.run = await api.getRun(this.state.runId);
      this.refreshDynamic();
    } catch (error) { toast(error.message, 'error'); }
  }

  startPoll() {
    clearTimeout(this.state.poll);
    const tick = async () => {
      if (!this.state.runId) return;
      try {
        const run = await api.getRun(this.state.runId);
        const previous = this.state.run;
        this.state.run = run;
        if (!previous || previous.updatedAt !== run.updatedAt || previous.status !== run.status) {
          this.refreshDynamic();
        }
      } catch (error) {
        if (error.status === 404) { this.newPipeline(); return; }
      }
      const active = this.state.run && ACTIVE.has(this.state.run.status);
      this.state.poll = setTimeout(tick, active ? 1200 : 5000);
    };
    this.state.poll = setTimeout(tick, 1200);
  }

  readPromptTemplate() {
    const el = this.el.left && this.el.left.querySelector('[name="pipelinePrompt"]');
    return el ? el.value.trim() : '';
  }

  async applyPrompts() {
    const run = this.state.run;
    if (!run) return;
    const template = this.readPromptTemplate();
    if (!template) { toast('请先填写统一提示词', 'warn'); return; }
    const ok = await confirmDialog({
      title: '覆盖全部格的提示词？',
      message: '统一提示词会写入每一格，已有自定义提示词会被覆盖。',
      confirmText: '覆盖',
      danger: true,
    });
    if (!ok) return;
    try {
      this.state.run = await api.setPrompts(run.id, new Array(run.frameCount).fill(template));
      this.refreshDynamic();
      toast('已应用到全部格', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async runPipeline(indexes) {
    const run = this.state.run;
    if (!run) return;
    if (run.status === 'running') { toast('正在精修中', 'warn'); return; }
    const settingsRoot = this.el.left.querySelector('#pipelineSettings');
    const settings = readSettings(settingsRoot, this.ctx.options, this.state.form);
    const template = this.readPromptTemplate();
    const payload = { settings };
    if (indexes && indexes.length) payload.indexes = indexes;
    if (template) {
      if (indexes && indexes.length === 1) payload.prompts = { [indexes[0]]: template };
      else payload.prompts = new Array(run.frameCount).fill(template);
    }
    try {
      this.state.run = await api.runPipeline(run.id, payload);
      this.refreshDynamic();
      this.startPoll();
      toast(indexes ? '开始精修选中格' : '开始精修全部格', 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async savePrompt(index, prompt) {
    try {
      this.state.run = await api.patchFrame(this.state.runId, index, { prompt });
      this.refreshDynamic();
      toast('提示词已保存', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  /* 参考框草稿：流水线轨道默认把本格放进画布，用户可自由增删。 */
  draftFor(index) {
    this.state.drafts = this.state.drafts || {};
    const key = String(index);
    if (!this.state.drafts[key]) {
      const frame = ((this.state.run && this.state.run.frames) || [])
        .find((item) => Number(item.index) === Number(index));
      this.state.drafts[key] = {
        images: [Number(index)],
        prompt: (frame && frame.prompt) || '',
      };
    }
    return this.state.drafts[key];
  }

  async retryFrame(index, payload) {
    const run = this.state.run;
    if (!run) return;
    if (run.status === 'running') { toast('正在生成中，请稍候', 'warn'); return; }
    const body = typeof payload === 'string' ? { prompt: payload } : (payload || {});
    const label = Array.isArray(body.images)
      ? (body.images.length ? `图生图（${body.images.length} 张参考）` : '文生图')
      : '精修';
    try {
      this.state.run = await api.retryFrame(run.id, index, body);
      this.refreshDynamic();
      this.startPoll();
      toast(`第 ${index} 格开始${label}`, 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async restoreFrame(index) {
    try {
      this.state.run = await api.restoreFrame(this.state.runId, index);
      this.refreshDynamic();
      toast('已恢复原图', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async deleteFrame(index) {
    const ok = await confirmDialog({
      title: '删除这一格？', message: `第 ${index} 格会从轨道移除，后续格自动前移。`,
      confirmText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      this.state.run = await api.deleteFrame(this.state.runId, index);
      this.state.drafts = {};
      this.refreshDynamic();
      toast('已删除一格', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async moveFrame(index, delta) {
    const run = this.state.run;
    if (!run) return;
    const target = index + delta;
    if (target < 1 || target > (run.frames || []).length) return;
    const order = (run.frames || []).map((frame) => Number(frame.index));
    const from = order.indexOf(index);
    const to = order.indexOf(target);
    order.splice(to, 0, order.splice(from, 1)[0]);
    try {
      this.state.run = await api.reorderFrames(run.id, order);
      this.state.drafts = {};
      this.refreshDynamic();
    } catch (error) { toast(error.message, 'error'); }
  }

  async exportRun(values) {
    const run = this.state.run;
    if (!run) return;
    if (!run.canExport) { toast('还有格未通过，无法导出', 'warn'); return; }
    this.ctx.store.setPrefs('pipeline.export', this.state.export);
    const timeline = {
      fps: values.fps,
      holds: (run.settings && run.settings.timeline && run.settings.timeline.holds) || [],
    };
    const motion = {
      preset: values.preset, fps: values.motionFps, jitter: values.jitter,
      grain: values.grain, vignette: values.vignette, color_boil: values.colorBoil,
    };
    try {
      await api.approve(run.id).catch(() => {});
      this.state.run = await api.exportRun(run.id, values.fps, {
        format: values.format, align: values.align, color_match: values.colorMatch,
      }, { motion, timeline });
      this.refreshDynamic();
      this.startPoll();
      toast('开始导出成片', 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async cancel() {
    if (!this.state.runId) return;
    try {
      await api.cancel(this.state.runId);
      toast('已发送取消请求', 'warn');
      this.reload();
    } catch (error) { toast(error.message, 'error'); }
  }
}
