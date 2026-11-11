import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANORAMA_ASPECT_MIN,
  SPHERE_PROMPT,
  SPHERE_SIZES,
  findSphereSize,
  isPanoramaAspect,
  isSphereSizeId,
  withSpherePrompt,
} from '../../src/components/panoramaMath.js';

test('全景入口判定：2:1 及以上算全景，3:2 与竖图不算', () => {
  assert.equal(isPanoramaAspect(2048, 1024), true);
  assert.equal(isPanoramaAspect(3072, 1536), true);
  assert.equal(isPanoramaAspect(3840, 1646), true);
  assert.equal(isPanoramaAspect(3000, 2000), false);
  assert.equal(isPanoramaAspect(1024, 2048), false);
  assert.equal(isPanoramaAspect(0, 1024), false);
  assert.equal(isPanoramaAspect(undefined, undefined), false);
  assert.ok(PANORAMA_ASPECT_MIN > 1);
});

test('360° 尺寸档固定 2:1，长边分别是 2048 / 3072', () => {
  assert.deepEqual(
    SPHERE_SIZES.map((size) => [size.id, size.width, size.height]),
    [['360-2k', 2048, 1024], ['360-3k', 3072, 1536]],
  );
  assert.equal(findSphereSize('360-3k')?.height, 1536);
  assert.equal(findSphereSize('nope'), null);
  assert.equal(isSphereSizeId('360-2k'), true);
  assert.equal(isSphereSizeId('2:1'), false);
});

test('360° 提示词：缺关键词时追加，已有不重复', () => {
  assert.equal(withSpherePrompt('现代客厅', true), `现代客厅, ${SPHERE_PROMPT}`);
  assert.equal(withSpherePrompt('', true), SPHERE_PROMPT);
  assert.equal(withSpherePrompt('现代客厅', false), '现代客厅');
  const once = withSpherePrompt('现代客厅', true);
  assert.equal(withSpherePrompt(once, true), once);
  assert.equal(withSpherePrompt('360° 全景，室内', true), '360° 全景，室内');
  assert.equal(withSpherePrompt('equirectangular room', true), 'equirectangular room');
});
