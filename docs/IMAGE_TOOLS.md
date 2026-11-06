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
    {"op": "adjust", "brightness": 1.05, "contrast": 1.1, "saturation": 1.05,
                     "sharpness": 1.2, "temperature": 0.1},
    {"op": "pad32"},
    {"op": "trim_alpha", "padding": 8}
  ],
  "format": "png|jpeg",
  "quality": 92,
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
- `format=jpeg` 会转 RGB（丢 alpha），`quality` 1~100；
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
& "<python>" -m pytest tests/test_imageops.py -q     # 17 项，纯 CPU，0.5s
```

覆盖：裁剪尺寸/越界收敛/非法参数、宫格数量与格子尺寸（含间隔）、旋转翻转、三种 fit、
调色改变像素且保持尺寸、色温方向（暖色抬红压蓝）、`pad32` 对齐、alpha 去边、未知操作报错、
落盘与 JPEG 质量、扩图规划（单方向/全方向/amount 收敛）。
