/**
 * 通用工具：DOM 构造、格式化、剪贴板、文件读取等。
 * 说明：前端不使用任何构建工具，本文件被各页面以原生 ES module 方式 import。
 */

/** 转义 HTML 文本，防止提示词/文件名里的尖括号破坏结构。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 创建元素：ce('div', {class:'x', dataset:{a:1}}, [child]) */
export function ce(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function qs(root, selector) {
  return (root || document).querySelector(selector);
}

export function qsa(root, selector) {
  return [...(root || document).querySelectorAll(selector)];
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 毫秒 → "1.8s" / "1m 12s" */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const total = Math.max(0, Number(ms));
  if (total < 1000) return `${Math.round(total)}ms`;
  if (total < 60000) return `${(total / 1000).toFixed(1)}s`;
  const m = Math.floor(total / 60000);
  const s = Math.round((total % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** 数字加千分位；null → "—" */
export function fmtNum(value, digits = 0) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return digits > 0 ? n.toFixed(digits) : Math.round(n).toLocaleString('zh-CN');
}

/** 字节 → 可读大小 */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 毫秒耗时显示（耗时统计专用） */
export function fmtElapsed(ms) {
  if (ms == null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

/** ISO 时间 / "YYYY-MM-DD HH:MM:SS" → 本地 "11-04 01:32" */
export function fmtTime(value) {
  if (!value) return '—';
  let text = String(value);
  // 后端 history 用 "YYYY-MM-DD HH:MM:SS"（空格分隔），补成标准 ISO 供各浏览器解析
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T');
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 复制文本到剪贴板（带降级）。返回 true/false。 */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    // 继续走降级路径
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

/** 触发浏览器下载（同源静态文件）。 */
export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** File/Blob → dataURL */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`读取文件失败：${file?.name || '未知文件'}`));
    reader.readAsDataURL(file);
  });
}

/** 加载图片，返回 HTMLImageElement。 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败（文件可能已失效）'));
    img.src = src;
  });
}

/** 从 dataURL/URL 取图片尺寸。 */
export async function probeImageSize(dataUrl) {
  const img = await loadImage(dataUrl);
  return { width: img.naturalWidth, height: img.naturalHeight, image: img };
}

/** 向上对齐到 multiple 的倍数（默认 32）。 */
export function snapUp(value, multiple = 32) {
  const n = Math.max(1, Math.round(Number(value) || 0));
  return Math.ceil(n / multiple) * multiple;
}

/** 用于把隐藏元素的显示状态切换成 flex 等：hidden → false 时移除 hidden 类。 */
export function setHidden(node, hidden) {
  if (!node) return;
  node.classList.toggle('hidden', Boolean(hidden));
}

/** 小号标签 HTML。 */
export function badge(text, kind = '') {
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`;
}

/** 从错误对象生成中文消息。 */
export function errorMessage(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/**
 * 把对象参数渲染成中文键值对文本（历史详情/参数摘要用）。
 * 只展示常见字段，避免把超长 meta 全量倒出来。
 */
export function summarizeParams(params) {
  if (!params || typeof params !== 'object') return '—';
  const labels = {
    width: '宽度',
    height: '高度',
    steps: '步数',
    cfg: 'CFG',
    seed: '种子',
    batch: '批量',
    sampler: '采样器',
    scheduler: '调度器',
    denoise: '降噪',
    fit: '适配',
    size_mode: '尺寸模式',
    pad_mode: '补边模式',
    rgba: '透明背景',
    ratio: '比例',
    megapixels: '百万像素',
  };
  const lines = [];
  for (const [key, label] of Object.entries(labels)) {
    if (params[key] === undefined || params[key] === null || params[key] === '') continue;
    lines.push(`${label}：${params[key]}`);
  }
  if (params.turbo?.enabled) lines.push(`Turbo：${params.turbo.profile || '开启'}`);
  if (Array.isArray(params.loras) && params.loras.length) {
    lines.push(`LoRA：${params.loras.map((x) => `${x.name} @ ${x.strength}`).join('、')}`);
  }
  if (params.consistency_lora) lines.push(`一致性 LoRA：${params.consistency_lora.name} @ ${params.consistency_lora.strength}`);
  return lines.length ? lines.join('\n') : '—';
}
