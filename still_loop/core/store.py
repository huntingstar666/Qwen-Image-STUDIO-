from __future__ import annotations

import html
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image

from .. import config


def now_text() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def new_run_id() -> str:
    return f"loop-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


def run_dir(run_id: str) -> Path:
    return config.RUNS_DIR / run_id


def frame_dir(run_id: str) -> Path:
    return run_dir(run_id) / "frames"


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def save_run(run: dict[str, Any]) -> dict[str, Any]:
    run["updatedAt"] = now_text()
    path = run_dir(run["id"]) / "run.json"
    # 轮询与生成线程会同时读写同一个文件，Windows 上 os.replace 偶发 PermissionError
    for attempt in range(6):
        try:
            _atomic_json(path, run)
            return run
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))
    return run


def load_run(run_id: str) -> dict[str, Any]:
    path = run_dir(run_id) / "run.json"
    if not path.is_file():
        raise FileNotFoundError(run_id)
    for attempt in range(6):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (PermissionError, json.JSONDecodeError):
            if attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))
    raise FileNotFoundError(run_id)


def save_images(run: dict[str, Any], images: list[Image.Image], stem: str) -> list[str]:
    """按顺序保存图片，返回相对 run 目录的路径（frames/xxx.png）。"""
    target = frame_dir(run["id"])
    target.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for index, image in enumerate(images, start=1):
        name = f"{stem}{index:02d}.png" if len(images) > 1 else f"{stem}.png"
        path = target / name
        image.save(path, format="PNG")
        paths.append(f"frames/{name}")
    return paths


def save_frame_bytes(run: dict[str, Any], data: bytes, name: str) -> str:
    target = frame_dir(run["id"])
    target.mkdir(parents=True, exist_ok=True)
    path = target / name
    path.write_bytes(data)
    return f"frames/{name}"


def _metric_row(label: str, value: Any) -> str:
    return f"<tr><th>{html.escape(label)}</th><td>{html.escape(str(value))}</td></tr>"


def _attempt_table(attempt: dict[str, Any]) -> str:
    metrics = attempt.get("metrics") or {}
    rows = [
        _metric_row("结果", attempt.get("verdict")),
        _metric_row("改动比例", metrics.get("changed_ratio")),
        _metric_row("MAE", metrics.get("mae")),
        _metric_row("SSIM", metrics.get("ssim")),
        _metric_row("直方图相关", metrics.get("hist_corr")),
        _metric_row("bbox IoU", metrics.get("bbox_iou")),
        _metric_row("首尾 SSIM", metrics.get("first_last_ssim")),
        _metric_row("耗时(ms)", attempt.get("elapsedMs")),
        _metric_row("job_id", attempt.get("jobId")),
    ]
    reasons = attempt.get("reasons") or []
    if reasons:
        rows.append(_metric_row("失败原因", ", ".join(reasons)))
    return "<table class='metrics'>" + "".join(rows) + "</table>"


def _frame_card(frame: dict[str, Any]) -> str:
    status = html.escape(str(frame.get("status") or "pending"))
    image = frame.get("acceptedFile") or frame.get("currentFile") or ""
    preview = f"<img src='{html.escape(image)}' alt='frame {frame.get('index')}'>" if image else "<div class='empty'>待生成</div>"
    attempts = frame.get("attempts") or []
    attempt_html = "".join(
        f"<details {'open' if attempt.get('verdict') != 'pass' else ''}>"
        f"<summary>第 {attempt.get('n')} 次 · {html.escape(str(attempt.get('verdict')))}</summary>"
        f"<p class='prompt'>{html.escape(str(attempt.get('prompt') or ''))}</p>"
        f"{_attempt_table(attempt)}</details>"
        for attempt in attempts
    )
    return (
        f"<article class='card {status}'>"
        f"<div class='thumb'>{preview}</div>"
        f"<div class='meta'><h3>#{frame.get('index')} {html.escape(str(frame.get('beat') or ''))}</h3>"
        f"<span class='badge'>{status}</span>"
        f"<p class='prompt'>{html.escape(str(frame.get('prompt') or ''))}</p>"
        f"<p class='expect'>{html.escape(str(frame.get('expect') or ''))}</p>"
        f"{attempt_html}</div></article>"
    )


