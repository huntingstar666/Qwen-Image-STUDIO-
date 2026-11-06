# 架构说明

## 1. 目标与约束

| 约束 | 后果 |
|---|---|
| 本机**没有 npm / PyPI 网络**（registry 超时） | 前端不能有构建步骤；后端只能用已装好的库 |
| 只有 Comfy-Org 的**单文件 safetensors 权重** | 不能走 diffusers（还要求 transformers≥5.17，本机 4.57.6） |
| RTX 5090 / 32GB，int8 权重组合约 16GB | 任务必须串行，同一时刻只跑一个采样 |
| 用户希望**不影响原有 ComfyUI** | 不能往 ComfyUI 里装节点、不能改它的文件 |

结论：**做一个独立服务，把 ComfyUI 的模型实现代码移植（vendor）进项目，只复用它的权重文件。**

## 2. 依赖是怎么抽离的

ComfyUI 的仓库其实分两层，边界很干净：

```
ComfyUI/
├─ comfy/                      ← 模型库（纯 Python，328 文件 / 5.4MB）
│   ├─ ldm/qwen_image21/        DiT 实现
│   ├─ text_encoders/qwen_image21.py, qwen3vl.py   文本编码器
│   ├─ sd.py                   load_diffusion_model / load_clip / VAE / LoRA
│   ├─ samplers.py, sample.py  采样器与采样流程
│   └─ model_management.py     显存调度
└─ main.py / nodes.py / server.py / folder_paths.py / custom_nodes/ / web/
                               ← 服务层（HTTP、节点图、队列、前端）
```

`comfy/` 里对 `folder_paths` / `nodes` / `server` 的引用是 **0 条**（已 grep 验证），且它是
没有 `__init__.py` 的命名空间包——把它复制进项目、加进 `sys.path` 就能独立工作。

唯一一处跨包引用是 `comfy/ldm/sam3d_body/model/model.py` 引用 `comfy_extras.mediapipe`，
该模块不在 Qwen 导入链上，运行期不会被加载。

所以：

```powershell
scripts\port_engine.ps1      # 把 comfy/ + node_helpers.py 复制到 engine/
```

之后运行期只需要 `engine/` + 权重文件，**不再读取 ComfyUI 源码目录**。
`engine/SOURCE.json` 记录来源版本/commit，`scripts/port_engine.ps1 -Check` 校验副本可独立 import。

> `engine/` 是 ComfyUI 的衍生副本，受 GPL-3.0 约束（详见 `engine/NOTICE.md`）。本地自用无碍。

## 3. 组件与依赖方向

```
                 ┌──────────────────────┐
  浏览器 ───────► │  web/ (原生 ES module) │
                 └──────────┬───────────┘
                            │ HTTP /api/*
                 ┌──────────▼───────────┐
                 │      server/main.py   │  FastAPI：路由 + 静态托管
                 └──┬────────┬─────┬────┘
                    │        │     │
        ┌───────────▼──┐ ┌───▼───┐ └────────────┐
        │   jobs.py    │ │storage│              │
        │ 单 worker 队列│ │ .py   │              │
        └───────┬──────┘ └───────┘              │
                │                              │
        ┌───────▼──────────────────────────────▼───────┐
        │              pipeline.py                     │
        │  解码 → 画布规划(32 对齐) → 引擎 → 裁回 → 合成 │
        └───┬─────────────┬──────────────┬─────────────┘
            │             │              │
   ┌────────▼──────┐ ┌────▼─────┐ ┌──────▼─────────┐
   │ imaging.py    │ │backends/ │ │prompt_polish.py│
   │ align.py      │ │native.py │ │styles.py       │
   │ (numpy 算法)   │ │(引擎)    │ │ollama.py       │
   └───────────────┘ └────┬─────┘ └────────────────┘
                          │ import
                    ┌─────▼──────┐        ┌──────────────┐
                    │ engine/    │        │ 权重 safetensors │
                    │ comfy/*    │        │ (model_root,只读) │
                    └────────────┘        └──────────────┘
```

