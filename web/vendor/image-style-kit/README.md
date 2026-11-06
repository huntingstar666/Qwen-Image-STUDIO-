# image-style-kit

从媒体生成节点里单独抽出的「图片好用的那几套库」：风格、滤镜、运镜、MJ 码图馆、视角调整、MJ 专用垫图。
纯 React + 原生 CSS，除 `react` / `react-dom` 外零依赖。

## 目录

```
image-style-kit/
├── src/                     # 纯逻辑，可在任何框架里用
│   ├── creative.js          # 预设校验、提示词合成、收藏/自定义存储
│   ├── mjPrompt.js          # MJ 参数归并、--preview 清理
│   ├── mjStyles.js          # 码图分组、四种插入模式、过滤
│   ├── midjourneyReferences.js  # cref / sref / dref 分配与请求载荷
│   ├── imageAngle.js        # 视角参数 + 相机语义提示词
│   ├── catalogs.js          # 目录 + 预览图地址解析
│   └── index.js
├── data/
│   ├── creativeCatalog.json # 风格 / 运镜 / 滤镜，285 条
│   └── mjStyleCatalog.json  # MJ 码图，493 条
├── react/                   # UI（全部用 af-* 类名，样式已带 --mgn-* 映射）
│   ├── CreativeLibrary.jsx  # 风格库面板 + 已选标签 + 入口按钮
│   ├── MjStyleLibrary.jsx   # MJ 码图馆
│   ├── ImageAngle.jsx       # 视角控件 + 拖拽弹层
│   ├── MidjourneyReferencePanel.jsx
│   ├── Icon.jsx
│   ├── library.css          # 唯一需要引入的样式文件
│   └── index.js
└── scripts/sync-assets.ps1  # 按需同步约 112MB 预览图
```

## 接入

```jsx
import './react/library.css';
import { CreativeLibraryTools, CreativePromptTokens, MjStyleStatus, ImageAngleControl } from 'image-style-kit/react';
import { createAssetResolver } from 'image-style-kit';

const resolveAssetUrl = createAssetResolver({
  creative: '/creative-presets',
  mj: '/mj-styles',
});

// node 只需是一个普通对象，字段如下：
// { id, type: 'Image', prompt, creativePresets, imageAngle, midjourneyReferenceNodeIds }

<CreativePromptTokens node={node} onUpdate={updateNode} />
<MjStyleStatus prompt={node.prompt} />
<CreativeLibraryTools node={node} onUpdate={updateNode} resolveAssetUrl={resolveAssetUrl} />
<ImageAngleControl node={node} onUpdate={updateNode} />
```

### 生成请求

```js
import { buildNodePrompt } from 'image-style-kit';

const prompt = buildNodePrompt(node.prompt, node);
// 顺序：创意前缀 → 正文 → 创意后缀 → MJ 参数归并 → 视角提示词
```

MJ 专用垫图：

```js
import { supportsMidjourneyReferences, resolveMidjourneyReferencePayload } from 'image-style-kit';

const midjourneyReferences = supportsMidjourneyReferences(model)
  ? resolveMidjourneyReferencePayload(node, nodes)
  : null;
```

### 两个可覆盖的入口

- `onInsertText(text)`：MJ 码图插入时调用。不传就自动追加到 `node.prompt`；传了可接到你自己的编辑器光标处。
- `creativeStorage`：收藏与自定义预设的存储，传 `{ load, save }`；默认 `localStorage`。

> 注意：三个库面板都用 `createPortal` 挂到 `document.body`，宿主不可对 `body` 做 `transform`。

## 预览图

`data/*.json` 只含文字与图片相对路径，图片本体（约 112MB）不在此包内：

1. 在原项目执行 `pwsh -File scripts/sync-assets.ps1`，把 `public/creative-presets`、`public/mj-styles` 同步到本包 `assets/` 再挂静态服务
2. 或直接用 `createAssetResolver({ creative: '原项目静态地址', mj: '原项目静态地址' })`

## 行为说明

- 风格 / 滤镜 / 运镜：选择后写入 `node.creativePresets` 快照（按 `style / filter / motion / custom` 四个槽位），面板顶部显示可移除标签
- MJ 码图：默认插入正文，不动 `creativePresets`
- 视角：`node.imageAngle = { azimuth, elevation, zoom }`，生成时追加相机语义提示词；设为 `null` 即关闭
- 垫图：同一张图只能占一个角色；未分配角色的连接图仍按普通参考图发送
