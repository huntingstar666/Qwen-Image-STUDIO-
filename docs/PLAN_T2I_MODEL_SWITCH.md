# 文生图模型切换（Qwen-Image 2.1 / MOSS-Image）+ 边界框布局：设计与实施计划

> 状态：**已实施（P0~P6 落地）**。后端 3 处可观测性改动 + 前端模型切换 / 默认值提示 / Turbo·SLG / 边界框设计器 / 润色对接均已完成；手动验收见第 7 节。
> 关联文档：[INFERENCE.md](INFERENCE.md)、[PROMPT_POLISH.md](PROMPT_POLISH.md)、[WEB_UI.md](WEB_UI.md)。

## 0. 结论摘要（先看这段）

- 后端能力已经齐了：`/api/generate` 支持 `model` / `bbox` / `slg` / `turbo.lora`，切模型时自动卸载另一套权重。**前端一行 `model` 都没传**，所以 MOSS 目前只是「接口可用、界面不可达」。
- 本轮前端只改**文生图页**：模型 pill 切换、高级设置按模型重绘、MOSS 专属参数（默认值提示）、边界框设计器。
- 图生图/编辑页不动：MOSS `capabilities.edit=false`，后端已硬拒。
- 显存策略保持「单模型常驻 + 按需切换」：前端切换**只改参数不加载权重**，点生成才换；任务运行中禁止切换。
- 额度：后端 3 处小改（`models.public_list` 补 `turbo`/`samplers`、`config.SAMPLERS` 补 `er_sde`、`health.engine` 暴露 `model`），其余全在前端。

## 1. 目标与边界

### 1.1 目标

1. 文生图页可在 **Qwen-Image 2.1** 与 **MOSS-Image (sft)** 之间切换。
2. 切换后高级设置区展示该模型的参数，并明确标出**默认值**与「当前是否已偏离默认」。
3. MOSS 支持 **Turbo（8 步 LoRA）**、**SLG**、**边界框布局**三个能力开关。
4. 边界框设计器在文生图页内完成绘制、编辑、校验，请求直接带 `bbox.items`。
5. 显存不出现双模型常驻；切换与加载时机对用户可见。

### 1.2 非目标（本轮明确不做）

- MOSS 参考图编辑（后端未接，`encode_text` 传图直接报错）。
- 编辑页的模型切换；编辑页继续固定 Qwen。
- 边界框的「模板商城」、图层面板、旋转/层级。
- 多任务并发（仍单 worker 串行）。
- 重写 `t2i.js`；只在现有结构上增量插入。

## 2. 现状盘点

### 2.1 后端已具备（无需改协议）

| 能力 | 入口 | 说明 |
|---|---|---|
| 模型档案 | `GET /api/options.model_profiles` | 含 `defaults` / `accelerator` / `slg` / `capabilities` / `files` / `missing` / `ready` |
| 模型切换 | `POST /api/generate` 的 `model` | `qwen` / `moss`，非法值返回 `bad_model` |
| 边界框 | 同上 `bbox` | `{enabled, canvas?, character_boxes?, items:[{x,y,w,h,type,text,desc,palette}]}` |
| SLG | 同上 `slg` | `{enabled, single_layers, double_layers, start_percent, end_percent}` |
| Turbo | 同上 `turbo` | `{enabled, profile?, lora?, lora_strength?}`；`turbo.lora="none"` 可关 MOSS 加速 LoRA |
| 润色 | `POST /api/polish` | 已支持 `image_model` / `target_size` / `references` / `images` |
| 显存 | `Pipeline._engine_for` | 切模型时对其余已加载引擎 `free(unload=True)`；空闲 30 分钟自动卸载 |

### 2.2 前端缺口

