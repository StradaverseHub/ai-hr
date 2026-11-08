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
# Compile the fixed source-owned sibling bytes directly. -I/-B do not stop
# SourceFileLoader from reading an ignored timestamp-valid .pyc.
from types import ModuleType
_kernel_path = Path(__file__).resolve().with_name('owned-process.py')
_owned_process = ModuleType('aihr_owned_process')
_owned_process.__file__ = str(_kernel_path)
exec(compile(_kernel_path.read_bytes(), str(_kernel_path), 'exec', dont_inherit=True), _owned_process.__dict__)
require = _owned_process.require
append_event = _owned_process.append_event
supervise = _owned_process.supervise
own_children = _owned_process.own_children


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
