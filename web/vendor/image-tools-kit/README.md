# image-tools-kit

图片节点的「改造类」工具：裁切、宫格裁切、画笔标注、全景图、扩图。
纯 React + 原生 CSS；裁切默认在前端 canvas 完成，也可切换到 sharp 后端。

## 目录

```
image-tools-kit/
├── src/
│   ├── cropGeometry.js   # 裁切矩形、手柄命中、缩放、宫格切分（像素换算）
│   ├── prompt.js         # 全景提示词、全景/扩图草稿构造
│   ├── clientRenderer.js # canvas 载图 / 裁切 / 下载
│   └── index.js
├── react/
│   ├── ImageStudio.jsx   # 工作室菜单，串起下面四个对话框
│   ├── CropDialog.jsx    # 裁切 + 宫格裁切（拖拽、比例、行列、间距）
│   ├── AnnotateDialog.jsx# 画笔 / 橡皮，输出叠加图 + 黑白蒙版
│   ├── GenerateDialog.jsx# 全景生成 / 扩图
│   ├── PanoramaPreview.jsx # 无 three.js 的 360° 拖动预览
│   ├── Icon.jsx
│   ├── styles.css        # 唯一需要引入的样式
│   └── index.js
├── server/
│   ├── core.js           # sharp 裁切 / 宫格，框架无关
│   ├── handler.js        # node:http handler + 路径白名单
│   └── express.js        # Express Router
└── tests/crop.test.js    # 12 条几何与草稿用例
```

## 前端接入

```jsx
import 'image-tools-kit/react.css';
import { ImageStudio } from 'image-tools-kit/react';

<ImageStudio
  node={{ id, resultUrl, aspectRatio }}
  onClose={() => setOpen(false)}
  // 裁切产物：数组 [{ dataUrl, width, height, row, column }]
  // 标注产物：{ overlay, mask, width, height }
  onSave={async (result, meta) => {
    const uploaded = await uploadAll(result);       // 你的上传
    createNodes(uploaded);                           // 你的建节点
    return true;                                     // 返回 false 会提示失败
  }}
  // 全景 / 扩图：拿到节点字段补丁，自己 create + connect
  onGenerate={async (patch) => {
    const node = createNodeAt(sourceNode, patch);    // patch 已含 prompt/aspectRatio/imageAngle
    connect(sourceNode.id, node.id);
  }}
/>
```

标注产物是 `{ overlay, mask, width, height }`：`overlay` 透明叠加图，`mask` 白底黑字的局部重绘蒙版。

也可以只用单个对话框：

```jsx
import { CropDialog, PanoramaDialog, OutpaintDialog, AnnotateDialog, PanoramaPreview } from 'image-tools-kit/react';
```

## 后端（可选）

前端 canvas 已能完成裁切；需要服务端处理或统一落盘时：

```js
import sharp from 'sharp';
import { createImageEditingService } from 'image-tools-kit/server';
import { createImageEditingRouter } from 'image-tools-kit/server/express';
import { createPathResolver } from 'image-tools-kit/server/handler';

const service = createImageEditingService({
  sharp,
  outputDirectory: './public/generated',
  outputUrl: '/generated',
});
const resolveSource = createPathResolver(['./public/library']);

app.use(express.json({ limit: '2mb' }));
app.use('/api', createImageEditingRouter({ service, resolveSource, express }));
app.use('/generated', express.static('./public/generated'));
```

接口与请求体：

| 路由 | 请求体 |
| --- | --- |
| `POST /api/media/images/crop` | `{ source, rect: { x, y, width, height }, format?, quality? }` |
| `POST /api/media/images/grid` | `{ source, rect?, rows, columns, horizontalGap?, verticalGap?, columnGuides?, rowGuides?, format? }` |

返回 `{ success: true, asset }` 或 `{ success: true, assets: [...] }`，`asset.url` 为 `outputUrl` 下的地址。

不想用 Express 时，`createImageEditingHandler({ service, resolveSource })` 直接在 `node:http` 上使用。

## 与原项目的关系

| 原项目 | 本包 |
| --- | --- |
| `dialogs/canvasImageCrop.tsx` | `react/CropDialog.jsx` + `src/cropGeometry.js` |
| `dialogs/canvasImageStudio.tsx` | `react/ImageStudio.jsx` |
| `media/imageAngleDraft.ts` | `src/prompt.js` |
| `dialogs/panoramaGenerate.tsx` | `react/GenerateDialog.jsx` |
| `dialogs/canvasPanoramaScene.tsx`（three.js） | `react/PanoramaPreview.jsx`（等距柱状拖动，无 three） |
| `server/media/mediaEditingRouter.js` 裁剪/宫格 | `server/core.js` + `server/handler.js` |

差异说明：

1. 裁切默认前端 canvas 出图，不强制走后端；后端作为可选能力。
2. 去掉了项目目录约定（`projectId` / `libraryDirectory`），改为 `source` 路径 + `createPathResolver` 白名单。
3. 全景预览不引入 three.js，用 2:1 贴图拖动代替球面渲染；需要真球面可自行替换。
4. 原项目的“合成/拼图”阶段未包含；标注只输出叠加图与蒙版。
5. 产物落盘、建节点、连线全部通过 `onSave` / `onGenerate` 交给宿主。
