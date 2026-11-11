"""Closed subreaper for the hosted serial worker comparison and for each parallel comparison cell."""
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


# Frontiers in milliseconds after the job anchor. A serial course reuses one host for three
# cells; a parallel cell owns one fresh runner and hands over exactly one cell barrier.
MODES = {
    'serial-2-4-8': {'job': 'selected-tests', 'entry': '--serial-2-4-8', 'kind': 'HOSTED_WORKER_COMPARISON_V1',
                     'cells': 3, 'active': 6600_000, 'minimum': 2560_000, 'settlement': 6960_000, 'final': 7080_000,
                     'outer': 7100_000, 'exited_outside_session': False},
    'parallel-2-4-8': {'job': 'worker-cell', 'entry': '--parallel-cell', 'kind': 'HOSTED_WORKER_COMPARISON_CELL_V1',
                       'cells': 1, 'active': 3000_000, 'minimum': 1390_000, 'settlement': 3360_000, 'final': 3480_000,
                       'outer': 3500_000, 'exited_outside_session': True},
}
MODES['parallel-smoke'] = MODES['parallel-2-4-8']
MODES['parallel-control'] = MODES['parallel-2-4-8']
MODES['parallel-control-50'] = MODES['parallel-2-4-8']
MODES['parallel-control-100'] = MODES['parallel-2-4-8']
# Exiting descendants may still be tearing down when cleanup returns. Wait, bounded,
# for the whole owned family to finish exiting before any census is taken.
FAMILY_EXIT_WAIT_MS = 20_000
# Closed counts for the public record. Browser helpers leave the runner's session by design.
ADOPTEES = {'live': 0, 'exitedInSession': 0, 'exitedOutsideSession': 0, 'reapedOutsideSession': 0}


def mode():
    course = os.environ.get('AIHR_MEASURED_BROWSER_COURSE')
    require(course in MODES)
    return MODES[course]


def require(value):
    if not value:
        raise ValueError('Worker comparison process custody refused')


