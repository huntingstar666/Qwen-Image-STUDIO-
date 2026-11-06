/**
 * 扩图（outpaint）公共逻辑：图像处理页与图像编辑页共用。
 * 职责：
 * 1. POST /api/image/outpaint-plan 拿画布规划；
 * 2. 用 Canvas 把原图贴到规划出来的 offset 上，并生成「白=新增区域」的遮罩；
 * 3. 调 vendor 的 image-tools-kit/prompt.js 生成扩图/全景提示词。
 */

import { api } from './api.js';
import { loadImage } from './utils.js';

export const OUTPAINT_DIRECTION_LABELS = {
  left: '向左',
  right: '向右',
  up: '向上',
  down: '向下',
  horizontal: '左右',
  vertical: '上下',
  all: '四周',
};

export const OUTPAINT_DIRECTIONS = ['left', 'right', 'up', 'down', 'horizontal', 'vertical', 'all'];

let promptKitPromise = null;

async function loadPromptKit() {
  if (!promptKitPromise) {
    promptKitPromise = import('/vendor/image-tools-kit/src/prompt.js').catch((err) => {
      console.warn('[outpaint] prompt 模块加载失败', err);
      promptKitPromise = null;
      return null;
    });
  }
  return promptKitPromise;
}

/** 请求扩图规划（canvas / pad / offset / source）。 */
export async function requestOutpaintPlan({ width, height, direction = 'right', amount = 0.5 }) {
  if (!width || !height) throw new Error('缺少原图尺寸，无法规划扩图');
  return api.outpaintPlan({ width, height, direction, amount });
}

/**
 * 把原图贴到扩图画布上，并生成遮罩。
 * @param {string} srcDataUrl
 * @param {object} plan 服务端返回的规划
 * @returns {Promise<{canvas:HTMLCanvasElement, maskCanvas:HTMLCanvasElement, dataUrl:string, maskDataUrl:string,
 *   width:number, height:number, sourceRect:{x:number,y:number,width:number,height:number}}>}
 */
export async function renderOutpaintCanvas(srcDataUrl, plan) {
  const image = await loadImage(srcDataUrl);
  const width = Math.max(1, Math.round(Number(plan?.canvas?.w) || image.naturalWidth));
  const height = Math.max(1, Math.round(Number(plan?.canvas?.h) || image.naturalHeight));
  const sourceW = Math.max(1, Math.round(Number(plan?.source?.w) || image.naturalWidth));
  const sourceH = Math.max(1, Math.round(Number(plan?.source?.h) || image.naturalHeight));
  const offsetX = Math.round(Number(plan?.offset?.x) || 0);
  const offsetY = Math.round(Number(plan?.offset?.y) || 0);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, offsetX, offsetY, sourceW, sourceH);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const mctx = maskCanvas.getContext('2d');
  mctx.fillStyle = '#ffffff';
  mctx.fillRect(0, 0, width, height);
  mctx.fillStyle = '#000000';
  mctx.fillRect(offsetX, offsetY, sourceW, sourceH);

  return {
    canvas,
    maskCanvas,
    dataUrl: canvas.toDataURL('image/png'),
    maskDataUrl: maskCanvas.toDataURL('image/png'),
    width,
    height,
    sourceRect: { x: offsetX, y: offsetY, width: sourceW, height: sourceH },
  };
}

/** 生成扩图提示词（全景方向使用 vendor 的 panoramaPrompt）。 */
export async function buildOutpaintPrompt(direction = 'right') {
  const label = OUTPAINT_DIRECTION_LABELS[direction] || '四周';
  const kit = await loadPromptKit();
  if (!kit) {
    return `扩图（${label}）：保持原图主体、身份、光照、材质与画面风格一致，自然补全${label}新增区域，边缘无缝衔接，避免接缝、拉伸与重复主体；不添加文字、水印或边框。`;
  }
  if (direction === 'all' && kit.panoramaPrompt) return kit.panoramaPrompt;
  const angle = kit.outpaintDirections?.[direction] || null;
  let draftPrompt = '';
  try {
    draftPrompt = kit.buildOutpaintDraft({ url: 'local://image' }, { angle, title: '扩图' })?.prompt || '';
  } catch {
    draftPrompt = '';
  }
  const angleText = kit.angleLabel && angle ? kit.angleLabel(angle) : '';
  return [
    draftPrompt,
    `扩图方向：${label}。保持原图主体、身份、光照、材质与画面风格一致，自然补全新增区域，边缘无缝衔接，避免接缝、拉伸与重复主体；不添加文字、水印或边框。${
      angleText ? `（参考视角：${angleText}）` : ''
    }`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 一次完成：请求规划 → 渲染画布/遮罩 → 生成提示词。 */
export async function planOutpaint({ srcDataUrl, width, height, direction = 'right', amount = 0.5 }) {
  const plan = await requestOutpaintPlan({ width, height, direction, amount });
  const rendered = await renderOutpaintCanvas(srcDataUrl, plan);
  const prompt = await buildOutpaintPrompt(direction);
  return { plan, prompt, ...rendered };
}
