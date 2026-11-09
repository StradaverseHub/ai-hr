"""First-attempt hosted diagnostic. The ordinary whole compiler gate stays separate."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import select
import signal
import stat
import subprocess
import sys
import time


SOURCE = '6a71ae8b651fafdb845d92a47568ac3c5382322f'
SOURCE_TREE = '853f28b988921a0f3b41035e2bb2bc4d653b75d1'
SOURCE_BRANCH = 'codex/architecture-145e-compiler-test-fix-20261110'
BRANCH = 'codex/compiler-6a71ae8b-whole-12800-platform-swap-20261110'
REPO = 'StradaverseHub/ai-hr'
GIB = 1024 ** 3
LIMIT = 13 * GIB
SWAP = 2560 * 1024 ** 2
PLATFORM_SWAP = Path('/swapfile')
PLATFORM_SWAP_BYTES = 3 * GIB
PLATFORM_SWAP_USABLE = PLATFORM_SWAP_BYTES - 4096
SWAP_HOST_RESERVE = 512 * 1024 ** 2
WORK_NS = 720 * 10 ** 9
ROOT = Path('/sys/fs/cgroup')
DIRECTORY = 'compiler-12800-platform-swap'
BASE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
CG_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
GENERATED = {
    'next-env.d.ts': '1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b',
    '.next/types/cache-life.d.ts': '87384ad5954f65285fc17ba8ed39d010a8ef111edba114e493b0431d677e5faa',
    '.next/types/root-params.d.ts': 'f3387dd7800eec3c34273f7a8efad13e864598c7e8f788d321e407390989bb59',
    '.next/types/routes.d.ts': '52aeb68060ebdc801316e0a6880c848ee0fbc87542c452b65d963c1dafbb7432',
    '.next/types/validator.ts': '860b54f3461834c458201cb58dbf3915fcafc89647b9a76abbe8d56242968124',
}


class Refusal(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def integer(raw):
    require(re.fullmatch(r'(?:0|[1-9][0-9]{0,18})', raw), 'invalid-integer')
    return int(raw)


def read_at(directory, name, maximum=65536):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    with os.fdopen(fd, 'rb') as stream:
        raw = stream.read(maximum + 1)
    require(len(raw) <= maximum, 'read-bound')
    return raw.decode('ascii', errors='strict').strip()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def pairs(raw):
    rows = [line.split() for line in raw.splitlines()]
    require(all(len(row) == 2 for row in rows), 'kernel-fields')
    result = dict(rows)
    require(len(result) == len(rows), 'kernel-duplicate')
    return result


def command(argv):
    deadline = time.monotonic() + 3
    child = subprocess.Popen(argv, env=BASE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL)
    try:
        out = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0 and select.select([child.stdout], [], [], remaining)[0], 'command-deadline')
            data = os.read(child.stdout.fileno(), min(8192, 65537 - len(out)))
            if not data:
                status = child.wait(timeout=max(0, deadline - time.monotonic()))
                return status, bytes(out)
            out.extend(data)
            require(len(out) <= 65536, 'command-output')
    finally:
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired as error:
                raise Refusal('stock-command-settlement-unknown') from error


def environment():
    e = os.environ
    controller = e.get('GITHUB_WORKFLOW_SHA', '')
    ref = 'refs/heads/' + BRANCH
    required = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                'GITHUB_REPOSITORY': REPO, 'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_REF': ref,
                'GITHUB_WORKFLOW': 'alpha-focused-checks', 'GITHUB_JOB': 'compiler-memory-feasibility',
                'GITHUB_WORKFLOW_REF': REPO + '/.github/workflows/alpha-focused-checks.yml@' + ref,
                'GITHUB_SHA': controller, 'AIHR_CI_CONTROL_HEAD': controller, 'GITHUB_RUN_ATTEMPT': '1',
                'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
                'STAGING_ENABLED': 'false', 'PRODUCTION_ENABLED': 'false'}
    require(re.fullmatch(r'[a-f0-9]{40}', controller) and all(e.get(k) == v for k, v in required.items()), 'hosted-identity')
    run = e.get('GITHUB_RUN_ID', '')
    require(re.fullmatch(r'[1-9][0-9]{0,15}', run) and int(run) <= 2 ** 53 - 1, 'run-identity')
    workspace = Path(e['GITHUB_WORKSPACE'])
    temporary = Path(e['RUNNER_TEMP'])
    require(workspace.is_absolute() and workspace.resolve(strict=True) == workspace
            and temporary.is_absolute() and temporary.resolve(strict=True) == temporary, 'workspace-identity')
    path = temporary / '_github_workflow' / 'event.json'
    require(path == Path(e['GITHUB_EVENT_PATH']) and path.resolve(strict=True) == path, 'event-path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        st = os.fstat(stream.fileno())
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1
                and not st.st_mode & 0o022 and 0 < st.st_size <= 65536, 'event-file')
        raw = stream.read(65537)
        require(len(raw) == st.st_size and identity(st) == identity(os.stat(path, follow_symlinks=False))
                == identity(os.fstat(stream.fileno())), 'event-changed')
    event = json.loads(raw)
    repo = event.get('repository', {})
    expected = {'candidate_ref': SOURCE_BRANCH, 'expected_sha': SOURCE, 'selected_tests': '[]',
                'architecture_browser_development_preflight': 'false',
                'measured_browser_course': 'off', 'measured_browser_preflight_run': '', 'employee_ascii_qualification': 'off',
                'qualify_restricted_port_prerequisites': 'false', 'profile_database': 'false', 'duration_order': 'false',
                'run_typecheck': 'true', 'run_native_typecheck': 'false', 'run_native_swift_models': 'false',
                'run_native_bundle': 'false', 'run_build': 'false', 'model_eval': '', 'eval_budget_usd': '20',
                'eval_allowed_providers': ''}
    inputs = {'model_eval': '', 'eval_allowed_providers': '', 'measured_browser_preflight_run': '', **event['inputs']}
    require(inputs == expected and event.get('ref') in (BRANCH, ref) and repo.get('id') == 1333414856
            and repo.get('full_name') == REPO and repo.get('default_branch') == 'main'
            and repo.get('private') is False and repo.get('fork') is False, 'dispatch-refused')
    for directory, sha in ((workspace / 'automation', controller), (workspace / 'source', SOURCE)):
        require(directory.resolve(strict=True) == directory, 'checkout-path')
        require(command(['/usr/bin/git', '-C', str(directory), 'rev-parse', 'HEAD']) == (0, (sha + '\n').encode('ascii'))
                and command(['/usr/bin/git', '-C', str(directory), 'status', '--porcelain']) == (0, b''), 'checkout-source')
    require(command(['/usr/bin/git', '-C', str(workspace / 'source'), 'rev-parse', 'HEAD^{tree}'])
            == (0, (SOURCE_TREE + '\n').encode('ascii')), 'checkout-tree')
    require(Path(__file__).resolve() == workspace / 'automation/.github/ci/compiler-memory-feasibility.py'
            and os.getuid() > 0, 'controller-path')
    return workspace, temporary, controller, run


def ram():
    raw = read_at(None, '/proc/meminfo')
    values = {}
    for key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
        found = re.findall(r'^' + key + r':\s+([0-9]+) kB$', raw, re.M)
        require(len(found) == 1, 'host-memory')
        values[key] = int(found[0]) * 1024
    require(15 * GIB <= values['MemTotal'] <= 17 * GIB, 'host-size')
    return values


def disk_available(*paths):
    return min(row.f_bavail * row.f_frsize for row in map(os.statvfs, paths))


def platform_swap(expected=None, *, initial=False):
    before = PLATFORM_SWAP.lstat()
    require(PLATFORM_SWAP.resolve(strict=True) == PLATFORM_SWAP and stat.S_ISREG(before.st_mode)
            and before.st_uid == 0 and before.st_nlink == 1 and not before.st_mode & 0o077
            and before.st_size == PLATFORM_SWAP_BYTES, 'platform-swap-file')
    birth = list(identity(before))
    rows = read_at(None, '/proc/swaps', 16384).splitlines()
    require(len(rows) == 2 and rows[0].split() == ['Filename', 'Type', 'Size', 'Used', 'Priority'], 'platform-swap-inventory')
    fields = rows[1].split()
    require(len(fields) == 5 and fields[:3] == [str(PLATFORM_SWAP), 'file', str(PLATFORM_SWAP_USABLE // 1024)]
            and fields[4] == '-1', 'platform-swap-inventory')
    require(birth == list(identity(PLATFORM_SWAP.lstat())) and (expected is None or birth == expected), 'platform-swap-identity')
    used = integer(fields[3]) * 1024
    require(0 <= used <= PLATFORM_SWAP_USABLE - SWAP_HOST_RESERVE, 'host-swap-headroom')
    if initial:
        require(used == 0, 'platform-swap-preused')
    return birth


@contextlib.contextmanager
def owner_lock(directory):
    info = directory.lstat()
    require(directory.resolve(strict=True) == directory and stat.S_ISDIR(info.st_mode)
            and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'swap-directory')
    path = directory / 'owner.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
    try:
        require(private_file_birth(os.fstat(fd)) == private_file_birth(path.lstat()), 'swap-lease')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def private_file_birth(info):
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600, 'swap-inode')
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid]


def own_json(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as handle:
        json.dump(data, handle, separators=(',', ':'))
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())


def read_intent(path, maximum=1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        private_file_birth(before)
        require(0 < before.st_size <= maximum, 'swap-intent')
        raw = handle.read(maximum + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(handle.fileno()))
                == identity(path.lstat()), 'swap-intent')
    return json.loads(raw)


def run_identity(controller, run_id):
    return {'candidate': SOURCE, 'controller': controller, 'run': run_id, 'attempt': 1}


def settle_manager(directory, unit, controller, run_id):
    require(show(unit)['LoadState'] == 'not-found' and not os.path.lexists(ROOT / 'system.slice' / unit), 'swap-service-live')
    require(not os.path.lexists(directory / 'manager-start.pending'), 'swap-manager-unsettled')
    manager = directory / 'manager-birth.json'
    if os.path.lexists(manager):
        recorded = read_intent(manager)
        pid, birth = recorded.pop('pid'), recorded.pop('birth')
        require(recorded == run_identity(controller, run_id) and type(pid) is int and pid > 1
                and type(birth) is int and birth > 0, 'swap-manager-identity')
        try:
            active_birth = process_birth(pid)
        except FileNotFoundError:
            active_birth = None
        require(active_birth != birth, 'swap-manager-live')
    return True


def oom_events(directory, name):
    events = pairs(read_at(directory, name))
    require({'oom', 'oom_kill'} <= events.keys(), 'oom-counters')
    return {key: integer(events[key]) for key in ('oom', 'oom_kill', 'oom_group_kill') if key in events}


def mount_id(fd):
    values = re.findall(r'^mnt_id:[ \t]+([1-9][0-9]*)$', read_at(None, f'/proc/self/fdinfo/{fd}', 4096), re.M)
    require(len(values) == 1, 'cgroup-mount-id')
    return values[0]


def group_birth(descriptors):
    births = [(info.st_dev, info.st_ino) for info in map(os.fstat, descriptors)]
    return hashlib.sha256(json.dumps(births, separators=(',', ':')).encode('ascii')).hexdigest()


@contextlib.contextmanager
def group(unit, service_birth=None):
    with contextlib.ExitStack() as held:
        mount = read_at(None, '/proc/self/mountinfo', 131072)
        rows = [line.split() for line in mount.splitlines() if len(line.split()) > 6]
        if service_birth is None:
            relevant = [row for row in rows if row[4] == str(ROOT) or row[4].startswith(str(ROOT) + '/')]
            require(len(relevant) == 1 and relevant[0][3:5] == ['/', str(ROOT)]
                    and relevant[0][relevant[0].index('-') + 1] == 'cgroup2', 'cgroup-mount')
        descriptors = []
        names = (str(ROOT), 'system.slice', unit)
        for name in names:
            fd = os.open(name, CG_FLAGS, dir_fd=descriptors[-1] if descriptors else None)
            held.callback(os.close, fd)
            info = os.fstat(fd)
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'cgroup-ownership')
            if service_birth is None:
                require(f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}' == relevant[0][2], 'cgroup-ownership')
            descriptors.append(fd)
        if service_birth is not None:
            require(group_birth(descriptors) == service_birth, 'service-cgroup-birth')
            # systemd can stack and split mount views. Judge only the actual
            # descriptor mounts against the parent's sealed physical directories.
            current = ROOT
            for index, fd in enumerate(descriptors):
                if index:
                    current /= names[index]
                selected = mount_id(fd)
                view = [row for row in rows if row[0] == selected]
                require(len(view) == 1, 'service-cgroup-view')
                row = view[0]
                info = os.fstat(fd)
                point = Path(row[4])
                require(point.is_relative_to(ROOT) and current.is_relative_to(point)
                        and row[row.index('-') + 1] == 'cgroup2'
                        and row[2] == f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}', 'service-cgroup-view')
                options = row[5].split(',')
                require('ro' in options and 'rw' not in options
                        and os.fstatvfs(fd).f_flag & os.ST_RDONLY, 'service-cgroup-cover')
        yield descriptors


def sample(descriptors, *, initial=False):
    host = ram()
    target = descriptors[-1]
    require(read_at(target, 'memory.max') == str(LIMIT) and read_at(target, 'memory.swap.max') == str(SWAP)
            and read_at(target, 'memory.oom.group') == '1', 'cgroup-cap-readback')
    used = integer(read_at(target, 'memory.swap.current'))
    peak = integer(read_at(target, 'memory.swap.peak'))
    swap_events = pairs(read_at(target, 'memory.swap.events'))
    require({'max', 'fail'} <= set(swap_events) and 0 <= used <= peak <= SWAP
            and host['SwapTotal'] == PLATFORM_SWAP_USABLE and SWAP_HOST_RESERVE <= host['SwapFree'] <= PLATFORM_SWAP_USABLE, 'cgroup-swap')
    if initial:
        require(used == peak == 0 and host['SwapFree'] == PLATFORM_SWAP_USABLE, 'cgroup-swap')
    pressure = {}
    for category in ('some', 'full'):
        rows = re.findall(r'^' + category + r' avg10=[0-9.]+ avg60=[0-9.]+ avg300=[0-9.]+ total=([0-9]+)$',
                          read_at(target, 'memory.pressure'), re.M)
        require(len(rows) == 1, 'cgroup-pressure')
        pressure[category] = integer(rows[0])
    require(pressure['full'] <= pressure['some'], 'cgroup-pressure')
    require(integer(swap_events['fail']) == 0, 'cgroup-swap-failed')
    ancestors = []
    required = 14 * GIB if initial else GIB
    for index, fd in enumerate(descriptors[:-1]):
        try:
            maximum = read_at(fd, 'memory.max')
        except FileNotFoundError:
            require(index == 0, 'ancestor-memory-controller')
            ancestors.append({'maximum': None, 'remaining': None, 'swapRemaining': None, 'oom': None})
            continue
        remaining = None if maximum == 'max' else integer(maximum) - integer(read_at(fd, 'memory.current'))
        require(remaining is None or remaining >= required, 'ancestor-headroom')
        swap_maximum = read_at(fd, 'memory.swap.max')
        swap_remaining = None if swap_maximum == 'max' else integer(swap_maximum) - integer(read_at(fd, 'memory.swap.current'))
        require(swap_remaining is None or swap_remaining >= (SWAP if initial else 0), 'ancestor-swap-headroom')
        ancestors.append({'maximum': None if maximum == 'max' else integer(maximum), 'remaining': remaining,
                          'swapRemaining': swap_remaining,
                          'oom': oom_events(fd, 'memory.events.local')})
    require(host['MemAvailable'] >= required, 'host-headroom')
    return {'memTotal': host['MemTotal'], 'memAvailable': host['MemAvailable'], 'ancestors': ancestors,
            'memoryMax': LIMIT, 'memorySwapMax': SWAP, 'oomGroup': 1,
            'swapCurrent': used, 'swapPeak': peak, 'hostSwapFree': host['SwapFree'],
            'swapEvents': {key: integer(value) for key, value in swap_events.items()},
            'pressureMicros': pressure,
            'current': integer(read_at(target, 'memory.current')), 'peak': integer(read_at(target, 'memory.peak')),
            'oom': oom_events(target, 'memory.events.local'),
            'hostOomKill': integer(pairs(read_at(None, '/proc/vmstat'))['oom_kill'])}


def process_identity(pid, unit):
    require(read_at(None, f'/proc/{pid}/cgroup') == '0::/system.slice/' + unit
            and Path(f'/proc/{pid}/exe').resolve(strict=True) == Path('/usr/bin/python3').resolve(strict=True),
            'process-cgroup-or-executable')
    status = read_at(None, f'/proc/{pid}/status')
    require(re.search(r'^NoNewPrivs:\s+1$', status, re.M)
            and re.search(r'^Uid:\s+' + (r'\s+'.join([str(os.getuid())] * 4)) + '$', status, re.M)
            and len(os.sched_getaffinity(pid)) == 4, 'process-identity')
    birth = process_birth(pid)
    require(birth is not None, 'process-not-live')
    return birth


def process_birth(pid):
    raw = read_at(None, f'/proc/{pid}/stat')
    fields = raw.rsplit(') ', 1)[-1].split()
    require(raw.startswith(f'{pid} (') and len(fields) >= 20, 'process-birth')
    return None if fields[0] in ('Z', 'X') else integer(fields[19])


def show(unit):
    props = ('LoadState,ActiveState,MainPID,ControlPID,ControlGroup,InvocationID,Description,Transient,'
             'KillMode,Delegate,NoNewPrivileges,PrivateNetwork')
    status, raw = command(['/usr/bin/systemctl', '--system', 'show', '--all', '--no-pager', '--property=' + props, unit])
    rows = [line.split('=', 1) for line in raw.decode('ascii').splitlines()]
    require(all(len(row) == 2 for row in rows), 'systemd-properties')
    values = dict(rows)
    require(len(values) == len(rows) and (values.get('LoadState') == 'not-found'
            or (status == 0 and set(values) == set(props.split(',')))), 'systemd-properties')
    return values


def frame(pipe, deadline, maximum=48):
    raw = bytearray()
    while len(raw) < maximum:
        remaining = (deadline - time.monotonic_ns()) / 10 ** 9
        require(remaining > 0 and select.select([pipe], [], [], remaining)[0], 'protocol-deadline')
        data = os.read(pipe.fileno(), 1)
        require(data and time.monotonic_ns() < deadline, 'protocol-eof-or-late')
        raw.extend(data)
        if data == b'\n':
            return bytes(raw).decode('ascii').strip()
    raise Refusal('protocol-bound')


SERVICE_FAILURES = {
    'identity': {'service-identity', 'process-cgroup-or-executable', 'process-identity', 'process-not-live', 'process-birth', 'core-limit'},
    'grant': {'grant', 'protocol-deadline', 'protocol-eof-or-late', 'protocol-bound', 'invalid-integer'},
    'cgroup': {'cgroup-mount-id', 'cgroup-ownership', 'service-cgroup-view', 'service-cgroup-cover', 'service-cgroup-birth',
               'host-memory', 'host-size', 'host-headroom', 'ancestor-memory-controller', 'ancestor-headroom',
               'cgroup-cap-readback', 'cgroup-swap', 'cgroup-pressure', 'ancestor-swap-headroom',
               'kernel-fields', 'kernel-duplicate', 'oom-counters',
               'invalid-integer', 'read-bound', 'service-launch-frontier'},
    'start': {'service-launch-late'},
    'compiler': {'service-completion-late'},
    'terminal': {'terminal-ack', 'protocol-deadline', 'protocol-eof-or-late', 'protocol-bound'},
}
SERVICE_ERRORS = {'os-denied', 'os-missing', 'os-pipe', 'os-error', 'invalid-data', 'missing-field', 'process-error', 'refused'}


def service_failure(message, allowed):
    matched = re.fullmatch(r'F ([a-z]+) ([a-z-]+)', message)
    if matched is None:
        return None
    phase, reason = matched.groups()
    require(phase in allowed and reason in SERVICE_FAILURES[phase] | SERVICE_ERRORS, 'child-refusal-frame')
    return {'phase': phase, 'reason': reason}


def service(unit, pending):
    phase = 'identity'
    try:
        temporary = Path(os.environ['RUNNER_TEMP'])
        directory = temporary / DIRECTORY
        pnpm = Path(pwd.getpwuid(os.getuid()).pw_dir) / 'setup-pnpm/node_modules/.bin/pnpm'
        require(re.fullmatch(r'aihr-compiler-12800-swap-[1-9][0-9]{0,15}\.service', unit) and os.getuid() > 0
                and temporary.is_absolute() and directory.resolve(strict=True) == directory, 'service-identity')
        pid = os.getpid()
        process_identity(pid, unit)
        # Linux reserves a soft core limit of one byte to suppress pipe recursion.
        # Socket core handlers have different semantics and remain outside this profile.
        require(resource.getrlimit(resource.RLIMIT_CORE) == (1, 1)
                and not read_at(None, '/proc/sys/kernel/core_pattern', 4096).startswith('@'), 'core-limit')
        print(f'R {pid}', flush=True)
        phase = 'grant'
        grant = frame(sys.stdin, pending, maximum=96).split()
        require(len(grant) == 3 and grant[0] == 'G' and re.fullmatch(r'[a-f0-9]{64}', grant[2]), 'grant')
        stop = integer(grant[1])
        phase = 'cgroup'
        with group(unit, service_birth=grant[2]) as descriptors:
            start = sample(descriptors, initial=True)
            require(read_at(descriptors[-1], 'cgroup.procs') == str(pid) and start['current'] < 64 * 1024 ** 2
                    and all(value == 0 for value in start['oom'].values())
                    and 0 < stop - time.monotonic_ns() <= WORK_NS, 'service-launch-frontier')
            phase = 'start'
            with (directory / 'compiler.raw.log').open('xb') as log:
                require(time.monotonic_ns() < stop, 'service-launch-late')
                with subprocess.Popen(['/usr/bin/time', '-v', str(pnpm), 'exec', 'tsc', '--noEmit'],
                                      stdin=subprocess.DEVNULL, stdout=log, stderr=log) as compiler:
                    print('S', flush=True)
                    phase = 'compiler'
                    result = compiler.wait()
            require(time.monotonic_ns() < stop, 'service-completion-late')
            print(f'D {result}', flush=True)
            phase = 'terminal'
            require(frame(sys.stdin, stop + 10 * 10 ** 9) == 'X', 'terminal-ack')
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        if isinstance(error, Refusal):
            reason = str(error) if str(error) in SERVICE_FAILURES[phase] else 'refused'
        elif isinstance(error, OSError):
            reason = {PermissionError: 'os-denied', FileNotFoundError: 'os-missing', BrokenPipeError: 'os-pipe'}.get(type(error), 'os-error')
        else:
            reason = {ValueError: 'invalid-data', UnicodeDecodeError: 'invalid-data', KeyError: 'missing-field'}.get(type(error), 'process-error')
        with contextlib.suppress(BrokenPipeError):
            print(f'F {phase} {reason}', flush=True)
        raise


def owned(row, unit, pid, nonce):
    return (row['LoadState'] == 'loaded' and row['ActiveState'] == 'active' and row['MainPID'] == str(pid)
            and row['ControlPID'] == '0' and row['ControlGroup'] == '/system.slice/' + unit
            and row['Transient'] == 'yes' and row['Description'] == nonce and row['KillMode'] == 'control-group'
            and row['Delegate'] == 'no' and row['NoNewPrivileges'] == row['PrivateNetwork'] == 'yes'
            and re.fullmatch(r'[a-f0-9]{32}', row['InvocationID']) and int(row['InvocationID'], 16) > 0)


def unit_name(run_id):
    return 'aihr-compiler-12800-swap-' + run_id + '.service'


def compiler_files(source):
    require(set((source / '.next/types').iterdir()) == {source / name for name in GENERATED if name.startswith('.next/')}
            and not os.path.lexists(source / '.next/dev'), 'typegen-root-inventory')
    for name, digest in GENERATED.items():
        member = source / name
        require(member.resolve(strict=True) == member and member.is_file() and 0 < member.stat().st_size <= 4 * 1024 ** 2
                and hashlib.sha256(member.read_bytes()).hexdigest() == digest, 'typegen-inputs')


def verify_swap_live(expected, temporary, source):
    platform_swap(expected)
    require(disk_available(temporary, source) >= 2 * GIB, 'compiler-disk-floor')


def accepted_terminal(report, deadline):
    terminal, initial = report.get('terminal'), report.get('initial')
    if not isinstance(terminal, dict) or not isinstance(initial, dict):
        return False
    if not all(type(terminal.get(key)) is int for key in ('memoryMax', 'memorySwapMax', 'swapCurrent', 'swapPeak', 'peak')):
        return False
    events, log = terminal.get('swapEvents'), report.get('compilerLog')
    if not isinstance(events, dict) or not isinstance(log, dict) or set(log) != {'bytes', 'sha256'}:
        return False
    if (type(log['bytes']) is not int or not 0 < log['bytes'] <= 4 * 1024 ** 2
            or not isinstance(log['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', log['sha256'])):
        return False
    return ('reason' not in report and report.get('admitted') is True and report.get('grantSent') is True
            and type(report.get('compilerExit')) is int and report['compilerExit'] == 0
            and type(report.get('managerExit')) is int and report['managerExit'] == 0
            and report.get('zeroObservedOom') is True and report.get('ownedCleanup') == 'settled'
            and report.get('platformSwapVerified') is True and report.get('platformSwapPreserved') is True
            and report.get('generatedTypesVerified') is True and report.get('sourceReverified') is True
            and report.get('v8HeapFatalMarker') is False and report.get('typescriptDiagnosticCount') == 0
            and terminal['memoryMax'] == LIMIT and terminal['memorySwapMax'] == SWAP and 0 < terminal['peak'] <= LIMIT
            and 0 <= terminal['swapCurrent'] <= terminal['swapPeak'] <= SWAP
            and initial.get('oom') == terminal.get('oom') == {'oom': 0, 'oom_kill': 0, 'oom_group_kill': 0}
            and type(events.get('fail')) is int and events['fail'] == 0
            and time.monotonic_ns() < deadline)


def run(workspace, temporary, controller, run_id):
    directory = temporary / DIRECTORY
    directory.mkdir(mode=0o700)
    with owner_lock(directory):
        return run_stock(workspace, temporary, controller, run_id, directory)


def run_stock(workspace, temporary, controller, run_id, directory):
    source = workspace / 'source'
    unit = unit_name(run_id)
    group_path = ROOT / 'system.slice' / unit
    nonce = unit + '-' + os.urandom(16).hex()
    deadline = integer(os.environ['AIHR_COMPILER_FEASIBILITY_T0_NS']) + 1140 * 10 ** 9
    report = {'kind': 'WHOLE_COMPILER_PLATFORM_SWAP_FEASIBILITY_NOT_RELEASE', 'candidateSha': SOURCE, 'candidateTree': SOURCE_TREE,
              'controllerSha': controller, 'residentCapBytes': LIMIT, 'swapCapBytes': SWAP,
              'runId': run_id, 'attempt': 1, 'heapMiB': 12800, 'compilerExit': None, 'admitted': False,
              'grantSent': False,
              'complete': False, 'ownedCleanup': 'not-started', 'platformSwapVerified': False,
              'platformSwapPreserved': False, 'releaseEligible': False}
    wrapper = None
    pidfd = None
    wrapper_pidfd = None
    holder_bound = False
    swap_birth = None
    try:
        require(deadline - time.monotonic_ns() >= WORK_NS + 45 * 10 ** 9, 'insufficient-job-budget')
        report['hostPrelaunch'] = ram()
        require(len(os.sched_getaffinity(0)) == 4 and report['hostPrelaunch']['MemAvailable'] >= 14 * GIB, 'host-prelaunch')
        require(show(unit)['LoadState'] == 'not-found' and not os.path.lexists(group_path), 'pre-existing-unit')
        tools = Path(os.environ['RUNNER_TOOL_CACHE']) / 'node/22.23.3/x64/bin'
        pnpm = Path(os.environ['PNPM_HOME']) / 'pnpm'
        require(pnpm.parent == Path(pwd.getpwuid(os.getuid()).pw_dir) / 'setup-pnpm/node_modules/.bin'
                and pnpm.is_file() and (tools / 'node').is_file(), 'pinned-tool-path')
        require(command([str(tools / 'node'), '--version']) == (0, b'v22.23.3\n')
                and json.loads((source / 'node_modules/typescript/package.json').read_bytes())['version'] == '5.9.3'
                and not os.path.lexists(source / 'tsconfig.tsbuildinfo'), 'cold-compiler-inputs')
        compiler_files(source)
        report['generatedTypesVerified'] = True
        swap_birth = platform_swap(initial=True)
        own_json(directory / 'platform-swap.json', {**run_identity(controller, run_id), 'birth': swap_birth})
        verify_swap_live(swap_birth, temporary, source)
        report['platformSwapVerified'] = True
        report['platformSwapBytes'] = PLATFORM_SWAP_USABLE
        report['hostSwapReserveBytes'] = SWAP_HOST_RESERVE
        report['platformSwapBirthSha256'] = hashlib.sha256(json.dumps(swap_birth).encode('ascii')).hexdigest()
        report['compilerDiskBytes'] = disk_available(temporary, source)
        pending = time.monotonic_ns() + 12 * 10 ** 9
        props = ('User=' + str(os.getuid()), 'Group=' + str(os.getgid()), 'Type=exec', 'MemoryAccounting=yes',
                 'MemoryMax=' + str(LIMIT), 'MemorySwapMax=' + str(SWAP), 'OOMPolicy=kill', 'NoNewPrivileges=yes',
                 'ProtectControlGroups=yes', 'PrivateNetwork=yes', 'LimitCORE=1', 'LimitFSIZE=67108864', 'UMask=0077', 'Delegate=no',
                 'KillMode=control-group', 'TimeoutStopSec=10s', 'RuntimeMaxSec=744s', 'Restart=no',
                 'WorkingDirectory=' + str(source), 'Description=' + nonce)
        settings = {'PATH': f'{tools}:{pnpm.parent}:/usr/bin:/bin', 'HOME': pwd.getpwuid(os.getuid()).pw_dir,
                    'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8', 'TZ': 'Asia/Kuala_Lumpur', 'CI': 'true',
                    'NODE_OPTIONS': '--max-old-space-size=12800', 'RUNNER_TEMP': str(temporary)}
        for name in ('DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'):
            settings[name] = 'postgres://nobody:nothing@127.0.0.1:1/no_database'
        argv = ['/usr/bin/sudo', '-n', '--', '/usr/bin/systemd-run', '--system', '--wait', '--pipe', '--quiet', '--collect',
                '--unit=' + unit, *['--property=' + value for value in props],
                *['--setenv=' + key + '=' + value for key, value in settings.items()],
                '/usr/bin/python3', '-I', '-B', str(Path(__file__).resolve()), 'service', unit, str(pending)]
        launching = directory / 'manager-start.pending'
        own_json(launching, run_identity(controller, run_id))
        with (directory / 'manager.raw.log').open('xb') as manager_log:
            wrapper = subprocess.Popen(argv, env=BASE_ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=manager_log)
        report['ownedCleanup'] = 'unknown'
        wrapper_pidfd = os.pidfd_open(wrapper.pid)
        manager_birth = process_birth(wrapper.pid)
        require(manager_birth is not None, 'swap-manager-live')
        own_json(directory / 'manager-birth.json', {**run_identity(controller, run_id),
                 'pid': wrapper.pid, 'birth': manager_birth})
        launching.unlink()
        message = frame(wrapper.stdout, pending)
        refusal = service_failure(message, {'identity'})
        if refusal is not None:
            report['unboundChildRefusal'] = refusal
            raise Refusal('child-pre-ready-refused')
        ready = re.fullmatch(r'R ([1-9][0-9]{0,9})', message)
        require(ready, 'ready-frame')
        pid = int(ready[1])
        row = show(unit)
        require(owned(row, unit, pid, nonce), 'unit-identity')
        birth = process_identity(pid, unit)
        pidfd = os.pidfd_open(pid)
        require(process_identity(pid, unit) == birth and show(unit) == row, 'unit-birth')
        holder_bound = True
        with group(unit) as descriptors:
            before = sample(descriptors, initial=True)
            require(read_at(descriptors[-1], 'cgroup.procs') == str(pid) and before['current'] < 64 * 1024 ** 2
                    and all(value == 0 for value in before['oom'].values()), 'initial-cgroup')
            report['initial'] = before
            minimum = before['memAvailable']
            birth_seal = group_birth(descriptors)
            now = time.monotonic_ns()
            require(now < pending and deadline - now >= WORK_NS + 25 * 10 ** 9 and wrapper.poll() is None, 'late-grant')
            stop = now + WORK_NS
            wrapper.stdin.write(f'G {stop} {birth_seal}\n'.encode('ascii'))
            wrapper.stdin.flush()
            report['grantSent'] = True
            while time.monotonic_ns() < stop:
                if select.select([wrapper.stdout], [], [], .25)[0]:
                    message = frame(wrapper.stdout, stop)
                    allowed = {'compiler', 'terminal'} if report['admitted'] else {'grant', 'cgroup', 'start'}
                    refusal = service_failure(message, allowed)
                    if refusal is not None:
                        report['childRefusal'] = refusal
                        raise Refusal('child-refused')
                    if not report['admitted']:
                        require(message == 'S', 'start-frame')
                        report['admitted'] = True
                    else:
                        done = re.fullmatch(r'D (-?[0-9]{1,3})', message)
                        require(done and -64 <= int(done[1]) <= 255, 'done-frame')
                        report['compilerExit'] = int(done[1])
                        break
                current = sample(descriptors)
                verify_swap_live(swap_birth, temporary, source)
                minimum = min(minimum, current['memAvailable'])
                report.update(lastSample=current, minimumMemAvailable=minimum)
                require(all(current['pressureMicros'][key] >= before['pressureMicros'][key] for key in ('some', 'full')),
                        'cgroup-pressure-reset')
                require(current['oom'] == before['oom'] and current['hostOomKill'] == before['hostOomKill']
                        and [a['oom'] for a in current['ancestors']] == [a['oom'] for a in before['ancestors']], 'oom-observed')
            require(report['compilerExit'] is not None and time.monotonic_ns() < stop, 'compiler-deadline')
            after = sample(descriptors)
            verify_swap_live(swap_birth, temporary, source)
            compiler_files(source)
            require(command(['/usr/bin/git', '-C', str(source), 'status', '--porcelain']) == (0, b''), 'checkout-source')
            report['sourceReverified'] = True
            report.update(terminal=after, minimumMemAvailable=min(minimum, after['memAvailable']))
            named_group = os.stat(unit, dir_fd=descriptors[-2], follow_symlinks=False)
            held_group = os.fstat(descriptors[-1])
            require((held_group.st_dev, held_group.st_ino) == (named_group.st_dev, named_group.st_ino)
                    and read_at(descriptors[-1], 'cgroup.procs') == str(pid) and process_identity(pid, unit) == birth
                    and show(unit) == row and after['peak'] <= LIMIT and after['oom'] == before['oom']
                    and all(after['pressureMicros'][key] >= before['pressureMicros'][key] for key in ('some', 'full'))
                    and after['hostOomKill'] == before['hostOomKill']
                    and [a['oom'] for a in after['ancestors']] == [a['oom'] for a in before['ancestors']]
                    and time.monotonic_ns() < stop, 'terminal-native-evidence')
            report['zeroObservedOom'] = True
            wrapper.stdin.write(b'X\n')
            wrapper.stdin.flush()
            require(wrapper.wait(timeout=10) == 0, 'service-exit')
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        report['reason'] = str(error) if isinstance(error, Refusal) else type(error).__name__
    finally:
        if wrapper is not None:
            with contextlib.suppress(BrokenPipeError):
                wrapper.stdin.close()
            if holder_bound and not select.select([pidfd], [], [], 0)[0]:
                with contextlib.suppress(OSError):
                    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                if not select.select([pidfd], [], [], 10)[0]:
                    with contextlib.suppress(OSError):
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            try:
                wrapper.wait(timeout=2)
            except subprocess.TimeoutExpired:
                if wrapper_pidfd is not None:
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        with contextlib.suppress(OSError):
                            signal.pidfd_send_signal(wrapper_pidfd, sig)
                        try:
                            wrapper.wait(timeout=2)
                            break
                        except subprocess.TimeoutExpired:
                            pass
            try:
                if holder_bound and wrapper.poll() is not None and select.select([pidfd], [], [], 0)[0]:
                    absent_until = min(deadline, time.monotonic_ns() + 4 * 10 ** 9)
                    while time.monotonic_ns() < absent_until:
                        if (show(unit)['LoadState'] == 'not-found' and not os.path.lexists(group_path)
                                and time.monotonic_ns() < absent_until):
                            report['ownedCleanup'] = 'settled'
                            break
                        time.sleep(.1)
            except (Refusal, OSError, ValueError, subprocess.SubprocessError):
                pass
            for fd in (pidfd, wrapper_pidfd):
                if fd is not None:
                    os.close(fd)
            report['managerExit'] = wrapper.poll()
            wrapper.stdout.close()
            try:
                manager = read_at(None, str(directory / 'manager.raw.log'), 4096).lower()
                if 'a password is required' in manager or 'not in the sudoers' in manager or 'not allowed to execute' in manager:
                    report['managerRefusal'] = 'sudo-unavailable'
                elif 'access denied' in manager or 'interactive authentication required' in manager:
                    report['managerRefusal'] = 'manager-authority-unavailable'
            except (Refusal, OSError, ValueError):
                pass
        try:
            settle_manager(directory, unit, controller, run_id)
            if swap_birth is not None:
                platform_swap(swap_birth)
                report['platformSwapPreserved'] = True
        except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError):
            report['platformSettlementRefused'] = True
        try:
            log = directory / 'compiler.raw.log'
            fd = os.open(log, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= 4 * 1024 ** 2, 'log-bound')
                raw = stream.read(4 * 1024 ** 2 + 1)
                require(len(raw) == info.st_size and identity(info) == identity(os.fstat(fd))
                        == identity(os.stat(log, follow_symlinks=False)), 'log-changed')
            if report['ownedCleanup'] == 'settled':
                report['compilerLog'] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                report['v8HeapFatalMarker'] = bool(re.search(
                    rb'^FATAL ERROR: [^\r\n]*JavaScript heap out of memory[^\r\n]*$', raw, re.M))
                report['typescriptDiagnosticCount'] = len(re.findall(rb'\berror TS[0-9]+:', raw))
        except (Refusal, OSError):
            report['compilerLog'] = None
        report['complete'] = accepted_terminal(report, deadline)
        own_json(directory / 'receipt.json', report)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as stream:
            stream.write('evidence=true\n')
        print(json.dumps(report, separators=(',', ':')), flush=True)
    return 0 if report['complete'] else 1


def independent_cleanup(_workspace, temporary, controller, run_id):
    directory = temporary / DIRECTORY
    if not os.path.lexists(directory):
        return
    with owner_lock(directory):
        settle_manager(directory, unit_name(run_id), controller, run_id)
        for name in ('compiler.raw.log', 'manager.raw.log'):
            path = directory / name
            if os.path.lexists(path):
                private_file_birth(path.lstat())
                path.unlink()
        swap = directory / 'platform-swap.json'
        platform_verified = False
        birth_digest = None
        if os.path.lexists(swap):
            proof = read_intent(swap)
            birth = proof.pop('birth')
            require(proof == run_identity(controller, run_id) and isinstance(birth, list)
                    and len(birth) == 9 and all(type(value) is int for value in birth), 'platform-swap-witness')
            platform_swap(birth)
            birth_digest = hashlib.sha256(json.dumps(birth).encode('ascii')).hexdigest()
            platform_verified = True
        receipt = directory / 'receipt.json'
        if os.path.lexists(receipt):
            report = read_intent(receipt, maximum=64 * 1024)
            require([report.get(key) for key in ('kind', 'candidateSha', 'candidateTree', 'controllerSha', 'runId', 'attempt',
                    'releaseEligible')] == ['WHOLE_COMPILER_PLATFORM_SWAP_FEASIBILITY_NOT_RELEASE', SOURCE, SOURCE_TREE,
                                           controller, run_id, 1, False], 'swap-receipt-context')
            if report.get('platformSwapVerified') is True:
                require(platform_verified and report.get('platformSwapBirthSha256') == birth_digest, 'platform-swap-witness')
            if report.get('complete') is True:
                require(report.get('platformSwapVerified') is True and report.get('platformSwapPreserved') is True,
                        'platform-swap-witness')
        own_json(directory / 'swap-settlement.json', {**run_identity(controller, run_id),
                  'kind': 'COMPILER_PLATFORM_SWAP_INDEPENDENT_SETTLEMENT_NOT_RELEASE',
                  'unitAbsent': True, 'platformSwapIdentityVerified': platform_verified,
                  'platformSwapBirthSha256': birth_digest, 'privateLogsRemoved': True,
                  'releaseEligible': False})
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as stream:
            stream.write('settled=true\n')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'service':
            service(sys.argv[2], integer(sys.argv[3]))
        else:
            require(sys.argv[1:] in (['admit'], ['run'], ['cleanup']), 'role')
            context = environment()
            if sys.argv[1] == 'run':
                signal.signal(signal.SIGTERM, lambda *_: require(False, 'controller-interrupted'))
                sys.exit(run(*context))
            if sys.argv[1] == 'cleanup':
                independent_cleanup(*context)
            if sys.argv[1] == 'admit':
                require(disk_available(context[0], context[1]) >= 12 * GIB, 'compiler-disk-setup')
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Compiler feasibility refused: ' + (str(error) if isinstance(error, Refusal) else type(error).__name__), file=sys.stderr)
        sys.exit(2)
