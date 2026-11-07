"""单 worker 任务队列：导出这种重活异步跑，前端轮询进度。

与主项目 ``server/jobs.py`` 保持同一套语义：

* 串行执行（导出会吃满内存/CPU，串行最稳）；
* 进度、取消、错误、历史落盘；
* 进程被硬杀后，重启时把未完成任务标成「中断」。
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

from .. import config
from ..core.errors import AnimationCanceled

HISTORY_PATH = config.DATA_DIR / "jobs.json"


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued|running|done|error|canceled
    params: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=lambda: {"value": 0, "max": 1, "label": ""})
    result: dict[str, Any] | None = None
    error: str | None = None
    traceback: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False

    def set_progress(self, value: int, maximum: int | None = None, label: str | None = None) -> None:
        self.progress = {
            "value": int(value),
            "max": int(maximum if maximum is not None else self.progress.get("max", 1)),
            "label": label if label is not None else self.progress.get("label", ""),
        }

    def check_cancel(self) -> None:
        if self.cancel_requested:
            raise AnimationCanceled()

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
            "result": self.result,
            "params": self.params,
            "meta": self.meta,
            "error": self.error,
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
            "result": self.result,
            "meta": self.meta,
            "error": self.error,
            "elapsed_ms": self.elapsed_ms(),
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.created_at)),
        }


class JobQueue:
    def __init__(self, history_limit: int = 40) -> None:
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._fns: dict[str, Callable[[Job], None]] = {}
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None
        self._running_id: str | None = None
        self._history_limit = max(1, int(history_limit))
        self._load_history()

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._loop, name="anim-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._queue.put("")
        if self._worker:
            self._worker.join(timeout=2.0)

    def _loop(self) -> None:
        while True:
            try:
                self._run_one()
            except BaseException as exc:  # noqa: BLE001 - worker 不能死
                print(f"[anim] worker 循环异常：{type(exc).__name__}: {exc}", flush=True)

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
            self._finish(job, "canceled")
            self._queue.task_done()
            return

        job.status = "running"
        job.started_at = time.time()
        self._running_id = job.id
        self._save_history()
        try:
            fn(job)
            if job.status == "running":
                job.status = "done"
        except AnimationCanceled:
            job.status = "canceled"
            job.error = None
        except Exception as exc:  # noqa: BLE001
            job.error = f"{type(exc).__name__}: {exc}"
            job.traceback = "".join(traceback.format_exc())[-4000:]
            job.status = "error"
        finally:
            self._running_id = None
            self._finish(job, None)
            self._queue.task_done()

    def _finish(self, job: Job, status: str | None) -> None:
        if status:
            job.status = status
        job.finished_at = time.time()
        with self._lock:
            if job.id not in self._order:
                self._order.append(job.id)
            self._trim_locked()
        self._save_history()

    def _trim_locked(self) -> None:
        finished = [jid for jid in self._order
                    if self._jobs.get(jid) and self._jobs[jid].status in ("done", "error", "canceled")]
        excess = len(finished) - self._history_limit
        for jid in finished[:max(0, excess)]:
            self._jobs.pop(jid, None)
            try:
                self._order.remove(jid)
            except ValueError:
                pass

    def submit(self, kind: str, fn: Callable[[Job], None], *,
               params: dict[str, Any] | None = None,
               meta: dict[str, Any] | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:16], kind=kind, params=params or {}, meta=meta or {})
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._fns[job.id] = fn
        self._queue.put(job.id)
        if self._worker is None or not self._worker.is_alive():
            self.start()
        self._save_history()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status in ("done", "error", "canceled"):
                return False
            job.cancel_requested = True
            if job.status == "queued":
                job.status = "canceled"
            self._fns.pop(job_id, None)
        return True

    def history(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            ids = list(reversed(self._order))
        items = []
        for jid in ids:
            job = self._jobs.get(jid)
            if job is None:
                continue
            items.append(job.to_summary())
            if len(items) >= max(1, int(limit)):
                break
        return items

    def stats(self) -> dict[str, Any]:
        with self._lock:
            pending = sum(1 for job in self._jobs.values() if job.status == "queued")
            running = self._running_id
            total = len(self._jobs)
        return {"pending": pending, "running": running is not None,
                "running_id": running, "queue_size": self._queue.qsize(), "history": total}

    def _save_history(self) -> None:
        try:
            with self._lock:
                payload = [self._jobs[jid].to_summary() for jid in self._order if jid in self._jobs]
            HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = str(HISTORY_PATH) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(tmp, HISTORY_PATH)
        except Exception:  # noqa: BLE001 - 历史落盘失败不影响导出
            pass

    def _load_history(self) -> None:
        if not HISTORY_PATH.is_file():
            return
        try:
            with open(HISTORY_PATH, "r", encoding="utf-8") as handle:
                items = json.load(handle)
        except (OSError, ValueError):
            return
        if not isinstance(items, list):
            return
        for item in reversed(items):
            try:
                job = Job(
                    id=str(item.get("id") or uuid.uuid4().hex[:16]),
                    kind=str(item.get("kind") or "export"),
                    params={},
                    meta=item.get("meta") or {},
                )
                job.status = str(item.get("status") or "done")
                job.result = item.get("result")
                job.error = item.get("error")
                if job.status in ("queued", "running"):
                    job.status = "error"
                    job.error = "服务重启：该任务未完成"
                elapsed = item.get("elapsed_ms")
                if isinstance(elapsed, (int, float)):
                    job.started_at = job.created_at
                    job.finished_at = job.created_at + float(elapsed) / 1000.0
                self._jobs[job.id] = job
                self._order.append(job.id)
            except Exception:  # noqa: BLE001
                continue
        with self._lock:
            self._trim_locked()
