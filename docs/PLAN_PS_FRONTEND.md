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

- [x] 主图：本地文件、素材仓库、最近结果、拖入、粘贴五种方式都能打开。（仓库/最近依赖后端数据，本轮验证到入口与取图链路；本地、拖入、粘贴实测通过）
- [x] 拖入多张：第一张主图，其余参考图；已有主图时全部进参考图。
- [x] 参考图：仓库多选、本地多选、图库拖入、指令框拖入都能加入，上限 3 张。
- [x] @：输入 `@` 出菜单；chip 视觉独立；Backspace 整块删除；删除参考图后 chip 与编号同步。
- [x] 提交 payload：`images[0]` 是主图，参考图顺序与 chip 编号一致；`prompt` 中 `@图二` 正确映射为 `图2`。
- [x] 右栏：3 段控件；蒙版参数只在画笔类工具出现；扩图面板只在扩图工具出现。
- [x] AI 面板：默认只看到指令、参考图、修改；「更多设置」折叠/展开正常，摘要实时更新。
- [x] 顶栏导入/导出菜单可键盘操作；危险操作有确认。
- [x] 1440 / 1280 / 1024 三档无横向滚动，画布不变形。
- [x] 控制台无报错；`python -m pytest tests` 保持全绿；文生图 / 图像编辑页面无回归。

### 12.11 实施进度

- **D1.1 导入选择器（已完成）** —— 新增 `web/src/components/studio/importPicker.js`：`openImportPicker({ title, multiple, accept, max, onPick })` 统一三来源，返回 `[{ name, src, width, height, source }]` 且 `src` 已转为 dataURL。本地文件支持多选与拖放（主图模式一次最多 4 张，供调用方拆 1 主图 + 3 参考图），素材仓库走 `api.materials({ limit: 200 })`、最近结果走 `api.history(20)`，两者都按 `src` 去重并经 `api.fileUrl → fetch → FileReader` 转 dataURL；单选模式自动替换选中，多选默认上限 3。弹窗沿用 `.ref-pick-grid` 视觉，只在 `studio.css` 追加 `.ip-*` 样式，未改动 `refLibrary.js`。浏览器实测：本地多图（尺寸读取正确）、仓库多选 2 张、单选替换、最近结果空态、取图转 dataURL 均通过，无 JS 异常。下一步 D1.2：顶栏「导入 ▾」与拖拽矩阵。

- **D1.2 主图导入入口与拖拽矩阵（已完成）** —— 顶栏「打开图片」改为「导入 ▾」下拉（本地文件 / 素材仓库 / 最近结果），支持点击外部关闭、方向键 / Home / End / Escape 键盘操作与 `aria-expanded` 同步；本地走隐藏 `fileInput`，仓库与最近结果复用 D1.1 的 `openImportPicker` 并以 `initialSource` 直接落到对应 tab。新增 `importPicked` / `importLocalFiles` / `openMainPicker` / `importLibraryRef` 四个分流函数：已有主图时拖入/导入的图片全部转参考图，无主图时第一张作主图、其余按顺序进参考图（参考图仍受 3 张上限约束，重复 dataURL 由 `addRefItems` 去重）。画布拖拽同时识别 `Files` 与 `application/x-wb-ref`，图库缩略图先 `urlToDataUrl` 再入参考图。浏览器实测：菜单三项与键盘操作正常、仓库 tab 自动激活并载入 5 张素材、空画布拖入 2 张 = `a.png` 主图（40×30）+ 1 张参考图、已有主图后 `x-wb-ref` 与仓库各补 1 张至 4/4、第 4 张被拦截并提示，无 JS 异常。下一步 D1.3：空状态素材仓库入口。

- **D1.3 空状态素材仓库入口（已完成）** —— 空画布按钮按 §12.6 收敛为两个：「从本地选择」继续走隐藏 `fileInput`，「从素材仓库」调用 `openMainPicker('warehouse')`，打开导入选择器并直接落在仓库 tab；原先「用近期结果试试」的入口由顶栏「导入 ▾ → 最近结果」承接。浏览器实测：空状态两个按钮均可见可点，仓库弹窗自动激活仓库 tab、载入 5 张素材，选中首张确认后以 1400×787 打开为主图，无 JS 异常。下一步 D2.1：参考图三来源。

- **D2.1 参考图三来源（已完成）** —— AI 面板「+ 添加参考图」改为「+ 添加参考图 ▾」下拉（本地文件 / 素材仓库 / 最近结果），与顶栏导入菜单同一套键盘与外部点击关闭行为，本地输入框补 `multiple`。素材仓库与最近结果复用 `openImportPicker({ accept:'ref', multiple:true, max: 3 - 已有参考图 })`，因此剩余 1 张时弹窗自动收窄为单选、已满 3 张时按钮禁用；选中结果统一走 `addRefItems`，保留尺寸校验与 dataURL 去重。`mountAiPanel` 新增 `destroy()` 解绑 document 级监听，由 `studio.js` 销毁时调用。浏览器实测：菜单三项、仓库 tab 自动激活并提示「可多选，最多 3 张」、连选 3 张后参考图 4/4 且按钮禁用、外部点击/Escape 关闭与焦点回落正常，无 JS 异常。下一步 D2.2：参考图拖拽与去重。

- **D2.2 参考图拖拽与去重（已完成）** —— `.ai-refs` 参考图条与 `.ai-prompt` 指令框同时接入拖拽：本地文件走 `filesFromDataTransfer → addRefFiles`，图库缩略图 / 历史胶囊的 `application/x-wb-ref` 先 `urlToDataUrl` 再 `addRefItems`，两条路径共用同一套尺寸校验与 dataURL 去重；`dragover` 时高亮 `.is-dropping`（参考图条描边变实底、指令框边框变虚线），`dragleave` / `drop` 立即回落。拖入成功后沿用原有 `insertMention` 自动补 `@图N`；重复图不再入队并提示「参考图已存在，未重复添加」，满 3 张时提示改为「参考图最多 3 张，已忽略多余图片」。浏览器实测：文件拖入 2/4 且自动插入 `@图二`、同图再拖保持 3/4 并出现去重提示、`x-wb-ref` 拖进指令框到 4/4 且按钮禁用、第 4 张被拦截、拖拽高亮均能正确出现与清除，无 JS 异常。下一步 D3.1：富文本 @ 内核。

- **D3.1 富文本编辑器内核（已完成）** —— 新增 `web/src/components/studio/promptEditor.js`：`createPromptEditor(host, opts)` 输出 `contenteditable` 编辑区与 `getText / setText / syncRefs / insertMention / setMentionMenu / focus / clear`。参考图以 `span.pe-mention[contenteditable=false][data-ref-id]` 原子节点存在，序列化按当前参考图顺序还原为 `@图二`，`<br>/<div>` 转 `\n` 并折叠连续空行，与既有 `mapMentions()` 契约一致；Backspace / Delete 命中相邻 chip 时整块删除，方向键按浏览器原生原子节点行为跨过；`@` 语境通过 `input` + 光标前文本识别并回调 `onMentionQuery(q|null)`，`insertMention` 会吞掉已输入的 `@` 片段；粘贴只取 `text/plain`，拖放交给调用方，IME 组合期间不触发变更与 @ 查询。浏览器实测（在页内动态 import 内核）：`setText` 还原 2 个 chip 且编号为 `r1:@图二 / main:@图一`、追加插入落在末尾、`syncRefs` 移除失效 chip 并回排编号同时回调 `onMissingRef(1)`、Backspace / Delete 各整块删除 1 个 chip、粘贴 HTML 不进入编辑区、IME 组合期间 0 次 `onChange` 且结束后补 1 次、`@` 唤起查询并选中菜单项后 chip 正确插入、Ctrl+Enter 回调 1 次、`clear` 后内容为空。下一步 D3.2：接入 AI 面板并做 @ 菜单与编号联动。

- **D3.2 @ 菜单与编号联动（已完成）** —— `aiPanel.js` 的指令框从 `textarea` 迁移到 `promptEditor`：`state.prompt` 改为每次 `getText()` 派生，提交、润色、任务识别、自动保存与恢复（先 `syncRefs` 再 `setText`，历史 `@图N` 还原为 chip）全部改走编辑器 API；参考图增删后统一 `syncEditorRefs()`，chip 只存 `refId`，删除参考图时失效 chip 自动移除并重排编号，同时提示「已移除 N 个失效的参考图引用」。输入 `@` 由内核回调 `onMentionQuery`，菜单按 `图N · 名称` 过滤；「@ 引用」按钮先聚焦编辑器再列全部；chip 删除、粘贴净化与 Ctrl+Enter 沿用内核。`studio.css` 用 `.pe-editor` 承接原 `.ai-prompt` 视觉，新增 `.pe-mention` 胶囊与 `:empty` placeholder，拖拽高亮改为 `.ai-prompt-host.is-dropping .pe-editor`。浏览器实测：输入文字计数与提交按钮联动正常、拖入参考图自动插 `@图二/@图三`、输入 `@` 菜单列出 3 项并过滤、选中后 chip 插入且 `@` 被吞、删除首张参考图同步移除 2 个 chip 并把 `@图三` 重排为 `@图二`、Backspace 整块删除 chip、`@ 引用` 按钮菜单正常，无 JS 异常。下一步 D4.1：右栏 3 段 + 扩图上下文。

- **D4.1 右栏 3 段 + 扩图上下文（已完成）** —— 右栏 tab 从 5 个（AI 修改 / 扩图 / 调整 / 蒙版 / 变换）收敛为 3 个（AI 修改 / 调整 / 变换），`.studio-tabs` 改 3 等分；扩图不再占常驻 tab，选中左栏「扩图 / 外补画布」工具时以上下文面板替换当前段显示，点任一 tab 自动 `setTool('view')` 回到常规段并复位工具。`setTool` 负责上下文切换：离开扩图时若当前段是 `outpaint` 则回落 `ai`；蒙版工具在 D4.2 浮条落地前暂以同样的上下文面板方式保留画笔参数（无 tab 高亮）。会话恢复新增 `normalizeTab()`，历史 `mask/outpaint` 仅在对应工具下保留，否则回落 `ai`。浏览器实测：tab 仅剩 3 项；扩图工具下扩图面板可见且无 tab 高亮；点「AI 修改」后扩图隐藏、工具复位 `view`；画笔工具下蒙版上下文面板可见；「变换」tab 正常高亮与切换。下一步 D4.2：蒙版工具浮条。

- **D4.2 蒙版工具浮条（已完成）** —— 删除右栏蒙版段，参数迁移到画布顶部浮条 `.studio-maskbar`：画笔类工具下拉（画笔 / 橡皮 / 矩形 / 椭圆 / 套索）、大小 / 硬度 / 不透明度三条滑杆（显示值与 `brush` 状态、快捷键共用）、导出蒙版 / 清除蒙版按钮；选中画笔类工具时浮条出现，切到查看 / 裁剪 / 扩图等工具自动隐藏，再用快捷键（如 `B`）可恢复。浮条 `left/right: 12px` 铺满画布宽度并 `flex-wrap`，窄栏下按钮自动落到第二行，不再裁切；会话恢复若上次停在画笔类工具，重新打开会直接显示浮条。浏览器实测：初始工具为画笔时浮条可见且下拉回显 `brush`；下拉切橡皮后左栏工具高亮同步、浮条保留；拖大小滑杆标签更新为 `96 px`；无蒙版时导出按钮禁用；切扩图工具后浮条隐藏且扩图上下文出现；点 AI tab 后工具复位 `view`、浮条隐藏；快捷键 `B` 再次唤起画笔与浮条；右栏蒙版节点已移除，导出 / 清除仍绑定新的浮条按钮。下一步 D4.3：AI 更多设置折叠。

- **D4.3 AI 更多设置折叠（已完成）** —— AI 面板改为渐进披露：常驻仅「指令（富文本）→ 参考图 → 修改 → 更多设置摘要 → 结果」，方案预设、本次保护、输出、高级设置、采样与 LoRA 统一收进 `.ai-more-body`，默认 `hidden`；折叠头 `.ai-more-head` 带旋转箭头、`aria-expanded` 与实时摘要 `预设 · 输出 W × H · Turbo N 步`。摘要由 `syncMoreSummary()` 统一维护，预设切换、输出模式 / 宽高、Turbo 方案变化都会即时刷新；提交按钮移到参考图之后，成为常驻区唯一主按钮，空白拦截与 Ctrl+Enter 不变。浏览器实测：默认折叠且摘要为「扩图 · 输出 160 × 100 · Turbo 9 步」，展开后 5 个分组齐全、预设网格 / 保护项 / 高级参数均正常挂载；切换预设摘要变为「局部编辑」、输出改指定 1024 后摘要同步「1024 × 1024」；再次折叠后摘要保留，反馈无 JS 异常。下一步 D5.1：左栏分组 + 顶栏菜单。

- **D5.1 左栏分组 + 顶栏导入/导出菜单（已完成）** —— 左栏按 §12.5 拆成 `TOOL_GROUPS` 四组（查看 / 选区 / 变换 / 生成），渲染为 `.studio-tool-group`，组间 1px 分隔线，组标题绝对定位在工具轨右侧、默认 `opacity:0`，hover 才显示文字；工具项仍用 `data-tool`，`setTool` 与快捷键完全未改。顶栏把原来的「收藏 / 复制 / 导出 JPG / 导出 PNG」四个按钮合并为「导出 ▾」下拉（导出 PNG / 导出 JPG / 导出蒙版 / 复制到剪贴板 / 收藏到素材仓库），复用导入菜单的交互模式：按钮点击与外部点击关闭、`aria-expanded` 同步、`ArrowDown/Up/Home/End/Escape` 键盘操作与焦点回落，两个菜单互斥（打开一个自动关另一个）。菜单项 `data-export` 分发到既有 `exportImage / copyToClipboard / collect`，导出蒙版直接复用 `doc.maskPng()`，无蒙版时提示「还没有涂抹蒙版」；`setDoc` 与导出过程中的禁用状态统一收敛到 `exportBtn`，与主按钮 `sendBtn` 同步。顺带修复顶栏下拉被画布内容遮住的问题：`.studio-bar` 加 `position:relative; z-index:30`（`backdrop-filter` 形成的层叠上下文原本把菜单压在 `.studio-body` 之下），导出菜单 `right:0` 右对齐避免溢出。移动端工具轨仍横向排列，分组改为左边框分隔并隐藏组标题。浏览器实测：4 组工具与顺序正确；导出菜单 5 项齐全且全部可见、右对齐；`Escape` 关闭并回落焦点到按钮、`ArrowDown` 打开并聚焦首项、外部点击关闭；点击「导出蒙版」在无蒙版时提示、涂抹后导出 `tab-test-mask.png`；「导出 PNG」触发 `tab-test-edited.png` 下载并在结束后恢复按钮；「复制到剪贴板」走 `clipboard.write` 并提示已复制；导入菜单与导出菜单互斥且都能外部点击关闭；hover「选区」组标题正常浮出；无 JS 异常。下一步 D5.2：视觉规范与响应式。

- **D5.2 视觉规范与响应式（已完成）** —— 三档宽度实测：1440 / 1280 / 1024 下 `documentElement.scrollWidth === innerWidth`，顶栏 `scrollWidth - clientWidth = 0`、tab 栏无溢出、画布按容器等比显示不变形；1024 时走桌面栅格（面板 262px + 工具轨 58px + 画布 542px），未触发 980 断点的纵向堆叠，布局仍可用。对比度按 WCAG 计算并修正：原先 `.ai-hint`（白底 3.21）、`.studio-status`（面板底 2.87）、`.studio-tool-key`（2.28）、`.ai-label`（2.54）均不达 AA，改为在 `.page-studio` 作用域内覆盖 `--dim: #6b6862`、`--muted: #6f6c66`（暗色单独覆盖 `--dim: #98a1a9`，暗色 `--muted` 原值已达标不改），实测亮色下提示 5.23 / 状态 4.69 / 快捷键角标 4.98 / 字段标签 5.55 / 组标题 5.59，暗色下 5.3~7.4，均 ≥ 4.5；覆盖只作用于工作室，不影响其他页面。浏览器实测：亮/暗两套截图目检正常，颜色加深后次要信息可读且不抢主标题，无 JS 异常。下一步 D5.3：裁剪性能优化。

- **D5.3 裁剪性能优化（已完成）** —— 裁剪框从 Canvas 挪到 DOM 覆盖层（`.studio-crop-overlay > .studio-crop-box`，`box-shadow: 0 0 0 9999px` 做外侧变暗、两层渐变做三分网格），`pointermove`（crop）只调 `syncCropOverlay()` 写 `left/top/width/height`，不再 `scheduleDraw()`；`draw()` 删除 `shadowBlur:26 / shadowOffsetY:10`，改为画布 CSS `filter: drop-shadow(...)`；`pointerdown` 缓存画布矩形到 `dragRect`，`pointermove` 不再 `getBoundingClientRect()`，`toImage` 增加可选 `rect` 参数；`syncCropOverlay` 做 1px 取整 + 样式缓存去重；新增 `localStorage.wb.studio.perf='1'` 探针，每 60 帧输出 draw 均值/最大值。§15.1 未做项 5（底图视口缓存）、6（文档版本号）明确留给 D18.2。4096² 实测：拖框 60 次 move 期间 `clearRect` 0 次、单次 move 平均 0.012ms / 最大 0.2ms；`1867 × 1244` 尺寸回显、应用裁剪后 `1,867 × 1,244`、覆盖层隐藏正确；画笔涂抹照常 2 帧重绘、覆盖率与撤销正常；截图目检选框虚线/网格/外遮罩与底图投影均正常，无 JS 异常。下一步 D6.1：M1 回归与文档。

- **D6.1 M1 回归与文档（已完成）** —— 按 §12.10 逐条回归并勾选。本轮新增验证：`buildEditPayload` 纯函数实测 `images` 顺序为 `[main, r2]`、`prompt` 中 `@图二/@图一` 正确映射为 `图2/图1`、越界 `@图五` 原样保留、`size_mode/steps/mask` 透传正确；`mapMentions('把 @图二 … @图一 …', 3)` 输出 `把 图2 … 图1 …`；粘贴图片在已有主图时进入参考图（参考图 +1）；`ClipboardEvent` 与拖拽链路均无异常。三档宽度复测 `scrollWidth === innerWidth`；裁剪拖动 4K 图 0 次画布重绘；导出菜单 PNG / JPG / 蒙版 / 复制 / 收藏全部可用。`python -m pytest tests -x -q` → **488 passed**（54s，日志中的 torch/CUDA 提示属环境信息，非失败）；浏览器 `exception` 级日志为空，控制台仅有后端未启动导致的 `ERR_CONNECTION_REFUSED`（环境限制，与前端无关）；`#t2i` 与 `#edit` 路由渲染正常（标题正确、编辑页高度 951px、无异常）。已知限制：素材仓库 / 最近结果依赖后端数据，本轮验证到入口与取图链路，未做真实取图回归。§12.10 十项全部勾选，M1 收口。

- **D16.1 本次任务 AI 编辑历史卡片（已完成）** —— 新增 `web/src/components/studio/sessionHistory.js`：一次任务 = 一个工程 id，元信息写 IndexedDB `wb-studio/aiHistory`（按 `sessionId` 归档，上限 30），结果原图写 `aiResults`（`result:<entryId>`），参考图按 `refId` 去重存 `ref:<refId>` 记录；缩略图统一转 320px WebP dataURL 随元信息持久化，结果原图只在内存缓存最近 6 张 objectURL 并按 LRU 回收。`append()` 支持同一 jobId 多张结果按子序号建卡片、同 id 去重、超限自动淘汰并删 blob；`refsFor()` 回退时把参考图还原为 dataURL，`ensureResultUrl()` 按需取结果图。新增 `web/src/components/studio/aiHistory.js`：AI 面板底部固定「编辑历史 N 次 / 清空」横向卡片轨道（缩略图、`#序号 时间`、指令摘要，当前结果高亮描边），hover / 聚焦显示「载入 · 对比 · 删除」底栏，支持 Tab、Enter 载入、`C` 对比、Delete 删除；空状态与清空二次确认齐备。`aiPanel.js` 在任务 `done` 后落卡片、`refresh()` 跟随工程切换会话、载入历史时先 `adoptResult` 重建文档再恢复参考图与指令（裁剪/旋转/调色/蒙版随新文档重置），运行中禁用载入。`studio.js` 的 AI ctx 追加 `getSessionId()` 与 `hasDocChanges()`，仅当撤销栈非空时载入前二次确认。浏览器实测（后端未启动，用页内动态 import 模拟成功任务写入历史）：写入后刷新仍见卡片与缩略图、计数「1 次」、空状态/清空按钮显隐正确；点击卡片载入后主图变为 `perf-4k-精修.png · 480 × 360`、指令 `把橙色圆形换成蓝色方块，保留背景` 恢复、卡片高亮且原图未变；Delete 删除只减记录不改画面；3 条记录时清空弹窗文案与「清空」入口正确，确认后卡片与 `aiHistory` 记录同时归零；卡片「对比」可拉起 `compare.js` 竖线对比且标签为「历史 #1 · …」。控制台仅环境类 `ERR_CONNECTION_REFUSED / 404`，无 JS 异常。已知限制：未接真实后端任务，`quality` 诊断标签沿用现有结果区；§14.3 模块表中的 `panels/aiHistory.js` 实际落在 `studio/aiHistory.js`。

- **D16.2 图片对比（已完成）** —— 新增 `web/src/components/studio/compareLauncher.js`：统一把候选图整理成 `compare.js` 需要的结构（`references = 本次结果 + AI 参考图 + 编辑历史`，`results = [{ label: '当前主图' }]`），不改 `compare.js`。当前主图由 `studio.js` 新增的 `getMainImage()` 调 `doc.bake('image/png')` 烘焙；历史图沿用 `sessionHistory` 的 Blob 读取，并给 `ensureResultUrl()` 增加 `pin` 选项——对比弹窗正在展示的 objectURL 不参与 6 张 LRU 回收，避免图片地址被提前释放。四个入口全部接到同一函数：顶栏「对比」按钮（`compareAllBtn`，随文档启用）、AI 结果卡片「与底图对比」（把 `runner.getResults()` 一并作为本次结果候选）、历史卡片 hover「对比」（按 `initialHistoryId` 预选该条）、`Shift+C`（在工具快捷键前拦截，不抢 `C` 裁剪）。原 `studio.js` 的 `ctx.compare` 与 `openCompareDialog` 引入已删除，避免两套组装逻辑。浏览器实测（模拟 2 条历史记录）：顶栏对比弹出选择面板，参考图 2 张（历史 #2/#1），结果图自动选中「当前主图」；点「开始对比」进入竖线对比并算出像素统计（测试图为纯色块，平均差异 50.5 / 255，仅验证链路，不代表真实结果质量）；点历史 #1 卡片的「对比」，弹窗预选 `历史 #1`；`Shift+C` 正常打开；关闭后画布、工具、滚动位置不变；`exception` 日志为空。已知限制：AI 真实结果卡片未接后端实测，但与历史卡片共用同一 `compareAll()`；4K 主图烘焙 PNG 有一次性耗时，入口在生成任务进行中时由面板 toast 拦截。

