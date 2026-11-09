"""Models of fixed wrapper custody. No native spawn, signal or manager call."""
import os
import pathlib
import select
import signal
import stat
import unittest
from contextlib import ExitStack, nullcontext
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, call, patch


def load(name, sibling):
    path = pathlib.Path(__file__).with_name(sibling)
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


P = load('wrapper_parent_model', 'native-workload-browser-wrapper-parent.py')
G = load('wrapper_parent_child_model', 'native-workload-browser-wrapper.py')
START = 10 * G._SECOND
LAUNCH = START + 32 * G._SECOND
CLEANUP = START + 75 * G._SECOND
PID, PIDFD = 551, 92


def stat_line(pid, *, parent=441, group=551, session=551, start=17):
    numbers = [parent, group, session] + [0] * 15 + [start]
    return (f'{pid} (name with ) parenthesis) S ' + ' '.join(map(str, numbers)) + '\n').encode()


def file(inode):
    return SimpleNamespace(st_dev=7, st_ino=inode, st_mode=stat.S_IFREG | 0o755, st_uid=0, st_gid=0,
                           st_nlink=1, st_size=4096, st_mtime_ns=12, st_ctime_ns=13)


class ParentModels(unittest.TestCase):
    def setUp(self):
        self.python, self.stock = file(51), file(52)
        self.reset_owner()
        for module in (P, G):
            clock = patch.object(module, 'monotonic_ns', side_effect=lambda: self.now)
            clock.start()
            self.addCleanup(clock.stop)

    def reset_owner(self):
        self.now = START + G._SECOND
        with (
            patch.object(P.sys, 'platform', 'linux'),
            patch.object(P.os, 'uname', return_value=SimpleNamespace(machine='x86_64')),
            patch.object(P.os, 'getresuid', return_value=(0, 0, 0), create=True),
            patch.object(P.os, 'getresgid', return_value=(0, 0, 0), create=True),
            patch.object(P.os, 'get_inheritable', return_value=False),
            patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL),
        ):
            self.owner = P._WrapperParent(G, role='driver', run_id='427', nonce='a' * 16, spki=None,
                                         unset_names=('MANAGERPID',), capsule_fd=50, python_fd=51, stock_fd=52,
                                         started_ns=START, launch_by_ns=LAUNCH, cleanup_by_ns=CLEANUP)

    def spawn_models(self, stack):
        owner = self.owner
        owner.control = Mock()
        owner.control.fileno.return_value = 29
        owner.control.send.side_effect = lambda packet, _flags: len(packet)
        owner.root_pipes = (30, 31)
        for name, settings in (
            ('_source', {}), ('_packages', {'return_value': (self.python, self.stock)}),
            ('_make_pipes', {'return_value': (20, 21, 22, 23)}), ('_native_marks', {}),
            ('_root_pipe_pair', {}), ('_bind', {}), ('_snapshot', {}),
        ):
            stack.enter_context(patch.object(owner, name, **settings))
        for name, settings in (
            ('open', {'side_effect': (80, 81, 82)}), ('getpid', {'return_value': 441}),
            ('readlink', {'return_value': '441'}), ('stat', {'return_value': file(64)}),
        ):
            stack.enter_context(patch.object(P.os, name, **settings))
        stack.enter_context(patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL))
        stack.enter_context(patch.object(P, '_all_cloexec'))
        stack.enter_context(patch.object(P, '_read', return_value=stat_line(441, start=19)))
        stack.enter_context(patch.object(G, '_command', return_value=('/usr/bin/systemd-run', '--fixed')))
        stack.enter_context(patch.object(G, '_poll', side_effect=({29: select.POLLIN}, {})))
        stack.enter_context(patch.object(G, '_recv', return_value=(G._READY, (PID, 0, 0))))

    def test_fixed_posix_spawn_only_after_prepare_and_ready_does_not_grant(self):
        with ExitStack() as held:
            self.spawn_models(held)
            def spawn(*_args, **_kwargs):
                self.assertEqual(self.owner.spawn_fact, ('spawn-uncertain', None))
                self.assertEqual(self.owner.control.send.call_count, 1)
                self.assertEqual(self.owner.pid, None)
                return PID
            called = held.enter_context(patch.object(P.os, 'posix_spawn', side_effect=spawn))
            bind = held.enter_context(patch.object(P.os, 'pidfd_open', return_value=PIDFD, create=True))
            self.owner.spawn_ready()
            helper, env = G.wrapper_helper_argv('427')
            called.assert_called_once_with(helper[0], helper, dict(env), file_actions=G.wrapper_file_actions(20, 21, 22, 23),
                                           setsid=True, setsigmask=(), setsigdef=P._SIGNALS)
            bind.assert_called_once_with(PID)
            self.owner._snapshot.assert_called_once_with(self.owner.active, helper=True)
            packet = G._prepare(self.owner.control.send.call_args.args[0])
            self.assertEqual((packet['parentPid'], packet['parentBirth'], packet['readyByNs']), (441, 19, LAUNCH))
            self.assertEqual(packet['unsetNames'], ['MANAGERPID'])
            self.assertTrue(self.owner.ready)
            self.assertFalse(self.owner.manager_request_possible)

    def test_lost_pid_and_known_pid_after_cleanup_never_open_or_signal_a_process(self):
        for variant in ('lost', 'late', 'pidfd-missing'):
            with self.subTest(variant=variant):
                self.reset_owner()
                with ExitStack() as held:
                    self.spawn_models(held)
                    def spawn(*_args, **_kwargs):
                        if variant == 'lost':
                            raise OSError('unproved spawn return')
                        if variant == 'late':
                            self.now = CLEANUP
                        return PID
                    held.enter_context(patch.object(P.os, 'posix_spawn', side_effect=spawn))
                    bind = held.enter_context(patch.object(P.os, 'pidfd_open', side_effect=OSError, create=True))
                    kill = held.enter_context(patch.object(P.signal, 'pidfd_send_signal', create=True))
                    close = held.enter_context(patch.object(P.os, 'close'))
                    control = self.owner.control
                    with self.assertRaises(P.Refused if variant == 'late' else OSError):
                        self.owner.spawn_ready()
                    with self.assertRaisesRegex(P.Refused, '^wrapper-parent-settlement$'):
                        self.owner.settle(terminate=True)
                    self.assertEqual(bind.call_args_list, [call(PID)] if variant == 'pidfd-missing' else [])
                    kill.assert_not_called()
                    control.close.assert_called_once_with()
                    self.assertCountEqual(close.call_args_list, [call(30), call(31)])
                expected = {'lost': ('spawn-uncertain', None), 'late': ('pid-known-after-cleanup', PID),
                            'pidfd-missing': ('pid-known-in-slot', PID)}
                self.assertEqual(self.owner.spawn_fact, expected[variant])
                self.assertFalse(self.owner.manager_request_possible)

    def test_foreign_inheritable_descriptor_refuses_without_rewriting_it(self):
        entries = iter(SimpleNamespace(name=name) for name in ('0', '1', '2', '64'))
        with (
            patch.object(P.os, 'scandir', return_value=nullcontext(entries)),
            patch.object(P.os, 'get_inheritable', return_value=True) as observed,
            patch.object(P.os, 'set_inheritable') as changed,
            self.assertRaisesRegex(P.Refused, '^wrapper-parent-inheritable-fd$'),
        ):
            P._all_cloexec(self.owner.active)
        observed.assert_called_once_with(64)
        changed.assert_not_called()

    def test_pid_returned_at_launch_cutoff_keeps_only_its_cleanup_handle(self):
        owner = self.owner
        with ExitStack() as held:
            self.spawn_models(held)
            def spawn(*_args, **_kwargs):
                self.now = LAUNCH
                return PID
            held.enter_context(patch.object(P.os, 'posix_spawn', side_effect=spawn))
            bind = held.enter_context(patch.object(P.os, 'pidfd_open', return_value=PIDFD, create=True))
            held.enter_context(patch.object(P.os, 'close'))
            with self.assertRaisesRegex(G.Refused, '^wrapper-deadline$'):
                owner.spawn_ready()
            bind.assert_called_once_with(PID)
            owner._bind.assert_not_called()
            owner._snapshot.assert_not_called()
        self.assertEqual(owner.spawn_fact, ('pid-known-after-launch', PID))
        self.assertEqual(owner.pidfd, PIDFD)
        self.assertFalse(owner.manager_request_possible)
        self.assertIsNone(owner.root_pipes)
        self.assertIsNone(owner.control)

    def test_held_pidfd_and_proc_birth_must_join_exact_parent_session_and_time_namespace(self):
        owner = self.owner
        owner.pid, owner.pidfd, owner.proc = PID, PIDFD, 83
        owner.proc_root, owner.self_proc, owner.fdinfo = 80, 81, 82
        owner.parent_pid, owner.start = 441, 17
        owner.proc_birth = owner.time_namespace = (7, 64)
        for variant, reason in (('positive', None), ('pidfd', 'pidfd'), ('start', 'child-identity'),
                                ('parent', 'child-identity'), ('dead', 'child-birth')):
            with self.subTest(variant=variant):
                pid = PID + (variant == 'pidfd')
                raw = stat_line(PID, parent=442 if variant == 'parent' else 441, start=18 if variant == 'start' else 17)
                with (
                    patch.object(P.os, 'get_inheritable', return_value=False),
                    patch.object(P.os, 'fstat', return_value=file(64)),
                    patch.object(P.os, 'stat', return_value=file(64)),
                    patch.object(G, '_poll', return_value={PIDFD: select.POLLIN} if variant == 'dead' else {}),
                    patch.object(P, '_read', side_effect=(f'Pid:\t{pid}\n'.encode(), raw)),
                ):
                    if reason is None:
                        owner._bind(owner.active)
                    else:
                        with self.assertRaisesRegex(P.Refused, '^wrapper-parent-' + reason + '$'):
                            owner._bind(owner.active)

    def test_ack_is_one_use_and_ambiguity_stays_manager_possible_without_stock_credit(self):
        for variant in ('success', 'short', 'late', 'error'):
            with self.subTest(variant=variant):
                self.reset_owner()
                owner = self.owner
                owner.ready, owner.pid, owner.pidfd = True, PID, PIDFD
                owner.control = Mock()
                def send(packet, _flags):
                    self.assertTrue(owner.manager_request_possible)
                    self.assertEqual(packet, G._GO)
                    if variant == 'late':
                        self.now = LAUNCH
                    if variant == 'error':
                        raise OSError('ambiguous write')
                    return 0 if variant == 'short' else len(packet)
                owner.control.send.side_effect = send
                with (
                    patch.multiple(owner, _source=Mock(), _packages=Mock(), _snapshot=Mock(), _root_pipe_pair=Mock()),
                    patch.object(G, '_poll', return_value={}),
                ):
                    if variant == 'success':
                        owner.acknowledge()
                    else:
                        with self.assertRaises((P.Refused, G.Refused, OSError)):
                            owner.acknowledge()
                        with self.assertRaisesRegex(P.Refused, '^wrapper-parent-stock-state$'):
                            owner.observe_stock()
                    with self.assertRaisesRegex(P.Refused, '^wrapper-parent-ack-once$'):
                        owner.acknowledge()
                self.assertTrue(owner.manager_request_possible)
                self.assertEqual(owner.ack_sent, variant == 'success')
                self.assertEqual(owner.control.send.call_count, 1)

    def test_stock_observation_requires_held_exec_transition_and_never_uses_control_eof(self):
        owner = self.owner
        owner.ack_attempted = owner.ack_sent = True
        owner.pidfd, owner.proc = PIDFD, 83
        owner.control = Mock()
        with (
            patch.object(owner, '_current_identity') as identity,
            patch.object(P.os, 'stat', side_effect=(self.python, self.stock)),
            patch.object(P.os, 'fstat', side_effect=lambda fd: self.python if fd == 51 else self.stock),
            patch.object(owner, '_packages'), patch.object(G, '_poll', return_value={}),
            patch.object(owner, '_snapshot') as snapshot,
        ):
            owner.observe_stock()
        self.assertEqual(identity.call_count, 2)
        snapshot.assert_called_once_with(owner.active, helper=False)
        owner.control.recv.assert_not_called()
        self.assertTrue(owner.stock_seen)

    def test_stock_snapshot_rejects_command_or_surviving_helper_socket(self):
        owner = self.owner
        owner.pidfd, owner.proc = PIDFD, 83
        owner.package_marks = (G._identity(self.python), G._identity(self.stock))
        owner.stock_argv = ('/usr/bin/systemd-run', '--fixed')
        for cmd, accepted in ((b'/usr/bin/systemd-run\0--fixed\0', True), (b'/usr/bin/systemd-run\0--wrong\0', False)):
            with (
                self.subTest(cmd=cmd),
                patch.object(owner, '_current_identity'),
                patch.object(P.os, 'fstat', return_value=self.stock),
                patch.object(P.os, 'stat', return_value=self.stock),
                patch.object(P.os, 'readlink', return_value='/usr/bin/systemd-run'),
                patch.object(P, '_read', side_effect=(b'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n', cmd)),
                patch.object(owner, '_child_stdio') as stdio,
            ):
                if accepted:
                    owner._snapshot(owner.active, helper=False)
                    stdio.assert_called_once_with(owner.active, helper=False)
                else:
                    with self.assertRaisesRegex(P.Refused, '^wrapper-parent-child-exec$'):
                        owner._snapshot(owner.active, helper=False)
                    stdio.assert_not_called()
        descriptors = [SimpleNamespace(st_dev=7, st_ino=20+i, st_mode=mode, st_rdev=0)
                       for i, mode in enumerate((stat.S_IFIFO, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFSOCK))]
        modes = (os.O_RDONLY, os.O_WRONLY, os.O_WRONLY, os.O_RDWR)
        owner.marks = tuple((P._descriptor(info), 9, mode) for info, mode in zip(descriptors, modes, strict=True))
        stock_socket = SimpleNamespace(st_dev=7, st_ino=99, st_mode=stat.S_IFSOCK, st_rdev=0)
        with (
            patch.object(P.os, 'stat', side_effect=lambda path, **_: stock_socket if path == 'fd/3' else descriptors[int(path[-1])]),
            patch.object(P, '_fdinfo', side_effect=lambda _gate, _folder, path, _clock: (20+int(path[-1]), 9, modes[int(path[-1])])),
        ):
            owner._child_stdio(owner.active, helper=False)
        with (
            patch.object(P.os, 'stat', side_effect=lambda path, **_: descriptors[int(path[-1])]),
            patch.object(P, '_fdinfo', side_effect=lambda _gate, _folder, path, _clock: (20+int(path[-1]), 9, modes[int(path[-1])])),
            self.assertRaisesRegex(P.Refused, '^wrapper-parent-control-survived$'),
        ):
            owner._child_stdio(owner.active, helper=False)

    def test_only_exact_waitid_pidfd_reaps_and_zero_needs_prior_stock_witness(self):
        for variant in ('stock-zero', 'helper-zero', 'foreign', 'signal'):
            with self.subTest(variant=variant):
                self.reset_owner()
                owner = self.owner
                owner.pid, owner.pidfd = PID, PIDFD
                owner.stock_seen = variant in ('stock-zero', 'signal')
                info = SimpleNamespace(si_pid=PID + (variant == 'foreign'), si_uid=0,
                                       si_code=os.CLD_KILLED if variant == 'signal' else os.CLD_EXITED,
                                       si_status=9 if variant == 'signal' else 0)
                with (
                    patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL),
                    patch.object(G, '_poll', return_value={PIDFD: select.POLLIN}),
                    patch.object(P.os, 'waitid', return_value=info) as wait,
                    patch.object(P.signal, 'pidfd_send_signal', create=True) as kill,
                ):
                    if variant == 'foreign':
                        with self.assertRaisesRegex(P.Refused, '^wrapper-parent-terminal$'):
                            owner.settle()
                    else:
                        terminal = owner.settle()
                        self.assertEqual(terminal.stock_exit_zero, variant == 'stock-zero')
                    common = os.WEXITED | os.WNOHANG
                    expected = [call(os.P_PIDFD, PIDFD, common | os.WNOWAIT)]
                    if variant != 'foreign':
                        expected.append(call(os.P_PIDFD, PIDFD, common))
                    self.assertEqual(wait.call_args_list, expected)
                    kill.assert_not_called()

    def test_failure_signal_requires_held_direct_child_and_records_before_syscall(self):
        owner = self.owner
        owner.pid, owner.pidfd = PID, PIDFD
        owner.ack_attempted = True
        info = SimpleNamespace(si_pid=PID, si_uid=0, si_code=os.CLD_KILLED, si_status=9)
        def kill(fd, number):
            self.assertTrue(owner.signal_attempted)
            self.assertEqual((fd, number), (PIDFD, signal.SIGKILL))
        with (
            patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL),
            patch.object(G, '_poll', side_effect=({}, {PIDFD: select.POLLIN})),
            patch.object(owner, '_bind') as bind,
            patch.object(P.os, 'waitid', return_value=info),
            patch.object(P.signal, 'pidfd_send_signal', side_effect=kill, create=True) as sent,
        ):
            self.assertEqual(owner.settle(terminate=True), (os.CLD_KILLED, 9, False))
        bind.assert_called_once()
        sent.assert_called_once_with(PIDFD, signal.SIGKILL)
        self.assertTrue(owner.manager_request_possible)

    def test_failure_settlement_reaps_owned_helper_that_exits_during_live_bind(self):
        owner = self.owner
        owner.pid, owner.pidfd, owner.fdinfo, owner.proc = PID, PIDFD, 82, 83
        owner.control = control = Mock()
        terminal = {PIDFD: select.POLLIN}
        info = SimpleNamespace(si_pid=PID, si_uid=0, si_code=os.CLD_EXITED, si_status=0)

        def proc_read(*_args):
            control.close.assert_called_once_with()
            return f'Pid:\t{PID}\n'.encode()

        with (
            patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL),
            patch.object(P.os, 'get_inheritable', return_value=False),
            patch.object(P, '_read', side_effect=proc_read) as read,
            patch.object(G, '_poll', side_effect=({}, terminal, terminal)) as poll,
            patch.object(P.os, 'waitid', return_value=info) as wait,
            patch.object(P.signal, 'pidfd_send_signal', create=True) as kill,
        ):
            self.assertEqual(owner.settle(terminate=True), (os.CLD_EXITED, 0, False))
        self.assertEqual(read.call_args.args[:4], (G, 82, str(PIDFD), 4096))
        self.assertEqual(poll.call_args_list, [call(None, PIDFD, 0)] * 3)
        common = os.WEXITED | os.WNOHANG
        self.assertEqual(wait.call_args_list, [call(os.P_PIDFD, PIDFD, common | os.WNOWAIT),
                                               call(os.P_PIDFD, PIDFD, common)])
        kill.assert_not_called()
        self.assertTrue(owner.reaped)
        self.assertFalse(owner.manager_request_possible)

    def test_failed_live_bind_preserves_refusal_without_timely_exact_terminal_proof(self):
        for variant in ('still-live', 'wrong-event', 'late-event', 'foreign-wait'):
            with self.subTest(variant=variant):
                self.reset_owner()
                owner = self.owner
                owner.pid, owner.pidfd, owner.fdinfo = PID, PIDFD, 82
                terminal = {PIDFD: select.POLLIN}
                info = SimpleNamespace(si_pid=PID+1, si_uid=0, si_code=os.CLD_EXITED, si_status=0)
                after_bind = iter((False, True))

                def poll_terminal(*_args):
                    if not next(after_bind):
                        return {}
                    if variant == 'late-event':
                        self.now = CLEANUP
                    return {'still-live': {}, 'wrong-event': {PIDFD: select.POLLHUP}}.get(variant, terminal)

                with (
                    patch.object(P.signal, 'getsignal', return_value=signal.SIG_DFL),
                    patch.object(P.os, 'get_inheritable', return_value=False),
                    patch.object(P, '_read', return_value=f'Pid:\t{PID+1}\n'.encode()),
                    patch.object(G, '_poll', side_effect=poll_terminal) as poll,
                    patch.object(P.os, 'waitid', return_value=info) as wait,
                    patch.object(P.signal, 'pidfd_send_signal', create=True) as kill,
                ):
                    with self.assertRaisesRegex(P.Refused, '^wrapper-parent-pidfd$'):
                        owner.settle(terminate=True)
                self.assertEqual(poll.call_args_list, [call(None, PIDFD, 0)] * 2)
                if variant == 'foreign-wait':
                    wait.assert_called_once_with(os.P_PIDFD, PIDFD, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                else:
                    wait.assert_not_called()
                kill.assert_not_called()
                self.assertFalse(owner.signal_attempted or owner.reap_attempted or owner.reaped)
                self.assertIsNone(owner.terminal)


if __name__ == '__main__':
    unittest.main()
