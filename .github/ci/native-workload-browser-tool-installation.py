"""Materialize only the strict toolchain into an already held private tree.

The caller owns exclusive custody of the empty directory and immutable input
archives throughout the operation. Refusal can leave private, nonexecutable
output. The caller must settle that tree. This leaf does not publish it.
"""
from __future__ import annotations

import hashlib
import math
import os
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import NamedTuple


_parser_path = Path(__file__).with_name('native-workload-browser-toolchain.py')
_PARSER = ModuleType('aihr_private_toolchain_archive')
_PARSER.__file__ = str(_parser_path)
sys.modules[_PARSER.__name__] = _PARSER
exec(compile(_parser_path.read_bytes(), str(_parser_path), 'exec', dont_inherit=True), _PARSER.__dict__)

_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
_WRITE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
_PACKAGES = ('playwright', 'playwright-core', 'postgres')
_MAX_ENTRIES = 2 + _PARSER.ZIP_COUNT_MAX + _PARSER.PACKAGE_COUNT_MAX
_SYNTHETIC_ENTRIES = 504
_SYNTHETIC_BYTES = 291895066
_SYNTHETIC_SHA = '27bc563027c1750df1e4fcb0ff252f972b20d7ac8772e4563da8435acf4e9a8a'


class StagedMember(NamedTuple):
    path: str
    kind: str
    staged_mode: int
    bytes: int
    sha256: str | None
    archive_mode: int


class SyntheticToolJournal(NamedTuple):
    root_birth: tuple[int, int]
    created: tuple[tuple[str, str, tuple[int, int]], ...]
    pending: tuple[str, str] | None


class SyntheticToolchain(NamedTuple):
    members: tuple[StagedMember, ...]
    root_state: tuple
    member_states: tuple[tuple[str, tuple], ...]


def _birth(info):
    return info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode


def _state(info):
    return _birth(info), info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@contextmanager
def _fd(fd):
    try:
        yield fd
    except BaseException as error:
        try:
            os.close(fd)
        except OSError:
            error.add_note('Private tool descriptor close also refused')
        raise
    else:
        os.close(fd)


