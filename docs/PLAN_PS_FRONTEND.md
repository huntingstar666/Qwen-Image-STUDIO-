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
