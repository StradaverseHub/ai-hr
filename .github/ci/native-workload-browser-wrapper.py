"""Dormant root gate for the exact synthetic stock wrapper.

The future source-sealed parent owns native spawn, its returned PID and pidfd,
the package and fd proofs, and the one acknowledgement. This leaf starts no
child process itself. Its fixed helper entry can replace itself only after the
private root protocol. No stage, manager, or workflow caller is installed.
"""

import base64
import fcntl
import hashlib
import json
import os
import re
import select
import signal
import socket
import stat
import struct
import sys
from contextlib import ExitStack
from time import monotonic_ns
from types import ModuleType
from typing import NamedTuple


_ROLES = ('driver', 'browser', 'third')
_STOCK = '/usr/bin/systemd-run'
_ROOT_PREFIX = 'aihr-native-tool-only-'
_HELPER = 'native-workload-browser-wrapper.py'
_CONTROL = 3
_PREPARE_MAX = 20 * 1024
_READY = b'wrapper-ready-v1\n'
_GO = b'wrapper-go-v1\n'
_SECOND = 1_000_000_000
_MAX_NS = (1 << 63) - 1
_ROOT = (0, 0, 0)
_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
_UCRED = struct.Struct('3i')
_RIGHT = struct.Struct('i')
_ENV = (('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), ('LANG', 'C'), ('LC_ALL', 'C'))
_BUILDERS = (
    ('native-workload-browser-host.py', 44520, 'e4c562f6a9cb3897745881728d5343082c6e05268a52c34025adc99ac4c770fa'),
    ('native-workload-browser-launch-plan.py', 5200, '0abd48fae6d6959ee008e0a6704e91928047b207bd305c203334528c790273a6'),
    ('native-workload-browser-preimport-gate.py', 4813, 'b0c4413354c7248d46f75c301e209636b4bd16816f097d2c65e9df606210829b'),
)


class Refused(RuntimeError):
    pass


def _need(ok, reason):
    if not ok:
        raise Refused(reason)


def _int(value, low, high):
    return type(value) is int and low <= value <= high


def _run_valid(run_id):
    return (type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id) is not None
            and int(run_id) <= 9007199254740991)


def wrapper_helper_argv(run_id):
    """Inert argv for the one fixed, protected script, with no role arguments."""
    _need(_run_valid(run_id), 'wrapper-run')
    script = f'/var/lib/{_ROOT_PREFIX}{run_id}/code/.github/ci/{_HELPER}'
    return ('/usr/bin/python3', '-I', '-B', '-S', script), _ENV


def wrapper_file_actions(stdin, stdout, stderr, control):
    """Inert child file actions for the caller's independently admitted setsid spawn."""
    sources = (stdin, stdout, stderr, control)
    _need(all(_int(fd, 4, 2_147_483_647) for fd in sources) and len(set(sources)) == 4, 'wrapper-spawn-fds')
    duplicates = tuple((os.POSIX_SPAWN_DUP2, source, target) for target, source in enumerate(sources))
    closes = tuple((os.POSIX_SPAWN_CLOSE, source) for source in sources)
    return duplicates + closes


class SpawnFact(NamedTuple):
    state: str
    pid: int | None


def returned_spawn_pid(pid, observed_ns, launch_by_ns, cleanup_by_ns):
    """Inert parent facts, never permission to open, signal, reap or stop."""
    _need(_int(observed_ns, 0, _MAX_NS) and _int(launch_by_ns, 1, _MAX_NS)
          and _int(cleanup_by_ns, launch_by_ns, _MAX_NS), 'wrapper-spawn-clock')
    if pid is None:
        return SpawnFact('spawn-uncertain', None)
    _need(_int(pid, 2, 4_194_304), 'wrapper-spawn-pid')
    if observed_ns >= cleanup_by_ns:
        return SpawnFact('pid-known-after-cleanup', pid)
    if observed_ns >= launch_by_ns:
        return SpawnFact('pid-known-after-launch', pid)
    return SpawnFact('pid-known-in-slot', pid)


class _Clock:
    def __init__(self, start, stop):
        self.last, self.stop = start, stop

    def left(self):
        now = monotonic_ns()
        _need(self.last <= now < self.stop, 'wrapper-deadline')
        self.last = now
        return self.stop - now


def _unique(pairs):
    result = {}
    for key, value in pairs:
        _need(key not in result, 'wrapper-prepare-shape')
        result[key] = value
    return result


def _canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode('ascii')


def _prepare(raw):
    _need(type(raw) is bytes and 0 < len(raw) <= _PREPARE_MAX, 'wrapper-prepare-shape')
    try:
        item = json.loads(raw.decode('ascii'), object_pairs_hook=_unique)
        keys = {'version', 'role', 'runId', 'nonce', 'spki', 'parentPid', 'parentBirth', 'startedNs', 'readyByNs',
                'serviceByNs', 'stock', 'unsetNames'}
        _need(type(item) is dict and set(item) == keys and _canonical(item) == raw
              and _int(item['version'], 1, 1), 'wrapper-prepare-shape')
        role, run_id, nonce, spki = (item[key] for key in ('role', 'runId', 'nonce', 'spki'))
        _need(type(role) is str and role in _ROLES and _run_valid(run_id)
              and type(nonce) is str and re.fullmatch(r'[0-9a-f]{16}', nonce) is not None,
              'wrapper-prepare-role')
        if role == 'browser':
            _need(type(spki) is str and re.fullmatch(r'[A-Za-z0-9+/]{43}=', spki) is not None
                  and base64.b64encode(base64.b64decode(spki, validate=True)).decode('ascii') == spki,
                  'wrapper-prepare-spki')
        else:
            _need(spki is None, 'wrapper-prepare-spki')
        start, ready, service = (item[key] for key in ('startedNs', 'readyByNs', 'serviceByNs'))
        _need(_int(start, 0, _MAX_NS) and _int(ready, start + 1, min(_MAX_NS, start + (42 if role == 'third' else 32) * _SECOND))
              and (service is None if role == 'third' else _int(service, ready, min(_MAX_NS, start + 32 * _SECOND))),
              'wrapper-prepare-clock')
        _need(_int(item['parentPid'], 2, 4_194_304) and _int(item['parentBirth'], 1, _MAX_NS), 'wrapper-prepare-parent')
        stock = item['stock']
        _need(type(stock) is list and len(stock) == 5 and all(_int(value, 0, _MAX_NS) for value in stock)
              and stock[1] > 0 and stock[2] > 0, 'wrapper-prepare-stock')
        names = item['unsetNames']
        kept = {'PATH', 'LANG', 'LC_ALL', 'HOME'}
        if role != 'third':
            kept.add('TMPDIR')
        if role == 'driver':
            kept.add('CREDENTIALS_DIRECTORY')
        _need(type(names) is list and len(names) <= 128
              and all(type(name) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', name) is not None
                      and name not in kept for name in names) and names == sorted(set(names)),
              'wrapper-prepare-environment')
        return item
    except (ValueError, UnicodeError, TypeError, RecursionError, OverflowError):
        raise Refused('wrapper-prepare-shape') from None


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _open_dir(stack, parent, name, mode=None):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    _need(stat.S_ISDIR(before.st_mode) and before.st_uid == before.st_gid == 0 and not before.st_mode & 0o022
          and (mode is None or stat.S_IMODE(before.st_mode) == mode), 'wrapper-source-directory')
    fd = os.open(name, _DIR, dir_fd=parent)
    stack.callback(os.close, fd)
    _need(_identity(os.fstat(fd)) == _identity(before), 'wrapper-source-directory')
    return fd, _identity(before)


def _read_exact(fd, size, clock):
    raw = bytearray()
    while len(raw) < size:
        clock.left()
        block = os.read(fd, min(16384, size - len(raw)))
        _need(bool(block), 'wrapper-source-extent')
        raw.extend(block)
    clock.left()
    _need(os.read(fd, 1) == b'', 'wrapper-source-extent')
    return bytes(raw)


def _load_builders(run_id, clock):
    _need(_run_valid(run_id), 'wrapper-run')
    modules = []
    with ExitStack() as held:
        parent, chain = None, []
        for part, mode in (('/', None), ('var', None), ('lib', None), (_ROOT_PREFIX + run_id, 0o700),
                           ('code', 0o555), ('.github', 0o755), ('ci', 0o755)):
            clock.left()
            child, birth = _open_dir(held, parent, part, mode)
            chain.append((parent, part, child, birth))
            parent = child
        device = chain[3][3][0]
        _need(all(entry[3][0] == device for entry in chain[3:]), 'wrapper-source-device')
        for name, size, digest in _BUILDERS:
            clock.left()
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            _need(stat.S_ISREG(before.st_mode) and stat.S_IMODE(before.st_mode) == 0o444
                  and before.st_uid == before.st_gid == 0 and before.st_nlink == 1
                  and before.st_dev == device and before.st_size == size, 'wrapper-source-file')
            fd = os.open(name, _FILE, dir_fd=parent)
            held.callback(os.close, fd)
            _need(_identity(os.fstat(fd)) == _identity(before), 'wrapper-source-file')
            raw = _read_exact(fd, size, clock)
            _need(_identity(os.fstat(fd)) == _identity(before) == _identity(os.stat(name, dir_fd=parent, follow_symlinks=False))
                  and hashlib.sha256(raw).hexdigest() == digest, 'wrapper-source-bytes')
            module = ModuleType('aihr_fixed_wrapper_' + str(len(modules)))
            exec(compile(raw, name, 'exec', dont_inherit=True), module.__dict__)
            modules.append(module)
        for owner, part, fd, birth in chain:
            clock.left()
            _need(_identity(os.fstat(fd)) == birth == _identity(os.stat(part, dir_fd=owner, follow_symlinks=False)),
                  'wrapper-source-directory-changed')
    clock.left()
    return tuple(modules)


def _stock_identity():
    with ExitStack() as held:
        root, _ = _open_dir(held, None, '/', None)
        usr, _ = _open_dir(held, root, 'usr', None)
        directory, _ = _open_dir(held, usr, 'bin', None)
        before = os.stat('systemd-run', dir_fd=directory, follow_symlinks=False)
        _need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and not before.st_mode & 0o6022
              and before.st_mode & stat.S_IXUSR and before.st_size > 0, 'wrapper-stock-file')
        fd = os.open('systemd-run', os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        held.callback(os.close, fd)
        _need(_identity(before) == _identity(os.fstat(fd)) == _identity(os.stat('systemd-run', dir_fd=directory, follow_symlinks=False)),
              'wrapper-stock-file')
        return before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns


def _command(item, clock):
    host, launch, preimport = _load_builders(item['runId'], clock)
    role, run_id = item['role'], item['runId']
    root = '/run/aihr-browser-capability-' + run_id
    credential = (root + '/private/observer', b'aihr-browser-isolation-v1:' + run_id.encode('ascii') + b'\n') if role == 'driver' else None
    plan = launch.synthetic_role_command(host, mode='capability-only', role=role, run_id=run_id, owner_nonce=item['nonce'],
                                         stage=root + '/launch-source', spki=item['spki'], credential=credential)
    _need(plan.argv[0] == _STOCK and plan.launcher_environment == _ENV, 'wrapper-stock-command')
    split = plan.argv.index('--')
    service = plan.argv[split + 1:]
    if role != 'third':
        service = preimport.synthetic_preimport_argv(role=role, run_id=run_id, deadline_ns=item['serviceByNs'], spki=item['spki'])
    # The protected parent owns the actual typed manager key projection. The
    # gate accepts bounded names only and never receives environment values.
    unset = '--property=UnsetEnvironment=' + ' '.join(item['unsetNames'])
    clock.left()
    return (*plan.argv[:split], unset, '--', *service)


def _stdio():
    left, right, sink = (os.fstat(fd) for fd in (0, 1, 2))
    _need(stat.S_ISFIFO(left.st_mode) and stat.S_ISFIFO(right.st_mode)
          and (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino)
          and stat.S_ISCHR(sink.st_mode) and (os.major(sink.st_rdev), os.minor(sink.st_rdev)) == (1, 3), 'wrapper-stdio')
    for fd, direction in ((0, os.O_RDONLY), (1, os.O_WRONLY), (2, os.O_WRONLY)):
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        _need(flags & os.O_ACCMODE == direction and not flags & os.O_NONBLOCK and os.get_inheritable(fd), 'wrapper-stdio')
    return tuple((item.st_dev, item.st_ino, item.st_mode, item.st_rdev) for item in (left, right, sink))


def _recv(channel, bound):
    extent = socket.CMSG_SPACE(_UCRED.size) + socket.CMSG_SPACE(4 * _RIGHT.size)
    data, ancillary, flags, _ = channel.recvmsg(bound + 1, extent, socket.MSG_CMSG_CLOEXEC | socket.MSG_DONTWAIT)
    credentials, rights, other = [], set(), False
    with ExitStack() as received:
        for level, kind, value in ancillary:
            if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                other = True
                for offset in range(0, len(value) - _RIGHT.size + 1, _RIGHT.size):
                    fd, = _RIGHT.unpack_from(value, offset)
                    if fd >= 0 and fd not in rights:
                        received.callback(os.close, fd)
                        rights.add(fd)
            elif (level, kind) == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS) and len(value) == _UCRED.size:
                credentials.append(_UCRED.unpack(value))
            else:
                other = True
        _need(0 < len(data) <= bound and not other and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
              and len(credentials) == 1, 'wrapper-control-packet')
        return data, credentials[0]


