"""Isolated real filesystem/flock refusal controls; no staging or application operations."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('custody_under_test', Path(__file__).resolve().parents[1] / '.github/ci/cleanup-only-recovery-custody.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class CustodyControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.lock = self.root / 'normal-cleanup.lock'
        self.ready = self.root / 'normal-cleanup-ready.json'
        self.lock.write_bytes(b'original fictional lock')
        self.ready.write_bytes(b'original fictional READY')
        self.lock.chmod(0o600)
        self.ready.chmod(0o600)
        self.row = lambda p: dict(device=p.stat().st_dev, inode=p.stat().st_ino, bytes=p.stat().st_size, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
        self.authority = dict(certificateId='a' * 64, certificateSha256='b' * 64, reconciliationSha256='c' * 64,
                              custodySha256='d' * 64, selection={'source': 'fixture'}, staleLock=dict(originalStartTicks=None, lock=self.row(self.lock), ready=self.row(self.ready)))
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    @property
    def custody(self):
        return self.root / ('cleanup-only-v1-custody-' + self.authority['certificateId'])

    def run_custody(self, preflight=None, boundary=lambda name: None):
        def checked():
            self.calls.append('checked')
            if preflight:
                preflight()
        return tool.preserve_dead_lock(self.root, self.authority, checked, boundary)

    def assert_preserved(self):
        self.assertEqual(self.ready.read_bytes(), b'original fictional READY')
        self.assertEqual(self.row(self.ready), self.authority['staleLock']['ready'])
        self.assertFalse(any((self.root / name).exists() for name in tool.ABSENT))

    def test_real_link_preserves_inode_bytes_and_ready_with_durable_receipt(self):
        result = self.run_custody()
        self.assertEqual(result['kind'], 'DEAD_LOCK_CUSTODY_COMPLETE')
        self.assertFalse(self.lock.exists())
        target = self.custody / 'original-normal-cleanup.lock'
        self.assertEqual(self.row(target), self.authority['staleLock']['lock'])
        self.assertEqual(target.stat().st_nlink, 1)
        self.assertEqual(sorted(p.name for p in self.custody.iterdir()), ['custody-intent.json', 'custody-result.json', 'original-normal-cleanup.lock'])
        self.assertIsNone(result['originalStartTicks'])
        self.assertTrue(result['historicalProcessStartUnavailable'])
        self.assertGreaterEqual(len(self.calls), 4)
        self.assert_preserved()

    def test_existing_custody_never_overwrites_or_replays(self):
        self.custody.mkdir(mode=0o700)
        marker = self.custody / 'retained'
        marker.write_text('preserve')
        with self.assertRaises(ValueError):
            self.run_custody()
        self.assertEqual(marker.read_text(), 'preserve')
        self.assertTrue(self.lock.exists())

    def test_each_partial_crash_is_retained_and_refuses_reentry(self):
        for phase in ['intent', 'linked', 'unlinked']:
            with self.subTest(phase=phase):
                self.tearDown()
                self.setUp()
                def crash(name):
                    if name == phase:
                        raise RuntimeError('simulated lost channel')
                with self.assertRaises(RuntimeError):
                    self.run_custody(boundary=crash)
                self.assertTrue((self.custody / 'custody-intent.json').is_file())
                self.assertFalse((self.custody / 'custody-result.json').exists())
                with self.assertRaises(ValueError):
                    self.run_custody()
                if phase == 'linked':
                    self.assertEqual(self.lock.stat().st_nlink, 2)
                if phase == 'unlinked':
                    self.assertEqual((self.custody / 'original-normal-cleanup.lock').stat().st_nlink, 1)
                self.assert_preserved()

    def test_changed_identity_permissions_links_or_symlink_refuse_before_custody(self):
        for fault in ['inode', 'bytes', 'mode', 'links', 'symlink', 'ready']:
            with self.subTest(fault=fault):
                self.tearDown()
                self.setUp()
                if fault == 'inode':
                    old = self.root / 'old'
                    self.lock.rename(old)
                    self.lock.write_bytes(old.read_bytes())
                    self.lock.chmod(0o600)
                elif fault == 'bytes':
                    self.lock.write_bytes(b'changed')
                elif fault == 'mode':
                    self.lock.chmod(0o644)
                elif fault == 'links':
                    os.link(self.lock, self.root / 'foreign-alias')
                elif fault == 'symlink':
                    self.lock.rename(self.root / 'actual')
                    self.lock.symlink_to('actual')
                else:
                    self.ready.write_bytes(b'changed READY')
                with self.assertRaises((ValueError, OSError)):
                    self.run_custody()
                self.assertFalse(self.custody.exists())

    def test_all_authority_consumption_result_markers_refuse_including_dangling_symlink(self):
        for name in tool.ABSENT:
            for symlink in [False, True]:
                with self.subTest(name=name, symlink=symlink):
                    target = self.root / name
                    if symlink:
                        target.symlink_to('absent-target')
                    else:
                        target.write_bytes(b'existing authority')
                    with self.assertRaises(ValueError):
                        self.run_custody()
                    self.assertFalse(self.custody.exists())
                    target.unlink()

    def test_replaced_lock_after_intent_refuses_before_link(self):
        def replace(phase):
            if phase == 'intent':
                self.lock.rename(self.root / 'old')
                self.lock.write_bytes(b'foreign')
                self.lock.chmod(0o600)
        with self.assertRaises(ValueError):
            self.run_custody(boundary=replace)
        self.assertEqual(self.lock.read_bytes(), b'foreign')
        self.assertFalse((self.custody / 'original-normal-cleanup.lock').exists())

    def test_mutation_boundary_permission_drift_refuses_and_retains_partial_state(self):
        for boundary in [1, 2, 3, 4]:
            with self.subTest(boundary=boundary):
                self.tearDown()
                self.setUp()
                count = 0
                def permission():
                    nonlocal count
                    count += 1
                    if count == boundary:
                        raise ValueError('lease/certificate/source/service changed')
                with self.assertRaises(ValueError):
                    self.run_custody(preflight=permission)
                self.assertFalse((self.custody / 'custody-result.json').exists())
                self.assert_preserved()

    def test_exclusive_nofollow_link_failure_keeps_original(self):
        with patch.object(tool.os, 'link', side_effect=OSError('exclusive link failed')):
            with self.assertRaises(OSError):
                self.run_custody()
        self.assertTrue(self.lock.exists())
        self.assertFalse((self.custody / 'custody-result.json').exists())
        self.assert_preserved()

    def test_replaced_alias_after_link_never_unlinks_original(self):
        def change(phase):
            if phase == 'linked':
                target = self.custody / 'original-normal-cleanup.lock'
                target.unlink()
                target.write_bytes(b'foreign alias')
                target.chmod(0o600)
        with self.assertRaises(ValueError):
            self.run_custody(boundary=change)
        self.assertTrue(self.lock.exists())
        self.assertFalse((self.custody / 'custody-result.json').exists())

    def test_actual_dead_pid_reused_pid_and_reboot_controls(self):
        proc = self.root / 'proc'
        (proc / 'sys/kernel/random').mkdir(parents=True)
        boot = proc / 'sys/kernel/random/boot_id'
        boot.write_bytes(b'boot A')
        binding = dict(pid=123, originalStartTicks=None, bootSha256=hashlib.sha256(boot.read_bytes()).hexdigest())
        tool.assert_dead_process(binding, proc)
        (proc / '123').mkdir()
        with self.assertRaises(ValueError):
            tool.assert_dead_process(binding, proc)
        (proc / '123').rmdir()
        boot.write_bytes(b'boot B')
        with self.assertRaises(ValueError):
            tool.assert_dead_process(binding, proc)

    def test_actual_flock_refuses_shared_or_exclusive_other_description(self):
        lock = self.root / 'operations.lock'
        lock.write_bytes(b'')
        lock.chmod(0o600)
        for held in [fcntl.LOCK_SH, fcntl.LOCK_EX]:
            first, second = os.open(lock, os.O_RDWR), os.open(lock, os.O_RDWR)
            try:
                fcntl.flock(first, held | fcntl.LOCK_NB)
                with patch.object(tool, 'OPERATIONS', lock), patch.dict(os.environ, AIHR_CLEANUP_EXCLUSIVE_FD=str(second)):
                    with self.assertRaises(BlockingIOError):
                        tool.inherited_exclusive(None)
            finally:
                os.close(second)
                os.close(first)
        fd = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(tool, 'OPERATIONS', lock), patch.dict(os.environ, AIHR_CLEANUP_EXCLUSIVE_FD=str(fd)):
                self.assertEqual(tool.inherited_exclusive(None), fd)
        finally:
            os.close(fd)

    def test_competing_selected_owner_finalizer_is_not_mistaken_for_a_dead_pid(self):
        proc = self.root / 'proc'
        process = proc / '77'
        process.mkdir(parents=True)
        executable = self.root / 'node'
        executable.write_bytes(b'fixture executable name')
        (process / 'exe').symlink_to(executable)
        (process / 'cmdline').write_bytes(b'node\0/opt/ai-hr/.github/ci/staging-build-install.mjs\0')
        with self.assertRaises(ValueError):
            tool.no_competing_finalizer(proc)
        (process / 'cmdline').write_bytes(b'node\0/opt/ai-hr/.next/standalone/server.js\0')
        tool.no_competing_finalizer(proc)


if __name__ == '__main__':
    unittest.main()
