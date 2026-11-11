/** 共享组件：播放器、素材选择器、轨道、检查器、导出面板。 */
import { api } from './api.js';
import {
  $, $$, h, escapeHtml, icon, toast, openModal, confirmDialog, clamp, num,
  RUN_STATUS, FRAME_STATUS, SOURCE_LABEL, runStatusBadge, frameStatusBadge,
  fmtDuration, fmtNumber, fmtClock, downloadFile, debounce, selectField,
  numberField, rangeField, checkField, syncRangeLabels,
} from './ui.js';

/* ================================================================
 * 播放器：逐帧预览 + 播放 / 暂停 + 进度点
 * ================================================================ */

export class Player {
  constructor(host, { onIndex } = {}) {
    this.host = host;
    this.onIndex = onIndex;
    this.run = null;
    this.index = 1;
    this.playing = false;
    this.timer = 0;
    this.signatureKey = '';
    this.refs = null;
  }

  setRun(run, index) {
    const same = this.run && run && this.run.id === run.id;
    this.run = run;
    const total = (run && run.frames && run.frames.length) || 0;
    if (typeof index === 'number') this.index = clamp(index, 1, Math.max(1, total));
    else if (!same) this.index = 1;
    if (total && this.index > total) this.index = total;
    this.sync();
  }

  setIndex(index, notify = false) {
    const total = (this.run && this.run.frames && this.run.frames.length) || 0;
    this.index = clamp(Number(index) || 1, 1, Math.max(1, total));
    this.paint();
    if (notify && this.onIndex) this.onIndex(this.index);
  }

  play() {
    if (this.playing) return;
    const frames = (this.run && this.run.frames) || [];
    if (frames.length < 2) return;
    this.playing = true;
    this.paint();
    this.tick();
  }

  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.paint();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  tick() {
    clearTimeout(this.timer);
    if (!this.playing) return;
    const run = this.run;
    const frames = (run && run.frames) || [];
    if (!frames.length) { this.pause(); return; }
    const fps = Math.max(1, num(run.settings && run.settings.timeline && run.settings.timeline.fps, 8));
    const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
    const hold = Math.max(1, num(holds[this.index - 1], 1));
    this.timer = setTimeout(() => {
      if (!this.playing) return;
      this.index = this.index >= frames.length ? 1 : this.index + 1;
      this.paint();
      this.tick();
    }, (hold / fps) * 1000);
  }

  /* 结构指纹：只有 run 或帧数变化才重建 DOM。
     播放时若每 tick 重建，按钮节点会被替换，按下/抬起落在不同节点导致 click 丢失，
     表现就是「播放按钮偶发关不掉」。 */
  signature() {
    const run = this.run;
    if (!run) return 'empty';
    const frames = run.frames || [];
    const reference = (run.reference && run.reference.previewUrl) || '';
    return `${run.id}|${frames.length}|${frames.map((frame) => frame.index).join(',')}|${reference}`;
  }

  sync() {
    const signature = this.signature();
    if (signature === this.signatureKey) {
      this.paint();
      return;
    }
    this.signatureKey = signature;
    this.build();
  }

  build() {
    const run = this.run;
    if (!run) {
      this.refs = null;
      this.host.innerHTML = `<div class="player"><div class="player-stage"><div class="player-empty">导入照片或生成分镜后，这里会显示逐帧预览。</div></div></div>`;
      return;
    }
    const frames = run.frames || [];
    const dots = frames.map((_item, i) => `<button type="button" class="scrub-dot" data-scrub="${i + 1}"></button>`).join('');
    this.host.innerHTML = `
      <div class="player">
        <div class="player-stage">
          <img data-role="shot" alt="" hidden>
          <div class="player-empty" data-role="empty" hidden>还没有可预览的帧</div>
          <span class="player-badge" data-role="badge"></span>
        </div>
        <div class="player-toolbar">
          <button type="button" class="player-play" data-player="toggle" aria-label="播放">
            <span data-role="toggleIcon"></span>
          </button>
          <div class="player-scrub">${dots || '<span class="mini">暂无帧</span>'}</div>
          <div class="player-meta">
            <span data-role="count"></span>
            <span data-role="fps"></span>
            <span data-role="dur"></span>
          </div>
        </div>
      </div>
    `;
    this.refs = {
      img: this.host.querySelector('[data-role="shot"]'),
      empty: this.host.querySelector('[data-role="empty"]'),
      badge: this.host.querySelector('[data-role="badge"]'),
      toggle: this.host.querySelector('[data-player="toggle"]'),
      toggleIcon: this.host.querySelector('[data-role="toggleIcon"]'),
      count: this.host.querySelector('[data-role="count"]'),
      fps: this.host.querySelector('[data-role="fps"]'),
      dur: this.host.querySelector('[data-role="dur"]'),
      dots: $$('[data-scrub]', this.host),
    };
    this.refs.toggle.addEventListener('click', () => this.toggle());
    this.refs.dots.forEach((dot) => {
      dot.addEventListener('click', () => this.setIndex(Number(dot.dataset.scrub), true));
    });
    this.paint();
  }

