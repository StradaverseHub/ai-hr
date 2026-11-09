"""Disposable filesystem models for the dormant synthetic stage finalizer."""

import hashlib
import os
import stat
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


def load(name, sibling):
    path = Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


S = load('synthetic_stage_model', 'native-workload-browser-synthetic-stage.py')
F = load('synthetic_stage_installer_fixtures', 'native-workload-browser-tool-installation.test.py')
I = F.I
ROLE_PATHS = ('roles/native-workload-browser-driver.mjs', 'roles/native-workload-browser-server.mjs',
              'roles/native-workload-browser-host.py')


def bound(data):
    return S.BoundStageFile(data, hashlib.sha256(data).hexdigest())


class SyntheticStageModels(unittest.TestCase):
    def setUp(self):
        self.fixture = F.PrivateToolInstallationModels()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.files = dict(node=bound(b'\x7fELFfictional node'), driver=bound(b'driver fixture'),
                          browser=bound(b'browser fixture'), probe=bound(b'probe fixture'))

    @contextmanager
    def stage(self):
        with self.fixture.held() as fd:
            with self.fixture.synthetic(fd) as (installer, archives):
                tools = installer.materialize(*archives)
                journal = installer.journal()
            _, projection = self.fixture.synthetic_projection()
            # The models retain actual nonroot filesystem identities. Only the
            # real hosted root admission predicate is replaced here.
            def model_owner(info):
                return (info.st_uid, info.st_gid) == (os.geteuid(), os.getegid())

            with patch.multiple(I, **projection), patch.object(S, '_root_owned', side_effect=model_owner), \
                 S.synthetic_stage(I, fd, time.monotonic() + 5) as finalizer:
                yield fd, finalizer, tools, journal

    def test_actual_inode_and_mode_readback_with_only_new_content_reads(self):
        read = os.read
        with self.stage() as (fd, finalizer, tools, journal):
            tool_births = {state[0][:2] for _, state in tools.member_states}

            def read_new(current, maximum):
                self.assertNotIn(I._birth(os.fstat(current))[:2], tool_births)
                return read(current, maximum)

            with patch.object(S.os, 'read', side_effect=read_new):
                snapshot = finalizer.finalize(tools, journal, **self.files)
            self.assertEqual(snapshot.root_state, I._state(os.fstat(fd)))
            self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o700)
            rows = {row.path: row for row in snapshot.members}
            self.assertEqual(set(rows), {row.path for row in tools.members} | {'node', 'roles', *ROLE_PATHS})
            for row in snapshot.members:
                info = (self.root / row.path).lstat()
                self.assertEqual(row.state, I._state(info))
                self.assertEqual(row.mode, stat.S_IMODE(info.st_mode))
            for original in tools.members:
                self.assertEqual(rows[original.path].sha256, original.sha256)
                self.assertEqual(rows[original.path].state[0][:2], dict(tools.member_states)[original.path][0][:2])
            for name, role in zip(('node', *ROLE_PATHS), ('node', 'driver', 'browser', 'probe'), strict=True):
                self.assertEqual(rows[name].sha256, self.files[role].sha256)
                self.assertEqual((self.root / name).read_bytes(), self.files[role].data)
                self.assertEqual(rows[name].mode, 0o555 if role == 'node' else 0o444)
            self.assertEqual(rows['roles'].mode, 0o555)
            with self.assertRaisesRegex(ValueError, 'not fresh'):
                finalizer.finalize(tools, journal, **self.files)
        recorded = finalizer.journal()
        self.assertIsNone(recorded.pending)
        self.assertEqual({name for name, *_ in recorded.created}, {'node', 'roles', *ROLE_PATHS})
        with self.assertRaises(AttributeError):
            snapshot.root_state = None

    def test_bad_archive_binding_refuses_before_any_mutation(self):
        with self.stage() as (_, finalizer, tools, journal):
            target = self.root / F.EXECUTABLE
            changed = tuple(row._replace(sha256='0' * 64) if row.path == F.EXECUTABLE else row for row in tools.members)
            with self.assertRaisesRegex(ValueError, 'archive census differs'):
                finalizer.finalize(tools._replace(members=changed), journal, **self.files)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(finalizer.journal().created, ())
            self.assertFalse((self.root / 'node').exists())

    def test_wrong_new_content_preserves_known_nonexecutable_inode(self):
        with self.stage() as (_, finalizer, tools, journal):
            node = self.files['node']._replace(sha256='0' * 64)
            with self.assertRaisesRegex(ValueError, 'content differs'):
                finalizer.finalize(tools, journal, **(self.files | {'node': node}))
        observed = (self.root / 'node').stat()
        self.assertEqual(stat.S_IMODE(observed.st_mode), 0o600)
        self.assertEqual(finalizer.journal().created, (('node', 'file', (observed.st_dev, observed.st_ino)),))
        self.assertFalse((self.root / 'roles').exists())

    def test_role_directory_attempt_without_held_birth_is_retained_unknown(self):
        open_file = os.open

        def interrupted(name, flags, mode=0o777, *, dir_fd=None):
            if name == 'roles' and dir_fd is not None:
                raise InterruptedError('fixture role directory open interruption')
            return open_file(name, flags, mode, dir_fd=dir_fd)

        with self.stage() as (_, finalizer, tools, journal):
            with patch.object(S.os, 'open', side_effect=interrupted), self.assertRaises(InterruptedError):
                finalizer.finalize(tools, journal, **self.files)
        self.assertTrue((self.root / 'roles').is_dir())
        self.assertEqual(finalizer.journal().pending, ('roles', 'directory'))
        self.assertEqual([name for name, *_ in finalizer.journal().created], ['node'])
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)

    def test_inheritable_or_unowned_stage_never_opens_a_finalizer(self):
        with self.fixture.held() as fd:
            os.set_inheritable(fd, True)
            with self.assertRaisesRegex(ValueError, 'held synthetic stage input'):
                with S.synthetic_stage(I, fd, time.monotonic() + 5):
                    self.fail('inheritable stage accepted')
            os.set_inheritable(fd, False)
            with patch.object(S.os, 'getresuid', return_value=(1, 1, 1)), \
                 self.assertRaisesRegex(ValueError, 'stage root differs'):
                with S.synthetic_stage(I, fd, time.monotonic() + 5):
                    self.fail('nonroot stage accepted')
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
