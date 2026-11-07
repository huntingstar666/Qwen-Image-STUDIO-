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

- 不做多套命名方案（标准/高清/省显存）——结构已预留，后续再加。
- 不改 Turbo 档位内部固定的 LoRA/底模策略（槽位只做兜底与 `turbo_unet` 覆盖）。
- 不改 `model_root` 扫描算法与 `extra_model_paths.yaml` 解析。
