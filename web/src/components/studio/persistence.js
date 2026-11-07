/**
 * 「图片精修」本机工程存储（IndexedDB）。
 *
 * 结构见 docs/PLAN_PS_FRONTEND.md §16.3：
 * - meta：lastProjectId / schemaVersion
 * - projects：工程元信息（缩略图、视口、当前工具、tabId）
 * - layers：主图与叠加层的位图 + 蒙版，按图层独立存
 * - refs：参考图原图
 * - session：指令、裁剪、变换、调色、AI 参数等轻量现场
 * - aiHistory / aiResults / drafts：预留给 D16 / D17.2 / D17.3
 *
 * 另含 D17.3 的配额估算、旧工程清理与多标签编辑租约。
 * 所有数据只落在本机浏览器，不上传服务端。
 */

const DB_NAME = 'wb-studio';
const DB_VERSION = 1;

export const SCHEMA_VERSION = 1;

const LAYER_STORE = 'layers';
const ALL_STORES = ['meta', 'projects', 'layers', 'refs', 'session', 'aiHistory', 'aiResults', 'drafts'];

/** 已写入数据库的签名，避免每次自动保存都重写未变化的大图。 */
const layerSignatures = new Map();
const baseSignatures = new Map();
const refsSignatures = new Map();
const knownLayerIds = new Map();
const blobTags = new WeakMap();
let blobSeq = 0;

let dbPromise = null;

export function storageAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && Boolean(indexedDB);
  } catch {
    return false;
  }
}

export function newProjectId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function blobTag(blob) {
  if (!blob) return 'none';
  if (!blobTags.has(blob)) {
    blobSeq += 1;
    blobTags.set(blob, blobSeq);
  }
  return String(blobTags.get(blob));
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地保存失败'));
    tx.onabort = () => reject(tx.error || new Error('本地保存被中断'));
  });
}

