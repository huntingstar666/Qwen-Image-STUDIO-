# 历史分类 / 高清预览 / 图像编辑回退：方案与实施计划

> 状态：**P1 高清预览、P2 历史分类已完成并实测通过**；P3/P4（编辑回退与遮罩还原）待实施。  
> 关联文档：[WEB_UI.md](WEB_UI.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[BUILD_CONTRACT.md](BUILD_CONTRACT.md)。  
> 范围：`web/src/components/history.js`、`gallery.js`、`materials.js`、`lightbox.js`、`handoff.js`、`edit.js`，以及 `server/pipeline.py`（仅补遮罩留档）。

## 0. 结论摘要

| 需求 | 现状 | 方案 | 复杂度 |
|---|---|---|---|
| 作品画廊 / 素材仓库高清预览 | 已有通用高清大图查看器 `lightbox.js`，但只有编辑页右侧历史在用；画廊与仓库详情只是普通 `<img>` | 复用 `openLightbox`，详情图可点开、增加「高清预览」入口，并补一个「1:1 实际像素」按钮 | 低 |
| 历史分类 | 后端 `kind` 已经区分 `t2i / edit / upscale / gif / segment`；前端历史页只写死了「全部 / 文生图 / 图像编辑」，且把所有非 `edit` 都显示成「文生图」；「精修工程」是独立区块，不在分类里 | 新增一份前端类型注册表，分类 chip 由注册表生成；精修工程作为虚拟分类并入同一套筛选；标签按 `kind` 正确显示 | 低~中 |
| 图像编辑回退 | 历史详情只能看结果；编辑任务的输入图已存 `meta.input_urls`，`replay.json` 有完整参数；遮罩只留在任务参数里、结束后被瘦身，无法还原；交接槽只支持图片/遮罩/指令/任务模式 | 历史详情新增「回到图像编辑」：取回输入图 + 完整参数 + 新任务遮罩留档，走扩展后的交接槽回填编辑页 | 中 |
| 放大被记成文生图 | 后端提交的确实是 `kind="upscale"`，是前端标签与筛选把它归到了文生图 | 注册表补 `upscale=高清放大`，并按 `kind` 生成标签/筛选/收藏类型 | 低 |

**总体判断：不复杂。** 高清预览和分类是低风险改动；回退功能的主要工作量在「编辑页参数回填」，属于中等复杂度，但只要按下面的映射表逐项落位即可，不需要改 `/api/edit` 契约。

## 1. 现状核查

### 1.1 高清预览

- 通用查看器已经存在：[lightbox.js](../../web/src/components/lightbox.js) 支持滚轮缩放、拖拽平移、多图切换、下载与新窗口打开原图。
- 目前只有编辑页右侧历史胶囊使用它：[historyRail.js](../../web/src/components/historyRail.js#L86-L97)。
- 作品画廊详情是静态 `<img>`：[gallery.js](../../web/src/components/gallery.js#L349-L466)，图片受容器 `max-height` 限制，无法放大看细节。
- 素材仓库详情同样是静态 `<img>`：[materials.js](../../web/src/components/materials.js#L480-L604)。
- `lightbox` 的缩放是「相对适应窗口后的显示尺寸」，没有「按原图 1:1 实际像素」入口，严格意义上还不算高清预览。

### 1.2 历史分类

- 后端任务类型是真实的：`/api/generate` → `t2i`，`/api/edit` → `edit`，`/api/image/upscale` → `upscale`（[main.py](../../server/main.py#L1388-L1394)），GIF → `gif`，主体分割 → `segment`。
- 历史接口只回 `to_summary()`，其中 `kind` 原样返回（[jobs.py](../../server/jobs.py#L129-L149)）。
- 前端历史页硬编码了三个 chip，并把非 `edit` 一律渲染成「文生图」（[history.js](../../web/src/components/history.js#L34-L57)、[history.js](../../web/src/components/history.js#L273)）。
- 「精修工程」现在固定显示在任务列表上方，不受分类 chip 控制（[history.js](../../web/src/components/history.js#L47-L56)）。
- 历史页只拉 60 条（[history.js](../../web/src/components/history.js#L26)），但后端历史上限是 200；分类计数可能因截断而不准。

### 1.3 图像编辑回退

- 编辑任务的输入图已经落盘并写入 `job.meta.input_urls`（[pipeline.py](../../server/pipeline.py#L1078-L1084)）。
- `replay.json` 会返回瘦身后的完整请求参数（图片 data URL 变成占位符），足以还原预设、任务模式、尺寸、采样、LoRA、Turbo 等字段（[main.py](../../server/main.py#L1061-L1076)）。
- 遮罩没有单独留档：它只在 `params.mask.data` 里，任务结束后被 `slim_params` 替换成占位符（[jobs.py](../../server/jobs.py#L29-L47)、[jobs.py](../../server/jobs.py#L235-L240)）。
- 现有交接槽只支持 `images / mask / prompt / localEnabled / taskMode / panorama`（[handoff.js](../../web/src/handoff.js#L15-L39)），还不够带回采样与预设参数。
- 编辑页已有成熟的接收入口 `applyHandoff()`（[edit.js](../../web/src/components/edit.js#L3111-L3180)）和完整的控件 `setValue()`（Turbo / LoRA），可以在其上扩展，不需要重写。

## 2. 方案设计

### 2.1 高清预览（画廊 / 素材仓库）

**复用而不是新写查看器。**

1. 扩展 [lightbox.js](../../web/src/components/lightbox.js)：
   - 工具栏增加「1:1」按钮：按图片 `naturalWidth / 当前渲染宽度` 计算缩放倍率，切到原图实际像素；
   - 工具栏显示原始像素尺寸（已有 `width/height`，缺失时用 `naturalWidth/naturalHeight` 回填）；
   - 保留 Esc / 方向键 / 滚轮 / 双击 / 拖拽，不改现有调用方。
2. 作品画廊 [gallery.js](../../web/src/components/gallery.js)：
   - 详情大图点击 → `openLightbox([{url:item.image, width, height}])`；
   - 详情弹窗底部动作区新增「高清预览」（primary/ghost 均可）；
   - 卡片 hover 动作保留「查看」，双击封面也可直接进高清预览（可选，低成本）。
3. 素材仓库 [materials.js](../../web/src/components/materials.js)：
   - 详情图使用原图 `image.url`（不是 `thumbUrl`）打开 `openLightbox`；
   - 详情动作区新增「高清预览」；
   - 参考图缩略图点击进入同一个 lightbox（多图时可左右切换）。
4. 样式：仅补 `gallery-detail` / `lib-detail-media img` 的 `cursor: zoom-in` 与一个「点击查看高清大图」提示，不调整现有布局。

> 不新建页面、不引入第三方查看器，避免重复能力。

### 2.2 历史分类

**新增一份唯一注册表，页面按注册表渲染。**

新增 `web/src/data/historyKinds.js`：

```js
export const HISTORY_KINDS = [
  { id: 'all',      label: '全部',     source: 'all' },
  { id: 't2i',      label: '文生图',   source: 'job' },
  { id: 'edit',     label: '图像编辑', source: 'job' },
  { id: 'upscale',  label: '高清放大', source: 'job' },
  { id: 'gif',      label: '动图',     source: 'job' },
  { id: 'studio',   label: '精修工程', source: 'project' },
];

export const KIND_LABELS = Object.fromEntries(
  HISTORY_KINDS.map((item) => [item.id, item.label]),
);
```

要点：

1. 历史页 chip 全部由 `HISTORY_KINDS` 生成，数量徽标实时统计；`studio` 的数量来自 IndexedDB 工程列表。
2. `source` 决定筛选对象：
   - `all`：精修工程区块 + 任务列表都显示；
   - `studio`：只显示精修工程区块；
   - `job`：只显示对应 `kind` 的任务卡片，并隐藏工程区块。
3. 任务卡片标签按 `KIND_LABELS[item.kind]` 显示，未知类型回落「其他」，不再默认「文生图」。
4. 详情弹窗标题同样按注册表生成（文生图记录 / 图像编辑记录 / 高清放大记录…）。
5. 收藏映射改为按 `item.kind` 取值；`favorites.js` 的 `KIND_LABELS` 增补 `upscale: '高清放大'`，`materials.py` 的 `KINDS` 同步加入 `upscale`，素材仓库筛选 chip 自动多一项。
6. 历史页拉取上限从 60 调整为 200（后端允许的最大值），保证分类计数与筛选覆盖完整历史；如后续历史量继续增长，再改为后端 `?kind=` 过滤。
7. 「全部」视图给两个区块加小标题（「生成与编辑」「精修工程」），避免混排后看不出边界。

### 2.3 图像编辑一键回退

**目标动线**：历史 → 图像编辑记录 → 详情 → 「回到图像编辑」→ 编辑页自动带回输入图、遮罩（新任务）、指令、预设与关键参数。

#### 2.3.1 后端：补遮罩留档

在 [pipeline.py](../../server/pipeline.py#L1055-L1066) 解析出遮罩后，额外保存一份遮罩 PNG：

```python
job.meta["mask_url"] = storage.save_upload(mask_bytes, ext=".png", orig_name="mask.png")["url"]
```

- 只影响新任务；旧记录没有 `mask_url`，回退时按「无遮罩」处理并提示。
- 不改变 `/api/edit` 契约，也不把 data URL 写回历史。

#### 2.3.2 前端：交接槽扩展

在 [handoff.js](../../web/src/handoff.js) 的 `setHandoff` 增加可选 `restore` 字段（只做透传，不改现有调用方）：

```js
restore: {
  preset, taskMode, negativePrompt,
  sizeMode, width, height, ratio, megapixels, fit, padMode,
  sampling: { steps, cfg, denoise, sampler, scheduler },
  turbo: { enabled, profile },
  loras, consistency_lora,
  overrides, local,
  seed, seedMode,
}
```

#### 2.3.3 前端：历史详情新增回退动作

在 [history.js](../../web/src/components/history.js#L390-L426) 详情弹窗的动作区，对 `item.kind === 'edit'` 增加「回到图像编辑」：

1. 读取 `item.meta.input_urls`；没有则回退用结果首图（提示「原输入图缺失，已用结果图继续编辑」）。
2. 逐个把 `/files/...` 转 data URL（复用 `studio/chain.js` 的 `imageUrlToDataUrl`）。
3. 请求 `/api/jobs/{id}/replay.json` 取完整参数；失败时只用历史摘要里的 `width/height/seed/steps/cfg`。
4. 读取 `item.meta.mask_url`，有则转 data URL 一起带上。
5. 组装：

```js
setHandoff({
  images: [{ dataUrl, name }...],
  mask: maskDataUrl || null,
  prompt: replay.params.prompt || item.prompt,
  taskMode: replay.params.task?.mode || null,
  restore: { ...replay.params },
  toast: '已带回图像编辑，可调整参数后重新生成',
});
goToEditPage();
```

#### 2.3.4 前端：编辑页接收参数

在 [edit.js](../../web/src/components/edit.js#L3111-L3180) 的 `applyHandoff()` 末尾增加 `applyRestore(payload.restore)`：

| replay 字段 | 落位 |
|---|---|
| `prompt` / `negative_prompt` | 指令框 / 反向提示词 |
| `preset` + `task` + `local` + `zero_shift` 等 | `edit.overrides`，复用 `withOverride` / `nestOverrides` 反向拆平 |
| `size_mode` / `width` / `height` / `ratio` / `megapixels` / `fit` / `pad_mode` | 尺寸面板与 `edit.*` |
| `steps` / `cfg` / `denoise` / `sampler` / `scheduler` / `seed` | 采样控件（含 `seedMode='fixed'`） |
| `turbo` | `turboControl.setValue()` |
| `loras` / `consistency_lora` | `loraPicker.setValue()` 与一致性开关 |
| `mask_url` | 第 1 张图的 `mask`，并计算覆盖率 |

应用后统一刷新：`renderModeRows / renderPresets / renderTaskMode / syncLocalControls / advanced.refresh / updateMaskStatus / syncSeedUi`，并给出 toast。

**降级规则**：
- 预设已不存在或版本变化：保留能识别的字段，忽略未知 key，提示「部分参数因预设变化未还原」；
- 参数值越界（steps / cfg / scale）：按页面现有上下限夹紧；
- 旧任务无遮罩、无 `input_urls`：不阻断，用结果图或空遮罩继续。

### 2.4 不在本次范围

- 文生图历史的「回填到文生图」：现有 `setT2IHandoff` 已能带提示词/尺寸/种子，可作为后续独立小改动。
- 把历史任务直接恢复成「精修工程」：两者数据模型不同（任务是一次性请求，工程是图层文档），不做隐式转换。
- 后端历史按 `kind` 分页/过滤：当前 200 条足够，先不扩接口。

## 3. 影响文件清单

| 文件 | 改动 |
|---|---|
| `web/src/data/historyKinds.js` | 新增：历史类型唯一注册表 |
| `web/src/components/history.js` | 分类 chip 数据驱动、精修工程并入筛选、标签修正、回退动作 |
| `web/src/components/gallery.js` | 详情接入 `openLightbox` + 高清预览入口 |
| `web/src/components/materials.js` | 详情/参考图接入 `openLightbox` + 高清预览入口 |
| `web/src/components/lightbox.js` | 增加 1:1 实际像素按钮与原始尺寸显示 |
| `web/src/components/favorites.js` | `KIND_LABELS` 增补 `upscale` |
| `web/src/handoff.js` | `setHandoff` 增加可选 `restore` 透传 |
| `web/src/components/edit.js` | 新增 `applyRestore` 并接入 `applyHandoff` |
| `web/assets/css/library.css` | 详情图 `cursor: zoom-in` 与预览提示 |
| `server/pipeline.py` | 遮罩 PNG 留档 `meta.mask_url` |
| `server/materials.py` | `KINDS` 增补 `upscale` |
| `docs/WEB_UI.md` / 本文件 | 能力与验收记录回写 |

## 4. 风险与边界

1. **旧记录不可追溯**：`mask_url` 只对新任务生效；旧编辑记录回退时无遮罩，属预期降级。
2. **输入图可能被清理**：`input_urls` 指向 `storage/uploads`，若用户手动清理文件，回退会失败并给出中文提示。
3. **预设漂移**：历史任务使用旧预设版本，参数回填以「显式值优先」为原则，不强行套用当前预设默认值。
4. **历史截断**：任务上限 200，超出后最旧记录不可回退；分类计数以当前可加载范围为准。
5. **画廊外链**：当前画廊封面全部是本地 `/assets/gallery/*.webp`，同源可预览；若以后接外链，lightbox 仍可用，但下载可能受跨域限制。
6. **不改接口契约**：回退只读 `/api/jobs/{id}/replay.json` 和历史字段，不新增写接口，避免影响第三方调用。

## 5. 验收清单

**A. 高清预览**
- 作品画廊详情：点图 / 点「高清预览」打开查看器，滚轮缩放、拖拽、1:1、下载、原图正常。
- 素材仓库详情：原图而非缩略图进入查看器；参考图可切换；关闭后页面状态不变。

**B. 分类**
- 分类 chip 顺序为：全部、文生图、图像编辑、高清放大、精修工程（后续新增只需改注册表）。
- 高清放大记录显示「高清放大」，不再显示「文生图」，且只出现在「全部 / 高清放大」。
- 图像编辑记录只在「全部 / 图像编辑」。
- 「精修工程」分类只显示工程卡片；「全部」同时显示工程与任务，且分区标题清楚。
- 各分类计数与列表数量一致。

**C. 回退**
- 新编辑任务：历史 → 回到图像编辑，输入图、遮罩、指令、预设、尺寸、采样、Turbo、LoRA 与任务一致，可直接重新提交。
- 旧编辑任务（无遮罩）：图片与指令正常回填，提示遮罩未还原。
- 输入图缺失：给出明确提示并降级为结果图继续编辑，不白屏、不静默失败。
- 回填后修改任一参数再提交，结果符合预期，不出现参数串台。

**D. 回归**
- `pytest` 全绿；前端 `node --check` / 现有 `web/tests/studio/history.test.mjs` 通过。
- 历史页加载、清空、删除、收藏、下载、导出 replay 不受影响。
- 编辑页原有「图像处理 → 送入图生图」「素材仓库 → 图生图小仓库」交接不回归。

## 6. 实施顺序

1. **P1 高清预览**（低风险，先交付）：lightbox 1:1 → 画廊 → 素材仓库。**已完成**
   - `lightbox.js` 增加「1:1」实际像素与原始尺寸显示；画廊详情图/「高清预览」按钮、素材仓库详情图/参考图均已接入。
   - Playwright 实测：画廊与素材仓库均可打开查看器，工具栏含「1:1」，素材使用原图而非缩略图。
2. **P2 分类注册表**（低风险）：historyKinds → 历史页 chip/区块 → 标签/收藏类型 → 放大分类。**已完成**
   - 新增 `web/src/data/historyKinds.js`；历史页分类为：全部 / 文生图 / 图像编辑 / 高清放大 / 精修工程（主体分割保留标签但不单独占 chip）。
   - 实测 chip 计数为 全部 152 / 文生图 18 / 图像编辑 51 / 高清放大 8 / 精修工程 1；选中精修工程时只显示工程区块，选中高清放大时只显示 8 条放大记录。
3. **P3 回退基础版**（中风险，待实施）：交接槽扩展 → 历史动作 → 编辑页回填（输入图 + 指令 + 主要参数）。
4. **P4 回退完整版**（待实施）：遮罩留档（后端）→ 遮罩回填 → 旧记录降级提示。
5. 每步完成后单独提交，并同步回写 `docs/WEB_UI.md` 与本文档的验收结论。

## 7. 已确认的决策

1. 「高清放大」作为独立分类（已落地）。
2. 「精修工程」并入分类 chip，选中时只显示工程（已落地）。
3. 历史页拉取上限 60 → 200（已落地）。
4. 回退是否要求遮罩也还原：推荐新任务还原、旧任务降级并提示，待 P3/P4 实施时最终确认。
