"""still_loop：一张参考图 + 一句话 → N 帧接力编辑 → GIF。

独立包，不 import 主项目；只通过 HTTP 调主项目已有的 /api/edit 等接口。
当前阶段提供 Mock 生成器，便于在主项目测试期间离线验证整条编排链路。
"""

__version__ = "0.1.0"
