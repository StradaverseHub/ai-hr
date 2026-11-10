"""First-attempt hosted proof of the complete bounded compiler. The ordinary gate stays separate."""
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


SOURCE = 'f9dfb7b9ea844e3938945981a4bf736c351ae980'
SOURCE_TREE = '792eb53641e2ea1fde9538f76c68652efa3f2402'
SOURCE_BRANCH = 'codex/architecture-f9dfb7b-stock-compiler-reference-20261110'
BRANCH = 'codex/compiler-witness-order-f9dfb7b9-13312-phase-proof-20261110'
REPO = 'StradaverseHub/ai-hr'
GIB = 1024 ** 3
HEAP_MIB = 13 * 1024
LIMIT = 13 * GIB
SWAP = 2560 * 1024 ** 2
PLATFORM_SWAP = Path('/swapfile')
PLATFORM_SWAP_BYTES = 3 * GIB
PLATFORM_SWAP_USABLE = PLATFORM_SWAP_BYTES - 4096
SWAP_HOST_RESERVE = 512 * 1024 ** 2
WORK_SECONDS = 1080
JOB_SECONDS = 1680
WORK_NS = WORK_SECONDS * 10 ** 9
PROGRESS_SECONDS = 30
PROGRESS_NS = PROGRESS_SECONDS * 10 ** 9
PROGRESS_MAX_ROWS = WORK_SECONDS // PROGRESS_SECONDS + 1
PROGRESS_TAIL_MS = 1000
PROGRESS_COUNTERS = ('cpuUsec', 'userUsec', 'systemUsec', 'cpuSomeUsec', 'cpuFullUsec',
                     'ioSomeUsec', 'ioFullUsec', 'memoryFullUsec', 'residentPeakBytes', 'swapPeakBytes')
PROGRESS_OPTIONAL_COUNTERS = ('throttledPeriods', 'throttledUsec')
PROGRESS_GAUGES = ('residentBytes', 'swapBytes', 'hostAvailableBytes')
ROOT = Path('/sys/fs/cgroup')
DIRECTORY = 'compiler-13312-witness-order-f9dfb7b9-phase'
UNIT_PREFIX = 'aihr-compiler-13312-witness-order-f9dfb7b9-phase-'
UNIT_NAME = re.compile(rf'{re.escape(UNIT_PREFIX)}[1-9][0-9]{{0,15}}\.service')
BASE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
CG_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
MANAGED_KIND = 'WHOLE_MANAGED_COMMAND_PLATFORM_SWAP_DIAGNOSTIC_NOT_RELEASE'
CACHE_RELATIVE = '.next/cache/compiler-transport/whole-project.tsbuildinfo'
MAX_STATE = 64 * 1024 ** 2
MAX_LOG = 4 * 1024 ** 2
ORDINARY_BUDGET_MS = 900000
INVENTORY_FIELDS = ('configuredRoots', 'orderedRootSha256', 'rootSetSha256', 'generatedCount',
                    'generatedSha256', 'toolSha256')
STATE_FIELDS = ('buildInfoBytes', 'buildInfoSha256', 'nativeFiles', 'nativeRoots', 'nativeRootSetSha256')
# The earlier managed command proves the tool, root census and route inputs on its own source.
# Neither its typecheck result nor its compiler graph is adopted.
BASELINE_RUN = '42760558491'
CALIBRATION_SOURCE = 'db3f301d0b7d0b19b4c000ff67067bb9099a5911'
TRACKED_MEMBERS = 12970
TRACKED_SHA256 = '9010b42238c1a5719a4d06def3f06865836749b2d00431fe0b60d471675e0d5f'
BASELINE_INVENTORY = {
    'configuredRoots': 9206,
    'orderedRootSha256': 'ede0443db2183aa00a164170912c73e28e9eebf10d06025f49140050e76d6c79',
    'rootSetSha256': '91757b55ea1211fc80cb0553c7e7f6befe7a40065de5d8b04d27c802e2de0ba6',
    'generatedCount': 5,
    'generatedSha256': '61eb985bfaa59dcd9621c43083c11c792856c4e031587d40fa6962c9d17f612e',
    'toolSha256': '8a3f43685059608d9fa8e5333e233d0494f89cd453202f5f9a54989631efa4be',
}
BASELINE_NODE_SHA256 = 'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48'
BASELINE_ARGV_SHA256 = 'c24f853d33edb0cfbb3068197aba380b9869e89e762827bb0edf9fe72de8027d'
BASELINE_STOCK_LIST_SHA256 = '508f02d502d0178ffafbd0cb7bc4b40df1b14240059709a1e2782d56a14a3797'
EXPECTED_NATIVE_FILES = 11689
LOCATION_POLICY = 'TRACKED_SOURCE_COMPILER_COORDINATES_V1'
EXTENDED_DIAGNOSTICS_POLICY = 'STOCK_TYPESCRIPT_EXTENDED_DIAGNOSTICS_V1'
EXTENDED_DIAGNOSTICS_FIELDS = {
    b'Types': 'types',
    b'Instantiations': 'instantiations',
    b'Program time': 'programMs',
    b'Check time': 'checkMs',
    b'Total time': 'totalMs',
}
LOCATION_MAX_ROWS = 64
LOCATION_GENERATED = {'next-env.d.ts', '.next/types/cache-life.d.ts', '.next/types/root-params.d.ts',
                      '.next/types/routes.d.ts', '.next/types/validator.ts'}
