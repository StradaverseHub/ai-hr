"""Closed evidence checks for the parallel 2/4/8 worker course.

verify-cell  Bind one runner's sealed cell summary to its owner outputs before publication.
aggregate    Read every published cell and publish a sanitized aggregate in two tiers.
             Release tier: every cell passes its own gates on the standard runner class,
             from one build and one 2/4 fixture day. Any failure fails the aggregate.
             Scaling tier: the 2-versus-4 comparison is claimed only when both cells passed
             on the same CPU model and vCPU. Otherwise it is not claimed and no scaling
             number is published; that alone does not fail the aggregate.

Neither mode grants staging, production or release authority.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

KIND = 'HOSTED_WORKER_COMPARISON_CELL_V1'
AGGREGATE_KIND = 'HOSTED_WORKER_COMPARISON_AGGREGATE_V1'
LIMIT = 128 * 1024
COURSES = {
    'parallel-2-4-8': (('2', 'steady-2', 'steady-500'), ('4', 'steady-4', 'steady-500'),
                       ('8', 'functional-8', 'functional-diagnostic-only')),
    'parallel-smoke': (('2', 'smoke-2', 'smoke-harness-only'), ('4', 'smoke-4', 'smoke-harness-only'),
                       ('8', 'smoke-8', 'smoke-harness-only')),
}
CELL_FIELDS = {'kind', 'releaseEligible', 'course', 'identity', 'prerequisite', 'frontiers', 'buildSeal', 'transport',
               'seedSettlement', 'cell', 'complete', 'host', 'productionEquivalent', 'scope', 'processOwner'}
HOST_FIELDS = {'effectiveCpus', 'memoryBytes', 'nodeVersion', 'postgresProfile', 'cpuModel', 'logicalCpus', 'kernel'}
SEAL_FIELDS = {'buildId', 'entries', 'bytes', 'sha256'}
# A 2-versus-4 scaling claim needs these to match; the rest of the specification is reported, not hidden.
SCALING_VCPU = ('effectiveCpus', 'logicalCpus')
SCALING_MATCH = ('cpuModel',) + SCALING_VCPU
REPORTED = ('memoryBytes', 'kernel', 'nodeVersion')
# Every cell must be the standard hosted class: a smaller machine fails whatever its CPU model.
RUNNER_VCPUS = 4
RUNNER_MEMORY_BYTES = (15 * 1024 ** 3, 17 * 1024 ** 3)
ROLES = ('employee', 'manager', 'companyHR', 'groupHR')
WORK = ('navigation', 'read', 'write')
LATENCY = ('samples', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs')


class Refused(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def unique(pairs):
    value = dict(pairs)
    require(len(value) == len(pairs), 'duplicate JSON field')
    return value


def nonfinite(_):
    raise Refused('non-finite JSON constant')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns)


def read_bounded(path, exact_mode=None):
    """Read one regular owned file without following links; refuse it if it changes."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                and 0 < before.st_size <= LIMIT and (before.st_mode & 0o022) == 0
                and (exact_mode is None or stat.S_IMODE(before.st_mode) == exact_mode), 'evidence file identity')
        raw = stream.read(LIMIT + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(stream.fileno()))
                == identity(os.lstat(path)), 'evidence file changed during read')
    return raw


def parse(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite)
    except (ValueError, RecursionError):
        raise Refused('evidence JSON') from None


def expected_identity(env):
    sha = env.get('AIHR_CI_HEAD', '')
    run = env.get('GITHUB_RUN_ID', '')
    require(re.fullmatch(r'[a-f0-9]{40}', sha) and sha == env.get('GITHUB_WORKFLOW_SHA')
            and re.fullmatch(r'[1-9][0-9]{0,15}', run), 'aggregate identity')
    return {'candidateSha': sha, 'controllerSha': sha, 'runId': int(run), 'runAttempt': 1}


def course_of(env):
    course = env.get('AIHR_MEASURED_BROWSER_COURSE')
    require(course in COURSES, 'parallel course')
    return course


def seal_of(value):
    require(type(value) is dict and set(value) == SEAL_FIELDS and type(value['buildId']) is str
            and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['buildId'])
            and all(type(value[key]) is int and value[key] > 0 for key in ('entries', 'bytes'))
            and type(value['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', value['sha256']), 'build seal')
    return value


