# 构建契约（所有参与者必须遵守）

项目：**Qwen-Image 2.1 独立本地工作台**。
根目录：`<PROJECT_ROOT>`（会话工作区）。**不要读写工作区以外的文件，除非明确要求只读。**

## 0. 硬约束（先读这段）

1. **本项目是独立服务，不依赖 ComfyUI 服务运行。**
   - 推理走 `server/backends/native.py`：把 `{COMFY_ROOT}`（含 `comfy/` 包的 ComfyUI 根目录，默认
     `<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI`）加入 `sys.path`，**只 import 其纯 Python 模型库代码**，
     自己构建采样管线。不需要 ComfyUI 的进程、端口、folder_paths、模型清单。
   - 模型文件按**绝对路径**加载（默认在 ComfyUI 的 `models/` 下，可用配置改）。
   - 那个 ComfyUI 服务会在开发过程中被关掉；任何实现都必须在它关掉后照常工作。
2. **零安装**：本机**没有可用 npm / PyPI 网络**（registry 超时）。
   - 前端**不允许**构建步骤、不允许 node_modules、不允许 React/JSX。只写浏览器原生 ES module + 原生 CSS。
   - 后端只允许用本机 Python 已有的库：`fastapi`、`uvicorn`、`pydantic`、`starlette`、`PIL`、`numpy`、`requests`、`torch`。
   - Python 解释器统一用：`<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe`（下称 `$PY`）。
3. **全部界面文案用中文**（技术标识符保持英文）。
4. **不要修改** `<COMFY_ROOT>\...` 下任何文件（只读参考/只读加载）。
5. 我们的服务端口固定 **8700**，一条命令启动（`scripts/run.ps1`）。
6. 每个模块写完后必须能 `import` 成功；纯逻辑函数必须有 pytest 测试。
   **本机没有安装 pytest**（任何解释器都没有，且无法联网安装）。项目根目录放了一个
   极简兼容运行器 `<PROJECT_ROOT>\pytest.py`，所以下面这条命令是**可用的**：
   `$PY -m pytest tests -q`
   它支持 `pytest.raises(...)`、`pytest.approx(...)`、`pytest.fail/skip/xfail`、
   `pytest.fixture`（空装饰器）、`pytest.mark.*`（空装饰器）、`pytest.warns`，
   以及 `-v / -q / -k / -x`。**不支持** parametrize / conftest / fixture 注入，
   测试请写成纯 `assert` 的 `test_*` 函数（或用 `Test*` 类 + `test_*` 方法）。
7. 文件编码 UTF-8（无 BOM）；JSON 一律 `ensure_ascii=False`。

## 1. 目录与归属（写作用域，互不重叠）

```
<PROJECT_ROOT>\
├─ server\
│  ├─ main.py              Lead         FastAPI 入口、路由、静态托管
│  ├─ config.py            Lead         配置（模型路径 / comfy_root / ollama / 生成默认值）
│  ├─ pipeline.py          Lead         统一管线：解码→画布规划→引擎→裁回→合成→存盘
│  ├─ jobs.py              Lead         任务队列 + 进度 + 历史
│  ├─ storage.py           Lead         工作区文件存取
│  ├─ backends\native.py   native-engine 进程内推理引擎（模型生命周期/编码/采样/解码/LoRA）
│  ├─ imaging.py           align-color  图像 I/O + 画布规划 + 合成编排（BlueBox 移植）
│  ├─ align.py             align-color  几何/颜色算法核（Precise-Align 移植，无 torch）
│  ├─ ollama.py            prompt-style Ollama HTTP 客户端
│  ├─ prompt_polish.py     prompt-style 提示词润色（官方 PE 规则）
│  └─ styles.py            prompt-style image-style-kit 目录加载 + 提示词合成（Python 侧）
├─ web\
│  ├─ index.html           frontend
│  ├─ assets\css\*.css     frontend
│  ├─ src\*.js             frontend     （原生 ES module）
│  └─ vendor\image-style-kit\  prompt-style （复制自 <LOCAL_PROJECTS>\...\image-style-kit）
├─ data\                   prompt-style  （PE 官方系统提示词）
├─ docs\                   各自负责自己那份
├─ tests\                  各模块自己的测试文件
├─ scripts\                Lead + native-engine
├─ comfy_workflows\        （可选交付，暂缓）
└─ storage\                运行时产物（uploads/outputs/thumbnails/editor）
```

## 2. 后端模块契约

### 2.1 `server/align.py`（align-color 负责）

