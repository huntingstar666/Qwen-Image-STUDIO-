# 提示词润色（Ollama + 每模型官方 PE）

用**目标图像模型自己的** Prompt-Enhancer（PE）系统提示词，把用户随手写的中文/短提示词
改写成该模型的原生写法，同时返回宽高比建议；由本机 Ollama 吐模型，不联网。

| 图像模型 | PE 文件 | 输出形态 |
|---|---|---|
| Qwen-Image 2.1 | `data/pe_system_prompt_t2i.txt` / `pe_system_prompt_edit.txt` | `{"rewritten_prompt","wh_ratio","ratio_follow"}` |
| MOSS-Image | `data/pe_system_prompt_moss_t2i.txt` | `{"caption": "..."}` 或完整 Layout 对象（`width/height/bbox_coord_space/bbox_format/summary/items`） |

- 服务端实现：`server/ollama.py`（HTTP 客户端）、`server/prompt_polish.py`（润色逻辑）
- 静态数据：`data/pe_system_prompt_*.txt`
  （**只读**，官方 PE 原文，逐字作为 system message，不要修改/覆盖）
- 对外接口：`POST /api/polish`（由 Lead 在 `server/main.py` 实现路由，原样透传本模块返回）

## 1. 契约要点（BUILD_CONTRACT 2.3 / 4.4）

```text
POST /api/polish
body {"prompt": str, "mode": "t2i"|"edit", "model": str|null, "language": str|null,
      "image_model": "qwen"|"moss"|null,          # 目标图像模型，决定用哪份 PE
      "target_size": [w, h] | {"width","height"} | "1024x1024",   # 目标画布
      "references": [{"name":"image1","size":[w,h],"description":"..."}],  # 参考图尺寸/描述
      "images": ["data:image/png;base64,..."]}    # 可选，真正附图给视觉模型
-> {"rewritten_prompt", "wh_ratio", "ratio_follow",
    "model", "elapsed_ms", "fallback", "raw", "mode", "parse",
    "image_model", "vision"}
```

| 项 | 值 |
| --- | --- |
| Ollama 地址 | `http://127.0.0.1:11434` |
| 默认模型 | `qwen3.5:9b`（T2I 与编辑同一个，`DEFAULT_T2I_MODEL` / `DEFAULT_EDIT_MODEL`） |
| 默认超时 | 300s（首次加载模型 30~60s 很正常） |
| 端点 | `GET /api/tags`、`POST /api/show`（能力探测）、`POST /api/chat`，`stream: false` |
| 空提示词 | 不发请求，直接 `fallback=True` |
| 未知 `image_model` | 退回 `qwen`（不报错，前端传旧值不会 500） |

## 2. system / user 消息的组装

官方 PE 自己的 `Output Format` 节要求「只输出纯文本、禁止 JSON」，而工作台需要
`wh_ratio` 字段，所以**不改官方提示词原文**，改用两层结构：

| 角色 | 内容 |
| --- | --- |
| `system` | **目标模型**的 PE 原文逐字（`load_system_prompt(mode, image_model)`；测试里逐字比对） |
| `user` | `[上下文块]`（有数据才加）+ 用户原始提示词 + 空行 + JSON 输出约定 |

JSON 约定按模型二选一：

- `qwen`：`JSON_OUTPUT_CONTRACT`，要求只输出 `{"rewritten_prompt","wh_ratio","ratio_follow"}`；
- `moss`：`MOSS_JSON_CONTRACT`，要求只输出 JSON 本体。普通场景 `{"caption":"..."}`；
  需要边界框/海报/分栏时输出完整 Layout 对象。有 `target_size` 时会额外插一句
  「画布固定为 W×H，Layout 的 width/height 必须等于该值，bbox 落在 0..W / 0..H 内」。

### 2.1 为什么要把「目标尺寸 + 参考图尺寸」写进 user message

