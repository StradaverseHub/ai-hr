"""Lease only the switch of a pre-warmed, migration-free release."""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import time
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Release:
    source: str
    artifact: str
    schema: str

    def __post_init__(self):
        if not re.fullmatch(r"[0-9a-f]{40}", self.source):
            raise ValueError("A full source commit is required")
        if not re.fullmatch(r"[0-9a-f]{64}", self.artifact):
            raise ValueError("A full artifact digest is required")
        if not re.fullmatch(r"[0-9a-zA-Z_.:-]{1,128}", self.schema):
            raise ValueError("A schema identity is required")


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, endpoint):
        super().__init__("localhost", timeout=5)
        self.endpoint = endpoint

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.endpoint))


def get_json(connection, path):
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"{path} returned HTTP {response.status}")
        data = response.read(8193)
        if len(data) > 8192:
            raise RuntimeError("Release probe response exceeded 8 KiB")
        return json.loads(data)
    finally:
        connection.close()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
        pending = Path(file.name)
        try:
            file.write(json.dumps(value, sort_keys=True).encode())
            file.flush()
            os.fsync(file.fileno())
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)
    sync_directory(path.parent)


def read_json(path):
    return json.loads(path.read_text())


class Cutover:
    """The root and loopback ingress belong to one target's trusted release operator."""

    def __init__(self, root, ingress_port):
        self.root = root.resolve(strict=True)
        self.ingress_port = ingress_port
        self.journal = self.root / "pending.json"
        self.pointer = self.root / "active.sock"

    def prepared_path(self, digest):
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("A full artifact digest is required")
        return self.root / "prepared" / f"{digest}.json"

    def endpoint(self, release):
        return self.root / "endpoints" / f"{release.artifact}.sock"

    def direct_health(self, release):
        expected = asdict(release)
        if get_json(UnixHTTPConnection(self.endpoint(release)), "/health") != expected:
            raise RuntimeError("Prepared endpoint reported a different release")

    def live_health(self):
        return Release(**get_json(
            http.client.HTTPConnection("127.0.0.1", self.ingress_port, timeout=5),
            "/health",
        ))

    def assert_live(self, release):
        if self.pointer.resolve(strict=True) != self.endpoint(release) or self.live_health() != release:
            raise RuntimeError("Active endpoint or release identity changed")

    def switch(self, release):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            incoming = Path(directory) / "selected.sock"
            incoming.symlink_to(self.endpoint(release))
            os.replace(incoming, self.pointer)
            sync_directory(self.root)

    def prepare(self, baseline, candidate, artifact_path, smoke):
        started = time.monotonic()
        if baseline.schema != candidate.schema:
            raise RuntimeError("Schema changes require a rehearsed upgrade path")
        if baseline.artifact == candidate.artifact:
            raise ValueError("Select a different candidate artifact")
        if not isinstance(smoke, dict) or not smoke:
            raise ValueError("Expected user outcome must be a non-empty JSON object")
        with artifact_path.open("rb") as artifact:
            if hashlib.file_digest(artifact, "sha256").hexdigest() != candidate.artifact:
                raise RuntimeError("Artifact digest does not match candidate")
        self.direct_health(candidate)
        if get_json(UnixHTTPConnection(self.endpoint(candidate)), "/release-check") != smoke:
            raise RuntimeError("Prepared candidate does not demonstrate the expected outcome")
        receipt = {
            "baseline": asdict(baseline),
            "candidate": asdict(candidate),
            "smoke": smoke,
            "preparationSeconds": time.monotonic() - started,
        }
        write_json(self.prepared_path(candidate.artifact), receipt)
        return receipt

    def restore_pending(self):
        if not self.journal.exists():
            return False
        baseline = Release(**read_json(self.journal)["baseline"])
        self.direct_health(baseline)
        self.switch(baseline)
        self.assert_live(baseline)
        self.clear_journal()
        return True

    def clear_journal(self):
        self.journal.unlink()
        sync_directory(self.root)

    def activate(self, digest):
        receipt = read_json(self.prepared_path(digest))
        baseline = Release(**receipt["baseline"])
        candidate = Release(**receipt["candidate"])
        if candidate.artifact != digest:
            raise RuntimeError("Prepared artifact identity changed")
        if baseline.schema != candidate.schema:
            raise RuntimeError("Schema changes require a rehearsed upgrade path")
        queued = time.monotonic()
        with (self.root / "cutover.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            claimed = time.monotonic()
            recovered = self.restore_pending()
            self.assert_live(baseline)
            self.direct_health(candidate)
            write_json(self.journal, {"baseline": asdict(baseline), "candidate": asdict(candidate)})
            try:
                self.switch(candidate)
                self.assert_live(candidate)
                live = http.client.HTTPConnection("127.0.0.1", self.ingress_port, timeout=5)
                if get_json(live, "/release-check") != receipt["smoke"]:
                    raise RuntimeError("Running candidate did not demonstrate the expected outcome")
            except Exception as error:
                try:
                    self.restore_pending()
                except Exception as rollback:
                    raise RuntimeError("Cutover and rollback failed. Recovery journal retained.") from rollback
                raise RuntimeError("Cutover failed. Previous release verified.") from error
            self.clear_journal()
            return {
                "source": candidate.source,
                "artifact": candidate.artifact,
                "recoveredInterruptedCutover": recovered,
                "preparationSeconds": receipt["preparationSeconds"],
                "leaseWaitSeconds": claimed - queued,
                "leaseSeconds": time.monotonic() - claimed,
            }

    def recover(self):
        with (self.root / "cutover.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self.restore_pending()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True, help="Trusted loopback ingress port")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--request", type=Path, required=True)
    prepare.add_argument("--artifact", type=Path, required=True)
    activate = commands.add_parser("activate")
    activate.add_argument("--artifact-digest", required=True)
    commands.add_parser("recover")
    options = parser.parse_args()
    cutover = Cutover(options.root, options.port)
    if options.command == "prepare":
        request = read_json(options.request)
        result = cutover.prepare(Release(**request["baseline"]), Release(**request["candidate"]),
                                 options.artifact, request["smoke"])
    elif options.command == "activate":
        result = cutover.activate(options.artifact_digest)
    else:
        result = {"recoveredInterruptedCutover": cutover.recover()}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
