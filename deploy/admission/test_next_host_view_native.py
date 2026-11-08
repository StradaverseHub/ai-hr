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
import signal
import stat
import subprocess
import sys
import time

ROOT = pathlib.Path('/var/lib/aihr-next-host-conformance')
UNIT = 'aihr-next-host-conformance.service'
FOREIGN = 'aihr-next-foreign-conformance.service'
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
    require(unit in (UNIT, FOREIGN), 'Unknown native conformance unit')
    result = command('/usr/bin/systemctl', '--system', 'show', unit,
        '--property=LoadState,InvocationID,MainPID,ControlPID,ActiveState,SubState,ControlGroup,FragmentPath,DropInPaths,KillMode,Delegate,User,NoNewPrivileges,TimeoutStopUSec,SendSIGKILL,RuntimeMaxUSec', cap=cap)
    require(len(result.stdout) <= 8192, 'Native conformance metadata exceeds bound')
    return dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)


def family_stopped(unit, cap=3):
    actual = properties(unit, cap=cap)
    if actual.get('MainPID') != '0' or actual.get('ControlPID') != '0' or actual.get('ActiveState') not in ('inactive', 'failed'):
        return False
    expected = '/system.slice/' + unit
    require(actual.get('ControlGroup', '') in ('', expected), 'Native conformance cgroup changed')
    directory = pathlib.Path('/sys/fs/cgroup' + expected)
    if not directory.exists():
        return True
    require(not directory.is_symlink(), 'Native conformance cgroup is a link')
    events = dict(line.split() for line in (directory / 'cgroup.events').read_text().splitlines())
    return events.get('populated') == '0' and not (directory / 'cgroup.procs').read_text().strip()


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
                require(actual.get('MainPID') == actual.get('ControlPID') == '0'
                        and actual.get('ActiveState') in ('inactive', 'failed'), 'Unknown native conformance family')
            safe.append(name)
        except BaseException as error:
            errors.append(error)
    # Queue every independently proven stop BEFORE awaiting any native family.
    for index, name in enumerate(safe):
        try:
            command('/usr/bin/systemctl', '--system', 'stop', '--no-block', name,
                    cap=phase_cap(queue_end, .25, len(safe)-index))
        except BaseException as error:
            errors.append(error)
    pending = set(safe)
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
    for name in (UNIT, FOREIGN):
        if name not in files:
            require(not os.path.lexists('/etc/systemd/system/' + name)
                    and properties(name, cap=.2).get('LoadState') == 'not-found',
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
    require(all(not os.path.lexists('/etc/systemd/system/' + name)
                and properties(name, cap=.2).get('LoadState') == 'not-found' for name in (UNIT, FOREIGN)),
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
    for unit in (UNIT, FOREIGN):
        require(not os.path.lexists('/etc/systemd/system/' + unit)
                and properties(unit).get('LoadState') == 'not-found', 'Foreign native unit retained')
    version = command('/usr/bin/systemctl', '--version').stdout.splitlines()[0]
    require(version.startswith(b'systemd 255 '), 'Native conformance requires actual systemd255')
    primary = None
    owned_root, N = None, None
    files, invocations, report = {}, {}, {'version': 1, 'kind': 'ACTUAL_SYSTEMD_HOST_CACHE_CONFORMANCE_NOT_NEXT',
        'complete': False, 'nextApplicationVerified': False, 'releaseEligible': False}
    try:
        ROOT.mkdir(mode=0o755)
        info = ROOT.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o755,
                'Native conformance root construction differs')
        owned_root = (info.st_dev, info.st_ino)
        for name, source in [('probe.py', pathlib.Path(__file__)), ('next_profile.py', pathlib.Path(__file__).with_name('next_profile.py')),
                             ('runtime_inventory.py', pathlib.Path(__file__).resolve().parents[2] / '.github/ci/runtime_inventory.py')]:
            data = source.read_bytes();require(0 < len(data) <= 256 * 1024, 'Bounded source closure required')
            destination = ROOT / name
            with destination.open('xb') as output:
                output.write(data)
            destination.chmod(0o644)
            report.setdefault('sourceSha256', {})[name] = hashlib.sha256(data).hexdigest()
        N, I = load('owned_host_view', ROOT / 'next_profile.py'), load('owned_host_inventory', ROOT / 'runtime_inventory.py')
        for target in N.CACHE_TARGETS:
            (RELEASE / target).mkdir(parents=True, mode=0o755)
        (RELEASE / '.next/foreign-cache').mkdir(mode=0o755)
        for index in range(3):
            source = ROOT / 'mutable' / str(index);source.mkdir(parents=True, mode=0o700)
            source.chmod(0o700);os.chown(source, 65534, 65534)
        (ROOT / 'other-source').mkdir(mode=0o700);os.chown(ROOT / 'other-source', 65534, 65534)
        (ROOT / 'source-link').symlink_to(ROOT / 'mutable/0')
        unit = '[Service]\nType=simple\nUser=nobody\nNoNewPrivileges=yes\nProtectSystem=strict\nPrivateMounts=yes\nKillMode=control-group\nTimeoutStopSec=3s\nSendSIGKILL=yes\nRuntimeMaxSec=15s\n'
        unit += 'ExecStartPre=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook\n'
        unit += 'ExecStart=/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' app\n'
        unit += 'ExecStartPost=+/usr/bin/python3 -I -B ' + str(ROOT / 'probe.py') + ' hook\n'
        unit += 'BindReadOnlyPaths=' + str(RELEASE) + ':' + str(RELEASE) + ':norbind\n'
        unit += ''.join('BindPaths=' + row['source'] + ':' + str(RELEASE / row['target']) + ':norbind\n' for row in rows(N)[UNIT])
        for name, content in [(UNIT, unit), (FOREIGN, '[Service]\nUser=nobody\nNoNewPrivileges=yes\nExecStart=/usr/bin/sleep 15\nTimeoutStopSec=1s\nKillMode=control-group\n')]:
            file = pathlib.Path('/etc/systemd/system', name)
            with file.open('x') as output:
                output.write(content)
            file.chmod(0o644);info = file.lstat();files[name] = (info.st_dev, info.st_ino)
        command('/usr/bin/systemctl', '--system', 'daemon-reload')
        def start_owned(name, check=True):
            result, failures = None, []
            try:
                result = command('/usr/bin/systemctl', '--system', 'start', name, check=check)
            except BaseException as error:
                failures.append(error)
            try:
                # Failed/timed-out StartUnit may already own a native invocation.
                file = pathlib.Path('/etc/systemd/system', name);info = file.lstat()
                require((info.st_dev, info.st_ino) == files[name] and info.st_uid == 0, 'Native start declaration changed')
                actual = properties(name)
                if actual.get('InvocationID'):
                    invocations[name] = actual['InvocationID']
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
        start_owned(UNIT)
        started = properties(UNIT);invocations[UNIT] = started['InvocationID']
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
