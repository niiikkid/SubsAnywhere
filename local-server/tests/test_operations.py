import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER = pathlib.Path(__file__).resolve().parents[1]
MODELS = ("SenseVoiceSmall", "speech_fsmn_vad_zh-cn-16k-common-pytorch")


class ModelImportTests(unittest.TestCase):
    def test_healthcheck_identifies_the_service_not_just_an_open_port(self):
        class Handler(BaseHTTPRequestHandler):
            payload = {"ok": True, "service": "subsanywhere", "api_version": 1}

            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(self.payload).encode())

            def log_message(self, format, *args):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        try:
            env = {**os.environ, "SUBSANYWHERE_PORT": str(httpd.server_port)}
            command = [sys.executable, str(SERVER / "healthcheck.py")]
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            Handler.payload = {"ok": True}
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
        finally:
            httpd.shutdown()
            httpd.server_close()
            worker.join()

    def test_offline_model_import_is_complete_and_never_overwrites_existing_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source, target = root / "source", root / "target"
            target.mkdir()
            for name in MODELS:
                model = source / name
                model.mkdir(parents=True)
                (model / "model.pt").write_bytes(b"test-fixture-not-a-model")
                (model / "configuration.json").write_text(json.dumps({"model": name}))
            command = [sys.executable, str(SERVER / "import_models.py"), str(source), str(target)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / MODELS[0] / "model.pt").read_bytes(), b"test-fixture-not-a-model")
            (source / MODELS[0] / "model.pt").write_bytes(b"new")
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((target / MODELS[0] / "model.pt").read_bytes(), b"test-fixture-not-a-model")

    def test_incomplete_source_does_not_install_half_a_model_set(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source, target = root / "source", root / "target"
            source.mkdir()
            target.mkdir()
            (source / MODELS[0]).mkdir()
            result = subprocess.run(
                [sys.executable, str(SERVER / "import_models.py"), str(source), str(target)],
                capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
