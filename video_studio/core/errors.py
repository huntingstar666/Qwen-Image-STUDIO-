"""video_studio 异常类型。

路由层统一把 :class:`StudioError` 转成 ``{"error": ..., "code": ...}``。
"""
from __future__ import annotations


class StudioError(ValueError):
    """参数或运行错误（默认按 400 返回）。"""

    def __init__(self, message: str, *, code: str = "invalid_field", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class CanceledError(StudioError):
    """任务被用户取消。"""

    def __init__(self, message: str = "任务已取消") -> None:
        super().__init__(message, code="canceled", status=409)


class MainProjectError(StudioError):
    """主项目不可达或返回异常。"""

    def __init__(self, message: str, *, code: str = "main_unavailable") -> None:
        super().__init__(message, code=code, status=502)


class RenderError(StudioError):
    """ffmpeg 渲染失败。"""

    def __init__(self, message: str, *, code: str = "render_failed") -> None:
        super().__init__(message, code=code, status=500)
