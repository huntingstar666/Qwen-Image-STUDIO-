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
