"""Real HTTP and SQLite exercises for queued cutovers."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingUnixStreamServer
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase
from unittest.mock import patch
import uuid

from controller import Release, UnixHTTPConnection, get_bytes, write_json
from staging import Coordinator, NextStaging, activate, promote, recover
from coordinator import PROTOCOL, check_operation_route


class App(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        if self.path == "/health":
            status, data = 200, b'{"status":"ok"}'
        elif self.path == f"/_next/static/{self.server.build}/_buildManifest.js":
            status, data = 200, self.server.marker
        elif self.path == "/analytics":
            status, data = 307, b""
        else:
            status, data = 404, b""
        self.send_response(status)
        self.end_headers()
        self.wfile.write(data)

    def address_string(self):
        return "local"


class Ingress(App):
    def do_GET(self):
        current = self.server.pointer.resolve(strict=True)
        if self.path == "/analytics":
            status, data = (503 if current == self.server.reject else 307), b""
        else:
            try:
                data = get_bytes(UnixHTTPConnection(current), self.path, 8192)
                if current == self.server.wrong_bytes and self.path.startswith("/_next/"):
                    data = b"stale ingress bytes"
                status = 200
            except RuntimeError:
                status, data = 502, b""
        self.send_response(status)
        self.end_headers()
        self.wfile.write(data)


class QueueCutoverTest(TestCase):
    def serve(self, server):
        worker = Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join, 3)
        self.addCleanup(server.shutdown)
        return server

    def source(self, sha, build):
        payload = build.encode()
        digest = hashlib.sha256(payload).hexdigest()
        release = Release(sha, digest, "c" * 64)
        source = self.root / "source" / digest / ".next"
        marker = source / "static" / build / "_buildManifest.js"
        marker.parent.mkdir(parents=True)
        marker.write_bytes(payload)
        (source / "BUILD_ID").write_text(build)
        write_json(self.root / "releases" / f"{digest}.json",
                   {"release": vars(release), "build": build})
        artifact = self.root / build
        artifact.write_bytes(payload)
        server = self.serve(ThreadingUnixStreamServer(str(self.cutover.endpoint(release)), App))
        server.build, server.marker = build, payload
        return release, artifact

    def setUp(self):
        directory = TemporaryDirectory(prefix="cq-", dir="/tmp")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        for name in ("endpoints", "prepared", "releases", "source"):
            (self.root / name).mkdir()
        ingress = self.serve(ThreadingHTTPServer(("127.0.0.1", 0), Ingress))
        self.cutover = NextStaging(self.root, ingress.server_port)
        self.ingress = ingress
        ingress.pointer = self.cutover.pointer
        ingress.reject = ingress.wrong_bytes = None
        self.baseline, _ = self.source("a" * 40, "old")
        self.candidate, artifact = self.source("b" * 40, "new")
        self.cutover.switch(self.baseline)
        self.cutover.prepare(self.baseline, self.candidate, artifact,
                             {"path": "/analytics", "status": 307})
        # Qualify the route and lease with HTTP and SQLite. No staging DB is attached.
        schema = patch.object(self.cutover, "verify_schema")
        self.schema = schema.start()
        self.addCleanup(schema.stop)
        write_json(self.root / "cutover.json", {"root": str(self.root), "port": ingress.server_port})
        self.queue = Coordinator(self.root, self.cutover.queue_state)
        self.addCleanup(self.queue.db.close)
        ticket = str(uuid.uuid4())
        self.request("submit", spec=dict(id=ticket, source=self.candidate.source,
                                        base=self.baseline.source, dependencies=[], risk="ordinary",
                                        migrations=[], acceptance="Analytics", evidence="CI"))
        batch = self.request("prepare", tickets=[ticket], candidate=self.candidate.source,
                             baseline=self.baseline.source, baselineBuild="old")
        self.assertEqual(batch["plan"]["lane"], "cutover")
        self.lease = self.request("claim", batch=batch["batch"])

    def request(self, action, **data):
        return self.queue.request({**data, "protocol": PROTOCOL, "actor": "test", "action": action})

    def installing(self):
        self.request("phase", **self.lease, phase="installing")

    def test_queue_observes_real_traffic_and_hands_back(self):
        self.installing()
        with self.assertRaisesRegex(ValueError, "shared cutover controller"):
            self.request("phase", **self.lease, phase="arrived", build="new")
        result = activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        self.assertEqual(self.candidate.source, result["source"])
        self.assertEqual("new", self.request("observe")["runtime"]["build_id"])
        self.schema.assert_called_once_with(self.baseline, self.candidate)
        with self.assertRaisesRegex(ValueError, "canonical route"):
            self.request("phase", **self.lease, phase="accepting", build="new")

    def test_canonical_restart_stays_behind_verified_immutable_ingress(self):
        self.installing()
        canonical = self.serve(ThreadingUnixStreamServer(str(self.cutover.canonical_socket), App))
        canonical.build, canonical.marker = "old", b"old"
        state = dict(state="ok", stale_build="0", ref=self.baseline.source,
                     built_ref=self.baseline.source, build_id="old", built_build_id="old")
        with patch("staging.canonical_live_state", side_effect=lambda: dict(state)), \
                patch("staging.APP", self.root / "source" / self.baseline.artifact):
            self.cutover.switch_to(self.cutover.canonical_socket)
            self.cutover.pin_canonical(self.baseline, "old")
            activate(self.queue, self.cutover, self.lease, self.candidate.artifact)

        def restart_canonical(*args, **kwargs):
            self.assertEqual("immutable", self.cutover.queue_state()["backend"])
            canonical.build, canonical.marker = "new", b"new"
            state.update(ref=self.candidate.source, built_ref=self.candidate.source,
                         build_id="new", built_build_id="new")

        with patch("staging.canonical_live_state", side_effect=lambda: dict(state)), \
                patch("staging.APP", self.root / "source" / self.candidate.artifact), \
                patch("staging.subprocess.run", side_effect=restart_canonical):
            result = promote(self.queue, self.cutover, self.lease, self.candidate.artifact)
            self.assertTrue(result["parked"])
            self.assertEqual("canonical", self.cutover.queue_state()["backend"])
            self.request("phase", **self.lease, phase="accepting", build="new")
            self.assertEqual("complete", self.request("finish", **self.lease, reason="Verified")["state"])

    def test_wrong_epoch_and_missing_install_phase_cannot_switch(self):
        for lease in ({**self.lease, "epoch": self.lease["epoch"] + 1}, self.lease):
            with self.assertRaises(ValueError):
                activate(self.queue, self.cutover, lease, self.candidate.artifact)
        self.assertEqual("old", self.cutover.queue_state()["build_id"])

    def test_legacy_install_cannot_act_on_default_cutover_batch(self):
        self.installing()
        held, plan = self.queue.lease(self.lease)
        with self.assertRaisesRegex(ValueError, "shared cutover controller"):
            check_operation_route(held, plan, {})
        activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        held, plan = self.queue.lease(self.lease)
        check_operation_route(held, plan, {"AIHR_STAGING_CUTOVER_CANONICAL": "1"})

    def test_busy_operation_cannot_be_overtaken(self):
        self.installing()
        with self.queue.operations():
            with self.assertRaises(BlockingIOError):
                activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        self.assertEqual("old", self.cutover.queue_state()["build_id"])

    def test_schema_failure_leaves_old_route_and_installing_lease(self):
        self.installing()
        self.schema.side_effect = ValueError("Schema differs")
        with self.assertRaisesRegex(ValueError, "Schema differs"):
            activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        self.assertEqual("old", self.cutover.queue_state()["build_id"])
        self.assertEqual("installing", self.request("status")["lease"]["phase"])

    def test_bad_ingress_bytes_roll_back_and_do_not_mark_arrival(self):
        self.installing()
        self.ingress.wrong_bytes = self.cutover.endpoint(self.candidate)
        with self.assertRaisesRegex(RuntimeError, "Previous release verified"):
            activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        self.assertEqual("old", self.cutover.queue_state()["build_id"])
        self.assertEqual("installing", self.request("status")["lease"]["phase"])

    def test_interrupted_route_is_recovered_under_same_lease(self):
        self.installing()
        with patch.object(self.cutover, "prove_outcome", side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        with self.assertRaisesRegex(ValueError, "requires recovery"):
            self.request("observe")
        self.assertTrue(recover(self.queue, self.cutover, self.lease))
        self.assertEqual("old", self.cutover.queue_state()["build_id"])

    def test_retry_recovers_successful_route_after_lost_queue_commit(self):
        self.installing()
        self.cutover.activate(self.candidate.artifact)
        with patch.object(self.cutover, "switch", side_effect=AssertionError("Repeated switch")):
            result = activate(self.queue, self.cutover, self.lease, self.candidate.artifact)
        self.assertTrue(result["resumedArrival"])
        self.assertEqual("arrived", self.request("status")["lease"]["phase"])