class _PrivateTree:
    def __init__(self, root, deadline):
        self.root, self.deadline = root, deadline
        self.owner = os.geteuid(), os.getegid()
        info = os.fstat(root)
        self.device = info.st_dev
        self.directories = {'': _birth(info)}
        self.files = {}
        self._created = None  # Only the fixed synthetic scope retains a creation journal.
        self._metadata(info, 'directory')
        with _fd(os.open('.', _DIR, dir_fd=root)) as scan:
            self._check_directory(scan, '', info)
            with os.scandir(scan) as entries:
                _PARSER.require(next(entries, None) is None, 'private tool directory is not empty')

    def _metadata(self, info, kind):
        _PARSER.require(info.st_dev == self.device and (info.st_uid, info.st_gid) == self.owner,
                        'private tool filesystem or owner differs')
        if kind == 'directory':
            _PARSER.require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700,
                            'private tool directory mode differs')
        else:
            _PARSER.require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
                            and info.st_nlink == 1, 'private tool file type, mode or link count differs')

    def _capacity(self):
        _PARSER.remaining(self.deadline)
        limit = _MAX_ENTRIES if self._created is None else min(_MAX_ENTRIES, _SYNTHETIC_ENTRIES)
        _PARSER.require(len(self.directories) + len(self.files) - 1 < limit,
                        'private tool tree entry bound')

    def _check_directory(self, fd, relative, named=None):
        info = os.fstat(fd)
        self._metadata(info, 'directory')
        _PARSER.require(_birth(info) == self.directories[relative]
                        and (named is None or _state(info) == _state(named)),
                        'private tool directory identity differs')
        return info

    @contextmanager
    def _directory(self, relative):
        self._check_directory(self.root, '')

        @contextmanager
        def enter(parent, prefix, parts):
            if not parts:
                yield parent
                return
            name = parts[0]
            path = prefix + '/' + name if prefix else name
            _PARSER.require(path not in self.files, 'private tool file conflicts with directory')
            fresh = path not in self.directories
            if fresh:
                self._capacity()
                if self._created is not None:
                    self._pending = (path, 'directory')
                os.mkdir(name, mode=0o700, dir_fd=parent)
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if fresh:
                self._metadata(named, 'directory')
                self.directories[path] = _birth(named)
            with _fd(os.open(name, _DIR, dir_fd=parent)) as fd:
                actual = self._check_directory(fd, path, named)
                if fresh and self._created is not None:
                    self._remember(path, 'directory', actual)
                with enter(fd, path, parts[1:]) as current:
                    yield current
                self._check_directory(fd, path, os.stat(name, dir_fd=parent, follow_symlinks=False))

        with enter(self.root, '', relative.split('/') if relative else []) as fd:
            yield fd

    @staticmethod
    def _destination(archive, path, *, directory=False):
        root = _PARSER.BROWSER_ROOT if archive == 'chromium' else 'package'
        _PARSER.require(archive == 'chromium' or archive in _PACKAGES, 'unknown private tool archive')
        path = _PARSER.relative_path(path.encode('ascii'), root.encode('ascii'), directory=directory)
        if archive == 'chromium':
            return 'chromium/' + path
        return 'node_modules/' + archive + path[len(root):]

    @contextmanager
    def _member(self, archive, path, size):
        destination = self._destination(archive, path)
        parent, name = destination.rsplit('/', 1)
        _PARSER.require(destination not in self.files and destination not in self.directories,
                        'duplicate private tool file')
        if self._created is not None:
            _PARSER.require(self._planned_bytes + size <= _SYNTHETIC_BYTES, 'private synthetic tool byte bound')
            self._planned_bytes += size
        with self._directory(parent) as folder:
            self._capacity()
            if self._created is not None:
                self._pending = (destination, 'file')
            with _fd(os.open(name, _WRITE, 0o600, dir_fd=folder)) as fd:
                info = os.fstat(fd)
                self._metadata(info, 'file')
                self.files[destination] = _birth(info)
                if self._created is not None:
                    _PARSER.require(_state(info) == _state(os.stat(name, dir_fd=folder, follow_symlinks=False)),
                                    'private synthetic created file differs')
                    self._remember(destination, 'file', info)
                count = 0

                def write(block):
                    nonlocal count
                    _PARSER.require(0 < len(block) <= _PARSER.CHUNK and count + len(block) <= size,
                                    'private tool write exceeds member bound')
                    view = memoryview(block)
                    while view:
                        _PARSER.remaining(self.deadline)
                        written = os.write(fd, view)
                        _PARSER.require(0 < written <= len(view), 'private tool write made no progress')
                        view = view[written:]
                        count += written

                yield write
                _PARSER.remaining(self.deadline)
                actual = os.fstat(fd)
                self._metadata(actual, 'file')
                _PARSER.require(count == size == actual.st_size and _birth(actual) == self.files[destination]
                                and _state(actual) == _state(os.stat(name, dir_fd=folder, follow_symlinks=False)),
                                'private tool written file identity or length differs')

    def _read_file(self, folder, name, path, info, size):
        _PARSER.remaining(self.deadline)
        self._metadata(info, 'file')
        _PARSER.require(_birth(info) == self.files[path] and info.st_size == size,
                        'private tool readback file identity or length differs')
        digest = hashlib.sha256()
        with _fd(os.open(name, _READ, dir_fd=folder)) as fd:
            _PARSER.require(_state(os.fstat(fd)) == _state(info), 'private tool readback opened different file')
            while size:
                _PARSER.remaining(self.deadline)
                data = os.read(fd, min(size, _PARSER.CHUNK))
                _PARSER.require(bool(data), 'private tool readback truncated')
                size -= len(data)
                digest.update(data)
            _PARSER.remaining(self.deadline)
            _PARSER.require(os.read(fd, 1) == b'' and _state(info) == _state(os.fstat(fd))
                            == _state(os.stat(name, dir_fd=folder, follow_symlinks=False)),
                            'private tool readback file changed')
        return digest.hexdigest()

    def verify(self, expected):
        _PARSER.require(expected.keys() == (self.directories.keys() | self.files.keys()) - {''},
                        'private tool staged tree membership differs')
        actual = {}
        states = {} if self._created is not None else None

        def visit(folder, relative, before):
            _PARSER.remaining(self.deadline)
            with os.scandir(folder) as entries:
                for entry in entries:
                    _PARSER.remaining(self.deadline)
                    name = entry.name
                    path = relative + '/' + name if relative else name
                    _PARSER.require(path in expected and path not in actual, 'private tool unexpected tree entry')
                    kind, mode, size, digest = expected[path]
                    info = os.stat(name, dir_fd=folder, follow_symlinks=False)
                    if kind == 'directory':
                        with _fd(os.open(name, _DIR, dir_fd=folder)) as fd:
                            visit(fd, path, self._check_directory(fd, path, info))
                            _PARSER.require(_state(info) == _state(os.stat(name, dir_fd=folder, follow_symlinks=False)),
                                            'private tool readback directory changed')
                    else:
                        _PARSER.require(self._read_file(folder, name, path, info, size) == digest,
                                        'private tool readback content differs')
                    actual[path] = StagedMember(path, kind, stat.S_IMODE(info.st_mode), size, digest, mode)
                    if states is not None:
                        states[path] = _state(info)
            _PARSER.require(_state(os.fstat(folder)) == _state(before), 'private tool readback directory changed')

        with _fd(os.open('.', _DIR, dir_fd=self.root)) as scan:
            before = self._check_directory(scan, '', self._check_directory(self.root, ''))
            visit(scan, '', before)
        _PARSER.require(actual.keys() == expected.keys(), 'private tool readback tree incomplete')
        if states is not None:
            _PARSER.require(_state(os.fstat(self.root)) == _state(before), 'private synthetic tool root changed')
            self._verified = _state(before), tuple(sorted(states.items()))
        _PARSER.remaining(self.deadline)
        return tuple(actual[name] for name in sorted(actual))

    def materialize(self, chromium, playwright, playwright_core, postgres):
        def sink(archive):
            return lambda path, size: self._member(archive, path, size)

        browser = _PARSER._inspect_chromium(chromium, self.deadline, sink('chromium'))
        sources = {'chromium': browser}
        budget = _PARSER.PACKAGE_COUNT_MAX
        for name, source in zip(_PACKAGES, (playwright, playwright_core, postgres), strict=True):
            destination = None if name == 'postgres' and self._created is not None else sink(name)
            rows = _PARSER._inspect_package(name, source, self.deadline, budget, destination)
            if destination is not None:
                sources[name] = rows
            budget -= len(rows)
        expected = {name: ('directory', 0o555, 0, None) for name in ('chromium', 'node_modules')}
        for archive, rows in sources.items():
            for path, kind, mode, size, digest in rows:
                destination = self._destination(archive, path, directory=kind == 'directory')
                _PARSER.require(destination not in expected, 'private tool expected path collision')
                expected[destination] = kind, mode, size, digest
        for path, (kind, _, _, _) in expected.items():
            if kind == 'directory' and path not in self.directories:
                with self._directory(path):
                    pass
        return self.verify(expected)


