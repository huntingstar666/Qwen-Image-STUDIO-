"""为移植后的 engine/ 目录生成 SOURCE.json 与 NOTICE.md（被 scripts/port_engine.ps1 调用）。

单独用 Python 写元数据，是为了避免 PowerShell here-string 里反引号/转义的坑。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys


def count_py(target: str) -> tuple[int, int, list[str]]:
    total = 0
    files = 0
    subdirs: list[str] = []
    for entry in os.listdir(target):
        if entry == "comfy" and os.path.isdir(os.path.join(target, entry)):
            subdirs = sorted(
                d for d in os.listdir(os.path.join(target, entry))
                if os.path.isdir(os.path.join(target, entry, d)) and d != "__pycache__"
            )
    for dirpath, dirnames, filenames in os.walk(target):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            if name.endswith(".py"):
                try:
                    total += os.path.getsize(os.path.join(dirpath, name))
                    files += 1
                except OSError:
                    pass
    return files, total, subdirs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="engine 目录")
    ap.add_argument("--source", default="", help="来源 ComfyUI 根目录（只用于校验，不写入元数据）")
    ap.add_argument("--version", default="unknown")
    ap.add_argument("--commit", default="")
    args = ap.parse_args(argv)

    target = os.path.abspath(args.target)
    if not os.path.isdir(os.path.join(target, "comfy")):
        print(f"[write-engine-notice] 目标里没有 comfy/：{target}", file=sys.stderr)
        return 1

    files, total_bytes, subdirs = count_py(target)
    now = _dt.datetime.now().astimezone()

    meta = {
        # 不记录本机绝对路径，避免随仓库外泄
        "source_root": "本地安装（路径未记录）",
        "source_version": args.version,
        "source_commit": args.commit or "",
        "copied_at": now.strftime("%Y-%m-%d %H:%M:%S%z"),
        "file_count": files,
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / (1024 ** 2), 2),
        "vendored_packages": ["comfy", "node_helpers.py"],
        "comfy_subdirs": subdirs,
        "note": "comfy/ 与 node_helpers.py 为 ComfyUI 源码副本，未修改；本项目只 import 其模型库代码，"
                "不启动 ComfyUI 服务、不使用其节点图/队列/前端。",
        "how_to_update": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\port_engine.ps1",
    }

    with open(os.path.join(target, "SOURCE.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    notice = f"""# 第三方代码来源说明（engine/）

本目录下的 `comfy/` 与 `node_helpers.py` 复制自 ComfyUI 开源项目，**未做修改**：

| 项 | 值 |
|---|---|
| 来源 | ComfyUI 官方仓库（本地安装，路径未记录） |
| ComfyUI 版本 | `{args.version}` |
| commit | `{args.commit or "unknown"}` |
| 复制时间 | {meta["copied_at"]} |
| 文件数 | {files} 个 .py |
| 代码量 | {meta["total_mb"]} MB |

## 用途

为本项目提供 Qwen-Image 2.1 的模型实现：DiT（`comfy/ldm/qwen_image21`）、
VAE（`comfy/sd.py` 的 `VAE`）、文本编码器（`comfy/text_encoders/qwen_image21.py`、
`qwen3vl.py`）、采样器（`comfy/samplers.py`、`comfy/sample.py`）、
LoRA 加载（`comfy/sd.py` 的 `load_lora_for_models`）。

本项目**只 import** 这些模块，不启动 ComfyUI 服务，也不使用其节点图 / 队列 / 前端。
`folder_paths`、`nodes.py`、`server.py` 等「服务层」文件**没有**被复制，引擎也不需要它们
（已验证 `comfy/` 内对这三个模块零引用，唯一例外是 `comfy/ldm/sam3d_body/model/model.py`
引用了 `comfy_extras.mediapipe`，该模块不在 Qwen 导入链上，运行时不会被加载）。

## 许可证

ComfyUI 以 **GPL-3.0** 发布（https://github.com/comfyanonymous/ComfyUI ）。
本目录是其衍生副本，同样受 GPL-3.0 约束：

- **自用（本地运行）没有问题**；
- 若要对外分发本项目，需遵守 GPL-3.0（开源相应部分）或另行取得授权。

## 权重文件不在此目录

模型权重（safetensors）仍在原 ComfyUI 的 `models/` 下，本项目只读取、不复制。
路径在 `config.json` 的 `model_root` 配置；也可指向任意其他目录。

## 更新方式

从同版本或新版本 ComfyUI 重新镜像：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\port_engine.ps1
```

校验项目内副本可独立 import：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\port_engine.ps1 -Check
```
"""

    with open(os.path.join(target, "NOTICE.md"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(notice)

    print(f"[write-engine-notice] SOURCE.json + NOTICE.md 已写入 {target}（{files} 个 .py, {meta['total_mb']} MB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
