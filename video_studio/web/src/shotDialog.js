/**
 * 段落详情弹窗：替代原来的侧栏「镜头」面板。
 *
 * 左列：当前画面、图片版本、换图（本地 / 素材仓库）、重新生成、清空；
 * 右列：台词、画面描述、用户指令（可润色）、最终提示词、负面词、镜头语言、转场。
 * 所有文本改动自动保存；润色会把用户指令一起发给 LLM。
 */
import { formatMs } from "./api.js";

const STATUS_LABEL = {
  pending: "待生成",
  generating: "生成中",
  ready: "已就绪",
  failed: "生成失败",
};

const MOTION_LABEL = {
  none: "固定画面",
  push: "慢推（靠近人物）",
  pull: "慢拉（抽离 / 揭示环境）",
  left: "左横移",
  right: "右横移",
  up: "上摇",
  down: "下摇",
  diag: "对角推（跟拍感）",
};

const TRANSITION_LABEL = { cut: "硬切", fade: "淡入淡出", fadeblack: "黑场过渡" };

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toPatch(path, value) {
  const keys = path.split(".");
  const root = {};
  let cursor = root;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) cursor[key] = value;
    else {
      cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return root;
}

export class ShotDialog {
  constructor(refs, handlers) {
    this.refs = refs;
    this.handlers = handlers;
    this.project = null;
    this.shotId = "";
    this.materials = [];
    this.materialOpen = false;
    this.materialLoading = false;
    this.materialQuery = "";
    this.materialTimer = 0;
    this.polishing = false;
    this.polishOn = true;
    this._timers = new Map();
    this._bind();
  }

  isOpen() {
    return !this.refs.dialog.hidden;
  }

  setProject(project) {
    this.project = project || null;
    if (!this.isOpen()) return;
    if (!this._shot()) {
      this.close();
      return;
    }
    this._syncLight();
  }

  open(shotId) {
    if (!shotId) return;
    this.shotId = shotId;
    this.materialOpen = false;
    this.materials = [];
    this.polishing = false;
    this.polishOn = true;
    this.refs.backdrop.hidden = false;
    this.refs.dialog.hidden = false;
    this.render();
  }

  close() {
    this._timers.forEach((timer) => clearTimeout(timer));
    this._timers.clear();
    this.refs.dialog.hidden = true;
    this.refs.backdrop.hidden = true;
    this.shotId = "";
    this.materialOpen = false;
  }

  _shot() {
    return ((this.project && this.project.shots) || []).find((shot) => shot.id === this.shotId) || null;
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    const shot = this._shot();
    if (!shot) {
      this.close();
      return;
    }
    const project = this.project;
    const shots = project.shots || [];
    const index = shots.findIndex((item) => item.id === shot.id);
    this.refs.id.textContent = shot.id;
    this.refs.time.textContent =
      `${formatMs(shot.startMs)} – ${formatMs(shot.endMs)} · ${((shot.endMs - shot.startMs) / 1000).toFixed(1)}s`;
    this.refs.status.textContent = STATUS_LABEL[shot.status] || shot.status || "待生成";
    this.refs.prev.disabled = index <= 0;
    this.refs.next.disabled = index < 0 || index >= shots.length - 1;
    this.refs.body.innerHTML = this._bodyHtml(shot, project);
    this._paintMaterials();
  }

  _syncLight() {
    const shot = this._shot();
    if (!shot) {
      this.close();
      return;
    }
    this.refs.status.textContent = STATUS_LABEL[shot.status] || shot.status || "待生成";
    const image = this.refs.body.querySelector("[data-image]");
    if (image) {
      if (shot.imageUrl) {
        image.src = shot.imageUrl;
        image.classList.remove("empty");
        image.alt = shot.id;
      } else {
        image.removeAttribute("src");
        image.classList.add("empty");
      }
    }
    const versions = this.refs.body.querySelector("[data-versions]");
    if (versions) versions.innerHTML = this._versionsHtml(shot);
    const clearBtn = this.refs.body.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.disabled = !shot.image;
  }

