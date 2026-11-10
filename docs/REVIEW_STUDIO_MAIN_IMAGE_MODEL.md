# 代码审查：`feat/studio-main-image-model`（主图模型重构）

> 审查对象：`feat/studio-main-image-model` @ `8e2f483`，对比基线 `main` @ `370d265`
> 范围：15 个文件 / +2155 −248（`studio.js` 为主），重点看「主图 = 仅底图」重构后的状态机、缓存与持久化
> 方式：静态审查 + 关键路径推演（未跑真机交互）；每条都给了可复现步骤与建议改法
> 分支：`review/studio-main-image-model`（仅新增本文档，未改代码）

---

## 0. 结论摘要

整体方向是对的：`replaceMainImage()` 取代 `new StudioDoc()`、`planBaseSwap()` 统一切主图路径、`bakeMain()` 把「主图」语义和「合成图」拆开，这三件事把用户反馈的「AI 修改后图层全丢」真正修掉了。缓存失效、异步竞态（`openSeq` / token + owner）、AI 出图跨工程校验这些坑也都补得比较干净。

但有 **1 个 P1 回归**和 **2 个 P2 数据一致性问题**值得在合并前处理：

| 级别 | 问题 | 位置 |
| --- | --- | --- |
| P1 | 90° 旋转后**撤销/重做被静默吞掉**，且历史指针已前移（后续撤销会跳步） | `studioDoc.js:209-221` + `:245` |
| P2 | `resetAll()` / `replaceBaseFromCanvas()` 换了蒙版画布**却不自增 `maskVersion`** → 保存复用旧蒙版 Blob，**刷新后蒙版「复活」** | `studioDoc.js:489-500`、`:836-853`、`studio.js:7574-7589` |
| P2 | 命名快照只按**尺寸**判断归属：换成同尺寸主图后，旧快照仍可恢复，会把上一张图的修复/蒙版像素套到新图上 | `studioDoc.js:245-250`、`history.js:73` |

P1 和 P2-2 其实是同一个根因：**用「尺寸」当「主图身份」的代理**。建议一次性换成显式的 `baseId`，两个问题一起消失。

---

## 1. P1：撤销/重做跨 90° 旋转失效，且会吃掉历史

### 现象

1. 打开一张图 → 旋转 90°；
2. `Ctrl+Z`：画面**没有任何变化**，但撤销按钮的步数少了一步；
3. 再按一次 `Ctrl+Z`：画面一次退回两步（跳过了旋转前的那一步）。

### 根因

```js
// studioDoc.js:209
undo() {
  const state = this._history.undo();     // 指针已经前移
  if (!state) return false;
  this.restore(state);                    // 可能直接 return false
  return true;                            // 仍然报告"撤销成功"
}
```

`restore()` 开头新增了守卫：

```js
// studioDoc.js:179 / 245
if (!this._canRestore(state)) return false;
...
_canRestore(state) {
  const target = state?.oriented;
  if (!target) return true;
  return target.width === this.oriented.width && target.height === this.oriented.height;
}
```

而 `rotateRight()` 会改变 `oriented`（W×H → H×W），并且没有清历史（这是对的）。于是旋转前那个 state 的 `oriented` 与当前不一致 → `restore()` 拒绝 → `undo()` 却照样返回 `true`，指针已经动了。**历史栈与画布从此不同步**。

### 建议改法

旋转是历史里的正常一步，天然应该可撤销；「不可恢复」只应发生在**换了另一张主图**之后。所以不要拿尺寸当身份，给状态记一个 `baseId`：

```js
// studioDoc.js 构造函数
this.baseId = 0;

// snapshot()
const state = { baseId: this.baseId, /* ...原有字段... */ };

// replaceMainImage() 里（换底图才算换身份）
this.baseId += 1;
this.clearHistory();
this.snapshot();

// _canRestore
_canRestore(state) {
  return !state?.baseId || state.baseId === this.baseId;
}
```

同时 `undo()/redo()` 必须尊重失败：

```js
undo() {
  const state = this._history.undo();
  if (!state) return false;
  if (!this.restore(state)) {
    this._history.redo();   // 回滚指针，别让历史与画面对不上
    return false;
  }
  return true;
}
```

UI 侧（`studio.js:10238`）失败时补一句 toast，避免"点了没反应"。

---

## 2. P2：重置 / 合并图层后保存复用旧蒙版 Blob，刷新后蒙版复活

### 现象

1. 画笔圈一块 → 等自动保存落盘；
2. 「重置全部」（或「与主图合并」，合并前同样有蒙版）；
3. 再等一次保存 → 刷新页面；
4. 之前那块**红色蒙版又回来了**（画布上并没有蒙版）。

### 根因

保存缓存用「像素版本号 + 尺寸」当 key：

```js
// studio.js:7578
const maskKey = `${current.maskVersion}:${current.mask.width}x${current.mask.height}`;
if (maskBlobCache.doc !== current || maskBlobCache.key !== maskKey) { /* 重新编码 */ }
```

但 `resetAll()` 换成了同尺寸的空白画布，**却没有自增版本号**：

```js
// studioDoc.js:489
resetAll() {
  ...
  this.mask = makeCanvas(this.oriented.width, this.oriented.height); // 新画布，同尺寸
  this.repair = null;
  this._maskHas = null;
  this.invalidateBase();
  this.snapshot();
}
```

`replaceBaseFromCanvas()`（`:836`，「与主图合并」的落点）也有同样的问题：它同样重建了蒙版画布、清空了修复层，但版本号没动。

key 没变 → 命中缓存 → 存进工程 session 的还是**上一次带像素的蒙版 Blob**。而 `bakeMain` 等其它路径都没问题，只有"存盘"这一环是脏的。

`repair` 侥幸没事，只是因为它的 key 里带了 `repair?.width || 0`（`null` → `0x0`）——这反过来说明这个 key 的设计不可靠。

> 对照：`clearMask()`、`rotateMaskRight/Left()`、`flipMask()`、`clearRepair()`、`rotateRepairRight/Left()`、`flipRepair()`、`ensureRepair()`、`replaceMainImage()` 全都记得自增。**偏偏这两个"整块换新"的路径漏了**，说明靠人工逐个记得并不可靠。

### 建议改法

1. 立刻补上：

```js
resetAll() {
  ...
  this.maskVersion += 1;
  this.repairVersion += 1;
  ...
}
```

`replaceBaseFromCanvas()` 同样补两行。

2. 更值得做的是**把"换蒙版画布"收敛成一个入口**，让版本号没法漏：

```js
_setMaskCanvas(canvas) {
  this.mask = canvas;
  this._maskHas = null;
  this.maskVersion += 1;
}
_setRepairCanvas(canvas) {
  this.repair = canvas;
  this.repairVersion += 1;
}
```

上面 8 个方法 + `resetAll` / `replaceBaseFromCanvas` / `replaceMainImage` 全部改走它，以后新增"换画布"的路径就不会再踩。

3. 长期建议把「像素身份」也纳入 key，别只靠版本号：`maskBlobCache` 里同时存 `maskCanvasRef`，`current.mask !== cache.maskCanvas` 时强制重编码。这样即使再漏一次也不会存错。

---

## 3. P2：命名快照只按尺寸判归属，换同尺寸主图后会"套"上旧像素

`clearHistory()` 只清 `past/future`，不清命名快照（`history.js:73`）；`_canRestore()` 又只比尺寸。于是：

1. AI 修改主图（结果尺寸不变）→ 「设为新主图」→ 图层保留、历史清空；
2. 但「项目历史」里之前存的命名快照还在，点它 → 尺寸一致 → **允许恢复**；
3. 恢复的是**上一张主图**的 `repair`（污点修复）与 `mask` 像素，叠在新图上就是"凭空出现的修复痕迹/蒙版"。

### 建议

同 §1 的 `baseId`：快照里记 `baseId`，恢复时 `baseId` 不一致就拒绝，并提示「该快照属于上一张主图」。若产品希望保留这类快照，可提供「仅恢复调色/图层」的降级恢复（明确不含修复层与蒙版）。

另外 `studio.js:9227` 现在的拒绝文案是「尺寸对不上，无法恢复」——在真正的坏场景（尺寸相同、身份不同）里这句话根本不会出现，反而会静默恢复错像素。换成 `baseId` 后文案也要同步改成「属于上一张主图」，才不会误导用户去反复重试。

---

## 4. P3：`exportMainCanvas()` 直接返回缓存引用

```js
// studioDoc.js:1377
exportMainCanvas(type = 'image/png') {
  const base = this.renderUnderlay();
  if (type !== 'image/jpeg') return base;   // ← 就是 _underlay 缓存本体
  ...
}
```

目前唯一调用方 `captureSnapshot()` 只做 `toBlob` / `drawImage`（只读），暂时安全；但这个返回值的语义很容易被下一个调用方误用（例如"给快照画个角标"直接在上面 `fillRect`，就会把 `_underlay` 缓存永久污染，画布/导出全带角标）。

建议返回副本（`cloneCanvas(base)`，4K 图约 30MB 一次，只在快门/换主图时发生，可接受），或在 JSDoc 上明确写"返回内部缓存，只读，禁止就地绘制"，并在函数名上体现（如 `peekMainCanvas`）。

---

## 5. 其他小问题（P3）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `studio.js:5465` | 有 AI 预览时用画笔点一下：先 `enterBaseEdit()` 退出预览，然后**同一笔继续落到画布** | 退出预览后直接 `return`，本次点击只用于退出 |
| 2 | `studio.js:3286` | `enterBaseEdit()` 里 `ai.exitPreview()` 内部已 `ctx.showResult(null)`，后面又 `setPreview(null)`，重复退出 | 只保留一处 |
| 3 | `studioDoc.js:730` | `addOverlay()` 为了拿尺寸调用 `renderBase()`（整张合成），4K 图上每次加图层都白跑一遍 | 用 `this.size` + `transform.crop` 偏移即可 |
| 4 | `history.js:79-89` | 命名快照不计入 `bytes` 预算，也不上限：4K 图每张约 30MB+，连续存十几张就吃满内存，且被 `trim()` 挤出的状态仍被快照引用 | 快照入栈时累加字节、删除时扣减，并给一个「最多 N 张 / 总字节上限」的软限制，超限提示用户删旧快照 |

---

## 6. 确认没问题的点（避免只挑刺）

- `replaceMainImage()` 之后 **`sourceBlob` 有同步更新**（`studio.js:6686`、`:2528`），刷新不会把旧源文件存回工程。
- `switchVersion()` 有 `versionId === currentVersionId` 早退 + `token !== openSeq || doc !== owner` 双校验，快速连点不会串图。
- 形状层负宽高有 `normalizeBox()` 兜底；直线/箭头走 `_paintArrowStroke()` 直接读 `this.x/this.width`，方向不会被 `abs` 抹平（`_rotateLayersBy90` 用负宽表示反向是对的）。
- `planBaseSwap()` 对"比例不同"（扩图）返回 `unsure` 且不缩放图层，符合 §0.1 决策 2/5；对"等比放大"按倍数缩放也符合。
- `repair` 的裁剪原点偏移（`_drawRepair` 减 `crop.x/y`）与 `renderSample()` 临时去裁剪这两处修得对，是有价值的隐蔽 bug 修复。

---

## 7. 建议补的回归清单

现有 `node --test web/tests/studio/*.test.mjs`（139 条）覆盖不到 DOM 与历史指针，建议手动/Playwright 补这几条：

1. **旋转后撤销**：旋转 90° → 撤销 3 次 → 再重做 3 次，画面与图层几何都要回到正确状态（对应 §1）。
2. **重置后刷新**：画蒙版 → 等保存 → 重置全部 → 等保存 → 刷新，蒙版必须为空（对应 §2）。
3. **同尺寸换主图**：AI 修改 → 设为新主图 → 点旧命名快照，应拒绝或明确提示（对应 §3）。
4. **预览态直接画**：有预览时选画笔点一下，应只退出预览、不落笔（对应 §5-1）。
5. **合并后刷新**：画蒙版 → 「与主图合并」→ 等保存 → 刷新，蒙版必须为空（对应 §2 的第二个入口）。
6. **送图包含图层**：勾选「送图包含图层」→ 生成 → 设为新主图，画面上应只有一份图层像素（当前靠 `containsLayers` 提示，建议顺带验证一键隐藏）。

