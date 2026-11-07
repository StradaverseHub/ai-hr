"""Owned ACTUAL Next two-worker boot/auth/Home smoke, not a capacity/release receipt.

Launched only from the API owner's sealed root-owned helper directory. Root
executes stdlib preparation/controllers; all Next/probe/browser JS is nonroot.
The existing fake-backend native protocol test remains a separate 240s gate.
"""
import contextlib
import hashlib
import http.client
import importlib.util
import json
import os
import pathlib
import pwd
import re
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

TOTAL_DEADLINE = time.monotonic() + 480
DEADLINE = TOTAL_DEADLINE - 30  # Cleanup has reserved time inside the same envelope.
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
UNITS = ['aihr-web@1.service', 'aihr-web@2.service']
PROXY = 'aihr-admission-nginx.service'
SLICE = 'aihr-native-next.slice'
FIXTURE_CGROUP = '/aihr.slice/aihr-native.slice/aihr-native-next.slice'
BROWSER = 'aihr-native-next-browser.service'
ROOTS = ['/etc/aihr-admission', '/usr/local/lib/aihr-admission', '/etc/nginx/aihr-admission',
         '/run/aihr-admission', '/var/lib/aihr-admission', '/var/cache/aihr']
owned_paths, owned_units = {}, {}
created_home = False
created_empty_parent = None
browser = None
report = {'version': 1, 'kind': 'ACTUAL_NEXT_TWO_WORKER_NATIVE_BOOT_ONLY', 'complete': False,
          'releaseEligible': False, 'fullApplicationJourneysVerified': False,
          'hostInstallationVerified': False, 'actualNextBootVerified': False,
          'phases': [], 'remaining': ['actual-actions-and-freshness', 'full-module-browser-preflight',
          '500-actor-steady-load', 'protected-installation', 'cross-build-compatibility']}
evidence = None
evidence_fd = None
PREPACKAGE_GUARDS = {
    **{'fixture-root-' + str(index): 'directory-absence' for index in range(6)},
    **{'fixture-unit-' + str(index): 'unit-absence' for index in (0, 1, 2, 4)},
    'empty-home-parent': 'empty-home', 'empty-home': 'empty-home',
    **{'sealed-helper-' + str(index): 'sealed-helpers' for index in range(6)},
    'node-hint': 'node-hint', 'node-stat': 'node-stat',
    'node-before-read': 'node-read', 'node-after-read': 'node-read',
    'node-installed-bytes': 'node-read',
    **{code: 'slice-absence' for code in ('slice-metadata', 'slice-paths', 'slice-file-absent',
        'slice-member-units', 'slice-cgroup-absent')},
}
PREPACKAGE_STAGES = frozenset(PREPACKAGE_GUARDS.values()) | {'owned-directories', 'node-install'}


def require(condition, reason):
    if not condition:
        raise AssertionError(reason)


def left(maximum=30):
    value = DEADLINE - time.monotonic()
    require(value > 0, 'Native Next fixture total deadline exceeded')
    return min(maximum, value)


def run(arguments, *, check=True, timeout=30, env=None, input=None):
    result = subprocess.run(arguments, env=SAFE_ENV if env is None else env, input=input,
                            capture_output=True, timeout=left(timeout))
    if check:
        require(result.returncode == 0, 'Bounded native subprocess refused')
    return result


def systemctl(*args, check=True, timeout=30):
    return run(['/usr/bin/systemctl', '--system', *args], check=check, timeout=timeout)


def props(unit):
    raw = systemctl('show', unit, '--property=LoadState,InvocationID,MainPID,ControlPID,ActiveState,SubState,ExecStart,ExecReload,FragmentPath,ControlGroup').stdout.decode()
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def write(file, payload, mode=0o600):
    raw = payload.encode() if isinstance(payload, str) else payload
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def regular(file, uid, maximum):
    file = pathlib.Path(file)
    before = file.lstat()
    require(str(file.resolve()) == str(file) and stat.S_ISREG(before.st_mode) and before.st_uid == uid
            and before.st_nlink == 1 and not stat.S_IMODE(before.st_mode) & 0o077
            and 0 < before.st_size <= maximum, 'Private bounded regular input required')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(before) == identity(os.fstat(fd)), 'Native input changed while opening')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(maximum + 1)
        require(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
                == identity(file.lstat()), 'Native input changed while reading')
        return raw
    finally:
        os.close(fd)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def load(name, file):
    # Only fixed sealed/root-copied helper modules are accepted, never runner imports.
    file = pathlib.Path(file)
    info = file.lstat()
    require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and not stat.S_IMODE(info.st_mode) & 0o022 and str(file.resolve()) == str(file), 'Unsealed root helper')
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def save():
    if evidence_fd is not None:
        # Evidence is an allowlisted report only. Private plans/env/logs stay elsewhere.
        info = os.fstat(evidence_fd)
        require(info.st_uid == 0 and info.st_nlink == 1 and stat.S_ISREG(info.st_mode), 'Evidence inode changed')
        os.lseek(evidence_fd, 0, os.SEEK_SET)
        raw = (json.dumps(report, indent=2) + '\n').encode()
        offset = 0
        while offset < len(raw):
            count = os.write(evidence_fd, raw[offset:])
            require(count > 0, 'Evidence write did not advance')
            offset += count
        os.ftruncate(evidence_fd, len(raw))


def phase(name):
    report['phases'].append(name)
    report['currentPhase'] = name
    save()


def prepackage_phase(stage):
    # Closed source labels only: never reflect an exception, path, environment
    # value or caller-selected reason into the uploaded public evidence.
    require(isinstance(stage, str) and stage in PREPACKAGE_STAGES, 'Unknown native prepackage stage')
    phase('prepackage-' + stage)


def prepackage_guard(condition, code):
    require(isinstance(code, str) and code in PREPACKAGE_GUARDS, 'Unknown native prepackage guard')
    stage = PREPACKAGE_GUARDS[code]
    require(report.get('currentPhase') == 'prepackage-' + stage, 'Native prepackage guard phase differs')
    if not condition:
        report['prepackageGuardFailure'] = {'stage': stage, 'code': code}
        save()
    require(condition, 'Closed native prepackage guard refused')


def until(callback, name, seconds=60):
    deadline = time.monotonic() + left(seconds)
    while time.monotonic() < deadline:
        value = callback()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError('Native deadline: ' + name)


