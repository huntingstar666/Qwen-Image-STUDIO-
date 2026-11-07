/**
 * 高清放大入口（D15.1）。
 *
 * 复用后端既有任务队列：`POST /api/image/upscale` → `GET /api/jobs/{id}`。
 * 输入是当前画面的烘焙结果（含变换 / 调色 / 叠加层），不直接读原图；
 * 结果先落在弹窗里预览，用户确认后再「载入为主图」，并可拉对比弹窗。
 */

import { api, pollJob } from '../../api.js';
import { openModal } from '../modal.js';
import { toastError } from '../toast.js';

const ENGINE_LABELS = {
  seedvr2: 'SeedVR2 · 质量优先',
  flashvsr: 'FlashVSR · 速度优先',
  vosr2: 'VOSR2 · 细节优先',
};

/**
 * @param {object} options
 * @param {() => (string|Promise<string>)} options.getImage 当前画面 dataURL
 * @param {() => {width:number,height:number}} [options.getSize]
 * @param {(url:string, name:string) => Promise<boolean>|boolean} options.onAdopt
 * @param {(url:string) => void} [options.onCompare]
 */
export function openUpscaleDialog({ getImage, getSize, onAdopt, onCompare }) {
  const body = document.createElement('div');
  body.className = 'up-panel';
  body.innerHTML = `
    <div class="up-row">
      <span class="up-label">引擎</span>
      <div class="chips up-chips" data-ref="engines"><span class="field-hint">正在读取模型…</span></div>
    </div>
    <div class="up-row">
      <span class="up-label">倍率</span>
      <div class="chips up-chips" data-ref="scales"></div>
    </div>
    <p class="up-hint" data-ref="hint">基于当前画面（含变换、调色与叠加层）放大；结果需确认后才替换主图。</p>
    <div class="up-progress" data-ref="progress" hidden>
      <div class="up-bar"><span data-ref="bar"></span></div>
      <div class="field-hint mono" data-ref="status">排队中…</div>
    </div>
    <div class="up-result" data-ref="result" hidden>
      <img data-ref="thumb" alt="放大结果" />
      <div class="up-result-side">
        <div class="mono up-meta" data-ref="meta"></div>
        <div class="up-actions">
          <button class="btn primary sm" type="button" data-act="adopt">载入为主图</button>
          <button class="btn ghost sm" type="button" data-act="compare">与当前主图对比</button>
        </div>
      </div>
    </div>
    <div class="up-actions up-main">
      <button class="btn primary sm" type="button" data-act="start" disabled>开始放大</button>
      <button class="btn ghost sm" type="button" data-act="cancel" hidden>取消任务</button>
    </div>
  `;

  const el = (name) => body.querySelector(`[data-ref="${name}"]`);
  const enginesEl = el('engines');
  const scalesEl = el('scales');
  const hintEl = el('hint');
  const progressEl = el('progress');
  const barEl = el('bar');
  const statusEl = el('status');
  const resultEl = el('result');
  const thumbEl = el('thumb');
  const metaEl = el('meta');
  const startBtn = body.querySelector('[data-act="start"]');
  const cancelBtn = body.querySelector('[data-act="cancel"]');

  const state = { engines: [], engine: '', scale: 2, jobId: '', polling: false, result: null };
  let poll = null;
  let disposed = false;

  const modal = openModal({
    title: '高清放大',
    subtitle: '走后台任务队列，完成后可作为新主图继续编辑',
    content: body,
    hideFooter: true,
    size: 'md',
    onClose: () => {
      disposed = true;
      poll?.stop?.();
    },
  });

  function syncStart() {
    startBtn.disabled = state.polling || !state.engine;
  }

  function renderScales() {
    scalesEl.innerHTML = [2, 4]
      .map(
        (scale) =>
          `<button class="chip ${scale === state.scale ? 'active' : ''}" type="button" data-scale="${scale}">${scale}×</button>`,
      )
      .join('');
  }

  function renderEngines() {
    if (!state.engines.length) {
      enginesEl.innerHTML = '<span class="field-hint">没有可用的放大模型，请到「设置 → 图像放大」配置模型目录并扫描。</span>';
      syncStart();
      return;
    }
    enginesEl.innerHTML = state.engines
      .map(
        (engine) =>
          `<button class="chip ${engine.id === state.engine ? 'active' : ''}" type="button" data-engine="${engine.id}">${
            ENGINE_LABELS[engine.id] || engine.label || engine.id
          }</button>`,
      )
      .join('');
    syncStart();
  }

  function setProgress(percent, label) {
    progressEl.hidden = false;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    barEl.style.width = `${value}%`;
    statusEl.textContent = label ? `${label}（${value}%）` : `${value}%`;
  }

  function finish(message, kind = 'error') {
    state.polling = false;
    state.jobId = '';
    cancelBtn.hidden = true;
    syncStart();
    if (kind === 'error' && message) toastError(new Error(message), '放大失败');
    else if (message) statusEl.textContent = message;
  }

  function showResult(image) {
    const width = Number(image.width) || 0;
    const height = Number(image.height) || 0;
    state.result = { url: image.url, width, height, filename: image.filename || '' };
    thumbEl.src = image.url;
    metaEl.textContent = `${width.toLocaleString()} × ${height.toLocaleString()} · ${image.filename || '放大结果'}`;
    resultEl.hidden = false;
    hintEl.textContent = '放大完成：可载入为新主图继续编辑，或先与当前主图对比。';
    setProgress(100, '完成');
  }

  async function run() {
    if (state.polling || !state.engine) return;
    state.polling = true;
    startBtn.disabled = true;
    cancelBtn.hidden = false;
    resultEl.hidden = true;
    setProgress(0, '生成当前画面');
    try {
      const image = await getImage();
      if (disposed) return;
      if (!image) {
        finish('当前没有可放大的画面', 'error');
        return;
      }
      setProgress(0, '提交任务');
      const resp = await api.upscale({ image, engine: state.engine, scale: state.scale });
      if (disposed) return;
      state.jobId = resp.job_id;
      setProgress(0, '排队中');
      poll = pollJob(state.jobId, (job) => {
        if (disposed) return;
        const progress = job.progress || {};
        const percent = progress.max ? (Number(progress.value) / Number(progress.max)) * 100 : 0;
        setProgress(percent, progress.label || (job.status === 'queued' ? '排队中' : '放大中'));
      });
      const job = await poll;
      if (disposed || !job) return;
      if (job.status === 'done') {
        const image0 = (job.images || [])[0];
        if (!image0?.url) {
          finish('放大完成但没有返回图片', 'error');
          return;
        }
        state.polling = false;
        cancelBtn.hidden = true;
        syncStart();
        showResult(image0);
        return;
      }
      if (job.status === 'canceled') {
        finish('已取消');
        return;
      }
      finish(job.error?.message || job.error || '放大失败', 'error');
    } catch (err) {
      if (!disposed) finish(err?.message || String(err), 'error');
    }
  }

  enginesEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-engine]');
    if (!chip || state.polling) return;
    state.engine = chip.dataset.engine;
    renderEngines();
  });

  scalesEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-scale]');
    if (!chip || state.polling) return;
    state.scale = Number(chip.dataset.scale) || 2;
    renderScales();
  });

  startBtn.addEventListener('click', () => {
    void run();
  });

  cancelBtn.addEventListener('click', async () => {
    if (!state.jobId) return;
    try {
      await api.cancelJob(state.jobId);
      statusEl.textContent = '已请求取消…';
    } catch (err) {
      toastError(err, '取消失败');
    }
  });

  resultEl.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn || !state.result) return;
    if (btn.dataset.act === 'adopt') {
      const name = `${(state.result.filename || 'upscaled').replace(/\.[^.]+$/, '')}-${state.scale}x.png`;
      const ok = await onAdopt?.(state.result.url, name);
      if (ok) modal.close();
      return;
    }
    onCompare?.(state.result.url);
  });

  renderScales();
  renderEngines();

  (async () => {
    try {
      const data = await api.upscaleModels();
      if (disposed) return;
      const engines = Object.values(data.engines || {}).filter((engine) => engine.ready);
      state.engines = engines;
      const preferred = data.default_engine || engines[0]?.id || '';
      state.engine = engines.some((engine) => engine.id === preferred) ? preferred : engines[0]?.id || '';
      const fallback = Number(data.defaults?.scale);
      if ([2, 4].includes(fallback)) state.scale = fallback;
      const size = getSize?.();
      if (size?.width) hintEl.textContent = `当前画面 ${size.width} × ${size.height}，将按 ${state.scale}× 放大；结果需确认后才替换主图。`;
      renderEngines();
      renderScales();
    } catch (err) {
      if (disposed) return;
      enginesEl.innerHTML = '<span class="field-hint">读取放大模型失败，请确认服务已启动。</span>';
      hintEl.textContent = err?.message || String(err);
    }
  })();

  return modal;
}