润色 LLM 看不到图片、也不知道目标画布时，会按训练数据的默认比例瞎猜（例如把方图写成 16:9），
生成阶段再硬套尺寸就必然跑偏。所以 `build_messages()` 会在 user 最前面拼一段上下文：

```text
[目标画布] 1024×1024 px（宽高比约 1.000），生成结果将按这个尺寸输出。
[参考图] 共 2 张，顺序与 <image1>…<image2> 一致：
  <image1>：1024×1024 px，内容：陶瓷茶壶放在原木桌上
  <image2>：768×1024 px
参考图内容以随消息附上的图片为准；没有附图时不要臆造画面细节。
```

`target_size` 接受 `[w,h]` / `{"width","height"}` / `"1024x1024"`；`references` 接受
`[{"name","size","description"}]` 或纯字符串列表。**system 提示词永远不掺这些内容**——
它必须是官方原文，否则测试逐字比对会失败。

### 2.2 视觉模型：能读图就附图，不能读图就显式降级

1. `POST /api/polish` 的 `images`（data URL）在 `server/main.py` 里解码成 PIL；
2. `polish()` 调 `_client_supports_vision()` → `GET /api/show`，看 `capabilities` 是否含 `vision`
   （老版本 Ollama 没有 `capabilities` 时退看 `details.families` 是否含 `vl` / `vision`）；
3. 支持 → 每张图压到最长边 **448px**、转 PNG、base64 放进 `messages[1]["images"]`，返回 `vision=true`；
4. 不支持 → 在 user content 最前面加一句
   「[注意] 当前润色模型不支持读图，只能按参考图的尺寸与文字描述工作，不要臆造画面细节。」，
   返回 `vision=false`。

能力探测抛任何异常都按「不支持」处理，**不允许因为探测失败让润色 500**。

云端（OpenAI 兼容）档案由 `OpenAICompatClient.supports_vision` 决定是否附图：

- `vision=off` 不发图；`vision=on` 强制发；
- `vision=auto`（默认）对**任意模型**先按「支持读图」发送：上游以 400 拒绝图片时自动去掉图片
  重试一次，并把该模型记入进程级「不支持」缓存，后续不再重复失败。这样以后新上线的视觉模型
  不用改代码就能读图，纯文本模型也不会反复报错；返回的 `vision` 以客户端真实发送结果为准。

配套两个 Ollama 请求参数（`OllamaClient.chat(..., format=..., think=...)`）：

- `format="json"`：Ollama 在 token 级做 JSON 语法约束，避免模型输出 markdown 代码块/前言；
- `think=false`：关掉 qwen3.5 系列的 thinking 段（原因见 §6，**这是必须的**）。

`polish()` 默认两者都开；`json_mode=False` 可关闭 JSON 约束做对比实验。

## 3. 采样参数（官方值，写在 `prompt_polish.py` 常量里）

| 参数 | T2I | 编辑 |
| --- | --- | --- |
| temperature | 1.0 | 1.0 |
| top_p | 0.95 | 0.95 |
| top_k | 20 | 20 |
| min_p | 0.0 | 0.0 |
| presence_penalty | **1.5** | **0.0** |
| repetition_penalty | 1.0 | 1.0 |
| num_predict | 4096 | 4096 |

编辑模式的 `presence_penalty` 是 0（不是 1.5），抄错会导致编辑指令发散，测试里有断言。

`num_predict` 是工作台的输出预算（不属于官方 PE 参数）。思考型模型会先消耗推理 token，
2048 经常被推理吃满、正文为空；因此默认给到 4096，云端客户端还会在
`finish_reason=length` 且只有 `reasoning_content` 时按 2 倍追加预算重试
（上限 `HARD_MAX_TOKENS=8192`）。云端档案的 `max_tokens` 默认也从 2048 提到 4096，
历史配置在加载时做一次性迁移；用户在设置里把「最大输出」调得更大时，会作为预算下限生效，
不会被采样常量压回去。

