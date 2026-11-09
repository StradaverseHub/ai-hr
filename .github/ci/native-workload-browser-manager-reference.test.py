"""Source models for the manager-reference contract. No broker or processes."""

import pathlib
import unittest
from types import ModuleType
from unittest.mock import patch


path = pathlib.Path(__file__).with_name('native-workload-browser-manager-reference.py')
M = ModuleType('native_browser_manager_reference_model')
exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), M.__dict__)

START = 10_000_000_000
SECOND = 1_000_000_000
PEER = M.ManagerBinding(9, 31, ':1.90', ':1.2', 1, 0, 123)
INVOCATION = bytes(range(16))
OTHER_INVOCATION = bytes(reversed(range(16)))
MANAGER_PATH = '/org/freedesktop/systemd1'
UNIT = 'org.freedesktop.systemd1.Unit'


def reply(signature='', body=()):
    return M.ManagerReply(PEER, PEER.manager, 'return', signature, body)


def absent():
    return M.ManagerReply(PEER, PEER.manager, 'error', 's', (), 'org.freedesktop.systemd1.NoSuchUnit')


def unit_path(role):
    return f'{MANAGER_PATH}/unit/aihrbc_2d{role}_2d427_2eservice'


def loaded(role):
    return reply('o', (unit_path(role),))


def current(invocation=INVOCATION):
    return reply('v', ('ay', invocation))


SERVICE = 'org.freedesktop.systemd1.Service'
MAIN = 4321
BEFORE_LAUNCH = START + 1234
LIVE_SAMPLE = BEFORE_LAUNCH + 4000
MAIN_START = BEFORE_LAUNCH // 1000
MAIN_EXIT = MAIN_START + 1000
STATE_CHANGE = MAIN_EXIT + 1
LIVE_FIELDS = (
    (UNIT, 'InvocationID', 'ay', INVOCATION),
    (SERVICE, 'MainPID', 'u', MAIN),
    (SERVICE, 'ExecMainPID', 'u', MAIN),
    (SERVICE, 'ExecMainStartTimestampMonotonic', 't', MAIN_START),
    (UNIT, 'InvocationID', 'ay', INVOCATION),
)
TERMINAL_BRACKET = (
    (UNIT, 'InvocationID', 'ay', INVOCATION),
    (UNIT, 'StateChangeTimestampMonotonic', 't', STATE_CHANGE),
    (UNIT, 'Job', '(uo)', (0, '/')),
)
TERMINAL_FIELDS = TERMINAL_BRACKET + (
    (UNIT, 'ActiveState', 's', 'inactive'),
    (UNIT, 'SubState', 's', 'dead'),
    (SERVICE, 'MainPID', 'u', 0),
    (SERVICE, 'ControlPID', 'u', 0),
    (SERVICE, 'ExecMainPID', 'u', MAIN),
    (SERVICE, 'ExecMainCode', 'i', 1),
    (SERVICE, 'ExecMainStatus', 'i', 0),
    (SERVICE, 'ExecMainStartTimestampMonotonic', 't', MAIN_START),
    (SERVICE, 'ExecMainExitTimestampMonotonic', 't', MAIN_EXIT),
    (SERVICE, 'Result', 's', 'success'),
) + TERMINAL_BRACKET


def property_replies(fields):
    return [reply('v', (signature, value)) for _interface, _name, signature, value in fields]


