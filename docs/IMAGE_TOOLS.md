# 图像处理台（image-tools-kit 接入）

工作台不只是「出图 + 改图」，还包括出图**前后**的常规处理：裁剪、宫格切分、旋转翻转、缩放、
调色、扩图、格式导出。这些能力来自 `image-tools-kit`，并按本项目的「零偏移 / 零色差」约定重接。

## 1. 为什么分「前端预览」和「服务端落盘」两套

| 层 | 用什么 | 负责 |
|---|---|---|
| 前端 | `web/vendor/image-tools-kit/src/cropGeometry.js` + `clientRenderer.js` | 拖拽手柄、比例约束、实时预览、宫格预览 |
| 服务端 | `server/imageops.py`（Pillow） | 真正落盘、无损 PNG / 可控 JPEG、32 对齐、输出进 `storage/outputs` 供后续编辑复用 |

前端 canvas 出图是 **有损的**（toDataURL 会按浏览器实现重新编码），而且拿不到 32 对齐这类管线规则；
所以「预览用 canvas，定稿走服务端」是唯一既顺手又正确的分工。

## 2. 复用了 image-tools-kit 的哪些东西

| 模块 | 用途 | 在本项目的位置 |
|---|---|---|
| `src/cropGeometry.js` | 裁切矩形、8 手柄命中、比例约束缩放、宫格切分 | 前端直接 import（纯 ES module，零依赖） |
| `src/clientRenderer.js` | 载图 / canvas 裁切 / 下载 | 前端直接 import，用于实时预览与下载 |
| `src/prompt.js` | 全景提示词、扩图草稿、方向 → 视角参数 | 扩图 / 全景入口调用 `buildOutpaintDraft`、`outpaintDirections`、`panoramaPrompt` |
| `react/*.jsx` | 参考交互（React，本项目不用） | 只作实现参考 |
| `server/*.js` | sharp 版后端（本项目用 Pillow 重写） | 参考接口形状 |
| `tests/crop.test.js` | 12 条几何用例 | 参考 |

vendor 位置：`web/vendor/image-tools-kit/`（原样复制，不改）。

## 3. HTTP 接口

### `POST /api/image/process`

```jsonc
{
  "image": "data:image/png;base64,...",   // 也支持 /files/outputs/xxx.png
  "ops": [
    {"op": "crop", "x": 120, "y": 80, "width": 800, "height": 600},
    {"op": "grid", "rows": 2, "columns": 3, "row_gap": 0, "column_gap": 0},
    {"op": "rotate", "angle": 90},
    {"op": "flip", "horizontal": true, "vertical": false},
    {"op": "resize", "width": 1024, "height": 768, "fit": "contain|cover|stretch"},
    // 或按模式：exact | percent | long_edge | short_edge | megapixels
    {"op": "resize", "mode": "long_edge", "long_edge": 2048, "snap": 32,
     "filter": "lanczos", "sharpen_after": 60},
    {"op": "adjust", "brightness": 1.05, "contrast": 1.1, "saturation": 1.05,
                     "sharpness": 1.2, "temperature": 0.1},
    {"op": "pad32"},
    {"op": "trim_alpha", "padding": 8}
  ],
  "format": "png|jpeg|webp",
  "quality": 92,          // JPEG/WebP 质量
  "lossless": false,      // WebP 无损
  "target_kb": 800,       // 可选：目标体积（JPEG/WebP 二分质量；PNG 只提示）
  "background": "#ffffff",// JPEG 透明区铺底颜色
  "prefix": "processed"
}
```

返回：

```jsonc
{
  "ok": true,
  "applied": ["crop", "grid"],
  "count": 6,
  "format": "png",
  "images": [{"url": "/files/outputs/...", "thumb_url": "...", "width": 400,
              "height": 300, "bytes": 12345, "filename": "...", "relpath": "..."}]
}
```

要点：

- **顺序执行**，`grid` 会对当前第一张做切分（先裁再切是常见用法）；
- 所有坐标是**像素**，越界自动收敛（但宽高 < 1 会报 400）；
- `pad32` = 向上对齐到 32 的倍数（补边），这是送进编辑管线前的必备步骤；
- `format=jpeg` 会转 RGB（丢 alpha，透明区按 `background` 铺底）；`quality` 1~100；
- 导出支持 `webp`（`lossless=true` 走无损）；`target_kb` 对 JPEG/WebP 二分搜索质量（最多 7 次），
  返回项里的 `quality` / `target_met` 告诉前端实际用了多少质量、是否达标；
