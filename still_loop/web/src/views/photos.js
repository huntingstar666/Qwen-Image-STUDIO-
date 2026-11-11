/** 定格工坊：多图上传 / 素材仓库多选 → 轨道编排 → AI 精修 → GIF / 定格导出。 */
import { api } from '../api.js';
import {
  $, $$, h, escapeHtml, icon, toast, confirmDialog, clamp, num, readForm,
  selectField, numberField, checkField, syncRangeLabels, runStatusBadge,
} from '../ui.js';
import {
  Player, openLibraryPicker, mountTrack, mountInspector, mountExportPanel,
  exportDefaults, progressOf, stepStrip, logPanel, runMetaLine,
} from '../components.js';
import {
  defaultsFromOptions, canvasFields, bindCanvas, modelFields, readSettings,
  pageHead, emptyState, featureCard,
  settingRow, stepper, advancedCard, engineLabel, modelLabel, bindSettingRows,
  paramPill, canvasSummary, bindDrawer,
} from './common.js';

const ACTIVE = new Set(['planning', 'running', 'exporting']);

export class PhotosView {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.state = {
      runId: ctx.store.get('photos'),
      run: null,
      selected: 1,
      drafts: {},
      files: [],
      materialItems: [],
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
    this.state.export = this.ctx.store.prefs('photos.export', exportDefaults(this.ctx.options));
    this.render();
    this.loadRun();
  }

  unmount() {
    clearTimeout(this.state.poll);
    if (this.player) this.player.destroy();
    this.revokeStaged();
  }

  revokeStaged() {
    for (const item of this.state.files) {
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    }
  }

  /* ------------------------------------------------------------ 页面骨架 */

  render() {
    const run = this.state.run;
    const actions = `
      <button class="btn ghost" type="button" data-action="new">${icon('plus', 15)} 新建轨道</button>
      <button class="btn ghost" type="button" data-action="library">${icon('archive', 15)} 素材仓库</button>
      <button class="btn primary" type="button" data-action="pick">${icon('upload', 15)} 上传照片</button>
    `;
    this.root.innerHTML = `<div class="page page-host${run ? ' page-workspace' : ' setup-page'}">
      ${pageHead({
        kicker: '创作 / 定格工坊',
        title: '定格工坊',
        sub: '照片轨道 · 逐帧编排 · 定格成片；支持素材仓库多选与 AI 精修。',
        actions,
      })}
      ${run
        ? `<div class="work-grid">
            <div class="col col-left" data-role="left"></div>
            <div class="col col-center" data-role="center"></div>
            <div class="col col-right" data-role="right"></div>
          </div>`
        : `<div data-role="left"></div>`}
      <input type="file" id="photoFileInput" accept="image/*" multiple hidden>
    </div>`;
    this.el = {
      left: this.root.querySelector('[data-role="left"]'),
      center: this.root.querySelector('[data-role="center"]'),
      right: this.root.querySelector('[data-role="right"]'),
      file: this.root.querySelector('#photoFileInput'),
    };
    this.bindShell();
    if (run) this.renderRun();
    else this.renderSetup();
  }

  bindShell() {
    const pageActions = this.root.querySelector('.page-actions');
    $$('[data-action]', pageActions || this.root).forEach((button) => {
      const action = button.dataset.action;
      if (action === 'pick') button.addEventListener('click', () => this.el.file.click());
      if (action === 'new') button.addEventListener('click', () => this.newTrack());
      if (action === 'library') button.addEventListener('click', () => this.openLibrary());
    });
    this.el.file.addEventListener('change', (event) => this.addFiles(Array.from(event.target.files || [])));
  }

  /* ------------------------------------------------------------ 新建轨道 */

