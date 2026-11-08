"""Closed two-attempt classifier diagnostic. No classifier/plan/kernel changes.

Native work is owned exclusively by the unchanged qualified shared kernel.
The clock always returns its actual monotonic observation unchanged; it neither
extends deadlines nor turns unavailable native samples into zero cost.
"""
import hashlib
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

ROOT = Path(__file__).resolve().parents[3]
SELECTOR = 'test/gate-db-classifier-timeout-diagnostic.test.ts'
MANIFEST = 'docs/qualification/db-classifier-owner-loss-correction-source-20261108.json'
CLASSIFIER_SHA = 'cc77445ba5b8a702a5f8f4a4292bdcb99275d520ae4f13b16442a17e78f3f916'
KERNEL_SHA = 'cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c'
LOG_MAX = 16 * 1024**2
META_MAX = 4 * 1024**2
kernel_path = ROOT / '.github/ci/owned-process.py'
assert hashlib.sha256(kernel_path.read_bytes()).hexdigest() == KERNEL_SHA
K = ModuleType('classifier_qualified_owner'); K.__file__ = str(kernel_path)
exec(compile(kernel_path.read_bytes(), str(kernel_path), 'exec', dont_inherit=True), K.__dict__)
require = K.require
digest = lambda raw: hashlib.sha256(raw).hexdigest()


