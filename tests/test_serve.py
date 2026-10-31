import gzip
import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import fixture  # noqa: E402
import serve  # noqa: E402


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        data = fixture.write(Path(cls._tmp.name))
        cls.server = serve.make_server(data, port=0, quiet=True)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls._tmp.cleanup()

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", path, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp, body

    def test_index_plain_and_gzip(self):
        resp, body = self.get("/api/index", {"Accept-Encoding": "identity"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body)["n"], 6)
        resp, body = self.get("/api/index", {"Accept-Encoding": "gzip"})
        self.assertEqual(resp.getheader("Content-Encoding"), "gzip")
        self.assertEqual(json.loads(gzip.decompress(body))["n"], 6)

    def test_response_and_source(self):
        resp, body = self.get("/api/response/2")
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body)["source"]["kind"], "summary")
        resp, body = self.get("/api/source/20")
        self.assertEqual(len(json.loads(body)["responses"]), 2)

    def test_not_found_is_json(self):
        for path in ("/api/response/999", "/api/source/999", "/api/nonsense"):
            resp, body = self.get(path)
            self.assertEqual(resp.status, 404, path)
            self.assertIn("error", json.loads(body))

    def test_search(self):
        resp, body = self.get("/api/search?q=seine&scope=spans")
        self.assertEqual(json.loads(body)["rows"], [1])
        resp, _ = self.get("/api/search?q=x&scope=bogus")
        self.assertEqual(resp.status, 400)

    def test_static_files(self):
        resp, body = self.get("/")
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/html"))
        self.assertIn(b"<html", body.lower())
        resp, _ = self.get("/js/app.js")
        self.assertEqual(resp.status, 200)
        self.assertIn("javascript", resp.getheader("Content-Type"))

    def test_static_cannot_escape_its_directory(self):
        for path in ("/../serve.py", "/%2e%2e/serve.py", "/js/../../rtdata.py", "/..%2fserve.py"):
            resp, body = self.get(path)
            self.assertEqual(resp.status, 404, path)
            self.assertNotIn(b"RagTruthUI", body)


if __name__ == "__main__":
    unittest.main()
