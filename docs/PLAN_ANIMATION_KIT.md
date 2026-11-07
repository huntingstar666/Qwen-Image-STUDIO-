# 定格动画 / GIF 工作台：实现说明与移植方案

> 状态：**独立套件已实现并可运行**，本文只描述现状与移植步骤，不涉及主项目源码改动。
> 套件位置：`animation_kit/`（自包含，可整体拷走）
> 参考文档：[ARCHITECTURE.md](./ARCHITECTURE.md)、[ALIGN_COLOR.md](./ALIGN_COLOR.md)
> 参考实现：`server/align.py`、`server/imaging.py`、`server/jobs.py`、`server/storage.py`

---

## 0. 结论摘要（先看这段）

| 问题 | 结论 |
| --- | --- |
| 怎么保证"不改变主项目" | 整个功能是一个独立包 `animation_kit/`，只依赖 FastAPI + Pillow + numpy，不 import 主项目、不 import torch、不碰 ComfyUI |
| 怎么复用主项目的零偏移经验 | 沿用三条硬规则：**只做整数裁剪/粘贴**、**不缩放不旋转时不重采样**、**合成快路径直接拷贝字节**；导出报告里显式给出 `pixel_exact` / `resampled_ids` |
| 4×4 透明宫格怎么切 | 单元格边界用 `round(索引 × (边长 + 间隔))` 推导，只做整数裁剪；默认 `trim=union` 保留格内相对位移 |
| 抖动怎么修 | FFT 相位相关估计整数平移，只补偿整数像素，绝不亚像素重采样 |
| 闪烁怎么修 | 逐通道 `gain + offset` 仿射匹配，gain 夹 `0.9~1.1`、offset 夹 `±24`，alpha 逐字节不变，可一键还原 |
| 能导出什么 | GIF、APNG（无损）、动画 WebP、PNG 序列 ZIP、透明精灵表 + atlas JSON |
| 哪些格式真正逐像素一致 | 合成无重采样时：APNG / PNG 序列 / WebP 无损；GIF 永远不承诺（256 色 + 1 位透明） |
| 前端为什么没有构建 | 与主项目一致：本机 npm registry 不可达，全部用浏览器原生 ES module |
| 移植时要小心的最大坑 | 路由与静态目录**重名**：合并进主项目必须整体加 `/api/animation` 与 `/animation/files` 前缀，否则会和主项目 `/api/jobs/{id}`、`/files`、`/src` 冲突 |

**一句话记忆版**：宫格整数切 → 帧只做整数位移 → 需要缩放/旋转才重采样并标注 → 稳定只修整数平移 → 去闪烁只调颜色统计 → APNG 保真、GIF 明示限制。

---

## 1. 目标与边界

### 1.1 目标

1. 把一次生成的 **4×4 透明通道宫格图**切成逐帧动画；
2. 支持逐帧停顿（曝光 N 次）、乒乓循环、逐帧时长；
3. 支持定格动画常用处理：**自动稳定（去抖动）**、**色彩一致（去闪烁）**、洋葱皮、辅助线；
4. 导出 GIF / 无损动图 / PNG 序列 / 精灵表；
5. 在不改动主项目代码的前提下完整跑通，后续可低风险移植。

### 1.2 非目标（当前明确不做）

- 不负责"生成"帧：不调用 Qwen-Image / ComfyUI / 显存；
- 不做视频编码（MP4/WebM），需要视频请用 PNG 序列进剪辑软件；
- 不做多轨时间轴、音频、转场、蒙版动画；
- 不做用户系统、鉴权、多机部署（服务固定绑定 `127.0.0.1`）；
- 不承诺 GIF 的逐像素一致性（格式本身做不到）。

### 1.3 与主项目能力的关系

| 主项目能力 | 本套件的对应物 | 关系 |
| --- | --- | --- |
| 画布 32 对齐、`resolution=0`、`crop_back` | **不适用** | 本套件不经过 VAE/DiT，不存在 latent 网格；画布尺寸由用户决定 |
| `imaging.decode_image`（EXIF→ICC→sRGB→RGBA） | `core/images.decode_image` | 语义对齐，**独立实现**，避免移植时反向依赖 |
| `imaging.encode_png`（8bit、剥 ICC、保 alpha） | `core/images.encode_png` | 同上 |
| `align.py` 的 pad/crop/composite/reinhard | **不复用** | 那是"单图编辑的几何逆变换"；本套件需要的是"帧间抖动估计"和"逐帧颜色统计"，语义不同 |
| `jobs.py` 单 worker 队列 | `server/jobs.py` | 同一套语义（串行、进度、取消、历史落盘），但队列实例独立 |
| `storage.save_output` | `core/project.save_frame` / `config.EXPORTS_DIR` | 移植时可替换成主项目 storage，见第 9 节 |

> 结论：**算法层不复用主项目代码，只复用约定**。这样套件可以先独立演进，移植时不会把两套几何语义搅在一起。

---

## 2. 运行形态与目录

### 2.1 启动

```powershell
python -m animation_kit                  # 默认 127.0.0.1:8710
python -m animation_kit --port 8711 --open
```

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `ANIM_KIT_DATA` | 数据根目录（项目、帧、导出、任务历史） | `animation_kit/_data/` |
| `ANIM_KIT_PORT` | 端口 | `8710` |

`_data/` 结构：

```
_data/
├─ projects/<projectId>.json        一个项目 = 一份 JSON 文档
├─ frames/<projectId>/<id>_<stem>.png
├─ exports/anim-<时间戳>-<随机>.<ext>      以及 .atlas.json
├─ thumbs/                          预留（当前未使用）
└─ jobs.json                        导出任务历史（原子写）
```

