"""核心层异常：不反向依赖 server 模块。"""


class AnimationCanceled(Exception):
    """任务被用户取消。"""
