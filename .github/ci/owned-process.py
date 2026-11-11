"""Private shared process ownership kernel, imported by closed context adapters.

No CLI, command selection, hosted context, environment admission or release proof.
The calling closed adapter owns argv, stage/budget and actual mode admission.
The unchanged kernel owns WNOWAIT/pidfd/subreaper/session settlement and telemetry.
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


def supervise(argv, seconds, event, *, clock=time.monotonic, monitor_fault=False, file_clock=None, file_seconds=900, mandatory=False):
    """Library inputs are fixed by CLI below; native controls supply tiny fixtures.
    A forked monitor never admits a command before session identity ACK. Parent
    never polls/reaps it through Popen; its reserved PID cannot name a new group.
    """
    require(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and hasattr(os, 'WNOWAIT'))
    require(type(seconds) in (int, float) and 0 < seconds <= 960)
    require(type(file_seconds) in (int, float) and 0 < file_seconds <= 960)
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
                    deadline = min(deadline, benchmark_start + file_seconds)
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


