"""Closed original-catalogue worker owner. No caller command, input or SQL API."""
import hashlib
import json
import os
import re
import select
import signal
import socket
import struct
import stat
import sys
import time
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[4]
KERNEL_PATH = ROOT / '.github/ci/owned-process.py'
KERNEL_SHA = 'cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c'


def fixed_bytes(path, maximum):
    """Bound the actual descriptor read; compile these bytes, never a cache."""
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
        raise ValueError('Fixed worker source boundary refused')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        opened = os.fstat(descriptor)
        if any(getattr(before, key) != getattr(opened, key) for key in fields):
            raise ValueError('Fixed worker source changed')
        result = bytearray()
        while len(result) <= maximum:
            piece = os.read(descriptor, min(65536, maximum + 1 - len(result)))
            if not piece:
                break
            result.extend(piece)
        after, current = os.fstat(descriptor), path.lstat()
        if len(result) != before.st_size or any(getattr(before, key) != getattr(after, key)
                                                or getattr(before, key) != getattr(current, key) for key in fields):
            raise ValueError('Fixed worker source read refused')
        return bytes(result)
    finally:
        os.close(descriptor)


_kernel_bytes = fixed_bytes(KERNEL_PATH, 131072)
if hashlib.sha256(_kernel_bytes).hexdigest() != KERNEL_SHA:
    raise ValueError('Qualified process source unavailable')
kernel = ModuleType('original_catalogue_owned_process')
kernel.__file__ = str(KERNEL_PATH)
exec(compile(_kernel_bytes, str(KERNEL_PATH), 'exec', dont_inherit=True), kernel.__dict__)


class InputRefused(ValueError):
    """Closed guard names only, never descriptor/argument/proc contents."""


def input_require(condition, reason):
    if not condition:
        raise InputRefused(reason)


def proc_bytes(directory, name, maximum):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        data = bytearray()
        while len(data) <= maximum:
            piece = os.read(descriptor, min(4096, maximum + 1 - len(data)))
            if not piece:
                break
            data.extend(piece)
        input_require(0 < len(data) <= maximum, 'parent-metadata')
        return bytes(data)
    finally:
        os.close(descriptor)