def admit():
    env = os.environ
    expected = {
        'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr',
        'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_WORKFLOW': 'alpha-focused-checks', 'GITHUB_JOB': mode()['job'],
        'GITHUB_RUN_ATTEMPT': '1',
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
    require(0 <= clock() - anchor < mode()['active'] - mode()['minimum'])
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


def classify_adoptees(child, candidates):
    counts = {'live': 0, 'exitedInSession': 0, 'exitedOutsideSession': 0}
    for pid in candidates:
        try:
            row = KERNEL.identity(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        if row['state'] not in ('Z', 'X'):
            counts['live'] += 1
        elif row['group'] == row['session'] == child:
            counts['exitedInSession'] += 1
        else:
            counts['exitedOutsideSession'] += 1
    ADOPTEES.update(counts)
    return counts


def reap_exited_adoptees(child, candidates, allow_outside_session=False):
    # The subreaper started childless and launched just the session leader, so every
    # adoptee descends from it. A helper can be adopted once its parent exits. Serial reuse
    # refuses one that left the session. A one-cell runner is never reused and may collect
    # it once exited: anything it left alive is adopted here too and stays refused as live.
    require(0 < len(candidates) <= 32 and len(set(candidates)) == len(candidates))
    require(hasattr(os, 'P_PIDFD') and hasattr(os, 'pidfd_open'))
    owner = os.getpid()
    for pid in candidates:
        require(type(pid) is int and pid > 1 and pid not in (owner, child))
        before = KERNEL.identity(pid)
        inside = before['group'] == before['session'] == child
        require(before['pid'] == pid and before['parent'] == owner and before['state'] == 'Z'
                and (inside or allow_outside_session))
        descriptor = os.pidfd_open(pid)
        try:
            require(KERNEL.identity(pid) == before)
            status = os.waitid(os.P_PIDFD, descriptor, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            require(status is not None and status.si_pid == pid and status.si_signo == signal.SIGCHLD
                    and status.si_code in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED))
            require(KERNEL.identity(pid) == before)
            require(os.waitid(os.P_PIDFD, descriptor, os.WEXITED | os.WNOHANG) == status)
            if not inside:
                ADOPTEES['reapedOutsideSession'] += 1
        finally:
            os.close(descriptor)


def await_family_exit(child, deadline):
    """Return once every adopted orphan is a zombie and the runner has no children.

    This only waits; it never signals or reaps. The census below still refuses any
    process that remains alive, so the barrier keeps its strength when the wait elapses.
    """
    end = min(deadline, clock() + FAMILY_EXIT_WAIT_MS)
    while True:
        live = []
        for pid in KERNEL.own_children():
            if pid == child:
                continue
            try:
                if KERNEL.identity(pid)['state'] not in ('Z', 'X'):
                    live.append(pid)
            except (FileNotFoundError, ProcessLookupError):
                continue
        if not live and children_of(child) == []:
            return True
        if clock() >= end:
            return False
        time.sleep(0.02)


def barrier(child, descriptor, birth, mark=lambda _check, _count=None: None, deadline=None):
    def census(check, read, expected, reap=False):
        mark(check)
        actual = read()
        if actual != expected:
            mark(check, len(actual))
            if reap and actual.count(child) == 1:
                others = [pid for pid in actual if pid != child]
                classify_adoptees(child, others)
                reap_exited_adoptees(child, others, mode()['exited_outside_session'])
                actual = read()
                if actual != expected:
                    mark(check, len(actual))
        require(actual == expected)

    mark('runner-birth-before')
    exact_child(child, descriptor, birth)
    if deadline is not None:
        await_family_exit(child, deadline)
        exact_child(child, descriptor, birth)
    census('owner-census-before', KERNEL.own_children, [child], reap=True)
    census('runner-descendant-census', lambda: children_of(child), [])
    census('owner-census-after', KERNEL.own_children, [child])
    mark('runner-birth-after')
    exact_child(child, descriptor, birth)


def exchange(connection, descriptor, child, birth, anchor, mark=lambda _stage, _ordinal=None, _check=None, _count=None: None):
    next_frame = b'H\n'
    ordinal = 0
    buffered = b''
    limits = mode()
    end = anchor + limits['final']
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
        frontier = anchor + (limits['active'] if ordinal == 0 else limits['settlement'])
        require(ordinal <= limits['cells'] and clock() < frontier)
        mark('family-barrier', ordinal)
        barrier(child, descriptor, birth, lambda check, count=None: mark('family-barrier', ordinal, check, count), frontier)
        reply = f'A{ordinal}\n'.encode('ascii')
        require(clock() < frontier)
        require(connection.send(reply) == len(reply))
        ordinal += 1
        next_frame = f'B{ordinal}\n'.encode('ascii')
        buffered = b''
    raise ValueError('Worker comparison process deadline elapsed')


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def publish(anchor, code, ordinal):
    limits = mode()
    final_end = anchor + limits['final']
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
            require(summary['kind'] == limits['kind'] and summary['releaseEligible'] is False
                    and type(summary['complete']) is bool and summary['complete'] == (code == 0)
                    and identity['candidateSha'] == identity['controllerSha'] == os.environ['AIHR_CI_HEAD']
                    and identity['runId'] == int(os.environ['GITHUB_RUN_ID']) and identity['runAttempt'] == 1
                    and 'processOwner' not in summary and 1 <= ordinal <= limits['cells'] + 1 and clock() < final_end)
            summary['processOwner'] = {'settled': True, 'cellBarriers': ordinal - 1, 'runnerExitCode': code}
            if limits['exited_outside_session']:
                summary['processOwner']['exitedOutsideSession'] = ADOPTEES['reapedOutsideSession']
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
                        and clock() < final_end)
                os.link(packet, 'summary.json', src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                os.unlink(packet, dir_fd=directory)
                final = os.open('summary.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(final, 'rb') as stream:
                    sealed = os.fstat(stream.fileno())
                    require(file_identity(sealed) == file_identity(os.fstat(fd)) and sealed.st_nlink == 1
                            and stat.S_IMODE(sealed.st_mode) == 0o600 and stream.read(limit + 1) == data
                            and file_identity(sealed) == file_identity(os.stat('summary.json', dir_fd=directory, follow_symlinks=False))
                            and clock() < final_end)
                return hashlib.sha256(data).hexdigest()
            finally:
                os.close(fd)
        finally:
            os.close(directory)
    finally:
        os.close(root)


def failure_fact(stage, ordinal, check=None, count=None):
    phases = ('admission', 'subreaper', 'child-launch', 'family-frame', 'family-barrier',
              'child-exit', 'summary-custody', 'family-cleanup', 'workflow-output')
    checks = ('runner-birth-before', 'owner-census-before', 'runner-descendant-census',
              'owner-census-after', 'runner-birth-after')
    check = check if stage == 'family-barrier' and check in checks else None
    census = check in ('owner-census-before', 'runner-descendant-census', 'owner-census-after')
    return {'kind': 'WORKER_COMPARISON_FAMILY_FAILURE_V1',
            'stage': stage if stage in phases else 'unavailable',
            'ordinal': ordinal if type(ordinal) is int and 0 <= ordinal <= 4 else None,
            'barrierCheck': check,
            'observedChildren': count if census and type(count) is int and 0 <= count <= 1024 else None}


def run(mark=lambda _stage, _ordinal=None, _check=None, _count=None: None):
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
            child = subprocess.Popen([node, 'scripts/performance/system-runner.mjs', mode()['entry']],
                                     env=env, pass_fds=(client.fileno(),), stdin=subprocess.DEVNULL, start_new_session=True)
            descriptor = os.pidfd_open(child.pid)
            client.close()
            birth = KERNEL.identity(child.pid)['start']
            ordinal = exchange(parent, descriptor, child.pid, birth, anchor, mark)
            mark('child-exit', ordinal)
            code = child.wait(timeout=1)
            require(KERNEL.own_children() == [])
            if code == 0:
                require(ordinal == mode()['cells'] + 1 and clock() < anchor + mode()['final'])
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
        settled, _ = KERNEL.settle_adopted(monitor, min(clock() / 1000 + 10, (anchor + mode()['outer']) / 1000), time.monotonic)
        require(settled and monitor == -1 and KERNEL.own_children() == [])
    mark('workflow-output', ordinal)
    require(summary_digest and clock() < anchor + mode()['final'])
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='ascii') as output:
        output.write('published=true\nsummary_sha256=' + summary_digest + '\n')
    return owner_result


if __name__ == '__main__':
    stage, ordinal, check, count = None, None, None, None

    def mark(new_stage, new_ordinal=None, new_check=None, new_count=None):
        global stage, ordinal, check, count
        stage, ordinal, check, count = new_stage, new_ordinal, new_check, new_count

    try:
        raise SystemExit(run(mark))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(json.dumps(failure_fact(stage, ordinal, check, count)), file=sys.stderr, flush=True)
        print(json.dumps({'kind': 'WORKER_COMPARISON_FAMILY_ADOPTEES_V1', **ADOPTEES}), file=sys.stderr, flush=True)
        print('Worker comparison family admission or settlement refused', file=sys.stderr, flush=True)
        raise SystemExit(1)
