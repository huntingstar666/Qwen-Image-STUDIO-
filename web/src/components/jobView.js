/**
 * 任务进度与结果渲染（文生图 / 图像编辑共用）。
 * 职责：
 * 1. 提交任务后每 700ms 轮询 /api/jobs/{id}（契约要求）；
 * 2. 进度条（value/max/label）、耗时、取消按钮；
 * 3. 成功后展示结果图、尺寸、align.canvas、quality.outside_max_abs（零色差校验）；
 * 4. 局部编辑时可把遮罩叠加到结果图上，便于人工核对遮罩范围；
 * 5. feed 模式：结果按批次依次铺开、累积展示，点击图片打开高清大图查看器，
 *    并可对单批结果提供「对比」入口（图像编辑页使用）。
 */

import { api, pollJob } from '../api.js';
import { toast, toastError } from './toast.js';
import { favoriteImage } from './favorites.js';
import { openLightbox } from './lightbox.js';
import { copyText, downloadUrl, escapeHtml, fmtElapsed, fmtNum } from '../utils.js';

const STATUS_TEXT = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

const MAX_BATCHES = 24;

const SCHEME_LABEL = { a: '全画布', b: '裁切', native: '原生', none: '无' };

function fmtRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const pct = ratio * 100;
  return pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`;
}

/**
 * 结果质量徽标（图片精修 / 图生图 / 文生图共用一份字段口径）。
 * 字段来源见 docs/PLAN_PS_EDIT_GH.md §12.11。
 * @param {object} job /api/jobs/{id} 返回的任务对象
 * @returns {Array<{text:string, kind?:'ok'|'warn'|'info', title?:string}>}
 */
export function qualityItems(job) {
  const quality = job?.quality || {};
  const align = job?.align || {};
  const image = job?.images?.[0] || {};
  const items = [];
  if (job?.elapsed_ms != null) items.push({ text: `耗时 ${fmtElapsed(job.elapsed_ms)}`, kind: 'info' });
  if (image.width && image.height) items.push({ text: `${fmtNum(image.width)} × ${fmtNum(image.height)}` });
  if (quality.preset) {
    const version = quality.preset_version != null ? ` · v${quality.preset_version}` : '';
    items.push({
      text: `预设 ${quality.preset_label || quality.preset}${version}`,
      title: `本次生效的编辑预设：${quality.preset}`,
    });
  }
  if (quality.sampling) {
    const s = quality.sampling;
    const turbo = s.turbo?.profile ? ` · Turbo ${s.turbo.profile}` : s.turbo?.enabled === false ? ' · 无 Turbo' : '';
    items.push({
      text: `${fmtNum(s.steps)} 步 · cfg ${fmtNum(s.cfg, 1)} · ${s.sampler}/${s.scheduler}${turbo}`,
      title: '后端实际使用的采样参数（预设未回传时由预设补全）',
    });
  }
  const scheme = String(quality.scheme || '').toLowerCase();
  if (scheme) {
    items.push({ text: `方案 ${SCHEME_LABEL[scheme] || scheme}`, title: '实际执行的局部编辑方案' });
  }
  const zeroShift = quality.zero_shift;
  if (zeroShift && zeroShift.enabled != null) {
    items.push(
      zeroShift.verified
        ? { text: '零偏移 ✓', kind: 'ok', title: '零偏移几何硬验收通过' }
        : { text: '零偏移 未校验', title: '零偏移未启用或未校验' },
    );
  }
  const canvas = quality.canvas || align.canvas;
  if (canvas) {
    const multiple = canvas.w % 32 === 0 && canvas.h % 32 === 0;
    items.push({
      text: `画布 ${fmtNum(canvas.w)} × ${fmtNum(canvas.h)}${multiple ? ' · 32 倍数' : ' · 非 32 倍数'}`,
      kind: multiple ? 'ok' : 'warn',
      title: '采样画布（32 的倍数表示零偏移对齐正常）',
    });
  }
  const band = quality.color?.mask_band;
  if (band && (band.expand_px != null || band.feather_px != null)) {
    items.push({
      text: `过渡带 外扩 ${fmtNum(band.expand_px)}px · 羽化 ${fmtNum(band.feather_px)}px`,
      title: `方案 B 实际过渡带（外扩 ${band.expand_pct ?? '—'}% / 羽化 ${band.feather_pct ?? '—'}%）`,
    });
  }
  if (quality.outside_max_abs != null) {
    const zero = Number(quality.outside_max_abs) === 0;
    items.push({
      text: zero ? '零色差校验通过 · 遮罩外差异 0' : `遮罩外差异 ${fmtNum(quality.outside_max_abs)}`,
      kind: zero ? 'ok' : 'warn',
      title: '遮罩外最大像素差异（0 表示逐像素一致）',
    });
  }
  if (quality.size_match != null) {
    items.push({
      text: `尺寸${quality.size_match ? '一致' : '不一致'}`,
      kind: quality.size_match ? 'ok' : 'warn',
    });
  }
  if (quality.changed_ratio != null) items.push({ text: `改动 ${fmtRatio(quality.changed_ratio)}` });
  if (quality.leak_ratio != null) {
    items.push({
      text: `遮罩外改动 ${fmtRatio(quality.leak_ratio)}`,
      kind: Number(quality.leak_ratio) > 0 ? 'warn' : 'ok',
    });
  }
  if (quality.color?.skipped) items.push({ text: '校色已跳过' });
  if (align.applied) items.push({ text: '已应用对齐裁回' });
  // 后端的降级 / 风险提示必须可见（例如"未圈选区域，按整图重绘"）。
  for (const warning of Array.isArray(quality.warnings) ? quality.warnings : []) {
    items.push({ text: String(warning), kind: 'warn', title: '后端任务提示' });
  }
  if (quality.lora_warning) {
    items.push({ text: String(quality.lora_warning), kind: 'warn', title: 'LoRA 数量提示' });
  }
  return items;
}

export class JobRunner {
  /**
   * @param {HTMLElement} host 结果面板容器（feed 模式下是批次流容器）
   * @param {{idleText?: string, idleGlyph?: string, feed?: boolean, latestOnly?: boolean,
   *          progressHost?: HTMLElement|null, onCompare?: Function, onBatch?: Function,
   *          maxBatches?: number}} [options]
   */
  constructor(host, {
    idleText = '设置好参数后点击生成，任务进度会显示在这里。',
    idleGlyph = '◇',
    feed = false,
    latestOnly = false,
    progressHost = null,
    onCompare = null,
    onBatch = null,
    maxBatches = MAX_BATCHES,
  } = {}) {
    this.host = host;
    this.feed = Boolean(feed);
    this.latestOnly = Boolean(latestOnly);
    this.idleText = idleText;
    this.idleGlyph = idleGlyph;
    this.onCompare = onCompare;
    this.onBatch = onBatch;
    this.maxBatches = maxBatches;
    this.progressHost = progressHost || host;
    this.jobId = null;
    this.maskOverlay = null;
    this.promptText = '';
    this.favoriteMeta = null;
    this.timer = 0;
    this.startedAt = 0;
    this.activePoll = null;
    this.showMaskOverlay = false;
    this.batches = [];
    this.batchSeq = 0;

    const progressMarkup = `
      <div class="job-body ${this.feed ? 'job-body-compact' : ''}">
        <div class="job-idle" data-ref="idle">
          <div class="glyph">${idleGlyph}</div>
          <div>${escapeHtml(idleText)}</div>
        </div>
        <div class="job-progress hidden" data-ref="progress">
          <div class="job-top">
            <span class="job-status" data-ref="status">排队中</span>
            <span class="job-elapsed" data-ref="elapsed">0.0s</span>
          </div>
          <div class="bar" data-ref="bar"><div class="bar-fill" data-ref="barFill"></div></div>
          <div class="job-label">
            <span data-ref="label">等待调度…</span>
            <span class="spacer"></span>
            <span class="mono" data-ref="counter">0 / 0</span>
          </div>
          <div class="job-actions">
            <button class="btn ghost sm" type="button" data-ref="cancel">取消任务</button>
            <span class="job-id mono dim" data-ref="jobId"></span>
          </div>
        </div>
        <div class="job-error hidden" data-ref="error"></div>
        ${this.feed ? '' : '<div class="job-result hidden" data-ref="result"></div>'}
      </div>`;

    this.progressHost.innerHTML = progressMarkup;

    if (this.feed) {
      host.innerHTML = `
        <div class="feed-empty" data-ref="idle">
          <div class="glyph">${idleGlyph}</div>
          <div>${escapeHtml(idleText)}</div>
        </div>`;
    }

    const root = this.feed ? this.progressHost : host;
    const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
    this.refs = {
      idle: this.feed ? host.querySelector('[data-ref="idle"]') : ref('idle'),
      progress: ref('progress'),
      status: ref('status'),
      elapsed: ref('elapsed'),
      bar: ref('bar'),
      barFill: ref('barFill'),
      label: ref('label'),
      counter: ref('counter'),
      cancel: ref('cancel'),
      jobId: ref('jobId'),
      error: ref('error'),
      result: this.feed ? null : ref('result'),
    };
    this.refs.cancel?.addEventListener('click', () => this.cancel());
  }

  reset({ idleText } = {}) {
    this.stopTimer();
    if (this.activePoll) {
      this.activePoll.stop?.();
      this.activePoll = null;
    }
    this.jobId = null;
    this.maskOverlay = null;
    this.favoriteMeta = null;
    this.showMaskOverlay = false;
    if (idleText && !this.feed) this.refs.idle.querySelector('div:last-child').textContent = idleText;
    this.refs.progress.classList.add('hidden');
    this.refs.error.classList.add('hidden');
    if (this.refs.jobId) this.refs.jobId.textContent = '';
    if (this.feed) {
      if (this.batches.length) this.refs.idle.classList.add('hidden');
      else this.refs.idle.classList.remove('hidden');
      return;
    }
    this.refs.idle.classList.remove('hidden');
    this.refs.result.classList.add('hidden');
    this.refs.result.innerHTML = '';
  }

  /**
   * 开始一次任务。
   * @param {{create: () => Promise<{job_id:string}>, maskDataUrl?: string|null, prompt?: string,
   *          favoriteMeta?: {kind?:string, category?:string, params?:object, referenceImages?:Array},
   *          onDone?: Function, onProgress?: Function}} options
   */
  async start({ create, maskDataUrl = null, prompt = '', favoriteMeta = null, onDone, onProgress } = {}) {
    this.reset();
    this.maskOverlay = maskDataUrl || null;
    this.favoriteMeta = favoriteMeta;
    this.promptText = prompt || '';
    this.startedAt = performance.now();
    this.refs.idle.classList.add('hidden');
    this.refs.progress.classList.remove('hidden');
    this.refs.error.classList.add('hidden');
    this.refs.status.textContent = '提交任务…';
    this.refs.label.textContent = '正在把参数发送给后端';
    this.refs.counter.textContent = '0 / 0';
    this.refs.elapsed.textContent = '0.0s';
    this.refs.cancel.disabled = false;
    this.refs.cancel.textContent = '取消任务';
    this.refs.bar.classList.add('indeterminate');
    this.refs.barFill.style.width = '0%';
    this.startTimer();

    let created;
    try {
      created = await create();
    } catch (err) {
      this.stopTimer();
      this.showError(err?.message || '提交任务失败');
      toastError(err, '提交任务失败');
      return;
    }

    const jobId = created?.job_id || created?.id;
    if (!jobId) {
      this.stopTimer();
      this.showError('后端没有返回任务 ID（job_id），请检查 /api 接口实现');
      return;
    }
    this.jobId = jobId;
    if (this.refs.jobId) this.refs.jobId.textContent = `#${jobId}`;
    onProgress?.({ status: 'queued', progress: { value: 0, max: 0, label: '排队中' } });

    try {
      this.activePoll = pollJob(jobId, (job) => {
        this.update(job);
        onProgress?.(job);
      });
      const finalJob = await this.activePoll;
      if (!finalJob) return; // 被手动停止
      this.finish(finalJob, { onDone });
      onProgress?.(finalJob);
    } catch (err) {
      this.showError(err?.message || '任务状态查询失败');
      toastError(err, '任务状态查询失败');
      onProgress?.({ status: 'error', error: err?.message || '任务状态查询失败' });
    } finally {
      this.activePoll = null;
      this.stopTimer();
    }
  }

  async cancel() {
    if (!this.jobId) {
      toast('任务还在提交中，请稍候再取消', 'info');
      return;
    }
    this.refs.cancel.disabled = true;
    this.refs.cancel.textContent = '取消中…';
    try {
      await api.cancelJob(this.jobId);
      toast('已请求取消任务', 'info');
    } catch (err) {
      toastError(err, '取消失败');
      this.refs.cancel.disabled = false;
      this.refs.cancel.textContent = '取消任务';
    }
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.startedAt) return;
      this.refs.elapsed.textContent = fmtElapsed(performance.now() - this.startedAt);
    }, 200);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  update(job) {
    if (!job) return;
    const progress = job.progress || {};
    const value = Number(progress.value) || 0;
    const max = Number(progress.max) || 0;
    const status = job.status || 'running';
    this.refs.progress.classList.remove('hidden');
    this.refs.status.textContent = STATUS_TEXT[status] || status;
    this.refs.label.textContent = progress.label || (status === 'running' ? '推理中…' : '等待调度…');
    this.refs.counter.textContent = max > 0 ? `${value} / ${max}` : '—';
    if (max > 0) {
      this.refs.bar.classList.remove('indeterminate');
      this.refs.barFill.style.width = `${Math.min(100, Math.round((value / max) * 100))}%`;
    } else if (status === 'queued') {
      this.refs.bar.classList.add('indeterminate');
    }
    if (job.elapsed_ms != null) {
      this.refs.elapsed.textContent = fmtElapsed(job.elapsed_ms);
    }
    if (status === 'canceled') {
      this.refs.status.textContent = '已取消';
      this.refs.label.textContent = '任务已取消';
      this.refs.bar.classList.remove('indeterminate');
    }
    if (status === 'done') {
      this.refs.bar.classList.remove('indeterminate');
      this.refs.barFill.style.width = '100%';
    }
  }

  showError(message) {
    this.refs.progress.classList.add('hidden');
    this.refs.idle.classList.add('hidden');
    this.refs.error.classList.remove('hidden');
    this.refs.error.innerHTML = `<div><b>任务失败</b></div><div>${escapeHtml(message || '后端未提供错误详情')}</div>`;
    this.stopTimer();
  }

  finish(job, { onDone } = {}) {
    this.stopTimer();
    if (job.status === 'error') {
      this.showError(job.error || '生成失败，请查看后端日志');
      toastError(job.error || '生成失败');
      return;
    }
    if (job.status === 'canceled') {
      this.refs.progress.classList.add('hidden');
      if (this.feed) {
        if (!this.batches.length) this.refs.idle.classList.remove('hidden');
      } else {
        this.refs.idle.classList.remove('hidden');
        this.refs.idle.innerHTML = '<div class="glyph">∅</div><div>任务已取消，可调整参数后重新生成。</div>';
      }
      return;
    }
    if (job.status !== 'done') {
      this.showError(`任务状态异常：${job.status}`);
      return;
    }

    this.refs.progress.classList.add('hidden');
    this.refs.idle.classList.add('hidden');
    this.refs.error.classList.add('hidden');
    if (this.feed) {
      this.renderBatch(job);
    } else {
      this.renderResult(job);
    }
    onDone?.(job);
  }

  /* ============================================================
   * 批次流（feed 模式）
   * ============================================================ */
  clearFeed() {
    this.batches = [];
    this.batchSeq = 0;
    this.host.querySelectorAll('.batch-card').forEach((node) => node.remove());
    this.refs.idle.classList.remove('hidden');
  }

  getResults() {
    return this.batches.flatMap((batch) =>
      batch.images.map((image, index) => ({
        url: image.url,
        width: image.width,
        height: image.height,
        filename: image.filename,
        batch: batch.no,
        index,
        label:
          batch.images.length > 1
            ? `批次 ${String(batch.no).padStart(2, '0')} · 第 ${index + 1} 张`
            : `批次 ${String(batch.no).padStart(2, '0')}`,
      })),
    );
  }

  buildBadges(job) {
    return qualityItems(job)
      .map(({ text, kind = '', title = '' }) => {
        const cls = `badge${kind ? ` ${kind}` : ''}`;
        const attr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<span class="${cls}"${attr}>${escapeHtml(text)}</span>`;
      })
      .join('');
  }

  renderBatch(job) {
    const rawImages = Array.isArray(job.images) ? job.images : [];
    const images = rawImages.map((image, index) => ({
      url: api.fileUrl(image.url || image.path || ''),
      width: image.width,
      height: image.height,
      filename: image.filename || `output-${index + 1}.png`,
    }));
    const no = ++this.batchSeq;
    const batch = {
      no,
      time: Date.now(),
      images,
      job,
      prompt: job.prompt || this.promptText || '',
      maskOverlay: this.maskOverlay,
      favoriteMeta: this.favoriteMeta,
    };
    this.batches.push(batch);

    // 只显示最新结果：把上一批卡片移出视区（历史仍保留在 this.batches 与历史胶囊里）
    if (this.latestOnly) {
      this.host.querySelectorAll('.batch-card').forEach((node) => node.remove());
    }

    const card = document.createElement('article');
    card.className = 'batch-card';
    card.dataset.batch = String(no);
    const prompt = batch.prompt;
    const multi = images.length > 1;
    const sizeText =
      images[0]?.width && images[0]?.height
        ? `${fmtNum(images[0].width)} × ${fmtNum(images[0].height)}`
        : '—';

    const imageCards = images
      .map((image, index) => {
        const overlay = index === 0 && batch.maskOverlay;
        return `
          <figure class="batch-item">
            <button class="batch-img" type="button" data-lightbox-index="${index}" title="点击查看高清大图">
              <img src="${escapeHtml(image.url)}" alt="批次 ${no} 结果 ${index + 1}" loading="lazy" />
              ${overlay ? `<img class="mask-overlay-img" src="${escapeHtml(batch.maskOverlay)}" alt="遮罩叠加" data-ref="maskOverlay" style="display:none" />` : ''}
              <span class="batch-zoom">查看高清大图</span>
            </button>
            <figcaption class="batch-cap">
              <span class="mono">#${index + 1}${images.length > 1 ? ` · ${fmtNum(image.width)}×${fmtNum(image.height)}` : ''}</span>
              <span class="spacer"></span>
              ${batch.favoriteMeta ? `<button class="batch-mini" type="button" data-favorite-index="${index}">收藏</button>` : ''}
              <button class="batch-mini" type="button" data-download="${escapeHtml(image.url)}" data-filename="${escapeHtml(image.filename)}">下载</button>
            </figcaption>
          </figure>`;
      })
      .join('');

    card.innerHTML = `
      <div class="batch-head">
        <span class="batch-no">批次 ${String(no).padStart(2, '0')}</span>
        <span class="batch-count">${images.length ? `${images.length} 张 · ${sizeText}` : '无图片'}</span>
        <span class="spacer"></span>
        ${this.onCompare && images.length ? '<button class="batch-action" type="button" data-ref="batchCompare">对比</button>' : ''}
        ${batch.maskOverlay ? '<button class="batch-action" type="button" data-ref="toggleMask">遮罩叠加</button>' : ''}
        ${prompt ? '<button class="batch-action" type="button" data-ref="copyPrompt">复制提示词</button>' : ''}
        ${images.length ? '<button class="batch-action" type="button" data-ref="downloadAll">下载本批</button>' : ''}
      </div>
      <div class="batch-grid ${multi ? 'multi' : 'single'}">
        ${imageCards || '<div class="feed-empty compact"><div class="glyph">⌀</div><div>任务完成但没有返回图片</div></div>'}
      </div>
      <div class="batch-foot">
        <div class="batch-badges">${this.buildBadges(job)}</div>
        ${prompt ? `<div class="batch-prompt" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</div>` : ''}
      </div>`;

    this.host.append(card);
    this.refs.idle.classList.add('hidden');

    /* 点击看高清大图 */
    card.querySelectorAll('[data-lightbox-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const start = Number(button.dataset.lightboxIndex) || 0;
        openLightbox(
          images.map((image, index) => ({
            ...image,
            label: images.length > 1 ? `批次 ${String(no).padStart(2, '0')} · 第 ${index + 1} 张` : `批次 ${String(no).padStart(2, '0')}`,
          })),
          start,
          { title: `批次 ${String(no).padStart(2, '0')} · 高清大图` },
        );
      });
    });

    /* 下载 */
    card.querySelectorAll('[data-download]').forEach((button) => {
      button.addEventListener('click', () => downloadUrl(button.dataset.download, button.dataset.filename));
    });

    /* 收藏 */
    card.querySelectorAll('[data-favorite-index]').forEach((button) => {
      button.addEventListener('click', async () => {
        const image = images[Number(button.dataset.favoriteIndex)];
        if (!image) return;
        button.disabled = true;
        const original = button.textContent;
        button.textContent = '收藏中…';
        await favoriteImage({
          ...batch.favoriteMeta,
          image: image.url,
          prompt,
          seed: job.params?.seed ?? null,
        });
        button.disabled = false;
        button.textContent = original;
      });
    });

    /* 对比（图像编辑页） */
    card.querySelector('[data-ref="batchCompare"]')?.addEventListener('click', () => {
      this.onCompare?.(batch);
    });

    /* 复制提示词 */
    card.querySelector('[data-ref="copyPrompt"]')?.addEventListener('click', async () => {
      const ok = await copyText(prompt);
      toast(ok ? '提示词已复制' : '复制失败，请手动选中复制', ok ? 'success' : 'warn');
    });

    /* 下载本批 */
    card.querySelector('[data-ref="downloadAll"]')?.addEventListener('click', () => {
      images.forEach((image, index) => {
        setTimeout(() => downloadUrl(image.url, image.filename || `output-${index + 1}.png`), index * 220);
      });
    });

    /* 遮罩叠加 */
    const toggleMask = card.querySelector('[data-ref="toggleMask"]');
    if (toggleMask) {
      const overlay = card.querySelector('[data-ref="maskOverlay"]');
      let visible = false;
      toggleMask.addEventListener('click', () => {
        visible = !visible;
        if (overlay) overlay.style.display = visible ? 'block' : 'none';
        toggleMask.classList.toggle('active', visible);
        toggleMask.textContent = visible ? '隐藏遮罩' : '遮罩叠加';
      });
    }

    while (this.batches.length > this.maxBatches) {
      const oldest = this.batches.shift();
      this.host.querySelector(`[data-batch="${oldest.no}"]`)?.remove();
    }

    this.onBatch?.(batch);
    if (!this.latestOnly) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return batch;
  }

  /* ============================================================
   * 单次结果（兼容旧布局）
   * ============================================================ */
  renderResult(job) {
    const host = this.refs.result;
    if (!host) return;
    host.classList.remove('hidden');
    const images = Array.isArray(job.images) ? job.images : [];
    const prompt = job.prompt || this.promptText || '';
    const badges = this.buildBadges(job);

    const imageCards = images
      .map((image, index) => {
        const url = api.fileUrl(image.url || image.path || '');
        const filename = image.filename || `output-${index + 1}.png`;
        const showOverlay = index === 0 && this.maskOverlay;
        return `
          <div class="result-card">
            <div class="result-img-wrap">
              <a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="点击在新窗口查看原图">
                <img src="${escapeHtml(url)}" alt="生成结果 ${index + 1}" loading="lazy" />
              </a>
              ${showOverlay ? `<img class="mask-overlay-img" src="${escapeHtml(this.maskOverlay)}" alt="遮罩叠加" data-ref="maskOverlay" style="display:none" />` : ''}
            </div>
            <div class="result-card-foot">
              <span class="mono">${fmtNum(image.width)}×${fmtNum(image.height)}</span>
              <span class="spacer"></span>
              ${this.favoriteMeta ? `<button class="btn ghost sm" type="button" data-favorite-index="${index}">收藏</button>` : ''}
              <button class="btn ghost sm" type="button" data-download="${escapeHtml(url)}" data-filename="${escapeHtml(filename)}">下载</button>
            </div>
          </div>`;
      })
      .join('');

    host.innerHTML = `
      <div class="result-grid">${imageCards || '<div class="empty"><div class="glyph">⌀</div><div>任务完成但没有返回图片</div></div>'}</div>
      <div class="result-meta">
        <div class="result-badges">${badges}</div>
        <div class="result-actions">
          ${this.maskOverlay ? '<button class="btn ghost sm" type="button" data-ref="toggleMask">显示遮罩叠加</button>' : ''}
          <button class="btn ghost sm" type="button" data-ref="copyPrompt">复制提示词</button>
          <button class="btn ghost sm" type="button" data-ref="downloadAll">下载全部</button>
        </div>
        ${prompt ? `<div class="result-prompt" data-ref="promptBox">${escapeHtml(prompt)}</div>` : ''}
      </div>`;

    for (const btn of host.querySelectorAll('[data-download]')) {
      btn.addEventListener('click', () => downloadUrl(btn.dataset.download, btn.dataset.filename));
    }
    for (const btn of host.querySelectorAll('[data-favorite-index]')) {
      btn.addEventListener('click', async () => {
        const image = images[Number(btn.dataset.favoriteIndex)];
        if (!image) return;
        const url = api.fileUrl(image.url || image.path || '');
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '收藏中…';
        await favoriteImage({
          ...this.favoriteMeta,
          image: url,
          prompt,
          seed: job.params?.seed ?? null,
        });
        btn.disabled = false;
        btn.textContent = original;
      });
    }
    host.querySelector('[data-ref="copyPrompt"]')?.addEventListener('click', async () => {
      const ok = await copyText(prompt);
      toast(ok ? '提示词已复制' : '复制失败，请手动选中复制', ok ? 'success' : 'warn');
    });
    host.querySelector('[data-ref="downloadAll"]')?.addEventListener('click', () => {
      images.forEach((image, index) => {
        const url = api.fileUrl(image.url || image.path || '');
        setTimeout(() => downloadUrl(url, image.filename || `output-${index + 1}.png`), index * 220);
      });
    });
    const toggleMask = host.querySelector('[data-ref="toggleMask"]');
    if (toggleMask) {
      const overlay = host.querySelector('[data-ref="maskOverlay"]');
      toggleMask.addEventListener('click', () => {
        this.showMaskOverlay = !this.showMaskOverlay;
        if (overlay) overlay.style.display = this.showMaskOverlay ? 'block' : 'none';
        toggleMask.textContent = this.showMaskOverlay ? '隐藏遮罩叠加' : '显示遮罩叠加';
      });
    }
  }
}
