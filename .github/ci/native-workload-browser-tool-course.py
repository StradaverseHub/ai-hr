"""One protected, disposable tool-only course. No candidate runtime or API."""
from __future__ import annotations

import ctypes
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import select
import signal
import socket
import ssl
import stat
import struct
import sys
import time
from contextlib import ExitStack, contextmanager
from types import ModuleType


ROOT_PARENT = pathlib.Path('/var/lib')
ROOT_PREFIX = 'aihr-native-tool-only-'
SOURCE = '.github/ci/native-workload-browser-tool-course.py'
GENERATION = '1784092784777971'
BROWSER_BYTES = 120231126
NPM_MAX = 16 * 1024**2
CHUNK = 256 * 1024
ACTIVE_SECONDS, TOTAL_SECONDS, PROCESS_SETTLEMENT = 150, 180, 6
HANDSHAKE_SECONDS, GROUP_SETTLEMENT = 3, 3
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
WRITE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
PROC_MAX = 4 * 1024**2
MOUNT = '/usr/bin/mount'
UMOUNT = '/usr/bin/umount'
DOWNLOADS = (
    ('chromium.zip', 'storage.googleapis.com',
     '/storage/v1/b/chrome-for-testing-public/o/151.0.7922.34%2Flinux64%2Fchrome-headless-shell-linux64.zip'
     '?alt=media&generation=' + GENERATION, BROWSER_BYTES),
    ('playwright.tgz', 'registry.npmjs.org', '/playwright/-/playwright-1.62.1.tgz', NPM_MAX),
    ('playwright-core.tgz', 'registry.npmjs.org', '/playwright-core/-/playwright-core-1.62.1.tgz', NPM_MAX),
    ('postgres.tgz', 'registry.npmjs.org', '/postgres/-/postgres-3.4.9.tgz', NPM_MAX),
)
ARCHIVES = frozenset(row[0] for row in DOWNLOADS)
DOWNLOAD_SLOTS = tuple(row[0] for row in DOWNLOADS) + ('download.json',)
DUMP_POLICIES = {b'0': 'post-drop-nondumpable-policy-zero', b'2': 'post-drop-nondumpable-policy-root-only'}
UCREDS = struct.Struct('=iII')
RIGHT = struct.Struct('=i')
TOP_LEVEL = frozenset(('code', 'incoming', 'inputs', 'payload'))
PROCESS_REASONS = frozenset(('complete', 'command-failed', 'deadline', 'handshake-refused', 'descendants-survived',
                             'protocol-refused', 'owner-interrupted', 'group-uncertain', 'session-escaped'))
DOWNLOAD_FAILURES = {2: 'download-identity', 3: 'download-writer', 4: 'download-tls-transport',
                     5: 'download-framing', 6: 'download-deadline', 7: 'download-write',
                     8: 'download-identity-original', 9: 'download-identity-dump-policy',
                     10: 'download-identity-dump-policy-root-only', 11: 'download-identity-set-dumpable',
                     12: 'download-identity-drop-groups', 13: 'download-identity-drop-gid',
                     14: 'download-identity-drop-uid', 15: 'download-identity-post-dumpable',
                     16: 'download-identity-set-no-new-privs', 17: 'download-identity-post-ids',
                     18: 'download-identity-status', 19: 'download-identity-capabilities',
                     20: 'download-identity-observe-no-new-privs'}


class ToolRefusal(ValueError):
    def __init__(self, message, reason):
        super().__init__(message)
        self.reason = reason


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode()


def left(deadline):
    seconds = deadline - time.monotonic()
    if not seconds > 0:
        raise ToolRefusal('TOOL elapsed boundary', 'deadline')
    return seconds


def birth(info):
    return info.st_dev, info.st_ino


def identity(info):
    return (*birth(info), info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def named(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)


def present(parent, name):
    try:
        named(parent, name)
    except FileNotFoundError:
        return False
    return True


@contextmanager
def owned_fd(fd):
    try:
        yield fd
    except BaseException as error:
        try:
            os.close(fd)
        except OSError:
            error.add_note('TOOL descriptor close refused')
        raise
    else:
        os.close(fd)


def _open_tool_parent(held):
    parent = held.enter_context(owned_fd(os.open('/', DIR)))
    for component in ROOT_PARENT.parts[1:]:
        before = named(parent, component)
        require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0 and not before.st_mode & 0o022,
                'TOOL parent ancestry is not protected')
        child = held.enter_context(owned_fd(os.open(component, DIR, dir_fd=parent)))
        require(identity(os.fstat(child)) == identity(before), 'TOOL parent ancestry changed')
        parent = child
    return parent


@contextmanager
def quiet_command_stdio():
    # Keep the original sealed request and receipt descriptors out of even the
    # fixed child. The kernel already supplies its own private process ledger.
    with ExitStack() as held:
        original = [held.enter_context(owned_fd(os.dup(fd))) for fd in (0, 1, 2)]
        sink = held.enter_context(owned_fd(os.open('/dev/null', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)))
        try:
            for fd in (0, 1, 2):
                os.dup2(sink, fd)
            yield
        finally:
            primary = sys.exception()
            failed = False
            for fd, saved in enumerate(original):
                try:
                    os.dup2(saved, fd)
                except OSError:
                    failed = True
            if failed:
                if primary is None:
                    raise OSError('TOOL command stdio restore refused')
                primary.add_note('TOOL command stdio restore refused')


def require_dir(info, uid, gid, mode, device):
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == mode and info.st_uid == uid
            and info.st_gid == gid and info.st_dev == device, 'TOOL directory ownership differs')


def require_file(info, uid, gid, mode, maximum):
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == mode and info.st_uid == uid
            and info.st_gid == gid and info.st_nlink == 1 and 0 < info.st_size <= maximum,
            'TOOL regular file custody differs')


def write_all(fd, raw, deadline):
    view = memoryview(raw)
    while view:
        left(deadline)
        count = os.write(fd, view)
        require(0 < count <= len(view), 'TOOL write made no progress')
        view = view[count:]


def read_file(parent, name, uid, gid, maximum, deadline):
    before = named(parent, name)
    require_file(before, uid, gid, 0o600, maximum)
    with owned_fd(os.open(name, READ, dir_fd=parent)) as fd:
        require(identity(os.fstat(fd)) == identity(before), 'TOOL opened file differs')
        result = bytearray()
        while len(result) < before.st_size:
            left(deadline)
            block = os.read(fd, min(CHUNK, before.st_size - len(result)))
            require(block, 'TOOL source truncated')
            result.extend(block)
        left(deadline)
        require(os.read(fd, 1) == b'' and identity(before) == identity(os.fstat(fd))
                == identity(named(parent, name)), 'TOOL source changed')
    return bytes(result)


def bounded_proc(path, maximum):
    with open(path, 'rb', buffering=0) as fd:
        raw = fd.read(maximum + 1)
    require(0 < len(raw) <= maximum, 'TOOL proc observation exceeds bound')
    return raw


@contextmanager
def fixed_refusal(reason, errors=(ValueError, OSError)):
    try:
        yield
    except (ToolRefusal, InterruptedError):
        raise
    except errors as error:
        raise ToolRefusal('Fixed TOOL operation refused', reason) from error


def refusal_reason(error):
    if isinstance(error, ToolRefusal):
        return error.reason
    if isinstance(error, InterruptedError):
        return 'owner-interrupted'
    if isinstance(error, OSError):
        return 'host-io'
    return 'contract-refused'


