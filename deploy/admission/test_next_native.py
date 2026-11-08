"""Owned ACTUAL Next two-worker boot/auth/Home smoke, not a capacity/release receipt.

Launched only from the API owner's sealed root-owned helper directory. Root
executes stdlib preparation/controllers; all Next/probe/browser JS is nonroot.
The existing fake-backend native protocol test remains a separate 240s gate.
"""
import contextlib
import ast
import hashlib
import http.client
import importlib.util
import io
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
import types

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
owned_paths, owned_units, owned_invocations = {}, {}, {}
created_home = False
created_empty_parent = None
browser = None
managed_runtime_module = None
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
CONFIGURATION_STAGES = frozenset({'principal', 'cache-sources', 'tls', 'unit-files',
    'manager-reload', 'guarded-profile', 'check-only', 'proxy-start', 'empty-publication'})
# Exact complete controller messages only. Never copy raw stderr, profile values,
# native unit contents, private paths or exception text into public evidence.
CONFIGURATION_REASONS = {
    'Managed path is missing': 'managed-path-missing',
    'Managed paths must not be symlinks': 'managed-path-link',
    'Managed path has an unexpected owner': 'managed-path-owner',
    'Managed path is writable by another principal': 'managed-path-writable',
    'Unexpected managed path type': 'managed-path-type',
    'Managed Next profile could not be verified': 'next-profile-verification',
    'Managed Next release inventory is unverified': 'next-release-verification',
    'Managed Next native configuration is unverified': 'next-native-configuration',
    'Managed Next package identity differs': 'package-identity',
    'Managed private runtime defaults differ': 'private-runtime-defaults',
    'Owned hosted app-role database required': 'app-database-scope',
    'Compiled bytes differ from exact format2 member': 'compiled-format2-member',
    'Unknown compiled envelope member': 'compiled-envelope-member',
    'Managed aggregate resource envelope differs': 'aggregate-envelope',
    'Managed resource envelope digest differs': 'aggregate-digest',
    'Managed package ownership or mode differs': 'package-owner-mode',
    'Managed package bytes differ': 'package-bytes',
    'Incomplete managed package inventory': 'package-inventory',
    'Managed package contains application prerender data': 'application-prerender',
    'Compiled dependency alias target differs': 'compiled-alias-target',
    'Compiled external dependency identity differs': 'compiled-external-identity',
    'Worker service identity differs from its profile': 'unit-command-identity',
    'Privileged-hook credential source is not qualified': 'unit-credential-source',
    'Privileged-hook environment source is not qualified': 'unit-environment-source',
    'Unsupported privileged-hook environment file syntax': 'unit-environment-file-syntax',
    'Managed worker sandbox/resource declarations differ': 'unit-sandbox-declarations',
    'Typed worker privilege/namespace restriction differs': 'unit-typed-restrictions',
    'Exact typed nonrecursive cache/release binds required': 'unit-typed-binds',
    'Only the exact stock Next command is supported': 'stock-next-command',
}
OBSERVER_PATHS = {'controller': '/usr/local/lib/aihr-admission/controller.py',
    'next-profile': '/usr/local/lib/aihr-admission/next_profile.py',
    'inventory': '/usr/local/lib/aihr-admission/runtime_inventory.py'}
OBSERVER_BINDING_STAGES = frozenset({'entry', 'input', 'observer-source', 'controller-source',
    'next-profile-source', 'inventory-source', 'profile-source', 'source-binding', 'controller-main', 'source-recheck'})
observer_binding_stage = 'entry'
OBSERVER_EXCEPTIONS = frozenset({'AssertionError', 'AttributeError', 'EOFError', 'FileNotFoundError',
    'ImportError', 'IndexError', 'KeyError', 'ModuleNotFoundError', 'NotADirectoryError', 'OSError',
    'OverflowError', 'PermissionError', 'RuntimeError', 'SyntaxError', 'TimeoutError', 'TypeError',
    'UnicodeDecodeError', 'UnicodeError', 'ValueError', 'ZeroDivisionError', 'JSONDecodeError'})


def observer_code_identity(code):
    """Exact semantic code fields; independent of marshal string sharing/interning."""
    def constant(value):
        if isinstance(value, types.CodeType):
            return ['code', observer_code_identity(value).hex()]
        if value is None or value is Ellipsis:
            return ['none' if value is None else 'ellipsis']
        if type(value) in (bool, int, str):
            return [type(value).__name__, str(value)]
        if isinstance(value, bytes):
            return ['bytes', value.hex()]
        if isinstance(value, float):
            return ['float', value.hex()]
        if isinstance(value, complex):
            return ['complex', value.real.hex(), value.imag.hex()]
        if isinstance(value, tuple):
            return ['tuple', [constant(item) for item in value]]
        if isinstance(value, frozenset):
            return ['frozenset', sorted((constant(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))]
        raise AssertionError('Unsupported observer code constant')
    value = {name: getattr(code, name) for name in ('co_argcount', 'co_posonlyargcount', 'co_kwonlyargcount',
        'co_nlocals', 'co_stacksize', 'co_flags', 'co_filename', 'co_name', 'co_qualname', 'co_firstlineno',
        'co_names', 'co_varnames', 'co_freevars', 'co_cellvars')}
    value.update({name: getattr(code, name).hex() for name in ('co_code', 'co_linetable', 'co_exceptiontable')})
    value['co_consts'] = [constant(item) for item in code.co_consts]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).digest()


def observer_catalog(sources):
    """Source models can exercise this pure compiler; only the root entry binds files."""
    require(isinstance(sources, dict) and set(sources) == set(OBSERVER_PATHS), 'Closed observer sources required')
    result = {}
    for owner, raw in sources.items():
        require(isinstance(raw, bytes) and 0 < len(raw) <= 1024 * 1024, 'Observer source exceeds bound')
        filename = OBSERVER_PATHS[owner]
        tree = ast.parse(raw, filename)
        lines = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and (
                    isinstance(node.func, ast.Name) and node.func.id in ('require', 'check')
                    or isinstance(node.func, ast.Attribute) and node.func.attr in ('require', 'check')):
                lines.update(range(node.lineno, node.end_lineno + 1))
        code = compile(raw, filename, 'exec', dont_inherit=True)
        codes = set()
        def gather(value):
            codes.add(observer_code_identity(value))
            for child in value.co_consts:
                if isinstance(child, types.CodeType):
                    gather(child)
        gather(code)
        result[owner] = {'module': code, 'codes': frozenset(codes), 'lines': frozenset(lines)}
    return result


def observer_location(frame, catalog):
    for owner, filename in OBSERVER_PATHS.items():
        if frame.f_code.co_filename == filename and frame.f_globals.get('__file__') == filename:
            trusted = catalog[owner]
            if (frame.f_lineno in trusted['lines'] and
                    observer_code_identity(frame.f_code) in trusted['codes']):
                return {'classification': 'guard', 'owner': owner, 'line': frame.f_lineno}
    return {'classification': 'foreign-guard'}


class ObserverStream(io.TextIOBase):
    """Never allocate an unbounded copy of private controller output."""
    def __init__(self, maximum):
        self.maximum, self.parts, self.length, self.overflow = maximum, [], 0, False

    def write(self, text):
        count = len(text)
        amount = len(text.encode('utf8')) if count <= self.maximum else self.maximum + 1
        if self.length + amount <= self.maximum and not self.overflow:
            self.parts.append(text)
            self.length += amount
        else:
            self.parts.clear()
            self.overflow = True
        return count

    def text(self):
        return ''.join(self.parts) if not self.overflow else ''


def observe_controller_main(controller, catalog):
    """Call the unmodified main and ALWAYS the original require; restore both globals."""
    original, argv = controller.require, sys.argv
    for function in (original, controller.main):
        require(function.__globals__ is controller.__dict__
                and observer_code_identity(function.__code__) in catalog['controller']['codes'],
                'Observer controller code identity differs')
    guard = None
    stdout, stderr = ObserverStream(65536), ObserverStream(1024)
    def observed(*args, **kwargs):
        nonlocal guard
        try:
            return original(*args, **kwargs)
        except controller.Refused:
            try:
                location = observer_location(sys._getframe(1), catalog)
            except Exception:
                location = {'classification': 'foreign-guard'}
            if guard is None or location['classification'] == 'foreign-guard':
                guard = location
            raise
    controller.require = observed
    sys.argv = [OBSERVER_PATHS['controller'], 'check-only']
    exception = None
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                code = controller.main()
            except BaseException as error:
                exception = type(error).__name__ if type(error).__name__ in OBSERVER_EXCEPTIONS else 'unknown'
                code = error.code if isinstance(error, SystemExit) and type(error.code) is int and 0 <= error.code <= 255 else 1
    finally:
        controller.require = original
        sys.argv = argv
    require(type(code) is int and 0 <= code <= 255, 'Observer controller exit differs')
    if code == 0:
        value = json.loads(stdout.text()) if not stdout.overflow else None
        require(isinstance(value, dict) and set(value) == {'kind', 'installationAvailable', 'releaseEligible',
                'rootBoundaryInspected', 'typedEmptyCredentialsVerified', 'immutableEntriesInspected', 'remainingInstallationGates'}
                and value['kind'] == 'ADMISSION_CHECKONLY' and value['installationAvailable'] is False
                and value['releaseEligible'] is False and value['rootBoundaryInspected'] is True
                and value['typedEmptyCredentialsVerified'] is True and type(value['immutableEntriesInspected']) is int
                and 0 <= value['immutableEntriesInspected'] <= 4_000_000
                and value['remainingInstallationGates'] == ['authenticated-format3-grant-and-shared-lease',
                    'complete-nginx-runtime-and-include-inventory', 'resource-envelope-admission',
                    'old-new-build-and-server-action-compatibility', 'real-next-transport-and-worker-qualification']
                and not stderr.overflow and stderr.text() == '' and not exception
                and (guard is None or guard['classification'] != 'foreign-guard'), 'Observer success output is unqualified')
        return code, stdout.text(), None
    diagnostic = guard or {'classification': 'cli-refusal'}
    if guard is None:
        for name in OBSERVER_EXCEPTIONS:
            if exception == name or stderr.text() == 'Admission failed: ' + name + '; reconcile before retry\n':
                diagnostic = {'classification': 'cli-exception', 'exception': name}
                break
    return code, '', diagnostic


