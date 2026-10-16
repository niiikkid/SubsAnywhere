import json
import os
import pathlib
import subprocess
import sys
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))


class HealthcheckTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
