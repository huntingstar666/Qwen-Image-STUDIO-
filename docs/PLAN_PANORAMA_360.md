# 360° 全景（panorama360）方案

> 状态：**P1 已落地（2026-11-11）；P2 排期，未动后端**。
> 已确认口径：P1 先上线；查看器三处一起（结果区 / 历史记录 / 素材仓库）；`coverage` 默认 40%；文生图 360 同时提供 2048×1024 与 3072×1536。
> 关联文档：[PLAN_PANORAMA.md](PLAN_PANORAMA.md)（宽幅全景已上线）、[WEB_UI.md](WEB_UI.md)、[PLAN_PS_FRONTEND.md](PLAN_PS_FRONTEND.md)。
> 独立验证产物：`pano_lab/`（生成实验）、`panorama_360/`（球面查看器参考实现）。

## 0. 结论摘要

1. **现有 `panorama` 任务做不出 360°**。它只按目标比例做「最小外扩」：3:2 源图补到 2:1 时源图仍占画布 75%，上下完全不补，模型没有空间补出新场景。真机实测就是「一张被加宽的人像」。
2. **文生图 + 等距柱状提示词可以直接出真 360° 内容**。独立实验 A/B 均通过（室内、户外），球面查看器里可以真正环视。
3. 因此本方案分两条能力，按优先级：
   - **P1（先做，确定性高）**：文生图 360° 直出 + 环绕融合 + 球面查看器入口；
   - **P2（实验，需要真机验收门）**：照片 → 360°（`panorama360` 任务：源图缩到画布 ~40%，上下左右四周外扩）。
4. 查看器不放在主页面做新顶级页，作为「查看方式」接入结果区 / 历史记录 / 素材仓库；three.js 复用 `web/vendor/pose3d/vnccs/three.module.mjs`，不新增 npm 依赖。

## 1. 实验证据（2026-11-08，RTX 5090 / turbo9）

脚本：`pano_lab/run_panorama_test.py`；产物：`pano_lab/out/`。

| 组 | 做法 | 输出 | 结论 |
|---|---|---|---|
| A | 文生图 2:1 + 等距柱状提示词（室内） | 2048×1024 | **真 360**，球面环视能看到沙发/电视/窗户；左右接缝色差 11.5/255 |
| B | 文生图 2:1 + 等距柱状提示词（户外） | 2048×1024 | **真 360**，标准球面展开；接缝色差 11.7/255 |
| C | `task.mode=panorama`（源图占 75%） | 2048×1024 | 失败：仅左右补房间，主体占满中心 |
| D | 先把源图缩到 800px 再跑 `panorama` | 1088×544 | 失败：最小外扩规则把画布也缩了，源图仍占 ~75% |

一条命令已验证：`pano_lab/make_panorama.py`（生成 → 接缝色差融合 → 球面查看），融合后色差 19.7→4.9、14.3→7.9。

## 2. 目标与非目标

**目标**

1. 用户能拿到「拖动可以环视一圈」的全景图，并在结果区/历史/素材里用球面查看器打开。
2. 文生图路径支持一键 360°（2:1、等距柱状提示词、自动环绕融合）。
3. 图生图路径提供实验档 `panorama360`：把已有照片扩展成 360° 画布，源图区域像素逐字节保留。
4. 不破坏现有 `panorama` / `outpaint` / 普通编辑行为。

**非目标**

1. 不承诺严格等距柱状投影的几何正确性（官方模型也无此保证），只承诺「球面环视观感 + 左右闭合」。
2. 不做多视角拼接、不做深度估计、不做 VR 头显适配。
3. 不做新的顶级页面。

## 3. 产品落位

