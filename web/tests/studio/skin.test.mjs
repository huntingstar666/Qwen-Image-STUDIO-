import test from 'node:test';
import assert from 'node:assert/strict';

import { boxBlur, smoothSkin } from '../../src/components/studio/skin.js';

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

test('boxBlur：纯色图模糊后数值不变', () => {
  const data = makeImage(20, 20, () => [120, 80, 40]);
  const out = boxBlur(data, 20, 20, 3);
  for (let i = 0; i < out.length; i += 4) {
    assert.equal(out[i], 120);
    assert.equal(out[i + 1], 80);
    assert.equal(out[i + 2], 40);
    assert.equal(out[i + 3], 255);
  }
});

test('boxBlur：单点脉冲向四周扩散且总量近似守恒', () => {
  const data = makeImage(21, 21, () => [0, 0, 0, 0]);
  const center = (10 * 21 + 10) * 4;
  data[center] = 255;
  data[center + 3] = 255;
  const out = boxBlur(data, 21, 21, 2);
  const at = (x, y) => out[(y * 21 + x) * 4];
  assert.ok(at(10, 10) > 0 && at(10, 10) < 255, `中心应被摊薄：${at(10, 10)}`);
  assert.ok(at(12, 10) > 0, '右侧应被扩散到');
  assert.ok(at(14, 10) === 0, '超出半径仍为 0');
  let sum = 0;
  for (let i = 0; i < out.length; i += 4) sum += out[i];
  assert.ok(sum > 200 && sum < 320, `总量近似守恒：${sum}`);
});

test('boxBlur：radius 为 0 时原样返回', () => {
  const data = makeImage(4, 4, (x, y) => [x * 10, y * 10, 0]);
  const out = boxBlur(data, 4, 4, 0);
  assert.deepEqual([...out], [...data]);
});

test('smoothSkin：平滑后高频细节被削弱但整体亮度保持', () => {
  // 亮底上放一根 1px 深色线模拟毛孔/瑕疵
  const data = makeImage(40, 40, (x) => (x === 20 ? [60, 60, 60] : [200, 200, 200]));
  const before = { r: 0 };
  for (let i = 0; i < data.length; i += 4) before.r += data[i];
  smoothSkin(data, 40, 40, 2, 1);
  const after = { r: 0 };
  for (let i = 0; i < data.length; i += 4) after.r += data[i];
  const linePixel = data[(20 * 40 + 20) * 4];
  assert.ok(linePixel > 60, `线条应被提亮：${linePixel}`);
  assert.ok(Math.abs((after.r - before.r) / before.r) < 0.1, '整体亮度大致保持');
});

test('smoothSkin：条纹图案的方差下降（细节被削弱）', () => {
  const data = makeImage(60, 60, (x) => (x % 5 === 0 ? [60, 60, 60] : [200, 200, 200]));
  const std = (arr) => {
    let sum = 0;
    let sum2 = 0;
    let count = 0;
    for (let i = 0; i < arr.length; i += 4) {
      sum += arr[i];
      sum2 += arr[i] * arr[i];
      count += 1;
    }
    const mean = sum / count;
    return Math.sqrt(Math.max(0, sum2 / count - mean * mean));
  };
  const before = std(data);
  smoothSkin(data, 60, 60, 3, 1);
  const after = std(data);
  assert.ok(after < before * 0.9, `平滑后方差应明显下降：${before} → ${after}`);
});

test('smoothSkin：ratio 为 0 时不做任何修改', () => {
  const data = makeImage(10, 10, (x) => [x * 20, 0, 0]);
  const snapshot = [...data];
  smoothSkin(data, 10, 10, 3, 0);
  assert.deepEqual([...data], snapshot);
});
