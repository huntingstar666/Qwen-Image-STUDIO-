/**
 * 顶栏右侧的中文提示（toast）。
 * 所有页面统一用它做成功/失败/警告提示，禁止静默失败。
 */

import { escapeHtml } from '../utils.js';

const MAX_TOASTS = 4;
const root = () => document.getElementById('toast-root');

const ICONS = {
  info: 'ⓘ',
  success: '✓',
  warn: '!',
  error: '×',
};

/**
 * @param {string} message 中文消息
 * @param {'info'|'success'|'warn'|'error'} [type]
 * @param {{timeout?: number}} [options]
 */
export function toast(message, type = 'info', { timeout = 4500 } = {}) {
  const host = root();
  if (!host) {
    console.warn('[toast]', message);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[type] || ICONS.info}</span><span>${escapeHtml(message)}</span>`;
  host.append(el);

  while (host.children.length > MAX_TOASTS) host.firstElementChild?.remove();

  const remove = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  };
  const timer = setTimeout(remove, timeout);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return el;
}

export function toastError(err, fallback = '操作失败') {
  const message = err?.message || (typeof err === 'string' ? err : fallback);
  toast(message, 'error', { timeout: 7000 });
}

export function toastSuccess(message) {
  toast(message, 'success');
}

export function toastWarn(message) {
  toast(message, 'warn', { timeout: 5500 });
}
