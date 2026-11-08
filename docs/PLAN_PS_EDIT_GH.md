# 图片精修工作台（PS 式）与孤海节点方案融合设计

> 状态：**方案定稿（预案）**，本文只做设计，不改源代码。
> 参考输入：`qwen2.1九步局部编辑API.json`、`qwen2.1元素移除API.json`、`qwen2.1扩图API.json`
> 节点源码：`<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\Goohaitools-comfyui\nodes\`
> 现有实现：`server/align.py`、`server/imaging.py`、`server/pipeline.py`、`web/src/components/studio.js`、`web/src/components/studio/studioDoc.js`
> 模型选择：默认模型槽位、自动匹配与首启向导见 [`docs/PLAN_DEFAULT_MODELS.md`](PLAN_DEFAULT_MODELS.md)；本文的 LoRA 预设（移除 / 扩图 / 一致性）仍是任务级默认，可被系统设置里的同名槽位覆盖。

---

## 0. 结论摘要（先看这段）

**最终采用「融合管线」，不是照抄任何一方：**

| 能力 | 采用谁的 | 理由 |
| --- | --- | --- |
| 32 对齐 + `resolution=0` + latent==画布 | 现项目 / Precise-Align | 唯一能让"参考图坐标 == 采样坐标 == 出图坐标"成立的硬约束 |
| 采样尺寸不动点 | BlueBox `fixed_point`（可选档） | 连编码器内部隐式缩放也消除，追求极限时启用 |
| 遮罩包围盒区域化采样 | 孤海 `MaskCropV2` | 大图只算局部，速度提升最明显 |
| 大图预处理（长边钳制 768~2048、32 倍数） | 孤海 `图像缩放（范围）` | 直接解决"4K 原图送进去很慢" |
| 还原（放大回原尺寸 + 颜色还原 + 遮罩粘贴） | 孤海 `CropRestore` | 逐通道 gain/offset 比整图 Reinhard 更稳 |
| 遮罩外字节级保留 | 现项目 `composite/stitch_region` | 硬验收 `max_abs == 0`，孤海做不到字节级承诺 |
| 9 步手写 sigma | 孤海 `ManualSigmas` | 8 步 + 0.15 尾步，出图更稳，接缝更干净 |
| 任务 LoRA（移除/扩图/一致性） | 孤海 | LoRA 是按这套 sigma + 提示词约定训练的 |
| 提示词润色 | 现项目（已是孤海 PE 规范） | `data/pe_system_prompt_edit.txt` 已是同一套规范 |

**三项默认开启的保护：**

1. `zero_shift.enabled = true`（32 对齐、整数裁剪、`resolution=0`、byte-exact 遮罩外）
2. `preprocess.enabled = true`，`max_side = 2048`（仅当原图长边 > 2048 时真正缩放）
3. `color_restore.enabled = true`（区域还原 gain/offset 1.0 + 过渡带 Reinhard 0.6）

**采样：** 默认 `turbo.profile = "turbo9_gh"`（新预设，9 步，切 Turbo int8 底模，cfg 1.0，euler/simple）。

**UI：** 现有 `图片精修`（`studio.js`）已经是 PS 式骨架，直接在其上加「AI 指令」右栏、参考图条、输出设置、LoRA 面板、结果对比，不新开页面。

---

## 1. 三份工作流拆解

三份工作流共用同一套底座：**Qwen-Image 2.1 + Turbo int8 底模 + 手写 9 步 sigma + 区域裁剪 + 预处理缩放 + 还原**。差异只在 **LoRA、提示词约定、以及是否有外补画板**。

### 1.1 九步局部编辑

| 阶段 | 节点 | 关键参数 | 作用 |
| --- | --- | --- | --- |
| 权重 | UNETLoader | `qwen_image_2.1_turbo_int8_convrot` | Turbo 底模直接出 9 步 |
| 文本编码 | CLIPLoader | `qwen3vl_8b_bf16` | 视觉语言编码器 |
| VAE | VAELoader | `qwen_image_2.1_vae_bf16` | 编解码 |
| 调度 | ManualSigmas | `1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000, 0.0` | **9 个区间 = 9 步** |
| 功能 LoRA | LoraLoaderModelOnly | `Qwen2.1 一致性无偏移_GH_V1.0`，strength **0.48** | 抑制局部编辑的整体漂移 |
| 主图 | LoadImage | 图 01 | 编辑目标 |
| 参考图 | LoadImage | 图 02 …（最多 4 张） | 多图参考 |
| 区域裁剪 | `GH_MaskCropV2` | 扩展系数 上 1.3 / 下 1.4 / 左 1.4 / 右 1.4；输出「原像素」；倍数取整 0 | 只把遮罩附近送去采样，并记录「接缝」 |
| 预处理 | `GH_ImageScaleRange` | 长边 768 ~ 2048，32 倍数 | 大图缩小再送模型 |
| 编码 | `TextEncodeQwenImage21GH` | latent 1024×1024；mode **填充**；ref_image_size 自动 | 文本 + 参考图 + 遮罩 + latent |
| 采样 | SamplerCustomAdvanced | euler / simple / cfg 1.0 | 9 步去噪 |
| 还原 | `GH_CropRestore` | 遮罩扩展 4% / 羽化 5% / 颜色还原 1.0 | 贴回原图并校色 |

**核心思想：** 采样尺寸固定（1024²），把裁剪块按 contain 方式放进画布；出图后 LANCZOS 缩回裁剪块尺寸，按整数坐标贴回，再做逐通道颜色还原。所以它追求的是"**位置不漂移**"，不是"**零重采样**"。

### 1.2 元素移除

| 差异点 | 值 |
| --- | --- |
| 功能 LoRA | `Qwen2.1_万物移除Remove_GH`，strength **1.0** |
| 遮罩填充 | `遮罩填充 = true`（把闭合轮廓内的孔洞补满，避免只移除描边） |
| 编码参考图 | **主图 + 绿色蒙版叠加**（`图像合并（遮罩）`：透明度 0.4，匹配图像大小，背景=原图，覆盖图=纯绿） |
| 提示词 | `移除图像中的绿色区域` |
| 预处理 | 同 1.1 |
| 还原 | 同 1.1 |

**关键点：** 它把"要移除哪里"编码进**图像本身**（绿色区域），而不是只依赖 `noise_mask`。这是 Remove LoRA 的训练约定，必须复刻，否则 LoRA 效果会明显下降。

### 1.3 扩图

| 差异点 | 值 |
| --- | --- |
| 外补画板 | `孤海外补画板可视化`：单位=百分比，左 235 / 右 69 / 上 24 / 下 232（该实例），外补色 `#808080`，可设最大输出长边与整除数 |
| 功能 LoRA | `Qwen2.1_扩图_GH_3750`，strength **0.7** |
| 提示词 | `移除图像中的灰色区域，无缝自然延展为完整图像。` + 场景描述（拼接进同一段文本） |
| 裁剪 | `MaskCropV2` 关闭遮罩填充，扩展量由遮罩分析/数学运算推算 |
| 预处理 | 长边 `min(max(1024, 长边), 2048)`，32 倍数 |
| 还原 | 同 1.1 |

**关键点：** 扩图不是"直接生成大画布"，而是**先把灰边补进原图 → 让模型把灰色去掉 → 再裁回**。灰色是"待生成区域"的显式标记，和移除工作流用绿色是同一套思路。

---

## 2. 孤海节点逐个拆解（原理级）

### 2.1 `GH_MaskCropV2`（裁切 + 接缝）

输入：图像、遮罩、`遮罩填充`、四向扩展系数、输出尺寸（原像素 / 原像素1:1 / 自定义宽高）、自定义宽高、倍数取整。

**执行顺序：**

1. **空遮罩兜底**：白色像素 < 10 → 视为整图全白（等价"全图编辑"），这一点很重要，前端忘传遮罩时不会崩。
2. **孔洞填充**（可选）：把闭合轮廓内部为 0 的像素补成 1（扫描线填充），避免"只移除一圈边"。
3. **求包围盒**：`mask > 0.1` 的所有像素的最小/最大行列，`w = max_x-min_x+1`。
4. **四向扩展**（注意：不是乘包围盒，而是乘**最短边**）：

```python
短边 = min(遮罩宽, 遮罩高)
扩展上 = int(短边 * (系数上 - 1.0))
扩展下 = int(短边 * (系数下 - 1.0))
扩展左 = int(短边 * (系数左 - 1.0))
扩展右 = int(短边 * (系数右 - 1.0))
# 各自夹到图像边界，绝不越界
扩展上 = min(扩展上, 最小y)
扩展左 = min(扩展左, 最小x)
```

5. **中心不动 + 向上取整**（`原像素` 模式）：

```python
裁剪宽 = 基础右侧 - 基础左侧
裁剪高 = 基础底部 - 基础顶部
if 倍数 > 1:
    裁剪宽 = ceil(裁剪宽 / 倍数) * 倍数
    裁剪高 = ceil(裁剪高 / 倍数) * 倍数
中心x = (基础左侧 + 基础右侧) // 2
中心y = (基础顶部 + 基础底部) // 2
最终左 = 中心x - 裁剪宽 // 2
最终上 = 中心y - 裁剪高 // 2
```

6. **越界区域用边缘众数色填充**：`获取颜色众数()` 把边缘 10px 采样、颜色量化到 16 级后取众数，左/右/上/下分别填。这样补出去的部分是"画面延伸"，不是黑边。
7. **输出「接缝」结构**（还原所需全部信息）：

```
{ 原像素(w,h), 裁剪区域(top,bottom,left,right), 目标尺寸(h,w),
  缩放比例宽/高, 原始图像, 填充后遮罩, 未缩放裁剪遮罩,
  遮罩白色区域宽/高, 遮罩填充(bool), 填充信息(可选) }
```

**为什么它能做到位置不漂移：** 裁剪矩形由「整数中心 + 整数尺寸」推导，贴回时用同一组整数坐标，中间不经过任何"比例换算再取整"。

### 2.2 `GH_CropRestore`（还原）

1. 取接缝，拿到 `目标宽高`。
2. 若模型输出尺寸 ≠ 目标尺寸 → **PIL LANCZOS** 一次性缩到目标尺寸（只缩一次）。
3. **颜色还原**（`匹配裁剪颜色`）：

```python
# 只在"变化不大"的像素上取统计，避免把主体颜色带进参考
候选 = |目标 - 源| <= 24/255
协方差 = cov(目标, 源) / var(源)
增益 = clip(协方差, 0.9, 1.1)          # 每通道
偏移 = clip(mean(目标) - mean(源) * 增益, -24/255, +24/255)
修正 = 源 * 增益 + 偏移
输出 = 源 + 强度 * (修正 - 源)
```

4. **遮罩扩展/羽化按百分比**：`像素 = 百分比 × 遮罩白色区域宽/高`（不是按整图）。
5. **混合**：以原图为底，只在 `alpha > 0` 的像素写入；过渡带加入**确定性抖动**（interleaved gradient noise，幅度 < 1/255），消除 8bit 舍入造成的等值线。
6. 按整数坐标贴回。

> 注意：它没有"遮罩外逐字节相同"的强制约束——只要颜色还原是整块做的，裁剪块内、遮罩外的像素就会被整体 gain/offset 拉一下。这一点我们必须改进。

### 2.3 `图像缩放（范围）`（预处理）

规则（该节点 `calculate_target_size` + `apply_divisor_with_crop`）：

1. 长边夹到 `[最小尺寸, 最大尺寸]`（默认 768 / 2048），等比算出另一条边；
2. 用**覆盖缩放 + 居中裁剪**把宽高变成 `整除数`（默认 32）的倍数：
   - 先按目标比例把图缩放到"至少覆盖"目标框；
   - 再把多余方向**居中裁掉**（最多 31px）。

**评价：** 快、简单，但"居中裁剪"会吃掉最多 31px 内容，而且裁掉的偏移必须在接缝里记录，否则还原会整体偏半格。**我们改用"向上补齐 32 + 边缘填充"**，不裁内容、偏移恒为整数且可逆。

### 2.4 `TextEncodeQwenImage21GH`（编码核心）

关键输入：`latent_width/latent_height`（32 步进）、`mode ∈ {裁剪, 填充}`、`ref_image_size ∈ {自动, 具体面积}`、1~10 张参考图、可选 mask。

执行逻辑：

```python
latent_w, latent_h = round32(latent_width), round32(latent_height)
target_area = min(latent_w * latent_h, MAX_REFERENCE_AREA)

# 主图是否已经"基本等于"采样画布（允许小幅溢出）
primary_matches_target = _cover_crop_is_small(主图宽, 主图高, latent_w, latent_h)

if not primary_matches_target and ref_image_size == "自动" and 图数 <= 2:
    # 用主图面积决定参考图的统一面积，避免参考图被放得过大
    target_area = area_limited(主图宽, 主图高, target_area)

主图预处理：
  if primary_matches_target:
      mode == "填充" → _resize_contain_black(主图, latent_w, latent_h)   # 等比缩放 + 黑/灰边
      mode == "裁剪" → _resize_image(center crop)
  else:
      按 target_area 等比缩放（不强行塞进 latent 尺寸）

primary_latent = VAEEncode(预处理后的主图)   # 仅当尺寸完全匹配
if 不匹配:
    primary_latent = zeros(1, 64, latent_h//16, latent_w//16)

latent["noise_mask"] = prepared_mask   # 仅当尺寸匹配且给了 mask
```

**重要结论：**

- 它允许"采样画布"与"裁剪块尺寸"不一致。九步工作流里 latent 固定 1024²，裁剪块按 `填充` 塞进去，出图后再由 `CropRestore` 缩回。**这条路径存在一次额外的几何重采样**，是"看起来差不多、但边缘略糊"的来源。
- 我们**不采用**这条：本项目强制 `latent == 工作画布 == 参考图尺寸`，并在 `pipeline.py` 里用"零偏移守卫"硬报错。
- 它值得借鉴的是：**参考图面积上限**（避免 10 张 4K 参考图把显存打爆）和 **contain 预处理 + mask 同步 contain**。

### 2.5 `LoadImageGoohai`（遮罩语义）

- 遮罩存放在 PNG 的 **alpha 通道**：`mask = 1 - alpha`（画过的地方 alpha=0）。文件名形如 `...-goohai.png`。
- 另有"保留透明通道"开关：开启时原图 alpha 与遮罩 alpha 一起保留（RGBA 编辑）。

**我们沿用这个约定**：前端导出的蒙版就是「白色 + alpha」，`imaging.decode_mask` 已经是 alpha 优先，天然兼容。

### 2.6 `外补画板（可视化）`

```python
pads = [值 * 宽/100, 值 * 宽/100, 值 * 高/100, 值 * 高/100]   # 百分比单位
画布 = 纯灰(#808080) 填充
画布[上:上+h, 左:左+w] = 原图
mask = 1（外补区）; mask[内部] = 原遮罩
# 缩放：最大输出长边限制 → 整除数
# 取整时只调整"外补色块"，永不裁到原图
```

`_output_geometry` 的关键规则：**对齐/缩放产生的差额只在补边区里加减**，原图区域永远不动。这条规则我们直接抄。

### 2.7 `图像合并（遮罩）`（绿色提示图）

`output = lerp(原图, 纯绿, mask * 0.4)`。

用途：把"要移除的区域"变成图像内容，喂给 Remove LoRA。**这不是可视化，是模型输入的一部分。**

---

## 3. 无像素偏移 / 无色彩偏移的原理

### 3.1 偏移到底从哪来（逐项对照）

| # | 误差源 | 后果 | 孤海 | 本项目（现状） | 融合方案 |
| --- | --- | --- | --- | --- | --- |
| 1 | 画布宽高不是 32 倍数 | 最多 31px 整体位移 | 用"居中裁剪到 32"解决（吃内容） | `snap_dims` **向上** 32、整数补边 | 保持向上补边 |
| 2 | `resolution > 0` | 编码器内部再缩一次，亚像素偏移 | 该节点暴露 resolution，可传 0 | 固定 0 | 固定 0 |
| 3 | latent 尺寸 ≠ 画布 | 出图尺寸和坐标对不上 | 固定 latent 1024²，靠后处理缩回 | 守卫强制相等 | 强制相等 |
| 4 | 裁剪坐标浮点/四舍五入 | 贴回错格 | 整数中心 + 整数尺寸 | `CropInfo` 整数 | 整数 + 中心不动 |
| 5 | 出图尺寸 ≠ 裁剪尺寸 | 需要缩放 → 重采样 | LANCZOS 缩一次（接受） | 不允许不一致 | 允许，记录 `restore_scale` |
| 6 | 多次 resize | 细节糊 | 2 次（缩到 2048 + 缩回） | 0~1 次 | 2 次，且只发生在遮罩区域 |
| 7 | 32 对齐用裁剪 | 内容丢失、偏移 | 会丢 ≤31px | 不丢 | 不丢 |
| 8 | 遮罩单独缩放未同步 | 遮罩错位 | mask 同步 contain | `map_mask_to_canvas` | 同一变换矩阵 |

**融合方案的四条硬约束：**

```
C1  canvas_w % 32 == 0 且 canvas_h % 32 == 0（向上补齐，不裁内容）
C2  TextEncode.resolution == 0，且 latent.size == canvas.size
C3  所有裁剪/贴回坐标都是整数，且来自同一个 bbox（不二次取整）
C4  遮罩与图像使用同一个 scale + offset 变换（不允许各自 resize）
```

只要 C1~C4 成立，`源图 → 画布 → 出图 → 裁回` 在 `scale=1` 时就是**恒等几何变换**（现项目已有测试 `test_pad_crop_back_roundtrip_is_pixel_exact_scale_1`）。

### 3.2 色偏从哪来

| # | 误差源 | 处理 |
| --- | --- | --- |
| 1 | EXIF 方向 | `ImageOps.exif_transpose` |
| 2 | ICC（Display P3 / Adobe RGB） | `ImageCms` 转 sRGB；已是 sRGB 则跳过（避免 ±1 抖动） |
| 3 | 整图浮点混合后转 uint8 | 只写 `alpha > 0` 的像素，`alpha == 0` 一次都不赋值 |
| 4 | 羽化向遮罩外扩散 | 羽化后把 alpha 钳回原遮罩内（现项目已做） |
| 5 | 模型整体亮度/色温漂移 | 锚区估 gain/offset（BlueBox）+ 过渡带 Reinhard（现项目）+ 区域 gain/offset（孤海） |
| 6 | 8bit 舍入产生色阶断层 | 确定性抖动（孤海，<1/255） |
| 7 | 输出带旧 ICC | 输出 PNG 剥离 ICC |

**"零色差"的定义（验收口径）：** 在 `mask_expand = 0` 时，**遮罩外 `max_abs == 0`**（字节级，不是肉眼）。模型只允许改遮罩内。

**孤海的做法是"整块校色 + 按遮罩混合"，遮罩外虽然取原图像素，但裁剪块内的非遮罩区已经被 gain/offset 改过。** 所以：
- 我们保留它的 gain/offset 算法，但**只作用在遮罩内 + 过渡带**；
- 遮罩外继续用现项目的 byte-exact 合成。

### 3.3 为什么"无偏移"必须靠区域裁剪而不是整图

4K 图直接整图采样：`4096×2160 → 128×68 = 8704 latent token`，显存和耗时都不可接受，而且模型对超大画布的构图控制会变差（训练分辨率远低于此）。

孤海的解法：只采样"遮罩 + 上下文"这一块，通常 512~1024，token 数降到 1/20，速度快一个数量级，且遮罩外像素完全不动。

**这是三方方案里唯一真正解决"大图 + 局部编辑"的组合。**

---

## 4. 三方案对比与选型

### 4.1 对比表

| 维度 | 孤海（GH 节点） | Precise-Align（精准方案） | BlueBox | 本项目现状 |
| --- | --- | --- | --- | --- |
| 32 对齐 | 覆盖缩放 + 居中裁剪到 32 | 向上补边到 32 | 32 不动点（面积白名单搜索） | 向上补边到 32 |
| 编码器缩放 | 暴露 `resolution`，可 0 | 强制 0 | 不动点，让内部缩放成为恒等 | 强制 0 |
| latent 与画布 | **可不等**（固定 1024²，靠后处理缩回） | 强制相等 | 强制相等 | 强制相等 |
| 大图预处理 | **有**（长边 768~2048） | 无 | 无 | 无 |
| 局部区域采样 | **有**（bbox + 四向扩展） | 有 `CropEdit/Region` | 无（整画布） | 有（方案 B，统一 context） |
| 遮罩孔洞填充 | **有** | 无 | 无 | 无 |
| 遮罩外字节级不变 | 近似（整块校色会碰到） | **是**（`max_abs==0`） | 核心链路是；Color Calibrator 会改遮罩外低频 | **是** |
| 颜色还原 | 逐通道 gain/offset + 抖动 | 过渡带 Reinhard | **锚区仿射 + 对比度区间 + 低频移植**（事后校准） | 过渡带 Reinhard |
| 羽化方向 | 双向 | 向外（会改遮罩外） | — | 钳回遮罩内 |
| 扩图 | **有**（灰边 + 扩图 LoRA） | 无 | 无 | 仅规划 API |
| 元素移除 | **有**（绿边提示 + Remove LoRA） | 无 | 无 | 无 |
| 采样步数 | **9 步手写 sigma** | 用户自定 | 用户自定 | 8 步官方 / 6 步 viggle |
| 速度（4K 局部） | **最快** | 慢（整画布） | 慢（整画布） | 中（方案 B 可局部） |
| 几何精度 | 中（一次额外缩放） | **最高** | **最高** | **最高** |
| 可移植性 | 依赖 torch/ComfyUI 节点 | 需 ComfyUI | 需 ComfyUI | **纯 numpy+PIL，服务内直调** |

### 4.2 选型结论

**几何精度不能妥协 → 以本项目/Precise-Align 为骨架；速度与功能必须补齐 → 吸收孤海的区域化 + 预处理 + 任务 LoRA；极限档 → 暴露 BlueBox 不动点。**

即：

```
骨架：C1~C4 硬约束（本项目）
+  区域化预处理与还原（孤海）
+  颜色还原算法（孤海）+ byte-exact 合成（本项目）
+  事后校准的锚区估计与过渡带低频移植（BlueBox Color Calibrator）
+  9 步 sigma 与任务 LoRA（孤海）
+  fixed_point 可选档（BlueBox）
```

**明确不采纳：**
1. 孤海的"居中裁剪到 32"——会吃内容，和零偏移承诺冲突。
2. 孤海的"固定 latent 1024² + contain 填充 + 出图缩回"——多一次重采样，且会引入黑边被当成内容的风险。
3. Precise-Align 的"羽化向外扩散"——违反遮罩外零色差。
4. BlueBox 的"只解决尺寸、不解决大图速度"——单独用不够。

---

## 5. 融合方案（定稿）

### 5.1 总链路

```
主图 + 参考图 + 遮罩
   │ ① decode_image：EXIF → ICC→sRGB → RGBA（不做隐式色彩变换）
   ▼
[预处理] preprocess_plan：s = min(1, max_side / max(w,h))
   │   工作尺寸 (ws,hs) = round(w*s), round(h*s)
   │   canvas = snap32_up(ws,hs)，只在边缘补 ≤31px（edge），记录 offset
   ▼
[区域化] 若 mask 存在且 scheme != canvas：
   │   bbox = 孔洞填充后的遮罩包围盒
   │   四向扩展 = 短边 × (factor-1)，夹到图像边界
   │   中心不动，宽高向上取整到 32
   │   裁剪块超出画布的部分用"边缘众数色"填充
   │   crop 再按 preprocess.max_side 缩到 ≤ 预算（32 倍数）
   ▼
[编码] TextEncode(resolution=0)，latent = VAEEncode(工作画布)
   │   遮罩同步做同一变换（mask_canvas）
   │   局部编辑：scheme A → noise_mask；scheme B → 只采样 crop
   │   移除任务：额外把"绿色蒙版提示图"作为编码参考图
   ▼
[采样] 9 步 sigma（euler/simple/cfg 1.0）+ 任务 LoRA + 一致性 LoRA 0.48
   ▼
[还原] edited → LANCZOS 到 crop 原始尺寸（只一次）
   │   ① 漂移估计：只在"锚区"（遮罩外）统计 gain/offset（BlueBox 思路）
   │   ② 颜色还原：gain/offset 只作用遮罩内 + 过渡带
   │   ③ 过渡带融合：alpha 羽化，或低频移植（保细节、消接缝色块）
   │   ④ 诊断：实际改动比例 / 遮罩外泄漏（只读，不写像素）
   │   贴回整数坐标；遮罩外像素直接取自原画布（byte-exact）
   ▼
[回原尺寸] crop_back_plan → 源图尺寸（scale=1 时为恒等；预处理时为一次 LANCZOS）
   ▼
[输出] PNG（sRGB、剥离 ICC、8bit）+ quality 报告
```