| 位置 | 现状 | 影响 |
|---|---|---|
| `web/src/components/t2i.js:1044 collectPayload()` | 不传 `model` | 永远落到 `config.model=qwen` |
| `web/src/store.js:11 DEFAULT_T2I` | 无模型字段 | 刷新丢选择 |
| `t2i.js:1046 snapUp(width)` | 写死 32 倍数 | MOSS `snap=16`，会多对齐一档 |
| `t2i.js` 采样器下拉 | 取 `/api/options.samplers` | 该表**没有 `er_sde`**，MOSS 默认采样器无法显示 |
| `t2i.js:789 renderTurbo()` | 只用全局 `turbo_profiles`（Qwen 的 sigma 方案） | MOSS 的 LoRA 型加速没有预设可选 |
| 高级设置各区块 | 全部按 Qwen 渲染 | 透明背景、姿态对 MOSS 无效 |
| 润色 `polish.js:44` | 只传 `prompt/mode/model/target_size/pose` | 未传 `image_model`，MOSS 仍用 Qwen 的 PE |
| 边界框 | 无任何 UI | 只能手写 JSON |

### 2.3 现有 UI 结构（改造锚点）

- 高级设置抽屉：`t2i.js:67-148`（`aside.wb-adv`，区块为 `section.panel` 与 `details.fold`）。
- 采样参数面板：`t2i.js:97-126`（`data-ref="steps" / "cfg" / "sampler" / "scheduler" / "turboHost"`）。
- 底部 pill 栏：`t2i.js:194-253`（尺寸 / 批量 / 种子 / 姿态 / Turbo / 透明背景 / 生成）。
- 抽屉与 pill 的显隐联动：`renderTurbo()`、`renderModels()`、`renderLoras()` 等函数，统一由 `refreshAll()`(t2i.js:964) 触发。
- 可复用样式：`wb-pill`、`size-pop`、`panel`、`field`、`tag-hint`、`chips`、`switch`、`fold`、`badge-mini`。

## 3. 前端设计

### 3.1 模型切换入口

**位置**：pill 栏最左侧新增「模型」pill，紧邻「尺寸」之前。

```
[模型 MOSS-Image ▾] [尺寸 3:4 · 1536×2048] [批量] [种子] [姿态] [Turbo] [布局] [透明背景] [生成]
```

- 结构复用尺寸 pill 的 `wb-size-anchor + size-pop` 模式 → `wb-model-anchor + model-pop`。
- 弹出面板为两行卡片：

| 卡片 | 主文案 | 副文案 | 状态 |
|---|---|---|---|
| Qwen-Image 2.1 | 全能：文生图 + 参考图编辑 | 25 步 · CFG 4 · 支持透明背景 | 已驻留 / 未加载 |
| MOSS-Image (sft) | 文生图：出字准、8 步可加速 | 50 步 · CFG 3.5 · 支持布局框 | 已驻留 / 未加载 / 缺失文件 |

- 数据源：`store.state.options.model_profiles`；`ready=false` 或 `missing` 非空时卡片置灰并显示缺失文件名。
- 当前模型来自 `state.t2i.model`；首次为 `null` 时取 `options.default_model`。
- 交互：
  - 切换即写入 `state.t2i.model`，并 `patchSettings({ t2i: { model } })` 持久化。
  - **不触发加载**；只更新 UI 与后续请求参数。
  - 任务 `running/queued` 时 pill 加 `disabled`，title 提示「任务进行中，完成后再切换」。
- 切换后 toast：
  - 首次切到 MOSS：「已切换 MOSS-Image；下次生成将加载约 20GB 权重（首次约 30~60s）」
  - 若后端 `health.engine.model` 是另一个模型：「已切换；生成前会先卸载当前模型」

### 3.2 能力联动（以 `capabilities` 为准，不按 id 硬编码）

