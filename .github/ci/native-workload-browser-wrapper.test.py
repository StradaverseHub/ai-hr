"""Models of the fixed child gate. No native spawn, exec, manager or socket."""

import base64
import json
import os
import pathlib
import select
import signal
import socket
import stat
import unittest
from contextlib import ExitStack
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


HERE = pathlib.Path(__file__).with_name('native-workload-browser-wrapper.py')
W = ModuleType('native_browser_stock_wrapper_model')
exec(compile(HERE.read_bytes(), str(HERE), 'exec', dont_inherit=True), W.__dict__)
START = 8_000_000_000
SECOND = 1_000_000_000
PARENT = 841
BIRTH = 271
STOCK = (3, 91, 81502, 21, 25)
PEER = (PARENT, 0, 0)
SPKI = base64.b64encode(bytes(range(32))).decode('ascii')


def request(role='driver', **changes):
    row = {'version': 1, 'role': role, 'runId': '427', 'nonce': '0123456789abcdef',
           'spki': SPKI if role == 'browser' else None, 'parentPid': PARENT, 'parentBirth': BIRTH,
           'startedNs': START, 'readyByNs': START + (42 if role == 'third' else 16) * SECOND,
           'serviceByNs': None if role == 'third' else START + 32 * SECOND,
           'stock': list(STOCK), 'unsetNames': ['AMBIENT_PRIVATE', 'BROWSER_KEY']}
    return row | changes


def packet(row):
    return json.dumps(row, sort_keys=True, separators=(',', ':')).encode('ascii')


class FixedCapsule:
    def __init__(self):
        self.records, self.opened, self.closed, self.offsets = {}, [], [], {}
        parent = None
        for fd, (name, mode) in enumerate((('/', 0o755), ('var', 0o755), ('lib', 0o755),
                                            ('aihr-native-tool-only-427', 0o700), ('code', 0o555),
                                            ('.github', 0o755), ('ci', 0o755)), 11):
            self.records[parent, name] = (fd, self.info(fd, stat.S_IFDIR | mode, 0), None)
            parent = fd
        for fd, (name, _, _) in enumerate(W._BUILDERS, 21):
            raw = HERE.with_name(name).read_bytes()
            self.records[parent, name] = (fd, self.info(fd, stat.S_IFREG | 0o444, len(raw)), raw)

    @staticmethod
    def info(fd, mode, size):
        return SimpleNamespace(st_dev=3, st_ino=fd, st_mode=mode, st_uid=0, st_gid=0, st_nlink=1,
                               st_size=size, st_mtime_ns=1, st_ctime_ns=2)

    def stat(self, name, *, dir_fd, follow_symlinks):
        if follow_symlinks:
            raise AssertionError('capsule names require no-follow')
        return self.records[dir_fd, name][1]

    def open(self, name, flags, *, dir_fd):
        fd, _, raw = self.records[dir_fd, name]
        if flags != (W._DIR if raw is None else W._FILE):
            raise AssertionError('unexpected fixed open mode')
        self.opened.append(name)
        self.offsets[fd] = 0
        return fd

    def fstat(self, fd):
        return next(info for other, info, _ in self.records.values() if fd == other)

    def read(self, fd, count):
        raw = next(raw for other, _, raw in self.records.values() if fd == other)
        index = self.offsets[fd]
        self.offsets[fd] += count
        return raw[index:index + count]

    def close(self, fd):
        self.closed.append(fd)


class Replaced(RuntimeError):
    pass


