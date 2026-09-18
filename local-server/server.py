#!/usr/bin/env python3
"""Local subtitle service used by the SubsAnywhere extension."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator
from urllib.parse import parse_qs, urlparse

from pinyin import bilingual_srt, contains_han
from asr_models import nano_model_available, select_engine
from words import MAX_WORD_BODY_BYTES, WordsStore, default_words_path

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
EXTENSION_ORIGIN_PATTERN = re.compile(r"chrome-extension://[a-p]{32}\Z")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 43817
MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
MAX_AUDIO_BYTES = 512 * 1024 * 1024
CAPTION_CACHE_VERSION = 1
ERROR_MESSAGES = {
    "interrupted": "Generation interrupted by server restart; retry.",
    "start_failed": "Could not start generation; retry.",
    "timeout": "Local command timed out; retry or use a shorter video.",
    "dependency_missing": "Required local executable is unavailable; check service health.",
    "command_failed": "Local command failed; check dependencies, cookies and video availability.",
    "generation_failed": "Subtitle generation failed; previous subtitles were preserved.",
    "storage_error": "Subtitle storage is unavailable or full.",
    "busy": "Local service is busy; retry shortly.",
    "cancelled": "Generation cancelled; previous subtitles were preserved.",
    "invalid_output": "Local command did not create valid subtitle output.",
    "too_large": "Subtitle or media file exceeds the service size limit.",
    "resource_limit": "Recognition exceeded the memory limit; choose a smaller model or increase the limit. Previous subtitles were preserved.",
}


class ServiceError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


def error_payload(error: BaseException, source: str = "generated") -> dict:
    if isinstance(error, ServiceError):
        code = error.code
    elif isinstance(error, subprocess.TimeoutExpired):
        code = "timeout"
    elif isinstance(error, FileNotFoundError):
        code = "dependency_missing"
    elif isinstance(error, OSError):
        code = "storage_error"
    else:
        code = "generation_failed"
    return {"status": "error", "source": source, "error_code": code, "error": ERROR_MESSAGES[code]}


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

    @property
    def lossless_audio(self) -> Path:
        # Keep the legacy MP3 path and tuple layout for existing caches/callers.
        return self.audio.with_suffix(".flac")

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


def validate_caption_language(language: str) -> str:
    if language not in ("", "en", "zh"):
        raise ValueError("Invalid caption language")
    return language


def caption_language(value) -> str | None:
    if not isinstance(value, str):
        return None
    base = value.lower().replace("_", "-").split("-")[0]
    return base if base in {"en", "zh"} else None


def select_original_captions(metadata: dict, language: str = "") -> tuple[str | None, list]:
    """Prefer manual tracks, then original ASR; never infer speech from titles.

    Unlabelled multilingual HLS captions are not evidence of original language.
    Unknown/unsupported/ambiguous originals deliberately return no selection.
    """
    override = validate_caption_language(language)
    tracks = []
    for source in ("subtitles", "automatic_captions"):
        mapping = metadata.get(source)
        if not isinstance(mapping, dict):
            continue
        for code, formats in sorted(mapping.items(), key=lambda pair: (not pair[0].endswith("-orig"), pair[0])):
            if "-t-" in code.lower() or not isinstance(formats, list):
                continue
            original = [item for item in formats if isinstance(item, dict)
                        and isinstance(item.get("url"), str)
                        and "tlang" not in parse_qs(urlparse(item["url"]).query, keep_blank_values=True)]
            if original:
                tracks.append((source, code, original))

    declared = next((value for value in (override, metadata.get("language"), metadata.get("audio_language"))
                     if isinstance(value, str) and value and value.lower() != "und"), None)
    if not declared:
        audio = [item for item in (metadata.get("formats") or []) if isinstance(item, dict)
                 and isinstance(item.get("language"), str) and item["language"]
                 and item["language"].lower() != "und" and item.get("acodec") != "none"]
        originals = [item for item in audio if "original" in str(item.get("format_note", "")).lower()]
        evidence = {item["language"].split("-")[0].lower() for item in (originals or audio)}
        if len(evidence) == 1:
            declared = next(iter(evidence))
    if not declared:
        auto = [code for source, code, _ in tracks if source == "automatic_captions"]
        originals = [code for code in auto if code.endswith("-orig")]
        evidence = {code.split("-")[0].lower() for code in (originals or auto)}
        if len(evidence) == 1:
            declared = next(iter(evidence))
    selected_language = caption_language(declared)
    return selected_language, [item for item in tracks if selected_language and caption_language(item[1]) == selected_language]


def progress_path(paths: OutputPaths) -> Path:
    return paths.directory / f".{paths.generated_srt.stem}.progress.json"


def job_path(paths: OutputPaths) -> Path:
    return paths.directory / ".generated-job.json"


class SubtitleService:
    def __init__(
        self,
        output_root: Path,
        run_command=None,
        yt_dlp: str = "yt-dlp",
        cookies_from_browser: str | None = None,
        asr_python: str | None = None,
        start_background=None,
        pinyinize=None,
        max_jobs: int | None = None,
        cookies_file: str | None = None,
    ) -> None:
        self.output_root = Path(output_root).expanduser().resolve()
        self.run_command = run_command or self._run_managed
        self.yt_dlp = yt_dlp
        self.cookies_from_browser = (os.environ.get("SUBSANYWHERE_COOKIES_BROWSER", "chrome")
                                     if cookies_from_browser is None else cookies_from_browser)
        self.cookies_file = (os.environ.get("SUBSANYWHERE_COOKIES_FILE", "")
                             if cookies_file is None else cookies_file)
        self.js_runtime = os.environ.get("SUBSANYWHERE_YTDLP_JS_RUNTIME", "")
        self.asr_python = asr_python or os.environ.get("SUBSANYWHERE_ASR_PYTHON") or str(
            Path.home() / ".hermes/venvs/video-url-to-subtitles/bin/python"
        )
        self.transcriber = Path(__file__).with_name("transcribe.py")
        self.start_background = start_background or self._start_thread
        self.pinyinize = pinyinize or bilingual_srt
        self.jobs = {}
        self.lock = threading.Lock()
        # Fixed lock stripes avoid growing a lock map for every requested ID.
        self.subtitle_locks = [threading.Lock() for _ in range(64)]
        self.download_locks = [threading.Lock() for _ in range(64)]
        max_jobs = int(os.environ.get("SUBSANYWHERE_MAX_JOBS", "1")) if max_jobs is None else max_jobs
        if not 1 <= max_jobs <= 16:
            raise ValueError("max_jobs must be between 1 and 16")
        self.max_jobs = max_jobs
        self.slots = threading.BoundedSemaphore(max_jobs)
        self.caption_slots = threading.BoundedSemaphore(1)
        self.caption_jobs = OrderedDict()
        self.caption_active = set()
        self.active_jobs = set()
        self.cancel_events = {}
        self.closing = threading.Event()
        self.local = threading.local()
        self.process_lock = threading.Lock()
        self.processes = set()
        self.threads = set()
        self.health_lock = threading.Lock()
        self.health_cached = None
        self.health_checked_at = 0.0

    def health(self) -> dict:
        # Probe module presence, not heavyweight imports/model loading; no network.
        with self.health_lock:
            if self.health_cached is None or time.monotonic() - self.health_checked_at > 60:
                python_available = bool(shutil.which(self.asr_python))
                dependencies = False
                if python_available:
                    try:
                        result = subprocess.run(
                            [self.asr_python, "-I", "-c", "import importlib.util,sys; "
                             "sys.exit(0 if all(importlib.util.find_spec(m) is not None "
                             "for m in ('funasr','torch','torchaudio','modelscope')) else 1)"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=3, check=False,
                        )
                        dependencies = result.returncode == 0
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                models_root = Path(os.environ.get("SUBSANYWHERE_MODELS_DIR", str(
                    Path.home() / ".cache/modelscope/hub/models/iic"))).expanduser()
                checks = {
                    "yt_dlp": bool(shutil.which(self.yt_dlp)),
                    "ffmpeg": bool(shutil.which("ffmpeg")),
                    "pinyin": importlib.util.find_spec("pypinyin") is not None or
                              (sys.platform == "darwin" and bool(shutil.which("swift"))),
                    "asr_python": python_available,
                    "asr_dependencies": dependencies,
                    "models": all((models_root / model / "model.pt").is_file() and
                                  (models_root / model / "configuration.json").is_file()
                                  for model in ("SenseVoiceSmall", "speech_fsmn_vad_zh-cn-16k-common-pytorch")),
                }
                self.health_cached = checks
                self.health_checked_at = time.monotonic()
            checks = dict(self.health_cached)
        model_setting = os.environ.get("SUBSANYWHERE_ASR_MODEL", "auto")
        models = {language: select_engine(model_setting, language) for language in ("en", "zh")}
        base_ready = all(checks.values())
        checks["nano_model"] = nano_model_available()
        languages = [language for language, model in models.items()
                     if base_ready and (model != "nano" or checks["nano_model"])]
        return {"ok": True, "service": "subsanywhere", "api_version": 1,
                "checks": checks, "recognition_models": models, "capabilities": {
                    "existing": all(checks[key] for key in ("yt_dlp", "ffmpeg", "pinyin")),
                    "asr": bool(languages), "asr_languages": languages,
                }, "limits": {"max_jobs": self.max_jobs}}

    def _youtube_command(self) -> list[str]:
        command = [self.yt_dlp, "--ignore-config", "--no-progress", "--no-continue",
                   "--max-filesize", str(MAX_AUDIO_BYTES), "--socket-timeout", "15",
                   "--retries", "2", "--fragment-retries", "2"]
        # A mounted cookie file takes precedence; never rewrite it from Chrome.
        if self.cookies_file:
            command.extend(["--cookies", self.cookies_file])
        elif self.cookies_from_browser:
            command.extend(["--cookies-from-browser", self.cookies_from_browser])
        if self.js_runtime:
            command.extend(["--js-runtimes", self.js_runtime])
        return command

    def _save_job(self, video_id: str, job: dict) -> None:
        path = job_path(output_paths(self.output_root, video_id))
        path.parent.mkdir(parents=True, exist_ok=True)
        self._write_text_atomically(path, json.dumps(job))
        self._remember_job(video_id, job)

    def _remember_job(self, video_id, job):
        self.jobs[video_id] = dict(job)
        while len(self.jobs) > 128:
            old = next(key for key in self.jobs if key not in self.active_jobs)
            del self.jobs[old]

    def _finish_job(self, video_id: str, job: dict) -> None:
        language = job.get("language", self.jobs.get(video_id, {}).get("language", "zh"))
        job = dict(job, language=language if language in ("en", "zh") else "zh")
        try:
            self._save_job(video_id, job)
        except OSError:
            # Disk-full cannot make the worker immortal. The persisted running
            # record becomes interrupted on restart if this final write fails.
            self._remember_job(video_id, dict(error_payload(ServiceError("storage_error")), language=job["language"]))

    @staticmethod
    def _remove_work_file(path: Path):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    def _load_job(self, video_id: str) -> dict:
        if video_id in self.jobs:
            return dict(self.jobs[video_id])
        path = job_path(output_paths(self.output_root, video_id))
        try:
            with path.open(encoding="utf-8") as source:
                job = json.loads(source.read(8192))
            if not isinstance(job, dict):
                return {}
        except (OSError, ValueError):
            return {}
        if job.get("status") == "running":
            job = {"status": "error", "source": "generated", "language": job.get("language", "zh"),
                   "error_code": "interrupted", "error": "Generation interrupted by server restart; retry."}
            self._finish_job(video_id, job)
            return dict(self.jobs[video_id])
        return job

    def existing(self, video_id: str, language: str = "") -> dict:
        safe_id = validate_video_id(video_id)
        language = validate_caption_language(language)
        self._check_cancelled()
        paths = output_paths(self.output_root, safe_id)
        download_lock = self.download_locks[hash(safe_id) % len(self.download_locks)]
        if not download_lock.acquire(timeout=10):
            raise ServiceError("busy")
        try:
            cached = self._cached_youtube_payload(paths.youtube_srt, language)
            if cached:
                return cached
            if not self.caption_slots.acquire(blocking=False):
                raise ServiceError("busy")
            try:
                return self._download_existing(safe_id, paths, language)
            finally:
                self.caption_slots.release()
        finally:
            download_lock.release()

    def existing_job(self, video_id: str, language: str = "") -> dict:
        """Nonblocking HTTP facade; MV3 fetches cannot wait for yt-dlp."""
        safe_id = validate_video_id(video_id)
        language = validate_caption_language(language)
        key = (safe_id, language)
        paths = output_paths(self.output_root, safe_id)
        with self.lock:
            self._check_cancelled()
            cached = self.caption_jobs.get(key)
            if cached:
                updated, payload = cached
                if payload["status"] == "ready":
                    ready = self._cached_youtube_payload(paths.youtube_srt, language)
                    if ready:
                        return ready
                cooldown = 10 if payload["status"] == "error" else 60
                if payload["status"] == "running" or (payload["status"] != "ready" and time.monotonic() - updated < cooldown):
                    return dict(payload)
            if self.caption_active:
                raise ServiceError("busy")
            self.caption_active.add(safe_id)
            payload = {"status": "running", "source": "youtube", "stage": "downloading"}
            self.caption_jobs[key] = (time.monotonic(), payload)
            self.caption_jobs.move_to_end(key)
            while len(self.caption_jobs) > 128:
                self.caption_jobs.popitem(last=False)
        try:
            self.start_background(lambda: self._existing_worker(safe_id, language))
        except Exception:
            with self.lock:
                self.caption_active.discard(safe_id)
                self.caption_jobs[key] = (time.monotonic(), error_payload(ServiceError("start_failed"), "youtube"))
        with self.lock:
            result = dict(self.caption_jobs[key][1])
        if result["status"] == "ready":
            return self._cached_youtube_payload(paths.youtube_srt, language) or error_payload(ServiceError("invalid_output"), "youtube")
        return result

    def _existing_worker(self, video_id: str, language: str = ""):
        try:
            result = self.existing(video_id, language)
            result = {key: value for key, value in result.items() if key != "srt"}
        except BaseException as error:
            result = error_payload(error, "youtube")
        with self.lock:
            self.caption_jobs[(video_id, language)] = (time.monotonic(), result)
            self.caption_active.discard(video_id)

    def _download_existing(self, safe_id: str, paths: OutputPaths, requested_language: str = "") -> dict:
        paths.directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".captions-", dir=paths.directory) as directory:
            work = Path(directory)
            template = work / "metadata.%(ext)s"
            result = self.run_command(
                self._youtube_command() + ["--skip-download", "--no-playlist", "--write-info-json",
                    "-o", str(template), f"https://www.youtube.com/watch?v={safe_id}"],
                capture_output=True, text=True, timeout=180, check=False,
            )
            self._require_success(result)
            self._check_cancelled()
            try:
                metadata = json.loads(self._read_subtitle(work / "metadata.info.json"))
                if not isinstance(metadata, dict):
                    raise ValueError("Invalid metadata")
            except (ValueError, FileNotFoundError):
                raise ServiceError("invalid_output") from None
            language, selections = select_original_captions(metadata, requested_language)
            if language is None:
                available = [code for code in ("en", "zh") if select_original_captions(metadata, code)[1]]
                return {"status": "missing", "source": "youtube", "language_required": bool(available),
                        "available_languages": available}
            failures = 0
            # At most one manual and one automatic attempt, independent of how
            # many regional aliases YouTube exposes. Never download media.
            attempted = set()
            for source, code, formats in selections:
                if source in attempted:
                    continue
                attempted.add(source)
                selected = dict(metadata, subtitles={}, automatic_captions={})
                selected[source] = {code: formats}
                selected.pop("requested_subtitles", None)
                info = work / "selected.info.json"
                info.write_text(json.dumps(selected), encoding="utf-8")
                with tempfile.TemporaryDirectory(prefix="track-", dir=work) as attempt:
                    output_template = Path(attempt) / f"youtube-{safe_id}-youtube.%(ext)s"
                    flag = "--write-subs" if source == "subtitles" else "--write-auto-subs"
                    result = self.run_command(
                        self._youtube_command() + ["--skip-download", "--no-playlist", flag,
                            "--sub-langs", re.escape(code).replace(r"\-", "-"), "--sub-format", "srt/vtt/best",
                            "--convert-subs", "srt", "--load-info-json", str(info),
                            "-o", str(output_template)],
                        capture_output=True, text=True, timeout=180, check=False,
                    )
                    self._check_cancelled()
                    if result.returncode:
                        failures += 1
                        continue
                    candidate = next((path for path in Path(attempt).glob("*.srt")
                                      if path.is_file() and path.stat().st_size), None)
                    if candidate:
                        contents = self._clean_srt(self._read_subtitle(candidate))
                        self._validate_srt(contents)
                        if language == "zh":
                            contents = self._pinyinize_srt(candidate, contents)
                        else:
                            self._write_text_atomically(candidate, contents)
                        self._check_cancelled()
                        record = {"version": CAPTION_CACHE_VERSION, "language": language,
                                  "requested_language": requested_language,
                                  "track": code, "kind": source,
                                  "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest()}
                        # Bind provenance to exact bytes. Publish SRT last; failed
                        # refreshes preserve it, crashes cannot trust stale metadata.
                        self._write_text_atomically(paths.youtube_srt.with_suffix(".language.json"), json.dumps(record))
                        candidate.replace(paths.youtube_srt)
                        return self._subtitle_payload(paths.youtube_srt, "youtube", contents, language)
            if failures:
                raise ServiceError("command_failed")
            return {"status": "missing", "source": "youtube"}

    def generate(self, video_id: str, language: str = "") -> dict:
        safe_id = validate_video_id(video_id)
        language = validate_caption_language(language) or "zh"
        with self.lock:
            self._check_cancelled()
            if safe_id in self.active_jobs:
                return dict(self.jobs[safe_id])
            if not self.slots.acquire(blocking=False):
                raise ServiceError("busy")
            self.active_jobs.add(safe_id)
            self.cancel_events[safe_id] = threading.Event()
            try:
                progress_path(output_paths(self.output_root, safe_id)).unlink(missing_ok=True)
                self._save_job(safe_id, {
                    "status": "running",
                    "source": "generated",
                    "language": language,
                    "stage": "preparing",
                    "progress": 0,
                })
            except OSError:
                self.active_jobs.remove(safe_id)
                self.cancel_events.pop(safe_id, None)
                self.slots.release()
                raise ServiceError("storage_error") from None
        try:
            self.start_background(lambda: self._generate_worker(safe_id, language))
        except Exception:
            with self.lock:
                self._finish_job(safe_id, {"status": "error", "source": "generated",
                                         "error_code": "start_failed", "error": "Could not start generation; retry."})
                self.active_jobs.remove(safe_id)
                self.cancel_events.pop(safe_id, None)
                self.slots.release()
        return self.generated(safe_id)

    def generated(self, video_id: str) -> dict:
        safe_id = validate_video_id(video_id)
        path = output_paths(self.output_root, safe_id).generated_srt
        with self._subtitle_lock(path):
            return self._generated_locked(safe_id, path)

    def _generated_locked(self, safe_id: str, path: Path) -> dict:
        with self.lock:
            job = self._load_job(safe_id)
        if job.get("status") in {"running", "error"}:
            if job.get("status") == "running":
                try:
                    with progress_path(output_paths(self.output_root, safe_id)).open(encoding="utf-8") as source:
                        live_progress = json.loads(source.read(8192))
                    if isinstance(live_progress, dict):
                        if live_progress.get("stage") in {"preparing", "downloading", "recognizing"}:
                            job["stage"] = live_progress["stage"]
                        for key, maximum in (("progress", 100), ("completed_segments", 1_000_000),
                                             ("total_segments", 1_000_000), ("eta_seconds", 86_400)):
                            value = live_progress.get(key)
                            if type(value) is int and 0 <= value <= maximum:
                                job[key] = value
                except (ValueError, OSError):
                    pass
            return job
        if path.is_file() and path.stat().st_size:
            contents = self._read_subtitle(path)
            # Job provenance is trusted only for the exact published SRT bytes.
            # Legacy/replaced files must never inherit a stale ready-job language.
            language = job.get("language")
            if (language not in ("en", "zh")
                    or job.get("sha256") != hashlib.sha256(contents.encode("utf-8")).hexdigest()):
                language = "zh" if contains_han(contents) else "en"
            if language == "zh":
                contents = self._pinyinize_srt_locked(path, contents)
            return self._subtitle_payload(path, "generated", contents, language)
        return {"status": "missing", "source": "generated"}

    def _generate_worker(self, video_id: str, language: str = "zh") -> None:
        paths = output_paths(self.output_root, video_id)
        self.local.cancel_event = self.cancel_events[video_id]
        try:
            self._check_cancelled()
            paths.directory.mkdir(parents=True, exist_ok=True)
            audio = paths.lossless_audio
            if (not audio.is_file() or not audio.stat().st_size) and paths.audio.is_file() and paths.audio.stat().st_size:
                audio = paths.audio
            if not audio.is_file() or not audio.stat().st_size:
                with self.lock:
                    self.jobs[video_id].update(stage="downloading", progress=0)
                audio_template = paths.directory / f"youtube-{video_id}-audio.working.%(ext)s"
                audio_format = audio.suffix.lstrip(".")
                working_audio = Path(str(audio_template).replace("%(ext)s", audio_format))
                self._remove_work_file(working_audio)
                result = self.run_command(
                    self._youtube_command() + [
                        "--no-playlist",
                        "-f",
                        "ba/bestaudio",
                        "-x",
                        "--audio-format",
                        audio_format,
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
                self._check_cancelled()
                if not working_audio.is_file() or not working_audio.stat().st_size:
                    raise ServiceError("invalid_output")
                if working_audio.stat().st_size > MAX_AUDIO_BYTES:
                    raise ServiceError("too_large")
                working_audio.replace(audio)
            if not audio.is_file() or not audio.stat().st_size:
                raise RuntimeError("yt-dlp did not create the audio file")
            if audio.stat().st_size > MAX_AUDIO_BYTES:
                raise ServiceError("too_large")
            temporary = {
                "srt": paths.directory / f"youtube-{video_id}-generated.working.srt",
                "text": paths.directory / f"youtube-{video_id}-generated.working.txt",
                "markdown": paths.directory / f"youtube-{video_id}-generated.working.timestamps.md",
            }
            for path in temporary.values():
                path.unlink(missing_ok=True)
            with self.lock:
                self.jobs[video_id].update(stage="recognizing", progress=0)
            result = self.run_command(
                [
                    self.asr_python,
                    str(self.transcriber),
                    str(audio),
                    "--srt",
                    str(temporary["srt"]),
                    "--text",
                    str(temporary["text"]),
                    "--markdown",
                    str(temporary["markdown"]),
                    "--device",
                    "cpu",
                    "--language",
                    language,
                    "--progress",
                    str(progress_path(paths)),
                ],
                capture_output=True,
                text=True,
                timeout=21_600,
                check=False,
            )
            if result.returncode == 73:
                raise ServiceError("resource_limit")
            self._require_success(result)
            destinations = {
                "srt": paths.generated_srt,
                "text": paths.generated_txt,
                "markdown": paths.generated_markdown,
            }
            for key, path in temporary.items():
                if not path.is_file() or not path.stat().st_size:
                    raise ServiceError("invalid_output")
                if path.stat().st_size > MAX_SUBTITLE_BYTES:
                    raise ServiceError("too_large")
            contents = self._read_subtitle(temporary["srt"])
            self._validate_srt(contents)
            if language == "zh":
                contents = self._pinyinize_srt(temporary["srt"], contents)
            with self._subtitle_lock(paths.generated_srt), self.lock:
                self._check_cancelled()
                # Commit SRT last: failed conversion/cancellation never replaces it.
                for key in ("text", "markdown", "srt"):
                    temporary[key].replace(destinations[key])
                self._finish_job(video_id, {"status": "ready", "source": "generated", "language": language,
                                            "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest()})
        except BaseException as error:
            with self.lock:
                self._finish_job(video_id, error_payload(error))
        finally:
            try:
                self._remove_work_file(progress_path(paths))
                for pattern in (f"youtube-{video_id}-generated.working.*", f"youtube-{video_id}-audio.working.*"):
                    for path in paths.directory.glob(pattern):
                        self._remove_work_file(path)
            except OSError:
                pass
            finally:
                with self.lock:
                    self.active_jobs.discard(video_id)
                    self.cancel_events.pop(video_id, None)
                    self.slots.release()
                self.local.cancel_event = None

    def _start_thread(self, target) -> None:
        def run():
            try:
                target()
            finally:
                with self.lock:
                    self.threads.discard(threading.current_thread())
        thread = threading.Thread(target=run, daemon=True)
        with self.lock:
            self._check_cancelled()
            self.threads.add(thread)
            try:
                thread.start()
            except BaseException:
                self.threads.discard(thread)
                raise

    def _check_cancelled(self):
        event = getattr(self.local, "cancel_event", None)
        if self.closing.is_set() or (event is not None and event.is_set()):
            raise ServiceError("cancelled")

    def cancel(self, video_id: str) -> dict:
        safe_id = validate_video_id(video_id)
        with self.lock:
            if safe_id in self.active_jobs and self.jobs[safe_id].get("status") == "running":
                self.cancel_events[safe_id].set()
                self._finish_job(safe_id, error_payload(ServiceError("cancelled")))
        return self.generated(safe_id)

    def close(self) -> None:
        self.closing.set()
        with self.lock:
            for video_id in list(self.active_jobs):
                if self.jobs[video_id].get("status") == "running":
                    self.cancel_events[video_id].set()
                    self._finish_job(video_id, error_payload(ServiceError("cancelled")))
            threads = list(self.threads)
        with self.process_lock:
            processes = list(self.processes)
        for process in processes:
            self._stop_process(process)
        deadline = time.monotonic() + 5
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(max(0, deadline - time.monotonic()))

    @staticmethod
    def _stop_process(process) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            elif process.poll() is None:
                process.terminate()
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            try:
                if os.name == "posix":
                    # Also kill grandchildren after their parent has exited.
                    os.killpg(process.pid, signal.SIGKILL)
                elif process.poll() is None:
                    process.kill()
                process.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def _run_managed(self, command, *, timeout, **kwargs):
        # yt-dlp saves its cookie jar on exit. Copy a read-only mount into a
        # private, short-lived directory rather than granting it write access.
        with tempfile.TemporaryDirectory(prefix="subsanywhere-command-") as directory:
            command = list(command)
            if "--cookies" in command:
                index = command.index("--cookies") + 1
                source = Path(command[index]).expanduser()
                with source.open("rb") as cookie:
                    data = cookie.read(MAX_SUBTITLE_BYTES + 1)
                if len(data) > MAX_SUBTITLE_BYTES:
                    raise ServiceError("too_large")
                copy = Path(directory) / "cookies.txt"
                with copy.open("xb") as destination:
                    os.chmod(copy, 0o600)
                    destination.write(data)
                command[index] = str(copy)
            return self._run_process(command, timeout=timeout)

    def _run_process(self, command, *, timeout):
        self._check_cancelled()
        output_directory = None
        for flag in ("-o", "--srt"):
            if flag in command:
                output_directory = Path(command[command.index(flag) + 1]).parent
                break
        with self.process_lock:
            self._check_cancelled()
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=os.name == "posix")
            self.processes.add(process)
        try:
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                self._check_cancelled()
                if output_directory is not None:
                    used = 0
                    for path in output_directory.iterdir():
                        try:
                            if path.is_file():
                                used += path.stat().st_size
                        except FileNotFoundError:
                            continue
                        if used > MAX_AUDIO_BYTES * 2:
                            raise ServiceError("too_large")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ServiceError("timeout")
                try:
                    process.wait(timeout=min(0.1, remaining))
                except subprocess.TimeoutExpired:
                    pass
            self._check_cancelled()
            return subprocess.CompletedProcess(command, process.returncode, "", "")
        finally:
            self._stop_process(process)
            with self.process_lock:
                self.processes.discard(process)

    @staticmethod
    def _require_success(result: subprocess.CompletedProcess) -> None:
        if result.returncode:
            raise ServiceError("command_failed")

    def _subtitle_lock(self, path: Path) -> threading.Lock:
        key = str(path.resolve())
        return self.subtitle_locks[hash(key) % len(self.subtitle_locks)]

    @staticmethod
    def _write_text_atomically(path: Path, contents: str) -> None:
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix=f".{path.name}.", suffix=".tmp", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(contents)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, path)
            if os.name == "posix":
                directory = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if temporary_path is not None:
                SubtitleService._remove_work_file(temporary_path)

    @staticmethod
    def _clean_srt(contents: str) -> str:
        normalized = contents.replace("\r\n", "\n").replace("\r", "\n").strip().lstrip("\ufeff")
        timestamp = r"[0-9]{2,}:[0-5][0-9]:[0-5][0-9][,.][0-9]{3}"
        empty_cue = re.compile(r"[0-9]+\n" + timestamp + r"\s+-->\s+" + timestamp + r"[^\n]*\Z")
        blocks = [block for block in re.split(r"\n\s*\n", normalized)
                  if not empty_cue.fullmatch(block)]
        return "\n\n".join(blocks).strip() + ("\n" if blocks else "")

    @staticmethod
    def _validate_srt(contents: str) -> None:
        normalized = contents.replace("\r\n", "\n").replace("\r", "\n").strip().lstrip("\ufeff")
        timestamp = r"([0-9]{2,}):([0-5][0-9]):([0-5][0-9])[,.]([0-9]{3})"
        for block in re.split(r"\n\s*\n", normalized):
            match = re.fullmatch(r"[0-9]+\n" + timestamp + r"\s+-->\s+" + timestamp + r"[^\n]*\n(.+)", block, re.DOTALL)
            if not match or not match[9].strip():
                raise ServiceError("invalid_output")
            values = [int(value) for value in match.groups()[:8]]
            start = ((values[0] * 60 + values[1]) * 60 + values[2]) * 1000 + values[3]
            end = ((values[4] * 60 + values[5]) * 60 + values[6]) * 1000 + values[7]
            if end <= start:
                raise ServiceError("invalid_output")

    def _pinyinize_srt(self, path: Path, contents: str | None = None) -> str:
        with self._subtitle_lock(path):
            return self._pinyinize_srt_locked(path, contents)

    def _pinyinize_srt_locked(self, path: Path, contents: str | None = None) -> str:
        source = self._read_subtitle(path) if contents is None else contents
        converted = self.pinyinize(source)
        if not isinstance(converted, str) or not converted.strip():
            raise ServiceError("invalid_output")
        if len(converted.encode("utf-8")) > MAX_SUBTITLE_BYTES:
            raise ServiceError("too_large")
        existing = self._read_subtitle(path) if path.is_file() else None
        if converted != existing:
            self._write_text_atomically(path, converted)
        return converted

    def _pinyin_subtitle_payload(self, path: Path, subtitle_source: str) -> dict:
        return self._subtitle_payload(path, subtitle_source, self._pinyinize_srt(path))

    def _cached_youtube_payload(self, path: Path, requested_language: str = "") -> dict | None:
        try:
            with path.with_suffix(".language.json").open(encoding="utf-8") as source:
                record = json.loads(source.read(8192))
            if (not isinstance(record, dict) or record.get("version") != CAPTION_CACHE_VERSION
                    or record.get("language") not in {"en", "zh"}
                    or record.get("requested_language") != requested_language):
                return None
            contents = self._read_subtitle(path)
            if hashlib.sha256(contents.encode("utf-8")).hexdigest() != record.get("sha256"):
                return None
            return self._subtitle_payload(path, "youtube", contents, record["language"])
        except (OSError, ValueError):
            return None

    @staticmethod
    def _read_subtitle(path: Path) -> str:
        with path.open("rb") as source:
            if os.fstat(source.fileno()).st_size > MAX_SUBTITLE_BYTES:
                raise ServiceError("too_large")
            data = source.read(MAX_SUBTITLE_BYTES + 1)
        if len(data) > MAX_SUBTITLE_BYTES:
            raise ServiceError("too_large")
        return data.decode("utf-8")

    @staticmethod
    def _subtitle_payload(path: Path, source: str, contents: str | None = None, language: str = "zh") -> dict:
        return {
            "status": "ready",
            "source": source,
            "language": language,
            "file_name": path.name,
            "srt": SubtitleService._read_subtitle(path) if contents is None else contents,
        }


WORDS_ROUTES = frozenset({
    "/api/words", "/api/words/learned", "/api/words/explanation",
    "/api/sentences", "/api/sentences/learned", "/api/sentences/explanation",
})
WORDS_ASSETS = {
    "/words": ("index.html", "text/html; charset=utf-8"),
    "/words/words.js": ("words.js", "text/javascript; charset=utf-8"),
    "/words/words.css": ("words.css", "text/css; charset=utf-8"),
}
WORDS_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
             "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'")


def handler_for(service, words_store=None):
    vocabulary = words_store if words_store is not None else WordsStore(default_words_path())

    class SubtitleRequestHandler(BaseHTTPRequestHandler):
        server_version = "SubsAnywhereLocal/1"

        def setup(self) -> None:
            self.request.settimeout(5)
            super().setup()

        def parse_request(self) -> bool:
            if not super().parse_request():
                return False
            self.close_connection = True
            if len(self.path) > 2048:
                self._send_json(HTTPStatus.REQUEST_URI_TOO_LONG, {"error": "Request target too long"})
                return False
            if sum(len(key) + len(value) for key, value in self.headers.items()) > 16384:
                self._send_json(HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE, {"error": "Headers too large"})
                return False
            port = self.server.server_address[1]
            hosts = {f"{host}:{port}" for host in ("127.0.0.1", "localhost", "[::1]")}
            if port == 80:
                hosts.update(("127.0.0.1", "localhost", "[::1]"))
            origins = self.headers.get_all("Origin", [])
            host = self.headers.get("Host", "").lower()
            # Docker port publishing changes Host but not the container listener.
            # Only literal loopback authorities remain allowed, never LAN names.
            mapped = re.fullmatch(r"(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})", host)
            valid_host = host in hosts or (self.server.server_address[0] in {"0.0.0.0", "::"}
                                           and mapped is not None and 1 <= int(mapped[1]) <= 65535)
            # Only the vocabulary surface accepts the local browser origin.
            # Do not grant the panel any new access to subtitle/job endpoints.
            panel_origin = (self.path in WORDS_ROUTES or self.path in WORDS_ASSETS) and origins == [f"http://{host}"]
            if (len(self.headers.get_all("Host", [])) != 1 or not valid_host
                    or len(origins) > 1 or (origins and not panel_origin and not EXTENSION_ORIGIN_PATTERN.fullmatch(origins[0]))):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden host or origin"}, cors=False)
                return False
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get_all("Transfer-Encoding") or len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid request framing"})
                return False
            # JSON bodies are limited to the exact learning-panel POST routes.
            # Subtitle endpoints retain their no-body contract.
            words_post = self.command == "POST" and self.path in WORDS_ROUTES
            if words_post and not lengths:
                self._send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
                return False
            if lengths and int(lengths[0]) > (MAX_WORD_BODY_BYTES if words_post else 0):
                self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {
                    "error": "Vocabulary body too large" if words_post else "Request bodies are not accepted"
                })
                return False
            return True

        def do_OPTIONS(self) -> None:
            origin = self.headers.get("Origin", "")
            requested_headers = {name.strip().lower() for name in self.headers.get("Access-Control-Request-Headers", "").split(",") if name.strip()}
            allowed_headers = {"x-subsanywhere-client"}
            if self.path in WORDS_ROUTES:
                allowed_headers.add("content-type")
            if (not EXTENSION_ORIGIN_PATTERN.fullmatch(origin)
                    or self.headers.get("Access-Control-Request-Method", "GET") not in {"GET", "POST"}
                    or not requested_headers.issubset(allowed_headers)):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden origin"})
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors_headers(origin)
            self.end_headers()

        def do_GET(self) -> None:
            if self.path in WORDS_ASSETS:
                self._send_words_asset()
                return
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                payload = service.health() if hasattr(service, "health") else {"ok": True, "service": "subsanywhere", "api_version": 1}
                self._send_json(HTTPStatus.OK, payload)
                return
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            if self.path in {"/api/words", "/api/sentences"}:
                self._run_words(write=False)
                return
            actions = {
                "/api/subtitles/existing": getattr(service, "existing_job", service.existing),
                "/api/subtitles/generated": service.generated,
            }
            self._run_action(actions.get(parsed.path), parsed)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            if self.path in WORDS_ROUTES:
                content_types = self.headers.get_all("Content-Type", [])
                if len(content_types) != 1 or not re.fullmatch(
                    r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', content_types[0], re.IGNORECASE
                ):
                    self._send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Expected application/json (UTF-8)"})
                    return
                self._run_words(write=True)
                return
            action = {"/api/subtitles/generate": service.generate,
                      "/api/subtitles/cancel": getattr(service, "cancel", None)}.get(parsed.path)
            self._run_action(action, parsed)

        def _run_words(self, *, write: bool) -> None:
            try:
                if not write:
                    payload = ({"sentences": vocabulary.list_sentences()} if self.path == "/api/sentences"
                               else {"words": vocabulary.list()})
                else:
                    length = int(self.headers["Content-Length"])
                    try:
                        body = self.rfile.read(length)
                    except (TimeoutError, ConnectionError) as error:
                        raise ValueError("Incomplete JSON body") from error
                    if len(body) != length:
                        raise ValueError("Incomplete JSON body")

                    def unique_object(pairs):
                        result = {}
                        for key, value in pairs:
                            if key in result:
                                raise ValueError("Duplicate JSON field")
                            result[key] = value
                        return result

                    def reject_constant(value):
                        raise ValueError("Invalid JSON constant")

                    data = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=reject_constant)
                    if self.path == "/api/words":
                        payload = {"word": vocabulary.add(data)}
                    elif self.path == "/api/words/learned":
                        if not isinstance(data, dict) or set(data) != {"id", "learned"} or type(data["learned"]) is not bool:
                            raise ValueError("Expected word ID and learned state")
                        word = vocabulary.set_learned(data["id"], data["learned"])
                        if word is None:
                            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Word not found"})
                            return
                        payload = {"word": word}
                    elif self.path == "/api/words/explanation":
                        if not isinstance(data, dict) or set(data) != {"id", "explanation"}:
                            raise ValueError("Expected word ID and explanation")
                        word = vocabulary.set_explanation(data["id"], data["explanation"])
                        if word is None:
                            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Word not found"})
                            return
                        payload = {"word": word}
                    elif self.path == "/api/sentences":
                        payload = {"sentence": vocabulary.add_sentence(data)}
                    elif self.path == "/api/sentences/learned":
                        if not isinstance(data, dict) or set(data) != {"id", "learned"} or type(data["learned"]) is not bool:
                            raise ValueError("Expected sentence ID and learned state")
                        sentence = vocabulary.set_sentence_learned(data["id"], data["learned"])
                        if sentence is None:
                            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Sentence not found"})
                            return
                        payload = {"sentence": sentence}
                    else:
                        if not isinstance(data, dict) or set(data) != {"id", "explanation"}:
                            raise ValueError("Expected sentence ID and explanation")
                        sentence = vocabulary.set_sentence_explanation(data["id"], data["explanation"])
                        if sentence is None:
                            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Sentence not found"})
                            return
                        payload = {"sentence": sentence}
                self._send_json(HTTPStatus.OK, payload)
            except (ValueError, RecursionError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid vocabulary fields or JSON"})
            except (OSError, sqlite3.Error):
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Vocabulary storage unavailable"})

        def _send_words_asset(self) -> None:
            # Fixed trusted filenames only; never turn request text into a path.
            name, content_type = WORDS_ASSETS[self.path]
            try:
                body = (Path(__file__).with_name("web") / name).read_bytes()
            except OSError:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Vocabulary panel unavailable"})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", WORDS_CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def _run_action(self, action, parsed) -> None:
            if action is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=4)
                options = {}
                if parsed.path in {"/api/subtitles/existing", "/api/subtitles/generate"} and "language" in query:
                    languages = query.pop("language")
                    if len(languages) != 1 or languages[0] not in {"en", "zh"}:
                        raise ValueError("Invalid caption language")
                    options["language"] = languages[0]
                if set(query) != {"video_id"} or len(query["video_id"]) != 1 or parsed.netloc or parsed.fragment:
                    raise ValueError("Invalid query")
                video_id = query["video_id"][0]
                payload = action(validate_video_id(video_id), **options)
                self._send_json(HTTPStatus.OK, payload)
            except ValueError:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid video ID or query"})
            except Exception as error:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE if isinstance(error, ServiceError) and error.code == "busy" else HTTPStatus.INTERNAL_SERVER_ERROR,
                    error_payload(error),
                )

        def _authorized(self) -> bool:
            return self.headers.get_all("X-SubsAnywhere-Client", []) == ["extension-v1"]

        def _send_json(self, status: HTTPStatus, payload: dict, cors=True) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            origin = getattr(self, "headers", {}).get("Origin", "")
            if cors and EXTENSION_ORIGIN_PATTERN.fullmatch(origin):
                self._cors_headers(origin)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            if status == HTTPStatus.SERVICE_UNAVAILABLE:
                self.send_header("Retry-After", "2")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def send_error(self, code, message=None, explain=None):
            self._send_json(code, {"error": HTTPStatus(code).phrase}, cors=False)

        def _cors_headers(self, origin: str) -> None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            allowed = "X-SubsAnywhere-Client, Content-Type" if self.path in WORDS_ROUTES else "X-SubsAnywhere-Client"
            self.send_header("Access-Control-Allow-Headers", allowed)
            self.send_header("Vary", "Origin")

        def log_message(self, format: str, *args) -> None:
            # Do not log attacker-controlled request targets or subprocess data.
            pass

    return SubtitleRequestHandler


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, handler, max_requests=16):
        self.request_slots = threading.BoundedSemaphore(max_requests)
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            try:
                request.settimeout(0.2)
                body = b'{"status":"error","error_code":"busy","error":"Local service is busy"}'
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n"
                                b"Content-Type: application/json\r\nRetry-After: 2\r\nContent-Length: "
                                + str(len(body)).encode() + b"\r\n\r\n" + body)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def handle_error(self, request, client_address):
        # Never emit traceback paths or arbitrary exception messages over logs.
        print("Local HTTP request failed", file=sys.stderr)


def create_server(service, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, max_requests=16, words_store=None) -> BoundedHTTPServer:
    return BoundedHTTPServer((host, port), handler_for(service, words_store), max_requests)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="SubsAnywhere local subtitle server")
    parser.add_argument("--host", default=os.environ.get("SUBSANYWHERE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=os.environ.get("SUBSANYWHERE_PORT", str(DEFAULT_PORT)))
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(os.environ.get("SUBSANYWHERE_OUTPUT_DIR", str(Path.home() / "Downloads/SubsAnywhere"))),
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    return args


def main() -> None:
    args = parse_args()
    service = SubtitleService(args.output_dir)
    httpd = create_server(service, args.host, args.port)
    print(f"SubsAnywhere local server: http://{args.host}:{args.port}")
    print(f"Subtitle files: {args.output_dir.expanduser().resolve()}")
    try:
        def terminate(signum, frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, terminate)
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        service.close()


if __name__ == "__main__":
    main()