### 2.2 包结构

```
animation_kit/
├─ __init__.py           版本号 + 移植指南
├─ __main__.py           python -m animation_kit 入口
├─ config.py             路径、端口、默认值、url_for / resolve_url
├─ core/                 纯算法，不依赖 FastAPI
│  ├─ registry.py        字段/范围/默认值/枚举 + 清洗校验（单一注册表）
│  ├─ images.py          解码/编码/缩放/适配（int 裁剪优先）
│  ├─ sheet.py           宫格切分
│  ├─ compose.py         帧 → 画布合成（零偏移快路径）
│  ├─ align.py           FFT 相位相关自动稳定
│  ├─ color.py           逐通道 gain/offset 去闪烁
│  ├─ timeline.py        hold / duration / pingpong / GIF 取整
│  ├─ encode.py          GIF / APNG / WebP / PNG 序列 / 精灵表
│  ├─ project.py         项目 JSON 与帧文件原子落盘
│  └─ errors.py          AnimationCanceled
├─ server/
│  ├─ app.py             FastAPI 路由 + 静态托管
│  └─ jobs.py            单 worker 队列（进度/取消/历史）
├─ web/                  原生 ES module 前端（零构建）
└─ tests/                unittest（33 项）
```

### 2.3 依赖方向

```
web/ (浏览器)
   │ HTTP /api/*
server/app.py
   ├─ server/jobs.py       任务队列
   └─ core/*               纯算法（Pillow + numpy）
        └─ core/project.py 落盘
```

`core/` 不 import `server/`，也不 import FastAPI；`server/app.py` 只做参数解码、错误映射与任务编排。

---

## 3. 数据模型

### 3.1 项目文档（`projects/<id>.json`）

```json
{
  "version": 1,
  "id": "prj-20261107-153012-ab12cd34",
  "name": "走路循环",
  "createdAt": "2026-11-07 15:30:12",
  "updatedAt": "2026-11-07 15:36:40",
  "canvas": { "width": 1024, "height": 1024, "background": "", "fit": "contain", "anchor": "center" },
  "timeline": { "fps": 12, "loop": 0, "direction": "forward", "defaultHold": 1 },
  "processing": {
    "align": { "reference": "first", "maxShift": 64, "confidence": 0.08 },
    "color": { "reference": "median", "strength": 0.8, "scope": "subject" }
  },
  "source": {
    "type": "sheet",
    "importedAt": "2026-11-07 15:30:40",
    "sheet": { "rows": 4, "columns": 4, "rowGap": 0, "columnGap": 0,
               "order": "row-major", "trim": "union", "padding": 0 }
  },
  "frames": [
    {
      "id": "f-1a2b3c4d", "name": "帧 01",
      "url": "/files/frames/prj-.../xxx_sheet-01.png",
      "sourceUrl": "",
      "width": 256, "height": 256,
      "offsetX": 0, "offsetY": 0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0,
      "hold": 1, "duration": 0,
      "visible": true, "locked": false,
      "origin": "sheet", "note": ""
    }
  ]
}
```

### 3.2 帧字段（`FRAME_FIELDS`）

| 字段 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | str | 自动 `f001` | ≤64 | 文档内唯一；导入时冲突补 `-2` 后缀 |
| `name` | str | `帧 01` | ≤80 | 显示名 |
| `url` | str | — | ≤512 | 当前图片（`/files/...`） |
| `sourceUrl` | str | `""` | ≤512 | 去闪烁前的原图；用于一键还原 |
| `width` / `height` | int | 1 | 1~8192 | 帧图尺寸 |
| `offsetX` / `offsetY` | int | 0 | ±8192 | 整数位移；浮动值会四舍五入并记 warning |
| `scale` | float | 1.0 | 0.05~8.0 | 显式缩放（会重采样） |
| `rotation` | float | 0.0 | ±360 | 显式旋转（会重采样） |
| `opacity` | float | 1.0 | 0~1 | 只乘 alpha |
| `hold` | int | 1 | 1~240 | 曝光次数（"拍 N 格"） |
| `duration` | int | 0 | 0~60000 | 单次曝光毫秒；0 = `1000/fps` |
| `visible` | bool | true | — | 不参与播放与导出 |
| `locked` | bool | false | — | 仅前端交互约束 |
| `origin` | enum | `upload` | `sheet/upload/derived` | 来源标记 |
| `note` | str | `""` | ≤200 | 备注 |

### 3.3 画布 / 时间轴 / 处理

| 组 | 字段 | 默认 | 取值 |
| --- | --- | --- | --- |
| `canvas` | `width`,`height` | 1024 | 1~8192 |
| | `background` | `""` | `#rrggbb`；空 = 全透明 |
| | `fit` | `contain` | `contain/cover/stretch/none` |
| | `anchor` | `center` | `center/top/bottom` |
| `timeline` | `fps` | 12 | 1~60 |
| | `loop` | 0 | 0~999（0 = 无限） |
| | `direction` | `forward` | `forward/pingpong` |
| | `defaultHold` | 1 | 1~240（前端批量套用） |
| `processing.align` | `reference` | `first` | `first/previous/median` |
| | `maxShift` | 64 | 0~512 |
| | `confidence` | 0.08 | 0~1 |
| `processing.color` | `reference` | `median` | `median/first` |
| | `strength` | 0.8 | 0~1 |
| | `scope` | `subject` | `subject/full` |

### 3.4 单一注册表

所有字段、范围、默认值、枚举、导出选项都只在 `core/registry.py` 定义一次：

- 服务端 `normalize_doc()` 用同一份定义做清洗与夹取；
- `GET /api/options` 把它序列化给前端，前端 `tools.js` 用 `controlFor()` 自动生成表单；
- 测试直接断言边界，避免"前端一套、后端一套"。

