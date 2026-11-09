"""启动视频工作台：``python -m video_studio.serve --open``"""
from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from . import config
from .server.app import app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="video_studio 音频驱动视频工作台")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args(argv)

    url = f"http://{args.host}:{args.port}/"
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"video_studio: {url}")
    print(f"  data: {config.DATA_DIR}")
    print(f"  main: {config.MAIN_BASE}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
