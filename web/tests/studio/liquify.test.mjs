import test from 'node:test';
import assert from 'node:assert/strict';

import { pushWeight } from '../../src/components/studio/liquify.js';

test('pushWeight：中心为 1，边缘为 0', () => {
  assert.equal(pushWeight(0, 50), 1);
  assert.equal(pushWeight(50, 50), 0);
  assert.equal(pushWeight(80, 50), 0);
});

test('pushWeight：单调递减且左右对称', () => {
  const values = [0, 10, 20, 30, 40].map((d) => pushWeight(d, 50));
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] < values[i - 1], `${values}`);
  assert.equal(pushWeight(20, 50), pushWeight(20, 50));
});

test('pushWeight：半径非法时返回 0', () => {
  assert.equal(pushWeight(10, 0), 0);
  assert.equal(pushWeight(10, -5), 0);
});

test('pushWeight：一半半径处约为 0.5（smoothstep）', () => {
  const value = pushWeight(25, 50);
  assert.ok(Math.abs(value - 0.5) < 0.01, `实际 ${value}`);
});
