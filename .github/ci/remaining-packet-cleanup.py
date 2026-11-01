"""One remaining packet; original normal/partial records remain immutable."""
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
import hashlib
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('frozen_selected_contracts', HERE / 'superseded-resource-cleanup.py')
frozen = importlib.util.module_from_spec(spec); spec.loader.exec_module(frozen)
require, canonical, digest, identity = frozen.require, frozen.canonical, frozen.digest, frozen.identity
private_directory, record, build_id, durable = frozen.private_directory, frozen.record, frozen.build_id, frozen.durable


def remove_packet(directory, source, operation_parent, certificate, check, post, boundary=lambda name: None):
    """Mechanically derived from cleanup-install.py's descriptor-relative nofollow engine.

    Two identities differ deliberately: the obsolete grant never identifies the CURRENT active build.
    No CLI override can select another source or resource set; test ports are import-only.
    """
    require(platform.system() == 'Linux' and shutil.rmtree.avoids_symlink_attacks, 'Linux safe descriptor-relative removal required')
    old, current = certificate['selection']['obsolete'], certificate['selection']['current']
    require(certificate['scope'] == ['packet'], 'Only the remaining packet may be removed')
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
            require(remaining in (['packet'], []), 'Only packet scope is valid')
            try:
                os.stat('next', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Previously removed next reappeared')
            try:
                s = os.stat('packet', dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                require(not remaining, 'Original remaining packet disappeared')
                return
            require(remaining and stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
                    and identity(s) == certificate['targets']['packet']
                    and identity(s) != certificate['targets']['active'], 'Remaining packet type/owner/identity/alias differs')

        remaining = ['packet']
        check(remaining)
        children(remaining)  # Validate the sole packet and historical next absence before creating an intent or deleting the packet.
        operation.mkdir(mode=0o700)
        root_fd = os.open(operation_parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(root_fd)
        os.fsync(root_fd)
        journal = os.open(operation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.append(journal)
        binding = dict(certificateSha256=digest(certificate), selection=certificate['selection'], targets=certificate['targets'])
        durable(journal, 'intent.json', dict(kind='REMAINING_PACKET_INTENT', **binding))
        check(remaining)
        children(remaining)
        durable(journal, 'consumed.json', dict(kind='REMAINING_PACKET_NONCE_CONSUMED', **binding))
        boundary('consumed')
        for name in ['packet']:
            check(remaining)  # Actual certificate/lease/fences/source-proof age is rechecked each time.
            children(remaining)
            shutil.rmtree(name, dir_fd=fd)
            os.fsync(fd)
            remaining.remove(name)
            durable(journal, 'removed-' + name + '.json', dict(kind='EXACT_REMAINING_PACKET_ABSENT', child=name, identity=certificate['targets'][name], **binding))
            boundary(name)
        children([])
        result = post()  # Actual full CURRENT runtime/compiled/638 proof plus immutable old records.
        require(result['kind'] == 'REMAINING_PACKET_REMOVED_CURRENT_RUNTIME_VERIFIED'
                and result['certificateSha256'] == digest(certificate) and result['verifiedAbsent'] == ['packet']
                and result['originalPartialJournalPreserved'] is True and result['historicalNextStillAbsent'] is True
                and result['originalPartialAttemptExit'] == 1 and result['originalLockReadyAndAuditsPreserved'] is True and result['originalOperatorExit'] is None
                and result['originalOperatorPass'] is False and result['releaseAuthorized'] is False, 'Purpose-specific completed post-audit required')
        active()
        durable(journal, 'result.json', result)
        return result
    finally:
        for handle in reversed(handles):
            os.close(handle)



def main():
    os.umask(0o077)
    require(sys.platform == 'linux' and Path.cwd() == Path('/opt/ai-hr'), 'Canonical staging only')
    module, c = frozen.installed_coordinator()
    require(len(sys.argv) == 6 and sys.argv[1] == 'cleanup', 'Exact selected cleanup invocation required')
    _, _, controller, observation, partial_certificate_path, certificate_path = sys.argv
    require(not os.environ.get('AIHR_SUPERSEDED_EXCLUSIVE_FD'), 'No nested cleanup guard')
    node = ['/opt/node22/bin/node', '--env-file=.env.production', '--import', 'tsx', str(HERE / 'remaining-packet-bridge.mjs')]
    with c.operations(exclusive=True) as fd:
        environment = {**os.environ, 'AIHR_SUPERSEDED_EXCLUSIVE_FD': str(fd), 'PYTHONDONTWRITEBYTECODE': '1'}
        def call(mode, remaining=None):
            with c.transaction():
                c.lease(module.environment_request())
            command = node + [mode, controller, observation, partial_certificate_path, certificate_path] + ([] if remaining is None else [json.dumps(remaining)])
            value = subprocess.check_output(command, env=environment, pass_fds=(fd,), timeout=600)
            require(0 < len(value) <= 32 * 1024 ** 2, 'Bounded complete read-only proof required')
            return json.loads(value)
        certificate = call('authority')
        require(os.environ.get('AIHR_STAGING_CANDIDATE') == certificate['selection']['current']['source'], 'Current lease source differs')
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
        directory = home / '.aihr-ci-builds' / certificate['selection']['obsolete']['installId']
        operation_parent = home / '.aihr-remaining-packet-cleanup'
        operation_parent.mkdir(mode=0o700, exist_ok=True)
        def check(remaining):
            frame = call('check', remaining)
            require(frame['certificate'] == certificate and frame['remaining'] == remaining
                    and frame['oldDirectory'] == str(directory) and frame['source'] == '/opt/ai-hr', 'Boundary certificate/fences differ')
        result = remove_packet(directory, Path('/opt/ai-hr'), operation_parent, certificate, check, lambda: call('post', []))
        print(canonical(result))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('Remaining-packet cleanup refused; preserve all records/partial state and lease.', file=sys.stderr)
        sys.exit(1)
