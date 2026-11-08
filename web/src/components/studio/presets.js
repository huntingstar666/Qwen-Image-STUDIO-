/**
 * 编辑预设与覆盖项（图片精修 / 图生图共用）。
 *
 * 唯一数值来源是后端 `GET /api/meta` 下发的 `edit_presets`：
 * 前端只渲染、不复制一份参数常量（否则又会回到 B6「两页各存一套」）。
 */

import { api } from '../../api.js';

let cache = null;

// 全局设置保存预设后，任务页需要重新拉取 /api/meta。
if (typeof window !== 'undefined') {
  window.addEventListener('presets:updated', () => {
    cache = null;
  });
}

/** 两个保护开关的默认值：只要在图片精修页编辑，默认都开（用户可关）。 */
export const PROTECTION_DEFAULTS = { color: true, zeroShift: true };

export function normalizeProtection(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    color: src.color !== false,
    zeroShift: src.zeroShift !== false,
  };
}

/** 拉取并缓存预设摘要；失败时清空缓存，下次再试。 */
export function loadPresets() {
  if (!cache) {
    cache = api
      .meta()
      .then((meta) => {
        const builtins = Array.isArray(meta?.edit_presets) ? meta.edit_presets : [];
        const customs = (Array.isArray(meta?.custom_presets) ? meta.custom_presets : [])
          .map((item) => ({ ...item, custom: true }));
        return {
          version: Number(meta?.preset_version) || 1,
          defaultId: String(meta?.default_preset || ''),
          list: [...builtins, ...customs],
          builtins,
          custom: customs,
        };
      })
      .catch((err) => {
        cache = null;
        throw err;
      });
  }
  return cache;
}

export function findPreset(list, id) {
  return (list || []).find((item) => item.id === id) || null;
}

export function defaultPresetId(list) {
  const hit = (list || []).find((item) => item.default);
  return hit?.id || (list || [])[0]?.id || '';
}

export function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), obj);
}

function flatten(params, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(params || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

/**
 * 切换预设时清掉"该预设自己定义的键"上的覆盖项，让新预设默认值真正生效。
 * 预设未定义的键（如 outpaint.top/left）是任务专用输入，继续保留。
 */
export function resetDefinedOverrides(preset, overrides) {
  const defined = new Set(Object.keys(flatten(preset?.params || {})));
  const next = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!defined.has(key)) next[key] = value;
  }
  return next;
}

function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? Math.abs(na - nb) < 1e-6 : a === b;
  }
  return a === b;
}

/** 预设参数拍平成 `local.feather` 这种扁平键（仅供界面回显）。 */
export function flattenParams(preset) {
  return flatten(preset?.params || {});
}

/** 生效值 = 覆盖项 > 预设参数 > 兜底（兜底只用于界面显示，不参与提交）。 */
export function effectiveValue(preset, overrides, key, fallback) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const value = getPath(preset?.params, key);
  return value === undefined ? fallback : value;
}

/** 生效值全集（扁平），用于界面回显 / 尺寸计算。 */
export function effectiveParams(preset, overrides) {
  const out = flattenParams(preset);
  for (const [key, value] of Object.entries(overrides || {})) out[key] = value;
  return out;
}

export function isModified(preset, overrides, key) {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key)) return false;
  const presetValue = getPath(preset?.params, key);
  return presetValue === undefined || !sameValue(presetValue, overrides[key]);
}

/** 改动过的键（覆盖项里与预设值相同的不算改动）。 */
export function modifiedKeys(preset, overrides) {
  return Object.keys(overrides || {}).filter((key) => isModified(preset, overrides, key));
}

/** 写覆盖项：与预设值相同就移除该键，保证「未改」时提交里不多字段。 */
export function withOverride(preset, overrides, key, value) {
  const next = { ...(overrides || {}) };
  const presetValue = getPath(preset?.params, key);
  if (presetValue !== undefined && sameValue(presetValue, value)) delete next[key];
  else next[key] = value;
  return next;
}

export function withoutOverrides(overrides, keys) {
  const drop = new Set(keys || []);
  const next = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!drop.has(key)) next[key] = value;
  }
  return next;
}

/** 预设默认任务（`edit` / `remove` / `outpaint`）。 */
export function presetTaskMode(preset, fallback = 'edit') {
  return String(preset?.params?.task?.mode || preset?.task_mode || fallback);
}

/**
 * 无蒙版时把「需要蒙版」的预设降级为整图档（§13.7 / §15.4）：
 * 不假装做了局部编辑，也不让 `remove` 在没有选区时静默乱改整图。
 * 连续编辑·遮罩同理，降级到连续编辑·整图（而不是退回 `canvas`）。
 */
export function resolvePresetForMask(id, hasMask) {
  if (hasMask) return { id, degraded: false, from: '' };
  if (id === 'mask_edit' || id === 'remove') return { id: 'canvas', degraded: true, from: id };
  if (id === 'chain_mask') return { id: 'chain_native', degraded: true, from: id };
  return { id, degraded: false, from: '' };
}