  renderSetup() {
    const form = this.state.form;
    this.el.left.innerHTML = `
      <div class="bench" data-role="workbench">
        <main class="bench-main">
          <section class="panel bench-stage">
            <div class="panel-head">
              <h2>素材</h2>
              <span class="hint" id="photoStageHint"></span>
              <div class="spacer"></div>
              <button class="btn small ghost" type="button" data-action="clearStaged">清空</button>
            </div>
            <div class="panel-body">
              <div class="bench-stage-host" id="photoSetupStage"></div>
              <div id="photoStaged" class="stack" style="gap:6px"></div>
            </div>
          </section>
          <div class="bench-bar">
            <div class="bench-pills">
              ${paramPill({ key: 'size', label: '尺寸', value: canvasSummary(this.ctx.options, form) })}
              ${paramPill({ key: 'fps', label: '帧率', value: `${form.fps} fps` })}
              ${paramPill({ key: 'hold', label: '停格', value: `${form.hold} 帧` })}
              <button class="param-pill gear" type="button" data-drawer-open aria-expanded="false">
                ${icon('settings', 13)} 参数
              </button>
            </div>
            <div class="bench-cta">
              <input class="input" id="photoName" placeholder="轨道名称（可选）">
              <button class="btn primary" type="button" data-action="create" disabled>${icon('film', 15)} 创建轨道</button>
            </div>
          </div>
        </main>
        <aside class="bench-drawer" data-role="drawer">
          <div class="drawer-head">
            <span>参数</span>
            <button class="drawer-close" type="button" data-drawer-close aria-label="收起参数">${icon('close', 12)}</button>
          </div>
          <section class="panel" id="photoSettings">
            <div class="panel-head"><h2>画布与节奏</h2></div>
            <div class="panel-body">
              ${canvasFields(this.ctx.options, form)}
              <div class="set-list">
                ${settingRow({
                  label: '默认停格', hint: '每张照片在成片里停留多久',
                  control: stepper({ name: 'hold', value: form.hold, min: 1, max: 6, unit: '帧' }),
                })}
              </div>
              ${advancedCard({
                meta: `${engineLabel(this.ctx.options, form.engine)} · ${modelLabel(this.ctx.options, form.model)}`,
                content: `<div class="stack">
                  ${modelFields(this.ctx.options, form)}
                  <div class="set-list">
                    ${settingRow({
                      label: '失败重试', hint: '单帧生成失败后的重试次数',
                      control: stepper({ name: 'max_retries', value: form.max_retries, min: 1, max: 5, unit: '次' }),
                    })}
                  </div>
                </div>`,
              })}
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>说明</h2></div>
            <div class="panel-body setup-features">
              <div class="setup-feature"><span class="feature-icon">${icon('layers', 15)}</span><div><strong>轨道编排</strong><span>逐帧调停格、拖动重排，随时删除或恢复原图。</span></div></div>
              <div class="setup-feature"><span class="feature-icon">${icon('spark', 15)}</span><div><strong>AI 精修</strong><span>黏土 / 纸偶 / 毛毡 / 积木质感，只改材质不改内容。</span></div></div>
              <div class="setup-feature"><span class="feature-icon">${icon('film', 15)}</span><div><strong>双版本成片</strong><span>一次导出顺滑版与定格版，支持 GIF / WebP / MP4 / WebM。</span></div></div>
              <div class="notice">${icon('info', 15)}<span>照片轨道不需要 GPU；只有「AI 精修」会调用主项目 /api/edit。</span></div>
            </div>
          </section>
        </aside>
      </div>
    `;
    this.bindSetup();
    this.renderStaged();
  }

  renderSetupStage() {
    const host = this.root && this.root.querySelector('#photoSetupStage');
    if (!host) return;
    const total = this.state.files.length + this.state.materialItems.length;
    const hint = this.root.querySelector('#photoStageHint');
    if (hint) hint.textContent = total ? `${total} 张 · 按选择顺序` : '';
    if (!total) {
      host.innerHTML = `<div class="dropzone" data-role="photoDrop">
        <div class="drop-empty">
          <span class="drop-icon">${icon('upload', 18)}</span>
          <strong>拖入一组照片开始</strong>
          <span>也可以从素材仓库多选</span>
        </div>
      </div>`;
      this.bindDropzones();
      return;
    }
    const first = this.state.files.length
      ? this.state.files[0].objectUrl
      : (this.state.materialItems[0].url || this.state.materialItems[0].thumbUrl);
    host.innerHTML = `<div class="stage-preview">
      <img src="${escapeHtml(first)}" alt="轨道第一帧预览">
      <div class="stage-meta">
        <span class="badge info">${total} 张</span>
        <span class="mini">按选择顺序铺入轨道，创建后可逐帧调整</span>
      </div>
    </div>`;
  }

