"""Models of service-view readback without services, mounts or root privileges."""
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
S = load('service_view_model', CI / 'native-workload-browser-service-view.py')
P = load('service_view_plan', CI / 'native-workload-browser-launch-plan.py')
F = load('service_view_stage', CI / 'native-workload-browser-synthetic-stage.py')
H = load('service_view_host', CI / 'native-workload-browser-host.py')
M = load('service_view_mounts', CI.parents[1] / 'deploy/admission/next_profile.py')
ROOT = '/run/aihr-browser-capability-427'
SOURCE = ROOT.removeprefix('/run') + '/launch-source'
LEAVES = frozenset(leaf for leaves in P._ROLE_FILES.values() for leaf in leaves)
DEV = S.os.makedev(0, 7)
COVER = '42 1 0:7 / /run rw,nosuid,nodev - tmpfs tmpfs rw'


def mounts_for(role):
    return [
        f'{i} 42 0:7 {SOURCE}/{leaf} {ROOT}/runtime/{leaf} ro,nosuid,nodev - tmpfs tmpfs rw'
        for i, leaf in enumerate(P._ROLE_FILES[role], 51)
    ]


def auxiliary_for(role):
    if role == 'third':
        return {home: f'{number} 42 0:7 /systemd/inaccessible/dir {ROOT}/{home} ro - tmpfs tmpfs rw'
                for number, home in ((90, 'driver-home'), (91, 'browser-home'))}
    opposite = 'driver-home' if role == 'browser' else 'browser-home'
    scratch = role + '-home/scratch'
    return {
        scratch: f'90 42 0:7 {ROOT.removeprefix("/run")}/{scratch} {ROOT}/{scratch} rw - tmpfs tmpfs rw',
        opposite: f'91 42 0:7 /systemd/inaccessible/dir {ROOT}/{opposite} ro - tmpfs tmpfs rw',
    }


