"""Models of the dormant gate's exact inline source, with no native effects."""

import base64
import fcntl
import os
import pathlib
import stat
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, call


path = pathlib.Path(__file__).with_name('native-workload-browser-preimport-gate.py')
G = ModuleType('synthetic_preimport_gate_model')
exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), G.__dict__)
SPKI = base64.b64encode(bytes(range(32))).decode('ascii')
RUNTIME = '/run/aihr-browser-capability-427/runtime'
DEADLINE = 40000000000
NOW = DEADLINE - 32000000000


class ReplacedProcess(Exception):
    pass


def gate(role='driver', **changes):
    parameters = dict(role=role, run_id='427', deadline_ns=DEADLINE,
                      spki=SPKI if role == 'browser' else None)
    return G.synthetic_preimport_argv(**(parameters | changes))


def inline(role='driver'):
    command = gate(role)
    program = {'__name__': 'synthetic_preimport_inline_model'}
    exec(compile(command[5], '<fixed inline gate>', 'exec', dont_inherit=True), program)
    uid = 62120 if role == 'driver' else 62121
    clock = SimpleNamespace(now=NOW)
    posix = Mock(O_ACCMODE=os.O_ACCMODE, O_RDONLY=os.O_RDONLY, O_WRONLY=os.O_WRONLY)
    posix.uname.return_value = SimpleNamespace(machine='x86_64')
    posix.getresuid.return_value = posix.getresgid.return_value = (uid, uid, uid)
    posix.getgroups.return_value = [uid]
    posix.fstat.side_effect = lambda fd: SimpleNamespace(st_mode=stat.S_IFIFO, st_dev=3, st_ino=20 + fd)
    posix.get_blocking.side_effect = (True, False)
    posix.write.return_value = 2
    posix.read.return_value = b'G\n'
    posix.execv.side_effect = ReplacedProcess
    poll = Mock(side_effect=[([], [1], []), ([0], [], [])])
    program.update(os=posix, sys=SimpleNamespace(platform='linux', argv=['-c', *command[6:]]),
                   time=SimpleNamespace(monotonic_ns=lambda: clock.now), select=SimpleNamespace(select=poll),
                   fcntl=SimpleNamespace(F_GETFL=fcntl.F_GETFL, fcntl=Mock(side_effect=[os.O_RDONLY, os.O_WRONLY])))
    return program, posix, poll, clock


