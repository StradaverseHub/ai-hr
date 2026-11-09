"""Deterministic controls over the inert owner. No commands, sockets, proc or DB."""
import ast
import copy
import fcntl
import importlib.util
import io
import json
import pathlib
import stat
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

PATH = pathlib.Path(__file__).with_name('native-workload-browser-host.py')
SPEC = importlib.util.spec_from_file_location('native_browser_host_model', PATH)
H = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(H)
NAME = 'aihrbc_123_0123456789abcdef'
HEADER = b'  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'


def data(rows):
    return json.dumps({'nftables': [{'metainfo': {'json_schema_version': 1}}, *rows]}).encode()


def kernel_rows():
    rows = []
    for index, (kind, spec) in enumerate(H.firewall_spec(NAME), 1):
        row = copy.deepcopy(spec)
        row['handle'] = index
        if kind == 'rule':
            row['expr'][-2] = {'counter': {'packets': 1, 'bytes': 60}}
        rows.append({kind: row})
    return rows


def frame(op, **fields):
    return (json.dumps({'op': op, **fields}, separators=(',', ':')) + '\n').encode()


def listener(address=b'0100007F', uid=62121, inode=99):
    return b'  0: ' + address + b':0D74 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ' + str(uid).encode() + b' 0 ' + str(inode).encode() + b'\n'


