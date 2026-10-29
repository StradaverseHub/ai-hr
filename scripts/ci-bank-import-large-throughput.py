"""GHA-only measurement of 100001 native changes from an already authenticated sealed packet.
No package production, migration, staging access, deployment or release authority.
"""
import time
STARTED=time.monotonic()

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import signal
import stat
import subprocess
import sys

REFUSED_SOURCE='968354c00a71df7baccd499eb60757a3307ed61e'
DEADLINE=STARTED+10790
REGISTRY=None
ROWS=100001
APP='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test'
OWNER='postgres://ai_hr_owner@127.0.0.1:5433/ai_hr_test'
WITNESS='postgres://postgres@127.0.0.1:5433/ai_hr_test'
BASE={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur'}

def require(ok,message):
    if not ok: raise ValueError('Disposable throughput gate refused: '+message)

def remaining(limit=None):
    seconds=DEADLINE-time.monotonic()
    require(seconds>0,'total throughput deadline exceeded (including setup and final evidence)')
    return seconds if limit is None else min(limit,seconds)

def deadline_alarm(signum,frame):
    raise TimeoutError('Disposable throughput total deadline exceeded; success forbidden')

def supervisor_budget(argv):
    # No parsing diagnostics or I/O in the supervisor. The child does full argparse
    # validation before work and confirms this exact budget; malformed input cannot run.
    preflight='--mode=preflight-401' in argv or any(word=='--mode' and index+1<len(argv) and argv[index+1]=='preflight-401' for index,word in enumerate(argv))
    maximum=900 if preflight else 10800
    minimum=60 if preflight else 900
    seconds=maximum
    for index,word in enumerate(argv):
        if word=='--max-seconds':
            if index+1==len(argv): return maximum
            raw=argv[index+1]
        elif word.startswith('--max-seconds='): raw=word.split('=',1)[1]
        else: continue
        try: seconds=int(raw)
        except ValueError: return maximum
        if not minimum<=seconds<=maximum: return maximum
    return seconds

def supervise_controller(seconds):
    # This external parent survives the COMPLETE controller exit, including fsync,
    # stdout/stderr flushing, exact-receipt rollback, exception output and finalizers.
    # It has no filesystem/output/cleanup tail: every parent path ends in os._exit.
    if not (os.geteuid()==0 and os.uname().sysname=='Linux' and os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and sys.flags.isolated==1 and sys.flags.dont_write_bytecode==1): os._exit(125)
    hard_deadline=STARTED+seconds
    controller=os.fork()
    if controller==0: return
    try:
        while True:
            child,status=os.waitpid(controller,os.WNOHANG)
            now=time.monotonic()
            if child==controller:
                if now>=hard_deadline: os._exit(124)
                code=os.waitstatus_to_exitcode(status)
                os._exit(code if code>=0 else 128-code)
            if now>=hard_deadline:
                # WNOHANG==0 proves our direct child is still unreaped: its PID
                # cannot have been recycled. No foreign PID scan or process group.
                try: os.kill(controller,signal.SIGKILL)
                except ProcessLookupError: pass
                # An uncatchable controller kill cannot guarantee native descendant
                # or DB cleanup. The workflow MUST clean its disposable DB and job
                # descendants on failure. Consumers MUST require overall exit/run 0;
                # any receipt surviving a controller kill is invalid evidence.
                os._exit(124)
            time.sleep(min(0.05,hard_deadline-now))
    except BaseException:
        # Fail closed without a traceback or potentially blocking supervisor output.
        try:
            child,_=os.waitpid(controller,os.WNOHANG)
            if child==0: os.kill(controller,signal.SIGKILL)
        except BaseException: pass
        os._exit(125)

def rollback_receipt():
    if RECEIPT is None: return
    report,identity,_=RECEIPT
    try: current=report.lstat()
    except FileNotFoundError: return
    require((current.st_dev,current.st_ino)==identity,'receipt changed; refusing to remove uncertain file')
    report.unlink()

def digest(raw): return hashlib.sha256(raw).hexdigest()

def file_hash(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024**2),b''):
            remaining();h.update(block)
    return h.hexdigest()

