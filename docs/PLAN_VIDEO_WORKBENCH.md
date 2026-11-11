# 视频工作台（video_studio）实施方案

状态：方案待确认（尚未写业务代码）
落地形态：独立目录 `video_studio/` + 独立端口 `8730`，不修改主项目 `server/`、`web/`、`animation_kit/`

---

## 1. 目标

上传「音频 + 带时间轴的逐字稿」，自动分段并对齐，逐段用 LLM 把台词改写成生图提示词，
批量生图后按时间线合成，最终导出一条完整 MP4。

核心能力：

| 能力 | 首版口径 |
|---|---|
| 输入 | 音频（mp3/wav/m4a/aac/flac）+ 字幕（SRT / VTT / ASS，必须带时间戳） |
| 分段 | 字幕 cue 合并成镜头段，边界按静音段吸附，全部对齐到视频帧 |
| 提示词 | LLM 按「台词 + 上下文 + 镜头语言」产出每段提示词 |
| 风格锁 | 项目级风格前缀/后缀 + 固定 seed 基线 + 一致性 LoRA + 可选首图参考 |
| 内容锁 | 项目设定（角色/场景/物品卡）强制拼接，LLM 只能引用已登记实体 |
| 画面 | 默认静止；单段可选轻微推拉（Ken Burns） |
| 转场 | 默认硬切；可选淡入淡出、黑场过渡 |
| 字幕 | 可选烧录，ASS 样式（字体/描边/位置/大小） |
| 音轨 | 原声一条（独立轨道，不随画面切）+ 可选 BGM 一条（音量/循环/闪避） |
| 导出 | MP4（H.264 + AAC），画布比例跟随生图比例 |

明确不做：AI 视频生成、多轨复杂混音、云端渲染、无时间轴字幕的自动语音识别（P2 再接）。

---

## 2. 可复用资产（只读复用，不改动）

| 用途 | 位置 | 复用方式 |
|---|---|---|
| 生图 / 编辑 | `/api/generate`、`/api/edit`、`/api/jobs/{id}` | HTTP 调用（照 `still_loop/core/generator.py` 的 `MainProjectClient` 范式） |
| 提示词润色客户端 | `server/llm_client.py`、`server/ollama.py` | 直接 import 复用客户端与档案解析，不改代码 |
| 风格库 | `server/styles.py` + `web/vendor/image-style-kit` | 复用创意前缀/后缀与 MJ 参数合成逻辑（纯函数） |
| 一致性 / seed | `server/pipeline.py` | 通过请求参数传入 `seed`、`consistency_lora`、参考图 |
| 水印渲染 | `server/mediaops.py` | 复用字体白名单与九宫格/平铺/描边参数模型 |
| 时间轴模型 | `animation_kit/core/timeline.py` | 复用「时长取整、序列展开、总时长统计」语义 |
| ffmpeg | 本机 8.1.1（已在 PATH） | 分段渲染、concat、xfade、amix、字幕烧录 |
| 工作台范式 | `still_loop/`（独立 app、独立端口、project.json、原子写入） | 目录结构与存储约定对齐 |

---

## 3. 目录结构

```
video_studio/
├── __init__.py
├── config.py            # 端口 8730、数据目录、MAIN_BASE
├── serve.py             # python -m video_studio.serve --open
├── core/
│   ├── schema.py        # 字段注册表（唯一来源，前后端共用）
│   ├── store.py         # project.json 原子读写、媒体落盘
│   ├── media.py         # ffprobe 探测、波形峰值、静音检测、音频切分
│   ├── subtitle.py      # SRT/VTT/ASS 解析与 ASS 生成
│   ├── segments.py      # cue 合并 → 镜头段 → 静音吸附 → 帧对齐
│   ├── prompts.py       # 分镜提示词生成（风格锁/内容锁装配 + 实体审计）
│   ├── images.py        # 调主项目生图、轮询、断点续跑、单段重生成
│   ├── render.py        # 分段渲染 → concat/xfade → 混音 → 封装
│   └── errors.py
├── server/app.py        # FastAPI 路由
├── web/
│   ├── index.html
│   ├── assets/app.css
│   └── src/{main,api,store,timeline,waveform,player,inspector,settings}.js
├── tests/
└── _data/projects/<project-id>/   # 项目数据（gitignore）
```

