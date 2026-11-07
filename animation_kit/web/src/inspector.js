// 帧检视器：名称、时间、变换、状态、备注与元信息。
// 所有字段与后端 registry.FRAME_FIELDS 对齐；修改经 store 自动保存。

import { h, formatMs, clamp } from './utils.js';
import {
  duplicateFrame, getSelectedFrame, removeFrame, state, subscribe, updateFrameValue,
} from './store.js';

const SOURCE_LABEL = { sheet: '宫格切分', upload: '导入图片', derived: '衍生副本' };

let root = null;
let currentId = '';
const refs = {};

function field(label, control) {
  return h('label', { class: 'field' }, [h('span', {}, label), control]);
}

function numberInput(key, { min, max, step = 1, title = '' }) {
  const input = h('input', { type: 'number', step, title });
  input.min = String(min);
  input.max = String(max);
  input.addEventListener('input', () => {
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    updateFrameValue(currentId, key, raw);
  });
  input.addEventListener('blur', () => {
    const raw = clamp(Number(input.value) || 0, min, max);
    input.value = String(raw);
    if (Number(state.doc?.frames.find((f) => f.id === currentId)?.[key]) !== raw) {
      updateFrameValue(currentId, key, raw);
    }
  });
  refs[key] = input;
  return input;
}

function textInput(key, { maxLength = 80, placeholder = '' } = {}) {
  const input = h('input', { type: 'text', placeholder, spellcheck: 'false' });
  input.maxLength = maxLength;
  input.addEventListener('input', () => updateFrameValue(currentId, key, input.value));
  refs[key] = input;
  return input;
}

function switchControl(key, label) {
  const wrap = h('label', { class: 'switch' });
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => updateFrameValue(currentId, key, input.checked));
  wrap.append(input, h('i'), h('span', {}, label));
  refs[key] = input;
  return wrap;
}

function metaRow(label, key) {
  const value = h('b', {}, '—');
  refs[key] = value;
  return h('div', { class: 'meta-row' }, [h('span', {}, label), value]);
}

function buildEmpty() {
  const wrap = h('div', { class: 'inspector-empty' }, [
    h('p', {}, '还没有可编辑的帧'),
    h('button', {
      class: 'btn btn-ghost btn-compact',
      type: 'button',
      style: { marginTop: '10px' },
      onclick: () => document.dispatchEvent(new CustomEvent('anim:import')),
    }, '导入帧'),
  ]);
  root.replaceChildren(wrap);
  currentId = '';
}

function build(frame, index) {
  const total = state.doc?.frames.length || 0;
  const head = h('div', { class: 'inspector-head' }, [
    h('div', { class: 'inspector-title' }, [
      h('span', { class: 'idx' }, String(index + 1).padStart(2, '0')),
      h('h2', {}, '帧属性'),
    ]),
    h('span', { class: 'hint' }, `${total} 帧`),
  ]);

  const preview = h('div', { class: 'inspector-preview' });
  const previewImg = h('img', { alt: frame.name });
  preview.append(previewImg);
  refs.preview = previewImg;

  const nameField = field('名称', textInput('name', { maxLength: 80 }));

  const timing = h('div', { class: 'field-grid two' }, [
    field('停顿（曝光次数）', numberInput('hold', { min: 1, max: 240 })),
    field('帧时长（0=按帧率）', numberInput('duration', { min: 0, max: 60000 })),
  ]);

  const transform = h('div', { class: 'inspector-group' }, [
    h('h3', {}, '变换'),
    h('div', { class: 'field-grid two' }, [
      field('X 位移', numberInput('offsetX', { min: -8192, max: 8192 })),
      field('Y 位移', numberInput('offsetY', { min: -8192, max: 8192 })),
    ]),
    h('div', { class: 'field-grid two' }, [
      field('缩放', numberInput('scale', { min: 0.05, max: 8, step: 0.01 })),
      field('旋转（度）', numberInput('rotation', { min: -360, max: 360, step: 0.5 })),
    ]),
    field('不透明度', (() => {
      const input = h('input', { type: 'range', min: '0', max: '1', step: '0.01' });
      input.addEventListener('input', () => updateFrameValue(currentId, 'opacity', Number(input.value)));
      refs.opacity = input;
      return input;
    })()),
  ]);

  const stateGroup = h('div', { class: 'inspector-group' }, [
    h('h3', {}, '状态'),
    h('div', { class: 'inline-control' }, [
      switchControl('visible', '显示'),
      switchControl('locked', '锁定几何'),
    ]),
  ]);

  const note = h('textarea', { class: 'select', rows: '2', placeholder: '拍摄备注、动作提示…' });
  note.style.height = 'auto';
  note.style.minHeight = '60px';
  note.style.padding = '7px 9px';
  note.addEventListener('input', () => updateFrameValue(currentId, 'note', note.value));
  refs.note = note;

  const meta = h('div', { class: 'inspector-group' }, [
    h('h3', {}, '信息'),
    metaRow('尺寸', 'metaSize'),
    metaRow('来源', 'metaOrigin'),
    metaRow('有效时长', 'metaDuration'),
    metaRow('总时长', 'metaTotal'),
  ]);

  const actions = h('div', { class: 'inspector-actions' }, [
    h('button', { class: 'btn btn-ghost btn-compact', type: 'button', onclick: () => duplicateFrame(currentId) }, '复制帧'),
    h('button', { class: 'btn btn-danger btn-compact', type: 'button', onclick: () => removeFrame(currentId) }, '删除帧'),
  ]);

  root.replaceChildren(head, preview, nameField, timing, transform, stateGroup,
    h('div', { class: 'inspector-group' }, [h('h3', {}, '备注'), note]),
    meta, actions);
  currentId = frame.id;
  sync(frame);
}