---

## 8. 建议处理顺序

1. **P1 撤销跨旋转**（影响面最大，用户每天按 Ctrl+Z）；
2. **P2 `resetAll` 版本号**（一行修复，避免脏数据落盘）；
3. **P2 快照归属 + `baseId`**（与 P1 同一改动，建议一起做）；
4. P3 各项按顺手程度合并进同一次提交。

---

## 9. 第三轮追加审查（代码 @ `8e2f483`，文档 @ `2ec4cd9`）

> 只补充 §1–§8 之外的新问题，不重复已记录项。
> 已执行：`node --check`（本次改动涉及的 6 个前端模块全部通过）、`node --test web/tests/studio/*.test.mjs`（139 pass / 0 fail），没有语法或单测回归；以下结论来自静态审查 + 路径推演。

### 9.0 先复核前两轮的结论（都在最新代码里）

| 原问题 | 现状 | 结论 |
| --- | --- | --- |
| §1 撤销跨 90° 旋转被吞、指针已前移 | `studioDoc.js:209-221`、`:245-249` 未改 | **仍存在**；`redo()` 有同样问题（见 §11-1） |
| §2 重置 / 合并后蒙版 Blob 复用旧像素 | `resetAll()`（`studioDoc.js:489-500`）、`replaceBaseFromCanvas()`（`:836-853`）仍不自增 `maskVersion / repairVersion` | **仍存在** |
| §3 命名快照只按尺寸判归属 | `_canRestore()` 仍只比 `oriented` | **仍存在** |

### 9.1 新增问题总览

| 级别 | 问题 | 位置 |
| --- | --- | --- |
| P2 | `pointercancel` 只丢掉 drag，不回滚**已经落下**的像素 / **已经移动**的图层 | `studio.js:6167-6174`（对照 `:6010-6047`） |
| P2 | 选区带 `rect` 后，蒙版画笔 / 修复 / 形状 / 提交蒙版仍按 `(0,0)` 贴 alpha → 在图层对象上涂抹整笔被裁掉 | `studio.js:1351-1354`、`:5011`、`:5051`、`:5093`、`:5121`、`:5204` |
| P2 | 文字层翻转按 `width=0` 算中心 → 位置偏移自身宽度，可能整段飞出画布 | `studioDoc.js:397-425` |
| P2 | 左 / 上扩图（及自定义比例）不补偿图层，与 PLAN §4.4 的结论不一致 | `studio.js:6740-6765`、`aiPanel.js:1871-1876` |
| P2 | 选区橡皮把选区擦空后不清 `selection`，之后画笔 / 修复全部「涂不上」 | `studio.js:4294-4301`、`:5082-5128` |
| P3 | `redo()` 同样无视 `restore()` 失败 | `studioDoc.js:216-221` |
| P3 | 换主图放大后，撤销回来的文字字号被 `TextLayer` 构造夹取 | `textLayer.js:102-113`、`:268-295` |
| P3 | 「设为新主图」后 AI 面板 `previewOn` 未复位 | `aiPanel.js:1866-1887` |
| P3 | 预览仍在加载时 `enterBaseEdit()` 不生效，图加载完又盖回画布 | `studio.js:3286-3292` |
| P3 | 换主图无条件清空命名的选区组 | `studio.js:6772` |
| P3 | 快门缩略图在 `await` 编码之后才绘制；JSDoc 仍是旧语义 | `studio.js:6958-6985` |
| P3 | 每次图层 / 历史刷新都重建两个「对象」下拉的 innerHTML | `studio.js:4474-4492`、`:1380-1383` |
| P3 | 选区每一笔提交都全图 scan，4K 图上明显卡顿 | `studio.js:4294-4300`、`selection.js:299-306/349-356` |
| P3 | 恢复工程时无上限并发解码所有图层位图 | `studio.js:7793-7809` |
| P3 | 结果预览上的蒙版色纱按预览矩形拉伸，比例不同时错位 | `studio.js:3746-3761` |
| P3 | `history.bytes` 只算蒙版，不计修复层与图层蒙版克隆 | `studioDoc.js:159-172`、`history.js:29-35` |
| P3 | 放大仍送合成图，但 `switchVersion` 把 `upscale` 当「不含图层」 | `studio.js:10229-10231`、`:6683-6684` |
| P3 | 分割回退只覆盖「提交请求抛错」，异步任务失败 / 空蒙版不回退 | `studio.js:4836-4850` |
| P3 | 图层对象的点提示越界被 clamp 到边缘，变成伪前景点 | `studio.js:4766-4769` |
| P3 | 抠图菜单的「对象」不影响已有选区的取像 | `studio.js:9838-9860` |

---

## 10. P2 详述与改法

### 10.1 P2：`pointercancel` 丢弃 drag，但像素与图层已经改过

**现象**

用触控笔 / 触屏涂抹蒙版、污点修复或拖动图层时，如果系统取消了手势（来电、通知、多指误触、拖出窗口），抬手后：

1. 画面上笔触 / 位移**已经生效**；
2. 撤销按钮步数没有增加，`Ctrl+Z` 会直接退回到**上一次提交之前**的状态（多退一步）；
3. 自动保存已经把半截笔触写进工程（`markMaskChanged` / `stampRepairLive` 已经自增了版本号），刷新后半截笔触还在，历史里却没有它。

**根因**

`pointermove` 里的 `strokeTo` / `healStroke` / `cloneStroke` / `moveLayer` 都是**就地改文档**；快照只在 `endDrag` 的提交分支里落（`studio.js:6010-6047`）。新的取消分支只把 `drag` 置空：

```js
// studio.js:6167
refs.canvas.addEventListener('pointercancel', () => {
  drag = null;      // ← 文档已经变了，但没有回滚也没有提交
  dragRect = null;
  cursor = null;
  scheduleDraw();
});
```

原来的实现走 `endDrag`，虽然会「误落笔」，但至少历史与画布是同步的；现在改成丢弃，反而制造了**不可撤销的半成品状态**。

`selpaint` 还额外有一份不一致：`selection.canvas` 上已经画了笔触，但 `selection.alpha` 没同步（`commitSelectionPaint` 才是同步点），随后的抠图 / 转蒙版用的是旧 alpha。

**建议**

按「是否需要回滚」区分，而不是一律丢弃：

| drag.mode | 取消时 |
| --- | --- |
| `paint` / `spot` / `clone` / `clone-blocked` / `smudge` / `skin` / `liquify` / `mosaic` / `selpaint` | 已经改像素：走 `endDrag` 提交（`selpaint` 至少调一次 `commitSelectionPaint`），或统一回滚到上一帧快照 |
| `moveLayer` | 用 `drag.originX/originY` 复位并 `doc.touchLayers()` + `scheduleDraw()`，不落新快照 |
| `crop` / `segBox` / `shapeDraw` / `local` / `patternPick` / `pan` | 无副作用，维持现在的丢弃逻辑 |

若选择「回滚」，建议在 `StudioDoc` 上加一个明确入口，避免 UI 直接摸 `_history`：

```js
// studioDoc.js
rollback() {
  const past = this._history.past;
  const last = past[past.length - 1];
  if (!last) return false;
  return this.restore(last);   // restore 内部会重建蒙版副本并自增版本号
}
```

### 10.2 P2：`selection.rect` 只被「画」和「抠图」认，蒙版侧仍按 `(0,0)` 贴

**现象**

「对象 = 某个叠加层」发起主体选择后（选区可能落在裁剪区外，`selection.rect` 不是 0）：

1. 选中画笔 `I` / 橡皮 `Q` 加减选区正常；
2. 但切回普通画笔 `B`、污点修复、套索 / 矩形填充、或直接提交 AI，笔触**整笔消失 / 只掉了一个角**——看起来就是「画笔坏了」。

**根因**

`setSelectionAlpha()` 现在支持 `rect`（`studio.js:4191`），但所有「把选区 alpha 贴进蒙版坐标系」的调用点仍是旧约定（选区左上角 = 文档 0,0）：

```js
// studio.js:5051（stampMask，画笔）
sctx.drawImage(selection.canvas, -x0, -y0);
// :5011（stampLayerMask）、:5121 / :5093（commitShapePaint）、
// :5204（repairPaint）、:1351-1354（submissionMask 合并）
```

当 `selection.rect = {x: 1200, y: 800}`、画布只有 `1600×1200` 时，alpha 只覆盖画布左上角；在图层真实位置落笔时，`destination-in` 取到的是全透明 → 整笔被裁掉。`submissionMask()` 的 `canMerge` 还会因为「选区尺寸 ≠ 蒙版尺寸」直接把选区和蒙版分成两条路，选区被静默忽略。

**建议**

给选区保留一份**文档蒙版坐标**的 alpha 画布（`rect = 0,0`），只在「区域选择」入口生成一次，后面所有蒙版侧消费者统一用它：

```js
function selectionAlphaInDocSpace() {
  if (!selection?.canvas) return null;
  if (selection.docCanvas) return selection.docCanvas;           // 缓存
  const rect = selection.rect || { x: 0, y: 0 };
  if (!rect.x && !rect.y) return (selection.docCanvas = selection.canvas);
  const canvas = document.createElement('canvas');
  canvas.width = doc.mask.width;
  canvas.height = doc.mask.height;
  canvas.getContext('2d').drawImage(selection.canvas, rect.x, rect.y);
  return (selection.docCanvas = canvas);
}
```

`setSelectionAlpha` / `commitSelectionPaint` / `clearSelection` 时置空缓存；`stampMask`、`stampLayerMask`、`commitShapePaint`、`repairPaint`、`submissionMask` 全部改用它。这样也顺手把 `canMerge` 恢复成「尺寸恒等于蒙版」，选区能正常并入提交蒙版。

### 10.3 P2：文字层翻转位置错误（`width` 不存在）

**现象**

画布 2000×1000，文字放在 `x = 100`（左侧），文字宽约 300 → 水平翻转后文字跑到 `x = 1900`，右侧 200px 被画布裁掉（视觉上「翻一下文字就没了」）；垂直翻转同理（单行文字被推到画布下方）。

**根因**

`_flipLayerGeometry()` 统一用 `layer.width / layer.height` 取尺寸：

```js
// studioDoc.js:397
const w = layer.width || 0;
const h = layer.height || 0;
...
layer.x = W - cx - w / 2;   // w = 0 → x = W - x
```

`OverlayLayer` 有 `get width()`，`ShapeLayer` 有字段，但 **`TextLayer` 两者都没有**（只有 `_localBounds()`）。于是文字被当成 0 尺寸对象，只镜像了锚点，没有考虑自身包围盒。

> 旋转不受影响：文字以锚点 `(x, y)` 为圆心旋转，锚点按整图旋转映射本身就是精确解；只有「翻转镜像包围盒」这一步需要宽高。

**建议**

翻转时对文字单独取本地包围盒尺寸（不要直接给 `TextLayer` 加 `width/height`，那会让 `_rotateLayersBy90()` 的中心映射也被启用，反而破坏当前正确的旋转逻辑）：

```js
const geom = layer.isText ? layer._localBounds() : { width: layer.width || 0, height: layer.height || 0 };
```

同时把 `shadowX / shadowY` 按轴取反（现在翻转后投影方向仍是旧的），这与 §8.1-2「缩放时补 `shadowY`」是同一类遗漏。

### 10.4 P2：左 / 上扩图不补偿图层，与 PLAN §4.4 冲突

`planBaseSwap()` 对「比例变化」一律返回 `unsure` 并保持原坐标：

```js
// studio.js:6764
return { scale: 1, dx: 0, dy: 0, unsure: true, sizeChanged: true };
```