def host_of(value):
    require(type(value) is dict and set(value) == HOST_FIELDS
            and type(value['cpuModel']) is str and re.fullmatch(r'[\x20-\x7e]{1,256}', value['cpuModel'])
            and all(type(value[key]) is int and value[key] > 0 for key in ('effectiveCpus', 'logicalCpus', 'memoryBytes'))
            and type(value['kernel']) is str and re.fullmatch(r'[0-9A-Za-z._+~-]{1,128}', value['kernel'])
            and type(value['nodeVersion']) is str and value['postgresProfile'] == 2, 'runner specification')
    return value


def runner_class_ok(host):
    return (host['effectiveCpus'] == RUNNER_VCPUS and host['logicalCpus'] == RUNNER_VCPUS
            and RUNNER_MEMORY_BYTES[0] <= host['memoryBytes'] <= RUNNER_MEMORY_BYTES[1])


def record(value):
    return value if type(value) is dict else {}


def gate_results(observation, scope, host):
    """Per-cell release gates from the published evidence, independent of the runner's verdict and CPU matching.

    A failed gate is an observed violation. An unobserved gate had no receipt, for example when the
    driver stopped early, and is never reported as a violation; a cell still cannot pass with one.
    """
    driver = record(observation.get('driver'))
    locks = record(driver.get('locks'))
    zero = lambda value: None if type(value) is not int else value == 0
    flag = lambda value: value if type(value) is bool else None
    gates = {
        'runner-class': runner_class_ok(host),
        'driver-complete': flag(driver.get('complete')),
        'busy': zero(driver.get('busyResponses')),
        'page-crashes': zero(record(driver.get('pageEvents')).get('qualifiedCrashes')),
        'worker-crashes': zero(observation.get('workerCrashes')),
        'browser-errors': zero(observation.get('browserErrors')),
        'preflight-lock-sampler': flag(record(locks.get('preflight')).get('pass')),
        'runtime-acceptance': flag(record(observation.get('runtimeAcceptance')).get('pass')),
        'database-lock-waits': zero(record(observation.get('postgresWaitLog')).get('retainedFailures')),
    }
    if scope == 'steady-500':
        gates['loaded-lock-sampler'] = flag(record(locks.get('loaded')).get('pass'))
    return (sorted(name for name, result in gates.items() if result is False),
            sorted(name for name, result in gates.items() if result is None))


def check_cell(summary, course, workers, expected, seal=None, archive=None):
    """Return the closed facts of one cell summary. Raises Refused on any foreign shape."""
    row = next((row for row in COURSES[course] if row[0] == workers), None)
    require(row is not None, 'cell worker count')
    _, name, scope = row
    require(type(summary) is dict and set(summary) == CELL_FIELDS and summary['kind'] == KIND
            and summary['releaseEligible'] is False and summary['productionEquivalent'] is False
            and summary['course'] == course and summary['identity'] == expected, 'cell identity')
    owner = summary['processOwner']
    require(type(owner) is dict and set(owner) == {'settled', 'cellBarriers', 'runnerExitCode', 'exitedOutsideSession'}
            and type(owner['exitedOutsideSession']) is int and 0 <= owner['exitedOutsideSession'] <= 1024
            and owner['settled'] is True
            and type(owner['cellBarriers']) is int and 0 <= owner['cellBarriers'] <= 1
            and type(owner['runnerExitCode']) is int, 'cell process owner')
    cell = summary['cell']
    require(type(cell) is dict and cell.get('name') == name and cell.get('scope') == scope
            and cell.get('state') in ('passed', 'failed', 'not-entered'), 'cell result')
    if course == 'parallel-smoke':
        require(summary['prerequisite'] is None, 'smoke prerequisite')
    else:
        require(type(summary['prerequisite']) is dict and summary['prerequisite'].get('source') == expected['candidateSha'],
                'cell prerequisite')
    host = host_of(summary['host'])
    transport = summary['transport']
    require(type(transport) is dict and set(transport) == {'seal', 'archiveSha256', 'archiveBytes'}
            and seal_of(transport['seal']) == transport['seal'], 'cell transport')
    if seal is not None:
        require(transport['seal'] == seal and transport['archiveSha256'] == archive, 'cell installed another build')
    build_seal = summary['buildSeal']
    if build_seal is not None:
        require(seal_of(build_seal) == transport['seal'], 'cell build seal differs from its transport')
    settled = (summary['complete'] is True and cell['state'] == 'passed' and owner['cellBarriers'] == 1
               and owner['runnerExitCode'] == 0 and build_seal == transport['seal'] and summary['seedSettlement'] == 'settled')
    if summary['complete'] is True:
        require(settled, 'complete cell without settled proof')
    observation = cell.get('observation') if type(cell.get('observation')) is dict else {}
    gates, unobserved = gate_results(observation, scope, host)
    passed = settled and not gates and not unobserved
    driver = observation.get('driver') if type(observation.get('driver')) is dict else {}
    harness = driver.get('identity') if type(driver.get('identity')) is dict else {}
    phases = observation.get('phaseStatus') if type(observation.get('phaseStatus')) is list else []
    failed = [row.get('label') for row in phases if type(row) is dict and (row.get('exitCode') != 0 or row.get('timedOut') is not False)]
    failed_phase = failed[0] if failed and type(failed[0]) is str and re.fullmatch(r'[a-z-]{1,64}', failed[0]) else None
    return {'workers': int(workers), 'name': name, 'scope': scope, 'state': cell['state'], 'reason': cell.get('reason'),
            'passed': passed, 'gateFailures': gates, 'gatesUnobserved': unobserved, 'failedPhase': failed_phase, 'fixtureDay': cell.get('fixtureDay'), 'host': host, 'processOwner': owner,
            'prerequisite': summary['prerequisite'],
            'harness': {key: harness.get(key) for key in ('harnessSha256', 'scenarioSha256')},
            'roleLatency': observation.get('roleLatency')}