  /* 增量绘制：只改图片、角标、按钮图标与进度点状态，不动 DOM 结构。 */
  paint() {
    const refs = this.refs;
    const run = this.run;
    if (!refs || !run) return;
    const frames = run.frames || [];
    const frame = frames[this.index - 1] || null;
    const src = (frame && frame.previewUrl) || (run.reference && run.reference.previewUrl) || '';
    if (refs.img) {
      if (src) {
        if (refs.img.getAttribute('src') !== src) refs.img.setAttribute('src', src);
        refs.img.alt = `第 ${this.index} 帧`;
        refs.img.hidden = false;
      } else {
        refs.img.removeAttribute('src');
        refs.img.hidden = true;
      }
    }
    if (refs.empty) refs.empty.hidden = Boolean(src);
    if (refs.badge) {
      refs.badge.textContent = frame
        ? `#${String(frame.index).padStart(2, '0')} · ${(FRAME_STATUS[frame.status] || {}).label || frame.status}`
        : '参考图';
    }
    if (refs.toggleIcon) refs.toggleIcon.innerHTML = icon(this.playing ? 'pause' : 'play', 15);
    if (refs.toggle) {
      const label = this.playing ? '暂停' : '播放';
      refs.toggle.title = label;
      refs.toggle.setAttribute('aria-label', label);
    }
    refs.dots.forEach((dot) => {
      const order = Number(dot.dataset.scrub);
      dot.classList.toggle('active', order === this.index);
      const item = frames[order - 1];
      dot.title = item
        ? `第 ${item.index} 帧 · ${(FRAME_STATUS[item.status] || {}).label || item.status}`
        : `第 ${order} 帧`;
    });
    const fps = Math.max(1, num(run.settings && run.settings.timeline && run.settings.timeline.fps, 8));
    const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
    const totalMs = frames.reduce((sum, _item, i) => sum + Math.max(1, num(holds[i], 1)) / fps * 1000, 0);
    if (refs.count) refs.count.textContent = frames.length ? `${this.index} / ${frames.length}` : '0 / 0';
    if (refs.fps) refs.fps.textContent = `${fps}fps`;
    if (refs.dur) refs.dur.textContent = fmtDuration(totalMs);
  }

  destroy() {
    clearTimeout(this.timer);
    this.playing = false;
  }
}

/* ================================================================
 * 素材仓库选择器
 * ================================================================ */

