import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENT_MAX_SIDE,
  maskGrayToAlpha,
  segmentSendSize,
  sortSegmentMasks,
  toSendBox,
  toSendPoints,
} from '../../src/components/studio/segment.js';

test('发送尺寸：长边超限才等比缩小', () => {
  const small = segmentSendSize(800, 600);
  assert.deepEqual([small.width, small.height, small.scale], [800, 600, 1]);

  const big = segmentSendSize(4096, 2048, SEGMENT_MAX_SIDE);
  assert.deepEqual([big.width, big.height], [2048, 1024]);
  assert.equal(big.scale, 0.5);

  const portrait = segmentSendSize(1000, 3000, 2048);
  assert.deepEqual([portrait.width, portrait.height], [683, 2048]);
  assert.ok(Math.abs(portrait.scale - 2048 / 3000) < 1e-6);
});

test('发送尺寸：非法输入回退 1×1', () => {
  const size = segmentSendSize(0, null);
  assert.deepEqual([size.width, size.height, size.scale], [1, 1, 1]);
});

test('点提示：裁剪偏移 + 缩放 + label', () => {
  const points = toSendPoints(
    [
      { x: 10, y: 20, label: 1 },
      { x: 30, y: 40, label: 0 },
    ],
    0.5,
    { x: 100, y: 200 },
  );
  assert.deepEqual(points, [
    { x: 55, y: 110, label: 1 },
    { x: 65, y: 120, label: 0 },
  ]);
});

test('框提示：裁剪偏移 + 缩放', () => {
  const box = toSendBox({ x: 10, y: 20, width: 40, height: 60 }, 0.5, { x: 100, y: 200 });
  assert.deepEqual(box, { x: 55, y: 110, width: 20, height: 30 });
});

test('灰度蒙版取 R 通道；带透明时用 alpha', () => {
  const gray = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.deepEqual(Array.from(maskGrayToAlpha(gray, 2, 1)), [255, 0]);

  const alphaMask = new Uint8ClampedArray([0, 0, 0, 128, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(maskGrayToAlpha(alphaMask, 2, 1)), [128, 0]);
});

test('候选按 score 降序，score 相同按面积', () => {
  const sorted = sortSegmentMasks([
    { url: '/a', score: 0.4, area: 100 },
    { url: '/b', score: 0.9, area: 10 },
    { url: '', score: 1 },
    { url: '/c', score: 0.9, area: 50 },
  ]);
  assert.deepEqual(sorted.map((item) => item.url), ['/c', '/b', '/a']);
});
