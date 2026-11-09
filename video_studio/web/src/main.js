import { api, toast, formatMs } from "./api.js";
import { getState, setState, shotAt } from "./store.js";
import { Timeline } from "./timeline.js";
import { Storyboard } from "./storyboard.js";
import { HistoryGallery } from "./history.js";
import { initSegmented } from "./ui.js";
import { renderInspector, renderPipeline } from "./inspector.js";

const $ = (id) => document.getElementById(id);
const audioEl = $("audio");

const refs = {
  stage: $("stage"),
  stageArea: document.querySelector(".stage-area"),
  image: $("stageImage"),
  subtitle: $("stageSubtitle"),
  empty: $("stageEmpty"),
  timecode: $("timecode"),
  seek: $("seek"),
  play: $("btnPlay"),
  taskBar: $("taskBar"),
  taskFill: document.querySelector("#taskBar .task-fill"),
  taskLabel: document.querySelector("#taskBar .task-label"),
  inspector: $("inspector"),
  pipeline: $("pipeline"),
  projectSelect: $("projectSelect"),
  tlMeta: $("tlMeta"),
  canvasTag: $("canvasTag"),
  drawer: $("drawer"),
  drawerBody: $("drawerBody"),
  drawerBackdrop: $("drawerBackdrop"),
  timelinePanel: $("timelinePanel"),
  storyboardPanel: $("storyboardPanel"),
  viewSwitch: $("viewSwitch"),
  stageHint: $("stageHint"),
  historyPanel: $("historyPanel"),
  btnTasks: $("btnTasks"),
  taskCenter: $("taskCenter"),
  taskBadge: $("taskBadge"),
  tcMain: $("tcMain"),
  tcList: $("tcList"),
  btnTheme: $("btnTheme"),
  preflight: $("preflight"),
  preflightBackdrop: $("preflightBackdrop"),
  preflightList: $("preflightList"),
  btnSide: $("btnSide"),
  sideBackdrop: $("sideBackdrop"),
};

let timeline = null;
let storyboard = null;
let historyGallery = null;
let viewSwitch = null;
let drawerDraft = null;
let lastStageKey = "";
let rafId = 0;
/** 双击镜头块后的试听区间（ms），播到段尾自动停。 */
let playRange = null;
/** 拆分弹窗里的 ±2s 循环试听区间。 */
let splitLoop = null;
/** 拆分弹窗状态：{shotId, atMs, snap} */
let splitState = null;

// --------------------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function merge(target, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = merge(target[key] || {}, value);
    } else {
      target[key] = value;
    }
  });
  return target;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function currentMs() {
  return Math.max(0, (audioEl.currentTime || 0) * 1000);
}

function duration() {
  const project = getState().project;
  return Number((project && project.audio && project.audio.durationMs) || 0);
}

// --------------------------------------------------------------------------- 启动

async function boot() {
  initTheme();
  timeline = new Timeline(
    {
      inner: $("tlInner"),
      ruler: $("tlRuler"),
      shots: $("tlShots"),
      subs: $("tlSubs"),
      bgm: $("tlBgm"),
      playhead: $("playhead"),
      wave: $("wave"),
      empty: $("tlEmpty"),
      scroll: $("tlScroll"),
    },
    {
      onSeek: (ms) => {
        playRange = null;
        seek(ms);
      },
      onSelect: (id) => selectShot(id),
      onRetime: (id, patch) => retimeShot(id, patch),
      onPlayRange: (shot) => playShot(shot),
      onCueText: (index, text) => editCue(index, text),
      onMerge: (ids) => mergeShotsByIds(ids),
    },
  );

  bindTopbar();
  bindTabs();
  bindTransport();
  bindDrawer();
  bindPreflight();
  bindSidePanel();
  bindSegmentMode();
  bindSplitDialog();
  bindContextBar();

  storyboard = new Storyboard(
    {
      list: $("sbList"),
      count: $("sbCount"),
      filter: $("sbFilter"),
      search: $("sbSearch"),
      bulk: $("sbBulk"),
      bulkCount: $("sbBulkCount"),
      merge: $("sbMerge"),
      bulkClear: $("sbClearSel"),
    },
    {
      onSelect: (id, shot) => {
        selectShot(id);
        if (shot) seek(shot.startMs);
      },
      onPatch: (id, patch) => patchShotById(id, patch),
      onRegenerate: (id) => regenerateShot(id),
      onUpload: (id) => {
        selectShot(id);
        $("fileShotImage").click();
      },
      onLocate: (shot) => {
        setView("timeline");
        selectShot(shot.id);
        seek(shot.startMs);
      },
      onUploadAudio: () => $("fileAudio").click(),
      onUploadSubtitle: () => $("fileSubtitle").click(),
      onUseVersion: (id, file) => useShotVersion(file, id),
      onDeleteVersion: (id, file) => deleteShotVersion(file, id),
      onMerge: (ids) => mergeShotsByIds(ids),
    },
  );

  historyGallery = new HistoryGallery(
    { root: $("historyPanel") },
    { onUse: (payload) => useHistoryImage(payload) },
  );

  bindTaskCenter();
  startTaskPolling();

  viewSwitch = initSegmented(refs.viewSwitch, (view) => setView(view));
  setView(localStorage.getItem("videoStudio.view") === "storyboard" ? "storyboard" : "timeline");

  if (window.ResizeObserver && refs.stageArea) {
    new ResizeObserver(() => fitStage()).observe(refs.stageArea);
  } else {
    window.addEventListener("resize", () => fitStage());
  }

  const [health, schema, projects] = await Promise.all([
    api.get("/api/health").catch((err) => ({ error: err.message })),
    api.get("/api/schema"),
    api.get("/api/projects").catch(() => ({ projects: [] })),
  ]);
  setState({ health, schema, projects: projects.projects || [] });
  renderChips();

  let projectId = localStorage.getItem("videoStudio.project") || "";
  if (!stateProjects().some((item) => item.id === projectId)) {
    projectId = (stateProjects()[0] || {}).id || "";
  }
  if (!projectId && schema) {
    const created = await api.post("/api/projects", { name: "未命名项目" });
    projectId = created.id;
    setState({ projects: [{ id: created.id, name: created.name }] });
  }
  if (projectId) await loadProject(projectId);
  else renderAll();

  window.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        event.preventDefault();
        redo();
        return;
      }
    }
    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 1000 : 100;
      seek(currentMs() + (event.key === "ArrowLeft" ? -step : step));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      seek(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      seek(duration());
    }
  });
}

function stateProjects() {
  return getState().projects || [];
}

const THEME_ORDER = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };
const THEME_ICON = { auto: "#i-auto", light: "#i-sun", dark: "#i-moon" };
let themeMode = "auto";

function initTheme() {
  // 主项目内嵌时用 ?theme= 跟随主项目主题，不覆盖本机的主题偏好
  const fromUrl = new URLSearchParams(location.search).get("theme");
  if (["light", "dark"].includes(fromUrl)) {
    themeMode = fromUrl;
    applyTheme();
    return;
  }
  const saved = localStorage.getItem("videoStudio.theme") || "auto";
  themeMode = ["light", "dark"].includes(saved) ? saved : "auto";
  applyTheme();
}

function applyTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = themeMode === "dark" || (themeMode === "auto" && prefersDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#131619" : "#faf8f4");
  updateThemeButton();
}

function updateThemeButton() {
  const icon = $("themeIcon");
  if (!icon || !refs.btnTheme) return;
  icon.setAttribute("href", THEME_ICON[themeMode]);
  refs.btnTheme.dataset.tip = `主题：${THEME_LABEL[themeMode]}`;
}

function cycleTheme() {
  themeMode = THEME_ORDER[(THEME_ORDER.indexOf(themeMode) + 1) % THEME_ORDER.length];
  if (themeMode === "auto") localStorage.removeItem("videoStudio.theme");
  else localStorage.setItem("videoStudio.theme", themeMode);
  applyTheme();
  toast(`主题：${THEME_LABEL[themeMode]}`);
}

// --------------------------------------------------------------------------- 项目

async function loadProject(projectId, { keepTime = true } = {}) {
  const previous = currentMs();
  const project = await api.get(`/api/projects/${projectId}`);
  if (project.id !== undoProjectId) {
    undoProjectId = project.id;
    undoStack.length = 0;
    redoStack.length = 0;
  }
  localStorage.setItem("videoStudio.project", projectId);
  const list = stateProjects().some((item) => item.id === projectId)
    ? stateProjects()
    : [{ id: project.id, name: project.name }, ...stateProjects()];
  const selected = (project.shots || []).some((shot) => shot.id === getState().selectedId)
    ? getState().selectedId
    : (project.shots || [])[0]?.id || "";
  setState({ project, projects: list, selectedId: selected });
  syncAudio(project, keepTime ? previous : 0);
  renderAll();
}

