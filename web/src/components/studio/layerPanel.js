/**
 * 左侧图层栏（D23.1 L1）。
 *
 * 只负责 DOM 与交互，状态变更全部回调给 studio.js 的图层控制器：
 *   listLayersForPanel() / getSelectedLayerId() / getMaskLayer() / getLayerThumb(layer)
 *   selectLayer(id) / selectNone() / toggleBaseVisible()
 *   toggleLayerVisible(id) / toggleLayerLock(id) / removeLayer(id) / cloneLayer(id)
 *   moveLayer(id, delta) / moveLayerTo(id, index) / moveLayerEdge(id, 'top'|'bottom')
 *   renameLayer(id, name) / toggleLayerMask(id) / editLayerMask(id) / removeLayerMask(id)
 *   setLayerOpacity(id, v) / commitLayers() / toggleCollapsed()
 *
 * PS 语义：面板最上面 = 最上层；主图虚拟行（id='base'）固定置底、不可拖动/删除。
 */

import { escapeHtml } from '../../utils.js';

export function createLayerColumn(host, ctx) {
  let draggingId = '';

  host.innerHTML = `
    <div class="studio-layers-head">
      <span class="studio-layers-title">图层 <span class="mono" data-lc-count>0</span></span>
      <button class="studio-layers-collapse" type="button" data-lc-collapse title="收起图层栏" aria-label="收起图层栏">‹</button>
    </div>
    <div class="studio-layers-list" data-lc-list role="listbox" aria-label="图层"></div>
    <div class="studio-layers-empty" data-lc-empty>打开图片后可管理图层</div>
    <label class="studio-layers-opacity">
      <span>不透明</span>
      <input type="range" min="0" max="100" step="1" value="100" data-lc-alpha aria-label="图层不透明度" />
      <span class="mono" data-lc-alpha-val>100%</span>
    </label>
    <div class="studio-layers-foot">
      <button type="button" data-lc-act="up" title="上移一层（Alt + ]）"><span class="glyph">↑</span><span class="label">上移</span></button>
      <button type="button" data-lc-act="down" title="下移一层（Alt + [）"><span class="glyph">↓</span><span class="label">下移</span></button>
      <button type="button" data-lc-act="top" title="置顶（Ctrl/Cmd + Shift + ]）"><span class="glyph">⤒</span><span class="label">置顶</span></button>
      <button type="button" data-lc-act="bottom" title="置底（Ctrl/Cmd + Shift + [）"><span class="glyph">⤓</span><span class="label">置底</span></button>
      <button type="button" data-lc-act="copy" title="复制图层（Ctrl/Cmd + J）"><span class="glyph">⧉</span><span class="label">复制</span></button>
      <button type="button" data-lc-act="del" title="删除图层（Delete）"><span class="glyph">✕</span><span class="label">删除</span></button>
    </div>
    <button class="studio-layers-spine" type="button" data-lc-spine title="展开图层栏" aria-label="展开图层栏">
      <span class="studio-layers-spine-count mono" data-lc-spine-count>0</span>
      <span class="studio-layers-spine-label">图层</span>
    </button>`;

  const refs = {
    count: host.querySelector('[data-lc-count]'),
    spineCount: host.querySelector('[data-lc-spine-count]'),
    list: host.querySelector('[data-lc-list]'),
    empty: host.querySelector('[data-lc-empty]'),
    alpha: host.querySelector('[data-lc-alpha]'),
    alphaVal: host.querySelector('[data-lc-alpha-val]'),
    foot: host.querySelector('.studio-layers-foot'),
  };

  const rows = () => ctx.listLayersForPanel?.() || [];

  function chip(label, cls = '') {
    return `<span class="studio-layer-chip ${cls}">${label}</span>`;
  }

  function rowHtml(layer) {
    const isBase = layer.kind === 'base';
    const selectedIds = ctx.getSelectedLayerIds?.() || [];
    const primaryId = ctx.getSelectedLayerId?.() || '';
    const selected = selectedIds.includes(layer.id) || primaryId === layer.id;
    const primary = primaryId === layer.id;
    const hidden = layer.visible === false;
    const classes = [
      'studio-layer',
      isBase ? 'is-base' : '',
      selected ? 'is-selected' : '',
      primary ? 'is-primary' : '',
      hidden ? 'is-hidden' : '',
      layer.locked ? 'is-locked' : '',
      layer.isAdjustment ? 'is-adjust' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const thumb = ctx.getLayerThumb?.(layer) || '';
    const opacity = Math.round((layer.opacity ?? 1) * 100);
    const chips = [];
    chips.push(chip(isBase ? '背景' : '图层', 'is-kind'));
    if (layer.isAdjustment) chips.push(chip('调整', 'is-kind'));
    if (layer.isText) chips.push(chip('文字', 'is-kind'));
    if (layer.isShape) chips.push(chip('形状', 'is-kind'));
    if (layer.clipped) chips.push(chip('剪贴', 'is-kind'));
    if (!isBase && !layer.isText && !layer.isShape) {
      const maskClass = layer.mask ? (layer.maskVisible ? 'is-on' : 'is-muted') : '';
      const maskTitle = layer.mask
        ? layer.maskVisible
          ? '隐藏图层蒙版（Shift 点击删除）'
          : '显示图层蒙版（Shift 点击删除）'
        : '添加图层蒙版';
      chips.push(
        `<button class="studio-layer-chip is-act ${maskClass}" type="button" data-layer-mask="${layer.id}" title="${maskTitle}">蒙</button>`,
      );
      if (layer.mask) {
        const editing = ctx.getMaskLayer?.() === layer.id;
        chips.push(
          `<button class="studio-layer-chip is-act${editing ? ' is-on' : ''}" type="button" data-layer-mask-edit="${layer.id}" title="涂抹图层蒙版">✎</button>`,
        );
      }
    }
    return `
      <div class="${classes}" data-layer="${layer.id}" role="option" aria-selected="${selected}" ${
        isBase ? '' : 'draggable="true"'
      }>
        <span class="studio-layer-thumb${thumb ? '' : ' is-empty'}">${
          thumb ? `<img src="${thumb}" alt="" />` : '<span>调</span>'
        }</span>
        <span class="studio-layer-info">
          <button class="studio-layer-name" type="button" data-layer-pick="${layer.id}" title="${escapeHtml(
            isBase ? layer.name : '单击选中 · 双击重命名',
          )}">${escapeHtml(layer.name)}</button>
          <span class="studio-layer-meta">${chips.join('')}${
            ctx.isLayerOutside?.(layer)
              ? '<span class="studio-layer-oob" title="图层部分在画布外">•</span>'
              : ''
          }<span class="studio-layer-alpha mono">${opacity}%</span></span>
        </span>
        <button class="studio-layer-icon${hidden ? ' is-off' : ''}" type="button" data-layer-visible="${layer.id}"
          title="${hidden ? '显示图层' : '隐藏图层'}">${hidden ? '◌' : '◉'}</button>
        <button class="studio-layer-icon" type="button" data-layer-lock="${layer.id}"
          title="${isBase ? '主图不可编辑' : layer.locked ? '解锁图层' : '锁定图层'}">${
            isBase || layer.locked ? '🔒' : '🔓'
          }</button>
      </div>`;
  }

  function render() {
    const list = rows();
    const count = list.filter((layer) => layer.kind !== 'base').length;
    refs.count.textContent = String(count);
    refs.spineCount.textContent = String(count);
    refs.list.innerHTML = list.map(rowHtml).join('');
    refs.empty.textContent = list.length ? '从文件或图层库添加图层' : '打开图片后可管理图层';
    refs.empty.hidden = count > 0;
    const selectedId = ctx.getSelectedLayerId?.() || '';
    const selected = list.find((layer) => layer.id === selectedId && layer.kind !== 'base') || null;
    const canEdit = Boolean(selected);
    for (const button of refs.foot.querySelectorAll('[data-lc-act]')) {
      button.disabled = !canEdit;
    }
    refs.alpha.disabled = !canEdit;
    if (selected) {
      const value = Math.round((selected.opacity ?? 1) * 100);
      refs.alpha.value = String(value);
      refs.alphaVal.textContent = `${value}%`;
    }
  }

  function setCollapsed(collapsed) {
    host.classList.toggle('is-collapsed', collapsed);
    host.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  /** 供 F2 调用：打开该行的名称输入框。 */
  function beginRename(id) {
    const name = host.querySelector(`[data-layer-pick="${id}"]`);
    if (!name) return false;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  }

  /* ---------------------------------------------------------- 单击操作 */

  host.addEventListener('click', (event) => {
    const collapse = event.target.closest('[data-lc-collapse], [data-lc-spine]');
    if (collapse) {
      ctx.toggleCollapsed?.();
      return;
    }
    const pick = event.target.closest('[data-layer-pick]');
    if (pick) {
      if (pick.dataset.layerPick === 'base') ctx.selectNone?.();
      else
        ctx.selectLayer?.(pick.dataset.layerPick, {
          additive: event.metaKey || event.ctrlKey,
          range: event.shiftKey,
        });
      return;
    }
    const eye = event.target.closest('[data-layer-visible]');
    if (eye) {
      if (eye.dataset.layerVisible === 'base') ctx.toggleBaseVisible?.();
      else ctx.toggleLayerVisible?.(eye.dataset.layerVisible);
      return;
    }
    const lock = event.target.closest('[data-layer-lock]');
    if (lock) {
      if (lock.dataset.layerLock === 'base') ctx.baseLockedHint?.();
      else ctx.toggleLayerLock?.(lock.dataset.layerLock);
      return;
    }
    const mask = event.target.closest('[data-layer-mask]');
    if (mask) {
      const layer = rows().find((item) => item.id === mask.dataset.layerMask);
      if (event.shiftKey && layer?.mask) ctx.removeLayerMask?.(layer.id);
      else ctx.toggleLayerMask?.(mask.dataset.layerMask);
      return;
    }
    const maskEdit = event.target.closest('[data-layer-mask-edit]');
    if (maskEdit) {
      ctx.editLayerMask?.(maskEdit.dataset.layerMaskEdit);
      return;
    }
    const act = event.target.closest('[data-lc-act]');
    if (act) {
      const id = ctx.getSelectedLayerId?.();
      if (!id) return;
      if (act.dataset.lcAct === 'up') ctx.moveLayer?.(id, 1);
      else if (act.dataset.lcAct === 'down') ctx.moveLayer?.(id, -1);
      else if (act.dataset.lcAct === 'top') ctx.moveLayerEdge?.(id, 'top');
      else if (act.dataset.lcAct === 'bottom') ctx.moveLayerEdge?.(id, 'bottom');
      else if (act.dataset.lcAct === 'copy') ctx.cloneLayer?.(id);
      else if (act.dataset.lcAct === 'del') ctx.removeLayer?.(id);
    }
  });

  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-lc-alpha]');
    if (!input) return;
    const id = ctx.getSelectedLayerId?.();
    if (!id) return;
    refs.alphaVal.textContent = `${input.value}%`;
    ctx.setLayerOpacity?.(id, Number(input.value) / 100);
  });

  host.addEventListener('change', (event) => {
    if (!event.target.closest('[data-lc-alpha]')) return;
    ctx.commitLayers?.();
  });

  /* ---------------------------------------------------------- 双击重命名 */

  host.addEventListener('dblclick', (event) => {
    const name = event.target.closest('[data-layer-pick]');
    if (!name) return;
    const layer = rows().find((item) => item.id === name.dataset.layerPick);
    if (!layer) return;
    if (layer.kind === 'base') {
      ctx.baseLockedHint?.();
      return;
    }
    event.preventDefault();
    const input = document.createElement('input');
    input.className = 'studio-layer-rename';
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
    for (const el of host.querySelectorAll('.studio-layer.is-drop')) el.classList.remove('is-drop');
  };

  const stopDrag = () => {
    draggingId = '';
    for (const el of host.querySelectorAll('.studio-layer.is-dragging')) el.classList.remove('is-dragging');
    clearDrop();
  };

  host.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('[data-layer]');
    if (!row || row.dataset.layer === 'base' || event.target.closest('input')) {
      event.preventDefault();
      return;
    }
    draggingId = row.dataset.layer;
    row.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
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
    const id = draggingId;
    // 面板顶层在上：落点 = 目标图层在 doc.layers 里的下标；主图行 = 0。
    const to =
      row.dataset.layer === 'base'
        ? 0
        : (ctx.getLayers?.() || []).findIndex((layer) => layer.id === row.dataset.layer);
    stopDrag();
    if (to < 0) return;
    ctx.moveLayerTo?.(id, to);
  });

  host.addEventListener('dragend', stopDrag);

  render();

  return { render, setCollapsed, beginRename };
}
