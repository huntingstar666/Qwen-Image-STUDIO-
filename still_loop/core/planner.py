"""分镜规划：一次 LLM 调用产出 N 条递进编辑指令，失败时规则兜底。"""
from __future__ import annotations

import base64
import io
import json
import re
import time
import urllib.error
import urllib.request
from typing import Any

from PIL import Image

from .. import config
from .motion import style_hint
from .schema import normalize_settings, preserve_text

SYSTEM_PROMPT = """你是定格动画分镜师，同时精通 Qwen-Image-Edit 的图像编辑指令写法。
用户会给一张参考图、一个想法和帧数 N。你要把想法拆成 N 个连续的微小变化。

必须遵守：
1. 第 1 帧就要执行第一个动作节拍（必须出现可见变化），禁止输出与参考图完全一致的静止帧；之后每一帧都在上一帧基础上只改变一点点。
2. 每一帧只推进一个动作节拍，禁止跳跃、禁止倒放、禁止新增无关主体。
3. 每条 edit 都是可直接送给图像编辑模型的完整中文指令，必须包含“保持人物身份、发型、服装、背景、镜头构图不变”。
4. 变化要单调递进，最后一帧达到想法的高潮；如果 seamless=true，最后一帧要回到接近第一帧的姿态。
5. 只输出 JSON，不要 markdown，不要解释。

输出格式：
{"title":"...","subject":"...","anchors":["..."],"frames":[
  {"index":1,"beat":"...","edit":"...","expect":"一句话验收标准","min_change":0.002,"max_change":0.35}
]}"""

EAT_BEATS = [
    ("端起饭碗", "让人物双手端起饭碗，身体微微前倾，准备开吃"),
    ("第一口", "让人物拿起筷子夹起第一口米饭，送到嘴边"),
    ("入口", "让人物张大嘴，把第一口米饭送入口中"),
    ("开始咀嚼", "让人物闭上嘴咀嚼，腮帮开始鼓起"),
    ("第二口", "让人物快速扒第二口饭，动作比上一帧更急"),
    ("狼吞虎咽", "让人物双颊明显鼓起，连续大口吃饭"),
    ("碗里变少", "让碗里的米饭明显减少，人物仍在快速扒饭"),
    ("贴近碗边", "让人物把碗端到嘴边，头更低，连续扒饭"),
    ("腮帮最大", "让人物腮帮鼓到最大，眼睛发亮，吃得更猛"),
    ("快见底", "让碗里的米饭快见底，人物动作更急促"),
    ("刮碗底", "让人物刮起碗底最后几口米饭，身体前倾"),
    ("满足收尾", "让人物放下空碗，露出满足的表情，动作停下"),
]

GENERIC_BEATS = [
    ("起势", "做出准备动作，身体重心开始变化"),
    ("加速", "动作开始加快，幅度比上一帧略大"),
    ("更投入", "动作更投入，姿态明显推进"),
    ("第一次高潮", "达到第一个动作高点，情绪或力度最强"),
    ("短暂停顿", "动作略微停顿，保持当前姿态"),
    ("二次加速", "再次发力，动作幅度继续增大"),
    ("动作顶点", "达到整个动作的最高点"),
    ("余势", "动作开始回落，但仍有惯性"),
    ("回落", "姿态逐渐回到接近初始的位置"),
    ("收尾", "动作完全收住，停在最终状态"),
]


