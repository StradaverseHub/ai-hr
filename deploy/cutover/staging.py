"""Next.js probes and shared staging lease for immutable cutovers."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

# The host runtime bundle places coordinator.py next to the cutover modules.
# The source checkout keeps staging coordinator code under scripts/staging.
if not (Path(__file__).parent / "coordinator.py").is_file():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/staging"))

from controller import Cutover, Release, UnixHTTPConnection, read_json, write_json
from coordinator import (APP, Coordinator, ROOT, canonical_live_state, environment_request,
                         plan_is_cutover, private, require)
from next_probe import verify_next_build


class NextStaging(Cutover):
    """Report the release that ingress actually serves, checking its compiled marker."""

    @property
    def canonical_socket(self):
        return self.root / "canonical.sock"

    def pinned_canonical(self):
        path = self.root / "canonical.json"
        return read_json(path) if path.exists() else None

    def endpoint(self, release):
        pinned = self.pinned_canonical()
        if pinned and pinned["release"] == vars(release):
            return self.canonical_socket
        return super().endpoint(release)

    def pin_canonical(self, release, build):
        """Pin the current canonical backend as the rollback endpoint."""
        require(self.pointer.resolve(strict=True) == self.canonical_socket,
                "The canonical backend must currently serve ingress")
        observed = self.queue_state()
        require(observed["ref"] == release.source and observed["build_id"] == build,
                "Canonical rollback identity differs")
        write_json(self.root / "canonical.json", {"release": vars(release), "build": build})

    def runtime(self, release):
        if self.endpoint(release) == self.canonical_socket:
            return APP, self.pinned_canonical()["build"]
        record = read_json(self.root / "releases" / f"{release.artifact}.json")
        require(Release(**record["release"]) == release, "Runtime release identity differs")
        return self.root / "source" / release.artifact, record["build"]

    def direct_health(self, release):
        source, build = self.runtime(release)
        return verify_next_build(source, build, lambda: UnixHTTPConnection(self.endpoint(release)))

    def live_health(self):
        selected = self.pointer.resolve(strict=True)
        if selected == self.canonical_socket:
            pinned = self.pinned_canonical()
            state = self.canonical_state()
            require(pinned and pinned["release"]["source"] == state["ref"]
                    and pinned["build"] == state["build_id"], "Canonical baseline pin differs")
            return Release(**pinned["release"])
        name = selected.name
        require(re.fullmatch(r"[0-9a-f]{64}\.sock", name), "Invalid active release endpoint")
        record = read_json(self.root / "releases" / f"{name[:-5]}.json")
        release = Release(**record["release"])
        require(self.pointer.resolve(strict=True) == self.endpoint(release), "Active socket differs")
        source, build = self.runtime(release)
        verify_next_build(source, build, self.ingress)
        require(self.pointer.resolve(strict=True) == self.endpoint(release), "Active route moved during verification")
        return release

    def prove_outcome(self, connect, expected):
        # A release may define a bounded, read-only check that is safe on real staging.
        # The operator performs the authenticated journey under the lease separately.
        require(set(expected) == {"path", "status"}, "Expected path and status required")
        path = expected["path"]
        require(isinstance(path, str) and re.fullmatch(r"/[a-zA-Z0-9/_-]{0,200}", path)
                and not path.startswith("//"), "Invalid stage smoke path")
        status = expected["status"]
        require(type(status) is int and status in (200, 302, 303, 307, 308, 401, 403),
                "Invalid stage smoke status")
        connection = connect()
        try:
            connection.request("GET", path)
            require(connection.getresponse().status == status, "Stage smoke status differs")
        finally:
            connection.close()

    def verify_schema(self, baseline, candidate):
        source, _ = self.runtime(candidate)
        assertion = """
            import { collectMigrationLedger, expectedMigrationLedger } from './.github/ci/staging-migration-ledger.mjs';
            import { installHash, installJson } from './.github/ci/ci-install-grant.mjs';
            const actual = collectMigrationLedger();
            const expected = installHash(installJson(expectedMigrationLedger(process.argv[1])));
            console.log(JSON.stringify({actual: actual.expectedSha256, expected}));
        """
        result = subprocess.run(
            ["/opt/node22/bin/node", "--env-file=.env.production", "--input-type=module",
             "-e", assertion, str(source)],
            cwd=APP, capture_output=True, text=True, timeout=25,
        )
        require(result.returncode == 0, "Could not verify the staging migration ledger")
        report = json.loads(result.stdout)
        worker = subprocess.run(
            ["/opt/node22/bin/node", "--env-file=.env.production", "--import", "tsx",
             "scripts/check-import-worker.ts"], cwd=APP, capture_output=True, timeout=25,
        )
        require(worker.returncode == 0, "The staging import worker heartbeat is stale")
        require(report["actual"] == report["expected"] == baseline.schema == candidate.schema,
                "Live and candidate schema identities differ")

    def canonical_state(self):
        before = canonical_live_state()
        require(before.get("state") == "ok" and before.get("stale_build") == "0"
                and before.get("ref") == before.get("built_ref")
                and before.get("build_id") == before.get("built_build_id"),
                "Canonical source and build must match")
        verify_next_build(APP, before["build_id"], self.ingress)
        after = canonical_live_state()
        require(all(before[key] == after[key] for key in
                    ("state", "stale_build", "ref", "built_ref", "build_id", "built_build_id"))
                and self.pointer.resolve(strict=True) == self.canonical_socket,
                "Canonical route moved during verification")
        return {**after, "backend": "canonical"}

    def queue_state(self):
        # The switch is uncommitted until application health and the selected outcome pass.
        require(not self.journal.exists(), "Interrupted cutover requires recovery")
        if self.pointer.resolve(strict=True) == self.canonical_socket:
            state = self.canonical_state()
            require(not self.journal.exists(), "Cutover is still in progress")
            return state
        release = self.live_health()
        _, build = self.runtime(release)
        require(not self.journal.exists(), "Cutover is still in progress")
        return dict(state="ok", stale_build="0", ref=release.source, built_ref=release.source,
                    build_id=build, built_build_id=build, backend="immutable")


def activate(queue, cutover, lease, digest):
    """Switch only the prepared release bound to the shared queue's installing phase."""
    receipt = read_json(cutover.prepared_path(digest))
    baseline = Release(**receipt["baseline"])
    candidate = Release(**receipt["candidate"])
    require(candidate.artifact == digest, "Prepared release digest differs")
    require(baseline.schema == candidate.schema, "Schema changes require the upgrade path")
    with queue.operations(exclusive=True), queue.transaction():
        held, plan = queue.lease(lease)
        require(plan_is_cutover(plan), "The batch was not admitted to the cutover lane")
        require(held["phase"] == "installing", "Cutover requires the installing phase")
        require(plan["baseline"] == baseline.source and plan["candidate"] == candidate.source,
                "Cutover sources differ from the leased batch")
        require(plan["baselineBuild"] == cutover.runtime(baseline)[1], "Leased baseline build differs")
        require(all(
            spec["risk"] == "ordinary" and not spec["migrations"]
            for member in plan["tickets"]
            for spec in [json.loads(queue.row("tickets", member)["spec"])]
        ), "Cutover requires ordinary migration-free tickets")
        cutover.verify_schema(baseline, candidate)
        build = cutover.runtime(candidate)[1]
        seen = cutover.queue_state()
        if seen["ref"] == candidate.source and seen["build_id"] == build:
            # A prior attempt can have switched successfully and lost the SQL commit.
            # Verify the exact route and outcome again before recording arrival.
            cutover.assert_live(candidate)
            cutover.prove_outcome(cutover.ingress, receipt["smoke"])
            result = {"source": candidate.source, "artifact": digest, "resumedArrival": True}
        else:
            queue.ready(plan["baseline"], plan["baselineBuild"])
            result = cutover.activate(digest)
        queue.ready(candidate.source, build)
        queue.db.execute("UPDATE lease SET phase='arrived',build=?", (build,))
        queue.event("cutover", "phase", {"batch": held["batch"], "epoch": held["epoch"],
                                         "phase": "arrived", "build": build})
        return {**result, "build": build, "epoch": held["epoch"]}


