"""Root-only authenticated preparation and exact pre-unit recovery. No web finish authority.

Preparation has its own finite IO authority; live activation retains preparation30 and the
original proof slots with one additional absolute827 cap. Historical grants are never renewed.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
from types import SimpleNamespace

POLICY='aihr-worker-prepared-handoff/v1'
NORMAL_V2_POLICY='aihr-worker-prepared-handoff/v2'
KINDS={'prepare-ci-worker':'ADMIN_REVIEWED_CI_WORKER_PREPARATION','activate-prepared-ci-runtime':'ADMIN_AUTHORIZED_PREPARED_CI_WORKER_CUTOVER','recover-ci-runtime':'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_RECOVERY'}
PREP_KEYS={'policy','mode','id','firstStageApproval','firstStageApprovalSha256','drainSha256','directory','directoryIdentity','proof','failure'}
FAILURE_KEYS={'originalOperation','originalActivationApproval','originalActivationApprovalSha256','originalStartedSha256','failureCurrentSha256','failureLastOkSha256','failureLog','failureLogSha256','failureFinishedAt'}
OVERALL_SECONDS=827
PREPARE_SECONDS=300
NORMAL_V2_PREPARE_SECONDS=600
INSTALL_LOCK=Path('/run/aihr-bank-import/install.lock')


def digest(raw):return hashlib.sha256(raw).hexdigest()

def tree_identity(root,manifest,*,deadline,content=False,uid=0):
    """No-follow membership+identity fence. content=True additionally authenticates EVERY file."""
    root=Path(root);before=root.lstat()
    def check(ok,message):
        if not ok:raise ValueError('Prepared worker refused: '+message)
    check(stat.S_ISDIR(before.st_mode) and not root.is_symlink() and root.resolve()==root and before.st_uid==uid and stat.S_IMODE(before.st_mode)==0o755,'canonical protected prepared root required')
    entries={row['path']:row for row in manifest['entries']};rows=[];total=0
    def identity(s):return [str(getattr(s,k))for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')]
    for current,dirs,files in os.walk(root,followlinks=False):
        for name in sorted(dirs+files):
            check(time.monotonic()<deadline,'absolute preparation/fence deadline expired')
            path=Path(current)/name;rel=path.relative_to(root).as_posix();s=path.lstat();row=entries.get(rel)
            check(row is not None and s.st_uid==uid and s.st_dev==before.st_dev,'unexpected member/owner/device')
            actual={'path':rel,'identity':identity(s)}
            if row['type']=='file':
                check(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==row['mode'] and s.st_size==row['size'],'file kind/mode/size/link differs')
                if content:
                    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                    with os.fdopen(fd,'rb')as stream:
                        check(identity(os.fstat(stream.fileno()))==identity(s),'file changed before byte read')
                        check(hashlib.file_digest(stream,'sha256').hexdigest()==row['sha256'],'file content differs')
                        check(identity(os.fstat(stream.fileno()))==identity(s)==identity(path.lstat()),'file changed during byte read')
                total+=s.st_size
            elif row['type']=='directory':check(stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==0o755,'directory kind/mode differs')
            else:
                check(stat.S_ISLNK(s.st_mode) and os.readlink(path)==row['target'],'link differs')
                # The content pass seals actual link closure. Later metadata-only passes
                # compare every root/member identity and exact literal target to that seal.
                if content:check(path.resolve(strict=True).is_relative_to(root),'prepared link escapes')
                actual['target']=row['target']
            rows.append(actual)
    rows.sort(key=lambda row:row['path'])
    check([row['path']for row in rows]==sorted(entries),'missing prepared members')
    check(identity(root.lstat())==identity(before),'prepared root changed during observation')
    check(time.monotonic()<deadline,'absolute preparation/fence deadline expired')
    return {'rootIdentity':identity(before),'entries':len(rows),'bytes':total,'metadataSha256':digest(json.dumps(rows,sort_keys=True,separators=(',',':')).encode())}


def preparation_seconds(p):
    return NORMAL_V2_PREPARE_SECONDS if p['policy']==NORMAL_V2_POLICY and p['mode']=='normal' else PREPARE_SECONDS


def closed_preparation(base,ci,a):
    p=a['preparation'];base.check(set(p)==PREP_KEYS and (p['policy']==POLICY or p['policy']==NORMAL_V2_POLICY and p['mode']=='normal') and p['mode']in('normal','failed-preunit') and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',p['id']),'closed preparation identity required')
    operation=base.ROOT/'upgrades'/a['identity']['source'];base.root_protected(operation)
    base.check(p['proof']==str(operation/('prepared-worker-'+p['id']+'.json')),'fixed exclusive proof destination required')
    wanted=operation/('prepared-'+p['id']) if p['mode']=='normal' else operation/'activation-release'
    base.check(p['directory']==str(wanted),'fixed prepared directory required')
    base.check((p['failure']is None and p['directoryIdentity']is None) if p['mode']=='normal' else isinstance(p['failure'],dict) and set(p['failure'])==FAILURE_KEYS and set(p['directoryIdentity'])=={'device','inode','uid','gid','mode'},'separate normal/failed preparation required')
    return p,operation


def failure_snapshot(base,ci,f,identity,launch):
    base.check(set(f)==FAILURE_KEYS and f['originalOperation']==str(base.ROOT/'upgrades'/identity['source']),'closed original failed operation required')
    base.check(not (ci.STATE/'pending').exists() and not (ci.STATE/'pending').is_symlink(),'no new pending deployment permitted')
    raw=[base.read_bounded(ci.STATE/name,65536)for name in('current','last-ok')]
    base.check([ci.sha(x)for x in raw]==[f['failureCurrentSha256'],f['failureLastOkSha256']],'original terminal failure/last-ok changed')
    current,prior=map(ci.record,raw)
    base.check(current.get('result')=='failed' and current.get('exit_code')=='1' and current.get('phase')=='ci-build-health' and current.get('finished_at')==f['failureFinishedAt'],'exact terminal worker-check failure required')
    base.check({k:current[k]for k in launch['current']}==launch['current'] and current['ref']==identity['source'] and current['build_id']==identity['build_id'],'original terminal launch identity differs')
    base.check(not (ci.PROCESS_ROOT/current['pid']).exists(),'original deployment process still exists or PID was reused')
    base.check(f['failureLog']==current['log'] and ci.sha(base.read_bounded(Path(f['failureLog']),4*1024**2))==f['failureLogSha256'],'original failure log changed')
    base.check(prior.get('ref')==identity['previous_web_source'] and prior.get('build_id')==identity['previous_web_build'],'prior successful release differs')
    base.check(base.read_bounded(ci.SOURCE/'.next/BUILD_ID',1024).decode().strip()==identity['build_id'],'actual build differs')
    return 'F',raw


FAILED_NATIVE_PROBE="""import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{validateInstallGrant}from'./.github/ci/ci-install-grant.mjs';import{admitInterruptedDeployRecord,validateActivationLog}from'./.github/ci/resume-arrival.mjs';import{expectedMigrationLedger}from'./.github/ci/staging-migration-ledger.mjs';const directory=process.argv[1],g=JSON.parse(readFileSync(directory+'/authorization.json'));validateInstallGrant(g,{allowExpired:true});const text=execFileSync('bash',['deploy/deploy-state.sh','status'],{encoding:'utf8'});const status=Object.fromEntries(text.trim().split('\\n').map(x=>x.split(/=(.*)/s).slice(0,2)));admitInterruptedDeployRecord(status,{grant:g,candidate:g.source});const proof=validateActivationLog(readFileSync(status.log,'utf8'),{grant:g,expectedLedger:expectedMigrationLedger('/opt/ai-hr')});assert(proof.activeRecord.source===g.source);console.log(JSON.stringify({kind:'EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL',installId:g.installId,source:g.source,build:g.build.nextBuildId,active:proof.activeRecord}));"""


def historical_activation(base,ci,a,f):
    path=Path(f['originalActivationApproval']);ci.protected_private(base,path)
    raw=base.read_bounded(path,65536);base.check(ci.sha(raw)==f['originalActivationApprovalSha256'],'original activation approval differs');old=json.loads(raw)
    base.check(set(old)==ci.ACTIVATION_FIELDS and old['kind']=='ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER','original closed activation authority required')
    shared=('identity','nodeSha256','python','nodeOptions','lease','leaseFile','leaseFileSha256','coordinatorSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','operationsLock')
    base.check(all(old[k]==a[k]for k in shared),'original activation shared pins differ')
    started=base.ROOT/'upgrades'/a['identity']['source']/'ci-runtime-started.json';ci.protected_private(base,started)
    started_raw=base.read_bounded(started,65536)
    base.check(ci.sha(started_raw)==f['originalStartedSha256'] and json.loads(started_raw)=={'authorizationSha256':ci.sha(raw),'journeyVerified':False},'original failed activation marker differs')
    base.check(ci.epoch(old['issuedAt'])<=started.stat().st_mtime<=ci.epoch(old['expiresAt']),'historical activation was not valid at its real start')
    return old


def check_history(o):
    b,c,a,f=o.base,o.guard.ci,o.auth,o.recovery
    if o.guard.stage=='recover-unstarted-ci-runtime':return c.UNSTARTED.check_history(o)
    if o.guard.stage=='recover-published-ci-runtime' and c.PUBLISHED.unstarted_origin(c,a):
        c.UNSTARTED.historical_preparation(b,c,c.RECOVERY,a)
        c.UNSTARTED.failure_snapshot(b,c,f,a['identity'],a['launch'])
        return c.PUBLISHED.load_seal(o.guard,o.fmt,b,c,c.RECOVERY)
    old=historical_activation(b,c,a,f)
    b.check(all(old[k]==a[k]for k in('install','grantSha256','activatedSha256','runtimeSha256','drainSha256','ledger','bootIdSha256','webPid','webStartedMonotonicUs','priorLastOkSha256','launch','firstStageApproval','firstStageApprovalSha256')),'original exact installation/failure pins differ')
    first=json.loads(o.first_bytes);b.check(first['helperSha256']==old['helperSha256'],'original helper provenance differs')
    failure_snapshot(b,c,f,a['identity'],a['launch'])
    if o.guard.stage=='recover-published-ci-runtime':c.PUBLISHED.load_seal(o.guard,o.fmt,b,c,c.RECOVERY)


def failed_snapshot(o):
    if o.guard.stage=='recover-unstarted-ci-runtime' or o.guard.stage=='recover-published-ci-runtime' and o.guard.ci.PUBLISHED.unstarted_origin(o.guard.ci,o.auth):return o.guard.ci.UNSTARTED.failure_snapshot(o.base,o.guard.ci,o.recovery,o.auth['identity'],o.auth['launch'])
    return failure_snapshot(o.base,o.guard.ci,o.recovery,o.auth['identity'],o.auth['launch'])


def admit_mutation(o):
    b=o.base;remaining=min(o.overall_deadline-time.monotonic(),o.guard.ci.epoch(o.auth['expiresAt'])-time.time())
    b.check(o.fence_count==3 and len(o.audits)==1 and len(o.content_proofs)==1,'full recovery pre-mutation proof graph required')
    if o.guard.stage=='recover-published-ci-runtime' and o.guard.ci.PUBLISHED.overall_selected(o.guard.ci,o.auth,o.guard.stage):
        b.check(remaining>0 and o.overall_deadline==o.guard.ci.OVERALL_EXECUTION_DEADLINE,'original overall opportunity expired before mutation')
        failed_snapshot(o);o.check_authority()
        return {'recoveryOnly':True,'originalReadinessWindowRevived':False,'expiredGrantWriteAuthority':False,'executionPolicy':o.auth['executionPolicy']}
    extra=40 if o.guard.stage in ('recover-published-ci-runtime','recover-unstarted-ci-runtime')else 0
    post=o.guard.ci.PUBLISHED.post_opportunity(o,extra)if o.guard.stage=='recover-published-ci-runtime'else 497+extra
    b.check(o.guard.ci.epoch(o.auth['expiresAt'])-time.time()>=post+30 and remaining>=post,'insufficient independently authorized recovery/global opportunity')
    failed_snapshot(o)
    return {'recoveryOnly':True,'originalReadinessWindowRevived':False,'expiredGrantWriteAuthority':False}


def prepared_proof(base,ci,fmt,selected,identity,*,deadline,metadata=True,published_root=None,baseline_publication=None):
    base.check(set(selected)=={'path','sha256'},'closed prepared proof selection required');path=Path(selected['path']);ci.protected_private(base,path)
    raw=base.read_bounded(path,65536);base.check(ci.sha(raw)==selected['sha256'],'sealed prepared proof differs');proof=json.loads(raw)
    base.check(set(proof)=={'format','kind','policy','preparationApproval','preparationApprovalSha256','preparedAt','identity','archiveSha256','manifestSha256','directory','tree','preparation','releaseAuthorized'} and proof['format']==1 and proof['kind']=='ROOT_AUTHENTICATED_WORKER_PREPARATION_NOT_ACTIVATION' and proof['policy']in(POLICY,NORMAL_V2_POLICY) and proof['identity']==identity and proof['releaseAuthorized']is False,'closed prepared byte attestation required')
    approval=Path(proof['preparationApproval']);ci.protected_private(base,approval);araw=base.read_bounded(approval,65536)
    base.check(ci.sha(araw)==proof['preparationApprovalSha256'],'preparation authority differs');a=json.loads(araw)
    preparation=a.get('preparation')
    fields=ci.baseline_publication_fields(PREP_FIELDS,a,allow=baseline_publication is not None and type(preparation)is dict and preparation.get('mode')=='normal')
    base.check(a.get(ci.BASELINE_PUBLICATION_KEY)==baseline_publication,'preparation and activation qualified legacy baseline selections differ')
    base.check(set(a)==fields and a['kind']==KINDS['prepare-ci-worker'] and a['policy']==ci.POLICY and a['format']==1 and a['target']=='alpha-staging' and a['releaseAuthorized']is False and a['identity']==identity and a['preparation']==proof['preparation'],'original closed preparation required')
    p,operation=closed_preparation(base,ci,a)
    base.check(proof['policy']==p['policy'],'prepared proof/approval policy version differs')
    base.check(str(path)==p['proof'] and proof['directory']==p['directory'],'fixed prepared proof/root selection differs')
    base.check(ci.epoch(a['issuedAt'])<=ci.epoch(proof['preparedAt'])<=ci.epoch(a['expiresAt']) and ci.epoch(a['issuedAt'])<=path.stat().st_mtime<=ci.epoch(a['expiresAt']) and ci.epoch(proof['preparedAt'])<=time.time() and ci.epoch(a['expiresAt'])<=ci.epoch(a['issuedAt'])+preparation_seconds(p),'preparation proof outside original finite IO authority')
    operation=base.ROOT/'upgrades'/identity['source'];archive=operation/'authenticated-worker.zip';base.root_protected(archive,regular=True)
    manifest=fmt.inspect_archive(archive,identity['source'],identity['lock_sha256'],identity['package_sha256'])
    base.check(proof['archiveSha256']==identity['archive_sha256'] and proof['manifestSha256']==fmt.digest(fmt.canonical(manifest)),'prepared archive/manifest identity differs')
    root=Path(proof['directory'])if published_root is None else Path(published_root)
    if published_root is not None:base.check(not metadata and root==base.ROOT/'releases'/identity['source'],'published proof requires explicit immutable destination and separate seal')
    base.root_protected(root)
    if metadata:base.check(tree_identity(root,manifest,deadline=deadline)==proof['tree'],'previously byte-proved root tree identity/membership changed')
    return proof,root,manifest


def clean_prior(base,update,identity):
    report=update.validate_existing(base,identity['previous_worker_source'],identity['unit_sha256'],identity['worker_env_sha256'])
    expected={'MainPID':'0','ActiveState':'inactive','SubState':'dead','Result':'success','ExecMainStatus':'0','NRestarts':'0','UnitFileState':'enabled'}
    base.check(all(report.get(key)==value for key,value in expected.items()),'prior managed worker is not the exact clean drain')
    base.check(update.unit_or_identity_processes(__import__('pwd').getpwnam(base.USER).pw_uid)==[],'worker identity has an unexpected process')
    base.check(not (base.ROOT/'releases'/identity['source']).exists(),'new worker release already exists')
    return report


def prepare(guard,fmt,base,ci,update):
    a=guard.a;p,operation=closed_preparation(base,ci,a);seconds=preparation_seconds(p);end=min([time.monotonic()+seconds,ci.epoch(a['expiresAt'])-time.time()+time.monotonic(),*[d for d in (getattr(base,'VERIFIED_OPERATION_DEADLINE',None),getattr(ci,'SLOT_DEADLINE',None))if d is not None]])
    base.check(ci.epoch(a['expiresAt'])<=ci.epoch(a['issuedAt'])+seconds,'finite preparation authority exceeds'+str(seconds)+'s')
    first_path=Path(p['firstStageApproval']);ci.protected_private(base,first_path);first_raw=base.read_bounded(first_path,65536)
    base.check(ci.sha(first_raw)==p['firstStageApprovalSha256'],'original drain approval differs');first=json.loads(first_raw)
    fields=ci.baseline_publication_fields(ci.FIRST_APPROVAL_FIELDS,first,allow=p['mode']=='normal'and ci.BASELINE_PUBLICATION_KEY in a)
    base.check(set(first)==fields and first['kind']=='ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS','closed original drain approval required')
    ci.require_same_baseline_publication(base,first,a)
    base.check(all(first[k]==a[k]for k in ci.FIRST_APPROVAL_FIELDS-{'kind','issuedAt','expiresAt','helperSha256'}),'prepared source/gate/environment/lease pins differ')
    raw=base.read_bounded(operation/'drained.json',65536);drain=json.loads(raw)
    base.check(ci.sha(raw)==p['drainSha256'] and drain['identity']==a['identity'] and drain['drain']['state']=='drained','actual original managed drain required')
    base.check(ci.epoch(first['issuedAt'])<=(operation/'drained.json').stat().st_mtime<=ci.epoch(first['expiresAt']),'original drain approval timing differs')
    args=SimpleNamespace(**a['identity'])
    def prior():return clean_prior(base,update,a['identity'])
    def state():
        guard.before_mutation();prior()
        if p['mode']=='normal':
            base.check(not (operation/'ci-runtime-started.json').exists(),'normal preparation must precede live activation')
            update.healthy_web_state(base,args.previous_web_source,args.previous_web_build)
        else:
            previous=historical_activation(base,ci,a,p['failure']);failure_snapshot(base,ci,p['failure'],a['identity'],previous['launch'])
            base.check(not any(x.name.startswith('recovery-')for x in operation.iterdir()),'previous recovery attempt requires separate review')
            native=ci.child([str(base.NODE),'--env-file=.env.production','--input-type=module','-e',FAILED_NATIVE_PROBE,previous['install']['directory']],guard.owner,guard.environment,timeout=30)
            base.check(native['kind']=='EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL' and native['source']==args.source and native['installId']==previous['install']['id'] and {k:v for k,v in native['active']['migrationLedger'].items()if k!='verifiedAt'}==previous['ledger'],'actual original failed install/ledger differs')
        return True
    state();archive=operation/'authenticated-worker.zip';base.root_protected(archive,regular=True)
    base.check(hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==args.archive_sha256,'authenticated archive bytes differ')
    manifest=fmt.inspect_archive(archive,args.source,args.lock_sha256,args.package_sha256)
    base.check(fmt.digest(fmt.canonical(manifest))==drain['manifestSha256'],'original drain manifest differs')
    directory=Path(p['directory']);base.check(not Path(p['proof']).exists(),'prepared proof already exists')
    if p['mode']=='normal':
        base.check(not directory.exists() and not directory.is_symlink(),'new prepared directory already exists');guard.file_mutation();directory.mkdir(mode=0o700)
        fmt.extract_archive(archive,directory,args.source,args.lock_sha256,args.package_sha256)
        entries={row['path']:row for row in manifest['entries']}
        for path in directory.rglob('*'):
            base.check(time.monotonic()<end,'aggregate offline preparation deadline expired')
            if not path.is_symlink():os.chmod(path,0o755 if path.is_dir()else entries[path.relative_to(directory).as_posix()]['mode'])
        os.chmod(directory,0o755)
    else:
        st=directory.lstat();base.check({k:getattr(st,'st_'+v)for k,v in [('device','dev'),('inode','ino'),('uid','uid'),('gid','gid')]}|{'mode':stat.S_IMODE(st.st_mode)}==p['directoryIdentity'],'exact failed extraction inode differs')
    tree=tree_identity(directory,manifest,deadline=end,content=True)
    state();base.check(time.monotonic()<end,'aggregate offline preparation deadline expired')
    proof={'format':1,'kind':'ROOT_AUTHENTICATED_WORKER_PREPARATION_NOT_ACTIVATION','policy':p['policy'],'preparationApproval':str(guard.path),'preparationApprovalSha256':ci.sha(guard.bytes),'preparedAt':ci.datetime.fromtimestamp(time.time(),ci.timezone.utc).isoformat(),'identity':a['identity'],'archiveSha256':args.archive_sha256,'manifestSha256':fmt.digest(fmt.canonical(manifest)),'directory':str(directory),'tree':tree,'preparation':p,'releaseAuthorized':False}
    guard.file_mutation();base.write_new(Path(p['proof']),fmt.canonical(proof),0o400)
    print(json.dumps({'kind':proof['kind'],'proof':p['proof'],'proofSha256':ci.sha(fmt.canonical(proof)),'tree':tree,'serviceMutation':False,'releaseAuthorized':False}))


def run(stage,guard,fmt,base,ci,update):
    import fcntl
    lock=INSTALL_LOCK
    base.root_protected(lock,regular=True);fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);guard.bind_install(fd,lock)
        if stage=='seal-published-ci-worker':return ci.PUBLISHED.seal(guard,fmt,base,ci,ci.RECOVERY,update)
        if stage=='recover-published-ci-runtime':return ci.PUBLISHED.run(guard,fmt,base,ci,ci.RECOVERY,update)
        if stage=='prepare-ci-worker':return prepare(guard,fmt,base,ci,update)
        if stage=='recover-unstarted-ci-runtime':return ci.UNSTARTED.run(guard,fmt,base,ci,update)
        a=guard.a;identity=a['identity'];original=base.ROOT/'upgrades'/identity['source'];base.root_protected(original)
        recovery=a.get('recovery');selected=a['preparedWorker']
        proof,directory,manifest=prepared_proof(base,ci,fmt,selected,identity,deadline=ci.SLOT_DEADLINE,baseline_publication=a.get(ci.BASELINE_PUBLICATION_KEY))
        base.check(ci.epoch(proof['preparedAt'])<=ci.epoch(a['issuedAt']),'live approval predates sealed preparation')
        base.check(proof['preparation']['mode']==('failed-preunit'if recovery is not None else'normal'),'prepared state does not match activation mode')
        base.check(proof['preparation']['firstStageApproval']==a['firstStageApproval'] and proof['preparation']['firstStageApprovalSha256']==a['firstStageApprovalSha256'] and proof['preparation']['drainSha256']==a['drainSha256'],'preparation and live historical drain pins differ')
        if recovery is not None:base.check(recovery==proof['preparation']['failure'],'failed state differs from sealed preparation')
        operation=original if recovery is None else original/('recovery-'+proof['preparation']['id'])
        if recovery is None:base.check(not (operation/'ci-runtime-started.json').exists(),'existing activation attempt requires exact recovery')
        else:
            base.check(not any(x.name.startswith('recovery-')for x in original.iterdir()),'previous recovery attempt requires separate review')
            base.check(not operation.exists(),'recovery attempt already exists')
        args=SimpleNamespace(**identity,ci_runtime_authorization=str(guard.path),ci_runtime_authorization_sha256=ci.sha(guard.bytes))
        observer=ci.RuntimeObservation(base,fmt,args,operation,base.read_bounded(original/'drained.json',65536),recovery=recovery,prepared=selected)
        observer.ci=ci
        if recovery is not None:
            native=ci.child([str(base.NODE),'--env-file=.env.production','--input-type=module','-e',FAILED_NATIVE_PROBE,str(observer.directory)],observer.owner,observer.environment,timeout=30)
            base.check(native['kind']=='EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL' and native['source']==identity['source'] and native['installId']==a['install']['id'] and native['active']['migrationLedger']['actualSha256']==a['ledger']['actualSha256'],'native original failed-install admission differs')
        clean_prior(base,update,identity)
        if recovery is not None:guard.file_mutation();operation.mkdir(mode=0o700)
        update.publish(base,operation/'ci-runtime-started.json',fmt.canonical({'authorizationSha256':ci.sha(guard.bytes),'journeyVerified':False}),0o400)
        observer.complete_fence();observer.content_audit();observer.complete_fence();observer.full_audit();observer.complete_fence();observer.admit_mutation()
        release=base.ROOT/'releases'/identity['source']
        def publish_prepared():
            # Same M0/45 slot covers this full metadata fence, atomic rename, unit replace and reload.
            guard.file_mutation();clean_prior(base,update,identity);fresh,root,_=prepared_proof(base,ci,fmt,selected,identity,deadline=ci.SLOT_DEADLINE,baseline_publication=a.get(ci.BASELINE_PUBLICATION_KEY))
            base.check(fresh==proof and root==directory and not release.exists(),'prepared publication changed')
            guard.file_mutation();os.rename(directory,release);return release
        return update.replace_and_start(base,fmt,args,operation,release,None,identity['unit_sha256'],{'manifestSha256':proof['manifestSha256'],'preparedProofSha256':selected['sha256'],'previousWebSource':identity['previous_web_source'],'previousWebBuildId':identity['previous_web_build'],'previousWorkerSource':identity['previous_worker_source'],'originalInstallationGrantExpiresAt':observer.grant['expiresAt'],'workerRecoveryOnly':recovery is not None},observer,prepare_release=publish_prepared)
    finally:os.close(fd)


def configure(ci):
    global PREP_FIELDS,NORMAL_FIELDS,FIELDS
    PREP_FIELDS=ci.FIRST_APPROVAL_FIELDS|{'preparation'}
    NORMAL_FIELDS=ci.ACTIVATION_FIELDS|{'preparedWorker','nativeActivation'}
    FIELDS=ci.ACTIVATION_FIELDS|{'preparedWorker','recovery','nativeActivation'}
