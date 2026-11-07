/**
 * 调色数学库（D9.1）：纯函数、零依赖，可在 Node 下直接单测。
 *
 * 约定：
 * 1. 输入与输出统一为 RGBA 的 `Uint8ClampedArray`（原地修改并返回，alpha 不动）；
 * 2. 曲线 / 色阶统一产出 256 项 LUT，渲染时查表，避免逐像素做插值；
 * 3. 所有颜色按 sRGB 处理，不做 ICC / CMYK（与 §14.5 颜色范围一致）。
 */

export const LUT_SIZE = 256;

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/* ---------------------------------------------------------------- 曲线 */

/**
 * 单调三次插值（Fritsch–Carlson），保证 LUT 不出现反转过冲。
 * @param {{x:number,y:number}[]} points 控制点，x / y 均为 0~255
 * @returns {(x:number)=>number}
 */
export function monotoneCubic(points) {
  const source = (points || [])
    .map((point) => ({ x: clamp(Number(point.x) || 0, 0, 255), y: clamp(Number(point.y) || 0, 0, 255) }))
    .sort((a, b) => a.x - b.x);

  // 去重：同一 x 只保留最后一个点，避免除零
  const list = [];
  for (const point of source) {
    if (list.length && Math.abs(list[list.length - 1].x - point.x) < 1e-6) list[list.length - 1] = point;
    else list.push(point);
  }
  if (!list.length) return (x) => x;
  if (list.length === 1) return () => list[0].y;

  const n = list.length;
  const width = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = list[i + 1].x - list[i].x;
    width.push(dx);
    slope.push((list[i + 1].y - list[i].y) / dx);
  }

  const tangent = new Array(n).fill(0);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) tangent[i] = 0;
    else tangent[i] = (slope[i - 1] + slope[i]) / 2;
  }
  // 限制切线，保证单调
  for (let i = 0; i < n - 1; i += 1) {
    if (Math.abs(slope[i]) < 1e-9) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      tangent[i] = tau * a * slope[i];
      tangent[i + 1] = tau * b * slope[i];
    }
  }

  return (x) => {
    const value = Number(x) || 0;
    if (value <= list[0].x) return list[0].y;
    if (value >= list[n - 1].x) return list[n - 1].y;
    let index = 0;
    while (index < n - 2 && value > list[index + 1].x) index += 1;
    const h = width[index];
    const t = (value - list[index].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return clamp(
      h00 * list[index].y + h10 * h * tangent[index] + h01 * list[index + 1].y + h11 * h * tangent[index + 1],
      0,
      255,
    );
  };
}

/**
 * 控制点 → 256 项曲线 LUT。`points` 为空时返回恒等曲线。
 * @param {{x:number,y:number}[]} points
 * @param {number} [size]
 * @returns {Uint8ClampedArray}
 */
export function buildCurveLUT(points, size = LUT_SIZE) {
  const list = points?.length ? points : [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  const evaluate = monotoneCubic(list);
  const lut = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i += 1) {
    lut[i] = Math.round(evaluate((i * 255) / (size - 1)));
  }
  return lut;
}

/**
 * @param {{rgb?:{x:number,y:number}[], r?:{x:number,y:number}[], g?:..., b?:...}} curves
 * @param {number} [size]
 * @returns {{rgb:Uint8ClampedArray, r:Uint8ClampedArray, g:Uint8ClampedArray, b:Uint8ClampedArray}}
 */
export function buildChannelLUTs(curves = {}, size = LUT_SIZE) {
  return {
    rgb: buildCurveLUT(curves.rgb, size),
    r: buildCurveLUT(curves.r, size),
    g: buildCurveLUT(curves.g, size),
    b: buildCurveLUT(curves.b, size),
  };
}

/**
 * 按复合曲线 + 单通道曲线查表；只处理 RGB，alpha 保持不变。
 * @param {Uint8ClampedArray} data
 * @param {{rgb?:Uint8ClampedArray, r?:Uint8ClampedArray, g?:Uint8ClampedArray, b?:Uint8ClampedArray}} luts
 */
export function applyChannelLUTs(data, luts) {
  const { rgb, r, g, b } = luts || {};
  for (let i = 0; i < data.length; i += 4) {
    if (rgb) {
      data[i] = rgb[data[i]];
      data[i + 1] = rgb[data[i + 1]];
      data[i + 2] = rgb[data[i + 2]];
    }
    if (r) data[i] = r[data[i]];
    if (g) data[i + 1] = g[data[i + 1]];
    if (b) data[i + 2] = b[data[i + 2]];
  }
  return data;
}