- **D18.1 性能探针与基线（已完成）** —— 新增 `web/src/components/studio/perf.js`：`createPerfProbe(label,{window=60})` 返回 `start/end/hit/reset/snapshot`，`end()` 记录一帧耗时并每 60 帧 `console.info` 一次（含 `performance.memory` 堆提示）；`perfSnapshot()/perfReset()` 汇总全部探针并挂到 `window.__wbPerf`，方便分场景 `reset → 操作 → snapshot`。开关仍是 `localStorage['wb.studio.perf']='1'`，关闭时所有方法零成本。`studio.js` 删除原内联 `perfOn / perfFrames / t0 / 60 帧日志`（约 10 行），改为顶部 `import { createPerfProbe }` + `const perf = createPerfProbe('studio.draw')`，`draw()` 用 `perf.start()/perf.end(t0)`，空文档提前 return 分支也会记一帧。`imageTools.js` / `maskEditor.js` 属同事 WIP（高清放大接入），本轮**未接入探针**，图像工具基线改用页面级「rAF 帧间隔 + 同步 dispatch 耗时」测量，避免改冲突文件。4K（4096×4096）实测：平移 draw 0.20ms 均 / 0.40ms 峰（41 帧）、缩放 0.13ms 均 / 0.30ms 峰（20 帧）—— 平移缩放只做缓存底图 blit，已远低于 16ms；蒙版涂抹 45.15ms 均 / 144.2ms 峰、叠加层拖动 102.06ms 均 / 127.5ms 峰、调色滑杆 123.62ms 均 / 162.8ms 峰 —— 三者每帧都在重建 4K 合成（`renderMaskTint` 全图重绘 / `invalidateBase` 全量重绘），是 D18.2 的主要目标；图像工具裁剪拖动帧间隔 30.43ms 均 / 51.2ms 峰（40 帧中 39 帧超标，同步 dispatch 仅 0.09ms/move，说明耗时在每次 move 的异步 `render()` 全量重建工作画布），留给 D18.3。历史内存：4K 蒙版单步快照 67MB，`HISTORY_BUDGET = 256MB` 生效 —— 连续 20 次快照后实测只剩 3 步可撤销（≈201MB，符合预算），JS 堆 20 步增量 <10MB（headless 下 `performance.memory` 被量化，仅作趋势参考）。测试数据（`p-mw6i8p9i-5oh3qe` 工程及其 `layers/refs` 记录）已清理，工作区不改他人文件。已知限制：headless 无 GPU 合成差异未覆盖，待 D18.4 在真实浏览器与 DPR 2 下复测。数据同步写入 §17.6 基线表。

- **D18.2 工作室交互优化（已完成）** —— 三处根因分别处理：
  1. **蒙版涂抹 45.15ms → 3.48ms**：`studioDoc.renderMaskTint(rect)` 支持脏矩形增量重绘（clip + 子区域 `drawImage` + `source-in` 填充），`stampMask()` 累积画笔包围盒 `tintRect`，只有裁剪/旋转/清空等 `tintDirty=true` 才整图重算；tint 画布尺寸变化时自动退回全量，避免假脏。
  2. **叠加层拖动 102.06ms → 2.39ms**：`studioDoc` 把「原图+变换+调色+裁剪」拆成 `renderUnderlay()` 独立缓存，`renderBase()` 只在有叠加层时复制一层并画图层；`invalidateBase()` 同时清 `_base/_underlay`，`touchLayers()/setOverlayOpacity()/scaleOverlay()` 只清 `_base`。拖动中的叠加层走 `drag.mode==='moveLayer'` 分支：底图用缓存的 underlay，图层按视口变换实时画在 `ctx` 上，不再每帧重建 4K。
  3. **调色滑杆 123.62ms → 7.96ms**：拖动（`input`）期间 `adjustPreview=true`，`draw()` 改用 `doc.renderPreviewBase(1024)`（从原图按 1/4 边长重建，滤镜与柔光同源实现，不写缓存）；`change` 时 `flushAdjustPreview()` 丢掉 `_base/_underlay` 并全分辨率重合成一次（实测 126.7ms，一次性成本），同时 `syncAdjustInputs()/setDoc()/导出/复制/收藏/送编辑/对比/缩略图` 都先 flush，保证「所见即所得」。
  4. 平移/缩放维持缓存 blit（3.20ms / 2.15ms，含 1 个叠加层与蒙版）；历史预算与 `bakeBlob()→toBlob` 异步导出保持现状。顺带修复 `restore()` 未清 `_underlay/_tint` 导致的撤销后残留旧底图问题。4K 实测前后对比已写入 §17.6；截图 `.screenshots/d18-optimized-studio-*.png`。测试工程与 `layers/refs` 记录已清理；`imageTools.js` 未改动，仍留给 D18.3。

- **D18.3 图像工具与蒙版编辑器优化（已完成）** —— 开工前确认同事的高清放大 WIP 已提交（`91eb15a feat(image-tools): WD14 反推标签`、`0af4c87 refactor(upscale): VOSR2 本地推理`），`imageTools.js` 工作区干净后才动手：
  1. **裁剪拖动 30.43ms → 16.68ms（锁到刷新率）**：`render()` 拆成「工作画布构建」与「显示/叠加层刷新」两段，新增 `workKey` 签名（源图对象 + `stagedOps` 长度 + 末位操作引用 + 扩图结果引用）与 `workStale()`；拖动选框时 `workStale()` 为假，直接跳过 `loadSourceImage + applyOpsToCanvas` 全量重建。同步 dispatch 40 次 `pointermove` 由 0.09ms/move（旧链路里其实还叠加异步重算）降到 **0.003ms/move**，不再堆积任务。
  2. **不重设画布尺寸**：新增 `displayStamp{width,height,dpr}` 与 `syncCanvasSize()`，只有显示尺寸 / DPR 变化时才写 `canvas.width/height`；窗口 resize（1200×800 → 1440×900）实测画布 382 → 438 正确重分配且底图重绘、滤镜保留。
  3. **rAF 合并 + 只画叠加层**：`scheduleOverlay()` 把裁剪拖动、水印拖动合并到一帧一次的 `paintOverlayOnly()`（只 `drawOverlay()` + 读数），旧代码每 move 都跑 `render()`。
  4. **调色不被缓存误伤**：CSS `filter` 原先写在重建分支里，改为每次 `render()` 都按 `stagedOps+state.adjust` 同步，拖动 1.35 亮度后 `filter: brightness(1.35)` 立即生效且工作画布未重建（回归通过）。
  5. **蒙版编辑器实测达标、不改代码**：用页内 `import('/src/components/maskEditor.js')` 起独立 4K 实例（4096² 底图 + 4096² 蒙版/预览，视口 1050×820、viewScale 0.195），连续画笔 40 帧 **16.55ms 均 / 22.7ms 峰**，已由 `requestDraw()` 的 rAF 合并 + 显示分辨率视图层兜住，无需降采样或脏矩形改造。
  实测前后同环境（headless Chromium 1440×900、DPR 1、4096² 测试图、显示 438×438 / 11%）：裁剪拖动 resize 40 帧 **16.68ms 均 / 18.0ms 峰 / 20 帧 >16.7ms**（D18.1 基线 30.43 / 51.2 / 39 帧）；水印拖动 16.63ms 均 / 17.9ms 峰。正确性回归：应用裁剪后工作尺寸 4096² → 187²，`裁剪输出` 回「整图」、操作史 1 步、撤销后恢复 4096²；叠加层 `imageCanvas` 中心像素 `[130,124,113,255]` 非空、`overlayCanvas` 顶边白线存在；截图 `.screenshots/d18-3-image-tools-after-*.png`、`.screenshots/d18-3-crop-resize-*.png`。已知：合成 PointerEvent 下 `setPointerCapture` 会抛 `NotFoundError`（仅测试脚本问题，测试前 stub 掉该 API），控制台无应用侧异常；DPR 2 与真实浏览器留待 D18.4。

- **D18.4 性能回归基准（已完成）** —— 目标是把 D18.1~D18.3 的结论固化成可复用的回归口径，不改渲染逻辑：
  1. **通用帧间隔基准**：`perf.js` 新增导出 `measureFrames(count=40, tick, {budget=16.7})`，按 rAF 采样帧间隔并返回 `{ frames, avg, peak, over16, total }`；`tick(i, count)` 供调用方驱动一次拖动，采样过程不依赖探针开关，headless / headed 都能直接跑。同时挂到 `window.__wbPerf.measure`，控制台一行命令即可复测（§17.6.1「复测方法」第 3 步）。
  2. **DPR 2 复测**：headless Chromium 无法用启动参数改 DPR（`playwright_resize {device:'iPad Pro 11'}` 只改视口，实测页面 `devicePixelRatio` 仍为 1），改用 `Object.defineProperty(window,'devicePixelRatio',{get:()=>2})` 后触发一次 stage 尺寸变化让 `sizeCanvas()` 重算，验证到后备存储 922×970 / CSS 461×485（翻倍路径生效）。4K 底图 + 800² 叠加层 + 已涂蒙版下，四个交互 `draw()` 均 <16ms：缩放 0.21ms、蒙版涂抹 5.93ms、叠加层拖动 5.94ms、调色拖动 13.74ms（含松手一次 133.3ms 全量合成，一次性成本）。
  3. **真实浏览器（headed DPR 1、1440×900、canvas 698）复测**：`draw()` 缩放 0.37ms / 蒙版 0.64ms / 叠加层 0.48ms / 调色 3.07ms，全部不高于 headless 同场景；但自动化环境窗口被系统遮挡，rAF 被节流到 ~1fps，帧间隔数据不可用，已在文档中标注，只采用 `draw()`。
  4. **结论与遗留**：DPR 2 下叠加层拖动帧间隔 25.92ms 明显高于 `draw()` 5.94ms，差异在合成器侧（4 倍像素的软件光栅化），不在 JS 渲染管线；真实 HiDPI GPU 浏览器需人工目检。若后续要再降延迟，调色代理可从 1024 降到 720，叠加层拖动可暂停非必要 DOM 层刷新（均未落地，只作备注）。
  数据与复测步骤写入 §17.6 / §17.6.1，台账 §14.12 收口；本轮只改 `perf.js` 与本文档，未触碰 `studio.js` / `imageTools.js` / `maskEditor.js`，工作区无冲突。

- **D18.5 M1C / M1D 验收收口（已完成）** —— 按 §17.7 四条逐项实测（headless Chromium，4096² 底图，DPR 2：CSS 768×531 / 后备存储 1536×1062）：
  1. **帧耗时**：缩放 9.85ms 均 / 14.0ms 峰、蒙版涂抹 9.11 / 12.1、调色拖动 15.49 / 33.7（1024 代理），松手一次全量合成 164.3ms；三项均值均 <16ms。另跑 60s 混合操作（292 轮、1585 帧 `draw()`）探针均值 27.96ms / 峰 154.2ms —— 该均值混入了撤销/重做整图恢复与工具切换，只作趋势参考，不作为交互帧基线。
  2. **内存**：60s 连续混合操作（画笔 / 橡皮 / 矩形 / 椭圆 / 套索 / 平移 + 调色 + 撤销重做，每 1s 采样）`usedJSHeapSize` 全程 73MB、无增长趋势（Canvas 后备存储在 JS 堆外，Chrome 对 `performance.memory` 有量化）；操作后撤销栈实测 **3 步**、重做 3 步 —— 4K 蒙版单步 67MB，`HISTORY_BUDGET = 256MB` 预算淘汰按预期生效。
  3. **功能与导出一致性**：`StudioDoc`（1000×800）裁剪 (100,80,500,400) 后 `size` 与 `exportCanvas` 均为 500×400；蒙版覆盖 **5.00%**（200×200 / 1000×800），裁剪后仍 5.00%、蒙版视图随裁剪变 500×400；叠加层默认居中 (150,150)、不透明度 1；曝光 +40 后采样点 `51,102,204 → 67,134,255`，再加对比度 30 → `48,135,255`；`exportCanvas` 与 `renderBase` 尺寸相同且 3 个采样点像素逐字节一致（所见即所得）；撤销 / 重做 / 旋转后撤销尺寸回滚正确。工作室真实导出（4096²、已涂蒙版 + 调色）：PNG 4096×4096 / 15.07MB、JPG 4096×4096 / 305KB、蒙版 PNG 4096×4096 / 904KB，解码后 8×8 采样 22~24 种颜色（非空白）。
  4. **真机 GPU 目检**：自动化环境无法覆盖 HiDPI 真实合成器差异（D18.4 已记录 headed 窗口被遮挡时 rAF 被节流），保留为人工项，不阻塞本条销项。
  5. **S-25 实测**：在 iframe 新 realm 中把 `CanvasRenderingContext2D.prototype.filter` 改为「setter 空实现、读取恒为 `none`」，再动态 import `studioDoc.js`，得到 `supportsCanvasFilter === false`（同页主 realm 仍为 `true`），探针能正确识别不支持环境；该分支下 `applyCanvasFilterCapability()` 禁用曝光 / 亮度 / 对比度 / 饱和度四个滑杆并显示说明，色温与色调保留。

- **D7.1 文档模型 + 图层创建（已完成）** —— 把原先散在 `StudioDoc` 里的叠加层数组抽成独立图层栈内核：
  - 新增 `studio/document.js`：`createDocument({width,height})` 产出 `{ width, height, layers, activeId }`；`addLayer(doc, layer, {index, activate})`、`removeLayer(doc, id)`、`moveLayer(doc, id, toIndex)`、`cloneLayer(doc, id, {offset, name, index})`、`findLayer / indexOf / layerCount / layersOf`。全部是零依赖纯函数，约定 `layers[0]` 为最底层、末尾为最上层；`moveLayer` 越界会裁剪，位置未变返回 `-1`（避免产生空撤销步）。
  - `studioDoc.js`：`this._doc = createDocument(this.oriented)`，`layers` 改为访问器（外部读写语义不变，`rotate/flip` 里 `this.layers = []` 照旧可用）；`addOverlay` / `removeOverlay` 改走内核并补 `_base = null`；新增 `cloneOverlay(id)`（副本上移 16px）与 `moveOverlay(id, toIndex)`，两者都会 `snapshot()`，可撤销。
  - `layers.js`：`OverlayLayer.clone({ fresh })` 支持 `fresh: true` 时生成新 id，复制图层不再撞 id；快照/恢复仍用默认 `fresh: false`。
  - `studio.js`：图层控制器新增 `cloneLayer(id)`（同步沿用源图层 Blob，便于自动保存）与 `moveLayer(id, delta)`（把 delta 换算成目标下标），操作后统一 `updateHistoryUi / scheduleSave / scheduleDraw`。
  - `aiPanel.js`：图层条每行新增「⧉ 复制 / ↓ 下移 / ↑ 上移」三个小按钮，事件里调用 `ctx.cloneLayer` / `ctx.moveLayer` 后重绘列表。
  - 实测（headless Chromium，1024×768 工程，叠加 `overlay-a.png` + `overlay-b.png`）：初始 `[a, b]` → 复制后 `[a, a 副本, b]`（副本紧跟源层上方）；对已在顶层的 `b` 点「上移」为 no-op；`b` 点「下移」→ `[a, b, a 副本]`；删除首层后剩两层，`撤销` 逐级还原到空；全程控制台无报错。
  - 范围说明：`history.js`（D7.4）与 `renderer.js`（D7.2）当时未拆分，图层渲染仍由 `studioDoc.renderBase()` 统一合成（已被 §17.7 导出像素一致性覆盖）；`docToJSON/fromJSON` 在 D7.3 复核后确认不需要——工程持久化已用「Blob + props」保存图层，不再引入第二条 JSON 路径。

- **D7.2 合成渲染器（已完成）** —— 把图层合成从 `studioDoc` 里抽成独立模块：
  - 新增 `studio/renderer.js`：`drawLayers(ctx, layers, { crop })` 按 `layers[0] → 末尾` 顺序逐层 `draw`，`crop` 非空时先 `ctx.translate(-crop.x, -crop.y)`；`composite(ctx, underlay, layers, { crop })` 先画底图再叠图层。全程 `save/restore`，不泄漏变换状态。
  - `studioDoc.renderBase()` 改为 `composite(canvas.getContext('2d'), underlay, this.layers, { crop: this.transform.crop })`，底图与图层的绘制顺序集中到一处，后续新图层类型（文字/贴纸）只需实现 `draw(ctx)`。
  - 实测（模块级，独立 canvas）：底层红 40×40、顶层绿 40×40，输出中心为绿、中心外为底；`drawLayers` 传 `crop={x:10,y:10}` 后图形整体左移 10px，与 `composite` 的裁剪语义一致；页面级导出/渲染像素一致性回归沿用 §17.7 结论，未回退。

- **D7.4 历史记录 + 快捷键（已完成）** —— 把撤销栈从 `studioDoc` 内部数组抽成独立模块并加字节预算：
  - 新增 `studio/history.js`：`createHistory({ limit = 30, budget = 256MB })`，`past/future` 双栈 + 累计 `bytes`；`push` 后先按步数裁尾、再按预算淘汰，且**至少保留「初始 + 最新」两帧**，否则撤销会直接失效；新 `push` 清空 `future`；`undo` / `redo` 同步维护字节计数；`clear()` 归零。
  - `studioDoc`：`snapshot/undo/redo/canUndo/canRedo` 全部委托 `_history`，新增 `historyBytes` 与 `clearHistory()`；`studio.js` 工程恢复处改为 `next.clearHistory(); next.snapshot();`，避免旧工程快照串项目。
  - 快捷键沿用既有绑定（`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 重做，输入框内不触发），本轮只换内核不改按键映射。
  - 实测（模块级）：`limit=3` 连推 6 帧 → `past=[3,4,5]`；`budget=100`、每帧 40B 连推 10 帧 → `past=[8,9]`、`bytes=80`（保留最新两帧）；三次 `undo` 返回 `1 / 0 / null`，`redo` 返回 `1`，新 `push` 后 `canRedo=false`、`past=[0,1,9]`，`clear()` 后 `past=0 / bytes=0`。页面级（1024×768 工程）：恢复工程后 `undoBtn.disabled=true`（`clearHistory` 生效）；蒙版画笔 4 笔后撤销可用、重做不可用，连点撤销 4 次回到初始（按钮转禁用），重做 2 次恢复；控制台无报错。
  - 遗留：图层维度的历史断言（复制/排序/锁定/不透明度可撤销）并入 D7.3 图层面板实测。

- **D7.3 图层面板（已完成）** —— 把 AI 面板里的图层条拆成独立模块，补齐拖拽排序、重命名、锁定与不透明度：
  - 新增 `studio/layerPanel.js`：`createLayerPanel(host, ctx)` 返回 `{ render }`，一次绑定 click / input / change / dblclick / drag* 事件。行结构新增拖拽手柄 `.ai-layer-grip`、锁定按钮 `[data-layer-lock]`（🔒/🔓），其余按钮与不透明度滑杆沿用；所有状态变更回调 `ctx`，模块本身不持有文档。
  - 交互语义：双击图层名就地变输入框（Enter 提交、Esc 取消、失焦提交）；拖拽行到目标行即落到该行下标（调用新增的 `ctx.moveLayerTo(id, index)`）；锁定后 `OverlayLayer.hitTest()` 直接返回 `false`，画布上不可点选/拖动，但仍参与合成；锁定图层若正被选中会清空选中态。
  - `layers.js`：`OverlayLayer` 增加 `locked` 字段（构造参数 + `clone()` 透传），锁定只影响命中测试，不影响绘制。
  - `studio.js`：图层控制器新增 `moveLayerTo / renameLayer / toggleLayerLock`，三者都 `commitLayers()` 入撤销栈；工程保存的 `props` 增加 `locked`，恢复时经 `addOverlay({ locked })` 还原（`studioDoc.addOverlay` 同时补上 `rotation`/`locked` 入参）。
  - `aiPanel.js`：`renderLayers()` 改为 `layerPanel.render()`；删除原来的图层按钮事件与重复的 `input`/`change` 监听，避免「一次拖动写两帧快照、撤销原地不动」。
  - `studio.css`：追加 `.ai-layer-grip`、`.ai-layer.is-dragging`、`.ai-layer.is-drop`、`.ai-layer.is-locked`、`.ai-layer-rename`。
  - 实测（headless Chromium，1024×768 主图 + 恢复工程图层 + 两张扣图；截图 `.cache/shots/d7-3-layer-panel-2026-11-07T16-51-38-616Z.png`）：双击重命名 `overlay-a.png → 前景 A`、撤销还原；锁定后行变 `is-locked`、字形 `🔒`、提示「解锁图层」，撤销解除；拖拽首行到末行 `[ov-7, ov-2, ov-3] → [ov-2, ov-3, ov-7]`，撤销还原；不透明度 `35 → 80` 撤销回 `35`、重做回 `80`。模块级：锁定图层 `hitTest(50,50) = false`、未锁定 `true`、`clone()` 保留 `locked`、`clone({fresh:true})` 换新 id。控制台无 exception。
  - 序列化取舍：计划中的 `docToJSON/fromJSON` **未实现**——工程持久化（D17.1）已经用「主图 Blob + 图层 Blob + props」完整保存/恢复图层，再加一层 JSON 序列化没有调用方，等真正需要导出/导入工程文件时再做。

- **D15.1 高清放大入口（已完成）** —— 顶栏新增「放大」按钮（`data-ref="upscaleBtn"`，无主图禁用；AI 预览态先被 `previewBlocked('放大')` 拦住，避免放大错版本）。点击后打开 `studio/upscaleDialog.js` 弹窗：
  - 引擎来自 `api.upscaleModels()` 的 `ready` 项，文案映射 VOSR2 细节优先 / SeedVR2 质量优先 / FlashVSR 速度优先，默认取响应的 `default_engine`；倍率 2× / 4×，默认取 `defaults.scale`。
  - 输入是 `doc.bake('image/png')`（含变换、调色、叠加层），提交 `api.upscale({ image, engine, scale })`，用 `pollJob` 每 700ms 刷新进度条与状态文案；失败/取消/超时都有明确状态，可中途「取消任务」（`api.cancelJob`）。
  - 完成后结果卡片显示 `宽 × 高` 与文件名，「载入为主图」走 `openUrl(url, name-2x.png)` 成为新工程（可继续编辑、导出、送编辑），「与当前主图对比」走 `ai.compareAll({ extra: [{ url, label: '放大结果' }] })` 复用竖线对比。
  - 实测（headless Chromium，512×384 底图，vosr2 2×）：弹窗正确列出 3 个就绪引擎、VOSR2 与 2× 默认选中、提示「当前画面 512 × 384」；任务 ~1.5s 完成，结果卡显示 `1,024 × 768 · out-…_upscale-vosr2.png` 且缩略图 `naturalWidth = 1024`；载入后顶栏尺寸变 `1,024 × 768`、文件名 `…-2x.png`、弹窗关闭。
  - 已知取舍：载入结果会 `beginProject()` 开新工程，旧工程历史不参与对比栈；需要前后对照时请在弹窗内先点「与当前主图对比」。

- **D0.1 预检与基线（已完成·补记）** —— 该项在 M0 阶段已随 D6.1 / D18.1 实际完成，本轮补齐证据与记录：工作区快照见 §0 与 §14.2（他人未提交文件每次开工前复核）；三页基线截图本轮重新采集到 `.cache/shots/baseline-2026-11-07-{t2i,edit,studio}-*.png`（1440×900、Chromium headless），文生图 / 图像编辑 / 图片精修均正常渲染，`exception` 日志为空；测试基线 `python -m pytest tests` → **497 passed（46.33s）**（计划编写时 419，D6.1 时 488）；`node -v` → **v24.13.0**（≥18，可用内置 `node --test`）；浏览器基线以 Chromium 为准，Safari 抽检未做（不阻塞验收）。原计划目录 `.cache/shots/` 此前未落地，本轮已创建并补齐。
- **D8.1 选区核心（已完成）** —— 新增 `web/src/components/studio/selection.js`（纯函数、零依赖，Node 可直接冒烟）：
  - 坐标系：选区统一为 `Uint8ClampedArray` alpha 蒙版（0~255），尺寸与 `doc.mask` 一致（旋转后、未裁剪），显示时按 `crop` 偏移平移，与文档蒙版共用同一套坐标，避免旋转/裁剪后错位。
  - API：`createAlpha / rectAlpha / ellipseAlpha / lassoAlpha / wandAlpha / combineAlpha / invertAlpha / featherAlpha / expandAlpha / contractAlpha / coverageAlpha / boundsAlpha / alphaToCanvas / canvasToAlpha / buildOutlinePath`。
  - 算法：魔棒从 `doc.renderBase()` 取 RGBA，按 RGB 三通道最大差 ≤ 容差判定相似，`contiguous` 用 `Int32Array` 栈做 BFS 洪泛，否则全图取样；羽化 = 三次盒式模糊（Float32 前缀和，O(n)）；扩展/收缩 = 二值形态学（Uint8 行列前缀和分离式膨胀/腐蚀）；蚂蚁线由 `buildOutlinePath` 按 step 采样生成 `Path2D` 边线段，超过 6000 段自动翻倍 step 降采样。
  - UI：左栏「选区」组新增魔棒（`W`），画布底部新增 `.studio-selbar` 浮条——容差 0~255、连续、半径、反选 / 羽化 / 扩展 / 收缩 / 清除选区与「选区 N%」读数；Shift 加选、Alt 减选、Shift+Alt 交集，单击即完成。
  - 蚂蚁线：`draw()` 在蒙版着色之后、形状预览之前，按 `view` 平移缩放后画「黑描边 + 白色虚线」，`lineDashOffset` 由 120ms 定时器推进，切换工具/清除选区即 `stopAnts()`。
  - 与画笔联动：`stampMask` 先把 dab 画进小尺寸 scratch，再 `destination-in` 选区后合成回蒙版（整图 scratch 只用于形状/套索），避免每笔整图合成；`commitShapePaint` 同样支持选区裁剪。
  - 实测（headless Chromium 1440×900，800×600 底图）：魔棒点黄色圆 → `选区 5.3%`，浮条显示「容差 32 / 连续 / 半径 8」；扩展 → 6.5%、收缩 → 5.3%、羽化 → 5.2%、反选 → 94.8%、清除 → 「未选区」；截图 `.cache/shots/d81-wand-ants-*.png` 可见流动虚线；在选区内跨红/蓝涂抹后文档蒙版仅存在于圆内（覆盖率 2.3%，截图 `.cache/shots/d81-brush-clip-*.png`）；模块级 Node 冒烟：rect 0.16 / bounds(3,3,4,4)、invert 0.84、feather 有软边、expand 0.36、contract 0.04、wand 0.5、add 0.58。

- **D8.2 图层蒙版（已完成）** —— 让叠加层拥有独立于文档的像素蒙版：
  - `layers.js`：`OverlayLayer` 增加 `mask / maskVisible / _masked`，`ensureMask()` 建全白（= 完全显示）蒙版，`maskedImage()` 用 `destination-in` 把蒙版合到图层位图并缓存，`touchMask()` 失效缓存；`toggleMaskVisible / removeMask / hasMask` + `naturalWidth/naturalHeight` 访问器；`clone()` 深拷贝蒙版与显隐。
  - 语义：白 = 显示。画笔 `destination-out` 挖掉蒙版（隐藏），橡皮 `source-over` 补白（恢复）；形状/套索涂抹同样走 `destination-out`。首版误用「白色 source-over」，表现为涂抹毫无效果，实测采样仍是原绿色后修正。
  - 坐标映射：新增 `docToLayerTransform()`，把 doc 空间（含 crop 偏移、图层 x/y/scale/rotation）的一次性 dab 仿射到图层自身像素坐标，旋转/缩放图层也能正确涂抹。
  - UI：图层面板每行新增 `◐`（添加/显隐蒙版，Shift 点击删除）与 `✎`（进入涂抹模式，仅有蒙版时显示，激活时高亮）；进入后自动切画笔并提示「画笔隐藏，橡皮擦恢复」，切到非蒙版工具自动退出。
  - 联动与持久化：`stampMask` / `commitShapePaint` 优先写图层蒙版，选区存在时同样按选区裁剪；图层蒙版涂抹松手后走 `doc.commitLayers()` 落快照（不动文档蒙版状态），撤销/重做与图层几何共用一套历史；工程保存为每个图层追加 `hasMask / maskVisible` 与 `maskBlob`（PNG），恢复时载入 `ensureMask()` 并 `touchMask()`。
  - 实测（headless Chromium，800×600 底图 + 200×200 绿色叠加层）：`✎` 进入后按钮高亮、工具切画笔；竖向涂抹后该区域露出底图红色 `[192,57,43]`、未涂抹处仍为绿色 `[102,212,115]`；切橡皮擦回同一条带恢复绿色；`◐` 关闭蒙版后条带恢复绿色、再开启复原；Shift+点击 `◐` 删除蒙版（按钮回到「添加图层蒙版」）；切「抓手」后 `✎` 取消高亮；`Ctrl+Z` 撤销回绿色、`Ctrl+Shift+Z` 重做回红色；选区联动——先魔棒选黄色圆（5.3%）再涂图层无任何变化，清除选区后同一笔立即生效；等待自动保存后刷新 `?cb=5#studio`，图层仍是 `has-mask` 且条带保持被挖空。截图 `.cache/shots/d82-layer-mask-*.png`、`d82-paint1-*.png`、`d82-eraser-*.png`。