def source_module(name, path, raw):
    module = ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    exec(compile(raw, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def _download_headers(response, maximum, browser):
    headers = response.getheaders()
    require(response.status == 200 and len(headers) <= 64
            and sum(len(key) + len(value) for key, value in headers) <= 65536,
            'TOOL HTTP response differs')
    values = lambda key: [value.strip() for name, value in headers if name.lower() == key]
    require(values('content-encoding') in ([], ['identity']) and not values('content-range')
            and not values('location'), 'TOOL HTTP encoding or location differs')
    lengths, transfers = values('content-length'), values('transfer-encoding')
    if lengths:
        require(len(lengths) == 1 and not transfers and re.fullmatch(r'[1-9][0-9]{0,9}', lengths[0]),
                'TOOL HTTP content length differs')
        size = int(lengths[0])
        require(size <= maximum, 'TOOL HTTP content length exceeds bound')
    else:
        require(transfers == ['chunked'] and not browser, 'TOOL HTTP framing differs')
        size = None
    if browser:
        require(size == BROWSER_BYTES and values('x-goog-generation') == [GENERATION],
                'TOOL fixed publisher generation or length differs')
    return size


def _drop_downloader(uid, gid):
    with fixed_refusal('download-identity-original'):
        require(os.geteuid() == 0 and type(uid) is int and type(gid) is int and uid > 0 and gid > 0,
                'TOOL downloader original identity differs')
    libc = ctypes.CDLL(None, use_errno=True)
    # Linux resets dumpability to this sysctl during credential transitions.
    # Refuse before any transition that could expose a same-UID /proc/fd view.
    with fixed_refusal('download-identity-dump-policy'):
        policy = bounded_proc('/proc/sys/fs/suid_dumpable', 16).strip()
        require(policy in DUMP_POLICIES, 'TOOL downloader descriptor privacy unavailable')
    with fixed_refusal('download-identity-set-dumpable'):
        require(libc.prctl(4, 0, 0, 0, 0) == 0, 'TOOL downloader descriptor privacy unavailable')
    with fixed_refusal('download-identity-drop-groups'):
        os.setgroups([])
    with fixed_refusal('download-identity-drop-gid'):
        os.setresgid(gid, gid, gid)
    with fixed_refusal('download-identity-drop-uid'):
        os.setresuid(uid, uid, uid)
    with fixed_refusal('download-identity-post-dumpable'):
        require(libc.prctl(3, 0, 0, 0, 0) == int(policy) and libc.prctl(4, 0, 0, 0, 0) == 0
                and libc.prctl(3, 0, 0, 0, 0) == 0, 'TOOL downloader post-drop dumpability differs')
    with fixed_refusal('download-identity-set-no-new-privs'):
        require(libc.prctl(38, 1, 0, 0, 0) == 0, 'TOOL downloader UID/GID or no-new-privs differs')
    with fixed_refusal('download-identity-post-ids'):
        require(os.getresuid() == (uid,)*3 and os.getresgid() == (gid,)*3 and not os.getgroups(),
                'TOOL downloader UID/GID or no-new-privs differs')
    with fixed_refusal('download-identity-status'):
        status = bounded_proc('/proc/self/status', 65536)
    with fixed_refusal('download-identity-capabilities'):
        _require_empty_capabilities(status)
    with fixed_refusal('download-identity-observe-no-new-privs'):
        _require_no_new_privileges(status)
    return policy, libc


def _require_empty_capabilities(status):
    for key in (b'CapInh', b'CapPrm', b'CapEff', b'CapAmb'):
        require(re.findall(rb'^' + key + rb':[ \t]+([0-9a-f]+)$', status, re.M) == [b'0000000000000000'],
                'TOOL downloader capabilities differ')


def _require_no_new_privileges(status):
    require(re.findall(rb'^NoNewPrivs:[ \t]+([0-9]+)$', status, re.M) == [b'1'],
            'TOOL downloader no-new-privs differs')


def download_slot(info):
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
            and info.st_uid == info.st_gid == 0 and info.st_nlink == 1, 'TOOL download slot custody differs')
    return birth(info)


def download_writers(writers):
    require(len(writers) == len(DOWNLOAD_SLOTS) and len(set(writers)) == len(writers)
            and all(3 <= fd < 1048576 for fd in writers), 'Fixed TOOL downloader writers required')
    births = set()
    for fd in writers:
        info = os.fstat(fd)
        key = download_slot(info)
        require(key not in births and info.st_size == 0 and os.lseek(fd, 0, os.SEEK_CUR) == 0
                and fcntl.fcntl(fd, fcntl.F_GETFL) & (os.O_ACCMODE | os.O_APPEND) == os.O_WRONLY,
                'TOOL downloader writer is not a fresh private capability')
        births.add(key)


@contextmanager
def _writer_message(channel, deadline):
    # Take custody of every delivered descriptor before checking framing or credentials.
    maximum = socket.CMSG_SPACE(UCREDS.size) + socket.CMSG_SPACE(len(DOWNLOAD_SLOTS) * RIGHT.size)
    ready, _, _ = select.select([channel], [], [], left(deadline))
    left(deadline)
    require(ready == [channel], 'TOOL writer channel read timeout')
    data, ancillary, flags, _ = channel.recvmsg(2, maximum, socket.MSG_CMSG_CLOEXEC | socket.MSG_DONTWAIT)
    credentials, rights, rights_records, shape = [], [], 0, True
    with ExitStack() as received:
        for level, kind, value in ancillary:
            if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                rights_records += 1
                shape = shape and len(value) % RIGHT.size == 0
                for offset in range(0, len(value) - RIGHT.size + 1, RIGHT.size):
                    fd, = RIGHT.unpack_from(value, offset)
                    if fd >= 0 and fd not in rights:
                        received.callback(os.close, fd)
                    shape = shape and fd >= 0
                    rights.append(fd)
            elif (level, kind) == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS) and len(value) == UCREDS.size:
                credentials.append(UCREDS.unpack(value))
            else:
                shape = False
        require(shape and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC)
                and (data or not ancillary), 'TOOL writer channel framing differs')
        left(deadline)
        yield data, credentials, tuple(rights), rights_records


def _send_writer_message(channel, data, ancillary, deadline):
    left(deadline)
    require(channel.sendmsg([data], ancillary, socket.MSG_DONTWAIT | socket.MSG_NOSIGNAL) == len(data),
            'TOOL writer channel write differs')


def _downloader_status(pid, deadline):
    require(type(pid) is int and pid > 1, 'TOOL held downloader PID differs')
    maximum = 65536
    left(deadline)
    with owned_fd(os.open('/proc', DIR)) as proc, owned_fd(os.open(str(pid), DIR, dir_fd=proc)) as process:
        process_birth = birth(os.fstat(process))
        require(process_birth == birth(named(proc, str(pid))), 'TOOL downloader proc directory differs')
        left(deadline)
        with owned_fd(os.open('status', READ, dir_fd=process)) as descriptor:
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and birth(before) == birth(named(process, 'status')),
                    'TOOL downloader proc status differs')
            status = bytearray()
            # A short procfs read is not EOF. Read one extra byte to detect overflow.
            while True:
                left(deadline)
                block = os.read(descriptor, min(4096, maximum + 1 - len(status)))
                left(deadline)
                if not block:
                    break
                status.extend(block)
                require(len(status) <= maximum, 'TOOL downloader proc status exceeds bound')
            require(status and birth(before) == birth(os.fstat(descriptor)) == birth(named(process, 'status'))
                    and process_birth == birth(os.fstat(process)) == birth(named(proc, str(pid))),
                    'TOOL downloader proc status or directory changed')
    left(deadline)
    return bytes(status)


