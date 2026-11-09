"""Measure bounded navigation source through an already held source tree.

The caller owns the exact Git inventory, source view, clock and authorization.
These facts neither attest the inventory nor admit execution.
"""
from __future__ import annotations

import hashlib
import os
import re
import select
import stat
import subprocess
import sys
from contextlib import contextmanager
from time import monotonic_ns
from typing import TYPE_CHECKING, Literal, NamedTuple

if TYPE_CHECKING:
    from collections.abc import Callable
    from runtime_inventory import PinnedTree

MAX_MEMBERS = 2048
MAX_FILE = 2 * 1024**2
MAX_TOTAL = 32 * 1024**2
MAX_INVENTORY = 32 * 1024**2
READ_CHUNK = 256 * 1024
HARNESS_ROOTS = (
    'scripts/performance', 'lib/navigation', 'lib/navigation-workspaces.ts',
    'lib/ai-centre/centre-nav.ts', 'lib/security-center-navigation.ts',
    'packs/performance/onehr/tab-model.ts', 'deploy/admission',
    '.github/workflows/alpha-focused-checks.yml', 'components/sidebar.tsx',
    'components/nav-flyout.tsx', 'components/navigation-submenus.tsx',
    'components/system-labels-tabs.tsx', 'components/claims-tabs.tsx',
    'components/attendance-tabs.tsx', 'components/holiday-tabs.tsx',
    'components/statutory-tabs.tsx', 'app/admin/rewards/admin-tabs.tsx',
    'components/leave/leave-inquiry-nav.tsx',
)
HARNESS_DIRECTORIES = ('scripts/performance/', 'lib/navigation/', 'deploy/admission/')
HARNESS_FILES = frozenset(HARNESS_ROOTS) - {path[:-1] for path in HARNESS_DIRECTORIES}
REQUIRED_ORDINARY = frozenset((
    'scripts/performance/navigation-scenarios.json',
    'scripts/performance/navigation-browser-capture.ts',
))
TREE_ROW = re.compile(rb'(100644|100755) blob ([a-f0-9]{40}) +(0|[1-9][0-9]{0,9})\t([A-Za-z0-9_.@+/-]{1,4096})')


class HistoryPin(NamedTuple):
    path: str
    size: int
    git_blob: str
    sha256: str


# These complete ee9 source bytes belong to startup inverse replay controls.
# A new raw preimage requires explicit reviewed pins, regardless of its size.
HISTORY_PINS = (
    HistoryPin('deploy/admission/next_bootstrap_session_inverse.json', 3214186,
               '9b5d549f1f9ebc95186962ce8b807f82d6ecb453',
               '45266a6b0972304842ccec5095506a65255e183630e04b03c6451c2bcfdb3933'),
    HistoryPin('deploy/admission/next_controller_admit_terminal_inverse.json', 22906898,
               '4af22ef5b8dba44b4ce1ce41059777126afe20be',
               '8f86d7c2b60eb061c30a62d665ac37b1617deee5761b4b2aa41b858f7f8a89cf'),
    HistoryPin('deploy/admission/next_controller_admit_timing_inverse.json', 8085766,
               '6d3d23b7301b2728073b73a2422b9e693d24fc3a',
               '8c5a9a8255d19f182d4e88c6f7b0b9433065833009e6168f5e75137d8e09eee7'),
    HistoryPin('deploy/admission/next_host_history_controller_inverse.json', 39474867,
               '4e64a7924aff4438fa4d2a3e4e6e5ac3c4c0c787',
               '7657c27da9d577e3c2d49db285439b37e6970a517250691af70f0f495c08cbe6'),
)


class BoundedHarnessMember(NamedTuple):
    path: str
    mode: str
    size: int
    git_blob: str


class FixedStartupInverseHistory(NamedTuple):
    path: str
    mode: str
    size: int
    git_blob: str
    sha256: str


