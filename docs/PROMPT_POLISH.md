# 提示词润色（Ollama + Qwen 官方 PE）

用 Qwen-Image 官方 Prompt-Enhancer（PE）系统提示词，把用户随手写的中文/短提示词
改写成官方风格的完整提示词，同时返回宽高比建议；由本机 Ollama 吐模型，不联网。

- 服务端实现：`server/ollama.py`（HTTP 客户端）、`server/prompt_polish.py`（润色逻辑）
- 静态数据：`data/pe_system_prompt_t2i.txt`、`data/pe_system_prompt_edit.txt`
  （**只读**，10KB 左右，官方 PE 原文，逐字作为 system message，不要修改/覆盖）
- 对外接口：`POST /api/polish`（由 Lead 在 `server/main.py` 实现路由，原样透传本模块返回）

## 1. 契约要点（BUILD_CONTRACT 2.3 / 4.4）

```text
POST /api/polish
body {"prompt": str, "mode": "t2i"|"edit", "model": str|null, "language": str|null}
-> {"rewritten_prompt", "wh_ratio", "ratio_follow",
    "model", "elapsed_ms", "fallback", "raw", "mode"}
```

| 项 | 值 |
| --- | --- |
| Ollama 地址 | `http://127.0.0.1:11434` |
| 默认模型 | `qwen3.5:9b`（T2I 与编辑同一个，`DEFAULT_T2I_MODEL` / `DEFAULT_EDIT_MODEL`） |
| 默认超时 | 300s（首次加载模型 30~60s 很正常） |
| 端点 | `GET /api/tags`、`POST /api/chat`，`stream: false` |
| 空提示词 | 不发请求，直接 `fallback=True` |

## 2. system / user 消息的组装

官方 PE 自己的 `Output Format` 节要求「只输出纯文本、禁止 JSON」，而工作台需要
`wh_ratio` 字段，所以**不改官方提示词原文**，改用两层结构：

| 角色 | 内容 |
| --- | --- |
| `system` | `data/pe_system_prompt_*.txt` **原文逐字**（见 `load_system_prompt()`；测试里逐字比对） |
| `user` | 用户原始提示词 + 空行 + `JSON_OUTPUT_CONTRACT`（声明工作台输出约定优先于上文 Output format，要求只输出 `{"rewritten_prompt","wh_ratio","ratio_follow"}`） |

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
| num_predict | 2048 | 2048 |

编辑模式的 `presence_penalty` 是 0（不是 1.5），抄错会导致编辑指令发散，测试里有断言。

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
result = polish("一只猫", mode="t2i", model=model, timeout=300)
print(result["rewritten_prompt"], result["wh_ratio"], result["fallback"], result["elapsed_ms"])
```

```bash
curl -X POST http://127.0.0.1:8700/api/polish \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只戴墨镜的橘猫","mode":"t2i","model":null,"language":null}'
```

`GET /api/health` 里的 `ollama.models` 可直接用 `available_models()` / `OllamaClient.model_names()`；
`OllamaClient.is_alive()` 用 5s 短超时且永不抛异常，适合 5s 轮询。

## 9. 测试

```bash
$PY -m pytest tests/test_prompt_polish.py -q        # 40 passed
$PY tests/test_prompt_polish.py                     # 无 pytest 时也可直接跑（文件末尾自跑块）
```

覆盖点：官方 system 原文逐字比对、三级降级、JSON 围栏/别名/比例清洗、按模式收口、
两种模式的采样参数（含 edit `presence_penalty=0`）、`think=false`/`format=json` 请求体、
各种失败 fallback、`fallback=False` 抛错、非法 mode、空提示词不发请求、契约签名、
`OllamaClient` 的请求体/错误收敛/`/api/tags` 规整。**所有测试都用注入的假 client /
假 session，不发真实网络请求。**

## 10. 边界

- 不修改 `data/pe_system_prompt_*.txt`（只读，测试会逐字比对文件与 `load_system_prompt()`）。
- 不调用 ComfyUI、不生成图片（显存留给端到端测试）。
- `language` 参数目前是预留位（透传不报错）：输出语言由官方 PE 自己判定——T2I 恒英文、
  编辑按指令语言判定，强改会和 PE 规则冲突。
- 模型可换：`qwen3.5:27b` 质量更高但更慢；换非 qwen 模型时 `think=false` 一般也无害。
