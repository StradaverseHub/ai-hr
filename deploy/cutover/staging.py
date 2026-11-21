"""Next.js probes and shared staging lease for immutable cutovers."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

# The host runtime bundle places coordinator.py next to the cutover modules.
# The source checkout keeps staging coordinator code under scripts/staging.
if not (Path(__file__).parent / "coordinator.py").is_file():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/staging"))

from controller import Cutover, Release, UnixHTTPConnection, read_json
from coordinator import APP, Coordinator, ROOT, environment_request, plan_is_cutover, private, require
from next_probe import verify_next_build


class NextStaging(Cutover):
    """Report the release that ingress actually serves, checking its compiled marker."""

    def runtime(self, release):
        record = read_json(self.root / "releases" / f"{release.artifact}.json")
        require(Release(**record["release"]) == release, "Runtime release identity differs")
        return self.root / "source" / release.artifact, record["build"]

    def direct_health(self, release):
        source, build = self.runtime(release)
        return verify_next_build(source, build, lambda: UnixHTTPConnection(self.endpoint(release)))

    def live_health(self):
        name = self.pointer.resolve(strict=True).name
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
        require(report["actual"] == report["expected"] == baseline.schema == candidate.schema,
                "Live and candidate schema identities differ")

    def queue_state(self):
        # The switch is uncommitted until application health and the selected outcome pass.
        require(not self.journal.exists(), "Interrupted cutover requires recovery")
        release = self.live_health()
        _, build = self.runtime(release)
        require(not self.journal.exists(), "Cutover is still in progress")
        return dict(state="ok", stale_build="0", ref=release.source, built_ref=release.source,
                    build_id=build, built_build_id=build)


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
    parser.add_argument("command", choices=("observe", "activate", "recover"))
    parser.add_argument("--artifact-digest")
    args = parser.parse_args()
    cutover = open_staging(ROOT / "cutover.json")
    if args.command == "observe":
        print(json.dumps(cutover.queue_state()))
        return
    queue = Coordinator(probe=cutover.queue_state)
    try:
        lease = environment_request()
        result = (activate(queue, cutover, lease, args.artifact_digest)
                  if args.command == "activate" else {"recovered": recover(queue, cutover, lease)})
        print(json.dumps(result))
    finally:
        queue.db.close()


if __name__ == "__main__":
    main()
