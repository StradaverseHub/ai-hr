"""Dedicated hosted Linux transport/lifecycle witness; not a Next/release witness.

Uses real root-owned controller bytes, systemd services, /proc identities and Nginx.
Every created host path/unit is refused if already present and removed by identity.
No application database, provider, credential or private installation is used.
"""
import base64
import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import importlib.util
import json
import os
import pathlib
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('admission_controller', pathlib.Path(__file__).with_name('controller.py'))
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
UNITS = ['aihr-web@1.service', 'aihr-web@2.service']
PROXY = 'aihr-admission-nginx.service'
DIRECTORIES = [pathlib.Path(path) for path in ['/etc/aihr-admission', '/usr/local/lib/aihr-admission',
                                             '/etc/nginx/aihr-admission', '/run/aihr-admission', '/var/lib/aihr-admission']]
report = {'kind': 'DISPOSABLE_NATIVE_NGINX_SYSTEMD_ADMISSION', 'releaseEligible': False,
          'nextApplicationVerified': False, 'hostInstallationVerified': False, 'phases': [], 'complete': False,
          'limits': {'healthSeconds': 8, 'activationSeconds': 3, 'drainSeconds': 1},
          'limitations': ['Fictional backend exercises transport/lifecycle, not actual Next authentication or Server Actions.',
                          'The actual protected immutable installer and full worker load path remain separate gates.']}
created_paths = {}
created_units = {}
evidence = None
profile_value = None


def save():
    if evidence is not None:
        evidence.write_text(json.dumps(report, indent=2) + '\n')
        evidence.chmod(0o644)


def phase(name):
    report['phases'].append({'name': name, 'started': time.monotonic()})
    report['currentPhase'] = name
    save()


def command(arguments, *, check=True, timeout=15, env=None):
    return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout,
                          check=check, env=env or C.SAFE_ENV)


def systemctl(*arguments, check=True):
    return command(['/usr/bin/systemctl', '--system', *arguments], check=check)


def properties(unit):
    raw = systemctl('show', unit, '--property=InvocationID,MainPID,ControlPID,ActiveState,SubState,ExecStart,ExecReload,FragmentPath').stdout
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def controller(operation, unit=None, invocation=None, *, check=True):
    arguments = ['/usr/bin/python3', '-I', str(C.INSTALLED), operation]
    if unit is not None:
        arguments.append(unit)
    env = C.SAFE_ENV.copy()
    if invocation is not None:
        env['INVOCATION_ID'] = invocation
    return command(arguments, check=check, timeout=20, env=env)


def status():
    return json.loads(controller('status').stdout)


def inventory():
    return json.loads((pathlib.Path(profile_value['stateDirectory']) / 'state.json').read_text())


def until(predicate, description, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError, subprocess.SubprocessError, KeyError, C.Refused):
            pass
        time.sleep(0.025)
    raise AssertionError('Native deadline: ' + description)


def free_port(used):
    while True:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        if port not in used:
            used.add(port)
            return port


def write(path, value, mode=0o600):
    path.write_text(value)
    path.chmod(mode)


def data(slot):
    return pathlib.Path('/var/lib/aihr-admission/app-data', str(slot))


def gate(slot, name, present=True):
    path = data(slot) / name
    if present:
        write(path, 'fictional gate\n', 0o644)
    else:
        path.unlink(missing_ok=True)


def request(path='/who', *, body=None, headers=None, port=None):
    connection = http.client.HTTPConnection('127.0.0.1', port or report['frontPort'], timeout=3)
    try:
        connection.request('POST' if body is not None else 'GET', path, body=body,
                           headers={'Connection': 'close', **(headers or {})})
        response = connection.getresponse()
        payload = response.read(4 * 1024 * 1024)
        assert response.status == 200, 'Unexpected fictional transport status ' + str(response.status)
        return json.loads(payload)
    finally:
        connection.close()


def open_stream():
    connection = http.client.HTTPConnection('127.0.0.1', report['frontPort'], timeout=3)
    connection.request('GET', '/stream', headers={'Connection': 'close'})
    response = connection.getresponse()
    assert response.status == 200 and response.read(7) == b'started'
    return connection, response


def ready_worker(unit):
    return next((row for row in status()['workers'] if row['unit'] == unit and row['phase'] == 'READY' and row['admitted']), None)


