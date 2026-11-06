"""校验项目内的 engine/ 副本可以独立 import ComfyUI 的模型库代码。

对应：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/port_engine.ps1 -Check

判定标准：
1. `comfy.*` 与 `node_helpers` 全部解析到 `engine/` 下；
2. 原 ComfyUI 根目录**不在** sys.path 中；
3. 引擎用到的关键子模块（sd / samplers / sample / model_management / cli_args /
   text_encoders.qwen_image21 / ldm.qwen_image21.model）均可导入。
"""
from __future__ import annotations

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "engine"))
    args = ap.parse_args(argv)

    engine = os.path.abspath(args.engine)
    if not os.path.isfile(os.path.join(engine, "comfy", "sd.py")):
        print(f"[check-engine] FAIL: 缺少 {engine}\\comfy\\sd.py")
        return 1

    forbidden = r"<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI"
    sys.path = [p for p in sys.path if os.path.abspath(p or ".") != os.path.abspath(forbidden)]
    sys.path.insert(0, engine)

    import comfy.cli_args  # noqa: F401
    import comfy.ldm.qwen_image21.model as qwen_model
    import comfy.model_management  # noqa: F401
    import comfy.sample  # noqa: F401
    import comfy.samplers  # noqa: F401
    import comfy.sd as sd
    import comfy.text_encoders.qwen_image21 as te21
    import node_helpers  # noqa: F401

    checks = {
        "comfy.sd": sd.__file__,
        "comfy.text_encoders.qwen_image21": te21.__file__,
        "comfy.ldm.qwen_image21.model": qwen_model.__file__,
        "node_helpers": node_helpers.__file__,
    }
    bad = []
    for name, path in checks.items():
        real = os.path.abspath(path)
        ok = real.startswith(engine + os.sep)
        print(f"[check-engine] {'OK  ' if ok else 'FAIL'} {name} -> {real}")
        if not ok:
            bad.append(name)

    if forbidden in sys.path:
        bad.append(f"{forbidden} 仍在 sys.path")

    if bad:
        print(f"[check-engine] FAIL: {bad}")
        return 1

    print(f"[check-engine] PASS: engine 独立可用（{engine}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
