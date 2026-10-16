#!/usr/bin/python3
"""Root-owned socket launcher. Linux supplies peer identity; request JSON never supplies it."""
import os
import pwd
import socket
import stat
import struct
import sys
try:
    worker = pwd.getpwnam('aihr-report-renderer')
    mail = pwd.getpwnam('aihr-identity-email')
    if os.getuid() != worker.pw_uid or not stat.S_ISSOCK(os.fstat(0).st_mode):
        raise RuntimeError('invalid activation')
    peer = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
    _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    peer.close()
    # Optional future internal-mode configuration; default remains mail-only. Installer ownership,
    # broker service UID and socket DAC changes are separately reviewed, not inferred here.
    configured_broker = os.environ.get('REPORT_RENDERER_AUTH_BROKER_UID')
    broker_uid = None
    if configured_broker is not None:
        if not configured_broker.isdecimal():
            raise RuntimeError('invalid broker configuration')
        broker_uid = int(configured_broker)
        if broker_uid <= 0 or broker_uid in (worker.pw_uid, mail.pw_uid):
            raise RuntimeError('invalid broker configuration')
    if uid != mail.pw_uid and (broker_uid is None or uid != broker_uid):
        raise RuntimeError('invalid peer')
    allowed = {key: os.environ[key] for key in ('DATABASE_URL', 'WORKFLOW_EMAIL_ISSUER', 'AUTH_PROVIDER', 'AUTH_PUBLIC_ORIGIN') if key in os.environ}
    allowed.update(NODE_ENV='production', TZ='UTC', REPORT_RENDERER_UID=str(worker.pw_uid),
                   REPORT_RENDERER_MAIL_UID=str(mail.pw_uid), REPORT_RENDERER_PEER_UID=str(uid))
    if broker_uid is not None:
        allowed['REPORT_RENDERER_AUTH_BROKER_UID'] = str(broker_uid)
    node_path = '/usr/local/lib/aihr-identity-email/internal-node' if allowed.get('AUTH_PROVIDER') == 'internal' else '/usr/local/lib/aihr-identity-email/node'
    os.execve(node_path,
              ['node', '--max-old-space-size=384', '/usr/local/lib/aihr-identity-email/report-renderer.cjs'], allowed)
except Exception:
    # No private input, environment, address or provider error is reflected to an unauthorized peer.
    sys.exit(78)