/* ---------------------------------------------------------------- 色阶 */

/**
 * 输入黑/白点归一化 → gamma → 输出区间映射。
 * @param {{black?:number, white?:number, gamma?:number, outBlack?:number, outWhite?:number}} params
 * @param {number} [size]
 */
export function buildLevelsLUT(params = {}, size = LUT_SIZE) {
  const black = clamp(Number(params.black ?? 0), 0, 255);
  const white = clamp(Number(params.white ?? 255), 0, 255);
  const span = Math.max(1, white - black);
  const gamma = Math.max(0.01, Number(params.gamma ?? 1));
  const outBlack = clamp(Number(params.outBlack ?? 0), 0, 255);
  const outWhite = clamp(Number(params.outWhite ?? 255), 0, 255);
  const lut = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i += 1) {
    const value = (i * 255) / (size - 1);
    let t = clamp((value - black) / span, 0, 1);
    if (gamma !== 1) t = Math.pow(t, 1 / gamma);
    lut[i] = Math.round(outBlack + t * (outWhite - outBlack));
  }
  return lut;
}

export function applyLevels(data, params) {
  const lut = buildLevelsLUT(params);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  return data;
}

/* ---------------------------------------------------------------- HSL */

/** @returns {{h:number,s:number,l:number}} h: 0~360 度，s/l: 0~1 */
export function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

/** @returns {{r:number,g:number,b:number}} 0~255，未取整 */
export function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 1);
  const ln = clamp(l, 0, 1);
  if (sn === 0) {
    const value = ln * 255;
    return { r: value, g: value, b: value };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hk = hue / 360;
  return {
    r: channel(hk + 1 / 3) * 255,
    g: channel(hk) * 255,
    b: channel(hk - 1 / 3) * 255,
  };
}

/** 默认 8 个色相带（红 / 橙 / 黄 / 绿 / 青 / 蓝 / 紫 / 洋红）。 */
export const HSL_BANDS = [
  { hue: 0, key: 'red' },
  { hue: 45, key: 'orange' },
  { hue: 90, key: 'yellow' },
  { hue: 135, key: 'green' },
  { hue: 180, key: 'aqua' },
  { hue: 225, key: 'blue' },
  { hue: 270, key: 'purple' },
  { hue: 315, key: 'magenta' },
];

function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * 分色相带调整：每条带按色相距离加权（默认 40° 过渡），偏移量在重叠处加权平均。
 * @param {Uint8ClampedArray} data
 * @param {{hue:number, h?:number, s?:number, l?:number}[]} bands h: 色相度数偏移；s/l: -100~100
 * @param {{feather?:number}} [options]
 */
export function applyHSL(data, bands, options = {}) {
  const list = (bands || []).filter((band) => band && (band.h || band.s || band.l));
  if (!list.length) return data;
  const feather = Math.max(1, Number(options.feather ?? 40));
  for (let i = 0; i < data.length; i += 4) {
    const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.001) continue;
    let weight = 0;
    let hShift = 0;
    let sShift = 0;
    let lShift = 0;
    for (const band of list) {
      const distance = hueDistance(h, band.hue ?? 0);
      const w = 1 - distance / feather;
      if (w <= 0) continue;
      weight += w;
      hShift += w * (band.h || 0);
      sShift += w * (band.s || 0);
      lShift += w * (band.l || 0);
    }
    if (weight <= 0) continue;
    const hs = hShift / weight;
    const ss = sShift / weight;
    const ls = lShift / weight;
    const nextH = h + hs;
    const nextS = ss >= 0 ? s + (1 - s) * (ss / 100) : s * (1 + ss / 100);
    const nextL = ls >= 0 ? l + (1 - l) * (ls / 100) : l * (1 + ls / 100);
    const rgb = hslToRgb(nextH, nextS, nextL);
    data[i] = Math.round(rgb.r);
    data[i + 1] = Math.round(rgb.g);
    data[i + 2] = Math.round(rgb.b);
  }
  return data;
}

/* ------------------------------------------------------------ 色彩平衡 */

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function balanceWeight(l) {
  // 阴影 / 中间调 / 高光三段重叠权重，和为 1
  const shadow = clamp(1 - l * 2, 0, 1);
  const highlight = clamp(l * 2 - 1, 0, 1);
  return { shadow, mid: 1 - shadow - highlight, highlight };
}