### 5.2 预处理算法（新增）

**参数：**

```json
"preprocess": {
  "enabled": true,
  "max_side": 2048,
  "min_side": 768,
  "multiple": 32,
  "mode": "downscale_only"      // downscale_only | clamp_range
}
```

- `downscale_only`（本工作台默认）：只缩小不放大。原图 1200×800 → 不动；4000×3000 → 2048×1536。
- `clamp_range`（孤海语义）：长边夹到 [min_side, max_side]，小图也会被放大。**仅用于出图档位对齐，默认关闭。**

**实现草案（`server/imaging.py`）：**

```python
@dataclasses.dataclass
class PreprocessPlan:
    enabled: bool
    src_w: int; src_h: int
    work_w: int; work_h: int        # 缩放后（未补边）
    canvas_w: int; canvas_h: int    # 32 对齐后
    scale: float                    # work / src
    pad_x: int; pad_y: int          # 画布内偏移（整数）
    max_side: int

def preprocess_plan(w, h, *, enabled=True, max_side=2048, min_side=768,
                    multiple=32, mode="downscale_only") -> PreprocessPlan:
    scale = 1.0
    if enabled:
        long_side = max(w, h)
        if mode == "clamp_range":
            target = min(max(long_side, min_side), max_side)
        else:
            target = min(long_side, max_side)
        scale = target / long_side
    work_w = max(multiple, int(round(w * scale)))
    work_h = max(multiple, int(round(h * scale)))
    canvas_w = snap_up(work_w, multiple)
    canvas_h = snap_up(work_h, multiple)
    return PreprocessPlan(True, w, h, work_w, work_h, canvas_w, canvas_h,
                          scale, (canvas_w - work_w) // 2, (canvas_h - work_h) // 2,
                          max_side)
```

**还原：**

```python
def restore_preprocess(img, plan, method="lanczos"):
    # 先裁掉 32 补边，再缩放回源尺寸
    if (plan.canvas_w, plan.canvas_h) != (img.width, img.height):
        img = img.resize((plan.canvas_w, plan.canvas_h), LANCZOS)
    img = img.crop((plan.pad_x, plan.pad_y,
                    plan.pad_x + plan.work_w, plan.pad_y + plan.work_h))
    if (plan.work_w, plan.work_h) != (plan.src_w, plan.src_h):
        img = img.resize((plan.src_w, plan.src_h), LANCZOS)
    return img
```

> 只缩一次、只放一次；32 补边是整数裁剪，不参与重采样。

**已落地（`server/imaging.py`）：** `PreprocessPlan` / `preprocess_plan` / `apply_preprocess` / `restore_preprocess`。

- `work` 尺寸只做比例缩放，不强抬到 32；32 对齐只在 `canvas` 上做（小图/已对齐图不会被无谓放大）。
- `apply_preprocess` 用边缘复制补边；`restore_preprocess` 先整数裁掉补边，再唯一一次 LANCZOS 回源尺寸。
- `scale == 1` 且源尺寸已对齐时，`apply`/`restore` 是**纯恒等**（有单测逐像素比对）。
- 传入非预期尺寸直接 `ValueError`，杜绝"悄悄重采样"造成的偏移。
- 测试：`tests/test_preprocess.py`（12 条）。

### 5.3 区域化裁剪（移植 + 改良）

新增 `imaging.crop_region_factors()`，行为对齐孤海但保留本项目的 byte-exact 语义：

```python
def crop_region_factors(canvas, mask, *, fills,
                        expand_top=1.3, expand_bottom=1.4,
                        expand_left=1.4, expand_right=1.4,
                        multiple=32, max_side=0) -> tuple[Image, CropInfo]:
    m = mask if not fills else fill_mask_holes(mask)
    ys, xs = np.where(m > 0.1)
    if len(xs) < 10:                      # 空遮罩 → 全图
        return canvas, CropInfo.full(canvas)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    short = min(x1 - x0, y1 - y0)

    top    = min(int(short * (expand_top - 1)), y0)
    bottom = min(int(short * (expand_bottom - 1)), canvas.height - y1)
    left   = min(int(short * (expand_left - 1)), x0)
    right  = min(int(short * (expand_right - 1)), canvas.width - x1)

    # 中心不动 + 向上取整到 multiple
    cx, cy = (x0 - left + x1 + right) // 2, (y0 - top + y1 + bottom) // 2
    bw, bh = snap_up(x1 - x0 + left + right, multiple), snap_up(y1 - y0 + top + bottom, multiple)
    x, y = cx - bw // 2, cy - bh // 2

    # 越界 → 边缘众数色填充（孤海做法），或 edge 复制（无众数时兜底）
    crop = crop_with_color_fill(canvas, (x, y, x + bw, y + bh))

    # 再按预算缩小（可选）
    if max_side and max(bw, bh) > max_side:
        s = max_side / max(bw, bh)
        tw, th = max(multiple, round32(bw * s)), max(multiple, round32(bh * s))
        crop = crop.resize((tw, th), LANCZOS)

    return crop, CropInfo(x=x, y=y, w=bw, h=bh, src_w=canvas.width, src_h=canvas.height)
```

**与现有 `crop_region` 的差异（必须新增而非改旧）：**

| 项 | 现有 | 新增 |
| --- | --- | --- |
| 扩展 | 包围盒 × context_factor + 常量像素 | **短边 × 每向独立系数** |
| 孔洞 | 无 | **有**（扫描线填充） |
| 越界 | 不允许（会裁小） | **众数色填充，尺寸不变** |
| 尺寸 | 直接 32 对齐 | 中心不动 + 向上取整 |
| 空遮罩 | 报错/全图 | 全图（对齐孤海） |

**已落地（`server/imaging.py` + `server/align.py`）：**

- `crop_region_factors(...)` / `crop_with_color_fill(...)` / `align.fill_mask_holes(...)`；
- `stitch_region` 支持**越界裁切**：贴回时先与画布求交，越界处的合成像素直接丢弃（遮罩外仍 byte-exact）；
- `pipeline` 在不破坏旧客户端的前提下切换：`local` 里出现 `fills / expand_*` 才走新路径，否则沿用 `crop_region`；
- 单测：越界往返遮罩外 `max_abs == 0`、空遮罩返回整画布、空洞填充（U 形开口不填）。

### 5.4 还原与颜色

新增 `align.robust_color_match(src, ref, strength)`：

```python
def robust_color_match(src, ref, strength=1.0, tol=24/255, g_lo=0.9, g_hi=1.1, o_max=24/255):
    """逐通道 gain/offset；只用 |ref-src| <= tol 的像素估计，避免主体色污染。"""
    diff = np.abs(ref - src).max(axis=2) <= tol
    if diff.mean() < 0.02:                      # 参考像素太少 → 退回 Reinhard
        return reinhard_match(src, ref, strength)
    gain, offset = [], []
    for c in range(3):
        a, b = src[..., c][diff], ref[..., c][diff]
        g = float(np.cov(a, b)[0, 1] / (np.var(a) + 1e-4))
        g = float(np.clip(g, g_lo, g_hi))
        o = float(np.clip(b.mean() - a.mean() * g, -o_max, o_max))
        gain.append(g); offset.append(o)
    out = src * np.array(gain) + np.array(offset)
    return np.clip(src + strength * (out - src), 0, 1)
```

**应用范围（关键改良）：** 只对 `alpha > 0` 的像素做颜色还原（遮罩内 + 过渡带），遮罩外不动。

**还原顺序：**

```
1. edited_crop → LANCZOS 到 crop.w × crop.h
2. if color_restore: edited_crop = robust_color_match(edited_crop, 原crop, strength)
3. alpha = feather(expand(mask_crop, expand_px), feather_px)  # 百分比换算
4. out_canvas = 原画布 copy；只在 alpha>0 处写入 out = orig*(1-a) + edited*a
5. 过渡带 0<a<1 加 IGN 抖动（可选，默认开）
```

**落地差异（重要）：** `robust_color_match` **不单独实现**——它"用锚区估计 gain/offset"的思想已被 §5.4.1 的 `anchor_affine` 完整覆盖（且更完整：scale + shift + strength）。再写一个弱化版只会多出一条颜色路径，增加不可控性；保留 `reinhard_match` 作为锚区不足时的兜底。

过渡带抖动已落地为 `align.ign_dither(rgb, alpha, amount=1/255)`：

- 确定性 IGN（无随机种子），振幅乘 `4·α·(1-α)` 包络；
- `alpha == 0` / `alpha == 1` 的像素严格不变 → 不破坏 byte-exact；
- `composite` / `stitch_region` 新增 `dither` 参数（默认 `False`，`pipeline` 传 `local.dither`，缺省 `True`）。

### 5.4.1 事后校准：BlueBox Color Calibrator 的取舍

**结论：值得借鉴，但只借"估参数"和"过渡带融合"，不整体移植。**

源码锚点：`ComfyUI-BlueBox/nodes/color_calibrator_bluebox.py`（`ColorCalibratorBlueBox`，输入 原图 + 编辑图，输出 校准图 + 自动遮罩 + 改动比例）。

它是**事后自愈**节点：不参与采样，只把编辑图"按原图校正回来"。核心 6 步：

1. 工作图缩到长边 ≤1024，再算差异图；
2. 差异用 YCbCr：`0.4·|ΔY| + w·soft_sat(√(ΔCb²+ΔCr²))`，色度权重按全图中位色度/亮度比自适应（1.0~1.2），先做 σ=0.8 预模糊压噪；
3. 阈值用 MAD：`med + 3·1.4826·MAD`，夹在 `[thr, 2·thr]`；
4. auto 闭环：Kneedle 找阈值拐点 → 形态学 open 去小色块 → close + merge_dilate 补洞并合并前景 → 逐连通域按面积做 expand/feather（`expand = √(area/π)·0.15`，夹 8~64；`feather = 0.5·expand`）；
5. **锚区**（遮罩外）逐通道仿射：`scale = σ0/σ1`（夹 0.5~2）、`shift = μ0 - scale·μ1`，按 `strength` 插值；锚区 < 2% 直接跳过；
6. 融合：`outside_mode=edited` 时做**高斯金字塔低频移植** —— `out = I1 + (1-M_soft)·(low(I0) - low(I1))`（÷4、3 层、σ=2），只把原图的低频颜色/亮度搬回来，保留编辑图的高频细节；`original` 模式则是普通羽化 alpha 混合。

#### 借哪 4 点

| # | 它的做法 | 我们用在哪 | 必要改动 |
| --- | --- | --- | --- |
| B1 | **锚区估漂移**（遮罩外统计 gain/offset） | `robust_color_match` 的估计样本从"过渡带"改为"锚区" | 锚区本来应与原图一致，只剩模型漂移，估计最干净；校正仍只作用遮罩内 + 过渡带 |
| B2 | **scale + shift 双参数** | 现方案只有 gain/offset，补 `scale ∈ [0.5,2]`、`shift`（默认不夹紧）、`strength` 插值 | scale 夹紧防对比度崩坏；shift 不夹紧才能把整体漂移校干净（与 BlueBox 一致） |
| B3 | **过渡带低频移植**（金字塔低频差量） | 新增 `band_mode = "lowfreq"`：`out = edited + (1-M_soft)·(blur(orig)-blur(edited))`，只在 `0<alpha<1` 生效 | 比纯 alpha 羽化更能消"接缝色块/光晕"；必须把 `alpha == 0` 处的 delta 强制为 0，否则破坏 byte-exact |
| B4 | **差异图诊断**（YCbCr 加权 + MAD 阈值） | 新增 `quality.changed_ratio / leak_ratio`，前端显示"模型实际改动 %" | 只读不写：绝不拿自动遮罩去改像素，泄漏超阈值只报警不回写 |

额外一个低成本护栏：**锚区 < 2% 就跳过校色**（几乎整图都改时，锚区统计没有意义）。我们 `mask_expand=0` 且遮罩合理时锚区通常远大于 2%，只在"整图重绘"场景触发，正好避免误校。

#### 算法落到 `server/align.py`

```python
def anchor_affine(orig, edited, alpha, *, anchor_min=0.02,
                  scale_clamp=(0.5, 2.0), shift_abs=None, strength=1.0):
    """只在锚区（alpha == 0）统计，返回 (scale[3], shift[3], skipped)。"""
    anchor = alpha <= 0
    if anchor.mean() < anchor_min:
        return np.ones(3), np.zeros(3), True
    m = anchor[..., None]
    n = float(m.sum())
    mu0 = (orig * m).sum((0, 1)) / n
    mu1 = (edited * m).sum((0, 1)) / n
    sd0 = np.sqrt((((orig - mu0) ** 2) * m).sum((0, 1)) / n) + 1e-6
    sd1 = np.sqrt((((edited - mu1) ** 2) * m).sum((0, 1)) / n) + 1e-6
    scale = np.clip(sd0 / sd1, *scale_clamp)
    shift = np.clip(mu0 - scale * mu1, -shift_abs, shift_abs)
    scale = 1.0 + strength * (scale - 1.0)
    shift = strength * shift
    return scale, shift, False


def band_lowfreq_merge(orig, edited, alpha, *, levels=3, sigma=2.0, downscale=4):
    """过渡带低频移植；alpha == 0 处结果严格等于 edited（delta 清零）。"""
    band = ((alpha > 0) & (alpha < 1))[..., None]
    delta = _lowpass(orig - edited, levels, sigma, downscale)  # ÷4 算，再双线性放大
    return np.clip(edited + band * (1.0 - alpha[..., None]) * delta, 0, 1)
```

> 统计与低通都在 ≤1024 工作尺度算，参数量按 `work_scale` 折回全分辨率（与它的 `expand_full` 同一套做法）。

#### 明确不采纳

1. **`outside_mode = "edited"` 作为默认**：它会把遮罩外**所有**像素的低频也改掉，直接违反 `outside_max_abs == 0`。我们只允许低频移植落在过渡带内。
2. **auto 闭环全量搜索**（Kneedle 8 档 × 连通域 + open 16 次 + close 16 次）：单次请求开销不可控，且依赖 scipy 连通域。降级为"MAD 阈值 + 固定 open/close 各 1 次"，只在 `diagnose` 或用户未给蒙版时跑。
3. **用自动遮罩替代用户蒙版**：蒙版是契约（用户圈哪里就只改哪里），自动遮罩只做诊断与报警，不做权威输入。

#### 验收口径不变

引入以上 4 点后，硬指标仍是 **`mask_expand=0` 时遮罩外 `max_abs == 0`**；B3 的 delta 在 `alpha == 0` 处必须为 0，用 `test_band_lowfreq_merges_outside_untouched` 守住。B1/B2 只改遮罩内数值，不碰锚区。

### 5.5 采样：8/9 步双预设与 LoRA

**已落地（`server/config.py` 的 `TURBO_PROFILES`）：** 每种加速方式各给 8 步与 9 步两套预设，共 4 个。

| id | 加速方式 | 步数 | 调度 |
| --- | --- | --- | --- |
| `turbo8_official` | 挂 `qwen_image_2.1_turbo_lora_hifi_T8_v001` | 8 | `TURBO_SIGMAS + [0.0]` |
| `turbo9_official` | 同一加速 LoRA | 9 | `TURBO_SIGMAS + [0.15, 0.0]` |
| `turbo8_ckpt` | 切 Turbo int8 底模（不挂 LoRA） | 8 | `TURBO_SIGMAS + [0.0]` |
| `turbo9_ckpt` | Turbo int8 底模 | 9 | `TURBO_SIGMAS + [0.15, 0.0]` |

```python
TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568]
# 9 步 = 官方 8 步 + 0.15 低噪尾步；采样时再追加 0.0 → 10 个 sigma = 9 步
TURBO_SIGMAS_9 = TURBO_SIGMAS + [0.15]
```

**默认策略：**
- 文生图 / 图像编辑：`DEFAULTS["turbo_profile"] = "turbo8_official"`，保持 8 步不变。
- 图片精修（studio）：前端 `aiPanel.loadOptions()` 固定优先 `steps === 9` 的预设（即 `turbo9_official`），开启 Turbo 时默认 9 步。

> 现有采样代码已经支持预设 `sigmas` + `unet` 切换，**无需改采样代码**，只加预设即可。9 步预设与 `turbo9_gh`（孤海工作流）等价：官方 8 步表 + 0.15 尾步。

**LoRA 预设（新增 `LORA_TASKS`）：**

| id | 文件 | strength | 触发 |
| --- | --- | --- | --- |
| `consistency` | `Qwen-功能2.1/Qwen2.1 一致性无偏移_GH_V1.0.safetensors` | **0.48** | 默认常开 |
| `remove` | `Qwen-功能2.1/Qwen2.1_万物移除Remove_GH.safetensors` | **1.0** | 任务=移除 |
| `outpaint` | `Qwen-功能2.1/Qwen2.1_扩图_GH_3750.safetensors` | **0.7** | 任务=扩图 |
| `none` | — | — | 纯重绘/换风格 |

**约束：** 任务 LoRA 最多 1 个；一致性 LoRA 可与任务 LoRA 叠加；总 LoRA 数 ≤ 2（超过给前端黄条警告）。

**已落地（`server/config.py` + `server/pipeline.py` + `server/main.py`）：**

- `config.LORA_TASKS` / `resolve_lora_preset()` / `lora_presets_public()`（`/api/options` 的 `lora_presets` 只暴露 id/label/strength，不暴露文件路径）；
- `_build_loras` 支持 `{"preset": "remove"}`：按预设取文件与强度，显式 `strength` 可覆盖；未知预设直接 `PipelineError`；
- LoRA 数 > 2 时写 `job.meta["lora_warning"]`（不擅自丢弃任务 LoRA），前端结果条已有黄条位；
- 单测：预设解析、未知预设报错、`_build_loras` 展开预设。

### 5.6 掩码提示（green overlay）

| 任务 | 编码参考图 | latent | noise_mask |
| --- | --- | --- | --- |
| 局部编辑（默认） | 干净画布 | VAE(画布) | 有（scheme A） |
| 局部编辑（大图） | 裁剪块 | VAE(裁剪块) | 有（scheme B） |
| **元素移除** | **绿蒙版提示图** | VAE(提示图) | 无（LoRA 约定） |
| 扩图 | 灰边画布 | VAE(灰边画布) | 无（整块重绘 + 裁回） |

提示图构造：

```python
def mask_hint_overlay(canvas, mask, color=(0, 200, 80), opacity=0.4):
    out = np.asarray(canvas).astype(np.float32) / 255
    a = (mask * opacity)[..., None]
    out = out * (1 - a) + np.array(color) / 255 * a
    return Image.fromarray((out * 255).round().astype(np.uint8))
```

> 移除任务必须用"提示图"同时做编码参考与 latent 初始化（与孤海一致）；否则 LoRA 看到的输入分布和训练时不一致。
> **A/B 结论待测**：如果发现绿边泄漏，退化为"干净 latent + 绿提示仅作编码参考"，并记录在 `job.quality.hint_mode`。

**已落地（`server/imaging.py` + `server/pipeline.py`）：**

- `imaging.mask_hint_overlay(im, mask, color=(0,200,80), opacity=0.4)`：只染 RGB，alpha 原样；
- `imaging.crop_mask_for_region(crop, mask)`：把画布遮罩切到"模型输入"坐标系（含补边/缩放），保证提示图与裁切图对齐；
- 触发规则：`local.hint` 显式给出优先；`task.mode == "remove"` 且未给/给 `auto` 时自动 `green_overlay`；非法值回落 `none`；
- **别名归一（商用兼容）**：前端历史上传 `"green"`，旧数据可能是 `"overlay"` / `"mask"` / `"grey"`，
  统一映射为 `green_overlay` / `gray_fill`，不要求客户端改字段；
- **任务指令兜底**：`remove` 且提示词不含"绿色/绿区/green"、`outpaint` 且不含"灰色/灰边/gray/grey" 时，
  后端自动前置对应训练指令（`移除图像中的绿色区域。` / `移除图像中的灰色区域，无缝自然延展为完整图像。`），
  并写 `job.meta.prompt_augmented`。前端不需要自己拼这两句；
- 提示图**只替换参考图**（`ref_images[0]`），latent 仍来自干净画布（先按保守方案，A/B 后再定）；
- `job.quality.hint_mode` / `task_mode` 记录实际生效值。

### 5.7 扩图

不直接生成大画布，沿用孤海：

```
1. 用户拖拽扩展边 → 四边像素/百分比
2. 画布 = 灰色 #808080，原图贴入；mask = 外补区为 1
3. 画布缩放：长边 ≤ max_out_long_side → 对齐 32（只调灰边，不动原图）
4. 提示词 = "移除图像中的灰色区域，无缝自然延展为完整图像。" + 场景描述
5. 扩图 LoRA 0.7，9 步
6. 还原：只把外补区贴回（原图区 byte-exact）
```

**输出尺寸：** 扩图默认 `size_mode=custom`（画布尺寸 = 外扩后尺寸），不再裁回源尺寸。

**已落地（`server/imaging.py` + `server/pipeline.py`）：**

- `imaging.outpaint_canvas(src, left/right/top/bottom=百分比)` → `(画布, OutpaintInfo)`：
  左右按宽度百分比、上下按高度百分比；画布向上对齐 32，余量补到右/下，源图仍是整数偏移（贴回零重采样）；
- `imaging.outpaint_mask(info)`：外补区 = 1，源图区 = 0；用户 mask 存在时取 `np.maximum` 并集；
- `pipeline`：`task.mode == "outpaint"` 时跳过预处理、强制 follow 规划（画布 = 外扩画布）、
  输出不裁回、`hint_mode = "gray_fill"`（灰边即提示，不再叠加绿提示）、`zero_shift` 自动关闭；
- `job.align.outpaint` / `job.quality.outpaint` 记录几何；单测覆盖百分比/32 对齐/贴入像素/遮罩面积。

**商用护栏（防止"点了没反应"和"直接把显存打爆"）：**

- 四边百分比由 `/api/edit` 校验为 `0~200`，非数字/负数/超范围直接 400；
- `outpaint_canvas(..., max_side=8192)` 硬保护：外扩后长边超限抛 `ValueError`，
  管线转成可读的 `PipelineError`（扩图不裁回也不预处理，没有上限就会 OOM）；
- `task.mode="outpaint"` 但四边全为 0 → **退回普通编辑**并写 `quality.warnings`，
  绝不静默生成一张尺寸没变的图；
- `task.mode="remove"` 但没传遮罩 → 退回普通编辑并说明原因（Remove LoRA 依赖绿色选区）。

### 5.8 API 契约（`POST /api/edit`）

```jsonc
{
  "model": "qwen",
  "prompt": "把 @图一 中的苹果替换成 @图二 的梨子，保持光照与桌面材质",
  "prompt_raw": "用@图二的物品替换@图一中的苹果",

  "images": ["data:image/png;base64,...", "..."],   // 第 1 张 = 主图（图一）
  "mask":  "data:image/png;base64,...",             // 白色 + alpha，主图尺寸

  "task": { "mode": "edit" },                       // edit | remove | outpaint | inpaint | replace
                                                    // 前端 detectTask 的 inpaint/replace 在后端归一为 edit
  "size_mode": "follow",                            // follow | custom | ratio | fixed_point
  "width": null, "height": null, "ratio": null, "megapixels": 1.0,
  "resolution": 0,

  "preprocess": {
    "enabled": true,
    "max_side": 2048,
    "min_side": 768,
    "multiple": 32,
    "mode": "downscale_only"
  },

  "zero_shift": {
    "enabled": true,
    "strength": "strict"            // strict | balanced | off
  },

  "local": {
    "enabled": true,
    "scheme": "auto",               // auto | a | b | none
    "context_factor": 1.5,
    "context_pixels": 96,
    "expand_top": 1.3,
    "expand_bottom": 1.4,
    "expand_left": 1.4,
    "expand_right": 1.4,
    "fills": true,
    "feather": 32,
    "feather_pct": 0.05,
    "mask_expand": 0,
    "blend_pixels": 24,
    "color_match": true,
    "color_strength": 0.6,
    "color_restore": true,
    "color_restore_strength": 1.0,
    "band_mode": "lowfreq",         // alpha | lowfreq（过渡带融合方式）
    "hint": "none"                  // none | green_overlay（remove 任务自动 = green_overlay）
  },

  "color_guard": {
    "enabled": true,
    "outside_exact": true,          // 遮罩外 max_abs 必须为 0（前端已发这三个键）
    "icc": "srgb",
    // 注意：当前后端实际消费的是 local.color_restore / color_restore_strength /
    // band_mode；下面这些是契约预留，接入时映射到 local 或独立解析。
    "mode": "anchor_affine",        // anchor_affine | range | both | off
    "anchor_min": 0.02,             // 锚区占比低于此值 → 跳过校色
    "scale_clamp": [0.5, 2.0],
    "shift_abs": null,              // null = 不夹紧（默认，与 BlueBox 一致）
    "strength": 1.0,
    "range_restore": false,         // 兜底：锚区 0.5%/99.5% 分位对比度区间
    "range_clip_pct": 0.005,
    "range_clamp": [0.3, 3.0],
    "band_mode": "lowfreq",         // alpha | lowfreq
    "band_lowfreq_levels": 3,
    "band_lowfreq_sigma": 2.0,
    "diagnose": true                // 输出 changed_ratio / leak_ratio
  },

  "outpaint": { "left": 0, "right": 0, "top": 0, "bottom": 0,
                "unit": "px", "color": "#808080", "max_long_side": 4096 },

  "loras": [
    { "preset": "remove", "strength": 1.0 },
    { "preset": "consistency", "strength": 0.48 }
  ],

  "turbo": { "enabled": true, "profile": "turbo9_gh" },
  "seed": -1
}
```

