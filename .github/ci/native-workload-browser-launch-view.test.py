"""Models of the held manager and local mount observations. No native calls."""

import pathlib
import stat
import unittest
from contextlib import ExitStack, contextmanager
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


def load(name, source):
    module = ModuleType(name)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


CI = pathlib.Path(__file__).resolve().parent
V = load('launch_view_model', CI / 'native-workload-browser-launch-view.py')
H = load('launch_view_host_model', CI / 'native-workload-browser-host.py')
M = load('launch_view_mountinfo_model', CI.parents[1] / 'deploy/admission/next_profile.py')
RUN = 'aihr-browser-capability-427'


def directory(inode, mode=0o755, device=1):
    return SimpleNamespace(st_dev=device, st_ino=inode, st_mode=stat.S_IFDIR | mode, st_uid=0, st_gid=0)


def binary(inode, mode=0o755, uid=0):
    return SimpleNamespace(st_dev=1, st_ino=inode, st_mode=stat.S_IFREG | mode, st_uid=uid, st_gid=0,
                           st_size=4096, st_mtime_ns=11, st_ctime_ns=12, st_nlink=1)


class NativeViewModel:
    def __init__(self):
        self.now = 100
        self.opened, self.closed = [], []
        self.options = ['rw,nosuid,nodev,relatime'] * 2
        self.foreign = False
        self.dead = False
        self.manager_name = b'systemd'
        self.manager_status = b'Name:\tsystemd\nUid:\t0\t0\t0\t0\n'
        self.manager_link = '/usr/lib/systemd/systemd'
        self.stage_inheritable = False
        self.stages = (25, 28)
        self.manager_id = 92
        self.fd_mounts = {9: 42, 23: 42, 24: 42, 25: 42, 26: 92, 27: 92, 28: 92}
        self.files = {
            (None, '/proc'): 10, (10, '427'): 11, (10, '1'): 12, (11, 'fdinfo'): 14,
            (None, '/'): 15, (12, 'root'): 16, (11, 'ns'): 17, (12, 'ns'): 18,
            (17, 'pid'): 19, (17, 'mnt'): 20, (18, 'pid'): 21, (18, 'mnt'): 22,
            (15, 'run'): 23, (23, RUN): 24, (24, 'launch-source'): 25,
            (16, 'run'): 26, (26, RUN): 27, (27, 'launch-source'): 28,
            (12, 'stat'): 29, (11, 'mountinfo'): 30, (12, 'mountinfo'): 31, (12, 'status'): 32, (12, 'exe'): 33,
            (15, 'usr'): 34, (34, 'lib'): 35, (35, 'systemd'): 36, (36, 'systemd'): 37,
            (16, 'usr'): 38, (38, 'lib'): 39, (39, 'systemd'): 40, (40, 'systemd'): 41,
            **{(14, str(fd)): 100 + fd for fd in self.fd_mounts},
        }
        self.info = {9: directory(6, 0o700, 7), 10: directory(2), 11: directory(3), 12: directory(4),
                     15: directory(1), 16: directory(1),
                     23: directory(4, device=7), 24: directory(5, 0o711, 7), 25: directory(6, 0o700, 7),
                     26: directory(4, device=7), 27: directory(5, 0o711, 7), 28: directory(6, 0o700, 7),
                     19: SimpleNamespace(st_dev=4, st_ino=61), 21: SimpleNamespace(st_dev=4, st_ino=61),
                     20: SimpleNamespace(st_dev=4, st_ino=62), 22: SimpleNamespace(st_dev=4, st_ino=63),
                     33: binary(73), 34: directory(70), 35: directory(71), 36: directory(72), 37: binary(73),
                     38: directory(70), 39: directory(71), 40: directory(72), 41: binary(73)}
        self.names = {}
        self.chunks = {}
        self.fs = [SimpleNamespace(f_flag=V.os.ST_NOSUID | V.os.ST_NODEV, f_frsize=4096,
                                   f_bavail=300000, f_favail=1000) for _ in range(2)]

    def open(self, path, flags, *, dir_fd=None):
        fd = self.files[(dir_fd, path)]
        self.opened.append((fd, flags))
        if fd == 29:
            raw = b'1 (' + self.manager_name + b') S ' + b'0 ' * 18 + b'314\n'
        elif fd == 32:
            raw = self.manager_status
        elif fd in (30, 31):
            mount_id = 42 if fd == 30 else self.manager_id
            flags_text = self.options[fd - 30]
            raw = f'{mount_id} 1 0:7 / /run {flags_text} - tmpfs tmpfs rw\n'.encode()
            if self.foreign and fd == 31:
                raw += f'96 {mount_id} 0:7 / /run/{RUN}/runtime/node ro,nosuid,nodev - tmpfs tmpfs rw\n'.encode()
        elif fd >= 100:
            raw = f'mnt_id:\t{self.fd_mounts[fd-100]}\n'.encode()
        else:
            return fd
        self.chunks[fd] = iter((raw[:2], raw[2:], b''))
        return fd

    def named(self, path, *, dir_fd=None, follow_symlinks=True):
        key = (dir_fd, path)
        return self.names.get(key, self.info[self.files[key]])

    def mocks(self):
        stack = ExitStack()
        for name, options in (
            ('open', {'side_effect': self.open}), ('stat', {'side_effect': self.named}),
            ('fstat', {'side_effect': lambda fd: self.info.get(fd, SimpleNamespace(st_mode=stat.S_IFREG | 0o400))}),
            ('fstatvfs', {'side_effect': lambda fd: self.fs[self.stages.index(fd)]}),
            ('read', {'side_effect': lambda fd, _: next(self.chunks[fd])}), ('close', {'side_effect': self.closed.append}),
            ('readlink', {'side_effect': lambda path, *, dir_fd: {
                (10, 'self'): '427', (12, 'root'): '/', (12, 'exe'): self.manager_link,
            }[dir_fd, path]}),
            ('pidfd_open', {'return_value': 13}), ('getpid', {'return_value': 427}),
            ('getresuid', {'return_value': (0, 0, 0)}), ('getresgid', {'return_value': (0, 0, 0)}),
            ('get_inheritable', {'side_effect': lambda fd: fd == 9 and self.stage_inheritable}),
        ):
            stack.enter_context(patch.object(V.os, name, **options))
        stack.enter_context(patch.object(V.select, 'select', side_effect=lambda *_: ([13] if self.dead else [], [], [])))
        stack.enter_context(patch.object(V.time, 'monotonic', side_effect=lambda: self.now))
        return stack

    def assert_closed(self, case):
        case.assertCountEqual(self.closed, [fd for fd, _ in self.opened] + [13])
        case.assertNotIn(9, self.closed)


