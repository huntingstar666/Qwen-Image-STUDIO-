/** Express 接入：把 service 暴露成 /media/images/crop 与 /media/images/grid。 */
import { ImageEditingError } from './core.js';

export function createImageEditingRouter({ service, express, resolveSource = async (source) => source, prefix = '/api' }) {
  if (!express?.Router) throw new Error('createImageEditingRouter 需要传入 express');
  const app = express.Router();
  const wrap = (run) => async (request, response) => {
    try {
      const payload = { ...(request.body || {}) };
      payload.source = await resolveSource(String(payload.source || payload.imagePath || ''));
      const result = await run(payload);
      response.status(201).json(Array.isArray(result) ? { success: true, assets: result } : { success: true, asset: result });
    } catch (error) {
      const status = error instanceof ImageEditingError ? error.status : 500;
      if (status >= 500) service.logger?.error?.('image editing error', error);
      response.status(status).json({ error: error?.message || '图片处理失败', code: error?.code || 'IMAGE_EDIT_FAILED' });
    }
  };
  app.post(`${prefix}/media/images/crop`, wrap((payload) => service.crop(payload)));
  app.post(`${prefix}/media/images/grid`, wrap((payload) => service.grid(payload)));
  return app;
}

export default createImageEditingRouter;
