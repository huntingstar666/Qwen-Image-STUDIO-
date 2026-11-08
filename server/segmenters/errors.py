"""分割相关错误：带 HTTP 语义，主程序直接映射到 ``ApiError``。"""

from __future__ import annotations


class SegmentError(RuntimeError):
    """分割请求失败（message 直接给中文提示）。"""

    def __init__(self, message: str, *, code: str = "segmentation_failed",
                 status: int = 500) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