def verify_cell(env):
    """Owner output binding for one runner's summary; writes owned_summary=true."""
    course = course_of(env)
    expected = expected_identity(env)
    digest = env.get('CELL_SUMMARY_SHA256', '')
    require(re.fullmatch(r'[a-f0-9]{64}', digest), 'cell summary digest')
    temp = Path(env['RUNNER_TEMP'])
    require(temp.is_absolute() and temp.resolve(strict=True) == temp, 'runner temporary root')
    directory = temp / 'system-worker-comparison-evidence'
    path = directory / 'summary.json'
    if not os.path.lexists(path):
        require(env.get('CELL_OUTCOME') == 'failure', 'missing summary after success')
        raise Refused('owned cell summary unavailable')
    parent = directory.lstat()
    require(stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700 and parent.st_uid == os.getuid(),
            'cell evidence directory')
    raw = read_bounded(path, 0o600)
    require(hashlib.sha256(raw).hexdigest() == digest, 'cell summary differs from the owner digest')
    facts = check_cell(parse(raw), course, env.get('CELL_WORKERS', ''), expected)
    if env.get('CELL_OUTCOME') == 'success':
        require(facts['passed'], 'successful owner without a passed cell')
    else:
        require(not facts['passed'] and facts['processOwner']['runnerExitCode'] != 0, 'failed owner with a passed cell')
    with open(env['GITHUB_OUTPUT'], 'a', encoding='ascii') as out:
        out.write('owned_summary=true\n')
    return facts


def latency_pair(left, right):
    if type(left) is not dict or type(right) is not dict:
        return None
    rows = {}
    for role in ROLES:
        for work in WORK:
            a = ((left.get(role) or {}).get(work)) or {}
            b = ((right.get(role) or {}).get(work)) or {}
            rows[role + '.' + work] = {key: [a.get(key), b.get(key)] for key in LATENCY}
    return rows