export function openLibraryPicker({ onConfirm, title = '从素材仓库导入', sub = '多选后按点击顺序铺入轨道' } = {}) {
  const state = { items: [], selected: [], categories: [], category: '', q: '', loading: true, error: '' };
  const body = h('div', { class: 'stack' });
  const footer = h('div', { class: 'row', style: 'width:100%' });
  const count = h('span', { class: 'mini' });
  const spacer = h('div', { class: 'spacer' });
  const cancel = h('button', { class: 'btn ghost', type: 'button', text: '取消' });
  const confirm = h('button', { class: 'btn primary', type: 'button', text: '导入选中' });
  footer.append(count, spacer, cancel, confirm);
  const modal = openModal({ title, sub, body, footer });
  cancel.addEventListener('click', modal.close);
  confirm.addEventListener('click', () => {
    if (!state.selected.length) { toast('请先选择素材', 'warn'); return; }
    const chosen = state.selected
      .map((id) => state.items.find((item) => item.id === id))
      .filter(Boolean);
    modal.close();
    onConfirm(chosen);
  });

  const refreshFooter = () => {
    count.textContent = state.selected.length
      ? `已选 ${state.selected.length} 张，将按选择顺序导入`
      : '点击图片按顺序多选';
    confirm.textContent = state.selected.length ? `导入 ${state.selected.length} 张` : '导入选中';
    confirm.disabled = !state.selected.length || state.loading;
  };

  const render = () => {
    const categories = ['', ...state.categories];
    body.innerHTML = `
      <div class="library-toolbar">
        <div class="library-search">
          ${icon('search', 14)}
          <input class="input" data-role="q" placeholder="搜索素材标题、提示词、标签" value="${escapeHtml(state.q)}">
        </div>
        <div class="chips">
          ${categories.map((cat) => `<button type="button" class="chip${state.category === cat ? ' active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat || '全部')}</button>`).join('')}
        </div>
      </div>
      ${state.error ? `<div class="notice bad">${icon('alert', 15)}<span>${escapeHtml(state.error)}</span></div>` : ''}
      <div class="library-grid">
        ${state.loading ? '<div class="library-empty">正在读取主项目素材仓库…</div>' : ''}
        ${!state.loading && !state.items.length ? '<div class="library-empty">没有找到素材。可以在主项目「素材仓库」里收藏或上传图片。</div>' : ''}
        ${state.items.map((item) => {
          const order = state.selected.indexOf(item.id);
          return `<div class="library-card${order >= 0 ? ' selected' : ''}" data-id="${escapeHtml(item.id)}">
            <div class="library-thumb"><img src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(item.title)}" loading="lazy"></div>
            ${order >= 0 ? `<span class="library-order">${order + 1}</span>` : ''}
            <span class="library-check">${icon('check', 12)}</span>
            <div class="library-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title || '未命名素材')}</div>
          </div>`;
        }).join('')}
      </div>
    `;
    const search = body.querySelector('[data-role="q"]');
    if (search) {
      search.addEventListener('input', debounce((event) => {
        state.q = event.target.value.trim();
        load();
      }, 280));
    }
    $$('[data-cat]', body).forEach((chip) => {
      chip.addEventListener('click', () => {
        state.category = chip.dataset.cat;
        load();
      });
    });
    $$('.library-card', body).forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const index = state.selected.indexOf(id);
        if (index >= 0) state.selected.splice(index, 1);
        else state.selected.push(id);
        render();
        refreshFooter();
      });
    });
    refreshFooter();
  };

  const load = async () => {
    const search = body.querySelector('[data-role="q"]');
    const hadFocus = Boolean(search && document.activeElement === search);
    const caret = hadFocus ? search.selectionStart : null;
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await api.library({ category: state.category, q: state.q, limit: 160 });
      if (!data.ok) {
        state.error = data.error || '主项目素材仓库不可用';
        state.items = [];
        state.categories = [];
      } else {
        state.items = data.items || [];
        if (!state.categories.length) state.categories = data.categories || [];
        state.selected = state.selected.filter((id) => state.items.some((item) => item.id === id));
      }
    } catch (error) {
      state.error = error.message || '读取素材仓库失败';
      state.items = [];
    } finally {
      state.loading = false;
      render();
      if (hadFocus) {
        const next = body.querySelector('[data-role="q"]');
        if (next) {
          next.focus();
          if (caret != null) next.setSelectionRange(caret, caret);
        }
      }
    }
  };

  render();
  load();
}

/* ================================================================
 * 轨道
 * ================================================================ */

export function mountTrack(container, run, { selected, onSelect, onHold, onDelete, onMove, onReorder } = {}) {
  const frames = (run && run.frames) || [];
  if (!frames.length) {
    container.innerHTML = '<div class="empty-hint">还没有帧。导入照片或完成切分后，轨道会显示在这里。</div>';
    return;
  }
  const holds = (run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
  const fallbackHold = num(run.settings && run.settings.motion && run.settings.motion.hold, 2);
  container.innerHTML = `<div class="track">
    ${frames.map((frame, i) => {
      const src = frame.previewUrl || frame.acceptedPreviewUrl || '';
      const status = FRAME_STATUS[frame.status] || { label: frame.status, tone: '' };
      const hold = Math.max(1, num(holds[i], fallbackHold));
      return `<article class="track-card${Number(frame.index) === Number(selected) ? ' selected' : ''}"
          data-index="${frame.index}" draggable="${run.canReorder ? 'true' : 'false'}" title="第 ${frame.index} 帧">
        <div class="track-thumb">
          ${src ? `<img src="${escapeHtml(src)}" alt="第 ${frame.index} 帧" loading="lazy">` : '<span class="placeholder">待生成</span>'}
          <span class="track-index">#${String(frame.index).padStart(2, '0')}</span>
          ${frame.isEdited ? '<span class="track-flag">AI</span>' : ''}
        </div>
        <div class="track-meta">
          <span class="track-hold" title="停格数：每帧停留的帧数">
            <button type="button" data-hold="-1" data-frame="${frame.index}" title="减少停格">−</button>
            <b>${hold}</b>
            <button type="button" data-hold="1" data-frame="${frame.index}" title="增加停格">+</button>
          </span>
          <span class="track-status">${escapeHtml(status.label)}</span>
        </div>
      </article>`;
    }).join('')}
  </div>`;

  $$('.track-card', container).forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-hold]')) return;
      if (onSelect) onSelect(Number(card.dataset.index));
    });
    card.addEventListener('dragstart', (event) => {
      if (!run.canReorder) return;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.dataset.index);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('.track-card', container).forEach((item) => item.classList.remove('drop-target'));
    });
    card.addEventListener('dragover', (event) => {
      if (!run.canReorder) return;
      event.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('drop-target');
      if (!run.canReorder || !onReorder) return;
      const from = Number(event.dataTransfer.getData('text/plain'));
      const to = Number(card.dataset.index);
      if (from && to && from !== to) onReorder(from, to);
    });
  });

  $$('[data-hold]', container).forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (onHold) onHold(Number(button.dataset.frame), Number(button.dataset.hold));
    });
  });
}

/* ================================================================
 * 检查器
 * ================================================================ */

export function mountInspector(container, run, selected, handlers = {}) {
  const frames = (run && run.frames) || [];
  const frame = frames.find((item) => Number(item.index) === Number(selected));
  if (!frame) {
    container.innerHTML = `<div class="inspect-empty"><strong>选中一帧查看细节</strong><span>点击轨道上的帧卡片</span></div>`;
    return;
  }
  const attempt = (frame.attempts || [])[frame.attempts.length - 1] || {};
  const metrics = attempt.metrics || {};
  const quality = attempt.quality || {};
  const reasons = attempt.reasons || [];
  const messages = attempt.messages || [];
  const isImported = run.source === 'photos' || run.source === 'sheet' || run.source === 'pipeline';
  const canEdit = ['planned', 'review', 'blocked', 'canceled', 'failed', 'done', 'approved'].includes(run.status)
    || run.status === 'draft';
  const metricRows = [
    ['改动比例', metrics.changed_ratio != null ? `${fmtNumber(metrics.changed_ratio * 100, 1)}%` : null],
    ['SSIM', metrics.ssim != null ? fmtNumber(metrics.ssim, 3) : null],
    ['MAE', metrics.mae != null ? fmtNumber(metrics.mae, 1) : null],
    ['耗时', attempt.elapsedMs ? fmtDuration(attempt.elapsedMs) : null],
  ].filter(([, value]) => value != null);
  const metricsHtml = metricRows
    .map(([label, value]) => `<div class="metric"><span>${label}</span><b>${escapeHtml(value)}</b></div>`)
    .join('');

  // 参考框：用户从轨道拖进来的帧号，第一张当画布；空着就是文生图。
  const draft = handlers.draft || {
    images: isImported ? [Number(frame.index)] : [],
    prompt: frame.prompt || '',
  };
  if (!Array.isArray(draft.images)) draft.images = [];
  if (typeof draft.prompt !== 'string') draft.prompt = frame.prompt || '';
  const refBlock = isImported ? `
    <div class="inspect-ref">
      <div class="inspect-ref-head">
        <span class="set-label">参考图</span>
        <span class="mini" data-role="refSummary"></span>
      </div>
      <div class="ref-drop" data-role="refDrop">
        <div class="ref-chips" data-role="refChips"></div>
        <p class="ref-drop-hint">把轨道上的帧拖进来 · 留空就是文生图</p>
      </div>
    </div>` : '';
  const manualBlock = isImported ? `
    <details class="fold">
      <summary>手动参数（可选）</summary>
      <div class="field-grid" style="margin-top:10px">
        <label class="field"><span>步数</span><input class="input" type="number" min="1" max="100" data-ov="steps" placeholder="沿用轨道"></label>
        <label class="field"><span>CFG</span><input class="input" type="number" min="0" max="30" step="0.1" data-ov="cfg" placeholder="沿用轨道"></label>
      </div>
      <div class="field-grid" style="margin-top:8px">
        <label class="field"><span>降噪</span><input class="input" type="number" min="0.05" max="1" step="0.05" data-ov="denoise" placeholder="沿用轨道"></label>
        <label class="field"><span>种子</span><input class="input" type="number" min="-1" data-ov="seed" placeholder="-1 随机"></label>
      </div>
      <p class="mini" style="margin-top:6px">只作用于这一次精修，不写回轨道设置。</p>
    </details>` : '';

  container.innerHTML = `
    <div class="inspect-head">
      <div class="inspect-title">
        <span class="kicker">帧 ${String(frame.index).padStart(2, '0')}</span>
        <h2>${escapeHtml((frame.beat || `第 ${frame.index} 帧`).slice(0, 24))}</h2>
      </div>
      ${frameStatusBadge(frame.status)}
    </div>
    <div class="inspect-img-wrap">
      ${frame.previewUrl ? `<img src="${escapeHtml(frame.previewUrl)}" alt="第 ${frame.index} 帧">` : '<div class="inspect-img-empty">还没有生成图</div>'}
    </div>
    ${frame.isEdited ? '<div class="notice ok">' + icon('check', 15) + '<span>这一帧已经过 AI 精修，可随时恢复原图。</span></div>' : ''}
    <label class="field mention-wrap" style="margin-top:10px"><span>提示词</span>
      <textarea class="textarea" data-role="prompt" rows="${isImported ? 4 : 3}" ${canEdit ? '' : 'disabled'}
        placeholder="${isImported ? '描述要改成什么样；输入 @ 引用轨道上的帧' : ''}">${escapeHtml(draft.prompt)}</textarea>
      <div class="mention-pop" data-role="mention" hidden></div>
    </label>
    ${refBlock}
    ${manualBlock}
    <div class="inspect-actions">
      <button class="btn" type="button" data-action="savePrompt" ${canEdit ? '' : 'disabled'}>保存提示词</button>
      <button class="btn primary" type="button" data-action="${isImported ? 'generate' : 'retryFrame'}" ${canEdit ? '' : 'disabled'}>
        ${isImported ? '生成这一帧' : '重试这一帧'}
      </button>
    </div>
    ${isImported ? `<div class="inspect-subactions">
      ${frame.canRestore ? '<button class="btn tiny subtle" type="button" data-action="restore">恢复原图</button>' : ''}
      <div class="spacer"></div>
      <button class="btn tiny ghost" type="button" data-action="moveLeft" ${run.canReorder ? '' : 'disabled'}>前移</button>
      <button class="btn tiny ghost" type="button" data-action="moveRight" ${run.canReorder ? '' : 'disabled'}>后移</button>
      <button class="btn tiny danger" type="button" data-action="deleteFrame" ${run.canDeleteFrames ? '' : 'disabled'}>删除</button>
    </div>` : ''}
    <p class="mini" style="margin-top:8px">${isImported
      ? '精修只重跑当前帧，不影响其它帧；调用主项目 /api/edit（ComfyUI 出图），不需要 LLM。'
      : '改词后点「重试这一帧」；接力模式下该帧之后的帧会重新生成。'}</p>
    ${metricsHtml ? `<div class="metrics">${metricsHtml}</div>` : ''}
    ${reasons.length || messages.length ? `<div class="reasons">
      ${reasons.map((reason) => `<div class="reason">${escapeHtml(reason)}</div>`).join('')}
      ${messages.map((message) => `<div class="reason warn">${escapeHtml(message)}</div>`).join('')}
    </div>` : ''}
    ${qualityLine(quality)}
    ${attempt.jobId ? `<p class="mini">任务 ${escapeHtml(attempt.jobId)}</p>` : ''}
  `;

  const promptEl = container.querySelector('[data-role="prompt"]');
  if (promptEl) {
    promptEl.addEventListener('input', () => { draft.prompt = promptEl.value; });
  }
  const saveBtn = container.querySelector('[data-action="savePrompt"]');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (handlers.onSavePrompt) handlers.onSavePrompt(frame.index, promptEl.value);
    });
  }
  if (isImported) {
    bindRefBox(container, frames, frame, draft, promptEl, handlers);
  } else {
    const retryBtn = container.querySelector('[data-action="retryFrame"]');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (handlers.onRetry) {
          handlers.onRetry(frame.index, {
            prompt: promptEl.value,
            reference: 'source',
            settings: {},
          });
        }
      });
    }
  }
  const restoreBtn = container.querySelector('[data-action="restore"]');
  if (restoreBtn) restoreBtn.addEventListener('click', () => handlers.onRestore && handlers.onRestore(frame.index));
  const moveLeft = container.querySelector('[data-action="moveLeft"]');
  if (moveLeft) moveLeft.addEventListener('click', () => handlers.onMove && handlers.onMove(frame.index, -1));
  const moveRight = container.querySelector('[data-action="moveRight"]');
  if (moveRight) moveRight.addEventListener('click', () => handlers.onMove && handlers.onMove(frame.index, 1));
  const deleteBtn = container.querySelector('[data-action="deleteFrame"]');
  if (deleteBtn) deleteBtn.addEventListener('click', () => handlers.onDelete && handlers.onDelete(frame.index));
}

/* 参考框：从轨道拖帧进来 / 提示词里 @ 帧；第一张当画布，空着就是文生图。 */
function bindRefBox(container, frames, frame, draft, promptEl, handlers) {
  const byIndex = new Map(frames.map((item) => [Number(item.index), item]));
  const drop = container.querySelector('[data-role="refDrop"]');
  const chipsEl = container.querySelector('[data-role="refChips"]');
  const summary = container.querySelector('[data-role="refSummary"]');
  const hint = container.querySelector('.ref-drop-hint');
  const mention = container.querySelector('[data-role="mention"]');
  const submit = container.querySelector('[data-action="generate"]');

  const paint = () => {
    if (!chipsEl) return;
    chipsEl.innerHTML = draft.images.map((index, pos) => {
      const item = byIndex.get(Number(index)) || {};
      const src = item.previewUrl || item.acceptedPreviewUrl || item.sourcePreviewUrl || '';
      return `<figure class="ref-chip${pos === 0 ? ' is-canvas' : ''}" draggable="true"
          data-ref-pos="${pos}" title="第 ${index} 帧">
        ${src ? `<img src="${escapeHtml(src)}" alt="第 ${index} 帧">` : '<span class="ref-chip-empty">无图</span>'}
        <figcaption>#${String(index).padStart(2, '0')}<b>${pos === 0 ? '画布' : '参考'}</b></figcaption>
        <button type="button" class="ref-chip-x" data-ref-remove="${pos}" title="移出参考框">×</button>
      </figure>`;
    }).join('');
    if (summary) {
      summary.textContent = draft.images.length
        ? `共 ${draft.images.length} 张 · 第 1 张是画布`
        : '空 · 文生图';
    }
    if (hint) hint.hidden = draft.images.length > 0;
    if (submit) {
      submit.textContent = draft.images.length ? '生成（图生图）' : '生成（文生图）';
    }
    bindChips();
  };

  const add = (index) => {
    const num = Number(index);
    if (!byIndex.has(num) || draft.images.includes(num)) return false;
    draft.images.push(num);
    paint();
    return true;
  };

  /* 拖进参考框时，提示词里自动补一个 @帧N，用户不用再手打。 */
  const appendMention = (index) => {
    if (!promptEl) return;
    const value = promptEl.value;
    const caret = promptEl.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const spacer = before && !/\s$/.test(before) ? ' ' : '';
    const token = `@帧${index} `;
    promptEl.value = before + spacer + token + after;
    draft.prompt = promptEl.value;
    const pos = (before + spacer + token).length;
    promptEl.focus();
    promptEl.setSelectionRange(pos, pos);
  };

  const removeAt = (pos) => {
    const [removed] = draft.images.splice(pos, 1);
    // 移出参考框时把对应的 @ 引用也去掉，避免提交时又被自动加回来。
    if (promptEl && removed != null) {
      promptEl.value = promptEl.value.replace(new RegExp(`@帧${removed}\\s?`, 'g'), '');
      draft.prompt = promptEl.value;
    }
    paint();
  };

  const move = (from, to) => {
    if (!Number.isFinite(from) || from === to || from < 0 || from >= draft.images.length) return;
    const [item] = draft.images.splice(from, 1);
    const target = Math.max(0, Math.min(draft.images.length, to > from ? to - 1 : to));
    draft.images.splice(target, 0, item);
    paint();
  };

  function bindChips() {
    $$('.ref-chip', chipsEl).forEach((chip) => {
      const pos = Number(chip.dataset.refPos);
      chip.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/x-ref-pos', String(pos));
      });
      chip.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chip.classList.add('drop-target');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('drop-target'));
      chip.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chip.classList.remove('drop-target');
        const raw = event.dataTransfer.getData('text/x-ref-pos');
        if (raw !== '') move(Number(raw), pos);
      });
    });
    $$('[data-ref-remove]', chipsEl).forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        removeAt(Number(button.dataset.refRemove));
      });
    });
  }

  if (drop) {
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
      const rawPos = event.dataTransfer.getData('text/x-ref-pos');
      if (rawPos !== '') {
        move(Number(rawPos), draft.images.length);
        return;
      }
      const raw = event.dataTransfer.getData('text/plain');
      if (raw && add(Number(raw))) appendMention(Number(raw));
    });
  }

  const closeMention = () => {
    if (mention) {
      mention.hidden = true;
      mention.innerHTML = '';
    }
  };
  const openMention = (query) => {
    if (!mention) return;
    const items = frames.filter((item) => {
      const src = item.previewUrl || item.acceptedPreviewUrl || item.sourcePreviewUrl;
      return src && (query === '' || String(item.index).includes(query));
    }).slice(0, 8);
    if (!items.length) { closeMention(); return; }
    mention.innerHTML = items.map((item) => `<button type="button" data-mention="${item.index}">
      #${String(item.index).padStart(2, '0')}<span>${escapeHtml((item.beat || '帧').slice(0, 8))}</span></button>`).join('');
    mention.hidden = false;
  };
  const insertMention = (index) => {
    if (!promptEl) return;
    const value = promptEl.value;
    const caret = promptEl.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]{0,10})$/, `@帧${index} `);
    const after = value.slice(caret);
    promptEl.value = before + after;
    draft.prompt = promptEl.value;
    promptEl.focus();
    promptEl.setSelectionRange(before.length, before.length);
    add(index);
    closeMention();
  };

  if (promptEl) {
    promptEl.addEventListener('input', () => {
      const before = promptEl.value.slice(0, promptEl.selectionStart ?? promptEl.value.length);
      const match = /@([^\s@]{0,10})$/.exec(before);
      if (match) openMention(match[1]);
      else closeMention();
    });
    promptEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMention();
    });
  }
  if (mention) {
    mention.addEventListener('mousedown', (event) => event.preventDefault());
    mention.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mention]');
      if (button) insertMention(Number(button.dataset.mention));
    });
  }

  if (submit) {
    submit.addEventListener('click', () => {
      const settings = {};
      $$('[data-ov]', container).forEach((input) => {
        const value = input.value.trim();
        if (value !== '') settings[input.dataset.ov] = value;
      });
      const prompt = resolveTokens(promptEl ? promptEl.value : '', draft.images, byIndex);
      if (!draft.images.length && !prompt) {
        toast('参考框为空时是文生图，请先写提示词', 'warn');
        return;
      }
      paint();
      if (handlers.onGenerate) {
        handlers.onGenerate(frame.index, { prompt, images: draft.images.slice(), settings });
      }
    });
  }

  paint();
}

