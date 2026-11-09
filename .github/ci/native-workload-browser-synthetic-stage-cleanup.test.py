"""Disposable inode models for the dormant launch-source cleanup leaf."""

import os
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


def load(name, sibling):
    path = Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


C = load('synthetic_stage_cleanup_model', 'native-workload-browser-synthetic-stage-cleanup.py')
F = load('synthetic_stage_cleanup_fixtures', 'native-workload-browser-synthetic-stage.test.py')
I = F.I


class SyntheticStageCleanupModels(unittest.TestCase):
    def setUp(self):
        self.finalized = F.SyntheticStageModels()
        self.finalized.setUp()
        self.addCleanup(self.finalized.doCleanups)
        self.fixture = self.finalized.fixture
        self.run = self.fixture.base / 'run'
        self.run.mkdir(mode=0o711)
        self.run.chmod(0o711)
        self.stage = self.run / 'launch-source'
        self.fixture.root.rename(self.stage)
        self.finalized.root = self.fixture.root = self.stage
        self.markers = []
        self.clock = time.monotonic() + 8
        self.host, self.mounts = object(), object()
        self.view = ModuleType('synthetic_cleanup_view_model')
        self.view._mount_id = lambda _fdinfo, _fd, _deadline: 27
        self.view.held_launch_source = self.view_context
        self.fail_view_close = False

    @contextmanager
    def view_context(self, host, mounts, **kwargs):
        self.assertIs(host, self.host)
        self.assertIs(mounts, self.mounts)
        fd = kwargs['stage_fd']
        self.assertEqual(kwargs, dict(run_id='427', stage_fd=fd, planned_bytes=0, planned_entries=0,
                                      deadline=self.clock))
        birth = I._birth(os.fstat(fd))[:2]
        self.assertEqual(birth, I._birth(self.stage.lstat())[:2])
        self.markers.append('view-entered')
        yield SimpleNamespace(backing_birth=birth, local_mount_id=27)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(list(self.stage.iterdir()), [])
        self.markers.append('view-rechecked')
        if self.fail_view_close:
            raise ValueError('fixture manager view changed')

    @contextmanager
    def complete(self):
        with self.finalized.stage() as (fd, finalizer, tools, archives), self.fixture.held(self.run) as run_fd:
            finalizer.finalize(tools, archives, **self.finalized.files)
            # Model the admitted private directory modes before sealing. A
            # nonroot test process cannot unlink children from sealed 0555 dirs.
            for path in self.stage.rglob('*'):
                if path.is_dir():
                    path.chmod(0o700)
            yield run_fd, fd, archives, finalizer.journal()

    def dispose(self, run_fd, stage_fd, archives, additions):
        # Actual filesystem checks run on a private nonroot fixture. Only the
        # hosted root predicate and native manager proof are modeled.
        def model_owner(info):
            return (info.st_uid, info.st_gid) == (os.geteuid(), os.getegid())

        with patch.object(C, '_root_owned', side_effect=model_owner):
            return C.dispose_synthetic_stage(I, self.view, self.host, self.mounts, run_id='427',
                run_fd=run_fd, stage_fd=stage_fd, initial_birth=archives.root_birth,
                archives=archives, additions=additions, deadline=self.clock)

    def test_removes_only_exact_stage_after_positive_fresh_view_recheck(self):
        foreign = self.run / 'unrelated'
        foreign.write_bytes(b'keep')
        with self.complete() as (run, stage, archives, additions):
            self.assertEqual(self.dispose(run, stage, archives, additions), len(archives.created) + len(additions.created))
            self.assertEqual(os.fstat(stage).st_nlink, 0)
        self.assertEqual(self.markers, ['view-entered', 'view-rechecked'])
        self.assertFalse(self.stage.exists())
        self.assertTrue(self.run.is_dir())
        self.assertEqual(foreign.read_bytes(), b'keep')

    def test_pending_creation_or_unknown_entry_preserves_the_whole_stage(self):
        with self.complete() as (run, stage, archives, additions):
            original = {path.relative_to(self.stage) for path in self.stage.rglob('*')}
            with self.assertRaisesRegex(ValueError, 'journal is incomplete'):
                self.dispose(run, stage, archives, additions._replace(pending=('roles', 'directory')))
            self.assertEqual(self.markers, [])
            extra = self.stage / 'node_modules' / 'untracked'
            extra.write_bytes(b'foreign')
            with self.assertRaisesRegex(ValueError, 'foreign entry'):
                self.dispose(run, stage, archives, additions)
            self.assertEqual({path.relative_to(self.stage) for path in self.stage.rglob('*')},
                             original | {extra.relative_to(self.stage)})
            self.assertEqual(extra.read_bytes(), b'foreign')

    def test_member_on_another_mount_refuses_before_any_removal(self):
        with self.complete() as (run, stage, archives, additions):
            target = self.stage / 'node'
            target_birth = I._birth(target.lstat())[:2]
            self.view._mount_id = lambda _proc, fd, _deadline: 28 if I._birth(os.fstat(fd))[:2] == target_birth else 27
            original = {path.relative_to(self.stage) for path in self.stage.rglob('*')}
            with self.assertRaisesRegex(ValueError, 'member mount differs'):
                self.dispose(run, stage, archives, additions)
            self.assertEqual({path.relative_to(self.stage) for path in self.stage.rglob('*')}, original)

    def test_replaced_inode_refuses_even_if_bytes_and_mode_match(self):
        with self.complete() as (run, stage, archives, additions):
            target = self.stage / 'node'
            replacement = self.run / 'replacement'
            replacement.write_bytes(target.read_bytes())
            replacement.chmod(0o555)
            os.replace(replacement, target)
            original = {path.relative_to(self.stage) for path in self.stage.rglob('*')}
            with self.assertRaisesRegex(ValueError, 'member identity differs'):
                self.dispose(run, stage, archives, additions)
            self.assertEqual({path.relative_to(self.stage) for path in self.stage.rglob('*')}, original)
            self.assertEqual(target.read_bytes(), self.finalized.files['node'].data)

    def test_root_name_survives_failed_manager_view_recheck(self):
        self.fail_view_close = True
        with self.complete() as (run, stage, archives, additions):
            with self.assertRaisesRegex(ValueError, 'fixture manager view changed'):
                self.dispose(run, stage, archives, additions)
            self.assertGreater(os.fstat(stage).st_nlink, 0)
        self.assertEqual(self.markers, ['view-entered', 'view-rechecked'])
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_known_partial_installer_output_can_be_removed_without_finalizer(self):
        write = os.write

        def interrupted(fd, block):
            write(fd, block[:1])
            raise InterruptedError('fixture partial write')

        with self.fixture.held() as stage, self.fixture.held(self.run) as run:
            with self.fixture.synthetic(stage) as (installer, sources):
                with patch.object(I.os, 'write', side_effect=interrupted), self.assertRaises(InterruptedError):
                    installer.materialize(*sources)
            archives = installer.journal()
            self.assertTrue(archives.created)
            self.assertIsNone(archives.pending)
            never_started = I.SyntheticToolJournal(archives.root_birth, (), None)
            self.assertEqual(self.dispose(run, stage, archives, never_started), len(archives.created))
        self.assertFalse(self.stage.exists())


if __name__ == '__main__':
    unittest.main()
