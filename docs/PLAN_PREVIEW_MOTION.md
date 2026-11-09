# 预览动效与历史页交互优化方案

> 状态：**已全部落地**（2026-11-09）。执行时按「做一项 → 真机验证 → 单独提交 → 回写 WEB_UI」推进，提交记录见文末。
> 范围：前端 only（`web/src/components/*` + `web/assets/css/*`），不涉及后端接口与数据模型。
> 相关文档：[WEB_UI.md](./WEB_UI.md)、[PLAN_HISTORY_LIBRARY_PREVIEW.md](./PLAN_HISTORY_LIBRARY_PREVIEW.md)

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 为什么画廊/素材预览大图"不自然" | 灯箱复用了通用弹窗的 `modal-in`（上移 8px + 缩到 0.99），与缩略图没有空间连续性；关闭时 `backdrop.remove()` 瞬删，没有退场 |
| 历史页有没有同类问题 | 有，且更多：筛选/刷新整块 `innerHTML` 重绘导致缩略图闪一下、详情图只能新窗口打开、图片无占位淡入、卡片缺 focus 态 |
| 是否要引入动画库 | 不需要。统一用 WAAPI（`element.animate`）+ CSS transition，复用现有 `--ease / --dur*` token |
| 改动面 | 灯箱 1 个文件 + 弹窗退场钩子 + 2 处调用点；历史页 1 个文件 + 样式。风险集中、可逐项提交 |
| 最大收益点 | ① 打开/关闭的共享元素 FLIP；② 历史筛选不整块重绘；③ 历史详情图接入同一个灯箱 |

---

## 1. 现状诊断

### 1.1 高清灯箱（作品画廊 / 素材仓库共用）

实现：`web/src/components/lightbox.js`，容器样式在 `web/assets/css/composer.css`（`.lightbox-modal` 2088-2290）。

| 编号 | 现象 | 根因 |
| --- | --- | --- |
| L1 | 打开时像"弹窗弹出"，不像图片被放大 | `openModal` 统一用 `modal-in 0.16s`（`app.css:1431`）；灯箱内容 `.lb` 本身没有入场动画；没有从缩略图位置过渡 |
| L2 | 关闭非常生硬 | `modal.js:59-65` 的 `close()` 直接 `backdrop.remove()`，没有退场阶段 |
| L3 | 连续切图会闪、会跳 | `lightbox.js:121-134` 直接改 `img.src` 再 `resetView()`；`img.load` 回调（`:232-235`）又 `resetView()` 一次 |
| L4 | 按钮缩放 / 双击缩放手感硬 | `applyTransform()`（`:66-70`）直接写 `transform`，无过渡；滚轮与拖拽也共用同一条路径 |
| L5 | 大图未解码时先白后现 | 没有缩略图占位与解码等待，`<img>` 直接指向原图 |
| L6 | 缩略图条、左右箭头、工具栏无动效 | `.lb-thumb.active`（composer.css:2285）只是换背景，没有位移指示 |

### 1.2 历史页

实现：`web/src/components/history.js`，样式在 `web/assets/css/app.css`（2172-2394）。

| 编号 | 现象 | 根因 | 等级 |
| --- | --- | --- | --- |
| H1 | 切换分类 / 点刷新时缩略图会"闪一下"，页面高度跳动 | `render()`（`history.js:307-329`）每次都重建整个 `refs.grid.innerHTML`，200 张图重新解码；高度变化导致滚动位置跳动 | 高 |
| H2 | 历史详情里的图只能"新窗口打开"，不能高清预览 | `history.js:381-383` 用 `<a target="_blank">`，没有接入 `openLightbox`（画廊/素材已有） | 高 |
| H3 | 详情弹窗图片加载时高度从 0 撑开，弹窗抖动 | `.result-img-wrap` 只给 `min-height:120px`，没有按原图宽高比占位；`loading="lazy"` 在弹窗内还会延后加载 | 高 |
| H4 | 缩略图与结果图没有加载渐变，白→图的硬切 | `history-thumb img` / `result-img-wrap img` 没有占位层与 `load` 态 class | 中 |
| H5 | 键盘聚焦卡片没有可见焦点样式 | `.history-card` 有 `role=button tabindex=0`，但 CSS 只有 `:hover`（`app.css:2298-2312`），没有 `:focus-visible`；`outline:none` 在别处被重置过 | 中 |
| H6 | 精修工程卡片完全没有 hover 反馈，与任务卡片不一致 | `.history-project-card`（`app.css:2225-2233`）无 `transition` / `:hover` | 低 |
| H7 | 刷新/清空没有过程反馈 | 刷新按钮无 busy 态；`aria-busy` 缺失；清空后列表瞬间消失（无退场） | 中 |
| H8 | 过滤后无法用键盘在网格里移动 | 只有 Enter/Space 打开详情（`history.js:339-348`），没有 ←/→ 或 ↑/↓ 导航 | 低 |