class BrowserHostModel(unittest.TestCase):
    def test_final_control_deny_checks_only_actual_listener_before_any_other_role_allow(self):
        rules = H.firewall_rules()['output']
        self.assertEqual([row[0] for row in rules[:3]], ['driver-control', 'control-final-denied', 'control-retarget-denied'])
        allowed = rules[0][1]
        final = rules[1][1]
        self.assertIn({'match': {'op': '==', 'left': {'meta': {'key': 'skuid'}}, 'right': 62120}}, allowed)
        self.assertIn({'match': {'op': '==', 'left': {'ct': {'key': 'daddr', 'family': 'ip', 'dir': 'original'}},
                                 'right': '127.0.0.1'}}, allowed)
        self.assertEqual(final, [
            {'match': {'op': '==', 'left': {'meta': {'key': 'nfproto'}}, 'right': 'ipv4'}},
            {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'ip', 'field': 'daddr'}}, 'right': '127.0.0.1'}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': 3444}},
        ])
        self.assertEqual(rules[1][2], {'reject': {'type': 'tcp reset'}})
        self.assertEqual(H.firewall_rules()['input'][0][1][-1],
                         {'match': {'op': '!=', 'left': {'meta': {'key': 'iifname'}}, 'right': 'lo'}})

    def test_browser_reply_has_original_connection_proof_and_only_exact_allowlisted_ports(self):
        rows = {label: expr for label, expr, _ in H.firewall_rules()['output']}
        reply = rows['browser-control-reply']
        self.assertIn({'match': {'op': '==', 'left': {'ct': {'key': 'direction'}}, 'right': 'reply'}}, reply)
        self.assertIn({'match': {'op': '==', 'left': {'ct': {'key': 'state'}}, 'right': 'established'}}, reply)
        self.assertIn({'match': {'op': '==', 'left': {'ct': {'key': 'proto-dst', 'dir': 'original'}}, 'right': 3444}}, reply)
        self.assertIn({'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'sport'}}, 'right': 3444}}, reply)
        self.assertEqual([r for r in H.firewall_rules()['output'] if r[2] == {'accept': None}][0][0], 'driver-control')
        self.assertEqual(set(label for label, _, verdict in H.firewall_rules()['output'] if verdict == {'accept': None}),
                         {'driver-control', 'browser-ingress', 'browser-control-reply', 'driver-postgres'})

    def test_terminal_base_hooks_refuse_competitors(self):
        for hook in ('input', 'output'):
            with self.subTest(hook=hook):
                chain = {'family': 'ip', 'table': 'elsewhere', 'name': 'foreign', 'hook': hook, 'prio': 2147483647}
                with self.assertRaisesRegex(H.Refused, 'competing-terminal-hook'):
                    H.require_terminal_hooks(data([{'chain': chain}]), NAME)
                chain['prio'] = -100
                H.require_terminal_hooks(data([{'chain': chain}]), NAME)
        owned = [row for row in kernel_rows() if 'chain' in row]
        H.require_terminal_hooks(data(owned), NAME)
        with self.assertRaisesRegex(H.Refused, 'competing-terminal-hook'):
            H.require_terminal_hooks(data(owned))

    def test_readback_checks_exact_order_counter_shape_and_rule_bytes(self):
        rows = kernel_rows()
        handles, counts = H.firewall_readback(NAME, data(rows))
        self.assertEqual(len(handles), 13)
        self.assertEqual(set(counts), {label for rules in H.firewall_rules().values() for label, *_ in rules})
        self.assertEqual(counts['control-final-denied'], {'packets': 1, 'bytes': 60})
        changed = copy.deepcopy(rows)
        changed[2], changed[3] = changed[3], changed[2]
        with self.assertRaisesRegex(H.Refused, 'firewall-rule-differs|firewall-expression-differs'):
            H.firewall_readback(NAME, data(changed))
        changed = copy.deepcopy(rows)
        changed[3]['rule']['expr'][-2]['counter']['packets'] = True
        with self.assertRaisesRegex(H.Refused, 'invalid-firewall-counter'):
            H.firewall_readback(NAME, data(changed))
        with self.assertRaisesRegex(H.Refused, 'firewall-census-differs'):
            H.firewall_readback(NAME, data(rows[:-1]))

    def test_counter_windows_refuse_missing_moved_and_unattributed_events(self):
        before = {'driver-control': 4, 'control-final-denied': 0, 'browser-postgres-denied': 0}
        after = dict(before, **{'control-final-denied': 1, 'browser-postgres-denied': 1})
        H.counter_window(before, after, {'control-final-denied', 'browser-postgres-denied'})
        for bad in (before, dict(after, **{'driver-control': 5}), {'control-final-denied': 1}):
            with self.subTest(bad=bad), self.assertRaises(H.Refused):
                H.counter_window(before, bad, {'control-final-denied', 'browser-postgres-denied'})

    def test_role_policy_keeps_direct_socket_abi_and_ring_fences(self):
        for role, budget in (('driver', ('512M', '64')), ('browser', ('2048M', '512'))):
            with self.subTest(role=role):
                policy = H.role_properties(role)
                self.assertEqual((policy['MemoryMax'], policy['TasksMax']), budget)
                self.assertEqual(policy['RestrictAddressFamilies'], 'AF_INET')
                self.assertEqual(policy['SystemCallArchitectures'], 'native')
                self.assertEqual(policy['SystemCallFilter'], '~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM')
                self.assertEqual((policy['CapabilityBoundingSet'], policy['Delegate'], policy['Restart']), ('', 'no', 'no'))
        with self.assertRaisesRegex(H.Refused, 'invalid-systemd-role'):
            H.role_properties('root')

    def test_exact_seventeen_frame_course_requires_final_role_exit_messages(self):
        ledger = H.Frames()
        fields = {'observer-ready': {'pid': 12, 'tag': 'aihrbc_0123456789abcdef'},
                  'listener-ready': {'pid': 13}, 'probe-ready': {'pid': 14}, 'deny-prepare': {'pid': 15},
                  'negatives-complete': {'checks': H.PROBE_CHECKS}, 'ingress-complete': {'status': 200}}
        self.assertEqual(len(H.FRAME_ORDER), 17)
        self.assertLess(H.FRAME_ORDER.index(('third', 'child', 'control-denied')),
                        H.FRAME_ORDER.index(('driver', 'root', 'connect')))
        for role, direction, op in H.FRAME_ORDER:
            self.assertFalse(ledger.complete())
            ledger.accept(role, direction, frame(op, **fields.get(op, {})))
        self.assertTrue(ledger.complete())
        with self.assertRaisesRegex(H.Refused, 'unexpected-capability-frame'):
            ledger.accept('third', 'child', frame('control-denied'))

    def test_frame_refuses_wrong_order_duplicates_size_false_pid_and_incomplete_probe(self):
        ledger = H.Frames()
        with self.assertRaisesRegex(H.Refused, 'unexpected-capability-frame-direction'):
            ledger.accept('driver', 'root', frame('observer-ready', pid=12, tag='aihrbc_0123456789abcdef'))
        ledger.accept('driver', 'child', frame('observer-ready', pid=12, tag='aihrbc_0123456789abcdef'))
        for bad in (frame('stop'), frame('listener-ready', pid=True), frame('listener-ready', pid=11, url='unsafe'),
                    b'{"op":"listener-ready","pid":12,"pid":13}\n', b'x' * 512 + b'\n'):
            with self.subTest(bad=bad[:50]), self.assertRaises(H.Refused):
                ledger.accept('browser', 'child', bad)
        self.assertEqual(ledger.accept('browser', 'child', frame('listener-ready', pid=11))['pid'], 11)
        with self.assertRaisesRegex(H.Refused, 'invalid-probe-census'):
            H.decode_frame(frame('negatives-complete', checks=H.PROBE_CHECKS[:-1]), 'negatives-complete')

    def test_only_one_real_address_and_owner_can_name_the_listener(self):
        self.assertEqual(H.listener_inode(HEADER + listener(), HEADER, 3444, 62121), 99)
        for v4, v6 in ((HEADER, HEADER), (HEADER + listener(uid=62120), HEADER),
                       (HEADER + listener(b'00000000'), HEADER),
                       (HEADER + listener() + listener(inode=101), HEADER),
                       (HEADER + listener(), HEADER + listener(b'0' * 32))):
            with self.subTest(v4=v4, v6=v6), self.assertRaises(H.Refused):
                H.listener_inode(v4, v6, 3444, 62121)

    def test_role_census_includes_all_uid_gid_and_supplementary_slots(self):
        raw = b'Uid: 1000 1001 1002 1003\nGid: 2 3 4 5\nGroups: 20 62121\n'
        self.assertEqual(H._role_credentials(raw), {1000, 1001, 1002, 1003, 2, 3, 4, 5, 20, 62121})
        with self.assertRaisesRegex(H.Refused, 'incomplete-proc-credentials'):
            H._role_credentials(raw.split(b'Groups:')[0])

    def test_renderer_must_be_in_the_same_family_with_more_filters_and_both_namespaces_distinct(self):
        launcher = {'cgroupBirth': (3, 4), 'userNamespace': 1, 'pidNamespace': 2, 'seccompFilters': 2, 'argv': []}
        chromium = dict(launcher, seccompFilters=3)
        renderer = dict(launcher, userNamespace=10, pidNamespace=11, seccompFilters=4, argv=[b'--type=renderer'])
        H.require_renderer(renderer, launcher, chromium)
        for delta in ({'userNamespace': 1}, {'pidNamespace': 2}, {'seccompFilters': 3},
                      {'cgroupBirth': (3, 5)}, {'argv': [b'--type=utility']}):
            with self.subTest(delta=delta), self.assertRaisesRegex(H.Refused, 'native-renderer-sandbox-differs'):
                H.require_renderer(dict(renderer, **delta), launcher, chromium)
        H._id_map(b'0 62121 1\n', 62121)
        for raw in (b'0 0 1\n', b'0 62120 1\n', b'0 62121 2\n', b'0 62121 1\n1 0 1\n'):
            with self.subTest(raw=raw), self.assertRaises(H.Refused):
                H._id_map(raw, 62121)


class BrowserHostSettlementModel(unittest.TestCase):
    def test_failed_nft_retains_first_error_and_actual_uncertain_child_under_original_clock(self):
        for settled in (True, False):
            with self.subTest(settled=settled):
                owner = H.Firewall('123', '0123456789abcdef')
                clock = SimpleNamespace(remaining=Mock(side_effect=lambda frontier: {16: 1.25, 75: 0.3}[frontier]))
                child = SimpleNamespace(stdout=Mock(), poll=Mock(return_value=None), kill=Mock(), wait=Mock())
                if not settled:
                    child.wait.side_effect = H.subprocess.TimeoutExpired(['/usr/sbin/nft'], 0.3)
                with (patch.object(H.os, 'geteuid', return_value=0),
                      patch.object(H.tempfile, 'TemporaryFile', return_value=io.BytesIO()),
                      patch.object(H.subprocess, 'Popen', return_value=child) as launch,
                      patch.object(H.select, 'select', return_value=([], [], []))):
                    with self.assertRaisesRegex(H.Refused, '^firewall-command-timeout$') as error:
                        owner._nft(['list', 'chains'], clock, 16)
                    self.assertEqual(getattr(error.exception, '__notes__', []),
                                     [] if settled else ['firewall-child-settlement-unproved'])
                    self.assertIs(owner._child, None if settled else child)
                    child.kill.assert_called_once_with()
                    child.wait.assert_called_once_with(timeout=0.3)
                    child.stdout.close.assert_called_once_with()
                    self.assertEqual(clock.remaining.call_args_list, [call(16), call(16), call(16), call(75), call(75)])
                    if not settled:
                        with self.assertRaisesRegex(H.Refused, '^firewall-child-settlement-unproved$'):
                            owner._nft(['list', 'chains'], clock, 16)
                    launch.assert_called_once()

    def test_expired_cleanup_frontier_retains_child_without_late_signal_or_wait(self):
        owner = H.Firewall('123', '0123456789abcdef')
        child = SimpleNamespace(poll=Mock(return_value=None), kill=Mock(), wait=Mock())
        owner._child = child
        clock = SimpleNamespace(remaining=Mock(side_effect=H.Refused('capability-deadline')))
        with self.assertRaisesRegex(H.Refused, '^capability-deadline$'):
            owner._reap_failed_child(clock)
        self.assertIs(owner._child, child)
        child.kill.assert_not_called()
        child.wait.assert_not_called()
        clock.remaining.assert_called_once_with(75)

    def test_nft_reaped_nonzero_exit_refuses_without_another_signal(self):
        owner = H.Firewall('123', '0123456789abcdef')
        clock = SimpleNamespace(remaining=Mock(return_value=0.5))
        child = SimpleNamespace(stdout=Mock(), poll=Mock(), kill=Mock(), wait=Mock(return_value=2))
        child.stdout.fileno.return_value = 8
        with (patch.object(H.os, 'geteuid', return_value=0),
              patch.object(H.tempfile, 'TemporaryFile', return_value=io.BytesIO()),
              patch.object(H.subprocess, 'Popen', return_value=child),
              patch.object(H.select, 'select', return_value=([child.stdout], [], [])),
              patch.object(H.os, 'read', side_effect=(b'{}', b'')) as read):
            with self.assertRaisesRegex(H.Refused, '^firewall-command-refused$'):
                owner._nft(['list', 'chains'], clock, 16)
        self.assertIsNone(owner._child)
        child.wait.assert_called_once_with(timeout=0.5)
        child.kill.assert_not_called()
        child.stdout.close.assert_called_once_with()
        self.assertEqual(read.call_args_list, [call(8, 16384), call(8, 16384)])

    def test_expired_active_frontier_refuses_before_spawn(self):
        owner = H.Firewall('123', '0123456789abcdef')
        clock = SimpleNamespace(remaining=Mock(side_effect=H.Refused('capability-deadline')))
        with (patch.object(H.os, 'geteuid', return_value=0),
              patch.object(H.subprocess, 'Popen') as launch, self.assertRaisesRegex(H.Refused, 'capability-deadline')):
            owner._nft(['list', 'chains'], clock, 16)
        launch.assert_not_called()

    def test_late_zero_wait_refuses_after_clearing_the_proven_reap(self):
        for frontier in (16, 60, 75):
            with self.subTest(frontier=frontier):
                owner = H.Firewall('123', '0123456789abcdef')
                with patch.object(H.time, 'monotonic', return_value=100) as now:
                    clock = H.Deadline()
                    def wait(*, timeout):
                        self.assertEqual(timeout, frontier)
                        now.return_value = 100 + frontier
                        return 0
                    child = SimpleNamespace(stdout=Mock(), poll=Mock(), kill=Mock(), wait=Mock(side_effect=wait))
                    child.stdout.fileno.return_value = 8
                    with (patch.object(H.os, 'geteuid', return_value=0),
                          patch.object(H.tempfile, 'TemporaryFile', return_value=io.BytesIO()),
                          patch.object(H.subprocess, 'Popen', return_value=child) as launch,
                          patch.object(H.select, 'select', return_value=([child.stdout], [], [])),
                          patch.object(H.os, 'read', side_effect=(b'{}', b'')),
                          self.assertRaisesRegex(H.Refused, '^capability-deadline$')):
                        owner._nft(['list', 'tables'], clock, frontier)
                launch.assert_called_once()
                child.wait.assert_called_once_with(timeout=frontier)
                child.stdout.close.assert_called_once_with()
                self.assertIsNone(owner._child)
                child.poll.assert_not_called()
                child.kill.assert_not_called()

    def test_late_initial_readback_retains_protection_without_birth_proof(self):
        owner = H.Firewall('123', '0123456789abcdef')
        rows = kernel_rows()
        chains = data([])
        table = data(rows)
        readback = H.firewall_readback
        replies = iter((chains, b'', table))
        with patch.object(H.time, 'monotonic', return_value=100) as now:
            clock = H.Deadline()

            def native_reply(_args, active_clock, frontier, _input=None):
                self.assertIs(active_clock, clock)
                self.assertEqual(frontier, 16)
                active_clock.remaining(frontier)
                return next(replies)

            def late_initial_readback(name, raw):
                result = readback(name, raw)
                now.return_value = 116
                return result

            with (patch.object(owner, '_nft', side_effect=native_reply) as native,
                  patch.object(H, 'firewall_readback', side_effect=late_initial_readback) as parse,
                  patch.object(H, 'require_role_credentials_absent') as census,
                  patch.object(H, '_bounded_file', return_value=HEADER)):
                with self.assertRaisesRegex(H.Refused, '^capability-deadline$'):
                    owner.install(clock)
                with self.assertRaisesRegex(H.Refused, '^firewall-install-already-attempted$'):
                    owner.install(clock)
                with self.assertRaisesRegex(H.Refused, '^firewall-birth-unproved$'):
                    owner.remove_after_quiescence(clock)

        self.assertEqual([entry.args[:3] for entry in native.call_args_list], [
            (['list', 'chains'], clock, 16),
            (['-f', '-'], clock, 16),
            (['-a', 'list', 'table', 'inet', NAME], clock, 16),
        ])
        parse.assert_called_once_with(NAME, table)
        census.assert_called_once_with(clock, 75)
        self.assertTrue(owner.attempted)
        self.assertFalse(owner.removal_attempted)
        self.assertIsNone(owner.handles)
        self.assertIsNone(owner.counters)

    def test_late_readback_does_not_publish_new_counters(self):
        owner = H.Firewall('123', '0123456789abcdef')
        rows = kernel_rows()
        readback = H.firewall_readback
        owner.handles, owner.counters = readback(NAME, data(rows))
        prior_counters = owner.counters
        for row in rows:
            if 'rule' in row:
                row['rule']['expr'][-2]['counter'] = {'packets': 2, 'bytes': 120}
        chains = data([row for row in rows if 'chain' in row])
        with patch.object(H.time, 'monotonic', return_value=100) as now:
            clock = H.Deadline()
            def late_readback(name, raw):
                result = readback(name, raw)
                now.return_value = 160
                return result
            with (patch.object(owner, '_nft', side_effect=(chains, data(rows))) as native,
                  patch.object(H, 'firewall_readback', side_effect=late_readback),
                  self.assertRaisesRegex(H.Refused, '^capability-deadline$')):
                owner.observe(clock)
        self.assertEqual(native.call_args_list, [
            call(['list', 'chains'], clock, 60), call(['-a', 'list', 'table', 'inet', NAME], clock, 60)])
        self.assertIs(owner.counters, prior_counters)

    def test_late_absence_inventory_keeps_last_proven_handles_and_delete_attempt(self):
        owner = H.Firewall('123', '0123456789abcdef')
        rows = kernel_rows()
        owner.handles, owner.counters = H.firewall_readback(NAME, data(rows))
        prior_handles = owner.handles
        chains = data([row for row in rows if 'chain' in row])
        absence = data([])
        parse = H._nft_rows
        with patch.object(H.time, 'monotonic', return_value=100) as now:
            clock = H.Deadline()
            def late_inventory(raw):
                result = parse(raw)
                if raw is absence:
                    now.return_value = 175
                return result
            with (patch.object(H, 'require_role_credentials_absent'),
                  patch.object(H, '_bounded_file', return_value=HEADER),
                  patch.object(owner, '_nft', side_effect=(chains, data(rows), b'', absence)) as native,
                  patch.object(H, '_nft_rows', side_effect=late_inventory)):
                with self.assertRaisesRegex(H.Refused, '^capability-deadline$'):
                    owner.remove_after_quiescence(clock)
                with self.assertRaisesRegex(H.Refused, '^firewall-removal-already-attempted$'):
                    owner.remove_after_quiescence(clock)
        self.assertEqual(native.call_args_list, [
            call(['list', 'chains'], clock, 75), call(['-a', 'list', 'table', 'inet', NAME], clock, 75),
            call(['delete', 'table', 'inet', NAME], clock, 75), call(['list', 'tables'], clock, 75)])
        self.assertIs(owner.handles, prior_handles)
        self.assertTrue(owner.removal_attempted)

    def test_uncertain_firewall_delete_cannot_retry_the_native_mutation(self):
        owner = H.Firewall('123', '0123456789abcdef')
        clock = SimpleNamespace(remaining=Mock(return_value=0.5))
        with (patch.object(H, 'require_role_credentials_absent') as census,
              patch.object(H, '_bounded_file', return_value=HEADER), patch.object(owner, 'observe'),
              patch.object(owner, '_nft', side_effect=H.Refused('firewall-command-timeout')) as native):
            with self.assertRaisesRegex(H.Refused, '^firewall-command-timeout$'):
                owner.remove_after_quiescence(clock)
            with self.assertRaisesRegex(H.Refused, '^firewall-removal-already-attempted$'):
                owner.remove_after_quiescence(clock)
        native.assert_called_once_with(['delete', 'table', 'inet', NAME], clock, 75)
        census.assert_called_once_with(clock, 75)

    def test_segmented_native_reads_require_eof_and_retain_later_listener(self):
        row = listener()
        stream = SimpleNamespace(read=Mock(side_effect=(HEADER[:10], HEADER[10:], row, b'')))
        raw = H._bounded_bytes(stream, len(HEADER) + len(row))
        self.assertEqual(H.listener_inode(raw, HEADER, 3444, 62121), 99)
        self.assertEqual(stream.read.call_args_list[-1], call(1))
        duplicate = SimpleNamespace(read=Mock(side_effect=(HEADER + row, listener(inode=101), b'')))
        with self.assertRaisesRegex(H.Refused, 'native-listener-not-unique'):
            H.listener_inode(H._bounded_bytes(duplicate, 4096), HEADER, 3444, 62121)
        overflow = SimpleNamespace(read=Mock(side_effect=(b'ab', b'c', b'd')))
        with self.assertRaisesRegex(H.Refused, 'native-file-bound'):
            H._bounded_bytes(overflow, 3)
        self.assertEqual(overflow.read.call_args_list, [call(4), call(2), call(1)])
        failed = SimpleNamespace(read=Mock(side_effect=(b'ab', PermissionError())))
        with self.assertRaises(PermissionError):
            H._bounded_bytes(failed, 3)

    def _model_task(self, root, group, tid, uid=1000, gid=1000, groups=1000):
        task = root / str(group) / 'task' / str(tid)
        task.mkdir(parents=True)
        status = task / 'status'
        status.write_text(f'Uid: {uid} {uid} {uid} {uid}\nGid: {gid} {gid} {gid} {gid}\nGroups: {groups}\n')
        return status

    def test_actual_task_census_refuses_sibling_reserved_uid_gid_and_group(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            self._model_task(root, 10, 10)
            status = self._model_task(root, 10, 11)
            H._require_proc_credentials_absent(root, lambda: None)
            safe = status.read_text()
            for old, new in (('Uid: 1000', 'Uid: 62120'), ('Gid: 1000', 'Gid: 62121'),
                             ('Groups: 1000', 'Groups: 1000 62121')):
                with self.subTest(old=old):
                    status.write_text(safe.replace(old, new))
                    with self.assertRaisesRegex(H.Refused, 'capability-role-process-present'):
                        H._require_proc_credentials_absent(root, lambda: None)

    def test_task_census_refuses_missing_status_and_missing_task_dir_with_live_group_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            status = self._model_task(root, 10, 10)
            status.unlink()
            with self.assertRaisesRegex(H.Refused, '^credential-census-ambiguous-task$'):
                H._require_proc_credentials_absent(root, lambda: None)
            status.parent.rmdir()
            status.parent.parent.rmdir()
            with self.assertRaisesRegex(H.Refused, '^credential-census-ambiguous-process$'):
                H._require_proc_credentials_absent(root, lambda: None)

    def test_task_budget_is_aggregate_and_new_live_sibling_requires_observation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            self._model_task(root, 10, 10)
            self._model_task(root, 10, 11)
            self._model_task(root, 20, 20)
            with (patch.object(H, 'MAX_PROC_IDS', 2),
                  self.assertRaisesRegex(H.Refused, '^credential-task-census-bound$')):
                H._require_proc_credentials_absent(root, lambda: None)
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            self._model_task(root, 10, 10)
            read = H._task_credentials
            def read_and_add_task(fd):
                credentials = read(fd)
                self._model_task(root, 10, 11)
                return credentials
            with (patch.object(H, '_task_credentials', side_effect=read_and_add_task),
                  self.assertRaisesRegex(H.Refused, '^credential-task-membership-differs$')):
                H._require_proc_credentials_absent(root, lambda: None)

    def test_observer_source_binds_warm_and_reserved_scalar_facts_before_report(self):
        driver = PATH.parents[2] / 'test/performance/native-workload-browser-driver.mjs'
        source = driver.read_text()
        self.assertEqual(source.count('fetch_types: false'), 1)
        self.assertIn('postgres(url, {max: 1, connect_timeout: 4, fetch_types: false,\n'
                      '      connection: {application_name: tag, statement_timeout: 2500}})', source)
        self.assertEqual(source.count('await observerIdentity('), 2)
        self.assertEqual(source.count('from pg_stat_statements'), 1)
        self.assertIn('extract(epoch from a.backend_start)::text as backend_start', source)
        self.assertIn('    observer = await pool.reserve();\n    const [reserved] = await observerIdentity(observer, true);', source)
        markers = ['await observerIdentity(pool, false)', 'observer = await pool.reserve()',
                   'await observerIdentity(observer, true)', 'assert.deepEqual(identity, warm)', "op: 'observer-ready'"]
        self.assertEqual([source.index(marker) for marker in markers], sorted(source.index(marker) for marker in markers))


class MainProcessKernel:
    def __init__(self, role='driver'):
        self.role = role
        self.uid = {'driver': H.DRIVER, 'browser': H.BROWSER, 'third': H.THIRD}[role]
        self.start = 100
        self.group_inode = 33
        self.dead = False
        self.foreign_namespace = None
        self.proc_group = f'0::/system.slice/aihrbc-{role}-123.service\n'.encode()
        self.root_read, self.root_write = 44, 45
        self.child_pipes = (45, 44)
        self.child_flags = (b'00', b'01')
        self.child_fdinfo = (None, None)
        self.replace_input_after_output_read = False
        self.inheritable = set()
        self.inherited_capabilities = b'0'
        self.clock = SimpleNamespace(remaining=Mock(return_value=1))
        self.held = {11: self.info(11, stat.S_IFDIR), 12: self.info(33, stat.S_IFDIR),
                     41: self.info(141, stat.S_IFREG | 0o755), 42: self.info(142, stat.S_IFREG | 0o555),
                     44: self.info(144, stat.S_IFIFO), 45: self.info(145, stat.S_IFIFO),
                     46: self.info(146, stat.S_IFIFO)}
        self.executable = self.held[41]
        runtime = '/run/aihr-browser-capability-123/runtime'
        if role == 'third':
            self.gate = None
            self.argv = ('/usr/bin/python3', '-I', '-B', runtime + '/roles/native-workload-browser-host.py', 'probe-third')
            self.node = None
        else:
            tree = ast.parse(PATH.with_name('native-workload-browser-preimport-gate.py').read_bytes())
            source = next(row.value.func.value.value.lstrip() for row in tree.body
                          if isinstance(row, ast.Assign) and row.targets[0].id == '_SOURCE')
            self.gate = ('/usr/bin/python3', '-I', '-B', '-S', '-c', source, role, '123', '321')
            if role == 'browser':
                argument, script = 'A' * 43 + '=', 'native-workload-browser-server.mjs'
                self.gate = (*self.gate, argument)
            else:
                argument, script = '--capability-only', 'native-workload-browser-driver.mjs'
            self.argv = self.gate
            self.node = (runtime + '/node', runtime + '/roles/' + script, argument)
        self.link = '/usr/bin/python3.12'
        self.readers = {}
        self.pins = []
        self.next_fd = 100
        self.closed = []

    @staticmethod
    def info(inode, mode=stat.S_IFREG):
        return SimpleNamespace(st_dev=5, st_ino=inode, st_mode=mode, st_uid=0, st_gid=0,
                               st_size=10, st_mtime_ns=11, st_ctime_ns=12)

    def open(self, path, flags, *, dir_fd=None):
        if dir_fd is None and not path.startswith('/proc/self/fdinfo/'):
            assert flags == H.os.O_PATH | H.os.O_DIRECTORY | H.os.O_NOFOLLOW | H.os.O_CLOEXEC
            return {'/proc/31': 11, f'/sys/fs/cgroup/system.slice/aihrbc-{self.role}-123.service': 12}[path]
        fd = self.next_fd
        self.next_fd += 1
        if path in ('fd/0', 'fd/1'):
            assert dir_fd == 11 and flags == H.os.O_PATH | H.os.O_CLOEXEC
            self.held[fd] = self.held[self.child_pipes[int(path[-1])]]
            self.pins.append(fd)
        else:
            assert flags == H.os.O_RDONLY | H.os.O_CLOEXEC | H.os.O_NOFOLLOW
            assert ((dir_fd == 11 and path in ('stat', 'status', 'cgroup', 'cmdline', 'fdinfo/0', 'fdinfo/1'))
                    or (dir_fd is None and path.startswith('/proc/self/fdinfo/')))
            self.readers[fd] = path
        return fd

    def stat(self, path, *, dir_fd=None, follow_symlinks=True):
        if dir_fd is None and not follow_symlinks:
            if path == '/proc/31':
                return self.held[11]
            assert path == f'/sys/fs/cgroup/system.slice/aihrbc-{self.role}-123.service'
            return self.info(self.group_inode, stat.S_IFDIR)
        if path == 'exe' and dir_fd == 11:
            return self.executable
        if path in ('fd/0', 'fd/1') and dir_fd == 11:
            return self.held[self.child_pipes[int(path[-1])]]
        assert path.startswith(('/proc/1/ns/', '/proc/self/ns/', 'ns/'))
        name = path.rsplit('/', 1)[-1]
        inode = 200 + ('user', 'pid', 'time', 'net', 'mnt').index(name)
        if dir_fd == 11 and name in ('mnt', self.foreign_namespace):
            inode += 20
        return self.info(inode)

    def fdopen(self, fd, mode, *, buffering, closefd):
        assert mode == 'rb' and buffering == 0 and closefd is False
        path = self.readers[fd]
        if path.startswith('/proc/self/fdinfo/'):
            pin = int(path.rsplit('/', 1)[-1])
            assert pin in self.pins and pin not in self.closed
            return self.fdinfo(self.held[pin].st_ino, 17, f'{H.os.O_PATH | H.os.O_CLOEXEC:o}'.encode())
        if path in ('fdinfo/0', 'fdinfo/1'):
            assert len(self.pins) >= 2 and not set(self.pins[-2:]).intersection(self.closed)
            number = int(path[-1])
            identity = self.child_fdinfo[number] or (self.held[self.child_pipes[number]].st_ino, 17)
            if number == 1 and self.replace_input_after_output_read:
                self.child_pipes = (46, self.child_pipes[1])
            return self.fdinfo(*identity, self.child_flags[number])
        uid = str(self.uid).encode()
        ids = b' '.join([uid] * 4)
        status = (b'Uid:\t' + ids + b'\nGid:\t' + ids + b'\nGroups:\t' + uid
                  + b'\nNoNewPrivs:\t1\nCapEff:\t0\nCapPrm:\t0\nCapBnd:\t0\nCapAmb:\t0\nSeccomp:\t2\nSeccomp_filters:\t3\n'
                  + b'CapInh:\t' + self.inherited_capabilities + b'\n')
        files = {'stat': b'31 (model command) S ' + b'0 ' * 18 + str(self.start).encode(),
                 'status': status, 'cgroup': self.proc_group,
                 'cmdline': b'\0'.join(part.encode('ascii') for part in self.argv) + b'\0'}
        return io.BytesIO(files[path])

    @staticmethod
    def fdinfo(ino, mount, flags):
        return io.BytesIO(b'pos:\t0\nflags:\t' + flags + f'\nmnt_id:\t{mount}\nino:\t{ino}\n'.encode())

    def fcntl(self, fd, operation):
        assert operation == fcntl.F_GETFL
        return {44: H.os.O_RDONLY, 45: H.os.O_WRONLY}[fd] | H.os.O_NONBLOCK

    @contextmanager
    def native(self):
        poll = Mock()
        poll.poll.side_effect = lambda _timeout: [(10, H.select.POLLIN)] if self.dead else []
        with ExitStack() as stack:
            for owner, name, value in (
                (H.os, 'geteuid', lambda: 0), (H.os, 'open', self.open), (H.os, 'stat', self.stat),
                (H.os, 'fstat', lambda fd: self.held[fd] if fd in self.held else self.info(fd)),
                (H.os, 'fdopen', self.fdopen), (H.os, 'readlink', lambda path, *, dir_fd: self.link),
                (H.os, 'get_inheritable', lambda fd: fd in self.inheritable), (H.os, 'close', self.closed.append),
                (fcntl, 'fcntl', self.fcntl), (H.select, 'poll', lambda: poll),
            ):
                stack.enter_context(patch.object(owner, name, side_effect=value))
            stack.enter_context(patch.object(H.os, 'O_PATH', getattr(H.os, 'O_PATH', 0o10000000), create=True))
            pidfd = stack.enter_context(patch.object(H.os, 'pidfd_open', return_value=10, create=True))
            yield pidfd, poll

    def observe(self):
        return H.held_synthetic_main(31, self.role, '123', python_fd=41, node_fd=42 if self.node else None,
                                     root_read_fd=self.root_read, root_write_fd=self.root_write,
                                     gate_argv=self.gate, clock=self.clock)

    def exec_node(self):
        self.executable = self.held[42]
        self.argv = self.node
        self.link = self.argv[0]


class BrowserHostMainProcessModel(unittest.TestCase):
    def test_both_roles_hold_one_pidfd_and_immutable_identity_through_exact_node_exec(self):
        for role in ('driver', 'browser'):
            with self.subTest(role=role):
                kernel = MainProcessKernel(role)
                kernel.child_flags = tuple(f'{int(flag, 8) | H.os.O_NONBLOCK:o}'.encode() for flag in kernel.child_flags)
                with kernel.native() as (pidfd_open, poll):
                    with kernel.observe() as (fd, initial, current):
                        self.assertEqual((fd, initial.identity.pid, initial.executable_birth), (10, 31, (5, 141)))
                        self.assertEqual(current(), initial)
                        with self.assertRaises(AttributeError):
                            initial.identity.start = 101
                        kernel.exec_node()
                        kernel.child_flags = (b'00', b'01')
                        after = current(post_exec=True)
                        self.assertEqual(after.identity, initial.identity)
                        self.assertEqual(after.executable_birth, (5, 142))
                        self.assertNotIn(10, kernel.closed)
                    with self.assertRaisesRegex(H.Refused, 'synthetic-main-exec-phase'):
                        current(post_exec=True)
                    pidfd_open.assert_called_once_with(31)
                    poll.register.assert_called_once_with(10, H.select.POLLIN)
                self.assertEqual(kernel.closed[-3:], [12, 11, 10])
                self.assertTrue(kernel.pins and all(kernel.closed.count(pin) == 1 for pin in kernel.pins))
                self.assertTrue({41, 42, 44, 45}.isdisjoint(kernel.closed))
                self.assertGreater(kernel.clock.remaining.call_count, 0)
                self.assertEqual(kernel.clock.remaining.call_args_list, [call(32)] * kernel.clock.remaining.call_count)

    def test_third_has_only_original_python_path_and_requires_its_own_uid(self):
        kernel = MainProcessKernel('third')
        with kernel.native(), kernel.observe() as (_, initial, current):
            self.assertEqual(current(), initial)
            with self.assertRaisesRegex(H.Refused, 'synthetic-main-exec-phase'):
                current(post_exec=True)
            kernel.uid = H.DRIVER
            with self.assertRaisesRegex(H.Refused, 'native-role-credentials-differ'):
                current()
        self.assertGreater(kernel.clock.remaining.call_count, 0)
        self.assertEqual(kernel.clock.remaining.call_args_list, [call(42)] * kernel.clock.remaining.call_count)

    def test_refuses_same_executable_path_with_foreign_inode_or_changed_exact_argv(self):
        for changed in ('inode', 'argv', 'gate'):
            with self.subTest(changed=changed):
                kernel = MainProcessKernel()
                if changed == 'inode':
                    kernel.executable = kernel.info(999, stat.S_IFREG | 0o755)
                elif changed == 'argv':
                    kernel.argv = (*kernel.argv, 'extra')
                else:
                    kernel.gate = (*kernel.gate[:5], kernel.gate[5] + '\n', *kernel.gate[6:])
                with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-executable-or-argv|synthetic-main-gate-argv'):
                    with kernel.observe():
                        self.fail('unexpected owner')

    def test_refuses_swapped_aliased_wrong_mode_and_inheritable_pipe(self):
        for changed in ('swap', 'alias', 'mode', 'inherit'):
            with self.subTest(changed=changed):
                kernel = MainProcessKernel()
                if changed == 'swap':
                    kernel.child_pipes = (44, 45)
                elif changed == 'alias':
                    kernel.child_pipes = (45, 45)
                elif changed == 'mode':
                    kernel.child_flags = (b'01', b'01')
                else:
                    kernel.inheritable.add(44)
                with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-(pipe-pair|child-pipe|root-pipe)'):
                    with kernel.observe():
                        self.fail('unexpected owner')

    def test_refuses_foreign_fdinfo_inode_or_mount_even_when_named_pipe_is_exact(self):
        for changed, identity in (('inode', (146, 17)), ('mount', (145, 18))):
            with self.subTest(changed=changed):
                kernel = MainProcessKernel()
                kernel.child_fdinfo = (identity, None)
                with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-child-pipe'):
                    with kernel.observe():
                        self.fail('unexpected owner')
                self.assertEqual(len(kernel.pins), 2)
                self.assertTrue(all(kernel.closed.count(pin) == 1 for pin in kernel.pins))

    def test_refuses_child_cloexec_on_either_endpoint(self):
        for endpoint in (0, 1):
            with self.subTest(endpoint=endpoint):
                kernel = MainProcessKernel()
                flags = list(kernel.child_flags)
                flags[endpoint] = f'{int(flags[endpoint], 8) | H.os.O_CLOEXEC:o}'.encode()
                kernel.child_flags = tuple(flags)
                with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-child-pipe'):
                    with kernel.observe():
                        self.fail('unexpected owner')

    def test_refuses_input_replaced_during_output_observation_and_closes_both_pins(self):
        kernel = MainProcessKernel()
        kernel.replace_input_after_output_read = True
        with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-child-pipe'):
            with kernel.observe():
                self.fail('unexpected owner')
        self.assertEqual(len(kernel.pins), 2)
        self.assertTrue(all(kernel.closed.count(pin) == 1 for pin in kernel.pins))
        self.assertTrue({44, 45, 46}.isdisjoint(kernel.closed))

    def test_refuses_reused_birth_changed_cgroup_and_pidfd_terminal(self):
        for changed, reason in (('start', 'identity-changed'), ('group_inode', 'cgroup-or-proc'), ('dead', 'process-exited')):
            with self.subTest(changed=changed):
                kernel = MainProcessKernel()
                with kernel.native(), kernel.observe() as (_, _, current):
                    kernel.exec_node()
                    setattr(kernel, changed, {'start': 101, 'group_inode': 34, 'dead': True}[changed])
                    with self.assertRaisesRegex(H.Refused, 'synthetic-main-' + reason):
                        current(post_exec=True)
                self.assertEqual(kernel.closed[-3:], [12, 11, 10])

    def test_refuses_foreign_initial_user_pid_time_or_network_namespace(self):
        for name in ('user', 'pid', 'time', 'net'):
            with self.subTest(name=name):
                kernel = MainProcessKernel()
                kernel.foreign_namespace = name
                with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-namespaces'):
                    with kernel.observe():
                        self.fail('unexpected owner')

    def test_refuses_inherited_capabilities_even_when_current_sets_are_zero(self):
        kernel = MainProcessKernel()
        kernel.inherited_capabilities = b'1'
        with kernel.native(), self.assertRaisesRegex(H.Refused, 'synthetic-main-inherited-credentials'):
            with kernel.observe():
                self.fail('unexpected owner')

    def test_late_native_observation_cannot_return_and_still_releases_owned_fds(self):
        kernel = MainProcessKernel()
        kernel.clock.remaining.side_effect = [1, 1, 1, 1, 1, H.Refused('capability-deadline')]
        with kernel.native(), self.assertRaisesRegex(H.Refused, 'capability-deadline'):
            with kernel.observe():
                self.fail('unexpected owner')
        self.assertEqual(kernel.closed[-3:], [12, 11, 10])


if __name__ == '__main__':
    unittest.main(defaultTest=('BrowserHostModel', 'BrowserHostSettlementModel'))
