import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from socketserver import ThreadingUnixStreamServer
import tempfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Thread
import unittest
from unittest.mock import patch

from controller import Cutover, Release, UnixHTTPConnection, get_json


SMOKE = {"employeeChart": "visible", "exportControls": 3}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.client_address = ("local", 0)

    def log_message(self, _format, *_args):
        pass

    def send_json(self, value):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class App(Handler):
    def do_GET(self):
        if self.path == "/health":
            self.send_json(self.server.identity)
        elif self.path == "/release-check":
            self.send_json(SMOKE)
        else:
            self.send_error(404)


class Ingress(Handler):
    def do_GET(self):
        endpoint = self.server.pointer.resolve(strict=True)
        if endpoint == self.server.reject and self.path == "/release-check":
            self.send_error(502)
            return
        self.send_json(get_json(UnixHTTPConnection(endpoint), self.path))


class CutoverTest(unittest.TestCase):
    def serve(self, server):
        self.addCleanup(server.server_close)
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(server.shutdown)
        return server

    def app(self, source, payload):
        digest = hashlib.sha256(payload).hexdigest()
        release = Release(source * 40, digest, "schema-ada")
        artifact = self.root / (source + ".artifact")
        artifact.write_bytes(payload)
        server = ThreadingUnixStreamServer(str(self.cutover.endpoint(release)), App)
        server.identity = {"source": release.source, "artifact": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                           "schema": release.schema}
        self.serve(server)
        return release, artifact

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ci-cut-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "endpoints").mkdir()
        (self.root / "prepared").mkdir()
        self.ingress = self.serve(ThreadingHTTPServer(("127.0.0.1", 0), Ingress))
        self.cutover = Cutover(self.root, self.ingress.server_port)
        self.ingress.pointer = self.cutover.pointer
        self.ingress.reject = None
        self.baseline, baseline_artifact = self.app("a", b"first release")
        self.candidate, self.artifact = self.app("b", b"candidate release")
        self.cutover.switch(self.baseline)
        self.cutover.assert_live(self.baseline)
        self.assertTrue(baseline_artifact.exists())

    def prepare(self):
        return self.cutover.prepare(self.baseline, self.candidate, self.artifact, SMOKE)

    def test_real_http_cutover_and_outcome(self):
        self.prepare()
        self.cutover.assert_live(self.baseline)
        observation = self.cutover.activate(self.candidate.artifact)
        self.cutover.assert_live(self.candidate)
        self.assertEqual(SMOKE, get_json(
            http.client.HTTPConnection("127.0.0.1", self.ingress.server_port), "/release-check"))
        self.assertFalse(self.cutover.journal.exists())
        self.assertTrue(self.cutover.endpoint(self.baseline).is_socket())
        print(json.dumps({"kind": "SYNTHETIC_CUTOVER", **observation}))

    def test_bad_bytes_are_refused_before_cutover(self):
        self.artifact.write_bytes(b"unverified bytes")
        with self.assertRaisesRegex(RuntimeError, "digest"):
            self.prepare()
        self.cutover.assert_live(self.baseline)

    def test_stale_prepared_release_cannot_replace_a_new_baseline(self):
        self.prepare()
        other, _ = self.app("c", b"newer running release")
        self.cutover.switch(other)
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            self.cutover.activate(self.candidate.artifact)
        self.cutover.assert_live(other)
        self.assertFalse(self.cutover.journal.exists())

    def test_failed_outcome_after_switch_restores_previous_route(self):
        self.prepare()
        self.ingress.reject = self.cutover.endpoint(self.candidate)
        with self.assertRaisesRegex(RuntimeError, "Previous release verified"):
            self.cutover.activate(self.candidate.artifact)
        self.cutover.assert_live(self.baseline)
        self.assertFalse(self.cutover.journal.exists())

    def test_interrupted_switch_recovers_the_previous_route(self):
        self.prepare()
        switch = self.cutover.switch

        def stop_after_switch(release):
            switch(release)
            raise SystemExit("simulated abrupt process exit")

        with patch.object(self.cutover, "switch", side_effect=stop_after_switch):
            with self.assertRaises(SystemExit):
                self.cutover.activate(self.candidate.artifact)
        self.cutover.assert_live(self.candidate)
        self.assertTrue(self.cutover.recover())
        self.assertFalse(self.cutover.recover())
        self.cutover.assert_live(self.baseline)

    def test_two_prepared_releases_cannot_both_replace_one_baseline(self):
        self.prepare()
        other, artifact = self.app("c", b"other release")
        self.cutover.prepare(self.baseline, other, artifact, SMOKE)
        start = Barrier(2)

        def attempt(release):
            start.wait(timeout=5)
            try:
                self.cutover.activate(release.artifact)
            except RuntimeError as error:
                self.assertIn("identity changed", str(error))
                return False
            return True

        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(attempt, (self.candidate, other)))
        self.assertEqual([False, True], sorted(results))
        self.cutover.assert_live(self.candidate if results[0] else other)

    def test_schema_change_is_refused_during_preparation(self):
        changed = Release(self.candidate.source, self.candidate.artifact, "schema-next")
        with self.assertRaisesRegex(RuntimeError, "rehearsed upgrade"):
            self.cutover.prepare(self.baseline, changed, self.artifact, SMOKE)
        self.cutover.assert_live(self.baseline)


if __name__ == "__main__":
    unittest.main()
