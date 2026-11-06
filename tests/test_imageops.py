"""图像处理（裁剪/宫格/旋转/缩放/调色/32 对齐）单元测试。

纯 CPU、不加载模型；用 PIL 现造图片，跑完即删。
"""
from __future__ import annotations

import io
import os
import shutil
import uuid

from PIL import Image

from server import config, imageops


def _tmp_out() -> str:
    path = os.path.join(config.OUTPUT_DIR, "tmptest-" + uuid.uuid4().hex[:8])
    os.makedirs(path, exist_ok=True)
    return path


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _scene(w: int = 800, h: int = 600) -> Image.Image:
    im = Image.new("RGB", (w, h), (240, 236, 228))
    for x in range(0, w, 40):
        im.paste((60 + x % 120, 90, 120), (x, 0, min(x + 20, w), h // 3))
    im.paste((200, 120, 80), (w // 3, h // 3, w * 2 // 3, h * 2 // 3))
    return im


def test_crop_returns_exact_size():
    out, applied = imageops.apply_ops(_png(_scene()), [{"op": "crop", "x": 100, "y": 50,
                                                        "width": 300, "height": 200}])
    assert applied == ["crop"]
    assert len(out) == 1
    assert out[0].size == (300, 200)


def test_crop_clamps_out_of_range():
    out, _ = imageops.apply_ops(_png(_scene()), [{"op": "crop", "x": 700, "y": 500,
                                                  "width": 500, "height": 500}])
    assert out[0].size == (100, 100)


def test_crop_invalid_raises():
    # 宽高 <= 0 / 非数字 才非法；超界坐标会被收敛成图内 1px，不算错
    for spec in ({"op": "crop", "x": 0, "y": 0, "width": 0, "height": 10},
                 {"op": "crop", "x": 0, "y": 0, "width": "abc", "height": 10},
                 {"op": "crop", "x": 0, "y": 0, "width": 10, "height": -5}):
        try:
            imageops.apply_ops(_png(_scene()), [spec])
        except imageops.ImageOpsError:
            continue
        raise AssertionError(f"应当报错：{spec}")


def test_grid_split_count_and_cells():
    out, applied = imageops.apply_ops(_png(_scene(600, 600)),
                                      [{"op": "grid", "rows": 2, "columns": 3}])
    assert applied == ["grid"]
    assert len(out) == 6
    assert all(cell.size == (200, 300) for cell in out)


def test_grid_with_gaps():
    out, _ = imageops.apply_ops(_png(_scene(640, 640)),
                                [{"op": "grid", "rows": 2, "columns": 2,
                                  "row_gap": 20, "column_gap": 20}])
    assert len(out) == 4
    assert out[0].size == (310, 310)


def test_rotate_and_flip():
    src = _png(_scene(400, 200))
    out, _ = imageops.apply_ops(src, [{"op": "rotate", "angle": 90}])
    assert out[0].size == (200, 400)
    out2, _ = imageops.apply_ops(src, [{"op": "flip", "horizontal": True}])
    assert out2[0].size == (400, 200)
    # 水平翻转必须真的改变像素
    a = list(Image.open(io.BytesIO(src)).convert("RGB").getdata())[:10]
    b = list(out2[0].convert("RGB").getdata())[-10:]
    assert a != b


def test_resize_three_fits():
    src = _png(_scene(400, 200))
    contain, _ = imageops.apply_ops(src, [{"op": "resize", "width": 300, "height": 300,
                                           "fit": "contain"}])
    assert contain[0].size == (300, 300)
    cover, _ = imageops.apply_ops(src, [{"op": "resize", "width": 300, "height": 300,
                                         "fit": "cover"}])
    assert cover[0].size == (300, 300)
    stretch, _ = imageops.apply_ops(src, [{"op": "resize", "width": 300, "height": 300,
                                          "fit": "stretch"}])
    assert stretch[0].size == (300, 300)


def test_resize_rejects_huge():
    try:
        imageops.apply_ops(_png(_scene()), [{"op": "resize", "width": 99999, "height": 10}])
    except imageops.ImageOpsError:
        return
    raise AssertionError("超大尺寸应当报错")


def test_adjust_changes_pixels_and_keeps_size():
    src = _png(_scene(320, 240))
    out, _ = imageops.apply_ops(src, [{"op": "adjust", "brightness": 1.4, "contrast": 1.2,
                                       "saturation": 1.5, "temperature": 0.6}])
    assert out[0].size == (320, 240)
    before = Image.open(io.BytesIO(src)).convert("RGB")
    assert list(before.getdata()) != list(out[0].convert("RGB").getdata())


def test_adjust_temperature_warms_image():
    src = _png(Image.new("RGB", (32, 32), (128, 128, 128)))
    warm, _ = imageops.apply_ops(src, [{"op": "adjust", "temperature": 1.0}])
    r, _g, b = warm[0].convert("RGB").getpixel((16, 16))
    assert r > 128 and b < 128, f"暖色应当抬红压蓝，实际 {(r, b)}"


def test_pad32_aligns_up():
    out, _ = imageops.apply_ops(_png(_scene(1000, 750)), [{"op": "pad32"}])
    assert out[0].width % 32 == 0 and out[0].height % 32 == 0
    assert out[0].size == (1024, 768)


def test_trim_alpha():
    im = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    im.paste((255, 0, 0, 255), (50, 60, 150, 160))
    out, _ = imageops.apply_ops(_png(im), [{"op": "trim_alpha", "padding": 0}])
    assert out[0].size == (100, 100)


def test_unknown_op_raises():
    try:
        imageops.apply_ops(_png(_scene()), [{"op": "不存在的操作"}])
    except imageops.ImageOpsError:
        return
    raise AssertionError("未知操作应当报错")


def test_process_saves_outputs():
    folder = _tmp_out()
    try:
        result = imageops.process(_png(_scene(400, 300)), {
            "ops": [{"op": "crop", "x": 0, "y": 0, "width": 200, "height": 200}],
            "format": "png",
        })
        assert result["ok"] and result["count"] == 1
        item = result["images"][0]
        assert item["width"] == 200 and item["height"] == 200
        assert item["url"].startswith("/files/outputs/")
        # 文件确实落盘
        from server import storage as st

        assert os.path.isfile(st.resolve_storage_path(item["relpath"]))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_process_jpeg_quality():
    result = imageops.process(_png(_scene(400, 300)), {
        "ops": [], "format": "jpeg", "quality": 70, "prefix": "jpegtest",
    })
    item = result["images"][0]
    assert item["filename"].endswith(".jpg")
    with open(os.path.join(config.STORAGE_DIR, item["relpath"]), "rb") as fh:
        assert fh.read(2) == b"\xff\xd8"  # JPEG SOI


def test_outpaint_plan_right():
    plan = imageops.outpaint_plan(1024, 1024, direction="right", amount=0.5)
    assert plan["pad"]["left"] == 0 and plan["pad"]["right"] == 512
    assert plan["canvas"]["w"] % 32 == 0 and plan["canvas"]["h"] % 32 == 0
    assert plan["canvas"]["w"] == 1536 and plan["canvas"]["h"] == 1024
    assert plan["offset"] == {"x": 0, "y": 0}


def test_outpaint_plan_all_sides():
    plan = imageops.outpaint_plan(1000, 800, direction="all", amount=0.25)
    assert plan["pad"]["left"] == 250 and plan["pad"]["right"] == 250
    assert plan["pad"]["top"] == 200 and plan["pad"]["bottom"] == 200
    assert plan["canvas"]["w"] % 32 == 0 and plan["canvas"]["h"] % 32 == 0
    assert plan["offset"] == {"x": 250, "y": 200}


def test_outpaint_plan_clamps_amount():
    plan = imageops.outpaint_plan(100, 100, direction="right", amount=99)
    assert plan["amount"] <= 2.0
