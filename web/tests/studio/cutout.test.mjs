import test from 'node:test';
import assert from 'node:assert/strict';

import { CUTOUT_EDGE_PRESETS, cutoutRect, prepareCutoutAlpha } from '../../src/components/studio/cutout.js';

function solidAlpha(width, height, block) {
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = block.y0; y < block.y1; y += 1) {
    for (let x = block.x0; x < block.x1; x += 1) alpha[y * width + x] = 255;
  }
  return alpha;
}

function count(alpha) {
  let hit = 0;
  for (const value of alpha) if (value >= 128) hit += 1;
  return hit;
}

test('边缘预设：提供硬边/标准/发丝三档', () => {
  assert.deepEqual(Object.keys(CUTOUT_EDGE_PRESETS), ['hard', 'standard', 'hair']);
  assert.equal(CUTOUT_EDGE_PRESETS.hard.contract, 1);
  assert.equal(CUTOUT_EDGE_PRESETS.hard.feather, 0);
  assert.equal(CUTOUT_EDGE_PRESETS.hair.contract, 0);
  assert.ok(CUTOUT_EDGE_PRESETS.hair.feather > 0);
});

test('硬边：收缩 1px 后覆盖面积变小且外圈被清掉', () => {
  const width = 9;
  const height = 9;
  const alpha = solidAlpha(width, height, { x0: 2, y0: 2, x1: 7, y1: 7 });
  const out = prepareCutoutAlpha(alpha, width, height, 'hard');
  assert.equal(out.length, alpha.length);
  assert.ok(count(out) < count(alpha), '收缩后选区应更小');
  assert.equal(out[2 * width + 2], 0, '左上角像素应被收缩掉');
  assert.equal(out[4 * width + 4], 255, '中心像素保持不变');
});

test('发丝：羽化后边缘出现半透明像素，中心仍为全选', () => {
  const width = 21;
  const height = 21;
  const alpha = solidAlpha(width, height, { x0: 5, y0: 5, x1: 16, y1: 16 });
  const out = prepareCutoutAlpha(alpha, width, height, 'hair');
  assert.equal(out[10 * width + 10], 255, '中心像素不受羽化影响');
  let soft = 0;
  for (const value of out) if (value > 0 && value < 255) soft += 1;
  assert.ok(soft > 0, '羽化应产生半透明边缘');
});

test('非法输入安全返回空数组', () => {
  assert.equal(prepareCutoutAlpha(null, 4, 4).length, 0);
  assert.equal(prepareCutoutAlpha(new Uint8ClampedArray(0), 4, 4).length, 0);
  assert.equal(prepareCutoutAlpha(new Uint8ClampedArray(16), 0, 4).length, 0);
});

test('输出矩形：无裁剪时取整图，有裁剪时对齐裁剪左上角', () => {
  assert.deepEqual(cutoutRect(null, 1200, 800), { x: 0, y: 0, width: 1200, height: 800 });
  assert.deepEqual(cutoutRect({ x: 10.4, y: 20.6, width: 300.2, height: 200.7 }, 1200, 800), {
    x: 10,
    y: 21,
    width: 300,
    height: 201,
  });
  assert.deepEqual(cutoutRect({ x: -5, y: -5, width: 0, height: 0 }, 640, 480), {
    x: -5,
    y: -5,
    width: 640,
    height: 480,
  });
});
