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
            self.assertEqual(paths.audio.name, "youtube-rwnyaH6cTDE-audio.mp3")
            self.assertEqual(paths.youtube_srt.name, "youtube-rwnyaH6cTDE-youtube.srt")
            self.assertEqual(paths.generated_srt.name, "youtube-rwnyaH6cTDE-generated.srt")
            for path in paths:
                path.name.encode("ascii")


class SubtitleServiceTests(unittest.TestCase):
    def test_generated_returns_live_transcriber_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            service = server.SubtitleService(root, provider=FakeProvider())
            paths = server.output_paths(root, "rwnyaH6cTDE")
            paths.directory.mkdir(parents=True)
            server.progress_path(paths).write_text(json.dumps({
                "stage": "recognizing",
                "progress": 42,
                "completed_segments": 21,
                "total_segments": 50,
                "eta_seconds": 125,
            }), encoding="utf-8")
            service.jobs["rwnyaH6cTDE"] = {
                "status": "running",
                "source": "generated",
                "stage": "recognizing",
            }

            result = service.generated("rwnyaH6cTDE")

        self.assertEqual(result["progress"], 42)
        self.assertEqual(result["completed_segments"], 21)
        self.assertEqual(result["total_segments"], 50)
        self.assertEqual(result["eta_seconds"], 125)

    def test_generated_subtitle_file_is_enriched_idempotently_before_returning_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            path = server.output_paths(root, "rwnyaH6cTDE").generated_srt
            path.parent.mkdir(parents=True)
            path.write_text("1\n00:00:00,000 --> 00:00:01,000\n你好\n", encoding="utf-8")
            batches = []
            service = server.SubtitleService(
                root,
                pinyinize=lambda source: pinyin.bilingual_srt(
                    source,
                    convert_many=lambda texts: batches.append(texts) or ["nǐ hǎo"],
                ),
             provider=FakeProvider())

            first = service.generated("rwnyaH6cTDE")
            second = service.generated("rwnyaH6cTDE")

            self.assertIn("\u2063nǐ hǎo\n\u2064你好", first["srt"])
            self.assertEqual(second["srt"], first["srt"])
            self.assertEqual(path.read_text(encoding="utf-8"), first["srt"])
            self.assertEqual(batches, [["你好"]])

    def test_generated_serializes_enrichment_per_file_and_never_writes_the_final_srt_directly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            path = server.output_paths(root, "rwnyaH6cTDE").generated_srt
            path.parent.mkdir(parents=True)
            raw = "1\n00:00:00,000 --> 00:00:01,000\n你好\n"
            enriched = "1\n00:00:00,000 --> 00:00:01,000\n\u2063nǐ hǎo\n\u2064你好\n"
            path.write_text(raw, encoding="utf-8")
            entered = threading.Event()
            second_entered = threading.Event()
            release = threading.Event()
            calls = []
            target_writes = []
            original_write_text = pathlib.Path.write_text

            def pinyinize(source):
                calls.append(source)
                if len(calls) == 1:
                    entered.set()
                    self.assertTrue(release.wait(timeout=2))
                    return enriched
                second_entered.set()
                return source

            def tracked_write_text(target, data, *args, **kwargs):
                if target == path:
                    target_writes.append(data)
                return original_write_text(target, data, *args, **kwargs)

            service = server.SubtitleService(root, pinyinize=pinyinize, provider=FakeProvider())
            results = []
            errors = []

            def load_generated():
                try:
                    results.append(service.generated("rwnyaH6cTDE"))
                except Exception as error:  # pragma: no cover - asserted below
                    errors.append(error)

            with mock.patch.object(pathlib.Path, "write_text", tracked_write_text):
                first = threading.Thread(target=load_generated)
                second = threading.Thread(target=load_generated)
                first.start()
                self.assertTrue(entered.wait(timeout=2))
                second.start()
                try:
                    self.assertFalse(second_entered.wait(timeout=0.1))
                    self.assertEqual(calls, [raw])
                finally:
                    release.set()
                    first.join(timeout=2)
                    second.join(timeout=2)

            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(target_writes, [])
            self.assertEqual([result["srt"] for result in results], [enriched, enriched])






class HttpServerTests(unittest.TestCase):
    def test_http_api_routes_health_existing_generation_and_status(self):
        calls = []

        class FakeService:
            def existing(self, video_id):
                calls.append(("existing", video_id))
                return {"status": "missing", "source": "youtube"}

            def generate(self, video_id):
                calls.append(("generate", video_id))
                return {"status": "running", "source": "generated"}

            def generated(self, video_id):
                calls.append(("generated", video_id))
                return {"status": "ready", "source": "generated", "srt": "captions"}

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
            request = api_request("/api/subtitles/generate?video_id=rwnyaH6cTDE", method="POST")
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["status"], "running")
            with urllib.request.urlopen(api_request("/api/subtitles/generated?video_id=rwnyaH6cTDE")) as response:
                self.assertEqual(json.load(response)["srt"], "captions")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)

        self.assertEqual(calls, [
            ("existing", "rwnyaH6cTDE"),
            ("generate", "rwnyaH6cTDE"),
            ("generated", "rwnyaH6cTDE"),
        ])


if __name__ == "__main__":
    unittest.main()
