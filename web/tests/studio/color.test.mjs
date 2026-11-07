/**
 * 调色数学库单测（D9.1）：`node --test web/tests/studio/color.test.mjs`
 * 纯函数、无 DOM 依赖，Node ≥ 18 可直接跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HSL_BANDS,
  applyChannelLUTs,
  applyColorBalance,
  applyGains,
  applyHSL,
  applyLevels,
  buildChannelLUTs,
  buildCurveLUT,
  buildLevelsLUT,
  grayPointGains,
  hslToRgb,
  kelvinToGains,
  monotoneCubic,
  rgbToHsl,
  whiteBalanceGains,
} from '../../src/components/studio/color.js';

const px = (r, g, b, a = 255) => new Uint8ClampedArray([r, g, b, a]);
const near = (actual, expected, tolerance = 2) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ≈${expected}，实际 ${actual}`);

/* ---------------------------------------------------------------- 曲线 */

test('曲线：默认为恒等 LUT', () => {
  const lut = buildCurveLUT();
  for (let i = 0; i < 256; i += 1) assert.equal(lut[i], i);
});

test('曲线：控制点命中且单调递增', () => {
  const lut = buildCurveLUT([
    { x: 0, y: 0 },
    { x: 128, y: 200 },
    { x: 255, y: 255 },
  ]);
  near(lut[0], 0);
  near(lut[128], 200);
  near(lut[255], 255);
  for (let i = 1; i < 256; i += 1) assert.ok(lut[i] >= lut[i - 1], `LUT 在 ${i} 处回退`);
});

test('曲线：单调插值不越界（Fritsch–Carlson）', () => {
  const evaluate = monotoneCubic([
    { x: 0, y: 0 },
    { x: 64, y: 20 },
    { x: 128, y: 200 },
    { x: 255, y: 255 },
  ]);
  let previous = -1;
  for (let x = 0; x <= 255; x += 1) {
    const value = evaluate(x);
    assert.ok(value >= 0 && value <= 255, `x=${x} 越界 ${value}`);
    assert.ok(value >= previous, `x=${x} 非单调`);
    previous = value;
  }
});

test('曲线：S 形提对比（暗更暗、亮更亮）', () => {
  const lut = buildCurveLUT([
    { x: 0, y: 0 },
    { x: 64, y: 44 },
    { x: 192, y: 212 },
    { x: 255, y: 255 },
  ]);
  assert.ok(lut[64] < 64);
  assert.ok(lut[192] > 192);
});

test('复合曲线 + 单通道曲线分别查表，alpha 不变', () => {
  const luts = buildChannelLUTs({
    rgb: [{ x: 0, y: 0 }, { x: 255, y: 128 }],
    r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  });
  const data = new Uint8ClampedArray([255, 255, 255, 77]);
  applyChannelLUTs(data, luts);
  near(data[0], 128, 3);
  near(data[1], 128, 3);
  assert.equal(data[3], 77);
});

/* ---------------------------------------------------------------- 色阶 */

test('色阶：默认参数为恒等映射', () => {
  const lut = buildLevelsLUT({});
  for (let i = 0; i < 256; i += 1) assert.equal(lut[i], i);
});

test('色阶：黑白点裁切与中间调', () => {
  const lut = buildLevelsLUT({ black: 64, white: 192 });
  assert.equal(lut[10], 0);
  assert.equal(lut[250], 255);
  near(lut[128], 128, 2);
});

test('色阶：gamma 与输出区间', () => {
  const bright = buildLevelsLUT({ gamma: 2 });
  assert.ok(bright[64] > 64);
  const inverted = buildLevelsLUT({ outBlack: 255, outWhite: 0 });
  assert.equal(inverted[0], 255);
  assert.equal(inverted[255], 0);
});

test('色阶：applyLevels 原地生效', () => {
  const data = new Uint8ClampedArray([0, 128, 255, 12]);
  applyLevels(data, { black: 0, white: 255, gamma: 2 });
  assert.ok(data[1] > 128);
  assert.equal(data[3], 12);
});

/* ---------------------------------------------------------------- HSL */

test('HSL：RGB ↔ HSL 往返一致', () => {
  const cases = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [12, 200, 140],
    [128, 128, 128],
  ];
  for (const [r, g, b] of cases) {
    const { h, s, l } = rgbToHsl(r, g, b);
    const back = hslToRgb(h, s, l);
    near(back.r, r, 2);
    near(back.g, g, 2);
    near(back.b, b, 2);
  }
});

test('HSL：8 个默认色相带中心互不重叠', () => {
  assert.equal(HSL_BANDS.length, 8);
  const hues = HSL_BANDS.map((band) => band.hue);
  assert.deepEqual(hues, [0, 45, 90, 135, 180, 225, 270, 315]);
});

