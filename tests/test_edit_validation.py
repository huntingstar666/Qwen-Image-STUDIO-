"""`/api/edit` 参数边界校验：非法参数在入队前就返回 400，不等到采样时炸。"""
from __future__ import annotations

import pytest

from server import main


def test_valid_payload_passes():
    main._validate_edit_params({
        "size_mode": "follow",
        "preprocess": {"enabled": True, "max_side": 2048, "mode": "downscale_only"},
        "task": {"mode": "remove"},
        "loras": [{"preset": "remove"}, {"name": "custom.safetensors", "strength": 0.5}],
        "zero_shift": {"enabled": True, "snap": 32, "resolution": 0},
    })


def test_empty_payload_passes():
    main._validate_edit_params({})


def test_rejects_unknown_size_mode():
    with pytest.raises(main.ApiError, match="size_mode"):
        main._validate_edit_params({"size_mode": "zoom"})


def test_rejects_non_object_preprocess():
    with pytest.raises(main.ApiError, match="preprocess"):
        main._validate_edit_params({"preprocess": "on"})


def test_rejects_preprocess_max_side_out_of_range():
    with pytest.raises(main.ApiError, match="max_side"):
        main._validate_edit_params({"preprocess": {"enabled": True, "max_side": 128}})
    with pytest.raises(main.ApiError, match="max_side"):
        main._validate_edit_params({"preprocess": {"enabled": True, "max_side": 16384}})


def test_rejects_preprocess_max_side_not_integer():
    with pytest.raises(main.ApiError, match="max_side"):
        main._validate_edit_params({"preprocess": {"enabled": True, "max_side": "big"}})


def test_rejects_unknown_preprocess_mode():
    with pytest.raises(main.ApiError, match="preprocess.mode"):
        main._validate_edit_params({"preprocess": {"enabled": True, "mode": "upscale"}})


def test_rejects_preprocess_min_side_over_max_side():
    with pytest.raises(main.ApiError, match="min_side"):
        main._validate_edit_params({
            "preprocess": {"enabled": True, "max_side": 1024, "min_side": 2048}})


def test_rejects_bad_preprocess_multiple():
    with pytest.raises(main.ApiError, match="multiple"):
        main._validate_edit_params({"preprocess": {"enabled": True, "multiple": "x"}})
    with pytest.raises(main.ApiError, match="multiple"):
        main._validate_edit_params({"preprocess": {"enabled": True, "multiple": 3}})


def test_rejects_bad_sampling_params():
    with pytest.raises(main.ApiError, match="steps"):
        main._validate_edit_params({"steps": "many"})
    with pytest.raises(main.ApiError, match="steps"):
        main._validate_edit_params({"steps": 0})
    with pytest.raises(main.ApiError, match="cfg"):
        main._validate_edit_params({"cfg": "high"})
    with pytest.raises(main.ApiError, match="denoise"):
        main._validate_edit_params({"denoise": 0})
    with pytest.raises(main.ApiError, match="采样器"):
        main._validate_edit_params({"sampler": "magic"})
    with pytest.raises(main.ApiError, match="调度器"):
        main._validate_edit_params({"scheduler": "magic"})


def test_rejects_bad_lora_strength():
    with pytest.raises(main.ApiError, match="strength"):
        main._validate_edit_params({"loras": [{"strength": "strong"}]})
    with pytest.raises(main.ApiError, match="strength"):
        main._validate_edit_params({"loras": [{"strength": 3}]})


def test_remove_allows_empty_prompt():
    """remove 的训练指令由后端补，第三方只传 task.mode + 遮罩也能直接出图。"""
    original = main._submit
    calls = []

    def _fake_submit(kind, payload, *, prompt):
        calls.append((kind, prompt))
        return {"job_id": "test", "status": "pending"}

    main._submit = _fake_submit
    try:
        result = main.api_edit({
            "images": [{"data": "data:image/png;base64,QUJD"}],
            "mask": "data:image/png;base64,QUJD",
            "task": {"mode": "remove"},
        })
    finally:
        main._submit = original

    assert result["status"] == "pending"
    assert calls == [("edit", "")]


def test_plain_edit_still_requires_prompt():
    with pytest.raises(main.ApiError, match="编辑指令"):
        main.api_edit({"images": [{"data": "data:image/png;base64,QUJD"}]})


def test_rejects_non_object_task():
    with pytest.raises(main.ApiError, match="task"):
        main._validate_edit_params({"task": "remove"})


def test_rejects_unknown_task_mode():
    with pytest.raises(main.ApiError, match="task.mode"):
        main._validate_edit_params({"task": {"mode": "zoom"}})


def test_rejects_non_list_loras():
    with pytest.raises(main.ApiError, match="loras"):
        main._validate_edit_params({"loras": "remove"})