def _download_writer_handoff(channel, deadline, interrupted, kernel, descriptor, admitted, uid, gid, slots):
    child = admitted['pid']

    def held():
        require(not select.select([descriptor], [], [], 0)[0], 'TOOL downloader exited before writer grant')
        actual = kernel.identity(child)
        require(actual['state'] not in ('Z', 'X') and all(actual[key] == admitted[key]
                for key in ('pid', 'parent', 'group', 'session', 'start')), 'TOOL downloader writer identity differs')

    with _writer_message(channel, deadline) as (data, credentials, rights, records):
        if not data:
            return None  # Let the original owned wait adjudicate the child's actual refusal exit.
        require(data[:1] == b'R' and data[1:] in DUMP_POLICIES and credentials == [(child, uid, gid)]
                and not rights and records == 0, 'TOOL writer readiness differs')
        policy = data[1:]
    held()
    status = _downloader_status(child, deadline)
    fields = [line.split() for line in status.splitlines()]
    for key, expected in ((b'Uid:', [str(uid).encode()] * 4), (b'Gid:', [str(gid).encode()] * 4), (b'Groups:', [])):
        require([row[1:] for row in fields if row and row[0] == key] == [expected],
                'TOOL downloader native writer credentials differ')
    _require_empty_capabilities(status)
    _require_no_new_privileges(status)
    require(bounded_proc('/proc/sys/fs/suid_dumpable', 16).strip() == policy, 'TOOL writer policy differs')
    folder, writers, births = slots
    download_writers(writers)
    for name, fd in zip(DOWNLOAD_SLOTS, writers, strict=True):
        info = os.fstat(fd)
        require(download_slot(info) == births[name] and identity(info) == identity(named(folder, name))
                and not os.get_inheritable(fd), 'TOOL writer slot changed before grant')
    held()
    require(not select.select([channel], [], [], 0)[0], 'TOOL writer readiness surplus')
    grant = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, b''.join(RIGHT.pack(fd) for fd in writers))]
    if interrupted():
        raise ToolRefusal('TOOL owner interrupted before writer grant', 'owner-interrupted')
    _send_writer_message(channel, b'W', grant, deadline)
    return DUMP_POLICIES[policy]


def _download_body(response, fd, maximum, browser, deadline):
    with fixed_refusal('download-framing', (ValueError, http.client.IncompleteRead)):
        expected = _download_headers(response, maximum, browser)
        limit = maximum if expected is None else expected
        total = 0
        while True:
            left(deadline)
            block = response.read(min(CHUNK, limit + 1 - total))
            if not block:
                break
            total += len(block)
            require(total <= limit, 'TOOL transfer exceeds byte bound')
            with fixed_refusal('download-write'):
                write_all(fd, block, deadline)
        require(total > 0 and (expected is None or total == expected), 'TOOL HTTP body length differs')
        return total


def download(uid, gid, deadline, ready_stop, channel_fd):
    here = pathlib.Path(__file__).absolute()
    root = here.parents[3]
    require(root.parent == ROOT_PARENT and re.fullmatch(ROOT_PREFIX + r'[1-9][0-9]{0,15}', root.name)
            and here == root / 'code' / SOURCE, 'Fixed TOOL downloader source required')
    with ExitStack() as received:
        with fixed_refusal('download-writer'), socket.socket(fileno=channel_fd) as channel:
            os.set_inheritable(channel_fd, False)
            require(channel.family == socket.AF_UNIX and channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET
                    and channel.getsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED) == 1, 'TOOL writer endpoint differs')
            parent = os.getppid()
            require(parent > 1, 'TOOL writer parent unavailable')
            with fixed_refusal('download-identity'):
                policy, libc = _drop_downloader(uid, gid)
            _send_writer_message(channel, b'R' + policy, [], ready_stop)
            data, credentials, writers, records = received.enter_context(_writer_message(channel, ready_stop))
            require(data == b'W' and credentials == [(parent, 0, 0)] and records == 1
                    and os.getppid() == parent and all(not os.get_inheritable(fd) for fd in writers), 'TOOL writer grant differs')
            download_writers(writers)
            with _writer_message(channel, ready_stop) as (tail, creds, extra, count):
                require(not (tail or creds or extra or count), 'TOOL writer channel surplus')
            require(libc.prctl(3, 0, 0, 0, 0) == 0, 'TOOL writer dumpability changed')
        left(ready_stop)
        _download_archives(writers, deadline)


def _download_archives(writers, deadline):
    left(deadline)
    lengths = {}
    with fixed_refusal('download-tls-transport', (OSError, http.client.HTTPException)):
        tls = ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')
        for (name, host, target, maximum), fd in zip(DOWNLOADS, writers[:-1], strict=True):
            connection = http.client.HTTPSConnection(host, timeout=min(10, left(deadline)), context=tls)
            try:
                connection.request('GET', target, headers={'Accept-Encoding': 'identity', 'Connection': 'close'})
                with connection.getresponse() as response:
                    lengths[name] = _download_body(response, fd, maximum, name == 'chromium.zip', deadline)
            finally:
                connection.close()
    with fixed_refusal('download-write'):
        write_all(writers[-1], canonical({'lengths': lengths, 'generation': GENERATION, 'privateWriters': True}), deadline)
    left(deadline)


def _admit_tool_command(kernel, child, ready, ack, stop, interrupted):
    buffer = b''
    while True:
        if interrupted():
            raise ToolRefusal('TOOL process owner interrupted', 'owner-interrupted')
        readable, _, _ = select.select([ready], [], [], min(.05, left(stop)))
        if not readable:
            continue
        raw = os.read(ready, 513 - len(buffer))
        require(raw, 'TOOL session anchor exited before readiness')
        buffer += raw
        require(len(buffer) <= 512, 'TOOL session packet exceeds bound')
        if b'\n' in buffer:
            break
    actual = kernel.identity(child)
    require(buffer.endswith(b'\n') and buffer.count(b'\n') == 1
            and json.loads(buffer) == {'kind': 'ready', **{key: value for key, value in actual.items() if key != 'state'}}
            and (actual['pid'], actual['parent'], actual['group'], actual['session']) == (child, os.getpid(), child, child)
            and actual['state'] not in ('Z', 'X'), 'TOOL session anchor differs')
    if interrupted():
        raise ToolRefusal('TOOL process owner interrupted', 'owner-interrupted')
    left(stop)
    require(os.write(ack, b'A') == 1, 'TOOL session acknowledgement refused')
    return actual


def _wait_tool_exit(pid):
    observed = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    require(observed is None or observed.si_pid == pid, 'TOOL wait returned a different process')
    return observed is not None


