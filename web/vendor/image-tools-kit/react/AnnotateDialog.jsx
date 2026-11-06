/**
 * 画笔标注（原项目图片工作室的 Annotation 阶段）：
 * 输出透明叠加图与黑白蒙版，供图生图 / 局部重绘使用。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadImage } from '../src/clientRenderer.js';
import { Icon } from './Icon.jsx';

const MAX_SIDE = 1600;

export function AnnotateDialog({ src, onClose, onSave, onError }) {
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState('draw');
  const [color, setColor] = useState('#ff4d6d');
  const [brush, setBrush] = useState(18);
  const [strokes, setStrokes] = useState([]);
  const [message, setMessage] = useState('');
  const drawing = useRef(null);
  const imageRef = useRef(null);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    loadImage(src)
      .then((image) => {
        if (!alive) return;
        imageRef.current = image;
        const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
        setSize({ width: Math.round(image.naturalWidth * scale), height: Math.round(image.naturalHeight * scale) });
        setReady(true);
      })
      .catch((error) => {
        setMessage(error.message);
        onError?.(error.message);
      });
    return () => {
      alive = false;
    };
  }, [src, onError]);

  const replay = (context, list, forMask = false) => {
    context.clearRect(0, 0, size.width, size.height);
    if (forMask) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, size.width, size.height);
    }
    for (const stroke of list) {
      context.globalCompositeOperation = !forMask && stroke.erase ? 'destination-out' : 'source-over';
      context.strokeStyle = forMask ? '#fff' : stroke.color;
      context.lineWidth = stroke.size;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      stroke.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, size.width, size.height);
    replay(context, strokes);
  }, [strokes, ready, size]);

  const point = (event) => {
    const bounds = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  function save() {
    const overlay = document.createElement('canvas');
    overlay.width = size.width;
    overlay.height = size.height;
    replay(overlay.getContext('2d'), strokes);
    const mask = document.createElement('canvas');
    mask.width = size.width;
    mask.height = size.height;
    replay(mask.getContext('2d'), strokes, true);
    try {
      onSave?.(
        { overlay: overlay.toDataURL('image/png'), mask: mask.toDataURL('image/png'), width: size.width, height: size.height },
        { strokes, mode },
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
      onError?.(error.message);
    }
  }

  return createPortal(
    <div className="itk-backdrop" onWheel={(event) => event.stopPropagation()}>
      <div className="itk-dialog itk-annotate" role="dialog" aria-modal="true" aria-label="画笔标注">
        <header className="itk-header">
          <Icon name="brush" size={18} />
          <div className="itk-heading">
            <strong>画笔标注</strong>
            <span>输出透明叠加图与黑白蒙版</span>
          </div>
          <button type="button" className="itk-icon" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="itk-toolbar">
          <button type="button" aria-pressed={mode === 'draw'} onClick={() => setMode('draw')}>画笔</button>
          <button type="button" aria-pressed={mode === 'erase'} onClick={() => setMode('erase')}>橡皮</button>
          <label>颜色 <input type="color" value={color} onChange={(event) => setColor(event.target.value)} disabled={mode === 'erase'} /></label>
          <label>粗细 <input type="range" min={2} max={64} value={brush} onChange={(event) => setBrush(Number(event.target.value))} /></label>
          <button type="button" onClick={() => setStrokes([])}>清空</button>
        </div>
        <div className="itk-stage-wrap">
          <div className="itk-annotate-stage" style={{ width: size.width || 320, height: size.height || 240 }}>
            {ready && <canvas ref={canvasRef} width={size.width} height={size.height} />}
            <canvas
              className="itk-annotate-hit"
              width={size.width || 1}
              height={size.height || 1}
              onPointerDown={(event) => {
                if (!ready) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drawing.current = { erase: mode === 'erase', color, size: brush, points: [point(event)] };
                setStrokes((current) => [...current, drawing.current]);
              }}
              onPointerMove={(event) => {
                if (!drawing.current) return;
                drawing.current.points = [...drawing.current.points, point(event)];
                setStrokes((current) => current.map((item, index) => (index === current.length - 1 ? { ...item, points: drawing.current.points } : item)));
              }}
              onPointerUp={() => {
                drawing.current = null;
              }}
              onPointerCancel={() => {
                drawing.current = null;
              }}
            />
          </div>
        </div>
        <footer className="itk-footer">
          <span role="status">{message || `${strokes.length} 笔 · 蒙版为白色区域`}</span>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="itk-primary" disabled={!ready || !strokes.length} onClick={save}>保存标注</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default AnnotateDialog;
