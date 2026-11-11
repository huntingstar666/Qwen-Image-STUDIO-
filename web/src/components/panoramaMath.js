/**
 * 全景相关的纯函数（无 DOM，可单测）。
 * 只负责三件事：判断能不能用全景查看器、360° 尺寸档、360° 提示词补全。
 */

/** 宽度 / 高度 达到这个比例，就认为值得提供「全景查看」入口（覆盖 2:1 及以上宽幅）。 */
export const PANORAMA_ASPECT_MIN = 1.9;

/** 文生图的 360° 尺寸档：固定 2:1，长边 2048 / 3072。 */
export const SPHERE_SIZES = [
  { id: '360-2k', label: '2K', width: 2048, height: 1024 },
  { id: '360-3k', label: '3K', width: 3072, height: 1536 },
];

/** 等距柱状提示词模板：只在用户没写 360 / equirect 关键词时补。 */
export const SPHERE_PROMPT =
  '360-degree equirectangular panorama photograph, full spherical view, '
  + 'seamless left and right edges, complete ceiling and floor, '
  + 'no duplicated subjects, photorealistic';

export function isPanoramaAspect(width, height, min = PANORAMA_ASPECT_MIN) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return false;
  return w / h >= min;
}

export function isSphereSizeId(id) {
  return SPHERE_SIZES.some((size) => size.id === id);
}

export function findSphereSize(id) {
  return SPHERE_SIZES.find((size) => size.id === id) || null;
}

/** 追加等距柱状提示词；已有相关关键词时不重复写。 */
export function withSpherePrompt(prompt, enabled = true) {
  const text = String(prompt || '').trim();
  if (!enabled) return text;
  if (/equirect|等距柱状|360\s*°/i.test(text)) return text;
  return text ? `${text}, ${SPHERE_PROMPT}` : SPHERE_PROMPT;
}