def port(used):
    for _ in range(256):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            value = probe.getsockname()[1]
        if value not in used:
            used.add(value)
            return value
    raise AssertionError('Cannot allocate bounded distinct fixture endpoints')


def control(operation, unit=None, check=True):
    result = run(['/usr/bin/python3', '-I', '-B', '/usr/local/lib/aihr-admission/controller.py', operation]
                 + ([unit] if unit else []), check=False, timeout=60)
    require(not check or result.returncode == 0, 'Protected admission operation refused: ' + operation)
    return result


def status():
    return json.loads(control('status').stdout)


def ready(unit):
    row = next((row for row in status()['workers']
                if row['unit'] == unit and row['phase'] == 'READY' and row['admitted']), None)
    return {**row, 'id': row['generation']} if row else None


def state():
    return json.loads(pathlib.Path('/var/lib/aihr-admission/state.json').read_bytes())


def cold(unit):
    current = state()
    key = current['current'].get(unit)
    row = current['generations'].get(key, {})
    if row.get('phase') != 'WARMING' or props(unit).get('SubState') != 'start-post':
        return None
    connection = http.client.HTTPConnection('127.0.0.1', row['port'], timeout=left(2))
    try:
        connection.request('GET', '/health', headers={'Connection': 'close'})
        response = connection.getresponse()
        if response.status != 200 or response.read(1024) != b'{"status":"ok"}\n':
            return None
    except (OSError, http.client.HTTPException):
        return None
    finally:
        connection.close()
    require(key not in current['published']['ready'], 'Cold worker was published')
    return row


def fixture_directories():
    global created_home, created_empty_parent
    prepackage_phase('directory-absence')
    for index, name in enumerate(ROOTS):
        prepackage_guard(not os.path.lexists(name), 'fixture-root-' + str(index))
    prepackage_phase('unit-absence')
    for index, unit in enumerate([*UNITS, PROXY, SLICE, BROWSER]):
        if unit == SLICE:
            continue  # A fragmentless slice is synthesized loaded by systemd.
        prepackage_guard(props(unit).get('LoadState') == 'not-found', 'fixture-unit-' + str(index))
    slice_absence()
    prepackage_phase('owned-directories')
    for name in ROOTS:
        os.mkdir(name, 0o755)
        os.chmod(name, 0o755)
        info = os.lstat(name)
        owned_paths[name] = (info.st_dev, info.st_ino)
    for name in ('/run/aihr-admission/ports', '/var/lib/aihr-admission/private'):
        os.mkdir(name, 0o700)
    prepackage_phase('empty-home')
    home = pathlib.Path('/var/empty/aihr')
    if not os.path.lexists(home.parent):
        home.parent.mkdir(mode=0o755)
        home.parent.chmod(0o755)
        info = home.parent.stat()
        created_empty_parent = (info.st_dev, info.st_ino)
    parent_info = home.parent.lstat()
    prepackage_guard(stat.S_ISDIR(parent_info.st_mode) and parent_info.st_uid == 0 and not parent_info.st_mode & 0o022
            and home.parent.resolve() == home.parent, 'empty-home-parent')
    if not home.exists():
        home.mkdir(mode=0o755)
        home.chmod(0o755)
        created_home = True
        owned_paths[str(home)] = (home.stat().st_dev, home.stat().st_ino)
    prepackage_guard(home.stat().st_uid == 0 and not home.is_symlink() and not home.stat().st_mode & 0o022
            and not any(home.iterdir()), 'empty-home')


def fixed_properties(raw, wanted):
    prepackage_guard(isinstance(raw, bytes) and len(raw) <= 1024**2, 'slice-metadata')
    rows = {}
    for line in raw.decode('utf8').strip().splitlines():
        key, separator, value = line.partition('=')
        prepackage_guard(separator == '=' and key in wanted and key not in rows
                         and len(value) <= 4096 and '\0' not in value, 'slice-metadata')
        rows[key] = value
    prepackage_guard(set(rows) == set(wanted), 'slice-metadata')
    return rows


def directory_identity(info):
    # System directories have unrelated live entries. Pin directory identity,
    # type and authority; unit-leaf absence is checked separately without links.
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid


@contextlib.contextmanager
def manager_directory(supplied):
    """Read only a real manager lookup directory through root-owned pinned parents.

    Ubuntu's root-owned /lib -> usr/lib directory alias is admitted locally;
    unit-file links themselves are never followed. No global secure_path change.
    """
    source = pathlib.Path(supplied)
    prepackage_guard(source.is_absolute() and len(supplied) <= 4096 and '..' not in source.parts
                     and str(source) == supplied and len(source.parts) <= 16
                     and supplied.startswith(('/etc/systemd/', '/run/systemd/', '/usr/lib/systemd/',
                                              '/usr/local/lib/systemd/', '/lib/systemd/')), 'slice-paths')
    aliases = []
    for index in range(1, len(source.parts)):
        ancestor = pathlib.Path(*source.parts[:index + 1])
        try:
            info = ancestor.lstat()
        except FileNotFoundError:
            break
        prepackage_guard(info.st_uid == 0 and (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode))
                         and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), 'slice-paths')
        aliases.append((ancestor, stat.S_ISLNK(info.st_mode), identity(info) if stat.S_ISLNK(info.st_mode) else directory_identity(info)))
    resolved = source.resolve()
    prepackage_guard(str(resolved).startswith(('/etc/systemd/', '/run/systemd/', '/usr/lib/systemd/',
                                              '/usr/local/lib/systemd/')) and len(resolved.parts) <= 16, 'slice-paths')
    descriptors, pins, missing = [], [], None
    try:
        current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(current)
        root_info = os.fstat(current)
        prepackage_guard(root_info.st_uid == 0 and not root_info.st_mode & 0o022, 'slice-paths')
        for part in resolved.parts[1:]:
            try:
                before = os.stat(part, dir_fd=current, follow_symlinks=False)
            except FileNotFoundError:
                missing = (current, part)
                break
            prepackage_guard(stat.S_ISDIR(before.st_mode) and before.st_uid == 0
                             and not before.st_mode & 0o022, 'slice-paths')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            descriptors.append(child)
            prepackage_guard(directory_identity(os.fstat(child)) == directory_identity(before), 'slice-paths')
            pins.append((current, part, child, directory_identity(before)))
            current = child
        yield None if missing else current
        for parent, name, child, before in pins:
            prepackage_guard(directory_identity(os.fstat(child)) == before
                             and directory_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before, 'slice-paths')
        if missing:
            parent, name = missing
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                prepackage_guard(False, 'slice-paths')
        for ancestor, link, before in aliases:
            after = ancestor.lstat()
            prepackage_guard((identity(after) if link else directory_identity(after)) == before, 'slice-paths')
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def slice_leaf_absence(directory):
    for name in (SLICE, SLICE + '.d'):
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        prepackage_guard(False, 'slice-file-absent')  # Includes dangling links.