但 PLAN §4.4 已经拍板：**向右 / 向下扩天然不动；向左 / 向上扩按扩展量 (dx, dy) 平移图层**。现在的实现里，左 / 上扩图后原图内容被推到右下，图层却停在左上，整组图层错位一个 padding（只给一句「可能需要手动微调」）。

同样的问题在**结果预览**阶段：`aiPanel` 只把 `url` 交给画布（`showResult`），画布用 `fit = min(dw/doc.size.width, dh/doc.size.height)` 铺图层（`studio.js:3733-3741`），相当于假设「旧底图占满整张结果」，扩图预览时图层会被缩小并贴到左上角。

**建议**

扩图面板本来就有四向百分比（`outpaint.top/bottom/left/right`），提交时一并带给宿主即可：

```js
// aiPanel submit / recordAiResult / adoptResult
const pad = {
  left: Number(inputs['outpaint.left'] || 0),
  top: Number(inputs['outpaint.top'] || 0),
  right: Number(inputs['outpaint.right'] || 0),
  bottom: Number(inputs['outpaint.bottom'] || 0),
};
```

`planBaseSwap(target, nw, nh, pad)` 里在「比例不一致」之前先处理扩图：

```js
if (pad) {
  const dx = Math.round(oldSize.width * pad.left / 100);
  const dy = Math.round(oldSize.height * pad.top / 100);
  return { scale: 1, dx, dy, unsure: false, sizeChanged: true };
}
```

预览侧用同一组 padding 决定图层绘制偏移（`translate(px + dx*fit, py + dy*fit)`），预览与采用后的画面才一致。若本轮不想动 API，至少把提示文案改成「左/上扩图后图层不会自动平移」，别让用户以为是自己点错了。

### 10.5 P2：选区擦空后不清选区，画笔「涂不上」

`commitSelectionPaint()`（`studio.js:4294`）只同步 alpha，不检查空选区：

```js
selection.alpha = canvasToAlpha(selection.canvas);
```

用选区橡皮 `Q` 把选区全部擦掉后，`selection` 对象仍然存在（`updateSelectionUi` 显示「选区 0%」，`selbar` 还在），而 `stampMask` / `repairPaint` / `commitShapePaint` 都会用这份**全透明**选区做 `destination-in` → 画笔、修复、套索全部无效，只能按 Esc 清选区才恢复。

**建议**

```js
function commitSelectionPaint() {
  if (!selection?.canvas) return;
  selection.alpha = canvasToAlpha(selection.canvas);
  if (!selectionHasPixels(selection.alpha)) {
    clearSelection();                 // 擦干净 = 取消选区
    return;
  }
  ...
}
```

（`selectionWidth/Height` 为 0 的边界也一并兜住。）

---

## 11. P3 清单（建议随手下改）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `studioDoc.js:216-221` | `redo()` 与 §1 的 `undo()` 同构：`restore()` 失败仍返回 `true` 并已把状态 push 回 `past` | 与 `undo()` 一起改，失败时把状态退回 `future` 并 toast |
| 2 | `textLayer.js:102-113`、`:268-295` | 换主图等比放大 2× 后 `fontSize` 可 > 400、`strokeWidth` > 40；但每次 `snapshot()` 的 `layer.clone()` 会在构造器里夹回上限 → 撤销一次文字就变小/描边变细 | 夹取只放在 UI 输入处，或 `clone()` 时原样透传 |
| 3 | `aiPanel.js:1866-1887` | 「设为新主图」成功后没有复位 `state.previewOn`，按钮仍写「回到主图」；再点一次会重新把旧结果盖到新主图上 | 与 `asLayerBtn` 一致：置 false、文案改回「画布预览」、`showResult(null)`（或直接调 `controller.exitPreview()`） |
| 4 | `studio.js:3286-3292` | `enterBaseEdit()` 只判断 `preview.image`；预览图还在加载时（`preview.image === null`、`previewSeq` 已自增）不退出，加载完成后又盖住刚画的笔触 | 记录 `preview.pendingUrl`，或让 `enterBaseEdit()` 无条件 `++previewSeq` + `ai.exitPreview()` |
| 5 | `studio.js:6772` | `afterBaseSwap()` 无条件 `selectionSets = []`：同尺寸换主图（AI 修图、切同尺寸版本）时，用户存的多组命名选区全部丢失 | 尺寸与原点都没变（`!plan.sizeChanged`）时保留，或给每组记 `baseKey` 在不可用时置灰 |
| 6 | `studio.js:6958-6985`、`:6936-6939` | 快门缩略图在 `await canvasToBlob()` **之后**才 `drawLayers`，编码期间拖动图层会让缩略图与快照内容不一致；同函数 JSDoc 还写着「烘焙…图层」 | 先同步画好缩略图再 await 编码；顺手改注释 |
| 7 | `studio.js:4474-4492` + `:1380-1383` | `syncLayersPanel()` 每次都重建 `segTarget / cutTarget` 的 `innerHTML`：撤销、切图层、AI 刷新都会触发，用户正展开下拉时会被关掉 | 只在 options 签名（id + name 列表 + 当前选中）变化时重建 |
| 8 | `studio.js:4294-4300`、`selection.js:299-306`、`:349-356` | 选区每笔结束都 `canvasToAlpha`（整图 `getImageData`）+ `coverageAlpha`（8M 次循环）+ 蚂蚁线重建，4K 上明显掉帧 | 记录笔触 dirty bbox，只把该矩形写回 alpha；覆盖率增量维护 |
| 9 | `studio.js:7793-7809` | 恢复工程把**所有**图层位图 + 蒙版同时解码，10 个 4K 图层峰值可达数百 MB（低端机 OOM 风险） | 并发上限 2–3（简单信号量），主图仍优先 |
| 10 | `studio.js:3746-3761` | 预览图上按 `previewRect` 拉伸蒙版色纱：扩图 / 自定义比例时红色区域与内容错位（蒙版属于旧底图，不应该覆盖新补出来的区域） | 用「旧底图在预览中的矩形」绘制，比例差异过大时干脆不画并提示 |
| 11 | `studioDoc.js:159-172`、`history.js:29-35` | `bytes` 只算 `mask`，`repair` 与各图层蒙版克隆都没计 → 256MB 预算实际可能吃 2–3 倍内存 | `bytes` 累加 `repair` 与 `layer.mask` 的尺寸，或按「内存预算 ÷ 系数」下调 |
| 12 | `studio.js:10229-10231`、`:6683-6684` | 放大仍送 `doc.bake()`（含图层，结果被烘焙进新工程），而 `switchVersion` 把 `kind === 'upscale'` 一律当「不含图层」，`containsLayers` 标记与事实不符 | 统一改送 `bakeMain()`（与 AI 送图一致）；若保持现状，放大卡要写 `containsLayers: true` |
| 13 | `studio.js:4836-4850` | 「SAM 不可用回退 BiRefNet」只包住 `api.segment()` 抛错；异步任务返回 `no_subject` / 空蒙版时不回退（点背景是常见误操作） | 在 `job.status !== 'done'` 或 `masks.length === 0` 且 `segMode === 'subject' && !segModel` 时重试一次 `mode: 'subject'` |
| 14 | `studio.js:4766-4769` | 图层对象的点提示越界时被 clamp 到区域边缘，等于凭空加了一个边缘前景/排除点 | 越界点直接丢弃（记录丢弃数并提示「N 个点不在对象范围内」） |
| 15 | `studio.js:9838-9860` + `cutTarget` | 抠图菜单的「对象」下拉只影响下一次分割；已有选区的抠图仍按 `selection.source` / 合成图取像，用户会以为下拉无效 | 要么下拉只放在主体选择条里，要么抠图时按当前「对象」重新取像（与 `selection.rect` 对齐） |

---

## 12. 本轮确认做得对的点

- **SAM 3.1 提示组合**：前后端契约一致（点坐标 scale 到发送图、框转 xyxy 后统一 `max_side` 缩放），`manager` 在 `mode=text/points` 叠加框时统一 `clip_to_box`，语义是「框 = 范围限制」，与 UI 文案一致。
- **选区空间重构**：`selection.rect / source` 在绘制（`studio.js:3765-3776`）、反选 / 羽化 / 扩展、转蒙版、抠图、批量导出这几处都正确换算了原点，`buildCutoutCanvas()` 也按 `baseRect / alphaRect` 重新取样，画布外图层可以正常抠图。
- **结果预览绘制**：`previewRect` + 统一比例 `fit`（`min`）叠图层，比例不同不再把图层拉变形；`setPreview` 的 `previewSeq` 也堵住了旧请求覆盖新状态。
- **换主图路径收敛**：`switchVersion()` / `adoptResult()` 共用 `planBaseSwap()` + `compensateLayersForBase()` + `afterBaseSwap()`，`sourceBlob`、`currentVersionId`、`containsLayers` 都同步了，没有再出现「刷新把旧源文件存回工程」。
- **租约**：`visibilitychange` 回前台立即 `beat()`，配合 `storage` 兜底，「后台标签带着过期租约继续保存」的场景基本堵住。
- **恢复工程**：主图与图层解码并行，4K 多图层恢复时间明显下降（代价见 §11-9 的内存峰值）。
- **交互细节**：`pointerdown` 过滤右键/侧键、`pointerleave` 清光标、`blur` 复位空格平移与 `preview.flash`，都是有效的小修。

---

## 13. 本轮建议补的回归项

1. **取消手势一致性**：触控笔涂抹蒙版时来电 / 切后台再回来 → 笔触与撤销栈必须一致（对应 §10.1）。
2. **图层对象选区 + 涂抹**：选中画布外 / 裁剪外的图层 → 主体选择 → 切画笔 `B` / 污点修复涂抹 → 笔触应落在选区内（对应 §10.2）。
3. **文字翻转**：左边缘文字 → 水平翻转 → 文字留在画布内且位置镜像；垂直翻转同理（对应 §10.3）。
4. **左 / 上扩图**：设 20% 左扩 + 10% 上扩 → 设为新主图 → 图层随原内容平移（对应 §10.4）。
5. **选区擦空**：选区橡皮擦光 → 切画笔 → 应能正常涂抹；Esc 前后行为一致（对应 §10.5）。
6. **放大链路**：带图层的图放大 → 图层是否还在 / 是否出现重影（对应 §11-12）。

---

## 14. 第三轮建议处理顺序

1. §2 的 `maskVersion / repairVersion` 两行补丁（已记录，一行修复，先落）；
2. §10.1 `pointercancel` 回滚/提交 + §10.5 空选区清理（都是「文档与历史不同步」，一起改）；
3. §10.2 选区 `rect` 收敛到 `selectionAlphaInDocSpace()`（影响画笔可用性）；
4. §10.3 文字翻转（一行尺寸来源修正 + 阴影方向）；
5. §10.4 扩图 padding（要动 aiPanel → studio 的参数，单独一次提交）；
6. §11 里挑 1–3、4、12 三条顺手改，其余按用户反馈再排。

---

## 15. 第四轮审查（整改提交 `71d2ad0` / `9cb6872`）

> 审查对象：`feat/studio-main-image-model` @ `71d2ad0`（与 `review/studio-main-image-model` @ `9cb6872` 的 `web/src` 完全一致，blob 相同）
> 范围：只看这次整改新增/修改的代码，以及它和主图模型的交互；前三轮已记录、本次未动的不再重复。
> 已执行：`node --check`（`studio.js` / `studioDoc.js` / `history.js` 全部通过）、`node --test web/tests/studio/*.test.mjs`（139 pass / 0 fail）。**注意：§15.2 是运行时 `ReferenceError`，语法检查与单测都覆盖不到。**

### 15.1 整改复核