- `resize` 两种写法：旧接口 `width/height + fit`；新接口 `mode + 目标参数`，
  可选 `snap`（对齐倍数）、`filter`（lanczos/bicubic/bilinear/nearest/box）、
  `sharpen_after`（0~200，UnsharpMask）。`keep_aspect` 默认 true，长宽都给时按“放进框内”等比缩小；
- 目标尺寸超过 8192 返回错误码 `image_too_large`；
- 解码时统一 `ImageOps.exif_transpose`，手机竖拍照片不会横着落盘；
- 输出落 `storage/outputs`，可直接用 URL 作为 `image_1` 再送 `/api/edit`。

### `POST /api/image/outpaint-plan`

扩图规划（给前端算画布与遮罩，不需要加载模型）：

```jsonc
// 请求
{"width": 1024, "height": 1024, "direction": "right", "amount": 0.5}
// 响应
{"canvas": {"w": 1536, "h": 1024}, "pad": {"left": 0, "right": 512, "top": 0, "bottom": 0},
 "offset": {"x": 0, "y": 0}, "source": {"w": 1024, "h": 1024}, "amount": 0.5,
 "note": "原图贴到画布 offset 处，遮罩只覆盖新增区域（白=要生成的地方）"}
```

`direction` 支持 `left / right / up / down / horizontal / vertical / all`，
`amount` 是相对对应边长的比例（0.05 ~ 2.0，超出会被收敛）。画布尺寸会向上对齐到 32 的倍数。

**扩图怎么落地**：前端拿 `canvas` + `offset` 造一张遮罩（原图区域=黑，新增区域=白），
然后正常调 `/api/edit`：`size_mode=custom` + `width/height=canvas` + `mask`。
管线的 `compose_canvas` 会把原图按 `pad_mode=edge` 补边到画布，`composite` 保证原图区域逐像素不变，
新增区域由模型生成 —— 天然就是「扩图」。

## 4. 与「局部精准编辑」的关系

图像处理台产出的两种东西直接喂给编辑页：

1. **处理后的图** → 作为 `image_1`（编辑目标）；
2. **遮罩** → 传给 `/api/edit` 的 `mask`（白=编辑区）

配合管线里的两条硬规则，就得到「局部精准编辑」：

- 画布 32 对齐 + 编码器 `resolution=0` → **零像素偏移**；
- 遮罩外逐像素保留原图 + 过渡带 Reinhard 校色 → **零色差**（`quality.outside_max_abs == 0`）。

## 5. 参数推荐

| 场景 | 建议 |
|---|---|
| 送进编辑前 | 先 `pad32`，让画布是 32 的倍数；否则编码器会替你向上取整，可能裁掉边缘 |
| 裁剪比例 | 与目标出图比例一致（如 16:9），避免编辑时再补边 |
| 宫格 | 行/列 ≤ 8，间隔 0~24px；单块建议 ≥ 256px，否则模型细节不足 |
| 调色 | 亮度/对比/饱和在 0.9~1.2 之间微调；色温 ±0.3 以内，过大容易出现通道断层 |
| 导出 | 中间产物用 PNG；最终交付需要小体积再转 JPEG q88~92 |
| 扩图 | `amount` 0.3~0.6；四方向一起扩用 `all`，但画布面积别超过 4MP，否则显存吃紧 |

## 6. 测试

```powershell
& "<python>" -m pytest tests/test_imageops.py tests/test_imageops_resize.py tests/test_imageops_export.py -q
```

覆盖：裁剪尺寸/越界收敛/非法参数、宫格数量与格子尺寸（含间隔）、旋转翻转、三种 fit、
调色改变像素且保持尺寸、色温方向（暖色抬红压蓝）、`pad32` 对齐、alpha 去边、未知操作报错、
落盘与 JPEG 质量、扩图规划（单方向/全方向/amount 收敛）；resize 五种模式/锁比例/snap/
滤镜/锐化/EXIF 方向；WebP、目标体积二分、alpha 铺底、超大尺寸错误码。

水印与 GIF：

```powershell
& "<python>" -m pytest tests/test_mediaops_watermark.py tests/test_gif_images.py tests/test_gif_video.py -q
```

