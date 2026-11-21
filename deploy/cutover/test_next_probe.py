import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
from threading import Thread
import unittest

from next_probe import verify_next_build


BUILD = "build-verified"
ASSET = f"/_next/static/{BUILD}/_buildManifest.js"
MARKER = b"self.__BUILD_MANIFEST = {};"


class Server(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            data = b'{"status":"ok"}'
        elif self.path == ASSET:
            data = self.server.marker
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _format, *_args):
        pass


class NextProbeTest(unittest.TestCase):
    def test_serving_the_exact_compiled_marker_is_required(self):
        with tempfile.TemporaryDirectory() as temp, ThreadingHTTPServer(("127.0.0.1", 0), Server) as server:
            root = Path(temp)
            compiled = root / ".next"
            marker = compiled / f"static/{BUILD}/_buildManifest.js"
            marker.parent.mkdir(parents=True)
            marker.write_bytes(MARKER)
            (compiled / "BUILD_ID").write_text(BUILD)
            server.marker = MARKER
            worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
            worker.start()
            try:
                def connect():
                    return http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)

                self.assertEqual(
                    verify_next_build(root, BUILD, connect),
                    {"buildId": BUILD, "markerSha256": hashlib.sha256(MARKER).hexdigest()},
                )
                server.marker = b"old build"
                with self.assertRaisesRegex(RuntimeError, "different compiled build"):
                    verify_next_build(root, BUILD, connect)
            finally:
                server.shutdown()
                worker.join(5)
