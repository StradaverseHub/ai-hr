"""Fixed development benchmark lifecycle owner; not an arbitrary-code sandbox.

Own direct fork child stays unreaped (waitid WNOWAIT) until its session group is
signalled and has no live members. No Popen reaper, numeric fallback after reap,
root execution, application imports, SQL execution or deployment authority.
"""
import json
import ctypes
import os
import re
import select
import stat
import signal
import sys
import time
from pathlib import Path

FILE = 'test/employee-choice-native-purpose-plan.test.ts'
CONTROL_FILE = 'test/employee-choice-benchmark-owner-native.test.ts'
FACTORY_FILE = 'test/employee-choice-native-owner-factory.test.ts'
LIMITS = {'git-head': 10, 'git-status': 10, 'git-tracked': 10, 'evidence': 30, 'classifier': 15, 'reset': 60, 'migrate': 60, 'benchmark': 960, 'native-controls': 180, 'native-factory': 206,
          'stats': 10, 'logs': 10, 'inspect': 10, 'stop': 9}
REASONS = {'complete', 'command-failed', 'deadline', 'monitor-died', 'handshake-refused',
           'protocol-refused', 'descendants-survived', 'session-escaped', 'group-uncertain', 'owner-interrupted'}


def require(ok):
    if not ok:
        raise ValueError('Closed benchmark supervision refused')


def identity(pid):
    text = Path('/proc/%s/stat' % pid).read_text()
    fields = text[text.rindex(')') + 2:].split()
    return {'pid': pid, 'parent': int(fields[1]), 'group': int(fields[2]),
            'session': int(fields[3]), 'start': int(fields[19]), 'state': fields[0]}