新增字段的正确做法：**只改 `registry.py`**，前后端自动跟上。

### 3.5 清洗规则（要点）

- 数字字段：先 `float()` 再 `round()`，最后夹到 `[min,max]`（不做静默丢弃）；
- 枚举字段：非法值**回退默认值**，不报错；
- 字符串：按 `max` 截断；
- 帧数上限 512（`normalize_doc` 截断）；
- 没有显式 `canvas` 时，画布跟随第一帧尺寸（避免导入后空白）；
- `validate_doc()` 只在导出时要求"至少一帧、每帧有 url、尺寸合法"。

---

## 4. API 契约

### 4.1 通用约定

- 响应统一 `application/json; charset=utf-8`；
- 错误结构：`{"error": {"code": "...", "message": "..."}}`；
- 图片入参接受三种形式：`data:` URL、`/files/...`、纯 base64；
- 提交类接口返回 `{job_id,status}`，前端轮询 `/api/jobs/{id}`；
- 前端静态文件 `/`、`/src/*`、`/assets/*` 强制 `Cache-Control: no-cache`（主项目踩过的坑）。

### 4.2 路由表

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 版本、队列状态、数据目录、项目数、可用格式 |
| GET | `/api/options` | 字段注册表 + 导出格式 + 默认值 + 能力列表 |
| GET | `/api/projects` | 项目列表（按 `updatedAt` 倒序，含封面首帧） |
| POST | `/api/projects` | 新建项目 `{name?, canvas?, timeline?}` → `{project}` |
| GET | `/api/projects/{id}` | 读取项目 → `{project}` |
| PUT | `/api/projects/{id}` | 整文档覆盖保存 → `{project}` |
| DELETE | `/api/projects/{id}` | 删除项目 JSON 与帧目录 → `{ok,id}` |
| POST | `/api/import/sheet` | 宫格切帧并落盘 → `{project,frames,split,warnings}` |
| POST | `/api/import/frames` | 多图导入 → `{project,frames,size,warnings}` |
| POST | `/api/align` | 自动稳定 → `{project,report,jitter_before}` |
| POST | `/api/color-match` | 色彩一致 → `{project,report}` |
| POST | `/api/color-match/revert` | 还原去闪烁前的图 → `{project,restored}` |
| POST | `/api/export` | 提交导出任务 → `{job_id,status}` |
| GET | `/api/jobs/{id}` | 任务详情（进度/结果/错误/traceback） |
| POST | `/api/jobs/{id}/cancel` | 请求取消 → `{ok,job_id}` |
| GET | `/api/history?limit=30` | 最近导出历史（1~200） |
| GET | `/files/*` | 数据根目录静态文件 |
| GET | `/src/*`、`/assets/*` | 前端模块与样式 |
| GET | `/`、`/favicon.svg`、`/favicon.ico` | 工作台页面与图标 |

### 4.3 关键请求/响应

**宫格导入**

```json
POST /api/import/sheet
{
  "image": "data:image/png;base64,...",
  "grid": { "rows": 4, "columns": 4, "rowGap": 0, "columnGap": 0,
            "order": "row-major", "trim": "union", "padding": 0 },
  "import": { "fit": "pad", "anchor": "center", "replace": false },
  "projectId": "prj-...",          // 可选；缺省则新建
  "canvas": { "width": 1024, "height": 1024 },
  "name": "宫格动画"
}
```

响应里的 `split`：

```json
{
  "size": [256, 256],              // 统一后的帧尺寸
  "bbox": [12, 8, 244, 236],       // trim=union 时的并集包围盒
  "rects": [[0,0,256,256], ...],   // 每个单元格在原图中的整数矩形（按播放顺序）
  "meta": { "rows":4, "columns":4, "rowGap":0, "columnGap":0,
            "order":"row-major", "trim":"union", "padding":0,
            "fit":"pad", "anchor":"center", "sourceSize":[1024,1024] }
}
```

**自动稳定**

```json
POST /api/align
{ "projectId": "prj-...", "reference": "first", "maxShift": 64, "confidence": 0.08 }
```

响应 `report`：

```json
{
  "reference": "first", "maxShift": 64, "confidence": 0.08,
  "shifts": [{ "frameId":"f-...", "dx":-3, "dy":2, "confidence":12.7,
               "applied":true, "reason":"" }],
  "accepted": 15, "rejected": 1, "mean_abs": 1.8, "max_abs": 5,
  "warnings": []
}
```

注意：`dx/dy` 是**已经取反后的补偿量**，直接加到 `offsetX/offsetY`。

**导出**

```json
POST /api/export
{ "projectId": "prj-...", "format": "gif",
  "options": { "colors": 256, "dither": true, "transparent": true,
               "loop": 0, "minMs": 20, "optimize": false } }
```

也可以直接传 `doc` 快照（不落盘），服务端优先用它。

导出完成任务的结果：

```json
{
  "format": "apng",
  "filename": "anim-20261107-153640-a1b2c3.png",
  "url": "/files/exports/anim-...png",
  "bytes": 5942,
  "width": 34, "height": 34,
  "frame_count": 16,          // 编码器回读的真实帧数
  "exposure_count": 16,       // 时间轴展开后的曝光次数
  "unique_frames": 16,
  "duration_ms": 1320,
  "loop": 0,
  "durations": [80, 80, ...],
  "pixel_exact": true,
  "resampled_ids": [],
  "warnings": [],
  "options": { "loop": 0 }
}
```

精灵表结果额外包含 `atlas_url`，且 `frame_count` 是**去重后的可见帧数**（`hold` 写进 atlas，不展开）。

### 4.4 错误码

