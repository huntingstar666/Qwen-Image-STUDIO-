/** 连续编辑：一张参考图 → LLM/手写分镜 → 逐帧接力生成 → 审核 → 导出。 */
import { api } from '../api.js';
import {
  $, $$, h, escapeHtml, icon, toast, openModal, confirmDialog, clamp, num, readForm,
  numberField, selectField, checkField, syncRangeLabels, runStatusBadge, bindSegmented,
} from '../ui.js';
import {
  Player, mountTrack, mountInspector, mountExportPanel, exportDefaults, progressOf,
  stepStrip, logPanel, runMetaLine,
} from '../components.js';
import {
  defaultsFromOptions, canvasFields, bindCanvas, modelFields, generationFields,
  readSettings, pageHead, emptyState, featureCard,
  settingRow, stepper, advancedCard, engineLabel, modelLabel, bindSettingRows,
  paramPill, canvasSummary, bindDrawer,
} from './common.js';

const ACTIVE = new Set(['planning', 'running', 'exporting']);

const NARRATIVE_PRESETS = {
  action: {
    label: '连续动作',
    relay: 'chain', background: 'plain', consistency: true, preset: 'chain_mask',
    steps: 8, cfg: 1.0, turbo: true,
    hint: '表情、吃喝、循环动作：每帧基于上一帧，遮罩锁主体。',
  },
  growth: {
    label: '成长变形',
    relay: 'chain', background: 'fixed', consistency: false, preset: '',
    steps: 16, cfg: 4.0, turbo: false,
    hint: '种子→大树：关掉一致性 LoRA，固定背景分层重绘。',
  },
  seasonal: {
    label: '四季变换',
    relay: 'independent', background: 'plain', consistency: false, preset: '',
    steps: 16, cfg: 4.0, turbo: false,
    hint: '同一主体换季节/配色：每帧都从参考图出发，减少噪声累积。',
  },
};

