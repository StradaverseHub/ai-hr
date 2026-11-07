#!/usr/bin/python3
"""Generation-fenced admission for stock web workers. Run installed with python -I.

This controller never starts, stops or kills an application worker. The release
owner drains first, then asks systemd to stop it. All configuration changes and
Nginx reload paths share this controller's lock. Health and drain waits do not.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import pwd
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time
from typing import Any

PROFILE = pathlib.Path('/etc/aihr-admission/profile.json')
INSTALLED = pathlib.Path('/usr/local/lib/aihr-admission/controller.py')
HEX32 = re.compile(r'^[0-9a-f]{32}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^[0-9a-f]{64}$')
UNIT = re.compile(r'^aihr(?:-web@[1-8])?\.service$')
PATH = re.compile(r'^/[A-Za-z0-9_./@-]+$')
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


class Refused(RuntimeError):
    """Safe, fixed operation refusal; never include command output or HTTP bodies."""


class EndpointNotReady(Refused):
    """The live expected worker has not opened its reserved listener yet."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise Refused(message)


def exact_keys(value: Any, keys: set[str]) -> None:
    require(isinstance(value, dict) and set(value) == keys, 'Unexpected profile or state fields')


def matches(pattern: re.Pattern[str], value: Any) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def managed_path(value: Any) -> bool:
    return matches(PATH, value) and '..' not in pathlib.Path(value).parts


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def process_identity(pid: int) -> dict[str, int] | None:
    try:
        raw = pathlib.Path('/proc', str(pid), 'stat').read_text()
        fields = raw[raw.rfind(')') + 2:].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'startTicks': int(fields[19])}
    except (OSError, ValueError, IndexError):
        return None


def alive(identity: dict[str, int]) -> bool:
    return process_identity(identity['pid']) == identity


def admitting_phase(properties: dict[str, str]) -> bool:
    return (properties.get('ActiveState'), properties.get('SubState')) in {
        ('active', 'running'), ('activating', 'start-post')}


def secure_path(path: pathlib.Path, uid: int, *, directory: bool = False) -> None:
    require(path.is_absolute() and '..' not in path.parts, 'Unsafe managed path')
    current = pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except OSError:
            raise Refused('Managed path is missing') from None
        require(not stat.S_ISLNK(info.st_mode), 'Managed paths must not be symlinks')
        # A root-created private directory under the OS sticky temporary parent
        # is also safe. Its children still require the declared owner/mode.
        temporary_parent = str(current) in ('/tmp', '/var/tmp') and bool(info.st_mode & stat.S_ISVTX)
        require(info.st_uid in (0, uid) or current == pathlib.Path('/') or temporary_parent,
                'Managed path has an unexpected owner')
        require(not info.st_mode & 0o022 or temporary_parent, 'Managed path is writable by another principal')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'Unexpected managed path type')


def atomic_write(path: pathlib.Path, content: bytes, uid: int, mode: int = 0o600) -> None:
    secure_path(path.parent, uid, directory=True)
    if path.exists() or path.is_symlink():
        secure_path(path, uid)
    temporary = path.parent / ('.' + path.name + '.' + secrets.token_hex(16))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class Profile:
    """Closed root-owned installation facts. No URL, shell or package arguments."""
    def __init__(self, path: pathlib.Path, uid: int = 0):
        secure_path(path, uid)
        raw = path.read_bytes()
        require(len(raw) <= 32768, 'Profile exceeds its supported size')
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise Refused('Invalid admission profile') from None
        exact_keys(value, {'version', 'epoch', 'source', 'build', 'resourceEnvelopeDigest', 'stateDirectory',
                           'nginxBinary', 'nginxConfig', 'nginxPrefix', 'nginxPid', 'nginxUnit',
                           'managedInclude', 'controlPort', 'ports', 'units', 'healthSeconds',
                           'activationSeconds', 'drainSeconds', 'reloadGuardDigest', 'controllerDigest'})
        require(type(value['version']) is int and value['version'] == 1 and matches(HEX32, value['epoch']),
                'Unsupported admission profile')
        require(matches(SHA, value['source']) and matches(DIGEST, value['resourceEnvelopeDigest']),
                'Missing accepted source or resource envelope')
        require(isinstance(value['build'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['build']) is not None,
                'Invalid accepted build')
        require(matches(DIGEST, value['reloadGuardDigest']), 'Missing guarded reload identity')
        require(matches(DIGEST, value['controllerDigest']), 'Missing accepted controller identity')
        require(value['nginxBinary'] == '/usr/sbin/nginx' and value['nginxUnit'] in ('nginx.service', 'aihr-admission-nginx.service'),
                'Unsupported proxy executable or service')
        require(isinstance(value['ports'], list) and 2 <= len(value['ports']) <= 512
                and all(type(port) is int and 1024 <= port <= 65535 for port in value['ports'])
                and len(set(value['ports'])) == len(value['ports']), 'Invalid endpoint pool')
        require(type(value['controlPort']) is int and 1024 <= value['controlPort'] <= 65535
                and value['controlPort'] not in value['ports'], 'Invalid control endpoint')
        require(isinstance(value['units'], dict) and 1 <= len(value['units']) <= 8, 'Invalid worker inventory')
        for name, spec in value['units'].items():
            require(matches(UNIT, name), 'Unsupported worker service')
            exact_keys(spec, {'environmentFile', 'releaseDirectory', 'workerUid', 'commandDigest', 'executable'})
            require(type(spec['workerUid']) is int and spec['workerUid'] > 0
                    and matches(DIGEST, spec['commandDigest']), 'Invalid worker principal or command')
            for key in ('environmentFile', 'releaseDirectory', 'executable'):
                require(managed_path(spec[key]), 'Unsafe worker path')
        require(len(value['ports']) >= len(value['units']) * 2, 'Endpoint pool cannot overlap worker generations')
        for key, ceiling in [('healthSeconds', 120), ('activationSeconds', 10), ('drainSeconds', 120)]:
            require(type(value[key]) is int and 1 <= value[key] <= ceiling, 'Invalid lifecycle bound')
        for key in ('stateDirectory', 'nginxConfig', 'nginxPrefix', 'nginxPid', 'managedInclude'):
            require(managed_path(value[key]), 'Unsafe proxy path')
        self.path, self.uid, self.value, self.sha = path, uid, value, hashlib.sha256(raw).hexdigest()
        self.root = pathlib.Path(value['stateDirectory'])
        secure_path(self.root, uid, directory=True)
        secure_path(pathlib.Path(value['managedInclude']).parent, uid, directory=True)
        for spec in value['units'].values():
            secure_path(pathlib.Path(spec['environmentFile']).parent, uid, directory=True)
        self.assert_current()

    def assert_current(self) -> None:
        secure_path(self.path, self.uid)
        require(hashlib.sha256(self.path.read_bytes()).hexdigest() == self.sha, 'Deployment profile changed during admission')


class Store:
    def __init__(self, profile: Profile):
        self.profile, self.file = profile, profile.root / 'state.json'

    @contextlib.contextmanager
    def locked(self):
        path = self.profile.root / 'control.lock'
        if path.exists() or path.is_symlink():
            secure_path(path, self.profile.uid)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < deadline, 'Admission configuration is occupied')
                    time.sleep(0.025)
            self.profile.assert_current()
            yield
        finally:
            os.close(fd)

    def read(self) -> dict[str, Any]:
        secure_path(self.file, self.profile.uid)
        raw = self.file.read_bytes()
        require(len(raw) <= 8_000_000, 'Admission inventory exceeds its supported size')
        try:
            value = json.loads(raw)
        except ValueError:
            raise Refused('Invalid admission inventory') from None
        exact_keys(value, {'version', 'boot', 'epoch', 'sequence', 'generations', 'current', 'published', 'pending'})
        require(value['version'] == 1 and type(value['sequence']) is int and value['sequence'] >= 0
                and isinstance(value['generations'], dict) and len(value['generations']) <= 4096
                and isinstance(value['current'], dict), 'Unsupported admission inventory')
        return value

    def save(self, value: dict[str, Any]) -> None:
        atomic_write(self.file, (json.dumps(value, sort_keys=True) + '\n').encode(), self.profile.uid)