function syncAudio(project, previousMs) {
  const url = (project.audio && project.audio.url) || "";
  if (audioEl.dataset.url !== url) {
    audioEl.dataset.url = url;
    if (url) {
      audioEl.src = url;
      audioEl.load();
    } else {
      audioEl.removeAttribute("src");
    }
  }
  if (url && previousMs > 0) {
    audioEl.addEventListener(
      "loadedmetadata",
      () => {
        audioEl.currentTime = Math.min(previousMs / 1000, audioEl.duration || 0);
        renderStage();
      },
      { once: true },
    );
  }
}

async function refreshProjects() {
  const data = await api.get("/api/projects");
  setState({ projects: data.projects || [] });
  renderProjectPicker();
}

function renderAll() {
  const state = getState();
  renderProjectPicker();
  renderChips();
  applyCanvasTag();
  renderStage();
  renderSide();
  syncSegmentInputs();
  updateMeta();
  renderContextBar();
  updateTransport();
  if (state.project && timeline) {
    timeline.setProject(state.project, state.selectedId, state.pxPerSec);
    timeline.setPlayhead(currentMs());
  }
  if (state.project && storyboard) {
    storyboard.setProject(state.project, state.selectedId);
  }
}

function syncSegmentInputs() {
  const project = getState().project;
  if (!project) return;
  const config = project.segments || {};
  const gap = Number(config.mergeGapMs ?? 350);
  const max = Number(config.maxShotMs ?? 8000);
  $("mergeGap").value = gap;
  $("maxShot").value = max;
  $("btnSegment").textContent = (project.shots || []).length ? "重新分段" : "自动分段";
  $("segModeLabel").textContent =
    `分段方式 · 合并 ${(gap / 1000).toFixed(2)}s · 上限 ${(max / 1000).toFixed(1)}s`;
  let matched = false;
  document.querySelectorAll("#segmentPopover [data-preset]").forEach((button) => {
    const preset = SEGMENT_PRESETS[button.dataset.preset];
    const active = Boolean(preset
      && preset.mergeGapMs === gap && preset.maxShotMs === max);
    button.classList.toggle("active", active);
    if (active) matched = true;
  });
  if (!matched) {
    const custom = document.querySelector('#segmentPopover [data-preset="custom"]');
    if (custom) custom.classList.add("active");
  }
}

const SEGMENT_PRESETS = {
  sentence: { mergeGapMs: 350, maxShotMs: 8000 },
  pause: { mergeGapMs: 0, maxShotMs: 6000 },
  long: { mergeGapMs: 800, maxShotMs: 10000 },
};

/** 切换「时间线 / 分镜表」：两块共用 selectedId，只有渲染入口不同。 */
function setView(view) {
  const next = view === "storyboard" ? "storyboard" : "timeline";
  document.querySelector(".app").dataset.view = next;
  localStorage.setItem("videoStudio.view", next);
  refs.timelinePanel.hidden = next !== "timeline";
  refs.storyboardPanel.hidden = next !== "storyboard";
  refs.stageHint.textContent = next === "storyboard"
    ? "点一行定位画面；台词与提示词可直接改"
    : "点镜头块看画面，双击只播这一段";
  if (viewSwitch) viewSwitch.set(next);
  if (next === "storyboard") {
    storyboard && storyboard.setProject(getState().project, getState().selectedId);
  } else if (timeline) {
    timeline.setProject(getState().project, getState().selectedId, getState().pxPerSec);
  }
  fitStage();
}

