"""Closed normal-CI adapter over the qualified source-loaded process kernel.
Not an argv broker, sandbox, focused impersonation or release receipt issuer.
"""
import hashlib
import json
import os
import re
import stat
import sys
import time
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
_kernel_path = ROOT / '.github/ci/owned-process.py'
_kernel = ModuleType('aihr_owned_process')
_kernel.__file__ = str(_kernel_path)
exec(compile(_kernel_path.read_bytes(), str(_kernel_path), 'exec', dont_inherit=True), _kernel.__dict__)
require = _kernel.require


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def regular(path, maximum, private=True):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum)
        require(not private or before.st_uid == os.getuid() and before.st_mode & 0o077 == 0)
        require(Path('/proc/self/fd/%d' % fd).resolve() == path)
        parts = []; remaining = before.st_size
        while remaining:
            part = os.read(fd, min(65536, remaining)); require(bool(part))
            parts.append(part); remaining -= len(part)
        require(os.read(fd, 1) == b'')
        after = os.fstat(fd)
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
        return b''.join(parts)
    finally:
        os.close(fd)


def packet(path, maximum=65536):
    return json.loads(regular(path, maximum), object_pairs_hook=pairs)


def publish(path, value):
    data = json.dumps(value, separators=(',', ':')).encode()
    require(len(data) <= 16384)
    path = Path(path)
    pending = path.with_name(path.name + '.pending')
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    owned = os.fstat(fd)
    try:
        require(os.write(fd, data) == len(data))
        os.link(pending, path, follow_symlinks=False)
    finally:
        os.close(fd)
        current = os.lstat(pending)
        require((current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino))
        os.unlink(pending)


def native_parent(expected):
    actual = _kernel.identity(os.getppid())
    argv = Path('/proc/%d/cmdline' % os.getppid()).read_bytes().split(b'\0')[:-1]
    require(actual['pid'] == expected['pid'] and str(actual['start']) == expected['start']
            and actual['parent'] == expected['parent'] and actual['group'] == expected['group']
            and actual['session'] == expected['session'])
    require(str(Path('/proc/%d/exe' % os.getppid()).resolve()) == expected['exe']
            and [arg.decode() for arg in argv] == expected['argv'])