| code | HTTP | 触发场景 |
| --- | --- | --- |
| `bad_request` | 400 | 参数非法、图片数据无法解析 |
| `invalid_doc` | 400 | 字段清洗失败（`DocError`） |
| `invalid_grid` | 400 | 行列/间隔导致每格 <1px、格子超过 256 |
| `missing_field` | 400 | 缺少 `image` / `images` / `projectId`+`doc` |
| `empty_timeline` | 400 | 对齐/调色时没有任何帧 |
| `not_found` | 404 | 项目/任务/帧文件不存在 |
| `missing_frame` | 404 | 文档引用的帧文件丢失 |
| `no_frontend` | 404 | `web/index.html` 缺失 |
| `internal_error` | 500 | 未捕获异常（含类型与消息） |

### 4.5 任务状态机

```
queued ──► running ──► done
   │           ├────► error
   └───────────┴────► canceled
```

- 单 worker 串行；导出期间新任务排队；
- `progress = {value, max, label}`，导出分两段：合成（0~帧数）→ 编码（帧数~总数）；
- 取消：`cancel_requested` 在合成循环和编码循环里轮询，抛 `AnimationCanceled`；
- 历史：`_data/jobs.json` 原子写，最多 40 条；进程被硬杀后，重启把 `queued/running` 标成 `error: 服务重启：该任务未完成`。

---

## 5. 算法细节

### 5.1 宫格切分（`core/sheet.py`）

**单元格边界**

```
cell_w = (W - colGap × (cols - 1)) / cols
left   = round(col × (cell_w + colGap))
right  = round(left + cell_w)
```

- 全部是整数像素，**不做任何缩放**；
- 与主项目 `server/imageops.py::op_grid` 同一套取整方式；
- 上限：`rows × cols ≤ 256`，每格至少 1px，否则 400 `invalid_grid`。

**顺序**

| `order` | 播放顺序 |
| --- | --- |
| `row-major` | 0,1,2,…（行优先） |
| `serpentine` | 偶数行正序、奇数行倒序（蛇形） |
| `column-major` | 先列后行 |

**裁边 `trim`**

| 值 | 行为 | 适用 |
| --- | --- | --- |
| `union`（默认） | 取所有格子 alpha 包围盒的**并集**，每帧裁同一个矩形 | 保留角色在格内的相对位移，做走路/位移动画 |
| `each` | 每格各自按 alpha 包围盒裁 | 每格角色都居中，只关心姿态 |
| `none` | 整格保留 | 需要完整格子尺寸/后续自己对齐 |

- `padding` 在包围盒外扩，向内钳到格子边界；
- 并集为空（全透明）或包围盒非法时，退回整格并写 warning；
- `trim=union` 的 `bbox` 会同时返回给前端画预览线。

**统一尺寸**

| `import.fit` | 行为 |
| --- | --- |
| `pad`（默认） | 透明补边到最大尺寸；水平居中 + `anchor` 控制垂直（`center/top/bottom`）；**纯整数粘贴** |
| `stretch` | LANCZOS 拉伸到最大尺寸；写 warning「会重采样，不再满足零像素偏移」 |

### 5.2 合成与零像素偏移（`core/compose.py`）

单帧处理顺序（严格按此顺序，前端 `stage.js` 完全同构）：

```
源图 RGBA
  → ① scale（显式缩放，LANCZOS；尺寸相同则跳过）
  → ② rotation（expand=True，BICUBIC；0° 跳过）
  → ③ fit_into（contain/cover/stretch/none；整数裁剪 + 整数粘贴）
  → ④ opacity（只乘 alpha）
  → ⑤ offsetX/offsetY（四舍五入到整数）
  → ⑥ 画布 alpha_composite
```

**零偏移快路径**

```python
if (not resampled and offset_x == 0 and offset_y == 0
        and placed.size == (width, height) and background[3] == 0):
    return placed.copy()
```

成立时直接返回 `copy()`，连 alpha 合成的往返都省掉，**输出与输入逐字节相同**。
这是"4×4 宫格切成 34×34、导出 APNG 后 `pixel_exact=true`"的关键。

**重采样标记**

| 触发 | `resampled` | 备注 |
| --- | --- | --- |
| `scale != 1` 且尺寸变化 | ✅ | reason「缩放 ×N」 |
| `rotation != 0` | ✅ | reason「旋转 N°」 |
| `fit_into` 发生缩放（contain/cover/stretch 尺寸不等） | ✅ | reason「画布适配 fit」 |
| 仅整数位移 / 仅 `opacity` / `fit_into` 尺寸已相等 | ❌ | 仍逐像素 |
| 位移是小数 | ❌ | 四舍五入并记 reason「位移已取整」 |

**cover 语义**：等比放大到覆盖画布，再**中心整数裁剪**，`info["offset"]` 记录 `(-left,-top)`；不改变颜色。

**负位移**：允许，超出画布的部分被裁掉（Pillow `alpha_composite` 负坐标会正确裁剪）。

**背景色**：`#rrggbb` → 不透明；空串 → 全透明。背景不透明时不会走快路径（因为要先铺底色）。

### 5.3 自动稳定（`core/align.py`）

**信号预处理**

```
luma   = 0.299R + 0.587G + 0.114B
signal = luma × (A/255)
signal = signal − mean(signal)
signal = signal × hanning2d          # 抑制 FFT 循环卷绕的假峰
```

透明区域被 alpha 自然压成 0，不会主导相关性。

**相位相关**

```
spectrum     = rfft2(ref) × conj(rfft2(cur))
spectrum    /= max(|spectrum|, 1e-8)     # 只保留相位
correlation  = irfft2(spectrum, s=ref.shape)
peak         = argmax(correlation)
dy, dx       = −peak_y, −peak_x          # 峰在 −shift，取反才是 cur 相对 ref 的位移
```