- **D9.1 调色数学库（已完成）** —— 新增 `web/src/components/studio/color.js`，纯函数、零依赖：
  - 曲线：控制点排序去重 → Fritsch–Carlson 单调三次插值（限制切线，避免过冲/反转）→ 256 项 LUT；`buildChannelLUTs({rgb,r,g,b})` 分别生成复合与单通道 LUT，`applyChannelLUTs` 先查复合表再三通道表。
  - 色阶：`buildLevelsLUT({black,white,gamma,outBlack,outWhite})`，输入区间归一化 → `t^(1/gamma)` → 输出区间映射；`applyLevels` 原地查表。
  - HSL：标准 `rgbToHsl/hslToRgb`（h 0~360°，s/l 0~1）；`HSL_BANDS` 定义 8 个色相带（0/45/90/135/180/225/270/315），`applyHSL` 按色相角距离加权（默认 40° 过渡），重叠处加权平均后再调 H/S/L，s/l 用「向 0 或 1 靠拢」的单调映射，±100 可到纯灰或纯色。
  - 色彩平衡：按感知亮度分阴影/中间调/高光三段重叠权重（和为 1），逐段施加 RGB 偏移，默认把亮度差加回三通道（`preserveLuma`）保证总亮度不变。
  - 白平衡：`kelvinToGains` 近似 Tanner Helland 黑体公式；`whiteBalanceGains({temperature,tint})` 中滑杆正向对应更低色温（更暖），色调正向压低绿通道（偏洋红），最后按感知亮度归一，既保亮度又保留色偏；`grayPointGains(r,g,b)` 用灰点反推增益，`applyGains(data, gains, strength)` 支持吸取后渐入。
  - 单测：`web/tests/studio/color.test.mjs` 共 23 项，覆盖恒等曲线、控制点命中、单调性、S 形对比、复合/单通道 LUT、色阶裁切与 gamma、RGB↔HSL 往返、8 色带不串色、色相偏移 +60° 得黄、过渡区加权、色彩平衡分区/保亮度、色温冷暖方向、色调洋红/绿方向、灰点还原、增益强度渐入；`node --test web/tests/studio/color.test.mjs` → `pass 23 / fail 0`。
  - 说明：`.cube` LUT 解析与直方图统计随 D9.2 继续追加到同一模块；面板接线（`panels/adjust.js`）留到 D9.3。

- **D9.2 直方图 + LUT（已完成）** —— 调色面板可视化与 3D LUT 落地：
  - 直方图：`histogram(data, {sampleLimit=200000})` 按步长抽样，输出 R/G/B/亮度四组 256 桶 + 阴影/高光削波比例；面板用 `doc.renderPreviewBase(320)` 取样（约 7.7 万像素），`draw()` 内 120ms 节流刷新，切到「调色」页签强制刷新一次。绘制为亮度底 + RGB `lighter` 叠色，附 1/4 网格与「77k 像素 / 无削波」读数。
  - `.cube`：`parseCube(text)` 支持 `TITLE / LUT_3D_SIZE / DOMAIN_MIN / DOMAIN_MAX`，校验数据长度（`size³×3`），明确拒绝 `LUT_1D_SIZE`；`sampleCube` 用三线性插值，`applyCube(data, cube, strength)` 按强度与原像素混合。
  - 渲染管线：`ADJUST_DEFAULTS.lut = null`；`studioDoc._applyLut(canvas)` 在 `renderUnderlay()` 与 `renderPreviewBase()` 末尾各执行一次，结果随 `_underlay` 缓存，拖动叠加层不重复计算。调色（含 LUT）作用于底图，与曝光/亮度等既有行为一致，不影响叠加层。
  - 面板：调色页签顶部加直方图；底部「3D LUT」区块支持加载 `.cube`、强度 0~100、移除，未加载时强度与移除禁用；加载/强度提交/移除都会 `invalidateBase + snapshot`，可撤销。LUT 体积大（33³×Float32）且来自本地文件，会话保存时主动剔除，刷新后需重新加载（界面有提示）。
  - 顺手修复：调色滑杆 `input` 时补 `invalidateBase()`——此前小图（≤1024）在 `renderPreviewBase` 里直接复用 `renderBase` 缓存，拖动期间画面不刷新；修复后曝光 60 实时变为 `[255,86,65]`，复位回 `[192,57,43]`。
  - 实测（headless Chromium 1440×900，800×600 底图）：直方图绘制 1246/21600 像素、读数「77k 像素 / 无削波」；注入 2³ 反相 `.cube` 后底图 `[192,57,43] → [63,198,212]`（青色），强度 40% 实时得 `[140,113,111]`（理论 140/113/111），移除后回 `[192,57,43]`，撤销同样还原并同步 UI；单测新增 6 项（解析、拒绝 1D、恒等采样、反相强度、直方图分箱、削波），`node --test` → `pass 29 / fail 0`。截图 `.cache/shots/d92-histogram-*.png`。

- **D9.3 调整图层（已完成）** —— 非破坏式调色层，作用于它下面的所有内容：
  - 新增 `studio/adjustments.js`：`ADJUSTMENT_KEYS/DEFAULTS`、`normalizeAdjustment`（夹到 ±100）、`hasAdjustment`、`applyAdjustment(data, params, strength)`——单次逐像素按「曝光/亮度 → 对比度（0.5 中灰为轴）→ 色温/色调增益（复用 `color.whiteBalanceGains`）→ 饱和度（感知亮度）」计算，`strength` 与原像素线性混合，透明像素跳过；顺序与全局调色观感一致，且不依赖 `ctx.filter`，预览与导出像素完全一致。
  - `AdjustmentLayer`：`kind='adjustment'`、`isAdjustment=true`、`bounds()` 覆盖整张画面、`hitTest()` 恒 false（画布点选交给图层面板，避免挡住下层拖动）；蒙版与 `doc.mask` 同坐标（旋转后、未裁剪），`ensureMask/toggleMaskVisible/removeMask/clone` 与叠加层接口对齐。
  - 合成：`applyAdjustmentLayer(ctx, layer, {crop, scale=1})` 先快照当前合成 → `getImageData/putImageData` 逐像素调整 → 蒙版 `destination-in`（按 `crop` 偏移、按 `scale` 缩放，供低分辨率代理）→ `globalAlpha=opacity` 叠回；`renderer.drawLayers` 遇到调整层先归零变换再调用，`renderBase`/`renderPreviewBase` 共用同一函数；`studioDoc.hasAdjustmentLayers` 让拖动叠加层时禁用「底图缓存 + 实时图层」捷径，保证调整层下方的位移也能实时重合成。
  - 面板：调色页签新增「调整图层」区块（＋新建）与顶部提示条；选中调整层后同一组滑杆/复位改为编辑该层参数（新建时自动选中），LUT 控件禁用并提示「调整图层不参与 LUT」，点「编辑主图」切回全局调色。
  - 图层系统：`OverlayLayer` 增加 `visible`（隐藏后不参与合成与 `hitTest`）；`layerPanel` 每行新增眼睛按钮（`◉/◌`，`is-hidden` 行降透明度）、调整层「调整」徽标，并对调整层隐藏缩放按钮；`studio.js` 新增 `toggleLayerVisible`（入撤销栈），删除/锁定/克隆/选中后同步调色面板上下文。
  - 蒙版涂抹：`docToLayerTransform` 对调整层走「单位矩阵 + 平移」分支，画笔/橡皮/形状/套索即可直接涂抹调整层的文档坐标蒙版。
  - 持久化：工程 schema 的图层 props 增加 `kind / params / visible`；调整层无位图（`layerBlobFor` 返回 null），恢复时按参数重建并回填 `id / visible / locked` 与 `maskBlob`，与原图层顺序一致；LUT 仍只属于主图，不随调整层保存。
  - 单测：新增 `web/tests/studio/adjustments.test.mjs` 13 项（默认值/夹取、非法值、全零判定、曝光翻倍、亮度压黑、对比度中灰轴、饱和度灰度保亮度、零参数不改像素、strength 混合、透明像素、色温冷暖、色调洋红、组合参数不越界）；`node --test web/tests/studio/adjustments.test.mjs web/tests/studio/color.test.mjs` → `pass 42 / fail 0`。
  - 实测（headless Chromium 1440×900，800×600 红/绿底图）：新建「调整图层 1」后行内出现「调整」徽标、顶部提示条显示层名；曝光 60 → 红色 `[192,57,43] → [255,86,65]`（input 实时与 change 提交一致）；眼按钮隐藏后回 `[192,57,43]`、再显示回 `[255,86,65]`，行变 `is-hidden`；`◐` 建蒙版后进入 `✎` 自动切画笔，涂抹处回 `[192,57,43]`、未涂抹处仍 `[255,86,65]`（绿色区 `[102,212,115] → [155,255,174]`）；撤销回填、重做复原；改曝光 −40 → `[146,43,33]`，改回 60；「编辑主图」后提示条隐藏、滑杆归 0；删除图层回原始、撤销复原；刷新 `?cb=32#studio` 后参数仍 60、蒙版孔洞保留、选中后提示条正常。另用 1600×1200 底图验证低分辨率代理（1024/1600 比例、蒙版按 scale 缩放）与全分辨率最终像素一致（均为 `[255,86,65]`）。截图 `.screenshots/D9.3-adjust-layer-2026-11-07T17-43-56-734Z.png`。
  - 已知代价：调整层每次重合成都要整图 `getImageData`，4K 下拖动下层会有可感知延迟；当前先以正确性优先，若后续 D18 基准触发预算再考虑 tile/WebGL 化。

- **D9.4 局部调整（已完成）** —— 调整图层支持「线性渐变 / 径向渐变 / 画笔」三种局部范围：
  - 新增纯函数（`studio/adjustments.js`）：`normalizeLocal`（type/start/end/feather/freehand 归一化）、`localStrengthAt(local, x, y)` → 0~1 强度、`buildLocalMask(local, width, height)` → 文档尺寸蒙版画布（白=应用、透明=不影响，逐像素写入 alpha）。
    - 线性：把点投影到 `start → end` 向量上得到 t，起点全量、终点为零，垂直方向不衰减，两端夹取；支持任意斜向。
    - 径向：`start` 为中心，`|end - start|` 为两轴半径（`ry=0` 时退化为正圆），归一化半径 r=1 处为零，超出即不再影响。
    - `feather` 0~100 在「线性斜坡」与 `smoothstep` 之间插值，只改变过渡曲线形状、不改变两端取值；零长度几何退化为全量，避免除零。
  - `AdjustmentLayer` 增加 `local` 与 `setLocal(local)/clearLocal()`：`setLocal` 直接按几何重建 `mask`（复用既有合成管线，线性/径向/画笔三者天然可叠加涂抹）；`clearLocal` 清几何并移除蒙版，恢复全图。
  - 交互：选中调整图层后调色面板出现「局部范围」区块（线性渐变 / 径向渐变 / 画笔蒙版 / 全图 + 过渡滑杆）。点线性/径向进入取景态（按钮高亮、画布 `crosshair`），画布上按下拖动即定义几何：拖动中只画白色虚线辅助线（线性画线+两端点，径向画椭圆+圆心），松手才逐像素重建蒙版并落一次撤销步；拖动距离 < `4/scale` 视为误触不生效，结束后自动退出取景态。取景优先级高于所有工具（含抓手），不会误平移或误涂。
  - 画笔蒙版：切到 `brush` 并直接进入该调整层的蒙版涂抹模式（画笔隐藏效果、橡皮恢复），`local.freehand=true`，提示文案随之改为「当前：画笔涂抹的蒙版」。
  - 过渡滑杆：`input` 只改参数与读数，`change` 才重建蒙版（避免逐帧逐像素重算），并落撤销步。
  - 持久化：工程图层 props 增加 `local`；恢复时先把 `local` 传给 `addAdjustmentLayer`（无蒙版快照时按几何重建），再用 `maskBlob` 覆盖为实际涂抹结果，因此「渐变 + 手涂」的组合刷新后完全保留。
  - 单测：`adjustments.test.mjs` 追加 7 项（类型/坐标归一化、none 全量、线性三点与夹取、斜向、径向两轴与半轴 50%、feather 曲线形状、零长度退化）；`node --test web/tests/studio/adjustments.test.mjs web/tests/studio/color.test.mjs` → `pass 49 / fail 0`。
  - 实测（headless Chromium 1440×900，800×600 红/绿底图，调整层曝光 60）：全图时红 `[192,57,43] → [255,86,65]`、绿 `[102,212,115] → [155,255,174]`；线性拖拽后起点侧 `[255,86,65]`、中点 `[218,68,52]`、终点侧回 `[102,212,115]`；径向拖拽后中心 `[255,85,64]`、半径处 `[192,57,43]`、外部回原色，截图可见中心暖色光斑；过渡 0/50/100 三档蒙版重建（统计差异 6168/6173/6175）；画笔在光斑中心点一下即回 `[192,57,43]`（提示「正在涂抹…画笔隐藏效果，橡皮擦恢复」）；「全图」立即恢复全量并提示；撤销可回到渐变。刷新 `?cb=43#studio` 恢复后提示为「当前：画笔涂抹的蒙版」、过渡 50、行扫描呈「渐变环 + 中心手涂孔洞」，即渐变与手涂组合被完整保留。截图 `.screenshots/D9.4-local-adjust-clean-2026-11-08T04-12-37-422Z.png`。
  - 说明：径向目前只支持椭圆（两轴由拖拽向量决定），不做旋转椭圆；「范围蒙版（按颜色/亮度）」仍留在 §13.2 的 P1 清单，本轮不做。

- **D10.1 污点修复（已完成）** —— 纯前端的「环形取样 + 锥形渐变填补」，用于去痘、去灰尘、去孤立小物体：
  - 新增 `studio/heal.js`：`ringSamples(data, width, height, {x,y,radius,samples,box})` 在半径外一圈按角度取样（每个角度取 `box` 邻域均值，跳过透明像素并沿用上一个有效颜色，越界安全跳过）；`healDab(ctx, source, {x,y,radius,opacity,softness})` 用 `createConicGradient` 把各角度颜色织成补丁，再用径向渐变的 `destination-in` 做柔和边缘（无 `createConicGradient` 时退回环形均值纯色）。
  - 文档模型：`StudioDoc.repair`（与「旋转后、未裁剪」画布同尺寸的透明修复层），`ensureRepair/hasRepair/clearRepair`；`renderUnderlay()` 在 LUT 之后、叠加层之前 `_drawRepair`，`renderPreviewBase()` 按 ratio + 裁剪偏移缩放贴回，保证缩略图/低分辨率代理与成图一致；`snapshot/restore` 克隆修复层（可撤销）；旋转/翻转/恢复原始图片同步清空或变换修复层。
  - 工具：左栏新增「修复」组与 `spot`（污点修复，快捷键 J）。复用画笔参数（大小/硬度/不透明度），拖动按 `brush.size * 0.22` 间距连续落笔，整笔只落一次撤销步；笔刷光标与隐藏鼠标指针沿用画笔样式；蒙版浮条进入 `is-heal` 模式，隐藏蒙版工具下拉与「导出/清除蒙版」，只保留参数滑杆。
  - 取样来自 `renderUnderlay()`（含调色/LUT/已有修复），每次落笔后 `invalidateBase()` 同时失效 `_underlay` 与 `_base`，修复结果即时可见。
  - 持久化：工程保存新增顶层 `repairBlob`（PNG 保留透明通道），`persistence` 写入 base 记录并纳入签名；恢复时按同尺寸贴回修复层，未修复区域保持透明、不覆盖底图。
  - 单测：新增 `web/tests/studio/heal.test.mjs` 5 项（纯色环、水平渐变左右差异、透明像素沿用、采样数下限/自定义、越界安全）；`node --test web/tests/studio/heal.test.mjs` → `pass 5 / fail 0`。
  - 实测（headless Chromium 1440×900，800×600 红色渐变 + 半径 18 深色圆点）：修复前圆点中心 `[59,31,24]`、周边 `[209,75,51]`；选中污点修复点击圆点后中心变为 `[207,73,50]`（与周边差 ≤2，肉眼无缝），撤销回到 `[59,31,24]`、重做再次修复；刷新 `?cb=53#studio` 恢复后仍是 `[207,72,50]`、深色像素计数 0，说明修复层随工程持久化。截图 `.screenshots/D10.1-spot-heal-2026-11-08T04-17-32-284Z.png`。
  - 已知取舍：当前是「环形颜色外推」而非内容感知修复，纹理/结构边缘（发丝、砖缝）会被抹平；正式的内容感知与仿制图章放在 D10.2，后续可把本工具的 `healDab` 换成 patch-match 取样而不改 UI。

- **D10.2 仿制图章 / 修复画笔（已完成）** —— Alt 取样 + 对齐/非对齐涂抹，结果写入 D10.1 的修复层：
  - `studio/heal.js` 追加：`meanRgb(data)`（忽略透明像素求均值）、`shiftPatch(data, delta, strength)`（补丁整体色偏，夹取 0~255）、`cloneDab(ctx, source, {x,y,sx,sy,radius,opacity,softness,blend})`——从 `(sx,sy)` 取方形补丁，`blend='clone'` 原样贴回（仿制图章），`blend='heal'` 先算目标窗口与源窗口的均值差再 `shiftPatch`（修复画笔：保留纹理、匹配目标色度），最后用径向渐变做柔和边缘；取样越界返回 `false`，由 UI 提示重新取样。
  - `StudioDoc.renderSample()`：临时摘掉修复层重合成一份「干净底图」用于取样，避免反复涂抹把已修像素当成源；只在每笔开始时调用一次。
  - 工具：左栏「修复」组新增 `clone`（仿制图章，S）与 `healbrush`（修复画笔，H）；复用画笔大小/硬度/不透明度，浮条新增「对齐取样」开关（仅这两种工具显示）。
  - 交互：Alt + 点击设置取样锚点并清空旧偏移（toast 回显坐标）；未取样直接涂抹时提示「按住 Alt 点击画面取样」；对齐开启时整段会话沿用第一次落笔的相对偏移，关闭后每笔重新对齐取样点；画布上用白色虚线圆 + 十字同时标出锚点与当前取样位置；拖动按 `brush.size * 0.22` 间距连续落笔，整笔只落一次撤销步。
  - 单测：`heal.test.mjs` 追加 4 项（均值忽略透明、全透明返回 null、色偏夹取并跳过透明、strength 比例）；`node --test web/tests/studio/heal.test.mjs` → `pass 9 / fail 0`。
  - 实测（headless Chromium，800×600：左半 16px 黑白棋盘、右半纯蓝 `#0000ff`，笔刷 24px）：Alt 在 `(24,24)` 取样（toast「已取样：24, 24」），点 `(600,450)` 后该点 `[0,0,255] → [255,255,255]`，`(600,470)` 仍为蓝，说明只复制了笔刷范围内的棋盘格；切修复画笔在 `(16,16)` 取样因窗口越界被拒（不绘制），改在 `(40,40)` 取样后点 `(600,540)` 得中心 `[119,119,255]`、上下相邻 `[0,0,135]`、`(620,540)` 仍纯蓝——纹理被完整复制且整体压到目标蓝色域；对齐校验：开启时第一笔 `(700,200)` 建立偏移后再点 `(700,40)` 源点越界不绘制（保持 `[0,0,255]`），关闭后重新取样同点立即绘出 `[255,255,255]`。刷新 `?cb=62#studio` 恢复后右半仍有 163 个白色采样点（棋盘补丁持久化）。截图 `.screenshots/D10.2-clone-heal-2026-11-08T04-20-56-031Z.png`。
  - 说明：修复画笔用的是「均值平移」，对亮度差异明显的区域有效，形状差异大时仍需手动选源；真正的内容感知补全属 P2 规划，不在本轮。

