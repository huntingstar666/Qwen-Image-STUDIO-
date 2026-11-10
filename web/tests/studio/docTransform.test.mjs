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

test('命名快照：回跳后新建快照保存的是当前画面，而不是回跳前', async () => {
  installCanvasStub();
  const { StudioDoc } = await import('../../src/components/studio/studioDoc.js');
  const { TextLayer } = await import('../../src/components/studio/textLayer.js');

  const doc = new StudioDoc({ width: 600, height: 400 }, 'test.png');
  const layer = new TextLayer({ text: '快照', x: 100, y: 100 });
  doc.layers = [layer];

  const first = doc.addSnapshot('A');
  assert.ok(first);

  // 改到另一个状态并入栈（模拟用户继续编辑）
  layer.x = 300;
  doc.snapshot();

  // 回跳 A：文档回到 x=100，但撤销栈顶仍是 x=300
  assert.equal(doc.restoreSnapshot(first.id), true);
  assert.equal(doc.layers[0].x, 100);

  // 立刻新建快照：必须是当前画面（x=100），不能是回跳前（x=300）
  const second = doc.addSnapshot('B');
  assert.ok(second);
  assert.equal(second.state.layers[0].x, 100);
});

test('复制图层：透视四点随副本一起偏移（§20.3.2）', async () => {
  installCanvasStub();
  const { createDocument, addLayer, cloneLayer } = await import('../../src/components/studio/document.js');
  const { OverlayLayer } = await import('../../src/components/studio/layers.js');

  const doc = createDocument({ width: 400, height: 400 });
  const layer = new OverlayLayer(
    { naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 },
    {
      x: 0,
      y: 0,
      quad: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
    },
  );
  addLayer(doc, layer);

  const copy = cloneLayer(doc, layer.id, { offset: 16 });
  assert.ok(copy);
  assert.deepEqual(
    copy.quad.map((point) => [point.x, point.y]),
    layer.quad.map((point) => [point.x + 16, point.y + 16]),
  );
});

test('弯曲文字：0 ↔ 非 0 切换时左端与基线保持不动（§20.3.6）', async () => {
  installCanvasStub();
  const { TextLayer } = await import('../../src/components/studio/textLayer.js');

  const layer = new TextLayer({ text: '弯曲测试', x: 120, y: 80 });
  const width = layer._textWidth();
  const halfLine = (layer.fontSize * layer.lineHeight) / 2;
  const startX = layer.x;
  const startY = layer.y;

  layer.setArc(30);
  assertClose(layer.x - width / 2, startX, '弯曲后左端');
  assertClose(layer.y - halfLine, startY, '弯曲后基线');

  layer.setArc(0);
  assertClose(layer.x, startX, '取消弯曲后 x');
  assertClose(layer.y, startY, '取消弯曲后 y');
});

test('弯曲文字：旋转 90° 后切换弯曲，补偿向量也随图层旋转（§22.7）', async () => {
  installCanvasStub();
  const { TextLayer } = await import('../../src/components/studio/textLayer.js');

  const layer = new TextLayer({ text: '弯曲测试', x: 120, y: 80, rotation: 90 });
  const halfWidth = layer._textWidth() / 2;
  const halfLine = (layer.fontSize * layer.lineHeight) / 2;
  const startX = layer.x;
  const startY = layer.y;

  layer.setArc(30);
  // R(90°) 把局部 (halfWidth, halfLine) 变成 (-halfLine, halfWidth)。
  assertClose(layer.x - startX, -halfLine, '旋转 90° 后 x 补偿');
  assertClose(layer.y - startY, halfWidth, '旋转 90° 后 y 补偿');

  layer.setArc(0);
  assertClose(layer.x, startX, '取消弯曲后 x');
  assertClose(layer.y, startY, '取消弯曲后 y');
});