def aggregate(env, root):
    course = course_of(env)
    expected = expected_identity(env)
    reasons = []
    build_result = env.get('WORKER_BUILD_RESULT')
    cell_result = env.get('WORKER_CELL_RESULT')
    seal = archive = None
    try:
        seal = seal_of(json.loads(env.get('AIHR_WORKER_BUILD_SEAL') or 'null', object_pairs_hook=unique))
        archive = env.get('AIHR_WORKER_BUILD_ARCHIVE_SHA256', '')
        require(re.fullmatch(r'[a-f0-9]{64}', archive), 'build archive digest')
    except (Refused, ValueError):
        seal = archive = None
        reasons.append('build-transport-unavailable')
    if build_result != 'success':
        reasons.append('build-job-' + str(build_result))
    cells = []
    for workers, name, _ in COURSES[course]:
        path = Path(root) / ('worker-comparison-cell-' + workers) / 'summary.json'
        try:
            require(seal is not None, 'no upstream build to compare against')
            cells.append(check_cell(parse(read_bounded(path)), course, workers, expected, seal, archive))
        except FileNotFoundError:
            cells.append({'workers': int(workers), 'name': name, 'state': 'missing', 'passed': False})
            reasons.append(name + '-missing')
            continue
        except (Refused, OSError) as error:
            cells.append({'workers': int(workers), 'name': name, 'state': 'refused', 'passed': False,
                          'refusal': str(error) if isinstance(error, Refused) else 'evidence file unreadable'})
            reasons.append(name + '-refused')
            continue
        if not cells[-1]['passed']:
            reasons.append(name + '-' + str(cells[-1]['reason'] or cells[-1]['state']))
            reasons.extend(name + '-gate-' + gate for gate in cells[-1]['gateFailures'])
            if cells[-1]['state'] == 'passed':
                reasons.extend(name + '-gate-unobserved-' + gate for gate in cells[-1]['gatesUnobserved'])
    if cell_result != 'success':
        reasons.append('cell-jobs-' + str(cell_result))

    pair = [cell for cell in cells[:2] if 'host' in cell]
    steady = {'cells': [cells[0]['name'], cells[1]['name']], 'scalingComparison': 'not-claimed',
              'scalingNotClaimedReason': 'steady-pair-unobserved', 'cpuModels': {}, 'vcpus': {},
              'differences': {}, 'fixtureDayMatch': False}
    if len(pair) == 2:
        left, right = (cell['host'] for cell in pair)
        for key in SCALING_MATCH + REPORTED:
            if left[key] != right[key]:
                steady['differences'][key] = {pair[0]['name']: left[key], pair[1]['name']: right[key]}
        steady['cpuModels'] = {cell['name']: cell['host']['cpuModel'] for cell in pair}
        steady['vcpus'] = {cell['name']: cell['host']['effectiveCpus'] for cell in pair}
        days = [cell['fixtureDay'] for cell in pair]
        steady['fixtureDayMatch'] = days[0] is not None and days[0] == days[1]
        if not steady['fixtureDayMatch']:
            reasons.append('fixture-day')
        if any(left[key] != right[key] for key in SCALING_VCPU):
            steady['scalingNotClaimedReason'] = 'vcpu-differs'
        elif left['cpuModel'] != right['cpuModel']:
            steady['scalingNotClaimedReason'] = 'cpu-model-differs'
        elif not all(cell['passed'] for cell in pair) or not steady['fixtureDayMatch']:
            steady['scalingNotClaimedReason'] = 'steady-pair-not-passed'
        else:
            steady['scalingComparison'] = 'claimed'
            steady['scalingNotClaimedReason'] = None
            # The only place a 2-versus-4 number may appear.
            steady['latency'] = latency_pair(pair[0].get('roleLatency'), pair[1].get('roleLatency'))
    else:
        reasons.append('steady-pair-unobserved')
    observed = [cell for cell in cells if cell.get('passed')]
    harness = {json.dumps(cell['harness'], sort_keys=True) for cell in observed}
    prerequisites = {json.dumps(cell['prerequisite'], sort_keys=True) for cell in observed}
    if len(harness) > 1 or any(None in cell['harness'].values() for cell in observed):
        reasons.append('harness-differs')
    if len(prerequisites) > 1:
        reasons.append('prerequisite-differs')
    if steady['scalingComparison'] == 'claimed' and ('harness-differs' in reasons or 'prerequisite-differs' in reasons):
        steady.update(scalingComparison='not-claimed', scalingNotClaimedReason='harness-differs')
        steady.pop('latency', None)
    steady_pair_passed = (len(pair) == 2 and all(cell.get('passed') for cell in cells[:2])
                          and steady['fixtureDayMatch'] and 'harness-differs' not in reasons and seal is not None)
    complete = not reasons and all(cell.get('passed') for cell in cells)
    public = []
    for cell in cells:
        public.append({key: cell[key] for key in ('workers', 'name', 'scope', 'state', 'reason', 'gateFailures', 'gatesUnobserved', 'failedPhase', 'passed', 'fixtureDay',
                                                  'host', 'processOwner', 'harness', 'refusal') if key in cell})
    return {'kind': AGGREGATE_KIND, 'releaseEligible': False, 'productionEquivalent': False, 'course': course,
            'identity': expected, 'build': {'result': build_result, 'seal': seal, 'archiveSha256': archive},
            'cells': public, 'steadyPair': steady, 'steadyPairPassed': steady_pair_passed, 'complete': complete,
            'scalingComparison': steady['scalingComparison'],
            'reasons': sorted(set(reasons)),
            'scope': ('Harness smoke only. No comparison evidence.' if course == 'parallel-smoke' else
                      'Each cell ran on its own hosted runner from one sealed build and must pass its own gates. A '
                      '2-versus-4 scaling comparison is claimed only on matching CPU model and vCPU; memory, kernel and '
                      'Node differences are reported. Eight workers are a functional oversubscription diagnostic only.')}


