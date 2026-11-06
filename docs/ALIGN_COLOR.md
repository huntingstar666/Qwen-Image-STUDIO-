# 零偏移 + 零色差：算法原理、参数推荐与实现说明

> 适用模块：`server/align.py`（几何/颜色算法核）、`server/imaging.py`（I/O + 画布规划 + 合成编排）
> 参考实现（只读）：ComfyUI-Precise-Align 的 `PreciseAlignPad / CropBack / CropEdit / Stitch / Composite / Region`
> 与 ComfyUI-BlueBox 的 `CutQwenImage21` / `LoadImage (BlueBox)`。
> 本项目的实现**不依赖 torch / cv2 / ComfyUI**，只用 `numpy` + `Pillow`，服务端可直接调用。

---

## 0. 一句话总结

"零偏移"靠三件事：**画布尺寸是 32 的倍数**、**文本编码器 `resolution=0`（参考图尺寸即采样画布尺寸）**、
**出图后按记录的几何信息精确裁回 + 用原图像素盖回遮罩外**。
"零色差"靠三件事：**统一按 sRGB 解码（exif/ICC 一次处理干净）**、**遮罩外逐像素保留原图（字节级）**、
**只在过渡带做 Reinhard 仿射颜色匹配**。

---

## 1. 零偏移原理

### 1.1 为什么必须是 32 的倍数

Qwen-Image 2.1 的 VAE 做 8× 空间下采样，DiT 再做 2×2 patch，合计 **32 像素 = 1 个 latent token**。
如果画布宽/高不是 32 的倍数，编码器内部会悄悄补齐或裁掉不到一个 token 的边缘，
你的"画布坐标"和"模型看到的坐标"之间就产生了最多 31px 的偏移——出图后再裁回去就会错位、重影、边缘发虚。

所以本项目的硬约束是：

```
canvas_w % 32 == 0
canvas_h % 32 == 0
```

`align.snap_dims(w, h)` 负责**向上**对齐（`server/imaging.py` 的 `plan_canvas(mode="follow")`
也是向上补齐，保证内容不被裁掉，而不是向下对齐）。

### 1.2 为什么 `TextEncodeQwenImage21.resolution = 0`

Qwen-Image 2.1 的文本编码器节点 `TextEncodeQwenImage21` 有一个 `resolution` 输入：

* `resolution > 0`：编码器会把参考图**按 `resolution²` 面积等比缩放**再对齐 32——这等于模型内部
  又重采样了一次，画布坐标和采样 latent 不再一一对应，于是出现亚像素偏移；
* `resolution = 0`：编码器**直接使用参考图的尺寸**，不再做面积缩放。此时
  "参考图尺寸 == 采样画布尺寸 == 出图尺寸"，三者在像素网格上完全重合。

本项目编辑链路一律传 `resolution=0`（因此 `align.PadInfo` 里不设 resolution 字段，
该值恒为 0；工作流构建器固定写 0）。

### 1.3 采样 latent 必须与画布同尺寸

契约 4.1 要求：

| 模式 | latent 来源 | 尺寸要求 |
| --- | --- | --- |
| `local.enabled = false`（全画布编辑） | `TextEncodeQwenImage21` 的 `latent` 输出（官方模板做法） | = 画布尺寸 |
| `local.enabled = true`（遮罩局部编辑） | `VAEEncode(画布)` + `SetLatentNoiseMask(遮罩)`（Precise-Align 方案 A） | = 画布尺寸 |

两者尺寸**必须相同**，否则 `SetLatentNoiseMask` 的遮罩和 latent 对不上，会出现"改到了别处"
或者接缝错位。统一由 `plan_canvas()` 产出的 `CanvasPlan`（`width/height` 已是 32 倍数）驱动。

### 1.4 出图后的精确逆变换

```
源图 --(plan_canvas)--> 32 对齐画布 --(ComfyUI/resolution=0)--> 画布成品
      --(align.crop_back / imaging.crop_back_plan)--> 源图尺寸 --(composite 遮罩外盖回)--> 最终结果
```

