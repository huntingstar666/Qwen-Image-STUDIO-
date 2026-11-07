// 工具与弹窗：画布/时间轴/自动稳定/色彩一致、导入、导出、提示。
// 所有字段都从 /api/options（后端单一注册表）读取，避免前后端各写一套。

import { api, pollJob } from './api.js';
import {
  applyDefaultHold, applyServerDoc, projectSummary, state, subscribe,
  updateCanvas, updateProcessing, updateTimeline,
} from './store.js';
import {
  clampInt, formatBytes, formatMs, h, readFileAsDataURL, triggerDownload,
} from './utils.js';

const ENUM_LABELS = {
  'row-major': '行优先（左→右，上→下）',
  serpentine: '蛇形（来回）',
  'column-major': '列优先（上→下，左→右）',
  none: '不裁边',
  union: '并集包围盒（保留格内位移）',
  each: '每格独立裁边（会消除位移）',
  pad: '透明补边（不重采样）',
  stretch: '拉伸（会重采样）',
  center: '居中',
  top: '顶部',
  bottom: '底部',
  first: '首帧',
  previous: '上一帧',
  median: '全片中位',
  subject: '仅主体',
  full: '整帧',
};

export function toast(message, kind = 'ok', timeout = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = h('div', { class: `toast ${kind}` }, String(message));
  root.append(el);
  window.setTimeout(() => el.remove(), timeout);
}

export function promptModal({ title, label, value = '', placeholder = '', confirmText = '确定' }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'select', type: 'text', placeholder });
    input.value = value;
    const status = h('span', { class: 'status' }, '');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
    const ok = h('button', { class: 'btn btn-primary', type: 'button' }, confirmText);
    let settled = false;
    let modal = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      modal?.close();
    };

    ok.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) {
        status.textContent = '名称不能为空';
        input.focus();
        return;
      }
      finish(text);
    });
    cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        ok.click();
      }
    });

    modal = openModal({
      title,
      body: h('label', { class: 'field' }, [h('span', {}, label), input]),
      footer: [status, cancel, ok],
      narrow: true,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

function openModal({ title, subtitle = '', body, footer, narrow = false, onClose }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dialog = h('div', { class: narrow ? 'modal narrow' : 'modal' });
  const head = h('div', { class: 'modal-head' }, [
    h('div', {}, [
      h('h2', {}, title),
      subtitle ? h('p', {}, subtitle) : null,
    ]),
    h('button', {
      class: 'icon-btn',
      type: 'button',
      title: '关闭',
      'aria-label': '关闭',
      onclick: () => close(),
    }, '×'),
  ]);
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footEl = h('div', { class: 'modal-foot' }, footer);
  dialog.append(head, bodyEl, footEl);
  backdrop.append(dialog);
  root.append(backdrop);

  let closed = false;
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
    if (previous instanceof HTMLElement) previous.focus();
  }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  return { backdrop, dialog, body: bodyEl, foot: footEl, close };
}

function defaultsOf(fields) {
  const out = {};
  for (const [name, spec] of Object.entries(fields || {})) out[name] = spec.default;
  return out;
}

function controlFor(name, spec, value, onChange) {
  if (spec.type === 'bool') {
    const wrap = h('label', { class: 'switch' });
    const input = h('input', { type: 'checkbox' });
    input.checked = value === undefined ? Boolean(spec.default) : Boolean(value);
    input.addEventListener('change', () => onChange(name, input.checked));
    wrap.append(input, h('i'), h('span', {}, spec.label || name));
    return wrap;
  }

  const field = h('label', { class: 'field' }, [h('span', {}, spec.label || name)]);
  let input;
  if (spec.type === 'enum') {
    input = h('select', { class: 'select' });
    for (const item of spec.values || []) {
      input.append(h('option', { value: item }, ENUM_LABELS[item] || item));
    }
    input.value = String(value ?? spec.default ?? '');
    input.addEventListener('change', () => onChange(name, input.value));
  } else if (spec.type === 'int') {
    input = h('input', { type: 'number', step: '1' });
    input.min = String(spec.min ?? 0);
    input.max = String(spec.max ?? 999999);
    input.value = String(value ?? spec.default ?? 0);
    input.addEventListener('change', () => {
      const next = clampInt(input.value, spec.min ?? 0, spec.max ?? 999999, spec.default ?? 0);
      input.value = String(next);
      onChange(name, next);
    });
  } else {
    input = h('input', { type: 'text' });
    input.value = String(value ?? spec.default ?? '');
    input.addEventListener('input', () => onChange(name, input.value));
  }
  field.append(input);
  return field;
}

function buildControls(fields, values, onChange, { columns = 2 } = {}) {
  const wrap = h('div');
  const grid = h('div', { class: columns === 2 ? 'field-grid two' : 'field-grid' });
  const switches = [];
  for (const [name, spec] of Object.entries(fields || {})) {
    const control = controlFor(name, spec, values[name], onChange);
    if (spec.type === 'bool') switches.push(control);
    else grid.append(control);
  }
  wrap.append(grid);
  if (switches.length) {
    wrap.append(h('div', { class: 'inline-control', style: { flexWrap: 'wrap', marginTop: '8px' } }, switches));
  }
  return wrap;
}

function dropzone({ multiple = false, label, hint, onFiles }) {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.multiple = Boolean(multiple);
  const zone = h('label', { class: 'dropzone' }, [
    h('strong', {}, label),
    h('span', {}, hint),
    input,
  ]);
  const take = (files) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length) onFiles(images);
  };
  input.addEventListener('change', () => {
    take(Array.from(input.files || []));
    input.value = '';
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragover');
    take(Array.from(event.dataTransfer?.files || []));
  });
  return zone;
}

