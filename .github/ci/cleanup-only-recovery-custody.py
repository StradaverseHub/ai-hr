"""One selected dead-lock custody transition. No installation, service, DB or grant mutation."""
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import pwd
from pathlib import Path
import stat
import subprocess
import sys
import urllib.request

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
COORDINATOR = Path('/var/tmp/aihr-deploy/staging-release-queue/coordinator.py')
OPERATIONS = COORDINATOR.parent / 'operations.lock'
ABSENT = ['normal-cleanup-commit.json', 'normal-cleanup-consumed.json', 'cleanup-authorized.json',
          'cleanup-intent.json', 'cleanup-result.json', 'normal-cleanup-owned-cleanup.json']


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def private_directory(path):
    s = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
            and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700, 'Private canonical directory required')


def file_bytes(path, wanted=None, links=1):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600
                and s.st_nlink == links and 0 < s.st_size <= 32768, 'Private bounded file/links required')
        data = os.read(fd, 32769)
        require(len(data) == s.st_size, 'Complete original bytes required')
        require((path.lstat().st_dev, path.lstat().st_ino) == (s.st_dev, s.st_ino), 'Path changed while reading')
        if wanted is not None:
            require((s.st_dev, s.st_ino, len(data), hashlib.sha256(data).hexdigest()) ==
                    (wanted['device'], wanted['inode'], wanted['bytes'], wanted['sha256']), 'Original identity/bytes changed')
        return data
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write((canonical(value) + '\n').encode())
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(path.parent)


def assert_dead_process(binding, proc=Path('/proc')):
    require(binding['originalStartTicks'] is None, 'Historical process start is explicitly unavailable')
    require(not (proc / str(binding['pid'])).exists(), 'Original PID present/reused')
    require(hashlib.sha256((proc / 'sys/kernel/random/boot_id').read_bytes()).hexdigest() == binding['bootSha256'], 'Server rebooted')


def no_competing_finalizer(proc=Path('/proc')):
    for path in proc.iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue  # The selected private install protocol requires the current installation owner.
            executable = (path / 'exe').resolve(strict=True).name
            command = (path / 'cmdline').read_bytes()
        except FileNotFoundError:
            continue  # An exited unrelated process is not an in-flight operation.
        require(not (executable in ['node', 'nodejs'] and b'/opt/ai-hr' in command and any(name in command for name in
                    [b'staging-build-install.mjs', b'cleanup-only-recovery-server.mjs', b'normal-cleanup-operator.mjs'])),
                'An installer/finalizer is still present')


def preserve_dead_lock(directory, authority, preflight, boundary=lambda name: None):
    """Filesystem transaction with injected *additional* assertions for isolated controls.

    A partial intent/link/unlink is retained and refuses a second invocation. No automatic repair.
    The production caller holds the actual coordinator EX descriptor for this entire function.
    """
    private_directory(directory)
    original = directory / 'normal-cleanup.lock'
    ready = directory / 'normal-cleanup-ready.json'
    binding = authority['staleLock']
    require(re.fullmatch('[a-f0-9]{64}', authority['certificateId']) is not None, 'Exact certificate custody name required')
    custody = directory / ('cleanup-only-v1-custody-' + authority['certificateId'])
    require(not os.path.lexists(custody), 'Existing custody/partial/replay refuses')

    def check(links=1):
        preflight()
        require(not any(os.path.lexists(directory / name) for name in ABSENT), 'Authority/consumption/result already exists')
        file_bytes(original, binding['lock'], links)
        file_bytes(ready, binding['ready'])

    check()
    custody.mkdir(mode=0o700)
    sync_directory(directory)
    record = {key: authority[key] for key in ['selection', 'certificateSha256', 'reconciliationSha256', 'custodySha256']}
    record.update(originalStartTicks=binding['originalStartTicks'], historicalProcessStartUnavailable=True)
    durable(custody / 'custody-intent.json', {'kind': 'DEAD_LOCK_CUSTODY_INTENT', **record})
    boundary('intent')
    check()
    target = custody / 'original-normal-cleanup.lock'
    os.link(original, target, follow_symlinks=False)
    sync_directory(custody)
    boundary('linked')
    check(2)
    file_bytes(target, binding['lock'], 2)
    # The EX queue operation excludes cooperating installers/finalizers and lease handback.
    # Recheck both names immediately before unlink; any uncertainty leaves intent/link intact.
    require((original.lstat().st_dev, original.lstat().st_ino) == (target.lstat().st_dev, target.lstat().st_ino), 'Custody alias changed')
    os.unlink(original)
    sync_directory(directory)
    boundary('unlinked')
    preflight()
    require(not os.path.lexists(original), 'Canonical old lock reappeared')
    file_bytes(target, binding['lock'])
    file_bytes(ready, binding['ready'])
    result = {'kind': 'DEAD_LOCK_CUSTODY_COMPLETE', **record, 'originalLockAbsent': True, 'readyPreserved': True}
    durable(custody / 'custody-result.json', result)
    return result