class ManagerReferenceModels(unittest.TestCase):
    def setUp(self):
        self.now = START
        self.events = []
        self.replies = []
        clock = patch.object(M, 'monotonic_ns', lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def exchange(self, request, deadline):
        self.events.append((request, deadline))
        self.assertTrue(self.replies, 'unexpected exchange')
        result = self.replies.pop(0)
        return result() if callable(result) else result

    def owner(self, **changes):
        values = dict(run_id='427', started_ns=START, binding=PEER, exchange=self.exchange)
        return M.ManagerReference(**(values | changes))

    def hold(self, owner, role='driver'):
        self.replies.extend((absent(), loaded(role), current(), reply(), current()))
        owner.before_launch(role, 16)
        owner.retain(role, INVOCATION, 32)
        self.assertEqual(owner.phase(role), 'held')

    def test_one_connection_uses_only_fixed_calls_across_all_three_roles(self):
        owner = self.owner()
        for role, grant, terminal in (('driver', 32, 75), ('browser', 32, 75), ('third', 42, 42)):
            with self.subTest(role=role):
                self.events.clear()
                self.replies.extend((absent(), loaded(role), current(), reply(), current(),
                                     current(), reply(), loaded(role), absent()))
                owner.before_launch(role, 16)
                owner.retain(role, INVOCATION, grant)
                owner.release_after_terminal(role, INVOCATION, terminal)
                self.assertEqual(owner.phase(role), 'unref-acknowledged')
                self.assertFalse(owner.collected(role, terminal))
                self.assertTrue(owner.collected(role, terminal))
                self.assertEqual(owner.phase(role), 'collected')
                native = [(q.destination, q.path, q.interface, q.member, q.signature, q.body) for q, _ in self.events]
                path = unit_path(role)
                get = (PEER.manager, MANAGER_PATH, 'org.freedesktop.systemd1.Manager', 'GetUnit', 's', (f'aihrbc-{role}-427.service',))
                identity = (PEER.manager, path, 'org.freedesktop.DBus.Properties', 'Get', 'ss', (UNIT, 'InvocationID'))
                self.assertEqual(native, [get, get, identity, (PEER.manager, path, UNIT, 'Ref', '', ()),
                                          identity, identity, (PEER.manager, path, UNIT, 'Unref', '', ()), get, get])
                self.assertEqual([ns for _, ns in self.events],
                                 [START + step * SECOND for step in (16, grant, grant, grant, grant,
                                                                  terminal, terminal, terminal, terminal)])
                self.assertEqual(self.replies, [])

    def test_rejects_unbound_peer_bad_run_and_wrong_role_frontier_or_order_before_io(self):
        for peer in (PEER._replace(manager_pid=True), PEER._replace(manager_uid=65534), PEER._replace(socket_inode=0),
                     PEER._replace(manager=PEER.client), PEER._replace(manager='org.freedesktop.systemd1')):
            with self.subTest(peer=peer), self.assertRaisesRegex(M.Refused, 'manager-reference-binding'):
                self.owner(binding=peer)
        for run_id in ('0427', '427\n', '427.service', '9007199254740992'):
            with self.subTest(run_id=run_id), self.assertRaisesRegex(M.Refused, 'manager-reference-run'):
                self.owner(run_id=run_id)
        owner = self.owner()
        with self.assertRaisesRegex(M.Refused, 'manager-reference-role'):
            owner.before_launch('foreign', 16)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-frontier'):
            owner.before_launch('driver', 42)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-frontier'):
            owner.before_launch('third', 42.0)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-order'):
            owner.retain('third', INVOCATION, 42)
        self.assertEqual(self.events, [])

    def test_prelaunch_refuses_any_loaded_name_and_any_nonmatching_object_path(self):
        for response, reason in ((loaded('driver'), 'unit-present'), (loaded('browser'), 'object')):
            with self.subTest(reason=reason):
                self.events.clear()
                self.replies.append(response)
                owner = self.owner()
                with self.assertRaisesRegex(M.Refused, reason):
                    owner.before_launch('driver', 16)
                self.assertEqual([q.member for q, _ in self.events], ['GetUnit'])
                self.assertEqual(owner.phase('driver'), 'new')

    def test_absence_requires_original_pinned_manager_error_shape_and_live_binding(self):
        for response in (absent()._replace(sender=':1.3'), absent()._replace(signature='ss'),
                         absent()._replace(body=('trailing',)), absent()._replace(error_name='org.freedesktop.DBus.Error.NoReply'),
                         absent()._replace(binding=PEER._replace(socket_inode=32)),
                         absent()._replace(binding=PEER._replace(manager_birth=124))):
            with self.subTest(response=response):
                self.events.clear()
                self.replies.append(response)
                owner = self.owner()
                with self.assertRaises(M.Refused):
                    owner.before_launch('driver', 16)
                with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
                    owner.before_launch('driver', 16)
                self.assertEqual(len(self.events), 1)

    def test_refuses_wrong_or_empty_live_invocation_before_ref(self):
        for response in (current(OTHER_INVOCATION), current(bytes(16)), current(bytes(15)), current()._replace(signature='ay')):
            with self.subTest(response=response):
                self.events.clear()
                owner = self.owner()
                self.replies.extend((absent(), loaded('driver'), response))
                owner.before_launch('driver', 16)
                with self.assertRaisesRegex(M.Refused, 'manager-reference-invocation'):
                    owner.retain('driver', INVOCATION, 32)
                self.assertEqual([q.member for q, _ in self.events], ['GetUnit', 'GetUnit', 'Get'])

    def test_acknowledged_ref_requires_post_ref_invocation_before_grant(self):
        owner = self.owner()
        self.replies.extend((absent(), loaded('driver'), current(), reply(), current(OTHER_INVOCATION)))
        owner.before_launch('driver', 16)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-invocation-changed'):
            owner.retain('driver', INVOCATION, 32)
        self.assertEqual(owner.phase('driver'), 'ref-acknowledged')
        with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
            owner.release_after_terminal('driver', INVOCATION, 75)
        self.assertEqual([q.member for q, _ in self.events], ['GetUnit', 'GetUnit', 'Get', 'Ref', 'Get'])

    def test_late_ref_ack_is_uncertain_and_never_retried(self):
        owner = self.owner()

        def late_ref():
            self.assertEqual(owner.phase('driver'), 'ref-attempted')
            self.now = START + 32 * SECOND
            return reply()

        self.replies.extend((absent(), loaded('driver'), current(), late_ref))
        owner.before_launch('driver', 16)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-deadline'):
            owner.retain('driver', INVOCATION, 32)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
            owner.retain('driver', INVOCATION, 32)
        self.assertEqual(owner.phase('driver'), 'ref-attempted')
        self.assertEqual([q.member for q, _ in self.events], ['GetUnit', 'GetUnit', 'Get', 'Ref'])

    def test_uncertain_unref_preserves_attempt_and_does_not_admit_collection(self):
        for failure in (reply('s', ('unexpected',)), reply()._replace(sender=':1.3')):
            with self.subTest(failure=failure):
                owner = self.owner()
                self.events.clear()
                self.hold(owner)
                self.replies.extend((current(), failure))
                with self.assertRaises(M.Refused):
                    owner.release_after_terminal('driver', INVOCATION, 75)
                self.assertEqual(owner.phase('driver'), 'unref-attempted')
                with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
                    owner.collected('driver', 75)
                self.assertEqual([q.member for q, _ in self.events].count('Unref'), 1)

    def test_terminal_requires_same_native_invocation_before_unref(self):
        owner = self.owner()
        self.hold(owner)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-terminal-invocation'):
            owner.release_after_terminal('driver', OTHER_INVOCATION, 75)
        self.replies.append(current(OTHER_INVOCATION))
        with self.assertRaisesRegex(M.Refused, 'manager-reference-invocation-changed'):
            owner.release_after_terminal('driver', INVOCATION, 75)
        self.assertEqual(owner.phase('driver'), 'held')
        self.assertNotIn('Unref', [q.member for q, _ in self.events])

    def test_transport_failure_hides_raw_details_and_does_not_become_absence(self):
        owner = self.owner()

        def disconnected():
            raise OSError('raw native details')

        self.replies.append(disconnected)
        with self.assertRaisesRegex(M.Refused, '^manager-reference-transport$'):
            owner.before_launch('driver', 16)
        self.assertEqual(owner.phase('driver'), 'new')
        self.assertEqual(len(self.events), 1)

    def test_reentrant_exchange_and_expired_frontier_admit_no_additional_call(self):
        owner = self.owner()

        def first_reply():
            with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
                owner.before_launch('browser', 16)
            return absent()

        self.replies.append(first_reply)
        owner.before_launch('driver', 16)
        self.now = START + 16 * SECOND
        with self.assertRaisesRegex(M.Refused, 'manager-reference-deadline'):
            owner.before_launch('browser', 16)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
            owner.before_launch('browser', 32)
        self.assertEqual(len(self.events), 1)

    def bind_typed(self, owner, role='driver'):
        self.hold(owner, role)
        self.events.clear()
        self.now = LIVE_SAMPLE
        self.replies.extend(property_replies(LIVE_FIELDS))
        return owner.bind_live_main(role, INVOCATION, MAIN, BEFORE_LAUNCH, 42 if role == 'third' else 32)

    def assert_typed_wire(self, role, fields, frontier):
        self.assertEqual([(q.destination, q.path, q.interface, q.member, q.signature, q.body, deadline)
                          for q, deadline in self.events],
                         [(PEER.manager, unit_path(role), 'org.freedesktop.DBus.Properties', 'Get', 'ss',
                           (interface, name), START + frontier * SECOND)
                          for interface, name, _signature, _value in fields])
        self.assertEqual(self.replies, [])

    def test_typed_live_and_terminal_passes_use_only_the_fixed_role_wire(self):
        for role, live, terminal in (('driver', 32, 75), ('browser', 32, 75), ('third', 42, 42)):
            with self.subTest(role=role):
                self.now = START
                owner = self.owner()
                main = self.bind_typed(owner, role)
                self.assertEqual(main, M.LiveMain(PEER, unit_path(role), INVOCATION, MAIN, MAIN_START,
                                                 LIVE_SAMPLE // 1000))
                self.assert_typed_wire(role, LIVE_FIELDS, live)
                self.events.clear()
                self.now = (STATE_CHANGE + 1) * 1000
                self.replies.extend(property_replies(TERMINAL_FIELDS))
                status = owner.observe_terminal(role, INVOCATION, terminal)
                self.assertEqual(status, M.ServiceTerminal(main, 'inactive', 'dead', 'success', 1, 0,
                                                           MAIN_EXIT, STATE_CHANGE))
                self.assertTrue(status.normal)
                self.assert_typed_wire(role, TERMINAL_FIELDS, terminal)
                self.assertEqual(owner.phase(role), 'held')
                with self.assertRaises(AttributeError):
                    status.exit_us = 0

    def test_typed_observation_requires_exact_held_role_live_baseline_and_one_attempt(self):
        owner = self.owner()
        self.hold(owner, 'third')
        self.events.clear()
        with self.assertRaisesRegex(M.Refused, 'live-main-required'):
            owner.observe_terminal('third', INVOCATION, 42)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-role'):
            owner.bind_live_main('foreign', INVOCATION, MAIN, BEFORE_LAUNCH, 32)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-frontier'):
            owner.bind_live_main('third', INVOCATION, MAIN, BEFORE_LAUNCH, 56)
        with self.assertRaisesRegex(M.Refused, 'observation-invocation'):
            owner.bind_live_main('third', OTHER_INVOCATION, MAIN, BEFORE_LAUNCH, 42)
        with self.assertRaisesRegex(M.Refused, 'live-main-input'):
            owner.bind_live_main('third', INVOCATION, True, BEFORE_LAUNCH, 42)
        self.assertEqual(self.events, [])
        self.now = LIVE_SAMPLE
        self.replies.extend(property_replies(LIVE_FIELDS))
        owner.bind_live_main('third', INVOCATION, MAIN, BEFORE_LAUNCH, 42)
        with self.assertRaisesRegex(M.Refused, 'observation-already-attempted'):
            owner.bind_live_main('third', INVOCATION, MAIN, BEFORE_LAUNCH, 42)
        self.assert_typed_wire('third', LIVE_FIELDS, 42)
        self.events.clear()
        with self.assertRaisesRegex(M.Refused, 'manager-reference-frontier'):
            owner.observe_terminal('third', INVOCATION, 75)
        with self.assertRaisesRegex(M.Refused, 'live-main-required'):
            owner.observe_terminal('browser', INVOCATION, 75)
        with self.assertRaisesRegex(M.Refused, 'observation-invocation'):
            owner.observe_terminal('third', OTHER_INVOCATION, 42)
        self.assertEqual(self.events, [])
        self.now = (STATE_CHANGE + 1) * 1000
        self.replies.extend(property_replies(TERMINAL_FIELDS))
        owner.observe_terminal('third', INVOCATION, 42)
        with self.assertRaisesRegex(M.Refused, 'observation-already-attempted'):
            owner.observe_terminal('third', INVOCATION, 42)
        self.assert_typed_wire('third', TERMINAL_FIELDS, 42)

    def test_live_pid_invocation_and_raw_start_must_match_the_owned_prelaunch_sample(self):
        for index, bad, reason in (
            (1, reply('v', ('u', True)), 'property-integer'),
            (1, reply('v', ('u', MAIN + 1)), 'live-main-pid'),
            (2, reply('v', ('u', 1 << 32)), 'property-integer'),
            (3, reply('v', ('t', MAIN_START - 1)), 'live-main-clock'),
            (3, reply('v', ('t', MAIN_START + 5)), 'live-main-clock'),
            (3, reply('v', ('t', 1 << 64)), 'property-integer'),
            (4, current(OTHER_INVOCATION), 'invocation-changed'),
        ):
            with self.subTest(index=index, reason=reason):
                self.now = START
                owner = self.owner()
                self.hold(owner)
                self.events.clear()
                self.now = LIVE_SAMPLE
                self.replies = property_replies(LIVE_FIELDS)
                self.replies[index] = bad
                with self.assertRaisesRegex(M.Refused, reason):
                    owner.bind_live_main('driver', INVOCATION, MAIN, BEFORE_LAUNCH, 32)
                after = len(self.events)
                self.assertGreaterEqual(after, index + 1)
                self.assertEqual(owner.phase('driver'), 'held')
                with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
                    owner.bind_live_main('driver', INVOCATION, MAIN, BEFORE_LAUNCH, 32)
                self.assertEqual(len(self.events), after)
                self.replies.clear()

    def test_typed_pass_refuses_reentrancy_and_early_late_or_regressed_clocks(self):
        for now, reason in (
            (BEFORE_LAUNCH - 1, 'observation-clock'),
            (START + 32 * SECOND, 'manager-reference-deadline'),
        ):
            with self.subTest(now=now):
                self.now = START
                owner = self.owner()
                self.hold(owner)
                self.events.clear()
                self.now = BEFORE_LAUNCH

                def drift():
                    with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
                        owner.release_after_terminal('driver', INVOCATION, 75)
                    self.now = now
                    return current()

                self.replies.append(drift)
                with self.assertRaisesRegex(M.Refused, reason):
                    owner.bind_live_main('driver', INVOCATION, MAIN, BEFORE_LAUNCH, 32)
                self.assertEqual(len(self.events), 1)
                self.assertEqual(owner.phase('driver'), 'held')
        self.now = START
        owner = self.owner()
        self.hold(owner)
        self.events.clear()
        with self.assertRaisesRegex(M.Refused, 'live-main-clock'):
            owner.bind_live_main('driver', INVOCATION, MAIN, BEFORE_LAUNCH, 32)
        self.assertEqual(self.events, [])

    def test_typed_terminal_refuses_mixed_identity_jobs_raw_shape_or_nonterminal_state(self):
        for index, bad, reason in (
            (2, reply('v', ('(uo)', (False, '/'))), 'terminal-job'),
            (2, reply('v', ('(uo)', (0, '/org/freedesktop/systemd1/job/4'))), 'terminal-job'),
            (4, reply('v', ('s', 'dead-resources-pinned')), 'property-text'),
            (5, reply('v', ('u', MAIN)), 'terminal-pid'),
            (6, reply('v', ('u', 1)), 'terminal-pid'),
            (7, reply('v', ('u', MAIN + 1)), 'terminal-pid'),
            (8, reply('v', ('i', 1 << 31)), 'property-integer'),
            (8, reply('v', ('i', 4)), 'terminal-status'),
            (9, reply('v', ('i', 256)), 'terminal-status'),
            (10, reply('v', ('t', MAIN_START + 1)), 'terminal-clock'),
            (11, reply('v', ('t', MAIN_START)), 'terminal-clock'),
            (11, reply('v', ('t', MAIN_START + 1)), 'terminal-clock'),
            (11, reply('v', ('t', STATE_CHANGE + 1)), 'terminal-clock'),
            (12, reply('v', ('s', 'exit-code')), 'terminal-state'),
            (13, current(OTHER_INVOCATION), 'invocation-changed'),
            (14, reply('v', ('t', STATE_CHANGE + 1)), 'terminal-bracket'),
            (15, reply('v', ('(uo)', (1, '/org/freedesktop/systemd1/job/4'))), 'terminal-job'),
            (15, reply('v', ('(uo)', (0, '/'), 'trailing')), 'property-variant'),
            (15, reply('v', ('(uo)', (0, '/')))._replace(sender=':1.3'), 'reply-identity'),
            (15, absent(), 'method-refused'),
        ):
            with self.subTest(index=index, reason=reason):
                self.now = START
                owner = self.owner()
                self.bind_typed(owner)
                self.events.clear()
                self.now = (STATE_CHANGE + 1) * 1000
                self.replies = property_replies(TERMINAL_FIELDS)
                self.replies[index] = bad
                with self.assertRaisesRegex(M.Refused, reason):
                    owner.observe_terminal('driver', INVOCATION, 75)
                self.assertGreaterEqual(len(self.events), index + 1)
                self.assertEqual(owner.phase('driver'), 'held')
                self.assertTrue(all(q.member == 'Get' for q, _ in self.events))
                self.replies.clear()

    def test_late_terminal_reply_does_not_become_success_or_authorize_unref(self):
        owner = self.owner()
        self.bind_typed(owner)
        self.events.clear()
        self.now = (STATE_CHANGE + 1) * 1000
        self.replies = property_replies(TERMINAL_FIELDS)

        def late():
            self.now = START + 75 * SECOND
            return reply('v', ('(uo)', (0, '/')))

        self.replies[-1] = late
        with self.assertRaisesRegex(M.Refused, 'manager-reference-deadline'):
            owner.observe_terminal('driver', INVOCATION, 75)
        with self.assertRaisesRegex(M.Refused, 'manager-reference-unavailable'):
            owner.release_after_terminal('driver', INVOCATION, 75)
        self.assert_typed_wire('driver', TERMINAL_FIELDS, 75)
        self.assertEqual(owner.phase('driver'), 'held')

    def test_nonnormal_terminal_is_raw_evidence_even_when_result_is_success(self):
        for active, sub, result, code, status in (
            ('inactive', 'dead', 'success', 2, 15),
            ('inactive', 'dead', 'success', 1, 7),
            ('failed', 'failed', 'exit-code', 1, 9),
            ('failed', 'failed', 'core-dump', 3, 11),
        ):
            with self.subTest(result=result, code=code, status=status):
                self.now = START
                owner = self.owner()
                main = self.bind_typed(owner)
                self.events.clear()
                self.now = (STATE_CHANGE + 1) * 1000
                self.replies = property_replies(TERMINAL_FIELDS)
                for index, signature, value in ((3, 's', active), (4, 's', sub), (8, 'i', code),
                                                (9, 'i', status), (12, 's', result)):
                    self.replies[index] = reply('v', (signature, value))
                observed = owner.observe_terminal('driver', INVOCATION, 75)
                self.assertEqual(observed, M.ServiceTerminal(main, active, sub, result, code, status,
                                                             MAIN_EXIT, STATE_CHANGE))
                self.assertFalse(observed.normal)
                self.assertEqual(owner.phase('driver'), 'held')
                self.assert_typed_wire('driver', TERMINAL_FIELDS, 75)


if __name__ == '__main__':
    unittest.main()