- 正数 `dx` 表示 **current 的内容在参考帧的右方**；
- 峰映射回 `[-N/2, N/2)`；
- `maxShift` 对估计值先夹取；
- 置信度 `confidence = (peak − mean) / std`，默认阈值 `0.08`。

**参考帧**

| `reference` | 做法 | 特点 |
| --- | --- | --- |
| `first`（默认） | 第 0 帧为参考，逐帧独立估计 | 最稳，适合固定机位 |
| `previous` | 与上一帧比较，位移**累加**后取反 | 适合长镜头漂移；误差会累积 |
| `median` | 前 24 帧逐像素中位数作为参考 | 对单帧异常更鲁棒 |

**补偿与拒绝**

- 补偿量 = `−位移`，写入 `offsetX/offsetY`；
- 置信度不足 → 不应用，`reason=置信度不足`；
- 超过 `maxShift` → 不应用，`reason=超过最大位移`；
- 第 0 帧永远 `dx=dy=0, applied=true, reason=参考帧`；
- 报告含 `accepted/rejected/mean_abs/max_abs`；
- API 额外返回 `jitter_before`（逐帧灰度绝对差的均值/最大值）。

**重要语义**：`apply_offsets` 是**在现有 offset 上累加**，因此同一项目重复点"自动稳定"会叠加补偿。它适合"拍完先对齐一次"，不是幂等操作；需要重来时应先手动清零位移（当前版本未提供"重置对齐"按钮，移植时可补）。

### 5.4 色彩一致 / 去闪烁（`core/color.py`）

**统计**

- 作用范围：`scope=subject` 只取 `alpha > 8` 的像素；`full` 取全图；
- 每帧每通道算 `mean`、`std`；
- 参考目标：
  - `median`（默认）：所有帧 `mean/std` 的**逐通道中位数**（不偏向任何一帧）；
  - `first`：第 0 帧的统计量。

**仿射校正**

```
gain   = clip(target_std / std, 0.9, 1.1)
offset = clip(target_mean − mean × gain, −24, +24)
out    = clip(rgb × (1 + strength × (gain − 1)) + strength × offset, 0, 255)
```

- `strength=0` 不改变；`strength=1` 完全匹配；
- `subject` 模式下按 `alpha/255` 加权，透明边缘不会被硬改；
- **alpha 通道完全不参与计算，逐字节保留**；
- 触发夹取的帧会写 warning「校正量触及安全上限」。

**还原**

- 首次调色时，若 `sourceUrl` 为空，把它设为当前 `url`；
- 调色结果写成新 PNG，`url` 指向新文件，`sourceUrl` 保留原图；
- `POST /api/color-match/revert` 把 `url` 指回 `sourceUrl` 并清空 `sourceUrl`，因此还原是**零损失**的；
- 重复调色时输入取 `sourceUrl`，不会累积漂移。

### 5.5 时间轴（`core/timeline.py`）

| 概念 | 规则 |
| --- | --- |
| 单次曝光时长 | `duration > 0 ? duration : max(10, round(1000/fps))` |
| 曝光次数 | `hold`（1~240） |
| 展开序列 | 每个可见帧重复 `hold` 次，record 含 `frameId/frameIndex/duration/holdIndex/holdTotal` |
| 乒乓 | `direction=pingpong` 且帧数 >2：`0,1,…,n-1,n-2,…,1`（首尾不重复） |
| GIF 时长 | 先四舍五入到 10ms 档：`floor(v/10 + 0.5) × 10`，再取 `minMs` 下限 |
| 总时长 | 所有曝光的 `duration` 之和 |

`summary()` 返回帧数、可见帧数、曝光数、总毫秒/秒、fps、方向、循环。

### 5.6 导出（`core/encode.py`）

所有导出都基于 `render_doc()` 合成后的画布尺寸图，导出器**只编码，不改几何**。

| 格式 | 关键实现 | 透明 | 无损 |
| --- | --- | --- | --- |
| GIF | `quantize(MEDIANCUT)`，透明模式保留索引 0（`alpha<128` 透明），`disposal=2`；非透明先铺背景色，`disposal=1` | 1 位 | ❌ |
| APNG | Pillow `save_all`，`disposal=1`，`blend=0`，`optimize=False` | 8 位 | ✅ |
| WebP | `save_all`，`quality=92`，`lossless=true`（默认），`method=4`，`exact=True` | 8 位 | 无损模式下 ✅ |
| PNG 序列 | ZIP（deflate 6）：`frame_0001.png…` + `manifest.json`（canvas、timeline、逐帧 duration） | 8 位 | ✅ |
| 精灵表 | 可见帧按 `columns`（默认 4）整数粘贴，生成 `.atlas.json` | 8 位 | ✅ |

**GIF 调色板细节**

- `colors` 夹 2~256；透明模式给透明色留 1 个索引，其余 `colors-1`；
- 调色板强制补齐到 768 字节；
- `transparency=0`、`disposal=2`；
- `optimize` 默认关闭（开启后 Pillow 会合并相同帧，帧数可能少于曝光数）。

**编码后回读**

- GIF/APNG/WebP 编码完成后重新打开，读取真实 `n_frames` 与逐帧 `duration`；
- 若真实帧数 < 曝光次数，写 warning「编码器把 N 次曝光合并成 M 帧（播放时长不变）」；
- `duration_ms` 与 `durations` 使用**回读值**，保证和播放器一致。

**`pixel_exact` 判定**

```python
pixel_exact = rendered.pixel_exact and (info.lossless or fmt in ("apng", "png-sequence"))
```

