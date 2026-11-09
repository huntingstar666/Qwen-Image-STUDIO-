import { api } from "./api.js";

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const KIND_LABEL = {
  txt2img: "文生图",
  img2img: "图生图",
  edit: "图像编辑",
  upscale: "放大",
  panorama: "全景",
};

/**
 * 历史图库：读主项目 /api/history，支持只看本工作台产物、一键用到当前镜头段。
 */
export class HistoryGallery {
  constructor(refs, handlers) {
    this.refs = refs;
    this.handlers = handlers;
    this.items = [];
    this.onlyStudio = false;
    this.loading = false;
    this.loaded = false;
    this.reachable = true;
    this.error = "";
    this._bind();
  }

  async load(force = false) {
    if (this.loading) return;
    if (this.loaded && !force) return;
    this.loading = true;
    this.render();
    try {
      const data = await api.get("/api/main/history?limit=40");
      this.reachable = data.reachable !== false;
      this.error = data.error || "";
      this.items = data.items || [];
      this.loaded = this.reachable;
    } catch (err) {
      this.reachable = false;
      this.error = err.message;
      this.items = [];
    }
    this.loading = false;
    this.render();
  }

  invalidate() {
    this.loaded = false;
  }

  _visible() {
    if (!this.onlyStudio) return this.items;
    return this.items.filter((item) => item.projectId);
  }

  render() {
    const root = this.refs.root;
    if (!root) return;

    if (this.loading) {
      root.innerHTML = `<div class="hg-grid">${Array.from({ length: 6 })
        .map(() => '<div class="hg-card hg-skeleton"></div>').join("")}</div>`;
      return;
    }

    if (!this.reachable) {
      root.innerHTML = `<div class="hg-offline">
        <svg class="icon"><use href="#i-history"></use></svg>
        <strong>主项目不可达</strong>
        <p>${escapeHtml(this.error || "请确认主工作台已启动（8700）。")}</p>
        <button class="btn" type="button" data-refresh>重试</button>
      </div>`;
      return;
    }

    const items = this._visible();
    const toolbar = `<div class="hg-toolbar">
      <label class="switch hg-switch">
        <input type="checkbox" data-only ${this.onlyStudio ? "checked" : ""} />
        <span>只看本工作台</span>
      </label>
      <button class="btn" type="button" data-refresh>刷新</button>
    </div>`;

    if (!items.length) {
      root.innerHTML = `${toolbar}
        <div class="hg-empty">${this.onlyStudio
          ? "本工作台还没有产出记录，取消勾选可看主项目全部历史。"
          : "主项目历史里还没有可用的图片。"}</div>`;
      return;
    }

    root.innerHTML = `${toolbar}
      <div class="hg-grid">${items.map((item) => this._card(item)).join("")}</div>`;
  }

  _card(item) {
    const images = item.images || [];
    const image = images[0] || {};
    const size = image.width && image.height ? `${image.width}×${image.height}` : "";
    const seed = item.seed != null ? `seed ${item.seed}` : "";
    const meta = [size, seed].filter(Boolean).join(" · ");
    const studio = item.projectId ? '<span class="hg-tag">本工作台</span>' : "";
    return `<figure class="hg-card" data-job="${escapeHtml(item.id)}" data-index="${image.index || 0}">
      <img src="${escapeHtml(image.thumbUrl || image.url || "")}"
        data-full="${escapeHtml(image.url || image.thumbUrl || "")}"
        onerror="this.onerror=null;this.src=this.dataset.full" alt="" loading="lazy" />
      <figcaption>
        <div class="hg-line">
          <span class="hg-kind">${escapeHtml(KIND_LABEL[item.kind] || item.kind || "生成")}</span>
          ${studio}
          <span class="hg-time">${escapeHtml((item.createdAt || "").slice(5))}</span>
        </div>
        <span class="hg-meta">${escapeHtml(meta)}</span>
        <span class="hg-prompt" title="${escapeHtml(item.prompt || "")}">${escapeHtml(item.prompt || "（无提示词）")}</span>
        <button class="hg-use" type="button" data-use>用到当前段</button>
      </figcaption>
    </figure>`;
  }

  _bind() {
    const root = this.refs.root;
    root.addEventListener("click", (event) => {
      if (event.target.closest("[data-refresh]")) {
        this.load(true);
        return;
      }
      const button = event.target.closest("[data-use]");
      if (!button) return;
      const card = button.closest(".hg-card");
      const jobId = card.dataset.job;
      const index = Number(card.dataset.index) || 0;
      this.handlers.onUse({ jobId, imageIndex: index });
    });
    root.addEventListener("change", (event) => {
      if (!event.target.matches("[data-only]")) return;
      this.onlyStudio = event.target.checked;
      this.render();
    });
  }
}
