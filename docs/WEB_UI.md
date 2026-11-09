# WEB_UI —— 前端工作台说明

> 归属：frontend。  
> 技术路线：**纯浏览器原生 ES module + 原生 CSS，零构建、零 npm、零框架**。  
> 服务端由 FastAPI 直接静态托管 `web/`，页面路径直接写 `/src/main.js`、`/assets/css/app.css`、`/vendor/image-style-kit/...`。

## 1. 页面结构

App Shell（所有页面共享）：

| 区域 | 内容 | 数据来源 |
| --- | --- | --- |
| 左侧边栏 | 品牌、创作 / 资产 / 工具三组导航、折叠按钮、主题切换（亮 / 暗 / 自动） | 静态 + `localStorage` |
| 顶部工具栏 | 页面标题 / 副标题 / 面包屑，右侧引擎、显存、Ollama、队列状态 | `GET /api/health`，每 5s 轮询 |
| 内容区 | `#viewport` 内按 hash 切换页面，宽度 100%（上限 1560px） | hash 路由 |

侧边栏导航共 7 项：

| 分组 | 页面 | hash |
| --- | --- | --- |
| 创作 | 文生图 | `#t2i` |
| 创作 | 图像编辑 | `#edit` |
| 创作 | 图片精修 | `#studio` |
| 资产 | 作品画廊 | `#gallery` |
| 资产 | 素材仓库 | `#materials` |
| 工具 | 图像处理 | `#tools` |
| 工具 | 历史记录 | `#history` |

> 主题：`theme.css` 提供 `html[data-theme="light|dark"]` 两套令牌，偏好存 `qi21.workbench.settings.v1`，支持跟随系统且首屏不闪烁。

> 旧版「风格库」独立页已按用户要求移除，改为「提示词框上方的工具条 + 弹窗选择器」。

### 风格选择器（提示词框上方，文生图 / 图像编辑共用）

- 工具条：`✎ 风格` / `🎨 MJ 码图` / `◐ 滤镜` / `⌖ 视角`，右侧显示 `◑ 已选 N`。
- 选中项以 chip 显示在提示词框上方，可单独移除；角度 chip 显示「方向 · 机位 · 景别」。
- **正文输入框永远保持用户原文**；提交时才用 vendor 的 `buildNodePrompt` 把预设 / 滤镜 / 视角合成进请求的 `prompt`。
- 两个页面各自维护独立选择集合（localStorage 按 `t2i` / `edit` 分 key 持久化）。

**风格弹窗**（约 920×620）：
- tabs「风格 / 滤镜 / 自定义」；搜索框；分类 chips（全部 / 收藏 / 各 preset.category）；3 列缩略图卡片；底部「N 个预设 · 收藏保存在本机」。
- 卡片点击选中 / 再点取消，选中态高亮；右上角星标收藏（本机 localStorage）。
- 「自定义」tab：自定义前缀 + 自定义描述，保存为可移除的 chip。
- 「滤镜」按钮复用同一弹窗，打开时默认切到「滤镜」tab。

**MJ 码图馆弹窗**（黄黑配色）：
- 标题「MJ 码图馆」，副标题「按效果挑选风格，在正文光标处插入」。
- 搜索框；分组 pills（全部 / 角色人物 / 场景环境 / 巨物怪兽，按 `item.group` 统计）；左侧「按风格浏览」分类折叠树（来自 `mjGroups`）；2 列缩略图卡片（图 + 名称 + 码型说明）；底部分页（36 条/页）。
- 右下角插入模式下拉：全部代码 / 风格码 / 参数 / 完整提示词 / 氛围描述（后四种来自 `/api/styles.insertModes`）。
- 点卡片 → 把文本插入提示词 textarea 的**光标位置**，并 toast 提示「已插入 MJ 码」。

**视角弹窗**：
- azimuth 0~360 / elevation -30~60 / zoom 0~10 三个滑杆，实时显示方向 / 机位 / 景别。
- 「应用」后变成 chip；「重置」回默认值；「清除视角」移除 chip。

**预览图**：目录数据里的 `preview` / `thumbnail` 已是 `/creative-presets/...`、`/mj-styles/...` 绝对路径，直接 `<img src>` 出真实缩略图；`onerror` 时隐藏图片并显示首字占位。

### 文生图页其余内容

