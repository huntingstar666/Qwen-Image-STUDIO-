/**
 * 扩图 / 外补画布面板（图片精修）。
 *
 * 交互对齐孤海「外补画板」：四边百分比 + 快捷比例 + 最大输出长边，
 * 画布上叠一层「幽灵预览」——原图区域保持清晰，外补区半透明灰，
 * 四个边 + 四个角都能直接拖，拖的时候实时给出百分比。
 *
 * 数值只写 `settings.edit.overrides` 的 `outpaint.*`，预设/覆盖项与 AI 面板同一份。
 */

import { patchSettings, store } from '../../store.js';
import { toastWarn } from '../toast.js';
import {
  effectiveValue,
  findPreset,
  loadPresets,
  withOverride,
} from './presets.js';

const EDGES = ['top', 'bottom', 'left', 'right'];
const RATIOS = [
  { id: '1:1', label: '1:1', w: 1, h: 1 },
  { id: '4:3', label: '4:3', w: 4, h: 3 },
  { id: '3:4', label: '3:4', w: 3, h: 4 },
  { id: '16:9', label: '16:9', w: 16, h: 9 },
  { id: '9:16', label: '9:16', w: 9, h: 16 },
];
const MAX_PCT = 300;
const MAX_SIDES = [2048, 3072, 4096, 5120, 6144, 8192];

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_PCT, Math.round(n)));
}

