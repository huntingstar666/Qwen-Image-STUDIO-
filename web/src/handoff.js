/**
 * 跨页面交接。
 * 用途：
 * 1. 「送入图生图」：把当前处理结果作为编辑页第 1 张图；
 * 2. 「扩图 → 去局部重绘」：带上扩图后的画布、遮罩与预填提示词；
 * 3. 「作品画廊 / 素材仓库 → 文生图」：把提示词、种子、尺寸带到工作台；
 * 4. 「素材仓库 → 图片精修」：把已收藏的图片作为精修文档打开。
 * 数据只停留在一个内存槽里，目标页消费一次即清空，避免页面切换时反复注入。
 */

let pending = null;
let pendingT2I = null;
let pendingStudio = null;

/**
 * @param {{
 *   images: Array<{dataUrl:string, name?:string}>,
 *   mask?: string|null,
 *   prompt?: string|null,
 *   localEnabled?: boolean|null,
 *   taskMode?: string|null,
 *   panorama?: {aspect?:string, long_side?:number, wrap?:boolean, seam_blend?:number}|null,
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
    taskMode: payload.taskMode || null,
    panorama: payload.panorama && typeof payload.panorama === 'object' ? payload.panorama : null,
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

/* ---------------------------------------------------------------- 文生图 */

/**
 * 把一条提示词交接给文生图工作台。
 * @param {{prompt?:string, negativePrompt?:string, seed?:number|null,
 *          width?:number|null, height?:number|null, title?:string, toast?:string}} payload
 */
export function setT2IHandoff(payload = {}) {
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('交接数据缺少提示词');
  pendingT2I = {
    prompt,
    negativePrompt: String(payload.negativePrompt || '').trim(),
    seed: Number.isFinite(Number(payload.seed)) && payload.seed !== null && payload.seed !== ''
      ? Math.max(0, Math.floor(Number(payload.seed)))
      : null,
    width: Number(payload.width) > 0 ? Math.round(Number(payload.width)) : null,
    height: Number(payload.height) > 0 ? Math.round(Number(payload.height)) : null,
    title: String(payload.title || '').trim(),
    toast: payload.toast || '提示词已发送到文生图工作台',
  };
}

export function consumeT2IHandoff() {
  const payload = pendingT2I;
  pendingT2I = null;
  return payload;
}

export function goToT2IPage() {
  location.hash = 't2i';
}

/* ---------------------------------------------------------------- 图片精修 */

/**
 * 把一张图片交给图片精修工作台打开。
 * @param {{url:string, name?:string, title?:string, toast?:string}} payload
 */
export function setStudioHandoff(payload = {}) {
  const url = String(payload.url || '').trim();
  if (!url) throw new Error('交接数据缺少图片');
  pendingStudio = {
    url,
    name: String(payload.name || '').trim(),
    title: String(payload.title || '').trim(),
    toast: payload.toast || '已在图片精修中打开',
  };
}

export function consumeStudioHandoff() {
  const payload = pendingStudio;
  pendingStudio = null;
  return payload;
}

export function goToStudioPage() {
  location.hash = 'studio';
}
