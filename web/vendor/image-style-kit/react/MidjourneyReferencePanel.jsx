/**
 * Midjourney 专用垫图面板（角色参考 / 风格参考 / 深度参考）。
 *
 * 移植自原项目 `canvasImageComposer.tsx` 的 MJ 面板；判断模型是否支持
 * 复用 `supportsMidjourneyReferences`，分配逻辑复用 `midjourneyReferences.js`。
 */
import React from 'react';
import {
  MIDJOURNEY_REFERENCE_ROLES,
  assignMidjourneyReference,
  sanitizeMidjourneyReferenceAssignments,
  supportsMidjourneyReferences,
} from '../src/midjourneyReferences.js';

/** 把宿主素材（{ id, url, label }）归一成垫图逻辑需要的图片节点形状。 */
function normalizeImages(images) {
  return (images || [])
    .filter((image) => image && typeof image.id === 'string')
    .map((image, index) => ({
      id: image.id,
      type: 'Image',
      resultUrl: image.url || image.resultUrl || image.networkUrl,
      title: image.title || image.label || `图片 ${index + 1}`,
    }))
    .filter((image) => typeof image.resultUrl === 'string' && image.resultUrl.trim());
}

export function MidjourneyReferencePanel({ node, images, disabled = false, model, onUpdate }) {
  if (model && !supportsMidjourneyReferences(model)) return null;
  const options = normalizeImages(images);
  const assignments = sanitizeMidjourneyReferenceAssignments(node.midjourneyReferenceNodeIds, options);
  return (
    <div className="mgn-mj-refs" data-mgn-midjourney-references="true" onClick={(event) => event.stopPropagation()}>
      <div className="mgn-mj-refs-head">
        <strong>专用垫图</strong>
        <span>未指定的图片仍作为普通参考</span>
      </div>
      <div className="mgn-mj-refs-grid">
        {MIDJOURNEY_REFERENCE_ROLES.map((role) => (
          <label key={role.key} title={role.description}>
            <span>{role.label}</span>
            <select
              aria-label={role.label}
              value={assignments[role.key] || ''}
              disabled={disabled || options.length === 0}
              onChange={(event) =>
                onUpdate({
                  midjourneyReferenceNodeIds: assignMidjourneyReference(node.midjourneyReferenceNodeIds, options, role.key, event.currentTarget.value),
                })
              }
            >
              <option value="">{options.length ? '未设置' : '先连接图片'}</option>
              {options.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

export default MidjourneyReferencePanel;

