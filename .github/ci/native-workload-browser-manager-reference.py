"""Dormant reference contract for the three stock synthetic browser units.

The protected caller must separately own the authenticated broker connection,
PID 1, live role, and raw terminal observations. The fixed exchange seam has
no physical implementation here and gives no authority to launch or stop a
unit, prove process settlement, or claim the broker file descriptor closed.
"""

import re
from contextlib import contextmanager
from enum import Enum
from time import monotonic_ns
from types import MappingProxyType
from typing import NamedTuple


_SERVICE = 'org.freedesktop.systemd1'
_MANAGER = _SERVICE + '.Manager'
_UNIT = _SERVICE + '.Unit'
_SERVICE_INTERFACE = _SERVICE + '.Service'
_MANAGER_PATH = '/org/freedesktop/systemd1'
_NO_SUCH_UNIT = _SERVICE + '.NoSuchUnit'
_ROLES = ('driver', 'browser', 'third')
_FRONTIERS = (16, 32, 42, 56, 60, 75)
_SECOND = 1_000_000_000
_NS_PER_US = 1_000
_CLD_EXITED, _CLD_KILLED, _CLD_DUMPED = 1, 2, 3  # Linux waitid si_code


class Refused(RuntimeError):
    pass


def _require(condition, reason):
    if not condition:
        raise Refused(reason)


class _Operation(Enum):
    GET_UNIT = 'get-unit'
    INVOCATION = 'invocation'
    REF = 'ref'
    UNREF = 'unref'
    MAIN_PID = 'main-pid'
    CONTROL_PID = 'control-pid'
    EXEC_MAIN_PID = 'exec-main-pid'
    MAIN_START_US = 'main-start-us'
    MAIN_EXIT_US = 'main-exit-us'
    MAIN_CODE = 'main-code'
    MAIN_STATUS = 'main-status'
    RESULT = 'result'
    ACTIVE_STATE = 'active-state'
    SUB_STATE = 'sub-state'
    STATE_CHANGE_US = 'state-change-us'
    JOB = 'job'


# The current physical transport refuses these new slots before native I/O.
_TYPED_PROPERTIES = MappingProxyType({
    _Operation.MAIN_PID: (_SERVICE_INTERFACE, 'MainPID', 'u'),
    _Operation.CONTROL_PID: (_SERVICE_INTERFACE, 'ControlPID', 'u'),
    _Operation.EXEC_MAIN_PID: (_SERVICE_INTERFACE, 'ExecMainPID', 'u'),
    _Operation.MAIN_START_US: (_SERVICE_INTERFACE, 'ExecMainStartTimestampMonotonic', 't'),
    _Operation.MAIN_EXIT_US: (_SERVICE_INTERFACE, 'ExecMainExitTimestampMonotonic', 't'),
    _Operation.MAIN_CODE: (_SERVICE_INTERFACE, 'ExecMainCode', 'i'),
    _Operation.MAIN_STATUS: (_SERVICE_INTERFACE, 'ExecMainStatus', 'i'),
    _Operation.RESULT: (_SERVICE_INTERFACE, 'Result', 's'),
    _Operation.ACTIVE_STATE: (_UNIT, 'ActiveState', 's'),
    _Operation.SUB_STATE: (_UNIT, 'SubState', 's'),
    _Operation.STATE_CHANGE_US: (_UNIT, 'StateChangeTimestampMonotonic', 't'),
    _Operation.JOB: (_UNIT, 'Job', '(uo)'),
})
_TEXT_VALUES = MappingProxyType({
    _Operation.ACTIVE_STATE: frozenset(('inactive', 'failed')),
    _Operation.SUB_STATE: frozenset(('dead', 'failed')),
    _Operation.RESULT: frozenset((
        'success', 'resources', 'protocol', 'timeout', 'exit-code', 'signal',
        'core-dump', 'watchdog', 'start-limit-hit', 'oom-kill',
    )),
})
_INTEGER_BOUNDS = MappingProxyType({
    'u': (0, (1 << 32) - 1),
    't': (0, (1 << 64) - 1),
    'i': (-(1 << 31), (1 << 31) - 1),
})