* `align.pad_image()` 记录 `PadInfo`（原尺寸、缩放倍率、缩放后尺寸、补边偏移、画布尺寸）；
* `align.crop_back()` 按 `PadInfo` **先裁 pad、再缩回原尺寸**，是纯几何逆变换，不改颜色空间；
* `imaging.crop_back_plan()` 是同一件事的 `CanvasPlan` 版本（`pad` 模式逐像素等价）。

**关键性质**：`scale_by == 1.0`（编辑模式恒为 1.0）时 `out_w/out_h == orig_w/orig_h`、
补边偏移是整数像素、全程不重采样，因此 `pad_image → crop_back` 是**恒等变换**，
`max_abs == 0`（测试 `test_pad_crop_back_roundtrip_is_pixel_exact_scale_1` 覆盖了 5 种补边 × 2 种对齐）。

### 1.5 BlueBox "32 不动点"（`fixed_point` 尺寸模式）

BlueBox 的 `CutQwenImage21` 更进一步：不只要求 32 倍数，还要求尺寸是 Qwen-Image 2.1
编辑器内部缩放的**不动点**——即"按 `resolution²` 面积等比缩放 + 32 对齐"之后尺寸不变，
这样连模型内部那一次隐式缩放都不会发生。

`align.fixed_point_size(w, h, resolution, tol_ratio)` 完整移植了 BlueBox 三步：

1. `_generate_whitelist`：枚举所有宽高为 32 倍数、面积格子数 `k*m` 落在 `n² ± tol` 内的候选
   （`n = resolution // 32`）；
2. `_score_candidate`：`1.0 × 与输入比例的距离 + 0.6 × 与标准训练桶比例的距离 + 0.4 × 面积偏差`，
   取最低分；
3. `_snap_fixed_point`：用 `_verify_fixed_point` 复核，若仍不是严格不动点，就在候选里挑
   "比例最接近输入且严格不动点"的一对。

返回值**保证** `align.is_fixed_point(w, h, resolution) == True`（512 / 1024 / 1440 档位在测试里
对 5 种输入比例逐一验证）。`imaging.plan_canvas(mode="fixed_point")` 会把推断出的 resolution
放进 `CanvasPlan.resolution`（其他模式为 0），供 BlueBox 工作流节点使用。

---

## 2. 零色差原理

### 2.1 第一件套：sRGB 统一解码

`imaging.decode_image(data)` 的处理顺序（对应 BUILD_CONTRACT 4.2 第一步）：

1. `Image.open` + `ImageOps.exif_transpose`：纠正手机照片的 EXIF 方向，避免"图被转了 90°"；
2. **有 ICC 才做色彩变换**：用 Pillow 的 `ImageCms` 把非 sRGB 的 ICC 转到 sRGB
   （灰度/CMYK profile 先转 RGB 再变换；alpha 单独保留后贴回）；
3. ICC 描述里已经含 sRGB 时**直接跳过**（避免 sRGB→sRGB 往返带来的 ±1 数值抖动）；
4. 没有 ICC 时**不做任何隐式色彩变换**，按原始 8bit 数值使用；
5. 统一成 `RGBA`（`keep_alpha=True`）或 `RGB`。

> 为什么要管 ICC：浏览器、PS、手机相册都可能给图片塞 Display P3 / Adobe RGB profile。
> 如果服务端忽略 ICC 直接当 sRGB 读，颜色会整体偏（尤其是大红、青绿），
> 与"原图颜色"对不上——这就是最常见的"色差"来源。

### 2.2 第二件套：遮罩外逐像素保留原图

"零色差"的硬验收是：**遮罩外像素与原图 `max_abs == 0`**（字节级相同，不是"看起来差不多"）。

`imaging.composite()` 和 `imaging.stitch_region()` 的实现策略：

```python
out = original_u8.copy()          # 从原图 uint8 出发
selected = alpha > 0              # 只挑出真正要改的像素
out[selected] = round(orig*(1-a) + edited*a)
```

而不是"整图浮点混合再转 uint8"——后者会因为 float32 舍入让遮罩外像素产生 ±1 的抖动。
只写 `alpha > 0` 的像素，`alpha == 0` 的位置连一次赋值都没有，天然字节级一致。

