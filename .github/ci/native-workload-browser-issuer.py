"""Private transcript owner for the fixed synthetic browser capability.

No executable entry or protected caller is installed. The future physical
owner must supply the already-held pipes, live kernel/DB observations and
the original capability clock. This module creates no service or credential.
"""
from __future__ import annotations

import json
import os
import re
import select
import stat


_INGRESS_URL = 'https://127.0.0.1:3443/__aihr_browser_capability_v1'
_INGRESS_BODY = b'aihr-browser-capability-v1\n'
_OBSERVER_DATABASE = 'ai_hr_test_w1'
_OBSERVER_ROLE = 'ai_hr_workload_observer'
_FRONTIERS = (32, 32, 42, 42, 42, 42, 42, 42, 42, 56, 56, 56, 56, 60, 60, 60, 60)
_WINDOWS = (
    ('negatives-complete', ('browser-ingress', 'browser-postgres-denied', 'control-final-denied')),
    ('control-denied', ('control-final-denied',)),
    ('websocket-ready', ('driver-control', 'browser-control-reply')),
    ('ingress-complete', ('driver-control', 'browser-control-reply', 'browser-ingress')),
)
_START_WINDOW = {'deny-go': 'negatives-complete', 'probe': 'control-denied',
                 'connect': 'websocket-ready', 'request': 'ingress-complete'}


class _Refused(RuntimeError):
    pass


def _require(ok, reason):
    if not ok:
        raise _Refused(reason)


def _pipe_birth(fd):
    info = os.fstat(fd)
    _require(stat.S_ISFIFO(info.st_mode) and not os.get_blocking(fd), 'held-nonblocking-pipe-required')
    return info.st_dev, info.st_ino


class _RolePipes:
    """Own one separate pair of nonblocking, already-held systemd/probe pipes."""

    def __init__(self, read_fd, write_fd, maximum):
        _require(type(read_fd) is int and type(write_fd) is int and read_fd > 2 and write_fd > 2
                 and read_fd != write_fd and maximum == 512, 'held-role-pipe-identity')
        self.read_fd, self.write_fd = read_fd, write_fd
        self.read_birth, self.write_birth = _pipe_birth(read_fd), _pipe_birth(write_fd)
        _require(self.read_birth != self.write_birth and os.fpathconf(write_fd, 'PC_PIPE_BUF') >= maximum,
                 'held-role-pipe-alias-or-bound')
        self.maximum = maximum
        self.pending = bytearray()

    def _require_output(self):
        _require(self.read_fd is not None and _pipe_birth(self.read_fd) == self.read_birth,
                 'held-role-output-changed')

    def _read(self, amount, clock, frontier):
        self._require_output()
        ready, _, _ = select.select([self.read_fd], [], [], clock.remaining(frontier))
        _require(bool(ready), 'held-role-output-timeout')
        result = os.read(self.read_fd, amount)
        clock.remaining(frontier)
        return result

    def frame(self, clock, frontier):
        self._require_output()
        while b'\n' not in self.pending:
            block = self._read(self.maximum + 1 - len(self.pending), clock, frontier)
            _require(bool(block), 'held-role-output-ended-before-frame')
            self.pending.extend(block)
            _require(len(self.pending) <= self.maximum, 'held-role-frame-bound')
        end = self.pending.index(b'\n') + 1
        frame = bytes(self.pending[:end])
        del self.pending[:end]
        clock.remaining(frontier)
        return frame

    def send(self, frame, clock, frontier):
        _require(self.write_fd is not None and _pipe_birth(self.write_fd) == self.write_birth,
                 'held-role-input-changed')
        _require(1 < len(frame) <= self.maximum, 'held-role-frame-bound')
        self._require_output()
        _require(not self.pending, 'held-role-output-before-command')
        # Reject output already observed at the turn. A readiness snapshot
        # cannot prove ordering against a concurrent child write.
        readable, ready, _ = select.select([self.read_fd], [self.write_fd], [], clock.remaining(frontier))
        _require(not readable, 'held-role-output-before-command')
        _require(bool(ready), 'held-role-input-timeout')
        clock.remaining(frontier)
        _require(os.write(self.write_fd, frame) == len(frame), 'held-role-input-short')
        clock.remaining(frontier)

    def _close(self, side):
        name = side + '_fd'
        fd = getattr(self, name)
        if fd is not None:
            # An uncertain identity or close cannot authorize a second attempt.
            setattr(self, name, None)
            _require(_pipe_birth(fd) == getattr(self, side + '_birth'), 'held-role-pipe-close-changed')
            os.close(fd)

    def close_input(self):
        self._close('write')

    def require_eof(self, clock, frontier):
        _require(not self.pending and self._read(1, clock, frontier) == b'', 'held-role-output-surplus')

    def close(self):
        try:
            self.close_input()
        except BaseException as primary:
            try:
                self._close('read')
            except BaseException:
                primary.add_note('held-role-output-close-unproved')
            raise
        self._close('read')


