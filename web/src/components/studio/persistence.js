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
    const signature = `${blobTag(layer.blob)}|${JSON.stringify(layer.props || {})}`;
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
        maskBlob: null,
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
