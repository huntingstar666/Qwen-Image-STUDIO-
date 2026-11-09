"""分镜提示词：LLM 生成 + 代码装配 + 模板降级。

三道保障（防止「风格跑偏 / 内容跑偏」）：

1. LLM 只负责「画面描述」这一栏，不负责最终提示词；
2. 最终提示词由 :func:`assemble_prompt` 按固定顺序拼接：风格前缀 → 实体外观 → 画面描述
   → 镜头语言 → 风格后缀 → 负面词；
3. 内容锁开启时只注入已登记实体的固定外观，LLM 引用未登记实体直接记警告。

LLM 不可用（没配模型 / 超时 / 返回不可解析）时降级为模板拼装，不阻塞全链路。
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any, Iterable

from .. import config
from . import store
from .errors import StudioError
from .schema import MOTIONS

#: 兜底负面词（避免画面里出现文字类元素）
DEFAULT_NEGATIVE = "文字, 水印, 字幕, 标志, 签名, 低清晰度, 畸形肢体, 多余人物"

SYSTEM_PROMPT = """你是电影分镜师。用户给你一段带时间轴的台词脚本，请为每个镜头写一句“画面描述”，
供文生图模型生成静帧。严格遵守：

1. 只输出 JSON，结构为 {"shots":[{"id":"s1","description":"...","usedEntities":["e1"],"note":"景别/机位/光线","motion":"push"}]}；
2. description 只写画面内容：场景、人物动作与表情、环境细节、光线氛围；不要写景别、机位、构图（这些放 note）；40~120 字；
3. 不要复述台词原文，不要把台词、字幕、文字、logo 写进画面；
4. 只能使用“已登记角色/场景”里出现的人物与地点，usedEntities 填实际用到的登记 id；一个都不用就填空数组；
5. 同一场景相邻镜头保持环境与人物外观一致，只有台词明确表示换场时才改变场景；
6. note 只写镜头语言（如“中景，平视，侧逆光”），不超过 20 字；
7. motion 从 ["none","push","pull","left","right","up","down","diag"] 里选一个镜头运动：
   push 情绪递进、靠近人物；pull 抽离、收尾或揭示环境；left/right 横向扫过环境；
   up 压迫/仰望；down 俯视/揭示；diag 有跟拍感；静止就用 none。
   相邻镜头不要连续用同一种运动，独白类内容优先 push / pull。"""


# --------------------------------------------------------------------------- 装配


def _join(parts: Iterable[str]) -> str:
    seen: list[str] = []
    for part in parts:
        text = re.sub(r"\s+", " ", str(part or "")).strip(" ，,。;；")
        if text and text not in seen:
            seen.append(text)
    return "，".join(seen)


def entity_prompt(entity: dict[str, Any]) -> str:
    name = str(entity.get("name") or "").strip()
    desc = str(entity.get("desc") or "").strip()
    kind = {"character": "角色", "location": "场景", "prop": "道具"}.get(
        str(entity.get("kind") or "character"), "元素")
    if not name and not desc:
        return ""
    if name and desc:
        return f"{kind}「{name}」：{desc}"
    return f"{kind}：{desc or name}"


def detect_entities(text: str, entities: list[dict[str, Any]]) -> list[str]:
    """按名字在台词里找已登记实体（模板降级与审计共用）。"""
    found = []
    for entity in entities:
        name = str(entity.get("name") or "").strip()
        if name and name in text:
            found.append(str(entity.get("id") or ""))
    return [item for item in found if item]


def used_entity_ids(project: dict[str, Any], shot: dict[str, Any]) -> list[str]:
    """本段实际引用的实体，按「@ 显式引用 → 模型判定 → 台词命中」排序。

    @ 的顺序就是生图参考图顺序：图1 底稿、图2..N 按这里依次对应，
    因此提示词装配和锚定提交必须共用这一份顺序。
    """
    content = (project.get("locks") or {}).get("content") or {}
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    ordered: list[str] = []
    sources = [
        shot.get("refAssets") or [],
        shot.get("usedEntities") or [],
        detect_entities(str(shot.get("text") or ""), list(entities.values())),
    ]
    for source in sources:
        for item in source:
            entity_id = str(item or "")
            if entity_id in entities and entity_id not in ordered:
                ordered.append(entity_id)
    return ordered


def strip_asset_mentions(text: str) -> str:
    """去掉 @ 符号，只留资产名；生图模型不认识 @ 语法。"""
    return re.sub(r"@(?=[^\s@])", "", str(text or ""))


def assemble_prompt(project: dict[str, Any], shot: dict[str, Any]) -> tuple[str, str]:
    """按固定顺序拼出最终提示词与负面词。"""
    style = (project.get("locks") or {}).get("style") or {}
    content = (project.get("locks") or {}).get("content") or {}
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    used = used_entity_ids(project, shot)

    style_on = bool(style.get("enabled", True))
    content_on = bool(content.get("enabled", True))
    parts = []
    if style_on:
        parts.append(str(style.get("prefix") or ""))
    if content_on:
        parts.extend(entity_prompt(entities[item]) for item in used)
    parts.append(str(shot.get("description") or ""))
    parts.append(str(shot.get("note") or ""))
    parts.append(strip_asset_mentions(str(shot.get("directive") or "")))
    if style_on:
        parts.append(str(style.get("suffix") or ""))
    prompt = _join(parts)

    negatives = [DEFAULT_NEGATIVE]
    if style_on and str(style.get("negative") or "").strip():
        negatives.insert(0, str(style.get("negative") or ""))
    if str(shot.get("negative") or "").strip():
        negatives.insert(0, str(shot.get("negative") or ""))
    return prompt, _join(negatives)


def fill_continuity(project: dict[str, Any]) -> None:
    """角色连贯：本段没点到人时，沿用上一段已用到的角色（场景不继承）。

    台词很少每句都重复称呼角色名，如果只按名字匹配，未命名的镜头会丢掉
    人物外观描述，成片就会出现「换脸」。这里按「显式 > 台词命名 > 上一段角色」
    三级回退，保证同一场戏里的人物始终带同一张设定卡。
    """
    content = (project.get("locks") or {}).get("content") or {}
    if not content.get("enabled", True):
        return
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    if not entities:
        return
    kinds = {key: str(item.get("kind") or "character") for key, item in entities.items()}
    previous: list[str] = []
    for shot in project.get("shots") or []:
        used = [str(item) for item in (shot.get("usedEntities") or []) if str(item) in entities]
        if not used:
            used = detect_entities(str(shot.get("text") or ""), list(entities.values()))
        if not used:
            used = [item for item in previous if kinds.get(item) == "character"]
        shot["usedEntities"] = used
        if used:
            previous = used


def assemble_all(project: dict[str, Any]) -> None:
    """风格锁或实体卡改动后，就地重建所有镜头的最终提示词。"""
    for shot in project.get("shots") or []:
        if not str(shot.get("description") or "").strip():
            shot["description"] = template_description(project, shot)
    fill_continuity(project)
    for shot in project.get("shots") or []:
        shot["prompt"], shot["negative"] = assemble_prompt(project, shot)


# --------------------------------------------------------------------------- 模板降级


def template_description(project: dict[str, Any], shot: dict[str, Any]) -> str:
    """没有 LLM 时，用台词 + 实体卡拼一个可用的画面描述。"""
    text = str(shot.get("text") or "").replace("\n", " ").strip()
    content = (project.get("locks") or {}).get("content") or {}
    entities = content.get("entities") or []
    names = [str(item.get("name") or "") for item in entities
             if str(item.get("name") or "") and str(item.get("name")) in text]
    if names:
        who = "、".join(names)
        base = f"电影感写实剧照，{who}正在对话，画面内容围绕：{text}"
    else:
        base = f"电影感写实剧照，对话场景，画面内容围绕：{text}"
    beat = shot.get("beat")
    if isinstance(beat, dict) and int(beat.get("index") or 1) > 1:
        base += "；同一句台词的另一个画面，换一个机位或细节"
    return base


# --------------------------------------------------------------------------- LLM


def _main_config() -> dict[str, Any]:
    try:
        from server import config as main_config  # 只读复用主项目配置解析
        return main_config.load_config()
    except Exception:  # 主项目不可导入时退回空配置（走模板）
        return {}


def _resolve_profile(cfg: dict[str, Any], profile_id: str) -> tuple[dict[str, Any], str]:
    profiles = list(cfg.get("llm_profiles") or [])
    active = str(profile_id or cfg.get("llm_active") or "")
    for profile in profiles:
        if str(profile.get("id")) == active:
            return profile, active
    if profiles:
        return profiles[0], str(profiles[0].get("id") or "")
    # 老配置：只有 ollama_url / ollama_model
    return {
        "id": "local-ollama", "kind": "ollama",
        "base_url": str(cfg.get("ollama_url") or "http://127.0.0.1:11434"),
        "model": str(cfg.get("ollama_model") or ""),
        "timeout_s": 300, "max_tokens": 4096, "json_mode": True,
    }, "local-ollama"


def llm_options() -> dict[str, Any]:
    cfg = _main_config()
    profiles = []
    for profile in cfg.get("llm_profiles") or []:
        profiles.append({
            "id": str(profile.get("id") or ""),
            "name": str(profile.get("name") or profile.get("id") or ""),
            "kind": str(profile.get("kind") or "ollama"),
            "base_url": str(profile.get("base_url") or ""),
            "model": str(profile.get("model") or ""),
        })
    profile, active = _resolve_profile(cfg, "")
    return {
        "profiles": profiles,
        "active": active,
        "defaultModel": str(profile.get("model") or config.DEFAULT_LLM_MODEL),
    }


def _build_client(profile: dict[str, Any]) -> Any:
    try:
        from server.llm_client import client_from_profile
        return client_from_profile(profile)
    except Exception as exc:  # 主项目模块不可用时明确报错给上层降级
        raise StudioError(f"提示词服务不可用：{exc}", code="llm_unavailable") from exc


def _beat_tag(shot: dict[str, Any]) -> str:
    beat = shot.get("beat")
    if isinstance(beat, dict) and int(beat.get("count") or 0) > 1:
        return f"[同句 {int(beat.get('index') or 1)}/{int(beat.get('count') or 1)}]"
    return ""


def _context_text(shots: list[dict[str, Any]], index: int, span: int = 1) -> str:
    start = max(0, index - span)
    end = min(len(shots), index + span + 1)
    lines = []
    for j in range(start, end):
        marker = "当前" if j == index else ("前一段" if j < index else "后一段")
        lines.append(f"[{marker}]{_beat_tag(shots[j])} {shots[j].get('text') or ''}")
    return "\n".join(lines)


def _user_message(project: dict[str, Any], chunk: list[dict[str, Any]],
                  offset: int) -> str:
    style = (project.get("locks") or {}).get("style") or {}
    content = (project.get("locks") or {}).get("content") or {}
    entities = content.get("entities") or []
    lines = ["【全局风格】", f"风格描述：{style.get('prefix') or '（未设置）'}",
             f"画面质感：{style.get('suffix') or '（未设置）'}"]
    if entities:
        lines.append("【已登记角色/场景（只能用这些）】")
        for entity in entities:
            lines.append(f"- {entity.get('id')} {entity_prompt(entity)}")
    lines.append("【镜头列表】")
    all_shots = project.get("shots") or []
    for local_index, shot in enumerate(chunk):
        index = offset + local_index
        lines.append(
            f"#{shot.get('id')}  {int(shot.get('startMs', 0)) / 1000:.1f}s~"
            f"{int(shot.get('endMs', 0)) / 1000:.1f}s\n{_context_text(all_shots, index)}")
    lines.append("只输出 JSON，不要解释。")
    return "\n".join(lines)


def _parse_shots(raw: str) -> list[dict[str, Any]]:
    text = str(raw or "").strip()
    # 有些模型即使开了 json 模式也会套 ```json 围栏
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    data: Any = None
    for candidate in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text else ""):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    if data is None:
        raise StudioError("提示词模型返回的内容不是 JSON", code="llm_bad_output")
    items = data.get("shots") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise StudioError("提示词模型返回缺少 shots 数组", code="llm_bad_output")
    out = []
    for item in items:
        if isinstance(item, dict):
            out.append({
                "id": str(item.get("id") or ""),
                "description": str(item.get("description") or item.get("prompt") or "").strip(),
                "usedEntities": [str(x) for x in (item.get("usedEntities") or []) if str(x)],
                "note": str(item.get("note") or "").strip(),
                "negative": str(item.get("negative") or "").strip(),
                "motion": str(item.get("motion") or "").strip().lower(),
            })
    return out


def generate(project: dict[str, Any], *, span: int = 1) -> dict[str, Any]:
    """为所有镜头生成画面描述并装配最终提示词。

    返回 ``{"source": "llm|template", "model": str, "error": str, "warnings": [...]}``。
    """
    shots = project.get("shots") or []
    if not shots:
        raise StudioError("还没有镜头段，先导入音频与字幕", code="no_shots")

    llm_cfg = project.get("llm") or {}
    cfg = _main_config()
    profile, profile_id = _resolve_profile(cfg, str(llm_cfg.get("profileId") or ""))
    model = str(llm_cfg.get("model") or profile.get("model") or config.DEFAULT_LLM_MODEL)
    warnings: list[str] = []
    source = "template"
    error = ""

    if not model:
        error = "未配置提示词模型，已按模板拼装"
    else:
        try:
            client = _build_client(profile)
            parsed: dict[str, dict[str, Any]] = {}
            chunk_size = max(1, int(config.PROMPT_BATCH))
            for offset in range(0, len(shots), chunk_size):
                chunk = shots[offset:offset + chunk_size]
                raw = client.chat(
                    model,
                    [{"role": "system", "content": SYSTEM_PROMPT},
                     {"role": "user", "content": _user_message(project, chunk, offset)}],
                    temperature=float(llm_cfg.get("temperature") or 0.7),
                    num_predict=4096,
                    format="json",
                    think=False,
                )
                items = _parse_shots(raw)
                for local_index, item in enumerate(items):
                    shot_id = str((chunk[local_index].get("id") if local_index < len(chunk) else "") or "")
                    parsed[item.get("id") or shot_id] = item
                    if shot_id and shot_id != item.get("id"):
                        parsed[shot_id] = item
            matched = 0
            for shot in shots:
                item = parsed.get(str(shot.get("id"))) or {}
                description = str(item.get("description") or "").strip()
                if not description:
                    continue
                shot["description"] = description
                shot["note"] = str(item.get("note") or "")[:40]
                shot["negative"] = str(item.get("negative") or "")[:200]
                shot["usedEntities"] = list(item.get("usedEntities") or [])
                motion = str(item.get("motion") or "").strip().lower()
                if motion in MOTIONS:
                    zoom = 1.06 if motion == "none" else (
                        1.10 if motion in ("push", "up", "down", "diag") else 1.08)
                    shot["motion"] = {"type": motion, "zoom": zoom}
                matched += 1
            if matched == 0:
                raise StudioError("提示词模型没有返回可用的画面描述", code="llm_bad_output")
            source = "llm"
            if matched < len(shots):
                warnings.append(f"{len(shots) - matched} 个镜头没有拿到模型描述，已按模板补全")
        except Exception as exc:  # 任何 LLM 故障都降级，不阻塞
            error = str(exc)
            source = "template"

    entities = {str(item.get("id")): item for item in
                (((project.get("locks") or {}).get("content") or {}).get("entities") or [])}
    by_name = {str(item.get("name") or "").strip(): str(item.get("id"))
               for item in entities.values() if str(item.get("name") or "").strip()}
    strict = bool((((project.get("locks") or {}).get("content") or {}).get("strict", True)))
    content_on = bool((((project.get("locks") or {}).get("content") or {}).get("enabled", True)))
    if content_on and not entities:
        warnings.append("内容锁已开启但没有登记角色/场景，本次未做实体校验")
    for shot in shots:
        if not str(shot.get("description") or "").strip():
            shot["description"] = template_description(project, shot)
        raw_used = [str(item) for item in (shot.get("usedEntities") or [])]
        resolved: list[str] = []
        unknown: list[str] = []
        for item in raw_used:
            if item in entities:
                resolved.append(item)
            elif item in by_name:
                resolved.append(by_name[item])
            else:
                unknown.append(item)
        shot_warnings: list[str] = []
        # 没登记任何实体时不做「未登记」告警，避免每段都刷屏
        if unknown and entities:
            shot_warnings.append("引用了未登记实体：" + "、".join(unknown[:3]))
            if strict:
                shot_warnings.append("严格模式已剔除")
        shot["usedEntities"] = resolved
        shot["warnings"] = shot_warnings

    fill_continuity(project)
    for shot in shots:
        shot["prompt"], shot["negative"] = assemble_prompt(project, shot)
        if str(shot.get("description") or "").strip():
            # 提示词已经重新产出，待复核标记自动解除
            from .segments import clear_review
            clear_review(shot, ["prompt"])

    project["prompts"] = {
        "at": _now(),
        "source": source,
        "model": model if source == "llm" else "",
        "error": error,
        "profileId": profile_id,
    }
    if source == "template" and not error:
        error = "已按模板拼装"
    return {"source": source, "model": model, "error": error, "warnings": warnings}


#: 资产设定图的取景约定：和分镜画面区分开，避免直接生成剧情镜头
ASSET_FRAMING = {
    "character": "角色设定图：单人，正面半身，中性表情，五官清晰，服装完整，纯净浅灰背景，无文字",
    "location": "场景定场图：广角，无人物，空间结构完整，材质与光线清晰，无文字",
    "prop": "道具设定图：单一物件居中，纯净浅灰背景，材质与磨损细节清晰，无文字",
}


def asset_prompt(project: dict[str, Any], entity: dict[str, Any]) -> str:
    """用文字直接生成资产设定图的提示词（不含分镜台词）。"""
    style = (project.get("locks") or {}).get("style") or {}
    style_on = bool(style.get("enabled", True))
    kind = str(entity.get("kind") or "character")
    parts = []
    if style_on:
        parts.append(str(style.get("prefix") or ""))
    parts.append(entity_prompt(entity))
    parts.append(ASSET_FRAMING.get(kind, ASSET_FRAMING["character"]))
    if style_on:
        parts.append(str(style.get("suffix") or ""))
    return _join(parts)


def asset_negative(project: dict[str, Any], entity: dict[str, Any]) -> str:
    style = (project.get("locks") or {}).get("style") or {}
    negatives = [DEFAULT_NEGATIVE]
    if str(style.get("negative") or "").strip():
        negatives.insert(0, str(style.get("negative") or ""))
    if str(entity.get("kind") or "character") == "character":
        negatives.append("多人，重复人物，变形的手指")
    return _join(negatives)


#: 资产设定图比例：人物/道具方形，场景 16:9
ASSET_SIZE = {"character": (1024, 1024), "prop": (1024, 1024), "location": (1280, 720)}


def asset_size(entity: dict[str, Any]) -> tuple[int, int]:
    return ASSET_SIZE.get(str(entity.get("kind") or "character"), (1024, 1024))


POLISH_SYSTEM = """你是电影分镜师。用户会给你一个镜头段：台词、上下文、当前画面描述和用户指令。
如果附带参考图：图1 可能是当前画面底稿，其后的图依次是角色/场景资产设定图；写描述时必须保持
参考图里的脸型、发型、服装、场景结构等固定外观，但不要照搬参考图的背景和构图。
请按用户指令的意图，把「画面描述」重写成一句适合文生图的描述（40~120 字）：
1. 只写画面内容：场景、人物动作与表情、环境细节、光线氛围；
2. 不要写景别、机位、构图；不要复述台词；不要出现文字、字幕、logo；
3. 保持角色/场景与上下文一致，用户指令优先级最高；
4. 同时给出不超过 20 字的镜头语言 note；
5. 只输出 JSON：{"description":"...","note":"..."}，不要解释。"""


def polish(project: dict[str, Any], shot: dict[str, Any], directive: str = "") -> dict[str, Any]:
    """按用户指令让 LLM 重写当前段的画面描述，并重拼最终提示词。"""
    index = next((i for i, item in enumerate(project.get("shots") or [])
                  if item.get("id") == shot.get("id")), -1)
    llm_cfg = project.get("llm") or {}
    cfg = _main_config()
    profile, profile_id = _resolve_profile(cfg, str(llm_cfg.get("profileId") or ""))
    model = str(llm_cfg.get("model") or profile.get("model") or config.DEFAULT_LLM_MODEL)
    if not model:
        raise StudioError("未配置提示词模型，无法润色画面描述", code="llm_unavailable")

    style = (project.get("locks") or {}).get("style") or {}
    content = (project.get("locks") or {}).get("content") or {}
    lines = [
        f"【台词】{shot.get('text') or '（无台词）'}",
        f"【上下文】\n{_context_text(project.get('shots') or [], index)}" if index >= 0 else "",
        f"【当前画面描述】{shot.get('description') or '（空）'}",
        f"【用户指令】{directive or '（空）'}",
        f"【全局风格】{style.get('prefix') or '（未设置）'}；{style.get('suffix') or ''}",
    ]
    entities = content.get("entities") or []
    if entities:
        lines.append("【已登记角色/场景】")
        lines.extend(f"- {entity_prompt(item)}" for item in entities[:20])
    # 参考图：图1=当前画面（有图时），其后按 used_entity_ids 顺序放资产设定图
    refs: list[dict[str, Any]] = []
    try:
        from . import images as images_mod
        refs = images_mod.shot_anchor_refs(project, shot, respect_anchor=False)
    except Exception:  # noqa: BLE001 - 读不到设定图不影响文字润色
        refs = []
    attachments: list[bytes] = []
    labels: list[str] = []
    if str(shot.get("image") or "").strip():
        try:
            attachments.append(store.read_media(project["id"], str(shot["image"])).read_bytes())
            labels.append("图1=当前画面底稿")
        except (StudioError, OSError):
            pass
    kind_label = {"character": "角色", "location": "场景", "prop": "道具"}
    for ref in refs:
        attachments.append(ref["data"])
        labels.append(f"图{len(attachments)}={kind_label.get(ref['kind'], '资产')}"
                      f"「{ref['name']}」设定图")
    if labels:
        lines.append("【参考图对应】" + "；".join(labels))

    try:
        client = _build_client(profile)
        vision = False
        if attachments:
            try:
                vision = bool(client.supports_vision(model))
            except Exception:  # noqa: BLE001 - 不支持探测就按纯文本处理
                vision = False
        if attachments and not vision:
            lines.append("【说明】当前提示词模型不支持读图，以上参考图只能按文字外观描述参考。")
        message: dict[str, Any] = {
            "role": "user",
            "content": "\n".join(item for item in lines if item),
        }
        if attachments and vision:
            message["images"] = [base64.b64encode(data).decode("ascii") for data in attachments]
        raw = client.chat(
            model,
            [{"role": "system", "content": POLISH_SYSTEM}, message],
            temperature=float(llm_cfg.get("temperature") or 0.7),
            num_predict=800,
            format="json",
            think=False,
        )
    except StudioError:
        raise
    except Exception as exc:  # noqa: BLE001 - 统一转成可读错误
        raise StudioError(f"润色失败：{exc}", code="llm_error") from exc

    text = str(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text[text.find("{"): text.rfind("}") + 1] if "{" in text else text)
    except json.JSONDecodeError as exc:
        raise StudioError("提示词模型返回的内容不是 JSON", code="llm_bad_output") from exc
    description = str((data or {}).get("description") or "").strip()
    if not description:
        raise StudioError("提示词模型没有返回可用的画面描述", code="llm_bad_output")

    shot["description"] = description[:2000]
    shot["note"] = str((data or {}).get("note") or "")[:40]
    shot["prompt"], shot["negative"] = assemble_prompt(project, shot)
    from .segments import clear_review
    clear_review(shot, ["prompt"])
    return {
        "description": shot["description"],
        "note": shot["note"],
        "prompt": shot["prompt"],
        "model": model,
        "profileId": profile_id,
        "vision": bool(attachments and vision),
        "refImages": len(attachments),
    }


def _now() -> str:
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