class NativeNavigationHistoryFacts(NamedTuple):
    ordinary: tuple[BoundedHarnessMember, ...]
    history: tuple[FixedStartupInverseHistory, ...]


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _read_inventory(inventory, check_clock):
    check_clock()
    _require(type(inventory) is bytes and len(inventory) <= MAX_INVENTORY and inventory.endswith(b'\0'),
             'invalid bounded navigation Git inventory')
    _require(0 < inventory.count(b'\0') <= MAX_MEMBERS, 'navigation inventory member limit exceeded')
    pins = {pin.path: pin for pin in HISTORY_PINS}
    files, members, history, total = set(), [], set(), 0
    for raw in inventory[:-1].split(b'\0'):
        check_clock()
        match = TREE_ROW.fullmatch(raw)
        _require(match is not None, 'navigation inventory row differs from regular Git blob')
        mode, oid, count, path = (field.decode('ascii') for field in match.groups())
        parts = path.split('/')
        _require(len(parts) <= 128 and not any(part in ('', '.', '..') for part in parts)
                 and (path in HARNESS_FILES or path.startswith(HARNESS_DIRECTORIES)),
                 'navigation inventory path outside fixed roots')
        _require(path not in files, 'duplicate navigation inventory member')
        files.add(path)
        size = int(count)
        pin = pins.get(path)
        if pin is not None:
            _require((mode, size, oid) == ('100644', pin.size, pin.git_blob),
                     'fixed navigation history Git metadata differs')
            history.add(path)
        else:
            total += size
            _require(size <= MAX_FILE and total <= MAX_TOTAL, 'navigation harness source exceeds bounds')
        members.append(BoundedHarnessMember(path, mode, size, oid))
    _require(history == pins.keys(), 'fixed navigation history inventory incomplete')
    _require(REQUIRED_ORDINARY <= files, 'navigation harness source inventory incomplete')
    check_clock()
    return tuple(members)


def _ordinary_members(members):
    history = {pin.path for pin in HISTORY_PINS}
    return tuple(member for member in members if member.path not in history)


def _partition(inventory, check_clock):
    return tuple(sorted(_ordinary_members(_read_inventory(inventory, check_clock))))


def _file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _stream_history(tree, pin, check_clock):
    check_clock()
    sha256 = hashlib.sha256()
    git_blob = hashlib.sha1(f'blob {pin.size}\0'.encode('ascii'), usedforsecurity=False)
    with tree.open_regular(pin.path, pin.size, context='fixed navigation inverse history') as (source, before):
        _require(before.st_size == pin.size and before.st_nlink == 1 and not before.st_mode & 0o7133,
                 'fixed navigation history checkout metadata differs')
        remaining = pin.size
        while remaining:
            check_clock()
            block = source.read(min(READ_CHUNK, remaining))
            _require(bool(block), 'fixed navigation history truncated')
            remaining -= len(block)
            sha256.update(block)
            git_blob.update(block)
        check_clock()
        _require(not source.read(1), 'fixed navigation history grew')
        expected = _file_identity(before)
        _require(_file_identity(os.fstat(source.fileno())) == expected == _file_identity(tree.metadata(pin.path)),
                 'fixed navigation history changed while reading')
    check_clock()
    sha, oid = sha256.hexdigest(), git_blob.hexdigest()
    _require(sha == pin.sha256 and oid == pin.git_blob, 'fixed navigation history bytes differ')
    return FixedStartupInverseHistory(pin.path, '100644', pin.size, oid, sha)


def capture_navigation_history(tree: PinnedTree, inventory: bytes,
                               check_clock: Callable[[], None]) -> NativeNavigationHistoryFacts:
    """Return bounded Git rows and observed history facts for the caller's held view."""
    ordinary = _partition(inventory, check_clock)
    history = tuple(_stream_history(tree, pin, check_clock) for pin in HISTORY_PINS)
    check_clock()
    tree.assert_unchanged()
    check_clock()
    return NativeNavigationHistoryFacts(ordinary, history)


class NavigationOrdinaryGitObject(NamedTuple):
    """Expected raw Git object facts supplied by the separately authenticated owner."""
    member: BoundedHarnessMember
    sha256: str


class ObservedNavigationOrdinary(NamedTuple):
    path: str
    mode: str
    size: int
    git_blob: str
    sha256: str


class NativeNavigationOrdinaryFacts(NamedTuple):
    ordinary: tuple[ObservedNavigationOrdinary, ...]
    scenario: bytes


_SCENARIO_PATH = 'scripts/performance/navigation-scenarios.json'
_RAW_SHA256 = re.compile(r'[a-f0-9]{64}')


