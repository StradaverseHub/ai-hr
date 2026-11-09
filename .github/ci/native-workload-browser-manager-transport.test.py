"""Models of the fixed sd-bus ABI boundary. No native bus, socket or unit."""

import ctypes as C
import errno
import pathlib
import socket
import stat
import struct
import unittest
from types import ModuleType, SimpleNamespace
from typing import NamedTuple
from unittest.mock import patch


def load(name, filename):
    path = pathlib.Path(__file__).with_name(filename)
    module = ModuleType(name)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


T = load('native_browser_manager_transport_model', 'native-workload-browser-manager-transport.py')
R = load('native_browser_manager_reference_model', 'native-workload-browser-manager-reference.py')
START = 3_000_000_000
SECOND = 1_000_000_000
PEER = (1, 0, 0)
PID1_BIRTH = 271
MANAGER = ':1.4'
CLIENT = ':1.87'
BROKER = 'org.freedesktop.DBus'
INVOCATION = bytes(range(16))
UNIT = '/org/freedesktop/systemd1/unit/aihrbc_2ddriver_2d427_2eservice'
FD = 63
PROBE_FD = 64


def set_value(address, data_type, value):
    C.cast(address, C.POINTER(data_type)).contents.value = value


class Frame(NamedTuple):
    sender: str
    signature: str
    fields: tuple = ()
    error: str | None = None
    serial: int | None = None


class ConnectedSocket:
    def __init__(self, bus):
        self.bus = bus
        self.fd = FD

    def fileno(self):
        return self.fd

    def detach(self):
        self.bus.trace.append(('detach', self.fd))
        if self.bus.detach_failure == 'before':
            raise KeyboardInterrupt('detach interrupted')
        self.fd = -1
        if self.bus.detach_failure == 'after':
            raise KeyboardInterrupt('detach interrupted')
        return FD


class PeerProbe:
    def __init__(self, bus):
        self.bus = bus

    def __enter__(self):
        self.bus.probes += 1
        return self

    def __exit__(self, *exc):
        self.bus.probes -= 1

    def fileno(self):
        return PROBE_FD

    def getpeername(self):
        return self.bus.peer_path

    def getsockopt(self, level, option, size=None):
        self.bus.test.assertEqual(level, socket.SOL_SOCKET)
        if option == socket.SO_DOMAIN:
            return self.bus.domain
        if option == socket.SO_TYPE:
            return self.bus.socket_type
        self.bus.test.assertEqual((option, size), (socket.SO_PEERCRED, struct.calcsize('3i')))
        self.bus.trace.append(('peer', FD, self.bus.broker_peer))
        return struct.pack('3i', *self.bus.broker_peer)


