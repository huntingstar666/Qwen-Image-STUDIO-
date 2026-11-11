from __future__ import annotations

import os
import tempfile
import unittest

os.environ.setdefault("STILL_LOOP_DATA", tempfile.mkdtemp(prefix="still-loop-test-"))

from PIL import Image, ImageDraw, ImageOps  # noqa: E402

from still_loop.core import checker, planner, runner, store  # noqa: E402
from still_loop.core.generator import MockGenerator  # noqa: E402


def _reference(size: int = 256) -> Image.Image:
    image = Image.new("RGB", (size, size), (235, 228, 214))
    draw = ImageDraw.Draw(image)
    draw.rectangle((size // 4, size // 4, size * 3 // 4, size * 3 // 4),
                   fill=(70, 110, 190))
    draw.ellipse((size // 3, size // 3, size * 2 // 3, size * 2 // 3),
                 fill=(240, 200, 120))
    return image


class PlannerTest(unittest.TestCase):
    def test_fallback_has_exact_count(self):
        settings = {"frames": 7, "preserve": ["人物身份", "背景"]}
        result = planner.plan("小人疯狂吃米饭", settings, llm="off")
        self.assertEqual(result["source"], "fallback")
        self.assertEqual(len(result["frames"]), 7)
        self.assertEqual([item["index"] for item in result["frames"]], list(range(1, 8)))
        for item in result["frames"]:
            self.assertIn("保持", item["edit"])
            self.assertLess(item["min_change"], item["max_change"])


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.settings = {
            "check": {"min_change": 0.002, "max_change": 0.35, "min_ssim": 0.40,
                      "max_mae": 55, "min_hist": 0.35, "min_loop_ssim": 0.35},
            "seamless": False,
            "preserve": ["人物身份"],
        }
        self.frame = {"min_change": 0.002, "max_change": 0.35}

    def test_identical_is_rejected(self):
        image = _reference()
        result = checker.check(image, image.copy(), self.frame, self.settings)
        self.assertEqual(result["verdict"], "fail")
        self.assertIn("too_small", result["reasons"])

    def test_inverted_is_rejected(self):
        image = _reference()
        inverted = ImageOps.invert(image)
        result = checker.check(image, inverted, self.frame, self.settings)
        self.assertEqual(result["verdict"], "fail")
        self.assertTrue({"too_large", "structure_broken", "color_jump"} &
                        set(result["reasons"]))

    def test_mild_change_passes(self):
        image = _reference()
        changed = image.crop((4, 4, 260, 260)).resize((256, 256))
        result = checker.check(image, changed, self.frame, self.settings)
        self.assertEqual(result["verdict"], "pass", result["reasons"])
        self.assertGreater(result["metrics"]["changed_ratio"], 0.002)


class RunnerTest(unittest.TestCase):
    def test_retry_once_then_review(self):
        reference = _reference()
        run = runner.create_run(reference, "小人吃米饭", {
            "frames": 4, "size": 256, "max_retries": 3, "seamless": False,
            "check": {"min_change": 0.002, "max_change": 0.35,
                      "min_ssim": 0.40, "max_mae": 55, "min_hist": 0.35},
        })
        runner.plan_run(run, llm="off")
        loaded = Image.open(store.run_dir(run["id"]) / "reference.png")
        loaded.load()
        generator = MockGenerator(loaded, run["settings"], fail_frames=(2,))
        result = runner.start_run(run, generator)
        self.assertEqual(result["status"], "review", result.get("error"))
        self.assertEqual(len(result["frames"]), 4)
        self.assertEqual(len(result["frames"][1]["attempts"]), 2)
        self.assertEqual(result["frames"][1]["attempts"][0]["verdict"], "fail")
        self.assertEqual(result["frames"][1]["attempts"][1]["verdict"], "pass")
        self.assertTrue((store.run_dir(run["id"]) / "report.html").is_file())
        runner.export_animation(result, fps=8)
        self.assertTrue((store.run_dir(run["id"]) / "anim.gif").is_file())


if __name__ == "__main__":
    unittest.main()
