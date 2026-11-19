"""F-only recovery of a normally prepared worker whose activation NEVER started.

The original grant and normal readiness/planning windows remain historical. A fresh
root authority owns this separate full F proof graph; it never manufactures an old attempt.
"""
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace

POLICY='aihr-worker-unstarted-recovery/v1'
REJECTED_POLICY='aihr-worker-rejected-normal-recovery/v1'
REJECTED_EXECUTION='aihr-worker-rejected-normal-overall/v1'
REJECTED_SECONDS=1500
REJECTED_MEMBERS={'ci-runtime-started.json','ci-runtime-full-audit-0.json',*(f'ci-runtime-fence-{i:02}.json' for i in range(3))}
LIVE_STAGE='recover-unstarted-ci-runtime'
KINDS={LIVE_STAGE:'ADMIN_AUTHORIZED_UNSTARTED_CI_WORKER_RECOVERY'}
FAILURE_FIELDS={'policy','id','originalOperation','failureCurrentSha256','failureLastOkSha256','failureLog','failureLogSha256','failureFinishedAt'}


def closed_failure(base,ci,f,identity):
    rejected=f.get('policy')==REJECTED_POLICY
    base.check(set(f)==(FAILURE_FIELDS|{'rejectedNormal'} if rejected else FAILURE_FIELDS) and f['policy'] in (POLICY,REJECTED_POLICY) and
               re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',f['id']) and
               f['originalOperation']==str(base.ROOT/'upgrades'/identity['source']),
               'closed unstarted recovery failure identity required')
    for key in ('failureCurrentSha256','failureLastOkSha256','failureLogSha256'):
        base.check(re.fullmatch('[a-f0-9]{64}',f[key]),'exact terminal failure digest required')
    base.check(re.fullmatch('[1-9][0-9]*',f['failureFinishedAt']),'actual deploy-state epoch finish required')


def failure_snapshot(base,ci,f,identity,launch):
    """Read-only canonical F admission, callable by the protected collector before authority exists."""
    closed_failure(base,ci,f,identity)
    base.check(not (ci.STATE/'pending').exists() and not (ci.STATE/'pending').is_symlink(),'no pending deployment permitted')
    raw=[base.read_bounded(ci.STATE/name,65536)for name in('current','last-ok')]
    base.check([ci.sha(x)for x in raw]==[f['failureCurrentSha256'],f['failureLastOkSha256']],'terminal failure/last-ok changed')
    current,prior=map(ci.record,raw)
    base.check(current.get('result')=='failed' and current.get('exit_code')=='1' and current.get('phase')=='ci-build-health' and current.get('finished_at')==f['failureFinishedAt'],'actual final worker-check failure required')
    base.check(set(launch)=={'current','processStartTicks','cmdlineSha256'} and
               set(launch['current'])=={'ref','pid','log','started_at','phase','build_id','built_at'} and
               {k:current[k]for k in launch['current']}==launch['current'] and current['ref']==identity['source'] and current['build_id']==identity['build_id'],
               'original captured R0 launch identity differs')
    base.check(not (ci.PROCESS_ROOT/current['pid']).exists(),'original launch process exists or PID was reused')
    base.check(f['failureLog']==current['log'] and ci.sha(base.read_bounded(Path(f['failureLog']),4*1024**2))==f['failureLogSha256'],'actual original failure log changed')
    base.check(prior.get('ref')==identity['previous_web_source'] and prior.get('build_id')==identity['previous_web_build'],'prior successful release differs')
    base.check(base.read_bounded(ci.SOURCE/'.next/BUILD_ID',1024).decode().strip()==identity['build_id'],'actual web build differs')
    return 'F',raw