function renderProjectPicker() {
  const state = getState();
  const options = stateProjects();
  refs.projectSelect.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item.id)}" ${
      state.project && item.id === state.project.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`)
    .join("");
}

function renderChips() {
  const { health } = getState();
  const main = (health && health.main) || {};
  const mainChip = $("chipMain");
  const ok = Boolean(main.reachable && main.engineReady);
  mainChip.className = `chip ${ok ? "ok" : main.reachable ? "warn" : "bad"}`;
  mainChip.textContent = ok
    ? `主项目就绪${main.device ? " · " + main.device.replace("NVIDIA GeForce ", "") : ""}`
    : main.reachable
      ? "主项目引擎未就绪"
      : "主项目离线";
  mainChip.title = main.error || `生图服务 ${health?.main?.url || ""}`;

  const ff = $("chipFfmpeg");
  ff.className = `chip ${health && health.ffmpeg ? "ok" : "bad"}`;
  ff.textContent = health && health.ffmpeg ? "ffmpeg 就绪" : "缺 ffmpeg";
}

const RATIO_VALUE = {
  "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3,
  "3:4": 3 / 4, "3:2": 3 / 2, "2:3": 2 / 3, "21:9": 21 / 9,
};

/** 和后端 canvas_size 同一套规则：长边定尺寸，宽高取偶数。 */
function canvasSize(canvas) {
  const ratio = RATIO_VALUE[(canvas || {}).ratio] || 16 / 9;
  const longSide = Math.min(3840, Math.max(480, Number((canvas || {}).longSide) || 1920));
  let width = ratio >= 1 ? longSide : longSide * ratio;
  let height = ratio >= 1 ? longSide / ratio : longSide;
  width = Math.max(320, Math.round(width / 2) * 2);
  height = Math.max(240, Math.round(height / 2) * 2);
  return { width, height };
}

function applyCanvasTag() {
  const project = getState().project;
  if (!project) return;
  const canvas = project.canvas || {};
  const { width, height } = canvasSize(canvas);
  refs.canvasTag.textContent =
    `${canvas.ratio || "16:9"} · ${width}×${height} · ${canvas.fps || 30}fps`;
  refs.canvasTag.title = "导出规格：点击修改画幅 / 分辨率 / 帧率";
  fitStage();
}

function fitStage() {
  const project = getState().project;
  const area = refs.stageArea;
  if (!project || !area) return;
  const ratio = RATIO_VALUE[(project.canvas || {}).ratio] || 16 / 9;
  const availWidth = Math.max(120, area.clientWidth - 24);
  const availHeight = Math.max(80, area.clientHeight - 12);
  const width = Math.min(availWidth, availHeight * ratio);
  refs.stage.style.width = `${Math.round(width)}px`;
  refs.stage.style.height = `${Math.round(width / ratio)}px`;
}

// --------------------------------------------------------------------------- 预览

function renderStage() {
  const state = getState();
  const project = state.project;
  if (!project) {
    refs.stage.classList.remove("has-image");
    return;
  }
  renderEmptyCopy(project);
  const ms = currentMs();
  const shot = shotAt(ms) || (project.shots || []).find((item) => item.id === state.selectedId);
  const url = (shot && shot.imageUrl) || "";
  const key = `${shot ? shot.id : ""}|${url}`;
  if (key !== lastStageKey) {
    lastStageKey = key;
    if (url) {
      refs.image.src = url;
      refs.stage.classList.add("has-image");
    } else {
      refs.image.removeAttribute("src");
      refs.stage.classList.remove("has-image");
    }
  }

  const spec = (project.render || {}).subtitle || {};
  const cue = (project.subtitle && project.subtitle.cues || []).find(
    (item) => ms >= item.startMs && ms < item.endMs,
  );
  const text = spec.enabled && cue ? cue.text : "";
  if (refs.subtitle.textContent !== text) refs.subtitle.textContent = text;
  refs.subtitle.className = `subtitle ${spec.position || "bottom"}`;

  if (project.shots && project.shots.length) refs.empty.hidden = true;
  else refs.empty.hidden = false;
}

/** 空状态按「缺什么」给出下一步和对应格式，避免用户不知道传什么。 */
function renderEmptyCopy(project) {
  const title = $("emptyTitle");
  if (!title) return;
  const desc = $("emptyDesc");
  const hint = $("emptyHint");
  const hasAudio = Number((project.audio || {}).durationMs) > 0;
  const cues = (project.subtitle && project.subtitle.cues) || [];
  if (!hasAudio) {
    title.textContent = "先上传一段音频";
    desc.innerHTML =
      "音频：mp3 / wav / m4a / flac / aac / ogg / opus / wma / mp4 / mov（≤200MB）<br />"
      + "带声音的视频也可以直接上传（mp4 / mov）。";
    hint.textContent = "再准备一份带时间轴的逐字稿（srt / vtt / ass / ssa）。";
    return;
  }
  if (!cues.length) {
    title.textContent = "音频已就绪，再上传字幕";
    desc.innerHTML = "字幕：srt / vtt / ass / ssa，每条都要有起止时间（≤5MB）。";
    hint.textContent = "没有现成字幕？先在剪辑软件里自动识别并导出 SRT。";
    return;
  }
  title.textContent = "素材齐了，点「自动分段」开始";
  desc.innerHTML = `已载入 ${cues.length} 条字幕 · 音频时长 ${formatMs(duration())}`;
  hint.textContent = "分段后可逐段改画面描述、生成提示词与图片。";
}

function updateTransport() {
  const total = duration();
  const ms = currentMs();
  refs.timecode.textContent = `${formatMs(ms)} / ${formatMs(total)}`;
  refs.seek.value = total ? String(Math.round((ms / total) * 1000)) : "0";
  refs.play.classList.toggle("is-playing", !audioEl.paused);
}

function loop() {
  if (audioEl.paused) {
    rafId = 0;
    return;
  }
  if (splitLoop && currentMs() >= splitLoop.endMs) {
    audioEl.currentTime = splitLoop.startMs / 1000;
    audioEl.play().catch(() => {});
  }
  if (!splitLoop && playRange && currentMs() >= playRange.endMs) {
    const stop = playRange.endMs;
    playRange = null;
    audioEl.pause();
    seek(stop);
    rafId = 0;
    return;
  }
  updateTransport();
  timeline && timeline.setPlayhead(currentMs());
  renderStage();
  selectFollow(currentMs());
  rafId = requestAnimationFrame(loop);
}

function selectFollow(ms) {
  const state = getState();
  // 正在编辑检查器时不要抢焦点
  const active = document.activeElement;
  if (active && refs.inspector.contains(active)
      && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  const shot = shotAt(ms);
  if (!shot || shot.id === state.selectedId) return;
  // 播放/跳转时跟随高亮
  setState({ selectedId: shot.id });
  timeline && timeline.setSelected(shot.id);
  storyboard && storyboard.setSelected(shot.id, false);
  renderInspector(refs.inspector, getState(), shotHandlers());
  renderContextBar();
}

function togglePlay() {
  if (!duration() || !audioEl.src) {
    toast("还没有音频", "bad");
    return;
  }
  if (audioEl.paused) {
    audioEl.play().then(() => {
      if (!rafId) rafId = requestAnimationFrame(loop);
    }).catch((err) => toast(err.message, "bad"));
  } else {
    audioEl.pause();
  }
}

function seek(ms) {
  const total = duration();
  const value = Math.max(0, Math.min(total || 0, ms));
  if (audioEl.src) audioEl.currentTime = value / 1000;
  timeline && timeline.setPlayhead(value);
  updateTransport();
  renderStage();
  selectFollow(value);
}

/** 双击镜头块：只播这一段，段尾自动停。再双击一次重播。 */
function playShot(shot) {
  if (!shot || !audioEl.src) {
    toast("还没有音频", "bad");
    return;
  }
  seek(shot.startMs);
  playRange = { startMs: shot.startMs, endMs: shot.endMs };
  audioEl.play().then(() => {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }).catch((err) => toast(err.message, "bad"));
}

function bindTransport() {
  refs.play.addEventListener("click", togglePlay);
  refs.canvasTag.addEventListener("click", () => openDrawer());
  refs.seek.addEventListener("input", () => {
    playRange = null;
    seek((Number(refs.seek.value) / 1000) * duration());
  });
  audioEl.addEventListener("play", () => {
    refs.play.classList.add("is-playing");
    if (!rafId) rafId = requestAnimationFrame(loop);
  });
  audioEl.addEventListener("pause", () => {
    refs.play.classList.remove("is-playing");
    updateTransport();
  });
  audioEl.addEventListener("timeupdate", () => {
    updateTransport();
    timeline && timeline.setPlayhead(currentMs());
    renderStage();
    selectFollow(currentMs());
  });
  audioEl.addEventListener("ended", () => {
    updateTransport();
    cancelAnimationFrame(rafId);
    rafId = 0;
  });
}

// --------------------------------------------------------------------------- 侧栏

function renderSide() {
  const state = getState();
  renderInspector(refs.inspector, state, shotHandlers());
  renderPipeline(refs.pipeline, state, {
    pipeline: (action) => pipelineAction(action),
  });
}

function bindTabs() {
  const panels = {
    shot: refs.inspector,
    pipeline: refs.pipeline,
    history: refs.historyPanel,
  };
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
      const name = tab.dataset.tab;
      Object.entries(panels).forEach(([key, node]) => {
        if (node) node.hidden = key !== name;
      });
      if (name === "history" && historyGallery) historyGallery.load();
    });
  });
}

function selectShot(id) {
  setState({ selectedId: id });
  renderInspector(refs.inspector, getState(), shotHandlers());
  timeline && timeline.setSelected(id);
  storyboard && storyboard.setSelected(id, true);
  renderContextBar();
  renderStage();
}

function selectedShot() {
  const project = getState().project;
  return ((project && project.shots) || []).find((shot) => shot.id === getState().selectedId) || null;
}

function shotHandlers() {
  return {
    patchShot: (patch) => patchShot(patch),
    regenerate: () => regenerateShot(),
    uploadImage: () => $("fileShotImage").click(),
    clearImage: () => clearShotImage(),
    useVersion: (file) => useShotVersion(file),
    deleteVersion: (file) => deleteShotVersion(file),
    splitShot: () => openSplitDialog(),
    mergeShot: (direction) => mergeWithNeighbor(direction),
    setTextMode: (mode) => setShotTextMode(mode),
    clearReview: (fields) => clearShotReview(fields),
  };
}

async function patchShot(patch) {
  return patchShotById(getState().selectedId, patch);
}

/** 按段 id 提交改动：时间线与分镜表共用同一入口，返回更新后的 shot。 */
async function patchShotById(shotId, patch) {
  const state = getState();
  if (!state.project || !shotId) return null;
  pushUndo();
  try {
    const result = await api.patch(
      `/api/projects/${state.project.id}/shots/${shotId}`,
      patch,
    );
    const shots = (state.project.shots || []).map((shot) =>
      shot.id === result.shot.id ? result.shot : shot);
    setState({ project: { ...state.project, shots } });
    updateMeta();
    timeline && timeline.setProject(getState().project, getState().selectedId, getState().pxPerSec);
    storyboard && storyboard.setProject(getState().project, getState().selectedId);
    renderContextBar();
    renderStage();
    if (shotId === getState().selectedId) {
      const active = document.activeElement;
      if (!active || !refs.inspector.contains(active)) {
        // 改动来自分镜表或其他入口时，检查器要跟着刷新
        renderInspector(refs.inspector, getState(), shotHandlers());
      } else {
        const promptEl = refs.inspector.querySelector('[data-field="prompt"]');
        if (promptEl && active !== promptEl) promptEl.value = result.shot.prompt || "";
      }
    }
    return result.shot;
  } catch (err) {
    toast(err.message, "bad");
    return null;
  }
}

async function retimeShot(shotId, patch) {
  const state = getState();
  if (!state.project) return;
  pushUndo();
  try {
    await api.patch(`/api/projects/${state.project.id}/shots/${shotId}`, patch);
    const project = await api.get(`/api/projects/${state.project.id}`);
    setState({ project });
    renderAll();
  } catch (err) {
    toast(err.message, "bad");
    renderAll();
  }
}

// --------------------------------------------------------------------------- 分段方式

function bindSegmentMode() {
  const popover = $("segmentPopover");
  const trigger = $("btnSegmentMode");
  const open = (value) => {
    popover.hidden = !value;
    trigger.setAttribute("aria-expanded", value ? "true" : "false");
    if (value) {
      syncSegmentInputs();
      refreshSegmentPreview();
    }
  };
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    open(popover.hidden);
  });
  $("segCancel").addEventListener("click", () => open(false));
  $("segApply").addEventListener("click", () => {
    open(false);
    applySegmentation();
  });
  popover.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => {
    if (!popover.hidden) open(false);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) open(false);
  });

  popover.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const preset = SEGMENT_PRESETS[button.dataset.preset];
      if (preset) {
        $("mergeGap").value = preset.mergeGapMs;
        $("maxShot").value = preset.maxShotMs;
        syncSegmentInputs();
      }
      popover.querySelectorAll("[data-preset]").forEach((item) =>
        item.classList.toggle("active", item === button));
      refreshSegmentPreview();
    });
  });
  ["mergeGap", "maxShot"].forEach((id) => {
    $(id).addEventListener("input", () => {
      popover.querySelectorAll("[data-preset]").forEach((item) => item.classList.remove("active"));
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshSegmentPreview, 260);
    });
  });
}

let previewTimer = 0;

/** 分段参数改动后实时预览段数，让用户知道两个数字到底影响什么。 */
async function refreshSegmentPreview() {
  const project = getState().project;
  const hint = $("segPreview");
  if (!project || !hint) return;
  if (!(project.subtitle || {}).cues || !((project.subtitle || {}).cues || []).length) {
    hint.textContent = "还没有字幕，无法预览分段";
    return;
  }
  try {
    const result = await api.post(`/api/projects/${project.id}/segments/preview`, {
      mergeGapMs: Number($("mergeGap").value) || 0,
      maxShotMs: Number($("maxShot").value) || 8000,
    });
    hint.textContent = `预计 ${result.summary.count} 段 · ${formatMs(result.summary.durationMs)}`;
  } catch (err) {
    hint.textContent = err.message;
  }
}

async function applySegmentation() {
  const project = getState().project;
  if (!project) return;
  const shots = project.shots || [];
  if (shots.length) {
    const manual = shots.filter((shot) => shot.textMode === "manual" || shot.beat || shot.review).length;
    const images = shots.filter((shot) => shot.image).length;
    const facts = [manual ? `${manual} 个手动调整段` : "", images ? `${images} 张已生成图片` : ""]
      .filter(Boolean);
    const extra = facts.length ? `将覆盖 ${facts.join("、")}。` : "";
    if (!window.confirm(`按字幕重新切开全片。${extra}确定继续？`)) return;
  }
  pushUndo();
  try {
    await api.post(`/api/projects/${project.id}/segments/apply`, {
      mergeGapMs: Number($("mergeGap").value) || 0,
      maxShotMs: Number($("maxShot").value) || 8000,
      preserveImages: false,
    });
    await loadProject(project.id);
    toast("已完成分段", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

/** 选中段落上下文操作条 + 待处理计数入口。 */
function bindContextBar() {
  $("tlContext").addEventListener("click", (event) => {
    const button = event.target.closest("[data-ctx]");
    if (!button) return;
    const shot = selectedShot();
    if (!shot) return;
    if (button.dataset.ctx === "split") openSplitDialog(shot.id, currentMs());
    if (button.dataset.ctx === "mergePrev") mergeWithNeighbor("prev");
    if (button.dataset.ctx === "mergeNext") mergeWithNeighbor("next");
  });
  $("btnReview").addEventListener("click", () => {
    setView("storyboard");
    storyboard && storyboard.setFilter("review");
  });
}

// --------------------------------------------------------------------------- 合并 / 拆分

function renderContextBar() {
  const bar = $("tlContext");
  if (!bar) return;
  const project = getState().project;
  const shot = selectedShot();
  if (!project || !shot) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const shots = project.shots || [];
  const index = shots.findIndex((item) => item.id === shot.id);
  const cues = (project.subtitle && project.subtitle.cues) || [];
  const cueCount = cues.filter((cue) => cue.endMs > shot.startMs && cue.startMs < shot.endMs).length;
  const durationSec = Math.max(0, shot.endMs - shot.startMs) / 1000;
  $("ctxInfo").textContent =
    `${shot.id} · ${formatMs(shot.startMs)} – ${formatMs(shot.endMs)} · ${durationSec.toFixed(1)}s · ${cueCount ? `含 ${cueCount} 句` : "无字幕"}`;
  const prev = bar.querySelector('[data-ctx="mergePrev"]');
  const next = bar.querySelector('[data-ctx="mergeNext"]');
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= shots.length - 1;
}

/** 合并连续镜头段：字幕不动，只换画面。 */
async function mergeShotsByIds(shotIds) {
  const project = getState().project;
  if (!project || !shotIds || shotIds.length < 2) return;
  const order = (project.shots || []).map((shot) => shot.id);
  const ids = [...shotIds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  pushUndo();
  try {
    const updated = await api.post(`/api/projects/${project.id}/shots/merge`, { shotIds: ids });
    setState({ project: updated, selectedId: ids[0] });
    storyboard && storyboard.clearChecked();
    renderAll();
    toast(`已合并 ${ids.length} 个画面，提示词与图片待复核`, "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

function mergeWithNeighbor(direction) {
  const project = getState().project;
  const shot = selectedShot();
  if (!project || !shot) return;
  const shots = project.shots || [];
  const index = shots.findIndex((item) => item.id === shot.id);
  const neighbor = direction === "prev" ? shots[index - 1] : shots[index + 1];
  if (!neighbor) {
    toast(direction === "prev" ? "已经是第一段" : "已经是最后一段");
    return;
  }
  mergeShotsByIds(direction === "prev" ? [neighbor.id, shot.id] : [shot.id, neighbor.id]);
}

async function setShotTextMode(mode) {
  const project = getState().project;
  const shot = selectedShot();
  if (!project || !shot) return;
  pushUndo();
  try {
    await api.patch(`/api/projects/${project.id}/shots/${shot.id}`, { textMode: mode });
    const updated = await api.get(`/api/projects/${project.id}`);
    setState({ project: updated });
    renderAll();
    toast(mode === "auto" ? "台词已恢复为跟随字幕" : "台词已转为手动", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function clearShotReview(fields) {
  const project = getState().project;
  const shot = selectedShot();
  if (!project || !shot) return;
  pushUndo();
  try {
    const updated = await api.post(
      `/api/projects/${project.id}/shots/${shot.id}/review/clear`, { fields });
    setState({ project: updated });
    renderAll();
    toast("已标记处理", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

// --------------------------------------------------------------------------- 拆分弹窗

function bindSplitDialog() {
  $("splitClose").addEventListener("click", closeSplitDialog);
  $("splitCancel").addEventListener("click", closeSplitDialog);
  $("splitBackdrop").addEventListener("click", closeSplitDialog);
  $("splitSnap").addEventListener("change", () => {
    if (splitState) splitState.snap = $("splitSnap").checked;
    syncSplitDialog();
  });
  $("splitDialog").addEventListener("click", (event) => {
    const nudge = event.target.closest("[data-nudge]");
    if (nudge && splitState) {
      nudgeSplit(Number(nudge.dataset.nudge));
      return;
    }
    const parts = event.target.closest("[data-parts]");
    if (parts) splitIntoParts(Number(parts.dataset.parts));
  });
  $("splitPlay").addEventListener("click", startSplitPreview);
  $("splitConfirm").addEventListener("click", confirmSplit);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("splitDialog").hidden) closeSplitDialog();
  });
}

/** 打开拆分弹窗：默认从播放头取切点，太靠边时退到段落中点。 */
function openSplitDialog(shotId = getState().selectedId, atMs = currentMs()) {
  const project = getState().project;
  if (!project) return;
  const shot = (project.shots || []).find((item) => item.id === shotId);
  if (!shot) {
    toast("先选一个镜头段", "bad");
    return;
  }
  const frame = 1000 / Number((project.canvas || {}).fps || 30);
  let cut = Math.round(Number(atMs) || 0);
  if (cut < shot.startMs + frame || cut > shot.endMs - frame) {
    cut = Math.round((shot.startMs + shot.endMs) / 2);
  }
  splitState = { shotId: shot.id, atMs: cut, snap: $("splitSnap").checked };
  $("splitBackdrop").hidden = false;
  $("splitDialog").hidden = false;
  playRange = null;
  syncSplitDialog();
}

function closeSplitDialog() {
  $("splitDialog").hidden = true;
  $("splitBackdrop").hidden = true;
  splitState = null;
  splitLoop = null;
  audioEl.pause();
}

function syncSplitDialog() {
  if (!splitState) return;
  const project = getState().project;
  const shot = (project.shots || []).find((item) => item.id === splitState.shotId);
  if (!shot) return;
  const frame = 1000 / Number((project.canvas || {}).fps || 30);
  const minimum = shot.startMs + Math.round(frame);
  const maximum = shot.endMs - Math.round(frame);
  splitState.atMs = Math.max(minimum, Math.min(maximum, Math.round(splitState.atMs)));
  $("splitTime").textContent = formatMs(splitState.atMs);
  const before = (splitState.atMs - shot.startMs) / 1000;
  const after = (shot.endMs - splitState.atMs) / 1000;
  $("splitHint").textContent = splitState.atMs <= minimum || splitState.atMs >= maximum
    ? "切点太靠近段落边缘，至少留 1 帧"
    : `前半 ${before.toFixed(2)}s · 后半 ${after.toFixed(2)}s${splitState.snap ? " · 会自动吸附字幕边界" : ""}`;
  seekNoSelect(splitState.atMs);
}

function seekNoSelect(ms) {
  const total = duration();
  const value = Math.max(0, Math.min(total || 0, ms));
  if (audioEl.src) audioEl.currentTime = value / 1000;
  timeline && timeline.setPlayhead(value);
  updateTransport();
  renderStage();
}

function nudgeSplit(delta) {
  if (!splitState) return;
  const project = getState().project;
  const shot = (project.shots || []).find((item) => item.id === splitState.shotId);
  if (!shot) return;
  const frame = 1000 / Number((project.canvas || {}).fps || 30);
  splitState.atMs = Math.max(shot.startMs + frame, Math.min(shot.endMs - frame,
    splitState.atMs + delta));
  syncSplitDialog();
}

function startSplitPreview() {
  if (!splitState || !audioEl.src) {
    toast("还没有音频", "bad");
    return;
  }
  const project = getState().project;
  const shot = (project.shots || []).find((item) => item.id === splitState.shotId);
  if (!shot) return;
  const start = Math.max(shot.startMs, splitState.atMs - 2000);
  const end = Math.min(shot.endMs, splitState.atMs + 2000);
  splitLoop = { startMs: start, endMs: end };
  audioEl.currentTime = start / 1000;
  audioEl.play().then(() => {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }).catch((err) => toast(err.message, "bad"));
}

async function confirmSplit() {
  if (!splitState) return;
  const project = getState().project;
  if (!project) return;
  const shotId = splitState.shotId;
  const atMs = splitState.atMs;
  const snapCues = splitState.snap;
  closeSplitDialog();
  pushUndo();
  try {
    const updated = await api.post(
      `/api/projects/${project.id}/shots/${shotId}/split`, { atMs, snapCues });
    setState({ project: updated, selectedId: shotId });
    renderAll();
    toast("已拆分为两个画面，右段待补图", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function splitIntoParts(parts) {
  if (!splitState) return;
  const project = getState().project;
  if (!project) return;
  const shotId = splitState.shotId;
  closeSplitDialog();
  pushUndo();
  try {
    const updated = await api.post(
      `/api/projects/${project.id}/shots/${shotId}/split`, { parts });
    setState({ project: updated, selectedId: shotId });
    renderAll();
    toast(`已均分为 ${parts} 个画面，请复核提示词`, "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

/** 时间线上就地改字幕文案：只改 cues，导出时 ASS 会用同一份数据。 */
async function editCue(index, text) {
  const state = getState();
  if (!state.project) return;
  const cues = ((state.project.subtitle || {}).cues || []).map((cue, position) =>
    (position === index ? { ...cue, text } : cue));
  try {
    const updated = await api.patch(
      `/api/projects/${state.project.id}/subtitle/cues`, { cues });
    setState({ project: updated });
    renderAll();
    toast("字幕已更新", "ok");
  } catch (err) {
    toast(err.message, "bad");
    renderAll();
  }
}

async function clearShotImage() {
  const state = getState();
  if (!state.project || !state.selectedId) return;
  pushUndo();
  try {
    const project = await api.post(
      `/api/projects/${state.project.id}/shots/${state.selectedId}/clear`,
    );
    setState({ project });
    renderAll();
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function useShotVersion(file, shotId = getState().selectedId) {
  const state = getState();
  if (!state.project || !shotId) return;
  pushUndo();
  try {
    const project = await api.post(
      `/api/projects/${state.project.id}/shots/${shotId}/versions/use`, { file });
    setState({ project });
    renderAll();
    toast("已切换到该版本", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function deleteShotVersion(file, shotId = getState().selectedId) {
  const state = getState();
  if (!state.project || !shotId) return;
  if (!window.confirm("删除这个版本？图片文件会一起删掉，且不可恢复。")) return;
  try {
    const project = await api.del(
      `/api/projects/${state.project.id}/shots/${shotId}/versions`, { file });
    setState({ project });
    renderAll();
    toast("版本已删除", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

// --------------------------------------------------------------------------- 任务中心

const TASK_STATUS = {
  queued: "排队中",
  running: "进行中",
  done: "完成",
  error: "失败",
  canceled: "已取消",
  interrupted: "已中断",
};

let taskCache = [];
let mainQueue = null;
let taskTimer = 0;

function startTaskPolling() {
  refreshTasks();
  if (taskTimer) clearInterval(taskTimer);
  taskTimer = setInterval(refreshTasks, 3000);
}

async function refreshTasks() {
  const project = getState().project;
  const query = project
    ? `?projectId=${encodeURIComponent(project.id)}&limit=50`
    : "?limit=50";
  try {
    const data = await api.get(`/api/tasks${query}`);
    taskCache = data.tasks || [];
  } catch (err) {
    return;
  }
  renderTaskBadge();
  if (!refs.taskCenter.hidden) {
    renderTaskCenter();
    refreshMainQueue();
  }
}

function renderTaskBadge() {
  if (!refs.taskBadge) return;
  const active = taskCache.filter((task) => ["queued", "running"].includes(task.status)).length;
  refs.taskBadge.hidden = !active;
  refs.taskBadge.textContent = String(active);
}

function bindTaskCenter() {
  refs.btnTasks.addEventListener("click", () => {
    const open = refs.taskCenter.hidden;
    refs.taskCenter.hidden = !open;
    refs.btnTasks.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderTaskCenter();
      refreshMainQueue();
    }
  });
  document.addEventListener("click", (event) => {
    if (refs.taskCenter.hidden) return;
    if (refs.taskCenter.contains(event.target) || refs.btnTasks.contains(event.target)) return;
    refs.taskCenter.hidden = true;
    refs.btnTasks.setAttribute("aria-expanded", "false");
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || refs.taskCenter.hidden) return;
    refs.taskCenter.hidden = true;
    refs.btnTasks.setAttribute("aria-expanded", "false");
  });
  refs.tcList.addEventListener("click", (event) => {
    const action = event.target.closest("[data-task-action]");
    if (!action) return;
    const task = taskCache.find((item) => item.id === action.dataset.id);
    if (!task) return;
    const kind = action.dataset.taskAction;
    if (kind === "cancel") cancelTask(task);
    if (kind === "retry") retryTask(task);
    if (kind === "failures") showTaskFailures(task);
  });
}

async function refreshMainQueue() {
  try {
    mainQueue = await api.get("/api/main/queue");
  } catch (err) {
    mainQueue = { reachable: false, error: err.message };
  }
  renderMainQueue();
}

function renderMainQueue() {
  if (!refs.tcMain) return;
  if (!mainQueue) {
    refs.tcMain.textContent = "主项目：—";
    return;
  }
  if (!mainQueue.reachable) {
    refs.tcMain.textContent = "主项目离线";
    return;
  }
  refs.tcMain.textContent =
    `主项目：运行中 ${mainQueue.running ? 1 : 0} · 排队 ${Number(mainQueue.pending) || 0}`;
}

function renderTaskCenter() {
  if (!refs.tcList) return;
  if (!taskCache.length) {
    refs.tcList.innerHTML =
      '<div class="tc-empty">还没有任务。批量生图、提示词、导出都会出现在这里。</div>';
    return;
  }
  const scrollTop = refs.tcList.scrollTop;
  const queued = taskCache.filter((task) => task.status === "queued");
  refs.tcList.innerHTML = taskCache.map((task) => taskRowHtml(task, queued)).join("");
  refs.tcList.scrollTop = scrollTop;
}

function taskRowHtml(task, queued) {
  const status = task.status || "";
  const active = ["queued", "running"].includes(status);
  const progress = task.progress || {};
  const value = Math.max(0, Math.min(100, Number(progress.value) || 0));
  const result = task.result || {};
  const failed = Array.isArray(result.failed) ? result.failed : [];
  const queuedAhead = status === "queued"
    ? queued.filter((item) => (item.createdAt || 0) < (task.createdAt || 0)).length
    : 0;

  let summary = "";
  if (status === "done") {
    if (task.kind === "images") {
      summary = `生成 ${result.generated ?? 0}/${result.total ?? 0} 段`
        + (failed.length ? ` · 失败 ${failed.length}` : "");
    } else if (task.kind === "render") {
      summary = result.file ? String(result.file).split("/").pop() : "成片已导出";
    } else if (task.kind === "image") {
      summary = task.shotId ? `完成 ${task.shotId}` : "已完成";
    } else {
      summary = "已完成";
    }
  } else if (status === "running") {
    summary = progress.label || "处理中";
  } else if (status === "queued") {
    summary = queuedAhead ? `排队中（前面还有 ${queuedAhead} 个）` : "排队中";
  }

  let actions = "";
  const id = escapeHtml(task.id);
  if (active) {
    actions += `<button class="mini-btn" type="button" data-task-action="cancel" data-id="${id}">取消</button>`;
  }
  if (["error", "interrupted"].includes(status)) {
    actions += `<button class="mini-btn" type="button" data-task-action="retry" data-id="${id}">重试</button>`;
  }
  if (status === "done" && task.kind === "images" && failed.length) {
    actions += `<button class="mini-btn" type="button" data-task-action="failures" data-id="${id}">查看失败</button>`;
  }

  const elapsed = task.elapsedMs ? `${Math.round(task.elapsedMs / 1000)}s` : "";
  return `<div class="tc-row" data-id="${id}">
    <div class="tc-row-top">
      <span class="tc-title">${escapeHtml(task.title || task.kind || "任务")}</span>
      <span class="tc-status ${escapeHtml(status)}">${escapeHtml(TASK_STATUS[status] || status)}</span>
    </div>
    ${active ? `<div class="tc-progress"><i style="width:${value}%"></i></div>` : ""}
    <div class="tc-sub">
      <span>${escapeHtml(summary)}</span>
      ${status === "running" ? `<span>${value}%</span>` : ""}
      ${elapsed ? `<span>${escapeHtml(elapsed)}</span>` : ""}
      <span class="tc-actions">${actions}</span>
    </div>
    ${task.error && !["done"].includes(status)
      ? `<div class="tc-error">${escapeHtml(task.error)}</div>`
      : ""}
  </div>`;
}

async function cancelTask(task) {
  try {
    await api.post(`/api/tasks/${task.id}/cancel`);
    toast("已请求取消任务");
    refreshTasks();
  } catch (err) {
    toast(err.message, "bad");
  }
}

function retryTask(task) {
  const project = getState().project;
  if (!project) return;
  const base = `/api/projects/${project.id}`;
  if (task.kind === "image" && task.shotId) {
    runTask(`${base}/images/${task.shotId}`, "重新生成该镜头");
    return;
  }
  if (task.kind === "images") {
    const failed = ((task.result || {}).failed || [])
      .map((item) => item.id).filter(Boolean);
    runTask(`${base}/images`, "重试失败段", failed.length ? { shotIds: failed } : {});
    return;
  }
  if (task.kind === "prompts") {
    runTask(`${base}/prompts`, "生成分镜提示词");
    return;
  }
  if (task.kind === "render") {
    runTask(`${base}/render`, "导出成片");
    return;
  }
  toast("这个任务暂不支持一键重试");
}

function showTaskFailures(task) {
  const failed = ((task.result || {}).failed || [])
    .map((item) => item.id).filter(Boolean);
  if (!failed.length) {
    toast("这条任务没有失败项");
    return;
  }
  refs.taskCenter.hidden = true;
  refs.btnTasks.setAttribute("aria-expanded", "false");
  setView("storyboard");
  if (storyboard) storyboard.setFilter("failed");
  selectShot(failed[0]);
  const shot = (getState().project.shots || []).find((item) => item.id === failed[0]);
  if (shot) seek(shot.startMs);
}

// --------------------------------------------------------------------------- 历史图库

async function useHistoryImage({ jobId, imageIndex }) {
  const state = getState();
  if (!state.project || !state.selectedId) {
    toast("先选一个镜头段，再从历史里取图", "bad");
    return;
  }
  pushUndo();
  try {
    const project = await api.post(
      `/api/projects/${state.project.id}/shots/${state.selectedId}/image/from-history`,
      { jobId, imageIndex },
    );
    setState({ project });
    renderAll();
    toast(`已用到 ${state.selectedId}`, "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

// --------------------------------------------------------------------------- 撤销 / 重做

const HISTORY_LIMIT = 20;
const undoStack = [];
const redoStack = [];
let undoProjectId = "";

function snapshotShots() {
  const project = getState().project;
  if (!project) return null;
  const shots = (project.shots || []).map(({ imageUrl, ...rest }) => rest);
  return JSON.parse(JSON.stringify(shots));
}

function pushUndo() {
  const shots = snapshotShots();
  if (!shots) return;
  const projectId = getState().project.id;
  if (undoProjectId !== projectId) {
    undoProjectId = projectId;
    undoStack.length = 0;
    redoStack.length = 0;
  }
  const key = JSON.stringify(shots);
  const last = undoStack[undoStack.length - 1];
  redoStack.length = 0;
  if (last && last.key === key) return;
  undoStack.push({ shots, key, selectedId: getState().selectedId });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
}

async function restoreShots(entry) {
  const state = getState();
  if (!state.project) return;
  const project = await api.post(`/api/projects/${state.project.id}/restore`, { shots: entry.shots });
  const ids = new Set((project.shots || []).map((shot) => shot.id));
  const selectedId = ids.has(entry.selectedId)
    ? entry.selectedId
    : ((project.shots || [])[0] || {}).id || "";
  setState({ project, selectedId });
  renderAll();
}

async function undo() {
  const state = getState();
  if (!state.project) return;
  if (undoProjectId !== state.project.id) {
    undoStack.length = 0;
    redoStack.length = 0;
  }
  if (!undoStack.length) {
    toast("没有可撤销的改动");
    return;
  }
  const entry = undoStack.pop();
  redoStack.push({ shots: snapshotShots(), selectedId: state.selectedId });
  try {
    await restoreShots(entry);
    toast("已撤销");
  } catch (err) {
    toast(err.message, "bad");
    undoStack.push(entry);
  }
}

async function redo() {
  const state = getState();
  if (!state.project) return;
  if (undoProjectId !== state.project.id) {
    undoStack.length = 0;
    redoStack.length = 0;
  }
  if (!redoStack.length) {
    toast("没有可重做的改动");
    return;
  }
  const entry = redoStack.pop();
  const current = snapshotShots();
  undoStack.push({ shots: current, key: JSON.stringify(current), selectedId: state.selectedId });
  try {
    await restoreShots(entry);
    toast("已重做");
  } catch (err) {
    toast(err.message, "bad");
    redoStack.push(entry);
  }
}

// --------------------------------------------------------------------------- 顶栏动作

function bindTopbar() {
  $("btnAudio").addEventListener("click", () => $("fileAudio").click());
  $("emptyAudio").addEventListener("click", () => $("fileAudio").click());
  $("btnSubtitle").addEventListener("click", () => $("fileSubtitle").click());
  $("emptySubtitle").addEventListener("click", () => $("fileSubtitle").click());
  $("btnExport").addEventListener("click", () => pipelineAction("export"));
  $("btnSettings").addEventListener("click", () => openDrawer());
  $("btnSegment").addEventListener("click", () => pipelineAction("segment"));
  if (refs.btnTheme) refs.btnTheme.addEventListener("click", cycleTheme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeMode === "auto") applyTheme();
  });

  refs.projectSelect.addEventListener("change", () => {
    loadProject(refs.projectSelect.value, { keepTime: false });
  });

  $("btnNewProject").addEventListener("click", async () => {
    const name = window.prompt("项目名称", "未命名项目");
    if (name === null) return;
    try {
      const project = await api.post("/api/projects", { name: name.trim() || "未命名项目" });
      setState({ projects: [{ id: project.id, name: project.name }, ...stateProjects()] });
      await loadProject(project.id, { keepTime: false });
    } catch (err) {
      toast(err.message, "bad");
    }
  });

  $("fileAudio").addEventListener("change", (event) => uploadFile(event, "audio"));
  $("fileSubtitle").addEventListener("change", (event) => uploadFile(event, "subtitle"));
  $("fileBgm").addEventListener("change", (event) => uploadFile(event, "bgm"));
  $("fileShotImage").addEventListener("change", (event) => uploadFile(event, "shotImage"));
  $("zoom").addEventListener("input", () => {
    setState({ pxPerSec: Number($("zoom").value) });
    timeline && timeline.setProject(getState().project, getState().selectedId, getState().pxPerSec);
  });
}

async function uploadFile(event, kind) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  const project = getState().project;
  if (!file || !project) return;
  const path = {
    audio: `/api/projects/${project.id}/audio`,
    subtitle: `/api/projects/${project.id}/subtitle`,
    bgm: `/api/projects/${project.id}/bgm`,
  }[kind];
  try {
    if (kind === "shotImage") {
      if (!getState().selectedId) {
        toast("先选一个镜头段", "bad");
        return;
      }
      pushUndo();
      const updated = await api.upload(
        `/api/projects/${project.id}/shots/${getState().selectedId}/image`, file);
      setState({ project: updated });
      renderAll();
      toast("图片已替换", "ok");
      return;
    }
    toast(kind === "audio" ? "正在解析音频…" : "正在解析字幕…");
    await api.upload(path, file);
    await loadProject(project.id, { keepTime: kind !== "audio" });
    toast(kind === "audio" ? "音频已就绪" : kind === "subtitle" ? "字幕已解析" : "背景音乐已就绪", "ok");
  } catch (err) {
    toast(err.message, "bad");
  }
}

// --------------------------------------------------------------------------- 流程动作

async function pipelineAction(action) {
  const project = getState().project;
  if (!project) return;
  if (action === "audio") return $("fileAudio").click();
  if (action === "subtitle") return $("fileSubtitle").click();
  if (action === "bgm") return $("fileBgm").click();

  try {
    if (action === "segment") {
      await applySegmentation();
      return;
    }
    if (action === "prompts") {
      await runTask(`/api/projects/${project.id}/prompts`, "生成分镜提示词");
      return;
    }
    if (action === "images") {
      await runTask(`/api/projects/${project.id}/images`, "批量生图", {});
      return;
    }
    if (action === "export") {
      await exportWithCheck();
      return;
    }
  } catch (err) {
    toast(err.message, "bad");
  }
}

async function regenerateShot(shotId = getState().selectedId) {
  const state = getState();
  if (!state.project || !shotId) return;
  pushUndo();
  await runTask(`/api/projects/${state.project.id}/images/${shotId}`, "重新生成该镜头");
}

// --------------------------------------------------------------------------- 导出前体检

let preflightProceed = null;

async function runPreflight(project) {
  const issues = [];
  const shots = project.shots || [];
  if (!shots.length) {
    issues.push({ kind: "empty", text: "还没有镜头段，导出会是空片" });
  }
  const missing = shots.filter((shot) => !shot.image);
  if (missing.length) {
    issues.push({ kind: "image", text: `${missing.length} 段还没有画面`, shotId: missing[0].id });
  }
  const emptyPrompt = shots.filter((shot) => !String(shot.prompt || "").trim());
  if (emptyPrompt.length) {
    issues.push({ kind: "prompt", text: `${emptyPrompt.length} 段提示词为空`, shotId: emptyPrompt[0].id });
  }

  const spec = (project.render || {}).subtitle || {};
  const cues = (project.subtitle || {}).cues || [];
  if (spec.enabled && cues.length) {
    const size = canvasSize(project.canvas);
    const fontSize = Math.max(12, Number(spec.size) || 46);
    const maxChars = Math.max(8, Math.floor((size.width * 0.88) / fontSize));
    const overflow = cues.filter((cue) => String(cue.text || "").length > maxChars * 2);
    if (overflow.length) {
      issues.push({ kind: "subtitle", text: `${overflow.length} 条字幕可能超出画面` });
    }
  }

  const audio = project.audio || {};
  if (!Number(audio.durationMs)) {
    issues.push({ kind: "audio", text: "还没有音频，成片没有声音" });
  } else if (audio.peaksUrl) {
    try {
      const peaks = await api.get(audio.peaksUrl);
      const peak = Array.isArray(peaks) ? Math.max(0, ...peaks.map(Number)) : 0;
      if (peak > 0 && peak < 6) {
        issues.push({ kind: "audio", text: "原声音量偏低，成片可能听不清" });
      }
    } catch (err) {
      // 波形缺失不阻塞导出
    }
  }
  return issues;
}

async function exportWithCheck() {
  const project = getState().project;
  if (!project) return;
  const issues = await runPreflight(project);
  const proceed = () => runTask(`/api/projects/${project.id}/render`, "导出成片");
  if (!issues.length) {
    toast("体检通过，开始导出", "ok");
    await proceed();
    return;
  }
  openPreflight(issues, proceed);
}

function openPreflight(issues, proceed) {
  preflightProceed = proceed;
  refs.preflightList.innerHTML = issues.map((issue) => {
    const jump = issue.shotId ? ` data-issue-shot="${escapeHtml(issue.shotId)}"` : "";
    return `<button class="pf-item" type="button"${jump}>
      <span class="pf-dot ${escapeHtml(issue.kind)}"></span>
      <span class="pf-text">${escapeHtml(issue.text)}</span>
      ${issue.shotId ? '<span class="pf-jump">定位</span>' : ""}
    </button>`;
  }).join("");
  refs.preflight.hidden = false;
  refs.preflightBackdrop.hidden = false;
}

function closePreflight() {
  refs.preflight.hidden = true;
  refs.preflightBackdrop.hidden = true;
  preflightProceed = null;
}

function bindPreflight() {
  const close = () => closePreflight();
  $("preflightClose").addEventListener("click", close);
  $("preflightCancel").addEventListener("click", close);
  refs.preflightBackdrop.addEventListener("click", close);
  $("preflightGo").addEventListener("click", () => {
    const proceed = preflightProceed;
    closePreflight();
    if (proceed) proceed();
  });
  refs.preflightList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-issue-shot]");
    if (!item) return;
    const shotId = item.dataset.issueShot;
    closePreflight();
    setView("storyboard");
    selectShot(shotId);
    const shot = (getState().project.shots || []).find((row) => row.id === shotId);
    if (shot) seek(shot.startMs);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !refs.preflight.hidden) closePreflight();
  });
}

function bindSidePanel() {
  const app = document.querySelector(".app");
  const open = () => {
    app.classList.add("side-open");
    if (refs.sideBackdrop) refs.sideBackdrop.hidden = false;
    if (refs.btnSide) refs.btnSide.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    app.classList.remove("side-open");
    if (refs.sideBackdrop) refs.sideBackdrop.hidden = true;
    if (refs.btnSide) refs.btnSide.setAttribute("aria-expanded", "false");
  };
  if (refs.btnSide) {
    refs.btnSide.setAttribute("aria-expanded", "false");
    refs.btnSide.addEventListener("click", () => {
      if (app.classList.contains("side-open")) close();
      else open();
    });
  }
  if (refs.sideBackdrop) refs.sideBackdrop.addEventListener("click", close);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.classList.contains("side-open")) close();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 1080) close();
  });
}

// --------------------------------------------------------------------------- 任务

async function runTask(path, label, body) {
  try {
    const { taskId } = await api.post(path, body === undefined ? {} : body);
    showTask(taskId, label);
    const result = await pollTask(taskId);
    hiddenTask();
    if (result.status === "done") {
      toast(`${label}完成`, "ok");
      const detail = result.result || {};
      if (detail.error) toast(detail.error);
      if (Array.isArray(detail.failed) && detail.failed.length) {
        toast(`${detail.failed.length} 段失败：${detail.failed[0].error}`, "bad");
      }
      await loadProject(getState().project.id);
      await refreshProjects();
    } else if (result.status === "canceled") {
      toast("任务已取消");
    } else {
      toast(result.error || `${label}失败`, "bad");
      await loadProject(getState().project.id);
    }
    return result;
  } catch (err) {
    hiddenTask();
    toast(err.message, "bad");
    return null;
  } finally {
    refreshTasks();
  }
}

function showTask(taskId, label) {
  refs.taskBar.hidden = false;
  refs.taskFill.style.width = "0%";
  refs.taskLabel.textContent = label;
  $("taskCancel").onclick = () => api.post(`/api/tasks/${taskId}/cancel`).catch(() => {});
}

function hiddenTask() {
  refs.taskBar.hidden = true;
}

async function pollTask(taskId) {
  for (;;) {
    const task = await api.get(`/api/tasks/${taskId}`);
    const progress = task.progress || {};
    const percent = Math.max(0, Math.min(100, Number(progress.value) || 0));
    refs.taskFill.style.width = `${percent}%`;
    refs.taskLabel.textContent = progress.label || task.kind || "处理中";
    if (["done", "error", "canceled"].includes(task.status)) return task;
    await sleep(700);
  }
}

// --------------------------------------------------------------------------- 设置抽屉

function drawerFieldsMarkup(fields, values, prefix) {
  return Object.entries(fields).map(([key, spec]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = values ? values[key] : spec.default;
    if (spec.type === "object") {
      return `<div class="sub-section"><h4>${escapeHtml(spec.label || key)}</h4>
        ${drawerFieldsMarkup(spec.fields || {}, value || {}, path)}</div>`;
    }
    if (spec.type === "bool") {
      return `<div class="field"><label class="switch">
        <input type="checkbox" data-path="${path}" data-kind="bool" ${value ? "checked" : ""} />
        <span>${escapeHtml(spec.label || key)}</span></label></div>`;
    }
    if (spec.type === "enum") {
      return `<div class="field"><label>${escapeHtml(spec.label || key)}</label>
        <select class="select" data-path="${path}" data-kind="string">
          ${(spec.options || []).map((option) =>
            `<option value="${escapeHtml(option)}" ${String(value) === String(option) ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select></div>`;
    }
    if (spec.type === "entity_list") {
      return `<div class="field"><label>${escapeHtml(spec.label || key)}</label>
        <div data-entities="1"></div>
        <button class="btn" data-add-entity="1" style="margin-top:6px">＋ 添加角色 / 场景</button>
        <div class="hint" style="margin-top:6px">只有这里登记过的实体允许出现在画面里；固定外观描述会拼进每一段提示词。</div>
      </div>`;
    }
    if (spec.type === "text") {
      return `<div class="field"><label>${escapeHtml(spec.label || key)}</label>
        <textarea class="textarea" style="min-height:56px" data-path="${path}" data-kind="string">${escapeHtml(value ?? "")}</textarea></div>`;
    }
    if (spec.type === "int" || spec.type === "float") {
      const numeric = value === undefined || value === null || value === ""
        ? (spec.default ?? spec.min ?? 0)
        : value;
      return `<div class="field"><label>${escapeHtml(spec.label || key)}</label>
        <input class="input" type="number" data-path="${path}" data-kind="number"
          min="${spec.min ?? ""}" max="${spec.max ?? ""}" step="${spec.type === "float" ? "0.01" : "1"}"
          value="${Number(numeric)}" /></div>`;
    }
    return `<div class="field"><label>${escapeHtml(spec.label || key)}</label>
      <input class="input" type="text" data-path="${path}" data-kind="string" value="${escapeHtml(value ?? "")}" /></div>`;
  }).join("");
}

