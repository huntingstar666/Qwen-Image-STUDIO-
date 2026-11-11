# still_loop 交接文档

> 交接时间：2026-11-11 ｜ 交接范围：`<PROJECT_ROOT>\still_loop\`（独立服务）+ `docs\` 下的设计记录
> 一句话：参考图 + 一句话（或手写分镜）→ LLM/手写分镜 → 逐帧调用主项目 `/api/edit` → 代码自检与重试 → 人工审核 → 定格动画导出。

---

## 0. 先读：四条硬约束

1. **不改主项目源码**：`server/`、`web/`、`animation_kit/` 一律不动。所有改动只落在 `still_loop/` 与 `docs/`。
   重启主项目服务属于运行时操作，不算改代码。
2. **主项目必须用 ComfyUI 自带 Python 启动**：
   `<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe -s`。
   用 anaconda 的 python 启动，`/api/edit` 会报 `No module named 'comfy_aimdo'`。
3. **still_loop 不 import 主项目代码**，只通过 HTTP 调 `8700`。
4. **前端已补齐**：手写提示词、independent 接力、宽高画布、多图/素材仓库导入、轨道编排、
   自动化流水线（宫格切分 + 逐格精修 + 中间结果可改）均已接入，仍是零构建 ES module。
   主项目若要嵌入，用 iframe 打开 `http://127.0.0.1:8720/?embed=1`，会隐藏侧栏与顶栏装饰。

---

## 1. 服务与启动

| 服务 | 端口 | 作用 | 启动方式 |
| --- | --- | --- | --- |
| 主项目 | 8700 | 出图/编辑/任务队列 | `...\python\python.exe -s -m uvicorn server.main:app --host 127.0.0.1 --port 8700` |
| still_loop | 8720 | 分镜、接力、自检、导出、Web 控制台 | `$env:PYTHONPATH="<PROJECT_ROOT>"; & "...\python.exe" -s -m still_loop.serve` |
| 动画稳定化 | 8710 | 去抖/配色（可选） | 默认不启动；`export.align/color_match` 为 false 时完全不需要 |
| Ollama | 11434 | LLM 分镜（可选） | 只有走 LLM 分镜时才需要；手写提示词不需要 |

健康检查：

```powershell
(Invoke-RestMethod "http://127.0.0.1:8700/api/health").ok
(Invoke-RestMethod "http://127.0.0.1:8720/api/loop/health").ok
```

环境变量（都有默认值，见 `still_loop/config.py`）：

```
STILL_LOOP_DATA      数据目录，默认 still_loop/_data
STILL_LOOP_MAIN      主项目地址，默认 http://127.0.0.1:8700
STILL_LOOP_OLLAMA    LLM 地址，默认 http://127.0.0.1:11434
STILL_LOOP_ANIM      稳定化服务，默认 http://127.0.0.1:8710
STILL_LOOP_LLM       分镜模型，默认 qwen3.5:9b
STILL_LOOP_PE_DIR    PE 提示词目录，默认 <repo>/data
STILL_LOOP_EDIT_MODEL 默认编辑模型 qwen
STILL_LOOP_FFMPEG    ffmpeg 可执行名/路径，默认 ffmpeg
```

---

## 2. 代码地图

