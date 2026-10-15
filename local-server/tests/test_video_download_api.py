import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import video_download_api as api
import server
from provider_fixtures import FakeProvider, SRT

VIDEO = "rwnyaH6cTDE"
READY = {"progress": 1000, "success": True, "download_url": "https://files.example/subtitles.srt"}


class Transport:
    def __init__(self, replies, content=b"downloaded"):
        self.replies = list(replies)
        self.content = content
        self.calls = []

    def fetch(self, url, *, limit, cancel, destination=None):
        self.calls.append(url)
        cancel()
        if destination is not None:
            if len(self.content) > limit:
                destination.write(self.content[:limit])
                raise api.ProviderError("too_large")
            destination.write(self.content)
            return len(self.content)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return json.dumps(reply).encode()


def client(root, transport, **kwargs):
    return api.VideoDownloadAPI(root, key="offline-secret-key", transport=transport,
                                poll_seconds=0, **kwargs)


class ProviderTests(unittest.TestCase):
    def test_submit_exact_contract_and_honor_progress_url(self):
        for language in ("en", "zh"):
            for kind in ("subtitles",):
                with self.subTest(language=language, kind=kind), tempfile.TemporaryDirectory() as directory:
                    transport = Transport([{"success": True, "id": "paid-123", "progress_url": "https://worker.example/api/progress?id=paid-123"}, READY])
                    service = client(directory, transport)
                    target = pathlib.Path(directory) / "result"
                    service.acquire(VIDEO, language, kind, target)
                    query = parse_qs(urlsplit(transport.calls[0]).query)
                    self.assertEqual(query["format"], ["srt"])
                    self.assertEqual(query["url"], ["https://www.youtube.com/watch?v=" + VIDEO])
                    if kind == "subtitles":
                        self.assertEqual(urlsplit(transport.calls[0]).path, "/ajax/subtitles")
                        self.assertEqual(query["api"], ["offline-secret-key"])
                        self.assertEqual(query["lang"], ["zh-Hans" if language == "zh" else "en"])
                    self.assertEqual(transport.calls[1], "https://worker.example/api/progress?id=paid-123")
                    record = service.state_path(VIDEO, language, kind).read_text()
                    self.assertNotIn("offline-secret-key", record)
                    self.assertEqual(json.loads(record)["id"], "paid-123")
                    self.assertEqual(target.read_bytes(), b"downloaded")

    def test_pending_is_pending_even_when_success_false_or_download_url_present(self):
        with tempfile.TemporaryDirectory() as directory:
            transport = Transport([{"id": "charged"}, {"progress": 400, "success": False, "download_url": "https://files.example/early"}, READY])
            service = client(directory, transport)
            service.acquire(VIDEO, "en", "subtitles", pathlib.Path(directory) / "result")
            self.assertEqual(len(transport.calls), 4)
            self.assertIn("/ajax/progress.php?id=charged", transport.calls[1])
            self.assertNotIn("early", transport.calls[-1])

    def test_terminal_failure_is_durable_and_never_resubmitted(self):
        for success, url in ((False, None), (0, "https://files.example/result"), (True, ""), ("1", "https://files.example/result")):
            with self.subTest(success=success, url=url), tempfile.TemporaryDirectory() as directory:
                transport = Transport([{"id": "charged"}, {"progress": 1000, "success": success, "download_url": url, "text": "No subtitles found offline-secret-key"}])
                service = client(directory, transport)
                for instance in (service, client(directory, transport)):
                    with self.assertRaises(api.ProviderError) as caught:
                        instance.acquire(VIDEO, "zh", "subtitles", pathlib.Path(directory) / "result")
                    self.assertEqual(caught.exception.code, "provider_captions_missing")
                    self.assertNotIn("offline-secret-key", str(caught.exception))
                self.assertEqual(len(transport.calls), 2)

    def test_timeout_persists_acceptance_before_poll_and_restart_only_polls(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "result"
            transport = Transport([{"id": "charged", "progress_url": "https://worker.example/api/progress?id=charged"}, {"progress": 999, "success": 0}])
            service = client(directory, transport, poll_timeout=0)
            def check_persisted(url, **kwargs):
                if "/api/progress" in url:
                    self.assertEqual(json.loads(service.state_path(VIDEO, "en", "subtitles").read_text())["id"], "charged")
                return original(url, **kwargs)
            original = transport.fetch
            transport.fetch = check_persisted
            with self.assertRaises(api.ProviderError) as caught:
                service.acquire(VIDEO, "en", "subtitles", target)
            self.assertEqual(caught.exception.code, "provider_timeout")
            resumed = Transport([READY])
            client(directory, resumed).acquire(VIDEO, "en", "subtitles", target)
            self.assertEqual(resumed.calls[0], "https://worker.example/api/progress?id=charged")
            self.assertEqual(len(resumed.calls), 2)

    def test_unknown_submission_outcome_blocks_chargeable_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            transport = Transport([api.ProviderError("provider_timeout")])
            target = pathlib.Path(directory) / "result"
            with self.assertRaises(api.ProviderError):
                client(directory, transport).acquire(VIDEO, "en", "subtitles", target)
            with self.assertRaises(api.ProviderError) as caught:
                client(directory, transport).acquire(VIDEO, "en", "subtitles", target)
            self.assertEqual(caught.exception.code, "provider_uncertain")
            self.assertEqual(len(transport.calls), 1)

    def test_download_failure_preserves_old_file_and_ready_record_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / "result"
            target.write_bytes(b"old")
            transport = Transport([{"id": "charged"}, READY], content=b"too big")
            with self.assertRaises(api.ProviderError):
                client(directory, transport).acquire(VIDEO, "en", "subtitles", target, limit=3)
            self.assertEqual(target.read_bytes(), b"old")
            transport = Transport([], content=b"new")
            client(directory, transport).acquire(VIDEO, "en", "subtitles", target, limit=3)
            self.assertEqual(transport.calls, [READY["download_url"]])
            self.assertEqual(target.read_bytes(), b"new")
            self.assertEqual(sorted(p.name for p in target.parent.iterdir()), sorted([VIDEO, "result"]))

    def test_no_key_and_invalid_language_do_not_touch_network_or_submit_record(self):
        with tempfile.TemporaryDirectory() as directory:
            transport = Transport([])
            service = api.VideoDownloadAPI(directory, key="", transport=transport)
            self.assertFalse(service.configured)
            with self.assertRaises(api.ProviderError) as caught:
                service.acquire(VIDEO, "en", "subtitles", pathlib.Path(directory) / "result")
            self.assertEqual(caught.exception.code, "provider_unconfigured")
            for language in ("", "fr", "zh-CN", "../en"):
                with self.assertRaises(ValueError):
                    service.acquire(VIDEO, language, "subtitles", pathlib.Path(directory) / "result")
            self.assertEqual(transport.calls, [])
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [])

    def test_file_key_and_env_precedence_are_private_and_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            keyfile = pathlib.Path(directory) / "key"
            keyfile.write_text("file-secret\n")
            with mock.patch.dict(os.environ, {"SUBSANYWHERE_VIDEO_API_KEY": "", "SUBSANYWHERE_VIDEO_API_KEY_FILE": str(keyfile)}):
                service = api.VideoDownloadAPI(directory)
                self.assertTrue(service.configured)
                self.assertEqual(service._key(), "file-secret")
                with mock.patch.dict(os.environ, {"SUBSANYWHERE_VIDEO_API_KEY": "env-secret"}):
                    self.assertEqual(service._key(), "env-secret")
                keyfile.write_text("x" * 4097)
                self.assertFalse(service.configured)

    def test_cancelled_poll_resumes_without_resubmit(self):
        with tempfile.TemporaryDirectory() as directory:
            transport = Transport([{"id": "charged"}, {"progress": 1, "success": False}])
            service = client(directory, transport)
            def cancel():
                if len(transport.calls) >= 2:
                    raise api.ProviderError("cancelled")
            with self.assertRaises(api.ProviderError) as caught:
                service.acquire(VIDEO, "zh", "subtitles", pathlib.Path(directory) / "result", cancel=cancel)
            self.assertEqual(caught.exception.code, "cancelled")
            resumed = Transport([READY])
            client(directory, resumed).acquire(VIDEO, "zh", "subtitles", pathlib.Path(directory) / "result")
            self.assertNotIn("download.php", resumed.calls[0])

    def test_auth_balance_and_missing_errors_are_short_russian_and_redacted(self):
        for payload, status, expected in (({"error": "Invalid API key secret"}, 400, "provider_auth"),
                                         ({"error": "Not enough balance"}, 400, "provider_balance"),
                                         ({"text": "No subtitles found"}, 200, "provider_captions_missing"),
                                         ({"message": "internal secret"}, 500, "provider_failure")):
            code = api.classify_error(payload, status)
            self.assertEqual(code, expected)
            result = server.error_payload(api.ProviderError(code), "youtube")
            self.assertEqual(result["error_code"], expected)
            self.assertNotIn("secret", result["error"])
            self.assertTrue(any("а" <= c <= "я" for c in result["error"]))


