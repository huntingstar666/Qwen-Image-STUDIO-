/**
 * 全景预览（无 three.js）：拖动查看 2:1 等距柱状图，横向循环。
 * 需要真实球面校验时可自行替换成 three.js 版本。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

export function PanoramaPreview({ src, height = 360, fov = 75, autoRotate = false }) {
  const [view, setView] = useState({ yaw: 0, pitch: 0, zoom: 1 });
  const drag = useRef(null);
  const frame = useRef(0);

  useEffect(() => {
    if (!autoRotate) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      setView((current) => ({ ...current, yaw: (current.yaw + 0.25) % 360 }));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frame.current);
    };
  }, [autoRotate]);

  const scale = 360 / fov;

  return (
    <div className="itk-pano">
      <div
        className="itk-pano-view"
        style={{ height }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          setView({
            yaw: start.view.yaw - (event.clientX - start.x) * 0.35,
            pitch: Math.max(-60, Math.min(60, start.view.pitch + (event.clientY - start.y) * 0.2)),
            zoom: start.view.zoom,
          });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          event.preventDefault();
          setView((current) => ({ ...current, zoom: Math.max(0.6, Math.min(2.4, current.zoom - Math.sign(event.deltaY) * 0.08)) }));
        }}
      >
        {src ? (
          <img
            src={src}
            alt="全景预览"
            draggable={false}
            style={{
              transform: `translate(${-((view.yaw % 360) / 360) * 100 * scale}%, ${view.pitch / 3}%) scale(${scale * view.zoom})`,
            }}
          />
        ) : (
          <p>还没有全景图</p>
        )}
        <span className="itk-pano-badge">360° 预览</span>
        <button
          type="button"
          className="itk-pano-reset"
          onClick={() => setView({ yaw: 0, pitch: 0, zoom: 1 })}
          aria-label="重置视角"
          title="重置视角"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
    </div>
  );
}

export default PanoramaPreview;
