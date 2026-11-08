import test from 'node:test';
import assert from 'node:assert/strict';

import { tilePatch } from '../../src/components/studio/pattern.js';

/** 生成 2×2 的四色图案：红、绿、蓝、黄。 */
function samplePattern() {
  return new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
}

function pixel(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

test('tilePatch：2×2 图案平铺成 4×4', () => {
  const out = tilePatch(samplePattern(), 2, 2, 4, 4, 0, 0);
  assert.equal(out.length, 4 * 4 * 4);
  assert.deepEqual(pixel(out, 4, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out, 4, 1, 0), [0, 255, 0, 255]);
  assert.deepEqual(pixel(out, 4, 2, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out, 4, 0, 1), [0, 0, 255, 255]);
  assert.deepEqual(pixel(out, 4, 3, 3), [255, 255, 0, 255]);
});

test('tilePatch：offset 平移图案相位', () => {
  const out = tilePatch(samplePattern(), 2, 2, 2, 2, 1, 1);
  assert.deepEqual(pixel(out, 2, 0, 0), [255, 255, 0, 255]);
  assert.deepEqual(pixel(out, 2, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(out, 2, 0, 1), [0, 255, 0, 255]);
  assert.deepEqual(pixel(out, 2, 1, 1), [255, 0, 0, 255]);
});

test('tilePatch：负 offset 也能正模回绕', () => {
  const out = tilePatch(samplePattern(), 2, 2, 2, 2, -1, -1);
  assert.deepEqual(pixel(out, 2, 0, 0), [255, 255, 0, 255]);
  const wrapped = tilePatch(samplePattern(), 2, 2, 1, 1, -3, -3);
  assert.deepEqual(pixel(wrapped, 1, 0, 0), [255, 255, 0, 255]);
});

test('tilePatch：非法尺寸返回全透明缓冲', () => {
  for (const out of [
    tilePatch(samplePattern(), 0, 2, 2, 2),
    tilePatch(null, 2, 2, 2, 2),
    tilePatch(samplePattern(), 2, 2, 0, 4),
  ]) {
    assert.ok(out.every((value) => value === 0));
  }
});