覆盖：九宫格/自定义位置、透明度 0、平铺覆盖、图片水印、空内容报错；GIF 帧数/时长/循环/
倒放/往返/逐帧时长/拆帧/帧数上限；视频探测与真实 1 秒样例转 GIF（无 ffmpeg 自动跳过）。

## 7. 高清放大（SeedVR2 / FlashVSR / VOSR2）

### 7.1 为什么是 vendor 原算法

重写推理代码无法保证与原模型蒸馏一致的画质，所以三套引擎都是**原样 vendor、零算法改动**：

| 引擎 | 代码位置 | 来源 |
|---|---|---|
| SeedVR2 7B | `server/upscalers/vendor/seedvr2/`（`src/` + `configs_7b/` + `configs_3b/` + `pos_emb.pt` / `neg_emb.pt`） | ComfyUI-SeedVR2_VideoUpscaler |
| FlashVSR 1.1 | `server/upscalers/vendor/flashvsr/`（`flashvsr_core/` + `te_runtime/`） | FlashVSR 官方实现 |
| VOSR2 1.4B | `server/upscalers/vendor/vosr2/`（`inference.py` + `loader.py` + `models/`） | ComfyUI-VOSR2（Apache-2.0） |

`server/upscalers/seedvr2_runner.py`、`flashvsr_runner.py`、`vosr2_runner.py` 只做原本由 ComfyUI 节点负责的接线：
模型加载、静图补帧、显存/分块、进度、取消。运行时不 import `comfy*`、不读 ComfyUI 目录代码。
模型是**数据**，路径来自 `config.json` 的 `upscale.dirs`。

VOSR2 原节点包依赖 `comfy.ops` / `comfy.model_management` / `folder_paths` / `comfy.utils.ProgressBar`，
vendor 时用最小兼容层替换：`vendor/vosr2/ops_compat.py`（`torch.nn` 别名层）、`progress.py`、
`loader.py` 内的 `_Patcher`（`.to(device)` 代替 ModelPatcher）。网络结构、单步采样、
tile/颜色对齐逻辑与上游逐行一致；许可证与出处见 `vendor/vosr2/LICENSE`、`vendor/vosr2/NOTICE`。

SeedVR2 的四个阶段完全沿用上游 `inference_cli._process_frames_core` 的调用序列
（encode → upscale → decode → postprocess），参数默认值也一致；只把上游 `force=True`
的阶段日志静音，避免服务端控制台被刷屏。

### 7.2 接口

`GET /api/image/upscale/models`：目录、候选 DiT/VAE、就绪状态、默认引擎、已加载状态。

```jsonc
{
  "engines": {
    "seedvr2": {"dir": "...", "ready": true, "dit": "seedvr2_ema_7b_fp8_e4m3fn.safetensors",
                "vae": "ema_vae_fp16.safetensors", "dits": [...], "vaes": [...], "missing": []},
    "flashvsr": {"dir": "...", "ready": true, "files": [...], "missing": []},
    "vosr2": {"dir": "...", "ready": true, "model_bundle": "VOSR2", "bundles": ["VOSR2"],
              "missing": []}
  },
  "default_engine": "vosr2",
  "defaults": {"scale": 2, "seed": 42},
  "ready": true,
  "status": {"loaded": {"vosr2": true}}
}
```

`POST /api/image/upscale`：提交后台任务，返回 `job_id`；进度与取消复用 `/api/jobs/{id}`
和 `/api/jobs/{id}/cancel`。

```jsonc
{
  "image": "data:image/png;base64,...",  // 或 "images": [...]，最多 8 张
  "engine": "seedvr2|flashvsr|vosr2",
  "scale": 2,                            // 2 / 4
  "seed": 42,
  "target_short_edge": 1024,             // 可选：直接指定短边（覆盖 scale）
  "vae_tiled": true,                     // SeedVR2：4K 输出建议开
  "dit": "seedvr2_ema_7b-Q8_0.gguf",     // 可选：临时换权重
  "tile_size": 256, "tile_overlap": 24,  // FlashVSR 分块
  "topk_ratio": 2.0, "kv_ratio": 3.0, "local_range": 11,
  "color_fix": true
}
```