SOURCE_INPUTS = {
    'tsconfig.json': '0ee72fb11a698bad9b18c39223569adf5758727272b35bfa99ec7bfa57c3530a',
    'package.json': '7f67e35d869a29d2cb58d65c6f63413afc63db2cc6c6cf9dacb5086bce70ec2c',
    'pnpm-lock.yaml': '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
    'pnpm-workspace.yaml': '68505b5f88e6fbd9ef4a309ca131de8e64f1749939d846da2d81e88db14c9369',
    'next.config.ts': 'bd74eab1c7b57d1d27ec240feaea84db60ca882b54c308434e5baa4104696d7c',
    'mobile/package.json': '03fd6692c2651a555672ee5025a008f447a8ed1443ba6933c3da03f7023a6a27',
    'mobile/package-lock.json': '6919f4b6fd6b0ac3fb8346fc9578d8c3a0ccbdb9538bed6e8fd43e3cb8eb9915',
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


def command(argv, *, timeout=3):
    deadline = time.monotonic() + timeout
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
    require(re.fullmatch(r'[a-f0-9]{40}', SOURCE) and re.fullmatch(r'[a-f0-9]{40}', SOURCE_TREE), 'frozen-candidate-unbound')
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
                'qualify_restricted_port_prerequisites': 'false', 'profile_database': 'false', 'duration_order': 'false',
                'run_typecheck': 'true', 'run_native_typecheck': 'false', 'run_native_swift_models': 'false',
                'run_native_bundle': 'false', 'run_build': 'false', 'model_eval': '', 'eval_budget_usd': '20',
                'eval_allowed_providers': ''}
    inputs = {'model_eval': '', 'eval_allowed_providers': '', **event['inputs']}
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


def pressure_totals(descriptor, resource):
    raw = read_at(descriptor, resource + '.pressure')
    pressure = {}
    for category in ('some', 'full'):
        rows = re.findall(r'^' + category + r' avg10=[0-9.]+ avg60=[0-9.]+ avg300=[0-9.]+ total=([0-9]+)$', raw, re.M)
        require(len(rows) == 1, 'cgroup-pressure')
        pressure[category] = integer(rows[0])
    require(pressure['full'] <= pressure['some'], 'cgroup-pressure')
    return pressure


def compiler_progress(descriptor, elapsed_ms, phase, memory):
    cpu = pairs(read_at(descriptor, 'cpu.stat'))
    required = ('usage_usec', 'user_usec', 'system_usec')
    throttle = ('nr_throttled', 'throttled_usec')
    require(all(key in cpu for key in required) and sum(key in cpu for key in throttle) in (0, 2), 'compiler-cpu-counters')
    cpu_pressure = pressure_totals(descriptor, 'cpu')
    io_pressure = pressure_totals(descriptor, 'io')
    return {'phase': phase, 'elapsedMs': elapsed_ms,
            'cpuUsec': integer(cpu['usage_usec']), 'userUsec': integer(cpu['user_usec']),
            'systemUsec': integer(cpu['system_usec']),
            'throttledPeriods': integer(cpu[throttle[0]]) if throttle[0] in cpu else None,
            'throttledUsec': integer(cpu[throttle[1]]) if throttle[1] in cpu else None,
            'cpuSomeUsec': cpu_pressure['some'], 'cpuFullUsec': cpu_pressure['full'],
            'ioSomeUsec': io_pressure['some'], 'ioFullUsec': io_pressure['full'],
            'memoryFullUsec': memory['pressureMicros']['full'], 'residentBytes': memory['current'],
            'residentPeakBytes': memory['peak'], 'swapBytes': memory['swapCurrent'],
            'swapPeakBytes': memory['swapPeak'], 'hostAvailableBytes': memory['memAvailable']}


def valid_progress(rows):
    if type(rows) is not list or len(rows) > PROGRESS_MAX_ROWS:
        return False
    fields = {*PROGRESS_COUNTERS, *PROGRESS_OPTIONAL_COUNTERS, *PROGRESS_GAUGES, 'phase', 'elapsedMs'}
    previous = None
    for index, row in enumerate(rows):
        if type(row) is not dict or set(row) != fields:
            return False
        phase, elapsed = row['phase'], row['elapsedMs']
        phases = ('start',) if index == 0 else (('running', 'terminal', 'deadline') if index == len(rows) - 1 else ('running',))
        if phase not in phases or type(elapsed) is not int or not 0 <= elapsed <= WORK_SECONDS * 1000 + PROGRESS_TAIL_MS:
            return False
        if (phase == 'deadline') != (elapsed >= WORK_SECONDS * 1000):
            return False
        if any(type(row[key]) is not int or not 0 <= row[key] <= 2 ** 63 - 1 for key in (*PROGRESS_COUNTERS, *PROGRESS_GAUGES)):
            return False
        optional = [row[key] for key in PROGRESS_OPTIONAL_COUNTERS]
        if optional != [None, None] and any(type(value) is not int or not 0 <= value <= 2 ** 63 - 1 for value in optional):
            return False
        if not (row['cpuFullUsec'] <= row['cpuSomeUsec'] and row['ioFullUsec'] <= row['ioSomeUsec']
                and row['residentBytes'] <= row['residentPeakBytes'] <= LIMIT
                and row['swapBytes'] <= row['swapPeakBytes'] <= SWAP):
            return False
        if previous is not None:
            gap = elapsed - previous['elapsedMs']
            if gap < (PROGRESS_SECONDS * 1000 if phase == 'running' else 0):
                return False
            if any(row[key] < previous[key] for key in PROGRESS_COUNTERS):
                return False
            if any((row[key] is None) != (previous[key] is None) or
                   (row[key] is not None and row[key] < previous[key]) for key in PROGRESS_OPTIONAL_COUNTERS):
                return False
        previous = row
    return True


