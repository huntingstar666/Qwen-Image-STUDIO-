# 一张参考图 + 一句话 → 12 帧接力 → GIF / 定格动画

> 状态：方案 + 可运行模拟（Mock 生成、真实 LLM 分镜）。
> 原则：**不修改主项目任何代码**。新功能是独立包 `still_loop/`，只通过 HTTP 调主项目已有的
> `/api/edit`、`/api/jobs/{id}`、`/api/upload`、`/api/polish`，产出的帧再交给
> `animation_kit/` 出 GIF。
> 相关文档：[ARCHITECTURE.md](./ARCHITECTURE.md)、[PROMPT_POLISH.md](./PROMPT_POLISH.md)、
> [PLAN_ANIMATION_KIT.md](./PLAN_ANIMATION_KIT.md)

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 本质是什么 | **串行接力编辑**：第 i 帧 = 对第 i-1 帧做一次小改动，而不是 12 次独立文生图 |
| 分镜从哪来 | 一次 LLM 调用产出 N 条递进编辑指令 + 验收区间；LLM 能读图时把参考图一起发过去 |
| 为什么不会越跑越偏 | 每帧都把**原始参考图**作为 image2 一起送入，锁人物身份/服装/背景；上一帧只作 image1 |
| 自检怎么做 | 代码自检不依赖模型：尺寸一致、改动比例、SSIM、色差、直方图相关、alpha 保留、首尾闭环 |
| 自检不过怎么办 | 该帧从**上一张已通过帧**重新生成，最多 3 次；每次追加针对性纠错指令；仍不过则暂停等人工 |
| 用户看到什么 | N 张缩略图 + 每张提示词 + 每次尝试的指标与判定 + 当前进度（第 i/N 帧、第 j 次尝试） |
| 用户能改什么 | 单帧提示词、单帧重试、跳过/接受；确认后才进入动画导出 |
| 分辨率 | GIF 常用 480~640，默认 **512×512**；接力全程锁同一尺寸，最后可再缩 |
| 透明通道 | 参考图有 alpha 就全程保留 alpha；编辑接口本身保 alpha，可导出透明 GIF/APNG |
| 显存 | 复用主项目单 worker 队列，**一次只提交一帧**；Turbo 8 步 @512 显存压力很小 |
| 模拟阶段验证什么 | 真实 LLM 分镜 + Mock 图 + 自检/重试/进度/报告/GIF 全链路；真生成只需换一个 generator |

**一句话记忆版**：LLM 把想法拆成 N 个「只改一点」的编辑指令 → 每帧用「上一帧 + 原图」接力编辑
→ 代码逐帧验收，不过就从上一张重来（≤3 次）→ 人工确认 → 丢给 animation_kit 出 GIF。

---

## 1. 目标与非目标

### 1.1 目标

1. 输入：一张参考图、一句想法、帧数 N（默认 12）。
2. LLM 一次产出 N 条**单调递进**的编辑指令，每条都能直接送 `/api/edit`。
3. 串行接力生成 N 张图，每张都以上一张为编辑目标、以原参考图为身份锚点。
4. 每张生成后立即做代码自检；不通过自动重试（最多 3 次），仍不过暂停等人工。
5. 前端实时显示阶段、帧号、尝试次数、自检指标。
6. 人工可改单帧提示词、单帧重试、跳过、接受；确认后进入动画导出。
7. 导出 GIF / APNG / PNG 序列（复用 animation_kit），并保留每帧提示词与报告。

### 1.2 非目标

- 不做视频编码（MP4/WebM），需要视频走 PNG 序列。
- 不做多角色/多镜头剪辑，一个 run 只讲一个连续动作。
- 不引入新模型、不训练 LoRA、不改主项目采样实现。
- 不在浏览器里做图像理解；自检全部在服务端用 numpy/Pillow。

---

## 2. 对主项目能力的复用（已核对源码）

| 能力 | 主项目接口 | 本方案用法 |
| --- | --- | --- |
| 参考图上传 | `POST /api/upload` → `{url:"/files/uploads/..."}` | 参考图只传一次，后续用 URL 引用，避免反复传 base64 |
| 连续编辑 | `POST /api/edit` `{prompt, images:[{url}], size_mode:"follow", ...}` → `{job_id}` | 每帧一次，image1=上一帧，image2=原始参考图 |
| 任务进度 | `GET /api/jobs/{id}` → `progress{value,max,label}`、`images[]`、`quality` | 前端显示「采样 6/8」；自检直接复用 `quality.changed_ratio` 等字段 |
| 透明输出 | 编辑解码保留 alpha，PNG 原样落盘 | 有 alpha 的参考图全程透明；导出透明 GIF/APNG |
| 提示词润色 | `POST /api/polish`（官方 PE） | **不直接用于分镜**（它是单条改写）；分镜用独立 planner，调用同一个 Ollama |
| 单 worker 队列 | `server/jobs.py` | 接力循环一次只提交一帧并等待，绝不一次塞 12 个任务 |
| 动画套件 | `animation_kit` `/api/import/frames`、`/api/export` | 确认后把 N 张图导入项目，再导出 GIF |

关键参数（实测契约，来自 `web/src/components/studio/payload.js`）：

```json
{
  "prompt": "编辑指令",
  "images": [
    {"name": "prev.png", "url": "/files/outputs/....png"},
    {"name": "reference.png", "url": "/files/uploads/....png"}
  ],
  "size_mode": "follow",
  "resolution": 0,
  "steps": 8,
  "cfg": 1.0,
  "sampler": "euler",
  "scheduler": "simple",
  "denoise": 1.0,
  "seed": 123456,
  "turbo": {"enabled": true, "profile": "turbo8_official"},
  "task": {"mode": "edit"},
  "preprocess": {"enabled": true, "max_side": 512, "min_side": 256, "multiple": 32,
                 "mode": "downscale_only"},
  "zero_shift": {"enabled": true, "snap": 32, "resolution": 0},
  "local": {"enabled": false, "scheme": "none"}
}
```

要点：

- `size_mode=follow` + 先把参考图缩到目标尺寸 → 全程尺寸不变；
- 编辑无遮罩时是整图重绘，但 `image1` 的图像条件 + 一致性 LoRA 会锁住主体；
- 固定 `seed` 可减少帧间随机跳变；每帧仍可从 job.params.seed 回放；
- `quality.changed_ratio` / `outside_max_abs` / `size_match` 可直接进入自检；
- `preprocess.max_side=512` 时主项目内部会缩到 512 再还原，输出仍是源尺寸。

---

## 3. 总体流程与状态机

```
用户输入：参考图 + 一句话 + N + 尺寸/风格锁
        │
        ▼
[planning]  LLM 分镜（可读图） → N 条 edit 指令 + 每帧验收区间
        │     失败 → 规则分镜兜底（仍然 N 条）
        ▼
[planned]   前端可先审分镜、改任意一条指令
        │
        ▼
[running]   for i in 1..N:
              for attempt in 1..3:
                edit(prev_accepted, reference, prompt_i + correction)
                自检
                pass → 接受，prev = 本帧；break
                fail → 记录原因，带纠错指令重试
              3 次都不过 → [blocked] 暂停，等人工改词/重试/跳过
        │
        ▼
[review]    N 张图 + 提示词 + 指标；可单帧重试/改词/跳过
        │
        ▼
[approved]  导入 animation_kit → 设置 fps/hold/loop → 导出 GIF/APNG
        │
        ▼
[done]      GIF + 报告 + 可回放 run.json
```

