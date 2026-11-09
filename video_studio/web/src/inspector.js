import { formatMs } from "./api.js";
import { renderVersions } from "./versions.js";

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
    if (index === keys.length - 1) {
      cursor[key] = value;
    } else {
      cursor[key] = {};
      cursor = cursor[key];
    }
  });
  return root;
}

function emptyHint(icon, text) {
  return `<div class="empty-hint"><svg class="icon"><use href="#${icon}"></use></svg><p>${text}</p></div>`;
}

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

export function renderInspector(host, state, handlers) {
  const project = state.project;
  const shot = (project.shots || []).find((item) => item.id === state.selectedId);
  if (!project) {
    host.innerHTML = emptyHint("i-image", "还没有项目");
    return;
  }
  if (!shot) {
    host.innerHTML = (project.shots || []).length
      ? emptyHint("i-locate", "在时间线或分镜表里点选一个镜头段")
      : emptyHint("i-caption", "上传音频与字幕后，点「自动分段」");
    return;
  }

  const entities = ((project.locks || {}).content || {}).entities || [];
  const used = (shot.usedEntities || []).map((id) => {
    const entity = entities.find((item) => item.id === id);
    return entity ? entity.name || entity.id : id;
  });
  const motion = shot.motion || {};
  const transition = shot.transition || {};
  const statusText = {
    pending: "待生成", generating: "生成中", ready: "已就绪", failed: "生成失败",
  }[shot.status] || shot.status || "待生成";
  const shots = project.shots || [];
  const position = shots.findIndex((item) => item.id === shot.id);
  const cues = (project.subtitle && project.subtitle.cues) || [];
  const cueCount = cues.filter((cue) => cue.endMs > shot.startMs && cue.startMs < shot.endMs).length;
  const review = shot.review || {};
  const hasReview = Boolean(review.prompt || review.image);
  const beat = shot.beat || null;

  host.innerHTML = `
    <div class="shot-head">
      <span class="shot-id">${escapeHtml(shot.id)}</span>
      <span class="shot-time">${formatMs(shot.startMs)} – ${formatMs(shot.endMs)}</span>
      <span class="tag" style="margin-left:auto">${escapeHtml(statusText)}</span>
    </div>
    <div class="shot-meta">
      <span class="tag">${cueCount ? `含 ${cueCount} 句字幕` : "无字幕"}</span>
      ${beat && Number(beat.count) > 1
        ? `<span class="tag">同句 ${Number(beat.index) || 1}/${Number(beat.count)}</span>`
        : ""}
      <span class="tag">台词：${shot.textMode === "manual" ? "手动" : "自动"}</span>
      ${shot.textMode === "manual"
        ? '<button class="mini-btn ghost" type="button" data-action="textAuto">恢复自动</button>'
        : ""}
    </div>
    ${hasReview ? `<div class="review-panel">
      <strong>待处理</strong>
      ${review.prompt
        ? `<div class="review-row"><span>提示词需复核</span>
            <button class="mini-btn" type="button" data-action="regen">重新生成</button>
            <button class="mini-btn ghost" type="button" data-action="reviewPrompt">标记已处理</button></div>`
        : ""}
      ${review.image
        ? `<div class="review-row"><span>图片需确认</span>
            <button class="mini-btn" type="button" data-action="regen">重新生图</button>
            <button class="mini-btn ghost" type="button" data-action="reviewImage">标记已处理</button></div>`
        : ""}
    </div>` : ""}
    ${shot.imageUrl
      ? `<img class="shot-thumb" src="${escapeHtml(shot.imageUrl)}" alt="${escapeHtml(shot.id)}" />`
      : '<div class="shot-thumb empty">还没有画面</div>'}
    <div class="row-actions">
      <button class="btn" data-action="regen">重新生成</button>
      <button class="btn" data-action="upload">上传图片</button>
      <button class="btn ghost" data-action="clear" ${shot.imageUrl ? "" : "disabled"}>清除画面</button>
    </div>
    <div class="row-actions">
      <button class="btn ghost" data-action="split">拆分本段…</button>
      <button class="btn ghost" data-action="mergePrev" ${position > 0 ? "" : "disabled"}>合并到上段</button>
      <button class="btn ghost" data-action="mergeNext" ${position >= 0 && position < shots.length - 1 ? "" : "disabled"}>合并到下段</button>
    </div>

    ${(shot.imageHistory || []).length
      ? `<details class="ver-block">
          <summary>图片版本 <span class="tag">${shot.imageHistory.length}</span></summary>
          <div class="ver-host" data-version-host></div>
        </details>`
      : ""}

    ${(shot.warnings || []).length
      ? `<div class="chips" style="margin-bottom:10px">${shot.warnings
          .map((item) => `<span class="tag warn">${escapeHtml(item)}</span>`).join("")}</div>`
      : ""}
    ${used.length
      ? `<div class="chips" style="margin-bottom:10px">${used
          .map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("")}</div>`
      : ""}

    <div class="field">
      <label>台词</label>
      <textarea class="textarea" data-field="text" data-kind="text">${escapeHtml(shot.text)}</textarea>
    </div>
    <div class="field">
      <label>画面描述（模型产出，可改；改动后自动重拼提示词）</label>
      <textarea class="textarea" data-field="description" data-kind="text">${escapeHtml(shot.description || "")}</textarea>
    </div>
    <div class="field">
      <label>最终提示词</label>
      <textarea class="textarea" data-field="prompt" data-kind="text">${escapeHtml(shot.prompt || "")}</textarea>
    </div>
    <div class="field">
      <label>负面词</label>
      <textarea class="textarea" style="min-height:52px" data-field="negative" data-kind="text">${escapeHtml(shot.negative || "")}</textarea>
    </div>

    <div class="divider"></div>

    <div class="field">
      <label>镜头语言</label>
      <select class="select" data-field="motion.type" data-kind="string">
        ${Object.entries(MOTION_LABEL).map(([value, label]) =>
          `<option value="${value}" ${motion.type === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    <div class="field" ${motion.type && motion.type !== "none" ? "" : "hidden"}>
      <label>运动幅度 <span class="hint">${Number(motion.zoom || 1.06).toFixed(2)}×</span></label>
      <input class="input" type="range" min="1.01" max="1.3" step="0.01"
        data-field="motion.zoom" data-kind="number" value="${Number(motion.zoom || 1.06)}" />
    </div>
    <div class="field">
      <label>转场方式（进入本段）</label>
      <select class="select" data-field="transition.type" data-kind="string">
        ${Object.entries(TRANSITION_LABEL).map(([value, label]) =>
          `<option value="${value}" ${transition.type === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    <div class="field" ${transition.type && transition.type !== "cut" ? "" : "hidden"}>
      <label>转场时长</label>
      <input class="input" type="number" min="80" max="2000" step="20"
        data-field="transition.durationMs" data-kind="number" value="${Number(transition.durationMs || 300)}" />
    </div>
  `;

  bindFields(host, handlers);

  const versionHost = host.querySelector("[data-version-host]");
  if (versionHost) {
    renderVersions(versionHost, shot, {
      onUse: (file) => handlers.useVersion(file),
      onDelete: (file) => handlers.deleteVersion(file),
    });
  }
}

function bindFields(host, handlers) {
  const timers = new Map();
  host.querySelectorAll("[data-field]").forEach((element) => {
    const path = element.dataset.field;
    const kind = element.dataset.kind || "string";
    const commit = () => {
      let value = element.value;
      if (kind === "number") value = Number(value);
      handlers.patchShot(toPatch(path, value));
    };
    if (element.tagName === "SELECT" || element.type === "range") {
      element.addEventListener("change", commit);
      if (element.type === "range") {
        element.addEventListener("input", () => {
          const label = element.closest(".field").querySelector("label .hint");
          if (label) label.textContent = `${Number(element.value).toFixed(2)}×`;
        });
      }
      return;
    }
    element.addEventListener("input", () => {
      clearTimeout(timers.get(path));
      timers.set(path, setTimeout(commit, 700));
    });
  });

  host.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "regen") handlers.regenerate();
      if (action === "upload") handlers.uploadImage();
      if (action === "clear") handlers.clearImage();
      if (action === "textAuto") handlers.setTextMode("auto");
      if (action === "split") handlers.splitShot();
      if (action === "mergePrev") handlers.mergeShot("prev");
      if (action === "mergeNext") handlers.mergeShot("next");
      if (action === "reviewPrompt") handlers.clearReview(["prompt"]);
      if (action === "reviewImage") handlers.clearReview(["image"]);
    });
  });
}

