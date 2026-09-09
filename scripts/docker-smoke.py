#!/usr/bin/env python3
"""Offline Docker API/persistence smoke test in disposable, isolated volumes."""

import json
import os
import pathlib
import socket
import subprocess
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    project = "subsanywhere-smoke-" + uuid.uuid4().hex[:10]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    environment = {**os.environ, "SUBSANYWHERE_HTTP_PORT": str(port)}
    command = ["docker", "compose", "-p", project, "-f", str(ROOT / "compose.yaml")]

    def compose(*args, input=None):
        result = subprocess.run(
            [*command, *args], cwd=ROOT, env=environment, input=input,
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout.strip()

    def request(path, origin=None):
        headers = {"X-SubsAnywhere-Client": "extension-v1"}
        if origin:
            headers["Origin"] = origin
        query = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers)
        try:
            with urllib.request.urlopen(query, timeout=8) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    try:
        compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90", "subtitles")
        code, health = request("/health")
        assert code == 200 and health["ok"] and health["service"] == "subsanywhere", health
        assert compose("exec", "-T", "subtitles", "id", "-u") == "10001"
        origin = "chrome-extension://" + "a" * 32
        assert request("/api/subtitles/generated?video_id=invalid", origin)[0] == 400
        assert request("/api/subtitles/generated?video_id=rwnyaH6cTDE", "https://untrusted.example")[0] == 403
        assert request("/api/subtitles/generated?video_id=rwnyaH6cTDE", origin)[1]["status"] == "missing"
        # Explicit synthetic SRT fixture: this tests storage and pinyin, NOT ASR.
        compose("exec", "-T", "subtitles", "python", "-", input='''from pathlib import Path
from pinyin import convert_many_to_pinyin
assert convert_many_to_pinyin(["你好"])[0] == "nǐ hǎo"
path = Path("/data/subtitles/rwnyaH6cTDE/youtube-rwnyaH6cTDE-generated.srt")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("1\\n00:00:01,000 --> 00:00:02,000\\n你好\\n", encoding="utf-8")
''')
        code, ready = request("/api/subtitles/generated?video_id=rwnyaH6cTDE", origin)
        assert code == 200 and ready["status"] == "ready", ready
        assert "nǐ hǎo" in ready["srt"] and "你好" in ready["srt"], ready
        compose("restart", "subtitles")
        compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90", "subtitles")
        assert request("/api/subtitles/generated?video_id=rwnyaH6cTDE", origin)[1]["srt"] == ready["srt"]
        print("PASS: Docker health, non-root user, API validation, hostile-origin rejection, real pinyin conversion and SRT persistence across restart. No YouTube, AI or model downloads.")
        print(json.dumps(health, ensure_ascii=False))
    finally:
        # This project name is newly generated above. Never touch user volumes.
        compose("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