function rangeFor(projectId) {
  return IDBKeyRange.bound(`${projectId}:`, `${projectId}:\uffff`);
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!storageAvailable()) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ALL_STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === 'projects') {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        } else {
          db.createObjectStore(name);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开本地工程库失败'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** dataURL → Blob；参考图在 AI 面板里以 dataURL 保存，落库时转成二进制更省空间。 */
function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const type = match[1] || 'application/octet-stream';
  try {
    const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

/**
 * 保存一份工作室工程。
 *
 * @param {{
 *   id: string,
 *   name: string,
 *   width: number,
 *   height: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   thumbnail?: string,
 *   activeTool?: string,
 *   viewport?: object|null,
 *   tabId?: string,
 *   base?: { blob: Blob|null, name: string, width: number, height: number },
 *   maskBlob?: Blob|null,
 *   refs?: Array<{ id: string, name: string, dataUrl?: string, blob?: Blob, width?: number, height?: number }>,
 *   layers?: Array<{ id: string, props: object, blob: Blob|null }>,
 *   session?: object,
 * }} project
 */
export async function saveStudioProject(project) {
  if (!project?.id) throw new Error('缺少工程 id');
  const db = await openDb();
  const projectId = project.id;
  const updatedAt = project.updatedAt || Date.now();

  // 事务外完成 dataURL → Blob 等异步转换，避免事务提前提交。
  const refs = project.refs || [];
  const refsSignature = refs.map((item) => `${item.id}:${item.dataUrl?.length || 0}`).join('|');
  const refsChanged = refsSignatures.get(projectId) !== refsSignature;
  const refsValue = refsChanged
    ? refs.map((item) => ({
        id: item.id,
        name: item.name,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        blob: item.blob || dataUrlToBlob(item.dataUrl),
      }))
    : null;

  const baseBlob = project.base?.blob || null;
  const baseSignature = [
    blobTag(baseBlob),
    project.base?.name || '',
    project.base?.width || 0,
    project.base?.height || 0,
    blobTag(project.maskBlob),
  ].join('|');
  const baseChanged = baseSignatures.get(projectId) !== baseSignature;

  const layers = project.layers || [];
  const keepIds = new Set();
  const pendingLayers = [];
  for (const layer of layers) {
    keepIds.add(layer.id);
    const signature = `${blobTag(layer.blob)}|${blobTag(layer.maskBlob)}|${JSON.stringify(layer.props || {})}`;
    if (layerSignatures.get(`${projectId}:${layer.id}`) === signature) continue;
    pendingLayers.push({ layer, signature });
  }
  const previousIds = knownLayerIds.get(projectId);
  const removeIds = previousIds ? [...previousIds].filter((id) => !keepIds.has(id)) : [];

  const tx = db.transaction(['meta', 'projects', 'layers', 'refs', 'session', 'drafts'], 'readwrite');
  const done = transactionDone(tx);
  const metaStore = tx.objectStore('meta');
  const layerStore = tx.objectStore(LAYER_STORE);
  const projectStore = tx.objectStore('projects');

  metaStore.put(projectId, 'lastProjectId');
  metaStore.put(SCHEMA_VERSION, 'schemaVersion');

  projectStore.put({
    id: projectId,
    name: project.name || '未命名工程',
    width: Number(project.width) || 0,
    height: Number(project.height) || 0,
    createdAt: project.createdAt || updatedAt,
    updatedAt,
    thumbnail: project.thumbnail || '',
    activeTool: project.activeTool || '',
    viewport: project.viewport || null,
    tabId: project.tabId || '',
    schemaVersion: SCHEMA_VERSION,
  });

  if (baseChanged) {
    layerStore.put(
      {
        id: 'base',
        projectId,
        props: {
          kind: 'base',
          name: project.base?.name || project.name || '',
          width: Number(project.base?.width) || Number(project.width) || 0,
          height: Number(project.base?.height) || Number(project.height) || 0,
        },
        bitmapBlob: baseBlob,
        maskBlob: project.maskBlob || null,
        version: SCHEMA_VERSION,
        updatedAt,
      },
      `${projectId}:base`,
    );
  }

  for (const { layer } of pendingLayers) {
    layerStore.put(
      {
        id: layer.id,
        projectId,
        props: layer.props || {},
        bitmapBlob: layer.blob || null,
        maskBlob: layer.maskBlob || null,
        version: SCHEMA_VERSION,
        updatedAt,
      },
      `${projectId}:${layer.id}`,
    );
  }
  for (const id of removeIds) layerStore.delete(`${projectId}:${id}`);

  if (refsValue) tx.objectStore('refs').put(refsValue, projectId);

  tx.objectStore('session').put(
    {
      projectId,
      prompt: project.session?.prompt || '',
      activeTab: project.session?.activeTab || '',
      cropRect: project.session?.cropRect || null,
      transform: project.session?.transform || null,
      adjust: project.session?.adjust || null,
      aiParams: project.session?.aiParams || null,
      viewport: project.session?.viewport || null,
      activeTool: project.session?.activeTool || '',
      schemaVersion: SCHEMA_VERSION,
    },
    projectId,
  );

  // 轻量草稿：主图/图层写坏时至少能回退现场参数；每个工程只留最近 3 份。
  const draftStore = tx.objectStore('drafts');
  draftStore.put({ snapshot: project.session || null, createdAt: updatedAt }, `${projectId}:${updatedAt}`);
  const draftKeys = [];
  const draftCursor = draftStore.openCursor(rangeFor(projectId));
  draftCursor.onsuccess = () => {
    const cursor = draftCursor.result;
    if (!cursor) {
      while (draftKeys.length > 3) draftStore.delete(draftKeys.shift());
      return;
    }
    draftKeys.push(cursor.key);
    cursor.continue();
  };

  await done;

  // 只有事务提交成功才更新签名，失败时下一轮会重新写。
  if (baseChanged) baseSignatures.set(projectId, baseSignature);
  if (refsValue) refsSignatures.set(projectId, refsSignature);
  for (const { layer, signature } of pendingLayers) {
    layerSignatures.set(`${projectId}:${layer.id}`, signature);
  }
  knownLayerIds.set(projectId, keepIds);
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function collectByRange(store, range) {
  return new Promise((resolve, reject) => {
    const items = [];
    const request = store.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function deleteByRange(store, range) {
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function loadProject(projectId) {
  if (!projectId) return null;
  const db = await openDb();
  const tx = db.transaction(['projects', 'layers', 'refs', 'session'], 'readonly');
  const done = transactionDone(tx);
  const projectRequest = readRequest(tx.objectStore('projects').get(projectId));
  const sessionRequest = readRequest(tx.objectStore('session').get(projectId));
  const refsRequest = readRequest(tx.objectStore('refs').get(projectId));
  const layersRequest = collectByRange(tx.objectStore(LAYER_STORE), rangeFor(projectId));

  const [project, session, refs, layers] = await Promise.all([
    projectRequest,
    sessionRequest,
    refsRequest,
    layersRequest,
  ]);
  await done;
  if (!project) return null;
  return { project, session: session || null, refs: refs || [], layers };
}

export async function loadLastProject() {
  const db = await openDb();
  const tx = db.transaction(['meta'], 'readonly');
  const done = transactionDone(tx);
  const lastId = await readRequest(tx.objectStore('meta').get('lastProjectId'));
  await done;
  if (!lastId) return null;
  return loadProject(lastId);
}

export async function clearProject(projectId) {
  if (!projectId) return;
  const db = await openDb();
  const tx = db.transaction(
    ['meta', 'projects', 'layers', 'refs', 'session', 'aiHistory', 'aiResults', 'drafts'],
    'readwrite',
  );
  const done = transactionDone(tx);
  tx.objectStore('projects').delete(projectId);
  tx.objectStore('refs').delete(projectId);
  tx.objectStore('session').delete(projectId);
  tx.objectStore('aiHistory').delete(projectId);
  const metaStore = tx.objectStore('meta');
  const lastRequest = metaStore.get('lastProjectId');
  lastRequest.onsuccess = () => {
    if (lastRequest.result === projectId) metaStore.delete('lastProjectId');
  };
  await Promise.all([
    deleteByRange(tx.objectStore('layers'), rangeFor(projectId)),
    deleteByRange(tx.objectStore('aiResults'), rangeFor(projectId)),
    deleteByRange(tx.objectStore('drafts'), rangeFor(projectId)),
  ]);
  await done;

  baseSignatures.delete(projectId);
  refsSignatures.delete(projectId);
  knownLayerIds.delete(projectId);
  for (const key of [...layerSignatures.keys()]) {
    if (key.startsWith(`${projectId}:`)) layerSignatures.delete(key);
  }
}

/* ============================================================
 * 配额、清理与多标签（D17.3）
 * ============================================================ */

const LEASE_TTL = 12_000;
const LEASE_HEARTBEAT = 4_000;
const LEASE_CHANNEL = 'wb-studio-lease';

function leaseKey(projectId) {
  return `wb.studio.lease.${projectId}`;
}

/** 读取工程当前租约；超过 TTL 未心跳视为已释放。 */
function readLease(projectId) {
  try {
    const raw = localStorage.getItem(leaseKey(projectId));
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record?.tabId) return null;
    if (Date.now() - Number(record.at || 0) > LEASE_TTL) return null;
    return record;
  } catch {
    return null;
  }
}

function writeLease(projectId, tabId) {
  try {
    localStorage.setItem(leaseKey(projectId), JSON.stringify({ tabId, at: Date.now() }));
  } catch {
    // 隐私模式写不进 localStorage 时退化为单标签，不做互斥
  }
}

export function leaseHeldByOther(projectId, tabId) {
  const current = readLease(projectId);
  return Boolean(current && current.tabId !== tabId);
}

/**
 * 多标签编辑租约：同一工程同一时刻只允许一个标签自动保存。
 * 后开标签 claim 失败即转只读；点「接管」调用 take()，
 * 原标签通过 BroadcastChannel（或 storage 事件）立即转只读。
 */
export function createProjectLease(projectId, tabId, { onLost } = {}) {
  let timer = 0;
  let channel = null;
  let owned = false;

  const post = (type) => {
    try {
      channel?.postMessage({ type, projectId, tabId });
    } catch {
      // 通道关闭后忽略
    }
  };

  const stopTimer = () => {
    clearInterval(timer);
    timer = 0;
  };

  const lose = () => {
    if (!owned) return;
    owned = false;
    stopTimer();
    onLost?.();
  };

  const beat = () => {
    if (!owned) return;
    const current = readLease(projectId);
    if (current && current.tabId !== tabId) {
      lose();
      return;
    }
    writeLease(projectId, tabId);
  };

  const start = () => {
    owned = true;
    writeLease(projectId, tabId);
    if (!timer) timer = setInterval(beat, LEASE_HEARTBEAT);
  };

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(LEASE_CHANNEL);
      channel.onmessage = (event) => {
        const message = event.data || {};
        if (message.projectId !== projectId || message.tabId === tabId) return;
        if (message.type === 'take' || message.type === 'claim') lose();
      };
    }
  } catch {
    channel = null;
  }

  // BroadcastChannel 不可用时，用 storage 事件兜底。
  const onStorage = (event) => {
    if (event.key !== leaseKey(projectId) || !event.newValue) return;
    try {
      const record = JSON.parse(event.newValue);
      if (record?.tabId && record.tabId !== tabId) lose();
    } catch {
      // 解析失败不处理
    }
  };
  window.addEventListener('storage', onStorage);

  return {
    claim() {
      if (leaseHeldByOther(projectId, tabId)) {
        owned = false;
        return false;
      }
      start();
      post('claim');
      return true;
    },
    take() {
      start();
      post('take');
    },
    get owned() {
      return owned;
    },
    release() {
      owned = false;
      stopTimer();
      if (readLease(projectId)?.tabId === tabId) {
        try {
          localStorage.removeItem(leaseKey(projectId));
        } catch {
          // 忽略
        }
        post('release');
      }
      try {
        channel?.close();
      } catch {
        // 忽略
      }
      channel = null;
      window.removeEventListener('storage', onStorage);
    },
  };
}

/** 浏览器源站存储估算；不支持时返回 null。 */
export async function estimateStorage() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota || !Number.isFinite(quota)) return null;
    return { usage, quota, ratio: Math.min(1, usage / quota) };
  } catch {
    return null;
  }
}

/** 申请持久化存储，降低被浏览器自动清理的概率。 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** 按最近更新时间倒序列出全部工程。 */
export async function listProjects() {
  const db = await openDb();
  const tx = db.transaction(['projects'], 'readonly');
  const done = transactionDone(tx);
  const items = await readRequest(tx.objectStore('projects').getAll());
  await done;
  return (items || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 清理旧工程：最多保留最近 `keep` 个，且超过 `maxAgeDays` 天的自动删除。
 * 正在被其他标签编辑（租约未过期）的工程会跳过。
 * @returns {Promise<number>} 删除数量
 */
export async function cleanupProjects({ keep = 10, maxAgeDays = 7, keepId = '', tabId = '' } = {}) {
  const projects = await listProjects();
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
  let removed = 0;
  for (let index = 0; index < projects.length; index += 1) {
    const item = projects[index];
    if (!item?.id || item.id === keepId) continue;
    const stale = index >= keep || (cutoff > 0 && (item.updatedAt || 0) < cutoff);
    if (!stale) continue;
    if (tabId && leaseHeldByOther(item.id, tabId)) continue;
    try {
      await clearProject(item.id);
      removed += 1;
    } catch {
      // 单个工程删除失败不影响其余
    }
  }
  return removed;
}

/** 清空全部本机工程数据（设置页「关于」入口，需二次确认）。 */
export async function clearAllProjects() {
  const projects = await listProjects();
  for (const item of projects) {
    if (!item?.id) continue;
    try {
      await clearProject(item.id);
    } catch {
      // 继续清理其他工程
    }
  }
  try {
    const db = await openDb();
    const tx = db.transaction(['meta'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('meta').delete('lastProjectId');
    await done;
  } catch {
    // 忽略：工程本身已删
  }
  return projects.length;
}