def record_progress(rows, descriptor, started, stamp, phase, memory):
    next_row = compiler_progress(descriptor, (stamp - started) // 10 ** 6, phase, memory)
    require(valid_progress([*rows, next_row]), 'compiler-progress-shape')
    rows.append(next_row)


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
    pressure = pressure_totals(target, 'memory')
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
    'start': {'service-launch-late', 'native-list-refused', 'native-input-fingerprint', 'native-list-cache-created'},
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
        require(UNIT_NAME.fullmatch(unit) and os.getuid() > 0
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
            source = Path.cwd()
            node = Path(os.environ['AIHR_STOCK_NODE'])
            with (directory / 'native-list.raw').open('xb') as listing:
                listed = subprocess.run(native_list_command(source, node),
                                        stdin=subprocess.DEVNULL, stdout=listing, stderr=subprocess.DEVNULL, timeout=45)
            require(listed.returncode == 0, 'native-list-refused')
            require(not os.path.lexists(source / CACHE_RELATIVE), 'native-list-cache-created')
            fingerprint = compiler_fingerprint(source, node, directory / 'native-list.raw')
            own_json(directory / 'native-input-fingerprint.json', fingerprint)
            with (directory / 'compiler.raw.log').open('xb') as log:
                require(time.monotonic_ns() < stop, 'service-launch-late')
                with subprocess.Popen(compiler_command(source, node),
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
    return UNIT_PREFIX + run_id + '.service'


def compiler_command(source, node):
    return ['/usr/bin/time', '-v', '/usr/bin/prlimit', '--fsize=67108864', '--', str(node),
            str(source / 'node_modules/typescript/lib/tsc.js'), '--noEmit', '--pretty', 'false',
            '--extendedDiagnostics', '--tsBuildInfoFile', str(source / CACHE_RELATIVE)]


def native_list_command(source, node):
    # This separate semantic-free census must leave the production cache cold.
    return [item for item in compiler_command(source, node)[2:] if item != '--extendedDiagnostics'] + ['--listFilesOnly']


def pinned_node_hash(node):
    fd = os.open(node, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 256 * 1024 ** 2, 'pinned-node-member')
        digest = hashlib.sha256()
        remaining = before.st_size
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            require(bool(chunk), 'pinned-node-member')
            digest.update(chunk)
            remaining -= len(chunk)
        require(not stream.read(1) and identity(os.fstat(fd)) == identity(before)
                == identity(node.lstat()), 'pinned-node-changed')
        return digest.hexdigest()


def verify_source_inputs(source):
    for name, digest in SOURCE_INPUTS.items():
        path = source / name
        info = path.lstat()
        require(path.resolve(strict=True) == path and stat.S_ISREG(info.st_mode)
                and 0 < info.st_size <= 16 * 1024 ** 2, 'managed-source-input')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'managed-source-input')


def pre_typegen(source):
    for name in ('next-env.d.ts', '.next/types', '.next/dev', 'tsconfig.tsbuildinfo', str(Path(CACHE_RELATIVE).parent)):
        require(not os.path.lexists(source / name), 'managed-pre-typegen-not-fresh')


def cache_birth(info):
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700, 'managed-cache-directory')
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid]


def canonical_cache_parent(source, *, create=False):
    parent = source / '.next/cache'
    if create and not os.path.lexists(parent):
        parent.mkdir(mode=0o700)
    require(parent.resolve(strict=True) == parent, 'managed-cache-parent')
    for path in (parent.parent, parent):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o022, 'managed-cache-parent')
    return parent


def verify_cache(source, fd, birth, *, require_empty=False):
    parent = canonical_cache_parent(source)
    path = parent / Path(CACHE_RELATIVE).parent.name
    require(cache_birth(os.fstat(fd)) == cache_birth(path.lstat()) == birth, 'managed-cache-replaced')
    names = os.listdir(fd)
    require(not names or (not require_empty and names == [Path(CACHE_RELATIVE).name]), 'managed-cache-members')
    if names:
        private_file_birth(os.stat(names[0], dir_fd=fd, follow_symlinks=False))
    return names


def create_cache(source, directory, controller, run_id):
    parent = canonical_cache_parent(source, create=True)
    path = parent / Path(CACHE_RELATIVE).parent.name
    require(not os.path.lexists(path) and not os.path.lexists(source / 'tsconfig.tsbuildinfo'), 'managed-cache-not-cold')
    pending = directory / 'cache-create.pending'
    own_json(pending, run_identity(controller, run_id))
    path.mkdir(mode=0o700)
    fd = os.open(path, CG_FLAGS)
    try:
        birth = cache_birth(os.fstat(fd))
        verify_cache(source, fd, birth, require_empty=True)
        own_json(directory / 'cache-birth.json', {**run_identity(controller, run_id), 'birth': birth})
        pending.unlink()
        return fd, birth
    except BaseException:
        os.close(fd)
        raise


def cleanup_cache(source, directory, controller, run_id):
    path = (source / CACHE_RELATIVE).parent
    require(not os.path.lexists(directory / 'cache-create.pending'), 'managed-cache-creation-unsettled')
    witness = directory / 'cache-birth.json'
    if os.path.lexists(witness):
        proof = read_intent(witness)
        birth = proof.pop('birth')
        require(proof == run_identity(controller, run_id) and type(birth) is list
                and len(birth) == 4 and all(type(value) is int and value >= 0 for value in birth), 'managed-cache-witness')
        parent = canonical_cache_parent(source)
        with contextlib.ExitStack() as cleanup:
            parent_fd = os.open(parent, CG_FLAGS)
            cleanup.callback(os.close, parent_fd)
            fd = os.open(path.name, CG_FLAGS, dir_fd=parent_fd)
            cleanup.callback(os.close, fd)
            for name in verify_cache(source, fd, birth):
                os.unlink(name, dir_fd=fd)
            verify_cache(source, fd, birth, require_empty=True)
            os.rmdir(path.name, dir_fd=parent_fd)
    require(not os.path.lexists(path) and not os.path.lexists(source / 'tsconfig.tsbuildinfo'), 'managed-cache-not-removed')


