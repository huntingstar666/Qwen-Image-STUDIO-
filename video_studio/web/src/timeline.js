import { formatMs } from "./api.js";

const MOTION_SHORT = {
  push: "推", pull: "拉", left: "左移", right: "右移",
  up: "上摇", down: "下摇", diag: "对角",
};

function durationMs(project) {
  return Math.max(0, Number((project && project.audio && project.audio.durationMs) || 0));
}

function pickStep(pxPerSec) {
  if (pxPerSec >= 90) return 1;
  if (pxPerSec >= 44) return 2;
  if (pxPerSec >= 20) return 5;
  return 10;
}

export class Timeline {
  constructor(refs, handlers) {
    this.refs = refs;
    this.handlers = handlers;
    this.project = null;
    this.selectedId = "";
    this.pxPerSec = 36;
    this.peaks = null;
    this.peaksUrl = "";
    this.playheadMs = 0;
    this._bind();
    window.addEventListener("resize", () => this.render());
  }

  // ---------------------------------------------------------------- 数据

  async setProject(project, selectedId, pxPerSec) {
    const audioChanged = !this.project || (project.audio && project.audio.peaksUrl) !== this.peaksUrl;
    this.project = project;
    this.selectedId = selectedId || "";
    this.pxPerSec = pxPerSec || this.pxPerSec;
    if (audioChanged) {
      this.peaks = null;
      this.peaksUrl = (project.audio && project.audio.peaksUrl) || "";
      if (this.peaksUrl) {
        try {
          const response = await fetch(this.peaksUrl);
          this.peaks = response.ok ? await response.json() : null;
        } catch (err) {
          this.peaks = null;
        }
      }
    }
    this.render();
  }

  setSelected(selectedId) {
    this.selectedId = selectedId || "";
    this.render();
  }

  setPlayhead(ms) {
    this.playheadMs = Math.max(0, Number(ms) || 0);
    const left = (this.playheadMs / 1000) * this.pxPerSec;
    this.refs.playhead.style.transform = `translateX(${left - 1}px)`;
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    if (!this.project) return;
    const duration = durationMs(this.project);
    const scrollWidth = this.refs.scroll.clientWidth || 800;
    const width = Math.max(Math.ceil((duration / 1000) * this.pxPerSec), scrollWidth);
    this.refs.inner.style.width = `${width}px`;
    this.refs.empty.hidden = Boolean((this.project.shots || []).length) || !duration;
    this.refs.wave.style.width = `${width}px`;
    this.refs.wave.width = Math.max(1, Math.round(width * (window.devicePixelRatio || 1)));
    this.refs.wave.height = Math.max(1, Math.round(this.refs.wave.clientHeight * (window.devicePixelRatio || 1)));

    this._renderRuler(duration, width);
    this._renderWave(duration, width);
    this._renderShots();
    this._renderSubs();
    this._renderBgm(duration, width);
    this.refs.ruler.style.width = `${width}px`;
    this.setPlayhead(this.playheadMs);
  }

  _renderRuler(duration, width) {
    const ruler = this.refs.ruler;
    ruler.innerHTML = "";
    if (!duration) return;
    const step = pickStep(this.pxPerSec);
    const totalSeconds = duration / 1000;
    for (let second = 0; second <= totalSeconds + 0.001; second += step) {
      const tick = document.createElement("div");
      tick.className = "tl-tick";
      tick.style.left = `${second * this.pxPerSec}px`;
      tick.textContent = formatMs(second * 1000).slice(0, 5);
      ruler.appendChild(tick);
    }
  }