class NativeInput:
    """The fixed Node parent's anonymous Linux stream, not a general IPC API.

    Constructor arguments are internal source composition. Production fixes fd0,
    Node/source/cwd below; there are no command/environment selection switches.
    Peer credentials identify the socket creator; pidfd and fresh proc identity
    separately prove that creator is still our exact live parent.
    """
    def __init__(self, descriptor, node, parent_source, parent_sha, parent_cwd):
        self.descriptor, self.node = descriptor, Path(node)
        self.source, self.source_sha, self.cwd = Path(parent_source), parent_sha, Path(parent_cwd)
        self.pid, self.pidfd, self.channel = os.getppid(), None, None
        self.identity = None
        try:
            input_require(sys.platform == 'linux' and hasattr(socket, 'SO_DOMAIN')
                          and hasattr(os, 'pidfd_open'), 'native-platform')
            self.fd_identity = self._descriptor()
            input_require(stat.S_ISSOCK(self.fd_identity[2]), 'descriptor-kind')
            self.channel = socket.socket(fileno=os.dup(descriptor))
            input_require(self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) == socket.AF_UNIX,
                          'socket-domain')
            input_require(self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM,
                          'socket-type')
            input_require(self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0,
                          'socket-listener')
            input_require(self.channel.getsockname() in ('', b''), 'socket-address')
            try:
                peer = self.channel.getpeername()
            except OSError:
                raise InputRefused('socket-connected') from None
            input_require(peer in ('', b''), 'socket-address')
            self.credentials = struct.unpack('3i', self.channel.getsockopt(socket.SOL_SOCKET,
                socket.SO_PEERCRED, struct.calcsize('3i')))
            input_require(self.credentials == (self.pid, os.getuid(), os.getgid()), 'socket-peer')
            self.pidfd = os.pidfd_open(self.pid)
            os.set_inheritable(self.pidfd, False)
            self.identity = self._parent()
            self.check()
            os.set_blocking(descriptor, False)
        except BaseException as error:
            self.close(error)
            raise

    def _descriptor(self):
        info = os.fstat(self.descriptor)
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)

    def _parent(self):
        input_require(os.getppid() == self.pid and not select.select([self.pidfd], [], [], 0)[0], 'parent-live')
        directory = os.open('/proc/' + str(self.pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            raw = proc_bytes(directory, 'stat', 65536).decode('ascii')
            suffix = raw[raw.rindex(')') + 2:].split()
            input_require(suffix[0] not in ('Z', 'X', 'x') and len(suffix) > 19, 'parent-live')
            start = suffix[19]
            input_require(re.fullmatch(r'[1-9][0-9]*', start) is not None, 'parent-identity')
            status = dict(line.split(':', 1) for line in proc_bytes(directory, 'status', 65536).decode('ascii').splitlines() if ':' in line)
            input_require(status['Uid'].split() == [str(os.getuid())] * 4
                          and status['Gid'].split() == [str(os.getgid())] * 4, 'parent-credentials')
            executable = os.stat('exe', dir_fd=directory)
            wanted = self.node.stat()
            input_require(stat.S_ISREG(executable.st_mode) and (executable.st_dev, executable.st_ino)
                          == (wanted.st_dev, wanted.st_ino), 'parent-executable')
            # Fixed kernel proc links only. Neither path is supplied by IPC.
            input_require(os.path.samefile('/proc/' + str(self.pid) + '/cwd', self.cwd), 'parent-cwd')
            argv = proc_bytes(directory, 'cmdline', 65536).split(b'\0')
            input_require(len(argv) == 3 and argv[-1] == b'', 'parent-argv')
            args = [part.decode('utf8', errors='strict') for part in argv[:-1]]
            input_require(args[0] in ('node', str(self.node)), 'parent-argv')
            entry = Path(args[1])
            input_require(entry == self.source or not entry.is_absolute() and self.cwd / entry == self.source,
                          'parent-entry')
            input_require(hashlib.sha256(fixed_bytes(self.source, 131072)).hexdigest() == self.source_sha,
                          'parent-source')
            input_require(os.getppid() == self.pid and not select.select([self.pidfd], [], [], 0)[0], 'parent-live')
            return (self.pid, start, executable.st_dev, executable.st_ino)
        finally:
            os.close(directory)

    def check(self):
        input_require(self._descriptor() == self.fd_identity, 'descriptor-changed')
        input_require(self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN) == socket.AF_UNIX
                      and self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_STREAM
                      and self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 0
                      and self.channel.getsockname() in ('', b'') and self.channel.getpeername() in ('', b''),
                      'socket-changed')
        input_require(struct.unpack('3i', self.channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                      struct.calcsize('3i'))) == self.credentials, 'socket-peer')
        input_require(self._parent() == self.identity, 'parent-identity')

    def close(self, primary=None):
        failures = []
        if self.channel is not None:
            try:
                self.channel.close()
            except BaseException as error:
                failures.append(error)
            finally:
                self.channel = None
        if self.pidfd is not None:
            try:
                os.close(self.pidfd)
            except BaseException as error:
                failures.append(error)
            finally:
                self.pidfd = None
        if failures:
            raise BaseExceptionGroup('Native input closure refused',
                                     ([primary] if primary is not None else []) + failures)