| 评审项 | 现状 | 结论 |
| --- | --- | --- |
| §1 撤销跨旋转 | `baseId` + `_canRestore` + 指针回滚 + UI 提示 | 已修（但 `resetAll` 误用，见 §15.4） |
| §2 重置 / 合并后蒙版复活 | 两处补版本号，保存缓存再比对画布引用 | 已修 |
| §3 快照只按尺寸判归属 | 快照随 `baseId` 判归属，文案已改 | 已修 |
| §4 `exportMainCanvas` 返回缓存引用 | `cloneCanvas` 副本 | 已修 |
| §5-1 预览态同一笔落画布 | `pointerdown` 退出预览后直接 `return` | 已修 |
| §5-3 `addOverlay` 整张合成 | 改读 `this.size` + crop 偏移 | 已修 |
| §5-4 快照不计内存 | 上限 20 张 ✓，但计数会双向漂移 | 部分修（§15.9） |
| §10.1 `pointercancel` 半成品 | 覆盖了像素类与 `moveLayer`，漏 3 个几何类 | 部分修（§15.6） |
| §10.2 选区 `rect` 未进蒙版坐标 | `selectionAlphaInDocSpace()` 统一消费 | 已修 |
| §10.3 文字翻转飞出画布 | `_localBounds()` + 阴影按轴取反 | 已修 |
| §10.5 选区擦空后涂不上 | 清理了选区，但引入 null 赋值 | 有回归（§15.3） |
| §11-1 / 3 / 4 / 6 / 11 | — | 已修 |
| §11-5 同尺寸换主图丢选区组 | 只按 `sizeChanged` 判断 | 部分修（§15.8） |
| §11-12 放大送合成图 | 改送 `bakeMain()`，但「载入为主图」路径没跟上 | 有回归（§15.7） |
| §11-14 越界提示点 | 新增 `segmentPointWithin()`，但依赖的函数不存在 | 未生效且更糟（§15.2） |

### 15.2 P1（阻断）：`segmentBounds()` 未定义，主体选择一按就抛错

**现象**

选中「主体选择」工具后，在画布上点一下（主体 / 点选）、Shift/Alt 加点、拖框，控制台立刻：

```
Uncaught ReferenceError: segmentBounds is not defined
```

画布没有任何反应，分割请求根本没发出去。等于主体选择、点选、框选、文字 + 框全部不可用。

**根因**

`studio.js:5620` 在进入任何模式分支之前先算了一次提示点判定：

```js
if (tool === 'segment') {
  const at = segmentPoint(freePoint);
  // 点提示不做夹取：夹到区域边缘会凭空多出一个「边缘前景点」，分割反而跑偏。
  const hint = segmentPointWithin(freePoint);   // ← 所有 segment 模式都会走到
```

而 `segmentPointWithin()`（`studio.js:4158-4167`）内部调用的 `segmentBounds()` **全仓库只有这一处引用，没有定义、也没有 import**：

```js
function segmentPointWithin(rawPoint) {
  const crop = doc?.transform.crop;
  const box = segmentBounds();   // ← ReferenceError
```

这是本次为了修 §11-14 新加的函数，函数漏写了；`node --check` 只查语法、单测不加载 DOM，所以都没拦住。

**建议**

补一个与 `aiTargetSource()`（`studio.js:4631-4666`）同源的可分割区域，别再手写第二份边界计算：

```js
/** AI 这次真正能看到的区域（「旋转后未裁剪」空间）。 */
function segmentBounds() {
  const layer = aiTargetLayer();
  if (layer) {
    const b = layerBox(layer);
    return {
      x: Math.floor(b.x) - 2,
      y: Math.floor(b.y) - 2,
      width: Math.max(8, Math.ceil(b.width) + 4),
      height: Math.max(8, Math.ceil(b.height) + 4),
    };
  }
  const crop = doc?.transform.crop;
  const oriented = doc?.oriented || { width: 0, height: 0 };
  return crop
    ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
    : { x: 0, y: 0, width: oriented.width, height: oriented.height };
}
```

并让 `aiTargetSource()` 复用它的返回值作为 `region`：现在两处各写一遍（`-2` / `+4` / crop），一旦改了一边，就会变成"提示点判越界、送图区域却没变"的错位。

### 15.3 P2：擦空选区后 `commitSelectionPaint()` 对 null 赋值

**现象**

选区橡皮 `Q` 把选区擦干净再松手（或手势被系统取消），控制台每次抛一次：

```
TypeError: Cannot set properties of null (setting 'docCanvas')
```

选区本身已经被清掉，但 `pointerup` / `pointercancel` 回调在这里中断，同一事件里后面的收尾（`updateHistoryUi` 等）会被跳过。

**根因**（`studio.js:4345-4360`）

```js
if (!selectionHasPixels(selection.alpha)) {
  clearSelection(true);        // ← 内部执行 selection = null
  selection.docCanvas = null;  // ← TypeError
  return;
}
```

**建议**

删掉 `selection.docCanvas = null;` 这一行（函数开头已经置过一次）。顺手补一条"擦空选区后松手"的用例（§15.12-2）。

### 15.4 P2：`resetAll()` 自增 `baseId` → 「恢复原始图片」从此不可撤销

**现象**

点「恢复原始图片」→ 再按 Ctrl+Z 或撤销按钮：画面不动，弹「这一步属于上一张主图，无法撤销」；撤销按钮始终保持可用，点一次弹一次。之前存的命名快照也全部变成"属于上一张主图"，点了也不能恢复。

**根因**

`resetAll()`（`studioDoc.js:521-536`）里加了：

```js
this.maskVersion += 1;
this.repairVersion += 1;
this.baseId += 1;      // ← 但底图并没有换，也没清历史
this.invalidateBase();
this.snapshot();
```

而 `_canRestore()`（`studioDoc.js:267-270`）现在只认 `baseId`：

```js
_canRestore(state) {
  if (!state || state.baseId === undefined) return true;
  return state.baseId === this.baseId;
}
```

`undo()` 恢复失败会把指针退回去并返回 false，UI 就弹那句"属于上一张主图"。但 `resetAll()` 只是清调色 / 裁剪 / 蒙版 / 图层，**底图没变**，本应是可正常撤销的一步，命名快照也理应继续有效。

> 这次 §1 的整改方向是对的：只让"真的换底图"改 `baseId`。而 `replaceMainImage()`（`studioDoc.js:481-484`）与 `replaceBaseFromCanvas()`（`:885-890`）都会 `clearHistory()`，所以"恢复被拒"这个分支本来只该是防御性的；`resetAll()` 误加之后，它变成了每次重置后必现的用户可见问题。

**建议**

1. 去掉 `resetAll()` 里的 `this.baseId += 1;`，只保留 `maskVersion / repairVersion`（这两行是本次要的，别一起删）。
2. 如果产品确实要求"恢复原始图片不可撤销"，就显式 `this.clearHistory()`，并把确认框文案改成"不可撤销"——不要让按钮变成点了没反应。
3. 收紧语义：`baseId` 只应在 `replaceMainImage()` / `replaceBaseFromCanvas()`（真正换底图且 `clearHistory()`）里自增。

### 15.5 P2：点提示换算丢掉 `label`（Alt 排除点全部变成正点）

**现象**

- 「点选」模式：按住 Alt 点几下，状态栏明确显示"已 N 点，含 M 个排除点"，但输出蒙版完全不排除这些点；
- 「框选」模式：Shift 加点 / Alt 排除点同样失效，全部被当成前景点。

**根因**（`studio.js:4825-4828`，消费点 `:4875`、`:4884`）

```js
// 点提示同样裁进发送图：落点可能在图层外，超出部分后端不认。
const toViewPoint = (point) => ({
  x: Math.max(0, Math.min(region.width, point.x - region.x)),
  y: Math.max(0, Math.min(region.height, point.y - region.y)),
});                                    // ← label 被丢掉
...
payload.points = toSendPoints(segPoints.map(toViewPoint), send.scale, null);
```

`toSendPoints()` 里是 `label: point?.label === 0 ? 0 : 1`；`label` 已是 `undefined`，于是全部按 1 发送。这是本次「按 region 偏移提示坐标」重构引入的回归——上一版是 `toSendPoints(segPoints, send.scale, crop)`，`label` 原样保留。

**顺带一个边界问题**：上面用 `Math.min(region.width, …)` 夹取，允许正好取到 `width` / `height`（再乘 `send.scale` 后正好等于送图宽高）；而后端 `validate_points()`（`server/segmenters/maskops.py:76`）要求 `x < width && y < height` → 在右/下边缘点一下（或越界点被夹到边缘）会让**整次分割**报「取样点无效」，而不是忽略那一个点。

**建议**

```js
const toViewPoint = (point) => ({
  x: Math.max(0, Math.min(region.width - 0.5, point.x - region.x)),
  y: Math.max(0, Math.min(region.height - 0.5, point.y - region.y)),
  label: point.label === 0 ? 0 : 1,
});
```

更好的做法：既然刚加了 `segmentPointWithin()`，区域外的点直接**丢弃**（含 Alt 点），不要夹取——夹取本身就是"边缘伪点"的来源。

### 15.6 P2：`pointercancel` 仍漏掉三个「已经改过几何」的拖拽模式

本次把已改像素的模式统一走 `endDrag()`、`moveLayer` 复位，方向是对的。但下面三个模式在 `pointermove` 里**已经就地改了文档**，既不在 `painted` 集合里、也没有复位逻辑：

| 模式 | 拖动中改了什么 | `endDrag` 里的提交 |
| --- | --- | --- |
| `perspCorner`（`studio.js:6038-6048`） | 直接改 `layer.quad[drag.index]` | `doc.commitLayers()`（`:6187-6191`） |
| `stickerScale`（`:6011-6021`） | `setStickerScale()` 改 `layer.scale` | `commitSticker()`（`:6192-6194`） |
| `stickerRotate`（`:6023-6036`） | 改 `layer.rotation` | `commitSticker()` |

于是触控笔/触屏手势被系统取消（来电、切后台、多指误触）时：画面已经变了，但既没有快照也没有回滚——和 §10.1 描述的问题一模一样，只是换了工具；自动保存还会把这个半成品写进工程。

**建议**

```js
const commitModes = new Set([...painted, 'perspCorner', 'stickerScale', 'stickerRotate']);
if (commitModes.has(mode)) {
  endDrag();
  return;
}
```

两点补充：

- `clone-blocked`（`studio.js:6248`）本来就没落笔，走 `endDrag()` 会 `doc.snapshot()` 多出一条无变化的撤销步，建议从集合里去掉；
- 如果想做到"真正回滚"而不是"提交"，需要在 `pointerdown` 时就备份 `{ scale, rotation, quad }`（目前没有备份，`perspCorner` 只能提交）。

### 15.7 P2：放大「载入为主图」仍是新工程，图层静默丢失

**现象**

带贴纸 / 文字 / 形状的图 → 放大 → 点「载入为主图」→ 进入的是一个**新工程**，只剩放大后的底图，图层全部消失，也没有任何提示或确认。

**根因**

这次把放大送图改成了主图（`studio.js:10345`，`doc.bakeMain()`，正确），但采用路径没改：

```js
// studio.js:10345-10348
getImage: () => doc.bakeMain('image/png'),
onAdopt: (url, name) => openUrl(url, name, { kind: 'upscale' }),
```

`openUrl()`（`studio.js:8266-8287`）内部是 `new StudioDoc()` + `beginProject()` + `setDoc()`，等价"新开一个工程"。改之前图层像素烘焙在放大图里，所以看起来"没丢"；现在不烘焙了，图层就真空了。而按钮文案是「载入为主图」，与本分支主张的「主图 = 仅底图，图层保留」直接冲突。

**建议（二选一）**

1. 走与 AI 结果相同的路径：抽一个 `adoptAsMain(url, name, { kind })`，内部复用 `planBaseSwap() + compensateLayersForBase() + replaceMainImage() + afterBaseSwap()`，再 `recordVersion(...)`。放大是等比尺寸变化，`planBaseSwap()` 的 `scale = nw / oldSize.width` 分支正好能把图层按倍数缩放（文字字号、形状宽高、透视 quad 都已覆盖）。
2. 若产品就是要"放大 = 另存新工程"，把按钮改成「放大并新建工程」，并在确认框里写明"当前 N 个图层不会带过去"。

### 15.8 P3：`afterBaseSwap()` 只在尺寸变化时清选区组，漏了「裁剪原点变化」

