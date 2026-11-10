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
    'components/statutory-tabs.tsx', 'packs/rewards/index.ts',
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
    HistoryPin('deploy/admission/next_bootstrap_session_inverse.json', 3545891,
               '6eb430f11b8011cbc19e127946a5249bd020c852',
               'bdf7ecba7c3ff70c690284a0e3dd3adb3a63422895ef8ad0bb01fc4c1613ab35'),
    HistoryPin('deploy/admission/next_controller_admit_terminal_inverse.json', 24563956,
               '410b94fda5f17793582d7ef7291b78c19f380800',
               'b2b572a6164c2452c7bf1544556eb146b6eabff795052782fa15f17b778bfcfc'),
    HistoryPin('deploy/admission/next_controller_admit_timing_inverse.json', 8972294,
               'bdc3207828823133d4fecd4dde5518e74a0fd441',
               '40de46d16e0c436a29ee599485058e686b2a710fbc1438cde56d91a197942a8e'),
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