纯算法，**只用 numpy + PIL**，不 import torch。遮罩用 `np.float32`，形状 `(H, W)`，值域 `[0,1]`，`1` = 要编辑的区域。

```python
MULTIPLE = 32

@dataclass
class PadInfo:
    orig_w: int; orig_h: int
    scale: float
    out_w: int; out_h: int          # 缩放后、补边前的尺寸
    pad_l: int; pad_t: int
    canvas_w: int; canvas_h: int
    multiple: int
    pad_mode: str

def snap_dims(w: int, h: int, multiple: int = 32) -> tuple[int, int]
def pad_image(im, *, multiple=32, pad_mode="edge", align="center", pad_value=0.5,
              scale_by=1.0, scale_method="lanczos") -> tuple[Image.Image, PadInfo]
def crop_back(im, info: PadInfo, *, method="bicubic") -> Image.Image
def fixed_point_size(w, h, resolution=1024, tol_ratio=1.0) -> tuple[int, int, int]
def dilate_mask(mask, px: int) -> np.ndarray
def feather_mask(mask, px: int) -> np.ndarray
def curve_mask(mask, curve="smoothstep") -> np.ndarray
def band_from_mask(mask, fallback_px=8) -> np.ndarray | None
def reinhard_match(edited, reference, weights, strength) -> np.ndarray
def region_shapes_to_mask(w, h, shapes: list[dict], feather=0, expand=0) -> np.ndarray
def latent_tokens(w, h, multiple=32) -> int
```

### 2.2 `server/imaging.py`（align-color 负责）

```python
SNAP = 32

@dataclass
class CanvasPlan:
    width: int; height: int; scale: float; offset_x: int; offset_y: int
    src_w: int; src_h: int; fit: str

@dataclass
class ImageMeta:
    width: int; height: int; mode: str; has_alpha: bool; format: str; icc: bool

def decode_image(data: bytes, *, keep_alpha: bool = True) -> Image.Image
def decode_mask(data: bytes, width: int, height: int, *, invert: bool = False) -> np.ndarray
def encode_png(im, *, strip_icc: bool = True) -> bytes
def encode_jpeg(im, quality: int = 95) -> bytes
def data_url(mime: str, data: bytes) -> str
def parse_data_url(url: str) -> tuple[str, bytes]
def plan_canvas(src_w, src_h, *, mode, width=None, height=None, ratio=None,
                megapixels=None, fit="pad", multiple=32) -> CanvasPlan
def compose_canvas(src, plan, *, pad_mode="edge",
                   pad_color=(0.5, 0.5, 0.5, 1.0)) -> Image.Image
def map_mask_to_canvas(mask, plan) -> np.ndarray
def map_mask_from_canvas(mask, plan) -> np.ndarray
def composite(original_canvas, edited_canvas, mask_canvas, *, feather=32,
              curve="smoothstep", color_match=True, color_strength=0.6,
              mask_expand=0) -> Image.Image
def crop_region(original_canvas, mask_canvas, *, context_factor=1.5,
                context_pixels=96, multiple=32) -> tuple[Image.Image, CropInfo]
@dataclass
class CropInfo: x: int; y: int; w: int; h: int; canvas_w: int; canvas_h: int
def stitch_region(original_canvas, edited_crop, crop, mask_canvas, *, blend_pixels=24,
                  curve="smoothstep", color_match=True, color_strength=0.85) -> Image.Image
def compare(a, b) -> dict
```

### 2.3 `server/ollama.py` / `server/prompt_polish.py`（prompt-style 负责）

```python
class OllamaError(RuntimeError): ...

class OllamaClient:
    def __init__(self, base_url="http://127.0.0.1:11434", timeout=300)
    def is_alive(self) -> bool
    def list_models(self) -> list[dict]
    def chat(self, model, messages, *, temperature=1.0, top_p=0.95, top_k=20, min_p=0.0,
             presence_penalty=1.5, repetition_penalty=1.0, num_predict=2048,
             format=None) -> str

DEFAULT_T2I_MODEL = "qwen3.5:9b"
DEFAULT_EDIT_MODEL = "qwen3.5:9b"

def load_system_prompt(mode: str) -> str
def polish(prompt, *, mode="t2i", model=None, client=None, timeout=300, fallback=True) -> dict
    # {"rewritten_prompt","wh_ratio","ratio_follow","model","elapsed_ms","fallback","raw","mode"}
def available_models() -> list[str]
def pick_default_model(preferred=None) -> str
```

### 2.4 `server/styles.py`（prompt-style 负责）

