// 启动：加载选项与项目、装配各模块、绑定传输控制与键盘快捷键。

import { api } from './api.js';
import { formatMs, isTypingTarget } from './utils.js';
import {
  currentPlayTime, duplicateFrame, expandedSequence, flushSave, init, removeFrame,
  renameProject, setOnion, setProject, setProjects, setSelection,
  setShowGuides, setTheme, setZoom, state, subscribe, totalDuration,
} from './store.js';
import { mountFilmstrip } from './filmstrip.js';
import { mountInspector } from './inspector.js';
import { mountStage } from './stage.js';
import { mountTools, openExport, openImport, promptModal, toast } from './tools.js';
import { step, toggle } from './player.js';

const LAST_PROJECT_KEY = 'anim-project';

function $(selector) {
  return document.querySelector(selector);
}

// ---------------------------------------------------------------- 项目

function renderProjectSelect() {
  const select = document.getElementById('project-select');
  if (!select) return;
  select.replaceChildren();
  for (const item of state.projects) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name || '未命名动画';
    select.append(option);
  }
  if (state.doc?.id) select.value = state.doc.id;
}

function syncProjectHeader() {
  const nameInput = document.getElementById('project-name');
  const select = document.getElementById('project-select');
  if (select && state.doc?.id) select.value = state.doc.id;
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = state.doc?.name || '';
  }
}

async function refreshProjects() {
  const payload = await api.projects();
  setProjects(payload.items || []);
  renderProjectSelect();
  return payload.items || [];
}

async function switchProject(id, { force = false } = {}) {
  if (!id) return;
  if (!force && state.doc?.id === id) return;
  await flushSave();
  try {
    const payload = await api.getProject(id);
    setProject(payload.project);
    localStorage.setItem(LAST_PROJECT_KEY, id);
    syncProjectHeader();
    syncTransport();
  } catch (error) {
    toast(error.message, 'bad', 5000);
  }
}

async function createProject() {
  if (document.getElementById('modal-root').children.length) return;
  const name = await promptModal({
    title: '新建项目',
    label: '项目名称',
    value: '我的定格动画',
    placeholder: '例如：纸偶开场',
    confirmText: '创建',
  });
  if (!name) return;
  await flushSave();
  try {
    const defaults = state.options?.defaults || {};
    const payload = await api.createProject({
      name,
      canvas: defaults.canvas,
      timeline: defaults.timeline,
    });
    await refreshProjects();
    await switchProject(payload.project.id, { force: true });
    toast('项目已创建');
  } catch (error) {
    toast(error.message, 'bad', 5000);
  }
}

// ---------------------------------------------------------------- 保存状态

function syncSaveState() {
  const el = document.getElementById('save-state');
  if (!el) return;
  let status = 'saved';
  let text = '已保存';
  if (state.saving) {
    status = 'saving';
    text = '保存中';
  } else if (state.saveError) {
    status = 'error';
    text = state.saveError;
  } else if (state.dirty) {
    status = 'dirty';
    text = '未保存';
  }
  el.dataset.state = status;
  const label = el.querySelector('.text');
  if (label) label.textContent = text;
}

// ---------------------------------------------------------------- 传输控制

function pausedTime() {
  const sequence = expandedSequence();
  const index = sequence.findIndex((item) => item.frame.id === state.selectionId);
  let total = 0;
  for (let cursor = 0; cursor < Math.max(0, index); cursor += 1) {
    total += sequence[cursor].duration;
  }
  return total;
}

function syncTransport() {
  const play = document.querySelector('#btn-play .icon-play');
  const pause = document.querySelector('#btn-play .icon-pause');
  if (play) play.hidden = state.playing;
  if (pause) pause.hidden = !state.playing;
  const button = document.getElementById('btn-play');
  if (button) {
    button.title = state.playing ? '暂停（空格）' : '播放（空格）';
    button.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }
  const readout = document.getElementById('time-readout');
  if (readout) {
    const time = state.playing ? currentPlayTime() : pausedTime();
    readout.textContent = `${formatMs(time)} / ${formatMs(totalDuration())}`;
  }
}