def create_fixture():
    global profile_value
    assert os.geteuid() == 0 and sys.platform == 'linux'
    assert os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    assert os.environ.get('GITHUB_REPOSITORY') == 'StradaverseHub/ai-hr'
    source = os.environ.get('AIHR_CI_HEAD', '')
    assert re.fullmatch(r'[0-9a-f]{40}', source)
    # The unprivileged wrapper verifies Git. The privileged fixture reads only
    # the expected detached checkout identity as DATA; it never executes Git or
    # an application-owned status script with root privileges.
    head = ROOT / '.git/HEAD'
    assert head.is_file() and not head.is_symlink() and head.read_text().strip() == source
    assert pathlib.Path('/usr/sbin/nginx').is_file(), 'Actual distro Nginx prerequisite is missing; no skip or mocked pass'
    assert pathlib.Path('/run/systemd/system').is_dir(), 'Actual systemd system manager is required'
    assert shutil.rmtree.avoids_symlink_attacks
    for path in DIRECTORIES:
        assert not path.exists() and not path.is_symlink(), 'Refuse a pre-existing fixture destination'
    for unit in [*UNITS, PROXY]:
        assert not properties(unit).get('FragmentPath'), 'Refuse a pre-existing fixture unit'
    for path in DIRECTORIES:
        path.mkdir(mode=0o755)
        created_paths[str(path)] = path.stat().st_ino
    for directory in [pathlib.Path('/run/aihr-admission/ports'), pathlib.Path('/var/lib/aihr-admission/release'),
                      pathlib.Path('/var/lib/aihr-admission/release/.next'), pathlib.Path('/var/lib/aihr-admission/app-data')]:
        directory.mkdir(mode=0o755)
    release = pathlib.Path('/var/lib/aihr-admission/release')
    write(release / '.aihr-admission-release.json', json.dumps({'source': source, 'build': 'fictional-native-build'}))
    write(release / '.next/BUILD_ID', 'fictional-native-build\n', 0o644)
    shutil.copyfile(pathlib.Path(C.__file__), C.INSTALLED)
    C.INSTALLED.chmod(0o644)
    backend = C.INSTALLED.with_name('fixture_backend.py')
    shutil.copyfile(pathlib.Path(__file__).with_name('fixture_backend.py'), backend)
    backend.chmod(0o644)
    nobody = pwd.getpwnam('nobody')
    for slot in (1, 2):
        data(slot).mkdir(mode=0o700)
        os.chown(data(slot), nobody.pw_uid, nobody.pw_gid)
        gate(slot, 'bind')
    gate(1, 'ready')
    used = set()
    front, control, unrelated = free_port(used), free_port(used), free_port(used)
    pool = [free_port(used) for _ in range(12)]
    report.update({'frontPort': front, 'controlPort': control, 'unrelatedPort': unrelated,
                   'nginxVersion': command(['/usr/sbin/nginx', '-v'], check=False).stderr.strip(),
                   'systemdVersion': systemctl('--version').stdout.splitlines()[0], 'source': source})
    nginx_config = pathlib.Path('/etc/nginx/aihr-admission/fixture.conf')
    nginx_text = '''worker_processes 2;
pid /run/aihr-admission/nginx.pid;
error_log /run/aihr-admission/nginx-error.log;
events { worker_connections 1024; }
http {
  access_log off;
  include /etc/nginx/aihr-admission/ready.conf;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  # This fixture's loopback ingress is trusted; retain the outer TLS scheme.
  map $http_x_forwarded_proto $forwarded_proto { default $scheme; https https; http http; }
  server {
    listen 127.0.0.1:FRONT;
    client_max_body_size 4m;
    location / {
      proxy_pass http://aihr_ready_workers;
      proxy_next_upstream off;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto $forwarded_proto;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_buffering off;
      proxy_request_buffering off;
    }
  }
  server { listen 127.0.0.1:UNRELATED; location / { return 200 'unrelated'; } }
}
'''.replace('FRONT', str(front)).replace('UNRELATED', str(unrelated))
    write(nginx_config, nginx_text)
    proxy_unit = '''[Unit]
Description=Owned disposable admission Nginx fixture
[Service]
Type=forking
PIDFile=/run/aihr-admission/nginx.pid
ExecStartPre=/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py prepare-proxy
ExecStart=/usr/sbin/nginx -c /etc/nginx/aihr-admission/fixture.conf -p /etc/nginx/aihr-admission
ExecStartPost=/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py confirm-proxy
ExecReload=/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py reload
ExecStop=/usr/sbin/nginx -c /etc/nginx/aihr-admission/fixture.conf -p /etc/nginx/aihr-admission -s quit
TimeoutStopSec=5
UMask=0077
'''
    files = {PROXY: proxy_unit}
    for slot, unit in enumerate(UNITS, 1):
        files[unit] = '''[Unit]
Description=Owned fictional admission backend
After=aihr-admission-nginx.service
[Service]
Type=simple
User=nobody
WorkingDirectory=/var/lib/aihr-admission/release
EnvironmentFile=-/run/aihr-admission/ports/SLOT.env
ExecStartPre=+/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py reserve UNIT
ExecStart=/usr/bin/python3 -I /usr/local/lib/aihr-admission/fixture_backend.py --data /var/lib/aihr-admission/app-data/SLOT
ExecStartPost=+/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py admit UNIT
ExecStopPost=+/usr/bin/python3 -I /usr/local/lib/aihr-admission/controller.py cleanup UNIT
Restart=on-failure
RestartSec=250ms
TimeoutStartSec=30
TimeoutStopSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
'''.replace('SLOT', str(slot)).replace('UNIT', unit)
    for name, text in files.items():
        path = pathlib.Path('/etc/systemd/system', name)
        write(path, text, 0o644)
        created_units[str(path)] = path.stat().st_ino
    systemctl('daemon-reload')
    profile_value = {'version': 1, 'epoch': 'a' * 32, 'source': source, 'build': 'fictional-native-build',
                     'resourceEnvelopeDigest': C.digest({'kind': 'FICTIONAL_LINUX_TRANSPORT_ONLY', 'workers': 2}),
                     'controllerDigest': hashlib.sha256(C.INSTALLED.read_bytes()).hexdigest(),
                     'stateDirectory': '/var/lib/aihr-admission', 'nginxBinary': '/usr/sbin/nginx',
                     'nginxConfig': str(nginx_config), 'nginxPrefix': '/etc/nginx/aihr-admission',
                     'nginxPid': '/run/aihr-admission/nginx.pid', 'nginxUnit': PROXY,
                     'managedInclude': '/etc/nginx/aihr-admission/ready.conf', 'controlPort': control,
                     'ports': pool, 'units': {}, 'healthSeconds': 8, 'activationSeconds': 3, 'drainSeconds': 1,
                     'reloadGuardDigest': C.command_identity(properties(PROXY)['ExecReload'])}
    for slot, unit in enumerate(UNITS, 1):
        profile_value['units'][unit] = {'environmentFile': '/run/aihr-admission/ports/' + str(slot) + '.env',
                                         'releaseDirectory': str(release), 'workerUid': nobody.pw_uid,
                                         'commandDigest': C.command_identity(properties(unit)['ExecStart']),
                                         'executable': os.path.realpath('/usr/bin/python3')}
    write(C.PROFILE, json.dumps(profile_value))
    assert C.INSTALLED.stat().st_uid == C.PROFILE.stat().st_uid == 0
    systemctl('start', PROXY)
    assert status()['workers'] == []
    return nginx_config, nginx_text