VOSR2 的其余参数（模型包、精度、颜色对齐、分块与 VAE 分块）都在设置页里配置，
请求只接受 `scale` / `seed`；`vosr2_runner.py` 负责 PIL ⇄ tensor 与进度的归一化，
取消由任务队列的 `should_cancel` 传入 vendor 的分块循环，命中后抛 `UpscaleCancelled`。

### 7.3 内存与耗时（本机 RTX 5090 / 32GB，实测）

| 任务 | 耗时 | 峰值显存 |
|---|---|---|
| SeedVR2 512→1024（2×） | 3.7s | — |
| FlashVSR 256→512（2×） | 15.8s | 5.38GB |
| FlashVSR 256→512 冷启动（含加载权重） | 16.2s | — |
| VOSR2 96×64→192×128（2×，wavelet） | 16.4s（含首次加载 7s） | 3.5GB |

- 同一时刻只保留一个放大引擎的权重；切换引擎会先卸载旧的（`server/upscalers/manager.py`）。
- 放大前会检查可用显存（SeedVR2 ≈12GB / FlashVSR ≈7GB / VOSR2 ≈8GB），不够时先卸载生成引擎。
- 空闲 `upscale.idle_unload_minutes`（默认 10 分钟）后自动卸载；`POST /api/engine/free`
  也会一并释放放大模型。
- SeedVR2 单帧按 t2i 处理（`batch_size=1`），保留 RGBA（alpha 走同一管线）。

### 7.4 设置

设置页「图像放大」分区可改：三个模型目录、DiT/VAE 选择、VAE 分块、FlashVSR 精度、
VOSR2 的模型包 / 精度 / 颜色对齐 / 分块尺寸 / 分块重叠 / VAE 分块、
默认引擎、默认倍率、空闲卸载分钟。保存后立即生效（会卸载已加载的放大模型），
点「重新扫描」刷新候选文件。

「模型目录」分区的扫描结果同时汇总三个放大引擎（目录、就绪状态、缺失文件；
VOSR2 额外显示选中的模型包与已扫描到的包），首次打开设置时随 `GET /api/settings`
自动扫描，`POST /api/models/scan` 会一并刷新。

### 7.5 测试

```powershell
& "<python>" -m pytest tests/test_upscalers.py tests/test_vosr2.py -q   # 10 项，纯 CPU，0.2s
```

覆盖：目录推断与显式覆盖、SeedVR2 就绪/缺失判定、FlashVSR 五个权重齐全判定、
VOSR2 三件套模型包完整性判定与引擎构造、非法倍率拒绝、
默认引擎回退到可用引擎、管理器空状态与默认配置。

## 8. 水印（`server/mediaops.py`）

### 8.1 接口

| 接口 | 说明 |
|---|---|
| `GET /api/image/watermark/fonts` | 本机可用字体白名单 `{id,label,family,path}` |
| `POST /api/image/watermark/preview` | 服务端精确预览，返回 `{data_url,width,height}`（最长边 960） |
| `POST /api/image/watermark` | 批量加水印（最多 20 张），结果落 `storage/outputs` |

请求体（归一化坐标，避免分辨率耦合）：

```jsonc
{
  "image": "data:image/png;base64,...",   // 或 "images": [...] 批量
  "text": "© 2026 Studio",
  "font": "msyh",
  "color": "#ffffff",
  "opacity": 0.55,                        // 0~1
  "scale": 0.06,                          // 字号相对短边 1%~20%
  "rotation": -12,
  "position": "bottom-right",             // 九宫格或 custom
  "x": 0.5, "y": 0.5,                     // position=custom 时的归一化中心
  "margin": 0.03,                         // 相对短边 0~20%
  "stroke": {"width": 0.004, "color": "#000000"},
  "shadow": {"blur": 0.008, "dx": 0.004, "dy": 0.004, "color": "#00000088"},
  "tile": {"enabled": false, "gap_x": 0.20, "gap_y": 0.12, "angle": -24},
  "image_mark": {"url": "/files/materials/xxx.png", "scale": 0.18, "opacity": 0.8},
  "format": "png|jpeg|webp", "quality": 92
}
```

要点：

- 文字与图片二选一：有 `text` 就画文字，否则用 `image_mark`；都没有返回 400；
- 九宫格位置按边距贴边；`position=custom` 用 `x/y` 归一化中心定位；
- `tile.enabled` 时忽略单点位置，按 `gap_x/gap_y`（相对短边）平铺，`angle` 为平铺角度；
- 字体优先用白名单 id（`msyh/simhei/arial/...`），也可直接传字体文件绝对路径；
- 批量结果结构与其他结果一致（`url/thumb_url/width/height/bytes`），可直接进胶片条。