/* 提示词里的 @帧N 换成 <imageN>，顺序与参考框一致；未入框的自动补进去。 */
function resolveTokens(text, images, byIndex) {
  return String(text || '').replace(/@帧(\d+)/g, (_whole, raw) => {
    const index = Number(raw);
    if (!byIndex.has(index)) return '';
    let pos = images.indexOf(index);
    if (pos < 0) {
      images.push(index);
      pos = images.length - 1;
    }
    return `<image${pos + 1}>`;
  }).trim();
}

/* 主项目 /api/edit 回执：把原始 JSON 折成一行可读的标签，避免在检查器里裸露 JSON。 */
function qualityLine(quality) {
  if (!quality || !Object.keys(quality).length) return '';
  const chips = [];
  if (quality.size_match != null) chips.push(`尺寸一致 ${quality.size_match ? '✓' : '✕'}`);
  if (quality.outside_max_abs != null) chips.push(`画布外偏差 ${fmtNumber(quality.outside_max_abs, 1)}`);
  Object.entries(quality).forEach(([key, value]) => {
    if (key === 'size_match' || key === 'outside_max_abs') return;
    if (typeof value === 'object' && value !== null) return;
    chips.push(`${key} ${value}`);
  });
  if (!chips.length) return '';
  return `<div class="quality-line">${icon('check', 13)}<span>主项目回执</span>${chips.slice(0, 4)
    .map((chip) => `<b>${escapeHtml(chip)}</b>`).join('')}</div>`;
}

