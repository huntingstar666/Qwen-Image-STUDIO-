"""Discovery and strict loading of a VOSR 2.0 bundle.

A bundle is a self-contained folder under a caller-supplied root -- VOSR 2.0
is a fixed DiT/VAE/DINOv2 triple (see the layout comment below), so the three
pieces are not independently selectable and live together:

    <root>/<bundle>/
        args.json
        checkpoints/ema_model.safetensors            (or clean_weights/, or bundle root)
        Qwen-Image-vae-2d/{config.json, diffusion_pytorch_model.safetensors}
        dinov2_vitl14.safetensors

This is a vendored copy of ComfyUI-VOSR2's loader with the ComfyUI host glue
removed: no ``comfy.*``/``folder_paths`` imports, no Hugging Face
auto-download, and a minimal ``_Patcher`` stands in for
``comfy.model_patcher.ModelPatcher`` (models are built on CPU and moved to the
compute device on first use). Missing files raise ``VOSR2LoadError`` naming the
missing file.

The ``name`` argument is re-joined against ``root`` via ``_safe_child_dir``,
never taken as -- or resolved through -- an arbitrary path.
"""
import gc
import json
import re
from pathlib import Path

import torch
from safetensors import safe_open

from .models.dinov2 import build_dinov2_vitl14
from .models.lightningdit import LightningDiT
from .models.qwenimage_vae2d import AutoencoderKLQwenImage2D

# VOSR 2.0 is one indivisible artifact: the DiT runs entirely in *this* Qwen 2D
# VAE's latent space (its channel count, scale factor, and per-channel
# latents_mean/std), and is conditioned on *this* DINOv2-L feature extractor.
# None of the three can be swapped independently, so they live together inside a
# single bundle folder rather than in shared vae/ and clip_vision/ trees. A
# bundle is a subdirectory of the root laid out as:
#     <bundle>/args.json
#     <bundle>/checkpoints/ema_model.safetensors      (or clean_weights/, or bundle root)
#     <bundle>/Qwen-Image-vae-2d/{config.json,diffusion_pytorch_model.safetensors}
#     <bundle>/dinov2_vitl14.safetensors
_VAE_SUBDIR = "Qwen-Image-vae-2d"       # diffusers VAE dir inside the bundle
_VAE_FILES = ("config.json", "diffusion_pytorch_model.safetensors")
_VISION_FILENAME = "dinov2_vitl14.safetensors"  # converted DINOv2-L, inside the bundle

# Required args.json values for a VOSR 2.0 (one-step 1.4B) checkpoint. See
# VOSR2.md "Author confirmation" -- these fields are confirmed to have no
# effect, or to be architecturally fixed, for this specific release.
REQUIRED_ARGS = {
    "ae_type": "qwen",
    "dim": 1536,
    "depth": 36,
    "num_heads": 24,
    "patch_size": 2,
    "enc_type": "dinov2l",
    "enc_dim": 1024,
    "layer_dinov2b_list": [17],
    "auxiliary_time_cond": False,
    "distill_type": "onestep",
}

# DiT construction params that must be present in args.json but whose value is
# taken from the checkpoint rather than pinned by REQUIRED_ARGS.
DIT_ARG_KEYS = ("mlp_ratio", "use_qknorm", "use_swiglu", "use_rope", "use_rmsnorm", "encdim_ratio", "resolution")

# Known training-only key patterns that may be present in an EMA/distillation
# checkpoint but have no corresponding module in the inference-only LightningDiT
# above (e.g. an EMA wrapper's step counter). Extend this list, don't relax
# strict loading, if a real checkpoint surfaces another such key.
_TRAINING_ONLY_KEY_PATTERNS = (
    re.compile(r"^n_averaged$"),
    re.compile(r"^step_count$"),
    re.compile(r"^decay$"),
)
_STRIPPABLE_PREFIXES = ("module.", "_orig_mod.", "ema_model.")


class VOSR2LoadError(RuntimeError):
    """Raised for any missing file, incompatible config, or malformed state dict."""