## 4. 三级解析降级（`parse_polish_output`）

返回值里 `parse` 字段标明落在哪一级：

1. `json`：整段就是合法 JSON（自动剥离 ```json 代码围栏；若 JSON 解析结果是字符串，也当作正文）；
2. `braces`：截取首个 `{` 到末个 `}` 再解析（模型加了「好的，结果如下：…」这类前言时）；
3. `text`：整段文本原样当 `rewritten_prompt`（官方 PE 的原生输出格式，永远可用），`wh_ratio` / `ratio_follow` 留空。

字段容错：`wh_ratio` 接受 `wh_ratio` / `aspect_ratio` / `ratio`，只保留 `数字:数字` 形式
（`" 16 : 9 "` → `"16:9"`，`"wide"` → 空串）；`ratio_follow` 只保留 `<imageN>` 形式
（`image2` 这种不带尖括号的丢弃）；正文接受 `rewritten_prompt` / `rewritten` / `prompt` / `text`。

按模式收口：**T2I 只返回 `wh_ratio`，编辑只返回 `ratio_follow`**——模型偶尔跨模式多填，
这里统一清空另一端，前端不会拿错字段。

`image_model="moss"` 时字段映射换成 `_from_moss_mapping()`：

| 模型输出 | `rewritten_prompt` |
|---|---|
| `{"caption":"..."}` | `caption` 原文（`wh_ratio` / `ratio_follow` 为空） |
| 带 `items` 且含 `bbox_coord_space` / `bbox_format` 的 Layout | `json.dumps(..., ensure_ascii=False, separators=(",",":"))` 的**紧凑 JSON 字符串** |
| 其他（模型没按约定输出） | 退回通用映射（`rewritten_prompt` / `prompt` / `text`…） |

Layout 之所以原样序列化，是因为 MOSS 的布局节点吃的就是这个紧凑 JSON 字符串；
再包一层 `{"rewritten_prompt": ...}` 反而要二次解包。**`wh_ratio` 对 MOSS 恒为空**，
画幅由 `target_size` 直接决定。

## 5. fallback 语义（契约要求：Ollama 挂了不许 500）

| 场景 | 行为 |
| --- | --- |
| Ollama 未启动 / 连接拒绝 / 超时 | `fallback=True`，`rewritten_prompt` = 原提示词，`raw=""`，`error` 带原因 |
| HTTP 4xx/5xx、响应缺 `message.content` | 同上 |
| 模型返回空 content | `fallback=True`，返回原提示词，保留 `raw`（空串）与 `error` |
| 模型输出解析不出正文 | 同上 |
| 模型输出纯文本（第三级降级） | `fallback=False`（成功用了模型输出），`parse="text"` |
| 空提示词 | 不发请求，`fallback=True` |
| `fallback=False` 且调用失败 | 抛 `OllamaError`（非 Ollama 异常也会包成 `OllamaError`） |
| `mode` 非法 | **始终** `ValueError`（唯一允许抛的异常） |

`raw` 永远保留模型的原始返回，方便前端/排查查看「模型到底说了什么」。

## 6. 实测踩到的两个坑（重要）

### 6.1 qwen3.5:9b 先吐 thinking，会把 `num_predict` 吃光、content 为空

首版没关 thinking，实测：

```text
POST /api/chat  model=qwen3.5:9b  options.num_predict=2048
响应: eval_count=2048  total_duration≈11.9s  message.content=""（长度 0）
```

模型把 2048 个 token 全用在 thinking 上，`done_reason=length`，正文一个字都没写。
三种消息布局（JSON 约定放 system、放 user、加 `format="json"`）在没关 thinking 时全部复现空 content。

**修复**：请求体加顶层 `"think": false`（Ollama ≥ 0.5 支持）。耗时也立刻从 ~11s 降到
~2s，且不再有被 thinking 吃光的风险。`OllamaClient.chat()` 为此多了可选 `think`
参数（默认 `None` 不发送，向后兼容契约 2.3 的签名），`polish()` 始终传 `False`。

### 6.2 官方 PE 要纯文本，工作台要 JSON

官方 PE 的 Output Format 明确禁止 JSON；直接加 `format="json"` 又会和 system 里的
「No JSON, no braces」打架。最终做法：官方原文不动，把 JSON 约定追加到 **user message
末尾**并声明「优先于上文 Output format」，同时开 `format="json"` 双保险。实测模型
稳定输出合法 JSON，且 `rewritten_prompt` 内容仍完全遵守 PE 的写法规则。

## 7. 真实调用记录（本机实测）

环境：Windows，Ollama 已运行于 `http://127.0.0.1:11434`，模型 `qwen3.5:9b`（6.1GB），
Python `<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe`。

