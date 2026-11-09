/**
 * 通用模态框：提示词润色对比、历史详情、确认对话框、风格选择器都复用它。
 * 纯 DOM 实现，支持 Esc 关闭、点击遮罩关闭、焦点回收；
 * 支持 dialogClass（给风格/MJ 选择器加自定义尺寸与配色）与 hideFooter（完全自定义底栏）。
 */

import { ce } from '../utils.js';
import { toastError } from './toast.js';

let activeModal = null;

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {string|Node} options.content
 * @param {Array<{label:string, kind?:string, onClick?:Function, close?:boolean, spacer?:boolean}>} [options.actions]
 * @param {'sm'|'md'|'lg'} [options.size]
 * @param {string} [options.dialogClass] 追加到 .modal 的类名（自定义尺寸/主题）
 * @param {boolean} [options.hideFooter] 不渲染默认底栏（由内容区自己画按钮）
 * @param {Function} [options.onClose]
 * @param {Function} [options.exit] 可选退场钩子：返回 Promise 时，等它结束后再移除弹窗
 * @returns {{close:Function, root:HTMLElement, body:HTMLElement}}
 */
export function openModal({
  title,
  subtitle = '',
  content,
  actions = [],
  size = 'md',
  dialogClass = '',
  hideFooter = false,
  onClose,
  exit,
}) {
  closeModal();
  const host = document.getElementById('modal-root') || document.body;

  const body = ce('div', { class: 'modal-body' });
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.append(content);

  const foot = ce('div', { class: 'modal-foot' });
  const closeBtn = ce('button', { class: 'modal-close', type: 'button', title: '关闭', 'aria-label': '关闭' }, ['×']);

  const sizeClass = size === 'lg' ? 'size-lg' : size === 'sm' ? 'size-sm' : '';
  const modal = ce('div', { class: `modal ${sizeClass} ${dialogClass}`.trim() }, [
    ce('div', { class: 'modal-head' }, [
      ce('div', {}, [
        ce('div', { class: 'modal-title', text: title }),
        subtitle ? ce('div', { class: 'modal-sub', text: subtitle }) : null,
      ]),
      closeBtn,
    ]),
    body,
    hideFooter ? null : foot,
  ]);

  const backdrop = ce('div', { class: 'modal-backdrop' }, [modal]);

  let closing = false;
  const teardown = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (activeModal === api) activeModal = null;
    onClose?.();
  };

  const close = () => {
    if (!backdrop.isConnected || closing) return Promise.resolve();
    // 默认行为保持不变：没有 exit 钩子时立即移除。
    if (typeof exit !== 'function') {
      teardown();
      return Promise.resolve();
    }
    closing = true;
    let pending = null;
    try {
      pending = exit({ backdrop, modal, body });
    } catch {
      pending = null;
    }
    return Promise.resolve(pending)
      .catch(() => {})
      .then(() => {
        closing = false;
        teardown();
      });
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  for (const action of actions) {
    if (!action) continue;
    if (action.spacer) {
      foot.append(ce('div', { class: 'spacer' }));
      continue;
    }
    const btn = ce(
      'button',
      {
        class: `btn ${action.kind || 'ghost'}`,
        type: 'button',
      },
      [action.label],
    );
    btn.addEventListener('click', async () => {
      try {
        if (action.onClick) {
          const result = await action.onClick({ close, body, modal });
          if (result === false) return;
        }
        if (action.close !== false) close();
      } catch (err) {
        console.error('[modal] 操作失败', err);
        toastError(err, '操作失败');
      }
    });
    foot.append(btn);
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  host.append(backdrop);
  activeModal = { close };

  const api = { close, root: backdrop, body };
  return api;
}

export function closeModal() {
  if (activeModal) {
    activeModal.close();
    activeModal = null;
  }
  const host = document.getElementById('modal-root');
  if (host) host.innerHTML = '';
}

/** 简易确认框，返回 Promise<boolean>。 */
export function confirmDialog({ title = '确认操作', message, confirmText = '确认', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      size: 'sm',
      content: `<div class="notice ${danger ? 'bad' : 'info'}">${message}</div>`,
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => settle(false) },
        {
          label: confirmText,
          kind: danger ? 'danger' : 'primary',
          onClick: () => settle(true),
        },
      ],
      onClose: () => settle(false),
    });
    // 点击按钮后 modal 会关闭，onClose 已经兜底
    void modal;
  });
}