| 文件 | 职责 |
| --- | --- |
| `still_loop/serve.py` | 8720 入口（uvicorn + 静态页） |
| `still_loop/server/app.py` | 全部 HTTP 路由（见第 4 节） |
| `still_loop/core/schema.py` | 设置归一化（默认值、范围、宽高取整到 32） |
| `still_loop/core/planner.py` | LLM 分镜、兜底节拍（吃饭/成长/四季/通用）、叙事判定、阈值放宽 |
| `still_loop/core/generator.py` | Mock 生成器 + 主项目 `/api/edit` 客户端（上传/轮询/下载） |
| `still_loop/core/runner.py` | 主流程：建 run、分镜、逐帧、自检重试、审核、续跑、导出 |
| `still_loop/core/checker.py` | 尺寸/alpha/改动幅度/SSIM/直方图/色偏/主项目 quality 判定 |
| `still_loop/core/matte.py` | 固定背景：背景板拟合、品红抠图、去溢色、合成 |
| `still_loop/core/motion.py` | 定格烘焙（抖动/颗粒/暗角/色彩漂移）、停格展开、ffmpeg 编码 |
| `still_loop/core/anim_client.py` | 8710 稳定化客户端（可选，失败回退本地） |
| `still_loop/core/store.py` | run 落盘、帧读写、replay |
| `still_loop/web/index.html` | 8720 工作台外壳（侧栏 + 顶栏 + 视图容器） |
| `still_loop/web/assets/app.css` | 与主项目同源的设计令牌、组件与响应式 |
| `still_loop/web/src/ui.js` | 图标、Toast、弹窗、主题、表单等通用 UI |
| `still_loop/web/src/components.js` | 播放器、素材选择器、轨道、检查器、导出面板 |
| `still_loop/web/src/views/*` | 定格工坊 / 自动化流水线 / 连续编辑 / 素材仓库 / 我的项目 |

数据目录结构：

```
still_loop/_data/runs/<run-id>/
  run.json                 # 状态、分镜、每帧 attempts、settings、animation
  reference.png            # 归一化后的参考图（宽高见 settings.width/height）
  background.png           # 仅 fixed 模式：拟合出的固定背景板
  frames/fNN.png           # 审核/导出用的成品帧
  frames/fNN_aN.png        # 第 N 次尝试的预览
  frames/fNN_key.png       # 仅 fixed：品红底原图（下一帧的输入）
  frames/fNN_subject.png   # 仅 fixed：主体 RGBA 透明层
  anim_smooth.mp4 / anim_stopmotion.mp4 / anim.*
  contact_sheet.png        # 人工验收用（不是每轮自动生成）
```

---

## 3. 决策树：先判断属于哪种叙事，再选参数

| 叙事类型 | 建议 | 关键设置 |
| --- | --- | --- |
| 连续动作、表情、吃喝、循环 | 接力重绘 | `relay=chain`、`background=plain`、`consistency=true`、`preset=chain_mask` |
| 成长/变形（种子→大树） | 逐帧长大 | `relay=chain`、`background=fixed`（或 plain + 清理）、`consistency=false`、`preset=""`、`steps=16`、`cfg=4.0` |
| 同一主体换季节/配色/状态 | **手写提示词 + 独立出图** | `relay=independent`、`background=plain`、`consistency=false`、`preset=""`、`plan` 用 `/prompts` 直接给 |
| 没有明确节拍、需要自动拆镜 | LLM 分镜 | `/plan`；注意 LLM 会写“保持构图不变/天空”等与叙事冲突的措辞 |

**这条是踩过坑的结论**：固定节拍的片子（四季、表情九宫格）手写 8–12 条短提示词 + 每帧都从参考图出发，
比「LLM 分镜 + 接力重绘」更干净、更可控。LLM 分镜的价值只在“我没有节拍、帮我拆”。

---