export class ChainView {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.state = {
      runId: ctx.store.get('chain'),
      run: null,
      selected: 1,
      file: null,
      fileUrl: '',
      mode: 'llm',
      busy: false,
      form: defaultsFromOptions(ctx.options),
      export: null,
      rightTab: 'inspect',
      poll: 0,
    };
    this.player = null;
  }

  mount(root) {
    this.root = root;
    this.state.export = this.ctx.store.prefs('chain.export', exportDefaults(this.ctx.options));
    this.render();
    this.loadRun();
  }

  unmount() {
    clearTimeout(this.state.poll);
    if (this.player) this.player.destroy();
    if (this.state.fileUrl) URL.revokeObjectURL(this.state.fileUrl);
  }

  render() {
    const run = this.state.run;
    const actions = `
      <button class="btn ghost" type="button" data-action="new">${icon('plus', 15)} 新建</button>
      <button class="btn primary" type="button" data-action="pick">${icon('image', 15)} 选择参考图</button>
    `;
    this.root.innerHTML = `<div class="page page-host${run ? ' page-workspace' : ' setup-page'}">
      ${pageHead({
        kicker: '创作 / 连续编辑',
        title: '连续编辑',
        sub: '参考图 · 分镜 · 逐帧接力；自检通过后审核导出。',
        actions,
      })}
      ${run
        ? `<div class="work-grid">
            <div class="col col-left" data-role="left"></div>
            <div class="col col-center" data-role="center"></div>
            <div class="col col-right" data-role="right"></div>
          </div>`
        : `<div data-role="left"></div>`}
      <input type="file" id="chainFileInput" accept="image/*" hidden>
    </div>`;
    this.el = {
      left: this.root.querySelector('[data-role="left"]'),
      center: this.root.querySelector('[data-role="center"]'),
      right: this.root.querySelector('[data-role="right"]'),
      file: this.root.querySelector('#chainFileInput'),
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
      if (action === 'new') button.addEventListener('click', () => this.newRun());
    });
    this.el.file.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) this.setFile(file);
    });
  }

  /* ------------------------------------------------------------ 新建 */

  renderSetup() {
    const form = this.state.form;
    this.el.left.innerHTML = `
      <div class="bench" data-role="workbench">
        <main class="bench-main">
          <section class="panel bench-stage">
            <div class="panel-head">
              <h2>参考图</h2>
              <span class="hint" id="chainStageHint"></span>
            </div>
            <div class="panel-body">
              <div class="bench-stage-host" id="chainPreview" style="min-height:240px"></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head">
              <h2>分镜</h2>
              <div class="spacer"></div>
              <div class="segmented" data-role="modeSwitch">
                <button type="button" data-mode="llm" class="active">LLM 分镜</button>
                <button type="button" data-mode="manual">手写分镜</button>
              </div>
            </div>
            <div class="panel-body">
              <label class="field"><span>一句话想法</span>
                <textarea class="textarea" name="idea" rows="2" placeholder="例如：让图片中的小人疯狂吃米饭"></textarea>
              </label>
              <div id="chainManual" class="hidden" style="margin-top:8px">
                <label class="field"><span>手写提示词（每行一条，至少 2 条）</span>
                  <textarea class="textarea" name="manualPrompts" rows="5"
                    placeholder="保持构图不变，小人低头吃一口米饭&#10;小人抬头咀嚼，表情满足&#10;小人又低头吃一口……"></textarea>
                </label>
                <p class="mini">手写分镜不会调用 LLM，也不会改写任何一条提示词，适合四季、表情九宫格这类固定节拍。</p>
              </div>
              <div class="chips" style="margin-top:8px">
                ${Object.entries(NARRATIVE_PRESETS).map(([id, item]) => `<button type="button" class="chip" data-narrative="${id}">${item.label}</button>`).join('')}
              </div>
              <p class="mini" id="narrativeHint" style="margin-top:6px">不确定就先用「连续动作」：接力重绘 + 遮罩锁主体。</p>
            </div>
          </section>
          <div class="bench-bar">
            <div class="bench-pills">
              ${paramPill({ key: 'size', label: '尺寸', value: canvasSummary(this.ctx.options, form) })}
              ${paramPill({ key: 'fps', label: '帧率', value: `${form.fps} fps` })}
              ${paramPill({ key: 'frames', label: '帧数', value: `${form.frames} 帧` })}
              <button class="param-pill gear" type="button" data-drawer-open aria-expanded="false">
                ${icon('settings', 13)} 参数
              </button>
            </div>
            <div class="bench-cta">
              <label class="check"><input type="checkbox" id="chainAuto" checked> 创建后立即生成</label>
              <div class="spacer"></div>
              <button class="btn primary" type="button" data-action="create" disabled>${icon('spark', 15)} 创建 run</button>
            </div>
          </div>
        </main>
        <aside class="bench-drawer" data-role="drawer">
          <div class="drawer-head">
            <span>参数</span>
            <button class="drawer-close" type="button" data-drawer-close aria-label="收起参数">${icon('close', 12)}</button>
          </div>
          <section class="panel" id="chainSettings">
            <div class="panel-head"><h2>画布与节奏</h2></div>
            <div class="panel-body">
              ${canvasFields(this.ctx.options, form)}
              <div class="set-list">
                ${settingRow({
                  label: '计划帧数', hint: '手写分镜会按提示词条数覆盖',
                  control: stepper({ name: 'frames', value: form.frames, min: 2, max: 48, unit: '帧' }),
                })}
              </div>
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
            <div class="panel-head"><h2>叙事决策</h2></div>
            <div class="panel-body setup-features">
              <div class="setup-feature"><span class="feature-icon">${icon('spark', 15)}</span><div><strong>连续动作</strong><span>接力 + 遮罩 + 一致性 LoRA，适合表情、吃喝、循环。</span></div></div>
              <div class="setup-feature"><span class="feature-icon">${icon('layers', 15)}</span><div><strong>成长变形</strong><span>关一致性 LoRA，固定背景或普通 16 步采样。</span></div></div>
              <div class="setup-feature"><span class="feature-icon">${icon('clock', 15)}</span><div><strong>四季变换</strong><span>独立出图 + 手写提示词，减少噪声累积。</span></div></div>
              <div class="notice">${icon('info', 15)}<span>固定节拍的片子，手写分镜通常比 LLM 分镜更稳；生成中 8700 偶发退出会自动等待重试。</span></div>
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
    $$('[data-role="chainDrop"]', this.root).forEach((drop) => {
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
    $$('[data-mode]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => {
        this.state.mode = button.dataset.mode;
        $$('[data-mode]', this.el.left).forEach((item) => item.classList.toggle('active', item === button));
        const manual = this.el.left.querySelector('#chainManual');
        if (manual) manual.classList.toggle('hidden', this.state.mode !== 'manual');
      });
    });
    $$('[data-narrative]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => this.applyNarrative(button.dataset.narrative));
    });
    const auto = this.el.left.querySelector('#chainAuto');
    if (auto) auto.checked = true;
    const create = this.el.left.querySelector('[data-action="create"]');
    if (create) create.addEventListener('click', () => this.createRun());
    const autoStart = this.el.left.querySelector('#chainAuto');
    if (autoStart) this.state.autoStart = autoStart.checked;
  }

  applyNarrative(id) {
    const preset = NARRATIVE_PRESETS[id];
    if (!preset) return;
    const form = this.state.form;
    form.relay = preset.relay;
    form.background = preset.background;
    form.consistency = preset.consistency;
    form.preset = preset.preset;
    form.steps = preset.steps;
    form.cfg = preset.cfg;
    form.turbo = preset.turbo;
    this.state.form = form;
    this.renderSetup();
    toast(`已切换为「${preset.label}」参数`, 'success');
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
    const host = this.root && this.root.querySelector('#chainPreview');
    if (!host) return;
    const hint = this.root.querySelector('#chainStageHint');
    if (hint) hint.textContent = this.state.fileUrl ? '已选择' : '';
    if (!this.state.fileUrl) {
      host.innerHTML = `<div class="dropzone" data-role="chainDrop">
        <div class="drop-empty">
          <span class="drop-icon">${icon('image', 18)}</span>
          <strong>拖入一张参考图</strong>
          <span>或点击选择文件</span>
        </div>
      </div>`;
      this.bindDropzones();
      return;
    }
    host.innerHTML = `<div class="stage-preview">
      <img src="${this.state.fileUrl}" alt="参考图预览">
      <div class="stage-meta">
        <span class="badge info">${escapeHtml(this.state.file ? this.state.file.name : '参考图')}</span>
        <span class="mini">生成时作为首帧锚点</span>
      </div>
    </div>`;
  }

  syncCreate() {
    const create = this.el.left && this.el.left.querySelector('[data-action="create"]');
    if (create) create.disabled = !this.state.file || this.state.busy;
  }

  async createRun() {
    if (!this.state.file) { toast('请先选择参考图', 'warn'); return; }
    const root = this.root.querySelector('#chainSettings');
    const settings = readSettings(root, this.ctx.options, this.state.form);
    const ideaEl = this.el.left.querySelector('[name="idea"]');
    let idea = ideaEl ? ideaEl.value.trim() : '';
    const manualEl = this.el.left.querySelector('[name="manualPrompts"]');
    const manualPrompts = manualEl
      ? manualEl.value.split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    if (this.state.mode === 'manual') {
      if (manualPrompts.length < 2) { toast('手写分镜至少需要 2 条提示词', 'warn'); return; }
      if (!idea) idea = manualPrompts[0].slice(0, 40);
    }
    if (!idea) { toast('请先写一句话想法', 'warn'); return; }
    const autoStartEl = this.el.left.querySelector('#chainAuto');
    const autoStart = autoStartEl ? autoStartEl.checked : true;
    this.state.busy = true;
    this.syncCreate();
    try {
      let run = await api.createRun(this.state.file, idea, settings, settings.engine);
      if (this.state.mode === 'manual') {
        run = await api.setPrompts(run.id, manualPrompts);
      }
      if (autoStart) {
        run = await api.start(run.id);
      } else if (this.state.mode === 'llm') {
        run = await api.plan(run.id);
      }
      this.state.run = run;
      this.state.runId = run.id;
      this.state.selected = 1;
      this.ctx.store.set('chain', run.id);
      this.render();
      this.startPoll();
      toast(autoStart ? '已创建并开始生成' : '已创建 run', 'success');
    } catch (error) {
      toast(error.message || '创建失败', 'error');
    } finally {
      this.state.busy = false;
      this.syncCreate();
    }
  }

  newRun() {
    this.ctx.store.clear('chain');
    clearTimeout(this.state.poll);
    if (this.state.fileUrl) URL.revokeObjectURL(this.state.fileUrl);
    this.state.file = null;
    this.state.fileUrl = '';
    this.state.run = null;
    this.state.runId = '';
    this.state.selected = 1;
    this.render();
  }

  /* ------------------------------------------------------------ 已有 run */

  async loadRun() {
    if (!this.state.runId) return;
    try {
      const run = await api.getRun(this.state.runId);
      this.state.run = run;
      this.state.selected = clamp(this.state.selected, 1, Math.max(1, run.frameCount || 1));
      this.render();
      this.startPoll();
    } catch (error) {
      this.ctx.store.clear('chain');
      this.state.runId = '';
      this.state.run = null;
      this.render();
      if (error.status !== 404) toast(error.message, 'error');
    }
  }

  renderRun() {
    const run = this.state.run;
    this.el.left.innerHTML = `
      <div class="rail-surface">
      <section class="panel">
        <div class="panel-head"><h2>当前轨道</h2><div class="spacer"></div><span data-role="leftRunBadge">${runStatusBadge(run.status)}</span></div>
        <div class="panel-body stack" style="gap:8px">
          <strong style="font-size:13px">${escapeHtml(run.name || run.idea || '未命名')}</strong>
          <p class="mini">${escapeHtml(run.idea || '')}</p>
          <div class="row wrap"><span class="badge" data-role="leftRunMeta">${escapeHtml(runMetaLine(run))}</span>
            <span class="badge">${(run.settings && run.settings.width) || 0}×${(run.settings && run.settings.height) || 0}</span>
            <span class="badge">${escapeHtml((run.settings && run.settings.engine) === 'main' ? '主项目' : '模拟')}</span>
          </div>
          <div class="row wrap" style="margin-top:2px">
            <button class="btn small ghost" type="button" data-action="new">${icon('plus', 13)} 新建</button>
            <button class="btn small ghost" type="button" data-action="reload">${icon('refresh', 13)} 刷新</button>
            <button class="btn small subtle" type="button" data-action="editPrompts">${icon('wand', 13)} 手写分镜</button>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>生成控制</h2></div>
        <div class="panel-body stack">
          <div class="row wrap">
            <button class="btn primary small" type="button" data-action="start" ${run.canStart ? '' : 'disabled'}>${icon('play', 14)} 开始 / 继续</button>
            <button class="btn small ghost" type="button" data-action="plan" ${ACTIVE.has(run.status) ? 'disabled' : ''}>重新 LLM 分镜</button>
            <button class="btn small danger" type="button" data-action="cancel" ${ACTIVE.has(run.status) ? '' : 'disabled'}>取消</button>
          </div>
          <p class="mini">重试中间帧会让之后的帧重新接力，这是接力链的设计。</p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>当前设置</h2></div>
        <div class="panel-body stack" style="gap:6px">
          <div class="row"><span class="mini">分镜</span><div class="spacer"></div><span class="badge">${escapeHtml((run.plan && run.plan.source) || '未分镜')}</span></div>
          <div class="row"><span class="mini">接力</span><div class="spacer"></div><span class="badge">${escapeHtml((run.settings && run.settings.relay) || 'chain')}</span></div>
          <div class="row"><span class="mini">背景</span><div class="spacer"></div><span class="badge">${escapeHtml((run.settings && run.settings.background) || 'auto')}</span></div>
          <div class="row"><span class="mini">步数 / CFG</span><div class="spacer"></div><span class="badge">${(run.settings && run.settings.steps) || '—'} / ${(run.settings && run.settings.cfg) || '—'}</span></div>
          <p class="mini">要改生成参数，请新建 run；提示词与单帧重试可以直接在当前 run 修改。</p>
        </div>
      </section>
      </div>
    `;
    this.el.center.innerHTML = `
      <div class="center-stack">
        <div id="chainStatus" class="status-strip"></div>
        <section class="panel player-surface">
          <div class="panel-head"><h2>逐帧预览</h2><span class="hint" id="chainPlayerHint"></span></div>
          <div class="panel-body"><div id="chainPlayer"></div></div>
        </section>
        <section class="panel track-surface">
          <div class="panel-head"><h2>帧与提示词</h2><div class="spacer"></div>
            <span class="hint" id="chainTrackHint"></span></div>
          <div class="panel-body"><div id="chainTrack"></div></div>
        </section>
        <details class="log-fold">
          <summary>运行日志 <span class="hint" id="chainLogHint"></span></summary>
          <div id="chainLog"></div>
        </details>
      </div>
    `;
    this.el.right.innerHTML = `
      <div class="rail-switch" data-role="rightSwitch">
        <button type="button" data-tab="inspect" class="active">帧检查</button>
        <button type="button" data-tab="export">导出</button>
      </div>
      <section class="panel rail-surface" style="flex:1;min-height:0;overflow-y:auto">
        <div id="chainRailBody" class="panel-body"></div>
      </section>
    `;
    this.player = new Player(this.el.center.querySelector('#chainPlayer'), {
      onIndex: (index) => this.selectFrame(index),
    });
    this.bindRun();
    this.refreshDynamic();
  }

  bindRun() {
    const switchRoot = this.el.right.querySelector('[data-role="rightSwitch"]');
    if (switchRoot) {
      $$('[data-tab]', switchRoot).forEach((button) => {
        button.addEventListener('click', () => this.setRightTab(button.dataset.tab));
      });
    }
    const newBtn = this.el.left.querySelector('[data-action="new"]');
    if (newBtn) newBtn.addEventListener('click', () => this.newRun());
    const reload = this.el.left.querySelector('[data-action="reload"]');
    if (reload) reload.addEventListener('click', () => this.reload());
    const start = this.el.left.querySelector('[data-action="start"]');
    if (start) start.addEventListener('click', () => this.start());
    const plan = this.el.left.querySelector('[data-action="plan"]');
    if (plan) plan.addEventListener('click', () => this.plan());
    const cancel = this.el.left.querySelector('[data-action="cancel"]');
    if (cancel) cancel.addEventListener('click', () => this.cancel());
    const edit = this.el.left.querySelector('[data-action="editPrompts"]');
    if (edit) edit.addEventListener('click', () => this.openPromptsModal());
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
    const hint = this.el.center.querySelector('#chainTrackHint');
    if (hint) hint.textContent = `${frames.length} 帧 · ${(run.plan && run.plan.source) || '未分镜'}`;
    const playerHint = this.el.center.querySelector('#chainPlayerHint');
    if (playerHint) playerHint.textContent = `${run.acceptedCount || 0}/${run.frameCount || frames.length} 帧通过`;

    mountTrack(this.el.center.querySelector('#chainTrack'), run, {
      selected: this.state.selected,
      onSelect: (index) => this.selectFrame(index),
      onHold: (index, delta) => this.changeHold(index, delta),
      onReorder: null,
    });
    this.renderRight();
    const log = this.el.center.querySelector('#chainLog');
    if (log) log.innerHTML = logPanel(run.log || []);
    const logHint = this.el.center.querySelector('#chainLogHint');
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
    const body = this.el.right.querySelector('#chainRailBody');
    if (!body || !this.state.run) return;
    if (this.state.rightTab === 'export') {
      mountExportPanel(body, this.state.run, this.ctx.options, this.state, {
        onExport: (values) => this.exportRun(values),
      });
      return;
    }
    if (document.activeElement && body.contains(document.activeElement)) return;
    mountInspector(body, this.state.run, this.state.selected, {
      onSavePrompt: (index, prompt) => this.savePrompt(index, prompt),
      onRetry: (index, payload) => this.retryFrame(index, payload),
    });
  }

  renderStatus() {
    const host = this.el.center.querySelector('#chainStatus');
    if (!host) return;
    const run = this.state.run;
    const progress = progressOf(run);
    const active = ACTIVE.has(run.status);
    host.innerHTML = `
      ${runStatusBadge(run.status)}
      <div class="status-strip-main">
        <div class="status-strip-line">
          <strong title="${escapeHtml(progress.message)}">${escapeHtml(progress.message)}</strong>
          <span>${progress.accepted}/${progress.total} 帧 · ${progress.percent}%</span>
        </div>
        <div class="progress-bar"><span style="width:${progress.percent}%"></span></div>
      </div>
      <div class="row" style="gap:6px">
        ${active
          ? `<button class="btn small danger" type="button" data-action="cancel" title="取消">${icon('close', 13)}</button>`
          : `<button class="btn small primary" type="button" data-action="start" title="开始 / 继续" ${run.canStart ? '' : 'disabled'}>${icon('play', 13)}</button>
             <button class="btn small subtle" type="button" data-action="reload" title="刷新">${icon('refresh', 13)}</button>`}
        <button class="btn small ${run.canExport ? 'primary' : 'ghost'}" type="button" data-action="openExport">${icon('download', 13)} 导出</button>
      </div>
    `;
    const cancel = host.querySelector('[data-action="cancel"]');
    if (cancel) cancel.addEventListener('click', () => this.cancel());
    const start = host.querySelector('[data-action="start"]');
    if (start) start.addEventListener('click', () => this.start());
    const reload = host.querySelector('[data-action="reload"]');
    if (reload) reload.addEventListener('click', () => this.reload());
    const openExport = host.querySelector('[data-action="openExport"]');
    if (openExport) openExport.addEventListener('click', () => this.setRightTab('export'));
  }

  selectFrame(index) {
    this.state.selected = index;
    const run = this.state.run;
    if (!run) return;
    this.player.setIndex(index);
    mountTrack(this.el.center.querySelector('#chainTrack'), run, {
      selected: index,
      onSelect: (next) => this.selectFrame(next),
      onHold: (frameIndex, delta) => this.changeHold(frameIndex, delta),
      onReorder: null,
    });
    this.renderRight();
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
        if (error.status === 404) { this.newRun(); return; }
      }
      const active = this.state.run && ACTIVE.has(this.state.run.status);
      this.state.poll = setTimeout(tick, active ? 1200 : 5000);
    };
    this.state.poll = setTimeout(tick, 1200);
  }

  /* ------------------------------------------------------------ 操作 */

  async start() {
    if (!this.state.runId) return;
    try {
      this.state.run = await api.start(this.state.runId);
      this.refreshDynamic();
      this.startPoll();
      toast('开始接力生成', 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async plan() {
    if (!this.state.runId) return;
    const ok = await confirmDialog({
      title: '重新生成分镜？',
      message: '已有帧与生成结果会保留，但分镜与提示词会被新结果覆盖。',
      confirmText: '重新分镜',
    });
    if (!ok) return;
    try {
      this.state.run = await api.plan(this.state.runId);
      this.refreshDynamic();
      this.startPoll();
      toast('LLM 正在拆分镜', 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  openPromptsModal() {
    const run = this.state.run;
    if (!run) return;
    const body = h('div', { class: 'stack' });
    body.innerHTML = `<label class="field"><span>手写提示词（每行一条）</span>
      <textarea class="textarea" name="prompts" rows="12">${escapeHtml((run.frames || []).map((frame) => frame.prompt).join('\n'))}</textarea>
    </label>
    <p class="mini">保存后会重建帧清单；已生成的结果会被清空，需要重新开始生成。</p>`;
    const footer = h('div', { class: 'row', style: 'width:100%;justify-content:flex-end' });
    footer.innerHTML = `<button class="btn ghost" type="button" data-action="cancel">取消</button>
      <button class="btn primary" type="button" data-action="save">保存分镜</button>`;
    const modal = openModal({ title: '手写分镜', sub: '不会调用 LLM，也不会改写提示词', body, footer });
    footer.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
    footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const text = body.querySelector('[name="prompts"]').value;
      const prompts = text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (prompts.length < 2) { toast('至少需要 2 条提示词', 'warn'); return; }
      try {
        this.state.run = await api.setPrompts(run.id, prompts);
        modal.close();
        this.refreshDynamic();
        toast('已保存手写分镜', 'success');
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  async savePrompt(index, prompt) {
    try {
      this.state.run = await api.patchFrame(this.state.runId, index, { prompt });
      this.refreshDynamic();
      toast('提示词已保存', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async retryFrame(index, payload) {
    const run = this.state.run;
    if (!run) return;
    if (run.status === 'running') { toast('正在生成中，请稍候', 'warn'); return; }
    const body = typeof payload === 'string' ? { prompt: payload } : (payload || {});
    try {
      this.state.run = await api.retryFrame(run.id, index, body);
      this.refreshDynamic();
      this.startPoll();
      toast(`第 ${index} 帧开始重试`, 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async changeHold(index, delta) {
    const run = this.state.run;
    const frames = run && run.frames || [];
    if (!frames.length) return;
    const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
    const next = [];
    for (let i = 0; i < frames.length; i += 1) next.push(Math.max(1, num(holds[i], 1)));
    next[index - 1] = clamp((next[index - 1] || 1) + delta, 1, 6);
    try {
      this.state.run = await api.patchTimeline(run.id, { holds: next });
      this.refreshDynamic();
    } catch (error) { toast(error.message, 'error'); }
  }

  async exportRun(values) {
    const run = this.state.run;
    if (!run) return;
    if (!run.canExport) { toast('还有帧未通过，无法导出', 'warn'); return; }
    this.ctx.store.setPrefs('chain.export', this.state.export);
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