def _stop_tool_command(kernel, child, descriptor, admitted, group_stop, final_stop):
    if admitted is not None:
        current = kernel.identity(child)
        require((current['pid'], current['parent'], current['group'], current['session'], current['start'])
                == (child, os.getpid(), child, child, admitted['start']), 'TOOL session ownership changed before stop')
    left(group_stop)
    try:
        if admitted is None:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        else:
            os.killpg(child, signal.SIGKILL)
    except ProcessLookupError:
        pass
    while True:
        left(group_stop)
        if not kernel.live_group(child) and _wait_tool_exit(child):
            left(group_stop)
            break
        time.sleep(min(.01, left(group_stop)))
    escaped = False
    while True:
        left(final_stop)
        owned = kernel.own_children()
        require(len(set(owned)) == len(owned) and child in owned, 'TOOL adopted process census differs')
        if owned == [child]:
            break
        for pid in owned:
            if pid == child:
                continue
            before = kernel.identity(pid)
            require((before['pid'], before['parent']) == (pid, os.getpid()), 'TOOL adopted process is foreign')
            with owned_fd(os.pidfd_open(pid)) as bound:
                after = kernel.identity(pid)
                require((after['pid'], after['parent'], after['start']) == (pid, os.getpid(), before['start']),
                        'TOOL adopted process identity changed')
                escaped = escaped or (after['group'], after['session']) != (child, child)
                left(final_stop)
                try:
                    signal.pidfd_send_signal(bound, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if _wait_tool_exit(pid):
                    left(final_stop)
                    require(os.waitpid(pid, os.WNOHANG)[0] == pid, 'TOOL adopted process reap refused')
        time.sleep(min(.01, left(final_stop)))
    require(not kernel.live_group(child) and _wait_tool_exit(child), 'TOOL session still live before reap')
    left(final_stop)
    waited, status = os.waitpid(child, os.WNOHANG)
    require(waited == child, 'TOOL reserved session reap differs')
    return os.waitstatus_to_exitcode(status), escaped


def _run_tool_command(kernel, argv, stop, *, download_slots=None):
    # Fixed root owner, with the same held identity and process-group primitives
    # as the historical kernel. Unlike its relative clock this stop is armed
    # before setup, and neither settlement phase can restart its allowance.
    ready_stop = min(stop, time.monotonic() + HANDSHAKE_SECONDS)
    command_stop = ready_stop
    require(kernel.own_children() == [] and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
            and len(list(pathlib.Path('/proc/self/task').iterdir())) == 1, 'TOOL process owner is not exclusive')
    previous = kernel.subreaper(True)
    fds, child, admitted = set(), None, None
    result = {'reason': 'handshake-refused', 'commandExit': None, 'admitted': False,
              'reaped': False, 'groupQuiescent': False, 'escapedSession': False}

    def close(fd):
        fds.remove(fd)
        os.close(fd)

    interrupted = False
    writer_handoff = None

    def interrupt(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    try:
        with ExitStack() as handlers:
            for sig in (signal.SIGINT, signal.SIGTERM):
                handlers.callback(signal.signal, sig, signal.signal(sig, interrupt))
            ready, publish = os.pipe()
            fds.update((ready, publish))
            grant, ack = os.pipe()
            fds.update((grant, ack))
            if download_slots is not None:
                root_channel, child_channel = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
                for endpoint in (root_channel, child_channel):
                    handlers.enter_context(endpoint)
                for endpoint in (root_channel, child_channel):
                    endpoint.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            child_env = os.environ.copy()
            if interrupted:
                raise ToolRefusal('TOOL process owner was interrupted before fork', 'owner-interrupted')
            left(ready_stop)
            child = os.fork()
            if child == 0:
                try:
                    os.close(ready); os.close(ack)
                    os.setsid()
                    signal.signal(signal.SIGTERM, signal.SIG_DFL)
                    signal.signal(signal.SIGINT, signal.SIG_DFL)
                    kernel.write_packet(publish, {'kind': 'ready', **{key: value for key, value in kernel.identity(os.getpid()).items() if key != 'state'}})
                    os.close(publish)
                    require(os.read(grant, 1) == b'A', 'TOOL session was not granted')
                    os.close(grant)
                    # A parent descheduled just before writing ACK cannot extend
                    # the shorter admission boundary for the actual child exec.
                    left(ready_stop)
                    if download_slots is not None:
                        root_channel.close()
                        for writer in download_slots[1]:
                            os.close(writer)
                        control = child_channel.fileno()
                        os.set_inheritable(control, True)
                        argv = [*argv, repr(ready_stop), str(control)]
                        left(ready_stop)
                    os.execve(argv[0], argv, child_env)
                except BaseException:
                    os._exit(125)
            close(publish); close(grant)
            try:
                descriptor = os.pidfd_open(child)
            except OSError:
                close(ack)  # EOF only; no guessed PID signal.
                result['reason'] = 'protocol-refused'
                return result
            fds.add(descriptor)
            try:
                if download_slots is not None:
                    child_channel.close()
                admitted = _admit_tool_command(kernel, child, ready, ack, ready_stop, lambda: interrupted)
                result['admitted'] = True
                if download_slots is not None:
                    uid, gid = map(int, argv[5:7])
                    writer_handoff = _download_writer_handoff(root_channel, ready_stop, lambda: interrupted,
                                                              kernel, descriptor, admitted, uid, gid, download_slots)
                    root_channel.close()
                # The launcher ACK grants mounts. A downloader also needs the writer handoff.
                if download_slots is None or writer_handoff is not None:
                    command_stop = stop
                while not interrupted:
                    left(command_stop)
                    if _wait_tool_exit(child):
                        break
                    time.sleep(min(.01, left(command_stop)))
                left(command_stop)
                result['reason'] = 'owner-interrupted' if interrupted else 'complete'
                if not interrupted:
                    followers_until = min(command_stop, time.monotonic() + 1)
                    while True:
                        left(command_stop)
                        followers = kernel.live_group(child)
                        if not followers:
                            break
                        remaining = followers_until - time.monotonic()
                        if remaining <= 0:
                            break
                        time.sleep(min(.01, remaining))
                    left(command_stop)
                    if followers:
                        result['reason'] = 'descendants-survived'
            except ToolRefusal as error:
                result['reason'] = ('handshake-refused' if admitted is None and error.reason == 'deadline'
                                    else error.reason)
            except BaseException:
                result['reason'] = 'protocol-refused'
            finally:
                settle = min(command_stop, time.monotonic())
                try:
                    code, escaped = _stop_tool_command(kernel, child, descriptor, admitted,
                                                       settle + GROUP_SETTLEMENT, settle + PROCESS_SETTLEMENT)
                    result['reaped'], result['escapedSession'] = True, escaped
                    if admitted is not None:
                        result['commandExit'] = code
                    require(kernel.own_children() == [], 'TOOL final owned census differs')
                    left(settle + PROCESS_SETTLEMENT)
                    result['groupQuiescent'] = True
                    if result['reason'] == 'complete' and (escaped or code != 0):
                        result['reason'] = 'session-escaped' if escaped else 'command-failed'
                    if interrupted and result['reason'] == 'complete':
                        result['reason'] = 'owner-interrupted'
                    if download_slots is not None and result['reason'] == 'complete':
                        if writer_handoff is None:
                            result['reason'] = 'protocol-refused'
                        else:
                            result['writerHandoff'] = writer_handoff
                except BaseException:
                    pass
    finally:
        close_failed = False
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                close_failed = True
        if child is None or result['groupQuiescent']:
            kernel.subreaper(previous)
        if close_failed and sys.exception() is None:
            raise ToolRefusal('TOOL process descriptor close refused', 'host-io')
    return result


class Course:
    def __init__(self, run, uid, gid, start):
        self.name = ROOT_PREFIX + run
        self.path = ROOT_PARENT / self.name
        self.uid, self.gid = uid, gid
        self.active, self.deadline = start + ACTIVE_SECONDS, start + TOTAL_SECONDS
        self.parent = self.root = None
        self.creation_attempted = self.created = False
        self.device = None
        self.births = {}
        self.download_births = {}
        self.processes_settled = True
        self.mount_uncertain = False
        self.owned_mount = None
        self.private_mount_namespace = None
        self.mounts = None
        self.kernel = None
        self.stage = 'root-acquisition'
        self.state = {}

    def create(self, parent):
        left(self.active)
        info = os.fstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'TOOL parent is not protected')
        self.parent = parent
        require(not present(parent, self.name), 'TOOL namespace already exists')
        left(self.active)
        self.creation_attempted = True
        os.mkdir(self.name, mode=0o700, dir_fd=parent)
        self.created = True
        first = named(parent, self.name)
        self.births[''] = birth(first)
        self.root = os.open(self.name, DIR, dir_fd=parent)
        self.device = first.st_dev
        self.check_root(0o700)

    def check_root(self, mode):
        require(self.root is not None, 'TOOL root descriptor unavailable')
        parent = ROOT_PARENT.lstat()
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022
                and birth(parent) == birth(os.fstat(self.parent)), 'TOOL parent identity changed')
        before, current = named(self.parent, self.name), os.fstat(self.root)
        require_dir(current, 0, 0, mode, self.device)
        require(birth(current) == self.births[''] and identity(before) == identity(current),
                'TOOL owned root changed')
        return current

    def add_directory(self, name):
        left(self.active)
        os.mkdir(name, mode=0o700, dir_fd=self.root)
        info = named(self.root, name)
        require_dir(info, 0, 0, 0o700, self.device)
        self.births[name] = birth(info)

    def child_directory(self, name, uid=0, gid=0, mode=0o700):
        before = named(self.root, name)
        require_dir(before, uid, gid, mode, self.device)
        require(birth(before) == self.births[name], 'TOOL child directory changed')
        fd = os.open(name, DIR, dir_fd=self.root)
        try:
            require(identity(os.fstat(fd)) == identity(before), 'TOOL opened directory differs')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def install_capsule(self, members):
        self.add_directory('code')
        with owned_fd(self.child_directory('code')) as capsule:
            for relative, raw in members.items():
                left(self.active)
                parts = relative.split('/')
                with ExitStack() as stack:
                    parent = capsule
                    for part in parts[:-1]:
                        fresh = not present(parent, part)
                        if fresh:
                            left(self.active)
                            os.mkdir(part, mode=0o700, dir_fd=parent)
                        parent = stack.enter_context(owned_fd(os.open(part, DIR, dir_fd=parent)))
                        if fresh:
                            left(self.active)
                            os.fchmod(parent, 0o755)
                        require_dir(os.fstat(parent), 0, 0, 0o755, self.device)
                    left(self.active)
                    with owned_fd(os.open(parts[-1], WRITE, 0o400, dir_fd=parent)) as fd:
                        write_all(fd, raw, self.active)
                        left(self.active)
                        os.fchmod(fd, 0o444)
                        info = os.fstat(fd)
                        require_file(info, 0, 0, 0o444, len(raw))
                    with owned_fd(os.open(parts[-1], READ, dir_fd=parent)) as fd:
                        require(identity(os.fstat(fd)) == identity(info), 'TOOL capsule copy identity differs')
                        offset = 0
                        while offset < len(raw):
                            left(self.active)
                            block = os.read(fd, min(CHUNK, len(raw) - offset))
                            require(block and block == raw[offset:offset + len(block)], 'TOOL capsule copy bytes differ')
                            offset += len(block)
                        require(os.read(fd, 1) == b'' and identity(info) == identity(os.fstat(fd))
                                == identity(named(parent, parts[-1])), 'TOOL capsule copy changed')
            left(self.active)
            os.fchmod(capsule, 0o555)
        code = self.path / 'code'
        self.kernel = source_module('aihr_tool_course_process', code / '.github/ci/owned-process.py',
                                    members['.github/ci/owned-process.py'])
        self.inventory = source_module('aihr_tool_course_inventory', code / '.github/ci/runtime_inventory.py',
                                       members['.github/ci/runtime_inventory.py'])
        materializer = '.github/ci/native-workload-browser-tool-installation.py'
        self.installer = source_module('aihr_tool_course_materializer', code / materializer, members[materializer])

    def command(self, argv, deadline, maximum, *, download_slots=None):
        payload = str(self.path / 'payload')
        mount_commands = ([MOUNT, '-i', '--make-rprivate', '/'], [MOUNT, '-i', '--bind', payload, payload],
                          [MOUNT, '-i', '-o', 'remount,bind,ro,nosuid,nodev,noexec', payload],
                          [UMOUNT, '-i', '--', payload])
        downloader = ['/usr/bin/python3', '-I', '-B', str(self.path / 'code' / SOURCE), '--download',
                      str(self.uid), str(self.gid), repr(self.active)]
        if argv in mount_commands:
            require(download_slots is None and maximum == 10
                    and deadline == (self.deadline if argv == mount_commands[-1] else self.active),
                    'TOOL mount command bound differs')
            operation = ('namespace-private', 'payload-bind', 'payload-remount', 'payload-unmount')[mount_commands.index(argv)]
        else:
            require(download_slots is not None and argv == downloader
                    and maximum == ACTIVE_SECONDS and deadline == self.active,
                    'Fixed TOOL process command required')
            operation = 'archive-downloader'
        require(operation not in self.state.get('processOutcomes', {}), 'TOOL process operation repeated')
        with quiet_command_stdio():
            now = time.monotonic()
            stop = min(now + maximum, deadline - PROCESS_SETTLEMENT)
            require(stop > now, 'TOOL process settlement reserve unavailable')
            if operation == 'archive-downloader':
                argv = argv[:7] + [repr(stop)]
            self.processes_settled = False
            if operation == 'archive-downloader':
                result = _run_tool_command(self.kernel, argv, stop, download_slots=download_slots)
            else:
                result = _run_tool_command(self.kernel, argv, stop)
        self.processes_settled = (result['reaped'] is True and result['groupQuiescent'] is True
                                  and self.kernel.own_children() == [])
        reason, code = result['reason'], result['commandExit']
        require(reason in PROCESS_REASONS and (code is None or type(code) is int and -64 <= code <= 255),
                'TOOL process result differs')
        outcomes = self.state.setdefault('processOutcomes', {})
        outcomes[operation] = {'reason': reason, 'exit': code, 'admitted': result['admitted'] is True,
                               'reaped': result['reaped'] is True, 'quiescent': self.processes_settled,
                               'escapedSession': result['escapedSession'] is True}
        if not self.processes_settled:
            outcomes[operation]['settlementReason'] = 'group-uncertain'
        if not (self.processes_settled and result['admitted'] is True and reason == 'complete'
                and code == 0 and result['escapedSession'] is False):
            if reason == 'command-failed' and operation == 'archive-downloader':
                reason = DOWNLOAD_FAILURES.get(code, reason)
            raise ToolRefusal('TOOL owned command or settlement refused',
                              reason if reason != 'complete' else 'group-uncertain')
        left(deadline)
        if operation == 'archive-downloader':
            handoff = result.get('writerHandoff')
            require(handoff in DUMP_POLICIES.values(), 'TOOL writer grant proof unavailable')
            return handoff

    def check_private_mount_namespace(self):
        require(self.private_mount_namespace is not None
                and birth(os.stat('/proc/self/ns/mnt')) == self.private_mount_namespace,
                'TOOL private mount namespace changed')

    def observe_mounts(self, deadline, *, private=False):
        left(deadline)
        if private or self.private_mount_namespace is not None:
            self.check_private_mount_namespace()
        with owned_fd(os.open('/proc/self', os.O_RDONLY | os.O_DIRECTORY)) as proc:
            raw = self.mounts.read_proc(proc, 'mountinfo', PROC_MAX, require)
        rows = self.mounts.parse_mountinfo(raw, require)
        if private:
            for line in raw.splitlines():
                fields = line.split(b' - ', 1)[0].split()
                require(not any(field.startswith((b'shared:', b'master:', b'propagate_from:')) for field in fields[6:]),
                        'TOOL mount propagation is not private')
        if private or self.private_mount_namespace is not None:
            self.check_private_mount_namespace()
        left(deadline)
        return rows

    def own_targets(self, rows):
        prefix = str(self.path)
        return [row for row in rows if row['target'] == prefix or row['target'].startswith(prefix + '/')]

    def enter_private_mount_namespace(self):
        require(not self.own_targets(self.observe_mounts(self.active)), 'Existing TOOL namespace mount')
        previous = birth(os.stat('/proc/self/ns/mnt'))
        left(self.active)
        require(ctypes.CDLL(None, use_errno=True).unshare(0x00020000) == 0,
                'TOOL private mount namespace unavailable')
        current = birth(os.stat('/proc/self/ns/mnt'))
        require(current != previous, 'TOOL private mount namespace unavailable')
        self.private_mount_namespace = current
        self.command([MOUNT, '-i', '--make-rprivate', '/'], self.active, 10)
        require(not self.own_targets(self.observe_mounts(self.active, private=True)),
                'Unexpected TOOL mount under private root')

    def acquire(self):
        self.add_directory('incoming')
        self.add_directory('inputs')
        self.check_root(0o700)
        with owned_fd(self.child_directory('incoming')) as folder, ExitStack() as held:
            writers = []
            for name in DOWNLOAD_SLOTS:
                left(self.active)
                fd = held.enter_context(owned_fd(os.open(name, WRITE, 0o600, dir_fd=folder)))
                info = os.fstat(fd)
                self.download_births[name] = download_slot(info)
                require(identity(info) == identity(named(folder, name)), 'TOOL created download slot changed')
                writers.append(fd)
            download_writers(writers)
            handoff = self.command(['/usr/bin/python3', '-I', '-B', str(self.path / 'code' / SOURCE), '--download',
                                    str(self.uid), str(self.gid), repr(self.active)], self.active, ACTIVE_SECONDS,
                                   download_slots=(folder, tuple(writers), self.download_births))
            for name, fd in zip(DOWNLOAD_SLOTS, writers, strict=True):
                require(download_slot(os.fstat(fd)) == self.download_births[name]
                        and identity(os.fstat(fd)) == identity(named(folder, name)), 'TOOL held download slot changed')
        self.check_root(0o700)
        with owned_fd(self.child_directory('incoming')) as source, \
             owned_fd(self.child_directory('inputs')) as destination:
            names = set()
            with os.scandir(source) as entries:
                for entry in entries:
                    require(entry.name in self.download_births and entry.name not in names
                            and download_slot(named(source, entry.name)) == self.download_births[entry.name],
                            'TOOL download inventory differs')
                    names.add(entry.name)
            require(names == set(DOWNLOAD_SLOTS), 'TOOL download inventory incomplete')
            fact = json.loads(read_file(source, 'download.json', 0, 0, 4096, self.active))
            require(type(fact) is dict and set(fact) == {'generation', 'lengths', 'privateWriters'}
                    and fact['generation'] == GENERATION and fact['privateWriters'] is True
                    and type(fact['lengths']) is dict and fact['lengths'].keys() == ARCHIVES, 'TOOL transfer facts differ')
            for name, _, _, maximum in DOWNLOADS:
                self.copy_archive(source, destination, name, maximum, fact['lengths'][name])
        self.state['transfer'] = {**fact, 'writerHandoff': handoff}

    def copy_archive(self, source, destination, name, maximum, size):
        left(self.active)
        info = named(source, name)
        require_file(info, 0, 0, 0o600, maximum)
        require(birth(info) == self.download_births[name], 'TOOL source slot differs')
        require(type(size) is int and size == info.st_size and (name != 'chromium.zip' or size == BROWSER_BYTES),
                'TOOL transfer size differs from owned file')
        with owned_fd(os.open(name, READ, dir_fd=source)) as incoming, \
             owned_fd(os.open(name, WRITE, 0o600, dir_fd=destination)) as sealed:
            require(identity(os.fstat(incoming)) == identity(info), 'TOOL source inode differs')
            remaining = size
            while remaining:
                left(self.active)
                data = os.read(incoming, min(remaining, CHUNK))
                require(data, 'TOOL source archive truncated')
                remaining -= len(data)
                write_all(sealed, data, self.active)
            left(self.active)
            require(os.read(incoming, 1) == b'' and identity(os.fstat(incoming)) == identity(info)
                    == identity(named(source, name)), 'TOOL source archive changed')
            left(self.active)
            os.fchmod(sealed, 0o400)
            require_file(os.fstat(sealed), 0, 0, 0o400, maximum)
            require(os.fstat(sealed).st_size == size, 'TOOL protected archive extent differs')

    @contextmanager
    def protected_archive_inputs(self, source):
        """Hold only this course's four exact inputs through strict materialization."""
        left(self.active)
        source_info = os.fstat(source)
        require_dir(source_info, 0, 0, 0o700, self.device)
        require(birth(source_info) == self.births['inputs']
                and identity(source_info) == identity(named(self.root, 'inputs')),
                'TOOL protected input directory differs')
        with ExitStack() as files:
            archives = []
            for name, _, _, maximum in DOWNLOADS:
                info = named(source, name)
                require_file(info, 0, 0, 0o400, maximum)
                stream = files.enter_context(os.fdopen(os.open(name, READ, dir_fd=source), 'rb'))
                require(identity(os.fstat(stream.fileno())) == identity(info), 'TOOL protected input inode differs')
                archives.append((name, stream, info))
            try:
                yield tuple(stream for _, stream, _ in archives)
            except self.installer._PARSER.ArchiveRefused as error:
                if error.args == ('archive inspection deadline exhausted',):
                    reason = 'deadline'
                elif error.args in (('pinned browser archive SHA-256 differs',), ('locked package SHA-512 differs',),
                                    ('parsed package SHA-512 differs',), ('pinned browser tree differs',)):
                    reason = 'strict-archive-pin'
                else:
                    reason = 'strict-archive-or-tree'
                raise ToolRefusal('Strict TOOL materialization refused', reason) from error
            for name, stream, info in archives:
                require(identity(info) == identity(os.fstat(stream.fileno())) == identity(named(source, name)),
                        'TOOL protected input changed')
            left(self.active)

    def materialize(self):
        self.add_directory('payload')
        with owned_fd(self.child_directory('inputs')) as source, \
             owned_fd(self.child_directory('payload')) as destination:
            with self.protected_archive_inputs(source) as archives:
                staged = self.installer.materialize_toolchain(destination, *archives, self.active)
            self.final_modes(destination, staged)
        return staged

    def final_modes(self, payload, staged):
        # The private materializer completed its full readback. The final
        # mounted pass independently reconciles all rows after these chmods.
        for row in reversed(staged):
            left(self.active)
            parts = row.path.split('/')
            with ExitStack() as stack:
                directory = payload
                for part in parts[:-1]:
                    directory = stack.enter_context(owned_fd(os.open(part, DIR, dir_fd=directory)))
                    require_dir(os.fstat(directory), 0, 0, 0o700, self.device)
                before = named(directory, parts[-1])
                flags = DIR if row.kind == 'directory' else READ
                with owned_fd(os.open(parts[-1], flags, dir_fd=directory)) as fd:
                    require(identity(os.fstat(fd)) == identity(before) and before.st_uid == before.st_gid == 0
                            and before.st_dev == self.device and stat.S_IMODE(before.st_mode) == row.staged_mode
                            and row.archive_mode in (0o444, 0o555), 'TOOL staged mode or identity changed')
                    left(self.active)
                    os.fchmod(fd, row.archive_mode)
                    current = os.fstat(fd)
                    require(birth(current) == birth(before) and stat.S_IMODE(current.st_mode) == row.archive_mode
                            and identity(current) == identity(named(directory, parts[-1])),
                            'TOOL final member mode differs')
        left(self.active)
        os.fchmod(payload, 0o555)

    def payload_mount(self, deadline, before_ids):
        rows = self.own_targets(self.observe_mounts(deadline, private=True))
        if not rows:
            self.mount_uncertain = False
            return None
        target = str(self.path / 'payload')
        require(len(rows) == 1 and rows[0]['target'] == target and rows[0]['id'] not in before_ids,
                'TOOL unexpected mount identity')
        mount = rows[0]
        # The backing FDs predate CLONE_NEWNS and still resolve on the old mount.
        # Start this mounted lookup at the current namespace's absolute root.
        with ExitStack() as held:
            parent = _open_tool_parent(held)
            parent_info = identity(os.fstat(self.parent))
            require(identity(os.fstat(parent)) == parent_info, 'TOOL private mount parent differs')
            root_info = identity(self.check_root(0o700))
            root = held.enter_context(owned_fd(os.open(self.name, DIR, dir_fd=parent)))
            require(identity(os.fstat(root)) == root_info == identity(named(parent, self.name)),
                    'TOOL private mount root differs')
            fd = held.enter_context(owned_fd(os.open('payload', DIR, dir_fd=root)))
            info = os.fstat(fd)
            require_dir(info, 0, 0, 0o555, self.device)
            fields = bounded_proc(f'/proc/self/fdinfo/{fd}', 65536)
            ids = re.findall(rb'^mnt_id:\s+([0-9]+)$', fields, re.M)
            require(ids == [str(mount['id']).encode()] and birth(info) == self.births['payload']
                    and identity(info) == identity(os.fstat(fd)) == identity(named(root, 'payload')),
                    'TOOL opened mount identity differs')
            require(identity(os.fstat(root)) == root_info == identity(named(parent, self.name))
                    and identity(os.fstat(parent)) == parent_info == identity(os.fstat(self.parent)),
                    'TOOL private mount ancestry changed')
        self.check_private_mount_namespace()
        left(deadline)
        self.owned_mount = mount['id']
        self.mount_uncertain = False
        return mount

    def seal_payload(self, staged):
        target = str(self.path / 'payload')
        self.check_root(0o700)
        require(birth(named(self.root, 'payload')) == self.births['payload'],
                'TOOL payload changed before bind')
        before = self.observe_mounts(self.active, private=True)
        require(not self.own_targets(before), 'TOOL payload already mounted')
        before_ids = {row['id'] for row in before}
        self.mount_uncertain = True
        try:
            self.command([MOUNT, '-i', '--bind', target, target], self.active, 10)
        except BaseException as error:
            if self.processes_settled:
                try:
                    self.payload_mount(self.deadline, before_ids)
                except BaseException:
                    error.add_note('TOOL bind observation refused')
            raise
        mounted = self.payload_mount(self.active, before_ids)
        require(mounted is not None, 'TOOL bind not observed')
        owned_id = self.owned_mount
        self.mount_uncertain = True
        try:
            self.command([MOUNT, '-i', '-o', 'remount,bind,ro,nosuid,nodev,noexec', target], self.active, 10)
        finally:
            # Reconcile the held mount ID before cleanup even after a failed
            # remount, without replacing the earlier command failure.
            if self.processes_settled:
                active_error = sys.exception()
                try:
                    observed = self.payload_mount(self.deadline if active_error else self.active, before_ids)
                    require(observed is not None and self.owned_mount == owned_id, 'TOOL remount identity changed')
                except BaseException:
                    self.owned_mount, self.mount_uncertain = owned_id, True
                    if active_error is None:
                        raise
                    active_error.add_note('TOOL remount observation refused')
        require({'ro', 'nosuid', 'nodev', 'noexec'} <= observed['options'] and 'rw' not in observed['options'],
                'TOOL payload is not mounted read-only')
        self.state['materialized'] = self.verify_mounted(target, staged, owned_id)

    def verify_mounted(self, target, staged, mount_id):
        expected = {row.path: row for row in staged}
        require(len(expected) == len(staged) and 0 < len(expected) <= 5122, 'TOOL installed tree census differs')
        rows = []
        with self.inventory.PinnedTree(target, lambda ok, reason: require(left(self.active) and ok, reason)) as tree:
            root = os.fstat(tree.fd)
            require_dir(root, 0, 0, 0o555, self.device)
            require(birth(root) == self.births['payload'], 'TOOL mounted payload birth differs')
            fields = bounded_proc(f'/proc/self/fdinfo/{tree.fd}', 65536)
            require(re.findall(rb'^mnt_id:\s+([0-9]+)$', fields, re.M) == [str(mount_id).encode()]
                    and os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY, 'TOOL mounted readback is not read-only')
            entries = tree.entries(maximum=5122)
            require(len(entries) == len(expected) and {path for path, _ in entries} == expected.keys(),
                    'TOOL mounted membership differs')
            for path, info in sorted(entries):
                left(self.active)
                row = expected[path]
                require(info.st_uid == info.st_gid == 0 and info.st_dev == self.device
                        and stat.S_IMODE(info.st_mode) == row.archive_mode, 'TOOL mounted owner or mode differs')
                if row.kind == 'directory':
                    require(stat.S_ISDIR(info.st_mode), 'TOOL mounted directory differs')
                    digest = None
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == row.bytes,
                            'TOOL mounted file identity differs')
                    hasher = hashlib.sha256()
                    with tree.open_regular(path, row.bytes, expected=self.inventory.identity(info), context='TOOL mounted member') as (stream, before):
                        require(identity(before) == identity(info), 'TOOL opened mounted member differs')
                        remaining = row.bytes
                        while remaining:
                            left(self.active)
                            chunk = stream.read(min(remaining, CHUNK))
                            require(chunk, 'TOOL mounted member truncated')
                            remaining -= len(chunk)
                            hasher.update(chunk)
                        require(stream.read(1) == b'' and identity(os.fstat(stream.fileno())) == identity(before),
                                'TOOL mounted member changed')
                    digest = hasher.hexdigest()
                    require(digest == row.sha256, 'TOOL mounted member hash differs')
                rows.append((path, row.kind, row.archive_mode, row.bytes, digest))
            tree.assert_unchanged()
            require(os.fstatvfs(tree.fd).f_flag & os.ST_RDONLY, 'TOOL mounted readback changed')
        mount_rows = self.own_targets(self.observe_mounts(self.active, private=True))
        require(len(mount_rows) == 1 and mount_rows[0]['id'] == mount_id
                and mount_rows[0]['target'] == target and {'ro', 'nosuid', 'nodev', 'noexec'} <= mount_rows[0]['options'],
                'TOOL mounted final observation differs')
        parser = self.installer._PARSER
        return {'treeSha256': hashlib.sha256(canonical(rows)).hexdigest(), 'entries': len(rows),
                'fileBytes': sum(row[3] for row in rows), 'mountId': mount_id,
                'readOnly': True, 'noSuid': True, 'noDev': True, 'noExec': True,
                'browserSha256': parser.BROWSER_ARCHIVE_SHA, 'browserTreeSha256': parser.BROWSER_TREE_SHA,
                'packageLockSRI': {name: parser.PACKAGES[name][1] for name in ('playwright', 'playwright-core', 'postgres')}}

    def dispose_mounts(self):
        require(self.processes_settled and not self.mount_uncertain, 'TOOL process or mount ownership uncertain')
        self.check_root(0o700)
        observed = self.observe_mounts(self.deadline)
        targets = self.own_targets(observed)
        if self.owned_mount is not None:
            held_id = self.owned_mount
            require(len(targets) == 1 and targets[0]['id'] == held_id
                    and targets[0]['target'] == str(self.path / 'payload'), 'TOOL owned mount changed before disposal')
            matched = self.payload_mount(self.deadline, set())
            require(matched is not None and matched['id'] == held_id, 'TOOL observed disposal mount differs')
            self.command([UMOUNT, '-i', '--', targets[0]['target']], self.deadline, 10)
            observed = self.observe_mounts(self.deadline)
            require(all(row['id'] != self.owned_mount for row in observed), 'TOOL owned mount still live')
        require(not self.own_targets(observed), 'TOOL foreign or leftover mount; preserve directory')
        self.state['mountsAbsent'] = True

    def execute(self, parent, members):
        primary, cleanup = None, 'not-acquired'
        try:
            self.create(parent)
            self.stage = 'source-capsule'
            self.install_capsule(members)
            self.stage = 'private-mount-namespace'
            self.enter_private_mount_namespace()
            self.stage = 'fixed-archive-acquisition'
            self.acquire()
            self.stage = 'strict-materialization'
            staged = self.materialize()
            self.stage = 'readonly-installation-readback'
            self.seal_payload(staged)
            left(self.active)
        except BaseException as error:
            primary = self.stage
            self.state['failureReason'] = refusal_reason(error)
        finally:
            if self.creation_attempted:
                cleanup = 'refused'
                if not self.created:
                    self.state['cleanupReason'] = 'namespace-creation-unproved'
            if self.created:
                cleanup = 'refused'
                try:
                    self.dispose_mounts()
                    self.dispose_tree(members)
                    cleanup = 'complete'
                except BaseException as error:
                    self.state['cleanupReason'] = refusal_reason(error)
            if self.root is not None:
                try:
                    os.close(self.root)
                except OSError:
                    cleanup = 'refused'
                    self.state.setdefault('cleanupReason', 'host-io')
        return primary, cleanup

    def dispose_tree(self, members):
        require(self.state.get('mountsAbsent') is True and self.processes_settled,
                'TOOL disposal requires native mount and process closure')
        self.check_root(0o700)
        count = 0
        fixed_code_paths = set(members)
        for relative in members:
            parts = relative.split('/')
            fixed_code_paths.update('/'.join(parts[:i]) for i in range(1, len(parts)))
        captured, children = {}, {}

        def scan(folder, relative, depth):
            nonlocal count
            require(depth <= 16, 'TOOL disposal depth exceeds bound')
            children[relative] = []
            with os.scandir(folder) as entries:
                for entry in entries:
                    left(self.deadline)
                    name = entry.name
                    path = relative + '/' + name if relative else name
                    count += 1
                    require(count <= 5200 and re.fullmatch(r'[A-Za-z0-9._+@-]+', name),
                            'TOOL disposal inventory exceeds bound')
                    info = named(folder, name)
                    top = path.split('/', 1)[0]
                    allowed = (
                        not relative and name in self.births and name in TOP_LEVEL
                        or top == 'code' and path[5:] in fixed_code_paths
                        or relative == 'incoming' and name in self.download_births
                        and download_slot(info) == self.download_births[name]
                        or relative == 'inputs' and name in ARCHIVES
                        or top == 'payload' and relative
                    )
                    directory, regular = stat.S_ISDIR(info.st_mode), stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    require(allowed and info.st_dev == self.device and info.st_uid == info.st_gid == 0
                            and (directory or regular)
                            and (relative not in ('incoming', 'inputs') or regular)
                            and (top != 'code' or not relative or directory == (path[5:] not in members)),
                            'TOOL unowned disposal entry; preserve directory')
                    if not relative:
                        require(stat.S_ISDIR(info.st_mode) and birth(info) == self.births[name], 'TOOL disposal root changed')
                    captured[path] = identity(info)
                    children[relative].append(name)
                    if directory:
                        with owned_fd(os.open(name, DIR, dir_fd=folder)) as child:
                            require(identity(os.fstat(child)) == identity(info), 'TOOL disposal directory changed')
                            scan(child, path, depth + 1)
        scan(self.root, '', 0)

        def remove(folder, relative):
            for name in children[relative]:
                left(self.deadline)
                path = relative + '/' + name if relative else name
                info = named(folder, name)
                require(captured.get(path) == identity(info), 'TOOL disposal entry changed')
                if stat.S_ISDIR(info.st_mode):
                    with owned_fd(os.open(name, DIR, dir_fd=folder)) as child:
                        require(identity(os.fstat(child)) == identity(info), 'TOOL disposal opened different directory')
                        remove(child, path)
                        require(birth(named(folder, name)) == birth(os.fstat(child)) == birth(info),
                                'TOOL disposal directory replaced')
                    left(self.deadline)
                    os.rmdir(name, dir_fd=folder)
                else:
                    left(self.deadline)
                    os.unlink(name, dir_fd=folder)
                require(not present(folder, name), 'TOOL disposed entry remains')
                del captured[path]
        # Open a new description, so prior enumeration cannot affect removal.
        with owned_fd(os.open('.', DIR, dir_fd=self.root)) as current:
            require(birth(os.fstat(current)) == self.births[''], 'TOOL disposal opened different root')
            remove(current, '')
        require(not captured, 'TOOL disposal lost entries')
        self.check_root(0o700)
        left(self.deadline)
        os.rmdir(self.name, dir_fd=self.parent)
        require(not present(self.parent, self.name), 'TOOL owned namespace remains')
        self.state['namespaceAbsent'] = True


