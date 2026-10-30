"""Reviewed installer fragment; generate a self-contained private helper with the reviewed byte format.
No entry point here. Human bootstrap must hash-pin the generated helper before Python -I execution.
Only a first staging installation is supported; existing identities, units and environments refuse.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import tempfile
import time
from urllib.parse import urlsplit,unquote,parse_qsl

SOURCE=Path('/opt/ai-hr')
ROOT=Path('/opt/aihr-import')
NODE=Path('/opt/node22/bin/node')
ENV=Path('/etc/aihr/import-worker.env')
UNIT=Path('/etc/systemd/system/aihr-bank-import.service')
USER='aihr-import'
LOCK_DIRECTORY=Path('/run/aihr-bank-import')
BASE_ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'}
ENV_KEYS={'DATABASE_URL','MIGRATION_DATABASE_URL','AUDIT_HASH_CHAIN_ENABLED','NODE_EXTRA_CA_CERTS','PGSSLMODE','PGSSLROOTCERT','PGSSLCERT','PGSSLKEY'}

class ActivationInterrupted(Exception): pass

@contextmanager
def activation_guard(cleanup):
    signals=(signal.SIGHUP,signal.SIGTERM,signal.SIGINT)
    previous={item:signal.getsignal(item) for item in signals}
    def interrupted(signum,frame): raise ActivationInterrupted('activation interrupted by '+signal.Signals(signum).name)
    for item in signals: signal.signal(item,interrupted)
    try: yield
    except BaseException:
        # A second terminal/session signal must not interrupt the managed transaction drain.
        for item in signals: signal.signal(item,signal.SIG_IGN)
        cleanup()
        raise
    finally:
        for item,handler in previous.items(): signal.signal(item,handler)

def check(ok,message):
    if not ok: raise ValueError('Worker installation refused: '+message)

def command(argv,*,input=None,env=None,allow_failure=False):
    result=subprocess.run(argv,input=input,env=env or BASE_ENV,cwd='/',capture_output=True,text=True,timeout=45)
    if not allow_failure: check(result.returncode==0,'administrator/runtime command failed (credentials suppressed)')
    return result

def root_protected(path,regular=False):
    path=Path(path);check(path.is_absolute() and str(path)==str(path.absolute()) and '..' not in path.parts,'absolute protected path required')
    for item in [path,*path.parents]:
        info=item.lstat()
        check(not stat.S_ISLNK(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'root-owned non-writable path and ancestors required')
        if item==path and regular: check(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and not info.st_mode&(stat.S_ISUID|stat.S_ISGID),'root-owned non-setid regular executable/file required')
        elif item!=path or not regular: check(stat.S_ISDIR(info.st_mode),'protected directory required')

def install_lock_directory():
    root_protected(LOCK_DIRECTORY.parent)
    if not LOCK_DIRECTORY.exists(): LOCK_DIRECTORY.mkdir(mode=0o755)
    root_protected(LOCK_DIRECTORY)
    return LOCK_DIRECTORY

def read_bounded(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd);check(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit,'bounded non-linked regular input required')
        chunks=[];size=0
        while True:
            block=os.read(fd,1024**2)
            if not block: break
            chunks.append(block);size+=len(block);check(size<=limit,'input exceeds bound')
        after=os.fstat(fd)
        check((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'input changed while reading')
        return b''.join(chunks)
    finally: os.close(fd)

def snapshot_archive(source,target,expected,limit):
    """Authenticate a copied inode; never reopen a web-writable archive after hashing."""
    incoming=os.open(source,os.O_RDONLY|os.O_NOFOLLOW);outgoing=None
    try:
        info=os.fstat(incoming);check(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=limit,'bounded archive input required')
        outgoing=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);h=hashlib.sha256();total=0
        while True:
            block=os.read(incoming,1024**2)
            if not block: break
            total+=len(block);check(total<=limit,'archive exceeds bound');h.update(block)
            view=memoryview(block)
            while view: view=view[os.write(outgoing,view):]
        os.fsync(outgoing);check(h.hexdigest()==expected,'independently authenticated archive digest differs')
    finally:
        os.close(incoming)
        if outgoing is not None: os.close(outgoing)

def database_config(value,role):
    check(isinstance(value,str) and not any(ord(c)<32 or ord(c)==127 for c in value),'invalid database URI')
    parsed=urlsplit(value);pairs=parse_qsl(parsed.query,keep_blank_values=True)
    check(parsed.scheme in ('postgres','postgresql') and parsed.hostname in ('localhost','127.0.0.1') and not parsed.fragment,'only the approved local staging database is supported')
    check(unquote(parsed.username or '')==role and parsed.password is not None and unquote(parsed.path)=='/ai_hr','approved distinct staging database roles required')
    check(len(pairs)==len(dict(pairs)) and set(dict(pairs))<={'sslmode','sslrootcert','sslcert','sslkey'},'unexpected connection options')
    return {'PGHOST':parsed.hostname,'PGPORT':str(parsed.port or 5432),'PGUSER':role,'PGPASSWORD':unquote(parsed.password),'PGDATABASE':'ai_hr',**{'PG'+key.upper():item for key,item in pairs}}

def deployment_state(source,build):
    state_root=Path('/var/tmp/aihr-deploy');check(not (state_root/'pending').exists(),'staging deployment pending')
    records=[read_bounded(state_root/name,65536) for name in ('current','last-ok')]
    current,prior=[dict(line.split('=',1) for line in raw.decode().splitlines() if '=' in line) for raw in records]
    check(current.get('result')=='ok' and current.get('ref')==source and prior.get('ref')==source and prior.get('build_id')==build,'exact independently verified web release must be installed first')
    check(read_bounded(SOURCE/'.next/BUILD_ID',1024).decode().strip()==build,'running build identity changed')
    return records

def service_unit(source):
    check(re.fullmatch('[a-f0-9]{40}',source or ''),'source SHA required')
    return f'''[Unit]
Description=AI HR Bank and Statutory import worker
After=network-online.target aihr.service
Wants=network-online.target
[Service]
Type=simple
User=aihr-import
Group=aihr-import
WorkingDirectory=/opt/aihr-import/releases/{source}
Environment=NODE_ENV=production
EnvironmentFile=/etc/aihr/import-worker.env
UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH
ExecStart=/opt/node22/bin/node --import tsx scripts/bank-import-runner.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=300
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
UMask=0077
[Install]
WantedBy=multi-user.target
'''

def write_new(path,data,mode):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as stream: stream.write(data);stream.flush();os.fsync(stream.fileno())

def service_properties():
    fields=['User','Group','WorkingDirectory','FragmentPath','DropInPaths','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition','Environment','EnvironmentFiles','PassEnvironment','RootDirectory','RootImage','PAMName','MainPID','NRestarts','ActiveState','SubState','UnitFileState']
    raw=command(['/usr/bin/systemctl','show','aihr-bank-import.service','--no-pager',*['--property='+key for key in fields]]).stdout
    properties=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
    # systemctl omits empty command arrays even with --all on this installation. Prove their
    # actual typed values; missing/unknown D-Bus properties are never treated as empty.
    unit=json.loads(command(['/usr/bin/busctl','--json=short','call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','LoadUnit','s','aihr-bank-import.service']).stdout)
    check(unit.get('type')=='o' and isinstance(unit.get('data'),list) and len(unit['data'])==1 and re.fullmatch('/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+',unit['data'][0]),'typed unit metadata unavailable')
    properties['_commands']={key:json.loads(command(['/usr/bin/busctl','--json=short','get-property','org.freedesktop.systemd1',unit['data'][0],'org.freedesktop.systemd1.Service',key]).stdout) for key in ['ExecStart','ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition']}
    return properties

def validate_command_proofs(proofs):
    hooks={'ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition'}
    check(isinstance(proofs,dict) and set(proofs)==hooks|{'ExecStart'},'complete typed command proof required')
    for key,value in proofs.items():
        check(isinstance(value,dict) and set(value)=={'type','data'} and value['type']=='a(sasbttttuii)' and isinstance(value['data'],list),'unknown or malformed command property: '+key)
        if key in hooks: check(value['data']==[],'nonempty command hook: '+key)
        else:
            rows=value['data'];check(len(rows)==1 and isinstance(rows[0],list) and len(rows[0])==10,'one typed worker command required')
            row=rows[0];check(row[0]==str(NODE) and row[1]==[str(NODE),'--import','tsx','scripts/bank-import-runner.ts'] and row[2] is False and all(type(v) is int for v in row[3:]),'typed worker command differs')

def validate_service(properties,release):
    validate_command_proofs(properties.get('_commands'))
    for key,wanted in {'User':USER,'Group':USER,'WorkingDirectory':str(release),'FragmentPath':str(UNIT),'Environment':'NODE_ENV=production','EnvironmentFiles':str(ENV)+' (ignore_errors=no)'}.items():
        check(properties.get(key)==wanted,'actual worker service configuration differs: '+key)
    for key in ['DropInPaths','PassEnvironment','RootDirectory','RootImage','PAMName']:
        check(properties.get(key)=='','unreviewed service override: '+key)
    for key in ['ExecStartPre','ExecStartPost','ExecStop','ExecStopPost','ExecCondition']:
        check(key not in properties or properties[key]=='','nonempty displayed command hook: '+key)

def stop_owned_first_install():
    """Normal managed stop; independently disable even if the stop request fails or times out."""
    request_errors=[]
    try:
        try:
            result=command(['/usr/bin/systemctl','stop','--no-block','aihr-bank-import.service'],allow_failure=True)
            if result.returncode: request_errors.append('stop request failed')
        except Exception: request_errors.append('stop request unavailable')
    finally:
        try:
            result=command(['/usr/bin/systemctl','disable','aihr-bank-import.service'],allow_failure=True)
            if result.returncode: request_errors.append('disable request failed')
        except Exception: request_errors.append('disable request unavailable')
    # The unit permits a 300-second transaction drain. No individual command blocks longer than
    # 45 seconds; wait through that complete grace period plus a margin, without killing DB jobs.
    deadline=time.monotonic()+330
    while time.monotonic()<deadline:
        try:
            report=command(['/usr/bin/systemctl','show','aihr-bank-import.service','--no-pager','--property=ActiveState','--property=MainPID','--property=UnitFileState'])
            properties=dict(line.split('=',1) for line in report.stdout.splitlines() if '=' in line)
            if properties.get('ActiveState') in ('inactive','failed') and properties.get('MainPID')=='0' and properties.get('UnitFileState') in ('disabled','not-found'):
                return {'stopped':True,'disabled':True,'requestWarnings':request_errors}
        except Exception: pass
        time.sleep(2)
    raise RuntimeError('Worker failure recovery could not confirm stopped and disabled; administrator intervention is required. Jobs and upload chunks were preserved.')

def install(argv,fmt):
    parser=argparse.ArgumentParser()
    for name in ('archive','archive-sha256','source','build-id','lock-sha256','package-sha256','env-sha256'): parser.add_argument('--'+name,required=True)
    args=parser.parse_args(argv);check(os.geteuid()==0,'administrator must run the hash-pinned helper with Python -I')
    check(re.fullmatch('[a-f0-9]{40}',args.source or '') and re.fullmatch('[A-Za-z0-9_-]{1,160}',args.build_id or ''),'exact source and build identity required')
    for value in (args.archive_sha256,args.lock_sha256,args.package_sha256,args.env_sha256): check(re.fullmatch('[a-f0-9]{64}',value or ''),'independently authenticated digests required')
    root_protected(NODE,regular=True)
    check(command([str(NODE),'--version']).stdout.strip()=='v22.23.3','reviewed Node runtime required')
    lock_directory=install_lock_directory()
    lock_fd=os.open(lock_directory/'install.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    lock_info=os.fstat(lock_fd);check(lock_info.st_uid==0 and stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink==1 and not lock_info.st_mode&0o077,'private administrator lock required')
    fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    check(not UNIT.exists() and not UNIT.is_symlink() and not ENV.exists() and not ENV.is_symlink(),'first installation only; existing unit/environment needs separate review')
    for folder in ('/etc/systemd/system','/run/systemd/system','/usr/lib/systemd/system'):
        check(not (Path(folder)/UNIT.name).exists() and not (Path(folder)/(UNIT.name+'.d')).exists(),'existing worker unit/drop-in needs separate review')
    try: pwd.getpwnam(USER)
    except KeyError: pass
    else: check(False,'existing worker identity needs separate review')
    state=deployment_state(args.source,args.build_id)
    command(['/usr/bin/systemctl','is-active','--quiet','aihr'])
    for directory in (ROOT,ROOT/'releases'):
        if not directory.exists(): root_protected(directory.parent);directory.mkdir(mode=0o755)
        root_protected(directory)
    private=Path(tempfile.mkdtemp(prefix='install-v2-',dir=ROOT));os.chmod(private,0o700)
    archive=private/'authenticated-worker.zip';snapshot_archive(args.archive,archive,args.archive_sha256,fmt.MAX_ARCHIVE)
    manifest=fmt.inspect_archive(archive,args.source,args.lock_sha256,args.package_sha256)
    staged=private/'release';staged.mkdir(mode=0o700);fmt.extract_archive(archive,staged,args.source,args.lock_sha256,args.package_sha256)
    raw_env=read_bounded(SOURCE/'.env.production',1024**2)
    check(hashlib.sha256(raw_env).hexdigest()==args.env_sha256,'independently pinned raw environment digest differs (not the combined install-grant fingerprint)')
    code="const fs=require('node:fs'),{parseEnv}=require('node:util');const e=parseEnv(fs.readFileSync(0,'utf8'));const keys="+json.dumps(sorted(ENV_KEYS))+";console.log(JSON.stringify(Object.fromEntries(keys.filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))));"
    environment=json.loads(command([str(NODE),'-e',code],input=raw_env.decode()).stdout)
    check(set(environment)<=ENV_KEYS and all(isinstance(v,str) and len(v)<=65536 and not any(ord(c)<32 or ord(c)==127 for c in v) for v in environment.values()),'unsupported selected environment value')
    app=database_config(environment.get('DATABASE_URL'),'ai_hr_app');owner=database_config(environment.get('MIGRATION_DATABASE_URL'),'ai_hr_owner')
    check((app['PGHOST'],app['PGPORT'],app['PGDATABASE'])==(owner['PGHOST'],owner['PGPORT'],owner['PGDATABASE']),'app and physical owner must target the same approved staging database')
    sql="SELECT json_build_object('role',current_user,'database',current_database(),'super',r.rolsuper,'bypass',r.rolbypassrls,'owner',c.relowner=r.oid)::text FROM pg_roles r JOIN pg_class c ON c.oid='public.bank_import_job'::regclass WHERE r.rolname=current_user;"
    for config,is_owner in [(app,False),(owner,True)]:
        for key in ('PGSSLROOTCERT','PGSSLCERT','PGSSLKEY'):
            value=config.get(key,environment.get(key))
            if value: root_protected(value,regular=True)
        settings={**BASE_ENV,**{k:v for k,v in environment.items() if k.startswith('PGSSL')},**config,'PGPASSFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'}
        proof=json.loads(command(['/usr/bin/psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],input=sql,env=settings).stdout)
        check(proof['role']==config['PGUSER'] and proof['database']=='ai_hr' and proof['owner']==is_owner and (is_owner or not proof['super'] and not proof['bypass']),'live database role/table-ownership proof differs')
    for key in ('NODE_EXTRA_CA_CERTS',):
        if environment.get(key): root_protected(environment[key],regular=True)
    release=ROOT/'releases'/args.source;check(not release.exists() and not release.is_symlink(),'immutable release already exists')
    entry_by_path={row['path']:row for row in manifest['entries']}
    for path in staged.rglob('*'):
        if not path.is_symlink(): os.chmod(path,0o755 if path.is_dir() else entry_by_path[path.relative_to(staged).as_posix()]['mode'])
    os.chmod(staged,0o755);os.rename(staged,release)
    if not ENV.parent.exists(): root_protected(ENV.parent.parent);ENV.parent.mkdir(mode=0o700)
    root_protected(ENV.parent);root_protected(UNIT.parent)
    unit=service_unit(args.source).encode();unit_written=False;started=False
    try:
        with activation_guard(lambda: stop_owned_first_install() if unit_written else None):
            command(['/usr/sbin/useradd','--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',USER])
            identity=pwd.getpwnam(USER);check(identity.pw_uid>0 and identity.pw_gid>0,'non-root dedicated identity required')
            for key in ('NODE_EXTRA_CA_CERTS','PGSSLROOTCERT','PGSSLCERT','PGSSLKEY'):
                values={environment.get(key),app.get(key),owner.get(key)}-{None,''}
                for value in values: command(['/usr/sbin/runuser','--user',USER,'--','/usr/bin/test','-r',value])
            check(deployment_state(args.source,args.build_id)==state,'web deployment changed during preparation')
            write_new(ENV,(''.join(key+'='+json.dumps(environment[key],ensure_ascii=False)+'\n' for key in sorted(environment))).encode(),0o600)
            write_new(UNIT,unit,0o644);unit_written=True
            command(['/usr/bin/systemctl','daemon-reload']);validate_service(service_properties(),release)
            command(['/usr/bin/systemctl','start','aihr-bank-import.service']);started=True
            expected_pid=None
            for attempt in range(3):
                time.sleep(4);properties=service_properties();validate_service(properties,release)
                check(properties['ActiveState']=='active' and properties['SubState']=='running' and properties['NRestarts']=='0','worker must remain running without restarts')
                pid=int(properties['MainPID']);check(pid>0 and (expected_pid is None or expected_pid==pid),'worker PID changed');expected_pid=pid
                process=Path('/proc')/str(pid)
                check(process.stat().st_uid==identity.pw_uid and (process/'cwd').resolve()==release,'live worker user/directory differ')
                check(read_bounded(process/'cmdline',65536).split(b'\0')[:-1]==[str(NODE).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'],'live worker command differs')
                # procfs has st_size=0, but read_bounded still enforces the actual read ceiling.
                actual=dict(item.split(b'=',1) for item in read_bounded(process/'environ',1024**2).split(b'\0') if b'=' in item)
                check(all(actual.get(k.encode())==v.encode() for k,v in environment.items()),'live selected worker environment differs')
                check(not any(k.encode() in actual for k in ('NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH')),'unexpected worker loader environment')
            check(deployment_state(args.source,args.build_id)==state,'web deployment changed before worker acceptance')
            check(hashlib.sha256(read_bounded(ENV,1024**2)).hexdigest()==hashlib.sha256((''.join(key+'='+json.dumps(environment[key],ensure_ascii=False)+'\n' for key in sorted(environment))).encode()).hexdigest(),'protected worker environment changed')
            command(['/usr/bin/systemctl','enable','aihr-bank-import.service'])
            record={'source':args.source,'webBuildId':args.build_id,'archiveSha256':args.archive_sha256,'manifestSha256':fmt.digest(fmt.canonical(manifest)),'selectedEnvironmentSha256':hashlib.sha256(read_bounded(ENV,1024**2)).hexdigest(),'unitSha256':hashlib.sha256(unit).hexdigest(),'workerPid':expected_pid,'serviceStable':True,'journeyVerified':False}
            write_new(release/'worker-install-v2.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o444)
            print(json.dumps(record))
    finally: os.close(lock_fd)