def admission(request):
    require(type(request) is dict and set(request) == {'stage', 'file', 'node', 'controller', 'destination', 'preparation', 'testContext', 'sequence'})
    env = os.environ
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('CI') == 'true' and env.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and env.get('RUNNER_OS') == 'Linux' and env.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr'
            and env.get('GITHUB_WORKFLOW') == 'alpha-staging-ci' and env.get('GITHUB_JOB') == 'test' and env.get('GITHUB_RUN_ATTEMPT') == '1')
    require(not any(key.startswith('AIHR_FOCUSED_') for key in env))
    require(type(request['sequence']) is int and 0 < request['sequence'] < 100)
    registry_bytes = regular(ROOT / '.github/ci/employee-lifecycle-profile.json', 16384, False)
    registry = json.loads(registry_bytes, object_pairs_hook=pairs)
    require(registry['version'] == 1 and registry['normalJobSeconds'] == 1800 and registry['settlementSeconds'] == 6)
    profiles = [row for row in registry['files'] if row['file'] == request['file']]
    require(len(registry['files']) == 5 and len(profiles) == 1)
    profile = profiles[0]
    directory = Path(env['RUNNER_TEMP']).resolve() / 'aihr-ci'
    require(request['destination'] == str(directory) and directory.resolve() == directory and request['controller'] == str(ROOT))
    preparation = packet(request['preparation'])
    unit = preparation['unit']
    require(re.fullmatch(r'db-[0-9a-f]{16}', unit) is not None)
    require(request['preparation'] == str(directory / (unit + '-employee-preparation.json')))
    require(preparation['version'] == 1 and preparation['mode'] == 'full-ci-singleton' and preparation['file'] == request['file']
            and preparation['stage'] == profile['stage'] and preparation['registrySha256'] == hashlib.sha256(registry_bytes).hexdigest()
            and preparation['automation'] == str(ROOT) and preparation['evidenceDirectory'] == str(directory)
            and preparation['sourceRoot'] == str(Path.cwd().resolve()) and preparation['releaseAuthorized'] is False)
    for field, variable in [('source', 'AIHR_CI_HEAD'), ('controller', 'AIHR_CI_CONTROL_HEAD'), ('run', 'GITHUB_RUN_ID'), ('attempt', 'GITHUB_RUN_ATTEMPT')]:
        require(preparation[field] == env[variable])
    require(env.get('AIHR_CI_UNIT') == unit)
    expected_sources = {'.github/ci/employee-lifecycle.mjs', '.github/ci/employee-lifecycle-profile.mjs', '.github/ci/employee-lifecycle-profile.json', '.github/ci/employee-lifecycle-context.mjs', '.github/ci/employee-lifecycle-supervisor.py', '.github/ci/owned-process.py', '.github/ci/employee-postgres-resource.py', '.github/ci/run-unit.mjs'}
    require(set(preparation['controllerSources']) == expected_sources)
    for path, digest in preparation['controllerSources'].items():
        require(hashlib.sha256(regular(ROOT / path, 1048576, False)).hexdigest() == digest)
    parent = preparation['parent']; native_parent(parent)
    require(parent['argv'] == [request['node'], str(ROOT / '.github/ci/run-unit.mjs'), unit, str(directory)]
            and parent['exe'] == request['node'])
    anchor_path = directory / (unit + '-employee-job-anchor.json')
    require(preparation['anchorPath'] == env.get('AIHR_EMPLOYEE_JOB_ANCHOR') == str(anchor_path))
    anchor = packet(anchor_path, 16384)
    require(set(anchor) == {'version', 'run', 'attempt', 'job', 'unit', 'source', 'controller', 'bootId', 'startNs', 'wallTimeNs'} and anchor['version'] == 1)
    for field in ('run', 'attempt', 'unit', 'source', 'controller'):
        require(anchor[field] == preparation[field])
    require(anchor['job'] == 'test' and anchor['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    require(all(type(anchor[key]) is str and re.fullmatch(r'[1-9][0-9]{0,19}', anchor[key]) for key in ('startNs', 'wallTimeNs')))
    elapsed = time.monotonic() - int(anchor['startNs']) / 1e9
    stage = request['stage']; test = stage == profile['stage']
    limits = {'git-head': 10, 'git-status': 10, 'git-tracked': 10, 'evidence': 30, 'classifier': 15, 'reset': 60, 'migrate': 60, 'stats': 10, 'logs': 10, 'inspect': 10, 'stop': 9, profile['stage']: profile['stageSeconds']}
    require(stage in limits and 0 <= elapsed < 1770)
    reserve = 30 if stage == 'stop' else 30 + 120 + 15
    seconds = min(limits[stage], 1800 - elapsed - reserve - 6)
    require(seconds > 0 and (not test or seconds >= profile['stageSeconds']))
    if test:
        context_path = directory / (unit + '-employee-test-context.json')
        require(request['testContext'] == env.get('AIHR_EMPLOYEE_LIFECYCLE_CONTEXT') == str(context_path))
        context = packet(context_path)
        require(context == {**preparation, 'preparationSha256': hashlib.sha256(regular(request['preparation'], 65536)).hexdigest(),
                            'singletonPath': str(directory / (unit + '-singleton.json')), 'singletonSha256': context['singletonSha256']})
        require(hashlib.sha256(regular(context['singletonPath'], 1048576)).hexdigest() == context['singletonSha256'])
    else:
        require(request['testContext'] is None)
    node = request['node']; name = 'aihr-ci-%s-%s-%s' % (preparation['run'], preparation['attempt'], unit)
    vitest = Path.cwd() / 'node_modules/vitest/vitest.mjs'
    if test:
        require(vitest.is_file() and (Path.cwd() / 'node_modules').resolve() == Path.cwd() / 'node_modules'
                and (Path.cwd() / 'node_modules') in vitest.resolve().parents)
    commands = {'git-head': ['git', 'rev-parse', 'HEAD'], 'git-status': ['git', 'status', '--porcelain'],
                'git-tracked': ['git', 'ls-files', '--stage', '-z', '--', 'test'],
                'evidence': [node, str(ROOT / '.github/ci/postgres-evidence.mjs')],
                'classifier': [node, '--import', 'tsx', 'scripts/gate-db-classify.ts', 'explain'],
                'reset': [str(Path('/proc/self/exe').resolve()), '-I', '-B', str(ROOT / '.github/ci/employee-postgres-resource.py'), 'reset'], 'migrate': ['pnpm', 'db:migrate'],
                'stats': [str(Path('/proc/self/exe').resolve()), '-I', '-B', str(ROOT / '.github/ci/employee-postgres-resource.py'), 'stats'], 'logs': ['docker', 'logs', name],
                'inspect': ['docker', 'inspect', '--format', '{{json .State}}', name], 'stop': [str(Path('/proc/self/exe').resolve()), '-I', '-B', str(ROOT / '.github/ci/employee-postgres-resource.py'), 'stop'],
                profile['stage']: [node, str(vitest), 'run', profile['file'], '--reporter=default', '--reporter=json', '--outputFile.json=' + str(directory / (unit + '-batch-0.json'))]}
    return preparation, profile, seconds, elapsed, commands[stage], directory


def main():
    require(len(sys.argv) == 2)
    request = json.loads(sys.argv[1], object_pairs_hook=pairs)
    preparation, profile, seconds, elapsed, argv, directory = admission(request)
    stage = request['stage']; test = stage == profile['stage']
    binding = {key: preparation[key] for key in ('source', 'controller', 'run', 'attempt', 'unit', 'file', 'fingerprint')}
    binding.update({'mode': 'full-ci-singleton', 'releaseAuthorized': False, 'stage': stage, 'sequence': request['sequence']})
    event_path = directory / (preparation['unit'] + '-employee-supervisor.jsonl')
    def event(value):
        _kernel.append_event(event_path, {**binding, **value, 'monotonicNs': str(time.monotonic_ns()), 'wallTimeNs': str(time.time_ns())})
        if test and value['kind'] == 'session-admitted':
            native_parent(preparation['parent'])
            publish(directory / (preparation['unit'] + '-employee-monitor.json'), {**binding,
                    'version': 1, 'preparationSha256': hashlib.sha256(regular(request['preparation'], 65536)).hexdigest(),
                    'testContextSha256': hashlib.sha256(regular(request['testContext'], 65536)).hexdigest(),
                    'supervisor': {'pid': os.getpid(), 'start': str(_kernel.identity(os.getpid())['start'])},
                    'monitor': {'pid': value['pid'], 'start': str(value['start'])}})
    diagnostic_failed = False
    try:
        event({'kind': 'stage-started', 'budgetSeconds': seconds, 'jobElapsedSeconds': elapsed})
    except BaseException:
        diagnostic_failed = True
        if stage != 'stop':
            return 1
    def file_clock(started, now):
        path = directory / profile['clockDirectory'] / 'benchmark-clock.json'
        try:
            witness = packet(path, 512)
        except FileNotFoundError:
            return None
        require(set(witness) == {'version', 'run', 'attempt', 'startNs'} and witness['version'] == 1)
        require(witness['run'] == preparation['run'] and witness['attempt'] == preparation['attempt']
                and type(witness['startNs']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', witness['startNs']) is not None)
        observed = int(witness['startNs']) / 1e9
        require(started <= observed <= now and observed + 900 <= started + seconds)
        publish(path.with_name('benchmark-clock-ack.json'), witness)
        return observed
    result = _kernel.supervise(argv, seconds, event, file_clock=file_clock if test and profile['clockDirectory'] is not None else None, mandatory=stage == 'stop')
    publish(directory / ('%s-employee-stage-%d.json' % (preparation['unit'], request['sequence'])), {**binding, 'version': 1, 'result': result})
    return 0 if not diagnostic_failed and result['reason'] == 'complete' and result['groupQuiescent'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError):
        sys.stderr.write('Closed normal employee lifecycle refused\n')
        sys.exit(1)
