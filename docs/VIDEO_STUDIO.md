# 视频工作台（video_studio）

音频 + 带时间轴逐字稿 → 自动分段 → 分镜提示词 → 批量生图 → 时间线合成 → 导出 MP4。

独立服务，不修改主项目代码：生图、风格库、LLM 客户端都通过 HTTP / 只读方式复用。

> 优化项（分镜表、图片版本、任务中心、历史图库、主题与导出体检）已全部落地，实施记录见
> [PLAN_VIDEO_STUDIO_OPTIMIZE.md](PLAN_VIDEO_STUDIO_OPTIMIZE.md)。

---

## 快速开始

```powershell
# 仓库根目录
python -m video_studio.serve --open       # 默认 http://127.0.0.1:8730/
```

- 主项目（生图服务）需先运行：`scripts/run.ps1`（8700）。
- 数据全部落在 `video_studio/_data/projects/<project-id>/`，可整目录拷走。
- 没配 LLM 也能用：提示词退化为模板拼装，之后可在检查器里手改。

环境变量：`VIDEO_STUDIO_PORT`、`VIDEO_STUDIO_MAIN`、`VIDEO_STUDIO_DATA`、`VIDEO_STUDIO_LLM`。

---

## 使用流程

1. **上传音频**（mp3 / wav / m4a / flac / aac）：自动转 AAC、算波形峰值、探静音段。
2. **上传字幕**（SRT / VTT / ASS，必须带时间戳）。
3. **自动分段**：按字幕边界合并成镜头段，边界向静音中点吸附，再对齐到视频帧。
4. **生成分镜提示词**：LLM 只写“画面内容”，风格前缀、角色卡、镜头语言由代码拼装。
5. **批量生图**：串行提交主项目，断点续跑；单段可重生成 / 手动上传图片，每段保留最近 8 个版本。
6. **导出成片**：先做导出前体检（缺图 / 空提示词 / 字幕溢出 / 音量过低），再分段渲染 → 拼接（硬切 / 淡入淡出 / 黑场）→ 字幕水印叠加 → 原声 + BGM 混音。

工作区有两种视图：**时间线**（拖边界、看波形、双击试听单段）与**分镜表**（一屏通读所有段的
台词、缩略图、提示词，可直接改文案、重新生图、切换图片版本）。两者共用同一选中段。

窄屏（≤1080px）时，检查器 / 流程 / 历史收进右侧滑出面板，由舞台右上角的面板按钮打开，
点遮罩或按 `Esc` 关闭。

顶栏「任务」浮层能看到排队 / 进行 / 完成 / 失败，支持取消与重试；侧栏「历史」页读主项目
最近产物，可一键把某张图用到当前镜头段。

快捷键：`空格` 播放/暂停、`←/→` ±0.1s、`Shift+←/→` ±1s、`Home/End` 跳首尾、
`Ctrl/⌘+Z` 撤销、`Shift+Ctrl/⌘+Z` 重做、`Esc` 关闭弹层。

时间线上可拖动镜头边界、点击跳转、缩放；单击字幕条可直接改字幕文案。
右侧检查器编辑台词、画面描述、提示词、运镜与转场。

---

## 目录结构

```
video_studio/
├── config.py          端口、数据目录、分段与渲染常量
├── serve.py           启动入口
├── core/
│   ├── schema.py      字段注册表（唯一来源，前端从 /api/schema 读取）
│   ├── store.py       project.json 原子读写 + 媒体落盘
│   ├── media.py       ffprobe / 归一化 / 波形 / 静音检测
│   ├── subtitle.py    SRT / VTT / ASS 解析与 ASS 生成
│   ├── segments.py    分段合并、静音吸附、帧对齐、边界重排
│   ├── prompts.py     LLM 分镜 + 代码装配 + 模板降级 + 实体审计
│   ├── images.py      主项目生图调度、下载、断点续跑
│   ├── render.py      分段渲染、拼接/转场、字幕水印、混音、封装
│   └── tasks.py       串行后台任务（进度 / 取消）
├── server/app.py      FastAPI 路由
├── web/               index.html + assets/app.css + src/*.js
└── tests/test_core.py
```

---