// --------------------------------------------------------------------------- 流程面板

function stepClass(done, active) {
  if (done) return "step done";
  if (active) return "step active";
  return "step";
}

export function renderPipeline(host, state, handlers) {
  const project = state.project;
  if (!project) {
    host.innerHTML = emptyHint("i-settings", "还没有项目");
    return;
  }
  const audio = project.audio || {};
  const cues = (project.subtitle && project.subtitle.cues) || [];
  const shots = project.shots || [];
  const ready = shots.filter((shot) => shot.status === "ready").length;
  const prompts = project.prompts || {};
  const outputs = project.outputs || [];
  const duration = Number(audio.durationMs || 0);

  const steps = [
    {
      title: "音频",
      done: Boolean(audio.file),
      desc: audio.file ? `已上传，时长 ${formatMs(duration)}` : "mp3 / wav / m4a / flac / aac / ogg…（≤200MB）",
      action: "audio",
      label: audio.file ? "重新上传" : "上传",
    },
    {
      title: "时间轴字幕",
      done: Boolean(cues.length),
      desc: cues.length ? `${cues.length} 条字幕` : "srt / vtt / ass / ssa（需带时间轴）",
      action: "subtitle",
      label: cues.length ? "重新上传" : "上传",
    },
    {
      title: "自动分段",
      done: Boolean(shots.length),
      desc: shots.length ? `${shots.length} 段，已对齐到 ${project.canvas.fps}fps` : "按字幕边界切分并吸附静音点",
      action: "segment",
      label: shots.length ? "重新分段" : "开始",
    },
    {
      title: "分镜提示词",
      done: Boolean(prompts.at),
      desc: prompts.at
        ? `${prompts.source === "llm" ? "模型生成" : "模板拼装"}${prompts.error ? " · " + prompts.error : ""}`
        : "模型不可用时会按模板拼装，也可手填",
      action: "prompts",
      label: prompts.at ? "重新生成" : "生成",
    },
    {
      title: "批量生图",
      done: shots.length > 0 && ready === shots.length,
      desc: shots.length
        ? `${ready} / ${shots.length} 段就绪 · 可上传 png / jpg / webp 换图`
        : "先分段，再逐段生成或上传 png / jpg / webp",
      action: "images",
      label: "生成待处理",
    },
    {
      title: "导出成片",
      done: outputs.length > 0,
      desc: outputs.length ? `最近导出 ${outputs[0].createdAt || ""}` : "硬切 / 转场 / 字幕 / 水印 / BGM",
      action: "export",
      label: "导出",
    },
  ];

  host.innerHTML = `
    <div class="steps">
      ${steps.map((step, index) => `
        <div class="${stepClass(step.done, false)}">
          <div class="step-index">${step.done ? "✓" : index + 1}</div>
          <div class="step-main">
            <div class="step-title">${escapeHtml(step.title)}</div>
            <div class="step-desc">${escapeHtml(step.desc)}</div>
          </div>
          <button class="btn" data-action="${step.action}">${escapeHtml(step.label)}</button>
        </div>`).join("")}
    </div>
    ${outputs.length ? `
      <div class="divider"></div>
      <div class="field">
        <label>导出记录</label>
        <div class="chips">
          ${outputs.map((item) => `<a class="tag" href="${escapeHtml(item.url)}" download>${escapeHtml((item.file || "").split("/").pop())}</a>`).join("")}
        </div>
      </div>` : ""}
  `;
  host.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handlers.pipeline(button.dataset.action));
  });
}
