"""Fixed layout models in disposable files, with modeled root and PID1 facts."""

import importlib.util
import os
import pathlib
import stat
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import patch


def sibling(name):
    path = pathlib.Path(__file__).with_name(name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = sibling('native-workload-browser-runtime-layout')
P = sibling('native-workload-browser-launch-plan')
RUN = '9007199254740991'
ROOT = '/run/aihr-browser-capability-' + RUN
REAL_STAT, REAL_FSTAT, REAL_OPEN, REAL_WRITE = os.stat, os.fstat, os.open, os.write


class RuntimeLayoutModel(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / 'run'
        self.root.mkdir(mode=0o711)
        self.root.chmod(0o711)
        self.stage = self.root / 'launch-source'
        self.stage.mkdir(mode=0o700)
        (self.stage / 'retained').write_bytes(b'stage owner')
        self.owners, self.admissions, self.mount_deadlines = {}, [], []
        self.foreign_mount = None
        self.fail_postcheck = False
        self.after_view = None

    def _stat_model(self, info):
        values = {name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size',
                                                       'st_mtime_ns', 'st_ctime_ns')}
        values['st_uid'], values['st_gid'] = self.owners.get((info.st_dev, info.st_ino), (0, 0))
        return SimpleNamespace(**values)

    def _named(self, path, *, dir_fd=None, follow_symlinks=True):
        return self._stat_model(REAL_STAT(self.root if path == ROOT else path, dir_fd=dir_fd,
                                          follow_symlinks=follow_symlinks))

    def _chown(self, fd, uid, gid):
        info = REAL_FSTAT(fd)
        self.owners[(info.st_dev, info.st_ino)] = (uid, gid)

    def _mount_id(self, fdinfo, fd, deadline):
        self.assertGreater(fdinfo, 2)
        self.assertLess(time.monotonic(), deadline)
        self.mount_deadlines.append(deadline)
        info = REAL_FSTAT(fd)
        return 18 if self.foreign_mount == (info.st_dev, info.st_ino) else 17

    @contextmanager
    def _own(self, fd):
        try:
            yield fd
        finally:
            os.close(fd)

    @contextmanager
    def held_launch_source(self, host, mounts, *, run_id, stage_fd, planned_bytes, planned_entries, deadline):
        self.assertEqual((host, mounts, run_id), ('held-host', 'held-mount-parser', RUN))
        remaining = deadline - time.monotonic()
        self.assertGreater(remaining, 0)
        self.assertLessEqual(remaining, 180)
        self.admissions.append((planned_bytes, planned_entries, deadline))
        info = REAL_FSTAT(stage_fd)
        yield SimpleNamespace(path=ROOT + '/launch-source', backing_birth=(info.st_dev, info.st_ino), local_mount_id=17)
        if self.after_view:
            self.after_view()
        if self.fail_postcheck:
            raise ValueError('fixture manager postcheck')

    @contextmanager
    def layout(self, *, stage=None):
        with ExitStack() as stack:
            run_fd = stack.enter_context(self._own(REAL_OPEN(self.root, L._DIRECTORY)))
            stage_fd = stack.enter_context(self._own(REAL_OPEN(stage or self.stage, L._DIRECTORY)))
            stack.enter_context(patch.object(L.os, 'getresuid', return_value=(0, 0, 0), create=True))
            stack.enter_context(patch.object(L.os, 'getresgid', return_value=(0, 0, 0), create=True))
            stack.enter_context(patch.object(L.os, 'stat', side_effect=self._named))
            stack.enter_context(patch.object(L.os, 'fstat', side_effect=lambda fd: self._stat_model(REAL_FSTAT(fd))))
            stack.enter_context(patch.object(L.os, 'fchown', side_effect=self._chown))
            self.started = time.monotonic()
            with L.held_runtime_layout(self, 'held-host', 'held-mount-parser', run_id=RUN, run_fd=run_fd,
                                       stage_fd=stage_fd, course_started=self.started) as layout:
                yield layout
            self.assertTrue(stat.S_ISDIR(REAL_FSTAT(run_fd).st_mode))
            self.assertTrue(stat.S_ISDIR(REAL_FSTAT(stage_fd).st_mode))

    def test_exact_layout_matches_existing_bind_union_and_all_fixed_metadata(self):
        with self.layout() as layout:
            result = layout.prepare()
            self.assertEqual(len(result.journal.created), 19)
            self.assertIsNone(result.journal.pending)
            self.assertTrue(result.scratch_verified_empty)
            self.assertEqual(result.driver_credential, (ROOT + '/private/observer',
                                                       ('aihr-browser-isolation-v1:' + RUN + '\n').encode()))
            role_targets = {f'runtime/{path}' for paths in P._ROLE_FILES.values() for path in paths}
            self.assertEqual(role_targets, {path for path, _, _ in result.journal.created
                                            if path.startswith('runtime/') and not stat.S_IMODE(REAL_STAT(self.root / path).st_mode)})
            self.assertEqual(set(self.root.iterdir()), {self.root / name for name in (
                'runtime', 'driver-home', 'browser-home', 'private', 'launch-source')})
            for role, uid in (('driver', 62120), ('browser', 62121)):
                with self.subTest(role=role):
                    home = self.root / (role + '-home')
                    self.assertEqual((home / 'canary').read_bytes(), (role + '-canary\n').encode())
                    for path, mode in ((home, 0o700), (home / 'scratch', 0o700), (home / 'canary', 0o400)):
                        value = self._stat_model(REAL_STAT(path))
                        self.assertEqual((value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)), (uid, uid, mode))
            private = self.root / 'private'
            self.assertEqual((private / 'observer').read_bytes(), result.driver_credential[1])
            for path, mode in ((private, 0o700), (private / 'observer', 0o400)):
                value = self._stat_model(REAL_STAT(path))
                self.assertEqual((value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)), (0, 0, mode))
            self.assertEqual((self.root / 'runtime/node').stat().st_size, 0)
            self.assertEqual(layout.inspect_empty(), result)
            self.assertEqual([row[:2] for row in self.admissions], [(72, 19), (0, 0)])
        self.assertEqual((self.stage / 'retained').read_bytes(), b'stage owner')

    def test_existing_foreign_top_symlink_refuses_before_any_layout_write(self):
        foreign = pathlib.Path(self.temp.name) / 'foreign'
        foreign.mkdir()
        (self.root / 'private').symlink_to(foreign, target_is_directory=True)
        with self.layout() as layout:
            with self.assertRaisesRegex(ValueError, 'runtime-layout-target-exists'):
                layout.prepare()
            self.assertEqual(layout.journal().created, ())
            self.assertIsNone(layout.journal().pending)
        self.assertTrue((self.root / 'private').is_symlink())
        self.assertEqual({p.name for p in self.root.iterdir()}, {'private', 'launch-source'})

    def test_lost_directory_birth_retains_pending_and_refuses_second_attempt(self):
        def interrupted(path, *args, **kwargs):
            if path == 'roles':
                raise InterruptedError('fixture lost open')
            return REAL_OPEN(path, *args, **kwargs)

        with self.layout() as layout, patch.object(L.os, 'open', side_effect=interrupted):
            with self.assertRaisesRegex(InterruptedError, 'fixture lost open'):
                layout.prepare()
            self.assertEqual(layout.journal().pending, ('runtime/roles', 'directory'))
            self.assertEqual([row[0] for row in layout.journal().created], ['runtime'])
            with self.assertRaisesRegex(ValueError, 'runtime-layout-attempted'):
                layout.prepare()
        self.assertTrue((self.root / 'runtime/roles').is_dir())

    def test_failed_final_manager_readback_cannot_publish_ready_layout(self):
        self.fail_postcheck = True
        with self.layout() as layout:
            with self.assertRaisesRegex(ValueError, 'fixture manager postcheck'):
                layout.prepare()
            self.assertEqual(len(layout.journal().created), 19)
            self.assertIsNone(layout.journal().pending)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-not-ready'):
                layout.inspect_fixed()
        self.assertTrue((self.root / 'private/observer').is_file())

    def test_short_canary_write_retains_known_file_birth_without_ready_layout(self):
        with self.layout() as layout, patch.object(L.os, 'write', side_effect=lambda fd, data: REAL_WRITE(fd, data[:-1])):
            with self.assertRaisesRegex(ValueError, 'runtime-layout-short-write'):
                layout.prepare()
            self.assertIsNone(layout.journal().pending)
            self.assertEqual(layout.journal().created[-1][:2], ('driver-home/canary', 'file'))
            with self.assertRaisesRegex(ValueError, 'runtime-layout-not-ready'):
                layout.inspect_empty()
        self.assertEqual((self.root / 'driver-home/canary').read_bytes(), b'driver-canary')

    def test_foreign_mount_or_same_content_replacement_refuses_on_held_recheck(self):
        with self.layout() as layout:
            layout.prepare()
            canary = self.root / 'driver-home/canary'
            info = REAL_STAT(canary)
            self.foreign_mount = info.st_dev, info.st_ino
            with self.assertRaisesRegex(ValueError, 'runtime-layout-mount'):
                layout.inspect_fixed()
            self.foreign_mount = None
            canary.unlink()
            canary.write_bytes(b'driver-canary\n')
            canary.chmod(0o400)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-member-birth'):
                layout.inspect_fixed()

    def test_active_fixed_recheck_leaves_scratch_unknown_and_empty_check_refuses(self):
        foreign = pathlib.Path(self.temp.name) / 'foreign'
        foreign.write_bytes(b'not owned')
        with self.layout() as layout:
            layout.prepare()
            scratch_child = self.root / 'browser-home/scratch/unknown'
            scratch_child.symlink_to(foreign)
            self.assertFalse(layout.inspect_fixed().scratch_verified_empty)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-foreign-child'):
                layout.inspect_empty()
            self.assertTrue(scratch_child.is_symlink())
            self.assertEqual(foreign.read_bytes(), b'not owned')

    def test_rejects_wrong_stage_scope_without_layout_mutation(self):
        other = self.root / 'other'
        other.mkdir(mode=0o700)
        with self.layout(stage=other) as layout:
            with self.assertRaisesRegex(ValueError, 'runtime-layout-run-scope'):
                layout.prepare()
            self.assertEqual(layout.journal().created, ())
        self.assertEqual({p.name for p in self.root.iterdir()}, {'launch-source', 'other'})

    def test_absolute_deadline_and_borrowed_fd_closure_do_not_admit_later_checks(self):
        with self.layout() as layout:
            layout.prepare()
            for elapsed, operation in ((255, layout.inspect_fixed), (285, layout.inspect_empty)):
                with self.subTest(elapsed=elapsed):
                    with patch.object(L.time, 'monotonic', return_value=self.started + elapsed):
                        with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                            operation()
            self.assertEqual(len(self.admissions), 1)
        with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
            layout.inspect_fixed()

    def test_read_only_checks_use_original_active_and_cleanup_frontiers_after_preparation(self):
        with self.layout() as layout:
            ready = layout.prepare()
            with patch.object(L.time, 'monotonic', return_value=self.started + 1):
                self.assertFalse(layout.inspect_fixed().scratch_verified_empty)
                self.assertTrue(layout.inspect_empty().scratch_verified_empty)
            with (
                patch.object(L.os, 'mkdir', side_effect=AssertionError('late mkdir')),
                patch.object(L.os, 'write', side_effect=AssertionError('late write')),
                patch.object(L.os, 'fchown', side_effect=AssertionError('late chown')),
                patch.object(L.os, 'fchmod', side_effect=AssertionError('late chmod')),
            ):
                with patch.object(L.time, 'monotonic', return_value=self.started + 180):
                    self.assertEqual(layout.inspect_fixed().journal, ready.journal)
                    with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                        layout.prepare()
                with patch.object(L.time, 'monotonic', return_value=self.started + 255):
                    self.assertEqual(layout.inspect_empty(), ready)
            self.assertEqual(self.admissions, [
                (72, 19, self.started + 180),
                (0, 0, (self.started + 1) + 180), (0, 0, (self.started + 1) + 180),
                (0, 0, self.started + 255), (0, 0, self.started + 285),
            ])

    def test_unattempted_layout_cannot_begin_at_preparation_frontier(self):
        with self.layout() as layout, patch.object(L.time, 'monotonic', return_value=self.started + 180):
            with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                layout.prepare()
            self.assertEqual(layout.journal().created, ())
            self.assertIsNone(layout.journal().pending)
            self.assertEqual(self.admissions, [])
        self.assertEqual({p.name for p in self.root.iterdir()}, {'launch-source'})

    def test_readbacks_crossing_their_own_postcheck_frontiers_cannot_return(self):
        with self.layout() as layout:
            layout.prepare()
            for elapsed, operation in ((255, layout.inspect_fixed), (285, layout.inspect_empty)):
                with self.subTest(elapsed=elapsed):
                    now = [self.started + elapsed - 1]

                    def mark_late():
                        now[0] = self.started + elapsed

                    self.after_view = mark_late
                    with patch.object(L.time, 'monotonic', side_effect=lambda: now[0]):
                        with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                            operation()
            self.assertEqual([row[2] for row in self.admissions], [self.started + n for n in (180, 255, 285)])

    def test_invalid_or_expired_role_deadline_refuses_before_native_admission(self):
        with self.layout() as layout:
            layout.prepare()
            self.mount_deadlines.clear()
            with patch.object(L.time, 'monotonic', return_value=self.started + 190):
                for value in (True, '201', float('inf'), float('-inf'), float('nan'), 0):
                    with self.subTest(value=value):
                        with self.assertRaisesRegex(ValueError, 'runtime-layout-role-deadline'):
                            layout.inspect_fixed(role_deadline=value)
                for expired in (self.started + 189, self.started + 190):
                    with self.subTest(expired=expired):
                        with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                            layout.inspect_fixed(role_deadline=expired)
            self.assertEqual(len(self.admissions), 1)
            self.assertEqual(self.mount_deadlines, [])

    def test_role_deadline_is_the_narrower_native_read_bound_and_never_extends_course_or_view(self):
        with self.layout() as layout:
            ready = layout.prepare()
            for elapsed, supplied, expected in ((190, 201, self.started + 201), (190, 900, self.started + 255),
                                                 (1, 900, (self.started + 1) + 180)):
                with self.subTest(elapsed=elapsed, supplied=supplied):
                    self.mount_deadlines.clear()
                    with patch.object(L.time, 'monotonic', return_value=self.started + elapsed):
                        result = layout.inspect_fixed(role_deadline=self.started + supplied)
                    self.assertEqual(result.journal, ready.journal)
                    self.assertEqual(self.admissions[-1], (0, 0, expected))
                    self.assertEqual(set(self.mount_deadlines), {expected})

    def test_role_deadline_crossed_during_target_read_stops_before_next_native_scan(self):
        with self.layout() as layout:
            layout.prepare()
            now = [self.started + 190]
            deadline = self.started + 191
            check = layout._check

            def cross(target, observation):
                result = check(target, observation)
                now[0] = deadline
                return result

            with (
                patch.object(L.time, 'monotonic', side_effect=lambda: now[0]),
                patch.object(layout, '_check', side_effect=cross) as checked,
                patch.object(L.os, 'scandir', side_effect=AssertionError('late directory scan')) as scanned,
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                    layout.inspect_fixed(role_deadline=deadline)
                self.assertEqual(checked.call_count, 1)
                scanned.assert_not_called()

    def test_role_view_completion_at_earlier_deadline_cannot_return_snapshot(self):
        with self.layout() as layout:
            layout.prepare()
            now = [self.started + 190]
            deadline = self.started + 191

            def mark_late():
                now[0] = deadline

            self.after_view = mark_late
            with patch.object(L.time, 'monotonic', side_effect=lambda: now[0]):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                    layout.inspect_fixed(role_deadline=deadline)
            self.assertEqual(self.admissions[-1], (0, 0, deadline))

    def test_disposal_removes_only_the_sealed_layout_in_reverse_birth_order(self):
        with self.layout() as layout:
            ready = layout.prepare()
            calls = []
            unlink, rmdir = os.unlink, os.rmdir

            def remove(operation, name, *, dir_fd):
                calls.append((name, dir_fd))
                operation(name, dir_fd=dir_fd)

            with (
                patch.object(L.os, 'unlink', side_effect=lambda *a, **kw: remove(unlink, *a, **kw)),
                patch.object(L.os, 'rmdir', side_effect=lambda *a, **kw: remove(rmdir, *a, **kw)),
                patch.object(L.time, 'monotonic', return_value=self.started + 260),
            ):
                self.assertEqual(layout.dispose(cleanup_deadline=self.started + 900), 19)
            expected = []
            for path, _, _ in reversed(ready.journal.created):
                parent, _, name = path.rpartition('/')
                expected.append((name, layout.opened[parent] if parent else layout.run))
            self.assertEqual(calls, expected)
            self.assertEqual(self.admissions[-1], (0, 0, self.started + 285))
            self.assertEqual(layout.journal(), ready.journal)
            self.assertTrue(all(REAL_FSTAT(fd).st_nlink == 0 for fd in layout.opened.values()))
            with self.assertRaisesRegex(ValueError, 'runtime-layout-disposal-attempted'):
                layout.dispose(cleanup_deadline=self.started + 280)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-not-ready'):
                layout.inspect_fixed()
        self.assertEqual({p.name for p in self.root.iterdir()}, {'launch-source'})
        self.assertEqual((self.stage / 'retained').read_bytes(), b'stage owner')

    def test_disposal_refuses_nonempty_scratch_before_any_removal(self):
        with self.layout() as layout:
            ready = layout.prepare()
            scratch = self.root / 'browser-home/scratch/foreign'
            scratch.symlink_to(self.stage / 'retained')
            with (
                patch.object(L.os, 'unlink', side_effect=AssertionError('unlink with nonempty scratch')),
                patch.object(L.os, 'rmdir', side_effect=AssertionError('rmdir with nonempty scratch')),
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-foreign-child'):
                    layout.dispose(cleanup_deadline=self.started + 280)
            self.assertEqual(layout.journal(), ready.journal)
            self.assertTrue(scratch.is_symlink())
            self.assertEqual((self.stage / 'retained').read_bytes(), b'stage owner')

    def test_disposal_refuses_a_foreign_run_child_before_any_removal(self):
        with self.layout() as layout:
            ready = layout.prepare()
            foreign = self.root / 'foreign'
            foreign.write_bytes(b'foreign')
            with (
                patch.object(L.os, 'unlink', side_effect=AssertionError('unlink with foreign run child')),
                patch.object(L.os, 'rmdir', side_effect=AssertionError('rmdir with foreign run child')),
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-foreign-run-child'):
                    layout.dispose(cleanup_deadline=self.started + 280)
            self.assertEqual(layout.journal(), ready.journal)
            self.assertEqual(foreign.read_bytes(), b'foreign')

    def test_disposal_refuses_same_content_replacement_before_any_removal(self):
        with self.layout() as layout:
            ready = layout.prepare()
            canary = self.root / 'driver-home/canary'
            canary.unlink()
            canary.write_bytes(b'driver-canary\n')
            canary.chmod(0o400)
            with (
                patch.object(L.os, 'unlink', side_effect=AssertionError('unlink with replaced birth')),
                patch.object(L.os, 'rmdir', side_effect=AssertionError('rmdir with replaced birth')),
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-member-birth'):
                    layout.dispose(cleanup_deadline=self.started + 280)
            self.assertEqual(layout.journal(), ready.journal)
            self.assertEqual(canary.read_bytes(), b'driver-canary\n')
            self.assertEqual((self.root / 'private/observer').read_bytes(), ready.driver_credential[1])

    def test_disposal_preserves_the_pending_and_known_births_of_incomplete_preparation(self):
        def interrupted(path, *args, **kwargs):
            if path == 'roles':
                raise InterruptedError('fixture lost open')
            return REAL_OPEN(path, *args, **kwargs)

        with self.layout() as layout:
            with patch.object(L.os, 'open', side_effect=interrupted):
                with self.assertRaisesRegex(InterruptedError, 'fixture lost open'):
                    layout.prepare()
            partial = layout.journal()
            with (
                patch.object(L.os, 'unlink', side_effect=AssertionError('unlink with partial journal')),
                patch.object(L.os, 'rmdir', side_effect=AssertionError('rmdir with partial journal')),
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-disposal-journal'):
                    layout.dispose(cleanup_deadline=self.started + 280)
            self.assertEqual(layout.journal(), partial)
            self.assertEqual(partial.pending, ('runtime/roles', 'directory'))
            self.assertEqual([row[0] for row in partial.created], ['runtime'])
            self.assertEqual(len(self.admissions), 1)
        self.assertTrue((self.root / 'runtime/roles').is_dir())

    def test_disposal_preserves_first_removal_failure_and_never_retries(self):
        with self.layout() as layout:
            ready = layout.prepare()
            with patch.object(L.os, 'rmdir', side_effect=InterruptedError('fixture uncertain removal')) as removed:
                with self.assertRaisesRegex(InterruptedError, 'fixture uncertain removal'):
                    layout.dispose(cleanup_deadline=self.started + 280)
                removed.assert_called_once_with('private', dir_fd=layout.run)
            self.assertFalse((self.root / 'private/observer').exists())
            self.assertTrue((self.root / 'private').is_dir())
            self.assertTrue((self.root / 'browser-home').is_dir())
            self.assertEqual(layout.journal(), ready.journal)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-disposal-attempted'):
                layout.dispose(cleanup_deadline=self.started + 280)

    def test_disposal_rechecks_the_earlier_deadline_after_the_last_entry_guard(self):
        with self.layout() as layout:
            ready = layout.prepare()
            now = [self.started + 260]
            deadline = self.started + 261
            check = layout._check
            observer_checks = []

            def cross(target, observation):
                result = check(target, observation)
                if target.path == 'private/observer':
                    observer_checks.append(target.path)
                    if len(observer_checks) == 2:
                        now[0] = deadline
                return result

            with (
                patch.object(L.time, 'monotonic', side_effect=lambda: now[0]),
                patch.object(layout, '_check', side_effect=cross),
                patch.object(L.os, 'unlink', side_effect=AssertionError('late unlink')),
                patch.object(L.os, 'rmdir', side_effect=AssertionError('late rmdir')),
            ):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                    layout.dispose(cleanup_deadline=deadline)
            self.assertEqual(len(observer_checks), 2)
            self.assertEqual(self.admissions[-1], (0, 0, deadline))
            self.assertEqual(layout.journal(), ready.journal)
            self.assertEqual((self.root / 'private/observer').read_bytes(), ready.driver_credential[1])

    def test_disposal_cannot_return_positive_after_the_final_manager_view_deadline(self):
        with self.layout() as layout:
            ready = layout.prepare()
            deadline = self.started + 261
            now = [deadline - 1]

            def mark_late():
                now[0] = deadline

            self.after_view = mark_late
            with patch.object(L.time, 'monotonic', side_effect=lambda: now[0]):
                with self.assertRaisesRegex(ValueError, 'runtime-layout-deadline-or-closed'):
                    layout.dispose(cleanup_deadline=deadline)
            self.assertEqual(self.admissions[-1], (0, 0, deadline))
            self.assertEqual(layout.journal(), ready.journal)
            with self.assertRaisesRegex(ValueError, 'runtime-layout-disposal-attempted'):
                layout.dispose(cleanup_deadline=self.started + 280)
        self.assertEqual({p.name for p in self.root.iterdir()}, {'launch-source'})


if __name__ == '__main__':
    unittest.main()