/* ================================================================
 * 导出面板
 * ================================================================ */

/* 成片时长：按逐帧停格与帧率估算，仅用于界面提示。 */
function durationOf(run, fps) {
  const holds = (run && run.settings && run.settings.timeline && run.settings.timeline.holds) || [];
  const defaultHold = num(run && run.settings && run.settings.motion && run.settings.motion.hold, 2);
  return ((run && run.frames) || []).reduce((sum, _frame, index) => {
    const hold = Math.max(1, num(holds[index], defaultHold));
    return sum + hold / Math.max(1, num(fps, 12)) * 1000;
  }, 0);
}

export function exportDefaults(options) {
  const defaults = (options && options.defaults) || {};
  return {
    format: (defaults.export && defaults.export.format) || 'gif',
    preset: (defaults.motion && defaults.motion.preset) || 'both',
    motionFps: (defaults.motion && defaults.motion.fps) || 8,
    jitter: (defaults.motion && defaults.motion.jitter) || 1.2,
    grain: (defaults.motion && defaults.motion.grain) || 0.06,
    vignette: (defaults.motion && defaults.motion.vignette) || 0.18,
    colorBoil: (defaults.motion && defaults.motion.color_boil) || 0.03,
    align: false,
    colorMatch: false,
    fps: (defaults.timeline && defaults.timeline.fps) || 12,
  };
}