def course_complete(course, primary, cleanup, ended):
    transfer = course.state.get('transfer', {})
    installed = course.state.get('materialized', {})
    return (primary is None and cleanup == 'complete' and ended < course.deadline
            and course.processes_settled is True
            and course.state.get('mountsAbsent') is True and course.state.get('namespaceAbsent') is True
            and transfer.get('generation') == GENERATION and transfer.get('lengths', {}).keys() == ARCHIVES
            and transfer.get('privateWriters') is True and transfer.get('writerHandoff') in DUMP_POLICIES.values()
            and installed.get('readOnly') is True and installed.get('noExec') is True
            and installed.get('entries', 0) > 0)


def run_course(run, source, uid, gid, members, rows, event_sha):
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64' and os.getresuid() == (0, 0, 0)
            and os.getresgid() == (0, 0, 0) and re.fullmatch(r'[1-9][0-9]{0,15}', run)
            and re.fullmatch(r'[0-9a-f]{40}', source), 'Actual root TOOL platform required')
    release = bounded_proc('/usr/lib/os-release', 65536).splitlines()
    require(b'ID=ubuntu' in release and b'VERSION_ID="24.04"' in release, 'Actual Ubuntu 24.04 TOOL platform required')
    os.umask(0o077)
    start = time.monotonic()
    course = Course(run, uid, gid, start)
    course.mounts = source_module('aihr_tool_course_mountinfo', SOURCE, members['deploy/admission/next_profile.py'])
    primary, cleanup = 'root-parent-acquisition', 'not-acquired'
    try:
        with ExitStack() as parents:
            def interrupt(_number, _frame):
                raise InterruptedError('TOOL owner interrupted')

            for signum in (signal.SIGINT, signal.SIGTERM):
                parents.callback(signal.signal, signum, signal.signal(signum, interrupt))
            parent = _open_tool_parent(parents)
            primary, cleanup = course.execute(parent, members)
    except BaseException as error:
        if course.creation_attempted:
            cleanup = 'refused'
        if primary is None:
            primary = 'owner-finalization'
        course.state.setdefault('failureReason', refusal_reason(error))
    ended = time.monotonic()
    if ended >= course.deadline:
        cleanup = 'refused'
        course.state.setdefault('cleanupReason', 'deadline')
    complete = course_complete(course, primary, cleanup, ended)
    report = {'kind': 'NATIVE_TOOL_ONLY_COMPONENT', 'complete': complete, 'cleanup': cleanup,
              'source': source, 'controller': source, 'runId': run, 'attempt': 1, 'job': 'native-test',
              'eventSha256': event_sha, 'sourceMembers': rows, 'sourceCapsuleSha256': hashlib.sha256(canonical(rows)).hexdigest(),
              'platform': {'system': sys.platform, 'machine': os.uname().machine, 'python': list(sys.version_info[:3]), 'ubuntu': '24.04'},
              'elapsedMs': int((ended - start) * 1000), 'ownedProcessesSettled': course.processes_settled,
              'browserStarted': False, 'applicationBuilt': False, 'databaseStarted': False,
              'nativeWorkloadQualified': False, 'releaseAuthorized': False, **course.state}
    if not complete:
        report['failure'] = primary if primary is not None else 'owned-settlement'
    return report


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 7 and sys.argv[1] == '--download'
                and all(re.fullmatch(r'[1-9][0-9]{0,9}', part) for part in sys.argv[2:4]),
                'Fixed TOOL downloader request required')
        require(re.fullmatch(r'[1-9][0-9]{0,6}', sys.argv[6]) and 3 <= int(sys.argv[6]) < 1048576,
                'Fixed TOOL writer endpoint required')
        deadline, ready_stop = map(float, sys.argv[4:6])
        require(0 < left(deadline) <= ACTIVE_SECONDS and 0 < left(ready_stop) <= HANDSHAKE_SECONDS
                and ready_stop <= deadline, 'Fixed TOOL downloader deadline differs')
        download(int(sys.argv[2]), int(sys.argv[3]), deadline, ready_stop, int(sys.argv[6]))
    except BaseException as error:
        sys.stderr.write('Fixed TOOL downloader refused\n')
        reason = refusal_reason(error)
        if reason == 'deadline':
            reason = 'download-deadline'
        sys.exit(next((code for code, value in DOWNLOAD_FAILURES.items() if value == reason), 1))
