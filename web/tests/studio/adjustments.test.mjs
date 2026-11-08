import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADJUSTMENT_DEFAULTS,
  applyAdjustment,
  hasAdjustment,
  localStrengthAt,
  normalizeAdjustment,
  normalizeLocal,
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

/* ------------------------------------------------- 局部调整（D9.4） */

test('normalizeLocal 归一化类型与坐标', () => {
  const local = normalizeLocal({ type: 'radial', start: { x: 10, y: '20' }, end: { x: 'abc' }, feather: 200 });
  assert.equal(local.type, 'radial');
  assert.deepEqual(local.start, { x: 10, y: 20 });
  assert.deepEqual(local.end, { x: 0, y: 0 });
  assert.equal(local.feather, 100);
  assert.equal(normalizeLocal({ type: 'nope' }).type, 'none');
});

test('none 类型对任意点都为全量', () => {
  assert.equal(localStrengthAt({ type: 'none' }, 0, 0), 1);
  assert.equal(localStrengthAt({ type: 'none' }, 999, 999), 1);
});

test('线性渐变：起点全量、终点为零、中点约一半', () => {
  const local = { type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, feather: 0 };
  assert.ok(localStrengthAt(local, 0, 0) > 0.99);
  assert.ok(localStrengthAt(local, 100, 0) < 0.01);
  near(localStrengthAt(local, 50, 0) * 100, 50, 1);
  // 渐变垂直方向不衰减
  near(localStrengthAt(local, 50, 80) * 100, 50, 1);
  // 超出两端夹取
  assert.ok(localStrengthAt(local, -200, 0) > 0.99);
  assert.ok(localStrengthAt(local, 400, 0) < 0.01);
});

test('线性渐变支持斜向', () => {
  const local = { type: 'linear', start: { x: 0, y: 0 }, end: { x: 80, y: 60 }, feather: 0 };
  near(localStrengthAt(local, 40, 30) * 100, 50, 1);
  assert.ok(localStrengthAt(local, 0, 0) > 0.99);
});

test('径向渐变：中心全量、边缘为零、椭圆按两轴半径', () => {
  const local = { type: 'radial', start: { x: 100, y: 100 }, end: { x: 140, y: 120 }, feather: 0 };
  assert.ok(localStrengthAt(local, 100, 100) > 0.99);
  assert.ok(localStrengthAt(local, 140, 100) < 0.01);
  assert.ok(localStrengthAt(local, 100, 120) < 0.01);
  // 椭圆边界点（长轴中点 = 归一化半径 1）与半轴中点（强度 50%）
  near(localStrengthAt(local, 120, 100) * 100, 50, 2);
  assert.ok(localStrengthAt(local, 140, 100) < 0.01);
});

test('过渡 feather 只改变曲线形状，不改变两端取值', () => {
  const base = { type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } };
  const linear = localStrengthAt({ ...base, feather: 0 }, 25, 0);
  const smooth = localStrengthAt({ ...base, feather: 100 }, 25, 0);
  assert.ok(Math.abs(linear - smooth) > 0.05, `linear=${linear} smooth=${smooth}`);
  assert.ok(localStrengthAt({ ...base, feather: 100 }, 0, 0) > 0.99);
  assert.ok(localStrengthAt({ ...base, feather: 100 }, 100, 0) < 0.01);
});

test('零长度几何退化为全量，不产生 NaN', () => {
  assert.equal(localStrengthAt({ type: 'linear', start: { x: 5, y: 5 }, end: { x: 5, y: 5 } }, 50, 50), 1);
  assert.equal(localStrengthAt({ type: 'radial', start: { x: 5, y: 5 }, end: { x: 5, y: 5 } }, 50, 50), 1);
});