test('HSL：降低红色饱和度不影响蓝色', () => {
  const red = px(255, 0, 0);
  applyHSL(red, [{ hue: 0, s: -100 }]);
  near(red[0], red[1], 2);
  near(red[1], red[2], 2);
  near(red[0], 128, 2);

  const blue = px(0, 0, 255);
  applyHSL(blue, [{ hue: 0, s: -100 }]);
  assert.deepEqual([...blue], [0, 0, 255, 255]);
});

test('HSL：红色带色相偏移 +60° 得到黄色', () => {
  const red = px(255, 0, 0);
  applyHSL(red, [{ hue: 0, h: 60 }]);
  assert.ok(red[0] > 240 && red[1] > 240, `实际 ${red[0]},${red[1]}`);
  assert.ok(red[2] < 20);
});

test('HSL：过渡区按距离加权平均', () => {
  // 色相 22° 同时受红带（0°）与橙带（45°）影响，取中点偏移
  const color = px(255, 96, 0);
  const base = px(255, 96, 0);
  applyHSL(color, [
    { hue: 0, l: 40 },
    { hue: 45, l: -40 },
  ]);
  assert.notDeepEqual([...color], [...base]);
  // 加权后应接近原亮度，而不是任一端点
  const before = rgbToHsl(base[0], base[1], base[2]).l;
  const after = rgbToHsl(color[0], color[1], color[2]).l;
  assert.ok(Math.abs(after - before) < 0.12, `亮度漂移过大：${before} → ${after}`);
});

/* ------------------------------------------------------------ 色彩平衡 */

test('色彩平衡：阴影偏移主要影响暗部', () => {
  const dark = px(30, 30, 30);
  const bright = px(230, 230, 230);
  const params = { shadows: { r: 50 }, preserveLuma: true };
  applyColorBalance(dark, params);
  applyColorBalance(bright, params);
  const darkDelta = dark[0] - dark[1];
  const brightDelta = bright[0] - bright[1];
  assert.ok(darkDelta > brightDelta, `暗部 ${darkDelta} 应大于亮部 ${brightDelta}`);
  assert.ok(new Set(dark).size > 1, '暗部应带上色偏');
});

test('色彩平衡：高光偏移主要影响亮部', () => {
  const dark = px(30, 30, 30);
  const bright = px(230, 230, 230);
  applyColorBalance(dark, { highlights: { b: 50 } });
  applyColorBalance(bright, { highlights: { b: 50 } });
  assert.ok(bright[2] - bright[1] > dark[2] - dark[1]);
});

test('色彩平衡：默认保持亮度', () => {
  const pixel = px(120, 120, 120);
  const before = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
  applyColorBalance(pixel, { midtones: { r: 60, b: -30 } });
  const after = 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2];
  assert.ok(Math.abs(after - before) < 2, `亮度 ${before} → ${after}`);
});

test('色彩平衡：全零参数不改动像素', () => {
  const data = new Uint8ClampedArray([10, 20, 30, 255]);
  applyColorBalance(data, { shadows: {}, midtones: {}, highlights: {} });
  assert.deepEqual([...data], [10, 20, 30, 255]);
});

/* ------------------------------------------------------------ 白平衡 */

test('色温：低压钠灯偏红、冷色温偏蓝', () => {
  const warm = kelvinToGains(3000);
  const cool = kelvinToGains(9000);
  assert.ok(warm.b < cool.b);
  assert.ok(warm.r >= cool.r);
});

test('白平衡：温度正向偏暖、负向偏冷', () => {
  const warm = whiteBalanceGains({ temperature: 100 });
  const cool = whiteBalanceGains({ temperature: -100 });
  assert.ok(warm.r > 1 && warm.b < 1, `暖 ${JSON.stringify(warm)}`);
  assert.ok(cool.b > 1 && cool.r < 1, `冷 ${JSON.stringify(cool)}`);
  near(whiteBalanceGains({}).g, 1, 0.001);
});

test('白平衡：色调正向偏洋红（绿增益下降）', () => {
  const magenta = whiteBalanceGains({ tint: 100 });
  const green = whiteBalanceGains({ tint: -100 });
  assert.ok(magenta.g < 1);
  assert.ok(green.g > 1);
});

test('灰点吸管：把中性色还原为等通道', () => {
  const source = px(200, 180, 160);
  const gains = grayPointGains(source[0], source[1], source[2]);
  applyGains(source, gains);
  near(source[0], source[1], 2);
  near(source[1], source[2], 2);
});

test('增益：strength 控制渐入', () => {
  const zero = px(100, 100, 100);
  applyGains(zero, { r: 2, g: 1, b: 0.5 }, 0);
  assert.deepEqual([...zero], [100, 100, 100, 255]);

  const half = px(100, 100, 100);
  applyGains(half, { r: 2, g: 1, b: 0.5 }, 0.5);
  near(half[0], 150, 2);
  near(half[2], 75, 2);
  assert.equal(half[1], 100);
});
