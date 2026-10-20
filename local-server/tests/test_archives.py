"""Focused offline archive/storage and HTTP-boundary regression fixtures."""
import copy
import http.client
import json
import pathlib
import socket
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server

ID = "a" * 64
VIDEO = "rwnyaH6cTDE"
ORIGIN = "chrome-extension://" + "a" * 32
ROUTE = "/api/preparations/" + ID
SRT = "1\r\n00:00:00,000 --> 00:00:01,000\r\n你好\r\n\r\n"


def job(count=2):
    descriptors = [{"key": "caption\x00Line " + str(index), "sourceText": "Line " + str(index),
                    "displayText": "Line " + str(index), "language": "", "characters": ""}
                   for index in range(count)]
    return {"id": ID, "pageKey": "https://www.youtube.com/watch?v=" + VIDEO,
            "trackId": "track", "provider": "openrouter", "model": "offline-fixture",
            "status": "running", "error": "", "descriptors": descriptors, "results": {},
            "revision": 1, "updatedAt": 1000,
            "sourceTrack": {"id": "track", "name": "Captions", "language": "en",
                            "sourceType": "youtube-page", "sourceVideoId": VIDEO,
                            "cues": [{"start": index, "end": index + 1, "text": "Line " + str(index)}
                                     for index in range(count)]}}


def result():
    return {"items": [{"text": "Line", "dictionary": "Перевод", "isSentenceTranslation": True,
                       "start": 0, "end": 4, "glossary": [{"text": "Line", "translation": "Строка",
                                                             "sourceStart": 0, "sourceEnd": 4}]}]}