**已落地（`server/pipeline.py`）：** `_zero_shift_spec()` + `verify_zero_shift()`。

- 仅在 `size_mode == "follow"` 生效；`custom / ratio` 自动降级为不校验（用户本就要新尺寸）。
- 前端默认发 `{enabled:true, snap:32, resolution:0}`；`resolution != 0` 或 `snap != 模型对齐值` 直接 `PipelineError`（拒绝出图，不做"偷偷纠偏"）。
- 出图前硬验收：画布必须是 `snap` 的倍数、输出尺寸必须等于源图，否则拒绝落盘。
- 结果写入 `job.align.zero_shift` 与 `job.quality.zero_shift`（`verified` 表示是否走过硬验收）。
- 单测：`tests/test_zero_shift_ps.py`（8 条）。

**响应（`GET /api/jobs/{id}` 的 `quality` 追加）：**

```jsonc
{
  "outside_max_abs": 0,
  "size_match": true,
  "canvas":   { "w": 2048, "h": 1152 },
  "source":   { "w": 4000, "h": 2250 },
  "output":   { "w": 4000, "h": 2250 },
  "offset_px": { "x": 0, "y": 0 },
  "preprocess": { "enabled": true, "scale": 0.512, "work": [2048, 1152] },
  "crop": { "x": 512, "y": 300, "w": 1024, "h": 896, "scale_back": 1.0 },
  "color": { "restore": true, "mode": "anchor_affine",
             "scale": [1.004, 0.998, 1.012], "offset": [0.002, -0.001, 0.004],
             "reinhard": 0.6, "band_mode": "lowfreq",
             "anchor_ratio": 0.78, "skipped": false },
  "changed_ratio": 0.0021,           // 模型实际改动像素占比（诊断）
  "leak_ratio": 0.0,                 // 遮罩外被改动像素占比（诊断，>0 报警）
  "scheme": "b",
  "steps": 9,
  "lora": ["Qwen2.1_万物移除Remove_GH.safetensors@1.0",
           "Qwen2.1 一致性无偏移_GH_V1.0@0.48"],
  "hint_mode": "green_overlay",
  "task_mode": "remove",             // 实际生效值（可能由 inpaint/replace 归一）
  "task_requested": "remove",        // 前端原始请求值，便于排查
  "seed": 1938472011,                // 实际生效 seed（前端传 null 时后端随机，供复现）
  "warnings": [                      // 不阻断出图，只解释"为什么结果和预期不一样"
    "未圈选区域，本次将按整图重绘"
  ],
  "elapsed_s": 18.4
}
```

### 5.9 默认参数表（前端默认值 = 后端默认值）

| 参数 | 默认 | 可调范围 | 说明 |
| --- | --- | --- | --- |
| `size_mode` | `follow` | follow / custom / ratio | 跟随主图分辨率 |
| `preprocess.enabled` | `true` | — | 大图保护 |
| `preprocess.max_side` | `2048` | 1024 / 1536 / 2048 / 2560 | 预处理尺寸 |
| `local.scheme` | `auto` | auto / a / b | auto：有遮罩且覆盖率 2%~45% → b，否则 a（与前端 `resolveScheme` 同口径） |
| `local.expand_*` | 1.3 / 1.4 / 1.4 / 1.4 | 1.0 ~ 2.0 | 上略小，保头部/天空 |
| `local.fills` | `true` | — | 孔洞填充 |
| `feather` | `32` | 0 ~ 96 | px（遮罩内） |
| `mask_expand` | `0` | 0 ~ 16 | 严格零色差时为 0 |
| `color_match` | `true` | — | 过渡带 Reinhard 0.6 |
| `color_restore` | `true` | — | 区域 gain/offset 1.0 |
| `color_guard.mode` | `anchor_affine` | anchor_affine / range / both / off | 锚区估漂移，只改遮罩内 |
| `color_guard.anchor_min` | `0.02` | 0 ~ 0.2 | 锚区不足则跳过校色 |
| `color_guard.band_mode` | `lowfreq` | alpha / lowfreq | 过渡带低频移植 |
| `color_guard.diagnose` | `true` | — | 输出 changed_ratio / leak_ratio |
| `turbo.profile` | `turbo9_gh` | — | 9 步 |
| `loras` | consistency 0.48 | — | 移除/扩图按任务自动切 |

---

## 6. 前端「图片精修」PS 工作台

### 6.1 现状与差距

现有 `studio.js`（1117 行）已经具备：打开/拖拽/粘贴、缩放平移、调色、旋转翻转裁剪、画笔/橡皮/矩形/椭圆蒙版、撤销重做、遮罩显隐与覆盖率、导出、收藏、送入图像编辑。

**PS 基础能力矩阵（目标态）：**

| 能力 | 现状 | 本次 |
| --- | --- | --- |
| 打开/拖拽/粘贴/多格式 | 有 | 保持 |
| 缩放/平移/适应/1:1 | 有 | 保持 |
| 旋转/翻转/裁剪 | 有 | 保持 |
| 调色（曝光/亮度/对比/饱和/色温/色调） | 有 | 保持 |
| 蒙版（画笔/橡皮/矩形/椭圆） | 有 | 加**套索**、Shift 约束、笔刷光标 |
| 撤销/重做/历史 | 有 | 扩展到图层与 AI 结果 |
| 图层（底图锁定 + 叠加层） | **无** | 新增 |
| 参考图（多图 + @引用） | **无** | 新增 |
| 文字指令 + 一键修改 | **无** | 新增 |
| 结果对比（分割/差异/统计） | 组件有、未接 | 接入 |
| 导出 PNG/JPG | 有 | 保持 |

**差距（本次要补）：**

1. 没有"指令框 + 一键修改"（目前只能导出后跳到 `图像编辑` 页）。
2. 没有多参考图（@图N）。
3. 没有图层面板（无法把扣好的图叠到主图上）。
4. 没有 AI 输出设置（分辨率/预处理/零偏移开关）。
5. 没有 LoRA 面板。
6. 没有结果对比（现有 `compare.js` 只在别处用）。

### 6.2 布局

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 顶栏  文件名 · 尺寸 · 缩放%  │ 适应 1:1 │ 撤销 重做 │ 对比 │ 导出 ▾ │ 修改 ⏎ │
├──────┬────────────────────────────────────────────────┬───────────────────┤
│ 工具 │                                                │ 右栏（可折叠）      │
│ 栏   │               画布（主图锁定为底图）              │  ┌ 指令 ────────┐ │
│ 48px │                                                │  │ textarea     │ │
│      │        ┌──────────┐                            │  │ @ 引用       │ │
│ 抓手 │        │  主图     │  ← 蒙版红色半透明叠加        │  │ 润色 / 修改   │ │
│ 裁剪 │        │ (locked) │                            │  └──────────────┘ │
│ 画笔 │        └──────────┘                            │  ┌ 参考图 ──────┐ │
│ 橡皮 │                                                │  │ 图一 图二 +   │ │
│ 矩形 │                                                │  └──────────────┘ │
│ 椭圆 │                                                │  ┌ 输出设置 ────┐ │
│ 套索 │                                                │  │ 分辨率/预处理 │ │
│ 移动 │                                                │  └──────────────┘ │
│      │                                                │  ┌ LoRA ────────┐ │
│      │                                                │  └──────────────┘ │
├──────┴────────────────────────────────────────────────┴───────────────────┤
│ 图层：底图🔒 · 叠加图1 · 叠加图2          结果：底图 | 结果1 | 结果2  对比  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6.3 文档模型（`studioDoc.js` 扩展）

```js
// 现有
new StudioDoc(image, name)
  .transform{rotate,flip,crop}  .adjust{...}  .mask(Canvas)  .bake()  .maskPng()

// 新增
doc.layers = [
  { id: 'base', type: 'base', locked: true, canvas },          // 主图，永不可拖动/删除
  { id: 'ov1',  type: 'overlay', src: <Image>, x, y, scale, rotation,
    opacity: 1, blend: 'normal', visible: true, locked: false },
]
doc.activeLayer = 'base'
doc.addOverlay(image)        // 上传扣好的 PNG → 自动居中 + 适配 60%
doc.moveOverlay(id, dx, dy)  // 主图上的叠加层可自由摆放
doc.flatten()                // 生成"工作图"：底图 + 调色 + 叠加层
doc.resultHistory = [{ jobId, url, prompt, quality, ts }]
```

**关键约束：**

- `base.locked = true`：主图不能移动、不能缩放、不能删除 → 保证所有坐标以主图为基准。
- 蒙版始终是**主图坐标系**的尺寸；叠加层参与 `flatten()` 后再作为 `images[0]` 送出。
- `flatten()` 输出 PNG 且尺寸 == 主图尺寸（叠加层超出部分裁掉）。

### 6.4 「画一个圈 → 自动成蒙版」

```
工具：椭圆(O) / 矩形(R) / 套索(L) / 画笔(B)
  mousedown  → 记录起点（画布坐标 → 主图坐标，除以 view.scale）
  mousemove  → 预览虚线
  mouseup    → 
     1. 若拖动距离 < 4px：视为单击 → 以笔刷大小画圆点
     2. 否则把图形填充进 doc.mask（白色 + 不透明）
     3. 套索：自动闭合首尾点，扫描线填充内部
     4. 按 hardness 对内边缘做一次轻微模糊（≤ 8px）
     5. 更新蒙版覆盖率 / 右侧"已选区域 xx%"
     6. 不自动提交，等用户点「修改」
```

**默认笔刷/图形参数：** size 64px（相对主图）、hardness 0.7、opacity 1.0；`Shift` 拖拽 = 正方形/正圆。

**蒙版叠加显示：** 红色 `rgba(255,60,60,0.38)` + 边缘 1px 高亮；`M` 键切换显隐。

### 6.5 指令输入与 @ 引用

```
┌─ 指令 ──────────────────────────────────────┐
│ 用 @图二 的物品替换 @图一 中的苹果            │
│                                             │
│ [@ 引用] [润色] [清空]        12 / 2000     │
└─────────────────────────────────────────────┘
```

- 输入 `@` → 弹出列表：`图一（主图 · 锁定）`、`图二`、`图三`…
- 选中后插入**不可编辑的 chip**（内部仍是 `@图二` 文本，提交前统一映射）。
- 提交前 `mapMentions(prompt)`：`@图一 → 图1`、`@图二 → 图2`（与模型参考图顺序一致）。当前 PE 规范用「图N」表述，不改。
- 未打 @ 但存在参考图时，前端提示："检测到 2 张参考图，建议用 @图二 指明用途"。

**快捷指令（chips）：** 去除选中物体 / 替换为… / 融合叠加图 / 扩图 / 消除水印 / 换背景 / 保持构图重绘。

### 6.6 LLM 润色

复用 `POST /api/polish`（后端已接 Ollama + 孤海 PE 规范 + 视觉）：

```js
const res = await api.polish({
  prompt: mappedPrompt,
  mode: 'edit',
  image_model: 'qwen',
  target_size: [workW, workH],
  images: [mainDataUrl, ...refDataUrls],
  references: [
    { index: 1, role: '主图（锁定底图）', has_mask: true, mask_coverage: 0.06 },
    { index: 2, role: '替换素材' },
  ],
});
```

**UI 行为：**

1. 点「润色」→ 按钮 loading（最长 5 分钟，`api.polish` 已设超时）。
2. 返回后展示**双栏 diff**：左=原指令，右=润色结果，可「采用 / 采用并编辑 / 忽略」。
3. 润色结果**回填到 textarea**，用户仍可改。
4. 失败不阻塞：toast 提示后可直接用原指令提交。

**system prompt 补充（可选，写进 `data/pe_system_prompt_edit.txt` 末尾）：**

```
编辑上下文补充：
- 用户会用「图N」指代参考图，第 1 张是编辑目标（主图），其余是素材参考。
- 若用户提供遮罩，遮罩标出的区域是"必须改变"的范围；遮罩外的内容必须原样保留。
- 当任务是"移除"时，描述被移除后露出的表面、光影与纹理，不要描述被移除物。
- 当任务是"扩图"时，明确写出向外延展的方向与内容衔接方式。
```

### 6.7 输出设置面板

```
┌ 输出设置 ─────────────────────────────────┐
│ 分辨率  ( • ) 跟随主图   4000 × 2250       │
│         (   ) 指定尺寸   [宽] × [高]       │
│         (   ) 比例       [16:9 ▾]  [1.0]MP │
│                                            │
│ ☑ 零偏移保护（32 对齐 · resolution=0）      │
│ ☑ 色彩保护（遮罩外像素不变 · 自动校色）      │
│                                            │
│ ☑ 图片预处理（大图先缩小，出图后还原）       │
│    预处理尺寸  [2048 ▾]  (1024/1536/2048/2560)│
│    预计工作画布  2048 × 1152               │
│                                            │
│ 局部策略  ( • ) 自动  (   ) 全画布  (   ) 裁切块│
│ 过渡羽化  [32] px      遮罩外扩 [0] px      │
└────────────────────────────────────────────┘
```

**实时反馈：** 改动分辨率/预处理时，立刻重算并显示"工作画布 / latent token 数 / 预计耗时档位"（用 `align.latent_tokens` 的阈值：>2048 提示、>4096 警告）。

### 6.8 LoRA 面板

```
┌ LoRA ─────────────────────────────────────┐
│ 任务      [自动识别 ▾]  (当前: 元素移除 1.0) │
│ ☑ 一致性   [0.48] ────────●────            │
│ 自定义   [+ 添加]                          │
│  ⚠ 任务 LoRA 与扩图 LoRA 不建议同时开启     │
└───────────────────────────────────────────┘
```

- 「任务」= 自动 / 无 / 元素移除 / 扩图 / 一致性；自动 = 根据指令关键词 + 任务模式推断，用户可改。
- 「一致性」默认勾选 0.48；滑块 0.2~0.8。
- 「自定义」：从 `/api/options` 的 LoRA 列表选（按 `Qwen-功能2.1` 优先排序），可填强度。
- 变更立即写入请求，不需要重新加载模型（后端按请求挂载）。

### 6.9 结果与对比

- 提交后：右下角任务卡（进度：准备模型 / 编码 / 采样 n/9 / 解码 / 合成）。
- 完成：结果进入底栏 `结果条`，画布切换为"结果预览"（可 `Tab` 在底图/结果间闪切）。
- 「对比」→ 复用 `openCompareDialog({ references:[baseUrl], results:[resultUrl] })`：
  - 左右分割滑块；
  - 差异模式（difference）；
  - 颜色统计（均值/最大差）；
  - 显示 `quality.outside_max_abs`（应为 0）与尺寸一致性。
- 「作为新底图」：把结果替换为主图（会清空蒙版，保留历史）。
- 「导出」：PNG / JPG（沿用 `doc.bake` + `/api/image/process`）。

### 6.10 任务状态机

```
idle → preparing(画布/预处理) → encoding → sampling(step/total)
     → decoding → compositing → done
                          ↘ error / cancelled
```

前端每 700ms 轮询 `/api/jobs/{id}`；`AbortController` 取消；切页不丢任务（job 存 `sessionStorage`）。

### 6.11 键盘与交互