function sync(frame = getSelectedFrame()) {
  if (!root || !frame || frame.id !== currentId) return;
  const active = document.activeElement;
  const setValue = (key, value) => {
    const el = refs[key];
    if (!el || el === active) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (String(el.value) !== String(value)) el.value = String(value);
  };
  setValue('name', frame.name);
  setValue('hold', frame.hold);
  setValue('duration', frame.duration);
  setValue('offsetX', frame.offsetX);
  setValue('offsetY', frame.offsetY);
  setValue('scale', frame.scale);
  setValue('rotation', frame.rotation);
  setValue('opacity', frame.opacity);
  setValue('visible', frame.visible !== false);
  setValue('locked', Boolean(frame.locked));
  setValue('note', frame.note || '');

  if (refs.preview && refs.preview.getAttribute('src') !== frame.url) {
    refs.preview.src = frame.url;
    refs.preview.alt = frame.name;
  }
  if (refs.metaSize) refs.metaSize.textContent = `${frame.width} × ${frame.height}`;
  if (refs.metaOrigin) refs.metaOrigin.textContent = SOURCE_LABEL[frame.origin] || frame.origin;
  if (refs.metaDuration) {
    const fps = Number(state.doc?.timeline?.fps) || 12;
    const auto = Math.max(10, Math.round(1000 / Math.max(1, fps)));
    const own = Number(frame.duration) || 0;
    refs.metaDuration.textContent = own > 0 ? `${own} ms × ${Math.max(1, Number(frame.hold) || 1)}` : `自动 ${auto} ms × ${Math.max(1, Number(frame.hold) || 1)}`;
  }
  if (refs.metaTotal) {
    const total = state.doc?.frames.reduce((sum, item) => {
      const fps = Number(state.doc?.timeline?.fps) || 12;
      const own = Number(item.duration) || 0;
      const value = own > 0 ? own : Math.max(10, Math.round(1000 / Math.max(1, fps)));
      return sum + value * Math.max(1, Number(item.hold) || 1);
    }, 0) || 0;
    refs.metaTotal.textContent = formatMs(total);
  }

  const locked = Boolean(frame.locked);
  for (const key of ['offsetX', 'offsetY', 'scale', 'rotation', 'opacity']) {
    if (refs[key]) refs[key].disabled = locked;
  }
}

function render() {
  if (!root) return;
  const frame = getSelectedFrame();
  if (!frame) {
    buildEmpty();
    return;
  }
  const index = state.doc.frames.findIndex((item) => item.id === frame.id);
  if (frame.id !== currentId) build(frame, Math.max(0, index));
  else sync(frame);
}

export function mountInspector() {
  root = document.getElementById('inspector');
  if (!root) return;
  subscribe((reason) => {
    if (['project', 'doc', 'selection'].includes(reason)) render();
    else if (reason === 'frame') sync();
  });
  render();
}