- **D10.3 涂抹（已完成）** —— 把笔刷范围内的像素沿拖动方向推开，做水面/发丝拖尾：
  - 新增 `studio/smudge.js`：`normalizeVector(x,y)`（零向量安全）、`smudgeShift(direction, radius, amount=0.35)`（方向 × 半径 × 强度，纯函数）、`smudgeDab(ctx, source, {x,y,dx,dy,radius,opacity,softness})`——读取当前点方形补丁，径向渐变柔边后按 `(dx,dy)` 偏移贴到修复层；取样越界返回 `false`。
  - 工具：左栏「修复」组新增 `smudge`（涂抹，U）；复用笔刷大小/硬度/不透明度，鼠标指针隐藏并显示笔刷圆环，浮条沿用 `is-heal` 精简模式。
  - 交互：按下不下笔，沿拖动方向逐帧 `smudgeDab`（每次读取含本次结果的合成底图，因此能连续把颜色推远），整笔仅落一次撤销步；松开后自动保存。
  - 单测：新增 `web/tests/studio/smudge.test.mjs` 5 项（单位向量、零向量、方向×半径×强度、斜向等长、强度夹取），`node --test web/tests/studio/smudge.test.mjs` → `pass 5 / fail 0`。
  - 实测（headless Chromium，800×600：左红 `#c0392b`、右蓝 `#1f6fd0`，分界 x=400，笔刷 64px）：从 `(360,300)` 拖到 `(470,300)` 后，红被推过原分界（`x=405/450` 由纯蓝 `[31,111,208]` 变为 `[191,55,41]`），`x=475` 仍为红、`x=600` 保持蓝，形成带柔边的舌头状拖尾；撤销后 `x=405/600` 回到 `[31,111,208]`，重做恢复 `[191,55,41]`。截图 `.screenshots/D10.3-smudge-2026-11-08T04-22-54-971Z.png`。
  - 说明：当前不是流体模拟，落笔依赖当前合成结果逐步累积，长距离拖动会把颜色推得较远；追求更自然的细节可后续换成双缓冲位移场。

- **D10.4 磨皮（已完成）** —— 频率分离式局部柔化，保留纹理不产生塑料感：
  - 新增 `studio/skin.js`：`boxBlur(data, w, h, radius)`（可分离箱式模糊 + 边缘夹取，纯函数）、`smoothSkin(data, w, h, radius, ratio)`（低频再模糊一次后与「按比例保留的高频」相加，再按 ratio 与原图混合，`keep = 1 - ratio*0.45` 保证细节不会归零）、`skinDab(ctx, source, {x,y,radius,strength,opacity,softness})`（窗口内磨皮 + 径向柔边贴回修复层，越界返回 false）。
  - 工具：左栏「修复」组新增 `skin`（磨皮，K）；复用笔刷大小/硬度/不透明度，其中不透明度兼作磨皮强度（`strength = 0.4 + opacity * 0.55`），光标与浮条沿用修复类样式。
  - 交互：按下即落笔，沿拖动按 `brush.size * 0.22` 间距连续处理，整笔只落一次撤销步，结果写进 D10.1 的修复层（可撤销、可持久化）。
  - 单测：新增 `web/tests/studio/skin.test.mjs` 6 项（纯色不变、脉冲扩散与总量、radius=0、单像素瑕疵被提亮且整体亮度保持、条纹方差下降、ratio=0 不变），`node --test web/tests/studio/skin.test.mjs` → `pass 6 / fail 0`。
  - 实测（headless Chromium，800×600 肤色底 `#d9a07a` + 1200 个 1.4px 深浅斑点，笔刷 160px）：在 `(400,300)` 点一下后 120×120 区域亮度标准差 `2.43 → 1.58`（−35%），均值保持 `217`，说明斑点被柔化而肤色未偏移；撤销可恢复。截图 `.screenshots/D10.4-skin-2026-11-08T04-25-23-215Z.png`。
  - 说明：磨皮只处理小半径细节，痘印/发丝级瑕疵仍建议先用污点修复或修复画笔；参数按「局部平均 + 细节衰减」设计，不追求中性灰高低频分离那种可再合成的图层结构。

- **D10.5 液化（已完成）** —— 以「推」为主的局部形变，做瘦脸、拉长、微调轮廓：
  - 新增 `studio/liquify.js`：`pushWeight(distance, radius)`（smoothstep 衰减，中心 1 / 边缘 0，纯函数）、`warpPatch(ctx, base, {x,y,dx,dy,radius,strength})`——对笔刷外接方形逐像素按累计位移**反向取样**本笔开始时的快照，再以画布绘制方式写回修复层（笔刷外透明像素不会擦掉已有修复内容）；越界返回 `false`。
  - 工具：左栏「修复」组新增 `liquify`（液化，Y）；复用笔刷大小/不透明度（不透明度兼作形变强度 `0.4 + opacity*0.6`）。
  - 交互：按下即记录本笔底图快照（`doc.renderUnderlay()`），拖动时累加 `total` 位移并以它反向取样，所以是真正的形变而不是涂抹式累积；整笔只落一次撤销步。
  - 单测：新增 `web/tests/studio/liquify.test.mjs` 4 项（中心/边缘/超界、单调递减、非法半径、半半径 ≈0.5），`node --test web/tests/studio/liquify.test.mjs` → `pass 4 / fail 0`。
  - 实测（headless Chromium，800×600 蓝底 + `(360,260)-(440,340)` 红色方块，笔刷 160px）：从 `(400,300)` 向右拖 60px 后，`x=450` 由蓝 `[31,111,208]` 变为红 `[231,76,60]`，`x=360` 边缘混合为 `[143,91,124]`，`x=560` 仍为蓝，方块整体右移且边缘平滑；撤销 `x=450` 回到蓝、重做恢复红。截图 `.screenshots/D10.5-liquify-2026-11-08T04-26-52-863Z.png`。
  - 说明：本轮只实现「向前推」一种液化笔刷（重建/膨胀/收缩/左推留给后续）；位移以文档像素为单位，大半径 + 大位移时边缘可能出现轻微拉伸纹理，属正常形变表现。

- **D11.1 马赛克 / 局部模糊（已完成）** —— 打码与柔化，边缘羽化不出现硬方块：
  - 新增 `studio/mosaic.js`：`pixelate(data, w, h, block)`（方块均值填充，越界按剩余像素取均值，纯函数）、`mosaicDab(ctx, source, {x,y,radius,mode,block,blurRadius,opacity,softness})`——`mosaic` 走 `pixelate`、`blur` 复用 `skin.boxBlur`，两者都用径向渐变柔边后贴回修复层；取样越界返回 `false`。
  - 工具：左栏「修复」组新增 `mosaic`（马赛克 / 模糊，P）；浮条新增「模式」下拉（马赛克 / 局部模糊，仅本工具显示），大小滑杆同时决定方块尺寸（`radius*0.22`）与模糊半径（`radius*0.18`）。
  - 交互：按下即落笔，沿拖动按 `brush.size * 0.3` 间距连续处理，整笔只落一次撤销步，结果写入修复层（可撤销、可持久化）。
  - 单测：新增 `web/tests/studio/mosaic.test.mjs` 4 项（方块内统一、均值为区域平均、block≤1 不变、越界取剩余像素），`node --test web/tests/studio/mosaic.test.mjs` → `pass 4 / fail 0`。
  - 实测（headless Chromium，800×600 的 4px 黑白棋盘，笔刷 160px）：马赛克点按后中心 80×80 区域亮度标准差 `99 → 1`，区域外保持 `99.5`；切「局部模糊」后另一处 `99.5 → 0.5`，撤销回到 `99.5`，中心马赛克不受影响（整笔一次撤销）。修复了 `boxBlur` 返回新数组未写回导致模糊模式无效果的缺陷。截图 `.screenshots/D11.1-mosaic-2026-11-08T04-29-25-596Z.png`。
  - 说明：马赛克方块大小随笔刷线性变化，不做「固定屏幕像素」模式；若需要整脸大块打码，建议调大笔刷或多次涂抹。

- **D11.2 文字图层（已完成）** —— 可编辑、可移动、可撤销的文字层，替代「先在其他软件打好字再导入」：
  - 新增 `studio/textLayer.js`：`TEXT_FONTS`（system-ui / 微软雅黑 / 宋体 / 楷体 / Georgia / Impact）、`TEXT_DEFAULTS`（默认「双击编辑文字」、64px、600 字重、白字、行高 1.25）、`class TextLayer`（`kind='text'`、`isText`、`font` 拼装、`lines()` 换行拆分、`bounds()` 带缓存测量、`hitTest`、`draw(ctx)` 按裁剪区绘制描边与投影并在 `textBaseline='top'` 下逐行填充、`clone()`、`hasMask()=>false`）、`textLayerFromProps()`。文字层走与叠加层相同的 `composer` 管线，因此支持显隐/锁定/不透明度/排序，但不支持蒙版与缩放按钮。
  - 文档模型：`StudioDoc.addTextLayer(props,{name,x,y})` 创建并落一次撤销步；`collectProject/applyRestore` 以 `kind:'text'` 区分，持久化文案、字体、字号、字重、颜色、行高、描边宽度/颜色、投影参数。
  - UI：左栏「合成」组新增 `text`（文字，T）；右侧工作区分页新增「文字」页（`data-pane="text"`），未选中文字层时显示空状态提示，选中后展示文案文本域、字体下拉、加粗、字号、颜色、描边宽度/颜色、投影模糊、删除按钮。工具在画布上点一下即创建文字层并自动切到移动工具 + 文字分页；选中文字层时自动切页并回填参数。
  - 交互：`input` 实时改属性并只重绘（`touchLayers`），`change` 才落撤销步 + 自动保存；移动工具可直接拖动文字层；`scaleLayer`/`toggleLayerMask`/`layerBlobFor` 对文字层做显式忽略与提示，避免误用。
  - 单测：新增 `web/tests/studio/textLayer.test.mjs` 6 项（默认值、换行与 bounds、命中测试、描边/投影绘制参数、克隆独立、props 还原），`node --test web/tests/studio/textLayer.test.mjs` → `pass 6 / fail 0`。
  - 实测（headless Chromium，800×600 空白底）：文字工具点击后图层条出现 `ai-layer is-text` 行「文字 1」，右侧字段可见；改为「LOS 2026」+ 96px + `#e74c3c` + 描边 6 + 投影 12 后红色像素 9006；用移动工具拖动后红色区域左上角由 `(101,311)` 移到 `(215,392)`（dx=114 / dy=81，与画布缩放 0.815 相符）；刷新后文字层与内容随工程恢复。截图 `.screenshots/D11.2-text-layer-2026-11-08T04-42-09-993Z.png`。
  - 说明：本轮为纯前端文字层，字体取自系统字体列表，不做字体文件上传与路径文字；双击画布直接进入行内编辑暂未实现，统一在右侧面板修改文案。

- **D11.3 贴纸（已完成）** —— 图片贴纸的导入、缩放、旋转、翻转与混合模式：
  - 图层模型：`layers.js` 新增 `BLEND_MODES`（正常/正片叠底/滤色/叠加/柔光/强光/颜色减淡/颜色加深/差值）与 `flipH/flipV/blend` 字段；`draw()` 写入 `globalCompositeOperation` 并围绕图层中心镜像；`hitTest()` 改为把点反变换到图层本地坐标，旋转后不再误命中 AABB 角落。
  - 新增 `studio` 内 `addOverlayFile(file, options)`（原 `ctx.addOverlay` 的实体，供 AI 面板与贴纸共用）：支持 `center` 落点、`focusSticker` 切页；`options` 透传 x/y/scale/flip/blend，贴纸导入与工程恢复共用同一条路径。
  - UI：左栏「文字 / 贴纸」组新增 `sticker`（贴纸，G），在画面空白处点一下即打开文件选择并以点击点为居中导入；点已有贴纸则选中拖动。右侧新增「贴纸」分页：导入、重置变换、缩放（5%~400%）、旋转（−180°~180°）、水平/垂直翻转、混合模式下拉、删除。
  - 画布手柄：选中贴纸时画旋转后的虚线框 + 四角缩放点 + 顶部旋转圆点；拖角按「到中心距离比」等比缩放且中心不变，拖圆点旋转默认吸附 15°（按住 Alt 自由旋转）。整段拖动只落一次撤销步。
  - 持久化：工程保存 `flipH/flipV/blend`，恢复时按原 id 还原；`setDoc` 清空待导入落点，避免跨工程误用旧坐标。
  - 单测：新增 `web/tests/studio/layers.test.mjs` 5 项（模式表与默认值、未知模式回退、旋转命中、draw 写入混合/翻转、clone 保留翻转与混合），`node --test web/tests/studio/layers.test.mjs` → `pass 5 / fail 0`。
  - 实测（headless Chromium，800×600 纯色底 `[40,60,90]` + 240×160 左绿右黄贴纸）：贴纸工具点击后图层条出现 `d113-sticker.png`、右侧自动切到「贴纸」页且显示 100% / 0° / 正常；导入后左半 `[46,204,113]`、右半 `[241,196,15]`，与底图叠加位置正确。切「正片叠底」后左半变为 `[8,48,40]`、右半 `[38,46,6]`（与 40×46/255 等理论值一致）。缩放 50% 后图层 `x=219,y=180,w=120,h=80`、中心保持 `(279,220)`，原左侧外沿回到底色。旋转 45° 后中心右移 40px 处仍为黄、远离旋转区域的 `(360,150)` 回到底色。拖旋转圆点一次得到 30°（15° 吸附）；拖左上角点缩放由 0.5 → 0.337 且中心 `(279,220)` 不变。水平翻转后左右颜色互换。重置后设 70% / 60° / 水平+垂直翻转 / 滤色，刷新后图层完整恢复（`x=316,y=244,scale=0.7,rotation=60,w=168,h=112`，分页仍为「贴纸」）。截图 `.screenshots/D11.3-sticker-fresh-2026-11-08T05-01-55-162Z.png`、`.screenshots/D11.3-sticker-blend-rotate-2026-11-08T05-04-46-163Z.png`。
  - 说明：本轮贴纸只做单张图片层，不含内置贴纸库与「另存为素材」；SVG 依赖浏览器 `Image` 解码，复杂 SVG（外链字体/滤镜）可能不完整，建议导入 PNG/WebP。

- **D11.4 形状与图案图章（已完成）** —— 矢量形状层 + 平铺图案盖章：
  - 新增 `studio/shapeLayer.js`：`SHAPE_KINDS`（矩形/椭圆/直线/箭头）、`SHAPE_DEFAULTS`、`class ShapeLayer`（几何 + `fill/stroke/strokeWidth/radius`，圆角矩形手写路径，箭头画主杆 + 实心三角；`bounds/hitTest` 支持负宽高与直线距离命中；`clone`、`hasMask()=>false`）、`shapeLayerFromProps`。
  - 新增 `studio/pattern.js`：`tilePatch(source, sw, sh, dw, dh, offsetX, offsetY)`（纯函数，按取样原点正模平铺，负 offset 也正确回绕）、`patternDab(ctx, source, {x,y,radius,opacity,softness,pattern})`（读一次取样矩形 → 平铺成笔刷窗口 → 径向柔边贴回修复层）。
  - 形状工具（D）：拖动时按当前样式画实时预览，松手才建层；左侧「文字 / 贴纸 / 形状」组，右侧新增「形状」分页（类型、填充、描边宽度/颜色、圆角、删除）。未选中形状时改的是「新建默认样式」，选中后改的是该层且可撤销。
  - 图案图章（N）：Alt + 拖框取样（虚线框持续显示，浮条显示「图案 W × H」并可清除），再涂抹按平铺图案复制；整笔一次撤销，结果写入修复层随工程持久化。
  - `StudioDoc.renderSample()` 改为「干净底图 + 叠加层/文字/形状」的合成（仅临时摘掉修复层），让图案与仿制取样都遵循「所见即所取」；取样坐标仍为未裁剪图像空间。
  - 图层与持久化：`kind:'shape'` 记录 `width/height/shape/fill/stroke/shapeStrokeWidth/radius`，恢复时按原 id 还原；图层面板显示「形状」徽标，不提供蒙版/缩放按钮。
  - 单测：新增 `web/tests/studio/shapeLayer.test.mjs` 6 项与 `pattern.test.mjs` 4 项（平铺、相位、负 offset、非法尺寸），`node --test web/tests/studio/shapeLayer.test.mjs web/tests/studio/pattern.test.mjs` → `pass 10 / fail 0`。
  - 实测（headless Chromium，800×600 纯色底 `[40,60,90]`）：拖出 `(100,100)-(300,250)` 得到「形状 1」200×150、填充 `#ff3b30`，中心像素 `[255,59,48]`、外部仍为底色。改填充 `#2ecc71`、描边 6、白色、圆角 20 后中心 `[46,204,113]`、左边框 `[255,255,255]`、圆角处为抗锯齿混色 `[91,106,129]`。切换类型后同一层变为椭圆（中心绿、角落底色）；再建箭头 170×100、描边 8 后杆中部与箭头尖端均为白色。刷新后 3 个形状的几何与样式完整恢复。图案图章 Alt 拖框 100×60 取样（覆盖椭圆绿色区域），提示「图案 100 × 60」；在 `(600,450)` 涂抹后该处变为 `[46,204,113]`、笔刷外仍为底色，刷新后图案仍保留。截图 `.screenshots/D11.4-shapes-pattern-2026-11-08T05-11-36-210Z.png`。
  - 说明：形状层暂不支持旋转/透视与虚线描边；图案图章与修复类一样写入修复层（非破坏、可撤销），不做独立图案层。

- **D12.1 混合模式 + 剪贴蒙版（已完成）** —— 图层级混合与「只显示在下方图层内」：
  - 混合模式：`BLEND_MODES`（9 种）扩展为叠加层、文字层、形状层共用；`TextLayer.draw` / `ShapeLayer.draw` 写入 `globalCompositeOperation`，`OverlayLayer` 沿用；调整图层暂不参与混合（按像素整体改色，语义不同）。
  - 剪贴蒙版：图层新增 `clipped` 标记；`renderer.drawLayers()` 改为逐层绘制，命中剪贴层时取**最近的未剪贴下层**作为 alpha 基座——先用离屏画布渲染基座 alpha，再把剪贴层画到另一块离屏画布并 `destination-in`，最后整块贴回目标。离屏画布按目标像素尺寸复用，4K 下也只分配两块。
  - 拖动预览：`studio.draw()` 的实时图层捷径改为复用 `drawLayers()`，拖拽过程中混合与剪贴立即生效，不再只对静态帧生效。
  - UI：右侧面板底部新增「图层属性」区块（选中非调整层时出现）：混合模式下拉 + 「剪贴到下层」勾选；最底层禁用剪贴并给出提示；图层条显示「剪」徽标。
  - 持久化：所有图层保存 `blend` 与 `clipped`（文字层随 props、形状层显式还原、叠加层随 options），恢复后徽标、面板与画面一致。
  - 单测：`shapeLayer.test.mjs` 与 `textLayer.test.mjs` 各追加 1 项（混合/剪贴默认值、非法模式回退、clone 保留），四份图层相关测试合计 `pass 23 / fail 0`。
  - 实测（headless Chromium，800×600 纯色底 `[40,60,90]`，已有椭圆/矩形/箭头三层）：选中矩形层设「正片叠底」后，矩形内像素由 `[255,59,48]` 变为 `[40,14,17]`（与逐通道相乘理论值一致），底色不变。把矩形移到椭圆上方并勾选「剪贴到下层」后：两者重叠处仍为红 `[255,59,48]`，矩形超出椭圆的区域回到底色 `[40,60,90]`，椭圆自身区域保持绿 `[46,204,113]`；图层条出现「剪」徽标。刷新后 `x=65,y=60,clipped=true` 与画面结果完整恢复。截图 `.screenshots/D12.1-blend-clip-2026-11-08T05-15-57-077Z.png`。
  - 说明：剪贴基座是「下方第一个未剪贴图层」，暂不支持成组剪贴到组；混合模式暂不作用于调整图层与修复层。

- **D12.2 图层样式（已完成）** —— 形状层的外阴影、外发光、渐变叠加与颜色叠加：
  - `shapeLayer.js` 新增 `SHAPE_STYLE_DEFAULTS` 与 `normalizeShapeStyle()`：`shadow`（颜色/模糊/距离/角度）、`glow`（颜色/模糊）、`gradient`（起止色/角度/不透明度）、`colorOverlay`（颜色/不透明度），深合并并夹取数值；`ShapeLayer.style` 随 `clone()` 复制、随工程持久化。
  - 绘制：先画「剪影阴影」——把纯色剪影平移到画布外，再用反向 `shadowOffset` 把阴影投回原位（`shadowOffset/Blur` 不受 CTM 影响，按 CTM 缩放把文档单位换算成设备像素），因此发光/阴影在缩放视口与导出时位置一致；主体先填色/描边，再把渐变或颜色叠加以独立 alpha 画在最上层。原有填充、描边、圆角仍作为基础样式。
  - UI：形状分页新增「图层样式」区块：外阴影（开关 + 颜色 + 模糊）、外发光（开关 + 颜色 + 模糊）、渐变叠加（开关 + 起止色）、颜色叠加（开关 + 颜色 + 不透明度）；`input` 实时预览、`change` 落撤销步。
  - 单测：`shapeLayer.test.mjs` 追加 1 项（默认值、数值夹取、clone 深拷贝），四份图层测试合计 `pass 24 / fail 0`。
  - 实测（headless Chromium，800×600 纯色底 `[40,60,90]`，200×200 红色形状）：外阴影（模糊 20、距离 10、角度 135°）启用后形状左下方 `[33,50,75]`、更远处为底色，形状内部不变；外发光（金色、模糊 18）在边缘外 2px 为 `[89,93,90]`，约 20px 外衰减回底色；渐变叠加（`#ff3b30 → #7aa2ff`、90°）后形状顶部 `[250,62,54]`、中部 `[187,110,152]`、底部 `[125,159,250]`；颜色叠加（黑、40%）后中心由 `[255,59,48]` 变为 `[153,35,28]`。刷新后样式开关、面板状态与像素结果完整恢复。截图 `.screenshots/D12.2-layer-style-2026-11-08T05-35-19-942Z.png`。
  - 说明：本轮图层样式只作用于形状层；文字层继续使用自身的描边/投影字段，贴纸仍用不透明度与混合模式。暂不支持内阴影、描边独立于形状描边、渐变角度 UI（默认 90°，可通过工程数据调整）。

- **D12.3 历史快照（已完成）** —— 命名快照与一键回跳：
  - `history.js` 在撤销栈之外新增命名快照：`addSnapshot(state, name)`（`id: snap-N`、默认名「快照 N」）、`removeSnapshot(id)`、`findSnapshot(id)`；快照引用状态对象，不增加撤销步数，历史被裁剪或清空后仍可回跳。
  - `StudioDoc` 暴露 `snapshots`、`addSnapshot(name)`、`restoreSnapshot(id)`、`renameSnapshot(id, name)`、`removeSnapshot(id)`；回跳时先把当前状态入栈再恢复，所以「回跳」本身也能撤销。
  - UI：右侧面板底部新增「历史快照」区块（随文档显示）：新建按钮、快照列表（点击名称回跳、双击重命名、× 删除），空状态与剩余数量提示。
  - 回跳后统一同步：清空图层选择、失效蒙版涂抹态、刷新调色/文字/贴纸/形状/图层属性面板、历史按钮、画布与自动保存。
  - 单测：新增 `web/tests/studio/history.test.mjs` 3 项（命名/查找/删除、默认名与不占撤销步数、清空历史后快照仍可回跳），`node --test web/tests/studio/history.test.mjs` → `pass 3 / fail 0`。
  - 实测（headless Chromium，已有渐变形状层）：新建两个快照后把形状从 `y=300` 拖到 `y=350`，点击「快照 1」后 `y` 恢复为 `300`，画布回到渐变形状原位置且撤销按钮可用；双击名称改为「基线」成功，删除「快照 2」后列表只剩 1 项；再点撤销回到 `y=350`（证明回跳可撤销），快照仍保留。截图 `.screenshots/D12.3-history-snapshot-2026-11-08T05-37-41-579Z.png`。
  - 说明：快照只保存在本次会话内存中（刷新后清空），暂不做工程持久化与缩略图；需要跨会话保留时建议导出工程或使用系统撤销栈。