def materialize_toolchain(root_fd, chromium, playwright, playwright_core, postgres, deadline):
    """Return observed private members, with archive mode separate from disk mode."""
    _PARSER.require(type(root_fd) is int and root_fd > 2
                    and type(deadline) in (int, float) and math.isfinite(deadline),
                    'held private tool directory and finite deadline required')
    _PARSER.remaining(deadline)
    with _fd(os.dup(root_fd)) as owned_root:
        members = _PrivateTree(owned_root, deadline).materialize(chromium, playwright, playwright_core, postgres)
    _PARSER.remaining(deadline)
    return members


class _SyntheticToolTree(_PrivateTree):
    def __init__(self, root, deadline):
        super().__init__(root, deadline)
        self._created = []
        self._pending = self._verified = None
        self._planned_bytes = 0
        self._attempted = False

    def _remember(self, path, kind, info):
        _PARSER.require(self._pending == (path, kind), 'private synthetic tool creation differs')
        self._created.append((path, kind, _birth(info)[:2]))
        self._pending = None

    def journal(self):
        """Snapshot of known creations and any unproved attempt, with no cleanup authority."""
        return SyntheticToolJournal(self.directories[''][:2], tuple(self._created), self._pending)

    def materialize(self, chromium, playwright, playwright_core, postgres):
        _PARSER.require(self.root is not None and not self._attempted, 'private synthetic tool stage is not fresh')
        self._attempted = True
        members = super().materialize(chromium, playwright, playwright_core, postgres)
        rows = [(row.path, row.kind, row.archive_mode, row.bytes, row.sha256) for row in members]
        _PARSER.require(len(rows) == _SYNTHETIC_ENTRIES and sum(row[3] for row in rows) == _SYNTHETIC_BYTES
                        and hashlib.sha256(_PARSER.canonical(rows)).hexdigest() == _SYNTHETIC_SHA,
                        'private synthetic tool projection differs')
        _PARSER.remaining(self.deadline)
        return SyntheticToolchain(members, *self._verified)


@contextmanager
def synthetic_tool_stage(root_fd, deadline):
    """One fixed private stage of Chromium and Playwright after checking all four archives.

    The owner supplies an empty held directory and retains its own descriptor.
    Preserve the stage journal on refusal and settle only actual owned effects.
    """
    _PARSER.require(type(root_fd) is int and root_fd > 2 and not os.get_inheritable(root_fd)
                    and type(deadline) in (int, float) and math.isfinite(deadline),
                    'held private synthetic tool directory and finite deadline required')
    _PARSER.remaining(deadline)
    with _fd(os.dup(root_fd)) as owned_root:
        stage = _SyntheticToolTree(owned_root, deadline)
        try:
            yield stage
        finally:
            stage.root = None
    _PARSER.remaining(deadline)
