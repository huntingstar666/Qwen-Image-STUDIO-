/** 图片版本条：缩略图横排，点选切换当前版本，可删除非当前版本。 */

const SOURCE_LABEL = {
  generate: "生成",
  upload: "上传",
  legacy: "旧版",
};

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function versionLabel(file) {
  const match = /_v(\d+)\./i.exec(String(file || ""));
  return match ? `V${match[1]}` : "V1";
}

export function renderVersions(host, shot, handlers) {
  const history = shot.imageHistory || [];
  if (!history.length) {
    host.innerHTML = '<div class="ver-empty">还没有历史版本，重新生成或上传后会在这里留档。</div>';
    host.onclick = null;
    return;
  }

  host.innerHTML = `<div class="ver-strip">${history.map((item) => {
    const file = item.file || "";
    const current = Boolean(file) && file === shot.image;
    return `<div class="ver-item${current ? " current" : ""}"
      data-file="${escapeHtml(file)}" title="${escapeHtml(item.at || "")}"
      role="button" tabindex="0">
      <img src="${escapeHtml(item.url || "")}" alt="" loading="lazy" />
      <span class="ver-tag">${versionLabel(file)}</span>
      ${current ? '<span class="ver-now">当前</span>' : ""}
      <span class="ver-src">${escapeHtml(SOURCE_LABEL[item.source] || item.source || "生成")}</span>
      <button class="ver-del" type="button" data-ver-del title="删除此版本" aria-label="删除此版本">
        <svg class="icon"><use href="#i-close"></use></svg>
      </button>
    </div>`;
  }).join("")}</div>`;

  host.onclick = async (event) => {
    const item = event.target.closest(".ver-item");
    if (!item) return;
    const file = item.dataset.file;
    if (!file) return;
    if (event.target.closest("[data-ver-del]")) {
      event.stopPropagation();
      await handlers.onDelete(file);
      return;
    }
    if (item.classList.contains("current")) return;
    await handlers.onUse(file);
  };

  host.onkeydown = (event) => {
    const item = event.target.closest(".ver-item");
    if (!item || event.target !== item) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      item.click();
    }
  };
}
