import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVector, smudgeShift } from '../../src/components/studio/smudge.js';

test('normalizeVector：归一化为单位长度', () => {
  const unit = normalizeVector(3, 4);
  assert.equal(Math.round(unit.x * 100) / 100, 0.6);
  assert.equal(Math.round(unit.y * 100) / 100, 0.8);
  assert.ok(Math.abs(Math.hypot(unit.x, unit.y) - 1) < 1e-9);
});

test('normalizeVector：零向量安全返回 0', () => {
  assert.deepEqual(normalizeVector(0, 0), { x: 0, y: 0 });
});

test('smudgeShift：方向 × 半径 × 强度', () => {
  const shift = smudgeShift({ x: 1, y: 0 }, 20, 0.35);
  assert.equal(Math.round(shift.x * 100) / 100, 7);
  assert.equal(shift.y, 0);
});

test('smudgeShift：斜向保持方向且长度一致', () => {
  const shift = smudgeShift({ x: 1, y: 1 }, 10, 0.5);
  assert.ok(Math.abs(Math.hypot(shift.x, shift.y) - 5) < 1e-9);
  assert.ok(Math.abs(shift.x - shift.y) < 1e-9);
});

test('smudgeShift：强度夹在 0~1', () => {
  assert.equal(smudgeShift({ x: 1, y: 0 }, 10, 0).x, 0);
  const capped = smudgeShift({ x: 1, y: 0 }, 10, 5);
  assert.equal(Math.round(capped.x), 10);
  const negative = smudgeShift({ x: -1, y: 0 }, 10, 0.5);
  assert.equal(Math.round(negative.x), -5);
});