| 控件 | qwen | moss | 规则 |
|---|---|---|---|
| 透明背景 pill | 可用 | **隐藏** | `capabilities.rgba` |
| 姿态 pill / 姿态块 | 可用 | **隐藏** | `capabilities.rgba`? 否——用 `profile.id==='qwen'`（姿态是 Qwen 专用 LoRA 链路） |
| 布局 pill | 隐藏 | 可用 | `capabilities.bbox` |
| 步数预设 chips | 8 / 25 / 40 | 50 / 8(Turbo) | 由 profile 提供或前端按模型映射 |
| 采样器下拉 | 全量 | `er_sde` / `euler` | `profile.samplers`（后端新增） |
| 调度器下拉 | 全量 | `simple` | 同上，默认 simple |
| 尺寸倍数 | 32 | 16 | `profile.snap` |
| 默认尺寸 | 2048²（沿用现有） | 1024² | `profile.defaults` |
| 负向默认 | 空 | `bad quality,` | 空串/null 语义见 3.3 |

切换模型时**清理不兼容字段**：`rgba=false`、`pose=null`、`bbox` 在 qwen 下不发送且清空本地状态（保留在 `byModel.moss` 里，切回不丢）。

### 3.3 高级设置按模型重绘

抽屉顶部新增「当前模型」条（不折叠）：

```
MOSS-Image (sft)   ·  50 步 · CFG 3.5 · er_sde   [恢复 MOSS 默认]
moss_image_sft_bf16 · qwen3.5_9b_int8 · flux2-vae
```

区块顺序（MOSS）：

1. **画面尺寸**（倍数提示改 16；摘要「自动向上对齐到 16 的倍数」）
2. **采样参数**（步数 / CFG / 采样器 / 调度器 / Turbo / SLG）
3. **边界框布局**（入口 + 已画 N 个框 + 清空）
4. **高级：模型与 LoRA**（unet/clip/vae 只读；LoRA 可多选并设强度）
5. **当前参数摘要** + 重置

#### 默认值提示规则（统一的三种状态）

| 状态 | 表现 | 示例 |
|---|---|---|
| 未改动 | 输入框 `placeholder` = 默认值；label 后 `tag-hint` 显示「默认 50」 | `步数 [默认 50]` |
| 已改动 | `tag-hint.is-changed` 显示「已改 · 默认 50」 | `步数 [已改 · 默认 50]` |
| 恢复 | 点「恢复默认」→ 清空覆盖值，回到 placeholder 状态 | — |

- 判定：`Number(refs.steps.value) === profile.defaults.steps`（空值也算默认）。
- 摘要区用「默认」/「自定义」后缀标注：`50 步（默认）`、`12 步（自定义）`。
- 抽屉底部保留一条常驻提醒（替代现有 `.wb-adv-note`）：
  - MOSS：「MOSS 无 Turbo 时 50 步 / CFG 3.5 / er_sde；开启 Turbo 自动切 8 步 / CFG 1.0 / euler」

#### 负向提示词

后端语义：`params.negative_prompt` 为 `null`/缺省 → 用 profile 默认；空串 → 真的空。

- 前端输入框为空时**不发送** `negative_prompt`（或显式 `null`），并在 hint 标注「留空 = 使用默认 `bad quality,`」。
- 输入框 placeholder 显示 profile 默认值。

#### Turbo（复用 `TurboControl`）

- `TurboControl` 的 `profiles` 改为按模型取：`profile.turbo`（后端新增字段，格式对齐现有 profile 对象）。
- MOSS 预设两条：
  - `moss8` ·「8 步加速 · moss-8steps @1.0」→ steps 8 / cfg 1.0 / euler / simple / lora 文件
  - `none` ·「不加速」→ steps 50 / cfg 3.5 / er_sde（等价于关闭）
- 关闭 Turbo 时仍按用户手填值发送；开启时后端以预设覆盖 steps/cfg/sampler/scheduler 并挂 LoRA。
- Turbo 开启时步数/CFG 输入框沿用现有「Turbo 锁定」样式。

#### SLG（MOSS 专属）

- 折叠块 `details.fold`「SLG 跳过层引导（实验）」：开关 + `single_layers`（默认 `22`）+ `start/end_percent`（默认 0 / 0.5），`double_layers` 留空折叠成高级项。
- 默认**关闭**；开启时 hint：「50 步下约 +10~15s；8 步加速下不建议开启」。
- 请求体：`slg: { enabled, single_layers, double_layers, start_percent, end_percent }`。

