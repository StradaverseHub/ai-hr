"""Root-sealed CI build handoff; no Git, app execution, network, SQL or release authority.

The trusted API owner caches these exact bytes before candidate execution and
passes its authenticated facts over stdin. The root reader never trusts a binding
merely because it contains an authentication flag or self-consistent hashes.
"""
from __future__ import annotations
import contextlib
import base64
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import sys

BASE = pathlib.Path('/var/lib/aihr-native-build')
RUNNER_TEMP = '/home/runner/work/_temp'
PLAIN_KIND = 'AUTHENTICATED_SAME_RUN_NATIVE_NEXT_BUILD_NOT_RELEASE'
SEALED_KIND = 'ROOT_SEALED_SAME_RUN_NATIVE_NEXT_BUILD_NOT_RELEASE'
RUNTIME = {'node': '22.23.3', 'abi': '127', 'platform': 'linux', 'arch': 'x64', 'glibc': '2.39', 'next': '16.4.1'}
CAPACITY = {'profileVersion': 4, 'archiveMaxBytes': 285212672, 'zipMaxBytes': 293601280}
MEMBERS = {'build-provenance.json': 1024**2, 'system-testing.json': 80*1024,
           'successful-build.json': 1024**2, 'bytes/build-bundle-files.json': 16*1024**2,
           'bytes/build-bundle.tar.gz': CAPACITY['archiveMaxBytes']}
SHA = re.compile(r'[a-f0-9]{64}')
SOURCE = re.compile(r'[a-f0-9]{40}')
UNIT = re.compile(r'db-[a-f0-9]{16}')
HELPERS = {name: 'deploy/admission/'+name for name in (
    'test_next_native.py', 'next_source.py', 'next_native_package.py', 'next_profile.py', 'controller.py',
    'next_fixture_poststart.py', 'next_fixture_filesystem.py', 'next_dependency_probe.cjs', 'next_build_binding.py')}
HELPERS.update({name: '.github/ci/'+name for name in ('runtime_inventory.py', 'build-bundle.py')})


def blob_id(raw):
    return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()


def need(value, message):
    if not value:
        raise ValueError(message)


def closed(value, keys):
    need(isinstance(value, dict) and set(value) == set(keys), 'Closed native build fields required')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def positive(value):
    return type(value) is int and 0 < value <= 9007199254740991


def context(candidate, controller, run_id, unit, temporary, uid):
    need(isinstance(candidate, str) and SOURCE.fullmatch(candidate)
         and isinstance(controller, str) and SOURCE.fullmatch(controller), 'Exact native source/controller required')
    need(isinstance(run_id, str) and re.fullmatch(r'[1-9][0-9]*', run_id)
         and positive(int(run_id)) and isinstance(unit, str) and UNIT.fullmatch(unit), 'Exact native run/unit required')
    need(temporary == RUNNER_TEMP and type(uid) is int and uid > 0, 'Standard native issuer context required')


@contextlib.contextmanager
def directory(path, uid, final_mode=0o700):
    """Pin every ancestor and reject links before opening any packet member."""
    path = pathlib.Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(path) and '..' not in path.parts, 'Canonical directory required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Runner ingress is untrusted data, descriptor-pinned and checked
            # against API-owner hashes. Root seals additionally require every
            # ancestor to be non-writable by group/other. Neither accepts links.
            need(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, uid)
                 and (uid != 0 or not stat.S_IMODE(info.st_mode) & 0o022), 'Unsafe native directory ancestor')
        info = os.fstat(fd)
        need(info.st_uid == uid and stat.S_IMODE(info.st_mode) == final_mode, 'Native directory owner/mode differs')
        yield fd
        need(identity(os.fstat(fd)) == identity(path.lstat()), 'Native directory identity changed')
    finally:
        os.close(fd)