- 大提示词 / 负向提示词、字数统计、清空；
- **模型切换**：底部参数栏「模型」pill 在 Qwen-Image 2.1 / MOSS-Image (sft) 间切换；切换只改参数、生成时才换权重（单模型常驻，运行中禁切）；小圆点表示显存驻留状态（绿=已驻留，黄=驻留的是另一个模型）；卡片显示每模型默认步数 / CFG / 采样器与缺失权重；
- 比例选择：`/api/options.ratios`，按钮显示实际 `w × h` 与「N 的倍数」提示（Qwen 32 对齐 / MOSS 16 对齐）；
- **全景比例分组**：网格末尾单独一组「全景」——`2:1 / 3:1 / 4:1 / 8:1 / 21:9`；选中后尺寸弹层出现「自动追加全景提示词」复选框（默认勾选），提交时在提示词里补 `seamless ultra-wide panoramic photograph, consistent horizon, no duplicated subjects`（已有 `panoram` 关键词时不重复追加）。文生全景没有参考图，一致性弱于图像编辑页；
- 自定义宽高（自动向上对齐到当前模型的倍数，实时提示对齐结果）；
- 步数 / CFG / 种子（随机 / 填入上次种子）/ 批量 / 采样器 / 调度器；标签后的 `tag-hint` 标出模型默认值，改动后变为「已改 · 默认 X」；
- 采样步数预设 chips（Qwen 取 `/api/options.steps_presets`；MOSS 为 50 步 / Turbo 8 步）；
- **Turbo 开关**：预设按当前模型取（`model_profiles[].turbo`）；Qwen 沿用全局 sigma 预设，MOSS 为「8 步加速 · moss-8steps @1.0」/「不加速」；开启时步数 / CFG / 采样器按预设锁定，关闭后还原；
- **SLG（仅 MOSS）**：折叠块「SLG 跳过层引导（实验）」，默认关闭；可设单层（默认 22）/ 双层 / 起止比例；
- **边界框布局（仅 MOSS）**：底部「布局」pill 或高级设置面板打开设计器；画布拖拽新建框、移动 / 八向缩放，支持 object / character / text 三类；文字框必须填写文字；布局开启时批量锁定为 1；尺寸变化时按比例缩放或清空；
- 透明背景（RGBA）开关（仅 Qwen；MOSS 下自动隐藏）；
- 高级折叠区：Qwen 显示 UNET / CLIP / VAE 下拉 + LoRA 多选（强度 0~2）；MOSS 显示只读权重文件名 + LoRA 多选；
- 抽屉顶部「当前模型」条：模型名、默认参数、权重文件、「恢复默认」按钮；
- **润色提示词**：`POST /api/polish`（带 `image_model`，MOSS 走 MOSS 提示词工程）→ 原文 / 润色后对比，展示模型、耗时、`wh_ratio`、`ratio_follow`、fallback；可一键采用（可选同时切换建议比例）或回退；
- 右侧结果区：任务进度（value/max/label）、耗时、取消、结果图、尺寸、`align.canvas`、`quality.*`、复制提示词、下载；底部实时参数摘要（首行含模型与默认/自定义标记）。

### 图像编辑页其余内容

- 编辑指令 + 负向提示词 + 润色（`mode=edit`）；
- 参考图上传：拖拽 / 点选 / 键盘 Enter，1~10 张；第 1 张标「编辑目标」，其余标「参考图 N」；支持拖动排序、单张删除、清空；第 1 张同时作为遮罩底图与输出尺寸基准；
- 尺寸模式：`follow`（跟随原图，推荐零偏移）/ `custom`（自定义，32 对齐）/ `ratio`（官方比例 + 可选百万像素）/ `fixed_point`（BlueBox 32 不动点）；
- **任务模式**：跟随预设 / 通用编辑 / 局部重绘 / 元素移除 / 扩图 / **全景**。选「全景」后展开 `studio/panoramaPanel.js`：比例 chips（`2:1 / 3:1 / 4:1 / 21:9`）、长边上限（`2048 / 3072 / 4096`）、「360° 环绕接缝（实验）」开关、目标画布实时预估与 6.0 MP 超限警告；参数写入 `edit.overrides.panorama.*`，提交时强制整画布采样（`scheme=a`、`fills=false`、`hint=gray_fill`），与扩图互斥；
- `fit`：`pad` 补边 / `crop` 裁切；补边模式 `edge`；
- 局部编辑：开关、方案 A 全画布 / 方案 B 裁切，羽化、外扩、颜色匹配开关、颜色强度、上下文倍数/像素、混合像素；
- 一致性 LoRA：开关 + LoRA 选择 + 强度；
- 采样：步数 / CFG / denoise / 种子 / 采样器 / 调度器 / Turbo；
- 右侧：**遮罩编辑器** + 编辑结果（进度、结果、`align.canvas`、`quality.outside_max_abs` 零色差标记、遮罩叠加开关）。

### 作品画廊（`#gallery`）

