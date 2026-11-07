"""Shared types for the upscaling backends."""

from __future__ import annotations


class UpscaleError(RuntimeError):
    """Raised when an upscaling backend cannot run (missing model, OOM, ...)."""


class UpscaleCancelled(RuntimeError):
    """Raised when the caller asked to abort an in-flight upscale job."""