- **D13.3 透视变换 / 路径文字（已完成）** —— 贴纸四角透视 + 文字沿弧线排版：
  - 新增 `studio/perspective.js`：`quadHomography(quad)`（单位正方形 → 四边形，退化面积直接拒绝）、`invert3x3`、`projectPoint`、`pointInQuad`、`quadBounds`、`warpImageToQuad(image, quad, {maxSide})`——按逆单应矩阵逐像素反向采样，双线性取色，返回可直接 `drawImage` 的离屏画布；超大图用 `maxSide` 限制采样尺寸。
  - 贴纸：`OverlayLayer` 新增 `quad`（四角文档坐标）与 `warpedQuad()` 缓存（四角或蒙版变化才重算）；`bounds/hitTest` 改按四边形；`draw()` 优先画透视结果；`clone` 与工程持久化保留 `quad`。贴纸分页新增「透视变换」：勾选「编辑四角」用当前旋转四角初始化并显示四个圆点，拖动圆点实时改形，「重置透视」恢复常规几何；透视生效期间禁用缩放/旋转/翻转，图层面板的 ± 缩放给出提示。
  - 文字：新增 `arcLayout(widths, arc)` 纯函数（−100~100，正数向上拱、负数向下弯；中间字符在基线、两端按弧长下沉/上翘并旋转）；`TextLayer.arc` 逐字平移 + 旋转绘制，描边/填充沿用原有样式，`bounds` 给弯曲文本保守包围盒，`clone` 与持久化保留 `arc`；文字分页新增「路径文字 · 弯曲」滑杆。
  - 单测：新增 `perspective.test.mjs` 7 项（仿射/透视四角映射、逆矩阵回投、奇异矩阵、内外判断、外接矩形、退化输入）；`textLayer.test.mjs` 追加 4 项（0 弯曲横排、正/负弯曲形态与角度、clone/props 保留），工作室全部单测 `pass 115 / fail 0`。
  - 实测（headless Chromium，800×600）：导入 240×160 贴纸（x=560,y=70），勾选「编辑四角」后把左上角从 `(560,70)` 拖到 `(600,120)`：原左上角 `(570,80)` 回到底色 `[40,60,90]`，新四角内 `(615,130)` 为绿 `[46,204,113]`，右半仍为黄 `[241,196,15]`；「重置透视」后 `quad=null` 恢复；重新设置后刷新，`quad` 与画面完整恢复。文字层 `arc=0` 时白字包围盒约 383×83，`arc=80` 后变为 357×140、两端明显下沉且字符随弧线旋转。截图 `.screenshots/D13.3-perspective-2026-11-08T05-43-57-651Z.png`、`.screenshots/D13.3-path-text-2026-11-08T05-47-04-167Z.png`。
  - 说明：透视采用反向采样 + 缓存，四角拖动时每帧重算（贴纸尺寸下流畅，超大贴纸会受 `maxSide` 降采样）；路径文字目前是圆弧弯曲，不支持任意贝塞尔路径与基线内缩/外扩参数。

- **D10/D11 收尾修复（已完成）** —— 修复类工具的坐标系与选区语义对齐：
  - 裁剪坐标：污点修复 / 仿制图章 / 修复画笔 / 涂抹 / 磨皮 / 液化 / 马赛克 / 图案图章，以及「文字」落点与「局部调整」取景，全部先经 `maskPoint()` 把画布显示坐标（裁剪后）换算成「旋转后 · 未裁剪」的图像坐标再落笔；此前直接写入裁剪后坐标，应用裁剪后整笔偏移一个 crop 偏移量。Alt 取样锚点、仿制对齐偏移、图案取样框同样换算。
  - 选区裁剪：新增 `repairPaint(point, radius, paint)` 统一入口——有选区时先画到等尺寸临时画布，再用 `destination-in` 叠选区 alpha，最后只贴回笔触附近区域；无选区时直接写入修复层，保持原性能。注意选区轮廓（`selectionOutline()`）是蚂蚁线用的不闭合线段路径，只能描边不能填充，`clip()` 会得到空区域，所以必须走 alpha 合成而不是裁剪路径。
  - 顺带修复：剪贴蒙版的基座若为调整层会调用不存在的 `draw()`（改为跳过调整层继续向下找、找不到就不剪贴）；删除中间快照后默认名会重复（新增 `nextSnapshotName()`）；贴纸「编辑四角」勾选状态未跟随图层是否已有透视；形状样式非法数值可能把 `NaN` 写进 Canvas 属性（新增 `numberOr()` 兜底）。
  - 单测：`history.test.mjs` 追加「删除中间项后默认名不重复」1 项；`node --test web/tests/studio/*.test.mjs` → `pass 116 / fail 0`。
  - 实测（headless Chromium，400×300 三色图：左上 80×80 绿、右半蓝、其余红，缩放 160%）：图案图章 Alt 拖框取样 50×50 后，魔棒点右半蓝区得「选区 50.0%」；选区内 `(350,150)` 由 `[0,0,255]` 变为图案绿 `[0,255,0]`，选区外 `(100,250)` 保持红 `[255,0,0]`；清除选区后同点可正常上色，证明拦截来自选区而非工具有效性问题。裁剪偏移此前已实测：裁剪 500×400（偏移 200,100）后按显示坐标落笔命中正确像素，旧坐标点无变化。截图 `.screenshots/D10-fix-selection-clip-2026-11-08T06-11-40-421Z.png`。
  - 说明：修复类笔触的选区裁剪只在「有选区」时多一次等尺寸临时画布与两次局部贴图；大图长笔触仍有开销，但每次只处理笔触附近 `pad = 2×半径 + 16` 的方块，不会整图合成。

- **D14.1 全景入口（已完成）** —— 精修页接入「全景」预设与画布参数：
  - `payload.js` 新增 `PANORAMA_ASPECTS / PANORAMA_MAX_PIXELS / panoramaPlan()`：与 `server/imaging.panorama_plan` 同一套「最小外扩 → 长边/总像素上限 → 32 对齐」算法，纯函数可单测；`detectTask()` 增加「全景」关键词（优先于扩图）。
  - AI 面板「更多设置 → 输出」新增全景画布区块（仅任务 = 全景时出现）：比例 chips 2:1 / 3:1 / 4:1 / 21:9、长边上限 2048 / 3072 / 4096、360° 环绕接缝开关；数值以 `panorama.aspect / panorama.long_side / panorama.wrap` 覆盖项随预设提交，后端按 `preset=panorama` + `task.mode=panorama` 生效。
  - 任务下拉新增「全景」，选全景预设自动切到该任务、离开时回「自动识别」；「工作画布」摘要改为显示全景画布尺寸与 MP，超 6MP 时提示降低长边；无蒙版时不再弹「整图重绘」确认（与扩图同语义）。
  - 单测：新增 `web/tests/studio/panorama.test.mjs` 7 项（2:1 / 正方形 / 超长边只缩不放 / 21:9 像素上限 / 非法比例回退 / 关键词优先级 / payload 覆盖项），工作室合计 `pass 123 / fail 0`。
  - 实测（headless Chromium，400×300 源图）：选「全景」后任务为 panorama、面板出现、预估 `608 × 320 · 0.19 MP`；点 3:1 后 `928 × 320 · 0.3 MP`（与后端算法逐位一致）；长边改 2048 不再变化（画布未超限）；切回「元素移除 / 原生」时面板隐藏、任务与提示同步。截图 `.screenshots/D14.1-panorama-panel-2026-11-08T06-17-01-941Z.png`。
  - 说明：结果目前统一走「载入为新底图」；「载入为新图层」要等画布尺寸不一致时的贴放策略定稿后再做。

- **D13.2 一键消除入口（已完成）** —— 选区转蒙版 + 预置「元素移除」：
  - 选区工具条新增「转为蒙版」与「AI 消除」：把选区 alpha 并进文档蒙版（白 = 要改），入撤销栈并刷新覆盖率；「AI 消除」额外切到「元素移除」预设 + `remove` 任务，填入默认指令「移除选区内的内容，并按周围环境自然补全背景。」并聚焦指令框，等用户点「修改」再提交（不自动消耗生成）。
  - `aiPanel` 新增 `prepareTask({ preset, task, prompt })`；任务提示文案抽成 `syncTaskHint()`，顺带修掉「切换预设后任务已变、提示仍显示旧任务」的不一致。
  - 实测（headless Chromium，400×300 三色图）：魔棒点右半蓝区得「选区 50.0%」、`蒙版 0.0%`；点「AI 消除」后选区清空、`蒙版 50.0%`，预设高亮「元素移除」、任务 = `remove`、指令与提交提示同步为元素移除。无控制台报错。
  - 说明：只做「选区 → 蒙版」，不会替用户点提交；需要完全自动生成时再补一次确认弹窗。

- **D20.1 面板布局收尾修复（已完成）** —— 右侧检查器底部内容不可见 / 滚不到：
  - 根因 1（主因）：`.studio-body` 是 grid 但只声明了列，单行是 `auto`，被右侧面板内容撑到约 990px；面板自身虽有 `overflow-y:auto`，但整个面板已经伸出视口（面板底 811 > 视口 575），滚动条也在视口外，导致「结果 / 编辑历史 / 图层属性 / 历史快照」永远看不到。改为 `grid-template-rows: minmax(0, 1fr)` 并补 `overflow:hidden`，行列都锁在剩余高度。
  - 根因 2：`.studio-layer-props`（图层属性）与 `.studio-snapshots`（历史快照）自身是 `display:flex`，覆盖了 `[hidden]{display:none}`；未选中图层时「图层属性」仍占 122px。补 `.studio-panel > [hidden]{display:none!important}`，实测该项 122 → 0。
  - 根因 3：历史快照区块固定占 189px，矮窗口把 AI 面板挤到 16px；给 `.studio-snapshots` 加 `flex:0 1 auto; min-height:0; max-height:34%; overflow-y:auto`，给 `.studio-pane` 加 `min-height:120px`，空间不足时优先保证面板可滚动。
  - 顺带：`.page-studio` 的 `min-height` 由 560 → 480，避免 575 高的窗口把页面顶出视口（实测页底 572 < 575）。
  - 实测（headless Chromium）：修复前 1024×575 下 body 440 / 面板 990 / 面板底 811；修复后同一窗口面板 360、AI 面板 191 可滚动（`scrollHeight` 836），滚到底可完整看到「结果 / 编辑历史」，状态栏与历史快照都在视口内；1440×900 下 AI 面板 417 可滚动；941×900（≤980 的堆叠布局）AI 面板按 420 上限滚动，未回归。截图 `.screenshots/before-layout-fix-2026-11-08T06-23-36-865Z.png`、`.screenshots/after-layout-fix-1024x575-2026-11-08T06-24-45-918Z.png`、`.screenshots/after-layout-fix-scrolled-2026-11-08T06-25-22-367Z.png`。
  - 说明：高度极小时（< 480px 视口）页面仍会出现整页滚动，这是桌面工作台的保底行为；面板内部各区块始终可达。

- **D20.2 左侧工具轨收尾修复（已完成）** —— 首尾工具被裁、悬停浮字「修复」：
  - 根因 1：工具轨是普通 flex 列（21 个工具约 931px），外层 `.studio-body` 加了 `overflow:hidden` 后，窗口较矮时首尾工具被直接裁掉，且工具轨本身没有滚动条（截图里顶部/底部各被切一半）。
  - 根因 2：`.studio-tool-group-title` 是绝对定位的组名浮字（`left: calc(100% + 8px)`），只要鼠标在组内任意工具上就浮出来，看起来像画布上多了一个「修复」菜单项；且工具轨改成滚动后，该浮字会被 `overflow` 裁掉。
  - 修复：工具轨改 `overflow-y:auto` + `overflow-x:hidden` + `overscroll-behavior:contain` + 细滚动条；矮窗口（`max-height:820px`）工具 40→36px、间距收紧；删除浮字元素与样式，组名并入工具原生 `title`（如「修复 · 污点修复（J）」）；`setTool()` 切换工具时 `scrollIntoView({ block:'nearest' })`，快捷键切到视口外工具会自动带进视野。
  - 实测（headless Chromium 1024×575）：工具轨 21 个，`clientHeight 360 / scrollHeight 931`；滚到底最后一个「扩图 / 外补画布」完整可见（479–519 < 527）；按 `X` 自动滚到 563 并高亮扩图，按 `V` 回滚到 8 且「抓手」高亮；DOM 中不再有 `.studio-tool-group-title`；控制台无报错。截图 `.screenshots/after-rail-fix-final-2026-11-08T06-31-41-913Z.png`。

- **D20.3 扩图上下文面板收尾修复（已完成）** —— 切出扩图后右侧不恢复：
  - 根因：`setTool()` 里从扩图切到别的工具时只把 `activeTab` 改回 `ai`，没有调用 `syncTabs()`，于是「外补画布」上下文面板一直显示、AI 面板一直是 `hidden`（实测 `ai:false / outpaint:true`）。
  - 修复：`activeTab` 由 `outpaint` 归一为 `ai` 时立即 `syncTabs()`。
  - 实测：`X` 切扩图 → `ai:false / outpaint:true`；`V` 切回抓手 → `ai:true / outpaint:false`，分页条 64px 始终可见。

- **D20.4 工具轨分组 + 顶栏去重（已完成）** —— 左栏不再平铺 21 个按钮：
  - 工具轨按 Photoshop 方式收成 6 个工具组（查看 / 选区 / 修复 / 变换 / 文字·贴纸·形状 / 生成）：组按钮显示该组「上次使用的工具」图标与快捷键，右下角小三角表示组内还有别的工具；单击展开浮层选具体工具（如修复组列出污点修复 J、仿制图章 S、修复画笔 H、涂抹 U、磨皮 K、液化 Y、马赛克 P、图案图章 N）。
  - 浮层用 `position:fixed` 定位（避免被可滚动的工具轨 `overflow` 裁掉），打开时按组按钮位置计算坐标并做底部越界保护；点击外部 / `Esc` / 工具轨滚动 / 窗口 resize 自动收起；快捷键切换工具会同步更新组图标、组高亮与浮层选中项。
  - 顶栏去掉与左侧导航重复的「送入图像编辑」主按钮（左侧「图像编辑」已有入口），改为「导出 ▾ → 发送到图像编辑 →」；顶栏只保留 `导入 / 对比 / 导出 / 放大` 四个动作。
  - 实测（headless Chromium 1024×575）：工具轨 6 个组按钮，`clientHeight 360 = scrollHeight 360`（不再需要滚动）；修复组浮层 8 项，浮层 rect `172–344 × 273–557` 在视口内；点「涂抹」后浮层收起、状态栏为涂抹、组按钮 key 变 `U`；按 `S` 后组按钮 key 变 `S`、工具为仿制图章；点外部 / `Esc` 均可收起；点「查看」组直接切抓手、点「生成」组直接切扩图。顶栏按钮只剩 `导入 ▾ / 对比 / 导出 ▾ / 放大`，导出菜单含「发送到图像编辑 →」。截图 `.screenshots/rail-groups-flyout-2026-11-08T06-53-46-148Z.png`。
  - 说明：组内工具仍是单击展开（不做长按/右键），键盘快捷键与图标按钮行为完全一致。

- **D13.1 AI 主体选择（已完成）** —— 精修页接入 `/api/image/segment`：
  - 新增 `studio/segment.js` 纯函数：发送尺寸（长边 >2048 只缩不放）、裁剪偏移 + 缩放的点/框换算、灰度蒙版 → 选区 alpha、候选按 score/面积排序；新增 `segment.test.mjs` 6 项。
  - 左栏「选区」组新增「AI 主体选择」（快捷键 A）：顶部浮条四种模式（主体 / 框选 / 点选 / 文字）、多候选、羽化 0~32、清空提示与候选切换；框选显示虚线框，点选在画布上画绿/红标记（Alt 为排除点）。
  - 请求走 `async:true` + `pollJob`：发送「旋转后未裁剪」的合成图（长边超 2048 先缩小），提示坐标经 `toSendBox / toSendPoints` 换算到发送图坐标；返回的灰度 PNG 缩放回蒙版空间后写入选区（白 = 选中），底部选区条随即出现，可直接接「转为蒙版 / AI 消除」。
  - 失败保留错误文案（如 `no_subject` → 「未识别到主体，请改用框选或点选」），不再被模式提示覆盖。
  - 实测（headless Chromium，3000×5000 人像 `subject-src.png`，缩放 10%，发送图 819×2048）：主体模式点一下 →「选区 14%」；点选躯干一处 → 2.8%；框选人像区域 → 0.4%（框内含多个小物体时 SAM 取最显著的小目标）；文字 `person` → 13%，`不存在的东西xyz` → 状态栏保留「未识别到主体，请改用框选或点选」；冷启动 30s 内完成，热态 6s 内轮询返回。截图 `.screenshots/d131-subject-selection-2026-11-08T09-11-11-601Z.png`、`.screenshots/d131-text-mode-2026-11-08T09-13-10-774Z.png`。
  - 说明：模型选择、阈值、细化次数、长边与超时统一在「设置 · 主体分割」配置，工作室只用后端默认模型；多候选仅在多主体场景返回 >1 个蒙版时出现。

- **D0.2 功能开关（不实施，合并进 D18.1）** —— `studio/flags.js` 未创建，也不建议现在创建：工作室自 D1 起就是 `studio.js` 原地增量扩展，计划里的「旧面板」已不存在，强行加 `studioV2` 开关没有可回退目标，只会留下死代码。运行时唯一的降级/诊断开关收敛为 D18.1 的 `localStorage['wb.studio.perf']`（默认关闭、零成本）。若 §13 的 D7 图层系统启动时引入并行渲染路径，再按「新路径可关、旧路径可回退」的原则重新设计开关，届时把本条改为 D7 的前置子项。台账据此销项。

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
| 测试基线 | `python -m pytest tests -q` 全绿；记录数量（计划编写时 419 → 本轮 497） |
| Node 测试 | 确认 `node -v`；若 ≥ 18，用内置 `node --test` 跑纯函数测试，不引入依赖 |
| 开关 | ~~`studio/flags.js` 导出 `studioV2`~~ 不实施；运行时开关统一用 `localStorage['wb.studio.perf']`（D18.1） |
| 浏览器 | 以 Chrome/Edge 为主；Safari 仅在 M1 后抽检，不阻塞 |

> **收口说明（本轮补记）**：D0.1 已按上表逐项核对并留存证据（`pytest` 497 passed、Node v24.13.0、三页基线截图 `.cache/shots/`），详见 §12.11；D0.2 **不实施**——工作室自 D1 起即为 `studio.js` 原地增量扩展，计划中的「旧面板」已不存在，加 `studioV2` 开关没有回退目标，运行时开关统一收敛到 `localStorage['wb.studio.perf']`（D18.1）。若 §13 D7 引入并行渲染路径，再重新设计开关。

### 14.3 模块蓝图

新增目录 `web/src/components/studio/`（已存在 `aiPanel.js` 等）：

