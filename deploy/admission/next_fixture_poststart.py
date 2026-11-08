"""Fixed disposable-fixture gate; production controller admission remains authoritative."""
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import sys
import time
import types

HELPER = pathlib.Path('/usr/local/lib/aihr-admission')
CONTEXT = pathlib.Path('/etc/aihr-admission/observation.json')
PROFILE = pathlib.Path('/etc/aihr-admission/profile.json')


# Diagnostic states only. None establishes source/process/environment/admission authority.
PHASE_PREFIX = 'AIHR_OWNED_ENV_OBSERVER_PHASE_V1 '
TERMINAL_PREFIX = 'AIHR_OWNED_ENV_OBSERVER_TERMINAL_V2 '
PLAIN_TERMINAL_PREFIX = 'AIHR_OWNED_ENV_OBSERVER_TERMINAL_V3 '
PHASES = ('timer-armed', 'context-read', 'profile-bound', 'helpers-bound',
    'observer-loaded', 'main-selector', 'declaration-before', 'process-before',
    'environment-read', 'environment-classified', 'process-after', 'custody-after',
    'environment-packet')


def validate_phase_observation(value, subject):
    if (type(value) is not dict or set(value) != {'version', 'kind', 'subject', 'sequence', 'phase', 'result', 'cause'}
            or type(value['version']) is not int or value['version'] != 1
            or value['kind'] != 'OWNED_OBSERVER_PHASE_NOT_ENVIRONMENT_OR_ADMISSION'
            or subject not in ('worker-1', 'worker-2') or value['subject'] != subject
            or type(value['sequence']) is not int or value['phase'] not in PHASES
            or value['result'] not in ('entered', 'failed', 'finished')
            or value['cause'] not in ('none', 'refused', 'budget', 'io', 'other')):
        raise ValueError('Closed observer phase required')
    index = PHASES.index(value['phase'])
    if (value['result'] == 'entered' and (value['sequence'] != index or value['cause'] != 'none')
            or value['result'] == 'failed' and (value['sequence'] != index + 1 or value['cause'] == 'none')
            or value['result'] == 'finished' and (index != len(PHASES) - 1
                or value['sequence'] != len(PHASES) or value['cause'] != 'none')):
        raise ValueError('Observer phase transition refused')
    return value


def validate_terminal_observation(value, subject, validate_keys):
    # The fixed caller supplies the codec from its independently source-sealed
    # next_profile owner. This pure envelope grants no native/provenance authority.
    if (type(value) is not dict or set(value) != {'version', 'kind', 'phase', 'keyNames'}
            or type(value['version']) is not int or value['version'] != 2
            or value['kind'] != 'CLOSED_PHASE_TERMINAL_KEY_NAME_DIGEST_NOT_ADMISSION'):
        raise ValueError('Closed key-name terminal required')
    phase = validate_phase_observation(value['phase'], subject)
    if phase['result'] != 'finished' or phase['sequence'] != len(PHASES):
        raise ValueError('Key-name terminal completion refused')
    validate_keys(value['keyNames'])
    return value


def validate_plain_terminal_observation(value, subject, validate_keys, validate_plain):
    if (type(value) is not dict or set(value) != {'version', 'kind', 'phase', 'keyNames', 'namesComplete', 'names'}
            or type(value['version']) is not int or value['version'] != 3
            or value['kind'] != 'CLOSED_PHASE_TERMINAL_OTHER_KEY_NAMES_NOT_ADMISSION'):
        raise ValueError('Closed plain key-name terminal required')
    validate_terminal_observation({'version': 2,
        'kind': 'CLOSED_PHASE_TERMINAL_KEY_NAME_DIGEST_NOT_ADMISSION',
        'phase': value['phase'], 'keyNames': value['keyNames']}, subject, validate_keys)
    validate_plain({'namesComplete': value['namesComplete'], 'names': value['names']}, value['keyNames'])
    return value