- 静态数据分三层：`src/data/gallery.js`（AIFISHER 原始 27 条）+ `gallery-zz.js`（OpenZhenZhen 精选 27 条）+ `gallery-more.js`（两站批量精选 178 条），合并为 232 条
- 字段：标题、分类、风格、提示词、负向提示词、种子、尺寸、采样参数、三色配色、本地封面 `image`、来源站点 / 作者 / 原帖链接
- 封面图已下载到 `web/assets/gallery/`（WebP）并通过 `/assets` 静态挂载，不依赖外站；`gallery-more.js` 由 `.cache/gen_gallery_more.py` 生成，缺失会导致全站白屏
- 分类 chips（全部 / 人像 / 海报 / 场景 / 角色 / 室内 / 产品 / 信息图 / 标志 / 贴纸）+ 搜索
- 详情弹窗：完整原图、画面说明、模型/尺寸徽标、来源署名；操作：高清预览、复制提示词、收藏到素材仓库、发送到文生图（写入提示词 / 负向 / 种子 / 宽高后跳转 `#t2i`）；详情图可直接点击进入高清预览
- 高清预览的打开动画是共享元素 FLIP：详情里的封面 rect 作为起点，图片从缩略图位置/尺寸“长”到灯箱最终尺寸（260ms，`cubic-bezier(.2,.8,.2,1)`），灯箱容器本身不再做上移缩放；未传 origin 的调用方退化为淡入 + 轻微放大
- 关闭时反向飞回起点（200ms，克隆层做位移 + 遮罩 160ms 淡出，避免遮罩淡出把图片一起淡化）；放大/平移状态下改为淡出，防止从裁切画面硬跳；`Esc` / 点遮罩 / 点 × 三条路径一致，动画结束再重新打开详情弹窗
- 多图切换（←/→、箭头、底部缩略图）：先 `Image.decode()` 预解码再替换，旧图 90ms 反向淡出、新图 150ms 定向滑入（按前后方向决定 ±20px）；连续快速切换只让最后一次生效，不残影不闪白
- 原图解码前用缩略图铺一层模糊占位（`.lb-lqip`，18px 模糊 + cover），加载完成后 200ms 淡出；加载失败保留占位并提示；没有独立缩略图时自动跳过，不发起额外请求（素材仓库与任务结果已传入 `thumb`）
- 缩放与平移：按钮 / 双击 / `+` `-` `0` `1` 快捷键走 180ms 过渡，滚轮以光标为锚点且保持跟手；拖拽实时跟随，松手后按最近速度做短惯性（逐帧 ×0.9 衰减），平移范围自动夹在图片边界内
- 卡片悬停可直接「收藏」：写入素材仓库（`source=gallery`、`sourceRef=作品 id`），已收藏的作品显示「已收藏」并禁用；页面进入时通过 `/api/materials` 回填收藏状态，并校验素材的提示词或尺寸是否与作品一致，避免历史错位的 `sourceRef` 造成「显示已收藏但仓库里没有」的误判
- 「随机灵感」按钮随机打开一条详情。

### 素材仓库（`#materials`）

- 区别于历史记录：只收录用户主动收藏的作品与本地上传，数据存 `storage/materials.json` + `storage/materials/` 图片。
- 搜索、类型 chips（全部 / 文生图 / 图生图 / 高清放大 / 精修 / 本地素材，带计数）、分类 chips（点击当前分类取消筛选）。
- 卡片与作品画廊同一套视觉（`gallery-grid / gallery-card / gallery-cover`）：封面图 + 标题/分类叠加 + 提示词摘要；悬停显示「查看 / 发送到文生图 / 删除」。
- 详情弹窗：大图、参数、参考图（图生图）、编辑信息、下载、删除、发送到文生图、在图片精修中打开；「高清预览」用原图打开通用查看器（支持 1:1 实际像素、滚轮缩放、拖拽、多图切换），详情图与参考图缩略图也可直接点开；打开动画同样以详情大图 rect 为起点的共享元素 FLIP。
- 单个删除：卡片悬停「删除」或详情弹窗内删除，二次确认后调用 `DELETE /api/materials/{id}`。
- 批量管理：「批量管理」进入选择模式，卡片左上角出现勾选圆点，点击卡片多选；选中后右下角浮动弹出「已选」侧栏（`position: fixed`，不占文档流、不挤压主区），可逐张移除 / 清空；移动端改为底部浮层。
  - 「一键发送到图生图小仓库」：通过 `refLibrary.addRefItems()` 把所选图片（`src=api.fileUrl(image.url)`）追加到图生图页会话级小图库（上限 24 张、按 src 去重），成功后跳转 `#edit`。
  - 「批量删除」：二次确认后逐个调用删除接口，统计成功/失败并刷新列表。