#### LoRA 区

- 保留现有 `LoraPicker`（可勾选多个 + 强度）。
- MOSS 下追加提示：「加速 LoRA 由 Turbo 管理；此处用于风格 LoRA」。
- 后端限制不变（最多 2 个，超出报错）。

### 3.4 边界框设计器

**入口**：仅 `capabilities.bbox` 为真时出现。

- pill：`[布局 未设置]` / `[布局 3 个框]`；
- 高级设置「边界框布局」面板：开关、`[打开设计器]`、`[清空]`、当前框数量、`character_boxes` 选择（`1` / `-1` / 空）。

**弹窗**：新增 `web/src/components/bboxStudio.js`，接口对齐 `openPoseStudio`：

```js
openBboxStudio({
  width, height,            // 目标画布（已 snap）
  initial,                  // { enabled, character_boxes, items }
  onApply, onClear,
})
```

- 左：`<canvas class="bbox-canvas">`，按 `min(560/w, 420/h)` 缩放显示，只做显示换算；
- 右：框列表（类型、文字、描述、色板）+ 新增/删除；
- 绘制：空白处拖拽新建；选中后拖动移动、四角/四边缩放；`Delete` 删除；方向键 1px 微调；
- 类型：`object` / `character` / `text`；选 `text` 时「文字」为**必填**，逐字上屏，`\n` 表示换行；
- 约束：最小 16×16 px，自动 clamp 在画布内，整数化；
- 列表项显示 `x,y,w,h` 可手改（与画布双向同步）。

**与现有功能的不冲突矩阵**

| 组合 | 处理 |
|---|---|
| 布局 + 姿态 | 不共存：MOSS 下姿态本就隐藏；切回 Qwen 时清空布局 |
| 布局 + 透明背景 | 不共存：MOSS 无 rgba，透明背景隐藏 |
| 布局 + 批量 | 开启布局时批量锁 1 并禁用，提示「布局模式一次生成 1 张」 |
| 布局 + Turbo | 允许 |
| 布局 + 风格预设 | 允许（预设只改主提示词） |
| 布局 + 润色 | 允许；MOSS 润色带 `image_model=moss`；布局开启时额外提示「框内文字请写在框里，不要写进主提示词」 |
| 布局 + 目标尺寸变更 | 弹确认：默认按比例缩放所有框并 4/16 取整；也可选「清空布局」 |
| 编辑页 | 完全不出现 |

**请求体**（已有后端契约，不改）：

```jsonc
"bbox": {
  "enabled": true,
  "character_boxes": "1",
  "items": [
    { "x": 120, "y": 900, "w": 784, "h": 500, "type": "character", "desc": "..." },
    { "x": 320, "y": 80,  "w": 384, "h": 160, "type": "text", "text": "清凉一夏", "desc": "手写体标题" }
  ]
}
```

### 3.5 参数摘要 / 状态文案

- 摘要新增首行：`模型 MOSS-Image · 50 步（默认） · CFG 3.5 · er_sde · simple`；
- Turbo 开启：`Turbo · 8 步 · CFG 1 · euler · moss-8steps @1.0`；
- 布局开启：`布局 · 3 个框（2 物 + 1 文字）`；
- 底部 action hint 按模型：MOSS「MOSS 首次加载约 30~60s，显存约 20GB」。

## 4. 显存管理

### 4.1 后端（已实现，本轮只补可观测性）

- `Pipeline._engines` 按模型惰性建实例；`_engine_for(profile)` 在切模型时对其余已加载引擎 `free(unload=True)`。
- 单 worker 串行；空闲 `idle_unload_minutes=30` 自动卸载。
- 本轮补：`status()` 增加 `model`（当前驻留模型 id，未驻留为 `null`），供 `/api/health` 透出。

### 4.2 前端策略

