"""Fixed root invocation for the existing native staging lock. Scheduling is never approval.
Loaded into the independently hash-pinned root bundle; no mutable source imports or generic command CLI.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import time

QUEUE = Path('/var/tmp/aihr-deploy/staging-release-queue')
LOCK = QUEUE / 'operations.lock'
GUARD_POLICY = 'aihr-worker-native-operation-lock/v1'
DRAIN_ENVIRONMENT_PROBE = "import {fingerprintStagingEnvironment} from './.github/ci/staging-environment.mjs';process.stdout.write(JSON.stringify({kind:'CI_WORKER_DRAIN_ENVIRONMENT_POLICY_V1',environmentSha256:fingerprintStagingEnvironment('/opt/ai-hr'),readiness:{required:process.env.AIHR_IMPORT_WORKER_REQUIRED??null,waitSeconds:process.env.AIHR_IMPORT_WORKER_WAIT_SECONDS??null}}))"

def published_kinds(ci):return getattr(getattr(ci,'PUBLISHED',None),'KINDS',{})
def unstarted_kinds(ci):return getattr(getattr(ci,'UNSTARTED',None),'KINDS',{})


class QueueOperationLock:
    def __init__(self,base,pins):
        self.base,self.pins,self.fd,self.acquired=base,pins,None,False
        base.check(set(pins)=={'policy','queueDirectory','lockPath','uid','gid','mode','device','inode','queueMode','queueDevice','queueInode'} and
                   pins['policy']==GUARD_POLICY and pins['queueDirectory']==str(QUEUE) and pins['lockPath']==str(LOCK) and
                   type(pins['uid']) is int and pins['uid']>0 and pins['mode']==0o600 and pins['queueMode']==0o700,
                   'exact native operation lock pins required')
        self.verify_paths()
        fd=os.open(LOCK,os.O_RDWR|os.O_NOFOLLOW)  # Existing native file only. Never CREATE/replace/chown.
        try:
            self.fd=fd;self.verify(require_held=False)
            fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
            self.acquired=True;self.verify();os.set_inheritable(fd,True)
        except BaseException:
            os.close(fd);self.fd=None;raise

    def verify_paths(self):
        b,p=self.base,self.pins
        for path in [QUEUE,*QUEUE.parents]:
            st=path.lstat()
            b.check(stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and path.resolve()==path,
                    'canonical native queue directory/ancestors required')
            if path==QUEUE:
                b.check((st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_dev,st.st_ino)==
                        (p['uid'],p['gid'],p['queueMode'],p['queueDevice'],p['queueInode']),'native queue directory identity changed')
            else:
                sticky_temporary=path in (Path('/var/tmp'),Path('/tmp')) and st.st_uid==0 and bool(st.st_mode&stat.S_ISVTX)
                b.check(st.st_uid in (0,p['uid']) and (not st.st_mode&0o022 or sticky_temporary),'unreviewed writable queue ancestor')
        named=LOCK.lstat()
        b.check(stat.S_ISREG(named.st_mode) and not stat.S_ISLNK(named.st_mode) and named.st_nlink==1 and
                (named.st_uid,named.st_gid,stat.S_IMODE(named.st_mode),named.st_dev,named.st_ino)==
                (p['uid'],p['gid'],p['mode'],p['device'],p['inode']),'native operation lock path identity changed')
        return named

    def verify(self,require_held=True):
        named=self.verify_paths();self.base.check(self.fd is not None,'native operation lock is not held')
        st=os.fstat(self.fd)
        self.base.check((st.st_dev,st.st_ino,st.st_uid,st.st_gid,st.st_mode,st.st_nlink)==
                        (named.st_dev,named.st_ino,named.st_uid,named.st_gid,named.st_mode,named.st_nlink),
                        'opened native operation lock differs from its path')
        if require_held:
            self.base.check(self.acquired and any(line.split()[2:5]==['FLOCK','ADVISORY','READ'] for line in Path('/proc/self/fdinfo/'+str(self.fd)).read_text().splitlines()if line.startswith('lock:')),'native shared operation lock is not held')
        return self.fd

    def close(self):
        # Never LOCK_UN: inherited descriptors share this open-file description. Last close releases SH.
        if self.fd is not None:os.close(self.fd);self.fd=None


class GuardedInvocation:
    def __init__(self,base,ci,stage,path,pinned):
        self.base,self.ci,self.stage,self.path,self.lock=base,ci,stage,Path(path),None
        self.approval_identity=ci.protected_private(base,self.path)
        self.bytes=base.read_bounded(self.path,65536)
        base.check(ci.sha(self.bytes)==pinned,'root invocation approval hash differs')
        self.a=json.loads(self.bytes)
        fields=ci.FIRST_APPROVAL_FIELDS if stage=='drain' else ci.ACTIVATION_FIELDS if stage=='activate-ci-runtime' else ci.RECOVERY.PREP_FIELDS if stage=='prepare-ci-worker' else ci.RECOVERY.NORMAL_FIELDS if stage=='activate-prepared-ci-runtime' else ci.RECOVERY.FIELDS
        if stage in published_kinds(ci):fields=ci.PUBLISHED.SEAL_FIELDS if stage==ci.PUBLISHED.SEAL_STAGE else ci.PUBLISHED.LIVE_FIELDS
        if stage in published_kinds(ci):fields=ci.PUBLISHED.budget_fields(base,ci,fields,self.a,stage)
        if stage in unstarted_kinds(ci):fields=ci.UNSTARTED.LIVE_FIELDS
        fields=ci.normal_overall_fields(fields,self.a,stage)
        baseline_allowed=stage in('drain','activate-ci-runtime','activate-prepared-ci-runtime',*unstarted_kinds(ci))
        if stage in published_kinds(ci) and ci.PUBLISHED.unstarted_origin(ci,self.a):baseline_allowed=True
        if stage=='prepare-ci-worker'and 'baselinePublication'in self.a:
            p=self.a.get('preparation');baseline_allowed=type(p)is dict and p.get('mode')=='normal'
        fields=ci.baseline_publication_fields(fields,self.a,allow=baseline_allowed)
        kind=unstarted_kinds(ci)[stage]if stage in unstarted_kinds(ci) else published_kinds(ci)[stage]if stage in published_kinds(ci) else 'ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS' if stage=='drain' else 'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER' if stage=='activate-ci-runtime' else ci.RECOVERY.KINDS[stage]
        base.check(set(self.a)==fields and self.a['kind']==kind and self.a['policy']==ci.POLICY and self.a['format']==1 and
                   self.a['target']=='alpha-staging' and self.a['releaseAuthorized'] is False,'fixed root invocation approval differs')
        base.check(base.read_bounded(Path(sys.argv[0]),16*1024**2) and ci.sha(base.read_bounded(Path(sys.argv[0]),16*1024**2))==self.a['helperSha256'],'independently pinned helper required')
        base.root_protected(Path(sys.argv[0]),regular=True)
        self.identity=self.a['identity'];self.owner=pwd.getpwuid(self.a['operationsLock']['uid'])
        self.lease_path=Path(self.a['leaseFile']);self.lease_identity=ci.protected_private(base,self.lease_path)
        raw=base.read_bounded(self.lease_path,4096);base.check(ci.sha(raw)==self.a['leaseFileSha256'],'root-private held lease differs')
        self.lease=json.loads(raw)
        base.check(set(self.lease)=={'protocol','batch','epoch','candidate','token','releaseAuthorized'} and
                   self.lease['protocol']=='aihr-staging-queue/v1' and self.lease['releaseAuthorized'] is False and
                   self.a['lease']=={k:self.lease[k]for k in ('batch','epoch','candidate')} and self.lease['candidate']==self.identity['source'],
                   'exact approved held native lease required')
        self.environment={'PATH':'/opt/node22/bin:/usr/bin:/bin','LANG':'C.UTF-8','HOME':self.owner.pw_dir,'USER':self.owner.pw_name,'LOGNAME':self.owner.pw_name,
                          'AIHR_STAGING_NODE_GUARDED':'1','AIHR_STAGING_BATCH':self.lease['batch'],'AIHR_STAGING_EPOCH':str(self.lease['epoch']),
                          'AIHR_STAGING_CANDIDATE':self.lease['candidate'],'AIHR_STAGING_TOKEN':self.lease['token'],
                          'PYTHONNOUSERSITE':'1','PYTHONSAFEPATH':'1'}
        self.last_phase=None;self.quarantine=False;self.observer=None;self.start_sent=False;self.install_fd=None;self.install_path=None;self.install_identity=None
        # Staging SH is acquired BEFORE update.upgrade may acquire worker install EX.
        self.lock=QueueOperationLock(base,self.a['operationsLock'])
        try:self.before_mutation()
        except BaseException:
            self.lock.close()
            raise

    def verify(self):
        self.lock.verify();b,a=self.base,self.a
        b.check(self.ci.protected_private(b,self.path)==self.approval_identity and b.read_bounded(self.path,65536)==self.bytes,'root invocation approval changed')
        b.check(self.ci.protected_private(b,self.lease_path)==self.lease_identity and self.ci.sha(b.read_bounded(self.lease_path,4096))==a['leaseFileSha256'],'root invocation lease inode/content changed')
        b.check(self.ci.sha(b.read_bounded(self.ci.COORDINATOR,1024**2))==a['coordinatorSha256'],'native coordinator bytes changed')
        self.ci.verify_python(b,a['python'])
        self.ci.verify_node_options_pins(b,a['nodeOptions'])
        b.root_protected(b.NODE,regular=True)
        b.check(self.ci.bounded_file_sha256(b,b.NODE,128*1024**2)==a['nodeSha256'],'independently approved Node bytes changed')
        return self.lock.fd

    def bind_install(self,fd,path):
        self.verify();self.base.root_protected(path,regular=True)
        opened=os.fstat(fd);named=Path(path).lstat()
        self.base.check(opened.st_uid==0 and stat.S_IMODE(opened.st_mode)==0o600 and opened.st_nlink==1 and
                        (opened.st_dev,opened.st_ino)==(named.st_dev,named.st_ino),'root install lock differs')
        self.install_fd,self.install_path,self.install_identity=fd,Path(path),(opened.st_dev,opened.st_ino)
        self.verify_install()
        self.base.VERIFIED_OPERATION_FDS=self.inherited_fds()

    def verify_install(self):
        self.verify();self.base.check(self.install_fd is not None,'worker install EX is not held')
        self.base.root_protected(self.install_path,regular=True)
        st=os.fstat(self.install_fd);named=self.install_path.lstat()
        self.base.check((st.st_dev,st.st_ino)==self.install_identity==(named.st_dev,named.st_ino) and
                        any(line.split()[2:5]==['FLOCK','ADVISORY','WRITE']for line in Path('/proc/self/fdinfo/'+str(self.install_fd)).read_text().splitlines()if line.startswith('lock:')),'worker install EX identity/ownership changed')

    def inherited_fds(self):
        # Both descriptions remain locked in direct authority/mutation children after parent death.
        self.verify()
        if self.install_fd is None:return (self.lock.fd,)
        self.verify_install()
        return (self.lock.fd,self.install_fd)

    def native_lease(self):
        fd=self.verify()
        held=self.ci.child(['/usr/bin/python3',str(self.ci.COORDINATOR)],self.owner,self.environment,
                           input=json.dumps({'protocol':'aihr-staging-queue/v1','action':'assert','actor':'root-worker-operation',**self.lease}),timeout=15,operation_fd=fd)
        allowed=('claimed',)if self.stage=='drain' or self.stage=='prepare-ci-worker' and self.a['preparation'].get('mode')=='normal' else ('installing',) if self.stage in ('prepare-ci-worker','recover-ci-runtime',*published_kinds(self.ci),*unstarted_kinds(self.ci)) else ('installing','arrived')
        self.base.check(held.get('releaseAuthorized') is False and all(held.get(k)==self.a['lease'][k]for k in self.a['lease']) and held.get('phase')in allowed,'fixed root operation native lease differs')
        self.base.check(self.last_phase!='arrived' or held['phase']=='arrived','native lease backslid')
        self.last_phase=held['phase'];return held

    def before_mutation(self):
        self.verify();a=self.a;b=self.base
        if self.install_fd is not None:self.verify_install()
        b.check(self.ci.epoch(a['issuedAt'])<=time.time()<self.ci.epoch(a['expiresAt']),'root invocation authority expired')
        b.check(self.ci.sha(b.read_bounded(self.ci.SOURCE/'.env.production',1024**2))==a['dotenvSha256'] and
                self.ci.sha(b.read_bounded(b.ENV,1024**2))==self.identity['worker_env_sha256'],'approved web/worker environment changed')
        self.ci.assert_python_runtime(b,self.owner,self.environment,a['python'])
        if self.stage=='drain':
            observed=self.ci.child([str(b.NODE),'--env-file=.env.production','--input-type=module','-e',DRAIN_ENVIRONMENT_PROBE],self.owner,self.environment,timeout=30,operation_fd=self.lock.fd,node_options=a['nodeOptions'])
            b.check(observed=={'kind':'CI_WORKER_DRAIN_ENVIRONMENT_POLICY_V1','environmentSha256':a['environmentSha256'],'readiness':a['readiness']},'actual native drain environment/readiness differs')
        held=self.native_lease()
        if 'baselinePublication' in a:
            self.ci.verify_baseline_publication(b,a,paired=self.stage in('drain','prepare-ci-worker'))
        overall=(self.stage in ('activate-prepared-ci-runtime','recover-unstarted-ci-runtime') and self.ci.normal_overall_budget(a,self.stage) is not None) or (a.get('executionPolicy')=='aihr-worker-published-prestart-overall/v1' and self.ci.PUBLISHED.overall_selected(self.ci,a,self.stage))
        if overall and self.observer is not None and not getattr(self.ci,'FAILURE_CLEANUP_ONLY',False):
            self.observer.fresh_native_identity()  # Fresh owner proof AFTER expensive guards, immediately before action.
        b.check(self.ci.epoch(a['issuedAt'])<=time.time()<self.ci.epoch(a['expiresAt']),'root invocation authority expired before mutation')
        return held

    def file_mutation(self,*,failure_only=False):
        # Call immediately before publishing an owned file/unit/success record, not before preparing bytes.
        self.verify_install()
        if failure_only:
            self.base.check(self.observer is not None,'failure-only owned-start proof required')
            self.observer.quarantine_fence()
            return
        self.before_mutation()

    def close(self):
        if self.lock:self.lock.close()


def preparation_initial_seconds(base,ci,path,pinned):
    # Select only the reviewed normal-v2 ceiling from the EXACT protected approval.
    # This grants no authority: GuardedInvocation still validates every field and
    # re-reads these same hash-pinned bytes before acquiring/mutating anything.
    path=Path(path);ci.protected_private(base,path);raw=base.read_bounded(path,65536)
    base.check(ci.sha(raw)==pinned,'root invocation approval hash differs')
    record=json.loads(raw);p=record.get('preparation')if isinstance(record,dict)else None
    return 600 if isinstance(p,dict) and p.get('policy')=='aihr-worker-prepared-handoff/v2' and p.get('mode')=='normal' else 300


def normal_overall_approval(base,ci,path,pinned,stage):
    if stage not in ('activate-prepared-ci-runtime','recover-unstarted-ci-runtime'):return None
    path=Path(path)
    ci.protected_private(base,path)
    raw=base.read_bounded(path,65536)
    base.check(ci.sha(raw)==pinned,'normal timing approval hash differs')
    approval=json.loads(raw)
    seconds=ci.normal_overall_budget(approval,stage)
    if seconds is None:return None
    now=time.time();issued=ci.epoch(approval['issuedAt']);expires=ci.epoch(approval['expiresAt'])
    base.check(issued<=now<expires<=issued+seconds,'normal timing approval expired or exceeds its fixed ceiling')
    return raw,seconds


def launch(argv,fmt,base,ci,update):
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['guarded-drain','guarded-activate-ci-runtime','guarded-prepare-ci-worker','guarded-activate-prepared-ci-runtime','guarded-recover-ci-runtime','guarded-seal-published-ci-worker','guarded-recover-published-ci-runtime','guarded-recover-unstarted-ci-runtime'])
    parser.add_argument('--approval',required=True);parser.add_argument('--approval-sha256',required=True)
    args=parser.parse_args(argv);base.check(os.geteuid()==0,'fixed root launcher must run after the privilege boundary')
    stage=args.mode.removeprefix('guarded-')
    guard=None;previous=base.command;previous_fds=getattr(base,'VERIFIED_OPERATION_FDS',());previous_guard=getattr(base,'VERIFIED_OPERATION_GUARD',None)
    previous_deadline=getattr(base,'VERIFIED_OPERATION_DEADLINE',None);previous_slot=getattr(ci,'SLOT_DEADLINE',None);previous_overall=getattr(base,'RECOVERY_OVERALL_DEADLINE',None)
    previous_execution=getattr(ci,'OVERALL_EXECUTION_DEADLINE',None);previous_failure=getattr(ci,'FAILURE_CLEANUP_ONLY',False)
    previous_base_execution=getattr(base,'OVERALL_EXECUTION_DEADLINE',None);previous_base_failure=getattr(base,'OVERALL_EXECUTION_FAILURE_ONLY',False)
    execution_started=time.monotonic()
    normal_approval=normal_overall_approval(base,ci,args.approval,args.approval_sha256,stage)
    published_overall=stage=='recover-published-ci-runtime' and ci.PUBLISHED.initial_overall_selection(base,ci,args.approval,args.approval_sha256,stage)
    overall=normal_approval is not None or published_overall
    if overall:
        selection_bytes=normal_approval[0] if normal_approval is not None else base.read_bounded(Path(args.approval),65536)
        base.check(ci.sha(selection_bytes)==args.approval_sha256,'overall selection changed before admission')
        authority_end=time.monotonic()+(ci.epoch(json.loads(selection_bytes)['expiresAt'])-time.time())
        budget=normal_approval[1] if normal_approval is not None else ci.PUBLISHED.OVERALL_SECONDS
        end=min([execution_started+budget,authority_end,*[v for v in (previous_deadline,previous_slot,previous_overall,previous_execution)if v is not None]])
        ci.OVERALL_EXECUTION_DEADLINE=end;ci.FAILURE_CLEANUP_ONLY=False;base.OVERALL_EXECUTION_DEADLINE=end;base.OVERALL_EXECUTION_FAILURE_ONLY=False
        base.RECOVERY_OVERALL_DEADLINE=end
    elif stage in ('activate-prepared-ci-runtime','recover-ci-runtime','recover-published-ci-runtime','recover-unstarted-ci-runtime'):base.RECOVERY_OVERALL_DEADLINE=min(time.monotonic()+827,previous_overall if previous_overall is not None else float('inf'))
    if stage in ('activate-ci-runtime','prepare-ci-worker','activate-prepared-ci-runtime','recover-ci-runtime',*published_kinds(ci),*unstarted_kinds(ci)):
        initial_started=time.monotonic()
        initial_seconds=preparation_initial_seconds(base,ci,args.approval,args.approval_sha256)if stage=='prepare-ci-worker'else 300 if stage=='seal-published-ci-worker'else 30
        initial_deadline=base.RECOVERY_OVERALL_DEADLINE if overall else min([initial_started+initial_seconds,*[value for value in (previous_deadline,previous_slot)if value is not None]])
        base.VERIFIED_OPERATION_DEADLINE=initial_deadline;ci.SLOT_DEADLINE=initial_deadline
    try:
        guard=GuardedInvocation(base,ci,stage,args.approval,args.approval_sha256)
        ci.ACTIVE_OPERATION_GUARD=guard;base.VERIFIED_OPERATION_GUARD=guard;base.VERIFIED_OPERATION_FDS=(guard.lock.fd,)
        def fenced_command(command,**options):
            guard.verify()
            # The verified EX appears after upgrade acquires it; never inherit a stale/closed fd.
            base.VERIFIED_OPERATION_FDS=guard.inherited_fds()
            mutating=len(command)>1 and command[0]=='/usr/bin/systemctl' and command[1]in ('kill','start','stop','daemon-reload','disable','enable')
            if mutating:
                if guard.quarantine:
                    base.check(guard.observer is not None,'owned quarantine proof missing');guard.observer.quarantine_fence()
                else:guard.before_mutation()
            if command==['/usr/bin/systemctl','start','aihr-bank-import.service'] and stage in ('activate-ci-runtime','activate-prepared-ci-runtime','recover-ci-runtime','recover-published-ci-runtime','recover-unstarted-ci-runtime'):guard.start_sent=True;guard.observer.start_requested()
            return previous(command,**options)
        base.command=fenced_command
        # A fixed target phase and original managed arguments, never a user-supplied executable or command.
        names=('previous-worker-source','source','build-id','archive','archive-sha256','lock-sha256','package-sha256','worker-env-sha256','previous-web-source','previous-web-build','unit-sha256')
        expected={name.replace('-','_')for name in names}
        base.check(set(guard.identity)in(expected,expected|{'previous_worker_env_sha256'}),'closed original managed invocation required')
        managed=[stage,*[part for name in names for part in ('--'+name,guard.identity[name.replace('-','_')])]]
        if 'previous_worker_env_sha256'in guard.identity:managed+=['--previous-worker-env-sha256',guard.identity['previous_worker_env_sha256']]
        if stage=='activate-ci-runtime':managed+=['--ci-runtime-authorization',str(guard.path),'--ci-runtime-authorization-sha256',args.approval_sha256]
        if stage in ('prepare-ci-worker','activate-prepared-ci-runtime','recover-ci-runtime',*published_kinds(ci),*unstarted_kinds(ci)):
            ci.RECOVERY.run(stage,guard,fmt,base,ci,update)
        else:update.upgrade(managed,fmt,base,ci)
    finally:
        base.command=previous;base.VERIFIED_OPERATION_FDS=previous_fds;base.VERIFIED_OPERATION_GUARD=previous_guard;base.VERIFIED_OPERATION_DEADLINE=previous_deadline;base.RECOVERY_OVERALL_DEADLINE=previous_overall;ci.SLOT_DEADLINE=previous_slot;ci.ACTIVE_OPERATION_GUARD=None
        ci.OVERALL_EXECUTION_DEADLINE=previous_execution;ci.FAILURE_CLEANUP_ONLY=previous_failure;base.OVERALL_EXECUTION_DEADLINE=previous_base_execution;base.OVERALL_EXECUTION_FAILURE_ONLY=previous_base_failure
        if guard:guard.close()
