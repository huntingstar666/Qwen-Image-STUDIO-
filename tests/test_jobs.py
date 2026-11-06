"""任务队列测试：进度、取消、历史落盘、进程中断恢复、单条删除。

不加载任何模型、不依赖 GPU，纯内存 + 临时目录。
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import time
import uuid

from server import config, jobs, pipeline


@contextlib.contextmanager
def _tmpdir():
    """普通目录（不用 tempfile.TemporaryDirectory）。

    它的 mkdtemp 会给目录设 0700 显式 ACL，Windows 沙箱下清理会 PermissionError，
    导致测试因为**收尾**失败而不是断言失败。
    """
    path = os.path.join(config.STORAGE_DIR, 'tmptests', uuid.uuid4().hex[:8])
    os.makedirs(path, exist_ok=True)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _queue(tmpdir: str) -> jobs.JobQueue:
    q = jobs.JobQueue(history_limit=10)
    q._history_path = os.path.join(tmpdir, "history.json")
    # 构造时会读真实 storage/history.json，这里清空，保证用例互不干扰
    with q._lock:
        q._jobs = {}
        q._order = []
    return q


def test_job_progress_and_done():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()

        def work(job):
            job.set_progress(1, 3, "第一步")
            job.bump_progress("第二步")
            job.images = [{"url": "/files/outputs/x.png", "width": 8, "height": 8}]

        job = q.submit("t2i", work, prompt="hello", params={"seed": 1})
        deadline = time.time() + 5
        while time.time() < deadline and job.status not in ("done", "error"):
            time.sleep(0.02)
        assert job.status == "done", job.error
        assert job.progress["value"] == 2
        assert job.progress["label"] == "第二步"
        assert job.images[0]["width"] == 8
        assert job.elapsed_ms() is not None and job.elapsed_ms() >= 0
        q.stop()


def test_job_error_is_recorded():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()

        def boom(job):
            raise ValueError("故意炸")

        job = q.submit("t2i", boom, prompt="x")
        # 等 finished_at（_finish 里最后写），避免读到 status 已变但 error 还没写的竞态
        deadline = time.time() + 15
        while time.time() < deadline and job.finished_at is None:
            time.sleep(0.01)
        assert job.finished_at is not None, f"任务未在 15s 内结束，status={job.status}"
        assert job.status == "error"
        assert "故意炸" in (job.error or "")
        assert job.traceback and "ValueError" in job.traceback
        q.stop()


def test_cancel_queued_job():
    """占住 worker，让第二个任务停在 queued，再取消它。"""
    import threading

    with _tmpdir() as tmp:
        q = _queue(tmp)
        release = threading.Event()

        def blocking(job):
            release.wait(timeout=5)

        first = q.submit("t2i", blocking, prompt="先占住 worker")
        deadline = time.time() + 5
        while time.time() < deadline and first.status != "running":
            time.sleep(0.01)
        assert first.status == "running", first.status

        second = q.submit("t2i", lambda j: None, prompt="排在后面")
        assert second.status == "queued", second.status
        assert q.cancel(second.id) is True
        assert second.cancel_requested is True
        assert second.status == "canceled"

        release.set()
        deadline = time.time() + 5
        while time.time() < deadline and first.status != "done":
            time.sleep(0.01)
        assert first.status == "done"

        # 已完成 / 不存在的记录不允许再取消
        assert q.cancel(first.id) is False
        assert q.cancel("不存在") is False
        q.stop()


def test_history_persisted_and_trimmed():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()
        ids = []
        for i in range(12):
            job = q.submit("t2i", lambda j: None, prompt=f"p{i}")
            ids.append(job.id)
        deadline = time.time() + 8
        while time.time() < deadline:
            if all((q.get(j) or jobs.Job(id=j, kind="t2i")).status == "done" for j in ids):
                break
            time.sleep(0.02)
        items = q.history(limit=50)
        assert len(items) <= 10, f"history_limit=10 生效，实际 {len(items)}"
        with open(q._history_path, encoding="utf-8") as fh:
            saved = json.load(fh)
        assert isinstance(saved, list) and saved
        assert all("id" in item and "status" in item for item in saved)
        q.stop()


def test_interrupted_jobs_marked_on_load():
    """进程崩溃遗留的 queued/running 记录，重启后必须标成 error 而不是消失。"""
    with _tmpdir() as tmp:
        path = os.path.join(tmp, "history.json")
        payload = [
            {"id": "abc", "kind": "t2i", "status": "running", "prompt": "跑到一半",
             "images": [], "params": {}, "meta": {}},
            {"id": "def", "kind": "edit", "status": "done", "prompt": "正常完成",
             "images": [{"url": "/files/outputs/a.png"}], "params": {}, "meta": {}},
        ]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)

        q = jobs.JobQueue(history_limit=10)
        q._history_path = path
        q._jobs = {}
        q._order = []
        q._load_history()

        interrupted = q.get("abc")
        assert interrupted is not None, "中断的任务不该消失"
        assert interrupted.status == "error"
        assert "中断" in (interrupted.error or "")
        finished = q.get("def")
        assert finished is not None and finished.status == "done"


def test_delete_single_history():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()
        job = q.submit("t2i", lambda j: None, prompt="x")
        deadline = time.time() + 5
        while time.time() < deadline and job.status not in ("done", "error"):
            time.sleep(0.02)
        assert q.delete(job.id) is True
        assert q.get(job.id) is None
        assert q.delete(job.id) is False
        q.stop()


def test_cancel_running_job_raises_jobcanceled():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()
        started = {"ok": False}

        def work(job):
            started["ok"] = True
            while True:
                job.check_cancel()
                time.sleep(0.01)

        job = q.submit("t2i", work, prompt="x")
        deadline = time.time() + 5
        while time.time() < deadline and not started["ok"]:
            time.sleep(0.01)
        q.cancel(job.id)
        deadline = time.time() + 5
        while time.time() < deadline and job.status != "canceled":
            time.sleep(0.01)
        assert job.status == "canceled", job.status
        assert job.error is None
        q.stop()


def test_stats_shape():
    with _tmpdir() as tmp:
        q = _queue(tmp)
        stats = q.stats()
        assert set(stats) >= {"pending", "running", "running_id", "queue_size", "history"}
        assert stats["pending"] == 0
        assert stats["running"] is False


def test_job_dict_hides_inline_image_data():
    """轮询接口不能回传 base64 图片：一张 4K 图就能让每 700ms 的轮询卡死。"""
    big = "data:image/png;base64," + "A" * 4096
    job = jobs.Job(id="x", kind="edit", prompt="p", params={
        "images": [{"name": "a.png", "data": big}],
        "mask": {"data": big},
        "seed": 42,
    })
    data = job.to_dict()

    assert data["params"]["images"][0]["data"] == "<inline data omitted>"
    assert data["params"]["images"][0]["name"] == "a.png"
    assert data["params"]["mask"]["data"] == "<inline data omitted>"
    assert data["params"]["seed"] == 42
    # 原参数不被改写，管线/回放仍拿得到完整数据
    assert job.params["images"][0]["data"] == big


def test_finished_job_drops_inline_binary():
    """任务结束后释放 base64 图片，历史常驻不再占几十 MB 内存。"""
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()
        big = "data:image/png;base64," + "A" * 4096
        job = q.submit("edit", lambda j: None, prompt="x", params={"images": [big]})
        deadline = time.time() + 5
        while time.time() < deadline and job.finished_at is None:
            time.sleep(0.02)
        assert job.finished_at is not None
        assert job.params["images"][0] == "<inline data omitted>"
        q.stop()


def test_business_error_drops_class_prefix():
    """用户看到的错误不该带 ``PipelineError:`` 前缀。"""
    with _tmpdir() as tmp:
        q = _queue(tmp)
        q.start()

        def _boom(_job):
            raise pipeline.PipelineError("显存不足：请降低编辑画布后重试")

        job = q.submit("edit", _boom)
        deadline = time.time() + 5
        while time.time() < deadline and job.finished_at is None:
            time.sleep(0.02)
        assert job.status == "error"
        assert job.error == "显存不足：请降低编辑画布后重试"
        q.stop()
