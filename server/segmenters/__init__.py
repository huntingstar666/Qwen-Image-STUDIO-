"""AI 主体分割（修图工作台「主体」工具的后端实现）。

    maskops    蒙版纯算法（坐标校验 / 二值化 / 连通域 / 羽化）
    registry   模型目录扫描、就绪判定与模型选择
    engines    SAM 3.1（点/框/文字）与 BiRefNet（显著性主体）
    manager    单例管理 + 请求编排（原图尺寸输出、候选排序、超时）
"""

from .errors import SegmentError
from .manager import SegmentManager, get_manager

__all__ = ["SegmentError", "SegmentManager", "get_manager"]
