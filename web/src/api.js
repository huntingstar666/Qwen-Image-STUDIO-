/**
 * 后端 HTTP 接口封装（同源，相对路径 /api/...）。
 * 职责：
 * 1. 统一 fetch + JSON 解析 + 超时；
 * 2. 把后端 {"error":{"code","message"}} 与网络失败统一转成中文 ApiError；
 * 3. 提供任务轮询 pollJob（700ms 一次，符合契约）。
 * 所有页面只能通过本文件访问后端，便于错误提示集中处理。
 */

/** 与后端契约一致：错误统一为中文可读消息。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = null, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

const DEFAULT_TIMEOUT = 20000;

async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ApiError(`请求超时：${path}（超过 ${Math.round(timeout / 1000)} 秒）`, { path });
    }
    throw new ApiError('无法连接后端服务，请确认 127.0.0.1:8700 已启动（服务未就绪）', { path });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let message = `请求失败：HTTP ${response.status}`;
    let code = null;
    try {
      const data = await response.json();
      if (data?.error?.message) message = data.error.message;
      code = data?.error?.code ?? null;
    } catch {
      // 非 JSON 错误体（例如静态文件 404），保留 HTTP 状态提示
    }
    throw new ApiError(message, { status: response.status, code, path });
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

export const api = {
  /** GET /api/health —— 引擎 / Ollama / 队列 */
  health() {
    return request('/api/health', { timeout: 8000 });
  },

  /** GET /api/meta —— 版本号 + 编辑预设摘要（预设数值唯一来源） */
  meta() {
    return request('/api/meta', { timeout: 15000 });
  },

  /** GET /api/options —— 模型、采样器、比例、turbo profile */
  options() {
    return request('/api/options', { timeout: 30000 });
  },

  /** GET /api/presets/config —— 预设出厂值 / 全局默认值 / 自定义搭配 */
  presetConfig() {
    return request('/api/presets/config', { timeout: 15000 });
  },

  /** POST /api/presets/config —— 保存预设默认值与自定义搭配 */
  savePresetConfig(payload) {
    return request('/api/presets/config', {
      method: 'POST',
      body: payload || {},
      timeout: 20000,
    });
  },

  /** GET /api/styles —— 风格库目录（creative / mj / mjGroups / insertModes） */
  styles() {
    return request('/api/styles', { timeout: 30000 });
  },

  /** GET /api/styles/angle-prompt —— 视角描述（优先用 vendor 纯函数，这里作为兜底） */
  anglePrompt({ azimuth, elevation, zoom }) {
    const params = new URLSearchParams({
      azimuth: String(azimuth),
      elevation: String(elevation),
      zoom: String(zoom),
    });
    return request(`/api/styles/angle-prompt?${params.toString()}`, { timeout: 8000 });
  },

  /** POST /api/polish —— Ollama 提示词润色（可能较慢，给 5 分钟） */
  polish(payload) {
    return request('/api/polish', { method: 'POST', body: payload, timeout: 300000 });
  },

  /** POST /api/generate —— 文生图，返回 {job_id} */
  generate(payload) {
    return request('/api/generate', { method: 'POST', body: payload, timeout: 60000 });
  },

  /** POST /api/edit —— 图像编辑，返回 {job_id} */
  edit(payload) {
    return request('/api/edit', { method: 'POST', body: payload, timeout: 120000 });
  },

  /** GET /api/jobs/{id} */
  job(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}`, { timeout: 15000 });
  },

  /** POST /api/jobs/{id}/cancel */
  cancelJob(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', timeout: 15000 });
  },

  /** GET /api/history?limit= */
  history(limit = 40) {
    return request(`/api/history?limit=${encodeURIComponent(limit)}`, { timeout: 20000 });
  },

  /** DELETE /api/history —— 清空全部历史（后端只提供整体清空） */
  deleteHistory() {
    return request('/api/history', { method: 'DELETE', timeout: 20000 });
  },

  /* ---------------------------------------------------------- 素材仓库 */

  /** GET /api/materials?kind=&category=&q=&limit= */
  materials({ kind = '', category = '', q = '', limit = 200 } = {}) {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (category) params.set('category', category);
    if (q) params.set('q', q);
    params.set('limit', String(limit));
    return request(`/api/materials?${params.toString()}`, { timeout: 20000 });
  },

  /** POST /api/materials —— 收藏一张结果图（图片可以是 /files 路径或 dataURL） */
  createMaterial(payload) {
    return request('/api/materials', { method: 'POST', body: payload, timeout: 120000 });
  },

  /** PATCH /api/materials/{id} —— 修改标题 / 分类 / 备注 / 提示词 / 种子 */
  updateMaterial(materialId, patch) {
    return request(`/api/materials/${encodeURIComponent(materialId)}`, {
      method: 'PATCH',
      body: patch,
      timeout: 20000,
    });
  },

  /** DELETE /api/materials/{id} */
  deleteMaterial(materialId) {
    return request(`/api/materials/${encodeURIComponent(materialId)}`, { method: 'DELETE', timeout: 20000 });
  },

  /** POST /api/materials/upload —— multipart 上传本地图片素材 */
  async uploadMaterial(file, { title = '', category = '' } = {}) {
    const form = new FormData();
    form.append('file', file);
    if (title) form.append('title', title);
    if (category) form.append('category', category);
    const response = await fetch('/api/materials/upload', { method: 'POST', body: form });
    if (!response.ok) {
      let message = `上传失败：HTTP ${response.status}`;
      try {
        const data = await response.json();
        if (data?.error?.message) message = data.error.message;
      } catch {
        // ignore
      }
      throw new ApiError(message, { status: response.status, path: '/api/materials/upload' });
    }
    return response.json();
  },

  /** POST /api/upload —— multipart 上传（当前编辑页直接用 dataURL，保留接口备用） */
  async upload(file) {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/upload', { method: 'POST', body: form });
    if (!response.ok) {
      let message = `上传失败：HTTP ${response.status}`;
      try {
        const data = await response.json();
        if (data?.error?.message) message = data.error.message;
      } catch {
        // ignore
      }
      throw new ApiError(message, { status: response.status, path: '/api/upload' });
    }
    return response.json();
  },

  /** 任务参数 JSON（可复现请求），后端真实接口是 /api/jobs/{id}/replay.json */
  replayUrl(jobId) {
    return `/api/jobs/${encodeURIComponent(jobId)}/replay.json`;
  },

  /** POST /api/image/process —— 图像处理（裁剪/宫格/旋转/翻转/缩放/调色/对齐32） */
  processImage(payload) {
    return request('/api/image/process', { method: 'POST', body: payload, timeout: 120000 });
  },

  /** POST /api/image/outpaint-plan —— 扩图规划（画布/补边/原图偏移） */
  outpaintPlan(payload) {
    return request('/api/image/outpaint-plan', { method: 'POST', body: payload, timeout: 20000 });
  },

  /** GET /api/image/upscale/models —— 放大引擎与模型扫描结果 */
  upscaleModels() {
    return request('/api/image/upscale/models', { timeout: 20000 });
  },

  /** POST /api/image/upscale —— 提交高清放大任务（返回 job_id） */
  upscale(payload) {
    return request('/api/image/upscale', { method: 'POST', body: payload, timeout: 30000 });
  },

  /** GET /api/image/segment/models —— 主体分割模型清单与就绪状态 */
  segmentModels() {
    return request('/api/image/segment/models', { timeout: 20000 });
  },

  /** POST /api/image/segment —— 主体选择（subject / box / points / text；冷启动较慢给足超时） */
  segment(payload) {
    return request('/api/image/segment', { method: 'POST', body: payload, timeout: 180000 });
  },

  /** GET /api/image/tagger/models —— WD14 反推模型清单 */
  taggerModels() {
    return request('/api/image/tagger/models', { timeout: 20000 });
  },

  /** POST /api/image/tagger —— 图片反推标签（首次会下载模型，给足超时） */
  tagImage(payload) {
    return request('/api/image/tagger', { method: 'POST', body: payload, timeout: 600000 });
  },

  /** GET /api/image/watermark/fonts —— 水印可用字体 */
  watermarkFonts() {
    return request('/api/image/watermark/fonts', { timeout: 15000 });
  },

  /** POST /api/image/watermark/preview —— 服务端精确预览（返回 data_url） */
  watermarkPreview(payload) {
    return request('/api/image/watermark/preview', { method: 'POST', body: payload, timeout: 60000 });
  },

  /** POST /api/image/watermark —— 批量加水印（最多 20 张） */
  watermark(payload) {
    return request('/api/image/watermark', { method: 'POST', body: payload, timeout: 180000 });
  },

  /** POST /api/media/upload —— 上传视频（GIF 源，multipart） */
  async uploadVideo(file) {
    const form = new FormData();
    form.append('file', file, file.name || 'video.mp4');
    const response = await fetch('/api/media/upload', { method: 'POST', body: form });
    if (!response.ok) {
      let message = `视频上传失败：HTTP ${response.status}`;
      let code = null;
      try {
        const data = await response.json();
        if (data?.error?.message) message = data.error.message;
        code = data?.error?.code ?? null;
      } catch {
        // ignore
      }
      throw new ApiError(message, { status: response.status, code, path: '/api/media/upload' });
    }
    return response.json();
  },

  /** POST /api/media/video/probe —— 视频时长/分辨率/fps */
  videoProbe(payload) {
    return request('/api/media/video/probe', { method: 'POST', body: payload, timeout: 30000 });
  },

  /** POST /api/media/gif —— 提交 GIF 任务（图片序列或视频，返回 job_id） */
  gif(payload) {
    return request('/api/media/gif', { method: 'POST', body: payload, timeout: 120000 });
  },

  /** POST /api/media/gif/split —— GIF 拆帧为 PNG 结果 */
  splitGif(payload) {
    return request('/api/media/gif/split', { method: 'POST', body: payload, timeout: 180000 });
  },

  /** GET /api/jobs/{id} —— 任务状态 */
  job(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}`, { timeout: 20000 });
  },

  /** POST /api/jobs/{id}/cancel —— 取消任务 */
  cancelJob(jobId) {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: {},
      timeout: 20000,
    });
  },

  /** POST /api/engine/free —— 释放显存（unload=true 卸载模型） */
  engineFree({ unload = true } = {}) {
    return request('/api/engine/free', { method: 'POST', body: { unload }, timeout: 60000 });
  },

  /** POST /api/engine/warmup —— 预加载默认模型（备用） */
  engineWarmup() {
    return request('/api/engine/warmup', { method: 'POST', body: {}, timeout: 300000 });
  },

  /** POST /api/settings —— 运行期设置（显存策略：文本编码器是否常驻） */
  updateSettings(patch) {
    return request('/api/settings', { method: 'POST', body: patch, timeout: 60000 });
  },

  /** GET /api/settings —— 全局设置（模型目录 / LLM / 运行策略 / 扫描摘要） */
  getSettings() {
    return request('/api/settings', { timeout: 30000 });
  },

  /** POST /api/models/scan —— 按当前配置重新扫描模型目录 */
  scanModels() {
    return request('/api/models/scan', { method: 'POST', body: {}, timeout: 60000 });
  },

  /** POST /api/llm/test —— 测试模型服务：列模型 + 一次最小对话 */
  testLlm({ profile = null, profile_id = '', api_key_unchanged = false } = {}) {
    const body = profile ? { profile, api_key_unchanged } : { profile_id };
    return request('/api/llm/test', { method: 'POST', body, timeout: 60000 });
  },

  /** POST /api/ollama/test —— 旧接口：测试 Ollama 连通性并列出模型 */
  testOllama({ url = '' } = {}) {
    return request('/api/ollama/test', { method: 'POST', body: { url }, timeout: 20000 });
  },

  /** 结果图/历史图静态地址（后端返回相对路径，这里做兜底拼接） */
  fileUrl(path) {
    if (!path) return '';
    if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
    return `/files/${path}`;
  },
};

/**
 * 轮询任务状态。
 * @param {string} jobId
 * @param {(job: object) => void} onUpdate 每次拿到新状态时回调
 * @param {{interval?: number}} [options]
 * @returns {Promise<object|null>} 终态任务对象；被 stop() 停止时返回 null
 */
export function pollJob(jobId, onUpdate, { interval = 700 } = {}) {
  let stopped = false;
  let failures = 0;
  const promise = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (stopped) break;
      try {
        const job = await api.job(jobId);
        failures = 0;
        onUpdate?.(job);
        if (job?.status === 'done' || job?.status === 'error' || job?.status === 'canceled') {
          return job;
        }
      } catch (err) {
        failures += 1;
        // 偶发失败容忍 4 次（约 3 秒），持续失败才向上抛
        if (failures >= 4) throw err;
      }
    }
    return null;
  })();
  promise.stop = () => {
    stopped = true;
  };
  return promise;
}
