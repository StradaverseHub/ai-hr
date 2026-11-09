"""Models of the fixed stage owner with private fixture paths and mount facts."""

import os
import stat
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


def load(name, sibling):
    path = Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


O = load('synthetic_stage_owner_model', 'native-workload-browser-synthetic-stage-owner.py')
T = load('synthetic_stage_owner_tool_model', 'native-workload-browser-tool-course.py')
C = load('synthetic_stage_owner_cleanup_model', 'native-workload-browser-synthetic-stage-cleanup.py')
F = load('synthetic_stage_owner_fixtures', 'native-workload-browser-synthetic-stage.test.py')
I, S = F.I, F.S


class RootInfo:
    st_uid = st_gid = 0

    def __init__(self, raw):
        self.raw = raw

    def __getattr__(self, name):
        return getattr(self.raw, name)


class SyntheticStageOwnerModels(unittest.TestCase):
    def setUp(self):
        fixture = F.SyntheticStageModels()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.fixture, self.bound = fixture.fixture, fixture.files
        self.system = self.fixture.base / 'system'
        self.system.mkdir(mode=0o700)
        self.base = self.system / 'run'
        self.base.mkdir(mode=0o755)
        self.run = self.base / 'aihr-browser-capability-427'
        self.stage = self.run / 'launch-source'
        self.inputs = self.fixture.root / 'inputs'
        self.inputs.mkdir(mode=0o700)
        files = {'chromium.zip': self.fixture.browser, **{name + '.tgz': data for name, data in self.fixture.packages.items()}}
        for name, data in files.items():
            target = self.inputs / name
            target.write_bytes(data)
            target.chmod(0o400)
        self.course = T.Course('427', 1001, 1001, time.monotonic())
        self.course.created = True
        self.course.installer = I
        self.course.mounts = ModuleType('fixture_mount_contract')
        complete = {'reason': 'complete', 'exit': 0, 'admitted': True, 'reaped': True,
                    'quiescent': True, 'escapedSession': False}
        self.course.state = {'processOutcomes': {'namespace-private': complete, 'archive-downloader': complete},
                             'transfer': {'generation': T.GENERATION, 'privateWriters': True,
                                          'writerHandoff': next(iter(T.DUMP_POLICIES.values())),
                                          'lengths': {name: len(data) for name, data in files.items()}}}
        self.host = ModuleType('fixture_host_contract')
        self.view = ModuleType('fixture_view_contract')
        self.view.held_launch_source = self.view_context
        self.view._mount_id = lambda _fdinfo, _fd, _deadline: 17
        self.view_facts = []
        self.refuse_capacity = self.refuse_stage_open = False
        self.planned = None

    @contextmanager
    def view_context(self, host, mounts, *, run_id, stage_fd, planned_bytes, planned_entries, deadline):
        self.assertIs(host, self.host)
        self.assertIs(mounts, self.course.mounts)
        self.assertEqual(run_id, '427')
        before = os.fstat(stage_fd)
        self.assertEqual(I._birth(before), I._birth(self.stage.stat()))
        self.assertEqual(stat.S_IMODE(self.run.stat().st_mode), 0o711)
        self.assertEqual(stat.S_IMODE(before.st_mode), 0o700)
        self.view_facts.append((stage_fd, planned_bytes, planned_entries, deadline))
        if planned_entries:
            self.assertEqual((planned_bytes, planned_entries, deadline), (*self.planned, self.course.active))
            self.assertEqual(list(self.stage.iterdir()), [])
            if self.refuse_capacity:
                raise ValueError('fixture insufficient view capacity')
        else:
            self.assertEqual((planned_bytes, deadline), (0, self.course.deadline))
        yield SimpleNamespace(backing_birth=I._birth(before)[:2], local_mount_id=17)
        self.assertEqual(I._birth(os.fstat(stage_fd)), I._birth(self.stage.stat()))

    @contextmanager
    def owner(self):
        native_open, native_fstat, native_stat = os.open, os.fstat, os.stat

        def open_path(path, flags, mode=0o777, *, dir_fd=None):
            if self.refuse_stage_open and path == 'launch-source' and dir_fd is not None:
                raise InterruptedError('fixture stage open interrupted')
            return native_open(self.system if path == '/' else path, flags, mode, dir_fd=dir_fd)

        def stat_path(path, **kwargs):
            return RootInfo(native_stat(path, **kwargs))

        with ExitStack() as held:
            # Keep actual inode and file operations. Only ownership, the
            # fixed parent, acquisition's prior native checks and view are modeled.
            held.callback(os.umask, os.umask(0o077))
            held.enter_context(patch.object(O.os, 'open', side_effect=open_path))
            held.enter_context(patch.object(O.os, 'fstat', side_effect=lambda fd: RootInfo(native_fstat(fd))))
            held.enter_context(patch.object(O.os, 'stat', side_effect=stat_path))
            for name in ('getresuid', 'getresgid'):
                held.enter_context(patch.object(O.os, name, return_value=(0, 0, 0)))
            for name in ('geteuid', 'getegid'):
                held.enter_context(patch.object(O.os, name, return_value=0))
            held.enter_context(patch.object(self.course, 'check_root'))
            held.enter_context(patch.object(self.course, 'check_private_mount_namespace'))
            held.enter_context(patch.object(T, 'BROWSER_BYTES', len(self.fixture.browser)))
            _, projection = self.fixture.synthetic_projection()
            self.planned = (projection['_SYNTHETIC_BYTES'] + sum(len(item.data) for item in self.bound.values()),
                            projection['_SYNTHETIC_ENTRIES'] + 5)
            held.enter_context(patch.multiple(I, **projection))
            held.enter_context(patch.multiple(I._PARSER, **self.fixture.browser_pins))
            held.enter_context(patch.dict(I._PARSER.PACKAGES, self.fixture.package_pins))
            self.course.root = held.enter_context(self.fixture.held())
            info = self.inputs.stat()
            self.course.device = info.st_dev
            self.course.births['inputs'] = T.birth(info)
            with O.owned_synthetic_stage(T, self.course, self.view, S, C, self.host) as owner:
                yield owner

    def test_same_held_fd_and_absolute_course_frontiers_join_prepare_and_dispose(self):
        with self.owner() as owner:
            prepared = owner.prepare(**self.bound)
            self.assertEqual(prepared.view.backing_birth, I._birth(os.fstat(owner.stage_fd))[:2])
            self.assertEqual(len(prepared.snapshot.members), self.planned[1])
            self.assertFalse((self.stage / 'node_modules/postgres').exists())
            self.assertEqual((self.stage / 'node').read_bytes(), self.bound['node'].data)
            with self.assertRaisesRegex(ValueError, 'preparation is not fresh'):
                owner.prepare(**self.bound)
            # The test process is nonroot. Preserve all inode births while
            # enabling removal from the private fixture's sealed directories.
            for path in self.stage.rglob('*'):
                if path.is_dir():
                    path.chmod(0o700)
            self.assertEqual(owner.dispose(), self.planned[1])
            with self.assertRaisesRegex(ValueError, 'disposal is not admitted'):
                owner.dispose()
        fd = self.view_facts[0][0]
        self.assertEqual(self.view_facts, [(fd, *self.planned, self.course.active), (fd, 0, 0, self.course.deadline)])
        self.assertFalse(self.run.exists())
        self.assertTrue((self.inputs / 'chromium.zip').is_file())

    def test_view_capacity_failure_precedes_archive_open_and_can_settle_empty_stage(self):
        self.refuse_capacity = True
        with self.owner() as owner, patch.object(self.course, 'protected_archive_inputs', wraps=self.course.protected_archive_inputs) as inputs:
            with self.assertRaisesRegex(ValueError, 'insufficient view capacity'):
                owner.prepare(**self.bound)
            inputs.assert_not_called()
            self.assertEqual(owner.dispose(), 0)
        self.assertFalse(self.run.exists())

    def test_late_archive_refusal_preserves_known_journal_for_explicit_cleanup(self):
        original = I._PARSER._inspect_package

        def inspect(name, *args):
            if name == 'postgres':
                raise I._PARSER.ArchiveRefused('fixture later strict refusal')
            return original(name, *args)

        with self.owner() as owner, patch.object(I._PARSER, '_inspect_package', side_effect=inspect):
            with self.assertRaises(T.ToolRefusal) as failed:
                owner.prepare(**self.bound)
            self.assertEqual(failed.exception.reason, 'strict-archive-or-tree')
            known = owner.archive_stage.journal()
            self.assertIsNone(known.pending)
            self.assertTrue(known.created)
            self.assertIsNone(owner.final_stage)
            self.assertEqual(owner.dispose(), len(known.created))
        self.assertFalse(self.run.exists())

    def test_unknown_stage_creation_is_never_automatically_or_explicitly_removed(self):
        self.refuse_stage_open = True
        with self.owner() as owner:
            with self.assertRaisesRegex(InterruptedError, 'stage open interrupted'):
                owner.prepare(**self.bound)
            self.assertEqual(owner.pending, 'launch-source')
            with self.assertRaisesRegex(ValueError, 'disposal is not admitted'):
                owner.dispose()
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.view_facts, [])

    def test_unsettled_archive_course_refuses_without_creating_the_fixed_run(self):
        self.course.processes_settled = False
        with self.owner() as owner, self.assertRaisesRegex(ValueError, 'archive course differs'):
            owner.prepare(**self.bound)
        self.assertFalse(self.run.exists())
        self.assertEqual(self.view_facts, [])

    def test_known_run_only_is_removed_after_fresh_view_or_preserved_on_refusal(self):
        original_mkdir, original_chmod = os.mkdir, os.fchmod
        for before_chmod, refuse_view, foreign in ((True, False, False), (False, False, False),
                                                   (True, True, False), (False, False, True)):
            with self.subTest(before_chmod=before_chmod, refuse_view=refuse_view, foreign=foreign):
                calls = []
                mode = 0o700 if before_chmod else 0o711

                @contextmanager
                def empty_view(host, mounts, *, run_id, run_fd, deadline):
                    self.assertEqual((host, mounts, run_id, deadline),
                                     (self.host, self.course.mounts, '427', self.course.deadline))
                    self.assertEqual(stat.S_IMODE(os.fstat(run_fd).st_mode), mode)
                    self.assertFalse(self.stage.exists())
                    self.assertEqual(list(self.run.iterdir()), [])
                    calls.append(run_fd)
                    if refuse_view:
                        raise ValueError('fixture manager mount differs')
                    yield SimpleNamespace(backing_birth=T.birth(os.fstat(run_fd)), local_mount_id=17)
                    if foreign:
                        (self.run / 'foreign').touch()

                def interrupt_chmod(fd, requested):
                    if requested == 0o711 and before_chmod:
                        raise InterruptedError('fixture run chmod interrupted')
                    return original_chmod(fd, requested)

                with self.owner() as owner:
                    if not before_chmod:
                        def interrupted_readback(deadline, actual_mode=0o711):
                            if deadline == self.course.active:
                                raise InterruptedError('fixture run readback interrupted')
                            return check_run(deadline, actual_mode)
                        check_run = owner._check_run
                    else:
                        interrupted_readback = owner._check_run
                    with patch.object(owner, '_check_run', side_effect=interrupted_readback), \
                         patch.object(O.os, 'fchmod', side_effect=interrupt_chmod), \
                         patch.object(O.os, 'mkdir', wraps=original_mkdir) as mkdir, \
                         patch.object(self.view, 'held_empty_launch_parent', empty_view, create=True):
                        with self.assertRaisesRegex(InterruptedError, 'fixture run (chmod|readback) interrupted'):
                            owner.prepare(**self.bound)
                        self.assertFalse(owner.stage_creation_attempted)
                        self.assertIsNone(owner.pending)
                        self.assertEqual([call.args[0] for call in mkdir.call_args_list], [self.run.name])
                        if refuse_view or foreign:
                            with self.assertRaisesRegex(ValueError, 'fixture manager mount differs|empty run view changed|run is not empty'):
                                owner.dispose()
                            self.assertTrue(self.run.is_dir())
                        else:
                            self.assertEqual(owner.dispose(), 0)
                            self.assertFalse(self.run.exists())
                        self.assertEqual(calls, [owner.run_fd])
                if foreign:
                    self.assertTrue((self.run / 'foreign').is_file())
                    (self.run / 'foreign').unlink()
                if self.run.exists():
                    self.run.rmdir()


if __name__ == '__main__':
    unittest.main()
