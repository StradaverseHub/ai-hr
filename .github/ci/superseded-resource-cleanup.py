"""Selected superseded resources only. Old normal lock/READY and all audit records are immutable."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
COORDINATOR = Path('/var/tmp/aihr-deploy/staging-release-queue/coordinator.py')
OPERATIONS = COORDINATOR.parent / 'operations.lock'


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def identity(s):
    return dict(device=s.st_dev, inode=s.st_ino)


def private_directory(path):
    s = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
            and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700, 'Canonical owned0700 directory required')
    return s


def record(fd, name, bound=32768):
    handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        s = os.fstat(handle)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and 0 < s.st_size <= bound, 'Bounded owned immutable record required')
        data = os.read(handle, bound + 1)
        require(len(data) == s.st_size and identity(os.fstat(handle)) == identity(s), 'Original record changed')
        return data
    finally:
        os.close(handle)


def build_id(fd):
    value = record(fd, 'BUILD_ID', 513).decode().strip()
    require(re.fullmatch('[A-Za-z0-9_-]{1,512}', value), 'Exact compiled build ID required')
    return value


def durable(fd, name, value):
    h = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        data = (canonical(value) + '\n').encode()
        with os.fdopen(h, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(h)
    finally:
        os.close(h)
    os.fsync(fd)


def remove_selected(directory, source, operation_parent, certificate, check, post, boundary=lambda name: None):
    """Mechanically derived from cleanup-install.py's descriptor-relative nofollow engine.

    Two identities differ deliberately: the obsolete grant never identifies the CURRENT active build.
    No CLI override can select another source or resource set; test ports are import-only.
    """
    require(platform.system() == 'Linux' and shutil.rmtree.avoids_symlink_attacks, 'Linux safe descriptor-relative removal required')
    old, current = certificate['selection']['obsolete'], certificate['selection']['current']
    require(directory.parent.name == '.aihr-ci-builds' and directory.name == old['installId'], 'Exact selected obsolete installation required')
    require(source.resolve() == source and not source.is_relative_to(directory) and source != directory, 'Separate canonical current source required')
    initial = private_directory(directory)
    private_directory(directory.parent)
    private_directory(operation_parent)
    require(re.fullmatch('[a-f0-9]{64}', certificate['certificateId']), 'Exact operation nonce required')
    operation = operation_parent / certificate['certificateId']
    require(not os.path.lexists(operation), 'Existing consumed/partial operation refuses replay')
    handles = []
    try:
        parent = os.open(directory.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(parent)
        fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent); handles.append(fd)
        source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(source_fd)
        active_fd = os.open('.next', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd); handles.append(active_fd)
        require(identity(os.fstat(fd)) == identity(initial) == certificate['targets']['oldInstall'], 'Obsolete installation replaced')
        authorization = record(fd, 'authorization.json')
        grant = json.loads(authorization)
        require(hashlib.sha256(authorization).hexdigest() == old['grantSha256'] and grant['source'] == old['source']
                and grant['installId'] == old['installId'] and grant['build']['nextBuildId'] == old['nextBuildId']
                and grant['baselineBuildId'] == old['retainedBuildId'], 'Immutable obsolete ownership metadata differs')

        def active():
            require(identity(os.stat('.next', dir_fd=source_fd, follow_symlinks=False)) == certificate['targets']['active']
                    == identity(os.fstat(active_fd)) and build_id(active_fd) == current['nextBuildId'], 'CURRENT active runtime changed')
            require(identity(os.stat(directory.name, dir_fd=parent, follow_symlinks=False)) == identity(initial), 'Obsolete install path changed')

        def children(remaining):
            active()
            for name in ['next', 'packet']:
                if name not in remaining:
                    try:
                        os.stat(name, dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    raise ValueError('An already removed selected resource reappeared')
                s = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and identity(s) == certificate['targets'][name]
                        and identity(s) != certificate['targets']['active'], 'Selected child type/owner/identity/alias differs')
                if name == 'next':
                    retained = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        require(build_id(retained) == old['retainedBuildId'], 'Retained194e baseline differs')
                    finally:
                        os.close(retained)

        remaining = ['next', 'packet']
        check(remaining)
        children(remaining)  # Validate BOTH resources before creating an intent or deleting either.
        operation.mkdir(mode=0o700)
        root_fd = os.open(operation_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(root_fd)
        os.fsync(root_fd)
        journal = os.open(operation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(journal)
        binding = dict(certificateSha256=digest(certificate), selection=certificate['selection'], targets=certificate['targets'])
        durable(journal, 'intent.json', dict(kind='SUPERSEDED_RESOURCE_INTENT', **binding))
        check(remaining)
        children(remaining)
        durable(journal, 'consumed.json', dict(kind='SUPERSEDED_RESOURCE_NONCE_CONSUMED', **binding))
        boundary('consumed')
        for name in ['next', 'packet']:
            check(remaining)  # Actual certificate/lease/fences/source-proof age is rechecked each time.
            children(remaining)
            shutil.rmtree(name, dir_fd=fd)
            os.fsync(fd)
            remaining.remove(name)
            durable(journal, 'removed-' + name + '.json', dict(kind='EXACT_SELECTED_RESOURCE_ABSENT', child=name, identity=certificate['targets'][name], **binding))
            boundary(name)
        children([])
        result = post()  # Actual full CURRENT runtime/compiled/638 proof plus immutable old records.
        require(result['kind'] == 'SUPERSEDED_RESOURCES_REMOVED_CURRENT_RUNTIME_VERIFIED'
                and result['certificateSha256'] == digest(certificate) and result['verifiedAbsent'] == ['next', 'packet']
                and result['originalLockReadyAndAuditsPreserved'] is True and result['originalOperatorExit'] is None
                and result['originalOperatorPass'] is False and result['releaseAuthorized'] is False, 'Purpose-specific completed post-audit required')
        active()
        durable(journal, 'result.json', result)
        return result
    finally:
        for handle in reversed(handles):
            os.close(handle)


def installed_coordinator():
    require(COORDINATOR.resolve() == COORDINATOR and COORDINATOR.read_bytes() == Path('/opt/ai-hr/scripts/staging/coordinator.py').read_bytes(), 'Actual installed coordinator/source contract differs')
    private_directory(COORDINATOR.parent)
    for name in ['operations.lock', 'queue.sqlite3']:
        s = (COORDINATOR.parent / name).lstat()
        require(stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600, 'Existing private queue required; no bootstrap')
    spec = importlib.util.spec_from_file_location('actual_coordinator', COORDINATOR)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module, module.Coordinator()


def assert_exclusive_lease(module, c):
    value = os.environ.get('AIHR_SUPERSEDED_EXCLUSIVE_FD', '')
    require(value.isdecimal() and int(value) >= 3, 'Inherited exclusive descriptor required')
    fd = int(value); actual, wanted = os.fstat(fd), OPERATIONS.lstat()
    require(stat.S_ISREG(actual.st_mode) and not stat.S_ISLNK(wanted.st_mode) and actual.st_uid == wanted.st_uid == os.getuid()
            and actual.st_nlink == wanted.st_nlink == 1 and stat.S_IMODE(actual.st_mode) == 0o600
            and identity(actual) == identity(wanted), 'Actual canonical operations descriptor differs')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with c.transaction():
        c.lease(module.environment_request())


def main():
    os.umask(0o077)
    require(sys.platform == 'linux' and Path.cwd() == Path('/opt/ai-hr'), 'Canonical staging only')
    module, c = installed_coordinator()
    if sys.argv[1:] == ['assert-exclusive']:
        assert_exclusive_lease(module, c)
        return
    require(len(sys.argv) == 5 and sys.argv[1] == 'cleanup', 'Exact selected cleanup invocation required')
    _, _, controller, observation, certificate_path = sys.argv
    require(not os.environ.get('AIHR_SUPERSEDED_EXCLUSIVE_FD'), 'No nested cleanup guard')
    node = ['/opt/node22/bin/node', '--env-file=.env.production', '--import', 'tsx', str(HERE / 'superseded-resource-bridge.mjs')]
    with c.operations(exclusive=True) as fd:
        environment = {**os.environ, 'AIHR_SUPERSEDED_EXCLUSIVE_FD': str(fd), 'PYTHONDONTWRITEBYTECODE': '1'}
        def call(mode, remaining=None):
            with c.transaction():
                c.lease(module.environment_request())
            command = node + [mode, controller, observation, certificate_path] + ([] if remaining is None else [json.dumps(remaining)])
            value = subprocess.check_output(command, env=environment, pass_fds=(fd,), timeout=600)
            require(0 < len(value) <= 32 * 1024 ** 2, 'Bounded complete read-only proof required')
            return json.loads(value)
        certificate = call('authority')
        require(os.environ.get('AIHR_STAGING_CANDIDATE') == certificate['selection']['current']['source'], 'Current lease source differs')
        first = call('check', ['next', 'packet'])
        require(first['certificate'] == certificate, 'Exact purpose certificate differs')
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        directory = home / '.aihr-ci-builds' / certificate['selection']['obsolete']['installId']
        require(first['oldDirectory'] == str(directory) and first['source'] == '/opt/ai-hr', 'Fixed selected runtime/resource path differs')
        operation_parent = home / '.aihr-superseded-cleanup'
        operation_parent.mkdir(mode=0o700, exist_ok=True)
        def check(remaining):
            frame = call('check', remaining)
            require(frame['certificate'] == certificate and frame['remaining'] == remaining, 'Boundary certificate/fences differ')
        result = remove_selected(directory, Path('/opt/ai-hr'), operation_parent, certificate, check, lambda: call('post', []))
        print(canonical(result))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('Superseded-resource cleanup refused; preserve all records/partial state and lease.', file=sys.stderr)
        sys.exit(1)
