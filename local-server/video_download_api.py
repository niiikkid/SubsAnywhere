"""Bounded HTTPS Video Download API client with durable, charge-safe jobs.

Accepted jobs are never resubmitted, including after timeout, cancellation or
restart. An ambiguous submit is deliberately blocked until manually reconciled.
No provider response text, request URL or credential is exposed in exceptions.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

MESSAGES = {
    "provider_unconfigured": "Не задан ключ Video Download API.",
    "provider_auth": "Неверный ключ Video Download API.",
    "provider_balance": "Недостаточно средств Video Download API.",
    "provider_captions_missing": "Субтитры на выбранном языке не найдены.",
    "provider_failure": "Не удалось скачать через Video Download API.",
    "provider_timeout": "Ожидание истекло. Повторите проверку — задание сохранено.",
    "provider_uncertain": "Статус отправки неизвестен. Не повторяем платный запрос.",
    "provider_unsafe": "API вернул небезопасную ссылку.",
    "cancelled": "Загрузка отменена. Задание API сохранено.",
    "too_large": "Файл превышает допустимый размер.",
}


class ProviderError(RuntimeError):
    def __init__(self, code="provider_failure"):
        self.code = code if code in MESSAGES else "provider_failure"
        super().__init__(MESSAGES[self.code])


def classify_error(payload, status=200):
    # Inspect only to classify; never return untrusted provider text.
    text = " ".join(str(payload.get(key, "")) for key in ("error", "text", "message")).lower()
    if status in (401, 403) or any(word in text for word in ("invalid api", "invalid key", "api key", "apikey", "unauthorized")):
        return "provider_auth"
    if status == 402 or any(word in text for word in ("balance", "credit", "insufficient funds")):
        return "provider_balance"
    if any(word in text for word in ("no subtitle", "no caption", "subtitles not", "captions not", "subtitle not", "transcript not")):
        return "provider_captions_missing"
    return "provider_failure"


def safe_url(url):
    try:
        parts = urlsplit(url)
        if (not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 33 for c in url)
                or parts.scheme != "https" or not parts.hostname or parts.username is not None
                or parts.password is not None or parts.fragment or parts.port not in (None, 443)
                or "\\" in url):
            raise ValueError()
        if parts.hostname.rstrip(".").lower() in ("localhost", "localhost.localdomain"):
            raise ValueError()
        # Reject literal unsafe addresses immediately; DNS is checked/pinned below.
        try:
            address = ipaddress.ip_address(parts.hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError()
        return parts
    except (ValueError, TypeError, AttributeError):
        raise ProviderError("provider_unsafe") from None


def public_addresses(host):
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        if not answers or any(not ipaddress.ip_address(item[4][0]).is_global for item in answers):
            raise ProviderError("provider_unsafe")
        return answers
    except (OSError, ValueError):
        raise ProviderError("provider_unsafe") from None


class _PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once and connect to the validated address; TLS still verifies
        # the original hostname. No environment proxies or DNS-rebinding window.
        answers = public_addresses(self.host)
        last = None
        for family, socktype, proto, _, address in answers:
            sock = socket.socket(family, socktype, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as error:
                last = error
                sock.close()
        raise last or OSError()


class HTTPS:
    def fetch(self, url, *, limit, cancel, destination=None):
        """Return bounded bytes or stream into destination. Redirects are bounded.

        Never follow a redirect carrying a submission credential: a redirected
        submit is ambiguous and cannot safely be retried.
        """
        deadline = time.monotonic() + (600 if destination else 60)
        initial = safe_url(url)
        credentialed = bool(set(parse_qs(initial.query)) & {"api", "apikey"})
        for redirects in range(4):
            cancel()
            parts = safe_url(url)
            connection = _PinnedHTTPS(parts.hostname, timeout=15, context=ssl.create_default_context())
            try:
                connection.request("GET", parts.path + ("?" + parts.query if parts.query else ""),
                                   headers={"Accept-Encoding": "identity", "User-Agent": "SubsAnywhere/1"})
                response = connection.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    if credentialed or redirects == 3:
                        raise ProviderError("provider_unsafe")
                    url = urljoin(url, response.getheader("Location", ""))
                    safe_url(url)
                    continue
                if response.getheader("Content-Encoding", "identity").lower() != "identity":
                    raise ProviderError()
                if not 200 <= response.status < 300:
                    limit = min(limit, 65536)
                length = response.getheader("Content-Length")
                if length is not None and (not length.isdigit() or int(length) > limit):
                    raise ProviderError("too_large")
                data = bytearray()
                used = 0
                while True:
                    cancel()
                    if time.monotonic() >= deadline:
                        raise ProviderError("provider_timeout")
                    chunk = response.read(min(65536, limit - used + 1))
                    if not chunk:
                        break
                    used += len(chunk)
                    if used > limit:
                        raise ProviderError("too_large")
                    if destination is not None and 200 <= response.status < 300:
                        destination.write(chunk)
                    else:
                        data.extend(chunk)
                if length is not None and used != int(length):
                    raise ProviderError()
                if not 200 <= response.status < 300:
                    try:
                        payload = json.loads(data)
                    except (ValueError, UnicodeError):
                        payload = {}
                    raise ProviderError(classify_error(payload if isinstance(payload, dict) else {}, response.status))
                return bytes(data) if destination is None else used
            except ProviderError:
                raise
            except (OSError, http.client.HTTPException):
                raise ProviderError("provider_timeout") from None
            finally:
                connection.close()
        raise ProviderError("provider_unsafe")


class VideoDownloadAPI:
    def __init__(self, root, *, key=None, base_url=None, transport=None, poll_seconds=2, poll_timeout=180):
        self.root = Path(root)
        self._explicit_key = key
        self.base_url = (base_url or os.environ.get("SUBSANYWHERE_VIDEO_API_URL", "https://p.savenow.to")).rstrip("/")
        parts = safe_url(self.base_url)
        if parts.query or parts.path not in ("", "/"):
            raise ProviderError("provider_unsafe")
        self.transport = transport or HTTPS()
        self.poll_seconds = poll_seconds
        self.poll_timeout = poll_timeout
        self.locks = [threading.Lock() for _ in range(64)]

    def _key(self):
        value = self._explicit_key if self._explicit_key is not None else os.environ.get("SUBSANYWHERE_VIDEO_API_KEY", "")
        if not value and self._explicit_key is None:
            path = Path(os.environ.get("SUBSANYWHERE_VIDEO_API_KEY_FILE", str(
                Path.home() / "Library/Application Support/SubsAnywhere/video-api-key"))).expanduser()
            try:
                with path.open("r", encoding="utf-8") as source:
                    value = source.read(4097).strip()
            except (OSError, UnicodeError):
                value = ""
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(ord(c) < 33 for c in value.strip()):
            raise ProviderError("provider_unconfigured")
        return value.strip()

    @property
    def configured(self):
        try:
            self._key()
            return True
        except ProviderError:
            return False

    def state_path(self, video, language, kind):
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video) or language not in ("en", "zh") or kind not in ("subtitles", "audio"):
            raise ValueError("Invalid provider job identity")
        return self.root / video / f".video-api-{kind}-{language}.json"

    @staticmethod
    def _save(path, state):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                os.chmod(temporary, 0o600)
                json.dump(state, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def _json(self, url, cancel):
        try:
            data = self.transport.fetch(url, limit=65536, cancel=cancel)
            payload = json.loads(data)
            if not isinstance(payload, dict):
                raise ValueError()
            return payload
        except (ValueError, UnicodeError):
            raise ProviderError() from None

    def _remote(self, url):
        safe_url(url)
        if set(parse_qs(urlsplit(url).query)) & {"api", "apikey"}:
            raise ProviderError("provider_unsafe")
        # Do not allow an echoed key into persistence, polling, or file requests.
        try:
            key = self._key()
        except ProviderError:
            key = None
        if key and key in url:
            raise ProviderError("provider_unsafe")
        return url

    def acquire(self, video, language, kind, target, *, cancel=lambda: None, limit=5 * 1024 * 1024):
        path = self.state_path(video, language, kind)
        with self.locks[hash(str(path)) % len(self.locks)]:
            cancel()
            try:
                with path.open(encoding="utf-8") as stream:
                    state = json.loads(stream.read(16385))
                if not isinstance(state, dict) or state.get("state") not in ("submitting", "accepted", "ready", "error"):
                    raise ValueError()
            except FileNotFoundError:
                state = None
            except (ValueError, UnicodeError):
                raise ProviderError("provider_uncertain") from None
            if state is None:
                key = self._key()
                params = {"url": f"https://www.youtube.com/watch?v={video}", "format": "srt" if kind == "subtitles" else "flac"}
                if kind == "subtitles":
                    endpoint = "/ajax/subtitles"
                    params.update(api=key, lang="zh-Hans" if language == "zh" else "en")
                else:
                    endpoint = "/ajax/download.php"
                    params.update(apikey=key, audio_language="zh-CN" if language == "zh" else "en")
                # Persist BEFORE submit: lost responses must not cause a second charge.
                self._save(path, {"state": "submitting"})
                try:
                    response = self._json(self.base_url + endpoint + "?" + urlencode(params), cancel)
                except ProviderError as error:
                    if error.code in ("provider_auth", "provider_balance", "provider_captions_missing"):
                        self._save(path, {"state": "error", "error_code": error.code})
                    raise
                identity = response.get("id")
                if not isinstance(identity, str) or not identity or len(identity) > 512 or key in identity:
                    code = classify_error(response)
                    self._save(path, {"state": "error", "error_code": code})
                    raise ProviderError(code)
                progress = response.get("progress_url")
                # Persist ID even if the supplied progress link is unusable.
                # The documented ID endpoint always remains a safe resume path.
                try:
                    progress = self._remote(urljoin(self.base_url + "/", progress)) if isinstance(progress, str) and progress else None
                    if progress is None:
                        raise ProviderError("provider_unsafe")
                except ProviderError:
                    progress = self.base_url + "/ajax/progress.php?" + urlencode({"id": identity})
                state = {"state": "accepted", "id": identity, "progress_url": progress}
                self._save(path, state)
            if state["state"] == "submitting":
                raise ProviderError("provider_uncertain")
            if state["state"] == "error":
                raise ProviderError(state.get("error_code"))
            deadline = time.monotonic() + self.poll_timeout
            while state["state"] != "ready":
                cancel()
                response = self._json(self._remote(state["progress_url"]), cancel)
                progress = response.get("progress")
                if type(progress) is not int or not 0 <= progress <= 1000:
                    raise ProviderError()
                if progress == 1000:
                    success = response.get("success")
                    url = response.get("download_url")
                    if not (success is True or type(success) is int and success == 1) or not isinstance(url, str) or not url.strip():
                        code = classify_error(response)
                        self._save(path, dict(state, state="error", error_code=code))
                        raise ProviderError(code)
                    try:
                        url = self._remote(url)
                    except ProviderError:
                        self._save(path, dict(state, state="error", error_code="provider_unsafe"))
                        raise
                    state = dict(state, state="ready", download_url=url)
                    self._save(path, state)
                    break
                if time.monotonic() >= deadline:
                    raise ProviderError("provider_timeout")
                until = min(deadline, time.monotonic() + self.poll_seconds)
                while time.monotonic() < until:
                    cancel()
                    time.sleep(min(0.1, max(0, until - time.monotonic())))
            cancel()
            target = Path(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", dir=target.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    count = self.transport.fetch(self._remote(state["download_url"]), limit=limit,
                                                 cancel=cancel, destination=stream)
                    if not count or count > limit or temporary.stat().st_size > limit:
                        raise ProviderError("too_large" if count else "provider_failure")
                    stream.flush()
                    os.fsync(stream.fileno())
                cancel()
                os.replace(temporary, target)
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
        return target