def live_group(group):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            row = identity(int(entry.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        if row['group'] == group and row['state'] not in ('Z', 'X'):
            found.append(row['pid'])
    return found


def own_children():
    text = Path('/proc/self/task/%s/children' % os.getpid()).read_text()
    require(len(text) <= 65536)
    pids = [int(value) for value in text.split()]
    require(len(pids) <= 1024)
    return pids


def subreaper(enable):
    libc = ctypes.CDLL(None, use_errno=True)
    observed = ctypes.c_int()
    require(libc.prctl(37, ctypes.byref(observed), 0, 0, 0) == 0)
    before = observed.value
    require(libc.prctl(36, int(enable), 0, 0, 0) == 0)
    require(libc.prctl(37, ctypes.byref(observed), 0, 0, 0) == 0 and observed.value == int(enable))
    return before


def settle_adopted(monitor, deadline, clock):
    escaped = False
    # This dedicated process had NO children before becoming a subreaper. Every
    # newly adopted direct child is therefore its own previously orphaned family.
    while clock() < deadline:
        adopted = [pid for pid in own_children() if pid != monitor]
        if not adopted:
            return True, escaped
        for pid in adopted:
            before = identity(pid)
            require(before['parent'] == os.getpid())
            escaped = escaped or before['session'] != monitor or before['group'] != monitor
            descriptor = os.pidfd_open(pid)
            try:
                after = identity(pid)
                require(before['start'] == after['start'] and after['parent'] == os.getpid())
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    os.waitpid(pid, 0)
            finally:
                os.close(descriptor)
        time.sleep(.01)
    return not any(pid != monitor for pid in own_children()), escaped


def write_packet(fd, packet):
    data = json.dumps(packet, separators=(',', ':')).encode() + b'\n'
    require(len(data) <= 512)
    require(os.write(fd, data) == len(data))


def append_event(path, event):
    data = json.dumps(event, separators=(',', ':')).encode() + b'\n'
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and st.st_size + len(data) <= 131072)
        require(os.write(fd, data) == len(data))
        os.fsync(fd)
    finally:
        os.close(fd)


def supervise(argv, seconds, event, *, clock=time.monotonic, monitor_fault=False, file_clock=None, mandatory=False):
    """Library inputs are fixed by CLI below; native controls supply tiny fixtures.
    A forked monitor never admits a command before session identity ACK. Parent
    never polls/reaps it through Popen; its reserved PID cannot name a new group.
    """
    require(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(os, 'WNOWAIT'))
    require(type(seconds) in (int, float) and 0 < seconds <= 960)
    require(own_children() == [] and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL
            and len(list(Path('/proc/self/task').iterdir())) == 1)
    previous_subreaper = subreaper(True)
    ready_r, ready_w = os.pipe()
    ack_r, ack_w = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(ready_r); os.close(ack_w)
            os.setsid()
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            write_packet(ready_w, {'kind': 'ready', **{key: value for key, value in identity(os.getpid()).items() if key != 'state'}})
            require(os.read(ack_r, 1) == b'A')
            os.close(ack_r)
            if monitor_fault is True:
                os._exit(90)
            command = os.fork()
            if command == 0:
                os.close(ready_w)
                signal.signal(signal.SIGTERM, signal.SIG_DFL)
                os.execvpe(argv[0], argv, os.environ.copy())
            if monitor_fault == 'after-command':
                os._exit(90)
            _, status = os.waitpid(command, 0)
            write_packet(ready_w, {'kind': 'done', 'exit': os.waitstatus_to_exitcode(status)})
            # Remain the live anchor until the parent terminates the complete
            # owned group, even when the command has already completed.
            while True:
                signal.pause()
        except BaseException:
            os._exit(91)
    os.close(ready_w); os.close(ack_r)
    try:
        descriptor = os.pidfd_open(child)
    except OSError:
        # No ACK and no workload exists. Closing the pipe makes the fixed
        # monitor refuse EOF; never fall back to signalling a numeric PID.
        os.close(ack_w); os.close(ready_r)
        until = clock() + 3
        while os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None and clock() < until:
            time.sleep(.01)
        if os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
            os.waitpid(child, 0)
        raise
    started = clock(); deadline = started + seconds
    benchmark_start = None
    escaped = False
    admitted = False; reason = 'handshake-refused'; code = None; reaped = False
    buffered = b''; packets = 0; stopped = False
    previous = {}
    event_failed = False
    def emit(packet):
        nonlocal event_failed
        try:
            event(packet); return True
        except BaseException:
            event_failed = True; return False
    def interrupt(_signum, _frame):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, interrupt)
    try:
        while True:
            now = clock()
            if file_clock is not None and benchmark_start is None:
                benchmark_start = file_clock(started, now)
                if benchmark_start is not None:
                    deadline = min(deadline, benchmark_start + 900)
            if file_clock is not None and benchmark_start is None and now - started >= 60:
                reason = 'deadline'; break
            if stopped:
                reason = 'owner-interrupted'; break
            if now >= deadline or (not admitted and now - started >= 3):
                reason = 'deadline' if admitted else 'handshake-refused'; break
            if os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                reason = 'monitor-died'; break
            readable, _, _ = select.select([ready_r], [], [], min(0.05, deadline - now))
            if not readable:
                continue
            raw = os.read(ready_r, 513)
            if not raw:
                reason = 'monitor-died'; break
            buffered += raw
            if len(buffered) > 512:
                reason = 'protocol-refused'; break
            if b'\n' not in buffered:
                continue
            line, buffered = buffered.split(b'\n', 1); packets += 1
            packet = json.loads(line)
            if packets == 1:
                actual = identity(child)
                require(packet == {'kind': 'ready', **{key: value for key, value in actual.items() if key != 'state'}} and actual['parent'] == os.getpid()
                        and actual['group'] == child and actual['session'] == child and actual['state'] not in ('Z', 'X'))
                admitted = True
                write_packet_event = {'kind': 'session-admitted', 'pid': child, 'start': actual['start']}
                if not emit(write_packet_event) and not mandatory:
                    reason = 'protocol-refused'; break
                require(os.write(ack_w, b'A') == 1)
            else:
                require(packets == 2 and set(packet) == {'kind', 'exit'} and packet['kind'] == 'done'
                        and type(packet['exit']) is int and -64 <= packet['exit'] <= 255 and buffered == b'')
                code = packet['exit']; reason = 'complete' if code == 0 else 'command-failed'
                # A command must not leave a live follower/background writer.
                until = min(deadline, clock() + 1)
                while any(pid != child for pid in live_group(child)) and clock() < until:
                    time.sleep(0.01)
                if any(pid != child for pid in live_group(child)):
                    reason = 'descendants-survived'
                break
    except BaseException:
        reason = 'protocol-refused'
    finally:
        try:
            # Child PID remains reserved through this point, including zombie
            # monitor failure. NEVER waitpid/reap before the last group signal.
            if admitted:
                emit({'kind': 'group-stop-before-reap', 'reason': reason})
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                # No ACK means no command was admitted: use only the bound fd.
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
            until = clock() + 3
            while live_group(child) and clock() < until:
                time.sleep(0.01)
            descendants_settled, escaped = settle_adopted(child, clock() + 3, clock)
            if live_group(child) or not descendants_settled:
                reason = 'group-uncertain'
            else:
                if escaped and reason == 'complete':
                    reason = 'session-escaped'
                _, status = os.waitpid(child, 0); reaped = True
                require(own_children() == [])
                emit({'kind': 'group-quiescent-then-reaped', 'monitorExit': os.waitstatus_to_exitcode(status), 'escapedSession': escaped})
        finally:
            os.close(ready_r); os.close(ack_w); os.close(descriptor)
            if reaped:
                subreaper(previous_subreaper)
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    if event_failed:
        reason = 'protocol-refused'
    require(reason in REASONS)
    result = {'reason': reason, 'commandExit': code, 'admitted': admitted, 'reaped': reaped,
              'groupQuiescent': reaped, 'escapedSession': escaped, 'releaseAuthorized': False}
    if not emit({'kind': 'stage-ended', **result}):
        result['reason'] = 'protocol-refused'
    return result


