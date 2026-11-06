# 推理引擎 `server/backends/native.py`

> 目标：**不启动 ComfyUI 服务**，把 Qwen-Image 2.1 的推理做成独立服务自持。
> 代码用项目内 vendored 的 ComfyUI 模型库（`engine/`），权重按绝对路径只读复用。
> 本文记录接口、实现要点、显存策略、实测数据与已知坑。

| 项 | 值 |
|---|---|
| 引擎文件 | `server/backends/native.py`、`server/backends/__init__.py` |
| 引擎代码 | `engine/`（ComfyUI **0.43.0 / commit ab08f7b2**，329 个文件 5.41MB，见 `engine/SOURCE.json`、`engine/NOTICE.md`） |
| 权重 | `<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\models\`（**只读**，不复制、不修改） |
| 依赖 | `torch 2.11.0+cu128`、`PIL 11.3.0`、`numpy 2.3.5`（`<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe` 自带，零安装） |
| 硬件 | RTX 5090 31.82GB（实测机） |
| 单测 | `tests/test_native_backend.py`（40 项）、`tests/test_moss_profile.py`（15 项），纯逻辑，不加载模型 |
| 验收脚本 | `scripts/verify_native_engine.py`、`scripts/bench_native_engine.py` |

**状态**：Qwen-Image 2.1 的 t2i 1024 turbo 8 步 / t2i 2048 默认 25 步 / 单图编辑 `resolution=0` 三组已真实出图并人眼确认（见第 6 节）；LoRA 通路已用 320MB LoRA 验证；**官方 18.22GB turbo LoRA 在本机无法加载**（见第 7.1 节，这是环境问题，影响 pipeline 默认 turbo 档位，必须改配置）。

**MOSS-Image 已接入同一个引擎**（2026-11-06）：模型差异集中在 `server/models.py` 的档案里，引擎通过
`EngineConfig` 的 4 个新字段区分（`clip_type` / `text_backend` / `latent_channels` / `latent_downscale`）。
边界框布局（`server/moss.py`，逐行移植 ComfyUI 三个节点）与 SLG（`sample(slg=...)`）是可选能力。
实测见 6.5，差异清单见 4.5。

---

## 1. 架构：代码与权重分离

```
<PROJECT_ROOT>\
├─ engine\                      ← vendored 引擎代码（只 import，不改）
│  ├─ comfy\                    ← 328 个 .py，命名空间包（无 __init__.py）
│  ├─ node_helpers.py           ← conditioning_set_values 等（TextEncodeQwenImage21 要用）
│  ├─ SOURCE.json               ← 来源版本/commit/文件数
│  └─ NOTICE.md                 ← GPL-3.0 说明
└─ server\backends\native.py    ← 本引擎：模型生命周期 / 编码 / 采样 / 解码 / LoRA
```

运行期只把 **`engine_dir`（默认 `<PROJECT_ROOT>\engine`）** 加进 `sys.path`。
`import comfy.sd` 之后引擎会做一次硬自检：

```python
sd_file = os.path.abspath(comfy.sd.__file__)
if not sd_file.startswith(engine_dir + os.sep):
    raise EngineError("comfy.sd 解析到了 engine_dir 之外：说明 sys.path 混入了外部 ComfyUI 源码目录")
```

`node_helpers` 同样校验。这样**杜绝了「悄悄又依赖 D 盘 ComfyUI 源码」**——ComfyUI 服务被关掉、甚至 D 盘源码被移走，引擎照样跑（权重目录仍在即可）。

**导入开销**（实测，`native.py` 全部延迟导入）：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `import server.backends.native` | **0.021s** | 不 import torch，`server.main` 启动无感 |
| `import torch` | ~1.6s | 第一次 `ensure_loaded()`/`status()` 才发生 |
| `import comfy.*` | ~4.0s | 同上，之后进程内缓存 |
| 单测 40 项 | **0.03s** | 全部走假 `engine_dir`，不 import torch/comfy |

---

## 2. 快速开始

```python
from server.backends import EngineConfig, NativeEngine, TURBO_SIGMAS

engine = NativeEngine(EngineConfig(
    engine_dir=r"<PROJECT_ROOT>\engine",
    unet=r"D:\...\models\diffusion_models\QwenImage2.1\qwen_image_2.1_int8_convrot.safetensors",
    clip=r"D:\...\models\text_encoders\Qweniamge2.1\qwen3vl_8b_int8_convrot.safetensors",
    vae=r"D:\...\models\vae\Qweniamge2.1\qwen_image_2.1_vae_bf16.safetensors",
))
engine.ensure_loaded()                       # 装载三个模型（mmap，5~11s）
cond = engine.encode_text("一只陶土茶壶放在原木桌上，柔和窗光", resolution=0)
samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                        latent=None, width=1024, height=1024,
                        sigmas=list(TURBO_SIGMAS), steps=8, cfg=1.0,
                        sampler="euler", scheduler="simple", seed=42)
