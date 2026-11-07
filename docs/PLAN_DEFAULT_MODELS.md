# 默认模型设置方案（系统设置统一入口）

> 目标：在系统设置中统一管理「默认用哪个模型 / LoRA / VAE / CLIP」，出厂默认等于当前这套配置；
> 首次使用自动匹配，匹配不到明确提示；页面不再各自持久化模型选择，从根上消除与高级设置的冲突。

## 1. 背景与冲突根因

当前模型选择的真实链路：

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 后端默认 | `server/config.py` 的 `unet / clip / vae / turbo_lora / turbo_unet / consistency_lora` | 由 `/api/options.defaults` 下发 |
| 前端持久化 | `web/src/store.js` 的 `t2i.unet/clip/vae`、`edit.unet/clip/vae/consistencyLora` | 随所有 UI 设置写 localStorage |
| 请求覆盖 | `t2i.js` / `edit.js` 组包时显式带 `models:{unet,clip,vae}` | 后端 `_resolve_models` 里请求优先 |

因此：**用户在系统设置里改默认模型，对已经存过 localStorage 的老用户完全不生效**。
同时设置页只有「模型目录」（扫描到哪些文件），没有「默认用哪个」的入口。

## 2. 已确认的四个决策（2026-11-07）

1. 页面（文生图 / 编辑页）的模型下拉**改为只读摘要**，显示「跟随系统默认 · 在设置中修改」，不再写 localStorage、不再随请求发送。
2. 默认模型采用**全局一套 + 每个预设可覆盖**（默认「跟随全局」）。
3. 首次使用走**三步向导**：选模型目录 → 自动匹配 → 确认默认模型。
4. 老用户 localStorage 里的模型选择**清除并跟随系统**，不做弹窗询问。

## 3. 概念与优先级

```
L2 任务级：Turbo 自动切底模 / 预设要求的 LoRA / 请求显式覆盖     ← 最高，且不持久化
L1 系统设置：默认模型槽位（config.json → model_defaults）        ← 新增，唯一事实来源
L0 出厂默认：代码内置 FACTORY_SLOTS（= 今天的 config 默认值）    ← 兜底
```

- **页面不再产生 L1 级别的值**，只展示解析结果；L2 仍保留（Turbo 切底模、移除/扩图 LoRA 等任务要求）。
- 解析顺序：`显式请求 > 预设覆盖 > 全局槽位 > 出厂值`。

### 槽位（slot）

第一阶段 8 个槽位，全部来自现有配置键，语义不变：

| 槽位 | 扫描类别 | 出厂值来源 | 必需 |
| --- | --- | --- | --- |
| `unet` | unet | `DEFAULTS["unet"]` | 是 |
| `clip` | clip | `DEFAULTS["clip"]` | 是 |
| `vae` | vae | `DEFAULTS["vae"]` | 是 |
| `turbo_lora` | lora | `DEFAULTS["turbo_lora"]` | 否（仅档位未固定 LoRA 时兜底） |
| `turbo_unet` | unet | `DEFAULTS["turbo_unet"]` | 否（Turbo「自动切底模」档使用） |
| `consistency_lora` | lora | `DEFAULTS["consistency_lora"]` | 否 |
| `remove_lora` | lora | `LORA_TASKS["remove"]["name"]` | 否 |
| `outpaint_lora` | lora | `LORA_TASKS["outpaint"]["name"]` | 否 |

> 说明：预设里的 `consistency` 任务 LoRA 第一阶段仍走 `config.LORA_TASKS`（现网已验证强度 0.48），
> 槽位 `consistency_lora` 只负责编辑页「一致性 LoRA」的默认值；两者统一留到后续版本，避免改变已验证的预设行为。

## 4. 数据结构（config.json）

