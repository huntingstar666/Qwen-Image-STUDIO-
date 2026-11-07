/**
 * 连续编辑（接力）辅助：从预设读取 chain 契约、取回结果图、估算累计漂移。
 *
 * `chain` 由后端预设下发（见 server/presets.py）：
 *   { mode: 'mask'|'native', carry_mask, anchor_every, drift_warn_delta_e }
 * 本模块只做纯计算与取图，不改页面状态；状态机在 edit.js。
 */

/** 从公开预设里取出 chain 契约；非接力预设返回 null。 */
export function chainConfigOf(presetMeta) {
  const chain = presetMeta?.params?.chain;
  if (!chain || (chain.mode !== 'mask' && chain.mode !== 'native')) return null;
  return {
    mode: chain.mode,
    carryMask: Boolean(chain.carry_mask),
    anchorEvery: Math.max(1, Number(chain.anchor_every) || 5),
    driftWarn: Number(chain.drift_warn_delta_e) || 10,
  };
}

/** 把任务结果图（同源 URL）读成 dataURL，供下一轮直接作为输入。 */
export async function imageUrlToDataUrl(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`读取结果图失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('结果图读取失败'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = src;
  });
}

function srgbToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(r, g, b) {
  const red = srgbToLinear(r);
  const green = srgbToLinear(g);
  const blue = srgbToLinear(b);
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * 两张图缩到同一张小画布后求平均 ΔE76（0~100）。
 * 连续编辑每轮输出尺寸不变，这里只用来做"相对首帧"的漂移趋势，不追求逐像素精确。
 */
export async function meanDeltaE(sourceA, sourceB, maxSide = 192) {
  const [a, b] = await Promise.all([loadImage(sourceA), loadImage(sourceB)]);
  const width = Math.max(1, Math.min(maxSide, a.width, b.width));
  const height = Math.max(1, Math.round((width * Math.min(a.height, b.height)) / Math.max(1, Math.min(a.width, b.width))));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.drawImage(a, 0, 0, width, height);
  const dataA = ctx.getImageData(0, 0, width, height).data;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(b, 0, 0, width, height);
  const dataB = ctx.getImageData(0, 0, width, height).data;

  let total = 0;
  let count = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    if (dataA[i + 3] === 0 && dataB[i + 3] === 0) continue;
    const [l1, a1, b1] = rgbToLab(dataA[i], dataA[i + 1], dataA[i + 2]);
    const [l2, a2, b2] = rgbToLab(dataB[i], dataB[i + 1], dataB[i + 2]);
    total += Math.hypot(l1 - l2, a1 - a2, b1 - b2);
    count += 1;
  }
  return count ? Math.round((total / count) * 100) / 100 : 0;
}
