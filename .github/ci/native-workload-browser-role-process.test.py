"""Ordering and refusal models for the fixed role-process join."""

import importlib.util
import pathlib
import unittest
from contextlib import ExitStack, contextmanager
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


def sibling(leaf):
    name = 'native-workload-browser-' + leaf
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


J, H, P, G = (sibling(leaf) for leaf in ('role-process', 'host', 'launch-plan', 'preimport-gate'))
R, W, L, V, F = (sibling(leaf) for leaf in (
    'manager-reference', 'wrapper-parent', 'runtime-layout', 'service-view', 'synthetic-stage',
))
RUN, START, PID = '123', 20, 43
NS = START * 1_000_000_000
INVOCATION = bytes(range(16))
ROOT = '/run/aihr-browser-capability-' + RUN
CREDENTIAL = (ROOT + '/private/observer', b'aihr-browser-isolation-v1:123\n')
SPKI = 'A' * 43 + '='


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
        self.mounts, self.installer = ModuleType('mount-model'), ModuleType('installer-model')
        self.installer._state = lambda fd: {38: ('stage',), 37: ('node',)}.get(fd)
        self.layout = object.__new__(L._Layout)
        self.layout.run_id, self.layout.root, self.layout.ready, self.layout.stage = RUN, ROOT, True, 38
        self.layout.host, self.layout.mounts, self.layout.view = H, self.mounts, self.view
        self.layout.inspect_fixed = Mock(side_effect=self.inspect_layout)
        self.stage = F.SyntheticStageSnapshot(('stage',), ())
        self.node_row = F.SealedStageMember('node', 'file', 0o555, 1, '0' * 64, ('node',))
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
        self.wrapper.take_role_pipes = Mock(side_effect=self.transfer)
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

    def stock_observed_externally(self):
        self.events.append('external-stock-proof')
        self.wrapper.ack_attempted = self.wrapper.ack_sent = self.wrapper.stock_seen = True

    def transfer(self):
        self.events.append('pipes')
        return 41, 42

    @contextmanager
    def own(self, fd):
        self.events.append(('own', fd))
        try:
            yield fd
        finally:
            self.events.append(('close', fd))

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
            stack.enter_context(patch.object(J.os, 'fstat', side_effect=lambda fd: fd))
            stack.enter_context(patch.object(J.os, 'get_inheritable', return_value=False))
            stack.enter_context(patch.object(V, '_stage_rows', return_value={'node': {'node': self.node_row}}))
            stack.enter_context(patch.object(H, 'held_synthetic_main', self.held_main))
            stack.enter_context(patch.object(V, 'observe_service_view', self.observe))
            yield stack.enter_context(J.held_role_process(
                H, self.mounts, self.view, P, self.installer, F, V, R, W, L,
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
                    model.stock_observed_externally()
                    with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION) as verified:
                        self.assertEqual(verified, (model.main, model.manager_main, model.service, 41, 42))
                        model.events.append('handoff')
                self.assertEqual(model.events, [
                    ('layout', START + model.frontier), ('ready', True), ('absent', role, model.frontier),
                    'external-stock-proof', 'stock-identity', 'pipes', ('own', 41), ('own', 42),
                    ('hold', PID, role, RUN, model.gate_argv), ('retain', role, INVOCATION, model.frontier),
                    ('view', role, model.main), ('bind', role, INVOCATION, PID, NS + 1, model.frontier),
                    'handoff', 'main-closed', ('close', 42), ('close', 41),
                ])
                model.wrapper.settle.assert_not_called()

    def test_out_of_order_join_does_not_take_pipes_and_settles_only_wrapper(self):
        model = RoleProcessModel('driver')
        with self.assertRaisesRegex(J.Refused, 'role-process-main-order') as refused:
            with model.run() as owner:
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('held before absence')
        model.wrapper.take_role_pipes.assert_not_called()
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
                model.stock_observed_externally()
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('handed off a refused invocation')
        self.assertIs(refused.exception, primary)
        self.assertEqual(primary.__notes__, ['role-process-manager-and-service-settlement-unproved',
                                             'role-process-wrapper-settlement-unproved'])
        self.assertEqual(model.events[-3:], ['main-closed', ('close', 42), ('close', 41)])
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
                        model.stock_observed_externally()
                        with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                            self.fail('handed off a mismatched process')
                self.assertEqual(model.manager.bind_live_main.call_count, 0 if broken_view else 1)
                self.assertEqual(model.events[-4:], [
                    'main-closed', ('close', 42), ('close', 41), ('settle-wrapper', True),
                ])

    def test_final_role_clock_refuses_even_after_all_observations(self):
        model = RoleProcessModel('driver')

        def bind(*args):
            model.remaining = 0
            return model.bind(*args)

        model.manager.bind_live_main.side_effect = bind
        with self.assertRaisesRegex(H.Refused, 'model deadline'):
            with model.run() as owner:
                owner.before_request()
                model.stock_observed_externally()
                with owner.hold_main(candidate_pid=PID, candidate_invocation=INVOCATION):
                    self.fail('handed off beyond fixed frontier')
        model.wrapper.settle.assert_called_once_with(terminate=True)

    def test_early_exit_after_possible_request_remains_uncertain(self):
        model = RoleProcessModel('driver')
        with self.assertRaisesRegex(J.Refused, 'role-process-not-joined') as refused:
            with model.run() as owner:
                owner.before_request()
                model.stock_observed_externally()
        model.wrapper.take_role_pipes.assert_not_called()
        model.wrapper.settle.assert_called_once_with(terminate=True)
        self.assertEqual(refused.exception.__notes__, ['role-process-manager-and-service-settlement-unproved'])


if __name__ == '__main__':
    unittest.main()
