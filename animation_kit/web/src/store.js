// 单一数据流：组件只读 store，所有修改都通过这里并自动持久化。

import { api } from './api.js';
import { debounce, clamp } from './utils.js';

const listeners = new Set();

export const state = {
  options: null,
  projects: [],
  doc: null,
  selectionId: '',
  playing: false,
  playhead: 0,
  onion: { enabled: true, opacity: 0.26, mode: 'both' },
  zoom: 'fit',
  showGuides: false,
  saving: false,
  dirty: false,
  saveError: '',
  rev: 0,
  theme: localStorage.getItem('anim-theme') || 'light',
  job: null,
  lastExport: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) {
    try { fn(reason); } catch (error) { console.error('[store]', error); }
  }
}

function bump() {
  state.rev += 1;
  state.dirty = true;
  emit('frame');
  scheduleSave();
}

const scheduleSave = debounce(saveNow, 700);

function selectedFrame() {
  if (!state.doc) return null;
  return state.doc.frames.find((frame) => frame.id === state.selectionId) || null;
}

export function getSelectedFrame() {
  return selectedFrame();
}

export function visibleFrames(doc = state.doc) {
  return (doc?.frames || []).filter((frame) => frame.visible !== false);
}

export function frameDuration(frame, fps = state.doc?.timeline?.fps || 12) {
  const duration = Number(frame?.duration) || 0;
  if (duration > 0) return duration;
  return Math.max(10, Math.round(1000 / Math.max(1, fps)));
}

export function expandedSequence(doc = state.doc) {
  if (!doc) return [];
  const fps = Number(doc.timeline?.fps) || 12;
  const frames = visibleFrames(doc);
  if (!frames.length) return [];
  const order = frames.map((_frame, index) => index);
  if (doc.timeline?.direction === 'pingpong' && order.length > 2) {
    order.push(...order.slice(1, -1).reverse());
  }
  const sequence = [];
  for (const frameIndex of order) {
    const frame = frames[frameIndex];
    const duration = frameDuration(frame, fps);
    const hold = Math.max(1, Number(frame.hold) || 1);
    for (let repeat = 0; repeat < hold; repeat += 1) {
      sequence.push({ frame, frameIndex, duration, holdIndex: repeat, holdTotal: hold });
    }
  }
  return sequence;
}

export function totalDuration(doc = state.doc) {
  return expandedSequence(doc).reduce((sum, item) => sum + item.duration, 0);
}

export function currentPlayTime() {
  const sequence = expandedSequence();
  let total = 0;
  for (let index = 0; index < Math.min(state.playhead, sequence.length); index += 1) {
    total += sequence[index].duration;
  }
  return total;
}

export function playbackFrame() {
  if (!state.doc) return null;
  if (state.playing) {
    const sequence = expandedSequence();
    return sequence[state.playhead]?.frame || selectedFrame();
  }
  return selectedFrame();
}

export function init({ options, projects }) {
  state.options = options;
  state.projects = projects;
  document.documentElement.dataset.theme = state.theme;
  emit('boot');
}

export function setProjects(projects) {
  state.projects = projects;
  emit('projects');
}

export function setProject(doc, { dirty = false, reason = 'project' } = {}) {
  state.doc = doc;
  state.dirty = dirty;
  state.saving = false;
  state.saveError = '';
  state.playing = false;
  state.playhead = 0;
  if (!doc.frames.some((frame) => frame.id === state.selectionId)) {
    state.selectionId = doc.frames[0]?.id || '';
  }
  emit(reason);
  if (doc.frames.length) emit('selection');
}

export function applyServerDoc(doc, reason = 'doc') {
  const previousId = state.selectionId;
  state.doc = doc;
  state.dirty = false;
  state.saveError = '';
  state.selectionId = doc.frames.some((frame) => frame.id === previousId)
    ? previousId
    : (doc.frames[0]?.id || '');
  state.playhead = 0;
  emit(reason);
  if (state.selectionId !== previousId) emit('selection');
}

export function setSelection(id) {
  if (!state.doc || !state.doc.frames.some((frame) => frame.id === id)) return;
  if (state.selectionId === id) return;
  state.selectionId = id;
  state.playing = false;
  emit('selection');
}

export function selectRelative(delta) {
  if (!state.doc) return;
  const frames = visibleFrames();
  if (!frames.length) return;
  const index = Math.max(0, frames.findIndex((frame) => frame.id === state.selectionId));
  const next = (index + delta + frames.length) % frames.length;
  setSelection(frames[next].id);
}

export function updateFrame(id, patch, { save = true } = {}) {
  const frame = state.doc?.frames.find((item) => item.id === id);
  if (!frame) return;
  Object.assign(frame, patch);
  if (save) bump();
  else emit('frame');
}

export function updateFrameValue(id, key, value) {
  const frame = state.doc?.frames.find((item) => item.id === id);
  if (!frame) return;
  frame[key] = value;
  state.rev += 1;
  state.dirty = true;
  emit('frame');
  scheduleSave();
}

export function updateCanvas(patch) {
  if (!state.doc) return;
  Object.assign(state.doc.canvas, patch);
  bump();
}

export function updateTimeline(patch) {
  if (!state.doc) return;
  Object.assign(state.doc.timeline, patch);
  bump();
}

