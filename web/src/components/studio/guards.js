/**
 * 「本次保护」两开关（图片精修 / 图生图共用）。
 *
 * 色彩校准与零像素偏移都不属于预设：预设不改变用户的显式选择，
 * 刷新 / 切预设都保持当前状态（默认都开，可关，关闭后结果卡片要如实回显）。
 */

import { normalizeProtection } from './presets.js';

const ITEMS = [
  {
    key: 'color',
    label: '色彩校准',
    tag: '只作用于写入区',
    hint: '用画面里几乎没变的像素估算色偏并拉回；遮罩外逐像素不动。关闭后输出可能与原图有色差。',
  },
  {
    key: 'zeroShift',
    label: '零像素偏移',
    tag: '32 对齐 · resolution 0',
    hint: '32 对齐 + resolution=0 + latent==画布 + 整数裁回，保证输出与源图逐像素对齐。关闭后可能出现 1~31px 位移或亚像素模糊；扩图任务会自动关闭。',
  },
];

export function mountGuards(host, { value, onChange } = {}) {
  let state = normalizeProtection(value);

  host.innerHTML = ITEMS.map(
    (item) => `
      <label class="ai-check ai-guard" title="${item.hint}">
        <input type="checkbox" data-guard="${item.key}" ${state[item.key] ? 'checked' : ''} />
        <span>${item.label}</span>
        <span class="ai-tag ok" data-guard-tag="${item.key}">${item.tag}</span>
      </label>`,
  ).join('');

  function paint() {
    for (const item of ITEMS) {
      const box = host.querySelector(`[data-guard="${item.key}"]`);
      const tag = host.querySelector(`[data-guard-tag="${item.key}"]`);
      if (box) box.checked = state[item.key];
      if (tag) {
        tag.classList.toggle('ok', state[item.key]);
        tag.classList.toggle('warn', !state[item.key]);
        tag.textContent = state[item.key] ? item.tag : '已关闭';
      }
    }
  }

  host.addEventListener('change', (event) => {
    const box = event.target.closest('[data-guard]');
    if (!box) return;
    state = { ...state, [box.dataset.guard]: box.checked };
    paint();
    onChange?.(state, box.dataset.guard);
  });

  paint();

  return {
    sync(next) {
      state = normalizeProtection(next);
      paint();
    },
    value: () => ({ ...state }),
  };
}
