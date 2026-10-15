#!/usr/bin/python3
"""Explicit post-install Linux probe. Root runs this reviewed file; no SMTP or HR rows are used."""
import json
import os
import pwd
import socket
import subprocess
import uuid

SOCKET = '/run/aihr-report-renderer.sock'
DIRECTORY = '/var/lib/aihr-report-renderer/render'

def as_user(user, program):
    return subprocess.run(['/usr/sbin/runuser', '-u', user, '--', '/usr/bin/python3', '-I', '-c', program],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=35, check=True).stdout

def request_as_mail(body):
    encoded = repr(json.dumps(body).encode())
    return json.loads(as_user('aihr-identity-email', """import socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(25);s.connect(%r)
s.sendall(%s);s.shutdown(socket.SHUT_WR);b=b''
while True:
 c=s.recv(4096)
 if not c:break
 b+=c
 if len(b)>4096:raise RuntimeError('oversized response')
print(b.decode())
""" % (SOCKET, encoded)))

def main():
    if os.getuid() != 0:
        raise RuntimeError('Root required')
    worker = pwd.getpwnam('aihr-report-renderer')
    mail = pwd.getpwnam('aihr-identity-email')
    assert worker.pw_uid not in (0, mail.pw_uid)
    # Outside systemd, ordinary DAC must already deny the renderer UID access to the vault/env.
    as_user('aihr-report-renderer', """import os
for path in ['/var/lib/aihr-identity-email/vault','/etc/aihr-keycloak']:
 try:os.listdir(path)
 except PermissionError:continue
 raise RuntimeError('private mail path readable')
""")
    # The renderer UID cannot impersonate the mail client through socket request content.
    as_user('aihr-report-renderer', """import socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:s.connect(%r)
except PermissionError:pass
else:raise RuntimeError('renderer UID reached mail-only socket')
""" % SOCKET)
    # Root can bypass socket DAC, but SO_PEERCRED must still reject the non-mail peer.
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(25);peer.connect(SOCKET);peer.sendall(b'{"phase":"status"}');peer.shutdown(socket.SHUT_WR)
    try:
        response = peer.recv(4096)
    except ConnectionResetError:
        response = b''
    finally:
        peer.close()
    assert response == b''
    assert request_as_mail({'phase':'status'}) == {'ok':True,'ready':True}
    assert request_as_mail({'phase':'status','roles':['super_admin']}) == {'ok':False,'reason':'generationFailed'}
    # Only a validated ID+nonce selects the artifact. Mail can read but cannot replace or unlink it.
    occurrence, token = str(uuid.uuid4()), str(uuid.uuid4())
    path = DIRECTORY + '/' + occurrence + '-' + token + '.xlsx'
    try:
        as_user('aihr-report-renderer', "import os;f=os.open(%r,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640);os.write(f,b'fixture');os.close(f)" % path)
        assert as_user('aihr-identity-email', "print(open(%r,'rb').read().decode())" % path).strip() == b'fixture'
        as_user('aihr-identity-email', """import os
for action in [lambda:open(%r,'wb'),lambda:os.unlink(%r)]:
 try:action()
 except PermissionError:continue
 raise RuntimeError('mail wrote renderer artifact')
""" % (path,path))
        assert request_as_mail({'phase':'remove','occurrenceId':occurrence,'leaseToken':token}) == {'ok':True,'removed':True}
        assert not os.path.lexists(path)
    finally:
        # Root removes only this fresh fixture path, never a caller-supplied path or existing artifact.
        if os.path.lexists(path):os.unlink(path)
    assert request_as_mail({'phase':'status'}) == {'ok':True,'ready':True}
    for unit, expected in [('aihr-identity-email.service',192*1024*1024),('aihr-report-renderer@.service',512*1024*1024),('aihrmanagedmail.slice',768*1024*1024)]:
        value = subprocess.check_output(['systemctl','show',unit,'--property=MemoryMax','--value'],timeout=10).strip()
        assert int(value) == expected
    print('Installed peer/DAC/artifact boundaries demonstrated. No report rows rendered or mail sent.')
    print('Workbook/runtime peak memory and SMTP acknowledgement outcomes require their separate controlled fixtures.')

if __name__ == '__main__':
    try:main()
    except Exception:
        print('Installed report isolation probe refused; inspect service state without printing private inputs.')
        raise SystemExit(1)