class SyntheticPreimportGateModels(unittest.TestCase):
    def test_exact_pure_argv_and_closed_arguments(self):
        driver, browser = gate(), gate('browser')
        self.assertEqual(driver[:5], ('/usr/bin/python3', '-I', '-B', '-S', '-c'))
        self.assertEqual(browser[:6], driver[:6])
        self.assertEqual(driver[6:], ('driver', '427', '40000000000'))
        self.assertEqual(browser[6:], ('browser', '427', '40000000000', SPKI))
        for invalid in ({'role': 'third'}, {'run_id': 427}, {'run_id': '0427'}, {'run_id': '٤٢٧'},
                        {'run_id': '427/../foreign'}, {'run_id': '9007199254740992'}, {'deadline_ns': True},
                        {'deadline_ns': '40000000000'}, {'deadline_ns': 0}, {'deadline_ns': 9223372036854775808},
                        {'spki': SPKI}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                G.synthetic_preimport_argv(**(dict(role='driver', run_id='427', deadline_ns=DEADLINE) | invalid))
        for invalid in (None, SPKI[:-2] + 'B=', SPKI[:-1] + '\n', SPKI[1:]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                gate('browser', spki=invalid)
        with self.assertRaises(TypeError):
            gate(argv=('/bin/sh',))

    def test_one_ready_and_grant_restore_stdio_then_replace_exact_role_process(self):
        for role, expected in (('driver', (RUNTIME + '/roles/native-workload-browser-driver.mjs', '--capability-only')),
                               ('browser', (RUNTIME + '/roles/native-workload-browser-server.mjs', SPKI))):
            program, posix, poll, _ = inline(role)
            order = Mock()
            for method in ('set_blocking', 'write', 'read', 'execv'):
                order.attach_mock(getattr(posix, method), method)
            order.attach_mock(poll, 'poll')
            node = RUNTIME + '/node'
            with self.subTest(role=role), self.assertRaises(ReplacedProcess):
                program['run']()
            self.assertEqual(order.mock_calls, [
                call.set_blocking(0, False), call.set_blocking(1, False), call.poll([0], [1], [], 32.0),
                call.write(1, b'R\n'), call.poll([0], [], [], 32.0), call.read(0, 3),
                call.set_blocking(1, False), call.set_blocking(0, True), call.execv(node, (node, *expected)),
            ])

    def test_inline_rechecks_argv_role_identity_and_reciprocal_pipes_before_ready(self):
        for case in ('extra', 'noncanonical-deadline', 'spki', 'root', 'saved-identity', 'other-group',
                     'aliases', 'regular', 'wrong-direction'):
            role = 'browser' if case == 'spki' else 'driver'
            program, posix, poll, _ = inline(role)
            if case == 'extra':
                program['sys'].argv.append('/bin/sh')
            elif case == 'noncanonical-deadline':
                program['sys'].argv[3] = '040000000000'
            elif case == 'spki':
                program['sys'].argv[4] = SPKI[:-2] + 'B='
            elif case == 'root':
                posix.getresuid.return_value = (0, 0, 0)
            elif case == 'saved-identity':
                posix.getresgid.return_value = (62120, 62120, 0)
            elif case == 'other-group':
                posix.getgroups.return_value = [62121]
            elif case in ('aliases', 'regular'):
                posix.fstat.side_effect = None
                posix.fstat.return_value = SimpleNamespace(st_mode=stat.S_IFIFO if case == 'aliases' else stat.S_IFREG,
                                                           st_dev=3, st_ino=20)
            else:
                program['fcntl'].fcntl.side_effect = [os.O_WRONLY, os.O_WRONLY]
            with self.subTest(case=case), self.assertRaisesRegex(ValueError, 'synthetic-preimport-refused'):
                program['run']()
            poll.assert_not_called()
            posix.write.assert_not_called()
            posix.execv.assert_not_called()

    def test_pregate_io_refuses_prequeued_short_wrong_and_surplus_packets(self):
        for grant in (b'', b'G', b'Q\n', b'G\nG'):
            program, posix, _, _ = inline()
            posix.read.return_value = grant
            with self.subTest(grant=grant), self.assertRaisesRegex(ValueError, 'synthetic-preimport-refused'):
                program['run']()
            posix.write.assert_called_once_with(1, b'R\n')
            posix.execv.assert_not_called()
        for case in ('prequeued-or-eof', 'write-short', 'no-grant'):
            program, posix, poll, _ = inline()
            if case == 'prequeued-or-eof':
                poll.side_effect = [([0], [1], [])]
            elif case == 'write-short':
                posix.write.return_value = 1
            else:
                poll.side_effect = [([], [1], []), ([], [], [])]
            with self.subTest(case=case), self.assertRaisesRegex(ValueError, 'synthetic-preimport-refused'):
                program['run']()
            self.assertEqual(posix.write.call_count, int(case != 'prequeued-or-eof'))
            posix.read.assert_not_called()
            posix.execv.assert_not_called()

    def test_same_absolute_frontier_refuses_expired_future_and_late_grant(self):
        for now in (DEADLINE, NOW - 1):
            program, posix, poll, clock = inline()
            clock.now = now
            with self.subTest(now=now), self.assertRaisesRegex(ValueError, 'synthetic-preimport-refused'):
                program['run']()
            poll.assert_not_called()
            posix.write.assert_not_called()
            posix.execv.assert_not_called()
        program, posix, _, clock = inline()

        def late_grant(fd, size):
            self.assertEqual((fd, size), (0, 3))
            clock.now = DEADLINE
            return b'G\n'

        posix.read.side_effect = late_grant
        with self.assertRaisesRegex(ValueError, 'synthetic-preimport-refused'):
            program['run']()
        posix.write.assert_called_once_with(1, b'R\n')
        self.assertEqual(posix.set_blocking.call_args_list, [call(0, False), call(1, False),
                                                            call(1, False), call(0, True)])
        posix.execv.assert_not_called()


if __name__ == '__main__':
    unittest.main()
