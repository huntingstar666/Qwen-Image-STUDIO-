/**
 * 图片对比数据组装（D16.2，方案 §15.3）。
 *
 * 不修改 `compare.js` 的交互，只把工作室里的候选图整理成它需要的
 * `{ references, results }` 结构：
 *   references = 本次结果（可选）+ AI 参考图 + 编辑历史 + 版本槽快照
 *   results    = 当前主图 + 版本槽快照
 *
 * 快照默认放在「参考图」侧、当前主图放在「结果图」侧，所以打开就是
 * 「最近一张快照 vs 当前主图」；两侧都带快照，因此也能任选两张对比。
 * 历史图是 IndexedDB 里的 Blob，取 objectURL 时 pin 住，避免 LRU 回收
 * 把弹窗里正在展示的图片地址释放掉；快照 URL 在弹窗关闭时统一释放。
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
  getSnapshots = () => [],
  getSnapshotBlob,
  getCurrentSnapshotId = () => '',
  extra = [],
  initialHistoryId = '',
  initialSnapshotId = '',
  initialUrl = '',
} = {}) {
  const main = await getMain?.();
  if (!main?.url) {
    toastWarn('请先打开一张主图');
    return null;
  }

  // 版本槽快照：用完整 Blob 对比，缩略图沿用卡片上的 160px 图，避免一次解码几十张 4K 图。
  const snapshots = [];
  const snapshotUrls = [];
  const versionList = getSnapshots() || [];
  const loaded = await Promise.all(
    versionList.map(async (version) => {
      try {
        const blob = await getSnapshotBlob?.(version);
        return blob ? { version, blob } : null;
      } catch {
        return null;
      }
    }),
  );
  for (const item of loaded) {
    if (!item) continue;
    const url = URL.createObjectURL(item.blob);
    snapshotUrls.push(url);
    snapshots.push({
      url,
      thumbUrl: item.version.thumbUrl || url,
      label: `快照 · ${item.version.label || '版本'}`,
      snapshotId: item.version.id,
    });
  }

  // 从快照卡片右键「与当前对比」进来时，原图不在本机要给出明确原因。
  if (initialSnapshotId && !snapshots.some((item) => item.snapshotId === initialSnapshotId)) {
    snapshotUrls.forEach((url) => URL.revokeObjectURL(url));
    toastWarn('该快照的原图不在本机，无法对比');
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
  for (const item of snapshots) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    references.push(item);
  }

  if (!references.length) {
    snapshotUrls.forEach((url) => URL.revokeObjectURL(url));
    toastWarn('先添加参考图、完成一次 AI 编辑，或按快门保存一张快照');
    return null;
  }

  // 结果侧同样带快照：这样「任选两张」也包含快照 ↔ 快照。
  const results = [{ url: main.url, label: '当前主图' }, ...snapshots];

  let focusIndex = initialSnapshotId
    ? references.findIndex((item) => item.snapshotId === initialSnapshotId)
    : initialHistoryId
      ? references.findIndex((item) => item.historyId === initialHistoryId)
      : initialUrl
        ? references.findIndex((item) => item.url === initialUrl)
        : -1;
  if (focusIndex < 0 && snapshots.length) {
    // 默认选最近一张快照；当前版本是最后一张时优先选前一张，避免「自己比自己」。
    const currentId = getCurrentSnapshotId?.() || '';
    const latest = [...snapshots].reverse().find((item) => item.snapshotId !== currentId) || snapshots[snapshots.length - 1];
    focusIndex = references.findIndex((item) => item.snapshotId === latest.snapshotId);
  }

  const handle = openCompareDialog({
    references,
    results,
    initialReference: focusIndex >= 0 ? focusIndex : 0,
    initialResult: 0,
    onClose: () => snapshotUrls.forEach((url) => URL.revokeObjectURL(url)),
  });
  if (!handle) snapshotUrls.forEach((url) => URL.revokeObjectURL(url));
  return handle;
}
