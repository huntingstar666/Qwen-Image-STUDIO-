# 图像处理模块 2.0：原理、架构与实施计划

> 状态：**P0 / P1 后端 / P2 后端 / P3 后端 / P4（高清放大）已落地**：
> 尺寸多模式 + WebP/目标体积/EXIF、水印（`server/mediaops.py` + `/api/image/watermark*`）、
> GIF（图片序列 + 视频两遍调色板 + 拆帧）、SeedVR2 / FlashVSR 与设置分区。
> 前端已补：左侧工具轨分组、尺寸多模式/导出增强、水印面板（含画布拖动定位/吸附/方向键微调）、
> 动图面板、导入菜单（素材仓库 / 最近结果 / 剪贴板 + 粘贴）、
> 结果「收藏素材 / 加入 GIF / 送入图像编辑」、**Apple 三栏 Inspector 重排 + 底部胶片条（多选批量操作）**。
> 本方案全部阶段已落地。
> 日期：2026-11-07
> 范围：`web/src/components/imageTools.js`、`web/assets/css/tools.css`、`server/imageops.py`、新增 `server/mediaops.py`、新增 `server/upscalers/`、`server/config.py`、`server/main.py`、`server/jobs.py`、设置页
> 目标：把「图像处理」从单页工具堆叠，升级为可商用的本地图像工作台：基础处理 + 水印 + GIF + 两套高清放大，并与素材仓库、图像编辑、结果历史打通。全部能力在本仓库内实现，不请求 ComfyUI 或任何其他项目的后端服务。

---

## 0. Git 状态与施工纪律（先看）

当前仓库状态（方案编写时实测）：

```
分支：main
HEAD：5b10db7 docs(panorama): 回写全景方案落地状态与使用说明
已修改未提交：web/assets/css/app.css
未跟踪：docs/PLAN_LLM_PROVIDERS.md、docs/PLAN_STILL_LOOP.md、sheet_test.png、still_loop/
```

施工约束：

1. **不碰 `web/assets/css/app.css`**：它已有未提交改动。图像处理页的样式全部写在 `web/assets/css/tools.css`（该文件已在 `web/index.html:14` 引入，无需改 HTML）。
2. **不回滚、不清理、不 stash 任何现有改动**；不执行 `git checkout -- .`、`git clean`、`git reset --hard`。
3. 新功能以新增文件为主；必须修改的既有文件仅限：`server/main.py`、`server/config.py`、`server/imageops.py`、`server/jobs.py`、`web/src/api.js`、`web/src/components/imageTools.js`、`web/src/components/settings.js`、`web/src/i18n.js`、`requirements.txt`。
4. 本方案确认后，按第 11 节阶段逐个提交；每个阶段独立可回滚。
5. 放大模型是**数据**，从设置页配置的目录读取；算法代码全部随仓库分发（含 vendor 的 `flashvsr_core` + `te_runtime`），运行时不 import `D:\ComfyUI...` 下的任何模块，也不读取 `nodes.pyd`。

---

## 1. 结论先行

- 后端新增三层：
  1. `server/imageops.py` 增强：无损/有损导出、目标体积、EXIF、智能尺寸；
  2. `server/mediaops.py` 新增：水印、GIF、视频探测与取帧；
  3. `server/upscalers/` 新增：SeedVR2 7B 与 FlashVSR 的本地推理适配器、模型扫描、显存管理、分块/融合。
- 前端把当前「左中右三列 + 折叠面板」重构为 **Apple 工作台三栏**：左侧工具轨（固定宽度）、中央画布（缩放/平移/前后对比/播放）、右侧 Inspector（按工具切换参数）+ 底部结果胶片条。
- 工具从「一屏全塞」改为 6 个上下文工作区：`调整`、`尺寸`、`水印`、`动图`、`放大`、`导出`。
- 放大默认策略：**单图质量优先走 SeedVR2 7B fp8；动图/序列/速度优先走 FlashVSR 4×**。两套都可在设置页改默认。
- 设置页新增「图像放大」分区：两个模型目录、默认引擎、默认 DiT/VAE/模型包、推理默认值、扫描与完整性校验。保存写 `config.json` 的 `upscale` 字段，立即生效。
- 所有异步重活（放大、GIF、视频取帧）走现有单 worker 任务队列；进度、取消、错误提示复用 `server/jobs.py`，不新造并发模型。

---

## 2. 现状审计

### 2.1 前端

| 位置 | 事实 | 影响 |
|---|---|---|
| `web/src/components/imageTools.js:244-264` | 页面状态：源图、stagedOps、裁剪、调色、缩放、格式、扩图、结果历史 | 可扩展，但状态集中在一个大闭包 |
| `imageTools.js:266-480` | 单页三列，工具全部折叠堆叠；没有工具级导航 | 新增 4 个工具会变成“长表单”，必须重构 IA |
| `imageTools.js:602-703` | 上传仅支持点击/拖拽，读成 data URL | 需要「从素材仓库选」「从最近结果选」「粘贴」 |
| `imageTools.js:1333` | `processAndSave` 调 `/api/image/process` | 可复用；放大/GIF 需改走任务队列 |
| `imageTools.js:1368-1422` | 结果区/弹窗仅「下载 / 继续编辑」 | 缺「送入图像编辑」「收藏素材」「加入 GIF」「作为放大输入」 |
| `web/assets/css/tools.css` | 独立样式，已在 index.html 引入；大量类名以 `.tools-*` 开头 | 新设计继续用该文件，避免 app.css 冲突 |
| `web/src/components/settings.js:13-19` | 设置分区：外观/模型目录/默认模型/LLM/运行/关于 | 新增 `upscale` 分区 |
| `web/src/handoff.js:26-61` | `setHandoff({images:[{dataUrl}], ...})` + `goToEditPage()` | 可复用为「处理结果 → 图像编辑」 |
| `web/src/components/materials.js` | 素材仓库只处理图片；上传走 `_read_image_bytes` | 图片选择可复用，视频需新通道 |

### 2.2 后端

| 位置 | 事实 | 影响 |
|---|---|---|
| `server/imageops.py:187-195` | 支持 `crop/rotate/flip/resize/adjust/pad32/trim_alpha`，另有 `grid` | 尺寸能力偏弱，需要补模式 |
| `imageops.py:230-258` | `/api/image/process` 只接受 `png/jpeg`，同步执行并落盘 | 加 WebP、目标体积；水印/GIF/放大另开接口 |
| `server/storage.py:50-63` | 对外 URL 统一 `/files/<relpath>`，有目录穿越防护 | 新接口全部复用 |
| `storage.py:123-200` | `save_upload`/`save_output` 自动写缩略图，返回 url/thumb_url/宽高 | 结果结构无需另造 |
| `server/materials.py:109-164` | 素材只支持图片，支持 data URL / `/files/...` 解析 | 图片选择器可直接用；视频不塞素材 |
| `server/jobs.py:57-149` | `Job` 有 `kind`、`progress{value,max,label}`、`images`、`meta`、`cancel_requested` | 放大/GIF 直接复用 |
| `server/jobs.py:270-303` | 单 worker 串行队列；提交/查询/取消 | GPU 不允许并发，放大任务会排队，UI 必须展示队列状态 |
| `server/main.py:950-958` | `/api/engine/free` 只释放 Qwen 引擎 | 需要同时释放放大模型 |
| `server/main.py:66-100` | 空闲 watchdog 只卸载引擎 | 需要同时卸载放大模型 |
| `server/config.py:350-368` | `update_config` 是顶层浅合并 | `upscale` 作为对象需在 API 层做深合并 |
| `server/config.py:555-585` | `scan_models` 只扫 unet/clip/vae/lora | 放大模型另写扫描器，避免污染现有四类 |
| `scripts/run.ps1:37-44` | 启动固定 `-s`，Python 3.13，torch cu130 | 依赖以该解释器实测为准 |

