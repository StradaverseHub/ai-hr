#!/usr/bin/python3
"""One nonce-bound Auth request. Forward no material until the broker exits and releases its pool."""
import array
import errno
import fcntl
import json
import os
import pwd
import re
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

REQUEST_MAX = 4096
RESPONSE_MAX = 512 * 1024
CHILD_SECONDS = 35
CLIENT_SECONDS = 44
CGROUP_ROOT = '/sys/fs/cgroup'
DISPATCH_CGROUP = '/aihrmanagedmail.slice/aihrmanagedmail-dispatch.slice/'
ENVELOPE_MAX = 1024

def require(value):
    if not value:
        raise RuntimeError('private activation retirement refused')

def retirement_identity(raw, kernel_path):
    require(isinstance(raw, dict) and set(raw) == {'version', 'unit', 'invocationId', 'cgroup', 'replyBytes'})
    require(raw['version'] == 1 and type(raw['replyBytes']) is int and 0 < raw['replyBytes'] <= RESPONSE_MAX)
    require(isinstance(raw['unit'], str) and re.fullmatch(r'aihr-report-auth@[-a-zA-Z0-9_.\\]{1,200}\.service', raw['unit']))
    require(isinstance(raw['invocationId'], str) and re.fullmatch(r'[a-f0-9]{32}', raw['invocationId']))
    require(raw['cgroup'] == DISPATCH_CGROUP + raw['unit'] and kernel_path == CGROUP_ROOT + raw['cgroup'])
    return raw

def unit_state(unit, deadline):
    remaining = deadline - time.monotonic()
    require(remaining > 0)
    args = ['/usr/bin/systemctl', 'show', unit, '--no-pager']
    for key in ['Id', 'LoadState', 'ActiveState', 'InvocationID', 'MainPID', 'ControlGroup']:
        args.append('--property=' + key)
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=min(2, remaining), env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    require(len(result.stdout) <= 4096)
    rows = result.stdout.decode('ascii').strip().splitlines()
    require(len(rows) == 6 and all('=' in row for row in rows))
    values = dict(row.split('=', 1) for row in rows)
    require(set(values) == {'Id', 'LoadState', 'ActiveState', 'InvocationID', 'MainPID', 'ControlGroup'} and values['Id'] == unit)
    require(values['MainPID'].isdecimal() and result.returncode in (0, 1))
    require(result.returncode == 0 or values['LoadState'] == 'not-found')
    return {'load': values['LoadState'], 'active': values['ActiveState'], 'invocation': values['InvocationID'],
            'pid': int(values['MainPID']), 'cgroup': values['ControlGroup']}

def wait_retirement(identity, group_state, read_unit, monotonic=time.monotonic, sleep=time.sleep, seconds=8):
    deadline = monotonic() + seconds
    while True:
        require(monotonic() < deadline)
        group = group_state()
        require(group in ('populated', 'empty', 'collected'))
        if group != 'populated':
            unit = read_unit()
            require(unit['invocation'] in ('', identity['invocationId']))
            if unit['active'] in ('inactive', 'failed') and unit['pid'] == 0 and unit['cgroup'] in ('', identity['cgroup']):
                if group == 'empty' and unit['load'] in ('loaded', 'not-found'):
                    return
                if group == 'collected' and unit['load'] == 'not-found' and unit['invocation'] == '':
                    return
        sleep(min(0.05, max(0, deadline-monotonic())))

def cgroup_identity(fd, identity):
    info = os.fstat(fd)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    require(info.st_dev == os.stat(CGROUP_ROOT).st_dev and fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY)
    kernel_path = os.readlink('/proc/self/fd/' + str(fd))
    retirement_identity(identity, kernel_path)  # A foreign/already-deleted descriptor never qualifies.
    return (info.st_dev, info.st_ino, kernel_path)

def pinned_group_state(directory_fd, events_fd, pin):
    info = os.fstat(directory_fd)
    require((info.st_dev, info.st_ino) == pin[:2])
    path = os.readlink('/proc/self/fd/' + str(directory_fd))
    try:
        require(path in (pin[2], pin[2] + ' (deleted)'))
        os.lseek(events_fd, 0, os.SEEK_SET)
        content = os.read(events_fd, 512).decode('ascii')
        require(path == pin[2])
        rows = dict(row.split() for row in content.strip().splitlines())
        require(set(rows) <= {'populated', 'frozen'} and rows.get('populated') in ('0', '1') and len(content) < 512)
        return 'empty' if rows['populated'] == '0' else 'populated'
    except OSError as error:
        # Only collection of the same previously validated kernel inode may be paired with
        # authoritative unit not-found. Missing arbitrary paths/PIDs never supply proof.
        require(error.errno in (errno.ENODEV, errno.ENOENT) and path == pin[2] + ' (deleted)')
        return 'collected'