- 支持拖拽 / 选择批量上传，上传项 `kind=upload`、无提示词。
- 收藏入口：任务结果卡片、历史详情、作品画廊、图片精修工作台。

### 图片精修（`#studio`）

- 三栏布局：左侧工具轨（抓手 / 裁剪 / 画笔 / 橡皮 / 矩形 / 椭圆）、中央画布、右侧检查器（调整 / 蒙版 / 变换）。
- 打开方式：拖拽、选择文件、粘贴、素材仓库「在图片精修中打开」。
- 调整：曝光 / 亮度 / 对比度 / 饱和度 / 色温 / 色调；变换：左右旋转、水平 / 垂直翻转、裁剪（应用 / 清除）、全部重置。
- 蒙版：画笔大小 / 硬度 / 不透明度、反相、清空、覆盖率；显示叠加开关。
- 历史：最多 30 步撤销 / 重做，`Ctrl+Z` / `Ctrl+Shift+Z`；快捷键 `V/C/B/E/R/O`、`[` `]`、`0`、`1`、`Esc`。
- 输出：导出 PNG / JPEG、复制、收藏到素材仓库、导出蒙版、送入图像编辑（带图 + 蒙版，自动开启局部编辑）。
- 文档模型见 `src/components/studio/studioDoc.js`：原图 + 变换 + 调整 + 蒙版 + 历史快照，非破坏式，展示与导出共用渲染管线。

### 历史页

- `GET /api/history?limit=200`，缩略图网格（优先 `thumb_url`）；分类由 `src/data/historyKinds.js` 注册表生成：全部 / 文生图 / 图像编辑 / 高清放大 / 精修工程，任务卡片与详情标题按 `kind` 显示正确类型（放大不再归为文生图）；
- 「精修工程」并入分类 chip：选中时只显示工程，其余任务分类只显示对应任务，全部视图同时展示两个区块；
- 点击卡片查看大图、参数摘要、提示词、`align` / `quality` 标记、时间；
- 缩略图与详情结果图在解码完成前透明（`.is-pending`），加载后 200ms 淡入；详情结果图按原图宽高比占位（`aspect-ratio`），弹窗高度不随加载跳动；失败时回落到「无预览」；
- 下载单张 / 全部、复制提示词、导出可复现请求参数 JSON（`/api/jobs/{id}/replay.json`）；
- **编辑任务一键回退**：详情弹窗对 `kind=edit` 提供「回到图像编辑」——读取 `meta.input_urls` 还原输入图（缺失时降级用结果图）、`meta.mask_url` 还原遮罩（新任务起留档，旧记录按无遮罩处理）、`replay.params` 还原预设 / 覆盖项 / 尺寸 / 采样 / 种子 / Turbo / LoRA / 一致性，经 `handoff.restore` 交接后跳 `#edit`；
  - LoRA 取 `meta.request_loras`（预设合并前的用户原始选择），避免把后端自动挂载的任务 / 一致性 / 加速 LoRA 当成用户 LoRA 回填；文件名会按目录映射回完整 value；
  - 一致性取 `meta.request_consistency`，缺失时退回 `local.consistency`（旧记录）；
  - Turbo 新记录存 `{enabled, profile}` 对象，旧记录若只有布尔值则用 `quality.sampling.turbo` 补档；
  - 覆盖项按 `local` / `zero_shift` / `preprocess` / `outpaint` / `panorama` 分组整体替换，不会残留上一条记录的值；`local.fills` / `hint` / `enabled` / `consistency` 由页面与任务自动推导，不写回覆盖项；
  - 还原前会等待预设摘要加载完成，避免误报「预设已不存在」；同时标记 `appliedPreset`，防止随后的预设同步清空还原出来的覆盖项；
  - 旧记录参数不全时用 `quality`（preset / size_mode / sampling / loras）补齐；
- 历史落盘（`storage/history.json`）保留除图片 / 遮罩 / 姿态图 / meta 之外的完整参数，服务重启后 `replay.json` 仍可回放；`/api/history` 列表摘要保持轻量；
- 清空全部历史（`DELETE /api/history`，二次确认）。后端只提供整体清空，因此不提供单条删除。

任务进度（文生图与图像编辑共用）：提交后每 **700ms** 轮询 `GET /api/jobs/{id}`，显示 `progress.value / progress.max / progress.label`、耗时与取消；成功后渲染结果图、尺寸、`align.canvas`（并标注是否 32 倍数）、`quality.outside_max_abs`（0 = 零色差校验通过）、`quality.size_match`；局部编辑可切换遮罩叠加做人工对比。