def observer_read(file, maximum):
    """Fixed root paths only, pinned descriptor and complete nonwritable ancestor chain."""
    file = pathlib.Path(file)
    current = pathlib.Path('/')
    for part in file.parts[1:]:
        current /= part
        info = current.lstat()
        require(info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and not info.st_mode & 0o022,
                'Observer root path is unqualified')
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= maximum,
            'Observer root file is unqualified')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(fd)) == identity(info), 'Observer root file changed')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(maximum + 1)
        require(len(raw) == info.st_size and identity(os.fstat(fd)) == identity(info) == identity(file.lstat()),
                'Observer root file changed')
        return raw
    finally:
        os.close(fd)


def observer_input(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 4096, 'Closed observer input exceeds bound')
    try:
        expected = json.loads(raw)
    except (ValueError, UnicodeError):
        raise AssertionError('Closed observer input differs') from None
    require(isinstance(expected, dict) and set(expected) == {'version', 'kind', 'observerSha256', 'profileSha256', 'sourceHashes'}
            and type(expected['version']) is int and expected['version'] == 1
            and expected['kind'] == 'SOURCE_BOUND_INSTALLED_CHECKONLY_OBSERVER'
            and isinstance(expected['sourceHashes'], dict) and set(expected['sourceHashes']) == set(OBSERVER_PATHS)
            and all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in
                [expected['observerSha256'], expected['profileSha256'], *expected['sourceHashes'].values()]),
            'Closed observer input differs')
    require((json.dumps(expected, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode() == raw,
            'Observer input must be canonical')
    return expected


def observer_bind(expected, own_raw, sources, profile_raw):
    require(isinstance(own_raw, bytes) and 0 < len(own_raw) <= 1024 * 1024
            and hashlib.sha256(own_raw).hexdigest() == expected['observerSha256'], 'Observer source identity differs')
    require(isinstance(sources, dict) and set(sources) == set(OBSERVER_PATHS)
            and all(isinstance(raw, bytes) and 0 < len(raw) <= 1024 * 1024 for raw in sources.values()),
            'Closed observer sources required')
    require(all(hashlib.sha256(raw).hexdigest() == expected['sourceHashes'][owner] for owner, raw in sources.items()),
            'Observer installed source identity differs')
    require(isinstance(profile_raw, bytes) and 0 < len(profile_raw) <= 32768
            and hashlib.sha256(profile_raw).hexdigest() == expected['profileSha256'], 'Observer profile identity differs')
    profile = json.loads(profile_raw)
    require(isinstance(profile, dict) and type(profile.get('version')) is int and profile['version'] == 2
            and profile.get('controllerDigest') == expected['sourceHashes']['controller']
            and profile.get('trustedModules') == {'next_profile.py': expected['sourceHashes']['next-profile'],
                'runtime_inventory.py': expected['sourceHashes']['inventory']}, 'Observer profile source binding differs')
    return observer_catalog(sources)


def observer_entry():
    global observer_binding_stage
    observer_binding_stage = 'entry'
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Observer requires owned Linux root')
    own = pathlib.Path(__file__).absolute()
    require(re.fullmatch(r'/var/lib/aihr-native-build/[1-9][0-9]{0,19}/[A-Za-z0-9_-]{1,100}/helpers/test_next_native.py', str(own)) is not None,
            'Observer requires sealed fixture source')
    observer_binding_stage = 'input'
    expected = observer_input(sys.stdin.buffer.read(4097))
    observer_binding_stage = 'observer-source'
    require(stat.S_IMODE(own.lstat().st_mode) == 0o400, 'Observer requires sealed fixture mode')
    own_raw = observer_read(own, 1024 * 1024)
    sources = {}
    for owner, filename in OBSERVER_PATHS.items():
        observer_binding_stage = owner + '-source'
        sources[owner] = observer_read(filename, 1024 * 1024)
    observer_binding_stage = 'profile-source'
    profile_raw = observer_read('/etc/aihr-admission/profile.json', 32768)
    observer_binding_stage = 'source-binding'
    catalog = observer_bind(expected, own_raw, sources, profile_raw)
    controller = types.ModuleType('source_bound_actual_controller')
    controller.__file__ = OBSERVER_PATHS['controller']
    exec(catalog['controller']['module'], controller.__dict__)
    observer_binding_stage = 'controller-main'
    code, stdout, diagnostic = observe_controller_main(controller, catalog)
    observer_binding_stage = 'source-recheck'
    require(all(observer_read(OBSERVER_PATHS[owner], 1024 * 1024) == raw for owner, raw in sources.items())
            and observer_read('/etc/aihr-admission/profile.json', 32768) == profile_raw,
            'Observer installed source changed during CHECKONLY')
    if diagnostic is not None:
        sys.stderr.write(json.dumps({'version': 1, 'kind': 'SOURCE_BOUND_CHECKONLY_REFUSAL', **diagnostic}, sort_keys=True) + '\n')
    else:
        sys.stdout.write(stdout)
    return code


def observer_diagnostic(raw, catalog):
    """Only closed source points/classes survive; foreign/private bytes remain generic."""
    invalid = {'reason': 'controller-observer-refused'}
    if not isinstance(raw, bytes) or not 0 < len(raw) <= 2048:
        return invalid
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get('version') != 1 or type(value['version']) is not int
                or value.get('kind') != 'SOURCE_BOUND_CHECKONLY_REFUSAL'
                or (json.dumps(value, sort_keys=True) + '\n').encode() != raw):
            return invalid
        classification = value.get('classification')
        if classification == 'guard' and set(value) == {'version', 'kind', 'classification', 'owner', 'line'}:
            owner, line = value['owner'], value['line']
            if (isinstance(owner, str) and owner in OBSERVER_PATHS and type(line) is int
                    and line in catalog[owner]['lines']):
                return {'reason': 'controller-source-guard', 'sourceGuard': {'owner': owner, 'line': line}}
        elif classification == 'cli-exception' and set(value) == {'version', 'kind', 'classification', 'exception'}:
            if isinstance(value['exception'], str) and value['exception'] in OBSERVER_EXCEPTIONS:
                return {'reason': 'controller-exception', 'exception': value['exception']}
        elif classification in ('foreign-guard', 'cli-refusal', 'binding-refusal') and set(value) == {'version', 'kind', 'classification'}:
            return {'reason': {'foreign-guard': 'controller-foreign-guard', 'cli-refusal': 'controller-direct-refusal',
                               'binding-refusal': 'controller-observer-binding'}[classification]}
        elif classification == 'binding-refusal' and set(value) == {'version', 'kind', 'classification', 'stage'}:
            if isinstance(value['stage'], str) and value['stage'] in OBSERVER_BINDING_STAGES:
                return {'reason': 'controller-observer-binding', 'bindingStage': value['stage']}
    except (ValueError, UnicodeError, TypeError, KeyError):
        pass
    return invalid


def observer_bound_catalog(expected):
    sources = {owner: observer_read(filename, 1024 * 1024) for owner, filename in OBSERVER_PATHS.items()}
    require(all(hashlib.sha256(raw).hexdigest() == expected['sourceHashes'][owner] for owner, raw in sources.items()),
            'Observer installed source identity differs')
    return observer_catalog(sources)


def configuration_phase(stage):
    require(isinstance(stage, str) and stage in CONFIGURATION_STAGES, 'Unknown closed configuration stage')
    report['configuration'] = {'stage': stage, 'declarationsVerified': False,
                               'actualNextBootVerified': False}
    save()


def configuration_reason(stderr):
    if not isinstance(stderr, bytes) or len(stderr) > 1024:
        return 'controller-refused'
    for message, code in CONFIGURATION_REASONS.items():
        if stderr == ('Admission refused: ' + message + '\n').encode():
            return code
    return 'controller-refused'


def configuration_control(operation, observer=None):
    require(isinstance(operation, str) and operation in ('check-only', 'status'), 'Unsupported closed configuration operation')
    expected = 'check-only' if operation == 'check-only' else 'empty-publication'
    require(report.get('currentPhase') == 'protected-native-configuration'
            and report.get('configuration', {}).get('stage') == expected,
            'Closed configuration operation phase differs')
    try:
        result = control(operation, check=False) if observer is None else control(operation, check=False, observer=observer)
    except subprocess.TimeoutExpired:
        report['configuration']['reason'] = 'controller-timeout'
        save()
        raise AssertionError('Protected native configuration operation timed out') from None
    if result.returncode != 0:
        if observer is None:
            report['configuration']['reason'] = configuration_reason(result.stderr)
        else:
            require(type(result.returncode) is int and -128 <= result.returncode <= 255, 'Invalid observer process exit')
            report['configuration']['exit'] = {'classification': 'signal' if result.returncode < 0 else 'nonzero', 'status': result.returncode}
            if result.returncode < 0:
                report['configuration']['reason'] = 'controller-signal'
            else:
                try:
                    preliminary = observer_diagnostic(result.stderr, {})
                    diagnostic = preliminary if preliminary['reason'] == 'controller-observer-binding' else observer_diagnostic(result.stderr, observer_bound_catalog(observer))
                    report['configuration'].update(diagnostic)
                except (OSError, ValueError, AssertionError, TypeError, KeyError):
                    report['configuration']['reason'] = 'controller-observer-binding'
        save()
        raise AssertionError('Protected native configuration operation refused')
    return result


def require(condition, reason):
    if not condition:
        raise AssertionError(reason)


def left(maximum=30):
    value = DEADLINE - time.monotonic()
    require(value > 0, 'Native Next fixture total deadline exceeded')
    return min(maximum, value)


def run(arguments, *, check=True, timeout=30, env=None, input=None, cwd=None):
    try:
        result = subprocess.run(arguments, env=SAFE_ENV if env is None else env, input=input,
                                capture_output=True, timeout=left(timeout), cwd=cwd)
    except BaseException as error:
        runtime_command_observation(arguments, error=error)
        raise
    runtime_command_observation(arguments, result=result)
    if check:
        require(result.returncode == 0, 'Bounded native subprocess refused')
    return result


def systemctl(*args, check=True, timeout=30):
    return run(['/usr/bin/systemctl', '--system', *args], check=check, timeout=timeout)


def props(unit, timeout=30):
    raw = systemctl('show', unit, '--property=LoadState,InvocationID,MainPID,ControlPID,ActiveState,SubState,ExecStart,ExecReload,FragmentPath,ControlGroup', timeout=timeout).stdout.decode()
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


def control(operation, unit=None, check=True, observer=None):
    if observer is None:
        result = run(['/usr/bin/python3', '-I', '-B', '/usr/local/lib/aihr-admission/controller.py', operation]
                     + ([unit] if unit else []), check=False, timeout=60)
    else:
        require(operation == 'check-only' and unit is None, 'Observer accepts only fixed CHECKONLY')
        result = run(['/usr/bin/python3', '-I', '-B', str(pathlib.Path(__file__).absolute()), '--observe-check-only'],
                     input=(json.dumps(observer, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode(),
                     check=False, timeout=60)
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


FORMAT2_REFUSALS = {
    b'Build bundle refused: generated semver wrapper does not belong to this runtime source\n': 'format2-installer-runtime-prefix',
    b'Build bundle refused: canonical distinct producer source required for installer comparison\n': 'format2-installer-origin',
    b'Build bundle refused: runtime prefix outside generated NODE_PATH\n': 'format2-installer-prefix-site',
    b'Build bundle refused: unsupported generated semver wrapper\n': 'format2-installer-shape',
}


def receive_compiled_package(helper, binding, release):
    require(report.get('currentPhase') == 'existing-format2-exact-receiver', 'Compiled receiver phase differs')
    try:
        result = run(['/usr/bin/python3', '-I', '-B', str(helper / 'build-bundle.py'), 'unpack-with-origin',
            binding['archivePath'], binding['manifestPath'], str(release / '.next'), str(release),
            binding['buildSourcePath']], timeout=60, check=False)
    except subprocess.TimeoutExpired:
        report['format2ReceiverFailure'] = {'code': 'format2-receiver-timeout'}
        save()
        raise AssertionError('Bounded compiled package receiver refused') from None
    if result.returncode != 0:
        report['format2ReceiverFailure'] = {'code': FORMAT2_REFUSALS.get(result.stderr, 'format2-receiver-refused')}
        save()
        raise AssertionError('Bounded compiled package receiver refused')


PROBE_STAGES = ('admission', 'next-version', 'sharp-image', 'font-layout', 'next-config', 'executable-maps')
PROBE_REFUSALS = {(json.dumps({'version': 1, 'kind': 'NATIVE_DEPENDENCY_PROBE_REFUSAL', 'stage': stage},
                           separators=(',', ':')) + '\n').encode(): 'probe-' + stage for stage in PROBE_STAGES}
PROBE_PROGRESS = tuple((json.dumps({'version': 1, 'kind': 'NATIVE_DEPENDENCY_PROBE_STAGE_ENTERED', 'stage': stage},
                                 separators=(',', ':')) + '\n').encode() for stage in PROBE_STAGES)
FIXED_RUNTIME = pathlib.Path('/var/lib/aihr-admission/release')


def probe_diagnostic(raw):
    # Only an exact ordered prefix can supply a last-entered source stage.
    # Raw child output, including a fatal VM traceback, never enters evidence.
    bounded = isinstance(raw, bytes) and len(raw) <= 65536
    remaining, entered = raw[:4096] if isinstance(raw, bytes) and not bounded else raw if isinstance(raw, bytes) else b'', None
    for stage, line in zip(PROBE_STAGES, PROBE_PROGRESS):
        if not remaining.startswith(line):
            break
        entered, remaining = stage, remaining[len(line):]
    code = PROBE_REFUSALS.get(remaining, 'probe-refused') if bounded else 'probe-refused'
    if code != 'probe-' + str(entered):
        code = 'probe-refused'
    return {'code': code, **({'lastEnteredStage': entered} if entered else {})}


def native_dependency_probe(node, release):
    require(report.get('currentPhase') == 'nonroot-stock-native-dependency-probe', 'Native dependency probe phase differs')
    require(release == FIXED_RUNTIME and release.resolve() == release, 'Exact copied runtime working directory required')
    try:
        result = run(['/usr/sbin/runuser', '-u', 'nobody', '--preserve-environment', '--', node, '--max-old-space-size=256',
            '/usr/local/lib/aihr-admission/next_dependency_probe.cjs', str(release)], timeout=30, check=False, cwd=str(release),
            env={'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1', 'HOME': '/var/empty/aihr', 'PATH': '/usr/bin:/bin'})
    except subprocess.TimeoutExpired as error:
        diagnostic = probe_diagnostic(error.stderr)
        report['dependencyProbeFailure'] = {**diagnostic, 'code': 'probe-timeout'}
        save()
        raise AssertionError('Bounded native dependency probe refused') from None
    if result.returncode != 0:
        report['dependencyProbeFailure'] = probe_diagnostic(result.stderr)
        save()
        raise AssertionError('Bounded native dependency probe refused')
    return json.loads(result.stdout)


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
    receive_compiled_package(helper, binding, release)
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
    probe = native_dependency_probe(plan['nodePath'], release)
    require(probe['kind'] == 'NONROOT_NATIVE_DEPENDENCY_PROBE_NOT_APPLICATION_ACCEPTANCE'
            and probe['runtime'] == N.RUNTIME and probe['imageBytes'] > 20 and probe['cjkGlyphs'] == 2
            and type(probe['uid']) is int and probe['uid'] == pwd.getpwnam('nobody').pw_uid
            and probe['copiedRuntimeCwdVerified'] is True and probe['privateHomeVerified'] is True,
            'Actual installed dependency/runtime probe differs')
    require(isinstance(probe['executableFiles'], list) and 0 < len(probe['executableFiles']) <= 512
            and all(isinstance(name, str) and name.startswith('/') and len(name) <= 4096 for name in probe['executableFiles']),
            'Bounded actual executable mapping proof required')
    report['dependencyProbe'] = {'kind': probe['kind'], 'uid': probe['uid'], 'copiedRuntimeCwdVerified': True,
        'privateHomeVerified': True, 'imageBytes': probe['imageBytes'], 'cjkGlyphs': 2,
        'mappedExecutableFiles': len(probe['executableFiles']), 'actualNextBootVerified': False}
    save()
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
    # Input-free actual mapping observations only; never publish a pathname.
    # This distinguishes the prior generic path refusal from its hypothesis.
    report['nativeSystemLibraryPaths'] = {'count': len(libraries),
        'plusNamed': sum('+' in file for file in libraries),
        'legacyGrammarRefused': sum(N.SAFE_PATH.fullmatch(file) is None for file in libraries)}
    save()
    for file in libraries:
        require(str(N.system_library_path(file, require)) == file,
                'Actual native library path grammar differs')

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


class OwnedPostgresScope:
    """Register ONLY this job's existing zero-swap Docker scope with its manager.

    This fixes persistence before any manager reload, never repairs drift after
    work or weakens the independently captured final PostgreSQL resource witness.
    """
    STAGES = frozenset({'registered', 'before-config-reload', 'after-config-reload',
                        'before-cleanup-reload', 'after-cleanup-reload', 'final'})
    FORMAT = ('{"id":{{json .Id}},"name":{{json .Name}},'
              '"owner":{{json (index .Config.Labels "aihr-owner")}},'
              '"pid":{{json .State.Pid}},"started":{{json .State.StartedAt}},'
              '"running":{{json .State.Running}},"memory":{{json .HostConfig.Memory}},'
              '"swap":{{json .HostConfig.MemorySwap}}}')

    def __init__(self, plan):
        require(isinstance(plan.get('runId'), str) and re.fullmatch(r'[1-9][0-9]{0,19}', plan['runId'])
                and isinstance(plan.get('unit'), str) and re.fullmatch(r'db-[a-f0-9]{16}', plan['unit']),
                'Fixed native PostgreSQL job identity required')
        self.name = 'aihr-ci-' + plan['runId'] + '-1-' + plan['unit']
        driver = self.docker('info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}').stdout.strip()
        require(driver == b'systemd 2', 'Owned native PostgreSQL requires systemd unified cgroups')
        self.identity = self.inspect()
        self.scope = 'docker-' + self.identity['id'] + '.scope'
        self.group = '/system.slice/' + self.scope
        # Kernel zero must already exist. Register its intended persistence;
        # never reset an already drifting workload to manufacture acceptance.
        self.observe(require_manager_zero=False)
        systemctl('set-property', '--runtime', self.scope, 'MemorySwapMax=0', timeout=10)
        self.snapshot('registered')

    @staticmethod
    def docker(*args):
        return run(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', *args], timeout=10)

    def inspect(self):
        raw = self.docker('inspect', '--format', self.FORMAT, self.name).stdout
        require(isinstance(raw, bytes) and 0 < len(raw) <= 4096, 'Bounded native container identity required')
        row = json.loads(raw)
        require(isinstance(row, dict) and set(row) == {'id', 'name', 'owner', 'pid', 'started', 'running', 'memory', 'swap'}
                and isinstance(row['id'], str) and re.fullmatch(r'[a-f0-9]{64}', row['id'])
                and row['name'] == '/' + self.name and row['owner'] == self.name
                and type(row['pid']) is int and row['pid'] > 1 and row['running'] is True
                and isinstance(row['started'], str) and re.fullmatch(r'[0-9TZ:.+-]{20,40}', row['started'])
                and type(row['memory']) is int and row['memory'] == 2113929216
                and type(row['swap']) is int and row['swap'] == 2113929216,
                'Actual owned native PostgreSQL container differs')
        return row

    def observe(self, require_manager_zero=True):
        require(self.inspect() == self.identity, 'Native PostgreSQL container changed')
        keys = {'Id', 'LoadState', 'ActiveState', 'ControlGroup', 'MemorySwapMax'}
        raw = systemctl('show', self.scope, '--property=' + ','.join(sorted(keys)), timeout=10).stdout
        require(isinstance(raw, bytes) and 0 < len(raw) <= 16384, 'Bounded native PostgreSQL manager fields required')
        row = {}
        for line in raw.decode('utf8').strip().splitlines():
            key, separator, value = line.partition('=')
            require(separator == '=' and key in keys and key not in row
                    and len(value) <= 4096 and '\0' not in value, 'Closed native PostgreSQL manager fields required')
            row[key] = value
        require(set(row) == keys, 'Complete native PostgreSQL manager fields required')
        require(row['Id'] == self.scope and row['LoadState'] == 'loaded' and row['ActiveState'] == 'active'
                and row['ControlGroup'] == self.group,
                'Native PostgreSQL manager scope is foreign or inactive')
        require(pathlib.Path('/proc', str(self.identity['pid']), 'cgroup').read_bytes() == ('0::' + self.group + '\n').encode(),
                'Actual PostgreSQL native PID belongs to another scope')
        require(not require_manager_zero or row['MemorySwapMax'] == '0', 'Native PostgreSQL manager swap limit drifted')
        raw = self.docker('exec', self.name, 'cat', '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max').stdout
        require(raw == b'2113929216\n0\n', 'Native PostgreSQL kernel resource limit drifted')
        require(self.inspect() == self.identity, 'Native PostgreSQL identity changed during scope observation')
        return {'memoryMax': 2113929216, 'memorySwapMax': 0, 'managerSwapMax': row['MemorySwapMax']}

    def snapshot(self, stage):
        require(stage in self.STAGES, 'Unknown native PostgreSQL scope observation')
        value = self.observe()
        observations = report.setdefault('ownedPostgresScope', {'version': 1, 'kind': 'JOB_OWNED_PERSISTENT_ZERO_SWAP',
            'containerIdentitySha256': hashlib.sha256(json.dumps(self.identity, sort_keys=True).encode()).hexdigest(),
            'scopeOnly': True, 'observations': []})
        require(len(observations['observations']) < len(self.STAGES), 'Native PostgreSQL observations exceed bound')
        require(stage not in {row['stage'] for row in observations['observations']}, 'Duplicate native PostgreSQL scope observation')
        observations['observations'].append({'stage': stage, **value})
        save()


def configure(plan, binding, N, release, runtime_package, postgres_scope):
    global managed_runtime_module
    managed_runtime_module = N
    phase('protected-native-configuration')
    configuration_phase('principal')
    nobody = pwd.getpwnam('nobody')
    require(nobody.pw_uid == 65534 and nobody.pw_gid == 65534, 'Expected fixed nonroot app principal')
    used = {3443}
    pool, control_port = [port(used) for _ in range(32)], port(used)
    envelope = {'version': 1, 'kind': 'HOSTED_NEXT_SAME_BUILD_V1', 'workers': 2,
        'suite': 'workflow-preflight', 'cpuOversubscriptionDiagnostic': False, 'slice': SLICE,
        'cgroupPath': FIXTURE_CGROUP, 'cpuQuotaPercent': 400,
        'memoryHighBytes': 7168 * 1024**2, 'memoryMaxBytes': 8192 * 1024**2, 'memorySwapMaxBytes': 0,
        'totalHeapMiB': 4096, 'totalWebConnections': 16, 'totalWaitingBudget': 2048, 'tasksMax': 1024}
    configuration_phase('cache-sources')
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
    configuration_phase('tls')
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
CPUWeight=100
UMask=0077
'''
    configuration_phase('unit-files')
    for name, contents in files.items():
        file = pathlib.Path('/etc/systemd/system', name)
        require(not os.path.lexists(file), 'Fixture unit destination already exists')
        write(file, contents, 0o644)
        info = file.stat()
        owned_units[name] = (info.st_dev, info.st_ino)
    configuration_phase('manager-reload')
    postgres_scope.snapshot('before-config-reload')
    systemctl('daemon-reload')
    postgres_scope.snapshot('after-config-reload')
    configuration_phase('guarded-profile')
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
    # Private native observation custody only; contains no environment data.
    observation_context = {'version': 1, 'profileSha256': hashlib.sha256(N.canonical(profile)).hexdigest(),
        'sources': {name: binding['helpers'][name]['sha256']
                    for name in ('next_fixture_poststart.py', 'next_profile.py')},
        'units': {unit: {'device': owned_units[unit][0], 'inode': owned_units[unit][1],
            'sha256': hashlib.sha256(pathlib.Path('/etc/systemd/system', unit).read_bytes()).hexdigest()}
            for unit in UNITS}}
    write(pathlib.Path('/etc/aihr-admission/observation.json'), N.canonical(observation_context))
    configuration_phase('check-only')
    observer = {'version': 1, 'kind': 'SOURCE_BOUND_INSTALLED_CHECKONLY_OBSERVER',
        'observerSha256': binding['helpers']['test_next_native.py']['sha256'],
        'profileSha256': hashlib.sha256(N.canonical(profile)).hexdigest(),
        'sourceHashes': {'controller': profile['controllerDigest'], 'next-profile': profile['trustedModules']['next_profile.py'],
                         'inventory': profile['trustedModules']['runtime_inventory.py']}}
    check = json.loads(configuration_control('check-only', observer=observer).stdout)
    require(check.get('kind') == 'ADMISSION_CHECKONLY' and check.get('rootBoundaryInspected') is True
            and check.get('installationAvailable') is False, 'Non-starting boundary inspection did not qualify')
    require(all(props(unit)['MainPID'] == '0' for unit in UNITS), 'CHECKONLY started an application worker')
    report['checkOnlyDidNotStartWorkers'] = True
    write(pathlib.Path('/run/aihr-admission/permit-' + UNITS[0]), b'owned cold gate\n')
    configuration_phase('proxy-start')
    owned_start(PROXY, timeout=60)
    configuration_phase('empty-publication')
    require(json.loads(configuration_control('status').stdout)['workers'] == [], 'Empty proxy unexpectedly published worker')
    report['configuration']['declarationsVerified'] = True
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
        '--property=TimeoutStopSec=3s', '--property=SendSIGKILL=yes', '--property=RuntimeMaxSec=300s',
        '--property=Description=Owned actual Next browser ' + plan['runId'],
        '--setenv=HOME=' + runner.pw_dir, '--setenv=PATH=/usr/bin:/bin', '--setenv=LANG=C.UTF-8',
        plan['nodePath'], '--max-old-space-size=512', driver, plan['browserInputPath']]
    browser = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
    until(lambda: record_owned_invocation(BROWSER, transient=True), 'owned native browser invocation', seconds=5)
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
                owned_start(UNITS[0], timeout=90)
                first = until(lambda: ready(UNITS[0]), 'first actual Next worker READY')
                proofs.append(native_worker(C, first, plan, binding))
                result = {'port': first['port']}
            elif operation == 'start-second-cold':
                owned_start(UNITS[1], nonblocking=True)
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


def require_stopped(unit, actual=None):
    if actual is None:
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


def record_owned_invocation(unit, transient=False):
    actual = props(unit)
    invocation = actual.get('InvocationID', '')
    if actual.get('LoadState') == 'not-found' or not invocation:
        return False
    require(re.fullmatch(r'[0-9a-f]{32}', invocation) is not None, 'Native owned invocation invalid')
    if transient:
        require(unit == BROWSER and browser is not None, 'No owned browser launch')
        description = systemctl('show', unit, '--property=Description,Transient', timeout=2).stdout.decode()
        require('Transient=yes\n' in description
                and 'Description=Owned actual Next browser ' + report['runId'] + '\n' in description,
                'Owned browser declaration differs')
    else:
        file = pathlib.Path('/etc/systemd/system', unit)
        info = file.lstat()
        require((info.st_dev, info.st_ino) == owned_units.get(unit) and info.st_uid == 0,
                'Owned service declaration changed at invocation capture')
    prior = owned_invocations.get(unit)
    require(prior is None or prior == invocation, 'Owned native invocation unexpectedly changed')
    owned_invocations[unit] = invocation
    return True


def owned_start(unit, *, timeout=30, nonblocking=False):
    require(unit in [*UNITS, PROXY] and unit in owned_units, 'Closed owned service start required')
    errors, result = [], None
    try:
        result = systemctl('start', *(['--no-block'] if nonblocking else []), unit, timeout=timeout)
    except BaseException as error:
        errors.append(error)
    try:
        if nonblocking:
            until(lambda: record_owned_invocation(unit), 'new native owned invocation', seconds=5)
        else:
            require(record_owned_invocation(unit), 'Native owned start produced no invocation')
    except BaseException as error:
        errors.append(error)
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup('Owned native start or identity capture refused', errors)
    return result


def cleanup(postgres_scope):
    # One aggregate deadline, including telemetry, all native stop attempts,
    # absence proofs, manager reload and descriptor-only filesystem disposal.
    global DEADLINE
    started = time.monotonic()
    DEADLINE = min(TOTAL_DEADLINE, started + 30)
    admission_end, queue_end, settlement_end = started + 6, started + 8, started + 15
    errors, safe = [], []
    def phase_timeout(frontier, cap, slots=1):
        remaining = min(DEADLINE, frontier) - time.monotonic()
        require(remaining > 0, 'Owned cleanup phase deadline exceeded')
        return min(cap, remaining / max(1, slots))
    # Reserve a fair observation slot for every other independently owned unit
    # and both browser properties. A single30s show must not consume all custody.
    admission_slots = sum(unit != SLICE for unit in owned_units) + 2
    def metadata_timeout():
        nonlocal admission_slots
        value = phase_timeout(admission_end, .75, admission_slots)
        admission_slots = max(0, admission_slots - 1)
        return value
    def attempt(work):
        try:
            return work()
        except BaseException as error:
            errors.append(error)
            return None
    for unit, expected in owned_units.items():
        def admit(unit=unit, expected=expected):
            path = pathlib.Path('/etc/systemd/system', unit)
            info = path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                    and (info.st_dev, info.st_ino) == expected,
                    'Owned unit changed; preserve uncertain runtime for diagnosis')
            if unit != SLICE:
                actual = props(unit, timeout=metadata_timeout())
                invocation = actual.get('InvocationID', '')
                if invocation:
                    require(managed_runtime_module is not None, 'Native runtime owner missing')
                    managed_runtime_module.require_owned_invocation(actual, owned_invocations.get(unit), require)
                else:
                    require(actual.get('MainPID') == actual.get('ControlPID') == '0'
                            and actual.get('ActiveState') in ('inactive', 'failed'), 'Unowned native service remains')
            safe.append(unit)
        attempt(admit)
    def browser_admit():
        transient = props(BROWSER, timeout=metadata_timeout())
        if transient.get('LoadState') == 'not-found':
            return
        actual = systemctl('show', BROWSER, '--property=Description,Transient', timeout=metadata_timeout()).stdout.decode()
        require('Transient=yes\n' in actual and 'Description=Owned actual Next browser ' + report['runId'] + '\n' in actual,
                'Unexpected browser transient unit; preserve uncertain runtime')
        require(managed_runtime_module is not None, 'Native runtime owner missing')
        managed_runtime_module.require_owned_invocation(transient, owned_invocations.get(BROWSER), require)
        safe.append(BROWSER)
    attempt(browser_admit)
    # Enqueue ALL independently admitted service stops before awaiting any one.
    # A foreign slice occupant cannot be killed through stop(slice).
    services = [unit for unit in [BROWSER, *reversed(UNITS), PROXY] if unit in safe]
    for index, unit in enumerate(services):
        attempt(lambda unit=unit, slots=len(services)-index: systemctl('stop', '--no-block', unit,
            timeout=phase_timeout(queue_end, .5, slots)))
    pending = set(services)
    while pending and time.monotonic() < min(DEADLINE, settlement_end):
        for unit in list(pending):
            try:
                require_stopped(unit, props(unit, timeout=phase_timeout(settlement_end, .25, len(pending))))
                pending.remove(unit)
            except AssertionError:
                pass
            except BaseException as error:
                errors.append(error)
                pending.remove(unit)
        if pending:
            time.sleep(max(0, min(0.025, min(DEADLINE, settlement_end) - time.monotonic())))
    if pending:
        errors.append(AssertionError('Owned runtime family did not settle within cleanup deadline'))
    if SLICE in safe:
        def stop_empty_slice():
            # cgroup absence/emptiness is checked BEFORE stop, so a newly arrived
            # foreign child service remains untouched and keeps package custody.
            actual = props(SLICE, timeout=phase_timeout(started + 18, .5))
            require(actual.get('MainPID', '0') == actual.get('ControlPID', '0') == '0', 'Native slice process identity differs')
            group = actual.get('ControlGroup', '')
            require(group == FIXTURE_CGROUP or not group, 'Native slice cgroup differs')
            if group:
                directory = pathlib.Path('/sys/fs/cgroup' + group)
                if directory.exists():
                    require(not directory.is_symlink(), 'Native slice cgroup is a link')
                    with os.scandir(directory) as entries:
                        child = any(entry.is_dir(follow_symlinks=False) for entry in entries)
                    require(not (directory / 'cgroup.procs').read_text().strip() and not child,
                            'Foreign native slice occupant; preserve runtime')
            systemctl('stop', SLICE, timeout=phase_timeout(started + 18, 2))
            require_stopped(SLICE, props(SLICE, timeout=phase_timeout(started + 18, .5)))
        attempt(stop_empty_slice)
    # Reap the exact launcher owned by Popen, never a reconstructed numeric PID.
    if browser is not None:
        def launcher_settle():
            if browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=left(1))
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait(timeout=left(1))
            require(browser.poll() is not None, 'Owned browser launcher remains live')
        attempt(launcher_settle)
    def no_host_mounts():
        # Same-filesystem bind mounts are not detected by st_dev alone. A fixed
        # bounded host observation must exclude them BEFORE any path disposal.
        owner = managed_runtime_module
        if owner is None:
            module = pathlib.Path('/usr/local/lib/aihr-admission/next_profile.py')
            require(module.exists(), 'Protected mount observation owner unavailable')
            raw = observer_read(module, 1024 * 1024)
            expected = report.get('sealedHelpers', {}).get('next_profile.py', {}).get('sha256')
            require(isinstance(expected, str) and hashlib.sha256(raw).hexdigest() == expected,
                    'Protected cleanup observer source differs')
            owner = types.ModuleType('owned_cleanup_mount_observer')
            owner.__file__ = str(module)
            exec(compile(raw, str(module), 'exec'), owner.__dict__)
        proc = os.open('/proc/self', os.O_RDONLY | os.O_DIRECTORY)
        try:
            mounts = owner.parse_mountinfo(owner.read_proc(proc, 'mountinfo', 4 * 1024 * 1024, require), require)
        finally:
            os.close(proc)
        require(not any(row['target'] == root or row['target'].startswith(root + '/')
                        for root in owned_paths for row in mounts), 'Foreign host mount; preserve fixture paths')
    attempt(no_host_mounts)
    if errors:
        raise BaseExceptionGroup('Owned native stop/absence refused; preserve all fixture paths', errors)
    for unit in safe:
        systemctl('reset-failed', unit, check=False, timeout=1)
        if unit in owned_units:
            path = pathlib.Path('/etc/systemd/system', unit)
            info = path.lstat()
            require((info.st_dev, info.st_ino) == owned_units[unit] and info.st_uid == 0,
                    'Owned unit changed before disposal')
            path.unlink()
    if owned_units:
        require(postgres_scope is not None, 'Owned PostgreSQL reload guard absent')
        postgres_scope.snapshot('before-cleanup-reload')
        systemctl('daemon-reload', timeout=2)
        postgres_scope.snapshot('after-cleanup-reload')
    def remove_tree(path, expected):
        info = os.lstat(path)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and (info.st_dev, info.st_ino) == expected, 'Owned fixture directory changed')
        root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        count = 0
        def walk(fd, depth):
            nonlocal count
            require(depth <= 128, 'Owned cleanup depth exceeds bound')
            with os.scandir(fd) as entries:
                for entry in entries:
                    left();count += 1
                    require(count <= 500000, 'Owned cleanup member count exceeds bound')
                    before = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    require(before.st_dev == info.st_dev, 'Unexpected cleanup mount; preserve runtime')
                    if stat.S_ISDIR(before.st_mode):
                        child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        try:
                            held = os.fstat(child)
                            require((held.st_dev, held.st_ino) == (before.st_dev, before.st_ino), 'Cleanup directory changed')
                            walk(child, depth + 1)
                            after = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                            require((after.st_dev, after.st_ino) == (held.st_dev, held.st_ino), 'Cleanup directory replaced')
                        finally:
                            os.close(child)
                        os.rmdir(entry.name, dir_fd=fd)
                    else:
                        os.unlink(entry.name, dir_fd=fd)  # unlink links; never follow them
        try:
            held = os.fstat(root)
            require((held.st_dev, held.st_ino) == expected, 'Cleanup root changed')
            walk(root, 0)
        finally:
            os.close(root)
        left();after = os.lstat(path)
        require((after.st_dev, after.st_ino) == expected, 'Cleanup root replaced')
        os.rmdir(path)
    for name in reversed(ROOTS):
        if name in owned_paths:
            remove_tree(name, owned_paths[name])
    if created_home:
        left();home = pathlib.Path('/var/empty/aihr');info = home.lstat()
        require((info.st_dev, info.st_ino) == owned_paths[str(home)] and info.st_uid == 0, 'Owned empty home changed')
        home.rmdir()
    if created_empty_parent is not None:
        left();parent = pathlib.Path('/var/empty');info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and (info.st_dev, info.st_ino) == created_empty_parent, 'Owned empty-home parent changed')
        parent.rmdir()


# Read-only failure diagnostics. These observations cannot grant admission,
# replace a product predicate, establish cleanup or change an original outcome.
RUNTIME_DIAGNOSTIC_UNITS = {unit: label for unit, label in zip(
    [*UNITS, PROXY, BROWSER, SLICE], ['worker-1', 'worker-2', 'proxy', 'browser', 'slice'])}
RUNTIME_STATE_KEYS = frozenset({'Id', 'LoadState', 'ActiveState', 'SubState', 'InvocationID',
    'MainPID', 'ControlPID', 'Result', 'ExecMainCode', 'ExecMainStatus'})
RUNTIME_DIAGNOSTIC_MAX = 131072
RUNTIME_PHASES = frozenset({'actual-browser-start-first', 'actual-browser-start-second-cold',
    'actual-browser-admit-second', 'actual-browser-browser-core-finished',
    'actual-browser-two-worker-boot', 'drain-stop-and-actual-bind-reclamation'})


def runtime_command_label(arguments):
    if not isinstance(arguments, list) or arguments[:2] != ['/usr/bin/systemctl', '--system']:
        return None
    tail = arguments[2:]
    if tail == ['daemon-reload']:
        return 'manager-reload'
    for unit, label in RUNTIME_DIAGNOSTIC_UNITS.items():
        for verb in ('start', 'stop', 'reset-failed'):
            if tail == [verb, unit] or tail == [verb, '--no-block', unit]:
                return verb + '-' + label
        if tail == ['show', unit, '--property=LoadState,InvocationID,MainPID,ControlPID,ActiveState,SubState,ExecStart,ExecReload,FragmentPath,ControlGroup']:
            return 'properties-' + label
    if tail == ['show', BROWSER, '--property=Description,Transient']:
        return 'browser-owner-check'
    return None


def runtime_command_observation(arguments, result=None, error=None):
    # No caller label, argument, stderr, private command output or exception text.
    label = runtime_command_label(arguments)
    if label is None:
        return
    values = report.setdefault('runtimeCommands', [])
    if len(values) >= 32:
        report['runtimeCommandsComplete'] = False
        return
    code = getattr(result, 'returncode', None)
    values.append({'command': label, 'returnCode': code if type(code) is int and -255 <= code <= 255 else None,
                   'outcome': 'timeout' if isinstance(error, subprocess.TimeoutExpired)
                       else 'exception' if error is not None else 'returned'})


def runtime_catalog(sources, fixture_path):
    paths = dict(OBSERVER_PATHS, fixture=fixture_path)
    require(isinstance(sources, dict) and set(sources) == set(paths), 'Closed diagnostic sources required')
    result, reasons = {}, {}
    for owner, filename in paths.items():
        raw = sources[owner]
        require(isinstance(raw, bytes) and 0 < len(raw) <= 1024**2, 'Bounded diagnostic source required')
        tree = ast.parse(raw, filename)
        calls, guards = set(), set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            calls.update(range(node.lineno, node.end_lineno + 1))
            if (isinstance(node.func, ast.Name) and node.func.id in ('require', 'check')
                    or isinstance(node.func, ast.Attribute) and node.func.attr in ('require', 'check')):
                guards.update(range(node.lineno, node.end_lineno + 1))
                if (owner != 'fixture' and len(node.args) == 2
                        and isinstance(node.args[1], ast.Constant) and type(node.args[1].value) is str
                        and 0 < len(node.args[1].value.encode()) <= 1024):
                    reasons.setdefault('Admission refused: ' + node.args[1].value, []).append(
                        {'owner': owner, 'line': node.lineno})
        code, codes = compile(raw, filename, 'exec', dont_inherit=True), set()
        def gather(value):
            codes.add(observer_code_identity(value))
            for item in value.co_consts:
                if isinstance(item, types.CodeType):
                    gather(item)
        gather(code)
        result[owner] = {'path': filename, 'codes': frozenset(codes),
                         'calls': frozenset(calls), 'guards': frozenset(guards)}
    return result, reasons


def runtime_exception_observation(error, catalog):
    frames, current, count = [], error.__traceback__, 0
    while current is not None:
        count += 1
        if count > 32:
            return {'classification': 'stack-bound-exceeded'}
        frame = current.tb_frame
        for owner, source in catalog.items():
            if (frame.f_code.co_filename == source['path'] and frame.f_globals.get('__file__') == source['path']
                    and current.tb_lineno in source['calls']
                    and observer_code_identity(frame.f_code) in source['codes']):
                frames.append({'owner': owner, 'line': current.tb_lineno,
                               'kind': 'guard' if current.tb_lineno in source['guards'] else 'call'})
        current = current.tb_next
    name = type(error).__name__
    return {'classification': 'sealed-source-exception' if frames else 'unmatched-source-exception',
            'exception': name if name in OBSERVER_EXCEPTIONS | {'TimeoutExpired', 'CalledProcessError',
                'SystemExit', 'KeyboardInterrupt'} else 'unknown', 'frames': frames}


def runtime_state_observation(raw):
    require(isinstance(raw, bytes) and len(raw) <= RUNTIME_DIAGNOSTIC_MAX, 'Diagnostic state bound refused')
    rows = {}
    for block in raw.decode('utf8').strip().split('\n\n'):
        values = {}
        for line in block.splitlines():
            key, separator, value = line.partition('=')
            require(separator and key in RUNTIME_STATE_KEYS and key not in values,
                    'Closed diagnostic state fields required')
            values[key] = value
        unit = values.get('Id')
        require(unit in RUNTIME_DIAGNOSTIC_UNITS and unit not in rows, 'Closed diagnostic unit required')
        require({'Id', 'LoadState', 'ActiveState', 'SubState', 'InvocationID'} <= set(values),
                'Complete diagnostic state identity required')
        rows[unit] = values
    require(set(rows) == set(RUNTIME_DIAGNOSTIC_UNITS), 'Complete fixed unit snapshot required')
    result, invocations = [], {}
    known = {'LoadState': {'loaded', 'not-found', 'masked', 'error', 'bad-setting', 'merged', 'stub'},
        'ActiveState': {'active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing'},
        'SubState': {'dead', 'running', 'start-pre', 'start', 'start-post', 'stop', 'stop-sigterm', 'stop-sigkill',
            'stop-post', 'failed', 'exited', 'waiting', 'auto-restart', 'condition', 'listening'},
        'Result': {'success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog',
            'start-limit-hit', 'oom-kill', 'protocol', 'exec-condition', 'dependency'}}
    for unit, label in RUNTIME_DIAGNOSTIC_UNITS.items():
        values = rows[unit]
        public = {'unit': label}
        for key, allowed in known.items():
            public[key] = values.get(key) if values.get(key) in allowed else 'unknown'
        for key in ('ExecMainCode', 'ExecMainStatus'):
            value = values.get(key, '')
            public[key] = int(value) if re.fullmatch(r'[0-9]{1,3}', value) and int(value) <= 255 else None
        invocation = values['InvocationID']
        public['hasInvocation'] = re.fullmatch(r'[a-f0-9]{32}', invocation) is not None
        if unit in UNITS and public['hasInvocation']:
            invocations[unit] = invocation
        result.append(public)
    return result, invocations


def runtime_journal_observation(raw, unit, invocation, python_exe, reasons):
    require(unit in UNITS and re.fullmatch(r'[a-f0-9]{32}', invocation)
            and isinstance(python_exe, str) and python_exe.startswith('/usr/bin/'), 'Closed journal identity required')
    require(isinstance(raw, bytes) and len(raw) <= RUNTIME_DIAGNOSTIC_MAX, 'Diagnostic journal bound refused')
    records, trusted, refusals, exceptions = 0, 0, [], []
    commands = {prefix + ' -I -B ' + OBSERVER_PATHS['controller'] + ' ' + operation + ' ' + unit
                for prefix in ('/usr/bin/python3', python_exe) for operation in ('reserve', 'admit', 'cleanup')}
    for line in raw.splitlines():
        records += 1
        require(records <= 64, 'Diagnostic journal record bound refused')
        row = json.loads(line)
        if not (isinstance(row, dict) and row.get('_UID') == '0' and row.get('_EXE') == python_exe
                and row.get('_SYSTEMD_UNIT') == unit and row.get('_SYSTEMD_INVOCATION_ID') == invocation
                and type(row.get('_CMDLINE')) is str and row['_CMDLINE'] in commands):
            continue
        trusted += 1
        message = row.get('MESSAGE')
        if type(message) is not str:
            continue
        if message in reasons:
            sites = reasons[message]
            require(len(sites) <= 16, 'Ambiguous literal diagnostic exceeds bound')
            refusals.append({'classification': 'sealed-literal-refusal', 'sites': sites})
        else:
            for name in OBSERVER_EXCEPTIONS:
                if message == 'Admission failed: ' + name + '; reconcile before retry':
                    exceptions.append(name)
                    break
    return {'unit': RUNTIME_DIAGNOSTIC_UNITS[unit], 'records': records, 'trustedControllerRecords': trusted,
            'literalRefusals': refusals, 'closedExceptions': exceptions}



def runtime_environment_journal_observation(raw, unit, invocation, python_exe, sources, binding):
    """Separate closed helper branch; controller message matching is unchanged."""
    require(unit in UNITS and re.fullmatch(r'[a-f0-9]{32}', invocation)
            and isinstance(python_exe, str) and python_exe.startswith('/usr/bin/'), 'Closed environment journal identity required')
    require(isinstance(raw, bytes) and len(raw) <= RUNTIME_DIAGNOSTIC_MAX, 'Environment journal bound refused')
    require(type(sources) is dict and set(sources) == {'next-profile', 'poststart'}, 'Closed environment observer sources required')
    for owner, name in (('next-profile', 'next_profile.py'), ('poststart', 'next_fixture_poststart.py')):
        require(isinstance(sources[owner], bytes) and 0 < len(sources[owner]) <= 1024**2
                and hashlib.sha256(sources[owner]).hexdigest() == binding['helpers'][name]['sha256'],
                'Environment observer source identity differs')
    N = types.ModuleType('sealed_environment_journal_receiver')
    N.__file__ = OBSERVER_PATHS['next-profile']
    exec(compile(sources['next-profile'], N.__file__, 'exec', dont_inherit=True), N.__dict__)
    commands = {prefix + ' -I -B /usr/local/lib/aihr-admission/next_fixture_poststart.py ' + unit
                for prefix in ('/usr/bin/python3', python_exe)}
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate environment journal field')
            value[key] = item
        return value
    result = []
    lines = raw.splitlines()
    require(len(lines) <= 64, 'Environment journal record bound refused')
    for line in lines:
        row = json.loads(line, object_pairs_hook=unique)
        if not (type(row) is dict and row.get('_UID') == '0' and row.get('_EXE') == python_exe
                and row.get('_SYSTEMD_UNIT') == unit and row.get('_SYSTEMD_INVOCATION_ID') == invocation
                and type(row.get('_CMDLINE')) is str and row['_CMDLINE'] in commands):
            continue
        message = row.get('MESSAGE')
        if type(message) is not str or not message.startswith(N.ENVIRONMENT_OBSERVATION_PREFIX):
            continue
        require(len(message.encode()) <= 4096, 'Environment journal message bound refused')
        value = json.loads(message[len(N.ENVIRONMENT_OBSERVATION_PREFIX):], object_pairs_hook=unique)
        result.append(N.validate_environment_observation(value, RUNTIME_DIAGNOSTIC_UNITS[unit]))
        require(len(result) == 1, 'Duplicate environment observer record refused')
    return result


def runtime_environment_journal_diagnostic(raw, unit, invocation, python_exe, sources, binding):
    """New phase failure cannot discard an original validated environment observation."""
    observed = runtime_environment_journal_observation(raw, unit, invocation, python_exe, sources, binding)
    try:
        return _runtime_environment_phase_diagnostic(raw, unit, invocation, python_exe, sources, observed)
    except BaseException:
        return {'observations': observed, 'diagnostic': {'kind': 'CLOSED_OBSERVER_PHASE_DIAGNOSTIC_NOT_ENVIRONMENT_OR_ADMISSION',
            'unit': RUNTIME_DIAGNOSTIC_UNITS[unit], 'state': 'receiver-unavailable', 'phases': [],
            'census': None, 'phaseUnavailable': True, 'keyNameDiagnostic': {
                'kind': 'KEY_NAME_HASHES_NOT_ENVIRONMENT_OR_ADMISSION', 'state': 'unavailable',
                'helperCompletion': 'unavailable', 'count': None, 'digests': [], 'reason': 'phase-unavailable'}, 'plainKeyNameDiagnostic': {
                'kind': 'PLAIN_OTHER_KEY_NAMES_NOT_ENVIRONMENT_OR_ADMISSION', 'state': 'unavailable',
                'helperCompletion': 'unavailable', 'count': None, 'names': [], 'reason': 'phase-unavailable'}}}


def _runtime_environment_phase_diagnostic(raw, unit, invocation, python_exe, sources, observed):
    # Original source and outer JSON/duplicate/transport checks have completed.
    P = types.ModuleType('sealed_observer_phase_receiver')
    P.__file__ = '/usr/local/lib/aihr-admission/next_fixture_poststart.py'
    N = types.ModuleType('sealed_observer_prefix_owner')
    N.__file__ = OBSERVER_PATHS['next-profile']
    exec(compile(sources['poststart'], P.__file__, 'exec', dont_inherit=True), P.__dict__)
    exec(compile(sources['next-profile'], N.__file__, 'exec', dont_inherit=True), N.__dict__)
    commands = {prefix + ' -I -B /usr/local/lib/aihr-admission/next_fixture_poststart.py ' + unit
                for prefix in ('/usr/bin/python3', python_exe)}
    controllers = {prefix + ' -I -B /usr/local/lib/aihr-admission/controller.py admit ' + unit
                   for prefix in ('/usr/bin/python3', python_exe)}
    census = {'kind': 'UNTRUSTED_PREFIX_TRANSPORT_COUNTS_NOT_HELPER_OR_ENVIRONMENT_PROOF',
        'records': 0, 'environmentCandidates': 0, 'phaseCandidates': 0, 'trustedHelperCandidates': 0,
        'metadataMatches': dict.fromkeys(('uid', 'executable', 'unit', 'invocation'), 0),
        'commandClasses': dict.fromkeys(('helper', 'controller', 'other-or-missing'), 0)}
    phases, unavailable, key_names, plain_names = [], False, None, None
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate observer phase field')
            value[key] = item
        return value
    for line in raw.splitlines():
        row = json.loads(line);census['records'] += 1
        message = row.get('MESSAGE') if type(row) is dict else None
        if type(message) is not str:
            continue
        plain_terminal = message.startswith(P.PLAIN_TERMINAL_PREFIX)
        terminal = message.startswith(P.TERMINAL_PREFIX) or plain_terminal
        phase = message.startswith(P.PHASE_PREFIX) or terminal
        environment = message.startswith(N.ENVIRONMENT_OBSERVATION_PREFIX)
        if not (phase or environment):
            continue
        census['phaseCandidates' if phase else 'environmentCandidates'] += 1
        matches = {'uid': row.get('_UID') == '0', 'executable': row.get('_EXE') == python_exe,
            'unit': row.get('_SYSTEMD_UNIT') == unit, 'invocation': row.get('_SYSTEMD_INVOCATION_ID') == invocation}
        for key, matched in matches.items():
            census['metadataMatches'][key] += int(matched)
        command = row.get('_CMDLINE')
        classification = 'helper' if type(command) is str and command in commands else \
            'controller' if type(command) is str and command in controllers else 'other-or-missing'
        census['commandClasses'][classification] += 1
        trusted = all(matches.values()) and classification == 'helper'
        if trusted:
            census['trustedHelperCandidates'] += 1
        if not phase or not trusted:
            continue
        try:
            require(len(message.encode()) <= 1024, 'Observer phase message bound refused')
            candidate_keys, candidate_plain = None, None
            if plain_terminal:
                envelope = P.validate_plain_terminal_observation(json.loads(message[len(P.PLAIN_TERMINAL_PREFIX):], object_pairs_hook=unique),
                    RUNTIME_DIAGNOSTIC_UNITS[unit], N.validate_key_name_digests, N.validate_plain_key_names)
                value, candidate_keys = envelope['phase'], envelope['keyNames']
                candidate_plain = {key: envelope[key] for key in ('namesComplete', 'names')}
            elif terminal:
                envelope = P.validate_terminal_observation(json.loads(message[len(P.TERMINAL_PREFIX):], object_pairs_hook=unique),
                    RUNTIME_DIAGNOSTIC_UNITS[unit], N.validate_key_name_digests)
                value, candidate_keys = envelope['phase'], envelope['keyNames']
            else:
                value = P.validate_phase_observation(json.loads(message[len(P.PHASE_PREFIX):], object_pairs_hook=unique), RUNTIME_DIAGNOSTIC_UNITS[unit])
            # Full-helper ledger starts at timer-armed. Host hook subsequences do
            # not become full-helper execution evidence through this receiver.
            require(not phases or phases[-1]['result'] == 'entered', 'Observer phase after terminal')
            require(value['sequence'] == len(phases) and len(phases) < 14, 'Observer phase sequence refused')
            if value['result'] != 'entered':
                require(phases and value['phase'] == phases[-1]['phase'], 'Observer terminal phase differs')
            phases.append(value)
            if terminal:
                key_names, plain_names = candidate_keys, candidate_plain
        except BaseException:
            unavailable = True
    # Never publish a partial accepted ledger after a malformed/duplicate/foreign
    # transition. Census remains explicitly untrusted; valid original observations survive.
    if key_names is not None and len(phases) == 14 and phases[-1]['result'] == 'finished' and len(observed) == 1:
        try:
            N.validate_key_name_digests(key_names, observed[0]['otherUnqualifiedCount'])
            if plain_names is not None:
                N.validate_plain_key_names(plain_names, key_names)
        except (ValueError, TypeError):
            unavailable = True
    if unavailable:
        phases, key_names, plain_names = [], None, None
    helper_finished = len(phases) == 14 and phases[-1]['result'] == 'finished'
    count = observed[0]['otherUnqualifiedCount'] if len(observed) == 1 else None
    key_diagnostic = {'kind': 'KEY_NAME_HASHES_NOT_ENVIRONMENT_OR_ADMISSION',
        'state': 'helper-not-finished', 'helperCompletion': 'not-finished', 'count': count,
        'digests': [], 'reason': 'helper-not-finished'}
    if unavailable:
        key_diagnostic.update(state='unavailable', helperCompletion='unavailable', reason='phase-unavailable')
    elif helper_finished:
        key_diagnostic.update(state='unavailable', helperCompletion='finished',
            reason='environment-observation-missing' if len(observed) != 1 else 'terminal-v2-absent')
        if len(observed) == 1 and key_names is not None:
            key_diagnostic.update(state=key_names['state'], digests=list(key_names['digests']), reason=key_names['reason'])
    plain_diagnostic = {'kind': 'PLAIN_OTHER_KEY_NAMES_NOT_ENVIRONMENT_OR_ADMISSION',
        'state': 'helper-not-finished', 'helperCompletion': 'not-finished', 'count': count,
        'names': [], 'reason': 'helper-not-finished'}
    if unavailable:
        plain_diagnostic.update(state='unavailable', helperCompletion='unavailable', reason='phase-unavailable')
    elif helper_finished:
        plain_diagnostic.update(state='unavailable', helperCompletion='finished',
            reason='environment-observation-missing' if len(observed) != 1 else 'terminal-v3-absent')
        if len(observed) == 1 and plain_names is not None:
            plain_diagnostic.update(state='complete' if plain_names['namesComplete'] else 'unavailable',
                names=list(plain_names['names']), reason='none' if plain_names['namesComplete'] else 'plain-unavailable')
    state = 'environment-observed' if observed else 'phase-only' if phases else \
        'untrusted-candidates-only' if census['environmentCandidates'] + census['phaseCandidates'] else 'no-candidates'
    if unavailable:
        state = 'receiver-unavailable'
    return {'observations': observed, 'diagnostic': {'kind': 'CLOSED_OBSERVER_PHASE_DIAGNOSTIC_NOT_ENVIRONMENT_OR_ADMISSION',
        'unit': RUNTIME_DIAGNOSTIC_UNITS[unit], 'state': state, 'phases': phases, 'census': census,
        'phaseUnavailable': unavailable, 'keyNameDiagnostic': key_diagnostic,
        'plainKeyNameDiagnostic': plain_diagnostic}}


def runtime_owned_declaration(unit):
    """Positive ownership only from this fixture's captured native declaration."""
    require(unit in RUNTIME_DIAGNOSTIC_UNITS, 'Closed diagnostic owned unit required')
    expected = owned_units.get(unit)
    if expected is None:
        return False
    info = pathlib.Path('/etc/systemd/system', unit).lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and (info.st_dev, info.st_ino) == expected, 'Diagnostic unit ownership differs')
    return True


def runtime_diagnostic_read(arguments, deadline):
    """Bound both pipe bytes and process lifetime; raw output is never evidence."""
    require(time.monotonic() < deadline - 0.05, 'Diagnostic budget unavailable')
    child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=SAFE_ENV)
    selector, raw, stopped, result = None, bytearray(), False, None
    try:
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline - 0.05:
            events = selector.select(max(0, deadline - 0.05 - time.monotonic()))
            if not events:
                break
            block = os.read(child.stdout.fileno(), 65537)
            if not block:
                result = child.wait(timeout=max(0.001, deadline - time.monotonic()))
                stopped = True
                return result, bytes(raw)
            raw.extend(block)
            require(len(raw) <= RUNTIME_DIAGNOSTIC_MAX, 'Diagnostic raw pipe bound refused')
        raise TimeoutError('Diagnostic budget exhausted')
    finally:
        cleanup_errors = False
        try:
            if selector is not None:
                selector.close()
        except BaseException:
            cleanup_errors = True
        if not stopped:
            try:
                child.kill()
            except BaseException:
                cleanup_errors = True
            try:
                child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except BaseException:
                report['diagnosticChildrenSettled'] = False
                cleanup_errors = True
        try:
            child.stdout.close()
        except BaseException:
            cleanup_errors = True
        if cleanup_errors:
            raise RuntimeError('Bounded diagnostic transport cleanup refused') from None


def runtime_failure_diagnostic(kind, error, binding):
    # Every failure, including unavailable time/source/IO, is observational only.
    # The original exception is always rethrown by the caller; cleanup is separate.
    if type(kind) is not str or kind not in ('primary', 'cleanup'):
        return
    current_phase = report.get('currentPhase')
    value = {'classification': 'unavailable', 'reason': 'budget-or-source-or-io-unavailable',
             'phase': current_phase if type(current_phase) is str and current_phase in RUNTIME_PHASES else 'other-native-phase'}
    report.setdefault('runtimeFailureDiagnostics', {})[kind] = value
    deadline = min(DEADLINE, time.monotonic() + 2)
    try:
        require(time.monotonic() < deadline - 0.05, 'Diagnostic budget unavailable')
        own_path = str(pathlib.Path(__file__).absolute())
        sources = {'fixture': observer_read(own_path, 1024**2)}
        require(hashlib.sha256(sources['fixture']).hexdigest() == binding['helpers']['test_next_native.py']['sha256'],
                'Diagnostic fixture identity differs')
        for owner, path in OBSERVER_PATHS.items():
            require(time.monotonic() < deadline - 0.05, 'Diagnostic budget unavailable')
            sources[owner] = observer_read(path, 1024**2)
            require(hashlib.sha256(sources[owner]).hexdigest() == binding['helpers'][pathlib.Path(path).name]['sha256'],
                    'Diagnostic installed source identity differs')
        catalog, reasons = runtime_catalog(sources, own_path)
        value['exception'] = runtime_exception_observation(error, catalog)
        for unit in owned_units:
            require(runtime_owned_declaration(unit), 'Captured diagnostic declaration required')
        require(time.monotonic() < deadline - 0.05, 'Diagnostic budget unavailable')
        code, raw = runtime_diagnostic_read(['/usr/bin/systemctl', '--system', 'show', '--all', '--no-pager',
            '--property=' + ','.join(sorted(RUNTIME_STATE_KEYS)), *RUNTIME_DIAGNOSTIC_UNITS], deadline)
        value['stateCommandReturnCode'] = code
        states, invocations = runtime_state_observation(raw)
        value['states'] = states
        value['statesScope'] = 'fixed-unit-snapshot-not-ownership'
        python_path = pathlib.Path('/usr/bin/python3').resolve(strict=True)
        require(str(python_path).startswith('/usr/bin/'), 'Diagnostic Python identity differs')
        current = pathlib.Path('/')
        for part in python_path.parts[1:]:
            current /= part
            python_info = current.lstat()
            require(python_info.st_uid == 0 and not stat.S_ISLNK(python_info.st_mode)
                    and not python_info.st_mode & 0o022, 'Diagnostic Python ancestor differs')
        require(stat.S_ISREG(python_info.st_mode), 'Diagnostic Python identity differs')
        journals, unavailable = [], []
        for unit in UNITS:
            # A same-named current invocation is not proof that this fixture
            # owns it. Never read an unowned worker's journal, even when its
            # native identity or message would match the fixed source catalog.
            if not runtime_owned_declaration(unit):
                unavailable.append({'unit': RUNTIME_DIAGNOSTIC_UNITS[unit], 'reason': 'unowned-declaration'})
                continue
            if unit not in invocations:
                unavailable.append({'unit': RUNTIME_DIAGNOSTIC_UNITS[unit], 'reason': 'no-current-invocation'})
                continue
            # Read no previous or foreign invocation. journald's trusted UID/exe/
            # unit/invocation/argv fields are revalidated before literal matching.
            code, raw = runtime_diagnostic_read(['/usr/bin/journalctl', '--system', '--no-pager', '--quiet',
                '--output=json', '--output-fields=_UID,_EXE,_CMDLINE,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,MESSAGE',
                '--lines=64', '_SYSTEMD_UNIT=' + unit, '_SYSTEMD_INVOCATION_ID=' + invocations[unit]], deadline)
            require(code == 0, 'Diagnostic journal read refused')
            require(runtime_owned_declaration(unit), 'Diagnostic journal ownership changed')
            journals.append(runtime_journal_observation(raw, unit, invocations[unit], str(python_path), reasons))
            # Optional helper observation has independent source/schema custody;
            # its failure cannot discard original controller literal diagnostics.
            try:
                require(time.monotonic() < deadline - 0.05, 'Environment diagnostic budget unavailable')
                poststart = observer_read('/usr/local/lib/aihr-admission/next_fixture_poststart.py', 1024**2)
                diagnostic = runtime_environment_journal_diagnostic(raw, unit, invocations[unit], str(python_path),
                    {'next-profile': sources['next-profile'], 'poststart': poststart}, binding)
                require(runtime_owned_declaration(unit), 'Environment diagnostic declaration changed')
                value.setdefault('environmentObservations', []).extend(diagnostic['observations'])
                value.setdefault('environmentObserverDiagnostics', []).append(diagnostic['diagnostic'])
            except BaseException:
                value['environmentObservationUnavailable'] = True
        require(time.monotonic() <= deadline, 'Diagnostic aggregate budget exhausted')
        value.update({'classification': 'bounded-sealed-source-observations', 'journals': journals,
                      'unavailableWorkerJournals': unavailable})
    except BaseException:
        # Never publish exception messages, command arguments or unknown native
        # values. Already verified source locations remain useful if IO refuses.
        value['incomplete'] = True


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
    primary_failure = None
    postgres_scope = None
    try:
        postgres_scope = OwnedPostgresScope(plan)
        fixture_directories()
        install_helpers(helper, plan, binding)
        N, release, runtime_package = package(plan, helper, binding)
        C = configure(plan, binding, N, release, runtime_package, postgres_scope)
        browser_core(plan, binding, C)
        release_workers(C)
        succeeded = True
    except BaseException as error:
        primary_failure = error
        report['failureType'] = type(error).__name__
        runtime_failure_diagnostic('primary', error, binding)
        report['complete'] = False
        save()
        raise
    finally:
        DEADLINE = TOTAL_DEADLINE
        try:
            cleanup(postgres_scope)
            if postgres_scope is not None:
                postgres_scope.snapshot('final')
            report['ownedRuntimeCleaned'] = True
        except BaseException as error:
            runtime_failure_diagnostic('cleanup', error, binding)
            report['ownedRuntimeCleaned'] = False
            report['complete'] = False
            save()
            if primary_failure is not None:
                raise BaseExceptionGroup('Native Next operation and owned cleanup both refused', [primary_failure, error])
            raise
        report['complete'] = succeeded
        save()
        if evidence_fd is not None:
            os.close(evidence_fd)


if __name__ == '__main__':
    if sys.argv[1:] == ['--observe-check-only']:
        try:
            observer_code = observer_entry()
        except BaseException:
            sys.stderr.write(json.dumps({'version': 1, 'kind': 'SOURCE_BOUND_CHECKONLY_REFUSAL',
                'classification': 'binding-refusal', 'stage': observer_binding_stage if isinstance(observer_binding_stage, str) and observer_binding_stage in OBSERVER_BINDING_STAGES else 'entry'}, sort_keys=True) + '\n')
            observer_code = 1
        sys.exit(observer_code)
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