#: 主项目里 Qwen edit 的 PE 规范（data/pe_system_prompt_edit.txt）会被原样作为 system。
#: 这里只追加「批量成片」的契约，不改写它的措辞要求。
BATCH_CONTRACT = """

---
# 工作台追加约定（优先于上文的 Output Format）

本次是**定格动画接力**：你会一次拿到整段动作的帧数 N，需要按播放顺序给出 N 条编辑指令。
每次编辑固定有两张输入图：
- `<image1>`：上一帧，是要被编辑的画布；它的构图、镜头、背景、未点名内容都要保留；
- `<image2>`：原始参考图，是人物身份、发型、服装、配色与光照的唯一来源。

每条 prompt 都必须显式写到 `<image1>` 与 `<image2>` 的关系，例如「以 <image1> 为画布，保持其中人物与背景不变；参照 <image2> 的身份与配色，让……」

只输出一个 JSON 对象，不要 markdown，不要解释：

{"title":"...","subject":"...","anchors":["..."],"frames":[
  {"index":1,"beat":"4~8 字节拍","edit":"单段完整编辑指令","expect":"一句话验收标准","min_change":0.002,"max_change":0.35}
]}

硬性规则：
1. `frames` 恰好 N 条，`index` 从 1 连续到 N；
2. `edit` 是单段连续文本，不加引号、不加标题、不分点；
3. 第 1 帧就要出现第一个可见动作，禁止静止帧；
4. 每帧只推进一个动作节拍，幅度小、方向单调递进，禁止跳跃、倒放、新增无关主体；
5. 颜色、光照、色温必须沿用 `<image2>`，禁止重新调色、加滤镜、换背景；
6. seamless=true 时，末帧回到接近第 1 帧的姿态，形成循环。
"""

_PE_CACHE: dict[str, str] = {}

#: 成长/变形叙事的补充契约。默认契约要求「幅度小、构图不变」，那是给动作循环用的；
#: 讲「种子长成大树」时它会和故事本身打架，所以按想法关键词切换。
GROWTH_CONTRACT = """
# 成长/变形叙事补充（优先于上文的“幅度小”“保持构图不变”）

本片是成长或形态变化叙事，允许主体发生**结构性**改变：
1. `<image2>` 只锁材质、配色、光照与世界观，**不锁主体的姿态与体量**；
2. 每帧相对上一帧必须出现肉眼可见的新结构（更高的主干、更多枝叶、新开花果），
   并在 `expect` 里写清这一帧新增了什么；
3. 禁止回退：已经长出的叶、枝、花果不得消失或缩回之前的状态；每一帧的最高点都必须
   **高于上一帧**——就算这一帧新长了侧枝，整体高度也要同步上升，不能只横向分枝；
4. 只固定镜头、机位、背景、光照与材质；不要把“保持构图不变”理解成“主体不许长”；
5. 用**绝对尺寸**描述目标，不要用“+10%”“+20%”这种增量措辞——实测模型会把增量
   当成“几乎不动”，整段故事停在幼苗。正确写法是“主干高度达到画面的三分之一”
   “树冠直径约占画面一半”“体量是上一帧的两倍以上”；
6. 每个**生长**节拍的体量必须跨一个明显台阶（约为上一帧的 1.5~2 倍），否则连起来看不出生长；
   但收尾/归种类节拍方向相反，必须写"整棵植物消失、只剩泥土和种子"，不要给它加体量增长；
7. 主体放大时背景必须保持**纯净无纹理的米白色无缝背景纸**，不要颗粒、布纹、纸纹或噪点；
   主体缩小时同理，背景仍然干净；
8. 禁止写「保持构图完全不变」「保持画面构图不变」——构图（主体占画面的比例）每帧都必须变，
   只允许固定镜头、机位、光照与背景。
"""

GROWTH_WORDS = ("发芽", "长成", "长出", "生长", "长大", "幼苗", "大树", "开花",
                "结果", "变形", "蜕变", "孵化", "盛开", "抽枝")

GROWTH_BEATS = [
    ("破土", "让种子顶端裂开，钻出一截约画面高度十分之一的嫩芽，顶端展开两片小叶"),
    ("幼苗", "让嫩芽长成一株约画面高度五分之一的幼苗，茎直立，叶片增加到四到六片"),
    ("抽干", "让幼苗拔高到约画面高度的三分之一，茎变粗成主干，从侧面抽出两根枝条"),
    ("成树", "让主干升高到画面的一半，向上分叉出三四根枝条，枝头形成一小团树冠"),
    ("展冠", "让树冠扩大到画面宽度的三分之二，叶片成团层叠，主干明显变粗"),
    ("繁茂", "让树冠再扩大一圈、几乎占满画面上半部，枝叶密密麻麻，深浅绿色分出层次"),
    ("开花", "让树冠外缘开出一圈淡粉色黏土小花，花朵小而密"),
    ("结果", "让花朵谢去，树冠下方的枝条上挂出一颗圆润的果实"),
    ("落果", "让果实从枝头脱落、滚落到土堆旁，树冠开始变稀疏"),
    ("归种", "画面里不再有任何树干、枝条、叶片或果实，整棵植物完全消失，"
             "只剩一小堆泥土和一颗半埋在泥土里的褐色种子，构图与第 1 帧接近"),
]