| 入口 | 改动 | 阶段 |
|---|---|---|
| 文生图 `#t2i` | 原「全景」组改名「宽幅」；新增「360° 全景」组：固定 2:1（2048×1024 / 3072×1536），选中后自动追加等距柱状提示词 | P1 |
| 图像编辑 `#edit` | 任务下拉新增「360° 全景」；面板新增「源图占比」滑杆（默认 40%）+ 环绕融合开关 | P2 |
| 图片精修 `#studio` | AI 面板任务下拉同步新增；复用 `panoramaPanel.js` 增加 coverage 控件 | P2 |
| 结果区 / 历史记录 / 素材仓库 | 结果预览旁增加「全景查看」按钮，用球面查看器打开 | P3 |
| 图像处理 `#tools` | 全景比例 chips 增加「360°（2:1）」预设，交接时带 `taskMode="panorama360"` | P3 |

查看器沿用 `panorama_360/` 的实现（three.js 球面 + 宽幅兜底 + 360° 示例），后续以组件形式接入 `web/src`。

## 4. 契约设计

### 4.1 新增任务模式（只加分支，不改既有）

```jsonc
POST /api/edit
{
  "images": ["<参考图>"],
  "prompt": "把画面扩展为 360° 等距柱状全景 …",
  "task": { "mode": "panorama360" },
  "panorama360": {
    "coverage": 0.4,        // 源图占画布宽度比例，0.3~0.6，默认 0.4
    "long_side": 3072,      // 上限，只缩不放
    "wrap": true,           // 默认开：左右环绕融合
    "seam_blend": 24,       // 0~128
    "level": true           // 源图与扩展区交界亮度对齐（复用 seam_level）
  },
  "size_mode": "custom",
  "local": { "enabled": true, "scheme": "a" }
}
```

- 画布比例固定 **2:1**，不接受 `aspect`；传了忽略。
- `coverage` 是唯一新增语义：源图等比缩到 `coverage × canvas_w` 后居中，四周补灰。
- 多余字段忽略；`panorama` 块与 `panorama360` 互斥，同时出现以 `panorama360` 为准并在 `meta.warnings` 提示。

### 4.2 校验（`main._validate_edit_params`）

| 场景 | 处理 |
|---|---|
| `panorama360` 非对象 | 400：`panorama360 必须是对象` |
| `coverage` 越界 | 400：`0.3~0.6` |
| `long_side` 越界 | 400：`1024~4096` 且不超过全局 `max_side` |
| `wrap` / `level` 非布尔 | 400 |
| `seam_blend` 越界 | 400：`0~128` |
| 目标画布超 6.0MP | 管线抛 `PipelineError`，提示降低长边或提高 coverage |
| 未传参考图 | 400（与 `/api/edit` 一致） |

`/api/options` 的 `task_modes` 增加 `"panorama360"`；`TASK_ALIASES` 增加 `"panorama360": "panorama360"`；`PRESET_VERSION` 7→8，新增预设 `panorama360`（避免历史回放串参）。

## 5. 几何算法：`imaging.panorama360_plan()`

与 `panorama_plan()` 并列新增，不改老函数：

```python
def panorama360_plan(src_w, src_h, *, coverage=0.4, long_side=3072,
                     multiple=32, max_side=4096,
                     max_pixels=PANORAMA_MAX_PIXELS,
                     fill=_OUTPAINT_FILL) -> PanoramaPlan:
```

规则：

1. 画布先按 2:1 取 `long_side` 为长边（向下取 `multiple` 倍数），再受 `max_pixels` 约束（只缩）。
2. `work_w = round(canvas_w * coverage)`，`work_h = work_w / src_ratio`；若 `work_h > canvas_h`，反推 `work_h = canvas_h`、`work_w = work_h * src_ratio`。
3. 源图缩到 `work_*`（只缩不放：源图比 work 小时按原尺寸贴，居中）。
4. `left/right/top/bottom` 为四边补边，32 对齐；`PanoramaPlan.to_outpaint_info()` 直接复用，遮罩走 `outpaint_mask()`。
5. 硬保护同现有：`max(W,H) > max_side` 或 `W*H > max_pixels` 抛 `ValueError`（带建议参数）。
6. 新增 `panorama360_canvas(im, plan)`：与 `panorama_canvas` 相同，只是允许上下补边（现有函数已居中贴放，可直接复用；若签名一致则不必新增）。