class ArchiveTests(unittest.TestCase):
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

    def test_restart_reads_exact_preparation_and_browser_srt_without_provider(self):
        initial = job()
        initial["results"] = {item["key"]: result() for item in initial["descriptors"]}
        initial["status"] = "ready"
        saved = self.service.save_preparation(ID, initial)
        self.assertEqual(saved, {"status": "saved", "job": initial})
        for language in ("en", "zh"):
            self.service.cache_subtitles({"videoId": VIDEO, "language": language, "srt": SRT, "source": "page"})
        self.service.close()
        restarted = self.new_service()
        self.assertEqual(restarted.preparation(ID), {"status": "ready", "job": initial})
        self.assertEqual(restarted.preparation("b" * 64), {"status": "missing"})
        for language in ("en", "zh"):
            for payload in (restarted.existing_job(VIDEO, language), restarted.existing(VIDEO, language)):
                self.assertEqual(payload["source"], "page")
                self.assertEqual(payload["srt"], SRT)
                self.assertEqual(payload["file_name"], "browser-" + language + ".srt")
        self.provider.acquire.assert_not_called()
        self.assertTrue((self.root / "preparations" / (ID + ".json")).is_file())
        self.assertEqual(sorted(p.name for p in (self.root / VIDEO).iterdir()),
                         ["browser-en.language.json", "browser-en.srt", "browser-zh.language.json", "browser-zh.srt"])

    def test_preparation_migrates_browser_only_source_and_allows_display_label_changes(self):
        initial = job(1)
        initial["results"] = {initial["descriptors"][0]["key"]: result()}
        initial["status"] = "ready"
        self.service.save_preparation(ID, initial)
        restarted = self.new_service()
        cached = restarted.existing_job(VIDEO, "en")
        self.assertEqual(cached["source"], "page")
        self.assertIn("Line 0", cached["srt"])
        renamed = copy.deepcopy(initial)
        renamed["sourceTrack"]["name"] = "A new display label"
        renamed["revision"] += 1
        self.assertEqual(restarted.save_preparation(ID, renamed)["job"]["status"], "ready")
        self.provider.acquire.assert_not_called()

    def test_stale_put_unions_successes_and_never_downgrades_ready(self):
        first = job()
        keys = [item["key"] for item in first["descriptors"]]
        first["results"][keys[0]] = result()
        first["revision"] = 8
        self.service.save_preparation(ID, first)
        stale = job()
        stale["results"][keys[1]] = result()
        merged = self.service.save_preparation(ID, stale)["job"]
        self.assertEqual(set(merged["results"]), set(keys))
        self.assertEqual(merged["revision"], 8)
        merged.update(status="ready", revision=9)
        self.service.save_preparation(ID, merged)
        incoming = job()
        incoming.update(status="error", error="interrupted", revision=100, updatedAt=2000)
        kept = self.service.save_preparation(ID, incoming)["job"]
        self.assertEqual(kept["status"], "ready")
        self.assertEqual(kept["error"], "")
        self.assertEqual(set(kept["results"]), set(keys))
        self.assertIn("sourceTrack", kept)

    def test_concurrent_puts_preserve_all_ten_successes(self):
        initial = job(10)
        barrier = threading.Barrier(10)
        def save(index):
            current = copy.deepcopy(initial)
            current["results"][current["descriptors"][index]["key"]] = result()
            barrier.wait(3)
            return self.service.save_preparation(ID, current)
        with ThreadPoolExecutor(max_workers=10) as workers:
            list(workers.map(save, range(10)))
        saved = self.service.preparation(ID)["job"]
        self.assertEqual(set(saved["results"]), {item["key"] for item in initial["descriptors"]})
        self.assertFalse(list((self.root / "preparations").glob("*.tmp")))

    def test_validation_rejects_ids_credentials_unknown_fields_and_invalid_ready(self):
        initial = job()
        for invalid in ("A" * 64, "a" * 63, "../" + ID, ID + "\n", None):
            with self.subTest(id=invalid), self.assertRaises(ValueError):
                self.service.preparation(invalid)
        variants = []
        for field, value in (("id", "b" * 64), ("apiKey", "not-a-real-key"), ("extra", True),
                             ("provider", ""), ("model", 3), ("status", "done"),
                             ("revision", True), ("updatedAt", float("nan")), ("status", "ready")):
            candidate = copy.deepcopy(initial)
            candidate[field] = value
            variants.append(candidate)
        candidate = copy.deepcopy(initial)
        candidate["results"]["unknown"] = result()
        variants.append(candidate)
        candidate = copy.deepcopy(initial)
        candidate["descriptors"].append(candidate["descriptors"][0])
        variants.append(candidate)
        candidate = copy.deepcopy(initial)
        candidate["sourceTrack"]["cues"][0]["end"] = -1
        variants.append(candidate)
        candidate = copy.deepcopy(initial)
        candidate["results"][candidate["descriptors"][0]["key"]] = {"items": [{"dictionary": "", "isSentenceTranslation": True}]}
        variants.append(candidate)
        candidate = copy.deepcopy(initial)
        candidate["results"][candidate["descriptors"][0]["key"]] = result()
        candidate["results"][candidate["descriptors"][0]["key"]]["items"][0]["api_key"] = "fixture"
        variants.append(candidate)
        for candidate in variants:
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                self.service.save_preparation(ID, candidate)
        self.assertFalse((self.root / "preparations").exists())

    def test_identity_mismatch_and_atomic_failure_preserve_prior_archive(self):
        initial = job()
        self.service.save_preparation(ID, initial)
        changed = copy.deepcopy(initial)
        changed["model"] = "other"
        with self.assertRaises(ValueError):
            self.service.save_preparation(ID, changed)
        with mock.patch.object(server.os, "fsync", side_effect=OSError("offline fixture")):
            with self.assertRaises(OSError):
                self.service.save_preparation(ID, {**initial, "revision": 2})
        self.assertEqual(self.service.preparation(ID)["job"], initial)
        self.assertEqual(len(list((self.root / "preparations").iterdir())), 1)

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


