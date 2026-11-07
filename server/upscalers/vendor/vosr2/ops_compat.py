"""Drop-in replacement for ``comfy.ops.disable_weight_init``.

Upstream VOSR2 builds its layers through ComfyUI's ops module. The members used
by the vendored models are ``Linear``, ``Conv2d`` and ``LayerNorm``; they map to
the plain ``torch.nn`` classes with identical ``state_dict`` keys and numerics.
ComfyUI's lazy/aimdo weight-init behaviour is not needed outside the host, so a
thin alias is enough (the remaining members are listed for API completeness).
"""
import torch


class _DisableWeightInit:
    Linear = torch.nn.Linear
    Conv2d = torch.nn.Conv2d
    ConvTranspose2d = torch.nn.ConvTranspose2d
    GroupNorm = torch.nn.GroupNorm
    LayerNorm = torch.nn.LayerNorm
    Embedding = torch.nn.Embedding

    @staticmethod
    def conv_nd(dims, *args, **kwargs):
        if dims == 1:
            return torch.nn.Conv1d(*args, **kwargs)
        if dims == 2:
            return torch.nn.Conv2d(*args, **kwargs)
        if dims == 3:
            return torch.nn.Conv3d(*args, **kwargs)
        raise ValueError(f"unsupported dimensions: {dims}")


disable_weight_init = _DisableWeightInit
