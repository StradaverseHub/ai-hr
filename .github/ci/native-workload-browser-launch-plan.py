"""Pure command contract for the fixed synthetic Chromium roles.

The protected issuer must independently bind the source, service-visible
mounts, accounts, credential, anonymous stdio, and native process settlement.
This module prepares no resources and has no command entry point.
"""

import base64
import re
from typing import NamedTuple


_DRIVER = 'roles/native-workload-browser-driver.mjs'
_SERVER = 'roles/native-workload-browser-server.mjs'
_PROBE = 'roles/native-workload-browser-host.py'
_PLAYWRIGHT = ('node_modules/playwright', 'node_modules/playwright-core')
_ROLE_FILES = {
    'driver': ('node', _DRIVER, _SERVER, *_PLAYWRIGHT),
    'browser': ('node', _SERVER, _PROBE, *_PLAYWRIGHT, 'chromium/chrome-headless-shell-linux64'),
    'third': (_PROBE,),
}
_LAUNCHER_ENVIRONMENT = (('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), ('LANG', 'C'), ('LC_ALL', 'C'))


class RoleCommand(NamedTuple):
    unit: str
    uid: int
    gid: int
    control_group: str
    description: str
    argv: tuple[str, ...]
    launcher_environment: tuple[tuple[str, str], ...]


def _require(condition, reason):
    if not condition:
        raise ValueError(reason)


def synthetic_role_command(host, *, mode, role, run_id, owner_nonce, stage, spki=None, credential=None):
    """Use the source-pinned host module already held by the future issuer.

    The stage and credential describe expected owner inputs. Equality here
    cannot attest to the actual bytes, paths, mount flags or service identity.
    """
    _require(type(mode) is str and mode == 'capability-only', 'synthetic-launch-mode')
    _require(type(role) is str and role in _ROLE_FILES, 'synthetic-launch-role')
    _require(type(run_id) is str and re.fullmatch(r'[1-9][0-9]{0,15}', run_id)
             and int(run_id) <= 9007199254740991, 'synthetic-launch-run')
    _require(type(owner_nonce) is str and re.fullmatch(r'[0-9a-f]{16}', owner_nonce), 'synthetic-launch-owner')

    root = '/run/aihr-browser-capability-' + run_id
    source, runtime = root + '/launch-source', root + '/runtime'
    _require(type(stage) is str and stage == source, 'synthetic-launch-stage')
    decoy = root + '/private/observer'
    if role == 'driver':
        _require(type(credential) is tuple and len(credential) == 2
                 and type(credential[0]) is str and type(credential[1]) is bytes
                 and credential == (decoy, b'aihr-browser-isolation-v1:' + run_id.encode('ascii') + b'\n'),
                 'synthetic-launch-credential')
    else:
        _require(credential is None, 'synthetic-launch-credential')
    if role == 'browser':
        _require(type(spki) is str and re.fullmatch(r'[A-Za-z0-9+/]{43}=', spki)
                 and base64.b64encode(base64.b64decode(spki, validate=True)).decode('ascii') == spki,
                 'synthetic-launch-spki')
    else:
        _require(spki is None, 'synthetic-launch-spki')

    unit = f'aihrbc-{role}-{run_id}.service'
    description = f'AIHR synthetic Chromium {run_id} {role} {owner_nonce}'
    uid = {'driver': host.DRIVER, 'browser': host.BROWSER, 'third': host.THIRD}[role]
    properties = dict(host.role_properties('driver' if role == 'third' else role))
    if role == 'third':
        properties.update(User=str(uid), Group=str(uid))
    properties.update(PrivateMounts='yes', DynamicUser='no', SetLoginEnvironment='no', PassEnvironment='')
    properties['BindReadOnlyPaths'] = ' '.join(f'{source}/{leaf}:{runtime}/{leaf}:norbind' for leaf in _ROLE_FILES[role])

    hidden = ['-/run/docker.sock', '-/run/containerd/containerd.sock']
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
    if role == 'third':
        environment['HOME'] = '/nonexistent'
        hidden.extend((root + '/driver-home', root + '/browser-home'))
        working_directory = '/'
        executable = ('/usr/bin/python3', '-I', '-B', runtime + '/' + _PROBE, 'probe-third')
    else:
        home = root + '/' + role + '-home'
        environment.update(HOME=home, TMPDIR=home + '/scratch')
        properties['ReadWritePaths'] = environment['TMPDIR']
        hidden.append(root + ('/browser-home' if role == 'driver' else '/driver-home'))
        working_directory = home
        if role == 'driver':
            properties['LoadCredential'] = 'observer:' + decoy
            executable = (runtime + '/node', runtime + '/' + _DRIVER, '--capability-only')
        else:
            executable = (runtime + '/node', runtime + '/' + _SERVER, spki)
    if role != 'driver':
        hidden.append(f'-/run/credentials/aihrbc-driver-{run_id}.service')
    properties['InaccessiblePaths'] = ' '.join(hidden)

    argv = ('/usr/bin/systemd-run', '--system', '--wait', '--pipe', '--quiet', '--no-ask-password',
            '--expand-environment=no', '--slice=system.slice', '--unit=' + unit, '--description=' + description,
            '--working-directory=' + working_directory,
            *(f'--property={key}={value}' for key, value in properties.items()),
            *(f'--setenv={key}={value}' for key, value in environment.items()), '--', *executable)
    return RoleCommand(unit, uid, uid, '/system.slice/' + unit, description, argv, _LAUNCHER_ENVIRONMENT)