| 键 | 行为 |
| --- | --- |
| `V` | 抓手 |
| `B` / `E` | 画笔 / 橡皮 |
| `R` / `O` / `L` | 矩形 / 椭圆 / 套索 |
| `M` | 蒙版显隐 |
| `[` `]` | 笔刷 -/+ |
| `Space`（按住） | 临时平移 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+Enter` | 提交修改 |
| `Tab`（按住） | 底图 / 结果闪切 |
| `Esc` | 取消框选 / 关闭对比 |

---

## 7. 实施清单（按阶段，均未执行）

### Phase 0 · 后端能力（不动 UI）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `server/config.py` | `TURBO_PROFILES` 增加 `turbo9_gh`；新增 `LORA_TASKS`（consistency 指向 GH 无偏移版 0.48，不影响 `config.consistency_lora` 与文生图默认）；新增 LoRA 预设解析函数 |
| 2 | `server/imaging.py` | 新增 `PreprocessPlan` / `preprocess_plan` / `restore_preprocess` / `crop_region_factors` / `crop_with_color_fill` / `mask_hint_overlay` |
| 3 | `server/align.py` | 新增 `fill_mask_holes` / `robust_color_match` / `ign_dither` |
| 4 | `server/pipeline.py` | `generate_edit` 接入预处理、区域化、颜色还原、提示图；`_build_loras` 支持 `preset`；`_plan_canvas_for` 支持 `preprocess`；`quality` 增加字段 |
| 5 | `server/main.py` | 校验 `preprocess` / `task` / `loras.preset`；`/api/options` 暴露 LoRA 预设与 9 步档 |
| 6 | `tests/` | 新增 `test_preprocess.py`、`test_zero_shift_ps.py`（见 §8） |

### Phase 1 · 前端工作台

| # | 文件 | 改动 |
| --- | --- | --- |
| 7 | `web/src/components/studio.js` | 右栏新增 `AI` 分页；顶栏增加「修改」；工具条加套索；快捷键 |
| 8 | `web/src/components/studio/studioDoc.js` | 图层模型、`flatten()`、结果历史 |
| 9 | `web/src/components/studio/aiPanel.js`（新） | 指令、@ 引用、润色、提交 |
| 10 | `web/src/components/studio/refStrip.js`（新） | 参考图上传/排序/删除/标注 |
| 11 | `web/src/components/studio/outSettings.js`（新） | 分辨率、预处理、局部策略 |
| 12 | `web/src/components/studio/loraPanel.js`（新） | 任务/一致性/自定义 |
| 13 | `web/src/components/studio/taskRunner.js`（新） | 提交 → 轮询 → 结果 → 事件 |
| 14 | `web/src/components/compare.js` | 复用，无改动（只传参） |
| 15 | 样式 | 在现有 studio 样式文件里加 `.studio-ai-*`，沿用现有 CSS 变量 |

### Phase 2 · 验收与灰度

16. 用 4 张典型图跑验收矩阵（见 §8.2）。
17. 对比开关前后：`outside_max_abs`、耗时、主观接缝。
18. 若绿提示泄漏 → 切 `hint=none` 回退，只保留少量任务开启。

---

## 8. 验收标准

### 8.1 硬指标

| # | 指标 | 通过标准 | 测法 |
| --- | --- | --- | --- |
| A1 | 遮罩外零色差 | `outside_max_abs == 0`（`mask_expand=0`） | 现有 `_outside_max_abs` |
| A2 | 输出尺寸 | follow 模式 == 源图尺寸 | `quality.size_match == true` |
| A3 | 几何零偏移 | 边缘标记图偏移 = 0px | 生成 1px 棋盘格边框，检测互相关位移 |
| A4 | 32 对齐 | canvas.w % 32 == 0 且 canvas.h % 32 == 0 | 断言 |
| A5 | 预处理可逆 | `restore_preprocess(preprocess(x))` 尺寸 == x 尺寸；偏移报告为 0 | 单测 |
| A6 | 采样式 | steps == 9，sigmas == 10 个值，末尾 0.0 | `job.quality.steps` |
| A7 | 区域裁剪不丢内容 | bbox 覆盖遮罩 + 扩展量；越界用众数色填 | 单测 |
| A8 | 色彩漂移 | 过渡带 ΔE00 均值 < 2.0 | 可选 |
| A9 | 速度 | 4K 图局部编辑 ≤ 整图耗时的 35% | 计时 |
| A10 | 改动比例可信 | `changed_ratio` 与人工标注面积误差 < 5% | 抽样对照 |

### 8.2 验收矩阵

| 用例 | 图 | 操作 | 预期 |
| --- | --- | --- | --- |
| U1 | 1024² 产品图 | 椭圆圈苹果 → "帮我去除苹果" | 遮罩外 0 差异；苹果消失、桌面纹理连续 |
| U2 | 4000×2250 | 同上（预处理 2048） | 输出 4000×2250；无偏移；耗时显著下降 |
| U3 | 1920×1080 | @图二 梨子 → "替换" | 梨子比例/光影合理；一致性 LoRA 生效 |
| U4 | 2000×3000 | 叠加扣好的 Logo → "融入主图" | 叠加层位置正确；边缘自然 |
| U5 | 2048² | 扩图 右+30% | 画布变宽；原图区 byte-exact |
| U6 | 任意 | 关闭预处理 + 关闭零偏移 | 对照组：能观察到偏移/色差 |

### 8.3 单测清单

```powershell
$PY = "<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe"
& $PY -m pytest tests/test_preprocess.py tests/test_zero_shift_ps.py -q
```

- `test_preprocess_downscale_only_never_upscales`
- `test_preprocess_work_dims_are_multiple_of_32`
- `test_restore_preprocess_roundtrip_size_exact`
- `test_crop_region_factors_expand_by_short_side`
- `test_crop_region_factors_center_preserved_and_snapped`
- `test_crop_region_factors_out_of_bounds_filled_with_mode_color`
- `test_fill_mask_holes_closes_ring`
- `test_robust_color_match_gain_offset_clipped`
- `test_anchor_affine_estimated_only_from_outside_mask`
- `test_anchor_affine_skips_when_anchor_below_min`
- `test_band_lowfreq_merges_outside_untouched`
- `test_restore_keeps_pixels_outside_mask_byte_identical`
- `test_green_hint_overlay_only_changes_mask_area`

---

## 9. 风险与回退

| 风险 | 表现 | 回退 |
| --- | --- | --- |
| 绿提示泄漏 | 移除区残留绿色 | `hint = none`，改用 noise_mask + 干净 latent |
| 颜色还原过度 | 遮罩内偏色 | 强度降到 0.5；或只用 Reinhard |
| 锚区估计失效（整图重绘） | 校色跑偏 | `anchor_ratio < 2%` 自动跳过，`quality.color.skipped = true` |
| 过渡带低频移植出色块 | 接缝处低频跳变 | `band_mode` 回退 `alpha`；或 `band_lowfreq_levels` 3→2 |
| 预处理放大后细节软 | 4K 输出不如原图锐 | 预处理尺寸提到 2560；或仅对 >4096 开启 |
| 区域裁剪太小 | 模型缺乏上下文、接缝差 | 扩展系数 1.3/1.4 → 1.5/1.6；`context_pixels` +64 |
| 9 步 Turbo 底模缺失 | 启动报错 | 预设回退 `turbo8_ckpt`；`job.meta` 标注 |
| LoRA 叠加冲突 | 画面崩坏 | 限制任务 LoRA ≤ 1；前端黄条 |
| 大图 OOM | 采样中断 | `vram_reserve`、tiled decode、预处理 max_side 1536 |
| 润色慢 | 提交等待 | 允许跳过润色直接提交；结果回填不阻塞 |

---

## 10. 附录

### A. 9 步 sigma（逐值）

```
1.000000
0.978453
0.954180
0.926626
0.895080
0.845148
0.704534
0.414568
0.150000
0.000000
```

---

### B. 任务 LoRA 对照

| 任务 | LoRA | 强度 | 提示词约定 |
| --- | --- | --- | --- |
| 局部编辑 | 一致性无偏移 GH V1.0 | 0.48 | 只描述"改成什么"，不描述遮罩外 |
| 元素移除 | 万物移除 Remove GH | 1.0 | `移除图像中的绿色区域`（+ 场景补充） |
| 扩图 | 扩图 GH 3750 | 0.7 | `移除图像中的灰色区域，无缝自然延展为完整图像。` + 场景 |
| 叠加融合 | 一致性 0.48（可叠加移除） | — | 说明叠加物的位置、透视、光照 |

### C. UI 文案

- 空状态：`拖入一张图片开始精修 · 主图会锁定为底图`
- 未画遮罩点修改：`未检测到蒙版：将按整图重绘。推荐先用椭圆/画笔圈出要改的区域。`
- 预处理开启：`大图会先缩到 {max_side}px 处理，完成后自动还原为 {w}×{h}，位置与颜色不会偏移。`
- 结果完成：`完成 · 遮罩外差异 0 · 用时 {s}s`
- LoRA 冲突：`任务 LoRA 与一致性 LoRA 可叠加，但总强度过高会让画面变"塑料"。`

### D. 决策记录（ADR 摘要）

1. **不采用孤海固定 latent + contain**：多一次重采样，且黑边可能被当内容。
2. **不采用居中裁剪到 32**：吃内容，违背零偏移承诺。
3. **遮罩外 byte-exact 是本项目的底线**，任何颜色算法都不得越过遮罩边界。
4. **预处理只缩不放**（默认），避免"小图被放大再缩回"造成的无谓损失。
5. **9 步 sigma 只对编辑任务默认开启**，文生图保持现有档位，避免影响既有出图风格。
6. **LLM 润色不阻塞提交**，失败即回退原文。

---

## 11. 施工记录与决策锚点（防走偏）

> 本节是施工台账：记录"现在已经有什么、这次只做什么、为什么这么定"。上下文丢失后先读这一节。

### 11.1 基线状态（2026-11-06）

| 模块 | 状态 | 位置 |
| --- | --- | --- |
| 前端 AI 工作台（F1–F6） | ✅ 完成并浏览器验证 | `web/src/components/studio/{aiPanel,payload,layers}.js`、`studio.js`、`studioDoc.js` |
| 几何核（snap/pad/crop_back/fixed_point） | ✅ 已有 | `server/align.py` |
| 遮罩核（dilate/feather/curve/band） | ✅ 已有 | `server/align.py` |
| 颜色核（Reinhard） | ✅ 已有 | `align.reinhard_match` |
| 合成（A：整图 / B：区域） | ✅ 已有，遮罩外 byte-exact | `imaging.composite`、`imaging.stitch_region` |
| 锚区仿射 / 过渡带低频移植 / 差异诊断 | ✅ 已落地（P1–P4），合成默认启用 | `server/align.py` |
| 9 步 Turbo 预设（`turbo9_official` / `turbo9_ckpt`） | ✅ 已落地，图片精修默认 9 步 | `server/config.py`、`web/src/components/studio/aiPanel.js` |
| 预处理几何（只缩不放 / 32 对齐 / 可逆还原） | ✅ 已落地（13 条单测） | `server/imaging.py`、`tests/test_preprocess.py` |
| 预处理接入 `pipeline.generate_edit` | ✅ 已接入（仅 `follow` 模式；`custom/ratio` 跳过） | `server/pipeline.py` |
| 裁切因子扩展 + 越界众数填色 + 空洞填充 | ✅ 已落地（含越界贴回无损单测） | `server/imaging.py`、`server/align.py`、`server/pipeline.py` |
| 任务 LoRA 预设（`LORA_TASKS` / preset 解析 / 超量警告） | ✅ 已落地 | `server/config.py`、`server/pipeline.py`、`server/main.py` |
| zero_shift 强制（resolution/snap 校验 + 出图前硬验收） | ✅ 已落地（8 条单测） | `server/pipeline.py`、`tests/test_zero_shift_ps.py` |
| `/api/edit` 参数边界校验（size_mode/preprocess/task/loras/zero_shift） | ✅ 已落地（13 条单测，入队前 400） | `server/main.py`、`tests/test_edit_validation.py` |
| 过渡带 IGN 抖动（`align.ign_dither`，默认开） | ✅ 已落地 | `server/align.py`、`server/imaging.py`、`server/pipeline.py` |
| 扩图（灰边画板 / 外补遮罩 / 不裁回输出） | ✅ 已落地 | `server/imaging.py`、`server/pipeline.py` |
| 端到端零偏移/零色差回归（假引擎，不占显存） | ✅ 5 条全链路（follow / 预处理 / 裁切越界 / 扩图 / 移除提示） | `tests/test_zero_shift_ps.py` |
| 前后端契约归一（`inpaint/replace` → edit、`green` → `green_overlay`、mask/local 类型与范围） | ✅ 已落地（校验 + e2e 覆盖） | `server/pipeline.py`、`server/main.py`、`tests/` |
| 扩图护栏（百分比 0~200 / `max_side=8192` / 空比例回退） | ✅ 已落地 | `server/imaging.py`、`server/pipeline.py`、`server/main.py` |
| 任务 LoRA 自动挂载（只传 `task.mode` 也生效） | ✅ 已落地 | `server/pipeline.py` |
| 质量告警 `quality.warnings`（未选区 / 近全遮罩 / 回退说明） | ✅ 已落地 | `server/pipeline.py` |
| 稳定性护栏：编辑画布 `max_side` 上限 + CUDA OOM 中文提示 | ✅ 已落地（e2e 覆盖） | `server/pipeline.py` |
| 输入限流：单张上传 64MB / 内联图片 48M 字符 / 最多 10 张 | ✅ 已落地（单测覆盖） | `server/main.py` |
| 任务指令兜底（remove/outpaint 自动补训练提示词） | ✅ 已落地（e2e 覆盖 3 条） | `server/pipeline.py` |
| 进度条单调（采样 offset）+ 采样中即时取消 | ✅ 已落地（2 条单测） | `server/pipeline.py`、`tests/test_zero_shift_ps.py` |
| 编辑任务回写生效采样参数（seed/steps/cfg/sampler/sigmas） | ✅ 已落地（历史可复现） | `server/pipeline.py` |
| 轮询/历史剔除内联图片（`slim_params`） | ✅ 已落地（2 条单测） | `server/jobs.py`、`tests/test_jobs.py` |
| 解码像素上限 120MP + `preprocess`/采样参数校验 | ✅ 已落地（4 条单测） | `server/imaging.py`、`server/main.py`、`tests/` |
| `local.scheme=auto` 后端解析（2%~45% 阈值） | ✅ 已落地（2 条 e2e） | `server/pipeline.py`、`tests/test_zero_shift_ps.py` |
| 业务错误不给用户看类名前缀 + `/files` 引用缺失友好提示 | ✅ 已落地（2 条单测） | `server/jobs.py`、`server/pipeline.py` |
| remove/outpaint 允许空提示词；`replay.json` 复用 `slim_params`；校验 LoRA 强度 | ✅ 已落地（3 条单测） | `server/main.py` |
| 真机回归（RTX 5090 / 真实权重，edit·remove·outpaint·turbo9） | ✅ 全部通过：遮罩外 `max_abs=0`、扩图真实照片接缝 1~24 RGB、移除无残留 | 见 §11.7 |
| 原生模式 `local.scheme=native`（不用遮罩合成） | ✅ 已落地（5 条 e2e + 真机回归），预处理/32 对齐/裁回全保留 | `server/pipeline.py`、`server/imaging.py`、`server/main.py` |
| 一致性 LoRA 默认挂载（`consistency` 预设） | ✅ 普通编辑默认挂，`local.consistency` / `consistency_lora` 可关 | `server/pipeline.py` |
| BlueBox 整图颜色一致性（`imaging.color_consistency`） | ✅ 原生模式默认开，`local.color_restore` 可关（3 条单测） | `server/imaging.py`、`tests/test_imaging.py` |
| 孤海裁切/接缝移植（`GH_MaskCropV2` + `GH_CropRestore`） | ✅ 已落地（4 条单测 + 真机回归），矩形台阶消失 | `server/imaging.py`、`server/pipeline.py` |

### 11.2 本轮切片（只做这四件）

| 步骤 | 产出 | 签名 |
| --- | --- | --- |
| P1 | 差异图 | `diff_map(original, edited, *, preblur=0.8, chroma_weight=1.0) -> (H,W) float32` |
| P2 | 锚区仿射 | `anchor_affine(original, edited, alpha, *, anchor_min=0.02, scale_clamp=(0.5,2.0), shift_abs=None, strength=1.0) -> (scale[3], shift[3], skipped)` |
| P3 | 过渡带低频移植 | `lowfreq_merge(original, edited, alpha, *, levels=3, sigma=2.0, downscale=4) -> float32 RGB` |
| P4 | 诊断 | `changed_stats(original, edited, mask=None, *, threshold=None) -> {threshold, changed_ratio, leak_ratio}` |

接入：`imaging.composite` / `imaging.stitch_region` 各加三个参数
`anchor_match=True`、`anchor_strength=1.0`、`band_mode="lowfreq"`，并把报告写进 `job.quality.color` 与 `quality.changed_ratio / leak_ratio`。

**状态：✅ P1–P4 已完成，`pytest tests -q` → 256 passed；合成默认启用，`color_match=False` 时整体关闭颜色链路。**

### 11.3 必须守住的决策（踩过就回滚）

1. **锚区必须用"原始硬遮罩"（`raw > 0`）判定，不能用羽化后的 alpha**。羽化带内原图与编辑图本就不同，混进统计会把参数估歪。
2. **`alpha == 1` 的像素直接写 `edited_u8`**，不要走 `float→rint` 往返：`7/255*255` 可能落成 `6.999…`，会把"遮罩内应完全等于编辑图"的单测打红。
3. **低频差量在 `alpha == 0` 处必须为 0**；实现上用 `(1 - alpha)` 天然归零 + 只写 `alpha > 0` 像素，双保险。
4. **锚区仿射与 Reinhard 互斥**：锚区可用时只做仿射；锚区不足（`skipped`）才回退 Reinhard。两个都做 = 二次拉色，过渡带会灰。
5. **自动差异遮罩只做诊断**：绝不拿它替代用户蒙版；`leak_ratio > 0` 只报警，不回写像素。
6. **诊断统计不得改变输出**：`changed_stats` 是纯函数，放在合成之后调用。
7. **不引入 scipy**：`align.py` 是 numpy + PIL 核，低通用现有 `_convolve_axis` + PIL 缩放实现。
8. **锚区仿射是 `color_match` 的子模式**：`color_match=False` 时连锚区仿射也不做，否则"关闭颜色匹配"关不干净（`test_composite_inside_mask_comes_from_edited` 会红）。
9. **诊断不预模糊**：`changed_stats` 的 `preblur=0`，否则边界外 1~2px 会被算成假泄漏；8bit 噪声本就低于阈值下限 0.02。
10. **诊断必须 try/except**：`pipeline` 里 `changed_stats` 失败只打印，不拖垮出图。
11. **提示模式默认值必须是空字符串，不能是 `"none"`**：`local.hint` 缺省时留空，才能走到「`remove` 自动上绿提示」分支；显式传 `"none"` 才关闭。写成 `or "none"` 会让自动分支永久失效（已修，勿回退）。
12. **端到端测试用假引擎，不加载真实权重**：`Pipeline(engine=fake)` 直接注入，`_resolve_models` / `_build_loras` / `storage.save_*` 在测试内临时替换并在 `finally` 复原。断言落盘 PNG 的遮罩外 `max_abs == 0`，而不是只看 `job.quality` 中间值。
13. **任务名必须归一，不能按字符串白名单硬拒**：`inpaint` / `replace` 是前端 `detectTask` 的合法产出，后端映射为 `edit`；以后新增任务名只改 `_TASK_ALIASES`，不要动校验白名单逻辑。
14. **扩图必须有上限与回退**：`outpaint_canvas` 的 `max_side` 是防 OOM 的最后一道闸；API 只做 `0~200` 范围校验；四边全 0 时退回普通编辑并写 `warnings`——既不要 400 卡住用户，也不要静默生成一张尺寸没变的图。
15. **告警写 `quality.warnings`，不阻断出图**：用户要能在结果面板看到"为什么和预期不一样"（未选区、近全遮罩、任务回退），后端只解释、不替用户改参数。
16. **编辑与文生图共用 `cfg["max_side"]`（默认 4096）**：`custom/ratio` 或用户关掉预处理时，画布可能远超显存；在 VAE 编码前抛 `PipelineError`，不要等 CUDA OOM。采样异常里只翻译 `out of memory`，其它异常原样上抛，避免掩盖真实 bug。
17. **输入必须先限流再解码**：`/api/upload` 单张 64MB，`/api/edit` 内联图片文本 48M 字符（约 36MB 原图）、最多 10 张。`images[i]` 允许 `{data}` / `{url}` / 裸字符串三种形态，只校验"有没有数据 + 大不大"，不做格式猜测。
18. **训练约定由后端兜底，不指望前端拼提示词**：`remove` / `outpaint` 的指令句是 LoRA 效果的一部分；用户提示词里已含关键词时不重复追加，保证幂等。
19. **采样进度必须带 offset**：采样前已占 3~4 格（准备/编码/VAE），回调从 `offset + n` 递增；直接写 `n/total` 会让进度条从 4/15 退回 1/15。文案用真实 `steps`，不拿 `total` 当分母。
20. **采样参数必须回写 `job.params`**：前端通常传 `seed=null`，若不在任务里落一份生效值（seed/steps/cfg/sampler/sigmas），历史与 `replay.json` 永远无法复现同一张图。
21. **轮询/历史接口不得回传内联图片**：`/api/jobs/{id}` 每 700ms 一次，一张 4K 图 data URL 十几 MB；`slim_params` 统一替换成占位符，原图看 `meta.input_urls`。任务结束后同样瘦身，避免历史常驻大字符串。
22. **解码前按文件头尺寸拦截**：`MAX_DECODE_PIXELS = 120MP`，在 `load()` 之前判断，否则小体积 PNG 能把服务端内存打爆；`preprocess.min_side` / `multiple`、`steps/cfg/denoise`、`sampler/scheduler` 一律入队前 400。
23. **`auto` 方案前后端同口径**：有遮罩且覆盖率在 2%~45% 才走方案 B，避免大遮罩裁出超大块反而更慢；阈值改动必须两边一起改。
24. **错误文案面向用户，不面向开发者**：`server.*` 抛出的 `RuntimeError` 子类（`PipelineError`）只回中文正文，去掉 `ClassName:` 前缀；`/files` 引用被清理时提示"图片不存在或已被清理"，不要漏 `FileNotFoundError`。
25. **`remove` / `outpaint` 不强制提示词**：这两类任务的训练指令由后端补全，第三方只传 `task.mode` + 图 + 遮罩即可；普通编辑仍要求指令，否则等于随机整图重绘。
26. **`remove` 的绿提示不可关闭**：既然 remove 会自动挂 Remove LoRA，就必须同时给「绿色选区」提示，否则模型输入分布与训练不一致、移除效果明显退化。显式传 `hint="none"` 时仍强制 `green_overlay`，但要在 `quality.warnings` 里说明原因，不静默改写用户参数。
27. **扩图回归必须用真实照片**：纯色渐变 + 白色矩形这类"卡片感"合成图会被模型理解成「一张画贴在背景上」，输出画框 + 投影；这属于模型语义判断，不是管线缺陷。验收扩图质量用照片素材，合成图只用来测几何（尺寸/偏移/遮罩外 byte-exact）。
28. **方案 B 贴回必须先羽化**：`stitch_region` 拿到的是 0/1 硬遮罩，直接当 alpha 会把模型重绘的背景/投影沿遮罩边界切成直角台阶（真机可见的"矩形像素块"）。现在先按 `blend_pixels`（默认 24）做高斯羽化，再钳到 `hard_alpha > 0`：遮罩外仍逐字节保留，遮罩内多出 24px 过渡带。
29. **"几乎没改"的像素必须压回原图（逐像素软阈值）**：模型会把遮罩内整块区域重画一遍，纯渐变/纯色墙背景上会带 1~8 级偏色与 ±1 噪点，沿矩形遮罩拼出一个肉眼可见的淡矩形。`_suppress_small_changes` 用
    `out = src + (dst - src) * smoothstep(|dst - src|; low=6, high=16)`（0~255 色阶）做**逐像素、单调、值域压缩**：差异 ≤6 精确回到原图（字节级），≥16 原样保留（物体、接触投影、真实改动），中间平滑过渡。
    必须避开的两种写法：`alpha *= gate` 这类乘性闸门会在两场交界留下等高线（真机直接看到一圈"线框"）；对闸门做空间模糊会把物体颜色糊出边界形成光晕。该步骤放在 `lowfreq_merge` **之后**，否则低频移植会把压掉的小残差重新引入。
30. **原生模式：整张画布就是模型输出，不做任何遮罩合成**（`local.scheme="native"`，`"raw"` 是别名）。用户实测孤海节点无偏移，要求提供同款路径：
    - **必须保留**的零偏移闭环：大图预处理（缩小到 `max_side`）→ 32 对齐画布 → `resolution=0` → 采样 latent == 画布 → 整数裁回 → 预处理还原。这条链一步都不能少，否则就会出现像素偏移。
    - **不保留**的：羽化、`noise_mask`、`composite` / `stitch_region`、`_suppress_small_changes`、遮罩外 byte-exact 承诺（`quality.outside_max_abs` 如实返回 `null`）。
    - 无遮罩（整图编辑）时自动走原生：本来就没有"遮罩外"可保留，且只有这条路径能给整图做 BlueBox 校色。
    - 最后一步用 :func:`imaging.color_consistency` 做**整图**锚区仿射（不再是过渡带）：以 `|dst-src| <= 6` 的像素为锚区估逐通道 `scale/shift`，把 VAE 编解码的 1~5 级整体漂移拉回；`local.color_restore=false` 可关。锚区不足 5% 时跳过（例如整图都被重画）。
    - 开关清单：`local.scheme`（`a` / `b` / `auto` / `native`）、`local.consistency`、`params.consistency_lora`、`local.color_restore`、`local.color_restore_strength`、`preprocess.enabled`。
    - 一致性 LoRA 默认挂：普通编辑且请求未带 `loras` 时自动 `{"preset": "consistency"}`（与孤海工作流一致）；`remove` / `outpaint` 仍优先挂各自任务预设。注意判断必须写成 `cons_switch is not None and not _truthy(cons_switch)`，否则未传该键时 `_truthy(None) == False` 会把默认值误关。
31. **`anchor_affine` 遇到纯色通道只校偏移**：标准差 `< 1/255` 的通道（白底商品图、纯色海报）增益没有统计意义，硬套 `sd0/sd1` 会撞到 `0.5` 下界，把物体颜色撕开（实测蓝色通道 10 → 49）。现在这类通道 `scale` 固定 1.0，只应用 `shift`。
32. **接缝学习孤海 `GH_CropRestore`：先向外膨胀再羽化，不能只往内羽化**。旧实现把 `alpha` 硬钳在原始遮罩内（`alpha *= hard_alpha > 0.5`），模型重绘的那一圈背景在遮罩线处被硬切，真机放大能看到矩形台阶；孤海的做法是把写入范围跨到遮罩外再羽化，接缝自然是渐变的。照此移植（`server/imaging.py` + `server/pipeline.py`）：
    - **裁切几何**（`GH_MaskCropV2`）：遮罩包围盒短边 × 每向系数（上 1.3 / 下左右 1.4），`fills` 可选填洞，窗口 32 对齐；不再要求前端显式传 `expand_*` 才启用（旧逻辑默认走 `crop_region(1.5, 96px)`，与孤海不是一套几何）。
    - **裁切块缩放**（孤海节点 8）：长边夹到 `[crop_min_side, crop_max_side]`（默认 `768 ~ 2048`）、两边 32 倍数，**小遮罩也放大**再送模型；`CropInfo.model_w/h` 记录模型输入尺寸，`stitch_region` 与 `crop_mask_for_region` 都按它映射，贴回时再缩回原始裁切尺寸。`local.crop_min_side=0` 可关。
    - **还原**（`GH_CropRestore`）：`expand_px = int(遮罩包围盒平均边长 × expand_pct/100)`（默认 4）、`feather_px` 同理（默认 5）；先 `dilate_mask` 再 `feather_mask`，高斯核支持之外严格不写。
    - **颜色还原安全夹取**：`anchor_affine` 加 `scale_clamp=(0.9, 1.1)`、`shift_abs=24/255`（与孤海 `匹配裁剪颜色` 一致），避免把物体真实色差当漂移放大。
    - **验收口径**：方案 B 的 `outside_max_abs` / `leak_ratio` 以「膨胀 + 羽化」带的外沿为界（`color_report.mask_band`），带外仍要求逐字节 0；带内是用户显式选择的过渡带。

### 11.4 集成点（改前先看这几处）

| 位置 | 说明 |
| --- | --- |
| `server/align.py#L46-L67` | `__all__`，新函数要登记 |
| `server/align.py#L561-L595` | `_convolve_axis` / `feather_mask`，低频核复用 |
| `server/imaging.py#L1006-L1125` | `stitch_region`：`color_match` 分支在 L1110，混合写回在 L1118 |
| `server/imaging.py#composite` | 同一套颜色分支，改法保持一致 |
| `server/pipeline.py` | `quality.outside_max_abs` 附近追加 `changed_ratio / leak_ratio` |
| `web/src/components/studio/aiPanel.js` | 质量标签已就绪，字段缺失时自动隐藏 |

### 11.5 验收命令

```powershell
$PY = "<COMFY_ROOT>\ComfyUI-aki-v3.2\python\python.exe"
& $PY -m pytest tests/test_align.py tests/test_imaging.py -q
```

通过标准：
- 现有 `test_composite_outside_mask_is_pixel_identical`、`test_stitch_region_outside_exact` 全绿（新参数默认值不得破坏 byte-exact）；
- 新增 5 条：`test_anchor_affine_estimated_only_from_outside_mask`、`test_anchor_affine_skips_when_anchor_below_min`、`test_band_lowfreq_merges_outside_untouched`、`test_diff_map_detects_color_shift`、`test_changed_stats_reports_leak`；
- `band_mode="lowfreq"` 时 `alpha == 0` 与 `alpha == 1` 的结果分别严格等于原图与编辑图。

### 11.6 后续队列（本轮之后）

1. ~~`preprocess.py`（缩放/还原/32 对齐）+ `test_preprocess.py`~~ ✅ 已完成（`imaging.py` 内实现）
2. ~~preprocess 接入 `pipeline.generate_edit`（预处理 → 画布 → 还原闭环）~~ ✅ 已完成
3. ~~`crop_region` 扩展系数 + 越界众数填色~~ ✅ 已完成
4. ~~`local.fills / hint=green`（移除场景）~~ ✅ 已完成（fills 已用于裁切/空洞；hint 自动触发）
5. ~~前端 `changed_ratio / leak_ratio / color.skipped` 标签联调~~ ✅ 已完成（`aiPanel.renderQuality`）

**剩余（按优先级）：**

6. ~~任务 LoRA：`config.LORA_TASKS`（remove 1.0 / outpaint 0.7）+ `_build_loras` 支持 `preset`~~ ✅ 已完成
7. ~~`zero_shift` 强制：前端传入后按 `align.plan` 校验，不对直接拒绝~~ ✅ 已完成
8. ~~`server/main.py`：`preprocess / task / loras.preset` 参数校验（`/api/options` 已暴露 LoRA 预设）~~ ✅ 已完成
9. ~~`align.robust_color_match` / `ign_dither`（低频抖动，防色带）~~ ✅ `ign_dither` 已落地；`robust_color_match` 由 `anchor_affine` 取代，不再单独实现
10. ~~扩图（outpaint）：灰边画布 → 重绘 → 裁回~~ ✅ 已完成（输出不裁回，保留外扩尺寸）
11. ~~`tests/test_zero_shift_ps.py`：端到端零偏移/零色差回归~~ ✅ 几何守卫 8 条 + 假引擎端到端 11 条（`generate_edit` 全链路；真实权重的出图回归仍由本机环境另跑）
12. ~~前后端契约归一：`inpaint/replace` → edit、`hint:"green"` → `green_overlay`、mask/local 类型与范围~~ ✅ 已完成（含 e2e 覆盖）
13. ~~扩图商用护栏：`0~200` 百分比校验、`max_side=8192` 防 OOM、空比例退回普通编辑~~ ✅ 已完成
14. ~~`quality.warnings` 告警 + 任务 LoRA 自动挂载~~ ✅ 已完成（`/api/options` 同步暴露 `task_modes` / `outpaint_percent` / `outpaint_max_side`）
15. ~~稳定性护栏：编辑画布 `max_side` 上限、CUDA OOM 中文提示~~ ✅ 已完成（e2e 覆盖 2 条）
16. ~~输入限流：上传体积、内联图片体积、参考图张数~~ ✅ 已完成（单测覆盖 3 条）
17. ~~任务指令兜底：remove/outpaint 自动补训练提示词（幂等）~~ ✅ 已完成（e2e 覆盖 3 条）
18. ~~进度条倒退修复 + 采样中即时取消~~ ✅ 已完成（`_make_callback(offset, steps)`，2 条单测）
19. ~~编辑任务回写生效采样参数（seed/steps/cfg/sampler/sigmas）~~ ✅ 已完成（`quality.seed` 同步输出）
20. ~~轮询/历史剔除内联图片（`jobs.slim_params`）~~ ✅ 已完成（2 条单测）
21. ~~解码像素上限 120MP + `preprocess`/采样参数入队前校验~~ ✅ 已完成（4 条单测）
22. ~~`local.scheme=auto` 后端解析（与前端同阈值）~~ ✅ 已完成（2 条 e2e）
23. ~~业务错误去掉类名前缀 + `/files` 引用缺失友好提示~~ ✅ 已完成（2 条单测）
24. ~~remove/outpaint 允许空提示词、replay 复用 `slim_params`、LoRA 强度校验~~ ✅ 已完成（3 条单测）
25. ~~真实权重端到端回归（edit / remove / outpaint / turbo9）~~ ✅ 已完成，见 §11.7
26. ~~原生模式 `local.scheme=native` + 一致性 LoRA 默认挂载 + BlueBox 整图校色（全部带开关）~~ ✅ 已完成（5 条 e2e + 3 条 imaging 单测 + 真机回归，见 §11.7）
27. ~~移植孤海 `GH_MaskCropV2` / `GH_CropRestore` 的裁切与接缝（含裁切块 768 放大、4%/5% 膨胀羽化、gain 0.9~1.1 夹取）~~ ✅ 已完成（见决策 32、§11.7）