def slice_absence():
    prepackage_phase('slice-absence')
    keys = ('Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'SourcePath',
            'DropInPaths', 'Transient', 'ControlGroup', 'Following')
    row = fixed_properties(systemctl('show', SLICE, '--all', '--property=' + ','.join(keys)).stdout, keys)
    expected = {'Id': SLICE, 'ActiveState': 'inactive', 'SubState': 'dead', 'FragmentPath': '',
                'SourcePath': '', 'DropInPaths': '', 'Transient': 'no', 'ControlGroup': '', 'Following': ''}
    prepackage_guard(row['LoadState'] in ('loaded', 'not-found')
                     and all(row[key] == value for key, value in expected.items()), 'slice-metadata')
    raw = systemctl('show', '--property=UnitPath', '--value').stdout
    prepackage_guard(len(raw) <= 65536, 'slice-paths')
    paths = raw.decode('utf8').strip().split()
    prepackage_guard(0 < len(paths) <= 64 and len(set(paths)) == len(paths)
                     and '/etc/systemd/system' in paths, 'slice-paths')
    for path in paths:
        with manager_directory(path) as directory:
            if directory is not None:
                slice_leaf_absence(directory)
    raw = systemctl('show', '--all', '--no-pager', '--property=Id,Slice', '*.service', '*.scope').stdout
    prepackage_guard(0 < len(raw) <= 1024**2, 'slice-member-units')
    blocks = raw.decode('utf8').strip().split('\n\n')
    prepackage_guard(0 < len(blocks) <= 2048, 'slice-member-units')
    seen = set()
    for block in blocks:
        member = fixed_properties(block.encode(), ('Id', 'Slice'))
        prepackage_guard(member['Id'].endswith(('.service', '.scope')) and member['Id'] not in seen
                         and member['Slice'] != SLICE, 'slice-member-units')
        seen.add(member['Id'])
    prepackage_guard(not os.path.lexists('/sys/fs/cgroup' + FIXTURE_CGROUP), 'slice-cgroup-absent')
    report['slicePreflight'] = {'fixedImplicitSliceAbsenceVerified': True, 'lookupDirectories': len(paths),
                              'associatedUnitsInspected': len(seen), 'existingKernelCgroup': False}
    save()


