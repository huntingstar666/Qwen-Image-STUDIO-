/**
 * 历史记录类型注册表。
 * 历史页的分类 chip、卡片标签、详情标题都从这里读取；
 * 后续新增任务类型（例如全景、放大更多引擎）只需在这里加一行。
 */

export const HISTORY_KINDS = [
  { id: 'all', label: '全部', source: 'all' },
  { id: 't2i', label: '文生图', source: 'job' },
  { id: 'edit', label: '图像编辑', source: 'job' },
  { id: 'upscale', label: '高清放大', source: 'job' },
  { id: 'gif', label: '动图', source: 'job' },
  // 主体分割是工具内部步骤，仍保留标签，但不单独占一个分类 chip。
  { id: 'segment', label: '主体分割', source: 'job', hidden: true },
  { id: 'studio', label: '精修工程', source: 'project' },
];

export const HISTORY_KIND_LABELS = Object.fromEntries(
  HISTORY_KINDS.map((item) => [item.id, item.label]),
);

export function historyKindLabel(kind) {
  return HISTORY_KIND_LABELS[kind] || '其他';
}

// 始终展示的核心分类；其余类型有数据时再自动出现，避免空 chip 占位。
const ALWAYS_VISIBLE = new Set(['all', 't2i', 'edit', 'studio']);

/**
 * @param {Record<string, number>} [counts]
 * @returns {Array<{id:string,label:string,source:string}>}
 */
export function visibleHistoryKinds(counts = {}) {
  return HISTORY_KINDS.filter(
    (kind) => !kind.hidden && (ALWAYS_VISIBLE.has(kind.id) || (counts[kind.id] || 0) > 0),
  );
}
