/** 通用 UI：图标、DOM、Toast、弹窗、主题与格式化。 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ICONS = {
  chain: '<path d="M9.5 14.5l5-5"/><path d="M7.6 16.4l-1.2 1.2a3.4 3.4 0 01-4.8-4.8l2.6-2.6a3.4 3.4 0 014.8 0"/><path d="M16.4 7.6l1.2-1.2a3.4 3.4 0 014.8 4.8l-2.6 2.6a3.4 3.4 0 01-4.8 0"/>',
  film: '<rect x="3.4" y="5" width="17.2" height="14" rx="2.4"/><path d="M7.4 5v14M16.6 5v14M3.4 9.6h4M3.4 14.4h4M16.6 9.6h4M16.6 14.4h4"/>',
  spark: '<path d="M12 3.6l1.65 4.2 4.2 1.65-4.2 1.65L12 15.3l-1.65-4.2-4.2-1.65 4.2-1.65L12 3.6z"/><path d="M18.2 14.6l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85.85-2.15z"/>',
  archive: '<path d="M4 8.5V19a1 1 0 001 1h14a1 1 0 001-1V8.5"/><rect x="3.2" y="4.2" width="17.6" height="4.3" rx="1.3"/><path d="M9.5 12.2h5"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4.8M7.6 9.2L12 4.8l4.4 4.4"/><path d="M4.5 15.2v3.3a1.5 1.5 0 001.5 1.5h12a1.5 1.5 0 001.5-1.5v-3.3"/>',
  image: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.4 17.4l4.6-4.2 3.4 3 3-2.7 4 3.7"/>',
  play: '<path d="M8.2 5.6v12.8L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4L17.5 7"/><path d="M10 10.5v5.5M14 10.5v5.5"/>',
  chevronLeft: '<path d="M14.5 6.5L9 12l5.5 5.5"/>',
  chevronRight: '<path d="M9.5 6.5L15 12l-5.5 5.5"/>',
  refresh: '<path d="M19.2 12a7.2 7.2 0 11-2.1-5.1"/><path d="M19.4 4.4v4.3h-4.3"/>',
  download: '<path d="M12 4.8v11.4M7.6 11.8L12 16.2l4.4-4.4"/><path d="M4.5 19.2h15"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  alert: '<path d="M12 4.8l8 14.4H4z"/><path d="M12 9.6v4.2M12 16.4v.1"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="M15.4 15.4L20 20"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.8v1.7M12 18.5v1.7M4.9 4.9l1.2 1.2M17.9 17.9l1.2 1.2M3.8 12h1.7M18.5 12h1.7M4.9 19.1l1.2-1.2M17.9 6.1l1.2-1.2"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.2v1.9M12 18.9v1.9M3.2 12h1.9M18.9 12h1.9M5.8 5.8l1.35 1.35M16.85 16.85l1.35 1.35M18.2 5.8l-1.35 1.35M7.15 16.85L5.8 18.2"/>',
  moon: '<path d="M19.2 14.6A7.6 7.6 0 019.4 4.8a7.7 7.7 0 109.8 9.8z"/>',
  auto: '<rect x="3.5" y="5" width="17" height="12.5" rx="2"/><path d="M8 21h8M12 17.5V21"/><path d="M8.2 13.5l2.1-5.2 2.1 5.2M9.1 11.7h2.4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  crop: '<path d="M6.5 3.5v14h14"/><path d="M3.5 6.5h14v14"/>',
  folder: '<path d="M3.8 6.8a1.6 1.6 0 011.6-1.6h4l1.8 2h7.4a1.6 1.6 0 011.6 1.6v8.6a1.6 1.6 0 01-1.6 1.6H5.4a1.6 1.6 0 01-1.6-1.6z"/>',
  info: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5.2M12 8v.1"/>',
  rotate: '<path d="M4.8 10.2A7.4 7.4 0 1112 19.4"/><path d="M4.5 5.6v4.8h4.8"/>',
  layers: '<path d="M12 3.6l8.2 4.2L12 12 3.8 7.8z"/><path d="M3.8 12.2L12 16.4l8.2-4.2"/><path d="M3.8 16.4L12 20.6l8.2-4.2"/>',
  scissors: '<circle cx="7" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/><path d="M9.2 8.6L19 18M9.2 15.4L19 6"/>',
  arrowRight: '<path d="M5 12h13M13.5 6.8L18.7 12l-5.2 5.2"/>',
  wand: '<path d="M4.5 19.5l9.2-9.2M12.3 4.2l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2z"/><path d="M18.4 9.6l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55.55-1.35z"/>',
};

export function icon(name, size = 18) {
  const path = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function toast(message, kind = 'info') {
  const root = $('#toastRoot');
  if (!root) return;
  const node = h('div', { class: `toast ${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : ''}` });
  node.innerHTML = `${icon(kind === 'error' ? 'alert' : kind === 'warn' ? 'alert' : 'check', 15)}<span>${escapeHtml(message)}</span>`;
  root.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity 160ms ease, transform 160ms ease';
    setTimeout(() => node.remove(), 180);
  }, kind === 'error' ? 4200 : 2400);
}

/* ---------------------------------------------------------------- 弹窗 */