### 11.7 真机回归记录（2026-11-07，RTX 5090 / torch 2.13.0+cu130）

服务用当前代码新起在 `8711`（旧实例还在 `8700`），解释器加 `-s` 避免 user site-packages 的 cu128 torch 覆盖。

| 场景 | 配置 | 耗时 | 关键结果 |
| --- | --- | --- | --- |
| 标准编辑 | `scheme=auto`（→B）/ 25 步 | 42.1s（含 18s 加载） | `outside_max_abs=0`、遮罩外非零像素 0、`zero_shift.verified=true` |
| 元素移除 | 自动 Remove LoRA 1.0 + 绿提示 | 41.1s | `hint_mode=green_overlay`、`mask_coverage=0.1156`、无绿色残留 |
| 扩图（合成图） | 12%/12%/10%/10% | 11.6s | 几何正确（1280×928、偏移 123/133/77/83），但输出「画框+投影」 |
| 扩图（照片，25 步） | 同上 | 12.6s | 视觉无缝，接缝 1~24 RGB |
| 扩图（照片，turbo9） | 同上 | 17.1s | 视觉无缝，接缝 1~4 RGB（右侧 16） |
| Turbo9 编辑 | `turbo9_gh` / 9 步 | 17.5s | 链路可用、`outside_max_abs=0` |

扩图「画框」问题定位过程：先关掉 `local` 合成看模型原始输出，确认灰边被画成浅色卡纸 + 投影，属于模型对「卡片感」合成图的语义判断；另外同一配置换成真实照片后完全正常。因此不改管线，只把「扩图质量必须用照片验收」写进决策 27。

进度条真机确认单调递增（准备模型 → 文本编码 → 扩散采样 → `采样 n/25` → 解码与合成 → 完成），不再倒退。

**遮罩边界"矩形像素块"（2026-11-07 二次回归发现）**：方案 B 贴回时把 0/1 硬遮罩直接当 alpha，模型重绘的接触阴影在遮罩边界被直角切断。实测边界相邻像素跳变：左 26、下 42（RGB）。`stitch_region` 增加按 `blend_pixels` 的高斯羽化后，同配置复跑：左 6、下 3，遮罩外仍然 `max_abs=0`、非零像素 0。对应单测 `test_stitch_region_feathers_mask_boundary_inside_only`。

**矩形淡影（第三轮，同一天）**：只剩羽化后仍能看到一个淡矩形，定位到模型把遮罩内整块背景重画了一遍：

| 指标（`edit`，固定 seed=12345） | 加性低频抵消（已废弃） | 逐像素软阈值（当前） |
| --- | --- | --- |
| 遮罩边界相邻像素跳变（y=300 左边界） | 蓝 +4~+5 | ≤2（多数 0） |
| 遮罩内背景带 `diff == 0` 占比 | 3.8% | 74.9%（其余为接触阴影） |
| 遮罩内背景高频纹理（原图为纯渐变） | +0.8 级噪点 | 与遮罩外一致 |

`remove`（seed=12345）更彻底：遮罩内背景带残差 `mean=0.11 / max=1 / zero 89.4%`，边界各方向 Δ≤0.8（等于渐变本身逐像素的 ±1 量化），遮罩外仍 `max_abs=0`。中途试过的乘性闸门 `alpha *= max(near, ramp)` 会在交界处留等高线，实机对比图里是比原问题更明显的"线框"，已废弃（见决策 29）。

**原生模式回归（2026-11-07，seed=777，`.cache/smoke_real_edit.py 8711 native 777`）**：同一提示词 / 同一一致性 LoRA，`local.scheme=native` 不做任何遮罩合成，预处理 + 32 对齐 + `resolution=0` + 整数裁回全部保留，`zero_shift.verified=true`、输出 1024×768 回到源尺寸。合成图（1024×768、遮罩覆盖率 11.6%）实测：

| 配置 | 遮罩外 mean | p95 | p99 | 说明 |
| --- | --- | --- | --- | --- |
| 方案 B（遮罩贴回 + 软阈值） | — | — | — | `outside_max_abs=0`，遮罩外逐字节等于原图 |
| 原生 + BlueBox 校色（默认） | 1.25 | 2 | 3 | 无硬边界，不存在矩形接缝 |
| 原生 + 关掉校色 | 2.45 | 4 | 5 | 可见整体偏色（对比图 ④ 背景偏品红） |

三组 `max` 均为 111，来自花瓶底部越过遮罩线的真实改动（物体本身），不是漂移。真实照片（1024×768，锚区 79.4%）同样通过：`scale≈1.00`、`shift<=0.005`，视觉无偏色。对照图：`storage/outputs/compare-native-v3.png`。

**孤海接缝移植回归（2026-11-07，seed=777，`smoke_real_edit.py 8711 edit 777`）**：`edit` 裁切块 384×608 → 按长边 768 放大到 480×768 再采样，贴回缩回 384×608；`mask_band = expand 12 / feather 16`（遮罩包围盒平均边长 320 × 4% / 5%），`outside_max_abs=0`（以膨胀+羽化带外沿为界），`zero_shift.verified=true`。与旧版对比（同一 seed、同一提示词）：

| 指标（原遮罩外，画布坐标） | 旧方案 B（仅向内羽化 24px） | 新方案 B（孤海接缝） |
| --- | --- | --- |
| mean | 0.00 | 0.02 |
| p99 | 0 | 0 |
| max | 155（花瓶底部越过遮罩线） | 31（同处，属于物体本身） |
| 放大图肉眼 | 遮罩线处可见矩形台阶 | 与背景渐变自然融合 |

`remove`（seed=777）同样干净：无残影、无矩形、背景渐变连续。对照图：`storage/outputs/compare-goho-mask.png`。全量测试 381 passed。

---

## 12. 设置界面参数契约（方案先定，2026-11-07 冻结 v1）

> 设置界面正在并行开发，本节先冻结「前端能调什么、字段叫什么、默认是什么、越界怎么办、结果怎么回显」。
> **只定契约，不代表前端已落地**：标 ⏳ 的是设置界面还需要接的字段。
> 后端读取位置以 `server/pipeline.py#generate_edit`（L732 起）为准，改字段必须同步本节。

### 12.1 三条硬约定

1. **命名只此一份**：局部编辑一律放 `local.*`（snake_case），预处理放 `preprocess.*`，一致性 LoRA 放 `consistency_lora`。不新增同义字段（`raw`、`green`、`overlay` 只是后端兼容别名，不要在新界面里出现）。
2. **传了 `local.scheme` 就必须同时传 `local.enabled: true`**。后端把 `local.enabled` 当总开关（缺省 = `false` → `scheme` 被忽略成 `none`）。`none` 在**有遮罩**时等同方案 A、**无遮罩**时才自动 native；所以"选了原生但没开 enabled"会静默退回方案 A。这是当前最容易踩的一脚。
3. **新开关默认值 = 当前最佳实践**，关掉要能回到旧行为；不允许出现"必须打开才正确"的默认值。`remove` / `outpaint` 的训练约定（绿提示 / 灰边 / 任务 LoRA）由后端兜底，界面只做只读说明。

### 12.2 模式组（决定整条管线走哪支）

| 字段 | 类型 | 默认 | 取值 | 作用 / 后果 |
| --- | --- | --- | --- | --- |
| `local.enabled` | bool | `false`（**界面必须传 `true`**） | `true/false` | 局部编辑总开关。假 → `scheme=none`（有遮罩=方案 A 合成；无遮罩=native） |
| `local.scheme` | string | `"a"` | `a` / `b` / `auto` / `native` | `a`=整画布采样 + 遮罩羽化合成；`b`=按遮罩 bbox 裁块采样 + 接缝贴回；`auto`=覆盖率 2%~45% 走 `b`，否则 `a`；`native`=不合成，整画布即输出（`raw` 是别名） |
| `local.consistency` | bool | `true` | `true/false` | 普通编辑默认挂一致性 LoRA。等价关闭开关 |
| `params.consistency_lora` | `false` / `{name, strength}` | `null`（=默认挂 `consistency` 预设，strength `0.48`） | — | 强度建议界面暴露 `0.3~0.8`；`false` 与 `local.consistency=false` 等效 |
| `params.loras` | array | `[]` | `[{preset?/name, strength}]` | **非空时覆盖自动挂载**（任务 LoRA 与一致性 LoRA 都不再自动加） |

> `native` 的承诺差异：不做遮罩合成、不写遮罩外、不做软阈值压回，`quality.outside_max_abs` 回 `null`；只保留预处理 → 32 对齐 → `resolution=0` → latent==画布 → 整数裁回 → 预处理还原，最后做整图锚区校色。

### 12.3 裁切组（仅 `scheme=b`；`auto` 落到 B 时同样生效）

| 字段 | 类型 | 默认 | 建议范围 | 作用 |
| --- | --- | --- | --- | --- |
| `local.expand_top` | float | `1.3` | `1.0~3.0` | 向上扩展系数（× 遮罩包围盒**短边**） |
| `local.expand_bottom` | float | `1.4` | `1.0~3.0` | 向下扩展系数 |
| `local.expand_left` | float | `1.4` | `1.0~3.0` | 向左扩展系数 |
| `local.expand_right` | float | `1.4` | `1.0~3.0` | 向右扩展系数 |
| `local.crop_min_side` | int | `768` | `0~2048` | 裁切块长边下限；小遮罩会**放大**到该值再送模型（孤海节点 8）。传 `0` 关闭放大 |
| `local.crop_max_side` | int | `2048` | `512~4096` | 裁切块长边上限（防 OOM）；须 ≥ `crop_min_side` |
| `local.fills` | bool | `task.mode == "remove"` | `true/false` | 裁切前填掉遮罩闭合孔洞（移除场景必须开） |
| `local.legacy_crop` | bool | `false` | `true/false` | 回退旧裁切几何（`context_factor` / `context_pixels`）。仅排查用，默认隐藏 |
| `local.context_factor` | float | `1.5` | `1.0~4.0`（已校验） | 旧几何：包围盒倍数（仅在 `legacy_crop=true` 时生效） |
| `local.context_pixels` | int | `96` | `0~1024`（已校验） | 旧几何：额外上下文像素 |

> `expand_*` 写 `0` 会被当成缺省（`or` 兜底），要收紧上下文请往下调但别写 0；`crop_min_side` 例外，`0` 是合法值（显式关闭放大），需要用 `null` 表示"用默认 768"。

### 12.4 接缝组（仅 `scheme=b`）

| 字段 | 类型 | 默认 | 建议范围 | 作用 |
| --- | --- | --- | --- | --- |
| `local.expand_pct` | float | `4.0` | `0~20` | 贴回时先向外**膨胀**占遮罩包围盒平均边长的百分比（`0` 合法，表示不外扩） |
| `local.feather_pct` | float | `5.0` | `0~30` | 膨胀后再高斯羽化的百分比（同上，`0` 合法） |
| `local.blend_pixels` | int | `24` | `0~256`（已校验） | 仅当 `expand_pct` 与 `feather_pct` **都为 0** 时生效的向内羽化像素（旧行为）。默认路径下被忽略 |
| `local.dither` | bool | `true` | `true/false` | 过渡带确定性抖动（IGN，<1/255），消除 8bit 色阶断层。建议界面显示为"抗色阶断层"，默认开 |

> 实际写入范围 = 遮罩 bbox 膨胀 `expand_px` + 羽化 `feather_px`（真机 `edit` 实测 12 / 16）。验收 `outside_max_abs` 以这条带的外沿为界；带内属于用户显式选择的过渡带，不是泄漏。

### 12.5 合成组（`scheme=a`，以及 `enabled=false` 但有遮罩时）

| 字段 | 类型 | 默认 | 建议范围 | 作用 |
| --- | --- | --- | --- | --- |
| `local.feather` | int | `32` | `0~256`（已校验） | 遮罩向内羽化半径（像素）。写 `0` 会被兜底成 `32`，要"硬边"请传 `1` |
| `local.mask_expand` | int | `0` | `0~256`（已校验） | 主动把写入范围外扩 N 像素（会把遮罩外像素也算作可改） |
| `local.color_match` | bool | `true` | `true/false` | 颜色匹配总开关；关掉则锚区仿射 / 低频移植整条颜色链路都不做 |
| `local.color_strength` | float | `0.6` | `0~1` | Reinhard 强度；方案 B 内部取 `max(strength, 0.7)` 保接缝 |
| `local.band_mode` | string | `"lowfreq"` | `lowfreq` / `alpha` | 过渡带方式：低频移植（默认，抗亮度台阶）/ 纯 alpha 混合。非法值回落 `lowfreq` |

### 12.6 颜色一致性（A / B / native 都生效，建议独立成一组）

| 字段 | 类型 | 默认 | 建议范围 | 作用 |
| --- | --- | --- | --- | --- |
| `local.color_restore` | bool | `true` | `true/false` | BlueBox 锚区仿射：用"几乎没变"的像素估逐通道 gain/shift 拉回整体漂移。native 模式下是唯一校色手段 |
| `local.color_restore_strength` | float | `1.0` | `0~1` | 校色强度；`0` = 只统计不应用 |

提示图（独立小项，不建议做成可编辑控件）：

| 字段 | 类型 | 默认 | 取值 | 作用 |
| --- | --- | --- | --- | --- |
| `local.hint` | string | `""`（=auto） | `""` / `auto` / `none` / `green_overlay` / `gray_fill` | 缺省时 `remove` 自动绿提示、其余 `none`；`remove` 强制 `green_overlay`、`outpaint` 强制 `gray_fill`。普通编辑建议显式传 `none` |

### 12.7 预处理组（大图必开）

| 字段 | 类型 | 默认 | 约束 | 作用 |
| --- | --- | --- | --- | --- |
| `preprocess.enabled` | bool | 界面 `true`（后端缺省 `false`，**必须显式传**） | bool | 仅 `size_mode=follow` 且非扩图时生效；长边超 `max_side` 才真正缩，出图后按记录还原 |
| `preprocess.max_side` | int | `2048` | `256~8192`（已校验） | 预处理长边上限 |
| `preprocess.min_side` | int | `768` | `256~8192`，且 ≤ `max_side`（已校验） | 仅 `mode=clamp_range` 时作为下限（默认模式不放大） |
| `preprocess.multiple` | int | `32` | `8~256`（已校验） | 32 对齐倍数，建议固定 32、界面不暴露 |
| `preprocess.mode` | string | `"downscale_only"` | `downscale_only` / `clamp_range` | 只缩不放（默认）/ 夹到区间（会放大小图） |

> 预处理是零偏移闭环的一部分：它缩小后，画布、遮罩、裁回都按同一组整数记录走。界面可以关，但要在提示里说明"关掉后 4K 原图会更慢，且可能 OOM"。

### 12.8 界面分组与控件建议（照抄即可）

| 分组 | 控件 | 绑定字段 | 显隐规则 |
| --- | --- | --- | --- |
| 编辑方式 | 分段选择：自动 / 全画布 / 裁切 / 原生 | `local.enabled=true` + `local.scheme` | 始终显示；选「原生」时禁用 12.4、12.5 两组 |
| 裁切 | 四个数字（上/下/左/右，step 0.05）+「最小裁切长边」下拉（512/768/1024）+「最大裁切长边」下拉（1536/2048/3072）+ 两个开关 | `expand_top/bottom/left/right`、`crop_min_side`、`crop_max_side`、`fills`、`legacy_crop` | 仅 `scheme ∈ {b, auto}`；`legacy_crop` 收进「高级」默认折叠 |
| 接缝 | 两个滑块（4% / 5%）+ 开关 | `expand_pct`、`feather_pct`、`dither` | 仅 `scheme=b`；建议收进「高级」 |
| 合成 | 羽化像素、外扩像素、颜色匹配开关 + 强度滑块 | `feather`、`mask_expand`、`color_match`、`color_strength` | 仅 `scheme=a` |
| 颜色一致性 | 开关 + 强度滑块 | `color_restore`、`color_restore_strength` | 始终显示（三种方案都需要） |
| 一致性 LoRA | 开关 + 强度滑块（0.3~0.8） | `local.consistency` + `consistency_lora.strength` | 始终显示；任务为 remove/outpaint 时标注"已改用任务 LoRA" |
| 大图预处理 | 开关 + 长边下拉（1024/1536/2048/3072） | `preprocess.enabled`、`preprocess.max_side` | 始终显示 |
| 移除提示 | 只读标签 | `local.hint` | 仅 `task.mode=remove`，显示"绿色选区提示（训练约定，不可关）" |

### 12.9 缺省与兼容（不传键时到底发生什么）

| 情形 | 实际行为 |
| --- | --- |
| `local` 整个缺失 | `enabled=false` → `scheme=none`：有遮罩=方案 A，无遮罩=native |
| 传 `scheme` 但没传 `enabled` | `scheme` 被忽略（同上）。**界面必须成对传** |
| `preprocess` 缺失 | 预处理**不启用**（不是默认 2048）。界面必须显式传 `enabled` |
| `zero_shift` 缺失 | 不启用零偏移校验（不传就只是普通画布）；建议界面默认传 `{enabled:true, snap:32, resolution:0}`，`resolution` 恒为 0 |
| `hint` 传 `green` / `overlay` / `mask` | 归一为 `green_overlay`；`gray` / `grey` → `gray_fill`（旧数据兼容，新界面不要再用） |
| `scheme` 传 `raw` | 归一为 `native` |
| `scheme=auto` 但无遮罩 | 直接 native（无"遮罩外"可保留） |
| `task.mode=remove` 但没遮罩 | 后端退回 `edit` 并写 `quality.warnings` |
| `task.mode=outpaint` 但四边全 0 | 退回 `edit` 并写 `quality.warnings` |

### 12.10 服务端校验（越界一律 400，不静默夹取）

已实现：`local.scheme` 枚举、`feather` / `mask_expand` / `blend_pixels`（0~256）、`context_pixels`（0~1024）、`context_factor`（1~4）、`preprocess.max_side` / `min_side`（256~8192 且 min ≤ max）、`preprocess.multiple`（8~256）、`preprocess.mode` 枚举、`loras[].strength`（0~2）。

⏳ 建议随设置界面一起补（本轮未改 `main.py`，避免与并行开发冲突）：

| 字段 | 建议规则 |
| --- | --- |
| `local.expand_top/bottom/left/right` | 数字，`1.0~3.0` |
| `local.crop_min_side` | 整数 `0~2048` |
| `local.crop_max_side` | 整数 `512~4096`，且 ≥ `crop_min_side`（`crop_min_side>0` 时） |
| `local.expand_pct` | 数字 `0~20` |
| `local.feather_pct` | 数字 `0~30` |
| `local.color_strength` / `color_restore_strength` | 数字 `0~1` |
| `local.band_mode` | 枚举 `lowfreq` / `alpha` |
| `local.hint` | 枚举 `""` / `auto` / `none` / `green_overlay` / `gray_fill` |
| `local.dither` / `fills` / `legacy_crop` / `consistency` / `color_restore` | 布尔（允许 `0/1`、`"true"/"false"`） |

### 12.11 结果回显（界面右上角「本次生效」面板）

| 字段 | 含义 | 展示建议 |
| --- | --- | --- |
| `job.quality.scheme` | 实际走的方案（`a` / `b` / `native` / `none`） | 徽标："全画布 / 裁切 / 原生" |
| `job.quality.zero_shift.verified` | 零偏移几何硬验收是否通过 | 通过显示 ✓，未启用显示"未校验" |
| `job.quality.preprocess.{applied, scale, work.w/h, canvas.w/h}` | 预处理是否真的缩放、缩放比与前后尺寸 | "4096×2304 → 2048×1152"（`scale` 约 0.5） |
| `job.quality.source.{w, h}` / `output.{w, h}` | 源图与最终输出尺寸 | 用于确认"回到源尺寸" |
| `job.quality.canvas.{w, h}` | 采样画布（32 倍数） | 折叠显示 |
| `job.quality.color.mask_band.{expand_px, feather_px}` | 方案 B 实际过渡带 | 高级信息，默认折叠 |
| `job.quality.outside_max_abs` | 遮罩外最大字节差；`0` = 逐字节保留；`null` = 原生模式不承诺 | 显示"遮罩外 0 变化"或"原生态" |
| `job.quality.changed_ratio` / `leak_ratio` | 改动比例 / 泄漏比例（诊断，只读） | 异常时才提示 |
| `job.quality.warnings` | 回退/强制说明（未选区、扩图退回、绿提示强制等） | 黄条列出 |
| `job.align.crop` | 裁切几何（`top/bottom/left/right`、`model_w/h`） | 调试信息 |

### 12.12 请求示例

最小可用（带遮罩的普通编辑，全部走默认最佳实践，⏳ 表示界面待接）：

```json
{
  "prompt": "把红色外套换成米白色",
  "images": [{"data": "data:image/png;base64,..."}],
  "mask": {"data": "data:image/png;base64,..."},
  "size_mode": "follow",
  "resolution": 0,
  "zero_shift": {"enabled": true, "snap": 32, "resolution": 0},
  "preprocess": {"enabled": true, "max_side": 2048},
  "local": {
    "enabled": true,
    "scheme": "auto",
    "consistency": true,
    "expand_top": 1.3,
    "expand_bottom": 1.4,
    "expand_left": 1.4,
    "expand_right": 1.4,
    "crop_min_side": 768,
    "crop_max_side": 2048,
    "expand_pct": 4,
    "feather_pct": 5,
    "dither": true,
    "feather": 32,
    "color_match": true,
    "color_strength": 0.6,
    "color_restore": true,
    "color_restore_strength": 1.0,
    "mask_expand": 0,
    "band_mode": "lowfreq"
  },
  "consistency_lora": {"strength": 0.48}
}
```

原生（孤海同款路径）：把 `local.scheme` 换成 `"native"`，`local.enabled` 仍必须是 `true`；`expand_pct` / `feather_pct` / `feather` / `mask_expand` 全部失效，只保留 `color_restore` 与 `color_restore_strength`。

### 12.13 待拍板（界面开工前确认）

1. **默认方案**：建议有遮罩时默认「自动」，无遮罩自动落「原生」；不要默认「裁切」，小图裁块会放大反而更慢。
2. **高级参数是否默认折叠**：`expand_pct` / `feather_pct` / `band_mode` / `legacy_crop` 建议只放折叠区，默认值已是真机验证过的最优点。
3. **一致性 LoRA 强度是否暴露**：建议暴露（0.3~0.8，默认 0.48）；关掉一致性 LoRA 时本地编辑的整体漂移会明显变大，需要文案提示。

---

## 13. 孤海三方案全量移植 + 预设体系（2026-11-07 钉死）

> 输入：`qwen2.1九步局部编辑API.json`、`qwen2.1元素移除API.json`、`qwen2.1扩图API.json`（孤海原版工作流）。
> 目标：**孤海的三条路径（局部编辑 / 元素移除 / 扩图）成为本项目的默认配置**，并把"方案"收敛成可选预设；
> 同时保证零像素偏移与色彩校准不被破坏，且图片精修与图生图共用同一套预设。
> 本节优先级高于 §5 中与孤海原版冲突的描述（§5 是早期设计稿，§13 是落地口径）。

### 13.0 结论（先看这段）