class URLSafetyTests(unittest.TestCase):
    def test_unsafe_urls_and_config_are_rejected(self):
        for url in ("http://example.com/a", "https://127.0.0.1/a", "https://[::1]/a", "https://10.0.0.2/a",
                    "https://169.254.169.254/a", "https://user:pass@example.com/a", "https://example.com:444/a",
                    "https://localhost/a", "https://example.com/a\nInjected: x", "https://example.com/\\evil"):
            with self.subTest(url=url), self.assertRaises(api.ProviderError):
                api.safe_url(url)
        with self.assertRaises(api.ProviderError):
            api.VideoDownloadAPI("unused", base_url="https://example.com/path?api=bad")

    def test_dns_mixed_public_private_is_rejected(self):
        answer = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
                  (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with mock.patch.object(socket, "getaddrinfo", return_value=answer), self.assertRaises(api.ProviderError):
            api.public_addresses("example.com")

    def test_transport_bounds_body_and_rejects_unsafe_redirects(self):
        class Response(io.BytesIO):
            status = 200
            headers = {}
            def getheader(self, key, default=None):
                return self.headers.get(key, default)
        class Connection:
            response = None
            def __init__(self, *args, **kwargs): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return self.response
            def close(self): pass
        for status, headers, body, code in ((200, {"Content-Length": "10"}, b"0123456789", "too_large"),
                                          (200, {}, b"0123456789", "too_large"),
                                          (302, {"Location": "http://localhost/private"}, b"", "provider_unsafe")):
            response = Response(body)
            response.status, response.headers = status, headers
            Connection.response = response
            with mock.patch.object(api, "_PinnedHTTPS", Connection), self.assertRaises(api.ProviderError) as caught:
                api.HTTPS().fetch("https://example.com/file", limit=5, cancel=lambda: None)
            self.assertEqual(caught.exception.code, code)

    def test_credentialed_submit_redirect_is_never_followed(self):
        response = mock.Mock(status=302)
        response.getheader.return_value = "https://other.example/capture"
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch.object(api, "_PinnedHTTPS", return_value=connection) as factory:
            with self.assertRaises(api.ProviderError):
                api.HTTPS().fetch("https://example.com/ajax/subtitles?api=secret", limit=100, cancel=lambda: None)
            self.assertEqual(factory.call_count, 1)


class ServiceProviderTests(unittest.TestCase):
    def test_empty_language_is_missing_without_paid_work_even_async(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider()
            service = server.SubtitleService(pathlib.Path(directory), provider=provider,
                                             start_background=mock.Mock(side_effect=AssertionError("no work")))
            for action in (service.existing, service.existing_job):
                result = action(VIDEO)
                self.assertEqual(result["status"], "missing")
                self.assertTrue(result["language_required"])
                self.assertEqual(result["available_languages"], ["en", "zh"])
            self.assertEqual(provider.calls, [])

    def test_async_captions_language_cache_and_legacy_preservation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            legacy = server.output_paths(root, VIDEO).youtube_srt
            legacy.parent.mkdir()
            legacy.write_text("old unknown captions")
            provider = FakeProvider(contents=SRT.replace("Captions", "你好").encode())
            pending = []
            service = server.SubtitleService(root, provider=provider, start_background=pending.append,
                                             pinyinize=lambda text: text.replace("你好", "nǐ hǎo\n你好"))
            self.assertEqual(service.existing_job(VIDEO, "zh")["status"], "running")
            self.assertEqual(service.existing_job(VIDEO, "zh")["status"], "running")
            self.assertEqual(len(pending), 1)
            pending.pop()()
            chinese = service.existing_job(VIDEO, "zh")
            self.assertIn("nǐ hǎo", chinese["srt"])
            english = service.existing(VIDEO, "en")
            self.assertNotIn("nǐ hǎo", english["srt"])
            self.assertNotEqual(chinese["file_name"], english["file_name"])
            self.assertEqual(service.existing_job(VIDEO, "zh"), chinese)
            restarted = server.SubtitleService(root, provider=FakeProvider(error=AssertionError("cache miss")))
            self.assertEqual(restarted.existing(VIDEO, "en"), english)
            self.assertEqual(restarted.existing(VIDEO, "zh"), chinese)
            self.assertEqual(legacy.read_text(), "old unknown captions")
            self.assertEqual(len(provider.calls), 2)


    def test_invalid_provider_subtitles_do_not_replace_saved_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            legacy = server.output_paths(root, VIDEO).youtube_srt
            legacy.parent.mkdir()
            legacy.write_text("saved")
            service = server.SubtitleService(root, provider=FakeProvider(contents=b"invalid"), start_background=lambda f: f())
            result = service.existing_job(VIDEO, "en")
            self.assertEqual(result["error_code"], "invalid_output")
            self.assertEqual(legacy.read_text(), "saved")
            self.assertFalse(service.caption_active)


if __name__ == "__main__":
    unittest.main()
