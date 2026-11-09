"""Fixed, dormant sd-bus transport for the synthetic manager reference owner.

The future protected caller owns verification of the stock library handle,
the connected broker socket and peer, and the held PID 1 process. This leaf
adopts that socket. It has no connector, loader, launcher, stop, or caller wiring.
Decoded fields are bounded here. The stock library owns its wire allocation.
"""

import ctypes as C
import errno
import os
import re
import socket
import stat
import struct
import sys
from threading import get_ident
from time import monotonic_ns
from types import MappingProxyType
from typing import NamedTuple


_SOCKET = '/run/dbus/system_bus_socket'
_DBUS = 'org.freedesktop.DBus'
_DBUS_PATH = '/org/freedesktop/DBus'
_SYSTEMD = 'org.freedesktop.systemd1'
_SYSTEMD_PATH = '/org/freedesktop/systemd1'
_UNIT = _SYSTEMD + '.Unit'
_SERVICE = _SYSTEMD + '.Service'
_ABSENT = _SYSTEMD + '.NoSuchUnit'
_MAX_REMAINING_NS = 75_000_000_000
_P = C.c_void_p
_PP = C.POINTER(_P)
_I = C.c_int
_U64 = C.c_uint64
_STR = C.c_char_p
_HANDLER = C.CFUNCTYPE(_I, _P, _P, _P)

# Independently reconstruct the exact allowed wire request, including the
# expected variant shape. The reference cannot supply a property or signature.
_ROLE_PROPERTIES = MappingProxyType({
    'MAIN_PID': (_SERVICE, 'MainPID', 'u'),
    'CONTROL_PID': (_SERVICE, 'ControlPID', 'u'),
    'EXEC_MAIN_PID': (_SERVICE, 'ExecMainPID', 'u'),
    'MAIN_START_US': (_SERVICE, 'ExecMainStartTimestampMonotonic', 't'),
    'MAIN_EXIT_US': (_SERVICE, 'ExecMainExitTimestampMonotonic', 't'),
    'MAIN_CODE': (_SERVICE, 'ExecMainCode', 'i'),
    'MAIN_STATUS': (_SERVICE, 'ExecMainStatus', 'i'),
    'RESULT': (_SERVICE, 'Result', 's'),
    'ACTIVE_STATE': (_UNIT, 'ActiveState', 's'),
    'SUB_STATE': (_UNIT, 'SubState', 's'),
    'STATE_CHANGE_US': (_UNIT, 'StateChangeTimestampMonotonic', 't'),
    'JOB': (_UNIT, 'Job', '(uo)'),
})
_PROPERTY_INTEGERS = MappingProxyType({'u': C.c_uint32, 'i': C.c_int32, 't': _U64})


class Refused(RuntimeError):
    pass


def _need(ok, reason):
    if not ok:
        raise Refused(reason)


def _success(code, reason):
    _need(code >= 0, reason)
    return code


def _left(deadline):
    remaining = deadline - monotonic_ns()
    _need(1_000 <= remaining <= _MAX_REMAINING_NS, 'manager-transport-deadline')
    return remaining // 1_000


def _unique(name):
    return type(name) is str and re.fullmatch(r':[0-9]{1,20}\.[0-9]{1,20}', name) is not None


def _text(address, limit):
    _need(address is not None and address > 0, 'manager-transport-text')
    raw = bytearray()
    for index in range(limit + 1):
        byte = C.c_ubyte.from_address(address + index).value
        if byte == 0:
            try:
                return raw.decode('ascii')
            except UnicodeDecodeError:
                raise Refused('manager-transport-text-encoding') from None
        raw.append(byte)
    raise Refused('manager-transport-text-bound')


def _socket_birth(fd):
    _need(fd > 2, 'manager-transport-fd')
    info = os.fstat(fd)
    _need(stat.S_ISSOCK(info.st_mode), 'manager-transport-fd')
    return info.st_dev, info.st_ino