export function openModal({ title, sub = '', body, footer = null, narrow = false } = {}) {
  const root = $('#modalRoot');
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dialog = h('div', { class: `modal${narrow ? ' is-narrow' : ''}` });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

  const head = h('div', { class: 'modal-head' });
  head.innerHTML = `
    <div class="modal-head-copy">
      <div class="modal-title">${escapeHtml(title || '')}</div>
      ${sub ? `<div class="modal-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
  const closeBtn = h('button', { class: 'modal-close', type: 'button', title: '关闭' });
  closeBtn.innerHTML = icon('close', 15);
  closeBtn.addEventListener('click', close);
  head.append(closeBtn);

  const bodyEl = h('div', { class: 'modal-body' });
  if (body instanceof Node) bodyEl.append(body);
  else bodyEl.innerHTML = body || '';

  dialog.append(head, bodyEl);
  if (footer) {
    const foot = h('div', { class: 'modal-foot' });
    if (footer instanceof Node) foot.append(footer);
    else foot.innerHTML = footer;
    dialog.append(foot);
  }
  backdrop.append(dialog);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { dialog, body: bodyEl, close };
}

export function confirmDialog({ title, message, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'stack' });
    body.innerHTML = `<p class="mini" style="font-size:12.5px;color:var(--text-2)">${escapeHtml(message || '')}</p>`;
    const footer = h('div', { class: 'row', style: 'width:100%;justify-content:flex-end' });
    const cancel = h('button', { class: 'btn ghost', type: 'button', text: cancelText });
    const confirm = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', text: confirmText });
    footer.append(cancel, confirm);
    const modal = openModal({ title, body, footer, narrow: true });
    cancel.addEventListener('click', () => { modal.close(); resolve(false); });
    confirm.addEventListener('click', () => { modal.close(); resolve(true); });
  });
}

/* ---------------------------------------------------------------- 主题 */

