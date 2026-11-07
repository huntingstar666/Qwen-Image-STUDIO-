import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADJUSTMENT_DEFAULTS,
  applyAdjustment,
  hasAdjustment,
  normalizeAdjustment,
} from '../../src/components/studio/adjustments.js';

function pixel(r, g, b, a = 255) {
  return Uint8ClampedArray.from([r, g, b, a]);
}

function near(actual, expected, tolerance = 2) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} ≈ ${expected} (±${tolerance})`,
  );
}

test('normalizeAdjustment 补齐默认值并夹在 -100~100', () => {
  const params = normalizeAdjustment({ exposure: 240, brightness: -999, nope: 3 });
  assert.equal(params.exposure, 100);
  assert.equal(params.brightness, -100);
  assert.equal(params.contrast, 0);
  assert.equal(params.saturation, 0);
  assert.equal(params.temperature, 0);
  assert.equal(params.tint, 0);
  assert.deepEqual(Object.keys(params).sort(), Object.keys(ADJUSTMENT_DEFAULTS).sort());
});

test('normalizeAdjustment 丢弃非法值', () => {
  const params = normalizeAdjustment({ exposure: 'abc', contrast: NaN });
  assert.equal(params.exposure, 0);
  assert.equal(params.contrast, 0);
});

test('hasAdjustment 识别全零与非零', () => {
  assert.equal(hasAdjustment({}), false);
  assert.equal(hasAdjustment({ exposure: 12 }), true);
});

test('曝光 +100 相当于亮度翻倍', () => {
  const data = pixel(100, 100, 100);
  applyAdjustment(data, { exposure: 100 });
  near(data[0], 200);
  near(data[1], 200);
  near(data[2], 200);
});

test('亮度 -100 压成纯黑', () => {
  const data = pixel(120, 80, 40);
  applyAdjustment(data, { brightness: -100 });
  assert.deepEqual([...data], [0, 0, 0, 255]);
});

test('对比度 +100 以中灰为轴拉开明暗', () => {
  const data = pixel(100, 180, 128);
  applyAdjustment(data, { contrast: 100 });
  // (100/255 - 0.5) * 2 + 0.5 = 0.2843 → 73
  near(data[0], 73);
  // (180/255 - 0.5) * 2 + 0.5 = 0.9118 → 233
  near(data[1], 233);
  near(data[2], 128);
});

test('饱和度 -100 得到灰度且保持感知亮度', () => {
  const data = pixel(200, 60, 40);
  const luma = 0.2126 * 200 + 0.7152 * 60 + 0.0722 * 40;
  applyAdjustment(data, { saturation: -100 });
  near(data[0], luma, 3);
  assert.equal(data[0], data[1]);
  assert.equal(data[1], data[2]);
});

test('零参数不改变像素', () => {
  const data = pixel(12, 200, 99);
  applyAdjustment(data, {});
  assert.deepEqual([...data], [12, 200, 99, 255]);
});

test('strength 0 不生效，0.5 位于原值与全量之间', () => {
  const full = pixel(100, 100, 100);
  applyAdjustment(full, { exposure: 100 }, 1);

  const half = pixel(100, 100, 100);
  applyAdjustment(half, { exposure: 100 }, 0.5);
  assert.ok(half[0] > 100 && half[0] < full[0], `half=${half[0]} full=${full[0]}`);

  const none = pixel(100, 100, 100);
  applyAdjustment(none, { exposure: 100 }, 0);
  assert.deepEqual([...none], [100, 100, 100, 255]);
});

test('透明像素保持原样', () => {
  const data = pixel(200, 10, 10, 0);
  applyAdjustment(data, { exposure: 100, saturation: -100 });
  assert.deepEqual([...data], [200, 10, 10, 0]);
});

test('色温正向偏暖：红升蓝降', () => {
  const warm = pixel(128, 128, 128);
  applyAdjustment(warm, { temperature: 60 });
  assert.ok(warm[0] > 128, `r=${warm[0]}`);
  assert.ok(warm[2] < 128, `b=${warm[2]}`);

  const cool = pixel(128, 128, 128);
  applyAdjustment(cool, { temperature: -60 });
  assert.ok(cool[0] < 128, `r=${cool[0]}`);
  assert.ok(cool[2] > 128, `b=${cool[2]}`);
});

test('色调正向偏洋红：绿降红蓝升', () => {
  const data = pixel(128, 128, 128);
  applyAdjustment(data, { tint: 80 });
  assert.ok(data[0] > 128, `r=${data[0]}`);
  assert.ok(data[1] < 128, `g=${data[1]}`);
  assert.ok(data[2] > 128, `b=${data[2]}`);
});

test('组合参数按顺序叠加且不越界', () => {
  const data = pixel(250, 240, 230);
  applyAdjustment(data, { exposure: 60, contrast: 40, saturation: 40, temperature: 30 });
  for (const value of data) assert.ok(value >= 0 && value <= 255);
  assert.ok(data[0] >= data[1] && data[1] >= data[2], `rgb=${[...data]}`);
});
