/**
 * Midjourney 专用垫图（cref / sref / dref）。
 * 与原项目 `midjourneyReferences.ts` 对齐，去掉了 window 全局适配器。
 */

export const MIDJOURNEY_REFERENCE_ROLES = Object.freeze([
  { key: 'cref', label: '角色参考', description: '保持人物或角色特征' },
  { key: 'sref', label: '风格参考', description: '迁移色彩、材质与视觉风格' },
  { key: 'dref', label: '深度参考', description: '参考画面的空间与景深关系' },
]);

const ROLE_KEYS = MIDJOURNEY_REFERENCE_ROLES.map((role) => role.key);

const isImageNode = (node) => ['image', 'upload image'].includes(String(node?.type || '').toLowerCase());
const imageNodes = (nodes) => (nodes || []).filter((node) => typeof node.id === 'string' && isImageNode(node));

/**
 * 丢弃未连接、重复或非图片的分配。
 * @param {Record<string,string>|null|undefined} assignments
 * @param {Array<object>} connectedNodes
 */
export function sanitizeMidjourneyReferenceAssignments(assignments, connectedNodes) {
  const connectedIds = new Set(imageNodes(connectedNodes).map((node) => node.id));
  const used = new Set();
  const sanitized = {};
  for (const role of ROLE_KEYS) {
    const nodeId = assignments?.[role];
    if (!nodeId || !connectedIds.has(nodeId) || used.has(nodeId)) continue;
    sanitized[role] = nodeId;
    used.add(nodeId);
  }
  return sanitized;
}

/**
 * 为某个角色分配参考图；同一张图不会同时担任两个角色。
 */
export function assignMidjourneyReference(assignments, connectedNodes, role, nodeId) {
  const next = sanitizeMidjourneyReferenceAssignments(assignments, connectedNodes);
  const normalized = String(nodeId || '').trim();
  delete next[role];
  if (!normalized) return next;
  for (const candidateRole of ROLE_KEYS) {
    if (next[candidateRole] === normalized) delete next[candidateRole];
  }
  if (new Set(imageNodes(connectedNodes).map((node) => node.id)).has(normalized)) next[role] = normalized;
  return next;
}

function referenceUrl(node) {
  if (!node || !isImageNode(node)) return undefined;
  const value = typeof node.networkUrl === 'string' && node.networkUrl.trim() ? node.networkUrl : node.resultUrl;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * 生成后端请求里的 `midjourneyReferences` 字段。
 * @returns {null|{cref?:string,sref?:string,dref?:string}}
 */
export function resolveMidjourneyReferencePayload(node, nodes) {
  const parents = new Set(Array.isArray(node?.parentIds) ? node.parentIds : []);
  const connected = imageNodes(nodes).filter((candidate) => parents.has(candidate.id));
  const assignments = sanitizeMidjourneyReferenceAssignments(node?.midjourneyReferenceNodeIds, connected);
  const byId = new Map(connected.map((candidate) => [candidate.id, candidate]));
  const payload = {};
  for (const role of ROLE_KEYS) {
    const value = referenceUrl(byId.get(assignments[role] || ''));
    if (value) payload[role] = value;
  }
  return Object.keys(payload).length ? payload : null;
}

/** 模型是否启用 MJ 垫图面板。 */
export function supportsMidjourneyReferences(model) {
  if (typeof model?.midjourneyReferences === 'boolean') return model.midjourneyReferences;
  return /midjourney/i.test(String(model?.name || ''));
}

