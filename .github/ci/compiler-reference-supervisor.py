"""Closed sole NODB compiler diagnostic adapter; no SQL or arbitrary command API.

The one shared owned-process.py kernel owns sessions/WNOWAIT/pidfd/subreaping.
This adapter owns fixed request, parent-node liveness, context and720s clock.
"""
import hashlib
import contextlib
import json
import os
import re
import select
import signal
import stat
import sys
import time
from pathlib import Path
from types import ModuleType

FILE = 'test/compiler-native-reference-fixture.test.ts'
LIMITS = {'git-head': 10, 'git-status': 10, 'git-tracked': 10,
          'controller-head': 10, 'controller-status': 10, 'classifier': 15,
          'compiler-reference': 848}
ROOT = Path(__file__).resolve().parents[2]
KERNEL = ROOT / '.github/ci/owned-process.py'
_kernel = ModuleType('compiler_owned_process');_kernel.__file__ = str(KERNEL)
exec(compile(KERNEL.read_bytes(), str(KERNEL), 'exec', dont_inherit=True), _kernel.__dict__)
require, identity = _kernel.require, _kernel.identity


def bounded(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                and before.st_nlink == 1 and not before.st_mode & 0o022 and 0 < before.st_size <= maximum)
        raw = os.read(fd, maximum + 1);after = os.fstat(fd);named = Path(path).lstat()
        require(len(raw) == before.st_size and len(raw) <= maximum
                and all(getattr(before, key) == getattr(after, key) == getattr(named, key)
                        for key in ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_mtime_ns', 'st_ctime_ns')))
        return raw
    finally:
        os.close(fd)


def request_command(request):
    require(type(request) is dict and list(request) == ['stage', 'node', 'controller', 'destination'])
    stage = request['stage'];require(stage in LIMITS)
    require(sys.platform == 'linux' and os.geteuid() > 0
            and os.environ.get('GITHUB_ACTIONS') == os.environ.get('CI') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'Linux'
            and os.environ.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr'
            and os.environ.get('GITHUB_WORKFLOW') == 'alpha-focused-checks'
            and os.environ.get('GITHUB_JOB') == 'selected-tests'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
            and os.environ.get('GITHUB_RUN_ATTEMPT') == '1'
            and json.loads(os.environ['AIHR_FOCUSED_TESTS']) == [FILE])
    require(re.fullmatch(r'[1-9][0-9]{0,19}', os.environ['GITHUB_RUN_ID']) is not None
            and all(re.fullmatch(r'[a-f0-9]{40}', os.environ[key]) is not None
                    for key in ('AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD')))
    workspace, temp = Path(os.environ['GITHUB_WORKSPACE']), Path(os.environ['RUNNER_TEMP'])
    control, source, destination = workspace / 'automation', workspace / 'source', temp / 'aihr-focused'
    node = Path(request['node'])
    require(all(path.is_absolute() and path.resolve() == path for path in (workspace, temp, control, source, destination, node))
            and Path.cwd().resolve() == source and ROOT == control and request['controller'] == str(control)
            and request['destination'] == str(destination) and os.path.samefile(node, '/proc/%s/exe' % os.getppid())
            and Path('/proc/self/exe').resolve() == Path('/usr/bin/python3').resolve())
    declaration = 'docs/qualification/compiler-reference-owned-source-20261108.json'
    raw = bounded(control / declaration, 131072)
    require(raw == bounded(source / declaration, 131072))
    manifest = json.loads(raw);require(manifest['kind'] == 'COMPILER_REFERENCE_OWNED_PROCESS_SOURCE_NOT_QUALIFICATION')
    for name, wanted in manifest['componentSources'].items():
        require(isinstance(name, str) and not name.startswith('/') and '..' not in name.split('/')
                and re.fullmatch(r'[a-f0-9]{64}', wanted) is not None)
        require(hashlib.sha256(bounded(control / name, 4 * 1024**2)).hexdigest() == wanted
                and hashlib.sha256(bounded(source / name, 4 * 1024**2)).hexdigest() == wanted)
    require(all(name in manifest['componentSources'] for name in
                ('.github/ci/compiler-reference-supervisor.py', '.github/ci/owned-process.py',
                 '.github/ci/focused-checks.mjs', '.github/ci/diagnostics/native-reference/admission.mjs', FILE)))
    return stage, fixed_command(stage, node, control, destination), destination, manifest


def fixed_command(stage, node, control, destination):
    require(stage in LIMITS)
    commands = {
        'git-head': ['git', 'rev-parse', 'HEAD'], 'git-status': ['git', 'status', '--porcelain'],
        'git-tracked': ['git', 'ls-files', '--stage', '-z', '--', 'test'],
        'controller-head': ['git', '-C', str(control), 'rev-parse', 'HEAD'],
        'controller-status': ['git', '-C', str(control), 'status', '--porcelain'],
        'classifier': [str(node), '--import', 'tsx', 'scripts/gate-db-classify.ts', 'explain'],
        'compiler-reference': ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.nodb.config.ts', FILE,
            '--reporter=default', '--reporter=json', '--outputFile.json=' + str(destination / 'nodb.vitest.json')],
    }
    return commands[stage]


def job_budget(stage, anchor, env, boot, now):
    require(type(anchor) is dict and set(anchor) == {'version', 'run', 'attempt', 'job', 'bootId', 'startNs', 'wallTimeNs'}
            and type(anchor['version']) is int and anchor['version'] == 1 and anchor['run'] == env['GITHUB_RUN_ID']
            and anchor['attempt'] == env['GITHUB_RUN_ATTEMPT'] == '1' and anchor['job'] == 'selected-tests'
            and anchor['bootId'] == boot and anchor['startNs'] == env['AIHR_FOCUSED_JOB_MONOTONIC_NS']
            and all(isinstance(anchor[key], str) and re.fullmatch(r'[1-9][0-9]{0,19}', anchor[key]) is not None
                    for key in ('startNs', 'wallTimeNs')) and stage in LIMITS)
    elapsed = now - int(anchor['startNs']) / 1e9
    require(0 <= elapsed < 1170)
    seconds = min(LIMITS[stage], 1170 - elapsed - 120 - 6)
    require(seconds > 0 and (stage != 'compiler-reference' or seconds >= 848))
    return seconds, elapsed


def supervise_parent(argv, seconds, event, *, parent, file_clock=None):
    """Fixed adapter supplies the already exe/source-fenced actual parent Node.
    Native controls use a separate real parent/child harness, never forged CI.
    """
    require(parent == os.getppid())
    before = identity(parent)
    with contextlib.ExitStack() as ownership:
        descriptor = os.pidfd_open(parent)
        ownership.callback(os.close, descriptor)
        require(identity(parent)['start'] == before['start'])
        active, cancelled = False, False
        def alive():
            return os.getppid() == parent and not select.select([descriptor], [], [], 0)[0]
        def clock():
            nonlocal cancelled
            now = time.monotonic()  # NEVER replace/advance the kernel's real clock.
            if active and not cancelled and not alive():
                handler = signal.getsignal(signal.SIGTERM)
                require(callable(handler) and handler.__code__.co_filename == str(KERNEL))
                cancelled = True
                signal.raise_signal(signal.SIGTERM)  # own exact live supervisor only
            return now
        def observed(packet):
            nonlocal active
            if packet['kind'] == 'session-admitted':
                require(alive())  # no ACK/workload after initial owner death
                handler = signal.getsignal(signal.SIGTERM)
                require(callable(handler) and handler.__code__.co_filename == str(KERNEL))
                active = True
            elif packet['kind'] == 'group-stop-before-reap':
                active = False  # never self-TERM after kernel handler restoration
            event(packet)
        try:
            require(alive())
            def observed_file_clock(started, now):
                require(not cancelled and alive())
                if not active:
                    return None
                return file_clock(started, now)
            return _kernel.supervise(argv, seconds, observed, clock=clock,
                file_clock=observed_file_clock if file_clock is not None else None, file_seconds=720)
        finally:
            active = False



def published_bytes(path, maximum):
    # mkdir is the atomic readiness frontier AFTER no-overwrite link/unlink.
    ready = Path(str(path) + '.ready')
    try:
        fd = os.open(ready, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(fd)
        require(stat.S_ISDIR(before.st_mode) and before.st_uid == os.getuid()
                and stat.S_IMODE(before.st_mode) == 0o700 and os.listdir(fd) == [])
        raw = bounded(path, maximum);after = os.fstat(fd);named = ready.lstat()
        require(all(getattr(before, key) == getattr(after, key) == getattr(named, key)
                    for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_mtime_ns', 'st_ctime_ns')))
        return raw
    finally:
        os.close(fd)


def compiler_clock(destination, started, now, seconds, binding):
    path = destination / 'compiler-reference-clock.json'
    raw = published_bytes(path, 2048)
    if raw is None:
        return None
    require(not path.lstat().st_mode & 0o077)
    value = json.loads(raw)
    require(type(value) is dict and set(value) == {'version', 'kind', 'run', 'attempt', 'source', 'controller', 'monitor', 'wrapper', 'startNs'}
            and type(value['version']) is int and value['version'] == 1 and value['kind'] == 'OWNED_COMPILER_REFERENCE_720_CLOCK'
            and all(value[key] == binding[key] for key in ('run', 'attempt', 'source', 'controller'))
            and re.fullmatch(r'[1-9][0-9]{0,19}', value['startNs']) is not None)
    require(all(type(value[key]) is dict and set(value[key]) == {'pid', 'start'}
                and all(type(field) is int and field > 1 for field in value[key].values())
                for key in ('monitor', 'wrapper')))
    children = _kernel.own_children();require(len(children) == 1)
    monitor = identity(children[0]);wrapper = identity(value['wrapper']['pid'])
    require(value['monitor'] == {'pid': monitor['pid'], 'start': monitor['start']}
            and monitor['parent'] == os.getpid() and monitor['group'] == monitor['session'] == monitor['pid']
            and value['wrapper'] == {'pid': wrapper['pid'], 'start': wrapper['start']}
            and wrapper['group'] == wrapper['session'] == monitor['pid'] and wrapper['state'] not in ('Z', 'X'))
    current, seen = wrapper, set()
    for _ in range(32):
        require(current['pid'] not in seen);seen.add(current['pid'])
        if current['pid'] == monitor['pid']:
            break
        require(current['group'] == current['session'] == monitor['pid']);current = identity(current['parent'])
    require(current['pid'] == monitor['pid'])
    observed = int(value['startNs']) / 1e9
    require(started <= observed <= now and observed + 720 <= started + seconds)
    pending, ack = destination / 'compiler-reference-clock-ack.pending', destination / 'compiler-reference-clock-ack.json'
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, raw) == len(raw))
    finally:
        os.close(fd)
    os.link(pending, ack, follow_symlinks=False);os.unlink(pending)
    os.mkdir(str(ack) + '.ready', 0o700)
    return observed


def main():
    require(len(sys.argv) == 2)
    stage, argv, destination, _manifest = request_command(json.loads(sys.argv[1]))
    binding = {'source': os.environ['AIHR_CI_HEAD'], 'controller': os.environ['AIHR_CI_CONTROL_HEAD'],
        'run': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT']}
    seconds, elapsed = job_budget(stage, json.loads(os.environ['AIHR_FOCUSED_JOB_ANCHOR']), os.environ,
        Path('/proc/sys/kernel/random/boot_id').read_text().strip(), time.monotonic())
    writer = identity(os.getpid());owner = identity(os.getppid());operation = os.urandom(16).hex()
    # Fixed diagnostics inherit no platform/provider/SSH/owner credentials.
    # Vitest's actual NODB setup retains the canonical closed-port proof.
    keys = ('PATH HOME RUNNER_TEMP GITHUB_WORKSPACE GITHUB_ACTIONS CI RUNNER_ENVIRONMENT RUNNER_OS '
            'GITHUB_REPOSITORY GITHUB_WORKFLOW GITHUB_JOB GITHUB_EVENT_NAME GITHUB_RUN_ATTEMPT GITHUB_RUN_ID '
            'AIHR_CI_HEAD AIHR_CI_CONTROL_HEAD AIHR_FOCUSED_TESTS AIHR_FOCUSED_EVIDENCE_DIR').split()
    clean = {key: os.environ[key] for key in keys if key in os.environ}
    clean.update({'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'GATE_NODB_PROOF': '1',
                  'VITEST_MAX_WORKERS': '1', 'VITEST_MAX_WORKERS_NODB': '1'})
    for key in ('DATABASE_URL', 'TEST_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL'):
        clean[key] = 'postgres://nobody:nothing@127.0.0.1:1/no_database'
    os.environ.clear();os.environ.update(clean)
    def event(packet):
        _kernel.append_event(destination / 'compiler-supervisor.jsonl', {**binding, 'stage': stage,
            'operation': operation, 'writer': {'pid': writer['pid'], 'start': writer['start']},
            'owner': {'pid': owner['pid'], 'start': owner['start']}, 'releaseAuthorized': False, **packet})
    event({'kind': 'stage-started', 'budgetSeconds': seconds, 'jobElapsedSeconds': elapsed})
    result = supervise_parent(argv, seconds, event, parent=owner['pid'],
        file_clock=(lambda begun, now: compiler_clock(destination, begun, now, seconds, binding)) if stage == 'compiler-reference' else None)
    return 0 if result['reason'] == 'complete' and result['groupQuiescent'] and result['reaped'] and not result['escapedSession'] else 1


if __name__ == '__main__':
    try:
        status = main()
    except BaseException:
        sys.stderr.write('Closed compiler supervision refused\n')
        status = 1
    sys.exit(status)