def compiler_inventory(source, node, mode):
    helper = Path(__file__).with_name('compiler-managed-inventory.mjs')
    result, raw = command([str(node), '--max-old-space-size=512', str(helper), mode, str(source)], timeout=15)
    require(result == 0 and 0 < len(raw) <= 4096, 'managed-native-inventory')
    row = json.loads(raw)
    require(valid_inventory(row, result=mode == 'post'), 'managed-native-inventory')
    return row


def compiler_fingerprint(source, node, listing):
    helper = Path(__file__).with_name('compiler-bounded-input-fingerprint.mjs')
    result, raw = command([str(node), '--max-old-space-size=512', str(helper), str(source), SOURCE, SOURCE_TREE,
                           str(listing), BASELINE_NODE_SHA256, BASELINE_ARGV_SHA256], timeout=20)
    require(result == 0 and 0 < len(raw) <= 4096, 'native-input-fingerprint')
    row = json.loads(raw)
    require(valid_fingerprint(row), 'native-input-fingerprint')
    require(matches_prior_native_list(row), 'native-input-fingerprint')
    return row


def matches_prior_native_list(fingerprint):
    return (fingerprint['loadedFiles'] == EXPECTED_NATIVE_FILES
            and fingerprint['stockListSha256'] == BASELINE_STOCK_LIST_SHA256)


def valid_fingerprint(row):
    keys = ('trackedMembers', 'trackedSha256', 'configuredRoots', 'configuredSha256', 'loadedFiles', 'loadedSha256',
            'generatedSha256', 'toolSha256', 'nodeSha256', 'argvSha256', 'inputFingerprintSha256', 'stockListSha256')
    if type(row) is not dict or set(row) != set(keys):
        return False
    if not all(type(row[key]) is str and re.fullmatch(r'[a-f0-9]{64}', row[key]) for key in keys if key.endswith('Sha256')):
        return False
    if not all(type(row[key]) is int and 1 <= row[key] <= 50000 for key in ('trackedMembers', 'configuredRoots', 'loadedFiles')):
        return False
    return (row['trackedMembers'] == TRACKED_MEMBERS and row['trackedSha256'] == TRACKED_SHA256
            and row['configuredRoots'] == BASELINE_INVENTORY['configuredRoots'] <= row['loadedFiles']
            and row['configuredSha256'] == BASELINE_INVENTORY['orderedRootSha256']
            and row['generatedSha256'] == BASELINE_INVENTORY['generatedSha256']
            and row['toolSha256'] == BASELINE_INVENTORY['toolSha256']
            and row['nodeSha256'] == BASELINE_NODE_SHA256 and row['argvSha256'] == BASELINE_ARGV_SHA256)


def valid_inventory(row, *, result=False):
    fields = (*INVENTORY_FIELDS, *STATE_FIELDS) if result else INVENTORY_FIELDS
    if type(row) is not dict or set(row) != set(fields):
        return False
    if not all(type(row[key]) is str and re.fullmatch(r'[0-9a-f]{64}', row[key])
               for key in fields if key.endswith('Sha256')):
        return False
    if type(row['generatedCount']) is not int or row['generatedCount'] != 5:
        return False
    if type(row['configuredRoots']) is not int or not 5 <= row['configuredRoots'] <= 100000:
        return False
    return (not result or type(row['nativeRoots']) is int and row['nativeRoots'] == row['configuredRoots']
            and row['nativeRootSetSha256'] == row['rootSetSha256']
            and type(row['nativeFiles']) is int and row['nativeRoots'] <= row['nativeFiles'] <= 100000
            and type(row['buildInfoBytes']) is int and 0 < row['buildInfoBytes'] <= MAX_STATE)


def compiler_log_evidence(raw):
    parsed = re.findall(rb'^(?:[^\r\n]+\([0-9]+,[0-9]+\): )?error TS([1-9][0-9]{3,4}):', raw, re.M)
    diagnostics = re.findall(rb'\berror TS[0-9]+:', raw)
    counts = {}
    for number in parsed:
        code = int(number)
        counts[code] = counts.get(code, 0) + 1
    rows = [[code, count] for code, count in sorted(counts.items())]
    files = re.findall(rb'^Files:[ \t]+([1-9][0-9]*)[ \t]*\r?$', raw, re.M)
    valid = len(parsed) == len(diagnostics) and len(rows) <= 128
    return {'v8HeapFatalMarker': bool(re.search(
                rb'^FATAL ERROR: [^\r\n]*JavaScript heap out of memory[^\r\n]*$', raw, re.M)),
            'typescriptDiagnosticCount': len(diagnostics), 'typescriptDiagnosticCodes': rows if valid else [],
            'diagnosticsParsed': valid,
            'compilerFiles': int(files[0]) if len(files) == 1 and len(files[0]) <= 6 else None}