## 6. 管线改造：`pipeline.generate_edit()`

在 `elif task_mode == "panorama"` 之后插入 `elif task_mode == "panorama360"`，其余走同一条合成链路：

1. 调 `imaging.panorama360_plan()` + `panorama360_canvas()`；`op_info` 供 `outpaint_mask()`。
2. 强制 `scheme="a"`（整画布采样）、`hint="gray_fill"`、`fills=false`；忽略 `local.scheme` 的 B 方案。
3. 提示词：缺少「全景/panorama/等距柱状/equirect」关键词时前置 `_PANORAMA360_INSTRUCTION`，写 `meta.prompt_augmented="panorama360"`。
4. `zs_spec` 关闭、`preprocess` 不启用（尺寸本就要变）。
5. `composite` 保留源图区域像素（既有遮罩语义），输出不裁回源尺寸。
6. 后处理顺序：
   - `level=true` → `imaging.seam_level(final, pads)` 修四边交界（现有函数已支持上下左右）；
   - `wrap=true` → `imaging.wrap_seam_blend(final, blend_px=seam_blend)` 压左右接缝。
7. `quality.panorama360` 回显：`coverage / canvas / work / pads / scale / seam_report / wrap_report`；`quality.outpaint` 置 `null`；`job.align.panorama360`。
8. `panorama` 分支完全不受影响。

### 6.1 文生图 360°（P1，不改后端）

后端已能按显式 `width/height` 生成 2:1 图，**P1 只改前端**：

1. `t2i.js`：`PANORAMA_RATIOS` 分组改名「宽幅」；新增「360° 全景」档（2048×1024 / 3072×1536）。
2. 提示词模板改为等距柱状版本（与实验 A/B 一致），已含 `panoram` 时只追加「equirectangular」。
3. 提交后可选择「生成后做环绕融合」——前端不做像素运算，改为由后端新增 `POST /api/image/wrap-blend`？**不做**。P1 先用「生成后结果区一键全景查看」；融合留到 P2 后端提供（避免前端引入大图运算）。

## 7. 前端与查看器

### 7.1 查看器组件化（P3）

- 现有 `panorama_360/` 是独立可运行页面，作为参考实现。
- 接入 `web/src` 时新增 `web/src/components/panoramaViewer.js`：ES module 直接 `import * as THREE from '../../vendor/pose3d/vnccs/three.module.mjs'`，不新增依赖。
- 接入点：结果区「全景查看」按钮、历史记录大图、素材仓库详情；`viewer.js` 的「宽幅 / 360° 全景」双模式与「360° 示例」直接搬过来。
- 大图性能：3072×1536 纹理在 5090 机器上无压力；低端机按 `maxTextureSize` 降采样，超过 4096 先缩到 4096 再贴。

### 7.2 编辑页 / 工作室面板

- `studio/panoramaPanel.js` 增加 `coverage` 滑杆（30%~60%，默认 40%）与「360° 全景（实验）」开关；选 360 时比例 chips 固定 2:1 并禁用。
- `edit.js` 的 `collectPayload()` 在 `taskMode === 'panorama360'` 时提交 `panorama360` 块，强制 `scheme=a / fills=false / hint=gray_fill`。
- 预设 `panorama360` 写进 `server/presets.py`，`presetSettings.js` 增加对应可编辑项。

## 8. 实施阶段与提交边界

