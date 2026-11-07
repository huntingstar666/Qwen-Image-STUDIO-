"""``python -m animation_kit`` 启动工作台。"""
from __future__ import annotations

import argparse
import webbrowser

from . import config


def main() -> None:
    parser = argparse.ArgumentParser(description="定格动画 / GIF 工作台")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    import uvicorn

    url = f"http://{args.host}:{args.port}/"
    if args.open:
        webbrowser.open(url)
    print(f"[anim] 工作台：{url}")
    print(f"[anim] 数据目录：{config.DATA_DIR}")
    uvicorn.run("animation_kit.server.app:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
