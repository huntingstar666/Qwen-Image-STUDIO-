/**
 * 本次任务 AI 编辑历史（D16.1，方案 §15.2）。
 *
 * 一次任务 = 一次打开的图片文档（sessionId = 工程 id）。只记录 AI 修改成功的结果：
 * - 元信息（指令、参数、参考图 id）存 IndexedDB `aiHistory`，按 sessionId 归档；
 * - 结果原图存 `aiResults`，缩略图转成 320px WebP dataURL 直接放元信息里；
 * - 参考图原图按 refId 去重存 `aiResults`，回退时还原成 dataURL；
 * - 内存只保留最近 6 张结果的 objectURL，其余按需读取。
 */

import { openDb } from './persistence.js';

const META_STORE = 'aiHistory';
const BLOB_STORE = 'aiResults';
const MAX_URL_CACHE = 6;
const THUMB_WIDTH = 320;

function rangeFor(sessionId) {
  return IDBKeyRange.bound(`${sessionId}:`, `${sessionId}:\uffff`);
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('读取编辑历史失败'));
    tx.onabort = () => reject(tx.error || new Error('读取编辑历史被中断'));
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const done = transactionDone(tx);
  const value = await readRequest(tx.objectStore(storeName).get(key));
  await done;
  return value;
}

async function dbPut(storeName, value, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(storeName).put(value, key);
  await done;
}

async function dbDelete(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(storeName).delete(key);
  await done;
}

async function dbDeleteRange(storeName, range) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(storeName);
  const request = store.openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await done;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function loadBlobImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('解析结果图失败'));
    };
    image.src = url;
  });
}

/** 结果图 → 320px 宽 WebP 缩略图 dataURL，卡片列表用。 */
async function makeThumb(blob) {
  const image = await loadBlobImage(blob);
  const width = image.naturalWidth || image.width || THUMB_WIDTH;
  const height = image.naturalHeight || image.height || THUMB_WIDTH;
  const scale = Math.min(1, THUMB_WIDTH / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/webp', 0.72);
}

async function fetchBlob(url) {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size ? blob : null;
  } catch {
    return null;
  }
}

