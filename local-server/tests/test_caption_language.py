
import pathlib

import sys

import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server


CHINESE_VIDEO = "0Zaxca2sUGs"







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
                ("existing", "&language=", 200), ("existing", "&language=fr", 400),
                ("existing", "&language=zh&language=en", 400),
                ("existing", "&other=zh", 400),
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
                             [mock.call(CHINESE_VIDEO, language="zh"), mock.call(CHINESE_VIDEO, language="en"), mock.call(CHINESE_VIDEO, language="")])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)