def extended_diagnostics_evidence(raw, report):
    if report.get('complete') is not True:
        return {'status': 'not-complete'}
    refused = {'status': 'projection-refused'}
    if (not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_LOG or report.get('compilerLog') != {
            'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}):
        return refused
    pattern = rb'^(Types|Instantiations|Program time|Check time|Total time):([^\r\n]*)\r?$'
    rows = re.findall(pattern, raw, re.M)
    if [label for label, _ in rows] != list(EXTENDED_DIAGNOSTICS_FIELDS):
        return refused
    values = {}
    for label, text in rows:
        key = EXTENDED_DIAGNOSTICS_FIELDS[label]
        if key in ('types', 'instantiations'):
            number = re.fullmatch(rb'[ \t]+(0|[1-9][0-9]{0,8})[ \t]*', text)
            if number is None:
                return refused
            values[key] = int(number[1])
        else:
            duration = re.fullmatch(rb'[ \t]+(0|[1-9][0-9]{0,3})\.([0-9]{2})s[ \t]*', text)
            if duration is None:
                return refused
            values[key] = 1000 * int(duration[1]) + 10 * int(duration[2])
    if (not 0 < values['types'] <= 100_000_000 or values['instantiations'] > 100_000_000
            or not 0 < values['totalMs'] <= WORK_SECONDS * 1000
            or max(values['programMs'], values['checkMs']) > values['totalMs']):
        return refused
    return {'status': 'verified', **values}


def read_owned_compiler_log(log):
    fd = os.open(log, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= MAX_LOG, 'log-bound')
        raw = stream.read(MAX_LOG + 1)
        require(len(raw) == info.st_size and identity(info) == identity(os.fstat(fd))
                == identity(os.stat(log, follow_symlinks=False)), 'log-changed')
        return raw


def diagnostic_source(source, raw_name, line, column):
    prefix = os.fsencode(source) + b'/'
    if raw_name.startswith(prefix):
        raw_name = raw_name[len(prefix):]
    elif raw_name.startswith(b'./'):
        raw_name = raw_name[2:]
    require(re.fullmatch(rb'[A-Za-z0-9_.@+() \[\]/-]{1,384}', raw_name) is not None
            and all(part not in (b'', b'.', b'..', b'.git') for part in raw_name.split(b'/')),
            'diagnostic-source-name')
    name = raw_name.decode('ascii')
    path = source / name
    require(path.resolve(strict=True) == path and path.suffix in {'.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'},
            'diagnostic-source-path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and 0 < info.st_size <= MAX_LOG, 'diagnostic-source-member')
        content = stream.read(MAX_LOG + 1)
        require(len(content) == info.st_size and identity(info) == identity(os.fstat(fd))
                == identity(path.lstat()), 'diagnostic-source-changed')
    if name not in LOCATION_GENERATED:
        result, found = command(['/usr/bin/git', '-C', str(source), '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', name])
        blob = hashlib.sha1(b'blob ' + str(len(content)).encode('ascii') + b'\0' + content).hexdigest().encode('ascii')
        require(result == 0 and re.fullmatch(rb'100(?:644|755) ' + blob + rb' 0\t' + re.escape(raw_name) + rb'\0', found),
                'diagnostic-source-tracked-blob')
    lines = re.split(r'\r\n|\r|\n|\u2028|\u2029', content.decode('utf-8-sig'))
    require(1 <= line <= len(lines) and 1 <= column <= len(lines[line-1].encode('utf-16-le')) // 2 + 1,
            'diagnostic-source-coordinate')
    return name


def diagnostic_location_evidence(raw, source, report):
    if report.get('complete') is True and report.get('compilerExit') == 0 and report.get('typescriptDiagnosticCount') == 0:
        return {'status': 'none', 'rows': []}
    count = report.get('typescriptDiagnosticCount')
    if (report.get('compilerOutcome') != 'typescript-diagnostics' or report.get('compilerExit') != 2
            or type(count) is not int or not 1 <= count <= LOCATION_MAX_ROWS or not same_baseline(report)
            or not all(report.get(key) is True for key in ('admitted', 'grantSent', 'managedInputsReverified',
                       'generatedTypesVerified', 'sourceReverified', 'zeroObservedOom', 'platformSwapPreserved'))
            or report.get('ownedCleanup') != 'settled'
            or not valid_fingerprint(report.get('nativeInputFingerprint'))
            or report.get('compilerFiles') != report['nativeInputFingerprint']['loadedFiles']):
        return {'status': 'unmatched-compiler-outcome', 'rows': []}
    try:
        require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_LOG and report['compilerLog'] == {
            'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, 'diagnostic-log-identity')
        fields = re.findall(rb'^([^\r\n]{1,384})\(([1-9][0-9]{0,6}),([1-9][0-9]{0,6})\): error TS([1-9][0-9]{3,4}):', raw, re.M)
        require(len(fields) == count, 'diagnostic-location-count')
        rows = []
        counts = {}
        for filename, line, column, code in fields:
            line, column, code = int(line), int(column), int(code)
            name = diagnostic_source(source, filename, line, column)
            counts[code] = counts.get(code, 0) + 1
            rows.append({'code': code, 'path': name, 'line': line, 'column': column})
        require([[code, amount] for code, amount in sorted(counts.items())] == report['typescriptDiagnosticCodes'],
                'diagnostic-location-codes')
        return {'status': 'verified', 'rows': rows}
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError):
        return {'status': 'location-projection-refused', 'rows': []}


def compiler_outcome(report):
    if report.get('v8HeapFatalMarker') is True:
        return 'v8-heap-exhausted'
    if report.get('reason') == 'oom-observed':
        return 'kernel-oom-observed'
    if report.get('reason') == 'compiler-deadline':
        return 'compiler-deadline'
    if report.get('typescriptDiagnosticCount', 0) > 0:
        return 'typescript-diagnostics' if report.get('diagnosticsParsed') is True else 'unparsed-diagnostics'
    if report.get('compilerExit') is None:
        return 'pre-grant-refusal' if not report.get('grantSent') else 'compiler-protocol-refusal'
    if report['compilerExit'] != 0:
        return 'other-compiler-nonzero'
    if report.get('complete') is True:
        return 'complete'
    return 'zero-exit-evidence-refused'


def same_baseline(report):
    return (report.get('inventory') == BASELINE_INVENTORY and report.get('nodeSha256') == BASELINE_NODE_SHA256
            and report.get('managedArgvSha256') == BASELINE_ARGV_SHA256)


def valid_measurement(report):
    if 'matchedCalibrationRun' in report and (report['matchedCalibrationRun'] != BASELINE_RUN
                                                or report.get('matchedCalibrationSource') != CALIBRATION_SOURCE
                                                or not same_baseline(report)):
        return False
    inventory, state = report.get('inventory'), report.get('managedState')
    if 'nativeInputFingerprint' in report and not valid_fingerprint(report['nativeInputFingerprint']):
        return False
    if inventory is not None and not valid_inventory(inventory):
        return False
    if 'managedInputsReverified' in report and report['managedInputsReverified'] is not True:
        return False
    if state is not None and (report.get('managedInputsReverified') is not True
                              or inventory is None or not valid_inventory(state, result=True)
                              or any(inventory[key] != state[key] for key in INVENTORY_FIELDS)
                              or report.get('compilerFiles') != state['nativeFiles']):
        return False
    if 'compilerWindowElapsedMs' in report:
        elapsed = report['compilerWindowElapsedMs']
        if (type(elapsed) is not int or not 0 <= elapsed < WORK_SECONDS * 1000
                or report.get('terminalBeforeOrdinaryBudget') is not (elapsed < ORDINARY_BUDGET_MS)):
            return False
    elif 'terminalBeforeOrdinaryBudget' in report:
        return False
    if report.get('compilerLog') is not None:
        log = report['compilerLog']
        if (type(log) is not dict or set(log) != {'bytes', 'sha256'} or type(log['bytes']) is not int
                or not 0 < log['bytes'] <= MAX_LOG or type(log['sha256']) is not str
                or not re.fullmatch(r'[0-9a-f]{64}', log['sha256'])):
            return False
        rows, count = report.get('typescriptDiagnosticCodes'), report.get('typescriptDiagnosticCount')
        if (type(rows) is not list or len(rows) > 128 or type(count) is not int or not 0 <= count <= log['bytes']
                or type(report.get('diagnosticsParsed')) is not bool or type(report.get('v8HeapFatalMarker')) is not bool):
            return False
        if any(type(row) is not list or len(row) != 2 or any(type(value) is not int for value in row)
               or not 1000 <= row[0] <= 99999 or not 0 < row[1] <= count for row in rows):
            return False
        codes = [row[0] for row in rows]
        if codes != sorted(set(codes)):
            return False
        if report['diagnosticsParsed']:
            if sum(row[1] for row in rows) != count:
                return False
        elif rows:
            return False
        files = report.get('compilerFiles')
        if files is not None and (type(files) is not int or not 0 < files <= 100000):
            return False
    if any(key in report and (type(report[key]) is not str or not re.fullmatch(r'[0-9a-f]{64}', report[key]))
           for key in ('managedArgvSha256', 'nodeSha256')):
        return False
    return report.get('compilerOutcome') == compiler_outcome(report)


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
    progress = report.get('progress')
    inventory, state = report.get('inventory'), report.get('managedState')
    return (valid_inventory(inventory) and valid_inventory(state, result=True)
            and all(inventory[key] == state[key] for key in INVENTORY_FIELDS)
            and report.get('compilerFiles') == state['nativeFiles']
            and valid_fingerprint(report.get('nativeInputFingerprint'))
            and report['nativeInputFingerprint']['loadedFiles'] == state['nativeFiles']
            and report.get('diagnosticsParsed') is True
            and valid_progress(progress) and bool(progress) and progress[-1]['phase'] == 'terminal'
            and 'reason' not in report and report.get('admitted') is True and report.get('grantSent') is True
            and type(report.get('compilerExit')) is int and report['compilerExit'] == 0
            and type(report.get('managerExit')) is int and report['managerExit'] == 0
            and report.get('zeroObservedOom') is True and report.get('ownedCleanup') == 'settled'
            and report.get('platformSwapVerified') is True and report.get('platformSwapPreserved') is True
            and report.get('generatedTypesVerified') is True and report.get('sourceReverified') is True
            and report.get('managedInputsReverified') is True
            and report.get('matchedCalibrationRun') == BASELINE_RUN
            and report.get('matchedCalibrationSource') == CALIBRATION_SOURCE and same_baseline(report)
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
    deadline = integer(os.environ['AIHR_COMPILER_FEASIBILITY_T0_NS']) + JOB_SECONDS * 10 ** 9
    report = {'kind': MANAGED_KIND, 'candidateSha': SOURCE, 'candidateTree': SOURCE_TREE,
              'controllerSha': controller, 'residentCapBytes': LIMIT, 'swapCapBytes': SWAP,
              'runId': run_id, 'attempt': 1, 'heapMiB': HEAP_MIB, 'compilerExit': None, 'admitted': False,
              'grantSent': False, 'workSeconds': WORK_SECONDS, 'progressSeconds': PROGRESS_SECONDS, 'progress': [],
              'complete': False, 'ownedCleanup': 'not-started', 'platformSwapVerified': False,
              'platformSwapPreserved': False, 'releaseEligible': False, 'compilerStateReusable': False}
    wrapper = None
    pidfd = None
    wrapper_pidfd = None
    holder_bound = False
    swap_birth = None
    cache_fd = None
    cache_seal = None
    node = None
    try:
        require(deadline - time.monotonic_ns() >= WORK_NS + 45 * 10 ** 9, 'insufficient-job-budget')
        report['hostPrelaunch'] = ram()
        require(len(os.sched_getaffinity(0)) == 4 and report['hostPrelaunch']['MemAvailable'] >= 14 * GIB, 'host-prelaunch')
        require(show(unit)['LoadState'] == 'not-found' and not os.path.lexists(group_path), 'pre-existing-unit')
        tools = Path(os.environ['RUNNER_TOOL_CACHE']) / 'node/22.23.3/x64/bin'
        node = tools / 'node'
        require(node.resolve(strict=True) == node and node.is_file()
                and all(Path(path).is_file() for path in ('/usr/bin/time', '/usr/bin/prlimit')), 'pinned-tool-path')
        require(command([str(node), '--version']) == (0, b'v22.23.3\n'), 'pinned-node-version')
        report['nodeSha256'] = pinned_node_hash(node)
        verify_source_inputs(source)
        report['inventory'] = compiler_inventory(source, node, 'pre')
        report['generatedTypesVerified'] = True
        report['managedArgvSha256'] = hashlib.sha256(json.dumps(compiler_command(source, node)).encode('ascii')).hexdigest()
        require(same_baseline(report), 'managed-baseline-differs')
        report['matchedCalibrationRun'] = BASELINE_RUN
        report['matchedCalibrationSource'] = CALIBRATION_SOURCE
        cache_fd, cache_seal = create_cache(source, directory, controller, run_id)
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
                 'KillMode=control-group', 'TimeoutStopSec=10s', f'RuntimeMaxSec={WORK_SECONDS + 24}s', 'Restart=no',
                 'WorkingDirectory=' + str(source), 'Description=' + nonce)
        settings = {'PATH': f'{tools}:/usr/bin:/bin', 'HOME': pwd.getpwuid(os.getuid()).pw_dir,
                    'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8', 'TZ': 'Asia/Kuala_Lumpur', 'CI': 'true',
                    'NODE_OPTIONS': f'--max-old-space-size={HEAP_MIB}', 'RUNNER_TEMP': str(temporary),
                    'AIHR_STOCK_NODE': str(node)}
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
            verify_cache(source, cache_fd, cache_seal, require_empty=True)
            next_progress = now
            progress = report['progress']
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
                        fingerprint = read_intent(directory / 'native-input-fingerprint.json', maximum=4096)
                        require(valid_fingerprint(fingerprint), 'native-input-fingerprint')
                        report['nativeInputFingerprint'] = fingerprint
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
                stamp = time.monotonic_ns()
                if report['admitted'] and next_progress <= stamp < stop:
                    record_progress(progress, descriptors[-1], now, stamp, 'running' if progress else 'start', current)
                    next_progress = stamp + PROGRESS_NS
            stamp = time.monotonic_ns()
            if report['compilerExit'] is None and progress and stop <= stamp <= stop + PROGRESS_TAIL_MS * 10 ** 6:
                with contextlib.suppress(Refusal, OSError, ValueError):
                    record_progress(progress, descriptors[-1], now, stamp, 'deadline', report['lastSample'])
            require(report['compilerExit'] is not None and stamp < stop, 'compiler-deadline')
            after = sample(descriptors)
            record_progress(progress, descriptors[-1], now, stamp, 'terminal', after)
            verify_swap_live(swap_birth, temporary, source)
            report['compilerWindowElapsedMs'] = (stamp - now) // 10 ** 6
            report['terminalBeforeOrdinaryBudget'] = report['compilerWindowElapsedMs'] < ORDINARY_BUDGET_MS
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
        raw = None
        try:
            raw = read_owned_compiler_log(directory / 'compiler.raw.log')
            if report['ownedCleanup'] == 'settled':
                report['compilerLog'] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                report.update(compiler_log_evidence(raw))
        except (Refusal, OSError):
            report['compilerLog'] = None
        try:
            if cache_fd is not None and report.get('compilerExit') is not None and report['ownedCleanup'] == 'settled':
                verify_cache(source, cache_fd, cache_seal)
                verify_source_inputs(source)
                require(pinned_node_hash(node) == report['nodeSha256'], 'pinned-node-changed')
                require(deadline - time.monotonic_ns() >= 20 * 10 ** 9, 'managed-result-budget')
                success = report['compilerExit'] == 0
                state = compiler_inventory(source, node, 'post' if success else 'pre')
                verify_cache(source, cache_fd, cache_seal)
                require(all(report['inventory'][key] == state[key] for key in INVENTORY_FIELDS), 'managed-result-identity')
                report['managedInputsReverified'] = True
                fingerprint = compiler_fingerprint(source, node, directory / 'native-list.raw')
                require(fingerprint == report['nativeInputFingerprint']
                        == read_intent(directory / 'native-input-fingerprint.json', maximum=4096),
                        'native-input-fingerprint-changed')
                if success:
                    require(report.get('compilerFiles') == state['nativeFiles'], 'managed-result-identity')
                    report['managedState'] = state
        except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError):
            report.setdefault('reason', 'managed-result-refused')
        finally:
            if cache_fd is not None:
                os.close(cache_fd)
        report['complete'] = accepted_terminal(report, deadline)
        report['compilerOutcome'] = compiler_outcome(report)
        report['diagnosticLocationPolicy'] = LOCATION_POLICY
        report['diagnosticLocations'] = diagnostic_location_evidence(raw, source, report)
        report['extendedDiagnosticsPolicy'] = EXTENDED_DIAGNOSTICS_POLICY
        report['extendedDiagnostics'] = extended_diagnostics_evidence(raw, report)
        own_json(directory / 'receipt.json', report)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as stream:
            stream.write('evidence=true\n')
        locations = report['diagnosticLocations']
        console = {**report, 'diagnosticLocations': {'status': locations['status'], 'count': len(locations['rows'])}}
        print(json.dumps(console, separators=(',', ':')), flush=True)
    return 0 if report['complete'] else 1


def independent_cleanup(workspace, temporary, controller, run_id):
    directory = temporary / DIRECTORY
    if not os.path.lexists(directory):
        return
    with owner_lock(directory):
        settle_manager(directory, unit_name(run_id), controller, run_id)
        cleanup_cache(workspace / 'source', directory, controller, run_id)
        report = None
        input_fingerprint = None
        locations_verified = False
        extended_verified = False
        try:
            receipt = directory / 'receipt.json'
            if os.path.lexists(receipt):
                report = read_intent(receipt, maximum=64 * 1024)
                if 'nativeInputFingerprint' in report:
                    node = Path(os.environ['RUNNER_TOOL_CACHE']) / 'node/22.23.3/x64/bin/node'
                    require(pinned_node_hash(node) == BASELINE_NODE_SHA256, 'pinned-node-changed')
                    input_fingerprint = compiler_fingerprint(workspace / 'source', node, directory / 'native-list.raw')
                    require(input_fingerprint == report['nativeInputFingerprint'], 'native-input-fingerprint-changed')
                require(report.get('diagnosticLocationPolicy') == LOCATION_POLICY, 'diagnostic-location-policy')
                raw = None
                if report.get('compilerLog') is not None:
                    raw = read_owned_compiler_log(directory / 'compiler.raw.log')
                    require(report['compilerLog'] == {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()},
                            'diagnostic-log-custody')
                projected = diagnostic_location_evidence(raw, workspace / 'source', report)
                require(projected == report.get('diagnosticLocations'), 'diagnostic-location-custody')
                locations_verified = projected['status'] in ('verified', 'none')
                require(report.get('extendedDiagnosticsPolicy') == EXTENDED_DIAGNOSTICS_POLICY,
                        'extended-diagnostics-policy')
                extended = extended_diagnostics_evidence(raw, report)
                require(extended == report.get('extendedDiagnostics'), 'extended-diagnostics-custody')
                extended_verified = extended['status'] == 'verified'
                require(report.get('complete') is not True or extended_verified, 'extended-diagnostics-unavailable')
        finally:
            for name in ('compiler.raw.log', 'manager.raw.log', 'native-list.raw'):
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
        if report is not None:
            require([report.get(key) for key in ('kind', 'candidateSha', 'candidateTree', 'controllerSha', 'runId', 'attempt',
                    'releaseEligible', 'compilerStateReusable', 'heapMiB', 'residentCapBytes', 'swapCapBytes')] == [
                        MANAGED_KIND, SOURCE, SOURCE_TREE, controller, run_id, 1, False, False, HEAP_MIB, LIMIT, SWAP],
                    'swap-receipt-context')
            require(report.get('workSeconds') == WORK_SECONDS and report.get('progressSeconds') == PROGRESS_SECONDS
                    and valid_progress(report.get('progress')), 'compiler-progress-witness')
            require(valid_measurement(report), 'managed-measurement-witness')
            if report.get('complete') is True:
                require(bool(report['progress']) and report['progress'][-1]['phase'] == 'terminal', 'compiler-progress-witness')
                require(valid_inventory(report.get('managedState'), result=True)
                        and valid_fingerprint(input_fingerprint)
                        and report['nativeInputFingerprint'] == read_intent(directory / 'native-input-fingerprint.json', maximum=4096)
                        and report.get('matchedCalibrationRun') == BASELINE_RUN
                        and report.get('matchedCalibrationSource') == CALIBRATION_SOURCE and same_baseline(report),
                        'managed-measurement-witness')
            if report.get('platformSwapVerified') is True:
                require(platform_verified and report.get('platformSwapBirthSha256') == birth_digest, 'platform-swap-witness')
            if report.get('complete') is True:
                require(report.get('platformSwapVerified') is True and report.get('platformSwapPreserved') is True,
                        'platform-swap-witness')
        own_json(directory / 'swap-settlement.json', {**run_identity(controller, run_id),
                  'kind': 'COMPILER_PLATFORM_SWAP_INDEPENDENT_SETTLEMENT_NOT_RELEASE',
                  'unitAbsent': True, 'managedStateRemoved': True, 'platformSwapIdentityVerified': platform_verified,
                  'platformSwapBirthSha256': birth_digest, 'privateLogsRemoved': True,
                  'inputFingerprintIndependentlyVerified': input_fingerprint is not None,
                  'diagnosticLocationsIndependentlyVerified': locations_verified,
                  'extendedDiagnosticsIndependentlyVerified': extended_verified,
                  'releaseEligible': False})
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as stream:
            stream.write('settled=true\n')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'service':
            service(sys.argv[2], integer(sys.argv[3]))
        else:
            require(sys.argv[1:] in (['admit'], ['pre-typegen'], ['run'], ['cleanup']), 'role')
            context = environment()
            if sys.argv[1] == 'run':
                signal.signal(signal.SIGTERM, lambda *_: require(False, 'controller-interrupted'))
                sys.exit(run(*context))
            if sys.argv[1] == 'cleanup':
                independent_cleanup(*context)
            if sys.argv[1] == 'pre-typegen':
                pre_typegen(context[0] / 'source')
            if sys.argv[1] == 'admit':
                require(disk_available(context[0], context[1]) >= 12 * GIB, 'compiler-disk-setup')
    except (Refusal, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Compiler feasibility refused: ' + (str(error) if isinstance(error, Refusal) else type(error).__name__), file=sys.stderr)
        sys.exit(2)