## 4. API 速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/loop/health` | 健康检查 |
| GET | `/api/loop/options` | 模型、预设、风格、导出格式等选项 |
| GET | `/api/loop/runs` | 列表 |
| POST | `/api/loop/runs` | multipart：`file`、`idea`、`settings`(JSON)、`engine`(main/mock) |
| POST | `/api/loop/runs/sheet` | 宫格切分导入（已实现，本轮未复测） |
| GET | `/api/loop/runs/{id}` | 详情（含 frames/attempts/log/animation） |
| POST | `/api/loop/runs/{id}/plan` | LLM 分镜（body 可空） |
| **POST** | **`/api/loop/runs/{id}/prompts`** | **手写分镜：`{"prompts": ["...", "..."]}`，不调 LLM、不改写** |
| POST | `/api/loop/runs/{id}/start` | 开始/继续生成（已 accepted 的帧跳过） |
| POST | `/api/loop/runs/{id}/frames/{index}/retry` | 单帧重试，可带 `{"prompt": "..."}` 覆盖该帧提示词 |
| POST | `/api/loop/runs/{id}/approve` | 人工审核通过 |
| POST | `/api/loop/runs/{id}/export` | 导出，body 见下 |
| POST | `/api/loop/runs/{id}/cancel` | 取消 |
| GET | `/api/loop/library` | 代理主项目素材仓库，返回可直接展示的绝对 URL |
| POST | `/api/loop/runs/import-photos` | multipart 多图：`files`、`settings`、`prompts`、`name` |
| POST | `/api/loop/runs/from-materials` | JSON：`ids`、`settings`、`prompts`、`name`，服务端抓取素材 |
| POST | `/api/loop/runs/pipeline` | 宫格切分 + 逐格 AI 精修（`auto_start` 可关） |
| POST | `/api/loop/runs/{id}/pipeline` | 对已有照片/宫格轨道启动精修，可带 `indexes` / `settings` |
| PATCH | `/api/loop/runs/{id}/timeline` | 持久化帧率与逐帧停格 `holds` |
| POST | `/api/loop/runs/{id}/frames/order` | 重排导入/切分/流水线轨道 |
| POST | `/api/loop/runs/{id}/frames/{index}/restore` | 撤销 AI 精修，恢复原图 |
| DELETE | `/api/loop/runs/{id}/frames/{index}` | 删除导入轨道中的一帧 |

导出 body 示例：

```json
{
  "fps": 8,
  "export": {"format": "mp4", "align": false, "color_match": false},
  "motion": {"preset": "both", "fps": 8, "jitter": 1.1, "grain": 0.05, "vignette": 0.16, "color_boil": 0.03},
  "timeline": {"fps": 8, "holds": [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]}
}
```

最小流程（手写分镜）：

```powershell
# 1) 建 run（multipart，需带参考图）
# 2) 给提示词
Invoke-RestMethod "http://127.0.0.1:8720/api/loop/runs/<id>/prompts" -Method Post `
  -ContentType "application/json" -Body (@{prompts=@("...","...")} | ConvertTo-Json)