| 模块 | 对外 API | 依赖 | 步骤 |
| --- | --- | --- | --- |
| `flags.js` | `isEnabled(name)` | 无 | 不实施（D0.2 已合并进 D18.1 探针开关） |
| `importPicker.js` | `openImportPicker(opts)`、`filesFromDataTransfer(dt)`、`readImageFile(file)`、`urlToDataUrl(url)`、`REF_MIME` | `api.js` | D1/D2 |
| `promptEditor.js` | `createPromptEditor(host, opts)` → `getText/setText/syncRefs/insertMention/focus/clear` | 无 | D3 |
| `document.js` | `createDocument()`、`addLayer/removeLayer/moveLayer/cloneLayer`（`docToJSON/fromJSON` 待 D7.3） | 无 | D7（D7.1 已落地） |
| `layers.js` | `OverlayLayer`（几何 + `visible` + `mask/maskVisible` + `maskedImage()` + `flipH/flipV/blend/clipped/quad` + `warpedQuad()`）；`BLEND_MODES`/`BLEND_IDS`；`createLayer(type, props)`、`composite(doc, opts)` | `renderer` | D7 / D8.2 / D9.3 / D11.3 / D12.1 / D13.3（已落地） |
| `history.js` | `createHistory({limit, budget})` → `push/undo/redo/clear`、`canUndo/canRedo/bytes`、命名快照 `addSnapshot/removeSnapshot/findSnapshot` | 无 | D7 / D12.3（已落地） |
| `renderer.js` | `drawLayers(ctx, layers, {crop})`、`composite(ctx, underlay, layers, {crop})`；调整层转交 `applyAdjustmentLayer`；剪贴蒙版双离屏 alpha 合成 | `layers/adjustments` | D7（D7.2 已落地，D9.3 / D12.1 扩展） |
| `selection.js` | `createAlpha/rectAlpha/ellipseAlpha/lassoAlpha/wandAlpha`、`combineAlpha/invertAlpha`、`featherAlpha/expandAlpha/contractAlpha`、`coverageAlpha/boundsAlpha`、`alphaToCanvas/canvasToAlpha`、`buildOutlinePath` | 无 | D8.1（已落地） |
| `color.js` | 曲线 LUT、色阶、HSL、色彩平衡、白平衡、直方图、`.cube` 解析与三线性采样（纯函数） | 无 | D9.1 / D9.2（已落地） |
| `adjustments.js` | `AdjustmentLayer`（参数 + 文档坐标蒙版 + `local/setLocal/clearLocal` + clone）、`normalizeAdjustment/hasAdjustment`、`applyAdjustment(imageData, params, strength)`、`applyAdjustmentLayer(ctx, layer, {crop, scale})`、`normalizeLocal/localStrengthAt/buildLocalMask` | `color` | D9.3 / D9.4（已落地） |
| `tools/brush.js` | 画笔 / 橡皮 / 蒙版画笔 | `renderer` | D8 |
| `tools/clone.js` | 仿制图章 / 修复画笔（D10.2 暂内联在 `studio.js`，取样与补丁算法在 `heal.js`） | `renderer` | D10.2（已落地） |
| `heal.js` | `ringSamples` / `healDab`（污点修复）、`meanRgb` / `shiftPatch` / `cloneDab`（仿制与修复画笔） | 无 | D10.1 / D10.2 |
| `tools/smudge.js` | 涂抹（D10.3 暂内联在 `studio.js`，算法在 `smudge.js`） | `renderer` | D10.3（已落地） |
| `smudge.js` | `normalizeVector` / `smudgeShift` / `smudgeDab`（涂抹位移与柔边贴回） | 无 | D10.3 |
| `skin.js` | `boxBlur` / `smoothSkin` / `skinDab`（频率分离磨皮，D10.4 已落地） | 无 | D10.4 |
| `tools/liquify.js` | 液化（D10.5 暂内联在 `studio.js`，形变算法在 `liquify.js`） | `renderer` | D10.5（已落地） |
| `liquify.js` | `pushWeight` / `warpPatch`（反向取样形变，D10.5 已落地） | 无 | D10.5 |
| `tools/mosaic.js` | 马赛克 / 局部模糊（D11.1 暂内联在 `studio.js`，算法在 `mosaic.js`） | `renderer` | D11.1（已落地） |
| `mosaic.js` | `pixelate` / `mosaicDab`（方块均值 + 箱式模糊，D11.1 已落地） | `skin` | D11.1 |
| `tools/text.js` | 文字图层创建与编辑 / 路径文字（暂内联在 `studio.js`，图层实体在 `textLayer.js`） | `renderer` | D11.2 / D13.3（已落地） |
| `textLayer.js` | `TextLayer` / `TEXT_FONTS` / `TEXT_DEFAULTS` / `textLayerFromProps` / `arcLayout`（文字图层实体、绘制与路径文字排版） | 无 | D11.2 / D13.3 |
| `shapeLayer.js` | `ShapeLayer` / `SHAPE_KINDS` / `SHAPE_DEFAULTS` / `SHAPE_STYLE_DEFAULTS` / `normalizeShapeStyle` / `shapeLayerFromProps`（形状图层实体、绘制与图层样式） | 无 | D11.4 / D12.2 |
| `pattern.js` | `tilePatch` / `patternDab`（图案平铺与柔边盖章） | 无 | D11.4 |
| `perspective.js` | `quadHomography` / `invert3x3` / `projectPoint` / `pointInQuad` / `quadBounds` / `warpImageToQuad`（四角透视映射与反向采样） | 无 | D13.3 |
| `tools/shape.js` | 形状创建与样式编辑（D11.4 暂内联在 `studio.js`，图层实体在 `shapeLayer.js`） | `renderer` | D11.4（已落地） |
| `tools/pattern.js` | 图案图章（D11.4 暂内联在 `studio.js`，算法在 `pattern.js`） | `renderer` | D11.4（已落地） |
| `tools/sticker.js` | 贴纸导入 / 缩放 / 旋转 / 翻转 / 混合模式 / 四角透视（暂内联在 `studio.js`，图层实体在 `layers.js`） | `renderer` | D11.3 / D13.3（已落地） |
| `panels/layers.js` | 图层面板 | `document/layers` | D7 |
| `panels/adjust.js` | 调色面板（D9.1~D9.3 暂内联在 `studio.js` 的 `data-pane="adjust"`，未拆文件） | `color/adjustments` | D9（已落地） |
| `panels/history.js` | 历史记录面板 | `history` | D7/D12 |
| `sessionHistory.js` | 本次任务 AI 编辑历史：增删、缩略图、持久化、回退 | `io` | D16.1 |
| `persistence.js` | IndexedDB 工程/草稿、自动保存、恢复、配额与多标签锁 | `document/io` | D17.1~D17.3 |
| `perf.js` | 帧耗时探针、渲染次数统计、4K 基准数据 | 无 | D18.1 |
| `panels/recovery.js` | 恢复横幅、最近工程列表 | `persistence` | D17.2 |
| `studio/aiHistory.js` | AI 编辑历史卡片区 | `sessionHistory` | D16.1 |
| `compareLauncher.js` | 组装对比数据并调用 `openCompareDialog` | `compare.js` | D16.2 |
| `studio/upscaleDialog.js` | 高清放大弹窗：引擎/倍率、任务进度、结果回流主图 | `api.upscale` + `pollJob` | D15.1 |
| `studio/layerPanel.js` | 图层条：列表渲染、拖拽排序、双击重命名、锁定、不透明度、图层蒙版 `◐`/`✎` | `utils.escapeHtml` | D7.3 / D8.2（已落地） |
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
| D7.1 | 文档模型 + 图层创建 | 新增 `document.js`（图层栈纯函数）；`studioDoc.js` 接入；`aiPanel` 图层条加复制/上移/下移 | 新建/删除/复制/排序正确 |
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
| D0.1 | 预检与基线 | 已完成（补记） | — | 497 passed / Node v24.13.0 / 三页基线截图 `.cache/shots/baseline-2026-11-07-*`；详见 §12.11 |
| D0.2 | 功能开关 | 不实施（合并 D18.1） | — | 无旧面板可回退；运行时开关为 `wb.studio.perf`；D7 若引入并行渲染再重新设计 |
| D17.1 | IndexedDB 存储 + 自动保存 | 已完成 | 本次提交 | 方案 §16；恢复流程见 D17.2 |
| D17.2 | 恢复流程与横幅 | 已完成 | 本次提交 | 横幅内联在 `studio.js`，最近工程列表落地时再抽 `panels/recovery.js` |
| D17.3 | 配额、清理与多标签 | 已完成 | 本次提交 | 方案 §16；设置页「关于」新增本机工程占用与清理入口 |
| D1.1 | 导入选择器 | 已完成 | 本次提交 | 方案 §12.3；新增 `studio/importPicker.js`，未改 `refLibrary.js` |
| D1.2 | 主图导入入口与拖拽 | 已完成 | 本次提交 | 方案 §12.3；顶栏「导入 ▾」+ 画布拖拽矩阵 |
| D1.3 | 空状态素材仓库入口 | 已完成 | 本次提交 | 方案 §12.6；两个按钮改为「从本地选择 / 从素材仓库」 |
| D2.1 | 参考图三来源 | 已完成 | 本次提交 | 「+ 添加参考图 ▾」接入统一导入选择器，按剩余名额限制 |
| D2.2 | 参考图拖拽与去重 | 已完成 | 本次提交 | 方案 §12.3；参考图条/指令框接收 `Files` 与 `x-wb-ref`，重复图忽略 |
| D3.1 | 富文本编辑器内核 | 已完成 | 本次提交 | 方案 §12.4；新增 `studio/promptEditor.js`，chip 原子节点与纯文本序列化 |
| D3.2 | @ 菜单与编号联动 | 已完成 | 本次提交 | 方案 §12.4；指令框迁移富文本，删参考图同步 chip 并重排编号 |
| D4.1 | 右栏 3 段 + 扩图上下文 | 已完成 | 本次提交 | 5 tab 变 3；扩图只在工具激活时以上下文面板出现 |
| D4.2 | 蒙版工具浮条 | 已完成 | 本次提交 | 参数迁移到画布顶部浮条，画笔类工具自动出现；导出/清除不回归 |
| D4.3 | AI 更多设置折叠 | 已完成 | 本次提交 | 默认只显示指令/参考图/修改；摘要随预设、输出、Turbo 实时更新 |
| D5.1 | 左栏分组 + 顶栏菜单 | 已完成 | 本次提交 | 方案 §12.5；`TOOL_GROUPS` 四组 + 「导出 ▾」菜单（PNG/JPG/蒙版/复制/收藏） |
| D5.2 | 视觉规范与响应式 | 已完成 | 本次提交 | 三档宽度无横向滚动；工作室次要文字对比度提升到 AA（5.23/4.69/4.98） |
| D5.3 | 裁剪性能优化 | 已完成 | 本次提交 | 选框改 DOM 覆盖层；4K 拖动 0 次画布重绘、0.012ms/move |
| D6.1 | M1 回归与文档 | 已完成 | 本次提交 | §12.10 十项全勾；pytest 488 passed；三档宽度、导出菜单、粘贴、payload 映射复测通过 |
| D16.1 | AI 编辑历史卡片 | 已完成 | b0aaba5 | 方案 §15.2；`sessionHistory.js` + `studio/aiHistory.js`，刷新可恢复、载入还原指令/参考图 |
| D16.2 | 图片对比 | 已完成 | 本次提交 | 方案 §15.3；`compareLauncher.js`，顶栏/结果卡片/历史卡片/Shift+C 四入口 |
| D18.1 | 性能探针与基线 | 已完成 | 本次提交 | 方案 §17.4~§17.6；`studio/perf.js` + `studio.js` 接入，4K 基线已填表（§17.6） |
| D18.2 | 工作室交互优化 | 已完成 | 本次提交 | 脏矩形 tint、叠加底层缓存、调色低分代理；4K 实测见 §17.6 |
| D18.3 | 图像工具与蒙版优化 | 已完成 | 本次提交 | 工作画布签名缓存 + 尺寸签名 + rAF 叠加层合并；裁剪 30.43→16.68ms；蒙版编辑器实测 16.55ms 达标未改代码；4K 实测见 §17.6 |
| D18.4 | 性能回归基准 | 已完成 | 本次提交 | `perf.js` 新增 `measureFrames` 并挂 `__wbPerf.measure`；DPR 2 四场景 `draw()` 均 <16ms；headed 真实浏览器复测见 §17.6.1 |
| D18.5 | M1C / M1D 验收收口 | 已完成 | 本次提交 | §17.7 四条逐项实测：DPR 2 帧耗时 <16ms、60s 内存无增长（撤销栈 3 步符合预算）、导出/渲染像素一致、S-25 探针在无 filter realm 判定为 false；真机 GPU 目检保留人工项；详见 §12.11 |
| D19.1 | 数据与输出一致性 | 已完成 | 本次提交 | §18 S-01~S-04 |
| D19.2 | AI 任务上下文 | 已完成 | 本次提交 | §18 S-05~S-08 |
| D19.3 | 输入健壮性 | 已完成 | 本次提交 | §18 S-09~S-13 |
| D19.4 | 编码与内存 | 已完成 | 本次提交 | §18 S-14~S-19 |
| D19.5 | 事件与生命周期 | 已完成 | 本次提交 | §18 S-21~S-24 |
| D19.6 | 兼容与降级 | 已完成 | 本次提交 | §18 S-25 |
| D7.1 | 文档模型 + 图层创建 | 已完成 | 本次提交 | `document.js` 提供 `createDocument / addLayer / removeLayer / moveLayer / cloneLayer / findLayer / indexOf / layerCount`（纯函数、零依赖，`layers[0]` 为最底层）；`StudioDoc.layers` 改为图层栈访问器，`addOverlay / removeOverlay` 走内核，新增 `cloneOverlay / moveOverlay`；AI 面板图层条加「⧉ 复制 / ↓ 上移 / ↑ 下移」，操作均入撤销栈。实测 1024×768 工程叠加两张扣图：复制插在源层上方（`overlay-a.png 副本`）、对顶层再上移为 no-op、下移后顺序 `[a, b, a副本]`、删除后两层、撤销逐级还原至空；控制台无报错。`docToJSON/fromJSON` 未实现：工程持久化已用「Blob + props」完整保存图层，D7.3 复核后确认无需额外 JSON 路径 |
| D7.2 | 合成渲染器 | 已完成 | 本次提交 | 新增 `renderer.js`：`drawLayers(ctx, layers, {crop})` 按底→顶逐层绘制并在 `crop` 时整体平移，`composite(ctx, underlay, layers, {crop})` 先底图后图层；`studioDoc.renderBase()` 改为调用 `composite`，底图/图层绘制顺序集中一处。模块级实测顶层覆盖底层、裁剪平移 10px 生效，§17.7 导出像素一致性未回退 |
| D7.3 | 图层面板 | 已完成 | 本次提交 | 新增 `layerPanel.js`：拖拽行落到目标下标、双击就地重命名、锁定按钮（`OverlayLayer.locked` 让 `hitTest` 返回 false，画布不可选/拖但继续合成）、不透明度滑杆；`studio.js` 新增 `moveLayerTo/renameLayer/toggleLayerLock`（均入撤销栈），工程保存 props 增加 `locked`。实测：重命名/锁定/拖拽排序/不透明度四项均修改成功且撤销还原，不透明度重做回滚正确；模块级锁定命中测试 false、clone 保留 locked。移除 aiPanel 重复监听后修复「撤销原地不动」。`docToJSON/fromJSON` 不实现（持久化已用 Blob + props） |
| D7.4 | 历史记录 + 快捷键 | 已完成 | 本次提交 | 新增 `history.js`：`createHistory({limit, budget})` 双栈 + 字节预算，步数先裁、预算再裁且至少保留初始+最新两帧；`studioDoc` 的 `snapshot/undo/redo/canUndo/canRedo` 委托 `_history`，新增 `historyBytes` / `clearHistory()`，工程恢复改为 `clearHistory + snapshot`。实测 `limit=3` 推 6 帧得 `[3,4,5]`、`budget=100`（40B/帧）推 10 帧得 `[8,9]`（80B）、undo/redo 序列与 `clear` 归零正确；页面 4 笔蒙版可连撤 4 次、重做 2 次，恢复工程后撤销按钮初始禁用。快捷键沿用既有 `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`。图层维度历史断言并入 D7.3 |
| D8.1 | 选区核心 | 已完成 | 本次提交 | 新增 `studio/selection.js`（alpha 蒙版、魔棒洪泛、羽化/扩展/收缩、蚂蚁线路径）；`studio.js` 加魔棒工具 + `.studio-selbar` 浮条，画笔/形状按选区裁剪；实测见 §12.11 |
| D8.2 | 图层蒙版 | 已完成 | 本次提交 | `OverlayLayer` 增加可画可擦蒙版与 `maskedImage()` 缓存；图层面板 `◐`/`✎`；`docToLayerTransform` 映射涂抹；随工程保存 `maskBlob`；实测见 §12.11 |
| D9.1 | 调色数学库 | 已完成 | 本次提交 | 新增 `studio/color.js`（曲线/色阶/HSL/色彩平衡/白平衡，纯函数）；新增 `web/tests/studio/color.test.mjs`，`node --test` 23 项全绿；实测见 §12.11 |
| D9.2 | 直方图 + LUT | 已完成 | 本次提交 | `color.js` 追加 `histogram/parseCube/sampleCube/applyCube`；`studioDoc` 支持 `adjust.lut` 逐像素查表；调色面板加直方图与 .cube 加载/强度；实测见 §12.11 |
| D9.3 | 调整图层 | 已完成 | 本次提交 | 新增 `studio/adjustments.js`（`AdjustmentLayer` + `applyAdjustment` + `applyAdjustmentLayer`）；`renderer`/`studioDoc` 合成管线支持调整层；图层显隐眼睛按钮；面板选中调整层后滑杆接管、LUT 禁用；随工程保存 `kind/params/visible`；实测见 §12.11 |
| D9.4 | 局部调整 | 已完成 | 本次提交 | `adjustments.js` 追加 `normalizeLocal/localStrengthAt/buildLocalMask`；`AdjustmentLayer` 支持 `local` + `setLocal/clearLocal`；调色面板「局部范围」区块（线性/径向/画笔/全图 + 过渡）；画布取景辅助线；随工程保存 `local`；实测见 §12.11 |
| D10.1 | 污点修复 | 已完成 | 本次提交 | 新增 `studio/heal.js`（`ringSamples` + `healDab` 锥形渐变补丁）；`studioDoc.repair` 修复层并入渲染/历史/旋转翻转；`spot` 工具（J）+ 笔刷参数；随工程保存 `repairBlob`；单测 5 项；实测见 §12.11 |
| D10.2 | 仿制图章 / 修复画笔 | 已完成 | 本次提交 | `heal.js` 追加 `cloneDab/meanRgb/shiftPatch`；`studioDoc.renderSample()` 提供干净取样源；`clone`（S）/`healbrush`（H）工具 + Alt 取样 + 对齐开关 + 锚点/取样标记；实测见 §12.11 |
| D10.3 | 涂抹 | 已完成 | 本次提交 | 新增 `studio/smudge.js`（`normalizeVector/smudgeShift/smudgeDab`）；`smudge` 工具（U）+ 笔刷参数；写入修复层并整笔一次撤销；单测 5 项；实测见 §12.11 |
| D10.4 | 磨皮 | 已完成 | 本次提交 | 新增 `studio/skin.js`（`boxBlur/smoothSkin/skinDab` 频率分离）；`skin` 工具（K）+ 笔刷参数（不透明度兼作强度）；单测 6 项；实测见 §12.11 |
| D10.5 | 液化 | 已完成 | 本次提交 | 新增 `studio/liquify.js`（`pushWeight` + `warpPatch` 反向取样形变）；`liquify` 工具（Y）+ 累计位移；单测 4 项；实测见 §12.11 |
| D11.1 | 马赛克 / 模糊 | 已完成 | 本次提交 | 新增 `studio/mosaic.js`（`pixelate` + `mosaicDab`，马赛克/模糊双模式）；`mosaic` 工具（P）+ 模式下拉；单测 4 项；实测见 §12.11 |
| D11.2 | 文字图层 | 已完成 | 本次提交 | 新增 `studio/textLayer.js`（`TextLayer` / `TEXT_FONTS` / `TEXT_DEFAULTS` / `textLayerFromProps`）；`StudioDoc.addTextLayer` + 工程持久化 `kind:'text'`；左栏 `text` 工具（T）+ 右侧「文字」分页（文案/字体/字重/字号/颜色/描边/投影/删除）；移动拖动、整页撤销、刷新恢复；单测 6 项；实测见 §12.11 |
| D11.3 | 贴纸 | 已完成 | 本次提交 | `layers.js` 追加 `BLEND_MODES` / `flipH/flipV/blend` / 旋转命中；`addOverlayFile` 支持落点与切页；`sticker` 工具（G）+ 右侧「贴纸」分页（导入/缩放/旋转/翻转/混合模式/删除）；画布四角缩放 + 旋转圆点（15° 吸附）；工程持久化翻转与混合；单测 5 项；实测见 §12.11 |
| D11.4 | 形状与图案图章 | 已完成 | 本次提交 | 新增 `studio/shapeLayer.js`（矩形/椭圆/直线/箭头，填充/描边/圆角，`kind:'shape'` 持久化）与 `studio/pattern.js`（`tilePatch` + `patternDab`）；`shape` 工具（D）+ 右侧「形状」分页；`pattern` 工具（N）+ Alt 拖框取样 + 浮条提示/清除；`renderSample()` 纳入叠加层/文字/形状；单测 10 项；实测见 §12.11 |
| D12.1 | 混合模式 + 剪贴蒙版 | 已完成 | 本次提交 | `BLEND_MODES` 扩展到叠加/文字/形状层；图层新增 `blend/clipped` 并持久化；`renderer.drawLayers()` 用双离屏画布做 alpha 剪贴（取最近未剪贴下层）；右侧「图层属性」区块 + 「剪」徽标；拖动预览复用同一渲染路径；实测见 §12.11 |
| D12.2 | 图层样式 | 已完成 | 本次提交 | `shapeLayer.js` 新增 `SHAPE_STYLE_DEFAULTS/normalizeShapeStyle` 与 `style`（外阴影/外发光/渐变叠加/颜色叠加）；剪影 + 反向 shadowOffset 实现阴影/发光，渐变与颜色叠加画在主体之上；形状分页新增样式区块并持久化；单测 24 项；实测见 §12.11 |
| D12.3 | 历史快照 | 已完成 | 本次提交 | `history.js` 新增命名快照（add/remove/find）；`StudioDoc.addSnapshot/restoreSnapshot/renameSnapshot/removeSnapshot`，回跳先入栈可撤销；右侧「历史快照」区块（新建/回跳/双击重命名/删除）；单测 3 项；实测见 §12.11 |
| D13.1 | AI 主体选择 | 已完成 | 本次提交 | 新增 `studio/segment.js`（发送尺寸/坐标换算/灰度蒙版→选区/候选排序）+ `AI 主体选择` 工具（A）与顶部浮条（主体/框选/点选/文字、多候选、羽化）；`async + pollJob` 轮询，结果直接写入选区；单测 6 项；实测见 §12.11 |
| D13.2 | 内容识别填充 | 已完成 | 本次提交 | 选区「转为蒙版 / AI 消除」：选区 alpha 并入文档蒙版并入撤销栈，AI 消除自动切「元素移除」预设 + `remove` 任务 + 默认指令；`aiPanel.prepareTask()` + `syncTaskHint()`；实测见 §12.11 |
| D13.3 | 透视变换 / 路径文字 | 已完成 | 本次提交 | 新增 `studio/perspective.js`（单应矩阵 + 反向采样，`OverlayLayer.quad` 四角透视 + 缓存/持久化 + 画布四角编辑）；`arcLayout` + `TextLayer.arc` 沿弧线逐字排版 + 文字分页弯曲滑杆；单测 11 项；实测见 §12.11 |
| D14.1 | 全景图入口 | 已完成 | 本次提交 | `payload.js` 新增 `panoramaPlan / PANORAMA_ASPECTS / PANORAMA_MAX_PIXELS`（与后端同算法）；任务下拉加「全景」，输出区新增全景面板（2:1/3:1/4:1/21:9、长边 2048/3072/4096、环绕接缝），覆盖项走 `panorama.*`；单测 7 项；实测见 §12.11 |
| D15.1 | 高清放大入口 | 已完成 | 本次提交 | 顶栏「放大」→ `upscaleDialog.js`：读取 `api.upscaleModels()` 列出就绪引擎（VOSR2 / SeedVR2 / FlashVSR，默认 VOSR2），倍率 2×/4×，提交当前烘焙主图后按 `pollJob` 显示进度、可取消；结果卡片显示输出尺寸与文件名，可「载入为主图」（新工程，可继续编辑 / 导出）或「与当前主图对比」（走 `ai.compareAll({ extra })`）。实测 512×384 → 1024×768（vosr2 2×），载入后尺寸与文件名同步 |
| D10F | 修复类工具收尾修复 | 已完成 | 本次提交 | 修复类工具（J/S/H/U/K/Y/P/N）与文字落点、局部调整取景统一经 `maskPoint()` 换算裁剪坐标；新增 `repairPaint()` 用 `destination-in` 叠选区 alpha（蚂蚁线路径不能 `clip`）；顺带修复剪贴基座为调整层崩溃、快照默认名重复、贴纸透视勾选状态、形状样式 NaN；单测 116 项全绿；实测见 §12.11 |
| D20.1 | 面板布局收尾修复 | 已完成 | 本次提交 | 右侧面板被内容撑高、`[hidden]` 被 flex 覆盖、快照区固定占位 → 底部区块不可见且滚不到；`grid-template-rows:minmax(0,1fr)` + 面板 `[hidden]` 兜底 + 快照区可收缩 + `.page-studio` min-height 480；三档窗口实测见 §12.11 |
| D20.2 | 工具轨收尾修复 | 已完成 | 本次提交 | 工具轨改可滚动（首尾工具不再被裁）、矮窗口工具收紧到 36px、切换工具 `scrollIntoView`；删除悬停组名浮字，组名并入工具 `title`；实测见 §12.11 |
| D20.3 | 扩图上下文收尾修复 | 已完成 | 本次提交 | 从扩图切走后 `activeTab` 归一为 `ai` 时漏调 `syncTabs()`，导致外补画布面板常驻、AI 面板隐藏；已补并实测见 §12.11 |
| D20.4 | 工具轨分组 + 顶栏去重 | 已完成 | 本次提交 | 左栏 21 个工具收成 6 个工具组（组按钮显示上次使用工具 + 小三角，点击展开 fixed 浮层，点外部/Esc/滚动自动收起）；顶栏去掉与侧栏重复的「送入图像编辑」，改为「导出 → 发送到图像编辑 →」；实测见 §12.11 |
| D21.1 | 抠图 / 透明导出 | 方案定稿（未实施） | — | 方案见 §19.1~§19.9：选区 alpha → `destination-in` 裁合成结果 → 透明 PNG / 剪贴板 / 抠图层 / 白底 JPG；边缘预设「硬边/标准/发丝」；P0 先做透明 PNG + 复制 |
| D22.1 | 主图版本抽屉 | 方案定稿（未实施） | — | 方案见 §19.10~§19.21：**右栏随主体上移，底部整条让给通栏 Dock**（macOS 桌面菜单栏同款），64×64 图片卡，原始主图固定第 1 张 + 分隔线；滚轮=横向轮播、悬停邻位放大/切换弹跳/当前圆点；最右「项目历史」书脊面板（`listProjects()` 工程列表，与全局历史记录页同源）；IndexedDB 版本链（原始 blob 导入即落盘，上限 30）；V1 先做只读 Dock + 原始卡 |
| D22.2 | 项目生命周期 | 方案定稿（未实施） | — | 方案见 §19.22：顶栏 `＋ / ⋯` 菜单提供新建、作为新主图、立即保存（Ctrl+S）、重命名、关闭、删除；项目历史面板点选切换；删除走 `clearProject` 回空状态；修复「有主图后导入只能变参考图、无法开新任务」 |

### 14.13 启动顺序（等通知后）

1. D0.1 预检（已完成·补记）→ D0.2 开关（不实施，见 §12.11）→ D17.1 存储层 → D17.2 恢复流程 → D17.3 配额与多标签。
2. 按 D1.1 → D1.2 → … → D6.1 完成 M1，每项提交一次。
3. M1 后依次 D16.1 → D16.2 → D18.1 → D18.2 → D18.3 → D18.4；D18.3 开工前已确认同事 WIP（`91eb15a` / `0af4c87`）提交完毕。
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

#### 实施结果（D5.3，已完成）