def _stream_ordinary(tree, member, expected_sha256, check_clock):
    check_clock()
    sha256 = hashlib.sha256()
    git_blob = hashlib.sha1(f'blob {member.size}\0'.encode('ascii'), usedforsecurity=False)
    scenario = bytearray() if member.path == _SCENARIO_PATH else None
    with tree.open_regular(member.path, member.size, context='ordinary navigation source') as (source, before):
        original = _file_identity(before)
        mode = before.st_mode
        executable = bool(mode & 0o100) if member.mode == '100755' else not mode & 0o111
        # Git stores the owner execute distinction. A read-only projection can
        # remove write bits; privileged or externally writable modes refuse.
        _require(before.st_size == member.size and before.st_nlink == 1
                 and mode & 0o400 and not mode & 0o7022 and executable,
                 'ordinary navigation checkout metadata differs')
        _require(_file_identity(os.fstat(source.fileno())) == original,
                 'ordinary navigation descriptor differs before reading')
        remaining = member.size
        while remaining:
            check_clock()
            block = source.read(min(READ_CHUNK, remaining))
            _require(0 < len(block) <= remaining, 'ordinary navigation source length changed')
            remaining -= len(block)
            sha256.update(block)
            git_blob.update(block)
            if scenario is not None:
                scenario.extend(block)
        check_clock()
        _require(not source.read(1), 'ordinary navigation source grew')
        _require(_file_identity(os.fstat(source.fileno())) == original
                 == _file_identity(tree.metadata(member.path)),
                 'ordinary navigation source changed while reading')
    check_clock()
    sha, oid = sha256.hexdigest(), git_blob.hexdigest()
    _require(oid == member.git_blob and sha == expected_sha256,
             'ordinary navigation checkout bytes differ from Git object evidence')
    return ObservedNavigationOrdinary(member.path, member.mode, member.size, oid, sha), scenario


def capture_navigation_ordinary(tree: PinnedTree, inventory: bytes,
                                git_objects: tuple[NavigationOrdinaryGitObject, ...],
                                check_clock: Callable[[], None]) -> NativeNavigationOrdinaryFacts:
    """Compare one held checkout to its independently authenticated Git objects.

    The caller owns complete inventory and Git-object authentication. Returned
    rows use the existing partition's path order, with no execution authority.
    """
    facts = _capture_ordinary(tree, _partition(inventory, check_clock), git_objects, check_clock)
    check_clock()
    tree.assert_unchanged()
    check_clock()
    return facts


def _capture_ordinary(tree, ordinary, git_objects, check_clock):
    _require(type(git_objects) is tuple and len(git_objects) == len(ordinary),
             'ordinary navigation Git object evidence count differs')
    by_path = {member.path: member for member in ordinary}
    expected = {}
    for obj in git_objects:
        check_clock()
        _require(type(obj) is NavigationOrdinaryGitObject and type(obj.member) is BoundedHarnessMember
                 and type(obj.member.path) is str and 0 < len(obj.member.path) <= 4096
                 and type(obj.member.mode) is str and obj.member.mode in ('100644', '100755')
                 and type(obj.member.size) is int and 0 <= obj.member.size <= MAX_FILE
                 and type(obj.member.git_blob) is str and len(obj.member.git_blob) == 40
                 and type(obj.sha256) is str and _RAW_SHA256.fullmatch(obj.sha256) is not None,
                 'invalid ordinary navigation Git object evidence')
        path = obj.member.path
        _require(path not in expected, 'duplicate ordinary navigation Git object evidence')
        _require(by_path.get(path) == obj.member, 'ordinary navigation Git object metadata differs')
        expected[path] = obj.sha256

    observed, scenario = [], None
    for member in ordinary:
        fact, content = _stream_ordinary(tree, member, expected[member.path], check_clock)
        observed.append(fact)
        if content is not None:
            scenario = bytes(content)
    _require(scenario is not None, 'ordinary navigation scenario bytes missing')
    return NativeNavigationOrdinaryFacts(tuple(observed), scenario)


class ObservedNavigationSourceMember(NamedTuple):
    ordinal: int
    path: str
    mode: str
    size: int
    git_blob: str
    sha256: str
    role: Literal['ordinary', 'startup-history']


class NativeNavigationSourceFacts(NamedTuple):
    """Immutable held-byte facts for the caller's separate protected handoff."""

    inventory_sha256: str
    members: tuple[ObservedNavigationSourceMember, ...]
    scenario: bytes


