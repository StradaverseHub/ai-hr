"""Real private filesystem exchanges on Linux. No application, database, build or service."""
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("activation", Path(__file__).with_name("build-activate.py"))
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)

class Activation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.source = self.root/"source"
        self.source.mkdir(mode=0o755)
        self.parent = self.root/"private-stage"
        self.parent.mkdir(mode=0o700)
        self.staged = self.parent/"next"
        self.staged.mkdir(mode=0o700)
        self.old = self.source/".next"
        self.old.mkdir(mode=0o755)
        for path, value in [(self.staged, "new-build"), (self.old, "old-build")]:
            (path/"BUILD_ID").write_text(value+"\n")
            (path/"asset").write_text(value)
    def tearDown(self):
        self.temp.cleanup()
        self.assertFalse(self.root.exists(), "owned private fixture must be removed")
    def exchange(self, action="activate", new="new-build", old="old-build"):
        return activation.activate(self.staged, self.source, new, old, action)
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_real_exchange_and_owned_rollback_keep_both_builds(self):
        previous_new = self.staged.stat().st_ino
        previous_old = self.old.stat().st_ino
        result = self.exchange()
        self.assertEqual(self.old.stat().st_ino, previous_new)
        self.assertEqual(self.staged.stat().st_ino, previous_old)
        self.assertEqual((self.old/"asset").read_text(), "new-build")
        self.assertEqual((self.staged/"asset").read_text(), "old-build")
        self.assertFalse(result["releaseAuthorized"])
        self.assertFalse(result["serviceRestarted"])
        rollback = self.exchange("rollback", "old-build", "new-build")
        self.assertEqual(self.old.stat().st_ino, previous_old)
        self.assertEqual(self.staged.stat().st_ino, previous_new)
        self.assertEqual(rollback["activeBuildId"], "old-build")
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_no_missing_active_directory_during_concurrent_readers(self):
        errors, seen, stop = [], set(), threading.Event()
        started, saw_new = threading.Event(), threading.Event()
        def reader():
            while not stop.is_set():
                try:
                    value = (self.source/".next/BUILD_ID").read_text().strip()
                    seen.add(value);started.set()
                    if value == "new-build":saw_new.set()
                    if value not in {"old-build", "new-build"}:
                        errors.append(value)
                except BaseException as error:
                    errors.append(str(error))
        thread = threading.Thread(target=reader);thread.start()
        try:
            self.assertTrue(started.wait(timeout=2))
            self.exchange()
            self.assertTrue(saw_new.wait(timeout=2))
            self.exchange("rollback", "old-build", "new-build")
        finally:
            stop.set();thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(seen, {"old-build", "new-build"})
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_wrong_old_identity_refuses_before_intent_or_mutation(self):
        with self.assertRaisesRegex(ValueError, "identity differs"):
            self.exchange(old="wrong")
        self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "old-build")
        self.assertEqual((self.staged/"BUILD_ID").read_text().strip(), "new-build")
        self.assertFalse((self.parent/"activate-intent.json").exists())
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_active_or_staged_symlink_refuses(self):
        self.old.rename(self.source/"foreign")
        self.old.symlink_to(self.source/"foreign", target_is_directory=True)
        with self.assertRaises(OSError):
            self.exchange()
        self.assertEqual((self.source/"foreign/BUILD_ID").read_text().strip(), "old-build")
        self.old.unlink()
        (self.source/"foreign").rename(self.old)
        self.staged.rename(self.parent/"foreign")
        self.staged.symlink_to(self.parent/"foreign", target_is_directory=True)
        with self.assertRaises(OSError):
            self.exchange()
        self.assertEqual((self.parent/"foreign/BUILD_ID").read_text().strip(), "new-build")
        self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "old-build")
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_nonprivate_parent_and_inside_source_stage_refuse(self):
        self.parent.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private"):
            self.exchange()
        self.parent.chmod(0o700)
        inside = self.source/"private";inside.mkdir(mode=0o700)
        (inside/"next").mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "outside source"):
            activation.activate(inside/"next", self.source, "new-build", "old-build")
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_duplicate_or_ambiguous_replay_refuses_without_second_exchange(self):
        self.exchange()
        with self.assertRaisesRegex(ValueError, "identity differs"):
            self.exchange()
        self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "new-build")
        self.assertEqual((self.staged/"BUILD_ID").read_text().strip(), "old-build")
        self.exchange("rollback", "old-build", "new-build")
        with self.assertRaises(FileExistsError):
            self.exchange()
        self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "old-build")
    @unittest.skipUnless(sys.platform == "linux", "actual Linux syscall is verified only on Linux")
    def test_missing_build_id_refuses_and_preserves_directories(self):
        (self.staged/"BUILD_ID").unlink()
        with self.assertRaises(FileNotFoundError):
            self.exchange()
        self.assertTrue(self.old.is_dir())
        self.assertTrue(self.staged.is_dir())
    @unittest.skipUnless(sys.platform == "linux", "actual Linux filesystem boundary is verified only on Linux")
    def test_cross_filesystem_refuses_without_copy_or_exchange(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as temporary:
            parent = Path(temporary).resolve()
            parent.chmod(0o700)
            staged = parent/"next";staged.mkdir(mode=0o700)
            (staged/"BUILD_ID").write_text("new-build\n")
            self.assertNotEqual(parent.stat().st_dev, self.source.stat().st_dev)
            with self.assertRaisesRegex(ValueError, "one filesystem"):
                activation.activate(staged, self.source, "new-build", "old-build")
            self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "old-build")
            self.assertFalse((parent/"activate-intent.json").exists())
    def test_nonlinux_refuses_without_mutation(self):
        original = activation.sys.platform
        try:
            activation.sys.platform = "darwin"
            with self.assertRaisesRegex(ValueError, "Linux renameat2"):
                self.exchange()
            self.assertEqual((self.old/"BUILD_ID").read_text().strip(), "old-build")
        finally:
            activation.sys.platform = original

if __name__ == "__main__":
    evidence = None
    if len(sys.argv) == 3 and sys.argv[1] == "--evidence":
        evidence = Path(sys.argv[2]);sys.argv = [sys.argv[0]]
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Activation)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if evidence:
        packet = {"format": 1, "kind": "PRIVATE_FILESYSTEM_ACTIVATION_TEST_NOT_DEPLOYMENT",
                  "platform": sys.platform, "machine": platform.machine(), "libc": platform.libc_ver(),
                  "runId": os.environ.get("GITHUB_RUN_ID"), "controller": os.environ.get("GITHUB_SHA"),
                  "testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                  "skipped": len(result.skipped), "actualKernelExchanges": activation.EXCHANGES_EXECUTED,
                  "releaseAuthorized": False, "applicationBuildExecuted": False, "stagingTouched": False}
        with evidence.open("x") as output:
            output.write(json.dumps(packet, sort_keys=True)+"\n")
    sys.exit(0 if result.wasSuccessful() else 1)