export function mountExportPanel(container, run, options, state, handlers = {}) {
  const values = state.export || exportDefaults(options);
  const formats = (options && options.exportFormats) || ['gif', 'apng', 'webp', 'mp4', 'webm'];
  const videoOk = Boolean(options && options.video && options.video.available);
  const formatLabels = { gif: 'GIF（循环）', apng: 'APNG（带 alpha）', webp: 'WebP（无损）', mp4: 'MP4（视频）', webm: 'WebM（视频）' };
  const presetLabels = { both: '顺滑 + 定格（两版）', smooth: '仅顺滑', stopmotion: '仅定格' };
  const animation = (run && run.animation) || {};
  const variants = animation.variants || [];
  const exporting = run && run.status === 'exporting';
  const ready = run && run.canExport;
  const totalMs = durationOf(run, values.fps);

  container.innerHTML = `
    <div class="export-grid">
      <label class="field"><span>导出格式</span>
        <select class="select" data-role="format">
          ${formats.map((fmt) => `<option value="${fmt}"${fmt === values.format ? ' selected' : ''}
            ${!videoOk && (fmt === 'mp4' || fmt === 'webm') ? ' disabled' : ''}>${escapeHtml(formatLabels[fmt] || fmt)}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>版本</span>
        <select class="select" data-role="preset">
          ${Object.entries(presetLabels).map(([id, label]) => `<option value="${id}"${id === values.preset ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>播放帧率</span>
        <input class="input" type="number" data-role="fps" min="4" max="30" value="${values.fps}">
      </label>
      <label class="field"><span>定格帧率</span>
        <input class="input" type="number" data-role="motionFps" min="4" max="24" value="${values.motionFps}">
      </label>
    </div>
    <details class="fold" data-role="bake">
      <summary>定格烘焙与稳定化</summary>
      <div class="stack" style="margin-top:10px">
        ${rangeField({ name: 'jitter', label: '抖动', value: values.jitter, min: 0, max: 8, step: 0.1, unit: 'px' })}
        ${rangeField({ name: 'grain', label: '颗粒', value: values.grain, min: 0, max: 0.3, step: 0.01 })}
        ${rangeField({ name: 'vignette', label: '暗角', value: values.vignette, min: 0, max: 0.8, step: 0.02 })}
        <div class="stack" style="gap:7px">
          ${checkField({ name: 'align', label: '去抖动对齐（需 8710）', checked: values.align })}
          ${checkField({ name: 'colorMatch', label: '去闪烁统一配色（需 8710）', checked: values.colorMatch })}
        </div>
        <p class="mini">抖动 / 颗粒 / 暗角只作用于定格版；顺滑版按播放帧率直接成片。</p>
      </div>
    </details>
    <div class="export-foot">
      <span class="mini">${(run && run.frames || []).length} 格 · 成片约 <b data-role="duration">${fmtDuration(totalMs)}</b></span>
      <span class="mini">${variants.length ? `已导出 ${variants.length} 个版本` : '默认同时出顺滑与定格两版'}</span>
    </div>
    ${!ready ? `<div class="notice warn">${icon('info', 15)}<span>还有帧未通过，先完成审核再导出。</span></div>` : ''}
    <button class="btn primary block" type="button" data-action="export"${ready && !exporting ? '' : ' disabled'}>
      ${icon('download', 15)} ${exporting ? '正在导出…' : '导出成片'}</button>
    <div class="variants">
      ${variants.map((item) => `<div class="variant">
        <span class="variant-icon">${icon('film', 15)}</span>
        <div class="variant-copy">
          <strong>${escapeHtml(item.key === 'stopmotion' ? '定格版' : '顺滑版')} · ${escapeHtml(String(item.format || '').toUpperCase())}</strong>
          <span>${item.frames} 格 @ ${item.fps}fps · ${fmtDuration(item.durationMs)}</span>
        </div>
        <a class="btn small ghost" href="${escapeHtml(item.fileUrl || '')}" target="_blank" rel="noopener">预览</a>
        <button class="btn small subtle" type="button" data-download="${escapeHtml(item.fileUrl || '')}"
          data-name="${escapeHtml(item.file || 'animation')}">${icon('download', 13)}</button>
      </div>`).join('')}
    </div>
    ${animation.stabilize && animation.stabilize.requested && !animation.stabilize.ok
      ? `<p class="mini" style="margin-top:6px">稳定化未生效：${escapeHtml(animation.stabilize.error || '服务不可用，已回退本地导出')}</p>` : ''}
  `;

  syncRangeLabels(container);
  const read = () => {
    const get = (role) => container.querySelector(`[data-role="${role}"]`);
    return {
      format: get('format').value,
      preset: get('preset').value,
      fps: num(get('fps').value, 12),
      motionFps: num(get('motionFps').value, 8),
      jitter: num(container.querySelector('[name="jitter"]').value, 1.2),
      grain: num(container.querySelector('[name="grain"]').value, 0.06),
      vignette: num(container.querySelector('[name="vignette"]').value, 0.18),
      colorBoil: values.colorBoil,
      align: container.querySelector('[name="align"]').checked,
      colorMatch: container.querySelector('[name="colorMatch"]').checked,
    };
  };
  const persist = () => { state.export = { ...(state.export || {}), ...read() }; };
  // 「仅顺滑」时定格烘焙参数无意义，直接禁用并降透明度，避免误以为会影响成片。
  const bake = container.querySelector('[data-role="bake"]');
  const durationEl = container.querySelector('[data-role="duration"]');
  const syncBake = () => {
    if (!bake) return;
    const off = container.querySelector('[data-role="preset"]').value === 'smooth';
    bake.classList.toggle('is-muted', off);
    bake.querySelectorAll('input').forEach((input) => { input.disabled = off; });
  };
  syncBake();
  container.querySelectorAll('select, input').forEach((input) => {
    input.addEventListener('change', persist);
    input.addEventListener('input', persist);
  });
  const presetSelect = container.querySelector('[data-role="preset"]');
  if (presetSelect) presetSelect.addEventListener('change', syncBake);
  const fpsInput = container.querySelector('[data-role="fps"]');
  if (fpsInput && durationEl) {
    fpsInput.addEventListener('input', () => {
      durationEl.textContent = fmtDuration(durationOf(run, num(fpsInput.value, 12)));
    });
  }
  const exportBtn = container.querySelector('[data-action="export"]');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      persist();
      const next = state.export;
      if (handlers.onExport) handlers.onExport(next);
    });
  }
  $$('[data-download]', container).forEach((button) => {
    button.addEventListener('click', () => {
      const url = button.dataset.download;
      if (url) downloadFile(url, button.dataset.name || '');
    });
  });
}