  _versionsHtml(shot) {
    const history = shot.imageHistory || [];
    if (!history.length) return "";
    return history.map((item) => {
      const active = item.file === shot.image;
      return `<button class="sd-ver${active ? " active" : ""}" type="button"
        data-ver="${escapeHtml(item.file)}" title="${escapeHtml(item.source || "版本")}">
        <img src="${escapeHtml(item.url || "")}" alt="版本" loading="lazy" />
        <span class="sd-ver-del" data-ver-del="${escapeHtml(item.file)}" title="删除该版本">×</span>
      </button>`;
    }).join("");
  }

  _bodyHtml(shot, project) {
    const motion = shot.motion || {};
    const transition = shot.transition || {};
    const review = shot.review || {};
    const entities = ((project.locks || {}).content || {}).entities || [];
    const used = (shot.usedEntities || []).map((id) => {
      const entity = entities.find((item) => item.id === id);
      return entity ? entity.name || entity.id : id;
    });
    const warnings = (shot.warnings || []).map((item) =>
      `<span class="tag warn">${escapeHtml(item)}</span>`).join("");
    const image = shot.imageUrl
      ? `<img class="sd-image" data-image src="${escapeHtml(shot.imageUrl)}" alt="${escapeHtml(shot.id)}" />`
      : `<div class="sd-image empty" data-image>还没有画面</div>`;
    const materialPanel = this.materialOpen ? `
      <div class="sd-material">
        <input class="input" data-material-search placeholder="搜索素材标题 / 提示词" value="${escapeHtml(this.materialQuery)}" />
        <div class="sd-material-grid" data-material-grid>
          <div class="sd-material-empty">${this.materialLoading ? "正在读取素材仓库…" : "还没有素材"}</div>
        </div>
      </div>` : "";
    const reviewPanel = (review.prompt || review.image) ? `
      <div class="review-panel">
        <strong>待处理</strong>
        ${review.prompt ? `<div class="review-row"><span>提示词需复核</span>
          <button class="mini-btn" type="button" data-act="regen">重新生成</button>
          <button class="mini-btn ghost" type="button" data-act="reviewPrompt">标记已处理</button></div>` : ""}
        ${review.image ? `<div class="review-row"><span>图片需确认</span>
          <button class="mini-btn" type="button" data-act="regen">重新生图</button>
          <button class="mini-btn ghost" type="button" data-act="reviewImage">标记已处理</button></div>` : ""}
      </div>` : "";

    return `
      <div class="sd-left">
        ${image}
        <div class="sd-versions" data-versions>${this._versionsHtml(shot)}</div>
        <div class="sd-actions">
          <button class="btn" type="button" data-act="upload">本地上传</button>
          <button class="btn" type="button" data-act="material">素材仓库</button>
          <button class="btn" type="button" data-act="regen">重新生成</button>
          <button class="btn ghost" type="button" data-act="clear" ${shot.image ? "" : "disabled"}>清空画面</button>
        </div>
        ${materialPanel}
        ${(warnings || used.length) ? `<div class="sd-chips">${warnings}
          ${used.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("")}</div>` : ""}
      </div>
      <div class="sd-right">
        <div class="sd-group">
          <label>台词
            <span class="tag">${shot.textMode === "manual" ? "手动" : "自动"}</span>
            ${shot.textMode === "manual" ? '<button class="mini-btn ghost" type="button" data-act="textAuto">恢复自动</button>' : ""}
          </label>
          <textarea class="textarea" data-field="text" data-kind="text"
            placeholder="（这段没有台词）">${escapeHtml(shot.text || "")}</textarea>
        </div>
        <div class="sd-group">
          <label>画面描述 <span class="hint">模型产出，可改；改动后自动重拼提示词</span></label>
          <textarea class="textarea" data-field="description" data-kind="text"
            placeholder="人物、动作、环境、光线">${escapeHtml(shot.description || "")}</textarea>
        </div>
        <div class="sd-group">
          <label>用户指令 <span class="hint">会拼进最终提示词；也可让模型按指令重写描述</span></label>
          <textarea class="textarea" data-field="directive" data-kind="text"
            placeholder="例如：让雨更大，人物不要看镜头，镜头更贴近手部">${escapeHtml(shot.directive || "")}</textarea>
          <div class="sd-directive-actions">
            <label class="sd-polish">
              <input type="checkbox" data-polish-toggle ${this.polishOn ? "checked" : ""} />
              <span>按指令让模型重写画面描述</span>
            </label>
            <button class="btn" type="button" data-act="polish" ${this.polishOn && !this.polishing ? "" : "disabled"}>
              ${this.polishing ? "润色中…" : "润色并更新提示词"}
            </button>
          </div>
        </div>
        <div class="sd-group">
          <label>最终提示词 <span class="hint">直接修改视为手改，不会再被描述覆盖</span></label>
          <textarea class="textarea" data-field="prompt" data-kind="text">${escapeHtml(shot.prompt || "")}</textarea>
        </div>
        <div class="sd-group">
          <label>负面词</label>
          <textarea class="textarea" data-field="negative" data-kind="text">${escapeHtml(shot.negative || "")}</textarea>
        </div>
        <div class="sd-two">
          <div class="sd-group">
            <label>镜头语言</label>
            <select class="select" data-field="motion.type" data-kind="string">
              ${Object.entries(MOTION_LABEL).map(([value, label]) =>
                `<option value="${value}" ${(motion.type || "none") === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select>
          </div>
          <div class="sd-group">
            <label>运动幅度 <span class="hint">${Number(motion.zoom || 1.06).toFixed(2)}×</span></label>
            <input class="input" type="range" min="1.01" max="1.3" step="0.01"
              data-field="motion.zoom" data-kind="number" value="${Number(motion.zoom || 1.06)}" />
          </div>
          <div class="sd-group">
            <label>转场方式（进入本段）</label>
            <select class="select" data-field="transition.type" data-kind="string">
              ${Object.entries(TRANSITION_LABEL).map(([value, label]) =>
                `<option value="${value}" ${(transition.type || "cut") === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select>
          </div>
          <div class="sd-group">
            <label>转场时长 ms</label>
            <input class="input" type="number" min="80" max="2000" step="20"
              data-field="transition.durationMs" data-kind="number" value="${Number(transition.durationMs || 300)}" />
          </div>
        </div>
        ${reviewPanel}
      </div>`;
  }

  // ---------------------------------------------------------------- 交互

  _bind() {
    this.refs.close.addEventListener("click", () => this.close());
    this.refs.done.addEventListener("click", () => this.close());
    this.refs.backdrop.addEventListener("click", () => this.close());
    this.refs.prev.addEventListener("click", () => this._navigate(-1));
    this.refs.next.addEventListener("click", () => this._navigate(1));

    this.refs.body.addEventListener("click", (event) => {
      const versionDel = event.target.closest("[data-ver-del]");
      if (versionDel) {
        event.stopPropagation();
        this.handlers.deleteVersion(this.shotId, versionDel.dataset.verDel);
        return;
      }
      const version = event.target.closest("[data-ver]");
      if (version) {
        this.handlers.useVersion(this.shotId, version.dataset.ver);
        return;
      }
      const material = event.target.closest("[data-material-url]");
      if (material) {
        this.handlers.useMaterial(this.shotId, material.dataset.materialUrl);
        return;
      }
      const action = event.target.closest("[data-act]");
      if (!action) return;
      this._action(action.dataset.act);
    });

    this.refs.body.addEventListener("input", (event) => {
      const target = event.target;
      if (target.matches("[data-material-search]")) {
        this.materialQuery = target.value;
        clearTimeout(this.materialTimer);
        this.materialTimer = setTimeout(() => this._loadMaterials(), 260);
        return;
      }
      if (target.matches("[data-polish-toggle]")) {
        this.polishOn = target.checked;
        const button = this.refs.body.querySelector('[data-act="polish"]');
        if (button) button.disabled = !this.polishOn || this.polishing;
        return;
      }
      if (target.matches("[data-field]")) {
        const label = target.closest(".sd-group")?.querySelector("label .hint");
        if (target.type === "range" && label) {
          label.textContent = `${Number(target.value).toFixed(2)}×`;
        }
        this._queueCommit(target);
      }
    });

    this.refs.body.addEventListener("change", (event) => {
      const target = event.target;
      if (!target.matches("[data-field]")) return;
      if (target.tagName === "SELECT" || target.type === "range" || target.type === "number") {
        this._queueCommit(target, 0);
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.isOpen()) return;
      event.preventDefault();
      this.close();
    });
  }

  _navigate(step) {
    const shots = (this.project && this.project.shots) || [];
    const index = shots.findIndex((shot) => shot.id === this.shotId);
    const target = shots[index + step];
    if (!target) return;
    this.shotId = target.id;
    this.materialOpen = false;
    this.handlers.onNavigate(target.id);
    this.render();
  }

  _action(name) {
    if (name === "upload") return this.handlers.upload(this.shotId);
    if (name === "regen") return this.handlers.regenerate(this.shotId);
    if (name === "clear") return this.handlers.clear(this.shotId);
    if (name === "textAuto") return this.handlers.setTextMode(this.shotId);
    if (name === "reviewPrompt") return this.handlers.clearReview(this.shotId, ["prompt"]);
    if (name === "reviewImage") return this.handlers.clearReview(this.shotId, ["image"]);
    if (name === "material") {
      this.materialOpen = !this.materialOpen;
      this.render();
      if (this.materialOpen) this._loadMaterials();
      return;
    }
    if (name === "polish") return this._polish();
  }

  async _loadMaterials() {
    if (this.materialLoading) return;
    this.materialLoading = true;
    this._paintMaterials();
    try {
      const data = await this.handlers.listMaterials(this.materialQuery);
      this.materials = data.items || [];
      this.materialError = data.reachable === false ? (data.error || "主项目不可达") : "";
    } catch (err) {
      this.materials = [];
      this.materialError = err.message;
    }
    this.materialLoading = false;
    this._paintMaterials();
  }

  _paintMaterials() {
    const grid = this.refs.body.querySelector("[data-material-grid]");
    if (!grid) return;
    if (this.materialLoading) {
      grid.innerHTML = '<div class="sd-material-empty">正在读取素材仓库…</div>';
      return;
    }
    if (this.materialError) {
      grid.innerHTML = `<div class="sd-material-empty">${escapeHtml(this.materialError)}</div>`;
      return;
    }
    if (!this.materials.length) {
      grid.innerHTML = '<div class="sd-material-empty">素材仓库里还没有图片</div>';
      return;
    }
    grid.innerHTML = this.materials.map((item) => `
      <button class="sd-material-item" type="button" title="${escapeHtml(item.title || item.kind || "")}"
        data-material-url="${escapeHtml(item.url)}">
        <img src="${escapeHtml(item.thumbUrl || item.url)}" alt="${escapeHtml(item.title || "素材")}" loading="lazy" />
      </button>`).join("");
  }

  async _polish() {
    const directive = this.refs.body.querySelector('[data-field="directive"]');
    const value = directive ? directive.value.trim() : "";
    if (!value) {
      this.handlers.toast("先填写用户指令，再润色", "bad");
      return;
    }
    if (this.polishing) return;
    this.polishing = true;
    const button = this.refs.body.querySelector('[data-act="polish"]');
    if (button) {
      button.disabled = true;
      button.textContent = "润色中…";
    }
    try {
      await this.handlers.polish(this.shotId, value);
      this.polishing = false;
      this.render();
      this.handlers.toast("已按指令重写画面描述", "ok");
    } catch (err) {
      this.polishing = false;
      this.render();
      this.handlers.toast(err.message, "bad");
    }
  }

  _queueCommit(element, delay = 650) {
    const path = element.dataset.field;
    if (!path) return;
    clearTimeout(this._timers.get(path));
    this._timers.set(path, setTimeout(() => this._commit(element), delay));
  }

  async _commit(element) {
    const path = element.dataset.field;
    if (!path) return;
    let value = element.value;
    if (element.dataset.kind === "number") value = Number(value);
    const shot = await this.handlers.patch(this.shotId, toPatch(path, value));
    if (!shot) return;
    this._syncLight();
    const prompt = this.refs.body.querySelector('[data-field="prompt"]');
    const negative = this.refs.body.querySelector('[data-field="negative"]');
    if (prompt && path !== "prompt" && document.activeElement !== prompt) {
      prompt.value = shot.prompt || "";
    }
    if (negative && path !== "negative" && document.activeElement !== negative) {
      negative.value = shot.negative || "";
    }
    const desc = this.refs.body.querySelector('[data-field="description"]');
    if (desc && path === "directive" && document.activeElement !== desc) {
      desc.value = shot.description || "";
    }
  }
}
