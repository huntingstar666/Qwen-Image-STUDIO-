"""任务队列：单 worker 串行执行（显存不允许并发），带进度、取消与历史落盘。

为什么串行：Qwen-Image 2.1 一套权重（unet+clip+vae）约 16GB 显存，
同卡并发两个任务会 OOM，也可能互相挤掉权重导致反复换进换出。
所以队列固定 1 个 worker，前端靠轮询 `/api/jobs/{id}` 拿进度。
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from . import config

# --------------------------------------------------------------------------- 数据结构


@dataclass
class Job:
    """一次生成任务。`fn(job)` 在 worker 线程里执行，通过 job.set_progress 上报进度。"""

    id: str
    kind: str                                   # "t2i" | "edit"
    prompt: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    status: str = "queued"                      # queued|running|done|error|canceled
    progress: dict[str, Any] = field(default_factory=lambda: {"value": 0, "max": 1, "label": ""})
    images: list[dict[str, Any]] = field(default_factory=list)
    align: dict[str, Any] | None = None
    quality: dict[str, Any] | None = None
    error: str | None = None
    traceback: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False

    # -- 由执行函数调用 -----------------------------------------------------
    def set_progress(self, value: int, maximum: int | None = None, label: str | None = None) -> None:
        self.progress = {
            "value": int(value),
            "max": int(maximum if maximum is not None else self.progress.get("max", 1)),
            "label": label if label is not None else self.progress.get("label", ""),
        }

    def bump_progress(self, label: str | None = None) -> None:
        self.set_progress(min(self.progress["value"] + 1, self.progress["max"]), label=label)

    @property
    def canceled(self) -> bool:
        return self.cancel_requested

    def check_cancel(self) -> None:
        """执行函数在关键节点调用；已请求取消则抛 JobCanceled。"""
        if self.cancel_requested:
            raise JobCanceled()

    # -- 序列化 -------------------------------------------------------------
    def elapsed_ms(self) -> int | None:
        if self.started_at is None:
            return None
        end = self.finished_at if self.finished_at is not None else time.time()
        return int((end - self.started_at) * 1000)

    def to_dict(self, *, verbose: bool = True) -> dict[str, Any]:
        data = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "images": self.images,
            "align": self.align,
            "quality": self.quality,
            "error": self.error,
            "prompt": self.prompt,
            "params": self.params,
            "meta": self.meta,
            "elapsed_ms": self.elapsed_ms(),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.created_at)),
        }
        if verbose and self.traceback:
            data["traceback"] = self.traceback
        return data

    def to_summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "prompt": (self.prompt or "")[:200],
            "images": self.images,
            "params": {
                k: self.params.get(k)
                for k in ("width", "height", "steps", "cfg", "seed", "turbo", "model")
                if k in self.params
            },
            "meta": self.meta,
            "align": self.align,
            "quality": self.quality,
            "error": self.error,
            "elapsed_ms": self.elapsed_ms(),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.created_at)),
        }


class JobCanceled(Exception):
    """任务被用户取消。"""


# --------------------------------------------------------------------------- 队列


class JobQueue:
    def __init__(self, history_limit: int | None = None) -> None:
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        self._running_id: str | None = None
        self._fns: dict[str, Callable[[Job], None]] = {}
        self._history_limit = history_limit or config.load_config()["history_limit"]
        self._history_path = os.path.join(config.STORAGE_DIR, "history.json")
        self._last_activity = time.time()
        self._load_history()

    def last_activity(self) -> float:
        """最近一次任务提交 / 结束的时间戳（供空闲自动卸载显存使用）。"""
        return self._last_activity

    # -- 生命周期 -----------------------------------------------------------
    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._loop, name="q2i-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        # 放入哨兵让 worker 退出
        self._queue.put("")
        if self._worker:
            self._worker.join(timeout=2.0)

    def _loop(self) -> None:
        while True:
            try:
                self._run_one()
            except BaseException as exc:  # noqa: BLE001 - worker 线程绝不能死
                # 这里只在 _run_one 自身出错（例如内部状态异常）时兜底：
                # 记日志继续消费队列，避免整个队列永久卡死。
                print(f"[jobs] WARN worker 循环异常，已忽略并继续：{type(exc).__name__}: {exc}",
                      flush=True)

    def _run_one(self) -> None:
        job_id = self._queue.get()
        if not job_id:
            self._queue.task_done()
            return
        with self._lock:
            job = self._jobs.get(job_id)
            fn = self._fns.pop(job_id, None)
        if job is None or fn is None:
            self._queue.task_done()
            return
        if job.cancel_requested:
            self._finish(job, status="canceled")
            self._queue.task_done()
            return

        job.status = "running"
        job.started_at = time.time()
        self._running_id = job.id
        self._save_history()  # 先落盘「正在跑」，进程若被硬杀重启后能标成中断
        try:
            fn(job)
            if job.status == "running":
                job.status = "done"
        except JobCanceled:
            job.status = "canceled"
            job.error = None
        except Exception as exc:  # noqa: BLE001 - 任务失败要落库给前端看
            # 注意顺序：先把 error/traceback 写全，最后才改 status。
            # 否则轮询方可能在 status=error 的瞬间读到 error=None（偶发竞态）。
            job.error = f"{type(exc).__name__}: {exc}"
            job.traceback = "".join(traceback.format_exc())[-4000:]
            job.status = "error"
        finally:
            self._running_id = None
            self._finish(job, status=None)
            self._queue.task_done()

    def _finish(self, job: Job, *, status: str | None) -> None:
        if status:
            job.status = status
        job.finished_at = time.time()
        self._last_activity = job.finished_at
        with self._lock:
            if job.id not in self._order:
                self._order.append(job.id)
            self._trim_history_locked()
        self._save_history()

    def _trim_history_locked(self) -> None:
        # 只裁剪已结束任务，保留正在跑的
        finished = [
            jid for jid in self._order
            if self._jobs.get(jid) and self._jobs[jid].status in ("done", "error", "canceled")
        ]
        excess = len(finished) - self._history_limit
        if excess > 0:
            for jid in finished[:excess]:
                self._jobs.pop(jid, None)
                try:
                    self._order.remove(jid)
                except ValueError:
                    pass

    # -- 提交与查询 ---------------------------------------------------------
    def submit(self, kind: str, fn: Callable[[Job], None], *, prompt: str = "",
               params: dict[str, Any] | None = None,
               meta: dict[str, Any] | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], kind=kind, prompt=prompt,
                  params=params or {}, meta=meta or {})
        self._last_activity = time.time()
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._fns[job.id] = fn
        self._queue.put(job.id)
        self._ensure_worker()
        # 立刻落盘：万一下一刻进程被 OOM/CUDA 崩溃带走，重启后还能看到这条记录
        self._save_history()
        return job

    def _ensure_worker(self) -> None:
        """看门狗：worker 线程若意外死亡（极少见，如被 kill），下次提交时自动拉起。"""
        if self._worker is None or not self._worker.is_alive():
            self.start()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status in ("done", "error", "canceled"):
                return False
            job.cancel_requested = True
            job.status = "canceled" if job.status == "queued" else job.status
            self._fns.pop(job_id, None)
        return True

    def history(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            ids = list(reversed(self._order))
        items: list[dict[str, Any]] = []
        for jid in ids:
            job = self._jobs.get(jid)
            if job is None:
                continue
            items.append(job.to_summary())
            if len(items) >= limit:
                break
        return items

    def clear_history(self) -> None:
        with self._lock:
            keep = {}
            for jid in self._order:
                job = self._jobs.get(jid)
                if job and job.status in ("queued", "running"):
                    keep[jid] = job
            self._jobs = keep
            self._order = list(keep.keys())
        self._save_history()

    def delete(self, job_id: str) -> bool:
        """删除单条历史（正在跑的任务不允许删）。"""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job.status in ("queued", "running"):
                return False
            self._jobs.pop(job_id, None)
            try:
                self._order.remove(job_id)
            except ValueError:
                pass
        self._save_history()
        return True

    def stats(self) -> dict[str, Any]:
        with self._lock:
            pending = sum(1 for j in self._jobs.values() if j.status == "queued")
            running = self._running_id
        return {
            "pending": pending,
            "running": running is not None,
            "running_id": running,
            "queue_size": self._queue.qsize(),
            "history": len(self._jobs),
        }

    # -- 历史落盘 -----------------------------------------------------------
    def _save_history(self) -> None:
        """把**所有**任务（含 queued/running）落盘。

        这样即使进程被 OOM / CUDA 崩溃直接带走，重启后也能看到那条「跑到一半」的记录，
        并在 _load_history 里标成「中断」，而不是凭空消失。
        """
        try:
            with self._lock:
                payload = [
                    self._jobs[jid].to_summary()
                    for jid in self._order
                    if jid in self._jobs
                ]
            os.makedirs(config.STORAGE_DIR, exist_ok=True)
            tmp = self._history_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            os.replace(tmp, self._history_path)
        except Exception:
            pass  # 历史落盘失败不影响出图

    def _load_history(self) -> None:
        if not os.path.isfile(self._history_path):
            return
        try:
            with open(self._history_path, "r", encoding="utf-8") as fh:
                items = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(items, list):
            return
        interrupted = 0
        for item in reversed(items):  # 老的在前，便于 _order 顺序
            try:
                job = Job(
                    id=str(item.get("id") or uuid.uuid4().hex[:16]),
                    kind=str(item.get("kind") or "t2i"),
                    prompt=str(item.get("prompt") or ""),
                    params=item.get("params") or {},
                    meta=item.get("meta") or {},
                )
                job.status = str(item.get("status") or "done")
                job.images = item.get("images") or []
                job.align = item.get("align")
                job.quality = item.get("quality")
                job.error = item.get("error")
                # 上次进程退出时还没跑完的任务 → 标成中断（内存队列无法跨进程恢复）
                if job.status in ("queued", "running"):
                    job.status = "error"
                    job.error = ("服务重启/进程中断：该任务未完成"
                                 "（若进程曾无征兆退出，多为显存耗尽或 CUDA 上下文崩溃）")
                    interrupted += 1
                elapsed = item.get("elapsed_ms")
                if isinstance(elapsed, (int, float)):
                    job.started_at = job.created_at
                    job.finished_at = job.created_at + float(elapsed) / 1000.0
                self._jobs[job.id] = job
                self._order.append(job.id)
            except Exception:
                continue
        if interrupted:
            print(f"[jobs] 发现 {interrupted} 条上次未完成的任务，已标记为中断", flush=True)
            self._save_history()
        with self._lock:
            self._trim_history_locked()