  bindDropzones() {
    $$('[data-role="photoDrop"]', this.root).forEach((drop) => {
      if (drop.dataset.bound) return;
      drop.dataset.bound = '1';
      drop.addEventListener('click', () => this.el.file.click());
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('drag');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('drag');
        this.addFiles(Array.from(event.dataTransfer.files || []));
      });
    });
  }

  bindSetup() {
    this.bindDropzones();
    bindCanvas(this.root);
    bindSettingRows(this.root);
    syncRangeLabels(this.root);
    bindDrawer(this.root);
    $$('[data-action="library"]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => this.openLibrary());
    });
    $$('[data-action="clearStaged"]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => {
        this.revokeStaged();
        this.state.files = [];
        this.state.materialItems = [];
        this.renderStaged();
      });
    });
    const create = this.el.left.querySelector('[data-action="create"]');
    if (create) create.addEventListener('click', () => this.createTrack());
    $$('[data-action="pick"]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => this.el.file.click());
    });
  }

  addFiles(files) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    // 本地照片与素材仓库在创建时走两条不同接口，只能二选一；
    // 已有素材选择时先确认，避免静默清空用户已挑好的图。
    if (this.state.materialItems.length) {
      confirmDialog({
        title: '改用本地照片？',
        message: `已从素材仓库选了 ${this.state.materialItems.length} 张，加入本地照片会清空这些选择。`,
        confirmText: '清空并加入',
      }).then((ok) => {
        if (!ok) return;
        this.state.materialItems = [];
        this.pushFiles(images);
      });
      return;
    }
    this.pushFiles(images);
  }

  pushFiles(images) {
    for (const file of images) {
      this.state.files.push({ file, name: file.name, objectUrl: URL.createObjectURL(file) });
    }
    this.renderStaged();
    toast(`已加入 ${images.length} 张照片`, 'info');
  }

  renderStaged() {
    const host = this.el.left && this.el.left.querySelector('#photoStaged');
    if (!host) return;
    const files = this.state.files;
    const materials = this.state.materialItems;
    const total = files.length + materials.length;
    host.innerHTML = `
      ${files.length ? `<div class="mini">本地照片 ${files.length} 张</div>
        <div class="row wrap" style="gap:6px">
          ${files.map((item, index) => `<div class="library-card" style="width:64px;border-radius:8px">
            <div class="library-thumb"><img src="${item.objectUrl}" alt="${escapeHtml(item.name)}"></div>
            <button class="modal-close" type="button" data-remove-file="${index}"
              style="position:absolute;right:2px;top:2px;width:18px;height:18px;background:rgba(23,26,30,.6);color:#fff">${icon('close', 10)}</button>
          </div>`).join('')}
        </div>` : ''}
      ${materials.length ? `<div class="mini">素材仓库 ${materials.length} 张（按选择顺序）</div>
        <div class="row wrap" style="gap:6px">
          ${materials.map((item, index) => `<div class="library-card" style="width:64px;border-radius:8px">
            <div class="library-thumb"><img src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(item.title)}"></div>
            <span class="library-order">${index + 1}</span>
          </div>`).join('')}
        </div>` : ''}
    `;
    $$('[data-remove-file]', host).forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.removeFile);
        const item = this.state.files[index];
        if (item && item.objectUrl) URL.revokeObjectURL(item.objectUrl);
        this.state.files.splice(index, 1);
        this.renderStaged();
      });
    });
    const create = this.el.left.querySelector('[data-action="create"]');
    if (create) create.disabled = !total || this.state.busy;
    const clear = this.el.left.querySelector('[data-action="clearStaged"]');
    if (clear) clear.hidden = !total;
    this.renderSetupStage();
  }

  openLibrary() {
    const open = () => openLibraryPicker({
      title: '从素材仓库导入',
      sub: '多选后按点击顺序铺入轨道；素材来自主项目 8700',
      onConfirm: (items) => {
        this.state.materialItems = items;
        this.state.files = [];
        this.renderStaged();
        toast(`已选择 ${items.length} 张素材`, 'info');
      },
    });
    if (!this.state.files.length) { open(); return; }
    confirmDialog({
      title: '改用素材仓库？',
      message: `已加入本地照片 ${this.state.files.length} 张，从素材仓库导入会清空这些照片。`,
      confirmText: '清空并继续',
    }).then((ok) => { if (ok) open(); });
  }

  async createTrack() {
    if (this.state.busy) return;
    const hasFiles = this.state.files.length;
    const hasMaterials = this.state.materialItems.length;
    if (!hasFiles && !hasMaterials) { toast('请先选择照片或素材', 'warn'); return; }
    const settingsRoot = this.root.querySelector('#photoSettings');
    const settings = readSettings(settingsRoot, this.ctx.options, this.state.form);
    const nameInput = this.root.querySelector('#photoName');
    const name = nameInput ? nameInput.value.trim() : '';
    this.state.busy = true;
    this.renderStaged();
    try {
      let run;
      if (hasFiles) {
        run = await api.importPhotos(this.state.files.map((item) => item.file), settings, [], name);
      } else {
        run = await api.fromMaterials(this.state.materialItems.map((item) => item.id), settings, [], name);
      }
      this.revokeStaged();
      this.state.files = [];
      this.state.materialItems = [];
      this.state.run = run;
      this.state.runId = run.id;
      this.state.selected = 1;
      this.ctx.store.set('photos', run.id);
      this.render();
      this.startPoll();
      toast(`轨道已创建：${run.frameCount} 帧`, 'success');
    } catch (error) {
      toast(error.message || '创建轨道失败', 'error');
    } finally {
      this.state.busy = false;
      const create = this.el.left && this.el.left.querySelector('[data-action="create"]');
      if (create) create.disabled = true;
    }
  }

  newTrack() {
    this.ctx.store.clear('photos');
    clearTimeout(this.state.poll);
    this.state.run = null;
    this.state.runId = '';
    this.state.selected = 1;
    this.render();
  }

  /* ------------------------------------------------------------ 已有轨道 */

  async loadRun() {
    if (!this.state.runId) return;
    try {
      const run = await api.getRun(this.state.runId);
      this.state.run = run;
      this.state.selected = clamp(this.state.selected, 1, Math.max(1, run.frameCount || 1));
      this.render();
      this.startPoll();
    } catch (error) {
      this.ctx.store.clear('photos');
      this.state.runId = '';
      this.state.run = null;
      this.render();
      if (error.status !== 404) toast(error.message, 'error');
    }
  }

  renderRun() {
    const run = this.state.run;
    const form = defaultsFromOptions(this.ctx.options);
    // 用服务端已保存的设置回填表单，避免刷新后画布/引擎跳回默认。
    const settings = run.settings || {};
    const width = num(settings.width, form.width);
    const height = num(settings.height, form.height);
    form.width = width;
    form.height = height;
    form.canvas = this.ctx.options && this.ctx.options.canvas
      ? (this.ctx.options.canvas.find((item) => item.width === width && item.height === height) || {}).id || 'custom'
      : 'custom';
    form.fps = num(settings.timeline && settings.timeline.fps, form.fps);
    form.steps = num(settings.steps, form.steps);
    form.cfg = num(settings.cfg, form.cfg);
    form.engine = settings.engine || 'mock';
    form.model = settings.model || form.model;
    form.preset = settings.preset || '';
    form.style = settings.style || '';
    form.max_retries = num(settings.max_retries, form.max_retries);
    form.hold = num(settings.motion && settings.motion.hold, form.hold);
    form.exportFormat = (settings.export && settings.export.format) || form.exportFormat;
    this.state.form = form;

    this.el.left.innerHTML = `
      <div class="rail-surface">
      <section class="panel">
        <div class="panel-head"><h2>当前轨道</h2><div class="spacer"></div><span data-role="leftRunBadge">${runStatusBadge(run.status)}</span></div>
        <div class="panel-body stack" style="gap:8px">
          <strong style="font-size:13px">${escapeHtml(run.name || run.idea || '未命名轨道')}</strong>
          <div class="row wrap"><span class="badge" data-role="leftRunMeta">${escapeHtml(runMetaLine(run))}</span>
            <span class="badge">${width}×${height}</span></div>
          <div class="row wrap" style="margin-top:2px">
            <button class="btn small ghost" type="button" data-action="new">${icon('plus', 13)} 新建</button>
            <button class="btn small subtle" type="button" data-action="libraryNew">${icon('archive', 13)} 素材新建</button>
            <button class="btn small ghost" type="button" data-action="reload">${icon('refresh', 13)} 刷新</button>
          </div>
        </div>
      </section>
      <div class="stack" id="photoSettings">
      <details class="fold">
        <summary>画布与节奏</summary>
        <div style="margin-top:10px">
          ${canvasFields(this.ctx.options, form)}
          <div class="set-list">
            ${settingRow({
              label: '默认停格', hint: '成片里的停留时间',
              control: stepper({ name: 'hold', value: form.hold, min: 1, max: 6, unit: '帧' }),
            })}
            ${settingRow({
              label: '应用到全部', hint: '批量覆盖每帧',
              control: `<div class="chips">
                <button class="chip" type="button" data-hold-all="1">1</button>
                <button class="chip" type="button" data-hold-all="2">2</button>
                <button class="chip" type="button" data-hold-all="3">3</button>
              </div>`,
            })}
          </div>
        </div>
      </details>
      <section class="panel">
        <div class="panel-head"><h2>AI 精修</h2><span class="badge experiment">实验性</span></div>
        <div class="panel-body stack">
          <div class="notice">${icon('info', 15)}<span>逐帧独立编辑，结果尚不稳定；每帧都可单独改词、重跑或恢复原图。</span></div>
          <details class="fold">
            <summary>精修参数</summary>
            <div class="stack" style="margin-top:10px">
              ${modelFields(this.ctx.options, form)}
              <div class="field-grid three">
                ${numberField({ name: 'steps', label: '步数', value: form.steps, min: 1, max: 100 })}
                ${numberField({ name: 'cfg', label: 'CFG', value: form.cfg, min: 0, max: 30, step: 0.1 })}
                ${numberField({ name: 'max_retries', label: '重试', value: form.max_retries, min: 1, max: 5 })}
              </div>
            </div>
          </details>
          <label class="field"><span>统一提示词（留空则用每帧自己的）</span>
            <textarea class="textarea" name="pipelinePrompt" rows="3"
              placeholder="例如：保持构图与内容不变，统一为细腻的黏土定格动画质感"></textarea>
          </label>
          <div class="row wrap">
            <button class="btn primary small" type="button" data-action="runAll">${icon('spark', 14)} 精修全部帧</button>
            <button class="btn small ghost" type="button" data-action="runSelected" ${run.canPipeline ? '' : 'disabled'}>精修选中帧</button>
          </div>
        </div>
      </section>
      </div>
      </div>
    `;

    this.el.center.innerHTML = `
      <div class="center-stack">
        <div id="photoStatus" class="status-strip"></div>
        <section class="panel player-surface">
          <div class="panel-head"><h2>逐帧预览</h2><span class="hint" id="photoPlayerHint"></span></div>
          <div class="panel-body"><div id="photoPlayer"></div></div>
        </section>
        <section class="panel track-surface">
          <div class="panel-head"><h2>轨道</h2><div class="spacer"></div>
            <span class="hint" id="photoTrackHint"></span></div>
          <div class="panel-body"><div id="photoTrack"></div></div>
        </section>
        <details class="log-fold">
          <summary>运行日志 <span class="hint" id="photoLogHint"></span></summary>
          <div id="photoLog"></div>
        </details>
      </div>
    `;
    this.el.right.innerHTML = `
      <div class="rail-switch" data-role="rightSwitch">
        <button type="button" data-tab="inspect" class="active">帧检查</button>
        <button type="button" data-tab="export">导出</button>
      </div>
      <section class="panel rail-surface" style="flex:1;min-height:0;overflow-y:auto">
        <div id="photoRailBody" class="panel-body"></div>
      </section>
    `;
    this.player = new Player(this.el.center.querySelector('#photoPlayer'), {
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
    const reload = this.el.left.querySelector('[data-action="reload"]');
    if (reload) reload.addEventListener('click', () => this.reload());
    const newBtn = this.el.left.querySelector('[data-action="new"]');
    if (newBtn) newBtn.addEventListener('click', () => this.newTrack());
    const libNew = this.el.left.querySelector('[data-action="libraryNew"]');
    if (libNew) {
      libNew.addEventListener('click', () => {
        openLibraryPicker({
          title: '从素材仓库新建轨道',
          onConfirm: (items) => this.createFromMaterials(items),
        });
      });
    }
    const fps = this.el.left.querySelector('[name="fps"]');
    if (fps) {
      fps.addEventListener('change', async () => {
        try {
          await api.patchTimeline(this.state.runId, { fps: num(fps.value, 12) });
          await this.reload();
        } catch (error) { toast(error.message, 'error'); }
      });
    }
    $$('[data-hold-all]', this.el.left).forEach((button) => {
      button.addEventListener('click', () => this.applyAllHolds(Number(button.dataset.holdAll)));
    });
    const runAll = this.el.left.querySelector('[data-action="runAll"]');
    if (runAll) runAll.addEventListener('click', () => this.runPipeline(null));
    const runSelected = this.el.left.querySelector('[data-action="runSelected"]');
    if (runSelected) runSelected.addEventListener('click', () => this.runPipeline([this.state.selected]));
  }

  async createFromMaterials(items) {
    if (!items.length) return;
    const settingsRoot = this.el.left.querySelector('#photoSettings');
    const settings = readSettings(settingsRoot, this.ctx.options, this.state.form);
    try {
      const run = await api.fromMaterials(items.map((item) => item.id), settings, [], '');
      this.state.run = run;
      this.state.runId = run.id;
      this.state.selected = 1;
      this.ctx.store.set('photos', run.id);
      this.render();
      this.startPoll();
      toast(`轨道已创建：${run.frameCount} 帧`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
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

    const trackHint = this.el.center.querySelector('#photoTrackHint');
    if (trackHint) {
      const fps = num(run.settings && run.settings.timeline && run.settings.timeline.fps, 12);
      const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
      const total = frames.reduce((sum, _f, i) => sum + Math.max(1, num(holds[i], 2)) / fps, 0);
      trackHint.textContent = `${frames.length} 帧 · ${total.toFixed(2)}s @ ${fps}fps`;
    }
    const playerHint = this.el.center.querySelector('#photoPlayerHint');
    if (playerHint) playerHint.textContent = `${run.acceptedCount || 0}/${run.frameCount || frames.length} 帧就绪`;

    mountTrack(this.el.center.querySelector('#photoTrack'), run, {
      selected: this.state.selected,
      onSelect: (index) => this.selectFrame(index),
      onHold: (index, delta) => this.changeHold(index, delta),
      onReorder: (from, to) => this.reorder(from, to),
    });

    this.renderRight();

    const log = this.el.center.querySelector('#photoLog');
    if (log) log.innerHTML = logPanel(run.log || []);
    const logHint = this.el.center.querySelector('#photoLogHint');
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
    const body = this.el.right.querySelector('#photoRailBody');
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
    const host = this.el.center.querySelector('#photoStatus');
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

  selectFrame(index) {
    this.state.selected = index;
    const run = this.state.run;
    if (!run) return;
    this.player.setIndex(index);
    mountTrack(this.el.center.querySelector('#photoTrack'), run, {
      selected: index,
      onSelect: (next) => this.selectFrame(next),
      onHold: (frameIndex, delta) => this.changeHold(frameIndex, delta),
      onReorder: (from, to) => this.reorder(from, to),
    });
    this.renderRight();
  }

  async reload() {
    if (!this.state.runId) return;
    try {
      const run = await api.getRun(this.state.runId);
      this.state.run = run;
      this.refreshDynamic();
    } catch (error) {
      toast(error.message, 'error');
    }
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
        if (error.status === 404) {
          this.newTrack();
          return;
        }
      }
      const active = this.state.run && ACTIVE.has(this.state.run.status);
      this.state.poll = setTimeout(tick, active ? 1200 : 5000);
    };
    this.state.poll = setTimeout(tick, 1200);
  }

  /* ------------------------------------------------------------ 轨道操作 */

  async changeHold(index, delta) {
    const run = this.state.run;
    if (!run) return;
    const frames = run.frames || [];
    const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
    const next = [];
    for (let i = 0; i < frames.length; i += 1) next.push(Math.max(1, num(holds[i], num(run.settings.motion.hold, 2))));
    next[index - 1] = clamp((next[index - 1] || 1) + delta, 1, 6);
    try {
      const updated = await api.patchTimeline(run.id, { holds: next });
      this.state.run = updated;
      this.refreshDynamic();
    } catch (error) { toast(error.message, 'error'); }
  }

  async applyAllHolds(value) {
    const run = this.state.run;
    if (!run) return;
    const holds = new Array((run.frames || []).length).fill(value);
    try {
      this.state.run = await api.patchTimeline(run.id, { holds });
      this.refreshDynamic();
      toast(`全部帧已设为 ${value} 格`, 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async reorder(from, to) {
    const run = this.state.run;
    if (!run) return;
    const order = (run.frames || []).map((frame) => Number(frame.index));
    const fromIndex = order.indexOf(from);
    const toIndex = order.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    order.splice(toIndex, 0, order.splice(fromIndex, 1)[0]);
    try {
      this.state.run = await api.reorderFrames(run.id, order);
      this.state.drafts = {};
      this.refreshDynamic();
    } catch (error) { toast(error.message, 'error'); }
  }

  async moveFrame(index, delta) {
    const run = this.state.run;
    if (!run) return;
    const target = index + delta;
    if (target < 1 || target > (run.frames || []).length) return;
    await this.reorder(index, target);
  }

  async deleteFrame(index) {
    const ok = await confirmDialog({
      title: '删除这一帧？',
      message: `第 ${index} 帧会从轨道中移除，后续帧自动前移。原图文件仍保留在运行目录。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      this.state.run = await api.deleteFrame(this.state.runId, index);
      this.state.drafts = {};
      this.refreshDynamic();
      toast('已删除一帧', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async savePrompt(index, prompt) {
    try {
      this.state.run = await api.patchFrame(this.state.runId, index, { prompt });
      this.refreshDynamic();
      toast('提示词已保存', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  /* 参考框草稿：照片轨道默认把本帧放进画布，用户可自由增删。 */
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
      toast(`第 ${index} 帧开始${label}`, 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async restoreFrame(index) {
    try {
      this.state.run = await api.restoreFrame(this.state.runId, index);
      this.refreshDynamic();
      toast('已恢复原图', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async runPipeline(indexes) {
    const run = this.state.run;
    if (!run) return;
    if (run.status === 'running') { toast('正在精修中', 'warn'); return; }
    const settingsRoot = this.el.left.querySelector('#photoSettings');
    const settings = readSettings(settingsRoot, this.ctx.options, this.state.form);
    const promptEl = settingsRoot.querySelector('[name="pipelinePrompt"]');
    const template = promptEl ? promptEl.value.trim() : '';
    const payload = { settings };
    if (indexes && indexes.length) payload.indexes = indexes;
    if (template) {
      if (indexes && indexes.length === 1) {
        payload.prompts = { [indexes[0]]: template };
      } else {
        payload.prompts = (run.frames || []).map(() => template);
      }
    }
    try {
      this.state.run = await api.runPipeline(run.id, payload);
      this.refreshDynamic();
      this.startPoll();
      toast(indexes ? '开始精修选中帧' : `开始精修 ${run.frameCount} 帧`, 'info');
    } catch (error) { toast(error.message, 'error'); }
  }

  async exportRun(values) {
    const run = this.state.run;
    if (!run) return;
    if (!run.canExport) { toast('还有帧未通过，无法导出', 'warn'); return; }
    this.ctx.store.setPrefs('photos.export', this.state.export);
    const timeline = {
      fps: values.fps,
      holds: (run.settings && run.settings.timeline && run.settings.timeline.holds) || [],
    };
    const motion = {
      preset: values.preset,
      fps: values.motionFps,
      jitter: values.jitter,
      grain: values.grain,
      vignette: values.vignette,
      color_boil: values.colorBoil,
    };
    try {
      await api.approve(run.id).catch(() => {});
      this.state.run = await api.exportRun(run.id, values.fps, {
        format: values.format,
        align: values.align,
        color_match: values.colorMatch,
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
