"""Exact-install continuation only. Does not recreate identities, unit, environment or runtime bytes.
Vendored into a separately hash-pinned private helper after review; no privileged entry point here.
"""
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import tempfile
import time

def verify_existing_tree(release,manifest,fmt,ops):
    ops.root_protected(release);entries=fmt.validate_manifest(manifest,manifest['source']);observed=set()
    for base,dirs,files in os.walk(release,followlinks=False):
        for name in dirs+files: observed.add((Path(base)/name).relative_to(release).as_posix())
    ops.check(observed==set(entries),'installed runtime has missing or extra entries')
    for name,row in entries.items():
        path=release/name;info=path.lstat()
        if row['type']=='symlink':
            ops.check(stat.S_ISLNK(info.st_mode) and info.st_uid==0 and os.readlink(path)==row['target'] and path.resolve(strict=True).is_relative_to(release),'installed link differs or escapes')
        elif row['type']=='directory': ops.root_protected(path)
        else:
            ops.root_protected(path,regular=True)
            ops.check(stat.S_IMODE(info.st_mode)==row['mode'] and info.st_size==row['size'],'installed file mode/size differs')
            h=hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda:stream.read(1024**2),b''): h.update(block)
            ops.check(h.hexdigest()==row['sha256'],'installed file bytes differ')

def never_started(properties,ops):
    ops.check(all(properties.get(k)==v for k,v in {'ActiveState':'inactive','SubState':'dead','MainPID':'0','NRestarts':'0','UnitFileState':'disabled'}.items()),'continuation requires inactive disabled worker with no restarts')
    ops.validate_command_proofs(properties.get('_commands'))
    ops.check(all(value==0 for value in properties['_commands']['ExecStart']['data'][0][3:]),'worker has already executed; separate recovery review required')

def validate_identity(identity,people,groups,ops):
    ops.check(sorted(p.pw_name for p in people if p.pw_uid==identity.pw_uid)==[ops.USER],'worker UID is not unique')
    ops.check(sorted(p.pw_name for p in people if p.pw_gid==identity.pw_gid)==[ops.USER],'private worker GID has another primary owner')
    private=[g for g in groups if g.gr_gid==identity.pw_gid]
    ops.check(len(private)==1 and private[0].gr_name==ops.USER and set(private[0].gr_mem)<={ops.USER},'private worker group has aliases or other members')
    ops.check(all(g.gr_gid==identity.pw_gid for g in groups if ops.USER in g.gr_mem),'worker has unexpected supplementary group membership')

