/** 素材仓库：浏览主项目素材，多选导入为定格轨道。 */
import { api } from '../api.js';
import {
  $$, h, escapeHtml, icon, toast, openModal, fmtClock,
} from '../ui.js';
import { pageHead, defaultsFromOptions } from './common.js';

export class LibraryView {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.state = {
      items: [],
      categories: [],
      selected: [],
      category: '',
      q: '',
      ok: true,
      error: '',
      loading: true,
    };
  }

  mount(root) {
    this.root = root;
    this.render();
    this.load();
  }

  unmount() {}

  render() {
    this.root.innerHTML = `<div class="page page-host">
      ${pageHead({
        kicker: '资产 / 素材仓库',
        title: '素材仓库',
        sub: '读取主项目收藏与上传的素材，多选后按选择顺序直接铺成定格轨道。',
        actions: `
          <button class="btn ghost" type="button" data-action="refresh">${icon('refresh', 15)} 刷新</button>
          <button class="btn primary" type="button" data-action="import" ${this.state.selected.length ? '' : 'disabled'}>
            ${icon('film', 15)} 导入到定格工坊${this.state.selected.length ? ` · ${this.state.selected.length}` : ''}
          </button>
        `,
      })}
      <section class="panel">
        <div class="panel-head"><h2>素材</h2><span class="hint" id="libHint"></span></div>
        <div class="panel-body">
          <div class="library-toolbar">
            <div class="library-search">
              ${icon('search', 14)}
              <input class="input" data-role="q" placeholder="搜索标题、提示词、标签" value="${escapeHtml(this.state.q)}">
            </div>
            <div class="chips" id="libCats"></div>
          </div>
          <div id="libGrid"></div>
        </div>
      </section>
    </div>`;
    this.bind();
    this.renderCategories();
    this.renderGrid();
    this.updateActions();
  }

  updateActions() {
    const button = this.root && this.root.querySelector('[data-action="import"]');
    if (!button) return;
    button.disabled = !this.state.selected.length;
    button.innerHTML = `${icon('film', 15)} 导入到定格工坊${this.state.selected.length ? ` · ${this.state.selected.length}` : ''}`;
  }

  bind() {
    this.root.querySelector('[data-action="refresh"]').addEventListener('click', () => this.load());
    this.root.querySelector('[data-action="import"]').addEventListener('click', () => this.importSelected());
    const search = this.root.querySelector('[data-role="q"]');
    search.addEventListener('input', () => {
      this.state.q = search.value.trim();
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.load(), 300);
    });
  }

  renderCategories() {
    const host = this.root && this.root.querySelector('#libCats');
    if (!host) return;
    const categories = ['', ...this.state.categories];
    host.innerHTML = categories.map((cat) => `<button type="button" class="chip${cat === this.state.category ? ' active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat || '全部')}</button>`).join('');
    $$('[data-cat]', host).forEach((button) => {
      button.addEventListener('click', () => {
        this.state.category = button.dataset.cat;
        this.renderCategories();
        this.load();
      });
    });
  }

  renderGrid() {
    const host = this.root && this.root.querySelector('#libGrid');
    if (!host) return;
    const hint = this.root.querySelector('#libHint');
    if (hint) hint.textContent = this.state.loading ? '读取中…' : `${this.state.items.length} 张素材`;
    if (this.state.error) {
      host.innerHTML = `<div class="notice bad">${icon('alert', 15)}<span>${escapeHtml(this.state.error)}</span></div>`;
      return;
    }
    if (this.state.loading) {
      host.innerHTML = '<div class="empty-hint">正在读取素材仓库…</div>';
      return;
    }
    if (!this.state.items.length) {
      host.innerHTML = `<div class="empty-state">
        <div class="empty-glyph">${icon('archive', 24)}</div>
        <h2>素材仓库还是空的</h2>
        <p>在主项目「素材仓库」里收藏作品或上传图片，这里就会同步出现。</p>
      </div>`;
      return;
    }
    host.innerHTML = `<div class="library-grid" style="max-height:none">
      ${this.state.items.map((item) => {
        const order = this.state.selected.indexOf(item.id);
        return `<div class="library-card${order >= 0 ? ' selected' : ''}" data-id="${escapeHtml(item.id)}">
          <div class="library-thumb"><img src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(item.title)}" loading="lazy"></div>
          ${order >= 0 ? `<span class="library-order">${order + 1}</span>` : ''}
          <span class="library-check">${icon('check', 12)}</span>
          <div class="library-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title || '未命名素材')}</div>
        </div>`;
      }).join('')}
    </div>`;
    $$('.library-card', host).forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const index = this.state.selected.indexOf(id);
        if (index >= 0) this.state.selected.splice(index, 1);
        else this.state.selected.push(id);
        this.renderGrid();
        this.updateActions();
      });
      card.addEventListener('dblclick', () => {
        const item = this.state.items.find((entry) => entry.id === card.dataset.id);
        if (!item) return;
        const body = h('div', { class: 'stack' });
        body.innerHTML = `<div class="inspect-img-wrap" style="margin:0"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.title)}"></div>
          <div class="row wrap"><span class="badge">${item.width}×${item.height}</span><span class="badge">${escapeHtml(item.category)}</span>
          <span class="badge">${escapeHtml(fmtClock(item.createdAt))}</span></div>
          <p class="mini" style="white-space:pre-wrap">${escapeHtml(item.prompt || '（无提示词）')}</p>`;
        openModal({ title: item.title || '素材详情', body });
      });
    });
  }

  async load() {
    this.state.loading = true;
    this.state.error = '';
    this.renderGrid();
    try {
      const data = await api.library({ category: this.state.category, q: this.state.q, limit: 200 });
      if (!data.ok) {
        this.state.error = data.error || '主项目素材仓库不可用';
        this.state.items = [];
      } else {
        this.state.items = data.items || [];
        if (!this.state.categories.length) this.state.categories = data.categories || [];
        this.state.selected = this.state.selected.filter((id) => this.state.items.some((item) => item.id === id));
      }
    } catch (error) {
      this.state.error = error.message || '读取素材仓库失败';
      this.state.items = [];
    } finally {
      this.state.loading = false;
      this.renderCategories();
      this.renderGrid();
      this.updateActions();
    }
  }

  async importSelected() {
    if (!this.state.selected.length) { toast('请先选择素材', 'warn'); return; }
    const settings = defaultsFromOptions(this.ctx.options);
    try {
      const run = await api.fromMaterials(this.state.selected, {
        ...settings,
        width: settings.width,
        height: settings.height,
        timeline: { fps: settings.fps, holds: [] },
        motion: {
          preset: 'both', fps: settings.motionFps, hold: settings.hold,
          jitter: settings.jitter, grain: settings.grain, vignette: settings.vignette,
          color_boil: settings.colorBoil,
        },
        export: { format: 'gif', dither: true, align: false, color_match: false },
      }, [], '素材导入轨道');
      this.ctx.store.set('photos', run.id);
      toast(`已导入 ${run.frameCount} 帧，正在打开定格工坊`, 'success');
      this.ctx.go('photos');
    } catch (error) {
      toast(error.message || '导入失败', 'error');
    }
  }
}