```python
def load_catalogs() -> dict   # {"creative","mj","mjGroups","insertModes","count"}
    # insertModes 是对象数组：[{"key":"style","label":"风格码"},{"key":"parameters",...},
    #                          {"key":"full",...},{"key":"vibe",...}]
def compose_prompt(prompt, *, presets=None, image_angle=None, node_type="Image") -> str
def angle_prompt(image_angle) -> str
def normalize_mj_prompt(text) -> str
def validate_presets(presets) -> list[dict]
```

前端合成提示词的推荐入口：`/vendor/image-style-kit/src/prompt.js`
（只 import creative.js / mjPrompt.js / imageAngle.js，**不碰静态 JSON import**，
比 `src/index.js` 稳；`index.js` 会连带 catalogs.js 的 `with { type: 'json' }`）。

### 2.5 `server/backends/native.py`（native-engine 负责）

进程内推理引擎。签名固定，pipeline 按此调用：

```python
class EngineError(RuntimeError): ...

@dataclass
class EngineConfig:
    comfy_root: str
    unet: str | None = None
    clip: str | None = None
    vae: str | None = None
    vram_reserve: float = 0.15
    dtype: str = "default"

class NativeEngine:
    def __init__(self, config: EngineConfig) -> None
    def status(self) -> dict
        # {"available","reason","comfy_root","device","vram_total_mb","vram_free_mb",
        #  "loaded":{"unet","clip","vae","loras":[{"name","strength"}]}}
    def ensure_loaded(self, *, unet=None, clip=None, vae=None) -> None
    def apply_loras(self, loras: list[dict]) -> None
    def encode_text(self, prompt, negative_prompt="", images=None, resolution=0) -> dict
        # {"positive":COND, "negative":COND, "canvas":(w,h)}；复刻 TextEncodeQwenImage21.execute
    def encode_latent(self, image) -> "torch.Tensor"   # [1,64,h/16,w/16]
    def sample(self, *, positive, negative, latent, sigmas, steps, cfg,
               sampler="euler", scheduler="simple", seed=0, denoise=1.0,
               noise_mask=None, callback=None) -> "torch.Tensor"
    def decode(self, samples) -> "PIL.Image.Image"     # RGBA
    def free(self, *, unload=False) -> None
```

## 3. HTTP API 契约（Lead 实现，前端按此调用）

基址 `http://127.0.0.1:8700`。错误统一 `{"error":{"code":str,"message":str}}` + 4xx/5xx。

```
GET  /api/health
  -> {"ok":true,
      "engine":{"ready":bool,"reason":str|null,"device":"cuda:0",
                "vram_total_mb":int,"vram_free_mb":int,
                "loaded":{"unet":str|null,"clip":str|null,"vae":str|null,"loras":[...]}},
      "ollama":{"connected":bool,"models":["..."]},
      "queue":{"pending":int,"running":bool},
      "outputs":int}
GET  /api/options
  -> {"models":{"unet":[{"value","label","size_gb"}],"clip":[...],"vae":[...],"lora":[...]},
      "samplers":["euler","euler_ancestral","dpmpp_2m",...],"schedulers":["simple","normal",...],
      "ratios":[{"id":"1:1","label":"1:1 方形","w":2048,"h":2048},...],
      "turbo_profiles":[{"id","label","sigmas":[float],"steps","cfg","sampler","lora","strength","note"}],
      "steps_presets":[{"id","label","steps","cfg","note"}],
      "defaults":{"unet","clip","vae","steps","cfg","sampler","scheduler","width","height","turbo_profile","consistency_lora"},
      "turbo_sigmas_help":str}
GET  /api/styles -> styles.load_catalogs()
GET  /api/styles/angle-prompt?azimuth=&elevation=&zoom= -> {"prompt":str,"description":{...}}
POST /api/polish   {"prompt","mode":"t2i"|"edit","model":str|null}   -> prompt_polish.polish()
POST /api/generate (文生图)
  {"prompt","negative_prompt":"","width":int,"height":int,
   "steps":int,"cfg":float,"seed":int|null,"batch":int,
   "sampler":"euler","scheduler":"simple",
   "turbo":{"enabled":bool,"profile":str,"sigmas":[float]|null},
   "rgba":bool,
   "models":{"unet","clip","vae"},"loras":[{"name","strength"}],
   "meta":{...任意前端元数据，原样回传}}
  -> {"job_id":str}
POST /api/edit (图像编辑)
  {"prompt","negative_prompt":"",
   "images":[{"name","data":"data:image/png;base64,..."}],   # 1..10，第 1 张是编辑目标
   "size_mode":"follow"|"custom"|"ratio"|"fixed_point",
   "width":int|null,"height":int|null,"ratio":str|null,"megapixels":float|null,
   "fit":"pad"|"crop","pad_mode":"edge",
   "mask":{"data":"data:image/png;base64,..."}|null,
   "local":{"enabled":bool,"scheme":"a"|"b","feather":int,"color_match":bool,
            "color_strength":float,"mask_expand":int,"context_factor":float,
            "context_pixels":int,"blend_pixels":int},
   "resolution":0,"steps":int,"cfg":float,"seed":int|null,"denoise":float,
   "sampler","scheduler","turbo":{...},
   "models":{...},"loras":[...],
   "consistency_lora":{"name":str,"strength":float}|null,
   "meta":{...}}
  -> {"job_id":str}
GET  /api/jobs/{job_id}
  -> {"id","kind":"t2i"|"edit","status":"queued"|"running"|"done"|"error"|"canceled",
      "progress":{"value":int,"max":int,"label":str},
      "images":[{"url","width","height","filename"}],
      "align":{"canvas":{"w","h"},"plan":{...},"applied":bool}|null,
      "quality":{"outside_max_abs":int|null,"size_match":bool}|null,
      "error":str|null,"prompt":str,"params":{...},"meta":{...},
      "elapsed_ms":int|null,"created_at":str}
POST /api/jobs/{job_id}/cancel -> {"ok":true}
GET  /api/history?limit=30 -> {"items":[...]}
DELETE /api/history -> {"ok":true}
POST /api/upload  multipart(file) -> {"id","url","width","height","has_alpha"}
GET  /files/{path} -> 静态文件（storage 下只读；含 uploads/outputs/thumbnails）
GET  / -> web/index.html，其余 /src/... /assets/... /vendor/... 静态托管
```