状态：`draft | planning | planned | running | blocked | review | approved | exporting | done | canceled | failed`。

**为什么必须暂停而不是带病继续**：第 i 帧是第 i+1 帧的输入，坏帧会污染后面所有帧；
暂停让用户在最便宜的位置修。

---

## 4. LLM 分镜规划

### 4.1 一次调用，产出整条动作曲线

system 约束（写死在 `planner.py`）：

1. 第 1 帧从参考图开始；之后每帧只在上一帧上改一点；
2. 每帧只推进一个动作节拍，禁止跳跃、倒放、新增无关主体；
3. 每条 `edit` 必须是可直接送 Qwen-Image-Edit 的完整中文指令，包含
   「保持人物身份、发型、服装、背景、镜头构图不变」；
4. 变化单调递进，最后一帧到高潮；`seamless=true` 时最后一帧回到接近第一帧的姿态；
5. 只输出 JSON，不要 markdown。

输出：

```json
{
  "title": "疯狂吃米饭",
  "subject": "蓝发女仆装小人",
  "anchors": ["蓝色长发", "黑白女仆装", "木桌与暖色背景", "正面近景"],
  "frames": [
    {
      "index": 1,
      "beat": "端起碗",
      "edit": "保持人物身份、发型、服装、背景和镜头构图完全不变；让人物双手端起饭碗，准备开吃。",
      "expect": "碗被端起，人物姿势开始变化",
      "min_change": 0.002,
      "max_change": 0.35
    }
  ]
}
```

服务端校验：帧数必须等于 N；`index` 连续；`edit` 非空且包含保持子句；`min_change < max_change`；
缺失字段补默认值；非法帧用规则模板补。

### 4.2 让 LLM 真的看到参考图

Ollama 的 `qwen3.5:9b` 支持 vision。把参考图缩到最长边 448、PNG base64 放进
`messages[1].images`，并在 user 里写「参考图内容以附图为准，不要臆造」。不支持 vision 时
显式降级为纯文字，不报错（沿用 `server/prompt_polish.py` 的判定思路）。

### 4.3 采样参数

- `format="json"`；`think=false`（qwen3.5 的 thinking 会吃光 token，主项目已踩过）；
- temperature 0.7，top_p 0.9，num_predict 4096；
- 超时 180s；失败/空 content/解析失败 → 规则分镜兜底。

### 4.4 规则分镜兜底

按关键词识别常见题材（吃、跑、跳、挥手、变大、变色…），否则用通用节拍：
`起势 → 加速 → 更投入 → 第一次高潮 → 短暂停顿 → 二次加速 → 顶点 → 回落 → 收尾`。
每帧模板都带保持子句，保证 N 条永远可用。**LLM 只是增强，不是单点故障。**

---

## 5. 接力编辑

### 5.1 输入图角色

```
image1 = 上一张已通过的帧（第 1 帧时 = 参考图）
image2 = 原始参考图（全程不变，身份锚点）
```

提示词里明确写 `<image1>` 是当前画面、`<image2>` 是身份参考。主项目最多 10 张图，这里只用 2 张。

### 5.2 尺寸与显存

- 参考图先按目标尺寸（默认 512）做一次 contain/pad 到 32 倍数；之后 `size_mode=follow`；
- 512×512 + Turbo 8 步，单帧约 4~8 秒（模型热态）；12 帧约 1~2 分钟，重试另计；
- 一次只提交一帧，主项目队列不会被 12 个任务堵死；
- 用户中途取消：取消当前 job + 不再提交下一帧。

### 5.3 一致性旋钮

| 旋钮 | 默认 | 作用 |
| --- | --- | --- |
| `seed` | 固定 | 减少帧间随机跳变；每帧记录实际 seed 便于回放 |
| `consistency_lora` | 开 | 主项目普通编辑默认挂「一致性无偏移」LoRA |
| `denoise` | 1.0 | 保持主项目编辑语义；想更保守可 0.85，但可能改不动 |
| `turbo` | 开（8 步） | 512 尺寸足够，速度优先 |
| `negative_prompt` | 空 | 需要时加「模糊、变形、多手、换脸」 |

---

## 6. 代码自检（核心）

### 6.1 指标（Pillow + numpy，无新依赖）

对「上一帧 A」与「新帧 B」计算：

| 指标 | 算法 | 用途 |
| --- | --- | --- |
| `size_ok` | 宽高严格相等 | 接力必须同尺寸 |
| `alpha_ok` | 参考图有 alpha ⇒ B 也有 alpha；否则不要求 | 透明通道不丢 |
| `changed_ratio` | `max(|RGB_B-RGB_A|) > 12` 的像素占比 | 判断「改了没有 / 改了多少」 |
| `mae` | RGB 平均绝对误差（0~255） | 整体偏差 |
| `ssim` | 128×128 灰度全局 SSIM | 结构是否还像上一帧 |
| `hist_corr` | 32 bin RGB 直方图相似度（交集，0~1） | 色调/光照是否跳变 |
| `bbox_iou` | alpha bbox（有 alpha 时） | 主体位置是否跑飞 |
| `first_last_ssim` | 末帧 vs 首帧 | `seamless` 闭环检查 |

### 6.2 判定规则

硬门槛（任一不过即 fail）：

```text
size_ok == true
alpha_ok == true
changed_ratio >= 0.002          # 完全没改 = 失败
changed_ratio <= 0.60           # 整图换掉 = 失败（编辑会整图重绘，比例天然偏高）
ssim >= 0.40                    # 结构崩了 = 失败
mae <= 55                       # 色差过大 = 失败
hist_corr >= 0.35               # 色调跳变 = 失败
```

**软区间**（planner 每帧给 `min_change` / `max_change`，默认 0.002~0.35）：

```text
min_change <= changed_ratio <= max_change
```

软区间只影响评分与报告里的 `below_expected_band` / `above_expected_band` 提示，
不单独判失败——LLM 无法精确预判图像模型会重绘多少像素，硬卡它会误杀正常帧。

`seamless=true` 时额外：`first_last_ssim >= 0.35`。

### 6.3 失败原因 → 纠错指令

| 失败码 | 追加到重试提示词 |
| --- | --- |
| `too_small` | 改动太小：请把动作做大一些，明确改变姿势/道具状态，但保持身份与背景不变。 |
| `too_large` | 改动过大：保持人物脸型、发型、服装、背景、构图完全不变，只改变指定动作。 |
| `size_mismatch` | 输出尺寸必须与输入完全一致，不要裁切或缩放。 |
| `alpha_lost` | 必须保留透明背景与 alpha 通道。 |
| `structure_broken` | 人物结构崩坏：保持五官、四肢、服装完整，只做小幅动作变化。 |
| `color_jump` | 色调跳变：保持原有光照、色温与背景颜色。 |
| `loop_broken` | 末帧需要回到接近首帧的姿态，形成无缝循环。 |