def coordinator():
    require(COORDINATOR.resolve() == COORDINATOR, 'Actual installed coordinator required')
    require(COORDINATOR.read_bytes() == Path('/opt/ai-hr/scripts/staging/coordinator.py').read_bytes(), 'Installed coordinator differs from the verified source contract')
    private_directory(COORDINATOR.parent)
    for name in ['queue.sqlite3', 'operations.lock']:
        value = (COORDINATOR.parent / name).lstat()
        require(stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode) and value.st_uid == os.getuid()
                and value.st_nlink == 1 and stat.S_IMODE(value.st_mode) == 0o600, 'Existing private queue required; no bootstrap')
    spec = importlib.util.spec_from_file_location('actual_staging_coordinator', COORDINATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, module.Coordinator()


def inherited_exclusive(c):
    value = os.environ.get('AIHR_CLEANUP_EXCLUSIVE_FD', '')
    require(value.isdecimal() and int(value) >= 3, 'Inherited actual operations descriptor required')
    fd = int(value)
    actual, wanted = os.fstat(fd), OPERATIONS.lstat()
    require(stat.S_ISREG(actual.st_mode) and not stat.S_ISLNK(wanted.st_mode) and actual.st_nlink == wanted.st_nlink == 1
            and actual.st_uid == wanted.st_uid == os.getuid() and stat.S_IMODE(actual.st_mode) == 0o600
            and (actual.st_dev, actual.st_ino) == (wanted.st_dev, wanted.st_ino), 'Actual canonical operations descriptor differs')
    # Same inherited open-file description retains EX; an unrelated SH/EX owner causes refusal.
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def run_json(command, **kwargs):
    out = subprocess.check_output(command, timeout=120, **kwargs)
    require(0 < len(out) <= 16 * 1024 ** 2, 'Bounded complete control response required')
    return json.loads(out)


def main():
    os.umask(0o077)
    require(sys.platform == 'linux' and Path.cwd() == Path('/opt/ai-hr'), 'Canonical staging only')
    module, c = coordinator()
    if sys.argv[1:] == ['assert-exclusive']:
        inherited_exclusive(c)
        with c.transaction():
            c.lease(module.environment_request())
        return
    require(len(sys.argv) == 7 and sys.argv[1] == 'custody', 'Exact selected custody invocation required')
    _, _, controller, reconciliation, reconciliation_sha, attempt, certificate = sys.argv
    require(not os.environ.get('AIHR_CLEANUP_EXCLUSIVE_FD'), 'No nested or reused custody operation')
    node = ['/opt/node22/bin/node', '--env-file=.env.production', '--import', 'tsx']
    authority_command = node + [str(HERE / 'cleanup-only-recovery-admission.mjs'), 'custody-authority', reconciliation, certificate, controller]
    with c.operations(exclusive=True) as fd:
        environment = {**os.environ, 'AIHR_CLEANUP_EXCLUSIVE_FD': str(fd), 'PYTHONDONTWRITEBYTECODE': '1'}
        with c.transaction():
            c.lease(module.environment_request())
        authority = run_json(authority_command, env=environment)
        cert = json.loads(Path(certificate).read_bytes())
        require(authority['reconciliationSha256'] == reconciliation_sha, 'Exact reconciliation differs')
        authority['certificateId'] = cert['certificateId']
        selection, binding = authority['selection'], authority['staleLock']
        check_command = node + [str(HERE / 'cleanup-only-recovery-server.mjs'), 'custody-check', '/opt/ai-hr', controller,
                                reconciliation, reconciliation_sha, attempt, certificate]
        checked = run_json(check_command, env=environment, pass_fds=(fd,))
        require(checked['kind'] == 'EXCLUSIVE_DEAD_LOCK_CUSTODY_CHECK_PASSED'
                and all(checked[k] == authority[k] for k in ['selection', 'certificateSha256', 'reconciliationSha256', 'custodySha256']), 'Actual fast fence proof differs')
        directory = Path(pwd.getpwuid(os.getuid()).pw_dir) / '.aihr-ci-builds' / selection['installId']
        require(directory.resolve() == directory and checked['directory'] == str(directory), 'Actual selected private install directory differs')

        def preflight():
            with c.transaction():
                c.lease(module.environment_request())
            current = run_json(authority_command, env=environment)
            require(all(current[k] == authority[k] for k in ['selection', 'certificateSha256', 'reconciliationSha256', 'custodySha256', 'staleLock']), 'Authority/tool/reconciliation changed')
            fast = run_json(check_command, env=environment, pass_fds=(fd,))
            require(fast == checked, 'Full fast metadata/service fences changed at custody boundary')
            assert_dead_process(binding)
            no_competing_finalizer()
            require(c.ready(selection['source'], selection['nextBuildId'])['state'] == 'ok', 'Current source/build unhealthy')
            for prop, expected in [('MainPID', checked['pid']), ('ExecMainStartTimestampMonotonic', checked['started'])]:
                observed = subprocess.check_output(['systemctl', 'show', 'aihr', '--property=' + prop, '--value'], timeout=10).decode().strip()
                require(observed == expected, 'Active service identity changed')
            port = os.environ.get('PORT', '3000')
            require(port.isdecimal() and 0 < int(port) <= 65535, 'Bounded local service port required')
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            with urllib.request.build_opener(NoRedirect).open('http://127.0.0.1:' + port + '/health', timeout=3) as response:
                require(response.status == 200, 'Actual service health failed')
        result = preserve_dead_lock(directory, authority, preflight)
        print(canonical(result))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('Dead-lock custody refused; preserve all original/partial records and lease.', file=sys.stderr)
        sys.exit(1)
