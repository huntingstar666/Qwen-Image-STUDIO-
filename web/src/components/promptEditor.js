/**
 * 富文本编辑指令框：普通文字 + 参考图 chip。
 * 职责：
 * 1. 用 contenteditable 替代 textarea，让 @ 引用的参考图以内联缩略图显示；
 * 2. 序列化时把 chip 还原成「@参考图N」（给用户看）或「<imageN>」（给 LLM / 润色用）；
 * 3. 支持 Backspace / Delete 删除整颗 chip，以及按当前参考图顺序刷新编号。
 *
 * chip 结构：<span class="ref-chip" contenteditable="false" data-ref-key="小图库 id">…</span>
 * 映射规则与后端一致：第 1 张图 = <image1>（编辑目标），第 2 张 = <image2>，依此类推。
 */

import { escapeHtml } from '../utils.js';

function isChip(node) {
  return node?.nodeType === 1 && node.classList?.contains('ref-chip');
}

export class PromptEditor {
  constructor(el, { placeholder = '', onChange } = {}) {
    this.el = el;
    this.onChange = onChange;
    el.classList.add('wb-prompt-rich');
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    if (placeholder) el.dataset.placeholder = placeholder;

    el.addEventListener('input', () => {
      this.prune();
      this.emit();
    });
    el.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      this.insertText(text);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (this.removeChipAtCaret(event.key)) event.preventDefault();
      }
    });
    el.addEventListener('click', (event) => {
      const del = event.target.closest('.ref-chip-del');
      if (!del) return;
      event.preventDefault();
      del.closest('.ref-chip')?.remove();
      this.cleanIfBlank();
      this.emit();
    });
    // 拖动 chip 不产生文字选择，交给页面处理拖放
    el.addEventListener('dragstart', (event) => {
      if (event.target.closest('.ref-chip')) event.preventDefault();
    });
  }

  /* ------------------------------------------------------------ 选区 */

  currentRange() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.startContainer)) return null;
    return range;
  }

  endRange() {
    const range = document.createRange();
    range.selectNodeContents(this.el);
    range.collapse(false);
    return range;
  }

  /** 占位符在 :empty 下才显示，清掉浏览器残留的空 <br>。 */
  prune() {
    const html = this.el.innerHTML;
    if (html === '<br>' || html === '<div><br></div>' || html === '<p><br></p>') {
      this.el.innerHTML = '';
    }
  }

  /** 只剩空白文本时清空，避免占位符被空格卡住不显示。 */
  cleanIfBlank() {
    if (this.el.querySelector('.ref-chip')) return;
    if (!(this.el.textContent || '').trim()) this.el.innerHTML = '';
  }

  emit() {
    this.onChange?.(this.getText());
  }

  focus() {
    this.el.focus({ preventScroll: true });
    if (!this.currentRange()) {
      const sel = window.getSelection();
      if (!sel) return;
      const range = this.endRange();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /* ------------------------------------------------------------ 序列化 */

  serialize(node, semantic) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeName === 'BR') return '\n';
    if (node.nodeType !== 1) return '';
    if (isChip(node)) {
      const label = node.querySelector('.ref-chip-name')?.textContent || '参考图';
      const index = Number(node.dataset.imageIndex);
      if (semantic) return Number.isInteger(index) && index >= 0 ? `<image${index + 1}>` : label;
      return `@${label}`;
    }
    const inner = [...node.childNodes].map((child) => this.serialize(child, semantic)).join('');
    const block = /^(DIV|P|LI)$/.test(node.nodeName);
    return block && inner && !inner.endsWith('\n') ? `${inner}\n` : inner;
  }

  /** 界面文本：chip → @参考图N */
  getText() {
    return [...this.el.childNodes]
      .map((node) => this.serialize(node, false))
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '');
  }

  /** 给 LLM 的语义文本：chip → <imageN>（与 images 数组顺序一致） */
  getSemantic() {
    return [...this.el.childNodes]
      .map((node) => this.serialize(node, true))
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '');
  }

  isEmpty() {
    return !this.getText().trim();
  }

  setText(text) {
    const value = String(text ?? '');
    this.el.textContent = value;
    if (!value) this.el.innerHTML = '';
  }

  /** 富文本快照（含 @ 引用 chip），用于刷新后恢复现场。 */
  getHTML() {
    return this.el.innerHTML;
  }

  /**
   * 恢复富文本快照：只认文字、换行与 ref-chip，其余标签一律丢弃，
   * chip 用 chipNode 重建（顺带过滤掉保存期间被塞进来的脚本 / 事件属性）。
   */
  setHTML(html) {
    const value = String(html || '');
    if (!value) {
      this.setText('');
      return;
    }
    const box = document.createElement('div');
    box.innerHTML = value;
    const frag = document.createDocumentFragment();
    const walk = (node, target) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          target.appendChild(document.createTextNode(child.textContent || ''));
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (isChip(child)) {
          target.appendChild(
            this.chipNode({
              key: child.dataset.refKey,
              src: child.querySelector('.ref-chip-img')?.getAttribute('src') || '',
              label: child.querySelector('.ref-chip-name')?.textContent || '参考图',
              index: Number(child.dataset.imageIndex) || 0,
            }),
          );
          continue;
        }
        if (/^(DIV|P)$/.test(child.nodeName)) {
          const block = document.createElement(child.nodeName);
          walk(child, block);
          target.appendChild(block);
          continue;
        }
        if (child.nodeName === 'BR') {
          target.appendChild(document.createElement('br'));
          continue;
        }
        // 其他标签（加粗、span 等）拆掉标签保留文字，避免恢复出无法序列化的结构。
        walk(child, target);
      }
    };
    walk(box, frag);
    this.el.innerHTML = '';
    this.el.appendChild(frag);
    this.prune();
    this.emit();
  }

  /** 指令框里是否已经有这张图（按小图库 key）的 @ 引用。 */
  hasChip(key) {
    const target = String(key || '');
    if (!target) return false;
    return [...this.el.querySelectorAll('.ref-chip')].some((chip) => chip.dataset.refKey === target);
  }

  /* ------------------------------------------------------------ 插入 */

  insertText(text) {
    const value = String(text ?? '');
    if (!value) return;
    const range = this.currentRange() || this.endRange();
    range.deleteContents();
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.prune();
    this.emit();
  }

  chipNode({ key, src, label, index, width, height }) {
    const chip = document.createElement('span');
    chip.className = 'ref-chip';
    chip.contentEditable = 'false';
    chip.dataset.refKey = String(key || '');
    chip.dataset.imageIndex = String(Number(index) || 0);
    chip.title = `@${label}${width && height ? ` · ${width}×${height}` : ''}`;
    chip.innerHTML = `
      <span class="ref-chip-at">@</span>
      <img class="ref-chip-img" src="${escapeHtml(src)}" alt="" draggable="false" />
      <span class="ref-chip-name">${escapeHtml(label)}</span>
      <button class="ref-chip-del" type="button" tabindex="-1" aria-label="移除引用">×</button>`;
    return chip;
  }

  /**
   * 在光标处插入参考图 chip（不传 range 时用当前选区）。
   * 返回 chip 元素；没有可用选区时退化为追加到末尾。
   */
  insertChip(item, range = null) {
    const chip = this.chipNode(item);
    const target = range || this.currentRange() || this.endRange();
    target.deleteContents();
    target.insertNode(chip);
    const space = document.createTextNode(' ');
    chip.after(space);
    const next = document.createRange();
    next.setStartAfter(space);
    next.collapse(true);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(next);
    }
    this.el.focus({ preventScroll: true });
    this.emit();
    return chip;
  }

  /* ------------------------------------------------------------ 同步 */

  /**
   * 按参考图区域刷新 chip 的编号 / 缩略图；解析不到的 chip 直接移除。
   * @param {(key: string) => ({index:number,label:string,src:string,width:number,height:number}|null)} resolve
   */
  syncChips(resolve) {
    if (typeof resolve !== 'function') return;
    for (const chip of [...this.el.querySelectorAll('.ref-chip')]) {
      const info = resolve(chip.dataset.refKey);
      if (!info) {
        chip.remove();
        continue;
      }
      chip.dataset.imageIndex = String(info.index);
      chip.title = `@${info.label}${info.width && info.height ? ` · ${info.width}×${info.height}` : ''}`;
      const name = chip.querySelector('.ref-chip-name');
      if (name) name.textContent = info.label;
      const img = chip.querySelector('.ref-chip-img');
      if (img && info.src && img.getAttribute('src') !== info.src) img.setAttribute('src', info.src);
    }
    this.prune();
    this.cleanIfBlank();
    this.emit();
  }

  /* ------------------------------------------------------------ 删除 */

  removeChipAtCaret(key) {
    const range = this.currentRange();
    if (!range || !range.collapsed) return false;
    const node = range.startContainer;
    if (node.nodeType !== 3) return false;
    const offset = range.startOffset;
    if (key === 'Backspace' && offset === 0) {
      let prev = node.previousSibling;
      while (prev && prev.nodeType === 3 && !prev.textContent) prev = prev.previousSibling;
      if (isChip(prev)) {
        prev.remove();
        this.cleanIfBlank();
        this.emit();
        return true;
      }
    }
    if (key === 'Delete' && offset === (node.textContent || '').length) {
      let next = node.nextSibling;
      while (next && next.nodeType === 3 && !next.textContent) next = next.nextSibling;
      if (isChip(next)) {
        next.remove();
        this.cleanIfBlank();
        this.emit();
        return true;
      }
    }
    return false;
  }
}
