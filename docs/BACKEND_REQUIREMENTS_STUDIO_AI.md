# 修图工作台 P2 能力 · 后端接口需求

- 版本：v1.0（2026-11-08）
- 关联台账：D13.1 AI 主体选择 / D13.2 内容识别填充 / D14.1 全景图入口
- 关联文档：[BUILD_CONTRACT.md](BUILD_CONTRACT.md)、[PLAN_PANORAMA.md](PLAN_PANORAMA.md)、[IMAGE_TOOLS.md](IMAGE_TOOLS.md)、[PLAN_PS_FRONTEND.md](PLAN_PS_FRONTEND.md)
- 结论先行：**只有 D13.1 需要新后端接口**；D13.2 用现有 `/api/edit` 即可；D14.1 后端已完成，零改动。

| 序号 | 能力 | 是否需要后端开发 | 优先级 |
| --- | --- | --- | --- |
| D13.1 | AI 主体选择（点选 / 框选 / 显著性主体） | **需要**：新增分割接口 | P0 |
| D13.2 | 内容识别填充（框选消除） | 不需要：`/api/edit` + `task.mode="remove"` | — |
| D14.1 | 全景图入口 | 不需要：`/api/edit` + `task.mode="panorama"` 已实现 | — |

---

## 1. 通用约定（复用现有契约，不另起一套）

所有接口与现有后端保持一致：

1. 同源相对路径 `/api/...`；图片支持两种入参：
   - `data:image/png;base64,...`（dataURL）
   - `/files/uploads/xxx.png` 或 `/files/outputs/xxx.png`（静态文件 URL）
2. 异步任务统一：
   - 提交返回 `{ "job_id": "..." }`
   - 轮询 `GET /api/jobs/{job_id}`，终态 `status` 为 `done | error | canceled`
   - 进度 `progress: { value, max, label }`
   - 结果 `images: [{ url, width, height, filename }]`
3. 错误统一：
   ```json
   { "error": { "code": "snake_case_code", "message": "中文可读消息" } }
   ```
4. 静态文件统一走 `/files/{path}`，只读。
5. 模型/显存管理复用：
   - `POST /api/engine/warmup`：预加载
   - `POST /api/engine/free`：`{ "unload": true }` 释放显存
6. 输入图硬限制（建议）：最长边 ≤ 4096、总像素 ≤ 16 MP；超出返回 `400 invalid_image`。
7. 所有坐标均为**输入图像素坐标**，原点左上，`(x, y)` 为左上角，`width/height` 为正数。

参考现有契约：[BUILD_CONTRACT.md](BUILD_CONTRACT.md) 的 `/api/edit`、`/api/jobs/{id}` 段落。

---

## 2. D13.1 AI 主体选择（需要开发）

### 2.1 产品目标

修图工作台左侧新增「主体」工具：

- **单击画面**：自动选中点击处的主体（人、动物、车、物体等）。
- **拖一个框**：选中框内的完整主体。
- 结果作为选区（alpha 蒙版），可直接用于：
  - 反选、羽化、扩展/收缩、清除；
  - 「带选区编辑」→ 现有 `/api/edit` 的 `mask`；
  - 「内容识别填充」→ `/api/edit` + `task.mode="remove"`。
- 支持多主体场景：一次返回多个候选，前端取其一或合并。

### 2.2 建议模型

| 用途 | 建议模型 | 说明 |
| --- | --- | --- |
| 点选 / 框选 | SAM 2.1（hiera-b 或 hiera-l） | 支持 box prompt 与 point prompt |
| 无提示主体（subject） | BiRefNet（通用或人像） | 无需用户提示，取最显著主体 |
| 文字选主体（可选） | Grounded-SAM（GroundingDINO + SAM） | 未部署时返回 `501`，前端隐藏入口 |

模型文件缺失时接口不得崩溃，返回 `503 model_not_ready`。

### 2.3 接口 A：模型清单

```http
GET /api/image/segment/models
```

响应 `200`：

```jsonc
{
  "models": [
    {
      "id": "sam2.1-hiera-large",
      "label": "SAM 2.1 Large",
      "kind": "prompt",        // subject | prompt | text
      "ready": true,
      "loaded": true,
      "vram_mb": 5200
    },
    {
      "id": "birefnet-portrait",
      "label": "BiRefNet 主体",
      "kind": "subject",
      "ready": true,
      "loaded": false,
      "vram_mb": 3600
    }
  ],
  "default": "sam2.1-hiera-large"
}
```

字段说明：

- `ready`：模型文件存在且可加载。
- `loaded`：当前是否驻留显存。
- `kind`：`subject` 无提示 / `prompt` 点或框 / `text` 文字提示。
- 风格对齐现有 `GET /api/image/upscale/models`。

