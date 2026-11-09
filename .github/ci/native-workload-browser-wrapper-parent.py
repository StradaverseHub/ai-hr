"""Dormant parent of one fixed stock wrapper. Manager custody stays separate."""
import errno
import fcntl
import hashlib
import os
import re
import select
import signal
import socket
import stat
import sys
from contextlib import ExitStack, contextmanager
from time import monotonic_ns
from types import ModuleType
from typing import NamedTuple


_HELPER_BYTES = 18462
_HELPER_SHA256 = 'c131712c9ca5054583573282e2918452a38bcd6c9225fbb541f56d9411e6691d'
_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGPIPE, signal.SIGCHLD, signal.SIGXFSZ)
_MS = 1_000_000


class Refused(RuntimeError):
    pass


class WrapperTerminal(NamedTuple):
    code: int
    status: int
    stock_exit_zero: bool


def _need(ok, reason):
    if not ok:
        raise Refused(reason)


def _birth(info):
    return info.st_dev, info.st_ino


def _child_identity(raw, pid, *, live=True):
    end = raw.rfind(b') ')
    fields = raw[end + 2:].split()
    _need(raw.startswith(f'{pid} ('.encode('ascii')) and end > 0 and len(fields) > 19
          and raw.endswith(b'\n') and (not live or fields[0] not in (b'Z', b'X'))
          and all(fields[index].isdigit() for index in (1, 2, 3, 19)),
          'wrapper-parent-proc-stat')
    return tuple(int(fields[index]) for index in (1, 2, 3, 19))


def _read(gate, folder, name, limit, clock):
    clock.left()
    fd = os.open(name, gate._FILE, dir_fd=folder)
    try:
        _need(stat.S_ISREG(os.fstat(fd).st_mode), 'wrapper-parent-proc-file')
        raw = bytearray()
        while True:
            clock.left()
            block = os.read(fd, min(16384, limit + 1 - len(raw)))
            clock.left()
            if not block:
                return bytes(raw)
            raw.extend(block)
            _need(len(raw) <= limit, 'wrapper-parent-proc-bound')
    finally:
        os.close(fd)


def _fdinfo(gate, folder, name, clock):
    data = _read(gate, folder, name, 4096, clock)
    fields = {}
    for key, grammar, base in ((b'ino', rb'[1-9][0-9]{0,19}', 10), (b'mnt_id', rb'[1-9][0-9]{0,9}', 10),
                               (b'flags', rb'[0-7]{1,16}', 8)):
        rows = re.findall(rb'^' + key + rb':[ \t]+(' + grammar + rb')$', data, re.M)
        _need(len(rows) == 1 and sum(line.startswith(key + b':') for line in data.splitlines()) == 1,
              'wrapper-parent-fdinfo')
        fields[key] = int(rows[0], base)
    return fields[b'ino'], fields[b'mnt_id'], fields[b'flags']


def _descriptor(info):
    return (*_birth(info), info.st_mode, info.st_rdev)


def _all_cloexec(clock):
    with os.scandir('/proc/self/fd') as entries:
        for count, entry in enumerate(entries, 1):
            clock.left()
            _need(count <= 4096 and re.fullmatch(r'[0-9]{1,10}', entry.name), 'wrapper-parent-fd-census')
            fd = int(entry.name)
            if fd > 2:
                try:
                    _need(not os.get_inheritable(fd), 'wrapper-parent-inheritable-fd')
                except OSError as error:
                    if error.errno != errno.EBADF:
                        raise
    clock.left()


@contextmanager
def _child_end_scope():
    ends = ExitStack()
    try:
        yield ends
    except BaseException as primary:
        try:
            ends.close()
        except BaseException:
            primary.add_note('wrapper-parent-child-end-closure-unproved')
        raise
    else:
        ends.close()


