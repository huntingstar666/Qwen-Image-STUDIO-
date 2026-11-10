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
  /** 列表签名：只有数据/选中态真正变化时才重建 DOM，避免单击把双击的目标节点换掉。 */
  let lastSignature = '';
  /** 重命名输入框打开期间不重建列表，否则输入框会被 innerHTML 冲掉。 */
  let renaming = false;

  host.innerHTML = `
    <div class="studio-layers-head">
      <span class="studio-layers-title">图层 <span class="mono" data-lc-count>0</span></span>
      <span class="spacer"></span>
      <button class="studio-layers-add" type="button" data-lc-add title="添加图层：本地图片 / 素材仓库 / 图层库" aria-haspopup="menu" aria-expanded="false">＋</button>
      <button class="studio-layers-library" type="button" data-lc-library title="图层库：跨工程存取图层">库</button>
      <button class="studio-layers-collapse" type="button" data-lc-collapse title="收起图层栏" aria-label="收起图层栏">‹</button>
    </div>
    <div class="studio-add-menu" data-lc-add-menu role="menu" hidden>
      <button type="button" role="menuitem" data-lc-add-item="local">本地图片…</button>
      <button type="button" role="menuitem" data-lc-add-item="warehouse">从素材仓库…</button>
      <button type="button" role="menuitem" data-lc-add-item="library">从图层库…</button>
    </div>
    <div class="studio-library" data-lc-lib hidden>
      <div class="studio-library-head">
        <span class="studio-library-title">图层库</span>
        <button class="btn ghost sm" type="button" data-lc-lib-save title="把当前选中图层存入图层库">存入当前图层</button>
        <button class="studio-library-close" type="button" data-lc-lib-close aria-label="关闭">×</button>
      </div>
      <div class="studio-library-list" data-lc-lib-list></div>
      <div class="studio-library-empty" data-lc-lib-empty>还没有图层素材</div>
    </div>
    <div class="studio-layers-list" data-lc-list role="listbox" aria-label="图层"></div>
    <button class="studio-layers-empty" type="button" data-lc-empty>打开图片后可管理图层</button>
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
      <button type="button" data-lc-act="export" title="导出图层" aria-haspopup="menu" aria-expanded="false"><span class="glyph">⭳</span><span class="label">导出</span></button>
      <button type="button" data-lc-act="material" title="把选中图层存入素材仓库（PNG，画布尺寸、透明底）"><span class="glyph">☆</span><span class="label">素材</span></button>
      <button type="button" data-lc-act="group" title="把选中图层编成一个组（组可整体显隐 / 调不透明度 / 改混合）"><span class="glyph">▣</span><span class="label">成组</span></button>
      <button type="button" data-lc-act="ungroup" title="解散选中图层所在的组"><span class="glyph">▢</span><span class="label">解组</span></button>
      <button type="button" data-lc-act="merge" title="合并图层" aria-haspopup="menu" aria-expanded="false"><span class="glyph">⇩</span><span class="label">合并</span></button>
      <div class="studio-merge-menu" data-lc-merge-menu role="menu" hidden>
        <button type="button" role="menuitem" data-lc-merge="selected">合并选中</button>
        <button type="button" role="menuitem" data-lc-merge="down">向下合并（Ctrl/Cmd + E）</button>
        <button type="button" role="menuitem" data-lc-merge="visible">合并可见（Ctrl/Cmd + Shift + E）</button>
        <button type="button" role="menuitem" data-lc-merge="flatten">拼合图像（Ctrl/Cmd + Alt + Shift + E）</button>
      </div>
      <div class="studio-merge-menu" data-lc-export-menu role="menu" hidden>
        <button type="button" role="menuitem" data-lc-export="current">当前图层 PNG</button>
        <button type="button" role="menuitem" data-lc-export="visible">所有可见图层（逐个 PNG）</button>
        <button type="button" role="menuitem" data-lc-export="with-mask">当前图层 + 蒙版</button>
      </div>
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
    mergeMenu: host.querySelector('[data-lc-merge-menu]'),
    mergeBtn: host.querySelector('[data-lc-act="merge"]'),
    exportMenu: host.querySelector('[data-lc-export-menu]'),
    exportBtn: host.querySelector('[data-lc-act="export"]'),
    lib: host.querySelector('[data-lc-lib]'),
    libList: host.querySelector('[data-lc-lib-list]'),
    libEmpty: host.querySelector('[data-lc-lib-empty]'),
    libSave: host.querySelector('[data-lc-lib-save]'),
    addMenu: host.querySelector('[data-lc-add-menu]'),
    addBtn: host.querySelector('[data-lc-add]'),
  };

  /** D25.2：添加图层菜单（本地图片 / 素材仓库 / 图层库）。 */
  function setAddMenuOpen(open) {
    if (!refs.addMenu) return;
    refs.addMenu.hidden = !open;
    refs.addBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  const closeMergeMenu = () => {
    if (!refs.mergeMenu || refs.mergeMenu.hidden) return;
    refs.mergeMenu.hidden = true;
    refs.mergeBtn?.setAttribute('aria-expanded', 'false');
  };

  const toggleMergeMenu = () => {
    if (!refs.mergeMenu) return;
    const open = refs.mergeMenu.hidden;
    closeExportMenu();
    refs.mergeMenu.hidden = !open;
    refs.mergeBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  /** D26.4：导出菜单（当前图层 / 所有可见图层 / 当前图层 + 蒙版）。 */
  const closeExportMenu = () => {
    if (!refs.exportMenu || refs.exportMenu.hidden) return;
    refs.exportMenu.hidden = true;
    refs.exportBtn?.setAttribute('aria-expanded', 'false');
  };

  const toggleExportMenu = () => {
    if (!refs.exportMenu) return;
    const open = refs.exportMenu.hidden;
    closeMergeMenu();
    refs.exportMenu.hidden = !open;
    refs.exportBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  async function refreshLibrary() {
    const assets = (await ctx.listLayerAssets?.()) || [];
    refs.libList.innerHTML = assets
      .map(
        (asset) => `
      <div class="studio-library-item">
        <span class="studio-library-thumb">${
          asset.thumbUrl ? `<img src="${asset.thumbUrl}" alt="" />` : ''
        }</span>
        <span class="studio-library-name" title="${escapeHtml(asset.name || '')}">${escapeHtml(
          asset.name || '图层',
        )}</span>
        <button type="button" class="studio-library-btn" data-lc-lib-insert="${asset.id}">置入</button>
        <button type="button" class="studio-library-btn is-del" data-lc-lib-del="${asset.id}" title="删除">×</button>
      </div>`,
      )
      .join('');
    refs.libEmpty.hidden = assets.length > 0;
  }

  function setLibraryOpen(open) {
    if (!refs.lib) return;
    refs.lib.hidden = !open;
    if (open) void refreshLibrary();
  }

  const rows = () => ctx.listLayersForPanel?.() || [];

  /** 底部不透明滑杆的目标：选中组时调组不透明度，否则调主选图层。 */
  function opacityTargetId() {
    const groupId = ctx.getSelectedGroupId?.() || '';
    if (groupId) return `group:${groupId}`;
    return ctx.getSelectedLayerId?.() || '';
  }

  function chip(label, cls = '') {
    return `<span class="studio-layer-chip ${cls}">${label}</span>`;
  }

  /** 图层组行（D23.4 L4）：折叠箭头 + 组名 + 组员数 + 组显隐。 */
  function groupRowHtml(row) {
    const groupId = row.group.id;
    const selected = (ctx.getSelectedGroupId?.() || '') === groupId;
    const hidden = row.visible === false;
    const classes = ['studio-layer', 'is-group', selected ? 'is-selected' : '', hidden ? 'is-hidden' : '']
      .filter(Boolean)
      .join(' ');
    const opacity = Math.round((row.opacity ?? 1) * 100);
    return `
      <div class="${classes}" data-group="${groupId}" role="option" aria-selected="${selected}">
        <button class="studio-layer-caret" type="button" data-group-toggle="${groupId}"
          title="${row.collapsed ? '展开图层组' : '折叠图层组'}" aria-expanded="${row.collapsed ? 'false' : 'true'}">${
            row.collapsed ? '▸' : '▾'
          }</button>
        <span class="studio-layer-info">
          <button class="studio-layer-name" type="button" data-group-pick="${groupId}"
            title="单击选中组 · 双击重命名">${escapeHtml(row.name)}</button>
          <span class="studio-layer-meta">
            ${chip('组', 'is-kind')}${chip(`${row.count || 0} 层`)}
            <span class="studio-layer-alpha mono">${opacity}%</span>
          </span>
        </span>
        <button class="studio-layer-icon${hidden ? ' is-off' : ''}" type="button" data-group-visible="${groupId}"
          title="${hidden ? '显示图层组' : '隐藏图层组'}">${hidden ? '◌' : '◉'}</button>
        <span class="studio-layer-icon is-static" title="图层组的锁定请对组内图层单个设置">—</span>
      </div>`;
  }

  function rowHtml(layer) {
    if (layer.kind === 'group') return groupRowHtml(layer);
    const isBase = layer.kind === 'base';
    const selectedIds = ctx.getSelectedLayerIds?.() || [];
    const primaryId = ctx.getSelectedLayerId?.() || '';
    const selected =
      (isBase && Boolean(ctx.getBaseSelected?.())) || selectedIds.includes(layer.id) || primaryId === layer.id;
    const primary = primaryId === layer.id;
    const hidden = layer.visible === false;
    const classes = [
      'studio-layer',
      isBase ? 'is-base' : '',
      layer.indent ? 'is-indent' : '',
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
    // 智能对象（D23.4 L4）：面板角标，缩放不烘焙像素。
    if (layer.smart) chips.push(chip('智能', 'is-kind'));
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
    const count = list.filter((layer) => layer.kind !== 'base' && layer.kind !== 'group').length;
    refs.count.textContent = String(count);
    refs.spineCount.textContent = String(count);
    const selectedGroupId = ctx.getSelectedGroupId?.() || '';
    const selectedId = ctx.getSelectedLayerId?.() || '';
    const selectedIds = (ctx.getSelectedLayerIds?.() || []).filter(Boolean);
    if (!selectedIds.length && selectedId) selectedIds.push(selectedId);
    // 数据签名：名称 / 选中 / 显隐 / 锁定 / 几何 / 蒙版版本 / 缩略图相关状态。
    const signature =
      `${selectedIds.join(',')}|${selectedId}|${selectedGroupId}|${ctx.getBaseSelected?.() ? 1 : 0}|` +
      list
        .map((layer) => {
          if (layer.kind === 'group') {
            return `g:${layer.group.id}:${layer.name}:${layer.visible}:${layer.opacity}:${layer.collapsed}:${layer.count}`;
          }
          const mask = layer.mask ? (layer.maskVisible ? 1 : 0) : 2;
          return `l:${layer.id}:${layer.name}:${layer.visible}:${layer.locked}:${layer.opacity}:${
            layer.indent ? 1 : 0
          }:${mask}:${layer._maskStamp || 0}:${Math.round(layer.x || 0)},${Math.round(layer.y || 0)}:${
            Math.round((layer.scale || 1) * 1000)
          }:${layer.rotation || 0}:${layer.flipH ? 1 : 0}${layer.flipV ? 1 : 0}:${
            ctx.isLayerOutside?.(layer) ? 1 : 0
          }`;
        })
        .join('|');
    if (signature !== lastSignature && !renaming) {
      refs.list.innerHTML = list.map(rowHtml).join('');
      lastSignature = signature;
    }
    // D25.2：空态改成可点的「＋ 添加图层」，不再是一句点了没反应的提示。
    const canAdd = Boolean(ctx.canAddLayer?.());
    refs.empty.textContent = list.length ? '＋ 从文件或素材仓库添加图层' : '打开图片后可管理图层';
    refs.empty.disabled = !list.length;
    refs.empty.hidden = count > 0;
    if (refs.addBtn) refs.addBtn.disabled = !canAdd;
    const selected = list.find((layer) => layer.id === selectedId && layer.kind !== 'base') || null;
    const selectedGroup = selectedGroupId
      ? list.find((layer) => layer.kind === 'group' && layer.group.id === selectedGroupId) || null
      : null;
    // 组选中时只开放「成组 / 解组」，图层级操作（移动/复制/删除/导出）禁用。
    const canEdit = Boolean(selected) && !selectedGroup;
    const hasLayers = list.some((layer) => layer.kind !== 'base' && layer.kind !== 'group');
    const inAnyGroup = Boolean(selectedGroup) || Boolean(selected && ctx.isLayerGrouped?.(selected.id));
    // 上移/下移到达边界时禁用按钮，避免点了没反应像「坏了」（多选按整组判断）。
    const selectedRows = [];
    list.forEach((layer, index) => {
      if (layer.kind !== 'base' && layer.kind !== 'group' && selectedIds.includes(layer.id)) selectedRows.push(index);
    });
    const layerRowIndexes = [];
    list.forEach((layer, index) => {
      if (layer.kind !== 'base' && layer.kind !== 'group') layerRowIndexes.push(index);
    });
    const atTop = selectedRows.length > 0 && Math.min(...selectedRows) === layerRowIndexes[0];
    const atBottom =
      selectedRows.length > 0 && Math.max(...selectedRows) === layerRowIndexes[layerRowIndexes.length - 1];
    for (const button of refs.foot.querySelectorAll('[data-lc-act]')) {
      const act = button.dataset.lcAct;
      // 「合并」菜单里的「合并可见 / 拼合」不需要选中层，只要求有图层。
      if (act === 'merge') button.disabled = !hasLayers;
      else if (act === 'export') button.disabled = !hasLayers;
      else if (act === 'group') button.disabled = !(selected || selectedIds.length);
      else if (act === 'ungroup') button.disabled = !inAnyGroup;
      else if (act === 'up' || act === 'top') button.disabled = !canEdit || atTop;
      else if (act === 'down' || act === 'bottom') button.disabled = !canEdit || atBottom;
      else button.disabled = !canEdit;
    }
    const alphaTarget = selectedGroup || selected;
    refs.alpha.disabled = !alphaTarget;
    if (refs.libSave) refs.libSave.disabled = !canEdit;
    if (alphaTarget) {
      const value = Math.round((alphaTarget.opacity ?? 1) * 100);
      refs.alpha.value = String(value);
      refs.alphaVal.textContent = `${value}%`;
    }
  }

  function setCollapsed(collapsed) {
    host.classList.toggle('is-collapsed', collapsed);
    host.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  /** 供 F2 调用：打开该行（图层或组）的名称输入框。 */
  function beginRename(id) {
    const name = host.querySelector(`[data-layer-pick="${id}"]`);
    if (name) {
      name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }
    const groupName = host.querySelector(`[data-group-pick="${id}"]`);
    if (!groupName) return false;
    groupName.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  }

  /* ---------------------------------------------------------- 单击操作 */

  host.addEventListener('click', (event) => {
    // 点菜单/图层库以外的地方先收起浮层。
    if (!event.target.closest('.studio-merge-menu') && !event.target.closest('[data-lc-act="merge"]')) {
      closeMergeMenu();
    }
    if (!event.target.closest('[data-lc-export-menu]') && !event.target.closest('[data-lc-act="export"]')) {
      closeExportMenu();
    }
    if (!event.target.closest('.studio-library') && !event.target.closest('[data-lc-library]')) {
      setLibraryOpen(false);
    }
    if (!event.target.closest('[data-lc-add-menu]') && !event.target.closest('[data-lc-add]')) {
      setAddMenuOpen(false);
    }
    // D26.4：导出菜单项。
    const exportItem = event.target.closest('[data-lc-export]');
    if (exportItem) {
      closeExportMenu();
      void ctx.exportLayers?.(exportItem.dataset.lcExport);
      return;
    }
    // D25.2：添加图层菜单。
    const addBtn = event.target.closest('[data-lc-add]');
    if (addBtn && !addBtn.disabled) {
      setLibraryOpen(false);
      setAddMenuOpen(refs.addMenu?.hidden !== false);
      return;
    }
    const addEmpty = event.target.closest('[data-lc-empty]');
    if (addEmpty && !addEmpty.disabled) {
      setAddMenuOpen(true);
      return;
    }
    const addItem = event.target.closest('[data-lc-add-item]');
    if (addItem) {
      setAddMenuOpen(false);
      const kind = addItem.dataset.lcAddItem;
      if (kind === 'local') ctx.addLayerLocal?.();
      else if (kind === 'warehouse') ctx.addLayerFromWarehouse?.();
      else if (kind === 'library') setLibraryOpen(true);
      return;
    }
    const libBtn = event.target.closest('[data-lc-library]');
    if (libBtn) {
      setAddMenuOpen(false);
      setLibraryOpen(refs.lib?.hidden !== false);
      return;
    }
    const libClose = event.target.closest('[data-lc-lib-close]');
    if (libClose) {
      setLibraryOpen(false);
      return;
    }
    const libSave = event.target.closest('[data-lc-lib-save]');
    if (libSave) {
      void (async () => {
        const asset = await ctx.saveSelectedToLayerLibrary?.();
        if (asset) await refreshLibrary();
      })();
      return;
    }
    const libInsert = event.target.closest('[data-lc-lib-insert]');
    if (libInsert) {
      void ctx.insertLayerAsset?.(libInsert.dataset.lcLibInsert);
      setLibraryOpen(false);
      return;
    }
    const libDel = event.target.closest('[data-lc-lib-del]');
    if (libDel) {
      void (async () => {
        await ctx.deleteLayerAsset?.(libDel.dataset.lcLibDel);
        await refreshLibrary();
      })();
      return;
    }
    const mergeItem = event.target.closest('[data-lc-merge]');
    if (mergeItem) {
      closeMergeMenu();
      void ctx.mergeLayers?.(mergeItem.dataset.lcMerge);
      return;
    }
    const collapse = event.target.closest('[data-lc-collapse], [data-lc-spine]');
    if (collapse) {
      ctx.toggleCollapsed?.();
      return;
    }
    // 图层组行（D23.4 L4）：折叠 / 选中 / 组显隐。
    const groupToggle = event.target.closest('[data-group-toggle]');
    if (groupToggle) {
      ctx.toggleGroupCollapsed?.(groupToggle.dataset.groupToggle);
      return;
    }
    const groupPick = event.target.closest('[data-group-pick]');
    if (groupPick) {
      ctx.selectGroup?.(groupPick.dataset.groupPick);
      return;
    }
    const groupEye = event.target.closest('[data-group-visible]');
    if (groupEye) {
      ctx.toggleGroupVisible?.(groupEye.dataset.groupVisible);
      return;
    }
    const groupRow = event.target.closest('[data-group]');
    if (groupRow && !event.target.closest('button')) {
      ctx.selectGroup?.(groupRow.dataset.group);
      return;
    }
    const pick = event.target.closest('[data-layer-pick]');
    if (pick) {
      if (pick.dataset.layerPick === 'base') {
        // 主图行是 toggle：已选中再点一次 = 取消选择。
        if (ctx.getBaseSelected?.()) ctx.selectNone?.();
        else ctx.selectBase?.();
      } else
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
      const action = act.dataset.lcAct;
      if (action === 'merge') {
        toggleMergeMenu();
        return;
      }
      if (action === 'export') {
        toggleExportMenu();
        return;
      }
      if (action === 'group') {
        ctx.createGroupFromSelection?.();
        return;
      }
      if (action === 'ungroup') {
        ctx.ungroupSelection?.();
        return;
      }
      const id = ctx.getSelectedLayerId?.();
      if (!id) return;
      if (action === 'up') ctx.moveLayer?.(id, 1);
      else if (action === 'down') ctx.moveLayer?.(id, -1);
      else if (action === 'top') ctx.moveLayerEdge?.(id, 'top');
      else if (action === 'bottom') ctx.moveLayerEdge?.(id, 'bottom');
      else if (action === 'copy') ctx.cloneLayer?.(id);
      else if (action === 'del') ctx.removeLayer?.(id);
      else if (action === 'material') void ctx.saveSelectedToMaterials?.(id);
    }
  });

  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMergeMenu();
    setLibraryOpen(false);
  });

  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-lc-alpha]');
    if (!input) return;
    const id = opacityTargetId();
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
    // 图层组改名（D23.4 L4）。
    const groupName = event.target.closest('[data-group-pick]');
    if (groupName) {
      event.preventDefault();
      const groupId = groupName.dataset.groupPick;
      const row = rows().find((item) => item.kind === 'group' && item.group.id === groupId);
      if (!row) return;
      const input = document.createElement('input');
      input.className = 'studio-layer-rename';
      input.value = row.name;
      input.maxLength = 60;
      groupName.replaceWith(input);
      input.focus();
      input.select();
      renaming = true;
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        renaming = false;
        const next = input.value.trim();
        if (commit && next && next !== row.name) ctx.renameGroup?.(groupId, next);
        // 行内节点已被输入框替换：强制重建，否则签名未变会跳过 render，名称按钮永远回不来。
        lastSignature = '';
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
      return;
    }
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

    renaming = true;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      renaming = false;
      const next = input.value.trim();
      if (commit && next && next !== layer.name) ctx.renameLayer?.(layer.id, next);
      // 同上：输入框替换了名称按钮，必须强制重建列表。
      lastSignature = '';
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
    if (!row || row.dataset.layer === 'base' || row.dataset.group || event.target.closest('input')) {
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
    const row = event.target.closest?.('.studio-layer');
    if (!row) return;
    if (row.dataset.layer === draggingId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDrop();
    row.classList.add('is-drop');
  });

  host.addEventListener('drop', (event) => {
    const row = event.target.closest?.('.studio-layer');
    if (!draggingId || !row) return;
    event.preventDefault();
    const id = draggingId;
    // 拖到组行 = 移入该组（D23.4 L4）。
    if (row.dataset.group) {
      const groupId = row.dataset.group;
      stopDrag();
      ctx.assignLayerGroup?.(id, groupId);
      return;
    }
    if (!row.dataset.layer) return;
    // 面板顶层在上：落点 = 目标图层在 doc.layers 里的下标；主图行 = 0。
    const to =
      row.dataset.layer === 'base'
        ? 0
        : (ctx.getLayers?.() || []).findIndex((layer) => layer.id === row.dataset.layer);
    stopDrag();
    // 把组内图层拖到组外 = 移出该组（PS 的同一手势，D23.4 L4）。
    const sourceGroup = ctx.getLayerGroupId?.(id) || '';
    const targetGroup = row.dataset.layer === 'base' ? '' : ctx.getLayerGroupId?.(row.dataset.layer) || '';
    if (sourceGroup && targetGroup !== sourceGroup) ctx.assignLayerGroup?.(id, '');
    if (to < 0) return;
    ctx.moveLayerTo?.(id, to);
  });

  host.addEventListener('dragend', stopDrag);

  render();

  return { render, setCollapsed, beginRename, closeAddMenu: () => setAddMenuOpen(false) };
}
