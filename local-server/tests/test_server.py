import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server


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
    def test_existing_subtitles_fall_back_to_automatic_captions_without_audio_download(self):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)

            def run(command, **kwargs):
                calls.append(command)
                if "--write-auto-subs" in command:
                    paths = server.output_paths(root, "rwnyaH6cTDE")
                    paths.directory.mkdir(parents=True, exist_ok=True)
                    paths.directory.joinpath("youtube-rwnyaH6cTDE-youtube.zh-Hans.srt").write_text(
                        "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
                        encoding="utf-8",
                    )
                return subprocess.CompletedProcess(command, 0, "", "")

            service = server.SubtitleService(root, run_command=run)
            result = service.existing("rwnyaH6cTDE")

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["source"], "youtube")
        self.assertIn("你好", result["srt"])
        self.assertEqual(len(calls), 2)
        self.assertIn("--write-subs", calls[0])
        self.assertIn("--write-auto-subs", calls[1])
        self.assertEqual(calls[0][calls[0].index("--convert-subs") + 1], "srt")
        self.assertEqual(calls[1][calls[1].index("--convert-subs") + 1], "srt")
        self.assertNotIn("-x", calls[0] + calls[1])
        self.assertTrue(all(isinstance(command, list) for command in calls))

    def test_generation_downloads_audio_only_and_runs_the_local_transcriber(self):
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)

            def run(command, **kwargs):
                calls.append(command)
                if "-x" in command:
                    output = pathlib.Path(command[command.index("-o") + 1].replace("%(ext)s", "mp3"))
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_bytes(b"audio")
                else:
                    pathlib.Path(command[command.index("--srt") + 1]).write_text(
                        "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
                        encoding="utf-8",
                    )
                    pathlib.Path(command[command.index("--text") + 1]).write_text("你好\n", encoding="utf-8")
                    pathlib.Path(command[command.index("--markdown") + 1]).write_text("[00:00] 你好\n", encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "", "")

            service = server.SubtitleService(
                root,
                run_command=run,
                start_background=lambda target: target(),
                asr_python="/local/funasr/python",
            )
            service.generate("rwnyaH6cTDE")
            result = service.generated("rwnyaH6cTDE")

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["source"], "generated")
        self.assertIn("你好", result["srt"])
        self.assertEqual(len(calls), 2)
        self.assertIn("-x", calls[0])
        self.assertEqual(calls[0][calls[0].index("-f") + 1], "ba/bestaudio")
        self.assertIn("--audio-format", calls[0])
        self.assertNotIn("--write-subs", calls[0])
        self.assertNotIn("--write-auto-subs", calls[0])
        self.assertEqual(calls[1][0], "/local/funasr/python")


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
                self.assertEqual(json.load(response), {"ok": True})
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