class _Phase(Enum):
    NEW = 'new'
    ABSENT = 'prelaunch-absent'
    REF_ATTEMPTED = 'ref-attempted'
    REF_ACKNOWLEDGED = 'ref-acknowledged'
    HELD = 'held'
    UNREF_ATTEMPTED = 'unref-attempted'
    RELEASED = 'unref-acknowledged'
    COLLECTED = 'collected'


class ManagerBinding(NamedTuple):
    """Facts from a single held FD and native broker/manager identity proof."""
    socket_device: int
    socket_inode: int
    client: str
    manager: str
    manager_pid: int
    manager_uid: int
    manager_birth: int


class _Request(NamedTuple):
    operation: _Operation
    destination: str
    path: str
    interface: str
    member: str
    signature: str
    body: tuple


class ManagerReply(NamedTuple):
    """One strictly decoded native reply, with its original message sender.

    The future exchange owner checks the current connection and PID 1 binding,
    enforces bounded decoding, and rejects trailing fields. It discards the
    standard single string body of an error after validating its wire shape;
    only the error name survives. A typed property uses (signature, value)
    as its body, including ('ay', bytes) for InvocationID.
    """
    binding: ManagerBinding
    sender: str
    kind: str
    signature: str
    body: tuple
    error_name: str | None = None


class LiveMain(NamedTuple):
    """Private manager observation joined to the caller's already-held main."""

    binding: ManagerBinding
    unit_object: str
    invocation: bytes
    pid: int
    start_us: int
    pid_read_floor_us: int


class ServiceTerminal(NamedTuple):
    """Raw manager terminal facts, independent of physical settlement."""

    main: LiveMain
    active_state: str
    sub_state: str
    result: str
    code: int
    status: int
    exit_us: int
    state_change_us: int

    @property
    def normal(self):
        return (self.active_state == 'inactive' and self.sub_state == 'dead'
                and self.result == 'success' and self.code == _CLD_EXITED and self.status == 0)


def _typed_value(operation, reply):
    signature = _TYPED_PROPERTIES[operation][2]
    _require(reply.signature == 'v' and len(reply.body) == 2 and type(reply.body[0]) is str
             and reply.body[0] == signature, 'manager-reference-property-variant')
    value = reply.body[1]
    if signature == '(uo)':
        _require(type(value) is tuple and len(value) == 2 and type(value[0]) is int
                 and value[0] == 0 and type(value[1]) is str and value[1] == '/',
                 'manager-reference-terminal-job')
    elif signature == 's':
        _require(type(value) is str and value in _TEXT_VALUES[operation], 'manager-reference-property-text')
    else:
        minimum, maximum = _INTEGER_BOUNDS[signature]
        _require(type(value) is int and minimum <= value <= maximum, 'manager-reference-property-integer')
    return value


def _binding_valid(binding):
    if type(binding) is not ManagerBinding:
        return False
    return (all(type(number) is int for number in (binding.socket_device, binding.socket_inode,
                binding.manager_pid, binding.manager_uid, binding.manager_birth))
            and binding.socket_device >= 0 and binding.socket_inode > 0 and binding.manager_birth > 0
            and binding.manager_pid == 1 and binding.manager_uid == 0
            and all(type(name) is str and re.fullmatch(r':[0-9]{1,20}\.[0-9]{1,20}', name)
                    for name in (binding.client, binding.manager)) and binding.client != binding.manager)


def _invocation_valid(invocation):
    return type(invocation) is bytes and len(invocation) == 16 and any(invocation)