# 3) 生成 → 审核 → 导出
Invoke-RestMethod "http://127.0.0.1:8720/api/loop/runs/<id>/start"  -Method Post
Invoke-RestMethod "http://127.0.0.1:8720/api/loop/runs/<id>/approve" -Method Post
Invoke-RestMethod "http://127.0.0.1:8720/api/loop/runs/<id>/export" -Method Post -ContentType "application/json" -Body '<上面的 JSON>'
```

`retry` 一个中间帧会把该帧之后的 accepted 帧重置为 pending，这是有意行为（后续帧依赖它）。
在 `relay=independent` 下这个依赖其实不存在，但当前实现仍会重置，接手时可按需优化。

---

## 5. settings 字段（`core/schema.py`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `frames` | 12 | 2–48；用 `/prompts` 时会被提示词条数覆盖 |
| `size` | 512 | 正方形边长；`width/height` 为空时用它 |
| `width` / `height` | 0 | 非方形画布；0 表示按 `size`；自动取整到 32 的倍数，范围 256–1536 |
| `steps` / `cfg` / `denoise` | 8 / 1.0 / 1.0 | 成长/四季建议 16 步、cfg 4.0 |
| `turbo` | true | `turbo8_official`；成长叙事实测会把背景画脏，建议 false |
| `consistency` | true | 一致性 LoRA；**成长/形变必须 false** |
| `seed` | 20261107 | |
| `max_retries` | 3 | 1–5 |
| `seamless` | false | 首尾闭环判定（`min_loop_ssim`） |
| `engine` | mock | `main` 才是真实调用 |
| `model` / `preset` | qwen / "" | 预设如 `chain_mask` 会锁主体形态 |
| `background` | auto | `auto`=成长用 fixed、其余 plain；`fixed`=品红抠图+背景板；`plain`=整幅重绘 |
| `relay` | chain | `independent`=每帧都从参考图出发 |
| `style` | "" | `clay`/`paper`/`felt`/`lego` |
| `preserve` | 人物身份、发型… | 仅用于兜底分镜的“保持不变”措辞 |
| `timeline` | fps 12 | GIF/WebP 的帧率与每帧停留 `holds`（1–6） |
| `motion` | preset both | 定格烘焙参数；`both` 同时出 smooth 与 stopmotion |
| `export` | gif | `gif/apng/webp/mp4/webm`；`align/color_match` 需 8710 |
| `quality` | 开 | `size_match`、`outside_max_abs`（`max_outside` 默认 24） |
| `check` | 见 schema | 硬门槛：改动比例、SSIM、MAE、直方图、参考图色偏、闭环 SSIM |

叙事阈值放宽（`planner.growth_thresholds` / `transform_thresholds`）：

- 成长：`max_change 0.92`、`min_ssim 0.06`、`min_hist 0.15`、`max_mae 90`、`anchor=None`
- 四季：`max_change 0.99`、`min_ssim 0.05`、`min_hist 0.18`、`max_mae 85`、`anchor=None`

---

## 6. 已验证的路径与证据（截至 2026-11-11）

| 路径 | run | 结果 | 备注 |
| --- | --- | --- | --- |
| 成长叙事 · 整幅重绘（plain） | `loop-20261107-223941-e36659eb`、`-230038-bae9b015`、`-230515-1e52cf10` | 10/10，mp4 | 背景会累积泥点，需“清理背景”补丁 |
| 成长叙事 · 固定背景分层（fixed） | `loop-20261109-232011-3f9419cc`、`-232425-b81b80b7` | 10/10，mp4 双版本 | 背景逐帧像素一致；顶部背景带 MAE 0.000 |
| 四季山景 · 轮流接力（chain/plain） | `loop-20261109-235221-79fa54af` | 12/12，mp4 | **背景出现明显彩色噪点，不推荐** |
| 四季山景 · 手写分镜 + 独立出图 | `loop-20261110-001551-7a6c26f7` | 12/12，mp4 双版本 | 12 条手写提示词，无 LLM；第 11 帧（厚雪）背景仍有颗粒，已用更强措辞重试，未做最终目视复核 |
| 早期 Mock/联调 | `20261107-*` 多条 | — | 含宫格切分与 GIF/WebP；未在本文档逐条复核 |
| 2026-11-11 · 新工作台 UI 联调 | `loop-20261111-142720-5baf73d6`（照片轨道）、`-142915-8907480a`（流水线 4×4）、`-143208-67fb3121`（手写分镜） | GIF/MP4 双版本 | 多图上传、素材仓库多选、宫格切分、逐格改词/重跑/恢复、轨道停格与重排均通过；引擎为 Mock，**真实模型未复测** |

交付示例：

- 种子故事（fixed）：`still_loop/_data/runs/loop-20261109-232425-b81b80b7/`
- 四季（手写分镜）：`still_loop/_data/runs/loop-20261110-001551-7a6c26f7/`

---

## 7. 必须知道的实现坑（都是实测换来的）

1. **fixed 模式的 `<image2>` 必须也传键控参考帧**。传原始参考图会把模型“拽回”整幅重绘，`key_lost`。
2. **一致性 LoRA + `chain_mask` 会锁死成长**：同一句“长成大树”只改 0.36%；关掉后 12.36%。
3. **去溢色必须带 `G<90`**：否则浅粉花瓣（255,178,203）会被压成灰色。
4. **模型会在主体外补淡灰紫底**：`matte.key_subject` 用「低饱和 + 较亮 + 绿通道不低」剔除。
5. **键色会漂移**（255,0,255 / 205,0,176 / 纯白都出现过）：每帧在“参考键色”和“角点估计键色”里取覆盖率高者。
6. **背景板只采样上/左/右上部**：19:9 山景的地台会延伸到左右边缘，整条侧边采样会被地台污染。
7. **末帧“归种”不要交给模型**：它只肯收掉树干、留下树冠；fixed 模式末帧直接复用键控参考帧（`loopReset`）。
8. **主项目 payload 不要带 `local.scheme: "none"`**：新版会 400。已从 `generator._payload` 移除。
9. **产物 URL 带中文**：下载前必须 `urllib.parse.quote`（`generator.download` 已处理）。
10. **8700 会静默退出**：`generator.wait()` 对 GET 退避重试；`wait_ready()` 在推理前等 60–90s；仍失败则该帧 blocked。
11. **四季/成长不要用参考图做全局色锚**：`runner` 里 `anchor=None`，否则第 9 帧会因树冠变绿判 `color_drift`。
12. **`/prompts` 是唯一“完全不改写提示词”的入口**；`/plan` 的 fallback 会加“保持 X 不变”，LLM 还会写“天空”，都会和 fixed/季节冲突。

---

## 8. 已知缺陷与风险（按严重度）

1. **主项目稳定性（blocker）**：连续出图时 8700 会静默退出（本轮出现 4+ 次）。当前只有“重试 + 等待”，没有自动拉起。
   合并前建议加进程看门狗，或把推理放进主项目自有队列。
2. **主项目契约会漂移**：本轮 `local.scheme` 突然被判 400。合并前后都要跑一次契约自检。
3. **fixed 依赖模型配合**：主体占比过大、模型画渐变底、画天空，都会 `key_lost`；有重试与回退，但不是 100%。
4. **independent 模式下主体会“呼吸”**：山体大小/位置帧间会有几像素漂移，适合“状态切换”，不适合连续动作。
5. **质量关仍靠人**：checker 只能挡明显崩坏/偏色；背景颗粒、花瓣变灰这类问题需要 contact sheet 目视。
6. **主项目导航入口还没加**：前端已覆盖手写分镜、independent、宽高、多图/素材导入、轨道编排与流水线；
   推荐用 iframe `?embed=1` 接入，不要在 8720 里改主项目代码。
7. **8710 未启动**：`align/color_match` 默认关，走本地烘焙；未验证 8710 在线时的效果。

---

## 9. 明确“未验证”，不要当成已完成

- [ ] 动作/循环类 + 真实模型（`consistency=true + chain_mask`）端到端跑通
- [ ] fixed 模式下的单帧重试、断点续跑（代码已接 `_stored_key`，未实测）
- [ ] WebM / APNG / WebP 真帧复测（GIF 与 MP4 已用新 UI 真帧跑通）
- [x] 宫格切分导入复测（UI + Mock；真实模型仍待）
- [ ] 8710 稳定化（align / color-match）
- [x] 非 19:9 的其他非方形画布（UI 已支持 4:3 / 16:9 / 9:16 / 自定义，Mock 未逐档目视）
- [x] 前端对 `/prompts`、`relay`、`width/height` 的支持
- [x] 照片轨道 / 素材仓库多选导入 / 轨道编排（UI + Mock）
- [x] 自动化流水线：切分 → 逐格精修 → 改词/重跑/恢复 → 导出（UI + Mock）
- [ ] 12 帧以上长片（内存/耗时/崩溃率）

---

## 10. 合并进主项目的建议顺序

1. 先以独立服务形态接入主项目（新页面/新入口反代 8720），不改 `server/`。
2. 合并前补三件事：8700 看门狗、契约自检、动作类真实验证。
3. 抽象契约面：`/api/edit`、`/api/upload`、`/api/jobs/{id}`、`/api/generate`、`/api/options`、`/api/meta`。
   这 6 个接口是 still_loop 对主项目的全部依赖，迁移时优先固化它们。
4. 数据迁移：`still_loop/_data/runs` 是纯文件，可直接搬；`run.json` 目前没有版本号，迁移前补 `schemaVersion`。
5. 合并后保留 Mock 引擎：UI/导出/状态机的回归不依赖 GPU。

---

## 11. 交接验收清单

- [ ] 能启动 8700（ComfyUI python）与 8720，并通过健康检查
- [ ] 能用 `/prompts` 跑一个 3 帧的手写分镜（independent/plain）
- [ ] 能看懂 `run.json` 里的 `frames[].attempts[].metrics` 与 `quality`
- [ ] 能解释 `background=fixed` 的 `keyFile/subjectFile/background.png` 三者关系
- [ ] 能在 8700 崩溃后重启并 `start` 续跑
- [ ] 知道 `docs/PLAN_STILL_LOOP.md` 的 14.6–14.10 是本轮设计与实测记录

---

## 12. 前端布局与启动容错（2026-11-11 重构）

**两种页面形态，同一套 CSS 令牌**（`still_loop/web/assets/app.css`）：

| 形态 | 触发条件 | 骨架 | 说明 |
| --- | --- | --- | --- |
| 设置态 | `state.run` 为空 | `.bench`（主区 + 参数抽屉） | 对齐主项目文生图：中间是素材/宫格/参考图画布，下面是参数胶囊（`.param-pill`）与主按钮；所有输入收进右侧 `.bench-drawer`，默认收起，点胶囊或齿轮展开；≤1180 抽屉改为整行跟在下方 |
| 运行态 | 已有 run | `.page-workspace` + `.work-grid`（`312 / 1fr / 320`） | 三栏各自滚动：左设置、中「状态条 + 播放器 + 轨道 + 折叠日志」、右「帧检查 / 导出」Tab；仅中栏 `overflow: hidden`，其余 `overflow-y: auto` |

要点：

- 设置页不铺参数表：胶囊只显示当前值（尺寸 / 帧率 / 停格 / 网格 / 帧数），点开抽屉才出现输入。抽屉内一行一个决定（`.set-row`），数字用步进器（`.stepper`），帧率用滑块（`.sliderRow`），画布比例用比例块（`.ratio-chips`）。
- 引擎 / 模型 / 预设 / 材质 / 步数 / CFG / 种子 / 重试统一收进「引擎与生成参数」折叠卡（`advancedCard`），摘要行显示当前引擎与模型，默认不展开。
- 参数变更时胶囊摘要实时同步（`bindDrawer` 内监听 drawer 的 input/change → `syncPills`）。
- 顶栏只放 kicker + 运行环境上下文，页面标题由 `pageHead()` 渲染，避免重复大标题。
- 右栏不再上下堆叠「检查 + 导出」，改用 `.rail-switch` 两个 Tab（`setRightTab` / `renderRight`），保证导出在首屏。
- 运行态左栏的「画布与节奏」默认折叠，避免工作区再出现参数墙。
- 轨道卡固定 `120px` 宽、`track-surface max-height: 262px`；宫格结果在 `.panel-body` 内滚动。
- 断点：≤1560 左右栏收窄（`288 / 296`）；≤1180 运行态退化为文档流、设置态抽屉改为整行；≤640 主按钮换行；≤560 设置行改为上下两段。

**启动容错（`web/src/main.js`）**：

1. 先用 `FALLBACK_OPTIONS` 调 `safeMountView()` 立即出内容，再异步拉 `/options`、`/health`，成功后 `hydrated=true` 再重挂。
2. `/health` 独立每 5s 刷新，不阻塞首屏；单次请求带 `withTimeout`。
3. `showFatal(error)` + 全局 `error` / `unhandledrejection` 兜底，异常时显示「页面加载失败」而不是白屏。
4. 静态资源与 API 统一 `Cache-Control: no-store`（`server/app.py`），改完刷新即生效。

## 13. 相关文档

- 设计与决策记录：[PLAN_STILL_LOOP.md](file:///<PROJECT_ROOT>/docs/PLAN_STILL_LOOP.md)
  - 14.6 入口最终并入主项目（当前不动主项目代码）
  - 14.7 本轮落地表（分镜/润色合并、数据驱动预设、quality 自检、导出）
  - 14.8 定格动画（视频输出、定格烘焙、手作材质、停格编排、双版本）
  - 14.9 成长叙事（成长契约、体量阶梯、一致性 LoRA 的副作用）
  - 14.10 固定背景 + 主体透明层（键控、抠图、合成、末帧复位）
