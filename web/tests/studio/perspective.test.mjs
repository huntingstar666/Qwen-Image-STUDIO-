import test from 'node:test';
import assert from 'node:assert/strict';

import { invert3x3, pointInQuad, projectPoint, quadBounds, quadHomography } from '../../src/components/studio/perspective.js';

const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

/** 单位正方形四角 (0,0)/(1,0)/(1,1)/(0,1) 映射到目标四边形。 */
function mapCorners(matrix) {
  return [
    projectPoint(matrix, 0, 0),
    projectPoint(matrix, 1, 0),
    projectPoint(matrix, 1, 1),
    projectPoint(matrix, 0, 1),
  ];
}

test('quadHomography：平行四边形映射四角', () => {
  const quad = [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 110, y: 80 },
    { x: 10, y: 80 },
  ];
  const matrix = quadHomography(quad);
  assert.ok(matrix);
  const mapped = mapCorners(matrix);
  quad.forEach((point, index) => {
    assert.ok(near(mapped[index].x, point.x));
    assert.ok(near(mapped[index].y, point.y));
  });
});

test('quadHomography：透视四边形映射四角', () => {
  const quad = [
    { x: 30, y: 40 },
    { x: 210, y: 10 },
    { x: 260, y: 190 },
    { x: 0, y: 160 },
  ];
  const matrix = quadHomography(quad);
  assert.ok(matrix);
  const mapped = mapCorners(matrix);
  quad.forEach((point, index) => {
    assert.ok(near(mapped[index].x, point.x, 1e-4));
    assert.ok(near(mapped[index].y, point.y, 1e-4));
  });
});

test('invert3x3：逆矩阵把文档坐标还原为归一化坐标', () => {
  const quad = [
    { x: 30, y: 40 },
    { x: 210, y: 10 },
    { x: 260, y: 190 },
    { x: 0, y: 160 },
  ];
  const forward = quadHomography(quad);
  const inverse = invert3x3(forward);
  assert.ok(inverse);
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.37, 0.62]]) {
    const point = projectPoint(forward, u, v);
    const back = projectPoint(inverse, point.x, point.y);
    assert.ok(near(back.x, u, 1e-4));
    assert.ok(near(back.y, v, 1e-4));
  }
});

test('invert3x3：奇异矩阵返回 null', () => {
  assert.equal(invert3x3([1, 2, 3, 2, 4, 6, 1, 1, 1]), null);
  assert.equal(invert3x3(null), null);
});

test('pointInQuad：凸四边形内外判断', () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 100, y: 20 },
    { x: 80, y: 90 },
    { x: 10, y: 70 },
  ];
  assert.equal(pointInQuad(quad, 50, 45), true);
  assert.equal(pointInQuad(quad, -10, 45), false);
  assert.equal(pointInQuad(quad, 120, 80), false);
});

test('quadBounds：返回外接矩形', () => {
  const box = quadBounds([
    { x: 10.2, y: 5.1 },
    { x: 100.8, y: 20 },
    { x: 90, y: 110.4 },
    { x: 0, y: 80 },
  ]);
  assert.equal(box.x, 0);
  assert.equal(box.y, 5);
  assert.equal(box.width, 101);
  assert.equal(box.height, 106);
});

test('quadHomography：退化输入返回 null', () => {
  assert.equal(quadHomography(null), null);
  assert.equal(quadHomography([{ x: 0, y: 0 }]), null);
  const degenerate = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  assert.equal(quadHomography(degenerate), null);
});
