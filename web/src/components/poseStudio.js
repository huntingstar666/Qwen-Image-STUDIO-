/**
 * 姿态工作室（2D 人偶摆姿 → 姿态参考图）。
 *
 * 原理对应 ComfyUI-Gaoshang-Pose 的 GaoshangQwenFreePose：
 * - 第 1 张图是「人偶姿态参考」（黑底、彩色四肢、灰白躯干），只提供动作与构图；
 * - 后续图片是人物 / 场景参考；提示词负责场景、服装、光影；
 * - 采样时叠加 VNCCS 姿态 LoRA，让模型按人偶的骨骼朝向重绘。
 *
 * 这里用 Canvas 2D 直接把 14 个关节渲染成同一分布的人偶图，
 * 输出 768×1024 PNG，提交时交给后端作为 image1。
 */

import { openModal } from './modal.js';
import { clamp, escapeHtml } from '../utils.js';

const W = 768;
const H = 1024;

const JOINTS = [
  'nose',
  'neck',
  'rSh', 'rEl', 'rWr',
  'lSh', 'lEl', 'lWr',
  'rHip', 'rKn', 'rAn',
  'lHip', 'lKn', 'lAn',
];

const PRESETS = [
  {
    id: 'stand',
    label: '自然站姿',
    summary: '正面站立，双臂自然下垂，重心均匀',
    joints: {
      nose: [0.5, 0.135], neck: [0.5, 0.205],
      rSh: [0.585, 0.225], rEl: [0.618, 0.365], rWr: [0.638, 0.5],
      lSh: [0.415, 0.225], lEl: [0.382, 0.365], lWr: [0.362, 0.5],
      rHip: [0.548, 0.52], rKn: [0.558, 0.705], rAn: [0.565, 0.885],
      lHip: [0.452, 0.52], lKn: [0.442, 0.705], lAn: [0.435, 0.885],
    },
  },
  {
    id: 'walk',
    label: '行走',
    summary: '向前迈步，双臂自然摆动',
    joints: {
      nose: [0.502, 0.135], neck: [0.502, 0.205],
      rSh: [0.588, 0.225], rEl: [0.64, 0.35], rWr: [0.665, 0.478],
      lSh: [0.416, 0.225], lEl: [0.36, 0.352], lWr: [0.33, 0.478],
      rHip: [0.548, 0.52], rKn: [0.598, 0.69], rAn: [0.648, 0.878],
      lHip: [0.452, 0.52], lKn: [0.408, 0.698], lAn: [0.362, 0.878],
    },
  },
  {
    id: 'run',
    label: '奔跑',
    summary: '身体前倾，一腿抬起、一腿后蹬，双臂弯举',
    joints: {
      nose: [0.548, 0.13], neck: [0.528, 0.202],
      rSh: [0.606, 0.226], rEl: [0.662, 0.316], rWr: [0.598, 0.246],
      lSh: [0.442, 0.226], lEl: [0.372, 0.336], lWr: [0.33, 0.444],
      rHip: [0.548, 0.518], rKn: [0.618, 0.628], rAn: [0.652, 0.752],
      lHip: [0.452, 0.52], lKn: [0.418, 0.71], lAn: [0.356, 0.872],
    },
  },
  {
    id: 'sit',
    label: '坐姿',
    summary: '坐在椅子上，膝盖弯曲，双手放在腿上',
    joints: {
      nose: [0.5, 0.18], neck: [0.5, 0.25],
      rSh: [0.582, 0.268], rEl: [0.618, 0.402], rWr: [0.6, 0.545],
      lSh: [0.418, 0.268], lEl: [0.382, 0.402], lWr: [0.4, 0.545],
      rHip: [0.548, 0.545], rKn: [0.63, 0.64], rAn: [0.632, 0.83],
      lHip: [0.452, 0.545], lKn: [0.37, 0.64], lAn: [0.368, 0.83],
    },
  },
  {
    id: 'squat',
    label: '蹲姿',
    summary: '屈膝下蹲，双膝分开，上身略前倾',
    joints: {
      nose: [0.5, 0.235], neck: [0.5, 0.302],
      rSh: [0.584, 0.32], rEl: [0.632, 0.44], rWr: [0.598, 0.55],
      lSh: [0.416, 0.32], lEl: [0.368, 0.44], lWr: [0.402, 0.55],
      rHip: [0.548, 0.6], rKn: [0.66, 0.7], rAn: [0.622, 0.878],
      lHip: [0.452, 0.6], lKn: [0.34, 0.7], lAn: [0.378, 0.878],
    },
  },
  {
    id: 'kneel',
    label: '单膝跪',
    summary: '单膝跪地，另一条腿弓起，上身直立',
    joints: {
      nose: [0.5, 0.16], neck: [0.5, 0.23],
      rSh: [0.584, 0.25], rEl: [0.616, 0.386], rWr: [0.632, 0.522],
      lSh: [0.416, 0.25], lEl: [0.384, 0.386], lWr: [0.368, 0.522],
      rHip: [0.548, 0.548], rKn: [0.592, 0.718], rAn: [0.62, 0.888],
      lHip: [0.452, 0.548], lKn: [0.384, 0.64], lAn: [0.34, 0.79],
    },
  },
  {
    id: 'jump',
    label: '跳跃',
    summary: '腾空跃起，双腿收拢，双臂向上舒展',
    joints: {
      nose: [0.5, 0.115], neck: [0.5, 0.185],
      rSh: [0.584, 0.205], rEl: [0.652, 0.318], rWr: [0.672, 0.168],
      lSh: [0.416, 0.205], lEl: [0.348, 0.318], lWr: [0.328, 0.168],
      rHip: [0.548, 0.5], rKn: [0.606, 0.618], rAn: [0.586, 0.735],
      lHip: [0.452, 0.5], lKn: [0.394, 0.618], lAn: [0.414, 0.735],
    },
  },
  {
    id: 'wave',
    label: '挥手',
    summary: '站立挥手，一只手举过头顶',
    joints: {
      nose: [0.5, 0.14], neck: [0.5, 0.21],
      rSh: [0.585, 0.23], rEl: [0.646, 0.326], rWr: [0.676, 0.178],
      lSh: [0.415, 0.23], lEl: [0.382, 0.37], lWr: [0.362, 0.505],
      rHip: [0.548, 0.522], rKn: [0.558, 0.707], rAn: [0.565, 0.887],
      lHip: [0.452, 0.522], lKn: [0.442, 0.707], lAn: [0.435, 0.887],
    },
  },
  {
    id: 'dance',
    label: '舞蹈',
    summary: '身体侧倾，一臂上扬、一臂外展，重心落在单腿',
    joints: {
      nose: [0.528, 0.138], neck: [0.518, 0.208],
      rSh: [0.598, 0.228], rEl: [0.664, 0.31], rWr: [0.706, 0.172],
      lSh: [0.434, 0.228], lEl: [0.362, 0.34], lWr: [0.302, 0.424],
      rHip: [0.552, 0.518], rKn: [0.6, 0.702], rAn: [0.618, 0.884],
      lHip: [0.456, 0.522], lKn: [0.42, 0.708], lAn: [0.394, 0.884],
    },
  },
  {
    id: 'punch',
    label: '出拳',
    summary: '弓步出拳，一臂向前伸直，另一臂收在胸前',
    joints: {
      nose: [0.53, 0.145], neck: [0.52, 0.215],
      rSh: [0.606, 0.234], rEl: [0.686, 0.29], rWr: [0.79, 0.298],
      lSh: [0.436, 0.234], lEl: [0.394, 0.34], lWr: [0.47, 0.316],
      rHip: [0.548, 0.522], rKn: [0.604, 0.702], rAn: [0.638, 0.884],
      lHip: [0.452, 0.522], lKn: [0.402, 0.708], lAn: [0.348, 0.884],
    },
  },
  {
    id: 'reach',
    label: '伸取',
    summary: '双臂斜向上伸展，抬头看向手的方向',
    joints: {
      nose: [0.5, 0.125], neck: [0.5, 0.195],
      rSh: [0.586, 0.216], rEl: [0.648, 0.33], rWr: [0.706, 0.232],
      lSh: [0.414, 0.216], lEl: [0.352, 0.33], lWr: [0.294, 0.232],
      rHip: [0.548, 0.518], rKn: [0.558, 0.702], rAn: [0.565, 0.882],
      lHip: [0.452, 0.518], lKn: [0.442, 0.702], lAn: [0.435, 0.882],
    },
  },
  {
    id: 'lean',
    label: '倚靠',
    summary: '身体微侧倚靠，一只手叉腰，姿态放松',
    joints: {
      nose: [0.53, 0.14], neck: [0.522, 0.21],
      rSh: [0.6, 0.23], rEl: [0.652, 0.362], rWr: [0.582, 0.5],
      lSh: [0.44, 0.232], lEl: [0.404, 0.372], lWr: [0.386, 0.508],
      rHip: [0.552, 0.522], rKn: [0.572, 0.706], rAn: [0.6, 0.886],
      lHip: [0.452, 0.524], lKn: [0.43, 0.71], lAn: [0.402, 0.886],
    },
  },
];