`afterBaseSwap()` 现在是 `if (sizeChanged) selectionSets = []`（`studio.js:6870`）。但 `planBaseSwap()` 的第一个分支（`:6841`）在"新图尺寸 == 当前画面尺寸"时返回 `sizeChanged: false`，**同时 `dx/dy = -crop.x/-crop.y`**：

```js
// 新图尺寸 == 当前画面（裁剪后）
return { scale: 1, dx: -(crop?.x || 0), dy: -(crop?.y || 0), unsure: false, sizeChanged: false };
```

因为 `replaceMainImage()` 会把 crop 清掉，图层与选区的坐标空间从「旋转后未裁剪」变成了「裁剪后」。结果：有裁剪时做一次同尺寸换主图（AI 修图、同尺寸版本卡），图层被正确平移了，但保存的选区组仍按旧原点解释 → 载入后整体偏移一个 crop 偏移。

**建议**：给 plan 补 `originChanged: Boolean(dx || dy)`，`afterBaseSwap` 改成 `if (plan.sizeChanged || plan.originChanged) selectionSets = []`；或在 `replaceMainImage()` 里随 `baseId` 一起作废，语义更不容易漏。

### 15.9 P3：命名快照计入 `history.bytes` 的方式会让预算双向漂移

`addSnapshot(state)` 直接 `bytes += sizeOf(state)`（`history.js:95`），但 `StudioDoc.addSnapshot()`（`studioDoc.js:255-260`）传进来的就是 **`past` 里已经存在的那个 state 对象**：

- 并存快照时没撤销 → 同一份状态被 `push()`（`history.js:54`）和 `addSnapshot()` 各算一次 → 预算虚高，`trim()` 提前裁掉撤销步（用户会觉得"只存了两张快照，撤销就少了好几步"）；
- 之后 `undo()`（`:63`）又把这份 state 减一次，而快照仍持有它 → 预算虚低，`trim()` 不再裁，内存反而失控。

另外 20 张 × 4K 全状态克隆（蒙版 + 修复 + 各图层蒙版）仍可能到几百 MB，`budget` 对快照完全没有约束。

**建议**

1. 计数与真实引用一致：`addSnapshot` 不计 `bytes`，但 `trim()` 的"总占用"里把 `snapshots` 的 `sizeOf` 也算进去（用 `Set` 对同一 state 去重）；
2. 或让快照存自己的克隆（`cloneState(state)`）并只计一次，历史里那份被裁剪时不会漏计；
3. 除 20 张上限外再给一个字节上限，超限提示用户删旧快照。

### 15.10 P3：切回「旋转之前」的版本卡，图层方向和底图不一致

**场景**：横图 → 向右旋转 90° → 在底部版本槽点最早那张「原始」卡。

- `planBaseSwap()`（`studio.js:6836-6856`）先比 `nw/nh == oldSize`，再比 `nw/nh == oldOriented`。旋转 90° 且无裁剪时 `oldSize === oldOriented`（都是 H×W），而「原始」卡是 W×H，于是走比例分支：非方图返回 `unsure`，图层保持"旋转后"的坐标与自身 `rotation += 90`，而新底图已回到未旋转方向 → 画面上图层相对底图转了 90°。
- 方图时 W == H，尺寸刚好相等，会走"完全匹配"分支（`unsure: false`），静默错位，连提示都没有。
- 提示语仍是"尺寸变化较大，图层保持原坐标，可能需要手动微调"，用户很难联想到"方向不一致"。

**建议**：`planBaseSwap` 明确识别"目标尺寸 == 当前 `sourceSize` 且 `transform.rotate % 360 !== 0`"，返回 `rotateDelta: -rotate`；`compensateLayersForBase` 按 `rotateDelta` 反向旋转图层几何（复用 `_rotateLayersBy90` 的中心映射）。本轮不做的话，至少把它标成 `unsure` 并把文案改成「图层方向与新主图不一致，可能需要手动旋转」。

### 15.11 P3：其它小问题

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `studio.js:4859`、`maskops.py:51` | 文字模式下框整体落在送图外 → `clampToSend` 得到 0 宽框 → 后端报「框选区域无效，请重新框选」，与"限制搜索范围"的语境不符，且会让整次请求失败 | `width/height < 3` 时干脆不带 `box`，前端先提示"框不在可分割范围内" |
| 2 | `studio.js:9465-9475` | `commitTransform()` 先 `enterBaseEdit()` 再弹"会清空裁剪区域"确认框；用户取消时预览已经被关掉 | 把 `enterBaseEdit()` 挪到确认之后 |
| 3 | `studio.js:5524-5529` | 有预览时 `BASE_EDIT_TOOLS` 内的工具任何按键都先退出预览并 `return`，中键（平移）也被吞掉，第一下拖不动 | 只在 `event.button === 0` 时拦截 |
| 4 | `studio.js:6867-6890` | `afterBaseSwap()` 没清 `cloneAnchor / cloneOffset`（`setDoc()` 里有清，`:8313-8315`），换主图后仿制图章取样点仍指旧图坐标 | 一并清掉并 `syncCloneHint()` |
| 5 | `aiPanel.js:1429`、`toast.js:70` | `toastWarn(msg, { timeout: 8000 })` 的第二个参数被 `toastWarn(message)` 丢掉，实际仍是 5.5s | 给 `toastWarn` 加 options 透传 |
| 6 | `studio.js:2504-2516`、`:6393-6425` | `adoptResult()` 只校验 `openSeq`、不校验 `doc === owner`；而 `closeProject()` 不递增 `openSeq` → 关闭工程后迟到的结果会新建一个工程并写入 | 补 `const owner = doc;` 与 `if (doc !== owner) return null;` |

### 15.12 本轮建议补的回归项

1. **主体选择基本可用**：主体 / 点选 / 框选各点一下、Shift 加点、Alt 排除 → 不报错，排除点真的生效（§15.2、§15.5）。
2. **选区橡皮擦空**：擦光后松手无报错；接着切画笔 `B` 能正常涂抹（§15.3）。
3. **恢复原始图片**：点「恢复原始图片」→ Ctrl+Z 应完整回退，命名快照仍可恢复（§15.4）。
4. **手势取消覆盖几何类**：透视四角拖动、贴纸缩放/旋转中切后台再回来 → 画面与撤销栈一致（§15.6）。
5. **带图层放大**：「载入为主图」后图层是否保留（或至少明确告知会丢）（§15.7）。
6. **先裁剪再 AI 修图**：裁剪成 4:3 → 同尺寸 AI 修图 → 载入已存选区组是否仍对齐（§15.8）。
7. **快照与撤销预算**：连存 5 张命名快照 → 撤销步数不应骤减；删掉快照后预算应回落（§15.9）。
8. **旋转后切版本**：旋转 90° → 切回「原始」卡 → 图层方向是否正确（§15.10）。

### 15.13 建议处理顺序

1. **§15.2**（补 `segmentBounds`）—— 不修则主体选择整套不可用；
2. **§15.3**（删一行）—— 每次擦空选区都会抛错；
3. **§15.4**（删 `baseId += 1`）—— 恢复"可撤销的重置"，顺带让快照恢复重新可用；
4. **§15.5**（`label` + 边界）—— 点选/框选才能真正用上排除点；
5. **§15.6 / §15.7**（一个补 `pointercancel` 集合，一个改放大采用路径）；
6. §15.8–§15.11 按顺手程度合并进同一次提交。

---

## 16. 第五轮审查（提交 `2ad0da6`「对象级变换与多选」）

> 审查对象：`feat/studio-main-image-model` @ `4a89609`，对比 `71d2ad0`
> 范围：`web/src/components/studio.js`、`studio/studioDoc.js`、`studio/textLayer.js`、`studio/layerPanel.js`（+441 −46）；规格见 `docs/PLAN_STUDIO_MAIN_IMAGE_MODEL.md` §12
> 已执行：`node --check`（4 个文件全部通过）、`node --test web/tests/studio/*.test.mjs`（139 pass / 0 fail）。**本轮新增的 `rotateLayers` / `flipLayers` 没有任何单测覆盖**，下面 §16.1 的结论来自真实 `TextLayer` + 复刻数学公式的数值验证（非肉眼判断）。

### 16.1 P1：已有角度的文字图层，对象级旋转 / 翻转会整体跳位（实测 152px）

**现象**

1. 选中一个文字层，连点两次「向右旋转」：**第二次点击文字整体跳走约 150px**（画布尺寸不变，所以不是视图问题）；
2. 画布先「向右旋转」90°（文字随之 `rotation=90`），再点「水平翻转」：文字跳到别的位置；
3. 先旋转一次再翻转、或翻转后再旋转，同理。

**根因**

`_localBounds()` 返回的是 **未旋转的本地盒**（以锚点 `(x, y)` 为原点，见 `textLayer.js:136-160`），而 `bounds()` 才是旋转后的文档外接盒（`:163-187`）。三处文字分支都把 `_localBounds()` 当成了**文档坐标**：

```js
// studioDoc.js:571-589（rotateLayers）
const geom = layer.isText ? layer._localBounds() : null;
const offsetX = geom.x + geom.width / 2 - layer.x;   // 本地偏移（未旋转）
const center = map(geom.x + geom.width / 2, ...);    // ← 把本地盒中心当成文档中心
layer.x = center.x - (offsetX * cos - offsetY * sin);
```

文字的真实文档中心是 `锚点 + R(θ)·本地偏移`，不是 `锚点 + 本地偏移`。θ=0 时两者相同，所以首屏测试看不出来；一旦 `rotation ≠ 0`（画布旋转过、或已经点过一次图层旋转），中心就算错，反算出的锚点自然偏移。

`flipLayers()`（`studioDoc.js:650-665`）和全局 `_flipLayerGeometry()`（`studioDoc.js:437-462`，本次刚重写过）用的是同一套「本地盒 + 新角度反算」写法，因此同错。**PLAN §12.6 里「已有角度的文字不再漂移（三处统一）」的结论不成立**，需要一并订正文档。

**数值验证**（200×80 的文字、`rotation` 分别为 0 / 90，比较操作后的真实文档中心）：

| 场景 | 期望中心 | 实际中心 | 误差 |
| --- | --- | --- | --- |
| rotation=0，连点第 2 次旋转 | (400, 340) | (460, 480) | **152.3px** |
| rotation=90，第一次旋转 | (260, 400) | (320, 540) | **152.3px** |
| 画布旋转 90° 后水平翻转 | (1340, 400) | (1200, 340) | **152.3px** |
| 图层水平翻转（rotation=90） | (260, 400) | (120, 340) | **152.3px** |

**建议改法**

文字层的锚点 `(x, y)` 就是对象原点，**不需要包围盒**：直接对角点做变换，再累加角度 / 翻转即可，数学上是精确解（旋转、翻转都是等距变换，锚点随对象一起被映射）。

```js
// rotateLayers：文字层走「点 + 角度」，不用 _localBounds
if (layer.isText) {
  const p = map(layer.x, layer.y);          // 绕选择集中心转 90°
  layer.x = p.x;
  layer.y = p.y;
  layer.rotation = normalize360(layer.rotation + add);
  continue;
}

// flipLayers / _flipLayerGeometry：镜像锚点 + 角度取反 + 翻转位
if (layer.isText) {
  if (axis === 'h') layer.x = 2 * cx - layer.x;   // 画布翻转为 W - x
  else layer.y = 2 * cy - layer.y;                // 画布翻转为 H - y
  layer.rotation = normalize360(-layer.rotation);
  if (axis === 'h') layer.flipH = !layer.flipH;
  else layer.flipV = !layer.flipV;
  continue;
}
```

只有 overlay 层需要「中心 + 宽高反算左上角」（它用 `x/y` 当左上角、绕中心绘制）；文字是「锚点 + 本地盒」，两者不能套同一段代码。

**建议补单测**：`web/tests/studio/` 里已经有 `textLayer.test.mjs`，可加一个纯几何用例（stub `document.createElement` 的 `measureText` 即可，不需要真实 canvas），断言「rotation=0 连转两次」「rotation=90 转一次 / 翻一次」后锚点与文档中心位置。本轮这两个方法目前 0 覆盖，`node --test` 完全拦不住这类回归。