def package(plan, helper, binding):
    phase('authenticated-package-preparation')
    I = load('native_shared_inventory', helper / 'runtime_inventory.py')
    S = load('native_source_merkle', helper / 'next_source.py')
    P = load('native_package_copy', helper / 'next_native_package.py')
    N = load('native_next_profile', helper / 'next_profile.py')
    require(binding['runtime'] == N.RUNTIME and binding['releaseAuthorized'] is False,
            'Bound build runtime or nonrelease purpose differs')
    expected = S.verified_source(plan['sourceProof'], plan['candidate'], require)
    # Native Git metadata can be influenced by a mutable checkout. Bind each
    # sealed helper independently to the cryptographically verified source tree.
    source_blobs = {row['path']: row['blob'] for row in expected}
    require(all(source_blobs.get(row['sourcePath']) == row['gitBlobId'] for row in binding['helpers'].values()),
            'Sealed helper differs from verified candidate source Merkle tree')
    release = pathlib.Path('/var/lib/aihr-admission/release')
    release.mkdir(mode=0o700)
    output = P.OwnedPackage(release, require)
    try:
        P.copy_tracked_source(plan['sourceDirectory'], expected, output, I, plan['runnerUid'], require)
        P.copy_installed_dependencies(plan['sourceDirectory'], output, I, plan['runnerUid'], require)
    finally:
        output.close()
    # Independent expected facts were captured by the trusted hosted install
    # owner BEFORE the first candidate child. Current runner bytes cannot mint
    # their own expected hash merely by reporting the official version string.
    installation = binding['installation']
    require(installation['version'] == 1 and installation['kind'] == 'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION',
            'Pre-candidate installed closure witness required')
    copied_dependencies = P.semantic_dependency_inventory(release, I, 0, require)
    require(copied_dependencies == installation['dependencies'], 'Copied dependencies differ from pre-candidate hosted install')
    for name, field in (('pnpm-lock.yaml', 'lockSha256'), ('package.json', 'packageSha256')):
        require(hashlib.sha256((release / name).read_bytes()).hexdigest() == installation[field],
                'Copied canonical install input differs from pre-candidate witness')
    report['installation'] = {'preCandidateWitnessMatched': True, 'dependencies': copied_dependencies,
        'nodeSha256': installation['node']['sha256'], 'nodeBytes': installation['node']['bytes'],
        'lockSha256': installation['lockSha256'], 'packageSha256': installation['packageSha256']}
    # Exact original format2 receiver/wire. This executes only the protected
    # stdlib tool, never application config or Node as root.
    phase('existing-format2-exact-receiver')
    run(['/usr/bin/python3', '-I', '-B', str(helper / 'build-bundle.py'), 'unpack-with-origin',
         binding['archivePath'], binding['manifestPath'], str(release / '.next'), str(release),
         binding['buildSourcePath']], timeout=60)
    (release / '.next').chmod(0o755)
    compiled = json.loads(pathlib.Path(binding['manifestPath']).read_bytes())
    # The unchanged receiver honors its caller's umask. These are exact trusted
    # format2 directories, made traversable for this public-code envelope only.
    for name in compiled['directories']:
        (release / '.next' / name).chmod(0o755)
    for alias in compiled['aliases']:
        file = release / '.next' / alias['path']
        name = file.name.split('-', 1)[0]
        require(name in ('sharp', 'fontkit') and file.is_symlink(), 'Unexpected compiled dependency alias')
        facts, target = I.package_identity(release, name, producer_source=binding['buildSourcePath'])
        require({key: alias[key] for key in facts} == facts and file.resolve() == target.resolve(),
                'Compiled alias package identity differs')
        file.unlink()
        file.symlink_to(os.path.relpath(target, file.parent))
    write(release / '.aihr-admission-release.json', N.canonical({'source': plan['candidate'], 'build': binding['nextBuildId']}), 0o644)
    for target in N.CACHE_TARGETS:
        directory = release / target
        directory.mkdir(parents=True, mode=0o755)
        directory.chmod(0o755)
    (release / '.next/cache').chmod(0o755)
    release.chmod(0o755)
    phase('nonroot-stock-native-dependency-probe')
    probe = json.loads(run(['/usr/sbin/runuser', '-u', 'nobody', '--', plan['nodePath'], '--max-old-space-size=256',
        '/usr/local/lib/aihr-admission/next_dependency_probe.cjs', str(release)], timeout=30,
        env={'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'HOME': '/var/empty/aihr', 'PATH': '/usr/bin:/bin'}).stdout)
    require(probe['kind'] == 'NONROOT_NATIVE_DEPENDENCY_PROBE_NOT_APPLICATION_ACCEPTANCE'
            and probe['runtime'] == N.RUNTIME and probe['imageBytes'] > 20 and probe['cjkGlyphs'] == 2,
            'Actual installed dependency/runtime probe differs')
    phase('complete-root-immutable-package-inventory')
    rows = []
    with I.PinnedTree(release, require) as tree:
        for name, info in tree.entries(maximum=N.MAX_ENTRIES):
            if any(name == target or name.startswith(target + '/') for target in N.CACHE_TARGETS):
                continue
            require(info.st_uid == 0, 'Native copied package owner differs')
            if stat.S_ISLNK(info.st_mode):
                tree.resolve(name, allow_absolute=False)
                row = {'path': name, 'kind': 'link', 'mode': 0o777, 'target': tree.readlink(name)}
            elif stat.S_ISDIR(info.st_mode):
                row = {'path': name, 'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)}
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unsafe copied package file')
                with tree.open_regular(name, N.MAX_FILE, expected=I.identity(info)) as (stream, _):
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                row = {'path': name, 'kind': 'file', 'mode': stat.S_IMODE(info.st_mode), 'size': info.st_size, 'sha256': digest}
            rows.append(row)
        tree.assert_unchanged()
    def root_digest(file):
        file = pathlib.Path(file)
        require(str(file.resolve()) == str(file) and file.stat().st_uid == 0
                and file.is_file() and not file.stat().st_mode & 0o022, 'Unprotected runtime executable dependency')
        return hashlib.sha256(file.read_bytes()).hexdigest()
    node = {'path': plan['nodePath'], 'sha256': root_digest(plan['nodePath'])}
    libraries = sorted(file for file in probe['executableFiles'] if file.startswith('/usr/lib/'))
    require(0 < len(libraries) <= 256, 'Bounded native system closure required')
    manifest = {'version': 1, 'source': plan['candidate'], 'build': binding['nextBuildId'], 'runtime': N.RUNTIME,
        'node': node, 'systemFiles': [{'path': file, 'sha256': root_digest(file)} for file in libraries],
        'producerSourcePath': binding['buildSourcePath'], 'entries': sorted(rows, key=lambda row: row['path'])}
    manifest_path = pathlib.Path('/etc/aihr-admission/package.json')
    write(manifest_path, N.canonical(manifest))
    environment_path = pathlib.Path('/etc/aihr-admission/environment.json')
    write(environment_path, N.canonical({'version': 1, 'values': plan['environment']}))
    # Root literal unit-file values are subsequently independently parsed by the
    # production CHECKONLY environment boundary, not accepted as opaque text.
    require(all('\n' not in value and '\r' not in value and '\0' not in value for value in plan['environment'].values()), 'Invalid unit environment literal')
    write(pathlib.Path('/etc/aihr-admission/app.env'), ''.join(key + '=' + json.dumps(value) + '\n' for key, value in sorted(plan['environment'].items())))
    report['package'] = {'source': plan['candidate'], 'build': binding['nextBuildId'], 'entries': len(rows),
        'manifestSha256': hashlib.sha256(N.canonical(manifest)).hexdigest(), 'sameCanonicalBuildPacket': True,
        'dependencyProvenance': 'HOSTED_LOCK_BOUND_INSTALL_PLUS_ROOT_CAPTURE_NOT_PACKET_COVERED',
        'actionManifestSha256': hashlib.sha256((release / '.next/server/server-reference-manifest.json').read_bytes()).hexdigest(),
        'actionKeyOverride': False}
    return N, release, {'manifestPath': str(manifest_path), 'manifestSha256': report['package']['manifestSha256'],
        'format2ManifestPath': binding['manifestPath'], 'format2ManifestSha256': binding['manifestSha256'],
        'format2ArchiveSha256': binding['archiveSha256'], 'privateEnvironmentPath': str(environment_path),
        'privateEnvironmentSha256': hashlib.sha256(N.canonical({'version': 1, 'values': plan['environment']})).hexdigest()}


def install_helpers(helper, plan, binding):
    prepackage_phase('sealed-helpers')
    destination = pathlib.Path('/usr/local/lib/aihr-admission')
    for index, name in enumerate(('controller.py', 'next_profile.py', 'runtime_inventory.py', 'next_fixture_poststart.py',
                 'next_fixture_filesystem.py', 'next_dependency_probe.cjs')):
        source = helper / name
        info = source.lstat()
        prepackage_guard(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o400, 'sealed-helper-' + str(index))
        write(destination / name, source.read_bytes(), 0o644)
    source = pathlib.Path(plan['nodePath'])
    installed_node = binding['installation']['node']
    prepackage_phase('node-hint')
    prepackage_guard(plan['nodePath'] == installed_node['path'], 'node-hint')
    prepackage_phase('node-stat')
    before = source.lstat()
    prepackage_guard(source.resolve() == source and stat.S_ISREG(before.st_mode) and before.st_uid in (0, plan['runnerUid'])
            and not before.st_mode & 0o022 and 0 < before.st_size <= 256 * 1024**2,
            'node-stat')
    prepackage_phase('node-read')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        prepackage_guard(identity(os.fstat(fd)) == identity(before), 'node-before-read')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(256 * 1024**2 + 1)
        prepackage_guard(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before) == identity(source.lstat()),
                'node-after-read')
        prepackage_guard(len(raw) == installed_node['bytes'] and hashlib.sha256(raw).hexdigest() == installed_node['sha256'],
                'node-installed-bytes')
        prepackage_phase('node-install')
        write(destination / 'node', raw, 0o755)
    finally:
        os.close(fd)
    # Only this root-owned copy can become the app executable. No root JS runs.
    plan['nodePath'] = str(destination / 'node')


def configure(plan, binding, N, release, runtime_package):
    phase('protected-native-configuration')
    nobody = pwd.getpwnam('nobody')
    require(nobody.pw_uid == 65534 and nobody.pw_gid == 65534, 'Expected fixed nonroot app principal')
    used = {3443}
    pool, control_port = [port(used) for _ in range(32)], port(used)
    envelope = {'version': 1, 'kind': 'HOSTED_NEXT_SAME_BUILD_V1', 'workers': 2,
        'suite': 'workflow-preflight', 'cpuOversubscriptionDiagnostic': False, 'slice': SLICE,
        'cgroupPath': FIXTURE_CGROUP, 'cpuQuotaPercent': 400,
        'memoryHighBytes': 7168 * 1024**2, 'memoryMaxBytes': 8192 * 1024**2, 'memorySwapMaxBytes': 0,
        'totalHeapMiB': 4096, 'totalWebConnections': 16, 'totalWaitingBudget': 2048, 'tasksMax': 1024}
    mounts = {}
    for slot, unit in enumerate(UNITS, 1):
        mounts[unit] = []
        for target in N.CACHE_TARGETS:
            source = pathlib.Path('/var/cache/aihr', runtime_package['manifestSha256'], str(slot), target.split('/')[-1])
            source.mkdir(parents=True, mode=0o700)
            # Parent metadata is protected; only the exact three leaves are app-owned.
            for parent in (source.parent.parent, source.parent):
                parent.chmod(0o755)
            os.chown(source, nobody.pw_uid, nobody.pw_gid)
            source.chmod(0o700)
            mounts[unit].append({'source': str(source), 'target': target})
    nginx = pathlib.Path('/etc/nginx/aihr-admission/fixture.conf')
    run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
         '-addext', 'subjectAltName=DNS:localhost', '-keyout', '/etc/nginx/aihr-admission/tls.key',
         '-out', '/etc/nginx/aihr-admission/tls.crt'], timeout=15)
    pathlib.Path('/etc/nginx/aihr-admission/tls.key').chmod(0o600)
    write(nginx, '''user www-data;
worker_processes 2;
pid /run/aihr-admission/nginx.pid;
error_log /run/aihr-admission/nginx-error.log;
events { worker_connections 1024; }
http {
 log_format owned '$upstream_addr $request_method $uri $status';
 access_log /run/aihr-admission/access.log owned;
 include /etc/nginx/aihr-admission/ready.conf;
 map $http_upgrade $connection_upgrade { default upgrade; '' close; }
 server {
  listen 127.0.0.1:3443 ssl;
  ssl_certificate /etc/nginx/aihr-admission/tls.crt;
  ssl_certificate_key /etc/nginx/aihr-admission/tls.key;
  client_max_body_size 20m;
  location / {
   proxy_pass http://aihr_ready_workers;
   proxy_next_upstream off;
   proxy_http_version 1.1;
   proxy_set_header Host $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection $connection_upgrade;
   proxy_buffering off;
   proxy_request_buffering off;
   add_header X-Aihr-Fixture-Worker $upstream_addr always;
  }
 }
}
''')
    files = {PROXY: '''[Unit]
Description=Owned actual Next admission Nginx fixture
[Service]
Type=forking
PIDFile=/run/aihr-admission/nginx.pid
ExecStartPre=/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py prepare-proxy
ExecStart=/usr/sbin/nginx -c /etc/nginx/aihr-admission/fixture.conf -p /etc/nginx/aihr-admission
ExecStartPost=/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py confirm-proxy
ExecReload=/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py reload
ExecStop=/usr/sbin/nginx -c /etc/nginx/aihr-admission/fixture.conf -p /etc/nginx/aihr-admission -s quit
TimeoutStopSec=5
UMask=0077
''', SLICE: '''[Unit]
Description=Owned standard hosted actual Next aggregate
[Slice]
CPUAccounting=yes
MemoryAccounting=yes
CPUQuota=400%
MemoryHigh=7168M
MemoryMax=8192M
MemorySwapMax=0
TasksMax=1024
'''}
    for slot, unit in enumerate(UNITS, 1):
        binds = '\n'.join('BindPaths=' + row['source'] + ':' + str(release) + '/' + row['target'] + ':norbind' for row in mounts[unit])
        files[unit] = f'''[Unit]
Description=Owned actual same-build Next worker {slot}
After={PROXY}
[Service]
Type=simple
User=nobody
DynamicUser=no
WorkingDirectory={release}
EnvironmentFile=/etc/aihr-admission/app.env
EnvironmentFile=-/run/aihr-admission/ports/{slot}.env
Environment=AIHR_APP_WORKERS=2 AIHR_DB_TOTAL_CONNECTIONS=16 AIHR_DB_POOL_MAX=8
ExecStartPre=+/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py reserve {unit}
ExecStart={plan['nodePath']} --max-old-space-size=2048 {release}/node_modules/next/dist/bin/next start --hostname 127.0.0.1
ExecStartPost=+/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/next_fixture_poststart.py {unit}
ExecStopPost=+/usr/bin/python3 -I -B /usr/local/lib/aihr-admission/controller.py cleanup {unit}
Restart=no
KillMode=control-group
Delegate=no
TimeoutStartSec=90
TimeoutStopSec=5
ProtectSystem=strict
ProtectHome=yes
PrivateMounts=yes
PrivateTmp=yes
NoNewPrivileges=yes
RestrictNamespaces=yes
CapabilityBoundingSet=
BindReadOnlyPaths={release}:{release}:norbind
{binds}
Slice={SLICE}
UMask=0077
'''
    for name, contents in files.items():
        file = pathlib.Path('/etc/systemd/system', name)
        require(not os.path.lexists(file), 'Fixture unit destination already exists')
        write(file, contents, 0o644)
        info = file.stat()
        owned_units[name] = (info.st_dev, info.st_ino)
    systemctl('daemon-reload')
    C = load('actual_next_controller', pathlib.Path('/usr/local/lib/aihr-admission/controller.py'))
    profile = {'version': 2, 'epoch': os.urandom(16).hex(), 'source': plan['candidate'], 'build': binding['nextBuildId'],
        'resourceEnvelopeDigest': C.digest(envelope), 'resourceEnvelope': envelope,
        'controllerDigest': hashlib.sha256(pathlib.Path(C.__file__).read_bytes()).hexdigest(),
        'trustedModules': {name: hashlib.sha256(pathlib.Path('/usr/local/lib/aihr-admission', name).read_bytes()).hexdigest()
                           for name in ('next_profile.py', 'runtime_inventory.py')},
        'runtimePackage': runtime_package, 'unitCacheMounts': mounts, 'stateDirectory': '/var/lib/aihr-admission',
        'nginxBinary': '/usr/sbin/nginx', 'nginxConfig': str(nginx), 'nginxPrefix': '/etc/nginx/aihr-admission',
        'nginxPid': '/run/aihr-admission/nginx.pid', 'nginxUnit': PROXY,
        'managedInclude': '/etc/nginx/aihr-admission/ready.conf', 'controlPort': control_port,
        'ports': pool, 'units': {}, 'healthSeconds': 60, 'activationSeconds': 5, 'drainSeconds': 30,
        'reloadGuardDigest': C.command_identity(props(PROXY)['ExecReload'])}
    for slot, unit in enumerate(UNITS, 1):
        profile['units'][unit] = {'environmentFile': f'/run/aihr-admission/ports/{slot}.env',
            'releaseDirectory': str(release), 'workerUid': nobody.pw_uid,
            'commandDigest': C.command_identity(props(unit)['ExecStart']), 'executable': plan['nodePath']}
    write(C.PROFILE, N.canonical(profile))
    check = json.loads(control('check-only').stdout)
    require(check.get('kind') == 'ADMISSION_CHECKONLY' and check.get('rootBoundaryInspected') is True
            and check.get('installationAvailable') is False, 'Non-starting boundary inspection did not qualify')
    require(all(props(unit)['MainPID'] == '0' for unit in UNITS), 'CHECKONLY started an application worker')
    report['checkOnlyDidNotStartWorkers'] = True
    write(pathlib.Path('/run/aihr-admission/permit-' + UNITS[0]), b'owned cold gate\n')
    systemctl('start', PROXY, timeout=60)
    require(status()['workers'] == [], 'Empty proxy unexpectedly published worker')
    report['nativeIngress'] = {'nginx': run(['/usr/sbin/nginx', '-v'], check=False).stderr.decode().strip(),
        'tls': True, 'proxyNextUpstream': 'off', 'buffering': False, 'requestBuffering': False,
        'nodeProxyUsed': False, 'webWorkers': 2, 'steadyLoadCapacityClaim': False}
    return C


def native_worker(C, row, plan, binding):
    unit = row['unit']
    with contextlib.closing(C.Profile(C.PROFILE)) as profile:
        host = C.LinuxHost(profile)
        identity_value = host.worker(unit, props(unit)['InvocationID'], row['port'])
        proof = host.next_worker_evidence[unit]
        require(proof['namespace']['actualKernelMountsVerified'] and proof['namespace']['actualEnvironmentVerified']
                and proof['resources']['aggregateCapsVerified'], 'Native live kernel proofs absent')
        pid = identity_value['pid']
        before = C.process_identity(pid)
        require(before == identity_value, 'Worker changed before namespace write controls')
        filesystem = json.loads(run(['/usr/bin/nsenter', '--target', str(pid), '--mount', '--',
            '/usr/sbin/runuser', '-u', 'nobody', '--', '/usr/bin/python3', '-I', '-B',
            '/usr/local/lib/aihr-admission/next_fixture_filesystem.py', '/var/lib/aihr-admission/release',
            binding['buildSourcePath'], plan['sourceDirectory'], os.urandom(16).hex()], timeout=10).stdout)
        require(C.process_identity(pid) == before and C.alive(before), 'Worker changed after namespace controls')
        require(filesystem == {'actualNamespaceFilesystemVerified': True, 'cacheWrites': 3,
            'immutableParentRefusals': 5, 'originalCheckoutReadWriteRefusals': 4}, 'Native filesystem control differs')
        return {'unit': unit, 'port': row['port'], 'invocation': props(unit)['InvocationID'],
                'process': identity_value, 'kernel': proof, 'filesystem': filesystem}


def browser_core(plan, binding, C):
    global browser
    phase('actual-browser-two-worker-boot')
    runner = pwd.getpwuid(plan['runnerUid'])
    require(runner.pw_gid == plan['runnerGid'] and runner.pw_uid > 0, 'Actual runner identity differs')
    # This transient driver gets no app/owner DB URL, platform token, session key
    # or build packet access. It has only fictional login inputs + browser cache.
    environment = {'PATH': '/usr/bin:/bin', 'HOME': runner.pw_dir, 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
    driver = '/var/lib/aihr-admission/release/scripts/performance/native-next-boot-browser.mjs'
    args = ['/usr/bin/systemd-run', '--system', '--unit=' + BROWSER, '--wait', '--pipe', '--quiet',
        '--property=User=' + runner.pw_name, '--property=Group=' + str(plan['runnerGid']),
        '--property=MemoryMax=2G', '--property=MemorySwapMax=0', '--property=TasksMax=512',
        '--property=NoNewPrivileges=yes', '--property=KillMode=control-group',
        '--property=Description=Owned actual Next browser ' + plan['runId'],
        '--setenv=HOME=' + runner.pw_dir, '--setenv=PATH=/usr/bin:/bin', '--setenv=LANG=C.UTF-8',
        plan['nodePath'], '--max-old-space-size=512', driver, plan['browserInputPath']]
    browser = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    expected = ['start-first', 'start-second-cold', 'admit-second', 'browser-core-finished']
    completed, first, second, proofs = [], None, None, []
    selector = selectors.DefaultSelector()
    selector.register(browser.stdout, selectors.EVENT_READ)
    buffer = b''
    try:
        while len(completed) < len(expected):
            require(browser.poll() is None, 'Native browser exited before complete protocol')
            require(selector.select(left(90)), 'Native browser protocol deadline exceeded')
            block = os.read(browser.stdout.fileno(), 65537)
            require(block, 'Native browser protocol ended early')
            buffer += block
            require(len(buffer) <= 65536, 'Native browser protocol exceeds bound')
            if b'\n' not in buffer:
                continue
            line, buffer = buffer.split(b'\n', 1)
            request = json.loads(line)
            index = len(completed)
            require(request == {'id': index + 1, 'operation': expected[index]}, 'Native browser protocol order/fields differ')
            operation = expected[index]
            phase('actual-browser-' + operation)
            if operation == 'start-first':
                systemctl('start', UNITS[0], timeout=90)
                first = until(lambda: ready(UNITS[0]), 'first actual Next worker READY')
                proofs.append(native_worker(C, first, plan, binding))
                result = {'port': first['port']}
            elif operation == 'start-second-cold':
                systemctl('start', '--no-block', UNITS[1])
                second = until(lambda: cold(UNITS[1]), 'second actual Next healthy but unpublished')
                require(second['port'] != first['port'], 'Cold endpoint reused current peer endpoint')
                proofs.append(native_worker(C, second, plan, binding))
                result = {'port': second['port'], 'admitted': False}
            elif operation == 'admit-second':
                cold_state = state()
                require(second['id'] not in cold_state['published']['ready'], 'Cold worker publication happened before gate')
                access = pathlib.Path('/run/aihr-admission/access.log').read_text()
                cold_rows = [row for row in access.splitlines() if row.startswith('127.0.0.1:' + str(second['port']) + ' ')]
                require(not cold_rows, 'Cold worker served business ingress traffic')
                report['coldBusinessRequests'] = 0
                write(pathlib.Path('/run/aihr-admission/permit-' + UNITS[1]), b'owned actual admission\n')
                admitted = until(lambda: ready(UNITS[1]), 'second actual Next worker READY')
                require(admitted['id'] == second['id'] and admitted['port'] == second['port'], 'Cold generation changed during admission')
                proofs.append(native_worker(C, admitted, plan, binding))
                result = {'port': admitted['port']}
            else:
                require(first and second, 'Two actual workers were not established')
                result = {'accepted': True}
            completed.append(operation)
            browser.stdin.write((json.dumps({'id': index + 1, 'ok': True, 'result': result}) + '\n').encode())
            browser.stdin.flush()
        browser.stdin.close()
        require(browser.wait(timeout=left(30)) == 0, 'Native browser final assertions or cleanup failed')
        # No extra out-of-order control request can silently be ignored.
        require(not buffer.strip() and not browser.stdout.read(65537).strip(), 'Unexpected native browser protocol tail')
        browser_report = json.loads(regular(pathlib.Path(plan['evidenceDirectory'], 'native-next-boot-browser.json'), plan['runnerUid'], 2 * 1024**2))
        require(browser_report.get('complete') is True and browser_report.get('unexpectedBrowserErrors') == 0
                and browser_report.get('hydratedAccountControls', 0) >= 6 and browser_report.get('nonemptyOwnPayrollView') is True
                and browser_report.get('servedPorts') == sorted([first['port'], second['port']])
                and len(browser_report.get('logins', [])) == 2, 'Actual browser functional evidence incomplete')
        report['browser'] = {'complete': True, 'realPasswordTotpLogins': 2,
            'hydratedAccountControls': browser_report['hydratedAccountControls'], 'unexpectedBrowserErrors': 0,
            'homeViews': len(browser_report['home']), 'nonemptyOwnPayrollView': True,
            'servedPorts': browser_report['servedPorts']}
        report['workers'] = proofs
        report['postBrowserWorkers'] = [native_worker(C, ready(unit), plan, binding) for unit in UNITS]
        report['actualNextBootVerified'] = True
    finally:
        selector.close()
        if browser.poll() is None:
            # The launcher belongs to this invocation. Its systemd child is
            # stopped only after independently checking transient-unit identity.
            browser.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                browser.wait(timeout=5)


def release_workers(C):
    phase('drain-stop-and-actual-bind-reclamation')
    for unit in UNITS:
        if ready(unit):
            control('drain', unit)
        systemctl('stop', unit, timeout=15)
    def reclaimed():
        control('reconcile')
        current = state()
        require(not current['published']['ready'], 'Stopped worker remained published')
        for row in current['generations'].values():
            if row['phase'] != 'RELEASED':
                return False
        with contextlib.closing(C.Profile(C.PROFILE)) as profile:
            host = C.LinuxHost(profile)
            require(all(host.generation_dead(row) for row in current['generations'].values()), 'Native raw-bind/process proof absent after release')
        return True
    until(reclaimed, 'all stopped actual Next generations conservatively reclaimed', seconds=90)
    report['allStoppedGenerationsReclaimed'] = True
    report['rawBindAndProcessFamilyBarriersPreserved'] = True


def require_stopped(unit):
    actual = props(unit)
    require(actual.get('MainPID', '0') == '0' and actual.get('ControlPID', '0') == '0'
            and actual.get('ActiveState') in ('inactive', 'failed'), 'Owned runtime process remains; preserve package')
    group = actual.get('ControlGroup', '')
    if not group:
        return
    require(group.startswith('/') and '..' not in group.split('/'), 'Unexpected stopped cgroup path')
    root = pathlib.Path('/sys/fs/cgroup' + group)
    if not root.exists():
        return
    pending, seen = [root], 0
    while pending:
        directory = pending.pop()
        seen += 1
        require(seen <= 512 and not directory.is_symlink(), 'Stopped process-family inspection exceeds bound')
        require(not (directory / 'cgroup.procs').read_text().strip(), 'Owned stopped process family remains live')
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(pathlib.Path(entry.path))


def cleanup():
    # Never remove a package under an unowned/replaced live service declaration.
    for unit, expected in owned_units.items():
        path = pathlib.Path('/etc/systemd/system', unit)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and (info.st_dev, info.st_ino) == expected,
                'Owned unit changed; preserve uncertain runtime for diagnosis')
    transient = props(BROWSER)
    if transient.get('LoadState') != 'not-found':
        actual = systemctl('show', BROWSER, '--property=Description,Transient').stdout.decode()
        require('Transient=yes\n' in actual and 'Description=Owned actual Next browser ' + report['runId'] + '\n' in actual,
                'Unexpected browser transient unit; preserve uncertain runtime')
        systemctl('stop', BROWSER, check=False, timeout=10)
        require_stopped(BROWSER)
        systemctl('reset-failed', BROWSER, check=False)
    for unit in [*reversed(UNITS), PROXY, SLICE]:
        if unit in owned_units:
            systemctl('stop', unit, check=False, timeout=15)
            require_stopped(unit)
            systemctl('reset-failed', unit, check=False)
            pathlib.Path('/etc/systemd/system', unit).unlink()
    if owned_units:
        systemctl('daemon-reload', check=False)
    require(shutil.rmtree.avoids_symlink_attacks, 'Descriptor-safe cleanup unavailable')
    for name in reversed(ROOTS):
        if name in owned_paths:
            info = os.lstat(name)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                    and (info.st_dev, info.st_ino) == owned_paths[name], 'Owned fixture directory changed')
            shutil.rmtree(name)
    if created_home:
        home = pathlib.Path('/var/empty/aihr')
        info = home.lstat()
        require((info.st_dev, info.st_ino) == owned_paths[str(home)] and info.st_uid == 0, 'Owned empty home changed')
        home.rmdir()
    if created_empty_parent is not None:
        parent = pathlib.Path('/var/empty')
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and (info.st_dev, info.st_ino) == created_empty_parent, 'Owned empty-home parent changed')
        parent.rmdir()