### 8.2 前端面板（`imageTools.js` + `tools.css`）

- 左侧工具轨新增 `水印` 分组；文字/图片两种水印用 chip 切换，字段随类型显隐；
- 字体下拉来自 `/api/image/watermark/fonts`，默认选第一个可用字体；
- 不透明度/大小/边距/描边/平铺间距用 range，旁边实时显示数值；
- 位置下拉除九宫格外新增「自定义（画布拖动）」：切到水印分组后画布显示可拖动手柄，
  拖动写入归一化 `x/y` 并吸附中线/三分线（8px 容差）；方向键微调 1px，Shift 10px；
- 「平铺防盗」勾选后出现横向/纵向间距与平铺角度；
- 「服务端预览」把当前参数 + 已暂存 `ops` 发给 `/preview`，在面板内显示返回图；
- 「应用水印」走批量接口，结果进入右侧结果列表（kind=`watermark`）；
- 结果弹窗新增「收藏素材」「加入 GIF」「送入图像编辑」，其中「加入 GIF」会把结果拉成 data URL 并切到动图分组。

## 8.5 尺寸/导出前端

- 缩放分组新增「缩放模式」下拉：精确宽高 / 百分比 / 长边 / 短边 / 百万像素；
  非精确模式只显示一个目标值输入，并带滤镜、对齐倍数、缩放后锐化；
- 导出格式新增 WebP：勾选「无损」时隐藏质量滑杆；JPEG 显示透明区铺底色；
- 「目标体积 KB」留空按质量导出，填写后由服务端二分搜索质量，结果里返回实际质量与 `target_met`。

## 9. 动图（GIF）

### 9.1 接口

| 接口 | 说明 |
|---|---|
| `POST /api/media/upload` | multipart 上传视频（mp4/mov/webm/mkv/avi，≤512MB），返回 `relpath/url/info` |
| `POST /api/media/video/probe` | `{path}` → 时长/分辨率/fps/码率（ffprobe，缺失时回退 OpenCV） |
| `POST /api/media/gif` | 提交 GIF 任务，返回 `job_id`（进度/取消走 `/api/jobs/{id}`） |
| `POST /api/media/gif/split` | GIF 拆帧为 PNG 结果（最多 60 帧），每帧带 `duration` |

图片序列：

```jsonc
{
  "source": "images",
  "images": ["data:image/png;base64,...", "/files/outputs/xxx.png"],
  "duration": 100,                 // 每帧毫秒，默认 100（最小 20）
  "durations": [80, 120, 160],     // 可选：逐帧覆盖
  "width": 720,                    // 0 = 用首帧宽度；最长边会被压到 1600 以内
  "mode": "forward|reverse|boomerang",
  "loop": 0
}
```

视频：

```jsonc
{
  "source": "video",
  "path": "uploads/vid-xxx.mp4",
  "start": 1.2, "end": 6.4,        // 片段最长 60s；倒放/往返限 15s
  "fps": 12, "width": 720,
  "mode": "forward"
}
```

实现要点：

- 图片序列用 Pillow：所有帧缩略拼成接触表 → `quantize(MEDIANCUT)` 得**全局调色板** →
  逐帧 `quantize(palette=..., dither=FLOYDSTEINBERG)`，避免逐帧跳色；
- 视频用 ffmpeg **两遍调色板**（`palettegen=stats_mode=diff` + `paletteuse`），
  `-progress pipe:1` 的 `out_time_ms` 映射到 5%~95%；取消时终止进程并删除临时目录；
- 没有 ffmpeg 时自动回退 OpenCV 抽帧 + Pillow 序列编码（质量降级但不报错）；
- 结果 `.gif` 走 `storage.save_output`，缩略图取首帧；`meta.frames` 记录帧数；
- 输出超过 50MB 返回 `gif_too_large`，建议降宽度/帧率或减少帧数。

### 9.2 前端面板（`imageTools.js` + `tools.css`）

