"""启动 still_loop 工作台：python -m still_loop.serve --open"""
from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from . import config
from .server.app import app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="still_loop 定格接力工作台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8720)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args(argv)
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{args.host}:{args.port}/")).start()
    print(f"still_loop: http://{args.host}:{args.port}/  (data: {config.DATA_DIR})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
