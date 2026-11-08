import test from 'node:test';
import assert from 'node:assert/strict';

import { CUTOUT_EDGE_PRESETS, CUTOUT_SIZES, clampCutoutSide, cutoutRect, decontaminatePixels, fitCutoutRect, prepareCutoutAlpha } from '../../src/components/studio/cutout.js';

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

/* ---------------------------------------------------------------- P4 */

test('固定尺寸：提供原图 / 1:1 / 3:4 / 4:3 / 9:16 / 自定义', () => {
  assert.deepEqual(
    CUTOUT_SIZES.map((item) => item.id),
    ['origin', 'square1000', 'portrait1200', 'landscape1600', 'story1080', 'custom'],
  );
  const square = CUTOUT_SIZES.find((item) => item.id === 'square1000');
  assert.deepEqual([square.width, square.height], [1000, 1000]);
});

test('固定尺寸：非法输入夹到 16~8192', () => {
  assert.equal(clampCutoutSide(0), 1024);
  assert.equal(clampCutoutSide('abc'), 1024);
  assert.equal(clampCutoutSide(8), 16);
  assert.equal(clampCutoutSide(99999), 8192);
  assert.equal(clampCutoutSide(640.4), 640);
});

test('固定尺寸：contain 等比缩放并居中', () => {
  // 宽图放进正方形：左右留白
  assert.deepEqual(fitCutoutRect(1600, 800, 1000, 1000), { x: 0, y: 250, width: 1000, height: 500 });
  // 高图放进正方形：上下留白
  assert.deepEqual(fitCutoutRect(800, 1600, 1000, 1000), { x: 250, y: 0, width: 500, height: 1000 });
  // 尺寸一致时铺满
  assert.deepEqual(fitCutoutRect(800, 600, 800, 600), { x: 0, y: 0, width: 800, height: 600 });
});

test('去色边：边缘像素取邻近实心像素均值，实心与全透明像素不变', () => {
  const width = 4;
  const height = 1;
  const data = new Uint8ClampedArray([
    // 实心红
    255, 0, 0, 255,
    // 边缘像素（原本被绿背景污染）
    0, 255, 0, 120,
    // 全透明
    0, 0, 0, 0,
    // 实心红
    255, 0, 0, 255,
  ]);
  decontaminatePixels(data, width, height, 1);
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255], '实心像素保持不变');
  assert.deepEqual([...data.slice(4, 7)], [255, 0, 0], '边缘 RGB 被邻近实心像素替换');
  assert.equal(data[7], 120, '边缘 alpha 保持不变');
  assert.deepEqual([...data.slice(8, 12)], [0, 0, 0, 0], '全透明像素保持不变');
});

test('去色边：附近没有实心像素时不动', () => {
  const data = new Uint8ClampedArray([10, 20, 30, 100]);
  decontaminatePixels(data, 1, 1, 1);
  assert.deepEqual([...data], [10, 20, 30, 100]);
});
