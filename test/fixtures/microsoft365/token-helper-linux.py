"""Disposable GitHub-hosted Linux probe. Refuses every pre-existing AIHR path; never uses real secrets."""
import json,os,pathlib,pwd,selectors,shutil,signal,socket,stat,subprocess,sys,time

def run(args):
    return subprocess.check_output(args,stderr=subprocess.DEVNULL,timeout=8,text=True).strip()

def show(unit,key):return run(['systemctl','show',unit,'--property='+key,'--value'])
def instances():return [line.split()[0] for line in run(['systemctl','list-units','--all','--no-legend','--plain','aihr-smtp-token@*.service']).splitlines()]
def wait_idle():
    deadline=time.monotonic()+6
    while any(show(unit,'ActiveState') in ['active','activating','deactivating'] for unit in instances()):
        assert time.monotonic()<deadline;time.sleep(.05)

def ready(child):
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout,selectors.EVENT_READ);assert selector.select(5)
        return child.stdout.readline().decode().strip()

def main():
    assert sys.platform=='linux' and os.getuid()==0
    assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
    uid=int(sys.argv[1]);assert uid>0;user=pwd.getpwuid(uid).pw_name
    source=pathlib.Path('deploy/identity-email').resolve();assert (source/'smtp-token-peer.py').is_file()
    runtime=pathlib.Path('/usr/local/lib/aihr-identity-email');private=pathlib.Path('/etc/aihr-internal-report')
    renderer=pathlib.Path('/var/lib/aihr-report-renderer');app=pathlib.Path('/opt/ai-hr')
    names=['aihr-smtp-token.socket','aihr-smtp-token@.service','aihrmanagedmail.slice','aihrmanagedmail-dispatch.slice']
    units=[pathlib.Path('/etc/systemd/system')/name for name in names];sock='/run/aihr-smtp-token.sock'
    assert all(not p.exists() and not p.is_symlink() for p in [runtime,private,renderer,app,*units,pathlib.Path(sock)])
    assert not instances()
    created=[];files=[];children=[]
    def write(path,content):
        with path.open('xb') as stream:stream.write(content)
        os.chmod(path,0o644);files.append(path)
    try:
        for directory in [runtime,private,renderer,app]:directory.mkdir(mode=0o700 if directory==private else 0o755);created.append(directory)
        write(private/'broker.env',b'AUTH_SESSION_KEY=fictional-private-file-marker\n');os.chmod(private/'broker.env',0o600)
        write(runtime/'smtp-token-peer.py',(source/'smtp-token-peer.py').read_bytes())
        for name,path in zip(names,units):write(path,(source/name).read_text().replace('@WEB_USER@',user).replace('@WEB_UID@',str(uid)).encode())
        run(['systemctl','daemon-reload']);run(['systemctl','start','aihr-smtp-token.socket'])
        info=os.lstat(sock);assert stat.S_ISSOCK(info.st_mode) and info.st_uid==uid and stat.S_IMODE(info.st_mode)==0o600
        web=subprocess.Popen(['runuser','-u',user,'--','env','-i','PATH=/usr/bin:/bin','AUTH_SESSION_KEY=fictional-process-key-marker','python3','-I','-c','import os,time;print(os.getpid(),flush=True);time.sleep(40)'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True);children.append(web)
        webpid=int(ready(web));assert os.stat('/proc/'+str(webpid)).st_uid==uid
        assert b'AUTH_SESSION_KEY=fictional-process-key-marker' in pathlib.Path('/proc/'+str(webpid)+'/environ').read_bytes().split(b'\0')
        client_code="import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(15);s.connect(%r);print('ready',flush=True);sys.stdin.buffer.read(1);s.sendall(b'{\"op\":\"status\"}');s.shutdown(socket.SHUT_WR);b=b''\nwhile True:\n c=s.recv(4096)\n if not c:break\n b+=c;assert len(b)<4096\nprint(b.decode(),flush=True)" % sock
        client=subprocess.Popen(['runuser','-u',user,'--','python3','-I','-c',client_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True);children.append(client);assert ready(client)=='ready'
        deadline=time.monotonic()+5;unit=None
        while unit is None:
            active=[name for name in instances() if show(name,'ActiveState')=='active']
            if active:assert len(active)==1;unit=active[0];break
            assert time.monotonic()<deadline;time.sleep(.03)
        # Type=simple becomes active before systemd finishes exec/credential setup.
        # Observe the actual installed helper before inspecting its identity; all
        # credential, namespace and resource assertions below remain mandatory.
        deadline=time.monotonic()+5
        while True:
            pid=int(show(unit,'MainPID'))
            try:command=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\0') if pid>0 else []
            except FileNotFoundError:command=[]
            if os.fsencode(runtime/'smtp-token-peer.py') in command:break
            assert time.monotonic()<deadline,'Installed token helper did not execute under systemd'
            time.sleep(.03)
        helper_uid=os.stat('/proc/'+str(pid)).st_uid;assert helper_uid>0 and helper_uid!=uid
        assert show(unit,'DynamicUser')=='yes' and show(unit,'EnvironmentFiles')==''
        env=pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\0')
        assert not any(part.startswith(prefix) for part in env for prefix in [b'DATABASE_URL=',b'MIGRATION_DATABASE_URL=',b'AUTH_SESSION_KEY=',b'IDENTITY_EMAIL_DATABASE_URL='])
        status=pathlib.Path('/proc/'+str(pid)+'/status').read_text().splitlines()
        credentials={key:[int(n) for n in next(line for line in status if line.startswith(key)).split()[1:]] for key in ['Uid:','Gid:','Groups:']}
        assert set(credentials['Uid:'])=={helper_uid};gid=credentials['Gid:'][0];assert set(credentials['Gid:'])=={gid}
        groups=credentials['Groups:'];group_args=['--groups',','.join(map(str,groups))] if groups else ['--clear-groups']
        probe="import os\nassert os.getuid()==%d and os.getgid()==%d and sorted(os.getgroups())==%r\nfor path in %r:\n try:open(path,'rb')\n except (PermissionError,FileNotFoundError):pass\n else:raise RuntimeError('private material readable')" % (helper_uid,gid,sorted(groups),['/proc/'+str(webpid)+'/environ',str(private/'broker.env')])
        run(['nsenter','--target',str(pid),'--mount','--','setpriv','--reuid',str(helper_uid),'--regid',str(gid),*group_args,'python3','-I','-c',probe])
        cgroup=pathlib.Path('/sys/fs/cgroup'+show(unit,'ControlGroup'));peak=int((cgroup/'memory.peak').read_text());assert 0<peak<=33554432 and int((cgroup/'memory.max').read_text())==33554432
        events=dict(line.split() for line in (cgroup/'memory.events').read_text().splitlines());assert events.get('oom_kill')=='0'
        assert int(show('aihrmanagedmail-dispatch.slice','MemoryMax'))==192*1024*1024
        client.stdin.write(b'1');client.stdin.flush();client.stdin.close();assert json.loads(ready(client))=={'available':True};assert client.wait(timeout=5)==0;wait_idle()
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as root:
            root.settimeout(5);root.connect(sock);root.sendall(b'{"op":"status"}');root.shutdown(socket.SHUT_WR)
            try:reply=root.recv(4096)
            except ConnectionResetError:reply=b''
            assert reply==b''
        wait_idle()
        run(['runuser','-u','nobody','--','python3','-I','-c',"import socket\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ntry:s.connect(%r)\nexcept PermissionError:pass\nelse:raise RuntimeError('foreign peer reached capability')" % sock])
        print(json.dumps({'status':'passed','privatePeerOnly':True,'keyAndDatabaseFree':True,'actualNamespaceDenial':True,'statusWithoutNetwork':True,'memoryPeakBytes':peak,'memoryMaxBytes':33554432,'oomKills':0}))
    finally:
        for child in children:
            if child.poll() is None:os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=3)
        try:run(['systemctl','stop','aihr-smtp-token.socket',*instances()])
        finally:
            for file in reversed(files):file.unlink()
            for directory in reversed(created):directory.rmdir()
            run(['systemctl','daemon-reload'])

if __name__=='__main__':
    def deadline(*args):raise TimeoutError('Owned Linux probe deadline')
    signal.signal(signal.SIGALRM,deadline);signal.alarm(40)
    main()