`_data/` 与 `still_loop/_data` 同级同规则，媒体与导出产物不进 git。

---

## 4. 数据模型（project.json）

字段只在 `core/schema.py` 的注册表里定义一次，后端校验与前端表单都从 `GET /api/schema` 读取。

```jsonc
{
  "schemaVersion": 1,
  "id": "vid-20261109-153000-ab12cd34",
  "name": "项目名",
  "createdAt": "...", "updatedAt": "...",

  "canvas": { "ratio": "16:9", "width": 1920, "height": 1080, "fps": 30 },

  "audio": {
    "file": "audio/source.m4a", "durationMs": 61234,
    "peaksFile": "audio/peaks.json"
  },

  "subtitle": {
    "file": "subs/source.srt", "format": "srt",
    "cues": [{ "id": "c1", "startMs": 0, "endMs": 2140, "text": "第一句台词" }]
  },

  "locks": {
    "style": {
      "enabled": true, "styleId": "", "prefix": "", "suffix": "",
      "negative": "", "seedBase": 20261109, "consistencyLora": { "name": "", "strength": 0.48 },
      "referenceImage": ""
    },
    "content": {
      "enabled": true, "strict": true,
      "entities": [
        { "id": "e1", "kind": "character", "name": "小林", "desc": "短发，深蓝工装，左眉有疤" },
        { "id": "e2", "kind": "location", "name": "夜班车间", "desc": "冷白顶灯，铁灰色设备" }
      ]
    }
  },

  "shots": [
    {
      "id": "s1", "index": 0, "startMs": 0, "endMs": 4200,
      "text": "第一句台词…",
      "prompt": "", "negative": "", "usedEntities": [],
      "image": "", "seed": 20261109, "status": "pending",
      "motion": { "type": "none", "zoom": 1.0, "panX": 0, "panY": 0 },
      "transition": { "type": "cut", "durationMs": 0 }
    }
  ],

  "render": {
    "subtitle": { "enabled": true, "fontId": "msyhbd", "size": 44, "color": "#FFFFFF",
                  "outline": 2, "outlineColor": "#000000", "marginV": 48, "position": "bottom" },
    "watermark": { "enabled": false, "kind": "text", "text": "", "position": "bottom-right",
                   "opacity": 0.7, "scale": 0.04, "tile": false },
    "bgm": { "file": "", "volumeDb": -18, "loop": true, "duck": true },
    "export": { "crf": 18, "preset": "medium", "format": "mp4" }
  },

  "outputs": [{ "file": "out/export-20261109-1601.mp4", "durationMs": 61234, "createdAt": "..." }]
}
```

约定：

- 所有时间以 **毫秒整数** 存储，渲染时统一换算帧。
- 生成参数不落在 project.json 里，跟随主项目 profile 与项目级覆盖项。
- `status` ∈ `pending | generating | ready | failed`；失败保留上一张可用图。

---

## 5. 核心算法

### 5.1 分段与对齐

1. 解析字幕 → `cues[]`（保留原始时间戳，不重排）。
2. 合并成镜头段：
   - 相邻 cue 间隔 < `mergeGapMs`（默认 350）则并入同一段；
   - 单段最长 `maxShotMs`（默认 8000），超长时在 cue 边界处切分，**不在 cue 内部切**；
   - 段数上限默认 80，超出提示用户调大 `maxShotMs`。
3. 静音吸附：`ffmpeg -af silencedetect=noise=-30dB:d=0.15` 得到静音区间；
   每个段边界在 `snapWindowMs`（默认 250）内若命中静音中点，则移到中点，否则保持字幕边界。
4. 帧对齐：边界统一 `round(ms / 1000 * fps) / fps * 1000`，保证导出时零黑帧、时长为整数帧。
5. 音频不切碎：原声作为**一条连续音轨**渲染进成片；分段切出的短音频只用于波形预览与后续 ASR。

### 5.2 提示词生成