### 6.4 重试策略

- 每次重试都从**上一张已通过帧**出发，不使用失败帧作为输入；
- 最多 `max_retries=3`（含首次，即最多生成 3 次）；
- 每次尝试独立落盘、独立记录指标；全失败时保留**得分最高**的一张供用户参考；
- 全失败后 run 进入 `blocked`，前端提供「改提示词重试 / 用这张 / 跳过」。

得分（用于选最佳失败帧）：

```text
score = 0.35*ssim + 0.25*hist_corr + 0.25*(1 - |mae|/255) + 0.15*区间命中
```

---

## 7. 人工审核

前端每帧一个卡片：

- 缩略图、序号、beat、当前提示词、状态（待生成/生成中/通过/重试中/阻塞）；
- 展开：大图、每次尝试的指标表、失败原因、实际 seed、job_id；
- 操作：编辑提示词并重试、原样重试、接受当前最佳、跳过（后续帧仍从上一张通过帧接力）；
- 顶部总进度：`第 5/12 帧 · 第 2/3 次尝试 · 采样 6/8`；
- 全部通过后「确认并做动画」按钮才可用。

---

## 8. 交接 animation_kit

确认后：

1. 把 N 张最终帧按顺序 `POST /api/import/frames` 到 animation_kit（或直接调其 core）；
2. 默认参数：`fps=12`、`hold=1`、`loop=0`、`direction=forward`；
3. 导出 `gif`（默认 512、256 色、透明开）、可选 `apng` 无损；
4. 报告里同时给出 GIF、APNG、PNG 序列路径与每帧提示词。

GIF 天生 256 色 + 1 位透明，**不承诺逐像素一致**；要保真用 APNG。

---

## 9. 数据模型（run.json）

```json
{
  "version": 1,
  "id": "loop-20261107-153012-ab12cd34",
  "status": "running",
  "idea": "让图片中的小人疯狂吃米饭",
  "reference": {"url": "/files/uploads/up-....png", "width": 512, "height": 512, "has_alpha": false},
  "settings": {
    "frames": 12, "size": 512, "steps": 8, "cfg": 1.0, "denoise": 1.0,
    "turbo": true, "seed": 20261107, "max_retries": 3, "seamless": true,
    "preserve": ["人物身份", "发型", "服装", "背景", "镜头构图"],
    "check": {"min_change": 0.002, "max_change": 0.35, "min_ssim": 0.40,
              "max_mae": 55, "min_hist": 0.35}
  },
  "plan": {"title": "...", "subject": "...", "anchors": [], "frames": []},
  "frames": [
    {
      "index": 1, "beat": "端起碗", "prompt": "...", "status": "accepted",
      "acceptedUrl": "frames/f01.png",
      "attempts": [
        {"n": 1, "prompt": "...", "jobId": "...", "url": "frames/f01_a1.png",
         "elapsedMs": 6200, "metrics": {"ssim": 0.71, "mae": 12.3, "changed_ratio": 0.08},
         "verdict": "pass", "reasons": []}
      ]
    }
  ],
  "animation": {"fps": 12, "projectId": null, "gif": null, "apng": null},
  "log": [{"t": "15:30:12", "stage": "planning", "message": "LLM 分镜完成：12 帧"}]
}
```

落盘：`runs/<id>/run.json`（原子写）+ `frames/fNN.png` + `frames/fNN_aN.png` + `report.html`。

---

## 10. API 契约（新模块，端口 8720）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/loop/runs` | 建 run（参考图 + idea + settings），返回 run |
| POST | `/api/loop/runs/{id}/plan` | 只跑分镜，返回 N 条指令 |
| POST | `/api/loop/runs/{id}/start` | 开始接力生成 |
| GET | `/api/loop/runs/{id}` | 全量状态（帧、尝试、指标、进度） |
| PATCH | `/api/loop/runs/{id}/frames/{i}` | 改提示词 / 接受 / 跳过 |
| POST | `/api/loop/runs/{id}/frames/{i}/retry` | 单帧重试（可带新提示词） |
| POST | `/api/loop/runs/{id}/approve` | 确认，进入导出 |
| POST | `/api/loop/runs/{id}/export` | 出 GIF/APNG |
| POST | `/api/loop/runs/{id}/cancel` | 取消当前 job 与后续帧 |
| GET | `/api/loop/health` | 主项目可达性、Ollama 模型、队列状态 |

进度统一用 1s 轮询（与主项目一致），返回 `{stage, frame, attempt, done, total, percent, message}`。

---

## 11. 前端信息架构

```
┌─────────────────────────────────────────────────────────────┐
│ 参考图 + 想法输入 + 帧数/尺寸/无缝/重试次数     [开始分镜]   │
├──────────────────────────────┬──────────────────────────────┤
│ 帧条（横向 12 张卡片）        │ 选中帧检查器                  │
│ [01 端起碗 ✓]                │ 大图                          │
│ [02 大口扒饭 ✓]              │ 提示词（可编辑）              │
│ [03 腮帮鼓起 ⟳2]             │ 指标：SSIM/MAE/改动比例       │
│ ...                          │ 尝试记录 1/2/3 + 失败原因      │
│ [12 见底 ✓]                  │ [重试] [接受] [跳过]          │
├──────────────────────────────┴──────────────────────────────┤
│ 进度条：第 5/12 帧 · 第 2/3 次尝试 · 采样 6/8                 │
│ 实时日志                                                     │
├─────────────────────────────────────────────────────────────┤
│ 全部通过 → [确认并做动画] → fps/hold/loop → [导出 GIF]        │
└─────────────────────────────────────────────────────────────┘
```

与主项目一致：原生 ES module，零构建；静态文件 `Cache-Control: no-cache`。

---

## 12. 性能、显存与风险

| 风险 | 对策 |
| --- | --- |
| 12 帧串行太慢 | Turbo 8 步 + 512 尺寸；模型常驻；单帧 4~8s |
| 接力越跑越偏 | 每帧带原图 image2 + 固定 seed + 一致性 LoRA + 自检 |
| 主项目服务没起 | `/api/loop/health` 明确提示；Mock 模式可离线演示 |
| 主项目正在测试 | 只调公开 HTTP，不 import 主项目、不改代码；一次只占一个队列位 |
| LLM 分镜跑偏 | 严格 JSON 校验 + 规则兜底 + 前端可改任意一条 |
| 坏帧污染后续 | 自检失败暂停（blocked），从上一张通过帧重试 |
| GIF 透明发黑 | 默认白底或明确透明；导出同时给 APNG |
| 512 细节不足 | 允许 640/768；GIF 小图足够，需要高清走 PNG 序列 |

---

## 13. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M0（本次）** | 独立包 + 真实 LLM 分镜 + Mock 生成 + 自检/重试 + HTML 报告 + GIF | 12 帧产物、失败重试可见、GIF 可播放 |
| M1 | 接主项目 `/api/edit` 真生成 | 12 帧真图，尺寸/alpha/指标与 Mock 一致 |
| **M2（已完成）** | FastAPI + 原生 ES module 前端 | 进度、卡片、单帧重试、确认 |
| M3 | 接 animation_kit 导出 | GIF/APNG/PNG 序列 + 报告 |

