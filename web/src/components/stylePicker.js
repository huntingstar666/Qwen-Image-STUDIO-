/**
 * 风格选择器（提示词框上方的工具条 + 弹窗）。
 *
 * 设计目标（用户改版要求）：
 * 1. 不再单独占一个「风格库」页面，而是嵌在「文生图 / 图像编辑」的提示词框上方；
 * 2. 四个按钮：✎ 风格 / 🎨 MJ 码图 / ◐ 滤镜 / ⌖ 视角，各自打开紧凑弹窗；
 * 3. 选中项以 chip 显示在提示词框上方，可单独移除；
 * 4. 正文输入框永远保持用户原文，提交时才用 vendor 的 buildNodePrompt 合成预设；
 * 5. 文生图与图像编辑各自持有独立的选择集合（localStorage 按 scope 持久化）；
 * 6. 预览图直接使用目录里的 `/creative-presets/...`、`/mj-styles/...` 绝对路径，
 *    onerror 时隐藏并显示首字占位，不出现破图。
 *
 * vendor 纯逻辑模块全部动态 import（prompt.js / creative.js / imageAngle.js / mjStyles.js），
 * 失败时降级：按钮仍可打开，但合成与插入会给出中文提示。
 */

import { api } from '../api.js';
import { store } from '../store.js';
import { openModal } from './modal.js';
import { toast, toastError, toastSuccess, toastWarn } from './toast.js';
import { escapeHtml } from '../utils.js';

const FAVORITES_KEY = 'qi21.stylePicker.favorites.v1';
const STATE_KEY = (scope) => `qi21.stylePicker.${scope}.v1`;
const PAGE_SIZE = 36;
const DEFAULT_ANGLE = Object.freeze({ azimuth: 0, elevation: 0, zoom: 5, enabled: false });
const KIND_LABELS = { style: '风格', filter: '滤镜', custom: '自定义' };
const MJ_GROUP_LABELS = { all: '全部', char: '角色人物', scene: '场景环境', juwu: '巨物怪兽' };
const FALLBACK_INSERT_MODES = [
  { key: 'style', label: '风格码' },
  { key: 'parameters', label: '参数' },
  { key: 'full', label: '完整提示词' },
  { key: 'vibe', label: '氛围描述' },
];

/* ============================================================
 * vendor 模块加载（模块级缓存，两个选择器实例共享）
 * ============================================================ */
let vendorPromise = null;

function loadVendor() {
  if (!vendorPromise) {
    vendorPromise = (async () => {
      const results = await Promise.allSettled([
        import('/vendor/image-style-kit/src/prompt.js'),
        import('/vendor/image-style-kit/src/creative.js'),
        import('/vendor/image-style-kit/src/imageAngle.js'),
        import('/vendor/image-style-kit/src/mjStyles.js'),
      ]);
      const [promptMod, creativeMod, angleMod, mjMod] = results.map((result) =>
        result.status === 'fulfilled' ? result.value : null,
      );
      const vendor = {
        buildNodePrompt: promptMod?.buildNodePrompt || null,
        composeCreativePrompt: creativeMod?.composeCreativePrompt || null,
        imageAnglePrompt: angleMod?.imageAnglePrompt || null,
        imageAngleDescription: angleMod?.imageAngleDescription || null,
        normalizeImageAngle: angleMod?.normalizeImageAngle || null,
        mjStyleText: mjMod?.mjStyleText || null,
        mjStylePreset: mjMod?.mjStylePreset || null,
        filterMjStyles: mjMod?.filterMjStyles || null,
        mjCategoryGroups: mjMod?.mjCategoryGroups || null,
        mjInsertModes: mjMod?.MJ_INSERT_MODES || null,
      };
      if (!vendor.buildNodePrompt || !vendor.mjStyleText) {
        console.warn(
          '[stylePicker] vendor 模块未完全就绪，合成/插入会降级',
          results.map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok')),
        );
      }
      return vendor;
    })();
  }
  return vendorPromise;
}

/* ============================================================
 * 本地存储
 * ============================================================ */
function loadFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  } catch {
    /* 存储不可用时忽略 */
  }
}

function loadPickerState(scope) {
  const empty = {
    presets: { style: null, filter: null, custom: null },
    angle: { ...DEFAULT_ANGLE },
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY(scope)) || '{}');
    return {
      presets: {
        style: parsed?.presets?.style || null,
        filter: parsed?.presets?.filter || null,
        custom: parsed?.presets?.custom || null,
      },
      angle: { ...DEFAULT_ANGLE, ...(parsed?.angle || {}) },
    };
  } catch {
    return empty;
  }
}

function safePreview(url) {
  return typeof url === 'string' ? url : '';
}

function firstChar(text) {
  return String(text || '?').trim().slice(0, 1) || '?';
}

/** 把目录条目变成 vendor 可接受的 creativePreset 快照。 */
function snapshotPreset(item, kind) {
  return {
    id: item.id,
    kind,
    category: item.category || '',
    name: item.name || item.id,
    description: item.description || '',
    prompt: item.prompt || '',
    prefix: item.prefix,
    preview: item.preview,
    poster: item.poster,
  };
}

