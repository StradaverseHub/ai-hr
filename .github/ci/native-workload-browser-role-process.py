"""Join one fixed synthetic role to its held wrapper, manager and service view.

The protected caller owns the wrapper ACK, candidate discovery, role grant and
service/cgroup settlement. This module acquires no launch authority.
"""

import hashlib
import os
import stat
from contextlib import ExitStack, contextmanager
from time import monotonic_ns
from types import ModuleType
from typing import NamedTuple


_SECOND = 1_000_000_000


class Refused(RuntimeError):
    pass


class VerifiedRoleMain(NamedTuple):
    main: tuple
    manager_main: tuple
    service_view: tuple
    pipe: object


def _require(condition, reason):
    if not condition:
        raise Refused(reason)


class _RoleProcess:
    def __init__(self, host, mounts, launch_view, launch_plan, installer, finalizer, service_view, issuer, *,
                 manager, wrapper, layout, stage_snapshot, node_fd, clock):
        self._host, self._mounts, self._view = host, mounts, launch_view
        self._plan, self._installer, self._finalizer = launch_plan, installer, finalizer
        self._service_view, self._manager, self._wrapper = service_view, manager, wrapper
        self._issuer = issuer
        self._layout, self._stage, self._node_fd, self._clock = layout, stage_snapshot, node_fd, clock
        self._role, self._run = wrapper.role, wrapper.run
        self._frontier = 42 if self._role == 'third' else 32
        self._before = None
        self._gate_argv = None
        self._ack_attempted = self._acknowledged = False
        self._attempted = self._joined = self._failed = False

    def _left(self):
        self._clock.remaining(self._frontier)
        self._wrapper.active.left()

    @contextmanager
    def _held_third_probe(self):
        # A stage directory stamp cannot authenticate the contents of a leaf
        # that the ungated third Python process imports as soon as it execs.
        stage, view = self._layout.stage, self._view
        parent, name = 'roles', 'native-workload-browser-host.py'
        path = parent + '/' + name
        _require(self._role == 'third' and self._plan._PROBE == path, 'role-process-third-probe')
        rows = self._service_view._stage_rows(self._finalizer, self._stage, frozenset((parent,)))[parent]
        directory, probe = rows.get(parent), rows.get(path)
        _require(directory is not None and directory.kind == 'directory' and directory.mode == 0o555
                 and probe is not None and probe.kind == 'file' and probe.mode == 0o444
                 and 0 < probe.bytes <= self._finalizer._ROLE_MAX, 'role-process-third-probe')
        deadline = self._clock.start + self._frontier
        self._left()
        with (view.held_launch_source(self._host, self._mounts, run_id=self._run, stage_fd=stage,
                                      planned_bytes=0, planned_entries=0, deadline=deadline) as launch,
              view._own(os.open(parent, self._installer._DIR, dir_fd=stage)) as folder,
              view._own(os.open(name, self._installer._READ, dir_fd=folder)) as fd):
            def current():
                self._left()
                stage_info = os.fstat(stage)
                _require(launch.path == self._layout.root + '/launch-source'
                         and launch.backing_birth == (stage_info.st_dev, stage_info.st_ino)
                         and self._installer._state(stage_info) == self._stage.root_state,
                         'role-process-stage-root')
                for held, relative, enclosing, row, mode in (
                    (folder, parent, stage, directory, stat.S_IFDIR | 0o555),
                    (fd, name, folder, probe, stat.S_IFREG | 0o444),
                ):
                    self._left()
                    info = os.fstat(held)
                    _require(info.st_mode == mode and info.st_uid == info.st_gid == 0
                             and not os.get_inheritable(held)
                             and (row is directory or (info.st_nlink == 1 and info.st_size == probe.bytes))
                             and self._installer._state(info) == row.state == self._installer._state(
                                 os.stat(relative, dir_fd=enclosing, follow_symlinks=False)), 'role-process-third-probe')
                    _require(view._mount_id(self._layout.fdinfo, held, deadline) == launch.local_mount_id,
                             'role-process-third-probe-mount')

            current()
            digest, offset = hashlib.sha256(), 0
            while offset < probe.bytes:
                self._left()
                size = min(16384, probe.bytes - offset)
                block = os.pread(fd, size, offset)
                _require(0 < len(block) <= size, 'role-process-third-probe-bytes')
                digest.update(block)
                offset += len(block)
            self._left()
            _require(not os.pread(fd, 1, offset) and digest.hexdigest() == probe.sha256,
                     'role-process-third-probe-bytes')
            current()
            yield
            current()

    def before_request(self):
        """Check the exact READY command and current unit absence before ACK."""
        wrapper, manager = self._wrapper, self._manager
        _require(self._before is None and not self._failed and wrapper.live and wrapper.ready
                 and not wrapper.manager_request_possible and not wrapper.reap_attempted
                 and manager.phase(self._role) == 'new', 'role-process-prelaunch-order')
        try:
            self._left()
            root = self._layout.root
            layout = self._layout.inspect_fixed(role_deadline=self._clock.start + self._frontier)
            self._left()
            _require(self._installer._state(os.fstat(self._layout.stage)) == self._stage.root_state,
                     'role-process-stage-root')
            if self._node_fd is not None:
                projected = self._service_view._stage_rows(self._finalizer, self._stage, frozenset(('node',)))
                self._left()
                _require(not os.get_inheritable(self._node_fd)
                         and self._installer._state(os.fstat(self._node_fd)) == projected['node']['node'].state,
                         'role-process-stage-node')
            credential = layout.driver_credential if self._role == 'driver' else None
            command = self._plan.synthetic_role_command(
                self._host, mode='capability-only', role=self._role, run_id=self._run,
                owner_nonce=wrapper.input['nonce'], stage=root + '/launch-source',
                spki=wrapper.input['spki'], credential=credential,
            )
            split = command.argv.index('--')
            unset = '--property=UnsetEnvironment=' + ' '.join(wrapper.input['unsetNames'])
            _require(wrapper.stock_argv[:split + 2] == (*command.argv[:split], unset, '--'),
                     'role-process-stock-command')
            service = wrapper.stock_argv[split + 2:]
            if self._role == 'third':
                _require(service == command.argv[split + 1:], 'role-process-stock-command')
                with self._held_third_probe():
                    self._left()
            else:
                _, node = self._host._main_commands(self._role, self._run, service)
                _require(node == command.argv[split + 1:] and service[8] == str(wrapper.launch_by),
                         'role-process-stock-command')
                self._gate_argv = service
            wrapper._snapshot(wrapper.active, helper=True)
            self._left()
            before = monotonic_ns()
            _require(wrapper.started <= before < wrapper.launch_by, 'role-process-launch-clock')
            manager.before_launch(self._role, self._frontier)
            self._left()
            self._before = before
        except BaseException as primary:
            self._settle_failure(primary)
            raise

    def acknowledge_request(self):
        """Send the existing wrapper ACK once, while the joined source proof is current."""
        wrapper = self._wrapper
        _require(self._before is not None and not self._ack_attempted and not self._failed
                 and wrapper.live and wrapper.ready and not wrapper.manager_request_possible and not wrapper.reap_attempted
                 and self._manager.phase(self._role) == 'prelaunch-absent', 'role-process-ack-order')
        self._ack_attempted = True
        try:
            self._left()
            if self._role == 'third':
                wrapper._prepare_ack()
                with self._held_third_probe():
                    wrapper._send_ack()
            else:
                wrapper.acknowledge()
            self._left()
            self._acknowledged = True
        except BaseException as primary:
            self._settle_failure(primary)
            raise

    @contextmanager
    def hold_main(self, *, candidate_pid, candidate_invocation):
        """Treat the discovery pair as candidates until both native owners agree."""
        wrapper, manager = self._wrapper, self._manager
        _require(self._acknowledged and not self._attempted and not self._failed
                 and wrapper.live and wrapper.ack_sent and wrapper.stock_seen and not wrapper.reap_attempted
                 and manager.phase(self._role) == 'prelaunch-absent', 'role-process-main-order')
        self._attempted = True
        try:
            _require(type(candidate_pid) is int and 1 < candidate_pid <= 4194304 and candidate_pid != wrapper.pid
                     and type(candidate_invocation) is bytes and len(candidate_invocation) == 16
                     and any(candidate_invocation), 'role-process-discovery')
            self._left()
            # The already-observed stock exec and the gated service share
            # stdio descriptions. The gate may now hold them nonblocking.
            wrapper._current_identity(wrapper.active)
            self._left()
            with ExitStack() as owned:
                read_fd, write_fd = wrapper.borrow_role_pipes()
                main = owned.enter_context(self._host.held_synthetic_main(
                    candidate_pid, self._role, self._run, python_fd=wrapper.python_fd, node_fd=self._node_fd,
                    root_read_fd=read_fd, root_write_fd=write_fd, gate_argv=self._gate_argv, clock=self._clock,
                ))
                _, initial, current = main
                _require(initial.identity.pid == candidate_pid and current() == initial, 'role-process-main-changed')
                manager.retain(self._role, candidate_invocation, self._frontier)
                observed = self._service_view.observe_service_view(
                    self._host, self._mounts, self._view, self._plan, self._installer, self._finalizer,
                    role=self._role, run_id=self._run, main=main, layout=self._layout,
                    stage_snapshot=self._stage, clock=self._clock,
                )
                identity = initial.identity
                _require((observed.role, observed.pid, observed.start, observed.mount_namespace)
                         == (self._role, identity.pid, identity.start, identity.namespaces[-1])
                         and current() == initial, 'role-process-view-changed')
                manager_main = manager.bind_live_main(
                    self._role, candidate_invocation, initial.identity.pid, self._before, self._frontier,
                )
                _require(manager_main.pid == identity.pid and manager_main.invocation == candidate_invocation
                         and current() == initial, 'role-process-main-changed')
                self._left()
                pipe = wrapper.adopt_role_pipes(self._issuer, output_birth=identity.output_birth,
                                                input_birth=identity.input_birth)
                self._left()
                yield VerifiedRoleMain(main, manager_main, observed, pipe)
            self._joined = True
        except BaseException as primary:
            self._settle_failure(primary)
            raise

    def _settle_failure(self, primary):
        if self._failed:
            return
        self._failed = True
        wrapper = self._wrapper
        if wrapper.manager_request_possible:
            primary.add_note('role-process-manager-and-service-settlement-unproved')
        if wrapper.reaped:
            return
        if wrapper.pidfd is not None and not wrapper.reap_attempted:
            try:
                wrapper.settle(terminate=True)
                return
            except BaseException:
                pass
        primary.add_note('role-process-wrapper-settlement-unproved')


