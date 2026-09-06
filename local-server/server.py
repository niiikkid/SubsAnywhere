#!/usr/bin/env python3
"""Local subtitle service used by the SubsAnywhere extension."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator
from urllib.parse import parse_qs, urlparse

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 43817


def validate_video_id(value: str) -> str:
    video_id = str(value or "")
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID")
    return video_id


@dataclass(frozen=True)
class OutputPaths:
    directory: Path
    audio: Path
    youtube_srt: Path
    generated_srt: Path
    generated_txt: Path
    generated_markdown: Path

    def __iter__(self) -> Iterator[Path]:
        return iter((
            self.directory,
            self.audio,
            self.youtube_srt,
            self.generated_srt,
            self.generated_txt,
            self.generated_markdown,
        ))


def output_paths(root: Path, video_id: str) -> OutputPaths:
    safe_id = validate_video_id(video_id)
    directory = Path(root).expanduser().resolve() / safe_id
    prefix = f"youtube-{safe_id}"
    return OutputPaths(
        directory=directory,
        audio=directory / f"{prefix}-audio.mp3",
        youtube_srt=directory / f"{prefix}-youtube.srt",
        generated_srt=directory / f"{prefix}-generated.srt",
        generated_txt=directory / f"{prefix}-generated.txt",
        generated_markdown=directory / f"{prefix}-generated.timestamps.md",
    )


class SubtitleService:
    def __init__(
        self,
        output_root: Path,
        run_command=subprocess.run,
        yt_dlp: str = "yt-dlp",
        asr_python: str | None = None,
        start_background=None,
    ) -> None:
        self.output_root = Path(output_root).expanduser().resolve()
        self.run_command = run_command
        self.yt_dlp = yt_dlp
        self.asr_python = asr_python or str(
            Path.home() / ".hermes/venvs/video-url-to-subtitles/bin/python"
        )
        self.transcriber = Path(__file__).with_name("transcribe.py")
        self.start_background = start_background or self._start_thread
        self.jobs = {}
        self.lock = threading.Lock()

    def existing(self, video_id: str) -> dict:
        safe_id = validate_video_id(video_id)
        paths = output_paths(self.output_root, safe_id)
        if paths.youtube_srt.is_file() and paths.youtube_srt.stat().st_size:
            return self._subtitle_payload(paths.youtube_srt, "youtube")
        paths.directory.mkdir(parents=True, exist_ok=True)
        output_template = paths.directory / f"youtube-{safe_id}-youtube.%(ext)s"
        failures = []
        for flag in ("--write-subs", "--write-auto-subs"):
            result = self.run_command(
                [
                    self.yt_dlp,
                    "--skip-download",
                    "--no-playlist",
                    flag,
                    "--sub-langs",
                    "zh-Hans",
                    "--sub-format",
                    "srt",
                    "--convert-subs",
                    "srt",
                    "-o",
                    str(output_template),
                    f"https://www.youtube.com/watch?v={safe_id}",
                ],
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            if result.returncode:
                failures.append((result.stderr or result.stdout or "yt-dlp failed").strip())
            candidate = next((
                path for path in sorted(paths.directory.glob(f"youtube-{safe_id}-youtube*.srt"))
                if path.is_file() and path.stat().st_size
            ), None)
            if candidate:
                if candidate != paths.youtube_srt:
                    candidate.replace(paths.youtube_srt)
                return self._subtitle_payload(paths.youtube_srt, "youtube")
        if len(failures) == 2:
            raise RuntimeError(failures[-1])
        return {"status": "missing", "source": "youtube"}

    def generate(self, video_id: str) -> dict:
        safe_id = validate_video_id(video_id)
        with self.lock:
            if self.jobs.get(safe_id, {}).get("status") == "running":
                return dict(self.jobs[safe_id])
            self.jobs[safe_id] = {"status": "running", "source": "generated"}
        self.start_background(lambda: self._generate_worker(safe_id))
        return self.generated(safe_id)

    def generated(self, video_id: str) -> dict:
        safe_id = validate_video_id(video_id)
        with self.lock:
            job = dict(self.jobs.get(safe_id, {}))
        if job.get("status") in {"running", "error"}:
            return job
        path = output_paths(self.output_root, safe_id).generated_srt
        if path.is_file() and path.stat().st_size:
            return self._subtitle_payload(path, "generated")
        return {"status": "missing", "source": "generated"}

    def _generate_worker(self, video_id: str) -> None:
        paths = output_paths(self.output_root, video_id)
        paths.directory.mkdir(parents=True, exist_ok=True)
        try:
            if not paths.audio.is_file() or not paths.audio.stat().st_size:
                audio_template = paths.directory / f"youtube-{video_id}-audio.%(ext)s"
                result = self.run_command(
                    [
                        self.yt_dlp,
                        "--no-playlist",
                        "-f",
                        "ba/bestaudio",
                        "-x",
                        "--audio-format",
                        "mp3",
                        "--audio-quality",
                        "0",
                        "-o",
                        str(audio_template),
                        f"https://www.youtube.com/watch?v={video_id}",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=600,
                    check=False,
                )
                self._require_success(result)
            if not paths.audio.is_file() or not paths.audio.stat().st_size:
                raise RuntimeError("yt-dlp did not create the audio file")
            temporary = {
                "srt": paths.directory / f"youtube-{video_id}-generated.working.srt",
                "text": paths.directory / f"youtube-{video_id}-generated.working.txt",
                "markdown": paths.directory / f"youtube-{video_id}-generated.working.timestamps.md",
            }
            for path in temporary.values():
                path.unlink(missing_ok=True)
            result = self.run_command(
                [
                    self.asr_python,
                    str(self.transcriber),
                    str(paths.audio),
                    "--srt",
                    str(temporary["srt"]),
                    "--text",
                    str(temporary["text"]),
                    "--markdown",
                    str(temporary["markdown"]),
                    "--device",
                    "cpu",
                ],
                capture_output=True,
                text=True,
                timeout=21_600,
                check=False,
            )
            self._require_success(result)
            destinations = {
                "srt": paths.generated_srt,
                "text": paths.generated_txt,
                "markdown": paths.generated_markdown,
            }
            for key, path in temporary.items():
                if not path.is_file() or not path.stat().st_size:
                    raise RuntimeError(f"Transcriber did not create {key} output")
            for key, path in temporary.items():
                path.replace(destinations[key])
            with self.lock:
                self.jobs[video_id] = {"status": "ready", "source": "generated"}
        except Exception as error:
            with self.lock:
                self.jobs[video_id] = {
                    "status": "error",
                    "source": "generated",
                    "error": str(error),
                }

    @staticmethod
    def _start_thread(target) -> None:
        threading.Thread(target=target, daemon=True).start()

    @staticmethod
    def _require_success(result: subprocess.CompletedProcess) -> None:
        if result.returncode:
            detail = (result.stderr or result.stdout or "Command failed").strip()
            raise RuntimeError(detail)

    @staticmethod
    def _subtitle_payload(path: Path, source: str) -> dict:
        return {
            "status": "ready",
            "source": source,
            "file_name": path.name,
            "srt": path.read_text(encoding="utf-8"),
        }


def handler_for(service):
    class SubtitleRequestHandler(BaseHTTPRequestHandler):
        server_version = "SubsAnywhereLocal/1"

        def do_OPTIONS(self) -> None:
            origin = self.headers.get("Origin", "")
            if not origin.startswith("chrome-extension://"):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden origin"})
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors_headers(origin)
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send_json(HTTPStatus.OK, {"ok": True})
                return
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            actions = {
                "/api/subtitles/existing": service.existing,
                "/api/subtitles/generated": service.generated,
            }
            self._run_action(actions.get(parsed.path), parsed)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            action = service.generate if parsed.path == "/api/subtitles/generate" else None
            self._run_action(action, parsed)

        def _run_action(self, action, parsed) -> None:
            if action is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                video_id = parse_qs(parsed.query).get("video_id", [""])[0]
                payload = action(validate_video_id(video_id))
                self._send_json(HTTPStatus.OK, payload)
            except ValueError as error:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception as error:
                self._send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": str(error)[:500] or "Local subtitle server failed"},
                )

        def _authorized(self) -> bool:
            return self.headers.get("X-SubsAnywhere-Client") == "extension-v1"

        def _send_json(self, status: HTTPStatus, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            origin = self.headers.get("Origin", "")
            if origin.startswith("chrome-extension://"):
                self._cors_headers(origin)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _cors_headers(self, origin: str) -> None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "X-SubsAnywhere-Client")
            self.send_header("Vary", "Origin")

        def log_message(self, format: str, *args) -> None:
            print(f"{self.address_string()} - {format % args}")

    return SubtitleRequestHandler


def create_server(service, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), handler_for(service))


def main() -> None:
    parser = argparse.ArgumentParser(description="SubsAnywhere local subtitle server")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.home() / "Downloads/SubsAnywhere",
    )
    args = parser.parse_args()
    service = SubtitleService(args.output_dir)
    httpd = create_server(service, args.host, args.port)
    print(f"SubsAnywhere local server: http://{args.host}:{args.port}")
    print(f"Subtitle files: {args.output_dir.expanduser().resolve()}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