async function openDrawer() {
  const state = getState();
  const project = state.project;
  const schema = state.schema;
  if (!project || !schema) return;
  drawerDraft = JSON.parse(JSON.stringify({
    canvas: project.canvas,
    locks: project.locks,
    render: project.render,
    llm: project.llm,
    image: project.image,
  }));
  const models = ((getState().health || {}).main || {}).llmModels || [];
  let styles = [];
  try {
    styles = (await api.get("/api/styles")).styles || [];
  } catch (err) {
    styles = [];
  }

  const sections = ["canvas", "locks", "render", "llm", "image"];
  refs.drawerBody.innerHTML = sections.map((name) => {
    const section = schema.sections[name];
    if (!section) return "";
    let extra = "";
    if (name === "llm") {
      extra = `<datalist id="llmModels">${models
        .map((item) => `<option value="${escapeHtml(item)}"></option>`).join("")}</datalist>
        <div class="hint" style="margin-bottom:10px">模型留空时使用服务默认模型；没配模型会退回模板拼装，提示词仍可手填。</div>`;
    }
    return `<section class="section" data-section="${name}">
      <h3>${escapeHtml(section.label || name)}</h3>
      ${extra}
      ${drawerFieldsMarkup(section.fields || {}, drawerDraft[name] || {}, name)}
    </section>`;
  }).join("");

  const llmModel = refs.drawerBody.querySelector('[data-path="llm.model"]');
  if (llmModel && models.length) llmModel.setAttribute("list", "llmModels");
  if (styles.length) enhanceStylePicker(styles);
  enhanceCanvasPresets();
  bindDrawerFields();
  refs.drawer.hidden = false;
  refs.drawerBackdrop.hidden = false;
}