| 问题 | 结论 |
| --- | --- |
| 孤海方案能否全量移植 | **能，且已经移植了 80%**：裁切几何、小遮罩放大、填洞、4%/5% 膨胀羽化、gain 0.9~1.1 / offset ±24/255、9 步 sigma、任务 LoRA、绿/灰提示都在。剩余差异见 §13.2 |
| 与零像素偏移是否兼容 | **兼容，但有三处不能照抄**：`倍数取整=0`、`图像缩放V2 拉伸`、`latent 1024² + 填充`。这三处正是孤海"看起来无偏移、实际有亚像素重采样"的来源，必须换成我们的 32 对齐 / 等比整数 / latent==画布（§13.3） |
| 与色彩校正是否兼容 | **兼容**。孤海的 gain/offset 与我们的 `anchor_affine` 同源；但"整图校色"只在 native 模式安全，A/B 模式只能在裁块/过渡带内校色，否则遮罩外不再逐字节相等（§13.4） |
| 方案太多太乱 | 收敛为 **5 个预设**：`mask_edit`（默认）/ `remove` / `outpaint` / `canvas` / `native`；其余全部降级为高级开关（§13.6）。2026-11-07 追加 `chain_mask` / `chain_native` 两套连续编辑档（§13.6.1） |
| 图片精修默认值 | **色彩校准默认开、零像素偏移默认开**，两者都可关，关掉时写 `quality.warnings` 说明后果（§13.7） |
| 图生图能否复用 | 能。预设定义只放后端一份，通过 `/api/meta` 下发，图片精修与图生图都只渲染 + 传 `preset`（§13.5） |

### 13.1 三份孤海工作流逐节点对照

| 环节 | 局部编辑（九步） | 元素移除 | 扩图 | 我们的现状 |
| --- | --- | --- | --- | --- |
| 底模 | turbo int8 convrot | 同 | 同 | ✅ `turbo9_gh` |
| CLIP / VAE | qwen3vl_8b / vae_bf16 | 同 | 同 | ✅ |
| sigma | 9 段手写 | 同 | 同 | ✅ 同一条 |
| 任务 LoRA | 一致性 **0.48** | Remove **1.0** | 扩图 **0.7** | ✅ 预设值一致 |
| 画板 | 原图 | 原图 | 外补画板：左 235% / 右 69% / 上 24% / 下 232%，色 `#808080`，最大长边 **5120** | ✅ 实现；⏳ 默认上限还是 8192 |
| 裁切 | `MaskCropV2`：1.3 / 1.4 / 1.4 / 1.4，`倍数取整 0`，`遮罩填充 false` | 同，但 **`遮罩填充 true`** | 同裁切节点，但四向系数由「孤海遮罩分析 + 数学运算」**按遮罩到边距离动态算**；`倍数取整 0` | ✅ 1.3/1.4 + fills；⏳ 扩图动态系数未移植 |
| 绿提示 | 无 | **裁切块上**叠 `#00ff00`，透明度 0.4 | 无（灰边即提示） | ✅ 已按裁块叠绿 |
| 裁块缩放 | `图像缩放（范围）`：长边 **768~2048**、32 倍数 | 先范围缩放算尺寸，再 `图像缩放V2` **拉伸**到该尺寸（图 + 遮罩同步） | 长边 **`clamp(1024, 长边, 2048)`**、32 倍数、`拉伸` | ✅ 等比 32 对齐 [768,2048]；⏳ 扩图下限应为 1024 |
| 编码 | latent **1024×1024**、mode **填充**、ref 自动 | 同（无 mask 输入） | 同 | ⚠️ 我们 latent == 裁块（**故意不同**，见 §13.3） |
| 还原 | `CropRestore`：扩展 **4%** / 羽化 **5%** / 颜色还原 1.0 | 同 4% / 5% | 扩展 **3%** / 羽化 **3%** / 颜色还原 1.0 | ✅ 4/5；⏳ 扩图默认应 3/3 |
| 采样 | euler / 9 步 / cfg 1 | 同 | 同 | ✅ |
| 提示词 | 用户提示词 | `移除图像中的绿色区域` | `移除图像中的灰色区域，无缝自然延展为完整图像。` + 场景 | ✅ 后端自动补全 |
| 输出 | 回源尺寸 | 回源尺寸 | 外扩后尺寸（不裁回） | ✅ |

### 13.2 移植缺口（只差这 4 项）

| # | 缺口 | 影响 | 处理 |
| --- | --- | --- | --- |
| G1 | 扩图裁块长边下限用 768（孤海 1024）、接缝 4%/5%（孤海 3%/3%）、外补上限 8192（孤海 5120） | 扩图细节略糊、接缝带宽偏大 | 由 `outpaint` 预设覆盖，不改全局默认 |
| G2 | 扩图四向扩展系数是固定 1.3/1.4，孤海按"遮罩到边距离"动态算 | 单侧超大幅外补时可能切到灰边 | 先真机验证固定系数是否已覆盖；不覆盖再加 `imaging.crop_region_outpaint` |
| G3 | 孤海 `image_02 = 整图缩到 1MP`（九步编辑）作为第二参考 | 全局构图参考更强 | 影响显存与速度，列为可选（`local.global_ref=true`），不进默认预设 |
| G4 | 任务/一致性 LoRA 在界面上无法真正关闭（见 §13.8） | 用户以为关了其实还在挂 | 前端修 `consistency_lora:false` + 强度显示 |

### 13.3 与「零像素偏移」的兼容性（结论：兼容，三处不照抄）

孤海工作流**本身不满足严格零偏移**，它的"无偏移"是肉眼级：

| 孤海做法 | 为什么破坏严格零偏移 | 我们的做法 |
| --- | --- | --- |
| `MaskCropV2 倍数取整 = 0`（裁块宽高不保证 32 倍数） | 下游必须再缩一次才能进 latent，多一次重采样 | 裁块宽高 **32 对齐**，`CropInfo` 记录整数，贴回同一组整数 |
| `图像缩放V2 拉伸` 到目标尺寸 | 宽高比例被强制改变（非整数缩放），像素网格错位 | `crop_region_factors` **等比** LANCZOS + `model_w/h` 显式记录，`crop_mask_for_region` 同步缩放遮罩 |
| `latent 1024² + 填充` | 裁块 contain 进 1024 画布，出图再缩回裁块 → 两次几何重采样 | **latent == 采样画布 == 参考图尺寸**，`resolution=0`，出图不缩放 |
| 扩图动态扩展系数（浮点） | 系数参与裁切窗口计算，取整点不固定 | 系数只用于求窗口，窗口最终按整数 + 32 snap；贴回用同一组整数 |

**结论：** 几何意图 100% 可移植；取整与缩放路径必须换成我们的。这也解释了为什么用户实测"孤海无偏移"而我们在同一张图上仍能做 `outside_max_abs=0` —— 我们比它更严格，不是更松。

**零偏移的边界（不要误解）：**
- 只在 `size_mode=follow` + 非扩图时承诺"输出回源尺寸且逐像素对齐"。
- `custom` / `ratio` / 扩图：画布尺寸本就是用户要的新尺寸，保留 32 对齐与整数偏移，但不做"回源尺寸"验收。

### 13.4 与「色彩校正」的兼容性（结论：兼容，但要限定作用域）

| 模式 | 校色作用域 | 能不能整图校色 | 原因 |
| --- | --- | --- | --- |
| 方案 A（整画布 + 遮罩合成） | 遮罩内 + 过渡带 | ❌ | 合成后整图校色会改到遮罩外，`outside_max_abs` 不再是 0 |
| 方案 B（裁块 + 贴回） | 裁块内 + 膨胀羽化带 | ❌ | 同上；孤海是整块 gain/offset，本身就"碰到遮罩外" |
| native（无遮罩合成） | 整张画布 | ✅ | 没有任何"遮罩外"承诺，`outside_max_abs=null` |

**顺序（不能换）：** 模型输出 → 缩回裁块尺寸 → 贴回（膨胀+羽化 alpha）→ 带内锚区仿射 / 低频移植 → **逐像素软阈值压回** → IGN 抖动。整图校色（native）在软阈值之前只做一次，不要与带内 Reinhard 叠加，否则二次拉色。

**结论：** 孤海的 `颜色还原强度 1.0` 与我们的 `color_restore_strength 1.0` 等价，兼容；界面文案必须写"色彩校准只作用于写入区，遮罩外永不动"，避免用户以为整图会被改。

### 13.5 预设体系（唯一事实源 + 合并优先级）

**唯一事实源：后端。** 新增 `server/presets.py`，定义：

```python
EDIT_PRESETS = {
    "mask_edit": {...},   # 默认
    "remove": {...},
    "outpaint": {...},
    "canvas": {...},
    "native": {...},
}
PRESET_VERSION = 1
```

通过 `/api/meta` 增加 `edit_presets`（含 `id / 名称 / 一句话说明 / 参数摘要 / 是否默认 / version`），前端只渲染、不复制数值。

**合并优先级（必须按这个顺序）：**

```
显式请求字段  >  preset 展开值  >  后端内置默认（§12 表）
```

- 请求带 `preset` 时，后端只补"请求里没有的键"，不覆盖用户显式改过的值。
- 请求不带 `preset` 时，行为与现在完全一致（向后兼容）。
- `task.mode` 也按同一优先级：显式 `task.mode` > 预设内置任务 > `edit`。
- `job.params` 与历史回放要记录 `preset` + `preset_version`，否则以后改预设无法复现。

### 13.6 预设的完整参数（原五档；连续编辑两档见 §13.6.1）

| 字段 | `mask_edit` 局部编辑（默认） | `remove` 元素移除 | `outpaint` 扩图 | `canvas` 整画布 | `native` 原生 |
| --- | --- | --- | --- | --- | --- |
| `task.mode` | `edit` | `remove` | `outpaint` | `edit` | `edit` |
| `local.enabled` | `true` | `true` | `true` | `true` | `true` |
| `local.scheme` | **`b`** | `b` | `b` | `a` | `native` |
| `local.fills` | `false` | **`true`** | `false` | `false` | `false` |
| `expand_top/bottom/left/right` | 1.3 / 1.4 / 1.4 / 1.4 | 同左 | 同左（动态系数为后续可选） | — | — |
| `crop_min_side` | `768` | `768` | **`1024`** | `0` | `0` |
| `crop_max_side` | `2048` | `2048` | `2048` | `2048` | `2048` |
| `expand_pct` / `feather_pct` | 4 / 5 | 4 / 5 | **3 / 3** | — | — |
| `blend_pixels` | 24（不生效，仅兜底） | 24 | 24 | 24 | — |
| `local.dither` | `true` | `true` | `true` | `true` | `true` |
| `local.feather` | 32 | 32 | —（不合成） | 32 | — |
| `local.mask_expand` | 0 | 0 | 0 | 0 | — |
| `local.color_match` | `true` | `true` | `true` | `true` | `false`（不走合成） |
| `local.color_strength` | 0.6 | 0.6 | 0.6 | 0.6 | — |
| `local.color_restore` | **`true`** | **`true`** | **`true`** | **`true`** | **`true`** |
| `local.color_restore_strength` | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| `local.consistency` | `true`（0.48） | `true` | `true` | `true` | `true` |
| `local.hint` | `none` | `green_overlay` | `gray_fill` | `none` | `none` |
| `loras`（自动挂载） | consistency 0.48 | remove 1.0 | outpaint 0.7 | consistency 0.48 | consistency 0.48 |
| `sampling` | `turbo9_gh` 9 步 | 9 步 | 9 步 | 9 步 | 9 步 |
| `preprocess` | `on / 2048` | `on / 2048` | `on / 2048`（扩图内部跳过） | `on / 2048` | `on / 2048` |
| `zero_shift` | **on** | **on** | 自动关（尺寸必变） | **on** | **on** |
| 扩图外补上限 | — | — | **5120** | — | — |

> `mask_edit` 明确用 `b`（孤海几何），不再走 `auto`。`auto` 保留为独立选项：小遮罩（<2%）想省显存、或想完全避开裁切时使用；大遮罩（>45%）会自动回 `a`。
> `canvas` 与 `native` 是"退路"：`canvas` 用于小遮罩/希望整画布上下文；`native` 用于用户偏好孤海式"不做任何遮罩合成"。

### 13.6.1 连续编辑两档（2026-11-07，`PRESET_VERSION = 2`）

| 项 | `chain_mask` 连续编辑·遮罩 | `chain_native` 连续编辑·整图 |
| --- | --- | --- |
| `local` 参数 | 与 `mask_edit` 完全一致（`b` 几何 / 4%·5% / 一致性 0.48 / 校色开） | 与 `native` 完全一致（整图重绘 / 全局校色 / 不做遮罩合成） |
| `chain.mode` | `mask` | `native` |
| `chain.carry_mask` | `true` | `false` |
| `chain.anchor_every` | 5 | 5 |
| `chain.drift_warn_delta_e` | 10 | 10 |

- 依据：测试档案 §4.9.1 对照实验——遮罩路径 8 轮遮罩外始终 0 漂移；整图路径关/开 BlueBox 校色 8 轮后 ΔE 为 23.78 / 22.57，证明连续编辑的漂移主体是"反复全图重绘"，不是色偏，所以整图档只作为退路，并提示每 5 轮回锚。
- 无蒙版时前端把 `chain_mask` 降级为 `chain_native`（`web/src/components/studio/presets.js#resolvePresetForMask`），不再退回 `canvas`。
- `chain` 是**前端流程契约**（保遮罩 / 回锚 / 漂移提示），后端不消费，只随 `job.params` 原样记录。
- 版本 +1 的原因：预设集合发生变化，历史回放需要区分 v1 / v2。

### 13.7 界面整合（图片精修 + 图生图共用）

**图片精修页（`studio`）右栏自上而下：**

```
┌ 方案预设 ─────────────────────────────┐
│ [推荐·局部编辑] [元素移除] [扩图]      │  ← 卡片，选中即套整包参数
│ [整画布] [原生]                        │
│ 说明：孤海几何 · 裁块 768~2048 · 4%/5% │
└───────────────────────────────────────┘
┌ 本次保护（始终可见）──────────────────┐
│ [✓] 色彩校准  只作用于写入区，遮罩外不动│
│ [✓] 零像素偏移  32 对齐 · resolution 0 │  ← 不再是 disabled 锁死
└───────────────────────────────────────┘
┌ 高级（折叠）──────────────────────────┐
│ 裁切 / 接缝 / 合成 / LoRA / 预处理      │  ← 字段同 §12，改动项打「已修改」chip
└───────────────────────────────────────┘
```

- **选预设 = 套参数包**：预设只写默认值，用户改任意一项后该预设显示为「已修改（可恢复）」。
- **两个保护开关不属于预设**：预设不改变用户对它们的显式选择；刷新/切预设都保持用户当前状态（默认都开）。
- **任务自动联动**：选 `remove` / `outpaint` 预设时自动切 `task.mode`，并锁住 `hint`（只读展示训练约定）。
- **当前缺口**：`studio/payload.js#L161-L179` 里 `color_strength 0.6`、`expand_*`、`blend_pixels`、`context_*` 都是硬编码，界面没有对应控件；接预设时这些值一律由预设下发，界面只显示不重复定义。
- **结果区显示"本次生效"**：预设名 + `quality.scheme` + `zero_shift.verified` + `outside_max_abs` + `mask_band`，让用户能验证预设真的生效。

**图生图页（`edit`）复用方式：**
- 预设定义与参数表完全一致，只是没有"蒙版"入口；无蒙版时预设自动降级：`mask_edit`/`remove` → 提示"需要蒙版，已按 `canvas` 执行"；`chain_mask` → `chain_native`（连续编辑仍可继续，只是失去遮罩外的零漂移）；`outpaint` 仍可用（扩图不依赖蒙版，靠外补遮罩）。
- 两页共享同一份 `/api/meta.edit_presets`，不在前端各写一份常量；两页的差异只有"是否有蒙版"和"尺寸入口"。

**设置页（同事正在开发）的职责：**
- 只做**预设管理**：列出预设（原 5 档 + 连续编辑 2 档）、显示只读参数摘要、恢复默认、选择"默认预设"。
- 不在设置页暴露每个细项（避免和图片精修页的高级区重复），细项一律在图片精修页高级区调。

### 13.8 「AI 精修设置界面 LoRA 强度显示」问题（已定位）

| # | 现象 | 根因（文件:行） | 修复 |
| --- | --- | --- | --- |
| B1 | **一致性 LoRA 关不掉**：取消勾选后仍会挂载 | `studio/payload.js#L209-L212` 关闭时传 `consistency_lora: null`；后端 `pipeline.py#L884-L895` 把 `null` 当"未传"→ 默认启用；且 `payload.js#L161-L179` 的 `local` 里没有 `consistency` 键 | 关闭时明文传 `consistency_lora: false` **且** `local.consistency: false` |
| B2 | 强度滑块"显示"与提交值不一致 | `studio/aiPanel.js#L155-L156` 滑块固定 `min=20 max=80`（只能 0.20~0.80）；`#L783-L787` 只在 `input`/`change` 时改标签，初始化/预设恢复不刷新；没有 `setStrength()` | 范围改 `0~200`（step 1，显示两位小数）；新增 `setStrength(v)` 同时写 `slider.value` 与 `label.textContent`，在初始化和切预设时调用 |
| B3 | 自定义 LoRA 强度超过 1 被静默截断，显示也不统一 | `studio/aiPanel.js#L814` `max="1"`、`#L826` `Math.min(1, …)`；`payload.js#L112-L116` `clampStrength` 上限 1；后端与任务预设允许 **0~2** | 上限改 `2`，显示统一 `toFixed(2)`，`clampStrength` 上限改 2 |
| B4 | 一致性开关关闭时滑块仍可拖 | `#L783-L785` 只在 `change` 时设置 `disabled`，初次渲染没同步 | 初始化时按勾选状态同步 enabled/disabled |
| B5 | 历史摘要出现 `undefined @ 0.48` | `web/src/utils.js#L228-L230` 直接打印 `consistency_lora.name`，设置面板可能只传 `{strength}` | 改成 `name || '一致性 LoRA'`，并优先读 `preset` 名称 |
| B6 | 预设/设置页改强度后，图片精修页仍显示旧值 | 两处各自存 `strength`，没有共同来源 | 预设与强度只存一份（预设对象），两页都从 `settings` 读；切页/切预设时调用 `setStrength()` |

> 这些是**显示与开关语义**问题，不影响后端算法。B1 是功能 bug（影响出图），优先修；B2/B3/B5 是显示一致性。

### 13.9 决策（钉死，后续不许绕）

33. **预设只放后端一份**（`server/presets.py`），前端通过 `/api/meta.edit_presets` 渲染；禁止前端再复制一份数值常量（历史上 `aiPanel` 的 0.48、`payload` 的 0.6 已经各写一遍，正是 B6 的来源）。
34. **合并优先级固定为「显式 > 预设 > 内置默认」**；预设只补缺、不覆盖用户显式值，保证第三方 API 与老前端不受影响。
35. **`mask_edit` 默认 `scheme=b`（孤海几何）**，`auto` 降级为可选；不要为了"省显存"把默认改回 `a`。
36. **零偏移与色彩校准默认开，但必须可关**；关闭时写 `quality.warnings`（"已关闭零偏移保护，可能出现亚像素偏移" / "已关闭色彩校准，输出可能与原图有色差"）。
37. **扩图与编辑的参数必须分家**：`crop_min_side` 1024 vs 768、接缝 3%/3% vs 4%/5%、外补上限 5120 vs 8192；不许用一个"万能默认"兼顾两边。
38. **不移植孤海的 1024² latent + 拉伸取整**。零偏移四硬约束（§3.1 C1~C4）优先级高于"和孤海一模一样"。
39. **整图校色只允许在 native 模式**；A/B 模式只能带内校色，否则 `outside_max_abs` 承诺作废。
40. **预设不承担任务识别**：`task.mode` 仍是显式优先；预设只给默认任务，避免"选了扩图预设但任务还是 edit"这种半套状态。
41. **预设必须带版本**：`preset + preset_version` 写进 `job.params`，改参数即 bump，历史回放才不会"同一预设出两张图"。

### 13.10 实施步骤与验收

| 步骤 | 内容 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| P13-1 | 新增 `server/presets.py`（5 个预设 + version）与合并逻辑；`/api/meta` 暴露预设 | `server/presets.py`、`server/pipeline.py`、`server/main.py` | 单测：显式字段覆盖预设、预设覆盖内置默认、未传预设零变化（3 条） |
| P13-2 | `zero_shift` 默认开（仅 follow；custom/ratio/扩图自动关）+ 关闭时 warnings | `server/pipeline.py`、`tests/` | e2e：默认 `verified=true`；显式关闭后 `enabled=false` 且有 warning |
| P13-3 | 扩图预设接线：`crop_min_side=1024`、接缝 3/3、外补上限 5120；验证固定系数能否覆盖灰边 | `server/pipeline.py`、`server/imaging.py` | 真机：大幅外补不出现"灰边被切"；接缝 RGB 差 ≤ 现有水平 |
| P13-4 | 前端：预设卡片 + 两个保护开关 + 高级折叠；修 §13.8 B1~B6 | `web/src/components/studio/{aiPanel,payload}.js`、`web/src/utils.js` | 切预设后提交 payload 只带 `preset` + 覆盖项；关闭一致性 LoRA 后后端不挂载；强度显示=提交值 |
| P13-5 | 图生图页复用同一预设与开关 | `web/src/components/edit.js` | 无蒙版时按 `canvas` 降级并提示；扩图可用 |
| P13-6 | 真机回归三预设（照片素材）+ 对照图 | `.cache/smoke_real_edit.py` | `mask_edit`/`remove`/`outpaint` 各出一组；`outside_max_abs=0`（native 为 null）、`zero_shift.verified=true`、无矩形台阶 |

**施工状态（2026-11-07）：**

- **P13-1 ✅** 新增 `server/presets.py`（5 预设 + `PRESET_VERSION=1` + 「显式 > 预设 > 内置默认」合并，只补缺不覆盖）；新增 `GET /api/meta` 下发 `edit_presets`。采样档复用已有 `turbo9_ckpt`（与文档里的 "turbo9_gh" 是同一份 Turbo 权重 + 9 段 sigma，不新增重复档位）。验证：`tests/test_edit_presets.py` 8 条全绿。
- **P13-2 ✅** `zero_shift` 默认开（仅 `size_mode=follow`；custom/ratio/扩图仍自动关），显式关闭时写 `quality.warnings`。验证：`test_zero_shift_defaults_on_and_can_be_disabled`、全量 **391 passed**。
- **P13-3 ⏳** 代码接线已完成（见 P14-2），真机大幅外补回归待跑。
- **P13-4 ✅** 预设卡片、两个保护开关、8 组高级设置全部接入图片精修（见 P14-1 / P14-3 / P15-1）。§13.8 六条显示/语义问题一并修掉：
  - **B1** 关闭一致性时 `consistency_lora:false` **且** `local.consistency:false`，后端不再默认挂载；
  - **B2** 强度滑块范围 0~2（step 0.01，显示两位小数），新增 `setStrength()` 统一写滑块 + 标签 + 共享设置；
  - **B3** 自定义 LoRA 强度上限 2，显示统一 `toFixed(2)`，`clampStrength` 上限同步改 2；
  - **B4** 初始化即按勾选状态同步滑块 disabled；
  - **B5** 历史摘要 LoRA 名缺失时回退「一致性 LoRA / LoRA」中文名（`utils.summarizeParams`）；
  - **B6** 预设 / 覆盖项 / 保护开关 / 一致性强度只存一份（`settings.edit`），两页共用。

**总验收口径：** 切到任一预设不改任何高级项，直接出图即为该预设的最佳效果；关掉两个保护开关后能回到旧行为；图片精修与图生图用同一预设出图参数一致（同 seed 同图）。

---

## 14. 高级设置全量可调 + 扩图面板（2026-11-07 钉死）

> 两条需求：
> ① 孤海原版能手动设的参数，全部进「高级设置」，可改、有作用提示、有恢复默认；
> ② 图片精修 PS 面板增加「扩图」入口，做一块比孤海「外补画板」更好用的扩图面板。
> 本节只定方案与实现细节，不改代码；与 §12/§13 冲突时以本节为准。

### 14.0 结论（先看这段）

| 问题 | 结论 |
| --- | --- |
| 参数放哪 | 图片精修页「高级」折叠区，按 8 组分区；设置页仍只做预设管理，不重复放细项（§14.2） |
| 每个参数怎么提示 | 每项都有「标签 + 单位 + 一行作用说明」，悬浮显示完整提示（含"调大/调小会怎样"），文案见 §14.2 |
| 恢复默认怎么算 | 三级：单项 ↺ / 分组「恢复本组」/ 底部「恢复全部」；恢复目标 = **当前预设值**（无预设时=内置默认），不是"清空"（§14.3） |
| 扩图入口 | 左侧工具条新增「扩图」（快捷键 `E`）+ 右栏新增「扩图」页签 + 预设卡片「扩图」三处互通（§14.5） |
| 扩图交互 | 画布上直接拖四条边（幽灵灰边实时预览），右侧同时给 % / px 输入、比例锁、快捷比例、目标尺寸与 32 对齐提示（§14.5） |
| 会不会改坏原图 | 不会。扩图只收集四边百分比，**提交后才生成**；原图、蒙版、图层都不动（§14.5） |
| 与零偏移/校色 | 扩图自动关零偏移（尺寸必变），但原图区域仍逐字节保留；色彩校准只作用于外扩区与接缝带（§14.7） |

