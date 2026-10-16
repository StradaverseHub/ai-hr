#!/usr/bin/python3
"""One nonce-bound Auth request. Forward no material until the broker exits and releases its pool."""
import json
import os
import pwd
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
            if not chunk:
                break
            body.extend(chunk)
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
            peer.sendall(reply)
            peer.shutdown(socket.SHUT_WR)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            child.stdout.close()
    finally:
        peer.close()

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No partial response, credentials, addresses, provider errors or request details are emitted.
        sys.exit(78)
