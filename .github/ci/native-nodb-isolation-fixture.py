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
            'gids': [int(part) for part in status['Gid'].split()]}


def uid_actors():
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            item = process(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        if UID in item['uids']:
            found.append(item)
    return found


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
    need(operation in ('git', 'hook', 'probe') and os.geteuid() == 0 and not SECRET_KEYS.intersection(os.environ))
    K = kernel(root)
    output = root / ('private/' + operation + '.stdout')
    error = root / ('private/' + operation + '.stderr')
    with output.open('xb') as out, error.open('xb') as err:
        saved = (os.dup(1), os.dup(2))
        try:
            os.dup2(out.fileno(), 1)
            os.dup2(err.fileno(), 2)
            result = K.supervise(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--restricted', operation],
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


def run_role(root, operation):
    need(not uid_actors())
    state = json.loads(secure_read(root / 'private/state.json', 65536))
    elapsed = time.monotonic_ns() - int(state['anchorNs'])
    # Next complete role, one actor settlement, two account commands and the
    # unchanged artifact tail must all fit the same first-step job envelope.
    need(0 <= elapsed and elapsed + (16 + 6 + 10 + 120) * 10**9 < 1800 * 10**9)
    started = time.monotonic()
    child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--supervise', operation],
                             env={**SAFE, 'GITHUB_RUN_ID': os.environ['GITHUB_RUN_ID']},
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True, close_fds=True)
    descriptor = os.pidfd_open(child.pid)
    write_new(root / ('private/' + operation + '.supervisor.json'), canonical(process(child.pid)))
    try:
        try:
            output, error = child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
            output, error = child.communicate(timeout=max(.001, started + 16 - time.monotonic()))
        need(time.monotonic() <= started + 16 and child.returncode == 0 and not error
             and len(output) <= 65536 and not uid_actors())
        return json.loads(output)
    finally:
        os.close(descriptor)


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
    need(not uid_actors())
    BASE.mkdir(mode=0o755, exist_ok=True)
    need(BASE.lstat().st_uid == 0 and stat.S_IMODE(BASE.lstat().st_mode) == 0o755 and BASE.resolve() == BASE)
    root = root_for_run(); root.mkdir(mode=0o755)
    (root / 'private').mkdir(mode=0o700)
    code = {}
    for name, relative in CODE.items():
        raw = bootstrap_read(source / relative, 1024**2, runner)
        write_new(root / name, raw, 0o444); code[name] = {'bytes': len(raw), 'sha256': digest(raw)}
    node = Path('/opt/hostedtoolcache/node/22.23.3/x64/bin/node')
    raw = bootstrap_read(node, 256 * 1024**2, runner); need(raw.startswith(b'\x7fELF'))
    write_new(root / 'node', raw, 0o555)
    state = {'run': os.environ['GITHUB_RUN_ID'], 'sourceSha': os.environ['GITHUB_SHA'], 'source': str(source),
             'runner': runner, 'runnerGid': int(os.environ['SUDO_GID']), 'uid': UID, 'gid': GID,
             'code': code, 'nodeSha256': digest(raw), 'anchorNs': anchor['startNs'], 'bootId': anchor['bootId'],
             'startedNs': str(time.monotonic_ns())}
    write_new(root / 'private/state.json', canonical(state))
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
    rows = [run_role(root, 'git'), run_role(root, 'hook')]
    need(not uid_actors())
    write_new(root / 'private/hooks-closed.json', canonical({'rows': rows, 'settled': True}))


def custody(root, state):
    need(os.geteuid() == 0 and int(os.environ['SUDO_UID']) == state['runner']
         and os.environ.get('GITHUB_SHA') == state['sourceSha'] and os.environ.get('GH_TOKEN'))
    need(json.loads(secure_read(root / 'private/hooks-closed.json', 65536))['settled'] is True and not uid_actors())
    targets = []; pid = os.getpid()
    for _ in range(32):
        item = process(pid); need(UID not in item['uids'] and GID not in item['gids'])
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
        need(row['body']['allAccessRefused'] is True and row['body']['targetIdentitiesStable'] is True and not uid_actors())
        report = {'kind': 'ACTUAL_DEDICATED_UID_ISOLATION_COMPONENT_ONLY', 'run': state['run'], 'source': state['sourceSha'],
                  'hooksSettledBeforeTokenStep': True, 'actualTokenEnvironmentPresent': True,
                  'credentialBearingAncestorTargets': len(targets), 'result': row,
                  'nativeSixOperationJoinVerified': False, 'nativeApiContextIssued': False,
                  'semanticParentVerified': False, 'normalNoDbVerified': False, 'releaseAuthorized': False}
        write_new(root / 'private/component.json', canonical(report))
    finally:
        os.close(fd)


def terminate_bound(item, argv=None):
    try:
        before = process(item['pid'])
    except (FileNotFoundError, ProcessLookupError):
        return
    need(before['start'] == item['start'])
    if argv is not None:
        actual = Path('/proc/%s/cmdline' % item['pid']).read_bytes()
        need(actual == b'\0'.join(part.encode() for part in argv) + b'\0')
    descriptor = os.pidfd_open(item['pid'])
    try:
        need(process(item['pid']) == before)
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except ProcessLookupError:
        pass
    finally:
        os.close(descriptor)


def settle(root):
    # Account allocation is exclusive and root-recorded before any test exists.
    # Cleanup uses actual current identities plus pidfds, never kill(pid) or a
    # caller's claimed receipt/argv. Uncertain or reused identities refuse.
    deadline = time.monotonic() + 6
    for operation in ('git', 'hook', 'probe'):
        lease = root / ('private/' + operation + '.supervisor.json')
        if lease.exists():
            item = json.loads(secure_read(lease, 65536))
            terminate_bound(item, ['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--supervise', operation])
        ledger = root / ('private/' + operation + '.jsonl')
        if ledger.exists():
            raw = secure_read(ledger, 131072)
            for line in raw.splitlines():
                row = json.loads(line)
                if row.get('kind') == 'session-admitted':
                    item = {'pid': row['pid'], 'start': row['start']}
                    terminate_bound(item, ['/usr/bin/python3', '-I', '-B', str(root / 'fixture.py'), '--supervise', operation])
    while True:
        actors = uid_actors()
        if not actors:
            return True
        need(time.monotonic() < deadline)
        for actor in actors:
            terminate_bound(actor)
        time.sleep(.01)


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
             and user.pw_name == ACCOUNT and user.pw_gid == GID and not uid_actors())
        subprocess.run(['/usr/sbin/userdel', ACCOUNT], env=SAFE, check=True, timeout=5)
    try:
        group = grp.getgrgid(GID)
    except KeyError:
        group = None
    if group is not None:
        need(json.loads(secure_read(group_receipt, 65536)) == {'name': ACCOUNT, 'gid': GID}
             and group.gr_name == ACCOUNT and not group.gr_mem)
        subprocess.run(['/usr/sbin/groupdel', ACCOUNT], env=SAFE, check=True, timeout=5)
    for lookup, identity in ((pwd.getpwuid, UID), (grp.getgrgid, GID)):
        try:
            lookup(identity)
        except KeyError:
            continue
        need(False)
    need(clean and not uid_actors())
    report = json.loads(secure_read(root / 'private/component.json', 65536)) if completed else {
        'kind': 'UID_ISOLATION_COMPONENT_UNAVAILABLE', 'source': state['sourceSha'],
        'nativeSixOperationJoinVerified': False, 'nativeApiContextIssued': False,
        'semanticParentVerified': False, 'normalNoDbVerified': False, 'releaseAuthorized': False}
    report.update(complete=completed, ownedAccountRemoved=True, uidActorsRemaining=0,
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
    need(sys.argv[1:] and sys.argv[1] in ('prepare', 'hooks', 'custody', 'finish', '--supervise', '--restricted'))
    if sys.argv[1:] == ['prepare']:
        prepare(); return
    root, state = load_state()
    if sys.argv[1:] == ['hooks']:
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


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        if os.geteuid() == 0 and sys.argv[1:2] in (['hooks'], ['custody'], ['finish']):
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
        sys.stderr.write('Native UID isolation component refused\n')
        raise SystemExit(1)