def _fd_birth(fd):
    birth = _socket_birth(fd)
    _need(not os.get_inheritable(fd) and not os.get_blocking(fd), 'manager-transport-fd')
    return birth


def _peer(fd, birth):
    # fromfd duplicates the fd. Its short scope never takes libsystemd's ownership.
    with socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        _need(_socket_birth(probe.fileno()) == birth and probe.getpeername() == _SOCKET
              and probe.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) == socket.AF_UNIX
              and probe.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM,
              'manager-transport-peer')
        return struct.unpack('3i', probe.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))


class _ABI:
    """Bind only the stock symbols needed by this fixed course."""

    def __init__(self, library):
        _need(type(library) is C.CDLL, 'manager-transport-library')
        # Public sd-bus ABI in systemd 255.4. The passed DSO is already admitted.
        specs = (
            ('new', _I, _PP), ('set_fd', _I, _P, _I, _I), ('set_bus_client', _I, _P, _I),
            ('negotiate_fds', _I, _P, _I), ('set_watch_bind', _I, _P, _I),
            ('set_exit_on_disconnect', _I, _P, _I), ('set_method_call_timeout', _I, _P, _U64),
            ('start', _I, _P), ('is_ready', _I, _P), ('get_fd', _I, _P), ('get_unique_name', _I, _P, _PP),
            ('process', _I, _P, _PP), ('wait', _I, _P, _U64), ('close_unref', _P, _P),
            ('message_new_method_call', _I, _P, _PP, _STR, _STR, _STR, _STR),
            ('message_set_allow_interactive_authorization', _I, _P, _I),
            ('message_append_basic', _I, _P, C.c_char, _P),
            ('call_async', _I, _P, _PP, _P, _HANDLER, _P, _U64), ('slot_unref', _P, _P),
            ('message_unref', _P, _P), ('message_get_cookie', _I, _P, C.POINTER(_U64)),
            ('message_get_reply_cookie', _I, _P, C.POINTER(_U64)),
            ('message_get_type', _I, _P, C.POINTER(C.c_uint8)), ('message_get_sender', _P, _P),
            ('message_get_signature', _P, _P, _I), ('message_is_method_error', _I, _P, _STR),
            ('message_read_basic', _I, _P, C.c_char, _P), ('message_at_end', _I, _P, _I),
            ('message_enter_container', _I, _P, C.c_char, _STR), ('message_exit_container', _I, _P),
            ('message_read_array', _I, _P, C.c_char, _PP, C.POINTER(C.c_size_t)),
        )
        for name, result, *args in specs:
            symbol = getattr(library, 'sd_bus_' + name)
            symbol.restype = result
            symbol.argtypes = args
            setattr(self, name, symbol)


class _Message(NamedTuple):
    destination: str
    path: str
    interface: str
    member: str
    body: tuple[str, ...]


class _Response(NamedTuple):
    sender: str
    kind: str
    signature: str
    body: tuple
    error: str | None


