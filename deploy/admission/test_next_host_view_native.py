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
import types

ROOT = pathlib.Path('/var/lib/aihr-next-host-conformance')
UNIT = 'aihr-next-host-conformance.service'
FOREIGN = 'aihr-next-foreign-conformance.service'
AGGREGATE = 'aihrnexthostresource.slice'
AGGREGATE_GROUP = '/' + AGGREGATE
UNITS = (UNIT, FOREIGN, AGGREGATE)
RELEASE = ROOT / 'release'
STARTED = time.monotonic()
TOTAL_DEADLINE = STARTED + 27
DEADLINE = TOTAL_DEADLINE - 7  #20s conformance work +7s owned cleanup;3s transport reserve.
PHASE_DEADLINE = STARTED + 7
WORK_PHASE_ACTIVE = False
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
    frontier = min(DEADLINE, PHASE_DEADLINE) if WORK_PHASE_ACTIVE else DEADLINE
    left = frontier - time.monotonic()
    require(left > 0, 'Host conformance aggregate deadline exceeded')
    return min(cap, left)


def _advance_work_phase(offset):
    global PHASE_DEADLINE
    require(WORK_PHASE_ACTIVE and offset in (11, 13, 17, 20)
            and STARTED + offset > PHASE_DEADLINE, 'Closed work phase transition')
    limit()  # The previous absolute frontier must still be live.
    PHASE_DEADLINE = STARTED + offset


def _new_invocation_ready(candidate, previous):
    """Pure identity decision only; no source/process/native admission proof."""
    require(previous is None or type(previous) is str and re.fullmatch(r'[a-f0-9]{32}', previous),
            'Previous invocation identity invalid')
    if candidate == '':
        return False
    require(type(candidate) is str and re.fullmatch(r'[a-f0-9]{32}', candidate), 'Candidate invocation identity invalid')
    return candidate != previous


def _admit_initial_observer_slot():
    # The unchanged observer owns a full1s slice. A50ms admission reserve is
    # stricter than the existing first7s frontier, never a refreshed allowance.
    require(WORK_PHASE_ACTIVE and PHASE_DEADLINE == STARTED + 7, 'Initial observer outside first phase')
    require(limit() > 1.05, 'Full initial observer slot unavailable')


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