## 2. 文件职责

```
web/
├─ index.html                 页面骨架（侧边栏/顶栏/内容区/toast/模态框挂载点）
├─ assets/css/
│  ├─ theme.css               设计令牌（亮/暗）、排版、动效、基础重置
│  ├─ shell.css               App Shell：侧边栏、顶栏、响应式
│  ├─ app.css                 面板/表单/结果/模态框、风格选择器与 MJ 码图馆弹窗
│  ├─ mask.css                遮罩编辑器（工具栏/舞台/状态栏/全屏）
│  ├─ tools.css               图像处理页
│  ├─ library.css             作品画廊 + 素材仓库
│  └─ studio.css              图片精修工作台
└─ src/
   ├─ main.js                 引导入口：DOM 就绪 → boot()，启动失败时显示中文兜底页
   ├─ app.js                  布局与路由：App Shell、健康检查 5s 轮询、options/styles 预加载、hash 路由
   ├─ api.js                  fetch 封装（超时 / 中文错误 / ApiError）+ pollJob 轮询 + 素材接口
   ├─ store.js                全局状态（health/options/styles/主题/提示词/采样参数）+ localStorage + 事件总线
   ├─ utils.js                DOM/格式化/剪贴板/文件读取/图片探测/32 对齐等工具
   ├─ handoff.js              跨页交接（图生图 / 文生图 / 图片精修）
   ├─ data/gallery.js         作品画廊数据入口（合并 gallery-zz.js / gallery-more.js）
   └─ components/
      ├─ toast.js             顶栏右侧中文提示（info/success/warn/error）
      ├─ modal.js             通用模态框（dialogClass / hideFooter / 可选 exit 异步退场）+ 确认对话框
      ├─ polish.js            提示词润色对比弹窗（文生图 / 图像编辑共用）
      ├─ jobView.js           任务进度轮询 + 结果渲染（尺寸/align/质量/遮罩叠加/收藏）
      ├─ controls.js          TurboControl / LoraPicker / ModelsField 复用控件
      ├─ stylePicker.js       ★ 提示词上方的风格选择器（风格/滤镜/自定义/MJ/视角弹窗）
      ├─ maskEditor.js        ★ 遮罩编辑器（Canvas 2D 自研）
      ├─ favorites.js         收藏到素材仓库的统一入口
      ├─ refLibrary.js        图生图页小图库（会话级，导出 addRefItems 供跨页批量追加）
      ├─ gallery.js           「作品画廊」页面
      ├─ materials.js         「素材仓库」页面
      ├─ studio.js            「图片精修」页面与交互
      ├─ studio/studioDoc.js  精修文档模型（变换 / 调色 / 蒙版 / 历史 / 烘焙）
      ├─ t2i.js               「文生图」页面
      ├─ edit.js              「图像编辑」页面
      ├─ imageTools.js        「图像处理」页面
      └─ history.js           「历史记录」页面
```

页面在首次进入时才创建 DOM（`app.js` 中 `pages` Map），之后切换只做显隐，状态不丢。旧的 `components/styles.js` 已删除。

## 3. 与 vendor 风格库（image-style-kit）的对接

**不 import `src/index.js` / `src/catalogs.js`**（后者的静态 JSON import + fetch/localStorage 在浏览器里较脆），改为按文件动态 import，全部包在 `try/catch` 里，模块级缓存供两个页面的选择器共享：

| 文件 | 用到的导出 |
| --- | --- |
| `/vendor/image-style-kit/src/prompt.js` | `buildNodePrompt`（最终提示词合成） |
| `/vendor/image-style-kit/src/creative.js` | `composeCreativePrompt`（保留备用） |
| `/vendor/image-style-kit/src/imageAngle.js` | `imageAnglePrompt` / `normalizeImageAngle` / `imageAngleDescription` |
| `/vendor/image-style-kit/src/mjStyles.js` | `mjStyleText` / `mjStylePreset` / `filterMjStyles` / `MJ_INSERT_MODES` / `mjCategoryGroups` |

合成方式（与 Python 侧 `styles.compose_prompt` 语义一致）：

```js
buildNodePrompt(rawPrompt, {
  creativePresets: { style, filter, custom },   // 预设快照
  type: 'Image',
  imageAngle: enabled ? { azimuth, elevation, zoom } : null,
});
```

目录数据一律来自 `/api/styles`，不 import `catalogs.js`。vendor 未就绪时选择器仍可打开，但合成/插入会给出中文提示。

## 4. 与 HTTP API 的对应关系