def state(info):
    return ((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode), info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Files:
    def __init__(self):
        self.opened, self.closed = [], []
        self.info, self.links, self.mounts = {}, {}, {}
        self.read_count = {}
        self.vfs = {}
        self.add('/run-fixture', True, 0o711, 42)
        self.run = self.links['/run-fixture']
        self.granted = {'node': (51, ()), 'chromium/chrome-headless-shell-linux64': (52, ())}
        self.births = []
        for name in (*S._CONTAINERS, *('runtime/' + leaf for leaf in sorted(LEAVES))):
            leaf = name.removeprefix('runtime/')
            directory = name in S._CONTAINERS or leaf in P._PLAYWRIGHT or leaf == 'chromium/chrome-headless-shell-linux64'
            number = self.add(name, directory, 0o711 if name in S._CONTAINERS else 0, 42)
            self.births.append((name, 'directory' if directory else 'file', (DEV, self.info[number].st_ino)))
        self.projected = {
            'node': {'node': self.member('node', False, 51, 0o555)},
            'chromium/chrome-headless-shell-linux64': {
                'chromium/chrome-headless-shell-linux64': self.member('chromium/chrome-headless-shell-linux64', True, 52, 0o555),
                S._CHROMIUM: self.member(S._CHROMIUM, False, 52, 0o555),
            },
        }

    def add(self, path, directory, mode, mount, size=0):
        number = len(self.info) + 7
        self.links[path] = number
        self.mounts[number] = mount
        self.info[number] = SimpleNamespace(st_dev=DEV, st_ino=number + 100, st_uid=0, st_gid=0,
                                            st_mode=(stat.S_IFDIR if directory else stat.S_IFREG) | mode,
                                            st_nlink=2 if directory else 1, st_size=size, st_mtime_ns=11, st_ctime_ns=12)
        return number

    def member(self, leaf, directory, mount, mode):
        number = self.add('runtime/' + leaf, directory, mode, mount, 0 if directory else 49)
        self.vfs[number] = S.os.ST_RDONLY | S.os.ST_NOSUID | S.os.ST_NODEV
        return F.SealedStageMember(leaf, 'directory' if directory else 'file', mode, self.info[number].st_size,
                                   None if directory else 'a' * 64, state(self.info[number]))

    def path(self, parent, name):
        prefix = next(p for p, fd in self.links.items() if fd == parent)
        return name if prefix == '/run-fixture' else prefix + '/' + name

    def stat(self, name, *, dir_fd, follow_symlinks):
        if follow_symlinks:
            raise AssertionError('followed an ordinary name')
        path = self.path(dir_fd, name)
        self.read_count[path] = self.read_count.get(path, 0) + 1
        return self.info[self.links[path]]

    def open(self, name, flags, *, dir_fd):
        if flags & (S.os.O_NOFOLLOW | S.os.O_CLOEXEC) != S.os.O_NOFOLLOW | S.os.O_CLOEXEC:
            raise AssertionError('ordinary open lacked nofollow/CLOEXEC')
        if flags & S.os.O_ACCMODE:
            raise AssertionError('unexpected write authority')
        fd = self.links[self.path(dir_fd, name)]
        self.opened.append(fd)
        return fd

    @contextmanager
    def scan(self, fd):
        prefix = next(p for p, number in self.links.items() if number == fd)
        yield (SimpleNamespace(name=path.rpartition('/')[2]) for path in self.links if path.rpartition('/')[0] == prefix)

    @contextmanager
    def own(self, fd):
        try:
            yield fd
        finally:
            self.closed.append(fd)

    @contextmanager
    def readback(self):
        view = SimpleNamespace(_mount_id=lambda _info, fd, deadline: self.mounts[fd],
                               _own=self.own, _check_clock=lambda _: None)
        with ExitStack() as held:
            for name, function in (('open', self.open), ('stat', self.stat), ('fstat', self.info.__getitem__),
                                   ('scandir', self.scan),
                                   ('fstatvfs', lambda fd: SimpleNamespace(f_flag=self.vfs[fd]))):
                held.enter_context(patch.object(S.os, name, side_effect=function))
            yield S._Readback(view, SimpleNamespace(_state=state), 99, 100)

    def inspect(self):
        with self.readback() as observer:
            observer.runtime(
                self.run, 42, SimpleNamespace(created=self.births), self.granted, self.projected, LEAVES,
            )


class ServiceViewModels(unittest.TestCase):
    def test_exact_mount_topology_for_all_role_sets_and_private_slave_mount(self):
        for role in P._ROLE_FILES:
            with self.subTest(role=role):
                rows = mounts_for(role)
                rows[0] = rows[0].replace(' - ', ' master:82 - ')
                raw = ('\n'.join([COVER, *rows, *auxiliary_for(role).values()]) + '\n').encode()
                got, auxiliary = S._runtime_mounts(M, raw,
                                                   42, ROOT, frozenset(P._ROLE_FILES[role]), DEV, role)
                self.assertEqual(got.keys(), set(P._ROLE_FILES[role]))
                self.assertEqual(set(item[0] for item in got.values()), set(range(51, 51 + len(rows))))
                self.assertEqual(auxiliary.keys(), auxiliary_for(role).keys())

    def test_fixed_scratch_and_home_mask_are_stable_auxiliary_not_runtime_grants(self):
        raw = ('\n'.join([COVER, *mounts_for('browser'), *auxiliary_for('browser').values()]) + '\n').encode()
        mounts, auxiliary = S._runtime_mounts(M, raw, 42, ROOT, frozenset(P._ROLE_FILES['browser']), DEV, 'browser')
        self.assertEqual(set(mounts), set(P._ROLE_FILES['browser']))
        self.assertEqual({name: row[0] for name, row in auxiliary.items()}, {'browser-home/scratch': 90, 'driver-home': 91})

    def test_wrong_parent_source_flags_shared_nested_or_alias_mount_refuses(self):
        expected = frozenset(P._ROLE_FILES['browser'])
        rows = mounts_for('browser')
        for variant, altered, reason in (
            ('wrong-parent', [rows[0].replace('51 42 ', '51 7 '), *rows[1:]], 'mount-topology'),
            ('wrong-source', [rows[0].replace('/launch-source/node', '/launch-source/wrong'), *rows[1:]], 'mount-topology'),
            ('writable', [rows[0].replace(' ro,', ' rw,'), *rows[1:]], 'mount-flags'),
            ('noexec', [rows[0].replace('ro,nosuid,nodev', 'ro,nosuid,nodev,noexec'), *rows[1:]], 'mount-flags'),
            ('shared', [rows[0].replace(' - ', ' shared:82 - '), *rows[1:]], 'mount-propagation'),
            ('duplicate', [*rows, rows[0].replace('51 42', '99 42')], 'mount-census'),
            ('nested', [*rows, f'99 51 0:7 / {ROOT}/runtime/node_modules/playwright/nested ro,nosuid,nodev - tmpfs tmpfs rw'], 'mount-census'),
            ('unexpected-role', [*rows, f'99 42 0:7 / {ROOT}/runtime/roles/native-workload-browser-driver.mjs ro - tmpfs tmpfs rw'], 'mount-census'),
            ('missing', rows[:-1], 'mount-census'),
            ('covered-source', [*rows, f'99 42 0:7 / {ROOT}/launch-source ro - tmpfs tmpfs rw'], 'source-covered'),
            ('alias', [*rows, f'99 42 0:7 {SOURCE}/node /unplanned-tool ro - tmpfs tmpfs rw'], 'source-alias'),
            ('cover-root-alias', [*rows, '99 1 0:7 / /unplanned-run-alias ro,nosuid,nodev - tmpfs tmpfs rw'], 'source-alias'),
            ('run-root-alias', [*rows, f'99 42 0:7 {ROOT.removeprefix("/run")} /unplanned-run ro - tmpfs tmpfs rw'], 'source-alias'),
            ('auxiliary', [*rows, f'99 42 0:7 / {ROOT}/private/external ro - tmpfs tmpfs rw'], 'auxiliary-mount'),
        ):
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, '^service-view-' + reason + '$'):
                raw = ('\n'.join([COVER, *altered, *auxiliary_for('browser').values()]) + '\n').encode()
                S._runtime_mounts(M, raw, 42, ROOT, expected, DEV, 'browser')

    def test_each_home_mask_or_scratch_omission_refuses_for_all_roles(self):
        for role in P._ROLE_FILES:
            auxiliary = auxiliary_for(role)
            for omitted in auxiliary:
                rows = [COVER, *mounts_for(role), *(row for name, row in auxiliary.items() if name != omitted)]
                with self.subTest(role=role, omitted=omitted), self.assertRaisesRegex(
                    ValueError, '^service-view-auxiliary-census$',
                ):
                    S._runtime_mounts(M, ('\n'.join(rows) + '\n').encode(),
                                      42, ROOT, frozenset(P._ROLE_FILES[role]), DEV, role)

    def test_live_scratch_joins_owned_home_and_scratch_births_native_mount_and_writable_flags(self):
        for variant, reason in (('positive', None), ('home', 'fd-mount'), ('scratch', 'fd-mount'),
                                ('birth', 'scratch-identity'), ('readonly', 'scratch-writable'),
                                ('mask', 'home-mask')):
            files = Files()
            home = files.add('browser-home', True, 0o700, 42)
            scratch = files.add('browser-home/scratch', True, 0o700, 90)
            mask = files.add('driver-home', True, 0, 91)
            for fd in (home, scratch):
                files.info[fd].st_uid = files.info[fd].st_gid = H.BROWSER
            layout = SimpleNamespace(created=[
                ('browser-home', 'directory', (DEV, files.info[home].st_ino)),
                ('browser-home/scratch', 'directory', (DEV, files.info[scratch].st_ino)),
            ])
            files.vfs[scratch] = S.os.ST_RDONLY if variant == 'readonly' else 0
            if variant == 'home':
                files.mounts[home] = 90
            elif variant == 'scratch':
                files.mounts[scratch] = 42
            elif variant == 'birth':
                files.info[scratch].st_ino += 1
            elif variant == 'mask':
                files.info[mask].st_mode |= 0o711
            rows = {'browser-home/scratch': (90, (), (), ()), 'driver-home': (91, (), (), ())}
            with self.subTest(variant=variant), files.readback() as observer:
                if reason is None:
                    observer.auxiliary(files.run, 42, layout, rows, H.BROWSER)
                    self.assertEqual(files.read_count['browser-home/scratch'], 2)
                else:
                    with self.assertRaisesRegex(ValueError, '^service-view-' + reason + '$'):
                        observer.auxiliary(files.run, 42, layout, rows, H.BROWSER)
            self.assertCountEqual(files.opened, files.closed)

    def test_inode_bound_executables_empty_placeholders_and_exact_tree(self):
        files = Files()
        files.inspect()
        self.assertCountEqual(files.opened, files.closed)
        for leaf in ('runtime/node', 'runtime/' + S._CHROMIUM):
            self.assertEqual(files.read_count[leaf], 2)

    def test_descendant_mount_id_mode_inode_sibling_and_native_exec_flags_refuse(self):
        for variant, reason in (('mount', 'fd-mount'), ('stamp', 'member-identity'),
                                ('exec', 'executable'), ('dev', 'fd-flags'),
                                ('sibling', 'placeholder'), ('extra', 'directory-census')):
            files = Files()
            exe = files.links['runtime/' + S._CHROMIUM]
            if variant == 'mount':
                files.mounts[exe] = 70
            elif variant == 'stamp':
                files.info[exe].st_mtime_ns += 1
            elif variant == 'exec':
                files.vfs[exe] |= S.os.ST_NOEXEC
            elif variant == 'dev':
                files.vfs[files.links['runtime/node']] &= ~S.os.ST_NODEV
            elif variant == 'sibling':
                files.info[files.links['runtime/roles/native-workload-browser-driver.mjs']].st_mode |= 0o444
            elif variant == 'extra':
                files.add('runtime/node_modules/postgres', True, 0o755, 42)
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, '^service-view-' + reason + '$'):
                files.inspect()
            self.assertCountEqual(files.opened, files.closed)

    def test_held_pidfd_must_report_same_native_pid_before_process_root_lookup(self):
        layout = SimpleNamespace(run_id='427', host=H, mounts=M, stage=90)
        deadlines = []

        def inspect_fixed(*, role_deadline):
            deadlines.append(role_deadline)
            return SimpleNamespace(journal=SimpleNamespace(pending=None, created=[()] * 19))

        layout.inspect_fixed = inspect_fixed
        view = ModuleType('service_view_held_pidfd_model')
        layout.view = view
        view._own = Files().own
        view._read_proc = lambda *_: b'Pid:\t941\n'
        initial = H._MainSnapshot(H._MainIdentity(940, 17, (1, 2), ((1, 2),) * 5, 3, (4, 5), (4, 6)), (7, 8))
        calls = []
        installer = ModuleType('service_view_installer_model')
        installer._state = state
        clock = H.Deadline()
        stage_info = SimpleNamespace(st_dev=DEV, st_ino=3, st_uid=0, st_gid=0,
                                     st_mode=stat.S_IFDIR | 0o700, st_nlink=2, st_size=0, st_mtime_ns=1, st_ctime_ns=2)
        snapshot = F.SyntheticStageSnapshot(state(stage_info), (F.SealedStageMember(
            P._ROLE_FILES['third'][0], 'file', 0o444, 8, 'b' * 64, (),
        ),))
        with ExitStack() as held:
            held.enter_context(patch.object(S, '_MAX_MEMBERS', 1))
            for name, function in (('open', lambda path, *_: calls.append(path) or 92),
                                   ('fstat', lambda _: stage_info), ('get_inheritable', lambda _: False),
                                   ('getresuid', lambda: (0, 0, 0)), ('getresgid', lambda: (0, 0, 0))):
                held.enter_context(patch.object(S.os, name, side_effect=function))
            with self.assertRaisesRegex(ValueError, '^service-view-pidfd$'):
                S.observe_service_view(H, M, view, P, installer, F, role='third', run_id='427',
                                       main=(91, initial, lambda: initial), layout=layout,
                                       stage_snapshot=snapshot, clock=clock)
        self.assertEqual(calls, ['/proc/self/fdinfo'])
        self.assertEqual(deadlines, [clock.start + 42])

    def test_both_layout_reads_use_original_role_cutoff_and_late_observation_cannot_publish(self):
        for role, frontier in (('driver', 32), ('third', 42)):
            for late in (False, True):
                with self.subTest(role=role, late=late), ExitStack() as held:
                    now = 100
                    held.enter_context(patch.object(H.time, 'monotonic', side_effect=lambda: now))
                    clock = H.Deadline()
                    deadline = now + frontier
                    deadlines = []
                    files = Files()
                    layout = SimpleNamespace(run_id='427', host=H, mounts=M, stage=90)
                    created = [(f'fixture-{i}', 'file', (DEV, i + 1)) for i in range(19)]
                    journal = SimpleNamespace(pending=None, created=created, run_birth=(DEV, 7))

                    def inspect_fixed(*, role_deadline):
                        nonlocal now
                        deadlines.append(role_deadline)
                        if late and len(deadlines) == 2:
                            now = deadline
                        return SimpleNamespace(journal=journal)

                    layout.inspect_fixed = inspect_fixed
                    view = ModuleType('service_view_role_cutoff_model')
                    layout.view = view
                    view._own = files.own
                    cgroup = f'0::/system.slice/aihrbc-{role}-427.service\n'.encode('ascii')
                    view._read_proc = lambda _fd, key, _limit, _deadline: {
                        '91': b'Pid:\t940\n', 'stat': b'940 (python) S ' + b'0 ' * 18 + b'17\n',
                        'cgroup': cgroup, 'mountinfo': b'fixed native topology model',
                    }[key]
                    view._root_directory = state
                    view._walk_directories = lambda *_: ((97, 'run', 98), (98, 'course', 99))
                    view._check_chain = lambda _: None
                    view._mount_id = lambda *_: 42
                    installer = ModuleType('service_view_role_cutoff_installer')
                    installer._state = state
                    info = SimpleNamespace(st_dev=DEV, st_ino=7, st_uid=0, st_gid=0,
                                           st_mode=stat.S_IFDIR | 0o700, st_nlink=2,
                                           st_size=0, st_mtime_ns=1, st_ctime_ns=2)
                    initial = H._MainSnapshot(H._MainIdentity(
                        940, 17, (1, 2), ((DEV, 7),) * 5, 3, (4, 5), (4, 6),
                    ), (7, 8))
                    expected = sorted(P._ROLE_FILES[role])
                    snapshot = F.SyntheticStageSnapshot(state(info), tuple(
                        F.SealedStageMember(path, 'file', 0o444, 8, 'b' * 64, ()) for path in expected
                    ))
                    grants = {path: (51 + i, frozenset()) for i, path in enumerate(expected)}
                    paths = {'/proc/self/fdinfo': 92, '/proc': 93, '940': 94, 'ns': 95, 'mnt': 96, 'root': 97}
                    held.enter_context(patch.object(S, '_MAX_MEMBERS', len(expected)))
                    held.enter_context(patch.object(S, '_runtime_mounts', return_value=(grants, {})))
                    held.enter_context(patch.object(S._Readback, 'runtime'))
                    for name, function in (
                        ('open', lambda path, *_, **__: paths[path]), ('fstat', lambda _: info),
                        ('stat', lambda *_, **__: info), ('readlink', lambda *_, **__: '/'),
                        ('get_inheritable', lambda _: False), ('getresuid', lambda: (0, 0, 0)),
                        ('getresgid', lambda: (0, 0, 0)),
                    ):
                        held.enter_context(patch.object(S.os, name, side_effect=function))

                    def observe():
                        return S.observe_service_view(H, M, view, P, installer, F, role=role, run_id='427',
                                                      main=(91, initial, lambda: initial), layout=layout,
                                                      stage_snapshot=snapshot, clock=clock)

                    if late:
                        with self.assertRaisesRegex(H.Refused, '^capability-deadline$'):
                            observe()
                    else:
                        self.assertEqual(observe(), (role, 940, 17, (DEV, 7),
                                                    tuple((path, grants[path][0]) for path in expected), len(expected)))
                    self.assertEqual(deadlines, [deadline, deadline])
                    self.assertCountEqual(files.closed, paths.values())


if __name__ == '__main__':
    unittest.main()