### 2.3 已实测的本机资源

模型（`<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\models`）：

```
SEEDVR2/
  seedvr2_ema_7b_fp8_e4m3fn.safetensors   7.86 GB
  seedvr2_ema_7b-Q8_0.gguf                8.43 GB
  seedvr2_ema_7b-Q4_K_M.gguf              4.54 GB
  ema_vae_fp16.safetensors                0.48 GB

FlashVSR-v1.1/
  diffusion_pytorch_model_streaming_dmd.safetensors  5.41 GB
  LQ_proj_in.ckpt                          0.55 GB
  TCDecoder.ckpt                           0.18 GB
  Wan2.1_VAE.pth                           0.48 GB
  posi_prompt.pth                          0.004 GB
```

依赖（用启动器同一个 `python.exe -s` 实测可导入）：`torch(cu130)`、`torchvision`、`opencv-python`、`omegaconf`、`gguf`、`einops`、`diffusers`、`peft`、`rotary_embedding_torch`、`matplotlib`、`spas_sage_attn`、`triton`、`safetensors`、`psutil`。
系统有 `ffmpeg`，可用于 GIF 调色板两遍法与视频探测。

> 注意：工作流里写的 `seedvr2_ema_3b_fp8_e4m3fn.safetensors` 本机不存在，只有 7B 三种精度。默认模型必须由扫描结果决定，不能硬编码 3B。

---

## 3. 目标与非目标

### 3.1 目标

1. **能力补齐**：水印、GIF、尺寸增强、高清放大（两套算法）。
2. **联动**：导入可从「本地 / 素材仓库 / 最近结果 / GIF 拆帧」；结果可「继续编辑 / 送入图像编辑 / 收藏素材 / 加入 GIF / 作为放大输入 / 下载」。
3. **商业化观感**：Apple 式三栏工作台、上下文工具栏、缩放平移、前后对比、任务进度、空/错/载入状态、快捷键、暗色/浅色、响应式、可访问性。
4. **可配置**：设置页可配放大模型目录、默认模型、默认参数；扫描结果实时反映到工具面板。
5. **全本地**：FastAPI + 仓库内算法代码 + 本机模型/ffmpeg；不调用 ComfyUI 服务、不 import 外部自定义节点。

### 3.2 非目标

- 不做云端 API、不做账号/计费/多租户。
- 不做完整非编（时间线剪辑、音频轨道）；GIF 只做「短视频 → 动图」。
- 不做抠图/换背景/生成式扩图（扩图仍走现有 `/api/image/outpaint-plan` + 图像编辑）。
- 不替换现有 Qwen 生成/编辑管线，只在其前后增加图像工具。
- 不把视频放大做成独立产品；FlashVSR 仅服务静帧与 GIF 序列。

---

## 4. 产品信息架构与关键流程

### 4.1 页面结构

```
┌ Topbar：图像处理  [导入 ▾]                    [撤销] [重做] [导出 ▾] ┐
├──────────┬──────────────────────────────────┬───────────────────────┤
│ 工具轨   │ 画布区                            │ Inspector             │
│ 220px    │                                   │ 320px                 │
│          │  [适应] [1:1] [−] 100% [+] [对比] │  当前工具参数         │
│ 输入     │  ┌─────────────────────────────┐  │  预设/高级（折叠）     │
│  · 调整  │  │                             │  │                       │
│  · 尺寸  │  │        画布 / 前后对比       │  │  任务卡（放大/GIF）    │
│  · 水印  │  │        / 动图播放            │  │                       │
│  · 动图  │  └─────────────────────────────┘  │                       │
│  · 放大  │  状态栏：2048×1365 · 2.4MB · 100% │                       │
│  · 导出  │                                   │                       │
├──────────┴──────────────────────────────────┴───────────────────────┤
│ 结果胶片条：缩略图 × N   [清空] [收藏全部] [送入编辑]                │
└─────────────────────────────────────────────────────────────────────┘
```

- 工具轨是**模式**，不是折叠面板；切工具只换右侧参数，不丢源图与已应用操作。
- 画布区永远存在；未导入时显示 Apple 风格的空状态（虚线投放区 + 三个入口按钮）。
- 结果胶片条固定在底部，支持多选（批量导出、收藏、加入 GIF、批量放大）。

### 4.2 核心用户流程

**A. 单图精修**
导入 → 调整/尺寸/水印 → 画布实时预览 → 导出（可批量格式/体积）→ 结果进入胶片条 → 「送入图像编辑」或「继续处理」。

**B. 素材复用**
导入菜单 →「从素材仓库」→ 网格多选（图片）→ 设为源图 / 直接作为水印 logo / 作为 GIF 帧 / 作为放大输入。

**C. GIF**
动图工作区 → 选「图片序列」或「视频」：
- 图片序列：多选本地/素材/结果 → 拖拽排序 → 每帧时长 → 循环/往返/倒放 → 预览播放 → 生成；
- 视频：上传 → 探测时长/分辨率 → 双滑块截取 → 目标 fps/宽度/裁剪模式 → 生成。
输出进入胶片条，可直接「拆帧继续编辑」。

**D. 高清放大**
放大工作区 → 源图（当前/结果/素材，最多 8 张）→ 选算法（SeedVR2 / FlashVSR）→ 倍率 2×/4×/目标长边 → 高级参数 → 提交任务 → 任务卡显示阶段/进度/取消 → 结果可「1:1 对比」「继续处理」「收藏」「送入编辑」。

**E. 水印**
水印工作区 → 文字或图片水印 → 画布拖动定位（九宫格吸附）/平铺 → 透明度/角度/描边/阴影 → 预设 → 应用到当前或批量 → 导出。

---

## 5. 功能规格（钉死默认值）

### 5.1 输入与素材联动

**导入菜单四项**：
1. 本地文件（图片多选；GIF 拆帧；视频仅在动图工作区允许）
2. 从素材仓库（图片网格多选；复用 `api.materials()`）
3. 从最近结果（`store.state.lastResults`，最多 24 条）
4. 从剪贴板（`paste` 事件，仅图片）

**统一输入规范**：
- 图片：`png/jpeg/webp/gif/bmp/tiff`，单张 ≤ 64MB，总像素 ≤ 80MP；解码前做 `Image.MAX_IMAGE_PIXELS` 防护。
- GIF 导入：默认取前 120 帧，超过提示；每帧保留原 duration，最小 20ms。
- 所有来源最终统一为 `{dataUrl}` 交给现有 `setSourceFromDataUrl`，或 `/files/...` 直接用于大图（避免 base64 膨胀）。
- EXIF 方向在**解码时**统一 `ImageOps.exif_transpose`，前端预览同步按方向显示。

**结果动作**（结果弹窗 + 胶片条多选）：
- 下载
- 继续编辑（设为源图）
- 送入图像编辑（`setHandoff({images:[{dataUrl,name}]})` + `goToEditPage()`）
- 收藏到素材仓库（调用现有素材创建接口，`kind=upload`）
- 加入 GIF 帧
- 作为放大输入
- 批量导出

### 5.2 尺寸与导出增强

`resize` 操作扩展为：

```json
{
  "op": "resize",
  "mode": "exact | percent | long_edge | short_edge | megapixels",
  "width": 2048, "height": 1365,
  "percent": 50,
  "long_edge": 4096,
  "short_edge": 2160,
  "megapixels": 4.0,
  "keep_aspect": true,
  "snap": 0,
  "filter": "lanczos",
  "sharpen_after": 0
}
```