const RESOLUTION_PRESETS = [
  { id: "720p", label: "720p", value: 1280 },
  { id: "1080p", label: "1080p", value: 1920 },
  { id: "4k", label: "4K", value: 3840 },
];

/** 把「导出长边」升级成常见分辨率预设，并实时显示成片实际尺寸。 */
function enhanceCanvasPresets() {
  const input = refs.drawerBody.querySelector('[data-path="canvas.longSide"]');
  if (!input) return;
  const field = input.closest(".field");
  if (!field) return;
  const ratioSelect = refs.drawerBody.querySelector('[data-path="canvas.ratio"]');
  const fpsInput = refs.drawerBody.querySelector('[data-path="canvas.fps"]');

  const presetField = document.createElement("div");
  presetField.className = "field";
  presetField.innerHTML = `<label>分辨率预设</label>
    <select class="select" data-resolution-preset>
      ${RESOLUTION_PRESETS.map((preset) =>
        `<option value="${preset.id}">${preset.label}</option>`).join("")}
      <option value="custom">自定义</option>
    </select>`;
  field.insertAdjacentElement("beforebegin", presetField);
  const select = presetField.querySelector("[data-resolution-preset]");

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.style.marginTop = "6px";
  field.appendChild(hint);

  const sync = (fromPreset) => {
    if (fromPreset) {
      const preset = RESOLUTION_PRESETS.find((item) => item.id === select.value);
      if (preset) input.value = String(preset.value);
    } else {
      const preset = RESOLUTION_PRESETS.find((item) => item.value === Number(input.value));
      select.value = preset ? preset.id : "custom";
    }
    const size = canvasSize({
      ratio: (ratioSelect && ratioSelect.value) || "16:9",
      longSide: Number(input.value) || 1920,
    });
    hint.textContent =
      `成片尺寸：${size.width}×${size.height} · ${Number((fpsInput || {}).value) || 30}fps`;
  };

  const current = RESOLUTION_PRESETS.find((preset) => preset.value === Number(input.value));
  select.value = current ? current.id : "custom";
  select.addEventListener("change", () => sync(true));
  input.addEventListener("input", () => sync(false));
  if (ratioSelect) ratioSelect.addEventListener("change", () => sync(false));
  if (fpsInput) fpsInput.addEventListener("input", () => sync(false));
  sync(false);
}