## 关键实现

### 分段与对齐

- 相邻 cue 间隔 ≤ `mergeGapMs`（默认 350ms）合并；单段不超过 `maxShotMs`（默认 8000ms）。
- **只在 cue 边界切**，绝不从一句台词中间切开。
- 边界在 ±`snapWindowMs`（250ms）内命中静音中点则移到中点。
- 所有边界对齐 `1000/fps` 的整数倍；段首尾相接、铺满整条音轨。

### 转场补偿（不丢时长）

转场以切点为中心，前后两段各让出半个转场。每段渲染时同时补上「进入转场的前半」和
「离开转场的后半」，两半相加正好一个转场，成片总时长精确等于台词总长：

```
Σ(段长 + 前半 + 后半) − Σ(转场) = Σ段长
```

`xfade` 对小数帧的取整不受控制，3 段以上会累计少 1~2 帧，所以拼接后还有一道
「帧数校准」：以台词总帧数为唯一标准，多了裁掉、少了克隆末帧补齐。
实测 4 段 + 三处 420ms 淡入淡出：781 帧 / 26.033s，音频 26.029s，偏差 4ms。

### 音频

原声始终是一条连续音轨，画面按帧切，不会累积音画偏移。
BGM 支持循环铺满、音量、`sidechaincompress` 原声闪避。

### 风格锁 / 内容锁

- **风格锁**：LLM 不写最终提示词。代码按固定顺序拼接
  `风格前缀 → 实体外观 → 画面描述 → 镜头语言 → 风格后缀 → 负面词`。
  风格前缀可直接从主项目风格库（`/api/styles`，285 条）选择。
- **内容锁**：只允许登记过的角色/场景出现，外观描述固定注入；
  LLM 返回未登记实体时告警，严格模式直接剔除。
- **角色连贯**：某段没有点名角色时，自动沿用上一段用到的角色（场景不继承），
  避免“这句台词没叫名字就换了一张脸”。

### 镜头语言

- 预设：固定画面 / 慢推 / 慢拉 / 左横移 / 右横移 / 上摇 / 下摇 / 对角推；幅度 1.01~1.30× 可调。
- 分镜 LLM 会按台词情绪给每段指定运动（写进 `shot.motion`），讲故事/独白优先 push / pull；
  重新生成提示词会覆盖手动改的运镜，之后仍可单独调。
- 新建镜头默认慢推 1.06×，需要完全静止切 `none`；时间线镜头块右上角显示「推 / 拉 / 左移…」角标。
- 实现：Python 逐帧亚像素仿射（OpenCV `warpAffine` + Lanczos4，缺 OpenCV 时回退 PIL 双三次），
  rawvideo 管道直送 ffmpeg，不落中间图片。运动进度按 `index/(N-1)` 归一化，段尾正好到位。
  - 不用 `zoompan`：它的裁剪坐标是整数像素，慢推每帧位移不到 1 像素，取整会让画面在
    相邻像素间来回跳（1.35× 实测逐帧位移 -1/0/1，标准差 0.93）。
  - 先按 2 倍工作分辨率做 `ImageOps.fit`，再浮点仿射降到输出尺寸，
    重采样相位连续，实测慢拉的帧间差标准差 0.01、位移抖动 ≈0.01px。
- **关键帧不落在镜头中间**：x264 默认每 250 帧一个 I 帧，I 帧的亮度/细节与前后 P 帧对不上，
  慢速运镜时每 8 秒左右会「闪一下」（实测帧间差 1.41 vs 平时 0.55；恒定 QP 也消不掉）。
  现在把 `keyint` 拉到约等于无穷，I 帧只用 `-force_key_frames` 指定：硬切落在切点，
  淡入淡出落在转场中点（两段混合最激烈处），肉眼看不出来。
- 想要横移更顺，可在设置里把帧率调到 60fps（成本是渲染时间翻倍）。

### 导出

- 分段渲染成同参数 MP4（`libx264/yuv420p/crf/preset` 完全一致）。
- 全硬切走 `concat -c copy`；有转场时相邻两段增量 `xfade`，不做 N 路一次性 filter。
- 字幕用 ASS 烧录（相对路径 + cwd 调 libass，规避中文/空格路径转义）。
- 水印用 Pillow 预渲染 PNG 再 overlay，九宫格 / 平铺 / 透明度与图像工具一致。