def _poll(channel, pidfd, milliseconds):
    poll = select.poll()
    poll.register(pidfd, select.POLLIN)
    if channel is not None:
        poll.register(channel.fileno(), select.POLLIN)
    return dict(poll.poll(milliseconds))


def _parent(item, pidfd, clock):
    clock.left()
    pid = item['parentPid']
    _need(os.getppid() == pid and not _poll(None, pidfd, 0), 'wrapper-parent-lost')
    with ExitStack() as held:
        proc, _ = _open_dir(held, None, '/proc', None)
        _need(os.readlink('self', dir_fd=proc) == str(os.getpid()), 'wrapper-parent-proc')
        child, _ = _open_dir(held, proc, str(os.getpid()), None)
        parent, _ = _open_dir(held, proc, str(pid), None)
        fd = os.open('stat', _FILE, dir_fd=parent)
        held.callback(os.close, fd)
        raw = os.read(fd, 8193)
        close = raw.rfind(b') ')
        fields = raw[close + 2:].split()
        _need(0 < len(raw) <= 8192 and raw.endswith(b'\n') and os.read(fd, 1) == b''
              and raw.startswith(f'{pid} ('.encode('ascii')) and close > 0
              and len(fields) > 19 and fields[0] not in (b'Z', b'X') and fields[19].isdigit()
              and int(fields[19]) == item['parentBirth'], 'wrapper-parent-birth')
        namespaces = (os.stat('ns/time', dir_fd=owner) for owner in (child, parent))
        own, other = ((info.st_dev, info.st_ino) for info in namespaces)
        _need(own == other, 'wrapper-parent-time-namespace')
    _need(os.getppid() == pid and not _poll(None, pidfd, 0), 'wrapper-parent-lost')
    clock.left()


