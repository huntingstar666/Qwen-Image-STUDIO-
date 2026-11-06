import test from 'node:test';
import assert from 'node:assert/strict';
import {
  centeredCrop,
  cropOutputRects,
  cropRatio,
  cropSegments,
  equalCuts,
  gridRects,
  hitCrop,
  moveCrop,
  resizeCrop,
} from '../src/cropGeometry.js';
import { buildOutpaintDraft, buildPanoramaDraft, angleLabel, panoramaAspectRatio } from '../src/prompt.js';

test('cropRatio 解析比例与自由模式', () => {
  assert.equal(cropRatio('Free', { width: 100, height: 50 }), null);
  assert.equal(cropRatio('Original', { width: 100, height: 50 }), 2);
  assert.equal(cropRatio('16:9', { width: 1, height: 1 }), 16 / 9);
  assert.equal(cropRatio('bad', { width: 1, height: 1 }), null);
});

test('centeredCrop 居中且符合比例', () => {
  const rect = centeredCrop({ width: 400, height: 300 }, 1, 0.8);
  assert.equal(rect.width, 240);
  assert.equal(rect.height, 240);
  assert.equal(rect.x, 80);
  assert.equal(rect.y, 30);
});

test('hitCrop 命中手柄与内部移动', () => {
  const rect = { x: 10, y: 10, width: 100, height: 80 };
  assert.equal(hitCrop(rect, { x: 11, y: 9 }), 'tl');
  assert.equal(hitCrop(rect, { x: 60, y: 50 }), 'move');
  assert.equal(hitCrop(rect, { x: 300, y: 300 }), null);
});

test('resizeCrop 固定比例时保持比例且不越界', () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const size = { width: 200, height: 200 };
  const next = resizeCrop(rect, 'br', { x: 260, y: 260 }, size, 1);
  assert.equal(next.width, 200);
  assert.equal(next.height, 200);
  assert.equal(next.x, 0);
});

test('moveCrop 不越界', () => {
  const rect = { x: 10, y: 10, width: 50, height: 50 };
  const next = moveCrop(rect, { x: 100, y: -100 }, { width: 100, height: 100 });
  assert.equal(next.x, 50);
  assert.equal(next.y, 0);
});

test('cropSegments 均分并扣除间距', () => {
  const segments = cropSegments(0, 100, equalCuts(4), 8);
  assert.equal(segments.length, 4);
  assert.ok(segments[0].start === 0);
  assert.ok(Math.abs(segments.reduce((sum, item) => sum + item.size, 0) - (100 - 8 * 3)) < 1e-6);
});

test('cropOutputRects 把显示坐标换算到原图像素', () => {
  const rect = { x: 50, y: 50, width: 100, height: 100 };
  const display = { width: 200, height: 200 };
  const source = { width: 400, height: 400 };
  const result = cropOutputRects(rect, display, source, equalCuts(2), equalCuts(2), 0, 0);
  assert.deepEqual(result.columns.map((item) => item.start), [100, 200]);
  assert.deepEqual(result.rows.map((item) => item.size), [100, 100]);
});

test('gridRects 行优先输出且数量正确', () => {
  const rects = gridRects({ x: 0, y: 0, width: 300, height: 300 }, { width: 300, height: 300 }, { width: 600, height: 600 }, 2, 3);
  assert.equal(rects.length, 6);
  assert.deepEqual([rects[0].row, rects[0].column], [0, 0]);
  assert.deepEqual([rects[5].row, rects[5].column], [1, 2]);
  assert.equal(rects[0].width, 200);
});

test('全景草稿固定 2:1 且带提示词', () => {
  const draft = buildPanoramaDraft({ resultUrl: 'blob:x' });
  assert.equal(draft.aspectRatio, panoramaAspectRatio);
  assert.equal(draft.imageMode, 'image-to-image');
  assert.ok(draft.prompt.includes('360'));
  assert.equal(draft.imageAngle, null);
});

test('全景草稿缺少原图时报错', () => {
  assert.throws(() => buildPanoramaDraft({}), /原图/);
});

test('扩图草稿带方向视角并给出默认比例', () => {
  const draft = buildOutpaintDraft({ resultUrl: 'blob:x', aspectRatio: '9:16' }, { angle: { azimuth: 90, elevation: 0, zoom: 5 } });
  assert.equal(draft.aspectRatio, '16:9');
  assert.ok(draft.title.startsWith('角度'));
  assert.equal(draft.prompt, '');
});

test('angleLabel 输出可读方向', () => {
  assert.equal(angleLabel(null), '默认');
  assert.ok(angleLabel({ azimuth: 90, elevation: 40 }).includes('俯视'));
});
