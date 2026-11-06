# 第三方代码来源说明（engine/）

本目录下的 `comfy/` 与 `node_helpers.py` 复制自 ComfyUI 开源项目，**未做修改**：

| 项 | 值 |
|---|---|
| 来源 | `<COMFY_ROOT>\ComfyUI-aki-v3.2\ComfyUI` |
| ComfyUI 版本 | `0.43.0` |
| commit | `ab08f7b2caa6d4007ecde3762116c6193613f43b` |
| 复制时间 | 2026-11-04 01:40:46+0800 |
| 文件数 | 329 个 .py |
| 代码量 | 5.41 MB |

## 用途

为本项目提供 Qwen-Image 2.1 的模型实现：DiT（`comfy/ldm/qwen_image21`）、
VAE（`comfy/sd.py` 的 `VAE`）、文本编码器（`comfy/text_encoders/qwen_image21.py`、
`qwen3vl.py`）、采样器（`comfy/samplers.py`、`comfy/sample.py`）、
LoRA 加载（`comfy/sd.py` 的 `load_lora_for_models`）。

本项目**只 import** 这些模块，不启动 ComfyUI 服务，也不使用其节点图 / 队列 / 前端。
`folder_paths`、`nodes.py`、`server.py` 等「服务层」文件**没有**被复制，引擎也不需要它们
（已验证 `comfy/` 内对这三个模块零引用，唯一例外是 `comfy/ldm/sam3d_body/model/model.py`
引用了 `comfy_extras.mediapipe`，该模块不在 Qwen 导入链上，运行时不会被加载）。

## 许可证

ComfyUI 以 **GPL-3.0** 发布（https://github.com/comfyanonymous/ComfyUI ）。
本目录是其衍生副本，同样受 GPL-3.0 约束：

- **自用（本地运行）没有问题**；
- 若要对外分发本项目，需遵守 GPL-3.0（开源相应部分）或另行取得授权。

## 权重文件不在此目录

模型权重（safetensors）仍在原 ComfyUI 的 `models/` 下，本项目只读取、不复制。
路径在 `config.json` 的 `model_root` 配置；也可指向任意其他目录。

## 更新方式

从同版本或新版本 ComfyUI 重新镜像：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1
```

校验项目内副本可独立 import：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\port_engine.ps1 -Check
```