### M0 模拟的判定标准

1. 真实 `qwen3.5:9b` 能看图产出 12 条递进指令（失败则规则兜底，仍为 12 条）；
2. 循环逐帧生成，至少 2 帧的首次尝试被自检判失败并自动重试成功；
3. run.json 记录每帧每次尝试的指标与判定；
4. 生成 `report.html`（12 帧 + 提示词 + 指标 + 重试标记）与 `anim.gif`；
5. 全程不写主项目目录，只写 `still_loop/_data/`。

### M0 实际模拟结果（2026-11-07，本机）

```powershell
python -m still_loop.simulate `
  --reference "Qwen_image_2.1_00298.png" --crop 376,1128,376,376 `
  --idea "让图片中的小人疯狂吃米饭" --frames 12 --size 512 `
  --llm auto --fail-frames 5,9
```

| 项 | 结果 |
| --- | --- |
| 分镜 | `qwen3.5:9b` **看图**产出 12 条递进指令，9.3s，`source=llm` |
| 生成 | Mock，12 帧全部通过；共 14 次尝试 |
| 自检重试 | 第 5、9 帧首次被 `too_large/structure_broken/color_jump` 拦截，第 2 次通过 |
| 产物 | `anim.gif`（12 帧、512×512、约 83ms/帧、2.3MB）、`report.html`（12 卡片 + 14 次尝试明细） |
| 测试 | `python -m unittest discover -s still_loop/tests -t .` → 5 项通过 |

模拟图是几何变换（推近、轻微旋转/位移、色温），**不是真的吃米饭**；Mock 只用于验证
编排、自检、重试、进度、报告与 GIF 链路。真实画面需要主项目 `/api/edit` 起来后切
`MainProjectClient`。

### M2 可交互前端（已落地并实测）

```powershell
python -m still_loop.serve --open      # 默认 http://127.0.0.1:8720/
```

零构建：原生 ES module，`still_loop/web/` 下 `index.html` + `assets/app.css` +
`src/api.js` + `src/main.js`；`server/app.py` 用 StaticFiles 直接挂目录，1s 轮询
`GET /api/loop/runs/{id}` 刷新进度，不需要 WebSocket。

三栏工作台：

| 区域 | 内容 |
| --- | --- |
| 左 · 设置 | 参考图拖拽/选择、idea、帧数/尺寸/帧率/重试次数、循环衔接、透明、引擎（mock/main）、生成分镜/开始/取消/确认导出、最近 run |
| 中 · 舞台 | 四步进度条、进度文案与百分比、分镜来源（LLM/兜底/耗时/是否看图）、结果卡（GIF 预览 + 下载 + 报告）、12 张帧卡（状态徽标/尝试次数/提示词摘要）、日志 |
| 右 · 检查器 | 选中帧大图（棋盘格透明预览）、可编辑提示词、保存/重试该帧、最近一次尝试的指标与失败原因 |

实测（2026-11-07，Mock 引擎）：

1. 浏览器上传参考图 → idea「让图片中的小人疯狂吃米饭」→ 12 帧分镜 5.6s（LLM 已看图）；
2. 开始接力：12 帧全部通过，第 5、9 帧首次自检失败后自动重试成功（卡片显示「尝试 2 次」）；
3. 打开第 6 帧改词 → 「重试这一帧」→ 第 7~12 帧自动回到 pending → 「继续接力生成」补齐；
4. 「确认并导出 GIF」→ 2.3MB、12 帧 @12fps，页面内可直接播放并下载。

本轮实测发现并修掉的问题：

| 问题 | 处理 |
| --- | --- |
| 轮询时偶发 `PermissionError: run.json`（500） | `store.save_run/load_run` 对 Windows 文件占用做 6 次短重试 |
| 单帧重试直接 `failed` | `retry_frame` 调 `_run_frame` 少传 `generator`，参数整体错位 |
| LLM 第 1 帧输出「与参考图完全一致」的静止帧 | 系统提示改为「第 1 帧必须出现第一个可见动作」，否则真模型会因 `too_small` 连续失败 |
| 导出完成后进度文案仍停在「正在导出 GIF」 | 导出结束写入 `progress={stage:done,percent:100}` |

#### 视觉对齐（主项目设计令牌 / Apple 风格）

- 令牌来源：直接复制 `web/assets/css/theme.css` 的浅色与 `html[data-theme="dark"]` 深色变量
  （`--bg:#faf8f4`、`--accent:#2f6b62`、`--violet:#b87340`、`--radius:16px`、SF 字体栈、`--shadow`），
  组件范式对齐 `shell.css` / `app.css`：64px glass 顶栏、白底 1px 描边面板、34px 高 10px 圆角按钮、
  分段胶囊步骤条、导航胶囊、hairline 分组。
- 主题：右上角圆形按钮一键切换，`localStorage('still-loop-theme')` 记忆，首次访问跟随系统
  `prefers-color-scheme`；`<html data-theme>` 与主项目同一套语义。
- 布局：`312px / minmax(0,1fr) / 352px` 三栏；`1180px` 收成两栏（检查器跨列到下方）；
  `880px` 单列并把参考图拖拽区从 1:1 收到 210px 高。
- 验证：1440 × 900 浅色/深色、1180 两栏、880 单列均无横向溢出；帧卡选中、检查器、日志、
  分镜/接力/审核/导出四步状态在浏览器实测通过。
- 主操作区（`.actions`）在设置面板内 `position: sticky; bottom: 0`，配 24px 渐变遮罩，
  1440×900 下「生成分镜 / 确认并导出 GIF」常驻可见；为此把 `.setup-panel` 的
  `overflow: hidden` 改为 `overflow: clip`（`hidden` 会生成滚动容器，使 sticky 失效）。

#### 宫格切分作为可选来源（`source=sheet`）

在同一个工作台里把「来源」做成顶部两段胶囊：**连续接力**（默认，走 LLM 分镜 + 接力编辑）
与 **宫格切分**（可选，直接切成品宫格图）。宫格模式复用 `animation_kit.core.sheet.split_sheet`，
规则与主项目 `server/imageops.py::op_grid` 一致：整数裁剪、`trim=union` 保留格内相对位移、
统一尺寸只透明补边不缩放。

- API：`POST /api/loop/runs/sheet`（`file` + `settings` + `rows/columns/row_gap/column_gap/order/trim`）；
  `runner.create_sheet_run` 建 `source=sheet` 的 run，`status=review`，每帧直接 `accepted`（`attempts`
  记一条 `宫格切分导入，无需重新生成`），`settings.preserve=[]`（没有生成步骤，不该显示"保持：人物身份…"）。
- 状态机差异：sheet run 的 `canStart=false`，`/plan` 与 `/frames/{i}/retry` 直接 400 拒绝，
  前端隐藏「开始接力生成」、禁用「保存提示词 / 重试这一帧」，主操作变「切分宫格」。
