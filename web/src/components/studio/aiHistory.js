/**
 * AI 编辑历史卡片轨道（D16.1，方案 §15.2）。
 *
 * 只负责渲染与交互，数据读写全部走 sessionHistory：
 *   render()       重新绘制卡片（宿主在新增/删除/回退后调用）
 *   setBusy(bool)  任务运行中禁用「载入」
 *
 * 交互：点击/Enter 载入，C 对比，Delete 删除；删除只删记录，不动当前画面。
 */

import { escapeHtml } from '../../utils.js';

const CLOCK = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function timeText(at) {
  try {
    return CLOCK.format(new Date(at || Date.now()));
  } catch {
    return '';
  }
}

function promptText(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return '未填写指令';
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

export function mountAiHistory(host, { getEntries, isBusy, onLoad, onCompare, onRemove, onClear } = {}) {
  host.innerHTML = `
    <div class="ai-label ai-history-head">
      <span>编辑历史</span>
      <span class="ai-label-note" data-ref="count"></span>
      <button class="ai-link" type="button" data-ref="clear" hidden>清空</button>
    </div>
    <div class="ai-history-track" data-ref="track"></div>
    <div class="ai-hint" data-ref="empty">还没有 AI 编辑记录，完成一次修改后会出现在这里。</div>`;

  const refs = {
    count: host.querySelector('[data-ref="count"]'),
    clear: host.querySelector('[data-ref="clear"]'),
    track: host.querySelector('[data-ref="track"]'),
    empty: host.querySelector('[data-ref="empty"]'),
  };

  let currentId = '';
  let busy = false;

  function cardOf(entry) {
    const current = entry.id === currentId;
    return `<div class="ai-history-card${current ? ' is-current' : ''}" data-history-id="${escapeHtml(entry.id)}"
      role="button" tabindex="0" aria-label="历史 #${entry.index} ${escapeHtml(timeText(entry.at))} ${escapeHtml(promptText(entry.prompt))}">
      ${entry.thumbUrl ? `<img src="${entry.thumbUrl}" alt="" loading="lazy" />` : '<div class="ai-history-ph">无预览</div>'}
      <span class="ai-history-badge">#${entry.index}</span>
      <div class="ai-history-meta">
        <span class="ai-history-time mono">${escapeHtml(timeText(entry.at))}</span>
        <span class="ai-history-prompt" title="${escapeHtml(entry.prompt || '')}">${escapeHtml(promptText(entry.prompt))}</span>
      </div>
      <div class="ai-history-actions">
        <button type="button" data-act="load"${busy ? ' disabled' : ''}>载入</button>
        <button type="button" data-act="compare">对比</button>
        <button type="button" data-act="remove">删除</button>
      </div>
    </div>`;
  }

  function render() {
    const entries = getEntries?.() || [];
    refs.count.textContent = entries.length ? `${entries.length} 次` : '';
    refs.clear.hidden = !entries.length;
    refs.empty.hidden = entries.length > 0;
    refs.track.innerHTML = entries.map(cardOf).join('');
  }

  function entryFrom(node) {
    const card = node?.closest?.('[data-history-id]');
    if (!card) return null;
    const entries = getEntries?.() || [];
    return entries.find((entry) => entry.id === card.dataset.historyId) || null;
  }

  refs.track.addEventListener('click', (event) => {
    const entry = entryFrom(event.target);
    if (!entry) return;
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (action === 'load') onLoad?.(entry);
    else if (action === 'compare') onCompare?.(entry);
    else if (action === 'remove') onRemove?.(entry);
    else onLoad?.(entry);
  });

  refs.track.addEventListener('keydown', (event) => {
    const entry = entryFrom(event.target);
    if (!entry) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onLoad?.(entry);
    } else if (event.key === 'c' || event.key === 'C') {
      event.preventDefault();
      onCompare?.(entry);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onRemove?.(entry);
    }
  });

  refs.clear.addEventListener('click', () => {
    if (!getEntries?.().length) return;
    onClear?.();
  });

  return {
    render,
    setBusy(next) {
      busy = Boolean(next);
      for (const button of refs.track.querySelectorAll('[data-act="load"]')) {
        button.disabled = busy;
      }
    },
    setCurrent(entryId) {
      currentId = entryId || '';
      for (const card of refs.track.querySelectorAll('[data-history-id]')) {
        card.classList.toggle('is-current', card.dataset.historyId === currentId);
      }
    },
    isBusy() {
      return busy;
    },
  };
}
