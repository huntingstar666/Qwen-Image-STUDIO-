"""VOSR2 放大引擎（通过本机 ComfyUI HTTP API 调用）。

TE-Speed-VOSR2 是闭源节点包（``inference.pyd`` / ``nodes.pyd``），无法像
SeedVR2 / FlashVSR 那样移植进本项目，因此这里走 ComfyUI 的公开 API：

1. ``POST /upload/image`` 把输入图放进 ComfyUI 的 ``input/``；
2. ``POST /prompt`` 提交与用户工作流一致的最小节点图（去掉 UI 对比节点）；
3. 轮询 ``GET /history/{prompt_id}``，完成后用 ``GET /view`` 取回结果；
4. 支持取消：先从队列删除，若已在执行则 ``POST /interrupt``。

工作流节点固定为：

- ``1``  SaveImage       输出
- ``2``  LoadImage       输入图
- ``3``  TESpeedVOSR2Settings
- ``4``  easy int        放大倍率
- ``11`` TESpeedVOSR2Image
- ``12`` TESpeedVOSR2Loader

模型目录只用于扫描可用性；真正加载模型的是 ComfyUI 进程。
"""

from __future__ import annotations

import json
import math
import time
import uuid
from io import BytesIO
from typing import Any, Callable, Optional
from urllib import error as urlerror
from urllib import parse, request

from .base import UpscaleCancelled, UpscaleError

ProgressFn = Callable[[float, str], None]
CancelFn = Callable[[], bool]

#: 与用户上传的 API 工作流保持一致的默认值。
DEFAULT_SETTINGS: dict[str, Any] = {
    "quality_profile": "speed",
    "tile_strategy": "auto",
    "tile_size": 512,
    "tile_overlap": 32,
    "vae_tile_size": 1024,
    "vae_tile_overlap": 32,
    "image_batch": 1,
    "frame_batch": 2,
    "dino_batch": 2,
    "temporal_cache": False,
    "cache_threshold": 0.003,
    "cache_refresh": 4,
    "memory_policy": "auto",
    "color_alignment": "wavelet",
}

_SETTING_KEYS = tuple(DEFAULT_SETTINGS)

DEFAULT_URL = "http://127.0.0.1:8188"


def build_workflow(
    image_name: str,
    *,
    scale: int = 2,
    seed: int = 42,
    settings: Optional[dict[str, Any]] = None,
    bundle: str = "VOSR2",
    precision: str = "auto",
    memory_policy: str = "auto",
    torch_compile: bool = False,
    vae_encode_amp: bool = False,
    prefix: str = "VOSR2",
) -> dict[str, Any]:
    """构造提交给 ComfyUI 的 API 工作流（纯函数，便于单测）。"""
    merged = {**DEFAULT_SETTINGS, **{k: v for k, v in (settings or {}).items() if k in _SETTING_KEYS}}
    try:
        scale = int(scale)
    except (TypeError, ValueError):
        scale = 2
    if scale < 1:
        scale = 1
    return {
        "1": {
            "inputs": {"filename_prefix": prefix, "images": ["11", 0]},
            "class_type": "SaveImage",
        },
        "2": {
            "inputs": {"image": image_name},
            "class_type": "LoadImage",
        },
        "3": {
            "inputs": merged,
            "class_type": "TESpeedVOSR2Settings",
        },
        "4": {
            "inputs": {"value": scale},
            "class_type": "easy int",
        },
        "11": {
            "inputs": {
                "scale": ["4", 0],
                "seed": int(seed),
                "model": ["12", 0],
                "images": ["2", 0],
                "settings": ["3", 0],
            },
            "class_type": "TESpeedVOSR2Image",
        },
        "12": {
            "inputs": {
                "model_bundle": bundle or "VOSR2",
                "precision": precision or "auto",
                "memory_policy": memory_policy or "auto",
                "torch_compile": bool(torch_compile),
                "vae_encode_amp": bool(vae_encode_amp),
            },
            "class_type": "TESpeedVOSR2Loader",
        },
    }


