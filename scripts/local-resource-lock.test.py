"""Real subprocesses and private directories only. Never uses the shared Mac slots or DB."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

LAUNCHER = Path(__file__).with_name("local-resource-lock.py")
if not LAUNCHER.exists():
    LAUNCHER = Path(__file__).with_name("aihr-local-resource-lock.py")


class ResourceLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aihr-atomic-lock-test-")
        self.root = Path(self.temp.name).resolve()
        self.processes = []

    def tearDown(self):
        for child in self.processes:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
        self.temp.cleanup()

    def command(self, name, source, *, slots=2, database=False, wait=3):
        return [sys.executable, str(LAUNCHER), "--state-root", str(self.root), "--test-slots", str(slots), *(["--database"] if database else []), "--wait-seconds", str(wait), "--poll-seconds", "0.02", "--terminate-grace", "1", name, "--", sys.executable, "-c", source]

    def start(self, command):
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(child)
        return child

    def wait_file(self, path):
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(path.exists(), str(path))

    def collect(self, child):
        output = child.communicate(timeout=10)
        return child.returncode, output

    def no_slots(self):
        return not list(self.root.glob("locks/slot.*")) and not list(self.root.glob("devdb-locks/slot.*"))

    def foreign_slot(self, group="locks", number=1):
        foreign = self.start([sys.executable, "-c", "import time;time.sleep(60)"])
        path = self.root / group / f"slot.{number}"
        path.mkdir(parents=True)
        (path / "pid").write_text(str(foreign.pid) + "\n")
        (path / "name").write_text("unrelated-fixture-owner\n")
        return path

    def test_three_concurrent_exclusive_jobs_finish_without_split_slot_deadlock(self):
        source = f'''import os,time,json
from pathlib import Path
root=Path({str(self.root)!r})
paths=[root/'locks/slot.1',root/'locks/slot.2',root/'devdb-locks/slot.1']
pids=[int((p/'pid').read_text()) for p in paths]
assert len(set(pids))==1 and pids[0]==os.getppid(),pids
print(json.dumps({{'start':time.monotonic(),'owner':pids[0]}}),flush=True)
time.sleep(.12)
print(json.dumps({{'end':time.monotonic()}}),flush=True)
'''
        children = [self.start(self.command("exclusive-" + str(i), source, database=True)) for i in range(3)]
        spans = []
        for child in children:
            code, (out, err) = self.collect(child)
            self.assertEqual(code, 0, err)
            a, b = map(json.loads, out.splitlines())
            spans.append((a["start"], b["end"]))
        spans.sort()
        self.assertTrue(all(spans[i][1] <= spans[i+1][0] for i in range(2)), spans)
        self.assertTrue(self.no_slots())

    def test_database_waiter_holds_no_test_slots(self):
        foreign = self.foreign_slot("devdb-locks")
        held = (foreign / "pid").read_bytes()
        waiter = self.start(self.command("full-set", "raise Exception('must not start')", database=True, wait=.5))
        time.sleep(.15)
        self.assertEqual(list(self.root.glob("locks/slot.*")), [])
        single = self.start(self.command("independent-single", "print('ran')", slots=1))
        code, (out, err) = self.collect(single)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), "ran")
        self.assertEqual(self.collect(waiter)[0], 75)
        self.assertEqual((foreign / "pid").read_bytes(), held)

    def test_single_slot_jobs_can_overlap_without_exceeding_capacity(self):
        source = "import time,json;print(json.dumps({'start':time.monotonic()}),flush=True);time.sleep(.2);print(json.dumps({'end':time.monotonic()}),flush=True)"
        jobs = [self.start(self.command("single-"+str(i), source, slots=1)) for i in range(3)]
        events = []
        for job in jobs:
            code, (out, err) = self.collect(job)
            self.assertEqual(code, 0, err)
            a, b = map(json.loads, out.splitlines())
            events.extend([(a["start"], 1), (b["end"], -1)])
        active = maximum = 0
        for _, delta in sorted(events):
            active += delta
            maximum = max(active, maximum)
        self.assertEqual(maximum, 2)
        self.assertTrue(self.no_slots())

    def test_legacy_occupied_slot_is_preserved_and_no_partial_slot_remains(self):
        foreign = self.foreign_slot()
        saved = {p.name: p.read_bytes() for p in foreign.iterdir()}
        child = self.start(self.command("blocked", "raise Exception('must not run')", wait=.1))
        self.assertEqual(self.collect(child)[0], 75)
        self.assertEqual({p.name: p.read_bytes() for p in foreign.iterdir()}, saved)
        self.assertFalse((self.root / "locks/slot.2").exists())

    def test_out_of_capacity_legacy_slots_block_without_new_leases(self):
        for group, number in [("locks", 3), ("devdb-locks", 2)]:
            with self.subTest(group=group):
                foreign = self.foreign_slot(group, number)
                saved = {p.name: p.read_bytes() for p in foreign.iterdir()}
                child = self.start(self.command("unexpected-capacity", "print('must not run')", database=True, wait=.1))
                code, (out, err) = self.collect(child)
                self.assertEqual(code, 75, err)
                self.assertEqual(out, "")
                self.assertEqual({p.name: p.read_bytes() for p in foreign.iterdir()}, saved)
                self.assertFalse((self.root / "locks/slot.1").exists())
                self.assertFalse((self.root / "devdb-locks/slot.1").exists())
                # These are this test's private fixture files, never shared leases.
                for file in foreign.iterdir(): file.unlink()
                foreign.rmdir()

    def test_missing_pid_legacy_reservation_is_preserved(self):
        path = self.root / "locks/slot.1"
        path.mkdir(parents=True)
        child = self.start(self.command("unknown-owner", "print('must not run')", wait=.1))
        self.assertEqual(self.collect(child)[0], 75)
        self.assertTrue(path.is_dir())
        self.assertEqual(list(path.iterdir()), [])

    def test_nested_upgrade_fails_promptly_and_outer_releases(self):
        inner = self.command("inner", "print('must not run')", slots=2)
        source = f"import subprocess,sys;r=subprocess.run({inner!r});sys.exit(r.returncode)"
        outer = self.start(self.command("outer", source, slots=1))
        code, (out, err) = self.collect(outer)
        self.assertEqual(code, 78, err)
        self.assertIn("nested resource acquisition is forbidden", err)
        self.assertTrue(self.no_slots())

    def test_child_exit_status_is_preserved(self):
        child = self.start(self.command("red-check", "raise SystemExit(42)", database=True))
        self.assertEqual(self.collect(child)[0], 42)
        self.assertTrue(self.no_slots())

    def test_signal_keeps_leases_through_owned_child_cleanup(self):
        ready, cleanup, done = [self.root / name for name in ("ready", "cleanup", "done")]
        source = f'''import signal,time,sys
from pathlib import Path
def stop(sig,frame):
 Path({str(cleanup)!r}).write_text('cleaning')
 time.sleep(.3)
 Path({str(done)!r}).write_text('done')
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
Path({str(ready)!r}).write_text('ready')
while True:time.sleep(.01)
'''
        child = self.start(self.command("cleanup-owner", source, database=True))
        self.wait_file(ready)
        child.send_signal(signal.SIGTERM)
        self.wait_file(cleanup)
        self.assertEqual(len(list(self.root.glob("locks/slot.*"))), 2)
        self.assertTrue((self.root / "devdb-locks/slot.1").exists())
        self.assertEqual(self.collect(child)[0], 143)
        self.assertTrue(done.exists())
        self.assertTrue(self.no_slots())

    def test_cancelled_waiter_does_not_start_or_remove_foreign_lease(self):
        foreign = self.foreign_slot()
        marker = self.root / "must-not-exist"
        child = self.start(self.command("queued", f"from pathlib import Path;Path({str(marker)!r}).touch()"))
        time.sleep(.15)
        child.send_signal(signal.SIGTERM)
        self.assertEqual(self.collect(child)[0], 143)
        self.assertTrue(foreign.exists())
        self.assertFalse(marker.exists())

    def test_changed_lease_token_is_not_deleted_or_reported_successful(self):
        ready = self.root / "ready"
        child = self.start(self.command("token-owner", f"from pathlib import Path;import time;Path({str(ready)!r}).touch();time.sleep(.25)"))
        self.wait_file(ready)
        lease = self.root / "locks/slot.1/lease.json"
        value = json.loads(lease.read_text())
        value["token"] = "foreign-replacement"
        lease.write_text(json.dumps(value))
        self.assertEqual(self.collect(child)[0], 78)
        self.assertEqual(json.loads(lease.read_text())["token"], "foreign-replacement")

    def test_actual_gate_helper_recognizes_both_private_ancestor_leases(self):
        helper = LAUNCHER.with_name("gate-lib.sh")
        self.assertTrue(helper.is_file(), "Actual repo gate helper is required")
        args = self.command("gate-helper-proof", "unused", database=True)
        args = args[:args.index("--") + 1] + ["bash", "-c", 'source "$1"; test "$(gate_slots_held_by_ancestors)" = 2', "gate-proof", str(helper)]
        child = self.start(args)
        code, (_, err) = self.collect(child)
        self.assertEqual(code, 0, err)
        self.assertTrue(self.no_slots())

    def gate_entry_fixture(self):
        home = self.root / "home"
        state = home / ".aihr-gate-state"
        state.mkdir(parents=True)
        (state / "testlock.sh").write_text("# private fixture marker, never executed\n")
        helper = LAUNCHER.with_name("gate-lib.sh")
        entry = self.root / "entry.sh"
        entry.write_text('#!/usr/bin/env bash\nset -uo pipefail\nsource "$1"\nhelper="$1"; shift\ngate_hold_both_slots "$0" "$helper" "$@"\ntest "$(AIHR_LOCK_DIR="$HOME/.aihr-gate-state/locks" gate_slots_held_by_ancestors)" = 2\ntest "$(AIHR_LOCK_DIR="$HOME/.aihr-gate-state/devdb-locks" gate_slots_held_by_ancestors)" = 1\ntest "$1" = "argument with spaces"\necho ACTUAL_GATE_ADMISSION_ENTERED\nexit 42\n')
        return home, state, ["bash", str(entry), str(helper), "argument with spaces"]

    def test_actual_gate_entry_reserves_complete_set_and_propagates_exit(self):
        home, state, command = self.gate_entry_fixture()
        child = subprocess.Popen(command, env={**os.environ, "HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(child)
        code, (out, err) = self.collect(child)
        self.assertEqual(code, 42, err)
        self.assertEqual(out.count("ACTUAL_GATE_ADMISSION_ENTERED"), 1)
        self.assertFalse(list(state.glob("locks/slot.*")))
        self.assertFalse(list(state.glob("devdb-locks/slot.*")))

    def test_actual_gate_entry_refuses_partial_outer_upgrade_and_releases(self):
        home, state, entry = self.gate_entry_fixture()
        command = [sys.executable, str(LAUNCHER), "--state-root", str(state), "--test-slots", "1", "partial-outer", "--", *entry]
        child = subprocess.Popen(command, env={**os.environ, "HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(child)
        code, (out, err) = self.collect(child)
        self.assertEqual(code, 78, err)
        self.assertNotIn("ACTUAL_GATE_ADMISSION_ENTERED", out)
        self.assertIn("resource upgrade refused", err)
        self.assertFalse(list(state.glob("locks/slot.*")))
        self.assertFalse(list(state.glob("devdb-locks/slot.*")))

    def test_missing_command_releases_owned_leases_and_refuses_success(self):
        args = self.command("missing-command", "unused")
        args = args[:args.index("--") + 1] + [str(self.root / "not-an-executable")]
        child = self.start(args)
        self.assertEqual(self.collect(child)[0], 127)
        self.assertTrue(self.no_slots())

    def test_symlink_parent_is_refused_before_creating_any_external_directory(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "alias").symlink_to(outside, target_is_directory=True)
        args = self.command("symlink-parent", "raise Exception('must not run')")
        args[args.index("--state-root") + 1] = str(self.root / "alias" / "not-created")
        child = self.start(args)
        self.assertEqual(self.collect(child)[0], 78)
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_resource_directory_is_refused_without_external_writes(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "locks").symlink_to(outside, target_is_directory=True)
        child = self.start(self.command("symlink-root", "raise Exception('must not run')"))
        self.assertEqual(self.collect(child)[0], 78)
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
