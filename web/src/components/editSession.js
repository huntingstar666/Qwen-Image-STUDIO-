/**
 * 「图像编辑」页的会话恢复（IndexedDB，本机）。
 *
 * 只解决一件事：刷新 / 重新打开页面后，参考图区域与指令框里的 @ 引用不要丢。
 * 数据只落在本机浏览器，不上传服务端；不保存生成结果（结果仍在 JobRunner / 历史书脊里）。
 *
 * 存两份记录：
 * - refs：参考图（含遮罩），dataURL 原样保存，恢复时重新生成缩略图；
 * - prompt：指令框富文本（含 @ 引用 chip），恢复时按当前参考图重新编号。
 */

const DB_NAME = 'wb-edit-session';
const DB_VERSION = 1;
const STORE = 'session';
const REFS_KEY = 'refs';
const PROMPT_KEY = 'prompt';

let dbPromise = null;

export function editSessionAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && Boolean(indexedDB);
  } catch {
    return false;
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!editSessionAvailable()) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开本地会话库失败'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function readRecord(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取本地会话失败'));
  });
}

async function writeRecord(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('写入本地会话失败'));
    tx.onabort = () => reject(tx.error || new Error('写入本地会话被中断'));
  });
}

/** 只保留恢复需要的字段：缩略图 / 预览图可以重新生成，不必占空间。 */
function slimImages(images) {
  return (Array.isArray(images) ? images : [])
    .filter((image) => typeof image?.dataUrl === 'string' && image.dataUrl.startsWith('data:image/'))
    .map((image) => ({
      id: image.id || '',
      name: image.name || '参考图',
      dataUrl: image.dataUrl,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      libKey: image.libKey || '',
      mask: image.mask?.dataUrl ? { ...image.mask } : null,
    }));
}

export async function saveEditImages(images) {
  try {
    const list = slimImages(images);
    await writeRecord(REFS_KEY, { images: list, at: Date.now() });
    return true;
  } catch (err) {
    console.warn('[edit-session] 保存参考图失败', err);
    return false;
  }
}

export async function saveEditPrompt(html) {
  try {
    await writeRecord(PROMPT_KEY, { html: String(html || ''), at: Date.now() });
    return true;
  } catch (err) {
    console.warn('[edit-session] 保存指令框失败', err);
    return false;
  }
}

/** @returns {Promise<{images: Array<object>, promptHtml: string}>} 没有记录时返回空值 */
export async function loadEditSession() {
  try {
    const [refs, prompt] = await Promise.all([readRecord(REFS_KEY), readRecord(PROMPT_KEY)]);
    return {
      images: Array.isArray(refs?.images) ? refs.images : [],
      promptHtml: typeof prompt?.html === 'string' ? prompt.html : '',
      at: Math.max(Number(refs?.at) || 0, Number(prompt?.at) || 0),
    };
  } catch (err) {
    console.warn('[edit-session] 读取本地会话失败', err);
    return { images: [], promptHtml: '', at: 0 };
  }
}

export async function clearEditSession() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(REFS_KEY);
      store.delete(PROMPT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('清空本地会话失败'));
    });
    return true;
  } catch (err) {
    console.warn('[edit-session] 清空本地会话失败', err);
    return false;
  }
}
