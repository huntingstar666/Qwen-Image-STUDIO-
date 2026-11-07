# 前端方案：图片精修「PS + AI」工作台（代码锚定版）

> 状态：**前端施工方案**。后端由其他人并行开发，本方案只动前端，且**以现有 `studio.js` 为宿主增量扩展**。
> 上游设计：`docs/PLAN_PS_EDIT_GH.md`（管线、9 步 sigma、LoRA、零偏移/零色差）。
> 原则：**先锚定真实代码，再动手；不改别人正在改的文件。**

---

## 0. 施工边界（重要）

当前工作区有未提交改动（别人在改前端/后端）：

```
M web/index.html
M web/src/components/controls.js
M web/src/components/edit.js
M web/src/components/jobView.js
M web/src/components/t2i.js
M web/src/store.js
?? web/assets/css/composer.css
?? web/src/components/compare.js
?? web/src/components/lightbox.js
```

**红线：**
1. 不修改上面 6 个已改动文件中的任何一个。
2. 不修改 `compare.js` / `lightbox.js` / `composer.css`（新建但归属不明）。
3. 只做：**新增文件** + 对 `studio.js` / `studio/studioDoc.js` / `assets/css/studio.css` 的增量修改（这三个文件当前干净）。
4. 后端契约以 `edit.js:1190-1242` 的**实际 payload** 为准，新字段全部**追加**，不改旧字段名。

---

## 1. 代码锚点（已核对）

### 1.1 `web/src/components/studio.js`（1117 行，页面宿主）

| 行号 | 锚点 | 用途 |
| --- | --- | --- |
| 16-21 | imports | 已引入 `StudioDoc`、`toast`、`handoff` |
| 23-72 | `TOOLS` | 左工具栏定义（view/crop/brush/eraser/rect/ellipse） |
| 85 | `createStudioPage(host)` | 入口；内部状态：`doc/tool/brush/view/showMask/activeTab` |
| 88 | `let brush = { size, hardness, opacity }` | 笔刷参数 |
| 91 | `let activeTab = 'adjust'` | 右栏 tab 状态 |
| 100-236 | `host.innerHTML` 模板 | 顶栏 103-118、画布 139-158、右栏 167-233 |
| 168-172 | `.studio-tabs` | 只有 adjust/mask/transform 三个 tab |
| 174-228 | `[data-pane]` | 三个面板 |
| 238-276 | `ref()` / `refs` | DOM 引用表 |
| 292-313 | `setTool(next)` | 工具切换 + 自动切 tab |
| 315-322 | `syncTabs()` | tab 显示同步 |
| 386-392 | `scheduleDraw()` | rAF 合帧 |
| 394-486 | `draw()` | 画布渲染：底图 400-408、蒙版 tint 410-420、裁剪框 423-449、形状预览 452-468、笔刷光标 470-485 |
| 492-523 | `toImage/clampPoint/maskPoint/offsetRect` | 屏幕↔图像坐标（含裁剪偏移） |
| 525-554 | `stampMask(point)` | 笔刷落点（含硬度渐变） |
| 556-565 | `strokeTo(point)` | 连续笔画插值 |
| 573-592 | `fillShape(rect)` | 矩形/椭圆填充蒙版 + `snapshot()` |
| 598-623 | `pointerdown` | pan/crop/paint/shape 四种模式 |
| 625-653 | `pointermove` | 同上 |
| 655-678 | `endDrag()` | 收笔快照、形状填充、裁剪框确认 |
| 687-692 | `wheel` | 缩放 |
| 702-738 | `loadImage/openFile/openUrl` | 打开图片 |
| 740-760 | `setDoc(next)` | 载入文档、刷新 UI、`fitView()` |
| 762-786 | `updateSizeInfo/updateMaskStatus` | 尺寸与蒙版覆盖率 |
| 848-864 | `sendToEdit()` | 现有"送入图像编辑"（保留作为逃生通道） |
| 870-911 | 事件绑定 | 工具栏、tab、打开、导出、撤销重做、送编辑 |

### 1.2 `web/src/components/studio/studioDoc.js`（382 行，文档模型）

| 行号 | 锚点 | 说明 |
| --- | --- | --- |
| 41-56 | `class StudioDoc` | `image/transform/adjust/mask/history/future` |
| 60-76 | `sourceSize/oriented/size` | 尺寸语义 |
| 80-121 | `snapshot/restore/undo/redo` | 状态快照（含蒙版副本，上限 30） |
| 125-179 | 旋转/翻转/裁剪/reset | 蒙版随变换 |
| 187-246 | `clearMask/hasMask/maskCoverage/maskCanvas` | 蒙版 API |
| 294-345 | `renderBase()` | 原图+变换+调色+裁剪，带缓存 `_base` |
| 347-357 | `renderMaskTint()` | 红色蒙版叠加图 |
| 365-376 | `bake(type, quality)` | 导出 |
| 378-381 | `maskPng()` | 蒙版 PNG（白色 + alpha） |

### 1.3 其他

| 文件:行 | 锚点 |
| --- | --- |
| `web/src/api.js:88` | `api.polish(payload)`（5 分钟超时） |
| `web/src/api.js:98` | `api.edit(payload)` |
| `web/src/api.js:103` | `api.job(id)` |
| `web/src/api.js:68` | `api.options()` |
| `web/src/api.js:231` | `pollJob(jobId, onUpdate, {interval})` |
| `web/src/components/jobView.js:28` | `class JobRunner` |
| `web/src/components/jobView.js:33` | `constructor(host, opts)` |
| `web/src/components/jobView.js:144` | `start({create, maskDataUrl, prompt, favoriteMeta, onDone, onProgress})` |
| `web/src/components/jobView.js:313` | `getResults()` |
| `web/src/components/compare.js:618` | `openCompareDialog({references:[{url,label}], results:[{url,label}], initialReference, initialResult})` |
| `web/src/handoff.js:24/48` | `setHandoff / goToEditPage` |
| `web/src/app.js:61-73` | 页面路由（studio → `createStudioPage`） |
| `web/assets/css/studio.css:405-560` | `.studio-panel / .studio-tabs / .studio-pane / .studio-slider / .studio-row / .studio-note` |

---

## 2. 目标布局（在现有骨架上加一栏）

```
studio-bar（保持）
├─ 左 rail（加「套索」）
├─ 中间 stage（不变，增加结果预览层）
└─ studio-panel
   tabs:  AI  |  调整  |  蒙版  |  变换
   AI pane:
     ┌ 指令 ───────────────────────────┐
     │ textarea + @引用 + 润色 + 修改    │
     ├ 参考图（图一锁定 / 图二…）────────┤
     ├ 输出设置（分辨率 / 预处理 / 局部）─┤
     ├ LoRA（任务 / 一致性 / 自定义）────┤
     └ 结果（JobRunner）+ 对比按钮 ──────┘
```

**默认 tab 改为 `ai`**（用户核心动线：上传 → 圈选 → 写指令 → 修改）。没有图片时仍显示空状态。

---

## 3. 新增文件（零冲突）

| 文件 | 职责 | 预估 |
| --- | --- | --- |
| `web/src/components/studio/aiPanel.js` | AI 分页 DOM、指令、@引用、润色、提交、结果区 | ~330 行 |
| `web/src/components/studio/refStrip.js` | 参考图上传/排序/删除/缩略图（图一锁定） | ~120 行 |
| `web/src/components/studio/outSettings.js` | 分辨率模式、预处理、局部策略、零偏移开关 | ~180 行 |
| `web/src/components/studio/loraPanel.js` | 任务/一致性/自定义 LoRA | ~130 行 |
| `web/src/components/studio/payload.js` | 纯函数：`buildEditPayload(ctx)`、`mapMentions()` | ~150 行 |
| `web/src/components/studio/layers.js` | `OverlayLayer` 类 + 叠加层交互 | ~180 行 |
| `web/src/components/studio/resultPreview.js` | 画布叠加结果预览、Tab 闪切 | ~90 行 |

**不新增 CSS 文件**：样式追加到 `web/assets/css/studio.css` 末尾（该文件干净，避免改 `index.html`）。

---

## 4. 数据流

```
createStudioPage(host)
 ├─ doc : StudioDoc          （主图 + 变换 + 调色 + 蒙版 + 叠加层）
 ├─ view: {scale,x,y}        （现有）
 ├─ ai  : {
 │     prompt, polished,
 │     refs: [{id,name,url,image}],     // refs[0] 恒为主图（不可删）
 │     settings: {sizeMode, width, height, ratio, megapixels,
 │                preprocess:{enabled,maxSide}, zeroShift, colorProtect,
 │                scheme, feather, maskExpand},
 │     loras: {task, consistency, strength, custom:[]},
 │     jobId, results: [], previewUrl, compareOpen
 │   }
 └─ aiPanel.mount(aiPane, ctx)   // ctx 暴露 getDoc/getView/refresh/onResult
```

**坐标基准：** 一切以 `doc.renderBase()`（= 主图 + 变换 + 调色 + 叠加层）为准，尺寸等于 `doc.size`。蒙版 `doc.maskCanvas()` 与它同尺寸。

---

## 5. `StudioDoc` 增量设计（不改旧语义）

### 5.1 叠加层

```js
// layers.js
export class OverlayLayer {
  constructor(image, { name = 'overlay', x, y, scale = 1, rotation = 0, opacity = 1 } = {}) {}
  // 内部：x/y 是"叠加图左上角"在图上的像素坐标；默认居中
  draw(ctx, targetW, targetH) {}   // 变换后 drawImage
  hitTest(px, py) {}
  bounds() {}
}
```

`StudioDoc` 新增：

```js
this.layers = [];                 // 仅叠加层，底图不在数组里（底图永远锁定）

addOverlay(image, opts) {
  const layer = new OverlayLayer(image, {
    x: (this.size.width - image.width * opts.scale) / 2,
    y: (this.size.height - image.height * opts.scale) / 2,
    scale: Math.min(1, (this.size.width * 0.6) / image.width),
    ...opts,
  });
  this.layers.push(layer);
  this.invalidateBase();
  this.snapshot();
  return layer;
}

removeOverlay(id) / moveOverlay(id, dx, dy) / scaleOverlay(id, factor) / setOverlayOpacity(id, v)
```

`renderBase()` 末尾追加：

```js
if (this.layers.length) {
  const ctx2 = canvas.getContext('2d');
  for (const layer of this.layers) layer.draw(ctx2, canvas.width, canvas.height);
}
```

> 约束：`layers` 参与 `renderBase()` 缓存失效（任何 move/scale 都要 `invalidateBase()`）；`snapshot()` 只记录 layer 的**几何参数**，不复制图片对象。

### 5.2 结果预览

不改 `renderBase`。画布 `draw()` 里，若 `ai.previewUrl` 有值：

```js
// resultPreview.js 暴露 drawResult(ctx, view, image, alpha)
if (aiPreview && showResult) {
  ctx.globalAlpha = 0.0 → 1.0（Tab 闪切时 1.0）
  ctx.drawImage(aiPreview, view.x, view.y, w, h);
}
```

`Tab` 按下显示结果，松开回到原图；另提供"固定显示结果"开关。

### 5.3 套索工具

`TOOLS` 增加：

```js
{ id: 'lasso', label: '套索蒙版', key: 'L', hint: '圈出要修改的区域，自动闭合填充' }
```

`MASK_TOOLS` 加入 `lasso`。指针逻辑新增 `drag.mode === 'lasso'`：
- `pointerdown` 记录 `points: [{x,y}]`
- `pointermove` push 点 + `scheduleDraw()` 画虚线路径
- `endDrag()`：点数 ≥ 3 → `fillLasso(points)`（闭合 + 扫描线/`evenodd` 填充）→ `snapshot()`；< 3 → 丢弃

> 这就是需求里的"直接在主图的苹果上画一个圈，自动补全为一个蒙版"。

---

## 6. AI 面板细节

### 6.1 指令区

