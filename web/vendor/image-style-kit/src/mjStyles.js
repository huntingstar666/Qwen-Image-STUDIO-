/**
 * MJ 码图馆数据逻辑（与原 `mjStyles.ts` 对齐）。
 */
import { removeMidjourneyPreview } from './mjPrompt.js';

export const mjCategoryGroups = Object.freeze([
  {
    name: '东方古风',
    categories: ['东方古风·武侠', '东方神话·仙侠奇观', '东方古装·史诗', '古风室内·殿堂楼阁', '古镇村落·俯瞰', '仙侠天宫·奇观', '古建·祠庙宫殿'],
  },
  {
    name: '现代影像',
    categories: ['现代都市·电影人文', '现代写实人像·生活流', '时尚编辑·商业广告', '日韩系·影像', '现代都市·街景', '现代室内·生活空间'],
  },
  {
    name: '科幻幻想',
    categories: ['科幻·机甲', '游戏CG·动漫角色', '东方赛博·武侠朋克', '西方奇幻·神话史诗', '科幻·未来场景', '西幻·城堡秘境'],
  },
  { name: '自然氛围', categories: ['自然奇观·山水云海', '光影空镜·氛围', '风格化与实验'] },
  { name: '暗黑废墟', categories: ['国风暗黑·志怪恐怖', '废墟·古代战场', '废墟末世·战场', '暗黑异兽·克苏鲁'] },
  {
    name: '巨物传说',
    categories: ['巨物·尺度压迫', '巨型机甲·超级机器人', '怪兽特摄·哥斯拉系', '超尺度奇观·巨物崇拜', '东方神龙·仙兽', '西方巨龙·翼兽', '深海巨兽·海怪', '上古神祇·泰坦巨人'],
  },
]);

export const MJ_INSERT_MODES = Object.freeze([
  ['style', '风格码'],
  ['parameters', '参数'],
  ['full', '完整提示词'],
  ['vibe', '氛围描述'],
]);

/**
 * @typedef {object} MjStyle
 * @property {string} id
 * @property {string} group
 * @property {string} category
 * @property {string} name
 * @property {boolean} mixed
 * @property {string} medium
 * @property {string} codes
 * @property {string} parameters
 * @property {string} prompt
 * @property {string} vibe
 * @property {string} thumbnail
 * @property {string} preview
 */

/**
 * 按插入模式取文本。
 * @param {MjStyle} item
 * @param {'style'|'parameters'|'full'|'vibe'} mode
 */
export function mjStyleText(item, mode) {
  const text =
    mode === 'full'
      ? item.prompt
      : mode === 'vibe'
        ? item.vibe
        : [item.vibe, mode === 'parameters' ? item.parameters : item.codes].filter(Boolean).join('\n');
  return removeMidjourneyPreview(text);
}

/**
 * 转成风格库可用的 CreativePreset 快照。
 * @param {MjStyle} item
 * @param {string} text
 */
export function mjStylePreset(item, text) {
  return {
    id: `mj-${item.id}`,
    kind: 'style',
    category: item.category,
    name: `MJ · ${item.name}`,
    description: item.vibe,
    prompt: removeMidjourneyPreview(text),
    preview: item.thumbnail,
    mjStyle: { codes: item.codes, parameters: item.parameters, mixed: item.mixed },
  };
}

/**
 * 搜索 / 分类过滤。
 * @param {MjStyle[]} items
 * @param {string} group
 * @param {string} category
 * @param {string} query
 * @param {string} codeKind 'all' | 'mixed' | 'pure'
 */
export function filterMjStyles(items, group, category, query, codeKind) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(
    (item) =>
      (group === 'all' || item.group === group) &&
      (category === '全部' || item.category === category) &&
      (codeKind === 'all' || item.mixed === (codeKind === 'mixed')) &&
      words.every((word) =>
        [item.id, item.name, item.category, item.codes, item.vibe, item.medium, item.prompt]
          .join(' ')
          .toLowerCase()
          .includes(word),
      ),
  );
}