- `rendered.pixel_exact`：所有帧都没有重采样；
- GIF 永远 false；
- WebP 只有无损模式才可能 true；
- 精灵表单独用 `rendered.pixel_exact`（不展开 hold）。

**精灵表 atlas**

```json
{
  "image": "anim-...png",
  "width": 1036, "height": 1036,
  "columns": 4, "rows": 4, "padding": 4,
  "cell": { "w": 256, "h": 256 },
  "frames": [
    { "index": 0, "x": 0, "y": 0, "w": 256, "h": 256,
      "id": "f-...", "name": "帧 01", "duration": 83, "hold": 1 }
  ]
}
```

---

## 6. 零偏移 / 无损保证矩阵

| 场景 | 合成重采样 | APNG/PNG 序列 | WebP 无损 | GIF |
| --- | --- | --- | --- | --- |
| 宫格 `trim=union`/`none` + `fit=pad`，画布 = 帧尺寸 | ❌ | 逐字节一致 | 逐字节一致 | 量化误差 |
| 同上 + 整数 `offsetX/offsetY` | ❌ | 逐字节一致 | 逐字节一致 | 量化误差 |
| `fit=contain` 且帧尺寸 = 画布 | ❌（快路径） | 逐字节一致 | 逐字节一致 | 量化误差 |
| `fit=contain` 尺寸不等 | ✅ | 有 LANCZOS 误差 | 同左 | 同左 |
| `fit=cover` / `stretch` | ✅ | 有误差 | 有误差 | 有误差 |
| `scale≠1` / `rotation≠0` | ✅ | 有误差 | 有误差 | 有误差 |
| `opacity<1` | ❌（只改 alpha 值，不插值） | alpha 被改写，但几何无偏移 | 同左 | 半透明被硬切 |

**必须明确告诉用户的三件事**

1. `pixel_exact` 只描述**几何与编码**，不描述"颜色是否被调过"；去闪烁本身就是有意改色。
2. GIF 的透明只有 1 位（`alpha < 128` 直接透明），半透明边缘会出现硬边，这是格式限制。
3. 只要出现缩放/旋转/`cover`/`stretch`，就一定会重采样，`resampled_ids` 会列出具体帧。

---

## 7. 前端设计（零构建）

### 7.1 模块

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | 启动、项目切换、保存状态、播放控制、快捷键、主题、退出前 flush |
| `src/store.js` | 单一状态树、所有变更动作、防抖保存（700ms）、revision 防覆盖 |
| `src/api.js` | `fetch` 封装、统一错误、任务轮询 |
| `src/utils.js` | DOM 构造、数字/颜色/时间格式化、防抖 |
| `src/stage.js` | Canvas 舞台：几何管线与后端 `compose.py` 同构、洋葱皮、辅助线、缩放/像素化 |
| `src/player.js` | rAF 播放、乒乓、逐帧步进、时间读数 |
| `src/filmstrip.js` | 缩略图、`×N` 停顿标记、拖拽排序、键盘选择 |
| `src/inspector.js` | 帧属性面板（名称/停顿/时长/位移/缩放/旋转/不透明度/显示/锁定/备注） |
| `src/tools.js` | 导入/导出弹窗、注册表驱动表单、宫格预览线、任务进度与结果 |
| `assets/app.css` | 设计令牌（与主项目同源）、亮/暗主题、响应式 |

### 7.2 状态流

```
用户操作
  → store 动作（updateFrame / reorder / updateCanvas / …）
  → state.rev += 1，emit()
  → stage / filmstrip / inspector 订阅重绘
  → debounce 700ms → saveNow()
```

`saveNow()` 的关键逻辑：

1. 复制当前 `rev` 与文档快照；
2. `PUT /api/projects/{id}`；
3. 返回时若 `state.rev` 已变化 → 保持 dirty 并重新排一次保存（**防止慢请求覆盖新编辑**）；
4. 未变化 → 清 dirty，回写 `updatedAt`；
5. `beforeunload` / `visibilitychange(hidden)` 调 `flushSave()`。

### 7.3 舞台几何同构

`stage.js` 与 `compose.py` 使用同一顺序：**缩放 → 旋转 → 画布适配 → 锚点 → 整数位移**；
`fit=none` 时按左上角放置并叠加 offset。
这样"画布上看到的位置"和"导出后的位置"一致，不会出现前端对齐、后端错位。

洋葱皮：上一帧蓝色 tint、下一帧橙色 tint，只影响显示，不影响导出。

### 7.4 交互约定

| 操作 | 快捷键 |
| --- | --- |
| 播放 / 暂停 | `Space` |
| 上一帧 / 下一帧 | `←` / `→` |
| 首帧 / 末帧 | `Home` / `End` |
| 删除帧 | `Delete` |
| 保存 | `Ctrl/Cmd + S` |
| 复制帧 | `Ctrl/Cmd + D` |
| 导入 | `I` |
| 导出 | `E` |

- 导入弹窗支持拖放、宫格/多图两个 tab；
- 宫格预览线使用**与后端相同的 round 公式**，所见即所得；
- 导出弹窗按 `EXPORT_FORMATS` 自动渲染选项，并在结果里显示「逐像素一致 / 含重采样 / 受格式限制」；
- 响应式断点 600 / 900 / 1600 已验证，暗色主题与主项目令牌同源。

---

