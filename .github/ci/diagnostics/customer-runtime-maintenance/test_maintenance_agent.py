"""Phase/refusal controls run only on a disposable hosted runner. No real host access."""
import copy
import datetime as dt
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("maintenance_agent", Path(__file__).with_name("maintenance_agent.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def plan_fixture():
    plan = {"format": 1, "purpose": "staging-smtp-runtime-maintenance",
            "operation": "12345678-1234-4123-8123-123456789abc", "candidate": "a" * 40,
            "controller": "a" * 40, "baseline": "b" * 40, "nodeSha256": m.NODE_SHA256,
            "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "baselineMigrationRows": 3,
            "baselineSourceProof": {"baseline": "b" * 40, "checksumOutput": "", "evidenceSha256": "c" * 64},
            "snapshot": {"baseline": {"sourceRef": "b" * 40}, "proposal": {"releaseAuthorized": False}, "hostWrites": False},
            "database": {"unfiltered": True, "readOnly": True, "migrationRows": 3, "digest": "before"},
            "expectedPnpmPath": "/usr/local/bin/pnpm",
            "witness": {"sha": "a" * 40, "controller": "a" * 40, "baseline": "b" * 40,
                        "result": "PASS", "policyVersion": "aihr-staging-ci/v14", "trustedFullEvidenceAuthenticated": True,
                        "runtime": {"node": m.VERSION, "abi": "127", "platform": "linux", "arch": "x64", "glibc": "2.39", "next": "16.3.8"}}}
    for key in ("proposalProgram", "databaseProgram", "actualPreflightProgram"):
        plan[key] = "/* fictional fixture, never executed */" + "x" * 110
        plan[key + "Sha256"] = m.sha(plan[key].encode())
    return plan


class FakeHost:
    def __init__(self, plan):
        self.plan = copy.deepcopy(plan)
        self.current = None
        self.calls = []
        self.db = copy.deepcopy(plan["database"])
        self.snap = copy.deepcopy(plan["snapshot"])
        self.active = True
        self.proposed = False
        self.release = False
        self.custody = True
        self.fail = None
        self.after_stop = None

    def record(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise m.Refused("Fictional injected failure")

    def phase(self):
        return self.current

    def proposals(self):
        self.record("proposals")
        return {"snapshot": copy.deepcopy(self.snap)}

    def database(self):
        self.record("database")
        return copy.deepcopy(self.db)

    def save_phase(self, phase):
        self.record("phase:" + phase)
        self.current = phase

    def backup(self, private):
        self.record("backup")

    def install_node(self):
        self.record("install_node")

    def verify_node_and_package_manager(self):
        self.record("verify_runtime")

    def stop(self):
        self.record("stop")
        self.active = False
        if self.after_stop:
            self.db["digest"] = self.after_stop

    def require_inactive(self):
        self.record("require_inactive")
        m.require(not self.active, "Fixture service active")

    def write_environment(self, private):
        self.record("write_environment")
        self.proposed = True

    def write_unit(self, private):
        self.record("write_unit")

    def reload(self):
        self.record("reload")

    def actual_preflight(self):
        self.record("actual_preflight")

    def assert_proposed_configuration(self):
        self.record("assert_proposed_configuration")
        m.require(self.proposed, "Fixture configuration differs")

    def assert_original_active(self):
        self.record("assert_original_active")
        m.require(self.active and not self.proposed and self.custody, "Fixture original baseline differs")

    def assert_baseline_custody(self):
        self.record("assert_baseline_custody")
        m.require(self.custody, "Fixture build/source/unit custody differs")

    def restore_configuration(self):
        self.record("restore_configuration")
        self.proposed = False

    def start_original(self):
        self.record("start_original")
        self.active = True


class PhaseTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan_fixture()
        self.host = FakeHost(self.plan)
        self.engine = m.Engine(self.host, self.plan)

    def prepared(self):
        self.engine.prepare()
        self.assertTrue(self.host.active)
        self.assertNotIn("stop", self.host.calls)

    def test_prepare_preserves_running_service_and_orders_backup_before_install(self):
        self.prepared()
        self.assertLess(self.host.calls.index("backup"), self.host.calls.index("install_node"))
        self.assertEqual(self.host.current, "prepared")

    def test_happy_cutover_requires_actual_preflight_and_leaves_service_stopped(self):
        self.prepared()
        self.engine.cutover()
        self.assertFalse(self.host.active)
        self.assertEqual(self.host.current, "ready-for-release")
        self.assertLess(self.host.calls.index("actual_preflight"), self.host.calls.index("phase:ready-for-release"))
        self.assertNotIn("start_original", self.host.calls)

    def test_source_or_proposal_race_refuses_before_stop(self):
        self.prepared()
        self.host.snap["proposal"]["changed"] = True
        with self.assertRaises(m.Refused):
            self.engine.cutover()
        self.assertTrue(self.host.active)
        self.assertNotIn("write_environment", self.host.calls)

    def test_database_race_before_stop_refuses_before_any_configuration_write(self):
        self.prepared()
        self.host.db["digest"] = "new audit or identity"
        with self.assertRaises(m.Refused):
            self.engine.cutover()
        self.assertNotIn("stop", self.host.calls)

    def test_database_race_during_stop_preserves_stopped_phase_without_config_write(self):
        self.prepared()
        self.host.after_stop = "new mutation"
        with self.assertRaises(m.Refused):
            self.engine.cutover()
        self.assertFalse(self.host.active)
        self.assertEqual(self.host.current, "stopped")
        self.assertNotIn("write_environment", self.host.calls)

    def test_runtime_mismatch_never_stops_old_service(self):
        self.prepared()
        self.host.fail = "verify_runtime"
        with self.assertRaises(m.Refused):
            self.engine.cutover()
        self.assertTrue(self.host.active)

    def test_preflight_failure_never_claims_release_ready(self):
        self.prepared()
        self.host.fail = "actual_preflight"
        with self.assertRaises(m.Refused):
            self.engine.cutover()
        self.assertEqual(self.host.current, "reloaded")
        self.assertFalse(self.host.active)

    def test_pre_release_recovery_proves_custody_and_restores_old_service(self):
        self.prepared()
        self.engine.cutover()
        result = self.engine.recover_before_release()
        self.assertTrue(self.host.active)
        self.assertFalse(result["newReleaseAccepted"])
        self.assertTrue(result["node22Retained"])
        self.assertLess(self.host.calls.index("assert_baseline_custody"), self.host.calls.index("restore_configuration"))

    def test_recovery_refuses_new_migration_identity_or_audit_state(self):
        for marker in ("migration", "identity", "audit", "audit setting"):
            with self.subTest(marker=marker):
                host = FakeHost(self.plan)
                engine = m.Engine(host, self.plan)
                engine.prepare(); engine.cutover()
                host.db["digest"] = marker
                with self.assertRaises(m.Refused):
                    engine.recover_before_release()
                self.assertNotIn("restore_configuration", host.calls)

    def test_recovery_refuses_source_build_or_unit_changes(self):
        self.prepared(); self.engine.cutover()
        self.host.custody = False
        with self.assertRaises(m.Refused):
            self.engine.recover_before_release()
        self.assertNotIn("restore_configuration", self.host.calls)

    def test_release_boundary_permanently_disables_automatic_recovery(self):
        self.prepared(); self.engine.cutover(); self.engine.release_started()
        with self.assertRaises(m.Refused):
            self.engine.recover_before_release()
        self.assertNotIn("restore_configuration", self.host.calls)
        self.assertEqual(self.host.current, "release-started")

    def test_active_service_cannot_be_marked_release_started(self):
        self.prepared(); self.engine.cutover()
        self.host.active = True
        with self.assertRaises(m.Refused):
            self.engine.release_started()
        self.assertEqual(self.host.current, "ready-for-release")

    def test_prepare_only_recovery_never_writes_or_stops(self):
        self.prepared()
        result = self.engine.recover_before_release()
        self.assertTrue(result["oldServiceStillActive"])
        self.assertNotIn("restore_configuration", self.host.calls)


class InputAndFileTests(unittest.TestCase):
    def test_untrusted_or_incomplete_witness_refused(self):
        for field, value in (("trustedFullEvidenceAuthenticated", False), ("result", "FAIL"),
                             ("policyVersion", "diagnostic"), ("sha", "d" * 40)):
            plan = plan_fixture(); plan["witness"][field] = value
            with self.assertRaises(m.Refused):
                m.validate_plan(plan)

    def test_old_native_packet_refused(self):
        plan = plan_fixture(); plan["witness"]["runtime"]["node"] = "20.20.2"
        with self.assertRaises(m.Refused): m.validate_plan(plan)

    def test_modified_operator_program_refused(self):
        for name in ("proposalProgram", "databaseProgram", "actualPreflightProgram"):
            plan = plan_fixture(); plan[name] += "changed"
            with self.assertRaises(m.Refused): m.validate_plan(plan)

    def test_expired_or_future_plan_refused(self):
        for age in (dt.timedelta(hours=3), dt.timedelta(minutes=-5)):
            plan = plan_fixture(); plan["observedAt"] = (dt.datetime.now(dt.timezone.utc) - age).isoformat()
            with self.assertRaises(m.Refused): m.validate_plan(plan)

    def test_filtered_zero_is_not_custody(self):
        plan = plan_fixture(); plan["database"]["unfiltered"] = False
        with self.assertRaises(m.Refused): m.validate_plan(plan)

    def test_source_checksum_difference_refused(self):
        plan = plan_fixture(); plan["baselineSourceProof"]["checksumOutput"] = ">f changed"
        with self.assertRaises(m.Refused): m.validate_plan(plan)

    def test_regular_read_refuses_symlink_and_hardlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "file").write_bytes(b"fixture")
            (root / "link").symlink_to(root / "file")
            with self.assertRaises(OSError): m.read_regular(root / "link")
            os.link(root / "file", root / "hard")
            with self.assertRaises(m.Refused): m.read_regular(root / "file")

    def test_exclusive_backup_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup"
            m.exclusive(path, b"retained fixture", uid=os.getuid(), gid=os.getgid())
            with self.assertRaises(FileExistsError):
                m.exclusive(path, b"replacement", uid=os.getuid(), gid=os.getgid())
            self.assertEqual(path.read_bytes(), b"retained fixture")

    def test_atomic_replacement_refuses_named_file_race(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "env"
            path.write_bytes(b"original"); before = m.file_identity(path.stat())
            path.unlink(); path.write_bytes(b"other owner")
            with self.assertRaises(m.Refused):
                m.atomic_replace(str(path), b"proposal", (b"original", before), "fictional")
            self.assertEqual(path.read_bytes(), b"other owner")


if __name__ == "__main__":
    unittest.main(verbosity=2)