def command_identity(raw: str) -> str:
    match = re.fullmatch(r'\{ path=([^;\n]+) ; argv\[\]=([^;\n]+) ; ignore_errors=(?:yes|no) ; .* \}', raw)
    require(match is not None, 'Unsupported service command representation')
    return digest({'path': match[1].strip(), 'argv': match[2].strip()})


class LinuxHost:
    def __init__(self, profile: Profile):
        self.profile = profile

    def boot(self) -> str:
        return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

    def properties(self, unit: str) -> dict[str, str]:
        require(unit in self.profile.value['units'] or unit == self.profile.value['nginxUnit'], 'Service is not in the installation profile')
        keys = ['InvocationID', 'MainPID', 'ControlPID', 'KillMode', 'Delegate', 'User', 'WorkingDirectory', 'ExecStart', 'ExecReload', 'ActiveState', 'SubState', 'ControlGroup',
                'Environment', 'EnvironmentFiles', 'PassEnvironment', 'PAMName', 'RootDirectory', 'RootImage',
                'DynamicUser', 'FragmentPath', 'DropInPaths', 'LoadCredential', 'LoadCredentialEncrypted',
                'SetCredential', 'SetCredentialEncrypted', 'ImportCredential']
        try:
            result = subprocess.run(['/usr/bin/systemctl', '--system', 'show', unit,
                                     '--property=' + ','.join(keys)], env=SAFE_ENV,
                                    capture_output=True, text=True, timeout=3, check=True)
        except (OSError, subprocess.SubprocessError):
            raise Refused('Cannot inspect the configured service') from None
        require(len(result.stdout) <= 32768, 'Service metadata exceeds its bound')
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def check_only(self) -> dict[str, Any]:
        """Read-only boundary inspection, never an installation/grant receipt.

        Run initially from an already trusted, clean root environment. Merely
        placing a privileged Python hook in an unsafe service would be too late:
        the dynamic loader processes LD_PRELOAD before Python's -I takes effect.
        """
        inspected = 0
        for unit, spec in self.profile.value['units'].items():
            props = self.properties(unit)
            self.release(spec)
            try:
                uid = pwd.getpwnam(props.get('User', '')).pw_uid
            except KeyError:
                raise Refused('Unexpected worker principal') from None
            require(uid == spec['workerUid'] and uid > 0 and props.get('DynamicUser') == 'no',
                    'A fixed nonroot worker principal is required')
            require(props.get('KillMode') == 'control-group' and props.get('Delegate') == 'no',
                    'Worker process containment is not qualified')
            require(props.get('WorkingDirectory') == spec['releaseDirectory']
                    and command_identity(props.get('ExecStart', '')) == spec['commandDigest'],
                    'Worker service identity differs from its profile')
            for key in ('PassEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'LoadCredential',
                        'LoadCredentialEncrypted', 'SetCredential', 'SetCredentialEncrypted', 'ImportCredential'):
                require(props.get(key) == '', 'Privileged-hook environment source is not qualified')
            def reject_loader(text: str) -> None:
                require(re.search(r'(?:^|[\s\"\x27])(?:export\s+)?(?:LD_[A-Za-z0-9_]*|DYLD_[A-Za-z0-9_]*|PYTHON[A-Za-z0-9_]*)\s*=', text) is None,
                        'Privileged-hook loader environment is not qualified')
            reject_loader(props.get('Environment', ''))
            configured = props.get('EnvironmentFiles', '')
            pattern = re.compile(r'([/A-Za-z0-9_.@-]+) \(ignore_errors=(yes|no)\)(?: |$)')
            offset, count = 0, 0
            while offset < len(configured):
                match = pattern.match(configured, offset)
                require(match is not None and count < 32, 'Unsupported privileged-hook environment file syntax')
                name = pathlib.Path(match[1])
                require(managed_path(str(name)), 'Unsafe privileged-hook environment path')
                secure_path(name.parent, 0, directory=True)
                try:
                    name.lstat()
                except FileNotFoundError:
                    require(match[2] == 'yes', 'Required privileged-hook environment file is missing')
                else:
                    secure_path(name, 0)
                    require(name.stat().st_size <= 1_048_576, 'Privileged-hook environment file exceeds its bound')
                    reject_loader(name.read_text())
                offset, count = match.end(), count + 1
            for name in [props.get('FragmentPath', ''), *props.get('DropInPaths', '').split()]:
                require(managed_path(name), 'Unsupported worker unit configuration path')
                secure_path(pathlib.Path(name), 0)
            secure_path(pathlib.Path(spec['executable']), 0)
            # Strict initial profile: immutable runtime/code bytes cannot hide
            # an application-writable child or link. A future installer may
            # adopt reviewed internal links only through its bound inventory.
            def walk_error(_error: OSError) -> None:
                raise Refused('Cannot inspect the complete immutable release inventory')
            for parent, directories, files in os.walk(spec['releaseDirectory'], followlinks=False, onerror=walk_error):
                for name in [*directories, *files]:
                    inspected += 1
                    require(inspected <= 500_000, 'Immutable release inventory exceeds its supported bound')
                    child = pathlib.Path(parent, name)
                    secure_path(child, 0, directory=child.is_dir())
        secure_path(pathlib.Path(self.profile.value['nginxConfig']), 0)
        secure_path(pathlib.Path(self.profile.value['nginxBinary']), 0)
        return {'kind': 'ADMISSION_CHECKONLY', 'installationAvailable': False, 'releaseEligible': False,
                'rootBoundaryInspected': True, 'immutableEntriesInspected': inspected,
                'remainingInstallationGates': ['authenticated-format3-grant-and-shared-lease',
                    'complete-nginx-runtime-and-include-inventory', 'resource-envelope-admission',
                    'old-new-build-and-server-action-compatibility', 'real-next-transport-and-worker-qualification']}

    def release(self, spec: dict[str, Any]) -> None:
        root = pathlib.Path(spec['releaseDirectory'])
        secure_path(root, self.profile.uid, directory=True)
        identity = root / '.aihr-admission-release.json'
        build = root / '.next/BUILD_ID'
        secure_path(identity, self.profile.uid)
        secure_path(build, self.profile.uid)
        require(identity.stat().st_size <= 1024 and build.stat().st_size <= 1024, 'Release identity exceeds its bound')
        try:
            declared = json.loads(identity.read_text())
        except ValueError:
            raise Refused('Invalid immutable release identity') from None
        require(declared == {'source': self.profile.value['source'], 'build': self.profile.value['build']}
                and build.read_text().strip() == self.profile.value['build'], 'Release does not match the admitted source and build')

    def invocation(self, unit: str, invocation: str) -> dict[str, str]:
        props = self.properties(unit)
        spec = self.profile.value['units'][unit]
        require(HEX32.fullmatch(invocation) is not None and props.get('InvocationID') == invocation,
                'Stale service invocation')
        try:
            uid = pwd.getpwnam(props.get('User', '')).pw_uid
        except KeyError:
            raise Refused('Unexpected worker principal') from None
        require(uid == spec['workerUid'] and props.get('WorkingDirectory') == spec['releaseDirectory']
                and command_identity(props.get('ExecStart', '')) == spec['commandDigest'], 'Worker service identity differs from its profile')
        require(props.get('KillMode') == 'control-group' and props.get('Delegate') == 'no',
                'Worker process containment is not qualified')
        self.release(spec)
        return props

    def worker(self, unit: str, invocation: str, port: int) -> dict[str, int]:
        props = self.invocation(unit, invocation)
        require(admitting_phase(props), 'Worker service is not in an admitting phase')
        require(props.get('MainPID', '').isdigit(), 'Worker has no process identity')
        pid = int(props['MainPID'])
        identity = process_identity(pid)
        require(identity is not None and pid > 1, 'Worker process has exited')
        spec = self.profile.value['units'][unit]
        try:
            require(pathlib.Path('/proc', str(pid)).stat().st_uid == spec['workerUid'], 'Worker process owner changed')
            require(os.path.realpath('/proc/' + str(pid) + '/exe') == spec['executable']
                    and os.path.realpath('/proc/' + str(pid) + '/cwd') == spec['releaseDirectory'], 'Worker executable or release changed')
        except OSError:
            raise Refused('Cannot inspect the worker process') from None
        if not self.owns_listener(identity, port):
            if self.port_free(port):
                raise EndpointNotReady('Worker has not opened its generation endpoint')
            raise Refused('Another process owns the generation endpoint')
        require(alive(identity), 'Worker process changed during inspection')
        final = self.invocation(unit, invocation)
        require(admitting_phase(final) and final.get('MainPID') == str(pid),
                'Worker service stopped or changed during inspection')
        return identity

    def reservation_invocation(self, unit: str, invocation: str) -> dict[str, str]:
        props = self.invocation(unit, invocation)
        require((props.get('ActiveState'), props.get('SubState')) == ('activating', 'start-pre'),
                'Worker reservation requires its native prestart phase')
        group = props.get('ControlGroup', '')
        require(group.startswith('/') and group != '/' and '..' not in pathlib.Path(group).parts,
                'Worker has no native control group')
        return props

    def generation_dead(self, generation: dict[str, Any]) -> bool:
        """Positive native proof only. False includes all uncertainty.

        A missing saved PID is not proof: a worker may have bound its socket
        before a readiness callback recorded MainPID. Inspect the original
        native cgroup, unit state, current process family and endpoint instead.
        """
        try:
            if generation.get('process') is not None and alive(generation['process']):
                return False
            props = self.properties(generation['unit'])
            group = generation.get('controlGroup', '')
            require(group.startswith('/') and group != '/' and '..' not in pathlib.Path(group).parts,
                    'Original worker control group is unknown')
            require(props.get('KillMode') == 'control-group' and props.get('Delegate') == 'no',
                    'Worker process containment is not qualified')
            directory = pathlib.Path('/sys/fs/cgroup', group.lstrip('/'))
            secure_path(directory.parent, 0, directory=True)
            try:
                directory.lstat()
            except FileNotFoundError:
                members = []
            else:
                secure_path(directory, 0, directory=True)
                secure_path(directory / 'cgroup.procs', 0)
                members = (directory / 'cgroup.procs').read_text().split()
            require(len(members) <= 1024 and all(value.isdigit() for value in members),
                    'Unbounded or invalid worker control group')
            require(props.get('MainPID', '').isdigit() and props.get('ControlPID', '').isdigit(),
                    'Worker unit process inventory is unknown')
            main, control = int(props['MainPID']), int(props['ControlPID'])
            if not members:
                require(main == control == 0 and props.get('ActiveState') in ('inactive', 'failed'),
                        'Worker generation is not natively quiescent')
            else:
                # A newer invocation may already be running by the time the
                # timer notices an interrupted old cleanup. Every cgroup member
                # must positively belong to the current MainPID/ControlPID
                # family; an old/orphan/uninspectable process retains the port.
                require(props.get('InvocationID') != generation['invocation']
                        and matches(HEX32, props.get('InvocationID')) and admitting_phase(props)
                        and props.get('ControlGroup') == group and main > 1,
                        'Original worker invocation may still be live')
                processes = {}
                for value in members:
                    pid = int(value)
                    identity = process_identity(pid)
                    require(identity is not None, 'Worker cgroup changed during inspection')
                    raw = pathlib.Path('/proc', value, 'stat').read_text()
                    fields = raw[raw.rfind(')') + 2:].split()
                    require(int(fields[19]) == identity['startTicks'], 'Worker process identity changed')
                    processes[pid] = (identity, int(fields[1]))
                roots = {pid for pid in (main, control) if pid > 1}
                require(roots <= set(processes), 'Current worker process family is incomplete')
                for pid in processes:
                    cursor, visited = pid, set()
                    while cursor not in roots:
                        require(cursor in processes and cursor not in visited, 'An unrelated worker process remains')
                        visited.add(cursor)
                        cursor = processes[cursor][1]
                require(all(alive(identity) for identity, _parent in processes.values())
                        and set((directory / 'cgroup.procs').read_text().split()) == set(members),
                        'Worker cgroup changed during inspection')
            after = self.properties(generation['unit'])
            keys = ('InvocationID', 'MainPID', 'ControlPID', 'ActiveState', 'SubState', 'ControlGroup', 'KillMode', 'Delegate')
            require(all(after.get(key) == props.get(key) for key in keys), 'Worker unit changed during inspection')
            require(self.port_free(generation['port']), 'Generation endpoint is still bound')
            return generation.get('process') is None or not alive(generation['process'])
        except (Refused, OSError, ValueError, IndexError):
            return False

    def owns_listener(self, identity: dict[str, int], port: int) -> bool:
        try:
            inodes = set()
            for line in pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]:
                fields = line.split()
                if fields[1] == '0100007F:' + format(port, '04X') and fields[3] == '0A':
                    inodes.add(fields[9])
            owned = set()
            for fd in pathlib.Path('/proc', str(identity['pid']), 'fd').iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue  # An unrelated descriptor may close during startup.
                if target.startswith('socket:['):
                    owned.add(target[8:-1])
            return alive(identity) and bool(inodes & owned)
        except (OSError, ValueError, IndexError):
            return False

    def port_free(self, port: int) -> bool:
        with socket.socket() as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return True
            except OSError:
                return False

    def health(self, port: int) -> bool:
        return self.request(port, '/health') == (200, b'{"status":"ok"}\n')

    def request(self, port: int, path: str) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
        try:
            connection.request('GET', path, headers={'Connection': 'close', 'Host': '127.0.0.1'})
            response = connection.getresponse()
            body = response.read(4097)
            return (response.status, body) if len(body) <= 4096 else (0, b'')
        except (OSError, http.client.HTTPException):
            return 0, b''
        finally:
            connection.close()

    def proxy_master(self) -> dict[str, int]:
        path = pathlib.Path(self.profile.value['nginxPid'])
        secure_path(path, self.profile.uid)
        try:
            pid = int(path.read_text().strip())
        except ValueError:
            raise Refused('Invalid proxy master identity') from None
        identity = process_identity(pid)
        props = self.properties(self.profile.value['nginxUnit'])
        require(identity is not None and str(pid) == props.get('MainPID')
                and (props.get('ActiveState') == 'active' or
                     props.get('ActiveState') == 'activating' and props.get('SubState') == 'start-post'),
                'Proxy master is not the configured active service')
        require(command_identity(props.get('ExecReload', '')) == self.profile.value['reloadGuardDigest'],
                'Proxy reload does not use the accepted shared guard')
        require(os.path.realpath('/proc/' + str(pid) + '/exe') == self.profile.value['nginxBinary'],
                'Unexpected proxy executable')
        return identity

    def proxy_workers(self, master: dict[str, int]) -> list[dict[str, int]]:
        require(alive(master), 'Proxy master changed')
        try:
            group = self.properties(self.profile.value['nginxUnit']).get('ControlGroup', '')
            require(group.startswith('/') and '..' not in pathlib.Path(group).parts, 'Unverified proxy control group')
            # Include old/orphaned workers still in the service's cgroup, not
            # merely children of the newest master PID.
            children = pathlib.Path('/sys/fs/cgroup', group.lstrip('/'), 'cgroup.procs').read_text().split()
            result = []
            for child in children:
                pid = int(child)
                identity = process_identity(pid)
                # A just-forked worker can still have its inherited master
                # process title. Retain every native Nginx child, including
                # transient/cache helpers; never rely on a title race.
                if pid != master['pid'] and identity is not None \
                        and os.path.realpath('/proc/' + child + '/exe') == self.profile.value['nginxBinary'] \
                        and alive(identity):
                    result.append(identity)
            require(bool(result), 'Proxy has no verifiable worker generation')
            return result
        except (OSError, ValueError):
            raise Refused('Cannot inspect proxy worker generations') from None

    def validate_proxy(self) -> None:
        try:
            result = subprocess.run([self.profile.value['nginxBinary'], '-t', '-c', self.profile.value['nginxConfig'],
                                     '-p', self.profile.value['nginxPrefix']], env=SAFE_ENV,
                                    capture_output=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            raise Refused('Proxy validation could not complete') from None
        require(result.returncode == 0, 'Proxy rejected the proposed configuration')

    def reload_proxy(self, master: dict[str, int]) -> None:
        require(self.proxy_master() == master, 'Proxy master changed before reload')
        os.kill(master['pid'], signal.SIGHUP)


def merge_readers(*groups: list[dict[str, int]]) -> list[dict[str, int]]:
    return list({(row['pid'], row['startTicks']): row for group in groups for row in group}.values())


class Controller:
    def __init__(self, profile: Profile, host: LinuxHost):
        self.profile, self.host, self.store = profile, host, Store(profile)

    def render(self, revision: str, ports: list[int]) -> bytes:
        # Only validated integers and generated hexadecimal revision text enter
        # Nginx syntax. Location headers/body/timeouts remain their existing owner.
        require(HEX32.fullmatch(revision) is not None and set(ports) <= set(self.profile.value['ports']),
                'Invalid generated proxy inventory')
        servers = ''.join('    server 127.0.0.1:' + str(port) + ';\n' for port in sorted(ports))
        if not servers:
            servers = '    server 127.0.0.1:9 down;\n'
        return ('# Managed exclusively by aihr-admission; do not reload outside its guard.\n'
                'upstream aihr_ready_workers {\n' + servers + '}\n'
                'server {\n    listen 127.0.0.1:' + str(self.profile.value['controlPort']) + ';\n'
                '    access_log off;\n    location = /__aihr_admission_revision {\n'
                '        default_type text/plain;\n        return 200 "' + revision + '\\n";\n'
                '    }\n    location / { return 404; }\n}\n').encode()

    def state(self) -> dict[str, Any]:
        state = self.store.read()
        require(state['boot'] == self.host.boot(), 'Reboot requires explicit admission reconciliation')
        return state

    def initialize(self) -> None:
        with self.store.locked():
            require(not self.store.file.exists(), 'Admission inventory already exists')
            include = pathlib.Path(self.profile.value['managedInclude'])
            require(not include.exists() and not include.is_symlink(), 'Managed proxy include already exists')
            state = {'version': 1, 'boot': self.host.boot(), 'epoch': self.profile.value['epoch'], 'sequence': 0,
                     'generations': {}, 'current': {}, 'published': {'revision': None, 'ready': []}, 'pending': None}
            self.store.save(state)
            self.publish(state, [])

    def prepare_proxy(self) -> None:
        """Nginx ExecStartPre: disk UP state is never replayed into a new master."""
        with self.store.locked():
            props = self.host.properties(self.profile.value['nginxUnit'])
            require(props.get('MainPID') in ('0', ''), 'Cannot prepare an already running proxy')
            if self.store.file.exists():
                state = self.store.read()
                if state['boot'] != self.host.boot():
                    for generation in state['generations'].values():
                        generation['process'], generation['readers'], generation['phase'] = None, [], 'RELEASED'
                else:
                    for generation in state['generations'].values():
                        if generation['phase'] == 'READY':
                            generation['phase'] = 'WARMING'
                state['boot'] = self.host.boot()
            else:
                state = {'version': 1, 'boot': self.host.boot(), 'epoch': self.profile.value['epoch'], 'sequence': 0,
                         'generations': {}, 'current': {}, 'published': {'revision': None, 'ready': []}, 'pending': None}
            revision = secrets.token_hex(16)
            state['published'] = {'revision': None, 'ready': []}
            state['pending'] = {'revision': revision, 'ready': [], 'master': None, 'readers': [], 'bootstrap': True}
            self.store.save(state)
            atomic_write(pathlib.Path(self.profile.value['managedInclude']), self.render(revision, []), self.profile.uid)
            self.host.validate_proxy()

    def confirm_proxy(self) -> None:
        """Nginx ExecStartPost proves DOWN activation; timers recheck old workers."""
        with self.store.locked():
            state = self.state()
            pending = state['pending']
            require(pending is not None and pending.get('bootstrap') is True, 'Proxy bootstrap is not pending')
            master = self.host.proxy_master()
            deadline = time.monotonic() + self.profile.value['activationSeconds']
            while self.host.request(self.profile.value['controlPort'], '/__aihr_admission_revision') != \
                    (200, (pending['revision'] + '\n').encode()):
                require(self.host.proxy_master() == master and time.monotonic() < deadline,
                        'Proxy bootstrap activation is unverified')
                time.sleep(0.025)
            state['published'] = {'revision': pending['revision'], 'ready': []}
            state['pending'] = None
            self.store.save(state)

    def publish(self, state: dict[str, Any], ready: list[str], *, force: bool = False,
                recover_pending: bool = False) -> None:
        """Caller holds the common lock, including for external Nginx reloads.

        Persist intent before touching config. On uncertainty retain every port
        and block ordinary transitions until explicit reconciliation succeeds.
        """
        prior_pending = copy.deepcopy(state['pending'])
        require(prior_pending is None or recover_pending and not prior_pending.get('bootstrap'),
                'Proxy publication requires reconciliation')
        require(len(set(ready)) == len(ready) and all(item in state['generations'] for item in ready),
                'Unknown ready generation')
        if prior_pending is None and not force and state['published']['revision'] is not None and ready == state['published']['ready']:
            self.store.save(state)
            return
        master = self.host.proxy_master()
        previous_ready = set(state['published']['ready'])
        if prior_pending:
            previous_ready.update(prior_pending['ready'])
            previous_ready.update(prior_pending.get('previousReady', []))
        require(previous_ready <= set(state['generations']), 'Unknown possibly exposed generation')
        readers = self.host.proxy_workers(master)
        for generation in state['generations'].values():
            if generation['id'] in previous_ready:
                generation['readers'] = merge_readers(generation['readers'], readers,
                                                      prior_pending['readers'] if prior_pending else [])
        revision = secrets.token_hex(16)
        state['pending'] = {'revision': revision, 'ready': ready, 'previousReady': sorted(previous_ready),
                            'master': master, 'readers': readers}
        self.store.save(state)
        path = pathlib.Path(self.profile.value['managedInclude'])
        previous = path.read_bytes() if path.exists() else None
        atomic_write(path, self.render(revision, [state['generations'][item]['port'] for item in ready]), self.profile.uid)
        try:
            self.host.validate_proxy()
        except Refused:
            if previous is not None:
                atomic_write(path, previous, self.profile.uid)
            else:
                path.unlink()
            state['pending'] = prior_pending
            self.store.save(state)
            raise
        self.host.reload_proxy(master)
        deadline = time.monotonic() + self.profile.value['activationSeconds']
        while True:
            require(self.host.proxy_master() == master, 'Proxy master changed during activation')
            if self.host.request(self.profile.value['controlPort'], '/__aihr_admission_revision') == (200, (revision + '\n').encode()):
                break
            require(time.monotonic() < deadline, 'Proxy activation is unverified; reconciliation required')
            time.sleep(0.025)
        new_readers = self.host.proxy_workers(master)
        for item in set(previous_ready) | set(ready):
            generation = state['generations'][item]
            generation['readers'] = merge_readers(generation['readers'], new_readers)
        state['published'] = {'revision': revision, 'ready': ready}
        removing = set(previous_ready) - set(ready)
        # First activation proves no future child can inherit the removed
        # config, but its conservative reader superset still needs a barrier.
        # Journal that obligation BEFORE acknowledging/starting its second HUP.
        # A crash or validation failure must not leave current false-positive
        # readers permanently retaining the endpoint with no recovery work.
        state['pending'] = {'revision': revision, 'ready': ready, 'previousReady': ready,
                            'master': master, 'readers': new_readers, 'retirementBarrier': True} if removing else None
        self.store.save(state)
        if removing:
            # Between the first snapshot and HUP the master could have forked
            # another old-config child. Conservatively retain all post-proof
            # children above, then retire that superset with a same-config
            # barrier. After the first revision proof no future child can be
            # born from the removed config. The barrier's newer children never
            # inherit the retired endpoint and need not block its drain.
            self.publish(state, ready, force=True, recover_pending=True)

    def begin(self) -> None:
        with self.store.locked():
            state = self.state()
            require(state['pending'] is None, 'Proxy publication requires reconciliation')
            require(all((generation['source'], generation['build']) ==
                        (self.profile.value['source'], self.profile.value['build'])
                        for generation in state['generations'].values() if generation['phase'] != 'RELEASED'),
                    'Cross-build overlap requires a qualified compatibility-window installation contract')
            state['epoch'] = self.profile.value['epoch']
            self.store.save(state)

    def reserve(self, unit: str, invocation: str) -> dict[str, Any]:
        require(unit in self.profile.value['units'], 'Unknown worker service')
        native = self.host.reservation_invocation(unit, invocation)
        with self.store.locked():
            state = self.state()
            require(state['pending'] is None and state['epoch'] == self.profile.value['epoch'], 'Deployment admission is not current')
            # First start allocates; a retried PreStart for the exact invocation
            # is idempotent and never changes its endpoint underneath a process.
            prior_id = state['current'].get(unit)
            if prior_id:
                prior = state['generations'][prior_id]
                if prior['invocation'] == invocation and prior['epoch'] == state['epoch']:
                    require(prior['phase'] == 'WARMING', 'Invocation already progressed beyond reservation')
                    # A previous PreStart may have died after the state commit
                    # but before the environment overlay reached durable storage.
                    atomic_write(pathlib.Path(self.profile.value['units'][unit]['environmentFile']),
                                 ('PORT=' + str(prior['port']) + '\n').encode(), self.profile.uid)
                    return copy.deepcopy(prior)
                require(prior.get('process') is None or not alive(prior['process']), 'Drain and stop the previous worker before replacement')
                if prior['phase'] != 'RELEASED':
                    prior['phase'] = 'RETIRED'
            ready = [item for item in state['published']['ready'] if item != prior_id]
            self.publish(state, ready)
            reserved = {generation['port'] for generation in state['generations'].values() if generation['phase'] != 'RELEASED'}
            port = next((candidate for candidate in self.profile.value['ports']
                         if candidate not in reserved and self.host.port_free(candidate)), None)
            require(port is not None, 'Generation endpoint pool is exhausted; no uncertain endpoint may be reused')
            generation_id = secrets.token_hex(16)
            state['sequence'] += 1
            generation = {'id': generation_id, 'unit': unit, 'invocation': invocation, 'epoch': state['epoch'],
                          'source': self.profile.value['source'], 'build': self.profile.value['build'],
                          'profile': self.profile.sha, 'port': port, 'phase': 'WARMING', 'process': None,
                          'readers': [], 'sequence': state['sequence'], 'controlGroup': native['ControlGroup']}
            state['generations'][generation_id] = generation
            state['current'][unit] = generation_id
            self.store.save(state)
            atomic_write(pathlib.Path(self.profile.value['units'][unit]['environmentFile']),
                         ('PORT=' + str(port) + '\n').encode(), self.profile.uid)
            return copy.deepcopy(generation)

    def admit(self, unit: str, invocation: str) -> None:
        with self.store.locked():
            state = self.state()
            generation = copy.deepcopy(state['generations'].get(state['current'].get(unit), {}))
            if generation.get('phase') == 'READY' and generation.get('invocation') == invocation \
                    and generation.get('epoch') == state['epoch'] == self.profile.value['epoch'] \
                    and generation.get('profile') == self.profile.sha and generation['id'] in state['published']['ready']:
                require(self.host.worker(unit, invocation, generation['port']) == generation['process'], 'Ready worker changed')
                return
            require(generation.get('phase') == 'WARMING' and generation.get('invocation') == invocation
                    and generation.get('epoch') == state['epoch'] == self.profile.value['epoch']
                    and generation.get('profile') == self.profile.sha, 'Stale warming generation')
        deadline = time.monotonic() + self.profile.value['healthSeconds']
        while True:
            self.profile.assert_current()
            try:
                identity = self.host.worker(unit, invocation, generation['port'])
                if self.host.health(generation['port']):
                    break
            except EndpointNotReady:
                pass
            require(time.monotonic() < deadline, 'Worker did not establish readiness')
            time.sleep(0.05)
        # Health is never enough: recheck the exact live process/socket/release
        # and current epoch after reacquiring the lock, immediately before UP.
        with self.store.locked():
            state = self.state()
            current = state['generations'].get(state['current'].get(unit), {})
            if current.get('phase') == 'READY' and current.get('id') == generation['id'] \
                    and current.get('invocation') == invocation and current.get('process') == identity \
                    and state['epoch'] == generation['epoch'] and current['id'] in state['published']['ready']:
                require(self.host.worker(unit, invocation, generation['port']) == identity, 'Ready worker changed')
                return
            require(state['pending'] is None and current == generation and state['epoch'] == generation['epoch'],
                    'Readiness callback no longer owns the current generation')
            require(self.host.worker(unit, invocation, generation['port']) == identity,
                    'Worker changed after readiness')
            current['process'] = identity
            self.store.save(state)
            self.publish(state, [*state['published']['ready'], generation['id']])
            try:
                require(self.host.worker(unit, invocation, generation['port']) == identity,
                        'Worker stopped or changed during proxy publication')
            except Refused:
                current['phase'] = 'RETIRED'
                self.store.save(state)
                self.publish(state, [item for item in state['published']['ready'] if item != generation['id']])
                raise
            current['phase'] = 'READY'
            self.store.save(state)

    def withdraw(self, unit: str, invocation: str, *, crash: bool = False) -> str:
        with self.store.locked():
            state = self.state()
            item = state['current'].get(unit)
            require(item is not None, 'Worker has no reserved generation')
            generation = state['generations'][item]
            require(generation['invocation'] == invocation, 'Stale cleanup cannot remove a replacement')
            require(state['pending'] is None, 'Proxy publication requires reconciliation')
            self.publish(state, [key for key in state['published']['ready'] if key != item])
            generation['phase'] = 'RETIRED' if crash else 'DRAINING'
            self.store.save(state)
            return item

    def drain(self, unit: str, invocation: str) -> dict[str, Any]:
        item = self.withdraw(unit, invocation)
        deadline = time.monotonic() + self.profile.value['drainSeconds']
        while True:
            with self.store.locked():
                state = self.state()
                generation = state['generations'][item]
                require(generation['phase'] == 'DRAINING', 'Drain generation changed')
                if not any(alive(reader) for reader in generation['readers']):
                    generation['phase'] = 'DRAINED'
                    self.store.save(state)
                    return {'generation': item, 'unit': unit, 'invocation': invocation, 'safeToStop': True}
            require(time.monotonic() < deadline, 'Drain deadline reached; retain the old process and endpoint')
            time.sleep(0.05)

    def reconcile(self) -> None:
        recover = []
        with self.store.locked():
            state = self.store.read()
            publication_uncertain = state['boot'] != self.host.boot() or state['pending'] is not None
            if state['boot'] != self.host.boot():
                # A new boot has no living old proxy/process identities. Never
                # restore UP from disk; rewrite DOWN before any worker start.
                state['boot'] = self.host.boot()
                for generation in state['generations'].values():
                    generation['phase'], generation['process'], generation['readers'] = 'RETIRED', None, []
                state['published']['ready'] = []
            # Preserve the entire durable pending/exposed endpoint union into
            # publish. Clearing it after one reader snapshot would lose an ADD
            # candidate absent from the acknowledged list and miss a later fork.
            if state['pending']:
                require(not state['pending'].get('bootstrap'), 'Proxy bootstrap must be confirmed before reconciliation')
            ready = []
            for item in state['published']['ready']:
                generation = state['generations'][item]
                if generation['phase'] == 'READY' and generation['process'] is not None:
                    try:
                        require(self.host.worker(generation['unit'], generation['invocation'], generation['port'])
                                == generation['process'], 'Ready worker identity changed')
                        ready.append(item)
                        continue
                    except Refused:
                        pass  # Unpublish known stopping or uncertain services.
                generation['phase'] = 'WARMING'
            # The ready list can equal the last acknowledged list even while a
            # different unacknowledged config is serving. Always replace/prove a
            # fresh revision after uncertainty; equality is not activation proof.
            self.publish(state, ready, force=publication_uncertain, recover_pending=state['pending'] is not None)
            for generation in state['generations'].values():
                native_dead = generation['id'] not in state['published']['ready'] and generation['phase'] != 'RELEASED' \
                    and self.host.generation_dead(generation)
                if native_dead:
                    generation['phase'] = 'RETIRED'
                if generation['phase'] == 'WARMING' and generation['process'] is not None \
                        and generation['epoch'] == state['epoch'] and generation['profile'] == self.profile.sha:
                    recover.append((generation['unit'], generation['invocation']))
                if generation['phase'] in ('RETIRED', 'DRAINED') and not any(alive(reader) for reader in generation['readers']) \
                        and native_dead:
                    generation['phase'] = 'RELEASED'
            # Keep a bounded recent history. No live, uncertain, or currently
            # referenced generation is removed; sequence numbers never reset.
            removable = sorted((row for row in state['generations'].values()
                                if row['phase'] == 'RELEASED' and row['id'] not in state['current'].values()),
                               key=lambda row: row['sequence'])
            for generation in removable[:-256]:
                del state['generations'][generation['id']]
            self.store.save(state)
        recovery_failed = False
        for unit, invocation in recover:
            # A restarted proxy begins DOWN. Existing live application processes
            # regain admission only through the same complete health/identity CAS.
            try:
                self.admit(unit, invocation)
            except Refused:
                recovery_failed = True  # Remains DOWN; never report recovery as healthy.
        require(not recovery_failed, 'Some workers remain unadmitted after reconciliation')

    def reload(self) -> None:
        with self.store.locked():
            state = self.state()
            self.publish(state, state['published']['ready'].copy(), force=True)

    def status(self) -> dict[str, Any]:
        with self.store.locked():
            state = self.store.read()
            return {'version': state['version'], 'bootMatches': state['boot'] == self.host.boot(),
                    'epoch': state['epoch'], 'publicationPending': state['pending'] is not None,
                    'publishedRevision': state['published']['revision'],
                    'workers': [{'unit': name, 'generation': item,
                                 'phase': state['generations'][item]['phase'],
                                 'port': state['generations'][item]['port'],
                                 'admitted': item in state['published']['ready']}
                                for name, item in state['current'].items()]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['check-only', 'initialize', 'prepare-proxy', 'confirm-proxy', 'begin', 'reserve', 'admit', 'cleanup', 'drain', 'reconcile', 'reload', 'status'])
    parser.add_argument('unit', nargs='?')
    args = parser.parse_args()
    try:
        require(sys.platform == 'linux' and os.geteuid() == 0, 'The installed admission controller requires Linux root')
        require(pathlib.Path(__file__).absolute() == INSTALLED, 'Use the root-owned installed admission controller')
        secure_path(INSTALLED, 0)
        profile = Profile(PROFILE)
        require(hashlib.sha256(INSTALLED.read_bytes()).hexdigest() == profile.value['controllerDigest'],
                'Installed controller differs from its accepted profile')
        controller = Controller(profile, LinuxHost(profile))
        if args.operation in ('reserve', 'admit', 'cleanup', 'drain'):
            require(args.unit in profile.value['units'], 'Unknown worker service')
            invocation = os.environ.get('INVOCATION_ID', '')
            if args.operation == 'drain':
                # A release controller is not inside the app invocation. Query
                # its current identity; a concurrent replacement still fails CAS.
                invocation = controller.host.properties(args.unit).get('InvocationID', '')
            require(HEX32.fullmatch(invocation) is not None, 'Missing native service invocation identity')
            if args.operation == 'reserve':
                controller.reserve(args.unit, invocation)
            elif args.operation == 'admit':
                controller.admit(args.unit, invocation)
            elif args.operation == 'cleanup':
                controller.withdraw(args.unit, invocation, crash=True)
            else:
                print(json.dumps(controller.drain(args.unit, invocation), sort_keys=True))
        else:
            require(args.unit is None, 'This operation accepts no service argument')
            if args.operation == 'check-only':
                print(json.dumps(controller.host.check_only(), sort_keys=True))
            elif args.operation == 'status':
                print(json.dumps(controller.status(), sort_keys=True))
            else:
                getattr(controller, args.operation.replace('-', '_'))()
        return 0
    except Refused as error:
        print('Admission refused: ' + str(error), file=sys.stderr)
        return 1
    except Exception as error:
        # Do not expose profile/command/HTTP contents through systemd's journal.
        print('Admission failed: ' + type(error).__name__ + '; reconcile before retry', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