class BusModel:
    def __init__(self, test):
        self.test = test
        self.config = []
        self.requests = []
        self.waits = []
        self.release = []
        self.deadline_late_for = None
        self.ready = False
        self.hold_hello = False
        self.fail_close = False
        self.closed = False
        self.native_closes = 0
        self.native_fd_closes = 0
        self.python_closes = 0
        self.native_fd = None
        self.probes = 0
        self.trace = []
        self.detach_failure = None
        self.set_fd_failure = None
        self.after_set_fd = None
        self.start_failure = None
        self.broker_peer = PEER
        self.probe_birth = None
        self.peer_path = '/run/dbus/system_bus_socket'
        self.domain = socket.AF_UNIX
        self.socket_type = socket.SOCK_STREAM
        self.blocking = False
        self.inheritable = False
        self.birth = (9, 41)
        self.manager_name = MANAGER
        self.manager_pid = 1
        self.manager_uid = 0
        self.cookie = 0
        self.loaded = False
        self.frame = None
        self.override = {}
        self.arrays = []
        self.pending = None
        self.hello_processed = 0
        self.next_body = []
        self.cursor = 0

    def _array(self, value):
        storage = C.create_string_buffer(value)
        self.arrays.append(storage)
        return C.addressof(storage)

    def _cstring(self, value):
        return self._array(value.encode('ascii'))

    def new(self, output):
        set_value(output, C.c_void_p, 91)
        return 0

    def __getattr__(self, name):
        if name not in ('set_bus_client', 'negotiate_fds', 'set_watch_bind',
                        'set_exit_on_disconnect', 'set_method_call_timeout'):
            raise AttributeError(name)

        def configure(_bus, value):
            self.config.append((name, value))
            return 0

        return configure

    def set_fd(self, _bus, read_fd, write_fd):
        self.test.assertEqual((read_fd, write_fd), (FD, FD))
        self.test.assertEqual(self.test.connected.fileno(), -1)
        self.test.assertIsNone(self.native_fd)
        self.test.assertEqual(self.probes, 0)
        self.config.append(('set_fd', (read_fd, write_fd)))
        self.trace.append(('set_fd', read_fd, write_fd))
        if self.set_fd_failure == 'rejected':
            return -errno.EINVAL
        self.native_fd = read_fd
        if self.after_set_fd:
            self.after_set_fd()
        if self.set_fd_failure == 'interrupted':
            raise KeyboardInterrupt('set_fd interrupted')
        return 0

    def start(self, _bus):
        self.test.assertEqual((self.native_fd, self.probes), (FD, 0))
        self.trace.append(('start', FD))
        self.config.append(('start', None))
        if self.start_failure == 'closed':
            self.close_native_fd()
        elif self.start_failure == 'unproved':
            self.native_fd = None
        if self.start_failure:
            return -errno.EIO
        return 0

    def is_ready(self, _bus):
        return int(self.ready)

    def get_fd(self, _bus):
        return -errno.ENOTCONN if self.native_fd is None else self.native_fd

    def get_unique_name(self, _bus, output):
        set_value(output, C.c_void_p, self._cstring(CLIENT))
        return 0

    def wait(self, _bus, usec):
        self.waits.append(usec)
        self.test.now += usec * 1000 if self.hold_hello else 2000
        return 0

    def process(self, _bus, _unused):
        if not self.ready:
            self.hello_processed += 1
            self.ready = not self.hold_hello and self.hello_processed == 2
            return int(self.ready)
        self.test.assertIsNotNone(self.pending)
        callback, self.pending = self.pending, None
        if self.requests[-1][3] == self.deadline_late_for:
            self.test.now = START + 32 * SECOND
        return callback(92, None, None)

    def message_new_method_call(self, _bus, output, *fields):
        self.next_request = tuple(value.decode('ascii') for value in fields)
        self.next_body = []
        set_value(output, C.c_void_p, 73)
        return 0

    def message_set_allow_interactive_authorization(self, _message, enabled):
        self.test.assertEqual(enabled, 0)
        return 0

    def message_append_basic(self, _message, type_code, value):
        self.test.assertEqual(type_code, b's')
        self.next_body.append(C.string_at(value).decode('ascii'))
        return 0

    def _frame(self, member):
        if member in self.override:
            return self.override[member]
        if member == 'GetNameOwner':
            return Frame(BROKER, 's', (self.manager_name,))
        if member == 'GetConnectionUnixProcessID':
            return Frame(BROKER, 'u', (self.manager_pid,))
        if member == 'GetConnectionUnixUser':
            return Frame(BROKER, 'u', (self.manager_uid,))
        if member == 'GetUnit':
            if self.loaded:
                return Frame(MANAGER, 'o', (UNIT,))
            return Frame(MANAGER, 's', ('fixed private text',), 'org.freedesktop.systemd1.NoSuchUnit')
        if member == 'Get':
            return Frame(MANAGER, 'v', (('ay', INVOCATION),))
        self.test.assertIn(member, ('Ref', 'Unref'))
        return Frame(MANAGER, '')

    def call_async(self, _bus, slot, _message, callback, _userdata, usec):
        self.test.assertIsNone(self.pending)
        self.test.assertGreater(usec, 0)
        self.cookie += 1
        self.requests.append((*self.next_request, tuple(self.next_body), usec))
        self.pending = callback
        self.frame = self._frame(self.next_request[3])
        self.cursor = 0
        set_value(slot, C.c_void_p, 74)
        return 1

    def message_get_cookie(self, _message, output):
        set_value(output, C.c_uint64, self.cookie)
        return 0

    def message_get_reply_cookie(self, _message, output):
        serial = self.frame.serial if self.frame.serial is not None else self.cookie
        set_value(output, C.c_uint64, serial)
        return 0

    def message_get_type(self, _message, output):
        set_value(output, C.c_uint8, 3 if self.frame.error else 2)
        return 0

    def message_get_sender(self, _message):
        return self._cstring(self.frame.sender)

    def message_get_signature(self, _message, complete):
        self.test.assertEqual(complete, 1)
        return self._cstring(self.frame.signature)

    def message_is_method_error(self, _message, name):
        return int(self.frame.error == name.decode('ascii'))

    def message_read_basic(self, _message, type_code, output):
        value = self.frame.fields[self.cursor]
        self.cursor += 1
        if type_code == b'u':
            set_value(output, C.c_uint32, value)
        else:
            set_value(output, C.c_void_p, self._cstring(value))
        return 1

    def message_enter_container(self, _message, tag, contents):
        return int((tag, contents) == (b'v', b'ay') and self.frame.fields[0][0] == 'ay')

    def message_read_array(self, _message, type_code, output, length):
        self.test.assertEqual(type_code, b'y')
        _, value = self.frame.fields[self.cursor]
        self.cursor += 1
        set_value(output, C.c_void_p, self._array(value))
        set_value(length, C.c_size_t, len(value))
        return 1

    def message_exit_container(self, _message):
        return 1

    def message_at_end(self, _message, complete):
        self.test.assertEqual(complete, 1)
        return int(self.cursor == len(self.frame.fields))

    def slot_unref(self, _slot):
        self.release.append('slot')

    def message_unref(self, _message):
        self.release.append('message')

    def close_native_fd(self):
        self.test.assertFalse(self.closed)
        self.test.assertEqual(self.native_fd, FD)
        self.native_fd_closes += 1
        self.native_fd = None
        self.closed = True

    def close_unref(self, _bus):
        self.native_closes += 1
        if self.native_fd is not None and not self.fail_close:
            self.close_native_fd()
        return None


