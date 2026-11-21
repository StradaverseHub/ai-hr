"""Prove a prepared Next build is actually served through the selected endpoint."""
import argparse
import hashlib
import http.client
import json
from pathlib import Path
import re

from controller import UnixHTTPConnection, get_bytes, get_json


def verify_next_build(release_directory, expected, connect):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", expected):
        raise ValueError("Invalid build ID")
    compiled = release_directory / ".next"
    if (compiled / "BUILD_ID").read_text().strip() != expected:
        raise RuntimeError("Prepared runtime build ID differs")
    relative = f"static/{expected}/_buildManifest.js"
    marker = compiled / relative
    with marker.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    if get_json(connect(), "/health") != {"status": "ok"}:
        raise RuntimeError("Application health check failed")
    asset = get_bytes(connect(), f"/_next/{relative}", 1024 * 1024)
    if hashlib.sha256(asset).hexdigest() != digest:
        raise RuntimeError("Endpoint served different compiled build bytes")
    return {"buildId": expected, "markerSha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-directory", type=Path, required=True)
    parser.add_argument("--build-id", required=True)
    endpoint = parser.add_mutually_exclusive_group(required=True)
    endpoint.add_argument("--socket", type=Path)
    endpoint.add_argument("--port", type=int)
    options = parser.parse_args()

    def connect():
        if options.socket is not None:
            return UnixHTTPConnection(options.socket)
        return http.client.HTTPConnection("127.0.0.1", options.port, timeout=5)

    print(json.dumps(verify_next_build(options.release_directory, options.build_id, connect)))


if __name__ == "__main__":
    main()