**羽化的处理**（与参考实现有意不同，见第 4 节）：
Precise-Align 的 `composite` 直接对遮罩做高斯羽化，羽化会向遮罩**外**扩散一圈，
于是"遮罩外"的像素也会被改动（测试里能测到 `max_abs ≈ 70`），这与零色差验收冲突。
本项目在羽化后**把 alpha 重新钳回"原始遮罩 > 0"的范围**，即羽化只向遮罩内侧衰减。
好处是任意 `feather` 取值下遮罩外都是严格 0；代价是过渡带在遮罩内侧（视觉上仍然平滑）。
`mask_expand > 0` 时，"原始遮罩"指**外扩后**的遮罩（这是主动改写遮罩外 3~8px 去盖住模型接缝的
功能，若要跑严格零色差验收请保持 `mask_expand = 0`）。

### 2.3 第三件套：过渡带 Reinhard 仿射匹配

即使几何零偏移，模型重绘的区域在**亮度/对比度/色温**上仍可能和原图有整体偏差
（尤其是 int8 量化模型 + 不同采样步数）。Reinhard 匹配的思路是：
用"过渡带"（遮罩边缘 `0 < a < 1` 的像素，或硬边遮罩的外扩环带）分别统计
`edited` 与 `reference` 每个通道的均值 `m` 和标准差 `s`，然后做线性仿射：

```
corrected = (edited - m_edited) * (s_ref / s_edited) + m_ref
result    = edited + strength * (corrected - edited)
```

* 只改**颜色统计**，不改色相方向、不改几何；
* 统计区域**只取过渡带**（`align.band_from_mask`），所以不会把整张图拉灰；
* `strength` 控制混合比例：0 = 关闭，1 = 完全匹配。

测试 `test_reinhard_match_pulls_mean_and_std_to_reference` 验证 strength=1 时输出均值/标准差与
参考图一致（1e-3 量级）。

### 2.4 输出编码

* `imaging.encode_png()`：统一输出 8bit PNG，默认**剥离 ICC**（避免客户端再次按旧 profile 解释色值）；
  RGBA 透明通道保留；
* `imaging.encode_jpeg()`：q95、`subsampling=0`（4:4:4，避免色度抽样造成彩边），
  RGBA 先合成到白底（JPEG 无 alpha）。

---

## 3. 本项目的零偏移调用链（可直接放进 README）

```
用户原图（第 1 张为编辑目标）
  │  ① decode_image：exif 纠正 → ICC→sRGB → RGBA（不做隐式色彩变换）
  ▼
plan_canvas：画布宽高向上对齐到 32 的倍数
  │  · follow：1:1 不重采样，只补 ≤31px 边（零偏移首选）
  │  · fixed_point：BlueBox 32 不动点（连模型内部缩放都省掉）
  ▼
compose_canvas：源图铺到画布（严格 plan.width × plan.height 的 RGBA，edge/reflect/纯色补边）
  │
  ▼
ComfyUI 编辑工作流
  │  ② TextEncodeQwenImage21(resolution=0) → 参考图尺寸即采样画布尺寸
  │  ③ 采样 latent 与画布同尺寸：
  │       local=false → 编码器 latent 输出
  │       local=true  → VAEEncode(画布) + SetLatentNoiseMask(遮罩)
  ▼
引擎出图（仍是画布尺寸）
  │
  ▼
crop_back / crop_back_plan：按 PadInfo / CanvasPlan 先裁补边、再缩回原图尺寸（纯几何逆变换）
  │
  ▼
composite：用**原始画布像素**盖回遮罩外区域（遮罩外逐字节保留），
           遮罩内做羽化 + smoothstep + 过渡带 Reinhard 颜色匹配
  │
  ▼
compose 后按需再裁回源尺寸（尺寸 == 输入尺寸，同一 32 网格，零偏移）
  │
  ▼
输出 PNG（sRGB、剥离 ICC、8bit）
```

一句话记忆版：**画布 32 对齐 → 引擎 `resolution=0` → latent 与画布同尺寸 → `crop_back` 裁回 →
`composite` 遮罩外盖回原像素。**