def recover(argv,fmt,ops):
    parser=argparse.ArgumentParser()
    for name in ('archive','archive-sha256','source','build-id','lock-sha256','package-sha256','env-sha256'): parser.add_argument('--'+name,required=True)
    args=parser.parse_args(argv);ops.check(os.geteuid()==0,'administrator must run the reviewed hash-pinned continuation with Python -I -B')
    ops.check(re.fullmatch('[a-f0-9]{40}',args.source or '') and re.fullmatch('[A-Za-z0-9_-]{1,160}',args.build_id or ''),'exact installed source/build required')
    for value in (args.archive_sha256,args.lock_sha256,args.package_sha256,args.env_sha256): ops.check(re.fullmatch('[a-f0-9]{64}',value or ''),'independently authenticated digest required')
    ops.root_protected(ops.NODE,regular=True);ops.check(ops.command([str(ops.NODE),'--version']).stdout.strip()=='v22.23.3','Node identity differs')
    # The old helper must have exited. Never wait through or break another administrator's lock.
    ops.root_protected(ops.LOCK_DIRECTORY);lock=ops.LOCK_DIRECTORY/'install.lock';ops.root_protected(lock,regular=True)
    ops.check(stat.S_IMODE(lock.stat().st_mode)==0o600,'original private install lock differs')
    lock_fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=ops.deployment_state(args.source,args.build_id);ops.command(['/usr/bin/systemctl','is-active','--quiet','aihr'])
        release=ops.ROOT/'releases'/args.source
        ops.root_protected(ops.ROOT);ops.root_protected(ops.ROOT/'releases');ops.root_protected(ops.UNIT,regular=True);ops.root_protected(ops.ENV,regular=True)
        ops.check(stat.S_IMODE(ops.ENV.stat().st_mode)==0o600,'private worker environment mode differs')
        unit=ops.service_unit(args.source).encode();ops.check(ops.read_bounded(ops.UNIT,65536)==unit,'installed fixed unit bytes differ')
        for record in ('worker-install-v2.json','worker-install-v2-recovery.json'): ops.check(not (release/record).exists(),'completed installation already recorded')
        identity=pwd.getpwnam(ops.USER)
        ops.check(identity.pw_uid>0 and identity.pw_gid>0 and identity.pw_shell=='/usr/sbin/nologin' and identity.pw_dir=='/nonexistent' and grp.getgrgid(identity.pw_gid).gr_name==ops.USER,'dedicated identity differs')
        validate_identity(identity,pwd.getpwall(),grp.getgrall(),ops)
        ops.check(set(os.getgrouplist(ops.USER,identity.pw_gid))=={identity.pw_gid},'unexpected supplementary worker groups')
        password=ops.command(['/usr/bin/passwd','--status',ops.USER]).stdout.split();ops.check(len(password)>=2 and password[0]==ops.USER and password[1]=='L','dedicated account is not locked')
        processes=ops.command(['/usr/bin/ps','-u',ops.USER,'-o','pid='],allow_failure=True)
        ops.check(processes.returncode in (0,1) and not processes.stdout.strip(),'worker identity already has running processes')
        properties=ops.service_properties();ops.validate_service(properties,release);never_started(properties,ops)
        private=Path(tempfile.mkdtemp(prefix='reviewed-recovery-',dir=ops.ROOT));os.chmod(private,0o700)
        archive=private/'authenticated-worker.zip';ops.snapshot_archive(args.archive,archive,args.archive_sha256,fmt.MAX_ARCHIVE)
        manifest=fmt.inspect_archive(archive,args.source,args.lock_sha256,args.package_sha256)
        verify_existing_tree(release,manifest,fmt,ops)
        raw_env=ops.read_bounded(ops.SOURCE/'.env.production',1024**2)
        ops.check(hashlib.sha256(raw_env).hexdigest()==args.env_sha256,'approved raw application environment changed')
        code="const fs=require('node:fs'),{parseEnv}=require('node:util');const e=parseEnv(fs.readFileSync(0,'utf8'));const keys="+json.dumps(sorted(ops.ENV_KEYS))+";console.log(JSON.stringify(Object.fromEntries(keys.filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))));"
        environment=json.loads(ops.command([str(ops.NODE),'-e',code],input=raw_env.decode()).stdout)
        ops.check(set(environment)<=ops.ENV_KEYS and all(isinstance(v,str) and len(v)<=65536 and not any(ord(c)<32 or ord(c)==127 for c in v) for v in environment.values()),'selected private environment invalid')
        expected_env=(''.join(key+'='+json.dumps(environment[key],ensure_ascii=False)+'\n' for key in sorted(environment))).encode()
        ops.check(ops.read_bounded(ops.ENV,1024**2)==expected_env,'installed worker environment differs from independently pinned source')
        app=ops.database_config(environment.get('DATABASE_URL'),'ai_hr_app');owner=ops.database_config(environment.get('MIGRATION_DATABASE_URL'),'ai_hr_owner')
        ops.check((app['PGHOST'],app['PGPORT'],app['PGDATABASE'])==(owner['PGHOST'],owner['PGPORT'],owner['PGDATABASE']),'database targets differ')
        sql="SELECT json_build_object('role',current_user,'database',current_database(),'super',r.rolsuper,'bypass',r.rolbypassrls,'owner',c.relowner=r.oid)::text FROM pg_roles r JOIN pg_class c ON c.oid='public.bank_import_job'::regclass WHERE r.rolname=current_user;"
        for config,is_owner in ((app,False),(owner,True)):
            for key in ('PGSSLROOTCERT','PGSSLCERT','PGSSLKEY'):
                value=config.get(key,environment.get(key))
                if value: ops.root_protected(value,regular=True);ops.command(['/usr/sbin/runuser','--user',ops.USER,'--','/usr/bin/test','-r',value])
            settings={**ops.BASE_ENV,**{k:v for k,v in environment.items() if k.startswith('PGSSL')},**config,'PGPASSFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'}
            proof=json.loads(ops.command(['/usr/bin/psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],input=sql,env=settings).stdout)
            ops.check(proof['role']==config['PGUSER'] and proof['database']=='ai_hr' and proof['owner']==is_owner and (is_owner or not proof['super'] and not proof['bypass']),'live database role/ownership proof differs')
        if environment.get('NODE_EXTRA_CA_CERTS'):
            ops.root_protected(environment['NODE_EXTRA_CA_CERTS'],regular=True);ops.command(['/usr/sbin/runuser','--user',ops.USER,'--','/usr/bin/test','-r',environment['NODE_EXTRA_CA_CERTS']])
        ops.check(ops.deployment_state(args.source,args.build_id)==state,'web release changed during continuation checks')
        ops.validate_service(ops.service_properties(),release);never_started(ops.service_properties(),ops)
        activated=False
        with ops.activation_guard(lambda: ops.stop_owned_first_install() if activated else None):
            activated=True;ops.command(['/usr/bin/systemctl','start','aihr-bank-import.service']);pid=None
            for attempt in range(3):
                time.sleep(4);properties=ops.service_properties();ops.validate_service(properties,release)
                ops.check(properties['ActiveState']=='active' and properties['SubState']=='running' and properties['NRestarts']=='0','worker did not remain healthy')
                actual_pid=int(properties['MainPID']);ops.check(actual_pid>0 and (pid is None or pid==actual_pid),'worker PID changed');pid=actual_pid
                process=Path('/proc')/str(pid)
                ops.check(process.stat().st_uid==identity.pw_uid and (process/'cwd').resolve()==release,'live worker user/directory differs')
                ops.check(ops.read_bounded(process/'cmdline',65536).split(b'\0')[:-1]==[str(ops.NODE).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'],'live command differs')
                actual=dict(row.split(b'=',1) for row in ops.read_bounded(process/'environ',1024**2).split(b'\0') if b'=' in row)
                ops.check(all(actual.get(k.encode())==v.encode() for k,v in environment.items()) and not any(k.encode() in actual for k in ('NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH')),'live environment differs')
            ops.check(ops.deployment_state(args.source,args.build_id)==state and ops.read_bounded(ops.ENV,1024**2)==expected_env and ops.read_bounded(ops.UNIT,65536)==unit,'installed authority changed during activation')
            ops.command(['/usr/bin/systemctl','enable','aihr-bank-import.service'])
            record={'kind':'EXACT_INSTALL_CONTINUATION','source':args.source,'webBuildId':args.build_id,'archiveSha256':args.archive_sha256,'manifestSha256':fmt.digest(fmt.canonical(manifest)),'selectedEnvironmentSha256':hashlib.sha256(expected_env).hexdigest(),'unitSha256':hashlib.sha256(unit).hexdigest(),'workerPid':pid,'serviceStable':True,'journeyVerified':False}
            ops.write_new(release/'worker-install-v2-recovery.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o444);print(json.dumps(record))
    finally: os.close(lock_fd)
