"""分镜提示词：LLM 生成 + 代码装配 + 模板降级。

三道保障（防止「风格跑偏 / 内容跑偏」）：

1. LLM 只负责「画面描述」这一栏，不负责最终提示词；
2. 最终提示词由 :func:`assemble_prompt` 按固定顺序拼接：风格前缀 → 实体外观 → 画面描述
   → 镜头语言 → 风格后缀 → 负面词；
3. 内容锁开启时只注入已登记实体的固定外观，LLM 引用未登记实体直接记警告。

LLM 不可用（没配模型 / 超时 / 返回不可解析）时降级为模板拼装，不阻塞全链路。
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

from .. import config
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


def assemble_prompt(project: dict[str, Any], shot: dict[str, Any]) -> tuple[str, str]:
    """按固定顺序拼出最终提示词与负面词。"""
    style = (project.get("locks") or {}).get("style") or {}
    content = (project.get("locks") or {}).get("content") or {}
    entities = {str(item.get("id")): item for item in (content.get("entities") or [])}
    used = [str(item) for item in (shot.get("usedEntities") or []) if str(item) in entities]
    if not used:
        used = detect_entities(str(shot.get("text") or ""), list(entities.values()))

    style_on = bool(style.get("enabled", True))
    content_on = bool(content.get("enabled", True))
    parts = []
    if style_on:
        parts.append(str(style.get("prefix") or ""))
    if content_on:
        parts.extend(entity_prompt(entities[item]) for item in used)
    parts.append(str(shot.get("description") or ""))
    parts.append(str(shot.get("note") or ""))
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


def _now() -> str:
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