def _observer_credential(raw):
    """Validate bytes only. The source owner must prove the live DB separately."""
    _require(type(raw) is bytes and re.fullmatch(
        rb'postgres://ai_hr_workload_observer:[0-9a-f]{64}@127\.0\.0\.1:5433/ai_hr_test_w1', raw),
        'fixed-observer-credential-differs')


def _require_observer_backend(actual, frame, before=None):
    """Compare a protected socket observation with the reserved child backend."""
    _require(type(actual) is dict and set(actual) == {'pid', 'start', 'database', 'login', 'tag'}
             and type(actual['pid']) is int and actual['pid'] == frame['pid']
             and type(actual['start']) is str and re.fullmatch(r'[0-9]{1,20}(?:\.[0-9]{1,9})?', actual['start'])
             and actual['database'] == _OBSERVER_DATABASE and actual['login'] == _OBSERVER_ROLE
             and actual['tag'] == frame['tag']
             and (before is None or actual == before), 'fixed-observer-backend-differs')


def _require_ingress_response(url, status, body, peer_der, expected_der):
    """Reconcile the exact independent validated TLS observation, never trust it from a frame."""
    _require(url == _INGRESS_URL and type(status) is int and status == 200
             and type(body) is bytes and body == _INGRESS_BODY
             and type(peer_der) is bytes and type(expected_der) is bytes and 0 < len(peer_der) <= 16384
             and peer_der == expected_der, 'fixed-ingress-response-differs')


class _Transcript:
    """Internal framing after successful native fence install and role acquisition.

    A fence object can retain handles for cleanup after failed installation.
    The physical owner must preserve that failure and never start this transcript.
    """

    def __init__(self, kernel, clock, firewall, driver, browser):
        _require(isinstance(clock, kernel.Deadline) and isinstance(firewall, kernel.Firewall)
                 and firewall.attempted and firewall.handles is not None and not firewall.removal_attempted,
                 'held-capability-fence-required')
        _require(len(kernel.FRAME_ORDER) == len(_FRONTIERS), 'fixed-capability-census-differs')
        self.kernel, self.clock, self.firewall = kernel, clock, firewall
        self.roles = {}
        self._bind('driver', driver)
        self._bind('browser', browser)
        self.frames = kernel.Frames()
        self.windows = dict(_WINDOWS)
        self.before = None
        self.window = None
        self.poisoned = False
        self.pipes_closed = False
        self.third_transport_finished = False
        self.frames_finished = False

    def _bind(self, role, pipe):
        _require(type(pipe) is _RolePipes and role not in self.roles, 'held-role-pipe-required')
        births = {birth for current in self.roles.values() for birth in (current.read_birth, current.write_birth)}
        _require(pipe.read_birth != pipe.write_birth and not births & {pipe.read_birth, pipe.write_birth},
                 'held-role-pipes-alias')
        self.roles[role] = pipe

    def attach_third(self, pipe):
        try:
            self._expected('third', 'child', 'probe-ready')
            self._bind('third', pipe)
        except BaseException:
            self.poisoned = True
            raise

    def finish_third_transport(self):
        try:
            self._expected('driver', 'root', 'connect')
            _require(not self.third_transport_finished, 'held-third-transport-already-finished')
            self.roles['third'].close_input()
            self.roles['third'].require_eof(self.clock, 42)
            self.clock.remaining(42)
            self.third_transport_finished = True
        except BaseException:
            self.poisoned = True
            raise

    def _expected(self, role, direction, operation):
        _require(not self.poisoned and not self.pipes_closed and not self.frames.complete(),
                 'closed-capability-transcript')
        index = self.frames.position
        _require(self.kernel.FRAME_ORDER[index] == (role, direction, operation), 'capability-frame-out-of-order')
        frontier = _FRONTIERS[index]
        self.clock.remaining(frontier)
        return frontier

    def _verify_window(self, operation, frontier):
        _require(self.window == operation and self.before is not None, 'capability-counter-window-missing')
        after = self.firewall.observe(self.clock, frontier)
        self.kernel.counter_window(self.before, after, self.windows[operation])
        self.before = self.window = None

    def receive(self, role, operation):
        try:
            frontier = self._expected(role, 'child', operation)
            _require(role in self.roles, 'held-role-pipe-required')
            frame = self.roles[role].frame(self.clock, frontier)
            packet = self.frames.accept(role, 'child', frame)
            if operation in self.windows:
                self._verify_window(operation, frontier)
            self.clock.remaining(frontier)
            return packet
        except BaseException:
            self.poisoned = True
            raise

    def send(self, role, operation, *, held_driver=None):
        try:
            frontier = self._expected(role, 'root', operation)
            frame = {'op': operation}
            if operation == 'connect':
                _require(self.third_transport_finished, 'held-third-transport-unproved')
            if operation == 'deny-prepare':
                _require(isinstance(held_driver, _HeldDriver), 'held-driver-required')
                frame['pid'] = held_driver.current_pid(self.kernel)
            else:
                _require(held_driver is None, 'unexpected-driver-process')
            if operation in _START_WINDOW:
                _require(self.window is None, 'capability-counter-window-overlap')
                self.before = self.firewall.observe(self.clock, frontier)
                self.window = _START_WINDOW[operation]
            wire = (json.dumps(frame, separators=(',', ':')) + '\n').encode('ascii')
            self.frames.accept(role, 'root', wire)
            self.roles[role].send(wire, self.clock, frontier)
        except BaseException:
            self.poisoned = True
            raise

    def finish_frames(self):
        """Transport settlement only. Native process and socket proof still belongs to root."""
        try:
            _require(not self.poisoned and not self.pipes_closed and not self.frames_finished
                     and self.frames.complete() and self.window is None,
                     'capability-transcript-incomplete')
            # Each child is waiting for its stdin EOF after its final frame.
            for role in ('driver', 'browser'):
                self.roles[role].close_input()
            for role in ('driver', 'browser'):
                self.roles[role].require_eof(self.clock, 75)
            self.clock.remaining(75)
            self.frames_finished = True
        except BaseException:
            self.poisoned = True
            raise

    def close_pipes(self, primary=None):
        """Never dispose a process, credential, ingress listener or firewall."""
        if self.pipes_closed:
            if primary is not None:
                primary.add_note('held-role-pipe-settlement-already-attempted')
                raise primary
            raise _Refused('held-role-pipe-settlement-already-attempted')
        self.pipes_closed = True
        for pipe in self.roles.values():
            try:
                pipe.close()
            except BaseException as error:
                if primary is None:
                    primary = error
                else:
                    primary.add_note('held-role-pipe-settlement-unproved')
        if primary is not None:
            raise primary