依赖方向严格单向：`main → pipeline → (imaging/align, backends.native, prompt_polish/styles) → engine`。
`align.py` / `imaging.py` 不 import torch；`engine/` 不知道上层存在。

## 4. 请求生命周期

### 文生图

```
POST /api/generate
  → jobs.submit()                        立即返回 job_id
  → worker 线程：pipeline.generate_t2i(job)
      1. 尺寸对齐 32；解析采样计划（Turbo 则注入官方 sigma）
      2. engine.ensure_loaded(unet, clip, vae) + apply_loras()
      3. engine.encode_text(prompt, negative)            文本编码
      4. engine.sample(latent=None, width, height, batch) 逐步回调 → job.progress
      5. engine.decode() → PNG → storage.save_output()
  → 前端轮询 GET /api/jobs/{id}
```

### 图像编辑（局部编辑）

```
POST /api/edit  {images[1..10], mask?, local{enabled,scheme,...}, size_mode}
  → pipeline.generate_edit()
      1. 解码输入（exif 纠正 → ICC→sRGB → RGBA）
      2. plan_canvas(mode=follow/custom/ratio/fixed_point)  画布向上对齐 32
      3. compose_canvas(src, plan)                          补边/裁切到画布
      4. mask → map_mask_to_canvas()                        遮罩同坐标变换
      5. engine.encode_text(images=[canvas, ...refs], resolution=0)
         └─ 零偏移守卫：cond.canvas 必须 == canvas.size，否则报错
      6. engine.encode_latent(canvas)                       VAE 编码（与画布同尺寸）
      7. engine.sample(..., noise_mask=mask_canvas)          方案 A：只在框内降噪
         或 crop_region → 只采样局部 → stitch_region          方案 B：省显存
      8. composite(canvas, edited, mask)                     遮罩外保留原图像素
         └─ outside_max_abs 计算并写入 job.quality
      9. crop_back_plan(composed, plan)                      纯几何裁回源尺寸
     10. 保存 PNG
```

## 5. 显存策略

| 阶段 | 显存占用 | 策略 |
|---|---|---|
| 权重常驻 | unet 6.7G + clip 8.7G + vae 0.6G ≈ 16G | 一次加载、多次复用；换模型才卸载 |
| 文本编码 | + 激活 | 完成后可把 CLIP 权重挪走，给采样/解码腾地方 |
| 采样 | + latent/激活 | 串行，队列只有 1 个 worker |
| VAE 解码 | + 数 GB | 不够时 ComfyUI 会自动回退 tiled 解码（有日志，属正常） |

对外提供 `/api/engine/free`（`unload=false` 只清缓存，`true` 卸载模型）与
`/api/engine/warmup`（预加载，避免首个请求等 20~60 秒）。

## 6. 与 ComfyUI 的边界

| 项 | 本项目 |
|---|---|
| 权重文件 | **复用** ComfyUI `models/`（只读，路径可配） |
| 模型实现代码 | **移植**进 `engine/`（不修改，GPL-3.0） |
| ComfyUI 服务进程 | **不需要** |
| ComfyUI 自定义节点 | **不需要**（Precise-Align / BlueBox 算法已重写进 `server/`） |
| ComfyUI 前端 / 工作流 | 不使用（本项目有自己的网页工作台） |

用户如果想继续在 ComfyUI 里用，也另附了原生工作流模板（见 `docs/COMFY_TEMPLATES.md`，可选）。

## 7. 为什么前端没有构建步骤

本机 npm registry 不可达，`vite`/`react` 都装不上。所以前端用**浏览器原生 ES module**：

```html
<script type="module" src="/src/main.js"></script>
```

组件、状态、遮罩编辑器（Canvas 2D）全部手写，`web/vendor/image-style-kit/src/*.js` 是纯逻辑
ES module，可直接被浏览器 import。代价是没有 JSX 的类型检查与热更新，收益是**零安装、零构建、
改完刷新即生效**。