@contextmanager
def held_role_process(host, mounts, launch_view, launch_plan, installer, finalizer, service_view, issuer,
                      reference, wrapper_parent, runtime_layout, *, manager, wrapper, layout, stage_snapshot,
                      node_fd, clock):
    """Borrow the source-pinned owners and the protected caller's open scopes.

    Before entry the caller owns the READY wrapper, held broker transport and
    fixed launch inputs. The caller uses before_request and acknowledge_request
    before stock exec observation and fixed-unit discovery. It must preserve
    the immutable launch source through exec, including the ungated third probe.
    The native main scope is borrowed until hold_main exits. The existing issuer
    uses the one adopted pipe object while the wrapper scope remains open and
    owns readiness, grant and exact transcript closure. The protected caller
    owns service, cgroup and manager-reference disposition on failure.
    """
    modules = (host, mounts, launch_view, launch_plan, installer, finalizer, service_view, issuer,
               reference, wrapper_parent, runtime_layout)
    _require(all(type(module) is ModuleType for module in modules)
             and type(manager) is reference.ManagerReference and type(wrapper) is wrapper_parent._WrapperParent
             and type(clock) is host.Deadline and type(stage_snapshot) is finalizer.SyntheticStageSnapshot
             and type(layout) is runtime_layout._Layout and layout.ready
             and layout.host is host and layout.mounts is mounts and layout.view is launch_view
             and wrapper.live and wrapper.ready and not wrapper.manager_request_possible
             and not wrapper.reap_attempted and wrapper.pidfd is not None
             and manager._run == wrapper.run == layout.run_id and manager._started == wrapper.started
             and wrapper.started == round(clock.start * _SECOND)
             and wrapper.launch_by == wrapper.started + (42 if wrapper.role == 'third' else 32) * _SECOND
             and ((node_fd is None) if wrapper.role == 'third' else (type(node_fd) is int and node_fd > 2)),
             'role-process-owner')
    owner = _RoleProcess(host, mounts, launch_view, launch_plan, installer, finalizer, service_view, issuer,
                         manager=manager, wrapper=wrapper, layout=layout, stage_snapshot=stage_snapshot,
                         node_fd=node_fd, clock=clock)
    try:
        yield owner
        _require(owner._joined, 'role-process-not-joined')
    except BaseException as primary:
        owner._settle_failure(primary)
        raise
