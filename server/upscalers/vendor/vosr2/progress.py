"""Replacement for ``comfy.utils.ProgressBar``.

Keeps the upstream call pattern (``update_absolute`` with a running counter) but
forwards ``(current, total)`` to an optional callback instead of driving the
ComfyUI web UI.
"""


class ProgressBar:
    def __init__(self, total: int, callback=None):
        self.total = total
        self.current = 0
        self.callback = callback

    def update_absolute(self, value, total=None):
        self.current = int(value)
        if self.callback:
            self.callback(self.current, total or self.total)
