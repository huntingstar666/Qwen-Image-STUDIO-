/**
 * 指令框富文本内核（D3.1）。
 *
 * 只负责编辑与序列化：参考图以 contenteditable=false 的 chip 原子节点存在，
 * 提交时序列化回 `@图二` 纯文本，与既有 mapMentions() 契约保持一致。
 * 菜单 UI、参考图编号来源由调用方（aiPanel.js）在 D3.2 接入。
 *
 * 用法：
 *   const editor = createPromptEditor(host, { placeholder, onChange, onEnterSubmit, onMentionQuery });
 *   editor.syncRefs([{ id: 'main' }, { id: 'ref-1' }]);
 *   editor.insertMention({ refId: 'ref-1' });
 *   editor.getText(); // '把 @图二 的梨子替换 @图一 的苹果'
 */

const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const MENTION_PATTERN = /@图[一二三四五六七八九]/g;

/** 参考图序号（0 = 主图）→ 展示标签。 */
export function mentionLabel(index) {
  return `图${NUMERALS[index] || index + 1}`;
}

function isChip(node) {
  return Boolean(node && node.nodeType === Node.ELEMENT_NODE && node.classList.contains('pe-mention'));
}

/**
 * @param {HTMLElement} host 挂载容器（会清空）
 * @param {object} [options]
 * @param {string} [options.placeholder] 空内容占位文案
 * @param {(text: string) => void} [options.onChange] 序列化文本变化
 * @param {() => void} [options.onEnterSubmit] Ctrl/Cmd+Enter
 * @param {(query: string|null) => void} [options.onMentionQuery] 输入 @ 后触发；离开 @ 语境传 null
 * @param {(count: number) => void} [options.onMissingRef] syncRefs 移除了失效 chip 时触发
 */
