"""Observe only the held synthetic main's fixed service-local bind view."""
import os
import re
import stat
from contextlib import ExitStack
from types import ModuleType
from typing import NamedTuple


_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
_MOUNTINFO_LIMIT = 4 * 1024**2
_MAX_MEMBERS = 509
_CONTAINERS = ('runtime', 'runtime/roles', 'runtime/node_modules', 'runtime/chromium')
_CHROMIUM = 'chromium/chrome-headless-shell-linux64/chrome-headless-shell'


class ServiceView(NamedTuple):
    role: str
    pid: int
    start: int
    mount_namespace: tuple[int, int]
    mounts: tuple[tuple[str, int], ...]
    members: int


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _inside(path, root):
    return path == root or path.startswith(root + '/')


def _nonpropagating(optional):
    return not optional or len(optional) == 1 and re.fullmatch(r'master:[1-9][0-9]{0,9}', optional[0])


def _runtime_mounts(mounts, raw, cover_id, root, expected, device, role):
    """Keep the existing mount parser; bind only the additional native fields needed here."""
    parsed = mounts.parse_mountinfo(raw, _require)
    fields = {int(parts[0]): parts for line in raw.decode().splitlines()
              if (parts := line.split(' - ', 1)[0].split())}
    covers = [row for row in parsed if row['target'] == '/run']
    _require(len(covers) == 1 and covers[0]['id'] == cover_id and covers[0]['fsType'] == 'tmpfs', 'service-view-cover')
    cover = fields[cover_id]
    dev = f'{os.major(device)}:{os.minor(device)}'
    _require(cover[2:4] == [dev, '/'], 'service-view-cover')
    backing = root.removeprefix('/run')
    source = backing + '/launch-source'
    masks = {'driver': {'browser-home'}, 'browser': {'driver-home'}, 'third': {'driver-home', 'browser-home'}}[role]
    scratch = None if role == 'third' else role + '-home/scratch'
    required_auxiliary = masks if scratch is None else masks | {scratch}

    def reject_alias(native):
        if native[2] == dev:
            mount_root = native[3]
            _require(mount_root != '/' and not _inside(mount_root, backing) and not _inside(backing, mount_root),
                     'service-view-source-alias')

    targets, auxiliary = {}, {}
    for row in parsed:
        if row['id'] == cover_id:
            continue
        target = row['target']
        native = fields[row['id']]
        if target == root or _inside(target, root + '/launch-source'):
            raise ValueError('service-view-source-covered')
        if _inside(target, root + '/runtime'):
            leaf = target.removeprefix(root + '/runtime/')
            _require(leaf in expected and leaf not in targets, 'service-view-mount-census')
            _require(native[1:4] == [str(cover_id), dev, source + '/' + leaf]
                     and row['fsType'] == 'tmpfs', 'service-view-mount-topology')
            _require(_nonpropagating(native[6:]), 'service-view-mount-propagation')
            flags = row['options']
            _require({'ro', 'nosuid', 'nodev'} <= flags and 'rw' not in flags
                     and (leaf not in ('node', _CHROMIUM.rpartition('/')[0]) or 'noexec' not in flags),
                     'service-view-mount-flags')
            targets[leaf] = (row['id'], frozenset(flags))
        else:
            if _inside(target, root):
                relative = target.removeprefix(root + '/')
                _require(relative not in auxiliary and native[1] == str(cover_id)
                         and relative in required_auxiliary, 'service-view-auxiliary-mount')
                _require(_nonpropagating(native[6:]), 'service-view-mount-propagation')
                if relative == scratch:
                    _require(native[2:4] == [dev, backing + '/' + scratch]
                             and 'rw' in row['options'] and 'ro' not in row['options'], 'service-view-scratch')
                else:
                    reject_alias(native)
                auxiliary[relative] = (row['id'], tuple(native[1:4]), frozenset(row['options']), tuple(native[6:]))
            else:
                reject_alias(native)
    _require(targets.keys() == expected, 'service-view-mount-census')
    _require(auxiliary.keys() == required_auxiliary, 'service-view-auxiliary-census')
    return targets, auxiliary


