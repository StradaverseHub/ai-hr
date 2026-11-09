"""Fixed host-side targets for dormant synthetic browser roles.

The protected caller owns the run parent, role credential census and any
future manager submission. This owner only removes its own settled layout and
never starts services.
"""

import math
import os
import re
import stat
import time
from contextlib import ExitStack, contextmanager
from typing import NamedTuple


_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE = os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
_ENTRIES, _BYTES = 19, 72
_PREPARATION, _ACTIVE, _CLEANUP = 180, 255, 285
_VIEW_MAX = 180
_SCRATCH = frozenset(('driver-home/scratch', 'browser-home/scratch'))


class _Target(NamedTuple):
    path: str
    mode: int
    uid: int
    data: bytes | None


class RuntimeLayoutJournal(NamedTuple):
    run_birth: tuple[int, int]
    created: tuple[tuple[str, str, tuple[int, int]], ...]
    pending: tuple[str, str] | None


class RuntimeLayoutSnapshot(NamedTuple):
    journal: RuntimeLayoutJournal
    driver_credential: tuple[str, bytes]
    scratch_verified_empty: bool


class _Observation(NamedTuple):
    mount: int
    deadline: float


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _targets(run_id):
    return (
        _Target('runtime', 0o711, 0, None),
        _Target('runtime/roles', 0o711, 0, None),
        _Target('runtime/node_modules', 0o711, 0, None),
        _Target('runtime/chromium', 0o711, 0, None),
        _Target('runtime/node_modules/playwright', 0, 0, None),
        _Target('runtime/node_modules/playwright-core', 0, 0, None),
        _Target('runtime/chromium/chrome-headless-shell-linux64', 0, 0, None),
        _Target('runtime/node', 0, 0, b''),
        _Target('runtime/roles/native-workload-browser-driver.mjs', 0, 0, b''),
        _Target('runtime/roles/native-workload-browser-server.mjs', 0, 0, b''),
        _Target('runtime/roles/native-workload-browser-host.py', 0, 0, b''),
        _Target('driver-home', 0o700, 62120, None),
        _Target('driver-home/scratch', 0o700, 62120, None),
        _Target('driver-home/canary', 0o400, 62120, b'driver-canary\n'),
        _Target('browser-home', 0o700, 62121, None),
        _Target('browser-home/scratch', 0o700, 62121, None),
        _Target('browser-home/canary', 0o400, 62121, b'browser-canary\n'),
        _Target('private', 0o700, 0, None),
        _Target('private/observer', 0o400, 0, b'aihr-browser-isolation-v1:' + run_id.encode('ascii') + b'\n'),
    )


def _birth(info):
    return info.st_dev, info.st_ino


def _metadata(info):
    return (*_birth(info), info.st_mode, info.st_uid, info.st_gid)