1. **切换不加载**：只改参数，避免用户来回点两次就换两次权重。
2. **生成时才切**：请求里带 `model`，后端自行卸载/加载，进度条 label 显示「加载模型」。
3. **运行中禁切**：`queue.running || status==='queued'` 时模型 pill 禁用。
4. **驻留可见**：pill 上小圆点：绿=已驻留且一致，灰=未加载，黄=驻留的是另一个模型。
5. **预期提示**：切换且后端驻留模型不同时，生成按钮 hint 改为「将卸载 Qwen 并加载 MOSS（约 30~60s）」。
6. **OOM 兜底**：沿用后端中文 OOM 提示；前端 toast 给出「关闭 Turbo / 降低分辨率 / 减少批量」建议。

### 4.3 不会做的事

- 不做「双模型常驻」（32GB 卡装不下 ~16GB + ~20GB）。
- 不做并发预加载/后台换权重（会和采样抢显存）。

## 5. 后端待改清单（3 处，均为小改）

| 文件 | 改动 | 原因 |
|---|---|---|
| `server/models.py::public_list` | 每个 profile 增加 `turbo`（数组，格式对齐 `TurboControl.profiles`）与 `samplers`（如 moss=`["er_sde","euler"]`，qwen 取全量） | 前端不再按 id 硬编码；`accelerator`/`turbo_profiles` 原样保留，编辑页不受影响 |
| `server/config.py::SAMPLERS` | 增加 `"er_sde"` | 当前列表缺失，MOSS 默认采样器在下拉里没有项 |
| `server/pipeline.py::status` | 返回 `model` 字段 | 前端显示驻留状态、切换提示 |

> `/api/generate`、`/api/polish`、`/api/options` 的既有字段一律保持兼容；不改错误码。

## 6. 实施步骤

### P0 后端可观测性与选项（预计 3 个小改 + 3 条单测）

1. `models.public_list` 补 `turbo` / `samplers`。
2. `config.SAMPLERS` 加 `er_sde`。
3. `pipeline.status()` 加 `model`，`main./api/health` 透传。
4. `tests/test_moss_profile.py` 增：`public_list` 的 moss turbo 预设条数与字段、moss samplers 含 er_sde、status 的 model 键。
5. 验收：`pytest tests/test_moss_profile.py -q` 全绿；`/api/options` 手查。

### P1 前端模型切换骨架

文件：`web/src/store.js`、`web/src/components/t2i.js`、`web/assets/css/composer.css`（或 `studio.css`）

1. `DEFAULT_T2I` 增加 `model: ''`、`byModel: {}`（按模型存采样参数快照）。
2. `collectPayload()` 传 `model`；`snapUp` 改为按 `profile.snap`。
3. pill 栏插入模型 pill（结构复用尺寸 pill）；切换逻辑 + 持久化 + toast。
4. 能力联动：透明背景/姿态/布局的显隐；切模型时清理不兼容字段。
5. 尺寸/采样器/调度器默认值按 profile 初始化（首次切 MOSS 用 `defaults`，不是沿用 2048²）。
6. 验收：切 MOSS → 刷新页面仍是 MOSS；请求体含 `model:"moss"`；生成成功且文件名前缀 `moss-t2i-`。

### P2 高级设置按模型重绘 + 默认值提示

1. 抽屉顶部模型条（名称、默认参数、恢复默认）。
2. 三个默认态样式：placeholder / `tag-hint` / `tag-hint.is-changed`；摘要标「默认/自定义」。
3. 负向提示词：空 → 不发送，hint 显示默认。
4. 采样器/调度器按 `profile.samplers` 生成。

### P3 Turbo 与 SLG（MOSS）

1. `renderTurbo()` 改用 `profile.turbo`；保留编辑页走全局 `turbo_profiles`。
2. 步数预设 chips 按模型切换。
3. 新增 SLG 折叠块，默认关；`collectPayload()` 带 `slg`。
4. 生成前互斥校验：Turbo 与手填步数冲突时以 Turbo 为准（沿用现有锁定样式）。

### P4 边界框设计器