function place(node, x, y, w, h) {
  if (!node) return;
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(y)}px`;
  node.style.width = `${Math.max(0, Math.round(w))}px`;
  node.style.height = `${Math.max(0, Math.round(h))}px`;
}

/**
 * @param {HTMLElement} panelHost 右栏面板容器
 * @param {HTMLElement} layerHost 画布上的幽灵预览层
 * @param {{
 *   getSize: () => {width:number,height:number}|null,
 *   getView: () => {scale:number,x:number,y:number},
 *   onApply: () => void,
 * }} options
 */
export function mountOutpaintPanel(panelHost, layerHost, { getSize, getView, onApply } = {}) {
  let presets = [];
  let active = false;
  let drag = null;

  panelHost.innerHTML = `
    <div class="op-panel">
      <div class="op-head">
        <span class="op-title">外补画布</span>
        <span class="op-target mono" data-op="target">—</span>
      </div>
      <div class="op-grid">
        ${EDGES.map(
          (edge) => `<label class="op-cell op-${edge}">
            <span>${edge === 'top' ? '上' : edge === 'bottom' ? '下' : edge === 'left' ? '左' : '右'}</span>
            <input class="input mono" type="number" min="0" max="${MAX_PCT}" step="1" value="0" data-op="${edge}" />
            <em>%</em>
          </label>`,
        ).join('')}
        <div class="op-preview" data-op="preview"></div>
      </div>
      <div class="op-row">
        <label class="studio-check"><input type="checkbox" data-op="link" checked /><span>对边同步</span></label>
        <button class="btn ghost sm" type="button" data-op="clear">清零</button>
      </div>
      <div class="ai-label">快捷比例</div>
      <div class="op-ratios">
        ${RATIOS.map(
          (ratio) => `<button class="ai-chip" type="button" data-ratio="${ratio.id}">${ratio.label}</button>`,
        ).join('')}
      </div>
      <label class="ai-field">
        <span>最大输出长边</span>
        <select class="select" data-op="maxSide">
          ${MAX_SIDES.map((value) => `<option value="${value}">${value} px</option>`).join('')}
        </select>
      </label>
      <div class="op-warn" data-op="warn" hidden></div>
      <button class="btn primary studio-block" type="button" data-op="apply">生成扩图</button>
      <div class="studio-note">拖动画布四边的手柄也能改；按住 Shift 拖动会临时反转「对边同步」。外补区按 32 对齐，原图区域逐字节保留。</div>
    </div>`;

  const el = (name) => panelHost.querySelector(`[data-op="${name}"]`);
  const op = {
    target: el('target'),
    preview: el('preview'),
    link: el('link'),
    warn: el('warn'),
    maxSide: el('maxSide'),
    inputs: Object.fromEntries(EDGES.map((edge) => [edge, el(edge)])),
  };
  const parts = {
    shadeTop: layerHost.querySelector('[data-shade="top"]'),
    shadeBottom: layerHost.querySelector('[data-shade="bottom"]'),
    shadeLeft: layerHost.querySelector('[data-shade="left"]'),
    shadeRight: layerHost.querySelector('[data-shade="right"]'),
    frame: layerHost.querySelector('[data-so="frame"]'),
    caps: Object.fromEntries(
      EDGES.map((edge) => [edge, layerHost.querySelector(`[data-cap="${edge}"]`)]),
    ),
    handles: [...layerHost.querySelectorAll('[data-edge]')],
  };

  function preset() {
    const id = String(store.state.edit?.preset || 'outpaint');
    return findPreset(presets, id) || findPreset(presets, 'outpaint');
  }

  function overrides() {
    const value = store.state.edit?.overrides;
    return value && typeof value === 'object' ? value : {};
  }

  function edges() {
    const out = {};
    for (const edge of EDGES) out[edge] = clampPct(effectiveValue(preset(), overrides(), `outpaint.${edge}`, 0));
    return out;
  }

  function setEdges(next, { quiet = false } = {}) {
    let merged = overrides();
    for (const edge of EDGES) {
      if (next[edge] == null) continue;
      merged = withOverride(preset(), merged, `outpaint.${edge}`, clampPct(next[edge]));
    }
    patchSettings({ edit: { overrides: merged } });
    if (!quiet) paint();
    syncGhost();
  }

  function outputSize(size, value) {
    if (!size) return null;
    const width = Math.round(size.width * (1 + (value.left + value.right) / 100));
    const height = Math.round(size.height * (1 + (value.top + value.bottom) / 100));
    return { width, height, long: Math.max(width, height) };
  }

  function paint() {
    const value = edges();
    for (const edge of EDGES) {
      if (document.activeElement !== op.inputs[edge]) op.inputs[edge].value = String(value[edge]);
    }
    const maxSide = Number(effectiveValue(preset(), overrides(), 'outpaint.max_side', 5120)) || 5120;
    op.maxSide.value = String(maxSide);

    const size = getSize();
    const out = outputSize(size, value);
    if (!out) {
      op.target.textContent = '未打开图片';
      op.preview.textContent = '';
    } else {
      op.target.textContent = `${out.width} × ${out.height}`;
      op.preview.textContent = `${Math.round(size.width)} × ${Math.round(size.height)} → ${out.width} × ${out.height}`;
    }

    const messages = [];
    if (!EDGES.some((edge) => value[edge] > 0)) messages.push('至少设置一条外扩边');
    if (out && out.long > maxSide) messages.push(`输出长边 ${out.long} 超过上限 ${maxSide}，请下调或提高上限`);
    op.warn.hidden = !messages.length;
    op.warn.textContent = messages.join('；');
    op.warn.classList.toggle('is-block', Boolean(out && out.long > maxSide));
  }

  function syncGhost() {
    if (!active) return;
    const size = getSize();
    if (!size) {
      layerHost.hidden = true;
      return;
    }
    layerHost.hidden = false;
    const view = getView();
    const value = edges();
    const iw = size.width;
    const ih = size.height;
    const scale = view.scale || 1;
    const left = (iw * value.left * scale) / 100;
    const right = (iw * value.right * scale) / 100;
    const top = (ih * value.top * scale) / 100;
    const bottom = (ih * value.bottom * scale) / 100;

    const ox = view.x;
    const oy = view.y;
    const ow = iw * scale;
    const oh = ih * scale;
    const x = ox - left;
    const y = oy - top;
    const w = ow + left + right;
    const h = oh + top + bottom;

    place(parts.shadeTop, x, y, w, top);
    place(parts.shadeBottom, x, oy + oh, w, bottom);
    place(parts.shadeLeft, x, oy, left, oh);
    place(parts.shadeRight, ox + ow, oy, right, oh);
    place(parts.frame, x, y, w, h);

    for (const handle of parts.handles) {
      const edge = handle.dataset.edge;
      if (edge === 'top') place(handle, x + w / 2 - 11, y - 11, 22, 22);
      else if (edge === 'bottom') place(handle, x + w / 2 - 11, y + h - 11, 22, 22);
      else if (edge === 'left') place(handle, x - 11, y + h / 2 - 11, 22, 22);
      else if (edge === 'right') place(handle, x + w - 11, y + h / 2 - 11, 22, 22);
      else if (edge === 'nw') place(handle, x - 6, y - 6, 12, 12);
      else if (edge === 'ne') place(handle, x + w - 6, y - 6, 12, 12);
      else if (edge === 'sw') place(handle, x - 6, y + h - 6, 12, 12);
      else if (edge === 'se') place(handle, x + w - 6, y + h - 6, 12, 12);
    }

    const caps = {
      top: [x + w / 2 - 22, y - 30],
      bottom: [x + w / 2 - 22, y + h + 8],
      left: [x - 54, y + h / 2 - 9],
      right: [x + w + 8, y + h / 2 - 9],
    };
    for (const edge of EDGES) {
      const node = parts.caps[edge];
      if (!node) continue;
      const value2 = value[edge];
      node.hidden = value2 <= 0;
      node.textContent = `+${value2}%`;
      place(node, caps[edge][0], caps[edge][1], 44, 18);
    }
    paintReadout(value, size);
  }

  function paintReadout(value, size) {
    const out = outputSize(size, value);
    if (!out) return;
    op.target.textContent = `${out.width} × ${out.height}`;
    op.preview.textContent = `${Math.round(size.width)} × ${Math.round(size.height)} → ${out.width} × ${out.height}`;
  }

  /* ---------------------------------------------------------- 拖动手柄 */

  function onPointerDown(event) {
    const handle = event.target.closest('[data-edge]');
    if (!handle || !active || event.button !== 0) return;
    const size = getSize();
    if (!size) return;
    event.preventDefault();
    event.stopPropagation();
    drag = {
      edge: handle.dataset.edge,
      startX: event.clientX,
      startY: event.clientY,
      scale: getView().scale || 1,
      iw: size.width,
      ih: size.height,
      base: edges(),
    };
    layerHost.setPointerCapture?.(event.pointerId);
    layerHost.classList.add('is-dragging');
  }

  function onPointerMove(event) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.scale;
    const dy = (event.clientY - drag.startY) / drag.scale;
    const edge = drag.edge;
    const next = { ...drag.base };
    if (edge === 'top' || edge === 'nw' || edge === 'ne') next.top = drag.base.top - (dy / drag.ih) * 100;
    if (edge === 'bottom' || edge === 'sw' || edge === 'se') {
      next.bottom = drag.base.bottom + (dy / drag.ih) * 100;
    }
    if (edge === 'left' || edge === 'nw' || edge === 'sw') next.left = drag.base.left - (dx / drag.iw) * 100;
    if (edge === 'right' || edge === 'ne' || edge === 'se') {
      next.right = drag.base.right + (dx / drag.iw) * 100;
    }
    if (op.link.checked !== event.shiftKey) {
      if (edge === 'left' || edge === 'nw' || edge === 'sw') next.right = next.left;
      else if (edge === 'right' || edge === 'ne' || edge === 'se') next.left = next.right;
      if (edge === 'top' || edge === 'nw' || edge === 'ne') next.bottom = next.top;
      else if (edge === 'bottom' || edge === 'sw' || edge === 'se') next.top = next.bottom;
    }
    setEdges(next);
  }

  function onPointerUp(event) {
    if (!drag) return;
    drag = null;
    layerHost.classList.remove('is-dragging');
    try {
      layerHost.releasePointerCapture?.(event.pointerId);
    } catch (err) {
      /* 指针已释放 */
    }
  }

  /* ---------------------------------------------------------- 面板事件 */

  for (const edge of EDGES) {
    op.inputs[edge].addEventListener('change', () => {
      const next = {};
      next[edge] = clampPct(op.inputs[edge].value);
      if (op.link.checked) {
        next[edge === 'left' ? 'right' : edge === 'right' ? 'left' : edge === 'top' ? 'bottom' : 'top'] =
          next[edge];
      }
      setEdges(next);
    });
  }

  op.link.addEventListener('change', () => {
    if (!op.link.checked) return;
    const value = edges();
    setEdges({ left: value.left, right: value.left, top: value.top, bottom: value.top });
  });

  panelHost.querySelector('[data-op="clear"]').addEventListener('click', () => {
    setEdges({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  panelHost.querySelector('.op-ratios').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ratio]');
    if (!button) return;
    const size = getSize();
    if (!size) {
      toastWarn('请先打开一张图片');
      return;
    }
    const ratio = RATIOS.find((item) => item.id === button.dataset.ratio);
    if (!ratio) return;
    const target = ratio.w / ratio.h;
    const current = size.width / size.height;
    if (Math.abs(target - current) < 0.005) {
      setEdges({ top: 0, bottom: 0, left: 0, right: 0 });
      return;
    }
    if (current < target) {
      const extra = ((size.height * target - size.width) / size.width) * 100;
      const side = clampPct(extra / 2);
      setEdges({ left: side, right: side, top: 0, bottom: 0 });
    } else {
      const extra = ((size.width / target - size.height) / size.height) * 100;
      const side = clampPct(extra / 2);
      setEdges({ top: side, bottom: side, left: 0, right: 0 });
    }
  });

  op.maxSide.addEventListener('change', () => {
    const merged = withOverride(preset(), overrides(), 'outpaint.max_side', Number(op.maxSide.value) || 5120);
    patchSettings({ edit: { overrides: merged } });
    paint();
  });

  panelHost.querySelector('[data-op="apply"]').addEventListener('click', () => {
    const value = edges();
    if (!EDGES.some((edge) => value[edge] > 0)) {
      toastWarn('至少设置一条外扩边');
      return;
    }
    const size = getSize();
    const out = outputSize(size, value);
    const maxSide = Number(effectiveValue(preset(), overrides(), 'outpaint.max_side', 5120)) || 5120;
    if (out && out.long > maxSide) {
      toastWarn(`输出长边 ${out.long} 超过上限 ${maxSide}，请先下调`);
      return;
    }
    onApply?.();
  });

  layerHost.addEventListener('pointerdown', onPointerDown);
  layerHost.addEventListener('pointermove', onPointerMove);
  layerHost.addEventListener('pointerup', onPointerUp);
  layerHost.addEventListener('pointercancel', onPointerUp);
  layerHost.addEventListener('dblclick', (event) => {
    const handle = event.target.closest('[data-edge]');
    if (!handle) return;
    const edge = handle.dataset.edge;
    const zero = {};
    for (const key of [edge, ...(op.link.checked ? [edge === 'left' ? 'right' : edge === 'right' ? 'left' : edge === 'top' ? 'bottom' : 'top'] : [])]) {
      if (EDGES.includes(key)) zero[key] = 0;
    }
    setEdges(zero);
  });

  const unsubscribe = store.subscribe(() => {
    if (drag) return;
    paint();
    syncGhost();
  });

  return {
    async init() {
      try {
        const meta = await loadPresets();
        presets = meta.list;
      } catch (err) {
        presets = [];
      }
      paint();
    },
    /** 进入扩图工具 / 标签：自动套 outpaint 预设并显示幽灵层。 */
    activate() {
      if (store.state.edit?.preset !== 'outpaint') {
        patchSettings({ edit: { preset: 'outpaint' } });
      }
      active = true;
      layerHost.hidden = false;
      paint();
      syncGhost();
    },
    deactivate() {
      active = false;
      layerHost.hidden = true;
    },
    syncGhost,
    refresh() {
      paint();
      syncGhost();
    },
    isActive: () => active,
    /** 弹窗销毁时解除订阅，避免重复打开累积监听 */
    destroy() {
      active = false;
      layerHost.hidden = true;
      unsubscribe();
    },
  };
}
