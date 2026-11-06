/**
 * 图片视角控件。
 *
 * 移植自原项目 `ImageAngleControl.tsx` + `dialogs/canvasImageAngle.tsx`，
 * 只保留编辑模式（模态弹层），去掉按节点坐标锚定与计费文案。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { angleDirections, defaultImageAngle, imageAngleDescription, normalizeImageAngle } from '../src/imageAngle.js';

export function CanvasImageAngle({ node, onClose, onApply, editing = true }) {
  const [angle, setAngle] = useState(() => normalizeImageAngle(node.imageAngle));
  const [error, setError] = useState('');
  const drag = useRef(null);

  useEffect(() => {
    const key = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const patch = (value) => setAngle((current) => normalizeImageAngle({ ...current, ...value }));
  const description = imageAngleDescription(angle);

  return createPortal(
    <div className={editing ? 'af-angle-backdrop' : 'af-angle-anchored'} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <div role="dialog" aria-modal={editing || undefined} aria-label="调整图片角度" className="af-angle-panel" onKeyDown={(event) => event.stopPropagation()}>
        <header>
          <Icon name="box" size={18} />
          <strong>角度</strong>
          <span>拖拽调整观察方向</span>
          <button type="button" aria-label="关闭角度" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="af-angle-body">
          <div
            className="af-angle-stage"
            aria-label="拖拽调整角度"
            role="group"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, angle };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start || start.id !== event.pointerId) return;
              setAngle(
                normalizeImageAngle({
                  ...start.angle,
                  azimuth: start.angle.azimuth - (event.clientX - start.x) * 0.7,
                  elevation: start.angle.elevation + (event.clientY - start.y) * 0.4,
                }),
              );
            }}
            onPointerUp={(event) => {
              drag.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onWheel={(event) => patch({ zoom: angle.zoom - Math.sign(event.deltaY) * 0.3 })}
          >
            <div
              className="af-angle-object"
              style={{ transform: `scale(${0.65 + angle.zoom * 0.07}) rotateX(${-angle.elevation}deg) rotateY(${-angle.azimuth}deg)` }}
            >
              <div className="af-angle-front">{node.resultUrl && <img draggable={false} src={node.resultUrl} alt="原图视角示意" />}</div>
              <div className="af-angle-back">背面</div>
              <div className="af-angle-left">左</div>
              <div className="af-angle-right">右</div>
              <div className="af-angle-top">上</div>
              <div className="af-angle-bottom">下</div>
            </div>
            <span className="af-angle-caption">视角示意 · 实际结果由模型生成</span>
          </div>
          <div className="af-angle-controls">
            {[
              ['azimuth', '水平角度', 0, 359, 1, '°'],
              ['elevation', '俯仰角度', -30, 60, 1, '°'],
              ['zoom', '取景远近', 0, 10, 0.1, ''],
            ].map(([key, label, min, max, step, unit]) => (
              <label key={key}>
                <span>{label}</span>
                <output>
                  {angle[key]}
                  {unit}
                </output>
                <input aria-label={label} type="range" min={min} max={max} step={step} value={angle[key]} onChange={(event) => patch({ [key]: Number(event.target.value) })} />
              </label>
            ))}
            <details className="af-angle-presets-menu">
              <summary>快捷视角</summary>
              <div className="af-angle-presets">
                {angleDirections.map((name, index) => (
                  <button key={name} type="button" aria-pressed={description.direction === name} onClick={() => patch({ azimuth: index * 45 })}>
                    {name}
                  </button>
                ))}
              </div>
            </details>
            <p>
              {description.direction} · {description.elevation} · {description.distance}
            </p>
          </div>
        </div>
        <footer>
          <button type="button" onClick={() => setAngle({ ...defaultImageAngle })}>
            <Icon name="refresh" size={14} />
            重置
          </button>
          <span role="status">{error || '保存角度后重新生成，即可按新视角出图。'}</span>
          <button
            type="button"
            className="primary"
            onClick={() => {
              try {
                onApply(node.id, angle);
                onClose();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : '创建失败，请重试');
              }
            }}
          >
            {editing ? '应用设置' : '生成新角度'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** 节点内的视角入口：显示当前视角摘要，并可打开弹层调整。 */
export function ImageAngleControl({ node, referenceUrl, disabled = false, onUpdate }) {
  const [open, setOpen] = useState(false);
  const description = imageAngleDescription(node.imageAngle);
  return (
    <div className="mgn-angle-row">
      <button type="button" className="mgn-angle-trigger" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name="box" size={13} />
        {node.imageAngle ? `${description.direction} · ${description.elevation} · ${description.distance}` : '设置视角'}
      </button>
      {node.imageAngle && (
        <button type="button" className="mgn-icon-btn" aria-label="移除角度设置" disabled={disabled} onClick={() => onUpdate({ imageAngle: null })}>
          <Icon name="close" size={13} />
        </button>
      )}
      {open && (
        <CanvasImageAngle
          editing
          node={{ ...node, resultUrl: referenceUrl || node.resultUrl }}
          onClose={() => setOpen(false)}
          onApply={(id, imageAngle) => {
            if (disabled) throw new Error('图片正在生成，请完成后再修改角度。');
            onUpdate({ imageAngle });
          }}
        />
      )}
    </div>
  );
}