def write_report(run: dict[str, Any]) -> Path:
    frames = run.get("frames") or []
    cards = "".join(_frame_card(frame) for frame in frames)
    source = (run.get("plan") or {}).get("source") or "-"
    gif = run.get("animation", {}).get("gif")
    gif_block = f"<img class='gif' src='{html.escape(gif)}' alt='gif'>" if gif else ""
    log_rows = "".join(
        f"<li><time>{html.escape(str(item.get('t') or ''))}</time> "
        f"{html.escape(str(item.get('message') or ''))}</li>"
        for item in (run.get("log") or [])[-80:]
    )
    summary = (
        f"<p><b>想法：</b>{html.escape(str(run.get('idea') or ''))}</p>"
        f"<p><b>状态：</b>{html.escape(str(run.get('status') or ''))}　"
        f"<b>分镜来源：</b>{html.escape(str(source))}　"
        f"<b>帧数：</b>{len(frames)}　"
        f"<b>尺寸：</b>{run.get('reference', {}).get('width')}×{run.get('reference', {}).get('height')}</p>"
    )
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>still_loop · {html.escape(str(run.get('idea') or ''))}</title>
<style>
:root{{color-scheme:light;--ink:#1f2328;--muted:#667085;--line:#e6e8eb;--bg:#f6f7f9;--ok:#12805c;--bad:#b42318;--run:#b54708}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif}}
main{{max-width:1200px;margin:0 auto;padding:28px}}
h1{{font-size:24px;margin:0 0 4px}}h2{{font-size:17px;margin:26px 0 12px}}
.summary{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px}}
.gif{{max-width:512px;width:100%;border-radius:14px;border:1px solid var(--line);background:#fff}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
.card{{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}}
.card.blocked{{border-color:#f0b4ae}} .card.accepted{{border-color:#a6d8c5}}
.thumb img{{width:100%;display:block;aspect-ratio:1/1;object-fit:contain;background:#fafafa}}
.empty{{aspect-ratio:1/1;display:grid;place-items:center;color:var(--muted);background:#fafafa}}
.meta{{padding:12px 14px}}.meta h3{{margin:0 0 6px;font-size:15px}}
.badge{{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:#eef2f6;color:#475467}}
.accepted .badge{{background:#e7f6ef;color:var(--ok)}} .blocked .badge{{background:#fdeceb;color:var(--bad)}}
.prompt{{color:#344054;white-space:pre-wrap;margin:8px 0}}.expect{{color:var(--muted);font-size:13px;margin:0 0 8px}}
details{{border-top:1px dashed var(--line);padding-top:6px;margin-top:6px}}summary{{cursor:pointer;font-size:13px}}
.metrics{{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}}
.metrics th,.metrics td{{border-bottom:1px solid var(--line);padding:3px 4px;text-align:left;vertical-align:top}}
.metrics th{{color:var(--muted);font-weight:500;width:42%}}
.log{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 16px;max-height:300px;overflow:auto}}
.log ul{{margin:0;padding-left:18px}}.log time{{color:var(--muted);margin-right:6px;font-variant-numeric:tabular-nums}}
</style></head><body><main>
<h1>still_loop · 定格接力报告</h1>
<div class="summary">{summary}<p><b>标题：</b>{html.escape(str((run.get('plan') or {}).get('title') or ''))}</p>
{('<p><b>GIF：</b><a href="' + html.escape(gif) + '">' + html.escape(gif) + '</a></p>') if gif else ''}
</div>
<h2>动画预览</h2>{gif_block or '<p class="expect">尚未导出 GIF</p>'}
<h2>帧与提示词</h2><div class="grid">{cards}</div>
<h2>运行日志</h2><div class="log"><ul>{log_rows}</ul></div>
</main></body></html>"""
    path = run_dir(run["id"]) / "report.html"
    path.write_text(page, encoding="utf-8")
    return path


def write_replay(run: dict[str, Any]) -> Path:
    """把每一帧的最终参数导成一份可复现清单。

    格式刻意贴着主项目 `/api/edit` 的入参，合并进主项目后可以直接喂给
    「再跑一次」或任务详情页，不用再翻译一层。
    """
    frames = []
    for frame in run.get("frames") or []:
        attempt = (frame.get("attempts") or [{}])[-1]
        frames.append({
            "index": frame.get("index"),
            "prompt": frame.get("acceptedPrompt") or frame.get("prompt") or "",
            "beat": frame.get("beat") or "",
            "status": frame.get("status"),
            "image": frame.get("acceptedFile") or frame.get("currentFile") or "",
            "job_id": attempt.get("jobId") or "",
            "metrics": attempt.get("metrics") or {},
            "quality": attempt.get("quality") or {},
            "align": attempt.get("align") or {},
        })
    settings = run.get("settings") or {}
    payload = {
        "runId": run.get("id"),
        "idea": run.get("idea") or "",
        "engine": settings.get("engine") or "mock",
        "model": settings.get("model") or "qwen",
        "preset": settings.get("preset") or "",
        "size": settings.get("size"),
        "frames": settings.get("frames"),
        "seamless": bool(settings.get("seamless")),
        "check": settings.get("check") or {},
        "quality": settings.get("quality") or {},
        "export": settings.get("export") or {},
        "plan": {
            "source": (run.get("plan") or {}).get("source"),
            "pe": (run.get("plan") or {}).get("pe") or {},
        },
        "frames_detail": frames,
    }
    path = run_dir(run["id"]) / "replay.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def safe_stem(text: str, fallback: str = "frame") -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "-", text).strip("-")
    return (cleaned or fallback)[:40]