#: 明确的四季叙事标记：优先级高于成长词（"返青开花"里的"开花"不该把四季片判成成长片）。
SEASON_STRONG = ("春夏秋冬", "四季", "季节", "一年四季")


def is_growth(idea: str) -> bool:
    if any(word in (idea or "") for word in SEASON_STRONG):
        return False
    return any(word in (idea or "") for word in GROWTH_WORDS)


#: 四季/气候叙事：主体不变，季节、植被与色彩整体迁移。
SEASON_WORDS = ("春夏秋冬", "四季", "季节", "春天", "夏天", "秋天", "冬天",
                "春", "夏", "秋", "冬", "雪", "落叶")

SEASON_KEEP = "山体轮廓、地平线、镜头、机位与构图"

SEASON_BEATS = [
    ("早春残雪", "山体顶部残留少量白雪，山脚露出湿润的深褐色土壤，光线清冷"),
    ("春·返青", "积雪完全消融，山坡由褐色转为浅绿，冒出零星嫩芽"),
    ("春·繁花", "山脚与山坡铺满嫩绿草甸和浅粉色野花，光照柔和"),
    ("初夏浓绿", "植被转为饱和的深绿，山体轮廓清晰，光照变强"),
    ("盛夏浓荫", "深绿铺满山体，叶片层次最深，草甸浓密"),
    ("夏末初黄", "绿色开始泛黄，草甸出现暖黄色斑块，光线偏金"),
    ("秋·层林尽染", "整座山转为金黄与橙红交织，色彩最饱和"),
    ("深秋红叶", "橙红加深为酒红，部分树叶开始稀疏飘落"),
    ("初冬落叶", "树叶大量脱落，露出褐色枝干与灰色岩壁"),
    ("冬·初雪", "山顶与山脊覆盖第一层白雪，山坡仍见褐色"),
    ("深冬大雪", "整座山被厚雪覆盖，只剩深色岩脊与少量枯枝"),
    ("冬末雪融", "雪线上升，山脚露出湿润的深色土壤，回到第 1 帧的季节氛围"),
]

SEASON_CONTRACT = """
# 四季/气候叙事补充（优先于上文的“幅度小”“构图不变”理解）

本片是同一个固定机位下的四季变化，山体不变、季节在变：
1. 镜头、机位、山体轮廓、地平线与构图**必须保持不变**，只允许季节、气候、植被与色彩变化；
2. 每帧只推进半个季节节拍：先变色，再变形态（落叶、积雪、融雪），不要跳季；
3. `expect` 必须写清季节名与这一帧新增的变化（如“深秋：树冠转为酒红，少量叶片飘落”）；
4. 颜色可以大幅变化（嫩绿→深绿→金黄→橙红→枯褐→雪白），**不要**为了贴合参考图而保持原来的配色；
5. 禁止出现人物、建筑、文字、动物等与山景无关的主体；
6. 不要改变画幅比例，不要裁切或缩放山体。
"""


def is_seasonal(idea: str) -> bool:
    return any(word in (idea or "") for word in SEASON_WORDS)


#: LLM 顺手写下的"别动构图"措辞会把成长锁死，落稿前统一改写。
_GROWTH_LOCK_PHRASES = (
    "保持其构图与背景不变",
    "保持画面构图与背景不变",
    "保持构图与背景完全不变",
    "保持画面构图完全不变",
    "保持构图与背景不变",
    "保持构图完全不变",
    "保持画面构图不变",
    "保持其构图不变",
    "保持构图不变",
)