def _stage_rows(finalizer, snapshot, expected):
    _require(type(snapshot) is finalizer.SyntheticStageSnapshot and type(snapshot.members) is tuple
             and len(snapshot.members) == _MAX_MEMBERS, 'service-view-stage-snapshot')
    projected = {leaf: {} for leaf in expected}
    previous = ''
    for row in snapshot.members:
        _require(type(row) is finalizer.SealedStageMember and type(row.path) is str and previous < row.path,
                 'service-view-stage-member')
        previous = row.path
        for leaf in expected:
            if _inside(row.path, leaf):
                projected[leaf][row.path] = row
    _require(all(leaf in subtree for leaf, subtree in projected.items()), 'service-view-stage-members')
    return projected


class _Readback:
    def __init__(self, view, installer, fdinfo, deadline):
        self.view, self.state, self.fdinfo, self.deadline = view, installer._state, fdinfo, deadline

    def _mount(self, fd, mount_id):
        _require(self.view._mount_id(self.fdinfo, fd, self.deadline) == mount_id, 'service-view-fd-mount')

    def _entries(self, folder, expected):
        found = set()
        with os.scandir(folder) as entries:
            for entry in entries:
                self.view._check_clock(self.deadline)
                _require(entry.name in expected and entry.name not in found, 'service-view-directory-census')
                found.add(entry.name)
        _require(found == expected, 'service-view-directory-census')

    def _member(self, parent, name, row, mount_id, subtree, children, *, mount_root=False):
        self.view._check_clock(self.deadline)
        flags = _DIRECTORY if row.kind == 'directory' else _READ
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        _require(self.state(before) == row.state, 'service-view-member-identity')
        with self.view._own(os.open(name, flags, dir_fd=parent)) as fd:
            _require(self.state(os.fstat(fd)) == row.state, 'service-view-member-identity')
            self._mount(fd, mount_id)
            if mount_root:
                required = os.ST_RDONLY | os.ST_NOSUID | os.ST_NODEV
                _require(os.fstatvfs(fd).f_flag & required == required, 'service-view-fd-flags')
            if row.kind == 'directory':
                expected = children[row.path]
                self._entries(fd, expected.keys())
                for child, path in expected.items():
                    self._member(fd, child, subtree[path], mount_id, subtree, children)
            if row.path in ('node', _CHROMIUM):
                _require(stat.S_ISREG(before.st_mode) and before.st_mode & 0o111 == 0o111
                         and not os.fstatvfs(fd).f_flag & os.ST_NOEXEC, 'service-view-executable')
            _require(self.state(os.fstat(fd)) == self.state(os.stat(name, dir_fd=parent, follow_symlinks=False))
                     == row.state, 'service-view-member-identity')

    def _bind(self, parent, name, leaf, mount_id, subtree):
        children = {path: {} for path, member in subtree.items() if member.kind == 'directory'}
        for path in subtree.keys() - {leaf}:
            ancestor, _, part = path.rpartition('/')
            _require(ancestor in children and part not in children[ancestor], 'service-view-stage-hierarchy')
            children[ancestor][part] = path
        self._member(parent, name, subtree[leaf], mount_id, subtree, children, mount_root=True)

    def auxiliary(self, run, cover_id, layout, rows, uid):
        births = {path: birth for path, kind, birth in layout.created if kind == 'directory'}

        def check_directory(parent, name, fd, mount_id, mode, owner, birth=None):
            self.view._check_clock(self.deadline)
            info = os.fstat(fd)
            _require(info.st_mode == stat.S_IFDIR | mode and info.st_uid == info.st_gid == owner
                     and (birth is None or (info.st_dev, info.st_ino) == birth)
                     and self.state(info) == self.state(os.stat(name, dir_fd=parent, follow_symlinks=False)),
                     'service-view-scratch-identity' if owner else 'service-view-home-mask')
            self._mount(fd, mount_id)

        for relative, (mount_id, _, _, _) in rows.items():
            self.view._check_clock(self.deadline)
            if '/' not in relative:
                with self.view._own(os.open(relative, _DIRECTORY, dir_fd=run)) as masked:
                    check_directory(run, relative, masked, mount_id, 0, 0)
            else:
                home, _, name = relative.partition('/')
                _require(home in births and relative in births and uid > 0, 'service-view-scratch-identity')
                with self.view._own(os.open(home, _DIRECTORY, dir_fd=run)) as home_fd:
                    check_directory(run, home, home_fd, cover_id, 0o700, uid, births[home])
                    with self.view._own(os.open(name, _DIRECTORY, dir_fd=home_fd)) as scratch:
                        check_directory(home_fd, name, scratch, mount_id, 0o700, uid, births[relative])
                        _require(not os.fstatvfs(scratch).f_flag & os.ST_RDONLY, 'service-view-scratch-writable')
                        check_directory(home_fd, name, scratch, mount_id, 0o700, uid, births[relative])
                    check_directory(run, home, home_fd, cover_id, 0o700, uid, births[home])

    def runtime(self, run, cover_id, layout, granted, projected, all_leaves):
        # The mode-000 placeholders are a separate exact inode census. Root
        # can inspect them, but no admitted service identity can use them.
        births = {path: (kind, birth) for path, kind, birth in layout.created}
        entries = {path: set() for path in _CONTAINERS}
        for path in (*_CONTAINERS[1:], *('runtime/' + leaf for leaf in all_leaves)):
            parent, _, name = path.rpartition('/')
            entries[parent].add(name)
        _require(births.keys() >= {*_CONTAINERS, *('runtime/' + leaf for leaf in all_leaves)},
                 'service-view-layout-census')

        def walk(folder, prefix):
            self._entries(folder, entries[prefix])
            for name in sorted(entries[prefix]):
                path = prefix + '/' + name
                leaf = path.removeprefix('runtime/')
                if leaf in granted:
                    self._bind(folder, name, leaf, granted[leaf][0], projected[leaf])
                else:
                    scaffold(folder, name, path)

        def scaffold(parent, name, path):
            self.view._check_clock(self.deadline)
            directory = path in entries or births[path][0] == 'directory'
            flags = _DIRECTORY if directory else _READ
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            _require((before.st_dev, before.st_ino) == births[path][1] and before.st_uid == before.st_gid == 0
                     and before.st_mode == ((stat.S_IFDIR if directory else stat.S_IFREG)
                                            | (0o711 if path in entries else 0))
                     and (directory or before.st_nlink == 1 and before.st_size == 0),
                     'service-view-placeholder')
            with self.view._own(os.open(name, flags, dir_fd=parent)) as fd:
                _require(self.state(os.fstat(fd)) == self.state(before), 'service-view-placeholder')
                self._mount(fd, cover_id)
                if path in entries:
                    walk(fd, path)
                elif directory:
                    self._entries(fd, set())
                _require(self.state(os.fstat(fd)) == self.state(os.stat(name, dir_fd=parent, follow_symlinks=False))
                         == self.state(before), 'service-view-placeholder')

        scaffold(run, 'runtime', 'runtime')