- 默认：`mode=exact`、`keep_aspect=true`、`filter=lanczos`、`snap=0`。
- 百分比吸附：25/50/75/100/150/200/300/400。
- 预设：1:1、4:5、3:4、2:3、16:9、9:16、21:9；社交尺寸（1080×1350、1080×1440、1242×1660、1920×1080、2560×1440）。
- 下采样用 `Image.resize(..., reducing_gap=3)` 防锯齿；`sharpen_after` 用 UnsharpMask(radius=1.0, percent=50~150, threshold=2)。
- 导出格式：`png` / `jpeg` / `webp`；WebP 支持 `lossless` 与 `quality`。
- 目标体积：`target_kb`（32KB~50MB），JPEG/WebP 用二分搜索质量（最多 7 次），PNG 只提示不可控。
- 透明通道：JPEG 导出前铺白底（可配置背景色）；WebP/PNG 保留 alpha。
- 超出 `config.max_image_side`（默认 8192）拒绝并返回 `image_too_large`。

### 5.3 水印

**能力**：
- 文字水印：内容、字体、字号（相对短边 1%~20%）、颜色、透明度 0~100%、旋转 -180~180°、描边、阴影、背景胶囊（可选）。
- 图片水印：上传/素材选择 PNG（支持透明），缩放（相对宽度 2%~60%）、透明度、旋转。
- 位置：九宫格 + 自定义拖动；边距（相对短边 0%~20%）。
- 平铺：角度、横向/纵向间距、透明度；用于防盗图。
- 批量：当前源图 + 选中的结果，最多 20 张。
- 预设：保存/删除（localStorage `q2i.watermark.presets`），内置「右下角版权」「居中大标」「满屏平铺」三套。
- GIF 联动：动图工作区提供「同时加水印」开关，逐帧应用同一水印。

**WYSIWYG 策略**：
- 前端 Canvas 2D 实时预览；参数变化用 `requestAnimationFrame` 合帧，不每次重绘。
- 字体：`GET /api/image/watermark/fonts` 返回系统字体 `{id,label,family,path}`；浏览器用 `local(family)`，服务端 Pillow 用同一路径，保证尽量一致。
- 提供「精确预览」按钮（300ms 防抖）：调用 `POST /api/image/watermark/preview` 返回 960px 预览，解决浏览器与 Pillow 字形差异。
- 拖动定位：指针事件 + 8px 吸附九宫格/中线；方向键微调 1px（Shift 10px）。

**服务端参数**（归一化坐标，避免分辨率耦合）：

```json
{
  "text": "© 2026 Studio",
  "font": "msyh",
  "color": "#ffffff",
  "opacity": 0.55,
  "scale": 0.06,
  "rotation": 0,
  "position": "bottom-right",
  "x": 0.5, "y": 0.5,
  "margin": 0.03,
  "stroke": {"width": 0.004, "color": "#000000"},
  "shadow": {"blur": 0.008, "dx": 0.004, "dy": 0.004, "color": "#00000088"},
  "tile": {"enabled": false, "gap_x": 0.20, "gap_y": 0.12, "angle": -24},
  "image_mark": {"url": "/files/materials/xxx.png", "scale": 0.18, "opacity": 0.8}
}
```

### 5.4 GIF

**两种来源，两条实现路径**：

1. **图片序列 → Pillow**
   - 帧输入：本地多选、素材多选、结果多选、GIF 拆帧。
   - 每帧 duration（默认 100ms）、可单独改；总帧数 ≤ 300。
   - 尺寸：等比缩放到目标宽度（最长边 ≤ 1600），LANCZOS。
   - 全局调色板：把所有帧缩略拼成一张图 → `quantize(colors=256, method=MEDIANCUT)` 得到全局 palette → 每帧 `quantize(palette=global, dither=FLOYDSTEINBERG)`，避免逐帧跳色。
   - 保存：`save_all=True, append_images=frames[1:], duration=[...], loop=0, disposal=2, optimize=True`。
   - 往返（boomerang）：`frames + reversed(frames[1:-1])`；倒放：`reversed(frames)`。
   - 最大输出 50MB，超过则报 `gif_too_large` 并给出建议（降宽度/降帧率/减帧）。

2. **视频 → ffmpeg**
   - 上传：`POST /api/media/upload`，白名单 `mp4/mov/webm/mkv/avi`，≤512MB；`ffprobe` 读取时长、分辨率、fps、码率。
   - 截取：`start/end` 秒；最长 60s。
   - 目标：`fps`（5~30，默认 12）、`width`（默认 720，最长边 ≤1600）、`fit=cover|contain`。
   - 两遍调色板：
     ```
     ffmpeg -ss S -to E -i in.mp4 -vf "fps=F,scale=W:-1:flags=lanczos,palettegen=stats_mode=diff" -y palette.png
     ffmpeg -ss S -to E -i in.mp4 -i palette.png -lavfi "fps=F,scale=W:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 out.gif
     ```
   - 往返/倒放：只对 ≤15s 的片段开放（`reverse` 内存开销大），否则禁用并提示。
   - 进度：`-progress pipe:1 -nostats` 解析 `out_time_ms`，映射为 5%~95%；取消时终止进程并清理临时目录。
   - 临时文件统一 `storage/tmp/gif-<jobid>/`，`finally` 删除。
   - ffmpeg 不可用时回退：用 OpenCV 抽帧 + Pillow 序列编码（质量降级，UI 标注）。

**GIF 结果**：
- 保存为 `.gif`，`save_output` 生成缩略图；结果卡显示动态缩略图、帧数、时长、体积。
- 「拆帧继续编辑」：把 GIF 每一帧转成 PNG 结果（最多 60 帧），进入胶片条。

### 5.5 高清放大

**输入**：1~8 张图片（当前源图、结果、素材）。GIF 序列放大不在本版（可由「拆帧 → 批量放大 → 重新合成 GIF」完成，形成闭环）。

**倍率**：
- `scale=2|4`；也支持 `target_long_edge`（512~8192），最终尺寸取 `min(原图×scale, target_long_edge)`。
- 输出长边硬上限 `upscale.max_output_side`（默认 8192）。
- 输入短边上限：SeedVR2 2048、FlashVSR 1024（超过则先按上限等比缩放，再放大）。

**SeedVR2 参数**（默认值即工作流推荐值）：

```json
{
  "engine": "seedvr2",
  "model": "seedvr2_ema_7b_fp8_e4m3fn.safetensors",
  "vae": "ema_vae_fp16.safetensors",
  "scale": 4,
  "target_short_edge": 0,
  "color_correction": "lab",
  "blocks_to_swap": 0,
  "batch_size": 1,
  "temporal_overlap": 2,
  "seed": 42
}
```

**FlashVSR 参数**：

```json
{
  "engine": "flashvsr",
  "bundle": "FlashVSR-v1.1",
  "scale": 4,
  "quality_profile": "balanced",
  "attention_backend": "auto",
  "attention_budget": 1.0,
  "topk_ratio": 0.18,
  "kv_ratio": 3.0,
  "local_radius": 6,
  "max_tile_edge": 256,
  "blend_overlap": 24,
  "color_fix": true,
  "seed": 42
}
```

**算法选择建议（UI 文案 + 默认路由）**：
- 单张实拍/老照片/人像 → SeedVR2（纹理与人脸更稳，色彩匹配好）。
- 动图拆帧/线条/动画/大批量 → FlashVSR（快、4× 原生、时序一致）。
- 显存 < 16GB → 优先 FlashVSR 或 SeedVR2 Q4 + block swap。
- 设置页可改 `upscale.engine` 默认值；前端仍会按输入类型给出推荐标签。

---

## 6. 算法原理（实现依据）

### 6.1 SeedVR2 7B

