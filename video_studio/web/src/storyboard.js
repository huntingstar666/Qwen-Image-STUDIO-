import { formatMs } from "./api.js";
import { initSegmented } from "./ui.js";
import { renderVersions } from "./versions.js";

const STATUS_LABEL = {
  pending: "待生成",
  generating: "生成中",
  ready: "已就绪",
  failed: "生成失败",
};

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusText(shot) {
  return STATUS_LABEL[shot.status] || shot.status || "待生成";
}

/**
 * 分镜表：一屏通读所有段的台词、缩略图与提示词，支持就地编辑与单段操作。
 * 与时间线共用同一份 selectedId，数据由 setProject 统一注入。
 */
export class Storyboard {
  constructor(refs, handlers) {
    this.refs = refs;
    this.handlers = handlers;
    this.project = null;
    this.selectedId = "";
    this.filter = "all";
    this.query = "";
    this.expanded = new Set();
    this._searchTimer = 0;
    this._pendingCommit = Promise.resolve();
    this._bind();
  }

  // ---------------------------------------------------------------- 数据

  setProject(project, selectedId) {
    this.project = project || null;
    if (selectedId !== undefined) this.selectedId = selectedId || "";
    this.render();
  }

  setSelected(selectedId, scroll = false) {
    this.selectedId = selectedId || "";
    const list = this.refs.list;
    if (!list) return;
    list.querySelectorAll(".sb-row").forEach((row) => {
      row.classList.toggle("selected", row.dataset.id === this.selectedId);
    });
    if (scroll && this.selectedId) {
      const row = list.querySelector(`.sb-row[data-id="${this.selectedId}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  }

  setFilter(filter) {
    this.filter = filter;
    if (this.segmented) this.segmented.set(filter);
    this.render();
  }

  setQuery(query) {
    this.query = String(query || "");
    this.render();
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    const list = this.refs.list;
    if (!list) return;
    const scrollTop = list.scrollTop;

    if (!this.project) {
      list.innerHTML = `<div class="sb-empty">
        <svg class="icon"><use href="#i-image"></use></svg>
        <strong>还没有项目</strong>
        <p>新建项目并上传音频与字幕后开始。</p>
      </div>`;
      this._setCount("0 段");
      return;
    }

    const shots = this.project.shots || [];
    if (!shots.length) {
      list.innerHTML = `<div class="sb-empty">
        <svg class="icon"><use href="#i-image"></use></svg>
        <strong>还没有镜头段</strong>
        <p>先上传音频和带时间轴的逐字稿，再点「自动分段」。</p>
        <div class="sb-empty-actions">
          <button class="btn primary" type="button" data-empty="audio">上传音频</button>
          <button class="btn" type="button" data-empty="subtitle">上传字幕</button>
        </div>
      </div>`;
      this._setCount(`0 段 · ${formatMs(this._duration())}`);
      return;
    }

    const visible = this._visible(shots);
    if (!visible.length) {
      list.innerHTML = `<div class="sb-empty">
        <svg class="icon"><use href="#i-search"></use></svg>
        <strong>没有符合条件的镜头段</strong>
        <p>换个筛选或关键词试试。</p>
        <button class="btn" type="button" data-empty="reset">清除筛选</button>
      </div>`;
    } else {
      list.innerHTML = visible.map((shot) => this._rowHtml(shot)).join("");
    }

    list.scrollTop = scrollTop;
    this._paintThumbs();
    this._paintAutoGrow();
    this.setSelected(this.selectedId);
    this._updateCount(shots, visible);
  }

  _duration() {
    return Number((this.project && this.project.audio && this.project.audio.durationMs) || 0);
  }

  _visible(shots) {
    const query = this.query.trim().toLowerCase();
    return shots.filter((shot) => {
      const status = shot.status || "pending";
      if (this.filter === "ready" && status !== "ready") return false;
      if (this.filter === "failed" && status !== "failed") return false;
      if (this.filter === "todo" && !["pending", "generating"].includes(status)) return false;
      if (!query) return true;
      return [shot.id, shot.text, shot.prompt, shot.description]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
  }

  _rowHtml(shot) {
    const status = shot.status || "pending";
    const open = this.expanded.has(shot.id);
    const prompt = shot.prompt || "";
    const versionCount = (shot.imageHistory || []).length;
    const durationSec = Math.max(0, shot.endMs - shot.startMs) / 1000;
    const thumb = shot.imageUrl
      ? `<img class="sb-thumb is-loading" src="${escapeHtml(shot.imageUrl)}" alt="${escapeHtml(shot.id)}" loading="lazy" />`
      : `<div class="sb-thumb empty"><svg class="icon"><use href="#i-image"></use></svg><span>待生成</span></div>`;

    return `<article class="sb-row status-${escapeHtml(status)}${shot.id === this.selectedId ? " selected" : ""}"
      data-id="${escapeHtml(shot.id)}" tabindex="0" aria-label="镜头段 ${escapeHtml(shot.id)}">
      <div class="sb-media">
        ${thumb}
        <span class="sb-num">${escapeHtml(shot.id)}</span>
      </div>
      <div class="sb-main">
        <div class="sb-top">
          <span class="sb-time">${formatMs(shot.startMs)} – ${formatMs(shot.endMs)}</span>
          <span class="sb-dur">${durationSec.toFixed(1)}s</span>
          <span class="sb-status">${escapeHtml(statusText(shot))}</span>
        </div>
        <label class="sb-field">
          <span class="sb-label">台词</span>
          <textarea class="sb-text auto-grow" rows="2" data-edit="text"
            data-saved="${escapeHtml(shot.text || "")}"
            placeholder="（这段没有台词，可手动补）">${escapeHtml(shot.text || "")}</textarea>
        </label>
        <div class="sb-field">
          <span class="sb-label">提示词</span>
          <div class="sb-prompt-wrap">
            <textarea class="sb-text sb-prompt${open ? "" : " clamped"}" rows="2" data-edit="prompt"
              data-saved="${escapeHtml(prompt)}" title="${escapeHtml(prompt)}"
              placeholder="还没有提示词，点「生成分镜提示词」">${escapeHtml(prompt)}</textarea>
            ${prompt.length > 80
              ? `<button class="sb-expand" type="button" data-expand>${open ? "收起" : "展开"}</button>`
              : ""}
          </div>
        </div>
        <div class="sb-versions" data-versions hidden></div>
      </div>
      <div class="sb-actions">
        <button class="mini-btn" type="button" data-act="regen" ${status === "generating" ? "disabled" : ""}>
          <svg class="icon"><use href="#i-refresh"></use></svg>重新生图
        </button>
        <button class="mini-btn" type="button" data-act="upload">
          <svg class="icon"><use href="#i-upload"></use></svg>换图
        </button>
        ${versionCount > 1
          ? `<button class="mini-btn ghost" type="button" data-act="versions">版本 ${versionCount}</button>`
          : ""}
        <button class="mini-btn ghost" type="button" data-act="locate">
          <svg class="icon"><use href="#i-locate"></use></svg>定位
        </button>
      </div>
    </article>`;
  }

  _paintThumbs() {
    this.refs.list.querySelectorAll("img.sb-thumb").forEach((img) => {
      const done = () => img.classList.remove("is-loading");
      if (img.complete && img.naturalWidth > 0) {
        done();
        return;
      }
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", done, { once: true });
    });
  }

  _paintAutoGrow() {
    if (!this.refs.list.offsetParent) return;
    this.refs.list.querySelectorAll("textarea.auto-grow").forEach((el) => this._autoGrow(el, 180));
    this.refs.list.querySelectorAll("textarea.sb-prompt:not(.clamped)").forEach((el) => this._autoGrow(el, 400));
  }

  _autoGrow(el, max) {
    el.style.height = "auto";
    el.style.height = `${Math.min(max, Math.max(44, el.scrollHeight))}px`;
  }

  _setCount(text) {
    if (this.refs.count) this.refs.count.textContent = text;
  }

  _updateCount(shots, visible) {
    const ready = shots.filter((shot) => shot.status === "ready").length;
    const filtering = this.filter !== "all" || this.query.trim();
    this._setCount(filtering
      ? `显示 ${visible.length} / ${shots.length} 段 · ${ready} 段就绪`
      : `${shots.length} 段 · ${ready} 段就绪`);
  }

  // ---------------------------------------------------------------- 交互

  _bind() {
    const list = this.refs.list;

    list.addEventListener("click", async (event) => {
      const emptyBtn = event.target.closest("[data-empty]");
      if (emptyBtn) {
        const kind = emptyBtn.dataset.empty;
        if (kind === "reset") {
          this.refs.search.value = "";
          this.setQuery("");
          if (this.segmented) this.segmented.set("all");
          this.setFilter("all");
          return;
        }
        if (kind === "audio") this.handlers.onUploadAudio?.();
        if (kind === "subtitle") this.handlers.onUploadSubtitle?.();
        return;
      }

      const actionBtn = event.target.closest("[data-act]");
      if (actionBtn) {
        event.stopPropagation();
        const row = actionBtn.closest(".sb-row");
        const shot = this._shot(row && row.dataset.id);
        if (!shot) return;
        await this._flush();
        const action = actionBtn.dataset.act;
        if (action === "versions") {
          const panel = row.querySelector("[data-versions]");
          if (!panel) return;
          if (!panel.hidden) {
            panel.hidden = true;
            return;
          }
          renderVersions(panel, shot, {
            onUse: (file) => this.handlers.onUseVersion(shot.id, file),
            onDelete: (file) => this.handlers.onDeleteVersion(shot.id, file),
          });
          panel.hidden = false;
          return;
        }
        if (action === "regen") this.handlers.onRegenerate(shot.id);
        if (action === "upload") this.handlers.onUpload(shot.id);
        if (action === "locate") this.handlers.onLocate(shot);
        return;
      }

      const expandBtn = event.target.closest("[data-expand]");
      if (expandBtn) {
        event.stopPropagation();
        const row = expandBtn.closest(".sb-row");
        const id = row.dataset.id;
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this._applyExpand(row);
        return;
      }

      if (event.target.closest("textarea, input, button, label")) return;
      const row = event.target.closest(".sb-row");
      if (!row) return;
      const shot = this._shot(row.dataset.id);
      this.handlers.onSelect(row.dataset.id, shot);
    });

    list.addEventListener("keydown", (event) => {
      const row = event.target.closest(".sb-row");
      if (!row || event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      const shot = this._shot(row.dataset.id);
      this.handlers.onSelect(row.dataset.id, shot);
    });

    list.addEventListener("focusin", (event) => {
      const el = event.target;
      if (!el.matches("[data-edit]")) return;
      el.dataset.saved = el.value;
    });

    list.addEventListener("focusout", (event) => {
      const el = event.target;
      if (!el.matches("[data-edit]")) return;
      this._commit(el);
    });

    list.addEventListener("input", (event) => {
      const el = event.target;
      if (!el.matches("textarea.auto-grow") || el.classList.contains("clamped")) return;
      this._autoGrow(el, 180);
    });

    list.addEventListener("keydown", (event) => {
      const el = event.target;
      if (!el.matches("[data-edit]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        el.value = el.dataset.saved ?? "";
        el.blur();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        el.blur();
      }
    });

    if (this.refs.filter) {
      this.segmented = initSegmented(this.refs.filter, (value) => this.setFilter(value));
    }
    if (this.refs.search) {
      this.refs.search.addEventListener("input", () => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.setQuery(this.refs.search.value), 140);
      });
    }
  }

  _shot(shotId) {
    return ((this.project && this.project.shots) || []).find((shot) => shot.id === shotId) || null;
  }

  _applyExpand(row) {
    const open = this.expanded.has(row.dataset.id);
    const promptEl = row.querySelector('[data-edit="prompt"]');
    const button = row.querySelector("[data-expand]");
    if (promptEl) {
      promptEl.classList.toggle("clamped", !open);
      if (open) this._autoGrow(promptEl, 400);
    }
    if (button) button.textContent = open ? "收起" : "展开";
  }

  _flush() {
    return this._pendingCommit || Promise.resolve();
  }

  _commit(el) {
    const row = el.closest(".sb-row");
    if (!row) return Promise.resolve();
    const shotId = row.dataset.id;
    const field = el.dataset.edit;
    const saved = el.dataset.saved ?? "";
    const value = el.value;
    if (!shotId || !field || value === saved) return this._flush();

    el.dataset.saved = value;
    const promise = (async () => {
      const shot = await this.handlers.onPatch(shotId, { [field]: value });
      if (!shot) {
        el.value = saved;
        el.dataset.saved = saved;
        return;
      }
      if (this.project) {
        this.project = {
          ...this.project,
          shots: (this.project.shots || []).map((item) => (item.id === shot.id ? shot : item)),
        };
      }
      this._syncRow(row, shot);
    })();
    this._pendingCommit = promise;
    return promise;
  }

  _syncRow(row, shot) {
    const promptEl = row.querySelector('[data-edit="prompt"]');
    if (promptEl && document.activeElement !== promptEl) {
      promptEl.value = shot.prompt || "";
      promptEl.dataset.saved = shot.prompt || "";
      promptEl.title = shot.prompt || "";
      promptEl.classList.add("clamped");
      this.expanded.delete(shot.id);
      const button = row.querySelector("[data-expand]");
      if (button) button.textContent = "展开";
    }
    const statusEl = row.querySelector(".sb-status");
    if (statusEl) statusEl.textContent = statusText(shot);
    row.className = `sb-row status-${shot.status || "pending"}${shot.id === this.selectedId ? " selected" : ""}`;
  }
}
