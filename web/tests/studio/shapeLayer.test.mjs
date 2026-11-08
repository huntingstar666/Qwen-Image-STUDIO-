import test from 'node:test';
import assert from 'node:assert/strict';

import { SHAPE_DEFAULTS, SHAPE_KINDS, SHAPE_STYLE_DEFAULTS, ShapeLayer, normalizeShapeStyle, shapeLayerFromProps } from '../../src/components/studio/shapeLayer.js';

function fakeCtx(calls) {
  return {
    save() {},
    restore() {},
    beginPath() {
      calls.push(['beginPath']);
    },
    rect(...args) {
      calls.push(['rect', ...args]);
    },
    moveTo(...args) {
      calls.push(['moveTo', ...args]);
    },
    lineTo(...args) {
      calls.push(['lineTo', ...args]);
    },
    arcTo(...args) {
      calls.push(['arcTo', ...args]);
    },
    closePath() {},
    ellipse(...args) {
      calls.push(['ellipse', ...args]);
    },
    fill() {
      calls.push(['fill', this.fillStyle]);
    },
    stroke() {
      calls.push(['stroke', this.strokeStyle, this.lineWidth]);
    },
    set fillStyle(value) {
      this._fill = value;
    },
    get fillStyle() {
      return this._fill;
    },
    set strokeStyle(value) {
      this._stroke = value;
    },
    get strokeStyle() {
      return this._stroke;
    },
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    globalAlpha: 1,
  };
}

test('SHAPE_KINDS：提供矩形/椭圆/直线/箭头四种', () => {
  assert.deepEqual(
    SHAPE_KINDS.map((item) => item.id),
    ['rect', 'ellipse', 'line', 'arrow'],
  );
});

test('ShapeLayer：默认值与参数夹取', () => {
  const layer = new ShapeLayer({ x: 10, y: 20, width: 100, height: 50 });
  assert.equal(layer.kind, 'shape');
  assert.equal(layer.isShape, true);
  assert.equal(layer.shape, SHAPE_DEFAULTS.kind);
  assert.equal(layer.opacity, 1);
  assert.equal(layer.hasMask(), false);

  const clamped = new ShapeLayer({ strokeWidth: 999, radius: -8, opacity: 5 });
  assert.equal(clamped.strokeWidth, 64);
  assert.equal(clamped.radius, 0);
  assert.equal(clamped.opacity, 1);
});

test('ShapeLayer：bounds 支持负宽高与直线外扩', () => {
  const rect = new ShapeLayer({ shape: 'rect', x: 100, y: 80, width: -40, height: -30 });
  assert.deepEqual(rect.bounds(), { x: 60, y: 50, width: 40, height: 30 });

  const line = new ShapeLayer({ shape: 'line', x: 0, y: 0, width: 100, height: 0, strokeWidth: 10 });
  const box = line.bounds();
  assert.equal(box.width, 100 + 14);
  assert.equal(box.height, 14);
});

test('ShapeLayer：hitTest 命中矩形/椭圆/直线', () => {
  const rect = new ShapeLayer({ shape: 'rect', x: 0, y: 0, width: 100, height: 50 });
  assert.equal(rect.hitTest(50, 25), true);
  assert.equal(rect.hitTest(101, 25), false);

  const ellipse = new ShapeLayer({ shape: 'ellipse', x: 0, y: 0, width: 100, height: 50 });
  assert.equal(ellipse.hitTest(5, 5), false);
  assert.equal(ellipse.hitTest(50, 25), true);

  const line = new ShapeLayer({ shape: 'line', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 });
  assert.equal(line.hitTest(50, 50), true);
  assert.equal(line.hitTest(90, 10), false);
});

test('ShapeLayer：draw 写入填充/描边，箭头画三角', () => {
  const calls = [];
  const rect = new ShapeLayer({ shape: 'rect', x: 0, y: 0, width: 50, height: 40, fill: '#112233', stroke: '#ffffff', strokeWidth: 4 });
  rect.draw(fakeCtx(calls));
  assert.ok(calls.some((call) => call[0] === 'rect'));
  assert.ok(calls.some((call) => call[0] === 'fill' && call[1] === '#112233'));
  assert.ok(calls.some((call) => call[0] === 'stroke' && call[1] === '#ffffff' && call[2] === 4));

  const arrowCalls = [];
  const arrow = new ShapeLayer({ shape: 'arrow', x: 0, y: 0, width: 100, height: 0, stroke: '#ff0000', strokeWidth: 3 });
  arrow.draw(fakeCtx(arrowCalls));
  assert.ok(arrowCalls.filter((call) => call[0] === 'stroke').length >= 1);
  assert.ok(arrowCalls.some((call) => call[0] === 'fill' && call[1] === '#ff0000'));
});

test('ShapeLayer：混合模式与剪贴标记随 clone 保留', () => {
  const source = new ShapeLayer({ shape: 'rect', width: 20, height: 20, blend: 'screen', clipped: true });
  assert.equal(source.blend, 'screen');
  assert.equal(source.clipped, true);
  const copy = source.clone({ fresh: true });
  assert.equal(copy.blend, 'screen');
  assert.equal(copy.clipped, true);
  assert.equal(new ShapeLayer({ blend: 'bad-mode' }).blend, 'source-over');
});

test('ShapeLayer：图层样式默认值、夹取与 clone 保留', () => {
  const layer = new ShapeLayer({ width: 10, height: 10 });
  assert.equal(layer.style.shadow.enabled, false);
  assert.equal(layer.style.glow.blur, SHAPE_STYLE_DEFAULTS.glow.blur);
  assert.equal(layer.style.gradient.from, SHAPE_STYLE_DEFAULTS.gradient.from);

  const clamped = normalizeShapeStyle({
    shadow: { enabled: true, blur: 999, distance: -5 },
    gradient: { opacity: 5 },
    colorOverlay: { opacity: -1 },
  });
  assert.equal(clamped.shadow.enabled, true);
  assert.equal(clamped.shadow.blur, 120);
  assert.equal(clamped.shadow.distance, 0);
  assert.equal(clamped.gradient.opacity, 1);
  assert.equal(clamped.colorOverlay.opacity, 0);

  const styled = new ShapeLayer({ width: 10, height: 10, style: { glow: { enabled: true, blur: 30 } } });
  const copy = styled.clone({ fresh: true });
  assert.equal(copy.style.glow.enabled, true);
  assert.equal(copy.style.glow.blur, 30);
  copy.style.glow.blur = 5;
  assert.equal(styled.style.glow.blur, 30);
});

test('ShapeLayer：clone 独立，props 还原保留样式与几何', () => {
  const source = new ShapeLayer({ shape: 'arrow', x: 5, y: 6, width: 70, height: 20, fill: '#00ff00', strokeWidth: 8, radius: 12 });
  const copy = source.clone({ fresh: true });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.shape, 'arrow');
  assert.equal(copy.strokeWidth, 8);
  copy.fill = '#000000';
  assert.equal(source.fill, '#00ff00');

  const restored = shapeLayerFromProps({ shape: 'ellipse', x: 1, y: 2, width: 30, height: 40, fill: '#123456' }, '椭圆 1');
  assert.equal(restored.name, '椭圆 1');
  assert.equal(restored.shape, 'ellipse');
  assert.equal(restored.fill, '#123456');
  assert.equal(restored.width, 30);
});