class PhaseTracker:
    """Private bounded helper telemetry. A copied phase packet proves no native state."""
    def __init__(self, unit, deadline):
        self.subject, self.deadline = 'worker-' + unit[9], deadline
        self.index, self.terminal, self.broken = -1, False, False
        self.key_names, self.key_codec = None, None
        self.plain_names, self.plain_codec = None, None

    def write(self, result, cause='none'):
        if self.broken or self.terminal or time.monotonic() >= self.deadline:
            raise TimeoutError('Observer phase budget unavailable')
        value = validate_phase_observation({'version': 1,
            'kind': 'OWNED_OBSERVER_PHASE_NOT_ENVIRONMENT_OR_ADMISSION', 'subject': self.subject,
            'sequence': self.index if result == 'entered' else self.index + 1,
            'phase': PHASES[self.index], 'result': result, 'cause': cause}, self.subject)
        prefix = PHASE_PREFIX
        if result == 'finished' and self.key_names is not None:
            value = validate_terminal_observation({'version': 2,
                'kind': 'CLOSED_PHASE_TERMINAL_KEY_NAME_DIGEST_NOT_ADMISSION',
                'phase': value, 'keyNames': self.key_names}, self.subject, self.key_codec)
            prefix = TERMINAL_PREFIX
            if self.plain_names is not None:
                value = validate_plain_terminal_observation({'version': 3,
                    'kind': 'CLOSED_PHASE_TERMINAL_OTHER_KEY_NAMES_NOT_ADMISSION',
                    'phase': value['phase'], 'keyNames': value['keyNames'], **self.plain_names},
                    self.subject, self.key_codec, self.plain_codec)
                prefix = PLAIN_TERMINAL_PREFIX
        message = prefix.encode() + (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        if len(message) > 1024:
            raise ValueError('Observer phase bound refused')
        # Latch BEFORE publishing: an asynchronous abort after a complete terminal
        # write must never admit a second terminal/failure frame. Unknown writes
        # retain this terminal latch as well as the broken-transport latch.
        if result != 'entered':
            self.terminal = True
        # One bounded framed write. Never retry an uncertain or partial record.
        try:
            if time.monotonic() >= self.deadline:
                raise TimeoutError('Observer phase budget exhausted')
            if os.write(1, message) != len(message):
                raise OSError('Observer phase write incomplete')
        except BaseException:
            self.broken = True
            raise
        return None

    def enter(self, phase):
        if self.terminal or self.broken or phase not in PHASES or PHASES.index(phase) != self.index + 1:
            raise ValueError('Observer phase order refused')
        self.index += 1
        self.write('entered')

    def capture_keys(self, value, validate_keys, plain=None, validate_plain=None):
        if self.key_names is not None or self.terminal or self.broken:
            raise ValueError('Repeated key-name capture refused')
        self.key_names, self.key_codec = validate_keys(value), validate_keys
        if plain is not None:
            self.plain_names, self.plain_codec = validate_plain(plain, value), validate_plain

    def finish(self):
        if self.index != len(PHASES) - 1:
            raise ValueError('Incomplete observer phases')
        self.write('finished')

    def fail(self, error):
        if self.index < 0 or self.terminal or self.broken or time.monotonic() >= self.deadline:
            return
        cause = 'budget' if isinstance(error, TimeoutError) else 'io' if isinstance(error, OSError) else \
            'refused' if isinstance(error, (ValueError, AssertionError)) else 'other'
        self.write('failed', cause)


def protected_read(file, bound):
    current = pathlib.Path('/')
    for part in file.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Observation source custody refused')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= bound:
        raise ValueError('Observation source type refused')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        fingerprint = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
            value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if fingerprint(os.fstat(fd)) != fingerprint(info):
            raise ValueError('Observation source replaced')
        data = bytearray()
        while True:
            block = os.read(fd, min(65536, bound + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            if len(data) > bound:
                raise ValueError('Observation source bound refused')
        if (len(data) != info.st_size or fingerprint(os.fstat(fd)) != fingerprint(info)
                or fingerprint(file.lstat()) != fingerprint(info)):
            raise ValueError('Observation source changed')
        return bytes(data), (info.st_dev, info.st_ino)
    finally:
        os.close(fd)


def full_observation(unit, deadline, phase=None, key_capture=None):
    mark = phase if phase is not None else lambda _stage: None
    mark('context-read')
    raw_context, context_identity = protected_read(CONTEXT, 65536)
    context = json.loads(raw_context)
    if (type(context) is not dict or set(context) != {'version', 'profileSha256', 'sources', 'units'}
            or type(context['version']) is not int or context['version'] != 1
            or set(context['sources']) != {'next_fixture_poststart.py', 'next_profile.py'}
            or set(context['units']) != {'aihr-web@1.service', 'aihr-web@2.service'}):
        raise ValueError('Observation context refused')
    mark('profile-bound')
    raw_profile, _ = protected_read(PROFILE, 1024**2)
    if hashlib.sha256(raw_profile).hexdigest() != context['profileSha256']:
        raise ValueError('Observation profile differs')
    profile = json.loads(raw_profile)
    if profile.get('version') != 2 or set(profile['units']) != set(context['units']):
        raise ValueError('Observation profile scope refused')
    spec = profile['units'][unit]
    fragment = pathlib.Path('/etc/systemd/system', unit)
    declarations = context['units'][unit]
    if type(declarations) is not dict or set(declarations) != {'device', 'inode', 'sha256'}:
        raise ValueError('Observation declaration context refused')
    mark('helpers-bound')
    sources = {}
    for name in context['sources']:
        raw, _ = protected_read(HELPER / name, 1024**2)
        if hashlib.sha256(raw).hexdigest() != context['sources'][name]:
            raise ValueError('Observation installed source differs')
        sources[name] = raw
    if (pathlib.Path(__file__) != HELPER / 'next_fixture_poststart.py'
            or profile['trustedModules']['next_profile.py'] != context['sources']['next_profile.py']):
        raise ValueError('Observation owner source differs')
    mark('observer-loaded')
    N = types.ModuleType('sealed_initial_environment_observer')
    N.__file__ = str(HELPER / 'next_profile.py')
    exec(compile(sources['next_profile.py'], N.__file__, 'exec', dont_inherit=True), N.__dict__)
    def custody():
        raw, identity = protected_read(CONTEXT, 65536)
        if raw != raw_context or identity != context_identity:
            raise ValueError('Observation context changed')
        raw, _ = protected_read(PROFILE, 1024**2)
        if raw != raw_profile:
            raise ValueError('Observation profile changed')
        raw, identity = protected_read(fragment, 65536)
        if (identity != (declarations['device'], declarations['inode'])
                or hashlib.sha256(raw).hexdigest() != declarations['sha256']):
            raise ValueError('Observation declaration changed')
        # Full root-created declaration binds stock command; actual proc proof
        # independently checks live executable/cwd/cgroup, including title rewrite.
        argv = [spec['executable'], '--max-old-space-size=2048',
            spec['releaseDirectory'] + '/node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1']
        if ('ExecStart=' + ' '.join(argv) + '\n').encode() not in raw:
            raise ValueError('Observation stock declaration differs')
        for name, expected in sources.items():
            actual, _ = protected_read(HELPER / name, 1024**2)
            if actual != expected:
                raise ValueError('Observation source changed')
    mark('main-selector')
    main_pid = os.environ.get('MAINPID', '')
    if re.fullmatch(r'[1-9][0-9]{0,9}', main_pid) is None:
        raise ValueError('Observation main identity unavailable')
    captured, plain = None, None
    def capture(keys, count):
        nonlocal captured, plain
        if captured is not None:
            raise ValueError('Repeated native key-name capture refused')
        try:
            captured = N.key_name_digests(keys, count)
        except (ValueError, TypeError, UnicodeError, OverflowError):
            captured = N.unavailable_key_name_digests(count)
        try:
            plain = N.plain_key_names(keys, count, captured)
        except (ValueError, TypeError, UnicodeError, OverflowError):
            plain = {'namesComplete': False, 'names': []}
    result = N.observe_owned_environment({'pid': int(main_pid), 'invocation': os.environ.get('INVOCATION_ID', ''),
        'uid': spec['workerUid'], 'executable': spec['executable'], 'cwd': spec['releaseDirectory'],
        'cgroup': profile['resourceEnvelope']['cgroupPath'] + '/' + unit,
        'argv': [spec['executable'], '--max-old-space-size=2048',
            spec['releaseDirectory'] + '/node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1'],
        'title': 'next-server (v16.4.1)', 'subject': 'worker-' + unit[9]}, custody, deadline, _phase=mark,
        _key_names=capture if key_capture is not None else None)
    if key_capture is not None:
        if captured is None:
            captured = N.unavailable_key_name_digests(result['otherUnqualifiedCount'])
        if plain is None:
            plain = {'namesComplete': False, 'names': []}
        key_capture(N.validate_key_name_digests(captured, result['otherUnqualifiedCount']), N.validate_key_name_digests,
                    N.validate_plain_key_names(plain, captured), N.validate_plain_key_names)
    mark('environment-packet')
    message = N.ENVIRONMENT_OBSERVATION_PREFIX.encode() + N.canonical(result)
    if len(message) > 4096:
        raise ValueError('Observation journal record bound refused')
    return message


def best_effort_observation(unit):
    # No child command, source import, proc read or telemetry write may exceed
    # this one-second slice of the existing work deadline. An unavailable or
    # partial diagnostic never prevents the unchanged original admission exec.
    old_handler = signal.getsignal(signal.SIGALRM)
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        return
    def expired(_signal, _frame):
        raise TimeoutError('Observation deadline')
    tracker = None
    try:
        signal.signal(signal.SIGALRM, expired)
        deadline = time.monotonic() + 1
        signal.setitimer(signal.ITIMER_REAL, 1)
        tracker = PhaseTracker(unit, deadline)
        tracker.enter('timer-armed')
        message = full_observation(unit, deadline, tracker.enter, tracker.capture_keys)
        if time.monotonic() >= deadline:
            raise TimeoutError('Environment packet budget exhausted')
        try:
            if os.write(1, message) != len(message):
                raise OSError('Environment packet write incomplete')
        except BaseException:
            tracker.broken = True
            raise
        tracker.finish()
    except BaseException as error:
        # No error text/type/native field is reflected; terminal observation is optional.
        if tracker is not None:
            try:
                tracker.fail(error)
            except BaseException:
                pass
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)


def main():
    assert os.geteuid() == 0 and len(sys.argv) == 2
    unit = sys.argv[1]
    assert re.fullmatch(r'aihr-web@[12]\.service', unit)
    gate = pathlib.Path('/run/aihr-admission', 'permit-' + unit)
    deadline = time.monotonic() + 60
    while not gate.exists():
        assert time.monotonic() < deadline, 'Native cold admission gate expired'
        time.sleep(0.025)
    info = gate.lstat()
    assert not gate.is_symlink() and gate.is_file() and info.st_uid == 0 and info.st_nlink == 1
    assert info.st_mode & 0o777 == 0o600
    try:
        best_effort_observation(unit)
    except BaseException:
        pass
    finally:
        os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-B',
            '/usr/local/lib/aihr-admission/controller.py', 'admit', unit],
            {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
             'INVOCATION_ID': os.environ['INVOCATION_ID']})


if __name__ == '__main__':
    main()
