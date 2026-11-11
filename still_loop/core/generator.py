"""生成器：Mock（离线模拟）与主项目 /api/edit 客户端。"""
from __future__ import annotations

import io
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from .. import config
from .schema import normalize_settings

ProgressFn = Callable[[dict[str, Any]], None]


class GeneratorError(RuntimeError):
    pass


class GeneratorCanceled(GeneratorError):
    pass


@dataclass
class FrameRef:
    image: Image.Image
    url: str | None = None


@dataclass
class GeneratedImage:
    image: Image.Image
    job_id: str = ""
    url: str | None = None
    elapsed_ms: int = 0
    quality: dict[str, Any] = field(default_factory=dict)
    align: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)


def _fill_for(image: Image.Image) -> tuple[int, ...]:
    return (255, 255, 255) if image.mode == "RGB" else (0, 0, 0, 0)


def _motion(image: Image.Image, scale_x: float, scale_y: float, angle: float,
            dx: float, dy: float) -> Image.Image:
    """单次仿射变换：缩放 + 旋转 + 位移一次重采样，避免多道重采样累积糊化。"""
    if (abs(scale_x - 1.0) < 1e-4 and abs(scale_y - 1.0) < 1e-4
            and abs(angle) < 0.05 and abs(dx) < 0.05 and abs(dy) < 0.05):
        return image
    width, height = image.size
    cx, cy = width / 2.0, height / 2.0
    theta = math.radians(angle)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    a, b = cos_t / scale_x, sin_t / scale_x
    d, e = -sin_t / scale_y, cos_t / scale_y
    c = (-cos_t * (cx + dx) - sin_t * (cy + dy)) / scale_x + cx
    f = (sin_t * (cx + dx) - cos_t * (cy + dy)) / scale_y + cy
    return image.transform(
        (width, height), Image.Transform.AFFINE, (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC, fillcolor=_fill_for(image))


def _warm(image: Image.Image, amount: float) -> Image.Image:
    if abs(amount) < 0.001:
        return image
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    array[..., 0] = np.clip(array[..., 0] * (1.0 + 0.05 * amount), 0, 255)
    array[..., 2] = np.clip(array[..., 2] * (1.0 - 0.05 * amount), 0, 255)
    tinted = Image.fromarray(array.astype(np.uint8), mode="RGB")
    if "A" in image.getbands():
        tinted = tinted.convert("RGBA")
        tinted.putalpha(image.getchannel("A"))
    return tinted


class MockGenerator:
    """模拟主项目出图：在固定锚点上做一次仿射动作，模拟“吃东西的起伏”。

    关键点：每一帧都从原始参考图（锚点）做**一次**重采样，而不是在上一帧基础上
    反复缩放/旋转。后者会让 12 帧后的画面明显发糊、偏色——那是 Mock 的锅，不是流程。
    动作幅度随 phase 推进（上下点头 + 咀嚼式纵向压缩），颜色只在 ±3% 内来回摆，
    末帧回到 0，不会单向越走越暖。

    为了让自检/重试链路可见：指定帧的第一次尝试会故意产出“改动过大”的图，
    第二次起恢复正常，从而稳定触发一次重试。
    """

    name = "mock"

    def __init__(self, reference: Image.Image, settings: dict[str, Any] | None = None,
                 *, fail_frames: tuple[int, ...] = (5, 9)) -> None:
        self.settings = normalize_settings(settings)
        self.keep_alpha = "A" in reference.getbands()
        self.reference = reference.convert("RGBA" if self.keep_alpha else "RGB")
        self.fail_frames = set(fail_frames)
        self._forced: set[int] = set()
        self._anchor: Image.Image | None = None

    def prepare(self, reference: Image.Image) -> FrameRef:
        return FrameRef(self.reference.copy())

    def _anchor_image(self) -> Image.Image:
        if self._anchor is None:
            self._anchor = self.reference.copy()
        return self._anchor.copy()

    def generate(self, previous: FrameRef, reference: FrameRef, prompt: str,
                 frame_index: int, total: int, attempt: int,
                 on_progress: ProgressFn | None = None,
                 extras: list[FrameRef] | None = None) -> GeneratedImage:
        started = time.time()
        if on_progress:
            on_progress({"stage": "mock", "frame": frame_index, "attempt": attempt,
                         "message": f"Mock 生成第 {frame_index}/{total} 帧（第 {attempt} 次）"})
        phase = 0.0 if frame_index >= total and self.settings["seamless"] else (
            (frame_index - 1) / max(1, total - 1))
        # 重试时模拟“纠错指令让动作变小”，否则 Mock 会一直以同样幅度失败。
        damping = 1.0 if attempt == 1 else 0.45
        beat = phase * math.tau
        image = self._anchor_image()
        # 咀嚼节奏：一个循环内 2.5 次纵向压缩 + 1.5 次上下点头。
        # 频率故意取非整数，避免相邻两帧同时落在余弦的极值点、姿态撞车被判 too_small。
        chew = math.cos(beat * 2.5) * damping
        bob = math.cos(beat * 1.5) * damping
        image = _motion(
            image,
            scale_x=1.04 - 0.012 * chew,
            scale_y=1.04 + 0.026 * chew,
            angle=1.0 * bob,
            dx=1.5 * math.sin(beat) * damping,
            dy=-4.0 * bob,
        )
        # 色温来回摆：phase 0/1 均为 0，不会像旧版那样单向累积变暖。
        image = _warm(image, 0.6 * math.sin(beat) * damping)

        if (attempt == 1 and frame_index in self.fail_frames
                and frame_index not in self._forced):
            # 故意做坏一次：反相 + 重模糊，自检应判 too_large / structure / color。
            # 每个帧只强迫失败一次，手动重试同一帧时不再重复做坏。
            self._forced.add(frame_index)
            rgb = ImageOps.invert(image.convert("RGB"))
            rgb = rgb.filter(ImageFilter.GaussianBlur(radius=6))
            image = rgb.convert("RGBA" if self.keep_alpha else "RGB")

        if not ("A" in self.reference.getbands()):
            image = image.convert("RGB")
        else:
            image = image.convert("RGBA")

        elapsed = int((time.time() - started) * 1000)
        return GeneratedImage(
            image=image,
            job_id=f"mock-{frame_index:02d}-{attempt}",
            elapsed_ms=elapsed,
            meta={"generator": "mock", "prompt": prompt, "attempt": attempt},
        )

    def text_to_image(self, prompt: str, frame_index: int, total: int, attempt: int,
                      on_progress: ProgressFn | None = None) -> GeneratedImage:
        """演示引擎的文生图：纯色画布 + 提示词，仅用于打通界面流程。"""
        started = time.time()
        if on_progress:
            on_progress({"stage": "mock", "frame": frame_index, "attempt": attempt,
                         "message": f"Mock 文生图第 {frame_index}/{total} 帧"})
        size = max(256, int(self.settings.get("size") or 512))
        image = Image.new("RGB", (size, size), (247, 243, 236))
        draw = ImageDraw.Draw(image)
        text = str(prompt or "").encode("ascii", "replace").decode("ascii")
        lines = [text[i:i + 48] for i in range(0, len(text), 48)][:14] or ["(empty prompt)"]
        for i, line in enumerate(lines):
            draw.text((24, 24 + i * 18), line, fill=(60, 64, 70))
        return GeneratedImage(
            image=image,
            job_id=f"mock-t2i-{frame_index:02d}-{attempt}",
            elapsed_ms=int((time.time() - started) * 1000),
            meta={"generator": "mock", "prompt": prompt, "attempt": attempt, "mode": "t2i"},
        )


class MainProjectError(GeneratorError):
    pass


class MainProjectClient:
    """通过 HTTP 调主项目，不 import 其代码。"""

    name = "main"

    def __init__(self, base_url: str | None = None, settings: dict[str, Any] | None = None,
                 *, timeout: float = 600.0) -> None:
        self.base_url = (base_url or config.MAIN_BASE).rstrip("/")
        self.settings = normalize_settings(settings)
        self.timeout = timeout

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None,
                 *, timeout: float | None = None) -> dict[str, Any]:
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers,
                                         method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:500]
            raise MainProjectError(f"{method} {path} HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise MainProjectError(f"主项目不可达：{self.base_url}（{exc.reason}）") from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/api/health", timeout=5.0)

    def wait_ready(self, seconds: float = 60.0) -> bool:
        """主项目偶发进程退出/重启；推理前等它回来，别把整条 run 直接判死。"""
        deadline = time.time() + seconds
        while time.time() < deadline:
            try:
                if self.health().get("ok", True):
                    return True
            except MainProjectError:
                pass
            time.sleep(2.0)
        return False

    def upload(self, data: bytes, name: str = "reference.png") -> str:
        boundary = "----stillloop" + uuid.uuid4().hex
        body = bytearray()
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'.encode())
        body.extend(b"Content-Type: image/png\r\n\r\n")
        body.extend(data)
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self.base_url + "/api/upload", data=bytes(body), method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with urllib.request.urlopen(request, timeout=60.0) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise MainProjectError(f"上传参考图失败：{exc}") from exc
        url = str(result.get("url") or "")
        if not url:
            raise MainProjectError(f"上传参考图返回异常：{result}")
        return url

    def prepare(self, reference: Image.Image) -> FrameRef:
        buffer = io.BytesIO()
        reference.save(buffer, format="PNG")
        url = self.upload(buffer.getvalue())
        return FrameRef(reference.copy(), url=url)

    def _payload(self, prompt: str, previous: FrameRef, reference: FrameRef,
                 frame_index: int, attempt: int,
                 extras: list[FrameRef] | None = None) -> dict[str, Any]:
        images = []
        if previous.url:
            images.append({"name": "previous.png", "url": previous.url})
        else:
            images.append({"name": "previous.png", "url": ""})
        if reference.url:
            images.append({"name": "reference.png", "url": reference.url})
        # 用户拖进参考框的额外图片，顺序接在画布之后，对应提示词里的 <imageN>。
        for order, extra in enumerate(extras or [], start=1):
            if extra.url:
                images.append({"name": f"extra{order}.png", "url": extra.url})
        settings = self.settings
        payload: dict[str, Any] = {
            "prompt": prompt,
            "images": images,
            "model": settings.get("model") or "qwen",
            "size_mode": "follow",
            "fit": "pad",
            "pad_mode": "edge",
            "resolution": 0,
            "steps": settings["steps"],
            "cfg": settings["cfg"],
            "seed": settings["seed"],
            "denoise": settings["denoise"],
            "sampler": "euler",
            "scheduler": "simple",
            "turbo": {"enabled": settings["turbo"], "profile": "turbo8_official"},
            "task": {"mode": "edit"},
            "consistency_lora": {"enabled": bool(settings.get("consistency", True))},
            "preprocess": {
                "enabled": True,
                "max_side": max(int(settings.get("width") or settings["size"]),
                                int(settings.get("height") or settings["size"])),
                "min_side": 256,
                "multiple": 32,
                "mode": "downscale_only",
            },
            "zero_shift": {"enabled": True, "snap": 32, "resolution": 0},
            "meta": {"source": "still_loop", "frame": frame_index, "attempt": attempt},
        }
        if settings.get("preset"):
            payload["preset"] = settings["preset"]
        return payload

    def wait(self, job_id: str, on_progress: ProgressFn | None = None,
             *, poll: float = 1.0) -> dict[str, Any]:
        deadline = time.time() + self.timeout
        last_label = ""
        misses = 0
        while time.time() < deadline:
            try:
                job = self._request("GET", f"/api/jobs/{job_id}", timeout=15.0)
                misses = 0
            except (urllib.error.URLError, ConnectionResetError, ConnectionAbortedError,
                    TimeoutError, json.JSONDecodeError) as exc:
                # 主项目在推理高负载下会偶发强制断连，读状态是幂等的，退避重试即可，
                # 不要因为一次断连把整条 run 判死。
                misses += 1
                if misses > 20:
                    raise MainProjectError(f"读取任务状态连续失败：{exc}") from exc
                time.sleep(min(0.5 * misses, 3.0))
                continue
            status = str(job.get("status") or "")
            progress = job.get("progress") or {}
            label = str(progress.get("label") or "")
            if on_progress and label != last_label:
                last_label = label
                on_progress({"stage": "job", "job": job_id,
                             "message": f"{label} {progress.get('value', 0)}/{progress.get('max', 1)}",
                             "progress": progress})
            if status == "done":
                return job
            if status == "canceled":
                raise GeneratorCanceled("主项目任务已取消")
            if status == "error":
                raise MainProjectError(str(job.get("error") or "主项目任务失败"))
            time.sleep(poll)
        raise MainProjectError(f"任务超时：{job_id}")

    def download(self, url: str) -> bytes:
        # 主项目产物文件名带提示词前缀（中文），http.client 只接受 ASCII 请求行，
        # 这里统一做一次百分号编码；已是完整 URL 的只编码路径与查询部分。
        if url.startswith("http"):
            parts = urllib.parse.urlsplit(url)
            target = urllib.parse.urlunsplit((
                parts.scheme, parts.netloc,
                urllib.parse.quote(parts.path),
                urllib.parse.quote(parts.query, safe="=&"),
                parts.fragment,
            ))
        else:
            target = self.base_url + urllib.parse.quote(url)
        with urllib.request.urlopen(target, timeout=60.0) as response:
            return response.read()

    def generate(self, previous: FrameRef, reference: FrameRef, prompt: str,
                 frame_index: int, total: int, attempt: int,
                 on_progress: ProgressFn | None = None,
                 extras: list[FrameRef] | None = None) -> GeneratedImage:
        payload = self._payload(prompt, previous, reference, frame_index, attempt, extras)
        submitted = self._request("POST", "/api/edit", payload, timeout=120.0)
        job_id = str(submitted.get("job_id") or "")
        if not job_id:
            raise MainProjectError(f"提交编辑任务失败：{submitted}")
        job = self.wait(job_id, on_progress)
        outputs = job.get("images") or []
        if not outputs:
            raise MainProjectError(f"任务 {job_id} 没有输出图片")
        output = outputs[0]
        url = str(output.get("url") or "")
        data = self.download(url)
        image = Image.open(io.BytesIO(data))
        image.load()
        return GeneratedImage(
            image=image,
            job_id=job_id,
            url=url,
            elapsed_ms=int(job.get("elapsed_ms") or 0),
            quality=job.get("quality") or {},
            align=job.get("align") or {},
            meta={"generator": "main", "prompt": prompt, "attempt": attempt,
                  "output": output, "model": self.settings.get("model")},
        )

    def text_to_image(self, prompt: str, frame_index: int, total: int, attempt: int,
                      on_progress: ProgressFn | None = None) -> GeneratedImage:
        """参考框为空时走主项目 /api/generate（文生图）。"""
        settings = self.settings
        width = int(settings.get("width") or settings["size"])
        height = int(settings.get("height") or settings["size"])
        payload: dict[str, Any] = {
            "prompt": prompt,
            "model": settings.get("model") or "qwen",
            "width": width,
            "height": height,
            "steps": settings["steps"],
            "cfg": settings["cfg"],
            "seed": settings["seed"],
            "sampler": "euler",
            "scheduler": "simple",
            "turbo": {"enabled": settings["turbo"], "profile": "turbo8_official"},
            "meta": {"source": "still_loop", "frame": frame_index, "attempt": attempt,
                     "mode": "t2i"},
        }
        submitted = self._request("POST", "/api/generate", payload, timeout=120.0)
        job_id = str(submitted.get("job_id") or "")
        if not job_id:
            raise MainProjectError(f"提交文生图任务失败：{submitted}")
        job = self.wait(job_id, on_progress)
        outputs = job.get("images") or []
        if not outputs:
            raise MainProjectError(f"任务 {job_id} 没有输出图片")
        output = outputs[0]
        url = str(output.get("url") or "")
        data = self.download(url)
        image = Image.open(io.BytesIO(data))
        image.load()
        return GeneratedImage(
            image=image,
            job_id=job_id,
            url=url,
            elapsed_ms=int(job.get("elapsed_ms") or 0),
            quality=job.get("quality") or {},
            align=job.get("align") or {},
            meta={"generator": "main", "prompt": prompt, "attempt": attempt,
                  "output": output, "model": settings.get("model"), "mode": "t2i"},
        )