const LIMB_COLORS = {
  armR: '#f08a5d',
  armL: '#f2c94c',
  legR: '#5fb7e8',
  legL: '#6fcf97',
  body: '#cfc6b4',
  bodyDark: '#8d8577',
  joint: '#e9e4d8',
};

function presetById(id) {
  return PRESETS.find((item) => item.id === id) || PRESETS[0];
}

function jointsFromPreset(preset) {
  const out = {};
  JOINTS.forEach((key) => {
    const point = preset.joints[key];
    out[key] = { x: point[0], y: point[1] };
  });
  return out;
}

function clonePose(pose) {
  const out = {};
  JOINTS.forEach((key) => {
    out[key] = { x: pose[key].x, y: pose[key].y };
  });
  return out;
}

function vertex(ctx, point) {
  return [point.x * W, point.y * H];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function capsule(ctx, a, b, width, color) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = width + 10;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();

  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
  const ox = Math.cos(angle) * width * 0.18;
  const oy = Math.sin(angle) * width * 0.18;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = Math.max(2, width * 0.26);
  ctx.beginPath();
  ctx.moveTo(a[0] + ox, a[1] + oy);
  ctx.lineTo(b[0] + ox, b[1] + oy);
  ctx.stroke();
}

function jointBall(ctx, point, radius, color) {
  const gradient = ctx.createRadialGradient(
    point[0] - radius * 0.3,
    point[1] - radius * 0.35,
    radius * 0.2,
    point[0],
    point[1],
    radius,
  );
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
  gradient.addColorStop(0.55, color);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function renderMannequin(ctx, joints, { scale = 1, handles = false } = {}) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);

  const raw = {};
  JOINTS.forEach((key) => {
    raw[key] = [joints[key].x, joints[key].y];
  });
  const anchor = [(raw.neck[0] + raw.rHip[0] + raw.lHip[0]) / 3, (raw.neck[1] + raw.rHip[1] + raw.lHip[1]) / 3];
  const point = {};
  JOINTS.forEach((key) => {
    point[key] = [
      (anchor[0] + (raw[key][0] - anchor[0]) * scale) * W,
      (anchor[1] + (raw[key][1] - anchor[1]) * scale) * H,
    ];
  });

  const shoulderSpan = dist(point.rSh, point.lSh);
  const armW = clamp(shoulderSpan * 0.2, 10, 44);
  const legW = clamp(shoulderSpan * 0.27, 14, 58);
  const hipMid = [(point.rHip[0] + point.lHip[0]) / 2, (point.rHip[1] + point.lHip[1]) / 2];
  const shoulderMid = [(point.rSh[0] + point.lSh[0]) / 2, (point.rSh[1] + point.lSh[1]) / 2];

  // 腿
  capsule(ctx, point.rHip, point.rKn, legW, LIMB_COLORS.legR);
  capsule(ctx, point.rKn, point.rAn, legW * 0.82, LIMB_COLORS.legR);
  capsule(ctx, point.lHip, point.lKn, legW, LIMB_COLORS.legL);
  capsule(ctx, point.lKn, point.lAn, legW * 0.82, LIMB_COLORS.legL);
  jointBall(ctx, point.rAn, legW * 0.48, LIMB_COLORS.legR);
  jointBall(ctx, point.lAn, legW * 0.48, LIMB_COLORS.legL);

  // 躯干
  const hipHalf = dist(point.rHip, point.lHip) * 0.5;
  const torso = [
    point.lSh,
    point.rSh,
    [point.rHip[0] + hipHalf * 0.12, point.rHip[1]],
    [point.lHip[0] - hipHalf * 0.12, point.lHip[1]],
  ];
  const bodyGradient = ctx.createLinearGradient(shoulderMid[0], point.neck[1], hipMid[0], point.rHip[1]);
  bodyGradient.addColorStop(0, '#e3ddd0');
  bodyGradient.addColorStop(0.55, LIMB_COLORS.body);
  bodyGradient.addColorStop(1, LIMB_COLORS.bodyDark);
  ctx.beginPath();
  ctx.moveTo(torso[0][0], torso[0][1]);
  torso.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.closePath();
  ctx.fillStyle = bodyGradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 6;
  ctx.stroke();

  // 胸腔高光
  ctx.beginPath();
  ctx.ellipse(
    (shoulderMid[0] + hipMid[0]) / 2,
    shoulderMid[1] + (hipMid[1] - shoulderMid[1]) * 0.36,
    shoulderSpan * 0.26,
    ((hipMid[1] - shoulderMid[1]) * 0.32),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
  ctx.fill();

  // 骨盆
  ctx.beginPath();
  ctx.ellipse(hipMid[0], hipMid[1], hipHalf * 1.14, Math.max(24, hipHalf * 0.62), 0, 0, Math.PI * 2);
  ctx.fillStyle = LIMB_COLORS.bodyDark;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // 手臂
  capsule(ctx, point.rSh, point.rEl, armW, LIMB_COLORS.armR);
  capsule(ctx, point.rEl, point.rWr, armW * 0.84, LIMB_COLORS.armR);
  capsule(ctx, point.lSh, point.lEl, armW, LIMB_COLORS.armL);
  capsule(ctx, point.lEl, point.lWr, armW * 0.84, LIMB_COLORS.armL);
  jointBall(ctx, point.rWr, armW * 0.5, LIMB_COLORS.armR);
  jointBall(ctx, point.lWr, armW * 0.5, LIMB_COLORS.armL);

  // 头
  const headRadius = clamp(shoulderSpan * 0.52, 42, 96);
  const headCenter = [
    point.neck[0] + (point.nose[0] - point.neck[0]) * 0.5,
    point.neck[1] + (point.nose[1] - point.neck[1]) * 0.95,
  ];
  const headGradient = ctx.createRadialGradient(
    headCenter[0] - headRadius * 0.3,
    headCenter[1] - headRadius * 0.35,
    headRadius * 0.24,
    headCenter[0],
    headCenter[1],
    headRadius,
  );
  headGradient.addColorStop(0, '#f4efe4');
  headGradient.addColorStop(0.6, '#d3cbbd');
  headGradient.addColorStop(1, '#7c7569');
  ctx.beginPath();
  ctx.ellipse(headCenter[0], headCenter[1], headRadius, headRadius * 1.16, 0, 0, Math.PI * 2);
  ctx.fillStyle = headGradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // 面部朝向（鼻尖）
  const faceRadius = clamp(headRadius * 0.16, 7, 17);
  ctx.beginPath();
  ctx.arc(point.nose[0], point.nose[1], faceRadius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(92, 84, 72, 0.85)';
  ctx.fill();

  // 关节球
  [point.rEl, point.lEl, point.rKn, point.lKn].forEach((item, index) => {
    const color = index < 2
      ? [LIMB_COLORS.armR, LIMB_COLORS.armL][index]
      : [LIMB_COLORS.legR, LIMB_COLORS.legL][index - 2];
    jointBall(ctx, item, (index < 2 ? armW : legW) * 0.52, color);
  });

  if (!handles) return;

  ctx.save();
  JOINTS.forEach((key) => {
    const [x, y] = point[key];
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.stroke();
  });
  ctx.restore();
}

/**
 * 打开姿态工作室。
 * @param {{
 *   initial?: {joints?: object, preset?: string, strength?: number, useLora?: boolean},
 *   onApply?: (pose: object) => void,
 *   onClear?: () => void,
 * }} options
 */
export function openPoseStudio({ initial = null, onApply, onClear } = {}) {
  const startPreset = initial?.preset && PRESETS.some((item) => item.id === initial.preset)
    ? initial.preset
    : 'stand';
  let joints = initial?.joints ? clonePose(initial.joints) : jointsFromPreset(presetById(startPreset));
  let presetId = initial?.joints ? 'custom' : startPreset;
  let scale = 100;
  let strength = initial?.strength ?? 0.85;
  let useLora = initial?.useLora !== false;
  let activeDrag = null;

  const content = document.createElement('div');
  content.className = 'pose-studio';
  content.innerHTML = `
    <div class="pose-stage">
      <canvas class="pose-canvas" width="${W}" height="${H}"></canvas>
      <span class="pose-stage-tip">拖动白色圆点调整关节 · 人偶只提供动作与构图</span>
    </div>
    <aside class="pose-side">
      <div class="pose-block">
        <div class="pose-block-title">姿态预设</div>
        <div class="pose-presets">
          ${PRESETS.map(
            (preset) => `<button class="pose-preset" type="button" data-preset="${preset.id}" title="${escapeHtml(preset.summary)}">${preset.label}</button>`,
          ).join('')}
        </div>
      </div>
      <div class="pose-block">
        <div class="pose-block-title">构图微调</div>
        <label class="pose-slider">人物大小
          <input type="range" min="80" max="125" step="1" value="100" data-ref="scale" />
          <span class="mono" data-ref="scaleVal">100%</span>
        </label>
        <div class="pose-btn-row">
          <button class="btn ghost sm" type="button" data-action="flip">水平翻转</button>
          <button class="btn ghost sm" type="button" data-action="reset">重置姿态</button>
        </div>
      </div>
      <div class="pose-block">
        <div class="pose-block-title">跟随强度</div>
        <label class="pose-slider">姿态 LoRA
          <input type="range" min="0.3" max="1.2" step="0.05" value="${strength}" data-ref="strength" />
          <span class="mono" data-ref="strengthVal">${strength.toFixed(2)}</span>
        </label>
        <label class="pose-check">
          <input type="checkbox" data-ref="useLora" ${useLora ? 'checked' : ''} />
          <span>启用姿态 LoRA<small>更强的骨骼跟随；关闭后只做姿态语义参考</small></span>
        </label>
      </div>
      <div class="pose-note">
        文生图：姿态图作为 image1，提示词补全场景与人物细节。<br />
        图生图：姿态图作为 image1，第 1 张参考图顺延为 image2，并自动改写指令里的 &lt;imageN&gt; 编号。
      </div>
    </aside>`;

  const canvas = content.querySelector('.pose-canvas');
  const scaleInput = content.querySelector('[data-ref="scale"]');
  const scaleVal = content.querySelector('[data-ref="scaleVal"]');
  const strengthInput = content.querySelector('[data-ref="strength"]');
  const strengthVal = content.querySelector('[data-ref="strengthVal"]');
  const useLoraInput = content.querySelector('[data-ref="useLora"]');
  const presetButtons = [...content.querySelectorAll('[data-preset]')];
  const summary = () => {
    if (presetId === 'custom') return '自定义姿态';
    const preset = presetById(presetId);
    return `${preset.label}：${preset.summary}`;
  };

  function paint() {
    renderMannequin(canvas.getContext('2d'), joints, { scale: scale / 100, handles: true });
    presetButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.preset === presetId);
    });
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * W,
      ((event.clientY - rect.top) / rect.height) * H,
    ];
  }

  function hitTest(position) {
    const anchor = [
      (joints.neck.x + joints.rHip.x + joints.lHip.x) / 3,
      (joints.neck.y + joints.rHip.y + joints.lHip.y) / 3,
    ];
    let best = null;
    let bestDistance = 30;
    JOINTS.forEach((key) => {
      const x = (anchor[0] + (joints[key].x - anchor[0]) * (scale / 100)) * W;
      const y = (anchor[1] + (joints[key].y - anchor[1]) * (scale / 100)) * H;
      const distance = Math.hypot(position[0] - x, position[1] - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = key;
      }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (event) => {
    const key = hitTest(canvasPoint(event));
    if (!key) return;
    activeDrag = key;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!activeDrag) {
      canvas.style.cursor = hitTest(canvasPoint(event)) ? 'grab' : 'default';
      return;
    }
    const [x, y] = canvasPoint(event);
    const anchor = [
      (joints.neck.x + joints.rHip.x + joints.lHip.x) / 3,
      (joints.neck.y + joints.rHip.y + joints.lHip.y) / 3,
    ];
    joints[activeDrag] = {
      x: clamp(anchor[0] + (x / W - anchor[0]) / (scale / 100), 0.03, 0.97),
      y: clamp(anchor[1] + (y / H - anchor[1]) / (scale / 100), 0.03, 0.97),
    };
    presetId = 'custom';
    paint();
  });

  const endDrag = () => {
    activeDrag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      presetId = button.dataset.preset;
      joints = jointsFromPreset(presetById(presetId));
      paint();
    });
  });

  content.querySelector('[data-action="flip"]').addEventListener('click', () => {
    JOINTS.forEach((key) => {
      joints[key].x = clamp(1 - joints[key].x, 0.03, 0.97);
    });
    presetId = 'custom';
    paint();
  });

  content.querySelector('[data-action="reset"]').addEventListener('click', () => {
    presetId = 'stand';
    scale = 100;
    scaleInput.value = '100';
    scaleVal.textContent = '100%';
    joints = jointsFromPreset(presetById('stand'));
    paint();
  });

  scaleInput.addEventListener('input', () => {
    scale = Number(scaleInput.value);
    scaleVal.textContent = `${scale}%`;
    paint();
  });

  strengthInput.addEventListener('input', () => {
    strength = Number(strengthInput.value);
    strengthVal.textContent = strength.toFixed(2);
  });

  useLoraInput.addEventListener('change', () => {
    useLora = useLoraInput.checked;
  });

  paint();

  openModal({
    title: '姿态参考',
    subtitle: '摆好动作后应用到指令框，作为构图与骨骼参考',
    content,
    size: 'lg',
    dialogClass: 'pose-dialog-modal',
    actions: [
      { label: '取消' },
      {
        label: '清除姿态',
        onClick: () => {
          onClear?.();
          return true;
        },
      },
      {
        label: '应用姿态',
        kind: 'primary',
        onClick: () => {
          const exportCanvas = document.createElement('canvas');
          exportCanvas.width = W;
          exportCanvas.height = H;
          renderMannequin(exportCanvas.getContext('2d'), joints, { scale: scale / 100, handles: false });
          onApply?.({
            dataUrl: exportCanvas.toDataURL('image/png'),
            width: W,
            height: H,
            joints: clonePose(joints),
            preset: presetId,
            label: presetId === 'custom' ? '自定义姿态' : presetById(presetId).label,
            summary: summary(),
            strength: Number(strength.toFixed(2)),
            useLora,
          });
          return true;
        },
      },
    ],
  });
}
