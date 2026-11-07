/**
 * 图片对比数据组装（D16.2，方案 §15.3）。
 *
 * 不修改 `compare.js`，只把工作室里的候选图整理成它需要的
 * `{ references, results, initialReference }` 结构：
 *   references = 本次结果（可选）+ AI 参考图 + 编辑历史
 *   results    = 当前主图（doc.renderBase 烘焙出的 dataURL）
 *
 * 历史图是 IndexedDB 里的 Blob，取 objectURL 时 pin 住，避免 LRU 回收
 * 把弹窗里正在展示的图片地址释放掉。
 */

import { openCompareDialog } from '../compare.js';
import { toastWarn } from '../toast.js';

function push(list, seen, item, label, meta) {
  if (!item?.url || seen.has(item.url)) return;
  seen.add(item.url);
  list.push({ url: item.url, label, ...meta });
}

export async function openStudioCompare({
  getMain,
  getRefs = () => [],
  getHistory = () => [],
  getHistoryUrl,
  extra = [],
  initialHistoryId = '',
  initialUrl = '',
} = {}) {
  const main = await getMain?.();
  if (!main?.url) {
    toastWarn('请先打开一张主图');
    return null;
  }

  const references = [];
  const seen = new Set();
  for (const item of extra) push(references, seen, item, item.label || '本次结果');
  (getRefs() || []).forEach((ref, index) => {
    const name = String(ref.name || '').replace(/\.[^.]+$/, '');
    push(references, seen, ref, `参考图 ${index + 1}${name ? ` · ${name}` : ''}`);
  });
  for (const entry of getHistory() || []) {
    const url = await getHistoryUrl?.(entry);
    const prompt = String(entry.prompt || '').replace(/\s+/g, ' ').slice(0, 12);
    push(references, seen, { url }, `历史 #${entry.index}${prompt ? ` · ${prompt}` : ''}`, { historyId: entry.id });
  }

  if (!references.length) {
    toastWarn('先添加参考图或完成一次 AI 编辑');
    return null;
  }

  const focusIndex = initialHistoryId
    ? references.findIndex((item) => item.historyId === initialHistoryId)
    : initialUrl
      ? references.findIndex((item) => item.url === initialUrl)
      : -1;

  return openCompareDialog({
    references,
    results: [{ url: main.url, label: '当前主图' }],
    initialReference: focusIndex >= 0 ? focusIndex : 0,
  });
}