| 前端动作 | 接口 |
| --- | --- |
| 顶栏状态（5s） | `GET /api/health` |
| 启动加载参数 | `GET /api/options` |
| 风格 / MJ 目录 | `GET /api/styles` |
| 润色提示词 | `POST /api/polish` `{prompt, mode, model}` |
| 文生图提交 | `POST /api/generate`（`prompt` 为合成后的最终提示词） |
| 图像编辑提交 | `POST /api/edit`（图片为 data URL；遮罩 `{data: "data:image/png;base64,..."}`） |
| 任务轮询（700ms） | `GET /api/jobs/{id}` |
| 取消任务 | `POST /api/jobs/{id}/cancel` |
| 历史列表 | `GET /api/history?limit=200` |
| 清空历史 | `DELETE /api/history` |
| 任务参数 JSON | `GET /api/jobs/{id}/replay.json` |
| 素材列表 | `GET /api/materials?kind=&category=&q=&limit=` |
| 新建收藏 | `POST /api/materials`（支持 dataURL / `/files/...`） |
| 修改素材 | `PATCH /api/materials/{id}` |
| 删除素材 | `DELETE /api/materials/{id}` |
| 本地上传 | `POST /api/materials/upload`（multipart） |
| 结果 / 缩略图 | `GET /files/...` |
| 风格预览图 | `GET /creative-presets/...`（静态托管） |
| MJ 缩略图 | `GET /mj-styles/...`（静态托管） |
| 上传（备用） | `POST /api/upload`（当前编辑页直接用 dataURL，不依赖该接口） |

请求体与契约第 3 节一致；额外说明：

- 文生图 / 编辑请求的 `prompt` 是「正文 + 预设 + 视角」合成后的最终文本；`meta.rawPrompt` 保留用户原文，`meta.creativePresets` / `meta.imageAngle` 保留快照，便于历史追溯；
- `turbo` 只发 `{enabled, profile}`：加速 LoRA、sigma、底模由后端预设决定，前端不再允许手动改；
- 编辑 `local.scheme` 为 `a` / `b`，`local.enabled=false` 时后端按 `scheme=none` 处理；
- `size_mode=follow` 时 `width/height` 传 `null`；`ratio` 模式传 `ratio` 与可选 `megapixels`；`fixed_point` 只传 `megapixels`；
- 全景任务（`task.mode="panorama"`）额外传 `panorama: {aspect, long_side, wrap, seam_blend}`；后端按目标比例算灰边画布、强制 `scheme=a`，输出保持全景画布，`quality.panorama` 回显画布/工作尺寸/四边补边/缩放与 `wrap_report`。详见 [PLAN_PANORAMA.md](PLAN_PANORAMA.md)。

## 5. 遮罩编辑器的输出约定

- 遮罩内部始终以**第一张参考图的原分辨率**保存在离屏 canvas；导出 PNG 的宽高与第 1 张图**完全一致**。
- 导出像素：`R=G=B=A=覆盖度`（白 = 编辑区，黑/透明 = 不编辑）。后端 `imaging.decode_mask` 的规则是「alpha 有变化取 alpha，否则取亮度」，两种解释下都成立。
- 工具栏：画笔（笔径 2~400、硬度 0~100%）、橡皮、矩形、椭圆、填充、撤销/重做（命令回放，最多 40 步）、清空、反相、显示/隐藏叠加、适配窗口、全屏；滚轮缩放、空格/中键平移；快捷键 B/E/R/O/F、Ctrl+Z / Ctrl+Shift+Z、Esc 退出全屏。
- 羽化 + 外扩在编辑器内用离屏 canvas 做近似预览（外扩 = 圆周 12 方向平移叠加，羽化 = `ctx.filter: blur(px/2)`），不改变导出的原始遮罩；服务端按 `local.feather` / `local.mask_expand` 再处理。

## 6. 已知边界 / 后端配合点

1. **`engine.ready` 字段**：当前 `/api/health` 返回的是 `engine.available`，前端已做 `ready ?? available` 兼容。
2. **历史单条删除**：后端 `DELETE /api/history` 只有整体清空，所以前端只提供「清空全部」。
3. **工作流 JSON**：没有 `/api/workflow/{id}.json`，历史详情改为「任务参数 JSON」→ `/api/jobs/{id}/replay.json`。
4. **任务进度**：`progress.max` 对 Turbo = 8、普通 = steps；`max<=0` 时显示不定进度动画。
5. **错误展示**：所有 fetch 失败、HTTP 4xx/5xx、任务 `error` 状态都会转中文 toast / 结果面板；后端不可用时顶栏状态灯变红并提示「服务未连接」，不白屏。
6. 预览图静态路径（`/creative-presets`、`/mj-styles`）由后端 `server/main.py` 挂载；路径 404 时前端自动隐藏图片改用首字占位。
7. 本机沙箱禁止 Chrome 命名管道，无法做 headless 浏览器实测；前端验证以 `node --check`、模块 import 图、静态资源 200 为准，真实交互由 Lead 在浏览器验收。

