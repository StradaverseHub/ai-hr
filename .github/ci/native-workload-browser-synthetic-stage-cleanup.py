"""Settle only the exact synthetic launch-source tree after issuer closure.

The protected caller owns the run parent, the stage FD and both genuine
journals. Before calling, it must prove no service can retain this stage.
This leaf neither launches nor settles a service or deletes the run parent.
"""
from __future__ import annotations

import math
import os
import re
import stat
from types import ModuleType


_STAGE = 'launch-source'
_ROLES = ('roles/native-workload-browser-driver.mjs', 'roles/native-workload-browser-server.mjs',
          'roles/native-workload-browser-host.py')
_ADDITIONS = {'node': 'file', 'roles': 'directory', **dict.fromkeys(_ROLES, 'file')}
_ARCHIVE_ROOTS = ('chromium', 'node_modules/playwright', 'node_modules/playwright-core')


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _valid_birth(birth):
    return (type(birth) is tuple and len(birth) == 2 and all(type(part) is int for part in birth)
            and birth[0] >= 0 and birth[1] > 0)


def _root_owned(info):
    return (os.getresuid() == os.getresgid() == (0, 0, 0)
            and (info.st_uid, info.st_gid) == (0, 0))


def _named(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)


def _absent(parent, name):
    try:
        _named(parent, name)
    except FileNotFoundError:
        return True
    return False


def _journal_entries(installer, initial_birth, archives, additions):
    expected = {}
    births = {initial_birth}
    for index, (journal, maximum) in enumerate(((archives, installer._SYNTHETIC_ENTRIES),
                                                 (additions, len(_ADDITIONS)))):
        _require(type(journal) is installer.SyntheticToolJournal and journal.root_birth == initial_birth
                 and journal.pending is None and type(journal.created) is tuple and len(journal.created) <= maximum,
                 'synthetic cleanup journal is incomplete')
        for entry in journal.created:
            _require(type(entry) is tuple and len(entry) == 3, 'synthetic cleanup journal entry differs')
            path, kind, birth = entry
            _require(type(path) is str and 0 < len(path) <= 276 and kind in ('directory', 'file')
                     and _valid_birth(birth) and birth[0] == initial_birth[0]
                     and path not in expected and birth not in births, 'synthetic cleanup journal entry differs')
            parts = path.split('/')
            _require(len(parts) <= 13 and all(p not in ('.', '..') and re.fullmatch(r'[A-Za-z0-9._+@-]+', p) for p in parts),
                     'synthetic cleanup journal path differs')
            if index == 0:
                allowed = path == 'node_modules' and kind == 'directory' or any(
                    path == root and kind == 'directory' or path.startswith(root + '/') for root in _ARCHIVE_ROOTS)
            else:
                allowed = _ADDITIONS.get(path) == kind
            _require(allowed, 'synthetic cleanup journal path differs')
            expected[path] = (kind, birth)
            births.add(birth)
    for path in expected:
        parent, _, _ = path.rpartition('/')
        _require(not parent or parent in expected and expected[parent][0] == 'directory',
                 'synthetic cleanup journal parent differs')
    return expected


