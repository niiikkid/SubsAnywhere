#!/usr/bin/env python3
"""Local subtitle service used by the SubsAnywhere extension."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from pinyin import bilingual_srt
from video_download_api import VideoDownloadAPI, ProviderError, MESSAGES as PROVIDER_MESSAGES

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
EXTENSION_ORIGIN_PATTERN = re.compile(r"chrome-extension://[a-p]{32}\Z")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 43817
MAX_SUBTITLE_BYTES = 5 * 1024 * 1024
CAPTION_CACHE_VERSION = 1
MAX_PREPARATION_BYTES = 32 * 1024 * 1024
# JSON escaping can expand each SRT character to six bytes.
MAX_CACHE_BODY_BYTES = MAX_SUBTITLE_BYTES * 6 + 1024
PREPARATION_ID_PATTERN = re.compile(r"[a-f0-9]{64}\Z")
PREPARATION_PATH_PATTERN = re.compile(r"/api/preparations/([a-f0-9]{64})\Z")


def bounded_text(value, limit, nonempty=False):
    if not isinstance(value, str) or len(value) > limit or (nonempty and not value.strip()):
        raise ValueError("Invalid text")
    # Reject unpaired surrogates before any UTF-8 storage or response encoding.
    value.encode("utf-8")
    return value


def bounded_number(value, limit, integer=False):
    if (type(value) not in (int, float) or not 0 <= value <= limit
            or not math.isfinite(value) or (integer and type(value) is not int)):
        raise ValueError("Invalid number")
    return value


def validate_preparation_id(value):
    if not isinstance(value, str) or not PREPARATION_ID_PATTERN.fullmatch(value):
        raise ValueError("Invalid preparation ID")
    return value


def validate_result_value(value, depth=0):
    """Bound translation/glossary data without coupling storage to AI execution."""
    if depth > 8:
        raise ValueError("Translation nesting too deep")
    if value is None or type(value) is bool:
        return
    if isinstance(value, str):
        bounded_text(value, 32000)
    elif type(value) in (int, float):
        bounded_number(value, 2 ** 53 - 1)
    elif isinstance(value, list) and len(value) <= 2000:
        for item in value:
            validate_result_value(item, depth + 1)
    elif isinstance(value, dict) and len(value) <= 64:
        for key, item in value.items():
            bounded_text(key, 128, True)
            if re.sub(r"[^a-z]", "", key.lower()) in {
                    "apikey", "token", "accesstoken", "authorization", "password", "secret", "credentials"}:
                raise ValueError("Credentials are not archive data")
            validate_result_value(item, depth + 1)
    else:
        raise ValueError("Invalid translation value")


def validate_preparation(job, preparation_id):
    validate_preparation_id(preparation_id)
    required = {"id", "pageKey", "trackId", "provider", "model", "status", "error",
                "descriptors", "results", "revision", "updatedAt"}
    if (not isinstance(job, dict) or not required.issubset(job)
            or set(job) - required - {"sourceTrack"} or job["id"] != preparation_id):
        raise ValueError("Invalid preparation fields")
    for key, limit in (("pageKey", 4096), ("trackId", 1024), ("provider", 128), ("model", 512)):
        bounded_text(job[key], limit, True)
    if job["status"] not in ("idle", "running", "paused", "error", "ready"):
        raise ValueError("Invalid preparation status")
    bounded_text(job["error"], 4096)
    bounded_number(job["revision"], 2 ** 53 - 1, integer=True)
    bounded_number(job["updatedAt"], 2 ** 53 - 1)
    descriptors = job["descriptors"]
    if not isinstance(descriptors, list) or not 1 <= len(descriptors) <= 40000:
        raise ValueError("Invalid descriptors")
    keys = set()
    for descriptor in descriptors:
        fields = {"key", "sourceText", "displayText", "language", "characters"}
        if (not isinstance(descriptor, dict) or not fields.issubset(descriptor)
                or set(descriptor) - fields - {"generatedPinyin"}):
            raise ValueError("Invalid descriptor")
        key = bounded_text(descriptor["key"], 2048, True)
        if key in keys or key in {"__proto__", "constructor", "prototype"}:
            raise ValueError("Invalid descriptor key")
        keys.add(key)
        for field in ("sourceText", "displayText", "characters"):
            bounded_text(descriptor[field], 1000, field == "sourceText")
        if descriptor["language"] not in ("", "en", "zh"):
            raise ValueError("Invalid descriptor language")
        if "generatedPinyin" in descriptor and type(descriptor["generatedPinyin"]) is not bool:
            raise ValueError("Invalid pinyin flag")
    results = job["results"]
    if not isinstance(results, dict) or not set(results).issubset(keys):
        raise ValueError("Invalid result keys")
    for result in results.values():
        if not isinstance(result, dict) or set(result) != {"items"}:
            raise ValueError("Invalid result")
        items = result["items"]
        if (not isinstance(items, list) or not 1 <= len(items) <= 1000
                or not all(isinstance(item, dict) for item in items)):
            raise ValueError("Invalid result items")
        validate_result_value(items)
        if not any(item.get("isSentenceTranslation") is True
                   and isinstance(item.get("dictionary"), str) and item["dictionary"].strip() for item in items):
            raise ValueError("Missing successful sentence dictionary")
    if job["status"] == "ready" and set(results) != keys:
        raise ValueError("Incomplete ready preparation")
    if "sourceTrack" in job:
        track = job["sourceTrack"]
        fields = {"id", "name", "language", "sourceType", "sourceVideoId", "cues"}
        if not isinstance(track, dict) or set(track) != fields or track["id"] != job["trackId"]:
            raise ValueError("Invalid source track")
        for key, limit in (("id", 1024), ("name", 1024), ("language", 64), ("sourceType", 128), ("sourceVideoId", 128)):
            bounded_text(track[key], limit)
        cues = track["cues"]
        if not isinstance(cues, list) or not 1 <= len(cues) <= 20000:
            raise ValueError("Invalid source cues")
        for cue in cues:
            if not isinstance(cue, dict) or set(cue) != {"start", "end", "text"}:
                raise ValueError("Invalid source cue")
            bounded_number(cue["start"], 1e9)
            bounded_number(cue["end"], 1e9)
            if cue["end"] <= cue["start"]:
                raise ValueError("Invalid cue interval")
            bounded_text(cue["text"], 32000, True)
    return job
ERROR_MESSAGES = {
    "start_failed": "Could not start subtitle download; retry.",
    "download_failed": "Subtitle download failed; previous subtitles were preserved.",
    "storage_error": "Subtitle storage is unavailable or full.",
    "busy": "Local service is busy; retry shortly.",
    "cancelled": "Subtitle download stopped; provider job was preserved.",
    "invalid_output": "Provider did not return valid subtitles.",
    "too_large": "Subtitle file exceeds the service size limit.",
}
ERROR_MESSAGES.update(PROVIDER_MESSAGES)


class ServiceError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


def error_payload(error: BaseException, source: str = "youtube") -> dict:
    if isinstance(error, (ServiceError, ProviderError)):
        code = error.code
    elif isinstance(error, OSError):
        code = "storage_error"
    else:
        code = "download_failed"
    return {"status": "error", "source": source, "error_code": code, "error": ERROR_MESSAGES[code]}


def validate_video_id(value: str) -> str:
    video_id = str(value or "")
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID")
    return video_id


@dataclass(frozen=True)
class OutputPaths:
    directory: Path
    youtube_srt: Path


def output_paths(root: Path, video_id: str) -> OutputPaths:
    safe_id = validate_video_id(video_id)
    directory = Path(root).expanduser().resolve() / safe_id
    return OutputPaths(directory, directory / f"youtube-{safe_id}-youtube.srt")


def validate_caption_language(language: str) -> str:
    if language not in ("", "en", "zh"):
        raise ValueError("Invalid caption language")
    return language


class SubtitleService:
    def __init__(
        self,
        output_root: Path,
        start_background=None,
        pinyinize=None,
        provider=None,
    ) -> None:
        self.output_root = Path(output_root).expanduser().resolve()
        self.provider = provider if provider is not None else VideoDownloadAPI(self.output_root)
        self.start_background = start_background or self._start_thread
        self.pinyinize = pinyinize or bilingual_srt
        self.lock = threading.Lock()
        # Fixed lock stripes avoid growing a lock map for every requested ID.
        self.subtitle_locks = [threading.Lock() for _ in range(64)]
        self.download_locks = [threading.Lock() for _ in range(64)]
        self.preparation_locks = [threading.Lock() for _ in range(64)]
        self.browser_locks = [threading.Lock() for _ in range(64)]
        self.caption_slots = threading.BoundedSemaphore(1)
        self.caption_jobs = OrderedDict()
        self.caption_active = set()
        self.caption_cancel_events = {}
        self.closing = threading.Event()
        self.local = threading.local()
        self.threads = set()
        self.health_lock = threading.Lock()
        self.health_cached = None
        self.health_checked_at = 0.0

    def health(self) -> dict:
        # Probe module presence, not heavyweight imports/model loading; no network.
        with self.health_lock:
            if self.health_cached is None or time.monotonic() - self.health_checked_at > 60:
                checks = {
                    "pinyin": importlib.util.find_spec("pypinyin") is not None or
                              (sys.platform == "darwin" and bool(shutil.which("swift"))),
                }
                self.health_cached = checks
                self.health_checked_at = time.monotonic()
            checks = dict(self.health_cached)
        checks["video_api"] = bool(self.provider.configured)
        return {"ok": True, "service": "subsanywhere", "api_version": 1,
                "checks": checks, "capabilities": {
                    "existing": all(checks[key] for key in ("video_api", "pinyin")),
                    "video_api_configured": checks["video_api"],
                }}

    @staticmethod
    def _remove_work_file(path: Path):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    @staticmethod
    def _language_required(source="youtube") -> dict:
        return {"status": "missing", "source": source, "language_required": True,
                "available_languages": ["en", "zh"]}

    def _read_preparation(self, preparation_id):
        path = self.output_root / "preparations" / (preparation_id + ".json")
        try:
            with path.open("rb") as source:
                contents = source.read(MAX_PREPARATION_BYTES + 1)
            if len(contents) > MAX_PREPARATION_BYTES:
                raise ValueError("Archive too large")
            return validate_preparation(json.loads(contents), preparation_id)
        except FileNotFoundError:
            return None

    def preparation(self, preparation_id):
        validate_preparation_id(preparation_id)
        with self.preparation_locks[hash(preparation_id) % len(self.preparation_locks)]:
            job = self._read_preparation(preparation_id)
            return {"status": "ready", "job": job} if job else {"status": "missing"}

    def save_preparation(self, preparation_id, job):
        validate_preparation(job, preparation_id)
        with self.preparation_locks[hash(preparation_id) % len(self.preparation_locks)]:
            old = self._read_preparation(preparation_id)
            merged = dict(job)
            if old:
                # An ID cannot be repurposed to overwrite another source/model.
                for field in ("pageKey", "trackId", "provider", "model", "descriptors"):
                    if old[field] != job[field]:
                        raise ValueError("Archive identity mismatch")
                if "sourceTrack" in old and "sourceTrack" in job:
                    for field in ("id", "cues", "sourceVideoId"):
                        if old["sourceTrack"][field] != job["sourceTrack"][field]:
                            raise ValueError("Source track mismatch")
                newer = (job["revision"], job["updatedAt"]) > (old["revision"], old["updatedAt"])
                merged = dict(job if newer else old)
                merged["results"] = {**job["results"], **old["results"]}
                if newer:
                    merged["results"].update(job["results"])
                if "sourceTrack" in old or "sourceTrack" in job:
                    merged["sourceTrack"] = old.get("sourceTrack", job.get("sourceTrack"))
                merged["revision"] = max(old["revision"], job["revision"])
                merged["updatedAt"] = max(old["updatedAt"], job["updatedAt"])
                if old["status"] == "ready" or job["status"] == "ready":
                    merged.update(status="ready", error="")
            validate_preparation(merged, preparation_id)
            contents = json.dumps(merged, ensure_ascii=False, allow_nan=False)
            if len(contents.encode("utf-8")) > MAX_PREPARATION_BYTES:
                raise ValueError("Archive too large")
            path = self.output_root / "preparations" / (preparation_id + ".json")
            path.parent.mkdir(parents=True, exist_ok=True)
            self._write_text_atomically(path, contents)
            self._cache_preparation_source(merged)
            return {"status": "saved", "job": merged}

    def _cache_preparation_source(self, job):
        track = job.get("sourceTrack")
        if not track or track["sourceType"] != "youtube-page" or track["language"] not in ("en", "zh"):
            return
        video_id = validate_video_id(track["sourceVideoId"])
        paths = output_paths(self.output_root, video_id)
        if self._browser_cache(paths, track["language"]):
            return
        def timestamp(seconds):
            milliseconds = round(seconds * 1000)
            hours, milliseconds = divmod(milliseconds, 3600000)
            minutes, milliseconds = divmod(milliseconds, 60000)
            seconds, milliseconds = divmod(milliseconds, 1000)
            return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"
        srt = "\n\n".join(
            f"{index}\n{timestamp(cue['start'])} --> {timestamp(cue['end'])}\n{cue['text']}"
            for index, cue in enumerate(track["cues"], 1)
        ) + "\n"
        self.cache_subtitles({"videoId": video_id, "language": track["language"], "source": "page", "srt": srt})

    def cache_subtitles(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"videoId", "language", "srt", "source"}:
            raise ValueError("Invalid browser cache fields")
        video_id = validate_video_id(payload["videoId"])
        language = payload["language"]
        if language not in ("en", "zh") or payload["source"] != "page":
            raise ValueError("Invalid browser caption source")
        contents = bounded_text(payload["srt"], MAX_SUBTITLE_BYTES, True)
        if len(contents.encode("utf-8")) > MAX_SUBTITLE_BYTES:
            raise ValueError("Browser subtitles too large")
        self._validate_srt(contents)
        paths = output_paths(self.output_root, video_id)
        with self.browser_locks[hash(video_id) % len(self.browser_locks)]:
            paths.directory.mkdir(parents=True, exist_ok=True)
            path = paths.directory / ("browser-" + language + ".srt")
            record = {"version": CAPTION_CACHE_VERSION, "language": language, "source": "page",
                      "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest()}
            self._write_text_atomically(path, contents)
            self._write_text_atomically(path.with_suffix(".language.json"), json.dumps(record))
            return self._subtitle_payload(path, "page", contents, language)

    def _browser_cache(self, paths, language):
        with self.browser_locks[hash(paths.directory.name) % len(self.browser_locks)]:
            path = paths.directory / ("browser-" + language + ".srt")
            try:
                with path.with_suffix(".language.json").open(encoding="utf-8") as source:
                    record = json.loads(source.read(8192))
                if (not isinstance(record, dict) or record.get("version") != CAPTION_CACHE_VERSION
                        or record.get("language") != language or record.get("source") != "page"):
                    return None
                contents = self._read_subtitle(path)
                if hashlib.sha256(contents.encode("utf-8")).hexdigest() != record.get("sha256"):
                    return None
                self._validate_srt(contents)
                return self._subtitle_payload(path, "page", contents, language)
            except (OSError, ValueError, ServiceError):
                return None

    def _caption_cache(self, paths, language):
        localized = paths.youtube_srt.with_name(paths.youtube_srt.stem + "-" + language + ".srt")
        return localized, (self._browser_cache(paths, language)
                           or self._cached_youtube_payload(localized, language)
                           or self._cached_youtube_payload(paths.youtube_srt, language))

    def existing(self, video_id: str, language: str = "") -> dict:
        safe_id = validate_video_id(video_id)
        language = validate_caption_language(language)
        self._check_cancelled()
        if not language:
            return self._language_required()
        paths = output_paths(self.output_root, safe_id)
        download_lock = self.download_locks[hash((safe_id, language)) % len(self.download_locks)]
        if not download_lock.acquire(timeout=10):
            raise ServiceError("busy")
        try:
            _, cached = self._caption_cache(paths, language)
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
        """Nonblocking facade; provider IDs survive timeout and restart."""
        safe_id = validate_video_id(video_id)
        language = validate_caption_language(language)
        if not language:
            return self._language_required()
        key = (safe_id, language)
        paths = output_paths(self.output_root, safe_id)
        with self.lock:
            self._check_cancelled()
            _, ready = self._caption_cache(paths, language)
            if ready:
                return ready
            cached = self.caption_jobs.get(key)
            if cached:
                updated, payload = cached
                if payload["status"] == "ready":
                    _, ready = self._caption_cache(paths, language)
                    if ready:
                        return ready
                cooldown = 10 if payload["status"] == "error" else 60
                if payload["status"] == "running" or (payload["status"] != "ready" and time.monotonic() - updated < cooldown):
                    return dict(payload)
            if self.caption_active:
                raise ServiceError("busy")
            self.caption_active.add(safe_id)
            self.caption_cancel_events[safe_id] = threading.Event()
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
                self.caption_cancel_events.pop(safe_id, None)
                self.caption_jobs[key] = (time.monotonic(), error_payload(ServiceError("start_failed"), "youtube"))
        with self.lock:
            result = dict(self.caption_jobs[key][1])
        if result["status"] == "ready":
            return self._caption_cache(paths, language)[1] or error_payload(ServiceError("invalid_output"), "youtube")
        return result

    def _existing_worker(self, video_id: str, language: str = ""):
        self.local.cancel_event = self.caption_cancel_events[video_id]
        try:
            result = self.existing(video_id, language)
            result = {key: value for key, value in result.items() if key != "srt"}
        except BaseException as error:
            result = error_payload(error, "youtube")
        with self.lock:
            self.caption_jobs[(video_id, language)] = (time.monotonic(), result)
            self.caption_active.discard(video_id)
            self.caption_cancel_events.pop(video_id, None)
        self.local.cancel_event = None

    def _download_existing(self, safe_id: str, paths: OutputPaths, requested_language: str = "") -> dict:
        if requested_language not in ("en", "zh"):
            return self._language_required()
        language = requested_language
        paths.directory.mkdir(parents=True, exist_ok=True)
        destination, _ = self._caption_cache(paths, language)
        with tempfile.TemporaryDirectory(prefix=".captions-", dir=paths.directory) as directory:
            candidate = Path(directory) / "subtitles.srt"
            self.provider.acquire(safe_id, language, "subtitles", candidate,
                                  cancel=self._check_cancelled, limit=MAX_SUBTITLE_BYTES)
            contents = self._clean_srt(self._read_subtitle(candidate))
            self._validate_srt(contents)
            if language == "zh":
                contents = self._pinyinize_srt(candidate, contents)
            else:
                self._write_text_atomically(candidate, contents)
            self._check_cancelled()
            record = {"version": CAPTION_CACHE_VERSION, "language": language,
                      "requested_language": language, "provider": "video-download-api",
                      "sha256": hashlib.sha256(contents.encode("utf-8")).hexdigest()}
            self._write_text_atomically(destination.with_suffix(".language.json"), json.dumps(record))
            candidate.replace(destination)
            return self._subtitle_payload(destination, "youtube", contents, language)

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

    def close(self) -> None:
        self.closing.set()
        with self.lock:
            for event in self.caption_cancel_events.values():
                event.set()
            threads = list(self.threads)
        deadline = time.monotonic() + 5
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(max(0, deadline - time.monotonic()))

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


def handler_for(service):

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
            if (len(self.headers.get_all("Host", [])) != 1 or not valid_host
                    or len(origins) > 1 or (origins and not EXTENSION_ORIGIN_PATTERN.fullmatch(origins[0]))):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden host or origin"}, cors=False)
                return False
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get_all("Transfer-Encoding") or len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid request framing"})
                return False
            body_limit = self._body_limit()
            if lengths and int(lengths[0]) > body_limit:
                self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Request body exceeds route limit"})
                return False
            return True

        def _new_route(self):
            parsed = urlparse(self.path)
            if self.path != parsed.path or parsed.params or parsed.query or parsed.fragment or parsed.netloc or parsed.scheme:
                return None
            match = PREPARATION_PATH_PATTERN.fullmatch(parsed.path)
            if match:
                return ("preparation", match[1])
            if parsed.path == "/api/subtitles/cache":
                return ("cache", None)
            return None

        def _body_limit(self):
            route = self._new_route()
            if route and self.command == "PUT" and route[0] == "preparation":
                return MAX_PREPARATION_BYTES
            if route and self.command == "POST" and route[0] == "cache":
                return MAX_CACHE_BODY_BYTES
            return 0

        def do_OPTIONS(self) -> None:
            origin = self.headers.get("Origin", "")
            requested_headers = {name.strip().lower() for name in self.headers.get("Access-Control-Request-Headers", "").split(",") if name.strip()}
            route = self._new_route()
            methods = {"GET", "PUT"} if route and route[0] == "preparation" else ({"POST"} if route else {"GET"})
            allowed_headers = {"x-subsanywhere-client", "content-type"} if route else {"x-subsanywhere-client"}
            if (not EXTENSION_ORIGIN_PATTERN.fullmatch(origin)
                    or self.headers.get("Access-Control-Request-Method", "GET") not in methods
                    or not requested_headers.issubset(allowed_headers)):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden origin"})
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors_headers(origin)
            self.end_headers()

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                payload = service.health() if hasattr(service, "health") else {"ok": True, "service": "subsanywhere", "api_version": 1}
                self._send_json(HTTPStatus.OK, payload)
                return
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            route = self._new_route()
            if route and route[0] == "preparation":
                self._archive_action(lambda: service.preparation(route[1]))
                return
            actions = {
                "/api/subtitles/existing": getattr(service, "existing_job", service.existing),
            }
            self._run_action(actions.get(parsed.path), parsed)

        def do_POST(self) -> None:
            self._write_archive()

        def do_PUT(self) -> None:
            self._write_archive()

        def _write_archive(self):
            if not self._authorized():
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden client"})
                return
            route = self._new_route()
            if not route or not self._body_limit():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            content_types = self.headers.get_all("Content-Type", [])
            if (len(content_types) != 1 or not re.fullmatch(
                    r'application/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?', content_types[0], re.I)):
                self._send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "JSON Content-Type required"})
                return
            def write():
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("Body required")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete body")
                def unique_object(pairs):
                    result = {}
                    for key, value in pairs:
                        if key in result:
                            raise ValueError("Duplicate JSON field")
                        result[key] = value
                    return result
                def invalid_constant(value):
                    raise ValueError("Invalid JSON constant")
                payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                                     parse_constant=invalid_constant)
                return (service.save_preparation(route[1], payload) if route[0] == "preparation"
                        else service.cache_subtitles(payload))
            self._archive_action(write)

        def _archive_action(self, action):
            try:
                self._send_json(HTTPStatus.OK, action())
            except (ValueError, RecursionError, TimeoutError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid archive request"})
            except ServiceError as error:
                status = HTTPStatus.BAD_REQUEST if error.code == "invalid_output" else HTTPStatus.INTERNAL_SERVER_ERROR
                self._send_json(status, error_payload(error))
            except Exception:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Archive storage unavailable"})

        def _run_action(self, action, parsed) -> None:
            if action is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
                return
            try:
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=4)
                options = {}
                if parsed.path == "/api/subtitles/existing" and "language" in query:
                    languages = query.pop("language")
                    if len(languages) != 1 or languages[0] not in {"", "en", "zh"}:
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
            route = self._new_route()
            methods = "GET, PUT, OPTIONS" if route and route[0] == "preparation" else ("POST, OPTIONS" if route else "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Methods", methods)
            self.send_header("Access-Control-Allow-Headers", "X-SubsAnywhere-Client, Content-Type" if route else "X-SubsAnywhere-Client")
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


def create_server(service, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, max_requests=16) -> BoundedHTTPServer:
    return BoundedHTTPServer((host, port), handler_for(service), max_requests)


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
