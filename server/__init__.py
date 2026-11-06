"""Qwen-Image 2.1 独立本地工作台 —— 服务端包。

模块职责（详见 docs/BUILD_CONTRACT.md）：

    config         配置：模型路径 / 引擎目录 / Ollama / 默认值 / 比例表
    imaging        图像 I/O + 画布规划 + 遮罩映射 + 合成（BlueBox 零色差移植）
    align          几何与颜色算法核（Precise-Align 零偏移移植，纯 numpy）
    backends.native 进程内推理引擎（项目内 engine/ 提供模型实现）
    pipeline       编排：解码 → 32 对齐画布 → 引擎采样 → 裁回 → 合成 → 存盘
    jobs           单 worker 任务队列 + 进度 + 历史
    storage        工作区文件存取
    ollama         Ollama HTTP 客户端
    prompt_polish  官方 PE 提示词润色
    styles         image-style-kit 目录 + 提示词合成
    main           FastAPI 入口与路由
"""

__version__ = "1.0.0"