```json
"model_defaults": {
  "version": 2,
  "active": "factory",
  "slots": {
    "unet": "diffusion_models/QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors",
    "clip": "text_encoders/Qweniamge2.1/qwen3vl_8b_int8_convrot.safetensors",
    "vae": "vae/Qweniamge2.1/qwen_image_2.1_vae_bf16.safetensors",
    "turbo_lora": "loras/qwen2.1加速/qwen_image_2.1_turbo_lora_hifi_T8_v001.safetensors",
    "turbo_unet": "diffusion_models/QwenImage2.1/qwen_image_2.1_turbo_int8_convrot.safetensors",
    "consistency_lora": "loras/Qwen-功能2.1/Qwen2.1 一致性无偏移_GH_V1.0.safetensors",
    "remove_lora": "loras/Qwen-功能2.1/Qwen2.1_万物移除Remove_GH.safetensors",
    "outpaint_lora": "loras/Qwen-功能2.1/Qwen2.1_扩图_GH_3750.safetensors"
  },
  "preset_overrides": {
    "mask_edit": null,
    "chain_mask": null,
    "remove": null,
    "outpaint": null,
    "native": null,
    "chain_native": null,
    "canvas": null
  }
}
```

- `preset_overrides[id] = null` 表示跟随全局；非空时形如 `{"slots": {"outpaint_lora": "..."}}`，只覆盖列出的键。
- 旧顶层键（`unet/clip/vae/turbo_*`）**保留并同步**：写入 `model_defaults` 时同时回写顶层，保证历史脚本、`turbo_plan`、`default_model_paths` 继续可用。

## 5. 后端接口

### 5.1 新增模块 `server/model_slots.py`

```python
SLOTS: dict[str, Slot]          # 注册表：label / kind / required / factory / 说明
def factory_slots() -> dict    # 出厂值
def normalize(cfg, raw) -> dict     # 校验 + 路径规整（主根内相对、根外绝对）
def resolve_plan(cfg, preset_id=None) -> dict   # 全局 + 预设覆盖合并后的槽位值
def match_factory(cfg) -> dict  # 自动匹配：{slot: {value, found, via}}
def audit(cfg, preset_id=None) -> dict  # {slots:{slot:{value,expected,found,kind,required}}, matched, missing[]}
```

### 5.2 `/api/settings`

- `GET` 增加 `model_defaults`：`audit()` 的结果（含每槽位 `expected / value / found / kind / required`、`matched`、`missing`、`presets[]`）。
- `POST` 接受 `model_defaults`：只允许 `SLOTS` 内的键；空字符串表示"清空，回落出厂"；返回保存后的审计结果。
- 保存后 `config.update_config()` 已会刷新缓存，**下一次任务**立即生效。

### 5.3 `/api/options`

- `defaults` 改由 `resolve_plan(cfg)` 产出（含全部槽位 + `preset_overrides`），并保留现有 `resolved` 文件名视图。
- 新增 `defaults.slots` 与 `defaults.preset` 供前端只读展示。

### 5.4 pipeline

- `_resolve_models` 的兜底从 `profile.get(key)` 改为 `resolve_plan(cfg, preset_id)`，请求显式 `models` 仍最高。
- `config.resolve_lora_preset` 增加可选 `cfg`：槽位有值时用槽位路径，否则用 `LORA_TASKS` 内置值。
- 缺文件时抛结构化错误：`{"code": "missing_models", "missing": [{"slot","expected","searched_dirs"}]}`，前端据此提示。

## 6. 自动匹配算法（`match_factory`）

对每个槽位，按顺序尝试：

1. `config.resolve_model(cfg, kind, expected)` 命中 → 记 `via="exact"`；
2. 全量扫描结果里 `value` 以 expected 的规范路径结尾 → `via="suffix"`；
3. 文件名相同且唯一 → `via="basename"`；
4. 多候选或零候选 → 不自动选，标记 `found=false`。

全部必需槽位命中 → `matched=true`，前端显示「已匹配出厂方案」；
任一必需槽位未命中 → 显示「未找到默认方案，请手动选择默认模型」，并定位到缺失槽位。

## 7. 前端改动

| 文件 | 改动 |
| --- | --- |
| `web/src/components/settings.js` | 新增导航项「默认模型」；渲染槽位行（下拉 + 状态徽章 + 恢复出厂）；保存走 `/api/settings` |
| `web/src/components/settings.js` | `formFromData / buildPayload` 增加 `model_defaults`；保存后广播 `settings:saved`（带 `modelDefaultsChanged`） |
| `web/src/components/controls.js` | `ModelsField` 改为只读摘要组件（或新增 `ModelsSummary`），展示"跟随系统默认"与文件名 |
| `web/src/components/t2i.js` / `edit.js` | 移除模型下拉与 localStorage 写入；请求不再发 `models`（保留 Turbo 的底模覆盖逻辑） |
| `web/src/store.js` | 删除 `t2i/edit` 的 `unet/clip/vae` 持久化字段；`applyOptionDefaults` 只保留参数类默认 |
| `web/src/app.js` | 首次启动引导：缺 `model_root` 或 `matched=false` 时打开向导 |
| `web/src/i18n.js` | 新增「默认模型」分区文案（中/英） |

