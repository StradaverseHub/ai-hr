"""Modeled proc, mount and file observations. No real DSO load, socket or bus."""

import hashlib
import pathlib
import stat
import struct
import unittest
from contextlib import ExitStack
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


def load(name, source):
    module = ModuleType(name)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


CI = pathlib.Path(__file__).resolve().parent
A = load('manager_admission_model', CI / 'native-workload-browser-manager-admission.py')
V = load('manager_admission_view_model', CI / 'native-workload-browser-launch-view.py')
H = load('manager_admission_host_model', CI / 'native-workload-browser-host.py')
M = load('manager_admission_mount_model', CI.parents[1] / 'deploy/admission/next_profile.py')
STARTED = 100 * 1_000_000_000
READY = STARTED + 16 * 1_000_000_000


def info(inode, mode, *, device=1, uid=0, gid=0, size=0):
    return SimpleNamespace(st_dev=device, st_ino=inode, st_mode=mode, st_uid=uid, st_gid=gid,
                           st_size=size, st_mtime_ns=11, st_ctime_ns=12, st_nlink=1)


def directory(inode, *, device=1, mode=0o755):
    return info(inode, stat.S_IFDIR | mode, device=device)


def elf():
    header = bytearray(64)
    header[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHI', header, 16, 3, 62, 1)
    struct.pack_into('<Q', header, 32, 64)
    struct.pack_into('<HHH', header, 52, 64, 56, 1)
    return bytes(header) + bytes(56)


class NativeModel:
    def __init__(self):
        self.now = STARTED
        self.start = 314
        self.dead = False
        self.manager_gid = b'0 0 0 0'
        self.manager_uid = b'0 0 0 0'
        self.manager_exe = '/usr/lib/systemd/systemd'
        self.dso = elf()
        self.opened, self.closed, self.reads = [], [], []
        self.named_overrides, self.readers, self.inheritable = {}, {}, set()
        self.foreign_mount = False
        self.extra_mounts = {}
        self.late_mount = None
        self.after_mount = None
        self.after_library = None
        self.paths = {
            (None, '/proc'): 10, (10, '427'): 11, (10, '1'): 12, (11, 'fdinfo'): 14,
            (None, '/'): 15, (12, 'root'): 16, (11, 'ns'): 17, (12, 'ns'): 18,
            (12, 'stat'): 29, (11, 'mountinfo'): 30, (12, 'mountinfo'): 31, (12, 'status'): 32, (12, 'exe'): 33,
        }
        self.nodes = {10: directory(2), 11: directory(3), 12: directory(4), 14: directory(5),
                      15: directory(1), 16: directory(1),
                      33: info(73, stat.S_IFREG | 0o755, size=4096)}
        self.mounts = {15: 41, 16: 91}
        for root, base, root_mount, run_mount in ((15, 100, 41, 42), (16, 120, 91, 92)):
            self.paths.update({(root, 'usr'): base, (base, 'lib'): base+1, (base+1, 'systemd'): base+2,
                               (base+2, 'systemd'): base+3, (base+1, 'x86_64-linux-gnu'): base+4,
                               (base+4, A._LIBRARY[-1]): base+5, (root, 'run'): base+6,
                               (base+6, 'dbus'): base+7, (base+7, A._SOCKET[-1]): base+8})
            self.nodes.update({base: directory(70), base+1: directory(71), base+2: directory(72),
                               base+3: self.nodes[33], base+4: directory(74),
                               base+5: info(75, stat.S_IFREG | 0o644, size=len(self.dso)),
                               base+6: directory(76, device=7), base+7: directory(77, device=7),
                               base+8: info(78, stat.S_IFSOCK | 0o666, device=7)})
            self.mounts.update({base+i: root_mount if i < 6 else run_mount for i in range(9)})
        for ns, base in ((17, 50), (18, 60)):
            for index, name in enumerate(A._NAMESPACES):
                fd = base + index
                self.paths[(ns, name)] = fd
                self.nodes[fd] = info(base+index if name == 'mnt' else 200+index, 0, device=4)

    def open(self, path, flags, *, dir_fd=None):
        if dir_fd == 14:
            fd = 1000 + int(path)
            raw = f'mnt_id:\t{self.mounts[int(path)]}\n'.encode()
        else:
            fd = self.paths[(dir_fd, path)]
            if fd == 29:
                raw = b'1 (systemd) S ' + b'0 ' * 18 + str(self.start).encode() + b'\n'
            elif fd == 32:
                raw = b'Uid:\t' + self.manager_uid + b'\nGid:\t' + self.manager_gid + b'\n'
            elif fd in (30, 31):
                r = 41 if fd == 30 else 91
                raw = (f'{r} 1 8:1 / / rw,relatime - ext4 /dev/root rw\n'
                       f'{r+1} {r} 0:7 / /run rw,nosuid,nodev - tmpfs tmpfs rw\n').encode()
                if self.foreign_mount and fd == 31:
                    raw += b'99 92 0:7 / /run/dbus ro - tmpfs tmpfs ro\n'
                raw += self.extra_mounts.get(fd, b'')
            else:
                raw = None
        self.opened.append((fd, flags))
        if raw is not None:
            self.readers[fd] = iter((raw[:2], raw[2:], b''))
        return fd

    def named(self, path, *, dir_fd=None, follow_symlinks=True):
        key = dir_fd, path
        return self.named_overrides.get(key, self.nodes[self.paths[key]])

    def read(self, fd, maximum):
        self.reads.append(fd)
        raw = next(self.readers[fd])
        if fd in (30, 31) and self.late_mount is not None:
            self.now = self.late_mount
        if fd == 31 and self.after_mount is not None:
            self.after_mount()
        if len(raw) > maximum:
            raise AssertionError('model exceeded requested byte count')
        return raw

    def pread(self, fd, maximum, offset):
        if fd != 105:
            raise AssertionError('unexpected library read')
        raw = self.dso[offset:offset+maximum]
        if self.after_library:
            self.after_library(offset)
        return raw

    def mocked(self):
        stack = ExitStack()
        for name, opts in (
            ('open', {'side_effect': self.open}), ('stat', {'side_effect': self.named}),
            ('fstat', {'side_effect': lambda fd: self.nodes.get(fd, info(fd, stat.S_IFREG))}),
            ('read', {'side_effect': self.read}), ('pread', {'side_effect': self.pread}),
            ('close', {'side_effect': self.closed.append}),
            ('readlink', {'side_effect': lambda path, *, dir_fd: {
                (10, 'self'): '427', (12, 'root'): '/', (12, 'exe'): self.manager_exe,
            }[dir_fd, path]}),
            ('pidfd_open', {'return_value': 13, 'create': True}), ('getpid', {'return_value': 427}),
            ('getresuid', {'return_value': (0, 0, 0), 'create': True}),
            ('getresgid', {'return_value': (0, 0, 0), 'create': True}),
            ('get_inheritable', {'side_effect': lambda fd: fd in self.inheritable}),
            ('uname', {'return_value': SimpleNamespace(machine='x86_64')}),
        ):
            stack.enter_context(patch.object(A.os, name, **opts))
        stack.enter_context(patch.object(A.os, 'O_PATH', getattr(A.os, 'O_PATH', 0o10000000), create=True))
        stack.enter_context(patch.object(A.sys, 'platform', 'linux'))
        poll = Mock()
        poll.poll.side_effect = lambda _timeout: [(13, A.select.POLLIN)] if self.dead else []
        stack.enter_context(patch.object(A.select, 'poll', return_value=poll))
        stack.enter_context(patch.object(A.time, 'monotonic_ns', side_effect=lambda: self.now))
        stack.enter_context(patch.object(A.time, 'monotonic', side_effect=lambda: self.now / A._SECOND))
        return stack

    def assert_closed(self, case, *, pidfd=True):
        case.assertCountEqual(self.closed, [fd for fd, _ in self.opened] + ([13] if pidfd else []))


def observe(**changes):
    return A.held_manager_inputs(V, H, M, **({'started_ns': STARTED, 'ready_by_ns': READY} | changes))


class ManagerAdmissionModels(unittest.TestCase):
    def test_fixed_paths_observe_same_pid1_library_and_socket_without_loader_or_connection(self):
        model = NativeModel()
        with model.mocked(), patch('socket.socket', side_effect=AssertionError('unexpected socket')), \
                patch('ctypes.CDLL', side_effect=AssertionError('unexpected load')), observe() as actual:
            self.assertEqual(actual[:6], (314, 105, (1, 75), len(model.dso), hashlib.sha256(model.dso).hexdigest(), (7, 78)))
            model.now = STARTED + 20 * A._SECOND
            self.assertEqual(actual.check_pid1(STARTED + 32 * A._SECOND), 314)
            self.assertNotIn(actual.library_fd, model.closed)
            A.os.pidfd_open.assert_called_once_with(1)
            for fd, flags in model.opened:
                if fd in (108, 128):
                    self.assertEqual(flags, A.os.O_PATH | A.os.O_NOFOLLOW | A.os.O_CLOEXEC)
                if fd in (105, 125):
                    self.assertEqual(flags, V._PROC_FILE)
        model.assert_closed(self)

    def test_refuses_symlink_writable_parent_or_foreign_socket_path_before_admission(self):
        for variant, reason in (('symlink', 'socket'), ('writable-parent', 'launch-view-directory'),
                                ('foreign-owner', 'target-owner')):
            with self.subTest(variant=variant):
                model = NativeModel()
                if variant == 'symlink':
                    model.nodes[108] = info(78, stat.S_IFLNK | 0o777, device=7)
                elif variant == 'writable-parent':
                    model.nodes[107] = directory(77, device=7, mode=0o775)
                else:
                    model.nodes[108] = info(78, stat.S_IFSOCK | 0o666, device=7, uid=1001)
                with model.mocked(), self.assertRaisesRegex(ValueError, reason):
                    with observe():
                        self.fail('unexpected admission')
                model.assert_closed(self)
                self.assertNotIn(108, [fd for fd, _ in model.opened])

    def test_refuses_unsafe_library_header_extent_or_changed_name(self):
        for variant, reason in (('unsafe-mode', 'library'), ('header', 'library-elf'), ('short', 'library-extent'),
                                ('changed-name', 'target-changed'), ('symlink', 'library')):
            with self.subTest(variant=variant):
                model = NativeModel()
                if variant == 'unsafe-mode':
                    model.nodes[105].st_mode = stat.S_IFREG | 0o664
                elif variant == 'header':
                    model.dso = b'\0' * len(model.dso)
                elif variant == 'short':
                    model.dso = model.dso[:64]
                elif variant == 'changed-name':
                    model.after_library = lambda _offset: model.named_overrides.update({
                        (104, A._LIBRARY[-1]): info(999, stat.S_IFREG | 0o644, size=len(model.dso)),
                    })
                else:
                    model.nodes[105].st_mode = stat.S_IFLNK | 0o777
                with model.mocked(), self.assertRaisesRegex(ValueError, 'manager-admission-' + reason):
                    with observe():
                        self.fail('unexpected admission')
                model.assert_closed(self)

    def test_recheck_rejects_pid1_birth_executable_credentials_namespaces_and_exit(self):
        changes = (
            ('start', 315, 'pid1'), ('manager_exe', '/tmp/systemd', 'pid1-root-exe'),
            ('manager_gid', b'0 0 1 0', 'pid1-credentials'), ('manager_uid', b'0 0 0 1', 'pid1-credentials'),
            ('dead', True, 'pid1'),
            ('named_overrides', {(18, 'net'): info(999, 0, device=4)}, 'namespace'),
        )
        for field, value, reason in changes:
            with self.subTest(field=field):
                model = NativeModel()
                with model.mocked(), self.assertRaisesRegex(ValueError, 'manager-admission-' + reason):
                    with observe() as actual:
                        setattr(model, field, value)
                        actual.check_pid1(READY)
                model.assert_closed(self)

    def test_recheck_refuses_socket_rebind_foreign_mount_or_relabelled_library_mount(self):
        for variant, reason in (('socket', 'target-changed'), ('socket-mount', 'mount-view'),
                                ('library-mount', 'target-mount'), ('during-mount', 'target-changed')):
            with self.subTest(variant=variant):
                model = NativeModel()
                with model.mocked(), self.assertRaisesRegex(ValueError, 'manager-admission-' + reason):
                    with observe() as actual:
                        if variant == 'socket':
                            model.named_overrides[(127, A._SOCKET[-1])] = info(999, stat.S_IFSOCK | 0o666, device=7)
                        elif variant == 'socket-mount':
                            model.foreign_mount = True
                        elif variant == 'library-mount':
                            model.mounts[125] = 92
                        else:
                            model.after_mount = lambda: model.named_overrides.update({
                                (127, A._SOCKET[-1]): info(999, stat.S_IFSOCK | 0o666, device=7),
                            })
                        actual.check_pid1(READY)
                model.assert_closed(self)

    def test_original_clock_refuses_invalid_expired_and_late_native_readback(self):
        model = NativeModel()
        with model.mocked():
            for deadline in (STARTED + 42 * A._SECOND, STARTED):
                with self.subTest(deadline=deadline), self.assertRaisesRegex(ValueError, 'manager-admission-clock'):
                    with observe(ready_by_ns=deadline):
                        self.fail('unexpected admission')
            model.now = READY
            with self.assertRaisesRegex(ValueError, 'manager-admission-deadline'):
                with observe():
                    self.fail('unexpected admission')
            self.assertEqual(model.opened, [])
            model.now = STARTED
            with self.assertRaisesRegex(ValueError, 'launch-view-deadline'):
                with observe() as actual:
                    reads = len(model.reads)
                    with self.assertRaisesRegex(ValueError, 'manager-admission-check-clock'):
                        actual.check_pid1(STARTED + 33 * A._SECOND)
                    self.assertEqual(len(model.reads), reads)
                    model.late_mount = READY
                    actual.check_pid1(READY)
        model.assert_closed(self)

    def test_recheck_refuses_stock_ancestor_and_leaf_mount_rows_in_either_view(self):
        targets = ('/usr', '/usr/lib', '/usr/lib/systemd', '/usr/lib/systemd/systemd',
                   '/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu/libsystemd.so.0.38.0')
        for mountinfo, root_mount in ((30, 41), (31, 91)):
            for target in targets:
                with self.subTest(mountinfo=mountinfo, target=target):
                    model = NativeModel()
                    with model.mocked(), self.assertRaisesRegex(ValueError, 'manager-admission-target-mount'):
                        with observe() as actual:
                            # The old held IDs and named stat records still agree after a same-inode bind.
                            model.extra_mounts[mountinfo] = (
                                f'99 {root_mount} 8:1 {target} {target} rw - ext4 /dev/root rw\n'.encode())
                            actual.check_pid1(READY)
                    model.assert_closed(self)

    def test_recheck_allows_unrelated_mount_rows_with_similar_names(self):
        model = NativeModel()
        model.extra_mounts[30] = b'98 41 0:8 / /usr/lib/systemd-backup rw - tmpfs tmpfs rw\n'
        model.extra_mounts[31] = b'99 91 0:8 / /usr/lib/x86_64-linux-gnu/libsystemd.so.0.38.0.old rw - tmpfs tmpfs rw\n'
        with model.mocked(), observe() as actual:
            self.assertEqual(actual.check_pid1(READY), 314)
        model.assert_closed(self)

    def test_recheck_refuses_changed_local_executable_names_after_both_mount_reads(self):
        for key, replacement, reason in (
            ((102, 'systemd'), info(999, stat.S_IFREG | 0o755, size=4096), 'manager-admission-pid1-root-exe'),
            ((15, 'usr'), directory(999), 'launch-view-ancestry'),
        ):
            with self.subTest(key=key):
                model = NativeModel()
                with model.mocked(), self.assertRaisesRegex(ValueError, reason):
                    with observe() as actual:
                        # The second census changes only the caller's named view, not PID1's magic exe.
                        model.after_mount = lambda: model.named_overrides.update({key: replacement})
                        actual.check_pid1(READY)
                model.assert_closed(self)

    def test_borrowed_library_and_callback_close_after_terminal_or_refused_recheck(self):
        model = NativeModel()
        with model.mocked():
            with self.assertRaisesRegex(ValueError, 'manager-admission-target-changed'):
                with observe() as actual:
                    model.inheritable.add(actual.library_fd)
            with self.assertRaisesRegex(ValueError, 'manager-admission-check-clock'):
                actual.check_pid1(READY)
        model.assert_closed(self)


if __name__ == '__main__':
    unittest.main()
