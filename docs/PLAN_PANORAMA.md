# 全景图生成：能力查证、落位与实施计划

> 状态：**S1~S6 已落地并提交**（几何层 / 契约层 / 管线 / 编辑页 / 文生图 / 图像处理辅助）；**P0 真机基线已执行**（2026-11-07，RTX 5090 32GB，2:1 / 3:1 / 4:1 × 3 seed，见第 13 节）；**S8 已修复源图边界亮带**（13.5）。  
> 关联文档：[ARCHITECTURE.md](ARCHITECTURE.md)、[WEB_UI.md](WEB_UI.md)、[ALIGN_COLOR.md](ALIGN_COLOR.md)、[IMAGE_TOOLS.md](IMAGE_TOOLS.md)。  
> 约束：仓库有并行开发（`animation_kit/`、作品画廊、`web/assets/css/app.css`），本次实现未触碰这些文件，全部按文件名精确暂存。

## 0. 结论摘要（先看这段）

1. **官方支持全景，但它是“编辑能力”，不是独立参数。** Qwen-Image-2.1 官方博客把 **Panoramas / Infographics / Storyboards** 列为编辑任务覆盖范围，示例是「一张自拍 → 生成全景」。官方仓库 README 没有全景专用参数、没有 360° 等距柱状投影说明。
2. **官方开源推荐比例只有 7 种，最宽 16:9**（2048² 原生 2K）。托管 API 允许 1:8 ~ 8:1、总像素 ≤ 2048×2048，说明“宽幅画布”合法，但**不代表 2:1 以上属于训练分布内**。
3. **本项目现状已经能出宽幅图**：文生图尺寸卡已含 `2:1 / 3:1 / 4:1 / 8:1 / 21:9`（[t2i.js](../../web/src/components/t2i.js)），后端按显式 `width/height` 生成，`max_side=4096`（[config.py](../../server/config.py#L116)）。缺的不是“能不能生成”，而是**全景专属的画布规划、接缝处理、质量回显和入口**——这三项已在 S1~S5 补齐。
4. **落位建议：主入口放「图像编辑」页，作为新任务模式 `panorama`；次入口放「文生图」尺寸胶囊的全景档。**
   - 主入口：官方能力就是“参考图 → 全景”，且项目已有成熟的扩图管线（灰边外补 + 遮罩 + 接缝融合 + 色彩一致），复用成本最低。
   - 次入口：纯文生全景只需“尺寸 + 提示词模板”，不需要新管线。
   - **不新增顶级页面**，不重写扩图，不动 `outpaint` 现有语义。
5. **“360° 全景（等距柱状 / VR）”只能作为实验能力**，官方没有承诺；先做 **2:1 / 3:1 / 4:1 宽幅全景**，360 环绕接缝作为 P5 可选项。
6. **真机基线结论（2026-11-07）**：2:1 默认、3:1 推荐（注意 24.6GB 峰值显存）、4:1 保持实验。三种比例都能连续延展、无重复主体、地平线平直；基线暴露的**源图与扩展区交界亮带**已在 S8 修复（交界阶跃 24~31 → <0.1，光晕 22 → 5），复测见 13.5。

## 1. 官方查证

### 1.1 官方博客（能力声明）

来源：[Qwen-Image-2.1 官方博客](https://qwen.ai/blog?id=qwen-image-2.1)（2026-09-20）

> **Task Coverage: Panoramas, Infographics, and Storyboards**  
> Qwen-Image-2.1 supports a broad range of editing tasks, including panorama, infographic, and storyboard generation...  
> For example, starting from this selfie: **Input selfie for panorama generation** — The model generates the following panorama.

结论：全景被官方明确列为**编辑任务**，输入是参考图，不是文生图专属能力。

### 1.2 官方开源仓库（参数与比例）

来源：[QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1)

- 原生 2K，README 的「Supported Aspect Ratios」只有 7 种：

| 比例 | 推荐尺寸 |
|---|---|
| 1:1 | 2048 × 2048 |
| 4:3 | 2400 × 1792 |
| 3:4 | 1792 × 2400 |
| 3:2 | 2528 × 1696 |
| 2:3 | 1696 × 2528 |
| 16:9 | 2752 × 1536 |
| 9:16 | 1536 × 2752 |

- 没有 `panorama` / `equirectangular` / `projection` 之类的参数或节点。
- README 的示例提示词只有一句 `"A panoramic mountain landscape"`，属于普通宽幅文生图，不是专用全景模式。

### 1.3 托管 API（尺寸边界）

来源：[Qwen 同步文生图 API](https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image)、[图像编辑 API](https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing)

> qwen-image-3.0 and qwen-image-2.1 series: total pixels between 512\*512 and 2048\*2048, aspect ratio between 1:8 and 8:1.

结论：**宽幅画布合法**（最高 8:1），但总像素被 2048² 限制；这是接口约束，不是质量承诺。

### 1.4 查证结论（用于产品口径）

| 问题 | 结论 |
|---|---|
| 能生成全景吗？ | **能**。官方定义为编辑任务，参考图 → 全景。 |
| 有全景专用开关/参数吗？ | **没有**。需要本项目自建画布与接缝策略。 |
| 能生成 360° 等距柱状（VR）全景吗？ | **官方未承诺**。属于分布外实验能力，不能作为默认卖点。 |
| 最稳妥的比例是多少？ | **2:1 / 3:1**（长边 2048~3072）；4:1 可用但需验收；8:1 不建议默认开放。 |
| 文生全景可行吗？ | 可行，按普通宽幅文生图 + 全景提示词模板；质量弱于参考图编辑。 |

## 2. 落位决策：放在哪里

### 2.1 候选位置对比

| 位置 | 复用度 | 用户路径 | 结论 |
|---|---|---|---|
| **图像编辑页 `#edit` 新增任务「全景」** | 高：直接复用 `outpaint_canvas` + `outpaint_mask` + `stitch_region` + `color_consistency` | 上传参考图 → 选全景比例 → 生成 | **主入口（推荐）** |
| 文生图页 `#t2i` 尺寸胶囊加「全景」档 | 高：只加尺寸档 + 提示词模板，零管线改动 | 写提示词 → 选全景 → 生成 | **次入口（P4）** |
| 图像处理页 `#tools` 扩图规划 | 中：已有 `outpaint_plan`，但它是“规划 → 带去编辑” | 先规划再跳转，路径长 | 保持现状，增加「全景」方向预设即可 |
| 新增顶级页面「全景工作台」 | 低：新页面、新路由、新样式 | 多一步导航 | **不做**（7 模块结构稳定，收益不足） |

### 2.2 推荐信息架构

```
图像编辑 #edit
├─ 方案预设：局部编辑 / 元素移除 / 扩图 / 【全景】
├─ 任务下拉：跟随预设 / 通用编辑 / 局部重绘 / 元素移除 / 扩图 / 【全景】
└─ 全景面板（选中后展开，实际控件）
   ├─ 目标比例 chips：2:1 / 3:1 / 4:1 / 21:9（默认 2:1）
   ├─ 长边上限 select：2048 / 3072 / 4096（默认 3072，只缩不放）
   ├─ 360° 环绕接缝（实验）：关（默认）/ 开，羽化 24 px
   └─ 目标画布实时预估：W × H、缩放比例、>6.0 MP 警告

文生图 #t2i
└─ 尺寸胶囊 → 比例网格「全景」分组：2:1 / 3:1 / 4:1 / 8:1 / 21:9
   └─ 选中后自动追加全景提示词模板（复选项，默认开，可关闭）
```

### 2.3 为什么不放在文生图作为主入口

官方示例的输入是自拍，能力本质是“基于参考图向外延展并保持人物/场景一致”。放在文生图会丢失参考图一致性，也绕不开项目已有的扩图接缝能力。文生图只做“纯想象全景”，作为补充入口。

## 3. 总体技术路线

### 3.1 技术路线（实际实现）

| 路径 | 适用 | 做法 | 状态 |
|---|---|---|---|
| **A. 单次直出** | 2:1 / 3:1 / 4:1 / 21:9，总像素 ≤ 6.0MP | 灰边外补到目标画布 → 整画布采样（`scheme="a"`）→ 贴回 → 接缝融合 | **已实现** |
| **B. 分块接力** | 4:1 以上或显存不足 | 左右分块外扩、逐块生成、接缝融合 | **未实现**（评估后认为首版收益不足，留作后续） |

`long_side` 与 `max_pixels` 都是**上限**：超出时整体等比缩小（只缩不放），不做分块。默认 3072，总像素上限 6.0MP（覆盖 3072×1536，拦住 4096×2048）。

### 3.2 复用现有能力（不重写）

| 现有能力 | 位置 | 全景中的用途 |
|---|---|---|
| `imaging.outpaint_canvas()` | [imaging.py](../../server/imaging.py#L1026-L1075) | 按百分比外扩、灰底画板、32 对齐、`max_side` 保护 |
| `imaging.outpaint_mask()` | [imaging.py](../../server/imaging.py#L1078-L1084) | 新增区域遮罩（只重绘外补区） |
| `pipeline.generate_edit()` 的 `task_mode=outpaint` | [pipeline.py](../../server/pipeline.py#L799-L823) | 灰边约定、提示词补全、零偏移保护、贴回 |
| `imaging.stitch_region()` / `color_consistency()` | [imaging.py](../../server/imaging.py#L1107) | 接缝过渡带、颜色一致性 |
| 一致性 LoRA | `config.consistency_lora` | 多块/多轮时锁人物与场景 |
| 零偏移守卫 | [pipeline.py](../../server/pipeline.py#L1079-L1084) | 画布 == 参考图画布，避免位移 |

## 4. 后端设计

### 4.1 请求契约（`POST /api/edit`，已实现）

新增 `task.mode="panorama"`，参数块独立，不污染现有 `outpaint`：

```jsonc
{
  "images": ["<参考图 base64 或 url>"],
  "prompt": "黄昏时分的海边公路，向两侧无限延伸",
  "task": { "mode": "panorama" },
  "panorama": {
    "aspect": "2:1",          // 2:1 | 3:1 | 4:1 | 21:9
    "long_side": 3072,        // 1024~4096，默认 3072（输出长边上限）
    "wrap": false,            // 360° 环绕接缝（实验）
    "seam_blend": 24          // 接缝羽化像素，0~128
  },
  "seed": 123456,
  "local": { "enabled": true, "scheme": "a" },
  "size_mode": "custom"
}
```

实际行为：

- `task.mode="outpaint"` 行为完全不变。
- `panorama` 块**只接受以上 4 个字段**；多余字段会被忽略（无 `sides` / `tile` / `overlap_pct`，已从设计中移除）。
- `long_side` 是上限：目标画布超过它或超过 6.0MP 时整体等比缩小，**只缩不放**。
- `prompt` 可留空：后端在缺少「全景/panorama/panoramic/宽幅」关键词时自动前置 `_PANORAMA_INSTRUCTION`，并写 `meta.prompt_augmented="panorama"`。
- `wrap=true` 时固定做左右环绕接缝，不做方向选择。
- 后端强制 `scheme="a"`（整画布采样），忽略 `local.scheme` 的 B 方案；`hint` 强制 `gray_fill`。

### 4.2 几何规划：`imaging.panorama_plan()`（已实现）

```python
PANORAMA_ASPECTS = {"2:1": (2, 1), "3:1": (3, 1), "4:1": (4, 1), "21:9": (21, 9)}
PANORAMA_MAX_PIXELS = 6_000_000

def panorama_plan(src_w, src_h, *, aspect="2:1", long_side=3072,
                  multiple=32, max_side=4096,
                  max_pixels=PANORAMA_MAX_PIXELS,
                  fill=_OUTPAINT_FILL) -> PanoramaPlan:
    """按目标比例算外扩画布；只缩不放，超预算抛 ValueError。"""
```

规则（与实现一致）：

1. **最小外扩**：源图比目标窄 → 只补左右；源图比目标宽 → 只补上下；不裁内容、不做方向选项。
2. 画布 32 对齐；源图等比缩到 `work_w/work_h` 后**居中**贴放，`left/top` 为整数偏移。
3. `long_side` / `max_pixels` 都是上限，超限时整体等比缩小并向下取整到 32 的倍数（保证不越过上限）。
4. 硬保护：`max(W,H) > max_side` 或 `W*H > max_pixels` 抛 `ValueError`，错误信息带建议长边。
5. `PanoramaPlan.to_outpaint_info()` 复用 `OutpaintInfo`，遮罩直接走 `outpaint_mask()`。
6. `panorama_canvas(im, plan)` 负责缩图与贴画布；`wrap_seam_blend(image, blend_px=24, strength=1.0)` 做全宽线性色差校正 + 首尾窄带羽化，返回 `(image, report)`。
7. `seam_level(image, pads, band=48, flatten=96, flatten_clip=32)` 修源图与扩展区的交界：先按逐行/逐列色差做 48px 阶跃对齐，再把源图边缘低频走向镜像进扩展区压掉 20~40px 的光晕，返回 `(image, seam_report)`。只写扩展区，源图像素不动。

### 4.3 管线改造：`pipeline.generate_edit()`

在 `outpaint` 分支后插入（只加分支，不改 `outpaint`）：

```python
elif task_mode == "panorama":
    pan = params.get("panorama") or {}
    pano_plan = imaging.panorama_plan(
        src.width, src.height, aspect=..., long_side=..., max_side=cfg.max_side)
    op_canvas = imaging.panorama_canvas(src, pano_plan)   # 灰底画板
    op_info = pano_plan.to_outpaint_info()                # 供 outpaint_mask 复用
```

其余步骤与扩图共用：

1. `op_canvas` 作为参考图画布；`zs_spec` 关闭（输出尺寸本就要变，不走零偏移）。
2. `encode_text(images=[canvas, ...refs], resolution=0)`。
3. `sample` 只在灰边区域降噪，**强制 `scheme="a"`**（全景不能裁块，否则横向连续性断裂）。
4. `composite` → 遮罩外保留原图；`job.align["panorama"]` 与 `quality.outpaint` 互斥。
5. 输出保持全景画布，不裁回源尺寸（`task_mode in ("outpaint","panorama")` 时 `final = composed`）。
6. 后处理：`wrap=true` 且 `seam_blend>0` 时执行 `imaging.wrap_seam_blend(final, blend_px=seam_blend)`，报告写入 `quality.panorama.wrap_report`。
7. 未做：分块接力、地平线/消失点自动纠偏。

### 4.4 质量回显（已实现）

`job.quality.panorama` 实际字段：

```jsonc
"quality": {
  "panorama": {
    "aspect": "2:1",
    "long_side": 3072,
    "wrap": false,
    "seam_blend": 24,
    "canvas": { "w": 3072, "h": 1536 },
    "work":   { "w": 1408, "h": 704 },
    "pads":   { "left": 0, "right": 0, "top": 0, "bottom": 0 },
    "scale": 1.0,
    "seam_report": {      // 源图边界渐变修正，见 13.4
      "mode": "edge_offset_ramp", "band": 48, "flatten": 96,
      "sides": {
        "left":  {"pad": 256, "band": 48, "before_mean_abs": 59.7, "before_max_abs": 109.0, "after_mean_abs": 4.0, "flatten_mean_abs": 7.9},
        "right": {"pad": 256, "band": 48, "before_mean_abs": 55.2, "before_max_abs": 95.0,  "after_mean_abs": 3.4, "flatten_mean_abs": 6.5}
      }
    },
    "wrap_report": null   // 开 wrap 时为 {mode, blend_px, before_max_abs, after_max_abs, shift}
  }
}
```

`quality.outpaint` 在全景任务下置 `null`，避免前端同时渲染两套扩图信息。`job.align` 按任务写 `panorama` 或 `outpaint`。

### 4.5 校验与错误（实际规则）

| 场景 | 处理 |
|---|---|
| `panorama` 不是对象 | 400：`panorama 必须是对象` |
| `aspect` 非法 | 400：只允许 `2:1 / 3:1 / 4:1 / 21:9` |
| `long_side` 越界 | 400：必须在 `1024~4096` |
| `wrap` 非布尔 / `seam_blend` 越界 | 400：布尔校验 / `0~128` |
| 目标画布超 `max_side` 或 6.0MP | 管线抛 `PipelineError`（`全景画布 W×H 超过…；请降低长边`） |
| 未传参考图 | 400（与 `/api/edit` 一致） |
| `task.mode=outpaint` | 完全不受影响，仍走原扩图逻辑 |

## 5. 前端设计

### 5.1 图像编辑页（主入口，已实现）

改动文件：`web/src/components/edit.js`、新增 `web/src/components/studio/panoramaPanel.js`、`web/assets/css/composer.css`。

1. 任务下拉新增 `<option value="panorama">全景</option>`，`TASK_NOTES.panorama` 给出说明。
2. 预设注册表新增 `panorama`（`server/presets.py`）：
   - `label: "全景"`；
   - `task: {mode: "panorama"}`；
   - `local: {enabled: true, scheme: "a", fills: false, hint: "gray_fill", feather: 32, color_match: true, consistency: true}`；
   - `panorama: {aspect: "2:1", long_side: 3072, wrap: false, seam_blend: 24}`。
3. 选中「全景」后展开 `panoramaPanel`：
   - 比例 chips：`2:1 宽幅 / 3:1 超宽 / 4:1 极宽 / 21:9 电影`；
   - 长边上限 select：`2048 / 3072 / 4096`；
   - 「360° 环绕接缝（实验）」复选框；
   - 目标画布 `W × H` 实时预估、缩放百分比提示、超过 6.0 MP 警告。
4. 面板数值写入 `edit.overrides` 的 `panorama.*`，由 `edit.js` 在 `collectPayload()` 统一提交；与 `outpaint` 互斥。
5. 前端 `estimate()` 与后端 `panorama_plan` 使用同一套「最小外扩 / 32 对齐 / 只缩不放」规则。
6. 提交时强制 `fills=false`、`hint="gray_fill"`、`scheme="a"`（预设分支与旧参数分支都覆盖）。

### 5.2 文生图页（次入口，已实现）

改动文件：`web/src/components/t2i.js`、`web/assets/css/composer.css`。

1. `PANORAMA_RATIOS = ['2:1','3:1','4:1','8:1','21:9']`，渲染时在比例网格末尾加「全景」分组标题。
2. 选中全景比例时，尺寸弹层出现「自动追加全景提示词」复选框（默认勾选）：
   - 模板：`seamless ultra-wide panoramic photograph, consistent horizon, no duplicated subjects`；
   - 只在提示词里还没有 `panoram` 时追加，不覆盖用户正文。
3. 不新增 API；`collectPayload()` 继续传显式 `width/height`（长边按档位，高按比例 32 对齐）。
4. 页面文案提示：文生全景没有参考图，人物/场景一致性弱于图像编辑页。

### 5.3 图像处理页（辅助，已实现）

`web/src/components/imageTools.js` 的扩图折叠区新增「全景比例」chips：`不限 / 2:1 / 3:1 / 4:1 / 21:9`。

- 选中比例后，方向与幅度由 `panoramaDirectionAmount()` 按目标比例自动反推（宽不够→左右扩，高不够→上下扩，幅度 = 需要补的边长 / 2 相对原边），方向 chips 与幅度滑杆自动禁用。
- 「规划扩图」仍调用 `/api/image/outpaint-plan`，预览新画布与新增区域遮罩。
- 按钮文案变为「带到编辑 · 全景」：交接时**不发送预览画布**，而是把当前处理图（已应用裁剪/调色等操作）+ `taskMode="panorama"` + `panorama` 参数送到编辑页，由编辑页重新规划，避免把已扩好的画布再当源图。
- 编辑页 `applyHandoff()` 已支持 `taskMode` 与 `panorama.*` 覆盖项，接收后自动选中「全景」并回填比例/长边。

## 6. 实施阶段（含实际状态）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 基线** | 现有“自定义尺寸”在 2:1 / 3:1 / 4:1 各跑 3 组真实权重，记录构图、重复元素、接缝、耗时、显存 | **已完成**（2026-11-07 真机，见第 13 节） |
| **P1 契约** | `task.mode=panorama` + `panorama` 参数块、边界校验、`quality.panorama` | **已完成**（S2，`d488aaa`） |
| **P2 几何** | `imaging.panorama_plan()`、`panorama_canvas()`、`wrap_seam_blend()` | **已完成**（S1，`7afa319`） |
| **P3 管线** | `generate_edit` 接入 panorama 分支、提示词模板、贴回与接缝融合 | **已完成**（S3，`bede74f`） |
| **P4 前端** | 编辑页任务 + 全景面板；文生图全景分组与提示词模板 | **已完成**（S4 `55cf243` / S5 `2f0f44b`） |
| **P5 实验** | 360 环绕接缝、分块接力、地平线指标 | 360 接缝**已实现**；分块与地平线指标**未做** |
| **P6 辅助入口** | 图像处理页全景比例规划 + 交接编辑页 | **已完成**（S6，见第 9 节提交） |

实际执行顺序为 `S1 → S2 → S3 → S4 → S5 → S6`，每步独立提交并跑对应测试。

## 7. 验收标准

### 7.1 功能

- 2:1 / 3:1 / 4:1 / 21:9 均能规划画布，输出尺寸与请求一致，32 对齐。✅ 单测覆盖
- 源图区域像素不被重绘。✅ mock e2e 断言源图区域字节不变
- 灰边外补后由模型补全，输出保持全景画布、不裁回源尺寸。✅ mock e2e
- 360 环绕：左右边缘色差回显 `wrap_report.before_max_abs / after_max_abs`。✅ 单测 + mock e2e
- 任务取消、进度条单调递增、显存释放与现有编辑任务一致。⬜ 未做真机回归

### 7.2 性能

| 画布（1024×768 源图） | 总像素 | 真机实测（turbo9 / RTX 5090） |
|---|---|---|
| 1536 × 768（2:1） | 1.2MP | 4.0~16.2s，峰值显存 22.9GB |
| 2304 × 768（3:1） | 1.8MP | 7.1~10.1s，峰值显存 24.6GB |
| 3072 × 768（4:1） | 2.4MP | 12.1~16.2s，峰值显存 23.7GB |
| 3072 × 1536（2:1 打满长边） | 4.7MP | 未实测：需要 1536×3072 级别源图才会触发 |
| 4096 × 2048 | 8.4MP | **默认不允许**：超过 6.0MP 上限，会被自动等比缩小 |

> 注：`max_side=4096` 只限制单边；全景同时限制总像素 6.0MP，避免 4096×2048 打爆显存。上表为 P0 真机基线实测值，明细见第 13 节。

### 7.3 兼容

- `task.mode=outpaint` 的请求与回显不变。
- 第三方只传 `prompt + images` 的普通编辑不受影响。
- `/api/options` 的 `ratios` 若增加全景比例，需保持向后兼容（前端按 id 查找，缺省回退）。

## 8. 风险与边界

| 风险 | 说明 | 对策 |
|---|---|---|
| 比例分布外 | 官方只保证到 16:9；2:1 以上可能出现重复元素、地平线弯曲 | P0 基线先定可用上限；默认 2:1，3:1 标“推荐”，4:1 标“实验” |
| 360° 并非官方能力 | 等距柱状投影需要 180° 垂直视场，模型未训练 | 只做“环绕接缝闭合”的近似，UI 标“实验”，不承诺 VR 可用 |
| 显存 | 8.4MP 画布超出常规编辑预算 | 总像素上限 6.0MP，超限自动等比缩小并报警告 |
| 接缝 | 宽幅画布容易出现左右重复纹理 | 灰边遮罩 + 已有过渡带 + 颜色一致；360 再用边缘色差校正 + 窄带羽化 |
| **源图边界亮带** | ~~真机复现：扩展区与源图交界有 1~2px 亮度阶跃（左边界 24~31/255，右边界 5~10/255）~~ | **已修复**（S8）：`imaging.seam_level()` 先对齐交界阶跃，再把源图边缘低频走向镜像进扩展区压掉光晕；真机复测见 13.5 |
| **24GB 显存卡** | 3:1 峰值 24.6GB，4090/3090 级别的 24GB 卡接近上限 | 默认 2:1；24GB 卡限制源图高度，或在文案提示降低比例 |
| 并行开发冲突 | `app.css`、`animation_kit/`、画廊由他人维护 | 新样式只加在 `composer.css` 的独立类名下；不改 `app.css` |

## 9. 改动清单（实际落地）

| 文件 | 改动 | 状态 |
|---|---|---|
| `server/imaging.py` | `PANORAMA_ASPECTS`、`PANORAMA_MAX_PIXELS`、`PanoramaPlan`、`panorama_plan()`、`panorama_canvas()`、`wrap_seam_blend()` | 已提交 `7afa319` |
| `server/main.py` | `task.mode` 白名单 + `panorama` 参数校验 | 已提交 `d488aaa` |
| `server/presets.py` | `PRESET_VERSION 2→3`，新增 `panorama` 预设 | 已提交 `d488aaa` |
| `server/pipeline.py` | panorama 分支、强制 `scheme=a`、提示词补全、环绕接缝、`quality.panorama` | 已提交 `bede74f` |
| `web/src/components/edit.js` | 任务下拉、面板挂载、payload 合并 | 已提交 `55cf243` |
| `web/src/components/studio/panoramaPanel.js` | 新增全景面板 | 已提交 `55cf243` |
| `web/src/components/t2i.js` | 全景比例分组 + 提示词模板 | 已提交 `2f0f44b` |
| `web/assets/css/composer.css` | `.size-ratio-group`、`.size-pano-row` | 已提交 `2f0f44b` |
| `tests/test_panorama.py` | 几何 / 画布 / 遮罩 / 环绕接缝单测 | 已提交 `7afa319` |
| `tests/test_edit_validation.py`、`tests/test_edit_presets.py` | 参数校验与预设断言 | 已提交 `d488aaa` |
| `tests/test_zero_shift_ps.py` | 全景 mock e2e（像素守恒 + wrap 报告） | 已提交 `bede74f` |
| `web/src/components/imageTools.js` | 扩图规划全景比例 + 交接编辑页 | 已提交 `91ffb0e` |
| `web/src/handoff.js` | 交接增加 `taskMode` / `panorama` 字段 | 已提交 `91ffb0e` |
| `web/src/components/edit.js` | `applyHandoff` 应用任务模式与全景覆盖项 | 已提交 `91ffb0e` |
| `server/imaging.py` | S8：`seam_level()` + `_smooth_1d()` / `_smooth_axis1()`，交界阶跃与低频光晕修正 | 本次提交 |
| `server/pipeline.py` | S8：全景合成后调用 `seam_level`、`quality.panorama.seam_report`、`feather=0` 修复 | 本次提交 |
| `tests/test_panorama.py` | S8：`seam_level` 单测（阶跃、光晕、跳过、PIL） | 本次提交 |
| `docs/WEB_UI.md` | 补「全景」入口说明 | 本次文档维护 |

## 10. 已确认事项

1. **产品口径**：只承诺“宽幅全景（2:1 / 3:1 / 4:1 / 21:9）”，360° 标“实验”，不承诺等距柱状投影。
2. **入口优先级**：主入口在图像编辑页 `panorama` 任务，文生图只做比例档 + 提示词模板。
3. **默认长边**：3072（4.7MP），总像素上限 6.0MP。
4. **分块**：首版只做单次直出；分块接力未实现。

## 11. 实现结果（本次交付）

| 项 | 结果 |
|---|---|
| 提交 | `7afa319` → `d488aaa` → `bede74f` → `55cf243` → `2f0f44b` → `91ffb0e` |
| 全量测试 | `python -m pytest tests -q` → **442 passed** |
| 浏览器验证 | `#edit` 选「全景」后面板展开，比例/长边/360 控件可见，无控制台错误；`#t2i` 尺寸弹层出现「全景」分组与提示词开关；`#tools` 扩图区出现「全景比例」chips；模拟交接后编辑页任务自动切到「全景」、比例回填 3:1、长边回填 2048 |
| 接口验证 | `/api/meta` 返回 `preset_version=3`，预设含 `panorama:panorama` |
| P0 真机基线 | 9 次全部成功（2:1/3:1/4:1 × 3 seed）：`outside_max_abs=0`、源区像素逐字节保留；耗时 4.0~16.2s、峰值显存 22.9~24.6GB；未出现重复主体，地平线平直；**已知源图边界竖向亮带**。明细见第 13 节 |
| 未验证 | 21:9 / 8:1 真机、分块接力、多轮连续扩展、取消与显存释放回归 |

## 12. 落实记录（已执行）

> 本节保留执行版的任务 ID、边界与回滚方案，并回写实际结果。
> **当前状态：S1~S6 已落地并提交；P0 真机基线待执行。**

### 12.1 Git 基线（开工前后对照）

| 项 | 开工前（2026-11-07 查证） | 完成后 |
|---|---|---|
| 分支 | `main` | `main` |
| 基线 HEAD | `d5b9c7c docs: 回写默认模型方案进度并补充交叉引用` | `91ffb0e feat(tools): 扩图规划支持全景比例并交接编辑页` |
| 他人未提交 | `server/pipeline.py`（去水印）、`web/src/components/edit.js`（去水印按钮） | 对方已提交 `9e985d8`，本人开工时两文件干净 |
| 历史遗留未提交 | `web/assets/css/app.css` | 仍未提交，未触碰 |
| 未跟踪（他人） | `docs/PLAN_LLM_PROVIDERS.md`、`docs/PLAN_STILL_LOOP.md`、`still_loop/`、`sheet_test.png` | 保持未跟踪，未触碰 |
| 本人产出 | `docs/PLAN_PANORAMA.md` | 6 个代码提交 + 文档 |

**执行顺序**：`S0`（等对方提交）→ `S1` → `S2` → `S3` → `S4` → `S5` → `S6` → `S7`。全部在主分支，逐文件 `git add`，未使用 `git add -A`。

### 12.2 S0 开工前检查（不写代码）

```powershell
git status --short
git log --oneline -5
git diff -- server/pipeline.py web/src/components/edit.js
```

通过标准：

1. `server/pipeline.py`、`web/src/components/edit.js` 没有非本人的未提交改动。
2. `web/assets/css/app.css`、`animation_kit/`、`still_loop/`、`docs/PLAN_STILL_LOOP.md`、`docs/PLAN_LLM_PROVIDERS.md` 保持不动。
3. 显卡空闲、没有正在跑的真机任务（P0 基线需要真实权重）。

分支建议：`git switch -c feat/panorama`，每个任务一个 commit，方便单独回滚。

> 如果用户希望直接在主分支做，也不影响步骤，但必须逐文件 `git add`，禁止 `git add -A`。

### 12.3 分步任务与提交边界

| ID | 内容 | 主要文件 | 实际结果 | commit |
|---|---|---|---|---|
| **S1** | 几何层：全景画布规划 + 环绕接缝融合 | `server/imaging.py`（新增函数，不改 `outpaint_canvas`） | ✅ `tests/test_panorama.py` 通过 | `7afa319` |
| **S2** | 参数契约：`panorama` 参数块、校验、预设 | `server/main.py`、`server/presets.py`（`PRESET_VERSION 2→3`） | ✅ 校验 5 例 + 预设测试通过 | `d488aaa` |
| **S3** | 管线接入：`task_mode=panorama` 分支、提示词补全、质量回显 | `server/pipeline.py`（只加分支，不改 outpaint） | ✅ mock e2e：源图像素守恒、wrap 报告 | `bede74f` |
| **S4** | 编辑页入口：任务下拉 + 全景面板 | `edit.js`、新增 `studio/panoramaPanel.js`、`composer.css` | ✅ 浏览器实测面板展开、无报错 | `55cf243` |
| **S5** | 文生图入口：全景比例分组 + 提示词模板 | `web/src/components/t2i.js`、`composer.css` | ✅ 浏览器实测分组与开关 | `2f0f44b` |
| **S6** | 图像处理辅助：全景比例规划 + 交接编辑页 | `imageTools.js`、`handoff.js`、`edit.js` | ✅ 浏览器实测 chips 渲染、交接后任务/比例/长边回填 | `91ffb0e` |
| **S7** | 真机回归 + 文档回写 | `docs/WEB_UI.md`、本文件 | 文档已回写；真机回归未做 | 本次文档提交 |

#### S1 细节（几何层，实际实现）

1. `server/imaging.py` 新增：
   - `PANORAMA_ASPECTS`、`PANORAMA_MAX_PIXELS = 6_000_000`；
   - `@dataclass PanoramaPlan`：`src_w/src_h`、`work_w/work_h`、`left/right/top/bottom`、`canvas_w/canvas_h`、`aspect`、`wrap`、`scale`、`fill`，带 `to_outpaint_info()`；
   - `panorama_plan(src_w, src_h, *, aspect="2:1", long_side=3072, multiple=32, max_side=4096, max_pixels=6_000_000)`；
   - `panorama_canvas(im, plan)`；
   - `wrap_seam_blend(image, *, blend_px=24, strength=1.0) -> (image, report)`。
2. 不修改 `outpaint_canvas()`；全景自己算最小外扩与居中贴放。
3. 新增 `tests/test_panorama.py`，覆盖比例尺寸、32 对齐、只缩不放、超限报错、画布粘贴、遮罩、环绕接缝（PIL/ndarray）。
4. 修正点：长边缩小时用 `round` 再向下取整到 32，避免 3072 掉到 3040；像素上限从 4.2MP 调到 6.0MP。

#### S2 细节（契约层，实际实现）

1. `main._validate_edit_params` 实际校验：
   - `aspect ∈ {2:1, 3:1, 4:1, 21:9}`；
   - `long_side ∈ [1024, 4096]`；
   - `wrap` 必须布尔；`seam_blend ∈ [0, 128]`；
   - `panorama` 必须是对象。
2. `presets.EDIT_PRESETS["panorama"]`：
   - `task: {mode: "panorama"}`；
   - `local: {enabled: true, scheme: "a", fills: false, hint: "gray_fill", feather: 32, color_match: true, consistency: true, ...}`；
   - `panorama: {aspect: "2:1", long_side: 3072, wrap: false, seam_blend: 24}`。
3. `PRESET_VERSION` 从 `2` 改为 `3`。
4. 同步更新 `tests/test_edit_presets.py` 的预设 ID 列表，并新增全景预设断言。

#### S3 细节（管线层，实际实现）

1. `_TASK_ALIASES` 新增 `"panorama": "panorama"`。
2. `generate_edit` 中新增 `elif task_mode == "panorama"`：
   - 调 `imaging.panorama_plan()` + `panorama_canvas()`；
   - `op_info = pano_plan.to_outpaint_info()`，复用 `outpaint_mask()`；
   - 强制 `scheme="a"`、`hint="gray_fill"`；
   - 缺关键词时前置 `_PANORAMA_INSTRUCTION`，写 `meta.prompt_augmented="panorama"`。
3. `zs_spec` 关闭；preprocess 在全景下不启用；`job.align` 写 `panorama`。
4. 输出保持全景画布；`wrap=true` 时 `composite` 之后执行 `wrap_seam_blend`。
5. `quality.panorama` 写 `aspect/long_side/wrap/seam_blend/canvas/work/pads/scale/wrap_report`，`quality.outpaint` 置 `None`。

#### S4 细节（编辑页 UI，实际实现）

1. 任务下拉加 `<option value="panorama">全景</option>`，并补 `TASK_NOTES`。
2. 新增 `studio/panoramaPanel.js`：`mountPanoramaPanel(host, { getSize })`，返回 `{init, refresh, destroy}`。
3. 面板控件：比例 chips、长边上限 select、360 开关、目标画布预估、>6.0MP 警告。
4. 数值写 `edit.overrides` 的 `panorama.*`，由 `edit.js` 合并进 payload；预设分支与旧参数分支都强制 `fills=false / hint=gray_fill / scheme=a`。
5. 样式只加在 `composer.css`，未碰 `app.css`。

#### S5 细节（文生图 UI，实际实现）

1. 新增 `PANORAMA_RATIOS = ['2:1','3:1','4:1','8:1','21:9']`，`SIZE_RATIOS` 末尾展开；补 `3:1`。
2. 渲染时插入 `<div class="size-ratio-group">全景</div>` 分组标题。
3. 尺寸弹层新增「自动追加全景提示词」复选框（默认开），提交时合成 `PANORAMA_PROMPT`。
4. 不改 `collectPayload()` 协议，只改尺寸与提示词合成。

### 12.4 测试命令（本机离线，用根目录 shim）

```powershell
python -m pytest tests/test_panorama.py -v
python -m pytest tests/test_edit_validation.py tests/test_edit_presets.py -v
python -m pytest tests/test_zero_shift_ps.py -v
python -m pytest tests -q
```

本次全量结果：**446 passed in 46.53s**（含 S8 新增的 4 个 `seam_level` 单测）。

真机回归（2026-11-07 已执行）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run.ps1
# 浏览器 http://127.0.0.1:8700/#edit
```

### 12.5 冲突规避硬规则

1. **开工前再查一次 git**：`git status --short` + `git diff --stat`，确认 `pipeline.py` / `edit.js` 无他人未提交改动。
2. 只做“函数级插入”，不整文件格式化、不批量改导入顺序。
3. 禁止 `git add -A` / `git add .`；按文件名精确暂存。
4. 不修改：`web/assets/css/app.css`、`animation_kit/`、`still_loop/`、`docs/PLAN_STILL_LOOP.md`、`docs/PLAN_LLM_PROVIDERS.md`、作品画廊相关文件。
5. 每次 commit 前跑一次对应单测；S3 之后跑全量 `tests -q`。

### 12.6 回滚方案

- 每个任务独立 commit，出问题用 `git revert <sha>`，**不用** `git reset --hard`。
- 若预设需要回滚：同时把 `PRESET_VERSION` 回退，避免历史任务回放参数串图。
- 若只是 UI 问题：可单独 revert S4/S5，后端契约与几何层保留，不影响既有编辑功能。
- 回滚后跑 `python -m pytest tests -q`，确认 `outpaint` / 局部编辑用例全绿。

### 12.7 当前状态与后续

- ✅ S1~S6 已完成并提交；文档已回写。
- ✅ **P0 真机基线**：2:1 / 3:1 / 4:1 各 3 组已跑完（第 13 节），结论是 2:1 默认、3:1 推荐但注意显存、4:1 保持实验。
- ✅ **360° 环绕接缝实测**：2:1 下 `before_max_abs 238 → after_max_abs 0`，功能可用，UI 继续保留“实验”标签（不承诺等距柱状投影）。
- ✅ **源图边界亮带**：S8 用 `imaging.seam_level()` 修复（阶跃对齐 + 低频光晕压制），真机复测见 13.5；`feather=0` 也被正确识别。
- ⬜ **21:9 / 8:1**：未跑真机，当前按 4:1 同量级对待；若要作为正式档位需补测。

## 13. P0 真机基线（2026-11-07）

### 13.1 环境与口径

| 项 | 值 |
|---|---|
| 显卡 | RTX 5090 32GB（`nvidia-smi` 每 0.5s 采样取峰值） |
| 模型 | `qwen` + Turbo 底模 `qwen_image_2.1_turbo_int8_convrot`（`turbo9_ckpt`，9 步，CFG 1.0，euler/simple） |
| 请求 | `POST /api/edit`，`preset=panorama`、`task.mode=panorama`、`long_side=3072`、`wrap=false`、`seam_blend=24` |
| 源图 | 先用文生图生成 1024×768 写实海边公路（39.4s，峰值 20.9GB），再作为编辑目标 |
| 提示词 | 「黄昏的海边公路，远山与低云向两侧无限延伸，海面与护栏保持连续，地平线平直，不要出现重复的人物、建筑或纹理」（不含「全景」关键词，9 次都命中 `prompt_augmented=panorama`） |
| seed | 1207 / 20261107 / 881231 |
| 产物 | `%TEMP%\qwen-pano-baseline\`（源图、9 张结果、`baseline.json`），未提交进仓库 |

### 13.2 结果

> 本节是 **S8 修复前**的基线数字（用于留档与横向对比）；修复后的同条件复测见 13.5。

| 比例 | 画布（补边 左/右） | 源区占比 | seed | 耗时 | 峰值显存 | 左边界亮度阶跃 | 右边界亮度阶跃 |
|---|---|---|---|---|---|---|---|
| 2:1 | 1536×768（256/256） | 66.7% | 1207 | 16.2s（首跑含预热） | 22863MB | 29.6 | 7.3 |
| 2:1 | 同上 | 66.7% | 20261107 | 4.0s | 23185MB | 26.7 | 6.2 |
| 2:1 | 同上 | 66.7% | 881231 | 4.1s | 23183MB | 26.7 | 7.8 |
| 3:1 | 2304×768（640/640） | 44.4% | 1207 | 10.1s | 24631MB | 28.0 | 8.1 |
| 3:1 | 同上 | 44.4% | 20261107 | 7.1s | 24633MB | 26.6 | 5.5 |
| 3:1 | 同上 | 44.4% | 881231 | 7.1s | 24627MB | 30.5 | 9.9 |
| 4:1 | 3072×768（1024/1024） | 33.3% | 1207 | 16.2s | 23728MB | 23.7 | 6.2 |
| 4:1 | 同上 | 33.3% | 20261107 | 12.1s | 23738MB | 26.2 | 6.5 |
| 4:1 | 同上 | 33.3% | 881231 | 12.3s | 23715MB | 27.8 | 5.3 |

- 9 次全部 `status=done`：`outside_max_abs=0`、`leak_ratio=0`、`size_match=true`，源图区域像素逐字节保留；`changed_ratio` 为 0.323 / 0.522~0.532 / 0.637~0.642，与补边比例一致。
- 色差校正均为 `anchor_affine`，缩放系数 0.993~0.998、偏移 <0.003，未触发跳过。
- 耗时首跑含模型预热；稳定后 2:1 约 4s、3:1 约 7s、4:1 约 12s。
- 360° 环绕（2:1 / seed 1207 / `wrap=true`）：`wrap_report = {mode: edge_affine, blend_px: 24, before_max_abs: 238.0, after_max_abs: 0.0, shift: [62.93, 60.87, 61.03]}`；输出首尾列平均差 63.3 → 0，功能符合设计。

### 13.3 构图观察

- **无重复主体**：三个比例、三个 seed 下，道路、护栏、海面、山体都是单份连续延展，没有复制的山峰、车辆或建筑。
- **地平线平直**：海天分界与道路消失点在扩展区保持连续，没有出现分布外常见的弯曲/倾斜。
- **延展方向正确**：左侧接草坡与远山、右侧接海面与护栏，未发生左右内容互换。
- **4:1 可用但细节更弱**：扩展区占 64%，补出的草地与护栏质感偏平，源图细节密度覆盖不到两端；未见结构性错误。
- **一致性 LoRA 生效**：9 次均自动挂载 `Qwen2.1 一致性无偏移_GH_V1.0`（0.48），主体未漂移。
- **长边 3072 在 1024×768 源图上用不满**：`long_side` 只是上限且不放大，实际输出 2:1 仅 1536×768（1.18MP）、3:1 为 2304×768、4:1 才 3072×768。

### 13.4 缺陷定位：源图与扩展区交界的竖向亮带（已修复）

源图左右边界存在 1~2px 的亮度阶跃：左边界 23.7~30.5（约 9%~12% 灰阶），右边界 5.3~9.9。视觉上是紧贴源图边缘的一条竖向亮带，2:1 / 3:1 / 4:1 与三个 seed 全部复现。

定位对照（2:1 / seed 1207）：

| 变体 | 左边界阶跃 | 结论 |
|---|---|---|
| 基线（feather 32 / color_match on / hint gray_fill） | 29.6 | — |
| `local.color_match=false`（输出字节已变化） | 29.7 | 不是颜色一致性导致的 |
| `local.hint=none` | 29.6 | 全景分支强制 `gray_fill`，hint 无法关闭 |
| `local.feather=0` | 29.6 | `pipeline.py` 是 `int(local.get("feather") or 32)`，**0 被吃成 32**，无法关羽化做对照 |

结论：亮带来自「模型补全结果与源图之间的亮度差」在合成边界上的直接暴露，不是色彩校正造成的，羽化也没有把它抹平。

### 13.5 修复与真机复测（S8）

修复落在 `imaging.seam_level()`（[imaging.py](../../server/imaging.py)），只改扩展区、不动源图：

1. **交界阶跃对齐**：取交界两侧的逐行（左右）/逐列（上下）色差，向扩展区内做 48px 线性衰减偏移，交界处与源图对齐。
2. **低频光晕压制**：模型常在交界内侧 20~40px 画一条竖亮带。把源图边缘的低频灰度走向镜像到扩展区，按 96px 衰减修正，限幅 32 级——只抹低频偏差，保留纹理。
3. 结果写入 `quality.panorama.seam_report`（每边 `before_mean_abs / after_mean_abs / flatten_mean_abs`）。
4. 顺带修掉 `pipeline.py` 的 `int(local.get("feather") or 32)`：现在显式传 `feather=0` 不再被吃成 32。

真机复测（同源图、同 seed 1207、turbo9）：

| 比例 | 交界列亮度阶跃（左 / 右） | 逐行色差均值（左） | 天空区光晕凸起（左 / 右） | `outside_max_abs` |
|---|---|---|---|---|
| 2:1 | 29.6 → **0.07 / 0.07** | 59.7 → **4.0** | 22 → **4.8 / 5.8** | 0 |
| 3:1 | 28.0 → **0.09 / 0.04** | 59.0 → **3.7** | 22 → **4.9 / 5.8** | 0 |
| 4:1 | 23.7 → **0.05 / 0.04** | 60.3 → **3.3** | 22 → **4.9 / 6.2** | 0 |

视觉上竖向亮带已基本消失，只在天空里残留极淡的过渡；源图区域像素仍逐字节保留，耗时与显存无明显变化（2:1 首跑 39.8s 含预热，3:1 10.2s，4:1 16.2s）。

### 13.6 结论与建议

| 问题 | 建议 |
|---|---|
| 默认比例 | **保持 2:1**：4s 级、构图最稳、边界亮带最窄 |
| 3:1 | 可作「推荐」开放，但峰值显存 24.6GB，24GB 卡（3090/4090）接近上限，文案需提示 |
| 4:1 | 保持「实验 / 极宽」定位，不做默认；扩展区细节偏弱、耗时 12s 级 |
| 21:9 / 8:1 | 本轮未跑真机，按 4:1 同量级对待；作为正式档位前需补测 |
| 长边 3072 | 保持默认，但 UI 文案应明确它是**上限而非输出尺寸**：源图高度决定画布高度，`long_side` 只在超出时缩小 |
| 显存 | 全景比同源图文生图（20.9GB）多 2~3.7GB；24GB 卡建议限制源图短边或优先用 2:1 |
| 修复优先级 | ~~源图边界亮带~~（S8 已修）> 大图分块 > 地平线指标；后续补测 21:9 / 8:1 与 24GB 卡 |

## 14. 官方来源

- [Qwen-Image-2.1 官方博客（全景能力）](https://qwen.ai/blog?id=qwen-image-2.1)
- [QwenLM/Qwen-Image-2.1（比例与默认参数）](https://github.com/QwenLM/Qwen-Image-2.1)
- [Qwen 文生图 API 尺寸约束](https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image)
- [Qwen 图像编辑 API 尺寸约束](https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing)