class VOSR2ComfyEngine:
    """把 ComfyUI 当作远程推理进程的 VOSR2 适配器。"""

    name = "vosr2"

    def __init__(
        self,
        *,
        url: str = DEFAULT_URL,
        settings: Optional[dict[str, Any]] = None,
        bundle: str = "VOSR2",
        precision: str = "auto",
        memory_policy: str = "auto",
        timeout_seconds: float = 1800,
    ) -> None:
        self.url = (url or DEFAULT_URL).rstrip("/")
        self.settings = {**DEFAULT_SETTINGS, **{k: v for k, v in (settings or {}).items() if k in _SETTING_KEYS}}
        self.bundle = bundle or "VOSR2"
        self.precision = precision or "auto"
        self.memory_policy = memory_policy or "auto"
        self.timeout_seconds = max(30.0, float(timeout_seconds or 1800))
        self._opener = request.build_opener(request.ProxyHandler({}))

    # ----------------------------------------------------------- 引擎接口
    @property
    def loaded(self) -> bool:
        # 权重在 ComfyUI 进程里，本进程没有可卸载的对象
        return False

    def unload(self) -> None:
        return None

    def upscale(
        self,
        image,
        *,
        scale: int = 2,
        seed: int = 42,
        progress: Optional[ProgressFn] = None,
        should_cancel: Optional[CancelFn] = None,
        **_: Any,
    ):
        report = progress or (lambda _value, _label: None)
        cancel = should_cancel or (lambda: False)
        if cancel():
            raise UpscaleCancelled("已取消")

        report(5, "上传到 ComfyUI")
        png = _to_png_bytes(image)
        image_name = f"qwen-tools-{uuid.uuid4().hex[:12]}.png"
        try:
            uploaded = self._upload_image(png, image_name)
        except UpscaleError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise UpscaleError(
                f"无法连接 ComfyUI（{self.url}），请先启动 ComfyUI：{exc}"
            ) from exc

        if cancel():
            raise UpscaleCancelled("已取消")

        workflow = build_workflow(
            uploaded,
            scale=scale,
            seed=seed,
            settings=self.settings,
            bundle=self.bundle,
            precision=self.precision,
            memory_policy=self.memory_policy,
        )
        report(10, "提交任务")
        prompt_id = self._submit(workflow)
        report(20, "VOSR2 推理中")

        started = time.time()
        status_label = "推理中"
        while True:
            if cancel():
                self._cancel(prompt_id)
                raise UpscaleCancelled("已取消")
            elapsed = time.time() - started
            if elapsed > self.timeout_seconds:
                self._cancel(prompt_id)
                raise UpscaleError(
                    f"VOSR2 超时（{int(self.timeout_seconds)} 秒），已尝试从 ComfyUI 队列移除"
                )
            entry = self._history(prompt_id)
            if entry is not None:
                images = _history_images(entry)
                if not images:
                    raise UpscaleError("ComfyUI 任务结束但没有输出图像")
                report(90, "下载结果")
                return self._fetch_image(images[0])
            queue_state = self._queue_state(prompt_id)
            if queue_state == "pending":
                status_label = "排队中（ComfyUI 有其他任务）"
            elif queue_state == "running":
                status_label = "推理中"
            soft = 20 + 60 * (1 - math.exp(-elapsed / 90))
            report(min(85.0, soft), f"VOSR2 {status_label}（{int(elapsed)}s）")
            time.sleep(1.0)

    # ----------------------------------------------------------- HTTP 细节
    def _request(self, path: str, *, data: Optional[bytes] = None, headers: Optional[dict[str, str]] = None,
                 timeout: float = 30.0) -> bytes:
        url = f"{self.url}{path}"
        req = request.Request(url, data=data, headers=headers or {})
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return resp.read()
        except urlerror.HTTPError as exc:
            detail = _error_detail(exc)
            raise UpscaleError(f"ComfyUI 返回 {exc.code}：{detail}") from exc
        except urlerror.URLError as exc:
            raise UpscaleError(
                f"无法连接 ComfyUI（{self.url}），请先启动 ComfyUI：{exc.reason}"
            ) from exc

    def _json(self, path: str) -> Any:
        raw = self._request(path, timeout=15.0)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise UpscaleError(f"ComfyUI 返回了非 JSON 响应：{exc}") from exc

    def _post_json(self, path: str, payload: dict[str, Any]) -> Any:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        raw = self._request(
            path, data=body, headers={"Content-Type": "application/json"}, timeout=30.0
        )
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def _upload_image(self, png: bytes, filename: str) -> str:
        boundary = f"----QwenTools{uuid.uuid4().hex}"
        chunks: list[bytes] = [
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
                "Content-Type: image/png\r\n\r\n"
            ).encode("utf-8"),
            png,
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue".encode(),
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput".encode(),
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        raw = self._request(
            "/upload/image",
            data=b"".join(chunks),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            timeout=60.0,
        )
        try:
            info = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise UpscaleError(f"上传图片失败：{exc}") from exc
        name = str(info.get("name") or "")
        subfolder = str(info.get("subfolder") or "")
        if not name:
            raise UpscaleError("上传图片失败：ComfyUI 未返回文件名")
        return f"{subfolder}/{name}" if subfolder else name

    def _submit(self, workflow: dict[str, Any]) -> str:
        info = self._post_json(
            "/prompt", {"prompt": workflow, "client_id": uuid.uuid4().hex}
        )
        prompt_id = str(info.get("prompt_id") or "")
        if not prompt_id:
            detail = info.get("error") or info.get("node_errors") or info
            raise UpscaleError(f"ComfyUI 拒绝了任务：{_compact(detail)}")
        return prompt_id

    def _history(self, prompt_id: str) -> Optional[dict[str, Any]]:
        data = self._json(f"/history/{prompt_id}")
        if not isinstance(data, dict):
            return None
        entry = data.get(prompt_id)
        return entry if isinstance(entry, dict) else None

    def _queue_state(self, prompt_id: str) -> str:
        try:
            data = self._json("/queue")
        except UpscaleError:
            return ""
        for key, state in (("queue_running", "running"), ("queue_pending", "pending")):
            for item in data.get(key) or []:
                if isinstance(item, (list, tuple)) and len(item) > 1 and item[1] == prompt_id:
                    return state
        return ""

    def _fetch_image(self, info: dict[str, Any]):
        from PIL import Image

        query = parse.urlencode(
            {
                "filename": info.get("filename") or "",
                "subfolder": info.get("subfolder") or "",
                "type": info.get("type") or "output",
            }
        )
        raw = self._request(f"/view?{query}", timeout=120.0)
        try:
            with Image.open(BytesIO(raw)) as image:
                image.load()
                return image.copy()
        except Exception as exc:  # noqa: BLE001
            raise UpscaleError(f"无法读取 ComfyUI 输出图像：{exc}") from exc

    def _cancel(self, prompt_id: str) -> None:
        try:
            self._post_json("/queue", {"delete": [prompt_id]})
        except Exception:  # noqa: BLE001
            pass
        if self._queue_state(prompt_id) == "running":
            try:
                self._post_json("/interrupt", {})
            except Exception:  # noqa: BLE001
                pass


# ----------------------------------------------------------------- 工具函数

def _to_png_bytes(image) -> bytes:
    buf = BytesIO()
    image.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def _history_images(entry: dict[str, Any]) -> list[dict[str, Any]]:
    status = entry.get("status") or {}
    if isinstance(status, dict) and status.get("status_str") == "error":
        raise UpscaleError(f"VOSR2 执行失败：{_compact(status.get('messages'))}")
    images: list[dict[str, Any]] = []
    outputs = entry.get("outputs") or {}
    if isinstance(outputs, dict):
        for node_out in outputs.values():
            if not isinstance(node_out, dict):
                continue
            for item in node_out.get("images") or []:
                if isinstance(item, dict) and item.get("filename"):
                    images.append(item)
    return images


def _compact(value: Any, limit: int = 400) -> str:
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False)
    else:
        text = str(value)
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "")


def _error_detail(exc: urlerror.HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return str(exc.reason or exc)
    detail = payload.get("error") or payload.get("node_errors") or payload
    return _compact(detail)