class _WrapperParent:
    def __init__(self, gate, *, role, run_id, nonce, spki, unset_names, capsule_fd, python_fd, stock_fd,
                 started_ns, launch_by_ns, cleanup_by_ns):
        _need(type(gate) is ModuleType and sys.platform == 'linux' and os.uname().machine == 'x86_64'
              and os.getresuid() == os.getresgid() == (0, 0, 0)
              and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
              and type(role) is str and role in gate._ROLES and type(unset_names) is tuple
              and gate._int(started_ns, 1, gate._MAX_NS) and gate._int(cleanup_by_ns, 1, gate._MAX_NS)
              and gate._int(launch_by_ns, started_ns + 1, started_ns + (42 if role == 'third' else 32) * gate._SECOND)
              and launch_by_ns < cleanup_by_ns <= started_ns + 75 * gate._SECOND,
              'wrapper-parent-input')
        descriptors = (capsule_fd, python_fd, stock_fd)
        _need(all(gate._int(fd, 4, 2_147_483_647) and not os.get_inheritable(fd) for fd in descriptors)
              and len(set(descriptors)) == 3, 'wrapper-parent-package-fds')
        self.gate, self.role, self.run = gate, role, run_id
        self.helper, self.environment = gate.wrapper_helper_argv(run_id)
        self.input = {'role': role, 'runId': run_id, 'nonce': nonce, 'spki': spki, 'unsetNames': list(unset_names)}
        self.capsule_fd, self.python_fd, self.stock_fd = descriptors
        self.started, self.launch_by, self.cleanup_by = started_ns, launch_by_ns, cleanup_by_ns
        self.active = gate._Clock(started_ns, launch_by_ns)
        self.pid = self.pidfd = self.proc = self.proc_birth = self.start = None
        self.spawn_fact = gate.SpawnFact('not-attempted', None)
        self.control = self.root_pipes = self.terminal = None
        self.package_marks = None
        self.live = True
        self.started_spawn = self.ready = self.ack_attempted = self.stock_seen = False
        self.ack_prepared = self.ack_sent = self.stock_attempted = False
        self.signal_attempted = self.reap_attempted = self.reaped = False

    @property
    def manager_request_possible(self):
        return self.ack_attempted

    def _source(self):
        gate, clock = self.gate, self.active
        with ExitStack() as stack:
            prefix = self.helper[-1].split('/')[1:-1]
            parent, chain = None, []
            for part in ('/', *prefix):
                clock.left()
                mode = (0o700 if part == gate._ROOT_PREFIX + self.run else
                        {'code': 0o555, '.github': 0o755, 'ci': 0o755}.get(part))
                fd, mark = gate._open_dir(stack, parent, part, mode)
                chain.append((parent, part, fd, mark))
                if part == 'code':
                    _need(gate._identity(os.fstat(self.capsule_fd)) == mark, 'wrapper-parent-capsule')
                parent = fd
            name = gate._HELPER
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            _need(before.st_mode == stat.S_IFREG | 0o444 and before.st_uid == before.st_gid == 0
                  and before.st_nlink == 1 and before.st_size == _HELPER_BYTES
                  and before.st_dev == os.fstat(self.capsule_fd).st_dev, 'wrapper-parent-helper')
            fd = os.open(name, gate._FILE, dir_fd=parent)
            stack.callback(os.close, fd)
            mark = gate._identity(before)
            _need(gate._identity(os.fstat(fd)) == mark
                  and hashlib.sha256(gate._read_exact(fd, _HELPER_BYTES, clock)).hexdigest() == _HELPER_SHA256
                  and gate._identity(os.fstat(fd)) == mark
                  == gate._identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'wrapper-parent-helper')
            for owner, part, fd, mark in chain:
                clock.left()
                _need(gate._identity(os.fstat(fd)) == mark
                      == gate._identity(os.stat(part, dir_fd=owner, follow_symlinks=False)), 'wrapper-parent-capsule')
        clock.left()

    def _packages(self, clock):
        gate = self.gate
        clock.left()
        with ExitStack() as stack:
            root, _ = gate._open_dir(stack, None, '/')
            usr, _ = gate._open_dir(stack, root, 'usr')
            folder, _ = gate._open_dir(stack, usr, 'bin')
            link = os.stat('python3', dir_fd=folder, follow_symlinks=False)
            _need(stat.S_ISLNK(link.st_mode) and link.st_uid == link.st_gid == 0
                  and os.readlink('python3', dir_fd=folder) == 'python3.12', 'wrapper-parent-python-link')
            pins = []
            for name, fd in (('python3.12', self.python_fd), ('systemd-run', self.stock_fd)):
                info = os.fstat(fd)
                _need(not os.get_inheritable(fd) and stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                      and info.st_size > 0 and info.st_mode & stat.S_IXUSR and not info.st_mode & 0o6022
                      and gate._identity(info) == gate._identity(os.stat(name, dir_fd=folder, follow_symlinks=False)),
                      'wrapper-parent-package')
                pins.append(info)
            _need(gate._identity(link) == gate._identity(os.stat('python3', dir_fd=folder, follow_symlinks=False))
                  and gate._identity(pins[0]) == gate._identity(os.stat('python3', dir_fd=folder)),
                  'wrapper-parent-python-link')
        clock.left()
        marks = tuple(gate._identity(info) for info in pins)
        _need(self.package_marks is None or self.package_marks == marks, 'wrapper-parent-package-changed')
        self.package_marks = marks
        return tuple(pins)

    def _make_pipes(self, child):
        # The four sources always start above the child target range.
        for number in (0, 1, 2):
            os.fstat(number)
        root_fds, child_fds = [], []
        try:
            for root_reads in (False, True):
                read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
                root, endpoint = (read_fd, write_fd) if root_reads else (write_fd, read_fd)
                root_fds.append(root)
                child.callback(os.close, endpoint)
                child_fds.append(endpoint)
                os.set_blocking(root, False)
            self.root_pipes = tuple(root_fds)
        except BaseException:
            for fd in root_fds:
                os.close(fd)
            raise
        null = os.open('/dev/null', os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        child.callback(os.close, null)
        info = os.fstat(null)
        _need(stat.S_ISCHR(info.st_mode) and info.st_uid == info.st_gid == 0
              and (os.major(info.st_rdev), os.minor(info.st_rdev)) == (1, 3)
              and _descriptor(info) == _descriptor(os.stat('/dev/null', follow_symlinks=False)),
              'wrapper-parent-null')
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
        self.control = left
        child.enter_context(right)
        for endpoint in (left, right):
            endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        left.setblocking(False)
        sources = []
        for fd in (*child_fds, null, right.fileno()):
            duplicate = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 4)
            child.callback(os.close, duplicate)
            sources.append(duplicate)
        return tuple(sources)

    def _native_marks(self, sources, clock):
        marks = []
        for index, fd in enumerate(sources):
            info = os.fstat(fd)
            ino, mount, flags = _fdinfo(self.gate, self.fdinfo, str(fd), clock)
            mode = (os.O_RDONLY, os.O_WRONLY, os.O_WRONLY, os.O_RDWR)[index]
            expected_kind = (stat.S_ISFIFO, stat.S_ISFIFO, stat.S_ISCHR, stat.S_ISSOCK)[index]
            _need(ino == info.st_ino and expected_kind(info.st_mode) and flags & os.O_ACCMODE == mode
                  and flags & os.O_CLOEXEC and not flags & (os.O_NONBLOCK | os.O_PATH), 'wrapper-parent-source-fd')
            marks.append((_descriptor(info), mount, mode))
        _need(marks[0][0][:2] != marks[1][0][:2], 'wrapper-parent-role-pipes')
        return tuple(marks)

    def _root_pipe_pair(self):
        _need(all(_descriptor(os.fstat(fd)) == mark[0] and not os.get_inheritable(fd)
                  and not os.get_blocking(fd) and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == direction
                  for fd, mark, direction in zip(self.root_pipes, self.marks[:2], (os.O_WRONLY, os.O_RDONLY), strict=True)),
              'wrapper-parent-role-pipes')

    def _bind(self, clock):
        clock.left()
        _need(self.pid is not None and self.pidfd is not None and not os.get_inheritable(self.pidfd),
              'wrapper-parent-pidfd')
        raw = _read(self.gate, self.fdinfo, str(self.pidfd), 4096, clock)
        _need(sum(line.startswith(b'Pid:') for line in raw.splitlines()) == 1
              and re.findall(rb'^Pid:[ \t]+([1-9][0-9]{0,9})$', raw, re.M) == [str(self.pid).encode('ascii')],
              'wrapper-parent-pidfd')
        if self.proc is None:
            self.proc = os.open(str(self.pid), self.gate._DIR, dir_fd=self.proc_root)
            self.proc_birth = _birth(os.fstat(self.proc))
        self._current_identity(clock)

    def _current_identity(self, clock):
        clock.left()
        _need(not self.gate._poll(None, self.pidfd, 0)
              and _birth(os.fstat(self.proc)) == self.proc_birth
              == _birth(os.stat(str(self.pid), dir_fd=self.proc_root, follow_symlinks=False)),
              'wrapper-parent-child-birth')
        parent, group, session, start = _child_identity(
            _read(self.gate, self.proc, 'stat', 8192, clock), self.pid,
        )
        _need((parent, group, session) == (self.parent_pid, self.pid, self.pid) and start > 0
              and (self.start is None or start == self.start)
              and _birth(os.stat('ns/time', dir_fd=self.proc)) == self.time_namespace
              == _birth(os.stat('ns/time', dir_fd=self.self_proc)), 'wrapper-parent-child-identity')
        if self.start is None:
            self.start = start
        clock.left()

    def _child_stdio(self, clock, *, helper):
        for number, (mark, mount, mode) in enumerate(self.marks[:4 if helper else 3]):
            path = 'fd/' + str(number)
            before = _descriptor(os.stat(path, dir_fd=self.proc))
            ino, actual_mount, flags = _fdinfo(self.gate, self.proc, 'fdinfo/' + str(number), clock)
            _need(before == mark == _descriptor(os.stat(path, dir_fd=self.proc)) and ino == mark[1]
                  and actual_mount == mount and flags & os.O_ACCMODE == mode and not flags & os.O_PATH
                  and bool(flags & os.O_CLOEXEC) == bool(flags & os.O_NONBLOCK) == (number == 3),
                  'wrapper-parent-child-fd')
        if not helper:
            try:
                control = _descriptor(os.stat('fd/3', dir_fd=self.proc))
            except FileNotFoundError:
                pass
            else:
                _need(control != self.marks[3][0], 'wrapper-parent-control-survived')

    def _snapshot(self, clock, *, helper):
        self._current_identity(clock)
        exe_fd, argv = (self.python_fd, self.helper) if helper else (self.stock_fd, self.stock_argv)
        link = '/usr/bin/python3.12' if helper else self.gate._STOCK
        expected = self.package_marks[0 if helper else 1]
        creds = _read(self.gate, self.proc, 'status', 65536, clock)
        _need(all(re.findall(rb'^' + key + rb':[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)$',
                             creds, re.M) == [(b'0',) * 4] for key in (b'Uid', b'Gid')), 'wrapper-parent-child-root')
        _need(os.readlink('exe', dir_fd=self.proc) == link
              and self.gate._identity(os.stat('exe', dir_fd=self.proc)) == expected
              and _read(self.gate, self.proc, 'cmdline', 32768, clock) == b'\0'.join(
                  arg.encode('ascii') for arg in argv) + b'\0', 'wrapper-parent-child-exec')
        self._child_stdio(clock, helper=helper)
        _need(self.gate._identity(os.stat('exe', dir_fd=self.proc)) == expected
              == self.gate._identity(os.fstat(exe_fd)), 'wrapper-parent-child-exec')
        self._current_identity(clock)

    def _send(self, packet):
        self.active.left()
        _need(self.control.send(packet, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL) == len(packet),
              'wrapper-parent-send')
        self.active.left()

    def spawn_ready(self):
        _need(self.live and not self.started_spawn, 'wrapper-parent-spawn-once')
        self.started_spawn = True
        try:
            self._spawn_ready()
        except BaseException as primary:
            try:
                self._close_channels()
            except BaseException:
                primary.add_note('wrapper-parent-descriptor-closure-unproved')
            raise

    def _spawn_ready(self):
        gate, clock = self.gate, self.active
        self._source()
        python, stock = self._packages(clock)
        _need(_birth(python) != _birth(stock), 'wrapper-parent-package')
        self.proc_root = os.open('/proc', gate._DIR)
        self.parent_pid = os.getpid()
        _need(os.readlink('self', dir_fd=self.proc_root) == str(self.parent_pid), 'wrapper-parent-own-proc')
        self.self_proc = os.open(str(self.parent_pid), gate._DIR, dir_fd=self.proc_root)
        self.fdinfo = os.open('fdinfo', gate._DIR, dir_fd=self.self_proc)
        self.time_namespace = _birth(os.stat('ns/time', dir_fd=self.self_proc))
        parent_start = _child_identity(_read(gate, self.self_proc, 'stat', 8192, clock), self.parent_pid)[-1]
        service_by = min(self.cleanup_by, self.started + 32 * gate._SECOND)
        item = self.input | {'version': 1, 'parentPid': self.parent_pid, 'parentBirth': parent_start,
                             'startedNs': self.started, 'readyByNs': self.launch_by,
                             'serviceByNs': None if self.role == 'third' else service_by,
                             'stock': [stock.st_dev, stock.st_ino, stock.st_size, stock.st_mtime_ns, stock.st_ctime_ns]}
        packet = gate._canonical(item)
        self.stock_argv = gate._command(gate._prepare(packet), clock)
        with _child_end_scope() as child:
            sources = self._make_pipes(child)
            self.marks = self._native_marks(sources, clock)
            self._root_pipe_pair()
            self._send(packet)
            actions = gate.wrapper_file_actions(*sources)
            _all_cloexec(clock)
            _need(signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL, 'wrapper-parent-wait-owner')
            clock.left()
            self.spawn_fact = gate.SpawnFact('spawn-uncertain', None)
            self.pid = os.posix_spawn(self.helper[0], self.helper, dict(self.environment), file_actions=actions,
                                      setsid=True, setsigmask=(), setsigdef=_SIGNALS)
            now = monotonic_ns()
            self.spawn_fact = gate.returned_spawn_pid(self.pid, now, self.launch_by, self.cleanup_by)
            _need(clock.last <= now < self.cleanup_by, 'wrapper-parent-cleanup-frontier')
            gate._Clock(self.started, self.cleanup_by).left()
            self.pidfd = os.pidfd_open(self.pid)
        clock.left()
        self._bind(clock)
        wait = clock.left() // _MS
        _need(wait > 0, 'wrapper-parent-ready-deadline')
        events = gate._poll(self.control, self.pidfd, wait)
        clock.left()
        _need(events == {self.control.fileno(): select.POLLIN}, 'wrapper-parent-ready')
        payload, credentials = gate._recv(self.control, len(gate._READY))
        _need(payload == gate._READY and credentials == (self.pid, 0, 0)
              and not gate._poll(self.control, self.pidfd, 0), 'wrapper-parent-ready')
        self._snapshot(clock, helper=True)
        clock.left()
        self.ready = True

    def acknowledge(self):
        """Caller first proves current absence through the separate manager owner."""
        self._prepare_ack()
        self._send_ack()

    def _prepare_ack(self):
        _need(self.live and self.ready and not self.ack_prepared and not self.ack_attempted and not self.reap_attempted,
              'wrapper-parent-ack-once')
        self._source()
        self._packages(self.active)
        self._snapshot(self.active, helper=True)
        self._root_pipe_pair()
        self.ack_prepared = True

    def _send_ack(self):
        _need(self.live and self.ready and self.ack_prepared and not self.ack_attempted and not self.reap_attempted,
              'wrapper-parent-ack-once')
        self.ack_prepared = False
        _need(not self.gate._poll(self.control, self.pidfd, 0), 'wrapper-parent-ready-surplus')
        packet = self.gate._GO
        self.active.left()
        self.ack_attempted = True
        _need(self.control.send(packet, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL) == len(packet),
              'wrapper-parent-send')
        self.active.left()
        self.ack_sent = True

    def observe_stock(self):
        _need(self.live and self.ack_sent and not self.stock_attempted and not self.reap_attempted,
              'wrapper-parent-stock-state')
        self.stock_attempted = True
        gate, clock = self.gate, self.active
        while True:
            self._current_identity(clock)
            birth = _birth(os.stat('exe', dir_fd=self.proc))
            if birth == _birth(os.fstat(self.stock_fd)):
                self._packages(clock)
                self._snapshot(clock, helper=False)
                clock.left()
                self.stock_seen = True
                return
            _need(birth == _birth(os.fstat(self.python_fd)), 'wrapper-parent-stock-executable')
            wait = min(10, clock.left() // _MS)
            _need(wait > 0 and not gate._poll(None, self.pidfd, wait), 'wrapper-parent-stock-exec-lost')

    def take_role_pipes(self):
        """Transfer the root output-read and input-write FDs to the one transcript owner."""
        reader, writer = self.borrow_role_pipes()
        self.root_pipes = None
        return reader, writer

    def borrow_role_pipes(self):
        """Read the exact pair without relinquishing wrapper cleanup ownership."""
        _need(self.live and self.stock_seen and type(self.root_pipes) is tuple and not self.reap_attempted,
              'wrapper-parent-pipe-transfer')
        self._root_pipe_pair()
        self.active.left()
        writer, reader = self.root_pipes
        return reader, writer

    def adopt_role_pipes(self, issuer, *, output_birth, input_birth):
        """Install the one transcript pipe object before returning any ownership."""
        _need(type(issuer) is ModuleType, 'wrapper-parent-pipe-issuer')
        reader, writer = self.borrow_role_pipes()
        pipe = issuer._RolePipes(reader, writer, 512)
        _need(type(pipe) is issuer._RolePipes and (pipe.read_birth, pipe.write_birth) == (output_birth, input_birth)
              and self.borrow_role_pipes() == (reader, writer), 'wrapper-parent-pipe-identity')
        # Before this single assignment the original tuple owns both ends;
        # afterwards cleanup reaches the same stateful object as the issuer.
        self.root_pipes = pipe
        return pipe

    def _close_channels(self):
        with ExitStack() as closed:
            if self.control is not None:
                closed.callback(self.control.close)
                self.control = None
            pair = self.root_pipes
            if pair is not None:
                if type(pair) is tuple:
                    for fd in pair:
                        closed.callback(os.close, fd)
                else:
                    closed.callback(pair.close)
                self.root_pipes = None

    def settle(self, *, terminate=False):
        """Reap only the held child. Unit and manager absence are separate facts."""
        _need(self.live and type(terminate) is bool and self.pidfd is not None and not self.reap_attempted
              and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL, 'wrapper-parent-settlement')
        gate = self.gate
        bound = self.cleanup_by if terminate else min(self.cleanup_by, self.started + 60 * gate._SECOND)
        clock = gate._Clock(self.started, bound)
        clock.left()
        if terminate:
            self._close_channels()
            if not gate._poll(None, self.pidfd, 0):
                _need(not self.signal_attempted, 'wrapper-parent-signal-once')
                try:
                    self._bind(clock)
                except (Refused, gate.Refused, OSError):
                    # Closing the helper channel can make the held child exit
                    # while the live identity check is in progress.
                    try:
                        clock.left()
                        if gate._poll(None, self.pidfd, 0) == {self.pidfd: select.POLLIN}:
                            return self._reap(clock)
                    except (Refused, gate.Refused, OSError):
                        pass
                    raise
                clock.left()
                self.signal_attempted = True
                try:
                    signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        wait = clock.left() // _MS
        _need(wait > 0 and gate._poll(None, self.pidfd, wait) == {self.pidfd: select.POLLIN},
              'wrapper-parent-terminal')
        return self._reap(clock)

    def _reap(self, clock):
        clock.left()
        options = os.WEXITED | os.WNOHANG
        row = os.waitid(os.P_PIDFD, self.pidfd, options | os.WNOWAIT)
        _need(row is not None and row.si_pid == self.pid and row.si_uid == 0
              and ((row.si_code == os.CLD_EXITED and 0 <= row.si_status <= 255)
                   or (row.si_code in (os.CLD_KILLED, os.CLD_DUMPED) and 1 <= row.si_status <= 64)),
              'wrapper-parent-terminal')
        clock.left()
        self.reap_attempted = True
        _need(os.waitid(os.P_PIDFD, self.pidfd, options) == row, 'wrapper-parent-reap')
        self.reaped = True
        clock.left()
        self.terminal = WrapperTerminal(row.si_code, row.si_status,
                                        self.stock_seen and row.si_code == os.CLD_EXITED and row.si_status == 0)
        return self.terminal

    def close(self):
        self.live = False
        with ExitStack() as closed:
            for field in ('proc_root', 'self_proc', 'fdinfo', 'proc', 'pidfd'):
                fd = getattr(self, field, None)
                if fd is not None:
                    closed.callback(os.close, fd)
                    setattr(self, field, None)
            closed.callback(self._close_channels)


@contextmanager
def held_stock_wrapper(gate, *, role, run_id, nonce, spki, unset_names, capsule_fd, python_fd, stock_fd,
                       started_ns, launch_by_ns, cleanup_by_ns):
    """Borrow protected package/capsule FDs. Caller owns all waiters and CLOEXEC producers.

    Caller retains this scope through explicit settlement. Scope exit closes only
    its descriptors; an unproved terminal or manager request remains uncertain.
    """
    owner = _WrapperParent(gate, role=role, run_id=run_id, nonce=nonce, spki=spki, unset_names=unset_names,
                           capsule_fd=capsule_fd, python_fd=python_fd, stock_fd=stock_fd, started_ns=started_ns,
                           launch_by_ns=launch_by_ns, cleanup_by_ns=cleanup_by_ns)
    try:
        yield owner
    except BaseException as primary:
        try:
            owner.close()
        except BaseException:
            primary.add_note('wrapper-parent-descriptor-closure-unproved')
        raise
    else:
        owner.close()