**模型组成**
- DiT：`dit_7b.nadit.NaDiT`，36 层，`vid_dim=3072`，24 heads × 128，patch `[1,2,2]`，3D RoPE，窗口 `(4,3,3)`。
- 输入 33 通道 = 16 通道噪声 latent + 16 通道 LR latent + 1 通道 mask；输出 16 通道。
- VAE：`video_vae_v3`，空间 8×、时间 4× 压缩，16 通道，`scaling_factor=0.9152`，fp16。
- 文本条件：固定正/负 embedding（`pos_emb.pt` / `neg_emb.pt`），推理不需要 CLIP/T5。
- 推理：1-step 蒸馏，`cfg_scale=1.0`，`timestep=1000`，Euler `v_lerp`，输出直接由 `x - v` 得到。

**为什么是“修复”而不是“插值放大”**
模型在训练时把低质视频/图像退化分布（模糊、压缩、噪声、下采样）映射回高质分布；LR latent 作为条件逐层注入，因此它能“重建”纹理，而不是只做像素插值。代价是可能产生轻微生成感，所以必须做颜色校正与强度控制。

**单图推理步骤（本项目实现）**
1. 解码 → EXIF 转正 → sRGB → 分离 alpha。
2. 计算目标尺寸：
   - 有 `target_short_edge` 用它；否则 `short_edge = min(原短边×scale, max_output_side 的一半约束)`。
   - 宽高对齐到 16 的倍数（VAE 8× × patch 2×）。
3. 把原图用 Lanczos 预放大到目标尺寸，作为 LR 条件（同时保留一份 bicubic 版本用于颜色校正）。
4. 归一化到 `[-1,1]`，按 `batch_size` 组帧；单图 batch=1；序列按 `temporal_overlap=2` 重叠。
5. VAE encode → latent；按 patch 2×2 做常量 padding，记录 padding。
6. 生成同形状噪声（seed），拼接 LR latent 与 mask，进入 DiT 1-step；
7. VAE decode → 裁掉 padding → 颜色校正（默认 `lab`，保留细节）→ 还原 alpha（alpha 用 Lanczos 单独放大）→ 保存。
8. fp8 权重：按节点加载器的 `float8_e4m3fn` 路径加载并在计算时转 bf16/fp16；GGUF 权重走量化 Linear（Q8/Q4），避免整模型反量化爆显存。
9. `blocks_to_swap>0` 时，每步前把指定数量 block 从 CPU 换入，计算后换出；用于 16GB/24GB 卡。

**显存估算**：7B fp8 ≈ 7.9GB + VAE 0.5GB + 激活 6~12GB（目标短边 2048）；32GB 卡可直接跑，24GB 建议 blocks_to_swap=8~16，16GB 用 Q4 + 20~28。

### 6.2 FlashVSR 1.1（4× 流式）

**模型组成**
- 骨干：Wan2.1 T2V 1.3B DiT（`diffusion_pytorch_model_streaming_dmd.safetensors`，5.4GB）。
- `LQ_proj_in.ckpt`：低质 4× 投影器，把原始 LR 帧映射到 4× 特征网格，逐 block 注入 DiT。
- `TCDecoder.ckpt`：轻量条件解码器，接收 latent + LR 条件，3 次空间 2× 上采样。
- `Wan2.1_VAE.pth`：编码 LR 到 latent（8× 空间压缩）。
- 1-step DMD 蒸馏，`cfg=1.0`，`timestep=1000`；原生 4×。

**流式时序**
- 输入帧数必须是 `4n+1`；内部按 8 帧 latent 为一块流式推进，并用 KV retention 保留前文。
- 首块处理 7 个 LQ 子块建立缓存，后续每块 2 个 LQ 子块；因此**单帧必须复制成 25 帧**（`(25-1)//8-2=1` 个处理块）才能走完一次流式前向，取输出的中间帧作为静帧结果。这个填充值是实现约束，不是可选优化。

**LCSA（Locality-Constrained Sparse Attention）**
- 目的：4× 输出时 token 数暴涨，稠密注意力的 O(N²) 不可承受；同时训练/测试分辨率差会导致伪影。
- 选择规则：每个 query block 保留
  1. 局部窗口内所有 key block（`local_radius`）；
  2. 用 block 均值 Q/K 相似度排序后的前 `topk_ratio` 比例 key block；
  3. 流式块之间按 `kv_ratio` 保留历史 KV。
- `attention_budget` 对首/尾块放大预算，中间块收紧，兼顾质量与速度。
- 本项目实现：
  - **直接运行用户提供的原始实现**：`flashvsr_core/models/wan_video_dit.py` 内部调用 `te_runtime.attention` 的 `generate_sparge_mask` / `sparge_attention`，稀疏后端由上游代码自行选择（`sparse_sage2` → `sparse_sage` → flash/sdpa 回退），本项目不做二次实现、不做数值改写。
  - 保留上游的后端日志（`attention backend=... executed successfully`）并写入任务 meta，便于排查“是否退化成稠密注意力”。
  - 不做“稀疏 vs 稠密数值对齐”自测（没有参考实现可比），改为**固定 seed + 固定输入**的回归基线图，作为版本升级时的画质守门。
- **实现路线（已定稿，2026-11-07 实测验证）**：直接 vendor 用户提供的 `TE-Speed-FlashVSR/flashvsr_core`（Apache-2.0，纯 Python）+ `te_runtime`（编译 pyd），**不重写 LCSA**。理由：自研重写无法保证与原模型训练/蒸馏时一致的稀疏注意力数值行为，会引入不可控的画质漂移；用户明确要求“不能保证就用我给的代码”。只 fork 掉 `nodes.pyd`（依赖 ComfyUI）以及 `__init__.py` 里的 `comfy` 导入，其余算法代码零改动。
- **实测结论（RTX 平台，bf16，256×256，25 帧）**：完整跑通，输出 `[3, 21, 256, 256]`，单块耗时 14.8s，峰值显存 4.11GB，稀疏注意力后端走 `sparse_sage2` 原生 kernel（SM120）。
- **关键构造参数（此前卡点，已确认）**：
  - `Causal_LQ4x_Proj(in_dim=3, out_dim=1536, layer_num=1)`：`LQ_proj_in.ckpt` 只含**一个** `linear_layers.0`（1536×3072），`strict=True` 直接加载；v1.1 用 Causal 版，v1.0 用 Buffer 版。
  - `build_tcdecoder(new_channels=[512, 256, 128, 128], new_latent_channels=784)`：784 = 16 latent + 3×4×8×8（`PixelShuffle3d(4,8,8)` 的 RGB 条件）；`decoder.1.weight` 为 `[512,784,3,3]`，`strict=False` 加载后无尺寸冲突。
  - `LQ_video` 必须与 `height/width` **同分辨率**（先 bicubic 放大到目标尺寸再送入），不是目标的一半；否则 `LQ_latents[0]` 的 token 数与 DiT 序列长度不匹配。

**分块策略（静帧）**
- 输入短边 ≤ 384：整帧一次（输出 ≤1536）。
- 输入短边 > 384：按 `max_tile_edge=256` 切块，块间 `blend_overlap=24`；每块向外扩 8px 上下文，输出后裁掉。
- 融合：余弦/线性羽化权重图，`sum(out*w)/sum(w)`；先融合 RGB，再统一做一次颜色校正，避免块间色差。
- 每块耗时与显存独立，进度可按块上报；取消在块边界生效。

**颜色校正**
- 把输出缩放到 LR 尺寸，在 Lab 空间匹配均值/方差（`color_fix=true`）；保留输出亮度细节，只迁移色彩分布。

### 6.3 两算法对比