---

## 4. 与参考实现有意不同的地方

| # | 位置 | 参考实现 | 本项目 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | 运行环境 | torch + ComfyUI 节点 | 纯 numpy + PIL | 服务端直接调用，不依赖 ComfyUI 进程 |
| 2 | `dilate_mask` | `F.pad(0) + F.max_pool2d` | 可分离一维最大值滤波（van Herk，O(1)/像素） | 无 torch，且大遮罩下内存/耗时更稳 |
| 3 | 缩放/补边 | `F.interpolate` / `F.pad(replicate/reflect)` | Pillow `resize` / `np.pad(edge/reflect)`；reflect 不合法时退回 edge | 与参考实现同样的算法选择（lanczos/bicubic/area/nearest），reflect 兜底行为一致 |
| 4 | 羽化后遮罩外 | 高斯羽化向遮罩外扩散 | **alpha 钳回原始遮罩内** | 满足"遮罩外 `max_abs == 0`"零色差验收；过渡变成内侧羽化 |
| 5 | `fixed_point_size` | 白名单里挑不到严格不动点时原样返回 | 再兜底 `(resolution, resolution)`（正方形永远是严格不动点） | 契约承诺"返回真不动点"；测试里 `tol_ratio` 0~3 全部验证 |
| 6 | `decode_image` | BlueBox LoadImage 不处理 ICC | 非 sRGB ICC 用 ImageCms 转 sRGB | BUILD_CONTRACT 4.2 要求统一 sRGB 解码 |
| 7 | `decode_mask` | 只取 L 通道 | alpha 有变化取 alpha；alpha 恒不透明取亮度；全透明视为空遮罩 | 前端遮罩编辑器可能导出"白+透明"PNG，也可能导出黑底白图 PNG |
| 8 | `ratio` 画布 | —（BlueBox 只有固定点） | 在 32 网格上做 ±2~3 格搜索，优先保比例、其次保面积（面积误差 <15%，比例误差 <2%） | 简单四舍五入会把 16:9 舍成 2.7% 偏差；搜索后 16:9 + 1MP → 1312×736（比例误差 0.27%） |
| 9 | `crop_region/stitch_region` | 用 `map_*` 记录裁切偏移 | `CropInfo` 只存契约字段，补边偏移由中心对齐 + 32 规则**反推** | 契约的 `CropInfo` 字段是固定的 6 个；反推结果确定性一致 |
| 10 | `stitch_region` 的 mask | 只接受"裁切画布坐标"的 mask | 同时兼容"原画布坐标"（契约传入方式）与"裁切画布坐标" | pipeline 传入的 `mask_canvas` 是原画布尺寸 |
| 11 | 新增辅助 | 无 | `imaging.plan_to_pad_info()` / `imaging.crop_back_plan()` / `plan.resolution` / `imaging.parse_ratio()` / `imaging.image_meta()` | 服务端编排需要；其中 `crop_back_plan` 被 `server/pipeline.py` 直接调用，`CanvasPlan.resolution` 只给 BlueBox 工作流用 |

`composite` 的 `compare()` 语义补充：尺寸不同时直接返回 `max_abs=255 / mean_abs=255.0 / identical=False`
（视为完全不同），避免调用方对 `None` 做额外判断。

---

## 5. 参数推荐值

### 5.1 尺寸 / 画布