---

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 自身 + 主项目 + ffmpeg + LLM 可用性 |
| GET | `/api/schema` | 字段注册表 |
| GET | `/api/styles` | 代理主项目风格库 |
| GET/POST | `/api/projects` | 列表 / 新建 |
| GET/PATCH/DELETE | `/api/projects/{id}` | 读取 / 局部更新 / 删除 |
| POST | `/api/projects/{id}/audio` | 上传音频 |
| POST | `/api/projects/{id}/subtitle` | 上传并解析字幕 |
| POST/DELETE | `/api/projects/{id}/bgm` | 上传 / 清除背景音乐 |
| POST | `/api/projects/{id}/segments/preview` | 预览分段（不落库） |
| POST | `/api/projects/{id}/segments/apply` | 应用分段 |
| PATCH | `/api/projects/{id}/shots/{shotId}` | 改时间 / 提示词 / 运镜 / 转场 |
| POST | `/api/projects/{id}/shots/{shotId}/image` | 手动替换图片（自动递增版本） |
| GET/POST/DELETE | `/api/projects/{id}/shots/{shotId}/versions` | 图片版本列表 / 切换 / 删除 |
| POST | `/api/projects/{id}/shots/{shotId}/image/from-history` | 取主项目历史图写入该段 |
| PATCH | `/api/projects/{id}/subtitle/cues` | 就地改字幕文案 |
| POST | `/api/projects/{id}/restore` | 撤销/重做时整段恢复 shots |
| POST | `/api/projects/{id}/prompts` | 生成分镜提示词（任务） |
| POST | `/api/projects/{id}/images` | 批量生图（任务） |
| POST | `/api/projects/{id}/images/{shotId}` | 单段重生成（任务） |
| POST | `/api/projects/{id}/render` | 导出（任务） |
| GET | `/api/tasks` · `/api/tasks/{id}` · POST `/api/tasks/{id}/cancel` | 任务列表 / 进度 / 取消 |
| GET | `/api/main/queue` · `/api/main/history` | 主项目队列与历史（只读代理） |

---

## 测试与验收

```powershell
python -m pytest video_studio/tests -q     # 23 passed
```

真机端到端（本机 RTX 5090 + 主项目 8700）：

| 项 | 结果 |
|---|---|
| 3 段 12s 音频 + SRT 全链路 | 通过 |
| 分段 | 0–2600 / 2600–6600 / 6600–12000ms，首尾相接 |
| LLM 分镜（qwen3.5:9b） | 通过，5s 内返回 3 段画面描述 |
| 批量生图 | 3/3 成功，断点续跑未触发重跑 |
| 硬切导出 | 1920×1080 / 30fps / 12.000s / 360 帧 |
| 淡入淡出 + 水印 + BGM + 推拉 | 总时长仍为 12.000s，水印与字幕位置正确 |
| 风格锁 + 内容锁 | 三段同一角色（深蓝工装/浅灰衬衫）、同一影像风格 |

音画同步：视频 12.000s / 音频 11.981s（AAC 编码器前导 ≈19ms），小于一帧 33ms。

---

## 已知限制

- 首版只接受带时间轴的 SRT / VTT / ASS，不做语音识别；无时间轴需要先转录。
- 转场时长会向上取整到整帧（例如 420ms @30fps → 13 帧 / 433ms），界面填的毫秒只是目标值。
- 导出默认长边 1920，可在设置里选 720p / 1080p / 4K 或自定义（480–3840）；比例以项目画布为准，出图统一按同比例。
- 后台任务单 worker 串行：生图与导出不会并发抢显存，但也意味着大项目要排队；任务记录落盘保留最近 100 条。
- 图片版本每段保留最近 8 版，超出自动删最旧；删除版本不可恢复。
- 撤销/重做只覆盖镜头段数据（最多 20 步），画布与全局设置改动不进入撤销栈。
- 浏览器端播放依赖音频解码；无声卡/自动化环境（headless）里 `currentTime` 不前进，属环境限制。
