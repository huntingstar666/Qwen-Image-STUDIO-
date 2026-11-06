/** 框架无关的 HTTP handler（可直接挂到 node:http）与本地路径解析。 */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { ImageEditingError } from './core.js';

export function createPathResolver(roots = []) {
  const allowed = roots.map((root) => path.resolve(root));
  return async (source) => {
    if (typeof source !== 'string' || !source.trim()) throw new ImageEditingError('缺少图片地址');
    const resolved = path.resolve(source);
    if (!allowed.length) return resolved;
    const real = await realpath(resolved).catch(() => resolved);
    if (!allowed.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
      throw new ImageEditingError('图片路径不在允许的目录内', 403);
    }
    return real;
  };
}

async function parseBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ImageEditingError('请求体必须是合法 JSON');
  }
}

function send(response, status, payload) {
  const data = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  response.end(data);
}

/**
 * @param {object} options
 * @param {ReturnType<import('./core.js').createImageEditingService>} options.service
 * @param {(source: string) => Promise<string>} [options.resolveSource]
 * @param {string} [options.prefix] 默认 /api
 */
export function createImageEditingHandler({ service, resolveSource = async (source) => source, prefix = '/api' }) {
  const routes = {
    [`${prefix}/media/images/crop`]: (payload) => service.crop(payload),
    [`${prefix}/media/images/grid`]: (payload) => service.grid(payload),
  };
  return async function handle(request, response) {
    const pathname = (request.url || '').split('?')[0];
    const route = routes[pathname];
    if (!route) return send(response, 404, { error: '未找到接口', code: 'NOT_FOUND' });
    if (request.method !== 'POST') return send(response, 405, { error: '只支持 POST', code: 'METHOD_NOT_ALLOWED' });
    try {
      const payload = await parseBody(request);
      const source = await resolveSource(String(payload.source || payload.imagePath || ''));
      const result = await route({ ...payload, source });
      if (Array.isArray(result)) send(response, 201, { success: true, assets: result });
      else send(response, 201, { success: true, asset: result });
    } catch (error) {
      const status = error instanceof ImageEditingError ? error.status : 500;
      if (status >= 500) service.logger?.error?.('image editing error', error);
      send(response, status, { error: error?.message || '图片处理失败', code: error?.code || 'IMAGE_EDIT_FAILED' });
    }
  };
}

export default createImageEditingHandler;