- 前端参数：行、列、横间隔、纵间隔、顺序（行优先 / 蛇形 / 列优先）、裁边（并集 / 逐格 / 不裁）；
  网格参数出现时，帧数/重试/无缝/透明/引擎全部禁用。
- 实测：658×658、间隔 6px 的 4×4 总表 → 16 帧 256×256 RGBA，行优先取色与调色板一致，
  approve + export 得到 16 帧 @12fps 的 `anim.gif`。

#### Mock 引擎为什么"动作没变"，以及劣化/偏色修复

Mock 是**纯 Pillow 的模拟出图**：只做几何摆动（缩放 / 旋转 / 位移 / 色温），
不调用任何扩散模型，所以它**不可能改变画面内容**——看不到小人在吃米饭是预期行为。
要看真实动作必须把引擎切到「主项目真实生成」（`engine=main`，需要 8700 在线）。

旧版 Mock 在 `previous.image` 上逐帧叠加变换，12 次重采样后必然糊化，且色温只朝一个方向累积，
肉眼可见发黄。现改为：

- 以参考图为锚点（`_anchor_image()` 只缓存一次），每帧**一次性**合成一个 AFFINE 矩阵
  （`a=cos/sx, b=sin/sx, d=-sin/sy, e=cos/sy`，含基准放大 1.04 防露边）；
- 色温用 `sin(beat)` 来回摆动，首末帧为 0，不再单向累积；
- 实测第 1 帧与第 12 帧清晰度完全一致（14.184 / 14.184），平均 RGB 完全一致，无一帧触发重采样累积。

#### 色彩漂移硬门槛（相对参考图）

自检原有 `hist` 是**帧间**比较，只能发现"这一帧相对上一帧变了"，发现不了整条链慢慢变黄。
`checker.check(..., anchor=reference.image)` 现在额外计算：

| 指标 | 含义 | 默认阈值 | 失败原因 |
| --- | --- | --- | --- |
| `ref_hist` | 与参考图直方图交集 | ≥ 0.55 | `color_drift` |
| `ref_color_delta` | 与参考图平均 RGB 的平均绝对差 | ≤ 18 | `color_drift` |

命中后重试提示为「整体色调相对参考图漂移过大：沿用原图的光照、色温与配色，不要重新调色或加滤镜」。
阈值可通过 `settings.check.min_ref_hist / max_ref_color_delta` 覆盖。Mock 实测 `ref_hist` 0.93~0.95、
`ref_color_delta` 2.5~4.0，全部在门槛内。


---

## 14. 对齐 2026-11-07 主项目大更新

> 本节用于把 still_loop 对齐 2026-11-07 的主项目更新。
> 结论先说：still_loop 的编辑入参本来就按 `images` 数组写，核心契约没被打破；
> 需要补的是「PE 规范、主项目质量回执、模型/预设、animation_kit 的导出与稳定化、前端令牌」五块。
> 落地范围：**当前只改 `still_loop/` 与本文档**，主项目 `server/`、`web/`、`animation_kit/` 一行未动。

### 14.1 已核对的主项目当前契约

| 能力 | 现在的真实行为 | 位置 |
| --- | --- | --- |
| 编辑入参 | `images` 数组，**第 1 张是编辑目标（姿态参考）**，其余为场景参考，最多 10 张；普通编辑 `prompt` 必填，`task.mode=remove/outpaint` 可空 | `server/main.py` L742-L756、`server/pipeline.py` L202-L207 |
| 编辑参数 | `size_mode`（follow/custom/ratio/fixed_point）、`fit`、`preprocess`、`steps/cfg/denoise/sampler/scheduler`、`turbo`、`consistency_lora`、`local`、`zero_shift`、`task.mode`（edit/inpaint/replace/remove/outpaint）、`outpaint`、`preset` | `server/main.py` L775-L872 |
| 模型切换 | t2i 可选 `qwen` / `moss`；**edit 只有 `qwen`**——MOSS 档案是 `capabilities.edit=false`，槽位表里 edit 也固定 Qwen。`payload["model"]` 有校验，传 MOSS 做编辑会失败 | `server/models.py` L106/L139、`server/model_slots.py` L57-L68、`server/pipeline.py` L657 |
| 任务回执 | `GET /api/jobs/{id}` 除 `images/progress` 外还有 `align`（canvas/source/work 尺寸）与 `quality`（`size_match` / `outside_max_abs` / `preset` / `model`）；另有 `/api/jobs/{id}/replay.json` 可下载完整复现参数 | `server/jobs.py` L107-L127、`server/pipeline.py` L823/L1009 |
| 提示词润色 | `POST /api/polish`：`mode=t2i|edit`、`image_model=qwen|moss`（**edit 模式只能传 `qwen`**，MOSS 没有编辑能力）、可带 `images`（视觉模型真的看图）、返回 `rewritten_prompt / wh_ratio / ratio_follow`。**本方案不逐帧调它，只复用 `load_system_prompt("edit","qwen")` 的 PE 原文**（批量出 12 条） | `server/main.py` L624-L678、`server/prompt_polish.py` L68-L98、L262-L270 |
| 能力发现 | `/api/options` 给 `capabilities`（size_modes / task_modes / max_ref_images / rgba…）、`model_profiles`、`defaults.edit`；`/api/meta` 给 `edit_presets` | `server/main.py` L542-L607、L610-L620 |
| 动画服务 | `animation_kit` 已是独立 HTTP 服务（默认 `127.0.0.1:8710`）：`/api/import/sheet`、`/api/import/frames`、`/api/align`（去抖动）、`/api/color-match`（去闪烁，可 revert）、`/api/export`（gif/apng/webp/png 序列，返回 `pixel_exact`、`resampled_ids`） | `animation_kit/server/app.py` L242/L314/L378/L403/L454、`animation_kit/config.py` L21-L22 |
| 前端规范 | 设计令牌**单一来源** `web/assets/css/theme.css`（禁止硬编码颜色，双主题 `html[data-theme]`）；外壳 `#app-shell / #sidebar / #topbar / #viewport / #toast-root / #modal-root`；页面注册在 `web/src/app.js` 的 `NAV_GROUPS / TABS / pages`（懒加载）；文案在 `web/src/i18n.js` | `web/assets/css/theme.css` L2-L125、`web/index.html` L52-L74、`web/src/app.js` L59-L102 |

### 14.2 差异清单与优先级