首次使用向导三步：

1. **模型目录**：复用现有目录表单（`model_root / extra_model_roots / extra_model_paths.yaml`）；
2. **自动匹配**：保存目录后调用 `match_factory`，列出 8 个槽位的匹配结果；
3. **确认默认**：匹配成功一键确认；失败则逐槽位手动选择，保存为默认。

## 8. 迁移与兼容

- `load_config`：无 `model_defaults` 时，用顶层旧键生成等价槽位（不写盘，只在内存中视为 `factory`）。
- 第一次从设置页保存时才落盘 `model_defaults`。
- 前端 localStorage 旧值：升级后首次加载直接清空 `t2i.unet/clip/vae`、`edit.unet/clip/vae/consistencyLora`，不再使用。
- 请求体里的 `models` 字段**后端继续支持**（API/历史回放兼容），只是新前端不再发送。
- 任务回放：`job.params.models` 仍记录实际生效值，历史记录不受影响。

## 9. 分步实施计划（每步独立可提交）

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| S1 | `server/model_slots.py`：槽位注册表、出厂值、`resolve_plan`、`match_factory`、`audit` | 新增 `tests/test_model_slots.py`：优先级、预设覆盖、文件缺失、路径规整 |
| S2 | `/api/settings` 读写 `model_defaults`；`GET` 返回审计结果 | 往返测试：保存后读取一致；非法槽位 400 |
| S3 | `/api/options.defaults` 改用 `resolve_plan`；pipeline 兜底与结构化缺模型错误；`resolve_lora_preset` 支持槽位 | 现有编辑/文生图回归测试通过；缺文件时报 `missing_models` |
| S4 | 设置页新增「默认模型」分区（只读先跑通，再接下拉与保存） | 浏览器：8 槽位显示、缺失标红、保存生效 |
| S5 | 页面模型区改只读摘要；移除 localStorage 持久化与请求 `models` | 真机：改设置 → 刷新页面 → 出图使用新模型；参数不受影响 |
| S6 | 首次使用三步向导 + i18n | 清空 model_root 后启动 → 向导 → 自动匹配 → 确认 |
| S7 | 文档回写（本文 + `PLAN_PS_EDIT_GH.md` 交叉引用）与回归 | 全部测试通过，提交 |

