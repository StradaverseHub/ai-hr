"""Staging-only managed update. Bundle with the reviewed format and installer, hash-pin as root.
No entry point or source imports: the private bundle supplies the reviewed modules.
Drain before web installation; activate only after exact web source/build arrival.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import tempfile
import time


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def properties(base):
    fields = ['Restart', 'NeedDaemonReload', 'ExecStart', 'Result', 'ExecMainCode', 'ExecMainStatus', 'SendSIGKILL', 'UnitFileState']
    extra = base.command(['/usr/bin/systemctl', 'show', 'aihr-bank-import.service', '--no-pager',
                          *['--property=' + field for field in fields]]).stdout
    return {**base.service_properties(), **dict(line.split('=', 1) for line in extra.splitlines() if '=' in line)}


def validate_existing(base, source, unit_hash, env_hash):
    release = base.ROOT / 'releases' / source
    for path in (base.UNIT, base.ENV, release / 'worker-install-v2.json'):
        base.root_protected(path, regular=True)
    base.check(digest(base.read_bounded(base.UNIT, 65536)) == unit_hash == digest(base.service_unit(source).encode()), 'reviewed prior unit differs')
    base.check(digest(base.read_bounded(base.ENV, 1024**2)) == env_hash, 'protected worker environment differs')
    record = json.loads(base.read_bounded(release / 'worker-install-v2.json', 65536))
    base.check(record.get('source') == source and record.get('unitSha256') == unit_hash and
               record.get('selectedEnvironmentSha256') == env_hash and record.get('serviceStable') is True, 'prior managed installation receipt differs')
    report = properties(base)
    base.validate_service(report, release)
    base.check(report.get('Restart') == 'on-failure' and report.get('NeedDaemonReload') == 'no', 'loaded prior service is not the reviewed configuration')
    return report


def validate_process(base, report, source):
    identity = pwd.getpwnam(base.USER)
    pid = int(report.get('MainPID', '0'))
    base.check(pid > 0 and report.get('ActiveState') == 'active' and report.get('SubState') == 'running', 'worker is not active')
    process = Path('/proc') / str(pid)
    base.check(process.stat().st_uid == identity.pw_uid and
               (process / 'cwd').resolve() == base.ROOT / 'releases' / source, 'live worker identity/source differs')
    base.check(base.read_bounded(process / 'cmdline', 65536).split(b'\0')[:-1] ==
               [str(base.NODE).encode(), b'--import', b'tsx', b'scripts/bank-import-runner.ts'], 'live worker command differs')
    raw = base.read_bounded(base.ENV, 1024**2).decode()
    environment = dict((key, json.loads(value)) for line in raw.splitlines() if line for key, value in [line.split('=', 1)])
    base.check(set(environment) <= base.ENV_KEYS, 'unreviewed worker environment key')
    actual = dict(item.split(b'=', 1) for item in base.read_bounded(process / 'environ', 1024**2).split(b'\0') if b'=' in item)
    base.check(all(actual.get(key.encode()) == value.encode() for key, value in environment.items()), 'live worker environment differs')
    base.check(not any(key.encode() in actual for key in ('NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH')), 'unexpected worker loader environment')
    return pid


def drain(base, initial, previous):
    """SIGTERM invokes the existing runner's finish-current-tick handler, without a stop/kill timer.
    If it crashes/restarts or fails to exit, refuse; never force-kill, disable or replay jobs.
    """
    pid = validate_process(base, initial, previous)
    fresh = properties(base)
    base.check(fresh == initial, 'service changed before managed drain')
    base.command(['/usr/bin/systemctl', 'kill', '--kill-whom=main', '--signal=SIGTERM', 'aihr-bank-import.service'])
    deadline = time.monotonic() + 330
    while time.monotonic() < deadline:
        report = properties(base)
        base.validate_service(report, base.ROOT / 'releases' / previous)
        base.check(report.get('NRestarts') == initial.get('NRestarts'), 'worker restarted during drain')
        current = int(report.get('MainPID', '0'))
        base.check(current in (0, pid), 'worker PID changed during drain')
        if current == 0 and report.get('ActiveState') == 'inactive' and report.get('SubState') == 'dead':
            base.check(report.get('Result') == 'success' and report.get('ExecMainStatus') == '0', 'worker did not exit successfully')
            time.sleep(2)
            base.check(properties(base) == report, 'worker did not remain drained')
            return {'pid': pid, 'state': 'drained', 'forcedKill': False}
        base.check(report.get('ActiveState') in ('active', 'activating', 'deactivating'), 'worker drain entered an unexpected state')
        time.sleep(2)
    raise RuntimeError('Worker drain deadline reached; retain prior unit and packages, inspect current process before proceeding')


def atomic_unit(base, raw, expected_prior):
    base.root_protected(base.UNIT.parent)
    base.check(digest(base.read_bounded(base.UNIT, 65536)) == expected_prior, 'unit changed before atomic replacement')
    fd, name = tempfile.mkstemp(prefix='.aihr-worker-update-', dir=base.UNIT.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, base.UNIT)
        directory = os.open(base.UNIT.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def quiesce_failed_activation(base, operation, source):
    """Quarantine only this updater's exact candidate unit; never restore an old worker.
    Persist failure evidence, prevent automatic starts, and drain without forced termination.
    If any protection cannot be established, report uncertainty and require administrator recovery.
    """
    result = {'source': source, 'accepted': False, 'stopped': False, 'disabled': False, 'forcedKill': False}
    candidate = base.service_unit(source).encode()
    try:
        base.write_new(operation / 'activation-failed.json', json.dumps(result, sort_keys=True).encode(), 0o400)
    except Exception:
        result['failureRecordUnavailable'] = True
    try:
        quarantine = base.service_unit(source).replace('Restart=on-failure\n', 'Restart=no\nSendSIGKILL=no\n').encode()
        atomic_unit(base, quarantine, digest(candidate))
        base.command(['/usr/bin/systemctl', 'daemon-reload'])
        report = properties(base)
        base.validate_service(report, base.ROOT / 'releases' / source)
        base.check(report.get('Restart') == 'no' and report.get('SendSIGKILL') == 'no' and
                   report.get('NeedDaemonReload') == 'no', 'failure quarantine is not loaded; do not arm a timed stop')
        try:
            base.command(['/usr/bin/systemctl', 'disable', 'aihr-bank-import.service'])
        except Exception:
            result['disableRequestFailed'] = True
        # A boot-enable error must not leave rejected work running. Recheck stop protection
        # independently, then request the graceful stop even if disabling was uncertain.
        report = properties(base)
        base.validate_service(report, base.ROOT / 'releases' / source)
        base.check(report.get('Restart') == 'no' and report.get('SendSIGKILL') == 'no' and
                   report.get('NeedDaemonReload') == 'no', 'failure quarantine changed before stop')
        try:
            base.command(['/usr/bin/systemctl', 'stop', '--no-block', 'aihr-bank-import.service'])
        except Exception:
            result['stopRequestFailed'] = True
        deadline = time.monotonic() + 330
        while time.monotonic() < deadline:
            report = properties(base)
            base.validate_service(report, base.ROOT / 'releases' / source)
            base.check(report.get('Restart') == 'no' and report.get('SendSIGKILL') == 'no', 'failure quarantine changed')
            result['disabled'] = report.get('UnitFileState') == 'disabled'
            if report.get('MainPID') == '0' and report.get('ActiveState') in ('inactive', 'failed'):
                result['stopped'] = True
                if not result['disabled']:
                    result['quiescenceUnconfirmed'] = True
                break
            time.sleep(2)
    except Exception:
        result['quiescenceUnconfirmed'] = True
    try:
        base.write_new(operation / 'activation-failure-observation.json', json.dumps(result, sort_keys=True).encode(), 0o400)
    except Exception:
        result['observationUnavailable'] = True
    return result


def upgrade(argv, fmt, base):
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['drain', 'activate'])
    for name in ('previous-web-source', 'previous-web-build', 'previous-worker-source', 'source', 'build-id', 'archive', 'archive-sha256',
                 'lock-sha256', 'package-sha256', 'unit-sha256', 'worker-env-sha256'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    base.check(os.geteuid() == 0, 'root must run the independently hash-pinned self-contained bundle with Python -I')
    for value in (args.previous_web_source, args.previous_worker_source, args.source):
        base.check(re.fullmatch('[a-f0-9]{40}', value or ''), 'exact sources required')
    base.check(args.previous_worker_source != args.source, 'update requires a different worker source')
    for value in (args.previous_web_build, args.build_id):
        base.check(re.fullmatch('[A-Za-z0-9_-]{1,160}', value or ''), 'exact builds required')
    for value in (args.archive_sha256, args.lock_sha256, args.package_sha256, args.unit_sha256, args.worker_env_sha256):
        base.check(re.fullmatch('[a-f0-9]{64}', value or ''), 'independently authenticated digests required')
    base.root_protected(base.NODE, regular=True)
    base.check(base.command([str(base.NODE), '--version']).stdout.strip() == 'v22.23.3', 'reviewed worker runtime required')
    lock = base.install_lock_directory() / 'install.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    base.check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077, 'private administrator lock required')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        base.root_protected(base.ROOT)
        operations = base.ROOT / 'upgrades'
        if not operations.exists():
            operations.mkdir(mode=0o700)
        base.root_protected(operations)
        operation = operations / args.source
        identity = {name: getattr(args, name) for name in ('previous_web_source', 'previous_web_build', 'previous_worker_source', 'source', 'build_id',
                    'archive_sha256', 'lock_sha256', 'package_sha256', 'unit_sha256', 'worker_env_sha256')}
        if args.phase == 'drain':
            state = base.deployment_state(args.previous_web_source, args.previous_web_build)
            report = validate_existing(base, args.previous_worker_source, args.unit_sha256, args.worker_env_sha256)
            base.check(not operation.exists() and not operation.is_symlink(), 'existing update attempt needs separate recovery review')
            operation.mkdir(mode=0o700)
            archive = operation / 'authenticated-worker.zip'
            base.snapshot_archive(args.archive, archive, args.archive_sha256, fmt.MAX_ARCHIVE)
            staged = operation / 'release'
            staged.mkdir(mode=0o700)
            manifest = fmt.extract_archive(archive, staged, args.source, args.lock_sha256, args.package_sha256)
            base.check(base.deployment_state(args.previous_web_source, args.previous_web_build) == state, 'web baseline changed before drain')
            base.check(validate_existing(base, args.previous_worker_source, args.unit_sha256, args.worker_env_sha256) == report, 'worker changed during preparation')
            result = drain(base, report, args.previous_worker_source)
            base.write_new(operation / 'drained.json', fmt.canonical({'identity': identity, 'manifestSha256': fmt.digest(fmt.canonical(manifest)), 'drain': result}), 0o400)
            print(json.dumps({'source': args.source, **result}))
            return
        base.root_protected(operation)
        base.root_protected(operation / 'drained.json', regular=True)
        record = json.loads(base.read_bounded(operation / 'drained.json', 65536))
        base.check(record.get('identity') == identity and record.get('drain', {}).get('state') == 'drained', 'exact drain record required')
        state = base.deployment_state(args.source, args.build_id)
        base.command(['/usr/bin/systemctl', 'is-active', '--quiet', 'aihr'])
        report = validate_existing(base, args.previous_worker_source, args.unit_sha256, args.worker_env_sha256)
        base.check(report.get('MainPID') == '0' and report.get('ActiveState') == 'inactive', 'prior worker is not drained')
        archive = operation / 'authenticated-worker.zip'
        base.root_protected(archive, regular=True)
        base.check(digest(base.read_bounded(archive, fmt.MAX_ARCHIVE)) == args.archive_sha256, 'prepared package changed')
        manifest = fmt.inspect_archive(archive, args.source, args.lock_sha256, args.package_sha256)
        base.check(fmt.digest(fmt.canonical(manifest)) == record.get('manifestSha256'), 'prepared manifest changed')
        # Re-extract authenticated bytes instead of trusting an earlier unpacked tree.
        staged = operation / 'activation-release'
        staged.mkdir(mode=0o700)
        fmt.extract_archive(archive, staged, args.source, args.lock_sha256, args.package_sha256)
        entries = {row['path']: row for row in manifest['entries']}
        for path in staged.rglob('*'):
            if not path.is_symlink():
                os.chmod(path, 0o755 if path.is_dir() else entries[path.relative_to(staged).as_posix()]['mode'])
        os.chmod(staged, 0o755)
        release = base.ROOT / 'releases' / args.source
        base.root_protected(release.parent)
        base.check(not release.exists() and not release.is_symlink(), 'immutable destination already exists')
        os.rename(staged, release)
        base.check(base.deployment_state(args.source, args.build_id) == state, 'web changed before activation')
        try:
            atomic_unit(base, base.service_unit(args.source).encode(), args.unit_sha256)
            base.command(['/usr/bin/systemctl', 'daemon-reload'])
            base.validate_service(properties(base), release)
            base.command(['/usr/bin/systemctl', 'start', 'aihr-bank-import.service'])
            stable_pid = None
            for _ in range(3):
                time.sleep(4)
                report = properties(base)
                base.validate_service(report, release)
                base.check(report.get('NRestarts') == '0' and report.get('NeedDaemonReload') == 'no', 'updated service is not stable')
                pid = validate_process(base, report, args.source)
                base.check(stable_pid in (None, pid), 'updated worker PID changed')
                stable_pid = pid
            base.check(base.deployment_state(args.source, args.build_id) == state, 'web changed before worker acceptance')
            base.check(digest(base.read_bounded(base.ENV, 1024**2)) == args.worker_env_sha256, 'worker environment changed during activation')
            accepted = {'source': args.source, 'webBuildId': args.build_id, 'archiveSha256': args.archive_sha256,
                        'manifestSha256': record['manifestSha256'], 'selectedEnvironmentSha256': args.worker_env_sha256,
                        'unitSha256': digest(base.service_unit(args.source).encode()), 'workerPid': stable_pid,
                        'serviceStable': True, 'journeyVerified': False,
                        'previousWebSource': args.previous_web_source, 'previousWebBuildId': args.previous_web_build,
                        'previousWorkerSource': args.previous_worker_source}
            base.write_new(release / 'worker-install-v2.json', fmt.canonical(accepted), 0o444)
            base.write_new(operation / 'activated.json', fmt.canonical(accepted), 0o400)
            print(json.dumps(accepted))
        except Exception:
            # Includes replacement/fsync, reload/start, process proof and receipt persistence failures.
            # Quarantine refuses any foreign/unchanged unit rather than touching another release.
            observed = quiesce_failed_activation(base, operation, args.source)
            print(json.dumps({'workerActivationFailed': True, **observed}), file=sys.stderr)
            raise RuntimeError('Worker activation failed; retained packages and protected failure observations require explicit administrator recovery') from None
    finally:
        os.close(fd)