- 左侧工具轨 `动图` 分组；来源 chip 切换「图片序列 / 视频截取」；
- 图片序列：本地多选加帧、当前源图一键入帧、帧缩略图网格（可单帧移除，最多 300 帧）、
  每帧毫秒、输出宽度、播放方式；
- 视频：选择后自动上传并探测，回填时长/分辨率/fps，双输入截取起止、目标 fps 与宽度；
- 生成走任务队列：进度条 + 阶段文案 + 取消按钮，完成后结果进入右侧列表（kind=`gif`）；
- 「把当前 GIF 拆帧」把源图拆成最多 60 张 PNG 结果（kind=`gif-frame`），可直接继续编辑。

## 10. 导入菜单与结果联动

源图面板提供三个导入入口（本地文件仍是点击/拖拽投放区）：

| 入口 | 行为 |
|---|---|
| 素材仓库 | `GET /api/materials?limit=200` → 弹窗网格单选 → 「载入为源图」 |
| 最近结果 | 当前会话 `state.results` 前 24 条 → 同样弹窗选择 |
| 剪贴板 | 优先 `navigator.clipboard.read()`；不支持或未授权时提示用 `Ctrl+V` |

- 页面在 `document` 上监听 `paste`，仅当剪贴板含图片且焦点不在输入框/文本域时接管，
  统一走 `handleFiles` → `readFileAsDataURL` → `setSourceFromDataUrl`；
- 素材仓库返回的 `/files/...` URL 可直接作为 `src` 载入，避免 base64 膨胀；
- `destroy()` 会移除 `paste` 监听，避免离开页面后误导入。

结果弹窗动作：下载 / 收藏素材 / 加入 GIF / 继续编辑（设为源图）/ 送入图像编辑。

## 11. 工作台布局（Apple 三栏 + 底部胶片条）

页面结构由 `imageTools.js` 的 `host.innerHTML` 一次性渲染，`tools.css` 用 grid-areas 摆放：

```
┌──────┬──────────────────────────────┬─────────────┐
│ 工具 │  画布                         │ Inspector   │
│ 轨   ├──────────────────────────────┤ 源图 + 工具  │
│ 58px │  操作史                       │ 折叠面板     │
│      ├──────────────────────────────┤ 340px       │
│      │  结果胶片条（横向滚动）         │             │
└──────┴──────────────────────────────┴─────────────┘
```

- 左侧 `.tools-rail`：8 个按钮复用原来的 `[data-tool-group]`，`syncToolGroups()` 只切 `.active`
  与 `.tool-fold[data-group]` 的 `hidden`，交互逻辑未变；Inspector 的折叠面板按当前工具显隐；
- 中间 `.tools-main`：画布面板 + 操作史；画布下方新增 `.tools-filmstrip`（grid-area `film`）；
- 右侧 `.tools-inspector`：源图、工具折叠面板、处理提示；`position: sticky` + 内部滚动，
  长面板不会把整页撑高；
- ≤1180px 时退化为单列，工具轨变成横向可滚动条，Inspector 取消 sticky。

### 胶片条与批量操作

- `renderResults()` 改为横向 flex 胶片条（每张 132px，`scroll-snap`），结果卡支持选中态
  `.is-selected` + 左上角勾选标记；单击切换选中，双击或右上角 `⤢` 打开详情弹窗；
- 选中集合 `selectedResultIds` 保存在页面闭包内，`renderResults()` 会清理已不存在的结果 id；
- 批量动作：`全选` / `取消选择` / `收藏`（逐张 `createMaterial`，失败不打断）/ `送入编辑`
  （全部拉成 data URL 后一次 `setHandoff`）/ `导出`（错峰触发下载）/ `加入 GIF`（逐张入帧并切到动图分组）；
- 无选中时四个批量按钮自动禁用，标题旁显示「已选 N 张」；
- 结果卡仍是原有 `data-ref="results"` 容器，因此「最近结果」等既有逻辑无需改动。

> 注：`theme.css` 在 `tools.css` 之后加载，会给 `.tool-canvas` 铺不透明底色；
> 覆盖层 canvas 用 `.tool-canvas.tool-overlay { background: transparent }` 提升优先级，
> 否则会把画布图片整块盖住（本次已修复并实测）。

## 12. 图片反推（WD14 / Danbooru，`server/tagger.py`）