def test_rejects_non_object_lora_item():
    with pytest.raises(main.ApiError, match="loras"):
        main._validate_edit_params({"loras": ["remove"]})


def test_rejects_unknown_lora_preset():
    with pytest.raises(main.ApiError, match="预设"):
        main._validate_edit_params({"loras": [{"preset": "upscale"}]})


def test_rejects_non_object_zero_shift():
    with pytest.raises(main.ApiError, match="zero_shift"):
        main._validate_edit_params({"zero_shift": True})


def test_accepts_frontend_task_aliases():
    """detectTask 会产出 inpaint / replace，后端必须放行。"""
    main._validate_edit_params({"task": {"mode": "inpaint"}})
    main._validate_edit_params({"task": {"mode": "replace"}})


def test_rejects_non_object_outpaint():
    with pytest.raises(main.ApiError, match="outpaint"):
        main._validate_edit_params({"outpaint": [10, 10]})


def test_rejects_outpaint_percent_out_of_range():
    with pytest.raises(main.ApiError, match="outpaint.left"):
        main._validate_edit_params({"outpaint": {"left": -1}})
    with pytest.raises(main.ApiError, match="outpaint.right"):
        main._validate_edit_params({"outpaint": {"right": 250}})


def test_rejects_outpaint_non_numeric():
    with pytest.raises(main.ApiError, match="outpaint.top"):
        main._validate_edit_params({"outpaint": {"top": "多"}})


def test_accepts_panorama_payload():
    main._validate_edit_params({
        "task": {"mode": "panorama"},
        "panorama": {"aspect": "3:1", "long_side": 3072,
                     "wrap": True, "seam_blend": 32},
    })


def test_rejects_non_object_panorama():
    with pytest.raises(main.ApiError, match="panorama"):
        main._validate_edit_params({"panorama": ["2:1"]})


def test_rejects_unknown_panorama_aspect():
    with pytest.raises(main.ApiError, match="panorama.aspect"):
        main._validate_edit_params({"panorama": {"aspect": "16:9"}})


def test_rejects_panorama_long_side_out_of_range():
    with pytest.raises(main.ApiError, match="panorama.long_side"):
        main._validate_edit_params({"panorama": {"long_side": 512}})
    with pytest.raises(main.ApiError, match="panorama.long_side"):
        main._validate_edit_params({"panorama": {"long_side": 5000}})


def test_rejects_panorama_wrap_and_seam_blend():
    with pytest.raises(main.ApiError, match="panorama.wrap"):
        main._validate_edit_params({"panorama": {"wrap": "yes"}})
    with pytest.raises(main.ApiError, match="panorama.seam_blend"):
        main._validate_edit_params({"panorama": {"seam_blend": 256}})


def test_rejects_unknown_local_scheme():
    with pytest.raises(main.ApiError, match="local.scheme"):
        main._validate_edit_params({"local": {"scheme": "c"}})


def test_rejects_local_numeric_out_of_range():
    with pytest.raises(main.ApiError, match="local.feather"):
        main._validate_edit_params({"local": {"feather": -4}})
    with pytest.raises(main.ApiError, match="local.mask_expand"):
        main._validate_edit_params({"local": {"mask_expand": "多"}})
    with pytest.raises(main.ApiError, match="local.context_factor"):
        main._validate_edit_params({"local": {"context_factor": 9}})


def test_rejects_mask_wrong_type():
    with pytest.raises(main.ApiError, match="mask"):
        main._validate_edit_params({"mask": 123})


def test_edit_endpoint_rejects_image_without_data():
    with pytest.raises(main.ApiError, match=r"images\[1\]"):
        main.api_edit({"prompt": "换成蓝天", "images": [{}]})


def test_edit_endpoint_accepts_url_entry():
    """走 /api/upload 后引用 /files/ 路径是合法用法，不能误判为缺数据。"""
    with pytest.raises(main.ApiError, match="未知"):
        # 结构合法（有 url），因此会走到参数校验；用一个非法参数证明已越过图片检查
        main.api_edit({
            "prompt": "换成蓝天",
            "images": [{"url": "/files/uploads/up-1.png"}],
            "size_mode": "zoom",
        })


def test_edit_endpoint_rejects_oversized_inline_image():
    old = main.MAX_INLINE_IMAGE_CHARS
    main.MAX_INLINE_IMAGE_CHARS = 16
    try:
        with pytest.raises(main.ApiError, match="过大"):
            main.api_edit({
                "prompt": "换成蓝天",
                "images": [{"data": "data:image/png;base64," + "A" * 32}],
            })
    finally:
        main.MAX_INLINE_IMAGE_CHARS = old