function mainTheme() {
  try {
    const raw = localStorage.getItem('qi21.workbench.settings.v1');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function initialTheme() {
  const stored = localStorage.getItem('stillloop.theme');
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  const main = mainTheme();
  if (main.theme === 'light' || main.theme === 'dark' || main.theme === 'system') return main.theme;
  return 'system';
}

export function applyTheme(mode) {
  const theme = mode === 'light' || mode === 'dark' ? mode : 'system';
  const dark = theme === 'dark'
    || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  const main = mainTheme();
  if (['ochre', 'indigo', 'violet'].includes(main.accent)) root.dataset.accent = main.accent;
  if (['system', 'sans', 'serif', 'mono'].includes(main.font)) root.dataset.font = main.font;
  localStorage.setItem('stillloop.theme', theme);
  return theme;
}

/* ---------------------------------------------------------------- 格式化 */

export function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function debounce(fn, delay = 260) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export const RUN_STATUS = {
  draft: { label: '草稿', tone: '' },
  planning: { label: '分镜中', tone: 'busy' },
  planned: { label: '已分镜', tone: 'info' },
  running: { label: '生成中', tone: 'busy' },
  blocked: { label: '待处理', tone: 'warn' },
  review: { label: '待确认', tone: 'info' },
  approved: { label: '已确认', tone: 'ok' },
  exporting: { label: '导出中', tone: 'busy' },
  done: { label: '已完成', tone: 'ok' },
  canceled: { label: '已取消', tone: '' },
  failed: { label: '失败', tone: 'bad' },
};

export const FRAME_STATUS = {
  pending: { label: '待生成', tone: '' },
  running: { label: '生成中', tone: 'busy' },
  retrying: { label: '重试中', tone: 'warn' },
  accepted: { label: '已通过', tone: 'ok' },
  blocked: { label: '已暂停', tone: 'bad' },
};

export const SOURCE_LABEL = {
  loop: '连续编辑',
  sheet: '宫格切分',
  photos: '照片轨道',
  pipeline: '自动化流水线',
};

export function runStatusBadge(status) {
  const meta = RUN_STATUS[status] || { label: status || '未知', tone: '' };
  return `<span class="badge ${meta.tone}">${escapeHtml(meta.label)}</span>`;
}

export function frameStatusBadge(status) {
  const meta = FRAME_STATUS[status] || { label: status || '未知', tone: '' };
  return `<span class="badge ${meta.tone}">${escapeHtml(meta.label)}</span>`;
}

export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${total.toFixed(total < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function fmtNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

export function fmtClock(text) {
  if (!text) return '';
  const raw = String(text);
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return raw;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

export function downloadFile(url, name = '') {
  const link = document.createElement('a');
  link.href = url;
  if (name) link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/* ---------------------------------------------------------------- 表单 HTML */

export function selectField({ name, label, options, value, hint = '' }) {
  const items = (options || []).map((item) => {
    const id = typeof item === 'string' ? item : item.id;
    const text = typeof item === 'string' ? item : (item.label || item.name || item.id);
    return `<option value="${escapeHtml(id)}"${String(id) === String(value) ? ' selected' : ''}>${escapeHtml(text)}</option>`;
  }).join('');
  return `<label class="field"><span>${escapeHtml(label)}</span>
    <select class="select" name="${escapeHtml(name)}">${items}</select>
    ${hint ? `<span class="mini">${escapeHtml(hint)}</span>` : ''}
  </label>`;
}

export function numberField({ name, label, value, min = 0, max = 9999, step = 1, hint = '' }) {
  return `<label class="field"><span>${escapeHtml(label)}</span>
    <input class="input" type="number" name="${escapeHtml(name)}" value="${escapeHtml(value)}"
      min="${min}" max="${max}" step="${step}">
    ${hint ? `<span class="mini">${escapeHtml(hint)}</span>` : ''}
  </label>`;
}

export function rangeField({ name, label, value, min = 0, max = 1, step = 0.01, unit = '', hint = '' }) {
  return `<label class="field"><span>${escapeHtml(label)} <b data-role="${escapeHtml(name)}Value">${escapeHtml(value)}${escapeHtml(unit)}</b></span>
    <input type="range" name="${escapeHtml(name)}" value="${escapeHtml(value)}" min="${min}" max="${max}" step="${step}"
      data-unit="${escapeHtml(unit)}">
    ${hint ? `<span class="mini">${escapeHtml(hint)}</span>` : ''}
  </label>`;
}

export function checkField({ name, label, checked = false }) {
  return `<label class="check"><input type="checkbox" name="${escapeHtml(name)}"${checked ? ' checked' : ''}> ${escapeHtml(label)}</label>`;
}

export function segmentedField({ name, options, value }) {
  const items = (options || []).map((item) => {
    const id = typeof item === 'string' ? item : item.id;
    const text = typeof item === 'string' ? item : (item.label || item.id);
    return `<button type="button" data-seg="${escapeHtml(name)}" data-value="${escapeHtml(id)}"
      class="${String(id) === String(value) ? 'active' : ''}">${escapeHtml(text)}</button>`;
  }).join('');
  return `<div class="segmented" data-seg-group="${escapeHtml(name)}">${items}</div>`;
}

export function bindSegmented(root, name, onChange) {
  root.querySelectorAll(`[data-seg="${name}"]`).forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll(`[data-seg="${name}"]`).forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      onChange(button.dataset.value);
    });
  });
}

export function readForm(root) {
  const data = {};
  root.querySelectorAll('input[name], select[name], textarea[name]').forEach((input) => {
    if (input.type === 'checkbox') data[input.name] = input.checked;
    else if (input.type === 'number' || input.type === 'range') data[input.name] = Number(input.value);
    else data[input.name] = input.value;
  });
  return data;
}

export function syncRangeLabels(root) {
  root.querySelectorAll('input[type="range"]').forEach((input) => {
    const label = root.querySelector(`[data-role="${input.name}Value"]`);
    if (label) label.textContent = `${input.value}${input.dataset.unit || ''}`;
    input.addEventListener('input', () => {
      if (label) label.textContent = `${input.value}${input.dataset.unit || ''}`;
    });
  });
}