| # | 方案 | 状态 | 落地说明 |
| --- | --- | --- | --- |
| 1 | 裁剪框改 DOM 覆盖层 | 已实现 | `.studio-crop-overlay > .studio-crop-box`，外侧变暗用 `box-shadow: 0 0 0 9999px rgba(12,14,16,.5)`，三分网格用两层 CSS 渐变；`pointermove`（crop）只调 `syncCropOverlay()`，**不再触发 `scheduleDraw()`** |
| 2 | 阴影移出 Canvas | 已实现 | 删除 `ctx.shadowBlur/shadowOffsetY`，改为画布 CSS `filter: drop-shadow(0 10px 26px rgba(0,0,0,.26))`（跟随图像 alpha，视觉与原来一致） |
| 3 | 缓存视口矩形 | 已实现 | `pointerdown` 缓存 `canvas.getBoundingClientRect()` 到 `dragRect`，`pointermove` 复用，`endDrag` 清空；`toImage(x, y, rect)` 支持传入缓存 |
| 4 | 帧内去重 | 已实现 | `syncCropOverlay()` 比较 `cropBoxStyle`，坐标取整到 1px，未变化不写 DOM |
| 5 | 底图按视口缓存 | 未做 | 平移/缩放的整图重绘留给 D18.2 统一处理，避免与 D5.3 混在一起 |
| 6 | 文档版本号 | 未做 | 同上，归入 D18.2 |
| 7 | 性能探针 | 已实现 | `localStorage.wb.studio.perf='1'` 时，`draw()` 累计 60 帧后输出均值/最大值 |

实测（4096×4096 JPEG、1440×900、Chromium headless）：裁剪拖动 60 次 `pointermove` 期间 `clearRect` 调用 **0 次**（优化前每帧 1 次整图重绘 + 阴影模糊），单次 move 处理平均 **0.012ms**、最大 0.2ms；选框位置/尺寸、`1867 × 1244` 尺寸回显、应用裁剪后画布变为 `1,867 × 1,244`、覆盖层隐藏均正确；画笔涂抹仍正常重绘（3 次指针事件合并为 2 帧）且蒙版覆盖率和撤销不受影响；旋转/取消裁剪沿用原有清空逻辑。

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

**实施进度**：D17.1 已完成 —— 新增 `studio/persistence.js`（数据库 `wb-studio` v1，含 `meta / projects / layers / refs / session / aiHistory / aiResults / drafts` 八个 store，写入统一走单个事务）；主图原文件、叠加层位图、蒙版、参考图、指令、AI 参数、变换、调色、裁剪框、视口与当前工具全部落库；保存触发为提交边界 800ms 防抖 + 空闲 5s 兜底 + `visibilitychange(hidden)` / `pagehide` flush + 页面 `destroy()` flush；未变化的底图与叠加层按签名跳过重写，参考图独立存 Blob 且不重复写进 session；失败指数退避（2s→30s）并提示一次，内存状态不丢；面板底部显示「保存中 / 已保存 / 保存失败，重试中」，IndexedDB 不可用时明确提示不会持久化。已实测：打开图片、改指令、旋转、加参考图后，IndexedDB 中 `projects / layers(base) / session / refs` 记录与实际状态一致。

D17.2 已完成 —— 进入工作室时读取 `meta.lastProjectId`：同标签页刷新直接静默恢复；新标签页打开显示「上次编辑未完成 · X 分钟前」横幅，可恢复或忽略（忽略写 sessionStorage，本次会话不再提示）。恢复覆盖主图、完整蒙版、叠加层（保留原图层 id）、旋转/翻转/裁剪、调色、指令、参考图、AI 参数、视口与当前工具；历史栈重置为单步基线，工程 id 不变，后续自动保存继续增量写入。实测：指令、旋转 90°、矩形蒙版 11.4%、叠加层、曝光 40 在刷新后全部还原；忽略后再次刷新不再提示；打开新图会新建工程且旧工程保留。多标签并发写入与配额清理留待 D17.3。

D17.3 已完成 —— 多标签编辑租约（`localStorage` 心跳 + `BroadcastChannel`，`storage` 事件兜底）：同一工程后开标签恢复时自动转只读，横幅提示「该工程已在其他标签编辑 · 本标签为只读」，画布与右栏停止交互、自动保存停摆，可一键「接管编辑」，原标签立即收到通知并转只读，避免互相覆盖；租约 12s 无心跳自动过期，关闭页面时主动释放。保存前用 `navigator.storage.estimate()` 检查源站占用，≥80% 提示一次；写入抛出 `QuotaExceededError` 时提示「空间不足，先导出再清理」并保留内存状态与重试；首次保存成功后申请 `navigator.storage.persist()`。进入工作室时自动清理排名 10 名之外或超过 7 天未更新的旧工程，正在被其他标签编辑的跳过；设置页「关于」新增「本机精修工程」行，显示工程数与源站占用（如「2 个工程 · 占用 55.1 KB / 6.0 GB」），并提供二次确认的「清理」入口。已实测：租约抢占 / 接管 / 释放、只读态 DOM（`data-locked`、横幅、`pointer-events:none`）、按数量与时间清理、被租用工程跳过、设置页统计与取消清理；无 JS 异常（仅有后端健康检查的 `ERR_CONNECTION_REFUSED`，与本次改动无关）。

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
| 1 | 工作室 · 裁剪 | `pointermove → scheduleDraw → draw()` | ~~全画布清空 + 整图 `drawImage` + `shadowBlur:26` + 选框再绘制~~ **D5.3 已优化**：选框改 DOM 覆盖层，拖动 0 次画布重绘 | 已解决（D5.3） |
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
| 12 | 图像工具 · 裁剪 / 移动选框 | `pointermove → render()`（异步） | 每次 move 都 `loadSourceImage` + `applyOpsToCanvas` 全量重算 + 两块画布重设 `width`（强制重分配）+ 全量重绘；**没有 rAF 合并**，一帧可触发多次 | 已解决（D18.3：工作画布签名缓存 + 尺寸签名 + rAF 合并，16.68ms 均） |
| 13 | 图像工具 · 水印拖动 | `pointermove → render()` | 同上，整条处理链重跑 | 已解决（D18.3：同上，16.63ms 均） |
| 14 | 蒙版编辑器 · 画笔 | rAF + `drawImage` 显示尺寸 | 每帧重绘显示层与预览层，无阴影；需实测 4K 下帧耗时 | 实测达标（4K 16.55ms 均 / 22.7ms 峰，D18.3） |
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

**注意**：`imageTools.js` / `maskEditor.js` 的同事高清放大 WIP 已于 `91eb15a` / `0af4c87` 提交，D18.3 已在干净工作区完成，无冲突。

### 17.6 性能基线（D18.1 填写）

| 场景 | 分辨率 | D18.1 基线 | D18.2 / D18.3 优化后 | 目标 |
| --- | --- | --- | --- | --- |
| 裁剪拖动（工作室） | 4096² | 0.012ms/move、0 次重绘（D5.3） | 未改动 | <16ms/帧 |
| 平移 / 缩放 | 4096² | draw 0.20ms 均 / 0.40ms 峰（41 帧）；缩放 0.13 / 0.30（20 帧） | 3.20ms 均 / 6.70ms 峰；缩放 2.15 / 3.60（含 1 个叠加层与蒙版） | <16ms/帧 |
| 蒙版涂抹 | 4096² | draw 45.15ms 均 / 144.2ms 峰（41 帧） | 3.48ms 均 / 22.6ms 峰（31 帧） | <16ms/帧 |
| 叠加层拖动 | 4096² | draw 102.06ms 均 / 127.5ms 峰（31 帧） | 2.39ms 均 / 4.70ms 峰（31 帧） | <16ms/帧 |
| 调色滑杆 | 4096² | draw 123.62ms 均 / 162.8ms 峰（40 帧） | 拖动 7.96ms 均 / 9.10ms 峰（40 帧）；松手一次全量 126.7ms | 预览 <16ms/帧 |
| 图像工具裁剪拖动 | 4096² | 帧间隔 30.43ms 均 / 51.2ms 峰（40 帧中 39 帧 >16.7ms） | 16.68ms 均 / 18.0ms 峰（40 帧中 20 帧 >16.7ms）；同步 dispatch 0.003ms/move（D18.3） | <16ms/帧 |
| 图像工具水印拖动 | 4096² | 未单独采样 | 16.63ms 均 / 17.9ms 峰（30 帧，D18.3） | <16ms/帧 |
| 蒙版编辑器画笔 | 4096² | 未实测（待测） | 16.55ms 均 / 22.7ms 峰（40 帧，D18.3 实测通过，未改代码） | <16ms/帧 |
| 历史 20 步内存 | 4096² | 每步 67MB，预算 256MB → 仅保留 3 步（≈201MB） | 未改动（已满足） | <256MB |

> 测量环境：Chromium headless、视口 1440×900、DPR 1、4K 测试图为 4096×4096 渐变 + 色块；`__wbPerf` 探针统计 `draw()` 耗时（不含浏览器合成），各场景在同一页面会话内 `reset → 操作 → snapshot` 连续采样。D18.2 数据在画布实际可见（756×551、缩放 12%）下取得，并带 1 个 800² 叠加层与已涂蒙版；D18.3 的图像工具数据在显示画布 438×438（缩放 11%）下按「rAF 帧间隔」采样，蒙版编辑器为页内独立实例（视口 1050×820、viewScale 0.195）。
> 已知限制：headless 下 `performance.memory.usedJSHeapSize` 被量化到 10MB 粒度，只能作趋势参考；画布后备存储不计入 JS 堆，历史内存按 `HISTORY_BUDGET` 字节预算与实测可撤销步数折算；无 GPU 合成差异未覆盖，见 §17.6.1 的 DPR 2 / 真实浏览器复测。headless 的合成 `PointerEvent` 需先 stub `setPointerCapture`，否则会抛 `NotFoundError` 中断拖动。
> 结论：工作室平移 / 缩放 / 蒙版涂抹 / 叠加层拖动 / 调色拖拽，以及图像工具裁剪 / 水印拖动、蒙版编辑器画笔，均已进入 16ms 预算（调色松手后一次性全分辨率合成为 127ms，属预期的一次性成本）；剩余帧间隔抖动来自 rAF 与 16.7ms 的对齐，不再有全量重算。

### 17.6.1 D18.4 回归复测（DPR 2 / 真实浏览器）

| 场景 | DPR 2 headless `draw()` 均 / 峰（帧数） | DPR 2 帧间隔 均 / 峰 | headed DPR 1 `draw()` 均 / 峰（帧数） |
| --- | --- | --- | --- |
| 缩放 | 0.21ms / 0.9ms（21） | 16.45 / 18.2 | 0.37ms / 1.1ms（20） |
| 蒙版涂抹 | 5.93ms / 37.5ms（41） | 16.30 / 18.5 | 0.64ms / 5.3ms（40） |
| 叠加层拖动 | 5.94ms / 7.7ms（36） | 25.92 / 50.3 | 0.48ms / 1.2ms（35） |
| 调色拖动 | 13.74ms / 133.3ms（35，含松手一次全量） | 16.55 / 24.1 | 3.07ms / 86.6ms（35） |

- 复测条件：4096² 底图 + 1 个 800² 叠加层 + 已涂蒙版；DPR 2 画布后备存储 922×970（CSS 461×485）；`draw()` 含 1 帧 = 1 次合成。
- DPR 2 构造方式：headless Chromium 无法通过启动参数改 DPR，用 `Object.defineProperty(window,'devicePixelRatio',{get:()=>2})` 后触发一次 stage 尺寸变化让 `sizeCanvas()` 重新计算，等效验证「后备存储翻倍」路径；真实 HiDPI 合成差异未覆盖。
- headed（`headless:false`，1440×900，DPR 1）：窗口在自动化环境中被系统遮挡，rAF 被节流到 ~1fps，**帧间隔不可用**；但 `draw()` 数据有效，且都 ≤ headless 同场景数值。
- 结论：DPR 2 下四个交互的 `draw()` 均 <16ms（最高为调色拖动 13.74ms，其中 133.3ms 峰值来自松手后的全分辨率合成，属一次性成本），满足 §17.7 第一条；叠加层拖动的帧间隔 25.92ms 与 `draw()` 5.94ms 不匹配，差异在合成器侧（DPR 2 下 4 倍像素的软件光栅化），真实 GPU 浏览器需人工目检。
- 后续如需更低延迟：调色拖动可把 1024 代理再降到 720；叠加层拖动可考虑拖动期间暂停非必要的 DOM 层刷新。

**复测方法（后续里程碑对比用）**

1. `localStorage['wb.studio.perf']='1'` 后刷新，确认 `window.__wbPerf.enabled === true`。
2. 单帧耗时：`__wbPerf.reset()` → 执行交互 → `__wbPerf.snapshot().probes.find(p => p.label === 'studio.draw')`。
3. 帧间隔：`__wbPerf.measure(40, (i, n) => 拖动一步)` → 返回 `{ frames, avg, peak, over16, total }`（D18.4 新增，`perf.js` 导出 `measureFrames`）。
4. 合成 PointerEvent 前先 stub `element.setPointerCapture = () => {}`，否则 headless 下会抛 `NotFoundError` 中断拖动。

### 17.7 验收标准

- 4096² 图、DPR 2 下，上述交互平均帧耗时 <16ms，无肉眼可见拖影。
- 连续操作 60s，内存不持续增长；历史 20 步内存低于预算。
- 所有功能行为不变：裁剪尺寸、蒙版范围、叠加层位置、调色结果与优化前一致。
- 图像工具与蒙版编辑器不因优化产生导出差异。

**实测结论（D18.5，headless Chromium，4096² 底图，DPR 2：CSS 768×531 / 后备存储 1536×1062）**

| 验收项 | 实测 | 结论 |
| --- | --- | --- |
| DPR 2 帧耗时 | 缩放 9.85 / 14.0ms、蒙版涂抹 9.11 / 12.1ms、调色拖动 15.49 / 33.7ms（均值 / 峰值），松手全量合成一次 164.3ms | 通过（均值均 <16ms；调色单帧峰 33.7ms 为代理重建抖动，无拖影反馈） |
| 60s 连续操作内存 | 292 轮混合操作、1585 帧 `draw()`，`usedJSHeapSize` 全程 73MB 无增长；撤销栈 3 步、重做 3 步 | 通过（4K 蒙版单步 67MB，`HISTORY_BUDGET=256MB` 淘汰生效；Canvas 后备存储在 JS 堆外，堆值仅作趋势参考） |
| 功能行为一致 | 裁剪 500×400、蒙版 5.00%（裁剪后仍 5.00%）、叠加层居中 (150,150)、曝光/对比度像素按预期变化 | 通过 |
| 导出与渲染一致 | `exportCanvas` 与 `renderBase` 尺寸、采样像素逐字节一致；4K 实际导出 PNG 15.07MB / JPG 305KB / 蒙版 904KB，全部 4096×4096 且非空白 | 通过 |
| S-25 降级 | 无 filter 的 iframe realm 中 `supportsCanvasFilter === false`，主 realm 为 `true` | 通过（UI 禁用四个滑杆并提示，色温/色调保留） |
| 真机 GPU 目检 | 自动化环境不覆盖 HiDPI 合成器差异 | 人工项，不阻塞 |

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
| S-26 | 编辑页润色不把参考图交给视觉模型，指代式指令无法展开 | P1（已修） | `edit.js:690-712`、`polish.js:62-80` |

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

**S-26 润色看不到参考图，指代式指令写不成可执行描述（P1，实测，已修复 `8edd0f7`）**

- 现象：编辑页输入 `让 <image1> 做出 <image2> 的动作`，提交后出图与第 1 张几乎一样，`quality.changed_ratio` 仅 **2.4%**，`<image2>` 形同废纸。
- 根因链：
  1. `edit.js` 调 `polishWithDialog` 时只传 `prompt / mode / styleHint / targetSize / pose`，不传 `images` 与 `references`；`polish.js` 参数表里也没有 `images`。
  2. 后端 `/api/polish` 本身支持 `payload.images`（解码成 PIL 交给视觉模型），收不到就降级为纯文本改写。
  3. `data/pe_system_prompt_edit.txt` 的 Image Reference Rules 强制 `<imageN>` 指代，于是润色结果仍是指代式。
- 实测对照（同图同 seed，Turbo 8 步）：指代式 **2.4%** → 去掉 Remove LoRA **29%** → 详细动作描述 **51.6%**（两张）/ **52.1%**（只给图 1）。
- 结论：多图条件确实进了 DiT（`keep_vision = len(ref_latents) == 0`，视觉 token 被 reference latent 替换是设计如此），但模型对「第 2 张提供姿态」这类指代不敏感；真正起作用的是**可执行的动作描述**。
- 修复：`polish.js` 透传 `images`（上限 6 张）与 `references`，`edit.js` 传入参考图本体与角色清单；复测润色 13.4s 产出具体描述，提交后 `changed_ratio 39.1%`，姿态迁移成功。
- 遗留：多图仍是弱条件，不做润色时不要承诺「精确动作迁移」；动作迁移优先走「姿态」面板（VNCCS）。

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
- 归属：已在 D18.3 修复（工作画布签名缓存 + `syncCanvasSize` + rAF 叠加层合并），本条只登记为稳定性问题，避免与 §17 重复排期。

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

**S-25 `ctx.filter` 缺失时静默降级（P2，已实测：探针有效 / UI 已禁用）**

- 证据：`if (ctx.filter !== undefined)` 才应用曝光 / 对比 / 饱和度；不支持时完全不生效，也没有提示。
- 后果：旧版 Safari 上预览与导出都「看起来没反应」，用户以为滑杆坏了。
- 修复：启动时探针检测 `ctx.filter`；不支持则降级为像素级调色（复用 D9.1 的 `color.js`）或禁用对应滑杆并提示。
- 实测（D18.5）：在 iframe 新 realm 把 `CanvasRenderingContext2D.prototype.filter` 的 setter 置空（读取恒为 `none`）后动态 import `studioDoc.js`，`supportsCanvasFilter === false`，同页主 realm 仍为 `true`；该分支下 `applyCanvasFilterCapability()` 禁用曝光 / 亮度 / 对比度 / 饱和度并显示说明，色温与色调保留。像素级降级（`color.js`）未实施，留待 D9.1 调色数学库。

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

**实施进度**：D19.1 已完成 —— 旋转/翻转在存在叠加层或裁剪时先确认；重置确认文案补上叠加层数量；叠加层不透明度松手落快照（可撤销）；AI 预览态拦截导出/复制/收藏/送编辑。D19.2 已完成 —— 删除参考图时同步移除并前移 `@图N`；换主图/载入结果清空参考图与指令；结果任务记录实际识别值；空结果地址不再假成功。D19.3 已完成 —— 主图/参考图/叠加图统一体积与像素上限；连续开图用自增序号防串图；http(s) 图片启用 `crossOrigin` 并在失败时明确报错；历史示例 URL 用协议判断归一化；AI 预览按比例居中不再拉伸。D19.4 已完成 —— 蒙版状态一次扫描并去掉笔画后的整图编码链；导出/复制/收藏/送编辑改用 `toBlob` 异步编码（顺带修复收藏失败按钮卡死）；历史按 256MB 预算淘汰；主图缩略图按底图缓存；蒙版着色与裁剪合成不再重复分配大画布。D19.5 已完成 —— 工作室返回 `destroy()` 统一解绑 keydown/keyup/paste、断开 `ResizeObserver`、取消 rAF 并释放 tint/缩略图/预览/文档引用，`app.js` 在移除页面时调用；快捷键与粘贴统一走 `isEditableTarget()`（含 `contenteditable`、输入框与弹窗）；空格仅在非按钮/链接目标上拦截平移；闪回底图从 Tab 改为按住 `\`；粘贴前若已有主图先确认再替换。D19.6 已完成 —— 模块加载时用探针检测 Canvas filter 支持（赋值后读回校验），`studioDoc` 渲染与 `studio` 调色面板共用同一结论；不支持时禁用曝光/亮度/对比度/饱和度滑杆并在面板内说明，色温与色调仍可用。M1D（D19.1~D19.6）已全部完成，状态以 §14.12 台账为准。**M1C / M1D 验收（D18.5）**：§17.7 四条已实测并写入 §17.7 结论表 —— DPR 2 三项交互均值 <16ms、60s 混合操作 JS 堆无增长且撤销栈按 256MB 预算淘汰到 3 步、裁剪/蒙版/叠加层/调色行为与导出像素一致、S-25 探针在无 `ctx.filter` 的 realm 判定为不支持并禁用对应滑杆；仅「真机 GPU 目检」保留为人工项。

---

## 19. 抠图（透明导出）与主图版本抽屉（2026-11-08 定稿方案，未实施）

> 状态：**方案定稿，本轮不改代码**。实施后回写 §12.11 与 §14.12 台账。
> 交付编号：**D21.1 抠图**、**D22.1 主图版本抽屉**。

### 19.1 抠图：要解决什么

| 现状 | 语义 | 能不能当抠图 |
| --- | --- | --- |
| AI 主体选择 → 选区 | 白 = 选中，存在 `selection.alpha`（未裁剪图像空间） | 只是圈住，没动像素 |
| 选区条「转为蒙版」 | 白 = 要 AI 重绘，写入 `doc.mask` | 不是抠图，是送 AI 消除 |
| 选区条「AI 消除」 | 走 `/api/edit` 重绘 | 会重画背景，拿不到透明底 |
| 导出 PNG / JPG | `doc.bake()` 整图合成 | 画布不透明，**没有 alpha** |
| 导出蒙版 | 黑白 PNG | 只能给外部工具用 |
| 收藏到素材仓库 | 整图 PNG | 无透明信息 |

根因：`StudioDoc` 的合成始终以实心底图为底，烘焙结果天然是不透明位图；要抠图必须新增一条「用选区 alpha 裁剪合成结果」的出口，**不能复用 `doc.mask`**（两者语义相反）。

目标形态（四种，按优先级）：

1. **透明 PNG**：选区外 alpha=0，选区内保留原像素（可带半透明边缘）；
2. **复制到剪贴板**：同透明 PNG，供其它软件直接粘贴；
3. **抠图层**：把选区内容落成一个可移动/缩放/旋转的叠加层（贴纸层），原底图可隐藏或替换背景；
4. **白底 JPG**：反选后填充白色（电商/证件照场景），不要求透明。

### 19.2 抠图：坐标与画布（原理，必须先对齐）

| 空间 | 尺寸 | 说明 |
| --- | --- | --- |
| 选区空间（`selection.alpha` / `doc.mask`） | 旋转后、**未裁剪**图像尺寸 | `selection.width/height`；`maskPoint()` 在此空间 |
| 可见空间 | `doc.size`（裁剪后） | 画布显示、导出、蒙版覆盖率都按这个 |
| 导出空间 | 与可见空间相同 | 抠图产出尺寸 = `doc.size` |

换算关系（锁死）：

- 导出画布尺寸 = `doc.size`；
- 选区在导出画布中的左上角偏移 = `-crop.x, -crop.y`（无裁剪时为 0）；
- 任何「图像坐标 → 导出坐标」都要减去 crop 偏移，反方向加回；
- 尺寸不一致时（选区与 `maskSize()` 不同）直接拒绝并提示重新选择，不做隐式拉伸。

### 19.3 抠图：像素级步骤（锁死顺序）

1. **前置校验**
   - 必须存在 `selection` 且 `coverage > 0`；
   - `selection.width/height === maskSize()`；
   - 若 `preview.image` 处于 AI 结果预览态 → 走 `previewBlocked('抠图')`，提示先「载入为新底图」或关闭预览（与导出一致，避免所见非所得）。
2. **合成底图**：取 `doc.renderBase()`（已含旋转/翻转/调色/叠加层，**未裁剪**）。
3. **裁出可见区域**：新建 `baseCanvas = doc.size`，`drawImage(renderBase, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)`。
4. **选区 alpha 对齐**：新建 `alphaCanvas = doc.size`，`drawImage(selection.canvas, crop.x, crop.y, ...)`；无裁剪时直接整幅。
5. **应用 alpha**：`baseCtx.globalCompositeOperation = 'destination-in'`，`baseCtx.drawImage(alphaCanvas, 0, 0)`；结束后恢复 `source-over`。
   - 这一步只影响 alpha，不改 RGB，保证选区内颜色 1:1 保留。
6. **边缘优化（可选，顺序固定：收缩 → 羽化 → 去色边）**，详见 19.4。
7. **编码输出**：`canvas.toBlob('image/png')`；命名 `${baseName}-cutout.png`。
8. **释放**：置空中间画布引用（`baseCanvas/alphaCanvas`），大图不常驻。

为什么用 `destination-in` 而不是逐像素写 alpha：逐像素在 4K 上要遍历 800 万像素（约 40~80ms 且阻塞），`destination-in` 走浏览器合成器，且天然保留半透明边缘。

### 19.4 边缘优化（决定像不像专业抠图）

| 预设 | 收缩 | 羽化 | 去色边 | 适用 |
| --- | --- | --- | --- | --- |
| 硬边 | 1px | 0 | 关 | 商品/图形，边缘干净 |
| 标准（默认） | 1px | 0.8px | 开 | 人像/日常 |
| 发丝 | 0 | 1.2px | 开 | 头发、毛绒、纱 |

- **收缩**：复用选区能力里的 `contractAlpha`（在选区空间做，再参与合成），去掉蒙版 1px 白边。
- **羽化**：复用 `featherAlpha`，半径 0~2px；羽化后边缘 α∈(0,1)，PNG 会保留半透明。
- **去色边（decontaminate）**：只对 α∈(0.02,0.98) 的边缘带做；取半径 1~2px 内 α≥0.98 的像素 RGB 均值替换该像素 RGB，避免背景色渗进主体边缘形成白边/绿边。
- 三种处理都只作用在「导出的临时画布」，**不改文档里的选区**，因此可反复尝试、可撤销。
- 抠图层路径同样先做边缘处理再建层，避免图层上带白边。

### 19.5 四种输出的落位与约束

| 输出 | 入口 | 约束 | 失败提示 |
| --- | --- | --- | --- |
| 透明 PNG | 选区条「抠出选区 ▾」→ 导出透明 PNG；顶栏「导出 ▾」→ 选区分组 | 无选区禁用；PNG only | 无选区/选区为空 |
| 复制到剪贴板 | 同上 | 浏览器需 `ClipboardItem` + `image/png`；不支持时回退「已下载」 | 剪贴板权限被拒 |
| 抠图层 | 同上 → 新建抠图层 | 图层尺寸 = `doc.size`，x/y = 0；默认命名「抠图 N」 | 文档只读/锁定 |
| 白底 JPG | 「抠出选区 ▾」→ 白底 JPG | 先反选 → 填充 `#ffffff` → JPG 0.92 | 无选区 |