def observe(**changes):
    arguments = {'run_id': '427', 'stage_fd': 9, 'planned_bytes': V._MAX_BYTES,
                 'planned_entries': V._MAX_ENTRIES, 'deadline': 110}
    return V.held_launch_source(H, M, **(arguments | changes))


class LaunchViewModels(unittest.TestCase):
    def test_same_backing_stage_uses_two_namespace_local_mount_ids_and_closes_owned_fds(self):
        model = NativeViewModel()
        with model.mocks(), observe() as facts:
            self.assertEqual(facts, ('/run/' + RUN + '/launch-source', (7, 6), 42, 92))
        model.assert_closed(self)
        for fd, flags in model.opened:
            self.assertEqual(flags & V.os.O_ACCMODE, V.os.O_RDONLY)
            self.assertEqual(bool(flags & V.os.O_NOFOLLOW), fd not in (16, 19, 20, 21, 22, 33))

    def test_same_pid1_birth_requires_fixed_protected_binary_and_all_four_root_uids(self):
        for variant, reason in (('foreign-exe', 'executable'), ('wrong-link', 'executable'),
                                ('foreign-manager-root-image', 'executable'), ('writable-image', 'executable'),
                                ('nonroot-image', 'executable'), ('changed-exe', 'executable'),
                                ('nonroot-uid', 'uid'), ('duplicate-uid', 'uid'), ('changed-uid', 'uid')):
            model = NativeViewModel()
            if variant == 'foreign-exe':
                model.info[33] = binary(74)
            if variant == 'wrong-link':
                model.manager_link = '/usr/lib/systemd/systemd (deleted)'
            if variant == 'foreign-manager-root-image':
                model.info[41] = binary(74)
            if variant == 'writable-image':
                model.info[37] = binary(73, 0o775)
            if variant == 'nonroot-image':
                model.info[37] = binary(73, uid=1000)
            if variant == 'nonroot-uid':
                model.manager_status = b'Uid:\t0\t0\t0\t1000\n'
            if variant == 'duplicate-uid':
                model.manager_status += b'Uid:\t0\t0\t0\t0\n'
            with self.subTest(variant=variant), model.mocks(), self.assertRaisesRegex(ValueError, '^launch-view-manager-' + reason + '$'):
                with observe():
                    if variant == 'changed-exe':
                        model.names[12, 'exe'] = binary(74)
                    elif variant == 'changed-uid':
                        model.manager_status = b'Uid:\t0\t1\t0\t0\n'
                    else:
                        self.fail('unproved manager was yielded')
            model.assert_closed(self)

    def test_manager_namespace_or_stage_replacement_refuses_before_publication(self):
        for variant, reason in (('pid-namespace', 'pid-namespace'), ('foreign-inode', 'backing-identity'),
                                ('wrong-mode', 'directory'), ('foreign-held-stage', 'stage-fd'), ('dead-manager', 'manager-birth'),
                                ('foreign-manager', 'manager-birth'), ('foreign-proc', 'proc-identity')):
            model = NativeViewModel()
            if variant == 'pid-namespace':
                model.info[21] = SimpleNamespace(st_dev=4, st_ino=64)
            if variant == 'foreign-inode':
                model.info[28] = directory(66, 0o700, 7)
            if variant == 'wrong-mode':
                model.info[28] = directory(6, 0o755, 7)
            if variant == 'foreign-held-stage':
                model.info[9] = directory(66, 0o700, 7)
            if variant == 'foreign-manager':
                model.manager_name = b'foreign'
            if variant == 'foreign-proc':
                model.names[None, '/proc'] = directory(66)
            model.dead = variant == 'dead-manager'
            with self.subTest(variant=variant), model.mocks(), self.assertRaisesRegex(ValueError, '^launch-view-' + reason + '$'):
                with observe():
                    self.fail('unproved view was yielded')
            model.assert_closed(self)

    def test_mountinfo_fd_identity_flags_and_foreign_mounts_fail_closed(self):
        for variant, reason in (('noexec', 'run-mount'), ('missing-nodev', 'run-mount'),
                                ('wrong-fd-mount', 'fd-mount'), ('foreign-mount', 'foreign-mount'),
                                ('fd-noexec', 'fd-flags'), ('stale-stage-fd', 'stage-mount')):
            model = NativeViewModel()
            if variant == 'noexec':
                model.options[1] += ',noexec'
            if variant == 'missing-nodev':
                model.options[1] = 'rw,nosuid'
            if variant == 'wrong-fd-mount':
                model.fd_mounts[28] = 42
            if variant == 'stale-stage-fd':
                model.fd_mounts[9] = 92
            if variant == 'fd-noexec':
                model.fs[1].f_flag |= V.os.ST_NOEXEC
            model.foreign = variant == 'foreign-mount'
            with self.subTest(variant=variant), model.mocks(), self.assertRaisesRegex(ValueError, '^launch-view-' + reason + '$'):
                with observe():
                    self.fail('unproved view was yielded')
            model.assert_closed(self)

    def test_allocations_require_both_fragment_space_and_inode_reserves(self):
        fragment = 4096
        required = V._MAX_BYTES + (V._MAX_ENTRIES + 16) * fragment + V._RESERVE_BYTES
        blocks = (required + fragment - 1) // fragment
        for available, inodes, accepted in ((blocks, V._MAX_ENTRIES + 128, True),
                                             (blocks - 1, V._MAX_ENTRIES + 128, False),
                                             (blocks, V._MAX_ENTRIES + 127, False)):
            model = NativeViewModel()
            model.fs[1].f_bavail, model.fs[1].f_favail = available, inodes
            with self.subTest(available=available, inodes=inodes), model.mocks():
                if accepted:
                    with observe():
                        model.fs[1].f_bavail = (V._RESERVE_BYTES + 16 * fragment) // fragment
                        model.fs[1].f_favail = 128
                else:
                    with self.assertRaisesRegex(ValueError, '^launch-view-capacity$'), observe():
                        self.fail('over-budget view was yielded')
            model.assert_closed(self)

    def test_postview_mount_namespace_path_and_clock_drift_are_refusals(self):
        for variant, reason in (('new-mount-id', 'mount-changed'), ('namespace', 'namespace'),
                                ('named-stage', 'ancestry'), ('inheritable-stage', 'stage-fd'), ('deadline', 'deadline')):
            model = NativeViewModel()
            with self.subTest(variant=variant), model.mocks(), self.assertRaisesRegex(ValueError, '^launch-view-' + reason + '$'):
                with observe():
                    if variant == 'new-mount-id':
                        model.manager_id = 93
                        model.fd_mounts.update({26: 93, 27: 93, 28: 93})
                    if variant == 'namespace':
                        model.names[18, 'mnt'] = SimpleNamespace(st_dev=4, st_ino=64)
                    if variant == 'named-stage':
                        model.names[27, 'launch-source'] = directory(66, 0o700, 7)
                    if variant == 'inheritable-stage':
                        model.stage_inheritable = True
                    if variant == 'deadline':
                        model.now = 110
            model.assert_closed(self)

    def test_run_and_capacity_inputs_cannot_choose_another_path_or_unbounded_allocation(self):
        for changes, reason in (({'run_id': '../427'}, 'run'), ({'planned_bytes': V._MAX_BYTES + 1}, 'copy-bound'),
                                ({'planned_entries': V._MAX_ENTRIES + 1}, 'copy-bound'),
                                ({'planned_entries': 0}, 'copy-bound'), ({'deadline': float('inf')}, 'deadline'),
                                ({'deadline': 281}, 'deadline')):
            model = NativeViewModel()
            with self.subTest(changes=changes), model.mocks(), self.assertRaisesRegex(ValueError, '^launch-view-' + reason + '$'):
                with observe(**changes):
                    self.fail('foreign plan was yielded')
            self.assertEqual(model.opened, [])
            self.assertEqual(model.closed, [])

    def test_empty_parent_checks_exact_held_birth_both_mounts_and_both_censuses(self):
        for variant, reason in ((0o700, None), (0o711, None), (0o755, 'directory'),
                                ('foreign-parent', 'backing-identity'), ('stale-held-mount', 'stage-mount'),
                                ('manager-submount', 'foreign-mount'), ('manager-child', 'empty-parent'),
                                ('late-local-child', 'empty-parent')):
            model = NativeViewModel()
            mode = variant if type(variant) is int else 0o700
            model.info.update({fd: directory(5, mode, 7) for fd in (9, 24, 27, 42, 43)})
            model.files.update({(24, '.'): 42, (27, '.'): 43, (14, '42'): 142, (14, '43'): 143})
            model.fd_mounts.update({42: 42, 43: 92})
            if variant == 'foreign-parent':
                model.info[27] = directory(6, mode, 7)
            if variant == 'stale-held-mount':
                model.fd_mounts[9] = 92
            model.foreign = variant == 'manager-submount'
            scans = []

            @contextmanager
            def scan(fd):
                scans.append(fd)
                occupied = variant == 'manager-child' and fd == 43 or variant == 'late-local-child' and len(scans) == 3
                yield iter(('foreign',) if occupied else ())

            def check_view():
                with V.held_empty_launch_parent(H, M, run_id='427', run_fd=9, deadline=110) as facts:
                    self.assertIn(variant, (0o700, 0o711, 'late-local-child'))
                    self.assertEqual(facts, ('/run/' + RUN, (7, 5), 42, 92))
                    self.assertEqual(scans, [42, 43])

            with self.subTest(variant=variant), model.mocks(), patch.object(V.os, 'scandir', side_effect=scan):
                if reason is None:
                    check_view()
                    self.assertEqual(scans, [42, 43, 42, 43])
                else:
                    with self.assertRaisesRegex(ValueError, '^launch-view-' + reason + '$'):
                        check_view()
            model.assert_closed(self)
            self.assertFalse(any(fd in (25, 28) for fd, _ in model.opened))


if __name__ == '__main__':
    unittest.main()