## 4. 关键算法约定

### 4.1 零像素偏移
- 画布尺寸**必须是 32 的倍数**。
- 编码器 `resolution` 传 **0**：参考图只对齐到 32、不再缩放，于是画布尺寸 == 参考图尺寸 == 采样 latent 尺寸。
- 局部编辑：`latent = VAEEncode(同一张画布)` + `noise_mask`（等价 SetLatentNoiseMask），尺寸与参考图完全一致。
- 出图后 `crop_back` 回源尺寸，再 `composite` 用原图像素盖回遮罩外。

### 4.2 零色差
- 解码：exif 纠正 →（有 ICC 则转 sRGB）→ 统一 RGBA，不做隐式色彩变换。
- **遮罩外逐像素保留原图**：`composite` 的硬验收是 `compare()` 显示遮罩外 `max_abs == 0`。
- 接缝只对过渡带做 Reinhard 仿射匹配。
- 输出统一 PNG（sRGB、剥离 ICC、8bit）。

### 4.3 Turbo 采样 sigma（本项目的一级能力）
官方 Turbo checkpoint 的 `sample_sigmas`（已核实，来自模型仓 `model_index.json`）：

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568
```

采样时再追加 `0.0`（9 个值 = 8 步）。配 `cfg=1.0`、`sampler=euler`。
引擎把 sigma 直接作为 `torch.FloatTensor` 传给 `guider.sample`，**不需要任何 ComfyUI 节点**。

### 4.4 提示词润色（Ollama）
- 用官方 PE 系统提示词（`data/pe_system_prompt_t2i.txt` / `data/pe_system_prompt_edit.txt`）。
- 采样参数按官方：T2I `temperature1.0, top_p0.95, top_k20, min_p0, presence_penalty1.5, repetition_penalty1.0`；编辑 `presence_penalty0`。
- 要求输出 JSON `{"rewritten_prompt","wh_ratio","ratio_follow"}`；解析三级降级。

## 5. 验收标准（Lead 会跑）

1. `$PY -m pytest tests -q` 全绿。
2. ComfyUI 服务**关闭**状态下，`python scripts/run.ps1` 能起服务，`GET /api/health` 返回 `engine.ready=true`。
3. 前端被托管，资源全部 200，无 console error。
4. 真实出图：文生图 1024×1024、Turbo 8 步、原生 2K、单图编辑、局部编辑（带遮罩）各 1 张 → 尺寸符合预期。
5. 零色差：局部编辑结果遮罩外 `max_abs_diff == 0`。
6. 零偏移：`size_mode=follow` 时输出尺寸 == 输入尺寸，`align.canvas` 为 32 的倍数。
7. 提示词润色：`POST /api/polish` 返回非空 `rewritten_prompt`（Ollama 在线时 `fallback=false`）。
