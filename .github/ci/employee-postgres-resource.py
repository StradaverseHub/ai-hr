"""Fixed disposable PostgreSQL owner inside the normal lifecycle's live kernel.

No supplied Docker command, name-only removal, inherited remote daemon, process
signal fallback or application credentials. The kernel remains the process owner.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]


def source_module(name, path):
    module = ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


policy = source_module('employee_postgres_policy', ROOT / '.github/ci/employee-postgres-policy.py')
adapter = source_module('employee_lifecycle_adapter', ROOT / '.github/ci/employee-lifecycle-supervisor.py')
require, packet, regular, publish = policy.require, adapter.packet, adapter.regular, adapter.publish
DOCKER = Path('/usr/bin/docker')
OPERATION_DEADLINE = None


def native(pid):
    value = adapter._kernel.identity(pid)
    require(value['state'] not in ('Z', 'X'))
    return {**{key: value[key] for key in ('pid', 'parent', 'group', 'session')},
            'start': str(value['start']), 'exe': str(Path('/proc/%d/exe' % pid).resolve()),
            'argv': [part.decode() for part in Path('/proc/%d/cmdline' % pid).read_bytes().split(b'\0')[:-1]]}


def validate_context(opcode):
    env = os.environ
    require(opcode in ('reset', 'stats', 'stop') and sys.platform == 'linux')
    for key, expected in {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                          'RUNNER_OS': 'Linux', 'GITHUB_REPOSITORY': 'StradaverseHub/ai-hr',
                          'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_WORKFLOW': 'alpha-staging-ci',
                          'GITHUB_JOB': 'test', 'GITHUB_RUN_ATTEMPT': '1'}.items():
        require(env.get(key) == expected)
    require(not any(key.startswith(('AIHR_FOCUSED_', 'AIHR_EMPLOYEE_LIFECYCLE_')) for key in env))
    require(all(not env.get(key) for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME')))
    require(env.get('AIHR_CI_PG_PROFILE') == '2' and env.get('AIHR_CI_PG_CONFIGURED_CAP_BYTES') == str(policy.MEMORY)
            and env.get('AIHR_CI_PG_PEAK_BUDGET_BYTES') == '2147483648' and env.get('AIHR_CI_PG_JIT') == 'on'
            and env.get('AIHR_CI_PG_STATEMENTS', '0') == '0' and env.get('AIHR_CI_PG_DURABLE', '0') == '0')
    unit = env.get('AIHR_CI_UNIT', '')
    require(re.fullmatch(r'db-[0-9a-f]{16}', unit) is not None)
    temp = Path(env['RUNNER_TEMP']).resolve()
    private = temp / 'aihr-employee-private' / unit
    for directory in (private.parent, private):
        info = directory.lstat()
        require(directory.resolve() == directory and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)
    context_path = private / 'resource.json'
    require(env.get('AIHR_EMPLOYEE_RESOURCE_CONTEXT') == str(context_path))
    context_bytes = regular(context_path, 65536)
    context = json.loads(context_bytes, object_pairs_hook=adapter.pairs)
    require(set(context) == {'version', 'kind', 'mode', 'source', 'controller', 'run', 'attempt', 'unit', 'file',
                            'fingerprint', 'registrySha256', 'sourceRoot', 'automation', 'evidenceDirectory',
                            'anchorPath', 'anchorSha256', 'parent', 'expectedPostgres', 'resourceNonce', 'createdMonotonicNs'})
    require(context['version'] == 1 and context['kind'] == 'EMPLOYEE_NORMAL_CI_RESOURCE_CUSTODY' and context['mode'] == 'full-ci-singleton')
    require(context['unit'] == unit and context['expectedPostgres'] == policy.PROFILE)
    for field, key in [('source', 'AIHR_CI_HEAD'), ('controller', 'AIHR_CI_CONTROL_HEAD'), ('run', 'GITHUB_RUN_ID'), ('attempt', 'GITHUB_RUN_ATTEMPT')]:
        require(context[field] == env[key])
    require(all(re.fullmatch(r'[0-9a-f]{40}', context[key]) is not None for key in ('source', 'controller')))
    require(policy.digest(context['fingerprint']) and policy.digest(context['resourceNonce']))
    workspace = Path(env['GITHUB_WORKSPACE']).resolve()
    require(context['automation'] == str(ROOT) == str(workspace / 'automation')
            and context['sourceRoot'] == str(Path.cwd()) == str(workspace / 'source')
            and context['evidenceDirectory'] == str(temp / 'aihr-ci'))
    registry_bytes = regular(ROOT / '.github/ci/employee-lifecycle-profile.json', 16384, False)
    registry = json.loads(registry_bytes, object_pairs_hook=adapter.pairs)
    require(context['registrySha256'] == policy.sha(registry_bytes)
            and len([row for row in registry['files'] if row['file'] == context['file']]) == 1)
    anchor_path = temp / 'aihr-ci' / (unit + '-employee-job-anchor.json')
    require(context['anchorPath'] == env.get('AIHR_EMPLOYEE_JOB_ANCHOR') == str(anchor_path)
            and policy.sha(regular(anchor_path, 16384)) == context['anchorSha256'])
    anchor = packet(anchor_path, 16384)
    require(anchor['bootId'] == Path('/proc/sys/kernel/random/boot_id').read_text().strip())
    require(all(anchor[key] == context[key] for key in ('source', 'controller', 'run', 'attempt', 'unit')))
    require(0 <= time.monotonic_ns() - int(anchor['startNs']) < 1770 * 10**9)
    preparation = packet(temp / 'aihr-ci' / (unit + '-employee-preparation.json'))
    require(preparation['resourceContextSha256'] == policy.sha(context_bytes)
            and preparation['resourceNonceSha256'] == policy.sha(context['resourceNonce'])
            and preparation['parent'] == context['parent'])
    expected_sources = {'.github/ci/' + path for path in ('employee-lifecycle.mjs', 'employee-lifecycle-profile.mjs',
                       'employee-lifecycle-profile.json', 'employee-lifecycle-context.mjs', 'employee-lifecycle-supervisor.py', 'employee-lifecycle-always-stop.mjs',
                       'owned-process.py', 'employee-postgres-resource.py', 'employee-postgres-policy.py', 'run-unit.mjs')}
    require(set(preparation['controllerSources']) == expected_sources)
    for path, digest in preparation['controllerSources'].items():
        require(path.startswith('.github/ci/'))
        require('..' not in Path(path).parts and not Path(path).is_absolute())
        require(policy.sha(regular(ROOT / path, 1048576, False)) == digest)
    # Actual resource helper is a direct child of the acknowledged, still-live
    # session monitor. Both Python processes retain the same fixed CLI request.
    me = native(os.getpid())
    monitor = native(os.getppid())
    supervisor = native(monitor['parent'])
    parent = native(supervisor['parent'])
    python = str(Path('/usr/bin/python3').resolve())
    require(me['group'] == me['session'] == monitor['pid'] == monitor['group'] == monitor['session'])
    require(monitor['exe'] == supervisor['exe'] == python and monitor['argv'] == supervisor['argv'])
    require(len(supervisor['argv']) == 5 and supervisor['argv'][:4] == ['/usr/bin/python3', '-I', '-B', str(ROOT / '.github/ci/employee-lifecycle-supervisor.py')])
    request = json.loads(supervisor['argv'][4], object_pairs_hook=adapter.pairs)
    require(request['stage'] == opcode and request['file'] == context['file'] and request['controller'] == str(ROOT)
            and request['destination'] == context['evidenceDirectory'])
    recovery_path = env.get('AIHR_EMPLOYEE_RECOVERY_CONTEXT')
    if recovery_path is None:
        require(parent == context['parent'] and parent['argv'] == [parent['exe'], str(ROOT / '.github/ci/run-unit.mjs'), unit, context['evidenceDirectory']])
    else:
        require(opcode == 'stop' and request['sequence'] == 99
                and recovery_path == str(temp / 'aihr-ci' / (unit + '-employee-recovery.json')))
        recovery = packet(recovery_path)
        require(recovery['nativeParent'] == parent and recovery['mode'] == 'cleanup-only' and recovery['releaseAuthorized'] is False
                and recovery['resourceContextSha256'] == policy.sha(context_bytes)
                and recovery['preparationSha256'] == policy.sha(regular(temp / 'aihr-ci' / (unit + '-employee-preparation.json'), 65536)))
        require(all(recovery[key] == context[key] for key in ('source', 'controller', 'run', 'attempt', 'unit', 'file', 'fingerprint', 'registrySha256')))
        require(parent['argv'] == [parent['exe'], str(ROOT / '.github/ci/employee-lifecycle-always-stop.mjs'), unit, context['evidenceDirectory']])
    require(DOCKER.is_file() and DOCKER.resolve() == DOCKER and Path('/var/run/docker.sock').is_socket())
    binding = {key: context[key] for key in ('source', 'controller', 'run', 'attempt', 'unit', 'file', 'fingerprint', 'registrySha256')}
    binding.update({'version': 1, 'mode': 'full-ci-singleton', 'resourceContextSha256': policy.sha(context_bytes),
                    'resourceNonceSha256': policy.sha(context['resourceNonce']), 'releaseAuthorized': False})
    return context, private, binding, parent


def command(args, private, seconds):
    """Fixed caller vectors only, bounded private disk capture, no raw output.

    There is no numeric kill fallback; stdlib owns its actual child handle and
    the enclosing shared kernel settles the complete acknowledged session.
    """
    if OPERATION_DEADLINE is not None:
        seconds = min(seconds, OPERATION_DEADLINE - time.monotonic())
        require(seconds > .025)
    with tempfile.TemporaryFile(dir=private) as output, tempfile.TemporaryFile(dir=private) as error:
        result = subprocess.run([str(DOCKER), '--host=unix:///var/run/docker.sock', '--config=' + str(private / 'docker-config'), *args],
                                stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': str(private)}, timeout=seconds, check=False)
        require(os.fstat(output.fileno()).st_size <= 1048576 and os.fstat(error.fileno()).st_size <= 65536)
        require(OPERATION_DEADLINE is None or time.monotonic() < OPERATION_DEADLINE)
        output.seek(0)
        return result.returncode, output.read()


def inspect(reference, private, seconds=1):
    code, data = command(['container', 'inspect', reference], private, seconds)
    if code != 0:
        # A failed inspect is NOT absence. An independently successful full ID
        # listing must establish that neither this exact name nor ID exists.
        code, listing = command(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}'], private, seconds)
        require(code == 0)
        rows = [row.split(' ') for row in listing.decode().splitlines()]
        require(all(len(row) == 2 and policy.digest(row[0]) for row in rows))
        require(not any(reference in row for row in rows))
        return None
    values = json.loads(data, object_pairs_hook=adapter.pairs)
    require(isinstance(values, list) and len(values) == 1)
    return values[0]


def load_optional(path):
    try:
        return packet(path)
    except FileNotFoundError:
        return None


def receipt(path, binding):
    value = load_optional(path)
    if value is not None:
        require(all(value.get(key) == expected for key, expected in binding.items()))
    return value


def volume_absent(volume, private):
    require(policy.digest(volume))
    code, data = command(['volume', 'ls', '--format', '{{.Name}}'], private, 1)
    require(code == 0 and volume not in data.decode().splitlines())


def public(context, name, value):
    publish(Path(context['evidenceDirectory']) / (context['unit'] + '-employee-container-' + name + '.json'), value)


def publish_stopped(context, value):
    path = Path(context['evidenceDirectory']) / (context['unit'] + '-employee-container-stopped.json')
    previous = load_optional(path)
    if previous is None:
        publish(path, value)
    else:
        require(previous == value)  # never overwrite a conflicting owner/proof


def absent_target(cid, container_name, volume, private):
    code, data = command(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}'], private, 1)
    require(code == 0)
    rows = [row.split(' ') for row in data.decode().splitlines()]
    require(all(len(row) == 2 and policy.digest(row[0]) for row in rows))
    require(not any((cid is not None and cid == row[0]) or container_name == row[1] for row in rows))
    if volume is not None:
        volume_absent(volume, private)


def pinned_image(image_id, private):
    code, data = command(['image', 'inspect', image_id], private, 1)
    image = json.loads(data, object_pairs_hook=adapter.pairs)
    require(code == 0 and isinstance(image, list) and len(image) == 1
            and image[0]['Id'] == image_id and any(value.endswith('@' + policy.IMAGE.split('@')[1]) for value in image[0]['RepoDigests']))
    code, pinned = command(['image', 'inspect', policy.IMAGE], private, 1)
    require(code == 0 and json.loads(pinned, object_pairs_hook=adapter.pairs)[0]['Id'] == image_id)


def reset(context, private, binding):
    container_name = policy.name(context)
    require(load_optional(private / 'create-intent.json') is None and inspect(container_name, private) is None)
    publish(private / 'create-intent.json', {**binding, 'wallTimeNs': str(time.time_ns()), 'monotonicNs': str(time.monotonic_ns())})
    # An actual immutable ID is captured before START. If CREATE's response is
    # lost, this path cannot admit a test; STOP may reconcile cleanup only.
    args = ['create', '--name', container_name, '--network', 'host', '--memory', str(policy.MEMORY),
            '--memory-swap', str(policy.MEMORY), '--shm-size', '128m']
    for key, value in policy.labels(context).items():
        args += ['--label', key + '=' + value]
    args += ['-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'TZ=Asia/Kuala_Lumpur', policy.IMAGE, *policy.COMMAND]
    code, data = command(args, private, 20)
    cid = data.decode().strip()
    require(code == 0 and policy.digest(cid))
    # Preserve the known CREATE reply before any subsequent Docker operation.
    # A failed publication still cannot admit a test; the pre-CREATE nonce
    # intent covers only cleanup of a response whose ID remains unknown.
    publish(private / 'create-id.json', {**binding, 'cid': cid})
    actual = inspect(cid, private)
    created = {**binding, **policy.container(actual, context, cid=cid)}
    pinned_image(created['imageId'], private)
    publish(private / 'created.json', created)
    public(context, 'created', created)
    require(command(['start', cid], private, 5)[0] == 0)
    actual = inspect(cid, private)
    policy.container(actual, context, cid=cid, image_id=created['imageId'], created=created['created'])
    birth = {**created, **policy.started(actual)}
    publish(private / 'started.json', birth)
    public(context, 'started', birth)
    deadline = time.monotonic() + 20
    while True:
        actual = inspect(cid, private)
        policy.container(actual, context, cid=cid, image_id=created['imageId'], created=created['created'])
        policy.same_birth(actual, birth)
        # Official entrypoint uses a temporary Unix-only postmaster during
        # initialization. Wait for the final PID1 postmaster before setup.
        postmaster_code, postmaster_pid = command(['exec', cid, 'head', '-n', '1', '/var/lib/postgresql/data/postmaster.pid'], private, 1)
        if postmaster_code == 0 and postmaster_pid == b'1\n' and command(['exec', cid, 'pg_isready', '-h', '/var/run/postgresql', '-U', 'postgres', '-p', '5433'], private, 2)[0] == 0:
            break
        require(time.monotonic() < deadline)
        time.sleep(.1)
    sql = ['CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;',
           'CREATE DATABASE ai_hr_dev OWNER ai_hr_app;', 'CREATE DATABASE ai_hr_test OWNER ai_hr_app;']
    require(command(['exec', cid, 'psql', '-h', '/var/run/postgresql', '-U', 'postgres', '-p', '5433', '-v', 'ON_ERROR_STOP=1', *sum((['-c', value] for value in sql), [])], private, 5)[0] == 0)
    actual = inspect(cid, private)
    policy.container(actual, context, cid=cid, image_id=created['imageId'], created=created['created'])
    policy.same_birth(actual, birth)


def stats(context, private, binding):
    created = receipt(private / 'created.json', binding)
    birth = receipt(private / 'started.json', binding)
    require(created is not None and birth is not None)
    actual = inspect(created['cid'], private)
    policy.container(actual, context, cid=created['cid'], image_id=created['imageId'], created=created['created'])
    policy.same_birth(actual, birth)
    code, data = command(['stats', '--no-stream', '--format', '{{json .}}', created['cid']], private, 5)
    require(code == 0)
    value = json.loads(data, object_pairs_hook=adapter.pairs)
    require(value.get('ID') in (created['cid'], created['cid'][:12]) and value.get('Name') == policy.name(context))
    actual = inspect(created['cid'], private)
    policy.container(actual, context, cid=created['cid'], image_id=created['imageId'], created=created['created'])
    policy.same_birth(actual, birth)
    data = (json.dumps(value) + '\n').encode()
    snapshot_name = context['unit'] + '-employee-container-stats.json'
    publish(Path(context['evidenceDirectory']) / snapshot_name, value)
    # publish() has one canonical compact encoding without a newline.
    snapshot_bytes = regular(Path(context['evidenceDirectory']) / snapshot_name, 16384)
    public(context, 'observed', {**birth, 'complete': True,
           'snapshot': {'filename': snapshot_name, 'sha256': policy.sha(snapshot_bytes)},
           'native': {'running': True, 'restarting': False, 'dead': False, 'oomKilled': False, 'errorEmpty': True},
           'sampledBirthUnchanged': True})
    sys.stdout.write(data.decode())


def stop(context, private, binding):
    previous = receipt(private / 'stopped.json', binding)
    if previous is not None:
        require(previous['complete'] is True and type(previous['createdResource']) is bool
                and previous['containerAbsent'] is True and previous['nameAbsent'] is True and previous['volumeAbsent'] is True)
        prior_intent = receipt(private / 'create-intent.json', binding)
        prior_known = receipt(private / 'create-id.json', binding)
        prior_target = receipt(private / 'created.json', binding) or receipt(private / 'remove-intent.json', binding)
        if previous['createdResource']:
            require(prior_intent is not None and prior_target is not None
                    and all(previous[key] == prior_target[key] for key in ('cid', 'imageId', 'created', 'volume')))
            require(prior_known is None or previous['cid'] == prior_known['cid'])
            require(set(previous) == {*binding, 'complete', 'createdResource', 'cid', 'imageId', 'created', 'volume',
                                      'reconciledLostCreateReply', 'containerAbsent', 'nameAbsent', 'volumeAbsent'})
        else:
            require(prior_intent is None and prior_known is None and prior_target is None and previous['cid'] is None)
            require(set(previous) == {*binding, 'complete', 'createdResource', 'cid',
                                      'reconciledLostCreateReply', 'containerAbsent', 'nameAbsent', 'volumeAbsent'})
        absent_target(previous['cid'], policy.name(context), previous.get('volume'), private)
        publish_stopped(context, previous)
        return
    intent = receipt(private / 'create-intent.json', binding)
    known = receipt(private / 'create-id.json', binding)
    if known is not None:
        require(set(known) == {*binding, 'cid'} and policy.digest(known['cid']))
    created = receipt(private / 'created.json', binding)
    actual = inspect(policy.name(context), private)
    if intent is None:
        require(created is None and known is None and actual is None)
        # This owner never attempted CREATE. It owns nothing to delete.
        result = {**binding, 'complete': True, 'createdResource': False, 'cid': None,
                  'reconciledLostCreateReply': False, 'containerAbsent': True, 'nameAbsent': True, 'volumeAbsent': True}
    else:
        pending = receipt(private / 'remove-intent.json', binding)
        if actual is None:
            # A lost REMOVE response may already have removed this exact known
            # object. A lost CREATE response with no object remains uncertain.
            target = pending or created
            require(target is not None and inspect(target['cid'], private) is None)
        else:
            target = policy.cleanup_target(actual, context, created or pending, intent, known['cid'] if known else None)
            if created is None:
                pinned_image(target['imageId'], private)
            if pending is None:
                publish(private / 'remove-intent.json', {**binding, **target})
        # Docker removes the exact validated immutable ID and its own anonymous
        # volume. A name replacement can never become the removal target.
            require(command(['rm', '-f', '-v', target['cid']], private, 3)[0] == 0)
        absent_target(target['cid'], policy.name(context), target['volume'], private)
        result = {**binding, 'complete': True, 'createdResource': True, **target,
                  'reconciledLostCreateReply': created is None, 'containerAbsent': True, 'nameAbsent': True, 'volumeAbsent': True}
    publish(private / 'stopped.json', result)
    publish_stopped(context, result)


def main():
    global OPERATION_DEADLINE
    require(len(sys.argv) == 2)
    opcode = sys.argv[1]
    context, private, binding, parent = validate_context(opcode)
    OPERATION_DEADLINE = time.monotonic() + {'reset': 58, 'stats': 9, 'stop': 8}[opcode]
    config = private / 'docker-config'
    try:
        config.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = config.lstat()
    require(config.resolve() == config and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0
            and list(config.iterdir()) == [])
    require(native(parent['pid']) == parent)
    {'reset': reset, 'stats': stats, 'stop': stop}[opcode](context, private, binding)
    require(native(parent['pid']) == parent)


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('Closed employee PostgreSQL resource operation refused\n')
        sys.exit(1)
