#!/usr/bin/python3
"""Explicit root Linux configuration/DAC probe. No report/consent rows, credentials or SMTP tests."""
import argparse
import grp
import json
import os
import pwd
import socket
import stat
import subprocess
import uuid

SOCKET = '/run/aihr-report-auth.sock'
RENDERER = '/run/aihr-report-renderer.sock'
DIRECTORY = '/var/lib/aihr-report-renderer/render'

def command(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=50).decode().strip()

def as_user(user, source, group=None):
    args = ['/usr/sbin/runuser', '-u', user]
    if group:
        args.extend(['-g', group])
    return command(args + ['--', '/usr/bin/python3', '-I', '-c', source])

def denied_root_peer(path, body):
    peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    peer.settimeout(45)
    try:
        peer.connect(path);peer.sendall(json.dumps(body).encode());peer.shutdown(socket.SHUT_WR)
        try:reply = peer.recv(4096)
        except ConnectionResetError:reply = b''
        assert reply == b''
    finally:
        peer.close()

def request_mail(body):
    return json.loads(as_user('aihr-identity-email', """import socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(45);s.connect(%r)
s.sendall(%r);s.shutdown(socket.SHUT_WR);b=b''
while True:
 c=s.recv(4096)
 if not c:break
 b+=c
 if len(b)>524288:raise RuntimeError('invalid response')
print(b.decode())
""" % (SOCKET, json.dumps(body).encode()), 'aihr-report-files'))

def main():
    parser = argparse.ArgumentParser();parser.add_argument('--web-unit', required=True);args = parser.parse_args()
    if os.getuid() != 0 or not args.web_unit.endswith('.service') or '/' in args.web_unit:
        raise RuntimeError('Explicit root web-unit probe required')
    web = command(['systemctl','show',args.web_unit,'--property=User','--value'])
    broker = pwd.getpwuid(int(web)) if web.isdecimal() else pwd.getpwnam(web)
    web = broker.pw_name
    mail = pwd.getpwnam('aihr-identity-email');renderer = pwd.getpwnam('aihr-report-renderer')
    assert min(broker.pw_uid,mail.pw_uid,renderer.pw_uid)>0 and len({broker.pw_uid,mail.pw_uid,renderer.pw_uid})==3
    config = os.stat('/etc/aihr-internal-report');assert config.st_uid==0 and stat.S_IMODE(config.st_mode)==0o700
    for name in ['broker.env','sender.env','renderer.env','runner.env']:
        info=os.lstat('/etc/aihr-internal-report/'+name);assert stat.S_ISREG(info.st_mode) and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600
    # Probe ordinary DAC outside mount namespaces; runtime units additionally hide these paths.
    for user in ['aihr-identity-email','aihr-report-renderer']:
        as_user(user,"""import os
try:open('/etc/aihr-internal-report/broker.env','rb')
except PermissionError:pass
else:raise RuntimeError('broker key configuration readable')
""")
    clients = grp.getgrnam('aihr-report-clients');files = grp.getgrnam('aihr-report-files')
    assert files.gr_gid not in os.getgrouplist(web,broker.pw_gid)
    assert clients.gr_gid not in os.getgrouplist(web,broker.pw_gid) # service-only supplementary group
    auth=os.lstat(SOCKET);render=os.lstat(RENDERER)
    assert stat.S_ISSOCK(auth.st_mode) and auth.st_uid==mail.pw_uid and stat.S_IMODE(auth.st_mode)==0o600
    assert stat.S_ISSOCK(render.st_mode) and render.st_uid==mail.pw_uid and render.st_gid==clients.gr_gid and stat.S_IMODE(render.st_mode)==0o660
    # Root bypasses DAC but the actual kernel peer UID still must fail.
    denied_root_peer(SOCKET,{'phase':'status'});denied_root_peer(RENDERER,{'phase':'status'})
    for user in [web,'aihr-report-renderer','nobody']:
        as_user(user,"""import socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:s.connect(%r)
except PermissionError:pass
else:raise RuntimeError('non-sender reached Auth socket')
""" % SOCKET)
    status_reply=request_mail({'phase':'status'});assert set(status_reply)=={'available'} and type(status_reply['available']) is bool
    # Unknown/caller-authority fields are refused before any private material is returned.
    as_user('aihr-identity-email',"""import socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(45);s.connect(%r)
s.sendall(b'{"phase":"status","subject":"caller-authority"}');s.shutdown(socket.SHUT_WR)
try:b=s.recv(4096)
except ConnectionResetError:b=b''
assert b==b''
""" % SOCKET,'aihr-report-files')
    # Artifact fixture uses only fresh UUID-derived owned path; sender group mirrors its actual unit.
    occurrence,lease=str(uuid.uuid4()),str(uuid.uuid4());path=DIRECTORY+'/'+occurrence+'-'+lease+'.xlsx'
    try:
        as_user('aihr-report-renderer',"import os;f=os.open(%r,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640);os.write(f,b'fictional');os.close(f)" % path)
        assert as_user('aihr-identity-email',"print(open(%r,'rb').read().decode())" % path,'aihr-report-files')=='fictional'
        as_user('aihr-identity-email',"""import os
for action in [lambda:open(%r,'wb'),lambda:os.unlink(%r)]:
 try:action()
 except PermissionError:continue
 raise RuntimeError('sender can mutate artifact')
""" % (path,path),'aihr-report-files')
        as_user(web,"""try:open(%r,'rb')
except PermissionError:pass
else:raise RuntimeError('web principal can read artifact')
""" % path)
    finally:
        if os.path.lexists(path):os.unlink(path) # root cleanup only this newly owned fixture
    for unit,expected in [('aihr-internal-report.service',192*1024*1024),('aihr-report-auth@.service',192*1024*1024),('aihrmanagedmail-dispatch.slice',192*1024*1024),('aihr-report-renderer@.service',512*1024*1024),('aihrmanagedmail.slice',768*1024*1024)]:
        assert int(command(['systemctl','show',unit,'--property=MemoryMax','--value']))==expected
    for unit in ['aihr-internal-report.service','aihr-report-auth@.service']:
        assert command(['systemctl','show',unit,'--property=Slice','--value'])=='aihrmanagedmail-dispatch.slice'
    assert 'aihr-report-clients' in command(['systemctl','show','aihr-report-auth@.service','--property=SupplementaryGroups','--value']).split()
    print('Configured UID/socket/DAC/budget boundaries demonstrated; no report rows or mail used.')
    print('Actual nonce authorization, process-exit ordering, peak memory, crash and SMTP remain separate acceptance.')

if __name__=='__main__':
    try:main()
    except Exception:
        print('Internal report isolation probe refused; inspect private service state without logging inputs.')
        raise SystemExit(1)
