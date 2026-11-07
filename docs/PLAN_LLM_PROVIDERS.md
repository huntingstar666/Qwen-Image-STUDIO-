# 全局设置：接入 OpenAI 兼容云端大模型（设计方案）

> 状态：**已实施**（`server/llm_client.py`、`server/config.py`、`server/main.py`、
> `web/src/components/settings.js`）。本文保留为方案与接口契约说明。
> 范围：仅覆盖「提示词润色」链路（`/api/polish`），不涉及出图引擎。
> 相关文档：[PROMPT_POLISH.md](./PROMPT_POLISH.md)、[WEB_UI.md](./WEB_UI.md)、
> [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 现在支持什么 | 只有本机 Ollama：`server/main.py` 里直接 `OllamaClient(base_url=cfg["ollama_url"])` |
| 要支持什么 | 任何 OpenAI 兼容接口：OpenAI、DeepSeek、百炼兼容模式、SiliconFlow、vLLM、LM Studio、One API / New API 网关 |
| 配置怎么存 | `config.json` 增加 `llm_profiles[]` + `llm_active`，保留旧 `ollama_url/ollama_model` 做兼容回写 |
| 协议怎么适配 | 新增 `OpenAICompatClient`，实现与 `OllamaClient` 相同的 `chat / list_models / supports_vision / is_alive` 四个方法，`prompt_polish` 不用改协议 |
| 界面怎么放 | 「AI 模型」分区改成「服务列表 + 编辑卡片」，顶部按 Ollama / OpenAI 兼容切换 |
| Key 怎么处理 | 读接口只返回 `has_key`/`key_hint`，永不回明文；日志一律打码；支持环境变量引用 |
| 怎么判断「能用」 | 测试连接 = 列模型 + 一次 8 token 的最小对话；只测 `/models` 不能证明有推理权限 |
| 云端费用怎么控 | 参考图默认不随云端请求发送；高级项里显式开启并给费用提示 |
| 兼容性 | 旧配置无感迁移；`/api/health` 的 `ollama` 字段保留；`/api/ollama/test` 保留为别名 |

---

## 1. 现状盘点

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `server/config.py` `DEFAULTS` | 只有 `ollama_url`、`ollama_model` | 无多服务概念 |
| `server/ollama.py` | `OllamaClient`：`list_models / model_names / chat / show / supports_vision / is_alive` | 协议是 Ollama 原生（`/api/chat`、`/api/tags`、`/api/show`），不能直连云端 |
| `server/prompt_polish.py` | `polish(..., client=...)` 只依赖 `client.chat` 与 `client.supports_vision`；`_call_model` 会带 `think=False` | 适配面很小，适合做「同接口、两实现」 |
| `server/main.py` `api_polish` | 每次请求 `OllamaClient(base_url=cfg["ollama_url"])` | 换服务必须改这里 |
| `server/main.py` `_ollama_health` | 10s 缓存探测 `/api/tags` | 云端需要区分「网络不通 / Key 无效 / 无推理权限」 |
| `server/main.py` `_settings_view` | 返回 `ollama_url/ollama_model/connected/models/error` | 前端模型选择器只认这一个源 |
| `web/src/components/settings.js` | 「AI 模型」只有地址 + 模型下拉 + 测试 | 无法管理多服务、无 Key 输入、无隐私说明 |
| `web/src/app.js` 顶栏 | 胶囊固定写「Ollama」，模型下拉来自健康检查 | 切换云端后文案与状态都不对 |
| `web/src/store.js` | `polishModel` 存在 localStorage | 与后端真实配置可能不一致 |

---

## 2. 目标与非目标

### 2.1 目标

1. 在「设置 → AI 模型」中管理 **多个** 模型服务，至少一个 Ollama、若干 OpenAI 兼容服务。
2. 每个服务可配置：名称、协议类型、Base URL、API Key（或环境变量名）、模型、超时、最大输出、JSON 模式、视觉能力、是否随图发送参考图。
3. 可「测试连接」，并区分：网络不可达 / 证书错误 / Key 无效 / 模型不存在 / 无推理权限 / 限流。
4. 可「设为当前」；顶栏显示当前服务名与模型，并可快速切换模型。
5. 旧配置、旧接口、旧脚本全部继续可用。
6. Key 不明文回显、不进日志、不出现在 DOM 属性里。

### 2.2 非目标

- 不做多租户 / 账号体系 / 云端同步（本项目是本机工具）。
- 不做流式输出与用量计费统计（可作为后续迭代）。
- 不改图像生成模型的选择逻辑（`model_defaults` 保持原样）。
- 不引入第三方 SDK，统一用现有 `requests`。

---

## 3. 配置数据模型

### 3.1 新增字段

```jsonc
{
  "llm_active": "local-ollama",
  "llm_profiles": [
    {
      "id": "local-ollama",              // 前端生成（crypto.randomUUID），只允许 [a-z0-9-]
      "name": "本机 Ollama",              // 展示名，≤ 40 字
      "kind": "ollama",                  // ollama | openai
      "base_url": "http://127.0.0.1:11434",
      "api_key": "",                     // 仅 openai；落盘明文，读接口脱敏
      "api_key_env": "",                 // 可选，如 "OPENAI_API_KEY"；优先于 api_key
      "model": "qwen3.5:9b",
      "timeout_s": 300,                  // 5–600
      "max_tokens": 2048,                // 64–8192
      "json_mode": true,                 // 请求 response_format=json_object
      "vision": "auto",                  // auto | on | off
      "send_reference_images": true,     // 云端建议默认 false
      "extra_headers": {}                // 可选，≤ 6 条 KV，兼容企业网关 X-* 鉴权
    }
  ]
}
```

- `models`（可用模型列表）只做运行时缓存，**不写入 config.json**。
- 最多 6 个 profile；`id` 唯一；`llm_active` 必须指向已存在的 profile。
- `base_url` 去掉尾部 `/`；`kind=openai` 时若用户填了 `https://api.openai.com`，自动补 `/v1`（仅在默认域名上做，避免误改网关路径）。

### 3.2 迁移与回写

在 `server/config.py` 的 `load_config()`（以及 `DEFAULTS` 合并处）加规范化：

1. 若 `llm_profiles` 为空 → 用旧键合成一条：
   ```jsonc
   {"id":"local-ollama","name":"本机 Ollama","kind":"ollama",
    "base_url": cfg.ollama_url || DEFAULT_BASE_URL,
    "model": cfg.ollama_model || "", ...}
   ```
   并令 `llm_active = "local-ollama"`。
2. `POST /api/settings` 保存后：
   - 若激活 profile 的 `kind == "ollama"`，把其 `base_url/model` 回写到顶层 `ollama_url/ollama_model`；
   - 若不是 ollama，则顶层旧键保持上一次的 ollama 值不动（避免别的脚本误读成云端地址）。
3. `api_key` 的保存语义（与前端约定）：
   - `null` / 字段缺省 → 保持原值
   - `""` → 清除
   - 其他字符串 → 覆盖

---

## 4. 后端设计

### 4.1 模块划分

| 文件 | 职责 |
| --- | --- |
| `server/llm_client.py`（新增） | `make_client(cfg, profile_id=None)` 工厂；`OpenAICompatClient`；`LLMConfigError` |
| `server/prompt_polish.py` | 不改调用协议；`polish()` 返回值补 `provider`/`profile` 便于排查 |
| `server/main.py` | `_llm_health()` 替代 `_ollama_health()`；`api_polish` 用工厂；`/api/llm/test`；settings 校验 |
| `server/config.py` | 默认值、迁移、白名单校验函数 |
| `web/**` | 见 §5 |

`make_client` 返回的对象必须满足 `prompt_polish` 的最小接口：

```python
client.chat(model, messages, *, think=False, temperature=..., top_p=..., ...) -> str
client.supports_vision(model) -> bool
```

### 4.2 OpenAI 兼容协议映射

| 能力 | 实现 |
| --- | --- |
| 鉴权 | `Authorization: Bearer {api_key}`；`api_key_env` 非空时从 `os.environ` 读取 |
| 列模型 | `GET {base_url}/models`；连接/超时 8s。404/405 视为「不支持列举」，返回 `[]` 且不报错 |
| 对话 | `POST {base_url}/chat/completions`，`messages` 直传 system/user |
| 采样参数 | `temperature`、`top_p`、`presence_penalty`、`max_tokens` 直传；`top_k`、`min_p`、`repetition_penalty` 丢弃 |
| JSON | `json_mode=true` → `response_format={"type":"json_object"}`；若返回 400 且错误信息提到该字段，去掉后重试一次 |
| 思考抑制 | `think=False` 仅对 Ollama 有意义，OpenAI 适配器忽略 |
| 返回解析 | 取 `choices[0].message.content`；为空且存在 `reasoning_content` 时返回明确错误「模型只返回了推理内容，请换非推理模型或关闭思考」 |
| 超时 | `(connect=10s, read=profile.timeout_s)`，用 `requests` 的 `timeout=(10, timeout_s)` |
| 代理 | 沿用 `requests` 默认环境变量（`HTTPS_PROXY`），不额外接管 |

**错误映射**（统一成 `LLMError(code, message, hint)`）：

| 上游表现 | code | 文案 / 建议 |
| --- | --- | --- |
| 401 / 403 | `auth_failed` | API Key 无效或无权限，请检查 Key 与服务商区域 |
| 404 | `not_found` | 地址或模型不存在，请检查 Base URL 是否带 `/v1`、模型名是否正确 |
| 429 | `rate_limited` | 触发限流，请稍后重试或提升配额 |
| 5xx | `upstream_error` | 服务商异常（附响应前 200 字） |
| DNS / 连接拒绝 | `unreachable` | 无法连接，请检查网络、代理与地址 |
| SSL 证书 | `tls_error` | 证书校验失败，检查代理或企业网关 |
| 超时 | `timeout` | 超过 {n}s 未返回，可在高级项调大超时 |

**Key 脱敏**：`_mask_key("sk-abcdef123456") -> "sk-…3456"`；日志中 `Authorization` 恒为 `Bearer ***`。

### 4.3 视觉与参考图

- 现状：`api_polish` 把参考图解码后交给 `polish()`，后者在 `_client_supports_vision()` 通过时以 `messages[1]["images"]` 发送（Ollama 格式）。
- OpenAI 适配器在 `chat()` 内做转换：
  ```jsonc
  {"role":"user","content":[
    {"type":"text","text":"<原 user 文本>"},
    {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}
  ]}
  ```
  图片统一转 JPEG（质量 85）以降低 token 与带宽。
- 是否发送由三层共同决定：
  1. `profile.vision`（`off` 直接不发；`on` 直接发；`auto` 用模型名启发式判断：`gpt-4o / gpt-4.1 / qwen-vl / qwen2.5-vl / claude / gemini / glm-4v / internvl / llava`）；
  2. `profile.send_reference_images`（云端默认 `false`）；
  3. 请求是否真的带了图片。
- 不发起「视觉能力探测」请求，避免额外费用。

### 4.4 API 契约

#### `GET /api/settings`（在现有结构上扩展 `llm`）

```jsonc
"llm": {
  "active": "local-ollama",
  "profiles": [
    {
      "id": "local-ollama", "name": "本机 Ollama", "kind": "ollama",
      "base_url": "http://127.0.0.1:11434",
      "model": "qwen3.5:9b",
      "timeout_s": 300, "max_tokens": 2048, "json_mode": true,
      "vision": "auto", "send_reference_images": true,
      "has_key": false, "key_hint": "",
      "models": ["qwen3.5:9b"], "connected": true, "error": null
    }
  ],
  // 兼容字段，等前端迁移完再删
  "ollama_url": "http://127.0.0.1:11434",
  "ollama_model": "qwen3.5:9b",
  "connected": true,
  "models": ["qwen3.5:9b"],
  "error": null
}
```

#### `POST /api/settings`

新增可写字段：`llm_active`、`llm_profiles`。校验规则：

- `kind ∈ {ollama, openai}`；`base_url` 必须以 `http://`/`https://` 开头且能解析出 host；
- `kind=openai` 且既无 `api_key`、无 `api_key_env`、也无历史已保存 Key → 保存允许，但返回警告位 `llm_warnings[]`（前端标黄）；
- `model` 允许空（未选模型），但测试连接会提示；
- `timeout_s`、`max_tokens` 越界直接 400；
- 删除当前激活 profile → 自动改为第一个剩余 profile；若删空 → 拒绝（至少保留一个）。

响应沿用：`{"ok": true, "released": n, **settings_view}`。

#### `POST /api/llm/test`

请求（二选一）：

```jsonc
// A. 已保存的服务
{"profile_id": "deepseek"}

// B. 未保存的表单（[保存并测试] 前）
{"profile": {"kind":"openai","base_url":"https://api.deepseek.com/v1",
             "api_key":"sk-...","model":"deepseek-chat","timeout_s":30},
 "api_key_unchanged": true}
```

响应：

```jsonc
{"ok": true, "connected": true, "list_ok": true, "chat_ok": true,
 "latency_ms": 320, "models": ["deepseek-chat","deepseek-reasoner"],
 "model_found": true, "vision": "auto",
 "error_code": null, "error": null, "hint": null}
```

- 先列模型（失败不致命，`list_ok=false`），再做最小对话：`messages=[{"role":"user","content":"ping"}]`，`max_tokens=8`。
- 400/401 等返回 **HTTP 200** + `ok=false`，让前端统一渲染（与现有 `/api/ollama/test` 行为一致）。
- `/api/ollama/test` 保留，内部转调 `/api/llm/test`，仅接受 `{url}`。

#### `GET /api/health`

保留 `ollama` 字段不变，新增 `llm`：

```jsonc
"llm": {"active":"local-ollama","name":"本机 Ollama","kind":"ollama",
        "model":"qwen3.5:9b","connected":true,"models":[…],"error":null}
```

- 探测缓存：本机 10s，云端 60s；
- 连续 401 → 熔断 5 分钟，只回缓存错误，不再请求上游。

#### `POST /api/polish`

- 请求体新增可选 `provider`（profile id）与 `model`；缺省用 `llm_active`。
- 响应新增 `provider`、`profile_name`，便于前端 toast 与日志定位。

### 4.5 安全

1. `GET /api/settings` 永不返回 `api_key` 明文；只返回 `has_key` 与 `key_hint`（末 4 位）。
2. 日志、异常信息、`/api/llm/test` 回包都不含 Key；`ApiError` 文案统一经 `_scrub_secrets()`。
3. 配置写入后设置文件权限（Windows 依赖 NTFS 默认 ACL，README 注明「不要把 config.json 提交到仓库」）。
4. 前端 Key 输入框 `type=password`，`autocomplete="new-password"`，不写入 localStorage。
5. 若填写 `api_key_env`，则优先使用环境变量，`api_key` 字段可留空。

---

## 5. 前端设计

### 5.1 「AI 模型」分区结构

```
AI 模型
┌ 已配置的服务 ─────────────────────────────┐
│ ● 本机 Ollama      ollama   ✓ 已连接   ›   │
│ ○ DeepSeek        openai   ! 401      ›   │
│ + 添加模型服务                              │
└───────────────────────────────────────────┘
┌ 编辑「DeepSeek」 ──────────────────────────┐
│ 服务类型   [ 本机 Ollama | OpenAI 兼容 ]    │  ← 新建时出现，之后只读徽标
│ 名称       [DeepSeek                      ] │
│ 接口地址   [https://api.deepseek.com/v1   ] │
│ API Key    [•••••••••••   👁] 已保存 sk-…9f2c│
│            □ 使用环境变量 [OPENAI_API_KEY ] │
│ 模型       [deepseek-chat              ▾]  │  ← 可手动输入
│ 高级  ▸    超时 / 最大输出 / JSON / 视觉 / 发参考图 │
│ [测试连接]   延迟 320ms · 模型 12 个 · 对话 ✓ │
└───────────────────────────────────────────┘
```

- 服务列表每行：状态点（绿=已连接 / 灰=未测试 / 红=错误）、名称、`kind` 徽标、当前使用标记（或「设为当前」按钮）、右箭头。
- 删除：行内次要按钮，二次确认；删除当前服务时提示会回退到哪个服务。
- 新建：先选类型，再进入编辑卡片；未保存前不进入列表。
- 隐私提示固定放在分区底部（不可折叠）：
  > 使用云端服务时，提示词会发送到你填写的服务商；开启「随图发送参考图」后，参考图也会一并上传并可能产生图像输入费用。

### 5.2 交互细节

| 场景 | 行为 |
| --- | --- |
| 地址输入 | `blur` 时去掉尾部 `/`；`kind=openai` 且为空时填入 `https://api.openai.com/v1` 占位 |
| 模型下拉 | Ollama：健康检查返回列表；OpenAI：`<input list>` + `<datalist>`，允许手输；旁边「刷新」按钮重新拉 `/models` |
| 测试连接 | 禁用按钮 + loading；结果卡显示 延迟 / 模型数 / 对话是否成功 / 错误建议；失败不清空已填内容 |
| Key 已保存 | 输入框空 + 占位「已保存 sk-…9f2c，留空表示不修改」；点「清除」才真正传 `""` |
| 保存 | 有脏数据时关闭浮层需确认（复用现有 `attemptClose`） |
| 设为当前 | 立即 `POST /api/settings {llm_active}`，并刷新顶栏；不关闭设置页 |
| 切换当前服务的模型（顶栏） | 写回该 profile 的 `model`（不再只写 localStorage） |

### 5.3 顶栏联动（`web/src/app.js`）

- 胶囊文案：`AI 模型` → 优先显示激活服务名（过长截断），`title` 显示 `kind · base_url · model`。
- 下拉：激活服务的 `models`；若为空则显示当前 `model`；选择后写回后端。
- 状态点沿用：绿=connected、黄=有配置未连通、灰=未配置；点击胶囊 → `openSettings('llm')`。

### 5.4 文案与样式

- i18n：新增 `settings.llm.*` 键（`title / add / test / testing / setActive / active / privacy / advanced / apiKey / apiKeySaved / apiKeyEnv / vision / sendImages / deleteConfirm` 等），中英同步。
- 样式：复用 `settings.css` 现有 `.set-card / .set-row / .set-seg / .set-input / .set-details`；新增 `.llm-profile-list / .llm-profile-row / .llm-badge / .llm-status-dot / .llm-test-result`，颜色全部走主题变量，暗色与强调色自动适配。
- 移动端：服务列表与编辑卡片纵向堆叠，高度不超过浮层内容区，内部滚动。

---

## 6. 兼容与降级

1. 旧 `ollama_url/ollama_model` 仍可读写；`/api/health.ollama`、`/api/ollama/test` 保留。
2. 润色失败仍回退原始提示词（现有 `fallback` 行为不变），但错误 toast 需要可执行：
   - `auth_failed` → 「Key 无效，去设置 → AI 模型更新」
   - `unreachable` → 「无法连接到 xxx，请检查网络或代理」
   - `timeout` → 「模型响应超时，可在高级项调大超时」
3. 云端默认 `send_reference_images=false`，避免用户不知情产生图像费用；Ollama 默认保持 `true`（与现状一致）。
4. `store.polishModel` 保留为顶栏临时覆盖，但以服务端配置为准；保存设置后清空该覆盖，避免"界面显示 A、实际走 B"。

---

## 7. 测试与验收

### 7.1 自动化

| 类型 | 用例 |
| --- | --- |
| 单测 · 适配器 | messages 文本/图片转换；采样参数裁剪；`json_mode` 400 重试；`choices[0].message.content` 为空时的报错；401/404/429/超时错误码映射 |
| 单测 · 配置 | 旧配置迁移；`api_key` 的 null/空/覆盖语义；范围校验；删除激活服务后的回退 |
| 单测 · 脱敏 | `GET /api/settings` 不含明文 Key；日志与异常文本不含 Key |
| 集成 | 用本地假 OpenAI 服务（临时 HTTP server）跑通 `/api/llm/test` 与 `/api/polish`，断言请求体字段 |
| 前端 | Playwright：新建 → 测试失败/成功 → 设为当前 → 顶栏更新 → 删除回退 |

### 7.2 人工验收清单

- [ ] 旧 `config.json` 启动无报错，顶栏润色可用，设置页自动出现「本机 Ollama」。
- [ ] 新增 OpenAI 兼容服务：错误 Key → `auth_failed` 提示；错误域名 → `unreachable`；正确配置 → 测试显示延迟与模型数。
- [ ] 切换激活服务后，`/api/polish` 实际走新服务（假网关验证）。
- [ ] Key 在 GET 响应、日志、DOM 中均不可见。
- [ ] 删除当前服务后自动回退，顶栏与设置页一致。
- [ ] 暗色 / 英文 / 390px 宽度下布局正常。

---

## 8. 实施顺序（供排期）

| 阶段 | 内容 | 可独立验证 |
| --- | --- | --- |
| 1 | `config.py`：字段、迁移、校验（不动 UI） | 旧配置加载 + settings 读写 |
| 2 | `llm_client.py`：`OpenAICompatClient` + 工厂 + 错误模型 | 单测 + 假网关 |
| 3 | `main.py`：`_llm_health`、`api_polish`、`/api/llm/test` | curl 三接口 |
| 4 | `settings.js` + `api.js` + `settings.css`：AI 模型分区 | 浏览器走查 |
| 5 | `app.js` 顶栏联动 + i18n | 切服务后润色 |
| 6 | 回归：旧 Ollama 链路、其他设置分区 | 全量验收 |

---

## 9. 默认取舍（已按商业化习惯选定，可再改）

| 待定项 | 建议默认 | 理由 |
| --- | --- | --- |
| 云端是否默认发送参考图 | **否** | 避免用户不知情产生图像输入费用 |
| 新服务默认超时 | 60s（Ollama 保持 300s） | 云端通常更快，超时过长会让人误以为卡死 |
| `json_mode` 默认 | 开 | 润色输出是结构化 JSON，失败会自动降级重试 |
| 是否允许保存未测试的服务 | 允许，但列表标黄 | 便于先填后配；不阻塞流程 |
| 是否支持自定义 Header | 高级项里留一个 KV 输入（≤ 6 条） | 兼容企业网关的 `X-*` 鉴权头 |
| Key 存储方式 | 本机明文 + 环境变量可选 | 本机工具优先可用性；README 提示勿提交仓库 |