class ManagerReference:
    """Closed request/receipt policy for an independently admitted exchange.

    exchange(request, deadline_ns) must use one persistent stock broker FD.
    An accepted reply requires three sequential asynchronous calls on that
    connection. GetNameOwner revalidates the admitted manager before and
    after the single fixed role request. At most one call is in flight, and
    all three use the same absolute deadline. A refusal may end the sequence
    early. The caller owns startup and the physical custody of the connection.
    The supplied start is the original protected monotonic course start.
    This model enforces the deadline around calls, not inside the transport.
    """

    def __init__(self, *, run_id, started_ns, binding, exchange):
        _require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id)
                 and int(run_id) <= 9007199254740991, 'manager-reference-run')
        now = monotonic_ns()
        _require(type(started_ns) is int and 0 <= started_ns <= now < started_ns + 75 * _SECOND,
                 'manager-reference-clock')
        _require(_binding_valid(binding) and callable(exchange), 'manager-reference-binding')
        self._run = run_id
        self._started = started_ns
        self._binding = binding
        self._exchange = exchange
        self._phases = dict.fromkeys(_ROLES, _Phase.NEW)
        self._invocations = {}
        self._busy = False
        self._poisoned = False
        self._observed_ns = now
        self._observing = False
        self._live_attempts = set()
        self._terminal_attempts = set()
        self._live = {}

    def _role(self, role):
        _require(type(role) is str and role in _ROLES, 'manager-reference-role')

    def _admit(self, role, frontier, phase, maximum, *, observation=False):
        self._role(role)
        _require(not self._busy and not self._poisoned, 'manager-reference-unavailable')
        _require(self._phases[role] is phase, 'manager-reference-order')
        _require(type(frontier) is int and frontier in _FRONTIERS and frontier <= maximum,
                 'manager-reference-frontier')
        deadline = self._started + frontier * _SECOND
        self._check_clock(deadline, observation=observation)
        return deadline

    def _check_clock(self, deadline, *, observation=False):
        now = monotonic_ns()
        if not self._started <= now < deadline:
            self._refuse('manager-reference-deadline')
        if (observation or self._observing) and (type(now) is not int or now < self._observed_ns):
            self._refuse('manager-reference-observation-clock')
        self._observed_ns = max(self._observed_ns, now)
        return now

    def _refuse(self, reason):
        self._poisoned = True
        raise Refused(reason)

    def _path(self, role):
        return f'{_MANAGER_PATH}/unit/aihrbc_2d{role}_2d{self._run}_2eservice'

    def _request(self, operation, role):
        destination = self._binding.manager
        if operation is _Operation.GET_UNIT:
            return _Request(operation, destination, _MANAGER_PATH, _MANAGER, 'GetUnit', 's',
                            (f'aihrbc-{role}-{self._run}.service',))
        path = self._path(role)
        if operation is _Operation.INVOCATION:
            return _Request(operation, destination, path, 'org.freedesktop.DBus.Properties',
                            'Get', 'ss', (_UNIT, 'InvocationID'))
        if operation in _TYPED_PROPERTIES:
            interface, name, _ = _TYPED_PROPERTIES[operation]
            return _Request(operation, destination, path, 'org.freedesktop.DBus.Properties',
                            'Get', 'ss', (interface, name))
        _require(operation in (_Operation.REF, _Operation.UNREF), 'manager-reference-operation')
        return _Request(operation, destination, path, _UNIT,
                        'Ref' if operation is _Operation.REF else 'Unref', '', ())

    def _decode(self, operation, role, reply):
        _require(type(reply) is ManagerReply and _binding_valid(reply.binding) and reply.binding == self._binding
                 and type(reply.sender) is str and reply.sender == self._binding.manager,
                 'manager-reference-reply-identity')
        _require(type(reply.kind) is str and type(reply.signature) is str and type(reply.body) is tuple,
                 'manager-reference-reply-shape')
        if reply.kind == 'error':
            _require(operation is _Operation.GET_UNIT and reply.signature == 's' and not reply.body
                     and type(reply.error_name) is str and reply.error_name == _NO_SUCH_UNIT,
                     'manager-reference-method-refused')
            return False
        _require(reply.kind == 'return' and reply.error_name is None, 'manager-reference-reply-shape')
        if operation is _Operation.GET_UNIT:
            _require(reply.signature == 'o' and len(reply.body) == 1 and type(reply.body[0]) is str
                     and reply.body[0] == self._path(role), 'manager-reference-object')
            return True
        if operation is _Operation.INVOCATION:
            _require(reply.signature == 'v' and len(reply.body) == 2 and type(reply.body[0]) is str
                     and reply.body[0] == 'ay' and _invocation_valid(reply.body[1]), 'manager-reference-invocation-shape')
            return reply.body[1]
        if operation in _TYPED_PROPERTIES:
            return _typed_value(operation, reply)
        _require(reply.signature == '' and not reply.body, 'manager-reference-ack-shape')
        return None

    def _call(self, operation, role, deadline):
        request = self._request(operation, role)
        self._check_clock(deadline)
        if operation is _Operation.REF:
            self._phases[role] = _Phase.REF_ATTEMPTED
        if operation is _Operation.UNREF:
            self._phases[role] = _Phase.UNREF_ATTEMPTED
        previous_busy, self._busy = self._busy, True
        try:
            try:
                reply = self._exchange(request, deadline)
            except Exception:
                raise Refused('manager-reference-transport') from None
            self._check_clock(deadline)
            result = self._decode(operation, role, reply)
            self._check_clock(deadline)
            return result
        except BaseException:
            self._poisoned = True
            raise
        finally:
            self._busy = previous_busy

    def _expect_invocation(self, role, invocation, deadline):
        if self._call(_Operation.INVOCATION, role, deadline) != invocation:
            self._refuse('manager-reference-invocation-changed')

    def before_launch(self, role, frontier):
        deadline = self._admit(role, frontier, _Phase.NEW, 42 if role == 'third' else 32)
        if self._call(_Operation.GET_UNIT, role, deadline):
            self._refuse('manager-reference-unit-present')
        self._phases[role] = _Phase.ABSENT

    def retain(self, role, invocation, frontier):
        """Run while the independently observed role still awaits its grant."""
        deadline = self._admit(role, frontier, _Phase.ABSENT, 42 if role == 'third' else 32)
        _require(_invocation_valid(invocation), 'manager-reference-live-invocation')
        if not self._call(_Operation.GET_UNIT, role, deadline):
            self._refuse('manager-reference-unit-missing')
        self._expect_invocation(role, invocation, deadline)
        self._call(_Operation.REF, role, deadline)
        self._phases[role] = _Phase.REF_ACKNOWLEDGED
        self._expect_invocation(role, invocation, deadline)
        self._invocations[role] = invocation
        self._phases[role] = _Phase.HELD

    @contextmanager
    def _observation(self, role, invocation, frontier, maximum, attempts):
        deadline = self._admit(role, frontier, _Phase.HELD, maximum, observation=True)
        _require(_invocation_valid(invocation) and invocation == self._invocations[role],
                 'manager-reference-observation-invocation')
        _require(role not in attempts, 'manager-reference-observation-already-attempted')
        attempts.add(role)
        self._busy = self._observing = True
        try:
            yield deadline
        except BaseException:
            self._poisoned = True
            raise
        finally:
            self._busy = self._observing = False

    def bind_live_main(self, role, invocation, held_pid, before_launch_ns, frontier):
        """Bind the protected caller's held PID and original prelaunch sample."""
        _require(type(held_pid) is int and 1 < held_pid <= 4194304
                 and type(before_launch_ns) is int and before_launch_ns >= self._started,
                 'manager-reference-live-main-input')
        maximum = 42 if role == 'third' else 32
        with self._observation(role, invocation, frontier, maximum, self._live_attempts) as deadline:
            _require(before_launch_ns <= self._check_clock(deadline), 'manager-reference-live-main-clock')
            self._expect_invocation(role, invocation, deadline)
            pid_read_floor_us = self._check_clock(deadline) // _NS_PER_US
            pid = self._call(_Operation.MAIN_PID, role, deadline)
            exec_pid = self._call(_Operation.EXEC_MAIN_PID, role, deadline)
            start_us = self._call(_Operation.MAIN_START_US, role, deadline)
            self._expect_invocation(role, invocation, deadline)
            now_us = self._check_clock(deadline) // _NS_PER_US
            _require(pid == exec_pid == held_pid, 'manager-reference-live-main-pid')
            _require(0 < start_us and before_launch_ns // _NS_PER_US <= start_us <= now_us,
                     'manager-reference-live-main-clock')
            main = LiveMain(self._binding, self._path(role), invocation, held_pid, start_us, pid_read_floor_us)
            self._live[role] = main
            return main

    def _terminal_bracket(self, role, invocation, deadline):
        self._expect_invocation(role, invocation, deadline)
        state_change_us = self._call(_Operation.STATE_CHANGE_US, role, deadline)
        self._call(_Operation.JOB, role, deadline)
        return state_change_us

    def observe_terminal(self, role, invocation, frontier):
        """Read one terminal pass after separately observed physical settlement."""
        self._role(role)
        _require(role in self._live, 'manager-reference-live-main-required')
        main = self._live[role]
        maximum = 42 if role == 'third' else 75
        with self._observation(role, invocation, frontier, maximum, self._terminal_attempts) as deadline:
            state_change_us = self._terminal_bracket(role, invocation, deadline)
            active = self._call(_Operation.ACTIVE_STATE, role, deadline)
            sub = self._call(_Operation.SUB_STATE, role, deadline)
            pid = self._call(_Operation.MAIN_PID, role, deadline)
            control_pid = self._call(_Operation.CONTROL_PID, role, deadline)
            exec_pid = self._call(_Operation.EXEC_MAIN_PID, role, deadline)
            code = self._call(_Operation.MAIN_CODE, role, deadline)
            status = self._call(_Operation.MAIN_STATUS, role, deadline)
            start_us = self._call(_Operation.MAIN_START_US, role, deadline)
            exit_us = self._call(_Operation.MAIN_EXIT_US, role, deadline)
            result = self._call(_Operation.RESULT, role, deadline)
            final_state_change_us = self._terminal_bracket(role, invocation, deadline)
            now_us = self._check_clock(deadline) // _NS_PER_US
            _require(state_change_us == final_state_change_us, 'manager-reference-terminal-bracket')
            _require((active, sub) in (('inactive', 'dead'), ('failed', 'failed'))
                     and (active == 'inactive') == (result == 'success'),
                     'manager-reference-terminal-state')
            _require(pid == control_pid == 0 and exec_pid == main.pid, 'manager-reference-terminal-pid')
            _require(start_us == main.start_us and start_us < exit_us <= state_change_us <= now_us
                     and main.pid_read_floor_us <= exit_us,
                     'manager-reference-terminal-clock')
            _require((code == _CLD_EXITED and 0 <= status <= 255)
                     or (code in (_CLD_KILLED, _CLD_DUMPED) and 1 <= status <= 64),
                     'manager-reference-terminal-status')
            return ServiceTerminal(main, active, sub, result, code, status, exit_us, state_change_us)

    def release_after_terminal(self, role, invocation, frontier):
        """Caller already proved raw terminal status, wrapper, pipe and cgroup facts."""
        deadline = self._admit(role, frontier, _Phase.HELD, 42 if role == 'third' else 75)
        _require(_invocation_valid(invocation) and invocation == self._invocations[role],
                 'manager-reference-terminal-invocation')
        self._expect_invocation(role, invocation, deadline)
        self._call(_Operation.UNREF, role, deadline)
        self._phases[role] = _Phase.RELEASED

    def collected(self, role, frontier):
        """Observe manager absence only. This is neither cgroup nor FD settlement."""
        deadline = self._admit(role, frontier, _Phase.RELEASED, 42 if role == 'third' else 75)
        if self._call(_Operation.GET_UNIT, role, deadline):
            return False
        self._phases[role] = _Phase.COLLECTED
        return True

    def phase(self, role):
        """Closed phase, useful to the independent cleanup owner after refusal."""
        self._role(role)
        return self._phases[role].value