```
<textarea placeholder="帮我去除苹果 / 把 @图二 的梨子替换进去">`
[ @ 引用 ] [ ✦ 润色 ] [清空]                    0/2000
[ 修改 ]（Ctrl+Enter）
```

- `@` 按钮弹出：`图一（主图·锁定）`、`图二`、`图三`…，插入到光标处。
- `mapMentions(text, refCount)`：`@图一→图1`、`@图二→图2`；越界引用自动忽略。
- 「润色」→ `api.polish({ prompt, mode:'edit', image_model:'qwen', target_size:[w,h], images:[...], references:[...] })`；返回 `{prompt}`，展示原/润色双栏，采用后回填。
- 空白提交拦截 + toast。

### 6.2 参考图

- 第一张 = 主图，缩略图带锁图标，不可删除/排序。
- `+` 上传（最多 3 张，与后端 `MAX_IMAGES` 一致）。
- 每张显示 `图二` 标签，可删除；上传后自动写入 `@图二` 提示。

### 6.3 输出设置

| 控件 | 值 | 说明 |
| --- | --- | --- |
| 分辨率 | `跟随主图`（默认）/ `指定尺寸` / `比例` | 对应 `size_mode: follow/custom/ratio` |
| 宽高 | 自动 32 对齐显示 | `follow` 时只读 |
| 零偏移保护 | 默认开，锁定不可关（高级可关） | 提示"32 对齐 · resolution=0 · 遮罩外不变" |
| 色彩保护 | 默认开 | 同上 |
| 图片预处理 | 默认开；尺寸 1024/1536/2048/2560 | 显示"工作画布 2048 × 1152" |
| 局部策略 | 自动 / 全画布 / 裁切块 | `scheme: auto/a/b` |
| 羽化 / 遮罩外扩 | 32 / 0 | `feather / mask_expand` |

实时计算：`工作画布 = snap32(min(size, maxSide))`，并显示 token 量级提示（>4096 警告）。

### 6.4 LoRA

- **任务**：`自动`（按指令关键词 + 有无遮罩推断：去除/移除→remove；扩图/延展→outpaint；其余→none）
- **一致性**：默认勾选，强度 0.48（可滑 0.2~0.8）
- **自定义**：来自 `api.options().loras`，可加多条，最多总 2 条，超出黄条提示
- 后端未返回预设时：下拉展示 `consistency_lora` 现有字段，任务 LoRA 退回"自定义"

### 6.5 提交 → 结果

```js
const { jobId } = await api.edit(buildEditPayload(ctx));
const job = await pollJob(jobId, (j) => aiPanel.setProgress(j));
if (job.status === 'done') {
  ai.results.unshift(job.images[0]);
  ai.previewUrl = job.images[0].url;
  aiPanel.setQuality(job.quality);   // outside_max_abs / size_match / steps
}
```

结果区直接复用 `JobRunner`（`jobView.js:28`）渲染缩略图/大图/进度，避免重复造轮子。

### 6.6 对比

```js
openCompareDialog({
  references: [{ url: doc.bake('image/png'), label: '底图（主图）' }],
  results: ai.results.map((r, i) => ({ url: r.url, label: `结果 ${i + 1}` })),
});
```

结果条旁显示：`遮罩外差异 0 · 4000×2250 · 9 步 · 18.4s`。

`job.quality` 追加的诊断项（后端就绪后自动生效，前端缺省隐藏）：
`changed_ratio` → 「改动 0.2%」；`leak_ratio > 0` → 黄标「遮罩外改动 0.3%」；`color.skipped` → 灰标「校色已跳过」。

---

## 7. 请求契约（**追加式**，兼容现有后端）

以 `edit.js:1190-1242` 为准，前端发送：

```jsonc
{
  "prompt": "把图1中的苹果替换成图2的梨子",
  "negative_prompt": "",
  "images": [{ "name": "main.png", "data": "data:image/png;base64,..." },
             { "name": "pear.png", "data": "data:image/png;base64,..." }],
  "size_mode": "follow",
  "width": null, "height": null, "ratio": null, "megapixels": null,
  "fit": "pad", "pad_mode": "edge",
  "mask": { "data": "data:image/png;base64,..." },
  "resolution": 0,
  "steps": 9, "cfg": 1.0, "denoise": 1,
  "sampler": "euler", "scheduler": "simple",
  "turbo": { "enabled": true, "profile": "turbo9_gh" },
  "models": { "unet": "", "clip": "", "vae": "" },
  "loras": [{ "name": "...", "strength": 1.0 }],
  "consistency_lora": { "name": "Qwen2.1 一致性无偏移_GH_V1.0.safetensors", "strength": 0.48 },

  // ===== 新增（后端未实现时应被忽略，不得报错）=====
  "task": { "mode": "edit" },
  "preprocess": { "enabled": true, "max_side": 2048, "min_side": 768, "multiple": 32, "mode": "downscale_only" },
  "zero_shift": { "enabled": true },
  "local": {
    "enabled": true, "scheme": "auto",
    "feather": 32, "mask_expand": 0,
    "color_match": true, "color_strength": 0.6,
    "color_restore": true, "color_restore_strength": 1.0,
    "expand_top": 1.3, "expand_bottom": 1.4, "expand_left": 1.4, "expand_right": 1.4,
    "fills": true, "hint": "none"
  },
  "meta": { "source": "web/studio", "rawPrompt": "...", "targetSize": {"width":4000,"height":2250}, "maskSize": {"width":4000,"height":2250} }
}
```

**兼容策略：** 新字段若被后端 422 拒绝（错误信息含未知字段），用 `legacyPayload()` 去掉 `task/preprocess/zero_shift/local.* 新增键` 重试一次，并 toast「后端尚未支持预处理/零偏移参数，已按旧参数提交」。

---

## 8. 实施顺序（按可验证的垂直切片）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **F1** | `studioDoc` 叠加层 + `layers.js` + 套索工具 | 能叠一张扣图、圈选成蒙版、撤销正常 |
| **F2** | `aiPanel` 骨架 + 指令 + `payload.js` + 提交轮询 | 圈苹果 → 输入"去除苹果" → 出结果 |
| **F3** | `refStrip` + `@图N` + `polish` | 上传图二 → 指令引用 → 润色回填 |
| **F4** | `outSettings` + `loraPanel` | 分辨率/预处理/LoRA 选择进入 payload |
| **F5** | `compare` + 结果预览 + Tab 闪切 + 状态条 | 对比底图/结果、显示 outside_max_abs |
| **F6** | 快捷键、空状态、错误处理、移动端收窄 | 全流程无阻塞 |

每阶段结束跑一次浏览器冒烟（本地 `127.0.0.1:8700`）。

---

## 9. 交互与可用性

| 操作 | 行为 |
| --- | --- |
| 拖入/粘贴图片 | 作为主图（若已有主图则作为参考图） |
| 椭圆/套索画圈 | 直接生成蒙版（软边 = 硬度） |
| 右键拖拽 / 空格拖拽 | 平移 |
| 滚轮 | 以光标为中心缩放 |
| `Tab` 按住 | 原图/结果闪切 |
| `Ctrl+Enter` | 提交 |
| `M` | 蒙版显隐 |
| `[` `]` | 笔刷大小 |
| `Esc` | 关闭对比/取消框选 |

**空状态文案：** `拖入一张图片开始精修 · 主图会锁定为底图`
**无蒙版提交：** `未检测到蒙版：将按整图重绘。推荐先用椭圆/套索圈出要改的区域。`（可继续）

---

## 10. 验收清单

- [ ] 打开 4000×2250 主图，画布适应屏幕，尺寸显示正确
- [ ] 椭圆圈苹果 → 蒙版覆盖率 3~8%，红色叠加位置准确
- [ ] 输入"帮我去除苹果" → 提交 → 进度 → 结果 → 对比
- [ ] 结果默认 `follow`，输出尺寸 == 主图尺寸
- [ ] 开启预处理 2048，payload 中 `preprocess.enabled=true, max_side=2048`
- [ ] 上传图二，指令含 `@图二`，payload `images.length == 2` 且顺序正确
- [ ] 润色成功回填；失败不阻塞提交
- [ ] 叠加一张扣图，可拖动/缩放/透明度，导出包含叠加
- [ ] LoRA 默认一致性 0.48；任务选"元素移除"后 payload `loras` 正确
- [ ] `Tab` 闪切、对比对话框、`outside_max_abs=0` 展示
- [ ] 刷新页面不残留任务（sessionStorage 恢复或清理）
- [ ] 控制台无报错；不影响 调整/蒙版/变换 三个旧 tab

---

## 11. 风险

| 风险 | 处理 |
| --- | --- |
| 别人正在改 `jobView.js` | 只 import `JobRunner`，不改文件；若 API 变动，退回自写轮询（`api.pollJob`） |
| 后端未支持 `turbo9_gh` | `api.options()` 无该 profile → 关闭 turbo 或退回已有 profile，toast 说明 |
| 后端未支持 `preprocess` | 422 时 `legacyPayload()` 重试 |
| 主图过大导致浏览器卡顿 | 画布只用 `renderBase()` 缩放显示，不复制原图；叠加层用 Canvas 变换 |
| 蒙版尺寸与叠加层不一致 | 蒙版始终在主图坐标系，叠加层只影响 `renderBase()`，不参与蒙版 |
| 与 `edit.js` 功能重复 | 保留"送入图像编辑"作为逃生通道，不删除 |

---

## 12. 精修工作室打磨 v2（2026-11-07 方案，未实施）

> 目标：把「图片精修」从「功能堆叠页」打磨成符合苹果设计理念的工作台。
> 本轮只写方案与步骤，不改代码；等确认后按 S1~S6 逐步实施、每步独立提交。

### 12.1 现状审计（代码锚点）

| 能力 | 代码位置 | 现状 | 缺口 |
| --- | --- | --- | --- |
| 主图导入 | `studio.js:1238-1464` | 本地文件选择、拖文件到画布、全局粘贴、素材仓库 handoff | 无应用内「从素材仓库选择」；拖入多文件只取第一张；无统一导入入口 |
| 主图空状态 | `studio.js:190-200` | 「打开图片 / 用近期结果试试」 | 缺「从素材仓库导入」 |
| 参考图 | `aiPanel.js:565-589, 867-868` | 只能「+ 添加参考图」选本地文件 | 不能从素材仓库选、不能拖入、不能拖图库缩略图 |
| @引用 | `aiPanel.js:591-612` | 纯文本插入 `@图二`，无视觉区分 | 不是富文本 chip；不能拖图插入；删除参考图后文本残留 |
| 左栏工具 | `studio.js:26-99, 494-500` | 9 个工具平铺（抓手/裁剪/5 种蒙版/移动/扩图） | 无分组，蒙版工具与变换工具混在一起 |
| 右栏 | `studio.js:216-292` | 5 个 tab：AI 修改 / 扩图 / 调整 / 蒙版 / 变换 | tab 过多；AI 面板常驻 15+ 控件，设置「又多又乱」 |
| AI 面板 | `aiPanel.js:52-180` | 预设、保护、指令、参考图、输出、扩图入口、高级、加速、任务、一致性、LoRA、结果全部纵向堆叠 | 缺渐进披露；主操作「修改」被淹没 |
| 未来能力 | `studio/panoramaPanel.js`、`PLAN_IMAGE_TOOLS_V2.md` | 全景已接入编辑页；高清放大在图像处理页 | 精修工作室未预留入口 |

### 12.2 目标信息架构

```
┌ 顶栏：文件名 · 尺寸        [导入 ▾] [撤销] [重做]        [导出 ▾] [送入图像编辑] ┐
├───────┬───────────────────────────────────────┬───────────────────────────────┤
│ 工具栏 │              画布                       │  右栏（分段控件 3 个）          │
│       │                                       │  [ AI 修改 ][ 调整 ][ 变换 ]    │
│ 查看   │   拖入图片 / 粘贴 / 从素材仓库导入      │                               │
│  抓手  │                                       │  AI：指令框（富文本 @）         │
│       │   ┌───────────────────────────────┐   │      + 参考图条                 │
│ 选区   │   │  工具选项浮条（按当前工具出现） │   │      + 「更多设置」折叠          │
│  画笔  │   │  画笔大小/硬度/不透明度 · 裁剪  │   │      + 结果                     │
│  橡皮  │   └───────────────────────────────┘   │                               │
│  矩形  │                                       │  调整：6 个滑块 + 复位           │
│  椭圆  │                                       │  变换：旋转/翻转/裁剪/恢复原图    │
│  套索  │                                       │                               │
│       │                                       │  扩图：选中「扩图」工具时出现     │
│ 变换   │                                       │                               │
│  裁剪  │                                       │                               │
│  移动  │                                       │                               │
│       │                                       │                               │
│ 生成*  │                                       │                               │
│  全景* │                                       │                               │
│  放大* │                                       │                               │
└───────┴───────────────────────────────────────┴───────────────────────────────┘
   * 预留位，等全景 / 高清放大后端接入后再启用，本轮不实现
```

设计原则：

1. **一个主操作**：AI 面板只保留一个蓝色主按钮「修改」。
2. **渐进披露**：常驻内容只有「指令 + 参考图 + 修改」；预设、输出尺寸、采样、LoRA、高级参数收进「更多设置」。
3. **上下文工具**：蒙版参数不再占一个 tab，跟随画笔工具以浮条出现；裁剪参数只在裁剪时出现。
4. **入口收敛**：所有导入走同一个「导入 ▾」菜单；所有导出走同一个「导出 ▾」菜单。
5. **状态可见**：折叠的「更多设置」右侧显示一行摘要，如 `预设：自然 · 2048 · Turbo 8 步`。

### 12.3 导入统一（主图与参考图同一套逻辑）

新增 `web/src/components/studio/importPicker.js`，只做选择与取图，不改现有 `refLibrary.js`：

```js
// 返回 [{ name, src, width, height, source }]
openImportPicker({
  title: '导入素材',
  multiple: false,          // 参考图 true
  accept: 'main' | 'ref',
  onPick(items) {},
});
```

三个来源：

| 来源 | 实现 | 主图 | 参考图 |
| --- | --- | --- | --- |
| 本地文件 | `input[type=file]`，可多选 | 取第一张，其余按顺序转参考图 | 全部加入，上限 3 张 |
| 素材仓库 | `api.materials({limit:200})` 复用现有弹窗网格样式 | 单选，打开为新文档 | 多选，批量加入 |
| 最近结果 | `GET /api/history?limit=20` | 单选 | 多选 |

规则：

- 统一用 `api.fileUrl()` 解析仓库地址，再 `fetch → blob → FileReader` 转 dataURL（提交契约要求 dataURL）。
- 同一 `src` 去重；参考图总数上限 3（与后端 `MAX_IMAGES=4` 含主图一致）。
- 仓库弹窗沿用 `refLibrary.js` 的 `.ref-pick-grid` 视觉，但抽到新模块，避免改共用组件。

拖拽矩阵（统一在 `studio.js` 与 `aiPanel.js` 各加一层 drop 处理）：

| 拖入位置 | 载荷 | 行为 |
| --- | --- | --- |
| 画布（无主图） | 文件 ×1 | 打开为主图 |
| 画布（无主图） | 文件 ×N | 第一张主图，其余进参考图 |
| 画布（已有主图） | 文件 ×1 / ×N | 全部进参考图（保持当前文案「已打开主图，拖入的图片作为参考图」） |
| 画布 | `application/x-wb-ref`（图库缩略图） | 先转参考图，再写入富文本 `@` chip |
| 参考图条 / 指令框 | 文件 ×N | 全部进参考图 |
| 参考图条 / 指令框 | `application/x-wb-ref` | 直接加入参考图并插入 chip |

粘贴保持现状：有主图时作为参考图，无主图时作为主图。

### 12.4 指令框富文本 @参考图

现状是 `textarea` + 纯文本 `@图二`。改为富文本编辑器，但**提交契约不变**：序列化后仍是 `@图二`，继续走 `mapMentions()` → `图2`。

新增 `web/src/components/studio/promptEditor.js`，对外 API：

```js
createPromptEditor(host, {
  placeholder,
  onChange(text) {},
  onEnterSubmit() {},       // Ctrl/Cmd+Enter
  onMentionQuery(q) {},     // 输入 @ 时触发
});
editor.getText();            // 序列化为纯文本：'把 @图二 的梨子替换 @图一 的苹果'
editor.setMentionMenu(items, onPick);
editor.insertMention({ refId, label });
editor.syncRefs(refs);       // 参考图增删后重排编号
editor.focus(); editor.clear();
```

DOM 结构：

```html
<div class="pe-editor" contenteditable="true" role="textbox" aria-multiline="true">
  把 <span class="pe-mention" contenteditable="false" data-ref-id="ref-2">@图二</span> 的梨子替换…
</div>
```

关键规则：

1. **chip 是原子节点**：`contenteditable=false`；Backspace/Delete 遇到 chip 整块删除；方向键跨过 chip。
2. **序列化**：遍历子节点，文本取 `textContent`，chip 取 `data-ref-id` 对应编号 → `@图二`；`<br>` / `<div>` 转 `\n`。
3. **编号联动**：chip 只存 `refId`，显示文案由当前参考图顺序计算（主图固定「图一」，参考图「图二/三/四」）。删除参考图 → 同步移除对应 chip 并提示；其余 chip 自动重排。
4. **输入 @**：`beforeinput` / `keydown` 检测光标前一个字符为 `@`，弹出参考图菜单（复用现有 `.ai-mention` 样式），选中后插入 chip 并吞掉输入的 `@`。
5. **粘贴**：`paste` 事件只取 `text/plain`，`insertText` 插入，防止外部富文本污染。
6. **输入法**：`compositionstart/end` 期间不触发 mention 菜单、不重排。
7. **拖图插入**：接收 `REF_DRAG_TYPE`，先加入参考图，再在光标处插入 chip。
8. **无障碍**：保留 `role=textbox`、`aria-label="修改指令"`；空内容用 CSS `:empty::before` 显示 placeholder。
9. **兜底**：若浏览器对 contenteditable 行为异常（如全选删除后残留 `<br>`），序列化时统一 trim 并折叠连续空行。

迁移点：`aiPanel.js` 中 `refs.prompt`（textarea）替换为编辑器容器；`syncPrompt/polish/submit/insertMention` 改调编辑器 API；`state.prompt` 保留为序列化文本。

### 12.5 右栏与工具栏重构

**右栏**：5 tab → 3 段控件 + 1 个上下文面板。

| 段 | 内容 | 说明 |
| --- | --- | --- |
| AI 修改 | 指令（富文本）+ 参考图 + 更多设置 + 结果 | 默认页 |
| 调整 | 曝光/亮度/对比度/饱和度/色温/色调 + 复位 | 原「调整」tab 保持不变 |
| 变换 | 左转/右转/水平翻转/垂直翻转/裁剪/清除裁剪/恢复原图 | 合并原「变换」 |
| 扩图 | 仍在右栏，但只在选中「扩图」工具时替换当前段显示 | 不再占常驻 tab |

**蒙版**：从 tab 中移除，参数改为画布上方的工具选项浮条：

```
[ 画笔 ▾ ]  大小 64  [——●——]   硬度 70% [——●——]   不透明度 100% [——●——]   清除蒙版
```

**AI 面板渐进披露**：

```
方案预设：自然 ▾         （折叠时只显示这一行摘要）
指令框（富文本 @）        ← 常驻
参考图条（图一锁定 + 图二…）← 常驻
[修改]                   ← 唯一主按钮
▸ 更多设置   预设：自然 · 输出 2048 · Turbo 8 步
   ├ 输出尺寸（跟随/指定/比例）
   ├ 采样与加速（Turbo、步数/CFG 摘要）
   ├ LoRA（一致性开关/强度、自定义 LoRA）
   └ 高级参数（原 advanced.js，再折叠一层）
