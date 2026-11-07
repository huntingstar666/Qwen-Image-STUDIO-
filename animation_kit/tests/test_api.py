"""接口冒烟测试：导入宫格 → 对齐 → 色彩 → 导出 → 读回。

运行：python -m unittest animation_kit.tests.test_api -v
"""
from __future__ import annotations

import base64
import io
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from animation_kit import config
from animation_kit.core import project
from animation_kit.server import jobs as jobs_module
from animation_kit.server.app import create_app


def data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def make_sheet(cell: int = 24) -> Image.Image:
    image = Image.new("RGBA", (cell * 4, cell * 4), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for row in range(4):
        for column in range(4):
            left = column * cell
            top = row * cell
            shift = (row * 4 + column) % 5
            draw.rectangle((left + 4 + shift, top + 5, left + 14 + shift, top + 18),
                           fill=(60 + column * 30, 80 + row * 20, 160, 255))
    return image


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient

        cls._saved = (config.DATA_DIR, config.PROJECTS_DIR, config.FRAMES_DIR,
                      config.EXPORTS_DIR, config.THUMBS_DIR)
        cls.tmp = Path(tempfile.mkdtemp(prefix="anim-api-"))
        config.DATA_DIR = cls.tmp
        config.PROJECTS_DIR = cls.tmp / "projects"
        config.FRAMES_DIR = cls.tmp / "frames"
        config.EXPORTS_DIR = cls.tmp / "exports"
        config.THUMBS_DIR = cls.tmp / "thumbs"
        jobs_module.HISTORY_PATH = cls.tmp / "jobs.json"
        config.ensure_dirs()
        cls.app = create_app()
        cls.client = TestClient(cls.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        (config.DATA_DIR, config.PROJECTS_DIR, config.FRAMES_DIR,
         config.EXPORTS_DIR, config.THUMBS_DIR) = cls._saved

    def test_01_health_and_options(self):
        health = self.client.get("/api/health").json()
        self.assertTrue(health["ok"])
        self.assertIn("gif", health["formats"])
        options = self.client.get("/api/options").json()
        self.assertIn("frame", options["fields"])
        self.assertIn("sprite-sheet", options["export_formats"])

    def test_02_import_sheet_and_crud(self):
        response = self.client.post("/api/import/sheet", json={
            "name": "宫格测试",
            "image": data_url(make_sheet()),
            "grid": {"rows": 4, "columns": 4, "trim": "union"},
        })
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        doc = payload["project"]
        self.assertEqual(len(doc["frames"]), 16)
        self.assertEqual(len(payload["frames"]), 16)
        self.assertEqual(doc["source"]["type"], "sheet")
        self.assertTrue(doc["canvas"]["width"] > 0)

        # 列表与详情
        items = self.client.get("/api/projects").json()["items"]
        self.assertTrue(any(item["id"] == doc["id"] for item in items))
        loaded = self.client.get(f"/api/projects/{doc['id']}").json()["project"]
        self.assertEqual(len(loaded["frames"]), 16)

        # 修改时间轴并保存
        loaded["timeline"]["fps"] = 8
        loaded["frames"][0]["hold"] = 3
        saved = self.client.put(f"/api/projects/{doc['id']}", json={"project": loaded}).json()["project"]
        self.assertEqual(saved["timeline"]["fps"], 8)
        self.assertEqual(saved["frames"][0]["hold"], 3)

        type(self).project_id = doc["id"]
        type(self).doc = saved

    def test_03_align(self):
        response = self.client.post("/api/align", json={
            "projectId": type(self).project_id, "reference": "first",
            "maxShift": 32, "confidence": 0,
        })
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(len(payload["report"]["shifts"]), 16)
        self.assertIn("jitter_before", payload["report"])
        type(self).doc = payload["project"]

    def test_04_color_match_and_revert(self):
        response = self.client.post("/api/color-match", json={
            "projectId": type(self).project_id, "reference": "first",
            "strength": 0.8, "scope": "subject",
        })
        self.assertEqual(response.status_code, 200, response.text)
        doc = response.json()["project"]
        self.assertTrue(all(frame["sourceUrl"] for frame in doc["frames"]))
        reverted = self.client.post("/api/color-match/revert",
                                    json={"projectId": type(self).project_id}).json()
        self.assertEqual(reverted["restored"], 16)
        type(self).doc = reverted["project"]

    def test_05_export_gif_and_readback(self):
        response = self.client.post("/api/export", json={
            "doc": type(self).doc, "format": "gif",
            "options": {"colors": 64, "transparent": True, "minMs": 20},
        })
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        deadline = time.time() + 60
        job = None
        while time.time() < deadline:
            job = self.client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in ("done", "error", "canceled"):
                break
            time.sleep(0.15)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "done", job)
        result = job["result"]
        self.assertTrue(result["url"].startswith("/files/exports/"))
        path = config.resolve_url(result["url"])
        self.assertTrue(path.is_file())
        self.assertEqual(result["exposure_count"], 18)
        self.assertIn(result["frame_count"], (16, 18))
        with Image.open(path) as image:
            self.assertEqual(image.n_frames, result["frame_count"])
            self.assertEqual(image.size, (int(type(self).doc["canvas"]["width"]),
                                         int(type(self).doc["canvas"]["height"])))

    def test_06_export_sprite_sheet(self):
        response = self.client.post("/api/export", json={
            "projectId": type(self).project_id, "format": "sprite-sheet",
            "options": {"columns": 4, "atlas": True},
        })
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()["job_id"]
        deadline = time.time() + 60
        job = None
        while time.time() < deadline:
            job = self.client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in ("done", "error", "canceled"):
                break
            time.sleep(0.15)
        self.assertEqual(job["status"], "done", job)
        self.assertTrue(job["result"]["atlas_url"].endswith(".atlas.json"))
        self.assertEqual(job["result"]["frame_count"], 16)

    def test_07_history_and_delete(self):
        history = self.client.get("/api/history").json()["items"]
        self.assertGreaterEqual(len(history), 2)
        deleted = self.client.delete(f"/api/projects/{type(self).project_id}")
        self.assertTrue(deleted.json()["ok"])
        self.assertEqual(self.client.get(f"/api/projects/{type(self).project_id}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