class WrapperModels(unittest.TestCase):
    def setUp(self):
        self.now = START
        clock = patch.object(W, 'monotonic_ns', lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def test_exact_helper_argv_environment_and_four_fd_actions(self):
        argv, env = W.wrapper_helper_argv('427')
        self.assertEqual(argv, ('/usr/bin/python3', '-I', '-B', '-S',
                         '/var/lib/aihr-native-tool-only-427/code/.github/ci/native-workload-browser-wrapper.py'))
        self.assertEqual(env, (('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), ('LANG', 'C'), ('LC_ALL', 'C')))
        self.assertEqual(W.wrapper_file_actions(10, 15, 20, 31), (
            (os.POSIX_SPAWN_DUP2, 10, 0), (os.POSIX_SPAWN_DUP2, 15, 1),
            (os.POSIX_SPAWN_DUP2, 20, 2), (os.POSIX_SPAWN_DUP2, 31, 3),
            (os.POSIX_SPAWN_CLOSE, 10), (os.POSIX_SPAWN_CLOSE, 15),
            (os.POSIX_SPAWN_CLOSE, 20), (os.POSIX_SPAWN_CLOSE, 31),
        ))
        for args in ((3, 15, 20, 31), (10, 10, 20, 31), (True, 15, 20, 31)):
            with self.subTest(args=args), self.assertRaises(W.Refused):
                W.wrapper_file_actions(*args)
        with self.assertRaises(W.Refused):
            W.wrapper_helper_argv('427/foreign')

    def test_returned_pid_remains_data_even_after_complete_cleanup_slot(self):
        self.assertEqual(W.returned_spawn_pid(None, 100, 50, 100), ('spawn-uncertain', None))
        self.assertEqual(W.returned_spawn_pid(241, 49, 50, 100), ('pid-known-in-slot', 241))
        self.assertEqual(W.returned_spawn_pid(241, 50, 50, 100), ('pid-known-after-launch', 241))
        self.assertEqual(W.returned_spawn_pid(241, 100, 50, 100), ('pid-known-after-cleanup', 241))
        with self.assertRaises(W.Refused):
            W.returned_spawn_pid(True, 100, 50, 100)

    def test_exact_prepare_data_refuses_arbitrary_commands_environment_and_later_time(self):
        for role in ('driver', 'browser', 'third'):
            with self.subTest(role=role):
                self.assertEqual(W._prepare(packet(request(role))), request(role))
        invalid = [request(argv=['/bin/sh']), request(path='/tmp'), request(runId='0427'), request(parentPid=True),
                   request(role='unowned'), request('third', serviceByNs=START + 32 * SECOND),
                   request(readyByNs=START + 33 * SECOND), request(serviceByNs=START + 15 * SECOND),
                   request('browser', spki='x' * 43 + '='), request(unsetNames=['PATH']),
                   request(unsetNames=['BROWSER_KEY', 'AMBIENT_PRIVATE']), request(unsetNames=['BAD=VALUE'])]
        for row in invalid:
            with self.subTest(row=row), self.assertRaises(W.Refused):
                W._prepare(packet(row))
        for raw in (packet(request()) + b'\n', b'{"version":1,"version":1}', b' ' * (W._PREPARE_MAX + 1)):
            with self.subTest(raw_size=len(raw)), self.assertRaises(W.Refused):
                W._prepare(raw)

    def test_stock_command_is_built_from_only_the_three_verified_capsule_members(self):
        for role in ('driver', 'browser', 'third'):
            with self.subTest(role=role):
                model = FixedCapsule()
                with patch.object(W, 'os', model):
                    argv = W._command(request(role), W._Clock(START, START + 16 * SECOND))
                self.assertEqual(model.opened, ['/', 'var', 'lib', 'aihr-native-tool-only-427', 'code', '.github', 'ci',
                                               *(member[0] for member in W._BUILDERS)])
                self.assertEqual(model.closed, [23, 22, 21, 17, 16, 15, 14, 13, 12, 11])
                self.assertEqual(argv[:9], ('/usr/bin/systemd-run', '--system', '--wait', '--pipe', '--quiet',
                                             '--no-ask-password', '--expand-environment=no', '--slice=system.slice',
                                             f'--unit=aihrbc-{role}-427.service'))
                split = argv.index('--')
                self.assertEqual(argv[split - 1], '--property=UnsetEnvironment=AMBIENT_PRIVATE BROWSER_KEY')
                if role == 'third':
                    self.assertEqual(argv[split + 1:], ('/usr/bin/python3', '-I', '-B',
                                     '/run/aihr-browser-capability-427/runtime/roles/native-workload-browser-host.py', 'probe-third'))
                else:
                    service = argv[split + 1:]
                    self.assertEqual(service[:5], ('/usr/bin/python3', '-I', '-B', '-S', '-c'))
                    self.assertEqual(service[6:9], (role, '427', str(START + 32 * SECOND)))
                    self.assertEqual(service[9:], (SPKI,) if role == 'browser' else ())

    def test_same_length_changed_source_and_unsafe_capsule_file_refuse(self):
        for damage in ('bytes', 'mode'):
            with self.subTest(damage=damage):
                model = FixedCapsule()
                key = (17, W._BUILDERS[0][0])
                fd, info, raw = model.records[key]
                if damage == 'bytes':
                    raw = b'X' + raw[1:]
                else:
                    info.st_mode = stat.S_IFLNK | 0o444
                model.records[key] = (fd, info, raw)
                with patch.object(W, 'os', model), self.assertRaisesRegex(W.Refused, '^wrapper-source-(bytes|file)$'):
                    W._load_builders('427', W._Clock(START, START + 16 * SECOND))
                self.assertNotIn(W._BUILDERS[1][0], model.opened)
                self.assertEqual(len(model.closed), len(model.opened))

    def test_control_requires_single_credentials_and_closes_received_rights_on_refusal(self):
        cred = (socket.SOL_SOCKET, socket.SCM_CREDENTIALS, W._UCRED.pack(*PEER))
        channel = Mock()
        channel.recvmsg.return_value = (W._GO, [cred], 0, None)
        self.assertEqual(W._recv(channel, len(W._GO)), (W._GO, PEER))
        rights = (socket.SOL_SOCKET, socket.SCM_RIGHTS, W._RIGHT.pack(44) + W._RIGHT.pack(45))
        with patch.object(W.os, 'close') as close:
            channel.recvmsg.return_value = (W._GO, [cred, rights], socket.MSG_CTRUNC, None)
            with self.assertRaisesRegex(W.Refused, '^wrapper-control-packet$'):
                W._recv(channel, len(W._GO))
            self.assertEqual([call.args for call in close.call_args_list], [(44,), (45,)])
        for body, ancillary, flags in ((b'', [], 0), (W._GO, [cred, cred], 0), (W._GO + b'x', [cred], 0)):
            channel.recvmsg.return_value = (body, ancillary, flags, None)
            with self.assertRaises(W.Refused):
                W._recv(channel, len(W._GO))

    def test_ack_checks_parent_death_first_and_rejects_surplus_or_wrong_peer(self):
        channel = Mock()
        channel.fileno.return_value = 3
        for events, reply in (([{3: select.POLLIN, 29: select.POLLIN}], (W._GO, PEER)),
                              ([{3: select.POLLIN}, {3: select.POLLIN}], (W._GO, PEER)),
                              ([{3: select.POLLIN}], (W._GO, (842, 0, 0))),
                              ([{3: select.POLLHUP}], (W._GO, PEER))):
            with self.subTest(events=events, reply=reply), patch.object(W, '_poll', side_effect=events), \
                    patch.object(W, '_recv', return_value=reply) as read, self.assertRaises(W.Refused):
                W._ack(channel, 29, PEER, W._Clock(START, START + 16 * SECOND))
            if 29 in events[0] or events[0][3] == select.POLLHUP:
                read.assert_not_called()

    def test_stock_exec_restores_explicit_native_signal_policy(self):
        with patch.object(W.signal, 'signal') as disposition, patch.object(W.signal, 'pthread_sigmask') as mask:
            W._restore_signals()
        self.assertEqual([row.args for row in disposition.call_args_list], [(number, signal.SIG_DFL) for number in (
            signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGPIPE, signal.SIGCHLD, signal.SIGXFSZ)])
        mask.assert_called_once_with(signal.SIG_SETMASK, ())

    def test_parent_witness_refuses_changed_birth_or_time_namespace(self):
        for birth, namespace, accepted in ((BIRTH, 7, True), (BIRTH + 1, 7, False), (BIRTH, 8, False)):
            with self.subTest(birth=birth, namespace=namespace):
                fields = [b'S', *([b'0'] * 18), str(birth).encode('ascii')]
                raw = f'{PARENT} (fixed root controller) '.encode('ascii') + b' '.join(fields) + b'\n'
                fake_os = SimpleNamespace(getppid=lambda: PARENT, getpid=lambda: 551,
                                          readlink=Mock(return_value='551'), open=Mock(return_value=24), close=Mock(),
                                          read=Mock(side_effect=[raw, b'']),
                                          stat=Mock(side_effect=[SimpleNamespace(st_dev=3, st_ino=7),
                                                                 SimpleNamespace(st_dev=3, st_ino=namespace)]))
                with patch.object(W, 'os', fake_os), patch.object(W, '_poll', return_value={}), \
                        patch.object(W, '_open_dir', side_effect=[(11, ()), (12, ()), (13, ())]):
                    if accepted:
                        W._parent(request(), 29, W._Clock(START, START + 16 * SECOND))
                    else:
                        with self.assertRaises(W.Refused):
                            W._parent(request(), 29, W._Clock(START, START + 16 * SECOND))
                fake_os.close.assert_called_once_with(24)

    def helper_model(self, *, lose_parent=False, late=False, changed_stdio=False, early=False, wrong_script=False):
        events = []
        info = request()
        cmd = ('/usr/bin/systemd-run', '--fixed-model-command')

        class Channel:
            family = socket.AF_UNIX

            def __enter__(self):
                return self

            def __exit__(self, *_):
                events.append('close-control')

            def fileno(self):
                return 3

            def setblocking(self, flag):
                if flag:
                    raise AssertionError('blocking control')

            def getsockopt(self, level, option):
                return {socket.SO_TYPE: socket.SOCK_SEQPACKET, socket.SO_PASSCRED: 1}[option]

            def send(self, data, flags):
                self_outer.assertEqual(data, W._READY)
                self_outer.assertEqual(flags, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL)
                events.append('ready')
                return len(data)

        self_outer = self
        parent_checks = 0

        def parent(*_):
            nonlocal parent_checks
            parent_checks += 1
            events.append('check-parent')
            if parent_checks == 3 and lose_parent:
                raise W.Refused('wrapper-parent-lost')
            if parent_checks == 3 and late:
                self.now = info['readyByNs']

        def replace(path, argv, env):
            self.assertEqual((path, argv, env), ('/usr/bin/systemd-run', cmd, dict(W._ENV)))
            events.append('exec')
            raise Replaced('mock process replaced')

        fake_os = SimpleNamespace(uname=lambda: SimpleNamespace(machine='x86_64'), getresuid=lambda: (0, 0, 0),
                                  getresgid=lambda: (0, 0, 0), getpid=lambda: 551, getsid=lambda _: 551,
                                  getpgrp=lambda: 551, environ=dict(W._ENV), pidfd_open=lambda _: 29,
                                  set_inheritable=lambda fd, enabled: events.append(('inheritable', fd, enabled)),
                                  close=lambda fd: events.append(('close', fd)), execve=replace)
        path = '/tmp/native-workload-browser-wrapper.py' if wrong_script else W.wrapper_helper_argv('427')[0][-1]
        fake_sys = SimpleNamespace(platform='linux', argv=[path],
                                   flags=SimpleNamespace(isolated=1, no_site=1), dont_write_bytecode=True)
        fake_channel = Channel()
        with ExitStack() as stack:
            for name, value in (('os', fake_os), ('sys', fake_sys), ('_parent', parent), ('_command', lambda *_: cmd),
                                ('_stock_identity', lambda: STOCK), ('_restore_signals', lambda: events.append('signals'))):
                stack.enter_context(patch.object(W, name, value))
            stack.enter_context(patch.object(W.socket, 'socket', return_value=fake_channel))
            stack.enter_context(patch.object(W, '_stdio', side_effect=[(1, 2, 3), (1, 3, 3) if changed_stdio else (1, 2, 3)]))
            stack.enter_context(patch.object(W, '_recv', side_effect=[(packet(info), PEER), (W._GO, PEER)]))
            stack.enter_context(patch.object(W, '_poll', side_effect=[{3: select.POLLIN} if early else {},
                                                                     {3: select.POLLIN}, {}, {}]))
            if lose_parent or late or changed_stdio or early or wrong_script:
                with self.assertRaises(W.Refused):
                    W._helper()
            else:
                with self.assertRaises(Replaced):
                    W._helper()
        return events

    def test_helper_closes_private_fds_after_one_ack_before_exact_exec(self):
        self.assertEqual(self.helper_model(), [('inheritable', 3, False), 'check-parent', 'check-parent', 'ready',
                                              'signals', 'check-parent', ('close', 29), 'close-control', 'exec'])

    def test_parent_loss_expired_slot_or_stdio_change_after_ack_never_executes(self):
        for change in ('lose_parent', 'late', 'changed_stdio'):
            with self.subTest(change=change):
                self.now = START
                events = self.helper_model(**{change: True})
                self.assertEqual(events.count('ready'), 1)
                self.assertEqual(events[-2:], [('close', 29), 'close-control'])
                self.assertNotIn('exec', events)

    def test_queued_control_before_readiness_never_grants_or_executes(self):
        events = self.helper_model(early=True)
        self.assertNotIn('ready', events)
        self.assertNotIn('exec', events)
        self.assertEqual(events[-2:], [('close', 29), 'close-control'])

    def test_non_capsule_entry_refuses_before_touching_control(self):
        self.assertEqual(self.helper_model(wrong_script=True), [])


if __name__ == '__main__':
    unittest.main()