/* ================================================================
 * 页面级小工具
 * ================================================================ */

export function runMetaLine(run) {
  if (!run) return '';
  const frames = (run.frames || []).length;
  const accepted = run.acceptedCount != null ? run.acceptedCount : (run.frames || []).filter((f) => f.status === 'accepted').length;
  return `${SOURCE_LABEL[run.source] || '连续编辑'} · ${accepted}/${frames} 帧`;
}

export function progressOf(run) {
  const total = (run && run.frames && run.frames.length) || num(run && run.settings && run.settings.frames, 0);
  const accepted = (run && run.frames || []).filter((frame) => frame.status === 'accepted').length;
  const percent = total ? Math.round(accepted * 100 / total) : num(run && run.progress && run.progress.percent, 0);
  let message = (run && run.progress && run.progress.message) || '等待开始';
  const status = run && run.status;
  if (percent >= 100 && (status === 'review' || status === 'approved')) {
    message = status === 'approved' ? '全部帧已确认，可导出' : '全部帧已就绪，等待确认';
  }
  return { total, accepted, percent, message };
}

export function stepStrip(run, mode = 'photos') {
  const status = (run && run.status) || 'draft';
  const source = run && run.source;
  const steps = mode === 'pipeline'
    ? [['切分', ['review', 'blocked', 'running', 'planned', 'done'].includes(status) || Boolean(run)], ['提示词', Boolean(run)], ['AI 精修', ['review', 'blocked', 'done', 'approved', 'exporting'].includes(status) || (run && run.pipeline && run.pipeline.step === 'edited')], ['导出', Boolean(run && run.animation && run.animation.file)]]
    : mode === 'chain'
      ? [['分镜', ['planned', 'running', 'review', 'blocked', 'done', 'approved'].includes(status)], ['生成', ['running', 'review', 'blocked', 'done', 'approved'].includes(status)], ['审核', status === 'approved' || status === 'done'], ['导出', Boolean(run && run.animation && run.animation.file)]]
      : [['导入素材', Boolean(run)], ['编排轨道', Boolean(run)], ['AI 精修（可选）', Boolean(run && run.pipeline && run.pipeline.step === 'edited')], ['导出', Boolean(run && run.animation && run.animation.file)]];
  return `<div class="step-strip">
    ${steps.map(([label, done], index) => `<span class="step-item${done ? ' done' : ''}${!done && (index === 0 || steps.slice(0, index).every(([, prev]) => prev)) ? ' active' : ''}">
      <span class="step-dot">${done ? '✓' : index + 1}</span>${escapeHtml(label)}
    </span>${index < steps.length - 1 ? '<span class="step-sep"></span>' : ''}`).join('')}
  </div>`;
}

export function canvasOptions(options, currentWidth, currentHeight) {
  const presets = (options && options.canvas) || [];
  const match = presets.find((item) => Number(item.width) === Number(currentWidth) && Number(item.height) === Number(currentHeight));
  return { presets, current: match ? match.id : 'custom' };
}

export function logPanel(log) {
  const items = (log || []).slice(-80);
  if (!items.length) return '<div class="log"><div class="log-line"><time>--:--</time><span>暂无日志</span></div></div>';
  return `<div class="log">${items.map((item) => `<div class="log-line ${escapeHtml(item.stage || '')}">
    <time>${escapeHtml(item.t || '')}</time><span>${escapeHtml(item.message || '')}</span>
  </div>`).join('')}</div>`;
}
