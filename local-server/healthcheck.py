#!/usr/bin/env python3
"""Container liveness probe; optional ASR models do not affect liveness."""

import json
import os
import sys
import urllib.request


def main() -> None:
    try:
        port = int(os.environ.get("SUBSANYWHERE_PORT", "43817"))
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
            payload = json.loads(response.read(65536))
        if payload.get("ok") is not True or payload.get("service") != "subsanywhere" or payload.get("api_version") != 1:
            raise ValueError("Unexpected service response")
    except Exception:
        print("Subtitle service health check failed", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