class ArchiveHttpTests(unittest.TestCase):
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

    def test_http_put_get_and_cached_existing_readback(self):
        initial = job()
        self.assertEqual(self.request()[2], {"status": "missing"})
        self.assertEqual(self.request("PUT", payload=initial)[2], {"status": "saved", "job": initial})
        self.assertEqual(self.request()[2], {"status": "ready", "job": initial})
        payload = {"videoId": VIDEO, "language": "zh", "srt": SRT, "source": "page"}
        self.assertEqual(self.request("POST", "/api/subtitles/cache", payload)[0], 200)
        ready = self.request(path="/api/subtitles/existing?video_id=" + VIDEO + "&language=zh")[2]
        self.assertEqual((ready["source"], ready["srt"]), ("page", SRT))
        self.provider.acquire.assert_not_called()

    def test_origin_host_client_and_content_type_guards(self):
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"},
                        {"Host": "attacker.example"}, {"X-SubsAnywhere-Client": None}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("PUT", payload=job(), headers=headers)[0], 403)
        for content_type in (None, "text/plain", "application/json; nope=1"):
            self.assertEqual(self.request("PUT", payload=job(), headers={"Content-Type": content_type})[0], 415)
        self.assertEqual(self.request("PUT", payload=job(), headers={"Content-Type": "application/json; charset=utf-8"})[0], 200)
        self.assertEqual(self.request("PUT", body=b'{"id":1,"id":2}', headers={"Content-Type": "application/json"})[0], 400)

    def test_exact_new_route_preflights_keep_legacy_get_only(self):
        for path, method in ((ROUTE, "PUT"), ("/api/subtitles/cache", "POST")):
            status, headers, _ = self.request("OPTIONS", path, headers={
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"})
            self.assertEqual(status, 204)
            self.assertIn(method, headers["Access-Control-Allow-Methods"])
            self.assertIn("Content-Type", headers["Access-Control-Allow-Headers"])
        for path in ("/api/subtitles/existing", ROUTE + "?x=1", ROUTE + ";x", ROUTE + "/", "/api/words"):
            self.assertEqual(self.request("OPTIONS", path, headers={
                "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "Content-Type"})[0], 403)
        status, headers, _ = self.request("OPTIONS", "/api/subtitles/existing", headers={"Access-Control-Request-Method": "GET"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, OPTIONS")
        self.assertNotIn("Content-Type", headers["Access-Control-Allow-Headers"])

    def test_bodies_only_on_new_methods_and_bounded_framing(self):
        for method, path in (("GET", ROUTE), ("POST", ROUTE), ("PUT", "/api/subtitles/cache"),
                             ("POST", "/api/subtitles/existing"), ("PUT", ROUTE + "?x=1")):
            self.assertEqual(self.request(method, path, body=b"{}")[0], 413)
        self.assertEqual(self.request("PUT", payload=job(), headers={"Transfer-Encoding": "chunked"})[0], 400)
        for path, method, limit in ((ROUTE, "PUT", server.MAX_PREPARATION_BYTES),
                                    ("/api/subtitles/cache", "POST", server.MAX_CACHE_BODY_BYTES)):
            self.assertEqual(self.request(method, path, headers={"Content-Length": str(limit + 1)})[0], 413)
        # Use raw framing to prove duplicate lengths are rejected, even identical ones.
        with socket.create_connection(("127.0.0.1", self.port), timeout=3) as connection:
            connection.sendall((f"PUT {ROUTE} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                                "X-SubsAnywhere-Client: extension-v1\r\nContent-Length: 2\r\n"
                                "Content-Length: 2\r\nContent-Type: application/json\r\n\r\n{}").encode())
            self.assertIn(b"400 Bad Request", connection.recv(4096))

    def test_invalid_id_routes_never_create_archives(self):
        for suffix in ("A" * 64, "a" * 63, "..%2f" + ID, ID + "/", ID + ";x"):
            self.assertEqual(self.request(path="/api/preparations/" + suffix)[0], 404)
        self.assertEqual(self.request("PUT", payload={**job(), "id": "b" * 64})[0], 400)
        self.assertEqual(self.request("PUT", payload={**job(), "status": "ready"})[0], 400)
        self.assertFalse((pathlib.Path(self.directory.name) / "preparations").exists())


if __name__ == "__main__":
    unittest.main()
