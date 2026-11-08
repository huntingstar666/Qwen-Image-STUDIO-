import test from 'node:test';
import assert from 'node:assert/strict';

import { pixelate } from '../../src/components/studio/mosaic.js';

function makeImage(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b, a = 255] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

test('pixelate：每个方块内颜色统一', () => {
  const data = makeImage(8, 8, (x, y) => [x * 20, y * 20, 0]);
  pixelate(data, 8, 8, 4);
  const at = (x, y) => [...data.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
  assert.deepEqual(at(0, 0), at(3, 3));
  assert.deepEqual(at(4, 0), at(7, 3));
  assert.notDeepEqual(at(0, 0), at(4, 0));
});

test('pixelate：方块均值为原区域平均值', () => {
  const data = makeImage(2, 2, (x) => (x === 0 ? [0, 0, 0] : [100, 200, 40]));
  pixelate(data, 2, 2, 2);
  // 四个像素都应为平均值 (50,100,20)
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], 50);
    assert.equal(data[i + 1], 100);
    assert.equal(data[i + 2], 20);
  }
});

test('pixelate：block<=1 时原样返回', () => {
  const data = makeImage(4, 4, (x) => [x * 10, 0, 0]);
  const snapshot = [...data];
  pixelate(data, 4, 4, 1);
  assert.deepEqual([...data], snapshot);
});

test('pixelate：方块超出边界时按剩余像素取均值', () => {
  const data = makeImage(3, 3, () => [10, 20, 30]);
  pixelate(data, 3, 3, 5);
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], 10);
    assert.equal(data[i + 1], 20);
    assert.equal(data[i + 2], 30);
  }
});