export class StylePicker {
  /**
   * @param {HTMLElement} host 提示词框上方的容器
   * @param {{scope?: 't2i'|'edit'}} [options]
   */
  constructor(host, { scope = 't2i' } = {}) {
    this.host = host;
    this.scope = scope;
    this.promptInput = null;
    this.state = loadPickerState(scope);
    this.favorites = loadFavorites();
    this.vendor = null;
    this.catalogPromise = null;
    this.flashTimer = 0;
    this.modal = null;
    this.renderShell();
    this.renderChips();
    this.preload();
  }

  /** 绑定正文提示词 textarea（MJ 码按光标位置插入到这里）。 */
  attachPrompt(textarea) {
    this.promptInput = textarea;
  }

  async preload() {
    try {
      this.vendor = await loadVendor();
    } catch (err) {
      console.warn('[stylePicker] vendor 预加载失败', err);
    }
    // 视角描述依赖 vendor，加载完成后刷新一次 chip 文案
    if (this.state.angle.enabled) this.renderChips();
    // 目录也顺手预取，第一次打开弹窗更快
    this.ensureCatalog().catch(() => {});
  }

  async ensureVendor() {
    if (this.vendor) return this.vendor;
    try {
      this.vendor = await loadVendor();
    } catch (err) {
      console.warn('[stylePicker] vendor 加载失败', err);
      this.vendor = null;
    }
    return this.vendor;
  }

  async ensureCatalog() {
    if (store.state.styles) return store.state.styles;
    if (!this.catalogPromise) {
      this.catalogPromise = api
        .styles()
        .then((data) => {
          store.patchRuntime({ styles: data, stylesError: null });
          return data;
        })
        .catch((err) => {
          this.catalogPromise = null;
          throw err;
        });
    }
    return this.catalogPromise;
  }

  save() {
    try {
      localStorage.setItem(STATE_KEY(this.scope), JSON.stringify(this.state));
    } catch {
      /* ignore */
    }
  }

  /* ============================================================
   * 工具条 + 标签
   * ============================================================ */
  renderShell() {
    this.host.innerHTML = `
      <div class="picker">
        <div class="picker-toolbar">
          <button class="picker-btn" type="button" data-open="style" title="选择风格预设">✎ 风格</button>
          <button class="picker-btn picker-btn-mj" type="button" data-open="mj" title="打开 MJ 码图馆">🎨 MJ 码图</button>
          <button class="picker-btn" type="button" data-open="filter" title="选择滤镜">◐ 滤镜</button>
          <button class="picker-btn" type="button" data-open="angle" title="设置相机视角">⌖ 视角</button>
          <span class="spacer"></span>
          <span class="picker-count" data-ref="count" title="当前已选预设与视角">◑ 已选 0</span>
        </div>
        <div class="picker-chips hidden" data-ref="chips"></div>
      </div>`;
    this.refs = {
      count: this.host.querySelector('[data-ref="count"]'),
      chips: this.host.querySelector('[data-ref="chips"]'),
    };
    this.host.querySelectorAll('[data-open]').forEach((button) => {
      button.addEventListener('click', () => this.open(button.dataset.open));
    });
  }

  selectionEntries() {
    const entries = [];
    for (const slot of ['style', 'filter', 'custom']) {
      const preset = this.state.presets[slot];
      if (preset) {
        entries.push({
          key: slot,
          label: preset.name || KIND_LABELS[slot] || slot,
          kind: slot,
        });
      }
    }
    if (this.state.angle.enabled) {
      entries.push({ key: 'angle', label: this.describeAngle(), kind: 'angle' });
    }
    return entries;
  }