### 2.4 接口 B：分割

```http
POST /api/image/segment
Content-Type: application/json
```

#### 请求

```jsonc
{
  "image": "data:image/png;base64,...",   // 必填；或 /files/uploads/xxx.png
  "model": "sam2.1-hiera-large",          // 可选，缺省用服务端 default
  "mode": "subject",                      // subject | box | points | text
  "box": { "x": 120, "y": 80, "width": 640, "height": 960 },  // mode=box 必填
  "points": [ { "x": 500, "y": 400, "label": 1 } ],            // mode=points 必填
  "text": "人物",                          // mode=text 选填
  "multi": false,                          // true：最多返回 8 个候选
  "feather": 0,                            // 0~32 px；0 表示前端自己羽化
  "max_side": 2048,                        // 内部推理上限（只缩不放）
  "async": false                           // P1 可选项；true 时返回 {job_id}
}
```

模式语义：

| mode | 必填 | 行为 |
| --- | --- | --- |
| `subject` | 无 | 忽略 box/points，选最显著主体；多主体按面积/置信度排序 |
| `box` | `box` | 分割框内完整物体；框外必须为 0 |
| `points` | `points` | SAM 点提示；`label=1` 前景、`label=0` 背景排除点 |
| `text` | `text` | Grounded-SAM；暂不支持时返回 `501 not_implemented` |

#### 同步响应 `200`

```jsonc
{
  "masks": [
    {
      "url": "/files/masks/seg_20261108_153012_ab12.png",
      "width": 1600,
      "height": 1000,
      "score": 0.97,
      "box": { "x": 118, "y": 76, "width": 648, "height": 972 },
      "area": 523144
    }
  ],
  "model": "sam2.1-hiera-large",
  "elapsed_ms": 412,
  "meta": { "mode": "box", "feather": 0 }
}
```

也允许返回内联图片（二选一）：

```jsonc
{
  "masks": [
    { "data": "data:image/png;base64,...", "width": 1600, "height": 1000, "score": 0.97 }
  ]
}
```

**蒙版格式（硬性要求）**

1. PNG，**与输入图同宽同高**。
2. 灰度图：白色 `255` = 选中，黑色 `0` = 未选中；可带 alpha，但不能只有 alpha 没有灰度。
3. 允许多个不连通区域出现在同一张蒙版内。
4. `multi=false` 只返回 1 个；`multi=true` 按 `score` 降序返回，最多 8 个。
5. 内部可用 `max_side` 降采样推理，但输出必须**上采样回原图尺寸**，并按 0.5 阈值二值化 + 轻度抗锯齿（1~2px），避免前端坐标错位。
6. 若 `feather > 0`，在输出前对蒙版做对应半径的羽化。

#### 异步模式（P1，可选）

请求 `"async": true` 时返回：

```json
{ "job_id": "job_xxx" }
```

轮询 `GET /api/jobs/{job_id}`，在任务对象上新增：

```jsonc
{
  "status": "done",
  "masks": [
    { "url": "/files/masks/xxx.png", "width": 1600, "height": 1000, "score": 0.97 }
  ]
}
```

> 同步模式是 P0 要求；异步仅用于模型冷启动可能超过 30s 的部署环境。

#### 错误码

| HTTP | code | 触发条件 | message 建议 |
| --- | --- | --- | --- |
| 400 | `invalid_image` | 解码失败、宽高为 0、超尺寸 | 图片无法读取或超出尺寸限制 |
| 400 | `invalid_box` | 框越界、宽高 ≤ 0 | 框选区域无效，请重新框选 |
| 400 | `invalid_points` | 点为空或坐标越界 | 取样点无效，请重新点选 |
| 422 | `no_subject` | 点/框内没有可分割主体 | 未识别到主体，请改用框选或点选 |
| 501 | `not_implemented` | `mode=text` 未部署 | 当前未启用文字选主体 |
| 503 | `model_not_ready` | 模型缺失/加载失败 | 分割模型未就绪，请稍后重试 |
| 504 | `segmentation_timeout` | 超过 30s | 分割超时，请重试 |
| 500 | `segmentation_failed` | 其他推理异常 | 主体分割失败 |

#### 性能与资源目标

- 热模型、2048 长边：p95 ≤ 1.5s。
- 冷启动：≤ 30s；建议首次请求前由前端/后端调用 `POST /api/engine/warmup`。
- 显存占用 ≤ 6GB；空闲时支持 `POST /api/engine/free {unload:true}` 卸载。
- 与文生图任务共存时：允许排队；若显存不足返回 `503 model_busy`（可复用 `model_not_ready` 文案）。

