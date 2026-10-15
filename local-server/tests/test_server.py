import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
from provider_fixtures import FakeProvider
import pinyin
from caption_fixtures import metadata_response


class PathSafetyTests(unittest.TestCase):
    def test_video_id_and_output_names_are_safe_and_english_only(self):
        self.assertEqual(server.validate_video_id("rwnyaH6cTDE"), "rwnyaH6cTDE")
        for invalid in ("", "short", "../escape123", "中文文件名字1"):
            with self.assertRaises(ValueError):
                server.validate_video_id(invalid)

        with tempfile.TemporaryDirectory() as temporary:
            paths = server.output_paths(pathlib.Path(temporary), "rwnyaH6cTDE")
            self.assertEqual(paths.directory.name, "rwnyaH6cTDE")
            self.assertEqual(paths.youtube_srt.name, "youtube-rwnyaH6cTDE-youtube.srt")
            for path in paths:
                path.name.encode("ascii")










class HttpServerTests(unittest.TestCase):
    def test_http_api_routes_health_and_existing(self):
        calls = []

        class FakeService:
            def existing_job(self, video_id, language=""):
                calls.append(("existing", video_id))
                return {"status": "missing", "source": "youtube"}

        httpd = server.create_server(FakeService(), host="127.0.0.1", port=0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        def api_request(path, method="GET"):
            return urllib.request.Request(
                f"{base}{path}",
                headers={"X-SubsAnywhere-Client": "extension-v1"},
                method=method,
            )
        try:
            with urllib.request.urlopen(f"{base}/health") as response:
                health = json.load(response)
                self.assertEqual(health["ok"], True)
                self.assertEqual((health["service"], health["api_version"]), ("subsanywhere", 1))
            with urllib.request.urlopen(api_request("/api/subtitles/existing?video_id=rwnyaH6cTDE")) as response:
                self.assertEqual(json.load(response)["status"], "missing")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

        self.assertEqual(calls, [
            ("existing", "rwnyaH6cTDE"),
        ])


if __name__ == "__main__":
    unittest.main()
