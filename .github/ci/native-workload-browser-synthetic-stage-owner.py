"""Hold and prepare only the same-run synthetic launch source.

The caller owns the exact protected modules, acquired TOOL course and sealed
Node/role bytes. It must prove roles never started or actually settled before
explicit disposal. Closing this scope only closes its descriptors.
"""
from __future__ import annotations

import os
import re
import stat
from contextlib import ExitStack, contextmanager
from types import ModuleType
from typing import NamedTuple


class PreparedStage(NamedTuple):
    view: tuple
    snapshot: tuple


def _require(ok, reason):
    if not ok:
        raise ValueError(reason)


def _successful(row):
    return row == {'reason': 'complete', 'exit': 0, 'admitted': True, 'reaped': True,
                   'quiescent': True, 'escapedSession': False}


class _StageOwner:
    def __init__(self, held, tool, course, launch_view, finalizer, cleanup, host):
        self.held, self.tool, self.course = held, tool, course
        self.views, self.finalizer, self.cleanup, self.host = launch_view, finalizer, cleanup, host
        self.installer = course.installer
        self.run_id = course.name.removeprefix(tool.ROOT_PREFIX)
        _require(re.fullmatch(r'[1-9][0-9]{0,15}', self.run_id) is not None
                 and int(self.run_id) <= 9007199254740991 and course.name == tool.ROOT_PREFIX + self.run_id
                 and course.path == tool.ROOT_PARENT / course.name, 'synthetic stage owner run differs')
        self.run_name = 'aihr-browser-capability-' + self.run_id
        self.run_fd = self.stage_fd = None
        self.pending = None
        self.archive_stage = self.final_stage = None
        self.live = True
        self.prepare_attempted = self.dispose_attempted = False
        self.stage_creation_attempted = False

    def _ready_course(self):
        course, tool = self.course, self.tool
        transfer = course.state.get('transfer', {})
        lengths = transfer.get('lengths', {})
        processes = course.state.get('processOutcomes', {})
        _require(course.created is True and course.processes_settled is True and course.mount_uncertain is False
                 and course.owned_mount is None and set(processes) == {'namespace-private', 'archive-downloader'}
                 and all(_successful(row) for row in processes.values())
                 and transfer.get('generation') == tool.GENERATION and transfer.get('privateWriters') is True
                 and transfer.get('writerHandoff') in tool.DUMP_POLICIES.values() and lengths.keys() == tool.ARCHIVES
                 and lengths['chromium.zip'] == tool.BROWSER_BYTES
                 and all(type(lengths[name]) is int and 0 < lengths[name] <= maximum
                         for name, _, _, maximum in tool.DOWNLOADS), 'synthetic stage owner archive course differs')
        _require(course.deadline == course.active + (tool.TOTAL_SECONDS - tool.ACTIVE_SECONDS),
                 'synthetic stage owner deadline differs')
        tool.left(course.active)
        course.check_root(0o700)
        course.check_private_mount_namespace()

    def _open(self, parent, name):
        tool = self.tool
        before = tool.named(parent, name)
        _require(stat.S_ISDIR(before.st_mode) and before.st_uid == before.st_gid == 0
                 and not before.st_mode & 0o022, 'synthetic stage owner directory differs')
        fd = self.held.enter_context(tool.owned_fd(os.open(name, tool.DIR, dir_fd=parent)))
        _require(tool.identity(os.fstat(fd)) == tool.identity(before)
                 == tool.identity(tool.named(parent, name)), 'synthetic stage owner opened directory differs')
        return fd, before

    def _create(self, parent, name):
        tool = self.tool
        tool.left(self.course.active)
        self.pending = name
        if name == 'launch-source':
            self.stage_creation_attempted = True
        os.mkdir(name, 0o700, dir_fd=parent)
        fd, before = self._open(parent, name)
        tool.require_dir(before, 0, 0, 0o700, self.device)
        return fd, tool.birth(before)

    def _check_run(self, deadline, mode=0o711):
        tool = self.tool
        tool.left(deadline)
        base = os.fstat(self.base)
        run = os.fstat(self.run_fd)
        tool.require_dir(run, 0, 0, mode, self.device)
        _require(stat.S_ISDIR(base.st_mode) and base.st_uid == base.st_gid == 0 and not base.st_mode & 0o022
                 and tool.birth(base) == self.base_birth and tool.identity(base) == tool.identity(tool.named(self.system, 'run'))
                 and tool.birth(run) == self.run_birth and tool.identity(run) == tool.identity(tool.named(self.base, self.run_name)),
                 'synthetic stage owner run directory changed')
        return run

    def _create_stage(self):
        tool = self.tool
        tool.left(self.course.active)
        self.system = self.held.enter_context(tool.owned_fd(os.open('/', tool.DIR)))
        root = os.fstat(self.system)
        _require(stat.S_ISDIR(root.st_mode) and root.st_uid == root.st_gid == 0
                 and not root.st_mode & 0o022, 'synthetic stage owner system root differs')
        self.base, base = self._open(self.system, 'run')
        self.device, self.base_birth = base.st_dev, tool.birth(base)
        self.run_fd, self.run_birth = self._create(self.base, self.run_name)
        self.pending = None
        tool.left(self.course.active)
        os.fchmod(self.run_fd, 0o711)
        self._check_run(self.course.active)
        self.stage_fd, self.stage_birth = self._create(self.run_fd, 'launch-source')
        self.pending = None

    def _planned_size(self, node, roles):
        f = self.finalizer
        _require(all(type(item) is f.BoundStageFile and type(item.data) is bytes and item.data
                     and type(item.sha256) is str and re.fullmatch(r'[0-9a-f]{64}', item.sha256)
                     for item in (node, *roles)) and node.data.startswith(b'\x7fELF')
                 and len(node.data) <= f._NODE_MAX and sum(len(item.data) for item in roles) <= f._ROLE_MAX,
                 'synthetic stage owner bound input differs')
        return self.installer._SYNTHETIC_BYTES + len(node.data) + sum(len(item.data) for item in roles)

    def prepare(self, *, node, driver, browser, probe):
        _require(self.live and not self.prepare_attempted and not self.dispose_attempted,
                 'synthetic stage owner preparation is not fresh')
        self.prepare_attempted = True
        self._ready_course()
        planned = self._planned_size(node, (driver, browser, probe))
        count = self.installer._SYNTHETIC_ENTRIES + 5  # Node, roles directory and its three files.
        self._create_stage()
        course, tool = self.course, self.tool
        with self.views.held_launch_source(self.host, course.mounts, run_id=self.run_id, stage_fd=self.stage_fd,
                                           planned_bytes=planned, planned_entries=count, deadline=course.active) as view:
            _require(view.backing_birth == self.stage_birth, 'synthetic stage owner view birth differs')
            with tool.owned_fd(course.child_directory('inputs')) as source, course.protected_archive_inputs(source) as archives:
                with self.installer.synthetic_tool_stage(self.stage_fd, course.active) as archive_stage:
                    self.archive_stage = archive_stage
                    tools = archive_stage.materialize(*archives)
            with self.finalizer.synthetic_stage(self.installer, self.stage_fd, course.active) as final_stage:
                self.final_stage = final_stage
                snapshot = final_stage.finalize(tools, archive_stage.journal(), node=node, driver=driver,
                                                browser=browser, probe=probe)
            _require(len(snapshot.members) == count and sum(row.bytes for row in snapshot.members) == planned
                     and snapshot.root_state == self.installer._state(os.fstat(self.stage_fd)),
                     'synthetic stage owner prepared census differs')
        self._check_run(course.active)
        _require(snapshot.root_state == self.installer._state(os.fstat(self.stage_fd)),
                 'synthetic stage owner root changed after view closure')
        tool.left(course.active)
        return PreparedStage(view, snapshot)

    def dispose(self):
        """Only the protected issuer with actual role absence or settlement may call."""
        _require(self.live and self.prepare_attempted and not self.dispose_attempted
                 and self.pending is None and self.run_fd is not None
                 and self.stage_creation_attempted == (self.stage_fd is not None),
                 'synthetic stage owner disposal is not admitted')
        self.dispose_attempted = True
        tool, deadline = self.tool, self.course.deadline
        if self.stage_fd is None:
            mode = stat.S_IMODE(os.fstat(self.run_fd).st_mode)
            _require(mode in (0o700, 0o711), 'synthetic stage owner run directory changed')
            before = self._check_run(deadline, mode)
            with self.views.held_empty_launch_parent(self.host, self.course.mounts, run_id=self.run_id,
                                                     run_fd=self.run_fd, deadline=deadline) as view:
                _require(view.backing_birth == self.run_birth, 'synthetic stage owner view birth differs')
            with tool.owned_fd(os.open('/proc/self/fdinfo', tool.DIR)) as fdinfo:
                _require(all(self.views._mount_id(fdinfo, fd, deadline) == view.local_mount_id
                             for fd in (self.base, self.run_fd))
                         and tool.identity(self._check_run(deadline, mode)) == tool.identity(before),
                         'synthetic stage owner empty run view changed')
                self._remove_empty_run(deadline, mode)
            return 0
        self._check_run(deadline)
        empty = self.installer.SyntheticToolJournal(self.stage_birth, (), None)
        archives = empty if self.archive_stage is None else self.archive_stage.journal()
        additions = empty if self.final_stage is None else self.final_stage.journal()
        removed = self.cleanup.dispose_synthetic_stage(self.installer, self.views, self.host, self.course.mounts,
                    run_id=self.run_id, run_fd=self.run_fd, stage_fd=self.stage_fd, initial_birth=self.stage_birth,
                    archives=archives, additions=additions, deadline=deadline)
        self._remove_empty_run(deadline, 0o711)
        return removed

    def _remove_empty_run(self, deadline, mode):
        tool = self.tool
        before = self._check_run(deadline, mode)
        with tool.owned_fd(os.open('.', tool.DIR, dir_fd=self.run_fd)) as scan:
            _require(tool.identity(os.fstat(scan)) == tool.identity(before), 'synthetic stage owner opened different run')
            with os.scandir(scan) as entries:
                _require(next(entries, None) is None, 'synthetic stage owner run is not empty')
        _require(tool.identity(self._check_run(deadline, mode)) == tool.identity(before)
                 and (self.stage_fd is None or os.fstat(self.stage_fd).st_nlink == 0),
                 'synthetic stage owner run removal differs')
        tool.left(deadline)
        os.rmdir(self.run_name, dir_fd=self.base)
        _require(os.fstat(self.run_fd).st_nlink == 0 and not tool.present(self.base, self.run_name),
                 'synthetic stage owner run remains')
        tool.left(deadline)


@contextmanager
def owned_synthetic_stage(tool, course, launch_view, finalizer, cleanup, host):
    """Retain one stage owner in the fixed existing TOOL acquisition lifetime."""
    _require(all(type(module) is ModuleType for module in (tool, launch_view, finalizer, cleanup, host))
             and type(course) is tool.Course and type(course.installer) is type(course.mounts) is ModuleType
             and os.getresuid() == os.getresgid() == (0, 0, 0), 'synthetic stage owner protected input required')
    with ExitStack() as held:
        owner = _StageOwner(held, tool, course, launch_view, finalizer, cleanup, host)
        try:
            yield owner
        finally:
            owner.live = False
