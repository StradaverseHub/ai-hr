"""Finalize the fixed synthetic source tree below an already held directory.

The protected caller owns the installer module, bound input bytes, stage mount
and all later cleanup. This leaf finalizes the private stage and verifies its
owned files.
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import stat
from contextlib import contextmanager
from types import ModuleType
from typing import NamedTuple


_NODE_MAX = 256 * 1024**2
_ROLE_MAX = 45947
_ROLES = ('native-workload-browser-driver.mjs', 'native-workload-browser-server.mjs',
          'native-workload-browser-host.py')


class BoundStageFile(NamedTuple):
    data: bytes
    sha256: str


class SealedStageMember(NamedTuple):
    path: str
    kind: str
    mode: int
    bytes: int
    sha256: str | None
    state: tuple


class SyntheticStageSnapshot(NamedTuple):
    root_state: tuple
    members: tuple[SealedStageMember, ...]


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _root_owned(info):
    return (os.getresuid() == os.getresgid() == (0, 0, 0)
            and (info.st_uid, info.st_gid) == (0, 0))


class _Stage:
    def __init__(self, installer, root, deadline):
        self.i, self.root, self.deadline = installer, root, deadline
        info = os.fstat(root)
        _require(_root_owned(info) and stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700,
                 'synthetic stage root differs')
        self.root_birth = installer._birth(info)
        self.created = []
        self.pending = None
        self.attempted = False

    def _left(self):
        self.i._PARSER.remaining(self.deadline)

    def _named(self, parent, name):
        return os.stat(name, dir_fd=parent, follow_symlinks=False)

    def _root(self):
        self._left()
        info = os.fstat(self.root)
        _require(self.i._birth(info) == self.root_birth, 'synthetic stage root changed')
        return self.i._state(info)

    def journal(self):
        """Only creations from this leaf. The archive journal remains separate."""
        return self.i.SyntheticToolJournal(self.root_birth[:2], tuple(self.created), self.pending)

    def _remember(self, fd, parent, name, path, kind, mode):
        info = os.fstat(fd)
        dev, ino, uid, gid, actual_mode = self.i._birth(info)
        _require(self.pending == (path, kind)
                 and (dev, uid, gid, actual_mode) == (self.root_birth[0], *self.root_birth[2:4], mode)
                 and (kind == 'directory' or (info.st_nlink, info.st_size) == (1, 0))
                 and self.i._state(info) == self.i._state(self._named(parent, name)),
                 'synthetic stage creation differs')
        self.created.append((path, kind, (dev, ino)))
        self.pending = None
        return info

    def _seal(self, fd, parent, name, before, mode):
        state = self.i._state
        _require(state(os.fstat(fd)) == before == state(self._named(parent, name)), 'synthetic stage mode input changed')
        self._left()
        os.fchmod(fd, mode)
        after = state(os.fstat(fd))
        _require(after[0][:4] == before[0][:4] and after[1:4] == before[1:4]
                 and after[0][4] == stat.S_IFMT(before[0][4]) | mode
                 and state(self._named(parent, name)) == after, 'synthetic stage mode readback differs')
        self._left()
        return after

    def _inventory(self, members, *, seal=False):
        children = {'': {}}
        for row in members:
            parent, _, name = row.path.rpartition('/')
            _require(parent in children and name not in children[parent], 'synthetic stage tree shape differs')
            children[parent][name] = row
            if row.kind == 'directory':
                children[row.path] = {}
        actual = {}
        state = self.i._state

        def walk(folder, relative, before):
            expected = children[relative]
            found = set()
            with os.scandir(folder) as entries:
                for entry in entries:
                    self._left()
                    _require(entry.name in expected and entry.name not in found, 'synthetic stage tree membership differs')
                    found.add(entry.name)
            _require(found == expected.keys(), 'synthetic stage tree membership differs')
            for name in sorted(expected):
                self._left()
                row = expected[name]
                _require(state(self._named(folder, name)) == row.state, 'synthetic stage member identity changed')
                flags = self.i._DIR if row.kind == 'directory' else self.i._READ
                with self.i._fd(os.open(name, flags, dir_fd=folder)) as fd:
                    _require(state(os.fstat(fd)) == row.state, 'synthetic stage opened different member')
                    if row.kind == 'directory':
                        walk(fd, row.path, row.state)
                    observed = self._seal(fd, folder, name, row.state, row.mode) if seal else row.state
                    _require(state(os.fstat(fd)) == observed == state(self._named(folder, name)),
                             'synthetic stage member readback differs')
                    actual[row.path] = row._replace(state=observed)
            _require(state(os.fstat(folder)) == before, 'synthetic stage directory changed')

        root_state = self._root()
        with self.i._fd(os.open('.', self.i._DIR, dir_fd=self.root)) as scan:
            _require(state(os.fstat(scan)) == root_state, 'synthetic stage opened different root')
            walk(scan, '', root_state)
        _require(self._root() == root_state, 'synthetic stage root changed')
        return SyntheticStageSnapshot(root_state, tuple(actual[path] for path in sorted(actual)))

    def _tool_members(self, tools, journal):
        i = self.i
        _require(type(tools) is i.SyntheticToolchain and type(journal) is i.SyntheticToolJournal
                 and journal.pending is None and journal.root_birth == self.root_birth[:2]
                 and tools.root_state == self._root()
                 and type(tools.members) is type(tools.member_states) is type(journal.created) is tuple
                 and len(tools.members) == len(tools.member_states) == len(journal.created) == i._SYNTHETIC_ENTRIES,
                 'synthetic stage archive input differs')
        created = {path: (kind, birth) for path, kind, birth in journal.created}
        members = []
        previous = ''
        for row, (path, state) in zip(tools.members, tools.member_states, strict=True):
            _require(type(row) is i.StagedMember and path == row.path and path > previous
                     and (path == 'chromium' or path.startswith('chromium/') or path == 'node_modules'
                          or any(path == prefix or path.startswith(prefix + '/') for prefix in (
                              'node_modules/playwright', 'node_modules/playwright-core'))),
                     'synthetic stage archive path differs')
            previous = path
            dev, ino, uid, gid, mode = state[0]
            _require((dev, uid, gid) == (self.root_birth[0], *self.root_birth[2:4])
                     and created.get(path) == (row.kind, (dev, ino)), 'synthetic stage archive birth differs')
            i._PARSER.relative_path(path.encode('ascii'), path.split('/', 1)[0].encode('ascii'),
                                    directory=row.kind == 'directory')
            if row.kind == 'directory':
                valid = stat.S_ISDIR(mode) and row.staged_mode == 0o700 and row.archive_mode == 0o555 \
                    and row.bytes == 0 and row.sha256 is None
            else:
                valid = row.kind == 'file' and stat.S_ISREG(mode) and row.staged_mode == 0o600 \
                    and row.archive_mode in (0o444, 0o555) and state[1:3] == (1, row.bytes) \
                    and type(row.sha256) is str and re.fullmatch(r'[0-9a-f]{64}', row.sha256)
            _require(valid and stat.S_IMODE(mode) == row.staged_mode, 'synthetic stage archive member differs')
            members.append(SealedStageMember(path, row.kind, row.archive_mode, row.bytes, row.sha256, state))
        rows = [(row.path, row.kind, row.mode, row.bytes, row.sha256) for row in members]
        _require(len(created) == len(members) and sum(row.bytes for row in members) == i._SYNTHETIC_BYTES
                 and hashlib.sha256(i._PARSER.canonical(rows)).hexdigest() == i._SYNTHETIC_SHA,
                 'synthetic stage archive census differs')
        return members

    def _file(self, folder, prefix, name, bound, mode):
        path = prefix + name
        state = self.i._state
        self._left()
        self.pending = (path, 'file')
        with self.i._fd(os.open(name, self.i._WRITE, 0o600, dir_fd=folder)) as fd:
            info = self._remember(fd, folder, name, path, 'file', stat.S_IFREG | 0o600)
            data = memoryview(bound.data)
            while data:
                self._left()
                size = min(len(data), self.i._PARSER.CHUNK)
                count = os.write(fd, data[:size])
                _require(0 < count <= size, 'synthetic stage write differs')
                data = data[count:]
            before = state(os.fstat(fd))
            _require(before[0] == self.i._birth(info) and before[1:3] == (1, len(bound.data))
                     and state(self._named(folder, name)) == before, 'synthetic stage written file differs')
        digest = hashlib.sha256()
        with self.i._fd(os.open(name, self.i._READ, dir_fd=folder)) as fd:
            _require(state(os.fstat(fd)) == before, 'synthetic stage readback opened different file')
            remaining = len(bound.data)
            while remaining:
                self._left()
                block = os.read(fd, min(remaining, self.i._PARSER.CHUNK))
                _require(bool(block), 'synthetic stage readback truncated')
                digest.update(block)
                remaining -= len(block)
            self._left()
            _require(os.read(fd, 1) == b'' and digest.hexdigest() == bound.sha256, 'synthetic stage content differs')
            after = self._seal(fd, folder, name, before, mode)
        return SealedStageMember(path, 'file', mode, len(bound.data), bound.sha256, after)

    def finalize(self, tools, journal, *, node, driver, browser, probe):
        _require(self.root is not None and not self.attempted, 'synthetic stage is not fresh')
        self.attempted = True
        roles = (driver, browser, probe)
        _require(all(type(bound) is BoundStageFile and type(bound.data) is bytes and bound.data
                     and type(bound.sha256) is str and re.fullmatch(r'[0-9a-f]{64}', bound.sha256)
                     for bound in (node, *roles))
                 and len(node.data) <= _NODE_MAX and node.data.startswith(b'\x7fELF')
                 and sum(len(bound.data) for bound in roles) <= _ROLE_MAX, 'synthetic stage bound input differs')
        members = list(self._inventory(self._tool_members(tools, journal), seal=True).members)
        _require(self._root() == tools.root_state, 'synthetic stage root changed before adding inputs')
        members.append(self._file(self.root, '', 'node', node, 0o555))
        self._left()
        self.pending = ('roles', 'directory')
        os.mkdir('roles', 0o700, dir_fd=self.root)
        with self.i._fd(os.open('roles', self.i._DIR, dir_fd=self.root)) as fd:
            self._remember(fd, self.root, 'roles', 'roles', 'directory', stat.S_IFDIR | 0o700)
            for name, bound in zip(_ROLES, roles, strict=True):
                members.append(self._file(fd, 'roles/', name, bound, 0o444))
            observed = self._seal(fd, self.root, 'roles', self.i._state(os.fstat(fd)), 0o555)
            members.append(SealedStageMember('roles', 'directory', 0o555, 0, None, observed))
        return self._inventory(sorted(members), seal=False)


@contextmanager
def synthetic_stage(installer, root_fd, deadline):
    """Use only the exact protected installer module and current held stage FD."""
    _require(type(installer) is ModuleType and type(root_fd) is int and root_fd > 2
             and not os.get_inheritable(root_fd) and type(deadline) in (int, float) and math.isfinite(deadline),
             'held synthetic stage input required')
    installer._PARSER.remaining(deadline)
    with installer._fd(os.dup(root_fd)) as owned:
        stage = _Stage(installer, owned, deadline)
        try:
            yield stage
        finally:
            stage.root = None
    installer._PARSER.remaining(deadline)
