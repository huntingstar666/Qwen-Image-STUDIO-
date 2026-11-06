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


def test_rejects_non_object_task():
    with pytest.raises(main.ApiError, match="task"):
        main._validate_edit_params({"task": "remove"})


def test_rejects_unknown_task_mode():
    with pytest.raises(main.ApiError, match="task.mode"):
        main._validate_edit_params({"task": {"mode": "inpaint"}})


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