images = engine.decode(samples)              # list[PIL.Image]，RGBA
images[0].save("out.png")
engine.free(unload=False)                    # 模型留在显存给下一单用
```

---

## 3. 接口

### 3.1 `EngineConfig`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `engine_dir` | str | `""` | **项目内 vendored 引擎目录**（含 `comfy/`）。给工作区根目录也能自动找到 `engine/` |
| `unet` / `clip` / `vae` | str \| None | None | 默认模型**绝对路径**；`ensure_loaded()` 可逐个覆盖 |
| `vram_reserve` | float | 0.15 | 显存安全余量（占总显存比例），供上层策略参考 |
| `dtype` | str | `"default"` | 与 ComfyUI `UNETLoader.weight_dtype` 同义，映射见下 |
| `clip_type` | str | `"qwen_image"` | CLIPType 名（大小写不敏感）。MOSS 用 `"moss_image"`；未知值在 `ensure_loaded()` 时抛 `EngineError` |
| `text_backend` | str | `"qwen"` | `"qwen"` 走 `TextEncodeQwenImage21`（vision + VAE 参考图）；`"moss"` 走纯 `clip.tokenize` + `encode_from_tokens_scheduled`（不读图） |
| `latent_channels` | int | `64` | 空 latent 通道数。Qwen 64 / MOSS 128 |
| `latent_downscale` | int | `16` | latent ↔ 像素下采样倍数。Qwen 16 / MOSS 16（但像素只需 16 对齐，不是 32） |
| `comfy_root` | str \| None | None | **旧字段名兼容别名**，等价 `engine_dir`；两者都给时 **`engine_dir` 优先** |

`dtype` → `model_options` 映射（与 `nodes.py::UNETLoader` 完全一致）：

| dtype | model_options |
|---|---|
| `default` | `{}` |
| `fp8_e4m3fn` | `{"dtype": torch.float8_e4m3fn}` |
| `fp8_e4m3fn_fast` | `{"dtype": torch.float8_e4m3fn, "fp8_optimizations": True}` |
| `fp8_e5m2` | `{"dtype": torch.float8_e5m2}` |

非法 `dtype` / `vram_reserve` 在**构造时**抛 `EngineError`。

### 3.2 `status() -> dict`

```python
{
  "available": bool,          # 引擎代码可 import + CUDA 可用（不代表模型已装载）
  "reason": str | None,       # 不可用原因（中文）
  "engine_dir": str,
  "comfy_root": str,          # 旧字段名别名，与 engine_dir 同值
  "device": "cuda:0" | None,
  "vram_total_mb": int, "vram_free_mb": int,
  "loaded": {"unet": path|None, "clip": path|None, "vae": path|None,
             "loras": [{"name": str, "strength": float}]},
  "text_encoder_offloaded": bool,
  "timings": {"load_s": float|None, "clip_reload_s": float|None,
              "sample_s": float|None, "decode_s": float|None},
}
```

`status()` **不加锁**，采样进行中也能立刻返回（供 `/api/health` 轮询）；失败只填 `available=False` + `reason`，不抛异常。

### 3.3 `ensure_loaded(*, unet=None, clip=None, vae=None)`

- 三个路径与当前装载**完全一致 → 立刻返回**（实测重复调用 **0.09ms**）。
- 任一不同 → 全部卸载重载（不做增量换模型）；之前挂过的 LoRA 会自动重新挂上。
- 路径校验发生在 `import torch` **之前**，所以「没配置模型」这类错误又快又准（`缺少模型路径: unet, clip, vae` / `模型文件不存在: <path>`）。
- 每次调用都把文本编码器装回显存（若上次被 `sample()` 挪走）。

### 3.4 `apply_loras(loras)`

```python
engine.apply_loras([{"name": r"D:\...\x.safetensors", "strength": 1.0}])
engine.apply_loras([])          # 还原基座模型
```

- 实现：`comfy.sd.load_lora_for_models` 链式克隆，**每次都从未挂 LoRA 的基座重新叠加**，所以重复调用幂等、天然「先清空上一批」。
- 支持 `strength`（模型）与可选 `strength_clip`（文本编码器，缺省同 `strength`）。
- 文件不存在 / 不是数字 / 缺 `name` → `EngineError`；底层加载失败也包成 `EngineError("LoRA 装载失败: ...")`，不会崩进程。

### 3.5 `encode_text(prompt, negative_prompt="", images=None, resolution=0) -> dict`

```python
{"positive": COND, "negative": COND, "canvas": (w, h)}
```

**逐行复刻** `comfy_extras/nodes_qwen.py::TextEncodeQwenImage21.execute`（对照见第 4.1 节）：

- 有参考图：`canvas` = 第一张参考图缩放后的 `(w, h)`；`resolution=0` 时只 32 对齐不缩放，`resolution>0` 时按面积 `resolution²` 等比缩放再 32 对齐。
- 无参考图：`canvas = (resolution or 1024)²`。
- 同一张缩放后的图**同时喂 VLM 和 VAE**；有 alpha 时 VLM 看白底合成（`rgb*alpha + (1-alpha)`），VAE 保留 4 通道。
- `keep_vision = (len(ref_latents) == 0)`；有参考图时用 `node_helpers.conditioning_set_values(..., append=True)` 追加 `reference_latents` 到正负条件。
- 输入 PIL 一律按 **RGBA** 处理（无 alpha 视为全不透明），保证可复现。
- **结果带 LRU 缓存**（`encode_cache_size`，默认 8 条）：键 = 权重代号 + 提示词 + 负向 + `resolution`
  + 参考图像素摘要。同提示词连抽多张直接复用，换模型/LoRA 自动失效。返回的是浅拷贝，
  可以放心交给 `sample()`。见 4.0 ⑤。

`text_backend="moss"` 时（MOSS-Image）：

- 走 `clip.tokenize(text)` + `encode_from_tokens_scheduled()`，**完全不读参考图**；
  传了 `images` 会直接抛 `EngineError("MOSS 参考图编辑尚未接入")`，不会静默忽略。
- `canvas` 仍返回 `(resolution or 1024)²`，纯为接口一致性；MOSS 的 t2i 不消费它。
- LRU 缓存键同样是「权重 + 提示词 + 负向 + resolution」。

### 3.6 `encode_latent(image) -> torch.Tensor`

VAE 编码画布 → `[1, 64, H/16, W/16]`（局部编辑方案 A 用）。

### 3.7 `sample(*, positive, negative, latent=None, sigmas=None, steps, cfg, sampler="euler", scheduler="simple", seed=0, denoise=1.0, width=None, height=None, batch=1, noise_mask=None, slg=None, callback=None)`

- `latent=None` + `width/height/batch` → 引擎内部造 `torch.zeros([batch, latent_channels, h//16, w//16])`（t2i 用，pipeline 不必 import torch）。
- `sigmas` 给定 → 显式 sigma 路径（Qwen Turbo），**忽略 `steps`/`scheduler`**（`steps` 仍用于进度总数）。
- `sigmas=None` → `comfy.samplers.calculate_sigmas(model_sampling, scheduler, steps)` 默认路径（MOSS 50 步与 8 步都走这条）。
- `denoise<1` → 两条路径都按 `KSampler.set_steps` 的规则截尾（见 4.2）。
- `noise_mask` → 等价 `SetLatentNoiseMask`；接受 **numpy `(H,W) float32` 像素尺寸 0..1**（1=重绘）、PIL `L` 图、或 tensor，引擎内部按 latent 形状插值。
- `slg` → 可选 `SkipLayerGuidanceDiTSimple`（仅 MOSS 用，默认 `None` 即关闭）。
  字段 `{single_layers:"22", double_layers:"", start_percent:0.0, end_percent:0.5}`，
  层号字符串用 `\d+` 解析；只对**本次采样**生效（`model.clone()`，不改基座）。
- `callback(step, total_steps, current_latent)` 用于进度（`total_steps = len(sigmas)-1`）；**在回调里抛异常即取消**，该异常原样抛给上层，不会被包成 `EngineError`。
- 每次采样前自动把文本编码器挪出显存（第 5.2 节）。

### 3.8 `decode(samples) -> list[PIL.Image]`

统一返回 **list**（batch>1 逐个元素），每张 RGBA，alpha 保留。VAE 显存不够时 ComfyUI 内部会自动回退 tiled 解码（日志 `Ran out of memory when regular VAE decoding, retrying with tiled VAE decoding`，属正常）；**tiled 也失败才抛异常**。

### 3.9 `free(*, unload=False)`

- `unload=False`：只 `torch.cuda.empty_cache()`，模型留在显存给下一单（pipeline 每单结束调它）。
  实测不需要 `soft_empty_cache` / `gc.collect`（每单多花 0.2s、对下一单零收益），见 6.4。
- `unload=True`：卸载全部模型 + `model_management.unload_all_models()` 归还显存。

---

## 4. 关键实现细节

### 4.0 性能：三个必须知道的结论（实测，别再踩）

**① torch 的 CUDA 版本决定 3 倍差距。** int8 权重的 GEMM 走 `comfy_kitchen` 的原生算子，
而这些算子要求 torch 自带 CUDA ≥ 13。cu128 时算子被禁用、退回 eager，profiler 里能看到
`cutlass_80_wmma_tensorop_i161616gemm_s8_...` 占掉一半时间（2.1s/4.8s），采样 12.4s；
换成 cu130 后同一个 8 步采样只要 4.3s。
坑点：机器上常有两份 torch（ComfyUI 自带 cu130 + user site-packages 里的 cu128），
普通启动会用到后者。**必须 `python -s` 启动**（启动器已内置，并在启动时打印 `[env] torch ...`）。

**② 解码要「直接分块」，而且阈值必须压到 0.6MP。** 2016×1152（latent 126×72 = 9072 token）全量解码
既 OOM（分配器报 `free: 0`）又慢：全量 5.6s、默认 tile=512 是 2.99s、**tile=1024 只要 1.29s**。
所以 `decode()` 在输出像素 ≥ `tiled_decode_threshold` 时**直接**走
`decode_tiled(tile_x=1024, tile_y=1024, overlap=64)`，失败再逐级减半重试。
先试全量再回退是错的——失败那一次本身就浪费 3~5 秒。

阈值原本是 1.5MP，但那是按「CLIP 已让位」估的。**CLIP 常驻 + 18GB LoRA 时，896²（0.8MP）
全量解码就 OOM**：一次失败会让解码从 0.38s 变 0.74s，并且连带把紧接着的采样从 0.9s 顶到 3.5s
（comfy 会重新搬运权重）。实测边界（2026-11-06，CLIP 常驻 + 18GB LoRA）：

| 输出像素 | 全量解码 | 分块（tile=1024） |
|---|---|---|
| 512² = 0.26MP | **0.07s** | 0.17s |
| 768² = 0.59MP | **0.15s** | ≈0.25s |
| 896² = 0.80MP | OOM → 0.74s（且污染后续采样） | **0.38s** |
| 1024² = 1.05MP | OOM → 3.4s | **0.52s** |
| 2016×1152 = 2.32MP | OOM | **1.16s** |

所以默认 `tiled_decode_threshold = 600000`（768² 全量、再大直接分块）。

**③ CLIP 常驻比「用完挪走」更快（推翻旧结论）。** 见 5.2，这里只放结论：
CLIP 留在显存后 1024² 引擎层 **2.3s**、2016×1152 **5.3s**；让位方案分别是 4.2s / 8.1s。

**④ LoRA 要按签名缓存。** `apply_loras` 每次会从基座模型重新 patch 所有层，
18GB 的 HiFi 适配器每张图重来一次是灾难。现在同一组 `(路径, 强度)` 直接秒返回。

**⑤ 文本编码结果要缓存（同提示词晒图）。** 用户「多抽几张」时提示词、负向、参考图都不变，
`encode_text` 是纯函数，可以整段复用。缓存键 = 权重代号 + 提示词 + 负向 + resolution
+ 每张参考图的**像素内容摘要**（blake2b），所以同图重新上传也能命中；换模型 / 换 LoRA
时代号自增并清空，不会串味。条数由 `encode_cache_size` 控制（默认 8，0 = 关）。

| 场景 | 未命中 | 命中 |
|---|---|---|
| 文生图（纯文本） | 145ms | **<1ms** |
| 编辑 + 1 张 1024² 参考图 | 1446ms | **4ms** |

编辑链路收益大得多，因为未命中那次要额外做**参考图 VAE 编码**（占了 1.3s）。
命中时连「把文本编码器装回显存」都跳过了。

热态实测（RTX 5090 32GB，cu130，Turbo 8 步 + HiFi 18GB LoRA，CLIP 常驻 + 阈值 0.6MP）：

| 尺寸 | 引擎层合计 | 端到端 | 拆解（编码 / 采样 / 解码 / PNG / free） |
|---|---|---|---|
| 512² | **0.9s** | — | 0.16 / 0.38 / 0.07 / 0.03 / 0.20 |
| 768² | **1.3s** | — | 0.18 / 0.66 / 0.15 / 0.06 / 0.21 |
| 1024² | **2.3s** | **2.7s** | 0.16 / 1.28 / 0.52 / 0.12 / 0.24 |
| 2016×1152 | **5.3s** | **5.7s** | 0.18 / 3.73 / 1.16 / 0.27 / 0.22 |
| 2752×1536 | **12.9s** | — | 0.23 / 9.7 / 2.48 / 0.48 / 0.25 |

对照 ComfyUI（同权重同 LoRA）：`Prompt executed in 4.95 seconds`（2016×1152），本项目 5.7s 端到端，
其中 0.4s 是队列/落盘等固定开销。

**注意力后端不用折腾**（2026-11-06 实测，2016×1152，8 步）：
SDPA 3.73s、comfy-kitchen int8 attention 3.66s、`--fast fp16_accumulation` 3.84s、sageattention 3.96s。
差异都在噪声内——瓶颈在 int8 GEMM 与 LoRA 通路，不在 attention。

### 4.1 `TextEncodeQwenImage21` 复刻对照

| 节点源码（`comfy_extras/nodes_qwen.py`） | 引擎（`native.py::encode_text`） |
|---|---|
| `samples = image[:1].movedim(-1, 1)` | `tensor = image_to_tensor(im)`（→`[1,H,W,4]`）；`samples = tensor[:1].movedim(-1,1)` |
| `resolution>0`: `w = round(sqrt(res²*ratio)/32)*32`, `h = round(sqrt(res²/ratio)/32)*32` | `reference_size(w,h,resolution)`，同样用**内置 `round`（银行家舍入）** |
| `resolution==0`: `w,h = round(src_w/32)*32, round(src_h/32)*32` | 同上 |
| `width,height = max(32,w), max(32,h)` | 同上 |
| 尺寸相同则不重采样，否则 `common_upscale(..., "lanczos", "disabled")` | 完全一致 |
| `if not images_vl: latent_w, latent_h = width, height` | `if idx == 0: canvas = (w, h)` |
| `rgb = s[...,:3]; if s.shape[-1] > 3: rgb = rgb*a + (1-a)` | 完全一致（VLM 看白底合成） |
| `ref_latents.append(vae.encode(s))`（原图 4 通道） | `self._vae.encode(scaled)` |
| `keep_vision = len(ref_latents) == 0` | 完全一致 |
| `clip.tokenize(text, images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)` | 完全一致（正负两次编码共用同一 `images_vl`） |
| `conditioning_set_values(..., {"reference_latents": ref_latents}, append=True)` | 优先用 `node_helpers`，缺失时用等价的本地实现兜底 |
| `latent = zeros([1,64,latent_h//16,latent_w//16])` | `empty_latent()` / `sample(latent=None,...)` |

纯逻辑部分有 40 项单测（`tests/test_native_backend.py`），包含**银行家舍入**（`80/32=2.5 → 64`、`144/32=4.5 → 128`）等易错点。

### 4.2 sigma 两条路径

```python
# 显式（Turbo）：8 个值自动补结尾 0.0 → 9 个值 = 8 步；再按 denoise 截尾
values = normalize_sigmas(sigmas)          # 校验：>=0、有限、单调不增、补 0.0
values = slice_sigmas_for_denoise(values, denoise)
return torch.FloatTensor(values)           # 交给 guider.sample(..., sigmas, ...)

# 默认（官方模板）：复刻 KSampler.set_steps
if denoise >= 0.9999:
    return calculate_sigmas(model_sampling, scheduler, steps)
new_steps = int(steps / denoise)                       # denoise=0.5, steps=8 → 16
return calculate_sigmas(model_sampling, scheduler, new_steps)[-(steps + 1):]
```

`slice_sigmas_for_denoise`：`denoise=0.5` 时保留后一半调度（8 步 → 4 步）+ 结尾 `0.0`；`denoise=0` 只剩 `[0.0]`。

未知名 sampler/scheduler 抛 `EngineError` 并列出 ComfyUI 支持的名单。

### 4.3 `noise_mask`：像素尺寸 → latent

pipeline 传的是 `np.float32 (H, W)`（像素尺寸，0..1）。引擎把它转成 float tensor 后调用
`comfy.sampler_helpers.prepare_mask(mask, latent_shape, device)`（内部 `reshape_mask` 双线性插值到 `(H/16, W/16)` 并复制到 64 通道），再作为 `guider.sample(denoise_mask=...)` 传入 `KSamplerX0Inpaint`。
**注意 `prepare_mask` 在 `comfy.sampler_helpers` 里，不在 `comfy.sample`**（原型注释里的 `comfy.sample.prepare_mask` 是不存在的路径）。

### 4.4 空 latent

`[batch, 64, h//16, w//16]`（MOSS 为 `128` 通道），device 取 `comfy.model_management.intermediate_device()`（默认 CPU，与节点行为一致），采样时由 `outer_sample` 搬上卡。

### 4.5 MOSS-Image 与 Qwen 的差异清单

同一个 `NativeEngine`，差异只在 `EngineConfig` + 档案（`server/models.py`）：

| 项 | Qwen-Image 2.1 | MOSS-Image (sft) |
|---|---|---|
| `CLIPType` | `qwen_image` | `moss_image` |
| 文本编码 | `TextEncodeQwenImage21`（VLM + VAE 参考图） | 纯 `clip.tokenize` + `encode_from_tokens_scheduled` |
| latent | 64 通道 / 16 倍 | **128 通道** / 16 倍 |
| 像素对齐 | 32 倍 | **16 倍** |
| 默认采样 | 25 步 / cfg 1.0 / euler / simple | **50 步 / cfg 3.5 / er_sde / simple**，负向 `bad quality,` |
| 加速 | 显式 sigma 表 + 官方 turbo LoRA | **8 步 LoRA** → 8 步 / cfg 1.0 / euler / simple |
| 边界框 | 不支持 | 支持（`server/moss.py`） |
| SLG | 不支持 | 支持（可选，默认关） |
| RGBA | 支持（`rgba=true`） | 不支持（按白底合成） |
| 参考图编辑 | 支持（1~10 张） | 未接入（`generate_edit` 直接报错） |

**边界框链路**（逐行移植 ComfyUI 三个节点，纯 Python 无 torch）：

```
请求 bbox（像素框 x/y/w/h 或 0..1000 element）
  → pixels_to_fractions / normalize_incoming_boxes
  → boxes_to_regions           # 0..1000 的 [ymin,xmin,ymax,xmax]
  → build_elements             # type/text/desc/palette → metadata
  → MOSSImageLayoutPrompt      # 按目标尺寸换像素、floor/ceil、减画布中心
  → abs_centralized + yxyx 紧凑 JSON 字符串 → 直接当 prompt
```

三个实现细节，改代码时别丢：

1. `item["bbox"]` 必须是
   `[floor(round(y0*h/1000,9))-h//2, floor(round(x0*w/1000,9))-w//2, ceil(round(y1*h/1000,9))-h//2, ceil(round(x1*w/1000,9))-w//2]`
   （`floor` 管前两位、`ceil` 管后两位，和原节点一字不差）。
2. 输出用 `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`，**不能有空格**（节点解析靠这个）。
3. `items` 为空时**原样返回 prompt**，不要拼空 JSON。

**SLG 实现**：`model.clone()` 后 `set_model_sampler_calc_cond_batch_function(...)`，
区间内对 `double_block` / `single_block` 调 `set_model_options_patch_replace(slg_options, skip, "dit", ..., layer)`，
用 `[cond, None]` 与 `[None, uncond]` 各算一次；区间外原样 `calc_cond_batch`。
`start_percent/end_percent` 经 `model_sampling.percent_to_sigma()` 转成 sigma 阈值比较。

---

## 5. 模型生命周期与显存策略

### 5.1 装载是「假快」

`comfy.utils.load_torch_file` + `load_diffusion_model` 走 **mmap 延迟加载**，`ensure_loaded()` 只解析头部，实测 **5.0~11.5s**。真正把权重搬上卡发生在：

1. 第一次 `encode_text()` —— CLIP 8.9GB 上卡 + CUDA kernel 首次编译，实测 **15.8~23.3s**（一次性）；
2. 第一次 `sample()` —— UNET 6.9GB 上卡（由 `sampler_helpers.prepare_sampling` 自动 `load_models_gpu`）；
3. 第一次 `decode()` —— VAE 0.6GB 上卡。

之后每次编码 **0.15~0.2s**（CLIP 常驻），采样/解码见第 6 节。**不要用 `ensure_loaded()` 的耗时判断「模型没生效」。**

### 5.2 文本编码器：留在显存更快（2026-11-06 推翻旧结论）

CLIP 是 int8 8B，约 **8.9GB**。旧版本默认在 `sample()` 前把它卸掉
（`unload_model_and_clones` + `soft_empty_cache`），理由是"采样用不到它"。**实测这是错的**。

A/B（同一台机、同一权重与 18GB LoRA、8 步、warm 后取中位数）：

| 尺寸 | 策略 | 编码 | 采样 | 解码 | 合计 |
|---|---|---|---|---|---|
| 1024² | **常驻** | 0.16s | **1.28s** | 0.52s（tiled） | **2.3s** |
| 1024² | 让位 | 1.41s（重新上卡） | 2.33s | 0.29s（全量） | 4.2s |
| 2016×1152 | **常驻** | 0.18s | **3.73s** | 1.16s | **5.3s** |
| 2016×1152 | 让位 | 1.35s | 5.15s | 1.29s | 8.1s |
| 896² | **常驻** | 0.14s | **0.91s** | 0.38s | **1.7s** |
| 896² | 让位 | — | 3.54s | 0.74s（全量失败） | 5.0s |

三条原因：

1. 省掉每次让位后 **1.0~1.4s** 的 CLIP 重新上卡（`status()["timings"]["clip_reload_s"]`）；
2. CLIP 被 `unload_model_and_clones` 卸掉后，comfy 的模型簿记状态会变化，**紧接着的采样会多花约 1s**
   （8 步 1.28s → 2.33s），大图更明显（3.73 → 5.15s）；
3. 常驻让显存变紧，代价是 VAE 只能走分块，但分块本身只要 0.52s（1MP），远小于上面省下的 1.4s+1s。

**结论：`keep_text_encoder_resident: true`（默认）+ `tiled_decode_threshold: 600000` 是最优组合。**
让位开关仍然保留（`QWEN_NATIVE_KEEP_TEXT_ENCODER=0`），用于"要一次性跑超大图、必须给 VAE 腾满显存"的场景。

> 代价：CLIP 常驻后 1MP 出图时显存只剩约 12GB 空闲；2752×1536 会顶到 0MB。这是分块解码已经覆盖的路径。

### 5.3 VAE 解码：先分块，不要赌全量

`vae.decode()` 内部（`comfy/sd.py`）在全量解码 OOM 时会打一行
`Ran out of memory when regular VAE decoding, retrying with tiled VAE decoding.` 然后自动换 tiled。

**引擎不让它走到那一步**：输出像素 ≥ `tiled_decode_threshold`（600000）时直接 `decode_tiled`。
理由见 4.0 ②：那次"失败的全量尝试"不只是慢（1024² 3.4s vs 分块 0.52s），还会让 comfy 重新搬运权重，
把下一段采样从 0.9s 顶到 3.5s。分块也失败时异常冒到 `EngineError("VAE 解码失败: ...")`，
由 pipeline 记成任务失败，进程继续活着。

`_decode_tiled` 的起始 tile 按**当前空闲显存**选：≥7000MB → 1024，≥4500 → 768，≥2500 → 512，否则 256；
失败再逐级减半（最多 4 次）。tile 实测（2016×1152）：512 = 2.99s、768 = 1.19s、1024 = **1.16s**、1280 = 1.24s。

### 5.4 并发

GPU 只有一个，pipeline 是单 worker 串行，这与引擎的 `self._gen_lock`（装载/编码/采样/解码互斥）匹配。
**多个进程同时用同一张卡跑大模型会导致进程级崩溃**（本机实测过一次：另一进程同时在 1024 turbo 采样，服务进程无 traceback 直接退出）。所以：**不要并行跑两个出图进程**，验收时也不要与本服务同时跑。

---

## 6. 实测数据

> **测量环境**：RTX 5090 31.82GB，`torch 2.11.0+cu128`，**ComfyUI 服务已关闭**（引擎完全独立运行），
> 但系统里还有浏览器 / LM Studio 等进程占用显存，起始空闲显存在 **22~31GB** 之间波动 →
> **属于并发环境测量，不是干净基线**。时间：2026-11-04 01:39–01:42。
>
> **代码版本说明**：三组数据是在引擎仍从 `D:\...\ComfyUI` 源码副本 `import comfy` 时测的（vendor 之前）；
> vendor 后代码与之**同一份 ComfyUI 0.43.0**，数值逻辑不变。vendor 之后已复测通过的是：
> `ensure_loaded` 11.47s、`status()` → `available=True, engine_dir=<PROJECT_ROOT>\engine`、
> 重复 `ensure_loaded` **0.09ms**、`pytest` 全绿；**三组出图在 vendor 后尚未复测**（GPU 被端到端验收占用，等空档补测）。

### 6.1 模型装载

| 项 | 实测 | 备注 |
|---|---|---|
| `import server.backends.native` | **0.021s** | 不 import torch |
| `ensure_loaded()`（unet+clip+vae） | **5.0 / 9.8 / 10.6 / 11.5s** | mmap 延迟加载，冷/热页缓存差异大 |
| `ensure_loaded()` 重复调用（同一套模型） | **0.09ms** | 幂等快路径 |
| 首次 `encode_text()`（含 CLIP 8.9GB 上卡 + 首次编译） | **15.8 / 19.1 / 23.3s** | 一次性成本 |
| 之后 `encode_text()`（文本） | ~0.35–0.5s | |
| CLIP 被 offload 后重新上卡 | **1.0–1.1s** | 每次 offload 后的首次编码 |
| `apply_loras`（320MB 小 LoRA） | 由脚本产出图验证可用，耗时未单独计时 | 见 6.3 |

### 6.2 三组必测用例

| 用例 | 尺寸 | 步数 / sigma | cfg / sampler | 编码 | 采样 | 解码 | **合计** | 峰值显存 | 产物 |
|---|---|---|---|---|---|---|---|---|---|
| **a. t2i turbo** | 1024×1024 | 8 步 / 显式 `TURBO_SIGMAS+0` | 1.0 / euler | 15.8s | **10.0s** | 0.43s | **26.4s** | 26225 MB | `storage/outputs/engine_t2i_1024_turbo.png` |
| **b. t2i 2K 默认** | 2048×2048 | 25 步 / `calculate_sigmas(simple)` | 1.0 / euler | 1.41s | **72.5s** | 5.51s | **80.0s** | 30597 MB | `storage/outputs/engine_t2i_2048_default.png` |
| **c. 单图编辑** | 1024×1024（canvas 跟随参考图） | 25 步 / 默认 | 1.0 / euler | 2.76s | **18.4s** | 1.63s | **23.0s** | 30635 MB | `storage/outputs/engine_edit_single_ref.png` |

- a 的首次测量（同一会话更早一次）：编码 19.1s / 采样 9.5s / 解码 3.2s / 合计 32.0s → 解码那次的 3.2s 是触发了 tiled 回退。
- c 的输入图另存为 `engine_edit_single_ref_input.png`，`canvas == 参考图尺寸 == 1024×1024`（零偏移守卫通过）。
- 2K 的 25 步是官方模板参数（`cfg=1, euler, simple`），不是 turbo。

**人眼确认（`read_image` 实看）**：

| 产物 | 结论 |
|---|---|
| `engine_t2i_1024_turbo.png` | 陶土茶壶 + 原木桌 + 左侧窗光，**釉面高光、景深、木纹纹理都清晰**，不糊、不黑、非色块。turbo 8 步**不挂 LoRA** 就有这个质量 |
| `engine_t2i_2048_default.png` | 雪地赤狐，**单根毛发、眼睛虹膜、雪花虚焦**都在，原生 2K 细节扎实，无 2K 常见的糊/畸变 |
| `engine_edit_single_ref.png` | 按指令把桌布换成**深蓝亚麻**、右侧**新增白瓷杯**，茶壶形状/位置/窗光/背景不变；说明 `reference_latents` 路径正确 |
| `engine_lora_smoke.png` | 黑底发光蓝莲花，验证 LoRA 通路可出图 |

机器统计（用于自动判「不是全黑/成片糊」，可作为回归指标）：

| 文件 | 尺寸 | mean_luma | std_luma | min/max | sharpness | alpha |
|---|---|---|---|---|---|---|
| a 1024 turbo | 1024² | 0.6445 | 0.2465 | 0.000 / 0.999 | 0.02005 | 0.98–1.00 |
| b 2048 | 2048² | 0.4454 | 0.1948 | 0.004 / 0.996 | 0.02851 | 0.97–1.00 |
| c 编辑 | 1024² | 0.5559 | 0.2877 | 0.000 / 0.999 | 0.02675 | 0.98–1.00 |
| d LoRA 冒烟 | 512² | 0.1585 | 0.2358 | 0.000 / 0.842 | 0.01239 | 0.98–1.00 |

判据：`std_luma` 太低（<0.05）或 `sharpness` 太低（<0.005）基本就是糊/纯色；全黑则 `mean_luma≈0`。

### 6.3 补充用例

| 用例 | 结果 |
|---|---|
| **g. 多参考图编辑（3 张：1024² 主图 + 512² + 640×480，`resolution=0`，turbo 8 步）** | **成功**（2026-11-04 02:10）：`ensure_loaded` 5.80s；`encode_text`（含 3 张图的 VAE 编码 + 首次 CLIP 上卡）**21.30s**；`encode_latent` **0.06s**；采样 **11.46s**；解码 **0.28s**；canvas=(1024,1024) → `storage/outputs/engine_edit_multi3ref.png`。人眼看：茶壶保持、桌布变深蓝、无接缝/糊 |
| d. 局部编辑（`VAEEncode` + `noise_mask` numpy 像素尺寸） | 脚本已实现（`scripts/verify_native_engine.py --cases d`），**尚未拿到完整数据**（当时脚本汇总行有 bug + 后续被要求停 GPU） |
| e. LoRA 切换（320MB `p_qwen_image_2.1_8step_v0.1`，512² 8 步） | 出图成功（`engine_lora_smoke.png`），随后 `apply_loras([])` 还原基座；说明挂载/清空通路可用 |
| f. 官方 18.22GB turbo LoRA | 现可正常加载，见 7.1 |

### 6.4 2026-11-06 复测基线（cu130 + 调优后配置）

环境：RTX 5090 31.82GB、`torch 2.13.0+cu130`、`python -s`、CLIP 常驻、阈值 0.6MP、HiFi 18GB LoRA。
`scripts/bench_stages.py` 直接打引擎（含 `free()`），端到端走 `POST /api/generate` + 轮询。

**冷启动（进程刚起，第一张图）**

| 阶段 | 1024² | 2016×1152 |
|---|---|---|
| `ensure_loaded` | 12.4~26.4s（页缓存差异大） | 同 |
| 首次 `encode_text`（CLIP 8.9GB 上卡） | 0.9~1.0s | 0.9~1.0s |
| 首次 `sample` | **12.5s** | **16.1s** |
| 首次 `decode` | 0.8s | 1.5s |
| 端到端首张 | **32.8s** | — |

首次 `sample` 的 12.5s 拆开看：**约 5s 是 int8 kernel 首次运行/autotune（与分辨率无关，512² 也是 5.2s）**，
**另外 7~8s 是 18GB HiFi LoRA 的首次烘焙**（换 0.31GB 小 LoRA 后同尺寸首采样只要 5.2s）。
这两块都只付一次；`warmup_on_load` 只是把它前移到启动阶段，不减少总量，所以默认仍关。

**热态矩阵（端到端 `POST /api/generate` → 轮询到 done，取样 100ms）**

| 尺寸 | 采样 | 解码 | 端到端 |
|---|---|---|---|
| 512² | 0.38s | 0.07s（全量） | **0.78s** |
| 1024² | 1.30s | 0.50s | **2.13s** |
| 2016×1152 | 3.73s | 1.13s | **5.25s** |
| 2752×1536 | 9.30s | 2.35s | **12.3s** |

（采样/解码取自引擎 INFO 日志；端到端与两者之和的差额 ≈ 0.35~0.45s，含 PNG 编码、缩略图、落盘、HTTP 与轮询量化误差。）

其它已验证结论：

- **`free(unload=False)` 只做 `torch.cuda.empty_cache()`**：原先的 `soft_empty_cache`
  （synchronize + empty_cache + ipc_collect）再加 `gc.collect()` 每单要 0.19~0.25s，实测只清 empty_cache
  就够（2K：free 从 0.22s 降到 0.03s，下一单不退化）。**不要改成完全不清**——那样下一单反而慢 0.2~0.3s。
- **PNG 压缩档位做成配置 `png_compress_level`，默认 1**（真实 2K 图：lv6 = 309ms / 5.2MB，
  lv1 = 101ms / 8.2MB，体积 +58%，画质无损）。
- **缩略图不再二次解码 PNG**：`save_output(..., image=已解码的 PIL 图)` 直接从内存缩放，
  4.3MP 图从 149ms 降到 24ms；同时省掉 `probe_image` 的又一次全图解码（37ms）。
- **2.3MP 全量 VAE 解码在本机根本不可能**：即使**完全不挂 LoRA**、显存全空，依旧
  `Ran out of memory when regular VAE decoding` → 说明 Qwen VAE 在 2.3MP 的峰值 >28GB。
  所以分块 1.13s 就是地板，不存在「先全量再回退」的更优解。
- **编辑链路有 0.3~1.1s 的纯 CPU 后处理**（`imaging.composite`：羽化 + Reinhard 配色）：
  1024² 274ms、2016×1152 602ms、2752×1536 1116ms。t2i 不受影响；编辑任务调参时要把这块算进去。
- 采样是硬件边界：1MP 8 步 = 1.30s（≈160ms/步），换任何 attention 后端都是噪声级差异（见 4.0）。
- **文本编码缓存（2026-11-06 端到端验证）**：同一提示词连发 3 次
  `POST /api/generate`（1024² Turbo），第 1 次未命中 2.16s、之后命中稳定 **2.00~2.05s**；
  换一句提示词回到 2.16s，再换回又回到 2.01s。`/api/health` 的
  `engine.encode_cache` 会给出 `{size, max, hits, misses}`，便于前端/脚本确认是否命中。
  2016×1152 档命中与否都是 ~5.0s（编码只占 0.18s，被采样淹没）——这是正常的。
- **和 ComfyUI 4.95s 的对照不是同口径**：2.3MP 全量解码既然不可能，任何 2016×1152 + 8 步的实现
  都得付 1.1s 左右的分块解码；本项目 5.25s 已在此基础上。1MP 档本项目 2.13s，ComfyUI 同尺寸约 5s。

### 6.5 MOSS-Image 实测（2026-11-06）

环境同上（RTX 5090 31.82GB、cu130、`python -s`、引擎内跑，不启动 ComfyUI）。
权重：`moss_image_sft_bf16` + `qwen3.5_9b_int8_convrot` + `flux2-vae`。

| 档位 | 尺寸 | 采样参数 | encode | 采样 | 解码 | 备注 |
|---|---|---|---|---|---|---|
| 8 步 LoRA | 1024×1024 | 8 步 / cfg 1.0 / euler / simple | 1.4s（热） | **3.73s** | 0.30s | 首图 decode 4.91s（autotune） |
| 无加速 + SLG | 1024×1024 | 50 步 / cfg 3.5 / er_sde / simple | — | **28.5s** | — | SLG `single_layers=22`、0~0.5 |
| 无加速 + SLG | 1248×1664 | 50 步 / cfg 3.5 / er_sde / simple | — | **66.7~72.6s** | 0.9s | 请求 1256×1672，16 对齐后实际 1248×1664 |

三条已验证的行为（改代码时容易回退）：

- **尺寸对齐不是 bug**：请求 1256×1672 输出 1248×1664。ComfyUI `EmptyLatentImage` 返回
  `downscale_ratio_spacial=8`，Flux2 latent 是 16 倍下采样，`fix_empty_latent_channels` 会做 0.5 倍缩放；
  与本项目的 `//16` 完全一致。
- **LoRA 真的在生效**：`apply_loras` 本身只 0.04s（只建 patch），采样时才应用。核对过
  `model_lora_keys_unet` 覆盖 252/252 键、`load_lora` 生成 252 个 patch。
- **边界框文字准确**：`清凉一夏` 海报用例，4 个框（蓝天白云 / 跳跃少女 / 草地树木 / 顶部标题）
  位置与文字都对，说明 `type/text/desc` → `metadata` → `text` 整条链路通了。

管线级（`Pipeline.generate_t2i`，`model=moss` + `turbo.enabled` + `bbox`）：
`steps=8, cfg=1.0, euler`，`job.meta.bbox.enabled=true`、`items=1`，
`job.params.layout_prompt` 是 `abs_centralized/yxyx` 紧凑 JSON，输出 832×832，
文件名前缀 `moss-t2i-…`（Qwen 仍为 `qwen21-…`）。



---

## 7. 已知坑 / 限制

### 7.1 官方 18.22GB turbo LoRA：现在能加载，但首次要烘焙 7~8s

- 文件：`D:\...\models\loras\qwen2.1加速\qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors`（**18.22GB**）。
- 它是**真正的 LoRA**：safetensors 头 665 个 tensor（200 组 `lora_down/lora_up` + 200 个 `alpha` + 65 个 `diff`），元数据 `modelspec.architecture = qwen_image_2.1/lora`，`adaptive SVD`。不是误命名的 checkpoint。
- **历史问题（2026-11-04）**：`load_torch_file()` 阶段报
  `OSError: 页面文件太小，无法完成操作。 (os error 1455)` —— safetensors `safe_open` 对此文件做 mmap 时撞上 Windows 提交限制。
- **2026-11-06 复测：可正常加载**（`python -s` + 现页面文件），已连续跑通十余次 `apply_loras` 与出图。
  代价有两块，都只付一次：
  1. **首次采样多 7~8s**（18GB 适配器首次烘焙）——同尺寸换 0.31GB 小 LoRA 只要 5.2s；
  2. **常驻占 18GB**，把 VAE 挤进分块解码路径（已由 5.3 的阈值策略覆盖）。
- 引擎侧行为是安全的：`apply_loras` 把异常包成 `EngineError("LoRA 装载失败: ...")`，任务失败但**进程存活**。
- 建议：
  1. **日常迭代用 0.31GB 的 `p_qwen_image_2.1_8step_v0.1.safetensors`**：冷启少约 40s、显存多出 18GB，热态采样与 HiFi 版本无差异（都是 1.28s@1MP）；
  2. 成片/验收再切 `turbo8_official`（HiFi）——画质换时间；
  3. 若又出现 `os error 1455`，先扩大 Windows 页面文件（或换成 bf16 小 LoRA 档位）。

### 7.2 【已修】`Inplace update to inference tensor outside InferenceMode`（3 张以上参考图的编辑）

**症状**：3 张参考图的编辑任务报
`EngineError: VAE 编码失败: Inplace update to inference tensor outside InferenceMode is not allowed.`
1~2 张正常，3 张必挂。

**根因**（vendor 的 ComfyUI 库里的一个 bug，不在我们代码）：

- `comfy/utils.py::tiled_scale` / `tiled_scale_multidim` 带 `@torch.inference_mode()`，
  它产出的张量是 **inference tensor**；
- `comfy/sd.py::VAE.encode_tiled_` 却对这个产出做原地运算：

  ```python
  samples = comfy.utils.tiled_scale(pixel_samples, encode_fn, ...)   # inference tensor
  samples += comfy.utils.tiled_scale(...)                            # ← 在 inference_mode 之外原地改
  samples /= 3.0
  ```

  → 抛 `Inplace update to inference tensor outside InferenceMode`。
- 常规 `vae.encode()` 走不到 `encode_tiled_`，**只有 encode 显存不足、库自动回退 tiled encode 时才会**。
  多参考图（≥3 张）显存更紧，于是只有 3 张图时触发——完全解释了"1~2 张正常、3 张挂"。

**修法**（`server/backends/native.py`，两处 + 一个工具函数，未改 `engine/` 里的任何文件）：

1. 新增模块级 `as_normal_tensor(tensor)`：inference tensor → `clone()` 成普通张量（并保证连续）。
   注意必须在 `inference_mode` **之外**调用，否则 clone 出来仍是 inference tensor。
2. 新增 `NativeEngine._encode_vae(pixels)` 作为**唯一的 VAE 编码入口**
   （`encode_text` 的参考图循环 + `encode_latent` 都改走它）：
   - 先把 VAE 权重上卡（在 inference_mode 之外，避免推理上下文里搬权重）；
   - `with torch.inference_mode(): out = vae.encode(pixels)` —— 让库里 `encode_tiled_` 的
     `+=` / `/=` 合法；
   - `return as_normal_tensor(out)` —— 输出转普通张量，避免**后续采样**对 latent 原地操作时
     再抛同样错误（常规路径的输出此时也是 inference tensor）。
3. 防御性归一化：`sample(latent=...)` 若收到 inference tensor 会 clone；`noise_mask` 处理后
   与 `decode(samples)` 的输入也会归一化。

**验证**：
- 确定性复现/回归脚本 `scripts/repro_multi_ref.py`：`--force-tiled` 把 `vae.encode` 换成
  `vae.encode_tiled_`（真机上只有 OOM 才走这条路）。修前稳定抛上面的错，修后通过，
  产出 latent `is_inference=False`。
- 真实 3 参考图端到端：成功（数据见 6.3 用例 g）。
- 单测 `tests/test_native_backend.py::test_as_normal_tensor_*`（在 CPU 上用一个
  `torch.inference_mode()` 里创建的张量复现原错误并验证归一化后可原地修改）。

**数值影响**：tiled encode 本身是 ComfyUI 的近似实现（把 3 种 tile 划分的结果平均），
不是逐位等价。实测同一张 1024² 图：`tiled(512)` vs 常规 encode 解码回像素后
**mean=0.98/255、max=47/255**；`tiled(256)` 为 mean=1.44、max=87。也就是说只在
**显存不够的降级路径**里会出现轻微差异，正常路径不受影响。

### 7.3 其他

1. **必须先 `ensure_loaded()` 再 `encode_text()`**，否则抛 `EngineError("模型未装载: ...")`（刻意不做隐式自动加载，避免 40GB 权重在请求线程里突然上卡）。
2. **CLIP 被挪走后重新编码要多 ~1s**：`sample()` 结束不会自动装回，下一次 `encode_text()`/`ensure_loaded()` 会装回（`status()["text_encoder_offloaded"]` 可观测）。
3. **首次编码慢 15~23s**：写前端进度文案时要把它算进去（pipeline 已有「加载模型（首次可能需要 20~60 秒）」提示）。
4. **2K 会触发 tiled VAE**：解码 5.5s 是正常值，不是 bug。
5. **不要两个进程同时出图**：会进程级崩溃（无 traceback），比任务失败严重。
6. **`decode()` 返回 list**，batch>1 时逐个元素；pipeline 已按此处理。
7. **alpha 实测 0.97~1.00**：正常图 alpha 基本不透明；要真透明背景需按官方提示词首尾声明 RGBA（pipeline 的 `rgba=true` 分支已做）。
8. **`torch` 启动警告**（`You need pytorch with cu130 or higher`、`pynvml deprecated`）是环境提示，不影响推理。
9. **本项目没有真 pytest**：`$PY -m pytest` 跑的是根目录 `pytest.py` 兼容 shim，**不支持 parametrize / fixture / conftest**，测试必须写成无参函数（本模块测试已按此写）。

---

## 8. 与 `server/pipeline.py` 的对接契约

pipeline 的实际调用顺序（已在服务端固化）：

```python
engine = NativeEngine(EngineConfig(engine_dir=..., unet=..., clip=..., vae=...))   # 零成本
engine.ensure_loaded(**models)                # models 是三个绝对路径
engine.apply_loras(loras)                     # 每次调用先清空上一批（内部从基座重挂）

# t2i
cond = engine.encode_text(prompt, negative_prompt)
samples = engine.sample(positive=cond["positive"], negative=cond["negative"],
                        latent=None, width=width, height=height, batch=batch,
                        sigmas=sigmas, steps=steps, cfg=cfg, sampler=sampler,
                        scheduler=scheduler, seed=seed, denoise=denoise,
                        noise_mask=None, callback=cb)
images = engine.decode(samples)               # list[PIL.Image]

# edit（resolution 必须 0，零偏移）
cond = engine.encode_text(prompt, negative_prompt, images=[canvas, *others], resolution=0)
assert tuple(cond["canvas"]) == canvas.size
latent = engine.encode_latent(canvas)                       # 方案 A（局部编辑）
samples = engine.sample(..., latent=latent, noise_mask=mask_canvas_np, ...)
images = engine.decode(samples)

engine.free(unload=False)                     # 每单结束，模型留在显存
```

**模型档案与引擎实例**：`pipeline` 不再只持有一个引擎，而是 `self._engines: dict[model_id, NativeEngine]`，
按 `profile["id"]` 惰性创建（`_engine_for(profile)`）。切换模型时对**其它已加载引擎**执行
`free(unload=True)`——32GB 放不下 Qwen + MOSS 两套权重，必须让位。每个引擎的
`EngineConfig` 由 `_make_engine_config()` 按档案填 `clip_type / text_backend / latent_channels / latent_downscale`。

MOSS 的 t2i 调用与上面完全同形，只多两个可选入参：

```python
profile = models.get(cfg, params.get("model"))        # "qwen" | "moss"
width, height = _t2i_size(cfg, params, profile)       # moss：按 ratio + megapixels + 16 对齐
prompt, info = moss.build_layout_prompt(prompt, params.get("bbox"), width, height)
cond = engine.encode_text(prompt, sampling["negative_prompt"])   # text_backend="moss"
samples = engine.sample(..., sigmas=None, steps=8, cfg=1.0, sampler="euler",
                        scheduler="simple", slg=sampling["slg"], ...)
```

需要 pipeline 注意的点：

| 点 | 说明 |
|---|---|
| **取消** | 采样 `callback` 里抛异常即可中断；引擎会**原样抛出**该异常（不包成 `EngineError`）。`job.check_cancel()` 建议在采样前 + 回调里都做 |
| **错误类型** | 引擎所有失败都是 `EngineError(RuntimeError)`，pipeline 把它记成任务 error 即可；**不会让进程退出** |
| **模型切换** | 同一个引擎内 `ensure_loaded()` 传不同路径会整体重载（~10s + 首次编码 ~16s）；**跨模型切换会卸载另一套权重**（见上） |
| **LoRA** | 空列表 = 还原基座；切换 LoRA 会重新读盘（小 LoRA 快，18GB 见 7.1）。MOSS 的 8 步 LoRA 用 `turbo.lora="none"` 可关 |
| **`batch`** | `sample(batch>1)` 只在 `latent=None` 时生效；`decode` 返回同长度 list |
| **canvas 守卫** | edit 时必须 `resolution=0` 且画布 32 对齐，否则 `cond["canvas"] != canvas.size`，pipeline 已抛 `PipelineError` |
| **能力开关** | 只按 `profile["capabilities"]` 走分支：`bbox`/`slg` 仅 MOSS，`rgba`/`edit` 仅 Qwen。MOSS 收到 `bbox` 以外的能力请求要写 `job.meta` 说明被忽略，不要静默丢弃 |

---

## 9. 复现命令

```powershell
# 解释器固定用 ComfyUI 自带那个
$PY = '<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe'

# 纯逻辑单测（0.03s，不加载模型）
& $PY -m pytest tests/test_native_backend.py -q
& $PY -m pytest tests/test_moss_profile.py -q      # MOSS 档案 / 布局换算 / SLG 开关

# 全量测试（含其它模块）
& $PY -m pytest tests -q

# 真实出图（三组必测 + LoRA/局部编辑），产物在 storage/outputs/engine_*.png
# 注意：会占满显存，跑之前先确认没有别的出图进程
& $PY scripts/verify_native_engine.py --cases a,b,c
& $PY scripts/verify_native_engine.py            # 全量 q,a,b,c,d,e

# CLIP 常驻 / 让位 A/B + 分阶段计时（改 --resident / --threshold / --tile 扫参数）
# 结论见 5.2 / 6.4
& $PY scripts/bench_stages.py --width 1024 --height 1024 --runs 3

# 定位 18.22GB turbo LoRA 的加载失败（最小复现）
& $PY scripts/debug_turbo_lora.py

# 多参考图编辑 / tiled VAE encode 的回归复现（7.2 那个 bug）
& $PY scripts/repro_multi_ref.py --refs 3 --sample                 # 真实 3 参考图编辑
& $PY scripts/repro_multi_ref.py --refs 1 --force-tiled --tile 256 256   # 确定性走 tiled encode
```

验收判据（自动）：`storage/outputs/engine_bench.json` 里每个用例 `ok=true`，且 `std_luma>0.05`、`sharpness>0.005`、`mean_luma` 不在 0 附近。

---

## 10. 待办 / 未完成

1. ~~vendor 后完整三组复测~~ —— 已完成，见 6.4（不同尺寸/后端的热态矩阵）。
2. ~~CLIP offload 受控 A/B~~ —— 已完成，见 5.2（结论：常驻更快）。
3. **局部编辑 `noise_mask` 完整数据**（用例 d）。
4. **`denoise<1` 的图生图**实测（当前只做了 `denoise=1.0`）。
5. **`batch>1`** 实测（多图一次采样）。
6. ~~18.22GB turbo LoRA 加载失败~~ —— 已可加载，见 7.1；剩余只是首次烘焙 7~8s 的成本。
7. ~~多参考图（≥3）编辑报 inference tensor 错~~ —— **已修并验证**，见 7.2；如需补更多图数（4~10 张）的显存压力测试，用 `scripts/repro_multi_ref.py --refs N` 扩展。
8. ~~prompt embedding 缓存~~ —— **已完成**，见 4.0 ⑤ 与 6.4（`encode_cache_size`，默认 8 条；
   纯文本省 145ms/张，编辑带参考图省 1.4s/张）。
   PNG 压缩档位与缩略图快路径**已完成**，见 6.4。
9. ~~VAE 量化 / `torch.compile`~~ —— **不做**（2026-11-06 决定）：项目目标是速度与质量跟 ComfyUI
   平齐，不追额外加速。现状已达标：同权重同 sigma 同种子，模型/采样器代码就是 vendored 的
   ComfyUI 本体，唯一的实现差异是解码分块（我们 1024 tile 比 ComfyUI OOM 回退的 512 tile 接缝更少）。
10. **MOSS 参考图编辑**：本轮只做文生图 + 边界框。`encode_text(text_backend="moss")` 收到 `images`
    会直接报错；下一轮要补 VAE 参考图编码与 `reference_latents` 条件拼接（对照 ComfyUI MOSS 编辑节点）。
11. **MOSS 8 步 LoRA 之外的加速方式**：目前只认 LoRA；若要接 sigma 表或蒸馏底模，在档案
    `accelerator.kind` 里加新分支即可，引擎侧不用改。
