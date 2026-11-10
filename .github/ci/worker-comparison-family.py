"""Closed subreaper for the hosted serial worker comparison."""
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import socket
import subprocess
import sys
import time
from types import ModuleType

SOURCE = Path(__file__).resolve().parents[2]
KERNEL_PATH = SOURCE / '.github/ci/owned-process.py'
KERNEL = ModuleType('aihr_owned_process')
KERNEL.__file__ = str(KERNEL_PATH)
exec(compile(KERNEL_PATH.read_bytes(), str(KERNEL_PATH), 'exec', dont_inherit=True), KERNEL.__dict__)


def clock():
    return time.monotonic_ns() // 1_000_000


def require(value):
    if not value:
        raise ValueError('Worker comparison process custody refused')


def admit():
    env = os.environ
    expected = {
        'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr',
        'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_WORKFLOW': 'alpha-focused-checks', 'GITHUB_JOB': 'selected-tests',
        'GITHUB_RUN_ATTEMPT': '1', 'AIHR_MEASURED_BROWSER_COURSE': 'serial-2-4-8',
        'AIHR_CI_UNIT': 'db-1', 'AIHR_CI_PG_PROFILE': '2', 'AIHR_CI_PG_DURABLE': '1',
        'AIHR_CI_PG_STATEMENTS': '1', 'AIHR_CI_PG_STATEMENTS_OWNER': 'system-http-profile',
    }
    require(sys.platform == 'linux' and len(sys.argv) == 1 and all(env.get(key) == val for key, val in expected.items()))
    require(len(os.sched_getaffinity(0)) == 4 and SOURCE == Path.cwd() == Path(env['GITHUB_WORKSPACE']) / 'source')
    sha = env.get('AIHR_CI_HEAD', '')
    require(re.fullmatch(r'[a-f0-9]{40}', sha) and all(env.get(key) == sha for key in
            ('AIHR_CI_CONTROL_HEAD', 'GITHUB_SHA', 'GITHUB_WORKFLOW_SHA')))
    require(not any(env.get(key) for key in ('GH_TOKEN', 'GITHUB_TOKEN', 'AIHR_EVAL_OPENROUTER_KEY', 'NODE_OPTIONS',
                                              'AIHR_WORKER_COMPARISON_FAMILY_FD')))
    anchor = env.get('AIHR_WORKER_COMPARISON_T0_MS', '')
    require(re.fullmatch(r'[1-9][0-9]{0,14}', anchor))
    anchor = int(anchor)
    require(0 <= clock() - anchor < 6600_000 - 2560_000)
    node = shutil.which('node')
    require(node and Path(node).is_absolute() and Path(node).is_file())
    require(KERNEL.own_children() == [] and len(list(Path('/proc/self/task').iterdir())) == 1)
    require(signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL)
    return anchor, node


def children_of(pid):
    rows = []
    tasks = Path(f'/proc/{pid}/task')
    before = sorted(tasks.iterdir())
    require(0 < len(before) <= 256)
    for task in before:
        with (task / 'children').open('rb') as stream:
            raw = stream.read(65537)
        require(len(raw) <= 65536)
        rows.extend(int(value) for value in raw.split())
        require(len(rows) <= 1024)
    require(before == sorted(tasks.iterdir()))
    return rows


def exact_child(child, descriptor, birth):
    require(not select.select([descriptor], [], [], 0)[0])
    row = KERNEL.identity(child)
    require(row['parent'] == os.getpid() and row['start'] == birth and row['state'] not in ('Z', 'X'))


def barrier(child, descriptor, birth):
    exact_child(child, descriptor, birth)
    require(KERNEL.own_children() == [child] and children_of(child) == [] and KERNEL.own_children() == [child])
    exact_child(child, descriptor, birth)