| 维度 | SeedVR2 7B | FlashVSR 1.1 |
|---|---|---|
| 骨干 | NaDiT 7B，36 层，3072 dim | Wan2.1 DiT 1.3B |
| 条件注入 | 33ch 拼接（噪声+LR+mask） | LQ 4× 投影逐 block 注入 |
| 时序 | VAE 4× 时间压缩，chunk+overlap | 8 帧 latent 流式 + KV retention |
| 步数 | 1-step 蒸馏 | 1-step DMD |
| 解码 | 视频 VAE（8× 空间） | TCDecoder（8× 空间，LR 条件） |
| 倍率 | 任意目标短边（建议 2×/4×） | 原生 4×（2× 由 4× 降采样） |
| 显存 | 约 16~22GB（7B fp8，2K） | 约 8~12GB（256 tile） |
| 优点 | 纹理/人脸/老片修复强，色彩稳 | 快、4×、时序一致、显存低 |
| 缺点 | 慢、重、可能过度生成 | 单帧要 25 帧填充、依赖稀疏注意力、块接缝 |
| 默认场景 | 单张实拍/人像/老照片 | 动图拆帧/线条/动画/批量 |

### 6.4 共性后处理

1. 颜色校正（Lab 均值方差 / wavelet）。
2. 输出尺寸精确到用户请求；2× 时从 4× Lanczos 下采样。
3. alpha 通道独立放大 + 边缘 1px 羽化，避免白边。
4. 保存前做 sRGB 转换与 ICC 保留（若输入有 ICC）。
5. 结果写 `storage/outputs`，缩略图写 `storage/thumbnails`，元数据记录引擎/模型/倍率/耗时/峰值显存。

---

## 7. 后端设计

### 7.1 新增文件结构

```
server/
  imageops.py                 # 修改：resize 模式、webp、target_kb、EXIF
  mediaops.py                 # 新增：水印、GIF、视频探测/抽帧、ffmpeg 封装
  media_runner.py             # 新增：GIF/视频任务执行器（job fn）
  upscalers/
    __init__.py               # 对外 API：scan/list/run_job/free/status
    registry.py               # 模型扫描、完整性校验、默认选择
    manager.py                # 单例、锁、加载/切换/卸载、显存预检
    common.py                 # 读写、tiling、羽化融合、颜色校正、进度、取消
    seedvr2_runner.py         # SeedVR2 适配器
    flashvsr_runner.py        # FlashVSR 适配器
    sparse_attention.py       # LCSA：spas_sage_attn 适配 + 纯 torch 回退
    vendor/
      seedvr2/                # Apache-2.0，保留 LICENSE/NOTICE 与上游文件头
        src/**                # 仅推理所需：models、core、utils/color_fix、data transforms
        configs_7b/main.yaml
        configs_3b/main.yaml
        assets/pos_emb.pt
        assets/neg_emb.pt
      flashvsr/               # Apache-2.0 上游代码（固定 commit）
        flashvsr_core/**      # models、schedulers、pipelines、configs
```

> `server/upscalers/vendor/` 只存算法源码与配置，不存权重；权重路径来自设置页。`vendor/` 不做 `sys.path` 注入，全部用包内相对导入。

### 7.2 API

#### 7.2.1 放大

`GET /api/image/upscale/models`

```json
{
  "ok": true,
  "engines": {
    "seedvr2": {
      "available": true,
      "models": [
        {"id": "seedvr2_ema_7b_fp8_e4m3fn.safetensors", "label": "SeedVR2 7B · FP8", "path": "D:\\...\\seedvr2_ema_7b_fp8_e4m3fn.safetensors", "size_gb": 7.86, "precision": "fp8", "params": "7B", "vram_hint_gb": 18}
      ],
      "vaes": [
        {"id": "ema_vae_fp16.safetensors", "label": "SeedVR2 VAE · FP16", "size_gb": 0.48}
      ],
      "default": {"model": "seedvr2_ema_7b_fp8_e4m3fn.safetensors", "vae": "ema_vae_fp16.safetensors"}
    },
    "flashvsr": {
      "available": true,
      "bundles": [
        {"id": "FlashVSR-v1.1", "label": "FlashVSR 1.1 · 4×", "path": "D:\\...\\FlashVSR-v1.1", "complete": true, "missing": [], "size_gb": 6.6}
      ],
      "default": {"bundle": "FlashVSR-v1.1"}
    }
  },
  "settings": {"engine": "seedvr2", "max_output_side": 8192}
}
```

`POST /api/image/upscale`

```json
{
  "images": [{"url": "/files/uploads/a.png"}],
  "engine": "seedvr2",
  "model": "seedvr2_ema_7b_fp8_e4m3fn.safetensors",
  "vae": "ema_vae_fp16.safetensors",
  "scale": 4,
  "target_long_edge": 0,
  "params": {"color_correction": "lab", "blocks_to_swap": 0, "seed": 42},
  "format": "png",
  "save_material": false
}
```

返回：`{"ok": true, "job_id": "...", "job": {...}}`。任务 `kind="upscale"`，进度阶段：

```
0-8    排队
8-28   加载模型（首次）
28-38  预处理/编码
38-90  推理（按图/按块）
90-96  解码/颜色校正
96-100 保存
```

`POST /api/image/upscale/cancel` 不需要：复用 `POST /api/jobs/{id}/cancel`（现有）。

#### 7.2.2 水印

- `GET /api/image/watermark/fonts` → 系统字体列表（只读白名单目录，禁止任意路径）。
- `POST /api/image/watermark` → 同步，1~20 张，返回 `images[]`（同 `save_output` 结构）。
- `POST /api/image/watermark/preview` → 单张 960px 预览，返回 `{url, width, height}`，不写正式 outputs（写 `storage/tmp`，1 小时清理）。

#### 7.2.3 动图/视频

- `POST /api/media/upload`（multipart）→ 视频落 `storage/uploads`，返回：
  ```json
  {"ok": true, "url": "/files/uploads/xxx.mp4", "filename": "xxx.mp4", "size": 12345678,
   "duration": 12.4, "width": 1080, "height": 1920, "fps": 30.0, "codec": "h264"}
  ```
- `POST /api/media/gif` → 任务，`kind="gif"`：
  ```json
  {
    "source": "images | video",
    "frames": [{"url": "/files/..."}],
    "durations": [100, 100],
    "video": {"url": "/files/uploads/x.mp4"},
    "start": 0, "end": 5,
    "fps": 12, "width": 720, "fit": "cover",
    "loop": 0, "dither": "sierra2_4a", "colors": 256,
    "boomerang": false, "reverse": false,
    "watermark": {"enabled": false}
  }
  ```
- `POST /api/media/video/probe` → 已有上传 URL 的元数据（前端截取前校验）。
- `POST /api/media/gif/split` → 同步，GIF 拆帧为 PNG 结果（≤60 帧）。

#### 7.2.4 设置

- `GET /api/settings` 增加：
  ```json
  "upscale": {
    "engine": "seedvr2",
    "model_dirs": {"seedvr2": ["SEEDVR2"], "flashvsr": ["FlashVSR-v1.1"]},
    "models": {
      "seedvr2": {"dit": "seedvr2_ema_7b_fp8_e4m3fn.safetensors", "vae": "ema_vae_fp16.safetensors"},
      "flashvsr": {"bundle": "FlashVSR-v1.1"}
    },
    "max_output_side": 8192,
    "device": "cuda",
    "dtype": "bf16",
    "seedvr2": {"color_correction": "lab", "blocks_to_swap": 0, "batch_size": 1, "temporal_overlap": 2},
    "flashvsr": {"quality_profile": "balanced", "attention_backend": "auto", "topk_ratio": 0.18, "kv_ratio": 3.0, "local_radius": 6, "max_tile_edge": 256, "blend_overlap": 24},
    "scan": { ...与 /api/image/upscale/models 同构的扫描摘要... }
  }
  ```
- `POST /api/settings` 接受 `upscale` 对象；在写入前与现有 `config["upscale"]` 做**一层深合并**，避免前端只改一个字段时把其他默认值清空。
- 目录解析规则：相对路径 → `model_root` / `comfy_root` 下解析；绝对路径 → 原样；去重；不存在不报错，扫描结果标 `missing`。

