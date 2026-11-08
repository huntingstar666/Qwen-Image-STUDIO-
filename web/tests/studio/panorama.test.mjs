import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEditPayload, detectTask, panoramaPlan } from '../../src/components/studio/payload.js';

test('全景预估：横图按 2:1 向左右补，并对齐 32', () => {
  const plan = panoramaPlan({ width: 800, height: 600 }, { aspect: '2:1', longSide: 3072 });
  assert.equal(plan.width, 1216);
  assert.equal(plan.height, 608);
  assert.equal(plan.scale, 1);
  assert.equal(plan.width % 32, 0);
  assert.equal(plan.height % 32, 0);
});

test('全景预估：正方形 2:1', () => {
  const plan = panoramaPlan({ width: 1024, height: 1024 }, { aspect: '2:1', longSide: 3072 });
  assert.deepEqual([plan.width, plan.height], [2048, 1024]);
});

test('全景预估：超长边时只缩不放', () => {
  const plan = panoramaPlan({ width: 4000, height: 1000 }, { aspect: '2:1', longSide: 3072 });
  assert.deepEqual([plan.width, plan.height], [3072, 1536]);
  assert.ok(plan.scale < 1);
});

test('全景预估：21:9 触发总像素上限', () => {
  const plan = panoramaPlan({ width: 4000, height: 1000 }, { aspect: '21:9', longSide: 4096 });
  assert.ok(plan.megapixels <= 6);
  assert.ok(plan.scale < 1);
  assert.equal(plan.width % 32, 0);
  assert.equal(plan.height % 32, 0);
});

test('全景预估：非法比例回退 2:1', () => {
  const bad = panoramaPlan({ width: 800, height: 600 }, { aspect: 'x' });
  const good = panoramaPlan({ width: 800, height: 600 }, { aspect: '2:1' });
  assert.deepEqual([bad.width, bad.height], [good.width, good.height]);
});

test('任务识别：全景关键词优先于扩图', () => {
  assert.equal(detectTask('生成一张宽幅全景'), 'panorama');
  assert.equal(detectTask('向外扩图补边'), 'outpaint');
  assert.equal(detectTask('移除画面里的行人'), 'remove');
});

test('payload：全景预设带出 aspect 覆盖项', () => {
  const payload = buildEditPayload({
    main: { data: 'x', name: 'a.png', width: 800, height: 600 },
    prompt: '生成全景',
    settings: { preset: 'panorama', overrides: { 'panorama.aspect': '3:1' }, hasMask: false },
    loras: {},
    sampling: {},
    task: 'panorama',
  });
  assert.equal(payload.preset, 'panorama');
  assert.equal(payload.task.mode, 'panorama');
  assert.deepEqual(payload.panorama, { aspect: '3:1' });
});
