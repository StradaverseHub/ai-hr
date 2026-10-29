"""Replace only the known never-started v1 unit target with an authenticated corrected variant.
The original runtime directory, credentials, identity and database remain unchanged.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import stat
import tempfile
import time

KNOWN_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e'
KNOWN_OLD_ARCHIVE='e078748fa2857a8833ae5c035c9e6bab846d99151e6097aecf9686e686936c36'

def variant_unit(source,archive,ops):
    ops.check(source==KNOWN_SOURCE and re.fullmatch('[a-f0-9]{64}',archive or ''),'known source and full variant digest required')
    original=ops.service_unit(source).encode();before=('WorkingDirectory='+str(ops.ROOT/'releases'/source)+'\n').encode()
    after=('WorkingDirectory='+str(ops.ROOT/'releases'/(source+'-'+archive))+'\n').encode()
    ops.check(original.count(before)==1,'fixed unit working directory is ambiguous')
    return original.replace(before,after)

def atomic_unit_replace(path,expected,replacement,ops):
    ops.root_protected(path,regular=True);ops.root_protected(path.parent)
    ops.check(ops.read_bounded(path,65536)==expected,'unit bytes changed before replacement')
    fd,name=tempfile.mkstemp(prefix='.reviewed-bank-unit-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write(replacement);stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),0o644)
        ops.check(ops.read_bounded(path,65536)==expected,'unit changed while preparing replacement')
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)

def restore_unit_after_failure(old,new,ops):
    # Exact new bytes prove our mutation even if interrupted between rename and a flag.
    # A refusal before mutation must not stop a foreign or otherwise uncertain service.
    current=ops.read_bounded(ops.UNIT,65536)
    if current==old: return
    ops.check(current==new,'unexpected unit bytes; no service stop attempted; administrator review required')
    ops.stop_owned_first_install()
    atomic_unit_replace(ops.UNIT,new,old,ops);ops.command(['/usr/bin/systemctl','daemon-reload'])
    ops.check(ops.read_bounded(ops.UNIT,65536)==old,'original unit restoration not confirmed')

def verify_inactive_before_ownership(old_unit,old_release,ops):
    # A foreign start during lengthy archive checks is not ours to stop or roll back.
    ops.root_protected(ops.UNIT,regular=True)
    ops.check(ops.read_bounded(ops.UNIT,65536)==old_unit,'original unit changed during preflight')
    properties=ops.service_properties();ops.validate_service(properties,old_release);ops.never_started(properties,ops)
    processes=ops.command(['/usr/bin/ps','-u',ops.USER,'-o','pid='],allow_failure=True)
    ops.check(processes.returncode in (0,1) and not processes.stdout.strip(),'worker identity acquired running processes during preflight')

def validate_runtime_witness(proof,source,controller,archive,archive_bytes,manifest,ledger,run_id,fmt,ops):
    fields={'format','kind','source','controllerSource','producerSha256','formatSha256','archiveSha256','manifestSha256','provenanceSha256','packageSha256','lockSha256','runtime','runId','runAttempt','rootOwnedReadOnly','extractedOutsideCheckout','modulePathsClean','roleProof','migrationLedger','emptyQueue','nativeFixture','cli','extractedPostRunVerified','releaseAuthorized'}
    ops.check(isinstance(proof,dict) and set(proof)==fields,'closed authenticated runtime proof required')
    manifest_hash=fmt.digest(fmt.canonical(manifest))
    provenance={'format':2,'kind':'WORKER_BYTES_ONLY_NOT_RELEASE_AUTHORITY','source':source,'controllerSource':controller,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'runtime':manifest['runtime'],'archiveSha256':archive,'archiveBytes':archive_bytes,'manifestSha256':manifest_hash,'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'entries':len(manifest['entries']),'unpackedBytes':sum(row['size'] for row in manifest['entries'] if row['type']=='file')}
    expected={'format':1,'kind':'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE','source':source,'controllerSource':controller,'producerSha256':manifest['producerSha256'],'formatSha256':manifest['formatSha256'],'archiveSha256':archive,'manifestSha256':manifest_hash,'provenanceSha256':fmt.digest(fmt.canonical(provenance)),'packageSha256':manifest['packageSha256'],'lockSha256':manifest['lockSha256'],'runtime':fmt.RUNTIME,'runId':run_id,'runAttempt':1,'rootOwnedReadOnly':True,'extractedOutsideCheckout':True,'modulePathsClean':True,'extractedPostRunVerified':True,'releaseAuthorized':False}
    def exact(actual,wanted):
        if type(actual) is not type(wanted): return False
        if isinstance(wanted,dict): return set(actual)==set(wanted) and all(exact(actual[k],v) for k,v in wanted.items())
        if isinstance(wanted,list): return len(actual)==len(wanted) and all(exact(a,b) for a,b in zip(actual,wanted))
        return actual==wanted
    ops.check(all(exact(proof.get(key),value) for key,value in expected.items()),'runtime provenance/privilege binding differs')
    roles=[{'rolname':'ai_hr_app','rolsuper':False,'rolbypassrls':False,'queue_owner':False},{'rolname':'ai_hr_owner','rolsuper':False,'rolbypassrls':False,'queue_owner':True}]
    ops.check(isinstance(proof['roleProof'],list) and all(isinstance(row,dict) and isinstance(row.get('rolname'),str) for row in proof['roleProof']) and exact(sorted(proof['roleProof'],key=lambda row:row['rolname']),roles),'runtime database roles differ')
    ops.check(exact(proof['migrationLedger'],{'rows':562,'sha256':ledger}),'runtime migration ledger differs')
    empty=proof['emptyQueue'];empty_fields={'before','after','publicTables','contentSha256','noHrMutation','exitCode','stdoutSha256','stderrSha256'}
    ops.check(isinstance(empty,dict) and set(empty)==empty_fields and type(empty['publicTables']) is int and 0<empty['publicTables']<=2000 and isinstance(empty['contentSha256'],str) and re.fullmatch('[a-f0-9]{64}',empty['contentSha256']),'complete empty-queue content witness required')
    empty_expected={'before':0,'after':0,'noHrMutation':True,'exitCode':0,'stdoutSha256':fmt.digest(b''),'stderrSha256':fmt.digest(b'')}
    ops.check(all(exact(empty[k],v) for k,v in empty_expected.items()),'native empty-queue invocation did not pass')
    ops.check(exact(proof['nativeFixture'],{'syntheticOnly':True,'previewValid':1,'previewInvalid':1,'previewHrUnchanged':True,'saved':1,'failed':0,'total':2,'processed':2,'auditItems':1,'sourceChunksReleased':True,'cliInvocations':5}),'native representative import did not pass')
    ops.check(exact(proof['cli'],{'invocations':6,'exitCodes':[0]*6,'noUnexpectedStderr':True}),'native CLI execution proof differs')

def replace_never_started(argv,fmt,ops):
    parser=argparse.ArgumentParser()
    for name in ['old-archive','old-archive-sha256','archive','archive-sha256','source','controller-source','build-id','lock-sha256','package-sha256','env-sha256','runtime-proof','runtime-proof-sha256','runtime-ledger-sha256','staging-ledger-sha256','runtime-run-id']: parser.add_argument('--'+name,required=True)
    args=parser.parse_args(argv);ops.check(os.geteuid()==0,'reviewed detached administrator activation required')
    ops.check(args.source==KNOWN_SOURCE and args.old_archive_sha256==KNOWN_OLD_ARCHIVE and re.fullmatch('[a-f0-9]{40}',args.controller_source or ''),'this continuation is only for the known never-started installation')
    for value in [args.archive_sha256,args.lock_sha256,args.package_sha256,args.env_sha256,args.runtime_proof_sha256,args.runtime_ledger_sha256,args.staging_ledger_sha256]: ops.check(re.fullmatch('[a-f0-9]{64}',value or ''),'independently authenticated digest required')
    ops.check(re.fullmatch('[1-9][0-9]{0,19}',args.runtime_run_id or ''),'authenticated original runtime run required')
    ops.check(args.archive_sha256!=KNOWN_OLD_ARCHIVE and re.fullmatch('[A-Za-z0-9_-]{1,160}',args.build_id or ''),'corrected distinct packet/build identity required')
    ops.root_protected(ops.NODE,regular=True);ops.check(ops.command([str(ops.NODE),'--version']).stdout.strip()=='v22.23.3','reviewed Node runtime required')
    lock=ops.LOCK_DIRECTORY/'install.lock';ops.root_protected(lock,regular=True);ops.check(stat.S_IMODE(lock.stat().st_mode)==0o600,'original private install lock required')
    lock_fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=ops.deployment_state(args.source,args.build_id);ops.command(['/usr/bin/systemctl','is-active','--quiet','aihr'])
        old_release=ops.ROOT/'releases'/args.source;new_release=ops.ROOT/'releases'/(args.source+'-'+args.archive_sha256)
        for path in [ops.ROOT,ops.ROOT/'releases']: ops.root_protected(path)
        old_unit=ops.service_unit(args.source).encode();new_unit=variant_unit(args.source,args.archive_sha256,ops)
        ops.root_protected(ops.UNIT,regular=True);ops.check(ops.read_bounded(ops.UNIT,65536)==old_unit,'exact original unit required')
        for record in ['worker-install-v2.json','worker-install-v2-recovery.json']: ops.check(not (old_release/record).exists(),'installation has already completed')
        identity=pwd.getpwnam(ops.USER)
        ops.check(identity.pw_uid>0 and identity.pw_gid>0 and identity.pw_shell=='/usr/sbin/nologin' and identity.pw_dir=='/nonexistent','dedicated locked identity differs')
        ops.validate_identity(identity,pwd.getpwall(),grp.getgrall(),ops);ops.check(set(os.getgrouplist(ops.USER,identity.pw_gid))=={identity.pw_gid},'unexpected worker groups')
        status=ops.command(['/usr/bin/passwd','--status',ops.USER]).stdout.split();ops.check(len(status)>=2 and status[1]=='L','worker account is not locked')
        processes=ops.command(['/usr/bin/ps','-u',ops.USER,'-o','pid='],allow_failure=True);ops.check(processes.returncode in (0,1) and not processes.stdout.strip(),'worker identity has running processes')
        properties=ops.service_properties();ops.validate_service(properties,old_release);ops.never_started(properties,ops)
        private=Path(tempfile.mkdtemp(prefix='corrected-variant-',dir=ops.ROOT));os.chmod(private,0o700)
        old_archive=private/'original-authenticated.zip';new_archive=private/'corrected-authenticated.zip'
        ops.snapshot_archive(args.old_archive,old_archive,args.old_archive_sha256,fmt.MAX_ARCHIVE);ops.snapshot_archive(args.archive,new_archive,args.archive_sha256,fmt.MAX_ARCHIVE)
        original=fmt.inspect_archive(old_archive,args.source,args.lock_sha256,args.package_sha256);ops.check(original['format']==1,'original v1 byte evidence required')
        ops.verify_existing_tree(old_release,original,fmt,ops)
        corrected=fmt.inspect_archive(new_archive,args.source,args.lock_sha256,args.package_sha256);fmt.require_activation_manifest(corrected,args.controller_source)
        raw_proof=ops.read_bounded(Path(args.runtime_proof),1024**2);ops.check(hashlib.sha256(raw_proof).hexdigest()==args.runtime_proof_sha256,'authenticated runtime proof differs')
        proof=json.loads(raw_proof);validate_runtime_witness(proof,args.source,args.controller_source,args.archive_sha256,new_archive.stat().st_size,corrected,args.runtime_ledger_sha256,int(args.runtime_run_id),fmt,ops)
        staged=private/'new-runtime';staged.mkdir(mode=0o700);fmt.extract_archive(new_archive,staged,args.source,args.lock_sha256,args.package_sha256)
        for row in corrected['entries']:
            if row['type']!='symlink': os.chmod(staged/row['path'],0o755 if row['type']=='directory' else row['mode'])
        os.chmod(staged,0o755)
        ops.check(not new_release.exists() and not new_release.is_symlink(),'corrected variant already exists; preserve it for review')
        os.rename(staged,new_release);ops.verify_existing_tree(new_release,corrected,fmt,ops)
        # Bind unchanged credentials to the independently approved source, without exposing values.
        ops.root_protected(ops.ENV,regular=True);ops.check(stat.S_IMODE(ops.ENV.stat().st_mode)==0o600,'protected worker environment differs')
        raw_env=ops.read_bounded(ops.SOURCE/'.env.production',1024**2);ops.check(hashlib.sha256(raw_env).hexdigest()==args.env_sha256,'approved raw environment changed')
        code="const fs=require('node:fs'),{parseEnv}=require('node:util');const e=parseEnv(fs.readFileSync(0,'utf8'));const keys="+json.dumps(sorted(ops.ENV_KEYS))+";console.log(JSON.stringify(Object.fromEntries(keys.filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))));"
        environment=json.loads(ops.command([str(ops.NODE),'-e',code],input=raw_env.decode()).stdout)
        ops.check(set(environment)<=ops.ENV_KEYS and all(isinstance(v,str) and not any(ord(c)<32 or ord(c)==127 for c in v) for v in environment.values()),'private selected values invalid')
        expected_env=(''.join(key+'='+json.dumps(environment[key],ensure_ascii=False)+'\n' for key in sorted(environment))).encode();ops.check(ops.read_bounded(ops.ENV,1024**2)==expected_env,'worker credentials changed')
        app=ops.database_config(environment.get('DATABASE_URL'),'ai_hr_app');owner=ops.database_config(environment.get('MIGRATION_DATABASE_URL'),'ai_hr_owner')
        ops.check((app['PGHOST'],app['PGPORT'],app['PGDATABASE'])==(owner['PGHOST'],owner['PGPORT'],owner['PGDATABASE']),'database targets differ')
        sql="SELECT json_build_object('role',current_user,'database',current_database(),'super',r.rolsuper,'bypass',r.rolbypassrls,'owner',c.relowner=r.oid)::text FROM pg_roles r JOIN pg_class c ON c.oid='public.bank_import_job'::regclass WHERE r.rolname=current_user;"
        for config,is_owner in [(app,False),(owner,True)]:
            for key in ['PGSSLROOTCERT','PGSSLCERT','PGSSLKEY']:
                value=config.get(key,environment.get(key))
                if value: ops.root_protected(value,regular=True);ops.command(['/usr/sbin/runuser','--user',ops.USER,'--','/usr/bin/test','-r',value])
            settings={**ops.BASE_ENV,**{k:v for k,v in environment.items() if k.startswith('PGSSL')},**config,'PGPASSFILE':'/dev/null','PGCONNECT_TIMEOUT':'5','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'}
            database=json.loads(ops.command(['/usr/bin/psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],input=sql,env=settings).stdout)
            ops.check(database['role']==config['PGUSER'] and database['database']=='ai_hr' and database['owner']==is_owner and not database['super'] and not database['bypass'],'live database role proof differs')
            if is_owner:
                ledger_sql="SELECT coalesce(json_agg(x ORDER BY x.id),'[]'::json)::text FROM (SELECT id,created_at::text AS created_at,CASE WHEN hash~'^[a-f0-9]{64}$' THEN hash ELSE 'INVALID' END AS hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 563) x;"
                rows=json.loads(ops.command(['/usr/bin/psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],input=ledger_sql,env=settings).stdout)
                ops.check(isinstance(rows,list) and len(rows)==562 and all(set(row)=={'id','created_at','hash'} for row in rows),'live complete migration ledger count/shape differs')
                projection=[{'created_at':row['created_at'],'hash':row['hash']} for row in rows]
                ledger_hash=hashlib.sha256(json.dumps(projection,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()
                ops.check(ledger_hash==args.staging_ledger_sha256,'live ordered migration ledger differs from independently approved staging identities')
        if environment.get('NODE_EXTRA_CA_CERTS'): ops.root_protected(environment['NODE_EXTRA_CA_CERTS'],regular=True);ops.command(['/usr/sbin/runuser','--user',ops.USER,'--','/usr/bin/test','-r',environment['NODE_EXTRA_CA_CERTS']])
        ops.check(ops.deployment_state(args.source,args.build_id)==state,'web deployment changed during checks')
        ops.write_new(private/'old-unit',old_unit,0o600);ops.write_new(private/'new-unit',new_unit,0o600)
        fresh_identity=pwd.getpwnam(ops.USER)
        ops.check(fresh_identity==identity,'worker identity changed during preflight')
        ops.validate_identity(fresh_identity,pwd.getpwall(),grp.getgrall(),ops)
        ops.check(set(os.getgrouplist(ops.USER,fresh_identity.pw_gid))=={fresh_identity.pw_gid},'worker groups changed during preflight')
        verify_inactive_before_ownership(old_unit,old_release,ops)
        with ops.activation_guard(lambda:restore_unit_after_failure(old_unit,new_unit,ops)):
            atomic_unit_replace(ops.UNIT,old_unit,new_unit,ops);ops.command(['/usr/bin/systemctl','daemon-reload'])
            properties=ops.service_properties();ops.validate_service(properties,new_release);ops.never_started(properties,ops)
            ops.command(['/usr/bin/systemctl','start','aihr-bank-import.service']);pid=None
            for attempt in range(3):
                time.sleep(4);properties=ops.service_properties();ops.validate_service(properties,new_release)
                ops.check(properties['ActiveState']=='active' and properties['SubState']=='running' and properties['NRestarts']=='0','corrected worker is not stable')
                current_pid=int(properties['MainPID']);ops.check(current_pid>0 and (pid is None or pid==current_pid),'worker PID changed');pid=current_pid;process=Path('/proc')/str(pid)
                ops.check(process.stat().st_uid==identity.pw_uid and (process/'cwd').resolve()==new_release,'actual worker identity/directory differs')
                ops.check(ops.read_bounded(process/'cmdline',65536).split(b'\0')[:-1]==[str(ops.NODE).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts'],'actual worker command differs')
                actual=dict(row.split(b'=',1) for row in ops.read_bounded(process/'environ',1024**2).split(b'\0') if b'=' in row)
                ops.check(all(actual.get(k.encode())==v.encode() for k,v in environment.items()) and not any(k.encode() in actual for k in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH']),'actual selected environment differs')
            ops.check(ops.deployment_state(args.source,args.build_id)==state and ops.read_bounded(ops.ENV,1024**2)==expected_env and ops.read_bounded(ops.UNIT,65536)==new_unit,'authority changed during activation')
            ops.command(['/usr/bin/systemctl','enable','aihr-bank-import.service'])
            record={'kind':'CORRECTED_NEVER_STARTED_VARIANT','source':args.source,'controllerSource':args.controller_source,'webBuildId':args.build_id,'oldArchiveSha256':args.old_archive_sha256,'newArchiveSha256':args.archive_sha256,'runtimeProofSha256':args.runtime_proof_sha256,'runtimeLedgerSha256':args.runtime_ledger_sha256,'stagingLedgerSha256':args.staging_ledger_sha256,'oldRelease':str(old_release),'newRelease':str(new_release),'unitSha256':hashlib.sha256(new_unit).hexdigest(),'workerPid':pid,'serviceStable':True,'journeyVerified':False}
            ops.write_new(private/'activation-result.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o444);print(json.dumps(record))
    finally: os.close(lock_fd)