### 7.3 配置默认值（写入 `server/config.py`）

```python
DEFAULT_UPSCALE = {
    "engine": "seedvr2",
    "model_dirs": {"seedvr2": ["SEEDVR2"], "flashvsr": ["FlashVSR-v1.1"]},
    "models": {"seedvr2": {"dit": "", "vae": ""}, "flashvsr": {"bundle": ""}},
    "max_output_side": 8192,
    "device": "cuda",
    "dtype": "bf16",
    "seedvr2": {"color_correction": "lab", "blocks_to_swap": 0,
                "batch_size": 1, "temporal_overlap": 2},
    "flashvsr": {"quality_profile": "balanced", "attention_backend": "auto",
                 "topk_ratio": 0.18, "kv_ratio": 3.0, "local_radius": 6,
                 "max_tile_edge": 256, "blend_overlap": 24, "color_fix": True},
}
```

`load_config` 在缺少 `upscale` 时合并该默认值，旧 `config.json` 无需手工迁移。

### 7.4 模型扫描与默认选择

`registry.py`：

```python
def scan(cfg) -> dict:
    # seedvr2:
    #   递归深度 2，匹配 *seedvr2*.(safetensors|gguf)
    #   文件名解析 params: 3b/7b；precision: fp8/Q8_0/Q4_K_M/fp16
    #   VAE 匹配 *vae*.safetensors，要求 ema_vae_fp16
    # flashvsr:
    #   识别包含以下文件的目录：
    #     diffusion_pytorch_model_streaming_dmd.safetensors
    #     LQ_proj_in.ckpt
    #     TCDecoder.ckpt
    #     Wan2.1_VAE.pth
    #     posi_prompt.pth
    #   complete=False 时列出 missing
    # 返回 [{id,label,path,size_gb,precision,params,vram_hint_gb,complete,missing}]
```

默认选择优先级（仅在用户未显式配置时）：

1. `seedvr2`：`7b_fp8` → `7b-Q8` → `7b-Q4` → `3b_fp8` → `3b-Q8` → `3b-Q4`。
2. `flashvsr`：唯一完整 bundle；多个时按路径字典序，UI 可切。
3. 若显存 < 16GB：SeedVR2 优先 Q4；否则默认 fp8。

`vram_hint_gb` 用文件名精度 + 参数量的经验值，仅用于 UI 提示，不参与硬校验。

### 7.5 显存与生命周期

- `UpscaleManager` 单例，`threading.RLock`；只允许一个引擎驻留。
- 加载前：
  1. `job.check_cancel()`；
  2. 若 Qwen 引擎已加载：`get_pipeline()._engine.free(unload=True)`；
  3. 若已有其他放大引擎：`free()`；
  4. 预检 `torch.cuda.mem_get_info()`，若 `free < weights + reserve`，按配置降级（Q8→Q4 / blocks_to_swap 增加）并给出提示；无法满足则抛 `upscale_oom`。
- 卸载：`del model` → `gc.collect()` → `torch.cuda.empty_cache()`。
- `/api/engine/free` 改为同时释放放大模型；返回 `{"engine": bool, "upscaler": bool}`。
- 空闲 watchdog 同样调用 `upscaler.free()`。
- 进程退出注册 `atexit` 清理。
- 任务串行：放大与 Qwen 生成共用单 worker，避免显存互挤；UI 显示「队列第 N 位」。

### 7.6 错误码（`ApiError.code`）

| code | 触发 | 前端动作 |
|---|---|---|
| `upscale_model_missing` | 扫描不到可用模型 | 弹「去设置」按钮 |
| `upscale_bundle_incomplete` | FlashVSR 缺文件 | 列出 missing |
| `upscale_oom` | 预检/推理 OOM | 建议降精度/开 block swap/换 FlashVSR |
| `upscale_unsupported` | 精度/后端不支持 | 提示换模型 |
| `video_invalid` | ffprobe 失败/编码不支持 | 重新上传 |
| `video_too_large` | >512MB 或 >60s（GIF） | 截短/压缩 |
| `ffmpeg_missing` | 系统无 ffmpeg | 提示安装或回退模式 |
| `gif_too_large` | 输出 >50MB | 降宽/降帧 |
| `watermark_font_missing` | 字体不可用 | 换字体 |
| `image_too_large` | 超过 max side/pixels | 先缩小 |

---

## 8. 前端设计（Apple 级体验）

### 8.1 设计原则

1. **内容优先**：画布最大，工具退后；参数只在需要时出现。
2. **直接操控**：拖动水印、拖动裁剪框、空格拖动画布、滚轮缩放；所见即所得。
3. **渐进披露**：常用参数常驻，高级参数折叠；危险操作二次确认。
4. **即时反馈**：任何异步操作都有阶段、进度、可取消；失败给下一步动作，不只给错误码。
5. **一致性**：沿用 `theme.css` 的 token（`--bg/--panel/--line/--accent/--radius/--shadow/--ease/--dur`），浅色暖纸 + 暗色同构；不引入第二套视觉语言。

### 8.2 布局与组件

| 区域 | 规格 |
|---|---|
| 工具轨 | 220px；分组标题 11px 大写字距；工具项 40px 高、圆角 10px、图标 18px；选中态 `--accent-dim` + 左侧 3px 指示条；支持 `⌘1..6` 切换 |
| Topbar | 64px；左侧标题 + 当前源图名；右侧「导入」菜单、撤销/重做、导出主按钮 |
| 画布工具栏 | 36px 浮动胶囊：适应、1:1、−、百分比、+、对比、网格、背景棋盘 |
| 画布 | 棋盘透明背景；图片居中；`transform: translate/scale` 实现缩放平移；缩放范围 5%~800%；双指/滚轮以指针为中心 |
| 状态栏 | 24px：尺寸、缩放、格式、体积、色彩空间、ICC 标记 |
| Inspector | 320px；标题 + 工具说明 + 参数组；底部固定「应用/重置」；高级折叠 |
| 任务卡 | 显示阶段、进度条、耗时、取消；完成变结果卡 |
| 胶片条 | 96px 高；缩略图 72px；多选；拖拽排序（GIF）；右键菜单 |
| 弹窗 | 复用 `modal.js`；结果详情用 `lightbox.js`；删除/清空用确认弹窗 |

### 8.3 关键交互