### 16.2 P2：选中图层组后点旋转 / 翻转，实际转的是整幅画面

`selectGroup()`（`studio.js:3030-3043`）只设 `selectedGroupId`，并清空 `selectedLayerIds / selectedLayerId / baseSelected`。于是 `selectionTarget()`（`:9598-9602`）判定为 `'none'`，而 `transformSelection()` 把 `'none'` 当成主图处理：

```js
if (selectionTarget() === 'layers') { ...图层分支... }
// 其余（'base' 和 'none'）都走 doc.rotateRight() / doc.flip()
```

结果：**用户选中一个图层组 → 点「向右旋转」→ 画布尺寸变了、裁剪被清空、蒙版跟着转**，组员一个都没转。这与 PLAN §12.3「组操作 = 批量对成员应用同一变换」以及阶段 4 的验收直接冲突，而且是对主图的破坏性操作（虽可撤销，但用户完全没预期）。

**建议**：`selectionTarget()` 先解析「实际可变换对象」，组选中时返回 `'layers'`：

```js
function selectionTarget() {
  if (selectedLayerIds.size || selectedLayerId) return 'layers';
  if (selectedGroupId) {
    const ids = doc?.layers?.filter((l) => l.groupId === selectedGroupId).map((l) => l.id) || [];
    return ids.length ? 'layers' : 'none';
  }
  if (baseSelected) return 'base';
  return 'none';
}
```

`transformSelection()` 的 `ids` 也按同一顺序取（组员 → 多选 → 单选）。另外建议补：组选中时把组员一起画成虚线框（现在多选框只遍历 `selectedLayerIds`，`studio.js:4067-4091`），否则用户看不到「这一转会转哪些对象」。

### 16.3 P2：选择状态三处不同步，导致旋转/翻转偶发失效 + 主图行与图层行同时高亮

`baseSelected` 是一个**独立布尔**，但代码里仍有 10 余处直接写 `selectedLayerId = ...` 而不清它：

| 位置 | 场景 |
| --- | --- |
| `studio.js:1290`（`afterLayerAdded`） | 拖入 / 粘贴一张素材 |
| `studio.js:5630` / `:6239` | 文字工具点一下建文字、拖框建形状 |
| `studio.js:2772`、`:2282` | 复制图层、粘贴图层 |
| `studio.js:10630` / `:10641` | 新建调整图层 / 「返回整图」 |
| `studio.js:8679` / `:8849` / `:9068` | 文字 / 贴纸 / 形状面板的删除按钮 |
| `studio.js:10943`（「恢复原始图片」） | `selectedLayerId = null`，但**没有**清 `selectedLayerIds / selectedGroupId` |

前一组（新增 / 选中类）：`baseSelected` 仍为 true，`getBaseSelected()` 让主图行保持高亮，图层面板出现**两行同时选中**；`selectionTarget()` 因为优先判图层，行为上还算「对」，但 UI 在说谎。

后一组（删除 / 重置类）更严重：`selectedLayerIds` 里留着**已经不存在的 id**，`selectionTarget()` 仍返回 `'layers'`，`doc.rotateLayers()` 过滤后返回 0，于是：

- 「恢复原始图片」之后点旋转 / 翻转 → 只弹「选中的图层不可变换（已锁定或是调整图层）」，主图再也转不动，直到用户重新点一下画布；
- 用文字 / 贴纸 / 形状面板的删除按钮删完图层后，同样失效。

这与 §15.4 的 `resetAll()` 问题叠加，会让「恢复原始图片」变成一连串看起来坏掉的操作（撤销无变化、旋转报错）。

**建议**

1. 收敛成一个入口，所有改选择的地方都走它（`selectLayerById` / `selectBaseObject` / `selectGroup` 内部也调用）：

```js
function setSelection({ layerIds = [], primaryId = null, groupId = '', base = false } = {}) {
  selectedLayerIds.clear();
  for (const id of layerIds) if (id && doc?.findLayer(id)) selectedLayerIds.add(id);
  selectedLayerId = primaryId && selectedLayerIds.has(primaryId) ? primaryId : ([...selectedLayerIds].pop() || null);
  selectedGroupId = groupId;
  baseSelected = base;
  editingLayerMaskId = '';
}
```

2. `selectionTarget()` 不要只看集合是否非空，**要解析出真实存在且可变换的图层**；没有就回退 `'base'`（或者 `'none'` 但给明确提示），别把「图层已被删」误报成「图层被锁定」。
3. 「恢复原始图片」的 handler（`studio.js:10924-10946`）补 `selectedLayerIds.clear() / selectedGroupId = '' / baseSelected = false / syncLayersPanel()`，并按 §15.4 决定到底要不要 `clearHistory()`。

### 16.4 P2：裁剪状态下旋转 / 翻转主图，视口仍会跳（「视口稳定」只在无裁剪时成立）

```js
// studio.js:9577-9584
const old = doc.oriented;
const crop = doc.transform.crop;
const anchorX = view.x + (old.width / 2 - (crop?.x || 0)) * view.scale;
...
view.x = anchorX - (size.width / 2) * view.scale;
```

视口里可见内容的中心，文档坐标是 `crop.x + doc.size.width / 2`，代码用的是整张未裁剪图的中心 `old.width / 2`。只有「裁剪框居中且宽度等于整图」时两者才相等；否则每翻转 / 旋转一次，画面就在屏幕上平移 `((old.width - crop.width)/2 - crop.x) * scale`。而这正是**裁剪后才更容易点旋转按钮**的场景（旋转会弹「会清空裁剪」确认框）。

**建议**

```js
const anchorX = view.x + (doc.size.width / 2) * view.scale;
const anchorY = view.y + (doc.size.height / 2) * view.scale;
```

（`toImage()` 里 `view.x` 对应的是裁剪后画面左上角，所以这就是可见中心，不需要再碰 `crop`。）

顺带：`enterBaseEdit()` 仍在「会清空裁剪」确认框**之前**调用（§15.11-2 未修），用户点取消时预览已经被关掉了。

### 16.5 P3：多选整组拖动不处理透视层（quad），会出现「只动一部分 + 多一条撤销步」

`pointermove` 的 `moveLayer` 分支对组内成员统一改 `layer.x / layer.y`（`studio.js:6140-6149`），但 `OverlayLayer` 有 `quad` 时**绘制完全按四点走、忽略 x/y**（`layers.js:272-293`）。于是多选里包含透视层时：其它层动了，透视层原地不动；`movedLayer` 又因为 x/y 变过而落了一条快照（撤销一次看不到画面变化）。

**建议**：组拖动时对 `quad` 层平移四个点（顺便 `_warpCache = null`），或干脆把 quad 层从 `drag.group` 里排除并在光标上体现「不可整组拖动」。旋转 / 翻转已经正确处理了 quad（`studioDoc.js:547-551`、`:615-622`），这里补齐即可。

### 16.6 P3：「主图可选中」缺状态提示，且选中后无法再点一次取消

- PLAN §12.3 要求「顶部常驻提示当前操作对象：主图 / 图层 3 / 已选 4 个图层」，本轮只改了右栏一行说明文字；用户点主图行后，画布上没有任何反馈，右栏属性面板仍显示「未选中图层」，很容易以为按钮坏了（尤其 §16.2/§16.3 的失效场景）。
- `layerPanel` 把主图行的点击从 `selectNone()` 改成了 `selectBase()`（`layerPanel.js:459-463`），于是**再点一次已选中的主图行也无法取消选中**；`selectNone()`（`studio.js:3238-3252`）现在没有任何调用方，成为死代码，`layerPanel.js:6` 的注释也还写着 `selectNone()`。
- PLAN §12.5 要求「主图被选中时，删除 / 方向键要明确禁用或提示」，当前 `Delete` 是静默无反应（`selectedLayerId` 为 null，走不到删除分支）。

**建议**：给主图行做 toggle（已选中 → `selectNone()`）；在主图选中时画一圈画布描边或画布角标；状态栏补「操作对象：主图」；`Delete` 在 `baseSelected` 时给一句提示。

### 16.7 P3：选中主图后，AI「对象」仍停在上一个图层

`selectBaseObject()` 没有调用 `syncAiTargets()`，而 `aiTargetLayer()`（`studio.js:4609-4614`）在 `aiTargetId === '__current__'` 时取 `selectedLayerId || aiTargetLastId`。于是「先选图层 A → 再点主图 → 主体选择 / 送图」仍然只送图层 A，用户以为已经在操作整幅画面。

**建议**：`selectBaseObject()` 里把 `aiTargetId` 归一为 `''`（合成图）并 `syncAiTargets()`；或者让 `aiTargetLayer()` 在 `baseSelected` 时直接返回 null。

### 16.8 P3：图层变换只判断 `preview.image`，漏了「预览加载中」

`transformSelection()`（`studio.js:9608`）用 `preview.image` 拦截 AI 预览，但预览图加载期间 `preview.image === null`、`previewPending === true`（`:3290`）。此时旋转图层会被允许，图加载完后又把刚改过的画面盖住（与 §15.11-4 同类）。改成 `if (preview.image || previewPending)`，或统一复用 `enterBaseEdit()` 的判定。

### 16.9 P3：其它小问题

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `studioDoc.js:579`、`:656`、`:445` | 三处文字分支重复同一套「本地盒中心 + 新角度反算」，且都错（§16.1） | 抽成 `_transformTextAnchor(layer, { pivot, mode, axis })`，或按 §16.1 直接映射锚点，删掉三份重复 |
| 2 | `studioDoc.js:494-506` | `_transformableLayers` 不过滤 `visible === false`；隐藏图层也会被算进 `layersBounds`，多选时轴心被看不见的层拉偏 | 轴心计算用可见图层，变换本身仍可作用于隐藏层（或明确提示） |
| 3 | `studioDoc.js:561-568` | 旋转闭合形状只交换宽高，未同步 `style.gradient.angle` / `style.shadow.angle`，旋转后渐变与投影方向仍是旧的 | 90° 旋转时 `angle += 90`（画布 `_rotateLayersBy90` 同样遗漏，可一次改完） |
| 4 | `studio.js:4067-4091` | 多选虚线框会画在锁定图层上（这些层实际不参与拖动 / 变换） | 跳过 `locked` / 调整层，或用不同颜色区分「选中但不可变换」 |
| 5 | `studio.js:9612` | `ids = selectedLayerIds.size ? [...] : [selectedLayerId]`，当集合里全是已删除 / 被锁定的层时提示语误导为「已锁定或是调整图层」 | 提示拆成「没有可变换的图层」/「选中的图层已锁定」两种 |
| 6 | `studio.js:9623-9628` | 图层旋转后没有 `syncLayersPanel()`，面板里与几何相关的状态（如选中框、复制偏移）可能滞后 | 顺手补一次，代价可忽略 |

### 16.10 本轮确认做得对的点

- **透视层（quad）的旋转 / 翻转**：直接映射四个点并清 `_warpCache`，比改 x/y 正确，也和 `bounds()` 一致。
- **直线 / 箭头**：`rotateLayers` / `flipLayers` 都按两个端点映射，方向不会反（闭合形状才用「中心 + 交换宽高」），这个区分是对的。
- **多选拖动**：`drag.group` 在 `pointerdown` 时冻结每个成员的起点，`pointermove` 只用同一增量；`pointercancel` 也能整组复位，历史与画面不会脱节。
- **Ctrl 点已选图层 = 取消选中**：`beginLayerDrag` 里先判断「加选后是否还在集合里」再决定是否起拖，避免了「想取消选中却把它拖走」。
- **文字镜像绘制**：绕本地盒中心 `scale`、阴影偏移在 `draw` 里按翻转位取反（数据不变，来回翻转可逆），`flipH/flipV` 也进了 `clone()` 与 `layerPropsFor()`，刷新能恢复。
- **无裁剪时**主图旋转的视口稳定性是有效的（`view.scale` 不变、中心不跳），`updateZoomLabel()` 也补上了。