def exchange(connection, descriptor, child, birth, anchor, mark=lambda _stage, _ordinal=None: None):
    next_frame = b'H\n'
    ordinal = 0
    buffered = b''
    end = anchor + 7080_000
    while clock() < end:
        mark('family-frame', ordinal)
        readable, _, _ = select.select([connection, descriptor], [], [], max(0, end - clock()) / 1000)
        if descriptor in readable:
            return ordinal
        require(connection in readable and clock() < end)
        chunk = connection.recv(16)
        if not chunk:
            # A normal child closes the socket just before exit. Let pidfd
            # establish its terminal identity, with no further barrier allowed.
            require(select.select([descriptor], [], [], min(5, max(0, end - clock()) / 1000))[0])
            return ordinal
        buffered += chunk
        require(len(buffered) <= len(next_frame) and next_frame.startswith(buffered))
        if buffered != next_frame:
            continue
        if ordinal == 0:
            require(clock() < anchor + 6600_000)
        else:
            require(ordinal <= 3 and clock() < anchor + 6960_000)
        mark('family-barrier', ordinal)
        barrier(child, descriptor, birth)
        reply = f'A{ordinal}\n'.encode('ascii')
        require(clock() < anchor + (6600_000 if ordinal == 0 else 6960_000))
        require(connection.send(reply) == len(reply))
        ordinal += 1
        next_frame = f'B{ordinal}\n'.encode('ascii')
        buffered = b''
    raise ValueError('Worker comparison process deadline elapsed')


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def publish(anchor, code, ordinal):
    temp = Path(os.environ['RUNNER_TEMP'])
    require(temp.is_absolute() and temp.resolve(strict=True) == temp)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = os.open(temp, directory_flags)
    try:
        directory = os.open('system-worker-comparison-evidence', directory_flags, dir_fd=root)
        try:
            before = os.fstat(directory)
            require(before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o700)
            fd = os.open('pending.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                limit = 128 * 1024
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                        and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= limit)
                raw = stream.read(limit + 1)
                require(len(raw) == info.st_size and file_identity(info) == file_identity(os.fstat(stream.fileno()))
                        == file_identity(os.stat('pending.json', dir_fd=directory, follow_symlinks=False)))
            summary = json.loads(raw)
            identity = summary['identity']
            require(summary['kind'] == 'HOSTED_WORKER_COMPARISON_V1' and summary['releaseEligible'] is False
                    and type(summary['complete']) is bool and summary['complete'] == (code == 0)
                    and identity['candidateSha'] == identity['controllerSha'] == os.environ['AIHR_CI_HEAD']
                    and identity['runId'] == int(os.environ['GITHUB_RUN_ID']) and identity['runAttempt'] == 1
                    and 'processOwner' not in summary and 1 <= ordinal <= 4 and clock() < anchor + 7080_000)
            summary['processOwner'] = {'settled': True, 'cellBarriers': ordinal - 1, 'runnerExitCode': code}
            data = (json.dumps(summary, indent=2) + '\n').encode('utf-8')
            require(len(data) <= limit)
            packet = 'summary-building.json'
            fd = os.open(packet, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                require(os.write(fd, data) == len(data))
                os.fsync(fd)
                after = os.stat('system-worker-comparison-evidence', dir_fd=root, follow_symlinks=False)
                require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino)
                        and file_identity(os.fstat(fd)) == file_identity(os.stat(packet, dir_fd=directory, follow_symlinks=False))
                        and clock() < anchor + 7080_000)
                os.link(packet, 'summary.json', src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                os.unlink(packet, dir_fd=directory)
                final = os.open('summary.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(final, 'rb') as stream:
                    sealed = os.fstat(stream.fileno())
                    require(file_identity(sealed) == file_identity(os.fstat(fd)) and sealed.st_nlink == 1
                            and stat.S_IMODE(sealed.st_mode) == 0o600 and stream.read(limit + 1) == data
                            and file_identity(sealed) == file_identity(os.stat('summary.json', dir_fd=directory, follow_symlinks=False))
                            and clock() < anchor + 7080_000)
                return hashlib.sha256(data).hexdigest()
            finally:
                os.close(fd)
        finally:
            os.close(directory)
    finally:
        os.close(root)


def failure_fact(stage, ordinal):
    phases = ('admission', 'subreaper', 'child-launch', 'family-frame', 'family-barrier',
              'child-exit', 'summary-custody', 'family-cleanup', 'workflow-output')
    return {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1',
            'stage': stage if stage in phases else 'unavailable',
            'ordinal': ordinal if type(ordinal) is int and 0 <= ordinal <= 4 else None}


def run(mark=lambda _stage, _ordinal=None: None):
    mark('admission')
    anchor, node = admit()
    mark('subreaper')
    require(KERNEL.subreaper(True) == 0)
    child = None
    descriptor = None
    owner_result = 1
    summary_digest = None

    def interrupted(_signum, _frame):
        raise InterruptedError('Worker comparison interrupted')

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        mark('child-launch')
        parent, client = socket.socketpair()
        with parent, client:
            parent.settimeout(5)
            env = {key: value for key, value in os.environ.items() if key not in
                   ('GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY', 'GITHUB_PATH', 'NODE_PATH')}
            env['AIHR_WORKER_COMPARISON_FAMILY_FD'] = str(client.fileno())
            child = subprocess.Popen([node, 'scripts/performance/system-runner.mjs', '--serial-2-4-8'],
                                     env=env, pass_fds=(client.fileno(),), stdin=subprocess.DEVNULL, start_new_session=True)
            descriptor = os.pidfd_open(child.pid)
            client.close()
            birth = KERNEL.identity(child.pid)['start']
            ordinal = exchange(parent, descriptor, child.pid, birth, anchor, mark)
            mark('child-exit', ordinal)
            code = child.wait(timeout=1)
            require(KERNEL.own_children() == [])
            if code == 0:
                require(ordinal == 4 and clock() < anchor + 7080_000)
            mark('summary-custody', ordinal)
            summary_digest = publish(anchor, code, ordinal)
            owner_result = 0 if code == 0 else 1
    finally:
        if summary_digest is not None:
            mark('family-cleanup', ordinal)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if child is not None and child.returncode is None:
            if descriptor is not None and not select.select([descriptor], [], [], 0)[0]:
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                if not select.select([descriptor], [], [], 5)[0]:
                    try:
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if descriptor is not None:
            os.close(descriptor)
        monitor = child.pid if child is not None and child.returncode is None else -1
        settled, _ = KERNEL.settle_adopted(monitor, min(clock() / 1000 + 10, anchor / 1000 + 7100), time.monotonic)
        require(settled and monitor == -1 and KERNEL.own_children() == [])
    mark('workflow-output', ordinal)
    require(summary_digest and clock() < anchor + 7080_000)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as output:
        output.write('published=true\nsummary_sha256=' + summary_digest + '\n')
    return owner_result


if __name__ == '__main__':
    stage, ordinal = None, None

    def mark(new_stage, new_ordinal=None):
        global stage, ordinal
        stage, ordinal = new_stage, new_ordinal

    try:
        raise SystemExit(run(mark))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(json.dumps(failure_fact(stage, ordinal)), file=sys.stderr, flush=True)
        print('Worker comparison family admission or settlement refused', file=sys.stderr, flush=True)
        raise SystemExit(1)
