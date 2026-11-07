// 统一请求层：与主项目 web/src/api.js 一致——错误归一化、超时、任务轮询。

export class ApiError extends Error {
  constructor(message, { code = 'request_failed', status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, timeout = 120000 } = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = null; }
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.detail || `请求失败（${response.status}）`;
      throw new ApiError(message, { code: payload?.error?.code || 'http_error', status: response.status });
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') throw new ApiError('请求超时，请重试', { code: 'timeout' });
    throw new ApiError(error?.message || '网络错误', { code: 'network_error' });
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  health: () => request('/api/health'),
  options: () => request('/api/options'),

  projects: () => request('/api/projects'),
  createProject: (payload) => request('/api/projects', { method: 'POST', body: payload }),
  getProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`),
  saveProject: (id, project) => request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT', body: { project },
  }),
  deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  importSheet: (payload) => request('/api/import/sheet', { method: 'POST', body: payload, timeout: 180000 }),
  importFrames: (payload) => request('/api/import/frames', { method: 'POST', body: payload, timeout: 180000 }),

  align: (payload) => request('/api/align', { method: 'POST', body: payload, timeout: 180000 }),
  colorMatch: (payload) => request('/api/color-match', { method: 'POST', body: payload, timeout: 180000 }),
  colorRevert: (payload) => request('/api/color-match/revert', { method: 'POST', body: payload }),

  exportAnimation: (payload) => request('/api/export', { method: 'POST', body: payload, timeout: 120000 }),
  job: (id) => request(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id) => request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  history: (limit = 20) => request(`/api/history?limit=${limit}`),
};

export function pollJob(jobId, onUpdate, { interval = 350, timeout = 600000 } = {}) {
  const started = Date.now();
  let stopped = false;
  let timer = 0;

  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const job = await api.job(jobId);
      onUpdate?.(job);
      if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
        stop();
        return;
      }
    } catch (error) {
      onUpdate?.({ status: 'error', error: error.message });
      stop();
      return;
    }
    if (Date.now() - started > timeout) {
      onUpdate?.({ status: 'error', error: '任务超时，请稍后在历史记录中查看' });
      stop();
      return;
    }
    timer = window.setTimeout(tick, interval);
  };

  timer = window.setTimeout(tick, 120);
  return { stop };
}
