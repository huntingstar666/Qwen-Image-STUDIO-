# 图片精修工作台（PS 式）与孤海节点方案融合设计

> 状态：**方案定稿（预案）**，本文只做设计，不改源代码。
> 参考输入：`qwen2.1九步局部编辑API.json`、`qwen2.1元素移除API.json`、`qwen2.1扩图API.json`
> 节点源码：`<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\Goohaitools-comfyui\nodes\`
> 现有实现：`server/align.py`、`server/imaging.py`、`server/pipeline.py`、`web/src/components/studio.js`、`web/src/components/studio/studioDoc.js`

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

### 5.8 API 契约（`POST /api/edit`）

```jsonc
{
  "model": "qwen",
  "prompt": "把 @图一 中的苹果替换成 @图二 的梨子，保持光照与桌面材质",
  "prompt_raw": "用@图二的物品替换@图一中的苹果",

  "images": ["data:image/png;base64,...", "..."],   // 第 1 张 = 主图（图一）
  "mask":  "data:image/png;base64,...",             // 白色 + alpha，主图尺寸

  "task": { "mode": "edit" },                       // edit | remove | outpaint | fuse
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
  "elapsed_s": 18.4
}
```

### 5.9 默认参数表（前端默认值 = 后端默认值）

| 参数 | 默认 | 可调范围 | 说明 |
| --- | --- | --- | --- |
| `size_mode` | `follow` | follow / custom / ratio | 跟随主图分辨率 |
| `preprocess.enabled` | `true` | — | 大图保护 |
| `preprocess.max_side` | `2048` | 1024 / 1536 / 2048 / 2560 | 预处理尺寸 |
| `local.scheme` | `auto` | auto / a / b | auto：有遮罩且画布 > 1024² → b，否则 a |
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
| 预处理几何（只缩不放 / 32 对齐 / 可逆还原） | ✅ 已落地（12 条单测） | `server/imaging.py`、`tests/test_preprocess.py` |
| preprocess 接入 pipeline / zero_shift 强制 / task / fills / hint | ⏳ 后端并行中 | 前端已发字段，后端安全忽略 |

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
2. preprocess 接入 `pipeline.generate_edit`（预处理 → 画布 → 还原闭环）
3. `crop_region` 扩展系数 + 越界众数填色
4. `local.fills / hint=green`（移除场景）
5. 前端 `changed_ratio / leak_ratio / color.skipped` 标签联调