- **缩放**：滚轮以指针为中心；`⌘0` 适应，`⌘1` 100%，`+/-` 步进；双击画布在适应/100% 间切换。
- **平移**：空格 + 拖动；中键拖动；触控板双指。
- **对比**：`对比` 按钮进入左右分屏，中间可拖分割线；支持「按住 \ 临时查看原图」。
- **撤销/重做**：`⌘Z` / `⌘⇧Z`；操作栈保存 stagedOps 快照（最多 50），切工具不丢。
- **水印拖动**：拖动即改归一化坐标；靠近九宫格/中线 8px 吸附；方向键微调。
- **GIF 排序**：胶片条拖拽；`Delete` 移除；`←/→` 选中；空格播放/暂停。
- **任务**：提交后按钮进入 loading，任务卡出现；离开页面任务继续，回来仍可查（`/api/jobs/{id}`）。
- **键盘**：`⌘O` 导入、`⌘S` 导出、`⌘Z/⌘⇧Z`、`⌘0/⌘1`、`Space` 平移/播放、`\` 对比、`Esc` 取消当前弹窗。
- **触控**：指针事件统一处理鼠标/触控/笔；触摸双指缩放。

### 8.4 状态与错误

- 空状态：三种导入入口 + 最近结果缩略图。
- 加载：源图解码骨架；放大/ GIFF 任务卡骨架。
- 错误：内联错误条 + 动作按钮（去设置/重试/降级/换算法）。
- 禁用：无源图时工具项禁用并显示 tooltip；模型缺失时放大按钮禁用并显示「未安装模型」。
- 成功：轻量 toast，不打断；批量结果用胶片条高亮新增项。
- 可访问性：所有图标按钮有 `aria-label`；焦点环用 `--accent-ring`；`prefers-reduced-motion` 关闭位移/缩放动画；对比度 ≥ 4.5:1。
- 响应式：≥1440 三栏；1100~1440 Inspector 可折叠为抽屉；<1100 工具轨变顶部横向滚动，Inspector 底部抽屉。

### 8.5 前端文件拆分（避免继续膨胀单文件）

```
web/src/components/imageTools.js          # 入口：createImageToolsPage，组装 shell
web/src/components/image-tools/
  state.js        # 源图/帧/结果/undo-redo/stagedOps，单一数据源
  shell.js        # Topbar + 工具轨 + 画布 + Inspector + 胶片条
  stage.js        # 缩放/平移/对比/棋盘/播放，封装现有 canvas
  inspector.js    # 工具注册与参数渲染
  tools/basic.js  # 裁剪/旋转/翻转/宫格/扩图（迁移现有）
  tools/resize.js # 尺寸/预设/目标体积/格式
  tools/adjust.js # 调色（迁移现有 + 精确预览）
  tools/watermark.js
  tools/gif.js
  tools/upscale.js
  tools/export.js
  results.js      # 结果卡/弹窗/多选/批量动作
  importers.js    # 本地/素材/最近结果/粘贴/GIF 拆帧
  jobs.js         # 提交/轮询/取消/任务卡
  preview.js      # Canvas 预览、水印绘制、GIF 播放
```

- `imageTools.js` 保留导出名 `createImageToolsPage`，`app.js` 无需改路由。
- 现有裁剪几何/画布渲染逻辑优先迁移，不重写算法；迁移以“行为不变”测试为门槛。
- 新增 CSS 全部写 `tools.css`，并在文件头部建立 `.it-*` 作用域，避免污染其他页。

---

## 9. 设置页同步（放大模型目录与默认模型）

### 9.1 新分区

`SECTIONS` 增加：

```js
{ id: 'upscale', icon: 'spark', label: () => t('settings.nav.upscale') }
```

### 9.2 界面

```
图像放大
  默认引擎      [ SeedVR2 (质量) | FlashVSR (速度) ]  分段控件
  模型目录
    SeedVR2      [D:\...\models\SEEDVR2            ] [检测]
    FlashVSR     [D:\...\models\FlashVSR-v1.1      ] [检测]
  默认模型
    SeedVR2 DiT  [seedvr2_ema_7b_fp8_e4m3fn ▾]  7.86GB · FP8 · 建议 ≥18GB
    SeedVR2 VAE  [ema_vae_fp16 ▾]                0.48GB
    FlashVSR     [FlashVSR-v1.1 ▾]               完整 ✓ / 缺少: TCDecoder.ckpt
  推理默认
    输出长边上限 [8192]
    色彩校正     [Lab ▾]
    Block swap   [0]（0=关闭，越高越省显存越慢）
    FlashVSR 质量 [均衡 ▾]  注意力后端 [自动 ▾]
  状态
    ✓ 已检测到 1 个可用放大模型
    ⚠ 7B FP8 预计占用 18GB 显存
  [重新扫描] [释放放大模型显存]