## 8. 性能与资源

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 任务并发 | 1 个 worker | 导出吃 CPU/内存，串行最稳；不会碰 GPU |
| 帧数上限 | 512 | 文档清洗时截断 |
| 宫格上限 | 256 格 | `rows × cols` |
| 内存 | 1024² RGBA ≈ 4MB/帧 | `render_doc` 会缓存所有合成结果；建议 1024² 下 ≤128 帧，2048² 下 ≤32 帧 |
| 导出重复曝光 | 只复制引用，不复制像素 | 但 GIF 每次曝光都会单独量化，`hold` 很大时耗时线性增长 |
| PNG 序列 | ZIP deflate 6 | 逐帧 PNG 独立压缩 |
| 进度 | 合成 + 编码两段 | `progress.max = 帧数 + 曝光数` |

---

## 9. 移植进主项目

### 9.1 总原则

1. **先搬后端算法，再搬路由，最后搬前端**；每步都能独立验证。
2. **所有新增路由加 `/api/animation` 前缀**，避免与主项目冲突：
   - 主项目已有 `/api/jobs/{job_id}`、`/api/history`、`/api/options`；
   - 动画套件也有同名语义，必须命名空间隔离。
3. **静态目录改名**：主项目已占用 `/files`、`/src`、`/assets`；动画页建议：
   - 页面：`/animation`
   - 静态模块：`/animation/src/*`、`/animation/assets/*`
   - 数据：`/animation/files/*`（或复用主项目 `/files`，前提是数据根目录一致）
4. **不改主项目既有模块行为**：只新增文件 + 在 `server/main.py` 里 `include_router` 与挂载静态目录。

### 9.2 后端落地步骤

| 步骤 | 动作 | 验证 |
| --- | --- | --- |
| 1 | 复制 `animation_kit/core/` → `server/animation/` | `python -c "from server.animation import compose"` |
| 2 | 把 `config.py` 的路径改成**注入式**：`configure(base_dir, exports_dir)`，不再依赖包内 `_data/` | 传主项目 `data/` 下的子目录能正常读写 |
| 3 | 把 `server/app.py` 的路由改造成 `APIRouter(prefix="/api/animation")` | OpenAPI 里路径全部带前缀 |
| 4 | 在 `server/main.py` 的 `lifespan` 里启动动画任务队列（或复用主队列，见 9.3） | `/api/animation/health` 返回队列状态 |
| 5 | 导出落盘换成 `storage.save_output(data, prefix="anim", ext=...)` | 导出文件出现在主项目输出目录/图库 |
| 6 | 帧文件仍放动画自己的目录（不要写进 `materials/`） | 删除项目只清动画帧目录 |
| 7 | 静态：`app.mount("/animation/files", StaticFiles(directory=anim_data))` 等 | 浏览器能打开 `/animation/` |

**路由拆分建议**

```
server/animation/
├─ __init__.py
├─ config.py          # 注入 base_dir
├─ registry.py ...    # 原 core/*
├─ routes.py          # APIRouter(prefix="/api/animation")
├─ jobs.py            # AnimationJobQueue（独立 worker）
└─ web/               # 独立页面（阶段 1）
```

主项目 `server/main.py` 只加三行：

```python
from server.animation import routes as animation_routes
app.include_router(animation_routes.router)
```

（静态挂载在 `routes.py` 内部完成，或由 `main.py` 统一挂。）

### 9.3 任务队列怎么选

| 方案 | 优点 | 代价 | 建议 |
| --- | --- | --- | --- |
| A. 复用主项目 `jobs.JobQueue` | 历史/取消/前端进度组件统一 | GIF 导出会占住 GPU 队列的 worker，期间采样任务排队 | 不推荐 |
| B. 独立 `AnimationJobQueue`（当前实现） | 导出不阻塞 GPU 任务；语义独立 | 多一个 worker 线程；历史分两处 | **推荐** |
| C. 独立队列 + 统一历史视图 | 兼顾两者 | 需要前端合并两个 `/history` | 二期可选 |

无论哪种，都要注意主项目 `Job.submit(kind, fn, prompt=...)` 与本套件 `submit(kind, fn, params=..., meta=...)` 签名不同，不能直接互换。

### 9.4 前端落地

**阶段 1（低风险）**：把 `animation_kit/web/` 原样作为独立页面挂到 `/animation`。
- 所有 `fetch('/api/...')` 改成 `/api/animation/...`；
- 图片 URL 改成 `/animation/files/...`；
- 与主项目共用顶部导航时，用 `<a href="/animation">` 跳转（不强行并入 SPA）。

**阶段 2（体验统一）**：拆成主项目组件。

```
web/src/components/animation/
├─ animationPage.js      # 页面骨架（左栏/舞台/右栏）
├─ stage.js
├─ filmstrip.js
├─ inspector.js
├─ importDialog.js
├─ exportDialog.js
└─ animationStore.js     # 或复用主项目 store 的命名空间
```

- 主项目前端也是零构建 ES module，可直接 import；
- 设计令牌沿用主项目 `web/assets/css/theme.css`，本套件的 `app.css` 只保留动画专属布局；
- 主项目 `app.js` 增加一个视图入口，切换时挂载/卸载动画模块。

### 9.5 与主项目模块的复用边界

| 模块 | 是否复用 | 说明 |
| --- | --- | --- |
| `server/imaging.decode_image` | **可复用** | 语义一致；移植时可用适配器替换 `core/images.decode_image`，减少一份解码逻辑 |
| `server/imaging.encode_png` | **可复用** | 同上 |
| `server/align.py` | **不复用** | 它是画布/遮罩几何变换；动画需要的是帧间平移估计 |
| `server/align.reinhard_match` | **可选复用** | 若未来要"局部去闪烁"（只调主体区域），可借它的过渡带匹配；当前用全局 gain/offset 更稳 |
| `server/jobs.py` | **语义参考** | 见 9.3，不建议直接共用队列 |
| `server/storage.save_output` | **导出复用** | 让动画导出进入主项目输出体系 |
| `server/storage.save_upload` | **不建议复用** | 动画帧有自己的项目目录结构，混用会污染素材库 |
| `engine/` / ComfyUI | **完全不涉及** | 本套件是纯后处理，不加载任何模型 |