| # | mode | 输入 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | t2i | `一只戴墨镜的橘猫坐在霓虹灯下的复古摩托车座上，赛博朋克夜景` | **8.5s**（冷启动，首次加载模型，`total_duration=8.5s`、`eval_count=726`） | 纯文本段落 1878 字符（当时还没加 JSON 约束，验证 PE 原文可用） |
| 2 | t2i | 同上 | **1.85s / 1850ms** | `parse=json`、`fallback=false`、`wh_ratio=16:9`，改写结果 1450 字符 |
| 3 | edit | `把背景换成雪山日落，人物衣服改成红色羽绒服` | **0.40s / 398ms** | `parse=json`、`fallback=false`、`wh_ratio=""`（编辑模式已收口）、改写结果 67 字符 |
| 4 | t2i | `一只戴草帽的柯基趴在木船上` | **1.85s / 1852ms** | `parse=json`、`fallback=false`、`wh_ratio=3:2`，改写 1350 字符 |

结果摘要（截断）：

- #2 输出开头：`A wide cinematic scene of a cyberpunk night cityscape where an orange cat wearing black sunglasses sits atop the seat of a vintage motorcycle under neon lights...`
- #3 输出开头：`将背景替换为雪山日落场景，确保人物身穿红色羽绒服，保留原有人物的面部特征和身份，保持其他所有细节不变...`
- #4 输出开头：`The image is a wide photorealistic photograph of a Corgi dog wearing a straw hat resting on an overturned wooden rowboat...`

结论：热态单次 0.4~1.9s，冷启动 8.5s；300s 超时对首字加载绰绰有余。降级路径另测：
指向 `http://127.0.0.1:59999`（无服务）时 2.0s 内返回 `fallback=True` + 原提示词，未抛异常。

## 8. 用法

```python
from server.prompt_polish import polish, available_models, pick_default_model

models = available_models()               # Ollama 挂了返回 []，不抛异常
model = pick_default_model()              # 优先 qwen3.5:9b，否则任一 qwen 模型

# Qwen：拿长提示词 + 画幅建议
result = polish("一只猫", mode="t2i", model=model, timeout=300)
print(result["rewritten_prompt"], result["wh_ratio"], result["fallback"], result["elapsed_ms"])

# MOSS：拿 caption 或 Layout JSON，并告诉它目标画布与参考图尺寸
moss = polish(
    "做一张清凉一夏的夏日海报，少女在草地上跳跃",
    mode="t2i", model=model, image_model="moss",
    target_size=(1024, 1536),
    references=[{"name": "image1", "size": (1024, 1024), "description": "蓝白条纹的连衣裙"}],
    reference_images=[pil_image],         # 可选；视觉模型才会真正看到图
)
print(moss["rewritten_prompt"], moss["parse"], moss["vision"])
```

```bash
curl -X POST http://127.0.0.1:8700/api/polish \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只戴墨镜的橘猫","mode":"t2i","model":null,"language":null}'

# MOSS + 目标画布
curl -X POST http://127.0.0.1:8700/api/polish \
  -H "Content-Type: application/json" \
  -d '{"prompt":"清凉一夏海报","mode":"t2i","image_model":"moss","target_size":[1024,1536]}'
```

