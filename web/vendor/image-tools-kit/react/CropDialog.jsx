/**
 * 裁切 / 宫格对话框（独立版）。
 * 交互与几何来自原项目 `canvasImageCrop.tsx` + `imageCropGeometry.ts`，
 * 产物通过 `onSave` 交给宿主（上传、建节点或直接下载）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  centeredCrop,
  createCrop,
  cropHandles,
  cropOutputRects,
  cropRatio,
  cropRatios,
  equalCuts,
  gridRects,
  hitCrop,
  moveCrop,
  resizeCrop,
} from '../src/cropGeometry.js';
import { loadImage } from '../src/clientRenderer.js';
import { Icon } from './Icon.jsx';

const FALLBACK = { width: 1024, height: 1024 };

export function CropDialog({ src, mode: initialMode = 'crop', onClose, onSave, onError }) {
  const [image, setImage] = useState(null);
  const [natural, setNatural] = useState(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [display, setDisplay] = useState({ width: 0, height: 0 });
  const [rect, setRect] = useState(null);
  const [mode, setMode] = useState(initialMode);
  const [ratioLabel, setRatioLabel] = useState('Free');
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const [horizontalGap, setHorizontalGap] = useState(0);
  const [verticalGap, setVerticalGap] = useState(0);
  const [rowCuts, setRowCuts] = useState(() => equalCuts(2));
  const [columnCuts, setColumnCuts] = useState(() => equalCuts(2));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const stageRef = useRef(null);
  const drag = useRef(null);

  const fail = useCallback(
    (error) => {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      onError?.(text);
    },
    [onError],
  );

  useEffect(() => {
    if (!src) return;
    let alive = true;
    loadImage(src)
      .then((loaded) => {
        if (!alive) return;
        setImage(loaded);
        setNatural({
          width: loaded.naturalWidth || loaded.width || FALLBACK.width,
          height: loaded.naturalHeight || loaded.height || FALLBACK.height,
        });
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [src, fail]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!natural || !box.width || !box.height) return;
    const scale = Math.min(box.width / natural.width, box.height / natural.height, 1);
    const next = { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) };
    setDisplay(next);
    setRect((current) => current || centeredCrop(next, null));
  }, [natural, box]);

  useEffect(() => {
    const key = (event) => event.key === 'Escape' && !busy && onClose?.();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, busy]);

  useEffect(() => {
    if (!display.width) return;
    setRect(centeredCrop(display, cropRatio(ratioLabel, natural || display)));
  }, [ratioLabel, natural, display]);

  useEffect(() => {
    setRowCuts(equalCuts(rows));
  }, [rows]);
  useEffect(() => {
    setColumnCuts(equalCuts(columns));
  }, [columns]);

  const cuts = useMemo(() => {
    const cellCuts = mode === 'grid' ? { rowCuts, columnCuts } : { rowCuts: [], columnCuts: [] };
    return cellCuts;
  }, [mode, rowCuts, columnCuts]);

  const outputs = useMemo(() => {
    if (!rect || !natural || !display.width) return [];
    if (mode === 'grid') {
      return gridRects(rect, display, natural, rows, columns, verticalGap, horizontalGap);
    }
    const computed = cropOutputRects(rect, display, natural, [], [], 0, 0);
    const column = computed.columns[0];
    const row = computed.rows[0];
    return [{ x: column.start, y: row.start, width: column.size, height: row.size, row: 0, column: 0 }];
  }, [rect, natural, display, mode, rows, columns, verticalGap, horizontalGap]);

  const pointer = (event) => {
    const bounds = stageRef.current.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  function start(event) {
    if (!rect || busy) return;
    event.preventDefault();
    const point = pointer(event);
    const handle = hitCrop(rect, point);
    if (!handle) {
      drag.current = {
        type: 'draw',
        start: point,
        size: { width: display.width, height: display.height },
        ratio: cropRatio(ratioLabel, natural || display),
      };
      setRect(createCrop(point, point, { width: display.width, height: display.height }, drag.current.ratio));
      return;
    }
    drag.current = {
      type: handle === 'move' ? 'move' : 'resize',
      handle,
      start: point,
      origin: rect,
      ratio: cropRatio(ratioLabel, natural || display),
    };
    stageRef.current?.setPointerCapture?.(event.pointerId);
  }

  function onMove(event) {
    const current = drag.current;
    if (!current || !rect) return;
    const point = pointer(event);
    const size = { width: display.width, height: display.height };
    if (current.type === 'draw') setRect(createCrop(current.start, point, size, current.ratio));
    else if (current.type === 'move') setRect(moveCrop(current.origin, { x: point.x - current.start.x, y: point.y - current.start.y }, size));
    else setRect(resizeCrop(current.origin, current.handle, point, size, current.ratio));
  }

  function end(event) {
    drag.current = null;
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function save() {
    if (!image || !natural || !outputs.length || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const results = outputs.map((output) => {
        canvas.width = Math.max(1, Math.round(output.width));
        canvas.height = Math.max(1, Math.round(output.height));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, output.x, output.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, row: output.row, column: output.column };
      });
      const result = await onSave?.(results, { mode, rect: outputs[0], rows, columns, horizontalGap, verticalGap });
      if (result === false) throw new Error('宿主没有接受裁切结果。');
      setMessage(`已生成 ${results.length} 张图片`);
      if (!onSave) onClose?.();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  if (!image && message) {
    return createPortal(
      <div className="itk-backdrop">
        <div className="itk-dialog itk-small">
          <p role="alert">{message}</p>
          <footer>
            <button type="button" onClick={onClose}>关闭</button>
          </footer>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="itk-backdrop" onWheel={(event) => event.stopPropagation()}>
      <div className="itk-dialog" role="dialog" aria-modal="true" aria-label={mode === 'grid' ? '宫格裁切' : '裁切图片'}>
        <header className="itk-header">
          <div className="itk-tabs">
            <button type="button" aria-pressed={mode === 'crop'} onClick={() => setMode('crop')}>裁切</button>
            <button type="button" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')}>宫格裁切</button>
          </div>
          <div className="itk-hint">{natural ? `${natural.width} × ${natural.height}` : '加载中…'}</div>
          <button type="button" className="itk-icon" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>

        <div className="itk-toolbar">
          {mode === 'crop' ? (
            <label>
              比例
              <select value={ratioLabel} onChange={(event) => setRatioLabel(event.target.value)}>
                <option value="Free">自由</option>
                <option value="Original">原始比例</option>
                {cropRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label>行 <input type="number" min={1} max={10} value={rows} onChange={(event) => setRows(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} /></label>
              <label>列 <input type="number" min={1} max={10} value={columns} onChange={(event) => setColumns(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} /></label>
              <label>横间距 <input type="number" min={0} max={200} value={horizontalGap} onChange={(event) => setHorizontalGap(Math.max(0, Number(event.target.value) || 0))} /></label>
              <label>纵间距 <input type="number" min={0} max={200} value={verticalGap} onChange={(event) => setVerticalGap(Math.max(0, Number(event.target.value) || 0))} /></label>
            </>
          )}
          <span className="itk-count">输出 {outputs.length} 张</span>
        </div>

        <div className="itk-stage-wrap">
          <div
            ref={stageRef}
            className="itk-stage"
            onPointerDown={start}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          >
            {image ? (
              <div className="itk-canvas" style={{ width: display.width, height: display.height }}>
                <img src={src} alt="待裁切图片" draggable={false} style={{ width: display.width, height: display.height }} />
                {rect && (
                  <>
                    <div className="itk-mask" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
                    {mode === 'grid' &&
                      cuts.rowCuts.map((cut, index) => (
                        <div key={`row-${index}`} className="itk-cut itk-cut-row" style={{ top: rect.y + cut * rect.height }} />
                      ))}
                    {mode === 'grid' &&
                      cuts.columnCuts.map((cut, index) => (
                        <div key={`col-${index}`} className="itk-cut itk-cut-col" style={{ left: rect.x + cut * rect.width }} />
                      ))}
                    <div className="itk-rect" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
                      {cropHandles(rect).map((handle) => (
                        <span key={handle.id} className={`itk-handle itk-${handle.id}`} style={{ left: handle.x - rect.x, top: handle.y - rect.y }} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="itk-loading">正在加载图片…</p>
            )}
          </div>
        </div>

        <footer className="itk-footer">
          <span role="status">{message || (mode === 'grid' ? `按 ${rows}×${columns} 切成 ${outputs.length} 张` : '拖动边框调整裁切范围')}</span>
          <div>
            <button type="button" disabled={busy} onClick={onClose}>取消</button>
            <button type="button" className="itk-primary" disabled={busy || !outputs.length} onClick={save}>
              {busy ? '处理中…' : mode === 'grid' ? '保存宫格' : '保存裁切'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export default CropDialog;