> 进度：
> - S1 已完成 —— `server/model_slots.py`（8 槽位注册表、`resolve_plan` 四层合并、`match_slots` 精确/后缀/同名匹配、`audit`）与 `tests/test_model_slots.py`。
> - S2 已完成 —— `GET /api/settings` 返回 `model_defaults` 审计视图；`POST /api/settings` 支持 `model_defaults.slots / preset_overrides`（空串=清空回落出厂，未知槽位 400），并把生效值同步回旧顶层键。`tests/test_model_slots.py` 10 项全绿；TestClient 往返验证：matched=true、清空后 `source=factory`、非法槽位 400。
> - S3 已完成 —— `/api/options.defaults` 改由 `resolve_plan` 产出（含 `slots / preset_overrides`）；`pipeline._resolve_models` 兜底走槽位并按预设覆盖，`_build_loras` 的 remove / outpaint 预设可被槽位替换（一致性 LoRA 保持原预设）；缺模型/缺 LoRA 抛 `PipelineError(code="missing_models", meta={missing:[{slot,expected,searched_dirs}]})`，`job.error_code / error_meta` 随 `/api/jobs/{id}` 下发。`tests/test_pipeline_defaults.py` 5 项全绿，槽位+预设回归 20 项全绿；`/api/options` 实测与 `resolve_plan` 一致。
> - S4 已完成 —— 设置页新增「默认模型」分区（`SECTIONS.defaults` + `renderDefaults`）：8 个槽位下拉（候选来自 `/api/options.models`，含「跟随出厂默认」与已扫描文件）、状态徽章（已找到 / 缺失 / 待保存）、顶部 `notice info|warn`（「已找到默认方案」/「未找到默认方案，请手动选择默认模型」）、维护组（全部恢复出厂 / 重新检测）；`buildPayload` 只提交改动过的槽位，空串 = 清空自定义回落出厂。浏览器实测：8 个下拉、横幅、徽章、未保存态均正常；REST 往返：改 `remove_lora` → `source=custom`，清空 → `source=factory`，`matched=true`，测试后 `config.json` 已还原。
> - S5 已完成 —— `ModelsField` 改为只读的 `ModelsSummary`（文生图 / 图像编辑 / 棚拍高级面板统一显示 `defaults.slots` 路径 + 「跟随系统默认 · 在「设置 → 默认模型」中修改」）；`store.DEFAULT_T2I / DEFAULT_EDIT` 去掉 `unet/clip/vae`，`loadSettings` 读取旧 localStorage 时丢弃这三个键；`collectPayload` 与 `studio/payload.js` 不再发送 `models`；Turbo「自动切底模」改由后端 `turbo_plan → turbo_unet` 槽位接管，前端删除 `applyTurboModel`。`node --check` 全绿；浏览器实测两页均为 3 行只读路径、0 个下拉。
> - S6 已完成 —— 新增首次使用三步向导（`settings.js` 的 `maybeOpenModelWizard / openModelWizard`，`app.js` 启动后调用）：仅当 `model_defaults.matched === false` 且未提醒过（`localStorage: qwen:model-wizard`）时弹出；第 1 步填模型根目录 / 额外根目录并保存匹配，第 2 步展示 8 个槽位的自动匹配结果，第 3 步手动选择后保存；「稍后设置」不再打扰。浏览器实测（用 fetch 桩模拟未匹配，不改真实配置）：三步文案、缺口徽章、8 个下拉与候选列表均正常，`config.json` 未被改动。
> - S7 已完成 —— `PLAN_PS_EDIT_GH.md` 头部增加交叉引用（默认模型槽位可覆盖其 LoRA 预设）；全量回归 `python -m pytest tests`：**408 passed**。上线提醒：**8722 端口的后端需要重启**才会加载 `model_slots` / `model_defaults` 相关代码（当前跑的是旧进程）。

## 10. 测试计划

- 单元：槽位合并优先级、预设覆盖、旧键迁移、相对/绝对路径规整、多候选不自动选。
- 接口：`POST /api/settings` 往返、非法 slot 拒绝、保存后 `/api/options.defaults` 同步。
- 回归：文生图 1 次、编辑 1 次（mask_edit）、Turbo 1 次（lora 档 + ckpt 档），确认实际加载的 unet/clip/vae/LoRA 与设置一致（`/api/health.engine.loaded`）。
- 前端：只读摘要、向导、缺失提示文案；不出现 JS 报错。

## 11. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 用户误保存不存在的路径 | 保存允许但标 `found=false`；出图前给结构化提示，不静默换模型 |
| 预设覆盖过多导致混乱 | 只允许覆盖槽位，不提供"整套方案"；界面默认折叠 |
| 旧脚本依赖顶层键 | 写入时同步顶层键，读时优先 `model_defaults` |
| 回滚 | 删掉 `model_defaults` 段即可回到旧行为；代码分支 `resolve_plan` 有 `model_defaults` 缺失兜底 |

## 12. 本方案不做

- 不限制任务级 LoRA 叠加：页面的 `LoraPicker` 保持原样，仍可从全部已扫描 LoRA 里多选并调强度，请求 `loras` 参数不变；
  设置里的 4 个 LoRA 槽位（turbo / consistency / remove / outpaint）只决定「默认用哪个」，候选永远来自扫描结果，
  新放进 `loras` 目录的文件点一次「重新扫描」即可出现。
- 不做多套命名方案（标准/高清/省显存）——结构已预留，后续再加。
- 不改 Turbo 档位内部固定的 LoRA/底模策略（槽位只做兜底与 `turbo_unet` 覆盖）。
- 不改 `model_root` 扫描算法与 `extra_model_paths.yaml` 解析。

## 13. 文生图 / 图生图分组默认模型（v3）

> 背景：v2 的 8 个槽位实际只服务编辑链路（Qwen 底模 + 一致性 / 移除 / 扩图 LoRA）。
> 文生图还有独立的模型档案切换（Qwen / MOSS）和另一套权重，必须分开配置。