`GET /api/health` 里的 `ollama.models` 可直接用 `available_models()` / `OllamaClient.model_names()`；
`OllamaClient.is_alive()` 用 5s 短超时且永不抛异常，适合 5s 轮询。

## 9. 测试

```bash
$PY -m pytest tests/test_prompt_polish.py -q        # 40 passed
$PY -m pytest tests/test_moss_profile.py -q         # MOSS PE 独立 + 尺寸注入 + caption/Layout 解析
$PY tests/test_prompt_polish.py                     # 无 pytest 时也可直接跑（文件末尾自跑块）
```

覆盖点：官方 system 原文逐字比对、三级降级、JSON 围栏/别名/比例清洗、按模式收口、
两种模式的采样参数（含 edit `presence_penalty=0`）、`think=false`/`format=json` 请求体、
各种失败 fallback、`fallback=False` 抛错、非法 mode、空提示词不发请求、契约签名、
`OllamaClient` 的请求体/错误收敛/`/api/tags` 规整。

MOSS 额外覆盖：两份 PE 互相独立（`load_system_prompt("t2i","moss") != ("t2i","qwen")`）、
`build_messages` 注入 `[目标画布]`、`{"caption":...}` 与 Layout 两种输出的解析。
**所有测试都用注入的假 client / 假 session，不发真实网络请求。**

## 10. 边界

- 不修改 `data/pe_system_prompt_*.txt`（只读，测试会逐字比对文件与 `load_system_prompt()`）。
- 不调用 ComfyUI、不生成图片（显存留给端到端测试）。
- `language` 参数目前是预留位（透传不报错）：输出语言由官方 PE 自己判定——Qwen T2I 恒英文、
  编辑按指令语言判定，强改会和 PE 规则冲突。
- MOSS 只有 `pe_system_prompt_moss_t2i.txt` 一份 PE，`mode="edit"` 也复用它；
  但 MOSS 的参考图编辑本轮未接入，前端不应把 `edit` + `moss` 组合当可用能力。
- `MOSS_JSON_CONTRACT` 里的画布规则只有拿到 `target_size` 才会插入；没传就别指望模型自己给出正确 `width/height`。
- 模型可换：`qwen3.5:27b` 质量更高但更慢；换非 qwen 模型时 `think=false` 一般也无害。

## 11. 与生图链路的注入边界（2026-11-09 只读核对）

核对结论：润色与生图是两条独立通道，**润色结果不会被后端自动注入生图请求**。

1. **润色**：`/api/polish` 只返回 `rewritten_prompt / wh_ratio / ratio_follow` 给前端；
   用户点「采用润色」后才写回提示词框，再随 `/api/generate`、`/api/edit` 正常提交。
2. **生图侧后端只做三类追加**（都不改 system）：
   - 任务训练指令前置（移除 / 扩图 / 全景），按 `meta.rawPrompt`（风格拼接前的原文）判重；
   - 去水印补全（文字 + 徽章 + 编号），原文已点名则不补；
   - 姿态人偶图成为 `image1` 时，`<imageN>` 编号统一顺延。
3. **风格 / 镜头 / 滤镜**由前端 `stylePicker.composePrompt()` 拼在提示词尾部，
   后端不做二次改写；因此 `rawPrompt` 与最终 prompt 是两件事，判重只看前者。
4. **提示词注入风险**：用户文本与参考图文件名 / 描述会原样进入润色 user message，
   可能影响改写结果；但该通道没有工具调用、不读本地文件、不回传 Key，
   最坏结果是「改写得不符合预期」，由用户决定是否采纳。生图模型只接收正 / 负提示词与参考图，
   不接收润色 system prompt。
5. **失败路径**：Ollama / 云端不可用、超时、空内容、解析失败均回退原提示词（详见 §5），
   不会因为润色失败阻断出图。