> 备注：`historyRail.js`（精修页侧栏）与 `jobView.js`（生成结果）也调用同一个 `openLightbox`，本方案只改灯箱本体，它们会自动受益，不单独排期。

---

## 2. 动效规范（统一口径）

沿用 `web/assets/css/theme.css` 现有变量：`--ease: cubic-bezier(.22,.61,.36,1)`、`--dur-fast: 120ms`、`--dur: 180ms`、`--dur-slow: 280ms`。

| 场景 | 时长 | 缓动 | 说明 |
| --- | --- | --- | --- |
| 灯箱打开（位置 + 尺寸） | 260ms | `cubic-bezier(.2,.8,.2,1)` | 略带回弹感，收尾柔和 |
| 灯箱关闭（回缩） | 200ms | `ease-in` | 比打开快，避免拖沓 |
| 背景遮罩淡入 / 淡出 | 180 / 160ms | `--ease` | 永远比图片先到 / 后走 |
| 切图交叉淡入 | 180ms | `--ease` | 位移 ≤ 24px |
| 按钮缩放 / 双击缩放 | 180ms | `--ease` | 滚轮与拖拽保持 0 过渡（跟手） |
| 历史卡片新增 / 过滤重绘 | 140ms 淡出 + 160ms 淡入 | `--ease` | 不逐卡 stagger，避免 200 张卡同时动画 |
| 缩略图解码完成 | 200ms 透明度 | `--ease` | 配合 LQIP 占位 |

硬约束：

- 只动 `transform` / `opacity`（遮罩 blur 可动，但低端机按 `matchMedia('(prefers-reduced-motion)')` 关闭）；
- 一律尊重 `prefers-reduced-motion: reduce` → 全部瞬时；
- 动画期间不做布局读写交替，避免强制同步布局。

---

## 3. 任务清单

### A. 灯箱动效（作品画廊 / 素材仓库）

**A1 打开：共享元素 FLIP**
- `openLightbox(images, index, { origin })` 新增可选 `origin`（`DOMRect`）。
- 目标渲染完成后，用 `img.animate([{ transform: 从 origin 推得的 translate+scale }, { transform: 'none' }], { duration: 260, easing })`；容器只做 1→1 淡入，不再整体弹跳。
- 无 `origin`（历史侧栏、生成结果）时退化为「淡入 + scale 1.02→1」。

**A2 关闭：反向 FLIP + 异步退场**
- 给 `openModal` 增加可选 `exit` 钩子（或让 `close()` 支持 Promise）：先播 200ms 回缩，再 `remove()`。
- Esc / 点遮罩 / 点 × 三条路径必须一致；源元素已不可见时退化为淡出。

**A3 切图：方向性交叉淡入**
- ←/→ 与缩略图切换：新图从 ±24px 侧移 + 透明 0 进入，旧图反向 12px 淡出。
- 切换前 `new Image().decode()` 预解码，未完成时保留旧图 + 细进度条；完成后替换，避免白闪。
- `img.load` 里的重复 `resetView()` 去掉，改为一次性状态复位（带 180ms 过渡）。

**A4 缩放与拖拽手感**
- 按钮 / 双击 / `0` `1` 快捷键：`transform` 加 180ms 过渡；滚轮与拖拽保持瞬时。
- 滚轮以指针为缩放锚点，避免越缩放越偏。
- 松手按最近 60ms 位移估算速度做短惯性（约 120ms 衰减），到边界回弹。

**A5 加载占位与失败态**
- 用缩略图做 LQIP：`blur(14px) scale(1.04)` 垫底，原图解码后 200ms 交叉淡出。
- 加载中 / 失败都有占位文案，不留黑屏。

