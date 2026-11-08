"""Owned kernel conformance ONLY: no Next, app, build, database or installation.

Two native positives: privileged-hook cache view and bounded resistant-family
stop. Fixed negative declarations/inodes/links/mounts/invocations must refuse.
The separately admitted component has its own30s aggregate envelope.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import time

ROOT = pathlib.Path('/var/lib/aihr-next-host-conformance')
UNIT = 'aihr-next-host-conformance.service'
FOREIGN = 'aihr-next-foreign-conformance.service'
AGGREGATE = 'aihrnexthostresource.slice'
AGGREGATE_GROUP = '/' + AGGREGATE
UNITS = (UNIT, FOREIGN, AGGREGATE)
RELEASE = ROOT / 'release'
TOTAL_DEADLINE = time.monotonic() + 27
DEADLINE = TOTAL_DEADLINE - 7  #20s conformance work +7s owned cleanup;3s transport reserve.
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def require(value, reason):
    if not value:
        raise AssertionError(reason)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def limit(cap=3):
    left = DEADLINE - time.monotonic()
    require(left > 0, 'Host conformance aggregate deadline exceeded')
    return min(cap, left)


def command(*arguments, check=True, cap=3):
    result = subprocess.run(arguments, env=ENV, capture_output=True, timeout=limit(cap))
    if check:
        require(result.returncode == 0, 'Fixed native conformance command refused')
    return result


def properties(unit, cap=3):
    require(unit in UNITS, 'Unknown native conformance unit')
    result = command('/usr/bin/systemctl', '--system', 'show', unit,
        '--property=LoadState,InvocationID,MainPID,ControlPID,ActiveState,SubState,ControlGroup,FragmentPath,SourcePath,Transient,DropInPaths,KillMode,Delegate,User,NoNewPrivileges,TimeoutStopUSec,SendSIGKILL,RuntimeMaxUSec,CPUWeight', cap=cap)
    require(len(result.stdout) <= 8192, 'Native conformance metadata exceeds bound')
    return dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)


def declaration_absent(name):
    require(name in UNITS, 'Unknown native declaration')
    if os.path.lexists('/etc/systemd/system/' + name):
        return False
    actual = properties(name, cap=.2)
    if name != AGGREGATE:
        return actual.get('LoadState') == 'not-found'
    # systemd synthesizes implicit slices. An inactive, fragment/dropin-free
    # declaration with no kernel group is absence; a loaded file is not.
    return (actual.get('LoadState') in ('not-found', 'loaded')
            and actual.get('ActiveState') == 'inactive'
            and actual.get('SubState') == 'dead'
            and actual.get('FragmentPath') == actual.get('DropInPaths') == ''
            and actual.get('SourcePath') == '' and actual.get('Transient') == 'no'
            and actual.get('ControlGroup') in ('', AGGREGATE_GROUP)
            and not os.path.lexists('/sys/fs/cgroup' + AGGREGATE_GROUP))


def family_stopped(unit, cap=3):
    actual = properties(unit, cap=cap)
    if (actual.get('MainPID', '0') if unit == AGGREGATE else actual.get('MainPID')) != '0' or (actual.get('ControlPID', '0') if unit == AGGREGATE else actual.get('ControlPID')) != '0' or actual.get('ActiveState') not in ('inactive', 'failed'):
        return False
    expected = AGGREGATE_GROUP if unit == AGGREGATE else AGGREGATE_GROUP + '/' + unit if unit == UNIT else '/system.slice/' + unit
    require(actual.get('ControlGroup', '') in ('', expected), 'Native conformance cgroup changed')
    directory = pathlib.Path('/sys/fs/cgroup' + expected)
    if not directory.exists():
        return True
    require(not directory.is_symlink(), 'Native conformance cgroup is a link')
    events = dict(line.split() for line in (directory / 'cgroup.events').read_text().splitlines())
    return events.get('populated') == '0' and not (directory / 'cgroup.procs').read_text().strip()


def aggregate_directory():
    return pathlib.Path('/sys/fs/cgroup' + AGGREGATE_GROUP)


def slice_occupants(N):
    """No slice stop may signal an unowned descendant, even during cleanup."""
    directory = aggregate_directory()
    if not os.path.lexists(directory):
        return
    secure(directory, 0, directory=True)
    require(N.kernel_text(directory / 'cgroup.procs', secure, require) == '', 'Foreign aggregate process; retain slice')
    # The only possible service child is fixed, and Delegate=no forbids
    # it creating a further hierarchy. Refuse every directory beyond it.
    entries = list(directory.iterdir());require(len(entries) <= 256, 'Aggregate metadata exceeds bound')
    for entry in entries:
        info = entry.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'Linked aggregate metadata; retain slice')
        if stat.S_ISDIR(info.st_mode):
            require(entry.name == UNIT, 'Foreign slice child; retain slice')
            secure(entry, 0, directory=True)
            children = list(entry.iterdir());require(len(children) <= 256, 'Worker metadata exceeds bound')
            for child in children:
                mode = child.lstat().st_mode
                require(not stat.S_ISDIR(mode) and not stat.S_ISLNK(mode), 'Nested foreign slice child; retain slice')


def resource_process(actual):
    """Actual fixed app PID/start/executable/cgroup, never a caller JSON PID."""
    pid = actual.get('MainPID', '')
    require(pid.isdigit() and int(pid) > 1 and actual.get('ControlGroup') == AGGREGATE_GROUP + '/' + UNIT,
            'Native resource process scope differs')
    proc = pathlib.Path('/proc') / pid
    raw = (proc / 'stat').read_text(); end = raw.rfind(')'); fields = raw[end + 2:].split()
    require(end > 0 and len(fields) >= 20 and fields[0] not in ('Z', 'X'), 'Native resource process is not live')
    require((proc / 'exe').resolve() == pathlib.Path('/usr/bin/python3').resolve()
            and (proc / 'cmdline').read_bytes().split(b'\0') ==
            [b'/usr/bin/python3', b'-I', b'-B', os.fsencode(ROOT / 'probe.py'), b'app', b''],
            'Native resource process executable differs')
    require((proc / 'cgroup').read_text() == '0::' + AGGREGATE_GROUP + '/' + UNIT + '\n', 'Native resource process cgroup differs')
    return (int(pid), fields[19])


def resource_guard_reason(error):
    return {'Missing nonroot ancestor resource cap': 'missing-nonroot-cap',
            'Ancestor memory cap is below accepted app envelope': 'ancestor-memory-too-low',
            'Ancestor CPU cap is below accepted app envelope': 'ancestor-cpu-too-low'}.get(str(error), 'resource-check-refused')


def resource_topology(N, I, invocation, files, source_hashes):
    """Closed observation of the UNCHANGED real resource method, not readiness."""
    aggregate = pathlib.Path('/sys/fs/cgroup' + AGGREGATE_GROUP)
    directories = [('worker', aggregate / UNIT), ('aggregate', aggregate), ('root', pathlib.Path('/sys/fs/cgroup'))]
    identities, weights = {}, []
    def custody():
        for name in (UNIT, AGGREGATE):
            limit()
            file = pathlib.Path('/etc/systemd/system', name);secure(file, 0)
            info = file.lstat()
            require((info.st_dev, info.st_ino) == files[name], 'Native resource declaration replaced')
            actual = properties(name)
            require(actual.get('FragmentPath') == str(file) and actual.get('DropInPaths') == ''
                    and actual.get('SourcePath') == '' and actual.get('Transient') == 'no', 'Native resource declaration differs')
            if name == UNIT:
                N.require_leaf_cpu_weight(actual, require)
        for name, digest in source_hashes.items():
            limit()
            file = ROOT / name;secure(file, 0)
            require(hashlib.sha256(file.read_bytes()).hexdigest() == digest, 'Native resource helper changed')
    def capture():
        rows = []
        for tier, directory in directories:
            limit()
            secure(directory, 0, directory=True)
            info = directory.lstat(); identity = (info.st_dev, info.st_ino)
            if tier in identities:
                require(identities[tier] == identity, 'Native resource tier replaced')
            else:
                identities[tier] = identity
            if tier == 'worker':
                weight = N.kernel_text(directory / 'cpu.weight', secure, require)
                require(weight == '100', 'Actual worker CPU weight differs')
                weights.append(int(weight))
            available = N.kernel_text(directory / 'cgroup.controllers', secure, require).split()
            enabled = N.kernel_text(directory / 'cgroup.subtree_control', secure, require).split()
            require(len(available) <= 32 and len(set(available)) == len(available) and len(enabled) <= 32
                    and len(set(enabled)) == len(enabled) and all(re.fullmatch(r'[a-z_]+', word) for word in available + enabled),
                    'Native controller metadata differs')
            require(set(enabled) <= set(available), 'Enabled native controller is unavailable')
            row = {'tier': tier}
            for controller, filename in (('memory', 'memory.max'), ('cpu', 'cpu.max')):
                file = directory / filename
                try:
                    metadata = file.lstat()
                except FileNotFoundError:
                    present = False
                else:
                    secure(file, 0);require(stat.S_ISREG(metadata.st_mode), 'Native resource cap type differs');present = True
                row[controller] = {'capPresent': present, 'available': controller in available, 'subtreeEnabled': controller in enabled}
            rows.append(row)
        return rows
    custody()
    before_unit = properties(UNIT);N.require_owned_invocation(before_unit, invocation, require)
    identity = resource_process(before_unit);slice_occupants(N)
    before = capture()
    runtime = object.__new__(N.NextRuntime)
    runtime.require, runtime.secure_path, runtime.inventory = require, secure, I
    runtime.value = {'units': {UNIT: {}}, 'resourceEnvelope': {'cgroupPath': AGGREGATE_GROUP,
        'memoryHighBytes': 7168 * 1024**2, 'memoryMaxBytes': 8192 * 1024**2, 'tasksMax': 1024,
        'cpuOversubscriptionDiagnostic': False}}
    # Never copy or patch resource_state. Its guard still rejects a missing
    # nonroot cap. This report records that refusal without accepting a worker.
    verdict, reason = False, 'resource-check-refused'
    try:
        limit()
        evidence = runtime.resource_state(UNIT, before_unit)
    except AssertionError as error:
        reason = resource_guard_reason(error)
    else:
        limit()
        require(evidence.get('aggregateCapsVerified') is True, 'Actual resource result differs')
        verdict, reason = True, 'resource-check-accepted'
    after = capture();after_unit = properties(UNIT);N.require_owned_invocation(after_unit, invocation, require)
    require(resource_process(after_unit) == identity and after == before, 'Native resource topology changed during observation')
    custody()
    kernel = os.uname().release
    require(re.fullmatch(r'[A-Za-z0-9.+_-]{1,128}', kernel) is not None, 'Kernel version syntax differs')
    return {'kind': 'ACTUAL_UNCHANGED_RESOURCE_METHOD_DIAGNOSTIC_NOT_READINESS', 'before': before, 'after': after,
            'resourceReady': verdict, 'guardReason': reason, 'actualProcessUnchanged': True,
            'leafCPUWeightBefore': weights[0], 'leafCPUWeightAfter': weights[1],
            'kernelVersion': kernel, 'profileConstructorVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}


def initial_environment_observation(N, started, files, source_hashes):
    """Same existing native service and invocation; no extra process or unit."""
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'Host environment observation timer occupied')
    old_handler = signal.getsignal(signal.SIGALRM)
    def expired(_signal, _frame):
        raise TimeoutError('Host environment observation deadline')
    def custody():
        file = pathlib.Path('/etc/systemd/system', UNIT)
        secure(file, 0)
        info = file.lstat()
        require((info.st_dev, info.st_ino) == files[UNIT], 'Host environment declaration replaced')
        require(hashlib.sha256(file.read_bytes()).hexdigest() == declaration_sha, 'Host environment declaration changed')
        for name, wanted in source_hashes.items():
            file = ROOT / name;secure(file, 0)
            require(file.stat().st_size <= 256 * 1024
                    and hashlib.sha256(file.read_bytes()).hexdigest() == wanted, 'Host environment source changed')
    declaration_sha = hashlib.sha256(pathlib.Path('/etc/systemd/system', UNIT).read_bytes()).hexdigest()
    stages, captured, plain = [], None, None
    def capture(keys, count):
        nonlocal captured, plain
        require(captured is None, 'Repeated host key-name capture refused')
        try:
            captured = N.key_name_digests(keys, count)
        except (ValueError, TypeError, UnicodeError, OverflowError):
            captured = N.unavailable_key_name_digests(count)
        try:
            plain = N.plain_key_names(keys, count, captured)
        except (ValueError, TypeError, UnicodeError, OverflowError):
            plain = {'namesComplete': False, 'names': []}
    try:
        deadline = min(DEADLINE, time.monotonic() + 1)
        require(deadline > time.monotonic(), 'Host environment observation budget unavailable')
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, max(.001, deadline - time.monotonic()))
        result = N.observe_owned_environment({'pid': int(started['MainPID']), 'invocation': started['InvocationID'],
            'uid': 65534, 'executable': str(pathlib.Path('/usr/bin/python3').resolve(strict=True)),
            'cwd': str(RELEASE), 'cgroup': AGGREGATE_GROUP + '/' + UNIT,
            'argv': ['/usr/bin/python3', '-I', '-B', str(ROOT / 'probe.py'), 'app'],
            'title': None, 'subject': 'host-component'}, custody, deadline, _phase=stages.append, _key_names=capture)
        require(result['knownUnqualified']['locale-language'] and result['knownUnqualified']['locale-numeric']
                and result['knownUnqualified']['process-pwd'] and result['otherUnqualifiedCount'] >= 1,
                'Actual synthetic initial environment observations absent')
        require(stages == ['declaration-before', 'process-before', 'environment-read',
                'environment-classified', 'process-after', 'custody-after'], 'Actual native hook sequence differs')
        keys = N.validate_key_name_digests(captured, result['otherUnqualifiedCount'])
        require(keys['state'] == 'complete' and hashlib.sha256(N.KEY_NAME_DIGEST_DOMAIN + b'AIHR_OBSERVATION_CANARY').hexdigest()
                in keys['digests'], 'Actual source-owned canary key-name digest unavailable')
        plain = N.validate_plain_key_names(plain, keys)
        return result, {'kind': 'ACTUAL_SHARED_OBSERVER_HOOKS_NOT_FULL_HELPER_OR_NEXT', 'stages': stages,
            'fullHelperVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}, {
            'kind': 'ACTUAL_SHARED_KEY_NAME_DIGEST_COMPONENT_NOT_FULL_HELPER_OR_NEXT', 'subject': 'host-component',
            'keyNames': keys, 'fullHelperVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}, {
            'kind': 'ACTUAL_SHARED_PLAIN_OTHER_KEY_NAMES_COMPONENT_NOT_FULL_HELPER_OR_NEXT', 'subject': 'host-component',
            'keyNames': keys, **plain, 'fullHelperVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)


def rows(N):
    return {UNIT: [{'source': str(ROOT / 'mutable' / str(index)), 'target': target}
                   for index, target in enumerate(N.CACHE_TARGETS)]}


def secure(file, uid, directory=False):
    current = pathlib.Path('/')
    for part in pathlib.Path(file).parts[1:]:
        current /= part
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == uid
                and not stat.S_IMODE(info.st_mode) & 0o022, 'Unprotected native conformance path')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Native conformance path type differs')


PUBLIC_SGX_GENERATOR = pathlib.Path('/usr/lib/systemd/system-environment-generators/linux-base-sgx')
PUBLIC_SGX_GENERATOR_SHA = 'cb746a20301f3845341c980a4f5432f963a19645d2bbb390d1712bd1474751ab'
SGX_GENERATOR_OVERRIDES = tuple(pathlib.Path(prefix, 'linux-base-sgx') for prefix in (
    '/run/systemd/system-environment-generators', '/etc/systemd/system-environment-generators',
    '/usr/local/lib/systemd/system-environment-generators'))


def sgx_default_overrides_absent():
    # Fixed lookup basenames only. Refuse parent symlinks rather than following
    # them into an unreviewed path, even for this diagnostic-only observation.
    for fixed in SGX_GENERATOR_OVERRIDES:
        current = pathlib.Path('/')
        for index, part in enumerate(fixed.parts[1:]):
            limit()
            current /= part
            try:
                info = current.lstat()
            except FileNotFoundError:
                break
            if index == len(fixed.parts) - 2:
                return False
            require(not stat.S_ISLNK(info.st_mode) and stat.S_ISDIR(info.st_mode)
                    and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022,
                    'Public generator lookup unavailable')
    return True


def installed_public_sgx_source():
    """Installed PUBLIC source only; never exclusive causal/default-path proof."""
    result = {'kind': 'INSTALLED_KNOWN_PUBLIC_UBUNTU_SGX_SOURCE_NOT_EXECUTION_HISTORY',
        'state': 'unavailable', 'knownPublicSourceSha256': None, 'defaultOverridesAbsent': False,
        'customGeneratorPathObserved': False, 'exclusiveOriginVerified': False,
        'nextApplicationVerified': False, 'releaseEligible': False}
    fd = None
    try:
        limit()
        if not sgx_default_overrides_absent():
            return result
        result['defaultOverridesAbsent'] = True
        secure(PUBLIC_SGX_GENERATOR, 0)
        before = PUBLIC_SGX_GENERATOR.lstat()
        require(before.st_nlink == 1 and before.st_mode & 0o111 and 0 < before.st_size <= 4096,
                'Public generator metadata unavailable')
        identity = lambda info: (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        fd = os.open(PUBLIC_SGX_GENERATOR, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        require(identity(os.fstat(fd)) == identity(before), 'Public generator changed')
        raw = bytearray()
        while True:
            limit()
            part = os.read(fd, min(4096, 4097 - len(raw)))
            if not part:
                break
            raw.extend(part)
            require(len(raw) <= 4096, 'Public generator metadata unavailable')
        require(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(PUBLIC_SGX_GENERATOR.lstat()) == identity(before)
                and sgx_default_overrides_absent(), 'Public generator changed')
        if hashlib.sha256(raw).hexdigest() == PUBLIC_SGX_GENERATOR_SHA:
            result.update(state='matched-public-source', knownPublicSourceSha256=PUBLIC_SGX_GENERATOR_SHA)
    except BaseException:
        result.update(state='unavailable', knownPublicSourceSha256=None)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except BaseException:
                result.update(state='unavailable', knownPublicSourceSha256=None)
    return result


def host_manager_snapshot(N, preparation, ledger, ordinal):
    require(type(ledger) is list and type(ordinal) is int and ordinal in (0, 1) and len(ledger) == ordinal,
            'Host manager preparation order refused')
    entry = {'ordinal': ordinal, 'outcome': 'entered', 'returned': False, 'settled': False,
             'keyCount': None, 'unsetCount': None}
    ledger.append(entry)
    try:
        # Each actual native read shares the SAME constructor/pipe/decoder as
        # Next preparation. Host owns this stricter half-second sub-budget.
        names = preparation.manager_environment_snapshot(N, time.monotonic() + limit(.5))
        projected = N.manager_unset_environment(names)
    except BaseException:
        entry['outcome'] = 'refused'
        raise
    entry.update(outcome='complete', returned=True, settled=True, keyCount=len(names), unsetCount=len(projected))
    return projected


def hook():
    require(os.geteuid() == 0 and pathlib.Path(__file__) == ROOT / 'probe.py', 'Fixed protected hook required')
    secure(ROOT / 'probe.py', 0)
    N, I = load('host_view_owner', ROOT / 'next_profile.py'), load('host_view_inventory', ROOT / 'runtime_inventory.py')
    with I.PinnedTree(RELEASE, require) as tree:
        proof = N.immutable_cache_view(str(RELEASE), tree, rows(N), 65534, require, secure)
        require(proof['overlaid'] is True and proof['unit'] == UNIT, 'Actual privileged overlay proof absent')
        observed = {target: {'uid': tree.metadata(target).st_uid, 'mode': stat.S_IMODE(tree.metadata(target).st_mode)}
                    for target in N.CACHE_TARGETS}
        require(all(row == {'uid': 65534, 'mode': 0o700} for row in observed.values()), 'Actual overlay ownership differs')
        # Change only expected declarations; no synthetic native mount facts.
        refused = []
        for kind in ('foreign-source', 'link-source'):
            bad = rows(N)
            replacement = ROOT / ('source-link' if kind == 'link-source' else 'other-source')
            bad[UNIT][0]['source'] = str(replacement)
            try:
                N.immutable_cache_view(str(RELEASE), tree, bad, 65534, require, secure)
            except (AssertionError, OSError):
                refused.append(kind)
            else:
                raise AssertionError('Foreign native source was accepted')
        source, backup = ROOT / 'mutable/0', ROOT / 'mutable/held-source'
        before = source.lstat();source.rename(backup)
        source.mkdir(mode=0o700);os.chown(source, 65534, 65534);replacement = source.lstat()
        try:
            try:
                N.immutable_cache_view(str(RELEASE), tree, rows(N), 65534, require, secure)
            except AssertionError:
                refused.append('same-path-inode-replaced')
            else:
                raise AssertionError('Replacement native source inode was accepted')
        finally:
            require((source.lstat().st_dev, source.lstat().st_ino) == (replacement.st_dev, replacement.st_ino)
                    and (backup.lstat().st_dev, backup.lstat().st_ino) == (before.st_dev, before.st_ino),
                    'Native source restoration ownership uncertain')
            source.rmdir();backup.rename(source)
        (ROOT / 'hook-proof.json').write_text(json.dumps({'overlaid': True, 'rootUid': os.geteuid(),
            'overlayOwnership': list(observed.values()), 'sourceRefusals': refused,
            'hostPlaceholders': len(proof['placeholders']), 'nativeNamespaceVerified': True}))


def app():
    require(os.geteuid() == 65534, 'Actual app identity differs')
    for target in ('.next/cache/images', '.next/cache/fetch-cache', '.next/server/route-cache'):
        file = RELEASE / target / 'owned-native-cache'
        file.write_text('fictional component cache\n')
    # Both parent and child ignore TERM: only the declared systemd cgroup stop
    # timeout may end this family; no numeric PID/group kill is used.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = os.fork()
    if child == 0:
        while True:
            signal.pause()
    while True:
        signal.pause()


def root_custody(owned_root, N):
    """Validate ownership and actual host mounts before ANY path disposal."""
    require(owned_root is not None and N is not None, 'Owned root custody unavailable; retain paths')
    before = ROOT.lstat()
    require(stat.S_ISDIR(before.st_mode) and before.st_uid == 0
            and stat.S_IMODE(before.st_mode) == 0o755
            and (before.st_dev, before.st_ino) == owned_root, 'Conformance root replaced; retain paths')
    proc = os.open('/proc/self', os.O_RDONLY | os.O_DIRECTORY)
    try:
        mounts = N.parse_mountinfo(N.read_proc(proc, 'mountinfo', 4 * 1024 * 1024, require), require)
    finally:
        os.close(proc)
    require(not any(row['target'] == str(ROOT) or row['target'].startswith(str(ROOT) + '/') for row in mounts),
            'Foreign host mount; retain conformance paths')
    limit()
    return before


def remove_owned_root(owned_root, N):
    """No pathname-only adoption, foreign mount, symlink parent or unbounded walk."""
    before = root_custody(owned_root, N)
    root = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    count = 0
    def walk(fd, depth):
        nonlocal count
        limit();require(depth <= 32, 'Conformance cleanup depth exceeds bound')
        with os.scandir(fd) as entries:
            for entry in entries:
                limit();count += 1
                require(count <= 2048, 'Conformance cleanup members exceed bound')
                info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                require(info.st_dev == before.st_dev, 'Conformance cleanup device changed')
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        held = os.fstat(child)
                        require((held.st_dev, held.st_ino) == (info.st_dev, info.st_ino), 'Conformance child changed')
                        walk(child, depth + 1)
                        after = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                        require((after.st_dev, after.st_ino) == (held.st_dev, held.st_ino), 'Conformance child replaced')
                    finally:
                        os.close(child)
                    limit();os.rmdir(entry.name, dir_fd=fd)
                else:
                    limit();os.unlink(entry.name, dir_fd=fd)
    try:
        held = os.fstat(root)
        require((held.st_dev, held.st_ino) == owned_root, 'Conformance root changed while opening')
        walk(root, 0)
    finally:
        os.close(root)
    limit();after = ROOT.lstat()
    require((after.st_dev, after.st_ino) == owned_root, 'Conformance root replaced before disposal')
    ROOT.rmdir()


def cleanup(files, invocations, N, owned_root):
    """Seven seconds TOTAL, including fair custody, all stops and real disposal."""
    global DEADLINE
    started = time.monotonic()
    DEADLINE = min(TOTAL_DEADLINE, started + 7)
    admission_end, queue_end, settlement_end = started + .75, started + 1.25, started + 4.5
    errors, safe = [], []
    def phase_cap(frontier, cap, slots=1):
        remaining = min(DEADLINE, frontier) - time.monotonic()
        require(remaining > 0, 'Conformance cleanup phase exceeded')
        return min(cap, remaining / max(1, slots))
    for index, (name, identity) in enumerate(files.items()):
        try:
            file = pathlib.Path('/etc/systemd/system', name);info = file.lstat()
            require(stat.S_ISREG(info.st_mode) and (info.st_dev, info.st_ino) == identity and info.st_uid == 0,
                    'Conformance unit replaced')
            actual = properties(name, cap=phase_cap(admission_end, .25, len(files)-index))
            if actual.get('InvocationID'):
                require(N is not None, 'Native invocation owner unavailable')
                N.require_owned_invocation(actual, invocations.get(name), require)
            else:
                require((actual.get('MainPID', '0') if name == AGGREGATE else actual.get('MainPID')) ==
                        (actual.get('ControlPID', '0') if name == AGGREGATE else actual.get('ControlPID')) == '0'
                        and actual.get('ActiveState') in ('inactive', 'failed'), 'Unknown native conformance family')
            if name == AGGREGATE:
                slice_occupants(N)
            safe.append(name)
        except BaseException as error:
            errors.append(error)
    # Queue every independently proven stop BEFORE awaiting any native family.
    services = [name for name in safe if name != AGGREGATE]
    for index, name in enumerate(services):
        try:
            command('/usr/bin/systemctl', '--system', 'stop', '--no-block', name,
                    cap=phase_cap(queue_end, .25, len(services)-index))
        except BaseException as error:
            errors.append(error)
    pending = set(services)
    while pending and time.monotonic() < min(DEADLINE, settlement_end):
        for name in list(pending):
            try:
                if family_stopped(name, cap=phase_cap(settlement_end, .1, len(pending))):
                    pending.remove(name)
            except BaseException as error:
                errors.append(error);pending.remove(name)
        if pending:
            time.sleep(max(0, min(.02, min(DEADLINE, settlement_end)-time.monotonic())))
    if pending:
        errors.append(AssertionError('Conformance families did not settle before disposal frontier'))
    if errors:
        raise BaseExceptionGroup('Native conformance stop/custody refused; retain paths', errors)
    if AGGREGATE in safe:
        slice_occupants(N)
        actual = properties(AGGREGATE, cap=phase_cap(settlement_end, .2))
        if actual.get('InvocationID'):
            N.require_owned_invocation(actual, invocations.get(AGGREGATE), require)
        # Every service is already natively stopped. No slice stop may signal
        # a remaining process, including one in the accepted worker's child.
        directory = pathlib.Path('/sys/fs/cgroup' + AGGREGATE_GROUP)
        if os.path.lexists(directory):
            require(N.key_values(N.kernel_text(directory / 'cgroup.events', secure, require), require).get('populated') == 0,
                    'Live slice descendant retained')
        command('/usr/bin/systemctl', '--system', 'stop', '--no-block', AGGREGATE, cap=phase_cap(settlement_end, .2))
        while not family_stopped(AGGREGATE, cap=phase_cap(settlement_end, .1)):
            time.sleep(.01)
    for name in UNITS:
        if name not in files:
            require(declaration_absent(name),
                    'Untracked native declaration; retain all paths')
    if owned_root is not None:
        root_custody(owned_root, N)
    else:
        require(not os.path.lexists(ROOT), 'Unknown root construction; retain paths')
    for name in safe:
        file = pathlib.Path('/etc/systemd/system', name);info = file.lstat()
        require((info.st_dev, info.st_ino) == files[name] and info.st_uid == 0, 'Conformance disposal identity changed')
        command('/usr/bin/systemctl', '--system', 'reset-failed', name, check=False, cap=.2)
        limit();file.unlink()
    if files:
        command('/usr/bin/systemctl', '--system', 'daemon-reload', cap=.4)
    require(all(declaration_absent(name) for name in UNITS),
            'Native conformance service or declaration remains after disposal')
    if owned_root is not None:
        remove_owned_root(owned_root, N)


def main():
    global DEADLINE
    os.umask(0o022)  # Dedicated synthetic public fixture; evidence stays explicit0600.
    require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.platform == 'linux', 'Actual root Linux conformance required')
    require(os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr', 'Actual hosted component required')
    evidence = pathlib.Path(sys.argv[1]);parent = evidence.parent.lstat()
    require(parent.st_uid > 0 and stat.S_ISDIR(parent.st_mode) and stat.S_IMODE(parent.st_mode) == 0o700
            and evidence.name == 'runtime-next-host-view-native.json' and evidence.parent.resolve() == evidence.parent and not evidence.exists()
            and not evidence.is_symlink(), 'Private admitted evidence path required')
    require(not os.path.lexists(ROOT), 'Foreign conformance directory retained')
    for unit in UNITS:
        require(declaration_absent(unit), 'Foreign native unit retained')
    version = command('/usr/bin/systemctl', '--version').stdout.splitlines()[0]
    require(version.startswith(b'systemd 255 ') and len(version) <= 256 and all(32 <= byte <= 126 for byte in version),
            'Native conformance requires actual systemd255')
    primary = None
    owned_root, N = None, None
    files, invocations, report = {}, {}, {'version': 1, 'kind': 'ACTUAL_SYSTEMD_HOST_CACHE_CONFORMANCE_NOT_NEXT',
        'complete': False, 'nextApplicationVerified': False, 'releaseEligible': False,
        'resourceReadinessQualified': False, 'systemdVersion': version.decode()}
    try:
        ROOT.mkdir(mode=0o755)
        info = ROOT.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o755,
                'Native conformance root construction differs')
        owned_root = (info.st_dev, info.st_ino)
        for name, source in [('probe.py', pathlib.Path(__file__)), ('next_profile.py', pathlib.Path(__file__).with_name('next_profile.py')),
                             ('runtime_inventory.py', pathlib.Path(__file__).resolve().parents[2] / '.github/ci/runtime_inventory.py'),
                             ('next_preparation.py', pathlib.Path(__file__).with_name('test_next_native.py'))]:
            data = source.read_bytes();require(0 < len(data) <= 256 * 1024, 'Bounded source closure required')
            destination = ROOT / name
            with destination.open('xb') as output:
                output.write(data)
            destination.chmod(0o644)
            report.setdefault('sourceSha256', {})[name] = hashlib.sha256(data).hexdigest()
        N, I = load('owned_host_view', ROOT / 'next_profile.py'), load('owned_host_inventory', ROOT / 'runtime_inventory.py')
        secure(ROOT / 'next_preparation.py', 0)
        preparation = load('owned_host_next_preparation', ROOT / 'next_preparation.py')
        projection_ledger = []
        report['managerEnvironmentPreparation'] = {'kind': 'ACTUAL_SHARED_TYPED_MANAGER_PREPARATION_NOT_NEXT_OR_ADMISSION',
            'operations': projection_ledger, 'stable': False, 'hostReadCapMs': 500,
            'fullHelperVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}
        manager_unsets = host_manager_snapshot(N, preparation, projection_ledger, 0)
        report['installedPublicSgxSource'] = installed_public_sgx_source()
        for target in N.CACHE_TARGETS:
            (RELEASE / target).mkdir(parents=True, mode=0o755)
        (RELEASE / '.next/foreign-cache').mkdir(mode=0o755)
        for index in range(3):
            source = ROOT / 'mutable' / str(index);source.mkdir(parents=True, mode=0o700)
            source.chmod(0o700);os.chown(source, 65534, 65534)
        (ROOT / 'other-source').mkdir(mode=0o700);os.chown(ROOT / 'other-source', 65534, 65534)
        (ROOT / 'source-link').symlink_to(ROOT / 'mutable/0')
        unit = '[Service]\nType=simple\nUser=nobody\nNoNewPrivileges=yes\nProtectSystem=strict\nPrivateMounts=yes\nKillMode=control-group\nTimeoutStopSec=3s\nSendSIGKILL=yes\nRuntimeMaxSec=15s\n'
        # Fictional literal values only. No manager-environment mutation.
        environment_file = ROOT / 'observation.env'
        environment_file.write_text('LANGUAGE=C\nLC_NUMERIC=C\nPWD=fictional-observation\nAIHR_OBSERVATION_CANARY=fictional-private-canary\n')
        environment_file.chmod(0o600)
        unit += 'WorkingDirectory=' + str(RELEASE) + '\nEnvironmentFile=' + str(environment_file) + '\n'
        unit += 'Environment=AIHR_APP_WORKERS=2 AIHR_DB_TOTAL_CONNECTIONS=16 AIHR_DB_POOL_MAX=8\n'
        unit += 'ExecStartPre=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook\n'
        unit += 'ExecStart=/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' app\n'
        unit += 'ExecStartPost=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook\n'
        unit += 'Slice=' + AGGREGATE + '\nDelegate=no\nCPUWeight=100\n'
        unit += 'BindReadOnlyPaths=' + str(RELEASE) + ':' + str(RELEASE) + ':norbind\n'
        unit += ''.join('BindPaths=' + row['source'] + ':' + str(RELEASE / row['target']) + ':norbind\n' for row in rows(N)[UNIT])
        aggregate = '[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nCPUQuota=400%\nMemoryHigh=7168M\nMemoryMax=8192M\nMemorySwapMax=0\nTasksMax=1024\n'
        for name, content in [(UNIT, unit), (FOREIGN, '[Service]\nUser=nobody\nNoNewPrivileges=yes\nExecStart=/usr/bin/sleep 15\nTimeoutStopSec=1s\nKillMode=control-group\n'), (AGGREGATE, aggregate)]:
            file = pathlib.Path('/etc/systemd/system', name)
            with file.open('x') as output:
                output.write(content)
            file.chmod(0o644);info = file.lstat();files[name] = (info.st_dev, info.st_ino)
        command('/usr/bin/systemctl', '--system', 'daemon-reload')
        require(host_manager_snapshot(N, preparation, projection_ledger, 1) == manager_unsets,
                'Host manager projection changed during reload')
        report['managerEnvironmentPreparation']['stable'] = True
        def start_owned(name, check=True):
            result, failures = None, []
            try:
                result = command('/usr/bin/systemctl', '--system', 'start', name, check=check)
            except BaseException as error:
                failures.append(error)
            # Failed/timed-out StartUnit may already activate BOTH its service
            # and slice. Capture each independently before propagating failure.
            for observed in (name, AGGREGATE) if name == UNIT else (name,):
                try:
                    file = pathlib.Path('/etc/systemd/system', observed);info = file.lstat()
                    require((info.st_dev, info.st_ino) == files[observed] and info.st_uid == 0, 'Native start declaration changed')
                    actual = properties(observed)
                    require(actual.get('FragmentPath') == str(file) and actual.get('DropInPaths') == '', 'Native start source differs')
                    if actual.get('InvocationID'):
                        N.require_owned_invocation(actual, actual['InvocationID'], require)
                        invocations[observed] = actual['InvocationID']
                except BaseException as error:
                    failures.append(error)
            if len(failures) == 1:
                raise failures[0]
            if failures:
                raise BaseExceptionGroup('Native start and custody capture both refused', failures)
            return result
        actual = properties(UNIT)
        require(actual.get('FragmentPath') == '/etc/systemd/system/' + UNIT and actual.get('DropInPaths') == ''
                and actual.get('User') == 'nobody' and actual.get('NoNewPrivileges') == 'yes'
                and actual.get('KillMode') == 'control-group' and actual.get('Delegate') == 'no'
                and actual.get('TimeoutStopUSec') == '3s' and actual.get('SendSIGKILL') == 'yes'
                and actual.get('RuntimeMaxUSec') == '15s', 'Effective native conformance service differs')
        N.require_leaf_cpu_weight(actual, require)
        actual_slice = properties(AGGREGATE)
        require(actual_slice.get('FragmentPath') == '/etc/systemd/system/' + AGGREGATE
                and actual_slice.get('DropInPaths') == '' and actual_slice.get('SourcePath') == ''
                and actual_slice.get('Transient') == 'no', 'Effective aggregate source differs')
        start_owned(UNIT)
        started = properties(UNIT);invocations[UNIT] = started['InvocationID']
        report['initialEnvironmentObservation'], report['initialEnvironmentHookObservation'], report['initialEnvironmentKeyNameObservation'], report['initialEnvironmentPlainKeyNameObservation'] = initial_environment_observation(N, started, files, report['sourceSha256'])
        slice_state = properties(AGGREGATE)
        require(slice_state.get('ActiveState') == 'active' and slice_state.get('ControlGroup') == AGGREGATE_GROUP,
                'Actual resource slice did not activate')
        N.require_owned_invocation(slice_state, slice_state.get('InvocationID'), require)
        invocations[AGGREGATE] = slice_state['InvocationID']
        report['resourceTopology'] = resource_topology(N, I, started['InvocationID'], files, report['sourceSha256'])
        require(report['resourceTopology']['resourceReady'] is True
                and report['resourceTopology']['guardReason'] == 'resource-check-accepted',
                'Explicit leaf CPU constructor did not satisfy unchanged resource method')
        require(report['resourceTopology']['before'][0]['cpu']['capPresent'] is True
                and report['resourceTopology']['before'][0]['cpu']['available'] is True
                and report['resourceTopology']['before'][1]['cpu']['subtreeEnabled'] is True,
                'Actual leaf CPU controller topology differs')
        hook_report = json.loads((ROOT / 'hook-proof.json').read_text())
        require(hook_report['nativeNamespaceVerified'] is True, 'Actual hook proof missing')
        with I.PinnedTree(RELEASE, require) as tree:
            host = N.immutable_cache_view(str(RELEASE), tree, rows(N), 65534, require, secure)
            require(host['overlaid'] is False and len(host['placeholders']) == 3, 'Host cold placeholders changed')
        while not all((ROOT / 'mutable' / str(index) / 'owned-native-cache').is_file() for index in range(3)):
            limit();time.sleep(0.02)
        before = time.monotonic()
        command('/usr/bin/systemctl', '--system', 'stop', '--no-block', UNIT)
        while not family_stopped(UNIT):
            limit();time.sleep(0.02)
        stopped = properties(UNIT)
        require(stopped['ControlPID'] == '0' and time.monotonic() - before <= 4,
                'Native resistant family exceeded declared stop bound')
        group = started['ControlGroup'];require(group.startswith('/') and '..' not in group.split('/'), 'Native cgroup differs')
        directory = pathlib.Path('/sys/fs/cgroup' + group)
        require(not directory.exists() or not (directory / 'cgroup.procs').read_text().strip(), 'Native stopped family remains')
        report['privilegedHookView'] = hook_report;report['resistantFamilyStopped'] = True
        report['hostPlaceholderOwnership'] = [{'uid': identity[3], 'mode': stat.S_IMODE(identity[2])}
                                              for identity in host['placeholders'].values()]
        report['stopElapsedMs'] = (time.monotonic() - before) * 1000
        # A real fourth mount, not a synthetic mountinfo payload, must fail the
        # same production helper before any application command can start.
        file = pathlib.Path('/etc/systemd/system', UNIT)
        file.write_text(unit + 'BindPaths=' + str(ROOT / 'other-source') + ':' + str(RELEASE / '.next/foreign-cache') + ':norbind\n')
        command('/usr/bin/systemctl', '--system', 'daemon-reload')
        extra = start_owned(UNIT, check=False)
        invocations[UNIT] = properties(UNIT)['InvocationID']
        require(extra.returncode != 0 and json.loads((ROOT / 'hook-refusal.json').read_text()) == {'reason': 'unknown-overlay'},
                'Actual foreign package mount was not refused')
        report['actualExtraMountRefused'] = True

        start_owned(FOREIGN)
        foreign = properties(FOREIGN);invocations[FOREIGN] = foreign['InvocationID']
        try:
            N.require_owned_invocation(foreign, '0' * 32, require)
        except AssertionError:
            require(properties(FOREIGN)['InvocationID'] == foreign['InvocationID']
                    and properties(FOREIGN)['MainPID'] == foreign['MainPID'] != '0', 'Foreign unit was not retained')
        else:
            raise AssertionError('Foreign native invocation authorized stop')
        report['foreignInvocationRetained'] = True
        # An unmounted app-owned physical placeholder is never an overlay.
        point = RELEASE / N.CACHE_TARGETS[0];os.chown(point, 65534, 65534)
        try:
            with I.PinnedTree(RELEASE, require) as tree:
                try:
                    N.immutable_cache_view(str(RELEASE), tree, rows(N), 65534, require, secure)
                except AssertionError:
                    report['unmountedAppOwnedPlaceholderRefused'] = True
                else:
                    raise AssertionError('Unmounted writable placeholder accepted')
        finally:
            os.chown(point, 0, 0)
        report['complete'] = True
    except BaseException as error:
        primary = error
        report['complete'] = False
        report['primaryFailure'] = 'native-assertion' if isinstance(error, AssertionError) else 'bounded-operation-refused'
    finally:
        errors = []
        try:
            cleanup(files, invocations, N, owned_root)
        except BaseException as error:
            errors.append(error)
        report['ownedRuntimeCleaned'] = not errors
        report['complete'] = report['complete'] and not errors
        try:
            with evidence.open('x') as output:
                os.fchmod(output.fileno(), 0o600);os.fchown(output.fileno(), parent.st_uid, parent.st_gid)
                output.write(json.dumps(report))
        except BaseException as error:
            errors.append(error)
        failures = ([primary] if primary is not None else []) + errors
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup('Conformance operation and ownership cleanup refused', failures)



if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'hook':
            try:
                hook()
            except AssertionError as error:
                if str(error) == 'Unknown or partial managed package overlay':
                    (ROOT / 'hook-refusal.json').write_text(json.dumps({'reason': 'unknown-overlay'}))
                raise
        elif len(sys.argv) == 2 and sys.argv[1] == 'app':
            app()
        else:
            main()
    except BaseException:
        os.write(2, b'Fixed host conformance refused\n')
        sys.exit(1)