class Cancellation:
    """One main-thread, nonblocking callback. Never changes the native clock.

    It can signal only the exact handler installed by this shared kernel.
    Group-stop disables polling before kernel cleanup restores that handler.
    No watcher, fork, thread, second process loop or numeric signal exists here.
    """
    def __init__(self, descriptor, soft_deadline, publish, *, verify=None):
        self.descriptor = descriptor
        self.verify = verify
        self.soft_deadline = soft_deadline
        self.publish = publish
        self.cancelled = False
        self.active = False
        self.handler = None
        self.requested = False
        self.publisher_failed = False

    def poll(self):
        try:
            if self.verify is not None:
                self.verify()
            if select.select([self.descriptor], [], [], 0)[0]:
                # EOF and ANY unexpected input both refuse. Never retain bytes.
                os.read(self.descriptor, 1)
                self.cancelled = True
        except BlockingIOError:
            pass
        except BaseException:
            self.cancelled = True

    def disable(self):
        self.active = False
        self.handler = None

    def clock(self):
        now = time.monotonic()
        if self.active:
            try:
                self.poll()
                if now >= self.soft_deadline:
                    self.cancelled = True
                if signal.getsignal(signal.SIGTERM) is not self.handler:
                    self.cancelled = True
                elif self.cancelled and not self.requested:
                    self.requested = True
                    signal.raise_signal(signal.SIGTERM)
            except BaseException:
                # The kernel must always receive the actual native clock value.
                self.cancelled = True
        return now

    def event(self, packet):
        if packet['kind'] == 'group-stop-before-reap':
            self.disable()
        elif packet['kind'] == 'session-admitted':
            handler = signal.getsignal(signal.SIGTERM)
            kernel.require(callable(handler) and getattr(handler, '__globals__', None) is kernel.__dict__
                           and getattr(handler, '__qualname__', None) == 'supervise.<locals>.interrupt')
            self.handler = handler
            self.active = True
            self.poll()
            if time.monotonic() >= self.soft_deadline:
                self.cancelled = True
            # mandatory=False makes this failure prevent the workload ACK.
            kernel.require(not self.cancelled)
        try:
            self.publish(packet)
        except BaseException:
            self.publisher_failed = True
            raise

    def completed(self, receipt):
        self.disable()
        self.poll()  # Completion and cancellation in one iteration still refuse.
        return (not self.cancelled and not self.publisher_failed
                and receipt == {'reason': 'complete', 'commandExit': 0, 'admitted': True,
                                'reaped': True, 'groupQuiescent': True,
                                'escapedSession': False, 'releaseAuthorized': False})