def rejected_normal(base,ci,a,original):
    base.check(a.get('executionPolicy')==REJECTED_EXECUTION,'exact rejected normal recovery execution policy required')
    selected=a['recovery']['rejectedNormal']
    base.check(set(selected)=={'approval','approvalSha256','members'} and set(selected['members'])==REJECTED_MEMBERS,
               'exact rejected normal pre-mutation record inventory required')
    approval=Path(selected['approval']);ci.protected_private(base,approval)
    approval_bytes=base.read_bounded(approval,65536);old=json.loads(approval_bytes)
    base.check(ci.sha(approval_bytes)==selected['approvalSha256'] and
               set(old)==ci.normal_overall_fields(ci.RECOVERY.NORMAL_FIELDS,old,'activate-prepared-ci-runtime') and
               old['format']==1 and old['kind']==ci.RECOVERY.KINDS['activate-prepared-ci-runtime'] and
               old['policy']==ci.POLICY and old['target']=='alpha-staging' and old['releaseAuthorized'] is False and
               old['executionPolicy']==ci.NORMAL_EXECUTION_POLICY and old['helperSha256']!=a['helperSha256'],
               'exact earlier approved normal worker attempt required')
    shared=ci.RECOVERY.NORMAL_FIELDS-{'kind','issuedAt','expiresAt','helperSha256'}
    base.check(all(old[key]==a[key] for key in shared),'rejected normal and recovery immutable pins differ')
    leaves={}
    for name,expected in selected['members'].items():
        path=original/name;ci.protected_private(base,path)
        raw=base.read_bounded(path,1024**2)
        base.check(ci.sha(raw)==expected and ci.epoch(old['issuedAt'])<=path.stat().st_mtime<=ci.epoch(old['expiresAt']),
                   'original rejected proof bytes or authority time changed')
        leaves[name]=json.loads(raw)
    base.check(leaves['ci-runtime-started.json']=={'authorizationSha256':selected['approvalSha256'],'journeyVerified':False},
               'original normal activation marker differs')
    for index in range(3):
        fence=leaves[f'ci-runtime-fence-{index:02}.json']; native=fence.get('freshNativeIdentity',{})
        base.check(fence.get('policy')==ci.POLICY and fence.get('stage')=='R0' and fence.get('slot')=='F'+str(index) and
                   fence.get('leasePhase')=='installing' and fence.get('lastOkSha256')==old['priorLastOkSha256'] and
                   fence.get('releaseAuthorized') is False and native.get('build')==a['identity']['build_id'] and
                   native.get('pid')==a['webPid'],'original pre-mutation fence identity differs')
    audit=leaves['ci-runtime-full-audit-0.json'];runtime=audit.get('runtime',{})
    base.check(audit.get('authorizationSha256')==a['grantSha256'] and audit.get('releaseAuthorized') is False and
               runtime.get('source')==a['identity']['source'] and runtime.get('installId')==a['install']['id'] and
               runtime.get('nextBuildId')==a['identity']['build_id'] and runtime.get('fullMigrationLedgerVerified') is True,
               'original pre-mutation native audit differs')
    return REJECTED_MEMBERS


def absence(base,ci,identity,*,operation=None,authorization_sha=None,initial=False,approval=None):
    """No historical activation is invented. Only this new attempt may subsequently exist."""
    original=base.ROOT/'upgrades'/identity['source'];base.root_protected(original)
    allowed=rejected_normal(base,ci,approval,original) if approval is not None and approval['recovery']['policy']==REJECTED_POLICY else set()
    for path in original.iterdir():
        base.check(path.name in allowed or not path.name.startswith(('ci-runtime-','ci-worker-','activation-')),'prior activation marker exists')
        if path.name.startswith(('recovery-','published-recovery-','unstarted-recovery-')):
            base.check(not initial and operation is not None and path==operation,'prior recovery attempt exists')
            base.root_protected(path)
            started=path/'ci-runtime-started.json'
            if started.exists():
                ci.protected_private(base,started)
                base.check(json.loads(base.read_bounded(started,65536))=={'authorizationSha256':authorization_sha,'journeyVerified':False},'new recovery marker belongs to another authority')
    if initial:
        release=base.ROOT/'releases'/identity['source']
        base.check(not release.exists() and not release.is_symlink(),'candidate worker release already exists')
    return original