export function createSessionHistory({ sessionId, limit = 30 } = {}) {
  const entries = [];
  const resultUrls = new Map();
  let loaded = false;
  let loading = null;

  const enabled = Boolean(sessionId);

  async function persist() {
    if (!enabled) return;
    await dbPut(
      META_STORE,
      { sessionId, entries: entries.map((entry) => ({ ...entry })), updatedAt: Date.now() },
      sessionId,
    );
  }

  function dropUrl(entryId) {
    const cached = resultUrls.get(entryId);
    if (!cached) return;
    URL.revokeObjectURL(cached.url);
    resultUrls.delete(entryId);
  }

  function trimUrls() {
    for (const entryId of [...resultUrls.keys()]) {
      if (resultUrls.size <= MAX_URL_CACHE) break;
      // 对比弹窗正在展示的 URL 会被 pin 住，不允许回收。
      if (resultUrls.get(entryId)?.pinned) continue;
      dropUrl(entryId);
    }
  }

  async function load() {
    if (!enabled || loaded) return entries;
    if (loading) return loading;
    loading = (async () => {
      try {
        const record = await dbGet(META_STORE, sessionId);
        if (Array.isArray(record?.entries)) {
          entries.splice(0, entries.length, ...record.entries);
        }
      } catch {
        // 存储不可用时退化为仅内存，不影响主流程
      }
      loaded = true;
      return entries;
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function removeBlobs(entryId) {
    dropUrl(entryId);
    if (!enabled) return;
    try {
      await dbDelete(BLOB_STORE, `${sessionId}:result:${entryId}`);
    } catch {
      // 忽略
    }
  }

  /**
   * 记录一次成功任务。images 支持一次任务多张结果（按张建卡片）。
   * @param {{
   *   jobId?: string,
   *   prompt?: string,
   *   model?: string,
   *   params?: object,
   *   refs?: Array<{ id: string, name?: string, dataUrl?: string, width?: number, height?: number }>,
   *   images?: Array<{ url: string, width?: number, height?: number }>,
   * }} input
   */
  async function append(input) {
    if (!enabled) return [];
    await load();
    const images = (input.images || []).filter((item) => item?.url);
    if (!images.length) return [];

    const refs = (input.refs || []).filter((item) => item?.id);
    const added = [];
    for (const ref of refs) {
      try {
        if (!ref.dataUrl) continue;
        const blob = await (await fetch(ref.dataUrl)).blob();
        await dbPut(
          BLOB_STORE,
          { id: ref.id, name: ref.name || '', width: Number(ref.width) || 0, height: Number(ref.height) || 0, blob },
          `${sessionId}:ref:${ref.id}`,
        );
      } catch {
        // 单张参考图存不进去不影响历史卡片
      }
    }

    const jobId = String(input.jobId || '');
    const maxIndex = entries.reduce((max, entry) => Math.max(max, Number(entry.index) || 0), 0);
    const jobEntries = [];
    for (let sub = 0; sub < images.length; sub += 1) {
      const image = images[sub];
      const id = `${jobId || Date.now()}#${sub}`;
      if (entries.some((entry) => entry.id === id)) continue;
      const blob = await fetchBlob(image.url);
      if (!blob) continue;
      let thumbUrl = '';
      try {
        thumbUrl = await makeThumb(blob);
      } catch {
        thumbUrl = '';
      }
      const entry = {
        id,
        index: maxIndex + jobEntries.length + 1,
        at: Date.now(),
        jobId,
        sub,
        prompt: String(input.prompt || ''),
        model: String(input.model || ''),
        params: { ...(input.params || {}) },
        refs: refs.map((ref) => ({
          id: ref.id,
          name: ref.name || '',
          width: Number(ref.width) || 0,
          height: Number(ref.height) || 0,
        })),
        result: {
          width: Number(image.width) || 0,
          height: Number(image.height) || 0,
        },
        thumbUrl,
        status: 'done',
      };
      jobEntries.push(entry);
      try {
        await dbPut(BLOB_STORE, { blob, width: entry.result.width, height: entry.result.height }, `${sessionId}:result:${id}`);
      } catch {
        // 原图落库失败，卡片仍可展示缩略图
      }
    }

    if (jobEntries.length) {
      entries.unshift(...jobEntries);
      added.push(...jobEntries);
    }

    // 超限按 LRU 淘汰最旧的记录，避免本机存储无限增长。
    while (entries.length > limit) {
      const dropped = entries.pop();
      await removeBlobs(dropped.id);
    }
    if (added.length) await persist();
    return added;
  }

  async function remove(entryId) {
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return false;
    entries.splice(index, 1);
    await removeBlobs(entryId);
    await persist();
    return true;
  }

  async function clear() {
    entries.splice(0, entries.length);
    for (const id of [...resultUrls.keys()]) dropUrl(id);
    if (!enabled) return;
    try {
      await dbDelete(META_STORE, sessionId);
      await dbDeleteRange(BLOB_STORE, rangeFor(sessionId));
    } catch {
      // 忽略：内存已清空
    }
  }

  /**
   * 历史结果图的 objectURL（默认内存缓存 6 张，LRU 回收）。
   * pin=true 用于对比弹窗：URL 正在展示，不参与 LRU，等实例销毁或清空时统一释放。
   */
  async function ensureResultUrl(entryId, { pin = false } = {}) {
    const cached = resultUrls.get(entryId);
    if (cached) {
      if (pin) cached.pinned = true;
      resultUrls.delete(entryId);
      resultUrls.set(entryId, cached);
      return cached.url;
    }
    const record = await dbGet(BLOB_STORE, `${sessionId}:result:${entryId}`).catch(() => null);
    if (!record?.blob) return '';
    const url = URL.createObjectURL(record.blob);
    resultUrls.set(entryId, { url, pinned: Boolean(pin) });
    trimUrls();
    return url;
  }

  /** 回退时还原该次记录的参考图（dataURL 供再次提交）。 */
  async function refsFor(entryId) {
    const entry = entries.find((item) => item.id === entryId);
    if (!entry?.refs?.length) return [];
    const out = [];
    for (const ref of entry.refs) {
      const record = await dbGet(BLOB_STORE, `${sessionId}:ref:${ref.id}`).catch(() => null);
      if (!record?.blob) continue;
      try {
        out.push({
          id: ref.id,
          name: ref.name,
          width: ref.width,
          height: ref.height,
          dataUrl: await blobToDataUrl(record.blob),
        });
      } catch {
        // 单张参考图读不出时跳过
      }
    }
    return out;
  }

  function destroy() {
    for (const id of [...resultUrls.keys()]) dropUrl(id);
    entries.splice(0, entries.length);
  }

  return {
    enabled,
    get entries() {
      return entries;
    },
    load,
    append,
    remove,
    clear,
    refsFor,
    ensureResultUrl,
    destroy,
  };
}
