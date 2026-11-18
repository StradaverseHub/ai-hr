"""Explicit recovery of an authenticated, published but never accepted staging worker.

Loaded only into the reviewed root bundle. A separate finite read-only seal precedes
fresh activation authority; original authorities, receipts and failed attempts survive.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import time
from types import SimpleNamespace

POLICY='aihr-worker-published-recovery/v1'
SEAL_STAGE='seal-published-ci-worker'
LIVE_STAGE='recover-published-ci-runtime'
KINDS={SEAL_STAGE:'ADMIN_REVIEWED_PUBLISHED_WORKER_SEAL',LIVE_STAGE:'ADMIN_AUTHORIZED_PUBLISHED_WORKER_RECOVERY'}
STAT_FIELDS=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
ATTEMPT_MEMBERS={'activation-failed.json','ci-runtime-started.json','ci-runtime-full-audit-0.json',
                 'ci-worker-start-request.json','ci-worker-started.json','ci-worker-quarantine-authority.json',
                 *('ci-runtime-fence-%02d.json'%i for i in range(4))}
FAILURE_FIELDS={'approval','approvalSha256','operation','operationIdentity','members','releaseIdentity','unitSha256'}

def identity(path):return {k:str(getattr(Path(path).lstat(),k))for k in STAT_FIELDS}

def selected_json(b,ci,selected):
    b.check(set(selected)=={'path','sha256'},'closed published proof selection required')
    path=Path(selected['path']);ci.protected_private(b,path);raw=b.read_bounded(path,65536)
    b.check(ci.sha(raw)==selected['sha256'],'published proof content changed')
    return path,json.loads(raw)

def historical(b,ci,prepared,a,pins):
    """Immutable lineage only; remains valid after our new worker has started."""
    b.check(set(pins)==FAILURE_FIELDS,'closed published failure selection required')
    approval,old=selected_json(b,ci,{'path':pins['approval'],'sha256':pins['approvalSha256']})
    b.check(set(old)==prepared.FIELDS and old['kind']==prepared.KINDS['recover-ci-runtime'] and
            old['target']=='alpha-staging' and old['releaseAuthorized']is False,'historical failed recovery authority required')
    shared=('identity','nodeSha256','python','nodeOptions','lease','leaseFile','leaseFileSha256','coordinatorSha256',
            'sourceManifestSha256','environmentSha256','dotenvSha256','readiness','operationsLock')
    b.check(all(old[k]==a[k]for k in shared),'published recovery shared pins differ')
    operation=Path(pins['operation']);original=b.ROOT/'upgrades'/a['identity']['source']
    _,prior_proof=selected_json(b,ci,old['preparedWorker'])
    b.check(operation==original/('recovery-'+prior_proof['preparation']['id']),'fixed historical recovery operation required')
    b.root_protected(operation)
    b.check(identity(operation)==pins['operationIdentity'] and set(os.listdir(operation))==ATTEMPT_MEMBERS and
            set(pins['members'])==ATTEMPT_MEMBERS,'historical recovery namespace changed')
    records={}
    for name in sorted(ATTEMPT_MEMBERS):
        path=operation/name;ci.protected_private(b,path);before=identity(path);raw=b.read_bounded(path,65536)
        b.check(before==identity(path) and {**before,'sha256':ci.sha(raw)}==pins['members'][name],
                'historical recovery record identity/content changed')
        records[name]=json.loads(raw)
    b.check(identity(operation)==pins['operationIdentity'] and set(os.listdir(operation))==ATTEMPT_MEMBERS,'historical recovery changed during observation')
    b.check(records['ci-runtime-started.json']=={'authorizationSha256':pins['approvalSha256'],'journeyVerified':False},'historical attempt authority differs')
    started=records['ci-worker-started.json'];intent=records['ci-worker-start-request.json']
    candidate=b.service_unit(a['identity']['source'])
    b.check(set(started)=={'intent','process','journeyVerified'} and started['intent']==intent and started['journeyVerified']is False and
            set(intent)=={'source','unitSha256','bootIdSha256','notBeforeTicks'} and intent['source']==a['identity']['source'] and
            intent['unitSha256']==ci.sha(candidate.encode()) and intent['bootIdSha256']==old['bootIdSha256'] and
            set(started['process'])=={'pid','startTicks','uid','source','cgroup'} and
            re.fullmatch('[1-9][0-9]*',started['process']['pid']) and
            int(started['process']['startTicks'])>=intent['notBeforeTicks'],'historical owned start differs')
    b.check(records['ci-worker-quarantine-authority.json']=={'ownedStartedProcess':started['process'],'freshLeaseAssertFailed':False,
            'failureOnly':True,'successAuthorized':False,'journeyVerified':False},'historical owned quarantine differs')
    for name in ATTEMPT_MEMBERS:
        observed=int(pins['members'][name]['st_mtime_ns'])/10**9
        b.check(ci.epoch(old['issuedAt'])<=observed<=ci.epoch(old['expiresAt']),'historical record outside original finite authority')
    b.check(records['activation-failed.json'].get('source')==a['identity']['source'] and
            records['activation-failed.json'].get('accepted')is False,'historical activation failure required')
    b.check(ci.sha(b.read_bounded(ci.BOOT_ID,4096))==old['bootIdSha256'],'published failure boot changed')
    return old,started['process'],candidate

def stopped(b,ci,update,a,pins):
    report=update.properties(b);release=b.ROOT/'releases'/a['identity']['source']
    b.validate_service(report,release)
    expected={'MainPID':'0','ActiveState':'inactive','SubState':'dead','NRestarts':'0','Restart':'no',
              'SendSIGKILL':'no','UnitFileState':'disabled','NeedDaemonReload':'no','Result':'success','ExecMainCode':'0','ExecMainStatus':'0'}
    b.check(all(report.get(k)==v for k,v in expected.items()),'exact clean stopped disabled published worker required')
    quarantine=b.service_unit(a['identity']['source']).replace('Restart=on-failure\n','Restart=no\nSendSIGKILL=no\n').encode()
    b.check(ci.sha(b.read_bounded(b.UNIT,65536))==pins['unitSha256']==ci.sha(quarantine),'exact published quarantine unit differs')
    b.check(ci.sha(b.read_bounded(b.ENV,1024**2))==a['identity']['worker_env_sha256'],'published worker environment changed')
    b.check(update.unit_or_identity_processes(pwd.getpwnam(b.USER).pw_uid)==[],'published worker identity still has a process')
    b.check(not (release/'worker-install-v2.json').exists() and not (release/'worker-install-v2.json').is_symlink(),'published worker already has an acceptance receipt')
    return report

def tree(b,ci,fmt,prepared,a,pins,*,deadline,content):
    release=b.ROOT/'releases'/a['identity']['source']
    old,process,_=historical(b,ci,prepared,a,pins)
    b.check(not (ci.PROCESS_ROOT/process['pid']).exists(),'old owned PID still exists or was reused')
    proof,root,manifest=prepared.prepared_proof(b,ci,fmt,old['preparedWorker'],a['identity'],deadline=deadline,metadata=False,published_root=release)
    actual=prepared.tree_identity(root,manifest,deadline=deadline,content=content)
    b.check(identity(root)==pins['releaseIdentity'],'published root identity differs')
    # Rename may change only the old root ctime/location; EVERY member identity,
    # byte, mode and link closure still follows its original authenticated seal.
    b.check(actual['rootIdentity'][:-1]==proof['tree']['rootIdentity'][:-1] and
            {k:v for k,v in actual.items()if k!='rootIdentity'}=={k:v for k,v in proof['tree'].items()if k!='rootIdentity'},
            'published membership/metadata changed since authenticated preparation')
    return old,actual,proof,manifest

def seal(guard,fmt,b,ci,prepared,update):
    a=guard.a;pins=a['publishedFailure'];ident=a['sealId']
    b.check(re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',ident),'exclusive published seal ID required')
    b.check(ci.epoch(a['expiresAt'])<=ci.epoch(a['issuedAt'])+300,'published read-only seal authority exceeds300 seconds')
    end=min(time.monotonic()+300,ci.epoch(a['expiresAt'])-time.time()+time.monotonic())
    path=b.ROOT/'upgrades'/a['identity']['source']/('published-worker-'+ident+'.json')
    b.check(not path.exists() and not path.is_symlink(),'published seal already exists')
    guard.before_mutation();stopped(b,ci,update,a,pins)
    old,actual,proof,manifest=tree(b,ci,fmt,prepared,a,pins,deadline=end,content=True)
    prepared.failure_snapshot(b,ci,old['recovery'],a['identity'],old['launch'])
    archive=b.ROOT/'upgrades'/a['identity']['source']/'authenticated-worker.zip'
    b.check(ci.bounded_file_sha256(b,archive,fmt.MAX_ARCHIVE)==a['identity']['archive_sha256'],'published archive bytes changed')
    guard.before_mutation();stopped(b,ci,update,a,pins)
    b.check(time.monotonic()<end,'published seal aggregate deadline expired')
    record={'format':1,'kind':'ROOT_AUTHENTICATED_PUBLISHED_WORKER_NOT_ACTIVATION','policy':POLICY,'sealId':ident,
            'approval':str(guard.path),'approvalSha256':ci.sha(guard.bytes),'sealedAt':ci.datetime.fromtimestamp(time.time(),ci.timezone.utc).isoformat(),
            'identity':a['identity'],'publishedFailure':pins,'tree':actual,'releaseAuthorized':False}
    guard.file_mutation();b.write_new(path,fmt.canonical(record),0o400)
    print(json.dumps({'kind':record['kind'],'proofSha256':ci.sha(fmt.canonical(record)),'serviceMutation':False,'releaseAuthorized':False}))

def load_seal(guard,fmt,b,ci,prepared):
    a=guard.a;selection=a['publishedSeal']
    b.check(set(selection)=={'path','sha256','identity'},'closed published seal inode/content selection required')
    path,record=selected_json(b,ci,{k:selection[k]for k in('path','sha256')})
    b.check(identity(path)==selection['identity'],'published seal inode/metadata changed')
    fields={'format','kind','policy','sealId','approval','approvalSha256','sealedAt','identity','publishedFailure','tree','releaseAuthorized'}
    b.check(set(record)==fields and record['format']==1 and record['kind']=='ROOT_AUTHENTICATED_PUBLISHED_WORKER_NOT_ACTIVATION' and
            record['policy']==POLICY and record['releaseAuthorized']is False and record['identity']==a['identity'],'closed authenticated published seal required')
    _,authority=selected_json(b,ci,{'path':record['approval'],'sha256':record['approvalSha256']})
    b.check(set(authority)==SEAL_FIELDS and authority['kind']==KINDS[SEAL_STAGE] and authority['target']=='alpha-staging' and
            authority['releaseAuthorized']is False and authority['sealId']==record['sealId'] and
            authority['publishedFailure']==record['publishedFailure'],'original published seal authority differs')
    b.check(path==b.ROOT/'upgrades'/a['identity']['source']/('published-worker-'+record['sealId']+'.json'),'fixed published seal destination required')
    issued,expires=ci.epoch(authority['issuedAt']),ci.epoch(authority['expiresAt'])
    sealed=ci.epoch(record['sealedAt']);live=ci.epoch(a['issuedAt'])
    b.check(issued<=sealed<=expires<=issued+300 and issued<=path.stat().st_mtime<=expires and
            sealed<=live<=expires and live<=time.time(),'published seal must complete before a fresh live authority inside original seal freshness window')
    old,_,_=historical(b,ci,prepared,a,record['publishedFailure'])
    shared=prepared.FIELDS-{'helperSha256','issuedAt','expiresAt','kind'}
    b.check(all(a[k]==old[k]for k in shared),'published recovery original installation/history pins differ')
    b.check(all(authority[k]==a[k]for k in ci.FIRST_APPROVAL_FIELDS-{'gate','helperSha256','issuedAt','expiresAt','kind'}),
            'published seal and live shared pins differ')
    return record

def run(guard,fmt,b,ci,prepared,update):
    a=guard.a;record=load_seal(guard,fmt,b,ci,prepared);pins=record['publishedFailure']
    release=b.ROOT/'releases'/a['identity']['source'];original=b.ROOT/'upgrades'/a['identity']['source']
    operation=original/('published-recovery-'+record['sealId'])
    b.check(not any(p.name.startswith('published-recovery-')for p in original.iterdir()),'previous published recovery requires separate review')
    stopped(b,ci,update,a,pins)
    _,actual,proof,_=tree(b,ci,fmt,prepared,a,pins,deadline=ci.SLOT_DEADLINE,content=False)
    b.check(actual==record['tree'],'published seal tree changed')
    args=SimpleNamespace(**a['identity'],ci_runtime_authorization=str(guard.path),ci_runtime_authorization_sha256=ci.sha(guard.bytes))
    observer=ci.RuntimeObservation(b,fmt,args,operation,b.read_bounded(original/'drained.json',65536),recovery=a['recovery'],prepared=a['preparedWorker'])
    observer.ci=ci
    native=ci.child([str(b.NODE),'--env-file=.env.production','--input-type=module','-e',prepared.FAILED_NATIVE_PROBE,str(observer.directory)],observer.owner,observer.environment,timeout=30)
    b.check(native['kind']=='EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL' and native['source']==args.source and
            native['installId']==a['install']['id'] and {k:v for k,v in native['active']['migrationLedger'].items()if k!='verifiedAt'}==a['ledger'],
            'actual original published failed installation differs')
    guard.file_mutation();operation.mkdir(mode=0o700)
    update.publish(b,operation/'ci-runtime-started.json',fmt.canonical({'authorizationSha256':ci.sha(guard.bytes),'journeyVerified':False}),0o400)
    observer.complete_fence();observer.content_audit();observer.complete_fence();observer.full_audit();observer.complete_fence();observer.admit_mutation()
    def revalidate_published():
        guard.file_mutation();stopped(b,ci,update,a,pins)
        fresh=load_seal(guard,fmt,b,ci,prepared)
        _,current,_,_=tree(b,ci,fmt,prepared,a,pins,deadline=ci.SLOT_DEADLINE,content=False)
        b.check(fresh==record and current==record['tree'],'published tree changed before unit replacement')
        return release
    receipt={'manifestSha256':proof['manifestSha256'],'preparedProofSha256':a['preparedWorker']['sha256'],
             'publishedSealSha256':a['publishedSeal']['sha256'],'previousWebSource':args.previous_web_source,
             'previousWebBuildId':args.previous_web_build,'previousWorkerSource':args.previous_worker_source,
             'originalInstallationGrantExpiresAt':observer.grant['expiresAt'],'workerRecoveryOnly':True,'publishedRecoveryOnly':True}
    return update.replace_and_start(b,fmt,args,operation,release,None,pins['unitSha256'],receipt,observer,prepare_release=revalidate_published,enable_after_verification=True)

def configure(ci,prepared):
    global SEAL_FIELDS,LIVE_FIELDS
    SEAL_FIELDS=ci.FIRST_APPROVAL_FIELDS|{'publishedFailure','sealId'}
    LIVE_FIELDS=prepared.FIELDS|{'publishedSeal'}
