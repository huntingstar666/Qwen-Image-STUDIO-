/**
 * 文档 / 图层内核（D7.1）。
 *
 * 只做「图层栈」这一件事：新建、删除、复制、排序、查找。
 * 所有操作都是纯函数，直接改传入的 doc 对象并返回结果，方便单元测试；
 * 不依赖 DOM、渲染器或历史模块，避免和 studioDoc.js 的图片管线互相牵制。
 *
 * 约定：
 * 1. `layers[0]` 是最底层，数组末尾是最上层（与绘制顺序一致）；
 * 2. `activeId` 记录当前选中的图层，仅用于 UI 高亮，不参与合成；
 * 3. 底图不在 layers 里，永远锁定。
 *
 * @typedef {{ id: string, name: string, clone: (opts?: object) => object }} Layer
 * @typedef {{ width: number, height: number, layers: Layer[], activeId: string }} LayerDocument
 */

/** @returns {LayerDocument} */
export function createDocument({ width = 0, height = 0 } = {}) {
  return {
    width: Number(width) || 0,
    height: Number(height) || 0,
    layers: [],
    activeId: '',
    /** 图层组（D23.4 L4）：[{ id, name, visible, opacity, blend, collapsed }] */
    groups: [],
  };
}

/** @returns {Layer[]} */
export function layersOf(doc) {
  return doc?.layers || [];
}

export function layerCount(doc) {
  return doc?.layers?.length || 0;
}

/** 找不到返回 -1 */
export function indexOf(doc, id) {
  if (!doc?.layers || !id) return -1;
  return doc.layers.findIndex((layer) => layer.id === id);
}

/** @returns {Layer|null} */
export function findLayer(doc, id) {
  const index = indexOf(doc, id);
  return index < 0 ? null : doc.layers[index];
}

/**
 * 插入图层。
 * @param {LayerDocument} doc
 * @param {Layer} layer
 * @param {{ index?: number, activate?: boolean }} [options] index 省略或越界时追加到最上层
 * @returns {number} 实际插入位置，失败返回 -1
 */
export function addLayer(doc, layer, { index = -1, activate = true } = {}) {
  if (!doc || !layer) return -1;
  if (!Array.isArray(doc.layers)) doc.layers = [];
  const at = index < 0 || index > doc.layers.length ? doc.layers.length : index;
  doc.layers.splice(at, 0, layer);
  if (activate) doc.activeId = layer.id;
  return at;
}

/**
 * 删除图层。
 * @returns {Layer|null} 被删除的图层
 */
export function removeLayer(doc, id) {
  const index = indexOf(doc, id);
  if (index < 0) return null;
  const [removed] = doc.layers.splice(index, 1);
  if (doc.activeId === id) {
    const next = doc.layers[Math.min(index, doc.layers.length - 1)];
    doc.activeId = next ? next.id : '';
  }
  return removed;
}

/**
 * 调整图层顺序。
 * @param {LayerDocument} doc
 * @param {string} id
 * @param {number} toIndex 目标下标（会被裁剪到合法范围）
 * @returns {number} 新位置；图层不存在或位置未变返回 -1
 */
export function moveLayer(doc, id, toIndex) {
  const from = indexOf(doc, id);
  if (from < 0) return -1;
  const last = doc.layers.length - 1;
  const to = Math.max(0, Math.min(last, Math.round(Number(toIndex)) || 0));
  if (to === from) return -1;
  const [layer] = doc.layers.splice(from, 1);
  doc.layers.splice(to, 0, layer);
  doc.activeId = layer.id;
  return to;
}

/**
 * 复制图层，副本插在源图层上方（除非显式指定 index）。
 * 图层自己负责生成新 id：`clone({ fresh: true })`。
 * @param {{ offset?: number, name?: string, index?: number }} [options] offset 为副本相对源图层的像素偏移
 * @returns {Layer|null}
 */
export function cloneLayer(doc, id, { offset = 0, name = '', index = -1 } = {}) {
  const source = findLayer(doc, id);
  if (!source || typeof source.clone !== 'function') return null;
  const copy = source.clone({ fresh: true });
  copy.name = name || `${source.name} 副本`;
  const shift = Number(offset) || 0;
  if (shift) {
    copy.x = (Number(copy.x) || 0) + shift;
    copy.y = (Number(copy.y) || 0) + shift;
  }
  addLayer(doc, copy, { index: index < 0 ? indexOf(doc, id) + 1 : index, activate: true });
  return copy;
}