单次 LLM 调用产出全部分镜（超长剧本按 ≤40 段分批），一次请求包含：

- 完整台词列表（含前后段上下文，避免每段孤立理解）；
- `locks.style` 的风格描述文本；
- `locks.content.entities` 实体卡（只读，不允许 LLM 修改）；
- 输出约定 JSON：`{ "shots": [{ "id", "prompt", "negative", "usedEntities": ["e1"], "shotNote" }] }`。

**风格锁的实现不依赖 LLM 自觉**：LLM 只输出「画面内容描述」字段，最终提示词由代码按固定顺序拼接：
`风格前缀 → 实体外观描述 → 画面内容 → 镜头语言 → 风格后缀 → 负面词`。
拼装顺序与 `server/styles.py` 的 `buildNodePrompt` 保持一致，便于与文生图页对齐效果。

**内容锁的校验**：LLM 返回的 `usedEntities` 与注册表比对；
- 引用未登记实体 → 标记 `warnings`，前端高亮，不静默放行；
- `strict=true` 时未登记实体不进入最终提示词，且该段不参与批量生图，等待用户确认。

### 5.3 生图

- 串行提交（一次一个 job），轮询 `/api/jobs/{id}`，进度回填到项目。
- 断点续跑：只处理 `status != ready` 的段；已完成的段不重跑。
- 单段重生成：只换 seed（`seedBase + index + attempt`），保留原图供对比。
- 画布比例：项目 `canvas.ratio` 决定出图宽高（长边按主项目 `max_side` 上限），
  保证全部镜头同比例，避免导出时出现混比黑边。

### 5.4 渲染与导出

分三段执行，避免一次性 `filter_complex` 吃满内存：

1. **分段渲染**：每段图片 → 定长视频片段（`-frames:v` 精确帧数），可选 `zoompan` 推拉；
   字幕按段局部时间偏移写成段内 ASS 并烧录，保证后续可 `-c copy` 拼接。
2. **拼接**：
   - 全硬切 → `concat demuxer -c copy`（零重编码、零黑帧）；
   - 含转场 → 相邻两段增量 `xfade` 合并为临时文件，再统一拼接（不做 N 路一次性输入）。
3. **音视频封装**：
   - 原声按 `-t 总时长` 截取；BGM 按 `volume` + `aloop` 铺满，`duck=true` 时用
     `sidechaincompress` 做原声闪避；
   - `amix` 混合后 AAC 192k，`-c:v copy` 封装成 MP4；
   - 水印在分段渲染阶段用 `mediaops` 参数模型叠加，位置/平铺规则与图像工具一致。

导出后记录 `outputs[]`，支持重复导出（同输入同 seed 结果一致）。

---

## 6. 后端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 自身健康 + 主项目可达性 |
| GET | `/api/schema` | 字段注册表、枚举、默认值 |
| GET/POST | `/api/projects` | 列表 / 新建 |
| GET/PATCH/DELETE | `/api/projects/{id}` | 读取 / 局部更新 / 删除 |
| POST | `/api/projects/{id}/audio` | 上传音频，返回时长与波形峰值 |
| POST | `/api/projects/{id}/subtitle` | 上传并解析字幕 |
| POST | `/api/projects/{id}/bgm` | 上传背景音乐 |
| POST | `/api/projects/{id}/segments:derive` | 按参数重新分段（返回预览，不落库） |
| POST | `/api/projects/{id}/segments:apply` | 应用分段结果 |
| PATCH | `/api/projects/{id}/shots/{shotId}` | 改时间、图、转场、推拉、提示词 |
| POST | `/api/projects/{id}/prompts` | 生成分镜提示词（LLM） |
| POST | `/api/projects/{id}/images` | 批量生图（后台任务，可取消） |
| POST | `/api/projects/{id}/images/{shotId}` | 单段重生成 |
| POST | `/api/projects/{id}/render` | 导出成片（后台任务，可取消） |
| GET | `/api/projects/{id}/tasks/{taskId}` | 任务进度 |
| GET | `/files/{projectId}/...` | 静态媒体 |

任务模型参照 `server/jobs.py`：单线程队列 + `{value,max,label}` 进度 + 取消标志。