export function createPromptEditor(
  host,
  { placeholder = '', onChange, onEnterSubmit, onMentionQuery, onMissingRef } = {},
) {
  host.innerHTML = '';
  const editor = document.createElement('div');
  editor.className = 'pe-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', '修改指令');
  if (placeholder) editor.dataset.placeholder = placeholder;
  host.appendChild(editor);

  /** 参考图顺序：主图固定第 0 位。 */
  let refs = [];
  let menu = { items: [], onPick: null };
  /** 正在输入的 @ 片段位置（菜单打开期间有效）。 */
  let pending = null;
  let composing = false;

  const refIndex = (refId) => refs.findIndex((ref) => ref.id === refId);

  function createChip(refId, index) {
    const chip = document.createElement('span');
    chip.className = 'pe-mention';
    chip.contentEditable = 'false';
    chip.dataset.refId = refId;
    chip.textContent = `@${mentionLabel(index)}`;
    return chip;
  }

  function serializeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (isChip(node)) {
      const index = refIndex(node.dataset.refId);
      return index >= 0 ? `@${mentionLabel(index)}` : node.textContent || '';
    }
    if (node.tagName === 'BR') return '\n';
    const inner = [...node.childNodes].map(serializeNode).join('');
    return node.tagName === 'DIV' || node.tagName === 'P' ? `\n${inner}` : inner;
  }

  function getText() {
    const text = [...editor.childNodes].map(serializeNode).join('');
    return text.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function emitChange() {
    onChange?.(getText());
  }

  function currentRange() {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) return range.cloneRange();
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  }

  function placeCaret(range) {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus();
  }

  /** 删除已输入的 @ 片段，返回删除后的光标位置。 */
  function consumePending() {
    if (!pending || !pending.node.isConnected || !editor.contains(pending.node)) {
      pending = null;
      return currentRange();
    }
    const range = document.createRange();
    range.setStart(pending.node, pending.start);
    range.setEnd(pending.node, pending.end);
    range.deleteContents();
    range.collapse(true);
    pending = null;
    return range;
  }

  function closeQuery() {
    if (!pending) return;
    pending = null;
    onMentionQuery?.(null);
  }

  /* ------------------------------------------------------------ 输入事件 */

  function detectMentionQuery() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      closeQuery();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (!editor.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      closeQuery();
      return;
    }
    const before = node.nodeValue.slice(0, range.startOffset);
    const match = /(^|[\s\n])@([^\s@]*)$/.exec(before);
    if (!match) {
      closeQuery();
      return;
    }
    pending = {
      node,
      start: range.startOffset - match[0].length + match[1].length,
      end: range.startOffset,
    };
    onMentionQuery?.(match[2]);
  }

  function onInput(event) {
    if (composing || event.isComposing) return;
    emitChange();
    detectMentionQuery();
  }

  function onCompositionStart() {
    composing = true;
    closeQuery();
  }

  function onCompositionEnd() {
    composing = false;
    emitChange();
    detectMentionQuery();
  }

  /** 光标前一个节点（Backspace 用）或后一个节点（Delete 用）。 */
  function adjacentNode(range, key) {
    const { startContainer: container, startOffset: offset } = range;
    if (key === 'Backspace') {
      if (container.nodeType === Node.TEXT_NODE) {
        if (offset > 0) return null;
        let node = container;
        while (node && node !== editor) {
          if (node.previousSibling) return node.previousSibling;
          node = node.parentNode;
        }
        return null;
      }
      if (offset > 0) return container.childNodes[offset - 1];
    } else {
      if (container.nodeType === Node.TEXT_NODE) {
        if (offset < (container.nodeValue || '').length) return null;
        let node = container;
        while (node && node !== editor) {
          if (node.nextSibling) return node.nextSibling;
          node = node.parentNode;
        }
        return null;
      }
      if (offset < container.childNodes.length) return container.childNodes[offset];
    }
    let node = container;
    while (node && node !== editor) {
      if (key === 'Backspace' ? node.previousSibling : node.nextSibling) {
        return key === 'Backspace' ? node.previousSibling : node.nextSibling;
      }
      node = node.parentNode;
    }
    return null;
  }

  function removeChip(chip) {
    const parent = chip.parentNode;
    const next = chip.nextSibling;
    chip.remove();
    if (!parent) return;
    const range = document.createRange();
    if (next) range.setStartBefore(next);
    else range.setStart(parent, parent.childNodes.length);
    range.collapse(true);
    placeCaret(range);
    emitChange();
  }

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      onEnterSubmit?.();
      return;
    }
    if (composing || event.isComposing) return;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return;
    const node = adjacentNode(range, event.key);
    if (!isChip(node)) return;
    event.preventDefault();
    removeChip(node);
  }

  /* ------------------------------------------------------------ 粘贴与拖放 */

  function insertPlainText(text) {
    const value = String(text || '');
    if (!value) return;
    const range = currentRange();
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    const after = document.createRange();
    after.setStart(node, value.length);
    after.collapse(true);
    placeCaret(after);
    emitChange();
    detectMentionQuery();
  }

  function onPaste(event) {
    const text = event.clipboardData?.getData('text/plain');
    if (text == null) return;
    event.preventDefault();
    insertPlainText(text);
  }

  function onDrop(event) {
    // 图片拖入由调用方接管；这里只阻止浏览器把文件/HTML 直接塞进富文本。
    event.preventDefault();
  }

  editor.addEventListener('input', onInput);
  editor.addEventListener('compositionstart', onCompositionStart);
  editor.addEventListener('compositionend', onCompositionEnd);
  editor.addEventListener('keydown', onKeyDown);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('dragover', (event) => event.preventDefault());
  editor.addEventListener('drop', onDrop);

  /* ------------------------------------------------------------ 对外 API */

  function setText(text = '') {
    editor.textContent = '';
    const lines = String(text).split('\n');
    lines.forEach((line, lineIndex) => {
      if (lineIndex) editor.appendChild(document.createElement('br'));
      if (!line) return;
      let last = 0;
      for (const match of line.matchAll(MENTION_PATTERN)) {
        const start = match.index;
        if (start > last) editor.appendChild(document.createTextNode(line.slice(last, start)));
        const resolved = refs.findIndex((_ref, i) => match[0] === `@${mentionLabel(i)}`);
        if (resolved >= 0) editor.appendChild(createChip(refs[resolved].id, resolved));
        else editor.appendChild(document.createTextNode(match[0]));
        last = start + match[0].length;
      }
      if (last < line.length) editor.appendChild(document.createTextNode(line.slice(last)));
    });
    pending = null;
    emitChange();
  }

  function syncRefs(nextRefs = []) {
    refs = nextRefs
      .map((ref) => (typeof ref === 'string' ? { id: ref } : { id: String(ref?.id ?? '') }))
      .filter((ref) => ref.id);
    let removed = 0;
    for (const chip of [...editor.querySelectorAll('.pe-mention')]) {
      const index = refIndex(chip.dataset.refId);
      if (index < 0) {
        chip.remove();
        removed += 1;
      } else {
        chip.textContent = `@${mentionLabel(index)}`;
      }
    }
    if (removed) {
      onMissingRef?.(removed);
      emitChange();
    }
    return removed;
  }

  function insertMention({ refId, label } = {}) {
    const index = refIndex(refId);
    const picked = menu.items.find((item) => item.refId === refId);
    if (!refId || (index < 0 && !label && !picked?.label)) return null;
    const text = String(label || picked?.label || mentionLabel(index)).replace(/^@/, '');
    const range = consumePending();
    range.deleteContents();
    const chip = createChip(refId, index >= 0 ? index : 0);
    chip.textContent = `@${text}`;
    range.insertNode(chip);
    const space = document.createTextNode(' ');
    chip.after(space);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    placeCaret(after);
    emitChange();
    return chip;
  }

  function setMentionMenu(items = [], onPick) {
    menu = { items: [...items], onPick: onPick || null };
  }

  function focus() {
    const selection = window.getSelection();
    const inside = Boolean(
      selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer),
    );
    editor.focus();
    if (inside) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    placeCaret(range);
  }

  function clear() {
    editor.textContent = '';
    pending = null;
    onMentionQuery?.(null);
    emitChange();
  }

  return {
    el: editor,
    getText,
    setText,
    syncRefs,
    insertMention,
    setMentionMenu,
    focus,
    clear,
  };
}
