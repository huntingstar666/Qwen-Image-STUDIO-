# 风格库（image-style-kit 接入）

把 `image-style-kit`（风格/滤镜/运镜预设、MJ 码图馆、视角提示词）接入本工作台：

- 前端静态资源：`web/vendor/image-style-kit/`（整包复制，浏览器直接 ESM import，**无构建步骤**）
- 服务端 Python 复刻：`server/styles.py`（`buildNodePrompt` 等价语义 + `/api/styles` 目录）
- 对外接口：`GET /api/styles`、`GET /api/styles/angle-prompt`（路由由 Lead 在 `server/main.py` 实现）

## 1. 复制结果

来源（只读）：`<LOCAL_PROJECTS>\mytools\aifisher\AIFISHER\image-style-kit`
目标：`<PROJECT_ROOT>\web\vendor\image-style-kit\`（23 个文件，约 802KB）

```text
web/vendor/image-style-kit/
├─ package.json                 # type: module，exports 指向 src/index.js
├─ README.md
├─ data/
│  ├─ creativeCatalog.json      # 285 条：风格 217 / 运镜 51 / 滤镜 17
│  └─ mjStyleCatalog.json       # 493 条 MJ 码图（char/juwu/scene 三组、34 个分类）
├─ src/                         # 纯逻辑 ES module（无第三方依赖）
│  ├─ index.js                  # 全量 re-export
│  ├─ prompt.js                 # buildNodePrompt ← 推荐前端入口
│  ├─ creative.js               # 预设校验 + 创意提示词合成
│  ├─ mjPrompt.js               # MJ 参数归并 / --preview 清理
│  ├─ mjStyles.js               # MJ 码图分组、四种插入模式、过滤
│  ├─ imageAngle.js             # 视角参数 + 相机语义提示词
│  ├─ midjourneyReferences.js   # cref/sref/dref 垫图（本工作台暂未用）
│  └─ catalogs.js               # 目录加载 + 预览图地址解析
├─ react/                       # React 面板（本项目前端不用 React，仅保留源码）
│  ├─ *.jsx / index.js
│  └─ *.css（library.css / CreativeLibrary.css / MjStyleLibrary.css / imageAngle.css）
└─ scripts/sync-assets.ps1      # 同步预览图用；本工作台**不执行**
```

**预览图（约 112MB）不在包里，也没有去下载/生成**：`data/*.json` 里的
`preview` / `thumbnail` / `poster` 指向 `/creative-presets/...`、`/mj-styles/...`，
这些静态路径本工作台不提供。前端在 `<img onerror>` 里隐藏图片即可，不要显示破图；
风格条目本身（名称、描述、提示词）完全可用。

## 2. 前端接入（原生 ES module）

**推荐入口（最稳）：**

```js
// web/src/styles.js
import { buildNodePrompt } from '/vendor/image-style-kit/src/prompt.js';

const finalPrompt = buildNodePrompt(node.prompt, node);
// node 只需普通对象：
// { type: 'Image', prompt, creativePresets, imageAngle }
```

原因：`prompt.js` 只 import `creative.js` / `mjPrompt.js` / `imageAngle.js`，不碰 JSON import、
不碰 localStorage，任何支持 ES module 的浏览器都能直接加载。

**全量入口（需要 import attributes）：**

```js
import { buildNodePrompt, normalizeMidjourneyPrompt } from '/vendor/image-style-kit/src/index.js';
```

`src/index.js` 会连带加载 `catalogs.js`，后者用
`import creativeCatalogData from '../data/creativeCatalog.json' with { type: 'json' }`
（import attributes），需要较新 Chrome/Edge（123+）。服务端 StaticFiles 需以
`application/json` 返回 `.json`；如果前端只做提示词合成，用 `prompt.js` 即可绕开这个依赖。

**样式**：`react/library.css` 等只服务于 vendor 自带的 React 面板，本项目前端是原生实现，
不必引入（想复用类名/设计语言可以引 `/vendor/image-style-kit/react/library.css`，但不要引
`react/index.js`——它依赖 React 运行时，本机没有）。

**CSS 文件全部保留**：`react/` 下 5 个 `.css` 原样在包里，随时可取色值/类名参考。

## 3. 提示词合成语义（JS ↔ Python 一一对应）

`buildNodePrompt(prompt, node)` 的处理链，`server/styles.py` 的 `compose_prompt()` 完全等价：

```text
创意前缀（style → filter → [motion] → custom）
→ 正文（用户提示词）
→ 创意后缀（同序）
→ normalizeMidjourneyPrompt（MJ 参数归并到末尾、--preview 丢弃）
→ imageAnglePrompt（视角提示词）
```

| JS（vendor） | Python（`server/styles.py`） |
| --- | --- |
| `buildNodePrompt` | `compose_prompt` |
| `composeCreativePrompt` | `compose_creative_prompt` |
| `normalizeMidjourneyPrompt` | `normalize_mj_prompt` |
| `removeMidjourneyPreview` | `remove_mj_preview` |
| `validCreativePreset` | `valid_creative_preset` |
| `creativeSelection` | `slots_of` |
| `imageAnglePrompt` / `imageAngleDescription` / `normalizeImageAngle` | `angle_prompt` / `image_angle_description` / `normalize_image_angle` |
| `mjStyleText` | `mj_style_text` |
| `mjCategoryGroups` / `MJ_INSERT_MODES` | `MJ_CATEGORY_GROUPS` / `MJ_INSERT_MODES` |
| `creativeCatalog` / `mjStyleCatalog` | `load_catalogs()` |

节点类型规则与 vendor 一致：`node_type` 是 `Image` 时只叠加 style/filter/custom，
`Video` 才额外叠加 motion，其它类型（Audio 等）忽略预设但**仍会做 MJ 参数归并**。
`node_type` 大小写不敏感；空预设/空提示词不会产生多余空行或首尾空行。

## 4. 视角提示词（中文文案逐字同 vendor）

`angle_prompt({"azimuth":90,"elevation":10,"zoom":5})`：

```text
根据参考图片重新呈现同一个主体，目标视角为主体的右侧，平视，中景构图。
精确相机参数：水平环绕 90°（0°正面、90°主体右侧、180°背面、270°主体左侧），俯仰 10°（正值抬高机位向下看、负值降低机位向上看），取景靠近程度 5.0/10（0为远景、5为中景、10为特写）。按连续数值调整，不要量化为固定预设。
只改变相机观察方向、高度和取景距离；保持主体身份、面部特征、服饰、道具、材质和画面风格一致。依据原图合理补全新视角可见的结构。不要用平面旋转、镜像或拉伸原图代替视角变化，不添加多视图拼版、文字或重复主体。以本段目标视角为准，其他内容要求保持不变。
```

规则（与 `src/imageAngle.js` 完全一致）：

- **八方向**：按 `azimuth`（0~360，自动回绕）落在 45° 扇区，以 22.5° 为界：
  `正面 / 右前侧 / 右侧 / 右后侧 / 背面 / 左后侧 / 左侧 / 左前侧`；
  例：0°→正面、45°→右前侧、90°→右侧、180°→背面、270°→左侧、337°→左前侧、338°→正面。
- **俯仰**：`elevation` 夹在 [-30, 60]；`< -15` 低机位仰视、`< 15` 平视、`< 45` 抬高机位俯视、否则高机位俯拍。
- **距离**：`zoom` 夹在 [0, 10]（保留 1 位小数）；`< 2` 远景、`< 6` 中景、否则近景。
- **未设置即关闭**：`image_angle` 为 `None`/`{}`/缺少任一数值字段（或字段是字符串、布尔、NaN）时返回空串，不追加任何内容。
- Python 用 JS 的 `Math.round` 语义（`.5` 向 +∞ 取整），`zoom` 用 `f"{zoom:.1f}"` 输出，和 JS `toFixed(1)` 一致。
- 测试 `test_angle_prompt_text_matches_vendor_js` 会把上述中文片段与
  `web/vendor/image-style-kit/src/imageAngle.js` 原文逐字比对，防两边文案漂移。

## 5. MJ 参数归并（`normalize_mj_prompt`）

规则与 `src/mjPrompt.js` 逐条一致：

1. 识别 `--flag`（前后必须是空白/行首/行尾，大小写不敏感）；
2. 所有参数块搬到提示词末尾，正文保留在参数块之前；
3. `--preview` 是本地预览专用标记，**整条丢弃**（它后面的值词按 vendor 语义保留）；
4. `--p` / `--personalize` 统一成 `--profile`；
5. `--sref` / `--profile` 支持叠加（空格分词去重合并）；其它标量参数以**最后一次**为准；
6. 输出 `正文 + "\n" + "--参数…"`；没有参数时仅 `trim()`。

```text
"x --p abc --profile def --sref 123 --sref 456 123"
→ "x\n--profile abc def --sref 123 456"

"cat --ar 16:9 --preview upscaled --v 6"
→ "cat\n--ar 16:9 --v 6"

"cat --AR 16:9 --V 6"
→ "cat\n--ar 16:9 --v 6"
```

## 6. 预设快照格式与校验

前端选中的风格/滤镜/运镜以**快照对象**存进节点的 `creativePresets`（不依赖远端 ID）：

```js
node.creativePresets = {
  style:  { id, kind: 'style',  category, name, description, prompt, prefix?, preview?, poster? },
  filter: { id, kind: 'filter', ... },
  motion: { id, kind: 'motion', ... },   // 只有 Video 节点参与合成
  custom: { id, kind: 'style',  ... },   // 自定义槽，图片节点也会叠加
}
```

- 槽位固定四个：`style / filter / motion / custom`；
- `kind` 只能是 `style / motion / filter`；列表形式传入时按 `kind` 自动落槽，
  非三种 kind 的一律落 `custom`；
- 校验规则与 `validCreativePreset` 一致：`id` 为字符串且 ≤100（**允许空字符串**）、
  `name` 非空且 ≤80、`prompt` 字符串且 ≤12000、`prefix` 可缺省或字符串 ≤12000；
- `validate_presets()` 过滤非法项并按 `id` 去重，返回可直接下发的干净列表；
- 同一槽位重复传入时后一个生效（与 JS 对象赋值语义一致）。

## 7. 服务端：`load_catalogs()` 与 HTTP 接口

```python
from server import styles
data = styles.load_catalogs()
```

返回结构（可直接 JSON 序列化，中文不转义）：

```json
{
  "creative": [ {...285 条干净预设...} ],
  "mj": [ {...493 条 MJ 码图原始条目...} ],
  "mjGroups": [ {"name": "东方古风", "categories": ["东方古风·武侠", "..."]}, ...6 组 ],
  "insertModes": [
    {"key": "style", "label": "风格码"},
    {"key": "parameters", "label": "参数"},
    {"key": "full", "label": "完整提示词"},
    {"key": "vibe", "label": "氛围描述"}
  ],
  "count": {
    "creative": 285,
    "creativeKinds": {"style": 217, "motion": 51, "filter": 17},
    "mj": 493,
    "mjGroups": 6,
    "mjCategories": 34,
    "insertModes": 4
  }
}
```

实测数量：`creative=285`、`mj=493`、`mjGroups=6`、`mjCategories=34`、`insertModes=4`；
`creativeKinds` 为 style 217 / motion 51 / filter 17。

- `mj` 条目字段：`id, group, category, name, mixed, medium, codes, parameters, prompt, vibe,
  thumbnail, preview`（`codes` 是纯风格码，`parameters` 是带 `--ar` 的完整参数，
  `prompt` 是完整英文提示词，`vibe` 是中文氛围描述；四种插入模式分别取这些字段，
  与 `mjStyleText` 一致且会清掉 `--preview`）。
- `insertModes` 是 **`[{key,label}]` 对象数组**（不是数组对），前端按此渲染。
- `mjGroups` 是 `[{name, categories}]`，分类来自 vendor 的 `mjCategoryGroups` 常量，
  与数据里的 `group`（char/juwu/scene）不是一回事，前端筛选用 `mjGroups[].categories`。
- `GET /api/styles` 直接 `return styles.load_catalogs()`；`GET /api/styles/angle-prompt?azimuth=&elevation=&zoom=`
  用 `{"prompt": styles.angle_prompt_from_query(azimuth, elevation, zoom)}` 返回。**注意** query
  参数是字符串，而 `angle_prompt()` 与 JS 一样严格要求 number（字符串会返回空串），
  所以路由里请用 `angle_prompt_from_query()` 这个宽松入口（空串/None 走默认值
  azimuth=0/elevation=0/zoom=5，三个参数全缺省返回空串表示不启用视角）。

## 8. 前端与 Python 如何保持"同一个结果"

两条路都能出最终提示词，二选一即可：

1. **前端直接合成（推荐）**：`buildNodePrompt(node.prompt, node)` 在浏览器里算完，把结果作为
   `prompt` 发给 `POST /api/generate` 或 `POST /api/edit`，同时在 `meta` 里带
   `style_ids`、`angle`、`polished`、`raw_prompt` 供历史回看；
2. **后端复核**：把 `presets`（列表或快照 dict）与 `image_angle` 交给
   `server/styles.compose_prompt(...)` 重算——顺序、空值处理、MJ 归并、视角文案都与 JS 一致，
   可以做「前端预览 vs 服务端最终」对拍。

预览图 URL 是原项目的绝对路径，本工作台没有对应静态资源：`<img>` 用 `onerror` 隐藏即可
（不要用 `createAssetResolver` 的默认 base 去请求 `/creative-presets/*`，会 404）。

## 9. 测试

```bash
$PY -m pytest tests/test_styles.py -q     # 34 passed
$PY tests/test_styles.py                  # 无 pytest 时也可直接跑（文件末尾自跑块）
```

覆盖点：八方向/俯仰/距离文案与边界、视角文案与 vendor JS 逐字比对、`normalizeImageAngle`
回绕夹取、MJ 参数归并（叠加/别名/`--preview`/大小写/幂等）、创意前缀-正文-后缀顺序（Image vs
Video vs 其它类型）、空值处理、快照 dict 与预设列表两种入参、`validate_presets` 过滤去重、
`load_catalogs` 真实数据数量与结构、自定义目录读取、非法 JSON 抛错。测试**不发网络请求**。

## 10. 边界与已知限制

- 预览图缺失是正常的（约 112MB 未随包提供），**不要**运行 `scripts/sync-assets.ps1`、不要下载。
- 不要修改 vendor 里的 JS 文案；要改视角提示词必须**同时**改
  `web/vendor/image-style-kit/src/imageAngle.js` 与 `server/styles.py`，并跑
  `test_angle_prompt_text_matches_vendor_js`。
- vendor 是某一时刻的快照，重新复制会覆盖本地改动；如需升级，重跑复制后重新跑测试。
- `react/` 下的面板需要 React 运行时，本项目前端不使用；保留仅为源码/样式参考。
