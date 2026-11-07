/**
 * 边界框布局设计器（MOSS bbox 可视化编辑）。
 *
 * 后端 /api/generate 的 bbox 参数只对 MOSS 生效：
 * - items 使用目标画布的像素坐标（x / y / w / h，左上角为原点）；
 * - type 为 object / character / text，text 仅在文字框里必填；
 * - character_boxes 交给后端决定哪些序号按「角色」描述（"1" / "-1" / ""）。
 *
 * 左侧画布按 min(560/width, 420/height) 缩放显示，命中测试再换算回逻辑像素；
 * 右侧列表与画布双向同步。关闭后 DOM 随模态框一起销毁，再次打开是全新状态。
 */

import { openModal } from './modal.js';
import { clamp, escapeHtml } from '../utils.js';

const STAGE_MAX_W = 560;
const STAGE_MAX_H = 420;
const MIN_SIZE = 16;
const TYPES = ['object', 'character', 'text'];

const TYPE_COLORS = {
  object: { stroke: '#6fb3a8', fill: 'rgba(111, 179, 168, 0.16)' },
  character: { stroke: '#e0a15e', fill: 'rgba(224, 161, 94, 0.16)' },
  text: { stroke: '#8fa6e8', fill: 'rgba(143, 166, 232, 0.16)' },
};

const HANDLE_CURSORS = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

const ARROW_DELTA = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function normalizeType(value) {
  return TYPES.includes(value) ? value : 'object';
}

/** 八个缩放手柄的坐标（逻辑像素）。 */
function handlePoints(box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return [
    ['nw', box.x, box.y],
    ['n', cx, box.y],
    ['ne', box.x + box.w, box.y],
    ['e', box.x + box.w, cy],
    ['se', box.x + box.w, box.y + box.h],
    ['s', cx, box.y + box.h],
    ['sw', box.x, box.y + box.h],
    ['w', box.x, cy],
  ];
}

/**
 * 打开边界框布局设计器。
 * @param {{
 *   width: number,
 *   height: number,
 *   initial?: {enabled?: boolean, characterBoxes?: string, items?: Array},
 *   onApply?: (layout: {enabled: boolean, characterBoxes: string, items: Array}) => void,
 *   onClear?: () => void,
 * }} options
 */