class _HeldDriver:
    """Hold only the actual process birth joined by the existing kernel owner."""

    def __init__(self, kernel, pid, run_id):
        _require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,19}', run_id), 'held-driver-run-differs')
        self.group = '/system.slice/aihrbc-driver-' + run_id + '.service'
        self.fd, self.facts = kernel.held_role_process(pid, 'driver', self.group)

    def current_pid(self, kernel):
        _require(self.fd is not None and not select.select([self.fd], [], [], 0)[0], 'held-driver-exited')
        check_fd, facts = kernel.held_role_process(self.facts['pid'], 'driver', self.group)
        try:
            _require(facts == self.facts and not select.select([self.fd], [], [], 0)[0], 'held-driver-changed')
        except BaseException as primary:
            try:
                os.close(check_fd)
            except BaseException:
                primary.add_note('held-driver-recheck-pidfd-close-unproved')
            raise
        os.close(check_fd)
        return facts['pid']

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)


def _require_browser_family(kernel, launcher, chromium, renderers):
    """Use live kernel observations held by the future physical owner."""
    launcher_fd, launcher_facts = launcher
    chromium_fd, chromium_facts = chromium
    _require(0 < len(renderers) <= 512, 'held-browser-renderer-census')
    descriptors = [launcher_fd, chromium_fd, *(fd for fd, _ in renderers)]
    _require(all(type(fd) is int and fd > 2 for fd in descriptors) and len(set(descriptors)) == len(descriptors),
             'held-browser-family-descriptors-differ')
    _require(launcher_facts['pid'] != chromium_facts['pid']
             and launcher_facts['cgroupBirth'] == chromium_facts['cgroupBirth'],
             'held-browser-family-differs')
    pids = {launcher_facts['pid'], chromium_facts['pid']}
    for fd, facts in renderers:
        _require(facts['pid'] not in pids and not select.select([fd], [], [], 0)[0],
                 'held-browser-renderer-differs')
        pids.add(facts['pid'])
        kernel.require_renderer(facts, launcher_facts, chromium_facts)
    _require(not select.select([launcher_fd, chromium_fd], [], [], 0)[0], 'held-browser-family-exited')
    kernel.require_role_listener(launcher_fd, launcher_facts, kernel.CONTROL, kernel.BROWSER)
