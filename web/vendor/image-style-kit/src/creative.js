/**
 * 风格 / 运镜 / 滤镜预设（Creative Presets）。
 *
 * 与宿主画布的数据兼容：节点上的 `creativePresets` 直接保存预设快照，
 * 因此导入项目不依赖远端预设 ID。
 */

export const CREATIVE_KINDS = Object.freeze(['style', 'motion', 'filter']);
export const CREATIVE_SLOTS = Object.freeze(['style', 'motion', 'filter', 'custom']);

/** @typedef {'style'|'motion'|'filter'} CreativeKind */
/**
 * @typedef {object} CreativePreset
 * @property {string} id
 * @property {CreativeKind} kind
 * @property {string} category
 * @property {string} name
 * @property {string} description
 * @property {string} prompt
 * @property {string} [prefix]
 * @property {string} [preview]
 * @property {string} [poster]
 */

/** @param {unknown} value */
export function validCreativePreset(value) {
  if (!value || typeof value !== 'object') return false;
  const preset = /** @type {CreativePreset} */ (value);
  return (
    typeof preset.id === 'string' &&
    preset.id.length <= 100 &&
    CREATIVE_KINDS.includes(preset.kind) &&
    typeof preset.name === 'string' &&
    preset.name.length > 0 &&
    preset.name.length <= 80 &&
    typeof preset.prompt === 'string' &&
    preset.prompt.length <= 12000 &&
    (preset.prefix === undefined || (typeof preset.prefix === 'string' && preset.prefix.length <= 12000))
  );
}

/** @param {unknown} value */
export function creativeSelection(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, preset]) => CREATIVE_SLOTS.includes(key) && validCreativePreset(preset)),
  );
}

/**
 * 组合最终提示词：前缀在上，用户提示词居中，预设描述在后。
 * 与原实现一致：图片只用 style/filter/custom，视频额外叠加 motion。
 * @param {string} prompt
 * @param {unknown} value 节点上的 creativePresets
 * @param {string} type 节点类型（Image / Video）
 */
export function composeCreativePrompt(prompt, value, type) {
  if (!['image', 'video'].includes(String(type).toLowerCase())) return prompt;
  const selected = creativeSelection(value);
  const entries = [
    selected.style,
    selected.filter,
    ...(String(type).toLowerCase() === 'video' ? [selected.motion] : []),
    selected.custom,
  ].filter(Boolean);
  return [
    ...entries.map((preset) => preset.prefix?.trim()).filter(Boolean),
    prompt,
    ...entries.map((preset) => preset.prompt.trim()).filter(Boolean),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 生成一个稳定的自定义预设 id。 */
export function createCustomPresetId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 默认的收藏 / 自定义预设存储（localStorage）。
 * 宿主可以传入自己的 storage（load/save）覆盖。
 */
export function createLocalCreativeStorage({ key = 'media-generation.creative-library', storage } = {}) {
  const target = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  return {
    async load() {
      if (!target) return { favorites: [], custom: [] };
      try {
        const parsed = JSON.parse(target.getItem(key) || '{}');
        return {
          favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((id) => typeof id === 'string') : [],
          custom: Array.isArray(parsed.custom) ? parsed.custom.filter(validCreativePreset) : [],
        };
      } catch {
        return { favorites: [], custom: [] };
      }
    },
    async save(value) {
      if (target) target.setItem(key, JSON.stringify(value));
      return value;
    },
  };
}