def request_command(request):
    require(type(request) is dict and set(request) == {'stage', 'node', 'controller', 'destination'})
    stage = request['stage']; require(stage in LIMITS)
    node = Path(request['node']); control = Path(request['controller']); destination = Path(request['destination'])
    require(node.is_absolute() and node.is_file() and node.resolve() == node
            and os.path.samefile(node, '/proc/%s/exe' % os.getppid()))
    require(control.is_absolute() and control.resolve() == control and (control / '.github/ci/postgres.sh').is_file())
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    require(destination.is_absolute() and destination.resolve() == destination and temp in destination.parents)
    selection = json.loads(os.environ['AIHR_FOCUSED_TESTS'])
    require(selection in ([FILE], [CONTROL_FILE], [FACTORY_FILE]))
    if stage == 'benchmark':
        require(selection == [FILE])
    if stage == 'native-controls':
        require(selection == [CONTROL_FILE])
    if stage == 'native-factory':
        require(selection == [FACTORY_FILE])
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', os.environ['GITHUB_RUN_ID']) is not None
            and re.fullmatch(r'[1-9][0-9]{0,3}', os.environ['GITHUB_RUN_ATTEMPT']) is not None)
    name = 'aihr-ci-%s-%s-db-1' % (os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'])
    commands = {
        'git-head': ['git', 'rev-parse', 'HEAD'],
        'git-status': ['git', 'status', '--porcelain'],
        'git-tracked': ['git', 'ls-files', '--stage', '-z', '--', 'test'],
        'evidence': [str(node), str(control / '.github/ci/postgres-evidence.mjs')],
        'classifier': [str(node), '--import', 'tsx', 'scripts/gate-db-classify.ts', 'explain'],
        'reset': ['bash', str(control / '.github/ci/postgres.sh'), 'reset'],
        'migrate': ['pnpm', 'db:migrate'],
        'native-controls': ['pnpm', 'exec', 'vitest', 'run', CONTROL_FILE, '--reporter=default', '--reporter=json', '--outputFile.json=' + str(destination / 'db.vitest.json')],
        'native-factory': ['pnpm', 'exec', 'vitest', 'run', FACTORY_FILE, '--reporter=default', '--reporter=json', '--outputFile.json=' + str(destination / 'db.vitest.json')],
        'benchmark': ['pnpm', 'exec', 'vitest', 'run', FILE, '--reporter=default', '--reporter=json', '--outputFile.json=' + str(destination / 'db.vitest.json')],
        'stats': ['bash', str(control / '.github/ci/postgres.sh'), 'stats'],
        'logs': ['docker', 'logs', name],
        'inspect': ['docker', 'inspect', '--format', '{{json .State}}', name],
        'stop': ['bash', str(control / '.github/ci/postgres.sh'), 'stop'],
    }
    return stage, commands[stage], destination


def job_budget(stage, anchor, env, boot, now):
    require(type(anchor) is dict and set(anchor) == {'version', 'run', 'attempt', 'job', 'bootId', 'startNs', 'wallTimeNs'}
            and type(anchor['version']) is int and anchor['version'] == 1
            and anchor['run'] == env['GITHUB_RUN_ID'] and anchor['attempt'] == env['GITHUB_RUN_ATTEMPT']
            and anchor['job'] == 'selected-tests' and anchor['bootId'] == boot
            and anchor['startNs'] == env['AIHR_FOCUSED_JOB_MONOTONIC_NS']
            and isinstance(anchor['startNs'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', anchor['startNs']) is not None
            and isinstance(anchor['wallTimeNs'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', anchor['wallTimeNs']) is not None)
    job_start = int(anchor['startNs']) / 1e9
    elapsed = now - job_start
    # Reserve30s BEFORE the first executable step as well as the explicit
    # artifact tail. Authenticated API job.startedAt must independently
    # corroborate anchor.wallTimeNs minus job.startedAt <=30s after the run.
    require(0 <= elapsed < 1170 and stage in LIMITS)
    reserve = 30 if stage == 'stop' else 45 if stage in {'git-head', 'git-status', 'git-tracked', 'evidence', 'stats', 'logs', 'inspect'} else 120
    seconds = min(LIMITS[stage], 1170 - elapsed - reserve - 6)
    if stage == 'benchmark':
        require(seconds >= 900)
    if stage == 'native-controls':
        require(seconds >= 180)
    if stage == 'native-factory':
        # Original global setup allowance128s + three complete26s owners.
        # This is not the two-case180s profile or the900s benchmark clock.
        require(seconds >= 128 + 3 * 26)
    require(seconds > 0)
    return seconds, elapsed


def check_file_clock(witness, env, started, now, seconds):
    require(type(witness) is dict and set(witness) == {'version', 'run', 'attempt', 'startNs'}
            and type(witness['version']) is int and witness['version'] == 1
            and witness['run'] == env['GITHUB_RUN_ID'] and witness['attempt'] == env['GITHUB_RUN_ATTEMPT']
            and isinstance(witness['startNs'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', witness['startNs']) is not None)
    observed = int(witness['startNs']) / 1e9
    require(started <= observed <= now and observed + 900 <= started + seconds)
    return observed


def main():
    require(len(sys.argv) == 2)
    request = json.loads(sys.argv[1]); stage, argv, destination = request_command(request)
    require(re.fullmatch(r'[0-9a-f]{40}', os.environ['AIHR_CI_HEAD']) is not None
            and re.fullmatch(r'[0-9a-f]{40}', os.environ['AIHR_CI_CONTROL_HEAD']) is not None)
    binding = {'source': os.environ['AIHR_CI_HEAD'], 'controller': os.environ['AIHR_CI_CONTROL_HEAD'],
               'run': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'releaseAuthorized': False}
    event = lambda packet: append_event(destination / 'benchmark-supervisor.jsonl', {'stage': stage, **packet, **binding})
    try:
        anchor = json.loads(os.environ['AIHR_FOCUSED_JOB_ANCHOR'])
        seconds, elapsed = job_budget(stage, anchor, os.environ,
                                     Path('/proc/sys/kernel/random/boot_id').read_text().strip(), time.monotonic())
    except (ValueError, KeyError, TypeError):
        event({'kind': 'stage-refused', 'reason': 'job-envelope-refused'})
        return 1
    diagnostic_failed = False
    try:
        event({'kind': 'stage-started', 'budgetSeconds': seconds, 'jobElapsedSeconds': elapsed,
               'anchorWallTimeNs': anchor['wallTimeNs']})
    except BaseException:
        diagnostic_failed = True
        if stage != 'stop':
            return 1
    def file_clock(started, now):
        path = destination / 'employee-choice-native-purpose' / 'benchmark-clock.json'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        try:
            st = os.fstat(fd); require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and 0 < st.st_size <= 512)
            data = os.read(fd, 513); require(len(data) <= 512)
        finally:
            os.close(fd)
        witness = json.loads(data)
        observed = check_file_clock(witness, os.environ, started, now, seconds)
        ack = path.with_name('benchmark-clock-ack.json')
        pending = ack.with_name('benchmark-clock-ack.pending')
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            data = json.dumps(witness, separators=(',', ':')).encode()
            require(os.write(fd, data) == len(data))
        finally:
            os.close(fd)
        # Publish complete bytes exclusively; never overwrite a foreign ACK.
        os.link(pending, ack, follow_symlinks=False)
        os.unlink(pending)
        return observed
    result = supervise(argv, seconds, event, file_clock=file_clock if stage == 'benchmark' else None, mandatory=stage == 'stop')
    return 0 if not diagnostic_failed and result['reason'] == 'complete' and result['groupQuiescent'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, json.JSONDecodeError):
        sys.stderr.write('Closed benchmark supervision refused\n')
        sys.exit(1)