结果卡片（提交后出现）
```

**顶栏**：

```
文件 · 尺寸    [导入 ▾] [撤销] [重做]        [收藏/复制] [导出 ▾] [送入图像编辑]
```

- 「导入 ▾」：本地文件 / 素材仓库 / 最近结果。
- 「导出 ▾」：PNG / JPG / 导出蒙版 / 复制 / 收藏。
- 「送入图像编辑」保留为主按钮。

**左栏**：按「查看 / 选区 / 变换 / 生成」分组，组间 1px 分隔线 + 组标题（hover 才显示文字，默认只显示图标）。工具项保持现有 `data-tool`，只改 DOM 分组，不改 `setTool` 逻辑。

### 12.6 视觉规范（苹果风）

| 项 | 规范 |
| --- | --- |
| 间距 | 8pt 栅格：4 / 8 / 12 / 16 / 24 |
| 圆角 | 面板 14px，卡片 10px，chip 999px |
| 描边 | 1px `color-mix(in srgb, currentColor 10%, transparent)`；不再叠加多重边框 |
| 字体 | 系统字体栈；标题 15/600，正文 13/400，辅助 11/500 |
| 颜色 | 中性灰为主；仅主按钮使用强调色；状态色只用于成功/警告/错误小圆点 |
| 阴影 | 画布区一层柔和阴影；面板不使用重阴影 |
| 动效 | 展开/折叠 160ms ease-out；tab 切换 120ms；遵守 `prefers-reduced-motion` |
| 空状态 | 画布中央大拖拽区 + 两个按钮：「从本地选择」「从素材仓库」 |
| 文案 | 动词开头、短句；危险操作二次确认保持现状 |

### 12.7 与全景图 / 高清放大的接口预留

本轮**不实现**，只预留位置与契约：

| 能力 | 入口位置 | 接入方式（后续） |
| --- | --- | --- |
| 全景图 | 左栏「生成」组 → 全景；或扩图浮条的「全景比例」 | 复用 `studio/panoramaPanel.js`；`payload.meta.panorama` 透传 |
| 高清放大 | 左栏「生成」组 → 放大；结果卡片增加「高清放大」 | 走 `/api/jobs` 放大任务，结果回流 `adoptResult()` |

实现前保持这些入口隐藏，避免出现点不动的按钮。

### 12.8 实施步骤（每步可独立验证、独立提交）

| 步骤 | 内容 | 改动文件 | 验收 |
| --- | --- | --- | --- |
| **S1** | 统一导入：新增 `importPicker.js`；顶栏「导入 ▾」；空状态加「从素材仓库」；画布拖拽多文件分流 | 新增 `studio/importPicker.js`；改 `studio.js`、`studio.css` | 主图可从本地/仓库/最近结果导入；拖 2 张图 = 1 主图 + 1 参考图 |
| **S2** | 参考图导入：AI 面板「添加参考图 ▾」三来源；参考图条支持文件与图库拖入；去重与上限 | 改 `aiPanel.js`、`studio.css`；复用 S1 模块 | 仓库多选 3 张、拖图进参考图条均成功；第 4 张被拦截 |
| **S3** | 富文本 @：新增 `promptEditor.js`；替换 textarea；@ 菜单、chip 原子删除、编号联动、拖图插入 | 新增 `studio/promptEditor.js`；改 `aiPanel.js`、`studio.css` | 输入 @ 弹菜单；chip 可整块删除；删参考图后 chip 同步；提交 payload 文本仍为 `@图二` |
| **S4** | 右栏重构：3 段控件 + 扩图上下文；蒙版参数浮条；AI「更多设置」折叠与摘要 | 改 `studio.js`、`aiPanel.js`、`studio.css` | 5 tab 变 3 段；蒙版参数跟随画笔；折叠摘要随设置更新 |
| **S5** | 左栏分组、顶栏导出菜单、视觉规范、空状态与响应式 | 改 `studio.js`、`studio.css` | 1440/1280/1024 宽度可用；无横向滚动；对比度达标 |
| **S6** | 未来入口占位（隐藏）、文档回写、全量回归 | 改 `PLAN_PS_FRONTEND.md`；必要时 `studio.js` | `pytest` 全绿（无后端改动）；浏览器冒烟通过 |

执行方式：一次只做一步，完成后在 8722 浏览器实测 → 记录到本文档 → 提交；等你确认再进入下一步。

### 12.9 冲突规避

- 不改 `web/assets/css/app.css`（同事未提交改动）。
- 不改 `web/src/components/edit.js`、`refLibrary.js`、`jobView.js`、`payload.js` 的既有契约；新能力全部走新文件 + `studio.js` / `aiPanel.js` / `studio.css` 的增量修改。
- 每步开工前先 `git status` 检查上述文件是否出现他人改动；若冲突，先停下同步。
- CSS 只追加新类（`pe-*`、`studio-import-*`、`studio-options-*`），不复用同名旧类的语义，避免影响文生图 / 编辑页。
- 不新增后端接口，不修改提交契约；富文本序列化后与现有 `@图N` 完全一致。

### 12.10 验收清单（全部通过才算完成）

- [ ] 主图：本地文件、素材仓库、最近结果、拖入、粘贴五种方式都能打开。
- [ ] 拖入多张：第一张主图，其余参考图；已有主图时全部进参考图。
- [ ] 参考图：仓库多选、本地多选、图库拖入、指令框拖入都能加入，上限 3 张。
- [ ] @：输入 `@` 出菜单；chip 视觉独立；Backspace 整块删除；删除参考图后 chip 与编号同步。
- [ ] 提交 payload：`images[0]` 是主图，参考图顺序与 chip 编号一致；`prompt` 中 `@图二` 正确映射为 `图2`。
- [ ] 右栏：3 段控件；蒙版参数只在画笔类工具出现；扩图面板只在扩图工具出现。
- [ ] AI 面板：默认只看到指令、参考图、修改；「更多设置」折叠/展开正常，摘要实时更新。
- [ ] 顶栏导入/导出菜单可键盘操作；危险操作有确认。
- [ ] 1440 / 1280 / 1024 三档无横向滚动，画布不变形。
- [ ] 控制台无报错；`python -m pytest tests` 保持全绿；文生图 / 图像编辑页面无回归。

---

## 13. 专业修图能力路线图（对标 Photoshop，v3 规划，未实施）

> 定位：浏览器内的专业修图，不追求 100% 复刻 PS，优先覆盖「调色、修肤、修复、局部处理、文字贴纸、图层」六类高频专业操作。
> 本轮只扩写方案，不动代码；实施顺序排在 §12 的 S1~S6 之后，从 S7 开始。

### 13.1 能力分层

| 优先级 | 能力 | 说明 |
| --- | --- | --- |
| **P0** | 图层系统、历史记录、选区增强、曲线/色阶/HSL、污点修复、仿制图章、涂抹、磨皮、马赛克/模糊、文字、贴纸 | 专业修图的基本盘，先做 |
| **P1** | 液化、局部调整（线性/径向/画笔蒙版）、混合模式、调整图层、图层样式、LUT、剪贴蒙版、图案图章 | 拉开与普通编辑器差距 |
| **P2** | AI 主体选择、内容识别填充、透视变换、路径文字、智能对象、分层导出 | 依赖模型/较大工程量 |
| **不做** | 3D、视频、完整 PSD 兼容、CMYK 印刷色彩管理 | 与产品定位无关 |

### 13.2 调色（专业级）

| 模块 | 能力 |
| --- | --- |
| 基础调整 | 曝光、对比度、高光、阴影、白色、黑色、清晰度、去朦胧、自然饱和度、饱和度 |
| 曲线 | RGB 复合 + 单通道（R/G/B）；控制点拖拽、吸管取点、删除点、重置；曲线预设保存 |
| 色阶 | 输入黑场/白场/灰点、输出黑场/白场、自动色阶 |
| HSL / 可选颜色 | 8 个色相带（红/橙/黄/绿/青/蓝/紫/洋红），每带色相/饱和度/明度 |
| 色彩平衡 | 阴影 / 中间调 / 高光 三段，青-红、洋红-绿、黄-蓝 |
| 白平衡 | 色温、色调、灰点吸管、自动白平衡 |
| 分离色调 | 高光/阴影分别上色与平衡 |
| LUT | 加载 `.cube`，强度可调，内置若干电影感预设 |
| 直方图 | 实时 RGB/亮度直方图，高光/阴影削波警告 |
| 局部调整 | 线性渐变、径向渐变、画笔蒙版；范围蒙版（按颜色/亮度）；每块独立参数 |
| 非破坏 | 所有调色以「调整图层」存在，可随时回改、显隐、加蒙版 |

### 13.3 修肤与修复

| 工具 | 能力 |
| --- | --- |
| 磨皮 | 频率分离（低频保色 + 高频保纹理）、表面模糊、双边滤波；强度/半径/阈值；AI 磨皮（保留毛孔质感） |
| 污点修复画笔 | 点涂自动取样周边修复；硬度/大小/不透明度 |
| 修复画笔 | Alt 取样 + 画笔修复，支持对齐/非对齐 |
| 仿制图章 | Alt 取样、对齐、连续采样；大小/硬度/不透明度/流量 |
| 红眼 / 牙齿美白 | 局部去红、提亮去黄 |
| 液化 | 向前变形、膨胀、收缩、左推、重建；画笔大小/压力；可冻结保护区域 |
| 涂抹 | 按拖动方向推色，强度/大小/笔刷；适合头发、烟雾、水面 |

### 13.4 特效

- 马赛克：像素块大小、局部马赛克、马赛克笔刷。
- 模糊：高斯、动感、径向、镜头、移轴；支持局部蒙版。
- 风格化：噪点、胶片颗粒、锐化（USM）、色差、暗角。
- 内容识别填充：框选后 AI 消除（接现有编辑管线，P2）。
- 智能超分：结果卡片「高清放大」（等 VOSR2 接入，见 §14）。

### 13.5 文字、贴纸、印章

| 类型 | 能力 |
| --- | --- |
| 文字图层 | 字体/字号/字重/行距/字距/对齐/颜色；描边、投影、背景块；自由缩放旋转；双击原位编辑；弯曲文字（P2） |
| 贴纸 | 内置分类贴纸库 + 导入 PNG/SVG/WebP；缩放/旋转/翻转；不透明度与混合模式；可另存为素材 |
| 印章 | 仿制图章（见 §13.3）、图案图章（P2）、自定义印章图案 |
| 形状 | 矩形/椭圆/直线/箭头/多边形；填充/描边/圆角（P1） |

### 13.6 图层系统

- 图层类型：像素层、文字层、贴纸/图片层、调整层、填充层、组。
- 操作：新建、复制、删除、重命名、拖拽排序、显隐、锁定（位置/像素/透明）、不透明度、混合模式。
- 混合模式首版：正常、正片叠底、滤色、叠加、柔光、强光、颜色减淡、颜色加深、差值。
- 蒙版：图层蒙版、剪贴蒙版（P1）、矢量蒙版（P2）。
- 图层样式（P1）：描边、内/外阴影、外发光、渐变叠加、颜色叠加。
- 变换：自由变换、旋转、翻转、透视变形（P2）；对齐/分布（P1）。
- 历史记录：≥100 步、快照、点击回退；支持撤销/重做快捷键。
- 性能：分层离屏 Canvas 缓存、脏矩形重绘、预览降采样；大图（4K+）分块处理，必要时 WebGL 滤镜（P1）。

### 13.7 选区与路径

- 基础选区：矩形、椭圆、套索、多边形套索、磁性套索（P1）。
- 智能选区：魔棒（容差/连续/取样合并）、快速选择、色彩范围、主体选择（AI，P2）。
- 选区运算：新建/加选/减选/交集；羽化、扩展/收缩、平滑、反选、变换选区。
- 路径：钢笔/贝塞尔路径、路径转选区（P2）。

### 13.8 架构调整（实施前提）

`studio.js` 目前是单文件大组件，继续叠加专业能力会失控。P0 实施前先做内部拆分，界面行为不变：

| 新模块 | 职责 |
| --- | --- |
| `studio/document.js` | 文档模型：尺寸、图层树、活动图层、脏标记 |
| `studio/layers.js` | 图层增删改排、混合、蒙版合成 |
| `studio/history.js` | 命令栈、快照、撤销/重做 |
| `studio/renderer.js` | 分层合成、缩放显示、脏矩形重绘 |
| `studio/tools/brush.js` 等 | 画笔、橡皮、仿制图章、涂抹、液化、文字、贴纸等工具 |
| `studio/panels/layers.js`、`adjust.js`、`text.js` | 对应右侧面板 |

数据与导出：

- 工程数据保存为 JSON（图层 + 调整参数 + 蒙版）到 IndexedDB，支持自动保存与恢复。
- 导出默认拼合 PNG/JPG；P2 再评估「导出分层 ZIP」。
- 与 AI 修改共存：AI 修改结果作为新像素层落地，保留原图层，可对比。

### 13.9 分阶段实施（接 §12 的 S1~S6 之后）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **S7** | 文档/图层/历史内核拆分；图层面板（新建/复制/删除/排序/显隐/不透明度）；撤销重做 | 10 图层内拖拽 60fps；100 步历史可回退 |
| **S8** | 选区增强：魔棒、反选、羽化、扩展/收缩；图层蒙版；选区与画笔联动 | 选区边缘可羽化；蒙版可擦除/恢复 |
| **S9** | 调色面板：曲线、色阶、HSL、色彩平衡、白平衡、直方图；调整图层 | 调整可回改、可显隐、可加蒙版；导出与预览一致 |
| **S10** | 修复套件：污点修复、仿制图章、涂沫、磨皮（频率分离/双边）、液化 | 人像磨皮保留纹理；仿制图章对齐取样正确 |
| **S11** | 马赛克/模糊、文字图层、贴纸、印章 | 文字可编辑换字体；贴纸可缩放旋转；局部马赛克自然 |
| **S12** | 混合模式、剪贴蒙版、图层样式、LUT、历史快照 | 与 PS 常用混合结果肉眼一致；性能不退化 |
| **S13** | AI 主体选择、内容识别填充、透视变换、路径文字、分层导出 | 依赖后端能力，单独评估 |

每阶段完成即浏览器实测 → 回写本文档 → 提交；不一次性铺开。

### 13.10 与现有代码的边界

- 不改 `edit.js`、`refLibrary.js`、`payload.js`、`jobView.js` 的既有契约。
- 不碰 `web/assets/css/app.css`（当前仅换行符差异，无实际内容改动，但仍视为公共文件）。
- 新增能力全部落在 `web/src/components/studio/` 新模块 + `studio.css` 增量类；`studio.js` 只做装配。
- 专业修图是纯前端能力，不新增后端接口；AI 相关（消除/超分/主体选择）走已有 `/api/edit`、`/api/jobs`。

---

## 14. 工程实施总纲（S0~S15 详细落地计划）

> 本文把 §12（工作室打磨 S1~S6）和 §13（专业修图 S7~S13）合并成一条可执行流水线，并补上全景 / 高清放大的接入位（S14~S15）。
> 原则：**一次只做一个交付项，完成一项提交一项，提交后立刻回写本文档台账。**
> 当前状态：全部未开始，等通知后从 S0 启动。

### 14.1 里程碑与依赖

| 里程碑 | 范围 | 交付项 | 前置 | 出口标准 |
| --- | --- | --- | --- | --- |
| **M0 预检** | 环境、开关、基线 | D0.1~D0.2 | 无 | 基线截图、pytest 全绿、开关可关闭新 UI |
| **M0.5 会话持久化** | IndexedDB 工程/草稿、自动保存、刷新与重开恢复 | D17.1~D17.3 | M0 | 刷新自动恢复；关闭浏览器后可恢复；配额与多标签可控 |
| **M1 基础体验** | 导入、参考图、富文本 @、右栏、视觉、裁剪性能 | D1.1~D6.1、D5.3 | M0.5 | §12.10 验收清单全过；裁剪拖动不卡 |
| **M1B AI 回退与对比** | 本次任务 AI 编辑历史卡片、图片对比 | D16.1~D16.2 | M1 | 历史可回退；竖线对比复用编辑模块 |
| **M1C 全站交互性能** | 工作室平移/缩放/画笔/移动/调色滑杆，图像工具裁剪、蒙版编辑器 | D18.1~D18.4 | M1、D5.3 | 4K 图各交互 <16ms；无内存暴涨 |
| **M1D 稳定性与健壮性** | 状态一致性、任务上下文、输入上限、编码主线程、事件生命周期、兼容降级 | D19.1~D19.6 | M1、M1B、M1C | §18 全部 P0/P1 修复并通过复现用例；无新增回归 |
| **M2 图层内核** | 文档 / 图层 / 历史 / 合成 | D7.1~D7.4 | M1C、M1D | 10 层 60fps，100 步历史 |
| **M3 选区与调色** | 选区增强、蒙版、专业调色 | D8.1~D9.4 | M2 | 调整可回改、可蒙版、导出与预览一致 |
| **M4 修复与创作** | 修复、磨皮、液化、马赛克、文字、贴纸 | D10.1~D11.4 | M3 | 人像/去物/文字三类样片通过 |
| **M5 进阶** | 混合模式、图层样式、LUT、快照、AI 项 | D12.1~D13.3 | M4 | 与 PS 常用效果肉眼一致；AI 项单独验收 |
| **M6 能力接入** | 全景图、高清放大 | D14.1~D15.1 | 后端就绪 | 结果可回流图层 |

依赖说明：

- S7 的文档 / 历史内核是 S8~S13 的地基，必须先做。
- M1B（AI 历史与对比）只依赖现有 AI 结果与 `compare.js`，可紧跟 M1 完成，不阻塞图层内核。
- M1D 中 D19.1 / D19.2 处理 P0 错误输出，M1 完成后即可开工；D19.3~D19.6 可在 M1C 之后收口，先于 M2。
- 选区（S8）先于调色（S9），因为局部调整和调整层蒙版都依赖选区。
- 文字 / 贴纸（S11）依赖图层（S7），不依赖修复（S10）。
- 全景 / 放大（S14/S15）等后端：全景看 `PLAN_PANORAMA.md`，放大看 VOSR2（当前有未提交改动，勿碰）。

### 14.2 M0 预检（D0）

| 项 | 内容 |
| --- | --- |
| 工作区快照 | 开工前 `git status` 记录他人未提交文件：`server/upscalers/*`、`config.py`、`main.py`、`imageTools.js`、`settings.js`、`i18n.js`；实施期间不碰 |
| 基线 | 8722 打开文生图 / 图像编辑 / 图片精修，各存一张截图与 console 日志到 `.cache/shots/` |
| 测试基线 | `python -m pytest tests -q` 全绿；记录数量（当前 419） |
| Node 测试 | 确认 `node -v`；若 ≥ 18，用内置 `node --test` 跑纯函数测试，不引入依赖 |
| 开关 | `studio/flags.js` 导出 `studioV2`，默认 `true`，`localStorage.wb.studio.v2='0'` 可回退旧面板 |
| 浏览器 | 以 Chrome/Edge 为主；Safari 仅在 M1 后抽检，不阻塞 |

### 14.3 模块蓝图

新增目录 `web/src/components/studio/`（已存在 `aiPanel.js` 等）：

| 模块 | 对外 API | 依赖 | 步骤 |
| --- | --- | --- | --- |
| `flags.js` | `isEnabled(name)` | 无 | D0 |
| `importPicker.js` | `openImportPicker(opts)`、`filesFromDataTransfer(dt)`、`readImageFile(file)`、`urlToDataUrl(url)`、`REF_MIME` | `api.js` | D1/D2 |
| `promptEditor.js` | `createPromptEditor(host, opts)` → `getText/setText/syncRefs/insertMention/focus/clear` | 无 | D3 |
| `document.js` | `createDocument()`、`addLayer/removeLayer/moveLayer/cloneLayer`、`docToJSON/fromJSON` | 无 | D7 |
| `layers.js` | `createLayer(type, props)`、`composite(doc, opts)` | `renderer` | D7 |
| `history.js` | `createHistory(limit)` → `push/undo/redo/jump/snapshot` | 无 | D7 |
| `renderer.js` | `render(doc, viewport)`、`renderLayer(layer)`、`dirty(rect)` | `layers` | D7 |
| `selection.js` | `rectSelect/ellipseSelect/lassoSelect/wandSelect`、`feather/expand/invert`、`toMask()` | 无 | D8 |
| `color.js` | 曲线 LUT、色阶、HSL、色彩平衡、白平衡、LUT、直方图（纯函数） | 无 | D9 |
| `adjustments.js` | `applyAdjustment(imageData, params)`、调整层合成 | `color` | D9 |
| `tools/brush.js` | 画笔 / 橡皮 / 蒙版画笔 | `renderer` | D8 |
| `tools/clone.js` | 仿制图章 / 修复画笔 | `renderer` | D10 |
| `tools/smudge.js` | 涂抹 | `renderer` | D10 |
| `tools/liquify.js` | 液化网格形变 | `renderer` | D10 |
| `tools/mosaic.js` | 马赛克 / 局部模糊 | `renderer` | D11 |
| `tools/text.js` | 文字图层创建与编辑 | `renderer` | D11 |
| `tools/sticker.js` | 贴纸 / 图片层变换 | `renderer` | D11 |
| `panels/layers.js` | 图层面板 | `document/layers` | D7 |
| `panels/adjust.js` | 调色面板 | `color/adjustments` | D9 |
| `panels/history.js` | 历史记录面板 | `history` | D7/D12 |
| `sessionHistory.js` | 本次任务 AI 编辑历史：增删、缩略图、持久化、回退 | `io` | D16.1 |
| `persistence.js` | IndexedDB 工程/草稿、自动保存、恢复、配额与多标签锁 | `document/io` | D17.1~D17.3 |
| `perf.js` | 帧耗时探针、渲染次数统计、4K 基准数据 | 无 | D18.1 |
| `panels/recovery.js` | 恢复横幅、最近工程列表 | `persistence` | D17.2 |
| `panels/aiHistory.js` | AI 编辑历史卡片区 | `sessionHistory` | D16.1 |
| `compareLauncher.js` | 组装对比数据并调用 `openCompareDialog` | `compare.js` | D16.2 |
| `io.js` | IndexedDB 自动保存、项目导入导出、图片导出 | `document` | D7 |

`studio.js` 只保留装配：工具切换、画布事件、面板挂载；不再新增业务算法。

### 14.4 数据模型

```js
// document.js
{
  id, name, width, height,          // 文档像素尺寸，sRGB
  layers: [Layer],                  // 数组顺序 = 从下到上
  activeLayerId,
  selection: Selection | null,
  viewport: { zoom, panX, panY },
  dirty: boolean,
  meta: { origin: 'local'|'warehouse'|'history'|'ai', refs: [] }
}

// Layer
{
  id, type: 'pixel'|'text'|'sticker'|'adjust'|'fill'|'group',
  name, visible, opacity, blend,    // blend 见 13.6
  locked: { pixels: false, position: false, alpha: false },
  parentId: null,                   // 组用
  bitmap: HTMLCanvasElement|null,   // 像素层 / 贴纸栅格缓存
  mask: HTMLCanvasElement|null,     // 灰度蒙版
  transform: { x, y, scaleX, scaleY, rotation },
  text: { content, font, size, weight, lineHeight, letterSpacing, align, color, stroke, shadow },
  sticker: { src, naturalWidth, naturalHeight },
  adjust: { kind: 'curves'|'levels'|'hsl'|'balance'|'white'|'lut', params, lutId },
  clipping: false,
  style: { stroke, shadow, glow, gradient } // P1
}

// Selection
{ path: Path2D, bounds: {x,y,w,h}, feather: 0, mode: 'new'|'add'|'sub'|'intersect' }

// History
{ stack: [Command], index, limit: 100, snapshots: [{ id, label, at, doc }] }
// Command: { label, mergeKey?, undo(), redo() }
```

持久化：

- IndexedDB 库 `wb-studio`，表 `projects`：`{ id, name, updatedAt, width, height, layers: [{...,blob|dataUrl}], selection }`。
- 自动保存：停止操作 5s 后写入；同一项目只保留最近 5 个版本。
- 工程文件：`.wbstudio.json`（图层图片以 dataURL 内嵌），用于导入导出；大文件提示。

### 14.5 渲染管线

1. **坐标**：文档像素坐标为唯一真值；`viewport` 负责屏幕映射，画笔半径按文档像素存储、按缩放显示。
2. **合成**：自下而上逐层绘制到主离屏 Canvas：
   - 普通层：`drawImage`；
   - 蒙版：临时 Canvas 上先画图层，再 `destination-in` 画蒙版；
   - 调整层：对下方已合成结果做一次像素处理，再按蒙版回贴；
   - 组：递归合成到组离屏 Canvas，再按组不透明度/混合模式贴回；
   - 混合模式映射到 `globalCompositeOperation`（正片叠底 `multiply`、滤色 `screen`、叠加 `overlay`、柔光 `soft-light` 等）。
3. **性能**：
   - 预览只渲染视口内区域，`renderScale = min(1, 视口宽/文档宽)`；
   - 图层位图缓存 + 脏矩形；画笔绘制只重绘当前层局部；
   - 缩略图 64px，200ms 节流；
   - 4K 文档限制 12 层，超出提示；内存超 1.5GB 时降级预览。
4. **颜色**：只处理 sRGB；不做 ICC/CMYK（与 §13.1 一致）。
5. **导出**：全分辨率合成 → `toBlob`；PNG 无损、JPG 质量 0.92；导出前可选拼合/包含蒙版。

### 14.6 关键算法实现

| 能力 | 实现要点 |
| --- | --- |
| 曲线 | 控制点 → 单调三次插值 → 256 项 LUT；R/G/B 与 RGB 复合分别生成 LUT，渲染时查表 |
| 色阶 | 输入黑/白/灰点归一化 → 线性映射 + gamma；输出区间映射 |
| HSL | RGB↔HSL；8 个色相带按色相距离加权（约 40° 过渡）；每带 H/S/L 偏移后混合回原值 |
| 色彩平衡 | 用亮度分区权重（阴影/中间调/高光）分别施加三组偏移，保持总亮度 |
| 白平衡 | 色温/色调转 RGB 增益（近似 Tanner Helland），灰点吸管取中性色反推增益 |
| LUT | 解析 `.cube` 的 `LUT_3D_SIZE` 与数据；三线性插值；强度按原图/结果混合 |
| 直方图 | 抽样步长 `max(1, floor(pixels/200000))`；256 桶；120ms 节流；统计削波像素占比 |
| 模糊 | Stack Blur（O(n)）近似高斯；动感/径向用方向采样；预览降采样 |
| 频率分离 | 低频 = 半径 8~20 模糊；高频 = 原图 + 128 − 低频；线性光混合，纹理强度单独控制 |
| 双边滤波 | 5×5/9×9 核，空间 σ 与颜色 σ 可调；4K 预览先降采样 |
| 污点修复 | 以笔刷为中心环形采样候选块，按梯度差选最优，羽化回贴 |
| 仿制图章 | `sourceOffset = 首次落笔 - Alt 取样点`；对齐模式固定偏移，非对齐每次重取；按笔刷 alpha 累积 |
| 涂抹 | 每笔蘸取笔刷范围像素作为 pickup，按强度与拖动方向混合到目标 |
| 液化 | 16/32px 网格位移场；笔刷按半径与压力累加位移；双线性重采样；冻结区不更新；pointerup 提交历史 |
| 马赛克 | 按块取平均色回填；局部马赛克通过笔刷蒙版控制强度 |
| 选区 | 魔棒 = 容差洪泛填充；羽化 = 对蒙版做模糊；扩展/收缩 = 形态学膨胀/腐蚀；反选 = 蒙版取反 |
| 文字 | `measureText` 逐字计算字距；`letterSpacing` 原生支持则优先；描边 `strokeText`、阴影 `shadowBlur`；编辑用叠加 DOM 输入框，提交后栅格化 |
| 贴纸 | 图片/SVG 转位图缓存；八向手柄缩放、旋转吸附 15°、Shift 等比 |

### 14.7 交互与状态

- **工具状态机**：`idle → hover → drawing → committing`；`pointerup` 才写入历史，拖拽过程只改临时层。
- **历史粒度**：一次完整笔画 / 一次面板提交 / 一次图层操作为一条命令；滑块拖动用 `mergeKey` 合并为一条。
- **快捷键**：V 抓手、B 画笔、E 橡皮、L 套索、W 魔棒、C 裁剪、T 文字、S 仿制图章、R 涂抹、X 液化、M 矩形、O 椭圆、Space 临时平移、`[`/`]` 笔刷大小、Ctrl/Cmd+Z 撤销、Shift+Ctrl/Cmd+Z 重做、Ctrl/Cmd+Enter 提交 AI 修改。
- **画布手势**：滚轮以光标为中心缩放；Space 拖拽平移；触屏双指缩放/平移；缩放 5%~800%。
- **自动保存**：空闲 5s 写 IndexedDB；崩溃后进入工作室提示恢复。
- **可访问性**：所有图标按钮有 `aria-label`；面板可 Tab 到达；动效遵守 `prefers-reduced-motion`。

### 14.8 交付项与提交粒度

> 每个交付项 = 1 次提交 = 1 次文档台账更新。提交前先跑该交付项的验证。

#### M0

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D0.1 | 预检与基线 | 无代码 | 截图、console、pytest 数量记录 |
| D0.2 | 功能开关 | 新增 `studio/flags.js`；`studio.js` 读取 | 关闭开关恢复旧面板 |

#### M0.5 会话持久化

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D17.1 | IndexedDB 存储层 + 自动保存 | 新增 `persistence.js`；`studio.js`、`studioDoc.js` | 图层/蒙版/参考图/指令自动落库；4K 三层保存 <500ms |
| D17.2 | 恢复流程与横幅 | 新增 `panels/recovery.js`；`studio.js`、`studio.css` | 刷新自动恢复；关闭后重开可「恢复上次」 |
| D17.3 | 配额、清理与多标签 | `persistence.js`、设置页「关于」 | 配额告警；旧工程清理；双标签不互相覆盖 |

#### M1 基础体验（§12）

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D1.1 | 导入选择器 | 新增 `importPicker.js` | 本地/仓库/最近结果三来源可取图 |
| D1.2 | 主图导入入口与拖拽矩阵 | `studio.js`、`studio.css` | 顶栏「导入 ▾」；拖 2 张 = 1 主图 + 1 参考图 |
| D1.3 | 空状态素材仓库入口 | `studio.js`、`studio.css` | 空画布两个按钮都可用 |
| D2.1 | 参考图三来源 | `aiPanel.js`、`studio.css` | 本地/仓库/最近结果多选，上限 3 |
| D2.2 | 参考图拖拽与去重 | `aiPanel.js`、`studio.css` | 文件/图库缩略图可拖入；重复图被忽略 |
| D3.1 | 富文本编辑器内核 | 新增 `promptEditor.js` | chip 原子删除、序列化 `@图二`、IME 正常 |
| D3.2 | @ 菜单与编号联动 | `aiPanel.js`、`studio.css` | 输入 @ 出菜单；删参考图 chip 同步 |
| D4.1 | 右栏 3 段 + 扩图上下文 | `studio.js`、`studio.css` | 5 tab 变 3；扩图只在工具激活时出现 |
| D4.2 | 蒙版工具浮条 | `studio.js`、`studio.css` | 画笔参数跟随工具；蒙版功能不回归 |
| D4.3 | AI「更多设置」折叠 | `aiPanel.js`、`studio.css` | 默认只显示指令/参考图/修改；摘要实时更新 |
| D5.1 | 左栏分组 + 顶栏导入/导出菜单 | `studio.js`、`studio.css` | 工具分组正确；导出项齐全 |
| D5.2 | 视觉规范与响应式 | `studio.css` | 1440/1280/1024 无横向滚动 |
| D5.3 | 裁剪性能优化 | `studio.js`、`studio.css` | 4K 图裁剪拖动 <16ms/帧；选框不闪 |
| D6.1 | M1 回归与文档 | 本文档 | §12.10 全过；pytest 全绿 |

#### M1B AI 回退与对比

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D16.1 | 本次任务 AI 编辑历史卡片 | 新增 `sessionHistory.js`、`panels/aiHistory.js`；`aiPanel.js`、`studio.css` | 每次 AI 成功生成一张卡片；点击可回退；刷新后仍在 |
| D16.2 | 图片对比（复用竖线对比） | 新增 `compareLauncher.js`；`studio.js`、`aiPanel.js` | 可选参考图/历史图与当前主图对比；竖线拖动流畅 |

#### M1C 全站交互性能

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D18.1 | 性能探针与基线 | 新增 `perf.js`；`studio.js`、`imageTools.js` 接入 | 4K 图各交互有帧耗时与渲染次数数据 |
| D18.2 | 工作室交互优化 | `studio.js`、`studio.css`、`studioDoc.js` | 平移/缩放/画笔/移动/调色滑杆均 <16ms/帧 |
| D18.3 | 图像工具与蒙版编辑器优化 | `imageTools.js`、`maskEditor.js` | 裁剪拖动不重复应用全量操作；蒙版绘制流畅 |
| D18.4 | 性能回归基准 | `perf.js`、本文档 | 形成 4K 基准表，后续里程碑可对比 |

#### M1D 稳定性与健壮性（§18）

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D19.1 | 数据与输出一致性 | `studioDoc.js`、`studio.js` | S-01~S-04：旋转/重置/不透明度可撤销；预览态导出有拦截或正确输出 |
| D19.2 | AI 任务上下文 | `aiPanel.js`、`studio.js` | S-05~S-08：无悬空 `@`；换图清 refs/prompt；任务类型记录正确 |
| D19.3 | 输入健壮性 | `studio.js`、`aiPanel.js` | S-09~S-13：超限拒绝；并发不串图；外链可导出；预览不变形 |
| D19.4 | 编码与内存 | `studioDoc.js`、`studio.js`、`aiPanel.js` | S-14~S-19：单笔蒙版 <50ms；4K 导出不冻结；20 步历史 <256MB |
| D19.5 | 事件与生命周期 | `studio.js` | S-21~S-24：进出 10 次无监听器增长；编辑框内不误触；收藏失败可重试 |
| D19.6 | 兼容与降级 | `studioDoc.js`、`studio.js` | S-25：`ctx.filter` 缺失时有降级或禁用提示 |

#### M2 图层内核

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D7.1 | 文档模型 + 图层创建 | 新增 `document.js`、`layers.js` | 新建/删除/复制/排序正确 |
| D7.2 | 合成渲染器 | 新增 `renderer.js`；`studio.js` 接画布 | 多图层叠加、透明度、显隐正确 |
| D7.3 | 图层面板 | 新增 `panels/layers.js`、`studio.css` | 拖拽排序、重命名、锁定、不透明度 |
| D7.4 | 历史记录 + 快捷键 | 新增 `history.js`；`studio.js` | 100 步回退；撤销重做覆盖图层与画笔 |

#### M3 选区与调色

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D8.1 | 选区核心 | 新增 `selection.js`、`tools/brush.js` | 魔棒/反选/羽化/扩展收缩；选区可显示蚂蚁线 |
| D8.2 | 图层蒙版 | `layers.js`、`panels/layers.js` | 蒙版可画可擦；与选区联动 |
| D9.1 | 调色数学库 | 新增 `color.js` | 曲线/色阶/HSL/平衡/白平衡单测（node --test） |
| D9.2 | 直方图 + LUT | `color.js`、`panels/adjust.js` | 直方图实时；.cube 加载正确 |
| D9.3 | 调整图层 | 新增 `adjustments.js`、`panels/adjust.js` | 可回改/显隐/加蒙版；导出与预览一致 |
| D9.4 | 局部调整（P1） | `selection.js`、`panels/adjust.js` | 线性/径向/画笔局部生效 |

#### M4 修复与创作

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D10.1 | 污点修复 | 新增 `tools/clone.js`（spot 模式） | 去痘/去小物体自然 |
| D10.2 | 仿制图章 / 修复画笔 | `tools/clone.js` | Alt 取样、对齐/非对齐正确 |
| D10.3 | 涂抹 | 新增 `tools/smudge.js` | 头发/水面方向感自然 |
| D10.4 | 磨皮 | 新增 `tools/skin.js`（或并入 clone） | 频率分离保留纹理 |
| D10.5 | 液化 | 新增 `tools/liquify.js` | 膨胀/收缩/左推可重建 |
| D11.1 | 马赛克 / 模糊 | 新增 `tools/mosaic.js` | 局部马赛克边缘自然 |
| D11.2 | 文字图层 | 新增 `tools/text.js`、`panels/text.js` | 可编辑换字体/描边/投影 |
| D11.3 | 贴纸 | 新增 `tools/sticker.js` | 导入/缩放/旋转/混合模式 |
| D11.4 | 形状与图案图章（P1） | `tools/sticker.js`、`tools/clone.js` | 形状可调填充描边 |

#### M5 进阶

| 编号 | 交付项 | 改动 | 验证 |
| --- | --- | --- | --- |
| D12.1 | 混合模式 + 剪贴蒙版 | `layers.js`、`panels/layers.js` | 与 PS 常用模式肉眼一致 |
| D12.2 | 图层样式 | `layers.js`、`panels/layers.js` | 描边/阴影/发光/渐变叠加 |
| D12.3 | 历史快照 | `history.js`、`panels/history.js` | 快照可命名、可回跳 |
| D13.1 | AI 主体选择（P2） | `selection.js` + 后端 | 需后端能力，单独评估 |
| D13.2 | 内容识别填充（P2） | `tools/clone.js` + `/api/edit` | 框选消除结果自然 |
| D13.3 | 透视变换 / 路径文字（P2） | `tools/sticker.js`、`tools/text.js` | 不阻塞主线 |

#### M6 能力接入

| 编号 | 交付项 | 前置 | 验证 |
| --- | --- | --- | --- |
| D14.1 | 全景图入口 | `PLAN_PANORAMA.md` 后端就绪 | 全景结果可作为新图层/新文档 |
| D15.1 | 高清放大入口 | VOSR2 后端提交并稳定 | 结果卡片可放大回流 |

### 14.9 测试策略

| 层级 | 方式 | 覆盖 |
| --- | --- | --- |
| 纯函数 | `node --test web/tests/studio/*.test.mjs`（Node ≥18，无依赖） | 曲线/色阶/HSL/LUT、富文本序列化、选区数学、坐标变换 |
| 浏览器冒烟 | Playwright（Chrome） | 导入矩阵、@ 引用、3 段切换、图层排序、调色回改、导出 |
| 视觉基线 | `.cache/shots/` 截图对比 | 面板布局、空状态、调色前后 |
| 性能 | 2048² × 8 层拖滑块 ≥30fps；4K 单层可编辑 | 渲染管线 |
| 回归 | `python -m pytest tests -q` | 后端零改动，必须保持全绿 |
| 可访问性 | 键盘走查 + 对比度检查 | 主要流程 |
| 稳定性回归 | Playwright + 手工复现用例 | §18：旋转/重置/调透明度、删参考图、换图、大图、外链图、反复进出工作室 |

若 Node 不可用，纯函数测试降级为浏览器内 `console.assert` 脚本，不阻塞交付，但需要在台账注明。

### 14.10 风险与回滚

| 风险 | 处理 |
| --- | --- |
| contenteditable 兼容性 | 只支持 Chrome/Edge 主路径；序列化兜底 trim；异常时回退 textarea（flags 开关） |
| 大图内存爆炸 | 限制 12 层；预览降采样；超出提示并禁止新增像素层 |
| 调整层性能 | 预览用低分辨率 + 节流；提交时全分辨率一次性处理 |
| LUT 文件格式差异 | 只支持标准 `.cube`；解析失败 toast 并回退 |
| 字体版权 | 只列系统字体 + 明确标注可商用字体；不内置商业字体 |
| 与同事改动冲突 | 开工前检查 `git status`；不碰 `app.css`、`edit.js`、`refLibrary.js`、`payload.js`、`jobView.js`；发现同文件改动先停 |
| 新面板异常 | `flags.js` 可关闭 studioV2，回退旧面板 |
| 单项提交出错 | 只 revert 当前提交；历史/图层不影响已提交的 M1 |

### 14.11 提交与文档维护规范

1. 一个交付项（D 编号）完成 → 先自测 → 再提交，提交信息中文，前缀 `feat(studio):` / `fix(studio):` / `docs(studio):`。
2. 只 `git add` 本交付项涉及的文件；绝不提交 `web/assets/css/app.css`、他人未提交文件、`.cache/`、测试截图。
3. 提交后立刻在 §14.12 台账写入：状态、日期、commit、验证结论、遗留问题。
4. 每个里程碑结束追加一次冒烟截图与性能数据。
5. 若中途被打断，台账的「当前进行中」列必须指向唯一的 D 编号。

### 14.12 进度台账

| 编号 | 交付项 | 状态 | 提交 | 备注 |
| --- | --- | --- | --- | --- |
| D0.1 | 预检与基线 | 未开始 | — | — |
| D0.2 | 功能开关 | 未开始 | — | — |
| D17.1 | IndexedDB 存储 + 自动保存 | 未开始 | — | 方案 §16 |
| D17.2 | 恢复流程与横幅 | 未开始 | — | 方案 §16 |
| D17.3 | 配额、清理与多标签 | 未开始 | — | 方案 §16 |
| D1.1 | 导入选择器 | 未开始 | — | — |
| D1.2 | 主图导入入口与拖拽 | 未开始 | — | — |
| D1.3 | 空状态素材仓库入口 | 未开始 | — | — |
| D2.1 | 参考图三来源 | 未开始 | — | — |
| D2.2 | 参考图拖拽与去重 | 未开始 | — | — |
| D3.1 | 富文本编辑器内核 | 未开始 | — | — |
| D3.2 | @ 菜单与编号联动 | 未开始 | — | — |
| D4.1 | 右栏 3 段 + 扩图上下文 | 未开始 | — | — |
| D4.2 | 蒙版工具浮条 | 未开始 | — | — |
| D4.3 | AI 更多设置折叠 | 未开始 | — | — |
| D5.1 | 左栏分组 + 顶栏菜单 | 未开始 | — | — |
| D5.2 | 视觉规范与响应式 | 未开始 | — | — |
| D5.3 | 裁剪性能优化 | 未开始 | — | 含卡顿根因与优化方案 §15.1 |
| D6.1 | M1 回归与文档 | 未开始 | — | — |
| D16.1 | AI 编辑历史卡片 | 未开始 | — | 方案 §15.2 |
| D16.2 | 图片对比 | 未开始 | — | 复用 `compare.js`，方案 §15.3 |
| D18.1 | 性能探针与基线 | 未开始 | — | 排查见 §17 |
| D18.2 | 工作室交互优化 | 未开始 | — | 排查见 §17 |
| D18.3 | 图像工具与蒙版优化 | 未开始 | — | 需与 `imageTools.js` 当前 WIP 协调 |
| D18.4 | 性能回归基准 | 未开始 | — | — |
| D19.1 | 数据与输出一致性 | 未开始 | — | §18 S-01~S-04 |
| D19.2 | AI 任务上下文 | 未开始 | — | §18 S-05~S-08 |
| D19.3 | 输入健壮性 | 未开始 | — | §18 S-09~S-13 |
| D19.4 | 编码与内存 | 未开始 | — | §18 S-14~S-19 |
| D19.5 | 事件与生命周期 | 未开始 | — | §18 S-21~S-24 |
| D19.6 | 兼容与降级 | 未开始 | — | §18 S-25 |
| D7.1 | 文档模型 + 图层创建 | 未开始 | — | — |
| D7.2 | 合成渲染器 | 未开始 | — | — |
| D7.3 | 图层面板 | 未开始 | — | — |
| D7.4 | 历史记录 + 快捷键 | 未开始 | — | — |
| D8.1 | 选区核心 | 未开始 | — | — |
| D8.2 | 图层蒙版 | 未开始 | — | — |
| D9.1 | 调色数学库 | 未开始 | — | — |
| D9.2 | 直方图 + LUT | 未开始 | — | — |
| D9.3 | 调整图层 | 未开始 | — | — |
| D9.4 | 局部调整 | 未开始 | — | — |
| D10.1 | 污点修复 | 未开始 | — | — |
| D10.2 | 仿制图章 / 修复画笔 | 未开始 | — | — |
| D10.3 | 涂抹 | 未开始 | — | — |
| D10.4 | 磨皮 | 未开始 | — | — |
| D10.5 | 液化 | 未开始 | — | — |
| D11.1 | 马赛克 / 模糊 | 未开始 | — | — |
| D11.2 | 文字图层 | 未开始 | — | — |
| D11.3 | 贴纸 | 未开始 | — | — |
| D11.4 | 形状与图案图章 | 未开始 | — | — |
| D12.1 | 混合模式 + 剪贴蒙版 | 未开始 | — | — |
| D12.2 | 图层样式 | 未开始 | — | — |
| D12.3 | 历史快照 | 未开始 | — | — |
| D13.1 | AI 主体选择 | 未开始 | — | 待后端 |
| D13.2 | 内容识别填充 | 未开始 | — | 待后端 |
| D13.3 | 透视变换 / 路径文字 | 未开始 | — | — |
| D14.1 | 全景图入口 | 未开始 | — | 待全景后端 |
| D15.1 | 高清放大入口 | 未开始 | — | 待 VOSR2 提交 |

### 14.13 启动顺序（等通知后）

1. D0.1 预检 → D0.2 开关 → D17.1 存储层 → D17.2 恢复流程 → D17.3 配额与多标签。
2. 按 D1.1 → D1.2 → … → D6.1 完成 M1，每项提交一次。
3. M1 后依次 D16.1 → D16.2 → D18.1 → D18.2 → D18.3 → D18.4；D18.3 动 `imageTools.js` 前先确认同事 WIP 已提交。
4. M1B 完成后即可并行启动 D19.1 → D19.2；M1C 后收口 D19.3 → D19.4 → D19.5 → D19.6。
5. M1C 与 M1D 验收通过后再进 D7.1；之后按里程碑顺序推进。
6. D14/D15 只在对应后端合入后启动。

---

## 15. 裁剪性能、AI 编辑历史与图片对比（补充方案）

> 对应交付项：D5.3（裁剪性能）、D16.1（AI 编辑历史）、D16.2（图片对比）。
> 本轮只写方案，不改代码。

### 15.1 裁剪卡顿：根因与优化（D5.3）

#### 现状与根因

当前裁剪交互（`studio.js`）：

- `pointermove` → `scheduleDraw()` → `draw()`；
- `draw()` 每帧执行：清空整块画布 → `drawImage` 整张底图（4K 原尺寸缩放绘制）→ 带 `shadowBlur: 26 / shadowOffsetY: 10` → 再画蒙版染色与裁剪遮罩；
- 裁剪选框、遮罩、网格全部画在同一张 Canvas 上，因此拖动选框会强制整张底图重绘；
- `toImage()` 每次 move 都调用 `getBoundingClientRect()`，产生同步布局；
- Canvas 按 DPR（≤2）放大，1600×900 视口实际绘制 2880×1800，阴影模糊成本进一步放大。

结论：**主要瓶颈不是裁剪计算，而是「每帧整图重绘 + 全画布阴影」**。4K 图或高缩放下尤其明显。

#### 优化方案（按收益排序）

| # | 优化 | 说明 |
| --- | --- | --- |
| 1 | 裁剪框改为 DOM 覆盖层 | 新增 `.studio-crop-overlay` 绝对定位层，选框用 `left/top/width/height` 更新；外侧变暗用 `box-shadow: 0 0 0 9999px rgba(0,0,0,.5)`；三分网格用 CSS 渐变。拖动时 **Canvas 完全不重绘** |
| 2 | 阴影从 Canvas 移到 CSS | 画布外包一层 `.studio-canvas-wrap`，用 `box-shadow` 表现悬浮；移除 `ctx.shadowBlur`，避免每帧模糊整图 |
| 3 | 缓存视口矩形 | `pointerdown` 时缓存 `stage.getBoundingClientRect()`，`pointermove` 不再触发布局 |
| 4 | 帧内去重 | rAF 回调里比较裁剪矩形，未变化则跳过 DOM 写入；坐标取整到 1px，减少样式抖动 |
| 5 | 底图按视口缓存 | 新增 `viewCache`：缩放/平移结束后把 `renderBase()` 按显示分辨率绘到离屏 Canvas；拖动时只 `drawImage` 缓存，不再缩放原图 |
| 6 | 文档版本号 | `studioDoc` 增加 `version`，`draw()` 仅在版本变化或视口变化时重绘；裁剪叠加层独立更新 |
| 7 | 性能探针 | `localStorage.wb.studio.perf='1'` 时在控制台输出最近 60 帧均值/最大值，便于回归对比 |

#### 交互细节

- 裁剪工具激活后，在画布上拖出选框；选框支持 8 个手柄调整（P1，可先只做整体拖动）。
- 双击选框内部或点「应用裁剪」提交；「取消」清除选框，不改文档。
- 旋转/翻转仍按现有逻辑清空裁剪框。
- 裁剪框与蒙版坐标的偏移逻辑保持不变（`toMaskRect`）。
- 缩放/平移时 DOM 覆盖层同步变换（通过 `transform` 或重算 left/top）。

#### 验收标准

- 4096×4096 图、DPR 2、1600×900 视口：拖动选框平均帧耗时 **<16ms**，无明显掉帧与拖影。
- 连续拖动 60s 内存不持续增长；松手后裁剪尺寸精确到像素。
- 应用/取消裁剪、旋转后清空裁剪、蒙版偏移均无回归。
- 记录优化前后帧耗时对比到本文档台账。

#### 回滚

- 新增 `flags.cropOverlay`（默认开）；关闭后回退到 Canvas 绘制裁剪框。
- 阴影改为 CSS 属于低风险改动，可单独 revert。

### 15.2 本次任务 AI 编辑历史（D16.1）

#### 定义

- **一次任务 = 一次打开的图片文档**；打开新图即开启新会话，历史互不混用。
- 只记录 **AI 修改成功** 的结果（`job.status=done`）；失败任务不建卡片。
- 历史是时间线：回退到旧结果不会删除后面的记录，用户可来回跳。

#### 数据模型

```js
// sessionHistory.js
{
  sessionId,            // 文档 id
  entries: [{
    id, index,          // index 从 1 递增
    at,                 // 时间戳
    jobId,
    prompt,             // 当时的指令文本（含 @图二）
    model,              // qwen / moss
    params: { width, height, preset, turbo, steps, cfg },
    refs: [{ id, label, thumbUrl }],
    result: { blobKey, thumbUrl, width, height },
    status: 'done'
  }],
  limit: 30
}
```

- 缩略图：320px 宽 WebP，内存 URL。
- 原图：Blob 存 IndexedDB `wb-studio/history`，按 `sessionId` 归档；内存只留最近 6 张的 objectURL。
- 持久化：每次新增后写入；刷新页面可恢复；会话超过 30 张按 LRU 淘汰并提示。

#### 界面

位置：AI 面板底部，固定标题「编辑历史」，横向卡片轨道（不新增 tab）。

```
编辑历史  12 次                                    [清空]
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ 缩略图  │ │ 缩略图  │ │ 缩略图  │ │ 缩略图  │  →
│ #12 14:32│ │ #11 14:20│ │ #10 14:05│ │ #9 13:58 │
│ 换成蓝天…│ │ 去掉路人…│ │ 磨皮…    │ │ …       │
└────────┘ └────────┘ └────────┘ └────────┘
        hover：载入 · 对比 · 删除
```

- 卡片状态：当前结果高亮描边；任务运行中禁用「载入」。
- 空状态：「还没有 AI 编辑记录，完成一次修改后会出现在这里。」
- 载入交互：
  1. 当前文档有未保存改动（历史栈非空）时二次确认；
  2. 将该结果作为新主图重建文档；
  3. 恢复该次记录的参考图与指令，便于继续修改；
  4. 重置裁剪/旋转/调色参数，避免重复叠加；
  5. 蒙版默认清空（若记录里带蒙版快照则恢复）。
- 「删除」只删记录，不影响当前画面；「清空」需二次确认。
- 无障碍：卡片可 Tab 聚焦，Enter 载入，`C` 对比，Delete 删除。

#### 记录时机

- `aiPanel` 提交成功、结果落地后调用 `sessionHistory.append()`；同一 `jobId` 去重。
- AI 修改若产生多张结果，按张记录（同一 jobId 下用子序号）。
- 不记录普通的调整/裁剪/画笔操作（那是 §14 的撤销历史，两者独立）。

#### 验收标准

- 每次 AI 修改成功出现一张卡片，缩略图与结果一致。
- 点击卡片可回退，画面、参考图、指令正确恢复。
- 刷新页面后历史仍在；超过 30 张按规则淘汰。
- 历史操作不影响撤销栈与当前图层；删除/清空有确认。

### 15.3 图片对比（D16.2）

#### 复用方案

直接复用 `web/src/components/compare.js` 的 `openCompareDialog()`：

- 已具备：参考图/结果图选择、可拖动竖线、逐像素统计、差异视图、色彩校正。
- 本轮**不修改** `compare.js`，只新增 `compareLauncher.js` 做数据组装。

#### 数据映射

```js
openCompareDialog({
  references: [
    ...refs.map((r, i) => ({ url: r.dataUrl, label: `参考图 ${i + 1}` })),
    ...history.entries.map((e) => ({ url: e.result.url, label: `历史 #${e.index} · ${e.prompt.slice(0, 12)}` })),
    { url: originalUrl, label: '原始主图' }, // 可选
  ],
  results: [{ url: currentMainUrl, label: '当前主图' }],
  initialReference: 0,
});
```

- 当前主图：`doc.renderBase()` 导出 dataURL（调用前若正在生成则禁用）。
- 参考图数据已存在 AI 面板，直接复用，避免重复读取。
- 历史图与参考图都来自本地 dataURL/Blob，不涉及跨域，像素统计可用。

#### 入口

| 位置 | 行为 |
| --- | --- |
| 顶栏「对比」按钮 | 参考图 + 历史图 vs 当前主图 |
| AI 结果卡片「对比」 | 该结果 vs 当前主图 |
| 历史卡片 hover「对比」 | 该历史图 vs 当前主图 |
| 快捷键 `Shift+C` | 同顶栏 |

无可用参考图且无历史时，toast：「先添加参考图或完成一次 AI 编辑」。

#### 验收标准

- 竖线拖动流畅（复用现有实现），标签正确区分参考图/历史/当前主图。
- 关闭对比后工作室状态、滚动位置、当前工具不变。
- 对比弹窗在 1280 宽度下不溢出。

### 15.4 交付与台账

- D5.3 排在 D5.2 之后、D6.1 之前，提交前缀 `fix(studio):`。
- D16.1、D16.2 排在 D6.1 之后、D7.1 之前，提交前缀 `feat(studio):`。
- 每项完成后更新 §14.12 台账，并补一张裁剪拖动/历史卡片/对比弹窗的截图路径。

---

## 16. 会话持久化与恢复（补充方案）

> 对应交付项：D17.1（存储层 + 自动保存）、D17.2（恢复流程 + 横幅）、D17.3（配额、清理、多标签）。
> 本轮只写方案，不改代码。

### 16.1 为什么现在刷新会丢

当前工作室的全部状态都在内存里：

- 主图位图、蒙版、裁剪框、旋转/翻转、叠加层、参考图、指令、AI 结果预览、视口缩放与平移；
- 代码中没有任何 `indexedDB` / `localStorage` / `sessionStorage` / `beforeunload` 持久化逻辑；
- 刷新后 `createStudioPage()` 重新执行，状态重建为空；服务端只保存设置与任务历史，不保存工作室现场。

结论：**不是浏览器缓存问题，而是工作室从未落盘**。要做到「刷新不丢、关掉还能恢复」，需要新增本地工程存储。

### 16.2 目标行为

| 场景 | 期望 |
| --- | --- |
| 刷新页面 / 开发热更新 | **自动恢复**到刷新前状态，不弹窗 |
| 关闭标签/浏览器后再次打开 | 进入工作室显示恢复横幅「上次编辑未完成 · 恢复 / 忽略」，点击恢复 |
| 打开新图片 | 开启新会话；旧工程保留在「最近工程」里，不互相覆盖 |
| 恢复时数据损坏 | 回退到最近一份有效草稿并提示；不白屏 |
| 生成任务进行中关闭页面 | 恢复后查询任务状态：完成则接回结果，失败/丢失则标记中断 |

恢复内容清单：

| 恢复 | 不恢复 |
| --- | --- |
| 主图与所有图层（含蒙版） | 撤销/重做栈（恢复后重置，避免半截命令） |
| 裁剪框、旋转/翻转 | 正在进行的画笔笔画 |
| 调色/调整参数（后续版本） | 浏览器缩放、面板滚动位置（可选恢复） |
| 参考图、指令文本、@ 引用 | 弹窗/临时提示 |
| 本次任务 AI 编辑历史 | 失败任务的中间态 |
| AI 参数（尺寸、预设、Turbo、LoRA） | — |
| 视口缩放/平移、当前工具、右栏 tab | — |

### 16.3 IndexedDB 结构

数据库：`wb-studio`，版本 `1`（`schemaVersion` 存在 `meta`）。

| store | key | 值 | 说明 |
| --- | --- | --- | --- |
| `meta` | `lastProjectId` / `schemaVersion` | 字符串 / 数字 | 启动时定位最近工程 |
| `projects` | `projectId` | `{ name, width, height, createdAt, updatedAt, thumbnail, activeTool, viewport, tabId, schemaVersion }` | 工程元信息，`updatedAt` 建索引 |
| `layers` | `${projectId}:${layerId}` | `{ props, bitmapBlob, maskBlob, version, updatedAt }` | 每个图层独立存，支持增量 |
| `refs` | `projectId` | `[{ id, name, blob, width, height }]` | 参考图原图 |
| `session` | `projectId` | `{ prompt, activeTab, cropRect, transform, adjust, aiParams, viewport, activeTool }` | 轻量现场 |
| `aiHistory` | `projectId` | `{ entries: [...] }` | 与 §15.2 共用 |
| `aiResults` | `${projectId}:${entryId}` | `Blob` | AI 结果原图 |
| `drafts` | `${projectId}:${timestamp}` | `{ snapshot, createdAt }` | 最近 3 份，防写坏 |

容量估算：

- 4K 单层 PNG 约 8~25MB；蒙版 <1MB；参考图每张 2~5MB；
- 典型 3 层 + 3 参考图约 50~100MB；超过 300MB 在 UI 提示清理；
- 所有数据只在本机浏览器，不上传服务端。

### 16.4 自动保存策略

| 触发 | 说明 |
| --- | --- |
| 操作提交后 | 一次笔画/一次裁剪/一次图层操作/一次 AI 结果落地，800ms 防抖保存 |
| 空闲 5s | 兜底保存一次 |
| 页面隐藏 | `visibilitychange === 'hidden'` 立即 flush |
| 页面关闭 | `pagehide` 尽力 flush（异步不保证完成，依赖前面的防抖保存） |
| 手动导出前 | 强制 flush，避免导出后丢失 |

实现要点：

1. **只在提交边界保存**，拖动中不序列化；画笔在 `pointerup` 后保存。
2. **增量保存**：图层有 `version`，只重编码变化的图层；未变图层不重复写。
3. **原子写入**：先写 `drafts`，再更新 `projects.updatedAt` 指针；失败保留上一份草稿。
4. **编码**：优先 `OffscreenCanvas` + `convertToBlob`（可放 Worker）；不支持时主线程 `canvas.toBlob`。
5. **状态提示**：面板底部显示「保存中 / 已保存 / 保存失败（重试）」；失败不打断编辑，指数退避重试。
6. **节流上限**：连续操作最多每 800ms 写一次；大图编码期间跳过下一轮，避免堆积。

### 16.5 恢复流程

```
进入工作室
  → 读取 meta.lastProjectId
  → 无工程：显示空状态 + 「最近工程」入口
  → 有工程：
      sessionStorage.wb.studio.tab 与 project.tabId 一致？
        ├─ 是：判定为刷新 → 自动恢复（无弹窗）
        └─ 否：判定为重新打开 → 顶部恢复横幅
              「上次编辑未完成 · 2 分钟前」[恢复] [忽略]
恢复步骤
  1. 校验 projects / layers / refs / session 的 blob 是否齐全
  2. 重建 studioDoc：按图层顺序解码位图与蒙版
  3. 应用 session：参考图、指令、裁剪、变换、视口、当前工具
  4. 恢复 aiHistory（缩略图先出，原图按需加载）
  5. 查询进行中的 AI 任务：done 接回结果；failed 标记；任务不存在标记「已中断」
  6. 标记为已保存，撤销栈清空
```

异常处理：

- 单个图层 blob 缺失：跳过该层并 toast「1 个图层恢复失败」，其余正常。
- 主图损坏：回退最近一份 `drafts`；再失败则进入空状态，保留工程记录供导出排查。
- `schemaVersion` 不兼容：提示「工程来自新版本」，提供导出/忽略，不静默清空。

### 16.6 关闭、崩溃、多标签与配额

| 场景 | 处理 |
| --- | --- |
| 正常关闭 | 依赖 800ms 防抖 + hidden flush；最坏丢失最后一次操作 |
| 浏览器崩溃 / 断电 | 同上；重新打开走恢复横幅 |
| 多标签打开同一工程 | `BroadcastChannel` + 心跳锁；后开的标签显示「已在其他标签编辑」只读横幅，可选择「接管」（旧标签转为只读） |
| 存储配额不足 | `navigator.storage.estimate()` 在保存前检查；>80% 提示并阻止继续写大图层；写入失败 toast + 保留内存状态 |
| 浏览器清理数据 | 首次使用请求 `navigator.storage.persist()`；被清理后工程消失，需在 UI 说明 |
| 隐私模式 | 提示「隐私模式下关闭浏览器可能清空工程」 |

清理策略：

- 每个工程保留最近 3 份 `drafts`；
- 最近工程最多 10 个，超过 7 天未打开自动清理（可在设置里关闭）；
- 设置页「关于」增加「本机工程数据占用 / 清理」入口，二次确认后清空。

### 16.7 数据版本与导出

- `schemaVersion` 随结构升级递增，迁移函数集中在 `persistence.js`。
- 手动导出：
  - 图片导出保持 PNG/JPG（拼合）；
  - 工程导出 `.wbstudio.json`（图层以 dataURL 内嵌）放 P2；大工程提示体积；
  - 工程导入 P2，导入前校验版本与尺寸上限。
- 清空本机数据入口与工程导入导出同属 D17.3 之后，避免早期范围膨胀。

### 16.8 验收标准

- 编辑 3 层 + 2 参考图 + 1 条 AI 历史后刷新：图层、蒙版、裁剪、参考图、指令、历史、视口全部一致。
- 关闭浏览器 10 分钟后重新打开：出现恢复横幅，点击后完整恢复。
- 4K 三层工程：单次自动保存 <500ms，编辑无可感知卡顿。
- 保存失败/配额不足：有明确提示，内存状态不丢，可继续导出。
- 两个标签同时打开：后开标签只读并提示接管，不出现互相覆盖。
- 隐私模式/禁用存储：工作室仍可用，但明确提示不会持久化。

### 16.9 交付顺序

- D17.1 存储层与自动保存 → D17.2 恢复流程 → D17.3 配额/清理/多标签；
- 排在 D0.2 之后、D1.1 之前，提交前缀 `feat(studio):`；
- 每项完成更新 §14.12 台账，并记录一次「刷新恢复 / 关闭重开」验证结果。

---

## 17. 全站交互性能排查（补充方案）

> 对应交付项：D18.1（探针与基线）、D18.2（工作室交互优化）、D18.3（图像工具与蒙版编辑器）、D18.4（回归基准）。
> 触发原因：裁剪卡顿排查时发现这是**共性模式**，不止裁剪一处。本轮只做代码审查与方案，不改代码。

### 17.1 排查方法与判定

- **代码特征扫描**：`shadowBlur`、`clearRect` 全画布、`renderBase()` 失效、`canvas.width =`、`snapshot()` 全量克隆、异步 `render()` 无合并、`pointermove` 直接触发绘制。
- **运行时**：4K 测试图，DevTools Performance 录制，统计每帧耗时与每秒渲染次数。
- **判定**：单帧 >16ms 记为风险，>32ms 记为高；一次交互触发多次全量渲染记为高。

### 17.2 排查结论总表

| # | 模块 / 功能 | 触发路径 | 现状（代码证据） | 等级 |
| --- | --- | --- | --- | --- |
| 1 | 工作室 · 裁剪 | `pointermove → scheduleDraw → draw()` | 全画布清空 + 整图 `drawImage` + `shadowBlur:26` + 选框再绘制；见 `studio.js` `draw()` | **高**（D5.3） |
| 2 | 工作室 · 平移 / 缩放 | 拖拽、滚轮 | 与裁剪同一条 `draw()` 路径，每帧整图 + 阴影 | **高** |
| 3 | 工作室 · 蒙版画笔悬停 | 未按下时 `pointermove` | `MASK_TOOLS` 命中即 `scheduleDraw()`，光标移动也整图重绘 | **高** |
| 4 | 工作室 · 蒙版涂抹 | `stampMask` → `tintDirty=true` → `draw()` | 每帧全尺寸 `renderMaskTint()`（4K 再开一张画布）+ 整图重绘 | **高** |
| 5 | 工作室 · 移动叠加层 | `pointermove → layer.x/y → touchLayers()` | `touchLayers()` 每次 move 都 `invalidateBase()`，下一帧重跑 `renderBase()`：4K 原图 + `ctx.filter` + 裁剪 + 全部叠加层 | **高** |
| 6 | 工作室 · 调色滑杆 | `input → invalidateBase() → scheduleDraw()` | 每个 input 事件都全分辨率重跑滤镜合成；`change` 再 `snapshot()` 克隆 | **高** |
| 7 | 工作室 · 笔刷大小/硬度滑杆 | `input → scheduleDraw()` | 只为移动光标也整图重绘 | 中 |
| 8 | 工作室 · 套索 / 形状预览 | `pointermove → scheduleDraw()` | 整图重绘后叠加路径 | 中 |
| 9 | 工作室 · 撤销 / 重做 | `restore()` + `scheduleDraw()` | 克隆蒙版与图层后整图重绘；大步回退有明显停顿 | 中 |
| 10 | 工作室 · 历史快照 | `snapshot()` | **每次都克隆整张蒙版 + 全部图层**，上限 30；4K 蒙版单张约 33MB，最坏可逼近 1GB，GC 造成卡顿 | **高（内存）** |
| 11 | 工作室 · 导出 | `bake() → toDataURL` | 主线程同步编码 4K PNG，期间界面冻结 | 中 |
| 12 | 图像工具 · 裁剪 / 移动选框 | `pointermove → render()`（异步） | 每次 move 都 `loadSourceImage` + `applyOpsToCanvas` 全量重算 + 两块画布重设 `width`（强制重分配）+ 全量重绘；**没有 rAF 合并**，一帧可触发多次 | **高** |
| 13 | 图像工具 · 水印拖动 | `pointermove → render()` | 同上，整条处理链重跑 | 中 |
| 14 | 蒙版编辑器 · 画笔 | rAF + `drawImage` 显示尺寸 | 每帧重绘显示层与预览层，无阴影；需实测 4K 下帧耗时 | 低-中（待实测） |
| 15 | 框选工作室 / 姿势工作室 | `pointermove` | 以 DOM 手柄与图片为主，未发现画布阴影；需实测 | 低（待实测） |
| 16 | 图片对比 | 拖动竖线 | CSS 裁剪 + 两张图，无 Canvas 处理 | 低 |
| 17 | 画廊 / 历史长列表 | 滚动 | 需确认大图是否 `loading="lazy"` / `decoding="async"`；否则滚动解码卡顿 | 中（待实测） |

### 17.3 共性根因

1. **静态底图与动态层画在同一张 Canvas**：选框、光标、路径、蒙版、底图任一变化都触发整图重绘。
2. **Canvas 阴影/滤镜作用在整张大图**：`shadowBlur` 与 `ctx.filter` 在 4K 上代价极高。
3. **缓存失效粒度过粗**：移动一个叠加层、拖一个滑杆就 `invalidateBase()`，重跑完整合成。
4. **蒙版着色全量重算**：每次落笔都重建整张 tint 画布。
5. **异步渲染无合并**（图像工具）：`pointermove` 直接 `await render()`，多次全量任务叠加。
6. **历史快照全量克隆**：每步都复制蒙版与所有图层，内存与 GC 压力大。
7. **主线程同步编码**：导出 `toDataURL` 阻塞。

### 17.4 统一优化原则（D18.2 / D18.3 共用）

| 原则 | 做法 |
| --- | --- |
| 双画布 | 静态底图一层（只在文档/视口变化时更新），动态层一层（选框/光标/路径/蒙版预览） |
| 阴影外移 | 删除 `ctx.shadowBlur`，画布容器用 CSS `box-shadow` |
| 交互只改动态层 | 裁剪、套索、形状、画笔光标、图层选中框全部画在动态层 |
| 缓存合成 | 叠加层移动时先缓存「下方」与「上方」合成结果，拖动只做一次 `drawImage`，松手后再落一次全量 |
| 滑杆预览降级 | 调色先用 CSS `filter` 或 1/2 降采样代理预览，`change`/`pointerup` 再全分辨率合成 |
| 蒙版脏矩形 | tint 只重绘笔刷包围盒；笔刷外区域复用上一帧 |
| 帧合并 | 所有 `pointermove` 走 rAF，并比较参数是否变化；异步渲染加 token 与「进行中跳过」 |
| 不重设尺寸 | 只有显示尺寸变化时才改 `canvas.width/height`，避免每帧重分配 |
| 历史控内存 | 按字节上限而非固定步数；未变图层共享引用；必要时压缩或改为命令式 |
| 异步导出 | `canvas.toBlob` + 进度提示，避免 `toDataURL` 卡主线程 |
| 探针 | `perf.js` 记录帧耗时、渲染次数、内存占用；开发开关 `wb.studio.perf=1` |

### 17.5 分项修复方案

**工作室（D18.2）**

1. `draw()` 拆为 `renderStatic()` 与 `renderOverlay()`；`scheduleDraw(kind)` 支持 `static/overlay/both`。
2. 平移/缩放只重绘静态层（仍复用视口缓存的 `viewCache`），动态层跟随变换。
3. 画笔悬停只更新动态层光标；涂抹时静态层不重绘，蒙版预览按脏矩形更新。
4. 叠加层拖动：拖动开始缓存上下合成图，move 只 blit 缓存，`pointerup` 提交并全量重绘一次。
5. 调色滑杆：输入时对画布元素加 CSS `filter`（与参数同构）或低分辨率代理；`change` 时全量合成 + 快照。
6. `snapshot()` 增加内存预算（例如 256MB），超限压缩旧快照或丢弃最旧；未修改图层不克隆。
7. 导出改 `toBlob`，显示「正在导出」。

**图像工具（D18.3）**

1. `render()` 拆为「工作画布构建」与「显示刷新」；工作画布按 `opsVersion` 缓存，拖动选框只刷新叠加层。
2. 所有 `pointermove` 走 rAF 合并；异步任务带 token，旧任务结果直接丢弃（现在只丢弃结果，不阻止重复计算）。
3. 只有显示尺寸变化时才重设 `canvas.width/height`。
4. 水印拖动只更新水印叠加层，不重跑 `applyOpsToCanvas`。
5. `applyOpsToCanvas` 对连续 adjust 做合并，避免多次全量滤镜。

**蒙版编辑器（D18.3）**

- 实测 4K 下画笔帧耗时；必要时把预览层降采样到显示分辨率，笔刷路径只更新脏矩形。

**注意**：`imageTools.js` / `maskEditor.js` 目前有同事未提交改动（高清放大接入），D18.3 开工前先确认已提交或明确分工，避免冲突。

### 17.6 性能基线（D18.1 填写）

| 场景 | 分辨率 | 当前 | 目标 |
| --- | --- | --- | --- |
| 裁剪拖动 | 4096² | 待测 | <16ms/帧 |
| 平移 / 缩放 | 4096² | 待测 | <16ms/帧 |
| 蒙版涂抹 | 4096² | 待测 | <16ms/帧 |
| 叠加层拖动 | 4096² | 待测 | <16ms/帧 |
| 调色滑杆 | 4096² | 待测 | 预览 <16ms/帧 |
| 图像工具裁剪拖动 | 4096² | 待测 | <16ms/帧 |
| 历史 20 步内存 | 4096² | 待测 | <256MB |

### 17.7 验收标准

- 4096² 图、DPR 2 下，上述交互平均帧耗时 <16ms，无肉眼可见拖影。
- 连续操作 60s，内存不持续增长；历史 20 步内存低于预算。
- 所有功能行为不变：裁剪尺寸、蒙版范围、叠加层位置、调色结果与优化前一致。
- 图像工具与蒙版编辑器不因优化产生导出差异。

### 17.8 交付顺序

- D18.1 探针与基线 → D18.2 工作室优化 → D18.3 图像工具/蒙版 → D18.4 回归基准。
- D5.3（裁剪）作为 D18.2 的前置子集，先单独提交，避免一次性大改。
- 每项完成后更新 §14.12 台账，并把 §17.6 的「待测」替换为实测数据。

---

## 18. 潜在隐患与 Bug 清单（静态审查）

> 触发：裁剪卡顿排查后做的一轮全链路静态审查。
> 范围：`studio.js`、`studio/studioDoc.js`、`studio/aiPanel.js`、`compare.js`、`imageTools.js`、`maskEditor.js`。
> 本轮只记录、不改代码。未运行复现的条目按「静态确定 / 待实测」标注，避免把推测写成结论。
> 对应新增里程碑：**M1D 稳定性与健壮性（D19.1~D19.6）**。

### 18.1 分级与判据

| 级别 | 含义 | 处理时机 |
| --- | --- | --- |
| **P0** | 产生错误输出或不可逆数据丢失 | M1 之后立即修（D19.1 / D19.2） |
| **P1** | 功能错误、明显卡顿、可恢复的数据丢失 | M1D 内修（D19.3~D19.5） |
| **P2** | 兼容性、体验、边界情况 | M1D 收尾或随对应里程碑 |

置信度：**静态确定**＝代码路径可完整推导；**待实测**＝需要浏览器/大图复现确认。

### 18.2 总表

| 编号 | 问题 | 级别 | 代码证据 |
| --- | --- | --- | --- |
| S-01 | 旋转 / 翻转静默清空叠加层与裁剪 | P1 | `studioDoc.js:131-161` |
| S-02 | 「恢复原始图片」确认文案漏掉叠加层 | P1 | `studio.js:1407-1424`、`studioDoc.js:182-189` |
| S-03 | 叠加层不透明度不可撤销 | P1 | `studioDoc.js:342-348`、`aiPanel.js:908-912` |
| S-04 | 预览 AI 结果时导出 / 收藏 / 送编辑仍是旧底图 | **P0** | `studio.js:632-638`、`studioDoc.js:450-461`、`studio.js:1180-1267` |
| S-05 | 删除参考图不清理指令里的 `@图N` | **P0** | `aiPanel.js:869-874`、`591-596` |
| S-06 | 换图 / 载入结果后参考图与指令残留 | **P0** | `aiPanel.js:1058-1067`、`studio.js:1084-1107` |
| S-07 | 自动识别任务被记录成 `auto` | P1 | `aiPanel.js:810`、`1019-1023` |
| S-08 | AI 结果 URL 为空仍提示成功并进入预览 | P1 | `aiPanel.js:809-820`、`api.js:322-326` |
| S-09 | 主图 / 参考图 / 叠加图无像素与体积上限 | P1 | `studio.js:1055-1082`、`studio.js:401-418`、`aiPanel.js:565-589` |
| S-10 | 快速连续打开图片存在加载竞态 | P1 | `studio.js:1055-1082` |
| S-11 | 外链图未设 `crossOrigin`，画布被污染后无法导出 | P1 | `studio.js:1046-1053`、`studioDoc.js:450-461` |
| S-12 | 「用近期结果试试」URL 拼接错误 | P2 | `studio.js:1242-1255` |
| S-13 | AI 结果预览被强行拉伸到旧文档尺寸 | P1 | `studio.js:632-638` |
| S-14 | 每次蒙版落下触发 4K 编码链 | **P1（重）** | `studio.js:1121-1134`、`aiPanel.js:1069-1076`、`studio.js:365-375` |
| S-15 | 导出 / 复制 / 收藏 / 送编辑同步 `toDataURL` | P1 | `studioDoc.js:450-466`、`studio.js:1166-1214` |
| S-16 | 历史快照 30 步全量克隆蒙版与图层 | P1（内存） | `studioDoc.js:84-95` |
| S-17 | `getMainThumb()` 每次刷新重建底图并编码 | P2 | `studio.js:350-364`、`aiPanel.js:542-563` |
| S-18 | `maskCanvas()` / `renderMaskTint()` 每次新建画布 | P2 | `studioDoc.js:243-256`、`433-445` |
| S-19 | 裁剪时先分配整张原尺寸画布再复制裁剪区 | P2（内存） | `studioDoc.js:371-417` |
| S-20 | 图像工具每次 `pointermove` 全量重算并重设画布尺寸 | P1 | `imageTools.js:1368-1401`（详见 §17.2 #12） |
| S-21 | 全局监听器与 `ResizeObserver` 从不清理，无 `destroy()` | P1 | `studio.js:1458-1464`、`1544-1562`、`1580-1588` |
| S-22 | 快捷键排除不完整：`contenteditable`、Space、Tab | P1 | `studio.js:1472-1523`、`1533-1542` |
| S-23 | 在指令框 / 弹窗内粘贴图片会替换主图 | P1 | `studio.js:1458-1464` |
| S-24 | 收藏失败后按钮永久禁用 | P1 | `studio.js:1180-1196` |
| S-25 | `ctx.filter` 不可用时曝光 / 对比 / 饱和度静默失效 | P2 | `studioDoc.js:382-390` |

### 18.3 数据与输出一致性

**S-01 旋转 / 翻转静默丢弃叠加层与裁剪（P1，静态确定）**

- 证据：`studioDoc.js:131-161` 在旋转 / 翻转中直接 `this.layers = []`、`this.transform.crop = null`。
- 触发：叠加素材或贴纸后点旋转 / 翻转。
- 后果：`layers` 与 `crop` 被直接置空，画面元素瞬间消失，仅能靠 Ctrl+Z 找回；界面只有一行静态小字提示，不针对本次操作。
- 修复：旋转 / 翻转时同步变换图层坐标与尺寸（推荐），或至少弹出确认「将清空 N 个叠加层与裁剪」；操作后用 toast 明示并提供撤销入口。

**S-02 「恢复原始图片」确认文案漏掉叠加层（P1，静态确定）**

- 证据：`resetAll()` 同时清空 `layers`，但确认文案只写「调色、裁剪与蒙版」。
- 修复：文案改为「会清空所有调色、裁剪、蒙版与叠加层」，并显示叠加层数量。

**S-03 叠加层不透明度不可撤销（P1，静态确定）**

- 证据：`setOverlayOpacity()` 只 `invalidateBase()`，不 `snapshot()`；AI 面板滑杆每个 `input` 直接调用。
- 后果：调完不透明度无法撤销；且滑杆过程完全没有历史记录。
- 修复：`input` 期间只预览，`change` 时 `commitLayers()` 落一次快照；或在 AI 面板滑杆上绑定 `change` 提交。

**S-04 预览 AI 结果时导出的是旧底图（P0，静态确定）**

- 证据：`preview.image` 只画在画布上（`draw()`），`bake()` 不含预览；下载 JPG/PNG、收藏、送编辑、复制全部走 `doc.bake()`。
- 后果：用户看到的是 AI 新结果，导出的却是旧图；属于「所见非所得」，容易造成交付错误。
- 修复：预览开启时，导出 / 收藏 / 送编辑先提示「当前显示的是 AI 预览，需先载入为新底图」，或提供「导出当前预览」分支（直接使用 `preview.image` 编码）。

### 18.4 AI 任务上下文

**S-05 删除参考图不清理 `@` 引用（P0，静态确定）**

- 证据：删除按钮只做 `state.refs.filter(...)` 与 `renderRefs()`，指令文本原样保留。
- 后果：`@图三` 仍指向已删除的槽位，后端按编号映射会取错图或取空；用户很难察觉。
- 修复：删除时同步重写指令中的引用编号（后移补位），或把失效引用标记为不可提交并高亮提示。

**S-06 换图 / 载入结果后参考图与指令残留（P0，静态确定）**

- 证据：`resetResult()` 只清结果态；`setDoc()` 调它但不动 `state.refs` 与 `refs.prompt`。
- 后果：打开新主图后，上一任务的参考图仍参与本次请求，指令里的 `@图N` 指向旧素材，生成结果不可控。
- 修复：`setDoc()` 增加 `ai.resetTaskContext()`，清空 refs、指令、`@` chip；若担心误清，可保留指令但强制清 refs 并提示。

**S-07 自动识别任务被记录成 `auto`（P1，静态确定）**

- 证据：`resultInfo.task = refs.task.value`，自动模式下即为 `'auto'`；`adoptResult` 用它决定文件名后缀与后续扩图判断。
- 后果：历史卡片 / 对比标签 / 载入后的任务标记全部失真。
- 修复：记录实际解析出的 `loraState.task`（`detectTask` 结果），`refs.task.value` 只表示用户选择。

**S-08 空结果 URL 假成功（P1，静态确定）**

- 证据：`api.fileUrl('')` 返回 `''`；`onDone` 仍 `previewOn = true`、`showResult('')` 并 toast「修改完成」。
- 后果：后端返回缺字段时，用户以为成功，实际画布无变化，载入按钮点击后静默失败。
- 修复：`if (!image?.url && !image?.path) throw` / toast 失败并保持结果区隐藏。

### 18.5 输入健壮性

**S-09 无像素与体积上限（P1，静态确定）**

- 位置：`openFile`、`openUrl`、`addRefFiles`、`addOverlay`。
- 后果：超大图（如 12000×12000）会直接分配数百 MB 画布，移动端或低内存机器白屏 / 崩溃；参考图还会以 base64 进请求体。
- 修复：统一 `validateImage(file/image)`：最大边 8192、总像素 ≤ 40MP、文件 ≤ 30MB；超限提示并拒绝；参考图另行降采样到 2048。

**S-10 连续打开图片的竞态（P1，静态确定）**

- 证据：`openFile` / `openUrl` 各自 `await loadImage` 后直接 `setDoc`，无请求序号。
- 后果：先点的图更大、后完成，会覆盖用户后选的图。
- 修复：增加 `openToken`，回调时比对；失效请求直接丢弃并 revoke。

**S-11 外链图污染画布（P1，静态确定）**

- 证据：`loadImage()` 未设置 `crossOrigin`；`bake()` / `maskPng()` 直接 `toDataURL`。
- 后果：从素材仓库或 AI 结果引入跨域 URL 后，导出抛 `SecurityError`，且错误发生在用户点导出时，难以定位。
- 修复：能控制的服务端图统一同源；外部 URL 先 `fetch` 成 Blob 再 `createObjectURL`；`loadImage` 对 http(s) 设 `crossOrigin='anonymous'` 并在失败时给出明确提示。

**S-12 近期结果 URL 拼接（P2，静态确定）**

- 证据：`url.startsWith('/') ? url : '/files/' + url`，若后端返回完整 `http(s)://` 会拼成 `/files/http://...`。
- 修复：直接复用 `api.fileUrl(url)`。

**S-13 预览被拉伸（P1，静态确定）**

- 证据：`ctx.drawImage(preview.image, view.x, view.y, w, h)`，`w/h` 来自旧文档尺寸。
- 后果：扩图结果与主图宽高比不同时，预览变形，用户误判构图。
- 修复：按 `preview.image` 实际宽高比计算绘制矩形，居中并保持比例；或预览期间临时按结果尺寸重算视图。

### 18.6 主线程、编码与内存

**S-14 每次蒙版落下触发 4K 编码链（P1 重，静态确定）**

- 链路：`endDrag → updateMaskStatus → maskCoverage（全图 getImageData）+ 可能触发的 hasMask 全图扫描 → ai.onMaskChanged → getSource → bake(PNG) + maskPng + maskCoverage`。
- 后果：每一笔结束都同步编码整张 4K 图，笔画间明显卡顿；越大越严重。
- 修复：`onMaskChanged` 只接收覆盖率数值并更新文案，不调用 `getSource()`；`updateMaskStatus` 复用一次 `getImageData` 结果；编码推迟到提交 / 导出时。

**S-15 同步 `toDataURL` 冻结主线程（P1，静态确定）**

- 位置：导出 JPG/PNG、复制、收藏、送编辑、`getSource()`。
- 修复：统一改 `canvas.toBlob()` + 异步等待；按钮进入 loading 态；4K PNG 预计数百毫秒，必须给反馈。

**S-16 历史快照内存（P1，静态确定）**

- 证据：每一步克隆整张蒙版与全部图层，上限 30；4K 蒙版单张约 33MB。
- 后果：叠图 + 长编辑后最坏接近 1GB，触发 GC 卡顿或标签页崩溃。
- 修复：按字节预算（如 256MB）淘汰；未修改图层共享引用；蒙版快照改为压缩位图或命令式重放。

**S-17 主图缩略图重复编码（P2，静态确定）**

- 证据：`refresh()` → `renderRefs()` → `getMainThumb()` → `renderBase()` + `toDataURL`；撤销、裁剪、旋转、缩放图层后都会触发。
- 修复：按 `doc.version` 缓存缩略图，只在底图变化时重算。

**S-18 蒙版显示画布重复分配（P2，静态确定）**

- 证据：`maskCanvas()`（有裁剪时）与 `renderMaskTint()` 每次都 `makeCanvas`。
- 修复：复用固定尺寸的 tint 画布，脏矩形更新；与 §17 的蒙版优化合并实施。

**S-19 裁剪路径双份大画布（P2，静态确定）**

- 证据：`renderBase()` 先分配 `oriented` 全尺寸画布，再新建裁剪画布复制。
- 修复：裁剪态直接以 `crop` 尺寸为目标画布，绘制时施加 `-crop.x/-crop.y` 偏移。

**S-20 图像工具重复全量计算（P1，静态确定；与 §17 #12 同源）**

- 证据：每次 `pointermove` 都 `await loadSourceImage()` + `applyOpsToCanvas()`，并重设两块画布的 `width/height`；`renderToken` 只丢弃过期结果，不阻止重复计算。
- 归属：修复在 D18.3，本条只登记为稳定性问题，避免与 §17 重复排期。

### 18.7 事件、生命周期与可访问性

**S-21 全局监听器泄漏（P1，静态确定）**

- 证据：`window.addEventListener('keydown'/'keyup'/'paste')` 与 `ResizeObserver` 均无清理，返回对象只有 `onShow()`，没有 `destroy()`。
- 后果：反复进入工作室会累积监听器；离开页面后快捷键与粘贴仍会命中旧实例，可能误改隐藏文档。
- 修复：返回 `destroy()`，统一移除监听器、`resizeObserver.disconnect()`、取消 rAF、释放 tint/缓存；路由切走时调用。

**S-22 快捷键可用性（P1，静态确定）**

- 问题一：只排除 `INPUT|TEXTAREA|SELECT`，富文本指令框（`contenteditable`）会吞掉工具快捷键。
- 问题二：Space 无条件 `preventDefault()`，按钮获得焦点后无法用空格触发。
- 问题三：有 AI 预览时 Tab 被劫持为「闪回底图」，破坏键盘导航。
- 修复：统一 `isEditableTarget()`（含 `isContentEditable`、弹窗内）；Space 仅在画布聚焦时拦截；Tab 改为按住 `\\` 或 `Alt` 等非导航键。

**S-23 粘贴劫持主图（P1，静态确定）**

- 证据：`window` 级 `paste` 不判断焦点与弹窗，只要图片项就 `openFile`。
- 后果：用户在指令框粘贴参考图 / 截图时，主图被替换，当前编辑丢失（历史随新文档清空）。
- 修复：焦点在可编辑元素或弹窗内时不处理；空状态外粘贴需确认；或把粘贴路由到「参考图 / 叠加层」并提供选择。

**S-24 收藏失败按钮死锁（P1，静态确定）**

- 证据：`collect()` 无 `try/finally`，`await favoriteImage(...)` 抛出后按钮保持 disabled 与「收藏中…」。
- 修复：`try { ... } catch { toastError } finally { 恢复按钮 }`。

### 18.8 兼容性

**S-25 `ctx.filter` 缺失时静默降级（P2，待实测）**

- 证据：`if (ctx.filter !== undefined)` 才应用曝光 / 对比 / 饱和度；不支持时完全不生效，也没有提示。
- 后果：旧版 Safari 上预览与导出都「看起来没反应」，用户以为滑杆坏了。
- 修复：启动时探针检测 `ctx.filter`；不支持则降级为像素级调色（复用 D9.1 的 `color.js`）或禁用对应滑杆并提示。

### 18.9 修复批次与验收

| 交付项 | 范围 | 包含 | 验收 |
| --- | --- | --- | --- |
| D19.1 | 数据与输出一致性 | S-01~S-04 | 旋转 / 重置 / 调透明度均可撤销；预览态导出有明确拦截或正确输出 |
| D19.2 | 任务上下文 | S-05~S-08 | 删参考图后指令无悬空 `@`；换图后 refs/prompt 清空；历史任务类型正确 |
| D19.3 | 输入健壮性 | S-09~S-13 | 超限图有明确提示；连续开图不串图；外链图可正常导出；扩图预览不变形 |
| D19.4 | 编码与内存 | S-14~S-19 | 单笔蒙版结束 <50ms；4K 导出不冻结界面且有进度；20 步历史 <256MB |
| D19.5 | 事件与生命周期 | S-21~S-24 | 进出工作室 10 次监听器数量不增长；编辑框内快捷键/粘贴不误触；收藏失败可重试 |
| D19.6 | 兼容与降级 | S-25 | 不支持 `ctx.filter` 时有降级或明确禁用提示 |

补充约定：

- S-20 归入 D18.3，不重复排期；S-14~S-19 与 D18.2 的分工是：**D18.2 管渲染管线，D19.4 管编码、快照与缓存**。
- 每个 D19 交付项先补一条可复现用例（Playwright 或手工步骤），再改代码，最后回归 `python -m pytest tests -q`。
- 本章所有条目在修复前不作为「已确认线上故障」对外描述；涉及浏览器行为的标注「待实测」。