def run():
    nginx_config, nginx_text = create_fixture()
    phase('cold-worker-exclusion-and-post-once')
    systemctl('start', UNITS[0])
    first = until(lambda: ready_worker(UNITS[0]), 'first worker admission')
    invocation1 = properties(UNITS[0])['InvocationID']
    phase('nonroot-worker-filesystem-boundary')
    nobody = pwd.getpwnam('nobody')
    protected = [str(C.PROFILE), str(C.INSTALLED), profile_value['units'][UNITS[0]]['environmentFile'],
                 '/var/lib/aihr-admission/release/.next/BUILD_ID']
    # Run real write attempts with the same unprivileged UID/groups as the
    # application. No test-mode ownership bypass exists in the installed helper.
    probe = '''import os,pathlib,sys
assert os.getuid()>0
for value in sys.argv[1:-1]:
 try:
  fd=os.open(value,os.O_WRONLY|os.O_APPEND)
 except PermissionError:
  continue
 else:
  os.close(fd)
  raise AssertionError('Protected file was writable by the application')
try:
 pathlib.Path('/var/lib/aihr-admission/release/forged').touch(exist_ok=False)
except PermissionError:
 pass
else:
 raise AssertionError('Immutable release parent was writable')
cache=pathlib.Path(sys.argv[-1])/'cache-proof'
cache.write_text('fictional writable application cache')
assert cache.read_text()=='fictional writable application cache'
'''
    subprocess.run(['/usr/bin/python3', '-I', '-c', probe, *protected, str(data(1))], check=True,
                   capture_output=True, text=True, timeout=5, env=C.SAFE_ENV,
                   user=nobody.pw_uid, group=nobody.pw_gid, extra_groups=[])
    report['nonrootWriteBoundaryVerified'] = True
    checked = json.loads(controller('check-only').stdout)
    assert checked['kind'] == 'ADMISSION_CHECKONLY' and checked['installationAvailable'] is False
    assert checked['releaseEligible'] is False and checked['rootBoundaryInspected'] is True
    build_identity = pathlib.Path('/var/lib/aihr-admission/release/.next/BUILD_ID')
    build_identity.chmod(0o666)
    try:
        assert controller('check-only', check=False).returncode != 0
    finally:
        build_identity.chmod(0o644)
    environment = pathlib.Path(profile_value['units'][UNITS[0]]['environmentFile'])
    os.chown(environment, nobody.pw_uid, nobody.pw_gid)
    try:
        assert controller('check-only', check=False).returncode != 0
    finally:
        os.chown(environment, 0, 0)
    report['checkOnlyRefusedUnsafeReleaseAndEnvironment'] = True
    save()
    stream_connection, stream = open_stream()
    assert stream.getheader('X-Fictional-Invocation') == invocation1
    systemctl('start', '--no-block', UNITS[1])
    second = until(lambda: next((row for row in status()['workers'] if row['unit'] == UNITS[1] and row['phase'] == 'WARMING'), None), 'second reservation')
    assert first['port'] != second['port'] and not second['admitted']
    invocation2 = properties(UNITS[1])['InvocationID']
    def cold_traffic(index):
        assert request()['invocation'] == invocation1
        receipt = request('/write', body=json.dumps({'id': 'fictional-' + str(index)}).encode(), headers={'Content-Type': 'application/json'})
        assert receipt['invocation'] == invocation1
    with ThreadPoolExecutor(max_workers=8) as clients:
        list(clients.map(cold_traffic, range(30)))
    assert not (data(2) / 'writes.jsonl').exists()
    def transition_traffic(index):
        assert request()['invocation'] in {invocation1, invocation2}
        return request('/write', body=json.dumps({'id': 'fictional-' + str(index)}).encode(), headers={'Content-Type': 'application/json'})
    with ThreadPoolExecutor(max_workers=10) as clients:
        callbacks = [clients.submit(controller, 'admit', UNITS[1], invocation2) for _ in range(2)]
        futures = [clients.submit(transition_traffic, index) for index in range(30, 90)]
        gate(2, 'ready')
        for future in futures:
            future.result()
        for callback in callbacks:
            assert callback.result().returncode == 0
    until(lambda: ready_worker(UNITS[1]), 'second worker admission')
    assert properties(UNITS[1])['InvocationID'] == invocation2
    assert {request()['invocation'] for _ in range(30)} == {invocation1, invocation2}
    writes = [json.loads(line) for slot in (1, 2) if (data(slot) / 'writes.jsonl').exists()
              for line in (data(slot) / 'writes.jsonl').read_text().splitlines()]
    assert sorted(row['id'] for row in writes) == sorted('fictional-' + str(index) for index in range(90))
    assert len(writes) == 90
    report.update({'coldBusinessRequests': 0, 'postReceipts': 90, 'duplicatePostReceipts': 0,
                   'concurrentTransportClients': 8, 'concurrentAdmissionCallbacks': 3})
    save()

    phase('headers-upload-and-upgrade')
    body = b'fictional-upload-' * (2 * 1024 * 1024 // 17)
    upload = request('/upload', body=body, headers={'Host': 'fixture.example.invalid:8443', 'Cookie': 'fictional=preserved',
                                                  'X-Forwarded-Proto': 'https'})
    assert upload == {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'host': 'fixture.example.invalid:8443',
                      'cookie': 'fictional=preserved', 'forwardedProto': 'https'}
    with socket.create_connection(('127.0.0.1', report['frontPort']), timeout=3) as connection:
        connection.sendall(b'GET /upgrade HTTP/1.1\r\nHost: fixture.example.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZmljdGlvbmFsLWtleS0xMg==\r\n\r\n')
        headers = b''
        while b'\r\n\r\n' not in headers:
            headers += connection.recv(1)
        assert headers.startswith(b'HTTP/1.1 101')
        mask, payload = b'abcd', b'ping'
        connection.sendall(bytes([0x81, 0x80 | len(payload)]) + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))
        reply = b''
        while len(reply) < 6:
            reply += connection.recv(6 - len(reply))
        assert reply == b'\x81\x04ping'
    report.update({'uploadBytes': len(body), 'headersPreserved': True, 'upgradeEchoVerified': True})
    save()

    phase('lost-post-response-is-not-replayed-or-masked')
    connection = http.client.HTTPConnection('127.0.0.1', report['frontPort'], timeout=3)
    connection.request('POST', '/write-drop', body=json.dumps({'id': 'fictional-lost-response'}),
                       headers={'Content-Type': 'application/json', 'Connection': 'close'})
    response = connection.getresponse()
    assert response.status == 502
    response.read()
    connection.close()
    receipts = [json.loads(line) for slot in (1, 2)
                for line in (data(slot) / 'writes.jsonl').read_text().splitlines()]
    assert sum(row['id'] == 'fictional-lost-response' for row in receipts) == 1
    report['lostPostResponseNotReplayed'] = True
    save()

    phase('drain-expiry-retains-old-worker-and-no-port-reuse')
    refused = controller('drain', UNITS[0], check=False)
    assert refused.returncode != 0 and 'retain the old process' in refused.stderr
    old_process = inventory()['generations'][first['generation']]['process']
    assert C.alive(old_process)
    assert request()['invocation'] == invocation2
    gate(1, 'release-stream')
    assert stream.read() == b'done'
    stream_connection.close()
    receipt = json.loads(controller('drain', UNITS[0]).stdout)
    assert receipt['safeToStop'] and C.alive(old_process)
    systemctl('stop', UNITS[0])
    controller('reconcile')
    assert inventory()['generations'][first['generation']]['phase'] == 'RELEASED'
    report['drainRetainedProcessOnExpiry'] = True
    save()

    phase('replacement-cold-start-and-stale-callback')
    gate(1, 'ready', False)
    systemctl('start', '--no-block', UNITS[0])
    replacement = until(lambda: next((row for row in status()['workers'] if row['unit'] == UNITS[0] and row['phase'] == 'WARMING'), None), 'replacement reservation')
    assert replacement['generation'] != first['generation']
    # Reuse is permitted only after all old readers and process exited above.
    for _ in range(20):
        assert request()['invocation'] == invocation2
    before = status()
    assert controller('cleanup', UNITS[0], invocation1, check=False).returncode != 0
    assert controller('admit', UNITS[0], invocation1, check=False).returncode != 0
    assert status() == before
    gate(1, 'ready')
    until(lambda: ready_worker(UNITS[0]), 'replacement admission')
    report['staleCleanupRefused'] = True
    save()

    phase('native-process-socket-and-profile-boundaries')
    profile = C.Profile(C.PROFILE)
    host = C.LinuxHost(profile)
    current = ready_worker(UNITS[0])
    try:
        host.worker(UNITS[1], properties(UNITS[1])['InvocationID'], current['port'])
        raise AssertionError('A healthy foreign process endpoint was accepted')
    except C.Refused:
        pass
    identity = host.worker(UNITS[0], properties(UNITS[0])['InvocationID'], current['port'])
    assert not host.owns_listener({'pid': identity['pid'], 'startTicks': identity['startTicks'] + 1}, current['port'])
    before = status()
    C.PROFILE.chmod(0o666)
    try:
        assert controller('status', check=False).returncode != 0
    finally:
        C.PROFILE.chmod(0o600)
    assert status() == before
    report.update({'foreignProcessEndpointRefused': True, 'startTicksMismatchRefused': True,
                   'unsafeProfilePermissionsRefused': True})
    save()

    phase('invalid-reload-keeps-previous-live-configuration')
    previous_revision = status()['publishedRevision']
    write(nginx_config, nginx_text + '\nnot_a_real_directive;\n')
    refused = controller('reload', check=False)
    assert refused.returncode != 0 and 'Proxy rejected' in refused.stderr
    assert status()['publishedRevision'] == previous_revision and not status()['publicationPending']
    assert request()['invocation'] in {properties(unit)['InvocationID'] for unit in UNITS}
    write(nginx_config, nginx_text)
    report['invalidReloadPreservedTraffic'] = True
    save()

    phase('interrupted-publication-real-nginx-recovery')
    profile = C.Profile(C.PROFILE)

    class InterruptedAfterHup(C.LinuxHost):
        def reload_proxy(self, master):
            before = self.proxy_workers(master)
            super().reload_proxy(master)
            until(lambda: any(row not in before for row in self.proxy_workers(master)), 'actual new Nginx worker')
            raise OSError('Controlled failure after real Nginx reload')

    try:
        C.Controller(profile, InterruptedAfterHup(profile)).reload()
        raise AssertionError('Controlled reload interruption did not occur')
    except OSError:
        pass
    assert status()['publicationPending']
    interrupted_revision = inventory()['pending']['revision']
    controller('reconcile')
    assert not status()['publicationPending'] and status()['publishedRevision'] != interrupted_revision
    assert request()['invocation'] in {properties(unit)['InvocationID'] for unit in UNITS}
    report['interruptedPublicationReconciled'] = True
    save()

    phase('endpoint-exhaustion-is-an-explicit-startup-failure')
    controller('drain', UNITS[1])
    systemctl('stop', UNITS[1])
    controller('reconcile')
    blockers = []
    try:
        for port in profile_value['ports']:
            blocker = socket.socket()
            try:
                blocker.bind(('127.0.0.1', port))
                blocker.listen(1)
                blockers.append(blocker)
            except OSError:
                blocker.close()  # A live generation is already retaining it.
        failed = systemctl('start', UNITS[1], check=False)
        assert failed.returncode != 0, 'An exhausted endpoint pool was reported as successful startup'
        assert not ready_worker(UNITS[1])
        assert request()['invocation'] == properties(UNITS[0])['InvocationID']
    finally:
        systemctl('stop', UNITS[1], check=False)
        for blocker in blockers:
            blocker.close()
    systemctl('reset-failed', UNITS[1], check=False)
    controller('reconcile')
    systemctl('start', UNITS[1])
    until(lambda: ready_worker(UNITS[1]), 'admission after explicit exhaustion recovery')
    report['endpointExhaustionRefusedStartup'] = True
    save()

    phase('proxy-restart-never-replays-persisted-up')
    systemctl('restart', PROXY)
    assert all(not row['admitted'] for row in status()['workers'])
    controller('reconcile')
    assert all(row['admitted'] for row in status()['workers'])
    assert request()['invocation'] in {properties(unit)['InvocationID'] for unit in UNITS}
    connection = http.client.HTTPConnection('127.0.0.1', report['unrelatedPort'], timeout=3)
    connection.request('GET', '/')
    response = connection.getresponse()
    assert response.status == 200 and response.read() == b'unrelated'
    connection.close()
    report.update({'restartBeginsDown': True, 'unrelatedVhostPreserved': True,
                   'rootOwnedControllerAndProfile': True, 'complete': True, 'currentPhase': 'complete'})
    save()


