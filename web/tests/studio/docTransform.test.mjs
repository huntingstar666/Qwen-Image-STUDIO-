import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 对象级变换的纯几何回归：
 * - 单选文字层连续旋转时，文字视觉中心应保持不动（只原地转）；
 * - 已有角度的文字再旋转 / 翻转，中心同样不能漂移。
 *
 * 用最小 document / canvas 桩跑 StudioDoc，不依赖真实浏览器。
 */
function installCanvasStub() {
  const context = {
    font: '',
    measureText: (text) => ({ width: Math.max(1, String(text || '').length * 24) }),
    drawImage() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    fillText() {},
    strokeText() {},
    beginPath() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
    setTransform() {},
    putImageData() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 1,
        height: 1,
        getContext: () => context,
        toDataURL: () => 'data:image/png;base64,',
        toBlob: (cb) => cb(null),
      };
    },
  };
}

function centerOf(layer) {
  const box = layer.bounds();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} ≠ ${expected}`);
}

test('对象级变换：文字连续旋转 / 镜像后视觉中心不漂移', async () => {
  installCanvasStub();
  const { StudioDoc } = await import('../../src/components/studio/studioDoc.js');
  const { TextLayer } = await import('../../src/components/studio/textLayer.js');

  const doc = new StudioDoc({ width: 600, height: 400 }, 'test.png');
  const layer = new TextLayer({ text: '测试', x: 300, y: 200 });
  doc.layers = [layer];

  const start = centerOf(layer);

  // 连点两次「向右旋转」：中心不动，角度累计到 180°
  doc.rotateLayers([layer.id], 1);
  let now = centerOf(layer);
  assertClose(now.x, start.x, '第一次旋转后 x');
  assertClose(now.y, start.y, '第一次旋转后 y');

  doc.rotateLayers([layer.id], 1);
  now = centerOf(layer);
  assertClose(now.x, start.x, '第二次旋转后 x');
  assertClose(now.y, start.y, '第二次旋转后 y');
  assert.equal(Math.round(layer.rotation) % 360, 180);

  // 已有角度时水平镜像：中心不动，旋转角取反、翻转位切换
  doc.flipLayers([layer.id], 'h');
  now = centerOf(layer);
  assertClose(now.x, start.x, '镜像后 x');
  assertClose(now.y, start.y, '镜像后 y');
  assert.equal(layer.flipH, true);
  assert.equal(Math.round(layer.rotation) % 360, 180);
});