def summary_markdown(result):
    lines = ['### Parallel worker comparison (%s)' % result['course'], '',
             'Release tier complete: **%s**; steady pair passed: **%s**.' % (result['complete'], result['steadyPairPassed']), '',
             '| Cell | State | CPU model | vCPU | Memory GiB | Kernel | Fixture day |', '|---|---|---|---|---|---|---|']
    for cell in result['cells']:
        host = cell.get('host') or {}
        memory = host.get('memoryBytes')
        lines.append('| %s | %s | %s | %s/%s | %s | %s | %s |' % (
            cell['name'], cell['state'] + ('' if cell.get('reason') in (None, '') else ' (' + str(cell['reason']) + ')'),
            host.get('cpuModel', '-'), host.get('effectiveCpus', '-'), host.get('logicalCpus', '-'),
            '-' if memory is None else '%.2f' % (memory / 1024 ** 3), host.get('kernel', '-'), cell.get('fixtureDay') or '-'))
    steady = result['steadyPair']
    if steady['scalingComparison'] == 'claimed':
        lines += ['', '2-versus-4 scaling comparison: **claimed** on matching CPU model and vCPU.']
    else:
        lines += ['', '2-versus-4 scaling comparison: **not claimed** (%s). No scaling number is published. CPU models: %s.'
                  % (steady['scalingNotClaimedReason'], json.dumps(steady['cpuModels'], sort_keys=True))]
    differences = steady['differences']
    lines += ['', 'Steady pair runner differences: ' + (json.dumps(differences, sort_keys=True) if differences else 'none') + '.']
    if result['reasons']:
        lines.append('Refusals: ' + ', '.join(result['reasons']) + '.')
    return '\n'.join(lines) + '\n'


def main(argv, env):
    try:
        if argv[1:] == ['verify-cell']:
            verify_cell(env)
            return 0
        require(len(argv) == 4 and argv[1] == 'aggregate', 'usage')
        result = aggregate(env, argv[2])
        out = Path(argv[3])
        out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        data = (json.dumps(result, indent=2, sort_keys=True) + '\n').encode('utf-8')
        require(len(data) <= LIMIT, 'aggregate exceeds its bound')
        with os.fdopen(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
            stream.write(data)
        summary = env.get('GITHUB_STEP_SUMMARY')
        if summary:
            with open(summary, 'a', encoding='utf-8') as stream:
                stream.write(summary_markdown(result))
        print(json.dumps({key: result[key] for key in ('course', 'complete', 'steadyPairPassed', 'scalingComparison', 'reasons')}), flush=True)
        print(json.dumps({'cells': [{key: cell.get(key) for key in ('name', 'state', 'reason', 'gateFailures', 'gatesUnobserved', 'failedPhase', 'host', 'fixtureDay')}
                                    for cell in result['cells']], 'steadyPair': {key: result['steadyPair'][key] for key in
                                                                                 ('scalingNotClaimedReason', 'cpuModels', 'differences', 'fixtureDayMatch')}}),
              flush=True)
        return 0 if result['complete'] else 1
    except (Refused, OSError, KeyError) as error:
        print('Worker comparison evidence refused: ' + (str(error) if isinstance(error, Refused) else type(error).__name__),
              file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv, os.environ))