  _renderWave(duration, width) {
    const canvas = this.refs.wave;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const height = canvas.height;
    ctx.clearRect(0, 0, canvas.width, height);
    const styles = getComputedStyle(document.documentElement);
    const line = styles.getPropertyValue("--line").trim() || "rgba(0,0,0,.1)";
    const accent = styles.getPropertyValue("--accent").trim() || "#2f6b62";
    const mid = height / 2;

    ctx.strokeStyle = line;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(canvas.width, mid);
    ctx.stroke();

    const peaks = this.peaks;
    if (!peaks || !peaks.length || !duration) return;
    const perSecond = peaks.length / (duration / 1000);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.55;
    for (let x = 0; x < canvas.width; x += dpr) {
      const startSecond = x / dpr / this.pxPerSec;
      const endSecond = (x + dpr) / dpr / this.pxPerSec;
      const from = Math.max(0, Math.floor(startSecond * perSecond));
      const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil(endSecond * perSecond)));
      let peak = 0;
      for (let i = from; i < to; i += 1) peak = Math.max(peak, peaks[i] || 0);
      // 开方缩放：安静段落也能看出起伏，避免整条波形贴成一条线
      const h = Math.max(1, Math.sqrt(peak / 100) * (height * 0.86));
      ctx.fillRect(x, mid - h / 2, Math.max(1, dpr), h);
    }
    ctx.globalAlpha = 1;
  }

  _renderShots() {
    const host = this.refs.shots;
    host.innerHTML = "";
    const shots = this.project.shots || [];
    shots.forEach((shot, index) => {
      const left = (shot.startMs / 1000) * this.pxPerSec;
      const width = Math.max(3, ((shot.endMs - shot.startMs) / 1000) * this.pxPerSec);
      const review = shot.review || {};
      const hasReview = Boolean(review.prompt || review.image);
      const block = document.createElement("div");
      block.className = `shot-block status-${shot.status || "pending"}${shot.id === this.selectedId ? " selected" : ""}${hasReview ? " has-review" : ""}`;
      block.style.left = `${left}px`;
      block.style.width = `${width}px`;
      block.dataset.id = shot.id;
      block.title = `${shot.id} · 双击只看这一段`;

      if (shot.imageUrl) {
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.style.backgroundImage = `url("${shot.imageUrl}")`;
        block.appendChild(thumb);
        const veil = document.createElement("div");
        veil.className = "veil";
        block.appendChild(veil);
      }

      const badges = document.createElement("div");
      badges.className = "badges";
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = shot.id;
      badges.appendChild(badge);
      const lines = String(shot.text || "").split("\n").filter((line) => line.trim());
      if (lines.length > 1) {
        const chip = document.createElement("span");
        chip.className = "meta-chip";
        chip.textContent = `含 ${lines.length} 句`;
        badges.appendChild(chip);
      }
      const beat = shot.beat || null;
      if (beat && Number(beat.count) > 1) {
        const chip = document.createElement("span");
        chip.className = "meta-chip";
        chip.textContent = `同句 ${beat.index}/${beat.count}`;
        badges.appendChild(chip);
      }
      block.appendChild(badges);

      const transition = shot.transition || {};
      const motionType = (shot.motion || {}).type || "none";
      const fx = [];
      if (transition.type && transition.type !== "cut") {
        fx.push(transition.type === "fadeblack" ? "黑场" : "淡入");
      }
      if (MOTION_SHORT[motionType]) fx.push(MOTION_SHORT[motionType]);
      if (fx.length) {
        const chip = document.createElement("span");
        chip.className = "fx";
        chip.textContent = fx.join(" · ");
        block.appendChild(chip);
      }

      const menuBtn = document.createElement("button");
      menuBtn.type = "button";
      menuBtn.className = "block-menu";
      menuBtn.dataset.menu = "1";
      menuBtn.textContent = "⋯";
      menuBtn.title = "段操作：拆分 / 合并 / 换图 / 重新生成";
      block.appendChild(menuBtn);

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = (shot.text || "").replace(/\n/g, " ") || "（无台词）";
      block.appendChild(label);

      if (hasReview) {
        const dot = document.createElement("span");
        dot.className = "review-dot";
        dot.title = `待处理：${[review.prompt ? "提示词需复核" : "", review.image ? "图片需确认" : ""]
          .filter(Boolean).join(" / ")}`;
        block.appendChild(dot);
      }

      const handleLeft = document.createElement("div");
      handleLeft.className = "handle left";
      handleLeft.dataset.edge = "left";
      const handleRight = document.createElement("div");
      handleRight.className = "handle right";
      handleRight.dataset.edge = "right";
      block.appendChild(handleLeft);
      block.appendChild(handleRight);

      host.appendChild(block);

      if (index > 0) {
        const gap = document.createElement("button");
        gap.type = "button";
        gap.className = "merge-gap";
        gap.style.left = `${left}px`;
        gap.textContent = "合并";
        gap.title = `把 ${shots[index - 1].id} 与 ${shot.id} 合并成一个画面`;
        gap.dataset.merge = `${shots[index - 1].id},${shot.id}`;
        host.appendChild(gap);
      }
    });
  }

  _renderSubs() {
    const host = this.refs.subs;
    host.innerHTML = "";
    const cues = (this.project.subtitle && this.project.subtitle.cues) || [];
    cues.slice(0, 400).forEach((cue, index) => {
      const left = (cue.startMs / 1000) * this.pxPerSec;
      const width = Math.max(8, ((cue.endMs - cue.startMs) / 1000) * this.pxPerSec);
      const node = document.createElement("div");
      node.className = "sub-block";
      node.style.left = `${left}px`;
      node.style.width = `${width}px`;
      node.dataset.index = String(index);
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      node.textContent = cue.text.replace(/\n/g, " ");
      node.title = `${formatMs(cue.startMs)}–${formatMs(cue.endMs)}  ${cue.text}（点击或回车修改文案）`;
      host.appendChild(node);
    });
  }

  _renderBgm(duration, width) {
    const host = this.refs.bgm;
    host.innerHTML = "";
    const bgm = (this.project.render && this.project.render.bgm) || {};
    if (!bgm.url) {
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "bgm-empty";
      empty.dataset.bgm = "open";
      empty.textContent = "点击上传背景音乐（mp3 / wav / m4a / flac…）";
      host.appendChild(empty);
      return;
    }
    const node = document.createElement("div");
    node.className = "bgm-block";
    node.dataset.bgm = "open";
    node.title = "点击调整背景音乐：音量 / 循环 / 闪避";
    node.style.left = "0px";
    node.style.width = `${Math.max(60, (duration / 1000) * this.pxPerSec - 2)}px`;
    const name = String(bgm.file || "").split("/").pop() || "背景音乐";
    node.textContent = `${name} · ${bgm.volumeDb ?? -18} dB${bgm.loop ? " · 循环" : ""}${bgm.duck ? " · 闪避" : ""}`;
    host.appendChild(node);
  }

  // ---------------------------------------------------------------- 交互

  _timeAt(clientX) {
    const rect = this.refs.inner.getBoundingClientRect();
    const scrollLeft = this.refs.scroll.scrollLeft;
    const x = clientX - rect.left + scrollLeft;
    return Math.max(0, (x / this.pxPerSec) * 1000);
  }

  _bind() {
    const { scroll } = this.refs;

    scroll.addEventListener("pointerdown", (event) => {
      // 字幕块单击进入文案编辑，不触发跳转
      if (event.target.closest(".sub-block")) return;
      // 段间「合并」胶囊自己处理点击
      if (event.target.closest(".merge-gap")) return;
      // 段操作按钮 / BGM 轨道自己处理点击
      if (event.target.closest(".block-menu")) return;
      if (event.target.closest("[data-bgm]")) return;
      const handle = event.target.closest(".shot-block .handle");
      if (handle) {
        event.preventDefault();
        this._startBoundaryDrag(event, handle);
        return;
      }
      const block = event.target.closest(".shot-block");
      if (block) {
        this.handlers.onSelect(block.dataset.id);
        this.handlers.onSeek(Math.max(this._shotStart(block.dataset.id), this._timeAt(event.clientX)));
        return;
      }
      if (event.target.closest(".tl-ruler") || event.target.closest(".tl-row")) {
        event.preventDefault();
        this.handlers.onSeek(this._timeAt(event.clientX));
        this._startSeekDrag(event);
      }
    });

    // 双击镜头块 = 只看这一段，方便逐段审画面 / 对台词
    scroll.addEventListener("dblclick", (event) => {
      const block = event.target.closest(".shot-block");
      if (!block || !this.handlers.onPlayRange) return;
      const shot = (this.project.shots || []).find((item) => item.id === block.dataset.id);
      if (shot) this.handlers.onPlayRange(shot);
    });

    // 字幕块单击 = 就地改文案；段间胶囊 = 合并；⋯ / BGM = 各自面板
    scroll.addEventListener("click", (event) => {
      const gap = event.target.closest(".merge-gap");
      if (gap) {
        event.preventDefault();
        event.stopPropagation();
        const ids = String(gap.dataset.merge || "").split(",").filter(Boolean);
        if (ids.length === 2 && this.handlers.onMerge) this.handlers.onMerge(ids);
        return;
      }
      const menuBtn = event.target.closest(".block-menu");
      if (menuBtn) {
        event.preventDefault();
        event.stopPropagation();
        const block = menuBtn.closest(".shot-block");
        const rect = menuBtn.getBoundingClientRect();
        this.handlers.onShotMenu?.(block.dataset.id, rect.left, rect.bottom + 4);
        return;
      }
      const bgm = event.target.closest("[data-bgm]");
      if (bgm) {
        event.preventDefault();
        this.handlers.onBgmOpen?.(bgm);
        return;
      }
      const block = event.target.closest(".sub-block");
      if (!block || !this.handlers.onCueText) return;
      this._startCueEdit(block);
    });

    scroll.addEventListener("contextmenu", (event) => {
      const block = event.target.closest(".shot-block");
      if (!block) return;
      event.preventDefault();
      this.handlers.onShotMenu?.(block.dataset.id, event.clientX, event.clientY);
    });

    // 图片直接拖到某个镜头块上 = 替换该段画面
    scroll.addEventListener("dragover", (event) => {
      const block = event.target.closest(".shot-block");
      if (!block) return;
      event.preventDefault();
      block.classList.add("drop-target");
    });
    scroll.addEventListener("dragleave", (event) => {
      const block = event.target.closest(".shot-block");
      if (block) block.classList.remove("drop-target");
    });
    scroll.addEventListener("drop", (event) => {
      const block = event.target.closest(".shot-block");
      if (!block) return;
      event.preventDefault();
      block.classList.remove("drop-target");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) this.handlers.onDropImage?.(block.dataset.id, file);
    });

    // 键盘可达：字幕块聚焦后回车 / 空格进入编辑
    scroll.addEventListener("keydown", (event) => {
      const block = event.target.closest(".sub-block");
      if (!block || event.target !== block) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      this._startCueEdit(block);
    });
  }

  _startCueEdit(block) {
    if (block.dataset.editing === "1") return;
    const index = Number(block.dataset.index);
    const cues = (this.project.subtitle && this.project.subtitle.cues) || [];
    const cue = cues[index];
    if (!cue) return;
    block.dataset.editing = "1";
    block.innerHTML = "";
    const input = document.createElement("input");
    input.className = "cue-input";
    input.value = cue.text;
    block.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      if (commit && value && value !== cue.text) {
        this.handlers.onCueText(index, value);
      } else {
        this.render();
      }
    };
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
  }

  /** 拖边界时吸附到最近的字幕起止点，避免把一句话切在字中间。 */
  _snapTime(value) {
    const threshold = (8 / this.pxPerSec) * 1000;
    const cues = (this.project.subtitle && this.project.subtitle.cues) || [];
    let best = null;
    cues.forEach((cue) => {
      [cue.startMs, cue.endMs].forEach((edge) => {
        const distance = Math.abs(edge - value);
        if (distance <= threshold && (best === null || distance < best.distance)) {
          best = { distance, value: edge };
        }
      });
    });
    return Math.round(best ? best.value : value);
  }

  _shotStart(shotId) {
    const shot = (this.project.shots || []).find((item) => item.id === shotId);
    return shot ? shot.startMs : 0;
  }

  _startSeekDrag(event) {
    let scrubbing = false;
    const move = (moveEvent) => {
      if (!scrubbing && Math.abs(moveEvent.clientX - event.clientX) > 1) {
        scrubbing = true;
        this.handlers.onScrubStart?.();
      }
      this.handlers.onSeek(this._timeAt(moveEvent.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (scrubbing) this.handlers.onScrubEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _startBoundaryDrag(event, handle) {
    const block = handle.closest(".shot-block");
    const shotId = block.dataset.id;
    const edge = handle.dataset.edge;
    const shot = (this.project.shots || []).find((item) => item.id === shotId);
    if (!shot) return;
    this.handlers.onScrubStart?.();
    const startX = event.clientX;
    const origin = edge === "left" ? shot.startMs : shot.endMs;
    const minGap = 1000 / 60;
    const min = edge === "left"
      ? this._previousEnd(shotId) + minGap
      : shot.startMs + minGap;
    const max = edge === "left"
      ? shot.endMs - minGap
      : this._nextStart(shotId) - minGap;

    const move = (moveEvent) => {
      const deltaMs = ((moveEvent.clientX - startX) / this.pxPerSec) * 1000;
      const value = Math.min(max, Math.max(min, origin + deltaMs));
      const left = edge === "left" ? (value / 1000) * this.pxPerSec : (shot.startMs / 1000) * this.pxPerSec;
      const right = edge === "left" ? (shot.endMs / 1000) * this.pxPerSec : (value / 1000) * this.pxPerSec;
      block.style.left = `${left}px`;
      block.style.width = `${Math.max(3, right - left)}px`;
      block.dataset.dragValue = String(Math.round(value));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.handlers.onScrubEnd?.();
      if (block.dataset.dragValue === undefined) return;
      const raw = this._snapTime(Number(block.dataset.dragValue || "0"));
      delete block.dataset.dragValue;
      this.handlers.onRetime(shotId, edge === "left" ? { startMs: raw } : { endMs: raw });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _previousEnd(shotId) {
    const shots = this.project.shots || [];
    const index = shots.findIndex((item) => item.id === shotId);
    return index > 0 ? shots[index - 1].endMs : 0;
  }

  _nextStart(shotId) {
    const shots = this.project.shots || [];
    const index = shots.findIndex((item) => item.id === shotId);
    return index >= 0 && index < shots.length - 1 ? shots[index + 1].startMs : durationMs(this.project);
  }
}