## 7. 自检记录（本轮改版）

- `node --check`：`web/src/**/*.js`（15 个文件）全部通过。
- stubbed Node 环境 import 全部前端模块，具名导出完整，无 missing import。
- 静态检查：`data-ref` / `ref()` 名称对齐、HTML 模板标签配平、静态 import 路径存在。
- 纯逻辑自测：StylePicker 的 chip 计数 / composePrompt 合成 / 光标插入 / 视角描述 / 移除状态；vendor buildNodePrompt 对 style / filter / custom / angle 快照的合成结果。
- 静态资源：`GET /`、`/src/*.js`、`/assets/css/*.css`、`/creative-presets/style-643.webp`、`/mj-styles/char1-thumb.webp` 均 200。
- 目录数据：`/api/styles` 返回 creative 285（style 217 / filter 17 / motion 51）、mj 493、mjGroups 6、insertModes 4。

---

## 8. 改版记录：App Shell + 资产模块 + 图片精修（当前版本）

### 8.1 主题

- 设计令牌统一在 `theme.css`：亮色沿用暖白 / 墨绿 / 暖赭，暗色为同色相低明度映射；`html[data-theme="light|dark"]` 切换，`system` 跟随系统。
- 主题偏好持久化在 `qi21.workbench.settings.v1`，`index.html` 首屏脚本提前写入 `data-theme`，避免闪烁。
- 组件只使用令牌，不再新增硬编码颜色。

### 8.1.1 App Shell

- 左侧边栏（232px，可折叠 72px）+ 顶部工具栏 + 内容区；移动端侧边栏改为抽屉。
- 导航分「创作 / 资产 / 工具」三组，共 7 项；内容区 `.viewport` 宽度 100%（上限 1560px）。

### 8.2 新增页签「图像处理」

`src/components/imageTools.js` + `assets/css/tools.css`（三列布局：工具 300 / 画布 1fr / 结果 300）。

能力：裁剪（8 手柄 + 比例 chips + 宫格切分）、旋转翻转、缩放（contain/cover/stretch + 对齐 32）、
调色（亮度/对比/饱和/锐化/色温，CSS filter 实时预览、后端真实落盘）、格式导出（PNG / JPEG 质量）、
扩图规划、送入图生图。

**全景辅助**：「扩图」折叠区新增「全景比例」chips（`不限 / 2:1 / 3:1 / 4:1 / 21:9`）。选中比例后自动反推扩图方向与幅度（宽不够左右扩、高不够上下扩），方向与幅度控件自动禁用；「规划扩图」预览新画布与遮罩。按钮变为「带到编辑 · 全景」，交接时发送当前处理图 + `taskMode="panorama"` + `panorama:{aspect,long_side,wrap,seam_blend}`，编辑页接收后自动切到「全景」任务并回填比例/长边（不发送预览画布，避免二次外扩）。

依赖 vendor 的纯逻辑模块（不要自己重写）：

```js
import * as geometry from '/vendor/image-tools-kit/src/cropGeometry.js';  // cropRatios/hitCrop/createCrop/resizeCrop/gridRects…
import * as renderer from '/vendor/image-tools-kit/src/clientRenderer.js'; // loadImage/cropToDataUrl/gridToDataUrls
import * as promptKit from '/vendor/image-tools-kit/src/prompt.js';        // panoramaPrompt/buildOutpaintDraft/outpaintDirections
```

后端对接：`POST /api/image/process`（ops 数组：crop/grid/rotate/flip/resize/adjust/pad32/trim_alpha）、
`POST /api/image/outpaint-plan`（返回 canvas / pad / offset）。

### 8.3 显存管理 UI

顶栏显示 `显存 x / y GB` + 「释放显存」按钮（`POST /api/engine/free {unload:true}`），
旁边提示「空闲 N 分钟后自动释放显存」（N = `/api/health.config.idle_unload_minutes`，默认 10）。
服务端看护线程会在队列空闲超时后自动 unload 模型。

### 8.4 本版新增的坑（改这里前必看）

