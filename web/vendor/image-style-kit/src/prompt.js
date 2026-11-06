/** 把创意预设、MJ 参数与视角合成为最终提示词。 */
import { composeCreativePrompt } from './creative.js';
import { normalizeMidjourneyPrompt } from './mjPrompt.js';
import { imageAnglePrompt } from './imageAngle.js';

export function buildNodePrompt(prompt, node = {}) {
  const composed = composeCreativePrompt(prompt, node.creativePresets, node.type || 'Image');
  const normalized = normalizeMidjourneyPrompt(composed);
  return [normalized, imageAnglePrompt(node.imageAngle)].filter(Boolean).join('\n');
}

export default buildNodePrompt;