def capture_navigation_handoff(tree: PinnedTree, inventory: bytes,
                               git_objects: tuple[NavigationOrdinaryGitObject, ...],
                               check_clock: Callable[[], None]) -> NativeNavigationSourceFacts:
    """Bind one authenticated inventory and held checkout in original Git traversal order.

    The caller supplies the complete immutable Git inventory and independently
    authenticated raw ordinary-object facts. This function does not open Git,
    attest a run or source revision, or authorize delivery of these facts.
    """
    members = _read_inventory(inventory, check_clock)
    ordinary = _capture_ordinary(tree, _ordinary_members(members), git_objects, check_clock)
    histories = tuple(_stream_history(tree, pin, check_clock) for pin in HISTORY_PINS)
    observed: dict[str, tuple[str, Literal['ordinary', 'startup-history']]] = {
        fact.path: (fact.sha256, 'ordinary') for fact in ordinary.ordinary
    }
    observed.update((fact.path, (fact.sha256, 'startup-history')) for fact in histories)
    facts = tuple(ObservedNavigationSourceMember(
        ordinal, member.path, member.mode, member.size, member.git_blob, *observed[member.path],
    ) for ordinal, member in enumerate(members))
    inventory_sha256 = hashlib.sha256(inventory).hexdigest()
    check_clock()
    tree.assert_unchanged()
    check_clock()
    return NativeNavigationSourceFacts(inventory_sha256, facts, ordinary.scenario)


class NavigationGitSources(NamedTuple):
    inventory: bytes
    ordinary: tuple[NavigationOrdinaryGitObject, ...]


_GIT = '/usr/bin/git'
_GIT_ENV = {
    'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C',
    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
    'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_ALLOW_PROTOCOL': '',
    'GIT_TERMINAL_PROMPT': '0',
}
_PROTECTED_AUTOMATION = re.compile(r'/var/lib/aihr-native-controller/[1-9][0-9]{0,19}/automation')
_GIT_CONFIG_MAX = 64 * 1024
_GIT_REAP_RESERVE_NS = 1_000_000_000
_GIT_CONFIG_KEYS = frozenset((
    b'core.repositoryformatversion', b'core.filemode', b'core.bare', b'core.logallrefupdates',
    b'core.ignorecase', b'core.precomposeunicode', b'core.symlinks', b'gc.auto',
    b'remote.origin.url', b'remote.origin.fetch',
))
_GIT_BRANCH_CONFIG = re.compile(rb'branch\.[A-Za-z0-9._/-]{1,256}\.(?:remote|merge)')
_GIT_ORIGIN = (b'https://github.com/StradaverseHub/ai-hr', b'https://github.com/StradaverseHub/ai-hr.git')


def _git_seconds(deadline_ns):
    remaining = deadline_ns - monotonic_ns()
    _require(remaining > 0, 'navigation Git deadline closed')
    return remaining / 1_000_000_000


class _NavigationGitPipe:
    def __init__(self, child, deadline_ns):
        self.child, self.deadline_ns = child, deadline_ns
        self.stdout, self.stderr = child.stdout.fileno(), child.stderr.fileno()
        os.set_blocking(self.stdout, False)
        os.set_blocking(self.stderr, False)

    def _ready(self, descriptors):
        ready, _, _ = select.select(descriptors, (), (), _git_seconds(self.deadline_ns))
        _git_seconds(self.deadline_ns)
        return ready

    def _stderr_eof(self):
        _require(not os.read(self.stderr, 1), 'navigation Git wrote an unexpected diagnostic')
        self.stderr = None

    def read(self, size):
        while True:
            available = [self.stdout] if self.stderr is None else [self.stdout, self.stderr]
            ready = self._ready(available)
            if self.stderr in ready:
                self._stderr_eof()
            if self.stdout in ready:
                return os.read(self.stdout, size)

    def request(self, oid):
        _git_seconds(self.deadline_ns)
        raw = oid.encode('ascii') + b'\n'
        _require(os.write(self.child.stdin.fileno(), raw) == len(raw), 'navigation Git request incomplete')

    def finish(self):
        if self.child.stdin is not None:
            self.child.stdin.close()
        _require(not self.read(1), 'navigation Git response has trailing bytes')
        while self.stderr is not None:
            if self.stderr in self._ready((self.stderr,)):
                self._stderr_eof()
        _require(_wait_git_child(self.child, self.deadline_ns) == 0, 'navigation Git child refused')