把一张图反推成 Danbooru 风格标签并拼成提示词，供文生图 / 图生图继续使用。
只依赖 `onnxruntime + numpy + Pillow`，不经过 ComfyUI 服务，也不依赖
`ComfyUI-WD14-Tagger` 节点（模型仓库与预处理逻辑与它保持一致）。

### 12.1 模型目录与下载

查找顺序（`tagger.search_dirs`）：

1. `config.tagger.dir`（设置里显式指定）；
2. `<model_root>/onnx`、`<model_root>/wd14_tagger`（复用 ComfyUI 的模型目录）；
3. `<storage>/models/wd14`（项目自带回退目录）。

目录下需要成对存在 `<name>.onnx` 与 `<name>.csv`（`selected_tags.csv` 重命名而来）。
首次反推时若模型缺失会自动从 HuggingFace 下载到 `tagger.dir`（未配置时落到
`<model_root>/onnx`，再回退到 storage）。下载目录没有网络时，可设置环境变量
`HF_ENDPOINT=https://hf-mirror.com` 走镜像后重启服务。

内置 11 个 SmilingWolf 模型（默认 `wd-v1-4-moat-tagger-v2`），未安装的项也会出现在
模型下拉框里并标注「需下载」。

### 12.2 接口

`GET /api/image/tagger/models`：模型清单。

```jsonc
{
  "default": "wd-v1-4-moat-tagger-v2",
  "dir": "D:/ComfyUI/models/onnx",          // 未安装时的下载目录
  "dirs": ["...", "..."],                    // 全部候选目录
  "models": [
    {"name": "wd-v1-4-moat-tagger-v2", "label": "WD v1.4 Moat v2（推荐）",
     "installed": true, "size_mb": 302.4, "dir": "...", "known": true}
  ]
}
```

`POST /api/image/tagger`：反推一张图。

```jsonc
{
  "image": "data:image/png;base64,...",     // 或 /files/ 路径
  "model": "wd-v1-4-moat-tagger-v2",
  "threshold": 0.35,                        // general 标签阈值
  "character_threshold": 0.85,              // character 标签阈值
  "exclude_tags": "watermark, text",        // 英文逗号分隔，忽略大小写
  "replace_underscore": false,              // long_hair → long hair
  "trailing_comma": false,                  // 提示词末尾追加逗号
  "download": true                          // 缺失时允许自动下载
}
```

返回：

```jsonc
{
  "model": "wd-v1-4-moat-tagger-v2",
  "prompt": "hatsune_miku, long_hair, ...",
  "count": 12,
  "tags": [{"tag": "hatsune_miku", "score": 0.98, "category": "character"}],
  "width": 1024, "height": 1024,
  "downloaded": false,
  "model_dir": "...",
  "elapsed_ms": 420
}
```

### 12.3 预处理与分类

- 输入尺寸取自 ONNX 首个输入：v2 为 `[1, H, W, 3]`（NHWC），v3 为 `[1, 3, H, W]`（NCHW）；
- 等比缩放后**白底 letterbox** 到正方形；
- 颜色保持 **BGR、0~255、不除以 255**（与 WD14 原生节点一致）；
- `selected_tags.csv` 第 3 列分类：`0` general、`4` character、`9` rating；
  rating 不输出，character 排在 general 前，各自按分数降序；
- 输出时把括号转义为 `\(` `\)`，再用 `", "` 拼接。

### 12.4 前端面板

「图像处理 → 工具轨 → 反推」：

- 模型下拉框显示安装状态与体积；切换未安装模型会提示下载目录；
- 通用阈值 / 角色阈值滑杆、排除标签、下划线转空格、末尾逗号；
- 「反推标签」调用接口（首次下载给 10 分钟超时），结果显示在只读文本框；
- 「复制」写入剪贴板；`→ 文生图` 用 `setT2IHandoff` 只把提示词带到工作台，
  `→ 图生图` 用 `setHandoff` 同时带图与提示词；
- 反推分组下不绘制裁剪框，避免遮住画面。

### 12.5 测试

```powershell
& "<python>" -m pytest tests/test_tagger.py -q
```

覆盖：CSV 三类标签切分、无 character 段回退、模型目录扫描（缺 csv 不算已安装）、
缺失模型拒绝自动下载时的错误码、NHWC/NCHW 预处理与 BGR 通道、阈值过滤、
character 优先排序、排除标签与末尾逗号。测试使用伪造 session，不加载真实 ONNX。