| 阶段 | 内容 | 主要文件 | 验收 |
|---|---|---|---|
| **S1** | 几何层：`panorama360_plan()` + 单测（2:1、coverage、32 对齐、6MP、只缩不放） | `server/imaging.py`、`tests/test_panorama360.py` | 单测全绿 |
| **S2** | 契约层：`task.mode=panorama360`、参数校验、预设 v8 | `server/main.py`、`server/presets.py`、`tests/test_edit_validation.py`、`tests/test_edit_presets.py` | 校验 6 例 + 预设断言 |
| **S3** | 管线：分支、提示词、`seam_level` 四边、`wrap` 融合、`quality.panorama360` | `server/pipeline.py`、`tests/test_zero_shift_ps.py` | mock e2e：源区像素守恒 + 报告字段 |
| **S4** | 前端入口：编辑页 / 工作室面板 + 文生图 360 档 + 预设设置 | `edit.js`、`studio/panoramaPanel.js`、`studio/aiPanel.js`、`t2i.js`、`presetSettings.js`、`composer.css` | 浏览器实测 |
| **S5** | 查看器接入：`web/src/components/panoramaViewer.js` + 结果区/历史/素材入口 | 新增组件、`jobView.js`、`history.js`、`materials.js`、`studio.js` | 浏览器实测 + 大图性能 |

**冲突规避**：`server/pipeline.py`、`server/presets.py`、`server/main.py` 当前干净；`web/assets/css/app.css`、`animation_kit/`、`still_loop/` 不碰；`web/src/components/studio*` 目前有他人未提交改动，**S4/S5 必须等其提交后再开工**。每个阶段单独 commit，禁止 `git add -A`。

## 9. 测试与验收

### 9.1 自动测试

- `tests/test_panorama360.py`：几何 8 例（2:1、coverage 0.3/0.4/0.6、32 对齐、超 6MP、源图超宽/超高、只缩不放、画布贴放位置）。
- `tests/test_edit_validation.py`：6 条非法参数。
- `tests/test_zero_shift_ps.py`：mock e2e 断言源图区域字节不变、`quality.panorama360` 字段齐全、`wrap_report` 存在。
- 全量 `python -m pytest tests -q` 必须全绿。

### 9.2 真机验收（硬门槛）

用现有素材（人像 + 一张室内照）各跑 3 seed，指标：

| 指标 | 通过线 |
|---|---|
| 源图区域像素 | `outside_max_abs = 0`，源区逐字节保留 |
| 左右接缝色差 | 融合后 ≤ 5/255 |
| 四边交界阶跃 | `seam_report.after_mean_abs` ≤ 5 |
| 构图 | 环视 360° 无重复主体、地平线/墙线连续（人工目检 3 张截图） |
| 耗时 / 显存 | 2048×1024 ≤ 15s、峰值 ≤ 26GB；3072×1536 ≤ 25s、峰值 ≤ 28GB |

**若 P2 真机达不到构图门槛**：`panorama360` 只保留为「实验」并默认关闭，对外只承诺 P1（文生图 360）。这一条写死在验收里，避免把幻觉包装成能力。

## 10. 性能预算

| 画布 | 像素 | 预估耗时（turbo9） | 显存 |
|---|---|---|---|
| 2048×1024 | 2.1MP | 6~10s | ~23GB |
| 3072×1536 | 4.7MP | 12~20s | ~26GB |
| 4096×2048 | 8.4MP | 禁止（>6MP 自动缩） | — |

## 11. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| 照片→360 是幻觉补全 | 背后场景模型凭空生成，可能不合理 | 标注「实验」；默认 coverage 0.4；真机门槛不达标就只保留 P1 |
| 接缝几何不连续 | 色差能抹平，结构线对不齐 | 只承诺观感；`wrap` 融合 + 提示词「seamless」；查看器默认宽幅、手动切球面 |
| 大图纹理 | 4096 纹理在低端 GPU 掉帧 | 贴图前按 `maxTextureSize` 降采样 |
| 与并行开发冲突 | `studio*.js` 他人未提交 | S4/S5 延后，先做 S1~S3 后端 |
| 预设版本 | 新增预设必须升版本 | `PRESET_VERSION 7→8`，同步测试与文档 |
| three.js 依赖 | 新增 npm 依赖会拖慢构建 | 复用 vendor 的 `three.module.mjs`（r160） |

