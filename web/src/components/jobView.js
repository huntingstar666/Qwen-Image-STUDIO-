/**
 * 任务进度与结果渲染（文生图 / 图像编辑共用）。
 * 职责：
 * 1. 提交任务后每 700ms 轮询 /api/jobs/{id}（契约要求）；
 * 2. 进度条（value/max/label）、耗时、取消按钮；
 * 3. 成功后展示结果图、尺寸、align.canvas、quality.outside_max_abs（零色差校验）；
 * 4. 局部编辑时可把遮罩叠加到结果图上，便于人工核对遮罩范围。
 */

import { api, pollJob } from '../api.js';
import { toast, toastError } from './toast.js';
import { copyText, downloadUrl, escapeHtml, fmtElapsed, fmtNum } from '../utils.js';

const STATUS_TEXT = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
};

export class JobRunner {
  /**
   * @param {HTMLElement} host 结果面板容器（会自动填充内容）
   * @param {{idleText?: string, idleGlyph?: string}} [options]
   */
  constructor(host, { idleText = '设置好参数后点击生成，任务进度会显示在这里。', idleGlyph = '◇' } = {}) {
    this.host = host;
    this.idleText = idleText;
    this.idleGlyph = idleGlyph;
    this.jobId = null;
    this.maskOverlay = null;
    this.promptText = '';
    this.timer = 0;
    this.startedAt = 0;
    this.activePoll = null;
    this.showMaskOverlay = false;
    this.host.innerHTML = `
      <div class="job-body">
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
        <div class="job-result hidden" data-ref="result"></div>
      </div>`;
    const ref = (name) => this.host.querySelector(`[data-ref="${name}"]`);
    this.refs = {
      idle: ref('idle'),
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
      result: ref('result'),
    };
    this.refs.cancel.addEventListener('click', () => this.cancel());
  }

  reset({ idleText } = {}) {
    this.stopTimer();
    if (this.activePoll) {
      this.activePoll.stop?.();
      this.activePoll = null;
    }
    this.jobId = null;
    this.maskOverlay = null;
    this.showMaskOverlay = false;
    if (idleText) this.refs.idle.querySelector('div:last-child').textContent = idleText;
    this.refs.idle.classList.remove('hidden');
    this.refs.progress.classList.add('hidden');
    this.refs.error.classList.add('hidden');
    this.refs.result.classList.add('hidden');
    this.refs.result.innerHTML = '';
    this.refs.jobId.textContent = '';
  }

  /**
   * 开始一次任务。
   * @param {{create: () => Promise<{job_id:string}>, maskDataUrl?: string|null, prompt?: string, onDone?: Function}} options
   */
  async start({ create, maskDataUrl = null, prompt = '', onDone, onProgress } = {}) {
    this.reset();
    this.maskOverlay = maskDataUrl || null;
    this.promptText = prompt || '';
    this.startedAt = performance.now();
    this.refs.idle.classList.add('hidden');
    this.refs.progress.classList.remove('hidden');
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
    this.refs.jobId.textContent = `#${jobId}`;
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
      this.refs.idle.classList.remove('hidden');
      this.refs.idle.innerHTML = '<div class="glyph">∅</div><div>任务已取消，可调整参数后重新生成。</div>';
      return;
    }
    if (job.status !== 'done') {
      this.showError(`任务状态异常：${job.status}`);
      return;
    }

    this.refs.progress.classList.add('hidden');
    this.refs.idle.classList.add('hidden');
    this.refs.error.classList.add('hidden');
    this.renderResult(job);
    onDone?.(job);
  }

  renderResult(job) {
    const host = this.refs.result;
    host.classList.remove('hidden');
    const images = Array.isArray(job.images) ? job.images : [];
    const prompt = job.prompt || this.promptText || '';
    const align = job.align || null;
    const quality = job.quality || null;

    const badges = [];
    if (job.elapsed_ms != null) badges.push(`<span class="badge info">耗时 ${fmtElapsed(job.elapsed_ms)}</span>`);
    if (images[0]?.width && images[0]?.height) {
      badges.push(`<span class="badge">${fmtNum(images[0].width)} × ${fmtNum(images[0].height)}</span>`);
    }
    if (align?.canvas) {
      const multiple = align.canvas.w % 32 === 0 && align.canvas.h % 32 === 0;
      badges.push(
        `<span class="badge ${multiple ? 'ok' : 'warn'}" title="采样画布（32 的倍数表示零偏移对齐正常）">画布 ${fmtNum(align.canvas.w)} × ${fmtNum(align.canvas.h)}${multiple ? ' · 32 倍数' : ' · 非 32 倍数'}</span>`,
      );
    }
    if (quality && quality.outside_max_abs != null) {
      const zero = Number(quality.outside_max_abs) === 0;
      badges.push(
        zero
          ? `<span class="badge ok" title="遮罩外像素与原图逐像素差异为 0，零色差校验通过">零色差校验通过 · 遮罩外差异 0</span>`
          : `<span class="badge warn" title="遮罩外最大像素差异（0 表示完全一致）">遮罩外差异 ${fmtNum(quality.outside_max_abs)}</span>`,
      );
    }
    if (quality?.size_match != null) {
      badges.push(
        `<span class="badge ${quality.size_match ? 'ok' : 'warn'}">尺寸${quality.size_match ? '一致' : '不一致'}</span>`,
      );
    }
    if (align?.applied) badges.push('<span class="badge">已应用对齐裁回</span>');

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
              <button class="btn ghost sm" type="button" data-download="${escapeHtml(url)}" data-filename="${escapeHtml(filename)}">下载</button>
            </div>
          </div>`;
      })
      .join('');

    host.innerHTML = `
      <div class="result-grid">${imageCards || '<div class="empty"><div class="glyph">⌀</div><div>任务完成但没有返回图片</div></div>'}</div>
      <div class="result-meta">
        <div class="result-badges">${badges.join('')}</div>
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