#### 验收标准（后端自测 + 前端联调）

1. 单人像图点选人物 → 返回蒙版覆盖人物，尺寸与输入一致，`score > 0.8`。
2. 框选人像 → 蒙版不超出框外 2px。
3. 多人图 `multi=true` → 至少返回 2 个候选，`box` 不重叠或低重叠。
4. 空白背景点选 → 返回 `422 no_subject`。
5. 输入 4000×3000 图 → 输出蒙版仍为 4000×3000。
6. 模型缺失 → `503 model_not_ready`，不影响其他接口。
7. `POST /api/engine/free` 后再次调用可正常重载。

前端接入计划（不在后端范围）：选区组新增「主体」工具，结果写入 `selection.js` 的 alpha 选区，复用现有反选/羽化/扩展/收缩与 `/api/edit`。

---

## 3. D13.2 内容识别填充（不需要新后端）

### 3.1 结论

现有 `/api/edit` 已支持：

- `task.mode="remove"`（后端会归一为 `edit`）；
- 请求带 `mask` 时只重绘遮罩区域；
- `prompt` 为空时后端自动补「移除并自然补全」训练指令。

前端会用「框选 / 主体选区」生成 mask，然后调用：

```http
POST /api/edit
Content-Type: application/json
```

```jsonc
{
  "prompt": "",                    // 可空；后端 remove 模式自动补指令
  "negative_prompt": "",
  "images": [
    { "name": "main.png", "data": "data:image/png;base64,..." }
  ],
  "mask": { "data": "data:image/png;base64,..." },
  "task": { "mode": "remove" },
  "size_mode": "follow",
  "steps": 20,
  "cfg": 4.5,
  "seed": null,
  "local": { "enabled": true, "scheme": "a" }
}
```

响应：`{ "job_id": "..." }`；轮询 `/api/jobs/{id}`；结果 `job.images[0]`。

### 3.2 对后端的唯一要求

1. 保持 `task.mode="remove"` 别名可用（现状已满足）。
2. mask 与主图同尺寸、白色为待移除区域；允许软边。
3. `local.mask_expand`（现有字段）支持 4~16px 外扩，用于减少接缝。
4. 不建议为 D13.2 新增专用接口；如后续要本地 LaMa 加速，再单独立项。

### 3.3 验收标准

- 矩形 mask 覆盖一个物体 → 结果中物体消失、背景纹理自然、无新物体。
- 输出尺寸 = 输入尺寸。
- 任务失败/取消路径与普通编辑一致。

### 3.4 可选（P2）：专用 `/api/image/inpaint`

仅当希望绕开大模型、走本地 LaMa/Qwen-Fill 时再考虑：

```jsonc
POST /api/image/inpaint
{
  "image": "data:...",
  "mask": { "data": "data:..." },
  "mode": "remove" | "fill",
  "prompt": "",                // mode=fill 时可填
  "dilate": 8,
  "feather": 8,
  "steps": 20,
  "cfg": 4.5,
  "seed": null,
  "engine": "lama" | "qwen-fill"
}
```
返回 `{job_id}`，结果同样走 `/api/jobs/{id}`。**不是 D13.2 的阻塞项。**

---

## 4. D14.1 全景图入口（后端已完成，零改动）

### 4.1 现状

- `task.mode="panorama"`、`panorama` 参数块、几何规划、接缝修正、质量回显均已实现（见 [PLAN_PANORAMA.md](PLAN_PANORAMA.md)）。
- 图像编辑页 `#edit` 已有入口；本次只缺「修图工作台」的入口，属于前端工作。

### 4.2 既有调用契约（前端会按此调用）

```http
POST /api/edit
Content-Type: application/json
```

```jsonc
{
  "prompt": "黄昏时分的海边公路，向两侧无限延伸",
  "negative_prompt": "",
  "images": [
    { "name": "main.png", "data": "data:image/png;base64,..." }
  ],
  "task": { "mode": "panorama" },
  "panorama": {
    "aspect": "2:1",       // 2:1 | 3:1 | 4:1 | 21:9
    "long_side": 3072,     // 1024~4096，只缩不放
    "wrap": false,         // 360° 环绕接缝（实验）
    "seam_blend": 24       // 0~128
  },
  "size_mode": "custom",
  "steps": 20,
  "cfg": 4.5,
  "seed": null
}
```

响应：`{ "job_id": "..." }`。

任务对象中可读字段：