## 12. 回滚

- 每阶段独立 commit，出问题 `git revert <sha>`。
- 预设回滚时同步回退 `PRESET_VERSION`，避免历史回放参数错配。
- 若 P2 验收失败：只下线 `panorama360` 预设与前端入口，保留 `panorama` 与 P1 文生图 360。

## 13. 未决问题（请确认）

1. **P1 是否先上线**：只做文生图 360 + 查看器，不等 P2 真机？建议先上，用户马上可用。
2. 查看器接入范围：先「历史记录 + 结果区」，还是三处一起（含素材仓库）？
3. `panorama360` 默认 `coverage`：40% 还是 35%（更低更沉浸，但源图细节损失更大）？
4. 文生图 360 的尺寸档：只给 2048×1024，还是同时给 3072×1536（更清晰、更慢）？

---

## 14. P1 落地记录（2026-11-11）

> 本轮只做 P1：文生图「360° 全景」尺寸档 + 全景查看器（结果区 / 历史记录 / 素材仓库三处）。后端与 `panorama360` 任务未动。
> 命名口径：原「全景」组改名「宽幅」；新增「360° 全景」组；查看器模式为「宽幅 / 360° 全景」。

### 14.1 交付清单

| 文件 | 改动 |
|---|---|
| `web/src/components/panoramaMath.js` | 新增：`isPanoramaAspect`（≥1.9 判定入口）、`SPHERE_SIZES`（2048×1024 / 3072×1536）、`withSpherePrompt`（缺关键词才追加等距柱状提示词） |
| `web/src/components/panoramaViewer.js` | 新增：双模式查看器（360° 全景 / 宽幅），three.js 动态 import，关闭时释放纹理/几何/渲染器 |
| `web/src/components/t2i.js` | 尺寸弹层分组改名「宽幅」、新增「360° 全景」档（2K / 3K，固定 2:1）、提示词复选框文案切换、提交时补 360° 提示词；360 档不跟随分辨率档位 |
| `web/src/components/jobView.js` | 结果卡片与批次流：宽高比 ≥1.9 的图片加「全景」按钮 |
| `web/src/components/history.js` | 历史详情每张图加「全景」按钮 |
| `web/src/components/materials.js` | 素材详情底栏加「全景查看」 |
| `web/assets/css/composer.css` | 新增 `.pano360-modal` / `.pv-*` 样式（未改 `app.css`） |
| `web/tests/studio/panorama360.test.mjs` | 新增 3 组单测（入口判定 / 尺寸档 / 提示词追加） |

### 14.2 验收

- `node --test "web/tests/studio/*.test.mjs"` → **147 passed**（含新增 3 例）。
- 浏览器（真实 8700）：`#t2i` 尺寸弹层出现「宽幅」「360° 全景」两组；点 `2K` 后尺寸 pill 显示 `360-2k · 2,048×1,024`，复选框文案变为「自动追加 360° 全景提示词」，无控制台报错。
- 组件隔离渲染（headless Chrome + 真实 2:1 输出）：弹窗正常打开，360° 视图渲染、尺寸信息 `2048 × 1024 · 2.00:1`、模式 chips 与操作按钮可用。

### 14.3 已知边界

- 宽高比 ≥1.9 只是「值得用全景查看」的启发式，不代表图片内容一定是 360°；非等距柱状内容在 360° 模式会有放大/边缘拉伸，查看器底部提示与「宽幅」模式可兜底。
- P1 不做接缝融合：文生图直出的左右接缝色差约 11/255（实验 A/B），需要融合时走 P2 的后端 `wrap` 能力。
- 未提交 commit；等确认后按文件精确暂存。
