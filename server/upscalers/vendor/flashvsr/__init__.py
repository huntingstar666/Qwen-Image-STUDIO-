"""FlashVSR 1.1 vendored runtime.

Layout mirrors the original TE-Speed-FlashVSR custom node so that the relative
import ``from ...te_runtime.attention import ...`` inside
``flashvsr_core/models/wan_video_dit.py`` keeps working unchanged:

    vendor/flashvsr/
        flashvsr_core/
        te_runtime/

The original ``nodes.pyd`` wrapper (which depends on ComfyUI) is intentionally
not vendored; this project calls ``flashvsr_core`` directly.
"""
