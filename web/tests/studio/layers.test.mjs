import test from 'node:test';
import assert from 'node:assert/strict';

import { BLEND_MODES, OverlayLayer } from '../../src/components/studio/layers.js';

const fakeImage = { naturalWidth: 100, naturalHeight: 50, width: 100, height: 50 };

function fakeCtx(calls) {
  return {
    save() {},
    restore() {},
    translate(...args) {
      calls.push(['translate', ...args]);
    },
    rotate(...args) {
      calls.push(['rotate', ...args]);
    },
    scale(...args) {
      calls.push(['scale', ...args]);
    },
    drawImage(...args) {
      calls.push(['drawImage', ...args.slice(1)]);
    },
    set globalAlpha(value) {
      calls.push(['alpha', value]);
    },
    set globalCompositeOperation(value) {
      calls.push(['blend', value]);
    },
  };
}

test('BLEND_MODES：覆盖 PS 常用模式且默认正常', () => {
  assert.ok(BLEND_MODES.length >= 9);
  assert.equal(BLEND_MODES[0].id, 'source-over');
  assert.ok(BLEND_MODES.some((mode) => mode.id === 'multiply'));
  assert.ok(BLEND_MODES.some((mode) => mode.id === 'soft-light'));
});

test('OverlayLayer：未知混合模式回退为正常', () => {
  const layer = new OverlayLayer(fakeImage, { blend: 'not-a-mode' });
  assert.equal(layer.blend, 'source-over');
  const custom = new OverlayLayer(fakeImage, { blend: 'screen' });
  assert.equal(custom.blend, 'screen');
});

test('OverlayLayer：旋转后 hitTest 按图层本地坐标判断', () => {
  const layer = new OverlayLayer(fakeImage, { x: 0, y: 0, scale: 1, rotation: 90 });
  // 中心点命中
  assert.equal(layer.hitTest(50, 25), true);
  // 旋转 90° 后 (5,5) 位于图层外，但仍在未旋转 AABB 内
  assert.equal(layer.hitTest(5, 5), false);
});

test('OverlayLayer：draw 写入混合模式与翻转变换', () => {
  const layer = new OverlayLayer(fakeImage, { x: 10, y: 20, scale: 1, flipH: true, blend: 'multiply' });
  const calls = [];
  layer.draw(fakeCtx(calls));
  assert.deepEqual(calls[0], ['alpha', 1]);
  assert.deepEqual(calls[1], ['blend', 'multiply']);
  assert.deepEqual(calls[2], ['translate', 60, 45]);
  assert.deepEqual(calls[3], ['scale', -1, 1]);
  assert.deepEqual(calls[4], ['drawImage', -50, -25, 100, 50]);
});

test('OverlayLayer：clone 保留翻转与混合模式且互不影响', () => {
  const source = new OverlayLayer(fakeImage, { flipH: true, flipV: true, blend: 'screen', rotation: 30 });
  const copy = source.clone({ fresh: true });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.flipH, true);
  assert.equal(copy.flipV, true);
  assert.equal(copy.blend, 'screen');
  assert.equal(copy.rotation, 30);
  copy.flipH = false;
  assert.equal(source.flipH, true);
});