```jsonc
{
  "status": "done",
  "images": [{ "url": "/files/outputs/xxx.png", "width": 3072, "height": 1536, "filename": "xxx.png" }],
  "align": {
    "panorama": { "canvas": { "w": 3072, "h": 1536 }, "plan": { "...": "..." }, "applied": true }
  },
  "quality": {
    "outpaint": null,
    "panorama": {
      "aspect": "2:1",
      "long_side": 3072,
      "wrap": false,
      "seam_blend": 24,
      "canvas": { "w": 3072, "h": 1536 },
      "work": { "w": 1408, "h": 704 },
      "pads": { "left": 0, "right": 0, "top": 0, "bottom": 0 },
      "scale": 1.0,
      "seam_report": { "...": "..." },
      "wrap_report": null
    }
  }
}
```

### 4.3 对后端的唯一请求（可选，不阻塞）

在 `GET /api/options` 的 `task_modes` 中补上 `"panorama"`（当前为 `["edit","inpaint","replace","remove","outpaint"]`），方便前端自动发现；不加也不影响通过 `task.mode` 显式调用。

### 4.4 验收标准

- `aspect=2:1 / 3:1 / 4:1 / 21:9` 均能返回对应比例画布，画布 32 对齐。
- `quality.panorama` 字段齐全，`quality.outpaint === null`。
- `wrap=true` 时 `quality.panorama.wrap_report` 非空。
- 输出 `images[0].width/height` 与 `quality.panorama.canvas` 一致。
- 提示词留空也能成功（后端自动补全景指令）。

---

## 5. 后端交付清单

### P0（阻塞 D13.1）

- [ ] `GET /api/image/segment/models`
- [ ] `POST /api/image/segment`（同步；`subject` / `box` / `points` 三种模式）
- [ ] 蒙版输出规范：与输入同尺寸、灰度、白=选中
- [ ] 错误码：`invalid_image / invalid_box / invalid_points / no_subject / model_not_ready / segmentation_timeout / segmentation_failed`
- [ ] 支持 `POST /api/engine/free` 卸载分割模型
- [ ] 自测用例通过（见 2.4 验收标准）

### P1（可选）

- [ ] `mode="text"`（Grounded-SAM）
- [ ] `async: true` 返回 `{job_id}`，任务对象带 `masks`
- [ ] `GET /api/options` 的 `task_modes` 增加 `"panorama"`
- [ ] `POST /api/image/inpaint`（本地补全，非必需）

### 不需要开发

- D13.2 内容识别填充：前端直接复用 `/api/edit` + `task.mode="remove"`
- D14.1 全景入口：前端直接复用 `/api/edit` + `task.mode="panorama"`

---

## 6. 联调方式

后端就绪后，前端用以下命令快速验证（把图片换成实际 base64 或 `/files` URL）：

```bash
# 1. 模型清单
curl -s http://127.0.0.1:8700/api/image/segment/models | jq

# 2. 框选分割
curl -s http://127.0.0.1:8700/api/image/segment \
  -H 'Content-Type: application/json' \
  -d '{
    "image": "/files/uploads/demo.png",
    "mode": "box",
    "box": {"x": 120, "y": 80, "width": 640, "height": 960}
  }' | jq

# 3. 点选分割
curl -s http://127.0.0.1:8700/api/image/segment \
  -H 'Content-Type: application/json' \
  -d '{
    "image": "/files/uploads/demo.png",
    "mode": "points",
    "points": [{"x": 500, "y": 400, "label": 1}]
  }' | jq

# 4. 内容识别填充（现有接口）
curl -s http://127.0.0.1:8700/api/edit \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "",
    "images": [{"name": "main.png", "data": "data:image/png;base64,..."}],
    "mask": {"data": "data:image/png;base64,..."},
    "task": {"mode": "remove"},
    "size_mode": "follow"
  }' | jq

# 5. 全景（现有接口）
curl -s http://127.0.0.1:8700/api/edit \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "",
    "images": [{"name": "main.png", "data": "data:image/png;base64,..."}],
    "task": {"mode": "panorama"},
    "panorama": {"aspect": "2:1", "long_side": 3072, "wrap": false, "seam_blend": 24},
    "size_mode": "custom"
  }' | jq
```

---

## 7. 待确认问题

1. SAM 2.1 / BiRefNet 的权重来源与许可证（HuggingFace / 官方 checkpoint）由谁负责下载与落盘？
2. 分割模型与文生图/编辑模型是否共享同一张 GPU？并发策略是排队还是直接返回 `503 model_busy`？
3. `mode="text"` 是否在本期范围？若不做，前端隐藏「文字选主体」。
4. 蒙版是返回 `/files` URL 还是内联 dataURL？推荐 URL（减少轮询体积），但同步接口两者皆可。
5. 是否需要“同一图片 + 参数”的结果缓存（按图片哈希）？默认不做。
