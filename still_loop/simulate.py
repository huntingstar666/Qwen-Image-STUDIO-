"""M0 模拟：真实 LLM 分镜 + Mock 出图 + 自检/重试 + HTML 报告 + GIF。

用法（仓库根目录）：
    python -m still_loop.simulate --reference 参考图.png --crop 256,256,512,512 \
        --idea "让图片中的小人疯狂吃米饭" --frames 12 --size 512
        --llm auto
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from . import config
from .core import runner, store
from .core.generator import MockGenerator


def _parse_crop(text: str | None) -> tuple[int, int, int, int] | None:
    if not text:
        return None
    parts = [int(float(item.strip())) for item in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("--crop 需要 x,y,w,h")
    return parts[0], parts[1], parts[2], parts[3]


def _parse_frames(text: str | None) -> tuple[int, ...]:
    if not text:
        return ()
    return tuple(int(item.strip()) for item in text.split(",") if item.strip())


def _progress(info: dict) -> None:
    stage = info.get("stage")
    if stage == "attempt_start":
        print(f"  -> 第 {info['frame']} 帧 · 第 {info['attempt']} 次尝试", flush=True)
    elif stage == "attempt_result":
        metrics = info.get("metrics") or {}
        print(
            f"     {info['verdict']}: 改动 {metrics.get('changed_ratio')} "
            f"SSIM {metrics.get('ssim')} MAE {metrics.get('mae')} "
            f"hist {metrics.get('hist_corr')}",
            flush=True,
        )
    elif stage == "frame_accepted":
        print(f"     通过（累计 {info['done']}/{info['total']}）", flush=True)
    elif stage == "frame_blocked":
        print(f"     未通过，已暂停", flush=True)
    elif stage == "run_review":
        print(f"  全部 {info['total']} 帧通过", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="still_loop 模拟运行")
    parser.add_argument("--reference", required=True, help="参考图路径")
    parser.add_argument("--crop", help="裁剪参考图：x,y,w,h")
    parser.add_argument("--idea", default="让图片中的小人疯狂吃米饭")
    parser.add_argument("--frames", type=int, default=config.DEFAULT_FRAMES)
    parser.add_argument("--size", type=int, default=config.DEFAULT_SIZE)
    parser.add_argument("--fps", type=int, default=config.DEFAULT_FPS)
    parser.add_argument("--llm", choices=("auto", "on", "off"), default="auto")
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--seamless", action="store_true")
    parser.add_argument("--max-retries", type=int, default=config.DEFAULT_MAX_RETRIES)
    parser.add_argument("--fail-frames", default="5,9",
                        help="Mock 强制首次失败的帧号，逗号分隔；空字符串表示不强制")
    parser.add_argument("--no-gif", action="store_true")
    args = parser.parse_args(argv)

    path = Path(args.reference)
    if not path.is_file():
        print(f"参考图不存在：{path}", file=sys.stderr)
        return 2
    image = Image.open(path)
    image.load()
    crop = _parse_crop(args.crop)
    if crop:
        image = image.crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))

    settings = {
        "frames": args.frames,
        "size": args.size,
        "max_retries": args.max_retries,
        "seamless": args.seamless,
        "seed": 20261107,
        "check": {"min_change": 0.002, "max_change": 0.35,
                  "min_ssim": 0.40, "max_mae": 55, "min_hist": 0.35},
    }
    run = runner.create_run(image, args.idea, settings)
    print(f"[run] {run['id']}")
    print(f"[plan] LLM={args.llm} model={args.model or config.LLM_MODEL}")
    runner.plan_run(run, llm=args.llm, model=args.model, timeout=args.timeout)
    plan = run["plan"]
    print(f"[plan] 来源 {plan['source']}，{len(run['frames'])} 帧，{plan.get('elapsed_ms')}ms")
    if plan.get("error"):
        print(f"[plan] 兜底原因：{plan['error']}")
    for frame in run["frames"]:
        print(f"  #{frame['index']:02d} {frame['beat']} :: {frame['prompt']}")

    reference = Image.open(store.run_dir(run["id"]) / "reference.png")
    reference.load()
    generator = MockGenerator(reference, run["settings"],
                              fail_frames=_parse_frames(args.fail_frames))
    print("[run] 开始接力（Mock 生成器）")
    runner.start_run(run, generator, on_event=_progress)
    print(f"[run] 状态：{run['status']}")

    if run["status"] in ("review", "approved", "done") and not args.no_gif:
        runner.export_animation(run, fps=args.fps)
        print(f"[gif] {store.run_dir(run['id']) / 'anim.gif'}")

    report = store.write_report(run)
    print(f"[report] {report}")
    print("[frames]")
    for frame in run["frames"]:
        last = frame["attempts"][-1] if frame["attempts"] else {}
        metrics = last.get("metrics") or {}
        print(
            f"  #{frame['index']:02d} {frame['status']:<9} "
            f"attempts={len(frame['attempts'])} "
            f"changed={metrics.get('changed_ratio')} "
            f"ssim={metrics.get('ssim')} file={frame.get('acceptedFile') or frame.get('currentFile')}"
        )
    print(json.dumps({"id": run["id"], "status": run["status"],
                      "report": str(report), "gif": run.get("animation", {}).get("gif")},
                     ensure_ascii=False))
    return 0 if run["status"] in ("review", "approved", "done") else 1


if __name__ == "__main__":
    raise SystemExit(main())
