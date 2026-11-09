"""Ordering and refusal models for the fixed role-process join."""

import hashlib
import importlib.util
import os
import pathlib
import stat
import unittest
from contextlib import ExitStack, contextmanager
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, call, patch


def sibling(leaf):
    name = 'native-workload-browser-' + leaf
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


J, H, P, G = (sibling(leaf) for leaf in ('role-process', 'host', 'launch-plan', 'preimport-gate'))
R, W, L, V, F, I = (sibling(leaf) for leaf in (
    'manager-reference', 'wrapper-parent', 'runtime-layout', 'service-view', 'synthetic-stage', 'issuer',
))
RUN, START, PID = '123', 20, 43
NS = START * 1_000_000_000
INVOCATION = bytes(range(16))
ROOT = '/run/aihr-browser-capability-' + RUN
CREDENTIAL = (ROOT + '/private/observer', b'aihr-browser-isolation-v1:123\n')
SPKI = 'A' * 43 + '='
PROBE = b'fixed probe model\n'


def node(inode, mode, state, size=0):
    return SimpleNamespace(st_dev=1, st_ino=inode, st_uid=0, st_gid=0, st_mode=mode, st_nlink=1,
                           st_size=size, state=state)


class RoleProcessModel:
    def __init__(self, role):
        self.role = role
        self.frontier = 42 if role == 'third' else 32
        self.events, self.phase, self.remaining = [], 'new', 1
        self.clock = object.__new__(H.Deadline)
        self.clock.start = START
        self.clock.remaining = Mock(side_effect=self.left)
        self.view = ModuleType('launch-view-model')
        self.view._own = self.own
        self.view.held_launch_source = self.held_stage_view
        self.view._mount_id = lambda _fdinfo, fd, _deadline: self.mounts_by_fd[fd]
        self.mounts, self.installer = ModuleType('mount-model'), ModuleType('installer-model')
        self.installer._state = lambda info: info.state
        self.installer._DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        self.installer._READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
        self.layout = object.__new__(L._Layout)
        self.layout.run_id, self.layout.root, self.layout.ready, self.layout.stage = RUN, ROOT, True, 38
        self.layout.fdinfo = 39
        self.layout.host, self.layout.mounts, self.layout.view = H, self.mounts, self.view
        self.layout.inspect_fixed = Mock(side_effect=self.inspect_layout)
        self.stage = F.SyntheticStageSnapshot(('stage',), ())
        self.node_row = F.SealedStageMember('node', 'file', 0o555, 1, '0' * 64, ('node',))
        self.roles_row = F.SealedStageMember('roles', 'directory', 0o555, 0, None, ('roles',))
        self.probe_row = F.SealedStageMember(P._PROBE, 'file', 0o444, len(PROBE), hashlib.sha256(PROBE).hexdigest(), ('probe',))
        self.probe_bytes, self.probe_missing, self.probe_reads = PROBE, False, []
        self.mounts_by_fd = {71: 11, 72: 11}
        self.nodes = {38: node(38, stat.S_IFDIR | 0o700, ('stage',)), 37: node(37, stat.S_IFREG | 0o555, ('node',)),
                      71: node(71, stat.S_IFDIR | 0o555, ('roles',)), 72: node(72, stat.S_IFREG | 0o444, ('probe',), len(PROBE)),
                      41: node(14, stat.S_IFIFO | 0o600, ('read',)), 42: node(13, stat.S_IFIFO | 0o600, ('write',))}
        self.manager = object.__new__(R.ManagerReference)
        self.manager._run, self.manager._started = RUN, NS
        self.manager.phase = Mock(side_effect=lambda _: self.phase)
        self.manager.before_launch = Mock(side_effect=self.absence)
        self.manager.retain = Mock(side_effect=self.retain)
        self.manager.bind_live_main = Mock(side_effect=self.bind)
        self.wrapper = object.__new__(W._WrapperParent)
        self.wrapper.role, self.wrapper.run = role, RUN
        self.wrapper.started, self.wrapper.launch_by = NS, NS + self.frontier * 1_000_000_000
        self.wrapper.live = self.wrapper.ready = True
        self.wrapper.ack_attempted = self.wrapper.ack_sent = self.wrapper.stock_seen = False
        self.wrapper.reap_attempted = self.wrapper.reaped = False
        self.wrapper.pid, self.wrapper.pidfd, self.wrapper.python_fd = 29, 30, 36
        self.wrapper.active = SimpleNamespace(left=Mock())
        self.wrapper._snapshot = Mock(side_effect=lambda *a, **kw: self.events.append(('ready', kw['helper'])))
        self.wrapper._current_identity = Mock(side_effect=lambda _: self.events.append('stock-identity'))
        self.wrapper.take_role_pipes = Mock(side_effect=AssertionError('legacy raw transfer'))
        self.wrapper.borrow_role_pipes = Mock(side_effect=self.borrow)
        self.wrapper.adopt_role_pipes = Mock(side_effect=self.adopt)
        self.wrapper.acknowledge = Mock(side_effect=self.ack)
        self.wrapper._prepare_ack = Mock()
        self.wrapper._send_ack = Mock(side_effect=self.ack)
        self.wrapper.settle = Mock(side_effect=self.settle)
        spki = SPKI if role == 'browser' else None
        self.wrapper.input = {'nonce': 'a' * 16, 'spki': spki, 'unsetNames': ['TMPDIR']}
        plan = P.synthetic_role_command(H, mode='capability-only', role=role, run_id=RUN,
                                        owner_nonce=self.wrapper.input['nonce'], stage=ROOT + '/launch-source',
                                        spki=spki, credential=CREDENTIAL if role == 'driver' else None)
        split = plan.argv.index('--')
        self.gate_argv = None if role == 'third' else G.synthetic_preimport_argv(
            role=role, run_id=RUN, deadline_ns=self.wrapper.launch_by, spki=spki,
        )
        self.wrapper.stock_argv = (*plan.argv[:split], '--property=UnsetEnvironment=TMPDIR', '--',
                                   *(self.gate_argv or plan.argv[split + 1:]))
        identity = H._MainIdentity(PID, 77, (1, 11), ((1, 12),), 2, (1, 13), (1, 14))
        self.initial = H._MainSnapshot(identity, (1, 15))
        self.current = Mock(return_value=self.initial)
        self.main = (45, self.initial, self.current)
        self.service = V.ServiceView(role, PID, 77, (1, 12), (), 1)
        self.manager_main = R.LiveMain(None, 'fixed-model-unit', INVOCATION, PID, 0, 0)
        self.node_fd = None if role == 'third' else 37

    def left(self, frontier):
        if frontier != self.frontier or self.remaining <= 0:
            raise H.Refused('model deadline')
        return self.remaining

    def inspect_layout(self, *, role_deadline):
        self.events.append(('layout', role_deadline))
        return L.RuntimeLayoutSnapshot(None, CREDENTIAL, False)

    def absence(self, role, frontier):
        self.events.append(('absent', role, frontier))
        self.phase = 'prelaunch-absent'

    def ack(self):
        self.events.append('ack')
        self.wrapper.ack_attempted = self.wrapper.ack_sent = True

    def stock_observed_externally(self):
        if not self.wrapper.ack_sent:
            raise AssertionError('stock observation preceded ACK')
        self.events.append('external-stock-proof')
        self.wrapper.stock_seen = True

    def borrow(self):
        self.events.append('borrow')
        return 41, 42

    def adopt(self, issuer, *, output_birth, input_birth):
        if issuer is not I or (output_birth, input_birth) != ((1, 14), (1, 13)):
            raise AssertionError('adoption did not use the held main pipe births')
        self.events.append('adopt')
        self.adopted = I._RolePipes(41, 42, 512)
        return self.adopted

    @contextmanager
    def own(self, fd):
        self.probe_reads.append(('open', fd))
        try:
            yield fd
        finally:
            self.probe_reads.append(('close', fd))

    @contextmanager
    def held_stage_view(self, host, mounts, **kw):
        if (host, mounts) != (H, self.mounts) or kw != dict(run_id=RUN, stage_fd=38, planned_bytes=0,
                                                          planned_entries=0, deadline=START + self.frontier):
            raise AssertionError('probe stage deadline or binding differs')
        yield SimpleNamespace(path=ROOT + '/launch-source', backing_birth=(1, 38), local_mount_id=11)

    def open_probe(self, name, flags, *, dir_fd):
        if (dir_fd, name, flags) == (38, 'roles', self.installer._DIR):
            return 71
        if (dir_fd, name, flags) == (71, 'native-workload-browser-host.py', self.installer._READ):
            if self.probe_missing:
                raise FileNotFoundError('model probe absent')
            return 72
        raise AssertionError('unexpected probe path or flags')

    def stat_probe(self, name, *, dir_fd, follow_symlinks):
        if follow_symlinks:
            raise AssertionError('followed named probe path')
        return self.nodes[{(38, 'roles'): 71, (71, 'native-workload-browser-host.py'): 72}[dir_fd, name]]

    def read_probe(self, fd, maximum, offset):
        if fd != 72:
            raise AssertionError('unexpected probe FD')
        self.probe_reads.append(('read', offset, maximum))
        return self.probe_bytes[offset:offset + maximum]

    def stage_rows(self, finalizer, snapshot, leaves):
        if finalizer is not F or snapshot is not self.stage:
            raise AssertionError('unexpected stage snapshot')
        if leaves == {'node'}:
            return {'node': {'node': self.node_row}}
        if leaves == {'roles'}:
            return {'roles': {'roles': self.roles_row, P._PROBE: self.probe_row}}
        raise AssertionError('unexpected stage projection')

    @contextmanager
    def held_main(self, pid, role, run, **options):
        self.events.append(('hold', pid, role, run, options['gate_argv']))
        if (options['root_read_fd'], options['root_write_fd'], options['node_fd']) != (41, 42, self.node_fd):
            raise AssertionError('different pipe ends or executable')
        try:
            yield self.main
        finally:
            self.events.append('main-closed')

    def retain(self, role, invocation, frontier):
        self.events.append(('retain', role, invocation, frontier))
        self.phase = 'held'

    def observe(self, *modules, **options):
        self.events.append(('view', options['role'], options['main']))
        return self.service

    def bind(self, role, invocation, pid, before, frontier):
        self.events.append(('bind', role, invocation, pid, before, frontier))
        return self.manager_main

    def settle(self, *, terminate):
        self.events.append(('settle-wrapper', terminate))
        self.wrapper.reaped = True

    @contextmanager
    def run(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(J, 'monotonic_ns', return_value=NS + 1))
            stack.enter_context(patch.object(J.os, 'fstat', side_effect=self.nodes.__getitem__))
            stack.enter_context(patch.object(J.os, 'get_inheritable', return_value=False))
            stack.enter_context(patch.object(J.os, 'get_blocking', return_value=False))
            stack.enter_context(patch.object(J.os, 'fpathconf', return_value=512))
            stack.enter_context(patch.object(J.os, 'open', side_effect=self.open_probe))
            stack.enter_context(patch.object(J.os, 'stat', side_effect=self.stat_probe))
            stack.enter_context(patch.object(J.os, 'pread', side_effect=self.read_probe, create=True))
            stack.enter_context(patch.object(V, '_stage_rows', side_effect=self.stage_rows))
            stack.enter_context(patch.object(H, 'held_synthetic_main', self.held_main))
            stack.enter_context(patch.object(V, 'observe_service_view', self.observe))
            yield stack.enter_context(J.held_role_process(
                H, self.mounts, self.view, P, self.installer, F, V, I, R, W, L,
                manager=self.manager, wrapper=self.wrapper, layout=self.layout, stage_snapshot=self.stage,
                node_fd=self.node_fd, clock=self.clock,
            ))


