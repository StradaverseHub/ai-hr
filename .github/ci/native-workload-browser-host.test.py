"""Deterministic controls over the inert owner. No commands, sockets, proc or DB."""
import copy
import importlib.util
import json
import pathlib
import unittest

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


if __name__ == '__main__':
    unittest.main()
