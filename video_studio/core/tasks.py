"""后台任务：单 worker 串行执行（生图与渲染互斥，避免抢显存/CPU）。

任务对象自带取消标志与进度，前端通过 ``GET /api/tasks/{id}`` 轮询。
"""
from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .errors import CanceledError, StudioError

Runner = Callable[["Task"], Any]


@dataclass
class Task:
    id: str
    kind: str
    project_id: str
    status: str = "queued"
    progress: dict[str, Any] = field(default_factory=lambda: {"value": 0, "max": 100, "label": ""})
    result: Any = None
    error: str = ""
    error_code: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def cancel(self) -> None:
        self._cancel.set()

    def canceled(self) -> bool:
        return self._cancel.is_set()

    def set_progress(self, value: int, label: str = "") -> None:
        self.progress = {"value": int(value), "max": 100, "label": label}

    def bump(self, label: str = "") -> None:
        self.set_progress(min(100, int(self.progress.get("value") or 0) + 1), label)

    def to_dict(self) -> dict[str, Any]:
        elapsed = None
        if self.started_at is not None:
            end = self.finished_at if self.finished_at is not None else time.time()
            elapsed = int((end - self.started_at) * 1000)
        return {
            "id": self.id,
            "kind": self.kind,
            "projectId": self.project_id,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
            "errorCode": self.error_code,
            "elapsedMs": elapsed,
        }


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._queue: queue.Queue[tuple[Task, Runner]] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None

    # -- 对外 -------------------------------------------------------------
    def submit(self, kind: str, project_id: str, runner: Runner) -> Task:
        task = Task(id=f"task-{uuid.uuid4().hex[:10]}", kind=kind, project_id=project_id)
        with self._lock:
            self._tasks[task.id] = task
            self._trim()
        self._ensure_worker()
        self._queue.put((task, runner))
        return task

    def get(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def cancel(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is None or task.status in ("done", "error", "canceled"):
            return False
        task.cancel()
        if task.status == "queued":
            task.status = "canceled"
            task.finished_at = time.time()
        return True

    def active_for(self, project_id: str) -> list[dict[str, Any]]:
        return [task.to_dict() for task in self._tasks.values()
                if task.project_id == project_id and task.status in ("queued", "running")]

    # -- 内部 -------------------------------------------------------------
    def _trim(self) -> None:
        finished = [task for task in self._tasks.values()
                    if task.status in ("done", "error", "canceled")]
        if len(finished) <= 40:
            return
        finished.sort(key=lambda item: item.finished_at or 0)
        for task in finished[: len(finished) - 40]:
            self._tasks.pop(task.id, None)

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._loop, name="video-studio-task", daemon=True)
        self._worker.start()

    def _loop(self) -> None:
        while True:
            task, runner = self._queue.get()
            if task.canceled():
                task.status = "canceled"
                task.finished_at = time.time()
                continue
            task.status = "running"
            task.started_at = time.time()
            try:
                task.result = runner(task)
                task.status = "done"
            except CanceledError as exc:
                task.status = "canceled"
                task.error = str(exc)
                task.error_code = exc.code
            except StudioError as exc:
                task.status = "error"
                task.error = str(exc)
                task.error_code = exc.code
            except Exception as exc:  # 兜底：任务线程不能静默死掉
                task.status = "error"
                task.error = f"{type(exc).__name__}: {exc}"
                task.error_code = "internal"
            finally:
                task.finished_at = time.time()
                self._queue.task_done()


_manager: TaskManager | None = None
_guard = threading.Lock()


def manager() -> TaskManager:
    global _manager
    if _manager is None:
        with _guard:
            if _manager is None:
                _manager = TaskManager()
    return _manager
