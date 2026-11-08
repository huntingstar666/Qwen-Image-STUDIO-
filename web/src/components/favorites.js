/**
 * 收藏（写入素材仓库）的共用逻辑。
 * 结果卡片、历史详情、作品画廊都走这里，保证字段与提示文案一致。
 */

import { api } from '../api.js';
import { toastError, toastSuccess, toastWarn } from './toast.js';

export const KIND_LABELS = {
  t2i: '文生图',
  edit: '图生图',
  upscale: '高清放大',
  upload: '本地素材',
  studio: '精修',
};

export const CATEGORY_PRESETS = ['未分类', '人像', '风景', '产品', '插画', '概念', '建筑', '纹理'];

const inFlight = new Set();

/**
 * 把一张图片收藏进素材仓库。
 * @param {object} options
 * @param {string} options.image 图片地址（/files/... 或 dataURL）
 * @param {string} [options.prompt]
 * @param {string} [options.negativePrompt]
 * @param {number|null} [options.seed]
 * @param {'t2i'|'edit'|'upload'|'studio'} [options.kind]
 * @param {string} [options.category]
 * @param {object} [options.params]
 * @param {Array<string|{dataUrl?:string,url?:string}>} [options.referenceImages]
 * @param {string} [options.source]
 * @param {string} [options.sourceRef]
 * @param {string} [options.title]
 * @returns {Promise<object|false>} 成功时返回素材记录
 */
export async function favoriteImage({
  image,
  prompt = '',
  negativePrompt = '',
  seed = null,
  kind = 't2i',
  category = '未分类',
  params = {},
  referenceImages = [],
  source = 'result',
  sourceRef = '',
  title = '',
} = {}) {
  if (!image) {
    toastWarn('这张图片没有可保存的地址');
    return false;
  }
  const key = `${kind}:${image.slice(0, 120)}`;
  if (inFlight.has(key)) {
    toastWarn('这张图片正在收藏中，请稍候');
    return false;
  }
  inFlight.add(key);
  try {
    const refs = (referenceImages || [])
      .map((ref) => (typeof ref === 'string' ? ref : ref?.dataUrl || ref?.url || ''))
      .filter(Boolean)
      .slice(0, 3);
    const data = await api.createMaterial({
      title: title || '',
      category: category || '未分类',
      kind,
      prompt,
      negativePrompt,
      seed,
      params,
      image,
      referenceImages: refs,
      source,
      sourceRef,
    });
    toastSuccess('已收藏到素材仓库');
    return data?.item || false;
  } catch (err) {
    toastError(err, '收藏失败');
    return false;
  } finally {
    inFlight.delete(key);
  }
}
