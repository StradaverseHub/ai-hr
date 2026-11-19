"""Native upgrade spine with real files/hashes and deterministic systemd/proc/native-command ports. Hosted only."""
import contextlib
import fcntl
import stat
import shutil
from contextlib import ExitStack
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
old=ModuleType('managed_worker_fixture');old.__file__=str(ROOT/'test/fixtures/bank-import-worker-upgrade-tests.py')
exec(Path(old.__file__).read_text().rsplit('\nunittest.main()',1)[0],old.__dict__)
update=old.update
spec=importlib.util.spec_from_file_location('ci_runtime',ROOT/'deploy/systemd/bank_import_worker_ci_runtime_v1.py')
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
check=old.check
def load_native(name, filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'deploy/systemd'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
guard=load_native('operation_guard_fixture','bank_import_worker_operation_guard_v1.py')
fences=load_native('complete_fences_fixture','bank_import_worker_fences_v1.py')
cleanup_spec=importlib.util.spec_from_file_location('owned_cleanup_fixture',ROOT/'.github/ci/cleanup-install.py')
owned_cleanup=importlib.util.module_from_spec(cleanup_spec);cleanup_spec.loader.exec_module(owned_cleanup)
activation_spec=importlib.util.spec_from_file_location('native_build_activation_fixture',ROOT/'.github/ci/build-activate.py')
native_activation=importlib.util.module_from_spec(activation_spec);activation_spec.loader.exec_module(native_activation)
# Import immutable build/runtime contract data from its actual native owner, not a copied selector schema.
contract=subprocess.run(['node','--input-type=module','-e',"import {STAGING_BUILD_RUNTIME,BUILD_CAPACITY_PROFILE} from './.github/ci/build-production.mjs';console.log(JSON.stringify({runtime:STAGING_BUILD_RUNTIME,capacity:BUILD_CAPACITY_PROFILE}))"],cwd=ROOT,capture_output=True,text=True,check=True)
NATIVE_CONTRACT=json.loads(contract.stdout)
PYTHON_PATH=Path('/usr/bin/python3').resolve(strict=True)
PYTHON_PINS={'path':str(PYTHON_PATH),'sha256':hashlib.sha256(PYTHON_PATH.read_bytes()).hexdigest(),'version':subprocess.run([str(PYTHON_PATH),'-c','import sys;print(".".join(map(str,sys.version_info[:3])))'],capture_output=True,text=True,check=True).stdout.strip()}

def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()+b'\n'

class Fixture(old.UpgradeFlowFixture):
    def __init__(self,root):
        super().__init__(root)
        self.invoke('drain');os.utime(self.operation/'drained.json',(1794873602,1794873602));self.web=self.source;self.native_calls=0;self.finish_at=None;self.fault_at=None;self.native_fault=None;self.held_phase='installing';self.arrive_at=None;self.cleanup_at=None;self.lease_backslide_at=None;self.probe_override=None;self.fast_calls=0;self.finish_on=None;self.clock=1794873610;self.advance_at=None;self.advance_seconds=0;self.native_failure_at=None;self.final_native_fault=None;self.monotonic_offset=0;self.deadline_at=None;self.stability_overrun=False;self.observe_cleanup=False;self.cleanup_observations=[];self.cleanup_intent_fault=None;self.partial_ready_at=None;self.pending_publication=None;self.pending_defect=None;self.publication_sleeps=0;self.cache_fault=None
        self.webroot=root/'web';self.webroot.mkdir();(self.webroot/'.next').mkdir();(self.webroot/'.next/BUILD_ID').write_text(self.new_build)
        (self.webroot/'node_modules').mkdir();(self.webroot/'node_modules/dependency.js').write_text('frozen dependency')
        self.runtime_root=root/'runtime';(self.runtime_root/'bin').mkdir(parents=True);self.node.rename(self.runtime_root/'bin/node');self.node=self.runtime_root/'bin/node';self.base.NODE=self.node
        (self.webroot/'.env.production').write_text('AIHR_IMPORT_WORKER_REQUIRED=1\n')
        for name in ['scripts/improve/release.ts','.github/ci/normal-cleanup-fences.mjs']:
            p=self.webroot/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((ROOT/name).read_bytes())
        for i in range(105):(self.webroot/('source-%03d'%i)).write_text('frozen '+str(i))
        self.state=root/'state';self.state.mkdir();self.coordinator=self.state/'coordinator.py';self.coordinator.write_text('fixed coordinator port fixture')
        self.boot=root/'boot';self.boot.write_text('same original boot')
        self.proc=root/'proc';p=self.proc/'777';p.mkdir(parents=True);p.joinpath('stat').write_text('777 (original deploy) '+' '.join(['S']+['0']*18+['444']))
        p.joinpath('cmdline').write_bytes(b'/bin/bash\0/opt/ai-hr/deploy/deploy.sh\0')
        self.current={'ref':self.source,'pid':'777','log':'/private/original-deploy.log','started_at':'2026-11-17T00:00:00Z','phase':'ci-build-health','result':'','exit_code':'','build_id':self.new_build,'built_at':'2026-11-17T00:01:00Z'}
        self.prior={'ref':self.previous_web,'pid':'666','log':'/private/previous-deploy.log','started_at':'2026-11-16T00:00:00Z','phase':'restart','result':'','exit_code':'0','build_id':self.old_build,'built_at':'2026-11-16T00:01:00Z','finished_at':'2026-11-16T00:02:00Z'}
        self.write_records()
        self.home=root/'owner';self.home.mkdir(mode=0o700);parent=self.home/'.aihr-ci-builds';parent.mkdir(mode=0o700)
        self.install_id='12345678-1234-4123-8123-123456789abc';self.build_record='22345678-1234-4123-8123-123456789abc'
        self.directory=parent/self.install_id;self.directory.mkdir(mode=0o700);(self.directory/'packet').mkdir(mode=0o700)
        uid=self.directory.stat().st_uid;self.owner=SimpleNamespace(pw_uid=uid,pw_gid=self.directory.stat().st_gid,pw_dir=str(self.home),pw_name='installation-owner')
        self.grant={'kind':'OPERATOR_AUTHORIZED_STAGING_CI_BUILD_INSTALL','format':2,'target':'alpha-staging','installId':self.install_id,'source':self.source,'controller':'3'*40,'runId':77,'baseline':self.previous_web,'baselineBuildId':self.old_build,'environmentSha256':'c'*64,'expiresAt':'2099-01-01T00:00:00Z','build':{'buildRecordId':self.build_record,'nextBuildId':self.new_build,'lockSha256':'a'*64,'packageSha256':'b'*64}}
        self.grant.update(policyVersion='aihr-staging-ci/v17',controllerBranch='alpha',runAttempt=1,runCreatedAt='2026-11-17T00:00:00Z',issuedAt='2026-11-17T00:00:00Z',expiresAt='2026-11-17T00:30:00Z',producerStartedAt='2026-11-17T00:00:00Z',producerCompletedAt='2026-11-17T00:00:00Z',witnessFingerprint='9'*64,artifact={'digest':'sha256:'+'8'*64,'id':1})
        self.grant['build'].update(format=2,capacityProfile=copy.deepcopy(NATIVE_CONTRACT['capacity']),buildSourcePath='/frozen',runtime=copy.deepcopy(NATIVE_CONTRACT['runtime']),provenanceSha256='1'*64,archiveSha256='2'*64,archiveBytes=1,manifestSha256='3'*64,preparedSha256='4'*64,successfulObservationSha256='5'*64)
        (self.directory/'next').mkdir(mode=0o700);(self.directory/'next/BUILD_ID').write_text(self.old_build)
        # Exercise the actual Linux atomic exchange producer and retain BOTH records.
        (self.webroot/'.next/BUILD_ID').write_text(self.old_build)
        (self.webroot/'.next').chmod(0o755)
        (self.directory/'next/BUILD_ID').write_text(self.new_build)
        with patch.object(native_activation.time,'time_ns',return_value=self.clock*10**9):
            activation=native_activation.activate(self.directory/'next',self.webroot,self.new_build,self.old_build)
        self.activated={'activation':activation,'kind':'CI_BUILD_BYTES_ACTIVATED_NOT_FULL_ARRIVAL','source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'bootIdSha256':ci.sha(self.boot.read_bytes())}
        self.verified={'format':1,'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build}
        for name,key in [('system-testing.json','preparedSha256'),('successful-build.json','successfulObservationSha256'),('build-provenance.json','provenanceSha256'),('bytes/build-bundle-files.json','manifestSha256')]:
            leaf=self.directory/'packet'/name;leaf.parent.mkdir(mode=0o700,parents=True,exist_ok=True);leaf.write_bytes(encoded({'nativeFixtureRecord':name,'source':self.source}));leaf.chmod(0o600);self.grant['build'][key]=ci.sha(leaf.read_bytes())
        self.ledger={'format':1,'kind':'READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE','rows':919,'expectedSha256':'d'*64,'actualSha256':'e'*64,'releaseAuthorized':False}
        self.runtime={'kind':'CI_BUILD_ACTIVE_SERVICE_VERIFIED_NOT_FULL_ARRIVAL','format':1,'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':ci.sha(encoded(self.grant)),'pid':'999','startedMonotonicUs':2000000,'healthStatus':200,'fullMigrationLedgerVerified':True,'fullSourceChecksumVerified':False,'releaseAuthorized':False,'migrationLedger':{**self.ledger,'verifiedAt':'2026-11-17T00:00:00.000Z'},'compiledByteInventory':{'format':2,'files':12000},'verifiedAt':'2026-11-17T00:00:00.000Z'}
        for name,value in [('authorization.json',self.grant),('activated.json',self.activated),('runtime.json',self.runtime),('verified.json',self.verified)]:
            (self.directory/name).write_bytes(encoded(value));(self.directory/name).chmod(0o600)
        self.lease={'protocol':'aihr-staging-queue/v1','batch':'32345678-1234-4123-8123-123456789abc','epoch':4,'candidate':self.source,'token':'f'*64,'releaseAuthorized':False}
        self.leasefile=root/'lease.json';self.leasefile.write_bytes(encoded(self.lease));self.leasefile.chmod(0o600)
        filters=ci.canonical_filters(self.base,self.webroot)
        manifest={'format':1,'kind':'CANONICAL_FROZEN_SOURCE_CONTENT_INVENTORY','policy':ci.POLICY,'source':self.source,'filters':filters,'entries':ci.source_inventory(self.base,self.webroot,filters),'releaseSha256':ci.sha((self.webroot/'scripts/improve/release.ts').read_bytes()),'filterOwnerSha256':ci.sha((self.webroot/'.github/ci/normal-cleanup-fences.mjs').read_bytes())}
        self.source_manifest_file=root/'source-manifest.json';self.source_manifest_file.write_bytes(encoded(manifest))
        self.helper=root/'protected-bundle.py';self.helper.write_text('independently reviewed root bundle fixture')
        self.authorization=root/'activation-authorization.json'
        drain=(self.operation/'drained.json').read_bytes();st=self.directory.stat()
        self.auth={'format':1,'kind':'ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER','policy':ci.POLICY,'target':'alpha-staging','issuedAt':'2026-11-17T00:00:05Z','expiresAt':'2026-11-17T00:15:05Z','identity':json.loads(drain)['identity'],'drainSha256':ci.sha(drain),'helperSha256':ci.sha(self.helper.read_bytes()),'nodeSha256':ci.sha(self.node.read_bytes()),'install':{'id':self.install_id,'buildRecordId':self.build_record,'runId':77,'controller':'3'*40,'directory':str(self.directory),'uid':uid,'gid':self.owner.pw_gid,'device':st.st_dev,'inode':st.st_ino},'grantSha256':ci.sha(encoded(self.grant)),'activatedSha256':ci.sha(encoded(self.activated)),'runtimeSha256':ci.sha(encoded(self.runtime)),'environmentSha256':'c'*64,'dotenvSha256':ci.sha((self.webroot/'.env.production').read_bytes()),'ledger':self.ledger,'bootIdSha256':ci.sha(self.boot.read_bytes()),'webPid':'999','webStartedMonotonicUs':2000000,'lease':{k:self.lease[k]for k in ['batch','epoch','candidate']},'leaseFile':str(self.leasefile),'leaseFileSha256':ci.sha(self.leasefile.read_bytes()),'coordinatorSha256':ci.sha(self.coordinator.read_bytes()),'sourceManifest':str(self.source_manifest_file),'sourceManifestSha256':ci.sha(self.source_manifest_file.read_bytes()),'priorLastOkSha256':ci.sha((self.state/'last-ok').read_bytes()),'launch':{'current':{k:v for k,v in self.current.items()if k not in ['result','exit_code','finished_at']},'processStartTicks':'444','cmdlineSha256':ci.sha(p.joinpath('cmdline').read_bytes())},'releaseAuthorized':False,'readiness':{'required':'1','waitSeconds':None}}
        self.queue=root/'queue';self.queue.mkdir(mode=0o700);self.queue_lock=self.queue/'operations.lock';self.queue_lock.write_bytes(b'');self.queue_lock.chmod(0o600)
        q=self.queue.stat();lock=self.queue_lock.stat()
        self.operations_lock={'policy':guard.GUARD_POLICY,'queueDirectory':str(self.queue),'lockPath':str(self.queue_lock),'uid':q.st_uid,'gid':q.st_gid,'mode':0o600,'device':lock.st_dev,'inode':lock.st_ino,'queueMode':0o700,'queueDevice':q.st_dev,'queueInode':q.st_ino}
        self.auth['operationsLock']=self.operations_lock;self.auth['python']=copy.deepcopy(PYTHON_PINS);self.auth['nodeOptions']={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(b'')}
        original_protected=self.base.root_protected
        def protected(path,regular=False):
            if Path(path)==PYTHON_PATH:
                st=PYTHON_PATH.lstat();check(stat.S_ISREG(st.st_mode)and st.st_uid==0 and not st.st_mode&0o022,'real root Python executable required');return
            return original_protected(path,regular=regular)
        self.base.root_protected=protected
        self.firstfile=root/'original-pre-drain-approval.json'
        self.first={'format':1,'kind':'ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS','policy':ci.POLICY,'target':'alpha-staging','issuedAt':'2026-11-17T00:00:00Z','expiresAt':'2026-11-17T00:00:04Z',**{k:self.auth[k]for k in ['identity','helperSha256','nodeSha256','lease','leaseFileSha256','sourceManifestSha256','environmentSha256','dotenvSha256','readiness','operationsLock','leaseFile','coordinatorSha256','python','nodeOptions']},'gate':{k:self.grant[k]for k in ['source','controller','runId','build','artifact','witnessFingerprint','policyVersion']},'releaseAuthorized':False}
        self.firstfile.write_bytes(encoded(self.first));self.firstfile.chmod(0o600);self.auth.update(firstStageApproval=str(self.firstfile),firstStageApprovalSha256=ci.sha(self.firstfile.read_bytes()))
        self.store={'format':1,'installId':self.install_id,'directory':{'device':st.st_dev,'inode':st.st_ino},'packetDirectory':{'device':st.st_dev,'inode':(self.directory/'packet').stat().st_ino}}
        (self.directory/'store.json').write_bytes(encoded(self.store));(self.directory/'store.json').chmod(0o600)
        self.persist_authority()
    def persist_authority(self):self.authorization.write_bytes(encoded(self.auth));self.authorization.chmod(0o600)
    def write_records(self):
        for name,value in [('current',self.current),('last-ok',self.prior)]:
            (self.state/name).write_text(''.join(k+'='+str(v)+'\n'for k,v in value.items()))
    def finish(self,phase='O'):
        self.current.update(exit_code='0',finished_at='2026-11-17T00:03:00Z');self.prior=dict(self.current)
        if phase=='O':self.current['result']='ok'
        self.write_records()
    def begin_cleanup(self):
        self.finish()
        # External native normal-session ordering: retain exact original audit bytes, READY,
        # checksum COMMIT, authorization, consumed nonce, owned deletion, result, then arrived.
        self.private_record('normal-cleanup.lock',{'source':self.source,'installId':self.install_id,'pid':777});self.observe_native_cleanup('lock-held')
        self.retain_audit_native()
        self.observe_native_cleanup('original-audit-retained')
        selection={'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':self.auth['grantSha256']}
        ready={'format':1,'kind':'NORMAL_VALID_GRANT_CLEANUP_READY','selection':selection,'nonce':'a'*64,'fencesSha256':'b'*64,'readyAt':'2026-11-17T00:00:08.000Z'}
        proof={'format':1,'kind':'OPERATOR_OBSERVED_SOURCE_CHECKSUM_FOR_OWNED_CLEANUP',**selection,'witnessFingerprint':self.grant['witnessFingerprint'],'outputSha256':ci.sha(b''),'checkedAt':'2026-11-17T00:00:08.999Z'}
        commit={'format':1,'kind':'NORMAL_VALID_GRANT_CLEANUP_COMMIT','readySha256':ci.sha(ci.canonical(ready)),'nonce':ready['nonce'],'proof':proof}
        authority={'format':1,'kind':'OWNED_CI_INSTALL_CLEANUP_AFTER_VERIFIED_ARRIVAL','sourceDirectory':str(self.webroot),**selection,'witnessFingerprint':self.grant['witnessFingerprint'],'directory':self.store['directory'],'activeDirectory':self.activated['activation']['activeDirectory'],'retainedDirectory':self.activated['activation']['retainedDirectory'],'packetDirectory':self.store['packetDirectory'],'sourceProof':proof,'sourceProofSha256':ci.sha(ci.canonical(proof)),'authorizedAt':'2026-11-17T00:00:09.000Z'}
        for name,value in [('normal-cleanup-ready.json',ready),('normal-cleanup-commit.json',commit),('cleanup-authorized.json',authority),('normal-cleanup-consumed.json',{'kind':'NORMAL_CLEANUP_NONCE_CONSUMED','readySha256':ci.sha(ci.canonical(ready))})]:
            self.private_record(name,value);self.observe_native_cleanup(name)
        if self.cleanup_intent_fault:
            intent={'format':1,'kind':'OWNED_INSTALL_CLEANUP_INTENT','authoritySha256':ci.sha((self.directory/'cleanup-authorized.json').read_bytes()),'directory':self.store['directory'],'children':['next','packet']}
            if self.cleanup_intent_fault=='hash':intent['authoritySha256']='0'*64
            if self.cleanup_intent_fault=='directory':intent['directory']={**intent['directory'],'inode':intent['directory']['inode']+1}
            if self.cleanup_intent_fault=='child-order':intent['children']=['packet','next']
            self.private_record('cleanup-intent.json',intent)
        original_publish=owned_cleanup.publish;original_remove=shutil.rmtree
        def publish(fd,name,value):
            original_publish(fd,name,value);self.observe_native_cleanup(name)
        def remove(name,*args,**kwargs):
            original_remove(name,*args,**kwargs);self.observe_native_cleanup('removed-'+str(name))
        # Actual descriptor-relative native intent/identity/deletion/result owner, not copied cleanup logic.
        remove.avoids_symlink_attacks=original_remove.avoids_symlink_attacks
        with patch.object(owned_cleanup,'publish',side_effect=publish),patch.object(owned_cleanup.shutil,'rmtree',remove):
            result=owned_cleanup.cleanup_install(str(self.directory),str(self.webroot))
        self.private_record('normal-cleanup-owned-cleanup.json',result);self.observe_native_cleanup('normal-session-result')
        (self.directory/'normal-cleanup.lock').unlink();self.observe_native_cleanup('lock-released');self.held_phase='arrived'
    def retain_audit_native(self):
        # The actual native retain owner checks the retained baseline and copies exact wx audit records.
        program="import{readFileSync}from'node:fs';import{join}from'node:path';import{retainNormalCleanupAudit}from'./.github/ci/staging-build-install.mjs';const d=process.argv[1];retainNormalCleanupAudit({directory:d,packet:join(d,'packet'),next:join(d,'next'),grant:JSON.parse(readFileSync(join(d,'authorization.json')))},JSON.parse(readFileSync(join(d,'activated.json'))));"
        subprocess.run(['node','--input-type=module','-e',program,str(self.directory)],cwd=ROOT,capture_output=True,text=True,check=True,timeout=15)
    def start_partial_ready(self):
        self.finish();self.private_record('normal-cleanup.lock',{'source':self.source,'installId':self.install_id,'pid':777});self.retain_audit_native()
        selection={'source':self.source,'installId':self.install_id,'buildRecordId':self.build_record,'nextBuildId':self.new_build,'authorizationSha256':self.auth['grantSha256']}
        ready={'format':1,'kind':'NORMAL_VALID_GRANT_CLEANUP_READY','selection':selection,'nonce':'a'*64,'fencesSha256':'b'*64,'readyAt':'2026-11-17T00:00:08.000Z'}
        raw=encoded(ready);leaf=self.directory/'normal-cleanup-ready.json';fd=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);split=len(raw)//2;os.write(fd,raw[:split]);self.pending_publication=(fd,raw[split:])
    def sleep_port(self,seconds):
        if self.stability_overrun and seconds==4:self.monotonic_offset+=25
        if self.pending_publication and seconds==.02:
            self.publication_sleeps+=1
            if self.pending_defect=='deadline':self.monotonic_offset+=21;return
            if self.pending_defect=='lease':self.held_phase='accepting';return
            fd,tail=self.pending_publication;os.write(fd,tail);os.fsync(fd);os.close(fd);self.pending_publication=None
    def observe_native_cleanup(self,stage):
        if self.observe_cleanup:
            observed=ci.ACTIVE_OPERATION_GUARD.observer.private_fence()
            self.cleanup_observations.append({'stage':stage,'members':observed['members'],'removed':observed['removed']})
    def private_record(self,name,value):
        leaf=self.directory/name;leaf.write_bytes(encoded(value));leaf.chmod(0o600)
    def boundary(self,kind,count):
        if self.finish_on==(kind,count) or kind=='fast' and self.finish_at==count:self.finish()
        if kind!='fast':return
        if self.cache_fault and count==6:
            if self.cache_fault=='cache-child':(self.webroot/'.next/cache/new-child').mkdir();(self.webroot/'.next/cache/new-child/data').write_text('legitimate runtime cache')
            if self.cache_fault=='compiled-sibling':(self.webroot/'.next/server.js').write_text('changed compiled bytes')
            if self.cache_fault=='cache-replaced':
                shutil.rmtree(self.webroot/'.next/cache');(self.webroot/'.next/cache').mkdir(mode=0o700)
        if self.partial_ready_at==count:self.start_partial_ready()
        if self.advance_at==count:self.clock+=self.advance_seconds
        if self.deadline_at==count:self.monotonic_offset+=21
        if self.arrive_at==count:self.finish();self.held_phase='arrived'
        if self.lease_backslide_at==count:self.held_phase='installing'
        if self.cleanup_at==count:self.begin_cleanup()
        if self.fault_at==count:
            if self.native_fault=='failed':self.current['result']='failed';self.write_records()
            elif self.native_fault=='source':(self.webroot/'source-000').write_text('drift after launch')
            elif self.native_fault=='lease-inode':
                p=self.root/'replacement-lease';p.write_bytes(self.leasefile.read_bytes());p.chmod(0o600);os.replace(p,self.leasefile)
            elif self.native_fault=='backslide':self.current.update(result='',exit_code='');self.current.pop('finished_at',None);self.prior={'ref':self.previous_web,'pid':'666','log':'/private/previous-deploy.log','started_at':'2026-11-16T00:00:00Z','phase':'restart','result':'','exit_code':'0','build_id':self.old_build,'built_at':'2026-11-16T00:01:00Z','finished_at':'2026-11-16T00:02:00Z'};self.write_records()
    def timestamp(self):return ci.datetime.fromtimestamp(self.clock,ci.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    def native(self,argv,identity,environment,**options):
        check(identity.pw_uid==self.owner.pw_uid and identity.pw_uid>0,'native command did not drop root')
        check(environment['HOME']==str(self.home) and environment['AIHR_STAGING_TOKEN']==self.lease['token'],'native controlled identity/lease environment differs')
        if argv[:2]==[PYTHON_PINS['path'],'-c']:
            check(argv==[PYTHON_PINS['path'],'-c',"import json,sys;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:3])),'safePath':sys.flags.safe_path,'noUserSite':sys.flags.no_user_site}))"],'fixed Python runtime probe changed')
            check(environment.get('PYTHONNOUSERSITE')=='1' and environment.get('PYTHONSAFEPATH')=='1','fixed Python isolation environment required')
            return {'version':PYTHON_PINS['version'],'safePath':True,'noUserSite':1}
        if argv[0]=='/usr/bin/python3':
            check(argv==['/usr/bin/python3',str(self.coordinator)],'native coordinator command changed')
            request=json.loads(options['input']);check(request['action']=='assert' and all(request[k]==self.lease[k]for k in self.lease),'native lease selection differs')
            fd=options.get('operation_fd')
            if fd is None and ci.ACTIVE_OPERATION_GUARD is not None:fd=ci.ACTIVE_OPERATION_GUARD.lock.fd
            check(fd is not None and any('FLOCK' in line and 'READ' in line for line in Path('/proc/self/fdinfo/'+str(fd)).read_text().splitlines()),'coordinator lacks genuine inherited queue SH')
            return {'releaseAuthorized':False,**self.auth['lease'],'phase':self.held_phase}
        if argv==[str(self.node),'--env-file=.env.production','-e',ci.READINESS_PROBE]:
            env=dict(line.split('=',1)for line in (self.webroot/'.env.production').read_text().splitlines())
            return {'kind':'CI_WORKER_READINESS_POLICY_V1',**(self.probe_override or {'required':env.get('AIHR_IMPORT_WORKER_REQUIRED'),'waitSeconds':env.get('AIHR_IMPORT_WORKER_WAIT_SECONDS')})}
        if '-e' in argv:
            check(argv==[str(self.node),'--env-file=.env.production','--input-type=module','-e',ci.FAST_PROBE,str(self.directory)],'fixed complete fresh probe changed')
            self.fast_calls+=1;self.boundary('fast',self.fast_calls)
            return {'kind':'CI_WORKER_COMPLETE_FENCE_V2','pid':self.auth['webPid'],'startedMonotonicUs':self.auth['webStartedMonotonicUs'],'bootId':self.boot.read_text(),'build':self.new_build,'environmentSha256':self.auth['environmentSha256'],'migrationLedger':{**self.ledger,'verifiedAt':self.timestamp()},'healthStatus':200,'readiness':self.probe_override or self.auth['readiness']}
        check(argv==[str(self.node),'--env-file=.env.production','--import','tsx','.github/ci/staging-build-install.mjs','status',self.source,self.install_id,self.build_record],'native status selection/argv differs')
        self.native_calls+=1;self.boundary('audit',self.native_calls)
        if self.native_failure_at==self.native_calls:raise ValueError('genuine native compiled byte integrity failed')
        result={'authorizationSha256':self.auth['grantSha256'],'releaseAuthorized':False,'runtime':copy.deepcopy(self.runtime),'verified':copy.deepcopy(self.verified),'activated':copy.deepcopy(self.activated)}
        result['runtime']['migrationLedger']['verifiedAt']=self.timestamp();result['runtime']['verifiedAt']=self.timestamp()
        fault=self.final_native_fault if self.native_calls==2 else self.native_fault
        ledger=result['runtime']['migrationLedger']
        if fault=='ledger-extra':ledger['unknown']=True
        if fault=='ledger-missing':ledger.pop('verifiedAt')
        if fault=='ledger-time':ledger['verifiedAt']='not-a-time'
        if fault=='runtime-time':result['runtime']['verifiedAt']='not-a-time'
        if fault=='ledger-time-order':ledger['verifiedAt']='2026-11-17T00:00:59.000Z'
        if fault=='pid':result['runtime']['pid']='1000'
        if fault=='ledger':ledger['actualSha256']='0'*64
        if fault=='compiled':result['runtime']['compiledByteInventory']['format']=1
        if fault=='wrong-install':result['runtime']['installId']='different'
        if fault=='environment-proof':raise ValueError('native full environment proof differs')
        if fault=='unknown-runtime':result['runtime']['extraTimestamp']='2026-11-17T00:00:10.000Z'
        return result
    def command(self,argv,**options):
        if argv==['/usr/bin/systemctl','show','aihr-bank-import.service','--property=ControlGroup','--value']:
            return SimpleNamespace(stdout='/system.slice/aihr-bank-import.service\n')
        try:return super().command(argv)
        finally:
            if argv==['/usr/bin/systemctl','start','aihr-bank-import.service']:
                process=self.proc/self.report['MainPID'];process.mkdir(exist_ok=True)
                (process/'cwd').symlink_to(self.app/'releases'/self.source)
                (process/'cmdline').write_bytes(str(self.node).encode()+b'\0--import\0tsx\0scripts/bank-import-runner.ts\0')
                (process/'status').write_text('Uid:\t'+'\t'.join([str(self.owner.pw_uid)]*4)+'\n')
                (process/'cgroup').write_text('0::/system.slice/aihr-bank-import.service\n')
                ticks=int(time.monotonic()*os.sysconf('SC_CLK_TCK'))+1
                (process/'stat').write_text(self.report['MainPID']+' (owned worker) '+' '.join(['S']+['0']*18+[str(ticks)]))
            if argv==['/usr/bin/systemctl','stop','--no-block','aihr-bank-import.service'] and self.report['MainPID']=='0':
                # A genuinely stopped process disappears from proc; retain it only in explicit reuse tests.
                shutil.rmtree(self.proc/'456')
    @contextlib.contextmanager
    def ports(self):
        original_fstat=os.fstat;original_monotonic=time.monotonic
        root_files={self.authorization,self.leasefile,self.firstfile,self.root/'install.lock'}|getattr(self,'additional_root_private_files',set())
        def protected_stat(fd):
            info=original_fstat(fd)
            # Only administrator-private credentials/install EX emulate the root privilege boundary.
            # Queue locks, real metadata-tree descriptors and install-owner records retain every actual field.
            target=Path(os.readlink('/proc/self/fd/'+str(fd)))
            if target not in root_files:return info
            fields={name:getattr(info,name)for name in dir(info)if name.startswith('st_')}
            fields['st_uid']=0;return SimpleNamespace(**fields)
        with ExitStack() as s:
            for name,value in [('SOURCE',self.webroot),('STATE',self.state),('COORDINATOR',self.coordinator),('BOOT_ID',self.boot),('PROCESS_ROOT',self.proc),('RUNTIME_ROOT',self.runtime_root),('FENCES',fences)]:s.enter_context(patch.object(ci,name,value))
            s.enter_context(patch.object(guard,'QUEUE',self.queue));s.enter_context(patch.object(guard,'LOCK',self.queue_lock))
            s.enter_context(patch.object(ci,'child',side_effect=self.native));s.enter_context(patch.object(ci.pwd,'getpwuid',return_value=self.owner));s.enter_context(patch.object(ci.pwd,'getpwnam',return_value=self.owner))
            s.enter_context(patch.object(ci.time,'time',side_effect=lambda:self.clock));s.enter_context(patch.object(ci.time,'monotonic',side_effect=lambda:original_monotonic()+self.monotonic_offset))
            s.enter_context(patch.object(update.time,'sleep',side_effect=self.sleep_port))
            s.enter_context(patch.object(sys,'argv',[str(self.helper)]))
            s.enter_context(patch.object(update.os,'geteuid',return_value=0));s.enter_context(patch.object(update.os,'fstat',side_effect=protected_stat))
            s.enter_context(patch.object(update,'properties',side_effect=lambda _:dict(self.report)))
            s.enter_context(patch.object(update,'HTTPConnection',side_effect=self.health_connection))
            s.enter_context(patch.object(update,'validate_process',side_effect=lambda _,report,source:int(report['MainPID'])))
            self.base.service_properties=lambda:dict(self.report)
            yield
    def conditional(self):
        with self.ports(),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            try:guard.launch(['guarded-activate-ci-runtime','--approval',str(self.authorization),'--approval-sha256',ci.sha(self.authorization.read_bytes())],self.fmt,self.base,ci,update)
            finally:
                if self.pending_publication:os.close(self.pending_publication[0]);self.pending_publication=None


def qualify_legacy_baseline_fixture(f,*,before_launch=False,preunit=False):
    """Fictional existing producer fields, real record/receipt bytes and OS metadata.
    Run the actual paired validator before replacing only current with the new launch.
    No record/receipt is exported or manufactured outside the private fixture tree.
    """
    if not hasattr(ci,'RECOVERY'):ci.RECOVERY=load_native('legacy_receipt_policy_owner','bank_import_worker_prepared_v1.py')
    original=copy.deepcopy(f.current)
    # Native begin replaces current only; it does not touch the previous last-ok publication.
    def write_changed_records():
        for name,value in [('current',f.current),('last-ok',f.prior)]:
            raw=''.join(k+'='+str(v)+'\n'for k,v in value.items()).encode();path=f.state/name
            if not path.exists()or path.read_bytes()!=raw:path.write_bytes(raw)
    f.write_records=write_changed_records
    f.current={**f.prior,'phase':'ci-build-health','result':'ok','finished_at':'1794873500'}
    f.prior={**f.current,'result':'failed'};f.write_records()
    receipt=f.old_release/'worker-install-v2.json'
    recovered={**f.old_receipt,'source':f.previous_worker,'webBuildId':f.old_build,'authorizationSha256':'6'*64,
               'mode':'recover-prepared-preunit-ci-runtime'if preunit else'recover-ci-runtime',
               'policy':'aihr-worker-prepared-preunit-recovery/v1'if preunit else ci.RECOVERY.POLICY,'workerRecoveryOnly':True,
               'nativeRuntimeVerified':True,'fullSourceContentInventoryVerified':True,'fullNativeAudits':2,
               'completeMetadataFences':10,'journeyVerified':False,'installationAuthorizationSha256':'5'*64,
               'firstStageApprovalSha256':'4'*64,'installId':'63333333-3333-4333-8333-333333333333'}
    receipt.write_bytes(encoded(recovered));receipt.chmod(0o444)
    # The actual native finish clock is seconds; the real receipt publication metadata precedes it.
    f.current['finished_at']=str(int(time.time()));f.prior['finished_at']=f.current['finished_at'];f.write_records()
    with patch.object(ci,'STATE',f.state):
        selection={'format':1,'policy':ci.BASELINE_PUBLICATION_POLICY,'source':f.previous_web,'buildId':f.old_build,
                   'currentSha256':ci.sha((f.state/'current').read_bytes()),'lastOkSha256':ci.sha((f.state/'last-ok').read_bytes()),
                   'workerReceiptSha256':ci.sha(receipt.read_bytes()),'workerAuthorizationSha256':recovered['authorizationSha256'],
                   'currentIdentity':ci.baseline_file_identity(f.base,f.state/'current'),
                   'lastOkIdentity':ci.baseline_file_identity(f.base,f.state/'last-ok'),
                   'workerReceiptIdentity':ci.baseline_file_identity(f.base,receipt)}
        f.auth[ci.BASELINE_PUBLICATION_KEY]=copy.deepcopy(selection)
        ci.verify_baseline_publication(f.base,f.auth,paired=True)
    f.first[ci.BASELINE_PUBLICATION_KEY]=copy.deepcopy(selection)
    f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes())
    f.auth['priorLastOkSha256']=selection['lastOkSha256'];f.current=original
    if not before_launch:f.write_records()
    f.persist_authority();return selection


class PauseBeforeNativeRemoval(Exception):pass


def prepare_real_cleanup_intent(f):
    original=shutil.rmtree
    def pause(*args,**kwargs):raise PauseBeforeNativeRemoval()
    pause.avoids_symlink_attacks=original.avoids_symlink_attacks
    with patch.object(owned_cleanup.shutil,'rmtree',pause):
        try:f.begin_cleanup()
        except PauseBeforeNativeRemoval:pass
    check((f.directory/'cleanup-intent.json').exists() and (f.directory/'next').exists() and (f.directory/'packet').exists(),'actual native intent must precede both removals')


@contextlib.contextmanager
def metadata_snapshot_race(f,point,action,setup=prepare_real_cleanup_intent):
    """Actual owner mutates precisely after initial readdir or at final root lstat."""
    original_listdir=os.listdir;original_lstat=Path.lstat;original_boundary=f.boundary;original_sleep=f.sleep_port
    state={'ready':False,'captured':False,'fired':False,'retries':0,'names':set()}
    def boundary(kind,count):
        original_boundary(kind,count)
        if kind=='fast' and count==1:setup(f);state['ready']=True
    def listing(path):
        result=original_listdir(path)
        if state['ready'] and not state['captured'] and isinstance(path,(str,os.PathLike)) and Path(path)==f.directory:
            state['captured']=True;state['names']=set(result)
        return result
    def lstat(path,*args,**kwargs):
        target=f.directory/point if point in ('packet','next')else f.directory
        if state['captured'] and not state['fired'] and path==target:
            state['fired']=True
            if point=='root-after':
                result=original_lstat(path,*args,**kwargs);action(f);return result
            action(f)
        return original_lstat(path,*args,**kwargs)
    def sleep(seconds):
        if seconds==.02:state['retries']+=1
        original_sleep(seconds)
    with patch.object(f,'boundary',side_effect=boundary),patch.object(f,'sleep_port',side_effect=sleep),patch.object(ci.os,'listdir',side_effect=listing),patch.object(Path,'lstat',new=lstat):yield state


def resume_real_owned_removal(f):
    return owned_cleanup.cleanup_install(str(f.directory),str(f.webroot))


class ConditionalRuntimeTests(unittest.TestCase):
    def test_fixture_original_grant_obeys_the_real_native_closed_validator(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));program="import {readFileSync} from 'node:fs';import {validateInstallGrant} from './.github/ci/ci-install-grant.mjs';validateInstallGrant(JSON.parse(readFileSync(process.argv[1])),{now:1794873610000});console.log('native-grant-valid')"
            result=subprocess.run(['node','--input-type=module','-e',program,str(f.directory/'authorization.json')],cwd=ROOT,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr);self.assertIn('native-grant-valid',result.stdout)
    def test_running_ci_retains_old_last_ok_and_honest_partial_receipt(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));old_last=(f.state/'last-ok').read_bytes();environment=f.env.read_bytes();dotenv=(f.webroot/'.env.production').read_bytes();f.conditional()
            r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['mode'],'activate-ci-runtime');self.assertFalse(r['journeyVerified']);self.assertEqual(set(r['transitionStages']),{'R0'});self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertEqual((r['fullNativeAudits'],r['completeMetadataFences']),(2,10));self.assertEqual(len(list(f.operation.glob('ci-runtime-full-audit-*.json'))),2);self.assertEqual(len(list(f.operation.glob('ci-runtime-fence-*.json'))),10);self.assertEqual((f.state/'last-ok').read_bytes(),old_last);self.assertEqual(f.env.read_bytes(),environment);self.assertEqual((f.webroot/'.env.production').read_bytes(),dotenv)
    def test_normal_finish_can_complete_at_all_ten_fences_and_exactly_two_audits(self):
        for kind,total in [('fast',10),('audit',2)]:
            for call in range(1,total+1):
                with self.subTest(kind=kind,call=call),tempfile.TemporaryDirectory()as tmp:
                    f=Fixture(Path(tmp));f.finish_on=(kind,call);f.conditional();r=json.loads((f.operation/'activated.json').read_text())
                    self.assertEqual(r['transitionStages'][-1],'O');self.assertFalse(r['journeyVerified']);self.assertEqual(f.current['result'],'ok');self.assertEqual((f.native_calls,f.fast_calls),(2,10))
    def test_coherent_native_r1_publication_then_ok_is_monotonic(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.finish('R1');f.finish_at=2;f.conditional();r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['transitionStages'][0],'R1');self.assertEqual(r['transitionStages'][-1],'O')
    def test_initial_strict_ok_is_admitted_only_under_same_pins(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.finish();f.conditional();self.assertEqual(set(json.loads((f.operation/'activated.json').read_text())['transitionStages']),{'O'})
    def test_same_lease_arrives_and_normal_cleanup_crosses_every_native_boundary(self):
        for boundary in range(1,11):
            for cleanup in [False,True]:
                with self.subTest(boundary=boundary,cleanup=cleanup),tempfile.TemporaryDirectory()as tmp:
                    f=Fixture(Path(tmp))
                    if cleanup:f.cleanup_at=boundary
                    else:f.arrive_at=boundary
                    f.conditional();r=json.loads((f.operation/'activated.json').read_text());self.assertEqual(r['transitionStages'][-1],'O');self.assertEqual(r['leasePhases'][-1],'arrived');self.assertFalse(r['journeyVerified'])
                    if cleanup:
                        self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')));self.assertFalse((f.directory/'packet').exists());self.assertFalse((f.directory/'next').exists());self.assertEqual((f.native_calls,f.fast_calls),(2,10))
    def test_arrived_requires_strict_ok_and_lease_never_backslides(self):
        for stage in ['R0','R1','wrong-build']:
            with self.subTest(stage=stage),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.held_phase='arrived'
                if stage=='R1':f.finish('R1')
                if stage=='wrong-build':f.finish();(f.webroot/'.next/BUILD_ID').write_text('other-build')
                with self.assertRaises(ValueError):f.conditional()
                self.assertFalse((f.operation/'activated.json').exists())
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.arrive_at=1;f.lease_backslide_at=6
            with self.assertRaises(RuntimeError):f.conditional()
            self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no')
    def test_native_byte_failure_during_legal_cleanup_is_fatal_without_retry(self):
        for audit in (1,2):
            with self.subTest(audit=audit),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.cleanup_at=1 if audit==1 else 6;f.native_failure_at=audit;before=f.unit.read_bytes()
                with self.assertRaisesRegex(ValueError if audit==1 else RuntimeError,'native compiled byte|retained packages|Retained packages'):f.conditional()
                self.assertEqual(f.native_calls,audit);self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')));self.assertFalse((f.operation/'activated.json').exists())
                if audit==1:self.assertEqual(f.unit.read_bytes(),before)
                else:self.assertEqual(f.report['Restart'],'no');self.assertEqual(f.report['SendSIGKILL'],'no')
    def test_wrong_expired_missing_and_late_authority_refuses_before_unit_or_service_mutation(self):
        for defect in ['authority-expired','unknown-authority','grant-expired','late-grant','wrong-run','wrong-controller','wrong-install','wrong-directory','wrong-inode','wrong-owner','wrong-drain','missing-grant','environment','worker-env','node','boot','manifest','extra-source','missing-source','source-mode','foreign-lease','pending','failed','dead-pid','wrong-launch','wrong-last-ok','world-readable-lease','symlink-lease','unknown-launch','unknown-ledger','unknown-grant','unknown-build','cleaned-install','unknown-current','unknown-last-ok','filter-drift','wrong-first-gate','wrong-first-artifact','wrong-first-helper','postdated-first-approval','expired-at-drain','world-readable-first-approval','first-web-env','first-dotenv','first-readiness','bad-readiness']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes()
                if defect=='authority-expired':f.auth['expiresAt']='2026-11-16T00:00:00Z'
                if defect=='unknown-authority':f.auth['selfApproved']=True
                if defect=='grant-expired':f.grant['expiresAt']='2026-11-16T00:00:00Z';(f.directory/'authorization.json').write_bytes(encoded(f.grant));f.auth['grantSha256']=ci.sha(encoded(f.grant))
                if defect=='late-grant':(f.directory/'authorization.json').write_text('{}')
                if defect=='wrong-run':f.auth['install']['runId']=78
                if defect=='wrong-controller':f.auth['install']['controller']='4'*40
                if defect=='wrong-install':f.auth['install']['id']='42345678-1234-4123-8123-123456789abc'
                if defect=='wrong-directory':f.auth['install']['directory']=str(f.root)
                if defect=='wrong-inode':f.auth['install']['inode']+=1
                if defect=='wrong-owner':f.auth['install']['uid']+=1
                if defect=='wrong-drain':f.auth['drainSha256']='0'*64
                if defect=='missing-grant':(f.directory/'authorization.json').unlink()
                if defect=='environment':(f.webroot/'.env.production').write_text('AIHR_IMPORT_WORKER_REQUIRED=0\n')
                if defect=='worker-env':f.env.write_text('DATABASE_URL="changed"\n')
                if defect=='node':f.node.write_text('different node')
                if defect=='boot':f.boot.write_text('other boot')
                if defect=='manifest':f.source_manifest_file.write_text('{}')
                if defect=='extra-source':(f.webroot/'unexpected').write_text('canonical extra')
                if defect=='missing-source':(f.webroot/'source-000').unlink()
                if defect=='source-mode':(f.webroot/'source-000').chmod(0o755)
                if defect=='foreign-lease':f.held_phase='accepting'
                if defect=='pending':(f.state/'pending').write_text('pending')
                if defect=='failed':f.current['result']='failed';f.write_records()
                if defect=='dead-pid':(f.proc/'777/stat').unlink()
                if defect=='wrong-launch':f.current['log']='foreign';f.write_records()
                if defect=='wrong-last-ok':f.prior['ref']='9'*40;f.write_records()
                if defect=='world-readable-lease':f.leasefile.chmod(0o644)
                if defect=='symlink-lease':
                    actual=f.root/'actual-lease';os.rename(f.leasefile,actual);f.leasefile.symlink_to(actual)
                if defect=='unknown-launch':f.auth['launch']['selfApproved']=True
                if defect=='unknown-ledger':f.auth['ledger']['subset']=True
                if defect in ['unknown-grant','unknown-build']:
                    target=f.grant if defect=='unknown-grant' else f.grant['build'];target['extra']=True;(f.directory/'authorization.json').write_bytes(encoded(f.grant));f.auth['grantSha256']=ci.sha(encoded(f.grant))
                if defect=='cleaned-install':(f.directory/'cleanup-authorized.json').write_text('{}')
                if defect=='unknown-current':f.current['unapproved']='extra';f.auth['launch']['current']['unapproved']='extra';f.write_records()
                if defect=='unknown-last-ok':f.prior['unapproved']='extra';f.write_records()
                if defect=='filter-drift':
                    m=json.loads(f.source_manifest_file.read_text());m['filters'].append('source-000');m['entries']=[row for row in m['entries']if row['path']!='source-000'];f.source_manifest_file.write_bytes(encoded(m));f.auth['sourceManifestSha256']=ci.sha(f.source_manifest_file.read_bytes());f.first=copy.deepcopy(f.first);f.first['sourceManifestSha256']=f.auth['sourceManifestSha256'];f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes())
                if defect in ['wrong-first-gate','wrong-first-artifact','wrong-first-helper','postdated-first-approval','expired-at-drain']:
                    f.first=copy.deepcopy(f.first)
                    if defect=='wrong-first-gate':f.first['gate']['runId']=78
                    if defect=='wrong-first-artifact':f.first['gate']['build']['provenanceSha256']='f'*64
                    if defect=='wrong-first-helper':f.first['helperSha256']='0'*64
                    if defect=='postdated-first-approval':f.first['issuedAt']='2026-11-17T00:00:03Z'
                    if defect=='expired-at-drain':f.first['expiresAt']='2026-11-17T00:00:01Z'
                    f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes())
                if defect=='world-readable-first-approval':f.firstfile.chmod(0o644)
                if defect in ['first-web-env','first-dotenv','first-readiness']:
                    f.first=copy.deepcopy(f.first)
                    if defect=='first-web-env':f.first['environmentSha256']='0'*64
                    if defect=='first-dotenv':f.first['dotenvSha256']='0'*64
                    if defect=='first-readiness':f.first['readiness']={'required':'0','waitSeconds':None}
                    f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes())
                if defect=='bad-readiness':f.auth['readiness']={'required':'1','waitSeconds':'45'}
                f.persist_authority()
                with self.assertRaises((ValueError,FileNotFoundError,KeyError)):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists());self.assertFalse((f.operation/'activated.json').exists())
    def test_fresh_native_proof_refuses_pid_ledger_compiled_install_and_full_environment_drift(self):
        for defect in ['pid','ledger','compiled','wrong-install','environment-proof','ledger-extra','ledger-missing','ledger-time','runtime-time','ledger-time-order','unknown-runtime']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.native_fault=defect
                with self.assertRaises(ValueError):f.conditional()
                self.assertFalse((f.operation/'activated.json').exists());self.assertFalse((f.operation/'activated.json').exists())
    def test_deploy_failure_or_source_drift_after_worker_start_uses_existing_quarantine(self):
        for defect in ['failed','source','backslide']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.fault_at=6;f.native_fault=defect
                if defect=='backslide':f.finish_at=1
                with self.assertRaisesRegex(RuntimeError,'retained packages|Retained packages'):f.conditional()
                self.assertTrue((f.operation/'ci-worker-started.json').exists());self.assertTrue((f.operation/'ci-worker-quarantine-authority.json').exists());self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no');self.assertEqual(f.report['SendSIGKILL'],'no');self.assertEqual(f.report['UnitFileState'],'disabled');self.assertEqual(f.report['MainPID'],'0');self.assertEqual(f.report['ActiveState'],'inactive')
    def test_conditional_authority_cannot_be_reused_or_passed_to_normal_modes(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.conditional()
            with self.assertRaises(ValueError):f.conditional()
            with self.assertRaisesRegex(ValueError,'belong only'):
                with f.ports():update.upgrade(f.args('activate',{'ci-runtime-authorization':str(f.authorization),'ci-runtime-authorization-sha256':ci.sha(f.authorization.read_bytes())}),f.fmt,f.base,ci)
    def test_changed_lease_inode_is_refused_before_unit_replacement(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.fault_at=1;f.native_fault='lease-inode';before=f.unit.read_bytes()
            with self.assertRaisesRegex(ValueError,'lease inode/content|credential identity'):f.conditional()
            self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists())
    def test_native_output_and_silent_runtime_have_hard_streaming_and_time_bounds(self):
        for stream in ['stdout','stderr']:
            with patch.object(ci,'MAX_NATIVE_STDOUT',256),patch.object(ci,'MAX_NATIVE_STDERR',256):
                with self.assertRaisesRegex(ValueError,'bounded native'):
                    ci.bounded_process([sys.executable,'-I','-c','import sys;sys.'+stream+'.buffer.write(b"x"*1024);sys.'+stream+'.flush()'],timeout=2)
        began=time.monotonic()
        with self.assertRaisesRegex(ValueError,'bounded native'):ci.bounded_process([sys.executable,'-I','-c','import time;time.sleep(60)'],timeout=.1)
        self.assertLess(time.monotonic()-began,3)
    def test_inventory_uses_component_globs_and_detects_links_extras_and_omissions(self):
        self.assertTrue(ci.excluded('mobile/key.p8',['/mobile/*.p8']));self.assertFalse(ci.excluded('mobile/sub/key.p8',['/mobile/*.p8']));self.assertTrue(ci.excluded('nested/node_modules',['node_modules']))
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);(root/'a').write_text('content');(root/'link').symlink_to('a');base=SimpleNamespace(check=check,read_bounded=lambda p,limit:p.read_bytes());before=ci.source_inventory(base,root,['node_modules','.next']);(root/'a').write_text('changed');self.assertNotEqual(ci.source_inventory(base,root,['node_modules','.next']),before);(root/'escape').symlink_to('../outside')
            with self.assertRaises((ValueError,FileNotFoundError)):ci.source_inventory(base,root,['node_modules','.next'])
    def test_root_private_authority_and_lease_refuse_public_linked_and_symlink_files(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);leaf=root/'credential';leaf.write_text('private');base=SimpleNamespace(check=check,root_protected=lambda *a,**kw:None)
            actual=os.fstat
            def root_info(fd):
                st=actual(fd);return SimpleNamespace(st_uid=0,st_mode=st.st_mode,st_nlink=st.st_nlink,st_dev=st.st_dev,st_ino=st.st_ino)
            with patch.object(ci.os,'fstat',side_effect=root_info):
                leaf.chmod(0o600);self.assertEqual(ci.protected_private(base,leaf),(leaf.stat().st_dev,leaf.stat().st_ino))
                leaf.chmod(0o644)
                with self.assertRaisesRegex(ValueError,'root-private'):ci.protected_private(base,leaf)
                leaf.chmod(0o600);linked=root/'linked';os.link(leaf,linked)
                with self.assertRaisesRegex(ValueError,'root-private'):ci.protected_private(base,leaf)
                linked.unlink();symbolic=root/'symbolic';symbolic.symlink_to(leaf)
                with self.assertRaises(OSError):ci.protected_private(base,symbolic)
    def test_only_safe_preexisting_cache_children_may_change_compiled_siblings_remain_exact(self):
        for defect in ['cache-child','compiled-sibling','cache-replaced']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));(f.webroot/'.next/cache').mkdir(mode=0o700);(f.webroot/'.next/server.js').write_text('frozen compiled bytes');f.cache_fault=defect
                if defect=='cache-child':
                    f.conditional();self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertTrue((f.operation/'activated.json').exists())
                else:
                    with self.assertRaises(RuntimeError):f.conditional()
                    self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no');self.assertEqual(f.native_calls,1)
    def test_known_native_wx_publication_completes_only_inside_same_fence_and_live_authority(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.partial_ready_at=1;f.conditional()
            self.assertEqual(f.publication_sleeps,1);self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertTrue((f.operation/'activated.json').exists());self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')))
        for defect in ['deadline','lease']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes();f.partial_ready_at=1;f.pending_defect=defect
                with self.assertRaisesRegex(ValueError,'stage deadline|native lease|installing/arrived'):f.conditional()
                self.assertEqual(f.publication_sleeps,1);self.assertEqual(f.unit.read_bytes(),before);self.assertEqual(f.native_calls,0);self.assertFalse((f.operation/'activated.json').exists());self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')))
    def test_actual_native_cleanup_lifecycle_is_legal_at_every_publication_and_removal(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.cleanup_at=5;f.observe_cleanup=True;f.conditional()
            self.assertEqual([row['stage']for row in f.cleanup_observations],['lock-held','original-audit-retained','normal-cleanup-ready.json','normal-cleanup-commit.json','cleanup-authorized.json','normal-cleanup-consumed.json','cleanup-intent.json','removed-next','removed-packet','cleanup-result.json','normal-session-result','lock-released'])
            self.assertEqual(set(f.cleanup_observations[-1]['removed']),{'next','packet','normal-cleanup.lock'});self.assertTrue({'next','packet','normal-cleanup.lock'}.isdisjoint(f.cleanup_observations[-1]['members']));self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertTrue((f.operation/'activated.json').exists())
    def test_real_native_packet_and_next_removal_between_names_and_folder_stat_retries_once(self):
        for point in ['packet','next']:
            with self.subTest(point=point),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp))
                with metadata_snapshot_race(f,point,resume_real_owned_removal)as state:f.conditional()
                self.assertTrue(state['fired']);self.assertTrue({'packet','next'}<=state['names']);self.assertEqual(state['retries'],1)
                self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertFalse((f.directory/'next').exists());self.assertFalse((f.directory/'packet').exists());self.assertTrue((f.operation/'activated.json').exists())
                self.assertEqual(json.loads((f.directory/'cleanup-result.json').read_bytes())['kind'],'OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED')
    def test_real_native_removal_before_and_after_final_root_stat_uses_final_stable_nlink(self):
        for point in ['root-before','root-after']:
            with self.subTest(point=point),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp))
                with metadata_snapshot_race(f,point,resume_real_owned_removal)as state:f.conditional()
                self.assertTrue(state['fired']);self.assertEqual(state['retries'],1);self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertTrue((f.operation/'activated.json').exists())
                self.assertFalse((f.directory/'packet').exists());self.assertFalse((f.directory/'next').exists())
    def test_actual_audit_publication_root_races_retry_but_unknown_identity_and_hash_are_fatal(self):
        for point in ['root-before','root-after']:
            with self.subTest(publication=point),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp))
                with metadata_snapshot_race(f,point,lambda target:target.retain_audit_native(),setup=lambda target:target.finish())as state:f.conditional()
                self.assertTrue(state['fired']);self.assertNotIn('audit',state['names']);self.assertEqual(state['retries'],1);self.assertEqual((f.native_calls,f.fast_calls),(2,10));self.assertTrue((f.operation/'activated.json').exists())
        for defect in ['unknown-member','directory-identity','audit-hash']:
            with self.subTest(fatal=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes()
                if defect=='audit-hash':f.finish();f.retain_audit_native()
                def action(target):
                    if defect=='unknown-member':target.private_record('foreign.json',{'unknown':True})
                    elif defect=='directory-identity':
                        parked=target.directory.parent/'parked-foreign-root';target.directory.rename(parked);target.directory.mkdir(mode=0o700)
                        for child in parked.iterdir():child.rename(target.directory/child.name)
                    else:
                        leaf=target.directory/'audit/system-testing.json';value=json.loads(leaf.read_bytes());value['tamperedAfterRead']=True;leaf.write_bytes(encoded(value))
                def setup(target):
                    # The audit-hash case already published native O before retaining
                    # its baseline audit. Do not synthesize a second finish publication.
                    if defect!='audit-hash':target.finish()
                with metadata_snapshot_race(f,'root-before',action,setup=setup)as state:
                    with self.assertRaisesRegex(ValueError,'unknown/missing|directory identity|audit byte integrity'):f.conditional()
                self.assertTrue(state['fired']);self.assertEqual(state['retries'],0);self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists());self.assertFalse((f.operation/'ci-worker-start-request.json').exists());self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')))

    def test_native_cleanup_intent_hash_directory_and_order_refuse_before_owned_deletion(self):
        for defect in ['hash','directory','child-order']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.cleanup_at=1;f.cleanup_intent_fault=defect;before=f.unit.read_bytes()
                with self.assertRaisesRegex(ValueError,'cleanup intent differs'):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertTrue((f.directory/'next').exists());self.assertTrue((f.directory/'packet').exists());self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.native_calls,0)
    def test_fixed_guard_is_mandatory_and_existing_queue_lock_excludes_foreign_operation(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));before=f.unit.read_bytes()
            with f.ports(),self.assertRaisesRegex(ValueError,'fixed root guarded'):
                update.upgrade(f.args('activate-ci-runtime',{'ci-runtime-authorization':str(f.authorization),'ci-runtime-authorization-sha256':ci.sha(f.authorization.read_bytes())}),f.fmt,f.base,ci)
            fd=os.open(f.queue_lock,os.O_RDWR|os.O_NOFOLLOW)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertEqual(f.fast_calls,0);self.assertEqual(f.native_calls,0)
            finally:os.close(fd)
        for defect in ['mode','inode']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes()
                if defect=='mode':f.queue_lock.chmod(0o644)
                else:
                    replacement=f.queue/'replacement';replacement.write_bytes(b'');replacement.chmod(0o600);os.replace(replacement,f.queue_lock)
                with self.assertRaisesRegex(ValueError,'lock path identity'):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists())
    def test_fresh_readiness_and_original_audit_bytes_are_not_metadata_waivers(self):
        for defect in ['required','wait','retained-audit-byte']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes()
                if defect=='required':f.probe_override={'required':'0','waitSeconds':None}
                if defect=='wait':f.probe_override={'required':'1','waitSeconds':'45'}
                if defect=='retained-audit-byte':
                    leaf=f.directory/'packet/system-testing.json';value=json.loads(leaf.read_bytes());value['fixtureTampered']=True;leaf.write_bytes(encoded(value))
                with self.assertRaisesRegex(ValueError,'identity/environment/health|audit byte integrity'):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertEqual(f.native_calls,0);self.assertFalse((f.operation/'activated.json').exists())
                if defect=='retained-audit-byte':self.assertEqual(f.publication_sleeps,0);self.assertFalse(list(f.operation.glob('ci-runtime-native-retry-*.json')))
    def test_f2_admission_refuses_helper_readiness_and_global_reservation_before_mutation(self):
        for defect in ['helper-reserve','readiness-opportunity','global-estimate','fence-deadline']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes();events=len(f.events)
                if defect=='helper-reserve':f.advance_at=3;f.advance_seconds=400
                if defect=='readiness-opportunity':
                    f.clock=1794873960;f.auth['issuedAt']='2026-11-17T00:05:50Z';f.auth['expiresAt']='2026-11-17T00:20:50Z';f.advance_at=3;f.advance_seconds=100
                if defect=='global-estimate':
                    f.grant['expiresAt']='2026-11-17T00:20:00Z';f.private_record('authorization.json',f.grant);f.auth['grantSha256']=ci.sha(encoded(f.grant))
                    f.runtime['authorizationSha256']=f.auth['grantSha256'];f.private_record('runtime.json',f.runtime);f.auth['runtimeSha256']=ci.sha(encoded(f.runtime))
                if defect=='fence-deadline':f.deadline_at=3
                f.persist_authority()
                reason='aggregate proof slot expired'if defect=='fence-deadline'else'insufficient mandatory|insufficient estimated global|stage deadline'
                with self.assertRaisesRegex(ValueError,reason):f.conditional()
                self.assertEqual(f.native_calls,1);self.assertEqual(f.fast_calls,3);self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists())
                mutations=[v for v in f.events[events:]if isinstance(v,list)and v[:2]in [['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','start']]]
                self.assertEqual(mutations,[])
    def test_final_native_pass_is_mandatory_and_only_two_timestamp_fields_may_vary(self):
        for fault in ['unknown-runtime','compiled','ledger-extra','ledger-time-order']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));f.final_native_fault=fault
                with self.assertRaises(RuntimeError):f.conditional()
                self.assertEqual(f.native_calls,2);self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no')
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.conditional()
            records=[json.loads(path.read_bytes())for path in sorted(f.operation.glob('ci-runtime-full-audit-*.json'))]
            self.assertEqual(len(records),2)
            for record in records:
                self.assertNotEqual(record['runtime']['verifiedAt'],f.runtime['verifiedAt'])
                self.assertNotEqual(record['runtime']['migrationLedger']['verifiedAt'],f.runtime['migrationLedger']['verifiedAt'])
                self.assertEqual(ci.runtime_identity(f.base,record['runtime'],ci.epoch(f.grant['issuedAt']),f.clock,True),ci.runtime_identity(f.base,f.runtime,ci.epoch(f.grant['issuedAt']),f.clock))
    def test_stability_sleep_and_following_fence_share_one_deadline(self):
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp));f.stability_overrun=True
            with self.assertRaises(RuntimeError):f.conditional()
            self.assertEqual(f.fast_calls,5);self.assertFalse((f.operation/'activated.json').exists());self.assertEqual(f.report['Restart'],'no')
    def test_native_command_drops_uid_gid_groups_and_has_no_shell_or_inherited_loader(self):
        owner=SimpleNamespace(pw_uid=1001,pw_gid=1001);env={'HOME':'/private/owner','PATH':'/opt/node22/bin:/usr/bin:/bin'}
        with patch.object(ci,'bounded_process',return_value=b'{}')as run:
            self.assertEqual(ci.child(['/opt/node22/bin/node','fixed-status'],owner,env),{})
            kwargs=run.call_args.kwargs;self.assertEqual(kwargs['user'],1001);self.assertEqual(kwargs['group'],1001);self.assertEqual(kwargs['extra_groups'],[]);self.assertEqual(kwargs['env'],{**env,'PYTHONNOUSERSITE':'1','PYTHONSAFEPATH':'1','TSX_DISABLE_CACHE':'1'});self.assertNotIn('shell',kwargs)
    def test_actual_node_parser_refuses_active_loader_keys_and_allows_comments(self):
        # Execute only the pinned native owner's no-dotenv/no-app-import parser port.
        # The eventual application/coordinator child is a recording port and never executes.
        node=shutil.which('node');self.assertIsNotNone(node)
        owner=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid());environment={'HOME':'/private/owner','PATH':'/usr/bin:/bin'}
        keys=['NODE_OPTIONS','NODE_PATH','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_REDIRECT_WARNINGS','NODE_ICU_DATA','NODE_EXTRA_CA_CERTS','LD_PRELOAD','DYLD_INSERT_LIBRARIES','PYTHONPATH','OPENSSL_CONF','TSX_TSCONFIG_PATH','TSX_DISABLE_CACHE']
        with tempfile.TemporaryDirectory()as tmp:
            source=Path(tmp);dotenv=source/'.env.production';status=[node,'--env-file=.env.production','fixed-status']
            def process(argv,**options):
                if argv==[node,'--input-type=module','-e',ci.LOADER_PROBE]:
                    parsed=subprocess.run(argv,cwd=options['cwd'],env=options['env'],capture_output=True,check=True,timeout=5)
                    return parsed.stdout
                self.assertEqual(argv,status);return b'{}'
            with patch.object(ci,'SOURCE',source),patch.object(ci,'bounded_process',side_effect=process)as run:
                for key in keys:
                    for line in [key+'=opaque','export '+key+'=opaque',key+'="opaque"',key+"='opaque'"]:
                        with self.subTest(key=key,line=line.split('=')[0]):
                            run.reset_mock();dotenv.write_text('AIHR_IMPORT_WORKER_REQUIRED=1\n'+line+'\n')
                            with self.assertRaisesRegex(ValueError,'active dotenv loader'):ci.child(status,owner,environment,node_options={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(b'')})
                            self.assertEqual(run.call_count,1);self.assertNotIn('--env-file=.env.production',run.call_args.args[0])
                    run.reset_mock();dotenv.write_text('AIHR_IMPORT_WORKER_REQUIRED=1\n# '+key+'=opaque\n')
                    self.assertEqual(ci.child(status,owner,environment,node_options={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(b'')}),{});self.assertEqual(run.call_count,2)
                    self.assertEqual(run.call_args.kwargs['env'],{**environment,'PYTHONNOUSERSITE':'1','PYTHONSAFEPATH':'1','TSX_DISABLE_CACHE':'1'})
                    run.reset_mock()
                    with self.assertRaisesRegex(ValueError,'controlled loader'):ci.child([node,'fixed-status'],owner,{**environment,key:'opaque'})
                    run.assert_not_called()
    def test_named_before_open_swapped_and_restored_source_file_is_refused(self):
        with tempfile.TemporaryDirectory()as tmp:
            parent=Path(tmp);root=parent/'source';root.mkdir();target=root/'target';target.write_text('original')
            foreign=parent/'foreign';foreign.write_text('tampered');parked=parent/'parked';original_open=os.open;swapped=[]
            def raced_open(path,flags,*args,**kwargs):
                if path=='target' and kwargs.get('dir_fd')is not None:
                    os.replace(target,parked);os.replace(foreign,target)
                    try:fd=original_open(path,flags,*args,**kwargs)
                    finally:os.replace(target,foreign);os.replace(parked,target)
                    swapped.append(fd);return fd
                return original_open(path,flags,*args,**kwargs)
            base=SimpleNamespace(check=check)
            with patch.object(ci.os,'open',side_effect=raced_open),self.assertRaisesRegex(ValueError,'source file changed while opening'):
                ci.source_inventory(base,root,['node_modules','.next'])
            self.assertEqual(len(swapped),1);self.assertEqual(target.read_text(),'original');self.assertEqual(foreign.read_text(),'tampered')
    def test_child_inherits_real_queue_sh_and_install_ex_with_absolute_slot_timeout(self):
        real_child=ci.child
        with tempfile.TemporaryDirectory()as tmp:
            f=Fixture(Path(tmp))
            with f.ports(),contextlib.redirect_stdout(io.StringIO()):
                invocation=guard.GuardedInvocation(f.base,ci,'activate-ci-runtime',f.authorization,ci.sha(f.authorization.read_bytes()))
                fd=os.open(f.root/'install.lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                try:
                    invocation.bind_install(fd,f.root/'install.lock')
                    with patch.object(ci,'ACTIVE_OPERATION_GUARD',invocation),patch.object(ci,'SLOT_DEADLINE',time.monotonic()+2),patch.object(ci,'bounded_process',return_value=b'{}')as run:
                        real_child([str(f.node),'fixed-status'],f.owner,{'HOME':str(f.home)},timeout=180,operation_fd=invocation.lock.fd)
                        kwargs=run.call_args.kwargs;self.assertEqual(kwargs['pass_fds'],(invocation.lock.fd,fd));self.assertGreater(kwargs['timeout'],0);self.assertLessEqual(kwargs['timeout'],2)
                        for held,kind in [(invocation.lock.fd,'READ'),(fd,'WRITE')]:self.assertIn(kind,Path('/proc/self/fdinfo/'+str(held)).read_text())
                    with patch.object(ci,'SLOT_DEADLINE',time.monotonic()-1),patch.object(ci,'bounded_process')as run:
                        with self.assertRaisesRegex(ValueError,'slot expired'):real_child([str(f.node),'fixed-status'],f.owner,{},timeout=180)
                        run.assert_not_called()
                finally:invocation.close();os.close(fd)

    def test_python_runtime_and_node_options_approval_pins_refuse_before_service_mutation(self):
        for defect in ['python-bytes','python-too-old','python-wrong-version','python-resolution','node-policy','node-shared-digest']:
            with self.subTest(defect=defect),tempfile.TemporaryDirectory()as tmp:
                f=Fixture(Path(tmp));before=f.unit.read_bytes();f.first=copy.deepcopy(f.first)
                if defect=='python-bytes':f.auth['python']['sha256']='0'*64
                if defect=='python-too-old':f.auth['python']['version']='3.10.0'
                if defect=='python-wrong-version':f.auth['python']['version']='3.99.0'
                if defect=='python-resolution':f.auth['python']['path']='/usr/bin/python3.999'
                if defect.startswith('python-'):f.first['python']=copy.deepcopy(f.auth['python'])
                if defect=='node-policy':f.auth['nodeOptions']['policy']='unreviewed';f.first['nodeOptions']=copy.deepcopy(f.auth['nodeOptions'])
                if defect=='node-shared-digest':f.auth['nodeOptions']['sha256']='0'*64
                f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes());f.persist_authority()
                with self.assertRaises((ValueError,FileNotFoundError)):f.conditional()
                self.assertEqual(f.unit.read_bytes(),before);self.assertFalse((f.operation/'activated.json').exists());self.assertFalse((f.operation/'ci-worker-start-request.json').exists())

    def test_pinned_memory_only_node_options_preserve_native_value_and_recognized_v8_flags(self):
        node=shutil.which('node');self.assertIsNotNone(node);owner=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        environment={'HOME':'/fictional/private-owner','PATH':'/usr/bin:/bin'}
        program="import{createHash}from'node:crypto';import{getHeapStatistics}from'node:v8';const value=process.env.NODE_OPTIONS;process.stdout.write(JSON.stringify({sha256:createHash('sha256').update(value).digest('hex'),recognized:process.allowedNodeEnvironmentFlags.has(value.split('=')[0]),bounded:getHeapStatistics().heap_size_limit>=256*1024**2&&getHeapStatistics().heap_size_limit<=512*1024**2}));"
        with tempfile.TemporaryDirectory()as tmp:
            source=Path(tmp);dotenv=source/'.env.production';argv=[node,'--env-file=.env.production','--input-type=module','-e',program];seen=[]
            def bounded(command,**options):
                seen.append(command);self.assertNotIn('NODE_OPTIONS',options['env'])
                self.assertEqual(options['env'].get('PYTHONNOUSERSITE','1'),'1');self.assertEqual(options['env'].get('PYTHONSAFEPATH','1'),'1')
                return subprocess.run(command,cwd=options['cwd'],env=options['env'],capture_output=True,check=True,timeout=5).stdout
            with patch.object(ci,'SOURCE',source),patch.object(ci,'bounded_process',side_effect=bounded):
                for first in ('-','_'):
                    for second in ('-','_'):
                        for third in ('-','_'):
                            value='--max'+first+'old'+second+'space'+third+'size=256';pins={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(value.encode())}
                            for text in ['NODE_OPTIONS='+value+'\n','export NODE_OPTIONS="'+value+'"\n',"NODE_OPTIONS='"+value+"'\n",'NODE_OPTIONS=--max-old-space-size=384\n# NODE_OPTIONS=--import=forbidden\nNODE_OPTIONS='+value+'\n']:
                                with self.subTest(spelling=value,text=text[:20]):
                                    dotenv.write_text(text);seen.clear();result=ci.child(argv,owner,environment,node_options=pins)
                                    self.assertEqual(result,{'sha256':pins['sha256'],'recognized':True,'bounded':True});self.assertEqual(len(seen),2)
                base='--max-old-space-size=256';pins={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(base.encode())}
                for value in ['--max-old-space-size=127','--max-old-space-size=65537','--max-old-space-size=-256','--max-old-space-size=256x',' '+base,base+' ',base+' --import=forbidden',base+' --require=forbidden','--inspect','--require=forbidden','--import=forbidden','--max-old-space-size=384']:
                    with self.subTest(refusal=value.split('=')[0]):
                        # Quoting retains intentional leading/trailing whitespace in the active value.
                        dotenv.write_text('NODE_OPTIONS="'+value+'"\n');seen.clear()
                        with self.assertRaisesRegex(ValueError,'active dotenv loader'):ci.child(argv,owner,environment,node_options=pins)
                        self.assertEqual(len(seen),1);self.assertNotIn('--env-file=.env.production',seen[0])
                dotenv.write_text('NODE_OPTIONS="'+base+'\n--import=forbidden"\n');seen.clear()
                with self.assertRaisesRegex(ValueError,'active dotenv loader'):ci.child(argv,owner,environment,node_options=pins)
                self.assertEqual(len(seen),1)

    def test_actual_tsx_ignores_malicious_disk_transforms_and_preserves_frozen_resolution(self):
        self.assertGreater(os.geteuid(),0,'Actual cache permission proof needs the hosted unprivileged runner')
        node=shutil.which('node');self.assertIsNotNone(node);owner=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        with tempfile.TemporaryDirectory()as tmp:
            source=Path(tmp);temporary=source/'temporary';temporary.mkdir();(source/'lib').mkdir()
            (source/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
            (source/'package.json').write_text('{"type":"commonjs"}')
            config=source/'tsconfig.json';config.write_text(json.dumps({'compilerOptions':{'target':'ES2022','module':'commonjs','baseUrl':'.','paths':{'@fictional/*':['lib/*']}}}))
            (source/'lib/answer.ts').write_text('export const answer: number = 42;')
            main=source/'main.ts';main.write_text("import {answer} from '@fictional/answer'; const value: number=answer; console.log(JSON.stringify({answer:value,cacheDisabled:process.env.TSX_DISABLE_CACHE==='1'}));")
            dotenv=source/'.env.production';dotenv.write_text('AIHR_IMPORT_WORKER_REQUIRED=1\n')
            env={'PATH':str(Path(node).parent)+':/usr/bin:/bin','HOME':str(source),'TMPDIR':str(temporary)}
            argv=[node,'--env-file=.env.production','--import','tsx',str(main)]
            warm=subprocess.run(argv,cwd=source,env=env,capture_output=True,text=True,check=True,timeout=15)
            self.assertEqual(json.loads(warm.stdout),{'answer':42,'cacheDisabled':False})
            cache=temporary/('tsx-'+str(os.geteuid()));self.assertTrue(cache.is_dir())
            poison_marker=source/'poison-executed';poisoned=[]
            for file in cache.iterdir():
                if not file.is_file():continue
                try:value=json.loads(file.read_bytes())
                except (ValueError,UnicodeError):continue
                if isinstance(value,dict)and isinstance(value.get('code'),str):
                    value['code']="require('node:fs').writeFileSync("+json.dumps(str(poison_marker))+",'hostile transform executed');console.log('hostile transform');"
                    file.write_bytes(encoded(value));poisoned.append(file)
            self.assertTrue(poisoned,'Control must create actual runtime transform-cache entries')
            subprocess.run(argv,cwd=source,env=env,capture_output=True,timeout=15)
            self.assertTrue(poison_marker.exists(),'Control must actually execute the poisoned transform without the fixed cache policy');poison_marker.unlink()
            before={file.name:(ci.sha(file.read_bytes()),file.stat().st_size,file.stat().st_mtime_ns)for file in cache.iterdir()if file.is_file()}
            config_before=config.read_bytes();mode=stat.S_IMODE(cache.stat().st_mode)
            # This actual UID cannot read OR write any existing transform through this
            # directory. Source-package cache implementation has no chmod fallback.
            cache.chmod(0)
            try:
                with self.assertRaises(PermissionError):os.listdir(cache)
                def bounded(command,**options):
                    self.assertEqual(options.pop('user'),os.getuid());self.assertEqual(options.pop('group'),os.getgid());self.assertEqual(options.pop('extra_groups'),[])
                    result=subprocess.run(command,cwd=options['cwd'],env=options['env'],capture_output=True,check=True,timeout=15)
                    return result.stdout
                with patch.object(ci,'SOURCE',source),patch.object(ci,'bounded_process',side_effect=bounded):
                    for text in ['AIHR_IMPORT_WORKER_REQUIRED=1\n','TSX_DISABLE_CACHE=1\n']:
                        dotenv.write_text(text)
                        result=ci.child(argv,owner,env,node_options={'policy':'aihr-worker-node-options-memory/v1','sha256':ci.sha(b'')})
                        self.assertEqual(result,{'answer':42,'cacheDisabled':True})
                self.assertEqual(stat.S_IMODE(cache.stat().st_mode),0);self.assertFalse(poison_marker.exists())
            finally:cache.chmod(mode)
            self.assertEqual(before,{file.name:(ci.sha(file.read_bytes()),file.stat().st_size,file.stat().st_mtime_ns)for file in cache.iterdir()if file.is_file()});self.assertEqual(config.read_bytes(),config_before)
            # Actual --env-file precedence: an existing fixed subprocess key wins.
            dotenv.write_text('TSX_DISABLE_CACHE=0\n')
            precedence=subprocess.run([node,'--env-file=.env.production','-e',"process.stdout.write(JSON.stringify({disabled:process.env.TSX_DISABLE_CACHE==='1'}))"],cwd=source,env={**env,'TSX_DISABLE_CACHE':'1'},capture_output=True,text=True,check=True,timeout=5)
            self.assertEqual(json.loads(precedence.stdout),{'disabled':True})

    def test_actual_node_python_child_inherits_safe_path_and_cannot_run_hostile_customization(self):
        node=shutil.which('node');self.assertIsNotNone(node)
        owner=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp);home=root/'home';cwd=root/'cwd';home.mkdir();cwd.mkdir()
            major,minor=PYTHON_PINS['version'].split('.')[:2]
            user_site=home/'.local/lib'/('python'+major+'.'+minor)/'site-packages';user_site.mkdir(parents=True)
            user_marker=root/'user-site-executed';cwd_marker=root/'cwd-site-executed'
            (user_site/'usercustomize.py').write_text('from pathlib import Path;Path('+repr(str(user_marker))+').write_text("forbidden")')
            (cwd/'sitecustomize.py').write_text('from pathlib import Path;Path('+repr(str(cwd_marker))+').write_text("forbidden")')
            program="import json,sys;print(json.dumps({'safePath':sys.flags.safe_path,'noUserSite':sys.flags.no_user_site}))"
            # The control proves that the fictional owner-user-site fixture is discoverable.
            control=subprocess.run([str(PYTHON_PATH),'-c',program],cwd=cwd,env={'PATH':'/usr/bin:/bin','HOME':str(home)},capture_output=True,text=True,check=True,timeout=5)
            self.assertEqual(json.loads(control.stdout)['noUserSite'],0);self.assertTrue(user_marker.exists());user_marker.unlink()
            if cwd_marker.exists():cwd_marker.unlink()
            env={'PATH':'/usr/bin:/bin','HOME':str(home)}
            js="const{execFileSync}=require('node:child_process');process.stdout.write(execFileSync(process.argv[1],['-c',process.argv[2]],{cwd:process.argv[3],env:process.env}));"
            def bounded(argv,**options):
                self.assertEqual(options.pop('user'),os.getuid());self.assertEqual(options.pop('group'),os.getgid());self.assertEqual(options.pop('extra_groups'),[])
                self.assertEqual(options['env']['PYTHONNOUSERSITE'],'1');self.assertEqual(options['env']['PYTHONSAFEPATH'],'1')
                # Already that actual unprivileged UID; separate kernel fixture tests privilege drop.
                result=subprocess.run(argv,cwd=options['cwd'],env=options['env'],capture_output=True,check=True,timeout=5)
                return result.stdout
            with patch.object(ci,'SOURCE',cwd),patch.object(ci,'bounded_process',side_effect=bounded):
                result=ci.child([node,'-e',js,str(PYTHON_PATH),program,str(cwd)],owner,env)
            self.assertEqual(result,{'safePath':True,'noUserSite':1});self.assertFalse(user_marker.exists());self.assertFalse(cwd_marker.exists())


