import json
import hashlib
import http.client
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
from provider_fixtures import FakeProvider
from caption_fixtures import metadata_response, missing_captions, mark_cache

VIDEO = "rwnyaH6cTDE"
VALID_SRT = "1\n00:00:00,000 --> 00:00:01,000\nCaptions\n"






    def test_atomic_write_failure_removes_its_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "saved.srt"
            path.write_text(VALID_SRT)
            with mock.patch.object(os, "fsync", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    server.SubtitleService._write_text_atomically(path, "replacement")
            self.assertEqual(path.read_text(), VALID_SRT)
            self.assertEqual(list(path.parent.iterdir()), [path])























if __name__ == "__main__":
    unittest.main()


class HttpSecurityTests(unittest.TestCase):
    def setUp(self):
        self.service = mock.Mock()
        self.service.existing_job.return_value = {"status": "missing"}
        self.httpd = server.create_server(self.service, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)

    def request(self, path="/api/subtitles/existing?video_id=" + VIDEO, method="GET", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, headers=headers or {}, body=body)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_rejects_rebinding_hosts_and_nonextension_origins_before_actions(self):
        invalid = [
            {"Host": f"attacker.example:{self.port}"},
            {"Host": "127.0.0.1:1"},
            {"Host": f"127.0.0.1.attacker.example:{self.port}"},
            {"Origin": "https://evil.example"}, {"Origin": "null"},
            {"Origin": "chrome-extension://fake"},
            {"Origin": "chrome-extension://" + "a" * 32 + ".evil.example"},
            {"Origin": "chrome-extension://" + "a" * 32 + "/"},
        ]
        for headers in invalid:
            with self.subTest(headers=headers):
                headers["X-SubsAnywhere-Client"] = "extension-v1"
                status, response_headers, body = self.request(headers=headers)
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response_headers)
                json.loads(body)
                self.assertEqual(self.request(path="/health", headers=headers)[0], 403)
        self.service.existing_job.assert_not_called()

    def test_accepts_only_well_formed_extension_preflight_and_cli_api(self):
        origin = "chrome-extension://" + "a" * 32
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}"):
            self.assertEqual(self.request(headers={"Host": host, "X-SubsAnywhere-Client": "extension-v1"})[0], 200)
        status, headers, _ = self.request(method="OPTIONS", headers={"Origin": origin,
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-SubsAnywhere-Client"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(self.request(headers={"Origin": origin})[0], 403)

    def test_rejects_bodies_ambiguous_query_and_large_requests(self):
        headers = {"X-SubsAnywhere-Client": "extension-v1"}
        self.assertEqual(self.request(method="POST", body="x", headers=headers)[0], 413)
        self.assertEqual(self.request(headers={**headers, "Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.request(path="/" + "x" * 2050, headers=headers)[0], 414)
        self.assertEqual(self.request(path="/api/subtitles/existing?video_id=" + VIDEO + "&video_id=" + VIDEO,
                                     headers=headers)[0], 400)

    def test_removed_vocabulary_routes_reject_requests_without_touching_legacy_db(self):
        # Isolated fixture: never test against the user's existing database.
        with tempfile.TemporaryDirectory() as directory:
            database = pathlib.Path(directory) / "words.sqlite3"
            database.write_bytes(b"legacy database fixture")
            with mock.patch.dict(os.environ, {"SUBSANYWHERE_WORDS_DB": str(database)}):
                host = f"127.0.0.1:{self.port}"
                client = {"X-SubsAnywhere-Client": "extension-v1"}
                same_origin = {**client, "Origin": f"http://{host}"}
                extension_origin = "chrome-extension://" + "a" * 32
                for path in ("/words", "/words/words.js", "/words/words.css",
                             "/api/words", "/api/words/learned", "/api/words/analysis",
                             "/api/sentences", "/api/sentences/analysis"):
                    with self.subTest(path=path):
                        self.assertEqual(self.request(path=path, headers=client)[0], 404)
                        self.assertEqual(self.request(path=path, headers=same_origin)[0], 403)
                        self.assertEqual(self.request(path=path, method="POST", headers=client)[0], 404)
                        self.assertEqual(self.request(path=path, method="POST", headers=client, body=b"{}")[0], 413)
                status, headers, _ = self.request(path="/api/words", method="OPTIONS", headers={
                    "Origin": extension_origin, "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "X-SubsAnywhere-Client, Content-Type"})
                self.assertEqual(status, 403)
                self.assertEqual(headers["Access-Control-Allow-Headers"], "X-SubsAnywhere-Client")
            self.assertEqual(database.read_bytes(), b"legacy database fixture")

    def test_http_errors_never_expose_exception_text(self):
        self.service.existing_job.side_effect = RuntimeError("token=secret /private/key")
        status, _, body = self.request(headers={"X-SubsAnywhere-Client": "extension-v1"})
        self.assertEqual(status, 500)
        self.assertNotIn(b"secret", body)
        self.assertNotIn(b"/private", body)

    def test_request_threads_are_bounded_with_immediate_overload_response(self):
        httpd = server.create_server(self.service, "127.0.0.1", 0, max_requests=1)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        # Occupy the only handler deterministically, without timing assumptions.
        self.assertTrue(httpd.request_slots.acquire(blocking=False))
        try:
            with socket.create_connection(httpd.server_address, timeout=2) as connection:
                response = connection.recv(4096)
                self.assertIn(b"503 Service Unavailable", response)
        finally:
            httpd.request_slots.release()

    def test_docker_wildcard_bind_accepts_mapped_loopback_port_not_domains(self):
        httpd = server.create_server(self.service, "0.0.0.0", 0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for host, expected in (("127.0.0.1:49123", 200), ("localhost:49123", 200),
                                   ("evil.example:49123", 403), ("127.0.0.1:99999", 403)):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=2)
                try:
                    connection.request("GET", "/api/subtitles/existing?video_id=" + VIDEO,
                                       headers={"Host": host, "X-SubsAnywhere-Client": "extension-v1"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)