| 编号 | 差异 | 影响 | 优先级 |
| --- | --- | --- | --- |
| D1 | 12 段提示词由 still_loop 自己拼，既没复用 Qwen 的 edit PE 规范，也没有一次成型的结构化产出（MOSS 的 PE 只服务 t2i，与此无关） | 真接主项目时出图指令风格不一致，废片率变高 | **P0** |
| D2 | 宫格切分与 GIF 编码已经在用 animation_kit 的**库**（`split_sheet` / `export_gif`），但没接它的**服务**（8710） | 拿不到 `align` / `color-match`、`pixel_exact`、APNG/WebP/PNG 序列与导出后的 probe 校验 | **P0** |
| D3 | 自检只用自研 SSIM/MAE/直方图，忽略 `job.quality` 与 `job.align` | 主项目已经算好的"是否越界/尺寸是否一致"被浪费，还可能重复判 | **P1** |
| D4 | 没有「编辑模型」选择：既没读 `model_profiles[*].capabilities.edit`，也没透传 `preset` | 当前只有 Qwen 能编辑，但以后接入新模型就得改代码；应做成数据驱动 | **P1** |
| D5 | 前端自建 `app.css` 硬编码暖白/墨绿，未引用 `theme.css` 令牌 | 主项目再调色就会割裂，深色模式要手动维护 | **P1** |
| D6 | 没有用到 `align`（去抖动）/`color-match`（去闪烁） | 12 帧接力的轻微位移与色偏只能靠重试，成本高 | **P2** |
| D7 | 独立跑在 8720，没有在主前端注册入口 | 用户要在两个端口间切 | **P2** |
| D8 | run 没有保存 `replay.json` | 出问题无法一键复现某一帧的参数 | **P2** |

### 14.3 落地顺序（三步，每步单独可验收）

**第 1 步 · 契约对齐（不动 UI，改动最小）**

1. 改造 `still_loop/core/planner.py`：**一次 LLM 调用**同时完成"分镜 + PE 润色"，**不再拆出单独的 polisher 环节**。
   - system 直接用主项目 `server/prompt_polish.py::load_system_prompt("edit", 选中的编辑模型)` 的 PE 原文，再追加"按接力顺序输出 N 条编辑指令"的 JSON 契约；
   - user 给一句话 + 参考图信息（必要时附图），输出就是 N 条可直接送 `/api/edit` 的 prompt；
   - 不走 `/api/polish` HTTP：它的契约是"一次一条 `rewritten_prompt`"，这里要"同规范、批量 N 条"，复用它的 PE 原文与 `EDIT_SAMPLING` 采样参数即可；
   - 回退：JSON 不合法重试 1 次，仍失败则用现有规则分镜模板（离线可用）。
   - 成本：1 次调用，输出约 12×80 字（云端约 2–3k 输出 token），比 12 次润色省一个数量级。
2. 启动时读一次 `/api/options` 与 `/api/meta`：按 `model_profiles[*].capabilities.edit === true` 生成「编辑模型」下拉（当前只有 `qwen`；MOSS 因 `edit=false` 不出现），默认取 `defaults.edit`；该值同时决定 PE 规范与 `/api/edit` 的 `payload.model`，`preset` 一并透传。
3. 自检合并主项目回执：`job.quality.size_match === false` 或 `quality.outside_max_abs > 阈值` 直接判 `size_mismatch`，与本地 `checker` 结果取并集（不替换原有指标）。
4. 每次 attempt 落一份 `replay.json`（直接存主项目 `/replay.json` 的内容），run 目录下按帧命名。
- 验收：真机 12 帧全部 `accepted`；任一帧故意改坏能触发重试；帧尺寸与参考图严格一致。

**第 2 步 · 导出与稳定化委托 animation_kit**

1. 宫格模式：`POST /api/projects` 建项目 → `POST /api/import/sheet` 切分，把 `runner.create_sheet_run` 里的进程内 `split_sheet` 调用换成服务调用（进程内调用保留为 8710 离线兜底）。
2. 审核通过后导出：`POST /api/import/frames` 上传 12 帧 → 可选 `POST /api/align`、`POST /api/color-match` → `POST /api/export`，把 `pixel_exact`、`resampled_ids`、帧时长回写到 run。
3. 进程内 `animation_kit.core.encode.export_gif` 保留为兜底路径（当前已经在用，不是另写一套）。
- 验收：导出的 GIF 帧序/时长与审核顺序一致；`pixel_exact=true`；animation_kit 离线时自动回退且用户体验不变。

**第 3 步 · 前端合流**

1. 把 `still_loop/web/assets/app.css` 里硬编码的颜色全部换成 `theme.css` 的同名令牌（复制一份 `theme.css` 到 still_loop 静态目录，或用同步脚本生成，避免跨目录引用）。
2. 若主项目允许改 `web/src/app.js`，把 still_loop 注册成 `TABS` 里的一个页面（懒加载 + iframe 指向 8720）；**这一步会修改主项目文件，需单独授权**。
- 验收：深浅色切换正常、与主项目同屏无风格落差、入口只需一个端口。

### 14.4 明确不做的事

- 不修改 `server/`、`web/` 主项目源码（第 3 步第 2 条除外，且需授权）。
- 不替换 still_loop 自己的 run 存储、状态机与审核界面。
- 不删除 Mock 引擎（离线验证、自检回归仍要用）。
- 现在不把 MOSS 接进接力链路（它 `capabilities.edit=false`、`rgba=false`），但**模型选择保持数据驱动**：将来 MOSS 或任何新模型只要在主项目档案里声明 `edit: true`（并配好 PE 与槽位），still_loop 不需改代码即可在下拉里出现。
- 不把 12 帧生成改成"主项目内建批量"——主项目目前没有序列生成能力。

### 14.5 编辑模型切换（保留能力，为后续模型预留）

**数据源**：`GET /api/options` 的 `model_profiles`（每项含 `label` 与 `capabilities{t2i,edit,rgba}`）与 `defaults.edit`。

**规则**

1. 下拉只列 `capabilities.edit === true` 的档案，默认 `defaults.edit`；没有任何可用项时禁用并提示。
2. 选中 id 原样用于 `/api/edit` 的 `payload.model`，同时作为 `/api/polish` 的 `image_model`（避免写死 `qwen`）。
3. `capabilities.rgba === false` 的模型在选择时给一条警告——still_loop 默认要保留透明通道。
4. `/api/options` 拉取失败时回退 `qwen` 并提示"模型列表不可用"，不阻塞出图。
5. run 里记 `settings.model` 与对应 `label`，审核页显示 chip，重试沿用同一模型；切换模型需要新建 run（不同模型的帧不混在同一条链里）。

**后续接入一个新编辑模型，主项目侧只需要四处**（仍然不碰 still_loop）：

1. `server/models.py` 增加 profile，`capabilities.edit = True`；
2. `server/model_slots.py` 的 edit 槽位登记该模型；
3. `data/pe_system_prompt_<model>_edit.txt` 提供该模型的 PE 规范；
4. `server/prompt_polish.py` 的 `MODEL_SYSTEM_PROMPT_FILES` 增加 `"<model>": {"t2i": ..., "edit": ...}`。

这四处齐了，still_loop 下一次拉 `/api/options` 就会自动出现新模型，零代码改动。

> 当前只有 `qwen` 满足 `edit=true`；MOSS 是 `edit=false`、`rgba=false`，所以下拉暂时只有一项——这是数据驱动后的自然结果，不是写死。

### 14.6 已确认的决定 & 待确认

**已定**

1. **润色：方案 C** —— 分镜与 PE 润色合并为一次结构化调用，不逐帧调 `/api/polish`（见 14.3 第 1 步）。
2. **导出：库为主、服务按需** —— 算法归 animation_kit；默认走进程内 `animation_kit.core.encode`（无网络依赖）；只有勾选"去抖动/去闪烁/APNG·WebP/需要 pixel_exact 报告"时才调 8710 的 `/api/align`、`/api/color-match`、`/api/export`。