补充约定：

- 抠图层走现有 `OverlayLayer`（贴纸层）通道：可移动/缩放/旋转/混合/加蒙版/持久化，天然复用 D11.3。
- 抠图层建立后可给一个**开关**：「隐藏原底图」或「填充背景（纯色/原图模糊）」，否则图层与底图重合看不出去别。默认不自动隐藏，只在提示条里给一键操作，避免用户误以为图片丢了。
- 「收藏到素材仓库」沿用 `favoriteImage`，但要传透明 PNG（当前收藏路径是整图，需显式指定 blob）。

### 19.6 抠图 UI 与文案

- **主入口**：底部选区条（与「转为蒙版 / AI 消除」同排），主按钮 `抠出选区 ▾`，菜单四项对应 19.5。
- **一致性入口**：顶栏「导出 ▾」加分隔线后的「选区 · 透明 PNG / 复制」；无选区时置灰。
- **不新增左栏工具**（避免工具轨再次拥挤）。
- 一键文案：`已抠出选区 · 1200 × 800 · PNG`；抠图层：`已建立抠图层（可拖动/缩放）`。
- 导出期间按钮进入 busy 态（`抠图中…`），重复点击不重入。

### 19.7 错误与边界

| 场景 | 处理 |
| --- | --- |
| 无选区 / 选区为空 | 禁用按钮 + 提示「先用 AI 主体选择或魔棒圈出要保留的主体」 |
| 选区尺寸与图像不符 | 提示重新选择并清空选区 |
| AI 预览态 | 拦截，提示先载入或关闭预览 |
| 超大图（4K+） | 允许，但禁用 JPG 路径；编码显示 busy，结束后释放中间画布 |
| 内存不足 / toBlob 失败 | 捕获并提示「导出失败，请缩小图片或释放其它标签」 |
| 多标签锁定（`leaseLocked`） | 抠图层路径禁用（会改文档）；纯导出仍允许 |
| 浏览器不支持剪贴板图片 | 回退为下载，并提示已下载 |

### 19.8 抠图验收标准

1. 选区内像素与 `renderBase` 同位置逐字节一致（±0 允许误差，PNG 无损）；
2. 选区外 alpha 恒为 0；
3. 羽化开启时边缘存在 α∈(0,255) 的像素，且不出现整圈白边；
4. 导出尺寸 = `doc.size`，有裁剪时内容相对位置正确（裁剪左上角对齐）；
5. 抠图层可拖动/缩放/删除/撤销，刷新后仍在；
6. 白底 JPG 的背景为纯白 `#ffffff`，主体边缘无灰边；
7. 4K 单次导出 < 2s 且不冻结页面（异步编码）。

### 19.9 抠图交付拆分

| 阶段 | 范围 | 预估改动 |
| --- | --- | --- |
| P0 | 透明 PNG + 复制（选区条 + 导出菜单） | 新增 1 个纯函数模块 + 1 个导出动作 |
| P1 | 抠图层 + 隐藏底图开关 | `addOverlayFile` 通道，新增层命名与提示 |
| P2 | 边缘优化预设（收缩/羽化/去色边） | 复用 `contractAlpha/featherAlpha`，新增去色边纯函数 |
| P3 | 白底 JPG | 反选 + 填充 |
| P4 | 批量/预设（多选区、固定尺寸、命名规则） | 需要多选区模型 |

---

### 19.10 主图版本抽屉：痛点与目标

现状问题：

- **没有「回到原始主图」的入口**：`sourceBlob` 在 `adoptResult` 时被结果图覆盖，原始图只在第一次打开时存在，后续只能重新导入；
- **编辑历史埋在右侧 AI 分页最底部**（`sessionHistory` + `aiHistory`），窗口矮时要滚动很久才能看到；
- **历史快照**又在面板更下面，和 AI 历史各占一块，用户分不清；
- 结果是「版本」这件事没有可视化，每次都要靠记忆。

目标：在**工作室底部**给一条常驻的横向卡片抽屉（苹果风），从左到右呈现「原始主图 → 编辑 1 → 编辑 2 …」，点任意卡片即切换为当前主图；首张原始主图永远可一键回到。

### 19.11 三层历史边界（避免重复展示）

| 层级 | 承载什么 | 现有实现 | 新方案 |
| --- | --- | --- | --- |
| 图像版本链 | 画布底图的每次更替（原始 / AI 结果 / 扩图 / 放大） | 无（只有当前底图） | **底部抽屉（本章新增）** |
| AI 任务记录 | 每次 AI 修改的指令、参考图、参数、结果地址 | 右侧 AI 分页底部「编辑历史」 | 保留原位，不再重复搬进抽屉 |
| 文档快照 | 同一底图内的图层/调色/蒙版状态 | 面板底部「历史快照」 | 保留原位 |

抽屉只做「图像版本」，卡片上可带该版本对应的 AI 指令摘要作为副标题，但点击**不会**回填指令（那是右侧编辑历史的职责），避免两套语义混淆。

### 19.12 布局：底部通栏 Dock（macOS 桌面菜单栏同款）

**一条明确的结构**：右栏 inspector 跟着主体一起上移，底部整条让给 Dock；Dock 横跨左中右三栏，不是挂在右栏下面。

```
.studio（纵向 flex）
├─ .studio-bar        52px   顶栏
├─ .studio-body       1fr    rail | stage | inspector（inspector 高度随之变矮）
├─ .studio-dock       96px   通栏 Dock：原始主图 │ 编辑 1 / 编辑 2 / …
└─ .studio-status     30px   状态栏
```

- `.studio-body` 已是 `grid-template-rows: minmax(0,1fr)`，Dock 作为它的下一个兄弟用 `flex: 0 0 auto`，天然不挤压画布比例；
- `.page-studio` 仍为 `calc(100vh - var(--topbar-h) - 92px)`，`min-height` 由 480 提到 560，保证 Dock 出现后画布仍可用；
- 窄屏 ≤980（堆叠布局）：Dock 仍通栏，横向滚动；
- 自动隐藏（可选，默认关闭）：视口高度 < 700 时收成 12px 玻璃条，鼠标移到窗口底部或点击展开，手感对齐 macOS Dock；
- 不允许把 Dock 塞进右栏：右栏宽度固定 336px，横向卡片会立刻退化成二级滚动，和「找不到历史」的初衷相反。

### 19.13 卡片规格（Dock 图标规格）

| 项 | 规格 |
| --- | --- |
| 卡片 | 64 × 64 缩略图，圆角 16，`object-fit: cover` |
| 名称 | 默认隐藏，悬停时在卡片下方浮出（macOS Dock 的 app 名），主行版本名、次行时间 |
| 原始卡 | 永远第 1 张；卡片右侧一条 1px 竖向分隔线（Dock 的 separator），左上角「原始」小角标；不可删除 |
| 当前卡 | 卡片正下方 4px 圆点（macOS running indicator），与选中环并存 |
| 来源徽标 | 右上角 12px 小圆标：AI / 扩图 / 放大 / 导入 |
| 悬停 | 名称浮层 + tooltip（尺寸、时间、指令摘要 ≤40 字） |
| 容器 | `--glass-strong` 玻璃底 + 1px hairline + 顶部内高光，圆角 16；左右内边距 16；卡片间距 10 |
| 滚动 | 卡片区是**轮播带**：`overflow-x: auto` + `scroll-snap-type: x mandatory`，鼠标在 Dock 上滚轮即横向逐卡轮播（见 19.15），不触发主图切换 |
| 右端 | 分隔线后放「项目历史」入口（书脊式），点开右侧同高面板，列出本机**精修工程**并与全局「历史记录」页同源（见 19.13.1） |

#### 19.13.1 Dock 右侧：项目历史入口（工程级，对齐文生图「生成历史」书脊）

> 口径纠正：这里要的是**工程级（项目级）历史**，不是 AI 编辑记录（`aiHistory` 是任务级，仍在检查器里）。

- 参照物：文生图 / 图生图的右侧书脊 `createHistoryRail(host, { label: '文生图历史' })` —— 收起是一条通高胶囊（计数 + 竖排标题），点开在右侧滑出同高面板，条目是「批次」卡片。精修页复用同一套交互与视觉，但数据换成**工程列表**。
- 数据源：现有 `persistence.js` 的 `listProjects()`（IndexedDB `projects` store，按 `updatedAt` 倒序），字段直接用 `id / name / width / height / thumbnail / createdAt / updatedAt / activeTool`；**不新增存储**。
- 面板内容：标题「项目历史」+ 数量（`N 个项目`）+ 关闭；每条 = 工程缩略图、工程名、尺寸、最后编辑时间、`当前` 徽标；操作 `打开`（等价重新载入该工程）、`删除`（`clearProject(id)`，二次确认）、`全部工程 →`（跳转全局历史记录页）。
- 与全局历史记录同步：全局「历史记录」页新增「精修工程」分组（同一份 `listProjects()`，同样按更新时间倒序），删除/清理在两边保持一致；「设置 · 清理工程」执行后侧栏与历史页同时刷新。
- 与底部 Dock 的分工：Dock = **当前工程内的图像版本链**（原始主图 → 编辑 N）；右端面板 = **本机所有精修工程**（跨项目）。
- 空态：`还没有精修工程` + 「打开一张图片」按钮。
- 多标签：正在被其它标签编辑的工程显示「编辑中」并禁止直接打开（复用 `leaseHeldByOther`）。

### 19.14 动效：Dock 悬停放大 + 切换弹跳（苹果风，参数锁死）

- **悬停放大（Dock 的核心手感）**：鼠标所在卡片 `scale(1.18)`，左右各 2 张按 `0.94 / 0.86` 衰减，`transform 120ms ease-out`；移出后 160ms 复原。实现上用每张卡的 CSS 变量 `--dock-scale`（`transform: scale(var(--dock-scale))`），`mousemove` 走 rAF 合并，不逐帧读布局。
- **切换弹跳**：点卡片后该卡 `translateY(-8px)` 再回落，220ms `cubic-bezier(0.22, 1.2, 0.36, 1)`，只弹一次（对齐 macOS 启动 app 的 bounce）。
- **选中环**：`box-shadow: 0 0 0 2px var(--accent), 0 10px 24px rgba(0,0,0,.22)`，与弹跳同时出现；旧卡 180ms 回落，避免两张卡同时动。
- **画布切换**：新底图 150ms 淡入（只动 `opacity`，不做位移，避免晕）。
- **当前圆点**：切换完成后 80ms 淡入到新卡下方。
- **`prefers-reduced-motion: reduce`**：去掉放大与弹跳，只保留 2px 描边和圆点，切换不做淡入。
- 性能：只动 `transform / opacity / box-shadow`；Dock 高度固定，动画期间不触发布局。

### 19.15 交互细则

- 单击卡片 = 立即切换为主图（用户要求「选中即设为主图」）；自动保存已在运行，不额外弹确认。
- 双击卡片 = 与当前版本对比（复用 `compare.js`，可选）。
- 右键 / 长按：`另存为`、`与当前对比`、`从此处重新开始（丢弃之后 N 张）`、`删除此版本`（原始卡不可删）。
- 键盘：`←/→` 移动焦点，`Enter` 应用，`Home/End` 跳到首/尾；焦点环可见。
- **滚轮 = 轮播**：鼠标在 Dock 上滚动时，纵向滚轮映射为卡片区横向轮播（每次约 1 张卡，`scroll-behavior: smooth` + 吸附），**不切换主图**；只有点击卡片才切换。滚到两端时出现渐隐遮罩提示还有更多；`Shift + 滚轮` 逆向。
- **画布利用率**：Dock 占用高度后，画布 `fit` 仍按「可视区 − 工具栏」计算；左右留白由 `fitView` 的 padding 从 24px 降到 12px，默认让图像占满宽度方向（不裁剪，只改 padding）。
- Dock 右侧「项目历史」：单击展开/收起右侧面板；`Esc` 收起；数据取 `listProjects()`，与全局历史记录页的「精修工程」分组同源（19.13.1）。

### 19.16 数据模型与持久化

```text
studioVersions（IndexedDB，按 projectId 归档）
  id            string   版本 id
  projectId     string   所属工程
  kind          'original' | 'edit' | 'upscale' | 'import'
  label         string   「原始主图」「编辑 1」「扩图 2」
  width/height  number   像素尺寸
  at            number   时间戳
  fromId        string   由哪个版本编辑而来（原始为空）
  thumbUrl      string   160px WebP dataURL
  blobKey       string   指向 studioVersionBlobs
  meta          object   { task, prompt, preset, model } 摘要

studioVersionBlobs（IndexedDB）
  blobKey → Blob(原始 PNG/JPG)
```

- **原始主图必须在导入时就落盘**：当前 `openFile/openUrl` 只把 `sourceBlob` 放在内存，`adoptResult` 会覆盖它；新方案在 `setDoc` 时把原始 blob 写入 `studioVersions`，保证随时能回到原始。
- 缩略图 160px WebP（质量 0.8），原图 blob 按 `blobKey` 去重。
- 上限 30 张（含原始）；超出淘汰最旧的非原始版本（先删 blob 再删元信息）；原始卡永不淘汰。
- 工程恢复：打开工程时重建抽屉，当前指针 = 最后应用的版本；抽屉数据缺失时降级为只有原始卡 + 当前图。
- **项目历史面板**：直接用 `persistence.listProjects()`（`projects` store）与 `clearProject/cleanupProjects`，不新增存储；全局「历史记录」页新增「精修工程」分组复用同一函数，两边删除/清理保持一致。
- 清理：`清理工程`（设置页已有）一并删除 `studioVersions/studioVersionBlobs`。

### 19.17 切换语义（锁死）

1. 点卡片 → 取该版本 blob → `loadImage` → 以它为底新建 `StudioDoc`（等同 `adoptResult`）；
2. 清空：蒙版、选区、撤销栈、快照、图层（版本层面不保留旧图层）；AI 面板保留参考图与指令，但结果预览状态重置；
3. 新编辑产生的新版本**追加到末尾**，记录 `fromId`，不自动截断历史；
4. `从此处重新开始` 是唯一会截断历史的操作，必须二次确认并说明「将删除之后 N 个版本」；
5. 切换不做跨版本撤销（`Ctrl+Z` 只作用于当前文档），抽屉是「会话级导航」，不是撤销栈；
6. 若正处于 AI 预览态，先关闭预览再切换。

### 19.18 与现有代码的接入点（不改旧语义）

| 位置 | 接入方式 |
| --- | --- |
| `openFile / openUrl` | 建立 `kind:'original'` 版本并落盘 blob |
| `adoptResult`（AI 结果载入） | 追加 `kind:'edit'`，带 task/prompt 摘要 |
| 放大结果载入 | 追加 `kind:'upscale'`，带倍率 |
| 统一导入（有主图时转参考图） | 不产生版本；仅当作为新主图时产生 `kind:'import'` |
| `setDoc` | 同步抽屉当前指针；重建缩略图 |
| `destroy()` | 取消缩略图解码、断开滚动监听、释放 objectURL（沿用 D19.5 的清理约定） |
| `persistence.js` | 新增两个 store 与版本迁移（DB version +1） |
| `app.css` / `studio.css` | 新增 `.studio-versions` 样式，不改现有类名 |

### 19.19 性能与可访问性

- 缩略图懒加载 + 解码异步；卡片 DOM 复用（切换只改 class，不重建列表）；
- 切换时只读一个 blob，避免批量解码；
- 抽屉滚动用 `overflow-x:auto` + `scroll-snap-type: x proximity`，不监听 `scroll` 做重排；
- 语义：`role="listbox"` + `role="option"` + `aria-selected`；焦点管理；`aria-live` 播报「已切换到 编辑 2」；
- 对比度：标签文字 ≥ AA；暗色/亮色两套 token 都验证。

### 19.20 验收清单（抽屉）

1. 打开任意工程，底部抽屉立即可见，第一张是「原始主图」；
2. 做一次 AI 编辑并「载入为新底图」后，末尾新增「编辑 1」卡片，当前态指向它；
3. 点「原始主图」→ 画布与文件名/尺寸回到原始，蒙版与选区清空；
4. 再点「编辑 1」→ 回到编辑结果，抽屉当前指针同步；
5. 选中动效：`transform/opacity` 过渡 260ms，帧耗时 <16ms，无布局抖动；
6. 刷新页面 / 重新打开工程，抽屉与当前指针完整恢复；
7. 连续 31 个版本后，最旧的非原始版本被淘汰，原始卡仍在；
8. 窄窗口（≤980）抽屉横向滚动可用且不压缩画布；
9. `prefers-reduced-motion` 下只保留描边，无缩放动画；
10. 键盘 `←/→/Enter` 可完成切换，`aria-selected` 正确。

### 19.21 交付顺序

| 阶段 | 范围 |
| --- | --- |
| V1 | 抽屉骨架 + 原始卡 + 当前版本指针（只读展示，不做切换） |
| V2 | 版本落盘（IndexedDB）+ 点击切换 + 原始/编辑版本生成 |
| V3 | Dock 悬停放大 + 切换弹跳 + 横向滚动与键盘 |
| V4 | 卡片菜单（对比/另存/删除/从此处重开）+ 全部网格 + 清理策略 |

---

### 19.22 项目生命周期：新建 / 切换 / 保存 / 删除（补 D22.2）

**现状与缺口（已核实代码）**

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 新建项目 | 无入口；`importLocalFiles` 在有 `doc` 时一律把新图加入参考图 | 打开主图后无法开始新任务，只能退出页面重进 |
| 切换项目 | `loadProject(id)` + `applyRestore()` 已具备 | 没有项目列表入口，只能靠刷新时的「上次编辑未完成」恢复条 |
| 保存项目 | 自动保存（`saveStudioProject`，防抖）+ 「自动保存 · 本机」徽标 | 没有手动保存、没有工程重命名 |
| 删除项目 | `clearProject(id)` / `cleanupProjects()` 已有，仅设置页「清空全部」在用 | 不能删单个工程；当前工程无法回到空状态 |

**1. 新建项目**

- 入口（三处，同一套动作）：顶栏文件区 `＋ 新建`、项目历史面板头部 `＋ 新建`、空状态按钮。
- 形式：`从本地图片新建`（选图即主图）、`从素材仓库新建`、`空白画布`（选尺寸）。
- 流程：`flushSave()` 保存当前工程 → 释放当前租约 → `beginProject()` + `newProjectId()` → 清空 doc / 蒙版 / 修复层 / 图层 / 撤销栈 / 快照 / AI 面板上下文 → 进空状态或直接载入新主图。
- 快捷键 `Ctrl/Cmd + N`（仅工作室激活时拦截）。

**2. 切换项目**

- 入口：底部 Dock 右端「项目历史」面板，点工程卡片。
- 流程：`flushSave()` → 释放租约 → `loadProject(id)` → `applyRestore()`；失败时保留当前工程并提示。
- 其它标签正在编辑的工程：显示「编辑中」，按钮禁用（复用 `leaseHeldByOther`）。
- 当前有 AI 任务在跑：提示「任务会在后台继续，结果仍可在结果区找回」，用户确认后再切。

**3. 保存项目**

- 自动保存保留；新增 `Ctrl/Cmd + S` 立即保存 + 顶栏 `⋯` 菜单「立即保存」。
- 保存状态沿用 `saveState`：`保存中… / 已保存 / 保存失败（本机存储不足）`。
- 工程命名：默认取主图文件名；`⋯ → 重命名` 或项目历史里双击改名，写回 `projects.name`。

**4. 删除项目**

- 入口：项目历史每条 hover 出现 `⋯ → 删除`；当前工程在顶栏 `⋯ → 删除当前项目`。
- 二次确认文案：`删除「xxx」？本机工程、图层、参考图与版本记录会一起删除，不可恢复。`
- 流程：释放租约 → `clearProject(id)`（顺带删 `studioVersions/studioVersionBlobs`）→ 若是当前工程则回到空状态。
- 批量清理仍走「设置 · 关于 · 清理旧工程」，两处行为一致。

**Bug 修复项（当前主图无法删除 / 无法开新任务）**

- 根因：有 `doc` 时导入分流固定走参考图；顶栏没有新建/关闭入口；空状态不可达。
- 修复：
  1. 顶栏文件区加 `＋` 与 `⋯` 菜单：`新建项目 / 作为新主图（新建） / 立即保存 / 重命名 / 关闭项目 / 删除项目`；
  2. 导入菜单在有主图时多一项「作为新主图（新建项目）」，与「作为参考图」并列；
  3. `关闭项目` = 保存 → 释放租约 → 回到空状态（`setDoc(null)` 的空状态渲染路径已存在）；
  4. `删除项目` 删完同样回空状态，刷新不再自动恢复。
- 验收：开一张图 → `＋ 新建` 能直接开始新任务；`⋯ → 关闭项目` 回到空状态；项目历史删除当前工程后回空状态且刷新不再恢复。

**边界与数据**

- 新建/切换/删除前一律 `flushSave()`，避免丢最后 1.2s 的编辑。
- 删除要按顺序清理：`studioVersions` → `studioVersionBlobs` → `projects` → `layers/refs/session/aiHistory/aiResults`。
- 空状态保留「上次编辑未完成 · 恢复」条，但已删除的工程不再出现。
- 多标签：切换/删除前检查租约；当前标签自己持有租约时正常执行。
- 重命名只改 `projects.name`，不动文档内容与版本链。

补充约定（本章）：D21.1 / D22.1 / D22.2 都不改已有工具语义；抠图产物不写回文档，除非用户显式「新建抠图层」；Dock 与项目历史面板是导航层，不进入撤销栈。实施顺序建议 **D22.2 项目生命周期（新建/关闭/删除 + 换主图）→ D22.1 V1/V2（Dock + 版本链）→ D21.1 P0（透明 PNG）**，先解决「开了一张图就出不来」的阻塞问题。





