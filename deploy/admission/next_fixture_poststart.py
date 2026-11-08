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


def full_observation(unit, deadline):
    raw_context, context_identity = protected_read(CONTEXT, 65536)
    context = json.loads(raw_context)
    if (type(context) is not dict or set(context) != {'version', 'profileSha256', 'sources', 'units'}
            or type(context['version']) is not int or context['version'] != 1
            or set(context['sources']) != {'next_fixture_poststart.py', 'next_profile.py'}
            or set(context['units']) != {'aihr-web@1.service', 'aihr-web@2.service'}):
        raise ValueError('Observation context refused')
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
    sources = {}
    for name in context['sources']:
        raw, _ = protected_read(HELPER / name, 1024**2)
        if hashlib.sha256(raw).hexdigest() != context['sources'][name]:
            raise ValueError('Observation installed source differs')
        sources[name] = raw
    if (pathlib.Path(__file__) != HELPER / 'next_fixture_poststart.py'
            or profile['trustedModules']['next_profile.py'] != context['sources']['next_profile.py']):
        raise ValueError('Observation owner source differs')
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
    main_pid = os.environ.get('MAINPID', '')
    if re.fullmatch(r'[1-9][0-9]{0,9}', main_pid) is None:
        raise ValueError('Observation main identity unavailable')
    result = N.observe_owned_environment({'pid': int(main_pid), 'invocation': os.environ.get('INVOCATION_ID', ''),
        'uid': spec['workerUid'], 'executable': spec['executable'], 'cwd': spec['releaseDirectory'],
        'cgroup': profile['resourceEnvelope']['cgroupPath'] + '/' + unit,
        'argv': [spec['executable'], '--max-old-space-size=2048',
            spec['releaseDirectory'] + '/node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1'],
        'title': 'next-server (v16.4.1)', 'subject': 'worker-' + unit[9]}, custody, deadline)
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
    try:
        signal.signal(signal.SIGALRM, expired)
        deadline = time.monotonic() + 1
        signal.setitimer(signal.ITIMER_REAL, 1)
        message = full_observation(unit, deadline)
        os.write(1, message)
    except BaseException:
        # No unknown exception, native field or private source is reflected.
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
