/** 定格工坊 API 封装。所有请求同源（8720），错误统一抛带 status 的 Error。 */

async function request(path, { method = 'GET', body, headers } = {}) {
  const options = { method, headers: { ...(headers || {}) } };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!response.ok) {
    const message = (data && data.error && data.error.message)
      || (data && data.detail)
      || `HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

function runPath(id, suffix = '') {
  return `/api/loop/runs/${encodeURIComponent(id)}${suffix}`;
}

export const api = {
  health: () => request('/api/loop/health'),
  options: () => request('/api/loop/options'),
  listRuns: (limit = 40) => request(`/api/loop/runs?limit=${limit}`),
  getRun: (id) => request(runPath(id)),

  createRun(file, idea, settings, engine) {
    const form = new FormData();
    form.append('file', file, file.name || 'reference.png');
    form.append('idea', idea);
    form.append('settings', JSON.stringify(settings || {}));
    form.append('engine', engine || 'mock');
    return request('/api/loop/runs', { method: 'POST', body: form });
  },

  createSheetRun(file, settings, grid) {
    const form = new FormData();
    form.append('file', file, file.name || 'sheet.png');
    form.append('settings', JSON.stringify(settings || {}));
    form.append('rows', String(grid.rows));
    form.append('columns', String(grid.columns));
    form.append('row_gap', String(grid.rowGap));
    form.append('column_gap', String(grid.columnGap));
    form.append('order', grid.order);
    form.append('trim', grid.trim);
    return request('/api/loop/runs/sheet', { method: 'POST', body: form });
  },

  importPhotos(files, settings, prompts, name) {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name || 'photo.png');
    form.append('settings', JSON.stringify(settings || {}));
    form.append('prompts', JSON.stringify(prompts || []));
    form.append('name', name || '');
    return request('/api/loop/runs/import-photos', { method: 'POST', body: form });
  },

  fromMaterials(ids, settings, prompts, name) {
    return request('/api/loop/runs/from-materials', {
      method: 'POST',
      body: { ids, settings: settings || {}, prompts: prompts || [], name: name || '' },
    });
  },

  createPipeline(file, settings, grid, prompts, autoStart, name) {
    const form = new FormData();
    form.append('file', file, file.name || 'sheet.png');
    form.append('settings', JSON.stringify(settings || {}));
    form.append('rows', String(grid.rows));
    form.append('columns', String(grid.columns));
    form.append('row_gap', String(grid.rowGap));
    form.append('column_gap', String(grid.columnGap));
    form.append('order', grid.order);
    form.append('trim', grid.trim);
    form.append('prompts', JSON.stringify(prompts || []));
    form.append('auto_start', autoStart ? 'true' : 'false');
    form.append('name', name || '');
    return request('/api/loop/runs/pipeline', { method: 'POST', body: form });
  },

  plan: (id) => request(runPath(id, '/plan'), { method: 'POST' }),
  setPrompts: (id, prompts) => request(runPath(id, '/prompts'), { method: 'POST', body: { prompts } }),
  start: (id) => request(runPath(id, '/start'), { method: 'POST' }),
  cancel: (id) => request(runPath(id, '/cancel'), { method: 'POST' }),
  approve: (id) => request(runPath(id, '/approve'), { method: 'POST' }),

  exportRun(id, fps, exportOptions, extras) {
    return request(runPath(id, '/export'), {
      method: 'POST',
      body: { fps, export: exportOptions || {}, ...(extras || {}) },
    });
  },

  patchFrame: (id, index, payload) => request(
    runPath(id, `/frames/${index}`), { method: 'PATCH', body: payload },
  ),

  // payload 支持 { prompt, reference, settings }；传字符串等价于 { prompt }
  retryFrame: (id, index, payload) => request(
    runPath(id, `/frames/${index}/retry`),
    { method: 'POST', body: typeof payload === 'string' ? { prompt: payload } : (payload || {}) },
  ),

  runPipeline: (id, payload) => request(runPath(id, '/pipeline'), { method: 'POST', body: payload || {} }),

  patchTimeline: (id, timeline) => request(runPath(id, '/timeline'), {
    method: 'PATCH', body: timeline || {},
  }),

  reorderFrames: (id, order) => request(runPath(id, '/frames/order'), {
    method: 'POST', body: { order },
  }),

  deleteFrame: (id, index) => request(runPath(id, `/frames/${index}`), { method: 'DELETE' }),

  restoreFrame: (id, index) => request(runPath(id, `/frames/${index}/restore`), { method: 'POST' }),

  library({ kind = '', category = '', q = '', limit = 120 } = {}) {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    return request(`/api/loop/library?${params.toString()}`);
  },
};

/** 运行产物（帧图 / GIF / 报告）都挂在 /files 下。 */
export function fileUrl(runId, relative) {
  if (!relative) return '';
  if (relative.startsWith('/') || relative.startsWith('http')) return relative;
  return `/files/${encodeURIComponent(runId)}/${relative}`;
}

export function reportUrl(runId) {
  return `/files/${encodeURIComponent(runId)}/report.html`;
}