| 症状 | 根因 | 修法 |
|---|---|---|
| 图像处理页画布 1×1、显示 0% | `.tool-stage` 没给确定高度，前端用 `clientHeight-64` 反算显示尺寸，高度塌陷就退化为 1×1 | `tools.css` 里 `.tool-stage { height: clamp(380px,56vh,620px) }` + `.tool-stage-inner { flex:1; min-height:0 }` |
| 上传后「裁剪输出」显示 2×2 | `resetCrop()` 在 `currentWorkDims` 还没写入时被调用，按 1×1 算了选框 | 不要在上传流程里提前 `resetCrop()`；交给 `render()`（先写 dims 再重置） |
| 应用裁剪后再次保存得到 1×1 | 裁剪后选框没重置，旧坐标被叠加到新尺寸上再切一刀 | 裁剪后置 `state.crop.pendingReset = true`，下一次 `render()` 在新尺寸下重排选框；并给 `pendingCropPixelRect()` 加 <16px 的退化保护 |
| 风格/结果卡片高度塌成 2px | grid auto 行高 + flex 卡片 + `aspect-ratio` 缩略图被 Chromium 算成边框厚度 | `.pk-grid` / `.mj-pk-grid` / `.tool-results` 加 `grid-auto-rows: max-content` |

### 8.5 自检（本版）

- `node --check`：`web/src/**/*.js` 18 个文件全部通过。
- 浏览器实测（Chrome via CDP）：四页签渲染、上传图片画布正确绘制（512×512 · 显示 61%）、
  比例 1:1 → 应用裁剪 → 操作史 1 步 → 处理并保存（结果 414×414 落盘）→ 送入图生图（跳编辑页并带图）、
  扩图规划（704×480 + 新增区域遮罩 + 按钮启用）、风格弹窗与 MJ 弹窗均正常。
- 静态资源 200：`/`、`/src/**`、`/assets/css/{app,mask,tools}.css`、`/vendor/image-tools-kit/src/*.js`、
  `/creative-presets/*.webp`、`/mj-styles/*.webp`。

---

## 9. 交互细节（本轮 UX 优化）

| 优化 | 说明 |
|---|---|
| **操作条粘底** | 「开始生成 / 开始编辑」+ 重置 + 状态提示固定在视口底部（`position: sticky; bottom: 14px`），长表单不用滚到底找按钮；在 page 网格里 `grid-column: 1 / -1` 横跨整页 |
| **进度就在操作条里** | 顶部 3px 进度细条 + 文案（`进行中 3/11 · 扩散采样 · 5.9s`）；运行中边框变墨绿，失败变赭红，完成显示 `已完成 · 14.5s` 并保留到下次提交 |
| **Ctrl / Cmd + Enter** | 任意位置直接提交，条上有 `Ctrl+Enter` 提示；长表单最实用 |
| **按钮不再"卡住"** | 任务结束/失败必定恢复 `开始生成`（`finally` 兜底），并把失败原因写进操作条 |
| **风格库不占页** | 改成提示词框上方四个按钮 + 弹窗，选中即标签 |
| **画布 32 对齐提示** | 尺寸输入区直接显示「输出 1024 × 1024 · 32 的倍数 ✓」，避免编辑时才被取整 |

改这里要注意的两个坑：

1. **操作条必须是 page 网格的直接子元素**（否则 `grid-column` 不生效，条只占左栏宽度）；
   t2i / edit 两页的 markup 都把 `<div class="action-bar">` 放在两个 `.col` 之后。
2. **进度条依赖 `jobView.start({ onProgress })`**：`jobView` 在每次轮询与终态都会回调，
   `onProgress(null)` 用于重置。改 `jobView` 的轮询时别把回调弄丢。

---

## 10. 已修复的两个参数类 bug（别再踩）

| 症状 | 根因 | 修法 |
|---|---|---|
| **关掉 Turbo 后步数还停在 8** | `applyTurboToFields()` 只在开启时写入档位参数（8 步 / cfg 1 / euler），关闭时只把输入框解除禁用、**不还原数值**。非 Turbo 采样用 8 步会明显发糊 | 开 Turbo 时快照 `{steps,cfg,sampler}`，关闭时还原（无快照则回落到 25 步 / cfg 1 / euler）并 toast 提示；页面加载时若「Turbo 关闭且步数 < 12」自动纠正为 25 |
| **外扩滑杆显示 `NaN px`** | 绑定的字段名写错：store 里叫 `maskExpand`，代码绑的是 `expand` → `input.value = String(undefined)`，`Math.round(undefined)` 得 NaN | 绑 `maskExpand`，`maskEditor.setPreview` 与提交载荷 `mask_expand` 统一用它 |

另外提醒：Turbo 面板只保留「开关 + 预设」，加速 LoRA 由预设自动挂载且同时最多一个；
「自动切换 Turbo 底模」预设会临时切到仓库里的 Turbo 权重、不挂加速 LoRA。实际挂载结果写进 `job.meta.turbo_lora` / `job.meta.turbo_unet` 便于复现。
