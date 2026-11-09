"""后台任务：单 worker 串行执行（生图与渲染互斥，避免抢显存/CPU）。

任务对象自带取消标志与进度，前端通过 ``GET /api/tasks`` 查看列表、
``GET /api/tasks/{id}`` 轮询单个任务。任务快照落盘到 ``_data/tasks.json``，
重启后仍能查到最近 100 条（运行中的标记为「已中断」）。
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .. import config
from .errors import CanceledError, StudioError

Runner = Callable[["Task"], Any]

#: 任务类型 → 默认标题
KIND_TITLE = {
    "prompts": "生成分镜提示词",
    "images": "批量生图",
    "image": "重新生成镜头",
    "render": "导出成片",
}

TERMINAL = ("done", "error", "canceled")


@dataclass
class Task:
    id: str
    kind: str
    project_id: str
    title: str = ""
    shot_id: str = ""
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

    def title_text(self) -> str:
        return self.title or KIND_TITLE.get(self.kind, self.kind)

    def to_dict(self) -> dict[str, Any]:
        elapsed = None
        if self.started_at is not None:
            end = self.finished_at if self.finished_at is not None else time.time()
            elapsed = int((end - self.started_at) * 1000)
        return {
            "id": self.id,
            "kind": self.kind,
            "projectId": self.project_id,
            "title": self.title_text(),
            "shotId": self.shot_id,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
            "errorCode": self.error_code,
            "createdAt": self.created_at,
            "createdAtText": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.created_at)),
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "elapsedMs": elapsed,
        }


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._queue: queue.Queue[tuple[Task, Runner]] = queue.Queue()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._load()

    # -- 对外 -------------------------------------------------------------
    def submit(self, kind: str, project_id: str, runner: Runner, *,
               title: str = "", shot_id: str = "") -> Task:
        task = Task(
            id=f"task-{uuid.uuid4().hex[:10]}",
            kind=kind,
            project_id=project_id,
            title=title,
            shot_id=shot_id,
        )
        with self._lock:
            self._tasks[task.id] = task
            self._trim()
            self._save()
        self._ensure_worker()
        self._queue.put((task, runner))
        return task

    def get(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def list_tasks(self, project_id: str = "", limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            tasks = list(self._tasks.values())
        if project_id:
            tasks = [task for task in tasks if task.project_id == project_id]
        tasks.sort(key=lambda task: task.created_at, reverse=True)
        return [task.to_dict() for task in tasks[:max(1, int(limit))]]

    def cancel(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is None or task.status in ("done", "error", "canceled"):
            return False
        task.cancel()
        with self._lock:
            if task.status == "queued":
                task.status = "canceled"
                task.finished_at = time.time()
            self._save()
        return True

    def active_for(self, project_id: str) -> list[dict[str, Any]]:
        return [task.to_dict() for task in self._tasks.values()
                if task.project_id == project_id and task.status in ("queued", "running")]

    # -- 内部 -------------------------------------------------------------
    def _tasks_path(self):
        return config.TASKS_FILE

    def _load(self) -> None:
        path = self._tasks_path()
        if not path.is_file():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for item in payload.get("tasks") or []:
            if not isinstance(item, dict):
                continue
            task_id = str(item.get("id") or "")
            if not task_id:
                continue
            task = Task(
                id=task_id,
                kind=str(item.get("kind") or ""),
                project_id=str(item.get("projectId") or ""),
                title=str(item.get("title") or ""),
                shot_id=str(item.get("shotId") or ""),
            )
            status = str(item.get("status") or "")
            # 上次进程退出时还在排队/运行的任务，内存队列无法恢复
            task.status = status if status in ("done", "error", "canceled") else "interrupted"
            task.progress = item.get("progress") or task.progress
            task.result = item.get("result")
            task.error = str(item.get("error") or "")
            if task.status == "interrupted" and not task.error:
                task.error = "服务重启，任务已中断，可重试"
            task.error_code = str(item.get("errorCode") or "")
            try:
                task.created_at = float(item.get("createdAt") or time.time())
            except (TypeError, ValueError):
                task.created_at = time.time()
            started = item.get("startedAt")
            finished = item.get("finishedAt")
            task.started_at = float(started) if started else None
            task.finished_at = float(finished) if finished else (
                time.time() if task.status != "queued" else None)
            self._tasks[task.id] = task
        self._trim()

    def _save(self) -> None:
        path = self._tasks_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            ordered = sorted(self._tasks.values(), key=lambda task: task.created_at)[-100:]
            payload = {"tasks": [task.to_dict() for task in ordered]}
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            pass

    def _trim(self) -> None:
        finished = [task for task in self._tasks.values()
                    if task.status not in ("queued", "running")]
        if len(finished) <= 100:
            return
        finished.sort(key=lambda item: item.created_at)
        for task in finished[: len(finished) - 100]:
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
                with self._lock:
                    self._save()
                continue
            task.status = "running"
            task.started_at = time.time()
            with self._lock:
                self._save()
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
                with self._lock:
                    self._save()
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