| 参数 | 推荐值 | 说明 |
| --- | --- | --- |
| `multiple` | **32** | Qwen-Image 2.1 唯一正确值；SD/SDXL 可用 8、Flux/SD3 可用 16（本项目固定 32） |
| `size_mode` | 编辑目标图用 **`follow`**；需要指定构图用 `ratio`；追求 BlueBox 级零偏移用 `fixed_point` | `follow` 最稳（不重采样），输出尺寸与输入一致 |
| `fit` | **`pad`** | `crop` 会裁掉内容边缘且不可逆；`stretch` 会变形，仅特殊情况用 |
| `pad_mode` | **`edge`** | 边缘复制最接近"画面延伸"；`reflect` 次之；`gray/black/white` 会让模型把纯色当内容 |
| `pad_value` | `0.5` | 仅 `pad_mode="gray"` 时生效（0.5 = 中灰 128） |
| `ratio`（`size_mode=ratio`） | UI 比例表（`1:1`/`4:3`/`16:9`/`9:16`/`3:2`/`2:3` 等） | 解析支持 `"16:9"`、`"16x9"`、`"16/9"`、`"16：9"`、`"1.777"`；小数 = 宽/高 |
| `megapixels`（`mode=ratio`） | **1.0**（缺省值） | 约 1024² 面积，Qwen-Image 2.1 的稳定档；2.2MP 用于 2K 出图 |
| `megapixels`（`mode=fixed_point`） | **1.0** | 用于推断 resolution 档（sqrt(面积) 夹到 512~2048、步进 32） |
| `resolution`（`fixed_point`） | 512 / 1024 / 1440 | 0.5MP→704、1MP→992、2.2MP→1472 左右；档位太小时白名单粗，比例保真度下降 |

### 5.2 局部编辑（方案 A：全画布 + 遮罩）

| 参数 | 推荐值 | 说明 |
| --- | --- | --- |
| `local.enabled` | 局部编辑时 `true`，纯重绘/大改为 `false` | `true` 走 `VAEEncode + SetLatentNoiseMask`，遮罩外 latent 不参与去噪 |
| `feather` | **32**（24~48） | 遮罩内过渡带宽度；太小有硬接缝、太大会吃掉细节 |
| `curve` | **`smoothstep`** | 过渡比 linear 更自然，不会出现可见的线性渐变带 |
| `color_match` | **`true`** | 开着更稳；纯色/极简画面可关 |
| `color_strength` | **0.6**（0.4~0.8） | `composite` 默认 0.6；`stitch_region` 默认 0.85（裁切块颜色漂移更大） |
| `mask_expand` | **0**（严格零色差验收必须为 0） | 需要盖住模型边缘接缝时用 3~8；此时"遮罩外"指外扩后的遮罩 |
| `context_factor`（方案 B） | **1.5**（1.3~1.6） | 裁切窗口 = 遮罩包围盒 × 该倍数 |
| `context_pixels`（方案 B） | **96**（64~128） | 叠加在倍数之外的额外上下文像素 |
| `blend_pixels`（方案 B） | **24**（24~48） | `mask=None` 时贴回边缘的线性 ramp 宽度 |

### 5.3 颜色

| 参数 | 推荐值 | 说明 |
| --- | --- | --- |
| 解码 | ICC → sRGB，统一 RGBA | 无 ICC 时按 sRGB 数值直读，不隐式变换 |
| 输出 | PNG（sRGB、剥离 ICC、8bit）；或 JPEG q95 / 4:4:4 | 需要透明通道时只能 PNG |
| `strength`（Reinhard） | `composite` 用 0.6，`stitch` 用 0.85 | 太低接缝色差可见，太高会把编辑区的色彩意图也拉回原图 |

### 5.4 显存 / token 预警

`align.latent_tokens(w, h, multiple=32)` 返回 `(ceil32(w)/32) * (ceil32(h)/32)`，
对应 Precise-Align 的告警阈值：**> 2048** 提示确认显存余量，**> 4096** 很可能 OOM。
服务端可以据此在前端给出中性提示（例如 2048×2048 → 4096 tokens）。

---

## 6. 契约未写清、由本模块定案的行为

1. **`ratio` 解析**：支持 `:` `：` `x` `X` `/` 五种分隔符和纯小数字符串；小数视为 `宽/高`；
   非法输入一律 `ValueError`（服务端应转成 `400 {"error":{"code":"bad_ratio"}}`）。
2. **`megapixels` 缺省值**：`ratio` 模式默认 **1.0MP**；`fixed_point` 模式默认取
   `sqrt(源图面积)` 后夹到 512~2048、步进 32 作为 resolution 档。
   `fixed_point` 的目标宽高比默认沿用**源图比例**（与 BlueBox `CutQwenImage21` 一致）；
   `width/height` 在该模式下只作为 resolution 档位的面积提示（例如 `1024×1024`
   表示"选 1024 档"），**不会被当成 1:1 目标画布**。
