import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server

ENGLISH_VIDEO = "1evO3Nekrr8"
CHINESE_VIDEO = "0Zaxca2sUGs"
SRT = "1\n00:00:00,000 --> 00:00:01,000\nHello, 你好\n"


def track(language, translated=False):
    return [{"ext": "vtt", "url": "https://www.youtube.com/api/timedtext?lang=" + language +
             ("&tlang=zh" if translated else "")}]


class CaptionDownloadTests(unittest.TestCase):
    def test_ambiguous_auto_requires_choice_and_override_caches_do_not_mix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            calls, pending = [], []
            metadata = {"id": CHINESE_VIDEO, "subtitles": {"zh-Hans": track("zh"), "en-US": track("en")},
                        "automatic_captions": {"zh-Hans": track("zh"), "en-US": track("en")}}
            def run(command, **kwargs):
                calls.append(command)
                template = command[command.index("-o") + 1]
                if "--write-info-json" in command:
                    pathlib.Path(template.replace("%(ext)s", "info.json")).write_text(json.dumps(metadata))
                else:
                    code = command[command.index("--sub-langs") + 1]
                    pathlib.Path(template.replace("%(ext)s", code + ".srt")).write_text(SRT)
                return subprocess.CompletedProcess(command, 0, "", "")
            service = server.SubtitleService(root, run_command=run, start_background=pending.append,
                                             pinyinize=lambda s: s.replace("你好", "nǐ hǎo\n你好"))
            self.assertEqual(service.existing_job(CHINESE_VIDEO)["status"], "running")
            pending.pop()()
            missing = service.existing_job(CHINESE_VIDEO)
            self.assertTrue(missing["language_required"])
            self.assertEqual(missing["available_languages"], ["en", "zh"])
            self.assertEqual(service.existing_job(CHINESE_VIDEO, language="zh")["status"], "running")
            with self.assertRaises(server.ServiceError):
                service.existing_job(CHINESE_VIDEO, language="en")
            pending.pop()()
            chinese = service.existing_job(CHINESE_VIDEO, language="zh")
            self.assertEqual(chinese["language"], "zh")
            self.assertIn("nǐ hǎo", chinese["srt"])
            self.assertEqual(service.existing_job(CHINESE_VIDEO), missing)
            self.assertEqual(service.existing(CHINESE_VIDEO, language="en")["language"], "en")
            # A ready Chinese in-memory status cannot return the English file.
            self.assertEqual(service.existing_job(CHINESE_VIDEO, language="zh")["status"], "running")
            pending.pop()()
            self.assertEqual(service.existing_job(CHINESE_VIDEO, language="zh"), chinese)
            with self.assertRaises(ValueError):
                service.existing(CHINESE_VIDEO, language="fr")

    def test_managed_process_reads_metadata_from_disk_without_stdout_capture(self):
        # Exercise the production process runner, not just run_command mocks.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = root / "offline_ytdlp.py"
            script.write_text(
                "import json,pathlib,sys\n"
                "args=sys.argv[1:]\n"
                "template=args[args.index('-o')+1]\n"
                "if '--write-info-json' in args:\n"
                " data={'language':'en','subtitles':{'en':[{'ext':'srt','url':'https://example.invalid/en'}]}}\n"
                " pathlib.Path(template.replace('%(ext)s','info.json')).write_text(json.dumps(data))\n"
                "else:\n"
                " data=json.loads(pathlib.Path(args[args.index('--load-info-json')+1]).read_text())\n"
                " assert list(data['subtitles'])==['en']\n"
                " pathlib.Path(template.replace('%(ext)s','en.srt')).write_text(" + repr(SRT) + ")\n"
            )
            service = server.SubtitleService(root, cookies_from_browser="", cookies_file="",
                                             pinyinize=mock.Mock(side_effect=AssertionError("English enrichment")))
            with mock.patch.object(service, "_youtube_command", return_value=[sys.executable, str(script)]):
                result = service.existing(ENGLISH_VIDEO)
            self.assertEqual(result["language"], "en")
            self.assertEqual(result["srt"], SRT)
            self.assertEqual(service.processes, set())

    def test_failed_refresh_preserves_legacy_file_and_releases_capacity(self):
        for failure in ("metadata", "download", "invalid"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                path = server.output_paths(root, ENGLISH_VIDEO).youtube_srt
                path.parent.mkdir(parents=True)
                path.write_text("old Chinese data")
                def run(command, **kwargs):
                    template = command[command.index("-o") + 1]
                    if "--write-info-json" in command:
                        pathlib.Path(template.replace("%(ext)s", "info.json")).write_text(json.dumps({
                            "language": "en", "subtitles": {"en": track("en")}}))
                        code = int(failure == "metadata")
                    else:
                        pathlib.Path(template.replace("%(ext)s", "en.srt")).write_text("invalid output")
                        code = int(failure == "download")
                    return subprocess.CompletedProcess(command, code, "", "private token")
                service = server.SubtitleService(root, run_command=run, start_background=lambda f: f())
                result = service.existing_job(ENGLISH_VIDEO)
                self.assertEqual(result["status"], "error")
                self.assertNotIn("private", json.dumps(result))
                self.assertEqual(path.read_text(), "old Chinese data")
                self.assertEqual(service.caption_active, set())
                self.assertTrue(service.caption_slots.acquire(blocking=False))
                service.caption_slots.release()


    def test_legacy_chinese_cache_refreshes_to_english_and_survives_restart_and_poll(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = server.output_paths(root, ENGLISH_VIDEO).youtube_srt
            path.parent.mkdir(parents=True)
            path.write_text(SRT.replace("Hello, 你好", "旧中文"))
            calls, pending = [], []
            metadata = {"id": ENGLISH_VIDEO, "language": "en-US", "subtitles": {},
                        "automatic_captions": {"en-orig": track("en"), "zh": track("en", True)}}
            def run(command, **kwargs):
                calls.append(command)
                self.assertLessEqual(kwargs["timeout"], 180)
                template = command[command.index("-o") + 1]
                if "--write-info-json" in command:
                    pathlib.Path(template.replace("%(ext)s", "info.json")).write_text(json.dumps(metadata))
                else:
                    self.assertIn("--load-info-json", command)
                    loaded = json.loads(pathlib.Path(command[command.index("--load-info-json") + 1]).read_text())
                    self.assertEqual(loaded["automatic_captions"], {"en-orig": track("en")})
                    self.assertEqual(command[command.index("--sub-langs") + 1], "en-orig")
                    pathlib.Path(template.replace("%(ext)s", "en-orig.srt")).write_text(SRT)
                return subprocess.CompletedProcess(command, 0, "", "")
            enrich = mock.Mock(side_effect=AssertionError("English must not be pinyinized"))
            service = server.SubtitleService(root, run_command=run, pinyinize=enrich,
                                             start_background=pending.append, cookies_from_browser="")
            self.assertEqual(service.existing_job(ENGLISH_VIDEO)["status"], "running")
            pending.pop()()
            ready = service.existing_job(ENGLISH_VIDEO)
            self.assertEqual(ready["status"], "ready")
            self.assertEqual(ready["language"], "en")
            self.assertEqual(ready["srt"], SRT)
            self.assertEqual(path.read_text(), SRT)
            self.assertEqual(service.existing_job(ENGLISH_VIDEO), ready)
            restarted = server.SubtitleService(root, run_command=mock.Mock(side_effect=AssertionError("cache miss")),
                                               pinyinize=enrich, start_background=lambda f: f())
            self.assertEqual(restarted.existing(ENGLISH_VIDEO), ready)
            self.assertEqual(restarted.existing_job(ENGLISH_VIDEO), ready)
            self.assertEqual(len(calls), 2)
            enrich.assert_not_called()


class CaptionHttpTests(unittest.TestCase):
    def test_existing_accepts_only_single_supported_language_override(self):
        import http.client
        import threading
        service = mock.Mock()
        service.existing_job.return_value = {"status": "running", "source": "youtube"}
        httpd = server.create_server(service, "127.0.0.1", 0)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for endpoint, suffix, status in [
                ("existing", "&language=zh", 200), ("existing", "&language=en", 200),
                ("existing", "&language=", 400), ("existing", "&language=fr", 400),
                ("existing", "&language=zh&language=en", 400),
                ("generated", "&language=zh", 400), ("existing", "&other=zh", 400),
            ]:
                with self.subTest(endpoint=endpoint, suffix=suffix):
                    connection = http.client.HTTPConnection(*httpd.server_address, timeout=2)
                    connection.request("GET", f"/api/subtitles/{endpoint}?video_id={CHINESE_VIDEO}{suffix}",
                                       headers={"X-SubsAnywhere-Client": "extension-v1"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    response.read()
                    connection.close()
            self.assertEqual(service.existing_job.call_args_list,
                             [mock.call(CHINESE_VIDEO, language="zh"), mock.call(CHINESE_VIDEO, language="en")])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)


class CaptionSelectionTests(unittest.TestCase):
    def test_language_evidence_and_ambiguity(self):
        cases = [
            ({"audio_language": "zh-Hant", "subtitles": {"zh-Hant": track("zh-Hant")}}, "zh"),
            ({"formats": [{"language": "en-US", "format_note": "English original (default)"},
                           {"language": "zh", "format_note": "dubbed-auto"}],
              "subtitles": {"en-US": track("en-US")}}, "en"),
            ({"automatic_captions": {"zh-orig": track("zh"), "en": track("zh", True)}}, "zh"),
            ({"automatic_captions": {"zh": track("zh")}}, "zh"),
            ({"language": "ja", "automatic_captions": {"en": track("en")}}, None),
            ({"title": "Chinese lesson 中文", "subtitles": {"zh": track("zh"), "en": track("en")},
              "automatic_captions": {"zh": track("zh"), "en": track("en")}}, None),
        ]
        for metadata, expected in cases:
            with self.subTest(metadata=metadata):
                language, selected = server.select_original_captions(metadata)
                self.assertEqual(language, expected)
                self.assertEqual(bool(selected), expected is not None)

    def test_unknown_language_does_not_mask_original_asr_evidence(self):
        metadata = {"language": "und", "formats": [{"language": "und"}],
                    "automatic_captions": {"zh-orig": track("zh")}}
        self.assertEqual(server.select_original_captions(metadata)[0], "zh")

    def test_original_alias_precedes_other_auto_tracks_and_t_translations_are_excluded(self):
        metadata = {"language": "en", "automatic_captions": {
            "en": track("en"), "en-orig": track("en"), "en-t-zh": track("en"),
            "en-US": track("en", True)}}
        self.assertEqual([item[1] for item in server.select_original_captions(metadata)[1]],
                         ["en-orig", "en"])

    def test_original_english_is_selected_instead_of_chinese_translation(self):
        metadata = {"language": "en-US", "title": "中文标题", "subtitles": {"zh": track("en", True)},
                    "automatic_captions": {"zh": track("en", True), "en-orig": track("en")}}
        self.assertEqual(server.select_original_captions(metadata),
                         ("en", [("automatic_captions", "en-orig", track("en"))]))
