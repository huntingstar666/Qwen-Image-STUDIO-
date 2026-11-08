import test from 'node:test';
import assert from 'node:assert/strict';

import { TEXT_DEFAULTS, TEXT_FONTS, TextLayer, arcLayout, textLayerFromProps } from '../../src/components/studio/textLayer.js';

test('TextLayer：默认值与标记位', () => {
  const layer = new TextLayer({});
  assert.equal(layer.kind, 'text');
  assert.equal(layer.isText, true);
  assert.equal(layer.text, TEXT_DEFAULTS.text);
  assert.equal(layer.fontSize, TEXT_DEFAULTS.fontSize);
  assert.equal(layer.opacity, 1);
  assert.equal(layer.visible, true);
  assert.equal(layer.hasMask(), false);
  assert.match(layer.font, new RegExp(`${TEXT_DEFAULTS.fontSize}px`));
});

test('TextLayer：字号/不透明度/描边宽夹在合理区间', () => {
  const layer = new TextLayer({ fontSize: 9999, opacity: 5, strokeWidth: -3 });
  assert.equal(layer.fontSize, 400);
  assert.equal(layer.opacity, 1);
  assert.equal(layer.strokeWidth, 0);
});

test('TextLayer：clone 保持内容且互不影响', () => {
  const source = new TextLayer({ text: '你好', color: '#ff0000', fontSize: 48 });
  const copy = source.clone({ fresh: true });
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.text, '你好');
  assert.equal(copy.color, '#ff0000');
  copy.text = '改动';
  assert.equal(source.text, '你好');
});

test('TextLayer：混合模式与剪贴标记随 clone 保留', () => {
  const source = new TextLayer({ text: '混合', blend: 'multiply', clipped: true });
  assert.equal(source.blend, 'multiply');
  assert.equal(source.clipped, true);
  const copy = source.clone({ fresh: true });
  assert.equal(copy.blend, 'multiply');
  assert.equal(copy.clipped, true);
  assert.equal(new TextLayer({ blend: 'bad-mode' }).blend, 'source-over');
});

test('arcLayout：0 弯曲时按宽度居中横排', () => {
  const layout = arcLayout([10, 20, 10], 0);
  assert.deepEqual(layout.map((item) => Math.round(item.x)), [-15, 0, 15]);
  assert.ok(layout.every((item) => item.y === 0 && item.angle === 0));
});

test('arcLayout：正弯曲两端下沉、角度对称', () => {
  const layout = arcLayout([10, 10, 10, 10, 10], 60);
  assert.ok(Math.abs(layout[2].y) < 1e-6, '中间字符在基线上');
  assert.ok(layout[0].y > 0 && layout[4].y > 0, '两端向下沉');
  assert.ok(Math.abs(layout[0].y - layout[4].y) < 1e-6, '两端对称');
  assert.ok(layout[0].angle < 0 && layout[4].angle > 0, '角度沿弧线张开');
  assert.ok(layout.every((item, index) => index === 0 || item.x > layout[index - 1].x), '字符顺序从左到右');
});

test('arcLayout：负弯曲两端上翘', () => {
  const layout = arcLayout([12, 12, 12], -50);
  assert.ok(layout[0].y < 0 && layout[2].y < 0);
  assert.ok(layout[0].angle > 0 && layout[2].angle < 0);
});

test('TextLayer：路径文字弯曲度随 clone 与 props 保留', () => {
  const layer = new TextLayer({ text: '弧线', arc: 70 });
  assert.equal(layer.arc, 70);
  const copy = layer.clone({ fresh: true });
  assert.equal(copy.arc, 70);
  assert.equal(new TextLayer({ arc: 300 }).arc, 100);
  assert.equal(textLayerFromProps({ text: 'x', arc: -40 }).arc, -40);
});

test('TextLayer：多行文本按换行拆分', () => {
  const layer = new TextLayer({ text: '一\n二\n三' });
  assert.deepEqual(layer.lines(), ['一', '二', '三']);
});

test('textLayerFromProps：缺名字时回退默认名并保留样式', () => {
  const layer = textLayerFromProps({ text: '标题', fontSize: 72, strokeWidth: 4 });
  assert.equal(layer.name, '文字');
  assert.equal(layer.text, '标题');
  assert.equal(layer.fontSize, 72);
  assert.equal(layer.strokeWidth, 4);
});

test('TEXT_FONTS：至少提供系统默认与一款中文字体', () => {
  assert.ok(TEXT_FONTS.length >= 3);
  assert.ok(TEXT_FONTS.some((font) => font.id === TEXT_DEFAULTS.fontFamily));
  assert.ok(TEXT_FONTS.some((font) => font.label === '微软雅黑'));
});
