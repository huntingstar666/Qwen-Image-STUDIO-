# 全景图生成：能力查证、落位与实施计划

> 状态：**S1~S5 已落地并提交**（几何层 / 契约层 / 管线 / 编辑页 / 文生图）；**S6 可选未做**；**P0 真机基线尚未执行**（当前验证为 mock e2e + 浏览器 UI）。  
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

### 5.3 图像处理页（辅助，未做）

S6 可选：`web/src/components/imageTools.js` 的扩图规划增加「全景（2:1 / 3:1 / 4:1）」方向预设，只做规划与遮罩预览，按钮改为「带到图像编辑 · 全景」，不带生成逻辑。当前**尚未实现**，编辑页与文生图两个入口已可用。

## 6. 实施阶段（含实际状态）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 基线** | 现有“自定义尺寸”在 2:1 / 3:1 / 4:1 各跑 3 组真实权重，记录构图、重复元素、接缝、耗时、显存 | **未执行**（本次只有 mock e2e 与 UI 验证） |
| **P1 契约** | `task.mode=panorama` + `panorama` 参数块、边界校验、`quality.panorama` | **已完成**（S2，`d488aaa`） |
| **P2 几何** | `imaging.panorama_plan()`、`panorama_canvas()`、`wrap_seam_blend()` | **已完成**（S1，`7afa319`） |
| **P3 管线** | `generate_edit` 接入 panorama 分支、提示词模板、贴回与接缝融合 | **已完成**（S3，`bede74f`） |
| **P4 前端** | 编辑页任务 + 全景面板；文生图全景分组与提示词模板 | **已完成**（S4 `55cf243` / S5 `2f0f44b`） |
| **P5 实验** | 360 环绕接缝、分块接力、地平线指标 | 360 接缝**已实现**；分块与地平线指标**未做** |

实际执行顺序为 `S1 → S2 → S3 → S4 → S5`，每步独立提交并跑对应测试。

## 7. 验收标准

### 7.1 功能

- 2:1 / 3:1 / 4:1 / 21:9 均能规划画布，输出尺寸与请求一致，32 对齐。✅ 单测覆盖
- 源图区域像素不被重绘。✅ mock e2e 断言源图区域字节不变
- 灰边外补后由模型补全，输出保持全景画布、不裁回源尺寸。✅ mock e2e
- 360 环绕：左右边缘色差回显 `wrap_report.before_max_abs / after_max_abs`。✅ 单测 + mock e2e
- 任务取消、进度条单调递增、显存释放与现有编辑任务一致。⬜ 未做真机回归

### 7.2 性能

| 画布 | 总像素 | 预期 |
|---|---|---|
| 2048 × 1024 | 2.1MP | 与 1024² 同量级，可默认 |
| 3072 × 1536 | 4.7MP | 略高于 2048²，需实测（默认长边） |
| 4096 × 2048 | 8.4MP | **默认不允许**：超过 6.0MP 上限，会被自动等比缩小 |

> 注：`max_side=4096` 只限制单边；全景同时限制总像素 6.0MP，避免 4096×2048 打爆显存。

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
| `web/src/components/imageTools.js` | 扩图规划全景预设 | **未做（S6 可选）** |
| `docs/WEB_UI.md` | 补「全景」入口说明 | 本次文档维护 |

## 10. 已确认事项

1. **产品口径**：只承诺“宽幅全景（2:1 / 3:1 / 4:1 / 21:9）”，360° 标“实验”，不承诺等距柱状投影。
2. **入口优先级**：主入口在图像编辑页 `panorama` 任务，文生图只做比例档 + 提示词模板。
3. **默认长边**：3072（4.7MP），总像素上限 6.0MP。
4. **分块**：首版只做单次直出；分块接力未实现。

## 11. 实现结果（本次交付）

| 项 | 结果 |
|---|---|
| 提交 | `7afa319` → `d488aaa` → `bede74f` → `55cf243` → `2f0f44b` |
| 全量测试 | `python -m pytest tests -q` → **442 passed** |
| 浏览器验证 | `#edit` 选「全景」后面板展开，比例/长边/360 控件可见，无控制台错误；`#t2i` 尺寸弹层出现「全景」分组与提示词开关 |
| 接口验证 | `/api/meta` 返回 `preset_version=3`，预设含 `panorama:panorama` |
| 未验证 | 真实权重下的构图/重复元素/耗时/显存（P0 基线） |

## 12. 落实记录（已执行）

> 本节保留执行版的任务 ID、边界与回滚方案，并回写实际结果。
> **当前状态：S1~S5 已落地并提交；S6 可选未做；P0 真机基线待执行。**

### 12.1 Git 基线（开工前后对照）

| 项 | 开工前（2026-11-07 查证） | 完成后 |
|---|---|---|
| 分支 | `main` | `main` |
| 基线 HEAD | `d5b9c7c docs: 回写默认模型方案进度并补充交叉引用` | `2f0f44b feat(t2i-ui): 尺寸胶囊新增全景比例分组与提示词模板` |
| 他人未提交 | `server/pipeline.py`（去水印）、`web/src/components/edit.js`（去水印按钮） | 对方已提交 `9e985d8`，本人开工时两文件干净 |
| 历史遗留未提交 | `web/assets/css/app.css` | 仍未提交，未触碰 |
| 未跟踪（他人） | `docs/PLAN_LLM_PROVIDERS.md`、`docs/PLAN_STILL_LOOP.md`、`still_loop/`、`sheet_test.png` | 保持未跟踪，未触碰 |
| 本人产出 | `docs/PLAN_PANORAMA.md` | 5 个代码提交 + 文档 |

**执行顺序**：`S0`（等对方提交）→ `S1` → `S2` → `S3` → `S4` → `S5`（→ `S6` 可选）→ `S7`。全部在主分支，逐文件 `git add`，未使用 `git add -A`。

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
| **S6** | 图像处理辅助（可选） | `web/src/components/imageTools.js` | ⬜ 未做 | — |
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

本次全量结果：**442 passed in 48.06s**。

真机回归（尚未执行）：

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

- ✅ S1~S5 已完成并提交；文档已回写。
- ⬜ **S6（可选）**：`imageTools.js` 扩图规划增加全景方向并跳转编辑页。
- ⬜ **P0 真机基线**：用真实权重跑 2:1 / 3:1 / 4:1 各 3 组，记录构图、重复元素、接缝、耗时、显存；据此决定是否开放 4:1 / 21:9 的默认推荐。
- ⬜ **360° 环绕接缝实测**：当前实现是「全宽线性色差校正 + 首尾窄带羽化」，只保证左右边缘尽量对齐，不保证等距柱状投影结构正确；需真机确认后决定是否在 UI 上保留“实验”标签。

## 13. 官方来源

- [Qwen-Image-2.1 官方博客（全景能力）](https://qwen.ai/blog?id=qwen-image-2.1)
- [QwenLM/Qwen-Image-2.1（比例与默认参数）](https://github.com/QwenLM/Qwen-Image-2.1)
- [Qwen 文生图 API 尺寸约束](https://docs.qwencloud.com/api-reference/image-generation/qwen-text-to-image)
- [Qwen 图像编辑 API 尺寸约束](https://docs.qwencloud.com/api-reference/image-generation/qwen-image-editing)