---

## 7. 前端时间线

布局（对齐项目现有苹果风格与主题令牌，不复用主项目页面结构）：

```
┌ 顶栏：项目名 · 画布比例 · 风格锁/内容锁状态 · 导出 ┐
├ 预览区（16:9 画布 + 字幕叠加）    │ 检查器（当前段）
│                                   │ 台词 / 提示词 / 图片 / 转场 / 推拉 / 重生成
├ 时间线 ────────────────────────────────────────────┤
│ 标尺 + 播放头                                       │
│ 波形轨（原声 peaks）                                │
│ 分段轨（段块，带台词缩略与状态色）                  │
│ 图片轨（缩略图）                                    │
│ 字幕轨（cue 块）                                    │
│ BGM 轨                                              │
└ 底部：缩放 · 吸附开关 · 总时长 / 段数 ┘
```

交互要点：

- 播放由 `<audio>` 驱动时间，`timeupdate` + `requestAnimationFrame` 计算当前段，预览区切换图片；
- 段块可拖边界（吸附到静音点/帧）、可拖动排序、可多选批量重生成；
- 所有编辑即时写回 `project.json`（防抖 400ms），刷新可恢复；
- 分段未应用前展示「预览态」，避免误改已生成的图片段。

---

## 8. 里程碑

### P0 全链路跑通
- 项目 CRUD、音频/字幕上传与解析
- 自动分段 + 静音吸附 + 帧对齐
- 分镜提示词生成
- 串行批量生图 + 断点续跑
- 时间线预览播放
- 硬切 + 原声导出 MP4

### P1 可交付质量
- 风格锁 / 内容锁 + 实体审计告警
- 单段重生成、图片替换
- 淡入淡出 / 黑场转场
- 字幕烧录（ASS 样式）
- 水印
- BGM + 音量 + 闪避
- 完成测试档案（每项三轮）

### P2 体验增强
- Ken Burns 推拉参数化
- 分段边界可视化吸附提示
- 项目模板 / 复用设定卡
- 可选接入本机语音转录（无时间轴时自动生成词级时间戳）

---

## 9. 验收标准

1. 60 秒 / 10 段素材全链路跑通，导出 MP4 可正常播放。
2. 音画同步：任意时刻音画偏差 ≤ 1 帧（33ms @30fps）。
3. 硬切处无黑帧、无重复帧，总时长误差为 0。
4. 分段边界不切断台词（吸附生效），边界误差 ≤ 250ms。
5. 开启风格锁后连续 10 段人工目检风格一致；固定 seed 重复导出结果一致。
6. 内容锁开启且 `strict` 时，未登记实体不出现在最终提示词中，并在界面告警。
7. 生成中断后重启，只补未完成段，已完成段不重跑。
8. 主项目未启动时给出明确错误，不卡死、不静默失败。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 字幕时间戳不准（整体偏移） | 画面与台词错位 | 提供全局偏移 `offsetMs` 微调；分段后可手动拖边界 |
| 字幕切在词中间 | 听感断裂 | 静音吸附 + 只在 cue 边界切分 + 边界可视化 |
| 画面比例混用 | 导出黑边/拉伸 | 项目级画布比例锁定，出图统一按该比例 |
| 风格漂移 | 成片不统一 | 提示词由代码装配（风格前缀固定）+ 固定 seed + 一致性 LoRA + 首图参考 |
| LLM 加戏（新增角色/场景） | 内容跑偏 | 实体白名单 + 差集审计 + `strict` 阻断 |
| 显存/耗时不可控 | 批量卡住 | 严格串行、单段可取消、断点续跑、生成前提示预计段数 |
| 一次性混合 N 段 | 内存爆、导出失败 | 分段渲染 + `concat -c copy`；转场增量两两合并 |
| 路径中文/空格 | ffmpeg 字幕滤镜失败 | 统一临时目录使用 ASCII 名，路径转正斜杠并转义 |
| 与主项目抢显存 | 主项目出图变慢 | 渲染阶段不调用生图；导出仅用 CPU |

---

## 11. 已确认决策