def cleanup():
    # Only units and paths created by this exact invocation can be stopped/removed.
    for unit in [*reversed(UNITS), PROXY]:
        path = pathlib.Path('/etc/systemd/system', unit)
        if str(path) in created_units and path.is_file() and not path.is_symlink() and path.stat().st_ino == created_units[str(path)]:
            systemctl('stop', unit, check=False)
            systemctl('reset-failed', unit, check=False)
            path.unlink()
    if created_units:
        systemctl('daemon-reload', check=False)
    for path in reversed(DIRECTORIES):
        if str(path) in created_paths:
            assert path.is_dir() and not path.is_symlink() and path.stat().st_ino == created_paths[str(path)] and path.stat().st_uid == 0
            shutil.rmtree(path)


def stop_signal(_signum, _frame):
    raise RuntimeError('Controlled harness termination; owned fixture cleanup required')


if __name__ == '__main__':
    destination = pathlib.Path(sys.argv[1]).resolve()
    runner_temporary = pathlib.Path(os.environ.get('RUNNER_TEMP', '/missing')).resolve()
    assert runner_temporary in destination.parents and destination.parent.is_dir()
    evidence = destination
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    try:
        run()
    except Exception as error:
        report['failureType'] = type(error).__name__
        report['complete'] = False
        save()
        raise
    finally:
        cleanup()