def _safe_child_dir(root: Path, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise VOSR2LoadError(f"Invalid VOSR2 selection: {name!r}")
    candidate = (root / name).resolve()
    root_resolved = root.resolve()
    if root_resolved not in candidate.parents and candidate != root_resolved:
        raise VOSR2LoadError(f"Invalid VOSR2 selection: {name!r}")
    return candidate


def list_bundles(root: Path) -> list[str]:
    root = Path(root)
    if not root.is_dir():
        return []
    return sorted(
        p.name for p in root.iterdir()
        if p.is_dir() and (p / "args.json").is_file()
    )


def _load_args_json(bundle_dir: Path) -> dict:
    args_path = bundle_dir / "args.json"
    if not args_path.is_file():
        raise VOSR2LoadError(f"VOSR2 model bundle at {bundle_dir} is missing args.json.")
    with open(args_path, "r") as f:
        args = json.load(f)

    for key, expected in REQUIRED_ARGS.items():
        actual = args.get(key)
        if actual != expected:
            raise VOSR2LoadError(
                f"VOSR2 model bundle at {bundle_dir} has an incompatible config: "
                f"expected {key}={expected!r}, got {actual!r}. VOSR2 v1 supports only "
                f"the VOSR 2.0 one-step 1.4B checkpoint."
            )
    missing = [k for k in DIT_ARG_KEYS if k not in args]
    if missing:
        raise VOSR2LoadError(
            f"VOSR2 model bundle at {bundle_dir}'s args.json is missing required field(s): {missing}."
        )
    return args


def _find_dit_weight(bundle_dir: Path):
    for candidate in (
        bundle_dir / "clean_weights" / "ema_model.safetensors",
        bundle_dir / "checkpoints" / "ema_model.safetensors",
        bundle_dir / "ema_model.safetensors",
    ):
        if candidate.is_file():
            return candidate
    return None


def _resolve_dit_weight_path(bundle_dir: Path) -> Path:
    weight = _find_dit_weight(bundle_dir)
    if weight is None:
        raise VOSR2LoadError(
            f"No ema_model.safetensors found under {bundle_dir} "
            f"(looked in clean_weights/, checkpoints/, and the bundle root)."
        )
    return weight


def _strip_key(key: str) -> str | None:
    """Apply the prefix-stripping / drop rules to one checkpoint key.

    Returns the cleaned key, or ``None`` if this key should be dropped (a known
    training-only artifact with no corresponding module, e.g. an EMA wrapper's
    step counter).
    """
    stripped = key
    for prefix in _STRIPPABLE_PREFIXES:
        if stripped.startswith(prefix):
            stripped = stripped[len(prefix):]
            break
    if any(pattern.match(stripped) for pattern in _TRAINING_ONLY_KEY_PATTERNS):
        return None
    return stripped


def _load_state_dict_lean(module: torch.nn.Module, path: Path, dtype: torch.dtype, source: Path) -> None:
    """Stream a safetensors checkpoint into `module`, then assign it in one shot.

    This goes through ``nn.Module.load_state_dict`` rather than a manual
    ``setattr`` per key so submodule hooks are honoured. ``assign=True`` takes
    the loaded tensor directly instead of cloning it, and reading + casting one
    tensor at a time off the safetensors mmap (rather than eager ``load_file()``)
    means the checkpoint is never resident a second time in its original dtype,
    so peak RAM stays roughly the model at its final dtype.
    """
    sd: dict[str, torch.Tensor] = {}
    with safe_open(str(path), framework="pt", device="cpu") as f:
        for key in f.keys():
            stripped = _strip_key(key)
            if stripped is None:
                continue
            sd[stripped] = f.get_tensor(key).to(dtype)

    missing, unexpected = module.load_state_dict(sd, strict=False, assign=True)
    if missing or unexpected:
        raise VOSR2LoadError(
            f"VOSR2 checkpoint at {source} does not match the expected {type(module).__name__} "
            f"architecture (missing={missing}, unexpected={unexpected})."
        )
    del sd
    gc.collect()


def _resolve_dtype(dtype: str, device) -> torch.dtype:
    if dtype == "fp16":
        return torch.float16
    if dtype == "bf16":
        return torch.bfloat16
    if dtype == "default":
        # 取代 comfy.model_management.unet_dtype(device=device)：cuda 用 bf16，cpu 用 fp32。
        return torch.bfloat16 if device.type == "cuda" else torch.float32
    raise VOSR2LoadError(f"Unknown dtype option: {dtype!r}")


class _Patcher:
    """Minimal stand-in for ``comfy.model_patcher.ModelPatcher``.

    Only two things are used downstream: ``.model`` and ``.load_device``
    (``_load`` moves the module there on first use); ``offload_device`` is kept
    for interface parity.
    """

    def __init__(self, model, load_device, offload_device=None):
        self.model = model
        self.load_device = load_device
        self.offload_device = offload_device or torch.device("cpu")


class VOSR2Model:
    """Runtime bundle: independently offloadable DiT/VAE/vision-encoder plus config.

    Exposes narrow operations (`vision_features`, `encode`, `denoise_one_step`,
    `decode`) rather than the raw modules, so callers never need to probe for
    capabilities on the wrapped components.
    """

    def __init__(self, dit_patcher, vae_patcher, vision_patcher, args: dict):
        self.dit_patcher = dit_patcher
        self.vae_patcher = vae_patcher
        self.vision_patcher = vision_patcher
        self.args = args
        self.vision_layer_index = args["layer_dinov2b_list"][0]
        self.dinov2_size = args.get("dinov2_size", 448)

    def _load(self, patcher):
        # 取代 comfy.model_management.load_models_gpu(...)：模型构造时留在 CPU，
        # 首次使用时再整体搬到 compute device（之后的调用是 no-op）。
        return patcher.model.to(patcher.load_device), patcher.load_device

    def vision_features(self, lq_bchw_01: torch.Tensor) -> list:
        """lq_bchw_01: (B, 3, H, W) in [0, 1]. Returns a one-item list (fixed-index layer)."""
        model, device = self._load(self.vision_patcher)
        x = torch.nn.functional.interpolate(lq_bchw_01, size=(self.dinov2_size, self.dinov2_size), mode="bicubic").clamp(0.0, 1.0)
        mean = torch.tensor((0.485, 0.456, 0.406), device=device, dtype=x.dtype).view(1, 3, 1, 1)
        std = torch.tensor((0.229, 0.224, 0.225), device=device, dtype=x.dtype).view(1, 3, 1, 1)
        x = (x.to(device) - mean) / std
        feats = model.forward_intermediate_layer(x.to(model.pos_embed.dtype), self.vision_layer_index)
        return [feats]

    def encode(self, x_bchw_neg1_1: torch.Tensor):
        from . import tiled_vae
        model, device = self._load(self.vae_patcher)
        return tiled_vae.encode_latent(model, x_bchw_neg1_1.to(device))

    def encode_tiled(self, x_bchw_neg1_1: torch.Tensor, tile_size: int, tile_overlap: int):
        from . import tiled_vae
        model, device = self._load(self.vae_patcher)
        return tiled_vae.encode_dispatch(model, x_bchw_neg1_1.to(device), tile_size, tile_overlap)

    def decode(self, latent: torch.Tensor, latents_mean, latents_std) -> torch.Tensor:
        from . import tiled_vae
        model, device = self._load(self.vae_patcher)
        return tiled_vae.decode_latent(model, latent.to(device), latents_mean, latents_std)

    def decode_tiled(self, latent: torch.Tensor, latents_mean, latents_std, tile_size: int, tile_overlap: int) -> torch.Tensor:
        from . import tiled_vae
        model, device = self._load(self.vae_patcher)
        return tiled_vae.decode_dispatch(model, latent.to(device), latents_mean, latents_std, tile_size, tile_overlap)

    def dit_velocity(self, inp: torch.Tensor, t_cur: float, t_next: float, venc_fea: list) -> torch.Tensor:
        """Single DiT forward: predicted flow velocity for `inp = cat([lq_latent, z], dim=1)`."""
        model, device = self._load(self.dit_patcher)
        compute_dtype = model.t_embedder.mlp[0].weight.dtype
        inp = inp.to(device=device, dtype=compute_dtype)
        venc_fea = [f.to(device=device, dtype=compute_dtype) for f in venc_fea]
        b = inp.shape[0]
        t_cur_t = torch.full((b,), t_cur, device=device, dtype=compute_dtype)
        t_next_t = torch.full((b,), t_next, device=device, dtype=compute_dtype)
        return model.forward_flexible(inp, t_cur_t, t_next_t, venc_fea)

    def denoise_one_step(self, lq_latent: torch.Tensor, noise: torch.Tensor, venc_fea: list) -> torch.Tensor:
        """One Euler flow-matching update from t=1 to t=0 (VOSR2 is a one-step model)."""
        device = self.dit_patcher.load_device
        z = noise.to(device)
        u = self.dit_velocity(torch.cat([lq_latent.to(device), z], dim=1), 1.0, 0.0, venc_fea)
        return z - u


def load_vosr2(root: Path, name: str, dtype: str = "default", device: torch.device | None = None) -> VOSR2Model:
    root = Path(root)
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = torch.device(device)

    bundle_dir = _safe_child_dir(root, name)
    if not bundle_dir.is_dir():
        raise VOSR2LoadError(f"VOSR2 model bundle not found: {name!r} (under {root})")
    args = _load_args_json(bundle_dir)
    dit_weight_path = _resolve_dit_weight_path(bundle_dir)

    # The VAE and vision encoder are part of the bundle -- VOSR 2.0 is a fixed
    # DiT/VAE/DINOv2 triple, not independently selectable components.
    vae_dir = bundle_dir / _VAE_SUBDIR
    missing_vae = [f"{_VAE_SUBDIR}/{fn}" for fn in _VAE_FILES if not (vae_dir / fn).is_file()]
    if missing_vae:
        raise VOSR2LoadError(
            f"VOSR2 bundle {bundle_dir} is missing its Qwen-Image 2D VAE "
            f"({', '.join(missing_vae)}). The VAE's latent space is tied to this DiT "
            f"and cannot be substituted."
        )

    vision_path = bundle_dir / _VISION_FILENAME
    if not vision_path.is_file():
        raise VOSR2LoadError(
            f"VOSR2 bundle {bundle_dir} is missing its DINOv2-L encoder ({vision_path})."
        )

    load_device = device
    offload_device = torch.device("cpu")
    compute_dtype = _resolve_dtype(dtype, load_device)

    # Node execute() methods run under ComfyUI's torch.inference_mode() upstream,
    # and constructing a module there is unsafe: tensors created while
    # inference_mode is active don't register as ordinary nn.Parameters, so
    # named_parameters()/load_state_dict() silently sees only a fraction of the
    # model and every Linear weight/bias comes back "unexpected". Construction
    # and checkpoint loading need real, autograd-trackable parameters regardless
    # of the caller's inference_mode state, so do both inside an explicit
    # inference_mode(False) scope.
    with torch.inference_mode(False):
        base_channels = 16  # Qwen 2D VAE latent channels
        # 上游依赖 comfy.ops 的懒初始化，构造时不真正分配权重；纯 torch.nn 会立刻
        # 分配，因此临时把默认 dtype 设为 compute dtype，避免先多占一份 fp32 权重。
        prev_default_dtype = torch.get_default_dtype()
        try:
            torch.set_default_dtype(compute_dtype)
            dit = LightningDiT(
                input_size=args["resolution"] // 8,
                patch_size=args["patch_size"],
                in_channels=2 * base_channels,
                out_channels=base_channels,
                hidden_size=args["dim"],
                depth=args["depth"],
                num_heads=args["num_heads"],
                mlp_ratio=args["mlp_ratio"],
                z_dims=args["enc_dim"],
                encdim_ratio=args["encdim_ratio"],
                auxiliary_time_cond=args["auxiliary_time_cond"],
                use_qknorm=args["use_qknorm"],
                use_swiglu=args["use_swiglu"],
                use_rope=args["use_rope"],
                use_rmsnorm=args["use_rmsnorm"],
                num_fused_layers=len(args["layer_dinov2b_list"]),
            )
        finally:
            torch.set_default_dtype(prev_default_dtype)
        _load_state_dict_lean(dit, dit_weight_path, compute_dtype, dit_weight_path)
        # .to() is a no-op for tensors already at compute_dtype (everything the
        # checkpoint covered); this only touches whatever _load_state_dict_lean
        # didn't -- e.g. non-persistent buffers absent from the checkpoint.
        dit = dit.eval().to(compute_dtype)
        for p in dit.parameters():
            p.requires_grad_(False)

        vae = AutoencoderKLQwenImage2D.from_pretrained(str(vae_dir))
        vae = vae.eval().float()  # Qwen VAE runs in fp32; see VOSR2.md "Device, dtype, and memory".
        for p in vae.parameters():
            p.requires_grad_(False)

        vision_encoder = build_dinov2_vitl14()
        _load_state_dict_lean(vision_encoder, vision_path, compute_dtype, vision_path)
        vision_encoder = vision_encoder.eval().to(compute_dtype)
        for p in vision_encoder.parameters():
            p.requires_grad_(False)

    # 取代 comfy.model_patcher.ModelPatcher：模型保留在 CPU，_load() 时再上卡。
    dit_patcher = _Patcher(dit, load_device=load_device, offload_device=offload_device)
    vae_patcher = _Patcher(vae, load_device=load_device, offload_device=offload_device)
    vision_patcher = _Patcher(vision_encoder, load_device=load_device, offload_device=offload_device)

    return VOSR2Model(dit_patcher, vae_patcher, vision_patcher, args)