**待确认**

1. **入口形态**：still_loop 最终合并进主项目作为一个功能（已定），但**当前阶段不动主项目代码**，先在 `still_loop/` 独立目录把准备工作做完。
   遗留待定：合并方式选「注册为主前端的一个页面（懒加载，仍指向 8720）」还是「把 still_loop 的 service 搬进 `server/`、前端页面搬进 `web/src/pages/`」——这一步要改主项目文件，需单独授权。

### 14.7 本轮已落地（只动 still_loop/）

| 项 | 落点 | 状态 |
| --- | --- | --- |
| 一次调用出 N 条 PE 指令 | `core/planner.py`：`plan_with_llm` 用 `data/pe_system_prompt_edit.txt` 原文 + `BATCH_CONTRACT`，`plan["pe"]={model,file,chars}`；失败重试 1 次后回退规则分镜 | ✅ 实测 `source=llm`、`pe=pe_system_prompt_edit.txt`、10494 字符、`attempts=1`、4/4 条命中 `<image1>/<image2>` |
| 编辑模型/预设透传 | `core/schema.py` 新增 `settings.model / preset`；`core/generator.py` 写入 `/api/edit` 的 `model`、`preset`；`server/app.py::_main_options` 从 `/api/options` 过滤 `capabilities.edit`，从 `/api/meta` 取 `edit_presets` 并只保留 `task_mode=edit` 的项 | ✅ 下拉 5 个预设，默认 `chain_mask`（「连续编辑·遮罩」，接力首选）；主项目离线时回退 `qwen`、预设为空 |
| 主项目质量回执入自检 | `core/checker.py` 新增 `q_size_match / q_outside_max_abs` 与 `size_mismatch / edge_bleed` | ✅ `job.quality` 已并入 attempt 指标 |
| 导出格式与稳定化 | `core/runner.py::export_animation` + 新增 `core/anim_client.py`；`gif/apng/webp` 三格式，8710 按需 `/api/align`、`/api/color-match`、`/api/export`，不可用自动回退本地 | ✅ 实测 webp=pillow、apng=pillow（`anim.png`）、gif=animation_kit（`anim.gif`） |
| 可复现 | `core/store.py::write_replay` 写 `replay.json` | ✅ 每次审核通过后生成 |
| 前端 | `web/index.html` 增「编辑模型/预设」与「导出」组；`web/src/main.js` 增 `loadOptions/readExport/applyRunSettings`，按钮文案随格式变化，非 GIF 用 `<video>` 预览 | ✅ 浏览器实测：GIF→WebP→APNG 按钮文案同步；主项目在线时健康线正常 |

**本轮未做**（按"不动主项目"约束）：宫格切分改走 8710 服务、注册主前端入口、`theme.css` 令牌替换。

### 14.8 定格动画（本轮追加）

GIF 本身已经是逐帧的，但"看起来不像定格"缺的是三样：视频容器、非匀速的停格节奏、手作材质。三者都在 `still_loop/` 内补齐。

| 能力 | 实现 | 位置 |
| --- | --- | --- |
| 视频输出 | `mp4`（libx264 `yuv420p` + faststart）/ `webm`（libvpx-vp9），RGBA 帧经 `rawvideo` 管道直接喂 ffmpeg，不落中间 PNG | `core/motion.py::encode_video` |
| 依赖探测 | 启动时 `ffmpeg -version` 探测；不可用时 `/api/loop/options.video.available=false`，前端禁用 mp4/webm 并回退 GIF，导出接口对视频格式返回 400 | `core/motion.py::ffmpeg_available`、`server/app.py` |
| 定格质感 | 逐帧烘焙：抖动+微旋转（`jitter`）、高斯颗粒（`grain`）、径向暗角（`vignette`）、通道 gain 漂移（`color_boil`）；每格独立随机种子，避免整段同噪 | `core/motion.py::stopmotion_frames` |
| 停格节奏 | `timeline.holds[]` 逐帧停格数（1–6），导出时按 hold 展开帧序列；默认 2 格 = 每张拍两帧 | `core/motion.py::expand_holds`、`runner.py::_holds_for` |
| 手作材质 | `style` ∈ 黏土/纸偶/毛毡/积木，由 `style_hint` 注入分镜提示词（LLM 与规则兜底都带），材质由模型画出来，不是后处理贴图 | `core/motion.py::style_hint`、`core/planner.py` |
| 双版本 | `motion.preset` = `both` / `smooth` / `stopmotion`；`both` 一次导出顺滑版（hold=1，`timeline.fps`）与定格版（hold 展开，`motion.fps`）两个文件 | `runner.py::export_animation` |
| 回读校验 | 导出后 `ffprobe -count_frames` 回填真实帧数/帧率/时长到 `animation.variants[*].probe` | `core/motion.py::probe_video` |
| 轨道编排板 | 审核通过后按帧列出缩略图，每帧 −/＋ 调停格数、全 1/2/3 格、实时显示总时长、按 hold 播放预览高亮当前帧 | `web/src/main.js::renderTrack`、`web/index.html` |

**实测（2026-11-07，Mock 4 帧，`style=clay`，`holds=[2,1,3,1]`）**

- `mp4` + `both` → `anim_smooth.mp4` 4 格 @12fps / 0.333s，`anim_stopmotion.mp4` 7 格 @8fps / 0.875s，`probe` 与声明一致；
- 同一 run 改导 `gif` + `both` → `anim_smooth.gif` / `anim_stopmotion.gif`，停格版 7 帧；
- LLM 分镜带材质前缀，实测首帧提示词为"…保持定格黏土动画质感，表面留有不规则的指痕与接缝…"。

**边界**

- 视频编码不进 `animation_kit`（它只有 gif/apng/webp/png 序列），8710 只参与图片格式的 `align` / `color-match`；视频版的"去抖动"由定格烘焙的抖动参数控制，不做帧间对齐。
- `report.html` 仍只展示 GIF 主版本；双版本卡片在前端结果区展示，不改 `animation_kit` 的报告。
- ffmpeg 可用路径可用环境变量 `STILL_LOOP_FFMPEG` 覆盖。

### 14.9 成长叙事（"种子→大树→种子"实测）

用一句话 + 一张种子参考图，真实跑通 10 帧定格片：`loop-20261107-230515-1e52cf10`，
10 帧全部一次通过（`changed_ratio` 3.9%→24.7%，单帧 2.7–3.7s），导出
`anim_smooth.mp4`（10 格 @8fps / 1.25s）与 `anim_stopmotion.mp4`（27 格 @8fps / 3.375s）。