3. **`ratio` 画布取整**：不是简单四舍五入，而是在 32 网格上做小范围搜索（见第 4 节第 8 条），
   在面积误差 ≤15% 的候选里取比例误差最小者，再用面积误差 tie-break。
4. **`mode="follow"` 忽略 `fit`**：跟随源图时画布只比源图大 0~31px，不存在裁切空间，
   因此恒按"1:1 居中补边"处理（`scale=1.0`、`offset` 居中），不重采样、不裁切。
5. **`custom` 模式没有宽高** → `ValueError("size_mode=custom 必须提供 width 与 height")`。
6. **`decode_mask` 的 alpha 语义**：alpha 有变化 → 取 alpha（遮罩编辑器导出的"白=编辑、透明=不编辑"）；
   alpha 恒不透明 → 取亮度（普通黑底白图遮罩）；alpha 全透明 → 空遮罩 → `ValueError("遮罩为空")`。
   `invert=True` 在归一化之后反相。
7. **`crop_region` 的 `multiple`**：契约里 `stitch_region` 没有 `multiple` 参数，
   所以 stitch 内部固定按 **32** 反推补边。`crop_region` 的 `multiple` 请保持默认 32，
   否则二者不成对、贴回会错位（文档即警告）。
8. **`compare` 尺寸不同**：返回 `max_abs=255, mean_abs=255.0, identical=False`
   （视为完全不同），而不是抛异常。
9. **`composite` 的 `edited_canvas` 尺寸不一致**：不报错，按 bicubic 缩放到原画布尺寸
   （方便前端预览）；正式出图链路应保证尺寸一致。
10. **`plan_to_pad_info` 只支持 `fit="pad"`**：`crop`/`stretch` 的画布与源图不是
    "缩放+补边"关系，无法用 `PadInfo` 表达；这两种模式请用 `crop_back_plan`。
11. **`CanvasPlan.resolution`**：契约字段之外新增的带默认值字段（默认 0），
    仅 `fixed_point` 模式有值，不影响按契约字段构造的调用方。
12. **`plan_canvas` 的 `width/height` 提前校验**：`ratio` 模式若没给 `ratio` 但给了
    `width`/`height`，会用二者组成比例；若都没给则 `ValueError`。

---

## 7. 验收自检清单（团队 Lead 可直接跑）

```powershell
$PY = "<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe"
& $PY -m pytest tests/test_align.py tests/test_imaging.py -q
```

测试覆盖的硬验收点：

| 验收点 | 对应测试 |
| --- | --- |
| `snap_dims` 向上对齐 32 | `test_snap_dims_rounds_up_to_multiple` |
| `pad_image → crop_back` 的 `max_abs == 0`（5 补边 × 2 对齐） | `test_pad_crop_back_roundtrip_is_pixel_exact_scale_1` |
| 画布宽高均为 32 倍数 | `test_pad_image_canvas_is_multiple_of_32` |
| 遮罩映射到画布后位置正确 | `test_transform_mask_position_on_canvas`、`test_map_mask_to_canvas_position` |
| 512/1024/1440 返回真不动点 | `test_fixed_point_size_is_strict_fixed_point_for_main_resolutions` |
| `composite` 遮罩外 `max_abs == 0`（含羽化/颜色匹配） | `test_composite_outside_mask_is_pixel_identical` |
| `composite` 遮罩内来自 edited | `test_composite_inside_mask_comes_from_edited` |
| `feather_mask` 单调、`reinhard_match` 均值/方差对齐 | `test_feather_mask_center_is_one_edge_is_zero_and_monotonic`、`test_reinhard_match_pulls_mean_and_std_to_reference` |
| `crop_region → stitch_region` 遮罩外仍为原图像素 | `test_crop_region_stitch_roundtrip_outside_mask_is_original` |
| 矩形/椭圆覆盖区域正确 | `test_region_shapes_rect_coverage`、`test_region_shapes_ellipse_coverage` |
| 端到端尺寸/遮罩外一致 | `test_zero_offset_zero_color_pipeline_end_to_end` |
