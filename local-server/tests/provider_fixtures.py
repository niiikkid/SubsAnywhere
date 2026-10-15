"""Offline-only injected provider for service/ASR tests."""
from pathlib import Path

SRT = "1\n00:00:00,000 --> 00:00:01,000\nCaptions\n"


class FakeProvider:
    configured = True

    def __init__(self, error=None, contents=None):
        self.error = error
        self.contents = contents
        self.calls = []

    def acquire(self, video, language, kind, target, *, cancel, limit):
        self.calls.append((video, language, kind, Path(target)))
        cancel()
        if self.error:
            raise self.error
        data = self.contents if self.contents is not None else (b"fLaC offline fixture" if kind == "audio" else SRT.encode())
        Path(target).write_bytes(data)
        return Path(target)
