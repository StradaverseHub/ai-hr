#!/usr/bin/python3
"""Explicit root Linux configuration/DAC probe. No report/consent rows, credentials or SMTP tests."""
import argparse
import grp
import json
import os
import pwd
import selectors
import signal
import socket
import stat
import subprocess
import time
import uuid

SOCKET = '/run/aihr-report-auth.sock'
RENDERER = '/run/aihr-report-renderer.sock'
DIRECTORY = '/var/lib/aihr-report-renderer/render'

def command(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=50, env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'}).decode().strip()

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
    source = "import json,subprocess\nr=subprocess.run(['/usr/bin/python3','-I','/usr/local/lib/aihr-identity-email/report-auth-peer.py','--client'],input=%r,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=45,check=True,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'})\nassert len(r.stdout)<=524288\nprint(r.stdout.decode())" % json.dumps(body).encode()
    return json.loads(as_user('aihr-identity-email', source, 'aihr-report-files'))

def process_pin(pid):
    assert isinstance(pid, int) and pid > 1
    raw=open('/proc/'+str(pid)+'/stat',encoding='ascii').read(4096)
    at=raw.rfind(') ');assert at>0
    ticks=raw[at+2:].split()[19];assert ticks.isdecimal()
    return (pid,ticks,os.stat('/proc/'+str(pid)).st_uid)

def assert_process_pin(pid, pin):
    assert process_pin(pid)==pin

def unit_process(unit, uid):
    assert unit.endswith('.service') and '/' not in unit
    assert command(['systemctl','show',unit,'--property=ActiveState','--value'])=='active'
    pid=int(command(['systemctl','show',unit,'--property=MainPID','--value']))
    pin=process_pin(pid);assert pin[2]==uid
    assert open('/proc/'+str(pid)+'/cgroup',encoding='ascii').read(4096).strip().endswith('/'+unit)
    return pid,pin

def service_credentials(status, expected_uid):
    rows={}
    for key in ['Uid:', 'Gid:', 'Groups:']:
        found=[row.split()[1:] for row in status.splitlines() if row.startswith(key)]
        assert len(found)==1 and all(value.isdecimal() for value in found[0])
        rows[key]=[int(value) for value in found[0]]
    uids,gids,groups=rows['Uid:'],rows['Gid:'],rows['Groups:']
    # setpriv must reproduce every credential identity, not weaken a process with mixed IDs.
    assert len(uids)==4 and all(value==expected_uid for value in uids) and expected_uid>0
    assert len(gids)==4 and len(set(gids))==1 and len(groups)<=32
    return expected_uid,gids[1],sorted(groups)

def process_environment_denial(namespace_pid, namespace_pin, target_pid, target_pin):
    assert_process_pin(namespace_pid,namespace_pin);assert_process_pin(target_pid,target_pin)
    status=open('/proc/'+str(namespace_pid)+'/status',encoding='ascii').read(16384)
    credentials=service_credentials(status,namespace_pin[2]);uid,gid,groups=credentials
    assert uid!=target_pin[2]
    with open('/proc/'+str(namespace_pid)+'/environ','rb') as stream:
        own_environment=stream.read(131073)
    assert len(own_environment)<=131072 and not any(part.startswith(b'AUTH_SESSION_KEY=') for part in own_environment.split(b'\0'))
    del own_environment
    # Root proves the pinned target really carries a nonempty key; bytes never leave this process.
    with open('/proc/'+str(target_pid)+'/environ','rb') as stream:
        environment=stream.read(131073)
    assert len(environment)<=131072 and any(part.startswith(b'AUTH_SESSION_KEY=') and len(part)>17 for part in environment.split(b'\0'))
    del environment
    source="import os\nassert os.getuid()==os.geteuid()==%d and os.getgid()==os.getegid()==%d and sorted(os.getgroups())==%r\ntry:open('/proc/%d/environ','rb')\nexcept (PermissionError,FileNotFoundError):pass\nelse:raise RuntimeError('foreign process environment readable')" % (uid,gid,groups,target_pid)
    # Enter the real installed service's proc mount, then discard root/group authority.
    group_args=['--groups',','.join(str(value) for value in groups)] if groups else ['--clear-groups']
    command(['nsenter','--target',str(namespace_pid),'--mount','--','/usr/bin/setpriv','--reuid',str(uid),'--regid',str(gid)]+group_args+['/usr/bin/python3','-I','-c',source])
    assert_process_pin(namespace_pid,namespace_pin);assert_process_pin(target_pid,target_pin)
    assert service_credentials(open('/proc/'+str(namespace_pid)+'/status',encoding='ascii').read(16384),namespace_pin[2])==credentials

def active_renderers():
    rows=command(['systemctl','list-units','--no-legend','--plain','--state=active,activating','aihr-report-renderer@*.service']).splitlines()
    units=[row.split()[0] for row in rows];assert len(units)<=1
    return units

def namespace_environment_checks(web_pid, web_pin, mail, renderer):
    # Canonical read-only status starts the actual persistent sender; this creates no report/mail.
    as_user(mail.pw_name,"""import http.client,socket,json\nc=http.client.HTTPConnection('localhost',timeout=45);c.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);c.sock.settimeout(45);c.sock.connect('/run/aihr-internal-report.sock');c.request('POST','/v1/reports',body=b'{"op":"status"}',headers={'Content-Type':'application/json'});r=c.getresponse();assert r.status==200;b=r.read(4097);assert len(b)<=4096 and type(json.loads(b)['ready']) is bool;c.close()""",'aihr-report-files')
    sender_pid,sender_pin=unit_process('aihr-internal-report.service',mail.pw_uid)
    process_environment_denial(sender_pid,sender_pin,web_pid,web_pin)
    assert not active_renderers()  # Never borrow another request's namespace.
    # Hold only our new empty renderer connection until its real namespace has been inspected.
    source="import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(15);s.connect(%r);print('ready',flush=True);sys.stdin.buffer.read(1);s.close()" % RENDERER
    child=subprocess.Popen(['/usr/sbin/runuser','-u',mail.pw_name,'-g','aihr-report-files','--','/usr/bin/python3','-I','-c',source],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    owned_unit=None
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout,selectors.EVENT_READ);assert selector.select(5)
            assert child.stdout.readline(16)==b'ready\n'
        deadline=time.monotonic()+5
        while not owned_unit:
            units=active_renderers()
            if units:owned_unit=units[0];break
            assert time.monotonic()<deadline;time.sleep(0.02)
        while command(['systemctl','show',owned_unit,'--property=ActiveState','--value'])!='active':
            assert time.monotonic()<deadline;time.sleep(0.02)
        pid,pin=unit_process(owned_unit,renderer.pw_uid)
        process_environment_denial(pid,pin,web_pid,web_pin)
    finally:
        if child.stdin:child.stdin.close()
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if child.poll() is None:os.killpg(child.pid,signal.SIGKILL)
            child.wait(timeout=5)
        if child.stdout:child.stdout.close()
        if owned_unit:
            deadline=time.monotonic()+10
            while owned_unit in active_renderers():
                assert time.monotonic()<deadline;time.sleep(0.05)

def resource_configuration_checks():
    broker='aihr-report-auth@aihr-isolation-probe.service';renderer='aihr-report-renderer@aihr-isolation-probe.service'
    # show loads configuration only; bare template names are not invocable systemd units.
    for unit,template in [(broker,'aihr-report-auth@.service'),(renderer,'aihr-report-renderer@.service')]:
        for prop,expected in [('LoadState','loaded'),('ActiveState','inactive'),('MainPID','0'),('FragmentPath','/etc/systemd/system/'+template)]:
            assert command(['systemctl','show',unit,'--property='+prop,'--value'])==expected
    for unit,expected in [('aihr-internal-report.service',192*1024*1024),(broker,192*1024*1024),('aihrmanagedmail-dispatch.slice',192*1024*1024),(renderer,512*1024*1024),('aihrmanagedmail.slice',768*1024*1024)]:
        assert int(command(['systemctl','show',unit,'--property=MemoryMax','--value']))==expected
    for unit in ['aihr-internal-report.service',broker]:
        assert command(['systemctl','show',unit,'--property=Slice','--value'])=='aihrmanagedmail-dispatch.slice'
    assert 'aihr-report-clients' in command(['systemctl','show',broker,'--property=SupplementaryGroups','--value']).split()

def main():
    parser = argparse.ArgumentParser();parser.add_argument('--web-unit', required=True);args = parser.parse_args()
    if os.getuid() != 0 or not args.web_unit.endswith('.service') or '/' in args.web_unit:
        raise RuntimeError('Explicit root web-unit probe required')
    web = command(['systemctl','show',args.web_unit,'--property=User','--value'])
    broker = pwd.getpwuid(int(web)) if web.isdecimal() else pwd.getpwnam(web)
    web = broker.pw_name
    mail = pwd.getpwnam('aihr-identity-email');renderer = pwd.getpwnam('aihr-report-renderer')
    web_pid,web_pin=unit_process(args.web_unit,broker.pw_uid)
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
    namespace_environment_checks(web_pid,web_pin,mail,renderer)
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
s.sendall(b'{"phase":"status","subject":"caller-authority"}\\n');s.shutdown(socket.SHUT_WR)
try:b=s.recv(4096)
except ConnectionResetError:b=b''
assert b==b''
""" % SOCKET,'aihr-report-files')
    # Artifact fixture uses only fresh UUID-derived owned path; sender group mirrors its actual unit.
    # The probe's private operator umask is not the renderer's service umask. Match the verified
    # installed credentials/mask explicitly; otherwise an inherited0077 creates a0600 fixture that
    # the actual sender correctly refuses, without exercising the intended0640 group-read contract.
    fixture_unit='aihr-report-renderer@aihr-isolation-probe.service'
    assert command(['systemctl','show',fixture_unit,'--property=Group','--value'])==files.gr_name
    assert command(['systemctl','show',fixture_unit,'--property=UMask','--value'])=='0027'
    occurrence,lease=str(uuid.uuid4()),str(uuid.uuid4());path=DIRECTORY+'/'+occurrence+'-'+lease+'.xlsx'
    try:
        as_user('aihr-report-renderer',"import os;os.umask(0o027);f=os.open(%r,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640);os.write(f,b'fictional');os.close(f)" % path,files.gr_name)
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
    resource_configuration_checks()
    print('Configured UID/socket/DAC/budget boundaries demonstrated; no report rows or mail used.')
    print('Actual nonce authorization, process-exit ordering, peak memory, crash and SMTP remain separate acceptance.')

if __name__=='__main__':
    try:main()
    except Exception:
        print('Internal report isolation probe refused; inspect private service state without logging inputs.')
        raise SystemExit(1)