def receive_activation(peer, deadline):
    data = bytearray(); descriptors = []
    try:
        while True:
            peer.settimeout(max(0.001, deadline-time.monotonic()));require(time.monotonic() < deadline)
            chunk, ancillary, flags, _ = peer.recvmsg(65536, socket.CMSG_SPACE(8 * array.array('i').itemsize), socket.MSG_CMSG_CLOEXEC)
            for level, kind, payload in ancillary:
                require(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS)
                received = array.array('i');itemsize = received.itemsize;received.frombytes(payload[:len(payload)//itemsize*itemsize]);descriptors.extend(received)
                require(len(payload) % itemsize == 0)
            require(not flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) and bool(chunk))
            require(len(descriptors) <= 1)
            data.extend(chunk);require(len(data) <= RESPONSE_MAX + ENVELOPE_MAX + 1)
            end = data.find(b'\n')
            if end >= 0:
                require(end <= ENVELOPE_MAX)
                envelope = json.loads(data[:end]);require(isinstance(envelope, dict) and type(envelope.get('replyBytes')) is int)
                total = end + 1 + envelope['replyBytes'];require(end < total <= RESPONSE_MAX + ENVELOPE_MAX + 1)
                if len(data) >= total:
                    require(len(data) == total and len(descriptors) == 1)
                    return envelope, bytes(data[end+1:]), descriptors.pop()
    finally:
        for fd in descriptors:
            os.close(fd)

def client_main():
    # Independent wall-clock bound also covers a caller that never closes stdin or a stuck syscall.
    def expired(_signal, _frame):
        raise RuntimeError('private retirement client deadline')
    previous=signal.signal(signal.SIGALRM,expired)
    signal.setitimer(signal.ITIMER_REAL,CLIENT_SECONDS)
    try:
        return _client_main(time.monotonic()+CLIENT_SECONDS)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

def _client_main(deadline):
    # Invoked by the keyless sender, never under broker.env. Do not inherit a DB URL, key,
    # private sender config or caller CA into this independent retirement observer.
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'})
    require(os.getuid() == pwd.getpwnam('aihr-identity-email').pw_uid and os.getuid() > 0)
    body = sys.stdin.buffer.read(REQUEST_MAX + 1)
    require(0 < len(body) <= REQUEST_MAX and b'\n' not in body)
    directory_fd = events_fd = None
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(CLIENT_SECONDS);peer.connect('/run/aihr-report-auth.sock');peer.sendall(body+b'\n')
        try:
            identity, reply, directory_fd = receive_activation(peer, deadline)
            pin = cgroup_identity(directory_fd, identity)
            events_fd = os.open('cgroup.events', os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory_fd)
            require(pinned_group_state(directory_fd, events_fd, pin) == 'populated')
            before = unit_state(identity['unit'], deadline)
            require(before['load'] == 'loaded' and before['active'] in ('active', 'activating') and before['invocation'] == identity['invocationId'] and before['pid'] > 1 and before['cgroup'] == identity['cgroup'])
            peer.sendall(b'R')  # Receiver has pinned this live exact activation; only now may it exit.
            peer.settimeout(max(0.001, deadline-time.monotonic()));require(peer.recv(1) == b'')
            wait_retirement(identity, lambda: pinned_group_state(directory_fd, events_fd, pin),
                            lambda: unit_state(identity['unit'], deadline), seconds=min(8, deadline-time.monotonic()))
            require(time.monotonic() < deadline)
            json.loads(reply)  # Node still applies the canonical strict phase-specific response parser.
            sys.stdout.buffer.write(reply)
        finally:
            if events_fd is not None: os.close(events_fd)
            if directory_fd is not None: os.close(directory_fd)


def main():
    sender = pwd.getpwnam('aihr-identity-email')
    configured = os.environ.get('REPORT_AUTH_BROKER_WEB_UID', '')
    if not configured.isdecimal() or int(configured) <= 0 or os.getuid() != int(configured) or os.getuid() == sender.pw_uid:
        raise RuntimeError('invalid activation')
    if not stat.S_ISSOCK(os.fstat(0).st_mode):
        raise RuntimeError('invalid activation')
    peer = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(5)
    try:
        _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if uid <= 0 or uid != sender.pw_uid or uid == os.getuid():
            raise RuntimeError('invalid peer')
        body = bytearray()
        while True:
            chunk = peer.recv(min(4096, REQUEST_MAX + 1 - len(body)))
            require(bool(chunk))
            body.extend(chunk)
            if b'\n' in body:
                require(body.endswith(b'\n') and body.count(b'\n') == 1)
                body.pop();break
            if len(body) > REQUEST_MAX:
                raise RuntimeError('invalid request')
        request = json.loads(body)
        phase = request.get('phase') if isinstance(request, dict) else None
        keys = {'status': {'phase'}, 'inspect': {'phase', 'occurrenceId', 'leaseToken'},
                'start': {'phase', 'occurrenceId', 'leaseToken', 'inspectionProof', 'expectedArtifact'}}
        if phase not in keys or set(request) != keys[phase]:
            raise RuntimeError('invalid request')
        allowed = {key: os.environ[key] for key in ('DATABASE_URL', 'AUTH_PROVIDER', 'AUTH_PUBLIC_ORIGIN', 'AUTH_SESSION_KEY') if key in os.environ}
        if allowed.get('AUTH_PROVIDER') != 'internal':
            raise RuntimeError('invalid configuration')
        allowed.update(NODE_ENV='production', TZ='UTC', REPORT_AUTH_BROKER_UID=str(os.getuid()),
                       REPORT_AUTH_BROKER_PEER_UID=str(uid), REPORT_AUTH_BROKER_MAIL_UID=str(sender.pw_uid))
        child = subprocess.Popen(['/usr/local/lib/aihr-identity-email/internal-node', '--max-old-space-size=96',
                                  '/usr/local/lib/aihr-identity-email/report-auth-broker.cjs'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
                                 env=allowed, start_new_session=True)
        reply = bytearray()
        try:
            child.stdin.write(body)
            child.stdin.close()
            deadline = time.monotonic() + CHILD_SECONDS
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RuntimeError('broker deadline')
                    for key, _ in selector.select(min(remaining, 1)):
                        chunk = os.read(key.fileobj.fileno(), min(65536, RESPONSE_MAX + 1 - len(reply)))
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            reply.extend(chunk)
                            if len(reply) > RESPONSE_MAX:
                                raise RuntimeError('invalid reply')
            if child.wait(timeout=max(0.01, deadline-time.monotonic())) != 0:
                raise RuntimeError('broker refused')
            # JSON completeness only; canonical strict response validation belongs to the sender.
            json.loads(reply)
            # The child and its DB pool are gone BEFORE any relay material reaches sender/EOF.
            cgroups = open('/proc/self/cgroup', encoding='ascii').read().strip().splitlines()
            require(len(cgroups) == 1 and cgroups[0].startswith('0::'))
            cgroup = cgroups[0][3:];unit = cgroup.rsplit('/', 1)[-1]
            identity = {'version': 1, 'unit': unit, 'invocationId': os.environ.get('INVOCATION_ID', ''), 'cgroup': cgroup, 'replyBytes': len(reply)}
            retirement_identity(identity, CGROUP_ROOT + cgroup)
            directory_fd = os.open(CGROUP_ROOT+cgroup, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                cgroup_identity(directory_fd, identity)
                envelope = json.dumps(identity, separators=(',', ':')).encode('ascii') + b'\n' + reply
                sent = peer.sendmsg([envelope], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [directory_fd]))])
                if sent < len(envelope): peer.sendall(envelope[sent:])
                peer.settimeout(5);require(peer.recv(1) == b'R')
            finally:
                os.close(directory_fd)
            # Never SHUT_WR: EOF is only framing, and the keyless client additionally waits for
            # this exact whole cgroup plus systemd activation to retire before publishing JSON.
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            child.stdout.close()
    finally:
        peer.close()

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--client']:
            client_main()
        else:
            require(len(sys.argv) == 1);main()
    except Exception:
        # No partial response, credentials, addresses, provider errors or request details are emitted.
        sys.exit(78)