def growth_guard(edit: str) -> str:
    """把"保持构图不变"这类锁死生长的措辞改掉，只留镜头/机位/光照/背景。"""
    text = str(edit or "")
    for bad in _GROWTH_LOCK_PHRASES:
        text = text.replace(bad, "保持镜头、机位、光照与纯净背景不变")
    return text


#: "整体体量较上一帧至少增长 1.5 倍"这类收尾帧不该出现的措辞。
_SCALE_RE = re.compile(
    r"[，；。]?\s*(整体)?(体量|体积)[^，；。]{0,16}(增长|扩大|增加)[^，；。]{0,12}[。，；]?")


def demote_growth(edit: str) -> str:
    """收尾/回归帧要去掉"体量继续增长"，否则模型不肯把树收回去。"""
    return _SCALE_RE.sub("，", str(edit or "")).replace("，，", "，")


def growth_thresholds(settings: dict[str, Any]) -> dict[str, Any]:
    """成长叙事每帧的体量变化本来就很大，全局像素门槛要按叙事放宽。

    种子的画面占比很小，长成大树时整幅画都会被重画：实测单帧 changed_ratio 可达
    0.74、SSIM 0.12，用动作类阈值会全部判成 too_large / structure_broken。
    这里只保留“不是纯噪声/纯色”的下限，尺寸、alpha、主项目 quality 仍然照常判定。
    """
    relaxed = dict(settings)
    check = dict(settings.get("check") or {})
    check["max_change"] = max(float(check.get("max_change", 0.35)), 0.92)
    check["min_ssim"] = min(float(check.get("min_ssim", 0.40)), 0.06)
    check["min_hist"] = min(float(check.get("min_hist", 0.35)), 0.06)
    check["max_mae"] = max(float(check.get("max_mae", 55.0)), 90.0)
    relaxed["check"] = check
    return relaxed


def transform_thresholds(settings: dict[str, Any]) -> dict[str, Any]:
    """四季/气候叙事：构图不变，但整幅色彩会大幅迁移（绿→黄→红→白）。

    动作类的 min_ssim / min_hist 会把正常换季判成 structure_broken / color_jump，
    这里只放宽色彩与相似度，尺寸、alpha、主项目 quality 仍照常判定。
    """
    relaxed = dict(settings)
    check = dict(settings.get("check") or {})
    check["max_change"] = max(float(check.get("max_change", 0.35)), 0.99)
    check["min_ssim"] = min(float(check.get("min_ssim", 0.40)), 0.05)
    check["min_hist"] = min(float(check.get("min_hist", 0.35)), 0.18)
    check["max_mae"] = max(float(check.get("max_mae", 55.0)), 85.0)
    relaxed["check"] = check
    return relaxed


def pe_system_prompt(model: str | None = None) -> tuple[str, str]:
    """返回 (PE 原文, 来源文件名)；找不到时退回内置 SYSTEM_PROMPT。"""
    name = (model or config.EDIT_MODEL).strip() or config.EDIT_MODEL
    if name in _PE_CACHE:
        return _PE_CACHE[name], _PE_CACHE.get(name + ":file", "")
    candidates = [config.PE_DIR / "pe_system_prompt_edit.txt"]
    if name != "qwen":
        candidates.insert(0, config.PE_DIR / f"pe_system_prompt_{name}_edit.txt")
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            _PE_CACHE[name] = text
            _PE_CACHE[name + ":file"] = path.name
            return text, path.name
    _PE_CACHE[name] = SYSTEM_PROMPT
    _PE_CACHE[name + ":file"] = ""
    return SYSTEM_PROMPT, ""


def _post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _image_b64(image: Image.Image | None, max_side: int = 448) -> str | None:
    if image is None:
        return None
    prepared = image.convert("RGB")
    prepared.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    prepared.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _supports_vision(base_url: str, model: str) -> bool:
    try:
        info = _post_json(f"{base_url.rstrip('/')}/api/show", {"model": model}, timeout=5.0)
    except Exception:  # noqa: BLE001 - 探测失败按不支持处理
        return False
    caps = info.get("capabilities")
    if isinstance(caps, list):
        return "vision" in caps
    families = str((info.get("details") or {}).get("families") or "")
    return "vl" in families or "vision" in families