### 14.1 原则

1. **参数全部可调，但默认折叠**：常用项（预设、两个保护开关）常显；其余进「高级」，避免第一眼就是 30 个数字。
2. **可调 ≠ 该调**：每项标出"预设默认值"，改动后显示 `已修改 ↺`，用户随时能回去。
3. **参数不复制**：高级区显示的是预设解析后的**生效值**，不是前端自己的一套常量；提交时只带 `preset` + 覆盖项（§14.4）。
4. **扩图是工具，不是设置里的一个数字**：它需要看画面、拖边、看尺寸，必须有自己的面板。
5. **孤海能设的我们都能设**，且比它多：px/% 双单位、快捷比例、四边同步、上限实时校验、幽灵预览。

### 14.2 高级设置参数清单（含提示文案）

> 控件建议：数字=带单位输入框 + 步进；开关=switch；枚举=下拉；只读=灰字。
> 「预设默认」列就是 §13.6 的生效值；用户改动后按 §14.3 显示状态。

#### A. 裁切（仅 `scheme=b`）

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `local.expand_top` | 数字 ×，step 0.05 | 1.30 | 1.00~3.00 | 遮罩包围盒**短边**向上扩展的倍数。调大给模型更多上方上下文（更稳、更慢），调小更贴合选区（更快，但边缘可能缺上下文） |
| `local.expand_bottom` | 数字 × | 1.40 | 1.00~3.00 | 向下扩展倍数，含义同上 |
| `local.expand_left` | 数字 × | 1.40 | 1.00~3.00 | 向左扩展倍数，含义同上 |
| `local.expand_right` | 数字 × | 1.40 | 1.00~3.00 | 向右扩展倍数，含义同上 |
| `local.fills` | switch | 移除=开，其余=关 | — | 把闭合选区内部的孔洞一起算进遮罩。移除人物/物体时打开，否则可能只移除描边、中间留空 |
| `local.crop_min_side` | 下拉 512/768/1024/1536/0 | 768（扩图 1024） | 0~2048 | 裁切块长边下限。小选区会被**放大**到这个尺寸再送模型，细节更实但更慢；`0` 表示不放大 |
| `local.crop_max_side` | 下拉 1536/2048/3072/4096 | 2048 | 512~4096 | 裁切块长边上限。越大细节越多、显存占用越高；爆显存就调小 |
| `local.legacy_crop` | switch（高级） | 关 | — | 回退旧版上下文裁切（倍数 + 固定像素）。仅用于对比排查，日常不要开 |
| `local.context_factor` | 数字 × | 1.50 | 1.0~4.0 | 旧版裁切：包围盒放大倍数（仅 `legacy_crop=on` 时生效） |
| `local.context_pixels` | 数字 px | 96 | 0~1024 | 旧版裁切：额外上下文像素（仅 `legacy_crop=on` 时生效） |

#### B. 接缝（仅 `scheme=b`）

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `local.expand_pct` | 滑块 % | 4 | 0~20 | 贴回时先**向外多写一圈**（占遮罩平均边长的百分比），把模型重绘的背景过渡带一起贴回来，消除矩形边。`0`=不扩 |
| `local.feather_pct` | 滑块 % | 5（扩图 3） | 0~30 | 外扩后的羽化宽度（同样按平均边长百分比）。越大过渡越柔；过大会把周围细节带糊 |
| `local.dither` | switch | 开 | — | 在过渡带加入幅度小于 1/255 的确定性抖动，消除 8bit 圆整造成的色阶线。一般不用关 |
| `local.blend_pixels` | 数字 px（高级） | 24 | 0~256 | 旧版向内羽化像素，**仅当 `expand_pct` 与 `feather_pct` 都为 0 时生效** |

#### C. 合成（仅 `scheme=a`）

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `local.feather` | 数字 px | 32 | 0~256 | 遮罩边缘向内羽化的像素数。越大拼接越柔；写 `0` 会被当成 32（要硬边请填 1） |
| `local.mask_expand` | 数字 px | 0 | 0~256 | 把可写入区域向外扩 N 像素。`0`=严格只改选区；调大会轻微改写选区外 |
| `local.color_match` | switch | 开 | — | 是否对写入区做颜色匹配，防止模型输出偏色/偏亮。关掉后接缝可能出现色差 |
| `local.color_strength` | 滑块 | 0.60 | 0~1 | 颜色匹配强度。`0`=不校色，`1`=完全采用匹配结果；建议 0.5~0.8 |
| `local.band_mode` | 下拉 | 低频移植 | 低频移植 / 透明度混合 | 过渡带混合方式。低频移植抗亮度台阶（默认）；透明度混合更保细节但可能露边 |

#### D. 色彩校准（A/B/native 全局）

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `local.color_restore` | switch | **开** | — | 用画面里几乎没变的像素估算整体色偏并拉回（锚区仿射）。图片精修的默认保护之一；关掉后输出可能整体偏色 |
| `local.color_restore_strength` | 滑块 | 1.00 | 0~1 | 校色强度。`0`=只统计不应用；`1`=完全校正。建议 0.8~1.0，调低可保留一点"模型原味" |
| `local.hint` | 只读标签 | 按任务 | — | 提示图。移除=绿色选区、扩图=灰边，都是 LoRA 训练约定，不可改；普通编辑无提示 |

#### E. 一致性 LoRA

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `local.consistency` | switch | 开 | — | 普通编辑挂载一致性 LoRA，抑制整体漂移（换衣服/换背景时主体不跑）。移除/扩图任务会自动改用对应任务 LoRA |
| `consistency strength` | 滑块，两位小数 | 0.48 | 0~2 | 强度。0.3~0.6 适合换色/换材质；>0.8 更贴原图但改动幅度变小；0=等于不挂 |
| 自定义 LoRA 强度 | 数字，两位小数 | 1.00 | 0~2 | 每个 LoRA 的权重；多个 LoRA 叠加时建议总和不超过 1.5 |

#### F. 大图预处理

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `preprocess.enabled` | switch | 开 | — | 大图先缩到长边上限再送模型，出图后按记录还原。零偏移闭环的一部分；关掉后 4K 图更慢且可能爆显存 |
| `preprocess.max_side` | 下拉 1024/1536/2048/3072 | 2048 | 256~8192 | 预处理长边上限。越大细节越好、越慢；显存不足时调小 |
| `preprocess.mode` | 下拉 | 只缩不放 | 只缩不放 / 夹到区间 | 只缩不放=小图保持原尺寸；夹到区间=小图也会被放大到区间内 |
| `preprocess.multiple` | 只读 | 32 | — | 32 对齐倍数，零像素偏移的前提，不建议修改 |
| `preprocess.min_side` | 数字（仅"夹到区间"时显示） | 768 | 256~8192 | 仅"夹到区间"模式生效：小图放大后的长边下限 |

#### G. 扩图（§14.5 面板的"高级"部分）

| 键 | 控件 / 单位 | 预设默认 | 范围 | 悬浮提示文案 |
| --- | --- | --- | --- | --- |
| `outpaint.left/right` | 数字 %（宽度） | 0（由用户设） | 0~400 | 左右外扩按**原图宽度**的百分比计算；100% = 向外扩出一个原图宽度 |
| `outpaint.top/bottom` | 数字 %（高度） | 0 | 0~400 | 上下外扩按**原图高度**的百分比计算 |
| `outpaint.max_side` | 下拉 3072/4096/5120/8192 | 5120 | 1024~8192 | 外扩后画布长边上限，超过直接报错不提交。显存不足就调小 |
| 外补颜色 | 只读色块 | `#808080` | 固定 | 孤海扩图训练约定的灰色，不要改；模型靠"去掉灰色"来延展画面 |
| 灰色提示词 | 只读/可追加 | 自动补全 | — | 输入框为空时后端自动补「移除图像中的灰色区域，无缝自然延展为完整图像。」，你只需补充场景描述 |

#### H. 采样与保护

| 键 | 控件 | 预设默认 | 提示文案 |
| --- | --- | --- | --- |
| `zero_shift.enabled` | switch | **开** | 零像素偏移保护：32 对齐 + resolution=0 + latent==画布 + 整数裁回。关闭后可能出现 1~31px 位移或亚像素模糊；扩图任务自动关闭 |
| 步数 / 采样器 / cfg | 下拉 / 数字 | 9 / euler / 1.0 | 孤海 9 步档位；步数越高越慢，9 步已是该 LoRA 的训练档位 |
| 色彩校准（页首开关） | switch | 开 | 同时控制 `color_match` 与 `color_restore`；关闭只影响校色，不影响零偏移 |

### 14.3 「恢复默认」的语义（三级，不搞歧义）

```
默认目标 = 当前预设的参数包（§13.6）；当前没有预设时 = 后端内置默认（§12 表）
```

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 单项恢复 | 每个被改动项右侧的 `↺` | 只把该项恢复为预设值，并移除它的覆盖记录 |
| 分组恢复 | 每组标题右侧「恢复本组」 | 把该组所有项恢复为预设值 |
| 全部恢复 | 高级区底部「恢复全部默认」 | 清空所有覆盖项（含扩图四边），回到当前预设的原始参数包；**不动**两个保护开关与画面内容 |

- 恢复后自动收起"已修改"chip；若当前预设不存在（第三方 API），按 §12 内置默认恢复。
- 加一个只读提示："恢复的是预设默认值，不是清空所有设置。"
- 危险操作不需要二次确认（可撤销、无副作用），但要给 1 秒 toast：「已恢复 局部编辑 的默认参数」。

### 14.4 数据流（预设 + 覆盖项）

**前端状态（图片精修页）：**

```js
settings.edit = {
  preset: 'mask_edit',
  overrides: {                 // 只存被用户改过的键，扁平命名
    'local.expand_pct': 6,
    'local.crop_min_side': 1024,
    'outpaint.left': 235,
  },
  protection: { color: true, zeroShift: true },
}
```

**提交规则：**
1. `payload.preset = settings.edit.preset`；
2. 覆盖项按 §14.2 的键展开成 `local.*` / `preprocess.*` / `outpaint.*` 平铺字段；
3. 保护开关分别写 `zero_shift.enabled` 与 `local.color_match` + `local.color_restore`（关闭时两者都 false）；
4. 后端仍按「显式 > 预设 > 内置默认」合并（§13.5），所以老前端/第三方请求不受影响。

**回显：** 结果面板的"本次生效"直接读 `quality`（scheme / zero_shift.verified / preprocess / color.mask_band / outside_max_abs）与提交时的 `preset`，不要前端自己推断。

### 14.5 扩图面板（入口 + 布局 + 交互）

#### 入口（三处互通）

1. **左侧工具条**新增「扩图」按钮（图标：向外四箭头；快捷键 `E`，`Shift+E` 直接套 `outpaint` 预设）。
2. **右栏页签**新增「扩图」（`ai / adjust / mask / transform / outpaint`），与工具条联动。
3. **预设卡片「扩图」**：选中后自动切到扩图页签并聚焦"上/下/左/右"第一个输入；四项全 0 时按钮禁用并提示"先设置至少一条边"。

#### 面板布局（右侧 320px，与现有抽屉同风格）

```
┌ 扩图 ───────────────────────────── ─ × ┐
│ 原图 4096×2304                          │
│ 目标 5120×3072 · 32 对齐 · ↑24% ↓232%  │
│                                          │
│  上   [  24 ] %      ≈ 553 px            │
│  下   [ 232 ] %      ≈ 5345 px           │
│  左   [ 235 ] %      ≈ 9626 px           │
│  右   [  69 ] %      ≈ 2826 px           │
│                                          │
│  [ ] 四边同步   [ ] 保持原图比例           │
│  快捷：[1:1] [4:3] [16:9] [9:16] [重置]    │
│                                          │
│  长边上限 [5120 ▾]   超出会阻止提交        │
│  ⚠ 4000×3000 → 9440 超过上限，请调小        │
│                                          │
│           [取消]   [开始扩图  E]           │
└──────────────────────────────────────────┘
```

#### 画布交互（舞台区）

| 交互 | 行为 |
| --- | --- |
| 进入工具 | 原图不动，四周出现**半透明灰色幽灵区**（透明度 55%）与 4 个边缘手柄；手柄外侧显示胶囊 `+24%` |
| 拖动边缘 | 实时改该边百分比（px 四舍五入），目标尺寸与超限提示同步刷新；拖到 0 时手柄贴边不消失 |
| `Shift` + 拖动 | 对边同步（上↔下、左↔右） |
| 双击手柄 | 该边归零 |
| 角部拖拽 | 同时改两条相邻边（不做等比锁，等比用开关） |
| 快捷比例 | 以原图为中心补到目标比例：1:1 / 4:3 / 16:9 / 9:16，自动分配四边百分比（例如 16:9 只加左右） |
| 缩放/平移 | 沿用现有 `view`，扩图模式不抢占滚轮 |
| `Esc` / 取消 | 退出工具，不修改任何状态 |
| 提交中 | 按钮转 loading，画布保留幽灵区，完成后展示结果 |

> 视觉：深色玻璃浮层、8px 圆角、手柄 28×28 圆角矩形、百分比胶囊等宽字体、120ms 过渡；与现有 Apple 风格设置抽屉一致，**不做孤海那种一排输入框 + 预览小窗**。

#### 提交行为

- 自动切 `task.mode=outpaint`，`size_mode=follow`（后端扩图不用 custom 尺寸）。
- 提示词为空 → 后端补孤海灰边指令；用户可在 AI 输入框追加场景描述。
- 有蒙版时提示「扩图不使用蒙版，选区将被忽略」，但不阻止提交（灰边即遮罩）。
- 完成后结果卡片提供：`再次扩图` / `继续精修`（把结果载入画布）/ `下载`。

### 14.6 后端契约（扩图）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task.mode` | `"outpaint"` | 缺省提示词自动补全、LoRA 自动挂 `outpaint`（0.7） |
| `outpaint.left/right` | float %（源图宽） | 后端 `outpaint_canvas` 转整数像素，画布向上 32 对齐，多出的像素补右/下 |
| `outpaint.top/bottom` | float %（源图高） | 同上 |
| `outpaint.max_side` | int | **当前未透传**，需 P14-2 补：`imaging.outpaint_canvas(..., max_side=...)` |
| 外补色 | 固定 | `#808080`，不开放修改 |
| `zero_shift` | 自动关 | 尺寸必变，输出不回源尺寸 |
| `preprocess` | 跳过 | 扩图自己决定画布，避免二次缩放 |
| `local.scheme` | `b` | 在扩大后的画布上按灰边裁块采样，原图区域仍逐字节保留 |
| `local.expand_pct/feather_pct` | 3 / 3 | 扩图预设值（§13.6） |

**验收口径：** 输出尺寸 = 32 对齐后的外扩画布；原图区域 `outside_max_abs == 0`（蒙版=外扩区）；无灰边残留；接缝无硬边；大幅外补不出现"灰边被切掉一半"。

### 14.7 与预设、零偏移、色彩校准的关系

- **扩图是预设的一种**（`outpaint`），不是独立管线；面板改的四边就是该预设的覆盖项。
- **零偏移**：扩图自动关（`quality.zero_shift.enabled=false`），界面显示"扩图模式不校验回源尺寸"，避免用户以为保护失效。
- **色彩校准**：保持默认开，作用域=外扩区 + 接缝带；原图区域不做任何写入，所以"遮罩外不动"的承诺仍然成立（这里的遮罩是灰边区）。
- **切换预设**：从 `outpaint` 切回其他预设时，扩图四边保留在 `overrides` 里但不生效（`task.mode` 已不是 outpaint），并显示灰字提示"扩图参数已保存，切回扩图预设继续使用"。

### 14.8 边界与异常

| 情形 | 行为 |
| --- | --- |
| 未打开图片 | 扩图工具禁用，页签显示"先打开一张图片" |
| 四边全 0 | 提交按钮禁用，提示"至少设置一条边" |
| 超过长边上限 | 输入框标红 + 按钮禁用 + 显示当前/上限；不静默夹取 |
| 输入非数字 / 负数 | 归 0 并恢复上一次合法值，不弹窗 |
| 单边 > 400% | 输入框标红，提示上限 |
| 超大图（> 30MP） | 进入扩图时提示"建议先裁剪或开启预处理" |
| 提交失败（后端 ValueError） | toast 显示后端原文（例如"扩图参数不可用：…"） |
| 结果尺寸与预览不一致 | 以 `quality.output` 为准刷新，并提示实际尺寸 |

### 14.9 实施步骤与验收

| 步骤 | 内容 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| P14-1 | 高级设置组件：8 组、每项 tooltip、单位、默认徽标、`已修改 ↺`、组/全局恢复 | `web/src/components/studio/aiPanel.js`、`web/src/components/studio/advanced.js`（新）、`app.css` | 改动任一项出现 chip；单项/分组/全部恢复都能回到预设值；悬浮提示完整 |
| P14-2 | 后端补 `outpaint.max_side` 透传；扩图预设参数接线（1024 / 3 / 3 / 5120） | `server/pipeline.py`、`server/imaging.py`、`tests/` | 超上限请求 400；扩图裁块下限 1024 生效；接缝 3/3 |
| P14-3 | 预设 + 覆盖项数据流（settings.edit → payload 平铺） | `studio/payload.js`、`studio/aiPanel.js` | 只改一项时 payload 只多一个字段；未改时只带 `preset` |
| P14-4 | 扩图面板 + 幽灵预览 + 拖边 + 快捷比例 + 32 对齐尺寸提示 | `studio.js`、`studio/outpaintPanel.js`（新）、`app.css` | 拖边实时刷新 %/px/目标尺寸；Shift 同步；Esc 不落状态 |
| P14-5 | 结果回流：再次扩图 / 继续精修 | `studio.js`、`aiPanel.js` | 结果可一键载入画布，尺寸标记正确 |
| P14-6 | 真机回归：小扩（+10%）/ 大扩（+235%）/ 单侧扩；照片素材 | `.cache/smoke_real_edit.py` | 原图区域 `outside_max_abs=0`、无灰边残留、无硬接缝；与孤海同图对照不差于它 |

**施工状态（2026-11-07）：**

- **P14-2 ✅** `outpaint.max_side` 已透传到 `imaging.outpaint_canvas`（缺省 5120，服务端校验 1024~8192，超范围 400）；扩图裁块下限默认 **1024**、接缝默认 **3%/3%**，编辑档仍是 768 / 4%/5%（决策 37 分家）。验证：`test_generate_edit_outpaint_honors_max_side`、`test_generate_edit_outpaint_preset_uses_1024_crop_and_3pct_seam`；全量 **391 passed**。
- **P14-3 ✅** 预设模式数据流落地：`studio/payload.js` 新增 `nestOverrides`，传 `settings.preset` 时只发 `preset` + 覆盖项（+ 关闭的保护开关），未改高级项时 payload 里除 `preset` 外不多任何字段；`local.scheme/feather/mask_expand/preprocess` 未覆盖时不落字段，由后端预设补全。不带 `preset` 的旧调用保持原 payload（回归零变化）。任务约定优先：`task=remove` 强制 `fills=true + green_overlay`，`task=outpaint` 强制 `gray_fill + fills=false`。
- **P14-1 ✅** 新增 `studio/advanced.js`（7 组可调 + 1 条只读约定）：裁切与上下文 / 接缝与羽化 / 合成策略 / 色彩还原 / 一致性 / 大图预处理 / 扩图；每项带单位、范围、作用提示（行内 hint + `title`），生效值 = 覆盖项 > 预设 > 显示兜底。恢复分三级：单项 ↺、分组 ↺（标题旁显示「N 项已改」）、全部恢复。`aiPanel` 的旧内联参数（羽化/外扩/局部策略/预处理）已并入高级设置，提交时只有覆盖项进 payload。
- **P14-4 ✅** 新增 `studio/outpaintPanel.js` 并接入 `studio.js`：左栏工具 `X`、右栏「扩图」页签、AI 面板「扩图 / 外补画布 →」三处入口，进入即套 `outpaint` 预设（任务同步切 `outpaint`）。画布上一层 DOM 幽灵预览（`.studio-outpaint`）：四边灰色斜纹外补区 + 虚线整框 + 4 个边中点圆点手柄 + 4 个角手柄，位置按 `view.x + imageX * view.scale` 实时跟随缩放/平移；拖动手柄实时改 `outpaint.*` 覆盖项并显示 `+N%` 胶囊，双击手柄清零，按住 Shift 拖动临时反转「对边同步」。面板含四边 % 输入、对边同步、快捷比例（1:1 / 4:3 / 3:4 / 16:9 / 9:16）、最大输出长边（默认 5120）、目标尺寸实时预览；四边全 0 或超长边上限时按钮前拦截并高亮提示。提交前不改 `doc`、不写历史；Esc 退出工具只隐藏幽灵层，覆盖项保留（符合决策 49）。验证：浏览器实测 `512 × 512 → 686 × 512`（点 4:3 前后尺寸变化）、8 个手柄与斜纹外补区正常；全量 **391 passed**。
- **P14-5 ✅** 结果回流：结果区新增「载入为新底图」（`adoptBtn`）+ 尺寸提示（`载入后 W×H 成为新底图…`）；点击后 `studio.ctx.adoptResult()` 解码结果图并新建 `StudioDoc`，文件名按任务加后缀（扩图 `-扩图.png`、其余 `-精修.png`），顶栏尺寸 / 缩放随解码后的真实像素刷新，蒙版、叠加层、撤销历史随新文档清空，可继续精修或再次扩图。`setDoc()` 同时调用 `ai.resetResult()` 清掉旧结果态（预览标记、尺寸标签），避免打开新图后仍指向上一张结果。全量 **391 passed**。

### 14.10 决策（钉死）

42. **高级设置里所有参数必须可改**，且每项都有单位、范围、默认值与作用提示；只读项只允许「32 倍数」「外补色」「提示图」这三类训练约定。
43. **恢复默认 = 回到当前预设值**；无预设时回到 §12 内置默认。单项 / 分组 / 全部三级，不做"清空设置"。
44. **扩图是独立工具**（工具条 + 页签 + 预设三处入口），不是藏在设置里的四个数字。
45. **扩图不破坏文档**：幽灵区只是预览，提交前不改 `doc`、不改蒙版、不写历史；输出后由用户决定是否"继续精修"。
46. **扩图单位统一用 %（源图宽/高）**，同时显示 px；32 对齐由后端保证，UI 只展示不自行取整。
47. **扩图上限默认 5120、硬上限 8192**；超限阻止提交，不静默夹取。
48. **扩图自动关零偏移校验**，但保留"原图区域逐字节不变"的承诺；界面必须写明这一点，避免和"零偏移保护被关掉"混淆。
49. **切换预设不丢覆盖项**：`overrides` 常驻，只显示"当前不生效"；不要因为切预设就清掉用户填的扩图比例。
50. **参数与预设都要可回放**：`job.params` 记录 `preset + preset_version + outpaint 四边 + 所有覆盖项`。

---

## 15. 图生图模块（图像编辑）同步方案（2026-11-07 钉死）

> 背景：本轮新增的能力（预设、孤海几何、零偏移默认开、色彩校准、扩图、高级设置、LoRA 开关修复）
> 都只在「图片精修」里；「图生图 / 图像编辑」（`edit.js`）还是旧参数集，两边已经不一致。
> 本节先把**现状联动**摸清，再定同步方案；不在两页各写一套。

### 15.0 结论（先看这段）

| 问题 | 结论 |
| --- | --- |
| 两页是什么关系 | 同一个后端 `/api/edit`、同一个 `pipeline.generate_edit`，只是一页有 PS 工具（蒙版/图层/扩图面板），一页是"上传→指令→出图"。**应该共用预设与高级设置，而不是各维护一套**（§15.4） |
| 图生图现在缺什么 | 缺 `preset / task.mode / preprocess / zero_shift / color_restore / fill / 新裁切几何 / 接缝百分比 / auto·native 方案 / 高级设置`，且一致性 LoRA 关不掉（§15.3） |
| 扩图为什么有两套 | 图生图/图像处理是**前端扩画布 + 手动遮罩**（`/api/image/outpaint-plan`）；图片精修是**后端灰边 + outpaint LoRA**。两者语义不同，必须收敛（§15.5） |
| 会不会破坏老配置 | 不会。旧 `settings.edit` 字段继续接受，映射进 `overrides`；旧扩图入口保留为 legacy，默认隐藏（§15.6） |
| 工作量归属 | P14（高级设置 + 扩图面板）与 P15（图生图同步）都由我实现；后端只保留 `outpaint.max_side` 透传这类小改动 |

### 15.1 现状：图生图是怎么联动的