class Progress:
    """Best-effort phase observations, never a process/admission receipt."""
    stages = ('environment', 'paths', 'dependencies', 'loader-source', 'contract-input', 'cancellation-input', 'launch', 'kernel-settlement')

    def __init__(self):
        self.fd = None
        self.current = None
        self.failed = False
        self.closed = False
        try:
            workspace = Path(os.environ['GITHUB_WORKSPACE'])
            temporary = Path(os.environ['RUNNER_TEMP'])
            if (not workspace.is_absolute() or workspace.resolve() != workspace
                    or ROOT != workspace / 'controller' or Path.cwd() != ROOT
                    or not temporary.is_absolute() or temporary.resolve() != temporary):
                raise ValueError('Diagnostic root refused')
            private = temporary / 'original-catalogue-replay-private'
            info = private.lstat()
            if (private.resolve() != private or not stat.S_ISDIR(info.st_mode)
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
                raise ValueError('Diagnostic root refused')
            self.fd = os.open(private / 'adapter-progress.jsonl',
                              os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except BaseException:
            self.failed = True

    def emit(self, stage, status):
        if self.failed or self.closed:
            return
        try:
            packet = {'kind': 'ORIGINAL_REPLAY_PHASE_OBSERVATION', 'role': 'adapter',
                      'stage': stage, 'status': status}
            data = (json.dumps(packet, separators=(',', ':')) + '\n').encode('utf8')
            if os.write(self.fd, data) != len(data):
                raise ValueError('Diagnostic short write')
        except BaseException:
            self.failed = True

    def next(self, stage):
        kernel.require(stage in self.stages)
        if self.current is not None:
            self.emit(self.current, 'complete')
        self.current = stage
        self.emit(stage, 'entered')

    def finish(self, status):
        kernel.require(status in ('complete', 'refused'))
        if self.closed:
            return
        if self.current is not None:
            self.emit(self.current, status)
        self.closed = True
        if self.fd is not None:
            try:
                os.close(self.fd)
            except BaseException:
                self.failed = True


_progress = None


def main():
    global _progress
    began = time.monotonic()
    _progress = Progress()
    _progress.next('environment')
    kernel.require(len(sys.argv) == 1 and sys.platform == 'linux')
    keys = {'PATH', 'LANG', 'LC_ALL', 'TZ', 'GITHUB_WORKSPACE', 'RUNNER_TEMP', 'GITHUB_ACTIONS',
            'CI', 'RUNNER_ENVIRONMENT', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID',
            'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_SHA',
            'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_EVENT_NAME', 'NODE_EXECUTABLE'}
    kernel.require(set(os.environ) == keys)
    for key, value in {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC',
                       'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                       'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr', 'GITHUB_REPOSITORY_ID': '1333414856',
                       'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_WORKFLOW': 'original-catalogue-replay-diagnostic',
                       'GITHUB_JOB': 'replay', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}.items():
        kernel.require(os.environ[key] == value)
    kernel.require(re.fullmatch(r'[1-9][0-9]{0,19}', os.environ['GITHUB_RUN_ID']) is not None
                   and re.fullmatch(r'[0-9a-f]{40}', os.environ['GITHUB_WORKFLOW_SHA']) is not None)
    _progress.next('paths')
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    temporary = Path(os.environ['RUNNER_TEMP'])
    kernel.require(workspace.is_absolute() and workspace.resolve() == workspace
                   and ROOT == workspace / 'controller' and Path.cwd() == ROOT
                   and temporary.is_absolute() and temporary.resolve() == temporary)
    private = temporary / 'original-catalogue-replay-private'
    info = private.lstat()
    kernel.require(private.resolve() == private and stat.S_ISDIR(info.st_mode)
                   and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
    node = Path(os.environ['NODE_EXECUTABLE'])
    kernel.require(node.is_absolute() and node.resolve() == node and node.is_file()
                   and os.path.samefile(node, '/proc/%s/exe' % os.getppid()))
    original = workspace / 'original'
    kernel.require(original.resolve() == original and original.is_dir())
    _progress.next('dependencies')
    package = (original / 'node_modules/tsx/package.json').resolve()
    kernel.require((original / 'node_modules') in package.parents
                   and json.loads(fixed_bytes(package, 262144))['version'] == '4.22.4')
    _progress.next('loader-source')
    loader = (original / 'node_modules/tsx/dist/loader.mjs').resolve()
    kernel.require((original / 'node_modules') in loader.parents and loader.is_file())
    _progress.next('contract-input')
    contract = json.loads(fixed_bytes(Path(__file__).with_name('contract.json'), 131072))
    fixed = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC',
             'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
             'GIT_NO_REPLACE_OBJECTS': '1', 'NODE_NO_WARNINGS': '1', 'RUNNER_TEMP': str(temporary),
             'AIHR_CI_HEAD': contract['originalCandidate'], 'AIHR_CI_CONTROL_HEAD': contract['originalController'],
             'AIHR_CI_MIGRATION_BASE': contract['originalMigrationBase'], 'AIHR_CI_CLASSIFIER_RUNTIME': 'native',
             'AIHR_ORIGINAL_REPLAY_SCOPE': 'old-plan-comparison-only'}
    for name in ('DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'):
        fixed[name] = 'postgres://nobody:nothing@127.0.0.1:1/no_database'
    _progress.next('cancellation-input')
    native_input = NativeInput(0, node, Path(__file__).with_name('parent.mjs'),
        '972936b9b1d06582a694608ca600375dc61a82a29694a58f0e3a82a1b32c5eae', workspace)
    # Keep six seconds for the unchanged kernel settlement and one for fixed
    # metadata/terminal work inside the parent's existing180s hard envelope.
    control = Cancellation(0, began + 173, lambda packet: kernel.append_event(private / 'worker-supervisor.jsonl', packet),
                           verify=native_input.check)
    try:
        seconds = began + 173 - time.monotonic()
        kernel.require(0 < seconds <= 173)
        os.environ.clear()
        os.environ.update(fixed)
        os.chdir(original)
        _progress.next('launch')
        try:
            receipt = kernel.supervise([str(node), '--import', str(loader), str(Path(__file__).with_name('worker.mjs'))],
                                       seconds, control.event, clock=control.clock, mandatory=False)
        finally:
            # The group-stop event already disabled polling before restoration;
            # this also closes every refusal path that never admitted a session.
            control.disable()
        _progress.next('kernel-settlement')
        completed = control.completed(receipt) and time.monotonic() - began < 180
        terminal = {'kind': 'ORIGINAL_CATALOGUE_SHARED_OWNER_TERMINAL', 'completed': completed,
                    'familySettled': receipt['reaped'] and receipt['groupQuiescent'] and not receipt['escapedSession']}
        _progress.finish('complete' if completed else 'refused')
        sys.stdout.write(json.dumps(terminal, separators=(',', ':')) + '\n')
        return 0 if completed else 1
    finally:
        native_input.close(sys.exception())



if __name__ == '__main__':
    try:
        outcome = main()
    except BaseException:
        if _progress is not None:
            _progress.finish('refused')
        sys.stderr.write('Original catalogue worker ownership refused\n')
        outcome = 1
    sys.exit(outcome)