1. 新增 `web/src/components/bboxStudio.js`（约 400 行，含画布绘制/命中测试/列表）。
2. 新增样式到 `web/assets/css/studio.css`（复用 `pose-*` 的 modal 布局）。
3. t2i 接入：pill、高级面板、尺寸变更确认、批量锁 1。
4. `collectPayload()` 输出 `bbox`；本地校验（越界/零面积/text 空）阻止提交并高亮。
5. 状态存 `state.t2i.byModel[model].bbox`，切模型不丢。

### P5 润色对接

1. `polish.js` 的 payload 增加 `image_model`（取当前模型）。
2. 布局开启时在提示中追加「框内文字已单独指定，主提示词不要再描述这些文字」。
3. 验收：切 MOSS 润色返回 `{"caption": ...}` 风格文案，不再套 Qwen 的 `rewritten_prompt`。

### P6 回归与验收

1. `pytest tests -q` 全绿（现有 250+）。
2. 手动矩阵（见下）。
3. 更新 `docs/WEB_UI.md` 的控件说明与 `README.md` 的界面截图/说明（如有）。

## 7. 验收清单（手动）

| # | 场景 | 期望 |
|---|---|---|
| 1 | Qwen 原用例（25 步 / 2K / 透明背景 / 姿态） | 与改动前一致 |
| 2 | 切 MOSS，默认参数直接生成 | 50 步 · CFG 3.5 · er_sde · 1024²，输出 `moss-t2i-*` |
| 3 | MOSS + Turbo | 8 步 · CFG 1.0 · euler；约 4s 采样 |
| 4 | MOSS + SLG（关 Turbo） | 采样时间 +10~15s，无报错 |
| 5 | MOSS + 布局 2 框（物体 + 文字） | 文字逐字正确、位置符合框 |
| 6 | 布局开启后批量控件 | 锁定为 1 |
| 7 | 运行中切换模型 | pill 禁用，无法切换 |
| 8 | 先 Qwen 出图再切 MOSS 出图 | 第二次请求前卸载 Qwen；显存峰值不叠加 |
| 9 | MOSS 下切回 Qwen | 透明背景/姿态恢复可用，布局隐藏且数据保留 |
| 10 | 编辑页 | 无模型切换，无布局入口 |
| 11 | 刷新页面 | 模型选择与各模型参数分别保留 |
| 12 | 缺文件（临时改名 LoRA） | 卡片置灰 + 缺失文件名；生成前拦截 |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `TurboControl` 契约变动影响编辑页 | 只新增 `profile.turbo`，不动全局 `turbo_profiles`；编辑页继续走旧数据源 |
| `t2i.js` 已 1100+ 行，继续膨胀 | 边界框独立成 `bboxStudio.js`；默认值提示抽成小工具函数留在 t2i 内 |
| 尺寸默认从 2048 变 1024 让用户困惑 | 切换模型时在摘要与 toast 明示「已套用 MOSS 默认 1024²」 |
| er_sde 加入全局列表后 Qwen 也能选 | 允许（后端本就能跑）；前端在 Qwen 下排序仍把 euler 放首位 |
| 布局框与实际出图偏差 | 沿用后端 `floor/ceil` 中心坐标换算；设计器只负责像素框，不做二次缩放 |
| 切换时权重抖动 | 切换只改参数；运行中禁切；生成时才换 |

## 9. 变更文件预览

```
server/models.py                     +turbo / +samplers
server/config.py                     +"er_sde"
server/pipeline.py                   status() +model
tests/test_moss_profile.py           +3 例

web/src/store.js                     DEFAULT_T2I +model/byModel
web/src/components/t2i.js            模型 pill、能力联动、默认值提示、Turbo/SLG、bbox 接入
web/src/components/bboxStudio.js     新增
web/assets/css/studio.css            新增 bbox-* 样式
web/src/components/polish.js         payload +image_model
docs/WEB_UI.md / README.md           控件与用法同步
```

> 以上为计划，**在你下达执行命令前不会改动任何代码**。