class _Cleanup:
    def __init__(self, installer, view_module, fdinfo, run, stage, birth, deadline):
        self.i, self.views, self.fdinfo = installer, view_module, fdinfo
        self.run, self.stage, self.birth, self.deadline = run, stage, birth, deadline
        self.captured = {}
        self.children = {}

    def left(self):
        self.i._PARSER.remaining(self.deadline)

    def _mount(self, fd, mount_id):
        _require(self.views._mount_id(self.fdinfo, fd, self.deadline) == mount_id,
                 'synthetic cleanup member mount differs')

    def _scope(self, mount_id):
        self.left()
        run = os.fstat(self.run)
        stage = os.fstat(self.stage)
        state = self.i._state
        _require(_root_owned(run) and _root_owned(stage) and run.st_dev == stage.st_dev
                 and run.st_mode == stat.S_IFDIR | 0o711 and stage.st_mode == stat.S_IFDIR | 0o700
                 and self.i._birth(stage)[:2] == self.birth and state(_named(self.run, _STAGE)) == state(stage),
                 'synthetic cleanup held scope differs')
        self._mount(self.run, mount_id)
        self._mount(self.stage, mount_id)
        with self.i._fd(os.open('..', self.i._DIR, dir_fd=self.stage)) as actual_parent:
            _require(state(os.fstat(actual_parent)) == state(run), 'synthetic cleanup stage parent differs')
            self._mount(actual_parent, mount_id)
        _require(state(os.fstat(self.run)) == state(run) and state(os.fstat(self.stage)) == state(stage)
                 == state(_named(self.run, _STAGE)), 'synthetic cleanup held scope changed')
        self.left()
        return state(stage)

    def _entry(self, path, info, expected):
        kind, birth = expected
        mode = stat.S_IMODE(info.st_mode)
        if kind == 'directory':
            valid = stat.S_ISDIR(info.st_mode) and mode in (0o700, 0o555)
        else:
            modes = (0o600, 0o555) if path == 'node' else (0o600, 0o444) if path in _ROLES else (0o600, 0o444, 0o555)
            valid = stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size >= 0 and mode in modes
        _require(valid and _root_owned(info) and self.i._birth(info)[:2] == birth,
                 'synthetic cleanup member identity differs')

    def scan(self, fd, prefix, mount_id, expected):
        state = self.i._state
        before = state(os.fstat(fd))
        names = []
        self.children[prefix] = names
        with os.scandir(fd) as entries:
            for entry in entries:
                self.left()
                name = entry.name
                path = prefix + '/' + name if prefix else name
                _require(path in expected and path not in self.captured, 'synthetic cleanup foreign entry')
                info = _named(fd, name)
                self._entry(path, info, expected[path])
                kind, _ = expected[path]
                observed = state(info)
                self.captured[path] = observed
                names.append(name)
                flags = self.i._DIR if kind == 'directory' else self.i._READ
                with self.i._fd(os.open(name, flags, dir_fd=fd)) as child:
                    self._mount(child, mount_id)
                    _require(state(os.fstat(child)) == observed, 'synthetic cleanup opened different member')
                    if kind == 'directory':
                        self.scan(child, path, mount_id, expected)
                    _require(state(os.fstat(child)) == observed == state(_named(fd, name)),
                             'synthetic cleanup member changed during census')
        _require(state(os.fstat(fd)) == before, 'synthetic cleanup directory changed during census')

    def remove(self, fd, prefix, mount_id):
        state = self.i._state
        for name in self.children[prefix]:
            self.left()
            path = prefix + '/' + name if prefix else name
            before = self.captured[path]
            _require(state(_named(fd, name)) == before, 'synthetic cleanup member changed before removal')
            directory = stat.S_ISDIR(before[0][4])
            flags = self.i._DIR if directory else self.i._READ
            with self.i._fd(os.open(name, flags, dir_fd=fd)) as child:
                self._mount(child, mount_id)
                _require(state(os.fstat(child)) == before, 'synthetic cleanup opened different member')
                if directory:
                    self.remove(child, path, mount_id)
                    _require(self.i._birth(os.fstat(child)) == before[0] == self.i._birth(_named(fd, name)),
                             'synthetic cleanup directory changed before removal')
                    self.left()
                    os.rmdir(name, dir_fd=fd)
                else:
                    _require(state(os.fstat(child)) == before == state(_named(fd, name)),
                             'synthetic cleanup file changed before removal')
                    self.left()
                    os.unlink(name, dir_fd=fd)
                _require(os.fstat(child).st_nlink == 0 and _absent(fd, name), 'synthetic cleanup member still present')
            del self.captured[path]

    def empty(self, mount_id):
        before = self._scope(mount_id)
        with self.i._fd(os.open('.', self.i._DIR, dir_fd=self.stage)) as fd:
            self._mount(fd, mount_id)
            _require(self.i._state(os.fstat(fd)) == before, 'synthetic cleanup opened different root')
            with os.scandir(fd) as entries:
                _require(next(entries, None) is None, 'synthetic cleanup stage not empty')
        _require(self._scope(mount_id) == before, 'synthetic cleanup empty stage changed')
        return before


def dispose_synthetic_stage(installer, launch_view, host, mounts, *, run_id, run_fd, stage_fd,
                            initial_birth, archives, additions, deadline):
    """Remove only the fixed launch-source name and its known held creations."""
    _require(type(installer) is type(launch_view) is ModuleType and _valid_birth(initial_birth)
             and type(deadline) in (int, float) and math.isfinite(deadline)
             and all(type(fd) is int and fd > 2 and not os.get_inheritable(fd) for fd in (run_fd, stage_fd))
             and run_fd != stage_fd,
             'synthetic cleanup held input required')
    installer._PARSER.remaining(deadline)
    expected = _journal_entries(installer, initial_birth, archives, additions)
    with installer._fd(os.open('/proc/self/fdinfo', installer._DIR)) as fdinfo:
        owned = _Cleanup(installer, launch_view, fdinfo, run_fd, stage_fd, initial_birth, deadline)
        with launch_view.held_launch_source(host, mounts, run_id=run_id, stage_fd=stage_fd, planned_bytes=0,
                                            planned_entries=0, deadline=deadline) as observed:
            _require(observed.backing_birth == initial_birth, 'synthetic cleanup view birth differs')
            mount_id = observed.local_mount_id
            before = owned._scope(mount_id)
            with installer._fd(os.open('.', installer._DIR, dir_fd=stage_fd)) as scan:
                owned._mount(scan, mount_id)
                _require(installer._state(os.fstat(scan)) == before, 'synthetic cleanup opened different root')
                owned.scan(scan, '', mount_id, expected)
            byte_count = sum(value[2] for value in owned.captured.values() if stat.S_ISREG(value[0][4]))
            _require(owned.captured.keys() == expected.keys() and owned._scope(mount_id) == before
                     and byte_count <= installer._SYNTHETIC_BYTES + 256 * 1024**2 + 45947,
                     'synthetic cleanup census differs')
            owned.remove(stage_fd, '', mount_id)
            _require(not owned.captured, 'synthetic cleanup entries remain')
            empty = owned.empty(mount_id)
        # Normal view exit still needs the exact stage named in both namespaces.
        # Remove that one name only after its positive recheck and fresh local check.
        _require(owned.empty(mount_id) == empty, 'synthetic cleanup root changed after view closure')
        owned.left()
        os.rmdir(_STAGE, dir_fd=run_fd)
        _require(os.fstat(stage_fd).st_nlink == 0 and _absent(run_fd, _STAGE), 'synthetic cleanup root still present')
    installer._PARSER.remaining(deadline)
    return len(expected)