def member(parent, name, bound, uid, mode, destination=None):
    need('/' not in name and name not in ('', '.', '..'), 'Direct packet member required')
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1
         and stat.S_IMODE(before.st_mode) in mode and 0 < before.st_size <= bound, 'Unsafe native packet member')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    output = None
    try:
        need(identity(os.fstat(fd)) == identity(before), 'Packet member changed while opening')
        if destination is not None:
            output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        h, chunks, size = hashlib.sha256(), [], 0
        while True:
            block = os.read(fd, 1024*1024)
            if not block:
                break
            size += len(block)
            need(size <= bound, 'Growing native packet member')
            h.update(block)
            if output is not None:
                view = memoryview(block)
                while view:
                    count = os.write(output, view)
                    need(count > 0, 'Incomplete root packet copy')
                    view = view[count:]
            if not name.endswith('.tar.gz'):
                chunks.append(block)
        need(size == before.st_size and identity(os.fstat(fd)) == identity(before)
             and identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity(before), 'Packet member changed while reading')
        if output is not None:
            os.fsync(output)
        return {'sha256': h.hexdigest(), 'size': size, 'bytes': b''.join(chunks)}
    finally:
        os.close(fd)
        if output is not None:
            os.close(output)


def binding_fields(value, candidate, controller, run_id, unit, temporary, uid, sealed):
    closed(value, {'schemaVersion', 'kind', 'expected', 'artifact', 'producerJob', 'packet', 'installation', 'releaseAuthorized'} | ({'issuer', 'helpers'} if sealed else set()))
    installation_fields(value['installation'])
    need(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
         and value['kind'] == (SEALED_KIND if sealed else PLAIN_KIND) and value['releaseAuthorized'] is False, 'Native handoff kind differs')
    expected = value['expected']
    closed(expected, {'candidate', 'controller', 'runId', 'controllerBranch', 'producerStartedAt', 'producerCompletedAt'}
           | ({'controllerRef'} if isinstance(expected, dict) and 'controllerRef' in expected else set()))
    need(expected['candidate'] == candidate and expected['controller'] == controller
         and type(expected['runId']) is int and expected['runId'] == int(run_id), 'Native handoff identity differs')
    dates = []
    for key in ('producerStartedAt', 'producerCompletedAt'):
        need(isinstance(expected[key], str) and len(expected[key]) <= 40, 'Native producer time required')
        date = datetime.datetime.fromisoformat(expected[key].replace('Z', '+00:00'))
        need(date.tzinfo is not None, 'Native producer timezone required')
        dates.append(date)
    need(dates[0] <= dates[1], 'Native producer time order differs')
    branch = expected['controllerBranch']
    need(isinstance(branch, str) and 0 < len(branch) <= 180 and '..' not in branch and '//' not in branch, 'Native branch differs')
    if 'controllerRef' in expected:
        need(re.fullmatch(r'refs/pull/[1-9][0-9]*/merge', expected['controllerRef'])
             and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', branch), 'Native PR scope differs')
        reference = expected['controllerRef']
    else:
        need(branch in ('main', 'alpha') or re.fullmatch(r'codex/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*', branch), 'Native branch scope differs')
        reference = 'refs/heads/' + branch
    closed(value['artifact'], {'id', 'digest', 'runId'})
    need(positive(value['artifact']['id']) and value['artifact']['runId'] == int(run_id)
         and isinstance(value['artifact']['digest'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', value['artifact']['digest']), 'Native artifact identity differs')
    closed(value['producerJob'], {'id', 'name'})
    need(positive(value['producerJob']['id']) and value['producerJob']['name'] == 'build', 'Native build job differs')
    closed(value['packet'], {'archiveSha256', 'manifestSha256', 'provenanceSha256', 'nextBuildId'})
    need(all(isinstance(value['packet'][key], str) and SHA.fullmatch(value['packet'][key])
             for key in ('archiveSha256', 'manifestSha256', 'provenanceSha256'))
         and isinstance(value['packet']['nextBuildId'], str)
         and re.fullmatch(r'[A-Za-z0-9_-]{1,512}', value['packet']['nextBuildId']), 'Native packet digests differ')
    if sealed:
        closed(value['issuer'], {'runnerUid', 'runnerTemp', 'unit', 'runId'})
        need(value['issuer'] == {'runnerUid': uid, 'runnerTemp': temporary, 'unit': unit, 'runId': run_id}, 'Root sealed issuer differs')
        helper_fields(value['helpers'], False)
    return reference


def installation_fields(value):
    """Finite expected facts from the trusted locked install, never app claims."""
    closed(value, {'version', 'kind', 'node', 'dependencies', 'lockSha256', 'packageSha256'})
    need(type(value['version']) is int and value['version'] == 1
         and value['kind'] == 'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION', 'Native installation witness kind differs')
    closed(value['node'], {'path', 'sha256', 'bytes'})
    node = value['node']
    need(isinstance(node['path'], str) and node['path'].startswith('/') and len(node['path']) <= 4096
         and str(pathlib.PurePosixPath(node['path'])) == node['path']
         and not any(part in ('.', '..') for part in node['path'].split('/')[1:])
         and not re.search(r'[\x00-\x1f\x7f]', node['path'])
         and isinstance(node['sha256'], str) and SHA.fullmatch(node['sha256'])
         and positive(node['bytes']) and node['bytes'] <= 256*1024**2, 'Native executable witness differs')
    closed(value['dependencies'], {'normalization', 'sha256', 'entries', 'bytes'})
    deps = value['dependencies']
    need(deps['normalization'] == 'ROOT_COPY_DEPENDENCIES_V1'
         and isinstance(deps['sha256'], str) and SHA.fullmatch(deps['sha256'])
         and positive(deps['entries']) and deps['entries'] <= 500000
         and positive(deps['bytes']) and deps['bytes'] <= 4*1024**3, 'Native dependency witness differs')
    need(all(isinstance(value[key], str) and SHA.fullmatch(value[key]) for key in ('lockSha256', 'packageSha256')),
         'Native install inputs differ')


def helper_fields(values, content):
    closed(values, HELPERS)
    total = 0
    decoded = {}
    for name, source in HELPERS.items():
        item = values[name]
        closed(item, {'sourcePath', 'sha256', 'gitBlobId'} | ({'base64'} if content else set()))
        need(item['sourcePath'] == source and isinstance(item['sha256'], str) and SHA.fullmatch(item['sha256'])
             and isinstance(item['gitBlobId'], str) and SOURCE.fullmatch(item['gitBlobId']), 'Native helper source identity differs')
        if content:
            need(isinstance(item['base64'], str) and len(item['base64']) <= 1400000, 'Bounded native helper bytes required')
            raw = base64.b64decode(item['base64'], validate=True)
            total += len(raw)
            need(0 < len(raw) <= 1024**2 and total <= 2*1024**2
                 and hashlib.sha256(raw).hexdigest() == item['sha256'] and blob_id(raw) == item['gitBlobId'], 'Native helper bytes differ')
            decoded[name] = raw
    return decoded


def packet_members(packet_dir, uid, destination=None):
    records = {}
    with directory(packet_dir, uid) as root:
        need(set(os.listdir(root)) == {'build-provenance.json', 'system-testing.json', 'successful-build.json', 'bytes'}, 'Native packet inventory differs')
        with directory(pathlib.Path(packet_dir) / 'bytes', uid) as binary:
            need(set(os.listdir(binary)) == {'build-bundle-files.json', 'build-bundle.tar.gz'}, 'Native binary inventory differs')
            for path, bound in MEMBERS.items():
                parent, name = (binary, path[6:]) if path.startswith('bytes/') else (root, path)
                records[path] = member(parent, name, bound, uid, (0o400,) if uid == 0 else (0o600, 0o644),
                                       pathlib.Path(destination) / path if destination else None)
    need(sum(row['size'] for row in records.values()) <= CAPACITY['zipMaxBytes'], 'Native packet aggregate exceeds bound')
    return records


def packet_fields(records, binding, reference):
    packet, expected = binding['packet'], binding['expected']
    need(records['build-provenance.json']['sha256'] == packet['provenanceSha256'], 'API-owner provenance bytes differ')
    p = json.loads(records['build-provenance.json']['bytes'])
    need(all(p.get(key) == binding['installation'][key] for key in ('lockSha256', 'packageSha256')),
         'Build packet and pre-candidate install inputs differ')
    need(p.get('format') == 2 and p.get('kind') == 'ci-system-testing-build-candidate' and p.get('releaseAuthorized') is False
         and p.get('source') == expected['candidate'] and p.get('controller') == expected['controller']
         and p.get('runId') == expected['runId'] and p.get('runAttempt') == 1
         and p.get('repository') == 'StradaverseHub/ai-hr' and p.get('repositoryId') == 1333414856
         and p.get('workflowRef') == 'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@' + reference
         and p.get('runtime') == RUNTIME and p.get('capacityProfile') == CAPACITY
         and p.get('nextBuildId') == packet['nextBuildId'], 'Native provenance identity differs')
    if reference.startswith('refs/pull/'):
        need(p.get('producerEvent') == 'pull_request' and p.get('producerRef') == reference, 'Native PR provenance differs')
    for path, key in [('system-testing.json', 'preparedSha256'), ('successful-build.json', 'successfulObservationSha256'),
                      ('bytes/build-bundle-files.json', 'manifestSha256'), ('bytes/build-bundle.tar.gz', 'archiveSha256')]:
        need(records[path]['sha256'] == p.get(key), 'Native bound member bytes differ')
    need(p.get('manifestSha256') == packet['manifestSha256'] and p.get('archiveSha256') == packet['archiveSha256']
         and p.get('archiveBytes') == records['bytes/build-bundle.tar.gz']['size'], 'Native archive binding differs')
    prepared = json.loads(records['system-testing.json']['bytes'])
    need(prepared.get('format') == 1 and prepared.get('activeServiceVerified') is False
         and prepared.get('identity', {}).get('sourceRef') == p['source']
         and prepared.get('identity', {}).get('buildRecordId') == p.get('buildRecordId'), 'Native prepared identity differs')
    manifest = json.loads(records['bytes/build-bundle-files.json']['bytes'])
    need(manifest.get('format') == 2 and manifest.get('kind') == 'next-build-byte-bundle' and manifest.get('platform') == 'linux'
         and manifest.get('capacityProfile') == CAPACITY and manifest.get('nextBuildId') == p['nextBuildId']
         and manifest.get('archiveSha256') == p['archiveSha256'] and manifest.get('archiveBytes') == p['archiveBytes'], 'Native manifest differs')
    source = p.get('buildSourcePath')
    need(isinstance(source, str) and len(source) <= 4096 and source.startswith('/')
         and str(pathlib.PurePosixPath(source)) == source and not any(part in ('.', '..') for part in source.split('/')[1:])
         and not re.search(r'[\x00-\x1f\x7f]', source), 'Native producer source identifier differs')
    return p


def read_native_build_binding(packet_dir, binding_path, candidate, controller, run_id, unit, runner_temp, runner_uid, require=need):
    """Read only the pre-candidate root seal. Producer source path is metadata, never read authority."""
    require(os.geteuid() == 0, 'Root-sealed native build reader requires root')
    context(candidate, controller, run_id, unit, runner_temp, runner_uid)
    root = BASE / run_id / unit
    require(str(packet_dir) == str(root / 'packet') and str(binding_path) == str(root / 'build-binding.json'), 'Fixed root-sealed build paths required')
    with directory(root, 0) as fd:
        require(set(os.listdir(fd)) == {'packet', 'build-binding.json', 'helpers'}, 'Root build seal inventory differs')
        raw = member(fd, 'build-binding.json', 128*1024, 0, (0o400,))['bytes']
    binding = json.loads(raw)
    reference = binding_fields(binding, candidate, controller, run_id, unit, runner_temp, runner_uid, True)
    with directory(root/'helpers', 0) as fd:
        require(set(os.listdir(fd)) == set(HELPERS), 'Root helper inventory differs')
        for name, expected in binding['helpers'].items():
            actual = member(fd, name, 1024**2, 0, (0o400,))
            require(actual['sha256'] == expected['sha256'] and blob_id(actual['bytes']) == expected['gitBlobId'], 'Root helper bytes differ')
    records = packet_members(packet_dir, 0)
    p = packet_fields(records, binding, reference)
    return {'nextBuildId': p['nextBuildId'], 'buildSourcePath': p['buildSourcePath'], 'archivePath': str(root/'packet/bytes/build-bundle.tar.gz'),
            'manifestPath': str(root/'packet/bytes/build-bundle-files.json'), 'archiveSha256': p['archiveSha256'],
            'manifestSha256': p['manifestSha256'], 'provenanceSha256': binding['packet']['provenanceSha256'], 'runtime': p['runtime'],
            'helperDirectory': str(root/'helpers'), 'helpers': binding['helpers'], 'installation': binding['installation'],
            'witness': {'candidate': candidate, 'controller': controller, 'runId': run_id, 'unit': unit,
                        'artifactId': binding['artifact']['id'], 'artifactDigest': binding['artifact']['digest'],
                        'producerJobId': binding['producerJob']['id'], 'rootSealed': True}, 'releaseAuthorized': False}


def seal(request):
    need(os.geteuid() == 0, 'Root build sealing requires root')
    closed(request, {'binding', 'unit', 'runnerTemp', 'runnerUid', 'helpers'})
    binding, unit, temporary, uid = request['binding'], request['unit'], request['runnerTemp'], request['runnerUid']
    expected = binding['expected']
    run_id = str(expected['runId'])
    context(expected['candidate'], expected['controller'], run_id, unit, temporary, uid)
    need(os.environ.get('SUDO_UID') == str(uid), 'Actual native issuer UID differs')
    reference = binding_fields(binding, expected['candidate'], expected['controller'], run_id, unit, temporary, uid, False)
    helpers = helper_fields(request['helpers'], True)
    source = pathlib.Path(temporary) / (unit+'-native-build-private') / 'packet'
    # Fixed root paths only. Existing seals are never overwritten or cleaned as ours.
    for parent in (BASE, BASE/run_id):
        try:
            parent.mkdir(mode=0o700)
        except FileExistsError:
            pass
        with directory(parent, 0):
            pass
    root = BASE/run_id/unit
    root.mkdir(mode=0o700)
    try:
        (root/'packet').mkdir(mode=0o700)
        (root/'packet/bytes').mkdir(mode=0o700)
        (root/'helpers').mkdir(mode=0o700)
        records = packet_members(source, uid, root/'packet')
        packet_fields(records, binding, reference)
        for name, raw in helpers.items():
            fd = os.open(root/'helpers'/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o400)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        sealed = dict(binding, kind=SEALED_KIND, issuer={'runnerUid': uid, 'runnerTemp': temporary, 'unit': unit, 'runId': run_id},
                      helpers={name: {key: value for key, value in item.items() if key != 'base64'} for name, item in request['helpers'].items()})
        raw = (json.dumps(sealed, sort_keys=True, separators=(',', ':'))+'\n').encode()
        need(len(raw) <= 128*1024, 'Root build binding exceeds bound')
        fd = os.open(root/'build-binding.json', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o400)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # Reopen the entire destination independently before issuing its paths.
        read_native_build_binding(root/'packet', root/'build-binding.json', expected['candidate'], expected['controller'], run_id, unit, temporary, uid)
        return {'packetDirectory': str(root/'packet'), 'bindingPath': str(root/'build-binding.json')}
    except BaseException:
        shutil.rmtree(root)  # Exclusive root-owned tree created by this invocation only.
        raise


if __name__ == '__main__':
    try:
        need(sys.argv[1:] == ['--seal'], 'Only the fixed native seal operation is supported')
        raw = sys.stdin.buffer.read(4*1024**2+1)
        need(0 < len(raw) <= 4*1024**2, 'Bounded native seal request required')
        print(json.dumps(seal(json.loads(raw))))
    except Exception:
        print('Native root build handoff refused', file=sys.stderr)
        sys.exit(1)