### B. 历史页动效与交互

**B1 缩略图与结果图：占位 + 淡入**
- `.history-thumb` 已有 1:1 棋盘格，补一层 `img.is-loaded` 淡入；加载失败保留现有"无预览"兜底。
- 详情 `.result-img-wrap` 用 `aspect-ratio: w / h`（来自 `image.width/height`）占位，加载完成再淡入，消除弹窗高度抖动（H3、H4）。

**B2 筛选 / 刷新：不整块重绘闪屏**
- 轻量方案：`render()` 前给网格加一次 140ms 淡出，渲染后 160ms 淡入；同时记录并恢复滚动位置（`scrollY` 或最近可见卡片）。
- 若后续要做 keyed diff，再单独拆任务；本次不做，避免引入虚拟列表复杂度。

**B3 详情图接入高清预览**
- 详情弹窗的 `.result-img-wrap` 改为按钮语义：点击 `openLightbox(item.images, index, { origin: img.getBoundingClientRect() })`，关闭后回到详情弹窗（沿用现有 `onClose` 模式）。
- 保留"原图"（新窗口）入口，放在灯箱工具栏，行为不变。

**B4 卡片交互态统一**
- `.history-card` / `.history-project-card` 补 `:focus-visible` 描边（与 `library.css` 中 `.lib-card:focus-visible` 同口径）。
- 项目卡补 hover：`border-color` + 轻微 `translateY(-1px)`，时长 140ms。
- 卡片 hover 的 `transform` 加 `will-change: transform`？**不加**（数量大，常驻 layer 反而更卡），只在过渡期间由浏览器自行合成。

**B5 加载与清空反馈**
- 刷新按钮：请求期间 `disabled` + 旋转图标文案（复用 `.spinner`），容器加 `aria-busy="true"`。
- 清空历史：列表先 160ms 淡出再切换到空状态（`DELETE` 成功之后播放）。
- 失败重试按钮保持现状，补 `focus-visible`。

**B6（可选，P2）网格键盘导航**
- ↑/↓/←/→ 在卡片间移动焦点，Home/End 到首尾；只改 `history.js` 的 keydown 分支。
- 与 B1-B5 分开提交，避免影响主线。

---

## 4. 验收标准

| 项 | 验收 |
| --- | --- |
| A1/A2 | 打开时图片视觉上从来源缩略图"长出来"；关闭回到原位置，误差 ≤ 2px；Esc / 遮罩 / × 三种关闭表现一致 |
| A3 | 连按 → 切换 10 张无白闪、无跳动；缩放状态按预期复位 |
| A4 | 按钮缩放有过渡、滚轮跟手；松手有短惯性且不越界 |
| A5 | 首帧有模糊占位，不出现纯黑/纯白；失败有文案 |
| B1 | 详情弹窗打开时高度不跳（CLS 目测为 0） |
| B2 | 切换分类实测 200 条记录：无缩略图闪白，滚动位置保持 |
| B3 | 历史详情点图进灯箱，Esc 关闭回到详情；灯箱内可切换该记录的多张图 |
| B4 | Tab 聚焦卡片有可见描边；项目卡 hover 有反馈 |
| B5 | 刷新时按钮不可重复点击且有 busy 提示；清空有退场而非瞬删 |
| 全局 | 开启"减少动态效果"后全部瞬时；打开/关闭期间 DevTools 无 forced reflow，中端机 ≥ 50fps |

验证方式：`node --check` 语法检查；Playwright 真机截图 + `document.getAnimations()` 数量断言 + 目测录屏；纯前端改动无需重启后端（静态文件 no-cache，刷新即可）。

---

## 5. 执行顺序与提交约定

按「落实一项 → 真机/测试验证一项 → 单独提交一项 → 回写 `WEB_UI.md` 一项」推进：

1. A2（弹窗退出钩子）→ 2. A1（打开 FLIP）→ 3. A3（切图）→ 4. A5（占位）→ 5. A4（缩放手感）
2. 6. B1（占位淡入）→ 7. B2（筛选不闪）→ 8. B3（历史接灯箱）→ 9. B4（交互态）→ 10. B5（加载/清空反馈）
3. B6 视情况最后做。

每项提交信息格式：`feat(web): <一句话动效/交互改进>`，并在正文写清验收结果。

