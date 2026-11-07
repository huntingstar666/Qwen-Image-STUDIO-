// 胶片条：缩略图、停顿/隐藏标记、拖拽排序、快速选择。
// 与后端一致：hold 表示曝光次数，duration 为 0 时回退 1000/fps。

import { h, formatMs } from './utils.js';
import {
  frameDuration, projectSummary, reorder, setSelection, state, subscribe,
} from './store.js';

let listEl = null;
let metaEl = null;
let queued = false;
let dragIndex = -1;
let dropIndex = -1;
let dropAfter = false;

function requestRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

function clearDropMarks() {
  if (!listEl) return;
  for (const card of listEl.querySelectorAll('.frame-card')) {
    card.classList.remove('drop-before', 'drop-after');
  }
}

function render() {
  if (!listEl || !metaEl || !state.doc) return;
  const frames = state.doc.frames || [];
  const scrollLeft = listEl.scrollLeft;
  const summary = projectSummary();
  metaEl.textContent = `${summary.frames} 帧 · ${summary.exposures} 次曝光 · ${formatMs(summary.duration)}`;

  listEl.replaceChildren();
  frames.forEach((frame, index) => {
    const card = h('div', {
      class: 'frame-card',
      role: 'option',
      tabindex: '0',
      draggable: true,
      dataset: { index: String(index), id: frame.id },
      title: frame.note || frame.name,
      'aria-selected': frame.id === state.selectionId ? 'true' : 'false',
    });
    if (frame.id === state.selectionId) card.classList.add('active');
    if (frame.visible === false) card.classList.add('hidden-frame');

    const thumb = h('div', { class: 'frame-thumb' });
    if (frame.url) {
      thumb.append(h('img', { src: frame.url, alt: frame.name, loading: 'lazy', draggable: false }));
    }

    const flags = h('div', { class: 'frame-flags' });
    const hold = Math.max(1, Number(frame.hold) || 1);
    if (hold > 1) flags.append(h('span', { class: 'frame-flag', title: `曝光 ${hold} 次` }, `×${hold}`));
    if (frame.visible === false) flags.append(h('span', { class: 'frame-flag muted' }, '隐'));

    const caption = h('div', { class: 'frame-caption' });
    caption.append(
      h('span', {}, `${frameDuration(frame, state.doc.timeline?.fps) || 0}ms`),
      h('span', {}, String(index + 1).padStart(2, '0')),
    );

    card.append(
      h('span', { class: 'frame-index' }, String(index + 1)),
      flags,
      thumb,
      caption,
    );
    listEl.append(card);
  });

  const add = h('button', {
    class: 'frame-add',
    type: 'button',
    title: '导入更多帧',
    onclick: () => document.dispatchEvent(new CustomEvent('anim:import')),
  }, [h('span', {}, '＋'), h('span', {}, '导入')]);
  listEl.append(add);
  listEl.scrollLeft = scrollLeft;
}

function bindDnd() {
  listEl.addEventListener('click', (event) => {
    const card = event.target.closest('.frame-card');
    if (!card) return;
    setSelection(card.dataset.id);
  });

  listEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.frame-card');
    if (!card) return;
    event.preventDefault();
    setSelection(card.dataset.id);
  });

  listEl.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.frame-card');
    if (!card) return;
    dragIndex = Number(card.dataset.index);
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.id);
  });

  listEl.addEventListener('dragend', () => {
    dragIndex = -1;
    dropIndex = -1;
    clearDropMarks();
    for (const card of listEl.querySelectorAll('.frame-card')) card.classList.remove('dragging');
  });

  listEl.addEventListener('dragover', (event) => {
    if (dragIndex < 0) return;
    const card = event.target.closest('.frame-card');
    if (!card) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    dropAfter = event.clientX > rect.left + rect.width / 2;
    dropIndex = Number(card.dataset.index);
    clearDropMarks();
    card.classList.add(dropAfter ? 'drop-after' : 'drop-before');
  });

  listEl.addEventListener('drop', (event) => {
    if (dragIndex < 0 || dropIndex < 0) return;
    event.preventDefault();
    const target = dropAfter ? dropIndex + 1 : dropIndex;
    reorder(dragIndex, target);
    dragIndex = -1;
    dropIndex = -1;
    clearDropMarks();
  });
}

export function mountFilmstrip() {
  listEl = document.getElementById('filmstrip');
  metaEl = document.getElementById('filmstrip-meta');
  if (!listEl) return;
  bindDnd();
  subscribe((reason) => {
    if (['project', 'doc', 'frame', 'selection'].includes(reason)) requestRender();
  });
  render();
}
