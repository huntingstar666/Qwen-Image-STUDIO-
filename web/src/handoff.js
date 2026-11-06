/**
 * 跨页面交接（图像处理 → 图像编辑）。
 * 用途：
 * 1. 「送入图生图」：把当前处理结果作为编辑页第 1 张图；
 * 2. 「扩图 → 去局部重绘」：带上扩图后的画布、遮罩与预填提示词。
 * 数据只停留在一个内存槽里，编辑页消费一次即清空，避免页面切换时反复注入。
 */

let pending = null;

/**
 * @param {{
 *   images: Array<{dataUrl:string, name?:string}>,
 *   mask?: string|null,
 *   prompt?: string|null,
 *   localEnabled?: boolean,
 *   toast?: string
 * }} payload
 */
export function setHandoff(payload) {
  if (!payload || !Array.isArray(payload.images) || !payload.images.length) {
    throw new Error('交接数据缺少图片');
  }
  pending = {
    images: payload.images,
    mask: payload.mask || null,
    prompt: payload.prompt ?? null,
    localEnabled: payload.localEnabled ?? null,
    toast: payload.toast || '已接收图像处理结果',
  };
}

export function consumeHandoff() {
  const payload = pending;
  pending = null;
  return payload;
}

export function peekHandoff() {
  return pending;
}

/** 切到图像编辑页（页面存在时走 hash 路由）。 */
export function goToEditPage() {
  location.hash = 'edit';
}
