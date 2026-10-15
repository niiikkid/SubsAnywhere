import json
import os
import hashlib
import http.client
import pathlib
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

VIDEO = "rwnyaH6cTDE"
ENGLISH = "1\n00:00:00,000 --> 00:00:01,000\nHello, 你好\n"
CHINESE = ENGLISH.replace("Hello, 你好", "你好")


class GenerationLanguageTests(unittest.TestCase):
    def test_health_reports_language_models_and_missing_nano_without_disabling_english(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.dict(os.environ, {'SUBSANYWHERE_ASR_MODEL': 'auto'}), \
                mock.patch.object(server, 'nano_model_available', return_value=False, create=True):
            service = server.SubtitleService(pathlib.Path(directory), provider=FakeProvider())
            service.health_cached = dict.fromkeys(('yt_dlp', 'ffmpeg', 'pinyin', 'asr_python', 'asr_dependencies', 'models'), True)
            service.health_checked_at = time.monotonic()
            health = service.health()
            self.assertEqual(health['recognition_models'], {'en': 'sensevoice', 'zh': 'nano'})
            self.assertEqual(health['capabilities']['asr_languages'], ['en'])
            self.assertTrue(health['capabilities']['asr'])

    def test_transcriber_memory_ceiling_is_actionable_and_preserves_subtitles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached")
            paths.generated_srt.write_text(CHINESE)
            run = mock.Mock(return_value=subprocess.CompletedProcess([], 73, "", "private path"))
            service = server.SubtitleService(root, run_command=run, start_background=lambda f: f(), provider=FakeProvider())
            result = service.generate(VIDEO, "en")
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error_code"], "resource_limit")
            self.assertEqual(result["language"], "en")
            self.assertEqual(paths.generated_srt.read_text(), CHINESE)
            self.assertNotIn("private", json.dumps(result))
            self.assertEqual(server.SubtitleService(root, provider=FakeProvider()).generated(VIDEO), result)
            self.assertEqual(service.active_jobs, set())


    def test_generate_http_accepts_only_one_supported_optional_language(self):
        with tempfile.TemporaryDirectory() as directory:
            service = server.SubtitleService(pathlib.Path(directory), start_background=lambda f: None, provider=FakeProvider())
            httpd = server.create_server(service, "127.0.0.1", 0)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                for endpoint, suffix, expected in (
                    ("generate", "&language=en", 200),
                    ("generate", "&language=zh", 200), ("generate", "", 200),
                    ("generate", "&language=", 200), ("generate", "&language=fr", 400),
                    ("generate", "&language=EN", 400), ("generate", "&language=en&language=zh", 400),
                    ("generate", "&other=en", 400), ("generated", "&language=en", 400),
                    ("cancel", "&language=en", 400),
                ):
                    with self.subTest(endpoint=endpoint, suffix=suffix):
                        connection = http.client.HTTPConnection(*httpd.server_address, timeout=2)
                        try:
                            connection.request("GET" if endpoint == "generated" else "POST",
                                f"/api/subtitles/{endpoint}?video_id={VIDEO}{suffix}",
                                headers={"X-SubsAnywhere-Client": "extension-v1"})
                            response = connection.getresponse()
                            body = json.loads(response.read())
                            self.assertEqual(response.status, expected)
                            if expected == 200:
                                if suffix in ("", "&language="):
                                    self.assertTrue(body["language_required"])
                                else:
                                    self.assertEqual(body["language"], "en")  # Running jobs deduplicate.
                        finally:
                            connection.close()
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(2)
                service.close()

    def test_legacy_and_stale_ready_metadata_infer_language_from_published_bytes(self):
        english = ENGLISH.replace("Hello, 你好", "Hello")
        for contents, expected in ((CHINESE, "zh"), (english, "en")):
            for record in ({}, {"language": "en"}, {"language": "zh", "sha256": "stale"},
                           {"language": "en", "sha256": hashlib.sha256(english.encode()).hexdigest()},
                           {"language": ["en"]}):
                with self.subTest(contents=contents, record=record), tempfile.TemporaryDirectory() as directory:
                    root = pathlib.Path(directory)
                    paths = server.output_paths(root, VIDEO)
                    paths.directory.mkdir(parents=True)
                    paths.generated_srt.write_text(contents, encoding="utf-8")
                    server.job_path(paths).write_text(json.dumps(dict(record, status="ready", source="generated")))
                    enrich = mock.Mock(side_effect=lambda text: text)
                    ready = server.SubtitleService(root, pinyinize=enrich, provider=FakeProvider()).generated(VIDEO)
                    self.assertEqual((ready["language"], ready["srt"]), (expected, contents))
                    self.assertEqual(enrich.call_count, int(expected == "zh"))


    def test_interrupted_cancelled_and_failed_jobs_keep_the_requested_language(self):
        for failure in ("restart", "cancel", "close", "start", "worker", "storage"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                pending = []
                service = server.SubtitleService(root, start_background=pending.append,
                    run_command=mock.Mock(side_effect=RuntimeError("offline failure")), provider=FakeProvider())
                if failure == "start":
                    service.start_background = mock.Mock(side_effect=RuntimeError("cannot start"))
                service.generate(VIDEO, "en")
                if failure == "restart":
                    service = server.SubtitleService(root, provider=FakeProvider())
                elif failure == "cancel":
                    service.cancel(VIDEO)
                elif failure == "close":
                    service.close()
                elif failure == "worker":
                    pending.pop()()
                elif failure == "storage":
                    with mock.patch.object(service, "_save_job", side_effect=OSError("full")):
                        pending.pop()()
                result = service.generated(VIDEO)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result.get("language"), "en")
                self.assertEqual(server.SubtitleService(root, provider=FakeProvider()).generated(VIDEO).get("language"), "en")

    def test_explicit_english_reaches_runner_and_survives_publication_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = server.output_paths(root, VIDEO)
            paths.directory.mkdir(parents=True)
            paths.audio.write_bytes(b"cached audio")
            pending, commands = [], []

            def run(command, **kwargs):
                commands.append(command)
                for flag in ("--srt", "--text", "--markdown"):
                    pathlib.Path(command[command.index(flag) + 1]).write_text(ENGLISH, encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")

            enrich = mock.Mock(side_effect=AssertionError("English must not acquire pinyin"))
            service = server.SubtitleService(root, run_command=run, start_background=pending.append, pinyinize=enrich, provider=FakeProvider())
            running = service.generate(VIDEO, language="en")
            self.assertEqual((running["status"], running["language"]), ("running", "en"))
            self.assertEqual(json.loads(server.job_path(paths).read_text())["language"], "en")
            pending.pop()()
            ready = service.generated(VIDEO)
            self.assertEqual((ready["status"], ready["language"], ready["srt"]), ("ready", "en", ENGLISH))
            self.assertEqual(commands[0][commands[0].index("--language") + 1], "en")
            self.assertEqual(json.loads(server.job_path(paths).read_text())["language"], "en")
            self.assertEqual(server.SubtitleService(root, pinyinize=enrich, provider=FakeProvider()).generated(VIDEO), ready)
            enrich.assert_not_called()