export function openBboxStudio({ width, height, initial = null, onApply, onClear } = {}) {
  const W = Math.max(1, Math.round(Number(width) || 1024));
  const H = Math.max(1, Math.round(Number(height) || 1024));
  const scale = Math.min(STAGE_MAX_W / W, STAGE_MAX_H / H);
  const viewW = Math.max(1, Math.round(W * scale));
  const viewH = Math.max(1, Math.round(H * scale));
  // 屏幕 1px 对应的逻辑像素数：线宽、手柄、字号都按它换算，避免缩放后糊成一团。
  const unit = 1 / scale;

  let items = readItems(initial?.items);
  let selected = items.length ? 0 : -1;
  const initialCharacters = String(initial?.characterBoxes ?? '');
  let characterBoxes = ['1', '-1', ''].includes(initialCharacters) ? initialCharacters : '';
  let drag = null;
  let rows = [];

  /** 原样加载历史框，只把越界坐标收回画布内。 */
  function readItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const boxW = Math.round(clamp(Number(item?.w) || MIN_SIZE, MIN_SIZE, W));
      const boxH = Math.round(clamp(Number(item?.h) || MIN_SIZE, MIN_SIZE, H));
      return {
        x: Math.round(clamp(Number(item?.x) || 0, 0, W - boxW)),
        y: Math.round(clamp(Number(item?.y) || 0, 0, H - boxH)),
        w: boxW,
        h: boxH,
        type: normalizeType(item?.type),
        text: String(item?.text ?? ''),
        desc: String(item?.desc ?? ''),
      };
    });
  }

  const content = document.createElement('div');
  content.className = 'bbox-studio';
  content.innerHTML = `
    <div class="bbox-main">
      <div class="bbox-toolbar">
        <button class="btn ghost sm" type="button" data-action="add">新增框</button>
        <label class="bbox-char">角色框
          <select class="select bbox-char-select" data-ref="charBoxes">
            <option value="1"${characterBoxes === '1' ? ' selected' : ''}>1 个角色</option>
            <option value="-1"${characterBoxes === '-1' ? ' selected' : ''}>多角色</option>
            <option value=""${characterBoxes === '' ? ' selected' : ''}>不限制</option>
          </select>
        </label>
        <span class="bbox-size mono">${W} × ${H}</span>
        <span class="bbox-grow"></span>
        <button class="btn ghost sm" type="button" data-action="clear">清空全部</button>
      </div>
      <div class="bbox-stage">
        <canvas class="bbox-canvas" width="${W}" height="${H}"
          style="width:${viewW}px;height:${viewH}px"></canvas>
        <span class="bbox-stage-tip">空白拖拽新建 · 拖动框移动 · 八向手柄缩放</span>
      </div>
      <div class="bbox-hint">点击选中后可 Delete 删除，方向键微调 1px（Shift 10px）</div>
    </div>
    <aside class="bbox-side">
      <div class="bbox-side-head">
        <span>布局框</span>
        <span class="bbox-count mono" data-ref="count">0 个</span>
      </div>
      <div class="bbox-warn" data-ref="warn" hidden></div>
      <div class="bbox-list" data-ref="list"></div>
      <div class="bbox-empty" data-ref="empty">还没有布局框<br />在左侧画布空白处拖拽，或点「新增框」</div>
      <div class="bbox-note">bbox 布局仅对 MOSS 模型生效；坐标按目标画布 ${W}×${H} 像素保存，应用后由后端转换。</div>
    </aside>`;

  const refs = {
    canvas: content.querySelector('.bbox-canvas'),
    charBoxes: content.querySelector('[data-ref="charBoxes"]'),
    list: content.querySelector('[data-ref="list"]'),
    empty: content.querySelector('[data-ref="empty"]'),
    warn: content.querySelector('[data-ref="warn"]'),
    count: content.querySelector('[data-ref="count"]'),
  };

  /* ---------------- 画布绘制 ---------------- */

  function paint() {
    const ctx = refs.canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0f14';
    ctx.fillRect(0, 0, W, H);

    // 三分线参考
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = Math.max(1, unit);
    ctx.beginPath();
    for (let i = 1; i <= 2; i += 1) {
      const x = (W * i) / 3;
      const y = (H * i) / 3;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    // 画布边界
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5 * unit;
    ctx.strokeRect(0, 0, W, H);

    items.forEach((box, index) => {
      const color = TYPE_COLORS[box.type] || TYPE_COLORS.object;
      const active = index === selected;

      ctx.fillStyle = color.fill;
      ctx.fillRect(box.x, box.y, box.w, box.h);

      if (active) {
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = 3 * unit;
        ctx.strokeRect(box.x - unit, box.y - unit, box.w + unit * 2, box.h + unit * 2);
      }
      ctx.strokeStyle = active ? '#f7f9fa' : color.stroke;
      ctx.lineWidth = (active ? 1.8 : 1.2) * unit;
      ctx.strokeRect(box.x, box.y, box.w, box.h);

      // 序号 + 类型
      const label = `${index + 1} · ${box.type}`;
      const fontSize = 11 * unit;
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const pad = 4 * unit;
      const labelW = Math.min(ctx.measureText(label).width + pad * 2, W);
      const labelH = fontSize + pad * 2;
      const lx = clamp(box.x, 0, Math.max(0, W - labelW));
      const ly = box.y - labelH < 0 ? box.y : box.y - labelH;
      ctx.fillStyle = 'rgba(5, 9, 13, 0.78)';
      ctx.fillRect(lx, ly, labelW, labelH);
      ctx.fillStyle = active ? '#ffffff' : color.stroke;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + pad, ly + labelH / 2, Math.max(1, labelW - pad * 2));
    });

    if (selected < 0 || !items[selected]) return;
    const activeBox = items[selected];
    const size = 7 * unit;
    ctx.fillStyle = '#f7f9fa';
    ctx.strokeStyle = (TYPE_COLORS[activeBox.type] || TYPE_COLORS.object).stroke;
    ctx.lineWidth = 1.2 * unit;
    handlePoints(activeBox).forEach(([, hx, hy]) => {
      ctx.beginPath();
      ctx.rect(hx - size / 2, hy - size / 2, size, size);
      ctx.fill();
      ctx.stroke();
    });
  }

  /* ---------------- 列表渲染 ---------------- */

  function updateCount() {
    refs.count.textContent = `${items.length} 个`;
    refs.empty.hidden = items.length > 0;
    refs.list.hidden = items.length === 0;
  }

  function renderList() {
    refs.list.innerHTML = items.map((item, index) => `
      <div class="bbox-row${index === selected ? ' is-active' : ''}" data-index="${index}">
        <div class="bbox-row-head">
          <span class="bbox-index mono">${index + 1}</span>
          <select class="select bbox-type" data-field="type">
            ${TYPES.map((type) => `<option value="${type}"${item.type === type ? ' selected' : ''}>${type}</option>`).join('')}
          </select>
          <button class="bbox-del" type="button" data-action="delete" title="删除该框">×</button>
        </div>
        <div class="bbox-row-grid">
          ${['x', 'y', 'w', 'h'].map((key) => `
            <label class="bbox-field"><span>${key}</span>
              <input class="input mono" type="number" step="1" data-field="${key}" value="${item[key]}" />
            </label>`).join('')}
        </div>
        <label class="bbox-field">
          <span>文字</span>
          <input class="input" type="text" data-field="text" value="${escapeHtml(item.text)}"
            placeholder="文字框必填" ${item.type === 'text' ? 'required' : 'disabled'} />
        </label>
        <label class="bbox-field">
          <span>描述</span>
          <input class="input" type="text" data-field="desc" value="${escapeHtml(item.desc)}"
            placeholder="可选：画面内容描述" />
        </label>
      </div>`).join('');

    rows = [...refs.list.querySelectorAll('.bbox-row')].map((root, index) => bindRow(root, index));
    updateCount();
  }

  function bindRow(root, index) {
    const field = (key) => root.querySelector(`[data-field="${key}"]`);
    const row = {
      root,
      type: field('type'),
      text: field('text'),
      desc: field('desc'),
      x: field('x'),
      y: field('y'),
      w: field('w'),
      h: field('h'),
    };

    // 点任意字段都把该行设为选中，画布高亮同步
    root.addEventListener('pointerdown', () => selectItem(index));

    row.type.addEventListener('change', () => {
      items[index].type = normalizeType(row.type.value);
      const isText = items[index].type === 'text';
      row.text.disabled = !isText;
      row.text.required = isText;
      clearInvalid();
      paint();
    });

    row.text.addEventListener('input', () => {
      items[index].text = row.text.value;
      clearInvalid();
    });

    row.desc.addEventListener('input', () => {
      items[index].desc = row.desc.value;
    });

    ['x', 'y', 'w', 'h'].forEach((key) => {
      row[key].addEventListener('change', () => applyNumber(index, key));
    });

    root.querySelector('[data-action="delete"]').addEventListener('click', () => removeItem(index));
    return row;
  }

  /** 数字输入改框：夹在画布内并按 16px 最小边处理。 */
  function applyNumber(index, key) {
    const box = items[index];
    const row = rows[index];
    if (!box || !row) return;
    const raw = Number(row[key].value);
    const value = Number.isFinite(raw) ? Math.round(raw) : box[key];
    if (key === 'x') box.x = clamp(value, 0, W - box.w);
    else if (key === 'y') box.y = clamp(value, 0, H - box.h);
    else if (key === 'w') box.w = clamp(value, MIN_SIZE, W - box.x);
    else box.h = clamp(value, MIN_SIZE, H - box.y);
    row[key].value = String(box[key]);
    paint();
  }

  function syncRows() {
    rows.forEach((row, index) => {
      const box = items[index];
      if (!box) return;
      ['x', 'y', 'w', 'h'].forEach((key) => {
        if (document.activeElement !== row[key]) row[key].value = String(box[key]);
      });
      row.root.classList.toggle('is-active', index === selected);
    });
  }

  function selectItem(index) {
    if (index < 0 || index >= items.length) return;
    selected = index;
    syncRows();
    paint();
  }

  function clearInvalid() {
    refs.warn.hidden = true;
    rows.forEach((row) => {
      row.root.classList.remove('is-invalid');
      row.text.classList.remove('invalid');
    });
  }

  function removeItem(index) {
    if (index < 0 || index >= items.length) return;
    items.splice(index, 1);
    selected = items.length ? Math.min(index, items.length - 1) : -1;
    clearInvalid();
    renderList();
    paint();
  }

  /* ---------------- 画布交互 ---------------- */

  function canvasPoint(event) {
    const rect = refs.canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * W,
      ((event.clientY - rect.top) / Math.max(1, rect.height)) * H,
    ];
  }

  function hitTest([x, y]) {
    const radius = 8 * unit;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const box = items[i];
      if (i === selected) {
        for (const [key, hx, hy] of handlePoints(box)) {
          if (Math.abs(x - hx) <= radius && Math.abs(y - hy) <= radius) {
            return { index: i, handle: key };
          }
        }
      }
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
        return { index: i, handle: null };
      }
    }
    return null;
  }

  refs.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const hit = hitTest(point);

    if (hit) {
      selectItem(hit.index);
      drag = {
        mode: hit.handle ? 'resize' : 'move',
        handle: hit.handle,
        index: hit.index,
        origin: { ...items[hit.index] },
        start: point,
      };
      refs.canvas.style.cursor = hit.handle ? HANDLE_CURSORS[hit.handle] : 'grabbing';
    } else {
      // 空白处按下：从落点拖出一个新框
      const start = [clamp(point[0], 0, W), clamp(point[1], 0, H)];
      items.push({
        x: Math.round(start[0]),
        y: Math.round(start[1]),
        w: MIN_SIZE,
        h: MIN_SIZE,
        type: 'object',
        text: '',
        desc: '',
      });
      selected = items.length - 1;
      drag = { mode: 'create', handle: null, index: selected, origin: null, start };
      renderList();
      refs.canvas.style.cursor = 'crosshair';
    }

    refs.canvas.setPointerCapture(event.pointerId);
    refs.canvas.classList.add('is-dragging');
    paint();
  });

  refs.canvas.addEventListener('pointermove', (event) => {
    const point = canvasPoint(event);

    if (!drag) {
      const hit = hitTest(point);
      refs.canvas.style.cursor = hit
        ? (hit.handle ? HANDLE_CURSORS[hit.handle] : 'grab')
        : 'crosshair';
      return;
    }

    const box = items[drag.index];
    if (!box) return;

    if (drag.mode === 'create') {
      const left = clamp(Math.min(drag.start[0], point[0]), 0, W - MIN_SIZE);
      const top = clamp(Math.min(drag.start[1], point[1]), 0, H - MIN_SIZE);
      const right = clamp(Math.max(drag.start[0], point[0]), left + MIN_SIZE, W);
      const bottom = clamp(Math.max(drag.start[1], point[1]), top + MIN_SIZE, H);
      box.x = Math.round(left);
      box.y = Math.round(top);
      box.w = Math.max(MIN_SIZE, Math.round(right) - Math.round(left));
      box.h = Math.max(MIN_SIZE, Math.round(bottom) - Math.round(top));
    } else if (drag.mode === 'move') {
      box.x = Math.round(clamp(drag.origin.x + point[0] - drag.start[0], 0, W - box.w));
      box.y = Math.round(clamp(drag.origin.y + point[1] - drag.start[1], 0, H - box.h));
    } else {
      // 八向缩放：分别收放四条边，始终保持最小尺寸与画布边界
      let left = drag.origin.x;
      let top = drag.origin.y;
      let right = drag.origin.x + drag.origin.w;
      let bottom = drag.origin.y + drag.origin.h;
      const handle = drag.handle || '';
      if (handle.includes('w')) left = clamp(point[0], 0, right - MIN_SIZE);
      if (handle.includes('e')) right = clamp(point[0], left + MIN_SIZE, W);
      if (handle.includes('n')) top = clamp(point[1], 0, bottom - MIN_SIZE);
      if (handle.includes('s')) bottom = clamp(point[1], top + MIN_SIZE, H);
      box.x = Math.round(left);
      box.y = Math.round(top);
      box.w = Math.max(MIN_SIZE, Math.round(right) - Math.round(left));
      box.h = Math.max(MIN_SIZE, Math.round(bottom) - Math.round(top));
    }

    syncRows();
    paint();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    refs.canvas.classList.remove('is-dragging');
    refs.canvas.style.cursor = 'crosshair';
    paint();
  };
  refs.canvas.addEventListener('pointerup', endDrag);
  refs.canvas.addEventListener('pointercancel', endDrag);

  /* ---------------- 键盘快捷键 ---------------- */

  function onKey(event) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, select, textarea')) return;
    if (selected < 0 || !items[selected]) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeItem(selected);
      return;
    }

    const delta = ARROW_DELTA[event.key];
    if (!delta) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const box = items[selected];
    box.x = Math.round(clamp(box.x + delta[0] * step, 0, W - box.w));
    box.y = Math.round(clamp(box.y + delta[1] * step, 0, H - box.h));
    syncRows();
    paint();
  }
  document.addEventListener('keydown', onKey);

  /* ---------------- 顶部工具 ---------------- */

  refs.charBoxes.value = characterBoxes;
  refs.charBoxes.addEventListener('change', () => {
    characterBoxes = refs.charBoxes.value;
  });

  content.querySelector('[data-action="add"]').addEventListener('click', () => {
    const boxW = Math.max(MIN_SIZE, Math.round(W * 0.3));
    const boxH = Math.max(MIN_SIZE, Math.round(H * 0.3));
    const offset = Math.round((items.length % 4) * Math.min(W, H) * 0.04);
    items.push({
      x: Math.round(clamp((W - boxW) / 2 + offset, 0, W - boxW)),
      y: Math.round(clamp((H - boxH) / 2 + offset, 0, H - boxH)),
      w: boxW,
      h: boxH,
      type: 'object',
      text: '',
      desc: '',
    });
    selected = items.length - 1;
    clearInvalid();
    renderList();
    paint();
    rows[selected]?.root.scrollIntoView({ block: 'nearest' });
  });

  content.querySelector('[data-action="clear"]').addEventListener('click', () => {
    items = [];
    selected = -1;
    clearInvalid();
    renderList();
    paint();
    onClear?.();
  });

  renderList();
  paint();

  openModal({
    title: '布局设计',
    subtitle: '拖拽画框，为 MOSS 指定每个元素的位置、类型与内容',
    content,
    size: 'lg',
    dialogClass: 'bbox-dialog-modal',
    actions: [
      { label: '取消' },
      {
        label: '应用布局',
        kind: 'primary',
        onClick: () => {
          clearInvalid();
          const badIndex = items.findIndex((item) => item.type === 'text' && !item.text.trim());
          if (badIndex >= 0) {
            // 文字框没填文字：阻止应用，滚动并高亮对应的行
            selected = badIndex;
            renderList();
            const row = rows[badIndex];
            row?.root.classList.add('is-invalid');
            row?.text.classList.add('invalid');
            refs.warn.hidden = false;
            refs.warn.textContent = `第 ${badIndex + 1} 个框是文字框，请填写文字内容后再应用。`;
            row?.text.focus();
            row?.root.scrollIntoView({ block: 'nearest' });
            paint();
            return false;
          }
          onApply?.({
            enabled: true,
            characterBoxes,
            items: items.map(({ x, y, w, h, type, text, desc }) => ({ x, y, w, h, type, text, desc })),
          });
          return true;
        },
      },
    ],
    onClose: () => document.removeEventListener('keydown', onKey),
  });
}
