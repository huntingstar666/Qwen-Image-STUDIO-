/**
 * 图层面板条（D7.3）：列表渲染 + 拖拽排序、双击重命名、锁定、不透明度。
 *
 * 只负责 DOM 与交互，状态变更全部回调给 studio.js 的图层控制器：
 *   getLayers() / selectLayer(id) / removeLayer(id) / cloneLayer(id)
 *   moveLayer(id, delta) / moveLayerTo(id, index) / setLayerOpacity(id, v)
 *   scaleLayer(id, f) / commitLayers() / renameLayer(id, name) / toggleLayerLock(id)
 *   toggleLayerMask(id) / editLayerMask(id) / removeLayerMask(id) / getMaskLayer()
 *
 * 数组顺序 `layers[0]` 最底层 → 末尾最上层，面板按同一顺序自上而下渲染。
 */

import { escapeHtml } from '../../utils.js';

export function createLayerPanel(host, ctx) {
  let draggingId = '';

  const list = () => ctx.getLayers?.() || [];

  function rowHtml(layer) {
    const maskEditing = ctx.getMaskLayer?.() === layer.id;
    const maskClass = [
      'ai-layer-btn',
      layer.mask ? 'has-mask' : '',
      layer.mask && !layer.maskVisible ? 'is-off' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const maskTitle = layer.mask
      ? layer.maskVisible
        ? '隐藏图层蒙版（Shift 点击删除）'
        : '显示图层蒙版（Shift 点击删除）'
      : '添加图层蒙版';
    return `
      <div class="ai-layer${layer.locked ? ' is-locked' : ''}" data-layer="${layer.id}" draggable="true">
        <span class="ai-layer-grip" title="拖动排序">⋮⋮</span>
        <button class="ai-layer-name" type="button" data-layer-pick="${layer.id}"
          title="单击选中 · 双击重命名">${escapeHtml(layer.name)}</button>
        <button class="${maskClass}" type="button" data-layer-mask="${layer.id}"
          title="${maskTitle}">◐</button>
        <button class="ai-layer-btn${maskEditing ? ' is-active' : ''}" type="button" data-layer-mask-edit="${layer.id}"
          title="涂抹图层蒙版" ${layer.mask ? '' : 'hidden'}>✎</button>
        <button class="ai-layer-btn" type="button" data-layer-lock="${layer.id}"
          title="${layer.locked ? '解锁图层' : '锁定图层'}">${layer.locked ? '🔒' : '🔓'}</button>
        <button class="ai-layer-btn" type="button" data-layer-scale="${layer.id}" title="缩小">−</button>
        <button class="ai-layer-btn" type="button" data-layer-scale="${layer.id}" data-dir="1" title="放大">＋</button>
        <input class="ai-layer-alpha" type="range" min="0" max="100" step="1" value="${Math.round(layer.opacity * 100)}"
          data-layer-alpha="${layer.id}" title="不透明度" />
        <button class="ai-layer-btn" type="button" data-layer-copy="${layer.id}" title="复制图层">⧉</button>
        <button class="ai-layer-btn" type="button" data-layer-move="${layer.id}" data-dir="-1" title="下移一层">↓</button>
        <button class="ai-layer-btn" type="button" data-layer-move="${layer.id}" data-dir="1" title="上移一层">↑</button>
        <button class="ai-layer-btn" type="button" data-layer-del="${layer.id}" title="删除">×</button>
      </div>`;
  }

  function render() {
    const layers = list();
    if (!layers.length) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = layers.map(rowHtml).join('');
  }

  /* ---------------------------------------------------------- 单击操作 */

  host.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-layer-pick]');
    if (pick) {
      ctx.selectLayer?.(pick.dataset.layerPick);
      return;
    }
    const lock = event.target.closest('[data-layer-lock]');
    if (lock) {
      ctx.toggleLayerLock?.(lock.dataset.layerLock);
      render();
      return;
    }
    const mask = event.target.closest('[data-layer-mask]');
    if (mask) {
      const layer = list().find((item) => item.id === mask.dataset.layerMask);
      if (event.shiftKey && layer?.mask) ctx.removeLayerMask?.(layer.id);
      else ctx.toggleLayerMask?.(mask.dataset.layerMask);
      render();
      return;
    }
    const maskEdit = event.target.closest('[data-layer-mask-edit]');
    if (maskEdit) {
      ctx.editLayerMask?.(maskEdit.dataset.layerMaskEdit);
      render();
      return;
    }
    const del = event.target.closest('[data-layer-del]');
    if (del) {
      ctx.removeLayer?.(del.dataset.layerDel);
      render();
      return;
    }
    const scale = event.target.closest('[data-layer-scale]');
    if (scale) {
      ctx.scaleLayer?.(scale.dataset.layerScale, scale.dataset.dir === '1' ? 1.1 : 1 / 1.1);
      render();
      return;
    }
    const copy = event.target.closest('[data-layer-copy]');
    if (copy) {
      ctx.cloneLayer?.(copy.dataset.layerCopy);
      render();
      return;
    }
    const move = event.target.closest('[data-layer-move]');
    if (move) {
      ctx.moveLayer?.(move.dataset.layerMove, Number(move.dataset.dir) || 0);
      render();
    }
  });

  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-layer-alpha]');
    if (!input) return;
    ctx.setLayerOpacity?.(input.dataset.layerAlpha, Number(input.value) / 100);
  });

  host.addEventListener('change', (event) => {
    if (!event.target.closest('[data-layer-alpha]')) return;
    ctx.commitLayers?.();
  });

  /* ---------------------------------------------------------- 双击重命名 */

  host.addEventListener('dblclick', (event) => {
    const name = event.target.closest('[data-layer-pick]');
    if (!name) return;
    const layer = list().find((item) => item.id === name.dataset.layerPick);
    if (!layer) return;
    event.preventDefault();
    const input = document.createElement('input');
    input.className = 'ai-layer-rename';
    input.value = layer.name;
    input.maxLength = 60;
    name.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (commit && next && next !== layer.name) ctx.renameLayer?.(layer.id, next);
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });

  /* ---------------------------------------------------------- 拖拽排序 */

  const clearDrop = () => {
    for (const el of host.querySelectorAll('.ai-layer.is-drop')) el.classList.remove('is-drop');
  };

  const stopDrag = () => {
    draggingId = '';
    for (const el of host.querySelectorAll('.ai-layer.is-dragging')) el.classList.remove('is-dragging');
    clearDrop();
  };

  host.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('[data-layer]');
    if (!row || event.target.closest('input')) {
      event.preventDefault();
      return;
    }
    draggingId = row.dataset.layer;
    row.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // 部分浏览器要求写入数据才会真正启动拖拽。
      try {
        event.dataTransfer.setData('text/plain', draggingId);
      } catch {
        /* 忽略：合成事件没有 dataTransfer 实现 */
      }
    }
  });

  host.addEventListener('dragover', (event) => {
    if (!draggingId) return;
    const row = event.target.closest?.('[data-layer]');
    if (!row || row.dataset.layer === draggingId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDrop();
    row.classList.add('is-drop');
  });

  host.addEventListener('drop', (event) => {
    const row = event.target.closest?.('[data-layer]');
    if (!draggingId || !row) return;
    event.preventDefault();
    // 目标下标以原始列表计算；moveLayer 会自行裁剪越界并去重。
    const to = list().findIndex((item) => item.id === row.dataset.layer);
    const id = draggingId;
    stopDrag();
    if (to < 0) return;
    ctx.moveLayerTo?.(id, to);
    render();
  });

  host.addEventListener('dragend', stopDrag);

  return { render };
}
