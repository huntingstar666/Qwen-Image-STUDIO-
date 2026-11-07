"""Image super-resolution backends (FlashVSR / SeedVR2).

Public entry points are re-exported here so ``server.main`` only needs one
import.  Heavy machine-learning imports stay inside the runner modules so that
the FastAPI process can boot on machines without CUDA.
"""

from .flashvsr_runner import FlashVSREngine  # noqa: F401
from .base import UpscaleCancelled, UpscaleError  # noqa: F401

__all__ = ["FlashVSREngine", "UpscaleError", "UpscaleCancelled"]