export function updateProcessing(group, patch) {
  if (!state.doc) return;
  const current = state.doc.processing?.[group] || {};
  state.doc.processing = state.doc.processing || {};
  state.doc.processing[group] = { ...current, ...patch };
  bump();
}

export function applyDefaultHold() {
  if (!state.doc) return;
  const hold = clamp(Number(state.doc.timeline.defaultHold) || 1, 1, 240);
  state.doc.frames.forEach((frame) => { frame.hold = hold; });
  bump();
}

export function reorder(fromIndex, toIndex) {
  if (!state.doc) return;
  const frames = state.doc.frames;
  if (fromIndex < 0 || fromIndex >= frames.length) return;
  // toIndex 是「插入到当前数组的第几个位置之前」，允许等于 length（放到末尾）
  let target = clamp(Number(toIndex) || 0, 0, frames.length);
  const [moved] = frames.splice(fromIndex, 1);
  if (fromIndex < target) target -= 1;
  target = clamp(target, 0, Math.max(0, frames.length - 1));
  frames.splice(target, 0, moved);
  bump();
}

export function duplicateFrame(id) {
  if (!state.doc) return;
  const index = state.doc.frames.findIndex((frame) => frame.id === id);
  if (index < 0) return;
  const source = state.doc.frames[index];
  const clone = {
    ...source,
    id: `f-${Math.random().toString(16).slice(2, 10)}`,
    name: `${source.name} 副本`.slice(0, 80),
    sourceUrl: '',
    origin: 'derived',
  };
  state.doc.frames.splice(index + 1, 0, clone);
  state.selectionId = clone.id;
  bump();
  emit('selection');
}

export function removeFrame(id) {
  if (!state.doc) return;
  const index = state.doc.frames.findIndex((frame) => frame.id === id);
  if (index < 0) return;
  state.doc.frames.splice(index, 1);
  if (state.selectionId === id) {
    const next = state.doc.frames[Math.min(index, state.doc.frames.length - 1)];
    state.selectionId = next?.id || '';
    emit('selection');
  }
  bump();
}

export function addImportedFrames(frames, { selectFirst = true } = {}) {
  if (!state.doc) return;
  state.doc.frames.push(...frames);
  if (selectFirst && frames.length) {
    state.selectionId = frames[0].id;
    emit('selection');
  }
  state.dirty = false; // 导入接口已经落盘
  emit('doc');
}

export function setPlaying(playing) {
  state.playing = Boolean(playing) && Boolean(state.doc?.frames.length);
  if (state.playing) {
    const sequence = expandedSequence();
    const index = sequence.findIndex((item) => item.frame.id === state.selectionId);
    state.playhead = index >= 0 ? index : 0;
  } else {
    state.playhead = 0;
  }
  emit('playback');
}

export function togglePlaying() {
  setPlaying(!state.playing);
}

export function setPlayhead(index) {
  state.playhead = Math.max(0, Number(index) || 0);
  emit('playhead');
}

export function setOnion(patch) {
  Object.assign(state.onion, patch);
  emit('ui');
}

export function setZoom(zoom) {
  state.zoom = zoom;
  emit('ui');
}

export function setShowGuides(value) {
  state.showGuides = Boolean(value);
  emit('ui');
}

export function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('anim-theme', theme);
  document.documentElement.dataset.theme = theme;
  emit('ui');
}

export function setJob(job) {
  state.job = job;
  emit('job');
}

export function setLastExport(result) {
  state.lastExport = result;
  emit('export');
}

function saveStatus() {
  emit('save');
}

export async function saveNow() {
  if (!state.doc || !state.dirty) return null;
  if (state.saving) {
    scheduleSave();
    return null;
  }
  const projectId = state.doc.id;
  const revision = state.rev;
  const snapshot = JSON.parse(JSON.stringify(state.doc));
  state.saving = true;
  state.saveError = '';
  saveStatus();
  try {
    const payload = await api.saveProject(projectId, snapshot);
    state.saving = false;
    if (state.rev === revision) {
      state.dirty = false;
      state.doc.updatedAt = payload.project.updatedAt;
      state.doc.createdAt = state.doc.createdAt || payload.project.createdAt;
      const item = state.projects.find((entry) => entry.id === projectId);
      if (item) item.updatedAt = payload.project.updatedAt;
    } else {
      state.dirty = true;
      scheduleSave();
    }
    saveStatus();
    emit('projects');
    return payload.project;
  } catch (error) {
    state.saving = false;
    state.saveError = error.message || '保存失败';
    saveStatus();
    return null;
  }
}

export function flushSave() {
  scheduleSave.cancel();
  return saveNow();
}

export async function renameProject(name) {
  if (!state.doc) return;
  state.doc.name = String(name || '').slice(0, 80) || '未命名动画';
  bump();
  const item = state.projects.find((entry) => entry.id === state.doc.id);
  if (item) item.name = state.doc.name;
  emit('projects');
}

export function projectSummary() {
  const sequence = expandedSequence();
  return {
    frames: state.doc?.frames.length || 0,
    visible: visibleFrames().length,
    exposures: sequence.length,
    duration: sequence.reduce((sum, item) => sum + item.duration, 0),
  };
}