```

- 目录输入支持多个（回车添加 chip，可删除）。
- 「检测」只扫描该目录并即时回显，不保存。
- 保存时提交整个 `upscale` 对象；后端深合并。
- 「释放放大模型显存」调用 `/api/engine/free`，提示释放结果。
- 打开设置时如果指定 `section='upscale'`，直接定位（`openSettings('upscale')`），供图像工具的「去设置」跳转。

### 9.3 i18n

新增键（zh/en 同步）：

```
settings.nav.upscale
settings.upscale.title / desc
settings.upscale.engine / engine.seedvr2 / engine.flashvsr
settings.upscale.dirs / dirs.seedvr2 / dirs.flashvsr / dirs.detect
settings.upscale.defaults / defaults.dit / defaults.vae / defaults.bundle
settings.upscale.max_side / color_fix / blockswap / quality / attention
settings.upscale.scan / free / missing / complete / vram_hint
tools.*（导入、工具名、参数、任务阶段、错误提示）
```

---

## 10. 与现有功能的联动清单

| 现有能力 | 联动方式 |
|---|---|
| 素材仓库 | 图片导入选择器；水印 logo 选择；GIF 帧来源；结果收藏 |
| 最近结果 `store.state.lastResults` | 导入菜单；放大输入；GIF 帧 |
| 图像编辑页 | 结果「送入图像编辑」用现有 `setHandoff`；扩图仍走现有 plan + handoff |
| 任务队列 | 放大/GIF 复用 `/api/jobs/{id}`、取消、历史 |
| 引擎释放 | `/api/engine/free` 与空闲 watchdog 同步释放放大模型 |
| 设置页 | 放大分区读写 `config.upscale`，扫描结果回显到工具面板 |
| 画廊 | 放大/GIF 结果仍是普通 output，自动出现在画廊/最近结果 |
| 下载/缩略图 | 全部走 `storage.save_output`，不另造文件服务 |

---

## 11. 实施步骤（按阶段提交）

### P0 骨架与配置（不动 UI）

1. `server/config.py`：加 `DEFAULT_UPSCALE`、`load_config` 合并、`update_config` 深合并 `upscale`。
2. `server/upscalers/registry.py`：扫描/校验 SeedVR2 与 FlashVSR；默认选择。
3. `server/main.py`：`_settings_view` 增加 `upscale`；`GET /api/image/upscale/models`。
4. `server/upscalers/manager.py`：单例、锁、卸载；`/api/engine/free` 与 watchdog 接入。
5. `server/settings` UI 分区骨架 + 保存/检测。
6. 测试：`test_upscale_registry.py`、`test_config_upscale.py`。
验收：设置页能看到本机 7B 三档 + FlashVSR bundle，保存后重启仍生效；无模型时 UI 给出缺目录提示。

### P1 基础设施与前端壳

1. `imageops.py`：EXIF、resize 模式、WebP、`target_kb`；保持旧请求兼容。
2. `web/src/api.js`：新增 `upscaleModels/upscaleSubmit/mediaUpload/gifSubmit/watermark/watermarkPreview/fonts`。
3. 前端拆分 `state.js/shell.js/stage.js/inspector.js/results.js/importers.js`；迁移现有工具。
4. 新画布：缩放/平移/对比/棋盘；快捷键；空状态。
5. 导入菜单：本地/素材/最近结果/粘贴；结果动作补齐。
6. 测试：`test_imageops_resize.py`、`test_imageops_export.py`；前端手工回归现有裁剪/宫格/调色/扩图。
验收：旧功能行为不变；新壳在 1280/1440/1920、浅色/暗色、减少动效下不破版。

### P2 水印

1. `server/mediaops.py`：字体白名单、文字/图片水印、平铺、批量、预览。
2. `POST /api/image/watermark`、`/preview`、`/fonts`。
3. 前端 `tools/watermark.js` + Canvas 预览 + 拖动吸附 + 预设。
4. 测试：`test_mediaops_watermark.py`（位置/透明度/alpha/批量）。
验收：4K 图上九宫格位置误差 ≤2px；透明 PNG 边缘无白边；20 张批量不超时。

### P3 GIF

1. `mediaops.py`：`probe_video`、`ffmpeg_gif`、`pillow_gif`、`split_gif`、进度/取消。
2. `media_runner.py`；`/api/media/upload`、`/api/media/gif`、`/api/media/gif/split`。
3. 前端 `tools/gif.js`：图片序列排序/时长、视频截取、播放预览、任务卡。
4. 测试：`test_gif_images.py`、`test_gif_video.py`（ffmpeg 缺失时跳过）。
验收：12fps/720px/5s 视频生成 ≤50MB；时长误差 ≤1 帧；取消后无残留临时文件。

### P4 SeedVR2

1. vendor SeedVR2（Apache-2.0）推理子集 + pos/neg embedding + configs。
2. `seedvr2_runner.py`：fp8/GGUF 加载、单图、批量、颜色校正、blockswap、进度、取消。
3. `manager` 接入；`POST /api/image/upscale`。
4. 前端 `tools/upscale.js`：算法卡、参数、任务、1:1 对比、结果动作。
5. GPU 冒烟：256×256 → 1024×1024；512×512 → 2048×2048；记录峰值显存/耗时/PSNR。
验收：输出尺寸精确；无 OOM；与 ComfyUI 参考工作流输出做 SSIM/PSNR 与目视对比，不出现明显色偏/块接缝。

### P5 FlashVSR

1. vendor 用户提供的 `flashvsr_core` + `te_runtime`（Apache-2.0，零算法改动，仅去掉 `nodes.pyd`/`comfy` 依赖）。
2. `flashvsr_runner.py`：25 帧静帧填充、tile/overlap、LQ 条件、TCDecoder、颜色校正。
3. 固定 seed 回归基线图；GPU 冒烟 256/384/512 输入、2×/4×。
4. 前端默认路由与推荐文案；设置页 FlashVSR 参数。
验收：4× 输出尺寸正确；tile 接缝不可见（梯度不连续 < 阈值）；`auto` 后端在 spas 不可用时自动降级且不崩。

### P6 打磨与验收

1. i18n 全量；暗色；响应式；键盘；`prefers-reduced-motion`。
2. 空/错/载入态；错误码到动作映射；队列位置。
3. 性能：大图预览用降采样 canvas；避免 data URL 轮询；缩略图懒加载。
4. 文档：更新 `docs/IMAGE_TOOLS.md`（使用说明）、本方案状态改为“已实施”。
5. 全量 `pytest` + 手工 QA 矩阵。

---

## 12. 测试与验收

### 12.1 自动化（纯 CPU，默认运行）

- `test_config_upscale.py`：默认合并、深合并、路径解析、去重。
- `test_upscale_registry.py`：文件名解析、完整性校验、默认选择、缺文件提示。
- `test_imageops_resize.py`：五种模式、宽高比、snap、EXIF、边界。
- `test_imageops_export.py`：WebP、目标体积二分、alpha 铺底、超限报错。
- `test_mediaops_watermark.py`：九宫格坐标、透明度、平铺、图片水印、批量。
- `test_gif_images.py`：帧数/时长/循环/往返/全局调色板/体积上限。
- `test_gif_video.py`：ffprobe 解析、命令参数拼装（不真跑）、临时目录清理；有 ffmpeg 时跑 1 秒真实样例。
- `test_upscale_tiling.py`：羽化权重和为 1、接缝坐标、2× 降采样、alpha 放大。
- `test_upscale_sparse_attention.py`：纯 torch 回退 vs 稠密注意力（fp32 1e-3）。
- `test_upscale_api.py`：TestClient + monkeypatch runner，验证 job 生命周期/取消/错误码。

### 12.2 GPU 冒烟（`Q2I_RUN_GPU_TESTS=1`，手动）

| 用例 | 输入 | 引擎 | 期望 |
|---|---|---|---|
| S1 | 256×256 合成图 | SeedVR2 7B fp8 | 1024×1024，无 OOM，PSNR > bicubic +1.5dB |
| S2 | 512×512 实拍 | SeedVR2 7B Q4 + swap | 2048×2048，峰值 < 24GB |
| F1 | 256×256 | FlashVSR 4× | 1024×1024，无接缝 |
| F2 | 1024×768 | FlashVSR tile | 4096×3072，拼接无缝，峰值 < 24GB |
| F3 | 384×384 | FlashVSR 2× | 768×768，4× 降采样正确 |
| G1 | 5s 1080p 视频 | GIF | 720px/12fps，≤50MB，时长误差 ≤1 帧 |
| W1 | 4K PNG | 水印 | 九宫格位置误差 ≤2px |

参考对照：同一张图用本机 ComfyUI 跑用户提供的两个工作流，比较 SSIM/PSNR 与目视；**ComfyUI 只作为开发期参照，不作为运行时依赖**。

### 12.3 前端 QA 矩阵

- 宽度：1280 / 1440 / 1920；浅色/暗色；中文/英文。
- 浏览器：Chrome/Edge 最新；Safari（若可用）。
- 输入：透明 PNG、超大 JPEG、EXIF 旋转、GIF、10 张批量。
- 交互：撤销 50 步、缩放 5%~800%、空格平移、对比分割、任务切页回来、刷新后设置保留。
- 可访问性：键盘走完导入→工具→导出；焦点可见；减少动效下无位移动画。

---

## 13. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| FlashVSR 稀疏核在 RTX 50/sm120 不兼容 | 推理失败/极慢 | `auto` 自动回退纯 torch block-gather；默认 SeedVR2；UI 提示 |
| SeedVR2 7B fp8 显存吃紧 | OOM | Q8/Q4、blocks_to_swap、预检、错误建议降级 |
| 模型缺失/工作流写 3B 但本机只有 7B | 功能不可用 | 扫描驱动默认值，不硬编码；缺模型引导设置 |
| 单 worker 被放大长时间占用 | 生成排队 | 任务卡显示队列；可取消；阶段进度 |
| ffmpeg 不存在 | GIF 视频源不可用 | 启动自检；回退 OpenCV+Pillow；明确提示 |
| 字体/字形差异 | 水印预览不一致 | 系统字体映射 + 服务端精确预览 |
| 大图 data URL 轮询卡顿 | 前端卡死 | 一律先 `/api/upload`，任务只传 `/files` URL；`slim_params` 已有保护 |
| 第三方代码许可 | 合规风险 | 只 vendor Apache-2.0 上游；保留 LICENSE/NOTICE；不用无许可的 pyd |
| app.css 未提交改动被覆盖 | 用户工作丢失 | 全部新样式写 tools.css；不动 app.css |

回滚：

- 每个阶段独立提交；P0/P1 只增不删，回滚只需撤销对应 commit。
- 放大模型不写入仓库；删除 `server/upscalers/vendor` 即可移除算法代码。
- 设置默认值向后兼容：旧 `config.json` 无 `upscale` 时自动补默认。

---

## 14. 待确认事项（需要你拍板）

1. **默认引擎**：我建议 `seedvr2`（质量优先），GIF/批量场景前端自动推荐 FlashVSR。是否同意？
2. **SeedVR2 默认精度**：本机 7B 有 FP8/Q8/Q4。我建议默认 FP8，24GB 以下自动建议 Q4 + block swap。是否同意？
3. **GIF 上限**：我建议图片 300 帧、视频 60s、输出最长边 1600、体积 50MB。是否要更宽松/更严格？
4. **水印字体**：首版只做系统字体白名单（微软雅黑/宋体/黑体/Arial 等），不做字体上传。是否可接受？
5. **结果保留**：当前结果只在页面会话内。是否要把胶片条结果持久化到 `localStorage`（刷新后仍在）？我建议持久化元数据，不持久化大图。
6. **放大输入上限**：单次最多 8 张、输入短边 SeedVR2 2048 / FlashVSR 1024。是否调整？

---

## 15. 实施顺序（一句话版）

先做设置与扫描骨架（P0）→ 再重构前端壳和基础增强（P1）→ 水印（P2）→ GIF（P3）→ SeedVR2（P4）→ FlashVSR（P5）→ 打磨验收（P6）。

方案确认后再动代码；当前仅新增本文档，未修改任何业务文件。