---

## 6. 风险与不做的事

- **不做**：不引入动画库（Framer Motion / GSAP）；不做虚拟滚动；不改历史接口与数据；不动 `video_studio/` 等他人工作区改动。
- **风险 1**：FLIP 需要在动画前读取 `getBoundingClientRect()`，若同一帧内既有读又有写，可能触发一次强制布局。控制在"读一次 → 动画"两步内。
- **风险 2**：`backdrop-filter: blur(6px)` 在动画期间开销较高；动画期间临时降到 `blur(0)` 或关闭，结束再恢复（低端机策略）。
- **风险 3**：历史页 200 张图同时淡入可能掉帧。B2 只对容器做一次淡入淡出，不逐卡动画。
- **风险 4**：`modal.js` 是公共组件，异步退场必须默认关闭（只有灯箱开启），避免影响历史详情、确认框、风格选择器等既有弹窗。

---

## 7. 影响文件清单

| 文件 | 改动 |
| --- | --- |
| `web/src/components/lightbox.js` | FLIP 进出场、切图交叉淡入、缩放过渡、惯性、LQIP、`origin` 参数 |
| `web/src/components/modal.js` | 可选 `exit` 异步退场（默认关闭，只灯箱启用） |
| `web/src/components/history.js` | 详情图接灯箱、网格淡入淡出、滚动保持、busy/清空反馈、键盘导航 |
| `web/src/components/gallery.js` | 高清预览传 `origin`（详情图 rect） |
| `web/src/components/materials.js` | 高清预览传 `origin`（详情图 rect） |
| `web/assets/css/composer.css` | 灯箱动效类、LQIP 占位、缩略图指示 |
| `web/assets/css/app.css` | 历史卡片 focus/hover、结果图占位、busy 态、清空退场 |
| `docs/WEB_UI.md` | 每完成一项回写对应段落 |

---

## 8. 落地记录（2026-11-09）

| 项 | 内容 | 提交 |
| --- | --- | --- |
| 前置 | `openModal` 新增可选 `exit` 异步退场钩子（默认行为不变） | `1dc2cae` |
| A1 | 灯箱打开改为共享元素 FLIP，画廊/素材详情传入来源 rect | `78dd257` |
| A2 | 关闭时克隆层反向飞回缩略图 + 遮罩淡出，三条关闭路径一致 | `7d11eaa` |
| A3 | 切图预解码 + 方向性淡入，连续快速切换只保留最后一次 | `c09facf` |
| A5 | 缩略图模糊占位（`lb-lqip`），加载完成淡出 | `2fa4d7e` |
| A4 | 缩放过渡 / 光标锚点 / 拖拽惯性与边界夹紧 | `bfd51ed` |
| B1 | 历史缩略图与详情图占位淡入，详情图按宽高比占位 | `af3345c` |
| B2 | 分类切换/刷新淡出淡入并保持滚动；修复失败态被空状态覆盖 | `8bc8872` |
| B3 | 历史详情图接入统一灯箱（FLIP 起点 + 关闭回详情） | `0666953` |
| B4 | 任务卡/工程卡 hover 与 `:focus-visible` 统一 | `6248eb4` |
| B5 | 刷新 busy 态（禁用+旋转+`aria-busy`）、清空淡出 | `b6ba6fd` |
| B6 | 网格方向键 / Home / End 导航 | `84a065a` |

验证摘要：

- 灯箱：打开动画命中 260ms 且起点来自详情图 rect；关闭时克隆层在 120ms 时仍存在、320ms 后移除并回到详情；`Esc` / 点遮罩 / 点 × 行为一致；切图时旧图 90ms 淡出、新图 150ms 滑入，连按 3 次不残留动画。
- 历史：切换分类时网格先 140ms 淡出再 160ms 淡入，滚动位置保持不变；详情图占位高度 124px 前后一致；键盘 End/Home/方向键索引正确；刷新期间按钮禁用且 `aria-busy=true`。
- 回归：画廊「高清预览 → 关闭」仍回到详情；历史「回到图像编辑」仍能还原输入图、步数、种子、Turbo 档位与一致性开关；所有页面无控制台报错；前端单测 139 项通过。
- 未执行：`清空全部历史` 的淡出仅做代码审查，未在真实数据上触发删除。