class ManagerTransport:
    """Adopt one connected socket and yield the closed reference API.

    The source-bound caller supplies an already verified ctypes CDLL handle,
    a connected socket and its independently expected SO_PEERCRED tuple, and
    check_pid1(deadline_ns) returning the held PID 1 start tick after rechecking
    the process. The caller retains socket ownership until detach.
    """

    def __init__(self, reference, *, library, connected_socket, run_id, started_ns, ready_by_ns,
                 broker_peer, manager_birth, check_pid1):
        _need(type(started_ns) is int and type(ready_by_ns) is int and 0 <= started_ns <= monotonic_ns()
              and ready_by_ns in (started_ns + 16_000_000_000, started_ns + 32_000_000_000),
              'manager-transport-frontier')
        _left(ready_by_ns)
        _need(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id)
              and int(run_id) <= 9007199254740991, 'manager-transport-run')
        _need(type(connected_socket) is socket.socket and type(broker_peer) is tuple and len(broker_peer) == 3
              and all(type(x) is int and x >= 0 for x in broker_peer) and broker_peer[0] > 0
              and type(manager_birth) is int and manager_birth > 0 and callable(check_pid1),
              'manager-transport-admission')
        self._abi = _ABI(library)
        self._socket = connected_socket
        self._reference = reference
        self._run, self._started, self._ready_by = run_id, started_ns, ready_by_ns
        self._peer, self._manager_birth, self._check_pid1 = broker_peer, manager_birth, check_pid1
        self._affinity = (os.getpid(), get_ident())
        self._bus = _P()
        self._fd = None
        self._birth = None
        self._detaching = False
        self._installed = False
        self._entered = False
        self._close_attempted = False
        self._busy = False
        self._failed = False
        self._closed_confirmed = False

    def _current_owner(self):
        _need(sys.platform == 'linux' and (os.getpid(), get_ident()) == self._affinity and os.getresuid() == (0, 0, 0)
              and os.getresgid() == (0, 0, 0), 'manager-transport-owner')

    def _pid1(self, deadline):
        _left(deadline)
        seen = self._check_pid1(deadline)
        _need(type(seen) is int and seen == self._manager_birth, 'manager-transport-pid1')
        _left(deadline)

    def _check_peer(self):
        _need(_fd_birth(self._fd) == self._birth and _peer(self._fd, self._birth) == self._peer
              and _fd_birth(self._fd) == self._birth,
              'manager-transport-socket-changed')

    def _socket_ready(self):
        _need(self._abi.get_fd(self._bus) == self._fd, 'manager-transport-socket-changed')
        self._check_peer()
        return _success(self._abi.is_ready(self._bus), 'manager-transport-ready') == 1

    def _socket_current(self):
        _need(self._socket_ready(), 'manager-transport-socket-changed')

    def _client_name(self):
        name = _P()
        _success(self._abi.get_unique_name(self._bus, C.byref(name)), 'manager-transport-client')
        name = _text(name.value, 64)
        _need(_unique(name), 'manager-transport-client')
        return name

    def _pump(self, complete, deadline):
        abi = self._abi
        while not complete():
            _left(deadline)
            progress = _success(abi.process(self._bus, None), 'manager-transport-process')
            _left(deadline)
            if progress == 0 and not complete():
                _success(abi.wait(self._bus, _left(deadline)), 'manager-transport-wait')
        _left(deadline)

    def _read_text(self, message, type_code, limit):
        value = _P()
        _need(self._abi.message_read_basic(message, type_code, C.byref(value)) > 0, 'manager-transport-field')
        return _text(value.value, limit)

    def _read_property_integer(self, message, signature):
        value = _PROPERTY_INTEGERS[signature]()
        _need(self._abi.message_read_basic(message, signature.encode('ascii'), C.byref(value)) > 0,
              'manager-transport-property-field')
        return value.value

    def _read_property_variant(self, message, signature):
        abi = self._abi
        _need(abi.message_enter_container(message, b'v', signature.encode('ascii')) > 0,
              'manager-transport-property-variant')
        if signature == '(uo)':
            _need(abi.message_enter_container(message, b'r', b'uo') > 0, 'manager-transport-property-job')
            value = (self._read_property_integer(message, 'u'), self._read_text(message, b'o', 96))
            _success(abi.message_exit_container(message), 'manager-transport-property-job')
        elif signature == 's':
            value = self._read_text(message, b's', 64)
        else:
            value = self._read_property_integer(message, signature)
        # Stock exit_container refuses unread members of structs and variants.
        _success(abi.message_exit_container(message), 'manager-transport-property-variant')
        return signature, value

    def _decode(self, message, sender, result_type, allow_absent, variant):
        abi = self._abi
        type_code = C.c_uint8()
        _success(abi.message_get_type(message, C.byref(type_code)), 'manager-transport-message-type')
        _need(_text(abi.message_get_sender(message), 64) == sender, 'manager-transport-sender')
        signature = _text(abi.message_get_signature(message, 1), 8)
        if type_code.value == 3:
            _need(allow_absent and signature == 's'
                  and abi.message_is_method_error(message, _ABSENT.encode('ascii')) == 1,
                  'manager-transport-method-refused')
            self._read_text(message, b's', 256)
            _need(abi.message_at_end(message, 1) == 1, 'manager-transport-trailing-field')
            return _Response(sender, 'error', 's', (), _ABSENT)
        _need(type_code.value == 2 and signature == result_type, 'manager-transport-return-shape')
        body = ()
        if signature in ('s', 'o'):
            body = (self._read_text(message, signature.encode('ascii'), 96 if signature == 'o' else 64),)
        elif signature == 'u':
            value = C.c_uint32()
            _need(abi.message_read_basic(message, b'u', C.byref(value)) > 0, 'manager-transport-field')
            body = (value.value,)
        elif signature == 'v' and variant is not None:
            body = self._read_property_variant(message, variant)
        elif signature == 'v':
            pointer, size = _P(), C.c_size_t()
            _need(abi.message_enter_container(message, b'v', b'ay') > 0
                  and abi.message_read_array(message, b'y', C.byref(pointer), C.byref(size)) > 0
                  and size.value == 16 and pointer.value is not None, 'manager-transport-invocation')
            body = ('ay', C.string_at(pointer.value, 16))
            _success(abi.message_exit_container(message), 'manager-transport-invocation')
        _need(abi.message_at_end(message, 1) == 1, 'manager-transport-trailing-field')
        return _Response(sender, 'return', signature, body, None)

    def _call(self, spec, sender, result_type, deadline, *, allow_absent=False, variant=None):
        abi, message, slot, cookie = self._abi, _P(), _P(), _U64()
        response, invalid = None, False

        @_HANDLER
        def receive(reply, _userdata, _error):
            nonlocal response, invalid
            try:
                _left(deadline)
                reply_cookie = _U64()
                _need(reply and response is None and not invalid and cookie.value > 0
                      and abi.message_get_reply_cookie(reply, C.byref(reply_cookie)) >= 0
                      and reply_cookie.value == cookie.value, 'manager-transport-reply-cookie')
                response = self._decode(reply, sender, result_type, allow_absent, variant)
                _left(deadline)
            except BaseException:
                # No exception or native message crosses the ctypes callback boundary.
                invalid = True
            return 1

        try:
            _left(deadline)
            parts = tuple(value.encode('ascii') for value in spec[:4])
            _success(abi.message_new_method_call(self._bus, C.byref(message), *parts), 'manager-transport-message')
            _success(abi.message_set_allow_interactive_authorization(message, 0), 'manager-transport-message')
            for value in spec.body:
                text = _STR(value.encode('ascii'))
                _success(abi.message_append_basic(message, b's', C.cast(text, _P)), 'manager-transport-message')
            _success(abi.call_async(self._bus, C.byref(slot), message, receive, None, _left(deadline)),
                     'manager-transport-dispatch')
            _need(slot.value is not None, 'manager-transport-slot')
            _success(abi.message_get_cookie(message, C.byref(cookie)), 'manager-transport-request-cookie')
            _need(cookie.value > 0, 'manager-transport-request-cookie')
            self._pump(lambda: response is not None or invalid, deadline)
            _need(not invalid and response is not None, 'manager-transport-reply-refused')
            return response
        finally:
            try:
                if slot.value is not None:
                    abi.slot_unref(slot)
            finally:
                if message.value is not None:
                    abi.message_unref(message)

    def _broker(self, member, subject, deadline):
        spec = _Message(_DBUS, _DBUS_PATH, _DBUS, member, (subject,))
        if member == 'GetNameOwner':
            _need(subject == _SYSTEMD, 'manager-transport-broker-subject')
            name, = self._call(spec, _DBUS, 's', deadline).body
            _need(_unique(name), 'manager-transport-manager-name')
            return name
        _need(member in ('GetConnectionUnixProcessID', 'GetConnectionUnixUser') and _unique(subject),
              'manager-transport-broker-subject')
        return self._call(spec, _DBUS, 'u', deadline).body[0]

    def _prove_binding(self, deadline):
        _left(deadline)
        self._socket_current()
        self._pid1(deadline)
        _need(self._client_name() == self._binding.client
              and self._broker('GetNameOwner', _SYSTEMD, deadline) == self._binding.manager,
              'manager-transport-owner-changed')
        self._socket_current()
        self._pid1(deadline)

    def _role_message(self, request):
        op = self._reference._Operation
        _need(type(request) is self._reference._Request and type(request.operation) is op,
              'manager-transport-operation')
        property_slot = _ROLE_PROPERTIES.get(request.operation.name)
        for role in ('driver', 'browser', 'third'):
            unit = f'aihrbc-{role}-{self._run}.service'
            path = f'{_SYSTEMD_PATH}/unit/aihrbc_2d{role}_2d{self._run}_2eservice'
            if request.operation is op.GET_UNIT:
                spec = (_SYSTEMD_PATH, _SYSTEMD + '.Manager', 'GetUnit', 's', (unit,))
            elif request.operation is op.INVOCATION:
                spec = (path, _DBUS + '.Properties', 'Get', 'ss', (_UNIT, 'InvocationID'))
            elif request.operation is op.REF:
                spec = (path, _UNIT, 'Ref', '', ())
            elif property_slot is not None:
                interface, name, _ = property_slot
                spec = (path, _DBUS + '.Properties', 'Get', 'ss', (interface, name))
            else:
                _need(request.operation is op.UNREF, 'manager-transport-operation')
                spec = (path, _UNIT, 'Unref', '', ())
            if request[1:] == (self._binding.manager, *spec):
                variant = property_slot[2] if property_slot is not None else None
                return _Message(self._binding.manager, spec[0], spec[1], spec[2], spec[4]), variant, role
        raise Refused('manager-transport-operation')

    def _exchange(self, request, deadline):
        self._current_owner()
        _need(not self._busy and not self._failed and not self._close_attempted, 'manager-transport-unavailable')
        _need(type(deadline) is int and any(deadline == self._started + second * self._reference._SECOND
                                          for second in self._reference._FRONTIERS),
              'manager-transport-frontier')
        spec, variant, role = self._role_message(request)
        if variant is not None and role == 'third':
            _need(deadline <= self._started + 42_000_000_000, 'manager-transport-frontier')
        op = self._reference._Operation
        self._busy = True
        try:
            self._prove_binding(deadline)
            result_type = ('v' if variant is not None else
                           {op.GET_UNIT: 'o', op.INVOCATION: 'v', op.REF: '', op.UNREF: ''}[request.operation])
            reply = self._call(spec, self._binding.manager, result_type, deadline,
                               allow_absent=request.operation is op.GET_UNIT, variant=variant)
            self._prove_binding(deadline)
            return self._reference.ManagerReply(self._binding, *reply)
        except BaseException:
            self._failed = True
            raise
        finally:
            self._busy = False

    def __enter__(self):
        self._current_owner()
        _need(not self._entered, 'manager-transport-entry')
        self._entered = True
        abi, deadline = self._abi, self._ready_by
        try:
            self._pid1(deadline)
            self._fd = self._socket.fileno()
            self._birth = _fd_birth(self._fd)
            self._check_peer()
            _left(deadline)
            _success(abi.new(C.byref(self._bus)), 'manager-transport-new')
            _need(self._bus.value is not None, 'manager-transport-new')
            for function, value in ((abi.set_bus_client, 1), (abi.negotiate_fds, 0), (abi.set_watch_bind, 0),
                                    (abi.set_exit_on_disconnect, 0)):
                _left(deadline)
                _success(function(self._bus, value), 'manager-transport-config')
            _success(abi.set_method_call_timeout(self._bus, _left(deadline)), 'manager-transport-config')
            self._pid1(deadline)
            _need(self._socket.fileno() == self._fd, 'manager-transport-socket-changed')
            self._check_peer()
            _left(deadline)
            self._detaching = True
            _need(self._socket.detach() == self._fd and self._socket.fileno() == -1,
                  'manager-transport-detach')
            self._check_peer()
            _left(deadline)
            _success(abi.set_fd(self._bus, self._fd, self._fd), 'manager-transport-set-fd')
            self._installed = True
            self._pid1(deadline)
            _need(abi.get_fd(self._bus) == self._fd, 'manager-transport-socket-changed')
            self._check_peer()
            _left(deadline)
            _success(abi.start(self._bus), 'manager-transport-start')

            def hello_ready():
                _left(deadline)
                return self._socket_ready()

            self._pump(hello_ready, deadline)
            self._socket_current()
            client = self._client_name()
            manager = self._broker('GetNameOwner', _SYSTEMD, deadline)
            _need(client != manager and self._broker('GetConnectionUnixProcessID', manager, deadline) == 1
                  and self._broker('GetConnectionUnixUser', manager, deadline) == 0,
                  'manager-transport-manager-credentials')
            self._binding = self._reference.ManagerBinding(*self._birth, client, manager, 1, 0, self._manager_birth)
            self._prove_binding(deadline)
            self._owner = self._reference.ManagerReference(run_id=self._run, started_ns=self._started,
                                                           binding=self._binding, exchange=self._exchange)
            return self._owner
        except BaseException as primary:
            self._close_preserving(primary)
            raise

    def _require_fd_closed(self):
        try:
            os.fstat(self._fd)
        except OSError as error:
            _need(error.errno == errno.EBADF, 'manager-transport-close-fd')
        else:
            raise Refused('manager-transport-close-fd')

    def _release_bus(self):
        if self._bus.value is not None:
            _need(self._abi.close_unref(self._bus) is None, 'manager-transport-close-native')
            self._bus = _P()

    def _close(self):
        self._current_owner()
        _need(not self._busy and not self._close_attempted, 'manager-transport-close-order')
        self._close_attempted = True
        live = self._abi.get_fd(self._bus) if self._bus.value is not None else -errno.ENOTCONN
        if not self._detaching or self._socket.fileno() == self._fd:
            _need(live == -errno.ENOTCONN and not self._installed, 'manager-transport-close-identity')
            self._release_bus()
            return
        _need(self._socket.fileno() == -1, 'manager-transport-close-identity')
        if live == self._fd:
            # A set_fd interruption can still leave the descriptor owned by sd-bus.
            _need(_socket_birth(live) == self._birth, 'manager-transport-close-identity')
            self._release_bus()
            self._require_fd_closed()
        else:
            _need(live == -errno.ENOTCONN, 'manager-transport-close-identity')
            if self._installed:
                # A negative native start can have already closed the installed fd.
                self._require_fd_closed()
                self._release_bus()
            else:
                _need(_socket_birth(self._fd) == self._birth, 'manager-transport-close-identity')
                try:
                    os.close(self._fd)
                    self._require_fd_closed()
                finally:
                    self._release_bus()
        self._closed_confirmed = True

    def _close_preserving(self, primary):
        try:
            self._close()
        except BaseException:
            if primary is None:
                raise Refused('manager-transport-close-unconfirmed') from None
            primary.add_note('manager-transport-close-unconfirmed')

    def __exit__(self, exc_type, exc, traceback):
        self._close_preserving(exc)
        return False

    @property
    def closed_confirmed(self):
        """Exact local FD closure only. Unit collection and clocks are separate."""
        return self._closed_confirmed
