import test from 'node:test';
import assert from 'node:assert/strict';

import { TEXT_DEFAULTS, TEXT_FONTS, TextLayer, textLayerFromProps } from '../../src/components/studio/textLayer.js';

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
