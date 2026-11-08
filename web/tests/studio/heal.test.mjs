import test from 'node:test';
import assert from 'node:assert/strict';

import { ringSamples } from '../../src/components/studio/heal.js';

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

test('ringSamples：纯色图的每个角度都取到同一颜色', () => {
  const data = makeImage(40, 40, () => [12, 200, 99]);
  const colors = ringSamples(data, 40, 40, { x: 20, y: 20, radius: 8, samples: 8, box: 1 });
  assert.equal(colors.length, 8);
  for (const color of colors) {
    assert.equal(Math.round(color.r), 12);
    assert.equal(Math.round(color.g), 200);
    assert.equal(Math.round(color.b), 99);
  }
});

test('ringSamples：水平渐变时左右两侧颜色不同', () => {
  // 左红右蓝的线性渐变
  const data = makeImage(120, 60, (x) => [255 - Math.round((x / 119) * 255), 0, Math.round((x / 119) * 255)]);
  const colors = ringSamples(data, 120, 60, { x: 60, y: 30, radius: 20, samples: 8, box: 0 });
  // 0° = 右侧（偏蓝），180° = 左侧（偏红）
  assert.ok(colors[0].b > colors[0].r, `0°=${JSON.stringify(colors[0])}`);
  assert.ok(colors[4].r > colors[4].b, `180°=${JSON.stringify(colors[4])}`);
  // 上下两侧接近中间灰
  assert.ok(Math.abs(colors[2].r - colors[2].b) < 40, `90°=${JSON.stringify(colors[2])}`);
});

test('ringSamples：跳过透明像素并退回最近一次有效颜色', () => {
  // 只让右半边不透明：0° 取到有效色，其余角度透明时沿用
  const data = makeImage(60, 60, (x) => (x > 30 ? [250, 10, 10, 255] : [0, 0, 0, 0]));
  const colors = ringSamples(data, 60, 60, { x: 30, y: 30, radius: 10, samples: 8, box: 1 });
  for (const color of colors) {
    assert.equal(Math.round(color.r), 250);
    assert.equal(Math.round(color.g), 10);
  }
});

test('ringSamples：采样数下限为 4，且允许自定义', () => {
  const data = makeImage(30, 30, () => [100, 100, 100]);
  assert.equal(ringSamples(data, 30, 30, { x: 15, y: 15, radius: 6, samples: 2 }).length, 4);
  assert.equal(ringSamples(data, 30, 30, { x: 15, y: 15, radius: 6, samples: 12 }).length, 12);
});

test('ringSamples：越界采样被安全跳过，不产生 NaN', () => {
  const data = makeImage(20, 20, () => [80, 90, 100]);
  const colors = ringSamples(data, 20, 20, { x: 0, y: 0, radius: 15, samples: 8, box: 2 });
  for (const color of colors) {
    assert.ok(Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b));
  }
});