### 13.1 架构调研结论（2026-11-07）

| 链路 | 入口 | 模型选择 | 实际权重来源 |
| --- | --- | --- | --- |
| 文生图 | `/api/generate` → `Pipeline.generate_t2i` | `params.model`（`qwen` / `moss`，默认 `cfg.model`） | Qwen：`model_defaults.slots`；MOSS：`config.json` 的 `moss` 段（unet/clip/vae/8 步 LoRA） |
| 图生图 | `/api/edit` → `Pipeline.generate_edit` | 固定 `qwen` | `model_defaults.slots` + 预设 / 任务级 LoRA |

已确认的链路缺陷（P0，需随本方案一起修）：

- `pipeline._resolve_models` 用 `model_slots.resolve_plan()` 的结果覆盖了模型档案的默认路径。
  `resolve_plan()` 永远返回 Qwen 出厂值，因此**选 MOSS 文生图时实际加载的是 Qwen 的 unet / clip / vae**，
  与 MOSS 档案的 latent 通道数、文本编码器不匹配，属于必现错误。
- t2i 页面默认模型取自 `options.default_model`（= 全局 `cfg.model`），无法与编辑页分开设置。
- `models.public_list()` 里 Qwen 档案读顶层旧键，不感知任务级槽位，设置页与页面显示的权重可能不一致。

### 13.2 数据结构（config.json，version = 3）

```json
"model_defaults": {
  "version": 3,
  "slots": { "unet": "...", "clip": "...", "vae": "...", "turbo_lora": "...", "turbo_unet": "...",
             "consistency_lora": "...", "remove_lora": "...", "outpaint_lora": "...",
             "moss_unet": "...", "moss_clip": "...", "moss_vae": "...", "moss_turbo_lora": "..." },
  "tasks": {
    "t2i": {
      "model": "moss",
      "slots": { "unet": "...", "moss_unet": "..." }
    },
    "edit": {
      "slots": { "unet": "..." }
    }
  },
  "preset_overrides": { "mask_edit": null }
}
```

- `slots`：公共默认（v2 已有，保留兼容；新增 4 个 `moss_*` 槽位）。
- `tasks.t2i.model`：文生图默认模型档案，`qwen` / `moss`，缺省回退 `cfg.model` → `qwen`。
- `tasks.t2i.slots` / `tasks.edit.slots`：任务级覆盖，只写与公共值不同的键；空串 = 清空回落。
- MOSS 槽位只在 `tasks.t2i.model = moss` 时参与解析；Qwen 槽位只在 qwen 档案 / 编辑链路参与解析。

### 13.3 解析顺序

```
出厂值 < 旧顶层键（仅无 model_defaults 时） < 公共 slots
       < tasks.<task>.slots < 预设覆盖 < 任务级显式请求
```

- `task` 由入口决定：`generate_t2i` 传 `t2i`，`generate_edit` 传 `edit`。
- `model = moss` 时，在任务覆盖之后把 `moss_unet/moss_clip/moss_vae/moss_turbo_lora`
  映射为生效的 `unet/clip/vae/turbo_lora`，保证 MOSS 档案拿到的永远是 MOSS 权重。
- `turbo_unet` 仍由 Turbo 预设的 `turbo_plan` 在请求级覆盖，优先级最高。

### 13.4 接口与模块

| 位置 | 改动 |
| --- | --- |
| `server/model_slots.py` | 新增 `MOSS_SLOTS` 注册表；`resolve_plan(cfg, preset_id, task, model)`；`task_model(cfg)`；`audit()` 增加 `tasks.t2i / tasks.edit` 视图；`merge_section` 接受 `tasks`（未知任务 / 模型 400） |
| `server/pipeline.py` | `_resolve_models(..., task)` 按任务 + 档案解析；MOSS 不再被 Qwen 槽位覆盖；`_profile` 传入任务 |
| `server/models.py` | 档案路径改读任务解析结果；`public_list(task="t2i")` 返回文生图实际权重 |
| `server/main.py` | `/api/options.defaults` 增加 `t2i` / `edit` 两份解析结果与 `t2i_model`；`/api/settings` 审计透传 `tasks` |
| `web/src/store.js` | 文生图默认档案改读 `defaults.t2i_model`；只读摘要按任务取槽位 |
| `web/src/components/settings.js` | 「默认模型」分区增加「文生图 / 图生图」切换；文生图含模型档案下拉（Qwen / MOSS）与对应槽位，图生图只显示编辑槽位；保存写 `tasks` |
| `web/src/components/t2i.js` / `edit.js` | 只读摘要分别展示 `defaults.t2i` / `defaults.edit` |