### 16.11 本轮建议补的回归项

1. **文字层连续变换**：选中文字 → 连点两次「向右旋转」→ 文字应原地转 180°，不位移；再点「水平翻转」→ 位置也不变（§16.1）。
2. **画布旋转后翻转**：向右旋转 90°（文字跟着转）→ 水平翻转 → 文字位置与字形镜像都正确（§16.1）。
3. **组选中变换**：选中一个含 3 个图层的组 → 点旋转 → 三个组员绕组中心转，画布尺寸与裁剪不变（§16.2）。
4. **恢复原始图片后的按钮**：恢复 → 点旋转 / 翻转 → 应作用于主图；撤销按钮不应「点了没变化」（§16.3 + §15.4）。
5. **面板删除后旋转**：用文字 / 贴纸 / 形状面板的删除按钮删掉当前层 → 点旋转不应弹「已锁定」提示（§16.3）。
6. **裁剪后旋转**：非居中裁剪成 4:3 → 旋转 90° → 画面中心不应跳（§16.4）。
7. **多选含透视层拖动**：Ctrl 选中普通层 + 透视层一起拖 → 两者位移一致（§16.5）。
8. **主图选中态**：点主图行 → 有明确提示；再点一次主图行可取消（§16.6）。
9. **主图选中后送图**：选中主图 → 主体选择应基于合成图，而不是上一次选中的图层（§16.7）。

### 16.12 建议处理顺序

1. **§16.1** 文字锚点直接映射（三处一起改，附纯几何单测）—— 功能主路径重复操作即错位；
2. **§16.2** 组选中走图层分支 —— 现在会静默改主图；
3. **§16.3** 选择状态收敛到 `setSelection()` + `selectionTarget()` 解析真实图层 —— 顺带修「恢复原始图片后按钮失效」；
4. **§16.4** 视口锚点改 `doc.size` 中心（两行）+ `enterBaseEdit` 挪到确认之后（§15.11-2）；
5. **§16.5 / §16.6 / §16.7** 按顺手程度合并；
6. §16.9 里的 1–3 可与 §16.1 同批，其余按用户反馈排。

---

## 17. 第六轮审查：PS 风格面板逐项（原理 → 实现 → 用户交互）

> 审查对象：`feat/studio-main-image-model` @ `20e7f56`（第 4/5 轮整改已合并，§16 大部分已修并新增 `web/tests/studio/docTransform.test.mjs`）
> 范围：右栏「变换 / 调整 / 文字 / 贴纸 / 形状 / 图层属性 + 历史快照」、左侧图层面板、底部版本槽 / 快门、蒙版与选区条。AI 面板在前几轮（§9–§15）已深度覆盖，本轮只复核它与这些面板的交叉行为。
> 已执行：`node --check`（4 个文件通过）、`node --test web/tests/studio/*.test.mjs`（**140 pass / 0 fail**）；§17.2 的坐标偏移用真实公式做了数值验证（见下），其余交互类结论标注了「静态推演 / 需真机确认」。

### 17.1 总览（按用户影响排序）

| 级别 | 问题 | 涉及面板 |
| --- | --- | --- |
| P1 | 多选后新建文字 / 形状 / 调整层 / 导入图层，选中集合仍是旧图层 → **Delete 删掉的是上一批图层** | 文字 / 形状 / 调整 / 图层栏 |
| P2 | 裁剪后给图层蒙版涂抹、用形状填蒙版，落点整体偏移一个 crop | 蒙版栏 + 图层栏 |
| P2 | 图层蒙版编辑模式下，蒙版栏的百分比 / 清除 / 导出 / 红色色纱仍指向**主图蒙版** | 蒙版栏 |
| P2 | 图层 / 组 / 快照的「双击重命名」在单击全量重建列表后失效；快照双击还会**回跳两次** | 图层栏 / 历史快照 |
| P2 | 快照回跳只清 `selectedLayerId`，多选集合与组选择残留 | 历史快照 |
| P2 | 二次裁剪只能越裁越小，无法把裁掉的区域拉回来 | 变换 |
| P3 | 文字字号 / 描边、贴纸缩放的滑杆上限小于模型上限，换主图放大后滑杆与数值脱节、一拖就跳变 | 文字 / 贴纸 |
| P3 | `编辑主图`、LUT 强度撤销、组选中时滑杆静默改主图、调整层属性面板显示「未选中图层」 | 调整 |
| P3 | 删除「当前版本」会静默把画面切到上一版；版本数量裁剪可能留下悬空的「当前」指针 | 版本槽 / 快门 |
| P3 | 多选时底部不透明度 / 复制只作用于主选；缩略图缓存不含翻转与蒙版内容；文字层越界提示漏报 | 图层栏 |

### 17.2 P1：新建对象没有清空多选集合，Delete 会删掉上一批图层

**用户路径**（PS 心智：图层面板里哪一行是选中态，Delete 就删哪一行）

1. Ctrl 点选图层 A、B（`selectedLayerIds = {A,B}`）；
2. 用文字工具在画布上点一下建文字（`studio.js:5698` 只写 `selectedLayerId = 文字 id`，**没有清集合**）；
3. 面板高亮显示新文字层，按 `Delete`；
4. `removeLayers(selectedLayerIds.size ? [...selectedLayerIds] : [selectedLayerId])`（`studio.js:11345`）优先用集合 → **删掉的是 A、B，新文字层反而留下**。

同一根因的入口还有：拖入 / 粘贴素材（`:1290`）、拖框建形状（`:6316`）、新建调整图层（`:10727`）、局部调整的「画笔蒙版」（`:8640`）、从面板进入图层蒙版涂抹（`:2932`）、涂抹中临时切主选（`:5197`）。

更让人困惑的是**同一屏两个删除入口结果不同**：面板底部「删除」走 `ctx.removeLayer(id)` → `actionLayerIds(id)`，id 不在集合里时只删当前层（行为正确）；而键盘 `Delete` 走集合优先（行为错误）。用户会认为「有时删对了、有时删错了」。

`编辑主图`（`:10738`）也属于这一类：只把 `selectedLayerId` 置空，集合里仍留着调整层 id，于是「编辑主图」后点旋转会弹「选中的图层已锁定」，按 Delete 反而删掉调整层。

**建议**

1. 新增一个不可绕过的选择入口，禁止再直接写 `selectedLayerId`（或至少在写入时同步集合）：

```js
function selectOnlyLayer(id) {
  selectedLayerIds.clear();
  if (id) selectedLayerIds.add(id);
  selectedLayerId = id || null;
  selectedGroupId = '';
  baseSelected = false;
}
```

2. 新建 / 删除 / `编辑主图` / 进入蒙版编辑等路径全部改走它；删除走 `dropLayerFromSelection()` 时**顺带清 `editingLayerMaskId`**（现在没清，删掉正在涂蒙版的贴纸后，下一笔会落到主图蒙版上，见 §17.4）。
3. `Delete` 的取值改成「主选优先，集合兜底」或直接复用 `actionLayerIds(selectedLayerId)`，与面板按钮统一。
4. 单测：纯逻辑层面可覆盖 `removeLayers` 的选择集合，建议补一个「多选 → 新建 → 删除」的回归用例。

### 17.3 P2：裁剪后图层蒙版的涂抹 / 形状落点整体偏移 crop（数值已验证）

`docToLayerTransform()`（`studio.js:5140-5164`）负责「文档坐标 → 叠加层像素坐标」，但平移量多减了一次裁剪原点：

```js
const dx = offsetX - (crop?.x || 0);
const dy = offsetY - (crop?.y || 0);
```

调用方 `stampLayerMask()`（`:5173-5198`）与 `commitShapePaint()`（`:5256-5280`）传进来的 `offsetX/offsetY`、以及画布上的笔触点，**都已经是「旋转后未裁剪」的文档坐标**（`maskPoint()` 专门加过 crop；`fillShape()` 也走 `offsetRect()` 加过 crop）。因此这里再减一次 crop，等于把落点往左上又挪了一个裁剪偏移。

**数值验证**（1000×1000 原图，裁掉左侧 100px，叠加层在文档 x=50，笔触落点文档 (200,100)）：

| 场景 | 期望落点（图层本地） | 实际落点 | 误差 |
| --- | --- | --- | --- |
| 无裁剪 | (150, 100) | (150, 100) | 0 |
| 裁剪 x=100 | (150, 100) | **(50, 100)** | **-100px** |

用户感受：先在 Transform 面板裁掉一条边，再用画笔涂图层蒙版 / 用矩形填蒙版，笔触会落在图层左边 100px 的位置；笔刷半径越大越像「蒙版错位」。裁剪越狠、偏移越大。

**建议**：去掉这两行裁剪减法（`dx = offsetX; dy = offsetY;`）；调整层分支已经是「不加不减」的正确写法，正好说明这里是历史遗留。修完补一个纯数学单测（给定 crop 与图层几何，断言落点），`docTransform.test.mjs` 可以顺手扩。

### 17.4 P2：图层蒙版编辑模式下，蒙版栏仍显示 / 操作主图蒙版

「图层 ✎ 蒙版」或调整层「画笔蒙版」进入涂抹后，底部蒙版条仍然可见，但：

- 状态栏百分比来自 `doc.maskStats()`（`studio.js:8559`），算的是**主图蒙版**；
- 红色色纱来自 `doc.hasMask() / renderMaskTint()`（`:3804`），也是主图蒙版；
- 「清除蒙版」直接 `doc.hasMask()` + 清 `doc.mask`（`:10846`）；
- 「导出蒙版」导出 `doc.maskPng()`（`:10863`）。

也就是说：用户正在涂 A 图层的蒙版，画面里看不到任何红色提示（因为主图蒙版是空的），状态栏永远是「蒙版 0%」；一旦顺手点「清除蒙版」，被清掉的是**主图蒙版**，A 的蒙版毫发无损——但用户会以为清掉了自己正在涂的东西。

**建议**（二选一，推荐 1）：

1. 蒙版栏感知 `editingLayerMaskId`：标题改成「图层蒙版」，百分比 / 色纱 / 清除 / 导出都改读该图层 `mask`（`maskStats` 可加参数或复用 `layer.mask` 扫描）；退出蒙版编辑时恢复主图蒙版语义。
2. 进入图层蒙版编辑时隐藏「清除 / 导出」与主图蒙版百分比，只保留笔刷参数，并用 toast/角标说明「正在编辑图层蒙版」。

### 17.5 P2：双击重命名失效；快照双击还会先回跳两次

- **图层 / 组**：单击会走 `selectLayerById → syncLayersPanel() → layersPanel.render()`，`render()` 每次都重写 `refs.list.innerHTML`（`layerPanel.js:281`）。浏览器的事件顺序是 click → click → dblclick，第二下 click 又触发一次重建，等 `dblclick` 派发时目标节点已经脱离 DOM，`name.replaceWith(input)` 落空 → **重命名输入框不出现**。面板 title 仍写着「双击重命名」，用户会以为坏了（`F2` 能用，但没人会先猜 F2）。
- **历史快照更严重**：`refs.snapshotList` 的 click 直接 `restoreSnapshot()` + `afterSnapshotJump()`（`studio.js:9526-9534`），而 `afterSnapshotJump` 会 `renderSnapshots()` 重建列表。双击 = **回跳两次**（每次还往撤销栈 push 一条），重命名同样不会出现；用户只是想把「快照 3」改个名字，画面却被退回快照内容，属于数据层面的惊吓。
- **快照回跳后的选择状态也没清干净**：`afterSnapshotJump()` 只写 `selectedLayerId = null`（`:9498-9513`），`selectedLayerIds / selectedGroupId / baseSelected / editingLayerMaskId` 都保持原样。回跳相当于一次「状态换血」，旧 id 可能已不存在：此时按 Delete 会把集合里已失效的 id 交给 `removeLayers`（删不到东西），点旋转会走图层分支并弹「已锁定」，图层面板还会高亮一行已经不存在的图层。建议与 §17.2 共用同一个 `clearObjectSelection()`。

**建议**