def _wait_git_child(child, deadline_ns):
    try:
        status = child.wait(timeout=_git_seconds(deadline_ns))
    except subprocess.TimeoutExpired:
        raise ValueError('navigation Git wait deadline closed') from None
    _git_seconds(deadline_ns)
    return status


def _settle_failed_git_child(child, deadline_ns):
    _git_seconds(deadline_ns)
    if child.poll() is None:
        _git_seconds(deadline_ns)
        try:
            child.kill()
        except OSError:
            # A concurrent exit can make the signal fail. Only the bounded
            # native wait below establishes settlement.
            pass
        _wait_git_child(child, deadline_ns)
    _git_seconds(deadline_ns)


@contextmanager
def _git_navigation_pipe(argv, deadline_ns, *, batch=False, pass_fds=()):
    work_deadline = deadline_ns - _GIT_REAP_RESERVE_NS
    _git_seconds(work_deadline)
    # Keep the fixed Git child in the original outer process scope. Every
    # child uses the same caller clock and its same final settlement reserve.
    child = subprocess.Popen((_GIT, *argv), cwd='/', env=_GIT_ENV, pass_fds=pass_fds,
                             stdin=subprocess.PIPE if batch else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    primary = None
    try:
        if batch:
            os.set_blocking(child.stdin.fileno(), False)
        pipe = _NavigationGitPipe(child, work_deadline)
        _git_seconds(work_deadline)
        yield pipe
        pipe.finish()
    except BaseException as error:
        primary = error
        try:
            _settle_failed_git_child(child, deadline_ns)
        except BaseException:
            error.add_note('Navigation Git child settlement unproved within original deadline')
        raise
    finally:
        close_error = None
        for stream in (child.stdin, child.stdout, child.stderr):
            if stream is None:
                continue
            try:
                stream.close()
            except OSError as error:
                if close_error is None:
                    close_error = error
        if close_error is not None:
            if primary is None:
                raise close_error
            primary.add_note('Navigation Git pipe close refused')
    _git_seconds(deadline_ns)


def _read_git_output(pipe, maximum):
    value = bytearray()
    while block := pipe.read(min(READ_CHUNK, maximum + 1 - len(value))):
        value.extend(block)
        _require(len(value) <= maximum, 'navigation Git output exceeds bounds')
    return bytes(value)


def _check_git_config(tree, deadline_ns):
    with tree.open_regular('.git/config', _GIT_CONFIG_MAX, context='navigation Git configuration') as (source, info):
        _require(info.st_nlink == 1 and not info.st_mode & 0o022,
                 'navigation Git configuration custody differs')
        fd = source.fileno()
        with _git_navigation_pipe(('config', '--null', '--no-includes', '--file', f'/proc/self/fd/{fd}',
                                   '--list'), deadline_ns, pass_fds=(fd,)) as pipe:
            config = _read_git_output(pipe, _GIT_CONFIG_MAX)
    _require(config.endswith(b'\0') and 0 < config.count(b'\0') <= 128,
             'navigation Git configuration exceeds bounds')
    known = {}
    for raw in config[:-1].split(b'\0'):
        _git_seconds(deadline_ns)
        key, separator, value = raw.partition(b'\n')
        _require(separator and key not in known and not any(char < 32 or char > 126 for char in value)
                 and (key in _GIT_CONFIG_KEYS or _GIT_BRANCH_CONFIG.fullmatch(key)),
                 'navigation Git configuration contains an unsupported setting')
        known[key] = value
    _require(known.get(b'core.repositoryformatversion') == b'0' and known.get(b'core.bare') == b'false'
             and known.get(b'remote.origin.url') in _GIT_ORIGIN,
             'navigation Git repository configuration differs')


def _check_git_store(tree, deadline_ns):
    for directory, forbidden in (
        ('.git', (('commondir', 'common-directory'), ('gitdir', 'git-directory'), ('config.worktree', 'worktree-config'))),
        ('.git/objects/info', (('alternates', 'object-alternates'), ('http-alternates', 'object-http-alternates'))),
    ):
        with tree.directory(directory) as fd:
            for name, marker in forbidden:
                _git_seconds(deadline_ns)
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                shape = 'nonregular'
                if stat.S_ISREG(info.st_mode):
                    shape = 'regular-nonempty' if info.st_size else 'regular-empty'
                refusal = ValueError('navigation Git alternate store or worktree refused')
                refusal.add_note('Navigation Git alias marker ' + marker + ' ' + shape)
                raise refusal
    with tree.directory('.git/objects/pack') as fd, os.scandir(fd) as entries:
        for count, entry in enumerate(entries, 1):
            _git_seconds(deadline_ns)
            _require(count <= 2048 and not entry.name.endswith('.promisor') and entry.is_file(follow_symlinks=False),
                     'navigation Git object pack catalogue refused')
    _check_git_config(tree, deadline_ns)


def _read_git_exact(pipe, size):
    raw = bytearray()
    while len(raw) < size:
        block = pipe.read(size - len(raw))
        _require(bool(block), 'navigation Git object response truncated')
        raw.extend(block)
    return raw


def _read_git_objects(pipe, members):
    facts = []
    for member in members:
        pipe.request(member.git_blob)
        header = f'{member.git_blob} blob {member.size}\n'.encode('ascii')
        _require(_read_git_exact(pipe, len(header)) == header, 'navigation Git object header differs')
        sha256 = hashlib.sha256()
        oid = hashlib.sha1(f'blob {member.size}\0'.encode('ascii'), usedforsecurity=False)
        remaining = member.size
        while remaining:
            raw = _read_git_exact(pipe, min(remaining, READ_CHUNK))
            sha256.update(raw)
            oid.update(raw)
            remaining -= len(raw)
        _require(_read_git_exact(pipe, 1) == b'\n' and oid.hexdigest() == member.git_blob,
                 'navigation Git object framing or bytes differ')
        facts.append(NavigationOrdinaryGitObject(member, sha256.hexdigest()))
    return tuple(facts)


def _acquire_navigation_git_sources(tree, revision, deadline_ns):
    _check_git_store(tree, deadline_ns)
    with tree.directory('.git') as fd:
        prefix = ('-c', 'safe.directory=' + str(tree.path), '-c', 'core.fsmonitor=false', '-c',
                  'core.hooksPath=/dev/null', '--literal-pathspecs', f'--git-dir=/proc/self/fd/{fd}')
        with _git_navigation_pipe((*prefix, 'ls-tree', '-rlz', '--full-tree', revision + '^{commit}',
                                   '--', *HARNESS_ROOTS), deadline_ns, pass_fds=(fd,)) as pipe:
            inventory = _read_git_output(pipe, MAX_INVENTORY)
        ordinary = _ordinary_members(_read_inventory(inventory, lambda: _git_seconds(deadline_ns)))
        with _git_navigation_pipe((*prefix, 'cat-file', '--batch'), deadline_ns, batch=True, pass_fds=(fd,)) as pipe:
            facts = _read_git_objects(pipe, ordinary)
    tree.assert_unchanged()
    _git_seconds(deadline_ns)
    return NavigationGitSources(inventory, facts)


def acquire_navigation_git_sources(tree: PinnedTree, revision: str, deadline_ns: int) -> NavigationGitSources:
    """Read committed Git bytes from the caller's already authenticated protected tree.

    The fixed outer owner must admit the exact commit and root mount before
    calling this leaf and own the process scope through mandatory Git reaping,
    including an unproved settlement at the original absolute deadline.
    No caller, launch authority or alternate view is installed here.
    """
    _require(sys.platform == 'linux' and os.geteuid() > 0 and _PROTECTED_AUTOMATION.fullmatch(str(tree.path)),
             'protected nonroot navigation Git view required')
    _require(type(revision) is str and re.fullmatch(r'[a-f0-9]{40}', revision)
             and type(deadline_ns) is int, 'exact navigation Git revision and clock required')
    _git_seconds(deadline_ns)
    root = os.fstat(tree.fd)
    _require(root.st_uid == 0 and not root.st_mode & 0o022 and os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY,
             'immutable root-owned navigation Git view required')
    result = _acquire_navigation_git_sources(tree, revision, deadline_ns)
    _require(os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY, 'navigation Git view lost immutability')
    _git_seconds(deadline_ns)
    return result
