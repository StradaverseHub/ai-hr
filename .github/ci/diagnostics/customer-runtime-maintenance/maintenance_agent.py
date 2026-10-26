"""Bounded staging configuration transition; separate from app release authority.

Operational inputs are private. Never print subprocess output, environment values,
backup bytes, or provider errors. The canonical app operator owns build/migrations.
"""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile

VERSION = "22.23.3"
NODE_SHA256 = "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
PRE_RELEASE = {"prepared", "stopping", "stopped", "environment-written", "unit-written", "reloaded", "ready-for-release"}


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def read_regular(path, maximum=4 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum,
                "Expected bounded regular file")
        data = b""
        while chunk := os.read(fd, min(maximum + 1 - len(data), 1024 * 1024)):
            data += chunk
            require(len(data) <= maximum, "File exceeded bound")
        require(file_identity(before) == file_identity(os.fstat(fd)) == file_identity(os.lstat(path)),
                "File changed while reading")
        return data, before
    finally:
        os.close(fd)


def exclusive(path, data, mode=0o600, uid=0, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
        require(read_regular(path, max(len(data), 1))[0] == data, "Written file readback differs")
    finally:
        os.close(fd)
    fsync_directory(Path(path).parent)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_replace(path, data, original, operation):
    current, info = read_regular(path)
    require(current == original[0] and file_identity(info) == original[1], "Target changed before replacement")
    temporary = path + ".maintenance-" + operation
    exclusive(temporary, data, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
    require(read_regular(path)[0] == current and file_identity(os.lstat(path)) == original[1],
            "Target raced before atomic replacement")
    os.replace(temporary, path)
    fsync_directory(Path(path).parent)


def file_identity(s):
    return {"device": s.st_dev, "inode": s.st_ino, "uid": s.st_uid, "gid": s.st_gid,
            "mode": stat.S_IMODE(s.st_mode), "size": s.st_size,
            "mtimeNs": s.st_mtime_ns, "ctimeNs": s.st_ctime_ns}


def validate_plan(plan, now=None):
    require(plan.get("format") == 1 and plan.get("purpose") == "staging-smtp-runtime-maintenance",
            "Wrong maintenance plan")
    require(re.fullmatch(r"[a-f0-9-]{36}", plan.get("operation", "")), "Invalid operation")
    for name in ("candidate", "controller", "baseline"):
        require(re.fullmatch(r"[a-f0-9]{40}", plan.get(name, "")), "Invalid source binding")
    require(plan["candidate"] == plan["controller"], "Exact frozen source/controller required")
    require(plan.get("nodeSha256") == NODE_SHA256, "Unreviewed Node archive")
    witness = plan.get("witness", {})
    require(witness.get("sha") == plan["candidate"] and witness.get("controller") == plan["controller"]
            and witness.get("baseline") == plan["baseline"] and witness.get("result") == "PASS"
            and witness.get("policyVersion") == "aihr-staging-ci/v14"
            and witness.get("trustedFullEvidenceAuthenticated") is True,
            "Authentic complete trusted witness required; diagnostics do not authorize maintenance")
    runtime = witness.get("runtime", {})
    require(runtime == {"node": VERSION, "abi": "127", "platform": "linux", "arch": "x64",
                        "glibc": "2.39", "next": "16.3.8"}, "Native build tuple differs")
    require(plan.get("baselineSourceProof", {}).get("checksumOutput") == ""
            and plan.get("baselineSourceProof", {}).get("baseline") == plan["baseline"]
            and re.fullmatch(r"[a-f0-9]{64}", plan.get("baselineSourceProof", {}).get("evidenceSha256", "")),
            "Actual canonical baseline source proof required")
    for key in ("proposalProgram", "databaseProgram", "actualPreflightProgram"):
        source = plan.get(key)
        require(isinstance(source, str) and 100 < len(source.encode()) < 160 * 1024
                and sha(source.encode()) == plan.get(key + "Sha256"), "Operator source binding differs")
    observed = dt.datetime.fromisoformat(plan["observedAt"].replace("Z", "+00:00"))
    now = now or dt.datetime.now(dt.timezone.utc)
    require(dt.timedelta(seconds=-60) <= now - observed <= dt.timedelta(minutes=120),
            "Maintenance observations expired; refresh before approval")
    snap = plan.get("snapshot", {})
    require(snap.get("baseline", {}).get("sourceRef") == plan["baseline"]
            and snap.get("proposal", {}).get("releaseAuthorized") is False
            and snap.get("hostWrites") is False, "Actual read-only baseline required")
    db = plan.get("database", {})
    require(db.get("unfiltered") is True and db.get("readOnly") is True
            and db.get("migrationRows") == plan.get("baselineMigrationRows"), "Unfiltered baseline custody required")
    require(isinstance(plan.get("expectedPnpmPath"), str)
            and re.fullmatch(r"/[A-Za-z0-9_./-]+", plan["expectedPnpmPath"]), "Reviewed package-manager path required")
    return plan


def stable_snapshot(snapshot):
    return {k: v for k, v in snapshot.items() if k != "observedAt"}


class Engine:
    """Host interface permits exact phase/refusal testing without a real service."""
    def __init__(self, host, plan):
        self.host, self.plan = host, validate_plan(plan)

    def prepare(self):
        require(self.host.phase() is None, "Operation already exists")
        private = self.host.proposals()
        require(stable_snapshot(private["snapshot"]) == stable_snapshot(self.plan["snapshot"]),
                "Actual baseline/proposal changed after review")
        require(self.host.database() == self.plan["database"], "Database custody changed after review")
        self.host.backup(private)
        self.host.install_node()
        self.host.verify_node_and_package_manager()
        self.host.save_phase("prepared")

    def cutover(self):
        require(self.host.phase() == "prepared", "Preparation required")
        private = self.host.proposals()
        require(stable_snapshot(private["snapshot"]) == stable_snapshot(self.plan["snapshot"]),
                "Baseline/proposal changed before service stop")
        require(self.host.database() == self.plan["database"], "Database changed before service stop")
        self.host.verify_node_and_package_manager()
        self.host.save_phase("stopping")
        self.host.stop()
        self.host.save_phase("stopped")
        self.host.require_inactive()
        require(self.host.database() == self.plan["database"], "Database changed during service stop")
        self.host.write_environment(private)
        self.host.save_phase("environment-written")
        self.host.write_unit(private)
        self.host.save_phase("unit-written")
        self.host.reload()
        self.host.save_phase("reloaded")
        self.host.actual_preflight()
        self.host.require_inactive()
        self.host.save_phase("ready-for-release")

    def release_started(self):
        require(self.host.phase() == "ready-for-release", "Actual Node22 preflight required")
        self.host.require_inactive()
        self.host.assert_proposed_configuration()
        self.host.save_phase("release-started")

    def recover_before_release(self):
        require(self.host.phase() in PRE_RELEASE, "Automatic recovery forbidden after release started")
        if self.host.phase() == "prepared":
            self.host.assert_original_active()
            return {"phase": "prepared", "oldServiceStillActive": True, "node22Retained": True}
        self.host.require_inactive()
        self.host.assert_baseline_custody()
        require(self.host.database() == self.plan["database"],
                "Migration/identity/audit custody changed; reviewed forward recovery required")
        self.host.restore_configuration()
        self.host.reload()
        self.host.start_original()
        self.host.assert_original_active()
        self.host.save_phase("recovered-before-release")
        return {"phase": "recovered-before-release", "newReleaseAccepted": False, "node22Retained": True}


class RealHost:
    def __init__(self, plan, operation_dir, archive):
        self.plan, self.root, self.archive = plan, Path(operation_dir), archive
        self.env_path = "/opt/ai-hr/.env.production"
        self.dropin = "/etc/systemd/system/aihr.service.d/40-customer-node22.conf"
        require(str(self.root) == "/var/lib/aihr-runtime-maintenance/" + plan["operation"], "Wrong operation directory")
        s = os.lstat(self.root)
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o700
                and os.path.realpath(self.root) == str(self.root), "Root-owned private operation directory required")
        self.state_file = self.root / "phase.json"

    def command(self, args, *, input=None, env=None, timeout=30):
        try:
            return subprocess.run(args, input=input, env=env or {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                  cwd="/opt/ai-hr", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  check=True, timeout=timeout).stdout
        except (subprocess.SubprocessError, OSError):
            raise Refused("Host operation failed; private subprocess output withheld") from None

    def node(self, program):
        return json.loads(self.command(["/opt/node20/bin/node", "--input-type=module"], input=program.encode(), timeout=60))

    def proposals(self):
        return self.node(self.plan["proposalProgram"])

    def database(self):
        return self.node(self.plan["databaseProgram"])

    def phase(self):
        try:
            value = json.loads(read_regular(self.state_file)[0])
        except FileNotFoundError:
            return None
        require(value["planSha256"] == sha(encoded(self.plan)), "Operation belongs to another plan")
        return value["phase"]

    def save_phase(self, phase):
        data = encoded({"phase": phase, "planSha256": sha(encoded(self.plan)),
                        "at": dt.datetime.now(dt.timezone.utc).isoformat()})
        # Retain every phase record. No success state or release instrumentation is manufactured.
        index = len(list(self.root.glob("phase-*.json")))
        exclusive(self.root / ("phase-%03d.json" % index), data)
        temp = self.root / ("phase-current-%03d.json" % index)
        exclusive(temp, data)
        os.replace(temp, self.state_file)
        fsync_directory(self.root)

    def backup(self, private):
        require(not (self.root / "backup.json").exists(), "Existing backup must not be overwritten")
        records = []
        paths = [self.env_path, "/var/tmp/aihr-deploy/current", "/var/tmp/aihr-deploy/last-ok",
                 "/opt/ai-hr/.next/BUILD_ID"]
        paths += [r["path"] for r in private["snapshot"]["configuration"]["unitFiles"]]
        for index, path in enumerate(paths):
            data, info = read_regular(path)
            name = "backup-%03d.private" % index
            exclusive(self.root / name, data)
            records.append({"path": path, "member": name, "sha256": sha(data), "identity": file_identity(info)})
        require(sha(base64.b64decode(private["environment"])) == self.plan["snapshot"]["proposal"]["environment"]["proposedSha256"]
                and sha(base64.b64decode(private["unit"])) == self.plan["snapshot"]["proposal"]["unit"]["sha256"],
                "Private proposed bytes differ")
        exclusive(self.root / "proposed-environment.private", base64.b64decode(private["environment"]))
        exclusive(self.root / "proposed-unit.private", base64.b64decode(private["unit"]))
        exclusive(self.root / "active-environment.private", base64.b64decode(private["activeEnvironment"]))
        exclusive(self.root / "backup.json", encoded(records))
        exclusive(self.root / "database-before.json", encoded(self.plan["database"]))

    def install_node(self):
        require(not os.path.lexists("/opt/node22"), "Existing Node22 installation requires separate review")
        archive, _ = read_regular(self.archive, 80 * 1024 * 1024)
        require(sha(archive) == NODE_SHA256, "Node archive SHA256 differs")
        stage = Path("/opt/.aihr-node22-" + self.plan["operation"])
        stage.mkdir(mode=0o700)
        with tarfile.open(self.archive, "r:xz") as package:
            members = package.getmembers()
            require(len(members) < 20000, "Unbounded Node archive")
            top = "node-v" + VERSION + "-linux-x64"
            for member in members:
                pieces = Path(member.name).parts
                require(pieces and pieces[0] == top and not Path(member.name).is_absolute()
                        and ".." not in pieces and (member.isfile() or member.isdir() or member.issym()),
                        "Unexpected Node archive member")
                if member.issym():
                    target = os.path.normpath(str(Path(member.name).parent / member.linkname))
                    require(not os.path.isabs(member.linkname) and target.startswith(top + "/"),
                            "Node archive link escapes its root")
            # The archive is hash-pinned; Python's data filter additionally excludes unsafe metadata.
            package.extractall(stage, filter="data")
        os.rename(stage / top, "/opt/node22")
        stage.rmdir()
        os.chmod("/opt/node22", 0o755)
        fsync_directory("/opt")

    def verify_node_and_package_manager(self):
        runtime = json.loads(self.command(["/opt/node22/bin/node", "-p",
            "JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime})"]))
        require(runtime == {"node": VERSION, "abi": "127", "platform": "linux", "arch": "x64", "glibc": "2.39"},
                "Installed Node runtime differs from native CI build")
        user = self.plan["snapshot"]["configuration"]["serviceUser"]
        require(re.fullmatch(r"[a-z_][a-z0-9_-]*", user), "Reviewed ordinary service account required")
        result = self.command(["/usr/sbin/runuser", "-u", user, "--", "/usr/bin/env", "-i",
                               "PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin",
                               self.plan["expectedPnpmPath"], "--version"])
        require(result.strip() == b"10.33.2", "Existing package manager differs; no implicit installation permitted")

    def stop(self):
        self.command(["/usr/bin/systemctl", "stop", "aihr.service"], timeout=60)

    def require_inactive(self):
        state = self.command(["/usr/bin/systemctl", "show", "aihr.service", "--property=ActiveState", "--value"]).strip()
        pid = self.command(["/usr/bin/systemctl", "show", "aihr.service", "--property=MainPID", "--value"]).strip()
        require(state == b"inactive" and pid == b"0", "Service must be fully stopped")

    def write_environment(self, private):
        record = self._records()[0]
        original = read_regular(self.root / record["member"])[0]
        atomic_replace(self.env_path, base64.b64decode(private["environment"]),
                       (original, record["identity"]), self.plan["operation"])

    def write_unit(self, private):
        parent = Path(self.dropin).parent
        if not parent.exists():
            parent.mkdir(mode=0o755)
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                and os.path.realpath(parent) == str(parent), "Unsafe unit drop-in directory")
        exclusive(self.dropin, base64.b64decode(private["unit"]), mode=0o644)

    def reload(self):
        self.command(["/usr/bin/systemctl", "daemon-reload"])

    def actual_preflight(self):
        self.assert_proposed_configuration()
        # Fixed reviewed checker source executes with real Node22, never a simulated process.version.
        # Environment values are parsed by the bound literal parser and inherited only in memory.
        report = self.node(self.plan["actualPreflightProgram"])
        require(report == {"operatorErrors": [], "webErrors": [], "node": VERSION, "abi": "127"},
                "Actual Node22 customer preflight refused")

    def assert_proposed_configuration(self):
        require(sha(read_regular(self.env_path)[0]) == self.plan["snapshot"]["proposal"]["environment"]["proposedSha256"]
                and sha(read_regular(self.dropin)[0]) == self.plan["snapshot"]["proposal"]["unit"]["sha256"],
                "Proposed configuration differs")
        executable = self.command(["/usr/bin/systemctl", "show", "aihr.service", "--property=ExecStart", "--value"]).decode()
        require(executable.count("path=/opt/node22/bin/node ;") == 1
                and "/opt/node20/bin/node" not in executable, "Reloaded service executable differs")

    def _records(self):
        return json.loads(read_regular(self.root / "backup.json")[0])

    def assert_baseline_custody(self):
        for record in self._records()[1:]:
            data, info = read_regular(record["path"])
            require(sha(data) == record["sha256"] and file_identity(info) == record["identity"],
                    "Retained baseline/unit custody changed")
        require(not os.path.lexists("/var/tmp/aihr-deploy/pending"), "A deployment may have started")
        directory = os.lstat("/opt/ai-hr/.next")
        old = self.plan["snapshot"]["baseline"]["activeDirectory"]
        require(stat.S_ISDIR(directory.st_mode) and directory.st_dev == old["device"]
                and directory.st_ino == old["inode"], "Retained baseline build was exchanged")

    def restore_configuration(self):
        record = self._records()[0]
        old = read_regular(self.root / record["member"])[0]
        require(sha(old) == record["sha256"], "Original private backup corrupted")
        current, info = read_regular(self.env_path)
        allowed = {record["sha256"], self.plan["snapshot"]["proposal"]["environment"]["proposedSha256"]}
        require(sha(current) in allowed and info.st_uid == record["identity"]["uid"]
                and info.st_gid == record["identity"]["gid"] and stat.S_IMODE(info.st_mode) == record["identity"]["mode"],
                "Unexpected private environment; no overwrite permitted")
        if current != old:
            atomic_replace(self.env_path, old, (current, file_identity(info)), self.plan["operation"] + "-restore")
        if os.path.lexists(self.dropin):
            require(sha(read_regular(self.dropin)[0]) == self.plan["snapshot"]["proposal"]["unit"]["sha256"],
                    "Another owner changed the drop-in")
            os.unlink(self.dropin)
            fsync_directory(Path(self.dropin).parent)

    def start_original(self):
        self.command(["/usr/bin/systemctl", "start", "aihr.service"], timeout=60)

    def assert_original_active(self):
        result = self.proposals()["snapshot"]
        require(result["baseline"]["sourceRef"] == self.plan["baseline"]
                and result["baseline"]["buildId"] == self.plan["snapshot"]["baseline"]["buildId"]
                and result["baseline"]["health"] == 200
                and result["proposal"] == self.plan["snapshot"]["proposal"], "Original runtime/configuration not restored")
        self.assert_baseline_custody()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "cutover", "release-started", "recover-before-release"))
    parser.add_argument("--plan", required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--human-approval", required=True)
    parser.add_argument("--archive", required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "Private terminal sudo is required")
    require(os.path.realpath(__file__) == __file__ and os.stat(__file__).st_uid == 0
            and not os.stat(__file__).st_mode & 0o022, "Execute only root-owned reviewed agent bytes")
    data, info = read_regular(args.plan)
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and sha(data) == args.plan_sha256,
            "Exact root-private approved plan required")
    plan = validate_plan(json.loads(data))
    approval, ai = read_regular(args.human_approval, 16384)
    grant = json.loads(approval)
    require(ai.st_uid == 0 and stat.S_IMODE(ai.st_mode) == 0o600
            and grant.get("planSha256") == sha(data) and grant.get("agentSha256") == sha(read_regular(__file__)[0])
            and grant.get("scope") == "staging-node22-config-and-app-release"
            and isinstance(grant.get("humanApprovalReference"), str) and len(grant["humanApprovalReference"]) >= 12,
            "Explicit human maintenance approval for these exact artifacts required")
    directory = "/var/lib/aihr-runtime-maintenance/" + plan["operation"]
    host = RealHost(plan, directory, args.archive)
    lock = os.open(Path(directory) / "operation.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        engine = Engine(host, plan)
        result = getattr(engine, args.phase.replace("-", "_"))()
        print(json.dumps(result or {"phase": host.phase(), "applicationReleaseAccepted": False}))
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError) as error:
        # Generic exception types can contain paths or private values: withhold their messages.
        print(json.dumps({"maintenanceRefused": True,
                          "reason": str(error) if isinstance(error, Refused) else "Private operation input/state invalid",
                          "automaticDatabaseRollback": False, "newReleaseAccepted": False}))
        raise SystemExit(1)