def recover(queue, cutover, lease):
    """Restore an interrupted route under the same lease that held the switch."""
    with queue.operations(exclusive=True), queue.transaction():
        held, plan = queue.lease(lease)
        require(plan_is_cutover(plan), "The batch was not admitted to the cutover lane")
        require(held["phase"] == "installing", "Cutover recovery requires the installing phase")
        if cutover.journal.exists():
            journal = read_json(cutover.journal)
            require(journal["baseline"]["source"] == plan["baseline"]
                    and journal["candidate"]["source"] == plan["candidate"],
                    "Recovery journal belongs to a different release")
        return cutover.recover()


def promote(queue, cutover, lease, digest):
    """Catch up the canonical backend and park ingress there without exposing its restart."""
    receipt = read_json(cutover.prepared_path(digest))
    baseline = Release(**receipt["baseline"])
    candidate = Release(**receipt["candidate"])
    require(candidate.artifact == digest, "Prepared release digest differs")
    build = cutover.runtime(candidate)[1]
    with queue.operations() as guard, (cutover.root / "cutover.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with queue.transaction():
            held, plan = queue.lease(lease)
            require(plan_is_cutover(plan) and held["phase"] == "arrived",
                    "Canonical handback requires a verified cutover arrival")
            require(plan["candidate"] == candidate.source and plan["baseline"] == baseline.source
                    and held["build"] == build, "Canonical handback lease differs")
            queue.ready(candidate.source, build)
        if cutover.pointer.resolve(strict=True) == cutover.canonical_socket:
            return {"parked": True, "resumed": True, "build": build}
        cutover.assert_live(candidate)
        # A previous immutable-only release must first be reconciled by its original lease.
        require(cutover.endpoint(baseline) == cutover.canonical_socket,
                "Canonical rollback baseline was not pinned")
        env = dict(os.environ, AIHR_STAGING_BATCH=held["batch"],
                   AIHR_STAGING_EPOCH=str(held["epoch"]), AIHR_STAGING_TOKEN=lease["token"],
                   AIHR_STAGING_CANDIDATE=candidate.source, AIHR_STAGING_CUTOVER_CANONICAL="1")
        subprocess.run(
            ["/bin/bash", str(Path(__file__).with_name("canonical-deploy.sh")),
             digest, baseline.source, plan["baselineBuild"], build],
            env=env, pass_fds=(guard,), check=True,
        )
        verify_next_build(APP, build, lambda: UnixHTTPConnection(cutover.canonical_socket))
        cutover.switch_to(cutover.canonical_socket)
        try:
            queue.ready(candidate.source, build)
            cutover.prove_outcome(cutover.ingress, receipt["smoke"])
        except Exception:
            cutover.switch(candidate)
            cutover.assert_live(candidate)
            raise
        return {"parked": True, "build": build}


def open_staging(path):
    private(path)
    config = read_json(path)
    require(set(config) == {"root", "port"}, "Unknown cutover configuration")
    root, port = Path(config["root"]), config["port"]
    require(root.is_absolute() and type(port) is int and 1024 <= port <= 65535,
            "Invalid staging cutover root or loopback ingress port")
    return NextStaging(root, port)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("observe", "prepare", "activate", "promote", "recover"))
    parser.add_argument("--packet", type=Path)
    parser.add_argument("--smoke-path")
    parser.add_argument("--smoke-status", type=int)
    parser.add_argument("--lease-stdin", action="store_true")
    parser.add_argument("--artifact-digest")
    args = parser.parse_args()
    cutover = open_staging(ROOT / "cutover.json")
    if args.command == "observe":
        print(json.dumps(cutover.queue_state()))
        return
    if args.command == "prepare":
        packet = args.packet
        require(packet is not None and packet.is_absolute(), "Exact private staging packet is required")
        private(packet, directory=True)
        candidate = Release(**read_json(packet / "release.json")["release"])
        state = cutover.queue_state()
        if cutover.pointer.resolve(strict=True) == cutover.canonical_socket:
            identity = json.dumps({"source": state["ref"], "build": state["build_id"]},
                                  sort_keys=True).encode()
            baseline = Release(state["ref"], hashlib.sha256(identity).hexdigest(), candidate.schema)
            cutover.pin_canonical(baseline, state["build_id"])
        else:
            baseline = cutover.live_health()
        cutover.verify_schema(baseline, candidate)
        print(json.dumps(cutover.prepare(baseline, candidate, packet / "build.tar.gz",
                                        {"path": args.smoke_path, "status": args.smoke_status})))
        return
    queue = Coordinator(probe=cutover.queue_state)
    try:
        lease = (json.loads(sys.stdin.buffer.read(4097)) if args.lease_stdin else environment_request())
        if args.command == "activate":
            result = activate(queue, cutover, lease, args.artifact_digest)
        elif args.command == "promote":
            result = promote(queue, cutover, lease, args.artifact_digest)
        else:
            result = {"recovered": recover(queue, cutover, lease)}
        print(json.dumps(result))
    finally:
        queue.db.close()


if __name__ == "__main__":
    main()
