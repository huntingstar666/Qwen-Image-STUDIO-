// 预览播放器：与后端 expanded_sequence 完全同构（hold / pingpong / duration）。

import {
  expandedSequence, setPlayhead, setSelection, state, subscribe, togglePlaying,
} from './store.js';

let raf = 0;
let lastTime = 0;
let carry = 0;
let sequence = [];

function rebuild() {
  sequence = expandedSequence();
  if (!sequence.length) {
    carry = 0;
    return;
  }
  if (state.playhead >= sequence.length) setPlayhead(0);
  carry = 0;
  lastTime = 0;
}

function frame(timestamp) {
  if (!state.playing) {
    raf = 0;
    return;
  }
  if (!lastTime) lastTime = timestamp;
  const delta = Math.min(120, timestamp - lastTime);
  lastTime = timestamp;
  carry += delta;

  let guard = 0;
  while (sequence.length && carry >= sequence[state.playhead]?.duration && guard < 240) {
    carry -= sequence[state.playhead].duration;
    const next = (state.playhead + 1) % sequence.length;
    setPlayhead(next);
    guard += 1;
  }
  raf = requestAnimationFrame(frame);
}

export function start() {
  rebuild();
  if (!state.playing) return;
  lastTime = 0;
  carry = 0;
  if (!raf) raf = requestAnimationFrame(frame);
}

export function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  lastTime = 0;
  carry = 0;
}

export function toggle() {
  togglePlaying();
  if (state.playing) start();
  else stop();
}

export function step(delta) {
  stop();
  state.playing = false;
  rebuild();
  const index = sequence.findIndex((item) => item.frame.id === state.selectionId);
  const base = index >= 0 ? index : 0;
  const next = (base + delta + sequence.length) % Math.max(1, sequence.length);
  setPlayhead(next);
  const target = sequence[next]?.frame;
  if (target) setSelection(target.id);
}

subscribe((reason) => {
  if (reason === 'project' || reason === 'doc') {
    rebuild();
    if (state.playing) start();
  }
  if (reason === 'frame' && state.playing) rebuild();
  if (reason === 'playback' && !state.playing) stop();
});
