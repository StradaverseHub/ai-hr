"""Stream four fixed startup inverse blobs through an already held source tree.

The caller owns the exact Git inventory, source view, clock and authorization.
These facts neither attest the inventory nor admit execution.
"""
from __future__ import annotations

import hashlib
import os
import re
from typing import TYPE_CHECKING, NamedTuple

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


def _partition(inventory, check_clock):
    check_clock()
    _require(type(inventory) is bytes and len(inventory) <= MAX_INVENTORY and inventory.endswith(b'\0'),
             'invalid bounded navigation Git inventory')
    _require(0 < inventory.count(b'\0') <= MAX_MEMBERS, 'navigation inventory member limit exceeded')
    pins = {pin.path: pin for pin in HISTORY_PINS}
    files, ordinary, history, total = set(), [], set(), 0
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
            ordinary.append(BoundedHarnessMember(path, mode, size, oid))
    _require(history == pins.keys(), 'fixed navigation history inventory incomplete')
    _require(REQUIRED_ORDINARY <= files, 'navigation harness source inventory incomplete')
    check_clock()
    return tuple(sorted(ordinary))


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
    ordinary = _partition(inventory, check_clock)
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
    check_clock()
    tree.assert_unchanged()
    check_clock()
    return NativeNavigationOrdinaryFacts(tuple(observed), scenario)