| 项 | 决策 |
|---|---|
| 落地形态 | 独立 `video_studio/` 目录 + 独立端口 `8730` |
| 字幕输入 | 首版只支持带时间轴的 SRT / VTT / ASS |
| 画面运动 | 默认静止，单段可选轻微推拉 |
| 导出规格 | 画布比例跟随生图比例自适应 |

---

## 12. 实施记录（2026-11-09）

P0 + 大部分 P1 已落地，代码在 `video_studio/`，使用说明见 [VIDEO_STUDIO.md](./VIDEO_STUDIO.md)。

| 里程碑 | 状态 | 说明 |
|---|---|---|
| P0 全链路 | 完成 | 3 段 12s 真机跑通，导出 1920×1080 / 30fps / 12.000s |
| 风格锁 / 内容锁 | 完成 | 风格库 285 条可选；实体白名单 + 严格模式；新增角色连贯继承 |
| 单段重生成 / 上传图片 | 完成 | 重生成换 seed，保留原图；支持手动上传替换 |
| 转场 | 完成 | 淡入淡出 / 黑场；转场尾部补偿，总时长不缩水 |
| 字幕烧录 / 水印 / BGM | 完成 | ASS 烧录、Pillow 水印、amix + 闪避 |
| Ken Burns | 完成（扩展为镜头语言） | 固定 / 慢推 / 慢拉 / 横移 / 纵摇 / 对角推，LLM 按台词情绪分配，幅度可调 |
| 测试档案 | 部分 | 23 项单元测试通过；真机端到端与视觉验收完成，三轮重复测试待补 |

与初版方案的差异：

1. **画布字段改为「比例 + 导出长边 + 帧率」**。原 `width/height` 两个字段会让人误以为可自由设宽高，
   实际导出由比例决定，现统一成长边（480–2048）+ 比例；老项目在读取时自动迁移。
2. **风格锁增加「风格库下拉」**。通过 `/api/styles` 代理主项目 285 条风格，选中即写入风格描述，
   不用手抄。
3. **内容锁增加角色连贯继承**。台词没重复称呼角色时沿用上一段角色，
   避免“同一场戏换了张脸”；场景（location）不做继承。
4. **转场以切点为中心**：前后两段各让出半个转场，成片总时长仍精确等于音轨。
   `xfade` 的小数帧取整会累计少 1~2 帧，拼接后增加了「帧数校准」（按台词总帧数裁/补），
   实测 4 段 + 三处 420ms 淡入淡出：781 帧 / 26.033s，音频 26.029s。
5. **镜头语言成体系**：不再只有一个「kenburns」开关，改为 8 种运镜预设，
   由分镜 LLM 按情绪分配、也可逐段手改；新建镜头默认慢推 1.06×。
6. **运镜改为逐帧亚像素仿射，不再用 `zoompan`**：`zoompan` 的裁剪坐标是整数像素，
   慢推时中心在相邻像素间跳动（1.35× 实测逐帧位移 -1/0/1、标准差 0.93）。
   现改为 Python + OpenCV `warpAffine`（2× 工作分辨率、Lanczos4、浮点坐标）逐帧渲染，
   rawvideo 管道直送 ffmpeg；慢拉的帧间差标准差 0.01、位移抖动 ≈0.01px。
   坑：`warpAffine` 必须带 `WARP_INVERSE_MAP`（我们给的是目标→源矩阵），否则会二次求逆。
7. **关键帧只落在切点/转场中点**：x264 默认每 250 帧插 I 帧，I 帧的亮度与细节和前后 P 帧
   对不上，慢速运镜时每 8 秒左右「闪一下」（实测帧间差 1.41 vs 平时 0.55）。
   恒定 QP、`ipratio=1.0` 均无效，只有把 `keyint` 拉到约等于无穷、用 `-force_key_frames`
   指定落点才彻底消失；硬切落在切点，淡入淡出落在转场中点。修后 25.0s 附近帧间差稳定在 0.50–0.56。
8. **`/api/styles`、生图、LLM 全部走 HTTP / 只读复用**，主项目 `server/`、`web/` 未改动一行。

