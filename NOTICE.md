# NOTICE — 致谢与使用条款

**Qwen-Image 2.1 本地工作台（Qwen-Image-STUDIO）**
Copyright 2026 huntingstar666

本文件包含两部分：**授权范围与第三方致谢**（第一部分）、**使用条款**（第二部分）。
原始许可证全文见 [LICENSE](LICENSE)（Apache License 2.0）。

---

## 第一部分　授权范围与致谢

### 1.1 授权范围

本仓库中**原创实现**的部分——`server/`、`web/src/`、`animation_kit/`、`video_studio/`、
`still_loop/`、`panorama_360/`、`pano_lab/`（脚本）、`scripts/`、`tests/`、`docs/` 及根目录文档——
以 **Apache License 2.0** 发布。

以下内容**不属于**上述授权范围：

| 内容 | 说明 |
|---|---|
| `engine/` | ComfyUI 的衍生副本，受 **GPL-3.0** 约束，详见 [engine/NOTICE.md](engine/NOTICE.md) |
| `web/vendor/`、`server/upscalers/vendor/` | 第三方组件，遵循各自许可证（见 1.3） |
| `web/assets/gallery/` | 第三方创作者的封面图与提示词，版权归原作者，仅作界面示例，不随本许可授权 |
| 模型权重（safetensors 等） | 不在本仓库内，需自行下载，遵循各自模型许可 |

> **注意**：由于本仓库包含 GPL-3.0 的 `engine/`，**整仓库**对外分发时须同时满足 GPL-3.0 的要求；
> 若你希望仅以 Apache-2.0 分发衍生作品，请删除 `engine/` 目录并自行提供引擎实现。

### 1.2 致谢

本项目的实现得益于以下开源项目与社区创作，在此一并致谢：

- **ComfyUI** — 本项目 `engine/` 直接复用其 DiT / VAE / 文本编码器 / 采样器 / LoRA 的模型实现，
  使工作台得以完全脱离 ComfyUI 服务独立推理。
- **Qwen-Image 2.1（通义千问）** — 模型权重、官方提示词润色（PE）系统提示词、尺寸与采样推荐参数。
- **MOSS-Image** — 文生图第二模型接入与 8 步加速路径。
- **ComfyUI-Precise-Align / ComfyUI-BlueBox** — 零像素偏移、零色彩偏移编辑的算法思路，
  本项目已重写为纯 numpy / 纯本地实现。
- **ComfyUI_VNCCS_Utils（AHEKOT）与 MakeHuman** — 3D 姿态编辑器的骨架渲染内核与人体数据。
- **image-style-kit / image-tools-kit（AIFISHER）** — 风格库、MJ 码图馆、裁切 / 宫格 / 扩图等前端资产与逻辑。
- **ComfyUI-VOSR2、SeedVR2、FlashVSR** — 三套高清放大引擎。
- **three.js** — 360° 全景查看器。
- **AIFISHER 灵感画廊、OpenZhenZhen** — 作品画廊的封面图与提示词示例，版权归各位原作者。

同时感谢所有在 `docs/` 中记录过的评审、实测与踩坑过程贡献者。

### 1.3 第三方组件与素材清单

| 来源 | 用途 | 位置 | 许可证 |
|---|---|---|---|
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | DiT / VAE / 文本编码器 / 采样器 / LoRA 实现（未修改） | `engine/` | GPL-3.0 |
| [Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1) | 模型权重、官方 PE 系统提示词 | 权重不入库；提示词在 `data/` | Qwen Research License |
| ComfyUI-Precise-Align | 零偏移几何算法参考，已重写 | `server/` | Apache-2.0 |
| [ComfyUI-BlueBox](https://github.com/zhoutingxi/ComfyUI-BlueBox) | 32 不动点与图像 I/O 参考，已重写 | `server/` | MIT |
| [ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) | 3D 姿态编辑器内核（原样 vendor） | `web/vendor/pose3d/vnccs/` | MIT |
| MakeHuman 人体数据 | 姿态编辑器人体网格 | `web/vendor/pose3d/vnccs/assets/` | CC0 1.0 |
| [three.js](https://github.com/mrdoob/three.js) r160 | 3D 渲染与全景查看器 | `web/vendor/pose3d/`、`panorama_360/vendor/` | MIT |
| image-style-kit（AIFISHER） | 风格库、MJ 码图、滤镜、运镜数据与逻辑 | `web/vendor/image-style-kit/` | 见其 README |
| image-tools-kit（AIFISHER） | 裁切 / 宫格 / 标注 / 全景 / 扩图前端逻辑 | `web/vendor/image-tools-kit/` | 见其 README |
| [ComfyUI-VOSR2](https://github.com/ylchen333/ComfyUI-VOSR2) | VOSR2 1.4B 放大引擎（替换宿主接口） | `server/upscalers/vendor/vosr2/` | Apache-2.0 |
| SeedVR2 | SeedVR2 7B 放大引擎 | `server/upscalers/vendor/seedvr2/` | Apache-2.0 |
| FlashVSR | FlashVSR 4× 放大引擎 | `server/upscalers/vendor/flashvsr/` | 见上游仓库 |
| [AIFISHER 灵感画廊](https://gallery.work-fisher.com/)、[OpenZhenZhen](https://www.openzhenzhen.com/) | 作品画廊封面与提示词（版权归原作者） | `web/assets/gallery/`、`web/src/data/gallery*.js` | 仅作示例，不随本许可授权 |

各目录内若附带 `LICENSE` / `NOTICE` / `README`，以其原文为准，优先于本表描述。

---

## 第二部分　使用条款

1. **合法使用。** 你应仅在遵守所在国家或地区法律法规的前提下使用本项目。禁止将本项目用于
   制作、传播违法违规内容，包括但不限于侵犯他人权益、危害未成年人、散布虚假信息等用途。

2. **生成内容责任。** 本项目仅为本地推理工作台，不提供任何模型或素材的托管服务。
   由你输入、生成、编辑、导出的一切内容及其后果，由你自行承担全部责任。

3. **肖像权与人格权。** 使用图片编辑、参考图生成、角色一致性、换脸类等能力时，
   你必须确保对所使用的肖像、作品享有合法权利或已获得明确授权，不得用于深度伪造、
   冒用他人身份或其他侵害人格权的用途。

4. **模型与素材许可。** 模型权重、LoRA、风格库、画廊封面等均不在本仓库授权范围内。
   商用前请自行核对各模型与素材的许可证（例如 Qwen Research License 对商用有额外限制），
   由此产生的合规责任由使用者承担。本仓库不附带任何模型权重。

5. **第三方代码。** 仓库中的第三方组件（见 1.3）受其原许可证约束。删除或替换这些目录后，
   相应许可证义务随之解除；反之，分发时必须保留其版权与许可声明。

6. **无担保。** 本项目按「现状」提供，不附带任何明示或默示担保，包括但不限于适销性、
   特定用途适用性与不侵权担保。作者不对因使用本项目导致的任何直接或间接损失负责，
   包括但不限于数据丢失、显存耗尽、硬件损坏或业务中断。

7. **商标。** Qwen、ComfyUI、MOSS、SeedVR2、FlashVSR、VOSR2 等名称与商标归各自所有者所有。
   本项目与上述项目及其所属公司无隶属或背书关系。

8. **条款更新。** 本条款可能随项目演进而调整，以仓库最新版本为准。若你不同意其中任何一条，
   请停止使用本项目。