def bounded(path, maximum=META_MAX):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
                and not before.st_mode & 0o022 and 0 <= before.st_size <= maximum)
        parts, count = [], 0
        while True:
            raw = os.read(fd, min(65536, maximum + 1 - count))
            if not raw:
                break
            parts.append(raw); count += len(raw); require(count <= maximum)
        after, named = os.fstat(fd), Path(path).lstat()
        require(all(getattr(before, key) == getattr(after, key) == getattr(named, key)
                    for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')))
        require(count == before.st_size and Path(path).resolve() == Path(path))
        return b''.join(parts)
    finally:
        os.close(fd)


def proc_bytes(pid, name, maximum=65536):
    require(type(pid) is int and pid > 1 and name in ('stat', 'io', 'cmdline', 'task-children'))
    suffix = 'task/%s/children' % pid if name == 'task-children' else name
    fd = os.open('/proc/%s/%s' % (pid, suffix), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        value = os.read(fd, maximum + 1); require(len(value) <= maximum); return value
    finally:
        os.close(fd)


def stat_row(raw, pid):
    end = raw.rfind(b') '); require(end > 0 and raw.startswith(str(pid).encode() + b' ('))
    fields = raw[end + 2:].split(); require(len(fields) >= 22)
    row = dict(pid=pid, parent=int(fields[1]), group=int(fields[2]), session=int(fields[3]),
               start=int(fields[19]), state=fields[0].decode(), userTicks=int(fields[11]),
               systemTicks=int(fields[12]), rssPages=int(fields[21]))
    require(all(type(row[key]) is int and row[key] >= 0 for key in ('parent', 'group', 'session', 'start', 'userTicks', 'systemTicks', 'rssPages')))
    return row


def io_row(raw):
    wanted = ('rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes')
    rows = {}
    for line in raw.decode('ascii').splitlines():
        key, value = line.split(':', 1)
        if key in wanted:
            require(key not in rows and re.fullmatch(r'\s*[0-9]+', value) is not None); rows[key] = int(value)
    require(set(rows) == set(wanted)); return rows


def identity_fields(row):
    return {key: row[key] for key in ('pid', 'parent', 'group', 'session', 'start')}


class NativeSampler:
    """Read only the admitted monitor's one exact actual native Node child."""
    def __init__(self, node):
        self.node, self.monitor, self.child, self.descriptor = node, None, None, None
        self.samples, self.failures, self.initial, self.last, self.peak = 0, [], None, None, 0

    def admit(self, packet):
        require(self.monitor is None and packet['kind'] == 'session-admitted')
        row = stat_row(proc_bytes(packet['pid'], 'stat'), packet['pid'])
        require(row['start'] == packet['start'] and row['parent'] == os.getpid()
                and row['group'] == row['session'] == row['pid'] and row['state'] not in ('Z', 'X'))
        self.monitor = identity_fields(row)

    def unavailable(self, code):
        if code not in self.failures:
            self.failures.append(code)

    def sample(self, now):
        if self.monitor is None or self.failures:
            return
        try:
            monitor = stat_row(proc_bytes(self.monitor['pid'], 'stat'), self.monitor['pid'])
            require(identity_fields(monitor) == self.monitor and monitor['state'] not in ('Z', 'X'))
            children = proc_bytes(monitor['pid'], 'task-children').split()
            if self.child is None:
                if not children:
                    return  # ACK-to-exec interval; no zero-cost sample inferred.
                require(len(children) == 1); pid = int(children[0])
                first = stat_row(proc_bytes(pid, 'stat'), pid)
                require(first['parent'] == monitor['pid'] and first['group'] == first['session'] == monitor['pid'])
                # A just-forked monitor child has not exec'd Node yet.
                if Path('/proc/%s/exe' % pid).resolve() != self.node:
                    return
                descriptor = os.pidfd_open(pid)
                try:
                    after = stat_row(proc_bytes(pid, 'stat'), pid); require(identity_fields(first) == identity_fields(after))
                except BaseException:
                    os.close(descriptor); raise
                self.child, self.descriptor = identity_fields(after), descriptor
            require(children == [str(self.child['pid']).encode()])
            if select.select([self.descriptor], [], [], 0)[0]:
                self.unavailable('native-child-exited-before-next-sample'); return
            before = stat_row(proc_bytes(self.child['pid'], 'stat'), self.child['pid'])
            require(identity_fields(before) == self.child and before['state'] not in ('Z', 'X'))
            require(Path('/proc/%s/exe' % before['pid']).resolve() == self.node)
            counters = io_row(proc_bytes(before['pid'], 'io'))
            after = stat_row(proc_bytes(before['pid'], 'stat'), before['pid'])
            require(identity_fields(after) == self.child and after['state'] not in ('Z', 'X')
                    and Path('/proc/%s/exe' % after['pid']).resolve() == self.node
                    and not select.select([self.descriptor], [], [], 0)[0])
            value = {'elapsedSeconds': now, 'userTicks': after['userTicks'], 'systemTicks': after['systemTicks'],
                     'rssBytes': after['rssPages'] * os.sysconf('SC_PAGE_SIZE'), 'io': counters}
            self.initial = self.initial or value; self.last = value; self.samples += 1; self.peak = max(self.peak, value['rssBytes'])
        except (OSError, ValueError, AssertionError, KeyError):
            self.unavailable('native-sample-identity-or-counter-unavailable')

    def close(self):
        if self.descriptor is not None:
            descriptor, self.descriptor = self.descriptor, None; os.close(descriptor)

    def summary(self):
        # No PID, executable path or raw proc content crosses this boundary.
        return {'kind': 'PARTIAL_PINNED_NATIVE_COUNTERS_NOT_COMPLETE_COST', 'sampleCount': self.samples,
                'available': self.samples > 0, 'unavailable': self.failures or ([] if self.samples else ['no-admitted-native-sample']),
                'clockTicksPerSecond': os.sysconf('SC_CLK_TCK'), 'peakSampledRssBytes': self.peak if self.samples else None,
                'first': self.initial, 'last': self.last, 'wholeProcessCostProved': False}


def admit():
    require(len(sys.argv) == 1 and sys.platform == 'linux' and os.getuid() > 0)
    expected = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux',
                'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr', 'GITHUB_WORKFLOW': 'alpha-focused-checks',
                'GITHUB_JOB': 'selected-tests', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1'}
    require(all(os.environ.get(key) == value for key, value in expected.items())
            and json.loads(os.environ.get('AIHR_FOCUSED_TESTS', 'null')) == [SELECTOR]
            and re.fullmatch(r'[1-9][0-9]{0,19}', os.environ['GITHUB_RUN_ID']) is not None
            and all(re.fullmatch(r'[a-f0-9]{40}', os.environ[key]) is not None for key in ('AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD')))
    workspace, temp = Path(os.environ['GITHUB_WORKSPACE']), Path(os.environ['RUNNER_TEMP'])
    source, controller, evidence = workspace / 'source', workspace / 'automation', temp / 'aihr-focused'
    require(all(path.is_absolute() and path.resolve() == path for path in (workspace, temp, source, controller, evidence))
            and ROOT == source and Path.cwd().resolve() == source and os.environ['AIHR_FOCUSED_EVIDENCE_DIR'] == str(evidence))
    node = Path('/proc/%s/exe' % os.getppid()).resolve()
    args = proc_bytes(os.getppid(), 'cmdline').rstrip(b'\0').decode().split('\0')
    worker = (source / 'node_modules/vitest/dist/workers/forks.js').resolve()
    require(args and Path(args[-1]).resolve() == worker and node.is_absolute())
    raw = bounded(source / MANIFEST); require(raw == bounded(controller / MANIFEST)); declaration = json.loads(raw)
    require(declaration['kind'] == 'CLASSIFIER_TIMEOUT_DIAGNOSTIC_SOURCE_ONLY_NOT_ACCEPTANCE')
    for name, wanted in declaration['componentSources'].items():
        require(isinstance(name, str) and not name.startswith('/') and '..' not in name.split('/')
                and re.fullmatch(r'[a-f0-9]{64}', wanted) is not None)
        require(digest(bounded(source / name)) == wanted and digest(bounded(controller / name)) == wanted)
    require(all(name in declaration['componentSources'] for name in (SELECTOR, '.github/ci/diagnostics/db-classifier-timeout.py', '.github/ci/diagnostics/db-classifier-timeout-profile.mjs', 'scripts/gate-db-classify.ts', '.github/ci/owned-process.py', '.github/ci/plan.mjs')))
    require(digest(bounded(source / 'scripts/gate-db-classify.ts')) == CLASSIFIER_SHA)
    return source, evidence, node, declaration


def atomic_json(path, value):
    raw = (json.dumps(value, separators=(',', ':')) + '\n').encode(); require(len(raw) <= META_MAX)
    pending = Path(str(path) + '.pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        before = os.fstat(fd); require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid())
        require(os.write(fd, raw) == len(raw))
    finally:
        os.close(fd)
    os.replace(pending, path)


def main():
    source, evidence, node, declaration = admit(); out = evidence / 'db-classifier-timeout'; out.mkdir(mode=0o700)
    suite = declaration['suite']; require(suite == sorted(set(suite)) and all(re.fullmatch(r'test/[A-Za-z0-9_./-]+(?:\.test\.ts|\.dom\.test\.tsx)', name) is not None for name in suite))
    stdin = ('\n'.join(suite) + '\n').encode(); require(digest(stdin) == declaration['stdinSha256'])
    (out / 'stdin.txt').write_bytes(stdin); os.chmod(out / 'stdin.txt', 0o600)
    reference = bounded(source / 'scripts/gate-db-classify.ts'); (out / 'classifier-reference.ts').write_bytes(reference); os.chmod(out / 'classifier-reference.ts', 0o600)
    binding = {'source': os.environ['AIHR_CI_HEAD'], 'controller': os.environ['AIHR_CI_CONTROL_HEAD'], 'run': os.environ['GITHUB_RUN_ID'],
               'suiteCount': len(suite), 'suiteSha256': declaration['suiteSha256'], 'stdinSha256': digest(stdin), 'classifierSha256': digest(reference)}
    atomic_json(out / 'binding.json', binding)
    report = {'kind': 'CLASSIFIER_TIMEOUT_CAUSAL_DIAGNOSTIC_NOT_ACCEPTANCE', **binding, 'complete': False, 'classificationAdopted': False,
              'workSecondsPerAttempt': 15, 'kernelSettlementSeconds': 6, 'kernelSha256': KERNEL_SHA, 'attempts': [],
              'stdinTransport': 'exact fixed bytes through regular stdin descriptor; normal plan uses an input pipe',
              'deadlineStop': 'unchanged qualified kernel group SIGKILL; normal plan timeout sends SIGTERM'}
    atomic_json(out / 'report.json', report)
    # No credentials, provider configuration, DB URLs or caller runtime flags.
    clean = {key: os.environ[key] for key in ('PATH', 'HOME', 'RUNNER_TEMP', 'GITHUB_WORKSPACE', 'GITHUB_ACTIONS', 'CI', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'AIHR_CI_HEAD', 'AIHR_CI_CONTROL_HEAD', 'AIHR_FOCUSED_TESTS', 'AIHR_FOCUSED_EVIDENCE_DIR') if key in os.environ}
    clean.update({'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC'}); os.environ.clear(); os.environ.update(clean)
    primary = None
    try:
        for phase in ('inventory', 'baseline', 'profile'):
            _run_phase(phase, binding, report)
            if phase == 'inventory':
                rows = bounded(out / 'inventory.stdout', LOG_MAX).decode().split('\0'); tracked = []
                for row in filter(None, rows):
                    metadata, name = row.split('\t'); mode, oid, stage = metadata.split(); require(mode in ('100644', '100755') and stage == '0' and re.fullmatch(r'[a-f0-9]{40}', oid) is not None)
                    if re.search(r'\.test\.ts$|\.dom\.test\.tsx$', name): tracked.append(name)
                require(sorted(tracked) == suite)
        report['complete'] = True
    except BaseException as error:
        primary = error; report['failure'] = {'kind': type(error).__name__}; report['blocked'] = [phase for phase in ('inventory', 'baseline', 'profile') if phase not in [row['phase'] for row in report['attempts']]]; raise
    finally:
        try:
            atomic_json(out / 'report.json', report)
        except BaseException as error:
            if primary is not None:
                raise BaseExceptionGroup('Classifier diagnostic and partial report failed', [primary, error])
            raise




def require_upstream_before_ack(descriptor, state):
    # The qualified kernel emits session-admitted before ACK and swallows a
    # refused event into its mandatory no-ACK cleanup. Never admit late work.
    require(descriptor is not None)
    if select.select([descriptor], [], [], 0)[0]:
        state['ownerLost'] = True
        state['transportFailures'].append('upstream-owner-lost-before-workload-ack')
        require(False)


def qualified_kernel_interrupt(handler):
    # Exact code object AND globals from the hash-verified loaded kernel, not a
    # caller bool, source filename alone or a same-named foreign Python function.
    return (callable(handler) and getattr(handler, '__globals__', None) is K.__dict__
            and any(isinstance(code, type(K.supervise.__code__)) and code.co_name == 'interrupt'
                    and getattr(handler, '__code__', None) is code for code in K.supervise.__code__.co_consts))


def phase_clock(state, *, parent_fd, drain, sampler, phase, errors):
    """Internal read/cleanup clock seam, never a command or admission interface."""
    def clock():
        if state['start'] is None:
            actual = time.monotonic(); state['start'] = actual; return actual
        # The kernel also calls its clock during pre-handler/no-ACK pidfd-open
        # failure cleanup. Owner loss must never SELF-TERM under a default or
        # foreign handler and interrupt that mandatory cleanup.
        try:
            descriptor = parent_fd()
            if descriptor is not None and select.select([descriptor], [], [], 0)[0] and not state['ownerLost']:
                state['ownerLost'] = True
                if qualified_kernel_interrupt(signal.getsignal(signal.SIGTERM)):
                    os.kill(os.getpid(), signal.SIGTERM)  # Exact active kernel handler, SELF only.
                else:
                    state['transportFailures'].append('upstream-owner-lost-without-qualified-handler')
            drain()
            if not state['settling'] and phase != 'inventory': sampler.sample(time.monotonic() - state['start'])
        except BaseException as error:
            name = type(error).__name__
            if name not in state['transportFailures']:
                state['transportFailures'].append(name)
            # Distinct failures of the same class must remain distinct causes.
            errors().append(error)
        return time.monotonic()  # Fresh ACTUAL time, never a shifted work clock.
    return clock


def _run_phase(phase, binding, report):
    """Fixed caller only. No exported command selection or acceptance API."""
    require(phase in ('inventory', 'baseline', 'profile')); source, evidence, node, _declaration = admit(); out = evidence / 'db-classifier-timeout'
    seconds = 10 if phase == 'inventory' else 15
    args = ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage', '-z', '--', 'test'] if phase == 'inventory' else [str(node), '--experimental-strip-types', 'scripts/gate-db-classify.ts', 'explain'] if phase == 'baseline' else [str(node), '--experimental-strip-types', str(source / '.github/ci/diagnostics/db-classifier-timeout-profile.mjs')]
    streams, originals, reads, outputs = [], [], [], []; parent_fd = None; sampler = NativeSampler(node); state = {'start': None, 'settling': False, 'transportFailures': [], 'ownerLost': False}
    def event(packet):
        try:
            if packet['kind'] == 'session-admitted':
                require_upstream_before_ack(parent_fd, state)
                atomic_json(out / (phase + '-clock.json'), {**binding, 'workSeconds': seconds, 'startSeconds': state['start']})
                sampler.admit(packet)
            if packet['kind'] == 'group-stop-before-reap': state['settling'] = True
            K.append_event(out / 'native-ownership.jsonl', {'phase': phase, **packet})
        except BaseException as error:
            errors.append(error); raise  # Kernel still owns mandatory settlement.

    def drain():
        for index, fd in enumerate(reads):
            for _ in range(256):
                try: raw = os.read(fd, 65536)
                except BlockingIOError: break
                if not raw: break
                count = sum(os.fstat(value).st_size for value in outputs)
                if count + len(raw) > LOG_MAX:
                    state['transportFailures'].append('combined-native-output-bound'); return
                require(os.write(outputs[index], raw) == len(raw))
    clock = phase_clock(state, parent_fd=lambda: parent_fd, drain=drain, sampler=sampler,
                        phase=phase, errors=lambda: errors)

    result, errors = None, []
    def attempt(work):
        try: return work()
        except BaseException as error: errors.append(error); return None
    try:
        parent = os.getppid(); before = K.identity(parent); parent_fd = os.pidfd_open(parent)
        require(identity_fields(K.identity(parent)) == identity_fields(before) and os.getppid() == parent and not select.select([parent_fd], [], [], 0)[0])
        for number, suffix in ((1, 'stdout'), (2, 'stderr')):
            original = os.dup(number); originals.append((number, original))
            read, write = os.pipe(); os.set_blocking(read, False); reads.append(read); streams.append(write)
            outputs.append(os.open(out / (phase + '.' + suffix), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)); os.dup2(write, number)
        original_input = os.dup(0); originals.append((0, original_input)); input_fd = os.open(out / 'stdin.txt', os.O_RDONLY | os.O_NOFOLLOW); streams.append(input_fd); os.dup2(input_fd, 0)
        result = K.supervise(args, seconds, event, clock=clock)
    except BaseException as error:
        errors.append(error)
    finally:
        for number, original in reversed(originals):
            attempt(lambda number=number, original=original: os.dup2(original, number)); attempt(lambda original=original: os.close(original))
        for fd in streams: attempt(lambda fd=fd: os.close(fd))
        attempt(drain); attempt(sampler.close)
        if parent_fd is not None: attempt(lambda: os.close(parent_fd))
        for fd in [*reads, *outputs]: attempt(lambda fd=fd: os.close(fd))
        observed_outputs = {}
        for suffix in ('stdout', 'stderr'):
            raw = attempt(lambda suffix=suffix: bounded(out / (phase + '.' + suffix), LOG_MAX))
            observed_outputs[suffix] = None if raw is None else {'bytes': len(raw), 'sha256': digest(raw)}
        result_row = {'phase': phase, 'native': result, 'sampled': sampler.summary(), 'transportFailures': state['transportFailures'], 'ownerLost': state['ownerLost'],
                      'elapsedSeconds': time.monotonic() - state['start'] if state['start'] is not None else None,
                      'nativeWorkCompleted': result is not None and result['reason'] == 'complete' and result['commandExit'] == 0,
                      'classificationAdopted': False, 'outputs': observed_outputs, 'failures': [{'kind': type(error).__name__} for error in errors]}
        if phase == 'profile' and (out / 'profile-progress.json').exists():
            result_row['partialProgress'] = attempt(lambda: json.loads(bounded(out / 'profile-progress.json', 8192)))
        result_row['failures'] = [{'kind': type(error).__name__} for error in errors]
        report['attempts'].append(result_row); attempt(lambda: atomic_json(out / 'report.json', report))
        result_row['failures'] = [{'kind': type(error).__name__} for error in errors]
    if len(errors) == 1: raise errors[0]
    if errors: raise BaseExceptionGroup('Classifier process and mandatory output settlement failed', errors)
    require(result is not None and result['admitted'] and result['reaped'] and result['groupQuiescent'] and not result['escapedSession'] and not state['transportFailures'] and not state['ownerLost'])
    require(result['reason'] == 'complete' and result['commandExit'] == 0 if phase == 'inventory' else result['reason'] in ('complete', 'command-failed', 'deadline'))
    if phase == 'profile': require(result_row.get('partialProgress') is not None)


if __name__ == '__main__':
    main()