def historical_preparation(base,ci,prepared,a):
    """Immutable normal preparation/first/drain lineage; valid after the sealed directory is renamed."""
    selected=a['preparedWorker'];base.check(set(selected)=={'path','sha256'},'closed original prepared selection required')
    path=Path(selected['path']);ci.protected_private(base,path);raw=base.read_bounded(path,65536)
    base.check(ci.sha(raw)==selected['sha256'],'original prepared proof changed');proof=json.loads(raw)
    base.check(set(proof)=={'format','kind','policy','preparationApproval','preparationApprovalSha256','preparedAt','identity','archiveSha256','manifestSha256','directory','tree','preparation','releaseAuthorized'} and proof['format']==1 and proof['kind']=='ROOT_AUTHENTICATED_WORKER_PREPARATION_NOT_ACTIVATION' and proof['identity']==a['identity'] and proof['releaseAuthorized']is False,'original normal preparation required')
    approval=Path(proof['preparationApproval']);ci.protected_private(base,approval);araw=base.read_bounded(approval,65536)
    base.check(ci.sha(araw)==proof['preparationApprovalSha256'],'original preparation authority changed');old=json.loads(araw)
    p,original=prepared.closed_preparation(base,ci,old)
    fields=ci.baseline_publication_fields(prepared.PREP_FIELDS,old,allow=ci.BASELINE_PUBLICATION_KEY in a)
    base.check(set(old)==fields and old['format']==1 and old['kind']==prepared.KINDS['prepare-ci-worker'] and old['policy']==ci.POLICY and old['target']=='alpha-staging' and old['releaseAuthorized']is False and p['mode']=='normal' and p['failure']is None and proof['policy']==p['policy'] and proof['preparation']==p,'unstarted recovery requires actual normally sealed preparation')
    base.check(proof['directory']==p['directory'] and str(path)==p['proof'] and p['firstStageApproval']==a['firstStageApproval'] and p['firstStageApprovalSha256']==a['firstStageApprovalSha256'] and p['drainSha256']==a['drainSha256'],'original preparation/drain selection differs')
    ci.require_same_baseline_publication(base,old,a)
    shared=('identity','nodeSha256','python','nodeOptions','lease','leaseFile','leaseFileSha256','coordinatorSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','operationsLock')
    base.check(all(old[k]==a[k]for k in shared),'original preparation shared pins differ')
    first_path=Path(a['firstStageApproval']);ci.protected_private(base,first_path);first_raw=base.read_bounded(first_path,65536)
    base.check(ci.sha(first_raw)==a['firstStageApprovalSha256'],'historical first approval changed');first=json.loads(first_raw)
    first_fields=ci.baseline_publication_fields(ci.FIRST_APPROVAL_FIELDS,first,allow=ci.BASELINE_PUBLICATION_KEY in a)
    base.check(set(first)==first_fields and first['format']==1 and first['policy']==ci.POLICY and first['target']=='alpha-staging' and first['releaseAuthorized']is False and first['kind']=='ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS' and first['helperSha256']==old['helperSha256'] and all(first[k]==a[k]for k in shared),'original first/preparation helper lineage differs')
    ci.require_same_baseline_publication(base,first,a)
    base.check(ci.epoch(old['issuedAt'])<=ci.epoch(proof['preparedAt'])<=ci.epoch(old['expiresAt']) and ci.epoch(proof['preparedAt'])<=ci.epoch(a['issuedAt']) and ci.epoch(old['issuedAt'])<=path.stat().st_mtime<=ci.epoch(old['expiresAt']) and ci.epoch(old['expiresAt'])<=ci.epoch(old['issuedAt'])+prepared.preparation_seconds(p),'preparation was not sealed under its original bounded authority')
    drain_raw=base.read_bounded(original/'drained.json',65536);drain=json.loads(drain_raw)
    base.check(ci.sha(drain_raw)==a['drainSha256'] and drain['identity']==a['identity'] and drain['drain']['state']=='drained','original genuine drain changed')
    base.check(ci.epoch(first['issuedAt'])<=(original/'drained.json').stat().st_mtime<=ci.epoch(first['expiresAt']),'original drain outside historical authority')
    return proof


