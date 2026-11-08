"""Manual Linux UID feasibility component. Never a native NoDB/API admission issuer.

Only the protected copy is executed after the first restricted hook. No package
install, application import, semantic-parent substitute or normal routing exists.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import resource
import signal
import select
import stat
import subprocess
import sys
import time
import types

BASE = Path('/var/lib/aihr-native-nodb-isolation')
ACCOUNT = 'aihrnodbfixture'
UID = 62000
GID = 62000
SELF = '.github/ci/native-nodb-isolation-fixture.py'
KERNEL = '.github/ci/owned-process.py'
WORKFLOW = '.github/workflows/native-nodb-isolation-fixture.yml'
CODE = {'fixture.py': SELF, 'owned-process.py': KERNEL, 'workflow.yml': WORKFLOW}
CODE['focused-workflow.yml'] = '.github/workflows/alpha-focused-checks.yml'
SAFE = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
        'TZ': 'Asia/Kuala_Lumpur', 'PYTHONDONTWRITEBYTECODE': '1',
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
        'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}
SECRET_KEYS = frozenset({'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN',
                         'ACTIONS_ID_TOKEN_REQUEST_TOKEN'})
MAX = 8 * 1024**2
NODE_VENDOR_SOURCE = Path('/opt/hostedtoolcache/node/22.23.3/x64/bin/node')
NODE_VENDOR_BYTES = 124827920
NODE_VENDOR_SHA256 = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'


def need(ok):
    if not ok:
        raise ValueError('Native UID component refused')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def secure_read(path, maximum=MAX, owner=0):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path)
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and not info.st_mode & 0o022)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_uid == owner and before.st_nlink == 1
         and not before.st_mode & 0o022 and 0 <= before.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                                  value.st_gid, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        need(identity(before) == identity(os.fstat(fd)))
        raw = bytearray()
        while len(raw) <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(path.lstat()))
        return bytes(raw)
    finally:
        os.close(fd)


def bootstrap_read(path, maximum, runner):
    path = Path(path)
    need(path.is_absolute() and path.resolve() == path)
    for parent in path.parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, runner) and not info.st_mode & 0o022)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_uid in (0, runner) and before.st_nlink == 1
         and not before.st_mode & 0o022 and 0 < before.st_size <= maximum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
                                  value.st_gid, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        need(identity(before) == identity(os.fstat(fd)))
        raw = bytearray()
        while len(raw) <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd)) == identity(path.lstat()))
        return bytes(raw)
    finally:
        os.close(fd)


def write_new(path, raw, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            need(count > 0)
            view = view[count:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def root_for_run():
    run = os.environ.get('GITHUB_RUN_ID', '')
    need(sys.platform == 'linux' and re.fullmatch(r'[1-9][0-9]{0,19}', run))
    return BASE / run


def load_state():
    root = root_for_run()
    value = json.loads(secure_read(root / 'private/state.json', 65536))
    need(value['run'] == os.environ['GITHUB_RUN_ID'] and value['uid'] == UID and value['gid'] == GID)
    need(value['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    for name, item in value['code'].items():
        raw = secure_read(root / name, 1024**2)
        need(len(raw) == item['bytes'] and digest(raw) == item['sha256'])
    need(digest(secure_read(root / 'node', 256 * 1024**2)) == value['nodeSha256'])
    need(Path(__file__).resolve() == root / 'fixture.py')
    return root, value


def kernel(root):
    module = types.ModuleType('uid_fixture_kernel')
    module.__file__ = str(root / 'owned-process.py')
    exec(compile(secure_read(root / 'owned-process.py', 1024**2), module.__file__, 'exec', dont_inherit=True), module.__dict__)
    return module


def process(pid):
    raw = Path('/proc/%s/stat' % pid).read_bytes()
    fields = raw[raw.rfind(b')') + 2:].split()
    status = dict(line.split(':', 1) for line in Path('/proc/%s/status' % pid).read_text().splitlines() if ':' in line)
    return {'pid': pid, 'start': int(fields[19]), 'parent': int(fields[1]),
            'uids': [int(part) for part in status['Uid'].split()],
            'gids': [int(part) for part in status['Gid'].split()],
            'groups': [int(part) for part in status['Groups'].split()]}


def identity_actors(*, uid_only=False):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            item = process(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        if UID in item['uids'] or (not uid_only and (GID in item['gids'] or GID in item['groups'])):
            found.append(item)
    return found


def uid_actors():
    return identity_actors(uid_only=True)


def require_identity_free():
    # A numeric GID can already be used without an NSS group or matching UID.
    need(not identity_actors())


class RootFamily:
    """Actual child ownership only, held within this one live root subreaper.

    No JSON/argv/group search can recreate a family. Its fresh supervisor stays
    WNOWAIT-reserved until all observed descendants/adopted children are dead and
    reaped. A missing closed receipt makes later account removal unavailable.
    """
    def __init__(self, root, operation):
        need(operation in ('allocation', 'fault', 'git', 'hook', 'probe') and os.geteuid() == 0)
        self.root, self.operation = root, operation
        self.K = kernel(root)
        need(self.K.own_children() == [] and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
             and len(list(Path('/proc/self/task').iterdir())) == 1)
        self.previous = self.K.subreaper(True)
        self.bindings, self.children = {}, []
        self.started = time.monotonic()
        self.closed = False
        state = json.loads(secure_read(root / 'private/state.json', 65536))
        self.source = state['sourceSha']
        self.owner = process(os.getpid())
        elapsed = time.monotonic_ns() - int(state['anchorNs'])
        need(0 <= elapsed and elapsed + (16 + 10 + 120) * 10**9 < 1800 * 10**9)
        self.prior_rows = sum(len(json.loads(secure_read(path, 65536))['actualHeldIdentities'])
                              for path in (root / 'private').glob('*.role-closed.json'))
        need(self.prior_rows < 128)
        self.fault_captured = False
        write_new(root / ('private/' + operation + '.role-start.json'), canonical({
            'owner': self.owner, 'source': self.source,
            'run': root.name, 'operation': operation, 'cleanupKnown': False}))

    def bind(self, row):
        key = (row['pid'], row['start'])
        if key in self.bindings:
            return
        need(self.prior_rows + len(self.bindings) < 128)
        descriptor = os.pidfd_open(row['pid'])
        try:
            current = process(row['pid'])
            need(current['start'] == row['start'])
            # Reparenting to this actual subreaper preserves the same family.
            if current['parent'] not in (row['parent'], os.getpid()):
                parents = [(parent, fd) for parent, fd in self.bindings.values()
                           if parent['pid'] == current['parent'] and not self.exited(fd)]
                need(len(parents) == 1 and process(current['parent'])['start'] == parents[0][0]['start'])
            self.bindings[key] = (current, descriptor)
        except BaseException:
            os.close(descriptor)
            raise

    def spawn(self, argv, *, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL):
        child = subprocess.Popen(argv, env={**SAFE, 'GITHUB_RUN_ID': self.root.name},
                                 stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                 start_new_session=True, close_fds=True)
        self.children.append(child)
        row = process(child.pid); need(row['parent'] == os.getpid())
        self.bind(row)
        return child

    @staticmethod
    def exited(descriptor):
        return bool(select.select([descriptor], [], [], 0)[0])

    def capture(self):
        snapshot = {}
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():
                continue
            need(len(snapshot) < 65536)
            try:
                row = process(int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                continue
            snapshot[row['pid']] = row
        # All direct children are ours: this single-threaded owner began with
        # none, creates only fixed children, and privately enabled subreaping.
        owned = {pid for (pid, start), (_, fd) in self.bindings.items()
                 if not self.exited(fd) and pid in snapshot and snapshot[pid]['start'] == start}
        owned.update(row['pid'] for row in snapshot.values() if row['parent'] == os.getpid())
        while True:
            expanded = owned | {row['pid'] for row in snapshot.values() if row['parent'] in owned}
            if expanded == owned:
                break
            owned = expanded
            need(len(owned) <= 128)
        for pid in sorted(owned):
            try:
                self.bind(snapshot[pid])
            except (FileNotFoundError, ProcessLookupError):
                continue
        if self.operation == 'fault' and not self.fault_captured:
            marker = self.root / 'private/fault-root-follower.json'
            if marker.exists():
                row = json.loads(secure_read(marker, 4096))
                key = (row['pid'], row['start'])
                if key in self.bindings:
                    actual, fd = self.bindings[key]
                    need(not self.exited(fd) and actual['uids'] == [0] * 4 and UID not in actual['uids'])
                    write_new(self.root / 'private/fault-owner-captured.json', canonical({'captured': True}))
                    self.fault_captured = True

    def wait(self, child):
        # Do not poll()/communicate()/wait(): Popen would release the root anchor
        # before orphaned pre-drop commands had been captured and settled.
        while time.monotonic() < self.started + 10:
            self.capture()
            if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                return
            time.sleep(.01)
        raise TimeoutError('Fixed root role work budget')

    def close(self):
        deadline = min(time.monotonic(), self.started + 10) + 6
        anchor_pids = {child.pid for child in self.children}
        unknown = False
        residual = False
        try:
            self.capture()
            residual = any(row['pid'] not in anchor_pids and not self.exited(fd)
                           for row, fd in self.bindings.values())
            # Stop the captured closure while all supervisor PIDs remain reserved.
            # Repeat capture until no running family member can fork a new branch.
            while time.monotonic() < deadline:
                self.capture()
                live = [(row, fd) for row, fd in self.bindings.values() if not self.exited(fd)]
                for row, fd in live:
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGSTOP)
                    except ProcessLookupError:
                        pass
                stopped = True
                for row, fd in live:
                    if self.exited(fd):
                        continue
                    try:
                        raw = Path('/proc/%s/stat' % row['pid']).read_bytes()
                        fields = raw[raw.rfind(b')') + 2:].split()
                        need(int(fields[19]) == row['start'])
                        stopped = stopped and fields[0] in (b'T', b't', b'Z', b'X')
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                if stopped:
                    before = len(self.bindings); self.capture()
                    if before == len(self.bindings):
                        break
                time.sleep(.01)
            else:
                need(False)
            # Bound descendants first, reserved supervisors last. No global UID,
            # GID, root PID, process-group or argv-based signal is authorized.
            ordered = sorted(self.bindings.values(), key=lambda pair: pair[0]['pid'] in anchor_pids)
            for row, fd in ordered:
                if not self.exited(fd):
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            while time.monotonic() < deadline:
                self.capture()
                for pid in self.K.own_children():
                    if pid not in anchor_pids and os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                        os.waitpid(pid, 0)
                if all(self.exited(fd) for _, fd in self.bindings.values()) and set(self.K.own_children()) <= anchor_pids:
                    break
                time.sleep(.01)
            else:
                need(False)
            statuses = []
            for child in self.children:
                row = next(row for row, _ in self.bindings.values() if row['pid'] == child.pid)
                need(os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None)
                statuses.append({'identity': row, 'exit': child.wait(timeout=max(.001, deadline - time.monotonic()))})
            need(self.K.own_children() == [] and time.monotonic() <= deadline)
            self.closed = True
            receipt = {'operation': self.operation, 'owner': self.owner, 'rootFamiliesClosed': True, 'cleanupKnown': True,
                       'liveDescendantsBeforeClosure': residual,
                       'actualHeldIdentities': [row for row, _ in self.bindings.values()],
                       'anchorsReapedAfterClosure': statuses, 'faultRootFollowerCaptured': self.fault_captured,
                       'source': self.source, 'run': self.root.name}
            write_new(self.root / ('private/' + self.operation + '.role-closed.json'), canonical(receipt))
            return receipt
        except BaseException:
            unknown = True
            # Even on observation failure, only already-held actual pidfds may
            # receive a final signal. Unknown closure never publishes success.
            for _, fd in self.bindings.values():
                if not self.exited(fd):
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            raise
        finally:
            for _, fd in self.bindings.values():
                os.close(fd)
            if self.closed and not unknown:
                self.K.subreaper(self.previous)


def value_refused(operation):
    try:
        operation()
    except ValueError:
        return True
    need(False)


def allocation_controls(root):
    family = RootFamily(root, 'allocation')
    try:
        require_identity_free()
        try:
            settle(root)
        except FileNotFoundError:
            pass
        else:
            need(False)
        children = [family.spawn(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--foreign-gid', kind])
                    for kind in ('primary', 'supplementary')]
        while time.monotonic() < family.started + 10:
            family.capture()
            paths = [root / ('private/foreign-gid-' + kind + '.json') for kind in ('primary', 'supplementary')]
            if all(path.exists() for path in paths):
                rows = [json.loads(secure_read(path, 4096)) for path in paths]
                need(all(row['pid'] == child.pid and UID not in row['uids'] for row, child in zip(rows, children)))
                need(GID in rows[0]['gids'] and GID in rows[1]['groups'] and GID not in rows[1]['gids'])
                need(not uid_actors() and {row['pid'] for row in identity_actors()} >= {child.pid for child in children})
                need(value_refused(require_identity_free))
                # This exact cleanup identity precondition refuses; it does not
                # kill either foreign-UID GID-only actor or remove any account.
                need(value_refused(lambda: settle(root)))
                need(all(process(row['pid']) == row for row in rows))
                need(all(not family.exited(fd) for _, fd in family.bindings.values()))
                break
            time.sleep(.01)
        else:
            need(False)
    finally:
        receipt = family.close()
    require_identity_free()
    write_new(root / 'private/allocation-controls.json', canonical({'missingRootReceiptRefusedDespiteEmptyCensus': True, 'primaryGidRefused': True,
              'supplementaryGidRefused': True, 'foreignActorsUntouchedByIdentityRefusal': True,
              'disposedOnlyByActualParentOwner': receipt['rootFamiliesClosed']}))


def root_fault(root):
    need(os.geteuid() == 0 and not SECRET_KEYS.intersection(os.environ))
    monitor = process(os.getppid()); supervisor = process(monitor['parent'])
    descriptors = []
    try:
        for row in (supervisor, monitor):
            descriptor = os.pidfd_open(row['pid']); descriptors.append(descriptor)
            need(process(row['pid']) == row and row['uids'] == [0] * 4)
        child = os.fork()
        if child == 0:
            for descriptor in descriptors:
                os.close(descriptor)
            os.setsid()
            write_new(root / 'private/fault-root-follower.json', canonical(process(os.getpid())))
            while True:
                signal.pause()
        deadline = time.monotonic() + 3
        while not (root / 'private/fault-owner-captured.json').exists():
            need(time.monotonic() < deadline)
            time.sleep(.01)
        need(json.loads(secure_read(root / 'private/fault-owner-captured.json', 4096)) == {'captured': True})
        # Actual native failure interleaving: both original live bound ancestors
        # die while a pre-drop UID0 follower survives in another session.
        for descriptor in descriptors:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
        os._exit(91)
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def restrict(root):
    need(os.geteuid() == 0)
    libc = ctypes.CDLL(None, use_errno=True)
    for capability in range(64):
        present = libc.prctl(23, capability, 0, 0, 0)
        if present == -1:
            need(ctypes.get_errno() == errno.EINVAL)
            break
        need(present in (0, 1))
        if present:
            need(libc.prctl(24, capability, 0, 0, 0) == 0)
    need(libc.prctl(47, 4, 0, 0, 0) == 0)  # PR_CAP_AMBIENT_CLEAR_ALL
    need(libc.prctl(8, 0, 0, 0, 0) == 0)   # PR_SET_KEEPCAPS
    need(libc.prctl(38, 1, 0, 0, 0) == 0)  # PR_SET_NO_NEW_PRIVS
    os.setgroups([])
    os.setresgid(GID, GID, GID)
    os.setresuid(UID, UID, UID)
    class Header(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]
    class Capabilities(ctypes.Structure):
        _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]
    header = Header(0x20080522, 0)
    values = (Capabilities * 2)()
    need(libc.capset(ctypes.byref(header), ctypes.byref(values)) == 0)
    os.environ.clear()
    os.environ.update(SAFE, HOME=str(root / 'home'), XDG_CACHE_HOME=str(root / 'cache'), GITHUB_RUN_ID=root.name)
    os.chdir(root / 'home')
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX, MAX))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    restricted_status()


def restricted_status():
    value = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    need([int(part) for part in value['Uid'].split()] == [UID] * 4
         and [int(part) for part in value['Gid'].split()] == [GID] * 4
         and value['Groups'].strip() == '' and value['NoNewPrivs'].strip() == '1')
    need(all(int(value[name].strip(), 16) == 0 for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')))
    need(not SECRET_KEYS.intersection(os.environ))
    for entry in Path('/proc/self/fd').iterdir():
        if int(entry.name) <= 2:
            continue
        try:
            os.fstat(int(entry.name))
        except OSError as error:
            need(error.errno == errno.EBADF)
            continue
        need(False)
    return {'uid': UID, 'gid': GID, 'supplementaryGroups': [], 'noNewPrivileges': True, 'capabilitiesZero': True}


def refused(operation):
    try:
        operation()
    except OSError as error:
        need(error.errno in (errno.EACCES, errno.EPERM))
        return True
    need(False)


def probe(root, request):
    status = restricted_status()
    libc = ctypes.CDLL(None, use_errno=True)
    results = []
    for item in request['targets']:
        need(process(item['pid']) == item)
        for name in ('environ', 'mem'):
            results.append(refused(lambda: os.close(os.open('/proc/%s/%s' % (item['pid'], name), os.O_RDONLY))))
        need(libc.ptrace(16, item['pid'], 0, 0) == -1 and ctypes.get_errno() in (errno.EPERM, errno.EACCES))
        results.append(True)
    results.append(refused(lambda: os.close(os.open(request['privateFile'], os.O_RDONLY))))
    results.append(refused(lambda: os.close(os.open('/proc/%s/fd/%s' % (request['ownerPid'], request['ownerFd']), os.O_RDONLY))))
    results.append(refused(lambda: os.readlink('/proc/%s/fd/%s' % (request['ownerPid'], request['ownerFd']))))
    class Iovec(ctypes.Structure):
        _fields_ = [('base', ctypes.c_void_p), ('length', ctypes.c_size_t)]
    byte = ctypes.create_string_buffer(1)
    local, remote = Iovec(ctypes.cast(byte, ctypes.c_void_p), 1), Iovec(request['markerAddress'], 1)
    libc.process_vm_readv.restype = ctypes.c_ssize_t
    need(libc.process_vm_readv(request['ownerPid'], ctypes.byref(local), 1, ctypes.byref(remote), 1, 0) == -1
         and ctypes.get_errno() in (errno.EPERM, errno.EACCES))
    results.append(True)
    results.append(refused(lambda: os.setresuid(0, 0, 0)))
    elevated = subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/true'], env=dict(os.environ),
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    need(elevated.returncode != 0)
    results.append(True)
    return {'status': status, 'accessRefusals': len(results), 'allAccessRefused': all(results),
            'targetIdentitiesStable': all(process(item['pid']) == item for item in request['targets'])}


def restricted(root, state, operation):
    request = json.loads(secure_read(root / 'request.json', 65536)) if operation == 'probe' else None
    K = kernel(root) if operation == 'hook' else None
    restrict(root)
    if operation == 'hook':
        refused(lambda: os.close(os.open(root / 'fixture.py', os.O_WRONLY)))
        events = []
        result = K.supervise(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--uid-child'],
                             1, events.append, mandatory=True)
        need(result == {'reason': 'complete', 'commandExit': 0, 'admitted': True, 'reaped': True,
                        'groupQuiescent': True, 'escapedSession': False, 'releaseAuthorized': False})
        need([event['kind'] for event in events] == ['session-admitted', 'group-stop-before-reap',
                                                   'group-quiescent-then-reaped', 'stage-ended'])
        escaped_events = []
        escaped = K.supervise(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--uid-escape'],
                              1, escaped_events.append, mandatory=True)
        need(escaped == {'reason': 'session-escaped', 'commandExit': 0, 'admitted': True, 'reaped': True,
                         'groupQuiescent': True, 'escapedSession': True, 'releaseAuthorized': False})
        need([event['kind'] for event in escaped_events] == ['session-admitted', 'group-stop-before-reap',
                                                           'group-quiescent-then-reaped', 'stage-ended'])
        write_new(root / 'home/hook.json', canonical(restricted_status()))
        print(json.dumps({'hookRanUnderDedicatedUid': True, 'protectedSourceWriteRefused': True,
                          'actualRestrictedKernel': result, 'actualRestrictedKernelEvents': events,
                          'actualEscapedFamilyRefused': escaped, 'actualEscapedFamilyEvents': escaped_events}))
    elif operation == 'probe':
        print(json.dumps(probe(root, request)))
    elif operation == 'git':
        hashes = {}
        for name, relative in CODE.items():
            argv = ['/usr/bin/git', '-c', 'safe.directory=' + state['source'], '-c', 'core.fsmonitor=false',
                    '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-C', state['source'],
                    'show', state['sourceSha'] + ':' + relative]
            result = subprocess.run(argv, env=dict(os.environ), stdin=subprocess.DEVNULL,
                                    capture_output=True, check=True, timeout=2)
            need(not result.stderr and 0 < len(result.stdout) <= 1024**2)
            hashes[name] = {'bytes': len(result.stdout), 'sha256': digest(result.stdout)}
        print(json.dumps(hashes))
    else:
        need(False)


def supervise(root, state, operation):
    need(operation in ('fault', 'git', 'hook', 'probe') and os.geteuid() == 0 and not SECRET_KEYS.intersection(os.environ))
    K = kernel(root)
    output = root / ('private/' + operation + '.stdout')
    error = root / ('private/' + operation + '.stderr')
    with output.open('xb') as out, error.open('xb') as err:
        saved = (os.dup(1), os.dup(2))
        try:
            os.dup2(out.fileno(), 1)
            os.dup2(err.fileno(), 2)
            argv = (['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--root-fault'] if operation == 'fault' else
                    ['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--restricted', operation])
            result = K.supervise(argv,
                                 10, lambda event: K.append_event(root / ('private/' + operation + '.jsonl'), event), mandatory=True)
        finally:
            os.dup2(saved[0], 1)
            os.dup2(saved[1], 2)
            os.close(saved[0]); os.close(saved[1])
    need(result == {'reason': 'complete', 'commandExit': 0, 'admitted': True, 'reaped': True,
                    'groupQuiescent': True, 'escapedSession': False, 'releaseAuthorized': False})
    raw = secure_read(output)
    if operation == 'git':
        need(json.loads(raw) == state['code'])
        body = {'committedFixtureSourcesExact': True, 'files': state['code']}
    else:
        body = json.loads(raw)
    print(json.dumps({'operation': operation, 'kernel': result, 'body': body}))


def location_fields(value):
    if type(value) is not dict or set(value) not in ({'frames'}, {'frames', 'exception'}):
        return None
    frames = value['frames']
    if type(frames) is not list or len(frames) > 8:
        return None
    for row in frames:
        if (type(row) is not dict or set(row) != {'function', 'line'}
                or type(row['function']) is not str or row['function'] not in FAILURE_FUNCTIONS or type(row['line']) is not int
                or not 1 <= row['line'] <= 4096):
            return None
    if 'exception' in value and (type(value['exception']) is not str or value['exception'] not in {kind.__name__ for kind in FAILURE_BUILTINS}):
        return None
    clean = {'frames': [{'function': row['function'], 'line': row['line']} for row in frames]}
    if 'exception' in value:
        clean['exception'] = value['exception']
    return clean if len(canonical(clean)) <= 1024 else None


def child_source_locations(root, operation):
    need(operation in ('fault', 'git', 'hook', 'probe'))
    packets = []
    for origin, suffix in (('supervisor', '.role-stderr'), ('command', '.stderr')):
        try:
            raw = secure_read(root / ('private/' + operation + suffix), 65536)
        except (FileNotFoundError, ValueError):
            continue  # Unavailable/unsafe/oversized input never becomes proof.
        for line in raw.splitlines()[:32]:  # Two fixed streams, at most64 lines.
            prefix = b'Native UID failure locations '
            if not line.startswith(prefix) or len(line) > len(prefix) + 1024 or len(packets) >= 2:
                continue
            try:
                clean = location_fields(json.loads(line[len(prefix):]))
            except (ValueError, UnicodeError, RecursionError, TypeError):
                continue
            if clean is not None:
                packets.append({'kind': 'UNTRUSTED_DIAGNOSTIC_NOT_PROOF', 'origin': origin, **clean})
    return packets


def partial_component_diagnostics(root, state):
    # Root-private fixed writers only. Validate exact schema and construct fresh
    # scalar summaries; never copy arbitrary JSON, process rows or raw streams.
    def read_optional(name):
        try:
            return json.loads(secure_read(root / ('private/' + name), 65536))
        except FileNotFoundError:
            return None

    def process_shape(row):
        need(type(row) is dict and set(row) == {'pid', 'start', 'parent', 'uids', 'gids', 'groups'})
        need(all(type(row[key]) is int and 0 <= row[key] < 2**63 for key in ('pid', 'start', 'parent')))
        for key, length in (('uids', 4), ('gids', 4), ('groups', None)):
            need(type(row[key]) is list and (len(row[key]) == length if length is not None else len(row[key]) <= 65536))
            need(all(type(value) is int and 0 <= value < 2**32 for value in row[key]))

    need(type(state['code']) is dict and set(state['code']) == set(CODE))
    for row in state['code'].values():
        need(type(row) is dict and set(row) == {'bytes', 'sha256'} and type(row['bytes']) is int
             and 0 < row['bytes'] <= 1024**2 and re.fullmatch(r'[a-f0-9]{64}', row['sha256']))
    result = {'kind': 'PARTIAL_COMPONENT_DIAGNOSTICS_NOT_ADMISSION', 'source': state['sourceSha'], 'run': state['run'],
              'protectedSourceCopies': len(CODE), 'committedGitComparisonQualified': False,
              'vendor': None, 'allocation': None, 'closedRoles': [], 'roleOutcomes': []}
    vendor = read_optional('node-vendor-controls.json')
    if vendor is not None:
        fields = {'kind', 'bytes', 'vendorSha256', 'positiveHeldCopyVerified', 'equalSizeAlteredCopyRejectedBySha',
                  'alteredCopyNeverExecutableOrPublished', 'rootProtectedBeforeHooks', 'releaseAuthorized'}
        need(type(vendor) is dict and set(vendor) == fields and vendor['kind'] == 'PINNED_NODE_VENDOR_BYTES_BEFORE_HOOKS'
             and type(vendor['bytes']) is int and vendor['bytes'] == NODE_VENDOR_BYTES
             and vendor['vendorSha256'] == NODE_VENDOR_SHA256 and vendor['releaseAuthorized'] is False)
        flags = ('positiveHeldCopyVerified', 'equalSizeAlteredCopyRejectedBySha', 'alteredCopyNeverExecutableOrPublished', 'rootProtectedBeforeHooks')
        need(all(vendor[key] is True for key in flags))
        result['vendor'] = {'bytes': NODE_VENDOR_BYTES, 'vendorSha256': NODE_VENDOR_SHA256,
                            **{key: True for key in flags}}
    allocation = read_optional('allocation-controls.json')
    if allocation is not None:
        keys = ('missingRootReceiptRefusedDespiteEmptyCensus', 'primaryGidRefused', 'supplementaryGidRefused',
                'foreignActorsUntouchedByIdentityRefusal', 'disposedOnlyByActualParentOwner')
        need(type(allocation) is dict and set(allocation) == set(keys) and all(allocation[key] is True for key in keys))
        result['allocation'] = {key: True for key in keys}
    held_total = 0
    for operation in ('allocation', 'fault', 'git', 'hook', 'probe'):
        closed = read_optional(operation + '.role-closed.json')
        if closed is not None:
            keys = {'operation', 'owner', 'rootFamiliesClosed', 'cleanupKnown', 'liveDescendantsBeforeClosure',
                    'actualHeldIdentities', 'anchorsReapedAfterClosure', 'faultRootFollowerCaptured', 'source', 'run'}
            need(type(closed) is dict and set(closed) == keys and closed['operation'] == operation
                 and closed['source'] == state['sourceSha'] and closed['run'] == state['run']
                 and closed['rootFamiliesClosed'] is True and closed['cleanupKnown'] is True
                 and type(closed['liveDescendantsBeforeClosure']) is bool and type(closed['faultRootFollowerCaptured']) is bool)
            process_shape(closed['owner']); need(type(closed['actualHeldIdentities']) is list and len(closed['actualHeldIdentities']) <= 128)
            for row in closed['actualHeldIdentities']:
                process_shape(row)
            held_total += len(closed['actualHeldIdentities']); need(held_total <= 128)
            anchors = closed['anchorsReapedAfterClosure']; need(type(anchors) is list and len(anchors) <= 2)
            exits = []
            for row in anchors:
                need(type(row) is dict and set(row) == {'identity', 'exit'} and type(row['exit']) is int and -64 <= row['exit'] <= 255)
                process_shape(row['identity']); exits.append(row['exit'])
            result['closedRoles'].append({'operation': operation, 'heldIdentities': len(closed['actualHeldIdentities']),
                'reservedChildExits': exits, 'rootFamiliesClosed': True,
                'liveDescendantsBeforeClosure': closed['liveDescendantsBeforeClosure'],
                'faultRootFollowerCaptured': closed['faultRootFollowerCaptured']})
        outcome = read_optional(operation + '.role-outcome.json')
        if outcome is not None:
            keys = {'kind', 'operation', 'source', 'run', 'childExit', 'stderrPresent',
                    'liveDescendantsBeforeClosure', 'stdoutWithinBound', 'childSourceLocations'}
            need(type(outcome) is dict and set(outcome) == keys and outcome['kind'] == 'CLOSED_ROOT_ROLE_DIAGNOSTIC'
                 and outcome['operation'] == operation and operation != 'allocation' and closed is not None
                 and outcome['source'] == state['sourceSha'] and outcome['run'] == state['run']
                 and type(outcome['childExit']) is int and -64 <= outcome['childExit'] <= 255
                 and all(type(outcome[key]) is bool for key in ('stderrPresent', 'liveDescendantsBeforeClosure', 'stdoutWithinBound')))
            need(outcome['childExit'] in exits and outcome['liveDescendantsBeforeClosure'] == closed['liveDescendantsBeforeClosure'])
            locations = outcome['childSourceLocations']; need(type(locations) is list and len(locations) <= 2)
            clean_locations = []
            for packet in locations:
                need(type(packet) is dict and set(packet) in ({'kind', 'origin', 'frames'}, {'kind', 'origin', 'frames', 'exception'})
                     and packet['kind'] == 'UNTRUSTED_DIAGNOSTIC_NOT_PROOF' and packet['origin'] in ('supervisor', 'command'))
                clean = location_fields({key: packet[key] for key in ('frames', 'exception') if key in packet}); need(clean is not None)
                clean_locations.append({'kind': 'UNTRUSTED_DIAGNOSTIC_NOT_PROOF', 'origin': packet['origin'], **clean})
            result['roleOutcomes'].append({'operation': operation, 'childExit': outcome['childExit'],
                'stderrPresent': outcome['stderrPresent'], 'liveDescendantsBeforeClosure': outcome['liveDescendantsBeforeClosure'],
                'stdoutWithinBound': outcome['stdoutWithinBound'], 'childSourceLocations': clean_locations})
    return result


def run_role(root, operation):
    require_identity_free()
    state = json.loads(secure_read(root / 'private/state.json', 65536))
    elapsed = time.monotonic_ns() - int(state['anchorNs'])
    need(0 <= elapsed and elapsed + (16 + 6 + 10 + 120) * 10**9 < 1800 * 10**9)
    family = RootFamily(root, operation)
    output_path = root / ('private/' + operation + '.role-stdout')
    error_path = root / ('private/' + operation + '.role-stderr')
    with output_path.open('xb') as out, error_path.open('xb') as err:
        try:
            child = family.spawn(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--supervise', operation],
                                 stdout=out, stderr=err)
            family.wait(child)
        finally:
            receipt = family.close()
    need(type(child.returncode) is int and -64 <= child.returncode <= 255)
    write_new(root / ('private/' + operation + '.role-outcome.json'), canonical({
        'kind': 'CLOSED_ROOT_ROLE_DIAGNOSTIC', 'operation': operation, 'source': state['sourceSha'], 'run': state['run'],
        'childExit': child.returncode, 'stderrPresent': error_path.lstat().st_size > 0,
        'liveDescendantsBeforeClosure': receipt['liveDescendantsBeforeClosure'],
        'stdoutWithinBound': output_path.lstat().st_size <= 65536,
        'childSourceLocations': child_source_locations(root, operation)}))
    require_identity_free()
    output, error = secure_read(output_path, 65536), secure_read(error_path, 65536)
    if operation == 'fault':
        need(child.returncode == -signal.SIGKILL and not output and not error and family.fault_captured
             and receipt['liveDescendantsBeforeClosure'] is True)
        return {'operation': operation, 'nativeRootPreDropOrphanFailureObserved': True, 'rootClosure': receipt}
    need(child.returncode == 0 and not error and len(output) <= 65536
         and receipt['liveDescendantsBeforeClosure'] is False)
    return json.loads(output)


def protect_vendor_node(root, anchor):
    """One fixed public transfer path; only immutable vendor bytes may publish.

    Source/K custody still uses bootstrap_read. No writable cache ancestor is
    executable authority, no caller supplies a path/hash/FD, and no network runs.
    """
    need(os.geteuid() == 0 and not SECRET_KEYS.intersection(os.environ))
    started = time.monotonic_ns()
    work_end, settle_end = started + 10 * 10**9, started + 16 * 10**9
    need(started + (16 + 10 + 120) * 10**9 < int(anchor['startNs']) + 1800 * 10**9)
    descriptors = []
    negative_path = root / 'private/node-altered-copy'

    def node_budget():
        need(time.monotonic_ns() <= work_end)

    def node_identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def copy_node(source_fd, destination_fd, *, altered=False):
        before = node_identity(os.fstat(source_fd))
        os.lseek(source_fd, 0, os.SEEK_SET)
        count, changed = 0, False
        checksum = hashlib.sha256()
        while True:
            node_budget()
            part = os.read(source_fd, min(1024**2, NODE_VENDOR_BYTES + 1 - count))
            if not part:
                break
            need(count + len(part) <= NODE_VENDOR_BYTES)
            if altered and count <= 4096 < count + len(part):
                offset = 4096 - count
                part = part[:offset] + bytes([part[offset] ^ 1]) + part[offset + 1:]
                changed = True
            checksum.update(part)
            view = memoryview(part)
            while view:
                node_budget(); written = os.write(destination_fd, view)
                need(written > 0); view = view[written:]
            count += len(part)
        need(count == NODE_VENDOR_BYTES and changed is altered
             and node_identity(os.fstat(source_fd)) == before)
        return checksum.hexdigest()

    def node_is_vendor(fd):
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
             and before.st_size == NODE_VENDOR_BYTES and stat.S_IMODE(before.st_mode) == 0)
        os.lseek(fd, 0, os.SEEK_SET)
        header = os.read(fd, 64)
        need(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == 62)
        os.lseek(fd, 0, os.SEEK_SET)
        count, checksum = 0, hashlib.sha256()
        while True:
            node_budget(); part = os.read(fd, min(1024**2, NODE_VENDOR_BYTES + 1 - count))
            if not part:
                break
            count += len(part); need(count <= NODE_VENDOR_BYTES); checksum.update(part)
        need(count == NODE_VENDOR_BYTES and node_identity(before) == node_identity(os.fstat(fd)))
        return checksum.hexdigest() == NODE_VENDOR_SHA256

    try:
        source = os.open(NODE_VENDOR_SOURCE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        descriptors.append(source)
        before = os.fstat(source)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == NODE_VENDOR_BYTES)
        need(node_identity(before) == node_identity(NODE_VENDOR_SOURCE.lstat()))
        destination = os.open(root / 'node', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0)
        descriptors.append(destination)
        need(copy_node(source, destination) == NODE_VENDOR_SHA256)
        need(node_identity(before) == node_identity(os.fstat(source)) == node_identity(NODE_VENDOR_SOURCE.lstat()))
        node_budget(); os.fsync(destination); need(node_is_vendor(destination))
        negative = os.open(negative_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0)
        descriptors.append(negative)
        need(copy_node(destination, negative, altered=True) != NODE_VENDOR_SHA256)
        node_budget(); os.fsync(negative)
        # Same exact-size/ELF/identity validator; only the pinned SHA must refuse.
        need(node_is_vendor(negative) is False and stat.S_IMODE(os.fstat(negative).st_mode) == 0)
        need(node_identity(os.fstat(negative)) == node_identity(negative_path.lstat()))
        os.unlink(negative_path)  # Sole owned non-executable control; never publish.
        node_budget(); os.fchmod(destination, 0o555); os.fsync(destination); node_budget()
        published = os.fstat(destination)
        need(published.st_uid == 0 and published.st_nlink == 1 and stat.S_IMODE(published.st_mode) == 0o555
             and node_identity(published) == node_identity((root / 'node').lstat()))
        write_new(root / 'private/node-vendor-controls.json', canonical({
            'kind': 'PINNED_NODE_VENDOR_BYTES_BEFORE_HOOKS', 'bytes': NODE_VENDOR_BYTES,
            'vendorSha256': NODE_VENDOR_SHA256, 'positiveHeldCopyVerified': True,
            'equalSizeAlteredCopyRejectedBySha': True, 'alteredCopyNeverExecutableOrPublished': True,
            'rootProtectedBeforeHooks': True, 'releaseAuthorized': False}))
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        need(time.monotonic_ns() <= settle_end)


def prepare():
    need(os.geteuid() == 0 and os.environ.get('GITHUB_ACTIONS') == 'true'
         and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
         and os.environ.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr'
         and os.environ.get('GITHUB_JOB') == 'isolation' and os.environ.get('GITHUB_RUN_ATTEMPT') == '1')
    need(not SECRET_KEYS.intersection(os.environ))
    runner = int(os.environ['SUDO_UID']); need(runner > 0 and runner != UID)
    source = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    need(Path(__file__).resolve() == source / SELF and re.fullmatch(r'[a-f0-9]{40}', os.environ['GITHUB_SHA']))
    anchor_file = Path('/home/runner/work/_temp/aihr-native-uid-anchor.json')
    anchor_info = anchor_file.lstat()
    need(stat.S_ISREG(anchor_info.st_mode) and anchor_info.st_uid == runner and anchor_info.st_nlink == 1
         and stat.S_IMODE(anchor_info.st_mode) == 0o600 and 0 < anchor_info.st_size <= 4096)
    anchor_fd = os.open(anchor_file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw_anchor = os.read(anchor_fd, 4097)
        after = os.fstat(anchor_fd)
        need(len(raw_anchor) == anchor_info.st_size and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
             == (anchor_info.st_dev, anchor_info.st_ino, anchor_info.st_size, anchor_info.st_mtime_ns))
    finally:
        os.close(anchor_fd)
    anchor = json.loads(raw_anchor)
    need(set(anchor) == {'run', 'sha', 'bootId', 'startNs'} and anchor['run'] == os.environ['GITHUB_RUN_ID']
         and anchor['sha'] == os.environ['GITHUB_SHA'] and anchor['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip()
         and re.fullmatch(r'[1-9][0-9]{0,19}', anchor['startNs']) and 0 <= time.monotonic_ns() - int(anchor['startNs']) < 1800 * 10**9)
    for lookup, identity in ((pwd.getpwuid, UID), (grp.getgrgid, GID), (pwd.getpwnam, ACCOUNT), (grp.getgrnam, ACCOUNT)):
        try:
            lookup(identity)
        except KeyError:
            continue
        need(False)
    require_identity_free()
    BASE.mkdir(mode=0o755, exist_ok=True)
    need(BASE.lstat().st_uid == 0 and stat.S_IMODE(BASE.lstat().st_mode) == 0o755 and BASE.resolve() == BASE)
    root = root_for_run(); root.mkdir(mode=0o755)
    (root / 'private').mkdir(mode=0o700)
    code = {}
    for name, relative in CODE.items():
        raw = bootstrap_read(source / relative, 1024**2, runner)
        write_new(root / name, raw, 0o444); code[name] = {'bytes': len(raw), 'sha256': digest(raw)}
    protect_vendor_node(root, anchor)
    state = {'run': os.environ['GITHUB_RUN_ID'], 'sourceSha': os.environ['GITHUB_SHA'], 'source': str(source),
             'runner': runner, 'runnerGid': int(os.environ['SUDO_GID']), 'uid': UID, 'gid': GID,
             'code': code, 'nodeSha256': NODE_VENDOR_SHA256, 'anchorNs': anchor['startNs'], 'bootId': anchor['bootId'],
             'startedNs': str(time.monotonic_ns())}
    write_new(root / 'private/state.json', canonical(state))
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), 'allocate'],
              {**SAFE, 'GITHUB_RUN_ID': state['run']})


def allocate(root, state):
    need(os.geteuid() == 0 and not SECRET_KEYS.intersection(os.environ))
    require_identity_free()
    allocation_controls(root)
    require_identity_free()
    subprocess.run(['/usr/sbin/groupadd', '--gid', str(GID), ACCOUNT], env=SAFE, check=True, timeout=5)
    need(grp.getgrgid(GID).gr_name == ACCOUNT and grp.getgrgid(GID).gr_mem == [])
    write_new(root / 'private/group-created.json', canonical({'name': ACCOUNT, 'gid': GID}))
    subprocess.run(['/usr/sbin/useradd', '--no-log-init', '--no-create-home', '--uid', str(UID), '--gid', str(GID),
                    '--home-dir', str(root / 'home'), '--shell', '/usr/sbin/nologin', '--password', '!', ACCOUNT], env=SAFE, check=True, timeout=5)
    need(pwd.getpwuid(UID).pw_name == ACCOUNT and pwd.getpwuid(UID).pw_gid == GID)
    write_new(root / 'private/user-created.json', canonical({'name': ACCOUNT, 'uid': UID, 'gid': GID}))
    for name in ('home', 'cache'):
        directory = root / name; directory.mkdir(mode=0o700); os.chown(directory, UID, GID)
    # From here forward every executable source is the fixed protected copy.
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), 'hooks'],
              {**SAFE, 'GITHUB_RUN_ID': state['run']})


def hooks(root, state):
    rows = [run_role(root, 'fault'), run_role(root, 'git'), run_role(root, 'hook')]
    require_identity_free()
    write_new(root / 'private/hooks-closed.json', canonical({'rows': rows, 'settled': True}))


def custody(root, state):
    need(os.geteuid() == 0 and int(os.environ['SUDO_UID']) == state['runner']
         and os.environ.get('GITHUB_SHA') == state['sourceSha'] and os.environ.get('GH_TOKEN'))
    hooks_packet = json.loads(secure_read(root / 'private/hooks-closed.json', 65536))
    need(hooks_packet['settled'] is True and not identity_actors())
    targets = []; pid = os.getpid()
    for _ in range(32):
        item = process(pid); need(UID not in item['uids'] and GID not in item['gids'] and GID not in item['groups'])
        environment_fd = os.open('/proc/%s/environ' % pid, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            raw_environment = bytearray()
            while len(raw_environment) <= 1024**2:
                chunk = os.read(environment_fd, min(65536, 1024**2 + 1 - len(raw_environment)))
                if not chunk:
                    break
                raw_environment.extend(chunk)
            need(len(raw_environment) <= 1024**2 and (not raw_environment or raw_environment.endswith(b'\0')))
            keys = set()
            for entry in raw_environment.split(b'\0'):
                if entry:
                    key, separator, _ = entry.partition(b'=')
                    need(separator and key)
                    keys.add(key.decode('ascii'))
            need(process(pid) == item)
        finally:
            os.close(environment_fd)
        if SECRET_KEYS.intersection(keys) or pid == os.getpid():
            targets.append(item)
        if pid == 1:
            break
        pid = item['parent']; need(pid > 0)
    else:
        need(False)
    marker = ctypes.create_string_buffer(b'fixed-private-uid-fixture-canary')
    private_file = root / 'private/credential-canary'; write_new(private_file, marker.raw)
    fd = os.open(private_file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        write_new(root / 'request.json', canonical({'targets': targets, 'ownerPid': os.getpid(), 'ownerFd': fd,
                  'privateFile': str(private_file), 'markerAddress': ctypes.addressof(marker)}), 0o444)
        row = run_role(root, 'probe')
        need(row['body']['allAccessRefused'] is True and row['body']['targetIdentitiesStable'] is True and not identity_actors())
        report = {'kind': 'ACTUAL_DEDICATED_UID_ISOLATION_COMPONENT_ONLY', 'run': state['run'], 'source': state['sourceSha'],
                  'hooksSettledBeforeTokenStep': True, 'actualTokenEnvironmentPresent': True,
                  'credentialBearingAncestorTargets': len(targets), 'result': row,
                  'nodeVendorControls': json.loads(secure_read(root / 'private/node-vendor-controls.json', 65536)),
                  'allocationControls': json.loads(secure_read(root / 'private/allocation-controls.json', 65536)),
                  'nativeRootFailureControl': hooks_packet['rows'][0],
                  'rootRoleClosures': [json.loads(secure_read(root / ('private/' + operation + '.role-closed.json'), 65536))
                                       for operation in ('allocation', 'fault', 'git', 'hook', 'probe')],
                  'nativeSixOperationJoinVerified': False, 'nativeApiContextIssued': False,
                  'semanticParentVerified': False, 'normalNoDbVerified': False, 'releaseAuthorized': False}
        write_new(root / 'private/component.json', canonical(report))
    finally:
        os.close(fd)


def settle(root):
    # Every role settles its own actual root/UID closure before its live owner
    # exits. Cleanup cannot reconstruct that authority from JSON or argv.
    require_identity_free()
    state = load_state()[1]
    for path in (root / 'private').glob('*.role-start.json'):
        operation = path.name.removesuffix('.role-start.json')
        need(operation in ('allocation', 'fault', 'git', 'hook', 'probe'))
        started = json.loads(secure_read(path, 65536))
        closed = json.loads(secure_read(root / ('private/' + operation + '.role-closed.json'), 65536))
        need(started['run'] == closed['run'] == root.name and started['source'] == closed['source'] == state['sourceSha']
             and started['operation'] == closed['operation'] == operation and started['owner'] == closed['owner']
             and closed['rootFamiliesClosed'] is True
             and closed['cleanupKnown'] is True and len(closed['actualHeldIdentities']) <= 128)
    require_identity_free()
    return True


def publish(state, value):
    directory = Path('/home/runner/work/_temp/aihr-native-uid-isolation')
    before = directory.lstat()
    need(directory.resolve() == directory and stat.S_ISDIR(before.st_mode)
         and before.st_uid == state['runner'] and stat.S_IMODE(before.st_mode) == 0o700)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        held = os.fstat(fd); need((held.st_dev, held.st_ino) == (before.st_dev, before.st_ino))
        raw = canonical(value); need(len(raw) <= 65536)
        output = os.open('uid-isolation-component.json', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            need(os.write(output, raw) == len(raw))
            os.fsync(output)
            os.fchown(output, state['runner'], state['runnerGid'])
            os.lseek(output, 0, os.SEEK_SET)
            need(os.read(output, len(raw) + 1) == raw)
            info = os.fstat(output)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == len(raw)
                 and info.st_uid == state['runner'] and stat.S_IMODE(info.st_mode) == 0o600)
        finally:
            os.close(output)
        after = directory.lstat(); need((after.st_dev, after.st_ino) == (before.st_dev, before.st_ino))
    finally:
        os.close(fd)


def finish(root, state):
    need(os.geteuid() == 0 and int(os.environ['SUDO_UID']) == state['runner'] and not SECRET_KEYS.intersection(os.environ))
    # This prefix exists before any cleanup. It is retained privately even when
    # cleanup/publication fail; a missing public artifact can never imply success.
    completed = (root / 'private/component.json').exists()
    write_new(root / 'private/failure-prefix.json', canonical({'kind': 'UID_COMPONENT_PRE_CLEANUP_PREFIX',
              'componentWritten': completed, 'cleanupKnown': False, 'releaseAuthorized': False}))
    clean = settle(root)
    user_receipt = root / 'private/user-created.json'
    group_receipt = root / 'private/group-created.json'
    try:
        user = pwd.getpwuid(UID)
    except KeyError:
        user = None
    if user is not None:
        need(json.loads(secure_read(user_receipt, 65536)) == {'name': ACCOUNT, 'uid': UID, 'gid': GID}
             and user.pw_name == ACCOUNT and user.pw_gid == GID and not identity_actors())
        subprocess.run(['/usr/sbin/userdel', ACCOUNT], env=SAFE, check=True, timeout=5)
    try:
        group = grp.getgrgid(GID)
    except KeyError:
        group = None
    if group is not None:
        need(json.loads(secure_read(group_receipt, 65536)) == {'name': ACCOUNT, 'gid': GID}
             and group.gr_name == ACCOUNT and not group.gr_mem and not identity_actors())
        subprocess.run(['/usr/sbin/groupdel', ACCOUNT], env=SAFE, check=True, timeout=5)
    for lookup, identity in ((pwd.getpwuid, UID), (grp.getgrgid, GID)):
        try:
            lookup(identity)
        except KeyError:
            continue
        need(False)
    need(clean and not identity_actors())
    report = json.loads(secure_read(root / 'private/component.json', 65536)) if completed else {
        'kind': 'UID_ISOLATION_COMPONENT_UNAVAILABLE', 'source': state['sourceSha'],
        'nativeSixOperationJoinVerified': False, 'nativeApiContextIssued': False,
        'semanticParentVerified': False, 'normalNoDbVerified': False, 'releaseAuthorized': False}
    if not completed:
        report['partialDiagnostics'] = partial_component_diagnostics(root, state)
    report.update(complete=completed, ownedAccountRemoved=True, uidActorsRemaining=0, gidActorsRemaining=0, rootFamiliesClosed=True,
                  privateFailurePrefixRetained=True, rootPrivateSourceRetained=True)
    publish(state, report)
    need(completed)


def main():
    if sys.argv[1:] in (['--uid-child'], ['--uid-escape']):
        need(Path(__file__).resolve() == root_for_run() / 'fixture.py')
        restricted_status()
        if sys.argv[1:] == ['--uid-escape']:
            reader, writer = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(reader)
                os.setsid()
                need(os.write(writer, b'A') == 1)
                os.close(writer)
                while True:
                    signal.pause()
            os.close(writer)
            need(os.read(reader, 1) == b'A')
            os.close(reader)
        return
    need(sys.argv[1:] and sys.argv[1] in ('prepare', 'allocate', 'hooks', 'custody', 'finish', '--supervise', '--restricted', '--foreign-gid', '--root-fault'))
    if sys.argv[1:] == ['prepare']:
        prepare(); return
    root, state = load_state()
    if sys.argv[1:] == ['allocate']:
        allocate(root, state)
    elif sys.argv[1:] == ['--root-fault']:
        root_fault(root)
    elif len(sys.argv) == 3 and sys.argv[1] == '--foreign-gid':
        need(os.geteuid() == 0 and sys.argv[2] in ('primary', 'supplementary') and not SECRET_KEYS.intersection(os.environ))
        if sys.argv[2] == 'primary':
            os.setgroups([]); os.setresgid(GID, GID, GID)
        else:
            os.setgroups([GID])
        write_new(root / ('private/foreign-gid-' + sys.argv[2] + '.json'), canonical(process(os.getpid())))
        while True:
            signal.pause()
    elif sys.argv[1:] == ['hooks']:
        hooks(root, state)
    elif sys.argv[1:] == ['custody']:
        custody(root, state)
    elif sys.argv[1:] == ['finish']:
        finish(root, state)
    elif len(sys.argv) == 3 and sys.argv[1] == '--supervise':
        supervise(root, state, sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == '--restricted':
        restricted(root, state, sys.argv[2])
    else:
        need(False)


# Immutable source symbols only. This is failure-location data, never a cause
# assertion, trace rendering, exception message, executable source or authority.
FAILURE_FUNCTIONS = frozenset(('<dictcomp>', '<genexpr>', '<lambda>', '<listcomp>', '<module>', '<setcomp>', 'Capabilities', 'Header', 'Iovec', 'RootFamily', '__init__', 'allocate', 'allocation_controls', 'bind', 'bootstrap_read', 'canonical', 'capture', 'child_source_locations', 'close', 'copy_node', 'custody', 'digest', 'exited', 'failure_locations', 'finish', 'hooks', 'identity_actors', 'kernel', 'load_state', 'location_fields', 'main', 'need', 'node_budget', 'node_identity', 'node_is_vendor', 'partial_component_diagnostics', 'prepare', 'probe', 'process', 'process_shape', 'protect_vendor_node', 'publish', 'read_optional', 'refused', 'require_identity_free', 'restrict', 'restricted', 'restricted_status', 'root_fault', 'root_for_run', 'run_role', 'secure_read', 'settle', 'spawn', 'supervise', 'uid_actors', 'value_refused', 'wait', 'write_new'))
FAILURE_BUILTINS = (ValueError, OSError, FileNotFoundError, ProcessLookupError,
                    PermissionError, TimeoutError, KeyError, TypeError, AssertionError,
                    RuntimeError, OverflowError, MemoryError, RecursionError, ImportError,
                    ModuleNotFoundError, AttributeError, UnicodeError, UnicodeDecodeError,
                    UnicodeEncodeError, ZeroDivisionError, IndexError, SystemExit,
                    KeyboardInterrupt, EOFError, InterruptedError, BrokenPipeError,
                    IsADirectoryError, NotADirectoryError, FileExistsError)


def failure_locations(error):
    frames = []
    trace = error.__traceback__
    walked = 0
    while trace is not None and walked < 64 and len(frames) < 8:
        code = trace.tb_frame.f_code
        if code.co_filename == __file__ and code.co_name in FAILURE_FUNCTIONS and 1 <= trace.tb_lineno <= 4096:
            frames.append({'function': code.co_name, 'line': trace.tb_lineno})
        trace = trace.tb_next
        walked += 1
    value = {'frames': frames}
    if type(error) in FAILURE_BUILTINS:
        value['exception'] = type(error).__name__
    raw = canonical(value)
    if len(raw) <= 1024:
        sys.stderr.write('Native UID failure locations ' + raw.decode('ascii'))


if __name__ == '__main__':
    try:
        main()
    except BaseException as failure:
        if os.geteuid() == 0 and sys.argv[1:2] in (['allocate'], ['hooks'], ['custody'], ['finish']):
            try:
                root, state = load_state()
                stage = sys.argv[1]
                write_new(root / ('private/' + stage + '-failure.json'), canonical({'stage': stage, 'reason': 'refused',
                          'cleanupKnown': False, 'releaseAuthorized': False}))
                if stage == 'finish':
                    publish(state, {'kind': 'UID_ISOLATION_COMPONENT_UNAVAILABLE', 'source': state['sourceSha'],
                            'complete': False, 'cleanupKnown': False, 'nativeSixOperationJoinVerified': False,
                            'nativeApiContextIssued': False, 'semanticParentVerified': False,
                            'normalNoDbVerified': False, 'releaseAuthorized': False})
            except BaseException:
                pass
        try:
            failure_locations(failure)
        except BaseException:
            pass
        sys.stderr.write('Native UID isolation component refused\n')
        raise SystemExit(1)