### 9.6 移植后的验收顺序

1. `GET /api/animation/health` 正常；
2. 4×4 宫格导入 → 16 帧、画布尺寸正确；
3. 整数位移 → 导出 APNG，`pixel_exact=true`、`resampled_ids=[]`；
4. 自动稳定 → 位移写回、`report.accepted` 合理；
5. 色彩一致 → 帧文件被替换、`sourceUrl` 保留；还原后字节一致；
6. GIF 导出 → 有 1 位透明 warning、帧数合并提示；
7. 主项目原有 `/api/generate`、`/api/edit`、图库、历史不受影响；
8. 主项目原有测试全绿。

---

## 10. 测试与验收

### 10.1 运行测试（重要）

仓库根目录的 `pytest.py` 是本地 shim，会遮蔽真实 pytest（表现为"没有测试数量、退出码 0"）。
请用 unittest：

```powershell
python -m unittest discover -s animation_kit/tests -t .
```

当前结果：**33 项通过**（`test_core.py` 26 项 + `test_api.py` 7 项）。

### 10.2 覆盖点

| 模块 | 覆盖 |
| --- | --- |
| `registry` | 默认值、夹取、枚举回退、帧数上限、id 去重 |
| `sheet` | 4×4 切分、round 边界、三种 order、三种 trim、pad/stretch、warnings |
| `compose` | 快路径逐字节一致、整数位移、缩放/旋转标记、opacity、负位移 |
| `align` | 符号约定（右移 → dx>0）、maxShift 夹取、置信度拒绝、previous 累加、jitter |
| `color` | gain/offset 夹取、alpha 不变、median/first 参考、还原 |
| `timeline` | duration 回退、hold 展开、pingpong、GIF 10ms 四舍五入 |
| `encode` | 五种格式产物、GIF 透明索引、APNG 回读帧数、精灵表 atlas、`pixel_exact` |
| `api` | 项目 CRUD、宫格导入、align、color-match/revert、导出任务轮询、错误码 |

### 10.3 浏览器冒烟（已执行）

| 项 | 结果 |
| --- | --- |
| 4×4 透明宫格导入 | 16 帧、画布 34×34、预览线 10 条 |
| replace 导入 | 正确替换旧帧 |
| 拖拽排序 / 键盘选择 | 正常 |
| 自动稳定 | 16 帧补偿写回 |
| 色彩一致 + 还原 | 正常 |
| 新建/切换项目、自动保存 | 正常 |
| GIF 导出 | 成功，warning 正确 |
| APNG 导出 | `pixel_exact=true`、无 warning、5.8KB |
| 暗色主题、600/900/1600 响应式 | 正常 |
| 控制台 | 零报错 |

### 10.4 像素级验收（建议保留为回归）

```python
# 伪代码：整数位移 + 等尺寸画布 → APNG 解码后应与源图逐字节一致
src = Image.open("frame.png").convert("RGBA")
doc = {... "canvas": {"width": src.width, "height": src.height},
          "frames": [{..., "url": url, "offsetX": 0, "offsetY": 0}]}
rendered = compose.render_doc(doc, loader)
assert rendered.pixel_exact
result = encode.export_animation(doc, rendered, "apng", {"loop": 0}, ...)
decoded = Image.open(result_path).convert("RGBA")
assert decoded.tobytes() == src.tobytes()      # max_abs == 0
```

---

## 11. 已知限制与后续可选增强

| # | 现状 | 影响 | 可选增强 |
| --- | --- | --- | --- |
| 1 | 自动稳定重复执行会累加 offset | 不是幂等 | 保存"对齐前 offset"快照，提供重置/重算 |
| 2 | 去闪烁会生成新帧文件，旧文件不自动清理 | 磁盘增长 | 项目级 GC 或写入前覆盖同名文件 |
| 3 | 精灵表使用去重后的可见帧，`hold` 只写 atlas | 直接播放精灵表不会自动停顿 | 导出时可选"展开 hold" |
| 4 | 没有撤销/重做 | 误操作只能手动改回 | 命令栈或 project 版本快照 |
| 5 | `background` 只支持 `#rrggbb` | 不支持半透明底色 | 支持 `#rrggbbaa` |
| 6 | GIF `optimize` 会合并相同连帧 | 帧数与曝光数不一致 | 已用回读 + warning 明示 |
| 7 | 帧缓存全量驻留内存 | 大项目占内存 | 分块渲染 / 临时文件交换 |
| 8 | 无鉴权，仅本机 | 不能直接暴露公网 | 移植后沿用主项目的部署边界 |

---

## 12. 一页速查

```
启动：      python -m animation_kit
测试：      python -m unittest discover -s animation_kit/tests -t .
数据：      animation_kit/_data/（ANIM_KIT_DATA 可改）
宫格：      round(col*(cell_w+gap))，trim=union 保留位移
合成：      缩放→旋转→适配→锚点→整数位移；等尺寸+零位移走 copy() 快路径
稳定：      FFT 相位相关，整数补偿，dx>0 = 内容在参考帧右侧
去闪烁：    gain 0.9~1.1、offset ±24、alpha 不变、sourceUrl 可还原
时间轴：    hold=曝光次数，duration=0 → 1000/fps，GIF 10ms 取整
导出：      GIF / APNG / WebP / PNG 序列 / 精灵表
保真：      无重采样时 APNG+PNG 序列+WebP 无损逐字节；GIF 永不承诺
移植：      core→server/animation、路由 /api/animation、静态 /animation/*、独立队列
```