function mountTransport() {
  document.getElementById('btn-play')?.addEventListener('click', () => {
    toggle();
    syncTransport();
  });
  document.getElementById('btn-prev')?.addEventListener('click', () => {
    step(-1);
    syncTransport();
  });
  document.getElementById('btn-next')?.addEventListener('click', () => {
    step(1);
    syncTransport();
  });

  const onionEnabled = document.getElementById('onion-enabled');
  const onionOpacity = document.getElementById('onion-opacity');
  const onionMode = document.getElementById('onion-mode');
  const guides = document.getElementById('show-guides');
  if (onionEnabled) onionEnabled.checked = state.onion.enabled;
  if (onionOpacity) onionOpacity.value = String(state.onion.opacity);
  if (onionMode) onionMode.value = state.onion.mode;
  if (guides) guides.checked = state.showGuides;

  onionEnabled?.addEventListener('change', () => setOnion({ enabled: onionEnabled.checked }));
  onionOpacity?.addEventListener('input', () => setOnion({ opacity: Number(onionOpacity.value) }));
  onionMode?.addEventListener('change', () => setOnion({ mode: onionMode.value }));
  guides?.addEventListener('change', () => setShowGuides(guides.checked));

  const zoom = () => (state.zoom === 'fit' ? 100 : Number(state.zoom) || 100);
  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => setZoom('fit'));
  document.getElementById('btn-zoom-100')?.addEventListener('click', () => setZoom(100));
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => setZoom(Math.min(800, Math.round(zoom() * 1.25))));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => setZoom(Math.max(10, Math.round(zoom() * 0.8))));
}

// ---------------------------------------------------------------- 键盘

function modalOpen() {
  return document.getElementById('modal-root')?.children.length > 0;
}

function mountKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target) || modalOpen()) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 's') {
      event.preventDefault();
      flushSave();
      return;
    }
    if (mod && key === 'd') {
      event.preventDefault();
      if (state.selectionId) duplicateFrame(state.selectionId);
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      toggle();
      syncTransport();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
      syncTransport();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
      syncTransport();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      const first = state.doc?.frames[0];
      if (first) setSelection(first.id);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const frames = state.doc?.frames || [];
      if (frames.length) setSelection(frames[frames.length - 1].id);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!state.selectionId) return;
      event.preventDefault();
      removeFrame(state.selectionId);
      syncTransport();
      return;
    }
    if (key === 'i') {
      event.preventDefault();
      openImport();
      return;
    }
    if (key === 'e') {
      event.preventDefault();
      openExport();
    }
  });
}

// ---------------------------------------------------------------- 启动

async function boot() {
  mountStage();
  mountFilmstrip();
  mountInspector();
  mountTools();
  mountTransport();
  mountKeyboard();
  setTheme(state.theme);

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('btn-new-project')?.addEventListener('click', createProject);
  document.getElementById('project-select')?.addEventListener('change', (event) => {
    switchProject(event.target.value);
  });
  const nameInput = document.getElementById('project-name');
  nameInput?.addEventListener('change', async () => {
    await renameProject(nameInput.value);
    flushSave();
  });
  nameInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      nameInput.blur();
    }
  });

  subscribe((reason) => {
    if (['save', 'project', 'doc', 'frame'].includes(reason)) syncSaveState();
    if (['project', 'doc'].includes(reason)) syncProjectHeader();
    if (['project', 'doc', 'selection', 'frame', 'ui', 'playhead', 'playback'].includes(reason)) {
      syncTransport();
    }
  });

  try {
    const [options, projects] = await Promise.all([api.options(), api.projects()]);
    init({ options, projects: projects.items || [] });

    let id = localStorage.getItem(LAST_PROJECT_KEY);
    if (!projects.items?.some((item) => item.id === id)) {
      id = projects.items?.[0]?.id || '';
    }
    if (!id) {
      const defaults = options.defaults || {};
      const created = await api.createProject({
        name: '我的定格动画',
        canvas: defaults.canvas,
        timeline: defaults.timeline,
      });
      await refreshProjects();
      id = created.project.id;
    }
    await switchProject(id, { force: true });
    refreshProjects().catch(() => {});
  } catch (error) {
    toast(error.message || '启动失败，请确认服务已启动', 'bad', 8000);
  }

  syncSaveState();
  syncTransport();

  window.addEventListener('beforeunload', () => {
    flushSave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

boot();