/**
 * 阴影 / 中间调 / 高光三段偏移，默认保持原亮度。
 * @param {Uint8ClampedArray} data
 * @param {{shadows?:{r?:number,g?:number,b?:number}, midtones?:..., highlights?:..., preserveLuma?:boolean, scale?:number}} params
 */
export function applyColorBalance(data, params = {}) {
  const sections = [params.shadows, params.midtones, params.highlights].map((item) => ({
    r: Number(item?.r) || 0,
    g: Number(item?.g) || 0,
    b: Number(item?.b) || 0,
  }));
  if (sections.every((item) => !item.r && !item.g && !item.b)) return data;
  const scale = Number(params.scale ?? 100);
  const preserve = params.preserveLuma !== false;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const weight = balanceWeight(luma(r, g, b) / 255);
    const weights = [weight.shadow, weight.mid, weight.highlight];
    let dr = 0;
    let dg = 0;
    let db = 0;
    for (let s = 0; s < 3; s += 1) {
      const w = weights[s];
      if (w <= 0) continue;
      dr += (sections[s].r / 100) * w * scale;
      dg += (sections[s].g / 100) * w * scale;
      db += (sections[s].b / 100) * w * scale;
    }
    if (!dr && !dg && !db) continue;
    let nr = r + dr;
    let ng = g + dg;
    let nb = b + db;
    if (preserve) {
      const diff = luma(r, g, b) - luma(nr, ng, nb);
      nr += diff;
      ng += diff;
      nb += diff;
    }
    data[i] = Math.round(clamp(nr, 0, 255));
    data[i + 1] = Math.round(clamp(ng, 0, 255));
    data[i + 2] = Math.round(clamp(nb, 0, 255));
  }
  return data;
}

/* ------------------------------------------------------------ 白平衡 */

/**
 * 色温（开尔文）→ RGB 增益，近似 Tanner Helland 的黑体辐射公式，结果归一到 0~1。
 * @param {number} kelvin
 * @returns {{r:number,g:number,b:number}}
 */
export function kelvinToGains(kelvin) {
  const temp = clamp(Number(kelvin) || 6500, 1000, 40000) / 100;
  let red;
  let green;
  let blue;
  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }
  return {
    r: clamp(red, 0, 255) / 255,
    g: clamp(green, 0, 255) / 255,
    b: clamp(blue, 0, 255) / 255,
  };
}

/**
 * 滑杆值（-100~100）→ RGB 增益。温度正=偏暖（红多蓝少），色调正=偏洋红。
 * 结果按绿色归一，尽量保持整体亮度。
 * @param {{temperature?:number, tint?:number, base?:number}} params
 */
export function whiteBalanceGains(params = {}) {
  const temperature = clamp(Number(params.temperature) || 0, -100, 100);
  const tint = clamp(Number(params.tint) || 0, -100, 100);
  const base = Number(params.base ?? 6500);
  // 滑杆正向 = 画面更暖，对应更低的色温
  const kelvin = base - temperature * 30;
  const current = kelvinToGains(kelvin);
  const reference = kelvinToGains(base);
  let r = current.r / Math.max(1e-4, reference.r);
  let g = current.g / Math.max(1e-4, reference.g);
  let b = current.b / Math.max(1e-4, reference.b);
  const t = tint / 100;
  g *= 1 - t * 0.2;
  r *= 1 + t * 0.04;
  b *= 1 + t * 0.04;
  // 按感知亮度归一，既保持整体亮度，又保留色调偏移
  const norm = Math.max(1e-4, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  return { r: r / norm, g: g / norm, b: b / norm };
}

/** 灰点吸管：按中性灰反推增益，使该像素三通道相等。 */
export function grayPointGains(r, g, b) {
  const target = luma(r, g, b);
  const safe = (value) => (value > 1 ? target / value : 1);
  return { r: safe(r), g: safe(g), b: safe(b) };
}

/** 三通道增益；`strength` 0~1 用于吸取后渐入。 */
export function applyGains(data, gains, strength = 1) {
  if (!gains) return data;
  const amount = clamp(Number(strength) || 0, 0, 1);
  if (amount <= 0) return data;
  const mix = (value, gain) => Math.round(clamp(value * (1 + (gain - 1) * amount), 0, 255));
  const { r = 1, g = 1, b = 1 } = gains;
  if (r === 1 && g === 1 && b === 1) return data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = mix(data[i], r);
    data[i + 1] = mix(data[i + 1], g);
    data[i + 2] = mix(data[i + 2], b);
  }
  return data;
}