def observe_service_view(host, mounts, launch_view, launch_plan, installer, finalizer, *,
                         role, run_id, main, layout, stage_snapshot, clock):
    """Borrow the live main/stage/layout scopes.

    Driver and browser are held before their Node exec. The third role is
    observed as its fixed Python probe. The caller owns the manager invocation
    and any later grant.
    """
    _require(all(type(module) is ModuleType for module in (host, mounts, launch_view, launch_plan, installer, finalizer))
             and os.getresuid() == os.getresgid() == (0, 0, 0) and type(clock) is host.Deadline
             and type(role) is str and role in ('driver', 'browser', 'third') and type(run_id) is str
             and re.fullmatch(r'[1-9][0-9]{0,15}', run_id) and int(run_id) <= 9007199254740991,
             'service-view-input')
    frontier = 42 if role == 'third' else 32
    clock.remaining(frontier)
    deadline = clock.start + frontier
    _require(type(main) is tuple and len(main) == 3, 'service-view-main')
    pidfd, initial, current = main
    _require(type(pidfd) is int and pidfd > 2 and not os.get_inheritable(pidfd)
             and type(initial) is host._MainSnapshot and current() == initial, 'service-view-main')
    identity = initial.identity
    root = '/run/aihr-browser-capability-' + run_id
    uid = {'driver': host.DRIVER, 'browser': host.BROWSER, 'third': host.THIRD}[role]
    cgroup = f'0::/system.slice/aihrbc-{role}-{run_id}.service\n'.encode('ascii')
    expected = frozenset(launch_plan._ROLE_FILES[role])
    all_leaves = frozenset(leaf for leaves in launch_plan._ROLE_FILES.values() for leaf in leaves)
    projected = _stage_rows(finalizer, stage_snapshot, expected)
    journal = layout.inspect_fixed(role_deadline=deadline).journal
    _require(journal.pending is None and len(journal.created) == 19 and layout.run_id == run_id
             and layout.host is host and layout.mounts is mounts and layout.view is launch_view
             and installer._state(os.fstat(layout.stage)) == stage_snapshot.root_state, 'service-view-layout')
    with ExitStack() as held:
        own = launch_view._own
        clock.remaining(frontier)
        self_fdinfo = held.enter_context(own(os.open('/proc/self/fdinfo', _DIRECTORY)))
        pid_raw = launch_view._read_proc(self_fdinfo, str(pidfd), 4096, deadline)
        _require(re.findall(rb'^Pid:[ \t]+([1-9][0-9]{0,9})$', pid_raw, re.M) == [str(identity.pid).encode('ascii')],
                 'service-view-pidfd')
        proc = held.enter_context(own(os.open('/proc', _DIRECTORY)))
        proc_name = str(identity.pid)
        process = held.enter_context(own(os.open(proc_name, _DIRECTORY, dir_fd=proc)))
        proc_birth = host._main_birth(os.fstat(process))
        namespaces = held.enter_context(own(os.open('ns', _DIRECTORY, dir_fd=process)))
        mnt = held.enter_context(own(os.open('mnt', os.O_RDONLY | os.O_CLOEXEC, dir_fd=namespaces)))
        service_root = held.enter_context(own(os.open('root', _DIRECTORY & ~os.O_NOFOLLOW, dir_fd=process)))
        local_root = launch_view._root_directory(os.stat('/', follow_symlinks=False))
        chain = launch_view._walk_directories(held, service_root, (('run', None), (root.split('/')[-1], 0o711)), deadline)
        run = chain[-1][2]
        cover_id = launch_view._mount_id(self_fdinfo, chain[0][2], deadline)
        observer = _Readback(launch_view, installer, self_fdinfo, deadline)

        def topology():
            clock.remaining(frontier)
            _require(host._main_birth(os.fstat(process)) == proc_birth
                     == host._main_birth(os.stat(proc_name, dir_fd=proc, follow_symlinks=False))
                     and host._process_birth(launch_view._read_proc(process, 'stat', 8192, deadline), identity.pid)
                     == identity.start and launch_view._read_proc(process, 'cgroup', 8192, deadline) == cgroup,
                     'service-view-main')
            _require(host._main_birth(os.fstat(mnt)) == identity.namespaces[-1]
                     == host._main_birth(os.stat('mnt', dir_fd=namespaces)), 'service-view-namespace')
            _require(os.readlink('root', dir_fd=process) == '/'
                     and launch_view._root_directory(os.fstat(service_root)) == local_root
                     == launch_view._root_directory(os.stat('root', dir_fd=process)), 'service-view-root')
            launch_view._check_chain(chain)
            _require(host._main_birth(os.fstat(run)) == journal.run_birth
                     and installer._state(os.stat('launch-source', dir_fd=run, follow_symlinks=False))
                     == stage_snapshot.root_state, 'service-view-source-root')
            observer._mount(chain[0][2], cover_id)
            observer._mount(run, cover_id)
            raw = launch_view._read_proc(process, 'mountinfo', _MOUNTINFO_LIMIT, deadline)
            result = _runtime_mounts(mounts, raw, cover_id, root, expected, journal.run_birth[0], role)
            observer.auxiliary(run, cover_id, journal, result[1], uid)
            clock.remaining(frontier)
            return result

        granted, auxiliary = topology()
        observer.runtime(run, cover_id, journal, granted, projected, all_leaves)
        _require(topology() == (granted, auxiliary) and layout.inspect_fixed(role_deadline=deadline).journal == journal
                 and installer._state(os.fstat(layout.stage)) == stage_snapshot.root_state
                 and current() == initial, 'service-view-changed')
    clock.remaining(frontier)
    return ServiceView(role, identity.pid, identity.start, identity.namespaces[-1],
                       tuple((path, granted[path][0]) for path in sorted(granted)),
                       sum(len(subtree) for subtree in projected.values()))