// ---------------------------------------------------------------- 导入

export function openImport() {
  if (!state.doc) {
    toast('请先创建项目', 'warn');
    return;
  }
  const sheetFields = state.options?.fields?.source?.sheet?.fields || {};
  const importFields = state.options?.fields?.import || {};
  const sheetValues = defaultsOf(sheetFields);
  const importValues = defaultsOf(importFields);
  const sheet = { file: null, dataUrl: '', width: 0, height: 0 };
  let framesFiles = [];
  let tab = 'sheet';

  const previewImg = h('img', { alt: '宫格预览' });
  previewImg.hidden = true;
  const gridOverlay = h('div', { class: 'preview-grid' });
  const emptyHint = h('div', { class: 'preview-empty' },
    '选择一张透明宫格图（默认按 4×4 切分）');
  const previewBox = h('div', { class: 'preview-box' }, [emptyHint, previewImg, gridOverlay]);

  const side = h('div', { class: 'import-side' });
  const tabs = h('div', { class: 'tabs' });
  const tabSheet = h('button', { class: 'tab active', type: 'button' }, '宫格切分');
  const tabFrames = h('button', { class: 'tab', type: 'button' }, '多张图片');
  tabs.append(tabSheet, tabFrames);

  const layout = h('div', { class: 'import-layout' }, [previewBox, side]);
  const body = h('div', {}, [tabs, layout]);

  const status = h('span', { class: 'status' }, '支持 PNG / WebP / JPG，透明背景请用 PNG');
  const confirmBtn = h('button', { class: 'btn btn-primary', type: 'button' }, '导入');
  const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
  const modal = openModal({
    title: '导入帧',
    subtitle: '宫格切分只做整数裁剪；默认保留每格内的相对位移',
    body,
    footer: [status, cancelBtn, confirmBtn],
    onClose: () => {
      window.removeEventListener('resize', renderGrid);
      gridOverlay.remove();
    },
  });

  cancelBtn.addEventListener('click', () => modal.close());

  // ---- 宫格预览网格（与后端 round(col*(cell+gap)) 一致）

  function renderGrid() {
    gridOverlay.replaceChildren();
    if (!previewImg.naturalWidth) return;
    const boxRect = previewBox.getBoundingClientRect();
    const imgRect = previewImg.getBoundingClientRect();
    if (!imgRect.width) return;
    gridOverlay.style.inset = 'auto';
    gridOverlay.style.left = `${imgRect.left - boxRect.left}px`;
    gridOverlay.style.top = `${imgRect.top - boxRect.top}px`;
    gridOverlay.style.width = `${imgRect.width}px`;
    gridOverlay.style.height = `${imgRect.height}px`;

    const width = previewImg.naturalWidth;
    const height = previewImg.naturalHeight;
    const rows = Math.max(1, Number(sheetValues.rows) || 1);
    const columns = Math.max(1, Number(sheetValues.columns) || 1);
    const rowGap = Math.max(0, Number(sheetValues.rowGap) || 0);
    const columnGap = Math.max(0, Number(sheetValues.columnGap) || 0);
    const cellW = (width - columnGap * (columns - 1)) / columns;
    const cellH = (height - rowGap * (rows - 1)) / rows;
    if (cellW < 1 || cellH < 1) return;
    const scale = imgRect.width / width;
    const line = (left, top, w, hh) => {
      const node = h('i');
      node.style.inset = 'auto';
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${Math.max(1, w)}px`;
      node.style.height = `${Math.max(1, hh)}px`;
      gridOverlay.append(node);
    };
    for (let column = 0; column <= columns; column += 1) {
      const left = Math.round(column * (cellW + columnGap)) * scale;
      line(left, 0, 1, imgRect.height);
    }
    for (let row = 0; row <= rows; row += 1) {
      const top = Math.round(row * (cellH + rowGap)) * scale;
      line(0, top, imgRect.width, 1);
    }
  }

  window.addEventListener('resize', renderGrid);

  async function pickSheet(files) {
    const file = files[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      sheet.file = file;
      sheet.dataUrl = dataUrl;
      previewImg.hidden = false;
      emptyHint.hidden = true;
      previewImg.onload = () => {
        sheet.width = previewImg.naturalWidth;
        sheet.height = previewImg.naturalHeight;
        const info = side.querySelector('[data-role="sheet-info"]');
        if (info) {
          info.textContent = `${file.name} · ${sheet.width} × ${sheet.height}`;
        }
        renderGrid();
      };
      previewImg.src = dataUrl;
      if (previewImg.complete) previewImg.onload();
    } catch (error) {
      toast(error.message, 'bad');
    }
  }

  function renderSheetPanel() {
    side.replaceChildren();
    const zone = dropzone({
      label: '选择或拖入宫格图',
      hint: '建议一次生成 4×4 透明通道宫格；间隔与留白需与生成参数一致',
      onFiles: pickSheet,
    });
    const info = h('p', { class: 'hint', dataset: { role: 'sheet-info' } },
      sheet.file ? `${sheet.file.name} · ${sheet.width} × ${sheet.height}` : '尚未选择图片');
    const gridControls = buildControls(sheetFields, sheetValues, (name, value) => {
      sheetValues[name] = value;
      renderGrid();
    });
    const importControls = buildControls(importFields, importValues, (name, value) => {
      importValues[name] = value;
    });
    side.append(zone, info, h('div', { class: 'hint' }, '宫格参数'), gridControls,
      h('div', { class: 'hint' }, '统一尺寸'), importControls);
    renderGrid();
  }

  function renderFramesPanel() {
    side.replaceChildren();
    const zone = dropzone({
      multiple: true,
      label: '选择或拖入多张图片',
      hint: '按文件名自然排序；尺寸不一致时默认透明补边，不做缩放',
      onFiles: async (files) => {
        const prepared = [];
        for (const file of files) {
          try {
            prepared.push({ name: file.name, dataUrl: await readFileAsDataURL(file) });
          } catch (error) {
            toast(error.message, 'bad');
          }
        }
        framesFiles = prepared;
        renderFramesPanel();
      },
    });
    const list = h('div', { class: 'file-list' });
    if (!framesFiles.length) {
      list.append(h('span', {}, '尚未选择图片'));
    } else {
      framesFiles
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
        .forEach((file) => list.append(h('span', {}, file.name)));
    }
    const importControls = buildControls(importFields, importValues, (name, value) => {
      importValues[name] = value;
    });
    side.append(zone, list, h('div', { class: 'hint' }, '统一尺寸'), importControls);
  }

  function setTab(next) {
    tab = next;
    tabSheet.classList.toggle('active', tab === 'sheet');
    tabFrames.classList.toggle('active', tab === 'frames');
    previewBox.hidden = tab !== 'sheet';
    layout.classList.toggle('single', tab !== 'sheet');
    if (tab === 'sheet') renderSheetPanel();
    else renderFramesPanel();
  }
  tabSheet.addEventListener('click', () => setTab('sheet'));
  tabFrames.addEventListener('click', () => setTab('frames'));

  async function confirm() {
    if (tab === 'sheet' && !sheet.dataUrl) {
      status.textContent = '请先选择一张宫格图';
      return;
    }
    if (tab === 'frames' && !framesFiles.length) {
      status.textContent = '请先选择至少一张图片';
      return;
    }
    confirmBtn.disabled = true;
    status.textContent = '导入中…';
    try {
      let payload;
      if (tab === 'sheet') {
        payload = await api.importSheet({
          image: sheet.dataUrl,
          grid: { ...sheetValues },
          import: { ...importValues },
          projectId: state.doc.id,
        });
      } else {
        payload = await api.importFrames({
          images: framesFiles.map((file) => ({ data: file.dataUrl, name: file.name })),
          import: { ...importValues },
          projectId: state.doc.id,
        });
      }
      applyServerDoc(payload.project, 'doc');
      for (const warning of payload.warnings || []) toast(warning, 'warn', 6000);
      toast(`已导入 ${payload.frames?.length || 0} 帧`);
      modal.close();
    } catch (error) {
      status.textContent = error.message;
      toast(error.message, 'bad', 6000);
      confirmBtn.disabled = false;
    }
  }
  confirmBtn.addEventListener('click', confirm);

  setTab('sheet');
}

// ---------------------------------------------------------------- 导出

export function openExport() {
  if (!state.doc) {
    toast('请先创建项目', 'warn');
    return;
  }
  if (!state.doc.frames.length) {
    toast('请先导入帧', 'warn');
    openImport();
    return;
  }

  const formats = state.options?.export_formats || {};
  const keys = Object.keys(formats);
  let format = keys.includes('gif') ? 'gif' : keys[0];
  const valuesByFormat = {};
  for (const key of keys) valuesByFormat[key] = defaultsOf(formats[key].options);

  const resultBox = h('div', { class: 'export-result' });
  resultBox.hidden = true;

  const formatGrid = h('div', { class: 'format-grid' });

  const optionsPanel = h('div', { class: 'export-options' });
  const qualityNote = h('div', { class: 'quality-note' });
  const summary = h('div', { class: 'export-summary' });
  const progressTrack = h('div', { class: 'progress-track' }, h('i'));
  progressTrack.hidden = true;
  const progressLabel = h('p', { class: 'hint' }, '');
  const recent = h('div', { class: 'recent-list' });

  const right = h('div', {},
    [h('p', { class: 'hint' }, '输出摘要'), summary, qualityNote,
      progressTrack, progressLabel,
      h('p', { class: 'hint', style: { marginTop: '10px' } }, '最近导出'), recent]);
  const grid = h('div', { class: 'export-grid' }, [optionsPanel, right]);
  const body = h('div', {}, [resultBox, formatGrid, grid]);

  const status = h('span', { class: 'status' }, '');
  const cancelJobBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, '取消任务');
  cancelJobBtn.hidden = true;
  const closeBtn = h('button', { class: 'btn btn-ghost', type: 'button' }, '关闭');
  const exportBtn = h('button', { class: 'btn btn-primary', type: 'button' }, '开始导出');

  const modal = openModal({
    title: '导出动画',
    subtitle: 'GIF 兼容性最好；需要逐像素无损请选 APNG / WebP 无损',
    body,
    footer: [status, cancelJobBtn, closeBtn, exportBtn],
    onClose: () => polling?.stop?.(),
  });
  closeBtn.addEventListener('click', () => modal.close());
  cancelJobBtn.addEventListener('click', async () => {
    if (!activeJobId) return;
    try {
      await api.cancelJob(activeJobId);
      status.textContent = '正在取消…';
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  let activeJobId = '';
  let polling = null;

  function renderFormats() {
    formatGrid.replaceChildren();
    for (const key of keys) {
      const spec = formats[key];
      const card = h('button', {
        class: `format-card${key === format ? ' active' : ''}`,
        type: 'button',
        onclick: () => {
          format = key;
          renderFormats();
          renderOptions();
        },
      }, [h('strong', {}, spec.label || key), h('span', {}, spec.hint || '')]);
      formatGrid.append(card);
    }
  }

  function renderOptions() {
    const spec = formats[format] || { options: {} };
    const values = valuesByFormat[format];
    optionsPanel.replaceChildren(
      h('p', { class: 'hint' }, '格式选项'),
      buildControls(spec.options, values, (name, value) => {
        values[name] = value;
      }, { columns: 2 }),
      h('p', { class: 'hint' }, spec.hint || ''),
    );
    updateSummary();
  }

  function updateSummary() {
    const info = projectSummary();
    summary.replaceChildren(
      h('div', { class: 'meta-row' }, [h('span', {}, '帧数'), h('b', {}, String(info.frames))]),
      h('div', { class: 'meta-row' }, [h('span', {}, '曝光次数'), h('b', {}, String(info.exposures))]),
      h('div', { class: 'meta-row' }, [h('span', {}, '总时长'), h('b', {}, formatMs(info.duration))]),
      h('div', { class: 'meta-row' }, [h('span', {}, '画布'), h('b', {}, `${state.doc.canvas.width} × ${state.doc.canvas.height}`)]),
    );
    const frames = state.doc.frames || [];
    const resampled = frames.some((frame) => Math.abs(Number(frame.scale) - 1) > 1e-6
      || Math.abs((Number(frame.rotation) || 0) % 360) > 1e-6)
      || state.doc.canvas.fit === 'stretch';
    qualityNote.className = resampled ? 'quality-note warn' : 'quality-note';
    qualityNote.textContent = resampled
      ? '当前存在缩放、旋转或强制拉伸：导出会重采样，无法保证逐像素一致。'
      : '当前只有整数位移与等比适配：APNG / WebP 无损可保持逐像素一致；GIF 仍受 256 色与 1 位透明限制。';
  }

  function renderResult(result) {
    if (!result) return;
    resultBox.hidden = false;
    resultBox.replaceChildren();
    const head = h('div', { class: 'export-result-head' }, [
      h('strong', {}, result.filename || '导出完成'),
      h('span', { class: 'chip' }, result.pixel_exact
        ? '逐像素一致'
        : (result.resampled_ids?.length ? '含重采样' : '受格式限制')),
    ]);
    resultBox.append(head);

    if (result.format !== 'png-sequence' && result.url) {
      const preview = h('div', { class: 'export-preview' },
        h('img', { src: result.url, alt: result.filename }));
      resultBox.append(preview);
    }

    const meta = h('div', { class: 'export-summary' }, [
      h('div', { class: 'meta-row' }, [h('span', {}, '格式'), h('b', {}, result.format)]),
      h('div', { class: 'meta-row' }, [h('span', {}, '尺寸'), h('b', {}, `${result.width} × ${result.height}`)]) ,
      h('div', { class: 'meta-row' }, [h('span', {}, '帧 / 曝光'), h('b', {}, `${result.frame_count} / ${result.exposure_count}`)]),
      h('div', { class: 'meta-row' }, [h('span', {}, '时长'), h('b', {}, formatMs(result.duration_ms))]),
      h('div', { class: 'meta-row' }, [h('span', {}, '体积'), h('b', {}, formatBytes(result.bytes))]),
    ]);
    resultBox.append(meta);

    if (result.warnings?.length) {
      const list = h('div', { class: 'warning-list' });
      for (const warning of result.warnings) list.append(h('div', { class: 'warning-item' }, warning));
      resultBox.append(list);
    }

    const actions = h('div', { class: 'button-row' }, [
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: () => triggerDownload(result.url, result.filename),
      }, '下载'),
      result.atlas_url
        ? h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: () => triggerDownload(result.atlas_url, `${result.filename}.atlas.json`),
        }, '下载 atlas')
        : null,
    ].filter(Boolean));
    resultBox.append(actions);
    resultBox.scrollIntoView({ block: 'nearest' });
  }

  async function refreshHistory() {
    try {
      const payload = await api.history(6);
      recent.replaceChildren();
      const items = (payload.items || []).filter((item) => item.status === 'done' && item.result?.url);
      if (!items.length) {
        recent.append(h('span', { class: 'hint' }, '还没有导出记录'));
        return;
      }
      for (const item of items) {
        const link = h('a', {
          href: item.result.url,
          target: '_blank',
          rel: 'noreferrer',
        }, item.result.filename);
        recent.append(h('div', { class: 'recent-item' }, [
          link,
          h('time', {}, String(item.created_at || '').slice(11, 16)),
        ]));
      }
    } catch {
      // 历史记录读取失败不影响导出
    }
  }

  function setProgress(value, max, label) {
    progressTrack.hidden = false;
    const percent = Math.max(0, Math.min(100, (Number(value) / Math.max(1, Number(max))) * 100));
    const bar = progressTrack.firstElementChild;
    if (bar) bar.style.width = `${percent}%`;
    progressLabel.textContent = label || `${Math.round(percent)}%`;
  }

  async function startExport() {
    if (activeJobId) return;
    exportBtn.disabled = true;
    status.textContent = '正在提交…';
    const options = valuesByFormat[format];
    try {
      const submitted = await api.exportAnimation({
        projectId: state.doc.id,
        format,
        options,
      });
      activeJobId = submitted.job_id;
      cancelJobBtn.hidden = false;
      status.textContent = '任务已提交';
      polling = pollJob(activeJobId, (job) => {
        if (job.status === 'queued' || job.status === 'running') {
          setProgress(job.progress?.value || 0, job.progress?.max || 1,
            job.progress?.label || '处理中…');
          status.textContent = job.progress?.label || '处理中…';
          return;
        }
        activeJobId = '';
        polling = null;
        exportBtn.disabled = false;
        cancelJobBtn.hidden = true;
        progressTrack.hidden = true;
        if (job.status === 'done' && job.result) {
          status.textContent = '导出完成';
          renderResult(job.result);
          toast('导出完成');
          refreshHistory();
        } else if (job.status === 'canceled') {
          status.textContent = '已取消';
          toast('导出已取消', 'warn');
        } else {
          status.textContent = job.error || '导出失败';
          toast(job.error || '导出失败', 'bad', 6000);
        }
      });
    } catch (error) {
      exportBtn.disabled = false;
      status.textContent = error.message;
      toast(error.message, 'bad', 6000);
    }
  }
  exportBtn.addEventListener('click', startExport);

  modal.dialog.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      startExport();
    }
  });

  renderFormats();
  renderOptions();
  refreshHistory();
  return modal;
}

// ---------------------------------------------------------------- 左侧工具

function setInput(selector, value, { skipFocused = true } = {}) {
  const el = document.querySelector(selector);
  if (!el) return;
  if (skipFocused && el === document.activeElement) return;
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else if (String(el.value) !== String(value)) el.value = String(value);
}

function syncLeftPanel() {
  const doc = state.doc;
  if (!doc) return;
  const canvas = doc.canvas || {};
  const timeline = doc.timeline || {};
  const processing = doc.processing || {};
  const align = processing.align || {};
  const color = processing.color || {};

  setInput('#canvas-width', canvas.width);
  setInput('#canvas-height', canvas.height);
  setInput('#canvas-fit', canvas.fit || 'contain');
  setInput('#canvas-anchor', canvas.anchor || 'center');
  const transparent = !canvas.background;
  setInput('#canvas-transparent', transparent);
  if (canvas.background) setInput('#canvas-bg', canvas.background);
  const chip = document.getElementById('canvas-chip');
  if (chip) chip.textContent = `${canvas.width} × ${canvas.height}`;

  setInput('#timeline-fps', timeline.fps);
  setInput('#timeline-hold', timeline.defaultHold);
  setInput('#timeline-direction', timeline.direction || 'forward');
  setInput('#timeline-loop', timeline.loop ?? 0);
  const timelineChip = document.getElementById('timeline-chip');
  const summary = projectSummary();
  if (timelineChip) timelineChip.textContent = `${timeline.fps}fps · ${summary.exposures} 次`;

  setInput('#align-reference', align.reference || 'first');
  setInput('#align-max', align.maxShift ?? 64);
  setInput('#align-confidence', align.confidence ?? 0.08);
  const confidenceValue = document.getElementById('align-confidence-value');
  if (confidenceValue) confidenceValue.textContent = Number(align.confidence ?? 0.08).toFixed(2);

  setInput('#color-reference', color.reference || 'median');
  setInput('#color-scope', color.scope || 'subject');
  setInput('#color-strength', color.strength ?? 0.8);
  const strengthValue = document.getElementById('color-strength-value');
  if (strengthValue) strengthValue.textContent = Number(color.strength ?? 0.8).toFixed(2);
}

function reportBox(id, lines, warn = false) {
  const box = document.getElementById(id);
  if (!box) return;
  box.hidden = false;
  box.className = warn ? 'result-box warn' : 'result-box';
  box.replaceChildren();
  for (const line of lines) box.append(h('div', {}, line));
}

function mountLeftPanel() {
  const width = document.getElementById('canvas-width');
  const height = document.getElementById('canvas-height');
  const bg = document.getElementById('canvas-bg');
  const transparent = document.getElementById('canvas-transparent');

  width?.addEventListener('change', () => updateCanvas({
    width: clampInt(width.value, 1, 8192, state.doc?.canvas.width || 1),
  }));
  height?.addEventListener('change', () => updateCanvas({
    height: clampInt(height.value, 1, 8192, state.doc?.canvas.height || 1),
  }));
  document.getElementById('canvas-fit')?.addEventListener('change', (event) => {
    updateCanvas({ fit: event.target.value });
  });
  document.getElementById('canvas-anchor')?.addEventListener('change', (event) => {
    updateCanvas({ anchor: event.target.value });
  });
  bg?.addEventListener('input', () => {
    if (transparent) transparent.checked = false;
    updateCanvas({ background: bg.value });
  });
  transparent?.addEventListener('change', () => {
    updateCanvas({ background: transparent.checked ? '' : (bg?.value || '#ffffff') });
  });

  const fps = document.getElementById('timeline-fps');
  const hold = document.getElementById('timeline-hold');
  const loop = document.getElementById('timeline-loop');
  fps?.addEventListener('change', () => updateTimeline({ fps: clampInt(fps.value, 1, 60, 12) }));
  hold?.addEventListener('change', () => updateTimeline({ defaultHold: clampInt(hold.value, 1, 240, 1) }));
  loop?.addEventListener('change', () => updateTimeline({ loop: clampInt(loop.value, 0, 999, 0) }));
  document.getElementById('timeline-direction')?.addEventListener('change', (event) => {
    updateTimeline({ direction: event.target.value });
  });
  document.getElementById('btn-apply-hold')?.addEventListener('click', () => {
    applyDefaultHold();
    toast('已把默认停顿应用到全部帧');
  });

  document.getElementById('align-reference')?.addEventListener('change', (event) => {
    updateProcessing('align', { reference: event.target.value });
  });
  const alignMax = document.getElementById('align-max');
  alignMax?.addEventListener('change', () => {
    updateProcessing('align', { maxShift: clampInt(alignMax.value, 0, 512, 64) });
  });
  const confidence = document.getElementById('align-confidence');
  confidence?.addEventListener('input', () => {
    const value = Number(confidence.value);
    const label = document.getElementById('align-confidence-value');
    if (label) label.textContent = value.toFixed(2);
    updateProcessing('align', { confidence: value });
  });

  document.getElementById('color-reference')?.addEventListener('change', (event) => {
    updateProcessing('color', { reference: event.target.value });
  });
  document.getElementById('color-scope')?.addEventListener('change', (event) => {
    updateProcessing('color', { scope: event.target.value });
  });
  const strength = document.getElementById('color-strength');
  strength?.addEventListener('input', () => {
    const value = Number(strength.value);
    const label = document.getElementById('color-strength-value');
    if (label) label.textContent = value.toFixed(2);
    updateProcessing('color', { strength: value });
  });

  const alignBtn = document.getElementById('btn-align');
  alignBtn?.addEventListener('click', async () => {
    if (!state.doc?.frames.length) {
      toast('请先导入帧', 'warn');
      return;
    }
    const original = alignBtn.textContent;
    alignBtn.disabled = true;
    alignBtn.textContent = '分析中…';
    try {
      const settings = state.doc.processing.align || {};
      const payload = await api.align({
        projectId: state.doc.id,
        reference: settings.reference || 'first',
        maxShift: settings.maxShift ?? 64,
        confidence: settings.confidence ?? 0.08,
      });
      applyServerDoc(payload.project, 'doc');
      const report = payload.report || {};
      const lines = [
        `参考 ${report.reference} · 补偿 ${report.accepted} 帧 · 跳过 ${report.rejected} 帧`,
        `平均位移 ${report.mean_abs ?? 0}px · 最大 ${report.max_abs ?? 0}px`,
      ];
      lines.push(...(report.warnings || []));
      reportBox('align-result', lines, Boolean(report.warnings?.length));
      toast(`已补偿 ${report.accepted || 0} 帧`);
    } catch (error) {
      toast(error.message, 'bad', 6000);
    } finally {
      alignBtn.disabled = false;
      alignBtn.textContent = original;
    }
  });

  const colorBtn = document.getElementById('btn-color');
  colorBtn?.addEventListener('click', async () => {
    if (!state.doc?.frames.length) {
      toast('请先导入帧', 'warn');
      return;
    }
    const original = colorBtn.textContent;
    colorBtn.disabled = true;
    colorBtn.textContent = '校正中…';
    try {
      const settings = state.doc.processing.color || {};
      const payload = await api.colorMatch({
        projectId: state.doc.id,
        reference: settings.reference || 'median',
        scope: settings.scope || 'subject',
        strength: settings.strength ?? 0.8,
      });
      applyServerDoc(payload.project, 'doc');
      const report = payload.report || {};
      const stats = report.stats || [];
      const clamped = stats.filter((item) => item.clamped).length;
      const lines = [
        `参考 ${report.reference} · 处理 ${stats.length} 帧 · 强度 ${report.strength}`,
        `增益 / 偏移已夹取 ${clamped} 帧；alpha 逐字节保留`,
        ...(report.warnings || []),
      ];
      reportBox('color-result', lines, Boolean(report.warnings?.length));
      toast(`已校正 ${stats.length} 帧`);
    } catch (error) {
      toast(error.message, 'bad', 6000);
    } finally {
      colorBtn.disabled = false;
      colorBtn.textContent = original;
    }
  });

  document.getElementById('btn-color-revert')?.addEventListener('click', async () => {
    if (!state.doc?.frames.length) return;
    try {
      const payload = await api.colorRevert({ projectId: state.doc.id });
      applyServerDoc(payload.project, 'doc');
      const box = document.getElementById('color-result');
      if (box) box.hidden = true;
      toast(`已还原 ${payload.restored || 0} 帧`);
    } catch (error) {
      toast(error.message, 'bad', 6000);
    }
  });
}

export function mountTools() {
  mountLeftPanel();

  document.getElementById('btn-import')?.addEventListener('click', openImport);
  document.getElementById('btn-export')?.addEventListener('click', openExport);
  document.querySelector('[data-action="import"]')?.addEventListener('click', openImport);
  document.addEventListener('anim:import', openImport);
  document.addEventListener('anim:export', openExport);

  subscribe((reason) => {
    if (['project', 'doc', 'frame', 'ui'].includes(reason)) syncLeftPanel();
  });
  syncLeftPanel();
}

export { syncLeftPanel };