| 结论 | 代价/做法 | 落点 |
| --- | --- | --- |
| `chain_mask` 预设 + 一致性 LoRA 会把主体形态死死锁住（同一句"长成大树"仅改动 0.36%） | 成长叙事必须 `preset=""` + `consistency=false`，同一句可达 12%~45% | `schema.consistency`、`generator._payload` |
| turbo8 / 8 步遵循度低：主体几乎不长，还会把平整背景画成颗粒布纹 | 成长叙事用普通采样 16 步、`cfg=4.0`；实测既能长出树冠，背景也干净 | `schema.steps/cfg/turbo` |
| LLM 会顺手写"保持构图与背景完全不变"和"+10%/+20%"，模型读成"别动" | `GROWTH_CONTRACT` 第 5/8 条禁止，并在 `_normalize_plan` 落稿前做字符串改写 | `planner.GROWTH_CONTRACT`、`_normalize_plan` |
| 每帧体量台阶不对齐就会停在幼苗 | 把 10 条绝对尺寸节拍梯子直接下发给 LLM（`体量阶梯…`），只许润色不许缩水 | `planner.GROWTH_BEATS`、`plan_with_llm` |
| 大幅生长会把整幅画连同背景重绘，背景逐渐变成一层泥点/布纹 | 每帧通过后追加一次"只清理背景"编辑（主体不动，实测改动 4%）；只对 `engine=main` 的成长叙事执行，失败保留原图 | `runner.CLEAN_BACKGROUND_PROMPT`、`_clean_background` |
| 种子→绿色树冠会让"相对参考图配色漂移"全部误判 | 成长叙事 `anchor=None`，不跟参考图比全局色 | `runner._run_frame` |
| 成长帧的全局像素/相似度天然越界（实测 SSIM 0.12、改动 74%） | `growth_thresholds()` 只放宽 `max_change/min_ssim/min_hist/max_mae`，尺寸、alpha、`job.quality` 仍照常判 | `planner.growth_thresholds` |
| 末帧"整棵植物消失"用增量措辞做不到 | 改成绝对删除措辞（"不再有任何树干、枝条、叶片或果实，只剩一小堆泥土和一颗种子"）可稳定出图 | `planner.GROWTH_BEATS` 归种 |

**运行环境注意**：主项目在连续出图时偶发连接重置甚至进程退出；`generator.wait()` 对幂等 GET 做了退避重试，
但若 8700 已退出，必须用 ComfyUI 自带解释器重启（`..\python\python.exe -s -m uvicorn server.main:app`），
用 anaconda python 会在 `/api/edit` 报 `No module named 'comfy_aimdo'`。

### 14.10 固定背景 + 主体透明层（`background: fixed`）

整幅重绘的问题在于「背景每帧都会被重新画一次」：即使提示词要求保持米白纸背景，
十几帧后也会累积出一层泥点/布纹，靠补一次"清理背景"编辑只能缓解。这里改成图层法：
**背景板只准备一次，之后每帧只生成主体并抠成透明通道，最后合成。**

| 步骤 | 做法 | 落点 |
| --- | --- | --- |
| 背景板 | 取参考图上/左/右三边（避开底部泥土）做二次曲面最小二乘拟合，外推整张背景，存 `background.png` | `core/matte.py::background_plate` |
| 键控参考帧 | 一次 `/api/edit`：把纸背景整张换成纯品红 #FF00FF，主体位置/材质不动（实测背景覆盖 97%） | `runner.KEY_REFERENCE_PROMPT`、`_key_reference` |
| 关键坑 | 后续每帧的 `<image2>` **必须也用键控参考帧**。用原始参考图时，模型会把它当"背景基准"又画回米白纸，整帧重绘 → key_lost | `runner._build_layer` 的 `reference` |
| 抠图 | 每帧独立估计键色（角点中位数）并与参考帧键色取覆盖率更高者；取最大连通域、填洞、内缩 1px 去粉边 | `core/matte.py::key_subject` |
| 去溢色 | 只压 `G<90 且 R、B 同时高于 G` 的像素。早期版本没有 `G<90`，把浅粉花瓣（如 255,178,203）整圈压成灰色 | `core/matte.py::_despill` |
| 灰紫蒙版 | 模型偶尔在开花帧主体外补一层淡灰紫底，用「低饱和 + 较亮 + 绿通道不低」剔除 | `key_subject` 的 `washed` |
| 合成 | 主体层叠到背景板，alpha 模糊后做 28% 接地阴影 | `core/matte.py::composite` |
| 末帧归种 | "植物完全消失"这种大跳跃模型只肯收掉树干、留下树冠；图层模式下末帧直接用键控参考帧复位，零模型调用、与第 1 帧严丝合缝 | `runner._is_return_beat`、`_run_frame` |
| 失败回退 | 键控参考帧 3 次仍抠不出（覆盖 <35%）→ 本次退回整幅重绘；单帧键色覆盖 <15% 或主体 <0.4% → 带纠错重试 | `_build_layer`、`_run_frame` |
| 产物 | 每帧同时保存 `fNN_key.png`（品红底原图）、`fNN_subject.png`（透明通道主体）、`fNN.png`（合成帧） | `store.save_frame_bytes` |

**实测（run `loop-20261109-232425-b81b80b7`，10 帧，512×512）**

- 10 帧全部一次通过，单帧 10–20s（16 步 / cfg 4.0，含抠图与合成）；
- 背景一致性：第 1–3 帧顶部背景带与第 1 帧的 MAE **0.000**；第 4 帧 1.08；
  第 5 帧起树冠已伸进该区域，数值上升是主体本身，不是背景噪声；
- 末帧与第 1 帧整图 MAE 1.73（末帧复用键控参考帧，闭环成立）；
- 导出 `anim_smooth.mp4`（10 格 @8fps / 1.25s）与 `anim_stopmotion.mp4`（27 格 @8fps / 3.375s）。

**已知边界**

- 合成是硬切：末帧从大树直接回到种子，不做溶解；要更柔和可以后续在两帧之间插过渡。
- 键控依赖模型"愿意给纯色底"；接近纯白/纯品红都能抠，但一旦模型画成渐变场景就会 key_lost，
  此时按纠错重试，连续失败仍会把该帧判 blocked，不会悄悄产出脏图。
- 抠图按"最大连通域"取主体，主体若被画面边缘裁断，边缘一圈会被内缩掉 1px。
- `background: auto` 只对成长/变形叙事启用 fixed；动作循环类仍走整幅重绘，避免动作片也被抠图。

---

## 15. 验收清单（真接主项目时）

- [ ] `/api/edit` 单帧成功，输出尺寸与输入严格一致；
- [ ] 有 alpha 的参考图，12 帧全部保留 alpha；
- [ ] `job.quality.size_match === true` 且 `outside_max_abs` 在阈值内；
- [ ] 12 条提示词由**一次**结构化调用产出，且复用 Qwen 的 edit PE 系统提示词；LLM 不可用时回退规则分镜；
- [ ] 自检失败时确实从上一张通过帧重试，而不是从失败帧；
- [ ] 3 次失败后 run 进入 blocked，不会继续生成后续帧；
- [ ] 取消后不再提交新帧，当前 job 被 cancel；
- [ ] 用户改提示词后只重跑该帧，后续帧自动按新帧接力；
- [ ] 每帧 `replay.json` 存在且可回灌；
- [ ] 确认后 GIF 帧序、时长、循环正确（animation_kit 导出时 `pixel_exact=true`）；
- [ ] 除第 14.3 第 3 步第 2 条外，全流程不修改主项目任何文件。
