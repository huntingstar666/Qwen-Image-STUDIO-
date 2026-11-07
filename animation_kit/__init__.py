"""定格动画 / GIF 工作台（独立可移植套件）。

设计目标与 ``qwen-image2.1`` 主项目保持一致：

* 后端只依赖 FastAPI + Pillow + numpy，算法层不 import torch；
* 前端是浏览器原生 ES module，**零构建、零安装**；
* 数据流单一来源：字段/枚举/默认值全部登记在 ``core/registry.py``；
* 默认守住「整数坐标、不缩放、不重采样、alpha 原样」的零偏移规则；
* 导出走单 worker 任务队列，前端轮询 ``/api/jobs/{id}``。

后续并入主项目时：

* ``core/`` 可整体移动为 ``server/animation/``；
* ``server/app.py`` 的路由按 ``server/main.py`` 的风格拆进主路由；
* 帧文件写入换成 ``storage.save_output`` 即可；
* 前端模块可直接放进 ``web/src/components/animation/``。
"""

__version__ = "0.1.0"