def check_history(o):
    b,c,a=o.base,o.guard.ci,o.auth
    closed_failure(b,c,o.recovery,a['identity'])
    b.check(o.recovery['failureLastOkSha256']==a['priorLastOkSha256'],'failure and original prior last-ok pins differ')
    b.check(o.operation==b.ROOT/'upgrades'/a['identity']['source']/('unstarted-recovery-'+o.recovery['id']),'fixed exclusive unstarted operation required')
    historical_preparation(b,c,c.RECOVERY,a)
    absence(b,c,a['identity'],operation=o.operation,authorization_sha=c.sha(o.bytes),approval=a)
    failure_snapshot(b,c,o.recovery,a['identity'],a['launch'])


def run(guard,fmt,base,ci,update):
    # prepared.run already holds/binds the existing root install EX and queue SH.
    a=guard.a;identity=a['identity'];closed_failure(base,ci,a['recovery'],identity)
    original=absence(base,ci,identity,initial=True,approval=a)
    historical_preparation(base,ci,ci.RECOVERY,a)
    failure_snapshot(base,ci,a['recovery'],identity,a['launch'])
    proof,directory,manifest=ci.RECOVERY.prepared_proof(base,ci,fmt,a['preparedWorker'],identity,deadline=ci.SLOT_DEADLINE,baseline_publication=a.get(ci.BASELINE_PUBLICATION_KEY))
    base.check(proof['preparation']['mode']=='normal' and ci.epoch(proof['preparedAt'])<=ci.epoch(a['issuedAt']),'actual previously sealed normal preparation required')
    operation=original/('unstarted-recovery-'+a['recovery']['id']);base.check(not operation.exists() and not operation.is_symlink(),'unstarted attempt already exists')
    args=SimpleNamespace(**identity,ci_runtime_authorization=str(guard.path),ci_runtime_authorization_sha256=ci.sha(guard.bytes))
    observer=ci.RuntimeObservation(base,fmt,args,operation,base.read_bounded(original/'drained.json',65536),recovery=a['recovery'],prepared=a['preparedWorker'])
    native=ci.child([str(base.NODE),'--env-file=.env.production','--input-type=module','-e',ci.RECOVERY.FAILED_NATIVE_PROBE,str(observer.directory)],observer.owner,observer.environment,timeout=30)
    base.check(native['kind']=='EXACT_FAILED_NATIVE_WORKER_CHECK_INSTALL' and native['source']==identity['source'] and native['installId']==a['install']['id'] and native['active']['migrationLedger']['actualSha256']==a['ledger']['actualSha256'],'actual failed native install/ledger differs')
    ci.RECOVERY.clean_prior(base,update,identity)
    guard.file_mutation();operation.mkdir(mode=0o700)
    update.publish(base,operation/'ci-runtime-started.json',fmt.canonical({'authorizationSha256':ci.sha(guard.bytes),'journeyVerified':False}),0o400)
    observer.complete_fence();observer.content_audit();observer.complete_fence();observer.full_audit();observer.complete_fence();observer.admit_mutation()
    release=base.ROOT/'releases'/identity['source']
    def publish_prepared():
        guard.file_mutation();ci.RECOVERY.clean_prior(base,update,identity)
        fresh,root,_=ci.RECOVERY.prepared_proof(base,ci,fmt,a['preparedWorker'],identity,deadline=ci.SLOT_DEADLINE,baseline_publication=a.get(ci.BASELINE_PUBLICATION_KEY))
        base.check(fresh==proof and root==directory and not release.exists(),'normal prepared publication changed')
        guard.file_mutation();os.rename(directory,release);return release
    return update.replace_and_start(base,fmt,args,operation,release,None,identity['unit_sha256'],{'manifestSha256':proof['manifestSha256'],'preparedProofSha256':a['preparedWorker']['sha256'],'previousWebSource':identity['previous_web_source'],'previousWebBuildId':identity['previous_web_build'],'previousWorkerSource':identity['previous_worker_source'],'originalInstallationGrantExpiresAt':observer.grant['expiresAt'],'workerRecoveryOnly':True,'unstartedRecoveryPolicy':a['recovery']['policy']},observer,prepare_release=publish_prepared)


def configure(ci,prepared):
    global LIVE_FIELDS
    LIVE_FIELDS=ci.ACTIVATION_FIELDS|{'preparedWorker','recovery','nativeActivation'}