def _strip_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json(text: str) -> dict[str, Any] | None:
    text = _strip_fence(text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def _beats_for(idea: str, count: int) -> list[tuple[str, str]]:
    if any(word in idea for word in ("吃", "饭", "食", "嚼")):
        source = EAT_BEATS
    elif is_growth(idea):
        source = GROWTH_BEATS
    elif is_seasonal(idea):
        source = SEASON_BEATS
    else:
        source = GENERIC_BEATS
    if count == 1:
        return [source[0]]
    picked: list[tuple[str, str]] = []
    for index in range(count):
        position = round(index * (len(source) - 1) / (count - 1))
        picked.append(source[position])
    return picked


def _change_band(index: int, count: int, seamless: bool) -> tuple[float, float]:
    if index == 0:
        return 0.002, 0.30
    if seamless and index == count - 1:
        return 0.002, 0.25
    return 0.003, 0.35


def fallback_plan(idea: str, settings: dict[str, Any], *, reason: str = "") -> dict[str, Any]:
    count = int(settings["frames"])
    growth = is_growth(idea)
    seasonal = is_seasonal(idea) and not growth
    keep = SEASON_KEEP if seasonal else preserve_text(settings)
    style = style_hint(settings.get("style"))
    beats = _beats_for(idea, count)
    frames: list[dict[str, Any]] = []
    for index, (beat, action) in enumerate(beats):
        prefix = "从参考图的初始姿态开始，" if index == 0 else ""
        tail = ""
        if settings.get("seamless") and index == count - 1:
            tail = "最后回到接近第一帧的姿态，形成无缝循环。"
        if growth:
            edit = (f"以 <image1> 为画布，参照 <image2> 的材质与配色；"
                    f"只保持镜头、机位、光照与纯净无纹理的米白色背景不变；"
                    f"{style}{prefix}{action}。{tail}")
        elif seasonal:
            edit = (f"以 <image1> 为画布，参照 <image2> 的画风；保持{SEASON_KEEP}完全不变；"
                    f"{style}{prefix}{action}。{tail}")
        else:
            edit = (f"以 <image1> 为画布，参照 <image2> 的身份与配色；保持{keep}完全不变；"
                    f"{style}{prefix}{action}。{tail}")
        low, high = _change_band(index, count, bool(settings.get("seamless")))
        if growth:
            low, high = 0.02, 0.55
        elif seasonal:
            low, high = 0.02, 0.55
        frames.append({
            "index": index + 1,
            "beat": beat,
            "edit": edit,
            "expect": action,
            "min_change": low,
            "max_change": high,
        })
    return {
        "title": idea[:24] or "未命名动作",
        "subject": "",
        "anchors": list(settings.get("preserve") or []),
        "frames": frames,
        "source": "fallback",
        "notes": reason,
    }


def _normalize_plan(raw: dict[str, Any], idea: str, settings: dict[str, Any],
                    *, source: str, model: str = "", error: str = "") -> dict[str, Any]:
    count = int(settings["frames"])
    growth = is_growth(idea)
    seasonal = is_seasonal(idea) and not growth
    keep = SEASON_KEEP if seasonal else preserve_text(settings)
    fallback = fallback_plan(idea, settings, reason=error)
    raw_frames = raw.get("frames") if isinstance(raw.get("frames"), list) else []
    frames: list[dict[str, Any]] = []
    for index in range(count):
        item = raw_frames[index] if index < len(raw_frames) and isinstance(raw_frames[index], dict) else {}
        base = fallback["frames"][index]
        edit = str(item.get("edit") or item.get("prompt") or "").strip()
        if not edit:
            edit = base["edit"]
        if is_growth(idea):
            edit = growth_guard(edit)
            if "消失" in edit or "只剩" in edit:
                edit = demote_growth(edit)
        if not any(word in edit for word in ("保持", "不变")):
            if is_growth(idea):
                edit = f"只保持镜头、机位、光照与纯净背景不变；{edit}"
            else:
                edit = f"保持{keep}完全不变；{edit}"
        beat = str(item.get("beat") or base["beat"]).strip() or base["beat"]
        expect = str(item.get("expect") or base["expect"]).strip()
        low, high = _change_band(index, count, bool(settings.get("seamless")))
        try:
            min_change = float(item.get("min_change", low))
        except (TypeError, ValueError):
            min_change = low
        try:
            max_change = float(item.get("max_change", high))
        except (TypeError, ValueError):
            max_change = high
        min_change = max(0.0, min(1.0, min_change))
        max_change = max(0.001, min(1.0, max_change))
        if min_change >= max_change:
            min_change, max_change = low, high
        frames.append({
            "index": index + 1,
            "beat": beat,
            "edit": edit,
            "expect": expect,
            "min_change": min_change,
            "max_change": max_change,
        })
    anchors = raw.get("anchors")
    if not isinstance(anchors, list):
        anchors = list(settings.get("preserve") or [])
    return {
        "title": str(raw.get("title") or fallback["title"]).strip(),
        "subject": str(raw.get("subject") or "").strip(),
        "anchors": [str(item) for item in anchors][:12],
        "frames": frames,
        "source": source,
        "model": model,
        "error": error,
    }


def plan_with_llm(idea: str, settings: dict[str, Any], reference: Image.Image | None = None,
                  *, model: str | None = None, base_url: str | None = None,
                  timeout: float = 180.0) -> dict[str, Any]:
    """调用 Ollama 产出分镜；失败抛异常，由 plan() 转兜底。"""
    model = model or config.LLM_MODEL
    base_url = (base_url or config.OLLAMA_BASE).rstrip("/")
    count = int(settings["frames"])
    growth = is_growth(idea)
    seasonal = is_seasonal(idea) and not growth
    keep = SEASON_KEEP if seasonal else preserve_text(settings)
    pe_text, pe_file = pe_system_prompt(settings.get("model"))
    vision = reference is not None and _supports_vision(base_url, model)
    user_lines = [
        f"想法：{idea}",
        f"帧数：{count}",
        f"目标尺寸：{settings['width']}×{settings['height']}",
        f"必须保持：{keep}",
        f"seamless：{'true' if settings.get('seamless') else 'false'}",
        "每次编辑的输入固定为两张图：<image1> 是上一帧（画布），<image2> 是原始参考图（身份/配色来源）。",
        "参考图内容以随消息附上的图片为准；没有附图时不要臆造画面细节。",
        "第 1 帧必须已经出现第一个可见动作，不要用静止帧占位。",
        f"必须输出恰好 {count} 帧，index 从 1 到 {count} 连续。",
    ]
    style = style_hint(settings.get("style"))
    if style:
        user_lines.append(f"画面材质固定为：{style}每条编辑指令都要维持这个材质，"
                          "不要退化成平滑的数字绘画。")
    if growth:
        ladder = "；".join(
            f"{index + 1}.{beat}：{action}"
            for index, (beat, action) in enumerate(_beats_for(idea, count))
        )
        user_lines.extend([
            "本次是成长/变形叙事：主体必须逐帧长大，允许出现新的结构（更高、更粗、更多枝叶、开花结果）。",
            "`<image2>` 只提供材质、配色与光照，不要用它锁住主体的体量和姿态。",
            "每一帧都要写清这一帧比上一帧新增了什么，禁止先长出来又消失。",
            "用绝对尺寸写目标（“主干达到画面高度的一半”“树冠直径约画面三分之二”），"
            "禁止用“+10%”“+20%”这类增量措辞——实测那样模型几乎不动。",
            "每个节拍的体量至少是上一帧的 1.5 倍，跨出台阶才看得出生长；"
            "但最后收尾/归种的节拍例外，要写整棵植物消失，不要加体量增长。",
            "背景固定为纯净无纹理的米白色无缝背景纸，不要颗粒、布纹、纸纹或噪点。",
            "禁止写“保持构图完全不变”，构图（主体占比）必须每帧都变；只固定镜头、机位、光照和背景。",
            f"体量阶梯按这个顺序推进，可润色措辞但台阶不能缩水：{ladder}",
        ])
    elif seasonal:
        ladder = "；".join(
            f"{index + 1}.{beat}：{action}"
            for index, (beat, action) in enumerate(_beats_for(idea, count))
        )
        user_lines.extend([
            "本次是同一机位下的四季/气候叙事：山体与构图不动，季节、植被与色彩整体迁移。",
            "禁止改变山体轮廓、地平线、镜头与构图；只允许换季带来的颜色、植被、积雪和云雾变化。",
            "`<image2>` 只提供画风、材质与光照，不要用它锁住当前季节的配色。",
            "允许大幅换色（嫩绿→深绿→金黄→橙红→枯褐→雪白），不要为了贴合参考图而保持原配色。",
            "每一帧写清季节名和这一帧新增的变化（落叶、积雪、融雪等），禁止跳季或回退。",
            "禁止出现人物、建筑、文字、动物等无关主体，也不要改变画幅比例。",
            f"季节节拍按这个顺序推进，可润色措辞但不能跳季：{ladder}",
        ])
    message: dict[str, Any] = {"role": "user", "content": "\n".join(user_lines)}
    image_b64 = _image_b64(reference) if vision else None
    if image_b64:
        message["images"] = [image_b64]
    payload = {
        "model": model,
        "messages": [
            {"role": "system",
             "content": pe_text + BATCH_CONTRACT
             + (GROWTH_CONTRACT if growth else (SEASON_CONTRACT if seasonal else ""))},
            message,
        ],
        "stream": False,
        "format": "json",
        "think": False,
        "options": {
            # 与主项目 /api/polish 的 edit 采样保持一致，保证 PE 规范按原设计生效
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "presence_penalty": 0.0,
            "num_predict": 4096,
        },
    }
    response = _post_json(f"{base_url}/api/chat", payload, timeout=timeout)
    content = str(((response.get("message") or {}).get("content")) or "").strip()
    if not content:
        raise ValueError("LLM 返回空内容")
    data = _parse_json(content)
    if not isinstance(data, dict):
        raise ValueError("LLM 输出不是合法 JSON")
    raw_frames = data.get("frames") or data.get("prompts") or data.get("edits")
    if not isinstance(raw_frames, list) or len(raw_frames) < count:
        raise ValueError(f"LLM 只给出 {len(raw_frames) if isinstance(raw_frames, list) else 0} 条指令，少于 {count} 帧")
    if not data.get("frames"):
        data["frames"] = [
            item if isinstance(item, dict) else {"edit": str(item)} for item in raw_frames
        ]
    plan = _normalize_plan(data, idea, settings, source="llm", model=model)
    plan["vision"] = bool(vision)
    plan["raw_chars"] = len(content)
    plan["pe"] = {"model": settings.get("model") or config.EDIT_MODEL,
                  "file": pe_file, "chars": len(pe_text)}
    return plan


def plan(idea: str, settings: dict[str, Any] | None = None, reference: Image.Image | None = None,
         *, llm: str = "auto", model: str | None = None,
         base_url: str | None = None, timeout: float = 180.0) -> dict[str, Any]:
    """llm: auto | on | off。auto 失败自动兜底，on 失败也兜底但记录原因。"""
    settings = normalize_settings(settings)
    if llm == "off":
        return fallback_plan(idea, settings)
    started = time.time()
    last_error = ""
    # 一次调用要出满 N 条，模型偶尔会少给或给坏 JSON；重试一次再兜底。
    for attempt in (1, 2):
        try:
            result = plan_with_llm(idea, settings, reference, model=model,
                                   base_url=base_url, timeout=timeout)
            result["elapsed_ms"] = int((time.time() - started) * 1000)
            result["attempts"] = attempt
            return result
        except Exception as exc:  # noqa: BLE001 - 分镜失败必须兜底
            last_error = f"{type(exc).__name__}: {exc}"
    result = fallback_plan(idea, settings, reason=last_error)
    result["elapsed_ms"] = int((time.time() - started) * 1000)
    result["model"] = model or config.LLM_MODEL
    result["attempts"] = 2
    result["pe"] = {"model": settings.get("model") or config.EDIT_MODEL,
                    "file": pe_system_prompt(settings.get("model"))[1], "chars": 0}
    return result