  renderChips() {
    const entries = this.selectionEntries();
    this.refs.count.textContent = `◑ 已选 ${entries.length}`;
    this.refs.chips.classList.toggle('hidden', !entries.length);
    this.refs.chips.innerHTML = entries
      .map(
        (entry) => `
        <span class="pick-chip kind-${entry.kind}">
          <span class="pick-chip-label">${escapeHtml(entry.label)}</span>
          <button class="pick-chip-x" type="button" data-remove="${entry.key}" title="移除">×</button>
        </span>`,
      )
      .join('');
    this.refs.chips.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => this.removeSlot(button.dataset.remove));
    });
  }

  removeSlot(key) {
    if (key === 'angle') {
      this.state.angle = { ...DEFAULT_ANGLE };
    } else {
      this.state.presets[key] = null;
    }
    this.save();
    this.renderChips();
  }

  describeAngle() {
    const angle = this.state.angle;
    if (this.vendor?.imageAngleDescription) {
      try {
        const desc = this.vendor.imageAngleDescription(angle);
        return `${desc.direction} · ${desc.elevation} · ${desc.distance}`;
      } catch {
        /* 落到数值描述 */
      }
    }
    return `${Math.round(angle.azimuth)}° · ${Math.round(angle.elevation)}° · ${Number(angle.zoom).toFixed(1)}`;
  }

  open(kind) {
    if (kind === 'style') this.openStyleModal('style');
    else if (kind === 'filter') this.openStyleModal('filter');
    else if (kind === 'mj') this.openMjModal();
    else if (kind === 'angle') this.openAngleModal();
  }

  flashCount(text) {
    if (!this.refs?.count) return;
    clearTimeout(this.flashTimer);
    this.refs.count.textContent = text;
    this.flashTimer = setTimeout(() => this.renderChips(), 2200);
  }

  /* ============================================================
   * 提示词合成 / 插入
   * ============================================================ */
  isReady() {
    return Boolean(this.vendor?.buildNodePrompt);
  }

  hasSelection() {
    return this.selectionEntries().length > 0;
  }

  getMeta() {
    const presets = {};
    for (const slot of ['style', 'filter', 'custom']) {
      if (this.state.presets[slot]) presets[slot] = this.state.presets[slot];
    }
    const angle = this.state.angle.enabled
      ? {
          azimuth: Number(this.state.angle.azimuth) || 0,
          elevation: Number(this.state.angle.elevation) || 0,
          zoom: Number(this.state.angle.zoom) || 5,
        }
      : null;
    return { creativePresets: presets, imageAngle: angle };
  }

  /** 已选风格 / 滤镜 / 视角的文本摘要，供润色模型理解最终会拼进去的参数。 */
  styleHint() {
    const { creativePresets, imageAngle } = this.getMeta();
    const parts = [];
    for (const [slot, preset] of Object.entries(creativePresets)) {
      const label = preset.name || KIND_LABELS[slot] || slot;
      const detail = preset.description || preset.prompt || '';
      parts.push(`${KIND_LABELS[slot] || slot}「${label}」${detail ? `：${detail}` : ''}`);
    }
    if (imageAngle) parts.push(`视角「${this.describeAngle()}」`);
    if (!parts.length) return '';
    return `已选风格参数：${parts.join('；')}。这些参数会在提交时由前端拼接进提示词，改写结果只写画面与主体描述，不要重复这些风格词。`;
  }

  /** 提交时调用：正文原文 + 预设合成；vendor 未就绪时原样返回。 */
  composePrompt(rawPrompt) {
    const prompt = String(rawPrompt ?? '');
    const { creativePresets, imageAngle } = this.getMeta();
    if (!Object.keys(creativePresets).length && !imageAngle) return prompt;
    if (!this.vendor?.buildNodePrompt) return prompt;
    try {
      return this.vendor.buildNodePrompt(prompt, {
        creativePresets,
        type: 'Image',
        imageAngle,
      });
    } catch (err) {
      console.warn('[stylePicker] buildNodePrompt 失败', err);
      return prompt;
    }
  }

  /** 在正文光标位置插入文本；没有绑定 textarea 时退化为追加到末尾。 */
  insertText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    const textarea = this.promptInput;
    if (!textarea) return false;
    // contenteditable 输入框自行处理光标，避免依赖 textarea 的 selectionStart
    if (typeof textarea.insertPromptText === 'function') return textarea.insertPromptText(value);
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const gapBefore = before && !/\n$/.test(before) ? '\n' : '';
    const gapAfter = after && !/^\n/.test(after) ? '\n' : '';
    const next = `${before}${gapBefore}${value}${gapAfter}${after}`;
    textarea.value = next;
    const caret = before.length + gapBefore.length + value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    try {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
    } catch {
      /* ignore */
    }
    return true;
  }

  /* ============================================================
   * 风格 / 滤镜 / 自定义 弹窗
   * ============================================================ */
  async openStyleModal(initialTab = 'style') {
    const vendor = await this.ensureVendor();
    let catalog;
    try {
      catalog = await this.ensureCatalog();
    } catch (err) {
      toastError(err, '风格目录加载失败');
      return;
    }
    void vendor;
    const picker = this;

    const content = document.createElement('div');
    content.className = 'pk-content';
    content.innerHTML = `
      <div class="pk-tabs" data-ref="tabs"></div>
      <div class="pk-library" data-ref="library">
        <div class="pk-toolbar-row">
          <input class="input" data-ref="search" placeholder="搜索风格名称、分类或描述" />
          <span class="pk-result-count" data-ref="resultCount"></span>
        </div>
        <div class="pk-cats" data-ref="cats"></div>
        <div class="pk-grid" data-ref="grid"></div>
        <div class="pk-foot-note" data-ref="foot"></div>
      </div>
      <div class="pk-custom hidden" data-ref="custom">
        <div class="field">
          <span class="field-label">自定义前缀 <span class="tag-hint">加在正文之前</span></span>
          <textarea class="textarea" rows="3" data-ref="customPrefix" spellcheck="false" placeholder="例如：电影感，35mm 胶片质感，冷色调"></textarea>
        </div>
        <div class="field">
          <span class="field-label">自定义描述 <span class="tag-hint">加在正文之后</span></span>
          <textarea class="textarea" rows="3" data-ref="customPrompt" spellcheck="false" placeholder="例如：柔和的逆光，浅景深，细腻颗粒"></textarea>
        </div>
        <div class="field-hint">自定义内容只用于当前页面（文生图 / 图像编辑各自独立），并会作为一个可移除的 chip 显示。</div>
        <div class="pk-custom-actions">
          <button class="btn ghost" type="button" data-ref="customClear">清除自定义</button>
          <button class="btn primary" type="button" data-ref="customApply">应用自定义</button>
        </div>
      </div>`;

    const modal = openModal({
      title: '选择风格',
      subtitle: '选中后以标签显示，提交时自动合成到提示词（正文保持原文）',
      size: 'lg',
      dialogClass: 'picker-modal',
      hideFooter: true,
      content,
    });
    this.modal = modal;
    const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
    const tabsEl = ref('tabs');
    const libraryEl = ref('library');
    const customEl = ref('custom');
    const searchEl = ref('search');
    const catsEl = ref('cats');
    const gridEl = ref('grid');
    const resultCountEl = ref('resultCount');
    const footEl = ref('foot');

    const draft = { tab: initialTab, query: '', category: '全部' };
    const allCreative = Array.isArray(catalog.creative) ? catalog.creative : [];
    const TABS = [
      ['style', '风格'],
      ['filter', '滤镜'],
      ['custom', '自定义'],
    ];

    const kindItems = (kind) => allCreative.filter((item) => item.kind === kind);
    const currentKind = () => (draft.tab === 'custom' ? 'style' : draft.tab);

    function renderTabs() {
      tabsEl.innerHTML = TABS.map(
        ([key, label]) =>
          `<button class="pk-tab ${draft.tab === key ? 'active' : ''}" type="button" data-tab="${key}">
            ${label}
            <span class="pk-tab-count">${key === 'custom' ? (picker.state.presets.custom ? '已设置' : '') : kindItems(key).length}</span>
          </button>`,
      ).join('');
      tabsEl.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          const next = button.dataset.tab;
          if (draft.tab === next) return;
          draft.tab = next;
          draft.query = '';
          draft.category = '全部';
          searchEl.value = '';
          renderTabs();
          renderBody();
        });
      });
    }

    function renderCategories() {
      if (draft.tab === 'custom') {
        catsEl.classList.add('hidden');
        return;
      }
      catsEl.classList.remove('hidden');
      const items = kindItems(currentKind());
      const categories = [...new Set(items.map((item) => item.category).filter(Boolean))];
      const chips = [
        { id: '全部', label: '全部' },
        { id: '收藏', label: '收藏' },
        ...categories.map((category) => ({ id: category, label: category })),
      ];
      if (!chips.some((chip) => chip.id === draft.category)) draft.category = '全部';
      catsEl.innerHTML = chips
        .map(
          (chip) =>
            `<button class="pk-cat ${draft.category === chip.id ? 'active' : ''}" type="button" data-cat="${escapeHtml(chip.id)}">${escapeHtml(chip.label)}</button>`,
        )
        .join('');
      catsEl.querySelectorAll('[data-cat]').forEach((button) => {
        button.addEventListener('click', () => {
          draft.category = button.dataset.cat;
          renderCategories();
          renderGrid();
        });
      });
    }

    function filteredItems() {
      const query = draft.query.trim().toLowerCase();
      return kindItems(currentKind()).filter((item) => {
        if (draft.category === '收藏') {
          if (!picker.favorites.has(item.id)) return false;
        } else if (draft.category !== '全部' && item.category !== draft.category) {
          return false;
        }
        if (!query) return true;
        return [item.name, item.category, item.description, item.prompt]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query);
      });
    }

    function cardVisibleState(item) {
      if (!item) return false;
      const slot = currentKind();
      return picker.state.presets[slot]?.id === item.id;
    }

    function renderGrid() {
      if (draft.tab === 'custom') return;
      const items = filteredItems();
      resultCountEl.textContent = `${items.length} 个`;
      footEl.textContent = `${items.length} 个预设 · 收藏保存在本机 · 再次点击可取消选择`;
      if (!items.length) {
        gridEl.innerHTML = '<div class="pk-empty">没有匹配的预设，换个分类或关键词试试。</div>';
        return;
      }
      gridEl.innerHTML = items
        .map(
          (item) => `
          <div class="pk-card ${cardVisibleState(item) ? 'selected' : ''}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0"
            title="${escapeHtml(item.description || item.name || item.id)}">
            <div class="pk-thumb">
              ${safePreview(item.preview) ? `<img src="${escapeHtml(safePreview(item.preview))}" alt="" loading="lazy" />` : `<span class="pk-thumb-fallback">${escapeHtml(firstChar(item.name))}</span>`}
            </div>
            <button class="pk-star ${picker.favorites.has(item.id) ? 'active' : ''}" type="button" data-fav="${escapeHtml(item.id)}" title="${picker.favorites.has(item.id) ? '取消收藏' : '收藏'}">★</button>
            <div class="pk-card-foot">
              <span class="pk-name">${escapeHtml(item.name || item.id)}</span>
              <span class="pk-cat-name">${escapeHtml(item.category || '')}</span>
            </div>
          </div>`,
        )
        .join('');

      // 预览图加载失败时隐藏图片并显示首字占位（资源未随包提供也安全）
      for (const image of gridEl.querySelectorAll('.pk-thumb img')) {
        image.addEventListener('error', () => {
          const thumb = image.closest('.pk-thumb');
          const name = image.closest('.pk-card')?.querySelector('.pk-name')?.textContent || '?';
          image.remove();
          if (thumb && !thumb.querySelector('.pk-thumb-fallback')) {
            const span = document.createElement('span');
            span.className = 'pk-thumb-fallback';
            span.textContent = firstChar(name);
            thumb.append(span);
          }
        });
      }

      gridEl.querySelectorAll('.pk-card').forEach((card) => {
        const item = items.find((entry) => entry.id === card.dataset.id);
        if (!item) return;
        const select = () => {
          picker.togglePreset(item, currentKind());
          for (const node of gridEl.querySelectorAll('.pk-card')) {
            node.classList.toggle('selected', cardVisibleState(items.find((entry) => entry.id === node.dataset.id)));
          }
        };
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-fav]')) return;
          select();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select();
          }
        });
      });

      gridEl.querySelectorAll('[data-fav]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          picker.toggleFavorite(button.dataset.fav);
          button.classList.toggle('active', picker.favorites.has(button.dataset.fav));
          button.title = picker.favorites.has(button.dataset.fav) ? '取消收藏' : '收藏';
          if (draft.category === '收藏') renderGrid();
        });
      });
    }

    function renderCustom() {
      const preset = picker.state.presets.custom;
      ref('customPrefix').value = preset?.prefix || '';
      ref('customPrompt').value = preset?.prompt || '';
    }

    function renderBody() {
      const isCustom = draft.tab === 'custom';
      libraryEl.classList.toggle('hidden', isCustom);
      customEl.classList.toggle('hidden', !isCustom);
      if (isCustom) {
        renderCustom();
        return;
      }
      if (draft.category === '全部' || draft.category === '收藏') searchEl.placeholder = '搜索风格名称、分类或描述';
      renderCategories();
      renderGrid();
    }

    searchEl.addEventListener(
      'input',
      debounce(() => {
        draft.query = searchEl.value;
        renderGrid();
      }, 160),
    );

    ref('customApply').addEventListener('click', () => {
      const prefix = ref('customPrefix').value.trim();
      const prompt = ref('customPrompt').value.trim();
      if (!prefix && !prompt) {
        this.state.presets.custom = null;
        this.save();
        this.renderChips();
        toast('已清除自定义风格', 'info', { timeout: 2000 });
        modal.close();
        return;
      }
      this.state.presets.custom = {
        id: `custom-${this.scope}`,
        kind: 'style',
        category: '自定义',
        name: '自定义风格',
        description: prompt,
        prompt,
        prefix,
      };
      this.save();
      this.renderChips();
      toastSuccess('已应用自定义风格');
      modal.close();
    });
    ref('customClear').addEventListener('click', () => {
      this.state.presets.custom = null;
      this.save();
      this.renderChips();
      ref('customPrefix').value = '';
      ref('customPrompt').value = '';
      toast('已清除自定义风格', 'info', { timeout: 2000 });
      renderTabs();
    });

    renderTabs();
    renderBody();
  }

  togglePreset(item, slot) {
    const current = this.state.presets[slot];
    if (current?.id === item.id) {
      this.state.presets[slot] = null;
    } else {
      this.state.presets[slot] = snapshotPreset(item, slot);
    }
    this.save();
    this.renderChips();
  }

  toggleFavorite(id) {
    if (this.favorites.has(id)) this.favorites.delete(id);
    else this.favorites.add(id);
    saveFavorites(this.favorites);
  }

  /* ============================================================
   * MJ 码图馆弹窗（黄黑配色）
   * ============================================================ */
  async openMjModal() {
    const vendor = await this.ensureVendor();
    let catalog;
    try {
      catalog = await this.ensureCatalog();
    } catch (err) {
      toastError(err, 'MJ 码图目录加载失败');
      return;
    }

    const content = document.createElement('div');
    content.className = 'mj-pk';
    const picker = this;
    content.innerHTML = `
      <div class="mj-pk-top">
        <input class="input mj-pk-search" data-ref="search" placeholder="搜索名称、分类、MJ 码或氛围描述" spellcheck="false" />
        <span class="mj-pk-count" data-ref="count"></span>
      </div>
      <div class="mj-pk-groups" data-ref="groups"></div>
      <div class="mj-pk-body">
        <aside class="mj-pk-tree" data-ref="tree"></aside>
        <div class="mj-pk-main">
          <div class="mj-pk-grid" data-ref="grid"></div>
          <div class="mj-pk-pager" data-ref="pager"></div>
        </div>
      </div>
      <div class="mj-pk-foot">
        <span class="mj-pk-tip">点击卡片把文本插入提示词光标处</span>
        <label class="mj-pk-mode">插入模式
          <select data-ref="mode"></select>
        </label>
      </div>`;

    const modal = openModal({
      title: 'MJ 码图馆',
      subtitle: '按效果挑选风格，在正文光标处插入',
      size: 'lg',
      dialogClass: 'picker-modal mj-picker-modal',
      hideFooter: true,
      content,
    });
    this.modal = modal;
    const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
    const searchEl = ref('search');
    const countEl = ref('count');
    const groupsEl = ref('groups');
    const treeEl = ref('tree');
    const gridEl = ref('grid');
    const pagerEl = ref('pager');
    const modeEl = ref('mode');

    const items = Array.isArray(catalog.mj) ? catalog.mj : [];
    const categoriesGroups = Array.isArray(vendor?.mjCategoryGroups) && vendor.mjCategoryGroups.length
      ? vendor.mjCategoryGroups
      : buildFallbackMjGroups(items);
    const modes = normalizeInsertModes(catalog.insertModes);
    const state = { group: 'all', category: '全部', query: '', page: 0, mode: 'style' };
    const expanded = new Set([categoriesGroups[0]?.name].filter(Boolean));

    function normalizeMode(key) {
      if (key === 'all-codes') return key;
      if (modes.some((mode) => mode.key === key)) return key;
      return modes[0]?.key || 'style';
    }

    function groupItems(group) {
      return items.filter((item) => (item.group || 'other') === group);
    }

    function renderGroups() {
      const groupIds = [...new Set(items.map((item) => item.group || 'other'))];
      const groups = [{ id: 'all', label: MJ_GROUP_LABELS.all, count: items.length }].concat(
        groupIds.map((id) => ({
          id,
          label: MJ_GROUP_LABELS[id] || id,
          count: groupItems(id).length,
        })),
      );
      groupsEl.innerHTML = groups
        .map(
          (group) =>
            `<button class="mj-pk-pill ${state.group === group.id ? 'active' : ''}" type="button" data-group="${escapeHtml(group.id)}">
              ${escapeHtml(group.label)}<span>${group.count}</span>
            </button>`,
        )
        .join('');
      groupsEl.querySelectorAll('[data-group]').forEach((button) => {
        button.addEventListener('click', () => {
          state.group = button.dataset.group;
          state.category = '全部';
          state.page = 0;
          renderGroups();
          renderTree();
          renderGrid();
        });
      });
    }

    function renderTree() {
      treeEl.innerHTML = `
        <div class="mj-tree-title">按风格浏览</div>
        <button class="mj-tree-all ${state.category === '全部' ? 'active' : ''}" type="button" data-cat="全部">全部风格</button>
        ${categoriesGroups
          .map(
            (group) => `
            <div class="mj-tree-group">
              <button class="mj-tree-head ${expanded.has(group.name) ? 'open' : ''}" type="button" data-group-name="${escapeHtml(group.name)}">
                <span class="mj-tree-arrow">▸</span>${escapeHtml(group.name)}
              </button>
              <div class="mj-tree-cats ${expanded.has(group.name) ? '' : 'hidden'}">
                ${(group.categories || [])
                  .map(
                    (category) =>
                      `<button class="mj-tree-cat ${state.category === category ? 'active' : ''}" type="button" data-cat="${escapeHtml(category)}">${escapeHtml(category)}</button>`,
                  )
                  .join('')}
              </div>
            </div>`,
          )
          .join('')}`;
      treeEl.querySelectorAll('[data-group-name]').forEach((button) => {
        button.addEventListener('click', () => {
          const name = button.dataset.groupName;
          if (expanded.has(name)) expanded.delete(name);
          else expanded.add(name);
          renderTree();
        });
      });
      treeEl.querySelectorAll('[data-cat]').forEach((button) => {
        button.addEventListener('click', () => {
          // 从分类树里选分类时，分组 pill 回到「全部」，避免两个筛选叠加导致空列表
          state.group = 'all';
          state.category = button.dataset.cat;
          state.page = 0;
          renderGroups();
          renderTree();
          renderGrid();
        });
      });
    }

    function filteredItems() {
      if (vendor?.filterMjStyles) {
        try {
          const result = vendor.filterMjStyles(items, state.group, state.category, state.query, 'all');
          if (Array.isArray(result)) return result;
        } catch (err) {
          console.warn('[stylePicker] filterMjStyles 失败，使用基础过滤', err);
        }
      }
      const query = state.query.trim().toLowerCase();
      return items.filter((item) => {
        if (state.group !== 'all' && (item.group || 'other') !== state.group) return false;
        if (state.category !== '全部' && item.category !== state.category) return false;
        if (!query) return true;
        return [item.id, item.name, item.category, item.codes, item.vibe, item.medium, item.prompt]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query);
      });
    }

    function mjText(item) {
      if (state.mode === 'all-codes') {
        const text = [item.codes, item.parameters].filter(Boolean).join('\n');
        return text.replace(/(?:^|\s)--preview(?=\s|$)/gi, '').trim();
      }
      if (vendor?.mjStyleText) {
        try {
          return vendor.mjStyleText(item, state.mode);
        } catch (err) {
          console.warn('[stylePicker] mjStyleText 失败', err);
        }
      }
      const text =
        state.mode === 'full'
          ? item.prompt
          : state.mode === 'vibe'
            ? item.vibe
            : [item.vibe, state.mode === 'parameters' ? item.parameters : item.codes].filter(Boolean).join('\n');
      return String(text || '').trim();
    }

    function renderGrid() {
      const filtered = filteredItems();
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages - 1);
      const pageItems = filtered.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
      countEl.textContent = `共 ${filtered.length} 条`;
      if (!filtered.length) {
        gridEl.innerHTML = '<div class="mj-pk-empty">没有匹配的码图，换个关键词或分类试试。</div>';
        pagerEl.innerHTML = '';
        return;
      }
      gridEl.innerHTML = pageItems
        .map(
          (item) => `
          <div class="mj-pk-card" data-id="${escapeHtml(String(item.id))}" role="button" tabindex="0"
            title="${escapeHtml(item.vibe || item.prompt || item.name || '')}">
            <div class="mj-pk-thumb">
              ${safePreview(item.thumbnail) ? `<img src="${escapeHtml(safePreview(item.thumbnail))}" alt="" loading="lazy" />` : `<span class="mj-pk-thumb-fallback">${escapeHtml(firstChar(item.name))}</span>`}
            </div>
            <div class="mj-pk-name">${escapeHtml(item.name || item.id)}</div>
            <div class="mj-pk-meta">
              <span class="mj-badge">${item.mixed ? '混合码' : '纯风格码'}</span>
              <span>${escapeHtml(item.category || '')}</span>
            </div>
          </div>`,
        )
        .join('');

      for (const image of gridEl.querySelectorAll('.mj-pk-thumb img')) {
        image.addEventListener('error', () => {
          const thumb = image.closest('.mj-pk-thumb');
          const name = image.closest('.mj-pk-card')?.querySelector('.mj-pk-name')?.textContent || '?';
          image.remove();
          if (thumb && !thumb.querySelector('.mj-pk-thumb-fallback')) {
            const span = document.createElement('span');
            span.className = 'mj-pk-thumb-fallback';
            span.textContent = firstChar(name);
            thumb.append(span);
          }
        });
      }

      gridEl.querySelectorAll('.mj-pk-card').forEach((card) => {
        const item = pageItems.find((entry) => String(entry.id) === card.dataset.id);
        if (!item) return;
        const insert = () => {
          const text = mjText(item);
          if (!text) {
            toastWarn('当前插入模式下没有可用文本');
            return;
          }
          if (!picker.insertText(text)) {
            toastWarn('没有找到提示词输入框，无法插入');
            return;
          }
          toastSuccess(`已插入 MJ 码「${item.name || item.id}」`);
          picker.flashCount('已插入 MJ 码 ✓');
        };
        card.addEventListener('click', insert);
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            insert();
          }
        });
      });

      pagerEl.innerHTML = `
        <button class="mj-pager-btn" type="button" data-page="${state.page - 1}" ${state.page <= 0 ? 'disabled' : ''}>上一页</button>
        <span class="mj-pager-info">${state.page + 1} / ${pages}</span>
        <button class="mj-pager-btn" type="button" data-page="${state.page + 1}" ${state.page >= pages - 1 ? 'disabled' : ''}>下一页</button>`;
      pagerEl.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => {
          state.page = Number(button.dataset.page);
          renderGrid();
          gridEl.scrollTop = 0;
        });
      });
    }

    function renderModes() {
      state.mode = normalizeMode(state.mode);
      modeEl.innerHTML = [{ key: 'all-codes', label: '全部代码' }, ...modes]
        .map((mode) => `<option value="${escapeHtml(mode.key)}">${escapeHtml(mode.label)}</option>`)
        .join('');
      modeEl.value = state.mode;
    }

    searchEl.addEventListener(
      'input',
      debounce(() => {
        state.query = searchEl.value;
        state.page = 0;
        renderGrid();
      }, 160),
    );
    modeEl.addEventListener('change', () => {
      state.mode = modeEl.value;
    });

    renderGroups();
    renderTree();
    renderModes();
    renderGrid();
  }

  /* ============================================================
   * 视角弹窗
   * ============================================================ */
  async openAngleModal() {
    await this.ensureVendor();
    const picker = this;
    const draft = { ...DEFAULT_ANGLE, ...this.state.angle };
    const content = document.createElement('div');
    content.className = 'angle-pk';
    content.innerHTML = `
      <div class="angle-grid">
        <div class="angle-row">
          <div class="angle-label"><span>水平环绕 azimuth</span><span class="mono" data-ref="azimuthVal">0°</span></div>
          <input class="range" type="range" min="0" max="360" step="1" data-ref="azimuth" />
        </div>
        <div class="angle-row">
          <div class="angle-label"><span>俯仰 elevation</span><span class="mono" data-ref="elevationVal">0°</span></div>
          <input class="range" type="range" min="-30" max="60" step="1" data-ref="elevation" />
        </div>
        <div class="angle-row">
          <div class="angle-label"><span>取景距离 zoom</span><span class="mono" data-ref="zoomVal">5.0 / 10</span></div>
          <input class="range" type="range" min="0" max="10" step="0.1" data-ref="zoom" />
        </div>
      </div>
      <div class="angle-desc" data-ref="desc"></div>
      <div class="field-hint">0° 正面 · 90° 主体右侧 · 180° 背面 · 270° 主体左侧；正值抬高机位向下看，负值降低机位向上看。</div>
      <div class="angle-pk-actions">
        <button class="btn ghost" type="button" data-ref="angleClear">清除视角</button>
        <span class="spacer"></span>
        <button class="btn ghost" type="button" data-ref="angleReset">重置</button>
        <button class="btn primary" type="button" data-ref="angleApply">应用视角</button>
      </div>`;

    const modal = openModal({
      title: '视角控制',
      subtitle: '按相机参数改写观察方向；应用后以标签显示在提示词上方',
      dialogClass: 'angle-picker-modal',
      hideFooter: true,
      content,
    });
    this.modal = modal;
    const ref = (name) => content.querySelector(`[data-ref="${name}"]`);
    const azimuthEl = ref('azimuth');
    const elevationEl = ref('elevation');
    const zoomEl = ref('zoom');
    const descEl = ref('desc');

    function sync() {
      azimuthEl.value = String(draft.azimuth);
      elevationEl.value = String(draft.elevation);
      zoomEl.value = String(draft.zoom);
      ref('azimuthVal').textContent = `${Math.round(draft.azimuth)}°`;
      ref('elevationVal').textContent = `${Math.round(draft.elevation)}°`;
      ref('zoomVal').textContent = `${Number(draft.zoom).toFixed(1)} / 10`;
      let description = null;
      if (picker.vendor?.imageAngleDescription) {
        try {
          description = picker.vendor.imageAngleDescription(draft);
        } catch {
          description = null;
        }
      }
      if (description) {
        descEl.innerHTML = `
          <span>方向 <b>${escapeHtml(description.direction)}</b></span>
          <span>机位 <b>${escapeHtml(description.elevation)}</b></span>
          <span>景别 <b>${escapeHtml(description.distance)}</b></span>`;
      } else {
        descEl.innerHTML = `<span class="muted">视角模块未就绪：水平 ${Math.round(draft.azimuth)}° · 俯仰 ${Math.round(draft.elevation)}° · 距离 ${Number(draft.zoom).toFixed(1)}</span>`;
      }
    }

    azimuthEl.addEventListener('input', () => {
      draft.azimuth = Number(azimuthEl.value);
      sync();
    });
    elevationEl.addEventListener('input', () => {
      draft.elevation = Number(elevationEl.value);
      sync();
    });
    zoomEl.addEventListener('input', () => {
      draft.zoom = Number(zoomEl.value);
      sync();
    });

    ref('angleReset').addEventListener('click', () => {
      Object.assign(draft, { azimuth: 0, elevation: 0, zoom: 5 });
      sync();
    });
    ref('angleClear').addEventListener('click', () => {
      this.state.angle = { ...DEFAULT_ANGLE };
      this.save();
      this.renderChips();
      toast('已移除视角', 'info', { timeout: 2000 });
      modal.close();
    });
    ref('angleApply').addEventListener('click', () => {
      this.state.angle = {
        azimuth: Math.round(draft.azimuth) % 360,
        elevation: Math.max(-30, Math.min(60, Math.round(draft.elevation))),
        zoom: Math.round(draft.zoom * 10) / 10,
        enabled: true,
      };
      this.save();
      this.renderChips();
      toastSuccess(`已应用视角：${this.describeAngle()}`);
      modal.close();
    });

    sync();
  }
}

/* ============================================================
 * 工具
 * ============================================================ */
function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function normalizeInsertModes(raw) {
  const normalized = (Array.isArray(raw) ? raw : [])
    .map((item) => {
      if (Array.isArray(item)) return { key: item[0], label: item[1] };
      if (item && typeof item === 'object') {
        const key = item.key ?? item.value ?? item.id;
        return key ? { key, label: item.label ?? item.name ?? key } : null;
      }
      return null;
    })
    .filter(Boolean);
  return normalized.length ? normalized : FALLBACK_INSERT_MODES;
}

function buildFallbackMjGroups(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
  }
  return [...groups.keys()].map((name) => ({ name, categories: [] }));
}

/** 工厂函数：页面里 createStylePicker(host, { scope }) 即可。 */
export function createStylePicker(host, options = {}) {
  return new StylePicker(host, options);
}

export default createStylePicker;