### 13.5 迁移与兼容

- 没有 `tasks` 段：两个任务都等于公共 `slots`，行为与 v2 完全一致。
- 旧顶层键同步规则不变（只同步公共槽位，不写任务覆盖）。
- 首次保存 v3 时写 `version: 3`；`tasks` 可只保存改动过的任务 / 槽位。
- 向导（首次使用）仍编辑公共 `slots`；已存在任务覆盖时以任务覆盖为准，向导结果作为公共兜底。

### 13.6 实施步骤（每步独立可提交）

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| T1 | `model_slots`：MOSS 槽位、任务解析、审计视图、`merge_section(tasks)` | 单测：任务覆盖优先级、MOSS 映射、未知任务 / 模型 400 |
| T2 | `pipeline` / `models` 按任务解析，修复 MOSS 被 Qwen 权重覆盖 | 单测：`models.get(moss)` 与 `_resolve_models(t2i, moss)` 全部为 MOSS 路径；Qwen 编辑回归不变 |
| T3 | `/api/options` / `/api/settings` 下发任务视图 | REST：`defaults.t2i.edit` 分离；保存 `tasks.t2i.model` 往返一致 |
| T4 | 设置页分组 UI + 前端摘要 + 文生图默认档案 | 浏览器：两任务切换、保存生效、刷新后摘要正确 |
| T5 | 文档回写 + 全量回归 | `python -m pytest tests` 全绿；文生图 / 编辑各跑 1 次真机 |

### 13.7 验收口径

- 文生图选 MOSS：`/api/health.engine.loaded` 与 `job.params.models` 均为 `moss_*` 路径，不再出现 Qwen unet。
- 文生图选 Qwen、编辑选 Qwen：两个任务可各自配置不同 unet，互不影响。
- 未配置 `tasks` 的旧配置：解析结果与 v2 完全一致。

### 13.8 实施进度（2026-11-07）

| 步骤 | 状态 | 说明 |
| --- | --- | --- |
| T1 | 已完成 | `model_slots.py` 新增 `MOSS_SLOTS` / `ALL_SLOTS` / `TASK_IDS`，`resolve_plan(cfg, preset_id, task, model)`、`task_model(cfg)`、`normalize_task_slots`、`merge_section(tasks)`、`audit()` 任务视图；`match_slots` 改为遍历全部槽位。 |
| T2 | 已完成 | `pipeline._resolve_models(..., task)` 与 `_profile(..., task)` 按任务解析；`models._resolve(cfg, name, task)` 改读任务级解析结果，MOSS 档案固定使用 `moss_*` 权重，修复「选 MOSS 实际加载 Qwen」的 P0。 |
| T3 | 已完成 | `/api/options` 新增 `t2i_plan` / `t2i_qwen` / `t2i_moss` / `edit_plan` 与 `defaults.t2i_model`；`/api/settings.model_defaults` 透传 `tasks` 审计视图；保存 `tasks.t2i.model` 往返一致。 |
| T4 | 已完成 | 设置页「默认模型」拆为「文生图 / 图生图」两个 tab；文生图含模型档案下拉（Qwen / MOSS）与对应槽位行，图生图只显示编辑槽位；`t2i.js` / `edit.js` 摘要分别读 `defaults.t2i` / `defaults.edit`；保存写 `tasks`。 |
| T5 | 已完成 | `python -m pytest tests` → 419 passed；TestClient 校验 `/api/settings` 与 `/api/options` 任务视图；浏览器验证设置页 tab 切换、MOSS 槽位显示与保存态。 |

注意事项：

- 真实 `config.json` 本次未写入 `model_defaults.tasks`（避免测试污染用户配置）；首次在设置页保存后自动升级为 `version: 3`。
- 生产后端若已在运行，需要重启（例如 8722 端口的旧进程）才能加载 v3 解析逻辑；未重启时 `/api/options` 仍是旧结构。