def _ack(channel, pidfd, expected, clock):
    wait = clock.left() // 1_000_000
    _need(wait > 0, 'wrapper-deadline')
    events = _poll(channel, pidfd, wait)
    clock.left()
    _need(pidfd not in events and events == {channel.fileno(): select.POLLIN}, 'wrapper-control-ready')
    payload, peer = _recv(channel, len(_GO))
    _need(payload == _GO and peer == expected and not _poll(channel, pidfd, 0), 'wrapper-control-ack')
    clock.left()


def _restore_signals():
    # Python installs its own SIGINT and ignores SIGPIPE and SIGXFSZ. Restore
    # the fixed native wrapper policy explicitly before replacing the process.
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGPIPE, signal.SIGCHLD, signal.SIGXFSZ):
        signal.signal(number, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, ())


def _helper():
    _need(sys.platform == 'linux' and os.uname().machine == 'x86_64'
          and os.getresuid() == os.getresgid() == _ROOT and len(sys.argv) == 1
          and sys.flags.isolated == sys.flags.no_site == 1 and sys.dont_write_bytecode
          and dict(os.environ) == dict(_ENV), 'wrapper-helper-identity')
    path = re.fullmatch(r'/var/lib/' + re.escape(_ROOT_PREFIX) + r'([1-9][0-9]{0,15})/code/\.github/ci/'
                        + re.escape(_HELPER), sys.argv[0])
    _need(path is not None and _run_valid(path[1]), 'wrapper-helper-path')
    pid = os.getpid()
    _need(pid == os.getsid(0) == os.getpgrp(), 'wrapper-helper-session')
    stdio = _stdio()
    os.set_inheritable(_CONTROL, False)
    with ExitStack() as held:
        channel = held.enter_context(socket.socket(fileno=_CONTROL))
        _need(channel.family == socket.AF_UNIX and channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET
              and channel.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'wrapper-control-fd')
        channel.setblocking(False)
        raw, peer = _recv(channel, _PREPARE_MAX)
        item = _prepare(raw)
        clock = _Clock(item['startedNs'], item['readyByNs'])
        clock.left()
        expected = (item['parentPid'], 0, 0)
        _need(peer == expected and item['runId'] == path[1], 'wrapper-control-parent')
        pidfd = os.pidfd_open(item['parentPid'])
        held.callback(os.close, pidfd)
        _parent(item, pidfd, clock)
        _need(_stock_identity() == tuple(item['stock']), 'wrapper-stock-changed')
        clock.left()
        argv = _command(item, clock)
        _parent(item, pidfd, clock)
        _need(not _poll(channel, pidfd, 0), 'wrapper-control-early-data')
        clock.left()
        _need(channel.send(_READY, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL) == len(_READY), 'wrapper-control-ready-send')
        _ack(channel, pidfd, expected, clock)
        _need(_stock_identity() == tuple(item['stock']), 'wrapper-stock-changed')
        clock.left()
        _need(_stdio() == stdio, 'wrapper-stdio-changed')
        clock.left()
        _restore_signals()
        _parent(item, pidfd, clock)
        _need(not _poll(channel, pidfd, 0), 'wrapper-control-surplus')
    clock.left()
    os.execve(_STOCK, argv, dict(_ENV))
    raise Refused('wrapper-exec-returned')


if __name__ == '__main__':
    try:
        _helper()
    except BaseException:
        os._exit(125)