def resource_topology(N, I, invocation, files, source_hashes, preparation=None, post_family=None):
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
    handoff = fresh_child_handoff(preparation, invocation, post_family) if preparation is not None and post_family is not None else None
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
    result = {'kind': 'ACTUAL_UNCHANGED_RESOURCE_METHOD_DIAGNOSTIC_NOT_READINESS', 'before': before, 'after': after,
            'resourceReady': verdict, 'guardReason': reason, 'actualProcessUnchanged': True,
            'leafCPUWeightBefore': weights[0], 'leafCPUWeightAfter': weights[1],
            'kernelVersion': kernel, 'profileConstructorVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False}
    if handoff is not None:
        result['admissionHandoff'] = handoff
    return result


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



class _HandoffRefusal(AssertionError):
    """One closed source category; never private native data or exception text."""
    def __init__(self, code):
        require(type(code) is int and 1 <= code <= 18, 'Closed handoff refusal code required')
        self.code = code
        super().__init__('Closed handoff observation refused')


def _handoff_require(value, code):
    if not value:
        raise _HandoffRefusal(code)


def unavailable_admission_handoff(refusal_code=18):
    require(type(refusal_code) is int and 1 <= refusal_code <= 18, 'Closed handoff refusal code required')
    return {'kind': 'ACTUAL_SAME_PID_EXEC_JOURNAL_AVAILABILITY_NOT_ADMISSION', 'state': 'unavailable',
        'beforePairVerified': False, 'afterPairVerified': False, 'samePidObserved': False,
        'exactDistinctArgvObserved': False, 'actualSharedEmitterTransportVerified': False,
        'fullControllerAdmissionVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False,
        'refusalCode': refusal_code}


def parse_host_admission_handoff(raw, invocation, python_exe, preparation):
    """HOST-only native origin predicates; never a full Next authority route."""
    _handoff_require(type(raw) is bytes and len(raw) <= 131072 and type(invocation) is str
            and re.fullmatch(r'[a-f0-9]{32}', invocation)
            and type(python_exe) is str and python_exe.startswith('/usr/bin/'), 4)
    lines, messages, pids = raw.splitlines(), {'before': [], 'after': []}, {'before': [], 'after': []}
    _handoff_require(0 < len(lines) < 64, 5)
    commands = {prefix + ' -I -B ' + str(ROOT / 'probe.py') + ' ' + mode: group
                for prefix in ('/usr/bin/python3', python_exe)
                for mode, group in (('hook-pre', 'before'), ('hook-pre-handoff', 'after'))}
    for line in lines:
        try:
            row = json.loads(line, object_pairs_hook=preparation.admission_unique_fields)
        except ValueError:
            raise _HandoffRefusal(6) from None
        message = row.get('MESSAGE') if type(row) is dict else None
        if type(message) is not str or not message.startswith(preparation.ADMISSION_PHASE_PREFIX):
            continue
        _handoff_require(row.get('_UID') == '0' and row.get('_EXE') == python_exe
                and row.get('_SYSTEMD_UNIT') == UNIT and row.get('_SYSTEMD_INVOCATION_ID') == invocation
                and row.get('_TRANSPORT') == 'stdout' and '_LINE_BREAK' not in row, 7)
        _handoff_require(type(row.get('_CMDLINE')) is str and row['_CMDLINE'] in commands, 8)
        _handoff_require(type(row.get('_PID')) is str and re.fullmatch(r'[1-9][0-9]{0,9}', row['_PID'])
                and int(row['_PID']) <= 2147483647, 9)
        group = commands[row['_CMDLINE']]
        messages[group].append(message)
        pids[group].append(row['_PID'])
    parsed = {}
    for group in ('before', 'after'):
        # Keep the existing interleaved order, not the numerical code order.
        _handoff_require(len(messages[group]) == len(pids[group]) == 2 and len(set(pids[group])) == 1,
                10 if group == 'before' else 11)
        try:
            parsed[group] = preparation.parse_admission_phase_messages(messages[group], len(lines))
        except ValueError:
            raise _HandoffRefusal(12 if group == 'before' else 13) from None
        rows = parsed[group]['events']
        _handoff_require([row['p'] for row in rows] == [0, 0] and [row['e'] for row in rows] == ['enter', 'return']
                and not parsed[group]['activeStageCodes'] and parsed[group]['traceComplete'] is False,
                14 if group == 'before' else 15)
    _handoff_require(pids['before'][0] == pids['after'][0], 16)
    _handoff_require(parsed['before']['events'][-1]['t'] <= parsed['after']['events'][0]['t'], 17)
    result = unavailable_admission_handoff()
    result.update(state='observed', beforePairVerified=True, afterPairVerified=True, samePidObserved=True,
        exactDistinctArgvObserved=True, actualSharedEmitterTransportVerified=True, refusalCode=0)
    return result


def host_admission_handoff(preparation, invocation):
    """Called inside existing resource custody + live invocation before/after."""
    try:
        try:
            python_exe = str(pathlib.Path('/usr/bin/python3').resolve(strict=True))
            secure(pathlib.Path(python_exe), 0)
            deadline = min(DEADLINE, time.monotonic() + limit(.5))
        except BaseException:
            raise _HandoffRefusal(1) from None
        try:
            code, raw = preparation.runtime_diagnostic_read(['/usr/bin/journalctl', '--system', '--no-pager', '--quiet',
                '--output=json', '--output-fields=_UID,_EXE,_CMDLINE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_TRANSPORT,_LINE_BREAK,MESSAGE',
                '--lines=64', '_SYSTEMD_UNIT=' + UNIT, '_SYSTEMD_INVOCATION_ID=' + invocation], deadline)
        except BaseException:
            raise _HandoffRefusal(2) from None
        _handoff_require(code == 0, 3)
        return parse_host_admission_handoff(raw, invocation, python_exe, preparation)
    except _HandoffRefusal as error:
        return unavailable_admission_handoff(error.code)
    except BaseException:
        return unavailable_admission_handoff()


def handoff_observer():
    require(os.geteuid() == 0 and pathlib.Path(__file__) == ROOT / 'probe.py', 'Fixed protected handoff required')
    secure(ROOT / 'probe.py', 0)
    secure(ROOT / 'controller.py', 0)
    controller = load('host_shared_admission_emitter', ROOT / 'controller.py')
    return controller.AdmissionPhaseObserver.from_stderr()


def prestart_handoff():
    observer = handoff_observer()
    try:
        with observer.stage(0):
            secure(ROOT / 'probe.py', 0)
            secure(ROOT / 'controller.py', 0)
    finally:
        observer.close()
    # SAME PID, fixed test-only argv, original stderr, no delay/fork/retry.
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B', str(ROOT / 'probe.py'), 'hook-pre-handoff'], ENV)

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


# Closed HOST-only coordination records. They never select a program/source.
HOST_SOURCES = ('probe.py', 'next_profile.py', 'runtime_inventory.py', 'next_preparation.py',
                'controller.py', 'next_fixture_poststart.py')


def _host_unique_fields(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate host record field')
        result[key] = value
    return result


def _read_host_record(name, invocation):
    require(name in ('post-child-ready.json', 'post-child-permit.json')
            and type(invocation) is str and re.fullmatch(r'[a-f0-9]{32}', invocation), 'Closed host record scope')
    value = json.loads(_held_host_file(ROOT / name, 512, 0o600), object_pairs_hook=_host_unique_fields)
    keys = {'version', 'invocation'} | ({'allowComplete'} if name == 'post-child-permit.json' else set())
    require(type(value) is dict and set(value) == keys and type(value['version']) is int
            and value['version'] == 1 and value['invocation'] == invocation
            and (name != 'post-child-permit.json' or value['allowComplete'] is True), 'Host record differs')
    return value


def _held_host_file(file, maximum, mode=None):
    secure(file, 0)
    before = file.lstat()
    require(before.st_nlink == 1 and 0 < before.st_size <= maximum
            and (mode is None or stat.S_IMODE(before.st_mode) == mode), 'Host file custody refused')
    fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(all(getattr(before, k) == getattr(os.fstat(fd), k) for k in fields), 'Host file replaced')
        parts, count = [], 0
        while count <= maximum:
            block = os.read(fd, min(65536, maximum + 1 - count))
            if not block:
                break
            parts.append(block);count += len(block)
        require(count == before.st_size and count <= maximum
                and all(getattr(before, k) == getattr(os.fstat(fd), k) == getattr(file.lstat(), k) for k in fields),
                'Host file changed')
        return b''.join(parts)
    finally:
        os.close(fd)


def _bound_host_module(name, label):
    require(name in HOST_SOURCES, 'Closed host source required')
    raw_binding = _held_host_file(ROOT / 'source-bindings.json', 4096, 0o600)
    binding = json.loads(raw_binding, object_pairs_hook=_host_unique_fields)
    require(type(binding) is dict and set(binding) == set(HOST_SOURCES)
            and all(type(v) is str and re.fullmatch(r'[a-f0-9]{64}', v) for v in binding.values()), 'Host binding refused')
    raw = _held_host_file(ROOT / name, 256 * 1024, 0o644)
    require(hashlib.sha256(raw).hexdigest() == binding[name], 'Host source differs')
    value = types.ModuleType(label);value.__file__ = str(ROOT / name)
    exec(compile(raw, value.__file__, 'exec', dont_inherit=True), value.__dict__)
    require(_held_host_file(ROOT / name, 256 * 1024, 0o644) == raw
            and _held_host_file(ROOT / 'source-bindings.json', 4096, 0o600) == raw_binding, 'Host source changed during import')
    return value


def _host_record(name, value):
    require(name in ('post-child-ready.json', 'post-child-permit.json'), 'Closed host record required')
    secure(ROOT, 0, directory=True)
    file = ROOT / name
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        raw = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        require(len(raw) <= 512 and os.write(fd, raw) == len(raw), 'Host record incomplete')
        info = os.fstat(fd)
        require(info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'Host record custody differs')
        return (info.st_dev, info.st_ino)
    finally:
        os.close(fd)


def _fresh_observer():
    require(os.geteuid() == 0 and pathlib.Path(__file__) == ROOT / 'probe.py', 'Protected host emitter required')
    return _bound_host_module('controller.py', 'fresh_host_controller').AdmissionPhaseObserver.from_stderr()


def poststart_fresh_child():
    observer = _fresh_observer()
    try:
        with observer.stage(0):
            secure(ROOT / 'probe.py', 0)
    finally:
        observer.close()
    owner = _bound_host_module('next_fixture_poststart.py', 'fresh_host_child_owner')
    owner._fixed_child()  # The SAME actual P owner, not a copied launcher.


def poststart_probe_child():
    observer = _fresh_observer()
    try:
        with observer.stage(0):
            hook()
    finally:
        observer.close()
    invocation = os.environ.get('INVOCATION_ID', '')
    require(re.fullmatch(r'[a-f0-9]{32}', invocation) is not None, 'Native child invocation required')
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    _host_record('post-child-ready.json', {'version': 1, 'invocation': invocation})
    permit = ROOT / 'post-child-permit.json'
    while not os.path.lexists(permit):
        time.sleep(.02)  # Existing native unit/outer deadlines remain owners.
    _read_host_record('post-child-permit.json', invocation)


def unavailable_fresh_child(code=18):
    require(type(code) is int and 1 <= code <= 18, 'Closed fresh child refusal required')
    return {'kind': 'ACTUAL_FRESH_CHILD_JOURNAL_AVAILABILITY_NOT_ADMISSION', 'state': 'unavailable',
        'parentPairVerified': False, 'childPairVerified': False, 'distinctPidsObserved': False,
        'exactDistinctArgvObserved': False, 'actualSharedEmitterTransportVerified': False,
        'fullControllerAdmissionVerified': False, 'nextApplicationVerified': False, 'releaseEligible': False,
        'refusalCode': code}


def parse_fresh_child_handoff(raw, invocation, python_exe, preparation, parent_pid, child_pid):
    _handoff_require(type(raw) is bytes and len(raw) <= 131072 and raw.endswith(b'\n')
            and type(invocation) is str and re.fullmatch(r'[a-f0-9]{32}', invocation)
            and type(python_exe) is str and python_exe.startswith('/usr/bin/'), 4)
    lines = raw.splitlines();_handoff_require(0 < len(lines) < 64, 5)
    expected = {'parent': parent_pid, 'child': child_pid}
    _handoff_require(all(type(pid) is int and 1 < pid <= 2147483647 for pid in expected.values())
            and parent_pid != child_pid, 16)
    commands = {prefix + ' -I -B ' + str(ROOT / 'probe.py') + ' ' + mode: group
        for prefix in ('/usr/bin/python3', python_exe)
        for mode, group in (('hook-post', 'parent'), ('hook-post-child', 'child'))}
    messages, pids = {'parent': [], 'child': []}, {'parent': [], 'child': []}
    for line in lines:
        try:
            row = json.loads(line, object_pairs_hook=preparation.admission_unique_fields)
        except ValueError:
            raise _HandoffRefusal(6) from None
        message = row.get('MESSAGE') if type(row) is dict else None
        if type(message) is not str or not message.startswith(preparation.ADMISSION_PHASE_PREFIX):
            continue
        _handoff_require(row.get('_UID') == '0' and row.get('_EXE') == python_exe
            and row.get('_SYSTEMD_UNIT') == UNIT and row.get('_SYSTEMD_INVOCATION_ID') == invocation
            and row.get('_TRANSPORT') == 'stdout' and '_LINE_BREAK' not in row, 7)
        _handoff_require(type(row.get('_CMDLINE')) is str and row['_CMDLINE'] in commands, 8)
        _handoff_require(type(row.get('_PID')) is str and re.fullmatch(r'[1-9][0-9]{0,9}', row['_PID'])
                and int(row['_PID']) <= 2147483647, 9)
        group = commands[row['_CMDLINE']];messages[group].append(message);pids[group].append(int(row['_PID']))
    parsed = {}
    for group, code in (('parent', 10), ('child', 11)):
        _handoff_require(len(messages[group]) == len(pids[group]) == 2 and set(pids[group]) == {expected[group]}, code)
        try:
            parsed[group] = preparation.parse_admission_phase_messages(messages[group], len(lines))
        except ValueError:
            raise _HandoffRefusal(code + 2) from None
        rows_ = parsed[group]['events']
        _handoff_require([r['p'] for r in rows_] == [0, 0] and [r['e'] for r in rows_] == ['enter', 'return']
            and not parsed[group]['activeStageCodes'] and parsed[group]['traceComplete'] is False, code + 4)
    _handoff_require(parsed['parent']['events'][-1]['t'] <= parsed['child']['events'][0]['t'], 17)
    result = unavailable_fresh_child()
    result.update(state='observed', parentPairVerified=True, childPairVerified=True, distinctPidsObserved=True,
        exactDistinctArgvObserved=True, actualSharedEmitterTransportVerified=True, refusalCode=0)
    return result


def fresh_child_handoff(preparation, invocation, identities):
    try:
        python_exe = str(pathlib.Path('/usr/bin/python3').resolve(strict=True));secure(pathlib.Path(python_exe), 0)
        deadline = time.monotonic() + limit(.5)
        code, raw = preparation.runtime_diagnostic_read(['/usr/bin/journalctl', '--system', '--no-pager', '--quiet',
            '--output=json', '--output-fields=_UID,_EXE,_CMDLINE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_TRANSPORT,_LINE_BREAK,MESSAGE',
            '--lines=64', '_SYSTEMD_UNIT=' + UNIT, '_SYSTEMD_INVOCATION_ID=' + invocation], deadline)
        _handoff_require(code == 0, 3)
        return parse_fresh_child_handoff(raw, invocation, python_exe, preparation,
            identities['parent'][0], identities['child'][0])
    except _HandoffRefusal as error:
        return unavailable_fresh_child(error.code)
    except BaseException:
        return unavailable_fresh_child()


def _bounded_host_proc(file, maximum):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        raw = os.read(fd, maximum + 1)
        require(0 < len(raw) <= maximum, 'Host proc read bound refused')
        return raw
    finally:
        os.close(fd)


def _host_source_custody():
    raw = _held_host_file(ROOT / 'source-bindings.json', 4096, 0o600)
    binding = json.loads(raw, object_pairs_hook=_host_unique_fields)
    require(type(binding) is dict and set(binding) == set(HOST_SOURCES), 'Host source closure differs')
    for name in HOST_SOURCES:
        require(hashlib.sha256(_held_host_file(ROOT / name, 256 * 1024, 0o644)).hexdigest() == binding[name],
                'Host source custody changed')
    require(_held_host_file(ROOT / 'source-bindings.json', 4096, 0o600) == raw, 'Host source binding changed')
    return raw


def _post_family(N, files, invocations):
    """Private actual proc proof, never a JSON-selected PID or exported row."""
    source_before = _host_source_custody()
    file = pathlib.Path('/etc/systemd/system', UNIT);secure(file, 0)
    info = file.lstat();require((info.st_dev, info.st_ino) == files[UNIT], 'Post declaration replaced')
    declaration = hashlib.sha256(file.read_bytes()).hexdigest()
    actual = properties(UNIT);N.require_owned_invocation(actual, invocations[UNIT], require)
    require(actual.get('ActiveState') == 'activating' and actual.get('SubState') == 'start-post'
            and actual.get('KillMode') == 'control-group' and actual.get('Delegate') == 'no'
            and actual.get('ControlGroup') == AGGREGATE_GROUP + '/' + UNIT, 'Post native phase differs')
    main, control = int(actual['MainPID']), int(actual['ControlPID'])
    require(main > 1 and control > 1 and main != control, 'Post native roots invalid')
    directory = pathlib.Path('/sys/fs/cgroup' + actual['ControlGroup']);secure(directory, 0, directory=True)
    members = (directory / 'cgroup.procs').read_text().split()
    require(0 < len(members) <= 16 and len(set(members)) == len(members), 'Post family bound differs')
    rows_ = {}
    for text in members:
        limit(.1);require(re.fullmatch(r'[1-9][0-9]{0,9}', text) is not None and 1 < int(text) <= 2147483647, 'Post PID differs')
        proc = pathlib.Path('/proc') / text
        raw = _bounded_host_proc(proc / 'stat', 65536)
        fields = raw[raw.rfind(b')') + 2:].split();require(len(fields) >= 20 and fields[0] not in (b'Z', b'X'), 'Post process not live')
        args = _bounded_host_proc(proc / 'cmdline', 65536)
        require((proc / 'exe').resolve() == pathlib.Path('/usr/bin/python3').resolve()
                and _bounded_host_proc(proc / 'cgroup', 65536).decode() == '0::' + actual['ControlGroup'] + '\n', 'Post executable/cgroup differs')
        rows_[int(text)] = (int(fields[19]), int(fields[1]), proc.stat().st_uid, args)
    require(main in rows_ and control in rows_, 'Post native roots absent')
    argv = lambda mode: [b'/usr/bin/python3', b'-I', b'-B', os.fsencode(ROOT / 'probe.py'), mode.encode(), b'']
    require(rows_[main][2:] == (65534, b'\0'.join(argv('app')))
            and rows_[control][2:] == (0, b'\0'.join(argv('hook-post'))), 'Post roots differ')
    children = [pid for pid, row in rows_.items() if row[1] == control and row[2:] == (0, b'\0'.join(argv('hook-post-child')))]
    apps = [pid for pid, row in rows_.items() if row[1] == main and row[2:] == rows_[main][2:]]
    require(len(children) == len(apps) == 1 and set(rows_) == {main, control, children[0], apps[0]}, 'Post family incomplete/foreign')
    ready = ROOT / 'post-child-ready.json';ready_before = ready.lstat()
    _read_host_record('post-child-ready.json', invocations[UNIT])
    ready_identity = (ready_before.st_dev, ready_before.st_ino)
    require(ready_identity == (ready.lstat().st_dev, ready.lstat().st_ino), 'Post ready record replaced')
    after = properties(UNIT);N.require_owned_invocation(after, invocations[UNIT], require)
    require(all(after.get(k) == actual.get(k) for k in ('MainPID', 'ControlPID', 'ControlGroup', 'ActiveState', 'SubState'))
            and set((directory / 'cgroup.procs').read_text().split()) == set(members)
            and hashlib.sha256(file.read_bytes()).hexdigest() == declaration, 'Post family changed')
    for pid, row in rows_.items():
        proc = pathlib.Path('/proc') / str(pid)
        data = _bounded_host_proc(proc / 'stat', 65536);fields = data[data.rfind(b')') + 2:].split()
        require(int(fields[19]) == row[0] and int(fields[1]) == row[1] and fields[0] not in (b'Z', b'X')
                and proc.stat().st_uid == row[2] and _bounded_host_proc(proc / 'cmdline', 65536) == row[3]
                and (proc / 'exe').resolve() == pathlib.Path('/usr/bin/python3').resolve()
                and _bounded_host_proc(proc / 'cgroup', 65536).decode() == '0::' + actual['ControlGroup'] + '\n', 'Post process changed')
    require(_host_source_custody() == source_before, 'Host source custody changed during process proof')
    return {'parent': (control, rows_[control][0]), 'child': (children[0], rows_[children[0]][0]),
            'members': {pid: row[0] for pid, row in rows_.items()}, 'readyIdentity': ready_identity}


def _await_post_family(N, files, invocations):
    while True:
        try:
            return _post_family(N, files, invocations)
        except (FileNotFoundError, ProcessLookupError):
            limit(.1);time.sleep(.02)
        except AssertionError:
            # A queued start can still be in prestart/app-fork setup. Only wait
            # until the fixed ready record exists; never retry a failed proof.
            if os.path.lexists(ROOT / 'post-child-ready.json'):
                raise
            limit(.1);time.sleep(.02)


def _forget_record(name, invocation, identity):
    require(name in ('post-child-ready.json', 'post-child-permit.json'), 'Closed host record disposal')
    file = ROOT / name
    info = file.lstat()
    require((info.st_dev, info.st_ino) == identity, 'Host record inode changed')
    raw = _held_host_file(file, 512, 0o600)
    _read_host_record(name, invocation)
    require((info.st_dev, info.st_ino) == (file.lstat().st_dev, file.lstat().st_ino), 'Host record replaced')
    file.unlink()



def main():
    global DEADLINE, PHASE_DEADLINE, WORK_PHASE_ACTIVE
    WORK_PHASE_ACTIVE = True
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
    owned_root, N, preparation = None, None, None
    declarations = {}  # Exact bytes created by this owned fixture, not observed foreign source.
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
                             ('next_preparation.py', pathlib.Path(__file__).with_name('test_next_native.py')),
                             ('controller.py', pathlib.Path(__file__).with_name('controller.py')),
                             ('next_fixture_poststart.py', pathlib.Path(__file__).with_name('next_fixture_poststart.py'))]:
            data = source.read_bytes();require(0 < len(data) <= 256 * 1024, 'Bounded source closure required')
            destination = ROOT / name
            with destination.open('xb') as output:
                output.write(data)
            destination.chmod(0o644)
            report.setdefault('sourceSha256', {})[name] = hashlib.sha256(data).hexdigest()
        binding_file = ROOT / 'source-bindings.json'
        with binding_file.open('x') as output:
            os.fchmod(output.fileno(), 0o600);output.write(json.dumps(report['sourceSha256']))
        N, I = _bound_host_module('next_profile.py', 'owned_host_view'), _bound_host_module('runtime_inventory.py', 'owned_host_inventory')
        secure(ROOT / 'next_preparation.py', 0)
        preparation = _bound_host_module('next_preparation.py', 'owned_host_next_preparation')
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
        unit += 'ExecStartPre=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook-pre\n'
        unit += 'ExecStart=/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' app\n'
        unit += 'ExecStartPost=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook-post\n'
        unit += 'Slice=' + AGGREGATE + '\nDelegate=no\nCPUWeight=100\n'
        unit += 'BindReadOnlyPaths=' + str(RELEASE) + ':' + str(RELEASE) + ':norbind\n'
        unit += ''.join('BindPaths=' + row['source'] + ':' + str(RELEASE / row['target']) + ':norbind\n' for row in rows(N)[UNIT])
        aggregate = '[Slice]\nCPUAccounting=yes\nMemoryAccounting=yes\nCPUQuota=400%\nMemoryHigh=7168M\nMemoryMax=8192M\nMemorySwapMax=0\nTasksMax=1024\n'
        for name, content in [(UNIT, unit), (FOREIGN, '[Service]\nUser=nobody\nNoNewPrivileges=yes\nExecStart=/usr/bin/sleep 15\nTimeoutStopSec=1s\nKillMode=control-group\n'), (AGGREGATE, aggregate)]:
            file = pathlib.Path('/etc/systemd/system', name)
            with file.open('x') as output:
                output.write(content)
            file.chmod(0o644);info = file.lstat();files[name] = (info.st_dev, info.st_ino)
            declarations[name] = hashlib.sha256(content.encode()).hexdigest()
        command('/usr/bin/systemctl', '--system', 'daemon-reload')
        require(host_manager_snapshot(N, preparation, projection_ledger, 1) == manager_unsets,
                'Host manager projection changed during reload')
        report['managerEnvironmentPreparation']['stable'] = True
        def start_owned(name, check=True, nonblocking=False):
            previous = invocations.get(name)
            if name == UNIT and previous is not None:
                require(family_stopped(name), 'Previous owned generation still live')
                N.require_owned_invocation(properties(name), previous, require)
            require(hashlib.sha256(_held_host_file(pathlib.Path('/etc/systemd/system', name), 65536)).hexdigest() == declarations[name],
                    'Native start source differs before request')
            result, failures = None, []
            try:
                # Preserve a capture tail even when the request times out. Each
                # subsequent service/slice capture receives its own fair share.
                result = command('/usr/bin/systemctl', '--system', 'start', *(['--no-block'] if nonblocking else []),
                    name, check=check, cap=limit() / 2)
            except BaseException as error:
                failures.append(error)
            observed_names = (name, AGGREGATE) if name == UNIT else (name,)
            try:
                capture_end = time.monotonic() + limit()
            except BaseException as error:
                failures.append(error);capture_end = time.monotonic()
            # A failed/timed-out request may still activate either source. Never
            # let the UNIT's wait consume the slice's independent capture share.
            for index, observed in enumerate(observed_names):
                try:
                    file = pathlib.Path('/etc/systemd/system', observed);secure(file, 0)
                    info = file.lstat();require((info.st_dev, info.st_ino) == files[observed], 'Native start declaration changed')
                    declaration = declarations[observed]
                    require(hashlib.sha256(_held_host_file(file, 65536)).hexdigest() == declaration, 'Native capture source differs')
                    observed_previous = previous if observed == name else invocations.get(observed)
                    now = time.monotonic()
                    capture_slot = now + max(0, capture_end - now) / (len(observed_names) - index)
                    while True:
                        remaining = capture_slot - time.monotonic()
                        require(remaining > 0, 'Native new invocation capture unavailable')
                        current = file.lstat()
                        require((current.st_dev, current.st_ino) == files[observed] and current.st_uid == 0
                                and hashlib.sha256(_held_host_file(file, 65536)).hexdigest() == declaration, 'Native start declaration changed while waiting')
                        actual = properties(observed, cap=min(3, remaining))
                        require(actual.get('FragmentPath') == str(file) and actual.get('DropInPaths') == ''
                                and actual.get('SourcePath') == '' and actual.get('Transient') == 'no', 'Native start source differs')
                        candidate = actual.get('InvocationID', '')
                        if observed == AGGREGATE and observed_previous is not None:
                            require(candidate == observed_previous, 'Owned slice invocation changed')
                            ready = True
                        else:
                            ready = _new_invocation_ready(candidate, observed_previous)
                        if ready:
                            N.require_owned_invocation(actual, candidate, require)
                            current = file.lstat()
                            require((current.st_dev, current.st_ino) == files[observed]
                                    and hashlib.sha256(_held_host_file(file, 65536)).hexdigest() == declaration, 'Native capture source changed')
                            invocations[observed] = candidate
                            break
                        # Old/empty ID remains unadopted until a genuinely new
                        # invocation is observable; no new source or budget.
                        remaining = capture_slot - time.monotonic()
                        require(remaining > 0, 'Native new invocation capture unavailable')
                        time.sleep(min(.02, remaining))
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
        start_owned(UNIT, nonblocking=True)
        first_family = _await_post_family(N, files, invocations)
        started = properties(UNIT);N.require_owned_invocation(started, invocations[UNIT], require)
        _admit_initial_observer_slot()
        report['initialEnvironmentObservation'], report['initialEnvironmentHookObservation'], report['initialEnvironmentKeyNameObservation'], report['initialEnvironmentPlainKeyNameObservation'] = initial_environment_observation(N, started, files, report['sourceSha256'])
        limit()  # Refuse immediately if scheduling consumed the admitted reserve.
        slice_state = properties(AGGREGATE)
        require(slice_state.get('ActiveState') == 'active' and slice_state.get('ControlGroup') == AGGREGATE_GROUP,
                'Actual resource slice did not activate')
        N.require_owned_invocation(slice_state, slice_state.get('InvocationID'), require)
        invocations[AGGREGATE] = slice_state['InvocationID']
        report['resourceTopology'] = resource_topology(N, I, started['InvocationID'], files, report['sourceSha256'], preparation, first_family)
        report['admissionHandoff'] = report['resourceTopology']['admissionHandoff']
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
        require(report['admissionHandoff']['state'] == 'observed', 'Fresh child journal capability unavailable')
        require(_post_family(N, files, invocations) == first_family, 'First post family changed')
        permit_identity = _host_record('post-child-permit.json', {'version': 1, 'invocation': invocations[UNIT], 'allowComplete': True})
        while True:
            admitted = properties(UNIT);N.require_owned_invocation(admitted, invocations[UNIT], require)
            if admitted.get('ActiveState') == 'active' and admitted.get('SubState') == 'running' and admitted.get('ControlPID') == '0':
                break
            require(admitted.get('ActiveState') == 'activating', 'Normal post wait refused');limit();time.sleep(.02)
        report['freshChildZeroWaitVerified'] = True
        while not all((ROOT / 'mutable' / str(index) / 'owned-native-cache').is_file() for index in range(3)):
            limit();time.sleep(0.02)
        _advance_work_phase(11)
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
        _advance_work_phase(13)
        first_invocation = invocations[UNIT]
        _forget_record('post-child-permit.json', first_invocation, permit_identity)
        _forget_record('post-child-ready.json', first_invocation, first_family['readyIdentity'])
        require(family_stopped(UNIT), 'First generation not stopped before restart')
        start_owned(UNIT, nonblocking=True)
        require(invocations[UNIT] != first_invocation, 'Restart reused native invocation')
        second_family = _await_post_family(N, files, invocations)
        require(_post_family(N, files, invocations) == second_family, 'Second post family changed')
        _advance_work_phase(17)
        post_stop = time.monotonic()
        command('/usr/bin/systemctl', '--system', 'stop', '--no-block', UNIT)
        while not family_stopped(UNIT):
            limit();time.sleep(.02)
        require(time.monotonic() - post_stop <= 4, 'Live post family stop exceeded bound')
        for pid, ticks in second_family['members'].items():
            proc = pathlib.Path('/proc') / str(pid) / 'stat'
            try:
                data = _bounded_host_proc(proc, 65536);fields = data[data.rfind(b')') + 2:].split()
            except FileNotFoundError:
                continue
            require(int(fields[19]) != ticks, 'Owned post/app process remains')
        report['livePostFamilyStopped'] = True
        report['livePostStopElapsedMs'] = (time.monotonic() - post_stop) * 1000
        _forget_record('post-child-ready.json', invocations[UNIT], second_family['readyIdentity'])
        _advance_work_phase(20)
        # A real fourth mount, not a synthetic mountinfo payload, must fail the
        # same production helper before any application command can start.
        file = pathlib.Path('/etc/systemd/system', UNIT)
        extra_unit = unit + 'BindPaths=' + str(ROOT / 'other-source') + ':' + str(RELEASE / '.next/foreign-cache') + ':norbind\n'
        file.write_text(extra_unit)
        declarations[UNIT] = hashlib.sha256(extra_unit.encode()).hexdigest()
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
        require(report['admissionHandoff']['state'] == 'observed', 'Fresh child journal capability unavailable')
        limit()
        report['complete'] = True
    except BaseException as error:
        primary = error
        report['complete'] = False
        report['primaryFailure'] = 'native-assertion' if isinstance(error, AssertionError) else 'bounded-operation-refused'
    finally:
        errors = []
        WORK_PHASE_ACTIVE = False
        try:
            cleanup(files, invocations, N, owned_root)
        except BaseException as error:
            errors.append(error)
        report['admissionHandoffTransportSettled'] = not (preparation is not None
            and preparation.report.get('diagnosticChildrenSettled') is False)
        if not report['admissionHandoffTransportSettled']:
            errors.append(RuntimeError('Component diagnostic transport settlement unavailable'))
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
        if len(sys.argv) == 2 and sys.argv[1] in ('hook-pre', 'hook-post', 'hook-post-child'):
            try:
                if sys.argv[1] == 'hook-pre':
                    hook()
                elif sys.argv[1] == 'hook-post':
                    poststart_fresh_child()
                else:
                    poststart_probe_child()
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
