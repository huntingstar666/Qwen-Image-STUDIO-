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
    this._menu = null;
    this._assetRange = null;
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
    this._closeAssetMenu();
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

  _chipHtml(entity, name) {
    const url = (entity.refUrls || [])[0] || "";
    return `<span class="rt-chip" contenteditable="false"
      data-asset-id="${escapeHtml(entity.id)}" data-asset-name="${escapeHtml(name)}">
      ${url ? `<img src="${escapeHtml(url)}" alt="" />` : ""}
      <b>${escapeHtml(name)}</b>
      <button type="button" class="rt-chip-del" data-chip-del="1" title="移除引用">×</button>
    </span>`;
  }

  /** 把 directive 里的 @资产名 还原成带缩略图的 chip。 */
  _richHtml(shot, entities) {
    const text = String(shot.directive || "");
    const named = entities
      .filter((entity) => String(entity.name || "").trim())
      .sort((a, b) => String(b.name).length - String(a.name).length);
    if (!named.length) return escapeHtml(text).replace(/\n/g, "<br>");
    const pattern = new RegExp(
      "@(" + named.map((entity) => String(entity.name)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
    let html = "";
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      html += escapeHtml(text.slice(last, match.index)).replace(/\n/g, "<br>");
      const entity = named.find((item) => String(item.name) === match[1]);
      html += entity ? this._chipHtml(entity, match[1]) : escapeHtml(match[0]);
      last = match.index + match[0].length;
    }
    return html + escapeHtml(text.slice(last)).replace(/\n/g, "<br>");
  }

  /** 生图参考顺序说明：图1=底稿，图2.. 按 @ 顺序对应资产。 */
  _refMapText(shot, entities) {
    const withImage = new Set(entities
      .filter((entity) => (entity.refImages || []).length)
      .map((entity) => String(entity.id)));
    const ordered = [];
    for (const source of [shot.refAssets || [], shot.usedEntities || []]) {
      for (const id of source) {
        const key = String(id);
        if (withImage.has(key) && !ordered.includes(key)) ordered.push(key);
      }
    }
    if (!ordered.length) return "";
    const names = ordered.map((id, index) => {
      const entity = entities.find((item) => String(item.id) === id);
      return `图${index + 2}=${escapeHtml((entity && entity.name) || id)}`;
    });
    return `生图参考：图1=画面底稿 · ${names.join(" · ")}`;
  }

  /** 读取富文本：纯文本 + 按出现顺序的资产 id。 */
  _readRich(editor) {
    let text = "";
    const ids = [];
    const walk = (node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.dataset && child.dataset.assetId) {
            text += "@" + (child.dataset.assetName || "");
            if (!ids.includes(child.dataset.assetId)) ids.push(child.dataset.assetId);
          } else if (child.tagName === "BR") {
            text += "\n";
          } else if (child.tagName !== "BUTTON") {
            walk(child);
          }
        }
      });
    };
    walk(editor);
    return { text: text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim(), ids };
  }

  _updateRefMap(shot) {
    const map = this.refs.body.querySelector("[data-ref-map]");
    if (!map || !this.project) return;
    const entities = ((this.project.locks || {}).content || {}).entities || [];
    map.innerHTML = this._refMapText(shot, entities);
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
          <label>用户指令
            <span class="hint">输入 @ 引用资产图；会参与提示词与润色</span>
            <button class="mini-btn ghost" type="button" data-act="assetRef">@ 引用资产</button>
          </label>
          <div class="rt-editor" contenteditable="true" data-rich="directive" spellcheck="false"
            data-placeholder="例如：让 @小林 转身看向门口，雨更大一些">${this._richHtml(shot, entities)}</div>
          <div class="rt-map" data-ref-map>${this._refMapText(shot, entities)}</div>
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
      const chipDel = event.target.closest("[data-chip-del]");
      if (chipDel) {
        event.preventDefault();
        event.stopPropagation();
        const chip = chipDel.closest(".rt-chip");
        const editor = chip && chip.closest("[data-rich]");
        if (chip) chip.remove();
        if (editor) this._queueCommit(editor, 0);
        return;
      }
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
      if (target.matches("[data-rich]")) {
        this._queueCommit(target, 700);
        this._syncAssetMenu(target);
        return;
      }
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
      if (this._menu) {
        event.preventDefault();
        this._closeAssetMenu();
        return;
      }
      event.preventDefault();
      this.close();
    });

    document.addEventListener("pointerdown", (event) => {
      if (!this._menu) return;
      if (this._menu.contains(event.target)) return;
      if (event.target.closest && event.target.closest("[data-rich]")) return;
      this._closeAssetMenu();
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
    if (name === "assetRef") {
      const editor = this.refs.body.querySelector('[data-rich="directive"]');
      if (!editor) return;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      this._openAssetMenu(editor, "", range);
      return;
    }
    if (name === "polish") return this._polish();
  }

  _syncAssetMenu(editor) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.anchorNode
        || !editor.contains(selection.anchorNode)) {
      this._closeAssetMenu();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      this._closeAssetMenu();
      return;
    }
    const before = node.textContent.slice(0, range.startOffset);
    const match = before.match(/@([^\s@]{0,20})$/);
    if (!match) {
      this._closeAssetMenu();
      return;
    }
    this._openAssetMenu(editor, match[1], range.cloneRange());
  }

  _openAssetMenu(editor, query = "", range = null) {
    const project = this.project;
    if (!project) return;
    const entities = (((project.locks || {}).content || {}).entities) || [];
    const named = entities.filter((entity) => String(entity.name || "").trim());
    if (!named.length) {
      this._closeAssetMenu();
      this.handlers.toast("先在设置里登记角色 / 场景，再 @ 引用", "bad");
      return;
    }
    this._closeAssetMenu();
    this._assetRange = range;
    const keyword = String(query || "").trim().toLowerCase();
    const list = named.filter((entity) =>
      !keyword || String(entity.name).toLowerCase().includes(keyword));

    const rect = range && range.getBoundingClientRect
      ? range.getBoundingClientRect() : editor.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left || editor.getBoundingClientRect().left),
      window.innerWidth - 288);
    const top = Math.min((rect.bottom || editor.getBoundingClientRect().bottom) + 6,
      window.innerHeight - 260);
    const menu = document.createElement("div");
    menu.className = "rt-menu";
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.innerHTML = list.length ? list.map((entity) => {
      const url = (entity.refUrls || [])[0] || "";
      const kind = entity.kind === "location" ? "场景" : entity.kind === "prop" ? "道具" : "角色";
      return `<button type="button" class="rt-menu-item" data-asset-id="${escapeHtml(entity.id)}">
        ${url ? `<img src="${escapeHtml(url)}" alt="" />` : '<span class="rt-menu-noimg"></span>'}
        <span class="rt-menu-name">${escapeHtml(entity.name)}</span>
        <em>${kind}</em>
      </button>`;
    }).join("") : '<div class="rt-menu-empty">没有匹配的资产</div>';
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    menu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-asset-id]");
      if (!item) return;
      const entity = named.find((entry) => String(entry.id) === item.dataset.assetId);
      const saved = this._assetRange;
      this._closeAssetMenu();
      if (entity) this._insertAssetChip(editor, entity, saved);
    });
    document.body.appendChild(menu);
    this._menu = menu;
  }

  _closeAssetMenu() {
    if (this._menu) {
      this._menu.remove();
      this._menu = null;
    }
  }

  _insertAssetChip(editor, entity, range) {
    editor.focus();
    let target = range;
    if (!target || !editor.contains(target.startContainer)) {
      target = document.createRange();
      target.selectNodeContents(editor);
      target.collapse(false);
    }
    // 把已经敲出来的 "@小林" 查询词删掉，再插入 chip
    const node = target.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      const before = node.textContent.slice(0, target.startOffset);
      const match = before.match(/@[^\s@]*$/);
      if (match) {
        const start = target.startOffset - match[0].length;
        const cut = document.createRange();
        cut.setStart(node, start);
        cut.setEnd(node, target.startOffset);
        cut.deleteContents();
        target = document.createRange();
        target.setStart(node, start);
        target.collapse(true);
      }
    }
    const chip = document.createElement("span");
    chip.className = "rt-chip";
    chip.contentEditable = "false";
    chip.dataset.assetId = entity.id;
    chip.dataset.assetName = entity.name || entity.id;
    const url = (entity.refUrls || [])[0] || "";
    chip.innerHTML = `${url ? `<img src="${escapeHtml(url)}" alt="" />` : ""}
      <b>${escapeHtml(entity.name || entity.id)}</b>
      <button type="button" class="rt-chip-del" data-chip-del="1" title="移除引用">×</button>`;
    target.insertNode(chip);
    const space = document.createTextNode("\u00a0");
    chip.parentNode.insertBefore(space, chip.nextSibling);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(after);
    this._assetRange = null;
    this._queueCommit(editor, 0);
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
    const editor = this.refs.body.querySelector('[data-rich="directive"]');
    let value = "";
    let refAssets = [];
    if (editor) {
      const rich = this._readRich(editor);
      value = rich.text;
      refAssets = rich.ids;
    } else {
      const directive = this.refs.body.querySelector('[data-field="directive"]');
      value = directive ? directive.value.trim() : "";
    }
    if (!value && !refAssets.length) {
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
      const result = await this.handlers.polish(this.shotId, value, refAssets);
      this.polishing = false;
      this.render();
      this.handlers.toast(
        result && result.vision
          ? `已读 ${result.refImages || 0} 张参考图并重写画面描述`
          : "已按指令重写画面描述",
        "ok");
    } catch (err) {
      this.polishing = false;
      this.render();
      this.handlers.toast(err.message, "bad");
    }
  }

  _queueCommit(element, delay = 650) {
    const path = element.dataset.field || element.dataset.rich;
    if (!path) return;
    clearTimeout(this._timers.get(path));
    this._timers.set(path, setTimeout(() => this._commit(element), delay));
  }

  async _commit(element) {
    if (element.dataset.rich) {
      const { text, ids } = this._readRich(element);
      const shot = await this.handlers.patch(this.shotId, { directive: text, refAssets: ids });
      if (!shot) return;
      this._updateRefMap(shot);
      const prompt = this.refs.body.querySelector('[data-field="prompt"]');
      const negative = this.refs.body.querySelector('[data-field="negative"]');
      if (prompt && document.activeElement !== prompt) prompt.value = shot.prompt || "";
      if (negative && document.activeElement !== negative) negative.value = shot.negative || "";
      return;
    }
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
