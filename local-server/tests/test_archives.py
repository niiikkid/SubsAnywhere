"""Focused offline browser subtitle cache and HTTP-boundary regressions."""
import http.client
import json
import pathlib
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server

VIDEO = "rwnyaH6cTDE"
ORIGIN = "chrome-extension://" + "a" * 32
ROUTE = "/api/subtitles/cache"
SRT = "1\r\n00:00:00,000 --> 00:00:01,000\r\n你好\r\n\r\n"


def browser_captions(language="zh"):
    return {"videoId": VIDEO, "language": language, "srt": SRT, "source": "page"}


class BrowserCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.provider = mock.Mock(configured=False)
        self.provider.acquire.side_effect = AssertionError("No provider calls allowed")
        self.service = self.new_service()

    def new_service(self):
        service = server.SubtitleService(self.root, provider=self.provider,
                                         start_background=mock.Mock(side_effect=AssertionError("No worker allowed")),
                                         pinyinize=mock.Mock(side_effect=AssertionError("Preserve page SRT exactly")))
        self.addCleanup(service.close)
        return service

    def test_restart_reads_exact_browser_srt_and_preserves_historical_data_without_provider(self):
        legacy = self.root / "preparations" / ("a" * 64 + ".json")
        legacy.parent.mkdir()
        legacy_contents = b'{"historical":"opaque legacy data"}\n'
        legacy.write_bytes(legacy_contents)
        for language in ("en", "zh"):
            self.service.cache_subtitles(browser_captions(language))
        self.service.close()
        restarted = self.new_service()
        for language in ("en", "zh"):
            for payload in (restarted.existing_job(VIDEO, language), restarted.existing(VIDEO, language)):
                self.assertEqual(payload["source"], "page")
                self.assertEqual(payload["srt"], SRT)
                self.assertEqual(payload["file_name"], "browser-" + language + ".srt")
        self.provider.acquire.assert_not_called()
        self.assertEqual(legacy.read_bytes(), legacy_contents)
        self.assertEqual(sorted(p.name for p in (self.root / VIDEO).iterdir()),
                         ["browser-en.language.json", "browser-en.srt", "browser-zh.language.json", "browser-zh.srt"])

    def test_atomic_failure_preserves_prior_browser_srt(self):
        self.service.cache_subtitles(browser_captions())
        with mock.patch.object(server.os, "fsync", side_effect=OSError("offline fixture")):
            with self.assertRaises(OSError):
                self.service.cache_subtitles({**browser_captions(), "srt": SRT.replace("你好", "再见")})
        self.assertEqual(self.service.existing_job(VIDEO, "zh")["srt"], SRT)
        self.assertFalse(list((self.root / VIDEO).glob("*.tmp")))

    def test_browser_cache_validates_srt_size_and_keeps_provider_files(self):
        paths = server.output_paths(self.root, VIDEO)
        paths.directory.mkdir()
        paths.youtube_srt.write_text("historical provider file")
        payload = {"videoId": VIDEO, "language": "en", "srt": SRT, "source": "page"}
        self.service.cache_subtitles(payload)
        for changes in ({"srt": "bad"}, {"source": "youtube"}, {"language": "fr"},
                        {"srt": "x" * (server.MAX_SUBTITLE_BYTES + 1)}, {"apiKey": "fixture"}):
            with self.subTest(changes=list(changes)), self.assertRaises((ValueError, server.ServiceError)):
                self.service.cache_subtitles({**payload, **changes})
        self.assertEqual(self.service.existing_job(VIDEO, "en")["srt"], SRT)
        self.assertEqual(paths.youtube_srt.read_text(), "historical provider file")


class BrowserCacheHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.provider = mock.Mock(configured=False)
        self.provider.acquire.side_effect = AssertionError("No network provider calls")
        self.service = server.SubtitleService(pathlib.Path(self.directory.name), provider=self.provider)
        self.httpd = server.create_server(self.service, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)
        self.service.close()
        self.directory.cleanup()

    def request(self, method="GET", path=ROUTE, payload=None, headers=None, body=None):
        default = {"X-SubsAnywhere-Client": "extension-v1", "Origin": ORIGIN}
        if payload is not None:
            body = json.dumps(payload).encode()
            default["Content-Type"] = "application/json"
        if headers:
            for key, value in headers.items():
                if value is None:
                    default.pop(key, None)
                else:
                    default[key] = value
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=default)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read() or b"null")
        finally:
            connection.close()

    def test_http_browser_cache_and_exact_existing_readback(self):
        status, _, saved = self.request("POST", payload=browser_captions())
        self.assertEqual(status, 200)
        self.assertEqual((saved["status"], saved["source"], saved["srt"]), ("ready", "page", SRT))
        ready = self.request(path="/api/subtitles/existing?video_id=" + VIDEO + "&language=zh")[2]
        self.assertEqual(ready, saved)
        self.assertEqual((ready["source"], ready["srt"]), ("page", SRT))
        self.provider.acquire.assert_not_called()

    def test_origin_host_client_and_content_type_guards(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Host": "attacker.example"}, {"X-SubsAnywhere-Client": None}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", payload=browser_captions(), headers=headers)[0], 403)
        for content_type in (None, "text/plain", "application/json; nope=1"):
            self.assertEqual(self.request("POST", payload=browser_captions(), headers={"Content-Type": content_type})[0], 415)
        self.assertEqual(self.request("POST", payload=browser_captions(), headers={"Content-Type": "application/json; charset=utf-8"})[0], 200)
        for body in (b'{"srt":1,"srt":2}', b'{"srt":NaN}', b'[]', b'{}'):
            self.assertEqual(self.request("POST", body=body, headers={"Content-Type": "application/json"})[0], 400)

    def test_exact_cache_preflight_keeps_other_routes_get_only(self):
        status, headers, _ = self.request("OPTIONS", headers={
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "POST, OPTIONS")
        self.assertIn("Content-Type", headers["Access-Control-Allow-Headers"])
        for path in ("/api/subtitles/existing", ROUTE + "?x=1", ROUTE + ";x", ROUTE + "/", "/api/words",
                     "/api/preparations/" + "a" * 64):
            self.assertEqual(self.request("OPTIONS", path, headers={
                "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type"})[0], 403)
        self.assertEqual(self.request("OPTIONS", headers={"Access-Control-Request-Method": "PUT"})[0], 403)
        status, headers, _ = self.request("OPTIONS", "/api/subtitles/existing", headers={"Access-Control-Request-Method": "GET"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, OPTIONS")
        self.assertNotIn("Content-Type", headers["Access-Control-Allow-Headers"])

    def test_bodies_only_on_cache_post_and_bounded_framing(self):
        for method, path in (("GET", ROUTE), ("PUT", ROUTE),
                             ("POST", "/api/subtitles/existing"), ("POST", ROUTE + "?x=1"),
                             ("POST", ROUTE + ";x"), ("POST", ROUTE + "/"),
                             ("PUT", "/api/preparations/" + "a" * 64)):
            self.assertEqual(self.request(method, path, body=b"{}")[0], 413)
        self.assertEqual(self.request("POST", payload=browser_captions(), headers={"Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.request("POST", headers={"Content-Length": str(server.MAX_CACHE_BODY_BYTES + 1)})[0], 413)
        # Use raw framing to prove duplicate lengths are rejected, even identical ones.
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as connection:
            connection.sendall((f"POST {ROUTE} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                                "X-SubsAnywhere-Client: extension-v1\r\nContent-Length: 2\r\n"
                                "Content-Length: 2\r\nContent-Type: application/json\r\n\r\n{}").encode())
            self.assertIn(b"400 Bad Request", connection.recv(4096))

    def test_only_subtitle_cache_is_exposed_without_creating_legacy_data(self):
        for path in (ROUTE, "/api/preparations/" + "a" * 64):
            self.assertEqual(self.request(path=path)[0], 404)
            self.assertEqual(self.request("PUT", path)[0], 501)
        self.assertFalse((pathlib.Path(self.directory.name) / "preparations").exists())


if __name__ == "__main__":
    unittest.main()
