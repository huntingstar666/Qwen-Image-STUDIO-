/** 我的项目：所有 run 的封面、状态与继续入口。 */
import { api } from '../api.js';
import {
  $$, escapeHtml, icon, toast, runStatusBadge, SOURCE_LABEL, fmtClock,
} from '../ui.js';
import { pageHead } from './common.js';

const SOURCE_ROUTE = { loop: 'chain', photos: 'photos', sheet: 'pipeline', pipeline: 'pipeline' };

export class ProjectsView {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = null;
    this.state = { items: [], filter: '', loading: true, error: '' };
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
        kicker: '资产 / 我的项目',
        title: '我的项目',
        sub: '所有照片轨道、流水线与连续编辑 run。打开后可以继续精修、审核或导出。',
        actions: `<button class="btn ghost" type="button" data-action="refresh">${icon('refresh', 15)} 刷新</button>`,
      })}
      <section class="panel">
        <div class="panel-head">
          <h2>项目</h2>
          <span class="hint" id="projectCount"></span>
          <div class="spacer"></div>
          <div class="chips" id="projectFilters"></div>
        </div>
        <div class="panel-body" id="projectBody"></div>
      </section>
    </div>`;
    this.bind();
    this.renderFilters();
    this.renderList();
  }

  bind() {
    this.root.querySelector('[data-action="refresh"]').addEventListener('click', () => this.load());
  }

  renderFilters() {
    const host = this.root && this.root.querySelector('#projectFilters');
    if (!host) return;
    const filters = [['', '全部'], ['photos', '照片轨道'], ['pipeline', '流水线'], ['sheet', '宫格切分'], ['loop', '连续编辑']];
    host.innerHTML = filters.map(([id, label]) => `<button type="button" class="chip${id === this.state.filter ? ' active' : ''}" data-filter="${id}">${label}</button>`).join('');
    $$('[data-filter]', host).forEach((button) => {
      button.addEventListener('click', () => {
        this.state.filter = button.dataset.filter;
        this.renderFilters();
        this.renderList();
      });
    });
  }

  renderList() {
    const host = this.root && this.root.querySelector('#projectBody');
    if (!host) return;
    if (this.state.error) {
      const count = this.root.querySelector('#projectCount');
      if (count) count.textContent = '';
      host.innerHTML = `<div class="notice bad">${icon('alert', 15)}<span>${escapeHtml(this.state.error)}</span></div>`;
      return;
    }
    if (this.state.loading) {
      const count = this.root.querySelector('#projectCount');
      if (count) count.textContent = '';
      host.innerHTML = '<div class="empty-hint">正在读取项目…</div>';
      return;
    }
    const items = this.state.items.filter((item) => !this.state.filter || item.source === this.state.filter);
    const countEl = this.root.querySelector('#projectCount');
    if (countEl) {
      countEl.textContent = this.state.filter
        ? `${items.length} / ${this.state.items.length} 个`
        : `${items.length} 个`;
    }
    if (!items.length) {
      // 这里在 panel-body 内部，不能再套一层 .panel
      host.innerHTML = `<div class="empty-state">
        <div class="empty-glyph">${icon('film', 24)}</div>
        <h2>还没有项目</h2>
        <p>去定格工坊导入照片，或在自动化流水线里切分一张宫格图。</p>
      </div>`;
      return;
    }
    host.innerHTML = `<div class="run-grid">
      ${items.map((item) => `<article class="run-card" data-id="${escapeHtml(item.id)}">
        <div class="run-cover">
          ${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.name)}" loading="lazy">` : '<span class="placeholder">没有封面</span>'}
        </div>
        <div class="run-body">
          <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name || '未命名项目')}</strong>
          <div class="row">
            <span class="badge">${escapeHtml(SOURCE_LABEL[item.source] || item.source)}</span>
            ${runStatusBadge(item.status)}
          </div>
          <div class="row">
            <span class="mini">${item.accepted}/${item.frames} 帧</span>
            <span class="mini">${escapeHtml(fmtClock(item.updatedAt || item.createdAt))}</span>
          </div>
        </div>
      </article>`).join('')}
    </div>`;
    $$('.run-card', host).forEach((card) => {
      card.addEventListener('click', () => this.openRun(card.dataset.id));
    });
  }

  async openRun(id) {
    const item = this.state.items.find((entry) => entry.id === id);
    if (!item) return;
    let source = item.source;
    try {
      const run = await api.getRun(id);
      source = run.source || source;
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const route = SOURCE_ROUTE[source] || 'photos';
    this.ctx.store.set(route, id);
    this.ctx.go(route);
  }

  async load() {
    this.state.loading = true;
    this.state.error = '';
    this.renderList();
    try {
      const data = await api.listRuns(80);
      this.state.items = data.items || [];
    } catch (error) {
      this.state.error = error.message || '读取项目失败';
      this.state.items = [];
    } finally {
      this.state.loading = false;
      this.renderList();
    }
  }
}
