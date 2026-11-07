/**
 * 全景任务面板：比例 / 长边上限 / 360° 环绕接缝。
 *
 * 数值一律写进 `edit.overrides`（`panorama.*`），由 `edit.js` 统一合并提交；
 * 这里不做生成、不改画布，只负责把参数显式化并预估输出尺寸。
 */

import { patchSettings, store } from '../../store.js';
import {
  effectiveValue,
  findPreset,
  loadPresets,
  withOverride,
} from './presets.js';

const ASPECTS = [
  { id: '2:1', label: '2:1 宽幅', w: 2, h: 1 },
  { id: '3:1', label: '3:1 超宽', w: 3, h: 1 },
  { id: '4:1', label: '4:1 极宽', w: 4, h: 1 },
  { id: '21:9', label: '21:9 电影', w: 21, h: 9 },
];

const LONG_SIDES = [2048, 3072, 4096];
const MAX_PIXELS = 6_000_000;

function snapUp(value) {
  return Math.max(32, Math.ceil(value / 32) * 32);
}

/** 与后端 `imaging.panorama_plan` 保持同一套最小外扩 / 只缩不放规则。 */
function estimate(size, aspect, longSide) {
  if (!size || !size.width || !size.height) return null;
  const ratio = aspect.w / aspect.h;
  const current = size.width / size.height;
  let width;
  let height;
  if (current < ratio) {
    height = size.height;
    width = Math.ceil(height * ratio);
  } else {
    width = size.width;
    height = Math.ceil(width / ratio);
  }
  width = snapUp(width);
  height = snapUp(height);

  let scale = 1;
  const long = Math.max(width, height);
  if (long > longSide) scale = longSide / long;
  if (width * height * scale * scale > MAX_PIXELS) {
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (width * height)));
  }
  if (scale < 1) {
    width = Math.max(32, Math.floor((width * scale) / 32) * 32);
    height = Math.max(32, Math.floor((height * scale) / 32) * 32);
  }
  return { width, height, pixels: width * height, scale };
}

export function mountPanoramaPanel(host, { getSize } = {}) {
  let presets = [];
  host.innerHTML = `
    <div class="op-panel pano-panel">
      <div class="op-head">
        <span class="op-title">全景</span>
        <span class="op-target mono" data-pano="target">—</span>
      </div>
      <div class="op-ratios" data-pano="aspects"></div>
      <label class="ai-field">
        <span>长边上限</span>
        <select class="select" data-pano="longSide">
          ${LONG_SIDES.map((v) => `<option value="${v}">${v} px</option>`).join('')}
        </select>
      </label>
      <label class="studio-check">
        <input type="checkbox" data-pano="wrap" />
        <span>360° 环绕接缝（实验）</span>
      </label>
      <div class="ai-hint" data-pano="note"></div>
      <div class="op-warn" data-pano="warn" hidden></div>
    </div>`;

  const refs = {
    aspects: host.querySelector('[data-pano="aspects"]'),
    longSide: host.querySelector('[data-pano="longSide"]'),
    wrap: host.querySelector('[data-pano="wrap"]'),
    target: host.querySelector('[data-pano="target"]'),
    note: host.querySelector('[data-pano="note"]'),
    warn: host.querySelector('[data-pano="warn"]'),
  };

  function currentPreset() {
    const id = String(store.state.edit?.preset || 'panorama');
    return findPreset(presets, id) || findPreset(presets, 'panorama');
  }

  function overrides() {
    return store.state.edit?.overrides || {};
  }

  function value(key, fallback) {
    return effectiveValue(currentPreset(), overrides(), `panorama.${key}`, fallback);
  }

  function setValue(key, next) {
    patchSettings({
      edit: {
        overrides: withOverride(
          currentPreset(), overrides(), `panorama.${key}`, next),
      },
    });
    paint();
  }

  function paint() {
    const aspectId = String(value('aspect', '2:1'));
    const aspect = ASPECTS.find((item) => item.id === aspectId) || ASPECTS[0];
    const longSide = Number(value('long_side', 3072)) || 3072;
    refs.aspects.innerHTML = ASPECTS.map((item) => `
      <button type="button" class="ai-chip${item.id === aspect.id ? ' is-active' : ''}"
              data-aspect="${item.id}">${item.label}</button>`).join('');
    refs.aspects.querySelectorAll('[data-aspect]').forEach((button) => {
      button.addEventListener('click', () => setValue('aspect', button.dataset.aspect));
    });
    refs.longSide.value = String(longSide);
    refs.wrap.checked = Boolean(value('wrap', false));

    const planned = estimate(getSize?.(), aspect, longSide);
    if (!planned) {
      refs.target.textContent = '等待图片';
      refs.note.textContent = '上传一张参考图后显示目标画布。';
      refs.warn.hidden = true;
      return;
    }
    refs.target.textContent = `${planned.width} × ${planned.height}`;
    refs.note.textContent = planned.scale < 1
      ? `源图会等比缩到画布内（缩放 ${(planned.scale * 100).toFixed(0)}%）`
      : '源图保持原尺寸，仅向外补画布。';
    const over = planned.pixels > MAX_PIXELS;
    refs.warn.hidden = !over;
    refs.warn.textContent = over
      ? `画布约 ${(planned.pixels / 1e6).toFixed(1)} MP，超过后端上限 6.0 MP，请降低长边。`
      : '';
  }

  refs.longSide.addEventListener('change', () => {
    setValue('long_side', Number(refs.longSide.value) || 3072);
  });
  refs.wrap.addEventListener('change', () => {
    setValue('wrap', refs.wrap.checked);
  });

  let unsubscribe = null;

  return {
    async init() {
      try {
        const meta = await loadPresets();
        presets = meta.list || [];
      } catch {
        presets = [];
      }
      paint();
      unsubscribe = store.subscribe(() => paint());
    },
    refresh() {
      paint();
    },
    destroy() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
  };
}