def command(argv,*,cwd='/',env=None,timeout=60,**identity):
    timeout=remaining(timeout)
    require(REGISTRY is not None,'durable exact-child registry must precede commands')
    result=REGISTRY.run(argv,cwd=cwd,env=env or BASE,timeout=timeout,**identity)
    remaining()
    require(result.returncode==0,'CI-only command failed: '+Path(argv[0]).name+'; stderr='+result.stderr[-12000:])
    return result

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded);return loaded

def main(supervised_seconds):
    parser=argparse.ArgumentParser(allow_abbrev=False)
    for name in ['controller','producer-controller','application-source','source','package-dir','node','accepted-controller','accepted-run-id','archive-sha256','manifest-sha256','provenance-sha256','runtime-proof-sha256','report']:
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--max-seconds',type=int,default=10800)
    parser.add_argument('--mode',choices=['full-100001','preflight-401'],default='full-100001')
    args=parser.parse_args()
    preflight=args.mode=='preflight-401'
    minimum,maximum=(60,900) if preflight else (900,10800)
    require(minimum<=args.max_seconds<=maximum,'fixed mode total-controller budget differs')
    require(os.environ.get('THROUGHPUT_PROOF_MODE','full-100001')==args.mode,'workflow and proof modes differ')
    global ROWS
    ROWS=401 if preflight else 100001
    require(sys.flags.isolated==1 and sys.flags.dont_write_bytecode==1,'invoke reviewed orchestration with Python -I -B')
    require(os.geteuid()==0 and os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and os.uname().sysname=='Linux','root orchestration on disposable Linux GHA only')
    require(args.max_seconds==supervised_seconds,'controller and external supervisor budgets must match')
    global DEADLINE
    DEADLINE=STARTED+args.max_seconds-10
    signal.signal(signal.SIGALRM,deadline_alarm)
    signal.setitimer(signal.ITIMER_REAL,remaining())
    validator=module('reviewed_throughput_proof',Path(__file__).resolve().parent/'bank_import_worker_throughput_proof.py')
    inputs=validator.authenticated_inputs()
    permitted=validator.remaining_job_seconds(inputs['consumerJobStartedAt'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))
    require(args.max_seconds<=permitted,'preflight elapsed time and five-minute cleanup/evidence reserve must precede proof budget')
    global REGISTRY
    REGISTRY=validator.Registry(validator.root_directory())
    require(re.fullmatch('[a-f0-9]{40}',args.application_source or '') and args.application_source!=REFUSED_SOURCE,'reviewed final application source required; old source explicitly refused')
    application_source=args.application_source
    run=os.environ.get('GITHUB_RUN_ID','');require(re.fullmatch('[1-9][0-9]*',run or '') and os.environ.get('GITHUB_RUN_ATTEMPT')=='1','original GHA run only')
    require(re.fullmatch('[a-f0-9]{40}',args.accepted_controller or '') and re.fullmatch('[1-9][0-9]*',args.accepted_run_id or ''),'independently authenticated producer identity required')
    for value in [args.archive_sha256,args.manifest_sha256,args.provenance_sha256,args.runtime_proof_sha256]: require(re.fullmatch('[a-f0-9]{64}',value or ''),'independently authenticated input digest required')
    require(minimum<=args.max_seconds<=maximum,'fixed mode total-controller budget differs')
    controller,producer,source,package=[Path(p).resolve(strict=True) for p in [args.controller,args.producer_controller,args.source,args.package_dir]]
    checkouts=[controller,producer,source]
    require(len(set(checkouts))==3 and all(not a.is_relative_to(b) for a in checkouts for b in checkouts if a!=b),'three separate frozen checkouts required')
    require(all(not package.is_relative_to(p) and not p.is_relative_to(package) for p in checkouts),'accepted packet must be outside checkouts')
    def git(root,*words): return command(['/usr/bin/git','-c','safe.directory='+str(root),'-C',str(root),*words]).stdout.strip()
    controller_sha=git(controller,'rev-parse','HEAD')
    require(controller_sha==os.environ.get('GITHUB_SHA') and git(producer,'rev-parse','HEAD')==args.accepted_controller and git(source,'rev-parse','HEAD')==application_source,'separate throughput/producer/application source identities required')
    def frozen():
        for path,sha in [(controller,controller_sha),(producer,args.accepted_controller),(source,application_source)]:
            require(git(path,'rev-parse','HEAD')==sha and not git(path,'status','--porcelain','--untracked-files=all'),'frozen checkout changed')
    frozen()
    # The workflow authenticates API run/job/artifact identity before this gate; hashes are mandatory independent inputs.
    names={'worker-package.zip':args.archive_sha256,'worker-manifest.json':args.manifest_sha256,'worker-provenance.json':args.provenance_sha256,'worker-runtime-proof.json':args.runtime_proof_sha256}
    require(package==validator.root_directory()/'accepted' and names==inputs['members'] and application_source==inputs['producer']['source'] and args.accepted_controller==inputs['producer']['producer'] and int(args.accepted_run_id)==inputs['producer']['run'],'CLI and root-authenticated API inputs differ')
    require(set(p.name for p in package.iterdir())==set(names),'closed accepted four-member packet required')
    for name,wanted in names.items():
        path=package/name;info=path.lstat()
        validator.protected(path)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and file_hash(path)==wanted,'accepted packet member differs: '+name)
    fmt=module('accepted_worker_format',producer/'deploy/systemd/bank_import_worker_format.py')
    provenance=json.loads((package/'worker-provenance.json').read_bytes());accepted=json.loads((package/'worker-runtime-proof.json').read_bytes())
    require((package/'worker-provenance.json').read_bytes()==fmt.canonical(provenance),'canonical accepted provenance required')
    require(provenance['producerSha256']==file_hash(producer/'scripts/bank-import-worker-package.py') and provenance['formatSha256']==file_hash(producer/'deploy/systemd/bank_import_worker_format.py'),'accepted producer code differs')
    area=REGISTRY.prepare_area()
    archive=area/'accepted.zip';shutil.copyfile(package/'worker-package.zip',archive);os.chmod(archive,0o400)
    require(file_hash(archive)==args.archive_sha256,'accepted private archive changed')
    runtime=area/'runtime';runtime.mkdir(mode=0o700)
    manifest=fmt.extract_archive(archive,runtime,application_source,provenance['lockSha256'],provenance['packageSha256'])
    require(fmt.canonical(manifest)==(package/'worker-manifest.json').read_bytes(),'inner and outer accepted manifests differ')
    fmt.require_activation_manifest(manifest,args.accepted_controller)
    ledger_expected=validator.ordinary_source_ledger(source);validator.require_registered_policy(source)
    LEDGER=ledger_expected['sha256']  # Fresh ordinary journal only; never a live/staging ledger.
    expected_provenance=validator.validate_runtime_witness(accepted,application_source,args.accepted_controller,args.archive_sha256,archive.stat().st_size,manifest,ledger_expected,int(args.accepted_run_id),fmt)
    require(validator.exact(provenance,expected_provenance),'closed accepted provenance differs')
    require((package/'worker-runtime-proof.json').read_bytes()==fmt.canonical(accepted),'canonical runtime witness required')
    validator.verify_source_bytes(source,manifest)
    require(provenance['format']==2 and provenance['source']==application_source and provenance['controllerSource']==args.accepted_controller,'accepted v2 provenance source/controller differs')
    require(accepted['provenanceSha256']==args.provenance_sha256,'accepted native proof/provenance differ')
    entries={row['path']:row for row in manifest['entries']}
    for path in runtime.rglob('*'):
        if not path.is_symlink(): os.chmod(path,0o555 if path.is_dir() else entries[path.relative_to(runtime).as_posix()]['mode']&0o555)
    os.chmod(runtime,0o555)
    def sealed():
        require(runtime.stat().st_uid==0 and stat.S_IMODE(runtime.stat().st_mode)==0o555,'sealed root changed')
        require({p.relative_to(runtime).as_posix() for p in runtime.rglob('*')}==set(entries),'sealed inventory changed')
        for name,row in entries.items():
            path=runtime/name;info=path.lstat()
            require(info.st_uid==0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode&0o222),'runtime owner or write bits changed')
            if row['type']=='file': require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size==row['size'] and stat.S_IMODE(info.st_mode)==row['mode']&0o555 and file_hash(path)==row['sha256'],'runtime file changed')
            elif row['type']=='directory': require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode)==0o555,'runtime directory changed')
            else: require(stat.S_ISLNK(info.st_mode) and os.readlink(path)==row['target'] and path.resolve(strict=True).is_relative_to(runtime),'runtime link changed')
    node=area/'node';shutil.copyfile(Path(args.node).resolve(strict=True),node);os.chmod(node,0o555)
    actual=json.loads(command([str(node),'-e',"console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime}))"]).stdout)
    require(actual==fmt.RUNTIME==manifest['runtime'],'actual Node/host differs from accepted runtime')
    worker=REGISTRY.prepare_user();require(worker.pw_uid>0 and worker.pw_gid>0,'dedicated nonroot worker required')
    runner_uid=source.stat().st_uid
    require(runner_uid>0 and runner_uid==controller.stat().st_uid==producer.stat().st_uid and package.stat().st_uid==0 and str(runner_uid)==os.environ.get('SUDO_UID'),'original nonroot Actions fixture identity and root-authenticated packet required')
    runner=pwd.getpwuid(runner_uid);require(runner_uid!=worker.pw_uid,'separate fixture and worker identities required')
    worker_work=area/'worker-private';worker_work.mkdir(mode=0o700);os.chown(worker_work,worker.pw_uid,worker.pw_gid)
    fixture_work=area/'fixture-private';fixture_work.mkdir(mode=0o700);os.chown(fixture_work,runner_uid,runner.pw_gid)
    env={**BASE,'HOME':str(worker_work),'TMPDIR':str(worker_work),'NODE_ENV':'production','GITHUB_ACTIONS':'true','CI':'true','DATABASE_URL':APP,'MIGRATION_DATABASE_URL':OWNER,'TEST_DATABASE_URL':APP,'TEST_MIGRATION_DATABASE_URL':OWNER}
    fixture_env={**env,'HOME':str(fixture_work),'TMPDIR':str(fixture_work)}
    native_auxiliaries=validator.auxiliary_contracts(runtime,manifest)
    fixture_auxiliaries=validator.auxiliary_contracts(source,manifest)
    state=fixture_work/'state.json';fixture=controller/'scripts/ci-bank-import-large-throughput.ts'
    def fixture_argv(name): return [str(node),'--import',str(source/'node_modules/tsx/dist/loader.mjs'),str(fixture),name,str(runtime),str(source),str(state),args.mode]
    def phase(name,timeout=180):
        result=command(fixture_argv(name),cwd=runtime,env=fixture_env,timeout=timeout,user=runner_uid,group=runner.pw_gid,extra_groups=[],umask=0o077,auxiliaries=fixture_auxiliaries)
        require(result.stderr=='','unexpected fictional fixture stderr: '+result.stderr[-12000:]);return json.loads(result.stdout)
    def query(sql,url=OWNER):
        require(url in [OWNER,WITNESS],'fixed disposable DB only')
        result=command(['/usr/lib/postgresql/16/bin/psql',url,'-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1'],env={**BASE,'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000'},timeout=20,input=sql)
        return json.loads(result.stdout)
    started=STARTED;events=[];samples=[];children=[];active=None;holder=None;peak_rss=0
    fixture_started=time.monotonic()
    holder_error=area/'latch-holder.stderr'
    def hold_pause(ordinal):
        nonlocal holder
        until=time.monotonic()+remaining(30)
        with validator.private_log(holder_error) as stderr:
            holder=REGISTRY.popen(fixture_argv('hold-pause'),cwd=runtime,env=fixture_env,gate_timeout=remaining(30),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,user=runner_uid,group=runner.pw_gid,extra_groups=[],umask=0o077,auxiliaries=fixture_auxiliaries)
        require(until>time.monotonic(),'latch gate consumed readiness budget')
        ready,_,_=select.select([holder.stdout],[],[],min(remaining(30),until-time.monotonic()))
        require(ready and json.loads(holder.stdout.readline(1024))=={'phase':'hold-pause','held':True,'ordinal':ordinal},'owned fictional latch did not become ready')
    def release_pause():
        nonlocal holder
        if holder is None: return
        if not holder.stdin.closed: holder.stdin.close()
        require(holder.wait(timeout=remaining(30))==0 and holder_error.stat().st_size==0,'fictional latch did not release cleanly')
        REGISTRY.mark_exit(holder)
        require(holder.stdout.read(1024)=='','unexpected fictional latch output');holder.stdout.close();holder=None
    def event(name,**fields):
        value={'phase':name,'elapsedSeconds':round(time.monotonic()-started,3),**fields};events.append(value);print(json.dumps(value),flush=True)
    def launch(once=False):
        nonlocal active
        require(active is None,'one owned worker at a time');sealed()
        index=len(children);out=area/f'worker-{index}.stdout';err=area/f'worker-{index}.stderr'
        with validator.private_log(out) as stdout,validator.private_log(err) as stderr:
            active=REGISTRY.popen([str(node),'--import','tsx','scripts/bank-import-runner.ts',*(['--once'] if once else [])],cwd=runtime,env=env,gate_timeout=remaining(30),stdout=stdout,stderr=stderr,user=worker.pw_uid,group=worker.pw_gid,extra_groups=[],umask=0o077,auxiliaries=native_auxiliaries)
        children.append({'process':active,'stdout':out,'stderr':err,'once':once})
        require(active.pid>0,'owned worker PID missing')
        exec_deadline=time.monotonic()+remaining(30)
        while active.poll() is None and (Path('/proc')/str(active.pid)/'exe').resolve()!=node:
            require(time.monotonic()<exec_deadline,'registered gate did not exec exact native Node');time.sleep(remaining(0.01))
        return active.pid
    def exited(expected):
        nonlocal active
        require(active is not None,'owned worker missing');code=active.wait(timeout=remaining(330))
        REGISTRY.mark_exit(active)
        child=children[-1];require(code==expected,'actual worker exit differs');require(child['stdout'].stat().st_size==0 and child['stderr'].stat().st_size==0,'actual worker emitted unexpected output')
        pid=active.pid;active=None
        lock=query("SELECT json_build_object('free',pg_try_advisory_lock(hashtextextended('bank-import-worker',0)))::text;")
        require(lock=={'free':True},'worker coordination lock retained after exit');return pid
    def process_identity():
        require(active is not None and active.poll() is None,'owned child is no longer running')
        info=Path('/proc')/str(active.pid)
        require(info.stat().st_uid==worker.pw_uid and (info/'cwd').resolve()==runtime and (info/'exe').resolve()==node,'actual worker identity, executable or cwd differs')
        expected=[str(node).encode(),b'--import',b'tsx',b'scripts/bank-import-runner.ts',*([b'--once'] if children[-1]['once'] else [])]
        require((info/'cmdline').read_bytes().split(b'\0')[:-1]==expected,'actual owned worker command differs')
        status={line.split(':',1)[0]:line.split(':',1)[1].split() for line in (info/'status').read_text().splitlines() if ':' in line}
        require(status.get('Uid')==[str(worker.pw_uid)]*4 and status.get('Gid')==[str(worker.pw_gid)]*4,'actual worker credential identities differ')
        actual_env=dict(value.split(b'=',1) for value in (info/'environ').read_bytes().split(b'\0') if b'=' in value)
        require(all(actual_env.get(k.encode())==v.encode() for k,v in env.items()) and not any(k.encode() in actual_env for k in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH','AUDIT_HASH_CHAIN_ENABLED']),'actual clean disposable worker environment differs')
        return info
    def signal_owned(value):
        process_identity();os.kill(active.pid,value)
    def sample():
        nonlocal peak_rss
        remaining()
        info=process_identity()
        for line in (info/'status').read_text().splitlines():
            if line.startswith('VmHWM:'): peak_rss=max(peak_rss,int(line.split()[1]))
        row=query("SELECT row_to_json(j)::text FROM (SELECT state,total,validated,valid,invalid,unchanged,processed,saved,failed FROM bank_import_job) j;")
        require(isinstance(row,dict) and row['state']!='failed' and row['failed']==0 and row['invalid']==0,'native import failed or has invalid rows')
        require(0<=row['saved']<=row['processed']<=row['total']<=ROWS and 0<=row['validated']<=row['total'],'progress bounds differ')
        if samples:
            require(all(row[k]>=samples[-1][k] for k in ['total','validated','processed','saved']),'persisted progress moved backwards')
        sample_row={**row,'elapsedSeconds':round(time.monotonic()-started,3),'pid':active.pid};samples.append(sample_row)
        require(len(samples)<=10000,'bounded sampling limit exceeded');return row
    def wait_until(predicate):
        while True:
            row=sample()
            if predicate(row): return row
            time.sleep(remaining(2))
    def tick_status():
        return query("SELECT row_to_json(j)::text FROM (SELECT state,total,validated,valid,invalid,unchanged,processed,saved,failed FROM bank_import_job) j;")
    def preflight_ticks(predicate,maximum_ticks):
        require(preflight and 1<=maximum_ticks<=6,'bounded fixed preflight ticks only')
        last_pid=None
        for tick in range(maximum_ticks):
            last_pid=launch(once=True);exited(0);row=tick_status()
            require(row['state']!='failed' and row['failed']==0 and row['invalid']==0,'preflight native tick failed')
            event('preflight-native-once-tick',tick=tick+1,**row)
            if predicate(row): return last_pid
        raise ValueError('Preflight exhausted fixed native CLI tick bound')
    try:
        setup=phase('setup',600);setup_seconds=time.monotonic()-fixture_started;event('fixture-created',rows=setup['rows'])
        command(['/usr/lib/postgresql/16/bin/psql',WITNESS,'-X','-v','ON_ERROR_STOP=1','-c','ALTER ROLE ai_hr_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;'])
        role_proof=query("SELECT json_agg(t ORDER BY rolname)::text FROM (SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('ai_hr_app','ai_hr_owner')) t;")
        require(role_proof==[{'rolname':'ai_hr_app','rolsuper':False,'rolbypassrls':False},{'rolname':'ai_hr_owner','rolsuper':False,'rolbypassrls':False}],'actual roles must not bypass RLS')
        catalog_sql="SELECT json_agg(t ORDER BY name)::text FROM (SELECT c.relname AS name,r.rolname AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind='r') t;"
        catalog=query(catalog_sql,WITNESS)
        ledger=query("SELECT json_agg(t ORDER BY id)::text FROM (SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id LIMIT "+str(ledger_expected['rows']+1)+") t;")
        require(len(ledger)==ledger_expected['rows'] and digest(json.dumps([{'created_at':r['created_at'],'hash':r['hash']} for r in ledger],sort_keys=True,separators=(',',':')).encode())==ledger_expected['sha256'],'exact fresh ordinary source migration ledger differs; no staging-ledger claim')
        launch(once=True);exited(0);event('actual-empty-cli-started')
        admitted=phase('admit',300);event('multipart-admission',**{k:v for k,v in admitted.items() if k!='phase'});validation_started=time.monotonic()
        if preflight:
            preflight_ticks(lambda row:row['state']=='ready',6);phase('duplicate');event('preflight-ready-duplicate-prevented')
        else:
            launch();wait_until(lambda row:row['state']=='validating' and row['validated']>0);phase('duplicate');event('validation-duplicate-prevented')
            wait_until(lambda row:row['state']=='ready');signal_owned(signal.SIGTERM);exited(0)
        validation_seconds=time.monotonic()-validation_started;event('validated',rows=ROWS)
        preview=phase('ready-confirm',300);event('confirmed',valid=preview['valid']);save_started=time.monotonic()
        if preflight: first_pid=preflight_ticks(lambda row:row['saved']==100,2)
        else:
            first_pid=launch();wait_until(lambda row:row['saved']>=100);signal_owned(signal.SIGTERM);exited(0)
        first=phase('checkpoint',300);require(first['job']['saved']<ROWS and first['job']['saved']%100==0,'graceful stop must preserve a nonterminal native batch boundary')
        if preflight: require(first['job']['saved']==100,'preflight exact first native batch required')
        phase('duplicate');event('preflight-once-checkpoint' if preflight else 'graceful-checkpoint',saved=first['job']['saved'],oldPid=first_pid)
        pause=phase('arm-pause');hold_pause(pause['ordinal']);latch_started=time.monotonic()
        second_pid=launch();require(second_pid!=first_pid,'fresh worker PID required')
        while True:
            sample()
            waiting=query("SELECT coalesce(json_agg(a.pid),'[]'::json)::text FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=2147483000 AND l.objid=100001 AND l.objsubid=2 AND NOT l.granted AND a.usename='ai_hr_app' AND a.datname='ai_hr_test' AND a.client_addr='127.0.0.1'::inet;",WITNESS)
            if waiting:
                require(len(waiting)==1 and type(waiting[0]) is int,'one actual app transaction must be paused');backend=waiting[0];observed_pause_started=time.monotonic();break
            time.sleep(remaining(2))
        phase('assert-paused');event('native-transaction-paused-before-checkpoint',ordinal=pause['ordinal'])
        signal_owned(signal.SIGKILL);exited(-signal.SIGKILL)
        release_pause();latch_seconds=time.monotonic()-latch_started;observed_pause_seconds=time.monotonic()-observed_pause_started
        rollback_deadline=time.monotonic()+30
        while query("SELECT json_build_object('present',exists(select 1 from pg_stat_activity where pid="+str(backend)+" and datname='ai_hr_test'))::text;",WITNESS)['present']:
            require(time.monotonic()<rollback_deadline,'killed app connection did not naturally roll back');time.sleep(remaining(1))
        phase('assert-rollback');phase('disarm-pause')
        second=phase('checkpoint',300);require(first['job']['saved']<=second['job']['saved']<ROWS,'forced restart checkpoint must advance without completing')
        phase('duplicate');event('forced-checkpoint',saved=second['job']['saved'],oldPid=second_pid)
        if preflight:
            third_pid=preflight_ticks(lambda row:row['state']=='completed',6)
            require(third_pid not in [first_pid,second_pid],'fresh bounded resume process required')
        else:
            third_pid=launch();require(third_pid not in [first_pid,second_pid],'fresh resume process required')
            wait_until(lambda row:row['state']=='completed');signal_owned(signal.SIGTERM);exited(0)
        complete=phase('complete',600)
        require(re.fullmatch('[a-f0-9]{64}',setup['targetMappingSha256']) and complete['targetMappingSha256']==setup['targetMappingSha256'] and complete['targetMappingUnchanged'] is True,'captured immutable target mapping changed')
        save_seconds=time.monotonic()-save_started;event('all-native-saves-verified',saved=complete['job']['saved'],saveSeconds=round(save_seconds,3))
        require(query(catalog_sql,WITNESS)==catalog,'table ownership/RLS policy flags changed')
        require(query("SELECT json_agg(t ORDER BY rolname)::text FROM (SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('ai_hr_app','ai_hr_owner')) t;")==role_proof,'database role privilege flags changed')
        sealed();frozen();validator.verify_source_bytes(source,manifest);REGISTRY.assert_empty()
        for name,wanted in names.items(): require(file_hash(package/name)==wanted,'accepted input packet changed during measurement')
        report=Path(args.report).absolute();require(not report.exists() and report.parent.resolve(strict=True)==report.parent and all(not report.is_relative_to(p) for p in checkouts+[package]),'new report outside all source/packet paths required')
        require(report.parent.stat().st_uid==runner_uid and not report.parent.stat().st_mode&0o022,'report parent must belong to original runner without group/world writes')
        proof={'format':1,'kind':'DISPOSABLE_NATIVE_100001_SAVE_MEASUREMENT_NOT_RELEASE','controllerSource':controller_sha,'applicationSource':application_source,'acceptedProducerController':args.accepted_controller,'acceptedRunId':int(args.accepted_run_id),'acceptedMembers':names,'runId':int(run),'runAttempt':1,'runtime':actual,'rows':ROWS,'saved':complete['job']['saved'],'auditItems':complete['audit']['rows'],'roleProof':role_proof,'ordinaryLedgerSha256':LEDGER,'sealedPacketUnchanged':True,'noStagingAccess':True,'nativeWorkersNonroot':True,'gracefulRestartVerified':True,'forcedRestartVerified':True,'inFlightNativeRollbackVerified':True,'testOnlyCheckpointLatchRemoved':True,'databaseRoleAndRlsFlagsUnchanged':True,'duplicateActivePreventionVerified':True,'sourceChunksReleased':complete['sourceChunksReleased'],'unrelatedFactsUnchanged':complete['unrelatedFactsUnchanged'],'targetMappingSha256':complete['targetMappingSha256'],'targetMappingUnchanged':complete['targetMappingUnchanged'],'maxSeconds':args.max_seconds,'hardDeadlineScope':'external-supervisor-until-controller-exit','cleanupReserveSeconds':10,'elapsedSeconds':round(time.monotonic()-started,3),'artifactAndEnvironmentSetupSeconds':round(fixture_started-started,3),'setupSeconds':round(setup_seconds,3),'validationSecondsIncludingProbes':round(validation_seconds,3),'saveSecondsIncludingRecoveryAndProbes':round(save_seconds,3),'checkpointLatchHeldSeconds':round(latch_seconds,3),'observedPausedSeconds':round(observed_pause_seconds,3),'workerPeakRssKiB':peak_rss,'events':events,'samples':samples,'releaseAuthorized':False}
        proof.update({'migrationLedger':ledger_expected,'acceptedProducerJobId':inputs['producer']['job'],'acceptedArtifactId':inputs['producer']['artifact'],'acceptedArtifactZipSha256':inputs['producer']['digest'],'actualSourceDependencyBytesVerified':True,'ownedDescendantCgroupsEmptyBeforePublication':True,'acceptanceRequires':'script-exit-zero AND whole-workflow-success AND owned-cleanup-success; JSON alone is invalid','wholeJobBudgetProposalSeconds':10800,'workflowCleanupEvidenceReserveSeconds':300})
        proof.update({'mode':args.mode,'catalogRows':100001,'nativeTaxDomainEvents':complete['nativeTaxEvents'],'nativeTaxDomainEventRollbackVerified':True,'multipartCoverageVerified':not preflight,'full100001SaveProof':not preflight})
        if preflight:
            require(complete['job']['saved']==401 and args.max_seconds<=900,'preflight cannot publish a full-throughput claim')
            proof.update({'kind':'CI_NATIVE_PREFLIGHT_NOT_FULL_100001','gracefulRestartVerified':False,'boundedNativeOnceCheckpointVerified':True,'wholeJobBudgetProposalSeconds':1200})
        remaining()
        # A timeout retains incomplete bytes as failure evidence, never as the final receipt.
        pending=report.with_name(report.name+'.incomplete')
        fd=os.open(pending,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o644)
        with os.fdopen(fd,'wb') as stream:
            stream.write(fmt.canonical(proof));stream.flush();os.fsync(stream.fileno())
        remaining()
    finally:
        # Cleanup has a separate ten-second reserve; preserve the original exception.
        # Only direct children with their exact UID/PID/argv/cwd/exe are eligible.
        failed=sys.exc_info()[0] is not None
        if failed: signal.setitimer(signal.ITIMER_REAL,0)
        errors=[]
        if holder is not None:
            try:
                if not holder.stdin.closed: holder.stdin.close()
                try: holder.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    info=Path('/proc')/str(holder.pid)
                    require(holder.poll() is None and info.stat().st_uid==runner_uid and (info/'exe').resolve()==node and (info/'cwd').resolve()==runtime and (info/'cmdline').read_bytes().split(b'\0')[:-1]==[v.encode() for v in fixture_argv('hold-pause')],'uncertain latch child; cleanup refused')
                    actual_env=dict(value.split(b'=',1) for value in (info/'environ').read_bytes().split(b'\0') if b'=' in value)
                    require(all(actual_env.get(k.encode())==v.encode() for k,v in fixture_env.items()),'uncertain latch child environment; cleanup refused')
                    holder.kill();holder.wait(timeout=1)
            except BaseException as error: errors.append('latch cleanup: '+repr(error))
        if active is not None and active.poll() is None:
            try:
                signal_owned(signal.SIGTERM)
                try: active.wait(timeout=3)
                except subprocess.TimeoutExpired: signal_owned(signal.SIGKILL);active.wait(timeout=1)
            except BaseException as error: errors.append('worker cleanup: '+repr(error))
        for error in errors: print(error,file=sys.stderr,flush=True)
        if not failed: require(not errors,'owned child cleanup failed')
    remaining()
    # Publish only after successful cleanup and fsync, exclusively and within budget.
    # A final receipt is consumable only with this controller's successful exit.
    receipt_identity=pending.stat()
    REGISTRY.register_receipt(report,receipt_identity)
    global RECEIPT
    RECEIPT=(report,(receipt_identity.st_dev,receipt_identity.st_ino),pending)
    remaining();os.link(pending,report);remaining()
    return {k:v for k,v in proof.items() if k not in ['events','samples']}

RECEIPT=None
if __name__=='__main__':
    supervised_seconds=supervisor_budget(sys.argv[1:])
    supervise_controller(supervised_seconds)
    # Only the exact forked root controller reaches this code. Its parent keeps
    # enforcing the original hard budget even when failure cleanup disarms SIGALRM.
    try:
        summary=main(supervised_seconds)
        remaining()
        RECEIPT[2].unlink()
        remaining()
        print(json.dumps(summary,sort_keys=True),flush=True)
        remaining()
    finally:
        if sys.exc_info()[0] is not None:
            signal.setitimer(signal.ITIMER_REAL,0)
            try: rollback_receipt()
            except BaseException as error: print('receipt rollback: '+repr(error),file=sys.stderr,flush=True)
        signal.setitimer(signal.ITIMER_REAL,0)
