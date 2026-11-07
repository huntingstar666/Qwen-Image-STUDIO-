"""核心算法单元测试：python -m unittest animation_kit.tests.test_core -v"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from animation_kit import config
from animation_kit.core import align, color, compose, encode, images, project, registry, sheet, timeline


def solid(size=(64, 64), rgba=(255, 255, 255, 255), background=(0, 0, 0, 0)) -> Image.Image:
    image = Image.new("RGBA", size, background)
    inset = max(1, min(8, min(size) // 4))
    ImageDraw.Draw(image).rectangle((inset, inset, size[0] - inset - 1, size[1] - inset - 1),
                                    fill=rgba)
    return image


def square_at(canvas=(96, 96), box=(10, 10, 26, 26), fill=(255, 255, 255, 255)) -> Image.Image:
    image = Image.new("RGBA", canvas, (0, 0, 0, 0))
    ImageDraw.Draw(image).rectangle(box, fill=fill)
    return image


class RegistryTests(unittest.TestCase):
    def test_frame_clamp_and_round(self):
        frame = registry.normalize_frame({"id": "a", "offsetX": 4.6, "hold": 0, "scale": 99,
                                          "opacity": -1, "rotation": 720})
        self.assertEqual(frame["offsetX"], 5)
        self.assertEqual(frame["hold"], 1)
        self.assertEqual(frame["scale"], 8.0)
        self.assertEqual(frame["opacity"], 0.0)
        self.assertEqual(frame["rotation"], 360.0)

    def test_doc_canvas_follows_first_frame(self):
        doc = registry.normalize_doc({"frames": [{"url": "/files/a.png", "width": 320, "height": 240}]})
        self.assertEqual(doc["canvas"]["width"], 320)
        self.assertEqual(doc["canvas"]["height"], 240)

    def test_export_options_clamp(self):
        options = registry.normalize_export("gif", {"colors": 999, "loop": -3, "minMs": 1})
        self.assertEqual(options["colors"], 256)
        self.assertEqual(options["loop"], 0)
        self.assertEqual(options["minMs"], 10)

    def test_unknown_enum_falls_back(self):
        frame = registry.normalize_frame({"origin": "alien"})
        self.assertEqual(frame["origin"], "upload")


class SheetTests(unittest.TestCase):
    def _grid(self, rows=4, columns=4, cell=32):
        width, height = columns * cell, rows * cell
        sheet_image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(sheet_image)
        for row in range(rows):
            for column in range(columns):
                left = column * cell
                top = row * cell
                draw.rectangle((left + 6, top + 6, left + 24, top + 24),
                               fill=(column * 40, row * 40, 128, 255))
        return sheet_image

    def test_split_4x4_union_keeps_size_and_alpha(self):
        result = sheet.split_sheet(self._grid(), rows=4, columns=4, trim="union")
        self.assertEqual(len(result.frames), 16)
        self.assertEqual(result.size, (19, 19))
        for frame in result.frames:
            self.assertEqual(frame.size, result.size)
            self.assertEqual(frame.mode, "RGBA")
            self.assertTrue(np.asarray(frame)[..., 3].max() > 0)

    def test_serpentine_order(self):
        result = sheet.split_sheet(self._grid(), rows=4, columns=4, trim="none",
                                   order="serpentine")
        self.assertEqual(result.order[:4], [0, 1, 2, 3])
        self.assertEqual(result.order[4:8], [7, 6, 5, 4])
        first_second_row = np.asarray(result.frames[4])
        self.assertEqual(int(first_second_row[..., 0].max()), 120)
        self.assertEqual(int(first_second_row[..., 1].max()), 40)

    def test_trim_each_and_none(self):
        each = sheet.split_sheet(self._grid(), rows=4, columns=4, trim="each")
        self.assertEqual(each.size, (19, 19))
        none = sheet.split_sheet(self._grid(), rows=4, columns=4, trim="none")
        self.assertEqual(none.size, (32, 32))

    def test_column_major(self):
        result = sheet.split_sheet(self._grid(), rows=4, columns=4, trim="none",
                                   order="column-major")
        self.assertEqual(result.order[:4], [0, 4, 8, 12])


class AlignTests(unittest.TestCase):
    def test_phase_shift_sign_and_compensation(self):
        frames_images = [
            square_at(box=(10, 10, 26, 26)),
            square_at(box=(14, 12, 30, 28)),
            square_at(box=(18, 10, 34, 26)),
        ]
        frames = [{"id": f"f{i}"} for i in range(3)]
        report = align.estimate_offsets(frames, frames_images, reference="first",
                                        max_shift=64, confidence=0)
        shifts = [(item.dx, item.dy) for item in report.shifts]
        self.assertEqual(shifts[0], (0, 0))
        self.assertEqual(shifts[1], (-4, -2))
        self.assertEqual(shifts[2], (-8, 0))

    def test_previous_mode_cumulative(self):
        frames_images = [
            square_at(box=(10, 10, 26, 26)),
            square_at(box=(12, 10, 28, 26)),
            square_at(box=(14, 10, 30, 26)),
        ]
        frames = [{"id": f"f{i}"} for i in range(3)]
        report = align.estimate_offsets(frames, frames_images, reference="previous",
                                        max_shift=64, confidence=0)
        self.assertEqual((report.shifts[1].dx, report.shifts[1].dy), (-2, 0))
        self.assertEqual((report.shifts[2].dx, report.shifts[2].dy), (-4, 0))

    def test_apply_offsets_does_not_mutate_input(self):
        frames = [{"id": "a", "offsetX": 0, "offsetY": 0}]
        report = align.AlignReport("first", 64, 0)
        report.shifts.append(align.Shift("a", 3, -2, 1.0, True))
        out = align.apply_offsets(frames, report)
        self.assertEqual(frames[0]["offsetX"], 0)
        self.assertEqual((out[0]["offsetX"], out[0]["offsetY"]), (3, -2))


class ColorTests(unittest.TestCase):
    def test_match_reduces_delta_and_preserves_alpha(self):
        base = solid((48, 48), (120, 140, 160, 255))
        darker = Image.new("RGBA", base.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(darker)
        draw.rectangle((8, 8, 39, 39), fill=(108, 128, 148, 255))
        matched, stats = color.match_frame({"id": "a"}, darker, base, strength=1.0, scope="subject")
        before = np.abs(np.asarray(darker, dtype=float)[..., :3]
                        - np.asarray(base, dtype=float)[..., :3]).mean()
        after = np.abs(np.asarray(matched, dtype=float)[..., :3]
                       - np.asarray(base, dtype=float)[..., :3]).mean()
        self.assertLess(after, before)
        np.testing.assert_array_equal(np.asarray(matched)[..., 3], np.asarray(darker)[..., 3])

    def test_deflicker_keeps_alpha_bytes(self):
        frames, images_list = [], []
        for delta in (0, 6, -4):
            image = solid((32, 32), (100 + delta, 110 + delta, 120 + delta, 255))
            frames.append({"id": f"f{delta}"})
            images_list.append(image)
        outputs, report = color.deflicker(frames, images_list, reference="first", strength=1.0)
        self.assertEqual(len(outputs), 3)
        for source, output in zip(images_list, outputs):
            np.testing.assert_array_equal(np.asarray(source)[..., 3], np.asarray(output)[..., 3])
        self.assertEqual(len(report.stats), 3)


class TimelineTests(unittest.TestCase):
    def _doc(self, holds, direction="forward", fps=10):
        return registry.normalize_doc({
            "timeline": {"fps": fps, "direction": direction},
            "frames": [{"id": f"f{i}", "url": "/files/x.png", "width": 8, "height": 8, "hold": hold}
                       for i, hold in enumerate(holds)],
        })

    def test_hold_expands_exposures(self):
        sequence = timeline.expanded_sequence(self._doc([2, 1, 3]))
        self.assertEqual(len(sequence), 6)
        self.assertEqual([item["duration"] for item in sequence], [100] * 6)
        self.assertEqual(timeline.summary(self._doc([2, 1, 3]))["durationMs"], 600)

    def test_pingpong(self):
        sequence = timeline.expanded_sequence(self._doc([1, 1, 1], direction="pingpong"))
        self.assertEqual([item["frameIndex"] for item in sequence], [0, 1, 2, 1])

    def test_gif_duration_rounding(self):
        seq = [{"duration": 33}, {"duration": 8}, {"duration": 125}]
        self.assertEqual(timeline.gif_durations(seq, min_ms=20), [30, 20, 130])


class ComposeTests(unittest.TestCase):
    def test_fast_path_is_byte_identical(self):
        source = solid((64, 64), (10, 20, 30, 255))
        frame = registry.normalize_frame({"id": "a", "url": "/x", "width": 64, "height": 64})
        rendered = compose.render_frame(frame, source, {"width": 64, "height": 64,
                                                        "fit": "contain", "anchor": "center"})
        self.assertFalse(rendered.resampled)
        self.assertEqual(rendered.image.tobytes(), source.tobytes())

    def test_integer_offset_places_exact_pixels(self):
        source = solid((16, 16), (255, 0, 0, 255))
        frame = registry.normalize_frame({"id": "a", "url": "/x", "width": 16, "height": 16,
                                          "offsetX": 10, "offsetY": 6})
        rendered = compose.render_frame(frame, source, {"width": 48, "height": 48,
                                                        "fit": "none", "anchor": "center"})
        array = np.asarray(rendered.image)
        self.assertEqual(tuple(array[6 + 10, 10 + 10]), (255, 0, 0, 255))
        self.assertFalse(rendered.resampled)

    def test_scale_marks_resampled(self):
        source = solid((16, 16))
        frame = registry.normalize_frame({"id": "a", "url": "/x", "width": 16, "height": 16,
                                          "scale": 2})
        rendered = compose.render_frame(frame, source, {"width": 64, "height": 64})
        self.assertTrue(rendered.resampled)


class EncodeTests(unittest.TestCase):
    def setUp(self):
        self.frames = []
        for index in range(4):
            image = Image.new("RGBA", (24, 24), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((4 + index * 3, 4, 12 + index * 3, 20),
                                            fill=(255, 100, 0, 200))
            self.frames.append(image)
        self.doc = registry.normalize_doc({
            "timeline": {"fps": 10},
            "canvas": {"width": 24, "height": 24},
            "frames": [{"id": f"f{i}", "url": f"/files/{i}.png", "width": 24, "height": 24}
                       for i in range(4)],
        })
        self.tmp = Path(tempfile.mkdtemp(prefix="anim-test-"))

    def _rendered(self):
        result = compose.RenderResult(frames={}, width=24, height=24)
        for i, image in enumerate(self.frames):
            result.frames[f"f{i}"] = compose.FrameRender(id=f"f{i}", image=image)
        return result

    def test_gif(self):
        out = encode.export_animation(self.doc, self._rendered(), "gif", {"colors": 64},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with Image.open(self.tmp / out["filename"]) as image:
            self.assertEqual(image.n_frames, 4)
            self.assertTrue(image.is_animated)
            image.seek(0)
            self.assertIn("transparency", image.info)

    def test_apng_lossless(self):
        out = encode.export_animation(self.doc, self._rendered(), "apng", {},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with Image.open(self.tmp / out["filename"]) as image:
            self.assertEqual(image.n_frames, 4)
            image.seek(2)
            self.assertEqual(image.convert("RGBA").size, (24, 24))
        self.assertTrue(out["pixel_exact"])

    def test_webp(self):
        out = encode.export_animation(self.doc, self._rendered(), "webp", {"lossless": True},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with Image.open(self.tmp / out["filename"]) as image:
            self.assertEqual(image.n_frames, 4)

    def test_sprite_sheet(self):
        out = encode.export_animation(self.doc, self._rendered(), "sprite-sheet",
                                      {"columns": 2, "padding": 2},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with Image.open(self.tmp / out["filename"]) as image:
            self.assertEqual(image.size, (50, 50))
            self.assertEqual(image.mode, "RGBA")
        atlas = json.loads((self.tmp / out["filename"]).with_suffix(".atlas.json").read_text("utf-8"))
        self.assertEqual(len(atlas["frames"]), 4)

    def test_png_sequence(self):
        out = encode.export_animation(self.doc, self._rendered(), "png-sequence", {},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with zipfile.ZipFile(self.tmp / out["filename"]) as archive:
            names = archive.namelist()
            self.assertIn("manifest.json", names)
            self.assertEqual(len([name for name in names if name.endswith(".png")]), 4)

    def test_holds_expand_output_frames(self):
        self.doc["frames"][0]["hold"] = 2
        out = encode.export_animation(self.doc, self._rendered(), "apng", {},
                                      out_dir=self.tmp, url_for=lambda p: "/files/" + p.name)
        with Image.open(self.tmp / out["filename"]) as image:
            self.assertEqual(image.n_frames, 5)


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="anim-project-"))
        self._saved = (config.DATA_DIR, config.PROJECTS_DIR, config.FRAMES_DIR,
                       config.EXPORTS_DIR, config.THUMBS_DIR)
        config.DATA_DIR = self.tmp
        config.PROJECTS_DIR = self.tmp / "projects"
        config.FRAMES_DIR = self.tmp / "frames"
        config.EXPORTS_DIR = self.tmp / "exports"
        config.THUMBS_DIR = self.tmp / "thumbs"
        config.ensure_dirs()

    def tearDown(self):
        (config.DATA_DIR, config.PROJECTS_DIR, config.FRAMES_DIR,
         config.EXPORTS_DIR, config.THUMBS_DIR) = self._saved

    def test_crud_and_frame(self):
        doc = project.create_doc("测试项目")
        saved = project.save_project(doc)
        loaded = project.load_project(saved["id"])
        self.assertEqual(loaded["name"], "测试项目")
        self.assertEqual(len(project.list_projects()), 1)
        frame = project.save_frame(saved["id"], images.encode_png(solid((8, 8))), stem="a")
        self.assertTrue(frame["url"].startswith("/files/frames/"))
        self.assertTrue(config.resolve_url(frame["url"]).is_file())
        self.assertTrue(project.delete_project(saved["id"]))
        self.assertEqual(project.list_projects(), [])


if __name__ == "__main__":
    unittest.main()