```
编辑页 edit.js
├─ store.state.edit（localStorage 持久化）        # 尺寸/步数/方案/遮罩羽化/一致性等
├─ images[]                                        # 第 1 张 = 编辑目标（含 mask）
├─ 工具栏/侧栏：尺寸模式、采样、LoRA、一致性、参考图、姿态、风格
├─ collectPayload()                                # L1849 起
│   ├─ prompt / negative_prompt / images / mask
│   ├─ size_mode(follow|custom|ratio) / width / height / ratio / megapixels / fit / pad_mode
│   ├─ local{enabled, scheme(a|b), feather, color_match, color_strength,
│   │        mask_expand, context_factor, context_pixels, blend_pixels}
│   ├─ resolution:0 / steps / cfg / seed / denoise / sampler / scheduler
│   ├─ turbo{enabled, profile} / models{unet, clip, vae} / loras[]
│   ├─ consistency_lora: 开 ? {name, strength} : null      ← 关不掉（同 §13.8 B1）
│   ├─ pose / meta{referenceMap, creativePresets, imageAngle}
│   └─ __maskOverlay（仅前端展示，不发送）
├─ POST /api/edit  →  job
└─ 轮询 /api/jobs/{id} → result / quality / align / 尺寸
```

后端：`main.api_edit` → `_validate_edit_params` → `pipeline.generate_edit` → `quality{scheme, zero_shift, preprocess, color, outside_max_abs}` 原样返回。

**关键事实：** 前端只用了后端能力的一小部分；后端早就支持 `preset`（待实现）、`task.mode`、`auto/native`、`preprocess`、`zero_shift`、`color_restore`、`expand_*`、`expand_pct/feather_pct`、`dither`，是图生图页没有传。

### 15.2 逐项对照（图片精修 vs 图生图）

| 能力 | 图片精修（新） | 图生图（现状） | 处理 |
| --- | --- | --- | --- |
| 预设 `preset` | 有计划（§13.5） | 无 | 两页共用 |
| 方案 | `a / b / auto / native` | 只有 `a / b` 单选 | 两页共用同一枚举 |
| 裁切几何 | `expand_*` + `crop_min/max` + `fills` | `context_factor / context_pixels`（旧几何） | 旧字段继续接受，默认切新几何 |
| 接缝 | `expand_pct 4 / feather_pct 5 / dither` | `blend_pixels`（旧向内羽化） | 两页共用；旧字段仅在 `expand_pct=feather_pct=0` 时生效 |
| 合成 | `feather / mask_expand / color_match / color_strength / band_mode` | 有前四项，无 `band_mode` | 补齐 `band_mode` |
| 色彩校准 | `color_restore + strength`（默认开） | 只有 `color_match` | 补 `color_restore`（默认开） |
| 零偏移保护 | `zero_shift`（默认开） | 无 | 补，默认开 |
| 大图预处理 | `preprocess`（默认开 2048） | 无 | 补，默认开 |
| 任务 | `task.mode`（remove/outpaint） | 无（永远是 edit） | 补，默认由预设推断 |
| 一致性 LoRA | 可开关 + 强度 | 开关传 `null` → 关不掉；强度滑块范围受限 | 两页一起修（§13.8） |
| 扩图 | 后端灰边 + outpaint LoRA（新面板） | 前端扩画布 + 白遮罩 + 通用提示词 | 收敛（§15.5） |
| 高级设置 | §14（8 组、提示、恢复默认） | 无，参数散落在侧栏且没有提示 | 复用同一组件 |
| 结果回显 | scheme / zero_shift / mask_band / outside_max_abs | 只看尺寸与 outside_max_abs | 共用结果卡片 |

### 15.3 差距清单（按影响排序）

| # | 差距 | 影响 |
| --- | --- | --- |
| G1 | 一致性 LoRA 关不掉（`null` 被当成"未传"） | 想关的用户关不掉，出图更贴原图、改动幅度小 |
| G2 | 没有 `zero_shift` / `preprocess` | 大图更慢、可能亚像素偏移，用户不知道保护没开 |
| G3 | 没有 `color_restore` | 模型整体偏色时只能靠 `color_match`，整图色偏拉不回 |
| G4 | 没有 `task.mode` | 图生图做不了"元素移除"（不会挂 Remove LoRA、不填洞、不发绿提示） |
| G5 | 扩图两套路径语义冲突 | 同一需求出两种结果，用户不知道该用哪个 |
| G6 | 只有 a/b，没有 `auto/native` | 小遮罩也走整画布；想复刻"原生"效果只能去图片精修 |
| G7 | 参数散落、无提示、无恢复默认 | 用户不知道 `context_factor` 和 `expand_pct` 是两代参数 |
| G8 | 结果信息不全 | 看不出实际用了哪个方案、过渡带多宽 |

### 15.4 同步方案：图生图 = 同一套预设的"轻量壳"

**原则：** 页面只是入口不同，参数、预设、保护开关、结果回显全部共用。

```
web/src/components/studio/presets.js      （新，纯数据 + 合并/覆盖工具）
web/src/components/studio/advanced.js     （新，§14 高级设置组件）
web/src/components/studio/guards.js       （新，两个保护开关 + 文案）
        ↑ import            ↑ import
  studio/aiPanel.js       components/edit.js
```

- **图生图页新增**：顶部「预设」横条（同 §13.6 五个）、下方两个保护开关、侧栏折叠「高级」（复用 `advanced.js`，参数 binding 前缀不同而已）。
- **提交**：与图片精修同一套 `preset + overrides` 规则（§14.4），不再手写 `local` 字段。
- **默认预设**：有遮罩 → `mask_edit`；无遮罩 → `canvas`（不假装局部编辑）。`remove`/`outpaint` 由用户显式选。
- **不引入 PS 工具**：图生图不加画笔/图层/变换，只保留现有上传、参考图、姿态、风格；蒙版仍是原图的 ✂。

### 15.5 扩图收敛（两套变一套）

| 路径 | 现状 | 结论 |
| --- | --- | --- |
| 后端灰边扩图 | `task.mode=outpaint` + `outpaint{left,right,top,bottom}` + 灰提示 + 扩图 LoRA 0.7 | **主路径**，图片精修与图生图都用它 |
| 前端扩画布 | `POST /api/image/outpaint-plan` 算画布 → canvas 贴原图 → 生成白遮罩 → 当普通 inpaint | **降级为 legacy**，改名「手动扩画布（旧）」收进下拉，默认隐藏 |

- 图生图的 `⤢ 扩图` 按钮改为打开 §14.5 的四边面板（同一个 `outpaintPanel`），提交时写 `task.mode=outpaint` + `preset=outpaint`。
- 旧的"先扩画布再涂抹"保留给需要手动控制新增区域内容的高级用户；选择时明确提示「旧流程不会使用扩图 LoRA，效果与新扩图不同」。
- `/api/image/outpaint-plan` 不删（图像处理页还在用），只作为 legacy 的几何计算。

### 15.6 兼容与迁移

| 旧配置 | 迁移规则 |
| --- | --- |
| `settings.edit.scheme = 'a'/'b'` | 映射为 `overrides['local.scheme']`；没有则跟随预设 |
| `feather / colorStrength / maskExpand` | 原样映射到 `local.feather / color_strength / mask_expand` |
| `contextFactor / contextPixels` | 保留；仅当 `legacy_crop=true` 时生效 |
| `blendPixels` | 保留；仅当 `expand_pct=feather_pct=0` 时生效 |
| `consistencyEnabled=false` | 迁移为 `local.consistency=false` **并** `consistency_lora=false`（修 G1） |
| 历史任务回放 | `job.params` 里没有 `preset` 的按 `custom` 处理，只用记录里的显式参数 |

### 15.7 实施步骤与验收

| 步骤 | 内容 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| P15-1 | 抽出 `presets.js / advanced.js / guards.js` 公共模块，图片精修先接入（P14 复用） | `web/src/components/studio/` | 两页 import 同一份，无重复常量 |
| P15-2 | 图生图 payload 升级：`preset + overrides + task.mode + preprocess + zero_shift + color_restore + band_mode` | `components/edit.js` | 只改一项时只多一个字段；旧配置仍能提交 |
| P15-3 | 图生图 UI：预设横条 + 两个保护开关 + 高级折叠 | `components/edit.js`、`app.css` | 默认 `mask_edit`（有遮罩）/`canvas`（无遮罩）；开关可关且有后果提示 |
| P15-4 | 扩图收敛：新面板接入 `⤢ 扩图`，旧流程降级并加对比提示 | `components/edit.js`、`components/outpaint.js` | 新路径出图带灰边延展；旧路径仍可用且标注 legacy |
| P15-5 | 移除任务：图生图可选 `task.mode=remove`，强制 `fills=true` + 绿提示只读说明 | `components/edit.js` | 选移除后出图无残影；提示词自动补「移除图像中的绿色区域」 |
| P15-6 | 结果回显统一（scheme / zero_shift / mask_band / outside_max_abs / preset） | `components/edit.js`、`studio/aiPanel.js` | 两页结果卡片字段一致 |
| P15-7 | 真机回归：同图同 seed 两页各预设出图参数一致 | `.cache/smoke_real_edit.py` | 两页 `job.params` 归一化后仅差工具态字段（画笔/图层） |

**施工状态（2026-11-07）：**

- **P15-1 ✅** 公共模块已抽出并接入图片精修：`studio/presets.js`（`/api/meta` 拉取 + 预设/覆盖项合并 + 无蒙版降级）、`studio/guards.js`（色彩校准 / 零像素偏移两开关，值写 `settings.edit.protection` 并跨页共享）、`studio/advanced.js`（8 组高级设置 + 三级恢复）。`store.DEFAULT_EDIT` 新增 `preset/overrides/protection`。图生图页在 P15-2/P15-3 直接 import 同一份。
- **P15-2 ✅** 图生图 payload 升级为「预设模式」：`collectPayload` 先按 `edit.preset` + 有无遮罩解析预设（有遮罩 `mask_edit`、无遮罩降级 `canvas`），命中预设时只发 `preset + overrides`（`nestOverrides` 复用图片精修同一份），未改高级项时请求里除 `preset` 外不多任何字段；`local.*` 完整字段只在无预设（meta 拉取失败）时保留，老配置仍按原样提交。`task.mode` 两页都显式传（取预设 `task_mode`）；`remove` 强制 `fills=true + green_overlay`、`outpaint` 强制 `fills=false + gray_fill`。同时修 G1：一致性关掉改发 `consistency_lora:false` 且预设模式补 `local.consistency=false`。旧设置按 §15.6 迁移：`scheme/feather/colorMatch/colorStrength/maskExpand/context*/blendPixels` 仅在与预设值不同时落覆盖项。提交前 `await ensurePresets()`，失败自动退回旧参数集。全量 **391 passed**。
- **P15-3 ✅** 图生图侧栏上线「方案预设 / 本次保护 / 高级参数」三块，全部复用图片精修同一套组件与数据：预设横条直接渲染 `/api/meta.edit_presets`（5 卡 + 版本号 + 摘要 + `已修改` 标记），点卡片写 `edit.preset`；`mountGuards` 两开关写 `edit.protection`；`mountAdvanced` 7 组折叠直接读写 `edit.overrides`，快捷滑杆也改为写覆盖项（`withOverride`），与高级面板双向回显。无蒙版时 `mask_edit/remove` 按 `canvas` 执行并在开关下方提示「将按整画布执行」。保护关闭时 payload 显式落 `local.color_match=false + local.color_restore=false`、`zero_shift.enabled=false`。旧字段一次性迁移到覆盖项（`edit.presetMigrated`），迁移后快捷项回显预设生效值。验证：浏览器实测 5 张卡片 / 2 个开关 / 7 组高级、切换卡片与滑杆 `56→64` 后高级面板同步为 64 且 `overrides` 落盘；全量 **391 passed**。
- **P15-4 ✅** 扩图收敛到新面板：`⤢ 扩图` 改为打开 `outpaintPanel` 弹窗（左侧原图 + 同一套幽灵预览，右侧四边百分比 / 对边同步 / 快捷比例 / max_side），`outpaintPanel` 增加 `destroy()` 解除 store 订阅，弹窗关闭即释放，重复打开不累积监听。弹窗打开时自动切 `outpaint` 预设，取消关闭会恢复原预设（避免后续普通编辑被当成扩图提交）；提交走 `task=outpaint`。旧「先扩画布再涂遮罩」流程保留为弹窗底部 `改用旧流程（legacy）`，生成画布后落回 `mask_edit` 并提示新旧差异。验证：浏览器实测 1600×899 原图 → 点 `4:3` 目标变 1600×1205、四边输入与幽灵层正常、关闭后预设恢复 `mask_edit`；全量 **391 passed**。
- **P15-5 ✅** 图生图新增「任务」下拉（跟随预设 / 通用编辑 / 局部重绘 / 元素移除 / 扩图）：选「元素移除」自动切 `remove` 预设，提交时强制 `fills=true + hint=green_overlay`，指令末尾自动补「移除图像中的绿色区域」，并在下拉下方给出只读说明（绿色提示图 + 遮罩外逐字节保留）；未涂蒙版时提交前拦截提示。选「扩图」自动切 `outpaint` 预设；点预设卡片或打开扩图弹窗会把任务重置为「跟随预设」，避免任务与预设互相覆盖；打开扩图弹窗取消时连同任务一起恢复。验证：浏览器实测任务下拉 5 项、切 `remove` 后预设变 `remove` 且说明文案出现；全量 **391 passed**。
- **P15-6 ✅** 结果回显统一：新增 `jobView.qualityItems(job)` 作为唯一字段口径，按 §12.11 依次输出 `preset/preset_version`、`scheme`（全画布/裁切/原生）、`zero_shift.verified`、`canvas`（32 倍数）、`color.mask_band`（外扩/羽化 px 与百分比）、`outside_max_abs`、`size_match`、`changed_ratio/leak_ratio`、`color.skipped`、`align.applied`；图生图/文生图批次卡片（`JobRunner.buildBadges`）与图片精修结果卡（`aiPanel.renderQuality`）都改为消费同一函数，只保留各自 CSS 类名差异。验证：浏览器用真实 edit 任务（1024×768、scheme=b）渲染出「耗时 46.1s / 尺寸 / 方案 裁切 / 零偏移 ✓ / 画布 1024×768 · 32 倍数 / 过渡带 外扩 12px · 羽化 16px / 零色差校验通过 · 遮罩外差异 0 / 尺寸一致」共 11 项，两页标签文本完全一致；带 `preset` 的任务额外显示「预设 mask_edit · v1」；全量 **391 passed**。
- **P15-7 ✅** 真机回归：`smoke_real_edit.py` 新增 `parity` 模式（`python -s .cache/smoke_real_edit.py 8722 parity 777`，脚本在 `.cache/` 内不入库），按两页真实 payload 形态（图片精修 `web/studio`、图生图 `web/edit`）对 5 个预设各起 2 个真实任务（同图 1024×768、同 seed 777、同 9 步 turbo9_ckpt、同遮罩），归一化剔除工具态 `meta/pose` 后比对 `job.params`。结果：**5/5 预设 `params` 差异 0 项**，输出尺寸一致（均 1024×768），scheme 一致（`mask_edit/remove/outpaint` = `b`，`canvas` = `a`，`native` = `native`），`outside_max_abs` 一致（`mask_edit/remove` = 0，`outpaint/canvas/native` = `null`），`preset` 均带回 `v1`；全量 pytest **391 passed**。

### 15.8 决策（钉死）

51. **图生图不是第二套实现**：它和图片精修共用预设、高级设置、保护开关、结果回显；页面只决定"有没有 PS 工具"。
52. **公共模块单身源**：预设/默认值/tooltip 只允许写一份（`presets.js` / `advanced.js`），两页 import；禁止复制常量。
53. **图生图默认预设按有无遮罩选择**：有遮罩 `mask_edit`，无遮罩 `canvas`；不默认 `native`（会关掉局部保护）。
54. **扩图只保留一条生成主路径**（后端灰边 + outpaint LoRA）；前端扩画布标记 legacy、默认隐藏，且必须提示"效果不同"。
55. **`task.mode` 两页都要显式传**；`remove` 必须 `fills=true`，`outpaint` 必须带四边百分比，后端继续兜底校验。
56. **保护开关跨页共享**：同一个 `settings` 键，切页不重置；关掉后结果卡片要显示"本次未启用"。
57. **旧字段永久兼容**（`feather/color_strength/mask_expand/context_*/blend_pixels`），只做映射不删除，避免老 localStorage 失效。
58. **图生图不引入 PS 工具栏**：只加预设/高级/扩图入口，保持"上传 → 指令 → 出图"的轻量定位。

---

## 16. 全局预设默认值 + 自定义搭配（v5）

### 16.1 产品语义

- **唯一持久化入口**：预设默认值只在「设置 → 预设与自定义」里保存，写进 `config.json`。
- **任务页修改是临时的**：任务页（图生图 / 图片精修）改 Turbo、采样、一致性、LoRA、方案、羽化等，会一直保留到**下次切换预设**；切换预设时重新加载全局默认值。刷新页面不会清掉临时值。
- **恢复出厂**：每个内置预设可单独恢复，也支持全部恢复。恢复依据是代码里的 `EDIT_PRESETS`，不是上一次手动保存的值。
- **自定义搭配**：在全局设置里命名、保存多套；任务页通过「自定义搭配」选择器使用。自定义**不继承任何内置预设**，后端只展开它自己保存的参数，未配置项走后端内置默认。
- **模板 + 冲突检测**：自定义从模板起步（局部编辑 / 整画布 / 原生 / 元素移除 / 扩图 / 全景），可自由组合；保存前做硬冲突校验，并提供「自动修复冲突」。

### 16.2 存储与 API

`config.json`：

```jsonc
{
  "preset_defaults": { "mask_edit": { /* 仅保存被覆盖的完整参数 */ } },
  "custom_presets": [
    { "id": "custom:xxxx", "name": "我的搭配", "params": { /* 完整参数 */ } }
  ],
  "preset_defaults_version": 5
}
```

- `GET /api/meta`：`edit_presets` 下发**全局默认生效后**的预设；`custom_presets` 下发自定义搭配摘要。
- `GET /api/presets/config`：设置页视图，返回 `factory`（出厂）/ `presets`（生效）/ `custom`（原始 `id/name/params`）/ `overridden` / `max_side`。
- `POST /api/presets/config`：
  - `preset_defaults`：按 id **补丁式**保存；值为 `null` 表示恢复该预设出厂值。
  - `reset_presets: [id...]`：批量恢复出厂。
  - `custom_presets`：全量替换自定义搭配列表。
- 保存后服务端立即刷新配置缓存，前端派发 `presets:updated`，已打开的任务页重新拉取并套用新默认值。

### 16.3 参数层

- `PRESET_VERSION = 5`。
- `_COMMON` 新增三组默认：
  - `sampling`：`steps/cfg/sampler/scheduler/denoise`
  - `consistency`：`enabled/lora/strength`（lora 为空 = 跟随系统默认文件）
  - `loras`：额外 LoRA 列表
- 管线读取顺序：**请求显式值 > 预设/自定义展开值 > 后端内置默认**。
  - `_sampling_plan` 支持 `params.sampling` 兜底；Turbo 开启时仍以加速档位为准。
  - 未显式传 `consistency_lora` 时，从 `params.consistency` 生成；显式 `consistency_lora` 不再重复挂 preset consistency。
  - remove / outpaint 的任务 LoRA 始终追加，不会被用户自定义 LoRA 挤掉。
- 任务页切换预设时同步：Turbo、采样、一致性、LoRA、快捷项与高级覆盖项；同一预设刷新页面保留临时值（`appliedPreset` 标记）。

### 16.4 冲突校验（保存前阻断）

硬冲突：

- 元素移除：`local.fills` 必须为 `true`，`local.hint` 必须为 `green_overlay`。
- 全景：`local.scheme` 必须为 `a`，`local.hint` 必须为 `gray_fill`。
- 自定义扩图：四边百分比至少一条 > 0。
- 裁块下限 > 上限、预处理下限 > 上限。
- 扩图 `max_side` / 全景 `long_side` 超过全局 `max_side`。
- 采样器 / 调度器 / Turbo 档位不在后端注册表内。
- 一致性 LoRA 或额外 LoRA 文件不存在。

警告（不阻断）：

- 原生模式 + 元素移除/扩图：边缘无法保证逐字节保留。
- 一致性关闭但仍有 LoRA 文件名或非默认强度。

### 16.5 代码位置

| 功能 | 文件 |
|---|---|
| 出厂预设 / 生效合并 / 自定义存储 / 校验 | `server/presets.py` |
| 设置页 API | `server/main.py`（`/api/meta`、`/api/presets/config`） |
| 采样 / 一致性 / LoRA 兜底 | `server/pipeline.py` |
| 设置页「预设与自定义」 | `web/src/components/presetSettings.js`、`settings.js` |
| 任务页预设同步 + 自定义选择器 | `web/src/components/edit.js`、`studio/aiPanel.js`、`studio/presets.js` |

测试：`tests/test_edit_presets.py` 覆盖预设覆盖/恢复、自定义不继承、冲突拒绝。

---

## 17. 遮罩编辑器可视化与覆盖率回显（补丁）

### 17.1 三个问题

| 现象 | 根因 |
| --- | --- |
| 遮罩压在深色主体上看不清 | 旧叠加只是羽化预览：`rgba(47,107,98,0.55)` × `globalAlpha 0.66`，有效不透明度约 36%，且是深墨绿 |
| 拖笔过程中几乎看不到正在画的区域 | 叠加层来自缓存离屏 canvas，只在 `pointerup → finalizeChange()` 时重建，绘制中画的是上一笔的缓存 |
| 只点了一下却提示「尚未绘制遮罩」 | 状态栏用 `Math.round(coverage * 100)`，48px 点在 2048×1365 上约 0.06%，被舍入成 0 |

第三条只是显示问题：`empty` / `getMask` 用的是 `coverage > 0`，保存本来就能成功。

### 17.2 画布分层（从下到上）

| 层 | 内容 | 说明 |
| --- | --- | --- |
| 底图 | 第 1 张参考图 | 按 dpr + 缩放/平移绘制 |
| `tintCanvas` | 原始遮罩（不羽化）染 `rgba(0,230,118,0.78)` | 静止时绘制，`globalAlpha 0.9` |
| `liveTint` | 视图像素级实时层 | 拖笔时每帧重建：把原分辨率遮罩画到一屏大小，再 `source-in` 染色 |
| `previewCanvas` | 羽化 + 外扩光晕 `rgba(0,230,118,0.55)` | `globalAlpha 0.38`，绘制中跳过（避免显示上一笔的光晕） |
| 包围框 | `alpha > 8` 的 bbox | 白黑双线虚线，快速定位画到哪 |
| 形状预览 | 矩形/椭圆拖拽 | 绿色实色 0.45；橡皮红色 0.35 |

遮罩数据仍然只存在原分辨率的 `maskCanvas` 里，`liveTint` 只影响显示，不改变导出。

### 17.3 覆盖率口径

- `computeCoverage()`：`alpha > 8` 计为覆盖，返回 `covered / total`。
- 判定「是否已绘制」一律用 `coverage > 0`（编辑器状态栏、`empty`、`getMask`）。
- `fmtCoverage()`（`utils.js`）统一文案：

| 覆盖率 | 显示 |
| --- | --- |
| 0 | `0%` |
| 0 < x < 0.1% | `<0.1%` |
| 0.1% ~ 10% | 一位小数，整数省略 `.0`（`2%`、`2.4%`） |
| ≥ 10% | 取整（`12%`） |

应用位置：遮罩编辑器状态栏、编辑页保存提示 / 缩略图「遮罩 x%」角标 / 右侧「遮罩覆盖 x%」、PS 面板状态栏「蒙版」、选区栏「选区」、AI 面板「已圈选」。

扩图规划与「图像处理」页交接带进来的遮罩，覆盖率不再硬编码 `0`，改由 `probeMaskCoverage()` 实算（alpha 有变化取 alpha，否则取亮度，与后端 `decode_mask` 同口径）。

### 17.4 指针健壮性

`setPointerCapture()` 在合成事件或部分触控笔下会抛 `NotFoundError`，抛出点在 `activeStroke` 赋值之前，会导致整笔被中断。现统一走 `capturePointer()`（try/catch）忽略该错误。

### 17.5 代码位置

| 功能 | 文件 |
|---|---|
| 分层绘制 / 实时层 / 包围框 / 覆盖率 | `web/src/components/maskEditor.js` |
| 覆盖率文案 | `web/src/utils.js`（`fmtCoverage`） |
| 编辑页遮罩回显、交接遮罩覆盖率 | `web/src/components/edit.js`（`probeMaskCoverage`） |
| PS 面板蒙版 / 选区 / 已圈选文案 | `web/src/components/studio.js`、`studio/aiPanel.js` |