class ManagerTransportModels(unittest.TestCase):
    def setUp(self):
        self.now = START
        self.pid1_birth = PID1_BIRTH
        self.abi = BusModel(self)

        def fstat(fd):
            self.assertIn(fd, (FD, PROBE_FD))
            if self.abi.closed:
                raise OSError(errno.EBADF, 'model fd closed')
            device, inode = self.abi.birth
            if fd == PROBE_FD:
                self.assertEqual(self.abi.probes, 1)
                if self.abi.probe_birth is not None:
                    device, inode = self.abi.probe_birth
            return SimpleNamespace(st_dev=device, st_ino=inode, st_mode=stat.S_IFSOCK)

        def close(fd):
            self.assertEqual(fd, FD)
            self.assertEqual(self.connected.fileno(), -1)
            self.assertIsNone(self.abi.native_fd)
            self.assertFalse(self.abi.closed)
            self.abi.python_closes += 1
            self.abi.closed = True

        def fromfd(fd, domain, kind):
            self.assertEqual((fd, domain, kind), (FD, socket.AF_UNIX, socket.SOCK_STREAM))
            self.assertFalse(self.abi.closed)
            return PeerProbe(self.abi)

        socket_model = SimpleNamespace(socket=ConnectedSocket, fromfd=fromfd, AF_UNIX=socket.AF_UNIX,
                                       SOCK_STREAM=socket.SOCK_STREAM, SOL_SOCKET=socket.SOL_SOCKET,
                                       SO_DOMAIN=socket.SO_DOMAIN, SO_TYPE=socket.SO_TYPE, SO_PEERCRED=socket.SO_PEERCRED)

        for name, value in (
            ('_ABI', lambda _library: self.abi), ('monotonic_ns', lambda: self.now),
            ('socket', socket_model),
            ('os', SimpleNamespace(getpid=lambda: 7, fstat=fstat, close=close,
                                   get_inheritable=lambda _fd: self.abi.inheritable,
                                   get_blocking=lambda _fd: self.abi.blocking)),
        ):
            owner = patch.object(T, name, value)
            owner.start()
            self.addCleanup(owner.stop)
        affine = patch.object(T.ManagerTransport, '_current_owner', lambda _owner: None)
        affine.start()
        self.addCleanup(affine.stop)
        reference_clock = patch.object(R, 'monotonic_ns', lambda: self.now)
        reference_clock.start()
        self.addCleanup(reference_clock.stop)

    def transport(self, **changes):
        self.connected = ConnectedSocket(self.abi)
        values = dict(library=object(), connected_socket=self.connected, run_id='427', started_ns=START,
                      ready_by_ns=START + 16 * SECOND,
                      broker_peer=PEER, manager_birth=PID1_BIRTH, check_pid1=lambda _deadline: self.pid1_birth)
        return T.ManagerTransport(R, **(values | changes))

    def members(self):
        return [request[3] for request in self.abi.requests]

    def test_async_hello_and_same_socket_close_around_fixed_reference_course(self):
        transport = self.transport()
        with transport as owner:
            self.assertEqual(self.members(), ['GetNameOwner', 'GetConnectionUnixProcessID',
                                              'GetConnectionUnixUser', 'GetNameOwner'])
            self.assertEqual(self.abi.config, [('set_bus_client', 1), ('negotiate_fds', 0), ('set_watch_bind', 0),
                             ('set_exit_on_disconnect', 0), ('set_method_call_timeout', 16000000),
                             ('set_fd', (FD, FD)), ('start', None)])
            self.assertEqual(self.abi.trace[:7], [('peer', FD, PEER), ('peer', FD, PEER), ('detach', FD),
                                                 ('peer', FD, PEER), ('set_fd', FD, FD), ('peer', FD, PEER),
                                                 ('start', FD)])
            self.assertEqual(self.connected.fileno(), -1)
            self.assertEqual(self.abi.waits, [16000000])
            exchange_start = self.now
            elapsed_ns = 2500
            native_call = self.abi.call_async

            def elapsed_call(bus, *args):
                self.assertIs(bus, transport._bus)
                self.assertEqual(bus.value, 91)
                self.assertEqual(self.abi.release, ['slot', 'message'] * len(self.abi.requests))
                result = native_call(bus, *args)
                self.now += elapsed_ns
                return result

            self.abi.call_async = elapsed_call
            owner.before_launch('driver', 16)
            self.abi.loaded = True
            owner.retain('driver', INVOCATION, 32)
            owner.release_after_terminal('driver', INVOCATION, 75)
            self.assertFalse(owner.collected('driver', 75))
            self.abi.loaded = False
            self.assertTrue(owner.collected('driver', 75))
            broker = (BROKER, '/org/freedesktop/DBus', BROKER, 'GetNameOwner', ('org.freedesktop.systemd1',))
            lookup = (MANAGER, '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit',
                      ('aihrbc-driver-427.service',))
            invocation = (MANAGER, UNIT, 'org.freedesktop.DBus.Properties', 'Get',
                          ('org.freedesktop.systemd1.Unit', 'InvocationID'))
            retain = (MANAGER, UNIT, 'org.freedesktop.systemd1.Unit', 'Ref', ())
            release = (MANAGER, UNIT, 'org.freedesktop.systemd1.Unit', 'Unref', ())
            role_calls = (lookup, lookup, invocation, retain, invocation, invocation, release, lookup, lookup)
            expected = [call for role in role_calls for call in (broker, role, broker)]
            self.assertEqual([request[:5] for request in self.abi.requests[4:]], expected)
            frontiers = (16, 32, 32, 32, 32, 75, 75, 75, 75)
            remaining = [(START + frontier * SECOND - exchange_start - (index * 3 + offset) * elapsed_ns) // 1000
                         for index, frontier in enumerate(frontiers) for offset in range(3)]
            self.assertEqual([row[5] for row in self.abi.requests[4:]], remaining)
            self.assertEqual(self.abi.release, ['slot', 'message'] * len(self.abi.requests))
            self.assertFalse(transport.closed_confirmed)
        self.assertTrue(transport.closed_confirmed)
        self.assertEqual(self.abi.native_closes, 1)
        self.assertEqual((self.abi.native_fd_closes, self.abi.python_closes, self.abi.probes), (1, 0, 0))

    def test_hello_uses_absolute_frontier_even_before_any_method(self):
        self.abi.hold_hello = True
        transport = self.transport()
        with self.assertRaisesRegex(T.Refused, '^manager-transport-deadline$'), transport:
            self.fail('late hello admitted the reference')
        self.assertEqual(self.abi.waits, [16000000])
        self.assertEqual(self.abi.requests, [])
        self.assertTrue(transport.closed_confirmed)

    def test_refuses_wrong_socket_peer_and_manager_credentials_before_role_calls(self):
        for field, value in (('broker_peer', (19, 0, 0)), ('peer_path', '/foreign'), ('domain', socket.AF_INET),
                             ('socket_type', socket.SOCK_DGRAM), ('blocking', True), ('inheritable', True),
                             ('probe_birth', (9, 42)), ('manager_pid', 2), ('manager_uid', 65534)):
            with self.subTest(field=field):
                self.abi = BusModel(self)
                setattr(self.abi, field, value)
                transport = self.transport()
                with self.assertRaises(T.Refused), transport:
                    self.fail('wrong peer admitted the reference')
                self.assertNotIn('GetUnit', self.members())
                if field in ('manager_pid', 'manager_uid'):
                    self.assertTrue(transport.closed_confirmed)
                else:
                    self.assertEqual((self.abi.config, self.abi.requests, self.abi.hello_processed), ([], [], 0))
                    self.assertEqual(self.connected.fileno(), FD)
                    self.assertEqual((self.abi.native_closes, self.abi.python_closes, self.abi.probes), (0, 0, 0))
                    self.assertFalse(transport.closed_confirmed)

    def test_exact_error_sender_cookie_and_body_are_required_for_absence(self):
        absence = Frame(MANAGER, 's', ('private error',), 'org.freedesktop.systemd1.NoSuchUnit')
        failures = (absence._replace(sender=':1.5'), absence._replace(serial=1234), absence._replace(signature='ss'),
                    absence._replace(fields=('expected field', 'trailing')), absence._replace(fields=('a' * 257,)),
                    absence._replace(error='org.freedesktop.DBus.Error.NoReply'))
        for frame in failures:
            with self.subTest(frame=frame):
                self.abi = BusModel(self)
                self.abi.override['GetUnit'] = frame
                transport = self.transport()
                with transport as owner, self.assertRaisesRegex(R.Refused, '^manager-reference-transport$'):
                    owner.before_launch('driver', 16)
                self.assertEqual(owner.phase('driver'), 'new')
                self.assertEqual(self.members().count('GetUnit'), 1)
                self.assertTrue(transport.closed_confirmed)

    def test_invocation_read_requires_bounded_exact_variant_before_ref(self):
        self.abi.override['Get'] = Frame(MANAGER, 'v', (('ay', bytes(17)),))
        transport = self.transport()
        with transport as owner:
            owner.before_launch('driver', 16)
            self.abi.loaded = True
            with self.assertRaisesRegex(R.Refused, '^manager-reference-transport$'):
                owner.retain('driver', INVOCATION, 32)
        self.assertNotIn('Ref', self.members())
        self.assertTrue(transport.closed_confirmed)

    def test_ref_reply_at_frontier_is_ambiguous_and_drops_slot_without_retry(self):
        self.abi.deadline_late_for = 'Ref'
        transport = self.transport()
        with transport as owner:
            owner.before_launch('driver', 16)
            self.abi.loaded = True
            with self.assertRaisesRegex(R.Refused, '^manager-reference-transport$'):
                owner.retain('driver', INVOCATION, 32)
            self.assertEqual(owner.phase('driver'), 'ref-attempted')
            with self.assertRaisesRegex(R.Refused, '^manager-reference-unavailable$'):
                owner.retain('driver', INVOCATION, 32)
        self.assertEqual(self.members().count('Ref'), 1)
        self.assertEqual(self.abi.release[-2:], ['slot', 'message'])
        self.assertTrue(transport.closed_confirmed)

    def test_changed_pid1_or_manager_name_never_admits_a_role_call(self):
        for name, value in (('pid1_birth', PID1_BIRTH + 1), ('manager_name', ':1.9')):
            with self.subTest(name=name):
                self.abi = BusModel(self)
                self.pid1_birth = PID1_BIRTH
                transport = self.transport()
                with transport as owner:
                    setattr(self if name == 'pid1_birth' else self.abi, name, value)
                    with self.assertRaisesRegex(R.Refused, '^manager-reference-transport$'):
                        owner.before_launch('driver', 16)
                self.assertNotIn('GetUnit', self.members())

    def test_native_boundary_refuses_mutated_verbs_paths_bodies_and_frontiers(self):
        transport = self.transport()
        with transport as owner:
            fixed = owner._request(R._Operation.GET_UNIT, 'driver')
            for forged in (fixed._replace(member='StartUnit'), fixed._replace(destination=':1.8'),
                           fixed._replace(path='/foreign'), fixed._replace(body=('outside.service',)),
                           fixed._replace(signature='o')):
                with self.subTest(forged=forged), self.assertRaisesRegex(T.Refused, '^manager-transport-operation$'):
                    transport._exchange(forged, START + 16 * SECOND)
            with self.assertRaisesRegex(T.Refused, '^manager-transport-frontier$'):
                transport._exchange(fixed, START + 17 * SECOND)
        self.assertNotIn('GetUnit', self.members())
        self.assertNotIn('StartUnit', self.members())

    def test_close_is_independent_and_never_replaces_primary_failure(self):
        self.abi.fail_close = True
        transport = self.transport()
        primary = ValueError('original failure')
        with self.assertRaises(ValueError) as failure, transport:
            raise primary
        self.assertIs(failure.exception, primary)
        self.assertEqual(primary.__notes__, ['manager-transport-close-unconfirmed'])
        self.assertFalse(transport.closed_confirmed)
        self.assertEqual(self.abi.native_closes, 1)

    def test_changed_fd_refuses_native_close_without_touching_other_file(self):
        transport = self.transport()
        with self.assertRaisesRegex(T.Refused, '^manager-transport-close-unconfirmed$'), transport:
            self.abi.birth = (9, 42)
        self.assertEqual(self.abi.native_closes, 0)
        self.assertFalse(transport.closed_confirmed)

    def test_detach_interruption_distinguishes_caller_owned_and_detached_fd(self):
        for stage in ('before', 'after'):
            with self.subTest(stage=stage):
                self.abi = BusModel(self)
                self.abi.detach_failure = stage
                transport = self.transport()
                with self.assertRaisesRegex(KeyboardInterrupt, '^detach interrupted$'), transport:
                    self.fail('interrupted detach admitted the reference')
                self.assertEqual(self.abi.config[-1], ('set_method_call_timeout', 16000000))
                self.assertEqual((self.abi.native_closes, self.abi.native_fd_closes, self.abi.hello_processed), (1, 0, 0))
                self.assertEqual(self.abi.python_closes, int(stage == 'after'))
                self.assertEqual(self.connected.fileno(), -1 if stage == 'after' else FD)
                self.assertEqual(transport.closed_confirmed, stage == 'after')

    def test_set_fd_failure_distinguishes_uninstalled_and_native_owned_fd(self):
        for stage, failure, reason, counts in (
            ('rejected', T.Refused, 'manager-transport-set-fd', (0, 1)),
            ('interrupted', KeyboardInterrupt, 'set_fd interrupted', (1, 0)),
        ):
            with self.subTest(stage=stage):
                self.abi = BusModel(self)
                self.abi.set_fd_failure = stage
                transport = self.transport()
                with self.assertRaisesRegex(failure, '^' + reason + '$'), transport:
                    self.fail('failed set_fd admitted the reference')
                self.assertEqual(self.abi.config[-1], ('set_fd', (FD, FD)))
                self.assertEqual((self.abi.native_closes, self.abi.hello_processed), (1, 0))
                self.assertEqual((self.abi.native_fd_closes, self.abi.python_closes), counts)
                self.assertTrue(transport.closed_confirmed)

    def test_start_failure_distinguishes_retained_closed_and_unproved_native_fd(self):
        for stage in ('retained', 'closed', 'unproved'):
            with self.subTest(stage=stage):
                self.abi = BusModel(self)
                self.abi.start_failure = stage
                transport = self.transport()
                with self.assertRaisesRegex(T.Refused, '^manager-transport-start$') as failed, transport:
                    self.fail('failed start admitted the reference')
                self.assertEqual(self.abi.config[-1], ('start', None))
                self.assertEqual((self.abi.hello_processed, self.abi.python_closes, self.abi.requests), (0, 0, []))
                settled = stage != 'unproved'
                self.assertEqual((self.abi.native_closes, self.abi.native_fd_closes), (int(settled), int(settled)))
                self.assertEqual(transport.closed_confirmed, settled)
                self.assertEqual(getattr(failed.exception, '__notes__', []),
                                 [] if settled else ['manager-transport-close-unconfirmed'])

    def test_late_or_replaced_socket_is_refused_after_set_fd_before_start(self):
        for field, value, reason, settled in (
            ('now', START + 16 * SECOND, 'manager-transport-deadline', True),
            ('birth', (9, 42), 'manager-transport-socket-changed', False),
            ('broker_peer', (19, 0, 0), 'manager-transport-socket-changed', True),
        ):
            with self.subTest(field=field):
                self.now = START
                self.abi = BusModel(self)
                self.abi.after_set_fd = lambda: setattr(self if field == 'now' else self.abi, field, value)
                transport = self.transport()
                with self.assertRaisesRegex(T.Refused, '^' + reason + '$'), transport:
                    self.fail('late or changed socket admitted the reference')
                self.assertEqual(self.abi.config[-1], ('set_fd', (FD, FD)))
                self.assertEqual((self.abi.hello_processed, self.abi.python_closes, self.abi.requests), (0, 0, []))
                self.assertEqual(self.abi.native_closes, int(settled))
                self.assertEqual(transport.closed_confirmed, settled)


if __name__ == '__main__':
    unittest.main()