class RoleProcessTests(unittest.TestCase):
    def test_all_fixed_roles_join_held_main_view_and_final_invocation_before_handoff(self):
        for role in ('driver', 'browser', 'third'):
            with self.subTest(role=role):
                model = RoleProcessModel(role)
                with model.run() as owner:
                    owner.before_request()
                    self.assertFalse(model.wrapper.manager_request_possible)
                    owner.acknowledge_request()
                    model.stock_observed_externally()
                    with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION) as verified:
                        self.assertEqual(verified, (model.main, model.manager_main, model.service, model.adopted))
                        model.events.append('handoff')
                self.assertEqual(model.events, [
                    ('layout', START + model.frontier), ('ready', True), ('absent', role, model.frontier),
                    'ack', 'external-stock-proof', 'stock-identity', 'borrow',
                    ('hold', PID, role, RUN, model.gate_argv), ('retain', role, INVOCATION, model.frontier),
                    ('view', role, model.main), ('bind', role, INVOCATION, PID, NS + 1, model.frontier),
                    'adopt', 'handoff', 'main-closed',
                ])
                model.wrapper.take_role_pipes.assert_not_called()
                model.wrapper.settle.assert_not_called()
                if role == 'third':
                    model.wrapper._prepare_ack.assert_called_once_with()
                    model.wrapper._send_ack.assert_called_once_with()
                    model.wrapper.acknowledge.assert_not_called()
                self.assertEqual(model.probe_reads, [
                    ('open', 71), ('open', 72), ('read', 0, len(PROBE)), ('read', len(PROBE), 1),
                    ('close', 72), ('close', 71),
                ] * (2 if role == 'third' else 0))

    def test_out_of_order_join_does_not_take_pipes_and_settles_only_wrapper(self):
        model = RoleProcessModel('driver')
        with self.assertRaisesRegex(J.Refused, 'role-process-main-order') as refused:
            with model.run() as owner:
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('held before absence')
        model.wrapper.take_role_pipes.assert_not_called()
        model.wrapper.borrow_role_pipes.assert_not_called()
        model.wrapper.adopt_role_pipes.assert_not_called()
        model.manager.retain.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)
        self.assertFalse(getattr(refused.exception, '__notes__', ()))

    def test_wrong_stock_gate_deadline_refuses_before_manager_absence(self):
        model = RoleProcessModel('driver')
        args = list(model.wrapper.stock_argv)
        args[-1] = str(model.wrapper.launch_by - 1)
        model.wrapper.stock_argv = tuple(args)
        with self.assertRaisesRegex(J.Refused, 'role-process-stock-command'):
            with model.run() as owner:
                owner.before_request()
        model.manager.before_launch.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_foreign_node_birth_refuses_before_manager_absence(self):
        model = RoleProcessModel('driver')
        model.node_row = model.node_row._replace(state=('foreign-node',))
        with self.assertRaisesRegex(J.Refused, 'role-process-stage-node'):
            with model.run() as owner:
                owner.before_request()
        model.manager.before_launch.assert_not_called()
        model.wrapper.take_role_pipes.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_failed_refusal_keeps_primary_and_post_ack_uncertainty(self):
        model = RoleProcessModel('browser')
        primary = R.Refused('model retain failed')
        model.manager.retain.side_effect = primary
        model.wrapper.settle.side_effect = OSError('model wrapper cleanup failed')
        with self.assertRaises(R.Refused) as refused:
            with model.run() as owner:
                owner.before_request()
                owner.acknowledge_request()
                model.stock_observed_externally()
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('handed off a refused invocation')
        self.assertIs(refused.exception, primary)
        self.assertEqual(primary.__notes__, ['role-process-manager-and-service-settlement-unproved',
                                             'role-process-wrapper-settlement-unproved'])
        self.assertEqual(model.events[-1], 'main-closed')
        model.wrapper.adopt_role_pipes.assert_not_called()
        model.manager.bind_live_main.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_view_or_fresh_manager_mismatch_refuses_before_handoff(self):
        for broken_view in (True, False):
            with self.subTest(broken_view=broken_view):
                model = RoleProcessModel('third')
                if broken_view:
                    model.service = model.service._replace(mount_namespace=(1, 99))
                else:
                    model.manager_main = model.manager_main._replace(invocation=b'X' * 16)
                with self.assertRaisesRegex(J.Refused, 'role-process-(view|main)-changed'):
                    with model.run() as owner:
                        owner.before_request()
                        owner.acknowledge_request()
                        model.stock_observed_externally()
                        with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                            self.fail('handed off a mismatched process')
                self.assertEqual(model.manager.bind_live_main.call_count, 0 if broken_view else 1)
                self.assertEqual(model.events[-2:], ['main-closed', ('settle-wrapper', True)])
                model.wrapper.adopt_role_pipes.assert_not_called()

    def test_final_role_clock_refuses_even_after_all_observations(self):
        model = RoleProcessModel('driver')

        def bind(*args):
            model.remaining = 0
            return model.bind(*args)

        model.manager.bind_live_main.side_effect = bind
        with self.assertRaisesRegex(H.Refused, 'model deadline'):
            with model.run() as owner:
                owner.before_request()
                owner.acknowledge_request()
                model.stock_observed_externally()
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('handed off beyond fixed frontier')
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_early_exit_after_possible_request_remains_uncertain(self):
        model = RoleProcessModel('driver')
        with self.assertRaisesRegex(J.Refused, 'role-process-not-joined') as refused:
            with model.run() as owner:
                owner.before_request()
                owner.acknowledge_request()
                model.stock_observed_externally()
        model.wrapper.take_role_pipes.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)
        self.assertEqual(refused.exception.__notes__, ['role-process-manager-and-service-settlement-unproved'])

    def test_third_probe_missing_wrong_bytes_or_foreign_mount_refuses_before_absence_and_ack(self):
        for variant, failure, reason in (
            ('missing', FileNotFoundError, 'model probe absent'),
            ('wrong-bytes', J.Refused, 'role-process-third-probe-bytes'),
            ('foreign-mount', J.Refused, 'role-process-third-probe-mount'),
        ):
            with self.subTest(variant=variant):
                model = RoleProcessModel('third')
                if variant == 'missing':
                    model.probe_missing = True
                elif variant == 'wrong-bytes':
                    model.probe_bytes = b'X' * len(PROBE)
                else:
                    model.mounts_by_fd[72] = 12
                with self.assertRaisesRegex(failure, '^' + reason + '$'), model.run() as owner:
                    owner.before_request()
                model.manager.before_launch.assert_not_called()
                model.wrapper.acknowledge.assert_not_called()
                model.wrapper._prepare_ack.assert_not_called()
                model.wrapper._send_ack.assert_not_called()
                model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_third_probe_replacement_after_absence_refuses_before_wrapper_ack(self):
        model = RoleProcessModel('third')
        with self.assertRaisesRegex(J.Refused, '^role-process-third-probe$'), model.run() as owner:
            owner.before_request()
            def replace_during_wrapper_preparation():
                model.nodes[72] = node(73, stat.S_IFREG | 0o444, ('foreign-probe',), len(PROBE))
            model.wrapper._prepare_ack.side_effect = replace_during_wrapper_preparation
            owner.acknowledge_request()
        model.manager.before_launch.assert_called_once_with('third', 42)
        model.wrapper._prepare_ack.assert_called_once_with()
        model.wrapper._send_ack.assert_not_called()
        model.wrapper.acknowledge.assert_not_called()
        model.wrapper.borrow_role_pipes.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_raw_wrapper_ack_cannot_bypass_the_joined_ack_transition(self):
        model = RoleProcessModel('third')
        with self.assertRaisesRegex(J.Refused, '^role-process-main-order$'), model.run() as owner:
            owner.before_request()
            model.wrapper.acknowledge()
            model.stock_observed_externally()
            with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                self.fail('raw ACK bypassed the joined guard')
        model.wrapper.borrow_role_pipes.assert_not_called()
        model.wrapper.adopt_role_pipes.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def wrapper_for_adoption(self):
        owner = object.__new__(W._WrapperParent)
        owner.live = owner.stock_seen = True
        owner.reap_attempted = False
        owner.control = owner.root_pipes = None
        owner.active = SimpleNamespace(left=Mock())
        return owner

    def test_adoption_interruption_keeps_exactly_one_cleanup_owner(self):
        for frontier in ('constructing', 'after-assignment'):
            with self.subTest(frontier=frontier), ExitStack() as stack:
                owner = self.wrapper_for_adoption()
                owner.root_pipes, owner.stock_seen = (30, 31), True
                stack.enter_context(patch.object(owner, '_root_pipe_pair'))
                stack.enter_context(patch.object(W.os, 'fstat', side_effect=lambda fd: SimpleNamespace(
                    st_mode=stat.S_IFIFO | 0o600, st_dev=7, st_ino=fd)))
                stack.enter_context(patch.object(W.os, 'get_blocking', return_value=False))
                stack.enter_context(patch.object(W.os, 'fpathconf', return_value=512))
                close = stack.enter_context(patch.object(W.os, 'close'))
                if frontier == 'constructing':
                    stack.enter_context(patch.object(I.os, 'fpathconf', side_effect=KeyboardInterrupt('construct')))
                else:
                    def interrupt(instance, name, value):
                        object.__setattr__(instance, name, value)
                        if name == 'root_pipes' and type(value) is I._RolePipes:
                            raise KeyboardInterrupt('adopted')
                    stack.enter_context(patch.object(W._WrapperParent, '__setattr__', interrupt))
                with self.assertRaises(KeyboardInterrupt):
                    owner.adopt_role_pipes(I, output_birth=(7, 31), input_birth=(7, 30))
                if frontier == 'constructing':
                    self.assertEqual(owner.root_pipes, (30, 31))
                else:
                    self.assertIs(type(owner.root_pipes), I._RolePipes)
                    self.assertEqual((owner.root_pipes.read_fd, owner.root_pipes.write_fd), (31, 30))
                owner._close_channels()
                owner._close_channels()
                self.assertCountEqual(close.call_args_list, [call(30), call(31)])
                self.assertIsNone(owner.root_pipes)

    def test_adopted_real_pipes_allow_input_eof_while_output_is_still_owned(self):
        owner = self.wrapper_for_adoption()
        with ExitStack() as held:
            child_read, root_write = os.pipe()
            held.callback(os.close, child_read)
            with ExitStack() as setup:
                setup.callback(os.close, root_write)
                root_read, child_write = os.pipe()
                setup.callback(os.close, root_read)
                child_output = held.enter_context(os.fdopen(child_write, 'wb', buffering=0))
                for fd in (child_read, root_write, root_read):
                    os.set_blocking(fd, False)
                owner.root_pipes, owner.stock_seen = (root_write, root_read), True
                held.callback(owner._close_channels)
                setup.pop_all()
            with patch.object(owner, '_root_pipe_pair'):
                self.assertEqual(owner.borrow_role_pipes(), (root_read, root_write))
                pipe = owner.adopt_role_pipes(I, output_birth=I._pipe_birth(root_read),
                                              input_birth=I._pipe_birth(root_write))
            self.assertIs(owner.root_pipes, pipe)
            with self.assertRaisesRegex(W.Refused, '^wrapper-parent-pipe-transfer$'):
                owner.take_role_pipes()
            clock = SimpleNamespace(remaining=Mock(return_value=0.01))
            with patch.object(W.os, 'close', wraps=os.close) as close:
                pipe.close_input()
                self.assertEqual(os.read(child_read, 1), b'')
                self.assertEqual(pipe.read_fd, root_read)
                child_output.write(b'probe-ready\n')
                self.assertEqual(pipe.frame(clock, 42), b'probe-ready\n')
                child_output.close()
                pipe.require_eof(clock, 42)
                pipe.close()
                owner._close_channels()
                self.assertEqual(close.call_args_list, [call(root_write), call(root_read)])


if __name__ == '__main__':
    unittest.main()