class QualifiedLegacyBaselineTests(unittest.TestCase):
    def fixture(self,*,before_launch=False,preunit=False):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);f=Fixture(Path(t.name))
        selection=qualify_legacy_baseline_fixture(f,before_launch=before_launch,preunit=preunit);return f,selection

    def resave_pair_pins(self,f):
        p=f.auth[ci.BASELINE_PUBLICATION_KEY]
        for name,key,digest in [('current','currentIdentity','currentSha256'),('last-ok','lastOkIdentity','lastOkSha256')]:
            p[key]=ci.baseline_file_identity(f.base,f.state/name);p[digest]=ci.sha((f.state/name).read_bytes())

    def test_real_pair_qualification_is_read_only_and_preserves_every_native_byte(self):
        f,p=self.fixture(before_launch=True);paths=[f.state/'current',f.state/'last-ok',f.old_release/'worker-install-v2.json']
        before=[(x.read_bytes(),ci.baseline_file_identity(f.base,x))for x in paths]
        with f.ports():self.assertEqual(ci.verify_baseline_publication(f.base,f.auth,paired=True),p)
        self.assertEqual(before,[(x.read_bytes(),ci.baseline_file_identity(f.base,x))for x in paths])

    def test_actual_preunit_receipt_pair_is_read_only_and_supports_normal_r0_graph(self):
        f,p=self.fixture(before_launch=True,preunit=True)
        paths=[f.state/'current',f.state/'last-ok',f.old_release/'worker-install-v2.json']
        before=[(x.read_bytes(),ci.baseline_file_identity(f.base,x))for x in paths]
        with f.ports():self.assertEqual(ci.verify_baseline_publication(f.base,f.auth,paired=True),p)
        self.assertEqual(before,[(x.read_bytes(),ci.baseline_file_identity(f.base,x))for x in paths])
        other,_=self.fixture(preunit=True);old_last=(other.state/'last-ok').read_bytes()
        receipt=(other.old_release/'worker-install-v2.json').read_bytes()
        other.conditional();result=json.loads((other.operation/'activated.json').read_bytes())
        self.assertEqual(set(result['transitionStages']),{'R0'})
        self.assertEqual((result['fullNativeAudits'],result['completeMetadataFences']),(2,10))
        self.assertEqual((other.state/'last-ok').read_bytes(),old_last)
        self.assertEqual((other.old_release/'worker-install-v2.json').read_bytes(),receipt)
        self.assertFalse(result['journeyVerified'])

    def test_receipt_mode_and_policy_are_closed_pairs_even_with_rebound_pins(self):
        for mode,policy in [('recover-ci-runtime','aihr-worker-prepared-preunit-recovery/v1'),
                            ('recover-prepared-preunit-ci-runtime','aihr-worker-prepared-handoff/v1'),
                            ('unknown-recovery','aihr-worker-prepared-handoff/v1'),
                            ('unknown-recovery','aihr-worker-prepared-preunit-recovery/v1')]:
            with self.subTest(mode=mode,policy=policy):
                f,_=self.fixture(before_launch=True);path=f.old_release/'worker-install-v2.json'
                saved=json.loads(path.read_bytes());saved.update(mode=mode,policy=policy)
                path.chmod(0o644);path.write_bytes(encoded(saved));path.chmod(0o444)
                proof=f.auth[ci.BASELINE_PUBLICATION_KEY]
                proof['workerReceiptSha256']=ci.sha(path.read_bytes())
                proof['workerReceiptIdentity']=ci.baseline_file_identity(f.base,path)
                with f.ports(),self.assertRaisesRegex(ValueError,'receipt mode/policy pair'):
                    ci.verify_baseline_publication(f.base,f.auth,paired=True)

    def test_full_normal_r0_graph_uses_captured_pair_after_new_begin_replaces_current(self):
        f,p=self.fixture();old_last=(f.state/'last-ok').read_bytes();receipt=(f.old_release/'worker-install-v2.json').read_bytes()
        self.assertNotEqual(ci.sha((f.state/'current').read_bytes()),p['currentSha256'])
        f.conditional();r=json.loads((f.operation/'activated.json').read_bytes())
        self.assertEqual(set(r['transitionStages']),{'R0'});self.assertEqual((r['fullNativeAudits'],r['completeMetadataFences']),(2,10))
        self.assertEqual((f.state/'last-ok').read_bytes(),old_last);self.assertEqual((f.old_release/'worker-install-v2.json').read_bytes(),receipt)
        self.assertFalse(r['journeyVerified'])

    def test_ordinary_running_and_final_ok_remain_exact_and_legacy_proof_cannot_relax_new_finish(self):
        f,_=self.fixture();f.finish_on=('fast',2);f.conditional();r=json.loads((f.operation/'activated.json').read_bytes())
        self.assertIn('R0',r['transitionStages']);self.assertIn('O',r['transitionStages']);self.assertEqual(f.prior['result'],'')
        other,_=self.fixture();other.finish();other.prior['result']='failed';other.write_records()
        with self.assertRaisesRegex(ValueError,'native successful finish publication differs'):other.conditional()
        self.assertFalse((other.operation/'activated.json').exists())

    def test_no_optin_keeps_original_failed_header_refusal(self):
        f,_=self.fixture();f.auth.pop(ci.BASELINE_PUBLICATION_KEY);f.first.pop(ci.BASELINE_PUBLICATION_KEY)
        f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes());f.persist_authority()
        with self.assertRaisesRegex(ValueError,'prior last-ok is invalid'):f.conditional()
        self.assertFalse((f.operation/'activated.json').exists())

    def test_first_stage_selection_cannot_be_dropped_or_changed_on_activation(self):
        for change in ['missing','changed']:
            with self.subTest(change=change):
                f,_=self.fixture()
                if change=='missing':f.auth.pop(ci.BASELINE_PUBLICATION_KEY)
                else:
                    f.first[ci.BASELINE_PUBLICATION_KEY]['currentSha256']='0'*64
                    f.firstfile.write_bytes(encoded(f.first));f.auth['firstStageApprovalSha256']=ci.sha(f.firstfile.read_bytes())
                f.persist_authority()
                with self.assertRaises(ValueError):f.conditional()
                self.assertFalse((f.operation/'activated.json').exists())

    def test_even_rebound_hashes_cannot_qualify_nonzero_mismatched_or_partial_native_pair(self):
        for defect in ['current-failed','prior-empty','nonzero','source','build','phase','finished','unknown','duplicate']:
            with self.subTest(defect=defect):
                f,_=self.fixture(before_launch=True);path=f.state/'last-ok';value=ci.record(path.read_bytes())
                if defect=='current-failed':
                    c=ci.record((f.state/'current').read_bytes());c['result']='failed';(f.state/'current').write_text(''.join(k+'='+v+'\n'for k,v in c.items()))
                if defect=='prior-empty':value['result']=''
                if defect=='nonzero':value['exit_code']='1'
                if defect=='source':value['ref']='7'*40
                if defect=='build':value['build_id']='foreign-build'
                if defect=='phase':value['phase']='restart'
                if defect=='finished':value['finished_at']=''
                if defect=='unknown':value['reviewed']='true'
                raw=''.join(k+'='+v+'\n'for k,v in value.items())+('result=failed\n'if defect=='duplicate'else'');path.write_text(raw)
                self.resave_pair_pins(f)
                with f.ports(),self.assertRaises(ValueError):ci.verify_baseline_publication(f.base,f.auth,paired=True)

    def test_receipt_must_be_actual_recovery_shape_even_when_caller_rebinds_its_hash(self):
        for preunit in (False,True):
            for defect in ['source','webBuildId','authorizationSha256','mode','policy','workerRecoveryOnly','serviceStable','nativeRuntimeVerified','fullSourceContentInventoryVerified','fullNativeAudits','completeMetadataFences','journeyVerified','installationAuthorizationSha256','firstStageApprovalSha256','installId']:
                with self.subTest(preunit=preunit,defect=defect):
                    f,_=self.fixture(before_launch=True,preunit=preunit);path=f.old_release/'worker-install-v2.json';saved=json.loads(path.read_bytes())
                    original=saved[defect];saved[defect]=not original if type(original)is bool else 1 if type(original)is int else 'wrong'
                    self.assertNotEqual(saved[defect],original)
                    path.chmod(0o644);path.write_bytes(encoded(saved));path.chmod(0o444)
                    proof=f.auth[ci.BASELINE_PUBLICATION_KEY];proof['workerReceiptSha256']=ci.sha(path.read_bytes());proof['workerReceiptIdentity']=ci.baseline_file_identity(f.base,path)
                    with f.ports(),self.assertRaisesRegex(ValueError,'recovered.*receipt'):ci.verify_baseline_publication(f.base,f.auth,paired=True)

    def test_record_and_receipt_metadata_bytes_and_selection_are_revalidated_after_launch(self):
        for defect in ['last-ok-content','last-ok-inode','receipt-content','receipt-inode','receipt-mode','receipt-hardlink','receipt-symlink','unknown-proof','wrong-version','wrong-policy','foreign-proof','missing-proof','auth-lastok']:
            with self.subTest(defect=defect):
                f,_=self.fixture();path=f.old_release/'worker-install-v2.json';last=f.state/'last-ok'
                if defect=='last-ok-content':last.write_bytes(last.read_bytes()+b'changed=1\n')
                if defect=='last-ok-inode':raw=last.read_bytes();last.unlink();last.write_bytes(raw)
                if defect=='receipt-content':path.chmod(0o644);path.write_bytes(path.read_bytes()+b' ');path.chmod(0o444)
                if defect=='receipt-inode':raw=path.read_bytes();path.unlink();path.write_bytes(raw);path.chmod(0o444)
                if defect=='receipt-mode':path.chmod(0o644)
                if defect=='receipt-hardlink':os.link(path,path.with_name('duplicate-receipt'))
                if defect=='receipt-symlink':target=path.with_name('actual-receipt');path.rename(target);path.symlink_to(target)
                if defect=='unknown-proof':f.auth[ci.BASELINE_PUBLICATION_KEY]['reviewed']=True
                if defect=='wrong-version':f.auth[ci.BASELINE_PUBLICATION_KEY]['format']=True
                if defect=='wrong-policy':f.auth[ci.BASELINE_PUBLICATION_KEY]['policy']='other'
                if defect=='foreign-proof':f.auth[ci.BASELINE_PUBLICATION_KEY]['source']='7'*40
                if defect=='missing-proof':f.auth.pop(ci.BASELINE_PUBLICATION_KEY)
                if defect=='auth-lastok':f.auth['priorLastOkSha256']='0'*64
                with f.ports(),self.assertRaises((ValueError,OSError)):
                    ci.verify_baseline_publication(f.base,f.auth,last_ok=last.read_bytes())

    def test_rebound_future_receipt_publication_cannot_be_presented_as_pre_finish_evidence(self):
        f,_=self.fixture(before_launch=True);receipt=f.old_release/'worker-install-v2.json'
        future=int(ci.record((f.state/'current').read_bytes())['finished_at'])+10
        os.utime(receipt,ns=(future*1000000000,future*1000000000))
        # Even an independently rebound metadata selection cannot bypass chronology.
        f.auth[ci.BASELINE_PUBLICATION_KEY]['workerReceiptIdentity']=ci.baseline_file_identity(f.base,receipt)
        with f.ports(),self.assertRaisesRegex(ValueError,'published after native successful finish'):
            ci.verify_baseline_publication(f.base,f.auth,paired=True)

    def test_unqualified_recovery_and_published_fieldsets_do_not_acquire_legacy_authority(self):
        p={ci.BASELINE_PUBLICATION_KEY:{'format':1}}
        with self.assertRaisesRegex(ValueError,'unavailable'):ci.baseline_publication_fields(ci.ACTIVATION_FIELDS,p)
        self.assertEqual(ci.baseline_publication_fields(ci.ACTIVATION_FIELDS,{}),ci.ACTIVATION_FIELDS)


if __name__=='__main__':unittest.main()