/** 把风格预设的纯文本输入升级成带分组的风格库下拉，选中即填入风格描述。 */
function enhanceStylePicker(styles) {
  const input = refs.drawerBody.querySelector('[data-path="locks.style.styleId"]');
  if (!input) return;
  const groups = new Map();
  styles.forEach((item) => {
    const key = item.category || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const select = document.createElement("select");
  select.className = "select";
  select.dataset.path = "locks.style.styleId";
  select.dataset.kind = "string";
  select.innerHTML = `<option value="">自定义（手写风格描述）</option>` + [...groups.entries()].map(([category, items]) =>
    `<optgroup label="${escapeHtml(category)}">${items.map((item) =>
      `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.id)}</option>`).join("")}</optgroup>`).join("");
  select.value = (drawerDraft.locks.style.styleId || "");
  select.addEventListener("change", () => {
    const item = styles.find((entry) => entry.id === select.value);
    drawerDraft.locks.style.styleId = item ? item.id : "";
    if (!item) return;
    const prefix = refs.drawerBody.querySelector('[data-path="locks.style.prefix"]');
    if (prefix) prefix.value = item.prompt;
    drawerDraft.locks.style.prefix = item.prompt;
  });
  input.replaceWith(select);
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.style.margin = "-4px 0 10px";
  hint.textContent = `已载入主项目风格库 ${styles.length} 条；选中后会把官方风格描述写进「风格描述」，仍可再改。`;
  select.insertAdjacentElement("afterend", hint);
}