def main():
    global evidence, evidence_fd, DEADLINE
    require(sys.platform == 'linux' and os.geteuid() == 0 and len(sys.argv) == 2, 'Root Linux native fixture requires one private plan')
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr'
            and os.environ.get('GITHUB_JOB') == 'native-test' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
            'Actual hosted native-test context required')
    uid, gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    require(uid > 0 and gid > 0, 'Actual nonroot sudo issuer required')
    plan = json.loads(regular(sys.argv[1], uid, 96 * 1024**2))
    fields = {'version', 'kind', 'candidate', 'controller', 'runId', 'unit', 'sourceDirectory', 'nodePath',
              'packetDirectory', 'buildBindingPath', 'sourceProof', 'environment', 'fixture', 'browserInputPath',
              'evidenceDirectory', 'runnerUid', 'runnerGid'}
    require(isinstance(plan, dict) and set(plan) == fields and plan['version'] == 1
            and plan['kind'] == 'NATIVE_NEXT_TWO_WORKER_BOOT_INPUT' and plan['runnerUid'] == uid and plan['runnerGid'] == gid,
            'Closed native Next plan required')
    require(plan['candidate'] == os.environ['AIHR_CI_HEAD'] and plan['controller'] == os.environ['AIHR_CI_CONTROL_HEAD']
            and plan['runId'] == os.environ['GITHUB_RUN_ID'] and re.fullmatch(r'[1-9][0-9]{0,19}', plan['runId'])
            and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', plan['unit']), 'Actual source/controller/run/unit binding differs')
    helper = pathlib.Path('/var/lib/aihr-native-build', plan['runId'], plan['unit'], 'helpers')
    require(pathlib.Path(__file__).absolute() == helper / 'test_next_native.py' and helper.resolve() == helper
            and helper.stat().st_uid == 0 and stat.S_IMODE(helper.stat().st_mode) == 0o700, 'Use fixed sealed root fixture helpers')
    adapter = load('sealed_next_build_binding', helper / 'next_build_binding.py')
    binding = adapter.read_native_build_binding(plan['packetDirectory'], plan['buildBindingPath'], plan['candidate'],
        plan['controller'], plan['runId'], plan['unit'], os.environ['RUNNER_TEMP'], uid, require)
    require(binding['helperDirectory'] == str(helper), 'Sealed helper witness differs')
    require(pathlib.Path(plan['sourceDirectory']).resolve() == pathlib.Path(plan['sourceDirectory'])
            and plan['sourceDirectory'].startswith('/home/') and binding['buildSourcePath'].startswith('/home/'),
            'Actual hosted source/producer layout required')
    destination = pathlib.Path(plan['evidenceDirectory'])
    require(destination.resolve() == destination and destination.is_dir() and destination.stat().st_uid == uid
            and pathlib.Path(os.environ['RUNNER_TEMP']).resolve() in destination.parents, 'Actual admitted evidence directory required')
    directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        evidence_fd = os.open('runtime-next-admission-native.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                              0o644, dir_fd=directory_fd)
        os.fchmod(evidence_fd, 0o644)
    finally:
        os.close(directory_fd)
    report.update({'source': plan['candidate'], 'controller': plan['controller'], 'runId': plan['runId'], 'unit': plan['unit']})
    report['testedBuild'] = {'source': plan['candidate'], 'controller': plan['controller'], 'runId': plan['runId'], 'unit': plan['unit'],
        **{name: binding[name] for name in ('nextBuildId', 'archiveSha256', 'manifestSha256', 'provenanceSha256')},
        **{name: binding['witness'][name] for name in ('artifactId', 'artifactDigest', 'producerJobId')}}
    report['sealedHelpers'] = binding['helpers']
    phase('actual-host-and-sealed-input-preflight')
    require(len(os.sched_getaffinity(0)) == 4, 'Standard four-CPU hosted worker required')
    memory = pathlib.Path('/proc/meminfo').read_text()
    total = int(re.search(r'^MemTotal:\s+([0-9]+) kB$', memory, re.M)[1]) * 1024
    require(15 * 1024**3 <= total <= 17 * 1024**3, 'Standard hosted memory profile required')
    require(pathlib.Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'Unified native cgroup required')
    with socket.socket() as ingress:
        ingress.bind(('127.0.0.1', 3443))  # Actual conservative bind, no reuse option.
    browser_input = json.loads(regular(plan['browserInputPath'], uid, 2 * 1024**2))
    require(isinstance(browser_input, dict) and set(browser_input) == {'version', 'kind', 'budgetMs', 'evidenceDirectory', 'fixture'}
            and browser_input['version'] == 1 and browser_input['kind'] == 'PRIVATE_NATIVE_NEXT_BOOT_BROWSER_INPUT'
            and browser_input['budgetMs'] == 300000 and browser_input['fixture'] == plan['fixture']
            and browser_input['evidenceDirectory'] == plan['evidenceDirectory'], 'Private browser input binding differs')
    save()
    succeeded = False
    try:
        fixture_directories()
        install_helpers(helper, plan, binding)
        N, release, runtime_package = package(plan, helper, binding)
        C = configure(plan, binding, N, release, runtime_package)
        browser_core(plan, binding, C)
        release_workers(C)
        succeeded = True
    except BaseException as error:
        report['failureType'] = type(error).__name__
        report['complete'] = False
        save()
        raise
    finally:
        DEADLINE = TOTAL_DEADLINE
        try:
            cleanup()
            report['ownedRuntimeCleaned'] = True
        except BaseException:
            report['ownedRuntimeCleaned'] = False
            report['complete'] = False
            save()
            raise
        report['complete'] = succeeded
        save()
        if evidence_fd is not None:
            os.close(evidence_fd)


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise RuntimeError('Owned native fixture interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except BaseException:
        # Do not copy private child output, GUCs, env, cookie or arbitrary error
        # text into uploaded logs. The bounded phase/failureType is retained.
        sys.stderr.write('Actual Next native boot fixture refused; inspect bounded phase evidence\n')
        sys.exit(1)