def _file_state(info):
    return (*_metadata(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _named(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)


def _absent(parent, name):
    try:
        _named(parent, name)
    except FileNotFoundError:
        return True
    return False


class _Layout:
    def __init__(self, held, launch_view, host, mounts, run_id, run, stage, fdinfo, course_started):
        self.held, self.view, self.host, self.mounts = held, launch_view, host, mounts
        self.run_id, self.run, self.stage, self.fdinfo = run_id, run, stage, fdinfo
        self.root = '/run/aihr-browser-capability-' + run_id
        self._preparation = course_started + _PREPARATION
        self._active = course_started + _ACTIVE
        self._cleanup = course_started + _CLEANUP
        self.run_state, self.stage_state = _metadata(os.fstat(run)), _metadata(os.fstat(stage))
        self.targets = _targets(run_id)
        self.by_path = {row.path: row for row in self.targets}
        self.opened, self.created = {}, {}
        self.pending = None
        self.attempted = self.ready = False
        self.disposal_attempted = False

    def _left(self, deadline):
        _require(self.held is not None and time.monotonic() < deadline, 'runtime-layout-deadline-or-closed')

    def _mount(self, fd, observation):
        _require(self.view._mount_id(self.fdinfo, fd, observation.deadline) == observation.mount,
                 'runtime-layout-mount')

    def _scope(self, observation):
        self._left(observation.deadline)
        _require(not os.get_inheritable(self.run) and not os.get_inheritable(self.stage)
                 and self.run_state == _metadata(os.fstat(self.run))
                 == _metadata(os.stat(self.root, follow_symlinks=False))
                 and self.stage_state == _metadata(os.fstat(self.stage))
                 == _metadata(_named(self.run, 'launch-source')),
                 'runtime-layout-run-scope')
        self._mount(self.run, observation)
        self._mount(self.stage, observation)

    @contextmanager
    def _admit(self, frontier, prepare=False):
        self._left(frontier)
        # Keep the unchanged launch view's per-read limit inside the absolute phase.
        deadline = min(frontier, time.monotonic() + _VIEW_MAX)
        with self.view.held_launch_source(self.host, self.mounts, run_id=self.run_id, stage_fd=self.stage,
                                          planned_bytes=_BYTES if prepare else 0,
                                          planned_entries=_ENTRIES if prepare else 0, deadline=deadline) as view:
            _require(view.path == self.root + '/launch-source' and view.backing_birth == self.stage_state[:2],
                     'runtime-layout-stage-view')
            observation = _Observation(view.local_mount_id, deadline)
            self._scope(observation)
            yield observation
            self._scope(observation)
        self._left(deadline)

    def journal(self):
        return RuntimeLayoutJournal(self.run_state[:2], tuple(self.created.values()), self.pending)

    def _parent(self, path, observation):
        self._scope(observation)
        *parts, name = path.split('/')
        parent = self.run
        prefix = ''
        for part in parts:
            prefix += ('/' if prefix else '') + part
            fd = self.opened[prefix]
            info = os.fstat(fd)
            _require(stat.S_ISDIR(info.st_mode) and self.created[prefix][2] == _birth(info)
                     and _metadata(info) == _metadata(_named(parent, part)), 'runtime-layout-parent')
            self._mount(fd, observation)
            parent = fd
        return parent, name

    def _create(self, target, observation):
        parent, name = self._parent(target.path, observation)
        directory = target.data is None
        kind = 'directory' if directory else 'file'
        _require(_absent(parent, name), 'runtime-layout-target-exists')
        self._left(self._preparation)
        self.pending = (target.path, kind)
        if directory:
            os.mkdir(name, 0o700, dir_fd=parent)
            self._left(self._preparation)
            fd = self.held.enter_context(self.view._own(os.open(name, _DIRECTORY, dir_fd=parent)))
        else:
            fd = self.held.enter_context(self.view._own(os.open(name, _FILE, 0o600, dir_fd=parent)))
        info = os.fstat(fd)
        _require(info.st_dev == self.run_state[0] and info.st_uid == info.st_gid == 0
                 and _metadata(info) == _metadata(_named(parent, name))
                 and (stat.S_ISDIR(info.st_mode) if directory
                      else stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 0),
                 'runtime-layout-created-birth')
        self._mount(fd, observation)
        self.opened[target.path] = fd
        self.created[target.path] = (target.path, kind, _birth(info))
        self.pending = None
        if target.data:
            self._left(self._preparation)
            _require(os.write(fd, target.data) == len(target.data), 'runtime-layout-short-write')
        self._left(self._preparation)

    def _check(self, target, observation, sealed=True):
        parent, name = self._parent(target.path, observation)
        fd = self.opened[target.path]
        self._mount(fd, observation)
        info, named = os.fstat(fd), _named(parent, name)
        _require(_metadata(info) == _metadata(named) and _birth(info) == self.created[target.path][2]
                 and stat.S_IFMT(info.st_mode) == (stat.S_IFDIR if target.data is None else stat.S_IFREG),
                 'runtime-layout-member-birth')
        if sealed:
            _require((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid) == (target.mode, target.uid, target.uid),
                     'runtime-layout-member-metadata')
        if target.data is not None:
            before = _file_state(info)
            self._left(observation.deadline)
            _require(info.st_nlink == 1 and info.st_size == len(target.data) and before == _file_state(named)
                     and os.pread(fd, len(target.data) + 1, 0) == target.data
                     and before == _file_state(os.fstat(fd)) == _file_state(_named(parent, name)),
                     'runtime-layout-member-content')
        return fd

    def _inspect(self, observation, empty_scratch):
        expected = {row.path: set() for row in self.targets if row.data is None}
        for row in self.targets:
            parent, _, name = row.path.rpartition('/')
            if parent:
                expected[parent].add(name)
        for row in self.targets:
            fd = self._check(row, observation)
            if row.data is None and (empty_scratch or row.path not in _SCRATCH):
                found = set()
                # Each scan stops at the first foreign child and never opens it.
                self._left(observation.deadline)
                _require(os.lseek(fd, 0, os.SEEK_SET) == 0, 'runtime-layout-directory-offset')
                self._left(observation.deadline)
                with os.scandir(fd) as entries:
                    while True:
                        self._left(observation.deadline)
                        entry = next(entries, None)
                        if entry is None:
                            break
                        self._left(observation.deadline)
                        _require(entry.name in expected[row.path] and entry.name not in found,
                                 'runtime-layout-foreign-child')
                        found.add(entry.name)
                _require(found == expected[row.path], 'runtime-layout-member-census')
                self._check(row, observation)
        self._left(observation.deadline)
        return RuntimeLayoutSnapshot(self.journal(), (self.root + '/private/observer', self.by_path['private/observer'].data),
                                     empty_scratch)

    def prepare(self):
        self._left(self._preparation)
        _require(not self.attempted, 'runtime-layout-attempted')
        self.attempted = True
        _require(len(self.targets) == _ENTRIES and sum(len(row.data or b'') for row in self.targets) <= _BYTES,
                 'runtime-layout-size')
        with self._admit(self._preparation, prepare=True) as observation:
            _require(all(_absent(self.run, row.path) for row in self.targets if '/' not in row.path),
                     'runtime-layout-target-exists')
            for row in self.targets:
                self._create(row, observation)
            for row in reversed(self.targets):
                fd = self._check(row, observation, sealed=False)
                if row.uid:
                    self._left(self._preparation)
                    os.fchown(fd, row.uid, row.uid)
                self._left(self._preparation)
                os.fchmod(fd, row.mode)
                self._check(row, observation)
            result = self._inspect(observation, empty_scratch=True)
        self.ready = True
        return result

    def inspect_fixed(self, *, role_deadline=None):
        """Recheck fixed births by the earlier absolute role or course deadline."""
        _require(self.ready, 'runtime-layout-not-ready')
        frontier = self._active
        if role_deadline is not None:
            _require(type(role_deadline) in (int, float) and 0 < role_deadline < math.inf,
                     'runtime-layout-role-deadline')
            frontier = min(frontier, role_deadline)
        with self._admit(frontier) as observation:
            return self._inspect(observation, empty_scratch=False)

    def inspect_empty(self):
        """Read-only pre-removal facts; the actual role owner must prove settlement."""
        _require(self.ready, 'runtime-layout-not-ready')
        with self._admit(self._cleanup) as observation:
            return self._inspect(observation, empty_scratch=True)

    def _require_run_entries(self, observation, expected):
        self._scope(observation)
        self._left(observation.deadline)
        _require(os.lseek(self.run, 0, os.SEEK_SET) == 0, 'runtime-layout-directory-offset')
        self._left(observation.deadline)
        found = set()
        with os.scandir(self.run) as entries:
            for _ in range(len(expected) + 1):
                self._left(observation.deadline)
                entry = next(entries, None)
                if entry is None:
                    break
                _require(entry.name in expected and entry.name not in found, 'runtime-layout-foreign-run-child')
                found.add(entry.name)
        _require(found == expected, 'runtime-layout-run-census')
        self._scope(observation)

    def dispose(self, *, cleanup_deadline):
        """Remove the sealed layout after the protected caller proves role settlement.

        The caller must hold exclusive layout mutation authority throughout and
        independently prove no role ever started or that all roles and their
        mounts have settled. A partial preparation or failed removal retains
        the original birth journal. This method never removes the run or stage.
        """
        _require(type(cleanup_deadline) in (int, float) and 0 < cleanup_deadline < math.inf,
                 'runtime-layout-cleanup-deadline')
        frontier = min(self._cleanup, cleanup_deadline)
        self._left(frontier)
        _require(not self.disposal_attempted, 'runtime-layout-disposal-attempted')
        _require(self.ready and self.pending is None and len(self.created) == _ENTRIES
                 and self.created.keys() == self.opened.keys() == self.by_path.keys(),
                 'runtime-layout-disposal-journal')
        self.disposal_attempted = True
        self.ready = False
        with self._admit(frontier) as observation:
            stage_only = {'launch-source'}
            expected = stage_only | {row.path for row in self.targets if '/' not in row.path}
            self._require_run_entries(observation, expected)
            self._inspect(observation, empty_scratch=True)
            for row in reversed(self.targets):
                parent, name = self._parent(row.path, observation)
                fd = self._check(row, observation)
                self._left(observation.deadline)
                if row.data is None:
                    os.rmdir(name, dir_fd=parent)
                else:
                    os.unlink(name, dir_fd=parent)
                self._left(observation.deadline)
                _require(os.fstat(fd).st_nlink == 0 and _absent(parent, name),
                         'runtime-layout-disposal-settlement')
            self._require_run_entries(observation, stage_only)
        return len(self.targets)


@contextmanager
def held_runtime_layout(launch_view, host, mounts, *, run_id, run_fd, stage_fd, course_started):
    """Borrow protected descriptors and the controller's original monotonic course origin.

    The same origin governs fixture preparation, active work and cleanup. The
    role caller still owns its earlier role-local frontiers and settlement.
    """
    _require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id)
             and int(run_id) <= 9007199254740991, 'runtime-layout-run-id')
    now = time.monotonic()
    _require(os.getresuid() == os.getresgid() == (0, 0, 0) and type(course_started) in (float, int)
             and math.isfinite(course_started) and 0 < course_started <= now < course_started + _PREPARATION,
             'runtime-layout-root-or-deadline')
    _require(all(type(fd) is int and fd > 2 and not os.get_inheritable(fd) for fd in (run_fd, stage_fd))
             and run_fd != stage_fd, 'runtime-layout-descriptors')
    run, stage = os.fstat(run_fd), os.fstat(stage_fd)
    _require(run.st_dev == stage.st_dev and run.st_uid == run.st_gid == stage.st_uid == stage.st_gid == 0
             and run.st_mode == stat.S_IFDIR | 0o711 and stage.st_mode == stat.S_IFDIR | 0o700,
             'runtime-layout-root-metadata')
    with ExitStack() as held:
        fdinfo = held.enter_context(launch_view._own(os.open('/proc/self/fdinfo', _DIRECTORY)))
        layout = _Layout(held, launch_view, host, mounts, run_id, run_fd, stage_fd, fdinfo, course_started)
        try:
            yield layout
        finally:
            layout.held = None