function bindDrawerFields() {
  refs.drawerBody.querySelectorAll("[data-entities]").forEach((host) => {
    const section = host.closest("[data-section]").dataset.section;
    const block = drawerDraft[section].content;
    block.entities = block.entities || [];
    host.innerHTML = "";
    block.entities.forEach((entity, index) => host.appendChild(entityRow(section, entity, index)));
    // 用 onclick 覆盖，避免重复绑定导致一次点击加两条
    const add = host.parentElement.querySelector("[data-add-entity]");
    add.onclick = () => {
      block.entities.push({
        id: `e${Date.now().toString(36).slice(-4)}`, kind: "character", name: "", desc: "",
      });
      bindDrawerFields();
    };
  });
}

function entityRow(section, entity, index) {
  const row = document.createElement("div");
  row.className = "entity-row";
  row.innerHTML = `
    <div class="entity-head">
      <select class="select" data-entity="kind">
        ${[["character", "角色"], ["location", "场景"], ["prop", "道具"]].map(([value, label]) =>
          `<option value="${value}" ${entity.kind === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>
    <input class="input" data-entity="name" placeholder="名称（台词里怎么称呼）" value="${escapeHtml(entity.name || "")}" />
    <input class="input full" data-entity="desc" placeholder="固定外观描述（会拼进每段提示词）" value="${escapeHtml(entity.desc || "")}" />
    <div class="full" style="display:flex;justify-content:flex-end">
      <button class="btn danger" data-remove="1" style="height:26px;padding:0 10px;font-size:12px">删除</button>
    </div>`;
  row.querySelectorAll("[data-entity]").forEach((input) => {
    input.addEventListener("input", () => {
      entity[input.dataset.entity] = input.value;
      drawerDraft[section].content.entities[index] = entity;
    });
    input.addEventListener("change", () => {
      entity[input.dataset.entity] = input.value;
      drawerDraft[section].content.entities[index] = entity;
    });
  });
  row.querySelector("[data-remove]").addEventListener("click", () => {
    drawerDraft[section].content.entities.splice(index, 1);
    bindDrawerFields();
  });
  return row;
}

function bindDrawer() {
  const close = () => {
    refs.drawer.hidden = true;
    refs.drawerBackdrop.hidden = true;
  };
  $("drawerClose").addEventListener("click", close);
  refs.drawerBackdrop.addEventListener("click", close);
  $("drawerSave").addEventListener("click", saveDrawer);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !refs.drawer.hidden) close();
  });
}

async function saveDrawer() {
  const project = getState().project;
  if (!project) return;
  const patch = {};
  refs.drawerBody.querySelectorAll("[data-path]").forEach((input) => {
    const path = input.dataset.path;
    const kind = input.dataset.kind;
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (kind === "number") value = Number(value);
    merge(patch, toPatch(path, value));
  });
  // 实体卡以草稿为准
  if (patch.locks && patch.locks.content && drawerDraft) {
    patch.locks.content.entities = (drawerDraft.locks.content.entities || [])
      .filter((entity) => (entity.name || "").trim() || (entity.desc || "").trim());
  }

  // 改画幅会让已生成的图被居中裁切，先把后果说清楚
  const oldRatio = (project.canvas || {}).ratio || "16:9";
  const ratioChanged = Boolean(patch.canvas && patch.canvas.ratio
    && patch.canvas.ratio !== oldRatio);
  const imageShots = (project.shots || []).filter((shot) => shot.image);
  let regenerateIds = null;
  if (ratioChanged && imageShots.length) {
    const proceed = window.confirm(
      `画幅将从 ${oldRatio} 改为 ${patch.canvas.ratio}，已有 ${imageShots.length} 张图会按新画幅居中裁切。继续保存吗？`);
    if (!proceed) return;
    if (window.confirm(`要顺便按新画幅重新生成这 ${imageShots.length} 张图吗？`)) {
      regenerateIds = imageShots.map((shot) => shot.id);
    }
  }

  try {
    const updated = await api.patch(`/api/projects/${project.id}`, patch);
    setState({ project: updated });
    refs.drawer.hidden = true;
    refs.drawerBackdrop.hidden = true;
    renderAll();
    toast("设置已保存，提示词已按新风格重新装配", "ok");
    if (regenerateIds) {
      await runTask(`/api/projects/${project.id}/images`, "按新画幅重新生图",
        { shotIds: regenerateIds });
    }
  } catch (err) {
    toast(err.message, "bad");
  }
}

// --------------------------------------------------------------------------- 元信息

function updateMeta() {
  const project = getState().project;
  const reviewButton = $("btnReview");
  if (!project) {
    refs.tlMeta.textContent = "0 段 · 00:00.00";
    if (reviewButton) reviewButton.hidden = true;
    return;
  }
  const shots = project.shots || [];
  const ready = shots.filter((shot) => shot.status === "ready").length;
  const review = shots.filter((shot) =>
    shot.review && (shot.review.prompt || shot.review.image)).length;
  refs.tlMeta.textContent = `${shots.length} 段 · ${formatMs(duration())} · ${ready} 段就绪`;
  if (reviewButton) {
    reviewButton.hidden = review === 0;
    reviewButton.textContent = `待处理 ${review}`;
  }
}

boot().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, "bad");
});