1. 列表渲染只在「数据签名」变化时重建（id + 名称 + 选中态 + 角标），选中同一条不重建；这同时解决 §15.11-7 的性能问题。
2. 快照跳转加单击/双击区分：`click` 时 `if (event.detail !== 1) return`，或延迟 220ms 执行、`dblclick` 时取消；重命名改为按钮/右键菜单入口更稳。
3. 真机回归：图层名、组名、快照名各双击一次，确认输入框出现且**快照不发生跳转**。

### 17.6 P2：二次裁剪只能缩小，不能把裁掉的区域拉回来

`cropStart` 只做 `setTool('crop')`（`:10977`），进入裁剪后画布仍然是 `doc.size`（已裁剪尺寸），所以能拖的框永远落在当前裁剪内部；`cropApply` 再把 `cropRect` 加上旧 `crop` 原点（`:10986-10995`），语法上正确，但**没有任何路径能向外扩**。PS 的预期是：再进裁剪看到整张图 + 当前裁剪框，四边都能往外拉。

用户遇到「裁多了」时的唯一出路是「清除裁剪」（全撤）或 Ctrl+Z 逐步退，损失中间的其他编辑。

**建议**

1. 进入裁剪时临时按「未裁剪」渲染整图（`draw()` 里对 crop 取 `null`，并把 `cropRect` 预置为当前 `doc.transform.crop`），`cropApply` 不再叠加旧 origin；这样一次性同时支持外扩与内缩，且与 PS 一致。
2. 若本轮不想动渲染路径，至少在裁剪条加一句「二次裁剪只能缩小；需要恢复请点『清除裁剪』」，并把「清除裁剪」放到裁剪条里更显眼的位置。
3. 顺带：裁剪面板没有比例锁定（1:1 / 4:3 / 16:9），对做电商主图的用户是高频缺口。

### 17.7 P3：滑杆上限与模型上限不一致，换主图放大后「数值与滑杆打架」

| 面板 | 控件上限 | 模型上限 | 触发方式 |
| --- | --- | --- | --- |
| 文字字号 | `max=240`（`studio.js:855`） | `TextLayer` 夹到 400（`textLayer.js:105`） | 放大 2× 后 `fontSize *= 2`（`studio.js:7105`），128 → 256 |
| 文字描边 | `max=24` | 40 | 同上，`strokeWidth *= 2` |
| 贴纸缩放 | `max=400%`（`:893`） | `setStickerScale` 允许到 800%（`:8796`） | 画布手柄放大到 600%，或换主图放大 |

表现：`syncTextPane()` 把 `input.value = "256"` 写到 `max=240` 的 range 上，浏览器会把滑块夹到 240，但旁边的数值标签仍显示 256；用户再拖一下滑杆，字号会**突然从 256 跳到 ≤240**。贴纸同理。

另外 `compensateLayersForBase` 直接改 `fontSize / strokeWidth / scale`，没有走构造器夹取；而 `snapshot()` 的 `layer.clone()` 会重新夹到上限，于是「放大 → 改字 → 撤销」可能让字号变小（§15.11-2 仍未修）。

**建议**：把「模型上限」作为唯一来源（`max = MODEL_LIMIT`），`compensateLayersForBase` 内做夹取，`sync*Pane` 用同一个值渲染标签与滑块；或把字号滑杆改成「按当前主图缩放动态换算」的百分比。

### 17.8 P3：调整面板的状态细节

1. **`编辑主图` 只清主选**（`:10737-10741`）：不改集合 / 组 / `selectedLayerIds`，也不 `syncLayerProps()`。后果见 §17.2（旋转报「已锁定」、Delete 删掉调整层、图层面板仍高亮）。
2. **LUT 强度不可撤销**：`snapshot()` 里 `adjust: { ...this.adjust }` 是浅拷贝，`doc.adjust.lut` 是同一个对象引用；`lutStrength` 的 input 直接改 `lut.strength`（`:10798`），而 `change` 才 snapshot（`:10811`）——历史里所有状态共享同一个 lut 对象，撤销后强度仍是新值。数值滑杆没这个问题（基本类型被展开复制）。建议 snapshot/restore 时把 `lut` 复制成 `{ ...lut, strength }`（`cube` 可共享，别整块深拷贝）。
3. **选中图层组时滑杆静默改主图**：`adjustmentTarget()` 只看 `selectedLayerId`（`:8567`），组选中时为 null → 滑杆改 `doc.adjust`，但右栏没有任何「正在编辑主图」的提示（只有进入调整层才有提示条）。用户选中组后拖曝光，画布变了但他以为改的是组。
4. **调整层的图层属性显示错**：`layerPropsTarget()` 对 `isAdjustment` 返回 null（`:9182`），于是选中调整层时「图层属性」折叠头显示「未选中图层」、混合模式禁用；而底部不透明度滑杆其实可以改这个层。至少应显示层名 + 类型「调整图层」，混合模式要么支持，要么明确写「调整层暂不支持」。
5. **加载 LUT 不退出 AI 预览**（`:10765-10785`）：强度滑杆会 `enterBaseEdit()`，加载却不会；预览开着时加载 LUT 改的是看不见的底图。

### 17.9 P3：版本槽 / 快门的交互

1. **删除「当前版本」会静默切换画面**：`deleteVersion` 先 `switchVersion(prev)` 再删除（`:7422-7428`），确认框只写「该版本的原始图会从本机移除」，没写「画面会切到上一版」；`switchVersion` 失败（blob 不在本机）时仍继续删除，`currentVersionId` 悬空、Dock 里没有任何卡是「当前」。
2. **版本裁剪可能裁掉当前卡**：`recordVersion` 里 `trimStudioVersions(..., keepId: id)` 只保证新卡保留（`:6911`）。如果用户点开一张旧卡再连拍，最旧的「当前卡」可能被裁掉，指针悬空。
3. **卡面尺寸与缩略图可能不一致**：默认用 `current.sourceSize`（未旋转）记录宽高（`:6890`），而缩略图是旋转 / 翻转后的观感；旋转 90° 拍的卡，hover 提示的宽高会和图像方向相反（快门卡显式传了 `size`，所以主要是 AI 入槽卡）。

### 17.10 P3：图层面板的细节

1. **多选时批量操作不统一**：上移 / 下移 / 显隐 / 锁定走 `actionLayerIds()`（整组生效），但底部「不透明度」「复制」「重命名」只用主选（`layerPanel.js:163-167`、`studio.js:2791`）。多选两根图层后拖不透明度，只有一根变化，用户会以为另一根坏了。
2. **缩略图缓存 key 缺维度**（`studio.js:1400-1402`）：只有 `scale / rotation / 有无蒙版`，不含 `flipH / flipV` 与蒙版内容。翻转贴纸、涂抹蒙版后，面板缩略图保持旧图，直到缩放或旋转变化才刷新。
3. **越界提示不可靠**：`isLayerOutside()` 用 `layer.width/height` 和未旋转的 x/y（`:3243-3251`）。文字层没有 `width`（按 0 算）→ 文字越界不提示；旋转过的贴纸越界也可能漏报。
4. **组行不能拖动排序、不能锁定**（`layerPanel.js:634-640` 明确跳过组行），多选也不能整组拖拽排序 —— 与用户对 PS 图层面板的预期有差距（可作为后续迭代项）。

### 17.11 P3：面板功能缺口（非 bug，供产品排期）

| 面板 | 缺口 | 用户影响 |
| --- | --- | --- |
| 文字 | 无对齐（左/中/右）、行距、字距；投影只有模糊，没有偏移 / 颜色；不能在画布上双击直接编辑文案 | 做海报 / 封面时基本要回面板反复调 |
| 形状 | 无旋转输入、无渐变角度 / 阴影角度 / 虚线；样式不能多选批量改 | 多形状统一风格成本高 |
| 贴纸 | 透视模式下缩放 / 旋转 / 翻转被禁用但提示只在「说明」里；无「适应画布 / 原始比例」 | 用户会以为控件坏了 |
| 变换 | 无宽高 / 角度数值输入；文字与形状没有画布缩放手柄（只能改 fontSize / 宽高字段） | 精确排版困难 |

### 17.12 本轮确认做得对的点

- **调整面板**：滑杆拖动走低分辨率代理 + `change` 落快照；调整层参数与主图调色分离；调整层蒙版走文档坐标（`docToLayerTransform` 的特例），涂抹位置正确。
- **局部调整**：渐变只在松手时重建蒙版，过渡曲线可调，`localClear` 与退出涂抹的状态清理是对的。
- **LUT**：不写入工程 session（避免几十 MB 的立方体进入存储），刷新后要求重新加载，取舍合理。
- **历史快照**：回跳前先 `snapshot()` 当前状态，所以跳转本身可撤销；快照超 20 张有明确提示；裁剪 / 换主图后按 `baseId` 拒绝旧快照。
- **快门**：缩略图在 `await` 编码前同步画好，编码期间拖动图层不会污染缩略图；只存主图（§16 之前的问题保持修复）。
- **裁剪框**：DOM 覆盖层只写样式，不重绘画布，4K 下手感明显更好。
- **图层面板**：显隐 / 锁定 / 删除都区分了「多选批量」与「主选」，蒙版 chip 与 `editingLayerMaskId` 的高亮同步；组折叠会清掉组员选择，避免「选中看不见的层」。
- **§16 整改复核**：文字旋转 / 翻转的三处公式改为「真实视觉中心 + 反向角度反算」，新增 `docTransform.test.mjs`；组选中走图层分支；`pointercancel` 覆盖几何类；重置后选择清理；主图行可再次点击取消；这些都已落地。

### 17.13 本轮建议补的回归项

1. **多选后新建对象再删**：Ctrl 选 A+B → 建文字 / 画形状 / 新建调整层 → 按 Delete，只能删掉当前新建对象（§17.2）。
2. **裁剪 + 图层蒙版**：裁剪左边 100px → 给贴纸涂图层蒙版 → 笔触应与光标重合（§17.3）；同样验证矩形 / 套索填蒙版。
3. **图层蒙版状态栏**：进入贴纸 ✎ 蒙版涂抹 → 状态栏百分比、红色色纱、「清除蒙版」都应作用于该贴纸蒙版；清除后主图蒙版保持不变（§17.4）。
4. **双击重命名**：图层名、组名、快照名各双击一次 → 输入框出现；快照不得发生回跳（§17.5）。
5. **快照回跳后的选择**：多选 A+B → 存快照 → 再改 → 回跳 → 按 Delete / 点旋转，不应作用到已不存在的旧层（§17.5 后续）。
6. **裁剪外扩**：裁剪成 4:3 → 再进裁剪，应能把边拉回去（或看到明确说明）（§17.6）。
7. **放大后的文字面板**：带 128px 文字 → 放大 2× → 选文字，滑杆位置与数值标签是否一致；拖一下是否跳变（§17.7）。
8. **调整面板**：选组 → 拖曝光，观察是否有「编辑主图」提示；加载 LUT → 改强度 → 撤销，强度应回退（§17.8）。
9. **版本删除**：删当前版本 → 确认框是否说明会切到上一版；删除后 Dock 必须仍有一张「当前」卡（§17.9）。
10. **图层缩略图**：翻转贴纸 / 涂抹蒙版后，图层面板 32px 缩略图应刷新（§17.10）。

### 17.14 建议处理顺序

1. **§17.2**（选择集合收敛 + Delete 取值统一）—— 唯一会「删错图层」的问题；
2. **§17.3**（去掉 crop 双减，补单测）—— 一行改动 + 可验证；
3. **§17.4**（蒙版栏感知图层蒙版）—— 避免误清主图蒙版；
4. **§17.5**（列表按签名重建 + 快照单击/双击区分）—— 同时解决重命名与 §15.11-7 性能；
5. **§17.6**（裁剪外扩，按「进入裁剪显示整图」重做）—— 需要动渲染分支，单独提交；
6. **§17.7 / §17.8**（上限统一、LUT 撤销、编辑主图清理）按顺手程度合并；
7. §17.9 / §17.10 / §17.11 归入下一轮体验优化。
